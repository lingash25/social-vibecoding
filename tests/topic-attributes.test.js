// Community-voted priority + assigned-person feature.
//
// Three layers:
//   1. Pure helpers in services/topic-attributes.js — normalizeValue
//      (priority enum + assignee trim/length-cap) and pickTop (count desc,
//      earliest-first tie-break, then alphabetical).
//   2. The service's DB-backed flow (summarizeForTargets / listOptions /
//      castVote) and the two HTTP endpoints, driven against a stateful
//      in-memory mock pool that re-implements the table's aggregation
//      semantics — so upsert-moves-a-vote, case-insensitive assignee
//      dedupe, and the GET/POST shapes are all exercised end to end.
//   3. Source guards pinning the feed-route enrichment + server wiring so
//      a refactor can't silently drop the chips from the cards.
//
// Run with: node --test tests/topic-attributes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── 1. Pure helpers ────────────────────────────────────────────────────
const attrs = require('../src/services/topic-attributes');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('normalizeValue: priority accepts only low/medium/high', () => {
  assert.equal(attrs.normalizeValue('priority', 'high'), 'high');
  assert.equal(attrs.normalizeValue('priority', 'HIGH'), 'high'); // case-folded
  assert.equal(attrs.normalizeValue('priority', '  low '), 'low'); // trimmed
  assert.equal(attrs.normalizeValue('priority', 'urgent'), null);
  assert.equal(attrs.normalizeValue('priority', ''), null);
  assert.equal(attrs.normalizeValue('priority', 42), null);
});

test('normalizeValue: assignee trims, rejects empty + over-long, keeps casing', () => {
  assert.equal(attrs.normalizeValue('assignee', '  Evan '), 'Evan');
  assert.equal(attrs.normalizeValue('assignee', ''), null);
  assert.equal(attrs.normalizeValue('assignee', '   '), null);
  assert.equal(attrs.normalizeValue('assignee', 'x'.repeat(64)), 'x'.repeat(64));
  assert.equal(attrs.normalizeValue('assignee', 'x'.repeat(65)), null);
  assert.equal(attrs.normalizeValue('bogus', 'x'), null);
});

// #780: category is free text now (a typed value becomes a per-app option),
// so normalizeValue returns the lower-cased SLUG for anything typeable —
// it no longer rejects values outside the built-in six.
test('normalizeValue: category lower-cases + trims any typeable value', () => {
  assert.equal(attrs.normalizeValue('category', 'bug'), 'bug');
  assert.equal(attrs.normalizeValue('category', 'BUG'), 'bug'); // case-folded
  assert.equal(attrs.normalizeValue('category', '  Feature '), 'feature'); // trimmed
  assert.equal(attrs.normalizeValue('category', 'improvement'), 'improvement');
  assert.equal(attrs.normalizeValue('category', 'urgent'), 'urgent'); // #780: custom, accepted
  assert.equal(attrs.normalizeValue('category', ''), null);
  assert.equal(attrs.normalizeValue('category', 7), null);
  assert.equal(attrs.normalizeValue('category', 'x'.repeat(25)), null); // over the cap
  // The exported vocabulary is exactly the BUILT-IN set (customs live in the
  // app_topic_categories registry, not in this constant).
  assert.deepEqual(attrs.CATEGORY_VALUES, ['feature', 'bug', 'improvement', 'design', 'docs', 'chore']);
  assert.ok(attrs.FIELDS.includes('category'), 'category is a recognised field');
});

test('normalizeCategoryInput: returns { slug, label } keeping the typed casing', () => {
  assert.deepEqual(attrs.normalizeCategoryInput('performance'), { slug: 'performance', label: 'performance' });
  // Casing is preserved for display but lower-cased for the dedupe key, so
  // "iOS" reads right on the chip yet collapses with a later "ios".
  assert.deepEqual(attrs.normalizeCategoryInput('iOS'), { slug: 'ios', label: 'iOS' });
  assert.deepEqual(attrs.normalizeCategoryInput('  Dev Experience  '), { slug: 'dev experience', label: 'Dev Experience' });
  // Internal whitespace runs collapse, so "dev  experience" is one option.
  assert.deepEqual(attrs.normalizeCategoryInput('dev  experience'), { slug: 'dev experience', label: 'dev experience' });
  // Control characters become a space rather than gluing words together.
  const tabbed = attrs.normalizeCategoryInput(`a${String.fromCharCode(9)}b`);
  assert.deepEqual(tabbed, { slug: 'a b', label: 'a b' });
  assert.equal(attrs.normalizeCategoryInput(`x${String.fromCharCode(0)}`).slug, 'x');
  // Length boundary: exactly at the cap passes, one over fails.
  assert.equal(attrs.normalizeCategoryInput('x'.repeat(attrs.MAX_CATEGORY_LEN)).slug, 'x'.repeat(attrs.MAX_CATEGORY_LEN));
  assert.equal(attrs.normalizeCategoryInput('x'.repeat(attrs.MAX_CATEGORY_LEN + 1)), null);
  // Rejections.
  assert.equal(attrs.normalizeCategoryInput(''), null);
  assert.equal(attrs.normalizeCategoryInput('   '), null);
  assert.equal(attrs.normalizeCategoryInput('---'), null, 'needs at least one letter or digit');
  assert.equal(attrs.normalizeCategoryInput('!!!'), null);
  assert.equal(attrs.normalizeCategoryInput(7), null, 'non-strings rejected');
  assert.equal(attrs.normalizeCategoryInput(null), null);
  assert.equal(attrs.MAX_CATEGORY_LEN, 24);
});

test('emptySummary carries a category slot', () => {
  const s = attrs.emptySummary();
  assert.deepEqual(s.category, { top: null, count: 0, myValue: null });
});

test('pickTop: count desc, then earliest first-suggestion, then alpha', () => {
  // Clear winner by count.
  assert.equal(attrs.pickTop([
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
    { value: 'high', count: 3, firstAt: '2026-01-02T00:00:00Z' },
  ]).value, 'high');

  // Tie on count → the value suggested first wins.
  assert.equal(attrs.pickTop([
    { value: 'high', count: 1, firstAt: '2026-01-02T00:00:00Z' },
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
  ]).value, 'low');

  // Tie on count AND time → alphabetical.
  assert.equal(attrs.pickTop([
    { value: 'medium', count: 1, firstAt: '2026-01-01T00:00:00Z' },
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
  ]).value, 'low');

  assert.equal(attrs.pickTop([]), null);
});

// ── 2. Stateful mock pool + service/route flow ─────────────────────────
//
// Re-implements the handful of SQL statements the service issues against
// an in-memory `store` so the real JS aggregation / dedupe / ranking runs.
function makeMockPool() {
  const store = []; // { app_id, target_type, target_ref, field, value, user_id, created_at }
  // #780: the per-app custom-category registry, modelled with its real
  // UNIQUE(app_id, slug) so first-label-wins and the cap are exercised.
  const cats = []; // { app_id, slug, label, created_by, created_at, id }
  let seq = 0;
  let catSeq = 0;
  const norm = (field, value) => (field === 'assignee' ? String(value).toLowerCase() : String(value));

  function grouped(filter) {
    const groups = new Map(); // `${ref}|${field}|${norm}` -> rows
    for (const r of store.filter(filter)) {
      const key = `${r.target_ref}|${r.field}|${norm(r.field, r.value)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [];
    for (const [key, rows] of groups) {
      const [refStr, field] = key.split('|');
      const byNewest = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      out.push({
        ref: parseInt(refStr, 10),
        field,
        norm: norm(field, rows[0].value),
        count: rows.length,
        first_at: rows.map((x) => x.created_at).sort()[0],
        display_value: byNewest[0].value, // array_agg(value ORDER BY created_at DESC)[1]
      });
    }
    return out;
  }

  const pool = {
    store,
    cats,
    async query(sql, params) {
      // ── #780: app_topic_categories (the custom-category registry) ──
      // ensureCategory's cap probe: total rows for the app + whether this
      // slug is already registered.
      if (/SELECT COUNT\(\*\)::int FROM app_topic_categories/.test(sql)) {
        const [appId, slug] = params;
        return {
          rows: [{
            total: cats.filter((c) => c.app_id === appId).length,
            existing: cats.filter((c) => c.app_id === appId && c.slug === slug).length,
          }],
        };
      }
      // ensureCategory's insert — ON CONFLICT (app_id, slug) DO NOTHING.
      if (/INSERT INTO app_topic_categories/.test(sql)) {
        const [appId, slug, label, userId] = params;
        if (!cats.some((c) => c.app_id === appId && c.slug === slug)) {
          catSeq += 1;
          cats.push({
            id: catSeq, app_id: appId, slug, label, created_by: userId,
            created_at: new Date(Date.now() + catSeq).toISOString(),
          });
        }
        return { rows: [] };
      }
      // listCategories — the app's registry rows, in creation order.
      if (/SELECT slug, label FROM app_topic_categories/.test(sql)) {
        const [appId] = params;
        return {
          rows: cats
            .filter((c) => c.app_id === appId)
            .sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) || (a.id - b.id))
            .map((c) => ({ slug: c.slug, label: c.label })),
        };
      }
      // listCategories — the self-heal tail: category values in use that
      // have no registry row.
      if (/SELECT DISTINCT value FROM topic_attribute_votes/.test(sql)) {
        const [appId] = params;
        const vals = [...new Set(store
          .filter((r) => r.app_id === appId && r.field === 'category')
          .map((r) => r.value))].sort();
        return { rows: vals.map((value) => ({ value })) };
      }
      // summarizeForTargets — grouped tally over a set of refs.
      if (/GROUP BY target_ref, field, norm/.test(sql)) {
        const [appId, type, ids] = params;
        return { rows: grouped((r) => r.app_id === appId && r.target_type === type && ids.includes(r.target_ref)) };
      }
      // summarizeForTargets — viewer's own votes over a set of refs.
      if (/SELECT target_ref AS ref, field, value/.test(sql)) {
        const [appId, type, ids, userId] = params;
        return {
          rows: store
            .filter((r) => r.app_id === appId && r.target_type === type && ids.includes(r.target_ref) && r.user_id === userId)
            .map((r) => ({ ref: r.target_ref, field: r.field, value: r.value })),
        };
      }
      // listOptions — grouped tally for one target+field.
      if (/GROUP BY norm/.test(sql)) {
        const [appId, type, ref, field] = params;
        return { rows: grouped((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field) };
      }
      // listOptions — viewer's own single value.
      if (/SELECT value FROM topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, userId] = params;
        const m = store.find((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId);
        return { rows: m ? [{ value: m.value }] : [] };
      }
      // castVote upsert.
      if (/INSERT INTO topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, value, userId] = params;
        const ex = store.find((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId);
        const ts = new Date(Date.now() + (seq++)).toISOString();
        if (ex) { ex.value = value; ex.created_at = ts; }
        else store.push({ app_id: appId, target_type: type, target_ref: ref, field, value, user_id: userId, created_at: ts });
        return { rows: [] };
      }
      // clearVote — delete the caller's own row for a (target, field).
      if (/DELETE FROM topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, userId] = params;
        for (let i = store.length - 1; i >= 0; i--) {
          const r = store[i];
          if (r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId) {
            store.splice(i, 1);
          }
        }
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
    },
  };
  return pool;
}

test('castVote upserts (moves) a vote instead of duplicating', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 100);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'low', 100); // same user moves their pick
  assert.equal(pool.store.length, 1);
  assert.equal(pool.store[0].value, 'low');
  const opts = await attrs.listOptions(pool, 1, 'issue', 7, 'priority', 100);
  assert.equal(opts.myValue, 'low');
  assert.equal(opts.options.find((o) => o.value === 'low').count, 1);
  assert.ok(!opts.options.some((o) => o.value === 'high'));
});

test('assignee dedupes case-insensitively, keeps most-recent casing', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'evan', 1);
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'Evan', 2);
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'EVAN', 3);
  const opts = await attrs.listOptions(pool, 1, 'proposal', 9, 'assignee', 2);
  assert.equal(opts.options.length, 1, 'three casings collapse to one option');
  assert.equal(opts.options[0].count, 3);
  assert.equal(opts.options[0].value, 'EVAN', 'display value is the most recent casing');
  assert.equal(opts.options[0].mine, true, 'viewer (user 2) backs this option');
});

test('summarizeForTargets returns top + count + myValue per target', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 2);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'low', 3);
  await attrs.castVote(pool, 1, 'issue', 8, 'assignee', 'alice', 1);

  const map = await attrs.summarizeForTargets(pool, 1, 'issue', [7, 8], 3);
  assert.equal(map.get(7).priority.top, 'high');
  assert.equal(map.get(7).priority.count, 2);
  assert.equal(map.get(7).priority.myValue, 'low'); // user 3 voted low
  assert.equal(map.get(7).assignee.top, null); // untouched field → placeholder
  assert.equal(map.get(8).assignee.top, 'alice');
  assert.equal(map.get(8).assignee.myValue, null); // user 3 didn't vote here
});

test('clearVote removes only the caller\'s own vote, leaving others\' intact', async () => {
  const pool = makeMockPool();
  // Two users back different assignees on the same card.
  await attrs.castVote(pool, 1, 'issue', 7, 'assignee', 'alice', 1);
  await attrs.castVote(pool, 1, 'issue', 7, 'assignee', 'bob', 2);
  assert.equal(pool.store.length, 2);

  // User 1 withdraws — only their row goes; user 2's 'bob' vote survives and
  // becomes the new leader.
  const after = await attrs.clearVote(pool, 1, 'issue', 7, 'assignee', 1);
  assert.equal(pool.store.length, 1);
  assert.equal(pool.store[0].value, 'bob');
  assert.equal(after.myValue, null, 'the caller no longer has a pick');
  assert.equal(after.options[0].value, 'bob');

  // Idempotent: clearing again is a no-op.
  await attrs.clearVote(pool, 1, 'issue', 7, 'assignee', 1);
  assert.equal(pool.store.length, 1);
});

// ── #780: per-app custom categories ────────────────────────────────────
//
// Typing a category IS voting for it: castVote registers an unknown slug in
// app_topic_categories (scoped to the app) and then upserts the vote, so a
// new option appears on every card in that app.

test('castVote: an unknown category registers exactly one registry row', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 100, [], 'Performance');
  assert.equal(pool.cats.length, 1);
  assert.deepEqual(
    { app_id: pool.cats[0].app_id, slug: pool.cats[0].slug, label: pool.cats[0].label, created_by: pool.cats[0].created_by },
    { app_id: 1, slug: 'performance', label: 'Performance', created_by: 100 }
  );
  // The vote itself stores the SLUG, so it tallies like a built-in.
  assert.equal(pool.store[0].value, 'performance');
});

test('castVote: a BUILT-IN category creates no registry row', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'bug', 100, [], 'bug');
  assert.equal(pool.cats.length, 0, 'the six built-ins need no registry row');
  assert.equal(pool.store[0].value, 'bug');
});

test('castVote: re-typing a category in different casing reuses the row + keeps the first label', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 100, [], 'Performance');
  // A second user types it LOUDLY on another card — same slug, so no second
  // row, and the original display casing survives.
  await attrs.castVote(pool, 1, 'issue', 8, 'category', 'performance', 200, [], 'PERFORMANCE');
  assert.equal(pool.cats.length, 1, 'no duplicate registry row');
  assert.equal(pool.cats[0].label, 'Performance', 'first typed label wins');
});

test('castVote: the same category is per-app — two apps get their own row', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 100, [], 'Performance');
  await attrs.castVote(pool, 2, 'issue', 7, 'category', 'performance', 100, [], 'Performance');
  assert.equal(pool.cats.length, 2, 'a custom category never leaks between apps');
  assert.deepEqual(pool.cats.map((c) => c.app_id), [1, 2]);
});

test('ensureCategory: rejects a NEW slug at the per-app cap, still allows existing ones', async () => {
  const pool = makeMockPool();
  for (let i = 0; i < attrs.MAX_CUSTOM_CATEGORIES_PER_APP; i += 1) {
    await attrs.castVote(pool, 1, 'issue', 7, 'category', `custom ${i}`, 100 + i, [], `custom ${i}`);
  }
  assert.equal(pool.cats.length, attrs.MAX_CUSTOM_CATEGORIES_PER_APP);

  await assert.rejects(
    () => attrs.castVote(pool, 1, 'issue', 7, 'category', 'one too many', 999, [], 'One too many'),
    (err) => err.message === attrs.CATEGORY_CAP_ERROR,
    'a brand-new slug is refused at the cap'
  );
  assert.equal(pool.cats.length, attrs.MAX_CUSTOM_CATEGORIES_PER_APP, 'nothing was registered');

  // Voting for an ALREADY-registered option must keep working at the cap.
  await attrs.castVote(pool, 1, 'issue', 9, 'category', 'custom 0', 999, [], 'custom 0');
  assert.ok(pool.store.some((r) => r.target_ref === 9 && r.value === 'custom 0'));

  // Another app is unaffected by app 1 being full.
  await attrs.castVote(pool, 2, 'issue', 7, 'category', 'fresh', 999, [], 'Fresh');
  assert.ok(pool.cats.some((c) => c.app_id === 2 && c.slug === 'fresh'));
});

test('listCategories: built-ins first, then customs in creation order', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 100, [], 'Performance');
  await attrs.castVote(pool, 1, 'issue', 8, 'category', 'onboarding', 101, [], 'Onboarding');

  const list = await attrs.listCategories(pool, 1);
  assert.deepEqual(
    list.slice(0, 6).map((c) => c.value),
    attrs.CATEGORY_VALUES,
    'the six built-ins lead, in their fixed order'
  );
  assert.ok(list.slice(0, 6).every((c) => c.custom === false));
  assert.deepEqual(
    list.slice(6).map((c) => ({ value: c.value, label: c.label, custom: c.custom })),
    [
      { value: 'performance', label: 'Performance', custom: true },
      { value: 'onboarding', label: 'Onboarding', custom: true },
    ],
    'customs follow, oldest-first, carrying their display label'
  );
});

test('listCategories: is scoped to one app', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'app-one-only', 100, [], 'App one only');
  const other = await attrs.listCategories(pool, 2);
  assert.deepEqual(other.map((c) => c.value), attrs.CATEGORY_VALUES, 'app 2 sees built-ins only');
});

test('listCategories: self-heals a category that has votes but no registry row', async () => {
  const pool = makeMockPool();
  // Simulate a vote whose registry row is gone (manual DB cleanup, or a row
  // written before #780) by writing the vote directly.
  pool.store.push({
    app_id: 1, target_type: 'issue', target_ref: 7, field: 'category',
    value: 'orphaned', user_id: 100, created_at: new Date().toISOString(),
  });
  const list = await attrs.listCategories(pool, 1);
  const orphan = list.find((c) => c.value === 'orphaned');
  assert.ok(orphan, 'a value a chip can display is always listed in the picker');
  assert.equal(orphan.custom, true);
  // Built-in values in use are NOT duplicated into the tail.
  pool.store.push({
    app_id: 1, target_type: 'issue', target_ref: 8, field: 'category',
    value: 'bug', user_id: 101, created_at: new Date().toISOString(),
  });
  const again = await attrs.listCategories(pool, 1);
  assert.equal(again.filter((c) => c.value === 'bug').length, 1);
});

test('a custom category tallies + wins the chip exactly like a built-in', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 1, [], 'Performance');
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'performance', 2, [], 'Performance');
  await attrs.castVote(pool, 1, 'issue', 7, 'category', 'bug', 3, [], 'bug');

  const map = await attrs.summarizeForTargets(pool, 1, 'issue', [7], 3);
  assert.equal(map.get(7).category.top, 'performance', 'custom (2) beats built-in (1)');
  assert.equal(map.get(7).category.count, 2);
  assert.equal(map.get(7).category.myValue, 'bug');

  const opts = await attrs.listOptions(pool, 1, 'issue', 7, 'category', 3);
  assert.equal(opts.options[0].value, 'performance');
  assert.ok(opts.options.find((o) => o.value === 'bug').mine);
});

// ── #639: proposal inheritance from linked issue(s) ────────────────────
//
// Priority/assignee are voted while a task is an open issue, but once it is
// promoted the card is keyed ('proposal', sessionId) instead of ('issue', N).
// summarizeForProposals bridges the two via the proposal's linked_issues with
// a per-field fallback so the chips no longer vanish on "propose for voting"
// or "close done".

test('mergeBuckets: folds same-value buckets across targets (sum, earliest, casing)', () => {
  const merged = attrs.mergeBuckets('assignee', [
    [{ value: 'Evan', count: 1, firstAt: '2026-01-02T00:00:00Z' }],
    [{ value: 'evan', count: 2, firstAt: '2026-01-01T00:00:00Z' }],
    [{ value: 'Sam', count: 1, firstAt: '2026-01-03T00:00:00Z' }],
  ]);
  const evan = merged.find((b) => b.value.toLowerCase() === 'evan');
  assert.equal(evan.count, 3, 'counts sum across the two casings');
  assert.equal(evan.firstAt, '2026-01-01T00:00:00Z', 'earliest first-suggestion wins');
  assert.equal(evan.value, 'evan', 'display casing follows the higher-count member');
  assert.equal(merged.length, 2, 'Evan/evan collapse; Sam stays separate');
});

test('summarizeForProposals: proposal with own votes ignores the linked issue', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'low', 1);   // issue says low
  await attrs.castVote(pool, 1, 'proposal', 7, 'priority', 'high', 2); // proposal says high
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 2);
  assert.equal(map.get(7).priority.top, 'high', 'own votes win outright');
  assert.equal(map.get(7).priority.myValue, 'high');
});

test('summarizeForProposals: no own votes → inherits from a single linked issue', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 2);
  await attrs.castVote(pool, 1, 'issue', 42, 'assignee', 'Alex', 3);
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 9);
  assert.equal(map.get(7).priority.top, 'high');
  assert.equal(map.get(7).priority.count, 2);
  assert.equal(map.get(7).assignee.top, 'Alex');
});

test('summarizeForProposals: inherits the combined tally across multiple linked issues', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 43, 'priority', 'high', 2); // same value, other issue
  await attrs.castVote(pool, 1, 'issue', 43, 'priority', 'low', 3);
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42, 43] }], 9);
  assert.equal(map.get(7).priority.top, 'high', 'high (1+1) beats low (1) once folded');
  assert.equal(map.get(7).priority.count, 2);
});

test('summarizeForProposals: per-field mix — own priority, inherited assignee', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'proposal', 7, 'priority', 'low', 1);  // own priority
  await attrs.castVote(pool, 1, 'issue', 42, 'assignee', 'Alex', 2);   // inherited assignee
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 9);
  assert.equal(map.get(7).priority.top, 'low', 'own priority stands');
  assert.equal(map.get(7).assignee.top, 'Alex', 'assignee inherited from the issue');
});

test('summarizeForProposals: no linked issues → empty summary (unchanged behaviour)', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 1);   // unrelated issue
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [] }], 9);
  assert.equal(map.get(7).priority.top, null);
  assert.equal(map.get(7).assignee.top, null);
});

test('summarizeForProposals: assignee casing dedupes across the issue→proposal boundary', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'assignee', 'evan', 1);
  await attrs.castVote(pool, 1, 'issue', 42, 'assignee', 'Evan', 2);
  const map = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 9);
  assert.equal(map.get(7).assignee.top, 'Evan', 'most-recent casing shows');
  assert.equal(map.get(7).assignee.count, 2, 'two casings count as one assignee');
});

test('summarizeForProposals: myValue resolves proposal vote else issue vote', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 5); // viewer voted on the issue
  const inherited = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 5);
  assert.equal(inherited.get(7).priority.myValue, 'high', 'falls back to the issue vote');

  await attrs.castVote(pool, 1, 'proposal', 7, 'priority', 'low', 5); // viewer re-votes on the proposal
  const own = await attrs.summarizeForProposals(pool, 1, [{ id: 7, linked_issues: [42] }], 5);
  assert.equal(own.get(7).priority.myValue, 'low', 'proposal vote overrides the issue vote');
});

test('listOptions: proposal dropdown inherits options from its linked issue, then detaches on cast', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 42, 'priority', 'low', 5); // viewer (5) backs low

  // Proposal has no votes yet → dropdown shows the inherited issue tally.
  const inherited = await attrs.listOptions(pool, 1, 'proposal', 7, 'priority', 5, [42]);
  assert.equal(inherited.options.length, 2, 'both inherited options surface');
  assert.equal(inherited.myValue, 'low', 'viewer\'s issue pick pre-selects');
  assert.ok(inherited.options.find((o) => o.value === 'low').mine);

  // Casting on the proposal writes the proposal key and detaches the field.
  await attrs.castVote(pool, 1, 'proposal', 7, 'priority', 'medium', 5, [42]);
  const own = await attrs.listOptions(pool, 1, 'proposal', 7, 'priority', 5, [42]);
  assert.equal(own.options.length, 1, 'only the proposal-level vote now');
  assert.equal(own.options[0].value, 'medium');
  assert.equal(own.myValue, 'medium');
});

// ── HTTP endpoints ──────────────────────────────────────────────────────
const express = require('express');
const poolMod = require('../src/db/pool');
const appAccess = require('../src/services/app-access');

let server;
let base;
let mockPool;

test.before(async () => {
  mockPool = makeMockPool();
  poolMod.getPool = () => mockPool;
  appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo' });

  const { topicAttributeRoutes } = require('../src/routes/topic-attributes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 100, username: 'tester' }; next(); });
  app.use(topicAttributeRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('POST rejects an out-of-range priority value', async () => {
  const r = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'urgent' }),
  });
  assert.equal(r.status, 400);
});

test('POST rejects an unknown field and a bad target type', async () => {
  const bad1 = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'colour', value: 'red' }),
  });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(`${base}/api/apps/demo/topics/widget/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'low' }),
  });
  assert.equal(bad2.status, 400);
});

test('POST then GET round-trips the option list + myValue', async () => {
  const post = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'medium' }),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.field, 'priority');
  assert.equal(posted.myValue, 'medium');
  assert.equal(posted.options[0].value, 'medium');
  assert.equal(posted.options[0].mine, true);

  const get = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes?field=priority`).then((x) => x.json());
  assert.equal(get.myValue, 'medium');
  assert.equal(get.options.find((o) => o.value === 'medium').count, 1);
});

test('DELETE withdraws the caller\'s assignee vote (drag-to-Unassigned)', async () => {
  // Seed the caller's assignee vote on a fresh target.
  const post = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'assignee', value: 'tester' }),
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).myValue, 'tester');

  // DELETE clears it; the option list comes back empty for this viewer.
  const del = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes?field=assignee`, {
    method: 'DELETE',
  });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.myValue, null);
  assert.ok(!body.options.some((o) => o.value === 'tester'), 'the withdrawn vote is gone');

  // A DELETE with an invalid field is rejected.
  const bad = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes?field=colour`, {
    method: 'DELETE',
  });
  assert.equal(bad.status, 400);
});

// ── #780: custom categories over HTTP ──────────────────────────────────

test('POST rejects a category that is empty, punctuation-only, or over-long', async () => {
  for (const value of ['', '   ', '---', 'x'.repeat(25)]) {
    const r = await fetch(`${base}/api/apps/demo/topics/issue/60/attributes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'category', value }),
    });
    assert.equal(r.status, 400, `rejected ${JSON.stringify(value)}`);
    const body = await r.json();
    assert.match(body.error, /Category must be 1–24 characters/);
  }
});

test('POST a typed category registers it and returns the app vocabulary', async () => {
  const r = await fetch(`${base}/api/apps/demo/topics/issue/61/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'category', value: '  Developer Experience ' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  // The vote landed on the normalized slug; the chip reads the label.
  assert.equal(body.myValue, 'developer experience');
  assert.ok(Array.isArray(body.categories), 'POST carries the vocabulary');
  const added = body.categories.find((c) => c.value === 'developer experience');
  assert.deepEqual(
    { label: added.label, custom: added.custom },
    { label: 'Developer Experience', custom: true },
    'trimmed, whitespace-collapsed, typed casing kept'
  );
  assert.deepEqual(
    body.categories.slice(0, 6).map((c) => c.value),
    attrs.CATEGORY_VALUES,
    'built-ins still lead the list'
  );

  // GET the same card's category options — the vocabulary rides along there
  // too, so opening the dropdown self-heals a stale FE cache.
  const get = await fetch(`${base}/api/apps/demo/topics/issue/61/attributes?field=category`).then((x) => x.json());
  assert.ok(get.categories.some((c) => c.value === 'developer experience'));
  assert.equal(get.myValue, 'developer experience');
});

test('GET/POST carry `categories` ONLY for the category field', async () => {
  const get = await fetch(`${base}/api/apps/demo/topics/issue/61/attributes?field=priority`).then((x) => x.json());
  assert.equal(get.categories, undefined, 'priority GET has no vocabulary');
  const post = await fetch(`${base}/api/apps/demo/topics/issue/61/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'assignee', value: 'someone' }),
  }).then((x) => x.json());
  assert.equal(post.categories, undefined, 'assignee POST has no vocabulary');
});

test('GET /topic-categories returns the vocabulary; 404 for an inaccessible app', async () => {
  const r = await fetch(`${base}/api/apps/demo/topic-categories`);
  assert.equal(r.status, 200);
  const { categories } = await r.json();
  assert.deepEqual(categories.slice(0, 6).map((c) => c.value), attrs.CATEGORY_VALUES);
  assert.ok(categories.every((c) => typeof c.label === 'string' && typeof c.custom === 'boolean'));

  // The route is view-gated through the same helper as the attributes GET.
  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => null;
  try {
    const denied = await fetch(`${base}/api/apps/nope/topic-categories`);
    assert.equal(denied.status, 404);
  } finally {
    appAccess.getAppForUser = orig;
  }
});

test('POST returns a distinct 400 (not a 500) once the app is at its category cap', async () => {
  // Fill app 1's registry straight through the service, then let the route
  // hit the cap so the error mapping is what's under test.
  const pool = poolMod.getPool();
  while (pool.cats.filter((c) => c.app_id === 1).length < attrs.MAX_CUSTOM_CATEGORIES_PER_APP) {
    const n = pool.cats.length;
    await attrs.ensureCategory(pool, 1, { slug: `filler ${n}`, label: `Filler ${n}` }, 100);
  }
  const r = await fetch(`${base}/api/apps/demo/topics/issue/62/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'category', value: 'one too many' }),
  });
  assert.equal(r.status, 400, 'a user error, not a server fault');
  const body = await r.json();
  assert.match(body.error, /maximum of 24 custom categories/);

  // Voting for a BUILT-IN still works at the cap (no registry row needed).
  const builtin = await fetch(`${base}/api/apps/demo/topics/issue/62/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'category', value: 'bug' }),
  });
  assert.equal(builtin.status, 200);
});

// ── 3. Source guards ───────────────────────────────────────────────────
test('feed routes attach the priority/assignee/category summary', () => {
  const issuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf-8');
  assert.match(issuesSrc, /summarizeForTargets\([^)]*'issue'/s, 'issues route enriches issue targets');
  assert.match(issuesSrc, /issue\.priority = s\.priority/);
  assert.match(issuesSrc, /issue\.category = s\.category/, 'issues route copies the category summary');

  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf-8');
  // #639: proposal cards enrich via the proposal-aware summary so their
  // priority/assignee chips inherit from the linked origin issue(s).
  assert.match(votesSrc, /summarizeForProposals\(/, 'votes route enriches proposal targets');
  assert.match(votesSrc, /linked_issues: r\.linked_issues/, 'passes each proposal its linked issues');
  assert.match(votesSrc, /\.category = s\.category/, 'votes route copies the category summary onto proposals');
});

test('server wires the topic-attributes route', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.match(serverSrc, /topicAttributeRoutes\(config\)/);
});

test('card renderer emits the three chips (priority, category, assignee)', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  assert.match(fe, /_attrChipSpecs\('issue'/, 'issue rows render chips');
  assert.match(fe, /_attrChipSpecs\('proposal'/, 'proposal cards render chips');
  // …and the BOARD passes omitUnset, so a card with no metadata carries no
  // grey "Set priority / Set category / Unassigned" placeholders. The detail
  // view (noNav) opts out — that page is where metadata gets set.
  assert.match(fe, /omitUnset: !noNav/, 'the board omits unset chips, the detail view keeps them');
  assert.match(fe, /data-attr-chip/, 'chip carries the delegated-click hook');
  // The three fields are a table inside _attrChipSpecs now (priority,
  // assignee, category — the badge-priority order) rather than three
  // hand-written calls, so the omitUnset filter applies uniformly.
  assert.match(fe, /\['category', it\.category\]/, 'the category chip is in the field table');
  assert.match(fe, /ATTR_CATEGORY_VALUES: \['feature', 'bug', 'improvement', 'design', 'docs', 'chore'\]/,
    'FE category vocabulary mirrors the service CATEGORY_VALUES');
});

// #780: the category dropdown gained a free-text box, a "Custom" block for
// the app's registered options, and — because those labels are USER INPUT —
// escaping on every label interpolation.
test('category dropdown offers a text box + the app custom block', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  // The dropdown's markup is features/dev-board/attr-popover.tsx since #1191;
  // what app-view.js still decides is the SHAPE it hands over.
  const pop = read('frontend/src/features/dev-board/attr-popover.tsx');
  assert.match(fe, /inputId: 'attr-category-input'/, 'the type-a-category box exists');
  assert.match(fe, /maxLength: AppView\.ATTR_CATEGORY_MAX_LEN/,
    'the box caps typed length from the mirrored constant');
  assert.match(fe, /ATTR_CATEGORY_MAX_LEN: 24/, 'FE cap mirrors the service MAX_CATEGORY_LEN');
  assert.match(fe, /buttonId: 'attr-category-add'/, 'the Add button exists');
  assert.match(pop, /maxLength=\{add\.maxLength\}/, 'the component applies that cap');
  assert.match(fe, /head: 'Custom', divided: true/, 'customs sit under a divided "Custom" heading');
  assert.match(pop, /'attr-pop-head attr-pop-head-divided' : 'attr-pop-head'/,
    'and the component draws the rule above it');
  assert.match(fe, /_customCategories\(\)/, 'the custom block reads the app vocabulary');

  // The vocabulary is loaded once per Dev mount and refreshed from the
  // GET/POST payloads, so a just-typed category can be labelled immediately.
  assert.match(fe, /AppView\._loadAppCategories\(pager\)/,
    'Dev data load fetches the vocabulary with the current app-visit guard');
  assert.match(fe, /topic-categories/, 'hits the vocabulary endpoint');
  assert.match(fe, /_setAppCategories\(data\.categories\)/, 'a cast adopts the refreshed vocabulary');

  // Escaping: custom labels are user-supplied. The chip is a component now
  // (card/dev-card.tsx's `attr` badge), so its label is a TEXT CHILD and
  // React escapes it — the property `escapeHtml` was there to give it.
  // Rendered, not grepped, exactly like the popover row below.
  assert.match(
    renderComponent('tests/fixtures/dev-card-api.ts', 'Badge', {
      b: {
        t: 'attr', key: 'attr:category', field: 'category', targetType: 'issue',
        targetRef: 5, cls: 'bg-sky-500/10', hover: 'hover:bg-sky-500/20',
        title: 'Vote on this card\'s category', count: 0, readonly: false,
        label: { kind: 'dot', cls: 'bg-sky-500/10', text: '<img src=x onerror=alert(1)>' },
      },
    }),
    /&lt;img src=x onerror=alert\(1\)&gt;/,
    'category chip escapes its label');
  // The popover row is a component now, so its label is a text child — the
  // property `escapeHtml` was there to give it. Rendered, not grepped.
  assert.match(
    renderComponent('frontend/src/features/dev-board/attr-popover.tsx', 'AttrPopoverView', {
      phase: 'ready',
      field: 'category',
      groups: [{
        head: 'Custom',
        divided: true,
        options: [{ value: 'x', dot: 'bg-sky-500/10', label: '<img src=x onerror=alert(1)>', count: 0, mine: false }],
      }],
      emptyNote: null,
      add: null,
      suggestions: [],
    }),
    /&lt;img src=x onerror=alert\(1\)&gt;/,
  );
  // The active-filter chips are features/dev-board/kanban-filters.tsx's
  // (Streamlined Concept) — a user-supplied category label is a TEXT CHILD of
  // the chip button, so React escapes it. The selects the bar used to render
  // live in the Filters dialog, where React does the same for option labels.
  assert.match(
    renderComponent('frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView', {
      mounted: true, q: '', seq: 0, count: 1,
      chips: [{ key: 'category', label: '<b>hi</b>' }],
    }),
    /&lt;b&gt;hi&lt;\/b&gt;/,
    'the active-category chip escapes its label',
  );

  // _categoryMeta must resolve unknown (custom) slugs rather than returning
  // null — every caller dereferences the result.
  assert.match(fe, /_categoryTint\(/, 'custom categories get a deterministic tint');
  assert.match(fe, /CATEGORY_CUSTOM_TINTS/, 'a dedicated custom-category palette exists');

  // The Filters dialog is vocabulary-driven: choices are computed fresh at
  // every open, so a category created this session appears without a reload.
  assert.match(fe, /_kanbanCategoryChoices\(\)/, 'the category filter is vocabulary-driven');
  assert.match(fe, /categories: AppView\._kanbanCategoryChoices\(\)/,
    'the dialog payload reads the vocabulary at open time');
});

// #780: _categoryMeta must never return null for a non-empty slug — chips,
// the popover and the filter bar all dereference it directly.
test('_categoryMeta resolves custom slugs (label + tint), null only for empty', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  // Evaluate the two helpers in isolation against a stubbed vocabulary.
  const metaSrc = fe.slice(fe.indexOf('  _categoryTint(slug) {'));
  const body = metaSrc.slice(0, metaSrc.indexOf('\n  // #780: the custom half'));
  const AppView = { CATEGORY_CUSTOM_TINTS: [{ cls: 'c1', hover: 'h1' }, { cls: 'c2', hover: 'h2' }] };
  // eslint-disable-next-line no-new-func
  const build = new Function('AppView', `return { ${body} };`);
  Object.assign(AppView, build(AppView));
  AppView._appCategories = [{ value: 'dev experience', label: 'Dev Experience', custom: true }];

  assert.equal(AppView._categoryMeta('bug').label, 'Bug', 'built-ins keep their fixed label');
  const known = AppView._categoryMeta('dev experience');
  assert.equal(known.label, 'Dev Experience', 'registered label wins');
  assert.ok(known.cls && known.hover, 'custom slugs still get colour classes');
  // Not yet in the cache → title-cased fallback, never null.
  assert.equal(AppView._categoryMeta('performance').label, 'Performance');
  assert.equal(AppView._categoryMeta(null), null, 'only an empty value is null');
  // Deterministic: the same slug always resolves to the same tint.
  assert.equal(AppView._categoryMeta('performance').cls, AppView._categoryMeta('performance').cls);
});

// #780: staging must seed the custom-category UI — app_topic_categories is
// created by this change, so it lands EMPTY in every staging clone.
test('staging seeds a custom-category vocabulary + cards using it', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'topic-attributes.js'), 'utf-8');
  assert.match(svc, /IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/, 'staging gate is the canonical helper');
  assert.match(svc, /Staging demo perf/, 'a demo custom category is appended in staging');
  assert.match(svc, /Staging demo onboarding/, 'and a second one');

  // One mock ISSUE and one mock PROPOSAL carry a custom category, so the
  // chip colour + the filter narrowing are reviewable on both card types.
  const issuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf-8');
  assert.match(issuesSrc, /category: \{ top: 'staging demo perf'/, 'a mock issue leads with a custom category');
  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf-8');
  assert.match(votesSrc, /category: \{ top: 'staging demo onboarding'/, 'a mock proposal too');
});

// #780: the registry table must exist and stay staging-copyable (like
// topic_attribute_votes) — a private marker would empty it in previews.
test('app_topic_categories is declared idempotently and is NOT staging:private', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf-8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_topic_categories/, 'idempotent create');
  assert.match(schema, /UNIQUE\(app_id, slug\)/, 'one row per (app, slug) — the dedupe key');
  assert.match(schema, /app_id\s+INTEGER NOT NULL REFERENCES apps\(id\) ON DELETE CASCADE/,
    'scoped to one app, cleaned up with it');
  assert.doesNotMatch(
    schema,
    /COMMENT ON TABLE app_topic_categories IS 'staging:private'/,
    'the taxonomy is a shared signal — it must copy into staging'
  );
});

// #600: the assignee dropdown pre-fills the name box with the viewer's own
// username, but only when they have no current pick, and without a
// standalone "Assign to me" button (that approach was replaced).
test('assignee dropdown defaults the name box to the viewer, gated on no prior vote', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  // The pre-fill is still app-view.js's decision — it reads App.user.username
  // and gates on !data.myValue — but it arrives as the box's `defaultValue`
  // now rather than as a `.value` write after the paint. The SELECT stays a
  // DOM call, because "typing replaces it" is a selection, not markup.
  assert.match(fe, /const me = \(typeof App !== 'undefined' && App\.user && App\.user\.username\)/,
    'reads the signed-in username');
  assert.match(fe, /defaultValue: \(me && !data\.myValue\) \? me : '',/,
    'only pre-fills when the viewer has no current pick');
  assert.match(fe, /if \(add\.defaultValue\) input\.select\(\);/,
    'selects the pre-filled text so typing replaces it');
  assert.match(read('frontend/src/features/dev-board/attr-popover.tsx'),
    /defaultValue=\{add\.defaultValue\}/, 'the field is uncontrolled, seeded from the model');

  // The standalone button + its plumbing are gone.
  assert.doesNotMatch(fe, /_assignToMeBtnHtml/, 'no assign-to-me button helper');
  assert.doesNotMatch(fe, /data-assign-me/, 'no assign-to-me button hook');
  assert.doesNotMatch(fe, /_toggleAssignToMe/, 'no assign-to-me click handler');
  assert.doesNotMatch(fe, /_assignInFlight/, 'no assign-to-me in-flight guard');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf-8');
  assert.doesNotMatch(css, /\.attr-assign-me/, 'no leftover assign-to-me button CSS');

  // NOTE: the DELETE …/attributes endpoint + clearVote service method were
  // REINTRODUCED (with a different purpose — the PM view's drag-to-Unassigned
  // gesture) by the PM drag-and-drop feature. Their presence is covered by
  // tests/topic-attributes.test.js (clearVote flow) and dev-pm-order.test.js;
  // the old "these are removed" guards no longer apply.
});

// #600: staging seeds make BOTH assignee-dropdown states reviewable via
// ?demo=1 — one card the viewer already voted on (dropdown opens empty,
// their pick checked) and unassigned rows (dropdown pre-fills their name).
test('staging seeds cover both assignee-dropdown states', () => {
  const issuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf-8');
  assert.match(issuesSrc, /myValue: viewer/, 'an issue mock is assigned to the viewer');
  assert.match(issuesSrc, /req\.user && req\.user\.username/, 'the viewer name is sourced from req.user');

  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf-8');
  assert.match(votesSrc, /function stagingMockProposals\(viewer\)/, 'proposal mock accepts the viewer');
  assert.match(votesSrc, /stagingMockProposals\(req\.user\?\.username\)/, 'feed passes the viewer through');
});

// Style guard: the chips must reuse the shared card-badge pill recipe and
// must NOT drift into a bespoke look (e.g. the old brightness-filter hover).
test('chips reuse the sibling-badge pill recipe + tint-deepening hover', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  // Every chip in a card's badge row shares ONE geometry class now — the row
  // used to mix three sizes, each computing its own height from its own
  // padding + line-height. The utility classes supply only the tint.
  const cardTsx = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
    'features', 'dev-board', 'card', 'dev-card.tsx'), 'utf-8');
  assert.match(cardTsx, /`attr-chip dev-badge \$\{b\.cls\}/,
    'chip base uses the shared badge geometry class');
  assert.match(cardTsx, /dev-chat-badge dev-badge /, 'the 💬 badge shares it too');
  assert.match(fe, /'dev-badge font-mono bg-violet/, 'and so do the linked-issue chips');
  // #1112: the work-state chip picks its tint from a table (it has five of
  // them now), so its class list is composed rather than a single literal —
  // but it still leads with the same shared geometry class, and every tint in
  // the table is the same `bg-<hue>-500/10 text-<hue>-…` badge recipe.
  assert.match(fe, /cls: `dev-badge \$\{tone\}`/, 'the work-state chip leads with dev-badge');
  const toneTable = fe.slice(fe.indexOf('_WORK_TONE_CLS:'), fe.indexOf('_WORK_TONE_HOVER:'));
  assert.match(toneTable, /sky: 'bg-sky-500\/10 text-sky-700 dark:text-sky-400'/, 'sky tint is the badge recipe');
  for (const line of toneTable.split('\n')) {
    // The contrast pass gave every light ink a dark partner, so a tint is a
    // PAIR now. Both halves must still name the same hue — that is the
    // recipe, and a mismatched partner is exactly the drift this guards.
    const tint = line.match(/'(bg-[a-z]+-500\/10 text-[a-z]+-[0-9]{3}(?: dark:text-[a-z]+-[0-9]{3})?)'/);
    if (tint) {
      assert.match(tint[1], /^bg-([a-z]+)-500\/10 text-\1-[0-9]{3}(?: dark:text-\1-[0-9]{3})?$/,
        `off-recipe tint: ${tint[1]}`);
    }
  }
  assert.match(fe, /bg-zinc-500\/10 text-zinc-500/, 'muted placeholder uses the badge muted tint');
  // Hover deepens the same tint (like the linked-issue pills), not a filter.
  assert.match(fe, /hover:bg-(red|amber|sky|violet|zinc)-500\/20/, 'interactive chip uses tint-deepening hover');
  assert.doesNotMatch(fe, /hover:brightness-110/, 'no leftover brightness-filter hover');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf-8');
  const block = css.slice(css.indexOf('.attr-chip {'), css.indexOf('button.attr-chip'));
  // font-FAMILY, never the `font` shorthand: this rule follows .dev-badge at
  // equal specificity, and the shorthand resets font-size/weight/line-height
  // to their initial values — which is how the chips ended up rendering at
  // the card's 14px body text inside a 20px box. See dev-chip-geometry.test.js.
  assert.match(block, /font-family:\s*inherit/, '.attr-chip inherits the surrounding font family');
  assert.doesNotMatch(block, /(^|[\s;{])font:\s/, 'and never the size-clobbering shorthand');
  assert.match(block, /appearance:\s*none/, '.attr-chip strips native button appearance');
  // The shared box: one height for every chip in the row, so they sit on a
  // single baseline instead of each being sized by its own content.
  const badge = css.slice(css.indexOf('.dev-badge {'), css.indexOf('button.dev-badge'));
  assert.match(badge, /height:\s*20px/, 'one fixed chip height');
  assert.match(badge, /box-sizing:\s*border-box/);
  assert.match(badge, /font-size:\s*10\.5px/);
});
