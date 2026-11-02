'use strict';

// Homeroom bot parity, P7: taps on the "confirm" card (see ./index.js), the
// card an admin tool puts under the bot's reply when it would change
// something (homeroom-bot-thread-tools/admin.js):
//
//   { type: 'confirm', v: 1, confirmId, tool, title, rows: [{ label, value }],
//     state: 'pending' | 'done' | 'failed' | 'cancelled' | 'expired', expiresAt,
//     result? }
//
// Confirm claims its sealed action once (pending, unexpired, this admin's,
// in this conversation), checks they are still a full admin, runs it as them
// and puts the outcome on the card; Cancel dismisses it. Anything else, and
// anybody else, changes nothing.

const { setCardState } = require('./index');

module.exports = {
  async decide(pool, config, { user, card, action, message, deps = {} }) {
    const admin = deps.adminTools || require('../homeroom-bot-thread-tools/admin');
    const actionId = typeof card?.confirmId === 'string' ? card.confirmId : '';
    const where = { user, actionId, conversationId: message.conversationId };
    if (action === 'confirm') {
      const out = await admin.confirmAction(pool, config, { ...where, botId: message.botId, threadRootId: message.threadRootId, deps });
      if (!out.ok) {
        // A card that ran out of time says so on every device.
        if (out.expired) await setCardState(pool, message.id, { state: 'expired' }, { userId: user.id, ws: deps.ws || null });
        return { ok: false, status: out.status, error: out.error };
      }
      return {
        ok: true, state: out.state, result: out.result, ...(out.secret ? { secret: out.secret } : {}),
        patch: { state: out.state, result: out.result, decidedAt: new Date().toISOString() },
      };
    }
    if (action === 'cancel') {
      const out = await admin.cancelAction(pool, where);
      if (!out.ok) return { ok: false, status: out.status, error: out.error };
      return { ok: true, state: out.state, result: out.result, patch: { state: out.state, result: out.result, decidedAt: new Date().toISOString() } };
    }
    return { ok: false, status: 400, error: 'Tap Confirm or Cancel' };
  },
};
