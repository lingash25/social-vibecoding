'use strict';

// Homeroom bot parity, P9: taps on the "investigation" card (see ./index.js
// and ../homeroom-bot-thread-tools/investigate.js).
//
//   start    Start: only its owner, only while proposed, at most MAX_RUNNING
//            of theirs at once, and only while the bot works on the project.
//            The card's message becomes where it reports (its thread), and
//            the bot-investigation machine is asked to start it: the first
//            check-in runs at once.
//   not_now  Not now: set aside, nothing ran.
//   stop     Stop: the machine ends it (a check-in under way is cut off).
//
// Notes and "File what it found" are the client's own: the notes are on the
// card, and the second is said as the person (sayAsMe).

const rules = require('../../workflow/rules/investigation.ts');

const refuse = (status, error) => ({ ok: false, status, error });

async function decide(pool, config, { user, card, action, message, deps = {} }) {
  const inv = deps.investigate || require('../homeroom-bot-thread-tools/investigate');
  const row = await inv.load(pool, Number(card?.investigationId));
  if (!row || Number(row.user_id) !== Number(user.id)
      || (row.conversation_id != null && Number(row.conversation_id) !== Number(message.conversationId))) {
    return refuse(404, 'No such investigation');
  }
  const machine = deps.investigationMachine || require('../../workflow/bot-investigation/machine.ts');
  const now = new Date();
  switch (action) {
    case 'start': {
      if (row.state !== 'proposed') return refuse(409, row.state === 'declined' ? 'It was set aside. Ask Homeroom bot again to start one.' : 'It has started already.');
      if (await inv.runningCount(pool, user.id) >= rules.MAX_RUNNING) {
        return refuse(409, `${rules.MAX_RUNNING} of your investigations are running already. Stop one first.`);
      }
      const look = deps.look || require('../homeroom-bot-thread-tools/look-into');
      const app = await look.appOf(pool, row.app_id);
      const settings = deps.settings || await (deps.botSvc || require('../homeroom-bot')).readSettings(pool);
      const found = app ? await look.projectFor(pool, user, app.slug) : { error: 'gone' };
      if (found.error) return refuse(403, 'You can no longer build on that project.');
      const refused = await look.gate(pool, { user, app, settings, deps, doing: 'investigation' });
      if (refused) return refuse(409, refused.error.replace('Their building time', 'Your building time'));
      // Where it reports: the card's own message and thread.
      await pool.query(
        `UPDATE homeroom_bot_investigations
            SET card_message_id = $2, conversation_id = $3, thread_root_id = COALESCE($4, thread_root_id)
          WHERE id = $1 AND state = 'proposed'`,
        [row.id, message.id, message.conversationId, message.threadRootId || null],
      );
      await machine.requestStart(pool, { investigationId: Number(row.id), appId: Number(row.app_id), userId: Number(user.id) });
      return {
        ok: true,
        patch: {
          state: 'running', startedAt: now.toISOString(), endsAt: rules.endsAtOf(now, Number(row.days)).toISOString(),
          nextAt: now.toISOString(), spentCents: 0, checkinsDone: 0,
        },
      };
    }
    case 'not_now': {
      if (row.state !== 'proposed') return refuse(409, 'It has started already.');
      await pool.query(`UPDATE homeroom_bot_investigations SET state = 'declined', ended_at = NOW() WHERE id = $1 AND state = 'proposed'`, [row.id]);
      return { ok: true, patch: { state: 'declined' } };
    }
    case 'stop': {
      if (row.state !== 'running') return refuse(409, 'It is not running.');
      await machine.requestStop(pool, { investigationId: Number(row.id), appId: Number(row.app_id), userId: Number(user.id), by: user.username || null });
      return { ok: true, patch: { state: 'ended', endedReason: 'stopped', endedAt: now.toISOString(), nextAt: null } };
    }
    default:
      return refuse(400, 'That is not something this card does.');
  }
}

module.exports = { decide };
