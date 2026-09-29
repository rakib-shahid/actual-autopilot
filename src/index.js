import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { fetchAlertEmails } from './gmail.js';
import { extractTransaction, categorizeTransactions } from './llm.js';
import { loadState } from './state.js';
import { planImports, dateRange } from './dedupe.js';
import { listImportFiles, parseBankCsv, ofxAccountLast4, accountFromFileName, moveFile } from './files.js';
import { writeBackup } from './backup.js';
import {
  openBudget,
  closeBudget,
  loadLookups,
  findAccount,
  toImportTransaction,
  importMany,
  accountTransactions,
  parseStatementFile,
  exportBudgetZip,
  recentTransactions,
  updateFields,
  daysAgo,
  isoDate,
  toCents,
  formatAmount,
} from './actual.js';

const REVIEW_TAG = '#review';
const log = (...args) => console.log(new Date().toISOString(), ...args);

function appendNote(existing, note) {
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing} ${note}`;
}

// Runs the duplicate check against what's already in the account, then imports
// only the new transactions. Returns what happened to each one.
async function importIntoAccount(config, account, txns) {
  const [start, end] = dateRange(txns);
  const existing = await accountTransactions(account.id, start, end);
  const plan = planImports(existing, txns);
  if (!config.dryRun) {
    for (const a of plan.attach) await updateFields(a.id, { imported_id: a.imported_id, cleared: true });
  }
  const result = plan.add.length ? await importMany(account.id, plan.add, config.dryRun) : { added: [], updated: [] };
  if (result.errors?.length) log('    errors:', result.errors.map((e) => e.message).join('; '));
  return { plan, result };
}

const describeMatch = (lookups, m) =>
  `${m.date} ${lookups.payeeName.get(m.payee) ?? m.imported_payee ?? '(no payee)'}`;

async function ingestEmails(config, lookups, state) {
  if (!config.gmail.enabled) return;
  if (!config.gmail.user || !config.gmail.appPassword) {
    log('Email ingest skipped: GMAIL_USER / GMAIL_APP_PASSWORD not set');
    return;
  }

  const emails = await fetchAlertEmails(config.gmail);
  log(`Found ${emails.length} alert email(s) in the last ${config.gmail.lookbackDays} day(s)`);

  for (const email of emails) {
    const seen = state.emails[email.messageId];
    if (seen && seen.status !== 'unmapped') continue;

    // Reuse the earlier extraction for emails waiting on an ACCOUNT_MAP entry.
    const extraction = seen?.extraction ?? (await extractTransaction(email));
    const record = { seenAt: seen?.seenAt ?? new Date().toISOString(), subject: email.subject, extraction };

    if (!extraction) {
      log(`  ? "${email.subject}": Claude returned nothing, will retry next run`);
      continue;
    }
    if (!extraction.is_transaction || extraction.amount == null || !extraction.date || !extraction.payee) {
      log(`  - skip "${email.subject}": ${extraction.reason}`);
      state.emails[email.messageId] = { ...record, status: 'not_transaction' };
      continue;
    }

    const account = findAccount(lookups.accounts, config.accountMap, extraction.account_last4);
    if (!account) {
      log(`  ! "${email.subject}": no ACCOUNT_MAP entry for card/account ending ${extraction.account_last4 ?? '(none)'}`);
      state.emails[email.messageId] = { ...record, status: 'unmapped' };
      continue;
    }

    const txn = toImportTransaction(extraction);
    const { plan, result } = await importIntoAccount(config, account, [txn]);
    const line = `${txn.date} ${extraction.payee} ${extraction.direction === 'inflow' ? '+' : '-'}$${extraction.amount.toFixed(2)} -> ${account.name}`;
    const prefix = config.dryRun ? '[dry run] ' : '';
    if (plan.skip.length) {
      log(`  ${prefix}= ${line} (already in Actual: ${describeMatch(lookups, plan.skip[0].match)})`);
    } else if (result.updated?.length) {
      log(`  ${prefix}= ${line} (Actual matched an existing entry)`);
    } else {
      log(`  ${prefix}+ ${line}`);
    }
    if (!config.dryRun) state.emails[email.messageId] = { ...record, status: 'imported' };
  }
}

async function ingestFiles(config, lookups) {
  const { importDir, doneDir } = config.files;
  if (!fs.existsSync(importDir)) return;
  const files = listImportFiles(importDir);
  if (files.length === 0) return;
  log(`Found ${files.length} file(s) in ${importDir}`);
  const prefix = config.dryRun ? '[dry run] ' : '';

  for (const file of files) {
    const name = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    let problem = null;
    try {
      let rows;
      let fileLast4 = null;
      if (ext === '.csv' || ext === '.tsv') {
        const parsed = parseBankCsv(fs.readFileSync(file, 'utf8'), ext === '.tsv' ? '\t' : ',');
        if (parsed.error) throw new Error(parsed.error);
        rows = parsed.rows;
      } else {
        const parsed = await parseStatementFile(file);
        if (!parsed.transactions?.length) throw new Error(parsed.errors?.[0]?.message ?? 'no transactions found');
        rows = parsed.transactions
          .filter((t) => t.date && t.amount != null)
          .map((t) => ({ date: t.date, amount: toCents(t.amount), payee: t.payee_name ?? t.imported_payee ?? '', imported_id: t.imported_id || undefined }));
        if (ext !== '.qif') fileLast4 = ofxAccountLast4(fs.readFileSync(file, 'utf8'));
      }
      if (rows.length === 0) throw new Error('no transactions found');

      // Which account each row belongs to: its own card/account column, else the
      // account number inside the file, else the file name.
      const fromName = accountFromFileName(name, lookups.accounts, config.accountMap);
      const byAccount = new Map();
      const unmapped = new Set();
      for (const r of rows) {
        const digits = r.last4 ?? (fileLast4 && config.accountMap[fileLast4] ? fileLast4 : null) ?? fromName?.last4;
        const account = digits ? findAccount(lookups.accounts, config.accountMap, digits) : fromName?.account;
        if (!account) {
          unmapped.add(digits ?? fileLast4 ?? '(none)');
          continue;
        }
        if (!byAccount.has(account.id)) byAccount.set(account.id, { account, txns: [] });
        byAccount.get(account.id).txns.push({
          date: r.date,
          amount: r.amount,
          payee_name: r.payee,
          imported_payee: r.payee,
          ...(r.imported_id ? { imported_id: r.imported_id } : {}),
          notes: 'auto: file',
          cleared: true,
        });
      }

      for (const { account, txns } of byAccount.values()) {
        const { plan, result } = await importIntoAccount(config, account, txns);
        const added = result.added?.length ?? 0;
        const already = plan.skip.length + (result.updated?.length ?? 0);
        log(`  ${prefix}${name} -> ${account.name}: ${added} new, ${already} already in Actual, ${plan.attach.length} linked to email entries`);
        for (const t of plan.add.slice(0, 50)) log(`    ${prefix}+ ${t.date} ${t.payee_name} ${formatAmount(t.amount)}`);
      }
      if (unmapped.size) problem = `no ACCOUNT_MAP entry for ${[...unmapped].join(', ')} (${rows.length - [...byAccount.values()].reduce((n, g) => n + g.txns.length, 0)} rows skipped)`;
    } catch (err) {
      problem = err?.message ?? String(err);
    }

    if (problem) log(`  ! ${name}: ${problem}`);
    if (config.dryRun) {
      log(`  ${prefix}${name} left in ${importDir}`);
    } else if (problem) {
      log(`  ${name} moved to ${moveFile(file, path.join(doneDir, 'failed'))}; fix it and drop it in again (already-imported rows are skipped)`);
    } else {
      moveFile(file, doneDir, `${isoDate(new Date())}_`);
    }
  }
}

async function backup(config, state) {
  const { dir, keep } = config.backup;
  const today = isoDate(new Date());
  if (!fs.existsSync(dir) || state.lastBackup === today) return;
  try {
    const { file, removed } = writeBackup(dir, await exportBudgetZip(), keep);
    state.lastBackup = today;
    log(`Backup written to ${file}${removed ? ` (removed ${removed} old)` : ''}`);
  } catch (err) {
    log('Backup failed:', err?.message ?? err);
  }
}

async function categorize(config, lookups) {
  if (!config.categorize.enabled) return;

  const today = isoDate(new Date());
  const history = await recentTransactions(lookups.accounts, daysAgo(config.categorize.historyDays), today);
  const cutoff = daysAgo(config.categorize.days);
  const todo = history.filter((t) => !t.category && t.date >= cutoff && t.amount !== 0 && !t.notes?.includes(REVIEW_TAG));
  if (todo.length === 0) {
    log('No uncategorized transactions');
    return;
  }

  const categoryById = new Map(lookups.categories.map((c) => [c.id, c]));
  // Latest categorization per payee is the most useful signal and keeps the prompt short.
  const byPayee = new Map();
  for (const t of history.filter((t) => t.category && categoryById.has(t.category)).sort((a, b) => b.date.localeCompare(a.date))) {
    const payee = lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '';
    if (!payee || byPayee.has(payee)) continue;
    const c = categoryById.get(t.category);
    byPayee.set(payee, { payee, amount: formatAmount(t.amount), category: `${c.group} / ${c.name}` });
  }
  const examples = [...byPayee.values()].slice(0, 400);

  const batchSize = 40;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const answer = await categorizeTransactions({
      categories: lookups.categories,
      examples,
      transactions: batch.map((t) => ({
        id: t.id,
        date: t.date,
        payee: lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '(no payee)',
        amount: formatAmount(t.amount),
        account: t.accountName,
        notes: t.notes,
      })),
    });
    if (!answer) continue;

    for (const t of batch) {
      const r = answer.results.find((x) => x.id === t.id);
      const payee = lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '(no payee)';
      const cat = r?.category_id ? categoryById.get(r.category_id) : null;
      const label = `${t.date} ${payee} $${formatAmount(t.amount)}`;
      if (cat && r.confidence >= config.categorize.minConfidence) {
        log(`  ${config.dryRun ? '[dry run] ' : ''}= ${label} -> ${cat.group} / ${cat.name} (${r.confidence.toFixed(2)})`);
        if (!config.dryRun) await updateFields(t.id, { category: cat.id, notes: appendNote(t.notes, 'auto: Claude') });
      } else {
        const guess = cat ? `${cat.group} / ${cat.name}` : 'no guess';
        log(`  ${config.dryRun ? '[dry run] ' : ''}? ${label} -> review (${guess}, ${r?.confidence?.toFixed(2) ?? 'n/a'}): ${r?.reason ?? 'missing'}`);
        if (!config.dryRun) await updateFields(t.id, { notes: appendNote(t.notes, `${REVIEW_TAG} maybe ${guess}`) });
      }
    }
  }
}

let running = false;

// One step failing (say Gmail is down) shouldn't stop the others.
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    log(`${name} failed:`, err?.stack ?? err);
    process.exitCode = 1;
  }
}

async function runOnce(config, { emails = true } = {}) {
  if (running) {
    log('Previous run still going, skipping');
    return;
  }
  running = true;
  const state = loadState(config.actual.dataDir);
  log(`Run started${config.dryRun ? ' (DRY_RUN: nothing will be written to Actual)' : ''}`);
  try {
    await openBudget(config.actual);
    const lookups = await loadLookups();
    // Files first, so bank data is in place before emails are checked against it.
    await step('File import', () => ingestFiles(config, lookups));
    if (emails) await step('Email import', () => ingestEmails(config, lookups, state));
    await step('Categorize', () => categorize(config, lookups));
    await backup(config, state);
    state.save();
    log('Run finished');
  } catch (err) {
    log('Run failed:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    await closeBudget().catch((err) => log('Close failed:', err?.message ?? err));
    running = false;
  }
}

function checkFolder(label, dir) {
  if (!fs.existsSync(dir)) {
    log(`${label}: ${dir} is not mounted, skipping`);
    return false;
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    log(`${label}: ${dir}`);
  } catch {
    log(`${label}: ${dir} is not writable by uid ${process.getuid?.()}; give that user modify access on the host folder`);
  }
  return true;
}

const config = loadConfig();
fs.mkdirSync(config.actual.dataDir, { recursive: true });
const watchImports = checkFolder('Import folder', config.files.importDir);
if (watchImports) checkFolder('Done folder', config.files.doneDir);
checkFolder('Backup folder', config.backup.dir);

if (config.runOnce) {
  await runOnce(config);
} else {
  if (!cron.validate(config.schedule)) throw new Error(`Invalid SCHEDULE "${config.schedule}"`);
  log(`Scheduling "${config.schedule}" (${config.timezone})`);
  await runOnce(config);
  cron.schedule(config.schedule, () => runOnce(config), { timezone: config.timezone });

  // Between scheduled runs, pick up new files within a few minutes. Not in dry
  // run, where files stay put and would be re-read every few minutes.
  if (watchImports && config.files.pollMinutes > 0 && !config.dryRun) {
    setInterval(() => {
      let pending = [];
      try {
        pending = listImportFiles(config.files.importDir);
      } catch (err) {
        log('Import folder check failed:', err?.message ?? err);
      }
      if (pending.length && !running) runOnce(config, { emails: false });
    }, config.files.pollMinutes * 60 * 1000);
  }
}
