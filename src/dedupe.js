// Decides which incoming transactions are new, before handing them to Actual.
//
// Actual's own matching skips fuzzy dedup when both sides have an imported_id,
// so an email (gmail:...) and a QFX line (FITID) for the same purchase would
// both be added. And when it does fuzzy-match, it overwrites the existing
// imported_id. So we match here first:
//   1. same imported_id                          -> already there, skip
//   2. same amount within MATCH_DAYS of the date -> already there, skip
//      (if the existing one has no imported_id and the incoming one does,
//       attach the id so later imports of that file match exactly)
//   3. otherwise                                 -> import
// Each existing transaction can be claimed once, so two real $5 charges in a
// file still both land when only one is in Actual.

export const MATCH_DAYS = 4;

export const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

export function planImports(existing, incoming) {
  const claimed = new Set();
  const plan = { add: [], attach: [], skip: [] };

  for (const txn of incoming) {
    let match = null;
    if (txn.imported_id) {
      match = existing.find((e) => !claimed.has(e.id) && e.imported_id === txn.imported_id) ?? null;
    }
    if (!match) {
      const day = dayNumber(txn.date);
      const candidates = existing
        .filter((e) => !claimed.has(e.id) && e.amount === txn.amount && Math.abs(dayNumber(e.date) - day) <= MATCH_DAYS)
        // Prefer an unlinked entry on the closest date.
        .sort((a, b) => Number(!!a.imported_id) - Number(!!b.imported_id) || Math.abs(dayNumber(a.date) - day) - Math.abs(dayNumber(b.date) - day));
      match = candidates[0] ?? null;
    }

    if (!match) {
      plan.add.push(txn);
      continue;
    }
    claimed.add(match.id);
    if (txn.imported_id && !match.imported_id) plan.attach.push({ id: match.id, imported_id: txn.imported_id, txn, match });
    else plan.skip.push({ txn, match });
  }
  return plan;
}

export function dateRange(txns) {
  const days = txns.map((t) => dayNumber(t.date));
  const iso = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
  return [iso(Math.min(...days) - MATCH_DAYS), iso(Math.max(...days) + MATCH_DAYS)];
}
