import { readInterfaceMode } from '../settings/interface-mode';
import { reducedMotion } from '../../lib/reduced-motion';
// The home screen's launcher grid: loads the viewer's apps, lays them out on
// the (column, row) canvas HomeLayout models, renders the tiles, and owns the
// drag-to-rearrange gesture.
//
// THE UI OVERHAUL narrowed what this canvas holds. Discover, Challenges and
// Create app used to be draggable WIDGETS placed on it alongside the app
// tiles; Discover and Challenges are fixed sections below the grid now (see
// features/home/index.tsx), so every item here is a 1x1 app tile, there is one
// column count instead of two, and the drag applies to app tiles alone.
// Create came back INTO the grid as its trailing tile (the prototype's
// scrHome), but not as an item: its cell is derived per paint, never stored
// or dragged — see the note at the end of render().
//
// Moved verbatim from public/js/home.js into the bundle by #1083 chunk F step 4
// (see features/home/index.tsx). Two things changed and nothing else:
//
//   * the app-card delegation is an import now instead of a `window.AppCard`
//     read (see renderAppPillsHtml / iconTileFor below), and
//   * escapeHtml and formatRelativeTime at the bottom of the file are
//     module-local rather than ambient globals. That has a consequence outside
//     this file, spelled out in the note above them.
//
// The `HomeLayout` and `window.HomePanels` reads throughout stay as they are:
// both are published by sibling modules the island imports BEFORE this one, and
// every read happens at call time, long after the bundle has evaluated.
import { t as message, htmlText, errorText } from '../../lib/i18n/runtime';
import { AppCard } from '../apps/app-card.js';
import { linkKind } from '../../lib/repo-link.js';
import { rankSearch, searchKey } from '../../lib/search-rank.js';
import { gridStore } from './grid-store';
import { chromeStore } from './chrome-store';
import { detectInstallHost } from '../mobile-install/environment';
import { buildLineTileClass, buildLineTileOf, buildLineTileWordsOf, tileStageOf } from '../first-session/build-line-words.js';
import { installHomeSearchShortcut } from './search-shortcut';


const Home = {
  // Can this viewer create apps right now? Derived per request by
  // /api/auth/me as `canAdminWrite || live app count < app_quota`, so it
  // flips without any user action — creating your one allowed app, an admin
  // editing your quota, an app erroring out. View-only admins intentionally
  // keep their ordinary quota because they cannot use the create route's
  // full-admin bypass.
  //
  // It gates the Create TILE's treatment only, never whether the tile
  // exists: the tile ends the launcher grid on every home screen, for every
  // account (see the note at the end of render() and ./create-tile.tsx).
  //
  // ?shot=create-enabled and ?shot=create-disabled pin the two treatments.
  // Proposal checks run as a zero-quota, view-only admin, so neither state
  // should depend on that fixture's privileges. Pure UI state: these flip one
  // boolean at render time, write nothing, and are not env-gated, so they work
  // in production the moment they ship.
  canCreate() {
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      if (shot === 'create-enabled') return true;
      if (shot === 'create-disabled') return false;
    } catch (err) { /* ignore */ }
    return !!App.user?.canCreateApps;
  },

  // ── One catalog load at a time ─────────────────────────────────────
  //
  // load() is called from a dozen live paths — every app_status,
  // app_redeploy_status, app_version_changed and session_update on the
  // socket, the late-arrival correction, pull-to-refresh, the card menu's
  // actions — and each call was a full GET /api/apps, the platform's largest
  // read (300-700 KB). They arrive in bursts: one redeploy is several status
  // frames, and a warm boot is a correction plus a session update. Measured
  // on a 1.6 Mbps link, a warm open of Home pulled the catalog five times in
  // five seconds, all five downloading at once and sharing the link, so the
  // one that mattered finished last.
  //
  // So a call that lands while a load is running does not start a second: it
  // queues exactly ONE more, which starts when the running one settles, and
  // every later caller in that window shares it. Nothing is dropped — the
  // queued load begins after the last trigger, so the grid always ends on an
  // answer at least as new as the newest event, which parallel loads could
  // not promise (whichever finished last painted, however old its request).
  // A caller that awaits load() after its own write gets the queued load, so
  // it still sees its change.
  _loadInFlight: null,
  _loadQueued: null,

  load() {
    // Edit mode (#4669) survives a catalog reload (#6696). This used to clear
    // the flag, relying on the router calling load() on every visit to Home —
    // but load() is also every background refresh (an app's status frame, a
    // vote landing), so the remove buttons vanished a few seconds into
    // arranging, without a Done. render() reads Home._editing and repaints the
    // badges over the fresh data. Leaving Home ends it instead: App's
    // _setScreenVisible asks Home.setEditing(false) when #home-screen goes
    // hidden.
    if (Home._loadInFlight) {
      if (!Home._loadQueued) {
        const rerun = () => { Home._loadQueued = null; return Home.load(); };
        Home._loadQueued = Home._loadInFlight.then(rerun, rerun);
      }
      return Home._loadQueued;
    }
    const run = Home._loadOnce();
    Home._loadInFlight = run;
    const settle = () => { if (Home._loadInFlight === run) Home._loadInFlight = null; };
    run.then(settle, settle);
    return run;
  },

  async _loadOnce() {
    // Re-render guard: Home.load() is invoked from many WS/event paths
    // (app_status / app_update in app.js, notifications.js), any of
    // which would wholesale-replace the grid mid-drag and yank the
    // card out from under the user's pointer. Defer instead; the drag
    // handlers re-run load() when the gesture ends.
    if (Home._dragActive) {
      Home._reloadPending = true;
      return;
    }
    // Establish the initial search position before the catalog request;
    // later refreshes must preserve the position the user chose.
    Home._searchReveal.sync();
    if (App.user && !App._sessionFromSnapshot) window.UsernodeReact?.appAllowance?.refresh?.();
    // The tiles' vote counts (request 6500): a bridge read, the same as the
    // allowance above, so every path into load() (a visit to Home, a pull,
    // the late-answer correction) re-reads what the tiles count.
    if (App.user) window.UsernodeReact?.homePins?.refresh?.();
    Home._probeShortcutSupport();
    // The header's standing action, from the remembered row, BEFORE the
    // fetch below rather than after it. render() is the call every path
    // funnels through and stays the authority, but on a cold boot at `/` it
    // does not run until /api/apps answers — which is exactly the window the
    // Improve button was missing from. A no-op once anything real is
    // published; see publishImproveTarget for what it does and does not do
    // with the cache.
    Home.publishImproveTarget();
    // Home-screen widgets (#911, ./home-panels.js) and the viewer's stored
    // grid layout (./home-layout.js). Both are TTL-guarded / de-duped
    // inside, so the dozen WS/event paths that call load() don't turn into a
    // dozen fetches.
    //
    // Deliberately NOT awaited — the grid must not wait on a second request
    // to paint. But the fetches race, and losing that race used to cost the
    // widgets their drag: with no registry yet, render() plants no slots, so
    // the blocks fell back to the #home-panels section, which has no drag
    // wiring at all. Re-render once either lands if the grid is already
    // painted without slots. Self-terminating — the slots then exist — and
    // render() defers itself mid-drag like every other path.
    const repaint = () => {
      // Gated on the first /api/apps PAYLOAD, not on the array itself or the
      // DOM. _apps starts as [] so every renderer can read it safely; treating
      // that truthy empty array as "loaded" let the much smaller home-layout
      // response win a cold-load race, repair the stored layout against zero
      // apps, and persist the damaged repair before /api/apps arrived.
      // #app-list is also non-empty for the failure state, so the DOM cannot
      // answer this question either.
      if (!Home._appsLoaded) return;
      // An active search rebuilds the results grid for nothing.
      if ((Home._query || '').trim()) return;
      Home.render();
    };
    window.HomePanels?.ensureLoaded()?.then(repaint);
    Home._ensureLayoutLoaded()?.then(repaint);

    // The read itself failed: no answer in time, or no network at all
    // (lib/read-timeout.ts). That says nothing about the apps, so a grid
    // already drawn stays, as it does offline, and the probe the failure
    // nudged decides whether to say so.
    let unreached = false;
    try {
      // The viewer's own proposals / active sessions used to ride along
      // here as two strips at the top of the grid; both moved into the
      // hamburger's notifications list and the Improve panel, which own those
      // fetches now.
      // ?demo=1 rides on /api/apps: staging injects the icon-demo
      // tiles there (routes/apps.js demoIconApps). No-op in production.
      const params = new URLSearchParams(location.search);
      const demoQS = params.get('demo') === '1' ? `?demo=1${params.get('curation') === '1' ? '&curation=1' : ''}` : '';
      const res = await fetch(`/api/apps${demoQS}`).catch((err) => { unreached = true; throw err; });
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      Home._lastLoadFailed = false;
      Home._apps = apps;
      // Set before render: currentLayout may now safely reconcile the stored
      // account layout against the complete app catalog.
      Home._appsLoaded = true;
      Home.render();
      // The shortcut probe's heal pass may have run before _apps was
      // populated (it needs the app objects for icon payloads); retry
      // now that they're here. No-op when everything has an icon.
      Home._healWidgetIcons();
    } catch (err) {
      // Offline is not a failure, it's a state (#1021) — and by far the
      // most common reason this fetch throws. "Failed to load apps" in
      // red reads like the platform is broken; say what actually happened
      // and offer the retry. Anything already cached stays on screen.
      Home._lastLoadFailed = true;
      let offline = false;
      try { offline = !!(window.Offline && Offline.isOffline()); } catch (_) { offline = false; }
      if (!Home._appsLoaded) {
        Home._appsSettled = true;
        window.HomePanels?.render();
      }
      if (offline || (unreached && Home._apps.length)) {
        if (Home._apps.length) {
          Home.render();
        } else {
          gridStore.set({
            ready: true, view: 'grid', rowTemplate: '', items: [],
            resultsHeading: null, emptyQuery: null, create: null,
            // load() has already cleared edit mode; the merge would keep it.
            editing: false,
            notice: {
              text: message('home:grid.notice.offline'),
              tone: 'muted',
            },
          });
        }
        try { Offline.nudge(); } catch (_) { /* ignore */ }
        return;
      }
      gridStore.set({
        ready: true, view: 'grid', rowTemplate: '', items: [],
        // No Create tile beside a load notice: the notice is the grid's whole
        // answer (offline, or the error card and its Retry) until apps load.
        resultsHeading: null, emptyQuery: null, create: null,
        // load() has already cleared edit mode; the merge would keep it.
        editing: false,
        // #1899: the grid draws this as the shared error card
        // (features/apps/load-error.tsx) with a Retry that re-runs load().
        notice: { text: message('home:grid.notice.loadFailed'), tone: 'error' },
      });
    }
  },

  // ===== Rendering (from the Home._apps cache) =====
  //
  // load() fetches then renders; search keystrokes call render() alone,
  // re-deriving the grid from the cached list + Home._query with no
  // network round trip. The search input itself lives OUTSIDE #app-list
  // (see index.html) so these wholesale innerHTML re-renders never
  // destroy its focus/caret.
  _apps: [],
  // False only until this document adopts its first successful /api/apps
  // payload. Kept separate from _apps because [] is both the safe initial
  // value and a legitimate loaded result for an account with no apps.
  _appsLoaded: false,
  // The first /api/apps read has FAILED (offline with nothing kept, or an
  // error). Home's sections wait for the apps before their first paint
  // (HomePanels.readyToPaint), and a read that will not come must not hold
  // them: they draw from what they have.
  _appsSettled: false,
  // The latest /api/apps read failed (cleared by the next one that lands):
  // the grid on screen is a kept copy, a note or the error card, and coming
  // back online reads it again.
  _lastLoadFailed: false,
  _query: '',

  // ── Edit mode (#4669) ──────────────────────────────────────────────
  //
  // Edit mode arranges My apps, like a phone's home screen: the tiles
  // wiggle, each one grows a remove button, and "Add other apps" and "Done" ride
  // the heading. Pure UI state, per visit: load() clears it, so it is never
  // remembered between visits, and nothing here writes a preference.
  //
  // #5871: a hold is the tile's menu and nothing else. It used to start edit
  // mode as well, so one press put the menu AND the wiggle on screen and
  // neither said which one the press had meant. Edit mode now has doors of
  // its own that say so: "Edit" beside the My apps heading (index.tsx) and
  // "Edit My apps" at the foot of a tile's menu (openCardMenu). While it is
  // on, a hold on a tile of your own is a drag and opens no menu.
  _editing: false,

  // The one setter. Render is the same call every other path funnels through,
  // so the wiggle, the remove buttons and the "Done" link all arrive in one
  // paint. While a drag is live render() must not run (grid-store.ts's
  // header): the flag goes down and `_rerenderPending` takes the flush, which
  // onSettle already drains — so on touch, where the lift happens mid-gesture,
  // the wiggle starts when the finger comes up.
  //
  // The paint is also held back while a tile's menu is up. Its "Edit My
  // apps" item starts edit mode from inside the menu; a synchronous render
  // here would expand the grid (edit mode shows every tile), re-run the
  // placement effect whose deps include items.length, and the detach that
  // cleanup calls is closeCardMenu — killing the menu mid-dismiss. The paint
  // waits for the menu's dismiss instead, so the popover finishes its life
  // anchored to the tile that opened it.
  setEditing(on) {
    const next = !!on;
    if (Home._editing === next) return;
    Home._editing = next;
    if (Home._dragActive) {
      Home._rerenderPending = true;
      return;
    }
    if (Home._menu) {
      Home._menu.then(() => {
        if (Home._dragActive) { Home._rerenderPending = true; return; }
        Home.render();
      });
      return;
    }
    Home.render();
  },

  // The remove button's action. It is the tile menu's own "Remove from My
  // apps" by another door: _menuToggleFavorite(app, false) unfavourites a
  // pinned app and, for a collaborator, hides the member pin — exactly the
  // two branches the menu's item passes (line ~3679). The toast and, for a
  // member, the "Remove … from Home?" question come from toggleAdded.
  _editRemove(slug) {
    const app = (Home._apps || []).find((a) => a && a.slug === slug);
    if (!app) return;
    return Home._menuToggleFavorite(app, false);
  },

  // Escape ends edit mode. Wired once, lazily, from render() like the search
  // bar — the listener reads the flag at event time, so it costs nothing
  // while edit mode is off.
  _editExitWired: false,
  _wireEditExit() {
    if (Home._editExitWired) return;
    if (typeof document === 'undefined'
      || typeof document.addEventListener !== 'function') return;
    Home._editExitWired = true;
    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || !Home._editing) return;
      // A presented sheet or modal owns the keyboard: the Add-apps sheet
      // sits above edit mode, and Escape must not end the state behind it.
      // The kit's own Escape path works off its modal stack, which a sheet
      // is not on, so read the presented surfaces directly.
      if (document.querySelector('.un-sheet, .un-backdrop')) return;
      Home.setEditing(false);
    });
  },


  // Set by toggleAdded for the one render that follows an ADD, then cleared.
  // The collapsed grid shows only the first couple of rows, so an app that
  // lands past the bound would be added to a section that visibly does not
  // change. render() expands the grid for that case rather than leaving the
  // viewer to guess. One-shot, because it describes a single paint.
  _revealSlug: null,

  // "Your apps" = apps the viewer is a member of (creator or accepted
  // invite — the server's is_collaborator flag, see app_collaborators
  // in schema.sql) OR apps they manually added (a favorite row; the
  // old "star", now the menu's "Add to Your apps"). #618: the member
  // pin is a per-user preference now — your_apps_hidden (a hidden
  // app_favorites row) suppresses it, so members can take their own
  // apps out of the section without giving up membership. An explicit
  // favorite still wins (is_favorited is served as false for hidden
  // rows, so both flags can't disagree).
  isYours(app) {
    return !!(app && ((app.is_collaborator && !app.your_apps_hidden) || app.is_favorited));
  },

  // In the community this app belongs to (the server's is_member; see
  // services/communities.js). NOT the same set as isYours, and the
  // difference is the point: "Your apps" is where the shortcuts sit on Home,
  // and taking a tile off Home is not leaving. Joining is what lets you
  // propose and vote, and it is what the Workshop lists.
  isJoined(app) {
    return !!(app && app.is_member);
  },

  // Open a project's hub: a door, so it names its place first
  // (AppView._landOnHub), then the router's own way into a project.
  openHub(slug) {
    if (!slug) return;
    try { window.AppView?._landOnHub?.(slug); } catch (err) { /* the page opens on what it remembers */ }
    if (typeof App !== 'undefined' && App.navigateToApp) App.navigateToApp(slug, 'dev');
    else location.hash = `#app/${encodeURIComponent(slug)}/dev/hub`;
  },

  // Where the communities you are in live: the Communities tab's page
  // (`#communities`, features/communities/), pinned and joined. They were
  // Home's Pinned communities (One Home, #6361) until the tab came back
  // (18 Nov 2026); the tour's Finish and "All communities" anywhere still
  // come through here.
  showCommunities() {
    if (location.hash !== '#communities') location.hash = '#communities';
  },

  // The sidebar's search glyph (features/nav/rail-communities.tsx): Home,
  // with its search box focused, which finds your apps and communities by
  // name. It opened the Communities screen's search until One Home (#6361).
  // The field a person types in: Home's own, or, under a look, the kit
  // page's (frame/home-frame.tsx HomeSearch), which writes into Home's own.
  _searchField() {
    return document.querySelector('[data-home-frame-search] input') || document.getElementById('home-search-input');
  },
  focusSearch() {
    if (typeof App !== 'undefined' && App.navigateHome) App.navigateHome();
    const focus = () => {
      const input = Home._searchField();
      if (!input) return;
      try { input.focus({ preventScroll: false }); input.select?.(); } catch (err) { /* nothing to focus */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(focus));
  },

  // Home's Communities to join (One Home, #6361), the directory Discover
  // was: Home, scrolled to it once it is drawn.
  showCommunitiesToJoin() {
    if (typeof App !== 'undefined' && App.navigateHome) App.navigateHome();
    const scroll = () => {
      const el = document.getElementById('home-frame-to-join') || document.getElementById('home-join-section');
      if (el && !el.hidden) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    requestAnimationFrame(() => requestAnimationFrame(scroll));
  },

  // Split the full list into { yours, rest }. Personal ordering
  // (issue #128) inside "Your apps": explicit favorite_order first
  // (ascending), NULLs after. Array.prototype.sort is stable, so
  // returning 0 for two NULLs preserves the server's activity order
  // among un-ordered entries (member apps that were never dragged).
  partitionApps(apps) {
    const yours = (apps || []).filter(Home.isYours);
    const rest = (apps || []).filter((a) => !Home.isYours(a));
    yours.sort((x, y) => {
      if (x.favorite_order == null && y.favorite_order == null) return 0;
      if (x.favorite_order == null) return 1;
      if (y.favorite_order == null) return -1;
      return x.favorite_order - y.favorite_order;
    });
    Home.hoistNewestOwned(yours);
    return { yours, rest };
  },

  // Move the app you most recently CREATED to the front of `list`, in
  // place. Exactly one row moves and everything else keeps its relative
  // order, so the favorite_order run above stays intact below it.
  //
  // Why it is needed at all: the server orders by 7-day chat messages +
  // seconds-spent (routes/apps.js), and an app created a moment ago has
  // neither — it sorts LAST, which is the opposite of where you want to
  // look right after creating it.
  //
  // Scope: this reorders the array that feeds Home.presentIds →
  // HomeLayout.deriveDefault, i.e. the DERIVED default grid. A user who
  // has loaded their tiles has a stored arrangement that wins in
  // Home.currentLayout, and we deliberately leave it alone rather than
  // shoving their layout around; their new app still lands in the first
  // free cell via HomeLayout.repair.
  hoistNewestOwned(list) {
    const me = window.App && App.user ? App.user.id : null;
    if (me == null || !Array.isArray(list) || list.length < 2) return list;
    let bestIndex = -1;
    let bestAt = -Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const app = list[i];
      if (!app || app.created_by !== me) continue;
      // A row with no parseable created_at cannot be "the newest"; skip
      // it rather than letting NaN win a comparison.
      const at = Date.parse(app.created_at);
      if (!Number.isFinite(at)) continue;
      if (at > bestAt) { bestAt = at; bestIndex = i; }
    }
    if (bestIndex > 0) list.unshift(list.splice(bestIndex, 1)[0]);
    return list;
  },

  // The one form both matchers compare in: trimmed, lower-cased, Latin
  // accents set aside, so "cafe" finds "Café" however its accent was
  // written (lib/search-rank.js, the rule every app search shares, #5891).
  searchKey(value) {
    return searchKey(value);
  },

  // Case-insensitive substring match on name and slug. An empty /
  // whitespace-only query matches everything (the default view).
  matchesQuery(app, query) {
    const q = Home.searchKey(query);
    if (!q) return true;
    return Home.searchKey(app?.name).includes(q)
      || Home.searchKey(app?.slug).includes(q);
  },

  // True when the query IS the app's name or slug (trimmed, any case, any
  // accents), not merely inside it. An empty query is nobody's exact match.
  isExactMatch(app, query) {
    const q = Home.searchKey(query);
    if (!q) return false;
    return Home.searchKey(app?.name) === q || Home.searchKey(app?.slug) === q;
  },

  // The matches, in input order, except that an exact match leads (#4793,
  // #5891): typing an app's full name should find it first, not below three
  // apps that merely contain it. The split is stable, so several exact
  // matches keep their order among themselves and the rest keep theirs.
  // Discover's search (Browse.visibleApps) runs through here too, and the
  // rule itself is lib/search-rank.js, which the communities and guest
  // searches share, so every app search ranks the same way.
  filterApps(apps, query) {
    return rankSearch(apps, query, (a) => [a?.name, a?.slug]);
  },

  // How many admin-featured tiles the "Featured apps" row shows.
  FEATURED_LIMIT: 6,

  // Can this app be offered in Discover at all: it runs, it is not the
  // platform itself, it has an icon to draw, and no admin has flagged it.
  // The flag (`directory.flagged`, src/services/discovery-curation.js) is the
  // one editorial state an app has, and it takes the app out of every
  // Discover list and Featured.
  isDiscoverable(app) {
    return !!app && app.status === 'running' && !app.self_hosted
      && !!(app.icon_url || app.icon_emoji) && !Home.isFlagged(app);
  },

  isFlagged(app) {
    return !!(app && app.directory && app.directory.flagged);
  },

  // The featured row's contents for this viewer: admin-curated apps
  // (the `featured` flag served by GET /api/apps) that are NOT already
  // in "Your apps" — those are one screen-section up, so repeating
  // them would be noise. Ordered by the admin's featured_order
  // (ascending, NULLs last) and capped at FEATURED_LIMIT.
  // Pure — unit-tested in tests/home-find-more.test.js.
  //
  // Featuring IS the editorial decision. A flagged app is never featured
  // (flagging one takes it off the list, and the PUT refuses it), and
  // isDiscoverable leaves one out here as well.
  //
  featuredApps(apps) {
    return (apps || [])
      .filter((a) => a && a.featured && Home.isDiscoverable(a) && !Home.isYours(a))
      .sort((x, y) => {
        const xo = x.featured_order == null ? Infinity : x.featured_order;
        const yo = y.featured_order == null ? Infinity : y.featured_order;
        return xo - yo;
      })
      .slice(0, Home.FEATURED_LIMIT);
  },

  // How many popular apps the Discover rail appends. Same number as
  // FEATURED_LIMIT: the two halves are the two halves of a twelve-card
  // ceiling on one lane, not a second lane's own budget.
  POPULAR_LIMIT: 6,

  // The popular half of the rail: the public communities the viewer has
  // NOT joined, appended after the curated cards. Derived from the SAME
  // /api/apps payload the grid already holds — `member_count`, `audience`
  // and `is_member` ride along with every row (see the serializer in
  // src/routes/apps.js), so this costs no query.
  //
  // Popularity is the member count, most first, with `active_users` as the
  // tie-break; after that the server's own order holds (the sort is stable).
  // parseInt because a count arrives as a STRING when it comes straight off
  // a Postgres bigint.
  //
  // Only public communities (`audience === 'open'`) qualify, running, with
  // an icon and not flagged (isDiscoverable). Also exclude:
  //   * `featured` — the curated half of the same lane already offers those.
  //     The renderer dedupes by slug anyway, since one lane is where a
  //     double-listing would show as the same card twice.
  //   * isJoined / isYours — the whole point is communities you haven't
  //     joined. isYours stays in the exclusion too: a Home shortcut is not
  //     membership, but adding one already joins you, so offering it again
  //     is noise either way.
  // Pure — unit-tested in tests/home-find-more.test.js.
  popularApps(apps) {
    const users = (a) => (parseInt(a && a.active_users, 10) || 0);
    const members = (a) => (parseInt(a && a.member_count, 10) || 0);
    return (apps || [])
      .filter((a) => a && !a.featured && a.audience === 'open'
        && Home.isDiscoverable(a)
        && !Home.isJoined(a) && !Home.isYours(a))
      .sort((x, y) => (members(y) - members(x)) || (users(y) - users(x)))
      .slice(0, Home.POPULAR_LIMIT);
  },

  // ===== Free-form grid layout =====
  //
  // The viewer's arrangement, per column count: { "4": [item…], "5": […] }.
  // Populated from GET /api/home-layout; a width with an empty array has
  // never been dragged and is DERIVED on demand (see currentLayout).
  _layouts: null,
  _derivedSaveTried: false,
  _layoutFetchedAt: 0,
  _layoutInflight: null,
  LAYOUT_TTL_MS: 60 * 1000,

  // True when `_layouts` came from the staging ?demo=1 payload rather than
  // this viewer's own rows. That payload is READ-ONLY by contract — it
  // exists so a reviewer signed in as any cloned identity can see the
  // feature — so nothing derived from it may be written back. Without this
  // flag the very first paint persists it: the demo layout references demo
  // apps that don't exist for the viewer, repair() drops them, and the
  // "stored layout was corrected" path then overwrites their real cells
  // with a repaired copy of the fixture.
  _layoutIsDemo: false,

  // The column count the grid is rendering at right now — four, at every
  // width, since THE UI OVERHAUL. It must agree with the `grid-cols-4` class
  // on #app-list, and HomeLayout.COLS is the single source for that.
  //
  // Kept as a call rather than inlined: every reader passes it around as a
  // parameter and the model still takes it, so the constant-ness stays one
  // fact in one place instead of a number sprinkled through two files.
  currentCols() {
    return HomeLayout.columnsForWidth();
  },

  // ── How much of the screen the launcher may take ───────────────────
  //
  // The collapsed grid used to be two rows at every viewport, full stop. Two
  // is the right FLOOR — a phone has two fixed sections under this grid and
  // an eight-row canvas would push Discover and Challenges off the bottom,
  // which is the failure the fixed-area design exists to prevent — but
  // it was also the ceiling, so a tall desktop window drew two rows of tiles,
  // a "Show all" button, and then a lot of nothing before the next section.
  //
  // The rule now: the launcher may fill the first half of the screen, and
  // never less than the two-row contract. Discover moved up beside it
  // (#4937) — the section under the grid is the rail of community cards now,
  // and the bottom half is what keeps it peeking without scrolling, which is
  // the whole point of capping the launcher at all — so the cap is stated as
  // the thing it is protecting rather than as a row count that only happened
  // to protect it at one viewport.
  APPS_VIEWPORT_FRACTION: 1 / 2,
  // The fewest rows Home shows (visibleRowBudget).
  MIN_ROWS: 3,

  // The row count that fraction buys, measured rather than assumed.
  //
  // Everything it needs is already on the page and already in pixels: the
  // scroller's own visible height, the grid's offset inside that scroller's
  // CONTENT (so the answer does not change as the viewer scrolls), and the
  // computed `grid-auto-rows` / `row-gap` — which is how the phone's shorter
  // --home-cell-h and the grid's `gap-1.5` / `sm:gap-3` are honoured without
  // this file knowing either number.
  //
  // The measurement is deliberately of the ROW's own geometry rather than of
  // what the grid currently draws: reading back the rendered height would make
  // the budget a function of its own output, and a grid one row short would
  // then stay one row short.
  //
  // Anything unmeasurable — the home screen is not the visible one, so
  // clientHeight is 0; `grid-auto-rows` is `auto` in the search view; no
  // layout has happened yet — answers with the LAST good budget rather than
  // the floor, so navigating away and back does not collapse the grid to two
  // rows for one paint.
  visibleRowBudget() {
    // 17 Nov 2026: the least Home shows is three rows at every width (it
    // was the model's two).
    const floor = Home.MIN_ROWS;
    const last = Home._rowBudget || floor;
    if (typeof document === 'undefined') return last;
    // ONE try/catch around the whole measurement, not one per read. Every
    // line below is a layout or style query, and the hosts that lack any of
    // them lack most of them: the vm this module is unit-tested in, a
    // detached node, a WebView mid-teardown. The answer in all of those is
    // the same — keep the last good budget — so branching per call would be
    // three ways of writing one fallback.
    try {
      const grid = document.getElementById('app-list');
      const screen = document.getElementById('home-screen');
      if (!grid || !screen) return last;
      const scroller = window.PlatformUI?.scrollElement?.(screen) || screen;
      const pageScroll = scroller !== screen;
      const viewport = pageScroll
        ? scroller.clientHeight - (screen.getBoundingClientRect().top + scroller.scrollTop)
        : screen.clientHeight;
      if (!viewport) return last;
      const cs = getComputedStyle(grid);
      const cell = parseFloat(cs.gridAutoRows) || 0;
      const gap = parseFloat(cs.rowGap) || 0;
      if (!cell) return last;
      // The resting scroll position parks the hidden search bar out of sight
      // (see _searchReveal), so the grid's top AT REST is its offset in the
      // scroller's content minus that bar. Measuring the live rect alone
      // would hand a viewer who has scrolled down a bigger budget than the
      // one they see when they scroll back.
      // Only where the bar parks (a phone, _searchReveal.tucks).
      const bar = document.getElementById('home-search-bar');
      const resting = (Home._searchReveal.tucks() && bar && bar.offsetHeight) || 0;
      const top = grid.getBoundingClientRect().top
        - screen.getBoundingClientRect().top
        + (pageScroll ? 0 : screen.scrollTop)
        - resting;
      const room = (viewport * Home.APPS_VIEWPORT_FRACTION) - top;
      // n rows occupy n cells and the n-1 gaps between them.
      const rows = Math.floor((room + gap) / (cell + gap));
      return Math.max(floor, Math.min(HomeLayout.MAX_ROWS, rows));
    } catch (err) {
      return last;
    }
  },

  // The budget the last render used, and the reason a resize is worth a
  // re-render: a window that grew or shrank past a whole row changes what the
  // collapsed grid should show. Anything smaller than that changes nothing, so
  // it is compared rather than rendered through — a drag-resize would
  // otherwise rebuild the grid on every frame.
  _rowBudget: 0,
  _rowBudgetWired: false,
  _rowBudgetPending: 0,

  // Whether New project is drawn outside the grid, so the grid ends with no
  // tile: under Standard (WIP) only, whose search row carries the button
  // (features/home/index.tsx), for a viewer who gets a tile.
  hasSideCard() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    if (window.App?.user?.privateMember) return false;
    // The two shot links that exist to show the tile's treatments keep it in
    // the grid at every width (the declared Create checks open them).
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      if (shot === 'create-enabled' || shot === 'create-disabled') return false;
    } catch { /* no address to read */ }
    let skin = 'standard';
    try { skin = window.Skin?.get?.() || 'standard'; } catch { /* the standard look */ }
    // Standard (WIP) (lib/skin.ts 'wip') has New project as a button on the
    // search row at every width, so its grid draws no tile. The brand look
    // ('brand') has the same button from 768px, where the search row is on
    // screen; a phone, whose search row waits to be pulled into view, keeps
    // the tile. Every other look, Standard among them, ends Pinned apps with
    // the tile.
    if (skin === 'wip') return true;
    if (skin !== 'brand') return false;
    try { return !!window.matchMedia('(min-width: 768px)').matches; } catch { return false; }
  },

  _wireRowBudget() {
    if (Home._rowBudgetWired) return;
    // Not `typeof window === 'undefined'`: this module is unit-tested inside a
    // vm whose `window` is a plain object with the handful of properties the
    // tests need, and render() runs there. A host without listeners simply
    // never gets a resize re-render — the budget it measured at render time is
    // still correct for the layout it measured.
    if (typeof window === 'undefined'
      || typeof window.addEventListener !== 'function') return;
    Home._rowBudgetWired = true;
    const run = () => {
      Home._rowBudgetPending = 0;
      // Same deferral the other re-render paths take: never yank the grid out
      // from under a live drag. The gesture's own end re-runs load().
      if (Home._dragActive) return;
      if (Home.visibleRowBudget() === Home._rowBudget
        && Home.hasSideCard() === !!Home._sideCard) return;
      Home.render();
    };
    window.addEventListener('resize', () => {
      if (Home._rowBudgetPending) return;
      Home._rowBudgetPending = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : setTimeout(run, 16);
    }, { passive: true });
  },

  // `_renderedCols`, `_wireViewport()` and `_applyColumnCount()` lived here:
  // a resize + matchMedia watcher that re-rendered the grid whenever a window
  // crossed 640px. Every item's cell is an INLINE grid-column/grid-row this
  // module writes at render time, so a breakpoint crossing left those inline
  // placements describing the OLD column count inside a grid the CSS had
  // already switched — a dead trailing column, widgets spanning 4 of 5.
  //
  // THE UI OVERHAUL settled on four columns at every width, so there is no
  // boundary to cross and nothing to go stale. The watcher, the mid-gesture
  // abort it needed (a crossing during a drag left the recognizer describing a
  // grid that was no longer on screen) and the second stored layout it existed
  // to keep honest all went with it.

  // Every item that should be on the grid right now, as stable ids: the
  // viewer's apps, and nothing else. This is the input HomeLayout.repair
  // reconciles a stored layout against.
  //
  // It used to include the widgets they had not hidden. THE UI OVERHAUL made
  // those fixed sections below the grid (and Create, later, the grid's
  // derived trailing tile), so they are not items — and repair() drops any
  // that a pre-overhaul stored layout still carries.
  presentIds() {
    const { yours } = Home.partitionApps(Home._apps || []);
    const ids = yours.map((a) => `app:${a.slug}`);
    // Staging's request-time demo tiles (?demo=1, src/routes/apps.js) are
    // NOT favourites and NOT collaborations, so partitionApps rightly leaves
    // them out of "Your apps" — but the ?demo=1 layout places them on the
    // grid on purpose, and repair() drops any item that isn't present. The
    // result was a demo route whose whole point is showing the grid rendering
    // a grid with the demo tiles silently removed: for a viewer with no apps
    // of their own that left an empty grid. They are placed
    // like anything else (the spec's rule); only the DRAG excludes them,
    // which the recognizer's `:not([data-demo])` selector already handles.
    for (const app of Home._apps || []) {
      if (app && app.demo && !Home.isYours(app)) ids.push(`app:${app.slug}`);
    }
    return ids;
  },

  // The layout to render, always repaired against what actually exists.
  // Resolution order:
  //   1. the stored arrangement (the viewer has dragged);
  //   2. flow order from favorite_order — i.e. the default home screen.
  // A fully loaded derived arrangement is saved once, so later activity
  // cannot reshuffle the pinned apps before the viewer has ever dragged.
  //
  // There used to be a step between the two: the OTHER width's arrangement,
  // reflowed. THE UI OVERHAUL settled on four columns at every width, so there
  // is one arrangement — and no lossy repack between two of them that could
  // let a phone visit silently rewrite a desktop layout.
  currentLayout(cols) {
    const present = Home.presentIds();
    const stored = Home._layouts && Home._layouts[String(cols)];
    let base;
    let derived = false;
    if (Array.isArray(stored) && stored.length) {
      base = stored;
    } else {
      // A pre-overhaul DESKTOP arrangement lives under '5'. Reading it here is
      // what stops the change looking like "my home screen was reset";
      // repair() pulls anything in the retired fifth column back onto the
      // canvas rather than dropping those apps off the right-hand edge.
      const legacy = Home._layouts && Home._layouts['5'];
      if (Array.isArray(legacy) && legacy.length) {
        base = legacy;
      } else {
        const { yours } = Home.partitionApps(Home._apps || []);
        base = HomeLayout.deriveDefault({ apps: yours.map((a) => a.slug), cols });
        derived = true;
      }
    }
    const { layout, changed } = HomeLayout.repair(base, cols, present);
    // ALWAYS cache what we are about to render. The drag handlers resolve a
    // dragged element to its layout item through this (Home._itemFor), so a
    // path that left it stale made every drop a no-op — canPlace could not
    // find the item and vetoed the whole gesture.
    Home._layoutCache = layout;
    // A repair of a STORED layout is a real correction (an app was added or
    // deleted, a pre-overhaul widget cell reclaimed, a tile pulled back out of
    // the retired fifth column) and is worth persisting so the next load is
    // clean. A new derivation is saved separately, once both reads finish.
    //
    // The `widgetsReady` gate that used to sit here is gone with the widgets.
    // It existed because a layout load that beat /api/home-panels saw an empty
    // widget list and would have persisted a repair that erased the viewer's
    // Challenges/Discover/Create cells. Nothing on the canvas depends on a
    // second endpoint any more, so a repair is always safe to keep.
    //
    // Only a repair that changes what the server would STORE is written.
    // With more apps than the canvas has cells, repair() parks the rest on
    // the overflow row and reports `changed` on every call; toWire() drops
    // that row, the server keeps the same cells, its answer resets
    // _layouts, and the next render repaired and wrote again: three PUTs
    // every few seconds for as long as the home screen was open, each one
    // queued on the server's per-user lock, until the browser's connections
    // were all waiting on them.
    if (changed && Array.isArray(stored) && stored.length) {
      Home._layouts[String(cols)] = layout;
      const wire = (l) => JSON.stringify(HomeLayout.toWire(l));
      if (wire(layout) !== wire(stored)) Home._persistLayout(cols, layout);
    }
    if (derived && Home._appsLoaded && Home._layouts && !Home._derivedSaveTried
        && !Home._layoutIsDemo && new URLSearchParams(location.search).get('demo') !== '1'
        && window.App?.user && layout.some((item) => item.type === 'app')) {
      Home._derivedSaveTried = true;
      Home._layouts[String(cols)] = layout;
      Home._persistLayout(cols, layout, { quiet: true });
    }
    return layout;
  },

  // One fetch per TTL, shared by concurrent callers — Home.load() runs from
  // a dozen WS/event paths and must not turn into a dozen requests.
  _ensureLayoutLoaded(opts) {
    const force = !!(opts && opts.force);
    if (!window.App || !App.user) return Promise.resolve();
    if (Home._layoutInflight) return Home._layoutInflight;
    if (!force && Home._layouts
        && Date.now() - Home._layoutFetchedAt < Home.LAYOUT_TTL_MS) {
      return Promise.resolve();
    }
    let qs = '';
    try {
      if (new URLSearchParams(location.search).get('demo') === '1') qs = '?demo=1';
    } catch (err) { /* ignore */ }
    Home._layoutInflight = fetch(`/api/home-layout${qs}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!json || !json.layouts) return;
        // The server's widget registry used to be adopted here as the
        // authority on footprints. Every item is a 1x1 app tile now, so there
        // is nothing to adopt.
        // adopt it before anything lays out against it.
        Home._layouts = json.layouts;
        Home._layoutIsDemo = !!json.demo;
        Home._layoutFetchedAt = Date.now();
      })
      // Silent on failure: a home screen must never break (or shout in the
      // console) because the layout read hiccuped — it falls back to the
      // derived default, which is exactly today's arrangement.
      .catch(() => {})
      .then(() => { Home._layoutInflight = null; });
    return Home._layoutInflight;
  },

  // Write one width's whole arrangement. Fire-and-forget with a revert:
  // the grid has already repainted optimistically, so this only records
  // where things landed. Same optimistic-then-revert shape the favourite
  // toggle uses.
  async _persistLayout(cols, layout, { quiet = false } = {}) {
    // The staging demo payload is read-only by contract — it is a fixture,
    // not the viewer's arrangement, and writing it back would overwrite
    // their real cells with it. The grid still repaints optimistically, so
    // a reviewer can drag things around; nothing survives the reload.
    if (Home._layoutIsDemo) return true;
    try {
      const res = await fetch('/api/home-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ cols, items: HomeLayout.toWire(layout) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.layouts) {
        Home._layouts = json.layouts;
        Home._layoutFetchedAt = Date.now();
      }
      return true;
    } catch (err) {
      if (quiet) {
        // A later drag may already own this width; never discard its order.
        if (Home._layouts?.[String(cols)] === layout) delete Home._layouts[String(cols)];
        return false;
      }
      PlatformUI.toast(message('home:layout.saveFailed'));
      await Home._ensureLayoutLoaded({ force: true });
      Home.render();
      return false;
    }
  },

  render() {
    // Same deferral as load(): a search keystroke must not yank the
    // grid out from under an in-flight drag either.
    if (Home._dragActive) {
      Home._reloadPending = true;
      return;
    }
    const canCreate = Home.canCreate();
    const apps = Home._apps || [];
    Home._wireSearch();
    Home._wireRowBudget();
    Home._wireEditExit();

    const query = (Home._query || '').trim();
    // EDIT MODE (#4669) is a grid-view state only: a search is a transient
    // list of matches, not the shelf, so nothing there wiggles or offers a
    // remove button. The flag itself is cleared by the search input's own
    // listener (see _wireSearch) the moment it is given a value.
    const editing = !!Home._editing && !query;
    // Home is "Your apps" only now — every other app lives on the
    // #apps browse screen (public/js/browse.js), so the old All Apps
    // section and its drag-to-add gesture are gone.
    const { yours } = Home.partitionApps(apps);
    let items = [];
    let view = 'grid';
    let resultsHeading = null;
    let emptyQuery = null;
    // The grid's explicit row tracks (#975). Empty string in the search view,
    // which clears any template a previous render left behind.
    let rowTemplate = '';
    // Non-zero only when the collapsed grid is holding tiles back; the count
    // is every app the viewer has, which is what the button offers to show.
    let moreCount = 0;
    // An unfolded grid that would hide rows when folded: "Show less" has a job.
    let canFold = false;
    // The trailing "Create an app" tile — null in the search view, which is a
    // transient list of matches rather than the launcher.
    let create = null;

    if (query) {
      // Active search over YOUR apps: one flat grid of matches. Section
      // header, widget strip and drag affordance all step aside until
      // the query clears — reorder is only meaningful against the
      // canonical ordering. The two fixed sections below the grid are
      // untouched by a search: they are outside #app-list. The Create tile
      // steps aside with the rest: it ends the launcher, not a result list.
      //
      view = 'search';
      const matches = Home.filterApps(yours, query);
      if (!matches.length) {
        emptyQuery = query;
      } else {
        resultsHeading = message('home:search.results', { count: matches.length });
        items = matches.map((a) => ({ kind: 'card', placement: null, app: Home.appView(a) }));
      }
    } else {
      // FREE-FORM PLACEMENT. Every app tile is a grid item at an explicit
      // (column, row) cell the viewer chose — holes and all. There is no
      // flow: a tile's position comes from the layout model, never from its
      // order in this array.
      const cols = Home.currentCols();
      // Read the real arrangement: currentLayout repairs it, caches it for
      // the drag maths and persists a repair.
      const layout = Home.currentLayout(cols);
      // THE STRIP'S PINNED PART (#5323): Home no longer publishes anything
      // here. The strip's pins are the viewer's own list now — a My apps
      // tile dropped on the "Pin here" slot pins through the drag recognizer
      // below (_attachGridPlacement), and nothing in a grid paint writes to
      // the strip at all.
      // AS MANY ROWS AS THE FIRST TWO-THIRDS OF THE SCREEN HOLDS, AND NEVER
      // FEWER THAN TWO (HomeLayout.DEFAULT_ROWS). The cap is on what is SHOWN,
      // never on what a viewer may have or where they may put it: the canvas
      // is still eight rows, a drag can still place a tile on any of them, and
      // "Show all" below reveals the rest for the rest of the visit.
      //
      // A cap exists at all because the home screen has two fixed sections
      // under this grid. An eight-row canvas would push Discover and
      // Challenges off the bottom of a phone for anyone with a lot of apps —
      // which is the failure the whole fixed-area design is meant to prevent.
      // Reserving the bottom THIRD is what protects them; two flat rows both
      // over-protected a tall window (two rows of tiles and then a gulf) and
      // said nothing about a short one. See Home.visibleRowBudget.
      const canvas = HomeLayout.canvasItems(layout);
      const rowBudget = Home.visibleRowBudget();
      Home._rowBudget = rowBudget;
      // The bound is "N rows that actually hold apps", not "row index < N"
      // — see HomeLayout.defaultRowBound. On a packed canvas the two are the
      // same number; on one with a hole on row 1 the old form collapsed the
      // two-row default down to a single visible row of tiles.
      //
      // The trailing Create tile never widens this window: when it would
      // start a row past it, it goes behind "Show all N apps" (#3047, below).
      const rowBound = HomeLayout.defaultRowBound(layout, cols, rowBudget);
      // AN ADD THAT LANDS BELOW THE FOLD OPENS THE GRID (#1567). The whole
      // point of repainting on add is that the viewer SEES the app arrive;
      // a collapsed grid that holds it back turns the tick into the only
      // feedback, which is the reload complaint again in a smaller form.
      // Same flag "Show all N apps" sets, so the rest of the visit behaves
      // as if it had been pressed.
      if (Home._revealSlug) {
        const landed = canvas.find((it) => it && it.slug === Home._revealSlug);
        if (landed && landed.row > rowBound) Home._appsExpanded = true;
      }
      const hiddenRows = !editing && !Home._appsExpanded
        && canvas.some((it) => it.row > rowBound);
      canFold = !editing && Home._appsExpanded && canvas.some((it) => it.row > rowBound);
      let shown = hiddenRows
        ? canvas.filter((it) => it.row <= rowBound)
        : canvas;
      // THE CREATE TILE GOES BEHIND "SHOW ALL" TOO (#3047). When the last row
      // the collapsed grid shows is full, the tile would start a row of its
      // own — a third row under two rows of eight apps. It is held back with
      // the hidden rows instead, and the expander appears for it even when
      // every app already fits: a launcher of exactly eight apps shows two
      // rows and "Show all 8 apps", and the tile ends the expanded grid.
      //
      // 17 Nov 2026: THE COLLAPSED GRID ENDS WITH THE TILE INSTEAD. Holding
      // it back left New project as a small button beside the heading. When
      // the last shown row is full, the app in its last cell goes behind
      // "Show all N apps" and the tile takes that cell: the last row shows
      // three apps and New project. Nothing is re-placed: the app keeps its
      // cell and is there again once the grid is expanded or edited.
      //
      // Not under Standard (WIP) (`inCard`, Home.hasSideCard): New project is
      // a button on its search row, and the grid draws no tile at all: four
      // apps to the last row.
      const inCard = Home.hasSideCard();
      Home._sideCard = inCard;
      const createTakesLast = !inCard && !editing && !Home._appsExpanded
        && HomeLayout.createTileCollapsed(shown, cols, rowBound);
      let createCell = null;
      if (createTakesLast) {
        const lastShown = shown[shown.length - 1]; // canvasItems is in reading order
        createCell = { col: lastShown.col, row: lastShown.row };
        shown = shown.slice(0, -1);
      }
      const createHidden = false;
      const collapsed = hiddenRows || createTakesLast;
      const overflow = collapsed ? [] : HomeLayout.overflowItems(layout);
      const parts = shown.map((it) => Home.gridItemView(it, cols, false));
      // Items past the 8-row canvas render after it in plain flow, packed
      // densely. The row cap bounds free PLACEMENT, never how many apps a
      // viewer may have — stranding a tile would be far worse than an
      // extra row.
      parts.push(...overflow.map((it) => Home.gridItemView(it, cols, true)));
      items = parts.filter(Boolean);
      // The row tracks describe what is RENDERED, so a collapsed grid must not
      // declare tracks for the rows it is holding back — an explicit track
      // exists whether or not anything is in it, and naming row 2 while
      // rendering rows 0-1 would pad the grid out with an empty tile row.
      rowTemplate = Home.rowTemplate(collapsed ? shown : layout, cols);
      moreCount = collapsed ? (canvas.length + HomeLayout.overflowItems(layout).length) : 0;
      // One-shot: it described this paint.
      Home._revealSlug = null;
      // THE GRID ENDS WITH "CREATE AN APP" (the prototype's scrHome, whose
      // Your apps grid closes on a dashed Create tile). It replaced the
      // separate trailing "Create app" section: a launcher's own last cell is
      // where "make something" lives, one tap away without scrolling past
      // Discover and Challenges.
      //
      // Its cell is DERIVED from what this paint draws — the one straight
      // after the last tile (HomeLayout.trailingCell) — so it ends the
      // collapsed grid and, after "Show all N apps", the expanded one. It is
      // not in the layout, so it is never dragged, stored or displaced; a drop
      // onto its cell lands in an empty cell and the next paint moves it on.
      // It FLOWS instead (no placement) when there is no cell to follow: an
      // empty launcher, where it is all the grid shows, and
      // overflow tiles, which have no cell of their own either.
      //
      // A collapsed grid the tile would add a row to (createHidden above)
      // holds it back with the hidden rows — but it is not DROPPED there
      // (#4757): heldBack marks it, and the My apps heading draws a compact
      // New project entry in its action seat (#5825; it was on the "Show all"
      // line before), so creating stays one tap away without expanding and
      // without a new tile row. Exactly
      // one of tile and compact entry is on screen: the grid draws its tile
      // only when not held back (app-grid.tsx).
      //
      // Present for EVERY account: `canCreate` decides its treatment, never
      // its presence — the locked tile opens the dialog that prints the quota.
      const placed = items.filter((it) => it.placement).map((it) => it.placement);
      const flows = !placed.length || items.some((it) => !it.placement);
      create = {
        enabled: canCreate,
        hint: message(Home.CREATE_DISABLED_HINT),
        heldBack: createHidden,
        inCard,
        placement: createCell
          ? { ...createCell, w: 1, h: 1 }
          : createHidden || flows
            ? null
            : { ...HomeLayout.trailingCell(placed, cols), w: 1, h: 1 },
      };
      // A private member makes no apps until they are let in off the
      // waitlist (their Home's waitlist card says so), so no tile at all —
      // in edit mode too (#4669): the mode's own entry, "Add other apps", is the
      // button beside the heading, not this tile, so the trailing tile keeps
      // exactly the presence it has at rest.
      if (App.user?.privateMember) create = null;
    }

    // The search view is a flat, transient list — it must not inherit the
    // canvas's fixed row height (its "N results" header and empty-state
    // line would each claim a whole 100px tile row). app.css keys the
    // auto-rows off this attribute.

    // SHORT ROWS (#968 fit rows, #975 blank rows). '' clears it, which is what
    // desktop and the search view get — app.css's grid-auto-rows is then the
    // only row sizing, exactly as before. Written BEFORE the innerHTML so the
    // first layout of the new children already has its tracks.
    gridStore.set({
      ready: true, view, rowTemplate, items, resultsHeading, emptyQuery, query, notice: null, create, editing,
    });
    // ...and, in the same push, the two hosts outside it: "Show all N apps"
    // and the iOS widget-editing strip. The strip renders ABOVE the grid, in
    // its own section, because a full-width flow item cannot coexist with the
    // explicit cell placement #app-list uses. Its reorder recognizer is
    // attached by ./widget-strip.tsx's effect, which calls _wireWidgetStrip —
    // that function attaches listeners, it writes no markup.
    Home._renderAppsMore(moreCount, canFold);
    // Discover / Challenges, painted from the widgets cache
    // (#911) — no network. Their hosts are fixed sections OUTSIDE #app-list,
    // so the grid's wholesale innerHTML re-render above cannot disturb them;
    // this call is here so a first paint fills them at the same moment.
    window.HomePanels?.render();
    // The header's Improve button, pointed at the PLATFORM (#1367). Published
    // from render() on purpose — see publishImproveTarget for why that is the
    // one call that makes it consistent.
    Home.publishImproveTarget();
  },

  // One app -> the flat facts its tile renders. Every conditional the old
  // template string evaluated inline is resolved HERE, where the `App.user`
  // gates and the status vocabulary already live.
  appView(app) {
    const isAwaiting = app.status === 'awaiting_secrets';
    const isError = app.status === 'error';
    const isRunning = app.status === 'running';
    // The status DOT and the active-users badge are gone from the tile face —
    // a launcher icon should read as an app, not a dashboard row. Every
    // non-running status still says so in words.
    // #4053 (owner, 7 Oct 2026): a project whose first version Homeroom bot
    // is making says where it is in the build line, from the time it is set
    // up until it is live (Home.tileBuildLine), not "Spinning up...". In the
    // tile's short words (run four, 13 Oct: the whole phrases were cut off),
    // and while it is built, its stage's (`first_version_phase`, run five:
    // the tile said "Building" while the App tab said "Drawing the screens").
    const { line: buildLine, phase: buildPhase } = Home.tileBuildStage(app);
    const statusLabel = buildLine ? message(buildLineTileWordsOf(buildLine, buildPhase))
      : isRunning ? ''
      : app.status === 'creating' ? message('home:grid.tile.status.creating')
      : isAwaiting ? message('home:grid.tile.status.awaitingSecrets')
      : message('home:grid.tile.status.error');
    // Retry is the errored card's primary recovery action, gated to
    // creator-or-full-admin (view-only admins excluded, issue #311).
    const showRetry = isError
      && !!(App.user?.canAdminWrite || App.user?.id === app.created_by);
    // #416: `last_failure_reason` only rides the list payload for the app's
    // creator / collaborators / admins, so it is simply absent for outsiders.
    const forkName = app.forked_from && typeof app.forked_from === 'object'
      ? (app.forked_from.name || '<deleted>') : null;
    const forkDeleted = !!forkName && !app.forked_from.name;
    return {
      slug: app.slug,
      name: String(app.name || ''),
      status: app.status,
      icon: AppCard.iconViewFor(app),
      locked: !!app.locked,
      demo: !!app.demo,
      statusLabel,
      buildLine,
      isAwaiting,
      isError,
      // Awaiting-secrets cards stay clickable so the viewer can open the app
      // view + Secrets modal to fill values; other non-running statuses show
      // no app surface.
      clickable: isRunning || isAwaiting,
      failureReason: isError && app.last_failure_reason ? String(app.last_failure_reason) : null,
      showRetry,
      forkName,
      forkDeleted,
      // The tile's audience mark (communities, stage 4): GET /api/apps
      // derives it per row, and anything it does not say reads as a
      // public community, which draws no mark.
      audience: app.audience === 'invited' || app.audience === 'solo' ? app.audience : 'open',
      // Standard (WIP)'s tile says what the app is and how many people made
      // it: dapp.json's own sentence, and the list's contributor count.
      description: String(app.manifest_snapshot?.description || '').trim(),
      contributors: Math.max(0, Number(app.contributor_count) || 0),
      // And how many people are in its community (the list's member_count).
      members: Math.max(0, Number(app.member_count) || 0),
    };
  },

  /**
   * #4053: the build line a tile shows (frontend/src/features/first-session/
   * build-line-words.js), from the list's `first_version_line` (GET /api/apps:
   * the line homeroom-bot-dm.js firstVersionState says for this viewer), or
   * null. An app that failed to set up says that instead: Error and Retry.
   */
  tileBuildLine(app) {
    return Home.tileBuildStage(app).line;
  },

  /**
   * The tile's first version, { line, phase }: the list's line and its
   * stage (`first_version_phase`), as the made screen says them from the
   * moment its Submit went through (run six, build-line-words.js
   * tileStageOf: "Starting", grey, never the list's "Plan ready" from before
   * Submit). `line` is null for none.
   */
  tileBuildStage(app) {
    if (!app || app.status === 'error') return { line: null, phase: null };
    return tileStageOf(app.slug, buildLineTileOf(app.first_version_line), app.first_version_phase);
  },

  // One placed item -> its view-model entry. The string version spliced
  // `data-yours` and the placement style INTO renderAppCard's output with two
  // fragile `String.replace` calls (one of which silently unplaced the whole
  // grid once by moving the anchor the other matched on). Placement is data
  // now, so there is nothing to splice.
  gridItemView(item, cols, overflow) {
    const [w, h] = HomeLayout.sizeOf(item, cols);
    const placement = overflow ? null : { col: item.col, row: item.row, w, h };
    // The `item.type === 'widget'` branch that planted a `[data-panel-slot]`
    // host is gone with the UI overhaul: Discover and Challenges are fixed
    // sections below the grid now, and Create is a derived trailing tile
    // (render()), so every ITEM on this canvas is an app tile.
    const app = (Home._apps || []).find((a) => a.slug === item.slug);
    if (!app) return null;
    return { kind: 'card', placement, app: Home.appView(app) };
  },

  // Attach / detach the kit's placement recognizer. Split out of _wireCards so
  // app-grid.tsx can own WHEN it happens (a post-commit effect) while every
  // callback below stays here, where the geometry lives.
  //
  // `enabled` is false in the search view: a flat, transient ordering must not
  // be persisted as a reorder.
  _attachGridPlacement(listEl, enabled) {
    Home._detachGridPlacement();
    if (!enabled || !window.unNative?.attachGridPlacement) return;
    const cols = Home.currentCols();
    Home._placementHandle = window.unNative.attachGridPlacement(listEl, {
      itemSelector: '.app-card[data-yours]:not([data-demo])',
      cellFromPoint: (x, y, info) => {
        // The kit owns the touch sequence. A stationary lift is a context
        // menu, not a layout write; movement turns that same lift into a drag.
        if (Home._contextLift) {
          if (!Home._contextLift.origin) Home._contextLift.origin = { x, y };
          const start = Home._contextLift.origin;
          if (Math.hypot(x - start.x, y - start.y) <= 10) return null;
          Home.closeCardMenu();
          Home._showGridOverlay(listEl, cols, Home._contextLift.item);
          Home._contextLift = null;
        }
        // #5323: the desktop strip's pinned part is a drop target too, and it is
        // checked first (it sits in the rail, beside the canvas). Its own
        // flag is reset here so a move from one target to the other cannot
        // leave the previous one claiming the release.
        Home._pointerOverWidget = false;
        Home._pointerOverStrip = Home._stripPinAt(x, y);
        if (Home._pointerOverStrip) return Home.STRIP_PIN_CELL;
        // #2894: the open widget strip is a drop target too. It is checked
        // BEFORE the grid's own geometry because the strip sits above the
        // canvas and a finger over it resolves to no cell there anyway.
        Home._pointerOverWidget = Home._widgetStripAt(x, y);
        if (Home._pointerOverWidget) return Home.WIDGET_DROP_CELL;
        return Home._targetCellFor(x, y, info, cols);
      },
      // canPlace runs first on every cell change and onHover right after, and
      // both need the SAME displacement plan — so compute it once and memo it
      // for the paint. Recomputing would risk the highlight describing a
      // different outcome than the one that commits.
      canPlace: (item, cell) => (Home._isStripPinCell(cell)
        ? Home._canDropOnStripPin(item)
        : Home._isWidgetDropCell(cell)
          ? Home._canDropOnWidget(item)
          : !!Home._planFor(item, cell, cols)),
      onLift: (item) => {
        Home._dragActive = true;
        // #5323: the "Pin here" slot goes up for the whole drag, so an empty
        // strip has somewhere to drop onto. Cleared on every settle.
        try { window.UsernodeReact?.nav?.setPinDrop?.('idle'); } catch { /* the slot is a convenience */ }
        // #5871: a touch hold opens the menu and does not start edit mode.
        // While edit mode is on the lift is the drag itself, with no menu,
        // so arranging never puts a menu over the tile being moved.
        if (Home._cardPointerType === 'touch' && !Home._editing) {
          Home._contextLift = { item, origin: null };
          Home.openCardMenu(item.dataset.slug, item);
        } else {
          Home.closeCardMenu();
          Home._showGridOverlay(listEl, cols, item);
        }
      },
      onHover: (item, cell, ok) => {
        const overStrip = Home._isStripPinCell(cell);
        const overWidget = Home._isWidgetDropCell(cell);
        if (overStrip) {
          // The slot names what a drop would do: it pins, or the refusal
          // words for an app already pinned or a full list.
          const slug = item && item.dataset ? item.dataset.slug : null;
          let state = 'full';
          try {
            state = ok ? 'ok'
              : (window.UsernodeReact?.nav?.pinStatus?.(slug) || 'full');
          } catch { /* the slot is a convenience */ }
          try { window.UsernodeReact?.nav?.setPinDrop?.(state); } catch { /* ditto */ }
        } else if (!overWidget) {
          // Back over the grid (or a gap): the slot waits neutrally, and the
          // drop would still be the grid's to take.
          try { window.UsernodeReact?.nav?.setPinDrop?.('idle'); } catch { /* ditto */ }
        }
        Home._markWidgetDrop(overWidget ? item : null, ok);
        Home._previewDrop(item, overWidget || overStrip ? null : cell, ok, cols);
      },
      // The release spring's destination. Same memoised plan again: the tile
      // settles on the cell the tint promised, not the one it left.
      rectForCell: (item, cell) => (Home._isStripPinCell(cell)
        ? Home._stripPinRect()
        : Home._isWidgetDropCell(cell)
          ? Home._widgetDropRect()
          : Home._rectForCell(item, cell, cols)),
      onPlace: (item, cell) => {
        // A pin writes NOTHING to the layout: the tile stays where it is on
        // My apps and the app is pinned to the strip as well (#5323). The
        // pin itself waits for onSettle, when the gesture is over and the
        // strip may repaint.
        if (Home._isStripPinCell(cell)) {
          Home._pendingStripPin = (item && item.dataset && item.dataset.slug) || null;
          return;
        }
        // A widget drop writes NOTHING to the layout: the tile stays where it
        // is on the canvas and the app is pinned as well. The pin itself waits
        // for onSettle, when the gesture is over and the strip may repaint.
        if (Home._isWidgetDropCell(cell)) {
          Home._pendingWidgetAdd = (item && item.dataset && item.dataset.slug) || null;
          return;
        }
        Home._onGridPlace(item, cell, cols);
      },
      onSettle: () => {
        Home._contextLift = null;
        Home._dragActive = false;
        Home._hideGridOverlay();
        // Read BEFORE the reset: the kit clears the hover (onHover null) ahead
        // of onSettle on a refused drop, so only the pointer's own last
        // position still says the release happened over the strip.
        const releasedOverWidget = Home._pointerOverWidget;
        Home._pointerOverWidget = false;
        Home._markWidgetDrop(null, false);
        const widgetAdd = Home._pendingWidgetAdd;
        Home._pendingWidgetAdd = null;
        const stripPin = Home._pendingStripPin;
        Home._pendingStripPin = null;
        // The gesture is over whatever happened: the "Pin here" slot goes
        // away before any flush below repaints the grid (#5323).
        try { window.UsernodeReact?.nav?.setPinDrop?.(null); } catch { /* the slot is a convenience */ }
        if (stripPin) {
          // The pin waits for onSettle (onPlace) so the strip may repaint.
          // The bridge takes the app's display data, and the account's own
          // list answers — a refusal here changed nothing and there is
          // nothing to undo.
          const app = (Home._apps || []).find((a) => a.slug === stripPin);
          if (app) {
            try {
              window.UsernodeReact?.nav?.pinApp?.({
                slug: app.slug,
                name: app.name || app.slug,
                iconUrl: app.icon_url || null,
                iconEmoji: app.icon_emoji || null,
              });
            } catch { /* the pin is a convenience */ }
          }
        }
        if (widgetAdd) {
          // The drop's own add is the terminal repaint (it renders the new
          // tile optimistically), so a deferred reload is flushed through it
          // rather than racing it.
          Home._rerenderPending = false;
          Home._dropOnWidget(widgetAdd);
          if (Home._reloadPending) {
            Home._reloadPending = false;
            Home.load();
          }
          return;
        }
        if (releasedOverWidget && Home._widgetFull()) Home._shakeWidgetStrip();
        if (Home._reloadPending) {
          Home._reloadPending = false;
          Home._rerenderPending = false;
          Home.load();
        } else if (Home._rerenderPending) {
          Home._rerenderPending = false;
          Home.render();
        }
      },
    });
  },

  _detachGridPlacement() {
    if (Home._placementHandle) {
      try { Home._placementHandle.detach(); } catch {}
      Home._placementHandle = null;
    }
    Home._contextLift = null;
    Home.closeCardMenu();
  },

  // ── Dragging an app IN from Discover (#1763) ───────────────────────
  //
  // The launcher above is free placement, so the gesture a Discover card was
  // missing is the obvious one: long-press it, drag it up onto the grid, drop
  // it in the cell you want. Add and place in one go, where the ⊕ badge can
  // only append the app to whatever cell happens to be free.
  //
  // This is THE SAME kit recognizer the grid itself uses, attached to a rail
  // instead of to #app-list, and every callback below is the grid's own. The
  // geometry (_targetCellFor), the drop plan (_planFor → HomeLayout.place),
  // the displacement preview, the release spring and the edge auto-scroll
  // that brings the grid into view are shared code, not a second
  // implementation of any of it.
  //
  // WHAT IS ACTUALLY NEW is one fact: the item being dragged is not on the
  // canvas yet. It is modelled as `_incoming` and parked in the OVERFLOW
  // region (row === MAX_ROWS) for the span of the gesture, with one
  // deliberate consequence — HomeLayout.place re-homes a displaced occupant
  // into the dragged item's vacated rectangle first, and HomeLayout.fits
  // rejects row >= MAX_ROWS, so that step finds nothing and the occupant
  // takes the first free cell instead. That is the right answer here: a tile
  // arriving from off-canvas has no cells to swap with.
  //
  // THE OVERLAY AND `un-reordering` BELONG TO #app-list, not to the rail. The
  // kit puts its own class on ITS list element, and the CSS that makes the
  // grid's tiles pointer-events:none — the thing that lets _cellFromPoint
  // resolve an occupied cell as a target at all — is scoped to #app-list, so
  // this reaches across and sets it there. Safe for exactly the reason
  // _showGridOverlay is safe at all (see its header): _dragActive holds for
  // the whole gesture, render() and load() both return early while it does,
  // and React therefore cannot reconcile #app-list inside that window.
  //
  // Returns a detach function for the lane's own effect to call, rather than
  // parking a handle on Home: there are TWO rails (Featured and Popular) and
  // a single slot would silently drop one of them.

  // A SECOND SOURCE (#6025): the sidebar's community rows drag the same way.
  // RailCommunities attaches this recognizer to #platform-rail-communities
  // while Home is on show, with `itemSelector` naming its rows; everything
  // below — the geometry, the plan, the preview, the add on settle — is the
  // Discover path unchanged. A row carries `data-rail-community` rather than
  // `data-slug`, so _dragSlug reads both; the slug means the same app either
  // way, and a community row is carried as the same incoming app.

  // The app a cross-surface drag is carrying, or null when the card being
  // dragged already has a tile on the canvas.
  _incoming: null,

  // The slug a committed incoming drop still owes an "add to Your apps",
  // handed from onPlace to onSettle so the membership write happens with the
  // gesture over and the grid free to repaint.
  _pendingAdd: null,

  _attachDiscoverPlacement(railEl, opts = {}) {
    if (!railEl || !window.unNative?.attachGridPlacement) return null;
    const cols = Home.currentCols();
    const gridEl = () => (typeof document !== 'undefined'
      ? document.getElementById('app-list') : null);
    const handle = window.unNative.attachGridPlacement(railEl, {
      // Demo tiles stay drag-inert (#746) — they have no DB row to favourite
      // and no cell to persist. A card with no slug is the empty-lane note.
      // A SECOND SOURCE (#6025) names its own selector: the sidebar's
      // community rows, which are not Discover cards.
      itemSelector: opts.itemSelector || '.app-card[data-slug]:not([data-demo])',
      cellFromPoint: (x, y, info) => Home._targetCellFor(x, y, info, cols),
      canPlace: (el, cell) => !!Home._planFor(el, cell, cols),
      onLift: (el) => {
        const slug = Home._dragSlug(el);
        const onCanvas = (Home._layoutCache || [])
          .some((it) => it.type === 'app' && it.slug === slug);
        Home._incoming = onCanvas
          ? null
          : { type: 'app', slug, col: 0, row: HomeLayout.MAX_ROWS };
        Home._dragActive = true;
        const listEl = gridEl();
        if (!listEl) return;
        listEl.classList.add('un-reordering');
        Home._showGridOverlay(listEl, cols, el);
      },
      onHover: (el, cell, ok) => { Home._previewDrop(el, cell, ok, cols); },
      rectForCell: (el, cell) => Home._rectForCell(el, cell, cols),
      onPlace: (el, cell) => {
        const incoming = Home._incoming;
        // The cell is written first and the membership second, which is safe
        // in that order: PUT /api/home-layout stores a cell for any app the
        // viewer can SEE (its header says so), and it is the add below that
        // decides whether a tile renders there.
        Home._onGridPlace(el, cell, cols);
        if (incoming) Home._pendingAdd = incoming.slug;
      },
      onSettle: () => {
        Home._dragActive = false;
        Home._hideGridOverlay();
        const listEl = gridEl();
        if (listEl) listEl.classList.remove('un-reordering');
        Home._incoming = null;
        const add = Home._pendingAdd;
        Home._pendingAdd = null;
        if (add) {
          // toggleAdded flips the cached flags, repaints — the model already
          // holds the app at its cell — and POSTs. It is the TERMINAL repaint
          // here, so anything deferred mid-gesture is dropped rather than
          // flushed: a load() at this point would re-read /api/apps while
          // that POST is still in flight and paint the app straight back out
          // of Your apps.
          Home._reloadPending = false;
          Home._rerenderPending = false;
          Home.toggleAdded(add, true);
          return;
        }
        if (Home._reloadPending) {
          Home._reloadPending = false;
          Home._rerenderPending = false;
          Home.load();
        } else if (Home._rerenderPending) {
          Home._rerenderPending = false;
          Home.render();
        }
      },
    });
    return () => { try { handle.detach(); } catch { /* ignore */ } };
  },

  // The errored card's Retry, lifted out of the _wireCards sweep so the button
  // can carry its own handler as a prop.
  async _onRetry(slug, btn) {
    if (btn) btn.textContent = '...';
    await fetch(`/api/apps/${slug}/retry`, { method: 'POST' });
    Home.load();
  },

  // ── The home screen's Improve button (#1367) ───────────────────────
  //
  // "Improve" on home means the PLATFORM: the same panel every app gets,
  // scoped to Homeroom's own self-hosted row. Feedback, its dev
  // sessions, its kanban and feed, its repo — all of it already works on that
  // row, which is why this is a target publish and not a second surface.
  //
  // ── Why this is called from render(), and why that matters ─────────
  //
  // THE UI OVERHAUL shipped this once and #1363 pulled it back out, and that
  // bug is worth naming because it is the whole design constraint here: the old
  // version re-targeted the platform row on the RETURN paths only —
  // navigateHome() after backing out of an app. A cold boot at `/` never
  // published anything, so the button appeared only after you had visited an
  // app and vanished again on refresh, which read as a stale leftover of the
  // app just closed rather than as a feature.
  //
  // render() is the fix because it is the one call every path already funnels
  // through: the cold boot's first paint, the WS app events, a search
  // keystroke, and the return from an app. Publishing the same target
  // repeatedly is free — improveStore.set() is a no-op when nothing changed,
  // and setTarget only re-buckets sessions when the slug actually moves.
  //
  // ── The two gates ──────────────────────────────────────────────────
  //
  // HOME HAS TO BE THE SCREEN ON SHOW. render() also runs while an app is
  // open (a WS event repaints the grid behind the app view), and publishing
  // then would overwrite the open app's own target with the platform's —
  // the header button would silently start describing the wrong thing.
  //
  // THE ROW HAS TO BE VISIBLE TO THIS VIEWER. GET /api/apps hides
  // `self_hosted` rows from non-admins unless SELF_APP_PUBLIC_VOTING is on,
  // and answers 404 rather than 403 for the slug so the row's existence is
  // not disclosed. Reading the target out of the list the viewer was actually
  // served keeps that stance exactly: no row in the payload, no button, and
  // nothing here has to know the flag or the slug. It also means the button
  // appears for everyone the moment public voting is switched on, with no
  // second change.
  // Where the last-published platform target is remembered, so the next cold
  // boot can put the button up before /api/apps answers. See
  // publishImproveTarget's "the gap on a cold boot" note.
  IMPROVE_TARGET_KEY: 'platform-improve-target',

  /** The remembered target, or null. Shape-checked: a stale key is not a target. */
  _cachedImproveTarget() {
    try {
      const raw = JSON.parse(localStorage.getItem(Home.IMPROVE_TARGET_KEY));
      if (!raw || typeof raw !== 'object' || typeof raw.slug !== 'string' || !raw.slug) {
        return null;
      }
      return raw;
    } catch (err) { return null; }
  },

  _rememberImproveTarget(target) {
    try {
      localStorage.setItem(Home.IMPROVE_TARGET_KEY, JSON.stringify(target));
    } catch (err) { /* private mode / quota — the cache is an optimisation */ }
  },

  publishImproveTarget() {
    if (!window.Improve) return;
    // An app is open (or opening): its target is the one that belongs in the
    // header. Both checks — app.js's own currentApp and the screen itself —
    // because a repaint can land either side of the transition.
    if (window.App?.currentApp) return;
    // #1406: the gate is now "an app is not on screen", not "home is". It used
    // to require home specifically, which is why the improve button and the
    // view selector vanished on settings, profile and messages — those screens
    // clear the app's target through _enterScreenChrome and nothing put the
    // PLATFORM's back. They call this now, so the check has to let them
    // through while still refusing to fire over an open app: the currentApp
    // check above and this one are the two halves of that, because a repaint
    // can land either side of the transition.
    //
    // ── AND WHY IT ASKS THE ROUTER TOO ─────────────────────────────
    //
    // #app-view being painted does NOT mean an app is on screen while the
    // viewer is on their way off one. navigateHome hides every other root but
    // deliberately keeps that one alive — `_showOnlyScreen('home-screen',
    // ['app-view'])` — because the shrinking card of the zoom-out IS that
    // element, and it has to keep showing the app's content until it lands.
    // So for the length of that animation the DOM answers "the app view is on
    // show" about a screen the router left, and this gate rejected the very
    // re-publish navigateHome makes two lines later to swap home's target in
    // the same frame. The later publish out of Home.render() lost the same
    // race — /api/apps usually answers before a ~300ms transition ends — so
    // the target stayed null and the header's standing action vanished for
    // the rest of the visit. Only on a leave that ANIMATES: from the App tab
    // the kit falls back to type 'none', which runs fn + after as one
    // synchronous mutation, which is why this read as a Board-only bug.
    //
    // App._revealedScreen is the router's own answer, set by the same
    // _showOnlyScreen call that starts the leave, so "painted, but no longer
    // the revealed screen" is exactly that window and nothing else. Both
    // halves still have to agree before this refuses to publish.
    if (window.App && typeof App._isScreenVisible === 'function'
        && App._isScreenVisible('app-view')
        && App._revealedScreen === 'app-view') return;
    const self = (Home._apps || []).find((a) => a && a.self_hosted);
    if (!self || !self.slug) {
      Home._publishPlatformFallback();
      return;
    }
    const target = Home._platformTargetFrom(self);
    window.Improve.setTarget(target);
    Home._rememberImproveTarget(target);
  },

  /**
   * The Improve target a self-hosted row describes — the ONE builder, whichever
   * payload the row came from.
   *
   * Two shapes reach it: GET /api/apps's list row (Home._apps), and GET
   * /api/apps/:slug's detail row, which ../app-context/platform-target.js
   * fetches when this tab has no list yet. They differ in two fields, and both
   * are read either way: the list carries a `version` block the server already
   * shortened and a server-built `icon_url`; the detail carries the raw
   * `main_sha` and `icon_image_id`.
   */
  _platformTargetFrom(row) {
    const iconUrl = row.icon_url
      || (row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null);
    return {
      kind: 'platform',
      slug: row.slug,
      name: row.name || row.slug,
      selfHosted: true,
      repoUrl: row.repo_url || null,
      iconUrl,
      iconEmoji: row.icon_emoji || null,
      version: row.version?.shortSha || (row.main_sha ? String(row.main_sha).slice(0, 7) : null),
      deploying: row.status === 'deploying',
      // `can_collaborate` is the read affordance accessFlags() computes for
      // this viewer on this row — the same bit that decides whether starting
      // a session is offered anywhere else.
      readOnly: !row.can_collaborate,
      canReport: row.can_report === true,
      // Nothing to share through the APP share dialog: the platform row has no
      // per-slug app URL, which is also why opening it lands on Dev rather
      // than the App tab. About Homeroom shares the platform's own address
      // (../app-context/about-pane.tsx).
      canShare: false,
    };
  },

  /**
   * Homeroom, for a viewer who is NOT served its row.
   *
   * GET /api/apps hides the self-hosted row from a non-admin while
   * SELF_APP_PUBLIC_VOTING is off, and answers 404 for its slug. That used to
   * mean NO target on every platform screen, permanently: the mark's menu said
   * "THIS APP" over a Go to workshop that went to `#` and an About with nothing
   * in it. But the viewer is still standing in the platform, and two of its
   * rows are theirs as much as anyone's — feedback on it, and About it. So the
   * target is Homeroom, marked `restricted`, and the menu hides the two rows
   * that lead to its workshop and discussion rather than into a 404.
   *
   * Nothing here discloses the row: the slug is what GET /api/version publishes
   * to anyone, and every other fact is either Homeroom's name or false.
   * `readOnly` hides New change — there is no workshop to start one in.
   */
  _restrictedPlatformTarget(slug) {
    return {
      kind: 'platform',
      slug,
      name: 'Homeroom',
      selfHosted: true,
      restricted: true,
      repoUrl: null,
      iconUrl: null,
      iconEmoji: null,
      version: null,
      deploying: false,
      readOnly: true,
      canReport: false,
      canShare: false,
    };
  },

  // ── THE GAP ON A COLD BOOT ─────────────────────────────────────────
  //
  // Everything above reads the self-hosted row out of GET /api/apps, and that
  // request is the whole boot's slowest. Until it lands `_apps` is empty and
  // the header's standing action was simply MISSING — for as long as the fetch
  // took, on home and on every other platform screen (they all route through
  // here via _enterScreenChrome). It then popped in, which was the "the
  // Improve button shows up a few seconds late" report: not a stale button, an
  // absent one.
  //
  // So publish the LAST ONE first. The row is the same object visit after
  // visit — it is the platform's own app — so a remembered copy is right far
  // more often than "nothing" is, and the real payload overwrites it a moment
  // later either way (improveStore.set is a no-op when nothing changed, so the
  // common case is invisible). Only while the payload is genuinely not here
  // yet: once `_appsLoaded` is true the list is the truth, including the truth
  // that this viewer is not served the row.
  //
  // It cannot leak the row's existence to someone who may not see it: the
  // cache is written only from a publish of a row this profile was served.
  //
  // ── AND HOME IS NOT THE ONLY DOOR ──────────────────────────────────
  //
  // Only Home loads that list. A first visit that lands on #messages,
  // #workshop, #profile or #settings — a shared link, a notification, a
  // bookmark — never loads it and has no remembered copy, so the menu stayed
  // untargeted for the whole visit: "THIS APP", Go to workshop to `#`, About
  // empty. It fixed itself once Home had been visited, and for a viewer not
  // served the row it never did. So when neither the list nor the cache can
  // answer, ../app-context/platform-target.js finds the row on its own — the
  // slug from GET /api/version, then GET /api/apps/<slug> — and calls this
  // publisher again with the answer, so the two gates above still decide.
  //
  // Reached through `window.PlatformTarget` rather than an import: a dozen
  // tests run this file as a classic script in a vm, where an import line is
  // stripped and its binding would be a ReferenceError at call time.
  _publishPlatformFallback() {
    const resolver = window.PlatformTarget;
    if (Home._appsLoaded) {
      // The list is here and the row is not in it: not served. Homeroom's
      // restricted menu rather than none, once the slug is known.
      const slug = resolver?.slug?.();
      if (slug) window.Improve.setTarget(Home._restrictedPlatformTarget(slug));
      else resolver?.resolve?.({ served: false });
      return;
    }
    const cached = Home._cachedImproveTarget();
    if (cached) {
      window.Improve.setTarget({ ...cached, canReport: false });
      return;
    }
    const known = resolver?.known?.();
    if (known) {
      window.Improve.setTarget(known);
      if (!known.restricted) Home._rememberImproveTarget(known);
      return;
    }
    resolver?.resolve?.();
  },

  // Per-visit only: a viewer who opened the full grid once should not have
  // every later visit start scrolled past two sections, and a preference
  // this cheap is not worth a write.
  // Whether "Show all N apps" has been pressed this visit. Per-visit state,
  // deliberately not persisted: the collapsed grid is the contract, and an
  // expansion the viewer forgot about would quietly eat the fold forever.
  //
  // `?shot=home-apps` pins it ON before the first paint. Every row past the
  // budget is unreachable to a still frame and to a declared check otherwise,
  // because the only way in is a tap; ungated and read-only, like every other
  // shot link here, so the production "before" side works the moment it ships.
  //
  // `?shot=create-enabled` / `?shot=create-disabled` pin it ON as well: they
  // exist to show the Create tile's two treatments, and a collapsed grid whose
  // last row is full holds that tile behind "Show all N apps" (#3047).
  _appsExpanded: (() => {
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      return shot === 'home-apps' || shot === 'create-enabled' || shot === 'create-disabled';
    } catch (err) { return false; }
  })(),

  // "Show all N apps" and the widget strip, pushed together — they are the
  // two hosts OUTSIDE #app-list that this same paint fills, and one store
  // keeps them from being repainted at two different moments. The button
  // stays outside the grid for the reason it always did: the grid's
  // re-render must not take it away mid-click.
  //
  // Kept its name and its caller. It no longer touches the DOM, and the
  // listener it used to re-attach on every paint is now attached once by
  // ./apps-more.tsx to an element React keeps.
  _renderAppsMore(count, canFold) {
    chromeStore.set({
      moreCount: count || 0,
      canFold: !!canFold,
      strip: Home.widgetSectionView(),
    });
  },

  // ── The grid's row tracks (#975) ───────────────────────────────────
  //
  // Every row is one app-grid cell EXCEPT one kind: a row with NOTHING in it
  // is half a cell. It is still exactly where the viewer left it and still a
  // cell they can drop into — it just stops reserving a whole tile to be
  // empty, which is what keeps the two fixed sections below the grid from
  // being pushed down by a viewer's deliberate gaps.
  //
  // A second kind used to qualify: a row a FIT widget owned outright sized to
  // what that widget actually drew (#968). Widgets are not on this canvas any
  // more, so that rule went with them — and the two sets were disjoint by
  // construction anyway (a fit row needs content to size to, a blank row has
  // none), so removing one leaves the other exactly as it was.
  //
  // Returns '' for "no template at all", which is the search-view answer:
  // app.css's `grid-auto-rows: var(--home-cell-h)` is then the only row
  // sizing, byte-for-byte as before.
  //
  // ONLY AS MANY ENTRIES AS THERE ARE OCCUPIED ROWS. Declaring all eight
  // would make them EXPLICIT tracks, and an explicit grid exists whether or
  // not anything is in it — a viewer with three apps would get a ~950px
  // canvas of empty rows below their tiles. Today the grid's rows are
  // implicit and stop at the last placed item; that must stay true, which is
  // also why blankRows() only ever names rows INSIDE that bound.
  //
  // `auto`, not `min-content`: #app-list has no definite height (it flows
  // inside .home-body-fill), so an auto track resolves to the item's content
  // height and grows if content is added — and it sidesteps the question of
  // what min-content means for a scroll container, which .home-panel-card is
  // (`overflow-hidden`). The floor is the smallest block the widget ever
  // draws, so it can never ADD space to a real state; its one job is to stop
  // a slot that rendered nothing from taking its row to zero and reading as
  // "the widget was deleted" rather than "the widget is short".
  rowTemplate(layout, cols) {
    const blank = HomeLayout.blankRows(layout, cols);
    if (!blank.size) return '';
    const last = HomeLayout.lastOccupiedRow(layout, cols);
    if (last < 0) return '';
    const tracks = [];
    for (let row = 0; row <= last; row++) {
      // No space inside the minmax(), and the half height is a CSS variable
      // rather than an inline calc(): tracks are separated by spaces, so
      // keeping each one a single token means the string can be split and
      // counted (here, in the overlay's mirror, and in the tests) without
      // parsing CSS.
      if (blank.has(row)) tracks.push('var(--home-blank-row-h)');
      else tracks.push('var(--home-cell-h)');
    }
    return tracks.join(' ');
  },

  // ===== Hidden search bar (pull-to-reveal) =====
  //
  // The bar is the first child INSIDE #home-screen and is not sticky,
  // so it occupies real scroll space above the content. Parking the
  // scroller at scrollTop = barHeight hides it; a slight pull down (a
  // scroll up on desktop) reveals it. Past that, scrollTop is 0 and
  // the kit's attachPullToRefresh — which only engages from a resting
  // scrollTop of 0 — arms the refresh. No new gesture code: the two
  // stages compose for free.
  _searchReveal: {
    _pinned: false,
    _initializedBar: null,
    _scrollWired: false,
    _rafPending: false,

    screenEl() {
      const el = document.getElementById('home-screen');
      return window.PlatformUI?.scrollElement?.(el) || el;
    },
    barEl() { return document.getElementById('home-search-bar'); },

    // Screenshot-state deep link (?shot=home-search): the revealed bar
    // is otherwise interaction-only, so before/after captures and
    // dapp.json tests could never see it. Pure UI state — no writes,
    // no env gate — so it works in production the moment it ships.
    shotRevealed() {
      try {
        return new URLSearchParams(location.search).get('shot') === 'home-search';
      } catch (err) { return false; }
    },

    // Focused, mid-query, or deep-linked: leave the bar wherever the
    // user put it, including during initial positioning and empty blur.
    isPinned() {
      if (Home._searchReveal._pinned) return true;
      if ((Home._query || '').trim()) return true;
      return Home._searchReveal.shotRevealed();
    },

    pin() { Home._searchReveal._pinned = true; },

    // A PHONE ONLY (#17 of the 19 Oct polish board). Under 768px the bar
    // parks under the header and a pull brings it out. From 768px there is
    // no pull: the parked bar left the desktop with no search in sight, and
    // an empty blur scrolled the page back up on its own. There it stays in
    // view. `!== false`: with no PlatformUI to ask, it parks, as it did.
    tucks() { return window.PlatformUI?.isPhoneLayout?.() !== false; },

    // Bring a parked or half-parked bar all the way out (QA 2026-09-24
    // Q30c). A parked bar is transparent under the translucent header now
    // (app.css), so focusing it must also SHOW it. Only from near the top:
    // a page scrolled well past the bar is left to the browser's own
    // focus scrolling.
    reveal() {
      const screen = Home._searchReveal.screenEl();
      const bar = Home._searchReveal.barEl();
      if (!screen || !bar) return;
      const h = bar.offsetHeight || 0;
      if (h && screen.scrollTop > 0 && screen.scrollTop <= h) screen.scrollTop = 0;
      Home._searchReveal.mark();
    },
    unpin() {
      Home._searchReveal._pinned = false;
      Home._searchReveal.sync({ park: true });
    },

    // Stamp the current state on the bar so tests / screenshot checks
    // can assert it without measuring scroll offsets.
    mark() {
      const screen = Home._searchReveal.screenEl();
      const bar = Home._searchReveal.barEl();
      if (!screen || !bar) return;
      const h = bar.offsetHeight || 0;
      // Half the bar showing already reads as "revealed".
      const revealed = !h || screen.scrollTop < h / 2;
      bar.dataset.revealed = revealed ? 'true' : 'false';
    },

    // Park once per mounted, measurable bar. Refreshes only stamp its
    // current state, preserving even a partially revealed search field.
    // Empty-field blur can explicitly request parking again.
    sync({ park = false } = {}) {
      const screen = Home._searchReveal.screenEl();
      const bar = Home._searchReveal.barEl();
      if (!screen || !bar) return;
      Home._searchReveal._wireScroll(screen);
      const h = bar.offsetHeight || 0;
      const initial = Home._searchReveal._initializedBar !== bar;
      if (h) Home._searchReveal._initializedBar = bar;
      if ((initial || park) && Home._searchReveal.tucks() && !Home._searchReveal.isPinned()
        && h && screen.scrollTop < h) {
        if (initial) screen.scrollTop = h;
        else Home._searchReveal.glide(screen, h);
      }
      Home._searchReveal.mark();
    },

    // Tuck a bar the viewer can SEE. The first park happens before anything
    // is drawn, so it is instant; a later one (blur on an empty field) moved
    // the whole screen up by the bar's height in a single frame while the
    // keyboard was still going down. Scrolled smoothly, it slides away.
    glide(screen, top) {
      let still = false;
      try { still = reducedMotion(); } catch (err) { /* unknown: animate */ }
      if (still || typeof screen.scrollTo !== 'function') {
        screen.scrollTop = top;
        return;
      }
      screen.scrollTo({ top, behavior: 'smooth' });
    },

    _wireScroll(screen) {
      if (Home._searchReveal._scrollWired) return;
      Home._searchReveal._scrollWired = true;
      const markOnScroll = () => {
        if (Home._searchReveal._rafPending) return;
        Home._searchReveal._rafPending = true;
        const run = () => {
          Home._searchReveal._rafPending = false;
          Home._searchReveal.mark();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
      };
      // Element scrolling does not bubble; document scrolling has a different
      // target. Observe both because resizing can change the scrolling owner.
      document.getElementById('home-screen').addEventListener('scroll', markOnScroll, { passive: true });
      document.addEventListener('scroll', markOnScroll, { passive: true });
    },
  },

  // Screenshot-state deep link (`?shot=card-menu`, #847): the card's "…"
  // actions menu only exists after a click, so neither the before/after
  // captures nor a dapp.json test can reach it — and it's exactly the
  // surface whose missing background this param exists to prove. Opening
  // it from the URL makes it capturable and testable. Pure UI state (it
  // opens the same kit popover a click opens, writes nothing, and is not
  // env-gated), so the production "before" side works too once shipped.
  //
  // Anchored to the FIRST card in the grid so the shot is deterministic;
  // pair it with `?demo=1` in staging to pin that to a seeded demo tile
  // (routes/apps.js demoIconApps, which unshifts them to the front).
  // Fires once per page load — a later re-render (a WS app_update, a
  // search keystroke) must not pop the menu back open under the user.
  // "Once" means once SUCCESSFULLY: the flag is burned where the menu
  // actually opens, at the bottom of the rAF, and every early return
  // above it leaves the link armed for the next render. That ordering is
  // the whole fix for #847's flake — before the first-app-payload gate above,
  // Home.load() could paint once from the layout/panels response while
  // /api/apps was still in flight (empty grid: no "…" trigger and no app to
  // resolve), then again with the apps. The readiness gate now prevents that
  // cold-load paint, while this consume-on-success rule remains necessary for
  // genuinely empty accounts and for the Browse grid racing the Home grid.
  //
  // Called by the launcher grid that carries the menu, home's #app-list
  // (Discover's #browse-list was the second until One Home, #6361). A
  // hidden grid has no offsetParent, so it neither opens a menu the user
  // can't see nor burns the once-only flag.
  _shotMenuDone: false,
  _shotMenuPending: false,

  _maybeOpenShotMenu(listEl) {
    if (Home._shotMenuDone || Home._shotMenuPending) return;
    let shot = null;
    let gesture = null;
    try {
      const q = new URLSearchParams(location.search);
      shot = q.get('shot');
      gesture = q.get('gesture');
    } catch (err) { /* ignore */ }
    if (shot !== 'card-menu') return;
    if (gesture !== 'contextmenu' && gesture !== 'hold') gesture = null;
    if (!listEl || listEl.offsetParent === null) return; // not the visible grid
    Home._shotMenuPending = true;
    // Deferred a frame: the grid was written synchronously just above,
    // and the kit's flip/clamp placement needs the button's settled rect.
    requestAnimationFrame(() => {
      Home._shotMenuPending = false;
      if (Home._shotMenuDone) return; // a render that raced us already won
      // The tile itself is the menu anchor now; there is no launcher badge.
      const btn = listEl.querySelector('.app-card[data-slug]');
      let slug = btn && btn.dataset.slug;
      let anchor = btn;
      // #929: a fresh checks database has an EMPTY "Your apps" grid, so
      // that selector finds nothing and the link used to open no menu at
      // all — which is how the touch idiom (a kit action sheet, the thing
      // that actually broke) went two releases without a check. Fall back
      // to the featured row's first tile, anchored to the card itself:
      // the same call a long-press makes.
      if (!slug) {
        const featured = document.getElementById('home-featured-list');
        const card = featured && featured.offsetParent !== null
          ? featured.querySelector('.app-card[data-slug]')
          : null;
        if (card) {
          slug = card.dataset.slug;
          anchor = card.getBoundingClientRect();
        }
      }
      if (!slug) return;
      // #1838: the gesture modes drive the REAL listeners rather than calling
      // openCardMenu, which is the only way a declared check can prove a
      // mouse can reach the menu instead of proving the menu builder works.
      // They need the card ELEMENT — the featured-row fallback above hands
      // back a rect, and a rect cannot receive an event — so leave the
      // one-shot unspent and let a later repaint with a real launcher tile
      // have its turn.
      const el = anchor && typeof anchor.dispatchEvent === 'function' ? anchor : null;
      if (gesture && !el) return;
      // A genuinely empty Home grid, or a hidden grid that raced Browse, has
      // no target. Consume the one-shot only after a real one exists, so the
      // next data-bearing/visible repaint gets another chance.
      Home._shotMenuDone = true;
      if (gesture) {
        Home._dispatchCardMenuGesture(el, gesture);
        // `hold` opens on the recognizer's own 400ms timer, so the opacity
        // lock waits for it rather than for the next frame.
        setTimeout(
          () => { if (Home._menu) Home._assertMenuOpaque(); },
          gesture === 'hold' ? 700 : 60,
        );
        return;
      }
      Home.openCardMenu(slug, anchor);
      // openCardMenu is a no-op when the app isn't in Home._apps yet or
      // carries no actions for this viewer; Home._menu is how it reports
      // that it actually put a menu up. Only then is the link spent.
      if (!Home._menu) return;
      Home._shotMenuDone = true;
      requestAnimationFrame(() => Home._assertMenuOpaque());
    });
  },

  // Synthesises one of the two MOUSE entry points on a launcher tile, for
  // `?shot=card-menu&gesture=…`. Everything downstream is the real wiring:
  // the tile's own React handlers and _wireCardLongPressMenu's timer.
  _dispatchCardMenuGesture(card, gesture) {
    const Pointer = typeof window.PointerEvent === 'function' ? window.PointerEvent : MouseEvent;
    const rect = typeof card.getBoundingClientRect === 'function'
      ? card.getBoundingClientRect() : null;
    const down = (button) => {
      card.dispatchEvent(new Pointer('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button,
        buttons: button === 2 ? 2 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: rect ? Math.round(rect.left + rect.width / 2) : 0,
        clientY: rect ? Math.round(rect.top + rect.height / 2) : 0,
      }));
    };
    if (gesture === 'hold') {
      // Left button down and left there: no pointerup, no pointermove, so
      // the 400ms hold runs to completion exactly as a held mouse does.
      down(0);
      return;
    }
    // Right-click. The pointerdown is what records the pointer type (and,
    // for a real mouse, what makes the kit dismiss any open menu), so it
    // has to lead — the same order the browser delivers them in.
    down(2);
    card.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2,
    }));
  },

  // Regression lock for #847, and the second reason the deep link above
  // exists: a translucent menu is invisible to a selector/text test (every
  // row is present and correct — you just read the app grid through them),
  // so assert the SURFACE. The verdict is stamped on the popover as
  // data-surface, which a dapp.json test asserts on, and a violation also
  // logs console.error so it trips the baseline no-console-errors check on
  // the same route. Scoped to ?shot=card-menu, so a real user's menu never
  // runs this.
  _assertMenuOpaque() {
    const pop = document.querySelector('.un-popover');
    if (!pop) return; // touch idiom: an action sheet over the kit's own backdrop
    const bg = getComputedStyle(pop).backgroundColor || '';
    const m = bg.match(/^rgba?\(([^)]+)\)$/);
    const parts = m ? m[1].split(',').map((s) => parseFloat(s.trim())) : [];
    // 3 components = rgb(), fully opaque. No match at all (`transparent`,
    // an unresolved var) counts as alpha 0 — the bug this guards against.
    const alpha = parts.length >= 4 ? parts[3] : (parts.length === 3 ? 1 : 0);
    const opaque = alpha >= 0.99;
    pop.dataset.surface = opaque ? 'opaque' : 'translucent';
    if (!opaque) {
      console.error(
        `[home] card actions menu surface is translucent (${bg}) — the page reads`
        + ' through it (#847). --un-popover-bg must resolve to an opaque color.'
      );
    }
  },

  // ===== Search bar =====
  //
  // Bound once, lazily, from render() — the input is static markup in
  // index.html so there's no per-render listener churn and no focus
  // loss. ~100ms debounce is plenty; the list is small and filtering
  // is a pure client-side re-render.
  _searchWired: false,
  _searchDebounce: null,

  _wireSearch() {
    if (Home._searchWired) return;
    const input = document.getElementById('home-search-input');
    const clearBtn = document.getElementById('home-search-clear');
    if (!input) return;
    Home._searchWired = true;
    const apply = () => {
      Home._query = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
      Home.render();
    };
    input.addEventListener('input', () => {
      // Typing pins the bar open — a re-render must never scroll the
      // field the user is typing into off the top of the screen.
      Home._searchReveal.pin();
      // EDIT MODE (#4669): a value in the field ends it, so arranging the
      // shelf and searching never happen at once.
      if (Home._editing && input.value) Home._editing = false;
      clearTimeout(Home._searchDebounce);
      Home._searchDebounce = setTimeout(apply, 100);
    });
    input.addEventListener('focus', () => {
      Home._searchReveal.pin();
      Home._searchReveal.reveal();
    });
    // Leaving an empty field releases the pin, so the next render (or a
    // scroll down) can tuck the bar away again. A field with text in it
    // stays pinned by isPinned()'s query check.
    input.addEventListener('blur', () => {
      if (!input.value) Home._searchReveal.unpin();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        clearTimeout(Home._searchDebounce);
        apply();
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearTimeout(Home._searchDebounce);
        apply();
        input.focus();
      });
    }
    // / from anywhere, and Ctrl+K (⌘K) while Home shows, put the cursor in
    // this box (./search-shortcut.ts, #6462). From another screen / opens
    // Home first, which is what focusSearch does.
    installHomeSearchShortcut({
      doc: document,
      open: (showing) => {
        // Under a look the field on screen is the kit page's: focusSearch finds it.
        if (!showing || Home._searchField() !== input) { Home.focusSearch(); return; }
        try {
          input.focus({ preventScroll: false });
          input.select?.();
        } catch (err) { /* nothing to focus */ }
      },
    });
  },

  // Add / remove one app from "Your apps", from anywhere: a discovery rail,
  // the browse screen's rows and detail, and the card menu (which is this
  // function now — see _menuToggleFavorite). For a member, favorited=false
  // writes the per-user `hidden` opt-out rather than dropping membership.
  //
  // Optimistic: flip the flags on the cached app object and repaint, then
  // revert to server truth by reloading on failure.
  //
  // THE REPAINT IS THE POINT (#1567). The flags on the cached object decide
  // what "Your apps" holds, but only a render turns that into pixels, and
  // this function used to leave it to `onChange` — which the home screen's
  // Discover rail does not pass at all, so an add from the home screen
  // changed nothing on screen until the next reload. Home.render() is the
  // single call that covers every surface: it rebuilds the grid AND ends by
  // re-rendering the panels, so the badge and the new tile land in the same
  // frame. `onChange` still runs, because the browse screen's own list is
  // outside Home's paint.
  async toggleAdded(slug, desired, onChange) {
    // An app this list has not loaded yet is not a silent no-op: see
    // _favoriteUnknown below.
    const known = (list) => (Array.isArray(list) ? list : []).find((a) => a && a.slug === slug);
    const app = known(Home._apps);
    // Staging ?demo=1 tiles have no DB row — a POST would 404. An app NEITHER
    // list holds is not that case: it is a list this tab has not loaded yet,
    // and the server is the authority on whether the slug exists. Ask it, and
    // let Home.load() bring back the truth either way, so the press is
    // answered by a toast rather than by silence.
    if (app && app.demo) return;
    if (!app) return Home._favoriteUnknown(slug, desired, onChange);
    // ONE HOME (#6361): pinning an app is only that. It no longer joins the
    // app's community, and taking it off Home no longer asks about leaving
    // (#5962's sheet): the community has its own pin, on the Communities
    // tab's page, and its own Leave, on its hub.
    const prev = { is_favorited: app.is_favorited, your_apps_hidden: app.your_apps_hidden, is_member: app.is_member };
    app.is_favorited = desired;
    if (app.is_collaborator) app.your_apps_hidden = !desired;
    // Only an ADD needs the reveal: a removal takes a tile away, and a grid
    // that expanded itself to show an absence would be nonsense.
    if (desired) Home._revealSlug = slug;
    Home.render();
    if (typeof onChange === 'function') onChange();
    try {
      const res = await fetch(`/api/apps/${slug}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: desired }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data) || `HTTP ${res.status}`);
      PlatformUI.toast(desired ? message('home:myApps.added') : message('home:myApps.removed'));
    } catch (err) {
      app.is_favorited = prev.is_favorited;
      app.your_apps_hidden = prev.your_apps_hidden;
      app.is_member = prev.is_member;
      // The add never happened, so nothing should be revealed for it. load()
      // renders, and a stale slug would expand the grid for an app that is
      // not there.
      Home._revealSlug = null;
      PlatformUI.toast(message('home:myApps.updateFailed', { reason: err.message }));
      await Home.load();
      if (typeof onChange === 'function') onChange();
    }
  },

  // Join or leave the community `slug` belongs to — Discover's Join pill,
  // its detail page and the join-required prompt all come through here.
  // POST /api/apps/:slug/membership (src/routes/apps.js).
  //
  // JOINING ALSO PINS THE COMMUNITY to Home (One Home, #6361: the server
  // does both, communities.join), never the app: the app's pin is its own
  // act, offered on the join's toast. Leaving unpins the community and
  // leaves the app's pin where it is.
  //
  // LEAVING ASKS FIRST. It is the one membership change with a cost you
  // might not expect — on a private app it is your access, and everywhere it
  // is your vote — and a pill that left on one tap would be a pill people
  // are afraid to touch. The creator is never offered it: the server refuses
  // (409) and the confirm would be a dead end.
  //
  // A WRITE THAT LANDS SAYS SO on `document`, as the tour's done does
  // (`sv:tour-done`): `sv:membership-changed`, with `{ slug, joined }`. The
  // flags above keep the grid and Discover's pill in step, but Home's
  // Challenges block holds a copy of what the server counted, for a minute
  // (./home-panels.js), and a join changes it: the server counts "Join a
  // community" before it answers (challengeScorer.scoreOnJoin). The block
  // listens and reads again, so the challenge ticks on Home as it does on
  // the Challenges tab, which reads afresh each time it opens. A leave says
  // so the same way. A refused write says nothing: nothing changed.
  //
  // Resolves true when the membership is now `desired`, false otherwise.
  async setMembership(slug, desired, onChange, opts = {}) {
    const known = (list) => (Array.isArray(list) ? list : []).find((a) => a && a.slug === slug);
    const app = known(Home._apps) || null;
    if (app && app.demo) return false;
    const name = (app && app.name) || opts.name || slug;
    if (!desired && !opts.confirmed) {
      const privateApp = !!app && app.view_visibility === 'private';
      // No confirm dialog in this document means no leaving from it: a
      // silent leave is the one outcome this step exists to prevent.
      const confirmModal = typeof window !== 'undefined' ? window.ConfirmModal : null;
      const ok = await confirmModal?.show?.({
        title: message('home:leave.confirm.title', { community: name }),
        message: privateApp
          ? message('home:leave.confirm.private')
          : message('home:leave.confirm.public'),
        confirmLabel: message('home:leave.confirm.button'),
        danger: true,
      });
      if (!ok) return false;
    }
    const prev = app ? {
      is_member: app.is_member,
      is_favorited: app.is_favorited,
      your_apps_hidden: app.your_apps_hidden,
      is_collaborator: app.is_collaborator,
      member_count: app.member_count,
    } : null;
    // ONE HOME (#6361): joining pins the COMMUNITY to Home (the server writes
    // it, ./home-pins-store.ts reads it back on the membership event below);
    // the app's own pin is untouched either way.
    if (app) {
      app.is_member = desired;
      if (!desired) app.is_collaborator = false;
      app.member_count = Math.max(0, (Number(app.member_count) || 0) + (desired ? 1 : -1));
      if (desired) Home._revealSlug = slug;
      Home.render();
      if (typeof onChange === 'function') onChange();
    }
    try {
      // Joining a public community asks a provisional handle for a username
      // first (username-first-run.js publicRetry).
      const write = () => fetch(`/api/apps/${encodeURIComponent(slug)}/membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joined: desired }),
      });
      const retry = typeof window !== 'undefined' ? window.UsernameFirstRun?.publicRetry : null;
      const res = desired && retry ? await retry(write) : await write();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data) || `HTTP ${res.status}`);
      if (app && Number.isFinite(Number(data.member_count))) app.member_count = Number(data.member_count);
      if (desired) {
        const pinnable = app && !Home.isYours(app) && !app.demo;
        PlatformUI.toast(message('home:membership.joinedPinned', { community: name }), pinnable ? {
          action: { label: message('home:membership.pinAppToo'), handler: () => { void Home.toggleAdded(slug, true); } },
        } : undefined);
      } else {
        PlatformUI.toast(message('home:membership.left', { community: name }));
      }
      Home._announceMembership(slug, desired);
      if (!app) {
        await Home.load();
        if (typeof onChange === 'function') onChange();
      }
      return true;
    } catch (err) {
      if (app && prev) Object.assign(app, prev);
      Home._revealSlug = null;
      PlatformUI.toast(desired
        ? message('home:membership.joinFailed', { reason: err.message })
        : message('home:membership.leaveFailed', { reason: err.message }));
      await Home.load();
      if (typeof onChange === 'function') onChange();
      return false;
    }
  },

  // The event setMembership's landed write dispatches (see there). Never
  // throws: the write has landed, and a document without CustomEvent (the
  // server-side prerender, a test's stub) only means nobody is listening.
  MEMBERSHIP_EVENT: 'sv:membership-changed',
  _announceMembership(slug, joined) {
    try {
      if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
      if (typeof CustomEvent !== 'function') return;
      document.dispatchEvent(new CustomEvent(Home.MEMBERSHIP_EVENT, {
        detail: { slug, joined: !!joined },
      }));
    } catch (_) { /* a listener's trouble is not the write's */ }
  },

  // The slow path for a slug neither app list carries — see toggleAdded.
  // There is no cached object to flip, so there is nothing to do optimistically
  // and nothing to revert: post, say what happened, and reload the list, which
  // is what puts the row in both places for next time.
  async _favoriteUnknown(slug, desired, onChange) {
    try {
      const res = await fetch(`/api/apps/${slug}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: desired }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data) || `HTTP ${res.status}`);
      if (desired) Home._revealSlug = slug;
      PlatformUI.toast(desired ? message('home:myApps.added') : message('home:myApps.removed'));
      if (desired && data && data.joined === true) Home._announceMembership(slug, true);
    } catch (err) {
      Home._revealSlug = null;
      PlatformUI.toast(message('home:myApps.updateFailed', { reason: err.message }));
    }
    await Home.load();
    if (typeof onChange === 'function') onChange();
  },

  // ===== Per-render card wiring =====

  // #931: start warming the app the finger is already on — the token mint
  // and the TCP/TLS handshake to its origin — so the tap that follows can
  // point the iframe at the app in its own tick. `pointerdown` is the real
  // lever on touch (it fires ~100ms before click, and long-press-to-drag
  // still ends up here harmlessly); `mouseenter` buys much more on desktop.
  // Passive: this never calls preventDefault and must not delay scrolling.
  //
  // #1882: the STATUS is not consulted here, on purpose. app-grid.tsx's
  // `wireRef` is guarded by a module-level WeakSet, so this runs exactly once
  // per card DOM node — and React keeps that node across re-renders. Reading
  // `card.dataset.status` here therefore froze a snapshot taken the first
  // time the tile was ever attached: an app that was still coming up when
  // the homepage painted got no listeners, and got none later however many
  // times it reached 'running'. That is the slow case the issue is about, on
  // a cold load, where rows move into 'running' while the viewer watches.
  //
  // `App.prewarmApp` already re-reads the live launcher record and returns
  // unless `rec.status === 'running'` (also `demo`, `self_hosted`, `url`,
  // offline), so the check belongs there — at event time, against the truth —
  // and this only has to attach. That is the shape browse.js's two call sites
  // always had, which is why the homepage was the one surface with this bug.
  // `demo` stays here: it is a fixed property of the tile, not a status.
  _wirePrewarm(card) {
    const slug = card.dataset.slug;
    if (!slug || card.dataset.demo === 'true') return;
    const warm = () => { try { App.prewarmApp(slug); } catch (err) { /* ignore */ } };
    card.addEventListener('pointerdown', warm, { passive: true });
    card.addEventListener('mouseenter', warm);
  },

  // NOTE: _wireCards is gone (#1191). It existed because an innerHTML
  // assignment destroys every listener under it, so all four sweeps — card
  // click, prewarm, long-press menu, retry and the card-menu button — had to
  // run again after each render. React keeps the card nodes across renders,
  // so those handlers are ordinary props on the elements that own them
  // (features/home/app-grid.tsx) and the two gesture attachments run once per
  // card from its ref. What was the tail of this function — the kit's
  // placement recognizer — is _attachGridPlacement above.


  // Map structured drift-check result → a short, user-readable
  // message. Mirrors the status enum in main-drift-poller.js.
  reportCheckResult(data) {
    if (!data || !data.status) {
      PlatformUI.toast(message('home:check.noDetails'));
      return;
    }
    switch (data.status) {
      case 'no_drift':
        // The check-updates button is git-drift-only. When SHA hasn't
        // moved but the operator still wants a rebuild (env vars
        // changed, platform code changed, container needs reset),
        // offer a one-click escape hatch into the unconditional
        // /redeploy endpoint instead of dead-ending. The Secrets
        // modal also exposes this same endpoint via "redeploy now",
        // but most operators reach for the home-card ⟳ first.
        if (data.slug) {
          PlatformUI.confirm({
            title: message('home:check.noDrift.title'),
            message: message('home:check.noDrift.message'),
            confirmLabel: message('home:check.noDrift.confirm'),
          }).then((ok) => {
            if (!ok) return;
            fetch(`/api/apps/${data.slug}/redeploy`, { method: 'POST' })
              .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
              .then(() => PlatformUI.toast(message('home:check.rebuild.started')))
              .catch((err) => PlatformUI.toast(message('home:check.rebuild.failed', { reason: err.message })));
          });
        }
        return;
      case 'in_flight':
        PlatformUI.toast(message('home:check.inFlight'));
        return;
      case 'deploy_requested':
        PlatformUI.toast(message('home:check.deployRequested', { sha: (data.to || '').slice(0, 7) }));
        return;
      case 'first_seen':
        PlatformUI.toast(message('home:check.firstSeen', { sha: (data.sha || '').slice(0, 7) }));
        return;
      case 'fetch_failed':
        PlatformUI.toast(data.error
          ? message('home:check.fetchFailed', { reason: data.error })
          : message('home:check.fetchFailedUnknown'));
        return;
      case 'invalid_repo':
        PlatformUI.toast(message('home:check.invalidRepo'));
        return;
      default:
        PlatformUI.toast(message('home:check.finished', { status: data.status }));
    }
  },

  // The "Your proposals" / "Your active sessions" strips that used to
  // render here (#194) moved into the header cog's drawer — see
  // the Improve panel (features/improve/), which owns their
  // fetches, rendering and busy-state polling now.

  // Pill builder for an app's status/activity flags, and the icon-tile
  // inner markup + kind. Both are shared with the browse screen's rows and
  // detail hero and with the app view's header tile, so all four surfaces
  // draw an app the same way.
  //
  // The implementations live in frontend/src/features/apps/app-card.js as of
  // #1083 chunk F, which is where browse.js went when it became a bundle
  // module and could no longer reach them through `window.Home`. These two
  // stay as delegating methods because their callers name them:
  // public/js/app-view.js's header tile (iconTileFor), renderAppCard /
  // renderMenuHeaderHtml / updateAppCardIcon below, and the card tests. As of
  // step 4 of the chunk this module rides in the bundle too, so the delegation
  // is a plain import rather than a `window.AppCard` read.
  renderAppPillsHtml(app) {
    return AppCard.renderAppPillsHtml(app);
  },

  iconTileFor(app) {
    return AppCard.iconTileFor(app);
  },

  // `opts.mode` picks the corner controls:
  //   'home' (default) — the "…" actions menu alone, top-right.
  //   'featured' / 'browse' — an add/remove badge (`.card-add-btn`,
  //     ✓ when the app is already in "Your apps") top-right, because a
  //     discovery grid's primary per-tile action is "keep this", PLUS the
  //     same "…" menu top-left when `opts.menu` is set.
  // Everything else — icon tile, status dot, users badge, fork tag,
  // click-to-open rule — is shared, so the launcher grids can't drift.
  renderAppCard(app, opts) {
    const mode = (opts && opts.mode) || 'home';
    const discovery = mode === 'featured' || mode === 'browse';
    const isAwaiting = app.status === 'awaiting_secrets';
    // The status DOT is gone from the tile face — a launcher icon should
    // read as an app, not as a dashboard row. What it signalled that no
    // other tile element does is an in-flight redeploy of an
    // ALREADY-RUNNING app; that state now lives only in the "…" menu's
    // version pill (renderMenuHeaderHtml), which renders it explicitly.
    // Every non-running status still says so in words on the tile — see
    // statusLabel / warningHtml below — so "Spinning up…", "Awaiting
    // secrets" and "Error" are unaffected.
    const { line: buildLine, phase: buildPhase } = Home.tileBuildStage(app);
    const statusLabel = buildLine ? htmlText(buildLineTileWordsOf(buildLine, buildPhase))
      : app.status === 'running' ? ''
      : app.status === 'creating' ? htmlText('home:grid.tile.status.creating')
      : isAwaiting ? htmlText('home:grid.tile.status.awaitingSecrets')
      : htmlText('home:grid.tile.status.error');
    const isError = app.status === 'error';
    const isRunning = app.status === 'running';
    // The active-users badge is gone from the tile face too. The count is
    // still served (and still shown where it is actually information: the
    // Browse-all directory, which is a ranked list — see browse.js).
    // Awaiting-secrets cards stay clickable so the user can open the
    // app view + Secrets modal to fill values; other non-running
    // statuses show no app surface.
    // Launcher actions open from the tile context menu. Retry remains an
    // inline recovery action for creators/full admins on errored apps.
    const showRetry = !discovery && isError
      && (App.user?.canAdminWrite || App.user?.id === app.created_by);
    // A tile with Retry greys only its icon (QA 2026-09-24 Q9): a greyed
    // card made the one working control on it look disabled.
    const cursorClass = (isRunning || isAwaiting) ? 'cursor-pointer'
      : showRetry ? 'cursor-not-allowed' : 'cursor-not-allowed grayscale-[0.75]';

    // Per-tile sections, computed up front so the template stays
    // readable. Anything that may be empty is collapsed to '' so the
    // tile self-trims without leaving stray padding.
    //
    // The warning line is status-only: the missing-secret detail (and
    // every other pill — to vote / in dev / issues / privacy) lives
    // ONLY in the hamburger menu's build-info header now
    // (renderMenuHeaderHtml → renderAppPillsHtml); the card face
    // carries no chips at all.
    // #416: hovering an errored card reveals the one-line failure
    // reason. `last_failure_reason` only rides the list payload for the
    // app's creator / collaborators / admins (server-gated), so the
    // tooltip simply doesn't render for outsiders. escapeHtml here
    // doesn't cover quotes (textContent→innerHTML), so add the
    // attribute-safe pass explicitly.
    const failureTip = isError && app.last_failure_reason
      ? ` title="${escapeHtml(String(app.last_failure_reason)).replace(/"/g, '&quot;')}"`
      : '';
    // #4053: a first version's build line is quiet (blue when it asks), not
    // the status colours below.
    const warningHtml = statusLabel
      ? (buildLine
        ? `<p class="${buildLineTileClass(buildLine)}" data-build-line="${buildLine}">${statusLabel}</p>`
        : `<p class="app-card-status ${isAwaiting ? 'text-[color:var(--state-attention)]' : 'text-[color:var(--state-blocked)]'}"${failureTip}>${statusLabel}</p>`)
      : '';

    const isLocked = !!app.locked;
    // Discovery grids swap the hamburger for the add/remove badge: a ✓
    // when the app is already in "Your apps", a + when it isn't. The
    // added state derives from the same isYours() predicate the home
    // grid partitions on, so the two can never disagree.
    const isAdded = Home.isYours(app);
    const addBadgeHtml = `
      <button class="card-add-btn absolute -top-1.5 -end-1.5 w-6 h-6 flex items-center justify-center rounded-full border shadow-sm transition-colors ${
        isAdded
          ? 'bg-emerald-500 border-emerald-500 text-white'
          : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-violet-700 dark:text-violet-400 hover:border-violet-400'
      }" data-slug="${app.slug}" data-added="${isAdded}" title="${
        isAdded ? htmlText('home:discover.card.addedTip') : htmlText('home:discover.card.addTip')
      }" aria-label="${
        isAdded
          ? htmlText('home:discover.card.removeNamed', { app: String(app.name || '') })
          : htmlText('home:discover.card.addNamed', { app: String(app.name || '') })
      }" aria-pressed="${isAdded}">${
        isAdded
          ? '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
          : '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>'
      }</button>`;
    // Discovery keeps its explicit menu beside the add badge. Launcher
    // tiles use long press / right click instead (#1616).
    const hamburgerHtml = (corner) => `
      <button class="card-menu-btn absolute -top-1.5 ${corner} w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors" data-slug="${app.slug}" title="${htmlText('home:grid.tile.actions')}" aria-label="${htmlText('home:grid.tile.actions')}" aria-haspopup="menu"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>`;
    // Discovery grids show BOTH: the add/remove badge as the primary
    // affordance, plus the same "…" menu the home cards have, so an app
    // you haven't added still offers Fork / build log / admin actions
    // without a detour through home. `opts.menu` opts a grid in — the
    // browse screen passes it; the home featured row doesn't (yet).
    // Staging ?demo=1 tiles never get it: their slugs have no DB row, so
    // every action in the menu would 404.
    const wantsMenu = !!(opts && opts.menu) && !app.demo;
    const menuBadgeHtml = discovery
      ? `${addBadgeHtml}${wantsMenu ? hamburgerHtml('-start-1.5') : ''}`
      : '';
    // QA 2026-09-24 Q9: Retry is a pill in the caption lane beside "Error",
    // not a corner button the icon covered on phones. Same classes as
    // app-grid.tsx's RETRY_BTN; a Retry tile greys only its icon.
    const retryHtml = showRetry
      ? `<button type="button" class="retry-btn relative inline-flex items-center rounded-full bg-violet-600 hover:bg-violet-500 px-1.5 text-[11px] leading-3 font-semibold text-white cursor-pointer transition-colors before:absolute before:-inset-x-1.5 before:-inset-y-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1" data-slug="${app.slug}" aria-label="${htmlText('home:grid.tile.retryNamed', { app: String(app.name || '') })}">${htmlText('core:common.retry')}</button>`
      : '';

    // Lineage tag: a small badge on the icon's bottom-left corner
    // (opposite the hamburger badge) marking this tile as a version made
    // from another app (docs/plans/versions.md). The full "Made from
    // <name>" line lives on the app's own page; here it's glyph-only with
    // the resolved live name (or "<deleted>") in the tooltip. It wears the
    // audience badge's quiet face with a two-tile glyph (app-grid.tsx's
    // copy, which says why); the ⑂ fork sign it had is gone with the word.
    // `forked_from` is null for an app that is not a version.
    const forkName = app.forked_from && typeof app.forked_from === 'object'
      ? (app.forked_from.name || '<deleted>') : null;
    const forkDeleted = !!forkName && !app.forked_from.name;
    const forkTagHtml = forkName
      ? `<span class="fork-tag absolute -bottom-1 -start-1 w-5 h-5 flex items-center justify-center rounded-full bg-white text-zinc-600 shadow-[0_0_0_1.5px_var(--app-sheet-line)] dark:bg-zinc-800 dark:text-zinc-300" title="${(forkDeleted ? htmlText('home:grid.tile.remixedFromDeleted', { open: '<', close: '>' }) : htmlText('home:grid.tile.remixedFrom', { app: forkName }))}" aria-label="${(forkDeleted ? htmlText('home:grid.tile.remixedFromDeleted', { open: '<', close: '>' }) : htmlText('home:grid.tile.remixedFrom', { app: forkName }))}"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/></svg></span>`
      : '';

    const icon = Home.iconTileFor(app);
    // escapeHtml is a textContent->innerHTML pass, which leaves quotes
    // alone — same attribute-safe extra step the failure tooltip takes.
    const nameAttr = escapeHtml(String(app.name || '')).replace(/"/g, '&quot;');

    // Layout: icon first at the top,
    // the name centered below it, then the status warning when present
    // (the status dot and the active-users badge that used to flank the
    // name are both gone — a launcher tile is an icon and a label).
    // Everything is
    // horizontally centered in the tile — homescreen-launcher style —
    // and the card draws NO border: the violet hover/drop-slot tint
    // (.app-card:hover in app.css) is the affordance. The title is
    // .app-card-title (app.css): iOS-sized 11px/13px type clamped to
    // TWO lines with an ellipsis, in a fixed-height lane so a long name
    // shows far more of itself without making its tile any taller than
    // a short one. The untruncated name stays reachable as the title
    // attribute (and in the "…" menu header).
    //
    // Every card carries app-card-draggable + touch-pan-y (not just
    // the reorderable ones): the long-press actions menu applies to
    // every card, so text selection / the mobile callout must be
    // suppressed card-wide, while touch-pan-y keeps vertical
    // scrolling alive until a long-press actually fires (see app.css).
    // Staging ?demo=1 tiles (routes/apps.js demoIconApps) carry
    // data-demo so the kit drag's :not([data-demo]) selector skips
    // them — their slugs don't exist in the DB, so a drag-to-favorite
    // would 404. They keep the long-press menu instead.
    const demoAttr = app.demo ? ' data-demo="true"' : '';
    return `
      <div class="app-card app-card-draggable touch-pan-y relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 ${cursorClass}" data-slug="${app.slug}" data-status="${app.status}" data-locked="${isLocked}"${demoAttr}>
        <div class="relative w-14 h-14 shrink-0${showRetry ? ' grayscale-[0.75]' : ''}">
          <div class="app-icon-tile w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center font-bold text-xl" data-icon="${icon.kind}">
            ${icon.html}
          </div>
          ${menuBadgeHtml}
          ${forkTagHtml}
        </div>
        <div class="w-full min-w-0">
          <div class="app-card-title" title="${nameAttr}">${escapeHtml(app.name)}</div>
          ${showRetry ? `<div class="app-card-retry flex items-center justify-center gap-1">${warningHtml}${retryHtml}</div>` : warningHtml}
        </div>
      </div>
    `;
  },

  // NOTE: renderCreateTile() is gone. "Create an app" is the launcher grid's
  // trailing TILE now (./create-tile.tsx, placed by render() — the prototype's
  // scrHome), present on every home screen for every account — in quieter
  // ink, and self-explaining, where the viewer has no app quota. It was a fixed section
  // below Challenges for a while; the tile is the same button at the end of
  // the grid it belongs to. It carries its own handler; CREATE_DISABLED_HINT
  // below is still the one wording of the locked case, which render() hands
  // the tile for its label. A tap opens the create dialog, where the exact
  // quota is shown.

  // ── Homeroom widget section (iOS in-app only) ──────────────────────
  //
  // A strip above the launcher grid mirroring the pinned grid the iOS
  // homescreen widget renders. Tiles are the device registry, in widget
  // order; entries pinned by other dapps show up too (letter icon, no
  // SV app match) and are just as removable/reorderable.
  // Toggled by the ⓘ button in the section header; survives re-renders
  // within the session like _widgetSectionVisible.
  _widgetHelpVisible: false,

  // The strip's view model. Was `renderWidgetSection()`, an HTML string, and
  // is the same decision as data (#1191 slice 7): ./widget-strip.tsx renders
  // it. `active: false` is what `return ''` meant — the section is hidden and
  // draws nothing, which is every platform but the iOS app.
  widgetSectionView() {
    if (!Home._widgetUiActive()) {
      return { active: false, helpVisible: false, tiles: [] };
    }
    return {
      active: true,
      helpVisible: !!Home._widgetHelpVisible,
      tiles: (Home._widgetItems || []).map((it) => Home.widgetTileView(it)),
    };
  },

  // One pinned shortcut, as the strip draws it. Same three icon kinds as the
  // home card, tagged with the same `kind` so the tile treatment (app.css)
  // can single out the letter fallback for its fainter glyph colour — and
  // resolved through AppCard.iconViewFor so the priority order has one home.
  widgetTileView(item) {
    const slug = Home._widgetSlugFor(item);
    const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
    const name = (app && app.name) || item.name || '?';
    // An entry another dapp pinned has no SV app behind it: fall back to the
    // registry's own name for the letter, rather than iconViewFor's '?'.
    const icon = app
      ? AppCard.iconViewFor(app)
      : { kind: 'letter', letter: String(name).charAt(0).toUpperCase() };
    return { id: item.id, slug: slug || null, name, icon };
  },

  // The strip's GESTURE, and only that. Done, the ⓘ help toggle and each
  // tile's ✕ used to be wired here too, re-attached on every paint because
  // the paint replaced the nodes they were on; they are props in
  // ./widget-strip.tsx now, on elements React keeps. What is left attaches
  // listeners to nodes and writes no markup, which is why the component may
  // call it (same split app-grid.tsx makes for the canvas recognizer).
  _wireWidgetStrip(listEl) {
    const strip = listEl.querySelector('#widget-strip');
    if (!strip) return;
    if (window.unNative && typeof window.unNative.attachReorder === 'function') {
      // The strip keeps attachREORDER, not the grid's attachGridPlacement,
      // and that is the right call: the iOS widget's pinned shortcuts are a
      // genuine ORDERED LIST on the device (the bridge's
      // reorderHomeScreenShortcuts takes a sequence), not a canvas with
      // holes. Displacement mode is used because the list model's Y-only
      // ghost and drop line are degenerate for a one-row tile strip
      // (issue #770). onLift/onSettle hold _dragActive so a WS-driven
      // Home.load() can't replace the strip mid-gesture (same guard as
      // the card grid).
      if (Home._widgetReorderHandle) { try { Home._widgetReorderHandle.detach(); } catch {} }
      Home._widgetReorderHandle = window.unNative.attachReorder(strip, {
        grid: true,
        itemSelector: '.widget-tile',
        onLift: () => { Home._dragActive = true; },
        onSettle: () => {
          Home._dragActive = false;
          if (Home._reloadPending) {
            Home._reloadPending = false;
            Home._rerenderPending = false;
            Home.load();
          } else if (Home._rerenderPending) {
            Home._rerenderPending = false;
            Home.render();
          }
        },
        onReorder: () => { Home._saveWidgetOrder(strip); },
      });
    } else {
      strip.querySelectorAll('.widget-tile').forEach((tile) => {
        tile.addEventListener('pointerdown', (e) =>
          Home._onWidgetTilePointerDown(e, tile, strip));
      });
    }
  },

  // Optimistic remove: the tile disappears immediately; on bridge
  // failure the registry is re-fetched so the UI snaps back to device
  // truth (same optimistic-then-revert shape as _menuToggleFavorite).
  async _removeWidgetItem(id) {
    Home._widgetItems = (Home._widgetItems || []).filter((it) => it.id !== id);
    Home.render();
    try {
      await window.usernode.removeHomeScreenShortcut(id);
    } catch (err) {
      PlatformUI.toast(message('home:widget.removeFailed', { reason: String((err && err.message) || err) }));
      await Home._refreshWidgetItems();
      Home.render();
    }
  },

  // Persist whatever order the strip currently shows. The app answers
  // with the authoritative order (unknown ids dropped, missing ids
  // appended), which we mirror back into _widgetItems.
  async _saveWidgetOrder(strip) {
    const ids = [...strip.querySelectorAll('.widget-tile')].map((t) => t.dataset.wid);
    const byId = new Map((Home._widgetItems || []).map((it) => [it.id, it]));
    Home._widgetItems = ids.map((id) => byId.get(id)).filter(Boolean);
    try {
      await window.usernode.reorderHomeScreenShortcuts(ids);
    } catch (err) {
      PlatformUI.toast(message('home:widget.reorderFailed', { reason: String((err && err.message) || err) }));
      await Home._refreshWidgetItems();
      Home.render();
    }
  },

  // Drag-to-reorder for widget tiles. A slimmed-down cousin of the app
  // card drag below: same ghost-plus-in-flow-slot idea, but tiles are
  // small and live in one flex row, so there's no FLIP animation or
  // edge auto-scroll. Mouse promotes on >6px movement; touch arms
  // after a ~250ms hold (no actions menu on tiles, so the hold goes
  // straight to pickup).
  _onWidgetTilePointerDown(e, tile, strip) {
    if (e.button !== 0) return;
    if (Home._dragActive) return;
    if (e.target.closest('.widget-remove-btn')) return;
    // Only one tile: nothing to reorder.
    if (strip.querySelectorAll('.widget-tile').length < 2) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType === 'touch';
    let armed = !isTouch;
    let dragging = false;
    let longPressTimer = null;
    let ghost = null;
    let grabX = 0;
    let grabY = 0;

    if (isTouch) {
      longPressTimer = setTimeout(() => {
        armed = true;
        tile.style.transform = 'scale(1.08)';
      }, 250);
    }
    const onTouchMove = (ev) => { if (dragging || armed) ev.preventDefault(); };
    const onContextMenu = (ev) => { if (dragging || armed) ev.preventDefault(); };
    if (isTouch) {
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('contextmenu', onContextMenu);
    }

    const beginDrag = (refX, refY) => {
      dragging = true;
      Home._dragActive = true;
      grabX = refX;
      grabY = refY;
      try { strip.setPointerCapture(pointerId); } catch {}
      const rect = tile.getBoundingClientRect();
      ghost = tile.cloneNode(true);
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        zIndex: '1000',
        pointerEvents: 'none',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.3)',
        transform: 'scale(1.04)',
        transition: 'none',
      });
      document.body.appendChild(ghost);
      // Same drop-slot treatment as app-card drags: contents hidden,
      // box restyled as a dashed violet gap (inline styles so the look
      // doesn't depend on the CDN JIT mid-gesture).
      tile.style.transform = '';
      for (const child of tile.children) child.style.visibility = 'hidden';
      Object.assign(tile.style, {
        borderWidth: '1px',
        borderStyle: 'dashed',
        borderColor: 'rgba(31, 134, 255, 0.55)',
        backgroundColor: 'rgba(31, 134, 255, 0.07)',
        borderRadius: '0.75rem',
      });
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      document.body.style.cursor = 'grabbing';
    };

    const detach = () => {
      clearTimeout(longPressTimer);
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('contextmenu', onContextMenu);
      try { strip.releasePointerCapture(pointerId); } catch {}
    };

    const teardown = () => {
      if (ghost) { ghost.remove(); ghost = null; }
      tile.style.transform = '';
      for (const child of tile.children) child.style.visibility = '';
      tile.style.borderWidth = '';
      tile.style.borderStyle = '';
      tile.style.borderColor = '';
      tile.style.backgroundColor = '';
      tile.style.borderRadius = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.body.style.cursor = '';
      Home._dragActive = false;
      if (Home._reloadPending) {
        Home._reloadPending = false;
        Home.load();
      }
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!armed) {
          // Finger moved before the hold armed the drag → scrolling.
          if (dist > 10) detach();
          return;
        }
        if (dist > (isTouch ? 10 : 6)) beginDrag(ev.clientX, ev.clientY);
        if (!dragging) return;
      }
      ev.preventDefault();
      ghost.style.transform =
        `translate(${ev.clientX - grabX}px, ${ev.clientY - grabY}px) scale(1.08)`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest('.widget-tile');
      if (!over || over === tile || !strip.contains(over)) return;
      const rect = over.getBoundingClientRect();
      if (ev.clientX < rect.left + rect.width / 2) {
        if (tile.nextElementSibling !== over) over.before(tile);
      } else {
        if (over.nextElementSibling !== tile) over.after(tile);
      }
    };

    const onUp = async (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      if (!didDrag) { teardown(); return; }
      teardown();
      await Home._saveWidgetOrder(strip);
    };

    const onCancel = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      teardown();
      // Abort without persisting — re-render restores the saved order.
      if (didDrag) Home.render();
    };

    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onCancel);
  },

  // Targeted lock-state refresh for a single app card, called from the
  // WS app_update handler (app.js handleAppUpdate) and the menu's own
  // toggle. The menu is built lazily from the Home._apps cache at open
  // time, so keeping the cache + the card's data-locked attribute fresh
  // is all that's needed — no live button swap, and no full Home.load()
  // that would blow away hover/scroll state on other cards. Safe no-op
  // if the card isn't mounted (different screen, not loaded yet, etc.).
  updateAppCardLock(slug, isLocked) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (app) app.locked = !!isLocked;
    // Same as updateAppCardIcon below: `data-locked` is rendered by
    // features/home/app-grid.tsx now, so the cache write above is the change
    // and this publishes it. Writing the attribute here would be overwritten
    // by the next render.
    Home.render();
  },

  // ── Native homescreen-shortcut support ─────────────────────────────
  //
  // Probed once per page via the bridge (usernode-bridge.js is loaded
  // by index.html). The bridge resolves { mechanism: "unsupported" } in
  // plain browsers AND on old app builds (it races the native call
  // against a timeout), so this never hangs — worst case the cache just
  // stays null and the menu item doesn't render. Fired from load(), so
  // it has long settled by the time a user opens a card menu.
  _shortcutSupport: null,
  _shortcutProbeStarted: false,
  _probeShortcutSupport() {
    if (Home._shortcutProbeStarted) return;
    Home._shortcutProbeStarted = true;
    // Start watching the system appearance (and foregrounds) here rather
    // than inside the widget branch below: the probe resolves
    // asynchronously, so the registration would otherwise race a flip
    // that happens during it. Both handlers are inert until the widget
    // mechanism is known anyway.
    Home._watchWidgetScheme();
    Home._watchWidgetForeground();
    const bridge = window.usernode;
    if (!bridge || typeof bridge.getHomeScreenShortcutSupport !== 'function') return;
    bridge.getHomeScreenShortcutSupport().then((support) => {
      Home._shortcutSupport = (support && support.mechanism) ? support : null;
      // iOS: shortcuts live in a shared widget grid, which SV can mirror
      // as a manageable section above "Your apps" (see
      // renderWidgetSection). Fetch the registry eagerly — the menu's
      // ✓-state and the capacity check need it — but the section itself
      // stays hidden until the user asks for it (_widgetSectionVisible).
      if (Home._shortcutSupport?.mechanism === 'widget') {
        return Home._refreshWidgetItems();
      }
    }).catch(() => { /* stay null — item simply never renders */ });
  },

  // ── iOS widget mirror ───────────────────────────────────────────────
  //
  // Home._widgetItems is the device-wide pinned registry as reported by
  // the app: null until (unless) a fetch succeeds, then an array of
  // { id, name, url, pinnedAtMs } in widget display order. null hides
  // the section entirely — old app builds resolve null (bridge timeout),
  // so the management UI only appears where every management call works.
  _widgetItems: null,
  // The section is opt-in per page load: hidden until the user clicks
  // "Add to Homeroom widget" (see _menuAddShortcut), then it stays up
  // for the rest of the session as the management surface.
  _widgetSectionVisible: false,
  // The iOS medium widget renders at most 8 tiles (see
  // UsernodeDappsWidget.swift, mediumView prefix(8)); adds beyond that
  // wouldn't be visible on the homescreen, so SV refuses them with a
  // shake instead.
  WIDGET_CAPACITY: 8,

  async _refreshWidgetItems() {
    const bridge = window.usernode;
    if (!bridge || typeof bridge.getHomeScreenShortcuts !== 'function') return;
    try {
      const resp = await bridge.getHomeScreenShortcuts();
      Home._widgetItems = (resp && Array.isArray(resp.items)) ? resp.items : null;
    } catch (_) {
      Home._widgetItems = null;
    }
    await Home._healWidgetIcons();
  },

  // Widget icons drift out of sync with SV app data in two ways:
  //   - The icon PNG never landed in the app's widget store (pinned by
  //     an older page build, or the download failed) — the registry
  //     reports has_icon:false.
  //   - The stored PNG is stale: the app gained/changed/lost its
  //     icon_url after pinning (e.g. an icon proposal passed), or the
  //     canvas-tile rendering changed (WIDGET_ICON_GEN bump). The
  //     registry still reports has_icon:true, so staleness is detected
  //     by remembering which icon source was last sent per shortcut id
  //     (localStorage) and comparing against the current desired source.
  // Either way the fix is the same: silently re-add with the current
  // icon payload — re-pinning the same URL is an in-place refresh, so
  // order is kept and no instruction walkthrough pops. One attempt per
  // shortcut id per page load so a persistently failing icon can't loop.
  //
  // WIDGET_ICON_GEN versions the canvas-tile rendering; it's part of
  // the recorded source string for tile-based icons, so bumping it
  // makes every canvas tile read as stale and re-send once.
  //   gen 2: pixel-centered glyphs (_drawGlyphCentered) — emoji tiles
  //          used to come out anchored bottom-left on iOS WebKit.
  //   gen 3: white rounded-tile face + faint grey hairline + dark-grey
  //          letter, matching the new .app-icon-tile treatment (was a
  //          flat violet-600/20 square with a violet-400 letter).
  //   gen 4: the letter glyph steps down to the faint grey the in-app
  //          letter tiles now use (--text-faint); emoji unchanged.
  //   gen 5: the tile is rendered per colour scheme instead of pinning
  //          the light face — gen 3/4 baked an opaque #ffffff square,
  //          which read as a bright white tile on a dark homescreen.
  //          The scheme is also part of the source marker below, so a
  //          light↔dark flip re-sends on top of this one-time bump.
  //
  // Deliberately NOT bumped for the dual-icon work (#948). The shell
  // that can't take a pair still gets byte-identical gen-5 pixels under
  // a byte-identical `tile:5:<scheme>:…` marker, so bumping would cost
  // every one of those users a full-grid re-send for artwork that did
  // not change. The only entries whose artwork DOES change are the ones
  // on a capable shell, and those are already distinguished by the new
  // `dual` value in the marker's variant segment — which is what
  // actually drives re-sends. (Gen 6 was briefly claimed by an
  // appearance-neutral tile that was reverted before merging, so the
  // number is free; use 7 if that ever reaches main independently.)
  WIDGET_ICON_GEN: 5,
  // The two faces the canvas tile can wear, mirroring `.app-icon-tile`
  // in app.css. Light is the pre-existing treatment, unchanged; dark
  // uses the same tokens the CSS tile resolves to under `.dark`
  // (--bg-secondary / --border / --text-faint). Emoji glyphs are never
  // recoloured — they carry their own colours in both schemes.
  WIDGET_TILE_PALETTE: {
    light: { face: '#ffffff', hairline: '#e4e4e7', letter: '#a1a1aa' },
    dark: { face: '#1a1a30', hairline: '#2e2e50', letter: '#9898b0' },
  },
  // The colour scheme the widget PNG should be painted for.
  //
  // Deliberately the SYSTEM appearance (prefers-color-scheme), NOT the
  // `.dark` class / Theme.get(): the PNG is consumed by the iOS
  // homescreen widget, which renders under the system appearance and
  // cannot see SV's in-app Light/Dark/System override. Keying off the
  // in-app theme would paint a light widget onto a dark homescreen
  // whenever someone forces SV to light.
  //
  // Falls back to 'light' wherever matchMedia is missing (old WebViews,
  // the vm sandbox in tests) — _desiredIconSrcFor runs on every heal
  // pass, so throwing here would break icon healing outright.
  _schemeQuery() {
    try {
      return typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    } catch (_) { return null; }
  },
  _widgetScheme() {
    const mq = Home._schemeQuery();
    return (mq && mq.matches) ? 'dark' : 'light';
  },
  // ── Dual-icon capability (#948) ─────────────────────────────────────
  //
  // A stored PNG can't restyle itself, and SV can't repaint one while
  // the app is closed — which is exactly when the system flips. The
  // only real fix is to hand the widget BOTH faces and let it pick per
  // colorScheme natively. That needs the shell to store a second icon
  // (Flutter repo issue #518), so it is gated on the capability the
  // shell advertises once it honours the field end to end.
  //
  // Absent the flag, everything below stays on the gen-5 path: bake the
  // face matching the current system appearance and re-send on a flip,
  // with the known limitation that the correction waits for the next
  // app open. Present, the payload carries both faces and stops
  // depending on the appearance at all.
  WIDGET_DARK_ICON_CAPABILITY: 'homeScreenShortcutDarkIcon',
  // ── Why this is not a plain `NativeChrome.has()` any more ───────────
  //
  // It was, and that is what kept the released shell fix invisible. The
  // capability list arrives from getBridgeInfo, which resolves
  // `{ version: 0, capabilities: [], degraded: true }` whenever the
  // handshake times out or the privileged channel is refused —
  // circumstances that say NOTHING about what the installed app can
  // store. `has()` collapses that to `false` (it is deliberately binary,
  // see public/js/native-chrome.js), the old code memoised the answer in
  // `_darkIconProbe` for the rest of the page load, and every tile went
  // out as a single face under a `tile:5:<scheme>:…` marker. The next
  // pass agreed with itself, so the grid never recovered — the exact
  // latched-negative shape issue #978 forbids.
  //
  // So the probe is TRI-STATE now, on three levels:
  //   1. `NativeChrome.supports()` — true / false / null, where null is
  //      "could not say" (no bridge, degraded info, empty capability
  //      list). A null is never memoised: `_darkIconProbe` is dropped so
  //      the next heal pass asks the shell again.
  //   2. A behavioural verdict (below), because "does not advertise" and
  //      "cannot store" are different claims and only the second one
  //      matters here.
  //   3. `_widgetDarkIcons` itself stays true / false / null, and the
  //      synchronous payload + marker builders test it with `=== true`,
  //      so an unresolved probe behaves exactly like the old
  //      single-face path rather than emitting a half-built pair.
  //
  // Both entry points still await the probe before building a payload or
  // a marker — a pass that ran on the unresolved value would send a
  // single face that the next pass immediately re-sends as a pair.
  _widgetDarkIcons: null,
  _darkIconProbe: null,
  // The raw capability answer, kept apart from the resolution so the
  // diagnostics row can show what the shell actually said.
  _darkIconCapability: null,
  // { appVersion, buildNumber } of the INSTALLED shell, read from the
  // same getBridgeInfo answer, or null when it could not be read.
  _darkIconBuild: null,
  // 'supported' | 'unsupported' | null — the behavioural verdict in
  // force for this build (see _confirmDarkIconSupport).
  _widgetDarkVerdict: null,
  _ensureDarkIconCapability() {
    if (Home._darkIconProbe) return Home._darkIconProbe;
    const probe = Home._probeDarkIconCapability();
    Home._darkIconProbe = probe;
    return probe;
  },
  async _probeDarkIconCapability() {
    const chrome = window.NativeChrome;
    let answer = null;
    if (chrome && typeof chrome.supports === 'function') {
      try {
        answer = await chrome.supports(Home.WIDGET_DARK_ICON_CAPABILITY);
      } catch (_) { answer = null; }
    }
    if (answer !== true && answer !== false) answer = null;
    Home._darkIconCapability = answer;
    Home._darkIconBuild = await Home._readDarkIconBuild(chrome);
    // The in-memory fallback matters in private mode, where the verdict
    // could not be written: without it a confirmed session would fall
    // back to "unresolved" on the very next pass, and _darkIconConfirmTried
    // means it can never be re-confirmed either.
    const stored = Home._storedVerdictForBuild(Home._darkIconBuild)
      || (Home._darkIconConfirmTried ? Home._widgetDarkVerdict : null);
    Home._widgetDarkVerdict = stored;
    // Resolution order: a behavioural verdict recorded against THIS
    // installed build outranks the capability list (it was obtained by
    // watching what the shell actually stored); then a conclusive yes;
    // otherwise the question is still open and _confirmDarkIconSupport
    // settles it with one silent send.
    Home._widgetDarkIcons = stored === 'supported' ? true
      : stored === 'unsupported' ? false
        : (answer === true ? true : null);
    // Never latch "could not say".
    if (Home._widgetDarkIcons === null) Home._darkIconProbe = null;
    return Home._widgetDarkIcons;
  },
  // The version pair the verdict is bound to. Read through getInfo
  // rather than getSettingsState: getInfo is unprivileged, so it still
  // answers on a device whose privileged handshake was refused. A
  // degraded answer carries no version, and an unversioned verdict is
  // not trusted (see _storedVerdictForBuild).
  async _readDarkIconBuild(chrome) {
    if (!chrome || typeof chrome.getInfo !== 'function') return null;
    let info = null;
    try { info = await chrome.getInfo(); } catch (_) { return null; }
    if (!info || info.degraded === true) return null;
    if (!info.appVersion) return null;
    return {
      appVersion: String(info.appVersion),
      buildNumber: info.buildNumber == null ? null : String(info.buildNumber),
    };
  },
  // ── The behavioural verdict ─────────────────────────────────────────
  //
  // NATIVE-BRIDGE.md tells a shell that cannot store a second face not to
  // advertise the capability, but the converse does not hold: a shell
  // that CAN store one may still fail to advertise it (the string landed
  // in a later release than the storage did) or may be unable to answer
  // at all (degraded getBridgeInfo). The registry read-back is the only
  // statement of fact available — `has_icon_dark` is written by the same
  // code path that stores the asset — so when the capability list can't
  // give a conclusive yes, SV sends one pair and looks.
  //
  // The answer is a property of the INSTALLED BUILD, so it is persisted
  // against `{ appVersion, buildNumber }` and discarded the moment that
  // pair changes: an app update is precisely when a shell gains (or
  // loses) the ability, and a verdict that outlived the build it was
  // measured on would be the same latch in a slower disguise.
  WIDGET_DARK_VERDICT_KEY: 'sv:widget_dark_icons',
  _loadDarkIconVerdict() {
    try {
      const rec = JSON.parse(localStorage.getItem(Home.WIDGET_DARK_VERDICT_KEY));
      if (!rec || typeof rec !== 'object') return null;
      if (rec.verdict !== 'supported' && rec.verdict !== 'unsupported') return null;
      return rec;
    } catch (_) { return null; /* private mode / corrupt */ }
  },
  _storedVerdictForBuild(build) {
    const rec = Home._loadDarkIconVerdict();
    if (!rec) return null;
    // No readable version means no binding, so the record proves
    // nothing about the app that is running now — re-confirm instead.
    if (!build || !build.appVersion) return null;
    if (rec.appVersion !== build.appVersion) return null;
    if (String(rec.buildNumber ?? '') !== String(build.buildNumber ?? '')) return null;
    return rec.verdict;
  },
  _recordDarkIconVerdict(verdict) {
    Home._widgetDarkVerdict = verdict;
    Home._widgetDarkIcons = verdict === 'supported';
    const build = Home._darkIconBuild || {};
    try {
      localStorage.setItem(Home.WIDGET_DARK_VERDICT_KEY, JSON.stringify({
        appVersion: build.appVersion ?? null,
        buildNumber: build.buildNumber ?? null,
        verdict,
      }));
    } catch (_) { /* private mode — re-confirmed next load */ }
  },
  // One confirmation per page load, on the first canvas-tile entry in the
  // registry. Image icons can't answer the question (they are single
  // artwork by design and never carry a dark face), and a foreign
  // shortcut isn't ours to touch.
  _darkIconConfirmTried: false,
  async _confirmDarkIconSupport(bridge) {
    if (Home._darkIconConfirmTried) return Home._widgetDarkIcons;
    if (!bridge || typeof bridge.getHomeScreenShortcuts !== 'function') {
      return Home._widgetDarkIcons;
    }
    let probeItem = null;
    let probeApp = null;
    for (const item of Home._widgetItems || []) {
      const slug = Home._widgetSlugFor(item);
      const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
      if (!app || app.icon_url) continue;
      probeItem = item;
      probeApp = app;
      break;
    }
    // Nothing to ask with — stay unresolved and try again on the next
    // pass, once the registry or the apps list has landed.
    if (!probeApp) return Home._widgetDarkIcons;
    Home._darkIconConfirmTried = true;
    try {
      await bridge.addHomeScreenShortcut({
        ...Home._shortcutPayloadFor(probeApp, 'dual'),
        silent: true,
      });
    } catch (_) {
      // Denied or unavailable: the send proved nothing, so no verdict is
      // recorded and the tile keeps whatever it had.
      return Home._widgetDarkIcons;
    }
    let stored = null;
    try {
      const resp = await bridge.getHomeScreenShortcuts();
      if (resp && Array.isArray(resp.items)) {
        Home._widgetItems = resp.items;
        stored = resp.items.find((it) => it.id === probeItem.id) || null;
      }
    } catch (_) {
      return Home._widgetDarkIcons; // couldn't look — no verdict
    }
    // Strict === true, mirroring the strict === false the heal pass uses:
    // a shell that reports neither key has not confirmed anything.
    if (stored && stored.has_icon_dark === true) {
      Home._recordDarkIconVerdict('supported');
      Home._recordIconSrc(probeItem.id, Home._desiredIconSrcFor(probeApp));
      return true;
    }
    Home._recordDarkIconVerdict('unsupported');
    // The pair's light face is what such a shell kept, which on a dark
    // homescreen is the bright tile this whole feature exists to stop.
    // Repaint the probe tile for the CURRENT appearance immediately, so
    // asking the question never leaves a tile worse than not asking it.
    try {
      await bridge.addHomeScreenShortcut({
        ...Home._shortcutPayloadFor(probeApp),
        silent: true,
      });
      Home._recordIconSrc(probeItem.id, Home._desiredIconSrcFor(probeApp));
    } catch (_) { /* leave it for the pass below to retry */ }
    return false;
  },
  _iconSrcKey: 'sv:widget_icon_src',
  _iconHealTried: null,
  // The icon source the widget *should* have for this app right now.
  // Image icons: the absolute URL (matches _shortcutPayloadFor). Canvas
  // tiles: an opaque marker keyed by emoji + rendering generation + the
  // VARIANT the payload was built for.
  //
  // The variant is 'dual' where the shell takes a light/dark pair — the
  // payload is then identical in both appearances, so a flip must NOT
  // mark anything stale. Otherwise it is the scheme the single face was
  // painted for ('light' / 'dark'), exactly as gen 5 recorded it, so a
  // flip still marks every canvas tile stale and re-sends it.
  //
  // The variant is NOT part of the image-icon marker — that payload is
  // the app's own URL, identical in both schemes and in both capability
  // states, so folding it in would re-send every image tile for no
  // visual change.
  _desiredIconSrcFor(app) {
    if (app.icon_url) return new URL(app.icon_url, location.origin).href;
    const variant = Home._widgetDarkIcons === true ? 'dual' : Home._widgetScheme();
    return `tile:${Home.WIDGET_ICON_GEN}:${variant}:${app.icon_emoji || ''}`;
  },
  // Re-paint pinned canvas tiles when the system appearance flips.
  //
  // Registered once per page load. The heal pass itself is gated on the
  // widget mechanism + the bridge, so this is inert on web, Android and
  // desktop; the handler only does work when the scheme ACTUALLY moved,
  // so a spurious media event can't re-send the whole grid.
  _widgetSchemeWatching: false,
  _widgetSchemeSeen: null,
  _watchWidgetScheme() {
    if (Home._widgetSchemeWatching) return;
    Home._widgetSchemeWatching = true;
    Home._widgetSchemeSeen = Home._widgetScheme();
    const mq = Home._schemeQuery();
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', Home._onWidgetSchemeChange);
    }
    // Theme also re-broadcasts OS changes while the user is in "system"
    // mode. Redundant with the query above, but free: the equality
    // guard below turns a duplicate notification into a no-op, and it
    // costs nothing where window.Theme isn't loaded (tests, standalone).
    if (window.Theme && typeof window.Theme.onChange === 'function') {
      window.Theme.onChange(Home._onWidgetSchemeChange);
    }
  },
  _onWidgetSchemeChange() {
    const scheme = Home._widgetScheme();
    if (scheme === Home._widgetSchemeSeen) return;
    Home._widgetSchemeSeen = scheme;
    // Load-bearing: _iconHealTried caps sends to one attempt per
    // shortcut id per page load. Without clearing it the flip would
    // mark every tile stale and then skip all of them.
    Home._iconHealTried = null;
    Promise.resolve(Home._healWidgetIcons()).catch(() => {});
  },
  // Re-run the heal pass when the app comes back to the foreground.
  //
  // Not redundant with the scheme watcher above. The native shell can
  // restore the webview without a page load, so Home.load() and the
  // probe don't necessarily re-run when someone reopens the app — gen 5
  // relied on the media-query listener happening to fire on resume,
  // which is incidental rather than guaranteed. It is also how a newly
  // installed dual-icon-capable shell gets picked up: the capability is
  // probed per page load and the marker transition needs a pass to act
  // on it.
  //
  // Overlap with the scheme watcher is free: the _widgetSchemeSeen
  // guard, the per-entry marker comparison, _iconHealTried and the
  // in-flight guard all turn a redundant pass into a no-op.
  //
  // Inert on web, Android and desktop: the handler early-returns unless
  // the app reported the widget mechanism.
  WIDGET_FOREGROUND_HEAL_MS: 30000,
  _widgetForegroundWatching: false,
  _widgetForegroundHealedAt: 0,
  _watchWidgetForeground() {
    if (Home._widgetForegroundWatching) return;
    Home._widgetForegroundWatching = true;
    if (typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', Home._onWidgetForeground);
  },
  _onWidgetForeground() {
    if (document.visibilityState !== 'visible') return;
    if (Home._shortcutSupport?.mechanism !== 'widget') return;
    // Throttled: _iconHealTried caps sends to one attempt per shortcut
    // id per page load, and clearing it is what lets a pending heal
    // retry. Rapid app switching must not turn a persistently failing
    // icon into a send on every foreground.
    const now = Date.now();
    if (now - Home._widgetForegroundHealedAt < Home.WIDGET_FOREGROUND_HEAL_MS) return;
    Home._widgetForegroundHealedAt = now;
    Home._iconHealTried = null;
    // Re-FETCH the registry, don't just re-heal against the snapshot in
    // memory. The whole point of a foreground is that the world moved
    // while SV was suspended: entries were pinned or removed from the
    // widget, and `has_icon` / `has_icon_dark` were rewritten by whatever
    // the shell managed to store from the last pass. Healing against the
    // stale snapshot re-derives the same decisions from the same numbers
    // and settles on the same wrong answer, which is how a tile that
    // failed to gain its dark face stayed single-faced across every
    // reopen. _refreshWidgetItems heals as its last step.
    Promise.resolve(Home._refreshWidgetItems()).then(() => {
      // A refresh that couldn't read the registry learned nothing, so it
      // must not spend the throttle window: disarm it and let the next
      // foreground try again.
      if (!Array.isArray(Home._widgetItems)) Home._widgetForegroundHealedAt = 0;
    }).catch(() => { Home._widgetForegroundHealedAt = 0; });
  },
  _loadIconSrcMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(Home._iconSrcKey));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; /* private mode / corrupt */ }
  },
  // Read-modify-write of a single record. Used by the capability
  // confirmation, which sends before the heal pass takes its snapshot —
  // recording the marker there is what stops the pass re-sending the tile
  // it just probed with.
  _recordIconSrc(id, src) {
    const map = Home._loadIconSrcMap();
    map[id] = src;
    try {
      localStorage.setItem(Home._iconSrcKey, JSON.stringify(map));
    } catch (_) { /* private mode — the pass re-sends once next load */ }
  },
  // Serialised: a pass reads the recorded-source map, awaits a bridge
  // round trip per stale tile, then writes the map back. Two overlapping
  // passes would each write a snapshot taken before the other's sends,
  // so the last writer drops the other's records and those tiles re-send
  // on the next load. Several triggers can collide — Home.load(),
  // _refreshWidgetItems, the scheme watcher and the foreground watcher —
  // so a second caller joins the running pass instead of starting its
  // own.
  _healInFlight: null,
  _healWidgetIcons() {
    if (Home._healInFlight) return Home._healInFlight;
    const pass = Home._healWidgetIconsPass()
      .finally(() => { Home._healInFlight = null; });
    Home._healInFlight = pass;
    return pass;
  },
  // Last-pass telemetry, for the Settings → "Widget icons" row. Kept
  // here rather than derived there: by the time someone opens Settings
  // the interesting pass has long finished. The outcome is recorded as
  // `{ kind, sent, refused }`, not as text: Settings says it, together with
  // the time, as one whole message (settings:usernode.widgetIcons.lastCheck.*).
  _lastHealAt: 0,
  _lastHealOutcome: null,
  async _healWidgetIconsPass() {
    if (Home._shortcutSupport?.mechanism !== 'widget') {
      Home._lastHealOutcome = { kind: 'skippedMechanism' };
      return;
    }
    const bridge = window.usernode;
    if (!bridge || typeof bridge.addHomeScreenShortcut !== 'function') {
      Home._lastHealOutcome = { kind: 'skippedBridge' };
      return;
    }
    // Resolve the dual-icon capability BEFORE building any marker or
    // payload, so the synchronous builders below never see the unprobed
    // null and send a single face that the next pass re-sends as a pair.
    await Home._ensureDarkIconCapability();
    // Still open after the capability list had its say: settle it by
    // observation, once. This runs before the snapshot below so its own
    // send and read-back are already recorded when the loop compares.
    if (Home._widgetDarkIcons === null) await Home._confirmDarkIconSupport(bridge);
    Home._lastHealAt = Date.now();
    const tried = (Home._iconHealTried ||= new Set());
    const srcMap = Home._loadIconSrcMap();
    let mapDirty = false;
    let healed = false;
    let sent = 0;
    let failed = 0;
    const liveIds = new Set();
    for (const item of Home._widgetItems || []) {
      liveIds.add(item.id);
      if (tried.has(item.id)) continue;
      const slug = Home._widgetSlugFor(item);
      const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
      // Foreign shortcuts (no SV slug) can never be healed here; SV
      // entries whose app hasn't loaded yet are left un-tried so a
      // later pass retries once the apps list lands.
      if (!app) continue;
      const desired = Home._desiredIconSrcFor(app);
      const needsIcon = item.has_icon === false;
      // Pinned before the shell could hold a dark asset: the marker can
      // already match (same emoji, same generation) while the second
      // face is simply missing, so the read-back flag is what catches
      // it. Strict === false, like has_icon above, so a shell that
      // reports neither key never triggers a send. Image icons are
      // permanently dark-assetless by design (the app's own artwork is
      // appearance-independent), hence the !app.icon_url clause —
      // without it every image tile would look stale on every pass.
      const needsDark = Home._widgetDarkIcons === true
        && !app.icon_url
        && item.has_icon_dark === false;
      const stale = srcMap[item.id] !== desired;
      if (!needsIcon && !needsDark && !stale) continue;
      tried.add(item.id);
      try {
        await bridge.addHomeScreenShortcut({
          ...Home._shortcutPayloadFor(app),
          silent: true,
        });
        healed = true;
        sent += 1;
        srcMap[item.id] = desired;
        mapDirty = true;
      } catch (_) {
        failed += 1; /* denied / old build — leave the fallback tile */
      }
    }
    // Drop records for shortcuts no longer in the registry so the map
    // can't grow without bound as apps are pinned and unpinned.
    for (const id of Object.keys(srcMap)) {
      if (!liveIds.has(id)) {
        delete srcMap[id];
        mapDirty = true;
      }
    }
    if (mapDirty) {
      try {
        localStorage.setItem(Home._iconSrcKey, JSON.stringify(srcMap));
      } catch (_) { /* private mode — retried next load, sends deduped by `tried` */ }
    }
    Home._lastHealOutcome = (sent || failed)
      ? (failed
        ? { kind: 'sentRefused', sent, refused: failed }
        : { kind: 'sent', sent })
      : { kind: 'nothing' };
    if (healed) {
      try {
        const resp = await bridge.getHomeScreenShortcuts();
        if (resp && Array.isArray(resp.items)) Home._widgetItems = resp.items;
      } catch (_) { /* keep the pre-heal snapshot */ }
    }
  },

  // The widget section (and drag-into-widget affordance) is active only
  // when the app reports the widget mechanism, the registry fetch
  // succeeded, AND the user has revealed the section this session.
  _widgetUiActive() {
    if (Home._shotWidgetDrop) return true; // ?shot=widget-drop, see below
    return Home._widgetSectionVisible
      && Home._shortcutSupport?.mechanism === 'widget'
      && Array.isArray(Home._widgetItems);
  },

  // Widget entries deep-link `origin/app/<slug>`. The old hash form remains
  // readable so an existing native widget heals in place the next time its
  // entries are reconciled. Anything else was pinned by another dapp.
  _widgetSlugFor(item) {
    const url = String(item?.url || '');
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.origin !== location.origin) return null;
      const clean = parsed.pathname.match(/^\/app\/([^/]+)\/?$/);
      if (clean) return decodeURIComponent(clean[1]);
      const legacy = parsed.hash.match(/^#app\/([^/]+)(?:\/app)?$/);
      return legacy ? decodeURIComponent(legacy[1]) : null;
    } catch (_) {
      return null;
    }
  },

  // Set of SV slugs currently in the widget — drives the "already
  // added" state in menus and drag targets.
  _widgetSlugs() {
    const out = new Set();
    for (const item of Home._widgetItems || []) {
      const slug = Home._widgetSlugFor(item);
      if (slug) out.add(slug);
    }
    return out;
  },

  // Targeted icon refresh for a single app card, called from the WS
  // app_update handler (app.js handleAppUpdate, action 'icon_changed')
  // after a deploy reconciled the dapp.json icon block. Same shape as
  // updateAppCardLock: patch the Home._apps cache + the mounted tile in
  // place, no full Home.load() that would blow away hover/scroll state.
  // Safe no-op if the card isn't mounted.
  updateAppCardIcon(slug, iconEmoji, iconUrl) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (app) {
      app.icon_emoji = iconEmoji || null;
      app.icon_url = iconUrl || null;
    }
    // #1191: the tile is React-owned now, so this re-renders instead of
    // writing into it. The cache update above IS the change; Home.render()
    // publishes it and React repaints the one tile whose icon moved.
    //
    // Writing `tile.innerHTML` here would have made this a SECOND writer
    // inside a subtree React reconciles — the exact hazard the stateful-island
    // rule in AGENTS.md exists to prevent. It would also have been silently
    // temporary: the next store push would paint the old icon straight back.
    //
    // The comment above still holds and is now free rather than hand-managed —
    // a reconcile touches the changed tile and nothing else, so hover and
    // scroll state on every other card survive without a special path.
    Home.render();
  },

  // ===== "…" card actions menu =====
  //
  // One adaptive menu shared by the desktop "⋯" button and the mobile
  // long-press (see _onCardPointerDown). Built lazily on open from the
  // app object in the Home._apps cache — no hidden per-card menus in
  // the DOM. Presentation is kit-owned via PlatformUI.menu (#741):
  // bottom action sheet on touch, anchored popover (flip/clamp
  // positioning, outside-pointerdown / Escape / scroll / resize
  // dismissal, menu focus handling) on desktop.
  _menu: null,
  // The element the open menu is anchored to, and what it was at the last
  // pointerdown — see _wireMenuAnchorSnapshot / #1838.
  _menuAnchor: null,
  _menuAnchorAtPress: null,
  _menuAnchorSnapshotWired: false,

  // Pure item builder, separate from the DOM so tests can pin the
  // permission gating. Mutating controls gate on canAdminWrite (full
  // admin) — view-only admins don't get them (issue #311); Retry stays
  // creator-or-full-admin.
  //
  // The Your-apps entry renders for EVERY app so the affordance is
  // always discoverable. #618: membership (is_collaborator — you
  // created or help build the app) no longer hard-pins the app there;
  // members get a working Remove/Add pair driven by your_apps_hidden
  // (a per-user, display-only opt-out — access and permissions are
  // untouched). The explicit desired value is passed through because
  // a pinned member app usually has is_favorited=false, so the
  // non-member "!is_favorited" derivation would send the wrong
  // direction.
  menuItemsFor(app) {
    const items = [];
    const user = App.user || {};
    const isRunning = app.status === 'running';
    const isError = app.status === 'error';
    // The way to the app's community, its hub (One Home, #6361: the hub
    // is the project's page, so the details page Discover drew went). First
    // in the list because it is navigation, not an action. A door to the
    // hub, so it says so first (AppView._landOnHub), as Home's community
    // tiles do. Skipped for the inert ?demo=1 tiles, whose slugs have no
    // project behind them.
    if (!app.demo && app.slug) {
      items.push({
        key: 'app-details',
        label: message('home:menu.details.label'),
        title: message('home:menu.details.tip'),
        run: () => { Home.openHub(app.slug); },
      });
    }
    // The app's source. This was a row in the hamburger drawer's reference
    // footer, revealed by hand from App.navigateToApp when the OPEN app had a
    // repo_url; the Streamlined Concept board draws no such footer, and a
    // link to the code is a thing you do WITH an app, which is what this list
    // is. As a menu item it reaches both places that render the list — the
    // home card's "…" menu and the app's own page — instead of only being
    // reachable while the app was open.
    //
    // ?demo=1 tiles carry no repository, so the gate never fires for them.
    //
    // Where the code is decides the row (lib/repo-link.js): "View on GitHub"
    // for a repository still on GitHub (the platform's own), "View code" for
    // one on Homeroom's git host, where app code lives since the move; an
    // address that is neither is no row at all.
    const repoKind = app.repo_url ? linkKind(app.repo_url) : null;
    if (repoKind === 'github' || repoKind === 'code') {
      const github = repoKind === 'github';
      items.push({
        key: github ? 'github' : 'code',
        label: github ? message('home:menu.github.label') : message('home:menu.code.label'),
        title: github ? message('home:menu.github.tip') : message('home:menu.code.tip'),
        // `noopener` explicitly: the target document must not get a handle on
        // this window, and repo_url is app-supplied.
        run: () => window.open(app.repo_url, '_blank', 'noopener'),
      });
    }
    if (app.is_collaborator) {
      items.push({
        key: 'favorite',
        label: app.your_apps_hidden ? message('home:menu.myApps.add') : message('home:menu.myApps.remove'),
        title: app.your_apps_hidden
          ? message('home:menu.myApps.showAgainTip')
          : message('home:menu.myApps.hideTip'),
        run: () => Home._menuToggleFavorite(app, !!app.your_apps_hidden),
      });
    } else {
      items.push({
        key: 'favorite',
        label: app.is_favorited ? message('home:menu.myApps.remove') : message('home:menu.myApps.add'),
        run: () => Home._menuToggleFavorite(app, !app.is_favorited),
      });
    }
    // #1374: per-app notification settings, UNGATED on purpose and placed
    // right after the "Your apps" entry.
    //
    // Not in App settings below, which is where a per-app dialog would
    // normally go: that entry is offered only to an admin, the creator, or
    // somebody whose app has other contributors. Who hears about an app is
    // every user's business, and most users are none of those things — so
    // putting it there would have hidden the switches from nearly everyone
    // who wants them. "Add to Your apps" above is the closest thing the
    // platform already had to a per-app subscription, which is why this sits
    // beside it.
    items.push({
      key: 'notifications',
      label: message('home:menu.notifications.label'),
      title: message('home:menu.notifications.tip'),
      run: () => window.UsernodeReact?.dialogs?.appNotifications?.open({ slug: app.slug }),
    });
    // Native homescreen shortcut — only when the page runs inside a
    // Homeroom app build whose bridge reports the feature (see
    // _probeShortcutSupport; Home._shortcutSupport stays null in plain
    // browsers and on old app builds, so the item never renders there).
    const shortcutSupport = Home._shortcutSupport;
    // "Your apps" only: the homescreen widget is for the apps you keep,
    // not something to offer on every card in the directory.
    const offersPin = !!(isRunning && Home.isYours(app)
      && shortcutSupport && shortcutSupport.mechanism !== 'unsupported');
    if (offersPin) {
      // iOS shortcuts land in the shared widget grid, so the item names
      // that destination; Android pins straight to the launcher.
      const isWidget = shortcutSupport.mechanism === 'widget';
      // Data-based, not visibility-based: the ✓ must show even while
      // the widget section itself is still hidden.
      const inWidget = isWidget
        && Array.isArray(Home._widgetItems)
        && Home._widgetSlugs().has(app.slug);
      if (inWidget) {
        // Already pinned: the item becomes the way back to the (hidden
        // by default) management section — reorder or remove from there.
        items.push({
          key: 'add-to-homescreen',
          label: message('home:menu.widget.edit'),
          run: () => Home._revealWidgetSection(),
        });
      } else {
        items.push({
          key: 'add-to-homescreen',
          label: isWidget ? message('home:menu.widget.add') : message('home:menu.phoneHome.add'),
          run: () => Home._menuAddShortcut(app),
        });
      }
    }
    // #2320: "Add to Home Screen", the per-app install page (#1508). It was a
    // row in the app chip's sheet, which only knows the app you are already
    // IN; here it is on the app itself, from its tile and its details page.
    //
    // A phone thing (see detectInstallHost in ../mobile-install/environment):
    // a laptop has no home screen. Skipped for the inert ?demo=1 tiles, which
    // have no install page, and wherever the native pin above is offered, so
    // the menu never carries two look-alike ways onto the home screen.
    //
    // How the page opens follows the host, read at open time: the native
    // webview cannot leave for the system browser on its own, so the bridge's
    // openExternal (window.open as the fallback for a build without it); an
    // installed platform PWA has no share sheet, so a browser window of its
    // own; anywhere else, an ordinary same-tab navigation.
    const installHost = !app.demo && app.slug && !offersPin ? detectInstallHost() : 'none';
    if (installHost !== 'none') {
      items.push({
        key: 'install',
        label: message('home:menu.install.label'),
        title: message('home:menu.install.tip'),
        run: () => {
          const href = `/app/${encodeURIComponent(app.slug)}/install`;
          if (installHost === 'standalone') {
            window.open(href, '_blank', 'noopener');
            return;
          }
          if (installHost !== 'native') {
            location.assign(href);
            return;
          }
          const url = new URL(href, window.location.origin).href;
          const bridge = window.usernode;
          const viaBridge = typeof bridge?.openExternal === 'function'
            ? Promise.resolve().then(() => bridge.openExternal(url))
            : Promise.reject(new Error('openExternal is unavailable'));
          viaBridge.catch(() => {
            window.open(url, '_blank', 'noopener');
          });
        },
      });
    }
    if (isError && (user.canAdminWrite || user.id === app.created_by)) {
      items.push({ key: 'retry', label: message('home:menu.retry'), run: () => Home._menuRetry(app) });
    }
    // #416: "View build log" for involved users — on errored apps, and
    // on running apps whose last recorded failure post-dates the last
    // successful deploy (a failed rebuild: the old container keeps
    // serving, but the rebuild died). `last_failure_reason/_at` only
    // ride the list payload when the server-side involved-user gate
    // passed, so the timestamp check below can't fire for outsiders.
    const canSeeBuildLog = app.is_collaborator || user.canAdminWrite || user.id === app.created_by;
    const rebuildFailed = isRunning && app.last_failure_at
      && (!app.last_deploy_at || new Date(app.last_failure_at) > new Date(app.last_deploy_at));
    if (canSeeBuildLog && (isError || rebuildFailed)) {
      items.push({
        key: 'build-log',
        label: message('home:menu.buildLog.label'),
        title: app.last_failure_reason || message('home:menu.buildLog.tip'),
        run: () => window.BuildLog && BuildLog.open(app.slug),
      });
    }
    if (user.canAdminWrite && app.repo_url && isRunning && !app.self_hosted) {
      // keepOpen: the drift check can take 30-90s when a rebuild kicks
      // off, so the item flips to "Checking…" in place instead of the
      // menu vanishing with zero feedback.
      items.push({
        key: 'check-updates',
        label: message('home:menu.checkUpdates.label'),
        keepOpen: true,
        run: (itemEl) => Home._menuCheckUpdates(app, itemEl),
      });
    }
    // Fork, which people see as "Make your own" (their own version of the
    // app, docs/plans/versions.md): available to anyone who can see
    // the app (every card in this list is already visibility-filtered
    // server-side, so presence here implies view access). Hidden for the
    // platform self-app, which has no per-app repo/DB/container to copy.
    // Reuses the same dialog + POST /api/apps/:slug/fork flow as the
    // Workshop "+" menu. `sub` is the line a row with room for one shows
    // under the label (About, Discover); the popover shows it as a tooltip.
    if (!app.self_hosted && typeof AppView !== 'undefined' && AppView.promptFork) {
      items.push({
        key: 'fork',
        label: message('home:menu.remix.label'),
        sub: message('home:menu.remix.sub'),
        title: message('home:menu.remix.sub'),
        run: () => AppView.promptFork({ slug: app.slug, name: app.name }),
      });
    }
    if (user.canAdminWrite) {
      items.push({
        key: 'lock',
        label: app.locked ? message('home:menu.lock.unlock') : message('home:menu.lock.lock'),
        title: app.locked
          ? message('home:menu.lock.unlockTip')
          : message('home:menu.lock.lockTip'),
        run: () => Home._menuToggleLock(app),
      });
    }
    // App settings is the canonical access editor, so every creator/app admin
    // with can_manage gets the entry even when deletion is unavailable. Keep
    // the full-admin fallback for older payloads already in memory while a
    // deployment rolls over. #2161: the creator of a shared app
    // (delete_block 'shared' is only ever handed to them) keeps the entry,
    // because the dialog is also where the deletion refusal is explained.
    if (user.canAdminWrite || app.can_manage || app.can_delete || app.delete_block === 'shared') {
      items.push({ key: 'app-settings', label: message('home:menu.settings'), run: () => window.UsernodeReact?.dialogs?.appSettings?.open({ slug: app.slug }) });
    }
    if (App.user && app.slug && app.can_report === true) items.push({
      key: 'report', label: message('home:menu.report'),
      run: () => window.UsernodeReact?.dialogs?.report?.open({ targetType: 'app', target: app.slug, label: app.name || app.slug }),
    });
    return items;
  },

  // Build-info header at the top of the "…" menu: the app's FULL,
  // untruncated name (the card face truncates it), the slug, and the
  // currently deployed commit — the version pill that used to sit on
  // the card face. Reuses AppView.renderAppVersionPillHTML (non-quiet,
  // like the AppView header) so the commit chip looks identical
  // everywhere and shows the live deploying state when a redeploy is
  // in flight. NOTE: classic-script `const AppView` from app-view.js
  // is in the shared script-global lexical env but is NOT a property
  // of window, so we reference it directly (a `window.AppView` guard
  // would silently short-circuit to false and drop the pill).
  renderMenuHeaderHtml(app) {
    const pillHtml = (typeof AppView !== 'undefined' && AppView.renderAppVersionPillHTML)
      ? AppView.renderAppVersionPillHTML({
          slug: app.slug,
          version: app.version || null,
          deployProgress: app.deployProgress || null,
          includePrContext: false,
        })
      : `<span class="text-xs font-mono">${escapeHtml(app.slug)} · ${escapeHtml(app.version?.shortSha || 'dev')}</span>`;
    // "Updated Xh ago" lives here rather than on the card face; falls
    // back to created_at when last_deploy_at is null (pre-migration
    // apps — schema.sql backfills last_deploy_at = created_at, so this
    // is mostly defensive).
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    // The app's FULL pill set (missing secrets / to vote / in dev /
    // issues / privacy) — the card face carries no chips at all, so
    // this header is the one place they render.
    const basic = readInterfaceMode() === 'basic';
    const pillsHtml = Home.renderAppPillsHtml(basic ? { ...app, open_issues: 0, open_prs: 0 } : app);
    return `
      <div class="card-menu-title">${escapeHtml(app.name || app.slug)}</div>
${basic ? '' : `<div class="card-menu-slug">${escapeHtml(app.slug)}</div><div class="card-menu-version">${pillHtml}</div>`}
      ${updatedRel ? `<div class="card-menu-updated">${htmlText('home:menu.updated', { when: updatedRel })}</div>` : ''}
      ${pillsHtml ? `<div class="card-menu-pills">${pillsHtml}</div>` : ''}`;
  },

  // anchor: the trigger Element (the "…" button — lets the kit toggle
  // the menu closed on a re-click) or a plain rect (the card's
  // bounding box from the long-press paths).
  openCardMenu(slug, anchor) {
    Home.closeCardMenu();
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    const basic = readInterfaceMode() === 'basic';
    const items = Home.menuItemsFor(app).filter(item => !basic || !['github', 'code', 'notifications', 'check-updates', 'lock'].includes(item.key));
    if (!items.length) return;
    const anchorIsEl = !!(anchor && typeof anchor.getBoundingClientRect === 'function');
    const anchorEl = anchorIsEl && anchor.nodeType === 1 ? anchor : null;
    // #5871: the menu of a tile on My apps ends with the way into edit mode,
    // the way a phone's home screen menu does. Only there: menuItemsFor also
    // fills the app's own page, search results and demo tiles carry no
    // data-yours, and while edit mode is on there is nothing to start.
    if (!basic && !Home._editing && anchorEl && typeof anchorEl.closest === 'function'
        && anchorEl.closest('.app-card[data-yours]:not([data-demo]), [data-home-frame-tile="yours"]')) {
      items.push({
        key: 'edit-my-apps',
        label: message('home:menu.editMyApps.label'),
        title: message('home:menu.editMyApps.tip'),
        run: () => Home.setEditing(true),
      });
    }

    // A tile's context stays anchored to the tile on every platform.
    // The kit owns clamping/flipping, dismissal, focus and menu navigation;
    // keeping the popover on touch also preserves metadata and disabled rows.
    const headerEl = document.createElement('div');
    headerEl.className = basic ? 'card-menu-header interface-mode-basic' : 'card-menu-header interface-mode-advanced';
    headerEl.innerHTML = Home.renderMenuHeaderHtml(app);
    const menu = PlatformUI.popover({
      anchorEl: anchorIsEl ? anchor : undefined,
      anchorRect: anchorIsEl ? undefined : anchor,
      title: app.name || app.slug,
      headerEl,
      items: items.map((i) => ({
        label: i.label,
        destructive: !!i.danger,
        disabled: !!i.disabled,
        keepOpen: !!i.keepOpen,
        title: i.title,
        handler: (btn) => i.run(btn || null),
      })),
    });
    if (!menu) return;
    Home._menu = menu;
    // #1838: which TILE the open menu belongs to. The desktop right-click
    // path is a toggle, and it can only tell "close this one" from "move to
    // that one" by comparing anchors.
    Home._menuAnchor = anchorEl;
    menu.then(() => {
      if (Home._menu === menu) {
        Home._menu = null;
        Home._menuAnchor = null;
      }
    });
  },

  closeCardMenu() {
    const menu = Home._menu;
    Home._menu = null;
    Home._menuAnchor = null;
    if (menu && typeof menu.dismiss === 'function') menu.dismiss();
  },

  // #1838: the kit's popover dismisses itself from a document-level
  // pointerdown CAPTURE listener it installs when it opens, and resolves its
  // promise synchronously in there — so by the time `contextmenu` arrives
  // (a later task) the menu is gone and `_menuAnchor` has already been
  // cleared. This listener is installed ONCE, before any popover exists, so
  // for the same node and the same phase it runs FIRST and can snapshot the
  // anchor the press landed on while it is still true.
  //
  // The snapshot is not a stale copy of _menuAnchor: it is re-taken on every
  // pointerdown, so a menu closed by Escape (or by anything else) leaves a
  // null snapshot at the NEXT press and the right-click opens as it should.
  _wireMenuAnchorSnapshot() {
    if (Home._menuAnchorSnapshotWired) return;
    if (!document || typeof document.addEventListener !== 'function') return;
    Home._menuAnchorSnapshotWired = true;
    document.addEventListener('pointerdown', () => {
      Home._menuAnchorAtPress = Home._menuAnchor;
    }, true);
  },

  // ── Menu actions ──────────────────────────────────────────────────

  // Ask the Homeroom app to pin this app to the device homescreen. The
  // shortcut URL is the platform's own hash deep link (#app/<slug>), so
  // tapping it reopens the SV shell already navigated to the app — same
  // surface as tapping the card, with the platform session intact. The
  // app shows its own native confirmation screen; a user decline
  // surfaces as a rejection, which we swallow (it's not an error).
  // Menu entry point. Android: direct launcher pin, unchanged. iOS: the
  // click is what reveals the widget section — then the app is added
  // automatically when the widget has room, and when it's full the
  // section shakes instead so the user sees why nothing was added (and
  // can ✕ something to make room).
  async _menuAddShortcut(app) {
    if (Home._shortcutSupport?.mechanism !== 'widget') {
      return Home._addShortcutForApp(app);
    }
    if (!Array.isArray(Home._widgetItems)) await Home._refreshWidgetItems();
    if (!Array.isArray(Home._widgetItems)) {
      // Registry unreachable (old build mid-probe?) — plain add, no
      // management section to show.
      return Home._addShortcutForApp(app);
    }
    // #2892: the tile the menu was opened from is done being "held" the
    // moment an action is chosen — see _releaseTile.
    Home._releaseTile(app.slug);
    Home._revealWidgetSection();
    if (Home._widgetSlugs().has(app.slug)) return; // already in — just reveal
    if (Home._widgetItems.length >= Home.WIDGET_CAPACITY) {
      Home._shakeWidgetStrip();
      return;
    }
    return Home._addShortcutForApp(app);
  },

  // Show the widget management section (idempotent) and bring it into
  // view. Shared by "Add to Homeroom widget" and "Edit in Homeroom
  // widget".
  _revealWidgetSection() {
    Home._widgetSectionVisible = true;
    Home.render();
    const strip = document.getElementById('widget-strip');
    if (strip) strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  _shakeWidgetStrip() {
    const strip = document.getElementById('widget-strip');
    if (!strip || typeof strip.animate !== 'function') return;
    strip.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-8px)' },
        { transform: 'translateX(7px)' },
        { transform: 'translateX(-5px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(-2px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 450, easing: 'ease-in-out' }
    );
  },

  // ── Dragging a tile INTO the widget strip (#2894) ──────────────────
  //
  // No second recognizer: a "Your apps" tile is already carried by the kit's
  // attachGridPlacement (_attachGridPlacement above), and its cells are
  // host-defined tokens. The open strip is simply one more cell — a sentinel
  // cellFromPoint returns while the finger is over #widget-strip — and every
  // callback branches on it: canPlace says whether the app can go in,
  // onHover tints the strip instead of the grid, rectForCell flies the ghost
  // to the slot the new tile will take, and onPlace defers the pin to
  // onSettle, when the gesture is over and the strip may repaint. Mouse and
  // touch are therefore the same code path the grid reorder already is.
  //
  // `col`/`row` are what the kit's sameCell compares, so they must be stable
  // and must never collide with a real cell.
  WIDGET_DROP_CELL: Object.freeze({ col: 'widget', row: 'widget', widget: true }),

  // Slug a committed widget drop still owes a pin (onPlace → onSettle).
  _pendingWidgetAdd: null,

  // Whether the finger was over the strip at the last hit-test, so onSettle
  // can tell a refused drop ON the strip (full → shake) from one elsewhere.
  _pointerOverWidget: false,

  _isWidgetDropCell(cell) {
    return !!(cell && cell.widget === true);
  },

  // A rect test, not elementFromPoint: the strip is a plain box and the kit's
  // ghost is pointer-events:none anyway, so this is exact and cheap on the
  // per-move path. Only while the section is actually showing.
  _widgetStripAt(x, y) {
    if (!Home._widgetUiActive() || typeof document === 'undefined') return false;
    const strip = document.getElementById('widget-strip');
    if (!strip || typeof strip.getBoundingClientRect !== 'function') return false;
    const r = strip.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  },

  _widgetFull() {
    return Array.isArray(Home._widgetItems)
      && Home._widgetItems.length >= Home.WIDGET_CAPACITY;
  },

  // The same gate as the menu's "Add to Homeroom widget": a running app, not
  // already pinned, and room left on the widget.
  _canDropOnWidget(el) {
    const slug = el && el.dataset ? el.dataset.slug : null;
    if (!slug || !Home._widgetUiActive()) return false;
    if (Home._widgetSlugs().has(slug) || Home._widgetFull()) return false;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    return !!(app && app.status === 'running');
  },

  // The strip's drop tint. A data attribute rather than a class because
  // #widget-strip's className is React's (widget-strip.tsx renders it), and a
  // class written from here would be a second writer to it; React renders no
  // `data-drop`, so it never touches this one. app.css draws both states.
  _markWidgetDrop(el, ok) {
    if (typeof document === 'undefined') return;
    const strip = document.getElementById('widget-strip');
    if (!strip) return;
    if (el) strip.setAttribute('data-drop', ok ? 'ok' : 'refused');
    else strip.removeAttribute('data-drop');
  },

  // Where the dropped tile lands: the slot right after the last pinned tile
  // (wrapping to the next line when the row is full), or the strip's first
  // slot when it is empty. Same gap and padding as the strip's gap-3 / p-3.
  _widgetDropRect() {
    if (typeof document === 'undefined') return null;
    const strip = document.getElementById('widget-strip');
    if (!strip) return null;
    const sr = strip.getBoundingClientRect();
    const tiles = strip.querySelectorAll('.widget-tile');
    const last = tiles.length ? tiles[tiles.length - 1] : null;
    if (!last) return { left: sr.left + 12, top: sr.top + 12 };
    const lr = last.getBoundingClientRect();
    const left = lr.right + 12;
    if (left + lr.width <= sr.right - 12) return { left, top: lr.top };
    return { left: sr.left + 12, top: lr.bottom + 12 };
  },

  // The drop's pin. Optimistic, the same shape as _removeWidgetItem: the new
  // tile is in the strip when the ghost lands, and a refusal or failure
  // re-fetches the registry so the strip snaps back to device truth.
  async _dropOnWidget(slug) {
    Home._releaseTile(slug);
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app || !Home._widgetUiActive() || Home._widgetSlugs().has(slug)) {
      Home.render();
      return false;
    }
    Home._widgetItems = [...Home._widgetItems, {
      id: `pending:${slug}`,
      name: app.name || slug,
      url: `${location.origin}/app/${encodeURIComponent(slug)}`,
    }];
    Home.render();
    const ok = await Home._addShortcutForApp(app);
    if (!ok) {
      await Home._refreshWidgetItems();
      Home.render();
    }
    return ok;
  },

  // ── Dragging a tile ONTO the sidebar's Pinned section (#5323) ──────
  //
  // No second recognizer: the widget strip above already showed the way, and
  // the desktop sidebar's pinned list is one more sentinel cell. Dropping a
  // My apps tile on it pins its community there (features/nav/rail-pinned.tsx;
  // features/nav/pinned-apps-store.js keeps the list, through the nav
  // bridge); dropping it on the canvas still rearranges My apps, and a
  // refused drop (already pinned, or four already there) springs the tile
  // back and writes nothing.
  //
  // `col`/`row` are what the kit's sameCell compares, so they must be stable
  // and must never collide with a real cell.
  STRIP_PIN_CELL: Object.freeze({ col: 'strip', row: 'strip', strip: true }),

  // Slug a committed strip-pin drop still owes a pin (onPlace → onSettle).
  _pendingStripPin: null,

  // Whether the pointer was over the strip at the last hit-test, kept for
  // symmetry with the widget flag (and so a later settle can tell).
  _pointerOverStrip: false,

  _isStripPinCell(cell) {
    return !!(cell && cell.strip === true);
  },

  // A rect test on the sidebar's Pinned section, not elementFromPoint: the
  // rail is a plain box and the kit's ghost is pointer-events:none anyway.
  // Only while the section is actually showing — hidden (nothing pinned yet
  // AND no drag up), folded (`platform-tabs-folded`), or on a phone
  // (display:none) all give a zero rect and the drag behaves exactly as
  // before.
  _stripPinAt(x, y) {
    if (typeof document === 'undefined') return false;
    const strip = document.getElementById('platform-rail-pinned');
    if (!strip || typeof strip.getBoundingClientRect !== 'function') return false;
    if (strip.classList.contains('hidden')) return false;
    const r = strip.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  },

  // The same gate as the drop: the strip's own list answers through the
  // bridge — 'ok' to append, 'already' and 'full' to refuse. The bridge is
  // optional (a vm test, a page before the nav island mounts).
  _canDropOnStripPin(el) {
    const slug = el && el.dataset ? el.dataset.slug : null;
    if (!slug) return false;
    try {
      return window.UsernodeReact?.nav?.pinStatus?.(slug) === 'ok';
    } catch {
      return false;
    }
  },

  // Where the dropped tile lands: the "Pin here" slot row the section draws
  // while the drag is up, else its top-left corner (a slot that has just
  // been refused still drew its words the instant before).
  _stripPinRect() {
    if (typeof document === 'undefined') return null;
    const strip = document.getElementById('platform-rail-pinned');
    if (!strip || typeof strip.getBoundingClientRect !== 'function') return null;
    const drop = strip.querySelector('[data-rail-pin-drop]');
    if (drop && typeof drop.getBoundingClientRect === 'function') {
      const r = drop.getBoundingClientRect();
      if (r.width || r.height) return { left: r.left, top: r.top };
    }
    const sr = strip.getBoundingClientRect();
    return { left: sr.left + 10, top: sr.top + 6 };
  },

  // #2892: "apps can get stuck in the selected state when adding to the
  // widget". Adding is one of the few card actions that leaves you on the
  // home screen — the others open the app, open a page or remove the tile —
  // so whatever held state the long-press left behind is still on screen
  // afterwards, and the strip appearing above the grid moves the tile out
  // from under the finger whose next tap would otherwise have cleared it.
  // Both add paths (the menu and a drop) release it here: the menu and the
  // context lift, any displacement preview, and the focus the popover hands
  // back to the tile it was anchored on. It writes nothing INTO the card —
  // #app-list is React's (tests/home-grid-ownership.test.js); the kit's own
  // drop slot comes off in its finish(), and the tile's hover fill is gated
  // to real hover pointers in app.css.
  _releaseTile(slug) {
    Home.closeCardMenu();
    Home._contextLift = null;
    Home._clearPreview();
    if (typeof document === 'undefined') return;
    const active = document.activeElement;
    const held = active && typeof active.closest === 'function' ? active.closest('.app-card[data-slug]') : null;
    if (held && (!slug || slug === held.dataset.slug) && typeof held.blur === 'function') held.blur();
  },

  // Draws `text` onto a scratch canvas, finds its ink (alpha) bounding
  // box, and blits it centered into the size x size target. Returns
  // false when the 2D APIs needed aren't available or nothing was
  // drawn, so callers can fall back to plain fillText.
  _drawGlyphCentered(ctx, size, text, font, color) {
    try {
      const scratch = document.createElement('canvas');
      const s = size * 2; // headroom for glyphs that overflow their box
      scratch.width = s;
      scratch.height = s;
      const sctx = scratch.getContext('2d');
      if (!sctx || typeof sctx.getImageData !== 'function'
        || typeof ctx.drawImage !== 'function') return false;
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = font;
      if (color) sctx.fillStyle = color;
      sctx.fillText(text, s / 2, s / 2);
      const data = sctx.getImageData(0, 0, s, s).data;
      let minX = s, minY = s, maxX = -1, maxY = -1;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          if (data[(y * s + x) * 4 + 3] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return false; // nothing drawn (blank glyph?)
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      ctx.drawImage(
        scratch, minX, minY, w, h,
        Math.round((size - w) / 2), Math.round((size - h) / 2), w, h
      );
      return true;
    } catch (_) {
      return false;
    }
  },

  // Renders the SV emoji/letter tile to a PNG data URI so the native
  // homescreen widget shows the exact tile the app shows — the same
  // face + hairline + faint letter as `.app-icon-tile` (app.css). Drawn
  // as a rounded rect (radius scaled from the in-app 12px-on-56px tile)
  // so the corners stay transparent and the shape reads correctly on the
  // widget's own surface, light or dark.
  //
  // A PNG can't follow the system theme the way the CSS tile does, so
  // the palette is a PARAMETER: the caller (_shortcutPayloadFor) knows
  // whether the shell can hold a light/dark pair and asks for both
  // faces, or for just the one matching the current system appearance.
  // Nothing in here reads the appearance itself — that decision belongs
  // one level up, so the capable path can produce a payload that is
  // identical in both appearances. `variant` defaults to the current
  // scheme so a caller that forgets it still paints a sane face, and an
  // unrecognised key falls back to light. Apps with a real icon image
  // skip this entirely (the image URL is passed through instead).
  _widgetIconDataUrl(app, variant) {
    try {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const stroke = 2;
      const inset = stroke / 2;
      const radius = Math.round(size * (12 / 56)); // rounded-xl at 56px
      const box = size - stroke;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(inset, inset, box, box, radius);
      } else {
        // Safari < 16.4 / older WebViews: hand-rolled rounded rect.
        ctx.beginPath();
        ctx.moveTo(inset + radius, inset);
        ctx.arcTo(inset + box, inset, inset + box, inset + box, radius);
        ctx.arcTo(inset + box, inset + box, inset, inset + box, radius);
        ctx.arcTo(inset, inset + box, inset, inset, radius);
        ctx.arcTo(inset, inset, inset + box, inset, radius);
        ctx.closePath();
      }
      // Light: #ffffff face / #e4e4e7 hairline (unchanged).
      // Dark: #1a1a30 face / #2e2e50 hairline — the tokens `.dark
      // .app-icon-tile` resolves to. The hairline is what keeps the
      // tile shape legible against iOS's own dark widget material, so
      // it must not be dropped in the dark palette.
      const palette = Home.WIDGET_TILE_PALETTE[variant || Home._widgetScheme()]
        || Home.WIDGET_TILE_PALETTE.light;
      ctx.fillStyle = palette.face;
      ctx.fill();
      ctx.strokeStyle = palette.hairline;
      ctx.lineWidth = stroke;
      ctx.stroke();
      const text = app.icon_emoji
        || String(app.name || '?').charAt(0).toUpperCase();
      const font = app.icon_emoji
        ? '72px system-ui, sans-serif'
        : 'bold 64px system-ui, sans-serif';
      // Letters only — emoji keep their own colour glyphs. The faint
      // grey matches .app-icon-tile[data-icon="letter"] (--text-faint).
      const color = app.icon_emoji ? null : palette.letter;
      // Pixel-centering first: textAlign/textBaseline metrics misplace
      // emoji glyphs in iOS WebKit (tiles came out anchored bottom-left),
      // and measured glyph bounds are just as unreliable across engines.
      // Ink bounds never lie. Fall back to the anchor heuristic where
      // getImageData isn't available.
      if (!Home._drawGlyphCentered(ctx, size, text, font, color)) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font;
        if (color) ctx.fillStyle = color;
        ctx.fillText(text, size / 2, size / 2 + (app.icon_emoji ? 4 : 2));
      }
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  },

  // The addHomeScreenShortcut payload for an SV app — shared by the add
  // flows and the icon-heal pass so every path sends the same icon.
  //
  // Three shapes, and only three:
  //   - Real icon image → the absolute URL the app downloads, and NO
  //     dark field: the author's artwork is the same in both
  //     appearances, so a second copy would double the native download
  //     for no visual change.
  //   - Canvas tile, shell takes a pair → the light face as icon_url
  //     (so a shell that stores the field but renders only icon_url
  //     still shows a sane tile) plus the dark face as icon_url_dark.
  //     The widget picks per colorScheme, natively, with SV closed.
  //   - Canvas tile, shell can't → the single face matching the current
  //     system appearance, exactly as gen 5 sent it.
  //
  // icon_url_dark is OMITTED rather than sent as null when there is no
  // dark asset: that keeps the payload byte-identical to what shipped
  // before this change for every non-capable shell, and gives the
  // native side an unambiguous "clear the dark slot" on a re-add.
  //
  // Callers must have awaited _ensureDarkIconCapability() — see the
  // heal pass and _addShortcutForApp.
  //
  // `variant` overrides the resolved capability, and exists for exactly
  // one caller: _confirmDarkIconSupport, which has to send a pair
  // PRECISELY when the capability is still unresolved — that send is how
  // it becomes resolved. Everything else passes nothing and gets the
  // shape the resolution dictates.
  _shortcutPayloadFor(app, variant) {
    const dual = variant ? variant === 'dual' : Home._widgetDarkIcons === true;
    const payload = {
      name: app.name,
      url: `${location.origin}/app/${encodeURIComponent(app.slug)}`,
      icon_url: app.icon_url
        ? new URL(app.icon_url, location.origin).href
        : Home._widgetIconDataUrl(app, dual ? 'light' : Home._widgetScheme()),
    };
    if (!app.icon_url && dual) {
      payload.icon_url_dark = Home._widgetIconDataUrl(app, 'dark');
    }
    return payload;
  },

  // ── Diagnostics snapshot (Settings → "Widget icons") ────────────────
  //
  // Everything the icon path decided, in one plain object: what the
  // shell said, what SV observed, what each pinned entry actually holds
  // and whether it matches what SV believes it sent. This screen exists
  // because every step above is invisible — the failure mode being
  // diagnosed is "the tile looks wrong", which no log line reports.
  //
  // Pure read: no bridge calls, no sends. Settings re-renders it after
  // asking Home to refresh the registry, so the caller controls I/O.
  widgetIconDiagnostics() {
    const srcMap = Home._loadIconSrcMap();
    const entries = (Home._widgetItems || []).map((item) => {
      const slug = Home._widgetSlugFor(item);
      const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
      const desired = app ? Home._desiredIconSrcFor(app) : null;
      const recorded = srcMap[item.id] ?? null;
      return {
        id: item.id,
        name: item.name || slug || item.id,
        // A shortcut pinned by another dapp, or one whose SV app hasn't
        // loaded — either way this pass can't heal it.
        foreign: !slug,
        unknownApp: !!slug && !app,
        hasIcon: item.has_icon === undefined ? null : item.has_icon === true,
        hasIconDark: item.has_icon_dark === undefined ? null : item.has_icon_dark === true,
        recorded,
        desired,
        matches: desired != null && recorded === desired,
      };
    });
    let readError = null;
    const chrome = window.NativeChrome;
    if (chrome && typeof chrome.lastReadError === 'function') {
      readError = chrome.lastReadError('getHomeScreenShortcuts')
        || chrome.lastReadError('addHomeScreenShortcut')
        || chrome.lastReadError('getBridgeInfo')
        || null;
    }
    return {
      mechanism: Home._shortcutSupport?.mechanism || null,
      registryLoaded: Array.isArray(Home._widgetItems),
      scheme: Home._widgetScheme(),
      capability: Home._darkIconCapability,
      verdict: Home._widgetDarkVerdict,
      resolved: Home._widgetDarkIcons,
      build: Home._darkIconBuild,
      confirmTried: Home._darkIconConfirmTried,
      lastHealAt: Home._lastHealAt || 0,
      lastHealOutcome: Home._lastHealOutcome,
      readError,
      entries,
    };
  },

  // Shared by the hamburger item and the drag-onto-strip drop. On iOS a
  // successful add lands in the widget registry, so the strip is
  // re-fetched and re-rendered to show the new tile.
  async _addShortcutForApp(app) {
    try {
      // Before building the payload: an un-probed capability would send
      // a single face that the next heal pass immediately re-sends as a
      // pair — a wasted round trip and a visible double refresh.
      await Home._ensureDarkIconCapability();
      await window.usernode.addHomeScreenShortcut(Home._shortcutPayloadFor(app));
      if (Home._shortcutSupport?.mechanism === 'widget') {
        await Home._refreshWidgetItems();
        Home.render();
      }
      return true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/denied/i.test(msg)) PlatformUI.toast(message('home:menu.phoneHome.addFailed', { reason: msg }));
      return false;
    }
  },

  // `desired` is the explicit favorited value to send. menuItemsFor
  // always passes it; the !is_favorited fallback keeps any legacy
  // caller working for non-member apps. For member apps the server
  // maps favorited=false to a hidden opt-out row rather than a delete
  // (#618), so the same endpoint drives both card menu states.
  //
  // ONE IMPLEMENTATION (#1567). This used to POST first and repaint by
  // reloading the whole list, which meant the menu and the rails disagreed
  // about how fast the section updates and about whether a failure is
  // announced. toggleAdded is the better of the two — it flips the cached
  // flags, paints immediately, and reverts against the server if the write
  // loses — so this is now the name the menu calls it by.
  _menuToggleFavorite(app, desired) {
    const next = typeof desired === 'boolean' ? desired : !app.is_favorited;
    return Home.toggleAdded(app.slug, next);
  },

  async _menuRetry(app) {
    await fetch(`/api/apps/${app.slug}/retry`, { method: 'POST' });
    Home.load();
  },

  async _menuCheckUpdates(app, itemEl) {
    if (itemEl) {
      itemEl.disabled = true;
      itemEl.textContent = message('home:menu.checkUpdates.checking');
    }
    try {
      const res = await fetch(`/api/apps/${app.slug}/check-updates`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        PlatformUI.toast(errorText(data) || message('home:menu.checkUpdates.failedHttp', { status: res.status }));
      } else {
        Home.reportCheckResult(data);
      }
    } catch (err) {
      PlatformUI.toast(message('home:menu.checkUpdates.failed', { reason: err.message }));
    } finally {
      Home.closeCardMenu();
      await Home.load();
    }
  },

  async _menuToggleLock(app) {
    const nextLocked = !app.locked;
    try {
      const res = await fetch(`/api/apps/${app.slug}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: nextLocked }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        PlatformUI.toast(errorText(data) || message('home:menu.lock.failedHttp', { status: res.status }));
        return;
      }
      Home.updateAppCardLock(app.slug, nextLocked);
    } catch (err) {
      PlatformUI.toast(message('home:menu.lock.failed', { reason: err.message }));
    }
  },

  // ===== "Your apps" drag-and-drop (issue #128) =====
  //
  // Vanilla Pointer Events (setPointerCapture + move/up/cancel on the
  // captured element), no library and no HTML5 draggable (poor touch
  // support).
  //
  // Homescreen-style visuals: picking a card up spawns a floating
  // clone ("ghost") that tracks the pointer, while the real card stays
  // in the grid restyled as a dashed drop slot. As the slot moves
  // among its "Your apps" siblings, the siblings FLIP-animate into their
  // new grid positions; on drop the ghost glides into the slot and the
  // real card is swapped back in. The in-flow card doubles as the drop
  // indicator, so the 1/2/3-column grid layout stays correct for free.

  // True while a drag gesture is in progress; Home.load() defers to
  // _reloadPending instead of re-rendering (see the guard in load()).
  _dragActive: false,
  _reloadPending: false,
  // Kit path: a cross-section drop updates Home._apps inside onReorder
  // (which fires while _dragActive still holds) and schedules the
  // cheap local re-render here; onSettle consumes it. A full
  // _reloadPending (server refetch) wins when both are set.
  _rerenderPending: false,
  // Eats the synthetic click the browser fires right after the
  // pointerup that ends a drag (see the card click handler in load()).
  _suppressClick: false,
  _placementHandle: null,
  _widgetReorderHandle: null,
  // The layout the CURRENT drag is resolving against. Snapshotted at lift so
  // canPlace/onPlace can't disagree with each other, and so a mid-gesture
  // fetch landing can't move the target cells under the finger.
  _layoutCache: null,

  // ===== Free-form placement =====

  // The layout the drag is working against — the same array render() painted
  // from. Falls back to computing one if a drag somehow starts before a
  // render (it can't, but a null here would be a silent no-op drop).
  // An INCOMING card is part of that layout for the span of its drag and no
  // longer (#1763). HomeLayout.place refuses an item it cannot find, and
  // canPlace, rectForCell and the displacement preview all resolve their plan
  // through here, so appending it is what makes a card dragged in from
  // Discover an ordinary drop rather than a special case in five callbacks.
  currentLayoutCached(cols) {
    const layout = Home._layoutCache || Home.currentLayout(cols);
    return Home._incoming ? layout.concat([Home._incoming]) : layout;
  },

  // A dragged DOM element → its layout item. The element carries only its
  // identity (data-slug); the cell comes from the model, so the DOM never
  // becomes a second source of truth about position.
  //
  // The `.home-panel-slot` branch that resolved a widget host is gone with the
  // widgets: every draggable item on this canvas is an app tile now.
  // THE LAYOUT IS ASKED FIRST, which is also the rule for a Discover card
  // whose app is already yours: the lane keeps it for the rest of the visit
  // after an add, and dragging it then moves the tile it already has rather
  // than adding a second one. `_incoming` is only ever the fallback, and only
  // ever set for a card with no tile on the canvas.
  // A dragged element names its app: a Discover card carries `data-slug`, a
  // sidebar community row carries `data-rail-community`, and both are the
  // same app slug (#6025).
  _dragSlug(el) {
    return (el && el.dataset && (el.dataset.slug || el.dataset.railCommunity)) || '';
  },

  _itemFor(el) {
    if (!el) return null;
    const layout = Home._layoutCache || [];
    const slug = Home._dragSlug(el);
    return layout.find((it) => it.type === 'app' && it.slug === slug)
      || (Home._incoming && Home._incoming.slug === slug ? Home._incoming : null);
  },

  // Which cell is this POINT over? Answered by hit-testing the OVERLAY's
  // own cell elements rather than by arithmetic over the grid's computed
  // template — that is the whole reason the overlay is real DOM. The kit's
  // ghost is pointer-events:none and the tiles go pointer-events:none for the
  // span of a lift (#app-list.un-reordering), so neither occludes them.
  _cellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const cell = el && el.closest ? el.closest('[data-cell]') : null;
    if (!cell) return null;
    const [col, row] = String(cell.dataset.cell).split(',').map(Number);
    if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
    return { col, row };
  },

  // ===== The target cell: the TILE's centroid, not the finger =====
  //
  // The dragged ghost tracks the finger from wherever it was grabbed, so the
  // pointer sits a grab-offset away from the tile's own box. Resolving the
  // target from the pointer therefore put the tile's TOP-LEFT under the
  // finger: grab a 2x2 widget by its bottom-right corner and the highlight
  // appeared two cells right and two rows down from the block the user was
  // actually holding, and the drop landed there. Multiply that by the phone
  // breakpoint, where Challenges and Discover are full-width by two rows, and
  // "the widget always drops one row lower than I put it" is the whole bug.
  //
  // So the target is the cell block the TILE is sitting over: take the ghost's
  // centre, and place a footprint of the item's own size centred on it.
  //
  // Two steps, deliberately: the overlay's own cells still GATE what counts as
  // being on the canvas (they carry the grid's asymmetric inset and the
  // ::before gap bleed, and re-deriving that arithmetically would be a second
  // source of truth), and the pitch arithmetic then REFINES the hit to the
  // footprint's top-left. A cell hit-test alone cannot do the second step: a
  // correctly centred even-width footprint puts its centre exactly on the seam
  // between two columns, so which side elementFromPoint resolves would decide
  // the column.
  _targetCellFor(x, y, info, cols) {
    const overlay = Home._overlayEl;
    const rect = info && info.rect;
    // No geometry to work from (a kit older than the third argument, or a
    // resolve after the overlay came down): the pointer hit-test is the
    // honest degradation, not a guess.
    if (!overlay || !rect || !Number.isFinite(info.centerX) || !Number.isFinite(info.centerY)) {
      return Home._cellFromPoint(x, y);
    }
    // GATE: the tile's centre has to be over the canvas at all.
    if (!Home._cellFromPoint(info.centerX, info.centerY)) return null;

    const origin = overlay.querySelector('[data-cell="0,0"]');
    const nextCol = overlay.querySelector('[data-cell="1,0"]');
    const nextRow = overlay.querySelector('[data-cell="0,1"]');
    if (!origin || !nextCol || !nextRow) return Home._cellFromPoint(x, y);
    // Measured fresh on every resolve, never cached at lift: edge auto-scroll
    // slides the overlay under a stationary ghost, which is precisely why the
    // kit re-asks without the pointer having moved.
    const a = origin.getBoundingClientRect();
    const pitchX = nextCol.getBoundingClientRect().left - a.left;
    const pitchY = nextRow.getBoundingClientRect().top - a.top;
    if (!(pitchX > 0) || !(pitchY > 0)) return Home._cellFromPoint(x, y);

    const item = Home._itemFor(info.item);
    if (!item) return null;
    const [w, h] = HomeLayout.sizeOf(item, cols);
    // The footprint size comes from the MODEL, never from the ghost's pixel
    // size: an overflow tile renders in plain flow with no span, so its ghost
    // is about one cell however big the widget really is.
    //
    // COLUMNS are uniform by construction — the template is
    // `repeat(cols, minmax(0, 1fr))` at both breakpoints — so one pitch
    // describes all of them.
    const col = Math.round((info.centerX - a.left) / pitchX - w / 2);
    // ROWS ARE NOT (#968, #975). A fit row is as tall as the widget in it and
    // an empty row is half a cell, so a
    // pitch measured between rows 0 and 1 stops describing row 5. Search the
    // overlay's real row geometry instead: the target is the placement whose
    // spanned rectangle is centred nearest the ghost, which is the same
    // centroid rule, just asked of measurements rather than of arithmetic.
    // With uniform rows it picks exactly what the rounding above would.
    const row = Home._rowNearest(overlay, info.centerY, h, pitchY);
    // Clamped here as well as in HomeLayout.place, so the token the kit
    // change-detects on is the cell the drop actually lands in — dragging past
    // an edge holds one steady target instead of churning the plan memo.
    return {
      col: Math.max(0, Math.min(col, cols - w)),
      row: Math.max(0, Math.min(row, HomeLayout.MAX_ROWS - h)),
    };
  },

  // The row a footprint `h` tall should take so its own centre sits closest to
  // `centerY`. Measured off the overlay's column-0 cells, which ARE the rows.
  //
  // `fallbackPitch` covers a cell whose rect reports no usable height — the
  // uniform assumption is a fine last resort, and it keeps a host that mocks
  // only `{ left, top }` working rather than collapsing every row to zero.
  _rowNearest(overlay, centerY, h, fallbackPitch) {
    const tops = [];
    const heights = [];
    for (let r = 0; r < HomeLayout.MAX_ROWS; r++) {
      const cell = overlay.querySelector(`[data-cell="0,${r}"]`);
      if (!cell) break;
      const rect = cell.getBoundingClientRect();
      tops.push(rect.top);
      heights.push(Number.isFinite(rect.height) && rect.height > 0 ? rect.height : null);
    }
    if (!tops.length) return 0;
    // Fill the gaps: a row with no measured height is the distance to the next
    // row's top (its own height plus the grid gap — close enough to centre a
    // footprint), and the last one falls back to the pitch.
    for (let r = 0; r < tops.length; r++) {
      if (heights[r] !== null) continue;
      heights[r] = r + 1 < tops.length
        ? Math.max(0, tops[r + 1] - tops[r])
        : Math.max(0, fallbackPitch);
    }
    const maxRow = Math.max(0, tops.length - h);
    let best = 0;
    let bestDist = Infinity;
    for (let r = 0; r <= maxRow; r++) {
      const last = Math.min(r + h - 1, tops.length - 1);
      const mid = (tops[r] + tops[last] + heights[last]) / 2;
      const dist = Math.abs(mid - centerY);
      // `<=` scanning upward, so an exact tie takes the LARGER row index —
      // which is what Math.round did (it rounds .5 up), and a ghost sitting
      // exactly on a seam is precisely the case the old arithmetic hit.
      if (dist <= bestDist + 1e-9) { bestDist = dist; best = r; }
    }
    return best;
  },

  // A committed drop. Mutate the model, keep the write to the width that is
  // actually on screen, and defer the repaint to onSettle (this fires while
  // _dragActive still holds, so an immediate render() would be swallowed).
  _onGridPlace(el, cell, cols) {
    const item = Home._itemFor(el);
    if (!item) return;
    const next = HomeLayout.place(Home.currentLayoutCached(cols), item, cell.col, cell.row, cols);
    if (!next) return;
    Home._layoutCache = next;
    if (!Home._layouts) Home._layouts = {};
    Home._layouts[String(cols)] = next;
    Home._rerenderPending = true;
    Home._persistLayout(cols, next);
  },

  // ===== The drag-time grid overlay =====
  //
  // While something is lifted, the grid it snaps to is drawn underneath it:
  // every cell of the canvas outlined, including the empty ones, so "you can
  // drop this anywhere" is visible rather than something to discover.
  //
  // The overlay is a real GRID sharing #app-list's own template, gap and row
  // height — that is what guarantees pixel alignment with zero arithmetic,
  // and it doubles as the hit-test surface (_cellFromPoint). The layer is
  // pointer-events:none; the individual cells re-enable them so
  // elementFromPoint lands on a cell rather than on a tile behind it.
  _overlayEl: null,

  // The overlay's ROW tracks, mirroring whatever #app-list actually did
  // (#968, #975). Rows are no longer uniform on a phone — a fit row is as tall
  // as the widget in it, an empty row is half a cell — and an overlay that
  // assumed 116px everywhere would
  // draw its cells off the tiles they sit behind. That is not cosmetic:
  // _rectForCell measures these cells to decide where the release glide
  // lands, so any drift becomes a jump at the end of every drop.
  //
  // getComputedStyle returns the USED sizes of the container's EXPLICIT
  // tracks — "116px 67.5px 116px" — so this is one read from the element
  // that already decided the answer, not a second derivation that could
  // disagree with it. Rows past the template are implicit in the grid and
  // absent from that string; the overlay pads them to MAX_ROWS with the cell
  // token, because the canvas is always eight rows deep even when the content
  // is three. Those padded rows are empty too, and they stay a FULL cell on
  // purpose: being past the template they cost the page nothing, so there is
  // no height to reclaim there and a full-size drop target is worth more.
  // A container with no template at all reports "none" (desktop,
  // the search view) — leave the overlay's own grid-auto-rows alone, which is
  // exactly the pre-#968 behaviour.
  //
  // PIXELS, NOT `auto`: the overlay's cells are empty divs, so a content-sized
  // track there would collapse to zero.
  _overlayRowTemplate(listEl) {
    if (!listEl || typeof getComputedStyle !== 'function') return '';
    let used = '';
    try {
      used = String(getComputedStyle(listEl).gridTemplateRows || '').trim();
    } catch (err) {
      return '';
    }
    if (!used || used === 'none') return '';
    const tracks = used.split(/\s+/).slice(0, HomeLayout.MAX_ROWS);
    if (!tracks.length) return '';
    while (tracks.length < HomeLayout.MAX_ROWS) tracks.push('var(--home-cell-h)');
    return tracks.join(' ');
  },

  // ── This appends INTO a React-owned host, and that is deliberate ───
  //
  // `#app-list` is features/home/app-grid.tsx's subtree, so `#home-grid-overlay`
  // is a second writer under an owned host. Moving it out would mean
  // re-deriving geometry that is currently free: the overlay's inset mirrors
  // #app-list's padding exactly at both breakpoints (app.css says so, twice)
  // and _rectForCell measures these cell elements to land a committed drop.
  //
  // What makes it safe is a timing invariant, not a boundary. The overlay
  // exists only between onLift and onSettle, and React cannot reconcile
  // #app-list in that window: render() and load() are the only publishers of
  // the grid model and both return early while _dragActive holds.
  // tests/home-grid-placement.test.js pins both halves — the deferral and the
  // absence of a third publisher — because the ownership audit never drags and
  // therefore cannot see any of this.
  _showGridOverlay(listEl, cols, liftedEl) {
    Home._hideGridOverlay();
    if (!listEl) return;
    const overlay = document.createElement('div');
    overlay.id = 'home-grid-overlay';
    overlay.className = 'home-grid-overlay';
    overlay.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const rowTemplate = Home._overlayRowTemplate(listEl);
    if (rowTemplate) overlay.style.gridTemplateRows = rowTemplate;
    let cells = '';
    for (let row = 0; row < HomeLayout.MAX_ROWS; row++) {
      for (let col = 0; col < cols; col++) {
        cells += `<div class="home-grid-cell" data-cell="${col},${row}"></div>`;
      }
    }
    overlay.innerHTML = cells;
    listEl.appendChild(overlay);
    Home._overlayEl = overlay;
  },

  _hideGridOverlay() {
    Home._clearPreview();
    Home._planMemo = null;
    if (Home._overlayEl && Home._overlayEl.parentNode) {
      Home._overlayEl.parentNode.removeChild(Home._overlayEl);
    }
    Home._overlayEl = null;
  },

  // ===== The live displacement preview =====
  //
  // While an item hovers a target, the occupants that WOULD be pushed move to
  // the cells they'd land in, right now — so the drop is never a surprise.
  // This is the same information the flow reorder gave for free (everything
  // shuffled as you dragged); free placement has to show it deliberately,
  // because only the items that actually collide move.
  //
  // The plan is HomeLayout.place's own output, so what is previewed and what
  // commits are one computation, not two that can disagree.

  // Memo of the last plan, keyed by (item, cell). canPlace runs immediately
  // before onHover on every cell change; sharing the result means the
  // highlight can never describe a different outcome than the drop.
  _planMemo: null,

  _planFor(el, cell, cols) {
    const item = Home._itemFor(el);
    if (!item || !cell) return null;
    const key = `${HomeLayout.idOf(item)}@${cell.col},${cell.row},${cols}`;
    if (Home._planMemo && Home._planMemo.key === key) return Home._planMemo.plan;
    const layout = Home.currentLayoutCached(cols);
    const next = HomeLayout.place(layout, item, cell.col, cell.row, cols);
    const plan = next ? { item, layout, next } : null;
    Home._planMemo = { key, plan };
    return plan;
  },

  // Where a committed drop LANDS, in viewport coords — the kit settles the
  // release spring here instead of on the dragged element's own rect, which
  // is still the origin cell (a placement drag never moves the real item).
  // Without this the tile flew from the finger back to where it was picked
  // up and only then jumped to the drop cell.
  //
  // Read off the same plan the tint and the drop use, so the tile settles
  // exactly where the highlight promised — including after an edge nudge,
  // where the landing cell is not the cell under the finger.
  //
  // MEASURED PRE-DROP, DELIBERATELY (#975). A drop that leaves its origin row
  // empty makes that row half height on the re-render, so if the origin was
  // ABOVE the landing row the settled tile ends up ~58px higher than the ghost
  // glided to. Accepted rather than corrected: at four columns every footprint
  // is one row tall, so that is the whole bound, and the entire lower grid
  // moves with it — it reads as the grid closing the gap, not as one tile
  // mis-landing. Correcting it would mean predicting the heights of rows the
  // re-render hasn't drawn yet (content-sized fit rows included), i.e. a second
  // source of truth for row heights, which is exactly what the overlay's
  // copy-the-used-tracks rule exists to prevent. Note HomeLayout.place prefers
  // the vacated rectangle when re-homing a displaced occupant, so the origin
  // row is usually refilled and nothing shifts at all; the case that shifts is
  // a drag into free space with nothing displaced.
  _rectForCell(el, cell, cols) {
    const overlay = Home._overlayEl;
    const plan = Home._planFor(el, cell, cols);
    if (!overlay || !plan) return null;
    const placed = plan.next.find((it) => HomeLayout.idOf(it) === HomeLayout.idOf(plan.item));
    if (!placed || placed.row >= HomeLayout.MAX_ROWS) return null;
    const target = overlay.querySelector(`[data-cell="${placed.col},${placed.row}"]`);
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { left: r.left, top: r.top };
  },

  // Elements currently wearing a preview transform, so the next hover can put
  // them back without re-deriving which ones moved.
  _previewEls: null,

  // Restores the transforms only. It must NOT drop _planMemo: _previewDrop
  // calls this first, and the memo it needs is the one canPlace computed a
  // moment earlier — clearing it here made every hover recompute the plan,
  // which is exactly the two-computations-that-can-disagree this memo exists
  // to prevent. The memo is keyed by (item, cell, cols), so a stale entry can
  // never be read; _hideGridOverlay drops it when the gesture ends.
  _clearPreview() {
    if (!Home._previewEls) return;
    for (const el of Home._previewEls) {
      el.style.transform = '';
      el.classList.remove('home-item-displaced', 'home-item-to-overflow');
    }
    Home._previewEls = null;
  },

  // The DOM element for a layout item, or null. Identity only — an item's
  // cell lives in the model, never in the DOM.
  _elFor(item, listEl) {
    const root = listEl || document.getElementById('app-list');
    if (!root || !item) return null;
    return root.querySelector(`.app-card[data-slug="${item.slug}"]`);
  },

  // Tint the cell the drop would land in, and move the item it would
  // displace. (This used to tint a whole FOOTPRINT, so a viewer dragging a
  // multi-cell widget saw the block they were about to occupy rather than
  // just the cell under the finger; every item is 1x1 now.)
  //
  // Occupied targets tint too: a drop there DISPLACES the occupant rather
  // than being refused (HomeLayout.place), so refusing to highlight it would
  // be the grid lying about where a release lands. The only untinted state is
  // the pointer genuinely leaving the canvas.
  _previewDrop(el, cell, ok, cols) {
    const overlay = Home._overlayEl;
    if (!overlay) return;
    Home._clearPreview();
    overlay.querySelectorAll('.home-grid-cell--on').forEach((c) => {
      c.classList.remove('home-grid-cell--on');
    });
    if (!cell || !ok) return;

    const plan = Home._planFor(el, cell, cols);
    if (!plan) return;
    const { item, layout, next } = plan;
    const draggedId = HomeLayout.idOf(item);

    // The target footprint, read off the PLAN rather than re-clamped here, so
    // the tint sits exactly where the item lands after an edge nudge.
    const placed = next.find((it) => HomeLayout.idOf(it) === draggedId);
    const [w, h] = HomeLayout.sizeOf(item, cols);
    if (placed) {
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          const t = overlay.querySelector(`[data-cell="${placed.col + dx},${placed.row + dy}"]`);
          if (t) t.classList.add('home-grid-cell--on');
        }
      }
    }

    // Everything the plan moves EXCEPT the dragged item — that one is
    // represented by the ghost under the finger and its dashed origin slot.
    const before = new Map(layout.map((it) => [HomeLayout.idOf(it), it]));
    const moved = new Set();
    const listEl = overlay.parentNode;
    for (const to of next) {
      const id = HomeLayout.idOf(to);
      if (id === draggedId) continue;
      const from = before.get(id);
      if (!from || (from.col === to.col && from.row === to.row)) continue;
      const node = Home._elFor(to, listEl);
      if (!node) continue;

      if (to.row >= HomeLayout.MAX_ROWS) {
        // Pushed off the canvas into the dense overflow rows. There is no
        // overlay cell to translate to, so say it in place instead of
        // sliding the tile to a position that doesn't exist yet.
        node.classList.add('home-item-to-overflow');
        moved.add(node);
        continue;
      }
      // The delta comes from the overlay's OWN cell rects — the same grid the
      // tiles are laid out in — so the preview lands pixel-exact with no
      // arithmetic over column widths or row heights.
      const fromCell = overlay.querySelector(`[data-cell="${from.col},${from.row}"]`);
      const toCell = overlay.querySelector(`[data-cell="${to.col},${to.row}"]`);
      if (!fromCell || !toCell) continue;
      const a = fromCell.getBoundingClientRect();
      const b = toCell.getBoundingClientRect();
      node.classList.add('home-item-displaced');
      node.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
      moved.add(node);
    }
    Home._previewEls = moved.size ? moved : null;
  },

  // Screenshot-state deep link (?shot=home-grid): the drag overlay only
  // exists mid-gesture, so neither the before/after captures nor a dapp.json
  // test could ever see it. Paint it in its resting visible state with the
  // first cell tinted. Pure UI state — no writes, no env gate — so the
  // production "before" side works too once shipped.
  //
  // Deliberately NOT once-per-page-load, unlike ?shot=card-menu: the grid's
  // innerHTML is replaced on every WS app event and every payload that lands
  // after the first paint, which wipes the overlay with it. A menu must not
  // pop back open under the user; an overlay is idempotent decoration, so
  // re-painting it is exactly right — a once-only guard here just meant the
  // capture raced the second render and shot a bare grid.
  _maybeShowShotGrid(listEl) {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'home-grid') return;
    if (!listEl || listEl.offsetParent === null) return; // not the visible grid
    if (Home._dragActive) return; // a real gesture owns the overlay
    const cols = Home.currentCols();
    Home._showGridOverlay(listEl, cols, null);
    // The kit sets .un-reordering for the span of a real lift, and the CSS
    // hangs the tiles' pointer-events:none off it — the thing that makes an
    // occupied cell resolvable as a drop target at all. Setting it here makes
    // this link a TRUE rendering of the mid-drag state rather than just the
    // outlines, so a check at this URL can catch that regression instead of
    // only noticing the overlay went missing.
    listEl.classList.add('un-reordering');

    // Render a REAL displacement preview, not just the outlines: pick the
    // last canvas item as the notional dragged one and hover it over (0,0).
    // Whatever sits there gets pushed and shows it. That is the whole point
    // of the link — the preview is the part a reviewer needs to see and the
    // part nothing can navigate to, and it makes the state assertable by a
    // declared check instead of only by a live gesture.
    // THE LAST RENDERED ITEM, not the last item on the canvas. The canvas is
    // eight rows deep and the grid shows two of them by default
    // (HomeLayout.DEFAULT_ROWS, THE UI OVERHAUL), so on any real account the
    // last canvas item is behind "Show all N apps" and has no element at all —
    // which sent this straight to the no-subject branch below and left the
    // shot with outlines and nothing being pushed.
    const layout = Home.currentLayoutCached(cols);
    const canvas = HomeLayout.canvasItems(layout);
    let dragged = null;
    let el = null;
    for (let i = canvas.length - 1; i > 0 && !el; i--) {
      const candidate = canvas[i];
      const found = Home._elFor(candidate, listEl);
      if (found) { dragged = candidate; el = found; }
    }
    if (el) {
      // The same dashed, contents-hidden drop slot a real lift gives the
      // dragged item (native.css .un-reorder-slot). Without it the tile stays
      // fully painted in its origin cell while the item it displaced slides
      // over that spot, and the shot reads as two things overlapping rather
      // than one thing making way for another.
      el.classList.add('un-reorder-slot');
      Home._previewDrop(el, { col: 0, row: 0 }, true, cols);
    } else {
      // Nothing to displace (an empty or single-item grid) — still tint the
      // target so the outlines have a subject.
      const first = Home._overlayEl && Home._overlayEl.querySelector('[data-cell="0,0"]');
      if (first) first.classList.add('home-grid-cell--on');
    }
  },

  // Screenshot-state deep link (?shot=widget-drop, #2894): the third sibling,
  // for the drag that ends in the Homeroom widget strip. The strip exists
  // only inside the iOS app (the bridge has to report the widget mechanism),
  // so without this no browser — not a capture, not a declared check — could
  // ever see the section, let alone the drop state.
  //
  // It shows the strip with ONE pinned tile (the second tile on the grid),
  // lifts the first tile into the kit's dashed drop slot and tints the strip
  // the way onHover does over it. The registry is a local stand-in:
  // _shortcutSupport is left alone, so the heal pass, the menu item and every
  // bridge call stay gated off — nothing is written anywhere. Idempotent and
  // repeatable like ?shot=home-grid, because every commit is a chance for a
  // repaint to have dropped it.
  _shotWidgetDrop: false,
  _maybeShowShotWidgetDrop(listEl) {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'widget-drop') return;
    if (Home._dragActive || !listEl || listEl.offsetParent === null) return;
    const cards = listEl.querySelectorAll('.app-card[data-yours][data-slug]');
    if (!cards.length) return;
    if (!Home._shotWidgetDrop) {
      Home._shotWidgetDrop = true;
      const pinned = cards[1] || cards[0];
      const app = (Home._apps || []).find((a) => a.slug === pinned.dataset.slug);
      Home._widgetItems = [{
        id: 'shot-widget-drop',
        name: (app && app.name) || pinned.dataset.slug,
        url: `${location.origin}/app/${encodeURIComponent(pinned.dataset.slug)}`,
      }];
      Home.render(); // paints the strip; the next commit comes back here
      return;
    }
    cards[0].classList.add('un-reorder-slot');
    Home._markWidgetDrop(cards[0], true);
  },

  // Press-and-hold actions for search/demo tiles, pen input, and the MOUSE.
  // Placed touch tiles use the kit's own lift callback above, so only one
  // recognizer claims a touch. Return teardown for React remounts and view
  // changes.
  //
  // #1838: the mouse always comes through HERE. The kit's own mouse path
  // only ever arms a drag (it lifts after REORDER_SLOP of movement and has
  // no hold timer), so before this a stationary mouse hold on a tile was a
  // no-op — the "can no longer hold press" in the issue.
  _wireCardLongPressMenu(card) {
    Home._wireMenuAnchorSnapshot();
    let cleanup = () => {};
    const onDown = (e) => {
      cleanup();
      if ((e.pointerType !== 'touch' && e.pointerType !== 'pen' && e.pointerType !== 'mouse')
          || e.button !== 0 || e.isPrimary === false) return;
      if (e.target.closest('.card-menu-btn') || e.target.closest('.retry-btn')
        // #4669: a press on the edit-mode remove button is not a hold on the
        // tile — it removes the app, and must never arm the 400ms menu timer.
        || e.target.closest('.app-card-remove')) return;
      // Placed touch tiles share the kit's lift/drag sequence above. Pen,
      // mouse and search/demo tiles have no touch placement recognizer to do
      // the hold.
      if (e.pointerType === 'touch' && card.hasAttribute('data-yours')
          && !card.hasAttribute('data-demo') && Home._placementHandle) return;
      // #5871: in edit mode a hold on a tile of your own is a drag (the kit's
      // mouse path lifts it once it moves), never a menu.
      if (Home._editing && card.hasAttribute('data-yours')
          && !card.hasAttribute('data-demo')) return;
      const isMouse = e.pointerType === 'mouse';
      const startX = e.clientX;
      const startY = e.clientY;
      let opened = false;
      let timer = setTimeout(() => {
        timer = null;
        const g = PlatformUI.gestures();
        if (g && !g.claim(e.pointerType === 'touch' ? 'touch' : e.pointerId, 'home-card-menu')) return;
        // Eat the click the browser fires on finger lift / button release so
        // ending the press-and-hold doesn't also open the app.
        Home._suppressClick = true;
        opened = true;
        Home.openCardMenu(card.dataset.slug, card);
      }, 400);
      cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        // Arm expiry at RELEASE, so holding for several seconds cannot
        // outlive the click guard. A quick tap on another tile still works.
        //
        // #1838: a mouse `click` follows its `pointerup` in the SAME task, so
        // a 0ms reset clears the flag before the tile's own onClick can read
        // it and the released hold would also open the app. Leave it armed
        // for the mouse and let onClick consume it; the timer is only a
        // safety net for a hold released off the tile, which fires no click.
        if (opened) setTimeout(() => { Home._suppressClick = false; }, isMouse ? 700 : 0);
      };
      const onMove = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        // Movement before the timer fires means scrolling — bail.
        if (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10) {
          if (opened) {
            Home.closeCardMenu();
            window.removeEventListener('pointermove', onMove);
          } else cleanup();
        }
      };
      const onEnd = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (ev.type === 'pointercancel' && opened) Home.closeCardMenu();
        cleanup();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    };
    card.addEventListener('pointerdown', onDown);
    return () => { cleanup(); card.removeEventListener('pointerdown', onDown); };
  },

  // NOTE: the legacy hand-rolled pointer drag (_onCardPointerDown, ~500
  // lines of ghost / hit-test / auto-scroll machinery behind the
  // `platform-legacy-reorder` localStorage flag) is GONE. It only ever
  // implemented FLOW reordering — pick a card up, everything re-packs — and
  // that model cannot express a layout with holes. Keeping it as a fallback
  // would have meant two incompatible ideas of what the home screen is,
  // with the fallback silently destroying the arrangement the primary path
  // exists to preserve. The kit's attachGridPlacement is now the only
  // recognizer, and it carries the same physics the flag was insurance for.


  // Empty-state ("No apps yet") has two variants — the existing
  // "Create your first app" CTA for users with permission, and a
  // muted "Ask an admin to enable app creation" hint for users
  // without. Toggle the CTA button on/off in place rather than
  // rebuilding the static DOM, so the surrounding "No apps yet"
  // copy stays put.
  // The one wording of "you can't create apps right now". The Create tile
  // is on every home screen regardless of quota, so this string is what the
  // locked tile announces in its tooltip and label. The dialog it opens
  // carries the exact used-of-limit numbers.
  CREATE_DISABLED_HINT: 'home:create.disabledHint',

  // `wireCreateButtons()` lived here: `document.querySelectorAll('.home-create-btn')`,
  // each button cloneNode'd and swapped for a fresh copy so a re-paint could
  // not leave two listeners on it, then a click handler bound to the clone.
  //
  // Its one caller was `HomePanels._wire`, and its one matching element is now
  // rendered by features/home/create-tile.tsx. Both halves of what it did
  // stop applying there: React keeps the element across paints, so there are
  // no stale listeners to clear, and the clone-and-replace is a structural DOM
  // write inside a subtree React owns — the exact failure the ownership rule
  // exists to prevent. Keeping it as an unused helper would leave that loaded
  // gun pointed at the block, so it went with its caller.

  // Targeted deploy-state update for a single app. Called from the
  // `app_redeploy_status` WS handler (deploy END triggers a full
  // Home.load() instead — see app.js) so the home screen flips into
  // the deploying state without a full re-render that would blow away
  // pending hover/scroll state on other cards.
  //
  // The commit pill no longer renders on the card face — build info
  // lives in the "…" menu's header, which is built lazily from the
  // Home._apps cache at open time. So this refreshes the cached app's
  // version/deployProgress, so a menu opened next shows fresh info.
  //
  // It used to ALSO re-class the tile's status dot, which was the only
  // visible "this app is redeploying" signal on an already-running card.
  // That dot is gone from the tile face on purpose (see renderAppCard), so
  // an in-flight redeploy of a running app now changes nothing visible on
  // the tile — it shows in the "…" menu's version pill instead. Nothing
  // else regressed: every non-running status still says so in words, and
  // those come from a full Home.load() as before.
  updateAppCardPill(slug, opts) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    app.deployProgress = opts && opts.deployProgress ? opts.deployProgress : null;
    // The deploy-start event carries version: null (the old SHA is
    // hidden while deploying anyway); keep the cached SHA so the
    // menu's fallback text stays meaningful, and only overwrite when
    // an event actually supplies one.
    if (opts && opts.version) app.version = opts.version;
  },
};

// `const Home` at the top of a classic script lands in the GLOBAL LEXICAL
// scope, which is NOT `window` — so `window.Home` is undefined even though
// bare `Home` resolves fine. home-panels.js guards nine call sites on
// `window.Home && …` (the same defensive shape it uses for `window.App` and
// that app.js satisfies with `window.App = App`), and every one of them was
// silently taking the "Home isn't loaded" branch forever: the Discover
// widget always rendered its empty-state note instead of the curated tiles,
// the Create widget always rendered LOCKED regardless of quota, the discover
// tiles and the create button were never wired, and hiding a widget never
// reloaded the grid. None of it threw — the guards are exactly what made it
// silent. Publishing Home the way App and HomePanels publish themselves is
// what makes those guards mean what they read as.
//
// Still published as a global now that this rides in the React bundle (#1083
// chunk F step 4): app.js's navigateHome / _exitHome / resyncCurrentView and its
// whole WS app-event fan-out, app-view.js, build-log.js, the settings screen's
// widget rows, notifications.js, the work drawer and the app-card helpers all
// reach it by name. The `const Home` note above is now redundant for the reason
// it describes — a module's top-level const was never on `window` either — but
// it records why the publication exists. The guard is for the SSG prerender pass:
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph in
// Node, where there is no window.
if (typeof window !== 'undefined') window.Home = Home;

// The grid's view model holds text (a tile's status, the results heading),
// so a language change rebuilds it from the apps already loaded.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => {
    if (Home._apps.length) Home.render();
  });
}

// escapeHtml and formatRelativeTime used to be AMBIENT here: as a classic
// script's top-level function declarations they were `window.escapeHtml` /
// `window.formatRelativeTime`, and home.js was the LAST tag to declare either,
// so it won a last-writer-wins chain. Inside a module they are module-local,
// which is the right scope and matches what browse.js, app-card.js, kudos.js and
// leaderboard.js already did when they moved.
//
// formatRelativeTime has no ambient consumer left: browse.js carries its own
// copy and build-log.js's comment says it deliberately kept one local so load
// order wouldn't matter. Nothing else ever read it.
//
// escapeHtml has one, and it changes which copy it resolves to.
// app-secrets.js calls `escapeHtml` (and `escapeAttr`, which
// is app-view.js's and calls the ambient escapeHtml) without declaring one, so
// it was reaching THIS function; with home.js out of the classic chain the
// last declaration standing is app-view.js's. The two differ: this one is a
// textContent→innerHTML pass, which escapes `& < >` but NOT quotes (hence the
// `.replace(/"/g, '&quot;')` its own callers above add), while app-view.js's
// replaces all five of `& < > " '`. In element content the rendered text is
// identical — `&quot;` and `&#39;` render as `"` and `'`. In an ATTRIBUTE
// app-view.js's is simply correct where this one could be broken out of, so the
// two dev-screen surfaces get a strictly safer escaper and the same visible
// output. Worth knowing about rather than papering over, which is why it is
// written down here.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Compact "Nx ago" formatter shared by the home-card meta line. Kept
// locally instead of pulling in a date library — the granularity here
// only needs to be readable at a glance, not exact to the second.
// Returns null for unparseable input so callers can drop the segment
// rather than render "NaN ago".
function formatRelativeTime(input) {
  if (!input) return null;
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return message('home:time.justNow');
  if (seconds < 3600) return message('home:time.minutesAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return message('home:time.hoursAgo', { count: Math.floor(seconds / 3600) });
  if (seconds < 86400 * 30) return message('home:time.daysAgo', { count: Math.floor(seconds / 86400) });
  if (seconds < 86400 * 365) return message('home:time.monthsAgo', { count: Math.floor(seconds / (86400 * 30)) });
  return message('home:time.yearsAgo', { count: Math.floor(seconds / (86400 * 365)) });
}

// Back online: refill a grid that could only show the offline note, or
// whose last read failed (a quiet network times reads out while it still
// says it is online, so the grid can be a kept copy or the error card).
// Guarded on that so a reconnect never yanks a current grid out from under
// someone mid-scroll (App.resyncCurrentView owns the general case). It
// waits HOME_RECOVERY_MS first and stands down when a load is out or has
// landed by then: the resync that the same return starts (the probe, or the
// events socket reopening) loads a visible Home itself, and two reads of
// one return would be one too many.
// (Guarded: the icon-renderer tests eval this file in a bare sandbox with
// no event target on `window`.)
const HOME_RECOVERY_MS = 1500;
const homeOwesRead = () => !Home._appsLoaded || Home._lastLoadFailed;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('usernode:offline-change', (e) => {
    if (!e.detail || e.detail.offline !== false) return;
    if (!window.Home || !homeOwesRead()) return;
    setTimeout(() => {
      if (!Home._loadInFlight && homeOwesRead()) Home.load();
    }, HOME_RECOVERY_MS);
  });
}
