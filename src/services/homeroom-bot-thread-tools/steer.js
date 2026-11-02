'use strict';

// Homeroom bot parity, P5: see ./index.js for this module's shape.
//
// add_to_build: the person who asked for a request (or its project's owner)
// adds to it or corrects it while the bot builds it. Their note goes to the
// build, which is handed it at its next stop (homeroom-bot-steer.js; the
// build's Stop hook, worker/build-stop-hook.js), and a card under the reply
// says when it has it (build_note: waiting, then delivered, or missed when
// the build ended first).
//
// stop_and_redo: they want the build stopped and done again with their
// note. Only offered here: the card carries Stop and redo and Keep going,
// and nothing stops until they tap (homeroom-bot-cards/build-note.js).

function steerOf(ctx) { return ctx?.deps?.steer || require('../homeroom-bot-steer'); }
function mayorOf(ctx) { return ctx?.deps?.mayor || require('../homeroom-bot-mayor'); }

const PARAMS = Object.freeze({
  type: 'object',
  properties: {
    project: { type: 'string', description: 'The project\'s name or short name.' },
    number: { type: 'integer', description: 'The request number of the build.' },
    note: { type: 'string', description: 'What they want added or changed, in their words, as the coding agent should read it.' },
  },
  required: ['project', 'number', 'note'],
  additionalProperties: false,
});

const ADD_TO_BUILD = Object.freeze({
  type: 'function',
  function: {
    name: 'add_to_build',
    description: 'While you are building one of their requests right now, they add something to it or correct it. Sends their note to the build, which reads it at its next step, before it finishes, and a card under your reply says when it has. Only for a build under way (progress says building); for a change already up for a vote use revise_proposal. One per turn.',
    parameters: PARAMS,
  },
});

const STOP_AND_REDO = Object.freeze({
  type: 'function',
  function: {
    name: 'stop_and_redo',
    description: 'They want a build of theirs that is running now stopped and done again with their note (it is going the wrong way, they changed their mind). Puts Stop and redo and Keep going under your reply; nothing stops until they tap Stop and redo. Then their note goes on the request\'s discussion under their name and you read the request again first. One per turn.',
    parameters: PARAMS,
  },
});

/** Pure: whether this turn may steer builds (a private chat with the bot). */
function offered(ctx) {
  return !!ctx?.user?.id && !ctx.inPublic;
}

/**
 * The request, the build and the gates both tools share: the project they
 * can see, the request on it, its build under way, and they asked for it or
 * manage the project. Resolves { app, n, build, gate, note } or { error }.
 */
async function resolve(pool, ctx, args, { running = false } = {}) {
  const steer = steerOf(ctx);
  const note = steer.noteText(args.note);
  if (!note) return { error: 'Say what they want added or changed. If they have not said, ask them. Nothing was sent.' };
  const mayor = mayorOf(ctx);
  const app = await mayor.findApp(pool, args.project);
  const n = Number(args.number);
  if (!app || !Number.isInteger(n) || n <= 0 || !(await mayor.canView(pool, app, ctx.user))) {
    return { error: 'No such request on a project they can see. Check progress or my_work. Nothing was sent.' };
  }
  ctx.appIds?.add?.(Number(app.id));
  const name = app.name || app.slug;
  const gate = await steer.maySteer(pool, { app, user: ctx.user, issueNumber: n, deps: ctx.deps || {} });
  if (!gate.ok) {
    return { error: `Only whoever asked for ${name} request #${n}, or the project's owner, can change its build while it runs. They can comment on the request instead (comment_on_request). Nothing was sent.` };
  }
  const build = await steer.buildUnderWay(pool, app.id, n);
  if (!build) {
    return { error: `You are not building ${name} request #${n} right now, so there is no build to send it to. If its change is up for a vote, revise_proposal changes it; otherwise comment_on_request adds it to the request. Nothing was sent.` };
  }
  if (running && !build.running) {
    return { error: `Its build has not started yet, so there is nothing to stop: send the note with add_to_build and the build reads it as it works. Nothing was stopped.` };
  }
  return { app, n, name, build, gate, note };
}

function cardOf({ id, state, app, n, note, title = null }) {
  return {
    type: 'build_note', v: 1, state, noteId: id,
    project: app.slug, projectName: app.name || app.slug, number: n, ...(title ? { title } : {}), note,
  };
}

async function titleOf(pool, appId, n) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE((SELECT NULLIF(BTRIM(title), '') FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id DESC LIMIT 1),
                       (SELECT NULLIF(BTRIM(issue_title), '') FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2)) AS title`,
      [Number(appId), Number(n)],
    );
    return rows[0]?.title ? String(rows[0].title).slice(0, 160) : null;
  } catch {
    return null;
  }
}

async function addToBuild(pool, ctx, args) {
  if (ctx.steered) return { ok: false, error: 'One note per turn: put everything they said into one.' };
  const r = await resolve(pool, ctx, args);
  if (r.error) return { ok: false, error: r.error };
  const id = await steerOf(ctx).addNote(pool, {
    app: r.app, issueNumber: r.n, build: r.build, user: ctx.user, note: r.note, conversationId: ctx.conversationId,
  });
  ctx.steered = true;
  ctx.card = cardOf({ id, state: 'waiting', app: r.app, n: r.n, note: r.note, title: await titleOf(pool, r.app.id, r.n) });
  return {
    ok: true,
    sent: `Your note waits for the build of ${r.name} request #${r.n}: it is handed it at its next step, before it finishes, and works it in then.`,
    shown: 'A card under your reply shows the note and says when the build has it. It has not read it yet, so never say it has, or that the change is made.',
  };
}

async function stopAndRedo(pool, ctx, args) {
  if (ctx.steered) return { ok: false, error: 'One per turn.' };
  const r = await resolve(pool, ctx, args, { running: true });
  if (r.error) return { ok: false, error: r.error };
  const id = await steerOf(ctx).addNote(pool, {
    app: r.app, issueNumber: r.n, build: r.build, user: ctx.user, note: r.note, conversationId: ctx.conversationId,
    kind: 'redo', state: 'offered',
  });
  ctx.steered = true;
  ctx.card = cardOf({ id, state: 'offer_redo', app: r.app, n: r.n, note: r.note, title: await titleOf(pool, r.app.id, r.n) });
  return {
    ok: true,
    offered: 'Stop and redo and Keep going are under your reply, for them to tap. Nothing is stopped until they tap Stop and redo: then the build stops, their note goes on the request\'s discussion under their name, and you read the request again first. Keep going sends the note into the running build instead. Never say it was stopped.',
  };
}

module.exports = {
  tools: (ctx) => (offered(ctx) ? [ADD_TO_BUILD, STOP_AND_REDO] : []),
  run: async (pool, ctx, name, args) => {
    if (name === 'add_to_build') return addToBuild(pool, ctx, args);
    if (name === 'stop_and_redo') return stopAndRedo(pool, ctx, args);
    return undefined;
  },
  promptLines: (ctx) => (offered(ctx) ? [
    '- When they add to or correct a request of theirs that you are building right now (progress says building),',
    '  send their words to the build (add_to_build): it reads them at its next step, before it finishes. When they',
    '  want that build stopped and done again with their note, offer it (stop_and_redo); nothing stops until they',
    '  tap Stop and redo. For a change already up for a vote, use revise_proposal instead.',
  ] : []),
  ADD_TO_BUILD,
  STOP_AND_REDO,
  offered,
  resolve,
  addToBuild,
  stopAndRedo,
};
