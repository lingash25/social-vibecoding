'use strict';

// Homeroom bot parity (P1-P9): the cards the bot puts under a reply beyond
// its request, change and project cards, and the taps on them.
//
// A card is the reply's metadata `card` (homeroomBot.card on the stored
// message): { type, v: 1, ...what that type draws }. The client draws it
// (frontend/src/features/messages/bot-cards/), and a tap on it comes here:
//
//   POST /api/conversations/homeroom-bot/cards/:messageId  { action, value? }
//
// decide() checks the message is the bot's, in a conversation the person is
// in, and carries a card of a type registered below; the type's handler
// decides the tap as that person. A handler answers
//   { ok: true, patch?, ...out }     patch: fields merged into the card and pushed to every open tab
//   { ok: false, status?, error }    nothing changed
// and never throws for a refusal. Taps that only send words as the person
// (pick an option, answer a question set) are sent from the client as their
// own message and never reach here.

const log = require('../logger');

const HANDLERS = Object.freeze({
  options: () => require('./options'), // P2
  questions: () => require('./questions'), // P2
  table: () => require('./table'), // P2
  compare: () => require('./compare'), // P2, design threads
  batch: () => require('./batch'), // P4
  build_note: () => require('./build-note'), // P5
  checks_green: () => require('./checks-green'), // P6
  confirm: () => require('./confirm'), // P7
  gallery: () => require('./gallery'), // P8
  investigation: () => require('./investigation'), // P9
});

const MAX_ACTION_CHARS = 60;
const MAX_VALUE_CHARS = 2000;

/** Pure: a card as stored, or null when it is not one of ours. */
function cardOf(metadata) {
  const bot = metadata && typeof metadata === 'object' ? metadata.homeroomBot : null;
  const card = bot && typeof bot === 'object' ? bot.card : null;
  if (!card || typeof card !== 'object' || typeof card.type !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(HANDLERS, card.type) ? card : null;
}

/** Pure: a tap's value, bounded: a string, a number, a boolean, or a flat list of strings. */
function boundedValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((v) => (typeof v === 'string' ? v.slice(0, 400) : null)).filter((v) => v !== null);
  }
  return null;
}

/**
 * Merge `patch` into a message's card and tell every tab that has it open.
 * Never throws.
 */
async function setCardState(pool, messageId, patch, { userId = null, ws = null } = {}) {
  try {
    const { rows } = await pool.query(
      'SELECT metadata, conversation_id, sender_id, thread_root_id FROM conversation_messages WHERE id = $1',
      [messageId],
    );
    if (!rows.length) return false;
    const metadata = rows[0].metadata && typeof rows[0].metadata === 'object' ? rows[0].metadata : {};
    const bot = metadata.homeroomBot && typeof metadata.homeroomBot === 'object' ? metadata.homeroomBot : {};
    const card = bot.card && typeof bot.card === 'object' ? bot.card : null;
    if (!card) return false;
    await require('../conversations').setMessageMetadata(pool, messageId, {
      ...metadata, homeroomBot: { ...bot, card: { ...card, ...patch } },
    });
    const io = ws || require('../ws');
    io.pushConversationEvent([rows[0].sender_id, userId].filter(Boolean), {
      type: 'conversation_message_updated', conversationId: Number(rows[0].conversation_id), messageId: Number(messageId),
      threadRootId: rows[0].thread_root_id ? Number(rows[0].thread_root_id) : null,
    }, { actorUserId: rows[0].sender_id });
    return true;
  } catch (err) {
    log.warn('homeroom-bot-cards', 'Could not update a card', { messageId, err: err.message });
    return false;
  }
}

/**
 * A tap on a card, decided as `user`. Resolves { ok, ... } or
 * { ok: false, status, error }. Never throws.
 */
async function decide(pool, config, { user, messageId, action, value = null, deps = {} }) {
  try {
    if (!user?.id || user.isSynthetic) return { ok: false, status: 403, error: 'forbidden' };
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return { ok: false, status: 404, error: 'No such card' };
    const act = typeof action === 'string' ? action.trim().slice(0, MAX_ACTION_CHARS) : '';
    if (!act) return { ok: false, status: 400, error: 'Say what was tapped' };
    const { rows } = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.thread_root_id, m.metadata, u.is_synthetic
         FROM conversation_messages m
         JOIN users u ON u.id = m.sender_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 AND cm.status = 'member'
        WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [id, user.id],
    );
    const row = rows[0];
    if (!row || !row.is_synthetic) return { ok: false, status: 404, error: 'No such card' };
    const card = cardOf(row.metadata);
    if (!card) return { ok: false, status: 404, error: 'No such card' };
    const handler = (deps.cardHandlers && deps.cardHandlers[card.type]) || HANDLERS[card.type]();
    if (!handler || typeof handler.decide !== 'function') return { ok: false, status: 404, error: 'No such card' };
    const out = await handler.decide(pool, config, {
      user, card, action: act, value: boundedValue(value), deps,
      message: {
        id: Number(row.id), conversationId: Number(row.conversation_id), botId: Number(row.sender_id),
        threadRootId: row.thread_root_id ? Number(row.thread_root_id) : null,
      },
    });
    if (!out || typeof out !== 'object') return { ok: false, status: 500, error: 'That did not work just now' };
    if (out.ok && out.patch && typeof out.patch === 'object') {
      await setCardState(pool, Number(row.id), out.patch, { userId: user.id, ws: deps.ws || null });
    }
    const { patch: _patch, ...rest } = out;
    return rest;
  } catch (err) {
    log.warn('homeroom-bot-cards', 'A card tap failed', { messageId, err: err.message });
    return { ok: false, status: 500, error: 'That did not work just now' };
  }
}

const MAX_HISTORY_LINE_CHARS = 1500;

/**
 * Pure: how a card reads in the model's history, under the reply it was put
 * under ("[Homeroom: under this reply you offered ...]"), from its type's
 * handler (`historyLine(card)`, optional), or null. The model never sees a
 * card otherwise: its tool call is not kept. Never throws.
 */
function historyLine(card) {
  try {
    if (!card || typeof card !== 'object' || typeof card.type !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, card.type)) return null;
    const handler = HANDLERS[card.type]();
    const line = typeof handler?.historyLine === 'function' ? handler.historyLine(card) : null;
    if (typeof line !== 'string' || !line.trim()) return null;
    return line.length > MAX_HISTORY_LINE_CHARS ? `${line.slice(0, MAX_HISTORY_LINE_CHARS - 2)}…]` : line;
  } catch (err) {
    log.warn('homeroom-bot-cards', 'Could not read a card back for the history', { type: String(card?.type).slice(0, 40), err: err.message });
    return null;
  }
}

module.exports = { decide, setCardState, cardOf, boundedValue, historyLine, HANDLERS };
