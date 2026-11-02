'use strict';

// Homeroom bot parity, P4: taps on the "batch" card (see ./index.js).
//
//   build    starts every request of the batch that is ready now, as
//            start_request does, with the batch's raised caps in place
//            (homeroom-bot-batches.js start); the card becomes the roll-up
//   refresh  reads the running batch's roll-up again from the records
//
// Answer the questions and Close #N are words said as the person (the
// client's sayAsMe), which the bot reads like anything they type: they never
// reach here.

function batchesOf(deps) { return deps?.batches || require('../homeroom-bot-batches'); }

async function decide(pool, config, { user, card, action, message, deps = {} }) {
  const batches = batchesOf(deps);
  const batch = await batches.batchRow(pool, card?.batchId);
  if (!batch || Number(batch.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (action === 'build') {
    return batches.start(pool, config, { batch, user, message, deps });
  }
  if (action === 'refresh') {
    if (batch.state !== 'running') return { ok: true, state: batch.state };
    if (!batch.message_id) await pool.query('UPDATE homeroom_bot_batches SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [batch.id, message.id]);
    await batches.refreshBatch(pool, batch.id, { deps });
    return { ok: true, state: 'running' };
  }
  return { ok: false, status: 400, error: 'That is not something this card does' };
}

module.exports = { decide };
