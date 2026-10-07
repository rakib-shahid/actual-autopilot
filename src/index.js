import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import * as api from '@actual-app/api';
import { loadConfig } from './config.js';
import { fetchAlertEmails, mentionsMoney } from './gmail.js';
import { extractTransaction, categorizeTransactions, EXTRACT_VERSION } from './llm.js';
import { loadState } from './state.js';
import { planImports, dateRange, DAY_MS } from './dedupe.js';
import { detailsNote, withDetails, matchReceipt, orderId, orderIds, sameOrder, isVerificationHold, tagNotes, hasOldTags, canonicalPayee, TAG, RECEIPT_TTL_DAYS } from './receipts.js';
import { listImportFiles, parseBankCsv, ofxAccountLast4, accountFromFileName, moveFile } from './files.js';
import { writeBackup } from './backup.js';
import { REVIEW_TAG, reviewNote, isPendingReview, guessedCategory, resolvedNotes, editableNotes } from './review.js';
import { startWebServer } from './web.js';
import { captureLogs, recentLogs } from './logbuffer.js';
import {
  openBudget,
  closeBudget,
  loadLookups,
  findAccount,
  merchantAccount,
  toImportTransaction,
  accountTransactions,
  parseStatementFile,
  recentTransactions,
  updateFields,
  daysAgo,
  isoDate,
  toCents,
  formatAmount,
} from './actual.js';

captureLogs();
const log =(...args) => console.log(new Date().toISOString(), ...args);

// Runs the duplicate check against what's already in the account, then imports
// only the new transactions. Returns what happened to each one. With an order
// number, a charge already noted with a different order isn't a match (two
// separate $5 purchases); run.orders tracks orders matched earlier this run.
async function importIntoAccount(config, account, txns, { order = null, run = null } = {}) {
  const [start, end] = dateRange(txns);
  const existing = (await accountTransactions(account.id, start, end)).filter((e) =>
    sameOrder(order, e.notes, run?.orders.get(e.id)),
  );
  const plan = planImports(existing, txns);
  if (!config.dryRun) {
    for (const a of plan.attach) await updateFields(a.id, { imported_id: a.imported_id, cleared: true });
  }
  const result = plan.add.length ? await api.importTransactions(account.id, plan.add, { dryRun: config.dryRun }) : { added: [], updated: [] };
  if (result.errors?.length) log('    errors:', result.errors.map((e) => e.message).join('; '));
  return { plan, result };
}

const describeMatch = (lookups, m) =>
  `${m.date} ${lookups.payeeName.get(m.payee) ?? m.imported_payee ?? '(no payee)'}`;

async function ingestEmails(config, lookups, state, run) {
  if (!config.gmail.enabled) return;
  if (!config.gmail.user || !config.gmail.appPassword) {
    log('Email ingest skipped: GMAIL_USER / GMAIL_APP_PASSWORD not set');
    return;
  }

  const all = await fetchAlertEmails(config.gmail);
  const emails = all.filter(mentionsMoney);
  log(`Found ${all.length} email(s) in the last ${config.gmail.lookbackDays} day(s), ${emails.length} mention an amount`);

  for (const email of emails) {
    const seen = state.emails[email.messageId];
    // Answers from an older prompt are asked again.
    const current = seen?.extraction && seen.v === EXTRACT_VERSION;
    // A dry run looks at every email again (a preview); a live run only at new
    // ones and those waiting on an ACCOUNT_MAP entry.
    const done = seen && !['unmapped', 'preview'].includes(seen.status) && !(['no_account', 'receipt'].includes(seen.status) && !current);
    if (done && !config.dryRun) continue;

    const answer = (current && seen.extraction) || (await extractTransaction(email, lookups.payeeNames, lookups.accounts.map((a) => a.name)));
    // Stick to existing payees; keep the name the email used in the notes.
    const payee = canonicalPayee(answer?.payee, lookups.payeeNames);
    const extraction = answer && payee !== answer.payee
      ? { ...answer, payee, merchant_raw: answer.merchant_raw ?? answer.payee }
      : answer;
    const record = { seenAt: seen?.seenAt ?? new Date().toISOString(), subject: email.subject, extraction: answer, v: EXTRACT_VERSION };
    // A dry run only caches the Gemini answer; the email still counts as new for the next live run.
    const remember = (status) => {
      state.emails[email.messageId] = { ...record, status: config.dryRun ? (seen?.status ?? 'preview') : status };
    };

    if (!extraction) {
      log(`  ? "${email.subject}": Gemini returned nothing, will retry next run`);
      continue;
    }
    if (!extraction.is_transaction || extraction.amount == null || !extraction.date || !extraction.payee) {
      log(`  - skip "${email.subject}": ${extraction.reason}`);
      remember('not_transaction');
      continue;
    }
    if (isVerificationHold(extraction)) {
      log(`  - skip "${email.subject}": $${extraction.amount.toFixed(2)} ${extraction.payee} card-verification charge`);
      remember('not_transaction');
      continue;
    }

    const account =
      findAccount(lookups.accounts, config.accountMap, extraction.account_last4) ??
      merchantAccount(lookups.accounts, config.accountMap, { ...extraction, from: email.from });
    // Receipts also land here when the card they show isn't one of yours
    // (DoorDash prints a placeholder "MasterCard 0000").
    if (!account && (!extraction.account_last4 || extraction.details)) {
      // Receipts often don't name the card; the bank's own alert for the same
      // charge will. Keep what was bought until that charge shows up.
      const details = detailsNote(extraction);
      if (details) {
        const cents = toCents(Math.abs(extraction.amount));
        run.receipts[email.messageId] = {
          at: new Date().toISOString(),
          date: extraction.date,
          amount: extraction.direction === 'inflow' ? cents : -cents,
          payee: extraction.payee,
          details,
        };
      }
      log(`  ${details ? '~ receipt' : '- skip'} "${email.subject}": ${extraction.payee} $${extraction.amount.toFixed(2)}${details ? ` (${details}), kept to attach to its bank charge` : " doesn't say which account"}`);
      remember(details ? 'receipt' : 'no_account');
      continue;
    }
    if (!account) {
      log(`  ! "${email.subject}": no ACCOUNT_MAP entry for card/account ending ${extraction.account_last4}`);
      remember('unmapped');
      continue;
    }

    const txn = toImportTransaction(extraction);
    // A card payment or transfer to another of your accounts becomes an Actual
    // transfer (both sides), like the ones you enter by hand.
    const target = lookups.accounts.find((a) => a.id !== account.id && a.name.toLowerCase() === extraction.payee.toLowerCase());
    if (target && lookups.transferPayee.has(target.id)) {
      txn.payee = lookups.transferPayee.get(target.id);
      delete txn.payee_name;
    }
    const order = orderId(extraction.details);
    const { plan, result } = await importIntoAccount(config, account, [txn], { order, run });
    const line = `${txn.date} ${extraction.payee} ${extraction.direction === 'inflow' ? '+' : '-'}$${extraction.amount.toFixed(2)} -> ${account.name}`;
    const prefix = config.dryRun ? '[dry run] ' : '';
    const row = { date: txn.date, account: account.name, payee: extraction.payee, amount: txn.amount, notes: txn.notes, existing: null };
    if (plan.skip.length) {
      // A second email about the same charge may say what was bought.
      const match = plan.skip[0].match;
      // Skip details for an order that's already noted (a reworded second email).
      const known = order && orderIds(match.notes).includes(order);
      const added = known ? match.notes : withDetails(match.notes, detailsNote(extraction));
      const notes = added !== match.notes ? tagNotes(added) : match.notes;
      if (notes !== match.notes && !config.dryRun) await updateFields(match.id, { notes });
      if (order) run.orders.set(match.id, new Set([...(run.orders.get(match.id) ?? []), order]));
      log(`  ${prefix}= ${line} (already in Actual: ${describeMatch(lookups, match)})`);
      row.existing = { date: match.date, payee: lookups.payeeName.get(match.payee) ?? match.imported_payee ?? '', notes: match.notes ?? '' };
      row.notes = notes;
      run.rows.set(match.id, row);
    } else if (result.updated?.length) {
      log(`  ${prefix}= ${line} (Actual matched an existing entry)`);
      row.existing = { date: '', payee: '(matched by Actual)', notes: '' };
      run.rows.set(`email:${email.messageId}`, row);
    } else {
      log(`  ${prefix}+ ${line}`);
      // Lets the preview attach receipts to rows that don't exist yet.
      run.rows.set(`email:${email.messageId}`, row);
      if (config.dryRun) run.newTxns.push({ id: `email:${email.messageId}`, date: txn.date, amount: txn.amount, notes: txn.notes, payeeName: extraction.payee, accountName: account.name });
    }
    remember('imported');
  }
}

// Writes waiting receipts into the notes of the bank charge they belong to.
async function matchReceipts(config, lookups, run) {
  const pending = Object.entries(run.receipts);
  if (pending.length === 0) return;
  const txns = (await recentTransactions(lookups.accounts, daysAgo(RECEIPT_TTL_DAYS + 7), isoDate(new Date())))
    .map((t) => ({ ...t, payeeName: lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '' }))
    .concat(run.newTxns);
  const claimed = new Set();
  const prefix = config.dryRun ? '[dry run] ' : '';
  for (const [id, r] of pending) {
    // Another email about the same order (ordered vs shipped) already attached.
    const order = orderId(r.details);
    const noted = order && (txns.some((t) => (t.notes ?? '').includes(order)) || [...run.rows.values()].some((row) => row.notes?.includes(order)));
    if (noted) {
      log(`  - receipt ${r.payee} "${r.details}": order already noted on its charge`);
      delete run.receipts[id];
      continue;
    }
    const t = matchReceipt(r, txns, claimed);
    if (t) {
      claimed.add(t.id);
      log(`  ${prefix}* ${r.payee} receipt "${r.details}" -> ${t.date} ${t.payeeName} $${formatAmount(t.amount)} (${t.accountName})`);
      const row = run.rows.get(t.id) ?? {
        date: t.date, account: t.accountName, payee: t.payeeName, amount: t.amount, notes: t.notes ?? '',
        existing: { date: t.date, payee: t.payeeName, notes: t.notes ?? '' },
      };
      row.notes = tagNotes(withDetails(row.notes, r.details));
      run.rows.set(t.id, row);
      const before = t.notes;
      t.notes = withDetails(t.notes, r.details);
      if (!config.dryRun) {
        if (!t.id.startsWith('email:')) await updateFields(t.id, { notes: tagNotes(withDetails(before, r.details)) });
        delete run.receipts[id];
      }
    } else if (Date.now() - new Date(r.at).getTime() > RECEIPT_TTL_DAYS * DAY_MS) {
      log(`  - receipt ${r.payee} $${formatAmount(r.amount)} "${r.details}" never matched a charge; dropping it`);
      delete run.receipts[id];
    }
  }
}

// Dry run: one line per transaction row the app would create, or the existing
// row it would update, with the final notes.
function logPreview(run) {
  const rows = [...run.rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  log(`Dry-run preview: ${rows.length} row(s) (nothing was written)`);
  for (const r of rows) {
    const base = `${r.date} | ${r.account} | ${r.payee} | $${formatAmount(r.amount)}`;
    if (!r.existing) log(`  [new]    ${base} | notes "${r.notes}"`);
    else if (r.notes === r.existing.notes) log(`  [exists] ${base} | matches ${r.existing.date} ${r.existing.payee} "${r.existing.notes}", no change`);
    else log(`  [exists] ${base} | matches ${r.existing.date} ${r.existing.payee} "${r.existing.notes}" -> notes "${r.notes}"`);
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
          notes: TAG,
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
    const { file, removed } = writeBackup(dir, await api.exportBudget(), keep);
    state.lastBackup = today;
    log(`Backup written to ${file}${removed ? ` (removed ${removed} old)` : ''}`);
  } catch (err) {
    log('Backup failed:', err?.message ?? err);
  }
}

async function categorize(config, lookups, state) {
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
        if (!config.dryRun) await updateFields(t.id, { category: cat.id, notes: tagNotes(t.notes) });
      } else {
        const guess = cat ? `${cat.group} / ${cat.name}` : 'no guess';
        log(`  ${config.dryRun ? '[dry run] ' : ''}? ${label} -> review (${guess}, ${r?.confidence?.toFixed(2) ?? 'n/a'}): ${r?.reason ?? 'missing'}`);
        if (!config.dryRun) {
          await updateFields(t.id, { notes: `${tagNotes(t.notes)} ${reviewNote(guess)}` });
          state.reviews[t.id] = { at: new Date().toISOString(), confidence: r?.confidence ?? null, reason: r?.reason ?? '' };
        }
      }
    }
  }
}

// Scheduled runs and the web page both open the budget; this makes them take turns.
let budgetQueue = Promise.resolve();
function withBudgetLock(fn) {
  const next = budgetQueue.then(fn);
  budgetQueue = next.catch(() => {});
  return next;
}

async function withOpenBudget(config, fn) {
  return withBudgetLock(async () => {
    await openBudget(config.actual);
    try {
      return await fn();
    } finally {
      await closeBudget().catch((err) => log('Close failed:', err?.message ?? err));
    }
  });
}

let running = false;
let lastRun = null;

// One step failing (say Gmail is down) shouldn't stop the others.
async function step(name, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    log(`${name} failed:`, err?.stack ?? err);
    process.exitCode = 1;
    return false;
  }
}

async function runOnce(config, { emails = true, trigger = 'schedule' } = {}) {
  if (running) {
    log('Previous run still going, skipping');
    return;
  }
  running = true;
  const run = { trigger, startedAt: new Date().toISOString(), finishedAt: null, ok: false };
  log(`Run started${trigger === 'web' ? ' (from web page)' : ''}${config.dryRun ? ' (DRY_RUN: nothing will be written to Actual)' : ''}`);
  try {
    await withOpenBudget(config, async () => {
      const state = loadState(config.actual.dataDir);
      const lookups = await loadLookups();
      // Files first, so bank data is in place before emails are checked against it.
      let ok = await step('File import', () => ingestFiles(config, lookups));
      // A dry run works on a copy of the waiting receipts so nothing is saved.
      const run = { receipts: config.dryRun ? { ...state.receipts } : state.receipts, rows: new Map(), newTxns: [], orders: new Map() };
      if (emails) ok = (await step('Email import', () => ingestEmails(config, lookups, state, run))) && ok;
      ok = (await step('Receipts', () => matchReceipts(config, lookups, run))) && ok;
      if (config.dryRun) logPreview(run);
      ok = (await step('Categorize', () => categorize(config, lookups, state))) && ok;
      ok = (await step('Tidy notes', () => tidyNotes(config, lookups))) && ok;
      await backup(config, state);
      state.save();
      run.ok = ok;
      log('Run finished');
    });
  } catch (err) {
    log('Run failed:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    run.finishedAt = new Date().toISOString();
    lastRun = run;
    running = false;
  }
}

// --- Web page API -----------------------------------------------------------

// Earlier versions wrote "auto: email", "auto: Gemini"...; rewrite those notes
// to the current style (your text, then #autopilot). Runs every time but only
// touches notes that still have an old tag.
async function tidyNotes(config, lookups) {
  const txns = await recentTransactions(lookups.accounts, daysAgo(config.categorize.historyDays), isoDate(new Date()));
  const old = txns.filter((t) => hasOldTags(t.notes));
  if (old.length === 0) return;
  log(`${config.dryRun ? '[dry run] ' : ''}Tidying notes on ${old.length} transaction(s): "auto: ..." tags become ${TAG}`);
  if (config.dryRun) return;
  for (const t of old) await updateFields(t.id, { notes: tagNotes(t.notes) });
}

// Transactions the app created or annotated recently, for the web page.
async function listRecent(config) {
  return withOpenBudget(config, async () => {
    const lookups = await loadLookups();
    const txns = await recentTransactions(lookups.accounts, daysAgo(30), isoDate(new Date()));
    const items = txns
      .filter((t) => ((t.notes ?? '').includes(TAG) || hasOldTags(t.notes)) && !isPendingReview(t.notes))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 200)
      .map((t) => ({
        id: t.id,
        date: t.date,
        payee: lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '(no payee)',
        account: t.accountName,
        amount: formatAmount(t.amount),
        notes: editableNotes(t.notes),
      }));
    return { items, dryRun: config.dryRun };
  });
}

// updates: [{ id, notes }]. Saves your text with #autopilot at the end.
async function saveNotes(config, updates) {
  if (config.dryRun) return { saved: 0, dryRun: true };
  return withOpenBudget(config, async () => {
    const lookups = await loadLookups();
    const txns = await recentTransactions(lookups.accounts, daysAgo(60), isoDate(new Date()));
    const byId = new Map(txns.map((t) => [t.id, t]));
    let saved = 0;
    for (const u of updates) {
      const t = byId.get(u?.id);
      if (!t || typeof u.notes !== 'string') continue;
      await updateFields(t.id, { notes: tagNotes(u.notes.slice(0, 1000)) });
      saved++;
    }
    log(`Web page: notes saved on ${saved} transaction(s)`);
    return { saved };
  });
}

async function listReviews(config) {
  return withOpenBudget(config, async () => {
    const state = loadState(config.actual.dataDir);
    const lookups = await loadLookups();
    const txns = await recentTransactions(lookups.accounts, daysAgo(config.categorize.historyDays), isoDate(new Date()));
    const categories = lookups.categories
      .map((c) => ({ id: c.id, label: `${c.group} / ${c.name}`, income: !!c.is_income }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const items = txns
      .filter((t) => isPendingReview(t.notes))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((t) => ({
        id: t.id,
        date: t.date,
        payee: lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '(no payee)',
        account: t.accountName,
        amount: formatAmount(t.amount),
        notes: editableNotes(t.notes),
        guess: guessedCategory(t.notes, lookups.categories)?.id ?? null,
        confidence: state.reviews[t.id]?.confidence ?? null,
        reason: state.reviews[t.id]?.reason ?? '',
      }));
    return { items, categories, dryRun: config.dryRun };
  });
}

// decisions: [{ id, category_id, skip, notes }]. Without notes, the current notes
// are re-read so a stale page can't overwrite them.
async function applyDecisions(config, decisions) {
  if (config.dryRun) return { applied: 0, dryRun: true };
  return withOpenBudget(config, async () => {
    const state = loadState(config.actual.dataDir);
    const lookups = await loadLookups();
    const validCategory = new Set(lookups.categories.map((c) => c.id));
    const txns = await recentTransactions(lookups.accounts, daysAgo(config.categorize.historyDays), isoDate(new Date()));
    const byId = new Map(txns.map((t) => [t.id, t]));
    let applied = 0;
    for (const d of decisions) {
      const t = byId.get(d?.id);
      if (!t || !isPendingReview(t.notes)) continue;
      const base = typeof d.notes === 'string' ? d.notes.slice(0, 1000) : t.notes;
      if (d.skip) {
        await updateFields(t.id, { notes: resolvedNotes(base, { skipped: true }) });
      } else if (validCategory.has(d.category_id)) {
        await updateFields(t.id, { category: d.category_id, notes: resolvedNotes(base) });
      } else continue;
      delete state.reviews[t.id];
      applied++;
    }
    state.save();
    log(`Web page: ${applied} review decision(s) saved`);
    return { applied };
  });
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
  const task = cron.schedule(config.schedule, () => runOnce(config), { timezone: config.timezone });

  if (config.web.port > 0) {
    startWebServer({
      port: config.web.port,
      password: config.web.password,
      publicDir: fileURLToPath(new URL('../public', import.meta.url)),
      log,
      api: {
        status: () => ({
          running,
          lastRun,
          nextRun: task.getNextRun()?.toISOString() ?? null,
          schedule: config.schedule,
          timezone: config.timezone,
          dryRun: config.dryRun,
          logs: recentLogs(),
        }),
        scan: () => {
          if (running) return false;
          runOnce(config, { trigger: 'web' });
          return true;
        },
        review: () => listReviews(config),
        recent: () => listRecent(config),
        saveNotes: (updates) => saveNotes(config, updates),
        decide: (decisions) => applyDecisions(config, decisions),
      },
    });
  }

  await runOnce(config, { trigger: 'startup' });

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
      if (pending.length && !running) runOnce(config, { emails: false, trigger: 'import folder' });
    }, config.files.pollMinutes * 60 * 1000);
  }
}
