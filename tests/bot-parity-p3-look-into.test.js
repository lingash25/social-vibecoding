'use strict';

// Homeroom bot parity, P3: look_into's pure parts
// (services/homeroom-bot-thread-tools/look-into.js), the working card's
// words for it (homeroom-bot-dm.js typingDoing, homeroom-bot-mayor.js
// doingFor) and the claims check's allowance: "I'll post what I find here"
// only when this turn's look is still running.

const test = require('node:test');
const assert = require('node:assert/strict');

const look = require('../src/services/homeroom-bot-thread-tools/look-into');
const mayor = require('../src/services/homeroom-bot-mayor');
const dm = require('../src/services/homeroom-bot-dm');

test('a look\'s arguments are checked: a project and a question of a sentence', () => {
  assert.deepEqual(look.lookArgs({ project: '#gym-tracker', question: 'Why does the streak reset at midnight?' }),
    { ok: true, project: 'gym-tracker', question: 'Why does the streak reset at midnight?' });
  assert.equal(look.lookArgs({ question: 'Why does the streak reset?' }).ok, false);
  assert.equal(look.lookArgs({ project: 'gym', question: 'why' }).ok, false);
  const long = look.lookArgs({ project: 'gym', question: 'x'.repeat(5000) });
  assert.equal(long.ok, true);
  assert.ok(long.question.length <= 1200);
});

test('the scout\'s prompt carries the question, an investigation\'s notes and what changed since, and asks for one JSON block', () => {
  const plain = look.lookPrompt({ projectName: 'Gym Tracker', username: 'ada', question: 'Why does the streak reset?' });
  assert.match(plain, /@ada asked/);
  assert.match(plain, /Why does the streak reset\?/);
  assert.match(plain, /Never change, commit or push anything/);
  assert.match(plain, /```json/);
  assert.doesNotMatch(plain, /NOTES SO FAR|WHAT CHANGED/);
  const later = look.lookPrompt({
    projectName: 'Gym Tracker', username: 'ada', question: 'Is the flaky check fixed?',
    notes: 'Check-in 1: the date test fails near midnight.', since: '2026-11-01T06:00:00.000Z',
  });
  assert.match(later, /NOTES SO FAR[\s\S]*the date test fails near midnight/);
  assert.match(later, /git log --since="2026-11-01T06:00:00.000Z"/);
  assert.ok(!/\u2014/.test(plain + later), 'no em dash in the prompt');
});

test('a reply\'s findings: its block read, its words when it wrote none, secrets left out, no em dash', () => {
  const found = look.parseFindings([
    'I read the streak code.',
    '```json',
    JSON.stringify({ summary: 'The streak resets because it counts days in UTC \u2014 not your time zone.', answered: true, worth_acting: true, line: 'It counts days in UTC.', files: ['src/streak.js', '.env', 'keys/server.pem'], checks: ['npm test'] }),
    '```',
  ].join('\n'));
  assert.equal(found.answered, true);
  assert.equal(found.worth, true);
  assert.equal(found.line, 'It counts days in UTC.');
  assert.deepEqual(found.files, ['src/streak.js']);
  assert.deepEqual(found.checks, ['npm test']);
  assert.ok(!found.summary.includes('\u2014'));
  const bare = look.parseFindings('It looks fine. The streak code handles time zones.');
  assert.equal(bare.answered, false);
  assert.match(bare.summary, /It looks fine/);
  assert.equal(bare.line, 'It looks fine.');
  assert.equal(look.parseFindings('').summary, '');
});

test('what the scout did is read off its progress lines: files once each, relative, and its checks', () => {
  const seen = look.activityOf([
    'Reading /home/node/workspace/src/streak.js',
    '  ⎿ Read: 120 lines',
    'Reading /home/node/workspace/src/streak.js',
    'Reading /home/node/workspace/gym-tracker/src/days.js',
    'Reading /home/node/workspace/.env',
    '$ npm test -- streak',
    '$ ls src',
    '$ git log --oneline -5',
  ], 'gym-tracker');
  assert.deepEqual(seen.files, ['src/streak.js', 'src/days.js']);
  assert.deepEqual(seen.checks, ['npm test -- streak']);
  assert.equal(look.repoPath('/workspace/./a/b.js'), 'a/b.js');
});

test('"what I looked at" lines and the compact result the chat model reads', () => {
  assert.deepEqual(look.lookedItems({ appName: 'Gym Tracker', filesRead: 23, checks: [] }), [{ what: 'Read 23 files in Gym Tracker' }]);
  assert.deepEqual(look.lookedItems({ appName: 'Gym Tracker', filesRead: 1, checks: ['npm test'] }),
    [{ what: 'Read 1 file in Gym Tracker' }, { what: 'Ran its checks in Gym Tracker' }]);
  assert.deepEqual(look.lookedItems({ appName: 'Gym Tracker', filesRead: 0 }), [{ what: 'Looked into Gym Tracker\'s code' }]);
  const out = look.compactResult({
    state: 'done', summary: 'It counts days in UTC.', answered: true, files_read: 23,
    files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'], checks: ['npm test'], duration_ms: 150000,
  }, 'Gym Tracker');
  assert.equal(out.ok, true);
  assert.deepEqual(out.filesRead, { count: 23, some: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] });
  assert.deepEqual(out.checksRun, ['npm test']);
  assert.equal(out.minutes, 3);
  assert.equal(look.compactResult({ state: 'failed', error: 'It ran out of time.' }, 'Gym Tracker').error, 'It ran out of time.');
});

test('the tool is offered, and said in the prompt, only while the bot is on', () => {
  const user = { id: 1, username: 'ada' };
  assert.deepEqual(look.tools({ user, settings: { mode: 'live' } }).map((t) => t.function.name), ['look_into']);
  assert.deepEqual(look.tools({ user, settings: { mode: 'off' } }), []);
  assert.ok(look.promptLines({ user, settings: { mode: 'live' } }).join(' ').includes('look_into'));
  assert.deepEqual(look.promptLines({ user, settings: { mode: 'off' } }), []);
  assert.ok(!/\u2014/.test(look.promptLines({ user, settings: { mode: 'live' } }).join('\n') + JSON.stringify(look.LOOK_TOOL)));
});

test('the working card says "Looking into it in <project>": the kind the typing event carries', () => {
  assert.deepEqual(mayor.doingFor('look_into', { project: 'gym' }, { project: 'Gym Tracker' }), { kind: 'looking', project: 'Gym Tracker' });
  assert.deepEqual(mayor.doingFor('look_into', {}), { kind: 'looking' });
  assert.deepEqual(dm.typingDoing({ kind: 'looking', project: 'Gym Tracker' }), { kind: 'looking', project: 'Gym Tracker' });
  assert.deepEqual(dm.typingDoing({ kind: 'looking' }), { kind: 'looking' });
});

test('the claims check lets "I\'ll post what I find here" through only while this turn\'s look runs', async () => {
  // No request number is named, so the check reads nothing.
  const pool = { query: async () => { throw new Error('nothing to read'); } };
  const said = 'Still looking into it. I\'ll post what I find here.';
  const running = await mayor.claimProblems(pool, { lookRunning: true, user: { id: 1 } }, said);
  assert.deepEqual(running, []);
  const none = await mayor.claimProblems(pool, { user: { id: 1 } }, said);
  assert.deepEqual(none.map((p) => p.kind), ['report_back']);
  // Other ways of saying it, and the old promise, are held to the same rule.
  for (const words of ['I\'ll let you know what it turns up.', 'I\'ll report back once the helper is done.', 'I\'ll get back to you with what I find.']) {
    assert.ok((await mayor.claimProblems(pool, { user: { id: 1 } }, words)).length > 0, words);
    assert.deepEqual(await mayor.claimProblems(pool, { lookRunning: true, user: { id: 1 } }, words), [], words);
  }
  // An ordinary answer is no claim.
  assert.deepEqual(await mayor.claimProblems(pool, { user: { id: 1 } }, 'The streak counts days in UTC, so it resets at 7pm for you.'), []);
  // Cut when it is still claimed after the second pass.
  const cut = mayor.stripClaims(said, none);
  assert.doesNotMatch(cut, /I'll post what I find/);
});

test('the thread tools registry offers the look and the investigation tools and routes their calls', async () => {
  const registry = require('../src/services/homeroom-bot-thread-tools');
  const ctx = { user: { id: 1, username: 'ada' }, settings: { mode: 'live' }, deps: {} };
  const names = registry.toolsFor(ctx).map((t) => t.function.name);
  for (const name of ['look_into', 'start_investigation', 'read_investigation']) assert.ok(names.includes(name), name);
  assert.ok(registry.promptLines(ctx).some((line) => line.includes('look_into')));
  assert.ok(registry.promptLines(ctx).some((line) => line.includes('start_investigation')));
  // A call is its module's: bad arguments are refused before anything is read.
  const pool = { query: async () => { throw new Error('nothing to read'); } };
  assert.deepEqual(await registry.run(pool, ctx, 'look_into', { project: 'gym' }), { ok: false, error: 'Say what to find out, in a sentence.' });
  assert.equal((await registry.run(pool, ctx, 'start_investigation', { project: 'gym', goal: 'x' })).ok, false);
  const off = { ...ctx, settings: { mode: 'off' } };
  assert.ok(!registry.toolsFor(off).some((t) => ['look_into', 'start_investigation'].includes(t.function.name)));
});
