import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailsNote, withDetails, samePayee, matchReceipt } from '../src/receipts.js';

test('notes keep what was bought and the raw bank merchant when it adds something', () => {
  assert.equal(detailsNote({ payee: 'DoorDash', merchant_raw: 'DOORDASH*CHIPOTLE', details: null }), 'DOORDASH*CHIPOTLE');
  assert.equal(detailsNote({ payee: 'AT&T', merchant_raw: 'AT&T', details: null }), null);
  assert.equal(detailsNote({ payee: 'Amazon', merchant_raw: null, details: 'Supplements (order 113-1)' }), 'Supplements (order 113-1)');
  assert.equal(withDetails('auto: email', 'Chipotle: bowl'), 'Chipotle: bowl · auto: email');
  assert.equal(withDetails('Chipotle: bowl · auto: email', 'Chipotle: bowl'), 'Chipotle: bowl · auto: email');
  assert.equal(withDetails('x', null), 'x');
});

test('payee names from the receipt and the bank count as the same business', () => {
  assert.ok(samePayee('Amazon', 'AMAZON MKTPL*2K41'));
  assert.ok(samePayee('DoorDash', 'DoorDash Chipotle'));
  assert.ok(!samePayee('Walmart', 'Target'));
});

test('a receipt finds its bank charge: exact amount first, then close, never another merchant', () => {
  const txns = [
    { id: 'w', date: '2026-10-06', amount: -2498, payeeName: 'Walmart', notes: 'auto: email' },
    { id: 'a1', date: '2026-10-08', amount: -2210, payeeName: 'Amazon', notes: 'auto: email' },
    { id: 'a2', date: '2026-10-07', amount: -2498, payeeName: 'Amazon', notes: 'auto: email' },
  ];
  const receipt = { date: '2026-10-06', amount: -2498, payee: 'Amazon', details: 'Supplements (order 113-1)' };
  assert.equal(matchReceipt(receipt, txns).id, 'a2');
  // Split shipment: only a smaller charge exists, still within 20%.
  assert.equal(matchReceipt(receipt, txns.filter((t) => t.id !== 'a2')).id, 'a1');
  // Already annotated, too far off, or claimed: no match.
  assert.equal(matchReceipt(receipt, [{ ...txns[2], notes: 'Supplements (order 113-1) · auto: email' }]), null);
  assert.equal(matchReceipt({ ...receipt, amount: -9999 }, txns), null);
  assert.equal(matchReceipt(receipt, [txns[2]], new Set(['a2'])), null);
  // Too many days apart.
  assert.equal(matchReceipt({ ...receipt, date: '2026-09-20' }, txns), null);
});

test('a roughly matching charge must be within 3 days; an exact one within 7', () => {
  const charge = { id: 'a', date: '2026-10-05', amount: -5495, payeeName: 'Amazon', notes: '' };
  const r = { date: '2026-09-29', amount: -6000, payee: 'Amazon', details: 'gift card' };
  assert.equal(matchReceipt(r, [charge]), null);
  assert.equal(matchReceipt({ ...r, date: '2026-10-03' }, [charge]).id, 'a');
  assert.equal(matchReceipt({ ...r, amount: -5495 }, [charge]).id, 'a');
});
