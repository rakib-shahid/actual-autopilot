// All settings come from environment variables so secrets never live in the repo.

const DEFAULT_SENDERS = [
  'capitalone@notification.capitalone.com',
  'no.reply.alerts@chase.com',
  'alerts@info.americanexpress.com',
  'discover@services.discover.com',
  'alerts@citibank.com',
  'venmo@venmo.com',
  'service@paypal.com',
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function num(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function json(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

export function loadConfig() {
  return {
    actual: {
      serverURL: required('ACTUAL_SERVER_URL'),
      password: required('ACTUAL_PASSWORD'),
      syncId: required('ACTUAL_SYNC_ID'),
      e2ePassword: process.env.ACTUAL_E2E_PASSWORD || undefined,
      dataDir: process.env.DATA_DIR || '/data',
    },
    gmail: {
      enabled: bool('EMAIL_INGEST', true),
      user: process.env.GMAIL_USER,
      appPassword: process.env.GMAIL_APP_PASSWORD,
      mailbox: process.env.GMAIL_MAILBOX || '[Gmail]/All Mail',
      senders: (process.env.ALERT_SENDERS || DEFAULT_SENDERS.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      lookbackDays: num('LOOKBACK_DAYS', 3),
    },
    claude: {
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
      effort: process.env.CLAUDE_EFFORT || undefined,
    },
    // Maps the last 4 digits a bank email mentions to an Actual account name,
    // e.g. {"1234": "Checking", "5678": "Credit Card"}.
    accountMap: json('ACCOUNT_MAP', {}),
    categorize: {
      enabled: bool('CATEGORIZE', true),
      days: num('CATEGORIZE_DAYS', 30),
      historyDays: num('HISTORY_DAYS', 180),
      minConfidence: num('MIN_CONFIDENCE', 0.8),
    },
    files: {
      // Bank exports (QFX/OFX/QIF/CSV) dropped here are imported, then moved to doneDir.
      importDir: process.env.IMPORT_DIR || '/import',
      doneDir: process.env.DONE_DIR || '/done',
      // Also check the folder this often between scheduled runs; 0 turns that off.
      pollMinutes: num('IMPORT_POLL_MINUTES', 5),
    },
    backup: {
      // A zip of the whole budget once a day, same format as Actual's Export.
      dir: process.env.BACKUP_DIR || '/backups',
      keep: num('BACKUP_KEEP', 30),
    },
    dryRun: bool('DRY_RUN', true),
    runOnce: bool('RUN_ONCE', false),
    schedule: process.env.SCHEDULE || '0 */2 * * *',
    timezone: process.env.TZ || 'America/New_York',
  };
}
