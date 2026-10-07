import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { DAY_MS } from './dedupe.js';
import { parseRequest } from './export.js';

// Mail the app sends to you (exports, answers to "autopilot: ..." requests) and
// the requests themselves. Uses the same Gmail app password as the import.

const imap = ({ user, appPassword }) =>
  new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass: appPassword }, logger: false });

// Requests are emails you sent to yourself with an "autopilot: ..." subject.
// They're read from Sent Mail, where only mail this account really sent can
// be, so a stranger can't send commands by faking your address.
export async function fetchRequests({ user, appPassword, sentMailbox }, sinceDays = 2) {
  const client = imap({ user, appPassword });
  const out = [];
  await client.connect();
  try {
    await client.mailboxOpen(sentMailbox, { readOnly: true });
    const uids = await client.search({ since: new Date(Date.now() - sinceDays * DAY_MS), subject: 'autopilot' }, { uid: true });
    if (!uids?.length) return out;
    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      const toSelf = parsed.to?.value?.some((a) => a.address?.toLowerCase() === user.toLowerCase());
      const request = parseRequest(parsed.subject);
      if (!toSelf || !request || /^\[autopilot\]/i.test(parsed.subject ?? '')) continue;
      out.push({ messageId: parsed.messageId, subject: parsed.subject, date: parsed.date?.toISOString(), ...request });
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

// Sends to yourself, then labels the message "Autopilot" and takes it out of
// the inbox so exports don't pile up there. Labeling is best effort.
export async function sendToSelf({ user, appPassword, label }, { subject, text, attachments = [], inReplyTo }) {
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: appPassword } });
  const info = await transport.sendMail({
    from: `Actual Autopilot <${user}>`,
    to: user,
    subject,
    text,
    attachments,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  if (label) await fileAway({ user, appPassword }, info.messageId, label).catch(() => {});
  return info.messageId;
}

export async function fileAway(auth, messageId, label) {
  const client = imap(auth);
  await client.connect();
  try {
    await client.mailboxOpen('[Gmail]/All Mail');
    // Gmail can take a moment to file a just-sent message.
    for (let i = 0; i < 5; i++) {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (uids?.length) {
        await client.messageFlagsAdd(uids, [label], { uid: true, useLabels: true });
        await client.messageFlagsRemove(uids, ['\\Inbox'], { uid: true, useLabels: true });
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
