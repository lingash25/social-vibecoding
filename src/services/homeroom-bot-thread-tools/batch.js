'use strict';

// Homeroom bot parity, P4: see ./index.js for this module's shape.
//
// work_through: "go through my requests on Gym Tracker" puts a table card
// under the reply (homeroom-bot-batches.js propose): each request with what
// the bot last found on it, the ones it has not read lately read again, and
// Build the N under it (homeroom-bot-cards/batch.js), which starts the ready
// ones and turns the card into their roll-up. Nothing is built from here.

const MAX_NOTE = 300;

function batchesOf(ctx) { return ctx?.deps?.batches || require('../homeroom-bot-batches'); }
function mayorOf(ctx) { return ctx?.deps?.mayor || require('../homeroom-bot-mayor'); }

const WORK_THROUGH = Object.freeze({
  type: 'function',
  function: {
    name: 'work_through',
    description: 'They want to go through several of their requests on one project at once (up to 20): see where each stands and build the ready ones. Puts a table under your reply with what you last found on each (ready, a question, left for the group, done, under way), reads again the ones you have not read lately, and gives them Build the ready ones, Answer the questions and Close for one that is done. Nothing is built until they tap Build. Name the requests, or which: "mine" for their own open requests there that nobody has taken. One per turn.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project\'s name or short name.' },
        numbers: { type: 'array', items: { type: 'integer' }, maxItems: 20, description: 'The request numbers they named, up to 20.' },
        which: { type: 'string', enum: ['mine'], description: '"mine": their own open requests on the project that nobody has taken, when they did not name numbers.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
});

/** Pure: whether this turn may offer work_through (a private chat with the bot, not a project's chat). */
function offered(ctx) {
  return !!ctx?.user?.id && !ctx.inPublic;
}

/** Pure: a work_through call's arguments, or { error } for one that names nothing. */
function argsOf(args = {}) {
  const project = String(args.project || '').trim();
  if (!project) return { error: 'Say which project. Check my_projects.' };
  const numbers = require('../homeroom-bot-batches').numbersOf(Array.isArray(args.numbers) ? args.numbers : []);
  const which = args.which === 'mine' ? 'mine' : null;
  if (!numbers.length && !which) return { error: 'Name the requests (numbers), or which: "mine" for their own open ones there.' };
  return { project, numbers, which };
}

async function workThrough(pool, ctx, args) {
  if (ctx.batch) return { ok: false, error: 'One table per turn.' };
  const asked = argsOf(args);
  if (asked.error) return { ok: false, error: asked.error };
  const mayor = mayorOf(ctx);
  const app = await mayor.findApp(pool, asked.project);
  if (!app || !(await mayor.canView(pool, app, ctx.user))) {
    return { ok: false, error: 'No such project they can see. Check my_projects. Nothing was read.' };
  }
  ctx.appIds?.add?.(Number(app.id));
  const out = await batchesOf(ctx).propose(pool, {
    app, user: ctx.user, numbers: asked.numbers, which: asked.which, settings: ctx.settings,
    conversationId: ctx.conversationId, deps: ctx.deps?.batchDeps || {},
  });
  if (!out.ok) return { ok: false, error: out.error, ...(out.unknown ? { unknown: out.unknown } : {}), ...(out.closed ? { closed: out.closed } : {}) };
  ctx.batch = out.batchId;
  ctx.card = out.card;
  // Reads it started come back on their own: what it says of them is true.
  if (out.queued.length) ctx.batchQueued = true;
  const name = app.name || app.slug;
  return {
    ok: true,
    project: app.slug,
    projectName: name,
    summary: out.card.label,
    requests: out.rows.map((r) => ({
      number: r.number, title: r.title, found: r.read,
      ...(r.note ? { note: String(r.note).slice(0, MAX_NOTE) } : {}),
      ...(r.why ? { why: r.why } : {}),
    })),
    ...(out.queued.length ? { readingNow: `Queued to be read again now, at the front of your queue: ${out.queued.map((n) => `#${n}`).join(', ')}. Their rows update when you have read them.` } : {}),
    ...(out.unknown.length ? { notRequests: out.unknown } : {}),
    ...(out.closed.length ? { closedLeftOut: out.closed } : {}),
    ...(out.raise ? {
      raised: `They manage ${name}, so Build may run up to ${out.raise.perPerson || ctx.settings?.perPerson || 3} of these at once and hold up to ${out.raise.proposalsPerApp} of your changes open on it, for this batch only.`,
    } : {}),
    shown: `The table is under your reply: one row per request, with Build for the ${out.counts.ready} ready ${out.counts.ready === 1 ? 'one' : 'ones'}. Nothing is built until they tap Build. Say what it shows in a sentence or two; never list every row in your words.`,
  };
}

module.exports = {
  tools: (ctx) => (offered(ctx) ? [WORK_THROUGH] : []),
  run: async (pool, ctx, name, args) => (name === 'work_through' ? workThrough(pool, ctx, args) : undefined),
  promptLines: (ctx) => (offered(ctx) ? [
    '- Go through several of their requests on one project at once when they ask you to work through, sort out or',
    '  build a list of them (work_through), with the numbers they named or which "mine" for their own open ones there.',
    '  It puts a table under your reply with what you last found on each, reads again the ones you have not read',
    '  lately, and offers Build for the ready ones. Nothing is built until they tap Build; never say it was.',
  ] : []),
  WORK_THROUGH,
  offered,
  argsOf,
  workThrough,
};
