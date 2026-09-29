import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planImports } from '../src/dedupe.js';
import { parseBankCsv, ofxAccountLast4, accountFromFileName, parseDate, parseMoney, moveFile } from '../src/files.js';
import { writeBackup } from '../src/backup.js';

test('email alert for a charge already imported from QFX is skipped, not duplicated', () => {
  // A pending charge: alert on 9/29, QFX posted it on 9/30 with a FITID.
  const existing = [{ id: 'q1', date: '2026-09-30', amount: -725, imported_id: 'FITID123', payee: 'p1' }];
  const email = { date: '2026-09-29', amount: -725, payee_name: 'Coffee Shop' };
  const plan = planImports(existing, [email]);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.skip[0].match.id, 'q1');
});

test('QFX line matching an email-created entry links its FITID instead of adding', () => {
  const existing = [{ id: 'e1', date: '2026-09-29', amount: -725, imported_id: null }];
  const plan = planImports(existing, [{ date: '2026-09-30', amount: -725, imported_id: 'FITID123' }]);
  assert.deepEqual(plan.attach.map((a) => [a.id, a.imported_id]), [['e1', 'FITID123']]);
  assert.equal(plan.add.length, 0);
});

test('same FITID is skipped even when the amount changed', () => {
  const existing = [{ id: 'q1', date: '2026-09-28', amount: -1000, imported_id: 'F1' }];
  const plan = planImports(existing, [{ date: '2026-09-28', amount: -1200, imported_id: 'F1' }]);
  assert.equal(plan.skip.length, 1);
});

test('two real identical charges only match one existing entry', () => {
  const existing = [{ id: 'a', date: '2026-09-20', amount: -250, imported_id: null }];
  const row = { date: '2026-09-20', amount: -250, payee_name: 'Bus' };
  const plan = planImports(existing, [row, { ...row }]);
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.add.length, 1);
});

test('different amount or far-apart date is a new transaction', () => {
  const existing = [{ id: 'a', date: '2026-09-01', amount: -725, imported_id: null }];
  const plan = planImports(existing, [
    { date: '2026-09-20', amount: -725 },
    { date: '2026-09-01', amount: -534 },
  ]);
  assert.equal(plan.add.length, 2);
});

test('Capital One card CSV: debit/credit columns and per-row card number', () => {
  const csv = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-29,2026-09-30,9012,COFFEE SHOP,Other Services,7.25,
2026-09-25,2026-09-26,5678,CITY CLINIC,Health Care,60.00,
2026-09-20,2026-09-20,9012,CAPITAL ONE AUTOPAY PYMT,Payment/Credit,,250.00
`;
  const { rows, error } = parseBankCsv(csv);
  assert.equal(error, null);
  assert.deepEqual(rows, [
    { date: '2026-09-29', amount: -725, payee: 'COFFEE SHOP', last4: '9012' },
    { date: '2026-09-25', amount: -6000, payee: 'CITY CLINIC', last4: '5678' },
    { date: '2026-09-20', amount: 25000, payee: 'CAPITAL ONE AUTOPAY PYMT', last4: '9012' },
  ]);
});

test('Capital One 360 CSV: unsigned amount with Debit/Credit type', () => {
  const csv = `Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance
1234,ACME TELECOM,09/29/26,Debit,42.17,957.83
1234,Payroll,09/26/26,Credit,1500.00,1000.00
`;
  const { rows } = parseBankCsv(csv);
  assert.deepEqual(rows.map((r) => [r.date, r.amount, r.last4]), [['2026-09-29', -4217, '1234'], ['2026-09-26', 150000, '1234']]);
});

test('Chase card CSV: signed amount, account comes from the file name', () => {
  const csv = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/27/2026,09/28/2026,STARBUCKS,Food & Drink,Sale,-6.45,
09/28/2026,09/28/2026,Payment Thank You-Mobile,,Payment,350.00,
`;
  const { rows } = parseBankCsv(csv);
  assert.deepEqual(rows.map((r) => [r.date, r.amount, r.last4]), [['2026-09-27', -645, null], ['2026-09-28', 35000, null]]);
  const accounts = [{ id: 'c', name: 'Rewards Card' }, { id: 'v', name: 'Travel Card' }];
  assert.deepEqual(accountFromFileName('Chase4821_Activity20260929.CSV', accounts, { 4821: 'Rewards Card' }), { last4: '4821' });
  assert.equal(accountFromFileName('travel-card.qfx', accounts, {}).account.id, 'v');
  assert.equal(accountFromFileName('export.csv', accounts, {}), null);
});

test('unknown CSV layout is reported, not guessed', () => {
  assert.match(parseBankCsv('foo,bar\n1,2\n').error, /unrecognized columns/);
});

test('small parsers', () => {
  assert.equal(ofxAccountLast4('<CCACCTFROM><ACCTID>XXXXXXXXXXXX9012\n</CCACCTFROM>'), '9012');
  assert.equal(parseDate('9/3/2026'), '2026-09-03');
  assert.equal(parseMoney('($1,234.50)'), -123450);
  assert.equal(parseMoney(''), null);
});

test('moveFile moves and never overwrites; writeBackup keeps the newest N', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-'));
  const done = path.join(dir, 'done');
  for (let i = 0; i < 2; i++) {
    const src = path.join(dir, 'a.csv');
    fs.writeFileSync(src, String(i));
    moveFile(src, done, 'x_');
    assert.ok(!fs.existsSync(src));
  }
  assert.deepEqual(fs.readdirSync(done).sort(), ['x_a (1).csv', 'x_a.csv']);

  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  for (let d = 1; d <= 4; d++) writeBackup(backups, Buffer.from('zip'), 2, new Date(`2026-09-0${d}T03:00:00Z`));
  assert.deepEqual(fs.readdirSync(backups).sort(), ['actual-budget-2026-09-03_0300.zip', 'actual-budget-2026-09-04_0300.zip']);
  fs.rmSync(dir, { recursive: true, force: true });
});
