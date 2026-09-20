// Completed-challenge deep link (#982):
// #leaderboard/challenges/<eventId>/<challengeId>.
//
// WHAT THIS PINS. The profile's completed list renders each row as a real
// anchor to that address. Making the anchor is the easy half; the address
// only means anything if the router carries BOTH ids through to the pane,
// and the pane holds the request until the grid it needs has actually been
// fetched. The pane is mounted by the section switch that comes AFTER the
// route is resolved, so nothing can be opened at route time — the request
// has to survive a mount and a fetch, and then be spent exactly once.
//
// Three layers:
//   1. Behavioural — the shipped topochain-challenges.js runs in a vm with a
//      DOM shim (same idiom as tests/estimator-card-render.test.js), driven
//      through the real openFromHash/_renderGrid path.
//
//      #1191 slice 6 conversion 7 made #challenges-root a React island, so
//      the pane no longer touches the DOM: the overlay it opens is a
//      descriptor pushed into topochain-challenges-store.js, and this file
//      plants a minimal stand-in for that store and reads `detail` off it.
//      That is why the module must stay import-free — vm.runInContext has no
//      module loader, and running the REAL file is the whole point of layer 1.
//   2. Static — the router in app.js parses the segments and hands them
//      over before the section mounts.
//   3. Static — the profile anchors point at the shape all of the above
//      expects.
//
// Run with: node --test tests/challenge-deep-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8'
);
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
// #1191 slice 6 split the profile screen into a shaping module and a view:
// the address is built in profile-store.js's completedView, and the anchor
// that carries it is rendered in profile-view.tsx.
const profileStoreJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/profile/profile-store.js'), 'utf8');
const profileViewTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/profile/profile-view.tsx'), 'utf8');

// ── Shims: a store stand-in, and just enough DOM for what is left ──────

function makeElement(id) {
  const el = {
    id,
    innerHTML: '',
    dataset: {},
    style: {},
    _classes: new Set(),
    addEventListener() {},
    appendChild() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

// A pane wired to a fixed challenge list, with the event bar stubbed to the
// real one's contract: select() is a NO-OP when the id is unchanged, which
// is precisely the case the deep link has to cope with on its own.
function loadPane({ challenges, eventId = null }) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const subs = [];
  const context = {
    eventId,
    select(id) {
      if (id == null || id === context.eventId) return; // real no-op branch
      context.eventId = id;
      context.notify();
    },
    onChange(fn) { subs.push(fn); return () => {}; },
    // The bar notifies on a user pick AND once at the end of its own
    // initial loadEvents() — the second one carries no change at all.
    notify() { for (const fn of subs) fn(context.eventId); },
  };

  const sandbox = {
    document: {
      getElementById: byId,
      createElement: (tag) => makeElement(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { TopochainEventContext: context },
    console,
    setTimeout,
    clearTimeout,
    location: { hash: '', search: '' },
    // The pane fetches its breakdown when a detail opens; keep it empty so
    // the assertions are about which challenge opened, not about the fetch.
    // It still has to be well-SHAPED: the breakdown renderer reads
    // `totals.participants` off the page, and that render lands after the
    // synchronous test body has returned, where a throw becomes an
    // unhandled rejection rather than a failed assertion.
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        success: true,
        data: String(url).includes('/breakdown')
          ? { entries: [], totals: { participants: 0, total_points: 0 }, has_more: false }
          : [],
      }),
    }),
  };
  sandbox.window.window = sandbox.window;
  // In a browser `window.X` IS a bare global, and the shipped code leans on
  // that: it feature-detects `window.TopochainEventContext` and then calls
  // `TopochainEventContext.select(...)` unqualified. Mirror it here or the
  // vm sees only half the pair.
  sandbox.TopochainEventContext = context;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });

  const pane = sandbox.window.TopochainChallenges;
  // What ./mount.ts plants in the browser, reduced to the two methods the
  // controller uses. `detail: null` is the shipped state — an overlay that has
  // never been opened — which is what the real store's initial value says too.
  const state = { mounted: false, grid: null, detail: null, profile: null };
  const store = {
    get: () => state,
    set: (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
  };
  pane._store = store;
  pane._open = true;
  pane._challenges = challenges;
  pane._challengesLoading = false;
  pane._loadedEventId = eventId;
  return { pane, context, byId, subs, store, sandbox };
}

const CH = [
  { id: 900500, completed: false, card_preview: { goal: 'Report a bug' } },
  { id: 900511, completed: true, card_preview: { goal: 'Share the announcement' } },
  { id: 900514, completed: true, card_preview: { goal: 'Vote five times' } },
];

// The detail overlay's visibility IS its descriptor since conversion 7: the
// component renders the root with `hidden` exactly when `detail` is null, so
// there is one source of truth instead of a class and a field that could
// disagree.
const overlayOpen = (store) => store.get().detail !== null;

// A pending link the PANE built was constructed inside the vm, so its
// prototype is the sandbox's Object.prototype and deepStrictEqual — which
// compares prototypes — rejects it against a host literal. Copy it into this
// realm first; the assertion is about the two ids, not about which realm
// allocated the wrapper.
const pending = (pane) =>
  (pane._pendingDeepLink ? { ...pane._pendingDeepLink } : pane._pendingDeepLink);

test('onboarding progress uses personal completion and explains the later unlocks', () => {
  const challenges = [1, 2, 3].map((id) => ({
    id, completed: true, progress: { done: id !== 1 },
    card_preview: { label: 'ONBOARDING', goal: `Step ${id}` },
  }));
  const { pane, store } = loadPane({ challenges, eventId: 10 });
  pane._onboarding = { total: 3, completed: 2, unlocked: false, event_id: 10 };
  pane._renderGrid();
  const grid = store.get().grid;
  assert.deepEqual({ ...grid.progress }, { done: 2, total: 3, caption: 'done in Get started' },
    'setup is its own scope while it gates the rest');
  assert.equal(grid.notice, 'Finish these to unlock the rest of the season.');
  assert.equal(grid.lockedCount, 0, 'no hidden_count in this payload, so no placeholder');
  assert.equal(grid.groups.length, 1);
  assert.equal(grid.groups[0].heading, 'Get started', 'the setup group’s heading (key `setup`)');
  assert.equal(grid.groups[0].cards[0].done, false, 'the organiser flag cannot finish a personal step');
});

test('unlocked challenge groups preserve each card’s detail target', () => {
  const challenges = [
    { id: 1, progress: { done: true }, card_preview: { label: 'ONBOARDING', goal: 'First step' } },
    { id: 4, card_preview: { label: 'PERSISTENT', goal: 'Prove your identity' } },
    { id: 6, card_preview: { label: 'WEEKLY', goal: 'Weekly task' } },
  ];
  const { pane, store } = loadPane({ challenges, eventId: 10 });
  pane._onboarding = { total: 3, completed: 3, unlocked: true, event_id: 10 };
  pane._renderGrid();
  const grid = store.get().grid;
  // The board's order (tests/challenge-groups.test.js): unlocked, Get started
  // goes last. The identity card is found by its group rather than by position.
  assert.deepEqual(Array.from(grid.groups, (g) => g.heading),
    ['This week', 'Always open', 'Get started']);
  const identity = grid.groups.find((g) => g.key === 'always').cards[0];
  pane._openIdx(identity.idx);
  assert.equal(pane._detailChallenge.id, 4);
  assert.equal('notice' in grid, false, 'unlocked, there is no notice');
});

test('a locked weekly event explains how to return to the introductory steps', () => {
  const { pane, store, context } = loadPane({ challenges: [], eventId: 11 });
  pane._onboarding = { total: 3, completed: 0, unlocked: false, event_id: 10 };
  pane._renderGrid();
  assert.equal(store.get().grid.kind, 'cards');
  assert.equal(store.get().grid.onboardingEventId, 10);
  pane._toOnboarding(10);
  assert.equal(context.eventId, 10);
});

// ─── 1. Behavioural ─────────────────────────────────────────────────────

test('a deep link opens that challenge once the grid paints', () => {
  // eventId already matches: select() no-ops, so nothing re-renders and the
  // request must be resolved against the grid as it already stands.
  const { pane, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._renderGrid();
  assert.equal(overlayOpen(store), false, 'nothing opens unprompted');

  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);
  assert.equal(overlayOpen(store), true);
  assert.equal(pane._pendingDeepLink, null, 'the request is spent');
});

test('a deep link registered before the pane loads survives until it does', () => {
  const { pane, context, store } = loadPane({ challenges: [], eventId: null });
  // The router resolves the address while the pane is still unmounted —
  // exactly what App._routeLeaderboard does before Leaderboard._setSection.
  pane._open = false;
  pane.openFromHash(900500, 900511);
  assert.equal(context.eventId, 900500, 'the event bar is pointed at the right event');
  assert.deepEqual(pending(pane), { eventId: 900500, challengeId: 900511 });

  // Mount + first paint.
  pane._open = true;
  pane._challenges = CH;
  pane._renderGrid();
  assert.equal(pane._detailChallenge?.id, 900511);
  assert.equal(overlayOpen(store), true);
});

test('a mid-reload render cannot spend the link on the previous event’s grid', () => {
  // loadChallenges() re-renders with _challengesLoading set while the OLD
  // event's rows are still in _challenges. Matching against those could open
  // a challenge from the wrong event — or burn the request on a list the
  // target was never in.
  const { pane, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  pane.openFromHash(900502, 900777);
  pane._open = true;

  pane._challengesLoading = true;
  pane._renderGrid();
  assert.deepEqual(pending(pane), { eventId: 900502, challengeId: 900777 },
    'still pending — that grid was not the one it asked for');
  assert.equal(overlayOpen(store), false);
});

test('a grid for a DIFFERENT event leaves the link armed', () => {
  // The other half of the same guard: the pane can finish a render for the
  // event the viewer was already on while the requested one is still in
  // flight. State is set directly here because the sequence — request for
  // 900502, bar back on 900500 — is a race no public call reproduces in
  // order.
  const { pane, context, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._pendingDeepLink = { eventId: 900502, challengeId: 900514 };
  context.eventId = 900500;
  pane._challengesLoading = false;
  pane._renderGrid();
  assert.deepEqual(pending(pane), { eventId: 900502, challengeId: 900514 });
  assert.equal(overlayOpen(store), false,
    '900514 exists in THIS grid — resolving here would open the wrong event’s copy');
});

test('an unknown challenge id lands silently on the grid', () => {
  const { pane, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane.openFromHash(900500, 424242);
  assert.equal(overlayOpen(store), false, 'no overlay');
  assert.equal(pane._pendingDeepLink, null,
    'spent anyway — a missing id must not fire later against another event');
  assert.equal(pane._challengesError, null, 'and no error state');
});

test('an event with no challenges retires the link instead of holding it', () => {
  const { pane } = loadPane({ challenges: [], eventId: 900500 });
  pane.openFromHash(900500, 900514);
  pane._renderGrid(); // empty state
  assert.equal(pane._pendingDeepLink, null);
});

test('a bare event id selects the event and opens nothing', () => {
  const { pane, context, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane.openFromHash(900502, null);
  assert.equal(context.eventId, 900502);
  assert.equal(pane._pendingDeepLink, null);
  assert.equal(overlayOpen(store), false);
});

test('closing the pane drops an unresolved link', () => {
  const { pane } = loadPane({ challenges: [], eventId: null });
  pane._open = false;
  pane.openFromHash(900502, 900514);
  assert.ok(pane._pendingDeepLink);
  pane.close();
  assert.equal(pane._pendingDeepLink, null,
    'a link left armed would pop an overlay on some later, unrelated visit');
});

test('a redundant event notification does not tear down the open overlay', () => {
  // The event bar notifies once at the end of its own initial loadEvents(),
  // carrying the event the pane already loaded. Treating that as a change
  // closed the detail a beat after the deep link opened it — the link
  // rendered the right panel and then lost it, which reads as the feature
  // not working at all.
  const { pane, context, subs } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  let reloads = 0;
  pane.loadChallenges = () => { reloads += 1; pane._loadedEventId = context.eventId; };
  pane.open(); // the shipped subscription wiring
  assert.equal(subs.length, 1, 'the pane subscribed to the event bar');
  assert.equal(reloads, 1, 'and did its own first load');

  pane._challenges = CH;
  pane._challengesLoading = false;
  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);

  context.notify(); // same event — the initial loadEvents() tail
  assert.equal(reloads, 1, 'no redundant refetch');
  assert.equal(pane._detailChallenge?.id, 900514, 'and the overlay survives');
});

test('a real event switch still reloads and clears the overlay', () => {
  // The dedupe above must not blunt the case it sits next to.
  const { pane, context, subs } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  let reloads = 0;
  pane.loadChallenges = () => { reloads += 1; pane._loadedEventId = context.eventId; };
  pane.open();
  assert.equal(subs.length, 1);
  reloads = 0;

  pane._challenges = CH;
  pane._challengesLoading = false;
  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);

  context.select(900502); // a user pick in the event picker
  assert.equal(reloads, 1, 'the new event is fetched');
  assert.equal(pane._detailChallenge, null,
    'and the previous event’s detail is torn down');
});

test('the event list landing after the grid redraws the deadline lines, reloading and closing nothing', () => {
  // A deep link can load the grid before the event bar's list lands, and a
  // card's deadline falls back to that list's `ends_at`. The bar's tail
  // notification carries the same event, so it must redraw the cards in place.
  const { pane, context, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  let reloads = 0;
  pane.loadChallenges = () => { reloads += 1; pane._loadedEventId = context.eventId; };
  pane.open();
  pane._challenges = [{ id: 900500, completed: false, card_preview: { goal: 'Report a bug' } }];
  pane._challengesLoading = false;
  pane._renderGrid();
  const deadline = () => store.get().grid.groups[0].cards[0].deadline;
  assert.equal(deadline(), null, 'no event list yet: no line');
  pane.openFromHash(900500, 900500);

  context.selectedEvent = () => ({ id: 900500, ends_at: inHours(71) });
  context.notify(); // the list landed — same event
  assert.equal(reloads, 1, 'no refetch');
  assert.equal(deadline(), '3d left', 'the cards now say how long is left');
  assert.equal(pane._detailChallenge?.id, 900500, 'and the open overlay survives');
});

test('_loadedEventId tracks the event the grid belongs to', () => {
  assert.match(CHALLENGES_SRC,
    /TopochainChallenges\._loadedEventId = eventId;/,
    'loadChallenges records which event its list is for');
  const load = CHALLENGES_SRC.slice(CHALLENGES_SRC.indexOf('async loadChallenges()'));
  const assignAt = load.indexOf('_loadedEventId = eventId');
  const guardAt = load.indexOf('if (eventId == null)');
  assert.ok(assignAt > -1 && assignAt < guardAt,
    'it is recorded before the no-event early return, or a null event never clears it');
});

// ─── 1b. Behavioural: the card rail's three states ──────────────────────
//
// _stateOf decides what each card's rail says. The shapes below are the
// /challenges-api/challenges row (src/routes/topochain/mobile.js
// buildMobileChallengeItem): `activities` is the viewer's own ledger rows,
// `activities_total` their points, `metric` null unless configured.

// Fields copied out of the vm realm, for the same reason `pending` above does.
const stateOf = (pane, c) => {
  const r = pane._stateOf(c);
  return { state: r.state, stateLabel: r.stateLabel, fill: r.fill, earned: r.earned };
};
const rows = (n, points) => Array.from({ length: n }, () => ({ points }));

test('with no personalization, a card is New or Done from the public flag alone', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  assert.deepEqual(stateOf(pane, CH[0]),
    { state: 'new', stateLabel: 'Not started', fill: 0, earned: null });
  assert.deepEqual(stateOf(pane, CH[1]),
    { state: 'done', stateLabel: 'Done', fill: 1, earned: null },
    'an anonymous visitor sees the organiser flag, same as the tally');
});

test('a counted metric fills the rail by the viewer’s ledger rows', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([[900500, {
    id: 900500, activities_total: 600, activities: rows(3, 200),
    metric: { kind: 'apps_tested', label: 'tried', target: 8 },
  }]]);
  assert.deepEqual(stateOf(pane, CH[0]),
    { state: 'progress', stateLabel: '3/8 tried', fill: 0.375, earned: null });
});

test('block production with no ledger points says Not started, never a bare ring (#2492)', () => {
  // The real shape: block scores live in snapshots, never in user_activities,
  // so an active block producer's row has no activities at all. That used to
  // return an empty label and draw a dot with nothing beside it; the words
  // are the same ones Home has always shown for the same challenge.
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([[900500, {
    id: 900500, activities_total: 0, activities: [],
    metric: { kind: 'blocks_produced', label: 'blocks', target: 1 },
  }]]);
  assert.deepEqual(stateOf(pane, CH[0]),
    { state: 'new', stateLabel: 'Not started', fill: 0, earned: null });
});

test('the row’s own block count wins over the ledger fallback (#2492)', () => {
  // What the server now attaches: `progress` resolved from the viewer's
  // newest leaderboard snapshot, the same value Home's meter reads. The
  // counted branch prints it, so the tab and Home agree on the number.
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const block = {
    id: 900504, completed: false, card_preview: {},
    metric: { kind: 'blocks_produced', label: 'blocks', target: 500 },
    progress: { done: false, current: 180, target: 500 },
  };
  assert.deepEqual(stateOf(pane, block),
    { state: 'progress', stateLabel: '180/500 blocks', fill: 0.36, earned: null });
});

test('before personalization lands, a block challenge says Not started too', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const block = { id: 900504, completed: false, activity_type: { metric_type: 'blocks_produced', metric_label: 'blocks' }, card_preview: {} };
  assert.deepEqual(stateOf(pane, block), { state: 'new', stateLabel: 'Not started', fill: 0, earned: null },
    'first paint and a failed personalization fall back to the ledger, which a block card never has');
});

test('ledger-credited block production and yes/no challenges are indeterminate, labelled Started', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([
    [900500, {
      // An organiser's extra-points row: the only way blocks reach the ledger.
      id: 900500, activities_total: 1200, activities: rows(1, 1200),
      metric: { kind: 'blocks_produced', label: 'blocks', target: 500 },
    }],
    [900514, { id: 900514, activities_total: 300, activities: rows(1, 300), metric: null }],
  ]);
  assert.deepEqual(stateOf(pane, CH[0]),
    { state: 'progress', stateLabel: 'Started', fill: null, earned: null },
    'the row count is not a block count, so no fill');
  const ch = { id: 900514, completed: false, card_preview: { goal: 'Vote five times' } };
  assert.deepEqual(stateOf(pane, ch),
    { state: 'progress', stateLabel: 'Started', fill: null, earned: null });
});

test('points decide an uncounted challenge; rows are the count of a counted one, as on Home', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([[900500, {
    id: 900500, activities_total: 0, activities: rows(2, 0),
    metric: { kind: 'apps_tested', label: 'tried', target: 8 },
  }]]);
  assert.deepEqual(stateOf(pane, CH[0]),
    { state: 'progress', stateLabel: '2/8 tried', fill: 0.25, earned: null },
    'two ledger rows are two of eight whatever they paid — Home’s server count is the same COUNT(*)');
  pane._mine = new Map([[900500, { id: 900500, activities_total: 0, activities: rows(2, 0), metric: null }]]);
  assert.deepEqual(stateOf(pane, CH[0]), { state: 'new', stateLabel: 'Not started', fill: 0, earned: null },
    'points, not rows, for a yes-or-no challenge — the Flutter rule');
  pane._mine = new Map([[900500, {
    id: 900500, activities_total: 0, activities: [], metric: { kind: 'count', label: 'votes', target: 1 },
  }]]);
  assert.equal(stateOf(pane, CH[0]).stateLabel, 'Not started', 'a target of one is a yes-or-no');
  assert.equal(pane._stateOf(CH[0]).counted, false);
});

test('a counted challenge shows its count before personalization lands, and signed out', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const counted = {
    id: 7, completed: false, card_preview: {},
    activity_type: { metric_type: 'apps_tested', metric_target: 8, metric_label: 'tried' },
    metric: { kind: 'apps_tested', target: 8, label: 'tried' },
  };
  assert.deepEqual(stateOf(pane, counted), { state: 'new', stateLabel: '0/8 tried', fill: 0, earned: null },
    'the public row’s effective metric, with no personalization row');
  assert.equal(pane._stateOf(counted).counted, true);
  // An organiser override on the challenge row wins over the template for
  // EVERY viewer — the public row's `metric` is the effective one, so a
  // signed-out visitor never sees the template's target.
  const overriddenToYesNo = { ...counted, metric: { kind: 'count', target: 1, label: 'votes' } };
  assert.equal(stateOf(pane, overriddenToYesNo).stateLabel, 'Not started', 'template 8, override 1: a yes-or-no');
  const overriddenToCounted = {
    ...counted, activity_type: { metric_type: null, metric_target: null, metric_label: null },
    metric: { kind: 'count', target: 3, label: 'votes' },
  };
  assert.equal(stateOf(pane, overriddenToCounted).stateLabel, '0/3 votes', 'no template metric, override 3: counted');
  pane._mine = new Map([[7, {
    id: 7, activities_total: 400, activities: rows(2, 200),
    metric: { kind: 'apps_tested', label: 'apps tried', target: 5 },
  }]]);
  assert.equal(stateOf(pane, counted).stateLabel, '2/5 apps tried', 'and the override-aware row wins once it lands');
});

test('a finished challenge the viewer scored on says what they earned', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([[900511, { id: 900511, activities_total: 1000, activities: rows(1, 1000) }]]);
  assert.deepEqual(stateOf(pane, CH[1]),
    { state: 'done', stateLabel: 'Done', fill: 1, earned: 'Earned 1,000 pts' });
});

test('the task is not on the card; the detail overlay carries it in full, never a tooltip', () => {
  const ch = [{ id: 1, completed: false, card_preview: { goal: 'Try apps', task: 'Open three apps from the directory and use each one' } }];
  const { pane, store } = loadPane({ challenges: ch, eventId: 900500 });
  pane._renderGrid();
  assert.equal(store.get().grid.groups[0].cards[0].task, undefined, 'the card is title and rail only');
  pane._openIdx(0);
  assert.equal(store.get().detail.task, 'Open three apps from the directory and use each one',
    'a tap reveals the task the card leaves out');
  const paneSrc = require('node:fs').readFileSync(
    require('node:path').join(root, 'frontend/src/features/leaderboard/challenges-pane.tsx'), 'utf8');
  // `<SectionHeading title=…/>` is @/components/ui/field's PROP, not the DOM
  // attribute of the same name: it renders the heading's visible text. Strip
  // those and the blunt rule below still catches a real tooltip.
  const noHeadings = paneSrc.replace(/<SectionHeading[\s\S]*?\/>/g, '');
  assert.doesNotMatch(noHeadings, /title=\{/,
    'a phone has no hover: nothing on this screen may live only in a title attribute');
});

test('per-viewer progress on the public row drives the rail, blocks included', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const blocks = {
    id: 1, completed: false, activity_type: { metric_label: 'blocks' },
    progress: { done: false, current: 180, target: 500 }, card_preview: { goal: 'Join block production' },
  };
  assert.deepEqual(stateOf(pane, blocks),
    { state: 'progress', stateLabel: '180/500 blocks', fill: 0.36, earned: null },
    'the platform counted snapshot blocks, so the board’s own label appears');
  pane._mine = new Map([[7, { id: 7, activities_total: 400, activities: rows(2, 200), metric: { kind: 'apps_tried', label: 'apps tried', target: 5 } }]]);
  const overridden = {
    id: 7, completed: false, activity_type: { metric_label: 'blocks' },
    progress: { done: false, current: 2, target: 5 }, card_preview: {},
  };
  assert.equal(stateOf(pane, overridden).stateLabel, '2/5 apps tried',
    'the unit follows the challenge-row override, like the count does');
  pane._mine = new Map();
  const untouched = { id: 2, completed: false, progress: { done: false, current: 0, target: 1 }, card_preview: {} };
  assert.deepEqual(stateOf(pane, untouched),
    { state: 'new', stateLabel: 'Not started', fill: 0, earned: null },
    'with progress present, Not started is a counted fact, not a guess');
  assert.equal(pane._stateOf(untouched).counted, false, 'a yes-or-no rail draws no bar');
  const binary = { id: 3, completed: false, progress: { done: false, current: null, target: null }, card_preview: {} };
  assert.equal(stateOf(pane, binary).stateLabel, 'Not started');
  // A COUNTED challenge shows its count from zero — "0/3 Apps tried", which is
  // what an anonymous visitor to Pre Season 2 gets for "Try Three Apps".
  const zero = {
    id: 6, completed: false, activity_type: { metric_label: 'Apps tried' },
    progress: { done: false, current: 0, target: 3 }, card_preview: {},
  };
  assert.deepEqual(stateOf(pane, zero),
    { state: 'new', stateLabel: '0/3 Apps tried', fill: 0, earned: null },
    'a challenge with steps never reads as a plain Not started');
  assert.equal(pane._stateOf(zero).counted, true, 'and its rail draws the bar from zero');
  assert.equal(pane._stateOf(blocks).counted, true);
  const mineDone = { id: 4, completed: false, progress: { done: true, current: 1, target: 1 }, card_preview: {} };
  assert.equal(stateOf(pane, mineDone).state, 'done', 'Done is the viewer’s own when progress says so');
  const archived = { id: 5, completed: true, progress: { done: false, current: 0, target: 3 }, card_preview: {} };
  assert.equal(stateOf(pane, archived).state, 'new',
    'an organiser archive flag does not mark the viewer’s onboarding step done');
});

// The deadline line's words, pinned by the same table as HomePanels.timeLeft
// in tests/home-panels-render.test.js, so both surfaces say one thing.
const TIME_LEFT = [
  [0.2, '1h left'], [7.5, '8h left'], [23, '23h left'], [23.5, '1d left'],
  [25, '2d left'], [71, '3d left'], [5 * 24 - 1, '5d left'], [-1, null],
];
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

test('an open card says how long it has left: its own end, else the event’s', () => {
  const { pane, context } = loadPane({ challenges: CH, eventId: 900500 });
  context.selectedEvent = () => ({ id: 900500, ends_at: inHours(71) });
  const open = { id: 900500, completed: false, card_preview: { goal: 'Report a bug' } };
  assert.equal(pane.cardView(open, 0).deadline, '3d left', 'the event’s end when the challenge sets none');
  const own = { ...open, effective: { schedule_end: inHours(23) } };
  assert.equal(pane.cardView(own, 0).deadline, '23h left', 'the challenge’s own end wins');
  assert.equal(pane.cardView(CH[1], 1).deadline, null, 'a finished card counts down to nothing');
  const notYet = { ...open, effective: { schedule_start: inHours(20), schedule_end: inHours(71) } };
  assert.equal(pane.cardView(notYet, 0).deadline, null, 'not open yet: no countdown, as on Home');
  const closedStep = { ...open, completed: true, progress: { done: false, current: 0, target: 3 } };
  assert.equal(pane.cardView(closedStep, 0).deadline, null,
    'an organiser-closed step the viewer never finished: no countdown either');
  context.selectedEvent = () => ({ id: 900500, ends_at: inHours(-5) });
  assert.equal(pane.cardView(open, 0).deadline, null, 'an ended event gives no line');
  delete context.selectedEvent;
  assert.equal(pane.cardView(open, 0).deadline, null, 'and no event known, no line');
  for (const [h, want] of TIME_LEFT) assert.equal(pane._timeLeft(inHours(h)), want, `${h}h`);
  assert.equal(pane._timeLeft('not a date'), null);
  assert.equal(pane._timeLeft(null), null);
});

// The template's illustration rides both descriptors as a slug of the
// registry's SHAPE, else null. Membership is the components' to decide
// (frontend/src/lib/challenge-illustrations.ts), and the controller never
// builds a path from it.
test('card and page descriptors carry the illustration only when it is slug-shaped', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const withArt = (illustration) => ({ id: 900500, completed: false, card_preview: { goal: 'Report a bug', illustration } });
  const pageOf = (c) => { pane._detailChallenge = c; return pane.detailView(); };
  const CASES = [
    ['useful-feedback', 'useful-feedback', 'a registry slug passes through'],
    ['not-in-the-registry', 'not-in-the-registry', 'a well-shaped unknown slug too: the registry is the component’s'],
    ['a'.repeat(64), 'a'.repeat(64), 'the longest slug the column holds'],
    [`u-${'0a'.repeat(16)}`, `u-${'0a'.repeat(16)}`, 'an uploaded slug is slug-shaped too: the path is the registry’s to derive'],
    ['a'.repeat(65), null, 'one longer is malformed'],
    ['../icons/x.svg', null, 'a path is not a slug'],
    ['Useful-Feedback', null, 'nor is an uppercase one'],
    ['-useful', null, 'nor a leading hyphen'],
    ['', null, 'empty'],
    [42, null, 'not a string'],
    [null, null, 'cleared'],
    [undefined, null, 'missing'],
  ];
  for (const [input, want, why] of CASES) {
    assert.equal(pane.cardView(withArt(input), 0).illustration, want, `card: ${why}`);
    assert.equal(pageOf(withArt(input)).illustration, want, `page: ${why}`);
  }
  assert.equal(pane.cardView({ id: 7, completed: false }, 0).illustration, null, 'no card_preview at all');
  assert.equal(pageOf({ id: 7, completed: false }).illustration, null);
  pane._detailChallenge = null;
  assert.doesNotMatch(CHALLENGES_SRC, /\/illustrations\//, 'the controller never spells the static path');
  assert.doesNotMatch(CHALLENGES_SRC, /\/challenge-illustrations\//, 'nor the uploaded one');
});

// An uploaded illustration's tone rides beside the slug as
// `card_preview.illustration_tone`: a lowercase word of a tone name's length,
// else null. Whether it is one of the TONES is the registry's to decide (it
// draws an unknown one on gray), so a well-shaped unknown word passes.
test('card and page descriptors carry the illustration tone only when it is tone-shaped', () => {
  const { pane } = loadPane({ challenges: CH, eventId: 900500 });
  const withTone = (illustration_tone) => ({
    id: 900500, completed: false,
    card_preview: { goal: 'Report a bug', illustration: `u-${'0a'.repeat(16)}`, illustration_tone },
  });
  const pageOf = (c) => { pane._detailChallenge = c; return pane.detailView(); };
  const CASES = [
    ['teal', 'teal', 'a tone passes through'],
    ['cream', 'cream', 'another'],
    ['magenta', 'magenta', 'a well-shaped unknown word too: TONES are the registry’s'],
    ['abcdefghij', 'abcdefghij', 'ten letters, the longest shape'],
    ['abcdefghijk', null, 'eleven is not a tone'],
    ['ab', null, 'nor two'],
    ['Teal', null, 'nor an uppercase one'],
    ['te-al', null, 'nor anything but letters'],
    ['home-tone-teal', null, 'nor a class name'],
    ['', null, 'empty'],
    [3, null, 'not a string'],
    [null, null, 'a built-in, which sends none'],
    [undefined, null, 'missing'],
  ];
  for (const [input, want, why] of CASES) {
    assert.equal(pane.cardView(withTone(input), 0).illustrationTone, want, `card: ${why}`);
    assert.equal(pageOf(withTone(input)).illustrationTone, want, `page: ${why}`);
  }
  assert.equal(pane.cardView({ id: 7, completed: false }, 0).illustrationTone, null, 'no card_preview at all');
  assert.equal(pageOf({ id: 7, completed: false }).illustrationTone, null);
  pane._detailChallenge = null;
});

// The progress over the grid (ITERATION 03): "N/M done in <event>", scoped to
// the selected event once the bar's list has it.
test('the grid opens on its progress: the tally, scoped to the selected event', () => {
  const { pane, context, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._renderGrid();
  assert.deepEqual({ ...store.get().grid.progress }, { done: 2, total: 3, caption: 'done' },
    'no event known yet: the bare tally');
  context.selectedEvent = () => ({ id: 900500, name: 'Season 2' });
  pane._renderGrid();
  assert.equal(store.get().grid.progress.caption, 'done in Season 2');
  context.selectedEvent = () => ({ id: 900500, name: '  ' });
  pane._renderGrid();
  assert.equal(store.get().grid.progress.caption, 'done', 'a blank name is left out');
  assert.equal(store.get().grid.points, undefined, 'and it carries no points');
  delete context.selectedEvent;
});

test('the grid’s card descriptors carry the rail and never re-sort by it', () => {
  const { pane, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane._mine = new Map([[900500, { id: 900500, activities_total: 50, activities: rows(1, 50) }]]);
  pane._renderGrid();
  const cards = store.get().grid.groups.flatMap((g) => g.cards);
  // Array.from, not .map: the grid's arrays were allocated in the vm realm.
  assert.deepEqual(Array.from(cards, (c) => [c.idx, c.state]),
    [[0, 'progress'], [1, 'done'], [2, 'done']],
    'state rides on the card; the flat order is still _ordered()’s');
  assert.equal(cards[0].stateLabel, 'Started');
  for (const c of cards) {
    assert.ok(!/In progress/.test(c.stateLabel), 'the icon carries the state, the words never repeat it');
  }
});

// ─── The detail page (ITERATION 03) ─────────────────────────────────────
//
// The detail is a page now, so a tap gives it an address and a history entry:
// the phone's back gesture pops it, the back disc spends it, and the router's
// answer to the push must not reset the page it just opened.

test('a card tap opens the page and pushes its address; leaving the address closes it', () => {
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  pane._openIdx(0);
  const first = pane._ordered()[0];
  assert.equal(store.get().detail.key, String(first.id));
  assert.equal(sandbox.location.hash, `#leaderboard/challenges/900500/${first.id}`,
    'the tap pushes the page’s own deep-link address');
  const opened = store.get().detail;
  pane.openFromHash(900500, Number(first.id));
  assert.equal(store.get().detail, opened,
    'the router resolving that address again leaves the open page untouched');
  sandbox.location.hash = '#leaderboard/challenges';
  pane._onHashChange();
  assert.equal(store.get().detail, null, 'the back gesture’s hashchange closes the page');
});

test('the back disc spends the pushed entry; a page without one just closes', () => {
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  let backs = 0;
  sandbox.window.history = { back() { backs += 1; } };
  pane._openIdx(0);
  pane._backFromDetail();
  assert.equal(store.get().detail, null, 'closed at once, not on a later hashchange');
  assert.equal(backs, 1, 'and the history step the tap added is taken back');
  sandbox.location.hash = '#leaderboard/challenges';
  pane.openChallengeDetail(CH[0]);
  pane._backFromDetail();
  assert.equal(store.get().detail, null);
  assert.equal(backs, 1, 'a page opened without an entry (?shot, a cold link) takes no history step');
});

test('a challenge address reached from another section opens a page that survives the section switch', () => {
  // Standings or Kudos showing, then Forward (or a pasted link) to a
  // challenge: the router opens the page first and switches section second,
  // and that switch replaceStates the address to #leaderboard/challenges.
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  sandbox.window.Leaderboard = { section: 'topochain' };
  sandbox.location.hash = '#leaderboard/challenges/900500/900500';
  pane.openFromHash(900500, 900500);
  assert.ok(store.get().detail, 'the page opens');
  assert.equal(pane._detailHash, null, 'but claims no entry the section switch is about to rewrite');
  sandbox.window.Leaderboard.section = 'challenges';
  sandbox.location.hash = '#leaderboard/challenges';
  pane._onHashChange({ newURL: 'https://example.test/#leaderboard/challenges/900500/900500' });
  assert.ok(store.get().detail, 'so the rewrite inside the same dispatch does not close it');
  pane._onHashChange({ newURL: 'https://example.test/#leaderboard' });
  assert.equal(store.get().detail, null, 'but a later move to another tab does');

  // Already on the Challenges tab, Forward to the same address: no switch
  // follows, and the page owns the entry as a tap would.
  const again = loadPane({ challenges: CH, eventId: 900500 });
  again.sandbox.window.Leaderboard = { section: 'challenges' };
  again.sandbox.location.hash = '#leaderboard/challenges/900500/900500';
  again.pane.openFromHash(900500, 900500);
  assert.equal(again.pane._detailHash, '#leaderboard/challenges/900500/900500');
  again.sandbox.location.hash = '#leaderboard/challenges';
  again.pane._onHashChange();
  assert.equal(again.store.get().detail, null, 'and Back closes it');
});

test('without an event id there is no address to push, and the page still opens', () => {
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: null });
  pane._openIdx(0);
  assert.ok(store.get().detail, 'the page opens');
  assert.equal(sandbox.location.hash, '', 'no unresolvable address is pushed');
  assert.equal(pane._detailHash, null);
});

test('the page descriptor: category, the card’s meta line, task, a clean rail', () => {
  const ch = {
    id: 5, completed: false,
    effective: { schedule_end: inHours(71) },
    card_preview: { label: 'ONBOARDING', goal: 'Join block production', task: 'Up to 2,000 pts a week', reward: '2000' },
    detail_modal: { description: 'Run a node.', requirements: 'A node reachable all week.', reward_logic: 'Points scale with blocks.' },
  };
  const { pane, store } = loadPane({ challenges: [ch], eventId: 900500 });
  pane.openChallengeDetail(ch);
  const d = store.get().detail;
  assert.equal(d.eyebrow, 'Get started',
    'a grouped page names its group; Get started’s header has no clock, so the deadline stays on the meta line');
  assert.equal(d.deadline, '3d left', 'in the card’s words, from the card’s rule');
  assert.equal(d.goal, 'Join block production');
  assert.equal(d.task, 'Up to 2,000 pts a week');
  assert.equal(d.description, 'Run a node.');
  assert.equal(d.requirements, 'A node reachable all week.');
  assert.equal(d.scoring, 'Points scale with blocks.', 'reward logic reads as Scoring');
  assert.deepEqual([d.state, d.stateLabel, d.fill, d.counted], ['new', 'Not started', 0, false]);
  assert.deepEqual({ ...d.amount }, { text: '2000 pts', earned: false }, 'nothing scored yet: the reward on offer');
  assert.equal(d.participants, 'Participants', 'no count before the breakdown lands');
  assert.equal(d.pointsTotal, null);
  for (const retired of ['label', 'mineNote', 'rewardLogic', 'totals', 'chip']) {
    assert.equal(retired in d, false, `${retired} retired from the descriptor`);
  }

  pane._mine = new Map([[5, { id: 5, activities_total: 720, activities: rows(3, 240) }]]);
  pane._renderDetailOverlay();
  assert.deepEqual({ ...store.get().detail.amount }, { text: '720 pts so far', earned: false },
    'the contribution line retired into the meta line');

  ch.completed = true;
  pane._renderDetailOverlay();
  const done = store.get().detail;
  assert.deepEqual({ ...done.amount }, { text: 'Earned 720 pts', earned: true });
  assert.equal(done.deadline, null, 'a finished challenge counts down to nothing, as on the card');

  ch.completed = false;
  ch.effective.schedule_end = inHours(-1);
  pane._renderDetailOverlay();
  assert.equal(store.get().detail.deadline, null, 'an ended challenge shows no time left');
});
test('participants: count and total in the heading row, "Show all" only when one page finishes it', () => {
  const { pane, store } = loadPane({ challenges: CH, eventId: 900500 });
  pane.openChallengeDetail(CH[0]);
  pane._breakdownLoading = false;
  pane._breakdown = {
    entries: Array.from({ length: 25 }, (_, i) => ({ user_id: i + 1, display_name: `P${i}`, points: 2000 - i, rate: null })),
    totals: { participants: 34, total_points: 12800 },
    has_more: true,
    next_offset: 25,
  };
  pane._renderDetailOverlay();
  let d = store.get().detail;
  assert.equal(d.participants, 'Participants · 34');
  assert.equal(d.pointsTotal, '12,800 pts between them');
  assert.equal(d.moreLabel, 'Show all 34 →');
  assert.equal(d.entries.rows[0].points, '2,000 pts');

  pane._breakdown = { ...pane._breakdown, totals: { participants: 200, total_points: 0 } };
  pane._renderDetailOverlay();
  d = store.get().detail;
  assert.equal(d.moreLabel, 'Show more →', 'beyond one more page, "all" would overpromise');
  assert.equal(d.pointsTotal, null);
});

test('the page is a level of the screen: the platform header is its nav bar', () => {
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  const calls = [];
  sandbox.window.App = {
    setBackIcon: (mode, href) => calls.push(['back', mode, href ?? null]),
    setHeaderTitle: (title) => calls.push(['title', title]),
  };
  sandbox.window.Leaderboard = { isOpen: () => true, section: 'challenges' };
  pane._openIdx(0);
  assert.deepEqual(calls.splice(0), [['back', 'arrow', '#leaderboard/challenges'], ['title', 'Challenge']],
    'the header chevron points up to the grid and the title is the generic word; the page names the challenge');
  assert.equal(pane.handleBack(), true, 'on a page the header chevron is claimed');
  assert.equal(store.get().detail, null, 'and goes up a level');
  assert.deepEqual(calls.splice(0), [['back', 'home', null], ['title', 'Leaderboard']],
    'the screen gets its own chrome back');
  assert.equal(pane.handleBack(), false, 'on the grid the chevron is not the page’s to claim');
});

test('a page closed by navigating away never retitles the screen being entered', () => {
  const { pane, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  const calls = [];
  sandbox.window.App = { setBackIcon: () => calls.push('back'), setHeaderTitle: () => calls.push('title') };
  sandbox.window.Leaderboard = { isOpen: () => true, section: 'challenges' };
  pane._openIdx(0);
  calls.length = 0;
  sandbox.window.Leaderboard = { isOpen: () => false, section: 'challenges' };
  sandbox.location.hash = '#profile';
  pane._onHashChange();
  assert.deepEqual(calls, [], 'the Leaderboard is not on show: its chrome is not restored over another screen');
});

test('back from a page reached from elsewhere in the app returns there; a cold page goes up to the grid', () => {
  // Home's challenge card: the page owns no entry (the section switch rewrote
  // the address), and Home is the route below it.
  const { pane, store, sandbox } = loadPane({ challenges: CH, eventId: 900500 });
  let backs = 0;
  sandbox.window.history = { back() { backs += 1; } };
  sandbox.window.App = { previousRoute: () => '' };
  sandbox.location.hash = '#leaderboard/challenges';
  pane.openChallengeDetail(CH[0]);
  assert.equal(pane.handleBack(), true);
  assert.equal(backs, 1, 'back to Home, where the viewer came from');
  assert.ok(store.get().detail, 'the page closes as the address moves off it, not before');

  // A cold arrival (bookmark, ?shot): nothing of ours below.
  const cold = loadPane({ challenges: CH, eventId: 900500 });
  let coldBacks = 0;
  cold.sandbox.window.history = { back() { coldBacks += 1; } };
  cold.sandbox.window.App = { previousRoute: () => null };
  cold.pane.openChallengeDetail(CH[0]);
  assert.equal(cold.pane.handleBack(), true);
  assert.equal(coldBacks, 0, 'no step back out of the app');
  assert.equal(cold.store.get().detail, null, 'up to the grid instead');

  // A card tap owns its entry: up to the grid, spending it, even with a route below.
  const tap = loadPane({ challenges: CH, eventId: 900500 });
  let tapBacks = 0;
  tap.sandbox.window.history = { back() { tapBacks += 1; } };
  tap.sandbox.window.App = { previousRoute: () => '#leaderboard/challenges' };
  tap.pane._openIdx(0);
  assert.equal(tap.pane.handleBack(), true);
  assert.equal(tap.store.get().detail, null, 'closed at once');
  assert.equal(tapBacks, 1, 'and the pushed entry is spent');
});

// ─── 2. Static: the router carries both ids ─────────────────────────────

test('the hash router parses #leaderboard/challenges/<event>/<challenge>', () => {
  assert.match(appJs, /const challengeTarget = parts\[1\] === 'challenges' && parts\[2\]/);
  assert.match(appJs, /eventId: App\._numericSegment\(parts\[2\]\)/);
  assert.match(appJs, /challengeId: App\._numericSegment\(parts\[3\]\)/);
  assert.match(appJs, /App\.navigateToLeaderboard\(parts\[1\], profileUser, challengeTarget\)/);
});

test('a non-numeric segment degrades to the plain screen', () => {
  const start = appJs.indexOf('_numericSegment(raw)');
  const body = appJs.slice(start, appJs.indexOf('\n  },', start));
  assert.match(body, /Number\.isSafeInteger\(n\) && n > 0 \? n : null/,
    'BIGINT-backed event and challenge ids remain valid while unsafe values cannot reach fetch URLs');
});

test('the target is threaded through both navigateToLeaderboard paths', () => {
  // The already-mounted fast path and the cold screen-swap path each call
  // _routeLeaderboard; a target dropped on either one makes the deep link
  // work only on a full page load, or only on an in-app click.
  const calls = appJs.match(
    /App\._routeLeaderboard\(sub, profileUser, challengeTarget\)/g
  ) || [];
  assert.equal(calls.length, 2, 'both the mounted and the cold path pass it on');
  assert.match(appJs, /navigateToLeaderboard\(sub, profileUser, challengeTarget\)/);
  assert.match(appJs, /_routeLeaderboard\(sub, profileUser, challengeTarget\)/);
});

test('the pane is told BEFORE the section mounts', () => {
  // The DEFINITION, not one of the two call sites above it.
  const start = appJs.indexOf('\n  _routeLeaderboard(sub, profileUser, challengeTarget) {');
  assert.ok(start > 0, '_routeLeaderboard must take the target');
  const body = appJs.slice(start, appJs.indexOf('\n  },', start));
  const handoff = body.indexOf('TopochainChallenges.openFromHash');
  const mount = body.indexOf('Leaderboard._setSection(sub)');
  assert.ok(handoff > -1 && mount > -1);
  assert.ok(handoff < mount,
    'selecting the event after the mount would load the default event, then throw it away');
  assert.match(body, /window\.TopochainChallenges\?\.openFromHash/,
    'feature-detected — the pane script may not be present on every shell build');
});

// ─── 3. Static: the anchors point at that address ───────────────────────

test('the profile links each completed challenge to <event>/<challenge>', () => {
  assert.match(profileStoreJs,
    /href: '#leaderboard\/challenges\/'\s*\n\s*\+ `\$\{encodeURIComponent\(c\.season_event_id\)\}\/\$\{encodeURIComponent\(c\.id\)\}`/,
    'both ids, in that order — the event id is what makes the challenge id resolvable');
  assert.match(profileViewTsx, /href=\{row\.href\}/,
    'the row renders as a real anchor to that address, not a click handler');
  assert.match(profileViewTsx, /data-completed-challenge=\{row\.id\}/);
});

test('the header back chevron asks the Challenges page first', () => {
  assert.match(appJs, /if \(App\._inLeaderboard && window\.TopochainChallenges\?\.handleBack\?\.\(\)\) return;/,
    'the same claim chain Settings, Admin and Browse use');
});
