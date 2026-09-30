import { z } from 'zod';

export const ExtractionSchema = z.object({
  is_transaction: z.boolean(),
  date: z.string().nullable(),
  amount: z.number().nullable(),
  direction: z.enum(['outflow', 'inflow']).nullable(),
  payee: z.string().nullable(),
  account_last4: z.string().nullable(),
  reason: z.string(),
});

export const CategorizationSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      category_id: z.string().nullable(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
});

const EXTRACT_SYSTEM = `You read bank and card alert emails and pull out the single money movement they report.

A transaction is money that already left or entered an account: a purchase, withdrawal, debit, transfer, deposit or refund. Statements, balance summaries, payment reminders, scheduled or upcoming payments, credit score updates and marketing are not transactions; set is_transaction to false for those.

For a transaction:
- date: the date the money moved, as YYYY-MM-DD. Use the email's sent date if the body gives none.
- amount: a positive number in dollars, e.g. 42.17.
- direction: "outflow" for money leaving the account, "inflow" for money arriving.
- payee: the merchant or counterparty as a short, clean name (e.g. "AT&T" rather than "ATT*BILL PAYMENT 800-331").
- account_last4: the last 4 digits of the account or card the email names, or null.
Always explain your call briefly in reason.`;

const CATEGORIZE_SYSTEM = `You categorize personal budget transactions in Actual Budget for one person.

You get their category list, examples of how they categorized past transactions, and new uncategorized transactions. For each new transaction pick the category they would most likely choose, following the examples first (same or similar payee) and common sense second.

- category_id must be one of the ids in the category list, or null if nothing fits.
- confidence is 0 to 1. Use 0.9+ only when the same payee was categorized the same way before or the choice is unambiguous. Use below 0.8 when you are guessing.
- Inflows like paychecks and refunds usually go to an income category or back to the category of the original purchase.
- Return one result for every transaction id you were given.`;

// Pulling fields out of an alert email and matching payees to categories are
// simple jobs, so the lightest model is the default.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Stay under the free tier's per-minute and per-day request limits (see
// https://aistudio.google.com/rate-limit). Past the daily cap, calls return null
// and callers retry on a later run.
const RPM = Number(process.env.GEMINI_RPM) || 10;
const RPD = Number(process.env.GEMINI_RPD) || 200;

const log = (...args) => console.log(new Date().toISOString(), ...args);
// Google resets daily quotas at midnight Pacific.
const pacificDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// ponytail: counts live in memory, so a restart resets today's count. Google's
// own quota still caps it, and a project without billing can't be charged.
const usage = { day: null, count: 0, nextAt: 0, pausedUntil: 0 };

async function takeSlot() {
  const now = Date.now();
  if (now < usage.pausedUntil) return false;
  if (usage.day !== pacificDay()) Object.assign(usage, { day: pacificDay(), count: 0 });
  if (usage.count >= RPD) {
    if (usage.count++ === RPD) log(`Gemini: reached GEMINI_RPD=${RPD} requests today; the rest waits for midnight Pacific`);
    return false;
  }
  const wait = usage.nextAt - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  usage.nextAt = Math.max(now, usage.nextAt) + 60_000 / RPM;
  usage.count++;
  return true;
}

async function parse(system, user, schema) {
  if (!(await takeSlot())) return null;
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json', responseJsonSchema: jsonSchema },
    }),
  });
  if (res.status === 429) {
    // Over a free-tier limit anyway: stop asking for a while instead of hammering it.
    usage.pausedUntil = Date.now() + 15 * 60_000;
    log('Gemini: rate limited (429); pausing Gemini calls for 15 minutes');
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message ?? res.statusText}`);

  const candidate = body.candidates?.[0];
  if (!candidate || candidate.finishReason !== 'STOP') {
    log(`Gemini: no answer (${body.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'empty'}); skipping`);
    return null;
  }
  const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    log('Gemini: answer did not match the schema; skipping');
    return null;
  }
  return parsed.data;
}

export async function extractTransaction(email) {
  const user = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Sent: ${email.date}`,
    '',
    '<email_body>',
    email.text,
    '</email_body>',
  ].join('\n');
  return parse(EXTRACT_SYSTEM, user, ExtractionSchema);
}

export async function categorizeTransactions({ categories, examples, transactions }) {
  const user = [
    '<categories>',
    ...categories.map((c) => `${c.id} | ${c.group} / ${c.name}${c.is_income ? ' (income)' : ''}`),
    '</categories>',
    '',
    '<past_examples format="payee | amount | category">',
    ...examples.map((e) => `${e.payee} | ${e.amount} | ${e.category}`),
    '</past_examples>',
    '',
    '<uncategorized format="id | date | payee | amount | account | notes">',
    ...transactions.map((t) => `${t.id} | ${t.date} | ${t.payee} | ${t.amount} | ${t.account} | ${t.notes ?? ''}`),
    '</uncategorized>',
  ].join('\n');
  return parse(CATEGORIZE_SYSTEM, user, CategorizationSchema);
}
