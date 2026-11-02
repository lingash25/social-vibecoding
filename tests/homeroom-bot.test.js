// #2684: the Homeroom bot, slice 1 — shadow-mode triage.
//
// Pins the pure pieces (verdict parsing, eligibility, settings), the queue
// refresh against an injected GitHub, a read (runTriage) inside the look its
// request's instance runs it in (what the look decided is on its `out`), and,
// as source text, the properties that make shadow mode SHADOW: the triage
// turn is a scout (no push token), the service posts, claims and builds
// nothing, and the loop runs on the workflow's machines and ships off.
//
// Run with: node --test tests/homeroom-bot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const durableSteps = require('../src/services/durable-steps');
const live = require('../src/services/homeroom-bot-live');
const rules = require('../src/workflow/rules/bot-loop.ts');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const SRC = read('src/services/homeroom-bot.js');

// ── parseVerdict ─────────────────────────────────────────────────────────

test('parseVerdict reads the LAST fenced JSON block and normalizes its fields', () => {
  const text = [
    'I looked at routes/issues.js and the thread.',
    '```json',
    '{"verdict":"ready","determined":true,"missing_fact":"none"}',
    '```',
    'Actually, on reflection:',
    '```json',
    '{ "verdict": "Question", "determined": false, "missing_fact": "Which screen shows the pins.",',
    '  "question": "Which screen do the pins drift on?", "default": "The route map", "build_note": "ignored",',
    '  "blocker": "user_facing", "why_default_fails": "The two maps draw pins in different code." }',
    '```',
  ].join('\n');
  const v = bot.parseVerdict(text);
  assert.equal(v.verdict, 'question');
  assert.equal(v.determined, false);
  assert.equal(v.missingFact, 'Which screen shows the pins.');
  assert.equal(v.question, 'Which screen do the pins drift on?');
  assert.equal(v.questionDefault, 'The route map');
  assert.equal(v.buildNote, null, 'a build note only rides a ready verdict');
  assert.equal(v.reason, 'user_facing: The two maps draw pins in different code.', 'which blocker, and why');
});

test('parseVerdict: "none" clears missing_fact, ready keeps its note, person keeps its reason', () => {
  const ready = bot.parseVerdict('```json\n{"verdict":"ready","determined":true,"missing_fact":"None.","build_note":"Edit public/js/map.js: clamp the pin offset on zoom."}\n```');
  assert.equal(ready.verdict, 'ready');
  assert.equal(ready.missingFact, null);
  assert.match(ready.buildNote, /clamp the pin offset/);
  const person = bot.parseVerdict('{"verdict":"person","determined":true,"reason":"Changes the login flow."}');
  assert.equal(person.verdict, 'person', 'bare braces without a fence still parse');
  assert.equal(person.reason, 'Changes the login flow.');
});

test('#4239: parseVerdict reads `platform` on a person verdict only', () => {
  const about = bot.parseVerdict('{"verdict":"person","determined":true,"platform":true,"reason":"The header is Homeroom\'s, not the app\'s."}');
  assert.equal(about.platform, true);
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"A design call."}').platform, false, 'absent is false');
  assert.equal(bot.parseVerdict('{"verdict":"person","platform":"yes","reason":"x"}').platform, false, 'only a real true');
  assert.equal(bot.parseVerdict('{"verdict":"ready","platform":true,"build_note":"Edit app.js."}').platform, false,
    'never on a verdict that builds');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /- `platform`: true ONLY with the verdict `person`, when the request is about the Homeroom platform itself rather than this app/);
  assert.match(prompt, /"platform": true \(verdict person, only when the request is about the Homeroom platform itself, not this app\),/);
  assert.equal(bot.PLATFORM_SELF_APP_SLUG, 'usernode-2d5619');
  // Stored on the run, and carried to the requester's DM, which offers the move.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /plan: parsed\.plan, aboutPlatform: !!parsed\.platform,/);
  assert.match(src, /if \(v\.platform && \(await platformAppSlugs\(pool\)\)\.includes\(app\.slug\)\) v = \{ \.\.\.v, platform: false \};/);
  assert.match(src, /reason: parsed\.reason, \.\.\.\(parsed\.platform \? \{ platform: true \} : \{\}\), \.\.\.\(deciders\.length \? \{ deciders \} : \{\}\),\n\s+\.\.\.\(parsed\.done \? \{ done: true \} : \{\}\),/);
});

test('a request that is already there is `done`: on a person or empty verdict, never with `platform`', () => {
  const done = bot.parseVerdict('{"verdict":"person","determined":true,"done":true,"reason":"It exists: open Profile, then Your votes."}');
  assert.equal(done.done, true);
  assert.equal(bot.parseVerdict('{"verdict":"empty","done":true,"reason":"Already there."}').done, true);
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"A design call."}').done, false, 'absent is false');
  assert.equal(bot.parseVerdict('{"verdict":"person","done":"yes","reason":"x"}').done, false, 'only a real true');
  assert.equal(bot.parseVerdict('{"verdict":"ready","done":true,"build_note":"Edit app.js."}').done, false, 'never on a verdict that builds');
  assert.equal(bot.parseVerdict('{"verdict":"person","done":true,"platform":true,"reason":"x"}').done, false,
    'about Homeroom itself is offered the move, not a close');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /- `done`: true only with `person` or `empty`, when all it asks for already exists or is done; `reason` says where on screen, and its requester is offered a vote to close it\./);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /await say\('empty', live\.emptyText\(parsed\), \{ dm: \{ reason: parsed\.reason, \.\.\.\(parsed\.done \? \{ done: true \} : \{\}\), \.\.\.quiet \} \}\);/);
});

test('a request that names who builds it is `builder`: a person verdict only, a bare name, and its news rings nobody', () => {
  const named = bot.parseVerdict('{"verdict":"person","builder":"@snait","reason":"Assigned to snait, not for the bot."}');
  assert.equal(named.builder, 'snait', 'the name, without its @');
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"A design call."}').builder, null, 'absent is null');
  assert.equal(bot.parseVerdict('{"verdict":"ready","builder":"snait","build_note":"Edit app.js."}').builder, null,
    'never on a verdict that builds');
  assert.equal(bot.parseVerdict('{"verdict":"person","builder":"two words","reason":"x"}').builder, null, 'a name, or nothing');
  assert.equal(bot.parseVerdict('{"verdict":"person","builder":true,"reason":"x"}').builder, null);
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /- `builder`: only with `person`, when the request or its discussion says a named person will build it: that username, without the @\./);
  assert.match(prompt, /"builder": "who the request says will build it \(verdict person, only then\)",/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  // Said in their chat with the bot, and quiet (homeroom-bot-dm.js relayIssuePost).
  assert.match(src, /\.\.\.\(parsed\.builder \? \{ builder: parsed\.builder, quiet: true \} : quiet\),/);
});

test('an older request\'s first read rings only when it is ready to try (16 Oct 2026)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /backlog: item\.reason === BACKLOG_REASON,\n/, 'the read says which it is');
  assert.match(src, /const quiet = backlog \? \{ quiet: true \} : \{\};/);
  // A question and an empty request are quiet; a person hand-off is too.
  const act = src.slice(src.indexOf('async function actOnVerdict'));
  const body = act.slice(0, act.indexOf('\n}\n'));
  assert.match(body, /\.\.\.\(parsed\.plan\?\.questions\?\.length > 1 \? \{ questions: parsed\.plan\.questions \} : \{\}\),\n\s+\.\.\.quiet,\n/);
  // A ready one builds, and its news rings as it did: nothing marks it quiet.
  const ready = body.slice(body.indexOf("} else if (parsed.verdict === 'ready') {"));
  assert.doesNotMatch(ready.slice(0, 4000), /quiet: true|\.\.\.quiet\b/);
  const dmSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  assert.match(dmSrc, /\.\.\.\(dm\.quiet \? \{ moment: null \} : \{\}\),/);
});

test('a re-read and the ask to repair a reply restate the verdict\'s keys (runs 1390, 1451, 1454 answered in keys of their own)', () => {
  const again = bot.continuedTriagePrompt({ seed: 'SEED', issueNumber: 30 });
  assert.match(again, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block in the same format as before, for issue #30, and nothing after it:\n\{"verdict": "question" \| "empty" \| "ready" \| "person", "determined": true \| false, "missing_fact": "\.\.\.", "question": "\.\.\.", "default": "\.\.\.", "build_note": "\.\.\.", "reason": "\.\.\."\}\nUse these keys and the others your instructions name \(such as `answers`, `blocker`, `assumptions`, `platform`\): a block with keys of its own, or no `verdict`, cannot be read\.$/);
  assert.match(bot.VERDICT_REPAIR_PROMPT, /with nothing before or after it:\n\{"verdict": "question" \| "empty" \| "ready" \| "person",[^\n]+\}\nUse these keys and the others your instructions name/);
  assert.ok(bot.triageClosing(30).endsWith(`in this format, and nothing after it:\n${bot.VERDICT_FORMAT}`), 'the first read says the same shape');
});

test('parseVerdict finds the last verdict object whatever surrounds it', () => {
  // The notes quote code in a fence of their own and the block's closing
  // fence never comes: the old reader took the code fence as the only
  // candidate and never looked at braces at all.
  const unclosed = [
    'The handler is `function pick(o) { return o.id; }`:',
    '```js',
    'const pins = { drift: true };',
    '```',
    'So:',
    '```json',
    '{"verdict":"person","determined":true,"reason":"Changes the login flow."}',
  ].join('\n');
  assert.equal(bot.parseVerdict(unclosed)?.verdict, 'person');
  // A stray brace in the prose before a bare block: first `{` to last `}`
  // spanned the prose and failed to parse.
  const stray = 'Wraps the list in a { group.\n{"verdict":"empty","determined":true,"reason":"Nothing to build."}';
  assert.equal(bot.parseVerdict(stray)?.verdict, 'empty');
  // Braces inside strings, a nested object, and a later object with no
  // verdict: the outer verdict object is the one read.
  const nested = [
    '```json',
    '{"verdict":"question","determined":false,"missing_fact":"which","question":"Which screen?","default":"The map",',
    ' "answers":["The map","The list"],"blocker":"user_facing","why_default_fails":"Two screens draw it {differently}.",',
    ' "second_question":{"question":"Which zoom?","answers":["All","Close"]}}',
    '```',
    '{"note":"not a verdict"}',
  ].join('\n');
  const q = bot.parseVerdict(nested);
  assert.equal(q?.verdict, 'question');
  assert.equal(q.question, 'Which screen?');
  assert.equal(q.reason, 'user_facing: Two screens draw it {differently}.');
});

test('parseVerdict refuses anything that is not one of the three verdicts', () => {
  assert.equal(bot.parseVerdict(''), null);
  assert.equal(bot.parseVerdict('no json here'), null);
  assert.equal(bot.parseVerdict('```json\n{"verdict":"maybe"}\n```'), null);
  assert.equal(bot.parseVerdict('```json\n{not json}\n```'), null);
  assert.equal(bot.parseVerdict('```json\n[1,2]\n```'), null);
});

// ── classifyIssue ────────────────────────────────────────────────────────

test('classifyIssue: a never-triaged open issue is queued at priority 1 with the newest activity as thread_seen_at', () => {
  const v = bot.classifyIssue({
    issue: { number: 7, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
    threadLastAt: '2026-09-03T12:00:00Z',
  });
  assert.equal(v.eligible, true);
  assert.equal(v.priority, 1);
  assert.equal(v.reason, 'new');
  assert.equal(v.threadSeenAt, '2026-09-03T12:00:00.000Z', 'the platform thread was newer than GitHub');
});

test('classifyIssue: unchanged since the last run is skipped; changed is re-queued at priority 2', () => {
  const issue = { number: 7, state: 'open', updatedAt: '2026-09-02T00:00:00Z' };
  const unchanged = bot.classifyIssue({ issue, lastRun: { thread_seen_at: '2026-09-02T00:00:00Z' } });
  assert.equal(unchanged.eligible, false);
  assert.equal(unchanged.reason, 'unchanged');
  const changed = bot.classifyIssue({
    issue, threadLastAt: '2026-09-05T00:00:00Z', lastRun: { thread_seen_at: '2026-09-02T00:00:00Z' },
  });
  assert.equal(changed.eligible, true);
  assert.equal(changed.priority, 2);
  assert.equal(changed.reason, 'changed');
  assert.equal(changed.changedBy, 'discussion', 'a person\'s message on Homeroom moved past the last read');
  const onGithub = bot.classifyIssue({
    issue: { ...issue, updatedAt: '2026-09-06T00:00:00Z' }, threadLastAt: '2026-09-01T00:00:00Z',
    lastRun: { thread_seen_at: '2026-09-02T00:00:00Z' },
  });
  assert.deepEqual([onGithub.reason, onGithub.changedBy], ['changed', 'github'], 'the issue itself: a comment, an edit or a label');
  assert.equal(unchanged.changedBy, undefined, 'only a change says what changed');
});

test('classifyIssue: an unchanged issue whose last verdict a cap held says which cap (#3152)', () => {
  const issue = { number: 7, state: 'open', updatedAt: '2026-09-02T00:00:00Z' };
  const lastRun = { thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app' };
  const held = bot.classifyIssue({ issue, lastRun });
  assert.equal(held.eligible, false, 'refreshApp, not classifyIssue, decides whether the cap has room');
  assert.equal(held.reason, 'held');
  assert.equal(held.cap, 'proposals_per_app');
  // Something new on the issue re-queues it whatever held it last time.
  const changed = bot.classifyIssue({ issue, threadLastAt: '2026-09-05T00:00:00Z', lastRun });
  assert.equal(changed.reason, 'changed');
});

test('classifyIssue: the bot never competes with a person, and never looks at a closed issue', () => {
  const busy = bot.classifyIssue({ issue: { number: 7, state: 'open' }, busy: true });
  assert.equal(busy.eligible, false);
  assert.equal(busy.reason, 'in_progress');
  const closed = bot.classifyIssue({ issue: { number: 7, state: 'closed' } });
  assert.equal(closed.eligible, false);
  assert.equal(closed.reason, 'closed');
  assert.equal(bot.classifyIssue({ issue: null }).eligible, false);
});

test('classifyIssue: a request whose live build waits or runs is not read again, whatever moved since (Plant Pal #1, #3)', () => {
  // The build's own spec comment moved updated_at past what its run had
  // recorded as seen, which read as a change: the request was read again
  // mid-build, found ready, and built twice.
  const issue = { number: 1, state: 'open', updatedAt: '2026-10-03T16:46:40Z' };
  const lastRun = { thread_seen_at: '2026-10-03T16:45:36Z', live_building: true };
  const building = bot.classifyIssue({ issue, lastRun });
  assert.equal(building.eligible, false);
  assert.equal(building.reason, 'building');
  assert.equal(bot.classifyIssue({ issue, lastRun: { ...lastRun, live_building: false } }).reason, 'changed',
    'once its build has ended, the change is read as before');
  assert.equal(bot.classifyIssue({ issue, lastRun, busy: true }).reason, 'in_progress', 'a person holding it still says so');
  assert.equal(bot.classifyIssue({ issue: { ...issue, state: 'closed' }, lastRun }).reason, 'closed');
});

test('a failed read is tried once more, a while later, then left until something new happens (#1080)', () => {
  // gas-lock #2 failed on a provider 400 on 2026-10-04 and was never read
  // again: a failed run counted as having read the thread.
  const issue = { number: 2, state: 'open', updatedAt: '2026-10-04T04:00:00Z', createdAt: '2026-10-04T04:00:00Z' };
  const failedAt = Date.parse('2026-10-04T04:17:57Z');
  const lastRun = { thread_seen_at: '2026-10-04T04:00:00Z', verdict: 'failed', failed_tries: 1, created_at: new Date(failedAt).toISOString() };
  const soon = bot.classifyIssue({ issue, lastRun, now: failedAt + 60_000 });
  assert.equal(soon.reason, 'unchanged', 'not straight away: a fault may still be there');
  const later = bot.classifyIssue({ issue, lastRun, now: failedAt + bot.FAILED_TRIAGE_RETRY_AFTER_MS });
  assert.equal(later.eligible, true);
  assert.equal(later.reason, bot.RETRY_FAILED_REASON);
  assert.equal(later.priority, 3, 'behind new and changed requests');
  const twice = bot.classifyIssue({ issue, lastRun: { ...lastRun, failed_tries: 2 }, now: failedAt + 3_600_000 });
  assert.equal(twice.reason, 'unchanged', 'a second failure on the same thread is final until it changes');
  const read = bot.classifyIssue({ issue, lastRun: { ...lastRun, verdict: 'person' }, now: failedAt + 3_600_000 });
  assert.equal(read.reason, 'unchanged', 'a real verdict is a read');
  const q = SRC.slice(SRC.indexOf('async function lastRunsByIssue'), SRC.indexOf('async function refreshApp'));
  assert.match(q, /f\.verdict = 'failed'\s+AND f\.thread_seen_at IS NOT DISTINCT FROM r\.thread_seen_at\) AS failed_tries/);
});

test('the last run says whether a live build is waiting or under way, as the read lane reads it', () => {
  const q = SRC.slice(SRC.indexOf('async function lastRunsByIssue'), SRC.indexOf('async function refreshApp'));
  assert.match(q, /\(mode = 'live' AND verdict = 'ready' AND build_ok IS NULL AND proposal_session_id IS NULL\s+AND \(live_build_waiting_at IS NOT NULL OR build_session_id IS NOT NULL\)\s+AND created_at > NOW\(\) - make_interval\(days => \$2\)\) AS live_building/);
  assert.match(q, /\[appId, ABANDONED_LIVE_WINDOW_DAYS\]/, 'past the abandoned-build sweep\'s window, a run holds nothing');
  // The lane reads its candidates with rules/bot-loop.ts READ_CANDIDATES_SQL,
  // whose window is the same constant's value written into the statement.
  const lane = rules.READ_CANDIDATES_SQL;
  assert.equal(rules.ABANDONED_LIVE_WINDOW_DAYS, bot.ABANDONED_LIVE_WINDOW_DAYS, 'one window on both sides');
  assert.match(lane, new RegExp(`AND b\\.mode = 'live' AND b\\.verdict = 'ready' AND b\\.build_ok IS NULL AND b\\.proposal_session_id IS NULL\\s+AND \\(b\\.live_build_waiting_at IS NOT NULL OR b\\.build_session_id IS NOT NULL\\)\\s+AND b\\.created_at > NOW\\(\\) - make_interval\\(days => ${rules.ABANDONED_LIVE_WINDOW_DAYS}\\)`),
    'the same condition, word for word');
  const refresh = SRC.slice(SRC.indexOf('async function refreshApp('), SRC.indexOf('async function refreshQueue('));
  assert.match(refresh, /verdict\.reason === 'unchanged' \|\| verdict\.reason === 'held' \|\| verdict\.reason === 'building'\) quiet\.push\(n\)/,
    'a row the bot queued for itself on it is kept, as on an unchanged request');
});

// ── settings ─────────────────────────────────────────────────────────────

test('settings default to off and clamp their numbers', () => {
  const s = bot.parseSettings([]);
  assert.deepEqual(s, {
    mode: 'off', concurrency: 1, batchSize: 100, pausedApps: [],
    turnSeconds: 20 * 60, turnInputTokens: 10_000_000,
    shadowBuilds: false, buildConcurrency: 2, shadowBuildPlatform: false,
    // #3624: $50 a week each for what a person's requests cost the bot,
    // and $100 for an admin's.
    userWeeklyCents: 5000, adminWeeklyCents: 10000,
    // #3654: every stage on the platform default until an admin names one.
    models: { triage: '', spec: '', build: '', followup: '' },
    // And the platform default itself on the deployment's until an admin
    // picks one (services/default-model.js).
    defaultModel: '',
    // The helper calls on the built-in GLM until an admin picks one
    // (services/helper-model.js).
    helperModel: '',
    // Live work, 12 at once and 3 per person (raised from 6 and 2 when every
    // project went live); a DM is read.
    liveAtOnce: 12, perPerson: 3, dmChat: true,
    // Its voice answers in changes', requests' and chats' discussions, each
    // until an admin turns it off there (homeroom-bot-voice.js).
    voiceSession: true, voiceIssue: true, voiceChat: true,
    // Reading a request again continues the conversation it was read in.
    continueReads: true,
    // The moment it went on for everyone is schema.sql's to write (readSettings
    // fills in a database without it); the proposal ceiling is automatic.
    everyoneSince: null, proposalCeiling: 0, liveBuildStream: true,
    // Homeroom bot parity, P8: pictures on the default image model, 24 a
    // person a week (services/bot-pictures.js).
    imageModel: 'google/gemini-2.5-flash-image', pictureWeeklyCap: 24,
  });
  const t = bot.parseSettings([
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_CONCURRENCY, value: '99' },
    { key: bot.KEY_BATCH_SIZE, value: '0' },
    { key: bot.KEY_PAUSED_APPS, value: '["a-b", 3, "c"]' },
  ]);
  assert.equal(t.mode, 'shadow');
  assert.equal(t.concurrency, 4, 'clamped to the ceiling');
  assert.equal(t.batchSize, 1, 'clamped to the floor');
  assert.deepEqual(t.pausedApps, ['a-b', 'c']);
  assert.deepEqual(bot.parseSettings([{ key: bot.KEY_PAUSED_APPS, value: 'not json' }]).pausedApps, []);
  const u = bot.parseSettings([
    { key: bot.KEY_LIVE_AT_ONCE, value: '99' },
    { key: bot.KEY_PER_PERSON, value: '0' },
    { key: bot.KEY_DM_CHAT, value: 'off' },
  ]);
  assert.equal(u.liveAtOnce, 24, 'clamped to the ceiling');
  assert.equal(u.perPerson, 1, 'clamped to the floor');
  assert.equal(u.dmChat, false);
  assert.equal(bot.parseSettings([{ key: bot.KEY_PER_PERSON, value: '99' }]).perPerson, 6, 'clamped to the ceiling');
  assert.deepEqual(bot.validateSettingsPatch({ liveAtOnce: 8, perPerson: 3, dmChat: false }).updates, [
    [bot.KEY_LIVE_AT_ONCE, '8'], [bot.KEY_PER_PERSON, '3'], [bot.KEY_DM_CHAT, 'off'],
  ]);
  assert.equal(bot.validateSettingsPatch({ liveAtOnce: 24 }).ok, true);
  assert.equal(bot.validateSettingsPatch({ liveAtOnce: 25 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ perPerson: 6 }).ok, true);
  assert.equal(bot.validateSettingsPatch({ perPerson: 7 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ dmChat: 'yes' }).ok, false);
});

test('the everyone moment and the proposal ceiling parse, clamp and validate', () => {
  const s = bot.parseSettings([
    { key: bot.KEY_EVERYONE_SINCE, value: '2026-10-05T09:00:00Z' },
    { key: bot.KEY_PROPOSAL_CEILING, value: '5000' },
  ]);
  assert.equal(s.everyoneSince, '2026-10-05T09:00:00.000Z');
  assert.equal(s.proposalCeiling, 1000, 'clamped to the ceiling');
  assert.equal(bot.parseSettings([{ key: bot.KEY_EVERYONE_SINCE, value: 'soon' }]).everyoneSince, null);

  assert.deepEqual(bot.validateSettingsPatch({ proposalCeiling: 40 }).updates, [[bot.KEY_PROPOSAL_CEILING, '40']]);
  assert.deepEqual(bot.validateSettingsPatch({ audience: 'everyone', livePlatform: false, proposalCeiling: 40 }).updates,
    [[bot.KEY_PROPOSAL_CEILING, '40']], 'the retired audience and platform switch are not written');
  assert.equal(bot.validateSettingsPatch({ proposalCeiling: -1 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ proposalCeiling: 1001 }).ok, false);
  // The moment it went on for everyone is schema.sql's to write, never a patch's.
  assert.equal(bot.validateSettingsPatch({ everyoneSince: '2020-01-01' }).ok, false);
  assert.equal(bot.validateSettingsPatch({ audienceSince: '2020-01-01' }).ok, false);
});

test('the proposal ceiling: an admin\'s number, else a fixed one, since every app is live', () => {
  assert.equal(bot.botProposalCeiling({}), bot.EVERYONE_PROPOSAL_CEILING);
  assert.equal(bot.EVERYONE_PROPOSAL_CEILING, 100);
  assert.equal(bot.botProposalCeiling(null), 100);
  assert.equal(bot.botProposalCeiling({ liveApps: ['a', 'b'], firstVersionApps: ['c'] }), 100,
    'the retired lists do not count: "per live app" would be no ceiling at all');
  assert.equal(bot.botProposalCeiling({ proposalCeiling: 30 }), 30);
  assert.equal(bot.botProposalCeiling({ proposalCeiling: 0 }), 100, 'unset is automatic');
});

test('a settings save never writes the everyone moment, and more room asks the lane to grant again', async () => {
  const writes = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: [{ key: bot.KEY_MODE, value: 'shadow' }] };
      if (/INSERT INTO platform_settings/.test(s)) { writes.push([params[0], params[1]]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  // What used to switch the bot to everyone changes nothing now.
  assert.deepEqual(await bot.writeSettings(pool, { audience: 'everyone' }, 1), { ok: false, error: 'Nothing to update' });
  assert.deepEqual(writes, []);
  assert.deepEqual(await bot.writeSettings(pool, { liveAtOnce: 12, perPerson: 3 }, 1), { ok: true });
  assert.deepEqual(writes.map(([k]) => k), [bot.KEY_LIVE_AT_ONCE, bot.KEY_PER_PERSON]);
  assert.ok(!writes.some(([k]) => k === bot.KEY_EVERYONE_SINCE));
  const write = SRC.slice(SRC.indexOf('async function writeSettings('), SRC.indexOf('// ── Identity'));
  assert.doesNotMatch(write, /KEY_EVERYONE_SINCE/, 'the moment is schema.sql\'s, written once');
  // The lane (bot-lane) grants and refreshes; a save tells it, and wakes no
  // loop of this process's.
  assert.match(write, /\[KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_PAUSED_APPS\]\.includes\(key\)\)[\s\S]{0,120}?\{\s+await platform\(\)\.botRefresh\(null\)/);
  assert.doesNotMatch(write, /wakeAll/);
});

test('validateSettingsPatch refuses live mode and bad values, accepts a real patch', () => {
  assert.equal(bot.validateSettingsPatch({ mode: 'live' }).ok, false, 'live is not in this slice');
  assert.match(bot.validateSettingsPatch({ mode: 'live' }).error, /shadow mode/);
  assert.equal(bot.validateSettingsPatch({ mode: 'loud' }).ok, false);
  assert.equal(bot.validateSettingsPatch({ concurrency: 0 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ batchSize: 501 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ batchSize: 500 }).ok, true, 'the ceiling is 500 (#2684 follow-up: 100 is the default)');
  assert.equal(bot.validateSettingsPatch({ pausedApps: ['Bad Slug'] }).ok, false);
  assert.equal(bot.validateSettingsPatch({ weeklyLimitCents: -1 }).ok, false);
  assert.equal(bot.validateSettingsPatch({}).ok, false, 'nothing to update');
  const ok = bot.validateSettingsPatch({ mode: 'shadow', pausedApps: ['x', 'x', 'y'], weeklyLimitCents: 15000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [[bot.KEY_MODE, 'shadow'], [bot.KEY_PAUSED_APPS, '["x","y"]']]);
  assert.equal(ok.weeklyLimitCents, 15000);
});

test('parseRepo reads owner and repo off a GitHub URL', () => {
  assert.deepEqual(bot.parseRepo('https://github.com/usernode-bot/todo-list-b641de'), { owner: 'usernode-bot', repo: 'todo-list-b641de' });
  assert.deepEqual(bot.parseRepo('https://github.com/Usernode-Labs/social-vibecoding.git'), { owner: 'Usernode-Labs', repo: 'social-vibecoding' });
  assert.equal(bot.parseRepo('https://example.com/x/y'), null);
});

// ── Activity on a request reaches its instance ───────────────────────────

test('noteIssueActivity: a message or an edit is heard by the request\'s instance; anything else asks for a refresh', () => {
  // Without the workflow runtime in this process both appends are no-ops,
  // so this only pins what is accepted and where each kind goes.
  assert.equal(bot.noteIssueActivity({ appId: 9, issueNumber: 12, reason: 'created' }), true);
  assert.equal(bot.noteIssueActivity({ appId: 9, issueNumber: 12, reason: 'thread' }), true);
  assert.equal(bot.noteIssueActivity({ appId: 9, issueNumber: 'x' }), false, 'a bad number is dropped');
  assert.equal(bot.noteIssueActivity({ appId: 0, issueNumber: 12 }), false);
  const note = SRC.slice(SRC.indexOf('const INTERRUPTING_ACTIVITY'), SRC.indexOf('async function noteProposalActivity('));
  assert.match(note, /const INTERRUPTING_ACTIVITY = new Set\(\['thread', 'updated'\]\);/);
  assert.match(note, /\? platform\(\)\.botActivityNow\(\{ appId: id, issueNumber: n, messageId \}\)\n\s+: platform\(\)\.botRefresh\(id, \{ now: String\(reason\) === 'first_version' \}\);/,
    'a person writing is Activity on the request (a read under way starts over); the rest refreshes its project');
});

test('activity reaches the bot from every place an issue changes on the platform', () => {
  const ws = read('src/services/ws.js');
  assert.doesNotMatch(ws, /case 'homeroom_bot':|case 'agent_stop':/, 'no bus wake of the bot\'s or a Mayor stop\'s: nothing sends one');
  const push = ws.slice(ws.indexOf('function pushIssueUpdate(data)'));
  assert.match(push.slice(0, 700), /noteIssueActivityForBot\(data\.appId, data\.issueNumber, data\.action\)/,
    'an edit or an unclaim reaches the bot');
  const handle = ws.slice(ws.indexOf('async function handleMessage(pool, client, msg)'));
  assert.match(handle, /if \(thread && thread\.type === 'issue' && !heard\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'thread'\);\n\s+else if \(thread && thread\.type === 'issue' && !rows\[0\]\?\.requestHeard\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'posted'\)/,
    'a connector\'s post on an issue thread is Activity as a person\'s is; one on a request with no instance asks for a refresh');
  const issues = read('src/routes/issues.js');
  assert.match(issues, /noteIssueActivity\(\{ appId: app\.id, issueNumber: githubIssueNumber, reason: 'created' \}\)/,
    'a new request reaches the bot once its GitHub twin exists');
  assert.match(SRC, /await platform\(\)\.botRefresh\(null\)/, 'switching the mode on rebuilds the queue at once');
});


// ── The budget on a turn (#2737) ─────────────────────────────────────────

test('runTriage: the wall clock stops a turn that never finishes, and the look says so', async (t) => {
  const harness = triageHarness({ verdictText: 'never gets here' });
  const { out, stopped, look } = await runToWallClock(t, harness, {}, {
    result: { lastResultText: '', inputTokens: 5000, outputTokens: 10 },
  });
  assert.deepEqual(stopped, [501], 'the turn is ended through the supported stop path');
  assert.equal(out.budget, 'wall clock');
  assert.equal(out.verdict, 'failed');
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params.includes('budget: wall clock'), 'the ledger says which limit it hit');
  assert.deepEqual([look.out.queue, look.out.reason, look.out.priority], ['requeue', 'budget_retry', 9],
    'and its request is owed one more look, at the bottom of the queue');
  assert.ok(!harness.calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)), 'the queue row is its instance\'s to change');
});

// ── Only the clock stops a turn; a fresh thread per issue (#3035) ───────

const QUESTION_REPLY = 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```';

// Drive the wall clock without waiting twenty minutes for it: the dispatch
// hangs until the bot stops it, and mocked timers fire the budget at once
// (the clock is durable-turn's). The read runs inside a look of its own, so
// the test can read what the look decided for its request.
async function runToWallClock(t, harness, opts = {}, {
  ctx = {}, result = { lastResultText: '' }, estimatedCostUsd = undefined,
} = {}) {
  const stopped = [];
  let release;
  const hung = new Promise((resolve) => { release = resolve; });
  harness.deps.worker.stopTurn = (id) => { stopped.push(id); release(); return Promise.resolve(); };
  harness.deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce }) => {
    await dispatchOnce({ openrouterApiKey: 'k', ...ctx });
    await hung;
    // A stopped attempt never reaches turn.completed, so the ledger has no
    // cost for it: `estimatedCostUsd` is absent, as it is in production,
    // unless a test says otherwise.
    return { result, error: null, ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}) };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const look = newLook();
  const running = bot._runInLookForTests(look, () => bot.runTriage(harness.pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: harness.deps,
    settings: { turnSeconds: 1200, turnInputTokens: 10_000_000 }, ...opts,
  }));
  for (let i = 0; i < 500 && !stopped.length; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1200 * 1000);
  }
  return { out: await running, stopped, look };
}

test('runTriage: a turn over its token limit keeps its verdict, and nothing is stopped', async () => {
  // Between #2870 and #3035 the token check was wired to the stop. Usage
  // only arrives when a turn is over, so it fired on FINISHED turns — every
  // one, since the figure was a conversation's running total — threw the
  // verdict away, and killed the next issue. 13 of 13 turns, zero verdicts.
  const stopped = [];
  const { pool, deps, calls } = triageHarness({
    sessionId: 834,
    result: { lastResultText: QUESTION_REPLY, inputTokens: 2_711_069_602, outputTokens: 262_128 },
  });
  deps.worker.stopTurn = async (id) => { stopped.push(id); };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 3600, turnInputTokens: 10_000_000 }, deps,
  });
  assert.equal(calls.exec[0].opts.onUsage, undefined, 'no usage hook reaches the stop');
  assert.ok(!/onUsage:/.test(SRC), 'the bot passes no usage hook at all');
  assert.deepEqual(stopped, [], 'a finished turn is never killed');
  assert.equal(out.verdict, 'question', 'the verdict the turn reached is kept');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'question');
  assert.equal(insert.params[19], null, 'and it is not recorded as a budget stop');
  assert.ok(!calls.queries.some((q) => /budget_retry/.test(q.s)), 'nor requeued');
});

test('runTriage: a second budget stop on the same issue drops it instead of looping', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 845 });
  const { out, look } = await runToWallClock(t, harness, { item: { ...ITEM, reason: 'budget_retry' } });
  assert.equal(out.budget, 'wall clock');
  assert.equal(look.out.queue, 'consume',
    'the one retry is spent, so the issue is let go rather than retried forever');
});

test('a budget stop records WHICH limit tripped, in a column of its own', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 856 });
  await runToWallClock(t, harness);
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.s, /budget_stop, proposal_session_id[,)]/, 'the insert names the column');
  assert.ok(insert.params.includes('wall clock'),
    'the limit is stored as data, not left to be grepped out of the error text');
  assert.ok(insert.params.includes('budget: wall clock'), 'and the error line still reads the same');
});

test('every issue starts a fresh model thread, through the platform\'s own reading of null', async () => {
  // The bot always passed a null thread, and the old test pinned exactly
  // that argument. But the platform reads null as "carry on the saved
  // thread" in two places, and saves the thread back after every turn, so
  // each app's bot session was ONE conversation: the Homeroom app's usage
  // climbed monotonically across every run for three days to 2.7 billion.
  // This harness imitates both of those readings, with a thread already
  // saved on the session, and checks what the dispatch actually resumes.
  const { pool, deps, calls } = triageHarness({ verdictText: QUESTION_REPLY, sessionId: 878 });
  const select = pool.query;
  pool.query = async (sql, params) => {
    const res = await select(sql, params);
    if (/SELECT \* FROM chat_sessions/.test(String(sql))) res.rows[0].agent_thread_id = 'thread-from-the-last-issue';
    return res;
  };
  deps.agentTurn.resolveCodexRuntimeContext = async ({ session, resumeThreadId }) => ({
    openrouterApiKey: 'k',
    resumeThreadId: resumeThreadId || session.agent_thread_id || null,
  });
  deps.sessions.runCodexAttemptLoop = async ({ resumeThreadId, resolveRuntime, dispatchOnce }) => {
    const runtimeContext = await resolveRuntime();
    const thread = resumeThreadId ?? runtimeContext.resumeThreadId ?? null;
    const result = await dispatchOnce({ ...runtimeContext, resumeThreadId: thread, resumeSessionId: thread });
    return { result, error: null, estimatedCostUsd: 0.01 };
  };
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.verdict, 'question');
  assert.equal(calls.exec[0].opts.resumeSessionId, null, 'the dispatch resumes nothing');
  assert.equal(calls.exec[0].opts.resumeThreadId, null);
  assert.deepEqual(calls.moves[0], ['takeSlot', 878, 0], 'the session takes its slot for the turn');
  assert.ok(calls.queries.some((q) => /UPDATE chat_sessions SET agent_thread_id = NULL WHERE id = \$1/.test(q.s) && q.params[0] === 878),
    'and the saved thread is cleared in the row, for every later reader');

  // The imitation is only worth something while it matches the platform.
  // (#3296 added a harness check after this read; it can only drop a thread,
  // never supply one, so a null here still means the saved thread.)
  assert.match(read('src/services/agent-turn.js'), /const candidateThreadId = resumeThreadId \|\| session\.agent_thread_id \|\| null;/,
    'if this changes, re-check how a null thread is read before trusting the test above');
  assert.match(read('src/routes/sessions.js'), /resumeThreadId \?\? runtimeContext\.resumeThreadId \?\? null/);
});

test('issues dropped by those spurious stops come back on the next refresh', () => {
  // The issue-level "unchanged since its last run" check counted a
  // collateral kill and a discarded token-stop as a judgement of the issue,
  // so an issue whose last row was one of those was never queued again.
  const q = SRC.slice(SRC.indexOf('async function lastRunsByIssue'), SRC.indexOf('async function refreshApp'));
  assert.match(q, /AND budget_stop IS DISTINCT FROM 'input tokens'/);
  assert.match(q, /AND \(error IS NULL OR error NOT LIKE 'collateral:%'\)/);
  assert.ok(!/spendBudget\('input tokens'\)/.test(SRC), 'and no new token stops are written, so the filter is a one-off recovery');
});

// ── A stopped turn is priced from what its finished requests used (#3038) ──

const PRICING = { available: true, inputPricePerMillion: 0.075, outputPricePerMillion: 0.3 };
const realEstimator = require('../src/services/agent-turn').estimateRequestedModelCost;

test('a turn stopped by the clock is priced from the requests that finished before the stop', async (t) => {
  // The one genuine wall-clock stop in the 2026-09-24 export (#3027, 20.3
  // minutes) recorded $0.00: the agent reports usage only at turn.completed,
  // which a stopped turn never reaches. The relay's per-request lines do
  // survive the kill, and they are priced here exactly as the ledger prices
  // a finished turn.
  const harness = triageHarness({ verdictText: 'x', sessionId: 901 });
  harness.deps.agentTurn.estimateRequestedModelCost = realEstimator;
  const { out } = await runToWallClock(t, harness, {}, {
    ctx: { pricingSnapshot: PRICING },
    result: {
      lastResultText: '',
      relayUsage: { requests: 7, inputTokens: 40_000_000, cachedInputTokens: 36_000_000, outputTokens: 5_000, reasoningOutputTokens: 900 },
    },
  });
  assert.equal(out.budget, 'wall clock');
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], 3.0015, 'cost: 40M input at $0.075/M plus 5k output at $0.30/M');
  assert.equal(insert.params[15], 40_000_000, 'and the tokens the relay counted');
  assert.equal(insert.params[16], 5_000);
  assert.ok(insert.params.includes('wall clock'), 'still recorded as the stop it was');
  assert.deepEqual(harness.calls.spend, [{ userId: 77, cents: 300.15, opts: { byok: false } }],
    'and it reaches the weekly cap like any other spend');
});

test('the ledger figure wins whenever the agent reported one', async () => {
  // A finished turn has the platform's own figure; the relay's sum is only
  // for the turn that has none, so the two never add up to a double count.
  const { pool, deps, calls } = triageHarness({
    sessionId: 902,
    result: {
      lastResultText: 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```',
      inputTokens: 1000, outputTokens: 50,
      relayUsage: { requests: 3, inputTokens: 999_999, cachedInputTokens: 0, outputTokens: 999, reasoningOutputTokens: 0 },
    },
  });
  deps.agentTurn.estimateRequestedModelCost = realEstimator;
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], 0.0123, "the harness's ledger cost, not the relay's");
  assert.equal(insert.params[15], 1000, "and the agent's own tokens");
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 1.23, opts: { byok: false } }], 'debited once');
});

test('with no price to apply, a stopped turn records its tokens and invents no cost', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 903 });
  harness.deps.agentTurn.estimateRequestedModelCost = realEstimator;
  await runToWallClock(t, harness, {}, {
    ctx: {},
    result: { lastResultText: '', relayUsage: { requests: 2, inputTokens: 120_000, cachedInputTokens: 0, outputTokens: 800, reasoningOutputTokens: 0 } },
  });
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], null, 'unknown, not zero');
  assert.equal(insert.params[15], 120_000);
  assert.deepEqual(harness.calls.spend, [], 'nothing to debit');
});

test('relaySpend: no finished request means no figure at all', () => {
  assert.equal(bot.relaySpend(null, PRICING, { estimateRequestedModelCost: realEstimator }), null);
  assert.equal(bot.relaySpend({ requests: 0, inputTokens: 0, outputTokens: 0 }, PRICING, { estimateRequestedModelCost: realEstimator }), null);
  assert.deepEqual(
    bot.relaySpend({ requests: 1, inputTokens: 1_000_000, outputTokens: 0 }, PRICING, { estimateRequestedModelCost: realEstimator }),
    { requests: 1, inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.075 },
  );
});

test('relaySpend: the relay\'s cache reads and writes are priced as the ledger prices them', () => {
  const cachePriced = {
    ...PRICING, cacheReadPricePerMillion: 0.0075, cacheWritePricePerMillion: 0.09375,
  };
  const usage = { requests: 3, inputTokens: 1_000_000, cachedInputTokens: 900_000, cacheWriteInputTokens: 50_000, outputTokens: 0 };
  const spend = bot.relaySpend(usage, cachePriced, { estimateRequestedModelCost: realEstimator });
  assert.equal(spend.costUsd, realEstimator(usage, cachePriced).estimatedCostUsd);
  // 50K uncached at $0.075/M + 900K reads at $0.0075/M + 50K writes at $0.09375/M.
  assert.equal(spend.costUsd, 0.0151875);
  assert.equal(spend.inputTokens, 1_000_000, 'the tokens it reports are unchanged');
  // Without cache prices, the old prompt-rate figure.
  assert.equal(bot.relaySpend(usage, PRICING, { estimateRequestedModelCost: realEstimator }).costUsd, 0.075);
});

test('the stopped-run detail says its cost is a floor', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /Its cost counts the model requests that finished before the stop\./);
  assert.match(ui, /so the real cost is a little higher/);
});

test('the totals count a budget stop separately and stop calling it a failure', () => {
  assert.match(SRC, /COUNT\(\*\) FILTER \(WHERE verdict = 'failed' AND budget_stop IS NULL\)::int AS failed/,
    'a turn we stopped ourselves is not a failure');
  assert.match(SRC, /COUNT\(\*\) FILTER \(WHERE budget_stop IS NOT NULL\)::int AS budget_stopped/);
  assert.match(SRC, /budgetStopped: t\.budget_stopped \|\| 0/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS budget_stop TEXT;/,
    'added, not backfilled: the rows already recorded keep their error text and a null here');
});

test('the runs query filters to budget stops on one static statement', () => {
  assert.match(SRC, /AND \(NOT \$5::boolean OR r\.budget_stop IS NOT NULL\)/,
    'a nullable parameter, so the SQL lint still sees one static query');
  assert.match(SRC, /r\.budget_stop,/, 'and the column travels with the row');
  assert.match(SRC, /'error', 'budget_stop', 'thread_seen_at',/, 'the export carries it beside the error');
});

// ── What the first day of budget data exposed (#2870) ────────────────────

test('a turn stopped on its budget is still debited against the weekly cap', async (t) => {
  // The three stops in the first day's ledger all recorded $0.0000, because
  // the branch that writes the stop returned above the debit. That is the
  // wrong way round: a twenty-minute turn nobody was ever going to use is
  // exactly the spend a weekly cap exists to notice.
  const harness = triageHarness({ verdictText: 'never gets here', sessionId: 611 });
  const { calls } = harness;
  const { out } = await runToWallClock(t, harness, {}, {
    result: { lastResultText: '', inputTokens: 5000, outputTokens: 10 }, estimatedCostUsd: 0.4,
  });
  assert.equal(out.budget, 'wall clock');
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 40, opts: { byok: false } }],
    'what the killed turn spent joins the same pool a completed one does');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params.includes(0.4), 'and the ledger row carries the cost instead of a zero');
  assert.ok(insert.params.includes(5000) && insert.params.includes(10),
    'along with whatever usage the dispatch managed to report');
});

test('an empty reply from a turn somebody stopped is the stop, not the request\'s failure', () => {
  // Two of the first three budget stops wrote an `(empty reply)` row in the
  // SAME SECOND, on a different issue: the stop killed the session's
  // container and an issue dispatched into it died with it. A turn's record
  // now says who stopped it (durable-turn's stoppedBy), and the clock stops
  // only its own turn, by its journal; an empty reply under a stop ends the
  // look with nothing recorded and no pause of the lane: the request is read
  // again when it is next owed (design-bot-loop Q1).
  const body = SRC.slice(SRC.indexOf('async function runTriage('), SRC.indexOf('// ── Builds ──'));
  assert.match(body, /if \(stoppedBy\) \{\n\s+look\.consume\(\);\n[^\n]*\n\s+return \{ ran: false, reason: 'stopped', detail: stoppedBy\.by \|\| null \};/);
  assert.match(body, /stop: \(\) => durableTurn\.clockStop\(worker, pool, session\.id, look\.owner\),/);
  assert.match(read('src/services/durable-turn.js'),
    /worker\.stopOwnedTurn\(pool, \{ sessionId, machine: own\.machine, key: own\.key, kinds: \[own\.kind\], workKey: own\.workKey \|\| null, stamp: false, release: false \}\)/);
});

test('an empty reply with no stop behind it records WHY it was empty', async () => {
  // 21 of the first 225 runs recorded `(empty reply)` and nothing else,
  // which is not enough to tell a provider refusal from a rate limit from a
  // container that died. The worker already knew; it was being discarded.
  const { pool, deps, calls } = triageHarness({
    sessionId: 744,
    result: {
      lastResultText: '',
      resultSubtype: 'error_during_execution',
      providerStopReason: 'rate_limit',
      agentErrorCode: 'provider_overloaded',
      agentError: '429 Too Many Requests',
      agentExit: 1,
      inputTokens: 4242,
      outputTokens: 0,
    },
  });
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 3600, turnInputTokens: 10_000_000 }, deps,
  });
  assert.equal(out.verdict, 'failed');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.params[18], /\(empty reply\)/, 'the old text is still there to search for');
  assert.match(insert.params[18], /rate_limit/);
  assert.match(insert.params[18], /provider_overloaded/);
  assert.match(insert.params[18], /429 Too Many Requests/);
});

test('describeStop reports what is known and admits when nothing is', () => {
  assert.equal(bot.describeStop({}), '[no reason reported]',
    'an honest blank beats an invented cause');
  const line = bot.describeStop({
    resultSubtype: 'error', providerStopReason: 'max_tokens', agentErrorCode: 'ctx',
    markerlessCause: 'exit', agentExit: 2, ccExit: 0, agentError: 'context window',
  });
  assert.match(line, /subtype=error/);
  assert.match(line, /stop=max_tokens/);
  assert.match(line, /markerless=exit/);
  assert.match(line, /agentExit=2/);
  assert.ok(!/ccExit/.test(line), 'a clean exit code is not a reason and is left out');
});

test('the usage hook reaches BOTH of the worker usage paths', () => {
  // The bug this fixes: the hook was called from applyClaudeResultUsage
  // only — the Claude `result` event — while the bot runs on the
  // Codex/OpenRouter agent, whose usage arrives through a different branch.
  // The token budget was inert in production for its whole first day.
  const w = read('src/services/worker.js');
  assert.match(w, /function notifyUsage\(state\)/, 'one implementation, not two');
  assert.equal((w.match(/\bnotifyUsage\(state\)/g) || []).length, 3,
    'declared once and called from both usage paths');
  const codexBranch = w.slice(w.indexOf("} else if (ev.kind === 'usage')"));
  assert.match(codexBranch.slice(0, 1400), /notifyUsage\(state\)/,
    'the Codex/OpenRouter branch notifies too');
  assert.match(w, /applyClaudeResultUsage[\s\S]{0,1800}?notifyUsage\(state\)/,
    'and so does the Claude result path it always did');

  // And be honest about what that buys on the agent the bot actually runs:
  // this one reports usage once, when the turn is already over.
  const agent = read('src/agents/codex-openrouter.js');
  assert.equal((agent.match(/kind: 'usage'/g) || []).length, 1, 'exactly one usage emission');
  const at = agent.indexOf("kind: 'usage'");
  const guard = agent.lastIndexOf("ev.type === 'turn.completed'", at);
  assert.ok(guard > 0 && guard < at, 'the emission sits under a turn.completed guard');
  assert.ok(!/ev\.type ===/.test(agent.slice(guard + 30, at)),
    'with no other event check between, so it is terminal: on this agent the '
    + 'token limit reports a breach after the fact rather than stopping a turn');
});

test('a turn that finishes over its token budget says so', () => {
  assert.match(SRC, /Triage turn finished over its token budget/,
    'not silently dropped just because it was too late to stop it');
  assert.match(SRC, /!budgetHit && usage\.inputTokens != null && usage\.inputTokens > turnInputTokens/,
    'and only when we did not already stop it ourselves');
});

test('the dashboard says where the token limit actually binds', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /id="admin-homeroom-bot-turn-tokens-note"/);
  assert.match(ui, /A warning, not a stop\./,
    'a setting that cannot stop a turn should not look like one that can');
  assert.match(ui, /keeps its verdict and the overrun is\s+logged/);
  assert.ok(!/stops an issue after/.test(ui), 'the save message stopped promising a stop too');
});
// ── Refusals (#2737) ─────────────────────────────────────────────────────

test('runTriage: a busy session is a refusal: no ledger row, the queue untouched, the look waits', async () => {
  const { pool, deps, calls } = triageHarness({ routed: { error: 'session_busy' } });
  const { out, look } = await triageInLook(pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.reason, 'refused');
  assert.equal(out.detail, 'session_busy');
  assert.ok(!calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)),
    'a refusal is not a verdict: 121 of these filled the first day of the ledger');
  assert.ok(!calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)), 'nothing here touches the queue');
  // Its instance backs the request off (bot-request's `busy`), its tries
  // untouched, because nothing was read.
  assert.deepEqual([look.out.queue, look.out.error], ['busy', 'session_busy']);
});

// ── Storage and platform faults (#3122) ──────────────────────────────────

const QUOTA_ERROR = 'worker: HTTP-Code: 403\nMessage: Unknown API Status Code!\nBody: "{\\"kind\\":\\"Status\\",\\"status\\":\\"Failure\\",\\"message\\":\\"persistentvolumeclaims \\\\\\"sv-worker-s4670-state\\\\\\" is forbidden: exceeded quota: social-vibecoding, requested: persistentvolumeclaims=1,requests.storage=5Gi, used: persistentvolumeclaims=120,requests.storage=600Gi, limited: persistentvolumeclaims=120,requests.storage=600Gi\\",\\"reason\\":\\"Forbidden\\",\\"code\\":403}"';

test('the bot starts its worker on temporary storage, never a volume', async () => {
  // Every issue starts a fresh thread (#3036), so nothing on the worker has
  // to outlive the turn; a 5Gi volume per app is what filled the quota.
  const { pool, deps, calls } = triageHarness({ verdictText: 'x', sessionId: 910 });
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(calls.ensured[0].opts.temporary, true);
});

test('a platform fault writes no run, and its request keeps its debt for the lane to retry', async () => {
  // 60 rows in 70 minutes while the quota was full, one per retry. A fault
  // is the platform's: the look says so (bot-request's `fault`, which pauses
  // the lane), and no run is written that a refresh would read as a failed
  // read of the request.
  const { pool, deps, calls } = triageHarness({ verdictText: 'x', sessionId: 911 });
  deps.worker.ensureWorker = async () => { throw new Error(QUOTA_ERROR.replace(/^worker: /, '')); };
  const { out, look } = await triageInLook(pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.reason, 'infra');
  assert.match(out.detail, /^worker: HTTP-Code: 403/);
  assert.equal(look.out.queue, 'fault');
  assert.ok(!calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no row for a fault');
  assert.ok(!calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)));
});

test('releaseBotVolumes frees only the bot\'s own volumes whose worker is gone', async () => {
  const destroyed = [];
  const volumes = [
    { sessionId: 4670, attached: false, terminating: false }, // bot, idle: freed
    { sessionId: 4685, attached: true, terminating: false }, // bot, warm worker: kept
    { sessionId: 4961, attached: false, terminating: true }, // bot, already going
    { sessionId: 5000, attached: false, terminating: false }, // a person's: never
    { sessionId: 4700, attached: false, terminating: false }, // bot, delete fails: logged
  ];
  const asked = [];
  const pool = {
    async query(sql, params) {
      asked.push(params);
      return { rows: params[1].filter((id) => [4670, 4685, 4961, 4700].includes(id)).map((id) => ({ id })) };
    },
  };
  const worker = {
    async listWorkerVolumes() { return volumes; },
    async destroyCcVolume(id) { if (id === 4700) throw new Error('boom'); destroyed.push(id); },
  };
  const freed = await bot.releaseBotVolumes(pool, BOT, { worker });
  assert.deepEqual(freed, [4670]);
  assert.deepEqual(destroyed, [4670]);
  assert.equal(asked[0][0], 77, 'scoped to the bot user');
  assert.deepEqual(asked[0][1].sort(), [4670, 4700, 5000], 'only detached, settled volumes are even considered');
  assert.deepEqual(await bot.releaseBotVolumes(pool, BOT, { worker: {} }), [], 'a Docker host has nothing to free');
});

test('the dashboard says when the bot will try again after a fault', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /, trying again at \$\{retryAt\(payload\.loop\)\}/);
  assert.match(ui, /retryInMs\?: number \| null;/);
});

// ── A turn record nothing owns (#2737) ───────────────────────────────────

test('clearStaleTurn: clears an old record with no container, and never a live one', async () => {
  const cleared = [];
  const mk = (activeTurn, containers) => ({
    pool: { async query() { return { rows: [{ active_turn: activeTurn }] }; } },
    worker: {
      async listOrphanWorkers() { return containers; },
      async clearActiveTurn(id) { cleared.push(id); },
    },
  });
  const OLD = { startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), turnUuid: 'u', logicalTurnId: 'l' };
  const NEW = { startedAt: new Date().toISOString(), turnUuid: 'u', logicalTurnId: 'l' };

  let h = mk(null, []);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 }), null, 'nothing set');

  h = mk(NEW, []);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 20 * 60 * 1000 }), null,
    'a turn younger than the budget is still running');

  h = mk(OLD, [{ name: 'usernode-worker-501', sessionId: 501, state: 'running' }]);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 }), null,
    'a container still owns it, so it is not ours to clear');
  assert.deepEqual(cleared, []);

  h = mk(OLD, [{ name: 'usernode-worker-777', sessionId: 777, state: 'running' }]);
  const out = await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 });
  assert.ok(out && out.ageMs > 0, 'old, and nothing owns it');
  assert.deepEqual(cleared, [501]);
});

// ── The fourth verdict (#2737) ───────────────────────────────────────────

test('parseVerdict accepts empty, and it shares the question tripwire', () => {
  const parsed = bot.parseVerdict('```json\n{"verdict":"empty","determined":false,"missing_fact":"none","reason":"A test issue with no request in it; close it."}\n```');
  assert.equal(parsed.verdict, 'empty');
  assert.equal(parsed.reason, 'A test issue with no request in it; close it.');
  assert.deepEqual([...bot.TRIPWIRE_VERDICTS], ['question', 'empty'],
    'both are a demand on somebody attention, so they share one daily allowance');
  assert.ok(bot.VERDICTS.includes('empty'));
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CHECK \(verdict IN \('question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise'\)\)/);
  assert.match(schema, /ALTER TABLE homeroom_bot_runs DROP CONSTRAINT IF EXISTS homeroom_bot_runs_verdict_check/,
    'and a database that predates it is widened on boot');
});

// ── refreshApp against an injected GitHub ────────────────────────────────

// What a refresh tells each request's instance (platform.botOwed and
// botNotOwed append to wf_events through the refresh's own pool): the
// events, read back off the insert. Answers the insert, else null.
function botEvents(events, s, params) {
  if (!/INSERT INTO wf_events/.test(s)) return null;
  events.push({ machine: params[0], key: params[1], type: params[3], payload: JSON.parse(params[4]), requestKey: params[7] });
  return { rows: [{ id: events.length }] };
}
const owedOf = (events) => events.filter((e) => e.type === 'Owed');
const notOwedOf = (events) => events.filter((e) => e.type === 'NotOwed');
// The requests a project has in the queue before the refresh (it reads
// them first, to know which it no longer wants and which are new).
const QUEUED_BEFORE_RE = /SELECT issue_number FROM homeroom_bot_queue WHERE app_id = \$1/;

test('refreshApp owes eligible issues a look, skips busy and unchanged ones, and lets go of the rest', async () => {
  const events = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      const appended = botEvents(events, s, params);
      if (appended) return appended;
      // #7 is no longer on GitHub's list (closed).
      if (QUEUED_BEFORE_RE.test(s)) return { rows: [1, 2, 3, 6, 7].map((n) => ({ issue_number: n })) };
      if (/FROM wf_instances/.test(s)) return { rows: [] };
      if (/FROM issue_claims/.test(s)) return { rows: [{ n: 3 }] };            // #3 has a live human claim
      if (/UNNEST\(cs\.linked_issues\)/.test(s)) return { rows: [{ n: 4 }] }; // #4 has a human session
      if (/headless_issue_number AS n/.test(s)) return { rows: [] };
      if (/created_from_issue_number AS n/.test(s)) return { rows: [] };
      if (/FROM chat_messages/.test(s)) return { rows: [{ n: 2, last_at: '2026-09-10T00:00:00Z' }] };
      if (/FROM homeroom_bot_runs/.test(s)) {
        return { rows: [
          { issue_number: 2, thread_seen_at: '2026-09-10T00:00:00Z' },
          { issue_number: 5, thread_seen_at: '2026-09-01T00:00:00Z' },
          // #6's live build is under way, and its spec comment moved updated_at.
          { issue_number: 6, thread_seen_at: '2026-09-01T00:00:00Z', live_building: true },
        ] };
      }
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  const github = {
    async fetchPublicIssues() {
      return {
        issues: [
          { number: 1, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // new
          { number: 2, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // unchanged since last run
          { number: 3, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // claimed by a person
          { number: 4, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // a person's session
          { number: 5, state: 'open', updatedAt: '2026-09-08T00:00:00Z' }, // changed since last run
          { number: 6, state: 'open', updatedAt: '2026-09-08T00:00:00Z' }, // changed, but the bot is building it
        ],
      };
    },
  };
  const out = await bot.refreshApp(pool, { id: 9, slug: 'todo', repo_url: 'https://github.com/usernode-bot/todo' }, { github, refreshN: 4 });
  assert.equal(out.queued, 2);
  assert.ok(events.every((e) => e.machine === 'bot-request'));
  assert.deepEqual(owedOf(events).map((e) => [e.key, e.payload.issueNumber, e.payload.priority, e.payload.reason]),
    [['request:9:1', 1, 1, 'new'], ['request:9:5', 5, 2, 'changed']]);
  assert.deepEqual(owedOf(events).map((e) => e.requestKey), ['refresh:4:9:1', 'refresh:4:9:5'],
    'keyed by the refresh, so a retried refresh appends nothing twice');
  // Everything else queued for this app is no longer owed a look. Its
  // instance keeps a debt the bot owes itself (a restart's, a failing
  // check's, an older request's read) while the request is `quiet`: open,
  // unchanged and nobody else's (#2), or being built by the bot (#6).
  assert.deepEqual(notOwedOf(events).map((e) => [e.payload.issueNumber, e.payload.quiet]),
    [[2, true], [3, false], [6, true], [7, false]]);
  assert.equal(notOwedOf(events)[0].requestKey, 'refresh:4:9:not:2');
  assert.equal(out.removed, 4);
});

test('the everyone moment: what the bot never read live before it went on for everyone waits for something new', async () => {
  const events = [];
  const since = '2026-10-05T00:00:00.000Z';
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      const appended = botEvents(events, s, params);
      if (appended) return appended;
      if (QUEUED_BEFORE_RE.test(s) || /FROM wf_instances/.test(s)) return { rows: [] };
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_dm_projects/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s)) {
        return { rows: [
          // #2 was read in the background a week before the moment; #3 was
          // live already (its app was on the old live list), and changed since.
          { issue_number: 2, thread_seen_at: '2026-09-28T00:00:00Z', mode: 'shadow' },
          { issue_number: 3, thread_seen_at: '2026-09-28T00:00:00Z', mode: 'live' },
        ] };
      }
      if (/SELECT COUNT\(\*\)/.test(s)) return { rows: [{ cnt: 0 }] };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  const github = {
    async fetchPublicIssues() {
      return {
        issues: [
          // Opened before the moment, untouched since, never read: left alone.
          { number: 1, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
          // Read in the background, then commented on before the moment: left alone too.
          { number: 2, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
          // Live already: changed since its last look, so it is read.
          { number: 3, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
          // Old, but somebody commented after the moment: read.
          { number: 4, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' },
          // New since the moment: read.
          { number: 5, state: 'open', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' },
        ],
      };
    },
  };
  const app = { id: 9, slug: 'todo', repo_url: 'https://github.com/usernode-bot/todo' };
  const capRoom = { proposals_per_app: 5, proposals_total: 50, question_tripwire: 10 };
  await bot.refreshApp(pool, app, { github, capRoom, everyoneSince: since });
  assert.deepEqual(owedOf(events).map((e) => e.payload.issueNumber), [3, 4, 5]);

  // Without a moment (refreshApp handed none), the same board reads as before.
  events.length = 0;
  await bot.refreshApp(pool, app, { github, capRoom });
  assert.deepEqual(owedOf(events).map((e) => e.payload.issueNumber), [1, 2, 3, 4, 5]);
  // The moment always applies now: it is the stored one, whatever else is set.
  const passes = SRC.slice(SRC.indexOf('async function refreshQueue'), SRC.indexOf('// ── The triage turn'));
  assert.equal((passes.match(/everyoneSince: everyoneSinceOf\(settings\)/g) || []).length, 2,
    'both the full refresh and a refresh of named projects pass it');
  assert.match(SRC, /function everyoneSinceOf\(settings\) \{\n  return settings\?\.everyoneSince \|\| null;\n\}/);
});

test('a new request on a live app gets its card when it is queued, under the key its read starts from, whatever it is', async () => {
  const started = [];
  const events = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      const appended = botEvents(events, s, params);
      if (appended) return appended;
      if (QUEUED_BEFORE_RE.test(s)) return { rows: [{ issue_number: 2 }] };
      if (/FROM wf_instances/.test(s)) return { rows: [] };
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_dm_projects|FROM homeroom_bot_runs|FROM homeroom_bot_dm_messages/.test(s)) return { rows: [] };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  const github = {
    async fetchPublicIssues() {
      return { issues: [
        { number: 1, state: 'open', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' },
        // Already in the queue from an earlier refresh: no second card.
        { number: 2, state: 'open', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' },
      ] };
    },
  };
  const dm = {
    async recordRequester(_pool, { issueNumber }) {
      return { userId: 7, username: 'maya', issueTitle: `#${issueNumber}`, hasPlatformAccess: true, firstVersion: firstVersion === issueNumber };
    },
    hasBot: () => true,
    requestLine: () => 'line',
    async requestStart() { return null; },
    async sendDm(_pool, args) { started.push(args); return { messageId: 1, conversationId: 2 }; },
  };
  const app = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo' };
  const capRoom = { proposals_per_app: 5, proposals_total: 50, question_tripwire: 10 };
  // One story: a request filed on the board gets its card too.
  let firstVersion = null;
  await bot.refreshApp(pool, app, { github, capRoom, bot: { id: 77 }, settings: { mode: 'shadow' }, dm });
  assert.equal(started.length, 1);
  assert.equal(started[0].idempotencyKey, 'hrbot-activity-r9-1', 'the request\'s own card (bot-loop lookCardKey)');
  started.length = 0;
  // So does a project's first version.
  firstVersion = 1;
  await bot.refreshApp(pool, app, { github, capRoom, bot: { id: 77 }, settings: { mode: 'shadow' }, dm });
  assert.equal(started.length, 1);
  assert.equal(started[0].idempotencyKey, 'hrbot-activity-r9-1', 'the key runTriage starts the card under');
  assert.match(started[0].content, /Waiting for a free builder/);
  // On a shadow app (no capRoom) nobody gets a card.
  started.length = 0;
  await bot.refreshApp(pool, app, { github, bot: { id: 77 }, settings: { mode: 'shadow' }, dm });
  assert.equal(started.length, 0);
});

function heldPool({ events }) {
  // #10 and #11 were held by the proposals cap (#10 first), #12 by the
  // question tripwire, #13 is unchanged and was never held.
  return {
    async query(sql, params) {
      const s = String(sql);
      const appended = botEvents(events, s, params);
      if (appended) return appended;
      if (QUEUED_BEFORE_RE.test(s) || /FROM wf_instances/.test(s)) return { rows: [] };
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s)) {
        return { rows: [
          { issue_number: 10, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app', created_at: '2026-09-03T00:00:00Z' },
          { issue_number: 11, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app', created_at: '2026-09-04T00:00:00Z' },
          { issue_number: 12, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'question_tripwire', created_at: '2026-09-04T00:00:00Z' },
          { issue_number: 13, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: null, created_at: '2026-09-03T00:00:00Z' },
        ] };
      }
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
}
const HELD_GITHUB = {
  async fetchPublicIssues() {
    // Listed newest first, as GitHub does: the refresh must still take the
    // OLDEST hold when there is room for only one.
    return { issues: [13, 12, 11, 10].map((number) => ({ number, state: 'open', updatedAt: '2026-09-01T00:00:00Z' })) };
  },
};
const HELD_APP = { id: 9, slug: 'rss-reader-4113da', repo_url: 'https://github.com/usernode-bot/rss-reader' };

test('refreshApp brings back held issues once their cap has room, oldest first, no more than fit (#3152)', async () => {
  const events = [];
  await bot.refreshApp(heldPool({ events }), HELD_APP, {
    github: HELD_GITHUB, capRoom: { proposals_per_app: 1, question_tripwire: 0 },
  });
  assert.deepEqual(owedOf(events).map((e) => [e.payload.issueNumber, e.payload.priority, e.payload.reason]), [[10, 2, 'cap_freed']],
    'one merged proposal frees one slot: the oldest held build comes back, the question tripwire is still full');

  events.length = 0;
  await bot.refreshApp(heldPool({ events }), HELD_APP, {
    github: HELD_GITHUB, capRoom: { proposals_per_app: 2, question_tripwire: 3 },
  });
  assert.deepEqual(owedOf(events).map((e) => e.payload.issueNumber).sort(), [10, 11, 12], 'an unchanged issue nothing held stays out');
});

test('refreshApp leaves held issues alone on a shadow app', async () => {
  const events = [];
  const out = await bot.refreshApp(heldPool({ events }), HELD_APP, { github: HELD_GITHUB });
  assert.equal(out.queued, 0, 'no capRoom, no retries: in shadow a hold is only a number on the dashboard');
});

test('#3624: on a live import, the issues it came with wait until something happens on them', async () => {
  const IMPORTED = '2026-09-05T00:00:00Z';
  const events = [];
  const reads = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      const appended = botEvents(events, s, params);
      if (appended) return appended;
      if (QUEUED_BEFORE_RE.test(s) || /FROM wf_instances/.test(s)) return { rows: [] };
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM homeroom_bot_runs/.test(s)) return { rows: [] };
      if (/FROM chat_messages/.test(s)) return { rows: [{ n: 4, last_at: '2026-09-07T00:00:00Z' }] };
      if (/FROM homeroom_bot_dm_projects WHERE app_id = \$1 AND origin = 'import'/.test(s)) {
        reads.push(params[0]);
        return { rows: [{ created_at: IMPORTED }] };
      }
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  const github = {
    async fetchPublicIssues() {
      return {
        issues: [
          { number: 1, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' }, // came with it, quiet since
          { number: 2, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' }, // came with it, commented on since
          { number: 3, state: 'open', createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' }, // filed after the import
          { number: 4, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }, // came with it, discussed on Homeroom since
        ],
      };
    },
  };
  const app = { id: 9, slug: 'imported', repo_url: 'https://github.com/usernode-bot/imported' };
  await bot.refreshApp(pool, app, { github, capRoom: { proposals_per_app: 5, proposals_total: 5, question_tripwire: 3 } });
  assert.deepEqual(reads, [9]);
  assert.deepEqual(owedOf(events).map((e) => [e.payload.issueNumber, e.payload.priority, e.payload.reason]),
    [[2, 2, 'changed'], [3, 1, 'new'], [4, 2, 'changed']],
    'the backlog is judged as if seen at the import; what is filed after it is new');

  // In shadow nothing is held back, and the import is not even read.
  events.length = 0;
  reads.length = 0;
  await bot.refreshApp(pool, app, { github });
  assert.deepEqual(reads, []);
  assert.deepEqual(owedOf(events).map((e) => e.payload.issueNumber), [1, 2, 3, 4]);
});

// Papote #3 (18 Oct 2026): "@Homeroom bot status" under a plan waiting for
// Build it read as a change to the request, and the look it started retired
// the plan and wrote it again. What is said to the bot there is its voice's
// to answer (start_request, change_plan); anything else still counts.
test('papote #3: under a plan waiting for Build it, what people said to the bot does not read the request again', async () => {
  const SEEN = '2026-10-18T17:22:08Z';
  const run = (n, planWaiting) => ({
    id: n, issue_number: n, thread_seen_at: SEEN, verdict: 'ready', cap_suppressed: null, created_at: SEEN, mode: 'live',
    live_building: false, plan_waiting: planWaiting, failed_tries: 0,
  });
  const refresh = async ({ settings, unaddressed = 'reads' }) => {
    const events = [];
    const asked = [];
    const pool = {
      async query(sql, params) {
        const s = String(sql);
        const appended = botEvents(events, s, params);
        if (appended) return appended;
        if (QUEUED_BEFORE_RE.test(s) || /FROM wf_instances|FROM homeroom_bot_dm_projects/.test(s)) return { rows: [] };
        if (/AS plan_waiting/.test(s)) return { rows: [run(3, true), run(4, false)] };
        if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM homeroom_bot_runs/.test(s)) return { rows: [] };
        if (/!~\*/.test(s)) {
          asked.push(params);
          if (unaddressed === 'fails') throw new Error('boom');
          // What people said there apart from to the bot is older than the plan.
          return { rows: [{ n: 3, last_at: '2026-10-18T17:00:00Z' }] };
        }
        // "@Homeroom bot status" on #3 and plain words on #4, both after it.
        if (/FROM chat_messages/.test(s)) return { rows: [{ n: 3, last_at: '2026-10-18T17:30:00Z' }, { n: 4, last_at: '2026-10-18T17:30:00Z' }] };
        throw new Error(`unexpected query: ${s.slice(0, 60)}`);
      },
    };
    const github = {
      async fetchPublicIssues() {
        return {
          // A partial list: the closed-request sweep leaves it alone.
          truncatedList: true,
          issues: [3, 4].map((number) => ({ number, state: 'open', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })),
        };
      },
    };
    await bot.refreshApp(pool, { id: 9, slug: 'papote', repo_url: 'https://github.com/usernode-bot/papote' }, {
      github, settings, bot: { id: 77 }, capRoom: { proposals_per_app: 5, proposals_total: 5, question_tripwire: 3 },
    });
    return { owed: owedOf(events).map((e) => [e.payload.issueNumber, e.payload.reason]), asked };
  };
  const on = await refresh({ settings: { mode: 'live' } });
  assert.deepEqual(on.owed, [[4, 'changed']], 'the request with a plan waiting is not read again; the other is');
  assert.equal(on.asked.length, 1);
  assert.deepEqual(on.asked[0][1], [3], 'only the requests with a plan waiting are read that way');
  assert.equal(on.asked[0][2], require('../src/services/homeroom-bot-holds').mentionPattern());
  assert.equal(on.asked[0][3], 77, 'a Reply to the bot is left out too');
  // With the voice off in requests' discussions nobody answers it there, so it is read as before.
  assert.deepEqual((await refresh({ settings: { mode: 'live', voiceIssue: false } })).owed, [[3, 'changed'], [4, 'changed']]);
  // And so is a refresh that could not tell what was said to whom.
  assert.deepEqual((await refresh({ settings: { mode: 'live' }, unaddressed: 'fails' })).owed, [[3, 'changed'], [4, 'changed']]);
});

test('capRoomFor counts the same two things the live check does', async () => {
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (s === bot.SLOT_HOLDERS_SQL) return { rows: [{ kind: 'build', issue_number: 3 }] };
      if (/FROM chat_sessions\s+WHERE user_id = \$1/.test(s)) return { rows: [{ cnt: 7 }] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: [{ cnt: 12 }] };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  assert.deepEqual(await bot.capRoomFor(pool, { id: 77 }, 9),
    { proposals_per_app: 4, proposals_total: 93, question_tripwire: 0 }, '#3576: the automatic ceiling across every app');
  assert.deepEqual(await bot.capRoomFor(pool, { id: 77 }, 9, { proposalCeiling: 10 }),
    { proposals_per_app: 4, proposals_total: 3, question_tripwire: 0 }, 'an admin\'s ceiling, across them all');
  assert.deepEqual(await bot.capRoomFor(pool, { id: 77 }, 9, { proposalCeiling: 5 }),
    { proposals_per_app: 4, proposals_total: 0, question_tripwire: 0 }, 'never below nothing');
  const tripwire = SRC.slice(SRC.indexOf('async function tripwireCount'), SRC.indexOf('async function capRoomFor'));
  assert.match(tripwire, /AND cap_suppressed IS NULL/,
    'a held question is not a posted one; counting it would let every retry keep the window full');
  const refresh = SRC.slice(SRC.indexOf('async function refreshQueue'), SRC.indexOf('// ── The triage turn'));
  assert.equal((refresh.match(/deps\.bot && live\.isLiveFor\(settings, app\)/g) || []).length, 2,
    'both the full refresh and a refresh of named projects ask for room, and only on a live app');
  // The lane's refresh (bot-lane's bot.refresh) hands both the bot, and its
  // number, which keys what each refresh appends.
  assert.match(SRC, /const refreshDeps = \{ \.\.\.deps, bot, refreshN: n \};/);
  assert.match(SRC, /apps \? await refreshApps\(pool, settings, apps, refreshDeps\) : await refreshQueue\(pool, settings, refreshDeps\)/);
});

test('refreshApp treats a degraded GitHub read as "no answer", not "no issues"', async () => {
  let touched = false;
  const pool = { async query() { touched = true; return { rows: [] }; } };
  const github = { async fetchPublicIssues() { return { issues: [], note: 'rate limited' }; } };
  const out = await bot.refreshApp(pool, { id: 1, slug: 'x', repo_url: 'https://github.com/a/b' }, { github });
  assert.equal(out.skipped, 'github_unavailable');
  assert.equal(touched, false, 'a failed read must not empty the queue');
});

// ── What makes shadow mode shadow (source pins) ─────────────────────────

test('the triage turn is a read-only scout: no build mode, no push, no posting, no claims', () => {
  const dispatch = SRC.slice(SRC.indexOf('async function runTriage'), SRC.indexOf('// ── The work loop'));
  assert.match(dispatch, /mode: 'scout'/, 'the ledger loop runs in scout mode');
  // The container exec carries the token half of the budget between the
  // mode and the prompt now (#2737), and #2870's note on where that limit
  // actually binds sits with it, so the pin allows what sits between.
  // The prompt is rendered at dispatch, for what the turn's model can see.
  assert.match(dispatch, /mode: 'scout',[\s\S]{0,1200}?\n\s*prompt: turnPrompt,/, 'so does the container exec');
  assert.ok(!/mode: 'build'/.test(dispatch), 'never a build turn');
  assert.ok(!/telemetryComponent: 'coding_agent_build'/.test(dispatch));
  for (const forbidden of ['createIssueComment', 'claimIssueForUser', 'sendSystemMessage', 'createNotification', '/promote', 'clone-headless', 'linked_issues = ']) {
    assert.ok(!SRC.includes(forbidden), `shadow mode never reaches ${forbidden}`);
  }
  // The runner blanks the push token in scout mode — the structural half of
  // "nothing is built". (The Codex runner refuses shots turns outright.) The
  // triage runs in the CLI its model is mapped to (#3296), so both runners.
  const runner = read('worker/run-codex-agent.sh');
  assert.match(runner, /if \[ "\$MODE" = "scout" \]; then\s*\n\s*WORKER_JWT=""/);
  assert.match(read('worker/run-cc.sh'), /if \[ "\$MODE" = "scout" \] \|\| \[ "\$MODE" = "shots" \]; then\s*\n\s*WORKER_JWT=""/);
});

test('the bot session is not work on any issue: is_headless FALSE, empty linked_issues, paused at rest', () => {
  const insert = SRC.slice(SRC.indexOf('INSERT INTO chat_sessions'), SRC.indexOf('RETURNING *', SRC.indexOf('INSERT INTO chat_sessions')));
  assert.match(insert, /'paused', FALSE, '\{\}'/);
  // Back to paused after every turn, through the proposal machine (its
  // 'rest' pause), which refuses a session somebody works on.
  const rest = SRC.slice(SRC.indexOf('async function pauseIdleSession'), SRC.indexOf('\n}\n', SRC.indexOf('async function pauseIdleSession')));
  assert.match(rest, /require\('\.\/session-lifecycle'\)\.restSession\(\{ pool, sessionId \}\)/, 'back to paused after every turn');
  assert.match(read('src/services/session-lifecycle.js'),
    /async function restSession[\s\S]*?if \(!now \|\| now\.status !== 'active'\) return false;[\s\S]*?pauseProposal\(\{ sessionId: Number\(sessionId\), reason: 'rest', from: 'active' \}\)/);
  // Defence in depth on the board's two derivations, and the global cap.
  const issues = read('src/routes/issues.js');
  assert.equal((issues.match(/AND u\.is_synthetic IS NOT TRUE/g) || []).length, 2,
    'headless and in_progress derivations both skip synthetic authors');
  // The global cap's one count leaves synthetic sessions out, and every
  // route that starts a session passes the gate that asks it (#2779; the
  // native proposal start once had a copy without the clause, 12 Oct 2026).
  const capClause = "AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)";
  // None: the bot's proposals hold preview pods like anyone's, and the cap is
  // sized from the cluster's pod slots, so every count includes them.
  assert.ok(!require('../src/services/session-caps').GLOBAL_SESSIONS_SQL.includes(capClause),
    'the global-cap count includes synthetic sessions');
  assert.ok(!read('src/services/session-lifecycle.js').includes(capClause));
  assert.equal((read('src/routes/sessions.js').match(/sessionLifecycle\.claimGlobalSlot\(/g) || []).length, 3);
  // The resume is the proposal machine's, which counts the platform-wide cap
  // itself under its lock (its count includes synthetic sessions too).
  assert.match(read('src/routes/sessions.js'), /platform\.resumeProposal\(\{[\s\S]*?caps: cap,/);
  assert.ok(!read('src/workflow/proposal/facts.ts').includes('is_synthetic = TRUE'));
  assert.match(read('src/routes/proposal-handoff.js'), /sessionLifecycle\.claimGlobalSlot\(/);
});

test('the loop runs on the workflow\'s machines, ships off, and its spend joins the shared weekly pool', () => {
  // No timer loop of its own: server.js starts nothing for the bot, and the
  // lane's clock starts with the release's adoptions (the release machine's
  // work), once per release, whichever process runs the workflow.
  const server = read('server.js');
  assert.doesNotMatch(server, /homeroom-bot'\)\.start\(/);
  assert.doesNotMatch(server, /homeroom-bot'\)\.stop\(/);
  assert.equal(bot.start, undefined);
  assert.equal(bot.runOnce, undefined);
  const loops = read('src/workflow/platform.ts');
  const start = loops.slice(loops.indexOf('const ADOPTIONS'), loops.indexOf('// ── The Homeroom bot\'s loop'));
  // No queue rows to adopt: the bot-request machine has been the queue's
  // only writer since #5424, so every row is one an instance holds.
  assert.doesNotMatch(loops, /adoptBotQueue|\['botQueue'/, 'no release adopts the bot\'s queue rows');
  assert.match(start, /\['botLane', \(release: string\) => startLaneClock\(release\)\]/);
  assert.match(start, /await runtime\.append\(BOT_LANE, LANE_KEY, \{ type: 'Tick', payload: \{\} \},\s+\{ requestKey: `boot:\$\{release\}`/, 'and the lane\'s clock starts, once per release');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS homeroom_bot_queue/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS homeroom_bot_runs/);
  assert.match(schema, /\('homeroom_bot_mode', 'off'\)/, 'the setting seeds off');
  assert.match(SRC, /limits\.checkBudget\(pool, bot\.id\)/, 'gated by the weekly cap before every turn');
  assert.match(SRC, /usesIncludedKey\(pool, bot\.id\)/);
  assert.match(SRC, /limits\.recordSpend\(pool, bot\.id/, 'debited into llm_usage like any included-key turn');
  assert.match(read('src/services/llm-telemetry.js'), /'homeroom_bot_triage'/);
});

test('the triage prompt ends with the JSON contract parseVerdict reads', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /"verdict": "question" \| "empty" \| "ready" \| "person"/);
  assert.match(prompt, /"missing_fact"/);
  assert.match(prompt, /do not edit, create, commit or push/i);
  assert.match(prompt, /exactly ONE question/i);
  // #2737. The fourth verdict, and the line that keeps it off a terse but
  // real bug report — the failure mode that would make it unusable.
  assert.match(prompt, /`empty` — there is NOTHING HERE/);
  assert.match(prompt, /NOT whether the request is short/);
  assert.match(prompt, /never an `empty`/);
});

test('the triage prompt decides what is not in the repository instead of searching for it', () => {
  // rss-reader #24, 2026-09-25: "a dark colour closer to the platform's
  // background". The model hunted the app's repository for the platform's
  // colour: 183 reads, over 50 of the same lines of index.html, 15 fresh
  // starts, no words and no verdict, until the 20-minute wall clock. The
  // first fix sent it to ASK instead; since the question bar it DECIDES:
  // the closest value in the app, stated as an assumption in the spec.
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /A value of the Homeroom platform the conventions do not state \(such as the exact colours of its own screens\) is not in anything you can read, so do not search for it: use the closest value you found in the app and say so\./);
  assert.match(prompt, /"darker", "nicer", "like the platform"/);
  assert.match(prompt, /is built with the closest dark colour the app already has, listed as an assumption, not asked about/);
  assert.match(prompt, /If one or two targeted searches for the obvious names do not find it, it is not in the repository: stop searching and decide\./,
    '"the repository can answer it" has a limit');
  assert.match(prompt, /Do not read a file or line range you have already read/);
  assert.match(prompt, /List or search the whole repository at most once/);
  assert.match(prompt, /still unsure after about ten reads, stop reading and decide now/);
  assert.match(prompt, /a turn that ends without the JSON block below has decided nothing/);
});

test('the triage prompt sends platform questions to the conventions tool, not to the repository', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /are served by the `get_platform_conventions` tool: call it with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section\./);
  assert.match(prompt, /That is the same document an app's notes tell an agent to fetch from the Homeroom site: use the tool, do not fetch the site\./,
    'the app\'s notes send an agent to the platform site for this document');
  assert.match(prompt, /A question about the platform is answered there, not in the app's repository: look it up with the tool/);
});

test('the triage prompt credits each answer to the person who wrote it (#5371)', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /Credit what was said to the person named on the comment or message it came from: the person who filed the request is not always the one who answered\./);
});

// ── runTriage with every dependency injected ─────────────────────────────

// The bot session's slot moves go through the proposal machine
// (session-lifecycle's takeSlot and restSession), which no fake pool runs:
// each harness stands in for both and records every move with how many
// turns had run when it was made.
const sessionLifecycle = require('../src/services/session-lifecycle');

function triageHarness({ verdictText, routed = null, budgetError = null, sessionId = 501, result = null } = {}) {
  const calls = { queries: [], exec: [], spend: [], ensured: [], moves: [] };
  sessionLifecycle.takeSlot = async ({ sessionId: id }) => { calls.moves.push(['takeSlot', id, calls.exec.length]); return true; };
  sessionLifecycle.restSession = async ({ sessionId: id }) => { calls.moves.push(['restSession', id, calls.exec.length]); return true; };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: sessionId, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash' }] };
      }
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/COUNT\(\*\)::int AS cnt FROM chat_sessions/.test(s)) return { rows: [{ cnt: 0 }] };
      if (/COUNT\(\*\)::int AS cnt FROM homeroom_bot_runs/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift on zoom.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, opts }); return `usernode-worker-${sessionId}`; },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return result || { lastResultText: verdictText, inputTokens: 1000, outputTokens: 50 }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return { openrouterApiKey: 'k', agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash' }; } },
    limits: {
      async checkBudget() { return budgetError ? { error: budgetError, reason: 'weekly_limit' } : { ok: true }; },
      async recordSpend(_pool, userId, cents, opts) { calls.spend.push({ userId, cents, opts }); },
    },
    threadContext: { async loadIssueThread() { return { messages: [{ author: 'pat', body: 'It is the route map.', createdAt: '2026-09-20T00:00:00Z' }] }; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    sessions: {
      buildHeadlessSeed: (n, issue) => `Please work on GitHub issue #${n}: "${issue.title}".`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent, resumeThreadId }) {
        calls.loop = { mode, telemetryComponent, resumeThreadId };
        if (routed) return routed;
        const result = await dispatchOnce({ openrouterApiKey: 'k', turnUuid: 't1', logicalTurnId: 'l1', attemptNumber: 1 });
        return { result, error: null, logicalTurnId: 'l1', estimatedCostUsd: 0.0123 };
      },
    },
  };
  return { pool, deps, calls };
}

// A read runs inside its look (bot-request's `bot.look`, homeroom-bot.js
// lookAt): runTriage claims, updates and deletes no queue row, and records
// instead on the look what its end does with its request's debt
// (`out.queue`: consume, fault, held, requeue or busy) and the conversation
// its next read may continue (`out.lastRead`). The look here has no durable
// steps, as a look outside a machine's work has none.
function newLook(opts = {}) {
  return bot._newLookForTests({ steps: durableSteps.none(), ...opts });
}
async function triageInLook(pool, args, lookOpts = {}) {
  const look = newLook(lookOpts);
  const out = await bot._runInLookForTests(look, () => bot.runTriage(pool, {}, args));
  return { out, look };
}

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-20T00:00:00Z' };
const BOT = { id: 77, username: 'homeroom_bot' };

test('runTriage: one scout turn, a fresh thread, a recorded verdict, a debited cost, a consumed debt', async () => {
  const { pool, deps, calls } = triageHarness({
    verdictText: 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```',
  });
  const { out, look } = await triageInLook(pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict, runId: out.runId }, { ran: true, verdict: 'question', runId: 900 });
  assert.equal(calls.loop.mode, 'scout');
  assert.equal(calls.loop.resumeThreadId, null,
    'the argument only: whether the thread is fresh is tested through the platform\'s reading of null (#3035)');
  assert.equal(calls.loop.telemetryComponent, 'homeroom_bot_triage');
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.exec[0].opts.mode, 'scout');
  assert.match(calls.exec[0].opts.prompt, /Please work on GitHub issue #12/);
  assert.match(calls.exec[0].opts.prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block/);
  assert.equal(calls.exec[0].opts.resumeSessionId, null);
  assert.equal(calls.ensured[0].opts.branchName, 'main');
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 1.23, opts: { byok: false } }], 'included-key spend joins the weekly pool');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'question');
  assert.equal(insert.params[7], 'Which screen?');
  assert.equal(insert.params[8], 'Route map');
  assert.equal(insert.params[14], 0.0123);
  assert.equal(look.out.queue, 'consume', 'the verdict consumes its request\'s debt');
  assert.ok(!calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)),
    'the lane granted the look, so nothing here claims, updates or deletes a queue row');
  // Through the proposal machine: the slot taken before the turn, given
  // back after it.
  assert.deepEqual(calls.moves, [['takeSlot', 501, 0], ['restSession', 501, 1]], 'active only while the turn runs');
});

test('runTriage: an issue carrying the bot\'s own GitHub comment triages instead of throwing', async () => {
  // github.getBotUsername() is async. Passed unawaited, the Promise reached
  // the real seed, and tagging a GitHub comment threw "botUsername.toLowerCase
  // is not a function". A live run posts its "looking" comment on GitHub
  // before it triages, so every live run died there (rss-reader #24).
  const { pool, deps, calls } = triageHarness({
    verdictText: '```json\n{"verdict":"question","determined":false,"missing_fact":"which colour","question":"Which dark colour?","default":"The platform background"}\n```',
  });
  deps.sessions.buildHeadlessSeed = require('../src/routes/sessions').buildHeadlessSeed;
  deps.github.getBotUsername = async () => 'usernode-bot';
  deps.github.fetchIssueComments = async () => ({ comments: [
    { author: 'usernode-bot', body: 'Homeroom bot is looking at this request.', createdAt: '2026-09-25T19:53:03Z' },
    { author: 'alice', body: 'Darker, like the platform.', createdAt: '2026-09-25T19:54:00Z' },
  ] });
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'question' });
  const prompt = calls.exec[0].opts.prompt;
  assert.match(prompt, /\[bot — earlier proposal questions, 2026-09-25, github\] Homeroom bot is looking at this request\./,
    'its own comment is recognised as the bot\'s');
  assert.match(prompt, /\[alice, 2026-09-25, github\] Darker, like the platform\./, 'a person\'s comment is not');
});

test('runTriage: the request comes first; the platform reference follows, small, with the conventions a tool call away (#24)', async () => {
  // Put first and inline (#3161), 150 KB of conventions buried the task on
  // rss-reader #24 (2026-09-26): once the model took the whole message for a
  // conventions document; once every request carried 50k tokens, the context
  // crossed the compaction limit after 86 reads, and the model's own summary
  // lost the task. The reference now follows the request, fenced, and names
  // the tool that serves the conventions a section at a time.
  const { pool, deps, calls } = triageHarness({
    verdictText: '```json\n{"verdict":"ready","determined":true,"missing_fact":"none","build_note":"x"}\n```',
  });
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  const prompt = calls.exec[0].opts.prompt;
  const at = (re) => prompt.search(re);
  const order = [
    /^Please work on GitHub issue #12/,
    /You are the Homeroom bot, triaging ONE request/,
    /"verdict": "question" \| "empty" \| "ready" \| "person",\n/,
    /==== PLATFORM REFERENCE \(for looking things up; not the request\) ====/,
    /Call `get_platform_conventions` with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section\./,
    /==== UI DESIGN/,
    /you read text, not images/,
    /==== END UI DESIGN ====/,
    /==== END PLATFORM REFERENCE ====/,
    /That is the end of the reference\. Now answer the triage request above, for issue #12/,
  ].map((re) => [re, at(re)]);
  for (const [re, where] of order) assert.ok(where >= 0, `present: ${re}`);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} before ${order[i][0]}`);
  }
  assert.match(prompt, /nothing in this reference is a task\./);
  assert.doesNotMatch(prompt, /==== PLATFORM CONVENTIONS \(authoritative\) ====/, 'the conventions are not inline');
  // #4488 added the four tests for a `complicated` change (about 860
  // characters), which the work order asked to be in this prompt. `done`
  // (about 120 more) lets a request that is already there be offered for
  // closing instead of left at "a person decides". Newcomer run six (14 Oct
  // 2026): the UI design guidance's line on forms on a phone (about 335
  // characters), which every build reads, rides in the reference too. #5224:
  // the plan lines' rule (about 330 more), so the plan card's lines stay
  // short and one point each. 16 Oct 2026: `builder` (about 280 more), so a
  // request that names who builds it does not ring its requester. #5117:
  // the platform's data rules (about 1,600 more) ride beside the content
  // rules, so a request whose point breaks them goes to a person.
  assert.ok(prompt.length < 24000, `a triage prompt stays small: ${prompt.length} chars`);
  // The last thing the model reads is the one format parseVerdict accepts.
  assert.match(prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format, and nothing after it:\n\{"verdict": "question" \| "empty" \| "ready" \| "person", "determined": true \| false, "missing_fact": "\.\.\.", "question": "\.\.\.", "default": "\.\.\.", "build_note": "\.\.\.", "reason": "\.\.\."\}$/);
});

test('the bot\'s GitHub login resolves to a string, or to null when it cannot be read', async () => {
  assert.equal(await live.botUsernameOf({ getBotUsername: async () => 'usernode-bot' }), 'usernode-bot');
  assert.equal(await live.botUsernameOf({ getBotUsername: () => 'usernode-bot' }), 'usernode-bot');
  assert.equal(await live.botUsernameOf({ getBotUsername: async () => { throw new Error('no installation'); } }), null);
  assert.equal(await live.botUsernameOf({ getBotUsername: () => { throw new Error('no installation'); } }), null);
  assert.equal(await live.botUsernameOf({}), null);
  assert.doesNotMatch(read('src/services/homeroom-bot.js'), /github\.getBotUsername\(\)/,
    'every read goes through botUsernameOf, which awaits it');
  assert.doesNotMatch(read('src/services/homeroom-bot-live.js'), /String\(github\.getBotUsername/);
});

test('runTriage: an unusable reply is a failed run that consumes the debt; the weekly cap leaves it alone', async () => {
  const bad = triageHarness({ verdictText: 'I could not decide.' });
  const { out, look } = await triageInLook(bad.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: bad.deps });
  assert.equal(out.verdict, 'failed');
  const insert = bad.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'failed');
  assert.match(insert.params[18], /unparseable/);
  assert.equal(look.out.queue, 'consume', 'not retried until the thread changes');
  assert.equal(bad.calls.exec.length, 1, 'with no thread to resume, nothing is asked again');

  const capped = triageHarness({ verdictText: 'x', budgetError: 'Weekly limit reached' });
  const { out: paused, look: cappedLook } = await triageInLook(capped.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: capped.deps });
  assert.deepEqual({ ran: paused.ran, reason: paused.reason }, { ran: false, reason: 'budget' });
  assert.equal(capped.calls.exec.length, 0, 'no turn is dispatched over the cap');
  assert.equal(cappedLook.out.queue, null, 'the debt is left as it was (the lane pauses on the budget)');
  assert.ok(!capped.calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)), 'the queue is left alone');
});

test('runTriage: the run records the newest thing it read, not the batch\'s figure', async () => {
  const { pool, deps, calls } = triageHarness({ verdictText: '```json\n{"verdict":"person","determined":true,"reason":"Auth."}\n```', sessionId: 962 });
  const order = [];
  const query = pool.query;
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (/SELECT MAX\(m\.created_at\) AS last_at/.test(s)) {
      order.push('person');
      return { rows: [{ last_at: new Date('2026-09-22T10:00:00Z') }] };
    }
    return query(sql, params);
  };
  deps.github.fetchPublicIssue = async () => ({ issue: { number: 12, title: 'Pins drift', body: 'They drift.', state: 'open', updatedAt: '2026-09-22T09:00:00Z', createdAt: '2026-09-01T00:00:00Z' } });
  deps.threadContext.loadIssueThread = async () => { order.push('thread'); return { messages: [] }; };
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual(order, ['person', 'thread'], 'the last word is read before the thread, so the thread holds it');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(new Date(insert.params[12]).toISOString(), '2026-09-22T10:00:00.000Z',
    'newer than what its debt was owed with (09-20) and the issue (09-22 09:00)');
});

// The triage reply, then the reply to the one turn that asks for its block.
function repairHarness(sessionId, replies, costs = [0.02, 0.005]) {
  const h = triageHarness({ verdictText: 'unused', sessionId });
  h.loops = [];
  h.deps.worker.execInWorker = async (id, opts) => {
    h.calls.exec.push({ id, opts });
    return replies[h.calls.exec.length - 1];
  };
  h.deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce, resumeThreadId }) => {
    h.loops.push({ resumeThreadId });
    const result = await dispatchOnce({ openrouterApiKey: 'k', resumeThreadId, resumeSessionId: resumeThreadId });
    return { result, error: null, estimatedCostUsd: costs[h.loops.length - 1] };
  };
  return h;
}

const WORDS_ONLY = { lastResultText: 'Small and bounded, no schema, so it can be built now. Verdict below.', agentThreadId: 'thr-1', inputTokens: 1000, outputTokens: 50 };

test('runTriage: a reply that decided in words is asked once, on its own thread, for the block', async () => {
  const h = repairHarness(951, [WORDS_ONLY, {
    lastResultText: '```json\n{"verdict":"person","determined":true,"reason":"Changes the login flow."}\n```',
    agentThreadId: 'thr-1', inputTokens: 1200, outputTokens: 30,
  }]);
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'person' });
  assert.deepEqual(h.loops, [{ resumeThreadId: null }, { resumeThreadId: 'thr-1' }],
    'a fresh thread for the triage, then that same thread resumed');
  assert.match(h.calls.exec[1].opts.prompt, /Reply now with ONLY that one fenced ```json block/);
  assert.equal(h.calls.exec[1].opts.resumeSessionId, 'thr-1');
  assert.equal(h.calls.exec[1].opts.mode, 'scout');
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'person');
  assert.equal(insert.params[10], 'Changes the login flow.');
  assert.ok(Math.abs(insert.params[14] - 0.025) < 1e-9, 'the row costs both turns');
  assert.deepEqual([insert.params[15], insert.params[16]], [2200, 80], 'and carries both turns\' tokens');
  assert.deepEqual(h.calls.spend.map((s) => s.cents), [2, 0.5], 'each turn joins the weekly pool');
  assert.deepEqual(h.calls.moves, [['takeSlot', 951, 0], ['restSession', 951, 1], ['takeSlot', 951, 1], ['restSession', 951, 2]],
    'active only while each turn runs');
  assert.equal(look.out.queue, 'consume', 'the debt is consumed by the verdict');
});

test('runTriage: a reply still without its block after the one ask fails as it always did', async () => {
  const h = repairHarness(952, [WORDS_ONLY, { lastResultText: 'It is fine to build.', agentThreadId: 'thr-1', inputTokens: 900, outputTokens: 10 }]);
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.exec.length, 2, 'asked once, never twice');
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.params[18], /^unparseable: Small and bounded/, 'the triage reply, not the ask\'s, is what the row shows');
  assert.ok(Math.abs(insert.params[14] - 0.025) < 1e-9, 'and it costs both turns');
  assert.ok(h.calls.queries.some((q) => /homeroom_bot_run_snapshots/.test(q.s)), 'still a benchmark case: a better model writes its block');
  assert.equal(look.out.queue, 'consume', 'a model failure consumes the debt');
});

test('runTriage: an unreadable reply is kept on its run, with the reply to the ask, while its error stays one short line', async () => {
  const long = `${'Reading the request. '.repeat(1500)}Verdict below.`;
  const h = repairHarness(955, [{ ...WORDS_ONLY, lastResultText: long }, { lastResultText: 'It is fine to build.', agentThreadId: 'thr-1' }]);
  const out = await bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.equal(out.verdict, 'failed');
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params[18].length <= 320, 'the error is one short line');
  const kept = h.calls.queries.find((q) => /SET unreadable_reply = \$2/.test(q.s));
  assert.ok(kept, 'the reply is stored beside the row');
  assert.equal(kept.params[0], 900);
  const stored = JSON.parse(kept.params[1]);
  assert.equal(stored.reply.chars, long.length);
  assert.ok(stored.reply.text.startsWith('Reading the request. '), 'its start');
  assert.ok(stored.reply.text.endsWith('Verdict below.'), 'and its end');
  assert.match(stored.reply.text, /\[… \d+ characters left out …\]/);
  assert.deepEqual(stored.repair, { text: 'It is fine to build.', chars: 20 }, 'and what the ask got back');
});

test('keptReply keeps a short reply whole and a long one as its first 4 KB and last 12 KB', () => {
  assert.equal(bot.keptReply(''), null);
  assert.equal(bot.keptReply('  \n'), null);
  assert.deepEqual(bot.keptReply('No block.'), { text: 'No block.', chars: 9 });
  const text = `${'a'.repeat(4096)}${'m'.repeat(5000)}${'z'.repeat(12 * 1024)}`;
  const kept = bot.keptReply(text);
  assert.equal(kept.chars, text.length);
  assert.equal(kept.text, `${'a'.repeat(4096)}\n\n[… 5000 characters left out …]\n\n${'z'.repeat(12 * 1024)}`);
  assert.equal(bot.unreadableReplyOf('', null), null, 'nothing to keep, nothing stored');
  assert.deepEqual(bot.unreadableReplyOf('x', null), { reply: { text: 'x', chars: 1 }, repair: null });
});

test('seedStagingUnreadableReply: staging only, once, a fake failed run with its kept reply', async () => {
  const queries = [];
  let have = false;
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT 1 FROM homeroom_bot_runs WHERE issue_number/.test(sql)) return { rows: have ? [{}] : [] };
    if (/FROM apps WHERE status = 'running'/.test(sql)) return { rows: [{ id: 7 }] };
    if (/INSERT INTO homeroom_bot_runs/.test(sql)) return { rows: [{ id: 41 }] };
    return { rows: [] };
  } };
  const env = process.env.USERNODE_ENV;
  try {
    delete process.env.USERNODE_ENV;
    assert.equal(await bot.seedStagingUnreadableReply(pool), false);
    assert.equal(queries.length, 0, 'nothing outside staging');
    process.env.USERNODE_ENV = 'staging';
    assert.equal(await bot.seedStagingUnreadableReply(pool), true);
    const insert = queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.sql));
    assert.match(insert.params[2], /^unparseable: /);
    const kept = JSON.parse(queries.find((q) => /SET unreadable_reply/.test(q.sql)).params[1]);
    assert.match(kept.reply.text, /^Staging demo:/);
    assert.match(kept.repair.text, /^Staging demo:/);
    have = true;
    queries.length = 0;
    assert.equal(await bot.seedStagingUnreadableReply(pool), false, 'seeded once');
    assert.ok(!queries.some((q) => /INSERT/.test(q.sql)));
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

test('runTriage: a thread the runtime will not resume is never asked on a fresh one', async () => {
  const h = repairHarness(954, [WORDS_ONLY, { lastResultText: '```json\n{"verdict":"ready","determined":true,"build_note":"Invented."}\n```' }]);
  h.deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce, resumeThreadId }) => {
    h.loops.push({ resumeThreadId });
    // The runtime dropped the thread (resolveCodexRuntimeContext's
    // resumeThreadDropped), so the attempt would start fresh.
    try {
      const result = await dispatchOnce({ openrouterApiKey: 'k', resumeThreadId: null, resumeSessionId: null });
      return { result, error: null, estimatedCostUsd: 0.01 };
    } catch (err) {
      return { result: null, error: err, estimatedCostUsd: null };
    }
  };
  const out = await bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.equal(out.verdict, 'failed', 'no verdict made up on a thread that never read the request');
  assert.equal(h.loops.length, 2);
  assert.equal(h.calls.exec.length, 1, 'the ask is never dispatched');
});

// ── A read started over, and a read continued ─────────────────────────────

const PERSON_REPLY = '```json\n{"verdict":"person","determined":true,"reason":"Changes the login flow."}\n```';

test('runTriage: a person writing mid-read ends the read with what it spent, for its instance to read again', async () => {
  // The request's instance heard the message while the turn ran (bot-request
  // Activity, kept on the look): what this read found answers the request as
  // it was, so it writes no run and hands back what it spent.
  const h = repairHarness(971, [{ lastResultText: PERSON_REPLY, agentThreadId: 'thr-1', inputTokens: 4000, outputTokens: 20 }], [0.03]);
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps },
    { readInterrupted: async () => true });
  assert.deepEqual(out, { ran: false, reason: 'interrupted', carried: { costUsd: 0.03, inputTokens: 4000, outputTokens: 20 } });
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no row for the read that is started over');
  assert.deepEqual(h.calls.spend.map((x) => x.cents), [3], 'what it spent is debited once, now');
  assert.equal(look.out.queue, null, 'its instance reads it again; the look decides nothing of its debt');
  assert.equal(look.out.lastRead, undefined, 'and its conversation is not kept: it answered nothing');
  // The instance starts that read at once, as `read_again` (not announced
  // twice, and never started over again), carrying what this one spent.
  const machine = read('src/workflow/bot-request/machine.ts');
  assert.match(machine, /if \(outcome === 'interrupted'\) \{[\s\S]*?owed: \{ \.\.\.lk\.owed, reason: READ_AGAIN_REASON \}[\s\S]*?carried: \(r\.carried as Json\) \?\? null/);
});

test('runTriage: the read started over is one row that carries what the first read spent, and is never started over again', async () => {
  const h = repairHarness(972, [{ lastResultText: PERSON_REPLY, agentThreadId: 'thr-2', inputTokens: 1000, outputTokens: 40 }], [0.01]);
  const { out, look } = await triageInLook(h.pool, {
    bot: BOT, app: APP, item: { ...ITEM, reason: bot.READ_AGAIN_REASON }, mode: 'shadow', deps: h.deps,
    carried: { costUsd: 0.03, inputTokens: 4000, outputTokens: 0 },
  }, { readInterrupted: async () => true });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'person' }, 'a second message does not send it back');
  const inserts = h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(inserts.length, 1);
  assert.ok(Math.abs(inserts[0].params[14] - 0.04) < 1e-9, 'the one row carries what the stopped read spent');
  assert.deepEqual([inserts[0].params[15], inserts[0].params[16]], [5000, 40]);
  assert.deepEqual(h.calls.spend.map((x) => x.cents), [1], 'the carried spend was debited by the read that spent it');
  assert.equal(look.out.queue, 'consume');
});

test('runTriage: a read started over that comes back empty is recorded as empty, not as collateral', async () => {
  const h = repairHarness(976, [
    { lastResultText: '', resultSubtype: 'error_during_execution', agentError: 'provider hung up', inputTokens: 900, outputTokens: 0 },
  ], [0.01]);
  const { out, look } = await triageInLook(h.pool, {
    bot: BOT, app: APP, item: { ...ITEM, reason: bot.READ_AGAIN_REASON }, mode: 'shadow', deps: h.deps,
    carried: { costUsd: 0.03, inputTokens: 4000, outputTokens: 0 },
  });
  assert.equal(out.verdict, 'failed');
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.params[18], /^unparseable: \(empty reply\) .*provider hung up/,
    'the first read\'s stop does not explain this reply');
  assert.equal(look.out.queue, 'consume', 'a model failure consumes the debt');
});

test('a read is sent back only by a message or an edit, and is not announced twice', () => {
  const note = SRC.slice(SRC.indexOf('const INTERRUPTING_ACTIVITY'), SRC.indexOf('async function noteProposalActivity('));
  assert.match(note, /new Set\(\['thread', 'updated'\]\)/, 'only these are Activity on the request');
  assert.match(SRC, /\|\| item\.reason === RETRY_FAILED_REASON \|\| item\.reason === READ_AGAIN_REASON \? null : await live\.post\(\{/,
    'a read started over is not announced twice');
  assert.match(SRC, /item\.reason !== APP_AGAIN_REASON && item\.reason !== READ_AGAIN_REASON\n\s+&& item\.reason !== BACKLOG_REASON\) \{\n\s+await activity\(\)\.startCard/,
    'and its card is not started twice');
  assert.ok(bot.SELF_QUEUED_REASONS.includes(bot.READ_AGAIN_REASON), 'a refresh keeps its debt and its reason');
});

test('runTriage: reading a request again continues the conversation it was read in', async () => {
  const h = repairHarness(973, [
    { lastResultText: PERSON_REPLY, agentThreadId: 'thr-A', inputTokens: 900000, outputTokens: 900 },
    { lastResultText: PERSON_REPLY, agentThreadId: 'thr-A', inputTokens: 30000, outputTokens: 200 },
  ], [0.2, 0.01]);
  const first = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.equal(first.look.out.lastRead.threadId, 'thr-A', 'the instance keeps the conversation the verdict was reached in');
  assert.equal(first.look.out.lastRead.continued, 0);
  // The instance hands its next look what it kept (bot-request `lastRead`).
  const again = await triageInLook(h.pool, { bot: BOT, app: APP, item: { ...ITEM, reason: 'changed' }, mode: 'shadow', deps: h.deps },
    { lastRead: first.look.out.lastRead });
  assert.deepEqual(h.loops, [{ resumeThreadId: null }, { resumeThreadId: 'thr-A' }]);
  assert.match(h.calls.exec[0].opts.prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format/, 'the first read gets the whole prompt');
  const prompt = h.calls.exec[1].opts.prompt;
  assert.match(prompt, /==== REQUEST #12 HAS CHANGED SINCE YOU READ IT ====/);
  assert.match(prompt, /Please work on GitHub issue #12/, 'with the request as it stands now, in full');
  assert.match(prompt, /do not repeat reads you made before/);
  assert.match(prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block in the same format as before, for issue #12/);
  assert.ok(!/YOUR ONLY JOB is to decide/.test(prompt), 'not the instructions again: they are earlier in the conversation');
  assert.equal(h.calls.exec[1].opts.resumeSessionId, 'thr-A');
  assert.equal(again.look.out.lastRead.continued, 1, 'one more continued read of the same conversation');
});

test('runTriage: a conversation the worker no longer has is read afresh, in the same read', async () => {
  const h = repairHarness(974, [
    { lastResultText: '', agentRetryFresh: true },
    { lastResultText: PERSON_REPLY, agentThreadId: 'thr-C', inputTokens: 800000, outputTokens: 700 },
  ], [0.001, 0.2]);
  // What the request's instance kept from its last read, under the model
  // this read resolves (the triage stage's).
  const lastRead = { threadId: 'thr-B', model: bot.stageModel(null, {}, 'triage'), continued: 0, at: new Date().toISOString() };
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: { ...ITEM, reason: 'changed' }, mode: 'shadow', deps: h.deps },
    { lastRead });
  assert.equal(out.verdict, 'person');
  assert.deepEqual(h.loops, [{ resumeThreadId: 'thr-B' }, { resumeThreadId: null }]);
  assert.match(h.calls.exec[1].opts.prompt, /YOUR ONLY JOB is to decide/, 'the fresh read gets the whole prompt');
  const inserts = h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(inserts.length, 1, 'one row for the read');
  assert.ok(Math.abs(inserts[0].params[14] - 0.201) < 1e-9, 'which costs both of its turns');
  assert.deepEqual([look.out.lastRead.threadId, look.out.lastRead.continued], ['thr-C', 0], 'the fresh conversation is kept, uncontinued');
});

test('runTriage: with continuing switched off, every read is fresh', async () => {
  const h = repairHarness(975, [
    { lastResultText: PERSON_REPLY, agentThreadId: 'thr-D' },
    { lastResultText: PERSON_REPLY, agentThreadId: 'thr-E' },
  ]);
  const settings = { continueReads: false };
  const first = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings, deps: h.deps });
  await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings, deps: h.deps },
    { lastRead: first.look.out.lastRead });
  assert.ok(first.look.out.lastRead, 'a conversation was there to continue');
  assert.deepEqual(h.loops, [{ resumeThreadId: null }, { resumeThreadId: null }]);
});

test('previousReadOf: a conversation is continued once per read, never past a day, a third time or another model', () => {
  const t0 = Date.parse('2026-10-06T00:00:00Z');
  const kept = bot.rememberedRead({ threadId: 'thr-1', model: 'm', continued: 1, now: t0 });
  assert.deepEqual(kept, { threadId: 'thr-1', model: 'm', continued: 1, at: '2026-10-06T00:00:00.000Z' });
  assert.equal(bot.previousReadOf(kept, { model: 'other', now: t0 }), null, 'another model reads afresh');
  assert.equal(bot.previousReadOf(kept, { model: 'm', now: t0 + 60_000 })?.threadId, 'thr-1');
  const third = bot.rememberedRead({ threadId: 'thr-1', model: 'm', continued: bot.MAX_CONTINUED_READS, now: t0 });
  assert.equal(bot.previousReadOf(third, { model: 'm', now: t0 }), null, 'a fresh read after the third continued one');
  assert.equal(bot.previousReadOf(kept, { model: 'm', now: t0 + bot.CONTINUE_READ_MAX_AGE_MS + 1 }), null, 'or a day on');
  assert.equal(bot.rememberedRead({ threadId: null, model: 'm', now: t0 }), null, 'a read with no conversation leaves none');
  assert.equal(bot.previousReadOf(null, { model: 'm', now: t0 }), null);
});

test('the continueReads setting is on by default, stored as on or off, and validated', () => {
  assert.equal(bot.parseSettings([]).continueReads, true);
  assert.equal(bot.parseSettings([{ key: bot.KEY_CONTINUE_READS, value: 'off' }]).continueReads, false);
  assert.deepEqual(bot.validateSettingsPatch({ continueReads: false }).updates, [[bot.KEY_CONTINUE_READS, 'off']]);
  assert.equal(bot.validateSettingsPatch({ continueReads: 'no' }).ok, false);
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /id="admin-homeroom-bot-continue-reads" type="checkbox"/, 'an admin can switch it off in the console');
  assert.match(ui, /key === 'continueReads'/, 'and the console saves it');
});

// One the request will always get must not keep the lane pausing for ever:
// it is recorded as a failed read (which the refresh counts toward
// FAILED_TRIAGE_TRIES), its debt spent, and the lane pauses all the same.
test('runTriage: a reply that is the provider\'s API error is a platform fault, not the model\'s', async () => {
  const { pool, deps, calls } = triageHarness({
    sessionId: 953,
    result: {
      lastResultText: 'API Error: 400 messages[6]: tool messages must include a non-empty string tool_call_id',
      agentThreadId: 'thr-1', inputTokens: 3000, outputTokens: 20,
    },
  });
  const { out, look } = await triageInLook(pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'failed' });
  assert.equal(calls.exec.length, 1, 'a thread that died on the wire is not asked for a block');
  assert.equal(look.out.queue, 'consume', 'its debt is spent');
  assert.equal(look.out.laneFault, true, 'the lane pauses');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params.some((v) => /^provider: API Error: 400 messages\[6\]/.test(String(v))), 'a failed read the refresh counts');
  assert.deepEqual(calls.spend.map((x) => x.cents), [1.23], 'what it cost is still debited');
  assert.ok(!calls.queries.some((q) => /homeroom_bot_run_snapshots/.test(q.s)), 'and it is no benchmark case');
});

// A read whose reply was unusable is no conversation to continue: the next
// read of the request starts a fresh one (as previousRead's take did).
test('runTriage: a failed read leaves no conversation for the next read to continue', async () => {
  const h = triageHarness({ sessionId: 960, result: { lastResultText: 'no block here', agentThreadId: 'thr-9' } });
  h.deps.askForVerdictBlock = async () => ({ text: null });
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.equal(out.verdict, 'failed');
  assert.equal(look.out.lastRead, null);
});

test('runTriage: a platform fault keeps its request\'s debt and writes no run', async () => {
  const h = triageHarness({ routed: { error: 'credential_required', logicalTurnId: 'l1' } });
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.deepEqual({ ran: out.ran, reason: out.reason, detail: out.detail }, { ran: false, reason: 'infra', detail: 'credential_required' });
  assert.equal(look.out.queue, 'fault');
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs|homeroom_bot_queue/.test(q.s)));
});

test('runTriage: a request\'s third platform fault in a row is recorded as a failed read, so it is not owed for ever', async () => {
  const h = triageHarness({ routed: { error: 'credential_required', logicalTurnId: 'l1' } });
  const { out, look } = await triageInLook(h.pool, { bot: BOT, app: APP, item: { ...ITEM, faults: 2 }, mode: 'shadow', deps: h.deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'failed' });
  assert.equal(look.out.queue, 'consume');
  assert.equal(look.out.laneFault, true);
  assert.ok(h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)));
  assert.ok(!h.calls.queries.some((q) => /homeroom_bot_run_snapshots/.test(q.s)), 'no benchmark case');
});

// ── Live on one app (#3146) ──────────────────────────────────────────────

test('runTriage on a live app: announces the first look, posts the question, records a live run', async () => {
  const { pool, deps, calls } = triageHarness({
    sessionId: 920,
    verdictText: 'Read the feed code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which feed","question":"Which feed?","default":"All of them"}\n```',
  });
  const posts = [];
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO homeroom_bot_posts/.test(String(sql))) { posts.push(params[3]); return { rows: [{ id: posts.length }] }; }
    return realQuery(sql, params);
  };
  const comments = [];
  deps.github.createIssueComment = async (owner, repo, n, body) => {
    comments.push(body);
    return { id: comments.length, created_at: new Date(Date.now() + 1000).toISOString() };
  };
  const thread = [];
  deps.ws = { async sendSystemMessage(_p, appId, content, msgType, metadata, scope) { thread.push({ content, msgType, scope }); return { id: thread.length }; } };
  deps.sessionLifecycle = {};
  deps.domain = 'app.onhomeroom.com';
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
    // The bot's voice off in requests' discussions: the fixed notes it had.
    settings: { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000, voiceIssue: false },
  });
  assert.equal(out.verdict, 'question');
  assert.equal(out.acted, 'question');
  assert.deepEqual(posts, ['looking', 'question'], 'the first look, then the verdict');
  assert.match(comments[0], /Homeroom bot is looking at this request/);
  assert.match(comments[1], /Which feed\?/);
  assert.ok(thread.every((m) => m.msgType === 'system' && m.scope.type === 'issue' && m.scope.ref === 12));
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[3], 'live', 'the ledger says which runs spoke');
  assert.ok(calls.queries.some((q) => /UPDATE homeroom_bot_runs\s+SET thread_seen_at = GREATEST/.test(q.s)),
    'and what it has seen moves past its own comments');
});

// A read resumed after a restart (its look's work carried on from its last
// saved step) acts on what the first attempt decided: what changed since,
// often because of the look itself (its run's cost, its debit, a reply to
// its own question), does not close, hold or restart a read whose turn
// already ran, nor say anything twice (PR #5424 review).
test('a live read resumed after its run was recorded still says its verdict, once, whatever changed during the restart', async () => {
  const { StepsStopped } = require('../src/workflow/kernel/steps.ts');
  const { pool, deps, calls } = triageHarness({
    sessionId: 921,
    verdictText: 'Read the feed code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which feed","question":"Which feed?","default":"All of them"}\n```',
  });
  const posts = [];
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO homeroom_bot_posts/.test(String(sql))) { posts.push(params[3]); return { rows: [{ id: posts.length }] }; }
    return realQuery(sql, params);
  };
  deps.github.createIssueComment = async () => ({ id: 1, created_at: new Date(Date.now() + 1000).toISOString() });
  deps.ws = { async sendSystemMessage() { return { id: 1 }; } };
  deps.sessionLifecycle = {};
  deps.domain = 'app.onhomeroom.com';
  deps.worker.finishTurn = async () => true;
  let saved = null;
  let crashed = false;
  let restarted = false;
  const attempt = (from) => {
    const steps = durableSteps.durable({
      resumeFrom: from,
      checkpoint: async (v) => {
        saved = v;
        if (!crashed && Object.prototype.hasOwnProperty.call(v, 'run:1')) { crashed = true; throw new StepsStopped('the process was replaced'); }
      },
    });
    const look = newLook({ steps, n: 1, key: 'request:9:12', readInterrupted: async () => restarted });
    return bot._runInLookForTests(look, () => bot.runTriage(pool, {}, {
      bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
      settings: { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000, voiceIssue: false },
    }));
  };
  await assert.rejects(attempt(null), (err) => err.stopped === true);
  assert.ok(crashed, 'the first attempt recorded its run');
  // During the restart: the request closed, the bot's week spent (its own
  // debit), a person answering on the request.
  restarted = true;
  deps.github.fetchPublicIssue = async () => ({ issue: { number: 12, title: 'Pins drift', body: 'They drift on zoom.', state: 'closed' } });
  deps.limits.checkBudget = async () => ({ error: 'Weekly limit reached', reason: 'weekly_limit' });
  const out = await attempt(saved);
  assert.equal(out.verdict, 'question', 'the read it recorded, acted on');
  assert.deepEqual(posts, ['looking', 'question'], 'its first look said once, then its verdict');
  assert.equal(calls.exec.length, 1, 'one turn');
  assert.equal(calls.queries.filter((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)).length, 1, 'one run');
});

test('with the bot\'s voice on in requests\' discussions, a first look is recorded but not announced', async () => {
  const { pool, deps } = triageHarness({
    sessionId: 922,
    verdictText: 'Read the feed code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which feed","question":"Which feed?","default":"All of them"}\n```',
  });
  const posts = [];
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO homeroom_bot_posts/.test(String(sql))) { posts.push(params[3]); return { rows: [{ id: posts.length }] }; }
    return realQuery(sql, params);
  };
  const comments = [];
  deps.github.createIssueComment = async (owner, repo, n, body) => {
    comments.push(body);
    return { id: comments.length, created_at: new Date(Date.now() + 1000).toISOString() };
  };
  const thread = [];
  deps.ws = { async sendSystemMessage(_p, appId, content) { thread.push(content); return { id: thread.length }; } };
  deps.sessionLifecycle = {};
  deps.domain = 'app.onhomeroom.com';
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
    settings: { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 },
  });
  assert.equal(out.verdict, 'question');
  assert.deepEqual(posts, ['looking', 'question'], 'the look is still recorded');
  assert.equal(comments.length, 1, 'only what it found is said');
  assert.match(comments[0], /Which feed\?/);
  assert.ok(!thread.some((m) => /looking at this request/.test(m)));
});

test('runTriage on a staging copy stays silent', async (t) => {
  // Every app is live in production; a staging copy is where nothing is.
  const prior = process.env.USERNODE_ENV;
  t.after(() => { if (prior === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prior; });
  process.env.USERNODE_ENV = 'staging';
  const { pool, deps, calls } = triageHarness({
    sessionId: 921,
    verdictText: 'x\n```json\n{"verdict":"question","determined":false,"missing_fact":"a","question":"Which?","default":"b"}\n```',
  });
  deps.github.createIssueComment = async () => { throw new Error('must not post'); };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
    settings: { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 },
  });
  assert.equal(out.acted, undefined);
  assert.ok(!calls.queries.some((q) => /homeroom_bot_posts/.test(q.s)));
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[3], 'shadow');
});

test('#3772: on a project of one, the person who asked decides what the group would', async () => {
  assert.equal(bot.deciderNote(null), null);
  assert.equal(bot.deciderNote({ requester: 'evan', members: 3, requesterDecides: false }), null, 'a group keeps the rule');
  const note = bot.deciderNote({ requester: 'evan', members: 1, requesterDecides: true });
  assert.match(note, /^==== WHO DECIDES ON THIS PROJECT ====/);
  assert.match(note, /@evan asked for this, and is the only member of this project/);
  assert.match(note, /is a `question` to them, not `person`/);
  assert.match(note, /the choice that needs no approval \(for example the browser's built-in way\) first/);
  assert.match(note, /auth, billing, permissions or credentials, and database changes that are not append-only, are still `person`/);
  const prompt = bot.triagePromptFor({ seed: 'SEED', issueNumber: 13, decider: { requester: 'evan', members: 1, requesterDecides: true } });
  assert.ok(prompt.indexOf('WHO DECIDES') > prompt.indexOf('SEED') && prompt.indexOf('WHO DECIDES') < prompt.indexOf('PLATFORM REFERENCE'));
  assert.doesNotMatch(bot.triagePromptFor({ seed: 'SEED', issueNumber: 13 }), /WHO DECIDES/, 'unchanged without it, as the benchmark replays');

  const pool = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  const evan = { userId: 1, username: 'evan' };
  assert.deepEqual(await bot.whoDecides(pool({ created_by: 1, members: 1, member: true }), { id: 5 }, evan),
    { requester: 'evan', members: 1, requesterDecides: true });
  assert.equal((await bot.whoDecides(pool({ created_by: 9, members: 1, member: false }), { id: 5 }, evan)).requesterDecides, false,
    'somebody else\'s project of one');
  assert.equal((await bot.whoDecides(pool({ created_by: 1, members: 0, member: false }), { id: 5 }, evan)).requesterDecides, true,
    'a project in no community: its creator');
  assert.equal(await bot.whoDecides(pool(null), { id: 5 }, evan), null);
});

test('on a project with more people, its creator and admins decide what gets built, and a request names them', async () => {
  const pool = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  const evan = { userId: 1, username: 'evan' };
  const app = { id: 5, slug: 'geneva-hikes' };
  assert.deepEqual(await bot.whoDecides(pool({ created_by: 1, creator: 'evan', members: 19, member: true, admin: false, admins: [] }), app, evan),
    { requester: 'evan', members: 19, requesterDecides: true, role: 'creator' }, 'its creator');
  assert.deepEqual(await bot.whoDecides(pool({ created_by: 9, creator: 'ann', members: 19, member: true, admin: true, admins: ['evan'] }), app, evan),
    { requester: 'evan', members: 19, requesterDecides: true, role: 'admin' }, 'one of its admins');
  assert.deepEqual(await bot.whoDecides(pool({ created_by: 9, creator: 'ann', members: 3, member: true, admin: false, admins: ['bo', 'cy', 'di', 'ed'] }), app, evan),
    {
      requester: 'evan', members: 3, requesterDecides: false,
      deciders: [{ username: 'ann', role: 'creator' }, { username: 'bo', role: 'admin' }, { username: 'cy', role: 'admin' }, { username: 'di', role: 'admin' }],
    }, 'anyone else: the creator first, four at most');
  assert.deepEqual(await bot.whoDecides(pool({ created_by: 1, creator: 'evan', members: 40, member: true, self_hosted: true, admin: true, admins: [] }), app, evan),
    { requester: 'evan', members: 40, requesterDecides: false }, 'Homeroom\'s own project keeps the rule');
  const homeroom = await bot.whoDecides(pool({ created_by: 1, creator: 'evan', members: 40, member: true, admin: true, admins: [] }), { id: 5, slug: 'usernode-2d5619' }, evan);
  assert.equal(homeroom.requesterDecides, false, 'by its slug too');
  assert.equal(homeroom.deciders, undefined);

  const creatorNote = bot.deciderNote({ requester: 'evan', members: 19, requesterDecides: true, role: 'creator' });
  assert.match(creatorNote, /@evan asked for this, and made this project: the decisions its group would make before building are theirs\. The group still votes on the change it becomes\./);
  assert.match(creatorNote, /is a `question` to them, not `person`/);
  assert.match(bot.deciderNote({ requester: 'evan', members: 19, requesterDecides: true, role: 'admin' }), /@evan asked for this, and is an admin of this project:/);
  assert.equal(bot.deciderNote({ requester: 'evan', members: 3, requesterDecides: false }), null, 'nobody to name says nothing');

  const named = bot.deciderNote({
    requester: 'evan', members: 3, requesterDecides: false,
    deciders: [{ username: 'ann', role: 'creator' }, { username: 'bo', role: 'admin' }],
  });
  assert.match(named, /^==== WHO DECIDES ON THIS PROJECT ====/);
  assert.match(named, /@evan asked for this\. On this project @ann \(who made it\) and @bo \(an admin\) decide what gets built; the group still votes on every change\./);
  assert.match(named, /is `person`, and its `reason` says it waits for @ann or @bo to say go ahead in this request's discussion\./);
  assert.match(named, /When the request's discussion shows @ann or @bo choosing .* that criterion is decided: judge the rest as usual\. A go-ahead from anyone else, @evan included, does not decide it\./);
  assert.match(named, /auth, billing, permissions or credentials, and database changes that are not append-only, are still `person`/);
  assert.match(bot.deciderNote({ requester: 'evan', members: 2, requesterDecides: false, deciders: [{ username: 'ann', role: 'creator' }] }),
    /On this project @ann \(who made it\) decides what gets built;/);
  assert.doesNotMatch(named, /\u2014/);
});

test('a person hand-off tells the requester\'s DM who it waits on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  const act = src.slice(src.indexOf('async function actOnVerdict('), src.indexOf("} else if (parsed.verdict === 'empty') {", src.indexOf('async function actOnVerdict(')));
  assert.match(act, /const deciders = decider && !decider\.requesterDecides && Array\.isArray\(decider\.deciders\)/);
  assert.match(act, /\.\.\.\(deciders\.length \? \{ deciders \} : \{\}\)/);
  assert.match(src, /firstVersion: !!requester\?\.firstVersion,\n\s+\/\/ Who a person hand-off waits on, for the requester's DM\.\n\s+decider,\n/);
});
