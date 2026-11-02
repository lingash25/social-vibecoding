'use strict';

// Homeroom bot parity, P6: taps on the "checks_green" card (see ./index.js),
// which follows one of the bot's changes past a failing check that is not its
// own (homeroom-bot-flaky-checks.js):
//
//   { type: 'checks_green', v: 1, state: 'working' | 'green' | 'person',
//     steps: [{ state: 'done' | 'now' | 'todo' | 'failed', what, request?: { project, number } }],
//     change: { project, sessionId, prNumber? }, fix?: { project, number, sessionId?, prNumber? } }
//
// The ladder patches the card itself as it moves (setCardState). Its buttons
// open the fix (its request, or its change to vote on) in the client. The one
// tap decided here is `refresh`: the card drawn again from where the change
// stands now, for the person it was posted to.

module.exports = {
  async decide(pool, config, { user, card, action, message, deps = {} }) {
    void config;
    if (action !== 'refresh') return { ok: false, status: 400, error: 'Nothing to decide on this card' };
    const flaky = deps.flakyChecks || require('../homeroom-bot-flaky-checks');
    const sessionId = Number(card?.change?.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return { ok: false, status: 404, error: 'No such card' };
    const wait = await flaky.waitOf(pool, sessionId);
    if (!wait || Number(wait.card_message_id) !== Number(message.id) || Number(wait.card_user_id) !== Number(user.id)) {
      return { ok: false, status: 404, error: 'No such card' };
    }
    const flakes = await flaky.flakesOf(pool, wait.flake_ids);
    const patch = flaky.cardFor({
      wait, flakes,
      change: { id: sessionId, slug: card?.change?.project || null, pr_number: card?.change?.prNumber || null },
      platformSlug: require('../homeroom-bot').PLATFORM_SELF_APP_SLUG,
    });
    return { ok: true, patch };
  },
};
