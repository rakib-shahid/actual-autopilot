import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, buildRows, toCsv, summarize, summaryText, parseRequest, budgetSummary, loadBudget } from '../src/export.js';

test('date ranges: periods, months and custom ranges', () => {
  const today = '2026-10-07';
  assert.deepEqual(resolveRange({}, today), { from: '2026-10-01', to: '2026-10-07', label: 'month to date' });
  assert.deepEqual(resolveRange({ period: 'last-month' }, today), { from: '2026-09-01', to: '2026-09-30', label: 'last month' });
  assert.deepEqual(resolveRange({ period: 'last-month' }, '2026-01-15'), { from: '2025-12-01', to: '2025-12-31', label: 'last month' });
  assert.equal(resolveRange({ period: 'ytd' }, today).from, '2026-01-01');
  assert.deepEqual(resolveRange({ period: 'last-year' }, today), { from: '2025-01-01', to: '2025-12-31', label: 'last year' });
  assert.equal(resolveRange({ period: 'last-30' }, today).from, '2026-09-08');
  assert.deepEqual(resolveRange({ period: '2026-02' }, today), { from: '2026-02-01', to: '2026-02-28', label: '2026-02' });
  assert.equal(resolveRange({ period: '2026-10' }, today).to, today);
  assert.deepEqual(resolveRange({ from: '2026-09-15', to: '2026-09-20' }, today), { from: '2026-09-15', to: '2026-09-20', label: '2026-09-15 to 2026-09-20' });
  assert.throws(() => resolveRange({ period: 'whenever' }, today), RangeError);
  assert.throws(() => resolveRange({ from: '2026-09-20', to: '2026-09-01' }, today), RangeError);
  assert.throws(() => resolveRange({ from: '9/1/2026' }, today), RangeError);
});

const lookups = {
  categories: [
    { id: 'food', name: 'Eating Out', group: 'Wants' },
    { id: 'pay', name: 'Paycheck', group: 'Income' },
  ],
  allAccounts: [{ id: 'chk', name: 'Checking' }, { id: 'cc', name: 'Credit Card' }],
  payeeName: new Map([['p1', 'DoorDash'], ['p2', 'Employer'], ['tcc', 'Credit Card']]),
  transferAccount: new Map([['tcc', 'cc']]),
};
const txns = [
  { id: 't2', date: '2026-10-03', accountName: 'Credit Card', payee: 'p1', category: 'food', amount: -1545, notes: 'Wingstop, "wings" #autopilot', cleared: true },
  { id: 't1', date: '2026-10-01', accountName: 'Checking', payee: 'p2', category: 'pay', amount: 250000, notes: null, cleared: true },
  { id: 't3', date: '2026-10-05', accountName: 'Checking', payee: 'tcc', category: null, amount: -50000, notes: 'pay bill', cleared: false },
  { id: 't4', date: '2026-10-06', accountName: 'Credit Card', payee: 'p1', category: null, amount: -1000, notes: '', cleared: false },
];

test('rows name transfers, categories and amounts, sorted by date', () => {
  const rows = buildRows(txns, lookups);
  assert.deepEqual(rows.map((r) => r.id), ['t1', 't2', 't3', 't4']);
  assert.equal(rows[1].category, 'Eating Out');
  assert.equal(rows[1].amount, '-15.45');
  assert.equal(rows[2].transfer, 'Credit Card');
  assert.equal(rows[2].payee, '');
  const csv = toCsv(rows).split('\n');
  assert.equal(csv[0], 'date,account,payee,transfer,category_group,category,amount,notes,cleared,offbudget,id');
  assert.equal(csv[2], '2026-10-03,Credit Card,DoorDash,,Wants,Eating Out,-15.45,"Wingstop, ""wings"" #autopilot",yes,no,t2');
});

test('summary leaves transfers out of income and spending', () => {
  const s = summarize(buildRows(txns, lookups), {
    range: { from: '2026-10-01', to: '2026-10-07', label: 'month to date' },
    balances: [{ account: 'Checking', balance: 200000 }],
    pendingReview: 2,
  });
  assert.equal(s.income, '2500.00');
  assert.equal(s.spending, '25.45');
  assert.equal(s.saved, '0.00');
  assert.equal(s.net, '2474.55');
  assert.deepEqual(s.by_category, [{ name: 'Wants / Eating Out', amount: '15.45' }, { name: '(uncategorized)', amount: '10.00' }]);
  assert.deepEqual(s.top_payees, [{ name: 'DoorDash', amount: '25.45' }]);
  assert.equal(s.uncategorized, 1);
  assert.equal(s.pending_review, 2);
  assert.deepEqual(s.balances, [{ account: 'Checking', balance: '2000.00', offbudget: false }]);
});

test('email request subjects', () => {
  assert.deepEqual(parseRequest('autopilot: export'), { command: 'export', params: {} });
  assert.deepEqual(parseRequest('Autopilot: export last-month'), { command: 'export', params: { period: 'last-month' } });
  assert.deepEqual(parseRequest('autopilot: export 2026-09-01 2026-09-30'), { command: 'export', params: { from: '2026-09-01', to: '2026-09-30' } });
  assert.deepEqual(parseRequest('autopilot: summary 2026-09'), { command: 'summary', params: { period: '2026-09' } });
  assert.deepEqual(parseRequest('autopilot:scan'), { command: 'scan', params: {} });
  assert.equal(parseRequest('autopilot: dance').command, 'help');
  assert.equal(parseRequest('Re: your order'), null);
  assert.equal(parseRequest('[autopilot] Export 2026-10-01 to 2026-10-07'), null);
});

test('money moved to savings counts as saved, not spent', () => {
  const lk = { ...lookups, categories: [...lookups.categories, { id: 'buf', name: 'Buffer', group: 'Investments and Savings' }], allAccounts: [...lookups.allAccounts, { id: 'sav', name: 'Savings' }], transferAccount: new Map([['tcc', 'cc'], ['tsav', 'sav']]) };
  const rows = buildRows([
    { id: 'p', date: '2026-10-01', accountName: 'Checking', payee: 'p2', category: 'pay', amount: 300000 },
    { id: 's', date: '2026-10-06', accountName: 'Checking', payee: 'tsav', category: 'buf', amount: -200000 },
    { id: 'f', date: '2026-10-06', accountName: 'Credit Card', payee: 'p1', category: 'food', amount: -1000 },
  ], lk);
  const s = summarize(rows, { range: { from: '2026-10-01', to: '2026-10-07', label: 'x' } });
  assert.equal(s.spending, '10.00');
  assert.equal(s.saved, '2000.00');
  assert.equal(s.net, '990.00');
  assert.deepEqual(s.top_payees, [{ name: 'DoorDash', amount: '10.00' }]);
});

// Shaped like api.getBudgetMonth() in @actual-app/api 26.9: integer cents,
// spent negative for money out, balance includes rollover.
const budgetMonth = (month) => ({
  month,
  toBudget: 12345,
  totalBudgeted: -90000,
  categoryGroups: [
    {
      id: 'g-wants', name: 'Wants', is_income: false, hidden: false,
      categories: [
        { id: 'shop', name: '🛒 Shopping', group_id: 'g-wants', is_income: false, hidden: false, budgeted: 30000, spent: -47997, balance: -17997, carryover: false },
        { id: 'food', name: 'Eating Out', group_id: 'g-wants', is_income: false, hidden: false, budgeted: 0, spent: -1545, balance: -1545, carryover: false },
        { id: 'old', name: 'Old Hobby', group_id: 'g-wants', is_income: false, hidden: true, budgeted: 1000, spent: -500, balance: 500, carryover: false },
      ],
    },
    {
      id: 'g-needs', name: 'Needs', is_income: false, hidden: false,
      categories: [
        // A refund bigger than the spending: spent comes out negative.
        { id: 'gro', name: 'Groceries', group_id: 'g-needs', is_income: false, hidden: false, budgeted: 60000, spent: 1250, balance: 61250, carryover: true },
        { id: 'rent', name: 'Rent', group_id: 'g-needs', is_income: false, hidden: false, budgeted: 150005, spent: -150000, balance: 5, carryover: false },
      ],
    },
    {
      id: 'g-gone', name: 'Archived', is_income: false, hidden: true,
      categories: [{ id: 'x', name: 'Visible In Hidden Group', group_id: 'g-gone', is_income: false, hidden: false, budgeted: 100, spent: -100, balance: 0, carryover: false }],
    },
    {
      id: 'g-inc', name: 'Income', is_income: true, hidden: false,
      categories: [{ id: 'pay', name: 'Paycheck', group_id: 'g-inc', is_income: true, hidden: false, budgeted: 0, received: 250000, balance: 0, carryover: false }],
    },
  ],
});

test('budget: shape, cents to dollars, signs, and most overspent first', () => {
  const b = budgetSummary('2026-11', budgetMonth('2026-11'));
  assert.deepEqual(b, {
    month: '2026-11',
    to_budget: '123.45',
    categories: [
      { group: 'Wants', name: '🛒 Shopping', budgeted: '300.00', spent: '479.97', remaining: '-179.97', rollover: false },
      { group: 'Wants', name: 'Eating Out', budgeted: '0.00', spent: '15.45', remaining: '-15.45', rollover: false },
      { group: 'Needs', name: 'Rent', budgeted: '1500.05', spent: '1500.00', remaining: '0.05', rollover: false },
      { group: 'Needs', name: 'Groceries', budgeted: '600.00', spent: '-12.50', remaining: '612.50', rollover: true },
    ],
  });
});

test('budget: hidden categories, hidden groups and income are left out', () => {
  const names = budgetSummary('2026-11', budgetMonth('2026-11')).categories.map((c) => `${c.group} / ${c.name}`);
  assert.ok(!names.includes('Wants / Old Hobby'));
  assert.ok(!names.some((n) => n.startsWith('Archived /')));
  assert.ok(!names.some((n) => n.startsWith('Income /')));
});

test('budget: no to_budget when Actual has none (tracking budgets)', () => {
  const b = budgetSummary('2026-11', { ...budgetMonth('2026-11'), toBudget: null });
  assert.ok(!('to_budget' in b));
  assert.equal(budgetSummary('2026-11', { ...budgetMonth('2026-11'), toBudget: 0 }).to_budget, '0.00');
});

test('budget: names line up with by_category', () => {
  const lk = { ...lookups, categories: [...lookups.categories, { id: 'shop', name: '🛒 Shopping', group: 'Wants' }] };
  const rows = buildRows([{ id: 'a', date: '2026-11-02', accountName: 'Credit Card', payee: 'p1', category: 'shop', amount: -47997 }], lk);
  const s = summarize(rows, { range: { from: '2026-11-01', to: '2026-11-16', label: 'month to date' }, budget: budgetSummary('2026-11', budgetMonth('2026-11')) });
  const budgetNames = s.budget.categories.map((c) => `${c.group} / ${c.name}`);
  assert.ok(budgetNames.includes(s.by_category[0].name));
});

test('budget: month of the end date, even when the range spans two months', async () => {
  const asked = [];
  const get = async (month) => (asked.push(month), budgetMonth(month));
  const range = resolveRange({ from: '2026-10-20', to: '2026-11-05' }, '2026-11-16');
  const b = await loadBudget(get, range.to, () => {});
  assert.deepEqual(asked, ['2026-11']);
  assert.equal(b.month, '2026-11');
  assert.equal((await loadBudget(get, resolveRange({ period: 'last-month' }, '2026-01-01').to, () => {})).month, '2025-12');
});

test('budget: a failure is logged and the export goes out without it', async () => {
  const logged = [];
  const log = (...args) => logged.push(args.join(' '));
  const range = { from: '2026-11-01', to: '2026-11-16', label: 'month to date' };
  const failing = async () => {
    throw new Error('No budget exists for month: 2026-11');
  };
  const budget = await loadBudget(failing, range.to, log);
  assert.equal(budget, null);
  assert.match(logged[0], /2026-11.*No budget exists/);
  // Malformed data is treated the same way.
  assert.equal(await loadBudget(async () => ({}), range.to, () => {}), null);

  const s = summarize(buildRows(txns, lookups), { range, balances: [], budget });
  assert.ok(!('budget' in s));
  assert.deepEqual(Object.keys(s), ['from', 'to', 'period', 'transactions', 'income', 'spending', 'saved', 'net', 'by_category', 'top_payees', 'uncategorized', 'pending_review', 'balances']);
  assert.ok(!summaryText(s).includes('Budget ('));
});

test('budget: JSON keeps the existing keys and adds budget last; text section sits between categories and payees', () => {
  const range = { from: '2026-11-01', to: '2026-11-16', label: 'month to date' };
  const s = summarize(buildRows(txns, lookups), { range, balances: [{ account: 'Checking', balance: 100 }], budget: budgetSummary('2026-11', budgetMonth('2026-11')) });
  assert.deepEqual(Object.keys(s), ['from', 'to', 'period', 'transactions', 'income', 'spending', 'saved', 'net', 'by_category', 'top_payees', 'uncategorized', 'pending_review', 'balances', 'budget']);
  const parsed = JSON.parse(JSON.stringify(s));
  assert.deepEqual(Object.keys(parsed.budget), ['month', 'to_budget', 'categories']);
  assert.deepEqual(Object.keys(parsed.budget.categories[0]), ['group', 'name', 'budgeted', 'spent', 'remaining', 'rollover']);

  const lines = summaryText(s).split('\n');
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('Spending by category:') < at('Budget (2026-11):'));
  assert.ok(at('Budget (2026-11):') < at('Top payees:'));
  assert.equal(lines[at('Budget (2026-11):') + 1], '  Wants / 🛒 Shopping: budgeted 300.00 | spent 479.97 | remaining -179.97');
  assert.equal(lines[at('Budget (2026-11):') + 4], '  Needs / Groceries: budgeted 600.00 | spent -12.50 | remaining 612.50');
  assert.equal(lines[at('Top payees:') - 1], '');
});
