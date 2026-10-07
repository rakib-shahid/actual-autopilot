import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { reviewNote, isPendingReview, guessedCategory, resolvedNotes, REVIEW_TAG } from '../src/review.js';
import { startWebServer } from '../src/web.js';

const categories = [
  { id: 'c1', group: 'Wants', name: '📅 Subscriptions' },
  { id: 'c2', group: 'Needs', name: 'Groceries' },
];

test('review tag round trip', () => {
  const notes = `auto: email ${reviewNote('Wants / 📅 Subscriptions')}`;
  assert.ok(isPendingReview(notes));
  assert.equal(guessedCategory(notes, categories).id, 'c1');
  assert.equal(guessedCategory(`x ${reviewNote('no guess')}`, categories), null);
  assert.equal(guessedCategory(`x ${reviewNote('Gone / Deleted')}`, categories), null);
  assert.equal(resolvedNotes(notes), 'auto: email auto: reviewed');
  assert.equal(resolvedNotes(reviewNote('no guess')), 'auto: reviewed');
});

test('a skipped transaction leaves the list but stays out of auto-categorizing', () => {
  const skipped = resolvedNotes(`auto: email ${reviewNote('no guess')}`, { skipped: true });
  assert.ok(!isPendingReview(skipped));
  // categorize() skips anything whose notes contain the review tag.
  assert.ok(skipped.includes(REVIEW_TAG));
  assert.ok(!resolvedNotes(reviewNote('no guess')).includes(REVIEW_TAG));
});

async function withServer(opts, fn) {
  const calls = [];
  const api = {
    status: () => ({ running: false, logs: [] }),
    scan: () => (calls.push('scan'), true),
    review: async () => ({ items: [], categories: [] }),
    decide: async (d) => (calls.push(d), { applied: d.length }),
  };
  const server = startWebServer({ port: 0, publicDir: fileURLToPath(new URL('../public', import.meta.url)), api, log: () => {}, ...opts });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, calls);
  } finally {
    server.close();
  }
}

test('web server serves the page and the JSON API', async () => {
  await withServer({}, async (base, calls) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Actual Autopilot/);
    assert.equal((await fetch(base + '/api/scan', { method: 'POST' })).status, 202);
    const res = await fetch(base + '/api/review', { method: 'POST', body: JSON.stringify({ decisions: [{ id: 't1', category_id: 'c1' }] }) });
    assert.deepEqual(await res.json(), { applied: 1 });
    assert.equal((await fetch(base + '/api/review', { method: 'POST', body: '{"decisions": 5}' })).status, 400);
    assert.equal((await fetch(base + '/nope')).status, 404);
    assert.deepEqual(calls, ['scan', [{ id: 't1', category_id: 'c1' }]]);
  });
});

test('web server requires the password when WEB_PASSWORD is set', async () => {
  await withServer({ password: 's3cret' }, async (base) => {
    assert.equal((await fetch(base + '/api/status')).status, 401);
    const auth = (p) => ({ headers: { authorization: 'Basic ' + Buffer.from(`me:${p}`).toString('base64') } });
    assert.equal((await fetch(base + '/api/status', auth('wrong'))).status, 401);
    assert.equal((await fetch(base + '/api/status', auth('s3cret'))).status, 200);
  });
});

test('review notes can be edited before saving', async () => {
  const { editableNotes } = await import('../src/review.js');
  const notes = `Wingstop · auto: email ${reviewNote('Wants / 📅 Subscriptions')}`;
  assert.equal(editableNotes(notes), 'Wingstop · auto: email');
  assert.equal(resolvedNotes('wings for game night'), 'wings for game night auto: reviewed');
  assert.ok(!isPendingReview(resolvedNotes('x', { skipped: true })));
});
