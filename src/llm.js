import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const client = new Anthropic();

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

async function parse(system, user, schema) {
  const response = await client.messages.parse({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: process.env.CLAUDE_EFFORT || 'low',
      format: zodOutputFormat(schema),
    },
  });
  if (response.stop_reason === 'refusal') {
    console.warn(`Claude declined: ${response.stop_details?.explanation ?? 'no explanation'}`);
    return null;
  }
  if (response.stop_reason === 'max_tokens') {
    console.warn('Claude hit max_tokens; skipping this batch');
    return null;
  }
  return response.parsed_output ?? null;
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
