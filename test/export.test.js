import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, buildRows, toCsv, summarize, parseRequest } from '../src/export.js';

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
