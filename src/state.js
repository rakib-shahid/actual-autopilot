import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

// Remembers which emails were already handled so each email costs one Claude
// call at most, when the last backup ran, and why Claude flagged transactions
// for review (shown in the web page). Losing this file is safe: the duplicate
// check in dedupe.js still stops re-imports.
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
    reviews: state.reviews ?? {},
    lastBackup: state.lastBackup ?? null,
    save() {
      // Keep the file small: forget emails older than 60 days, review notes older than 180.
      const now = Date.now();
      for (const [id, entry] of Object.entries(this.emails)) {
        if (now - new Date(entry.seenAt).getTime() > 60 * DAY_MS) delete this.emails[id];
      }
      for (const [id, entry] of Object.entries(this.reviews)) {
        if (now - new Date(entry.at).getTime() > 180 * DAY_MS) delete this.reviews[id];
      }
      fs.writeFileSync(file, JSON.stringify({ emails: this.emails, reviews: this.reviews, lastBackup: this.lastBackup }, null, 2));
    },
  };
}
