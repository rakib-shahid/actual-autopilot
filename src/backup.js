import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'actual-budget-';

// Writes the same zip as Actual's Settings > Export data (restore it with
// Import file > Actual), then keeps only the newest `keep` backups.
export function writeBackup(dir, zip, keep, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const file = path.join(dir, `${PREFIX}${stamp}.zip`);
  fs.writeFileSync(file, zip);

  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.zip'))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return { file, removed: old.length };
}
