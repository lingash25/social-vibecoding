'use strict';

// Homeroom bot parity, P2: the compare card in a design thread. The designer
// (design-bot.js) answers "show me them side by side", or "next to how it
// looks now", with compare_versions, and its reply carries a card
//
//   { type: 'compare', v: 1, rootId, items: [{ version: n | 'now', label }], picked: null }
//
// drawn as small live previews side by side (frontend features/messages/
// bot-cards/compare.tsx), each with Pick (homeroom-bot-cards/compare.js),
// and Propose for the one picked. 'now' is the captured screen the thread
// started from (design-threads.js startDesign: version 1, author 'capture').
// Pure but for nothing: the design is handed in.

const MAX_LABEL = 40;
const MIN_ITEMS = 2;
const MAX_ITEMS = 3;

const TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'compare_versions',
    description: 'Show versions of this design side by side, as a card under your reply where they pick one: when they ask to '
      + 'compare versions, to see them next to each other, or next to how the screen looks now. 2 or 3 in all. The versions are '
      + 'this thread\'s numbers; one you drew this turn is the next number.',
    parameters: {
      type: 'object',
      properties: {
        versions: { type: 'array', items: { type: 'integer' }, description: 'The version numbers to show, in order.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'A short name for each of those versions, in the same order ("Bigger title").' },
        now: { type: 'boolean', description: 'true to put the screen as it is now first, as "Now" (only in a thread that began from a captured screen).' },
      },
      required: ['versions'],
      additionalProperties: false,
    },
  },
});

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Pure: an item's version as a card names it: 'now', a version number, or null. */
function compareKey(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'now') return 'now';
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 10_000 ? n : null;
}

/** Pure: whether the design began as a captured screen (its "Now"). */
function hasNow(design) {
  return design?.versions?.[0]?.author === 'capture';
}

/**
 * Pure: compare_versions' arguments made into a card: { card } or { error }
 * in words the model can act on. `latest` is the newest version that exists
 * once this turn is saved (design.latest, plus one for a screen drawn now).
 */
function compareCard({ design, args = {}, latest = null }) {
  if (!design?.rootId) return { error: 'There is no screen to compare yet: draw it with write_screen first.' };
  const newest = Number(latest ?? design.latest) || 0;
  const asked = Array.isArray(args.versions) ? args.versions : [];
  const labels = Array.isArray(args.labels) ? args.labels : [];
  const now = args.now === true;
  if (now && !hasNow(design)) {
    return { error: 'This thread did not begin from a captured screen, so there is no "now" to show. Compare its versions instead.' };
  }
  const items = now ? [{ version: 'now', label: 'Now' }] : [];
  const seen = new Set();
  for (const [i, raw] of asked.entries()) {
    const n = compareKey(raw);
    if (typeof n !== 'number') return { error: `${raw} is not a version number.` };
    if (n > newest) return { error: `There is no version ${n} yet: the newest is ${newest}.` };
    // With "now" first, version 1 is the same screen.
    if (seen.has(n) || (now && n === 1)) continue;
    seen.add(n);
    items.push({ version: n, label: clip(labels[i], MAX_LABEL) || `Version ${n}` });
  }
  if (items.length < MIN_ITEMS) return { error: 'Name at least two different versions to compare (or one and now: true).' };
  if (items.length > MAX_ITEMS) return { error: `Compare at most ${MAX_ITEMS} at once.` };
  return { card: { type: 'compare', v: 1, rootId: Number(design.rootId), title: clip(design.title, 120), items, picked: null } };
}

module.exports = { TOOL, MAX_ITEMS, compareKey, hasNow, compareCard };
