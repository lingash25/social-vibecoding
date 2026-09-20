// Challenges pane of the Leaderboard screen — the season's challenge grid.
//
// This file was public/js/topochain-seasons.js (Task 14, the public
// seasons/events screen at #topochain/seasons). The leaderboard merge folded
// it, and the separate #challenges screen (the deleted public/js/challenges.js),
// into the Leaderboard screen's third tab:
//   - the event picker + hero it used to render itself moved UP into the
//     shared bar owned by ./topochain-event-context.js, so this pane
//     and the standings pane always describe the same event;
//   - the old #challenges screen's one unique contribution — YOUR OWN points
//     on each challenge — became a decoration on these (richer) cards, see
//     "personalization" below;
//   - its season-scope leaderboard block is gone: it was a thinner copy of the
//     standings tab, one tab over (#1917 retired the link that pointed there).
//
// Hosted in #challenges-root inside #leaderboard-screen (public/index.html);
// mounted/unmounted by the Leaderboard module (./leaderboard.js) when
// its section flips, not by a navigate* pair in app.js. The legacy
// #topochain/seasons and #challenges hashes both still land here — the router
// aliases them to #leaderboard/challenges.
//
// Mirrors the source `seasons-events/index` page's three overlays (SPEC
// §5.2/§5.5.1: challenge grid, challenge detail overlay, user profile
// overlay), served by /api/v4 endpoints:
//   - challenge grid: GET /season-events/:id/challenges (card_preview fields).
//   - challenge detail overlay: the SAME challenge's detail_modal fields
//     (already in hand from the grid fetch) + GET .../challenges/:cid/
//     breakdown for the participant list.
//   - user profile overlay: GET /users/:id/profile. Unlike the standings pane
//     (see that file's header comment for why it CAN'T do this for an
//     arbitrary row), the breakdown entries here carry a real `user_id`
//     (src/routes/topochain/public.js's challenge-breakdown route), so this
//     overlay opens for any participant a challenge's breakdown lists.
//
// PERSONALIZATION: on top of the public grid, a second fetch to
// GET /challenges-api/challenges?season_event_id=<id> (session-cookie authed,
// src/routes/topochain/mobile.js) supplies the viewer's own per-challenge
// points plus `featured`, keyed by the same challenges.id the public endpoint
// returns. It is strictly DECORATIVE: a 401/422/network failure leaves the
// public grid exactly as it rendered, with no error banner.
// The public response itself now applies onboarding before first paint and
// carries its progress, so a failed decoration request cannot reveal locked
// challenges or mistake an organiser's archive flag for personal completion.
//
// COMPLETION (#981): `completed` is a column on the challenges row — an
// organiser flag about the CHALLENGE ("this one is over"), not a per-user
// completion. The per-user signal is activities_total. This pane is now the
// HOME for that flag: the profile screen used to list the season's finished
// challenges and no longer does (see the header of
// frontend/src/features/profile/profile.js), so the grid groups them, counts
// them in a summary line and marks them on the card's progress rail.
//
// That is why `completed` is read from the PUBLIC row rather than from the
// personalization map it used to come from: the chip, the grouping and the
// count are all correct on FIRST PAINT and for an ANONYMOUS visitor, neither
// of which held while the flag arrived only with the session-authed pass.
// (`featured` still comes from that pass, so the featured lift can still
// re-sort once it lands — pre-existing behaviour, deliberately unchanged.)
//
// ── #1191 slice 6, conversion 7: this file builds DESCRIPTORS ────────────
//
// `#challenges-root` was the Leaderboard screen's last innerHTML host. It is
// React-owned now: ./challenges-pane.tsx is the only writer below it, and the
// four render methods below push view descriptors into
// ./topochain-challenges-store.js instead of assembling markup. That is a
// change of OUTPUT TYPE, not of behaviour — the ordering, the completed
// split, the deep-link resolution and every id are the ones this file already
// shipped, and each is still decided here.
//
// Three consequences worth stating, because each replaced something visible
// in the diff:
//
//   * `esc()` is gone, replaced by `str()`. There is no markup left to escape
//     — React escapes the text when it renders it, and an esc() surviving
//     into a descriptor would double-encode. What outlived it is the
//     null→'' coercion, which is still load-bearing: React prints
//     String(null) as the four-character word "null". `safeHref()` did NOT
//     retire with it, because it guards a real `href` attribute and React
//     does not validate schemes.
//   * The four `addEventListener` sweeps that were re-bound after every
//     render (the cards, the two overlay
//     backdrops, the close buttons, the breakdown's Load more and its
//     participant rows) are named methods now — `_openIdx` and
//     `_moreBreakdown` — and the component calls them. The behaviour stayed
//     here; only the wiring moved.
//   * The overlays' `hidden` class retired into their descriptors: `detail`
//     and `profile` are null when closed. Only the PANE ROOT's visibility is
//     still `Leaderboard._applySection()`'s `classList.toggle`, which is why
//     #challenges-root keeps a constant `className` in ./index.tsx.
'use strict';

const TopochainChallenges = {
  // ./topochain-challenges-store.js, planted by ./mount.ts rather than
  // imported — see that store's header for why this file can take no import
  // at all. Null during the SSG prerender pass and until the bundle mounts,
  // so every write below goes through `?.set(...)`.
  _store: null,

  _open: false,

  _challenges: [],
  _challengesLoading: false,
  _challengesError: null,
  // challenge id -> the viewer's own row from /challenges-api/challenges.
  // Empty map = no personalization available (signed out, request failed);
  // the grid renders identically, just without the "you" decorations.
  _mine: new Map(),
  _onboarding: null,
  // The challenge groups the viewer opened or closed on this visit, as group
  // key ('setup', 'week', 'always', 'other') -> collapsed. A group absent here
  // takes the board's default (see _groupedGridView). Reset by open() and by a
  // change of event; the detail page leaves it alone, so going back up to the
  // grid keeps the viewer's toggles.
  _collapsed: {},
  // Unsubscribe handle from TopochainEventContext.onChange.
  _unsub: null,
  // The event id `_challenges` was last loaded for. `undefined` until the
  // first load, which is deliberately distinct from the `null` a pane with
  // no resolvable event settles on.
  _loadedEventId: undefined,
  // True once the ?shot=challenge-detail deep link has fired, so a later
  // re-render (event switch, personalization landing) doesn't reopen it.
  _shotFired: false,
  // Pending #leaderboard/challenges/<eventId>/<challengeId> request (#982),
  // as { eventId, challengeId }, or null. Held rather than acted on
  // immediately because the router registers it before the pane has
  // mounted, let alone fetched the event's challenge list.
  _pendingDeepLink: null,
  // The address a card tap pushed for the detail page it opened
  // (#leaderboard/challenges/<eventId>/<challengeId>), or null. The detail is
  // a page, so it owns a history entry: the phone's back gesture pops it and
  // _onHashChange closes the page once the address stops naming it. Null for
  // a page opened without one (?shot, or a cold deep link whose hash the
  // section switch has already rewritten).
  _detailHash: null,
  // The hashchange listener open() installs, kept so close() can remove it.
  _hashListener: null,

  // Challenge detail overlay state. `_detailChallenge` is the clicked
  // challenge-grid item (already carries card_preview/detail_modal); the
  // breakdown paginates via limit/offset/has_more (its own documented
  // shape, not the shared page/per_page meta envelope — SPEC judgment
  // call #5 in public.js).
  _detailChallenge: null,
  _breakdown: null,
  _breakdownLoading: false,
  _breakdownError: null,

  // User profile overlay state.
  _profileUserId: null,
  _profile: null,
  _profileLoading: false,
  _profileError: null,

  isOpen() { return TopochainChallenges._open; },

  // What is left of esc() after conversion 7 took the markup away: the
  // null→empty coercion, with none of the escaping. React escapes every text
  // node and every attribute value it renders, so escaping here would
  // double-encode — a challenge goal reading `Ship & tell` would paint as
  // `Ship &amp; tell`. The coercion is NOT redundant: React renders
  // String(null) as the four-character word "null", so a nullable API field
  // still has to land as ''.
  str(s) {
    return String(s == null ? '' : s);
  },

  // Rewards are organiser prose, rendered verbatim, except that a bare number
  // gets " pts" — Home's HomePanels.formatReward rule, so the same challenge
  // reads the same reward on both surfaces. Null for an empty reward.
  formatReward(reward) {
    const s = String(reward == null ? '' : reward).trim();
    if (!s) return null;
    return /^[\d][\d.,]*$/.test(s) ? `${s} pts` : s;
  },

  // "2,000 pts": a points figure with thousands separators. A value that is
  // not a finite number comes back verbatim, so a surprise payload still
  // reads as what the server sent.
  _pts(v) {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n)
      ? `${n.toLocaleString('en-US')} pts` : TopochainChallenges.str(v);
  },

  // href-safe URL: only http(s) links are ever rendered as a real anchor.
  // This is the ONE guard React does not make redundant. Rendering through a
  // component stops attribute breakout for free, but it does NOT stop a
  // `javascript:`-scheme href, which executes on click with no markup
  // injection needed at all. Every cta/mobile_cta link in this file must
  // go through this before it can reach an `href`; anything that isn't
  // http(s) renders as plain text instead of a clickable link.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  // The challenge template's illustration, as the card and the page are
  // handed it: a slug of the registry's SHAPE, else null. This file cannot
  // import frontend/src/lib/challenge-illustrations.ts — it stays an
  // import-free classic script (see tests/challenge-deep-link.test.js) — so it
  // checks only the shape the server already checks, and the components
  // resolve it (a built-in by MEMBERSHIP, an admin upload by its `u-` slug).
  // Nothing here builds a path from it.
  ILLUSTRATION_SLUG: /^[a-z0-9][a-z0-9-]{0,63}$/,
  _illustrationOf(cp) {
    const slug = cp && cp.illustration;
    return typeof slug === 'string' && TopochainChallenges.ILLUSTRATION_SLUG.test(slug) ? slug : null;
  },

  // An uploaded illustration's tone, which the server sends beside the slug
  // (null for a built-in, which carries its own). Again only its SHAPE: a
  // lowercase word of the length a tone name has. The registry decides
  // whether it is one of its TONES and draws an unknown one on gray, so a
  // tone added there needs no change here.
  ILLUSTRATION_TONE: /^[a-z]{3,10}$/,
  _illustrationToneOf(cp) {
    const tone = cp && cp.illustration_tone;
    return typeof tone === 'string' && TopochainChallenges.ILLUSTRATION_TONE.test(tone) ? tone : null;
  },

  async fetchJson(url) {
    try {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: res.ok, data: null };
      }
      try {
        return { status: res.status, ok: res.ok, data: await res.json() };
      } catch {
        return { status: res.status, ok: res.ok, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  open() {
    TopochainChallenges._open = true;
    // Every visit starts the groups from the board's defaults.
    TopochainChallenges._collapsed = {};
    TopochainChallenges._renderShell();
    // The event bar owns the selection; re-render whenever it CHANGES.
    // Not on every notification: the bar also notifies once at the end of
    // its own initial loadEvents(), and that one carries the same event
    // this pane already loaded. Treating it as a change tore down whatever
    // was on top of the grid a beat after it opened — which is how the
    // #982 deep link ended up rendering the right detail panel and then
    // closing it unprompted, and would do the same to an overlay the user
    // opened by hand.
    if (window.TopochainEventContext?.onChange) {
      TopochainChallenges._unsub = TopochainEventContext.onChange(() => {
        if (!TopochainChallenges._open) return;
        if (TopochainChallenges._eventId() === TopochainChallenges._loadedEventId) {
          // The same event — most often the bar's own notification once its
          // event list lands. Nothing to reload and nothing to close, but a
          // card's deadline line (_deadlineOf) and the season line over the
          // grid (_progressView) read that list, so a grid drawn before the list arrived is redrawn
          // in place. Only the descriptor: _renderGrid would re-run the
          // screenshot and deep-link hooks.
          const store = TopochainChallenges._store;
          const grid = store && store.get().grid;
          if (grid && grid.kind === 'cards') {
            store.set({ grid: TopochainChallenges.gridView(TopochainChallenges._ordered()) });
          }
          return;
        }
        TopochainChallenges.closeChallengeDetail();
        TopochainChallenges.closeUserProfile();
        TopochainChallenges.loadChallenges();
      });
    }
    if (!TopochainChallenges._hashListener && window.addEventListener) {
      TopochainChallenges._hashListener = (e) => TopochainChallenges._onHashChange(e);
      window.addEventListener('hashchange', TopochainChallenges._hashListener);
    }
    TopochainChallenges.loadChallenges();
  },

  close() {
    TopochainChallenges._open = false;
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._profileUserId = null;
    TopochainChallenges._detailHash = null;
    if (TopochainChallenges._hashListener && window.removeEventListener) {
      window.removeEventListener('hashchange', TopochainChallenges._hashListener);
    }
    TopochainChallenges._hashListener = null;
    // An unresolved deep link dies with the screen. Keeping it would make a
    // much later, unrelated visit to this pane pop an overlay the user
    // never asked for.
    TopochainChallenges._pendingDeepLink = null;
    if (TopochainChallenges._unsub) {
      TopochainChallenges._unsub();
      TopochainChallenges._unsub = null;
    }
  },

  _eventId() {
    return window.TopochainEventContext
      ? TopochainEventContext.eventId : null;
  },

  // ── Shell ────────────────────────────────────────────────────────────

  // No title and no event picker of its own: the Leaderboard screen shell
  // titles the page, the tab strip above says "Challenges", and the shared
  // event bar (TopochainEventContext) owns the picker + hero.
  //
  // The grid host and the two overlay roots are ./challenges-pane.tsx's
  // markup now, so all this does is announce that the pane is open. It still
  // clears both overlays, exactly as re-writing the root's innerHTML did:
  // close() leaves `_detailChallenge` null but never took the `hidden` class
  // off, and it was this rebuild that re-hid them on the next open.
  _renderShell() {
    TopochainChallenges._store?.set({ mounted: true, detail: null, profile: null });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadChallenges() {
    const eventId = TopochainChallenges._eventId();
    // A different event starts its groups from the board's defaults; a
    // refresh of the same one (pull-to-refresh) keeps the viewer's toggles.
    if (eventId !== TopochainChallenges._loadedEventId) TopochainChallenges._collapsed = {};
    // The event `_challenges` reflects (or is being fetched for). The
    // onChange subscriber above compares against it to tell a real event
    // switch apart from a redundant re-notification.
    TopochainChallenges._loadedEventId = eventId;
    if (eventId == null) {
      TopochainChallenges._challenges = [];
      TopochainChallenges._challengesLoading = false;
      TopochainChallenges._challengesError = null;
      TopochainChallenges._mine = new Map();
      TopochainChallenges._onboarding = null;
      TopochainChallenges._renderGrid();
      return;
    }

    TopochainChallenges._challengesLoading = true;
    TopochainChallenges._challengesError = null;
    TopochainChallenges._mine = new Map();
    TopochainChallenges._onboarding = null;
    // Drop the previous event's cards while resolving this viewer's gate.
    TopochainChallenges._challenges = [];
    TopochainChallenges._renderGrid();

    const res = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId) return;

    TopochainChallenges._challengesLoading = false;
    if (res.ok && res.data?.success && Array.isArray(res.data.data)) {
      TopochainChallenges._challenges = res.data.data;
      TopochainChallenges._onboarding = res.data.onboarding || null;
    } else {
      TopochainChallenges._challenges = [];
      TopochainChallenges._challengesError = (res.data && res.data.error)
        || 'Failed to load challenges.';
    }
    TopochainChallenges._renderGrid();
    // Decorations land in a second pass so the grid never waits on them.
    TopochainChallenges._loadMine(eventId);
  },

  // Your own points per challenge, from the session-authed web read. Purely
  // additive: any failure (401 signed out, 422, network) leaves the grid as
  // rendered above — no error banner, no retry.
  async _loadMine(eventId) {
    if (!TopochainChallenges._challenges.length) return;
    const { ok, data } = await TopochainChallenges.fetchJson(
      `/challenges-api/challenges?season_event_id=${encodeURIComponent(eventId)}`
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId) return;
    // The /challenges-api envelope is { success, data } like /api/v4.
    const rows = (ok && data && Array.isArray(data.data)) ? data.data : null;
    if (!rows) return;
    const mine = new Map();
    for (const r of rows) {
      if (r && r.id != null) mine.set(Number(r.id), r);
    }
    TopochainChallenges._mine = mine;
    TopochainChallenges._renderGrid();
  },

  // ── Challenge grid ───────────────────────────────────────────────────

  // Is this challenge organiser-FINISHED? The public row is the source of
  // truth (see the file header's COMPLETION note); the personalization row
  // is only a fallback, so a stale/older public payload still gets the chip
  // for a signed-in viewer rather than silently losing it.
  _isDone(c) {
    // Onboarding is per-user progress. `completed` remains the organiser's
    // archive flag for older challenge lists that have no progress payload.
    if (c?.progress) return c.progress.done === true;
    if (c && c.completed === true) return true;
    const m = TopochainChallenges._mine.get(Number(c && c.id)) || null;
    return !!(m && m.completed === true);
  },

  // ── Groups (ITERATION 03, "Groups count themselves") ──────────────────
  //
  // A challenge's group is its category, the card's label. The same table,
  // in the same words, is HomePanels' (frontend/src/features/home/home-panels.js):
  // both files run as import-free classic scripts, so each keeps a copy.
  // Headings are sentence case; the header uppercases them with CSS, so a
  // screen reader says the words. The keys are not the headings: ids
  // (`tc-se-group-<key>`) and tests name the keys, so a heading can change
  // without them. `order` is each group's rank while setup is unfinished;
  // _groupRankOf moves a finished Get started to the end.
  GROUPS: {
    ONBOARDING: { key: 'setup', heading: 'Get started', order: 0 },
    WEEKLY: { key: 'week', heading: 'This week', order: 1 },
    PERSISTENT: { key: 'always', heading: 'Always open', order: 2 },
  },
  OTHER_GROUP: { key: 'other', heading: 'Season challenges', order: 3 },

  _groupOf(c) {
    const label = c && c.card_preview ? c.card_preview.label : null;
    const category = String(label == null ? '' : label).trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(TopochainChallenges.GROUPS, category)
      ? TopochainChallenges.GROUPS[category] : TopochainChallenges.OTHER_GROUP;
  },

  // GROUPED when the season gates on setup or any challenge carries one of
  // the board's categories. Otherwise the grid is the ungrouped one it always
  // was: open cards, then a "Completed" split, each card with its deadline.
  _grouped() {
    if (TopochainChallenges._onboarding) return true;
    const list = TopochainChallenges._challenges;
    return Array.isArray(list)
      && list.some((c) => TopochainChallenges._groupOf(c) !== TopochainChallenges.OTHER_GROUP);
  },

  // Whether setup is behind the viewer, which decides where Get started
  // sits. With an onboarding summary the server's gate says so
  // (`unlocked === true`); without one, the list must hold at least one setup
  // card and every one of them must be done.
  _setupFinished(list = TopochainChallenges._challenges, onboarding = TopochainChallenges._onboarding) {
    if (onboarding) return onboarding.unlocked === true;
    const setup = (Array.isArray(list) ? list : [])
      .filter((c) => TopochainChallenges._groupOf(c).key === 'setup');
    return setup.length > 0 && setup.every((c) => TopochainChallenges._isDone(c));
  },

  // A group's rank in the board's order: Get started while unfinished (0),
  // This week (1), Always open (2), Season challenges (3), then Get started
  // once finished (4, last), so the grid leads with what is left to do.
  // Pure: a group from GROUPS/OTHER_GROUP and the _setupFinished answer.
  // HomePanels keeps the same rule for Home's block, and
  // tests/challenge-group-parity.test.js holds the two to the same results.
  _groupRankOf(group, setupFinished) {
    const g = group || TopochainChallenges.OTHER_GROUP;
    return g.key === 'setup' && setupFinished === true ? 4 : g.order;
  },

  // A card's group rank; 0 for every card of an ungrouped grid, so the key
  // changes nothing there.
  _groupRank(c, grouped = TopochainChallenges._grouped(), setupFinished = TopochainChallenges._setupFinished()) {
    return grouped ? TopochainChallenges._groupRankOf(TopochainChallenges._groupOf(c), setupFinished) : 0;
  },

  // The group first (a grouped grid only, by _groupRankOf: Get started while
  // unfinished, This week, Always open, Season challenges, then a finished
  // Get started), then unfinished challenges, then organiser-featured, then
  // the public payload's order (display_order, then id) — the retired
  // #challenges screen's ordering with the completed split added in front of
  // it (#981). The group key keeps each group contiguous, so a grouped grid's
  // "completed split" is inside each group rather than across the grid. The
  // not-completed key comes from the PUBLIC row, so the split is final on
  // first paint; `featured` still arrives with the personalization pass, so
  // that lift alone can still re-sort later.
  _ordered() {
    const mine = TopochainChallenges._mine;
    const grouped = TopochainChallenges._grouped();
    const setupFinished = TopochainChallenges._setupFinished();
    return TopochainChallenges._challenges
      .map((c, i) => ({
        c, i, m: mine.get(Number(c.id)) || null, g: TopochainChallenges._groupRank(c, grouped, setupFinished),
      }))
      .sort((a, b) => {
        if (a.g !== b.g) return a.g - b.g;
        const ad = TopochainChallenges._isDone(a.c) ? 1 : 0;
        const bd = TopochainChallenges._isDone(b.c) ? 1 : 0;
        if (ad !== bd) return ad - bd;
        const af = a.m && a.m.featured === true ? 1 : 0;
        const bf = b.m && b.m.featured === true ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.i - b.i;
      })
      .map((x) => x.c);
  },

  _renderGrid() {
    const store = TopochainChallenges._store;

    if (TopochainChallenges._challengesLoading && !TopochainChallenges._challenges.length) {
      store?.set({ grid: { kind: 'loading' } });
      return;
    }
    // Both terminal empty states retire a pending deep link (#982) on the
    // way out, via the same guards the populated path uses — an empty
    // `ordered` simply matches nothing. Neither state can ever resolve one,
    // and leaving it armed would fire it against whatever event the viewer
    // picks next.
    if (TopochainChallenges._challengesError) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({
        grid: {
          kind: 'error',
          message: TopochainChallenges.str(TopochainChallenges._challengesError),
        },
      });
      return;
    }
    if (!TopochainChallenges._challenges.length && !TopochainChallenges._onboarding) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({ grid: { kind: 'empty' } });
      return;
    }

    const ordered = TopochainChallenges._ordered();
    store?.set({ grid: TopochainChallenges.gridView(ordered) });
    TopochainChallenges._maybeShot(ordered);
    TopochainChallenges._maybeDeepLink(ordered);
  },

  // The populated grid, as a descriptor. `ordered` stays ONE flat array
  // whatever the grouping does: both the cards' `idx` and _maybeShot index
  // into it, so splitting it in two would desynchronise every click from the
  // card it was made for. The groups below therefore carry SLICES of the same
  // numbering, not a re-numbering.
  gridView(ordered) {
    if (TopochainChallenges._grouped()) return TopochainChallenges._groupedGridView(ordered);
    const firstDone = ordered.findIndex((c) => TopochainChallenges._isDone(c));
    const doneCount = firstDone === -1 ? 0 : ordered.length - firstDone;
    const cards = ordered.map((c, i) => TopochainChallenges.cardView(c, i));

    // The "Completed" subheading only earns its row when there is something
    // on BOTH sides of it. Every public event in production is currently
    // 100% completed, and a heading over the entire grid says nothing.
    const groups = (firstDone > 0 && doneCount > 0)
      ? [
        { key: 'open', heading: null, cards: cards.slice(0, firstDone) },
        { key: 'done', heading: 'Completed', cards: cards.slice(firstDone) },
      ]
      : [{ key: 'all', heading: null, cards }];

    return {
      kind: 'cards',
      // Always present when the grid has rows (including "0/8" and "8/8"),
      // so the declared dapp.json check can anchor on #tc-se-challenge-summary
      // whatever the selected event's data happens to be.
      progress: TopochainChallenges._progressView(doneCount, ordered.length),
      groups,
    };
  },

  // The GROUPED grid: one group per category present, in the board's order,
  // each a contiguous slice of the same flat numbering (_ordered sorts by
  // group first). Each group carries its header, decided here: the heading,
  // ONE composed meta string, whether it is finished, and whether it starts
  // collapsed.
  _groupedGridView(ordered) {
    const cards = ordered.map((c, i) => TopochainChallenges.cardView(c, i));
    const slices = [];
    ordered.forEach((c, i) => {
      const group = TopochainChallenges._groupOf(c);
      let slice = slices[slices.length - 1];
      if (!slice || slice.group !== group) {
        slice = { group, challenges: [], cards: [] };
        slices.push(slice);
      }
      slice.challenges.push(c);
      slice.cards.push(cards[i]);
    });
    const summaries = slices.map((s) => TopochainChallenges._groupSummary(s.group.key, s.challenges));
    // A finished group starts collapsed, so the group holding the next action
    // is what the grid opens on. When every group is finished none collapses,
    // or the grid would open on nothing but headers.
    const everyDone = summaries.every((s) => s.allDone);
    const toggled = TopochainChallenges._collapsed || {};
    const groups = slices.map((s, n) => ({
      key: s.group.key,
      heading: s.group.heading,
      meta: summaries[n].meta,
      allDone: summaries[n].allDone,
      collapsed: Object.prototype.hasOwnProperty.call(toggled, s.group.key)
        ? toggled[s.group.key] === true
        : summaries[n].allDone && !everyDone,
      cards: s.cards,
    }));
    const doneCount = ordered.filter((c) => TopochainChallenges._isDone(c)).length;
    const onboarding = TopochainChallenges._onboarding;
    if (!onboarding) {
      return { kind: 'cards', progress: TopochainChallenges._progressView(doneCount, ordered.length), groups };
    }
    return {
      kind: 'cards',
      // Get started is its own scope while it gates the rest; once unlocked
      // the grid is the whole event again, and so is the progress.
      progress: onboarding.unlocked
        ? TopochainChallenges._progressView(doneCount, ordered.length)
        : TopochainChallenges._progressView(onboarding.completed, onboarding.total, 'Get started'),
      onboardingEventId: !onboarding.unlocked && !groups.some((g) => g.key === 'setup')
        ? onboarding.event_id : null,
      // While the gate is closed: the note, and how many of this event's
      // challenges it hides, the server's additive `hidden_count`, which the
      // pane draws as one locked placeholder after the groups. The
      // placeholder's second line is the note, so the pane draws the note only
      // without one; a payload without the field (an older server) is 0,
      // which draws no placeholder. Unlocked, nothing hides and there is
      // nothing to say: no notice, no count.
      ...(onboarding.unlocked ? {} : {
        notice: 'Finish these to unlock the rest of the season.',
        lockedCount: Number(onboarding.hidden_count) || 0,
      }),
      groups,
    };
  },

  // One group's header, from its challenges: how many are done, whether all
  // are, the clock, and the meta string composed from them: "2/2 done" for a
  // finished group, "1/3" for Get started (which has no clock), "1/4 · 3d left"
  // or "0/2 · no deadline" for the rest. `left` is the time-left words alone,
  // or null (Get started, a finished group, no deadline); the detail page's eyebrow
  // reads it.
  _groupSummary(key, challenges) {
    const list = Array.isArray(challenges) ? challenges : [];
    const total = list.length;
    const done = list.filter((c) => TopochainChallenges._isDone(c)).length;
    const allDone = total > 0 && done === total;
    const left = allDone || key === 'setup' ? null : TopochainChallenges._groupTimeLeft(key, list);
    let meta;
    if (allDone) meta = `${total}/${total} done`;
    else if (key === 'setup') meta = `${done}/${total}`;
    else meta = `${done}/${total} · ${left || 'no deadline'}`;
    return { done, total, allDone, left, meta };
  },

  // A group's clock: the earliest end among its open, unfinished challenges,
  // in _timeLeft's words. A challenge's end is what _deadlineOf reads: its own
  // `effective.schedule_end`, else the selected event's `ends_at`. Always open
  // never borrows the event's end; only an organiser's own end date gives that
  // group a clock. Null when nothing ends in the future.
  _groupTimeLeft(key, challenges) {
    const ctx = window.TopochainEventContext;
    const ev = key !== 'always' && ctx && typeof ctx.selectedEvent === 'function' ? ctx.selectedEvent() : null;
    let best = null;
    for (const c of challenges) {
      if (TopochainChallenges._isDone(c) || !TopochainChallenges._isOpen(c)) continue;
      const raw = (c.effective && c.effective.schedule_end) || (ev && ev.ends_at);
      const left = TopochainChallenges._timeLeft(raw);
      if (!left) continue;
      const at = Date.parse(raw);
      if (!best || at < best.at) best = { at, left };
    }
    return best ? best.left : null;
  },

  // A group header's tap. Flips the group's collapsed state AS DRAWN (the
  // viewer's own toggle, else the default) and redraws the grid descriptor
  // alone: _renderGrid would re-run the screenshot and deep-link hooks.
  _toggleGroup(key) {
    const store = TopochainChallenges._store;
    const grid = typeof store?.get === 'function' ? store.get()?.grid : null;
    if (grid?.kind !== 'cards' || !TopochainChallenges._grouped()) return;
    const group = TopochainChallenges.gridView(TopochainChallenges._ordered()).groups
      ?.find((g) => g.key === key);
    if (!group) return;
    TopochainChallenges._collapsed = { ...TopochainChallenges._collapsed, [group.key]: !group.collapsed };
    store.set({ grid: TopochainChallenges.gridView(TopochainChallenges._ordered()) });
  },

  _toOnboarding(eventId) {
    if (eventId != null) window.TopochainEventContext?.select(Number(eventId));
  },

  // One card. `idx` is this challenge's position in the flat `ordered` array
  // — the component hands it straight back to _openIdx, which is what the
  // retired `data-idx` attribute did.
  cardView(c, i) {
    const str = TopochainChallenges.str;
    const cp = c.card_preview || {};
    const m = TopochainChallenges._mine.get(Number(c.id)) || null;
    return {
      key: `${c.id}|${i}`,
      idx: i,
      featured: !!(m && m.featured === true),
      // A finished challenge is MARKED, not hidden: its detail overlay and
      // participant breakdown are the interesting part of it, so the card
      // stays fully clickable and at full strength. The done state lives on
      // the rail, which _stateOf decides.
      done: TopochainChallenges._isDone(c),
      label: str(cp.label || ''),
      goal: str(cp.goal || ''),
      // #1914: the challenge kind's icon, the same face Home's block draws
      // (HomePanels.challengeRowView). `ChallengeTile` renders an empty
      // neutral square when this is null, which is what every card on this
      // screen used to get — the payload simply never carried one.
      icon: str(cp.icon || '').trim().slice(0, 8) || null,
      reward: TopochainChallenges.formatReward(cp.reward),
      illustration: TopochainChallenges._illustrationOf(cp),
      illustrationTone: TopochainChallenges._illustrationToneOf(cp),
      ...TopochainChallenges._stateOf(c),
      // On a grouped grid the header over This week, Always open and Season
      // challenges says when the group ends, so those cards leave it out.
      // Get started's header has no clock, and its cards keep theirs.
      deadline: TopochainChallenges._isDone(c) || !TopochainChallenges._isOpen(c)
        || (TopochainChallenges._grouped() && TopochainChallenges._groupOf(c).key !== 'setup')
        ? null : TopochainChallenges._deadlineOf(c),
    };
  },

  // Open right now, by the rule Home's server applies (OPEN_ONLY_WHERE in
  // src/routes/home-panels.js): not marked over by the organiser, and inside
  // its effective schedule window. The public list carries every enabled
  // challenge, so a card that is not open gets no countdown, on either surface.
  _isOpen(c) {
    if (!c || c.completed === true) return false;
    const eff = c.effective || {};
    const now = Date.now();
    const start = eff.schedule_start ? Date.parse(eff.schedule_start) : NaN;
    const end = eff.schedule_end ? Date.parse(eff.schedule_end) : NaN;
    return !(start > now) && !(end < now);
  },

  // The deadline on a card's meta line: "5d left". The challenge's own end
  // (`effective.schedule_end`, the organiser's override over the template's)
  // when one is set, else the selected event's `ends_at`. An ungrouped grid
  // shows it on every open card. A grouped grid shows it only on Get
  // started's cards; the other groups' headers carry the earliest end instead
  // (_groupTimeLeft), from the same two sources.
  _deadlineOf(c) {
    const own = c && c.effective && c.effective.schedule_end;
    const ctx = window.TopochainEventContext;
    const ev = ctx && typeof ctx.selectedEvent === 'function' ? ctx.selectedEvent() : null;
    return TopochainChallenges._timeLeft(own || (ev && ev.ends_at));
  },

  // The same rule and words as HomePanels.timeLeft, so a challenge says the
  // same thing on both surfaces. Short, the board's form: whole days rounded
  // UP ("5d left"; 23.5 hours is "1d left"), hours under a day ("7h left", at
  // least "1h left"), and null once past or on an unparseable date rather
  // than a negative count. A copy rather than an import because this module
  // runs import-free; both test files pin the same table of cases.
  _timeLeft(raw) {
    if (!raw) return null;
    const ends = Date.parse(raw);
    if (!Number.isFinite(ends)) return null;
    const ms = ends - Date.now();
    if (ms <= 0) return null;
    const hours = Math.ceil(ms / 3600000);
    return hours < 24 ? `${hours}h left` : `${Math.ceil(ms / 86400000)}d left`;
  },

  // The progress over the grid, as the board's quiet season summary draws it
  // ("3/9 done in Season 2", one segment per challenge, in
  // ./season-progress.tsx, which Home's block shares). `scope` names a scope
  // of its own ("Get started"); otherwise it is the selected event, whose name
  // can land after the grid does. The onChange redraw in open() fills it in
  // then, and until it has, the caption is plain "done".
  _progressView(done, total, scope) {
    let name = scope || '';
    if (!name) {
      const ctx = window.TopochainEventContext;
      const ev = ctx && typeof ctx.selectedEvent === 'function' ? ctx.selectedEvent() : null;
      name = ev ? TopochainChallenges.str(ev.name).trim() : '';
    }
    return { done, total, caption: name ? `done in ${name}` : 'done' };
  },

  // The card's rail: which of the three states a challenge is in, the one
  // line of copy it shows, and how much of the rail is filled.
  //
  //   done      _isDone — the viewer's own `progress.done` when the public row
  //             carries onboarding progress, otherwise the organiser's
  //             `completed` flag. The same meaning the summary tally and the
  //             grouping use, so the rail can never disagree with them.
  //   progress  something credited. For a COUNTED challenge (a target above
  //             one) that is any ledger row, because rows are the count on
  //             both surfaces. For an uncounted one it is POINTS
  //             (activities_total > 0): a zero-point row is not progress
  //             there, which is the Flutter app's hasEarnedPoints rule.
  //   new       everything else, including every card an anonymous visitor
  //             sees that is not done.
  //
  // The fill is a fraction only when the count can honestly be one: a metric
  // with a numeric target above one whose count this read carries. A target
  // of one is a yes/no, and so is a counted metric before personalization
  // lands — both read "Started" with no fill rather than a bar that means
  // nothing. The viewer's points stay in the detail overlay.
  //
  // BLOCK PRODUCTION IS NO LONGER AN EXCEPTION (#2492). Block scores live in
  // leaderboard snapshots and are never written to the points ledger
  // (src/services/topochain/snapshot-builder.js), so a viewer producing
  // blocks can have zero ledger points. This pane used to answer that by
  // drawing the bare ring with no label and no value — the rail saying
  // nothing it could not see — while Home, which reads the snapshot, showed
  // the real count beside the same challenge. The public row now carries that
  // count itself (src/routes/topochain/public.js resolves it through the same
  // helper Home's panel uses), so the `if (p)` block below answers a block
  // card the way it answers every other one, and the fallback under it says
  // "Not started" rather than nothing at all.
  //
  // Every label is SHORT on purpose, and the words are the board's ("Not
  // started", "Done"). The rail is alone on its row at the card body's full
  // width (~170px on a 320px phone) and truncates rather than wraps; the ring
  // carries the state, so the words never repeat it ("In progress · 3/8"
  // wrapped).
  // PER-VIEWER PROGRESS FIRST. The public row carries `progress`
  // ({ done, current, target }) for the season's onboarding steps, computed
  // server-side by services/topochain/challenge-onboarding.js — including
  // block production, which it reads from snapshots. When it is there, the
  // platform has actually counted, so "Not started" is a fact rather than a
  // guess, and the count and fill come from it. Everything below the
  // `if (p)` block is the fallback for rows without it.
  //
  // A COUNTED RAIL STARTS AT ZERO. Whenever the count is known — a target
  // above one — the card shows it from the first moment ("0/3 Apps tried",
  // with a stub of bar; `counted: true` is what draws it) instead of "Not
  // started", so a challenge with steps is told apart from a yes-or-no one
  // before anyone begins. "Not started" is the yes-or-no challenge's word.
  _stateOf(c) {
    const m = TopochainChallenges._mine.get(Number(c && c.id)) || null;
    const points = m && Number(m.activities_total) > 0 ? Number(m.activities_total) : 0;
    const p = (c && c.progress) || null;
    if (TopochainChallenges._isDone(c)) {
      const earned = points ? `Earned ${points.toLocaleString('en-US')} pts` : null;
      return { state: 'done', stateLabel: 'Done', fill: 1, counted: false, earned };
    }
    if (p) {
      const target = Number(p.target);
      const current = p.current == null ? 0 : Math.max(0, Number(p.current) || 0);
      if (p.current != null && Number.isFinite(target) && target > 1) {
        const count = Math.min(current, target);
        // The count honours challenge-row overrides (the server COALESCEs
        // metric_type/metric_target), so the unit must too: the personalization
        // row's label is override-aware, the public row's `activity_type` is
        // the template's alone.
        const label = (m && m.metric && m.metric.label)
          || (c.metric && c.metric.label)
          || (c.activity_type && c.activity_type.metric_label);
        const unit = label ? ` ${TopochainChallenges.str(label)}` : '';
        return {
          state: count > 0 || points > 0 ? 'progress' : 'new',
          stateLabel: `${count}/${target}${unit}`,
          fill: count / target,
          counted: true,
          earned: null,
        };
      }
      if (current > 0 || points > 0) {
        return { state: 'progress', stateLabel: 'Started', fill: null, counted: false, earned: null };
      }
      return { state: 'new', stateLabel: 'Not started', fill: 0, counted: false, earned: null };
    }
    const metric = (m && m.metric) || null;
    const at = (c && c.activity_type) || null;
    // The metric, override-aware from either row: the personalization row's
    // once it lands (never, signed out or on failure), else the public row's
    // `metric`, which is the effective one — so a counted challenge shows its
    // count on first paint and to a signed-out visitor, with the organiser's
    // target rather than the template's. The template's `activity_type` kind
    // is the last resort.
    const src = metric || (c && c.metric) || null;
    const kind = (src && src.kind) || (at && at.metric_type) || null;
    // BLOCK PRODUCTION FALLS THROUGH TO THE ORDINARY WORDS. Everything below
    // counts LEDGER ROWS, which a block challenge never has, so it is read as
    // uncounted here: "Started" once something has paid the viewer points for
    // it, "Not started" otherwise. That is the honest answer for the reads
    // this branch serves — a signed-out visitor and the moment before the
    // list's own `progress` arrives — and it is what Home says too. The real
    // count comes from `progress` above.
    const target = Number(src ? src.target : NaN);
    if (kind && kind !== 'blocks_produced' && Number.isFinite(target) && target > 1) {
      // ROWS are the count, the way Home's server count works (one ledger row
      // per unit), so both surfaces print the same number: a zero-point row is
      // still one of the eight. Points decide only an uncounted challenge.
      const count = Math.min(m && Array.isArray(m.activities) ? m.activities.length : 0, target);
      const label = (src && src.label) || (at && at.metric_label);
      const unit = label ? ` ${TopochainChallenges.str(label)}` : '';
      return {
        state: count > 0 || points > 0 ? 'progress' : 'new',
        stateLabel: `${count}/${target}${unit}`,
        fill: count / target,
        counted: true,
        earned: null,
      };
    }
    if (points) return { state: 'progress', stateLabel: 'Started', fill: null, counted: false, earned: null };
    // Points, not rows: a zero-point ledger row is not a step taken.
    return { state: 'new', stateLabel: 'Not started', fill: 0, counted: false, earned: null };
  },

  // A card click, by its index in the flat ordered array. Recomputed rather
  // than closed over: the only thing that can change `_ordered()` is a new
  // `_mine` or a new `_challenges`, and either of those has already pushed a
  // fresh grid descriptor, so the index the component is holding belongs to
  // the array this returns.
  _openIdx(idx) {
    const challenge = TopochainChallenges._ordered()[idx];
    TopochainChallenges.openChallengeDetail(challenge);
    TopochainChallenges._pushDetailHash(challenge);
  },

  // Screenshot-state deep link (`?shot=challenge-detail`): the detail overlay
  // is interaction-gated, so before/after captures and the declared dapp.json
  // check can't reach it by URL alone. Opens one card once, right after the
  // grid first paints: the first UNFINISHED card when the event has one
  // (#981), which is the better capture either way. That is looked up, not
  // assumed to be `ordered[0]`: a grouped grid leads with Get started while
  // the gate reads locked, even over setup cards that are all done, and a
  // finished group starts collapsed. Scoped to
  // that one param value so a real user's
  // grid never auto-opens an overlay. Pure UI state — no writes, no env gate.
  _maybeShot(ordered) {
    if (TopochainChallenges._shotFired) return;
    if (!ordered.length) return;
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    if (shot !== 'challenge-detail') return;
    TopochainChallenges._shotFired = true;
    TopochainChallenges.openChallengeDetail(
      ordered.find((c) => !TopochainChallenges._isDone(c)) || ordered[0]
    );
  },

  // ── Challenge deep link (#982) ───────────────────────────────────────

  // Entry point for #leaderboard/challenges/<eventId>[/<challengeId>], the
  // address the profile's completed-challenge rows link to. Called by
  // App._routeLeaderboard BEFORE the pane mounts, so it can only record the
  // intent and point the shared event bar at the right event; the detail
  // overlay opens later, from the render that first paints that event's
  // grid. A bare eventId (no challenge) is a valid, useful address too —
  // it just selects the event.
  openFromHash(eventId, challengeId) {
    const ev = Number.isInteger(eventId) ? eventId : null;
    const ch = Number.isInteger(challengeId) ? challengeId : null;
    if (ev == null && ch == null) return;
    if (ch != null) TopochainChallenges._pendingDeepLink = { eventId: ev, challengeId: ch };
    // select() is a no-op when the event is already the selected one, so
    // this neither reloads nor re-renders in the common "already looking at
    // this event" case — which is exactly why the grid below may already be
    // painted and needs resolving here rather than waiting for a render
    // that will never come.
    if (ev != null && window.TopochainEventContext?.select) {
      TopochainEventContext.select(ev);
    }
    if (TopochainChallenges._open) {
      TopochainChallenges._maybeDeepLink(TopochainChallenges._ordered());
    }
  },

  // Resolve a pending deep link against a freshly painted grid. Consumed
  // ONCE, whether or not the challenge is there: an id that doesn't exist
  // (deleted challenge, hand-edited hash, wrong event) leaves the viewer on
  // the grid with no overlay and no error, which is the honest answer —
  // the challenges they CAN open are all on screen.
  _maybeDeepLink(ordered) {
    const want = TopochainChallenges._pendingDeepLink;
    if (!want) return;
    // Mid-reload the grid still holds the PREVIOUS event's rows (see
    // loadChallenges), and matching against those could open the wrong
    // event's challenge — or, worse, silently burn the link on a list the
    // target was never in. Wait for the render that belongs to it.
    if (TopochainChallenges._challengesLoading) return;
    if (want.eventId != null
        && TopochainChallenges._eventId() !== want.eventId) return;
    TopochainChallenges._pendingDeepLink = null;
    const match = ordered.find((c) => c && Number(c.id) === want.challengeId);
    if (!match) return;
    TopochainChallenges.openChallengeDetail(match);
    // Reached by a history step while the Challenges tab is already showing
    // (a card tap's own push, or forward after back): the address still
    // names this page, so the page owns that entry exactly as a tap would.
    //
    // Not when another section is showing. The router resolves the link
    // BEFORE it switches sections, and that switch replaceStates the address
    // to #leaderboard/challenges — so a page that claimed the address here
    // would read the rewrite as navigating away and close itself in the same
    // event. Such a page owns no entry, like a cold arrival (whose hash the
    // section switch rewrote before the grid was even fetched): its back disc
    // just closes it.
    const section = window.Leaderboard?.section;
    if (section != null && section !== 'challenges') return;
    const hash = `#leaderboard/challenges/${TopochainChallenges._eventId()}/${Number(match.id)}`;
    try {
      if (location.hash === hash) TopochainChallenges._detailHash = hash;
    } catch (err) { /* ignore */ }
  },

  // ── Challenge detail overlay ─────────────────────────────────────────

  openChallengeDetail(challenge) {
    if (!challenge) return;
    // Already the open page. A card tap opens the page and then pushes its
    // address, and the router answers that push (twice: popstate and
    // hashchange) by resolving the same challenge again; without this each
    // answer would reset the page and refetch its participants.
    if (TopochainChallenges._detailChallenge === challenge) return;
    const fromGrid = !TopochainChallenges._detailChallenge;
    TopochainChallenges._detailChallenge = challenge;
    TopochainChallenges._breakdown = null;
    TopochainChallenges._breakdownError = null;
    TopochainChallenges._breakdownLoading = true;
    // The page's visibility IS its descriptor — _renderDetailOverlay
    // publishing a non-null `detail` is what used to be the
    // classList.remove('hidden') on this line. It is a level of the screen,
    // so it opens the way one does: pushed, with the platform header as its
    // nav bar (the pane puts the screen's scroll at the page's top).
    TopochainChallenges._level(() => {
      TopochainChallenges._renderDetailOverlay();
      TopochainChallenges._syncChrome();
    }, fromGrid ? 'push' : 'none');
    TopochainChallenges._loadBreakdown(0);
  },

  closeChallengeDetail(type = 'none') {
    const wasOpen = !!TopochainChallenges._detailChallenge;
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._detailHash = null;
    if (!wasOpen) {
      TopochainChallenges._store?.set({ detail: null });
      return;
    }
    // Back up a level: the header returns to the screen's own chrome (and the
    // pane returns the grid to where it was scrolled).
    TopochainChallenges._level(() => {
      TopochainChallenges._store?.set({ detail: null });
      TopochainChallenges._syncChrome();
    }, type);
  },

  // A level change, animated the way Settings animates its own ('push' in,
  // 'pop' out); 'none' applies it at once.
  _level(fn, type) {
    if (type && type !== 'none' && window.PlatformUI?.transition) {
      window.PlatformUI.transition(fn, { type });
    } else {
      fn();
    }
  },

  // The platform header IS the page's nav bar, as it is for a Settings section
  // or an app's detail in Browse: while a page is open its chevron points up to
  // the grid and its title reads "Challenge"; back on the grid the screen's
  // own chrome returns ("Leaderboard", the house).
  //
  // Only while the Leaderboard is the screen on show. A page closed by a
  // navigation AWAY must never retitle the screen being entered, and restoring
  // the grid's chrome needs the Challenges tab to be the section showing.
  _syncChrome() {
    const app = window.App;
    if (!app || typeof app.setBackIcon !== 'function' || typeof app.setHeaderTitle !== 'function') return;
    const lb = window.Leaderboard;
    if (lb && typeof lb.isOpen === 'function' && !lb.isOpen()) return;
    const challenge = TopochainChallenges._detailChallenge;
    if (challenge) {
      // "Challenge", not the challenge's own name: the page's large title says
      // which one, and a generic word keeps the bar short and steady.
      app.setBackIcon('arrow', '#leaderboard/challenges');
      app.setHeaderTitle('Challenge');
      return;
    }
    // Any section: "Leaderboard" is the whole screen's title, and a page left
    // for another tab must not keep the page's chevron and word.
    app.setBackIcon('home');
    app.setHeaderTitle('Leaderboard');
  },

  // The platform header's back chevron (and Escape), claimed the way Settings
  // and Browse claim it (app.js's #back-btn chain). On the grid it declines, so
  // the chevron's usual destination takes over. On a page:
  //   * a page a card tap opened owns its entry: up to the grid, spending it;
  //   * a page reached from ANOTHER place in the app — a Home challenge card,
  //     another Leaderboard tab — goes back THERE, the rule Settings keeps for
  //     a link from elsewhere (#1565): replacing it with the grid would strand
  //     the viewer a level below where they started. The page closes as the
  //     address moves off it (_onHashChange, or the screen's own exit);
  //   * a cold arrival (a bookmark, ?shot) has nothing of ours below: up to
  //     the grid.
  handleBack() {
    if (!TopochainChallenges._detailChallenge) return false;
    const owned = !!TopochainChallenges._detailHash && location.hash === TopochainChallenges._detailHash;
    let cameFrom = null;
    try { cameFrom = window.App?.previousRoute?.() ?? null; } catch (err) { cameFrom = null; }
    if (!owned && cameFrom != null && window.history?.back) {
      window.history.back();
      return true;
    }
    TopochainChallenges._backFromDetail();
    return true;
  },

  // A card tap gives the page its own address and history entry, so the
  // phone's back gesture (or the browser's) returns to the grid. The page is
  // already open when the router sees the new hash. Without an event id or a
  // numeric challenge id there is no address the router could resolve, so no
  // entry — the page still opens, and its back disc still closes it.
  _pushDetailHash(challenge) {
    const eventId = TopochainChallenges._eventId();
    const ev = eventId == null ? NaN : Number(eventId);
    const id = Number(challenge && challenge.id);
    if (!Number.isSafeInteger(ev) || !Number.isSafeInteger(id)) return;
    const hash = `#leaderboard/challenges/${ev}/${id}`;
    try {
      if (location.hash === hash) return;
      TopochainChallenges._detailHash = hash;
      location.hash = hash;
    } catch (err) { /* no history to push: the page works without it */ }
  },

  // The address moved off the page — the back gesture, the header chevron, a
  // tab, or any other navigation. Close the page and the profile stacked on it.
  //
  // Judged by the address the event ARRIVED at (`newURL`), not only by
  // location.hash: when a challenge link lands while another Leaderboard tab
  // is showing, the router opens the page and then its section switch
  // replaceStates the address to #leaderboard/challenges inside the same
  // dispatch, and that rewrite is not a navigation away.
  _onHashChange(e) {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return;
    let arrived = location.hash;
    if (e && typeof e.newURL === 'string') {
      const at = e.newURL.indexOf('#');
      arrived = at === -1 ? '' : e.newURL.slice(at);
    }
    const own = `#leaderboard/challenges/${TopochainChallenges._eventId()}/${Number(challenge.id)}`;
    if (arrived === own) return;
    if (TopochainChallenges._detailHash && location.hash === TopochainChallenges._detailHash) return;
    TopochainChallenges.closeUserProfile();
    TopochainChallenges.closeChallengeDetail('pop');
  },

  // Up from the page — the header chevron (handleBack) and Escape. When the
  // page owns a history entry, going back spends it, so the browser's own back
  // does not land on the same grid a second time. The page closes here first
  // rather than waiting for the hashchange, so going up never depends on that
  // event arriving.
  _backFromDetail() {
    const hash = TopochainChallenges._detailHash;
    TopochainChallenges.closeChallengeDetail('pop');
    if (!hash || location.hash !== hash) return;
    try {
      window.history?.back?.();
    } catch (err) { /* the page is closed already */ }
  },

  async _loadBreakdown(offset) {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return;
    const eventId = TopochainChallenges._eventId();
    const { ok, data } = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challenge.id)}/breakdown`
      + `?limit=25&offset=${encodeURIComponent(offset)}`
    );
    if (TopochainChallenges._detailChallenge !== challenge) return; // overlay closed/changed
    TopochainChallenges._breakdownLoading = false;
    if (ok && data?.success) {
      const page = data.data;
      if (offset === 0 || !TopochainChallenges._breakdown) {
        TopochainChallenges._breakdown = page;
      } else {
        // "Load more": append entries, keep the fresh totals/has_more/next_offset.
        TopochainChallenges._breakdown = {
          ...page,
          entries: TopochainChallenges._breakdown.entries.concat(page.entries),
        };
      }
    } else {
      TopochainChallenges._breakdownError = (data && data.error) || 'Failed to load the breakdown.';
    }
    TopochainChallenges._renderDetailOverlay();
  },

  // Describes a `detail_modal` CTA, scheme-guarded: only an http(s) link
  // (per safeHref) becomes a real, clickable anchor. Anything else
  // (missing, `javascript:`, a bare string, ...) renders the label as
  // plain text with no href at all — never an anchor whose href
  // an attacker-controlled scheme could turn into script execution. The
  // decision stays here, in the shaping module, precisely so that the
  // renderer has no branch to get wrong: it is handed either a href or not
  // one, and `kind: 'text'` has no href field at all to reach for.
  ctaView(dm) {
    const label = TopochainChallenges.str(dm.cta_label || dm.cta_button || 'Go');
    if (!dm.cta_link) return null;
    const href = TopochainChallenges.safeHref(dm.cta_link);
    if (!href) return { kind: 'text', label };
    return { kind: 'link', href, label };
  },

  _renderDetailOverlay() {
    if (!TopochainChallenges._detailChallenge) return;
    TopochainChallenges._store?.set({ detail: TopochainChallenges.detailView() });
  },

  detailView() {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return null;
    const str = TopochainChallenges.str;
    const dm = challenge.detail_modal || {};
    const cp = challenge.card_preview || {};

    const bd = TopochainChallenges._breakdown;
    let entries;
    if (TopochainChallenges._breakdownLoading && !bd) {
      entries = { kind: 'loading' };
    } else if (TopochainChallenges._breakdownError) {
      entries = { kind: 'error', message: str(TopochainChallenges._breakdownError) };
    } else if (bd && bd.entries.length) {
      entries = {
        kind: 'list',
        hasMore: !!bd.has_more,
        rows: bd.entries.map((e, i) => ({
          key: `${e.user_id}|${i}`,
          userId: e.user_id,
          // Same fallback as the standings table's User cell (#2394).
          name: str(e.display_name) || 'Anonymous',
          nonPodium: !!e.is_non_podium,
          // Points and the optional rate are ONE string, composed here: they
          // shared a single <span> in the markup this replaces, and two
          // sibling expressions in JSX are two text nodes.
          points: e.rate != null
            ? `${TopochainChallenges._pts(e.points)} · ${str(e.rate)}%`
            : TopochainChallenges._pts(e.points),
        })),
      };
    } else {
      entries = { kind: 'empty' };
    }

    // Under the title, the card's own meta line: how long is left, by the
    // card's rules (_isOpen, _deadlineOf), and an amount — what the viewer
    // earned on a finished challenge, their points so far on an open one they
    // have scored on, otherwise the reward on offer. The rail beneath holds the
    // state and nothing else, as on the card.
    const rail = TopochainChallenges._stateOf(challenge);
    const mine = TopochainChallenges._mine.get(Number(challenge.id)) || null;
    const points = mine && Number(mine.activities_total) > 0 ? Number(mine.activities_total) : 0;
    const reward = TopochainChallenges.formatReward(cp.reward);
    let amount = null;
    if (rail.earned) amount = { text: rail.earned, earned: true };
    else if (points) amount = { text: `${points.toLocaleString('en-US')} pts so far`, earned: false };
    else if (reward) amount = { text: reward, earned: false };

    const totals = (bd && bd.totals) || {};
    const participants = Number(totals.participants) > 0 ? Number(totals.participants) : 0;
    const totalPoints = Number(totals.total_points) > 0 ? Number(totals.total_points) : 0;
    const loaded = bd && Array.isArray(bd.entries) ? bd.entries.length : 0;
    // One more page (25, _loadBreakdown's limit) finishes the list: say how
    // many that is. Beyond one page, "Show all" would promise what one tap
    // does not deliver.
    const remaining = participants - loaded;

    // The eyebrow, uppercase on the page. Ungrouped it is the category label,
    // and the meta line carries the card's deadline. Grouped it is the
    // challenge's group with that group's clock ("This week · 3d left"), and
    // the meta line leaves the deadline to it; Get started has no clock, so its
    // page keeps the card's deadline.
    let eyebrow = cp.label ? str(cp.label) : null;
    let deadline = TopochainChallenges._isDone(challenge) || !TopochainChallenges._isOpen(challenge)
      ? null : TopochainChallenges._deadlineOf(challenge);
    if (TopochainChallenges._grouped()) {
      const group = TopochainChallenges._groupOf(challenge);
      const members = TopochainChallenges._challenges.filter((c) => TopochainChallenges._groupOf(c) === group);
      const { left } = TopochainChallenges._groupSummary(group.key, members);
      eyebrow = left ? `${group.heading} · ${left}` : group.heading;
      if (group.key !== 'setup') deadline = null;
    }

    return {
      key: str(challenge.id),
      eyebrow,
      goal: str(cp.goal || ''),
      deadline,
      amount,
      // The card shows only the title, its meta line and the rail, so the page
      // is where the task is read; before ITERATION 03 the card showed it and
      // the overlay never needed it.
      task: cp.task ? str(cp.task) : null,
      // The same artwork as the card's tile, for the page's well under the task.
      illustration: TopochainChallenges._illustrationOf(cp),
      illustrationTone: TopochainChallenges._illustrationToneOf(cp),
      state: rail.state,
      stateLabel: rail.stateLabel,
      fill: rail.fill,
      counted: !!rail.counted,
      cta: TopochainChallenges.ctaView(dm),
      description: dm.description ? str(dm.description) : null,
      requirements: dm.requirements ? str(dm.requirements) : null,
      scoring: dm.reward_logic ? str(dm.reward_logic) : null,
      participants: participants
        ? `Participants · ${participants.toLocaleString('en-US')}` : 'Participants',
      pointsTotal: totalPoints ? `${totalPoints.toLocaleString('en-US')} pts between them` : null,
      moreLabel: remaining > 0 && remaining <= 25
        ? `Show all ${participants.toLocaleString('en-US')} →` : 'Show more →',
      entries,
    };
  },

  // The breakdown's "Load more". `next_offset` is read off the CURRENT
  // breakdown rather than a captured one, so a page that landed between the
  // render and the click cannot make this re-request a page already in hand.
  _moreBreakdown() {
    const bd = TopochainChallenges._breakdown;
    if (!bd) return;
    TopochainChallenges._breakdownLoading = true;
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadBreakdown(bd.next_offset);
  },

  // ── User profile overlay ─────────────────────────────────────────────

  openUserProfile(userId) {
    TopochainChallenges._profileUserId = userId;
    TopochainChallenges._profile = null;
    TopochainChallenges._profileError = null;
    TopochainChallenges._profileLoading = true;
    // As with the detail overlay: publishing a non-null `profile` is what the
    // classList.remove('hidden') on this line used to be.
    TopochainChallenges._renderProfileOverlay();

    const eventId = TopochainChallenges._eventId();
    TopochainChallenges.fetchJson(
      `/api/v4/users/${encodeURIComponent(userId)}/profile?season_event_id=${encodeURIComponent(eventId)}`
    ).then(({ ok, data }) => {
      if (TopochainChallenges._profileUserId !== userId) return; // overlay closed/changed
      TopochainChallenges._profileLoading = false;
      if (ok && data?.success) {
        TopochainChallenges._profile = data.data;
      } else {
        TopochainChallenges._profileError = (data && data.error) || 'Failed to load this profile.';
      }
      TopochainChallenges._renderProfileOverlay();
    });
  },

  closeUserProfile() {
    TopochainChallenges._profileUserId = null;
    TopochainChallenges._store?.set({ profile: null });
  },

  _renderProfileOverlay() {
    if (TopochainChallenges._profileUserId == null) return;
    TopochainChallenges._store?.set({ profile: TopochainChallenges.profileView() });
  },

  profileView() {
    if (TopochainChallenges._profileUserId == null) return null;
    const str = TopochainChallenges.str;
    if (TopochainChallenges._profileLoading) return { kind: 'loading' };
    if (TopochainChallenges._profileError) {
      return { kind: 'error', message: str(TopochainChallenges._profileError) };
    }
    const p = TopochainChallenges._profile;
    return {
      kind: 'profile',
      name: str(p.display_name) || 'Anonymous',
      // The stats grid was six hand-written cells in the same shape; one
      // ordered list of label/value pairs is the same six, and a label can no
      // longer drift away from the field it sits over.
      stats: [
        { label: 'Rank', value: str(p.rank ?? '—') },
        { label: 'Total points', value: str(p.total_points) },
        { label: 'Extra points', value: str(p.extra_points) },
        { label: 'Produced blocks', value: str(p.produced_blocks) },
        { label: 'VRF won slots', value: str(p.vrf_won_slots) },
        { label: 'Success rate', value: `${str(p.success_rate)}%` },
      ],
      // null, not [], so the renderer's "No activities recorded." branch is
      // the same explicit choice the template's ternary was.
      activities: (p.activities && p.activities.length)
        ? p.activities.map((a, i) => ({
          key: `${i}`,
          text: str(a.description || a.activity_type),
          points: `+${str(a.points)}`,
        }))
        : null,
    };
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount, app.js's
// pull-to-refresh and its #982 deep-link branch (openFromHash)
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainChallenges = TopochainChallenges;
