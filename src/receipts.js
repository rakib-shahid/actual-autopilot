import { DAY_MS } from './dedupe.js';

// Receipts (Amazon orders, DoorDash, walmart.com...) usually don't say which
// card paid, so they never create transactions. They wait in the state file
// until the bank's charge shows up, then write what was bought into its notes.

const MATCH_DAYS = 7;
// A charge that only roughly matches must also be close in time.
const CLOSE_DAYS = 3;
// Amazon charges per shipment and delivery tips change, so the charge can be
// a bit off the receipt total. Exact amounts always win over close ones.
const TOLERANCE = 0.2;
export const RECEIPT_TTL_DAYS = 30;

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "What was bought", plus the bank's raw merchant text when it says more than
// the cleaned payee (e.g. DOORDASH*CHIPOTLE vs DoorDash).
export function detailsNote({ details, merchant_raw: raw, payee }) {
  const parts = [];
  if (details) parts.push(details.trim());
  if (raw && norm(raw) !== norm(payee) && !norm(details).includes(norm(raw))) parts.push(raw.trim());
  return parts.join(' · ') || null;
}

export function withDetails(notes, text) {
  if (!text || (notes ?? '').includes(text)) return notes;
  return notes ? `${text} · ${notes}` : text;
}

// Same business if one cleaned name starts with or contains the other's first word.
export function samePayee(a, b) {
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y) return false;
  const first = (s) => s.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? '';
  return x.includes(y) || y.includes(x) || (first(a).length >= 4 && first(a) === first(b));
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

// receipt: { date, amount (cents, signed), payee, details }
// txns: [{ id, date, amount, notes, payeeName }]. Returns the best match or null.
export function matchReceipt(receipt, txns, claimed = new Set()) {
  const day = dayNumber(receipt.date);
  const scored = txns
    .filter((t) => !claimed.has(t.id) && Math.sign(t.amount) === Math.sign(receipt.amount))
    .filter((t) => !(t.notes ?? '').includes(receipt.details))
    .filter((t) => samePayee(t.payeeName, receipt.payee))
    .map((t) => ({ t, off: Math.abs(t.amount - receipt.amount), days: Math.abs(dayNumber(t.date) - day) }))
    .filter((c) => c.days <= (c.off === 0 ? MATCH_DAYS : CLOSE_DAYS) && c.off <= Math.abs(receipt.amount) * TOLERANCE)
    .sort((a, b) => a.off - b.off || a.days - b.days);
  return scored[0]?.t ?? null;
}
