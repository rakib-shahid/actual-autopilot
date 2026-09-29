import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmailText } from '../src/gmail.js';
import { findAccount, toImportTransaction } from '../src/actual.js';
import { ExtractionSchema, CategorizationSchema } from '../src/llm.js';

const capitalOneBody = `Withdrawal notice ͏ ͏ ͏ ͏

[Sign in to your account]
(https://click-notification.capitalone.com/f/a/eF1AZ5EDmqr6KH1WiXsxGQ~~/AAAAARA~/Yw5eIWy3O)

Account ending in 1234

Withdrawal notice

ACME TELECOM has initiated the following withdrawal from your 360 Checking…1234 account:

Amount: $42.17

From: Account ending in 1234

Submitted on: September 29, 2026

To view your account balance, sign in online (https://click-notification.capitalone.com/f/a/xyz
).`;

test('cleanEmailText drops tracking links and filler', () => {
  const text = cleanEmailText(capitalOneBody);
  assert.ok(!text.includes('http'));
  assert.ok(!text.includes('͏'));
  assert.match(text, /ACME TELECOM has initiated the following withdrawal/);
  assert.match(text, /Amount: \$42\.17/);
});

test('findAccount maps last4 to an Actual account by name', () => {
  const accounts = [{ id: 'a1', name: 'Checking' }, { id: 'a2', name: 'Credit Card' }];
  const map = { 1234: 'checking', 5678: 'Credit Card' };
  assert.equal(findAccount(accounts, map, '1234').id, 'a1');
  assert.equal(findAccount(accounts, map, '9999'), null);
  assert.equal(findAccount(accounts, map, null), null);
});

test('toImportTransaction signs amounts and sets a stable imported_id', () => {
  const email = { messageId: '<abc@capitalone.com>' };
  const out = toImportTransaction(
    { date: '2026-09-29', amount: 42.17, direction: 'outflow', payee: 'Acme Telecom' },
    email,
  );
  assert.equal(out.amount, -4217);
  assert.equal(out.imported_id, 'gmail:<abc@capitalone.com>');
  assert.equal(out.payee_name, 'Acme Telecom');
  const refund = toImportTransaction({ date: '2026-09-29', amount: 12.5, direction: 'inflow', payee: 'Amazon' }, email);
  assert.equal(refund.amount, 1250);
});

test('schemas accept the shapes Claude is asked for', () => {
  ExtractionSchema.parse({
    is_transaction: false, date: null, amount: null, direction: null, payee: null, account_last4: null, reason: 'statement',
  });
  CategorizationSchema.parse({ results: [{ id: 't1', category_id: null, confidence: 0.2, reason: 'unknown' }] });
});
