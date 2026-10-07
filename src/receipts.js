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

// Notes the app writes are your text, then this tag at the end.
export const TAG = '#autopilot';
// What earlier versions wrote instead.
const OLD_TAGS = /\s*\bauto: (?:email|gemini|claude|reviewed|file)\b/gi;
const REVIEW_SUFFIX = /\s*#review maybe .*$/;

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "Steam ... #autopilot": drops old "auto: ..." tags, puts #autopilot at the
// end (before a pending "#review maybe ..." tag, which must stay last).
export function tagNotes(notes) {
  const review = (notes ?? '').match(REVIEW_SUFFIX)?.[0] ?? '';
  const text = (notes ?? '')
    .slice(0, (notes ?? '').length - review.length)
    .replace(OLD_TAGS, '')
    .split(TAG).join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·]+|[\s·]+$/g, '')
    .trim();
  return `${text ? `${text} ${TAG}` : TAG}${review}`;
}

export const hasOldTags = (notes) => new RegExp(OLD_TAGS.source, 'i').test(notes ?? '');

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

// Order numbers Gemini puts in parentheses, e.g. "Supplements (113-4902473-6853010)".
// Ordered and shipped emails for one order share it; two separate purchases
// of the same amount (two $5 credit buys) don't.
export const orderIds = (text) => [...(text ?? '').matchAll(/\(#?(\w*\d[\w-]{3,})\)/g)].map((m) => m[1]);
export const orderId = (details) => orderIds(details)[0] ?? null;

// False when the transaction is already noted with a different order.
export function sameOrder(order, ...noteSources) {
  const ids = noteSources.flatMap((s) => (typeof s === 'string' ? orderIds(s) : [...(s ?? [])]));
  return !order || ids.length === 0 || ids.includes(order);
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

// receipt: { date, amount (cents, signed), payee, details }
// txns: [{ id, date, amount, notes, payeeName }]. Returns the best match or null.
export function matchReceipt(receipt, txns, claimed = new Set()) {
  const day = dayNumber(receipt.date);
  const order = orderId(receipt.details);
  const scored = txns
    .filter((t) => !claimed.has(t.id) && Math.sign(t.amount) === Math.sign(receipt.amount))
    .filter((t) => !(t.notes ?? '').includes(receipt.details))
    .filter((t) => !order || !orderIds(t.notes).length)
    .filter((t) => samePayee(t.payeeName, receipt.payee))
    .map((t) => ({ t, off: Math.abs(t.amount - receipt.amount), days: Math.abs(dayNumber(t.date) - day) }))
    .filter((c) => c.days <= (c.off === 0 ? MATCH_DAYS : CLOSE_DAYS) && c.off <= Math.abs(receipt.amount) * TOLERANCE)
    .sort((a, b) => a.off - b.off || a.days - b.days);
  return scored[0]?.t ?? null;
}

// The existing payee to use for a name from an email: an exact (case-insensitive)
// match, else one whose cleaned name contains the other ("Amazon" for
// "Amazon.com"), else the name as is. Gemini already picks from the list;
// this catches small spelling differences.
export function canonicalPayee(name, payeeNames) {
  if (!name) return name;
  const n = norm(name);
  const exact = payeeNames.find((p) => norm(p) === n);
  if (exact) return exact;
  const contains = payeeNames
    .filter((p) => norm(p).length >= 4 && n.length >= 4 && (n.includes(norm(p)) || norm(p).includes(n)))
    .sort((a, b) => norm(b).length - norm(a).length);
  return contains[0] ?? name;
}
