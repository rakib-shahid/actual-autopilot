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

export function toImportTransaction(extraction, email) {
  const cents = api.utils.amountToInteger(Math.abs(extraction.amount));
  return {
    date: extraction.date,
    amount: extraction.direction === 'inflow' ? cents : -cents,
    payee_name: extraction.payee,
    imported_payee: extraction.payee,
    imported_id: `gmail:${email.messageId}`,
    notes: 'auto: email',
    cleared: false,
  };
}

export async function importOne(accountId, transaction, dryRun) {
  return api.importTransactions(accountId, [transaction], { dryRun });
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

export const formatAmount = (cents) => api.utils.integerToAmount(cents).toFixed(2);
