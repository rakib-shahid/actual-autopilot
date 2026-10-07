// Transactions Gemini wasn't sure about carry "#review maybe <Group> / <Name>"
// in their notes. These helpers read and clear that tag for the web page.

export const REVIEW_TAG = '#review';
export const SKIPPED_TAG = '#review-skipped';
const PENDING = /\s*#review maybe (.*)$/;

export const reviewNote = (guess) => `${REVIEW_TAG} maybe ${guess}`;

// The notes without the review tag: what the web page lets you edit.
export const editableNotes = (notes) => (notes ?? '').replace(PENDING, '').trim();

export function isPendingReview(notes) {
  return PENDING.test(notes ?? '');
}

// The category Gemini guessed, matched against the current category list.
export function guessedCategory(notes, categories) {
  const m = (notes ?? '').match(PENDING);
  if (!m || m[1] === 'no guess') return null;
  return categories.find((c) => `${c.group} / ${c.name}` === m[1].trim()) ?? null;
}

// Notes after a decision: the tag is replaced so the transaction leaves the
// review list. A skipped one keeps a #review-skipped tag so Gemini doesn't
// categorize it again on the next run.
export function resolvedNotes(notes, { skipped = false } = {}) {
  const base = (notes ?? '').replace(PENDING, '').trim();
  const tag = skipped ? SKIPPED_TAG : 'auto: reviewed';
  return base ? `${base} ${tag}` : tag;
}
