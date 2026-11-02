'use strict';

// Homeroom bot parity, P5: steering a build while it runs.
//
// add_to_build sends the note of the person who asked for a request (or of
// its project's owner) to the bot's build of it, which is handed it at its
// next stop (worker/build-stop-hook.js, pinned in tests/build-stop-hook.test.js);
// stop_and_redo offers Stop and redo and Keep going under the reply, and
// nothing stops until it is tapped. These pin the tools' gates, the card
// taps' routing, the claims check, and the card in each state; the notes'
// lifecycle against the schema is tests/bot-parity-p5-steer-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const steer = require('../src/services/homeroom-bot-steer');
const tool = require('../src/services/homeroom-bot-thread-tools/steer');
const cardHandler = require('../src/services/homeroom-bot-cards/build-note');
const threadTools = require('../src/services/homeroom-bot-thread-tools');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a note is their words, trimmed and bounded, and says at least two words', () => {
  assert.equal(steer.noteText('  Make it blue  '), 'Make it blue');
  assert.equal(steer.noteText('blue'), null);
  assert.equal(steer.noteText(''), null);
  assert.equal(steer.noteText(null), null);
  assert.ok(steer.noteText('word '.repeat(1000)).length <= steer.NOTE_CHARS);
});

test('the steering tools are offered in a private chat with the bot, never in a project\'s chat', () => {
  const ctx = { user: { id: 3 }, deps: {} };
  assert.deepEqual(tool.tools(ctx).map((t) => t.function.name), ['add_to_build', 'stop_and_redo']);
  assert.deepEqual(tool.tools({ ...ctx, inPublic: true }), []);
  const names = threadTools.toolsFor(ctx).map((t) => t.function.name);
  assert.ok(names.includes('add_to_build') && names.includes('stop_and_redo'));
  const lines = tool.promptLines(ctx).join('\n');
  assert.match(lines, /add to or correct a request of theirs that you are building right now/);
  assert.match(lines, /nothing stops until they\s+tap Stop and redo/);
  assert.ok(!lines.includes('—'));
  for (const t of [tool.ADD_TO_BUILD, tool.STOP_AND_REDO]) {
    assert.deepEqual(t.function.parameters.required, ['project', 'number', 'note']);
    assert.ok(!t.function.description.includes('—'));
  }
});

// A stand-in for the steering service and the project lookups.
function fakes({ canView = true, ok = true, build = { runId: 70, sessionId: 900, running: true } } = {}) {
  const added = [];
  const fake = {
    noteText: steer.noteText,
    async maySteer() { return { ok, theirs: ok, manages: false }; },
    async buildUnderWay() { return build; },
    async addNote(_pool, args) { added.push(args); return 55; },
  };
  const mayor = { findApp: async () => ({ id: 2, slug: 'gym', name: 'Gym Tracker' }), canView: async () => canView };
  const pool = { query: async () => ({ rows: [{ title: 'Dark mode' }] }) };
  return { added, pool, deps: { steer: fake, mayor } };
}

test('add_to_build: their words go to the build under way, with a card that says when it has them', async () => {
  const f = fakes();
  const ctx = { user: { id: 1 }, conversationId: 8, appIds: new Set(), deps: f.deps };
  const out = await tool.addToBuild(f.pool, ctx, { project: 'gym', number: 12, note: 'Make the button blue too.' });
  assert.equal(out.ok, true);
  assert.match(out.sent, /Gym Tracker request #12/);
  assert.match(out.shown, /never say it has/);
  assert.equal(ctx.steered, true);
  assert.deepEqual(ctx.card, {
    type: 'build_note', v: 1, state: 'waiting', noteId: 55, project: 'gym', projectName: 'Gym Tracker', number: 12,
    title: 'Dark mode', note: 'Make the button blue too.',
  });
  assert.equal(f.added[0].build.runId, 70);
  assert.equal(f.added[0].conversationId, 8);
  assert.equal(f.added[0].kind, undefined, 'a note, not a redo');
  // One per turn.
  assert.deepEqual(await tool.addToBuild(f.pool, ctx, { project: 'gym', number: 12, note: 'And green.' }),
    { ok: false, error: 'One note per turn: put everything they said into one.' });
});

test('add_to_build refuses, and sends nothing, without words, a project they see, the right to steer, or a build under way', async () => {
  const call = async (opts, args = { project: 'gym', number: 12, note: 'Make it blue.' }) => {
    const f = fakes(opts);
    const ctx = { user: { id: 1 }, deps: f.deps };
    const out = await tool.addToBuild(f.pool, ctx, args);
    assert.equal(out.ok, false);
    assert.equal(f.added.length, 0);
    assert.equal(ctx.card, undefined);
    return out.error;
  };
  assert.match(await call({}, { project: 'gym', number: 12, note: 'blue' }), /Say what they want added/);
  assert.match(await call({ canView: false }), /No such request/);
  assert.match(await call({}, { project: 'gym', number: 0, note: 'Make it blue.' }), /No such request/);
  assert.match(await call({ ok: false }), /Only whoever asked for Gym Tracker request #12, or the project's owner/);
  assert.match(await call({ build: null }), /not building Gym Tracker request #12 right now/);
});

test('stop_and_redo only offers: Stop and redo and Keep going under the reply, for a build that is running', async () => {
  const f = fakes();
  const ctx = { user: { id: 1 }, conversationId: 8, deps: f.deps };
  const out = await tool.stopAndRedo(f.pool, ctx, { project: 'gym', number: 12, note: 'Start over with a list, not a grid.' });
  assert.equal(out.ok, true);
  assert.match(out.offered, /Nothing is stopped until they tap Stop and redo/);
  assert.equal(ctx.card.state, 'offer_redo');
  assert.equal(f.added[0].kind, 'redo');
  assert.equal(f.added[0].state, 'offered');
  // A build still waiting its turn has nothing to stop.
  const waiting = fakes({ build: { runId: 70, sessionId: null, running: false } });
  const refused = await tool.stopAndRedo(waiting.pool, { user: { id: 1 }, deps: waiting.deps }, { project: 'gym', number: 12, note: 'Start over please.' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /has not started yet/);
  assert.equal(waiting.added.length, 0);
});

test('a missed note\'s card offers the change\'s next update only when there is one', () => {
  assert.deepEqual(steer.missedPatch(31), { state: 'missed', change: { sessionId: 31 } });
  assert.deepEqual(steer.missedPatch(null), { state: 'missed', change: null });
});

test('the card\'s taps go to the note\'s own person: Stop and redo, Keep going, Put it in the next update', async () => {
  const calls = [];
  const fake = {
    async noteRow(_pool, id) { return id === 55 ? { id: 55, user_id: 1, kind: 'redo', state: 'offered' } : null; },
    async redo(_pool, _config, args) { calls.push(['redo', args.row.id, args.message.id]); return { ok: true, patch: { state: 'redone' } }; },
    async keep(_pool, args) { calls.push(['keep', args.row.id]); return { ok: true, patch: { state: 'waiting' } }; },
    async forward(_pool, _config, args) { calls.push(['forward', args.card.change.sessionId]); return { ok: true, patch: { state: 'forwarded' } }; },
  };
  const deps = { steer: fake };
  const message = { id: 400, conversationId: 8, botId: 2 };
  const card = { noteId: 55, change: { sessionId: 31 } };
  assert.equal((await cardHandler.decide({}, {}, { user: { id: 2 }, card, action: 'redo', message, deps })).status, 404);
  assert.equal((await cardHandler.decide({}, {}, { user: { id: 1 }, card: { noteId: 54 }, action: 'redo', message, deps })).status, 404);
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card, action: 'redo', message, deps }), { ok: true, patch: { state: 'redone' } });
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card, action: 'keep', message, deps }), { ok: true, patch: { state: 'waiting' } });
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card, action: 'forward', message, deps }), { ok: true, patch: { state: 'forwarded' } });
  assert.equal((await cardHandler.decide({}, {}, { user: { id: 1 }, card, action: 'stop', message, deps })).status, 400);
  assert.deepEqual(calls, [['redo', 55, 400], ['keep', 55], ['forward', 31]]);
});

test('Stop and redo and Keep going are refused to anybody but the note\'s person, and once decided', async () => {
  const user = { id: 1 };
  assert.equal((await steer.redo({}, {}, { row: { id: 1, kind: 'redo', state: 'offered', user_id: 2 }, user })).status, 404);
  assert.equal((await steer.redo({}, {}, { row: { id: 1, kind: 'note', state: 'offered', user_id: 1 }, user })).status, 404);
  assert.equal((await steer.redo({}, {}, { row: { id: 1, kind: 'redo', state: 'redone', user_id: 1 }, user })).status, 409);
  assert.equal((await steer.keep({}, { row: { id: 1, kind: 'redo', state: 'kept', user_id: 1 }, user })).status, 409);
  assert.equal((await steer.forward({}, {}, { row: { id: 1, state: 'waiting', user_id: 1 }, user })).status, 409);
});

test('the claims check accepts a note sent to a build this turn, and only then', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const pool = { query: async () => ({ rows: [] }) };
  const said = 'I\'ve passed your note on to the build of that request.';
  assert.deepEqual((await mayor.claimProblems(pool, { user: { id: 1 }, appIds: new Set() }, said)).map((p) => p.kind), ['posted']);
  assert.deepEqual(await mayor.claimProblems(pool, { user: { id: 1 }, appIds: new Set(), steered: true }, said), []);
});

test('the requester, or the project\'s owner, may stop the bot\'s build of the request from the session\'s Stop too', () => {
  const src = read('src/routes/sessions.js');
  const at = src.indexOf('async function requestSessionStop(');
  const body = src.slice(at, at + 3000);
  assert.match(body, /mayStopBotBuild\(pool, sessionId, user\)/);
  // Only when the owner-or-admin read found nothing: never narrower.
  assert.ok(body.indexOf('user_id = $2 OR $3::boolean') < body.indexOf('mayStopBotBuild'));
});

test('the build\'s stop hook is handed its notes by an internal route, its own session only, a build turn\'s token only', () => {
  const src = read('src/routes/internal.js');
  const at = src.indexOf("'/api/internal/sessions/:sessionId/build-notes/take'");
  assert.ok(at > 0);
  const block = src.slice(src.lastIndexOf('const buildNotesAuth', at), at + 1200);
  assert.match(block, /internalAuthPurpose\(\[platformJwt\.PUR_WORKER, platformJwt\.PUR_VISIBLE_CHANGES\]\)/);
  assert.match(block, /session_mismatch/);
  assert.match(block, /takeNotes\(pool, sessionId\)/);
  // run-cc.sh hands the hook the URL only with a worker token (a build).
  const runner = read('worker/run-cc.sh');
  assert.match(runner, /if \[ -n "\$WORKER_JWT" \]; then\n\s+USERNODE_STOP_GUARD_NOTES="\$\{PLATFORM_URL%\/\}\/api\/internal\/sessions\/\$\{SESSION_ID\}\/build-notes\/take"/);
});

test('a build stopped to be redone says nothing of its own end on the request', () => {
  const src = read('src/services/homeroom-bot.js');
  const at = src.indexOf('async function recordLostLiveBuild(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.ok(body.indexOf('redoAsked(pool, run.id)') > body.indexOf('putAwayRecoveredSession'), 'its session is still put away');
  assert.ok(body.indexOf('redoAsked(pool, run.id)') < body.indexOf('sayBuildLost'), 'and nothing is said');
});

// ── The card, drawn ──

test('the build note card, in each state', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { BuildNoteView, buildNoteOf } = loadTsx('frontend/src/features/messages/bot-cards/build-note.tsx');
  const draw = (card) => renderToHtml(createElement(BuildNoteView, { data: buildNoteOf({ type: 'build_note', number: 12, title: 'Dark mode', note: 'Make it blue <b>now</b>', ...card }) }));
  const waiting = draw({ state: 'waiting' });
  assert.match(waiting, /data-bot-build-note="waiting"/);
  assert.match(waiting, />Sent to the build of #12</);
  assert.match(waiting, /It reads it at its next step, before it finishes\./);
  assert.match(waiting, /Make it blue &lt;b&gt;now&lt;\/b&gt;/, 'their words are text');
  assert.ok(!/data-bot-build-note-action/.test(waiting));
  assert.match(draw({ state: 'delivered' }), />The build of #12 has your note</);
  const missed = draw({ state: 'missed', change: { sessionId: 31 } });
  assert.match(missed, />The build of #12 finished first</);
  assert.match(missed, /Put your note in its next update\?/);
  assert.match(missed, /class="messages-bot-primary"[^>]*data-bot-build-note-action="forward"><span>Put it in the next update<\/span>/);
  const lost = draw({ state: 'missed', change: null });
  assert.match(lost, /It ended before it read your note\./);
  assert.ok(!/data-bot-build-note-action/.test(lost));
  assert.match(draw({ state: 'forwarded' }), /It goes into the next update instead\./);
  const offer = draw({ state: 'offer_redo' });
  assert.match(offer, />Stop the build of #12 and start again\?</);
  assert.match(offer, /goes on the request&#x27;s discussion, under your name/);
  assert.match(offer, /data-bot-build-note-action="redo"><span>Stop and redo<\/span>/);
  assert.match(offer, /data-bot-build-note-action="keep"><span>Keep going<\/span>/);
  assert.match(draw({ state: 'redone' }), />Starting #12 again with your note</);
  assert.match(draw({ state: 'redone', posted: false }), /its next build gets your note/);
  assert.match(draw({ state: 'gone' }), />That build of #12 already finished</);
  assert.match(draw({ state: 'nonsense' }), /data-bot-build-note="waiting"/, 'an unknown state reads as waiting');
});
