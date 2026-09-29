import fs from 'node:fs';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { fetchAlertEmails } from './gmail.js';
import { extractTransaction, categorizeTransactions } from './llm.js';
import { loadState } from './state.js';
import {
  openBudget,
  closeBudget,
  loadLookups,
  findAccount,
  toImportTransaction,
  importOne,
  recentTransactions,
  updateFields,
  daysAgo,
  isoDate,
  formatAmount,
} from './actual.js';

const REVIEW_TAG = '#review';
const log = (...args) => console.log(new Date().toISOString(), ...args);

function appendNote(existing, note) {
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing} ${note}`;
}

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

    const txn = toImportTransaction(extraction, email);
    const result = await importOne(account.id, txn, config.dryRun);
    const added = result.added?.length ?? 0;
    log(
      `  ${config.dryRun ? '[dry run] ' : ''}+ ${txn.date} ${extraction.payee} ${extraction.direction === 'inflow' ? '+' : '-'}$${extraction.amount.toFixed(2)} -> ${account.name}` +
        (added === 0 && !config.dryRun ? ' (already in Actual)' : ''),
    );
    if (result.errors?.length) log('    errors:', result.errors.map((e) => e.message).join('; '));
    if (!config.dryRun) state.emails[email.messageId] = { ...record, status: 'imported' };
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

async function runOnce(config) {
  if (running) {
    log('Previous run still going, skipping');
    return;
  }
  running = true;
  const state = loadState(config.actual.dataDir);
  log(`Run started${config.dryRun ? ' (DRY_RUN: nothing will be written)' : ''}`);
  try {
    await openBudget(config.actual);
    const lookups = await loadLookups();
    await ingestEmails(config, lookups, state);
    await categorize(config, lookups);
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

const config = loadConfig();
fs.mkdirSync(config.actual.dataDir, { recursive: true });

if (config.runOnce) {
  await runOnce(config);
} else {
  if (!cron.validate(config.schedule)) throw new Error(`Invalid SCHEDULE "${config.schedule}"`);
  log(`Scheduling "${config.schedule}" (${config.timezone})`);
  await runOnce(config);
  cron.schedule(config.schedule, () => runOnce(config), { timezone: config.timezone });
}
