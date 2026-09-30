import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_RPM = '6000';
process.env.GEMINI_RPD = '2';
const { categorizeTransactions } = await import('../src/llm.js');

const answer = { results: [{ id: 't1', category_id: 'c1', confidence: 0.9, reason: 'same payee' }] };
const input = { categories: [{ id: 'c1', group: 'Bills', name: 'Phone' }], examples: [], transactions: [{ id: 't1' }] };
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('Gemini: parses the answer, then stops at the daily cap and on 429', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }] })();
  });
  assert.deepEqual(await categorizeTransactions(input), answer);
  assert.equal(calls[0].generationConfig.responseJsonSchema.$schema, undefined);

  t.mock.method(globalThis, 'fetch', reply(429, { error: { message: 'quota' } }));
  assert.equal(await categorizeTransactions(input), null); // 2nd call today: 429
  assert.equal(await categorizeTransactions(input), null); // paused, and over GEMINI_RPD=2
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
