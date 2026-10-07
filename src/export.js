// Transaction exports for analysis: a CSV of every transaction in a date range
// plus a summary (income, spending by category, balances). Served by the web
// page and emailed on a schedule or on request, so a Claude session that can
// read Gmail but can't reach the NAS still gets the data.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(\d{2})$/;

// today: "YYYY-MM-DD" in the budget's timezone.
// Accepts { from, to } (YYYY-MM-DD), or a period: mtd (default), last-month,
// ytd, last-year, last-N (days, e.g. last-30), or a month like 2026-09.
export function resolveRange({ period, from, to } = {}, today) {
  const [y, m, d] = today.split('-').map(Number);
  if (from || to) {
    if ((from && !ISO_DAY.test(from)) || (to && !ISO_DAY.test(to))) throw new RangeError('from and to must be YYYY-MM-DD');
    const start = from ?? `${today.slice(0, 7)}-01`;
    const end = to ?? today;
    if (start > end) throw new RangeError('from is after to');
    return { from: start, to: end, label: `${start} to ${end}` };
  }
  const p = (period ?? 'mtd').toLowerCase().trim();
  const month = p.match(MONTH);
  if (month) {
    const [yy, mm] = [Number(month[1]), Number(month[2])];
    if (mm < 1 || mm > 12) throw new RangeError(`no such month: ${p}`);
    const last = ymd(utc(yy, mm, 0));
    return { from: `${p}-01`, to: last < today ? last : today, label: p };
  }
  if (p === 'mtd') return { from: ymd(utc(y, m - 1, 1)), to: today, label: 'month to date' };
  if (p === 'last-month') return { from: ymd(utc(y, m - 2, 1)), to: ymd(utc(y, m - 1, 0)), label: 'last month' };
  if (p === 'ytd') return { from: `${y}-01-01`, to: today, label: 'year to date' };
  if (p === 'last-year') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: 'last year' };
  const days = p.match(/^last-?(\d{1,4})d?$/);
  if (days) return { from: ymd(utc(y, m - 1, d - Number(days[1]) + 1)), to: today, label: `last ${days[1]} days` };
  throw new RangeError(`unknown period "${period}" (use mtd, last-month, ytd, last-year, last-30 or YYYY-MM)`);
}

// txns: flat rows from allTransactions(). lookups: from loadLookups().
export function buildRows(txns, lookups) {
  const category = new Map(lookups.categories.map((c) => [c.id, c]));
  const accountName = new Map(lookups.allAccounts.map((a) => [a.id, a.name]));
  return txns
    .map((t) => {
      const transferTo = lookups.transferAccount.get(t.payee);
      const c = category.get(t.category);
      return {
        date: t.date,
        account: t.accountName,
        payee: transferTo ? '' : lookups.payeeName.get(t.payee) ?? t.imported_payee ?? '',
        transfer: transferTo ? accountName.get(transferTo) ?? 'other account' : '',
        category_group: c?.group ?? '',
        category: c?.name ?? '',
        amount: (t.amount / 100).toFixed(2),
        notes: t.notes ?? '',
        cleared: t.cleared ? 'yes' : 'no',
        offbudget: t.offbudget ? 'yes' : 'no',
        id: t.id,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
}

export const CSV_COLUMNS = ['date', 'account', 'payee', 'transfer', 'category_group', 'category', 'amount', 'notes', 'cleared', 'offbudget', 'id'];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

const cents = (s) => Math.round(Number(s) * 100);
const dollars = (c) => (c / 100).toFixed(2);

// Income and spending count on-budget rows the way Actual's budget does: a
// transfer between two budget accounts has no category and is left out; one to
// an off-budget account (savings, investments) has a category and counts.
// Categories in a group named like "Savings" or "Investments" are reported as
// saved rather than spent. balances: [{ account, balance (cents), offbudget }].
const SAVINGS_GROUP = /saving|invest/i;

export function summarize(rows, { range, balances = [], pendingReview = 0 }) {
  let income = 0;
  let spending = 0;
  let saved = 0;
  const byCategory = new Map();
  const byPayee = new Map();
  let uncategorized = 0;
  for (const r of rows) {
    if ((r.transfer && !r.category) || r.offbudget === 'yes') continue;
    const c = cents(r.amount);
    const incomeRow = c > 0 && (!r.category || /income/i.test(r.category_group));
    if (incomeRow) income += c;
    else {
      const key = r.category ? `${r.category_group} / ${r.category}` : '(uncategorized)';
      byCategory.set(key, (byCategory.get(key) ?? 0) - c);
      const who = r.payee || (r.transfer && `Transfer to ${r.transfer}`) || '(no payee)';
      if (SAVINGS_GROUP.test(r.category_group)) saved -= c;
      else {
        if (c < 0) byPayee.set(who, (byPayee.get(who) ?? 0) - c);
        spending -= c;
      }
    }
    if (!r.category) uncategorized++;
  }
  const sorted = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([name, c]) => ({ name, amount: dollars(c) }));
  return {
    from: range.from,
    to: range.to,
    period: range.label,
    transactions: rows.length,
    income: dollars(income),
    spending: dollars(spending),
    saved: dollars(saved),
    // What's left after spending and saving.
    net: dollars(income - spending - saved),
    by_category: sorted(byCategory),
    top_payees: sorted(byPayee).slice(0, 15),
    uncategorized,
    pending_review: pendingReview,
    balances: balances.map((b) => ({ account: b.account, balance: dollars(b.balance), offbudget: !!b.offbudget })),
  };
}

export function summaryText(s) {
  const lines = [
    `Period: ${s.from} to ${s.to} (${s.period}), ${s.transactions} transaction(s)`,
    `Income ${s.income} | Spending ${s.spending} | Saved ${s.saved} | Net ${s.net}`,
    `Uncategorized: ${s.uncategorized} | Waiting for review: ${s.pending_review}`,
    '',
    'Spending by category:',
    ...s.by_category.map((c) => `  ${c.name}: ${c.amount}`),
    '',
    'Top payees:',
    ...s.top_payees.map((p) => `  ${p.name}: ${p.amount}`),
    '',
    'Account balances (today):',
    ...s.balances.map((b) => `  ${b.account}${b.offbudget ? ' (off budget)' : ''}: ${b.balance}`),
  ];
  return lines.join('\n');
}

// Commands sent by email to yourself, subject "autopilot: <command> [args]":
//   export [period | from to]   CSV + summary (default month to date)
//   summary [period | from to]  summary only
//   scan                        run now
//   status                      last run, next run, waiting reviews
export function parseRequest(subject) {
  const m = (subject ?? '').trim().match(/^autopilot\s*:\s*(\w+)\s*(.*)$/i);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!['export', 'summary', 'scan', 'status', 'help'].includes(command)) return { command: 'help', params: {}, unknown: m[1] };
  const args = m[2].trim().split(/\s+/).filter(Boolean);
  const params = {};
  if (args.length >= 2 && ISO_DAY.test(args[0]) && ISO_DAY.test(args[1])) [params.from, params.to] = args;
  else if (args.length === 1 && ISO_DAY.test(args[0])) params.from = args[0];
  else if (args.length) params.period = args[0];
  return { command, params };
}

export const REQUEST_HELP = `Email yourself with one of these subjects (the body is ignored):
  autopilot: export                    CSV of all transactions, month to date
  autopilot: export last-month         also ytd, last-year, last-30, or a month like 2026-09
  autopilot: export 2026-09-01 2026-09-30
  autopilot: summary last-month        totals only, no CSV
  autopilot: scan                      run email/file import now
  autopilot: status                    last run, next run, reviews waiting`;
