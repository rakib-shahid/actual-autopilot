import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

// Bank export files dropped into IMPORT_DIR (QFX/OFX/QIF/CSV).

export const FILE_TYPES = ['.qfx', '.ofx', '.qif', '.csv', '.tsv'];
// Skip files still being copied in (e.g. over SMB).
const SETTLE_MS = 30 * 1000;

export function listImportFiles(dir) {
  const now = Date.now();
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && FILE_TYPES.includes(path.extname(d.name).toLowerCase()))
    .map((d) => path.join(dir, d.name))
    .filter((file) => now - fs.statSync(file).mtimeMs > SETTLE_MS)
    .sort();
}

const last4 = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

// The account number inside an OFX/QFX file, if the bank includes one.
export function ofxAccountLast4(text) {
  const m = text.match(/<ACCTID>\s*([^<\r\n]+)/i);
  return m ? last4(m[1]) : null;
}

export function parseDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

export function parseMoney(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()$,\s+-]/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return negative ? -cents : cents;
}

const pick = (headers, names) => names.find((n) => headers.includes(n));

// Maps a bank CSV to { date, amount (cents, outflow negative), payee, last4 }.
// Handles the common layouts by header name:
//   Capital One card:  Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit
//   Capital One 360:   Account Number, Transaction Description, Transaction Date, Transaction Type, Transaction Amount, Balance
//   Chase card:        Transaction Date, Post Date, Description, Category, Type, Amount, Memo
//   Chase checking:    Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #
export function parseBankCsv(text, delimiter = ',') {
  const records = parse(text, {
    columns: (row) => row.map((h) => String(h).trim().toLowerCase()),
    bom: true,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
  if (records.length === 0) return { rows: [], error: 'no rows' };

  const headers = Object.keys(records[0]);
  const dateCol = pick(headers, ['transaction date', 'trans. date', 'date', 'posting date', 'posted date', 'post date']);
  const payeeCol = pick(headers, ['description', 'transaction description', 'payee', 'merchant', 'name', 'memo']);
  const amountCol = pick(headers, ['amount', 'transaction amount']);
  const debitCol = pick(headers, ['debit', 'withdrawal', 'withdrawals']);
  const creditCol = pick(headers, ['credit', 'deposit', 'deposits']);
  const typeCol = pick(headers, ['transaction type', 'details', 'type']);
  const accountCol = pick(headers, ['card no.', 'card no', 'card number', 'account number', 'account']);

  if (!dateCol || !payeeCol || (!amountCol && !(debitCol || creditCol))) {
    return { rows: [], error: `unrecognized columns: ${headers.join(', ')}` };
  }

  const rows = [];
  for (const r of records) {
    const date = parseDate(r[dateCol]);
    let amount;
    if (amountCol) {
      amount = parseMoney(r[amountCol]);
      // Some banks (Capital One 360) export unsigned amounts plus a Debit/Credit type.
      const type = String(r[typeCol] ?? '').toLowerCase();
      if (amount != null && amount > 0 && type === 'debit') amount = -amount;
    } else {
      const debit = parseMoney(r[debitCol]) ?? 0;
      const credit = parseMoney(r[creditCol]) ?? 0;
      amount = Math.abs(credit) - Math.abs(debit);
      if (!r[debitCol] && !r[creditCol]) amount = null;
    }
    const payee = String(r[payeeCol] ?? '').trim();
    if (!date || amount == null || !payee) continue;
    rows.push({ date, amount, payee, last4: accountCol ? last4(r[accountCol]) : null });
  }
  return { rows, error: null };
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Account for a file with no per-row account column: a 4-digit group in the
// file name that is in ACCOUNT_MAP (Chase names downloads like Chase1234_Activity...),
// or an Actual account name in the file name (travel-card.qfx).
export function accountFromFileName(fileName, accounts, accountMap) {
  const base = path.basename(fileName, path.extname(fileName));
  for (const m of base.matchAll(/(?<!\d)\d{4}(?!\d)/g)) {
    if (accountMap[m[0]]) return { last4: m[0] };
  }
  const flat = normalize(base);
  const byLength = [...accounts].sort((a, b) => b.name.length - a.name.length);
  const named = byLength.find((a) => normalize(a.name) && flat.includes(normalize(a.name)));
  return named ? { account: named } : null;
}

// rename() fails across mounts (import and done are separate volumes), so fall back to copy.
export function moveFile(src, destDir, prefix = '') {
  fs.mkdirSync(destDir, { recursive: true });
  const name = `${prefix}${path.basename(src)}`;
  let dest = path.join(destDir, name);
  for (let i = 1; fs.existsSync(dest); i++) {
    const ext = path.extname(name);
    dest = path.join(destDir, `${path.basename(name, ext)} (${i})${ext}`);
  }
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
  return dest;
}
