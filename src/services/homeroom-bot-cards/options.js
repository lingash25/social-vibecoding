'use strict';

// Homeroom bot parity, P2: taps on the "options" card (see ./index.js), made
// by offer_options (../homeroom-bot-thread-tools/cards.js):
//
//   { type: 'options', v: 1, title?, options: [{ key: 'A', title, detail? }], picked: null | 'B' }
//
// Pick is decided here, once, so the card says which was picked on every
// device; the client then says "B: <title>" as the person, which the bot
// reads like anything they type. Show only says words (the client's own).

const list = (value) => (Array.isArray(value) ? value : []);

/** Pure: the option a pick names on a card, or null. */
function optionOf(card, key) {
  const wanted = typeof key === 'string' ? key.trim().toUpperCase() : '';
  return list(card?.options).find((o) => o && typeof o.key === 'string' && o.key === wanted) || null;
}

async function decide(_pool, _config, { card, action, value }) {
  if (action !== 'pick') return { ok: false, status: 400, error: 'That is not something this card does' };
  const option = optionOf(card, value);
  if (!option) return { ok: false, status: 400, error: 'No such option' };
  // Picked already, here or on another device: the card says which.
  if (card.picked) return { ok: true, picked: String(card.picked), already: true };
  return { ok: true, picked: option.key, patch: { picked: option.key, pickedAt: new Date().toISOString() } };
}

/** Pure: how the card reads in the model's history (index.js historyLine). */
function historyLine(card) {
  const options = list(card?.options).filter((o) => o && o.key && o.title);
  if (!options.length) return null;
  const listed = options.map((o) => `${o.key}. ${o.title}${o.detail ? ` (${o.detail})` : ''}`).join('; ');
  const picked = optionOf(card, card.picked);
  return `[Homeroom: under this reply you offered options${card.title ? ` for "${card.title}"` : ''}: ${listed}. `
    + `${picked ? `They picked ${picked.key}.` : 'They have not picked one.'}]`;
}

module.exports = { decide, historyLine, optionOf };
