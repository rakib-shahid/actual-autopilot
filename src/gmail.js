import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { DAY_MS } from './dedupe.js';

// Bank emails are mostly tracking links and legal footer. Strip that so the
// model sees the few lines that matter and each call stays small.
export function cleanEmailText(text) {
  return text
    .replace(/\((https?:\/\/[^)\s]+)\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[͏​-‍ ]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, 4000);
}

// Read-only: opens the mailbox without marking anything as read.
export async function fetchAlertEmails({ user, appPassword, mailbox, senders, lookbackDays }) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
  });

  const since = new Date(Date.now() - lookbackDays * DAY_MS);
  const emails = [];

  await client.connect();
  try {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const query = senders.length === 1
      ? { since, from: senders[0] }
      : { since, or: senders.map((from) => ({ from })) };
    const uids = await client.search(query, { uid: true });
    if (!uids || uids.length === 0) return emails;

    for await (const msg of client.fetch(uids, { source: true, envelope: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      emails.push({
        messageId: parsed.messageId || `uid-${msg.uid}`,
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '',
        date: (parsed.date ?? msg.envelope?.date ?? new Date()).toISOString(),
        // mailparser already turns HTML-only mail into text.
        text: cleanEmailText(parsed.text ?? ''),
      });
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return emails;
}
