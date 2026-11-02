'use strict';

// Homeroom bot parity, P2: taps on the "compare" card (see ./index.js): a
// design thread's versions side by side (design-bot.js compare_versions),
// { rootId, items: [{ version: n | 'now', label }], picked? }.
//
//   pick   value: an item's version (a number, or 'now' for the screen the
//          thread started from). Patch { picked }; the client then says
//          "Pick version N" as the person, which the designer reads.

const { compareKey } = require('../design-bot-compare');

async function decide(pool, _config, { user, card, action, value, deps = {} }) {
  if (action !== 'pick') return { ok: false, status: 400, error: 'Unknown action' };
  const key = compareKey(value);
  const items = Array.isArray(card.items) ? card.items : [];
  if (key == null || !items.some((item) => compareKey(item?.version) === key)) {
    return { ok: false, status: 404, error: 'No such version' };
  }
  const threads = deps.designThreads || require('../design-threads');
  const design = await threads.designFor(pool, { userId: user.id, rootId: card.rootId });
  if (!design) return { ok: false, status: 404, error: 'No such design' };
  return { ok: true, picked: key, patch: { picked: key } };
}

module.exports = { decide };
