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

test('ordered and shipped emails for one order attach only once', async () => {
  const { orderId } = await import('../src/receipts.js');
  assert.equal(orderId('Supplements (113-4902473-6853010) · Amazon.com'), '113-4902473-6853010');
  assert.equal(orderId('Bloc Large Silver Moonphase (#63179) · Laphont'), '63179');
  assert.equal(orderId('Wingstop: wings'), null);
  const charge = { id: 'a', date: '2026-10-06', amount: -2498, payeeName: 'Amazon', notes: 'Supplements (113-4902473-6853010) · auto: email' };
  const shipped = { date: '2026-10-06', amount: -2498, payee: 'Amazon', details: 'Vitamins (113-4902473-6853010) · Amazon.com' };
  assert.equal(matchReceipt(shipped, [charge]), null);
});

test('notes: your text, then #autopilot; old auto: tags removed', async () => {
  const { tagNotes, hasOldTags, sameOrder, canonicalPayee } = await import('../src/receipts.js');
  assert.equal(tagNotes('Racetrac · auto: email auto: Gemini'), 'Racetrac #autopilot');
  assert.equal(tagNotes('auto: email'), '#autopilot');
  assert.equal(tagNotes(null), '#autopilot');
  assert.equal(tagNotes('wings #autopilot'), 'wings #autopilot');
  assert.equal(tagNotes('Supplements · #autopilot'), 'Supplements #autopilot');
  assert.equal(tagNotes('x auto: email #review maybe Wants / Dining'), 'x #autopilot #review maybe Wants / Dining');
  assert.ok(hasOldTags('a auto: Gemini') && !hasOldTags('a #autopilot'));
  // Two $5.33 Anthropic purchases with different receipt numbers stay separate.
  assert.ok(!sameOrder('2821-4589-4314', 'One-time credit purchase (#2853-1675-8241) #autopilot'));
  assert.ok(sameOrder('2853-1675-8241', 'One-time credit purchase (#2853-1675-8241) #autopilot'));
  assert.ok(sameOrder('2853-1675-8241', '#autopilot'));
  assert.ok(sameOrder(null, 'anything (#1234-5)'));
  // Existing payees win.
  const payees = ['Steam', 'Gas Stations', 'Amazon', 'DoorDash'];
  assert.equal(canonicalPayee('Amazon.com', payees), 'Amazon');
  assert.equal(canonicalPayee('doordash', payees), 'DoorDash');
  assert.equal(canonicalPayee('Racetrac', payees), 'Racetrac');
});

test('a bare "auto:" left by hand is tidied too', async () => {
  const { tagNotes } = await import('../src/receipts.js');
  assert.equal(tagNotes('auto: email auto: (hospital payment)'), '(hospital payment) #autopilot');
});

test('AWS $1 card checks are skipped, other small charges are not', async () => {
  const { isVerificationHold } = await import('../src/receipts.js');
  assert.ok(isVerificationHold({ amount: 1, payee: 'Amazon Web Services', merchant_raw: null }));
  assert.ok(isVerificationHold({ amount: 1, payee: 'Amazon', merchant_raw: 'AWS EMEA' }));
  assert.ok(!isVerificationHold({ amount: 12.4, payee: 'Amazon Web Services', merchant_raw: null }));
  assert.ok(!isVerificationHold({ amount: 0.98, payee: 'Walmart', merchant_raw: null }));
});
