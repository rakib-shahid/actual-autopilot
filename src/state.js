import fs from 'node:fs';
import path from 'node:path';

// Remembers which emails were already handled so each email costs one Claude
// call at most, and when the last backup ran. Losing this file is safe: the
// duplicate check in dedupe.js still stops re-imports.
export function loadState(dataDir) {
  const file = path.join(dataDir, 'autopilot-state.json');
  let state = { emails: {} };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first run
  }
  return {
    emails: state.emails ?? {},
    lastBackup: state.lastBackup ?? null,
    save() {
      // Keep the file small: forget emails older than 60 days.
      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
      for (const [id, entry] of Object.entries(this.emails)) {
        if (new Date(entry.seenAt).getTime() < cutoff) delete this.emails[id];
      }
      fs.writeFileSync(file, JSON.stringify({ emails: this.emails, lastBackup: this.lastBackup }, null, 2));
    },
  };
}
