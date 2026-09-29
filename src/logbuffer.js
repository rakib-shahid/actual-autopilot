import { format } from 'node:util';

// Keeps the app's own recent log lines (the timestamped ones, not Actual's
// debug output) so the web page can show what the last runs did.
const MAX_LINES = 300;
const lines = [];

export function captureLogs() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const text = format(...args);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return;
      lines.push(text.split('\n')[0]);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    };
  }
}

export const recentLogs = (count = 150) => lines.slice(-count);
