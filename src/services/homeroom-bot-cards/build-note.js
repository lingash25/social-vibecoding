'use strict';

// Homeroom bot parity, P5: taps on the "build_note" card (see ./index.js),
// decided as the person who sent the note (homeroom-bot-steer.js):
//
//   redo     on a Stop and redo offer: stops the build and starts the
//            request again with the note
//   keep     on the same offer: nothing stops, the note goes into the build
//   forward  on a missed note: Put it in the next update, posted on the
//            change's discussion as theirs, which queues its follow-up

function steerOf(deps) { return deps?.steer || require('../homeroom-bot-steer'); }

async function decide(pool, config, { user, card, action, message, deps = {} }) {
  const steer = steerOf(deps);
  const row = await steer.noteRow(pool, card?.noteId);
  if (!row || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (action === 'redo') return steer.redo(pool, config, { row, user, message, deps });
  if (action === 'keep') return steer.keep(pool, { row, user, message });
  if (action === 'forward') return steer.forward(pool, config, { row, user, card, message, deps });
  return { ok: false, status: 400, error: 'That is not something this card does' };
}

module.exports = { decide };
