import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

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

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
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

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
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
      const raw = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
      emails.push({
        messageId: parsed.messageId || `uid-${msg.uid}`,
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '',
        date: (parsed.date ?? msg.envelope?.date ?? new Date()).toISOString(),
        text: cleanEmailText(raw),
      });
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return emails;
}
