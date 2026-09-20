// #2570 — what each model is good for, what a change on it is expected to
// cost, and what changes on it actually cost.
//
// The properties worth pinning are the ones a wrong answer would be hard to
// notice:
//   1. the ESTIMATE is derived, never invented: per-token pricing times one
//      token profile, and a model with no published price gets no estimate
//      rather than a plausible-looking zero;
//   2. the token profile comes from the platform's own recorded usage when
//      there is enough of it, and from ONE documented constant otherwise —
//      and says which;
//   3. the OBSERVED figures are per CHANGE, not per turn: all THREE
//      per-turn records that carry a model id are folded into one bucket
//      per model whichever label they used, a session is counted once and
//      attributed to the model that spent the most in it, and only
//      sessions recorded since the agent's spend gained a model dimension
//      count at all (#2592);
//   4. an admin override replaces the shown estimate and clears back to the
//      derived one, and nothing rewrites an estimate automatically.
//
// Run with: node --test tests/model-costs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modelCosts = require('../src/services/model-costs');
const models = require('../src/services/models');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── 1. The estimate is arithmetic, not an opinion ───────────────────────

test('an estimate is per-token pricing times the typical change, in cents', () => {
  const profile = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  // $1/MTok in and $2/MTok out over exactly one MTok each = $3 = 300 cents.
  assert.equal(
    modelCosts.estimateCents(
      { inputPricePerMillion: 1, outputPricePerMillion: 2 }, profile,
    ),
    300,
  );
  // The real default profile, on the published Opus price.
  const opus = modelCosts.estimateCents(modelCosts.publishedPricing('claude-opus-5'));
  const { inputTokens, outputTokens } = modelCosts.TYPICAL_CHANGE;
  assert.equal(opus, Math.round(
    ((inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25) * 100 * 100,
  ) / 100);
  // The ladder the picker will show is the ladder the prices describe.
  const sonnet = modelCosts.estimateCents(modelCosts.publishedPricing('claude-sonnet-5'));
  const fable = modelCosts.estimateCents(modelCosts.publishedPricing('claude-fable-5-1'));
  const glm = modelCosts.estimateCents(modelCosts.publishedPricing('z-ai/glm-5.3-flash'));
  const deepseek = modelCosts.estimateCents(modelCosts.publishedPricing('deepseek/deepseek-v4.1-flash'));
  assert.ok(deepseek < glm && glm < sonnet && sonnet < opus && opus < fable,
    `expected deepseek < glm < sonnet < opus < fable, got ${deepseek} ${glm} ${sonnet} ${opus} ${fable}`);

  // And the figures themselves, in cents. The derivation above cannot
  // catch a wrong PROFILE, because it uses the same one; these are the
  // numbers a person actually reads, so a change to either the profile or
  // a published price has to be a deliberate edit here.
  // estimateCents keeps two decimals of a cent so that a sub-cent model is
  // not flattened to zero, so pin the figure as a PERSON reads it: rounded
  // to the cent, in dollars. A change to the profile or to a published
  // price has to be a deliberate edit here.
  const shown = (c) => `$${(c / 100).toFixed(2)}`;
  assert.deepEqual(
    { deepseek: shown(deepseek), glm: shown(glm), sonnet: shown(sonnet),
      opus: shown(opus), fable: shown(fable) },
    { deepseek: '$0.21', glm: '$0.30', sonnet: '$6.20',
      opus: '$15.50', fable: '$31.00' },
    'at 2.5M in / 120k out, these are the five figures the picker states',
  );
});

test('a model with no published price gets no estimate rather than a zero', () => {
  assert.equal(modelCosts.publishedPricing('some/unknown-model'), null);
  assert.equal(modelCosts.estimateCents(null), null);
  assert.equal(modelCosts.estimateCents({ inputPricePerMillion: 1 }), null);
  assert.equal(modelCosts.estimateCents({ outputPricePerMillion: 1 }), null);
});

test('the Anthropic notes are models.js’s own copy, not a second opinion', () => {
  for (const [id, meta] of Object.entries(models.MODELS)) {
    assert.equal(modelCosts.noteFor(id), meta.changeSize.short,
      `${id}'s note must come from services/models.js`);
  }
  // The OpenRouter ids are stated here because nothing else states them.
  assert.match(modelCosts.noteFor('z-ai/glm-5.3-flash'), /\w/);
  assert.match(modelCosts.noteFor('deepseek/deepseek-v4.1-flash'), /\w/);
  assert.equal(modelCosts.noteFor('nobody/knows'), '');
});

test('one model reached by several labels is one model', () => {
  for (const label of [
    'z-ai/glm-5.3-flash',
    'openrouter/z-ai/glm-5.3-flash',
    'codex-openrouter/z-ai/glm-5.3-flash',
  ]) {
    assert.equal(modelCosts.normalizeModelId(label), 'z-ai/glm-5.3-flash', label);
  }
  assert.equal(modelCosts.normalizeModelId('scout/claude-opus-5'), 'claude-opus-5');
  assert.equal(modelCosts.normalizeModelId('  '), '');
  assert.equal(modelCosts.normalizeModelId(null), '');
});

// ── 2. The typical change ───────────────────────────────────────────────

function poolFor(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, answer] of rows) {
        if (pattern.test(sql)) return { rows: answer };
      }
      return { rows: [] };
    },
  };
}

test('the token profile is measured when there is enough history, and named either way', async () => {
  const enough = poolFor([[/FROM agent_turns/, [{
    changes: String(modelCosts.MIN_SESSIONS_FOR_PROFILE),
    input_tokens: '300000', output_tokens: '20000',
  }]]]);
  assert.deepEqual(await modelCosts.typicalChange(enough), {
    inputTokens: 300000, outputTokens: 20000, source: 'recorded_usage',
    changes: modelCosts.MIN_SESSIONS_FOR_PROFILE,
  });

  // Too few changes for a median to mean anything: the constant, and it
  // says so.
  const thin = poolFor([[/FROM agent_turns/, [{
    changes: '3', input_tokens: '9', output_tokens: '9',
  }]]]);
  const fallback = await modelCosts.typicalChange(thin);
  assert.equal(fallback.source, 'documented_constant');
  assert.equal(fallback.inputTokens, modelCosts.TYPICAL_CHANGE.inputTokens);

  // And a read that fails is the constant too, never a throw: this feeds a
  // picker, not a gate.
  const broken = { async query() { throw new Error('db down'); } };
  assert.equal((await modelCosts.typicalChange(broken)).source, 'documented_constant');
});

// ── 3. Observed spend is per CHANGE ─────────────────────────────────────

// A pool that answers the observed aggregate with `rows` and the
// observed-since stamp with `since`. `since: null` is a platform that has
// not stamped it yet.
function observedPool(rows, since = '2026-01-01 00:00:00+00') {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT value FROM platform_settings/.test(sql)) {
        return { rows: since == null ? [] : [{ value: since }] };
      }
      if (/turn_costs/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

test('the observed aggregate reads all three per-turn records, per change, over the window', async () => {
  const pool = observedPool([
    { session_id: 1, model: 'z-ai/glm-5.3-flash', cents: '10' },
    { session_id: 2, model: 'openrouter/z-ai/glm-5.3-flash', cents: '22' },
    { session_id: 3, model: 'claude-opus-5', cents: '140' },
  ]);
  const observed = await modelCosts.observedPerModel(pool, { days: 30 });
  const sql = pool.calls[1].sql;
  assert.match(sql, /FROM chat_session_messages/, 'the Mayor and direct-reply record');
  assert.match(sql, /FROM agent_turns/, 'the OpenRouter coding-turn record');
  assert.match(sql, /FROM chat_session_agent_model_costs/,
    '#2592: the Claude coding agent’s own spend, which is most of what a change costs');
  assert.match(sql, /GROUP BY t\.session_id, t\.model/, 'per CHANGE, not per turn');
  assert.deepEqual(pool.calls[1].params, ['30', new Date('2026-01-01T00:00:00Z').toISOString()]);

  // The two labels for GLM are one model, so those are two changes on it.
  assert.equal(observed.get('z-ai/glm-5.3-flash').changes, 2);
  assert.equal(observed.get('z-ai/glm-5.3-flash').avgCents, 16);
  assert.equal(observed.get('z-ai/glm-5.3-flash').medianCents, 16);
  assert.equal(observed.get('claude-opus-5').changes, 1);
});

test('#2592: the coding agent’s spend is counted, not left out', async () => {
  // One change: a $0.15 chat turn and a $9.00 coding-agent bill. The old
  // aggregate saw only the chat turn, which is exactly why the observed
  // figures read far below what a change costs.
  const pool = observedPool([
    { session_id: 11, model: 'claude-opus-5', cents: '15' },
    { session_id: 11, model: 'claude-opus-5', cents: '900' },
  ]);
  const observed = await modelCosts.observedPerModel(pool, { days: 30 });
  const opus = observed.get('claude-opus-5');
  assert.equal(opus.changes, 1, 'one session is one change');
  assert.equal(opus.avgCents, 915, 'the whole session, agent spend included');
  assert.equal(opus.medianCents, 915);
});

test('#2592: a session that switched models is ONE change, on its dominant model', async () => {
  const pool = observedPool([
    // Most of this change ran on Opus; a little of it on Sonnet.
    { session_id: 21, model: 'claude-opus-5', cents: '800' },
    { session_id: 21, model: 'claude-sonnet-5', cents: '200' },
    // A second change, wholly on Opus.
    { session_id: 22, model: 'claude-opus-5', cents: '600' },
  ]);
  const observed = await modelCosts.observedPerModel(pool, { days: 30 });
  const opus = observed.get('claude-opus-5');
  assert.equal(opus.changes, 2, 'two sessions, not three partial ones');
  assert.equal(opus.avgCents, 800, 'each change costs what the WHOLE session cost');
  assert.equal(opus.medianCents, 800);
  assert.equal(observed.get('claude-sonnet-5'), undefined,
    'the minority model does not collect a partial change of its own');
});

test('#2592: the median is PERCENTILE_CONT’s answer, including on even counts', async () => {
  const pool = observedPool([
    { session_id: 1, model: 'claude-opus-5', cents: '100' },
    { session_id: 2, model: 'claude-opus-5', cents: '200' },
    { session_id: 3, model: 'claude-opus-5', cents: '300' },
    { session_id: 4, model: 'claude-opus-5', cents: '1000' },
  ]);
  const opus = (await modelCosts.observedPerModel(pool, { days: 30 })).get('claude-opus-5');
  assert.equal(opus.changes, 4);
  assert.equal(opus.medianCents, 250, 'the mean of the two middle changes');
  assert.equal(opus.avgCents, 400, 'and the mean is dragged by the long one, as a mean is');
});

test('#2592: only sessions recorded since the stamp are counted at all', async () => {
  // The cutoff is passed to the query rather than applied afterwards, so
  // history with no model against the agent's spend cannot reach the
  // aggregate and keep understating it.
  const stamped = observedPool([{ session_id: 1, model: 'claude-opus-5', cents: '500' }]);
  await modelCosts.observedPerModel(stamped, { days: 30 });
  assert.match(stamped.calls[1].sql, /s\.created_at >= \$2::timestamptz/);

  // No stamp: nothing is known to be clean, so nothing is reported and the
  // aggregate is never even run.
  const unstamped = observedPool([{ session_id: 1, model: 'claude-opus-5', cents: '500' }], null);
  assert.equal((await modelCosts.observedPerModel(unstamped, { days: 30 })).size, 0);
  assert.equal(unstamped.calls.length, 1, 'only the stamp read');

  // Garbage in the stamp is the same answer, not a throw.
  const bad = observedPool([], 'not a date');
  assert.equal(await modelCosts.observedSince(bad), null);
});

test('#2592: the console states what one change is, and what it counts', () => {
  // The figure this screen exists to be trusted on is only trustworthy if
  // the screen says what it counted. Three things have to be on the page:
  // that a change is one dev session, that the coding agent's own spend is
  // in, and which model a mixed session is attributed to.
  const admin = read('frontend/src/features/admin/admin-model-costs.tsx');
  assert.match(admin, /One change is one dev session/);
  assert.match(admin, /the coding agent\u2019s own spend included/);
  assert.match(admin, /model that spent the most in it/);
  // And the cutoff, because "observed over the last 30 days" alone would
  // read as all of them.
  assert.match(admin, /Only changes started on or after \$\{cleanSince\} are counted/);
  assert.match(admin, /observedSince/, 'the payload carries the stamp the sentence names');

  // The declared check pins that sentence on the real screen.
  const dapp = JSON.parse(read('dapp.json'));
  assert.ok(
    dapp.tests.some((t) => t.path === '/#admin/model-costs'
      && t.expectSelector === '#admin-model-costs-profile'
      && /One change is one dev session/.test(t.expectText || '')),
    'the new sentence carries a declared check like the paragraph it joins',
  );
});

test('#2592: the admin payload names the day the clean count starts', async () => {
  const pool = observedPool([{ session_id: 1, model: 'claude-opus-5', cents: '500' }]);
  const payload = await modelCosts.adminPayload(pool, { days: 30 });
  assert.equal(payload.observedSince, new Date('2026-01-01T00:00:00Z').toISOString());
  const opus = payload.rows.find((r) => r.modelId === 'claude-opus-5');
  assert.equal(opus.observedChanges, 1);
  assert.equal(opus.observedAvgCents, 500);

  const unstamped = observedPool([], null);
  assert.equal((await modelCosts.adminPayload(unstamped, { days: 30 })).observedSince, null);
});

// ── 4. Overrides ────────────────────────────────────────────────────────

test('an override replaces the shown estimate and clears back to the derived one', async () => {
  let stored = null;
  const pool = {
    async query(sql, params) {
      if (/SELECT value FROM platform_settings/.test(sql)) {
        return { rows: stored == null ? [] : [{ value: stored }] };
      }
      if (/INSERT INTO platform_settings/.test(sql)) {
        stored = params[1];
        return { rows: [] };
      }
      if (/FROM agent_turns/.test(sql)) return { rows: [{ changes: '0' }] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await modelCosts.readOverrides(pool), {});

  await modelCosts.writeOverride(pool, { modelId: 'claude-opus-5', cents: 250, actorId: 1 });
  assert.deepEqual(await modelCosts.readOverrides(pool), { 'claude-opus-5': 250 });

  const picker = await modelCosts.pickerPayload(pool);
  assert.equal(picker.models['claude-opus-5'].estimateCents, 250,
    'the override the admin typed, not the derived 1550');
  assert.equal(picker.models['claude-opus-5'].estimateSource, 'override');
  assert.equal(picker.models['claude-sonnet-5'].estimateSource, 'pricing',
    'the models nobody overrode keep their derived figure');
  assert.equal(picker.typicalChange.source, 'documented_constant');

  await modelCosts.writeOverride(pool, { modelId: 'claude-opus-5', cents: null, actorId: 1 });
  assert.deepEqual(await modelCosts.readOverrides(pool), {});
  const cleared = await modelCosts.pickerPayload(pool);
  assert.equal(cleared.models['claude-opus-5'].estimateSource, 'pricing');

  // Garbage in the setting is ignored rather than rendered.
  stored = '{"good/model": 10, "bad/model": "nope", "": 5}';
  assert.deepEqual(await modelCosts.readOverrides(pool), { 'good/model': 10 });
  stored = 'not json at all';
  assert.deepEqual(await modelCosts.readOverrides(pool), {});
});

test('nothing turns an observed figure into an estimate on its own', () => {
  const src = read('src/services/model-costs.js');
  const admin = read('frontend/src/features/admin/admin-model-costs.tsx');
  // The only writer of the override setting is writeOverride, and its only
  // caller is the admin PUT — an admin typing a number.
  assert.match(src, /async function writeOverride/);
  assert.equal((src.match(/INSERT INTO platform_settings/g) || []).length, 1);
  const routes = read('src/routes/admin.js');
  assert.match(routes, /put\('\/api\/admin\/model-costs', requireAdminWrite/,
    'the write is admin-write gated like its neighbours');
  assert.match(routes, /get\('\/api\/admin\/model-costs'/);
  assert.doesNotMatch(admin, /observedAvgCents.*setDrafts|setDrafts.*observedAvgCents/,
    'the observed figure never prefills the override field');
});

// ── 5. The console section obeys the admin console’s own boundary ──────

test('the Model costs section is registered, routed and audited', () => {
  const console_ = read('frontend/src/features/admin/admin-console.js');
  assert.match(console_, /\{ key: 'model-costs', label: 'Model costs', group: 'Platform' \}/);
  assert.match(console_, /'model-costs': 'AdminModelCosts'/);
  assert.match(console_, /'model-costs': '<svg/, 'the nav entry has an icon like its neighbours');
  assert.match(read('frontend/src/features/admin/sections.ts'), /admin-model-costs\.tsx/);

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/model-costs' \}/,
    'the section declares React ownership of the host it mounts into');
  assert.match(audit, /'#admin\/model-costs'/, 'and the sweep visits the route');

  const dapp = JSON.parse(read('dapp.json'));
  const declared = dapp.tests.filter((t) => t.path === '/#admin/model-costs');
  assert.ok(declared.length >= 1, 'the screen carries a declared check');
});

// ── 6. A cost is never shown as a bare dollar amount ───────────────────
//
// The figure is per TYPICAL CHANGE, not per message, per hour or per
// month, and "$1.55" beside a model name invites all three readings. The
// product decision for #2570 is that the amount only ever reaches a person
// inside the phrase "about $X for a typical change" — on the picker option,
// on the line under the picker, and in the admin console's save
// confirmation. The admin TABLE may hold bare numbers, because its column
// headers carry the unit instead.
//
// dev-chat.js is a plain browser script, so this loads it the way
// model-selector-ui.test.js does: into a vm, reading DevChat back out.

test('a cost only ever reaches a person as "about $X for a typical change"', () => {
  const vm = require('node:vm');
  const sandbox = { console, fetch: () => Promise.reject(new Error('no network')) };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // dev-chat.js wires a few listeners at load. None of them is what this
  // test reads, so the stubs only have to exist.
  sandbox.document = { addEventListener() {}, getElementById: () => null };
  sandbox.addEventListener = () => {};
  sandbox.navigator = {};
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('frontend/src/features/dev-chat/dev-chat.js')}\n;globalThis.__DevChat = DevChat;`,
    sandbox,
  );
  const DevChat = sandbox.__DevChat;

  // The one place the amount is formatted. A curated row carries its own
  // estimate; the client never re-derives one it was given.
  DevChat._modelNotes = {
    typicalChange: { inputTokens: 2_500_000, outputTokens: 120_000, source: 'documented_constant' },
    models: { 'z-ai/glm-5.3-flash': { note: 'quick, cheap changes', estimateCents: 40 } },
  };

  const cost = DevChat._modelCostNote('z-ai/glm-5.3-flash', null);
  assert.equal(cost.compact, 'quick, cheap changes · about $0.40 for a typical change');
  assert.equal(cost.full, 'quick, cheap changes · about $0.40 for a typical change (estimate)');
  // The prefixed picker value resolves to the same row, so an option and
  // the line beneath it cannot disagree.
  assert.equal(DevChat._modelCostNote('openrouter:z-ai/glm-5.3-flash', null).compact, cost.compact);

  // Neither display string may carry an amount that is not inside the
  // phrase. `estimate` holds the bare figure on purpose, for arithmetic.
  for (const text of [cost.compact, cost.full]) {
    for (const match of text.match(/\$[0-9.]+|<\$[0-9.]+/g) || []) {
      assert.match(text, new RegExp(`about ${match.replace(/[$.]/g, '\\$&')} for a typical change`),
        `"${text}" shows an amount outside the phrase`);
    }
  }
  assert.equal(cost.estimate, '$0.40');

  // A model nobody published a price for says what it is good for and
  // stops there, rather than reading as free.
  DevChat._modelNotes.models['no-price/model'] = { note: 'experimental', estimateCents: null };
  const priceless = DevChat._modelCostNote('no-price/model', null);
  assert.equal(priceless.compact, 'experimental');
  assert.doesNotMatch(priceless.full, /\$/);

  // Under a cent is "<$0.01", still inside the phrase.
  DevChat._modelNotes.models['tiny/model'] = { note: 'trivial edits', estimateCents: 0.4 };
  assert.equal(DevChat._modelCostNote('tiny/model', null).compact,
    'trivial edits · about <$0.01 for a typical change');

  // The admin table's cells are bare, so its headers carry the unit.
  const admin = read('frontend/src/features/admin/admin-model-costs.tsx');
  // And the profile it prints reads as millions: a typical change is 2.5M
  // input tokens, which "2500k" is a worse way to say.
  assert.match(admin, /n >= 1_000_000/,
    'the token formatter reaches for M before it reaches for k');
  for (const header of ['Shown estimate, per typical change',
    'Observed average, per typical change',
    'Observed median, per typical change']) {
    assert.ok(admin.includes(header), `the table header "${header}" states its unit`);
  }
  assert.match(admin, /the picker now says about \$\{money\(cents\)\} for a typical change/,
    'the save confirmation uses the phrase too');
});
