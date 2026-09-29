import * as api from '@actual-app/api';

let internal = null;
let loaded = false;

export async function openBudget({ serverURL, password, syncId, e2ePassword, dataDir }) {
  internal = await api.init({ serverURL, password, dataDir });
  await api.downloadBudget(syncId, e2ePassword ? { password: e2ePassword } : undefined);
  loaded = true;
}

export async function closeBudget() {
  if (!internal) return;
  try {
    if (loaded) await api.sync();
  } finally {
    loaded = false;
    internal = null;
    await api.shutdown().catch(() => {});
  }
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days) {
  return isoDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

export function findAccount(accounts, accountMap, last4) {
  const name = last4 ? accountMap[last4] : undefined;
  if (!name) return null;
  return accounts.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

// No imported_id on purpose: the bank's QFX later carries the real one, and
// Actual only fuzzy-matches when one side has no id. The state file stops the
// same email being imported twice.
export function toImportTransaction(extraction) {
  const cents = api.utils.amountToInteger(Math.abs(extraction.amount));
  return {
    date: extraction.date,
    amount: extraction.direction === 'inflow' ? cents : -cents,
    payee_name: extraction.payee,
    imported_payee: extraction.payee,
    notes: 'auto: email',
    cleared: false,
  };
}

export async function importMany(accountId, transactions, dryRun) {
  return api.importTransactions(accountId, transactions, { dryRun });
}

// Top-level (non-split) transactions in one account between two ISO dates.
export async function accountTransactions(accountId, startDate, endDate) {
  const txns = await api.getTransactions(accountId, startDate, endDate);
  return txns.filter((t) => !t.tombstone && !t.is_child);
}

// Actual's own QFX/OFX/QIF parser, so FITIDs match what its Import button stores.
export async function parseStatementFile(filepath) {
  return internal.send('transactions-parse-file', {
    filepath,
    options: { fallbackMissingPayeeToMemo: true, importNotes: false },
  });
}

export async function exportBudgetZip() {
  return api.exportBudget();
}

export async function loadLookups() {
  const [accounts, categories, groups, payees] = await Promise.all([
    api.getAccounts(),
    api.getCategories(),
    api.getCategoryGroups(),
    api.getPayees(),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  return {
    accounts: accounts.filter((a) => !a.closed),
    categories: categories
      .filter((c) => !c.hidden)
      .map((c) => ({ id: c.id, name: c.name, group: groupName.get(c.group_id) ?? '', is_income: c.is_income })),
    payeeName: new Map(payees.map((p) => [p.id, p.name])),
  };
}

// Returns flat, non-transfer transactions in on-budget accounts.
export async function recentTransactions(accounts, startDate, endDate) {
  const out = [];
  for (const account of accounts.filter((a) => !a.offbudget)) {
    const txns = await api.getTransactions(account.id, startDate, endDate);
    for (const t of txns) {
      const rows = t.is_parent && t.subtransactions?.length ? t.subtransactions : [t];
      for (const row of rows) {
        if (row.transfer_id || row.starting_balance_flag || row.tombstone) continue;
        out.push({ ...row, accountName: account.name });
      }
    }
  }
  return out;
}

// api.updateTransaction resolves before its write finishes (it reads a field off
// an un-awaited promise), so a shutdown right after it can drop the change.
// Calling the batch handler directly waits for the write.
export async function updateFields(id, fields) {
  await internal.send('transactions-batch-update', { updated: [{ id, ...fields }] });
}

export const toCents = (amount) => api.utils.amountToInteger(amount);
export const formatAmount =(cents) => api.utils.integerToAmount(cents).toFixed(2);
