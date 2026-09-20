// ── The build this document IS ─────────────────────────────────────────
//
// `<meta name="platform-build">`, written into public/index.html by
// frontend/scripts/build-shell.mjs from the GIT_SHA the image was built with.
//
// This is the boot baseline `loadedPlatformSha` needs, and the reason it
// cannot be recovered from /api/version: that endpoint answers "what is the
// SERVER running", and the document is not always from the server. A tab
// booting off the service worker's shell cache — a cold start after the app
// was killed, which is exactly when a deploy has most likely happened in
// between — runs the OLD build and would record the NEW sha as its own
// baseline. `isStale` then goes false permanently: no prefetch, no dot on the
// Improve button, no reload offer. The one state that whole machine exists
// for was the one state it could never observe.
//
// Returns null outside a deploy (`dev`, and local/staging builds have no
// GIT_SHA at all), which leaves the old first-poll capture in loadVersion as
// the fallback — the same behaviour those environments had before.
function documentPlatformSha() {
  try {
    const meta = document.querySelector('meta[name="platform-build"]');
    const value = meta && meta.getAttribute('content');
    return value && value !== 'dev' ? value : null;
  } catch { return null; }
}

// Top-level `const` doesn't auto-write to `window` in non-module
// scripts, so other modules that read `window.App.…` instead of the
// bare `App.…` identifier silently see `undefined`. Mirror onto
// `window` explicitly so both styles work — the rest of this file
// uses bare `App` because it's already in scope here.
const App = {
  user: null,
  currentApp: null,
  // Top-level mode: 'app' (the running iframe) or 'dev' (#194). The
  // legacy tab names 'group-chat' / 'individual-chat' are normalized to
  // dev sub-tabs by _normalizeTab so old links, notification hrefs, and
  // call sites keep working.
  currentTab: 'app',
  // Active Dev view: 'forum' (the card list, default), 'chat'
  // (full-screen general chat), 'topic' (an issue/proposal discussion
  // open full-screen), or 'sessions' (a dev session open full-screen).
  // Only meaningful while currentTab === 'dev'.
  currentSubTab: 'forum',
  // Tracks whether the dedicated #leaderboard-screen (the Leaderboard
  // screen: Kudos + Topochain + Challenges tabs) is visible. Sibling
  // state to `currentApp`: home / app / leaderboard are the three
  // top-level screens, and they're mutually exclusive. Flipped by
  // navigateToLeaderboard() / _exitLeaderboard() / navigateHome().
  //
  // There is deliberately no separate _inTopochainLeaderboard,
  // _inChallenges or _inTopochainSeasons any more: the Topochain
  // standings and the season challenges are TABS of this screen (see
  // Leaderboard.section), not screens of their own, so one flag covers
  // all three and the sibling navigate* functions have three fewer
  // exits to remember.
  _inLeaderboard: false,
  // Same for the #profile screen (profile-and-settings-to-web migration)
  // — set by navigateToProfile() / _exitProfile() / navigateHome().
  _inProfile: false,
  // Same for the #admin screen (admin & moderation console, #818) — set
  // by navigateToAdminConsole() / _exitAdminConsole() / navigateHome().
  _inAdmin: false,
  // Same for the #settings screen (settings-modal-to-screen conversion)
  // — set by navigateToSettings() / _exitSettings() / navigateHome().
  _inSettings: false,
  // Same for the #apps browse screen (home-screen split: home is "Your
  // apps" only, every other app lives there) — set by
  // navigateToBrowse() / _exitBrowse() / navigateHome().
  _inBrowse: false,
  // Platform-wide direct and group conversations (#488). The screen itself
  // is React-owned; this flag only coordinates the classic shell router.
  _inMessages: false,
  // Experimental Global Chat (#2543), now a normal routed screen with one
  // stable address per durable session.
  _inGlobalChat: false,

  // Chromeless full-screen mode (/app/<slug>/full): the App tab with the
  // platform header + tab bar hidden, so the embedded app fills the
  // viewport. This is where the edge gate sends credential-less direct
  // visits to an app's own subdomain — the shell still injects the
  // iframe token, refreshes it, and hosts the bridge/LLM-consent flows,
  // so a shared link "just works". The only chrome is a floating
  // "Open in Homeroom" pill (see _mountChromelessPill) that switches to
  // the regular /app/<slug> view. Driven purely by the route via
  // restoreFromHash/setChromeless.
  chromeless: false,

  // Set to true while restoreFromHash() is applying a URL (e.g. on
  // popstate/hashchange) so that the navigation helpers it calls
  // (navigateToApp, switchTab, navigateHome) don't push a NEW history
  // entry on top of the one the browser just popped to. Without this
  // guard, "back" would push a forward entry and the user could never
  // actually leave the page.
  _isRestoring: false,

  // ── Is there anywhere of OURS below this history entry? (#1565) ──────
  //
  // A screen that claims the back chevron has to answer that, and nothing
  // else in the platform can: `history.length` counts entries from other
  // documents, `document.referrer` says nothing about a fragment change, and
  // a cold deep link to `#settings/username` and an in-app link to the same
  // address are indistinguishable once they have been applied.
  //
  // So the router remembers. `_currentRoute` is the address on screen and
  // `_previousRoute` the one before it — `''` for home, and NULL only while
  // this document has not navigated at all since it loaded, which is exactly
  // the case where back leaves the app.
  //
  // Both are written in _routeFromHash, the one funnel popstate and
  // hashchange share, and seeded in bindEvents with the address the document
  // loaded at so the FIRST navigation already has a real answer.
  _previousRoute: null,
  _currentRoute: null,

  // The address this document was showing before the current one, or null
  // when it has not navigated since it loaded. `''` means home.
  previousRoute() {
    return App._previousRoute;
  },

  // ── Display-only session snapshot (#1021) ───────────────────────────
  // A tiny durable record that THIS DEVICE was signed in, written on every
  // successful boot/login and read only when /api/auth/me cannot be
  // reached at all. Without it an offline reload is indistinguishable from
  // a sign-out: `fetch` throws, and the shell drops the user on the
  // landing screen with no way back until the network returns.
  //
  // It is DISPLAY-ONLY and grants nothing. The session cookie remains the
  // sole credential — every request still authenticates normally and the
  // server is free to reject them. All the snapshot decides is which
  // *screen* an offline boot paints, and the moment the network answers
  // again the real /api/auth/me reconciles it (see _reconcileSession).
  // It is cleared on logout, on any answered non-ok /me, and when it ages
  // out, so a stale one can't strand a signed-out device in a signed-in
  // looking shell.
  SESSION_SNAPSHOT_KEY: 'usernode.session.v1',
  SESSION_SNAPSHOT_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

  // #1524 — a one-shot advisory handed from a sign-out to the anonymous boot
  // that follows it. Sign-out always navigates now, which destroys any toast
  // raised before it, so the message rides across in sessionStorage instead.
  // Written by Settings.logout on the one path that has something to say (a
  // native sign-out whose terminal step failed); read and removed exactly
  // once, by enterAnonymous below.
  LOGOUT_NOTICE_KEY: 'sv:logout_notice',

  // How long boot waits for /api/auth/me before falling back to the
  // snapshot. Deliberately just past the service worker's own API deadline
  // (API_TIMEOUT_MS, now 1000) so the SW gets first refusal at answering
  // from cache; this only catches the no-SW / SW-bypassed cases.
  //
  // MOVE THIS WHENEVER API_TIMEOUT_MS MOVES. It is the last link in the
  // serial chain a cold load walks — navigation, then the shell's scripts,
  // then this — so leaving it at the old 5s would have made it the sole
  // remaining multi-second wait on a weak connection and undone most of
  // the retune on its own.
  BOOT_SESSION_TIMEOUT_MS: 2000,

  saveSessionSnapshot(user) {
    if (!user || !user.id) return;
    try {
      localStorage.setItem(App.SESSION_SNAPSHOT_KEY, JSON.stringify({
        user, savedAt: Date.now(),
      }));
    } catch (err) { /* private mode / quota — offline boot just degrades */ }
  },

  readSessionSnapshot() {
    try {
      const raw = localStorage.getItem(App.SESSION_SNAPSHOT_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || !snap.user || !snap.user.id) return null;
      const age = Date.now() - Number(snap.savedAt || 0);
      if (!(age >= 0) || age > App.SESSION_SNAPSHOT_MAX_AGE_MS) {
        App.clearSessionSnapshot();
        return null;
      }
      return snap;
    } catch (err) {
      return null;
    }
  },

  clearSessionSnapshot() {
    try { localStorage.removeItem(App.SESSION_SNAPSHOT_KEY); } catch (err) { /* ignore */ }
  },

  // Ask the service worker to drop the cached API responses of a session
  // that is definitively over. Fire-and-forget: the snapshot has already
  // been cleared, so a worker that never answers changes nothing.
  _dropCachedSession() {
    App.clearSessionSnapshot();
    // The remembered top-bar state goes with it, for the same reason and on
    // the same event: it is display-only (frontend/src/lib/shell-snapshot.ts),
    // but the next cold paint reading back the previous account's app name is
    // exactly the residue this function exists to clear.
    try {
      window.UsernodeReact?.shellSnapshot?.clear?.();
    } catch (err) { /* nothing stored, or no storage at all */ }
    // …and the remembered Improve target, which is the same kind of residue
    // for the same reason: it exists so a cold boot can put the header's
    // standing action up before /api/apps answers, and the next account may
    // not be served the self-hosted row at all.
    try {
      if (typeof Home !== 'undefined') localStorage.removeItem(Home.IMPROVE_TARGET_KEY);
    } catch (err) { /* nothing stored, or no storage at all */ }
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
    } catch (err) { /* no SW — nothing cached to drop */ }
    // #487 follow-up: which apps this browser has opened offline-capable is
    // the same kind of session residue as the cached feed, and it goes with
    // it. Bare `AppView` — it is a classic-script top-level `const`, so
    // `window.AppView` would silently be undefined (see resyncCurrentView).
    try {
      if (typeof AppView !== 'undefined') AppView.clearOfflineReady();
    } catch (err) { /* ignore */ }
  },

  // True while the shell is running on the snapshot rather than a verified
  // /api/auth/me. Read by the boot path (skip the session-gated fetches
  // and the events socket) and cleared by _reconcileSession.
  _sessionFromSnapshot: false,

  // ── The boot session read, published ────────────────────────────────
  //
  // GET /api/auth/me was being fetched TWICE on every document, 16ms apart,
  // and the boot queued behind the copy it did not make. Settings.init()
  // mounts from a React layout effect at document load — on every screen,
  // not just #settings, because the byok dot it publishes rides the Profile
  // screen and DevChat's budget indicator — and it read the same endpoint
  // for the same fields that are already on the `user` object App.init is
  // about to fetch. Whichever went first, the other waited behind it on the
  // connection: measured on a 150ms link, one read is ~250ms and the pair
  // was ~420ms, which is ~130ms off the first paint of EVERY screen.
  //
  // So the boot read is published rather than repeated. Three outcomes,
  // because "no" and "we could not tell" are not the same answer and a
  // caller has to be able to act differently on them:
  //
  //   { user }          — a verified session; use it, ask nothing.
  //   { signedOut }     — /api/auth/me answered 401/403. Asking again gets
  //                       the same 401, so callers stop rather than spend a
  //                       request rediscovering it.
  //   { unknown: true } — the read never landed and the shell is running on
  //                       the localStorage snapshot, whose thin user record
  //                       carries none of these fields. A caller that needs
  //                       them reads for itself; the worker answers that
  //                       from cache offline (/api/auth/me is IMMUNE there),
  //                       which is what it did before this existed.
  //
  // Settled from enterAuthed / enterAnonymous rather than from init(),
  // because EVERY boot path ends in one of those two — including the three
  // ?shot= early returns, which never reach the session read at all and
  // would otherwise leave a joiner waiting forever.
  //
  // Deliberately settled ONCE, on the first of them. A reload-free login
  // (auth-screens.js) calls enterAuthed again later; a joiner that already
  // resolved `signedOut` is not listening by then, and that is exactly the
  // pre-existing behaviour — Settings ran once per document and its 401
  // ended it. Making a later login re-publish is a real improvement and a
  // separate one; it is not what this is fixing.
  _bootSession: null,
  _settleBootSession: null,

  bootSession() {
    if (!App._bootSession) {
      App._bootSession = new Promise((resolve) => {
        App._settleBootSession = resolve;
      });
    }
    return App._bootSession;
  },

  _publishBootSession(outcome) {
    App.bootSession();
    if (!App._settleBootSession) return;
    const settle = App._settleBootSession;
    App._settleBootSession = null;
    settle(outcome);
  },

  async init() {
    // FIRST, before any screen paints: the synthetic-inset shot state.
    // Runs here rather than beside the other ?shot= handlers below
    // because it must cover the anonymous shell too (the landing / login
    // / waitlist screens are part of what it reviews) and because a
    // later application would repaint every inset mid-boot.
    App._applySafeAreaShot();

    // Chrome wiring is session-independent and has no re-entry guards
    // (double listeners otherwise), so it runs exactly once per document
    // — BEFORE we know whether a session exists. The anonymous shell
    // needs the popstate/hashchange wiring too (auth screens are
    // hash-routed).
    App.bindEvents();

    // Screenshot-state deep links for the ANONYMOUS shell (`?shot=anon`,
    // `?shot=waitlist-joined`, `?shot=anon-back`). Captures and proposal checks carry a
    // capture token, so a session always exists for them and
    // restoreFromHash would strip #landing / #waitlist to the home feed —
    // the signed-out screens would be unreachable to every shot. These
    // skip the /api/auth/me fetch so the anonymous shell boots and the
    // fragment picks the screen. Pure UI state: no writes, no env gate, so
    // the "before" side starts working the moment this ships.
    if (App._anonShot()) {
      await App.enterAnonymous();
      return;
    }
    // `?shot=offline` / `?shot=offline-signin` pin the offline state before
    // the boot check runs, so the shot never depends on real connectivity.
    // The signed-out variant boots the anonymous shell directly, exactly
    // as _anonShot does, so it doesn't depend on the capture's session.
    if (App._applyOfflineShot() === 'offline-signin') {
      await App.enterAnonymous();
      return;
    }

    // Boot has THREE outcomes, not two (#1021). The old code collapsed
    // "the server said no" and "the server said nothing" into the same
    // anonymous boot, so a signed-in user who reloaded on a dead network
    // landed on the landing page — signed out, in effect, by a dropped
    // packet.
    //
    //   answered, ok       → the real session; refresh the snapshot.
    //   answered, not ok   → genuinely signed out; drop every cached trace.
    //   never answered     → unknown. Fall back to the snapshot and show
    //                        the signed-in shell in read-only offline mode,
    //                        reconciling as soon as the network returns.
    // ── The snapshot goes FIRST when there is one ────────────────────
    //
    // This read used to be the gate: nothing painted until /api/auth/me
    // answered, which on a 150ms link was ~250ms of the ~1100ms to a
    // usable board and the last serial network wait in the boot chain.
    // The snapshot existed the whole time and could have answered it — it
    // was just wired as the fallback for when the read FAILED rather than
    // as the thing the shell starts from.
    //
    // This is what a native app does: it reads the session out of the
    // keychain synchronously, renders from its local store, and discovers
    // auth lazily — a 401 on a real request is what sends you to a login
    // screen, not a question asked before the first frame. The snapshot is
    // the keychain record here, and it is the WHOLE last user object, not
    // an id: the shell it paints is the right shell, with the right admin
    // affordances and the right quota, not a stub.
    //
    // What makes it safe is unchanged and is not on this side of the wire:
    // the session cookie is still the only credential, every request still
    // authenticates, and the server is still free to reject any of them.
    // The snapshot decides which SCREEN paints first, nothing more — and
    // the data behind that screen is the cache already on this device,
    // which whoever is holding it could see a moment ago.
    //
    // _sessionFromSnapshot stays true until the read lands, so everything
    // that must not run against an unverified session — the events socket,
    // the budget widgets, SessionState, the terms first-run — is held by
    // the guards that already exist for the offline case. _reconcileSession
    // starts all of it when the answer arrives, and reloads if the answer
    // is that the session ended or belongs to somebody else.
    const snap = App.readSessionSnapshot();
    if (snap) {
      App._sessionFromSnapshot = true;
      App.enterAuthed(snap.user);
      // NOT awaited: it is the whole point that the shell is already up.
      App._reconcileSession({ fromBoot: true });
      return;
    }

    // No snapshot: this device has never completed a boot here, so there is
    // nothing to be optimistic WITH and the read is the only answer. Three
    // outcomes, not two (#1021) — the old code collapsed "the server said
    // no" and "the server said nothing" into the same anonymous boot, so a
    // signed-in user who reloaded on a dead network landed on the landing
    // page, signed out in effect by a dropped packet.
    let res = null;
    try {
      res = await App._fetchSession();
    } catch (err) {
      res = null;
    }

    if (res && res.ok) {
      let user = null;
      try { user = (await res.json()).user; } catch (err) { user = null; }
      if (user) {
        App.enterAuthed(user);
        return;
      }
    } else if (App._answeredSignedOut(res)) {
      // A real answer with a real "no" (401/403). Only reachable online —
      // error responses never enter the SW cache — so this is authoritative.
      App._dropCachedSession();
      await App.enterAnonymous();
      return;
    } else if (res) {
      // Answered, but not ABOUT the session (#1608): a 500 from a database
      // hiccup, a 502 from the proxy, a 429. The cookie is untouched and
      // still live, so dropping the cached trace here would put the sign-in
      // screen in front of a session the server still holds — the dead end
      // this issue is about. Boot anonymous (there is no snapshot to paint)
      // but leave the cache alone, and let the next read settle it.
      try { window.Offline?.nudge(); } catch (err) { /* ignore */ }
      await App.enterAnonymous();
      return;
    }

    // No answer and no snapshot: offline on a device that was never signed
    // in. Probe so the strip appears; the anonymous shell shows its own
    // offline state and refuses submits (see auth-screens.js).
    try { window.Offline?.nudge(); } catch (err) { /* ignore */ }
    await App.enterAnonymous();
  },

  // Does this answer mean the SESSION is over? Only the two statuses the API
  // returns for that: 401 (no session) from /api/auth/me itself and 403 from
  // the platform-access gate. Everything else a response can carry — 500 when
  // the session lookup query fails (middleware/auth.js answers "Session check
  // failed" with one), 502/503 from the proxy, 429 — says nothing about the
  // cookie, which is still sitting in the browser and still valid.
  //
  // Collapsing those into "signed out" is what produced the reported dead end
  // (#1608): the shell dropped to the sign-in screen while the server still
  // held a live session, and the session-mint boundary then refused the
  // credentials with "Sign out before signing in again." from a shell that
  // has no sign-out to offer. The client recovery in
  // frontend/src/features/auth/shared.ts closes that door from the other
  // side; this is the side that stops the user arriving there at all.
  _answeredSignedOut(res) {
    return !!res && (res.status === 401 || res.status === 403);
  },

  // /api/auth/me with a deadline. Resolves to the Response, or throws when
  // nothing arrived in time — an open-but-stalled socket must not hold the
  // whole boot, which is what left the reported blank screen.
  async _fetchSession() {
    const response = await App._fetchWebSession();
    if (window.NativeChrome && typeof NativeChrome.restoreWebSession === 'function') {
      try {
        const restored = await NativeChrome.restoreWebSession({ force: response.status === 401 });
        if (restored) return App._fetchWebSession();
      } catch (error) {
        // Native uncertainty must not erase a display snapshot. A valid web
        // response can still be used while native recovery is unavailable.
        if (response.status === 401) throw error;
      }
    }
    return response;
  },

  async _fetchWebSession() {
    let timer = null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), App.BOOT_SESSION_TIMEOUT_MS);
    try {
      return await fetch('/api/auth/me', ctrl ? { signal: ctrl.signal } : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  // Replace the snapshot-derived session with a verified one. This runs on
  // EVERY boot that started from a snapshot — which, since the shell boots
  // optimistically, is every boot on a device that has been signed in here
  // — and again from the reconnect path when the network returns.
  //
  // Four outcomes, and each matters:
  //   401/403     → the session really did end. Drop every cached trace and
  //                 reload, which lands on the sign-in screen.
  //   another id  → a different user; a full reload is the only way to
  //                 rebuild a shell that was painted for someone else.
  //   same id     → promote to a live session: start everything the
  //                 unverified guards held back, and resync the screen.
  //   no answer   → offline. Raise the strip and stay on the snapshot; the
  //                 reconnect path calls this again.
  //
  // Uses the same deadline'd read as the boot (_fetchSession): an
  // open-but-stalled socket must not hold this open forever either, and on
  // the boot path this IS the boot's read.
  async _reconcileSession({ fromBoot = false } = {}) {
    if (!App._sessionFromSnapshot) return;
    let res;
    try {
      res = await App._fetchSession();
    } catch (err) {
      res = null;
    }
    if (!res) {
      // Still unreachable — stay on the snapshot and say so on screen. This
      // is where the offline strip belongs: the shell is up and READABLE,
      // and the thing the viewer needs to know is that it is not live.
      try { window.Offline?.nudge(); } catch (e) { /* ignore */ }
      App._publishBootSession({ unknown: true });
      return;
    }
    if (!res.ok && !App._answeredSignedOut(res)) {
      // Answered, but not ABOUT the session (#1608). A signed-in reload that
      // lands on a 500 must not end with the sign-in screen in front of a
      // session the server still holds: keep the snapshot, say we could not
      // tell, and let the next reconcile settle it. Same treatment as no
      // answer at all, because that is exactly what this is.
      try { window.Offline?.nudge(); } catch (e) { /* ignore */ }
      App._publishBootSession({ unknown: true });
      return;
    }
    if (!res.ok) {
      App._dropCachedSession();
      App._sessionFromSnapshot = false;
      App._publishBootSession({ signedOut: true });
      location.reload();
      return;
    }
    let user = null;
    try { user = (await res.json()).user; } catch (err) { user = null; }
    if (!user) return;
    if (String(user.id) !== String(App.user?.id)) {
      App.clearSessionSnapshot();
      location.reload();
      return;
    }
    // Platform access is the one field whose value decides which SHELL is
    // on screen rather than what is inside it — enterAuthed sends a viewer
    // without it to the waiting room. A snapshot that disagrees with the
    // server about it painted the wrong shell, and there is no repairing
    // that in place.
    if (!!user.hasPlatformAccess !== !!App.user?.hasPlatformAccess) {
      App.saveSessionSnapshot(user);
      location.reload();
      return;
    }
    App._sessionFromSnapshot = false;
    if (window.NativeChrome &&
        typeof NativeChrome.prepareIdentityPublication === 'function') {
      NativeChrome.prepareIdentityPublication(user);
    }
    App.user = user;
    App.saveSessionSnapshot(user);
    // The verified answer, for everyone who joined bootSession() rather
    // than reading /api/auth/me for themselves. Published HERE on an
    // optimistic boot, because until now the shell had a last-known user,
    // not a confirmed one.
    App._publishBootSession({ user });
    document.dispatchEvent(new CustomEvent('sv:session', {
      detail: { user: App.user },
    }));
    App.connectEvents();
    if (window.Kudos?.Budget?.init) Kudos.Budget.init();
    if (window.AiCredit?.Budget?.init) AiCredit.Budget.init();
    // Held by the same unverified-session guard in enterAuthed, so it has
    // to start here too. Missing it left an optimistic boot with no session
    // state at all — invisible offline, where this path used to be the only
    // way in, and on every load once it became the ordinary one.
    if (window.SessionState) { try { SessionState.start(); } catch (e) { /* ignore */ } }
    // Same reason: the terms first-run check bails on an unverified session
    // (features/settings/terms-first-run.js), so it has to be re-offered
    // once there is a verified one.
    try { window.TermsFirstRun?.maybePrompt?.(); } catch (e) { /* ignore */ }
    // resyncCurrentView is the DISCONNECT-RECOVERY sweep: reload home,
    // re-pull notifications, resync session state, re-read the version. It
    // belongs to the reconnect path, where the screen has been sitting on
    // cached data through an outage and everything on it may have moved.
    //
    // On a BOOT promotion none of that is true. The screen was painted
    // moments ago from this same session's data, so the sweep re-runs half a
    // dozen loads that just ran — and it lands ~300ms in, on top of whatever
    // the first paint put on screen. That is not only waste: it reopened a
    // real defect in the ?shot=feedback-capture-failed route, where the
    // sweep arrived while the shot's dialog was open and took it back down,
    // leaving the status line written but the modal closed. Two proposal
    // checks failed on exactly that.
    if (!fromBoot) {
      try { App.resyncCurrentView(); } catch (err) { /* ignore */ }
    }
  },

  // ── Staged boot (fold-auth-pages-into-SPA) ──────────────────────────
  // The SPA now serves anonymous visitors too: landing / login / signup /
  // register / waiting are hash-routed in-SPA screens (auth-screens.js),
  // and login is reload-free — the authed shell boots in place. Three
  // stages:
  //   bindEvents (chrome)  — once per document, session-independent.
  //   enterAnonymous       — no session: show the auth screens.
  //   enterAuthed(user)    — session established: set App.user, then
  //                          either the waiting room (no platform access)
  //                          or the full one-shot authed boot.
  _authedBooted: false,

  async enterAnonymous() {
    let nativeBoundary = null;
    if (window.NativeChrome && NativeChrome.enterAnonymous) {
      // enterAnonymous closes the private native realm synchronously before
      // returning its Promise. Publish null only after that hard boundary.
      nativeBoundary = NativeChrome.enterAnonymous();
    }
    App.user = null;
    if (nativeBoundary) await nativeBoundary;
    // The boot reader sees signed-out only after native authority is closed.
    App._publishBootSession({ signedOut: true });
    // Capture the platform SHA this document booted with. The anonymous
    // shell has no drawer (so no stale-version pill), which makes
    // pull-to-refresh its only recovery path after a deploy — and
    // platformMovedOn() needs a boot-time baseline to compare against.
    App.loadVersion();
    if (window.AuthScreens) AuthScreens.enter();
    App._drainLogoutNotice();
  },

  // Read-and-remove the one-shot sign-out advisory (#1524). Runs after the
  // auth screens are up so the toast lands on the landing page the user was
  // just sent to. One-shot by construction: the key is removed before it is
  // shown, so a later anonymous boot stays silent.
  _drainLogoutNotice() {
    let message = null;
    try {
      message = window.sessionStorage?.getItem?.(App.LOGOUT_NOTICE_KEY) || null;
      if (message) window.sessionStorage.removeItem(App.LOGOUT_NOTICE_KEY);
    } catch (err) { /* private mode / no storage — nothing to say */ }
    if (!message) return;
    try {
      if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(message, { error: true });
      }
    } catch (err) { /* ignore */ }
  },

  // True for the anonymous-shell screenshot-state links (see init). Also
  // normalises the fragment for `?shot=waitlist-joined`, which names one
  // specific screen — so the path needs no hash of its own and the shot
  // stays deterministic. AuthScreens._waitlistOnShow reads the same param
  // to paint the post-join state.
  _anonShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    // `anon-back` (#1028) scripts the guest back path on the landing
    // directory. It matters that it routes through here and not the
    // ordinary boot: this path skips /api/auth/me, so the capture or
    // proposal check's own session can't promote the page into the
    // signed-in shell and stop exercising the guest viewer at all.
    // `password-recovery` (#1158) opens the login screen's forgot-password
    // view (login.tsx reads the shot in loginOnShow); it needs the same
    // anonymous boot so the capture session can't strip #login to the feed.
    // `password-recovery-sent` is the same view with the post-submit
    // confirmation painted (the green "link is on its way" success box).
    // `password-reset-complete` is the terminal step after that link is
    // redeemed: the reset form is gone and the login form carries the durable
    // success notice. It sends nothing and consumes no token.
    // `email-code-password-account` (#1586) is the login screen carrying the
    // explanation an email code hands back when the account it matches can
    // only be signed in with its password. Same anonymous boot, same reason.
    // `waitlist-confirmed` is the state AFTER the six-digit code lands:
    // confirming is what puts somebody on the list now, so the list place
    // and the stage-2 offer live there rather than on `waitlist-joined`,
    // which stops at the confirm step.
    // `waitlist-more` opens the stage-2 survey for the token in the
    // fragment (`/?shot=waitlist-more#more/<48 hex>`). The survey is an
    // auth screen, and restoreFromHash drops an auth route outright for a
    // signed-in user who has platform access — which every capture and
    // proposal-check session is — so without this the screen is reachable
    // by a real recipient and by nothing that photographs or checks it.
    // `waitlist-step1` and `waitlist-code-entry` are the two halves of the
    // returning-user path: the join form carrying the "Already joined?"
    // link, and the confirm step reached through it, which is the only
    // state that asks which address the code belongs to. Both need the
    // anonymous boot for the same reason waitlist-more does: restoreFromHash
    // drops an auth route outright for the signed-in session every capture
    // and proposal check runs as.
    // `waitlist-code-step` (#1876) is what follows that address step now
    // that the errand is two screens: the six-digit field, the way back, and
    // the resend, with a request already behind it. A shot of its own
    // because the two halves cannot be photographed at once, and a capture
    // can only navigate to a state, never type its way into one.
    // `waitlist-admitted` (#1538) is the released panel of check-my-status:
    // the pill, the joined-on date and the "Create my account" action a
    // signup that has been let in reads back after typing its code. It is
    // the one settled state no other route can paint, because reaching it
    // for real needs a row with a released_at behind it.
    // `waitlist-status` is the same panel one state earlier: still waiting,
    // read back through check-my-status rather than confirmed just now. It
    // is a separate shot from `waitlist-confirmed` because the difference
    // between them is the whole point of the panel — the celebration is the
    // join's and the state pill is the status read's — and one shot cannot
    // photograph both.
    // `waitlist-not-found` (#2201) is the third answer that address step can
    // get: the address is not on the list at all. It carries the note saying
    // so and the control that turns the dead end into a join, and like the
    // two above it needs the anonymous boot. Nothing is sent to paint it —
    // waitlist.tsx sets the note from a literal.
    // `waitlist-rejoined` (#2201) is that same settled panel reached a
    // fourth way: an address already on the list AND already confirmed
    // submits the join form again, and the server answers with its status
    // instead of a code, so the client skips the code step entirely. No URL
    // reaches it without the POST behind it, so a capture cannot get there
    // on its own — and it is the state this change exists to produce, so a
    // before/after that photographed the home screen would show none of it.
    // `signup-code-sent` (#1548) is the signup screen a second after a
    // waitlist-release link opens it: the code step, the confirmation, and
    // the resend held for its cooldown. The address rides in the fragment
    // (`/?shot=signup-code-sent#signup/<url-encoded address>`), and like
    // `waitlist-more` it needs the anonymous boot, because restoreFromHash
    // drops an auth route for the signed-in session every capture and
    // proposal check runs as. login.tsx paints it and sends nothing.
    if (shot !== 'anon' && shot !== 'waitlist-joined' && shot !== 'waitlist-confirmed' &&
        shot !== 'waitlist-step1' && shot !== 'waitlist-code-entry' &&
        shot !== 'waitlist-code-step' && shot !== 'waitlist-not-found' &&
        shot !== 'waitlist-admitted' && shot !== 'waitlist-status' &&
        shot !== 'waitlist-rejoined' &&
        shot !== 'waitlist-more' &&
        shot !== 'anon-back' &&
        shot !== 'signup-code-sent' &&
        shot !== 'password-recovery' && shot !== 'password-recovery-sent' &&
        shot !== 'password-reset-complete' &&
        shot !== 'email-code-password-account') {
      return false;
    }
    if ((shot === 'waitlist-joined' || shot === 'waitlist-confirmed'
         || shot === 'waitlist-step1' || shot === 'waitlist-code-entry'
         || shot === 'waitlist-code-step' || shot === 'waitlist-not-found'
         || shot === 'waitlist-admitted' || shot === 'waitlist-status'
         || shot === 'waitlist-rejoined') &&
        (!location.hash || location.hash === '#')) {
      try { history.replaceState(null, '', location.search + '#waitlist'); } catch (err) { /* ignore */ }
    }
    return true;
  },

  // Screenshot-state deep links for the offline experience (#1021):
  //   ?shot=offline         — the signed-in shell in read-only offline mode
  //                           (the fixed strip above everything).
  //   ?shot=offline-signin  — the signed-out login screen while offline:
  //                           the explanation block, and the credential
  //                           fields greyed out because they cannot work.
  //
  // Both pin connectivity rather than reading it, because the one thing a
  // capture runner and a reviewer's browser always have is a working
  // network — without this the offline UI is literally unphotographable,
  // and the "before" side of the comparison could never be produced.
  // Pure UI state, no writes, so deliberately NOT env-gated (same
  // reasoning as ?shot=improve). Returns the shot name, or null.
  _applyOfflineShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'offline' && shot !== 'offline-signin'
        && shot !== 'offline-app' && shot !== 'offline-app-blocked') return null;
    if (shot === 'offline-signin' && (!location.hash || location.hash === '#')) {
      try { history.replaceState(null, '', location.search + '#login'); } catch (err) { /* ignore */ }
    }
    try { window.Offline?.forceOffline(); } catch (err) { /* ignore */ }
    return shot;
  },

  // Screenshot-state deep links `?shot=offline-app` / `?shot=offline-app-blocked`
  // (#487 follow-up): the offline App tab, with and without an app whose own
  // service worker can serve it. The offline state itself is pinned much
  // earlier, by _applyOfflineShot above; painting the App tab needs the
  // screens to exist, so it runs late, beside _applyLaunchShot.
  //
  // Both are self-contained — see AppView.showOfflineAppShot for why they
  // synthesise the app record instead of naming a real slug.
  //
  // Bare `AppView`: classic-script top-level `const`, so `window.AppView`
  // would silently be undefined (see resyncCurrentView).
  _applyOfflineAppShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'offline-app' && shot !== 'offline-app-blocked') return;
    try {
      if (typeof AppView !== 'undefined') AppView.showOfflineAppShot(shot === 'offline-app');
    } catch (err) { /* ignore */ }
  },

  enterAuthed(user) {
    if (window.NativeChrome &&
        typeof NativeChrome.prepareIdentityPublication === 'function') {
      // The bridge handles this event synchronously and drops the old opaque
      // realm claim before the successor identity becomes observable.
      NativeChrome.prepareIdentityPublication(user);
    }
    App.user = user;
    // A snapshot is display-only and unverified. _reconcileSession publishes
    // the server's answer; a normal login publishes immediately.
    if (!App._sessionFromSnapshot) App._publishBootSession({ user });
    // "View as non-admin" admin tool. We mask `App.user.isAdmin`
    // for client-side UI gating (admin buttons, retry, delete, lock,
    // app-secrets edit, etc. — see grep for App.user?.isAdmin) so
    // an admin can preview the experience a regular user gets.
    // Server-side `req.user.isAdmin` is unaffected — this is purely
    // visual, not a privilege drop. We stash the real value on
    // App._realIsAdmin so settings.js knows whether to render the
    // toggle, and the body class lets a thin header banner reveal
    // the masked state at all times so the admin doesn't forget
    // they're in preview mode.
    App._realIsAdmin = !!App.user?.isAdmin;
    // View-only admin role (issue #311): mutating controls gate on
    // `canAdminWrite`, view affordances on `isAdmin`. Mask BOTH under the
    // "View as non-admin" preview so the admin sees the true non-admin
    // experience. Server-side gates are unaffected — purely visual.
    App._realCanAdminWrite = !!App.user?.canAdminWrite;
    App._viewAsNonAdmin = App._realIsAdmin
      && localStorage.getItem('viewAsNonAdmin') === '1';
    if (App._viewAsNonAdmin && App.user) {
      App.user.isAdmin = false;
      App.user.canAdminWrite = false;
      App.user.role = 'user';
      document.body.classList.add('is-view-as-non-admin');
    }

    // #1284: a feedback draft that a failed screenshot capture left behind in
    // sessionStorage — tell the user it is still there. Optional call: the
    // feedback island publishes this when it wires up, which may be after
    // this point on a slow boot, in which case there is nothing to announce
    // anyway (the draft is handed back on the next open regardless).
    try { App.noticeRescuedFeedbackDraft?.(); } catch (err) { /* ignore */ }

    // Remember that this device is signed in, so a later boot that can't
    // reach /api/auth/me still knows which shell to paint (#1021). Skipped
    // when the shell is running FROM the snapshot — re-writing it then
    // would keep refreshing savedAt and an offline device would never age
    // its session out.
    if (!App._sessionFromSnapshot) App.saveSessionSnapshot(App.user);

    // A web session exists (platform access or not). Native protocol 2
    // listens for this — wallet provisioning and the node work
    // for waiting-room users too (apps are usable without platform
    // access; only the SV social/build surfaces are gated).
    document.dispatchEvent(new CustomEvent('sv:session', {
      detail: { user: App.user },
    }));

    // Platform-access gate (onboarding flow alignment): a released
    // session boots the full shell; an unreleased one gets the waiting
    // room, which re-calls enterAuthed once /api/auth/me reports access.
    // `=== false` on purpose — an older cached /me without the field
    // must not lock anyone out.
    if (App.user?.hasPlatformAccess === false && window.AuthScreens) {
      AuthScreens.showWaiting();
      return;
    }

    if (App._authedBooted) {
      App.restoreFromHash();
      return;
    }
    App._authedBooted = true;

    if (window.AuthScreens) AuthScreens.hideAll();

    // Header admin/moderation icon — revealed for admins (full or
    // view-only) once App.user is resolved. bindEvents already ran, so
    // the click handler is attached before the button can be seen.
    App.renderAdminButton();
    // On a snapshot-derived boot every one of these is a guaranteed
    // failure: the socket can't open and the budget endpoints can't
    // answer. _reconcileSession runs them the moment the network is back.
    if (!App._sessionFromSnapshot) App.connectEvents();
    App.loadVersion();
    // Header kudos budget badge polls /api/me/kudos-budget once at
    // load and then on a long interval (hourly safety-net for the
    // Monday-UTC rollover). Refreshes opportunistically on every
    // successful give + on the leaderboard screen mount.
    if (!App._sessionFromSnapshot && window.Kudos?.Budget?.init) Kudos.Budget.init();
    // AI-credit status row (#555), same boot shape as the kudos badge:
    // the viewer's own daily allowance. Refreshes again on every drawer
    // open (App.HeaderMenu.open), throttled inside the module.
    if (!App._sessionFromSnapshot && window.AiCredit?.Budget?.init) AiCredit.Budget.init();
    // #1038: seed the live session-state store and arm its adaptive
    // reconcile tick. Same snapshot-boot guard as the meters above — the
    // endpoint is session-gated, so firing it on an offline snapshot boot is
    // a guaranteed 401.
    if (!App._sessionFromSnapshot && window.SessionState) SessionState.start();
    // Session-gated boot fetches (notifications bell, work drawer)
    // defer to this event instead of firing a guaranteed 401 on an
    // anonymous document load.
    document.dispatchEvent(new CustomEvent('sv:authed', {
      detail: { user: App.user },
    }));
    App.restoreFromHash();
    // The fragment-scoped `?shot=` states, applied for whatever fragment is
    // live now and re-applied whenever it changes — see _applyRouteShots.
    App._applyRouteShots();
    // The four that DRIVE something instead of painting a state stay
    // once-per-document: _applyMenuNavShot clicks a drawer row and
    // _applySettingsBackShot assigns a hash and traverses back out of it, so
    // re-running either on the hashchange it just caused would loop, and
    // _applyNotifPermissionsShot / _applyTermsConsentShot /
    // _applyAppPermissionShot present overlays that would stack.
    App._applySettingsBackShot();
    App._applyNotifPermissionsShot();
    App._applyTermsConsentShot();
    App._applyAppPermissionShot();
    // #1054: a verified session is the first moment a queued submit can
    // actually be filed — /api/feedback is session-gated, so flushing any
    // earlier would only burn 401s. Everything after this is event- and
    // timer-driven inside public/js/feedback-queue.js.
    if (window.FeedbackQueue) FeedbackQueue.flush('signin');

    // Promote a snapshot-derived shell to a verified session as soon as
    // the connectivity probe reports we're back.
    window.addEventListener('usernode:offline-change', (e) => {
      if (e.detail && e.detail.offline === false) App._reconcileSession();
    });

    // The service worker answered a slow /api/* from cache and the real
    // answer has now landed disagreeing with it (see _onApiUpdated).
    window.addEventListener('usernode:api-updated', App._onApiUpdated);

    // Re-poll the platform version every 10s so the drawer's platform
    // row flips to its "deploying" state within seconds of a deploy
    // signaling start, and to "stale" (a tappable reload) once a new
    // build is live and this tab is behind it. Cheap endpoint — just
    // reads one tiny file off disk on the server. The live SHA also
    // arrives pushed on /ws/events (`platform_version`, #2545), which is
    // what usually gets there first; this poll is what carries a tab whose
    // socket is down, and everything the message does not say.
    setInterval(App.loadVersion, 10_000);
  },

  // Admin / moderation console entry point (#588). Was a header shield
  // icon until the header slim-down moved it into the slide-out drawer as
  // #drawer-row-admin (below Settings). The function keeps its name and
  // its gate — only the element it reveals changed.
  //
  // Gate: `App.user.isAdmin`, which is true for BOTH full platform
  // admins and view-only admins (`admin_readonly`); see
  // middleware/auth.js, where `isAdmin` is the read/visibility flag and
  // `canAdminWrite` is the narrower full-admin mutation gate. A
  // moderation console is a *viewing* surface, so `isAdmin` is the right
  // flag and `canAdminWrite` would wrongly exclude view-only admins.
  // Regular users never see the row. Nothing here consults
  // USERNODE_ENV — the row exists identically in staging and prod.
  //
  // The "View as non-admin" preview reloads the page after masking
  // `App.user.isAdmin` (see settings.js), so this boot-time read is all
  // that's needed to make the row disappear in preview mode too.
  // The fragment this ran for last, so a repeat dispatch for the same
  // address is a no-op (one history traversal fires popstate AND
  // hashchange, so the router runs twice in a tick — #1102).
  _shotHash: null,

  // #1146: `?shot=` states are a property of the ADDRESS, not of the
  // document load. These three used to be applied exactly once, from the
  // boot path, which is correct only when a document is ever looked at on
  // one fragment. The grouped capture runner reaches a document's other
  // cohorts by writing location.hash, and a check pointed at
  // `/?shot=feedback#leaderboard` after one pointed at `/?shot=feedback`
  // would find no dialog. Re-applying on every real fragment change makes
  // the hash switch render what a cold load at that fragment renders.
  //
  // Only the state-PAINTING appliers belong here; see the note beside the
  // two navigation-driving ones in enterAuthed.
  _applyRouteShots() {
    if (!App.user) return;
    if (App._shotHash === location.hash) return;
    App._shotHash = location.hash;
    App._applyImproveShot();
    App._applyDevTerminalShot();
    App._applyPlatformUpdateShot();
    App._applyAppUpdateShot();
    App._applyLaunchShot();
    App._applyOfflineAppShot();
    App._applyFeedbackShot();
    App._applyAppContextShot();
  },

  // Screenshot-state deep link `?shot=improve`: open the Improve panel at
  // boot, so the surface THE UI OVERHAUL built — sessions, the dev links, the
  // repo and version rows — is reachable by URL for the before/after
  // screenshots, the "Test this change" button and the dapp.json checks. It is
  // only reachable by TAPPING the header button otherwise, which no still
  // frame and no plain route can do.
  //
  // Deliberately NOT env-gated, for exactly the reason ?shot=improve is not: pure
  // UI state with no writes, and an IS_STAGING-only link would starve the
  // production "before" shot forever while an ungated one starts working the
  // moment it ships. Pair it with ?demo=1 in staging so the session sections
  // have mock rows to render.
  //
  // It WAITS FOR A TARGET rather than firing on a fixed delay. Without one the
  // panel refuses to open — correct behaviour, not something to work around —
  // and on an /app/<slug> route the target is published by
  // App.ImproveStatus.setAppOpen(), which runs after openApp()'s fetch has
  // landed. A single 50ms tick (what ?shot=improve can afford, because the panel
  // needs nothing but a settled shell) fired long before that, so the panel
  // stayed shut and both of its declared checks failed on an empty surface.
  //
  // Polls instead, on the checks runner's own budget: an app route gets as
  // long as its fetch needs. Bounded, so a route with no target at all — home
  // included, which publishes none since the Improve button left that screen —
  // stops trying rather than spinning for the life of the page. (A bare
  // `/?shot=improve` therefore never opens the panel; its remaining dapp.json
  // check asserts panel MARKUP that renders closed, not an open surface.)
  IMPROVE_SHOT_TRIES: 40,
  IMPROVE_SHOT_INTERVAL_MS: 100,

  // `?shot=app-context`: open the APPS SWITCHER sheet at boot — the surface
  // behind the header's "app name ⌄" tab (Streamlined Concept). Same
  // wait-for-a-target poll as ?shot=improve below, and for the same reason:
  // the sheet refuses to open until an app target is published. (The app's own
  // views and changes are the IMPROVE PANEL now — see ?shot=improve.)
  _applyAppContextShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'app-context') return;
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      try {
        window.AppContext?.open();
        const panel = document.getElementById('apps-switcher-sheet');
        if (panel && panel.hasAttribute('data-open')) return;
      } catch (err) { /* ignore */ }
      if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
    };
    setTimeout(attempt, 50);
  },

  // Screenshot-state deep links `?shot=platform-updating` and
  // `?shot=platform-update-ready`: the two shapes of the "this tab is behind
  // a deploy" row, with the Improve panel open around them.
  //
  // Neither is otherwise reachable: both need the platform to have deployed
  // SINCE this document loaded, which no route and no still frame can
  // arrange. That is precisely the state the reload button exists for and the
  // one nobody could look at — which is how it shipped for so long doing the
  // wrong thing.
  //
  // Pure paint: this fakes the two client-side fields the row reads and
  // repaints it. No fetch, no worker message, nothing written — ungated for
  // the same reason as ?shot=improve above. It reuses that applier by
  // running the same open loop, because the row lives inside the panel.
  _applyPlatformUpdateShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'platform-updating' && shot !== 'platform-update-ready') return;
    const ready = shot === 'platform-update-ready';
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      try {
        window.Improve?.open();
        const panel = document.getElementById('improve-panel');
        if (panel && panel.hasAttribute('data-open')) {
          // A boot baseline that differs from what the row is handed is the
          // whole of `isStale`; the prefetch state is what picks the shape.
          App.loadedPlatformSha = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
          const sha = '1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
          App.shellUpdate = { sha, state: ready ? 'ready' : 'fetching' };
          const info = { sha, repoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
          App._lastVersionInfo = info;
          // The 10s poll would repaint this row out from under the shot with
          // the real answer, which for a local or staging build is `dev` — an
          // entirely different branch. Pin the row for as long as the shot is
          // on screen; nothing else reads this flag.
          App._platformUpdateShot = true;
          App.renderPlatformVersionPill(info);
          return;
        }
      } catch (err) { /* ignore */ }
      if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
    };
    setTimeout(attempt, 50);
  },

  // Screenshot-state deep links `?shot=app-updating` and
  // `?shot=app-update-ready`: the Improve button and panel as they look while
  // the open app's own build rolls out, and once it has landed. Store writes
  // only, the same two publishes handleAppRedeployStatus makes on the real
  // broadcasts, so nothing is fetched and nothing is rebuilt. Same open loop
  // as ?shot=improve, because the row lives inside the panel.
  _applyAppUpdateShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'app-updating' && shot !== 'app-update-ready') return;
    const ready = shot === 'app-update-ready';
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      try {
        window.Improve?.open();
        const panel = document.getElementById('improve-panel');
        if (panel && panel.hasAttribute('data-open')) {
          window.Improve.update({ deploying: !ready, appUpdateReady: ready });
          return;
        }
      } catch (err) { /* ignore */ }
      if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
    };
    setTimeout(attempt, 50);
  },

  _applyImproveShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'improve') return;
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      try {
        window.Improve?.open();
        // open() is a no-op without a target, so the panel's own state is
        // what says whether it took.
        const panel = document.getElementById('improve-panel');
        if (panel && panel.hasAttribute('data-open')) return;
      } catch (err) { /* ignore */ }
      if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
    };
    setTimeout(attempt, 50);
  },

  // Screenshot-state deep links `?shot=dev-terminal` and
  // `?shot=dev-terminal-open`: the Improve panel with its "Developer
  // terminal" row showing, and the same row already actioned.
  //
  // Neither state is otherwise reachable by a URL. The row is conditional on
  // DevConsole's own visibility signal — an app iframe on screen, plus either
  // "always show" in Settings or an error already forwarded from that frame —
  // so a plain route renders the panel WITHOUT it, and what the row does when
  // pressed is behind a tap that no still frame and no declared check can
  // perform. #1967 shipped a row that did nothing for exactly as long as that
  // was true, so the fix is locked in by a link rather than by a screenshot.
  //
  // No server state: the availability signal is published into DevConsole's
  // own in-memory state and the console renders from the buffer it already
  // has. Nothing is fetched and no row is written, so this is deliberately
  // NOT env-gated — same reasoning as ?shot=improve above, and the "before"
  // shot needs it to work in production too. The one thing it does persist is
  // the viewer's own "always show dev console" preference, which setMode()
  // stores: that is the same switch Settings flips, it is what makes the row
  // exist at all, and it is undone from Settings like any other.
  _applyDevTerminalShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'dev-terminal' && shot !== 'dev-terminal-open') return;
    const openIt = shot === 'dev-terminal-open';
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      try {
        // Stand in for the app frame that normally publishes this. All three
        // calls are needed: _refreshButtonVisibility() shows the row only when
        // there is an app slug AND an iframe on screen AND one of
        // always-mode / a logged error / an already-open panel. A fresh
        // browser has no localStorage and no errors, so without the mode call
        // the row is correctly absent and the link would capture a panel with
        // nothing in it to press.
        const slug = App.currentApp;
        if (slug && window.DevConsole) {
          window.DevConsole.setCurrentApp(slug);
          window.DevConsole.setButtonVisible(true);
          window.DevConsole.setMode(window.DevConsole.MODE_ALWAYS);
        }
        window.Improve?.open();
        const panel = document.getElementById('improve-panel');
        const row = document.getElementById('improve-row-terminal');
        if (panel && panel.hasAttribute('data-open') && row) {
          // The panel closes on the way, so the row has to be pressed once
          // and only once — a repeat would reopen nothing and re-hide this.
          if (openIt) row.click();
          return;
        }
      } catch (err) { /* ignore */ }
      if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
    };
    setTimeout(attempt, 50);
  },


  // Screenshot-state deep link `?shot=safe-bottom`: paint the whole shell
  // as if it were on a notched phone, so the safe-area treatment is
  // REVIEWABLE. No desktop browser reports a bottom inset and Chrome's
  // device emulation doesn't synthesise one, so without this every
  // before/after capture and every manual check of the home-indicator
  // clearance renders with zero insets — i.e. shows nothing.
  //
  // It writes the KIT's two custom properties rather than our own
  // --platform-safe-* tokens, and that is the whole trick: our tokens are
  // defined as `var(--un-safe-inset-X, env(...))`, so setting the kit
  // property drives the platform utilities AND every `.un-safe-*` kit
  // class (the header included) from one place — the shell shifts as a
  // whole instead of insets appearing in a few places and not others.
  //
  // Pure paint state — nothing is written and no layout code branches on
  // it — so it is deliberately NOT env-gated (same reasoning as
  // ?shot=improve above). It also cannot lie to an app frame: the insets
  // forwarded over the safe-area bridge are read from the hidden
  // env()-valued probe element (AppView._readRootInsets), never from
  // these properties, so an embedded app still receives its real ones.
  //
  // 47/34 are the iPhone 14/15-class status-bar and home-indicator
  // insets in portrait — the frame the captures use (390x844).
  SAFE_AREA_SHOT_INSETS: { top: '47px', bottom: '34px' },

  //
  // IT IS ALSO ITS OWN PARAM, `?safe-bottom=1`, AND THAT IS THE USEFUL ONE.
  // `shot` holds a single value — every reader is an equality test against
  // `.get('shot')` — so `?shot=safe-bottom` cannot be combined with the shot
  // that opens the surface you want to look at. That is fine for a screen a
  // plain route reaches, and useless for the ones that need BOTH: the app
  // menu, the Improve panel and notifications only reserve the home-indicator
  // strip once they are open, so `?shot=app-context` alone renders them with
  // zero insets — i.e. shows nothing of the thing being reviewed.
  //
  // A second param rather than a comma list because these are two different
  // kinds of thing: `shot` SELECTS a state (one at a time, by construction),
  // this PAINTS the device the state is drawn on (composes with any of them).
  // `?un-native-webview=1` above is the same shape for the same reason, and
  // teaching twenty equality tests to split a list would be a much larger
  // change than the one this exists to make reviewable.
  _applySafeAreaShot() {
    let on = false;
    try {
      const qs = new URLSearchParams(location.search);
      on = qs.get('shot') === 'safe-bottom' || qs.get('safe-bottom') === '1';
    } catch (err) { /* ignore */ }
    if (!on) return;
    try {
      const root = document.documentElement;
      root.style.setProperty('--un-safe-inset-top', App.SAFE_AREA_SHOT_INSETS.top);
      root.style.setProperty('--un-safe-inset-bottom', App.SAFE_AREA_SHOT_INSETS.bottom);
    } catch (err) { /* ignore */ }
  },


  // Screenshot-state deep link `?shot=settings-back` (#1102): drill into a
  // settings section and then traverse history BACK out of it, which is the
  // one dispatch shape that produced the two-copies transition — a traversal
  // fires popstate AND hashchange, so restoreFromHash runs twice in one tick
  // and Settings.route() is called twice with the same target. The defect
  // lived entirely inside the ~250-420ms the animation lasts, which no still
  // frame and no plain route can reach; the dapp.json check asserts the
  // resulting state instead (#settings-screen carrying
  // data-settings-route="skipped" — i.e. the duplicate did NOT repaint —
  // with the destination section still correct).
  //
  // Ungated for the same reason as ?shot=improve above: pure UI state, no
  // writes, and an env-gated link would starve the production "before" shot
  // forever. Same timing budget as the other appliers (well inside the checks
  // runner's 500ms settle), and it drives the real hash → restoreFromHash →
  // navigateToSettings path rather than calling the router directly.
  _applySettingsBackShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'settings-back') return;
    setTimeout(() => {
      // A drill-in: one dispatch (a hash assignment fires hashchange only).
      try { location.hash = '#settings/password'; } catch (err) { /* ignore */ }
      // Then back out of it once that push has settled — the traversal, and
      // with it the duplicate popstate + hashchange pair.
      setTimeout(() => {
        try { history.back(); } catch (err) { /* ignore */ }
      }, 200);
    }, 50);
  },

  // Screenshot-state deep link `?shot=notif-permissions`: present the real
  // device-permissions sheet — the one whose primary button is literally
  // "Allow notifications" — and then fire the trailing ghost click a touch
  // tap leaves behind on the backdrop a few hundred milliseconds later.
  //
  // Before the kit's backdrop guard (decideBackdropDismiss in
  // public/usernode-native/v1/native.js) that click dismissed the sheet the
  // same tap had just opened: it rose from the bottom for a fraction of a
  // second and then there was nothing left to tap to grant. The defect
  // lived entirely inside those few hundred milliseconds, which no still
  // frame and no plain route can reach, so the dapp.json check asserts the
  // resulting state instead — the sheet still present, carrying the
  // data-un-ghost-click marker that proves the click was really delivered
  // (without it the check would pass on a sheet nothing ever tried to
  // close).
  //
  // The sheet renders from a fixed "nothing granted yet" snapshot and calls
  // no bridge method, so this is pure UI state with no writes — ungated for
  // the same reason as the other appliers above, and on the same timing budget
  // (well inside the checks runner's 500ms settle).
  _applyNotifPermissionsShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'notif-permissions') return;
    // Retried for the same reason the feedback shot above is: this used to
    // give up silently the moment NativeChrome had not wired up yet, and the
    // optimistic boot moved this tick ~250ms earlier relative to it.
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      if (!window.NativeChrome ||
          typeof NativeChrome.presentPermissionsSheet !== 'function') {
        if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
        return;
      }
      const sheet = NativeChrome.presentPermissionsSheet({
        perms: { platform: 'ios', exactAlarmGranted: false },
        isAndroid: false,
      });
      // Present refused (the kit is there but not ready to show one yet):
      // also worth another go rather than ending the shot.
      if (!sheet) {
        if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
        return;
      }
      // The kit appends the backdrop and sheet, and wires the dismiss guard,
      // before returning this handle. Dispatch immediately: a bare click with
      // no pointerdown is the real ghost shape, and scheduling it would make
      // this a test of a throttled browser clock instead of the guard.
      const backdrop = document.querySelector('.un-backdrop');
      if (!backdrop) return;
      backdrop.click();
      if (sheet.el) sheet.el.setAttribute('data-un-ghost-click', 'dispatched');
    };
    setTimeout(attempt, 50);
  },

  // Screenshot-state deep link `?shot=app-permission` (#2219): present the
  // platform's app-permission prompt — the dialog an embedded app opens by
  // calling usernode.requestPermission().
  //
  // It needs a link because there is no other way to reach it. The real
  // prompt appears only when a running app in the frame asks for a gated
  // capability it has declared and this user has not answered for yet: three
  // conditions no URL can arrange, and the first of them needs a deployed app
  // that actually calls the bridge. So the before/after captures would show
  // the app screen instead of the thing the change is about.
  //
  // Renders from a fixed snapshot, calls no bridge method and writes nothing
  // (the POST that stores a grant happens on Allow, which nothing here
  // presses), so it is pure UI state — ungated for the same reason as
  // ?shot=notif-permissions above, and on the same retry budget, because
  // `AppView._reactDevBoard()` may not have wired up on the first tick.
  _applyAppPermissionShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'app-permission') return;
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      if (!window.AppView || typeof AppView.showPermissionConsentModal !== 'function'
          || !AppView._reactDevBoard()) {
        if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
        return;
      }
      // Not awaited: the shot leaves the dialog standing for the camera. It
      // resolves if somebody dismisses it, and its answer goes nowhere.
      AppView.showPermissionConsentModal({
        appName: 'Staging demo app',
        capability: 'microphone',
        label: 'Microphone',
        blurb: 'record audio from your microphone',
        reason: 'Records your voice notes',
        needsReload: true,
        surfaced: false,
      });
    };
    setTimeout(attempt, 50);
  },

  // Screenshot-state deep links `?shot=terms-consent` (issue #1297) and
  // `?shot=terms-consent-blocking` (issue #1328): present the first-run
  // terms UI — Accept / Decline framing included — from a fixed inline
  // payload. The blocking variant renders the native app's non-dismissible
  // modal, which is otherwise derived from the bridge's isNative flag and
  // so has no other URL-reachable state. The real prompt only ever appears
  // to a signed-in user whose consent row for the current published version
  // is null, a state the staging seed deliberately erases for every cloned
  // account (src/db/migrate.js records blanket accepted consents so the
  // auto-prompt can't slide over unrelated preview screenshots), so these
  // links are the only URL-reachable ways to see the ask. Passing `payload`
  // skips the fetch and no button is pressed, so both are pure UI state
  // with no writes — ungated for the same reason as ?shot=notif-permissions
  // above. The trigger module
  // (frontend/src/features/settings/terms-first-run.js) skips any route
  // carrying a shot param, so the overlay presents exactly once here.
  _applyTermsConsentShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'terms-consent' && shot !== 'terms-consent-blocking') return;
    const blocking = shot === 'terms-consent-blocking';
    setTimeout(() => {
      if (!window.Settings || typeof Settings.showTermsSheet !== 'function') return;
      Settings.showTermsSheet(null, {
        firstRun: true,
        blocking,
        payload: {
          id: 900500,
          version: 'staging-demo-v1',
          title: 'Staging Demo Terms of Service',
          terms_link: 'https://staging-demo.example.invalid/terms',
          published_at: '2026-07-15T00:00:00.000Z',
          consent: { status: null, accepted: false, responded_at: null },
        },
      });
    }, 50);
  },

  // Screenshot-state deep link `?shot=app-launching` (#931): paint the app
  // launch surface — icon, name and spinner over the theme background —
  // which otherwise exists only for the few hundred milliseconds between a
  // tap and the app's first paint, and so was invisible to the before/after
  // screenshots and the dapp.json checks. Pure UI state, no app is loaded
  // behind it, not env-gated (same reasoning as ?shot=improve above).
  _applyLaunchShot() {
    let shot = null;
    let settled = false;
    try {
      const params = new URLSearchParams(location.search);
      shot = params.get('shot');
      settled = params.get('settle') === '1';
    } catch (err) { /* ignore */ }
    // #1945: `?shot=app-tone-dark` / `?shot=app-tone-light` — a running app
    // whose page is that tone, so the bar above it can be seen taking it.
    // Same synthetic frame as the settled launch below (no document loads),
    // with the page colour the app's bridge would have reported set by hand.
    if (shot === 'app-tone-dark' || shot === 'app-tone-light') {
      const tone = shot === 'app-tone-dark' ? 'dark' : 'light';
      setTimeout(() => {
        try { AppView.showAppToneShot(tone); } catch (err) { /* ignore */ }
      }, 50);
      return;
    }
    if (shot !== 'app-launching') return;
    // #2154: the paired settled state deliberately uses the SAME route as
    // the old loading fixture. On the base commit `settle=1` is ignored and
    // the spinner stays up; on this commit it synthesises the race (terminal
    // event first, stale detail response second) and shows the resulting live
    // frame. That makes the before/after capture observe the actual fix.
    if (settled) {
      setTimeout(() => {
        try { AppView.showSettledLaunchShot(); } catch (err) { /* ignore */ }
      }, 50);
      return;
    }
    // Wait (briefly, and bounded) for the home feed's app list to land, so
    // the cover shows a REAL app's icon and name rather than the stub —
    // Home.load's fetch is in flight while boot finishes. Paints regardless
    // once the budget is spent, which is what keeps the link working against
    // an empty checks database.
    let tries = 0;
    const paint = () => {
      // Bareword, not window.Home: home.js's `const Home` is a lexical
      // top-level binding, not a window property (see AppView._home).
      const ready = typeof Home !== 'undefined' && Array.isArray(Home._apps) && Home._apps.length;
      if (!ready && tries++ < 20) { setTimeout(paint, 50); return; }
      try { AppView.showLaunchCoverShot(); } catch (err) { /* ignore */ }
    };
    setTimeout(paint, 50);
  },

  // Screenshot-state deep links `?shot=feedback` / `?shot=feedback-spent`
  // (#964): open the Send Feedback dialog at boot. The dialog — and with it
  // the new "Put a kudos bounty on this" row — is reachable ONLY by tapping
  // the header speech-bubble or the Dev plus-menu, so without this link the
  // before/after screenshots, the "Test this change" button and the
  // dapp.json checks would all show the home feed instead of the change.
  //
  // `feedback-spent` additionally forces a client-side remaining:0 budget
  // BEFORE opening, so the greyed-out/exhausted state is reviewable without
  // writing kudos rows for a real cloned user (which the staging seed rules
  // forbid). That override is display-only: it never posts, and the server
  // remains the real allowance gate on submit.
  //
  // Pure UI state, no writes, deliberately NOT env-gated — same reasoning as
  // ?shot=improve above: an IS_STAGING-only link would starve the production
  // "before" shot forever.
  _applyFeedbackShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'feedback' && shot !== 'feedback-spent'
        && shot !== 'feedback-offline' && shot !== 'feedback-queued'
        && shot !== 'feedback-capture-failed'
        && shot !== 'feedback-required' && shot !== 'feedback-first') return;
    const spent = shot === 'feedback-spent';
    // #1054: the two offline variants. `feedback-offline` is the dialog as a
    // disconnected user meets it (the hint, and Submit reading "Save for
    // later"); `feedback-queued` adds one already-saved message, so the
    // waiting count and the header's violet dot are reviewable too. Both pin
    // connectivity with forceOffline() — the same device ?shot=offline uses
    // (#1021) — and the seeded entry lives in memory only, so nothing is
    // written to the device and nothing is ever filed.
    const offline = shot === 'feedback-offline' || shot === 'feedback-queued';
    const queued = shot === 'feedback-queued';
    // #1284: the dialog as a phone user meets it when "Take screenshot"
    // fails. Seeds a draft, then runs the controller's real capture round
    // trip with a capture that throws the way the native bridge does — so
    // what gets photographed is the retained text, the restored dialog and
    // the actual notice copy. Display-only: no bridge call, no upload, and
    // the draft is typed into the field, never stashed (the stash skips any
    // ?shot= route on purpose) and never filed.
    const captureFailed = shot === 'feedback-capture-failed';
    // #1603: the dialog after a submit with nothing in the description — the
    // state that used to be indistinguishable from a dead button. Clicks the
    // real Submit and photographs the real refusal; the controller returns
    // before any fetch, so this posts nothing either.
    const requiredError = shot === 'feedback-required';
    // ONCE PER DOCUMENT. _applyRouteShots dedupes on the hash, not on the
    // applier, so a fragment that changes after boot re-runs this one — and
    // this shot is not idempotent the way the others are. Its
    // ?shot=feedback-capture-failed branch drives a real capture round trip,
    // which SUSPENDS the dialog (hidden, draft cleared) and resumes it when
    // the attempt fails; two rounds interleaving leave it suspended, which
    // reads exactly like a dialog that closed itself. Both #1284 checks
    // photographed that state.
    if (App._feedbackShotApplied) return;
    App._feedbackShotApplied = true;
    // Seed and pin synchronously, BEFORE enterAuthed() reaches its
    // FeedbackQueue.flush('signin') call below. Delaying all of this with the
    // modal used to leave a 50 ms window where the real persisted queue could
    // start opening/flushing before seedDisplayOnly() swapped in the inert
    // memory store. The resulting race made the queued dot/offline class
    // depend on boot timing in proposal checks. Only presentation needs the
    // delay; the address-driven state does not.
    if (queued) {
      window.FeedbackQueue?.seedDisplayOnly?.([{
        payload: {
          description: 'Dragging a card scrolls the board back to the top.',
          target: 'platform',
        },
      }]);
    }
    if (shot === 'feedback-first') window.FeedbackQueue?.seedDisplayOnly?.([]);
    if (offline) {
      try { window.Offline?.forceOffline(); } catch (err) { /* ignore */ }
    }
    // One tick after restoreFromHash so the screen it navigated to has
    // painted and the dialog opens over a settled shell — and then RETRIES,
    // on the same budget as the Improve / app-context shots above.
    //
    // Waits for the ISLAND, not for App.openFeedbackModal.
    //
    // The function is published by feedback-controller.js's init(); the
    // island is registered separately, by useDialog('feedback') on hydration.
    // Between those two moments openFeedbackModal EXISTS and falls back to
    // the legacy open — and then the island hydrates, React reconciles
    // `hidden` back on, and the dialog it just opened is taken down again,
    // form reset. That is precisely what a failing check photographed: the
    // status line written, the modal closed, the draft gone.
    //
    // feedback-controller.js's own header already names the ordering this
    // depends on — "hydration normally publishes this AFTER /api/auth/me has
    // already run enterAuthed, and a slow bundle reverses it". The optimistic
    // boot removes that round trip, so the reversal is no longer the slow
    // case; on a loaded container it is the ordinary one. Waiting on the
    // island is the fix that does not care which way the race goes.
    let tries = App.IMPROVE_SHOT_TRIES;
    const attempt = () => {
      // The same lookup dialogController() makes (use-dialog.ts registers it).
      const island = window.UsernodeReact?.dialogs?.feedback;
      if (!island || typeof App.openFeedbackModal !== 'function') {
        if (--tries > 0) setTimeout(attempt, App.IMPROVE_SHOT_INTERVAL_MS);
        return;
      }
      try {
        if (spent && window.Kudos?.Budget) {
          const limit = Kudos.Budget.state?.limit || 20;
          // Pin the exhausted figure and stop the hourly poll from
          // replacing it mid-screenshot with the real (unspent) budget. The
          // flag also makes an initial refresh that is already in flight
          // discard its response instead of winning this race later.
          Kudos.Budget._displayOverride = true;
          Kudos.Budget.state = { given_this_week: limit, remaining: 0, limit };
          Kudos.Budget.refresh = () => Promise.resolve();
        }
        App.openFeedbackModal();
        if (shot === 'feedback-first') {
          let firstTries = App.IMPROVE_SHOT_TRIES;
          const showFirst = () => {
            const success = document.getElementById('feedback-first-success');
            if (success && !success.classList.contains('hidden')) return;
            App._simulateFirstFeedback?.();
            if (--firstTries > 0) setTimeout(showFirst, App.IMPROVE_SHOT_INTERVAL_MS);
          };
          setTimeout(showFirst, 50);
        }
        if (captureFailed) {
          const text = document.getElementById('feedback-text');
          // Assigned, not typed: dispatching `input` would start the live
          // title generation, and a display-only shot must not call the LLM.
          if (text) text.value = 'The board scrolls back to the top when I drag a card.';
          // One more tick so the dialog has settled (and its own open-time
          // resets have run) before the failing attempt starts — and then the
          // same retry the open above gets, for the same reason one level
          // down. runCapture suspends the dialog, awaits the attempt and
          // resumes it with the notice; fired once into a shell that is still
          // settling it can land before the dialog's own open-time reset,
          // which then wipes the status line it just wrote. What the check
          // asserts is the notice being VISIBLE, so that is what this waits
          // for rather than a fixed number of milliseconds.
          let capTries = App.IMPROVE_SHOT_TRIES;
          const runFailure = () => {
            const status = document.getElementById('feedback-status');
            if (status && !status.classList.contains('hidden')) return;
            try { App._simulateFeedbackCaptureFailure?.(); } catch (err) { /* ignore */ }
            if (--capTries > 0) setTimeout(runFailure, App.IMPROVE_SHOT_INTERVAL_MS);
          };
          setTimeout(runFailure, 50);
        }
        if (requiredError) {
          // Same retry shape, and for the same reason, as captureFailed
          // above: a submit fired into a shell that is still settling can
          // land before the dialog's own open-time reset, which then clears
          // the error this is trying to photograph. What the check asserts
          // is the message being VISIBLE, so that is what this waits for.
          // The hook is the controller's, like the capture one beside it —
          // it calls the shipped submitFeedback, which keeps the dialog's
          // own ids and internals out of this file.
          let reqTries = App.IMPROVE_SHOT_TRIES;
          const runEmptySubmit = () => {
            const err = document.getElementById('feedback-text-error');
            if (err && !err.classList.contains('hidden')) return;
            try { App._simulateEmptyFeedbackSubmit?.(); } catch (e) { /* ignore */ }
            if (--reqTries > 0) setTimeout(runEmptySubmit, App.IMPROVE_SHOT_INTERVAL_MS);
          };
          setTimeout(runEmptySubmit, 50);
        }
      } catch (err) { /* ignore */ }
    };
    setTimeout(attempt, 50);
  },

  renderAdminButton() {
    // Was a classList write on #drawer-row-admin, which was always in the DOM
    // because the drawer was. The row is the Profile screen's account group
    // now (features/profile/account-panel.tsx) — rendered only once profile
    // data lands — so an id lookup at boot finds nothing, and React would
    // re-render the class back the moment it did. PUBLISH instead: the
    // visibility store is the one sanctioned way to drive a converted
    // region's visibility from outside React, and the component subscribes.
    // The gate is unchanged.
    const isAdmin = !!App.user?.isAdmin;
    App.Visibility.publish('switcher-row-admin', isAdmin);
    // The admin console's twenty section modules are a lazy chunk now
    // (features/admin/sections.ts) — 421KB a non-admin never downloads. This
    // is the moment the viewer is known to BE one, so warm it at idle and the
    // first open is as instant as it was when everybody paid for it.
    // prefetchSections itself declines on a ?shot= / ?demo= route.
    if (isAdmin) {
      try { window.AdminConsole?.prefetchSections?.(); } catch (err) { /* opens on demand anyway */ }
    }
  },

  // Navigate to the full-page admin console (#818): the #admin hash route
  // drives everything — restoreFromHash lands on navigateToAdminConsole,
  // which mounts #admin-screen and hands rendering to AdminConsole
  // (public/js/admin-console.js). The isAdmin re-check keeps a
  // programmatic call from navigating. The drawer row is a real anchor
  // (its href IS the navigation, matching Settings/Challenges/Profile),
  // so this stays the *programmatic* entry point rather than a click
  // handler; the route's own gate inside navigateToAdminConsole is the
  // client-side boundary, and every /api/admin/* is enforced server-side.
  openAdminConsole() {
    if (!App.user?.isAdmin) return;
    location.hash = '#admin';
  },

  // The SHA the currently-loaded client JS was shipped with, so later polls
  // can surface a "platform updated, reload to use new features" hint when the
  // running platform has moved on but this tab hasn't.
  //
  // Read from the DOCUMENT (see documentPlatformSha above), because the
  // document is the thing whose age is in question. Null outside a deploy —
  // and only then does loadVersion's first-poll capture below fill it in.
  loadedPlatformSha: documentPlatformSha(),

  // ── The update the reload button is offering ──────────────────────────
  //
  // `{ sha, state }`, where state is 'fetching' | 'ready' | 'failed' —
  // or 'retry', a fetch answered by the build being replaced (the seconds of
  // a rollout in which both serve), which the next poll or push asks again
  // rather than treats as the update having failed.
  //
  // The button used to appear the instant /api/version reported a new SHA,
  // and clicking it ran `location.reload()` — an ordinary navigation, which
  // the service worker races against the cached document on a deadline it
  // documents as shorter than a round trip. Losing that race is the DESIGNED
  // case, and losing it served the old document, latched
  // shellFromCacheThisLoad, and therefore served all ~38 old assets too,
  // while the new build landed in the cache for next time. The button
  // downloaded the update instead of switching to it.
  //
  // It was worse than a no-op, because the tab then went quiet about it:
  // `loadedPlatformSha` used to be captured from the FIRST /api/version
  // answer each document saw, so the reloaded-but-still-old document recorded
  // the NEW sha as its own baseline, `isStale` went false and the pill
  // stopped offering anything. The reload looked like it had worked. (That
  // half is fixed at its root now — the baseline is read from the document's
  // own `<meta name="platform-build">`, so a document that did not come from
  // the network can no longer mistake the server's sha for its own.)
  //
  // So the new build is pulled into the shell cache first (see
  // public/sw.js's `prefetch-shell`), and only then is a reload offered. Once
  // the cache holds it, WHO WINS THE RACE STOPS MATTERING: network and cache
  // both answer with the new build.
  shellUpdate: null,

  // A stale document discovered by the FIRST /api/version answer is a cold
  // boot from the shell cache, not a tab that has been open across a deploy.
  // Once its complete replacement is prefetched, switch to it automatically
  // if doing so cannot discard input. The per-SHA session latch is the second
  // guard: if a browser somehow serves the old document again, it gets the
  // visible reload offer instead of entering a reload loop.
  _shellAutoReloadSha: null,
  _shellReloadStarted: null,
  SHELL_AUTO_RELOAD_KEY: 'usernode-shell-auto-reload',

  _hasUnsavedShellInput() {
    let controls = [];
    try {
      controls = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
    } catch { return true; }
    for (const control of controls) {
      if (!control || control.disabled) continue;
      if (control.isContentEditable) {
        if (String(control.textContent || '').trim()) return true;
        continue;
      }
      const tag = String(control.tagName || '').toUpperCase();
      const type = String(control.type || '').toLowerCase();
      if (tag === 'INPUT' && ['button', 'submit', 'reset', 'hidden', 'image'].includes(type)) {
        continue;
      }
      if (tag === 'INPUT' && type === 'file') {
        if (control.files && control.files.length) return true;
        continue;
      }
      if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
        if (!!control.checked !== !!control.defaultChecked) return true;
        continue;
      }
      if (tag === 'SELECT') {
        if (Array.from(control.options || [])
          .some((option) => !!option.selected !== !!option.defaultSelected)) return true;
        continue;
      }
      if (String(control.value || '') !== String(control.defaultValue || '')) return true;
    }
    return false;
  },

  _reloadPrefetchedShellIfSafe(sha, { force = false } = {}) {
    if (!sha || App._shellReloadStarted) return false;
    if (!force && App._shellAutoReloadSha !== sha) return false;
    if (!force && App._hasUnsavedShellInput()) {
      App._shellAutoReloadSha = null;
      return false;
    }
    if (!force) {
      try {
        if (sessionStorage.getItem(App.SHELL_AUTO_RELOAD_KEY) === sha) {
          App._shellAutoReloadSha = null;
          return false;
        }
        sessionStorage.setItem(App.SHELL_AUTO_RELOAD_KEY, sha);
      } catch {
        // Without a cross-reload latch we cannot prove this will not loop.
        App._shellAutoReloadSha = null;
        return false;
      }
    }
    App._shellReloadStarted = sha;
    location.reload();
    return true;
  },

  /**
   * Ask the worker for the build at `sha`, once.
   *
   * Idempotent per SHA — renderPlatformVersionPill calls this from the stale
   * branch, which runs on every 10s poll for as long as the tab stays behind.
   *
   * Returns a promise that resolves with the settled state ('ready' or
   * 'failed') and NEVER rejects. The pill ignores it and repaints from
   * `App.shellUpdate` instead, because it is already on a timer; pull-to-
   * refresh awaits it, because a pull has one moment to get this right and
   * reloading before the cache holds the new build is the exact mistake this
   * whole machine was built to stop. It is bounded by the same
   * SHELL_PREFETCH_TIMEOUT_MS bail-out below, so awaiting it cannot hang a
   * gesture.
   */
  _ensureShellPrefetch(sha) {
    if (!sha) return Promise.resolve('failed');
    if (App.shellUpdate && App.shellUpdate.sha === sha && App.shellUpdate.state !== 'retry') {
      // Already asked for this build. Hand back the in-flight promise so a
      // second caller waits on the same download rather than starting one.
      return App._shellPrefetchSettled && App._shellPrefetchSettled.sha === sha
        ? App._shellPrefetchSettled.promise
        : Promise.resolve(App.shellUpdate.state);
    }
    // This attempt, by identity: a settle belongs to the ask that made it, and
    // is one-way because settling replaces the object. Two asks for one build
    // can be alive at once — a 'retry' re-ask under the previous attempt's
    // still-pending bail-out timer — and that timer must not fail the new
    // download when it fires.
    const attempt = { sha, state: 'fetching' };
    App.shellUpdate = attempt;

    let resolveSettled;
    const promise = new Promise((resolve) => { resolveSettled = resolve; });
    App._shellPrefetchSettled = { sha, promise };

    const settle = (state) => {
      if (App.shellUpdate !== attempt) return;
      App.shellUpdate = { sha, state };
      // 'retry' is 'failed' to anyone awaiting this download — a pull reloads
      // either way — and an open question only to the next poll or push,
      // which asks again. That cadence bounds the retries; nothing here does:
      // the row already says "updating…", and repainting it would run the
      // stale branch, which re-asks, which is the loop this must not be.
      resolveSettled(state === 'retry' ? 'failed' : state);
      if (state === 'retry') return;
      // Repaint from the last answer rather than re-polling: the pill is the
      // only thing this changes, and /api/version is already on a 10s timer.
      if (App._lastVersionInfo) App.renderPlatformVersionPill(App._lastVersionInfo);
      if (state === 'ready') App._reloadPrefetchedShellIfSafe(sha);
    };

    const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!controller) {
      // No worker driving this document — an unsupported context, or the
      // very first load before the registration claims it. Nothing is
      // serving a cached build either, so a reload already goes to the
      // network: offer it immediately rather than waiting for a reply that
      // is never coming.
      App.shellUpdate = { sha, state: 'ready' };
      resolveSettled('ready');
      return promise;
    }

    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const reply = event.data || {};
        if (reply.sha !== sha) return settle('failed');
        if (reply.ok) return settle('ready');
        // Answered by the build being replaced, not the one asked for: the
        // request landed on the old pod in the seconds a rollout has both
        // serving (the worker gives up on the document, one request, before
        // touching an asset). The update has not failed; it has not arrived
        // where this request went. Ask again on the next cue.
        settle(reply.mismatch ? 'retry' : 'failed');
      };
      controller.postMessage({ type: 'prefetch-shell', sha }, [channel.port2]);
    } catch {
      settle('failed');
      return promise;
    }
    // A worker that never answers — killed mid-fetch, or a browser that
    // dropped the port — must not leave the row saying "updating…" forever.
    // 'failed' still OFFERS the reload: it may serve the old build, which is
    // exactly today's behaviour and strictly better than no way back.
    setTimeout(() => settle('failed'), App.SHELL_PREFETCH_TIMEOUT_MS);
    return promise;
  },

  /** `{ sha, promise }` for the prefetch in flight — see _ensureShellPrefetch. */
  _shellPrefetchSettled: null,

  // Generous on purpose: this is a full re-download of the shell on whatever
  // connection the tab has, and the only cost of waiting is that the reload
  // button appears a few seconds later than the SHA changed.
  SHELL_PREFETCH_TIMEOUT_MS: 30_000,

  /** The last /api/version answer, so a prefetch reply can repaint the row. */
  _lastVersionInfo: null,

  async loadVersion() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const info = await res.json();
      const firstVersionAnswer = !App._lastVersionInfo;
      if (!App.loadedPlatformSha && info.sha && info.sha !== 'dev') {
        App.loadedPlatformSha = info.sha;
      }
      if (firstVersionAnswer
          && info.sha && info.sha !== 'dev'
          && App.loadedPlatformSha && info.sha !== App.loadedPlatformSha
          && !(info.deployProgress && info.deployProgress.deploying)) {
        App._shellAutoReloadSha = info.sha;
      }
      App._lastVersionInfo = info;
      // `?shot=platform-updating` / `-ready` pin the row to a state no real
      // answer can produce on demand; a poll landing on top would erase it.
      if (!App._platformUpdateShot) App.renderPlatformVersionPill(info);
    } catch {}
  },

  /**
   * The server said which build is live — `platform_version` on /ws/events,
   * sent on connect and pushed by a pod leaving a rollout (#2545). Same
   * conclusion the 10s poll reaches, up to 10s sooner: start the download
   * now, so the reload button is up — with the build already cached behind
   * it — by the time the user goes looking for it. Nothing here reloads;
   * the button is the only way forward, as it is for the poll.
   *
   * A word, not an answer: /api/version is trusted for everything else
   * (env, deployProgress, the boot latch). Before the first poll there is
   * nothing to compare against, so the message is left to the poll; a SHA
   * that is not news, or is 'dev', is nothing to do.
   */
  handlePlatformVersion(data) {
    const sha = data && data.sha;
    if (!sha || sha === 'dev') return;
    if (!App.loadedPlatformSha || !App._lastVersionInfo) return;
    if (sha === App.loadedPlatformSha) return;
    if (App._lastVersionInfo.sha === sha) return;
    // The poll's shape, with the pushed SHA: a pod announcing its successor
    // knows it as live, whatever /api/version last said about a rollout in
    // progress (the row shows "updating…" for a deploying answer without
    // asking for the build, and this is the one moment that deferral is
    // wrong: the download is exactly what should start).
    App._lastVersionInfo = { ...App._lastVersionInfo, sha, deployProgress: null };
    if (!App._platformUpdateShot) App.renderPlatformVersionPill(App._lastVersionInfo);
  },

  // The SHA /api/version reports when it differs from the one this document
  // booted with — i.e. the platform redeployed and this tab is running stale
  // client code. Null when it hasn't. The SHA rather than a bare true because
  // the caller has to name the build it wants pulled into the shell cache
  // before it reloads onto it. Fail-closed (false) on any error: a flaky
  // network must never turn a data refresh into a reload loop.
  async platformMovedOn() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return false;
      const info = await res.json();
      if (!info.sha || info.sha === 'dev') return false;
      if (!App.loadedPlatformSha) {
        // No boot baseline. Since the document carries its own build id this
        // only happens outside a deploy (no GIT_SHA, so the meta reads `dev`)
        // — record what we see and treat this tab as current.
        App.loadedPlatformSha = info.sha;
        return false;
      }
      return info.sha !== App.loadedPlatformSha ? info.sha : null;
    } catch { return false; }
  },

  // Pull-to-refresh wrapper: run the screen's data refresh, and when the
  // platform has redeployed since this document loaded, upgrade it to a
  // full reload — pull-to-refresh means "get me the latest", and data
  // alone can't deliver new client code. The never-resolving promise
  // keeps the kit's spinner up until the reload tears the page down.
  //
  // The reload waits for the new build to be IN THE SHELL CACHE first, for
  // the reason _ensureShellPrefetch exists: `location.reload()` is an
  // ordinary navigation, public/sw.js races it against the cached document on
  // a deadline shorter than a round trip, and losing that race — the designed
  // case — serves the old build straight back and latches the whole load onto
  // it. The Improve drawer's reload button has held that line since #1468;
  // pull-to-refresh was the other door into the same reload and still went
  // through it unguarded, so on a phone (where the pull IS how people
  // refresh) the update quietly failed to arrive.
  //
  // Awaiting is safe: _ensureShellPrefetch always settles, within
  // SHELL_PREFETCH_TIMEOUT_MS at the latest, and 'failed' still reloads —
  // that is exactly the old behaviour, and a pull with no way forward would
  // be worse. The spinner stays up throughout, which is honest: the download
  // is what the pull is now waiting on.
  _refreshOrReload(refresh) {
    App._announceRefreshIntent();
    return Promise.all([
      Promise.resolve().then(refresh).catch(() => {}),
      App.platformMovedOn(),
    ]).then(([, movedOnSha]) => {
      if (!movedOnSha) return undefined;
      return App._ensureShellPrefetch(movedOnSha).then(() => {
        App._reloadPrefetchedShellIfSafe(movedOnSha, { force: true });
        return new Promise(() => {});
      });
    });
  },

  // Tell the worker this is a REFRESH, not a boot, before the screen's
  // loader runs.
  //
  // public/sw.js answers `/api/home-panels` and the other boot reads from
  // cache on a zero deadline, which is right for a first paint and wrong
  // here: a pull is somebody asking for the current state, and handing them
  // last visit's numbers is the one answer it must not give. The worker
  // already undoes it via `api-updated`, but that correction cannot fire
  // until the network answer arrives — so on a slow link, which is where
  // people pull, the stale frame is what they sit looking at.
  //
  // Fire-and-forget on purpose. A refresh must never wait on the worker, and
  // a message that lands late costs one lane-served request and nothing
  // else. Silent when there is no worker at all.
  _announceRefreshIntent() {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'refresh-intent' });
    } catch { /* no worker, or a browser that refuses the post */ }
  },

  // ── Late-arrival correction ─────────────────────────────────────────
  // The service worker now answers a slow GET /api/* from cache rather than
  // holding the screen (public/sw.js, API_TIMEOUT_MS), and posts
  // `api-updated` when the real answer finally lands and DISAGREES with the
  // copy it served. Without this handler that correction would sit in the
  // cache until the next reload, and a faster first paint would just mean
  // being wrong sooner.
  //
  // The worker only posts when it actually served stale bytes AND they
  // actually changed, so on a healthy connection none of this ever runs.
  _apiUpdateTimer: null,

  _onApiUpdated() {
    // Coalesce: one slow load can correct several endpoints a few ms apart,
    // and the screen's loader re-pulls all of them anyway.
    clearTimeout(App._apiUpdateTimer);
    App._apiUpdateTimer = setTimeout(App.refreshActiveScreen, 250);
  },

  // Re-run the visible screen's own loader — the same one pull-to-refresh
  // uses, so a correction can never diverge from a manual refresh.
  //
  // Bails when the tab is hidden or a sheet/drawer is presenting: a screen
  // re-rendering underneath an open surface (or scrolling out from under a
  // reader) is a worse failure than the stale row it would have fixed, and
  // the next navigation re-pulls anyway.
  refreshActiveScreen() {
    try {
      if (document.hidden) return;

      const visible = (id) => {
        const el = document.getElementById(id);
        return !!el && !el.classList.contains('hidden');
      };

      // The app record itself is in the service worker's zero-deadline boot
      // lane. If its cached `creating` snapshot is corrected after first
      // paint, revalidate the open App tab just as the branches below refresh
      // the Dev board and Home. WebSocket remains the fast path; this closes
      // the missed-event hole that otherwise leaves the placeholder forever.
      if (App.currentApp && App.currentTab === 'app'
          && window.AppView && AppView.appData?.status === 'creating'
          && AppView._watchCreatingStatus) {
        AppView._watchCreatingStatus(AppView.appData, { immediate: true });
        return;
      }

      if (App.currentApp && App.currentTab === 'dev'
          && window.AppView && AppView.refreshDevData) {
        AppView.refreshDevData('api-update');
        return;
      }
      if (visible('browse-screen') && window.Browse) { Browse._load(); return; }
      if (visible('leaderboard-screen')) { App._refreshLeaderboard(); return; }
      if (visible('home-screen') && window.Home) { Home.load(); }
    } catch (err) {
      /* a correction that throws is just a screen that stays as served */
    }
  },

  // The Leaderboard screen hosts three panes with three different loaders.
  // Extracted so pull-to-refresh and the late-arrival correction above
  // cannot drift apart.
  _refreshLeaderboard() {
    if (!window.Leaderboard) return Promise.resolve();
    if (Leaderboard.section === 'topochain') {
      if (!window.TopochainLeaderboard) return Promise.resolve();
      return TopochainLeaderboard.loadLeaderboard();
    }
    if (Leaderboard.section === 'challenges') {
      if (!window.TopochainChallenges) return Promise.resolve();
      return TopochainChallenges.loadChallenges();
    }
    Leaderboard._cache.clear();
    return Leaderboard._load();
  },

  // Four rendering states, all rendered as .drawer-ver text (see
  // public/css/app.css) with modifier classes for the dev / deploying /
  // stale variants. This is labelled "Platform version" in the drawer
  // (#1211): it identifies the deployed web build (a Git SHA), not the
  // installed Flutter mobile-app version.
  //
  // The slot moved out of the header (header slim-down) and then out of
  // the drawer's status pane into #drawer-footer, but kept its id
  // throughout — so every call site is unchanged, as is the trailing
  // refreshDeployDot(), which mirrors the
  // deploying state onto the hamburger (the only place a deploy is
  // visible now without opening the menu).
  renderPlatformVersionPill(info) {
    const slot = document.getElementById('platform-version-pill-slot');
    // Every path below ends by naming the update state and painting `slot`.
    //
    // THE STATE IS NAMED, NOT INFERRED. refreshDeployDot used to recover it by
    // querying `#improve-footer .drawer-ver--deploying` / `--stale`, i.e. by
    // reading back the classes this function had just written. That coupled
    // the Improve button's indicator to where the version rows happened to be
    // rendered, and the rows are in Settings now. This function already knows
    // the answer exactly — it is the one computing isDeploying/isStale and
    // reading App.shellUpdate — so it says so, and the pill is left as pure
    // presentation.
    //
    // It is also finer than the classes were: `--stale` covered both "the new
    // build is downloading" and "the new build is here", deliberately, so the
    // dot would not blink off mid-download. Those are different offers to make
    // (a note vs. a reload button), so they are different states, and the dot
    // simply treats both as the same colour.
    //
    // Published even when the slot is absent: the button's icon must not
    // depend on whether the Settings screen's markup happens to be in the
    // document.
    const paint = (html, state) => {
      App.platformUpdateState = state;
      if (slot) slot.innerHTML = html;
      App.ImproveStatus.refreshDeployDot();
    };

    const runningSha = info.sha;
    const repoUrl = info.repoUrl || '#';
    const deploy = info.deployProgress;
    const isDeploying = !!(deploy && deploy.deploying);
    const isStale = !isDeploying
      && App.loadedPlatformSha
      && runningSha
      && runningSha !== App.loadedPlatformSha
      && runningSha !== 'dev';

    // The project label ("usernode ·") used to prefix every state here.
    // It's gone: the row this renders into is LABELLED "Platform version" in the
    // drawer footer, so repeating the project name was pure redundancy —
    // and it was what pushed "usernode · 1a2b3c4" past the 15rem panel
    // and into truncation. Bare version only. (`info.name` is still
    // served by /api/version; nothing else reads it here.)
    if (!runningSha || runningSha === 'dev') {
      // No GIT_SHA. STAGING PREVIEWS OF THE PLATFORM ARE BUILT WITHOUT
      // ONE, so this is the state a PR tester actually sees — and a row
      // reading "Platform version  dev" told them nothing about which
      // build they were looking at. Name the environment instead when the
      // server reports one, and keep the literal "dev" for a local run
      // (and for a production build missing its SHA, where printing
      // "production" would imply a version we don't actually know).
      const staging = info.env === 'staging';
      const label = staging ? 'staging' : 'dev';
      const tip = staging
        ? 'Staging preview of the platform, built without a commit SHA, so there is no revision to link'
        : 'Running outside of a deploy (no GIT_SHA set)';
      paint(`
        <span class="drawer-ver drawer-ver--dev" title="${tip}">${label}</span>`, 'idle');
      return;
    }

    if (isDeploying) {
      const newShort = (deploy.sha || '').slice(0, 7);
      const oldShort = runningSha.slice(0, 7);
      const elapsed = deploy.startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(deploy.startedAt).getTime()) / 1000))
        : null;
      const tipParts = [`Deploying ${newShort || 'new build'}`];
      if (oldShort) tipParts.push(`from ${oldShort}`);
      if (elapsed != null) tipParts.push(`${elapsed}s elapsed`);
      const shaLabel = newShort ? `→ ${newShort}` : 'deploying';
      paint(`
        <span class="drawer-ver drawer-ver--deploying" title="${tipParts.join(' · ')}">
          <span class="drawer-ver-spinner" aria-hidden="true"></span>${shaLabel}
        </span>`, 'deploying');
      return;
    }

    if (isStale) {
      const oldShort = App.loadedPlatformSha.slice(0, 7);
      const newShort = runningSha.slice(0, 7);
      // Pull the new build down before offering to switch to it. Idempotent
      // per SHA (a 'retry' excepted: this is the re-ask), and this branch
      // runs on every 10s poll and every push while the tab is behind — see
      // _ensureShellPrefetch for why the reload was a lie without it.
      App._ensureShellPrefetch(runningSha);
      const update = App.shellUpdate;
      if (update && update.sha === runningSha
          && (update.state === 'fetching' || update.state === 'retry')) {
        // Downloading. NOT a button: a reload right now is the exact thing
        // that used to serve the old document back. The row still says the
        // platform has moved on, and still lights the Improve dot (the
        // `--stale` class is what refreshDeployDot selects), so nothing is
        // hidden — only the promise of a working reload is withheld until it
        // is one.
        paint(`
          <span class="drawer-ver drawer-ver--stale drawer-ver--fetching"
                title="Platform updated from ${oldShort} to ${newShort}. Downloading it now; the reload appears once there is something to switch to.">
            <span class="drawer-ver-spinner" aria-hidden="true"></span>${newShort} · updating…
          </span>`, 'downloading');
        return;
      }
      // 'ready' — the worker holds the new build, so a reload lands on it
      // whichever way the navigation race goes. Or 'failed', where the reload
      // may still serve the cached old build: that is exactly the behaviour
      // this row had before, and a tab with no way back would be worse.
      const failed = !!(update && update.state === 'failed');
      const tip = failed
        ? `Platform updated from ${oldShort} to ${newShort}. Click to reload (the update could not be pre-downloaded, so this may take two tries).`
        : `Platform updated from ${oldShort} to ${newShort}, and the new build is ready. Click to reload.`;
      paint(`
        <button type="button"
                class="drawer-ver drawer-ver--stale"
                title="${tip}"
                onclick="location.reload()">${newShort} · reload</button>`, failed ? 'failed' : 'ready');
      return;
    }

    const shortSha = runningSha.slice(0, 7);
    const href = `${repoUrl.replace(/\/$/, '')}/commit/${runningSha}`;
    paint(`
      <a href="${href}" target="_blank" rel="noopener" class="drawer-ver" title="Platform commit ${shortSha}">${shortSha}</a>`, 'idle');
  },

  // Tiny local HTML-escaper for server-sourced strings interpolated into
  // markup here. Kept on App rather than reaching into app-view.js's
  // helpers since those load conditionally / aren't guaranteed to be in
  // scope. (Its original caller — the project-name prefix on the platform
  // version pill — is gone; kept as the local escaper for this file.)
  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  },

  // Per-app redeploy WS handler. Flips the affected home-card pill into / out
  // of the yellow + spinner state. Reacts to BOTH the start broadcast
  // (deploying:true → render the deploying pill) and the end
  // broadcast (deploying:false → re-fetch the version so the new
  // SHA shows up). The server emits these from staging.js around
  // every rebuildProduction call, so all entry paths (dev-chat
  // merge, drift poller, manual check-updates) are covered.
  handleAppRedeployStatus(data) {
    if (!data || !data.appSlug) return;
    const slug = data.appSlug;
    const deployProgress = data.deploying
      ? { deploying: true, startedAt: data.startedAt, fromSha: data.fromSha || null }
      : null;

    // Home-screen card pill (only if the home screen is visible).
    const homeVisible = App._isScreenVisible('home-screen');
    if (homeVisible && typeof Home !== 'undefined') {
      if (data.deploying) {
        // We don't have the row's `version` data on hand here, but
        // the deploying pill hides the SHA anyway, so passing null
        // is correct.
        Home.updateAppCardPill(slug, { deployProgress, version: null });
      } else {
        // Deploy ended — full reload picks up the new version row
        // from /api/apps. Cheap (one query) and avoids manually
        // splicing the new SHA into a single card.
        Home.load();
      }
    }

    // The app tab, for the app in view. Its Improve button spins while the
    // build rolls out and offers the reload once it has landed. Nothing here
    // touches the frame: it keeps showing the build before this one on
    // purpose, and AppView.reloadAppFrame is what moves it. Another app's
    // build is that app's news.
    if (slug === App.currentApp && window.Improve) {
      if (data.deploying) {
        window.Improve.update({ deploying: true, appUpdateReady: false });
      } else {
        // A failed build leaves nothing new to load onto.
        window.Improve.update({ deploying: false, appUpdateReady: !data.failed });
      }
    }
  },

  eventsWs: null,
  // Shell-injected staging iframe token, captured at script load so SPA
  // history rewrites can't lose it before a (re)connect needs it.
  _bootToken: new URLSearchParams(location.search).get('token'),
  // Set on the very first connect; on every subsequent (re)connect we
  // resync state because the server's broadcast model is fire-and-forget
  // — anything pushed during the disconnect window (a `vote_update
  // merged:true` from a long-running merge, an `app_status` flip, etc.)
  // would otherwise be silently lost. Resync = re-pull whatever the
  // current view depends on; cheap, and it self-bounds to "exactly when
  // we know we might have missed something" rather than a periodic poll.
  _eventsWsHasConnected: false,

  connectEvents() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Same staging-iframe token fallback as GroupChat._openSocket — the
    // session cookie can be orphaned by a staging redeploy, and the WS
    // handshake can't re-mint it the way HTTP requests do. Prefer the
    // live URL, fall back to the boot-time capture (SPA history rewrites
    // may have stripped the query by now).
    const token = new URLSearchParams(location.search).get('token') || App._bootToken;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    App.eventsWs = new WebSocket(`${proto}//${location.host}/ws/events${qs}`);

    App.eventsWs.onopen = () => {
      const isReconnect = App._eventsWsHasConnected;
      App._eventsWsHasConnected = true;
      console.log(`[ws] Global events ${isReconnect ? 'reconnected' : 'connected'}`);
      // A (re)opened socket proves we're online — clear the offline
      // banner immediately instead of waiting for the slow re-probe loop.
      if (window.Offline) Offline.nudge();
      if (isReconnect) App.resyncCurrentView();
    };

    App.eventsWs.onerror = (err) => {
      console.warn('[ws] Global events error', err);
    };

    App.eventsWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          // A cross-instance event whose payload did not fit in a NOTIFY
          // (8000 bytes), so the emitting pod sent a nudge instead of a
          // truncated event — see services/ws-bus.js. "Something you are
          // looking at moved; go and re-read it" is exactly what a dropped
          // socket already means, so it takes the identical recovery path
          // rather than a second one that could drift from it.
          case 'resync_hint':
            App.resyncCurrentView();
            break;
          // Which platform build is live, from the server rather than the
          // next /api/version poll (#2545) — see handlePlatformVersion.
          case 'platform_version':
            App.handlePlatformVersion(data);
            break;
          case 'app_status':
            window.UsernodeReact?.appAllowance?.invalidate?.();
            App.handleAppStatusUpdate(data);
            break;
          case 'session_update':
            App.handleSessionUpdate(data);
            break;
          case 'session_state':
            // #1038: live working state for one session. The store repaints
            // every surface that shows it (cog, board cards, session list)
            // with no refetch at all.
            App.handleSessionState(data);
            break;
          case 'vote_update':
            App.handleVoteUpdate(data);
            break;
          case 'kudos_update':
            // Kudos count changed for some PR — bump cached state +
            // any visible buttons + the leaderboard if open. Delegated
            // to Kudos so app.js stays thin.
            if (window.Kudos) Kudos.applyLiveUpdate(data);
            break;
          case 'session_event':
            App.handleSessionEvent(data);
            break;
          case 'app_update':
            App.handleAppUpdate(data);
            break;
          case 'issue_update':
            App.handleIssueUpdate(data);
            break;
          case 'workshop_update':
            App.handleWorkshopUpdate(data);
            break;
          case 'board_order_update':
            // #613: someone reordered a Dev-board column. refreshDevData
            // re-pulls the board (including the manual order fetched by
            // _loadDevData) and repaints, so every open board converges.
            if (typeof AppView !== 'undefined' && AppView.refreshDevData) {
              AppView.refreshDevData('board-order');
            }
            break;
          case 'session_drafts_changed':
            // #940: another device of THIS user saved or trashed a draft.
            // No-ops unless that session is the one on screen; a dropped
            // socket costs nothing, since opening the session or returning
            // to the tab reconciles anyway.
            if (typeof DevChat !== 'undefined' && DevChat.applyDraftsUpdate) {
              DevChat.applyDraftsUpdate(data.sessionId);
            }
            break;
          case 'app_allowance_changed':
            window.UsernodeReact?.appAllowance?.invalidate?.();
            break;
          case 'budget_updated':
            // #2598: a model call's cost just landed against this user's
            // weekly pool (services/budget-live.js). Both meters repaint from
            // the figures the event carries — the composer's and the header
            // drawer's AI-credit row — so "$x left this week" ticks while the
            // agent works instead of only once the turn ends. No refetch:
            // the payload IS the snapshot both surfaces read, which is why
            // this can fire every few seconds during a build.
            if (typeof DevChat !== 'undefined' && DevChat.applyBudgetUpdate) {
              DevChat.applyBudgetUpdate(data.budget);
            }
            window.AiCredit?.Budget?.applyPush?.(data.budget);
            break;
          case 'notification_new':
            if (window.Notifications) Notifications.handleIncoming(data.notification);
            // A mention/reply/reaction may have arrived for a message in
            // the currently-open chat — reconcile its unread dot.
            window.GroupChat?.reconcileDotsFromNotifications?.();
            break;
          case 'notifications_changed':
            // Server cleared/changed this user's notifications elsewhere
            // (e.g. another tab cast a vote and the PR nudge was dismissed,
            // or this user sent a chat message and reply-clears-all fired).
            // Re-pull so this tab's badge + list stay in sync, then
            // reconcile the in-chat unread dots from the fresh list.
            if (window.Notifications) {
              const r = Notifications.refresh?.();
              if (r && typeof r.then === 'function') {
                r.then(() => window.GroupChat?.reconcileDotsFromNotifications?.());
              } else {
                window.GroupChat?.reconcileDotsFromNotifications?.();
              }
            }
            break;
          case 'conversation_message_created':
          case 'conversation_message_updated':
          case 'conversation_reaction_updated':
          case 'conversation_read':
          case 'conversation_membership_changed':
          case 'conversation_typing':
            // The global socket is transport only. The React-owned Messages
            // store applies member-scoped events without a legacy DOM write.
            window.UsernodeReact?.messages?.handleEvent?.(data);
            break;
          case 'app_version_changed':
            // #21: a PR just merged and prod was rebuilt. Re-pull the home
            // list so the app card's commit pill picks up the new SHA.
            // The drawer is platform information and has no dApp SHA slot.
            if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
              Home.load();
            }
            // #405: the merge that triggered this rebuild also flips the
            // session to 'merged' — advance the open session's header pill +
            // change card to "✓ Merged" if it's the one being viewed.
            if (typeof DevChat !== 'undefined' && DevChat.refreshCurrentSessionStatus
                && DevChat.currentSession && DevChat.currentSession.app_slug === data.appSlug) {
              DevChat.refreshCurrentSessionStatus(DevChat.currentSession.id);
            }
            break;
          case 'app_redeploy_status':
            // Per-app rebuild started/ended. Flip the home-screen card pill
            // (if visible) into / out of the yellow + spinner state
            // immediately, no extra server round-trip.
            App.handleAppRedeployStatus(data);
            break;
          case 'admin_rollover_status':
            // Bulk container rollover progress (admin-only broadcast — see
            // ws.broadcastToAdmins). Only the admin console's rollover
            // section cares; it no-ops when that section isn't mounted.
            if (window.AdminConsole?.handleRolloverStatus) {
              AdminConsole.handleRolloverStatus(data);
            }
            break;
          case 'admin_staging_reap_status':
            // Stale-staging-preview sweep progress (admin-only broadcast —
            // see ws.broadcastToAdmins). Only the admin console's stale
            // previews section cares; it no-ops when that section isn't
            // mounted.
            if (window.AdminConsole?.handleStagingReapStatus) {
              AdminConsole.handleStagingReapStatus(data);
            }
            break;
        }
      } catch {}
    };

    App.eventsWs.onclose = () => {
      // A dropped global-events socket is the strongest early signal that
      // we've gone offline — nudge the connectivity probe so the offline
      // banner appears without waiting for a browser `offline` event.
      if (window.Offline) Offline.nudge();
      setTimeout(() => App.connectEvents(), 3000);
    };
  },

  // Pull fresh state for whatever the user is currently looking at.
  // Called on WS reconnect (and could also be wired to visibilitychange
  // for tabs that come back from being backgrounded). Each branch maps
  // to a corresponding `case` in onmessage — the rule is simply "if a
  // WS event would have driven this view, refetch the same data here."
  resyncCurrentView() {
    // `Home` and `AppView` are classic-script top-level `const` — they
    // live in the script-global lexical env but are NOT on `window`,
    // so `window.Home` / `window.AppView` would silently be undefined.
    // `Notifications` is explicitly assigned to `window` in
    // notifications.js, so that one is fine.
    if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
      Home.load();
    }
    if (window.Notifications) Notifications.refresh?.();
    // The cog drawer used to be refreshed here. It is retired; its session
    // list is the Improve panel's, which reloads only while it is open.
    if (window.Improve) Improve.onSessionStateChanged?.();
    // Messages owns a global drawer unread badge even while its screen is
    // closed, so reconcile its summary after a disconnect in every view.
    window.UsernodeReact?.messages?.refresh?.();
    // #1038: `session_state` is fire-and-forget like every other broadcast,
    // so anything that transitioned during the disconnect window was lost.
    // The reconcile endpoint is the authority — it also clears overrides for
    // sessions that finished while we were away, and detects a platform
    // restart (new bootId) that invalidated all of them.
    if (window.SessionState) SessionState.sync?.();
    // Admin console's container-rollover section: its live table is driven
    // by `admin_rollover_status`, so a dropped socket means missed
    // transitions. The loader no-ops unless that section is mounted.
    if (window.AdminConsole?.isOpen?.()) AdminConsole.loadRollover?.();
    // Same for the stale-previews sweep, driven by
    // `admin_staging_reap_status`. Each loader no-ops unless its own section
    // is the mounted one, so calling both is free.
    if (window.AdminConsole?.isOpen?.()) AdminConsole.loadStagingReap?.();
    App.loadVersion();
    if (App.currentApp && typeof AppView !== 'undefined' && AppView.appData) {
      // Re-fetch tab-specific state. We don't blow away the DOM —
      // these helpers update in place — so scroll positions, drafts,
      // etc. survive the resync.
      if (App.currentTab === 'dev') {
        AppView.refreshDevData('all');
      } else if (App.currentTab === 'app') {
        AppView.refreshToken?.();
      }
    }
  },

  /**
   * Slugs a status broadcast has already made us re-pull the app list for.
   *
   * A creation emits many `app_status` messages (one per phase), and without
   * this the first one would be followed by another list fetch on every
   * subsequent phase for the same app.
   */
  _listedNewApps: new Set(),

  /**
   * A status arrived for an app with NO card on the home grid (#1547).
   *
   * That is the just-created app: the grid was loaded before it existed, so
   * nothing on My Apps represents it. Closing the creation dialog therefore
   * left the build with no visible trace at all until it finished, which is
   * exactly the report — the dialog is "dismissing a report, not cancelling
   * anything" (create-app.tsx), and the screen behind it did not say so.
   *
   * One list pull per slug puts the tile there, and the tile already knows how
   * to say "Spinning up..." for a creating app (Home.renderAppCard). Every
   * later phase for that slug then takes the `if (card)` branch above, which
   * keeps `data-status` current with no further fetching.
   *
   * Deliberately not gated on which screen is showing: Home.load() is the
   * same call the running/error branch makes, the payload is one request, and
   * gating it would mean the grid is stale the moment somebody navigates back
   * to it mid-build — which is the bug wearing a different hat.
   */
  _listNewlyCreatedApp(slug) {
    if (!slug || App._listedNewApps.has(slug)) return;
    App._listedNewApps.add(slug);
    if (window.Home && typeof Home.load === 'function') Home.load();
  },

  handleAppStatusUpdate(data) {
    // The create dialog's progress view, if one is open on this app.
    // Forwarded unconditionally — the store drops messages for apps it
    // is not watching, and it is the only thing that knows which app
    // that is. `?.` all the way down because this file is a classic
    // script that runs BEFORE the deferred React bundle: a status
    // message arriving in that window has no store to publish into yet.
    window.UsernodeReact?.appCreationProgress?.publish?.(data);

    // A creation commonly finishes while its progress dialog is still open,
    // BEFORE this slug is the current app. The terminal event is newer than
    // any app-detail snapshot already sitting in the service-worker cache, so
    // retain it for AppView.open() regardless of which screen is visible.
    // `_rememberPendingAppStatus` also treats a later `creating` phase as a
    // retry boundary and clears an older terminal fact for the same slug.
    AppView._rememberPendingAppStatus?.(data);

    // Update home screen card if visible
    const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
    if (card) {
      // The tile carries no status dot any more (a launcher icon should
      // read as an app, not a dashboard row), so `data-status` IS the
      // update: it gates the tap-to-open handler and the cursor, and it is
      // what a full re-render reads back. The visible copy — "Spinning
      // up…" / "Error" and the Retry button — comes from the Home.load()
      // below, which every status worth showing already triggers.
      card.dataset.status = data.status;
      // #416: 'error' also triggers a re-pull — the fresh list carries
      // the (server-gated) last_failure_reason for the card tooltip and
      // the "View build log" menu item.
      if (data.status === 'running' || data.status === 'error') {
        Home.load();
      }
    } else {
      App._listNewlyCreatedApp(data.slug);
    }

    // Update app view if we're looking at this app
    if (App.currentApp === data.slug && App.currentTab === 'app') {
      // On the first open, the terminal event can beat the detail request.
      // There is no record to mutate yet. The event was preserved above, so
      // open() will reconcile it with the fetched snapshot when that settles.
      if (AppView.appData && AppView.appData.slug === data.slug
          && data.status === 'running') {
        AppView.appData.status = 'running';
        AppView.appData.url = data.url;
        // Share lives in the Improve panel now, and the panel reads
        // `canShare` off the same signal this branch is reacting to — so
        // publishing the app's new state is what re-enables the row, in
        // place of the `classList.remove('hidden')` on #drawer-row-share
        // that used to sit here.
        if (window.Improve) Improve.update({ canShare: true });
        AppView.refreshToken().then(() => {
          // Re-check the tab — the user may have switched to group/dev
          // chat while refreshToken() was in flight. Without this guard
          // the button gets re-shown on tabs that have no iframe.
          if (App.currentApp !== data.slug || App.currentTab !== 'app') return;
          AppView.renderAppTab();
          if (window.DevConsole) DevConsole.setButtonVisible(true);
        });
      } else if (AppView.appData && AppView.appData.slug === data.slug
          && data.status === 'error') {
        // #416: a watched spin-up just failed — flip the App tab to the
        // error state immediately, carrying the broadcast one-line
        // reason so the user isn't left with a bare "Error".
        AppView.appData.status = 'error';
        if (data.errorReason) AppView.appData.errorReason = data.errorReason;
        AppView.renderAppTab();
      } else if (AppView.appData && AppView.appData.slug === data.slug
          && data.status === 'awaiting_secrets') {
        // This is terminal for the initial deploy too. Leaving appData at
        // `creating` would strand the same spinner as a missed running event;
        // render the actionable blocked state immediately.
        AppView.appData.status = 'awaiting_secrets';
        if (Array.isArray(data.missingSecrets)) {
          AppView.appData.missingSecrets = data.missingSecrets;
        }
        AppView.renderAppTab();
      }
    }
  },

  // #1038: a pushed session working-state change. The spinner half needs no
  // fetch — SessionState.applyEvent repaints every subscribed surface. The
  // only thing that still warrants a refetch is a LIFECYCLE change
  // (active → paused / promoted / archived), because that changes which rows
  // exist on the board and in the drawer, not just how they're decorated.
  // Debounced so a burst of transitions costs one reload.
  _sessionStatusSeen: Object.create(null),
  _sessionRowsTimer: null,
  handleSessionState(data) {
    if (!window.SessionState || data == null || data.sessionId == null) return;
    const key = String(data.sessionId);
    const prevStatus = App._sessionStatusSeen[key];
    const nextStatus = data.status || null;
    App._sessionStatusSeen[key] = nextStatus;
    SessionState.applyEvent(data);
    if (prevStatus === undefined || prevStatus === nextStatus) return;
    if (App._sessionRowsTimer) return;
    App._sessionRowsTimer = setTimeout(() => {
      App._sessionRowsTimer = null;
      App.refreshHomeProposals();
      if (typeof AppView !== 'undefined' && AppView.refreshDevData) {
        AppView.refreshDevData('session');
      }
    }, 500);
  },

  handleSessionUpdate(data) {
    // #8: behind_main updates patch the dev-chat banner in place
    // without disturbing the surrounding chat view. We dispatch
    // before the broader re-render branches because behind_main
    // events are scoped per-session and don't need a session-list
    // refetch.
    if (data.action === 'behind_main' && typeof data.behindMain === 'number') {
      // The topic page's "Behind main" pill read this number from its last
      // refetch and went stale while the dev-chat banner updated live; both
      // surfaces now take the same patch.
      if (typeof AppView !== 'undefined' && AppView.applyBehindMainEvent) {
        AppView.applyBehindMainEvent(data.sessionId, data.behindMain);
      }
      if (typeof DevChat !== 'undefined' && DevChat.applyBehindMainUpdate) {
        DevChat.applyBehindMainUpdate(data.sessionId, data.behindMain);
      }
      return;
    }
    // #1442: freshness re-measurements. Same scoping argument as
    // behind_main above (per-session, no list refetch), and it carries a
    // behind_main of its own because the two numbers are now measured
    // together — a proposal reading "0 behind" for eight commits was the
    // failure the issue reported.
    if (data.action === 'freshness') {
      if (typeof AppView !== 'undefined' && AppView.applyFreshnessEvent) AppView.applyFreshnessEvent(data);
      if (typeof DevChat !== 'undefined' && DevChat.applyFreshnessUpdate) {
        DevChat.applyFreshnessUpdate(data);
      }
      return;
    }
    // #252: sync-with-main lifecycle events drive the dev-chat sync
    // banner's spinner/phase text and terminal feedback. Scoped
    // per-session like behind_main — no list refetch needed.
    if (data.action === 'sync_status') {
      if (typeof AppView !== 'undefined' && AppView.applySyncStatusEvent) AppView.applySyncStatusEvent(data);
      if (typeof DevChat !== 'undefined' && DevChat.applySyncStatusUpdate) {
        DevChat.applySyncStatusUpdate(data);
      }
      return;
    }
    // Refresh session list if we're on the Sessions sub-tab for this app
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab === 'sessions') {
      if (AppView.appData) {
        DevChat.loadSessions(AppView.appData.slug).then(() => {
          if (!DevChat.currentSession) DevChat.renderSessionList();
        });
      }
    }
    // Refresh proposals / inline chat vote state on the other dev sub-tabs
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab !== 'sessions') {
      AppView.refreshDevData('session');
    }
    // The header cog's drawer tracks session status changes.
    App.refreshHomeProposals();
  },

  handleSessionEvent(data) {
    console.log('[ws] session_event', data.event, data.sessionId, data._seq);
    // #47: the checks badge can change on any open proposal, not just the
    // dev session the viewer happens to have focused — refresh the vote
    // panel + home strip globally before the currentSession early-return.
    if (data.event === 'checks_ready') {
      // A run in flight reports once a second, to everyone, for as long as
      // it runs (`progress` on a 'pending' event). Those ticks are for the
      // row that is showing: they patch it in place and touch no fetch. The
      // start-of-run and verdict events (no `progress`) keep the refreshes
      // below, which is what the board and the home strip advance on.
      const progressTick = data.checkState === 'pending' && data.progress && typeof data.progress === 'object';
      if (App.currentTab === 'dev' && App.currentSubTab !== 'sessions') {
        // The event carries checkState / checkPhase / checkTrigger and, for
        // a run in flight, `progress`. Patch the cached row and repaint from
        // it; a final verdict (which needs test_results the event does not
        // carry) refetches — through a kind that keeps the vote roster.
        if (typeof AppView !== 'undefined' && AppView.applyChecksEvent) AppView.applyChecksEvent(data);
        else if (!progressTick) AppView.refreshDevData('session');
      }
      if (!progressTick) {
        // The Underway board refresh above is intentionally skipped while the
        // owner is inside a session. Refresh that focused row directly so its
        // header advances Draft -> Checks running -> Checks passed/failed
        // without waiting for a vote/version event or a manual reload.
        if (typeof DevChat !== 'undefined' && DevChat.refreshCurrentSessionStatus) {
          DevChat.refreshCurrentSessionStatus(data.sessionId);
        }
        App.refreshHomeProposals();
      }
    }
    // #439: an on-demand preview rebuild (Preview-click → ensure-staging)
    // can complete for a session that isn't the focused dev-chat one (e.g. a
    // vote-panel preview), so drive the "spinning back up" overlay globally,
    // before the currentSession gate below. onStagingRebuildResult is a
    // no-op unless a matching pending marker is parked, so this is cheap.
    if (data.event === 'staging_ready') {
      AppView.onStagingRebuildResult(data.sessionId, { url: data.url });
    } else if (data.event === 'staging_failed') {
      AppView.onStagingRebuildResult(data.sessionId, { failed: true, error: data.error });
    }
    if (!DevChat.currentSession || DevChat.currentSession.id !== data.sessionId) return;
    // Dedup by sequence number
    if (data._seq && DevChat._seenSeqs?.has(data._seq)) return;
    if (data._seq) {
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      // Deliberately do NOT advance DevChat._lastSeenSeq here. That cursor
      // seeds the resumable GET /events `?since=` replay, and WS + SSE-only
      // events interleave in ONE monotonic seq stream — advancing it from a
      // WS delivery would make the replay skip SSE-only events (suggestions,
      // quick_replies, tokens) that were never actually delivered. Replay
      // overlap is harmless (_seenSeqs dedups it); cursor over-advancement
      // loses events until refresh. Only the SSE channels move the cursor.
    }

    // #2599: live evidence outranks any snapshot that declared the turn over.
    // A running-agent status, a progress line, a phase or a stop request on
    // an idle transcript re-arms the turn (Stop button, live stream, poll)
    // before the row paints — the report's spinning "OpenRouter is running…"
    // row beside an enabled Send button was exactly this event landing after
    // a stale not-busy /status answer. The helper is a no-op mid-turn.
    if (typeof DevChat._noteLiveTurnEvent === 'function') {
      DevChat._noteLiveTurnEvent({ ...data, type: data.event }, data.sessionId);
    }

    switch (data.event) {
      case 'status': {
        DevChat._deactivateLastStatus();
        // A status line always closes the current streaming bubble (#99 /
        // #394): when the WS is the only channel that delivered the Mayor's
        // phase-1 preamble (POST SSE dropped), seal it here so the phase-2
        // 'mayor_reasoning' summary opens a fresh bubble below the status row
        // instead of overwriting the preamble. Mirrors the POST-SSE and
        // resumable status handlers (dev-chat.js).
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { DevChat.messages[i]._finalized = true; break; }
        }
        // Carry the scout spec-preview card fields (#394) so the inline card
        // renders live when the scout's final status arrives via the WS after
        // a POST-SSE drop — parity with the POST-SSE (sessions.js) and
        // resumable (_handleResumedEvent) status handlers.
        // #786: carry quickReplies so a restart-recovery breadcrumb
        // delivered over the WS repaints the pill bar live — the recovery
        // paths broadcast pills on the status event, not 'quick_replies'
        // (that handler attaches to the last ASSISTANT row, which a
        // recovered turn doesn't have).
        DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, stagingBuild: data.stagingBuild, scoutOutput: data.scoutOutput, quickReplies: data.quickReplies, agentBackend: data.agentBackend, agentModel: data.agentModel, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
        // #990: keep a live cue where the next message will land, for the
        // whole gap between this step line and whatever follows it. Parity
        // with both dev-chat.js status handlers.
        if (typeof DevChat._showActivity === 'function') DevChat._showActivity();
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      }
      case 'platform_issue_draft':
        // Agent-suggested platform report (human gate) — see dev-chat.js.
        if (typeof DevChat._hideActivity === 'function') DevChat._hideActivity();
        DevChat._pushPlatformIssueDraft(data);
        break;
      case 'billing_switched':
        // #664: the daily free allowance ran out mid-turn and the worker
        // proxy switched the remaining calls onto the user's own key. The
        // server already persisted the matching system row; render the
        // notice live and refresh the meter so the "your key" split shows.
        DevChat.messages.push({ role: 'system', content: data.text, billingSwitch: true, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        DevChat.refreshBudget();
        break;
      case 'staging_ready':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url) {
          DevChat.currentSession.staging_url = data.url;
          // #127: testing guidance rides along with the rebuild broadcast.
          if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
          if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
        }
        break;
      case 'staging_failed':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({
          role: 'system',
          content: `Staging build failed: ${data.error || 'unknown error'}`,
          stagingFailed: true,
          stagingErrorName: data.errorName || 'Error',
          stagingMissingKeys: data.missingKeys || [],
          created_at: new Date().toISOString(),
          _slug: Math.random().toString(36).slice(2,8),
        });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'pr_created':
      case 'pr_updated':
        if (DevChat.currentSession) {
          if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) {
            DevChat.currentSession.pr_title = data.prTitle;
            // #249: server mirrors pr_title into session_title.
            DevChat.currentSession.session_title = data.prTitle;
          }
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'session_titled':
        // #249: pre-PR display name landed — refresh header/session UI.
        if (DevChat.currentSession && data.sessionTitle) {
          DevChat.currentSession.session_title = data.sessionTitle;
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'visuals_ready':
        // #195: before/after capture finished (it lands after
        // staging_ready, often after the turn's POST SSE is gone) —
        // stash the artifact ids and re-render so the staging card
        // upgrades in place with the media tiles.
        if (DevChat.currentSession && Object.prototype.hasOwnProperty.call(data, 'visuals')) {
          DevChat.currentSession.visuals = data.visuals || null;
          DevChat.renderMessages();
        }
        break;
      case 'cc_progress':
        // #990: the coding agent's own live log takes over as the cue.
        if (typeof DevChat._hideActivity === 'function') DevChat._hideActivity();
        DevChat._appendProgressLine(data.text, data);
        DevChat.scrollToBottom();
        // Also arm the /status polling fallback when cc_progress arrives via
        // WS (e.g. the SSE POST itself died before getting here). Without
        // this, a WS reconnect in the middle of the run could lose every
        // subsequent event and leave the UI stuck with a spinning send
        // button and stale progress.
        if (!DevChat._progressPollTimer && DevChat.isStreaming) {
          DevChat._startProgressPolling(data.sessionId, []);
        }
        break;
      case 'mayor_reasoning': {
        // #394: the Mayor's authoritative full-text reply (phase-1 preamble or
        // phase-2 wrap-up summary). Broadcast on the WS now so the post-spec
        // summary survives a dropped POST SSE — the global-WS 'done' used to
        // tear down streaming before the resumable stream could replay it, so
        // the summary only appeared after a manual refresh. Mirrors
        // DevChat._handleResumedEvent's 'mayor_reasoning' branch. The _seq
        // dedup above already skipped this if the POST SSE delivered it first.
        if (!data.text) break;
        let am = null;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { am = DevChat.messages[i]; break; }
        }
        // No live bubble yet (or the last one is sealed — phase-2 after a
        // status row) → push a fresh bubble. Otherwise reconcile the existing
        // live bubble to the server's authoritative text whenever it differs
        // (the server may have shortened it by scrubbing a fake completion
        // marker), patching the content node in place when present.
        // #990: the reply is here — drop the dots, and freeze the step line
        // that is still painted as live (guarded so a running coding agent
        // keeps its progress estimate).
        if (typeof DevChat._hideActivity === 'function') DevChat._hideActivity();
        if (!am || am._finalized) {
          if (typeof DevChat._deactivateStatusForFreshBubble === 'function') DevChat._deactivateStatusForFreshBubble();
          DevChat.messages.push({ role: 'assistant', content: data.text, created_at: new Date().toISOString() });
          DevChat.renderMessages();
        } else if (am.content !== data.text) {
          am.content = data.text;
          const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
          // #1078: the transcript is a React island, so the streaming writer
          // takes the MESSAGE and publishes a frame keyed to its row. It no
          // longer resolves a content node as "the last `.dc-msg-content` on
          // the page" — which was the PREVIOUS turn's bubble whenever this
          // one had not been rendered yet.
          if (typeof DevChat._renderStreamingMarkdown === 'function') {
            DevChat._renderStreamingMarkdown(am, displayContent);
          } else {
            DevChat.renderMessages();
          }
        }
        DevChat.scrollToBottom();
        break;
      }
      case 'suggestions': {
        // Q/A suggested-answer chips, no longer SSE-only: they must survive a
        // dropped POST SSE just like mayor_reasoning (#394). Attach to the
        // live assistant bubble — the emit order guarantees mayor_reasoning
        // (WS-handled above) pushed it first. A sealed bubble means a
        // dispatch turn, where suggestions were already dropped server-side —
        // skip rather than mis-attach (same guard as the resumable handler).
        if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
        let am = null;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { am = DevChat.messages[i]; break; }
        }
        if (am && !am._finalized) {
          am.suggestions = data.suggestions;
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
        break;
      }
      case 'quick_replies': {
        // Quick-reply pills ("Build it", …), no longer SSE-only: the phase-2
        // emit rides right behind the wrap-up mayor_reasoning, which a long
        // scout/build turn frequently delivers only via this WS after the
        // POST SSE died. Attach to the latest assistant bubble; the pill bar
        // reads from it, so _renderQuickReplies redraws (hidden while
        // streaming, surfaces when _finishStreaming re-renders).
        if (!Array.isArray(data.replies) || !data.replies.length) break;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') {
            DevChat.messages[i].quickReplies = data.replies;
            DevChat._renderQuickReplies();
            break;
          }
        }
        break;
      }
      case 'assistant_message_end': {
        // #394: seal the current assistant bubble so a subsequent
        // 'mayor_reasoning' / token starts a fresh one. Already broadcast on
        // the WS but previously ignored here; mirrors the POST-SSE and
        // resumable handlers (dev-chat.js).
        if (typeof DevChat._flushStreamingFinal === 'function') DevChat._flushStreamingFinal();
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { DevChat.messages[i]._finalized = true; break; }
        }
        break;
      }
      case 'done':
        // A 'done' arriving on the WS means the primary POST SSE never
        // finished this turn (its own 'done' would have been seq-deduped
        // first) — reconcile the timeline from the DB so anything that rode
        // only the dead stream (chips, pills, a late wrap-up) shows without
        // a manual refresh. See issue #446.
        // #2599: the WS carries every request's events for this session —
        // a second send refused with "already running" ends in a `done`
        // too — so the teardown asks /status first and stays up while the
        // session is still busy.
        if (typeof DevChat._endTurnFromSharedChannel === 'function') {
          DevChat._endTurnFromSharedChannel(data.sessionId).then((idle) => {
            if (idle) DevChat._reconcileAfterFallbackDone(data.sessionId);
          });
        } else {
          DevChat._deactivateLastStatus();
          DevChat._finishStreaming();
          DevChat.renderMessages();
          DevChat._reconcileAfterFallbackDone(data.sessionId);
        }
        break;
      case 'spec_updated':
        // Mayor's dispatch_scout updated the live draft.
        // The accompanying status event already pushed an inline preview
        // card into the chat timeline; we just keep an open spec viewer
        // in sync if the user happens to be looking at the live draft.
        if (typeof DevChat._handleSpecUpdated === 'function') {
          DevChat._handleSpecUpdated(data);
        }
        break;
      // #437: these four are broadcast on the WS (not in SSE_ONLY), so once
      // the WS path is live they MUST be handled here — handleSessionEvent
      // records `data._seq` into _seenSeqs BEFORE this switch, so an
      // unhandled type arriving first on the WS would mark the seq seen and
      // then get the matching POST-SSE / resumable copy deduped-and-swallowed.
      // Mirrors the resumable handlers in dev-chat.js (_handleResumedEvent).
      case 'phase':
        // Toggle the live-status UI between stop-button (interruptible) and
        // spinner (wrap-up). Cheap + idempotent — just swaps the button glyph.
        DevChat._setStreamingUI(true, data.phase);
        break;
      case 'stopping':
        // #889: someone hit Stop on this session (possibly in another tab or
        // on another device). Paint the interim "stopping…" state here too —
        // and note this case is REQUIRED, not decorative: an unhandled type
        // arriving first on the WS marks its _seq seen and gets the matching
        // SSE/resumable copy deduped-and-swallowed (see the comment above).
        DevChat._enterStoppingState({ by: data.by });
        break;
      case 'stopped':
        // The "Stopped by @user." status row was already persisted + emitted
        // server-side via sendStatus, so just tear down the streaming UI —
        // once /status confirms the session is idle (#2599, as for 'done').
        if (typeof DevChat._endTurnFromSharedChannel === 'function') {
          DevChat._endTurnFromSharedChannel(data.sessionId);
        } else {
          DevChat._removeSpinner();
          DevChat._deactivateLastStatus();
          DevChat._finishStreaming();
        }
        break;
      case 'cc_estimate':
        // Experimental AI progress estimate (opt-in, server-gated).
        // `cleared: true` (#891) blanks the guess at the coding run's end.
        DevChat._applyEstimate(data.text, data.remainingSeconds, {
          estimatedAt: data.estimatedAt, cleared: data.cleared,
        });
        break;
      case 'cc_log':
        DevChat.messages.push({
          role: 'system',
          ccLog: data.log,
          content: data.agentBackend === 'codex_openrouter' ? 'Codex log' : 'Claude Code log',
          agentBackend: data.agentBackend,
          agentModel: data.agentModel,
          created_at: new Date().toISOString(),
        });
        // #990: real content arrived — the trailing dots stand down. Guarded
        // with typeof because app.js may run before dev-chat.js is defined.
        if (typeof DevChat._hideActivity === 'function') DevChat._hideActivity();
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
    }
  },

  handleAppUpdate(data) {
    if (data.action === 'renamed') {
      // Update home card (if visible) and header (if we're on this app).
      const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
      if (card) {
        const nameEl = card.querySelector('.font-medium');
        if (nameEl) nameEl.textContent = data.newName;
        // Only letter-fallback tiles track the name; a custom icon
        // (emoji/image from dapp.json) must not be clobbered by a rename.
        const avatar = card.querySelector('[data-icon]') || card.querySelector('div.rounded-xl');
        if (avatar && (avatar.dataset?.icon || 'letter') === 'letter') {
          avatar.textContent = (data.newName || '?').charAt(0).toUpperCase();
        }
      }
      if (App.currentApp === data.slug) {
        App.setHeaderTitle(data.newName);
        if (typeof AppView !== 'undefined' && AppView.applyRename) {
          AppView.applyRename(data.newName);
        }
      }
    } else if (data.action === 'illustration_changed') {
      // #2086: a featured-illustration proposal was voted in (or admin
      // applied). The editor used to patch these caches itself the moment
      // it saved; the vote apply is what changes the app now, so every
      // open client patches them from the broadcast instead.
      if (typeof Home !== 'undefined' && Array.isArray(Home._apps)) {
        const cached = Home._apps.find((a) => a.slug === data.slug);
        if (cached) cached.featured_illustration = data.illustration || null;
        if (Home.render) Home.render();
      }
      if (App.currentApp === data.slug && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.featured_illustration = data.illustration || null;
      }
    } else if (data.action === 'icon_changed') {
      // A deploy reconciled this app's dapp.json icon block (emoji /
      // image / cleared back to the letter). Patch the mounted home
      // tile in place — no full Home.load().
      if (typeof Home !== 'undefined' && Home.updateAppCardIcon) {
        Home.updateAppCardIcon(data.slug, data.iconEmoji, data.iconUrl);
      }
    } else if (data.action === 'lock_changed') {
      // The admin-gated change lock flipped on this app (see
      // POST /api/apps/:slug/lock in routes/apps.js). Refresh the
      // home-card icon and, if the user is currently looking at this
      // app's group chat, refresh the vote panel so the "(locked —
      // also needs an admin yes)" hint appears or disappears in step.
      if (typeof Home !== 'undefined' && Home.updateAppCardLock) {
        Home.updateAppCardLock(data.appSlug, data.locked);
      }
      if (App.currentApp === data.appSlug
          && App.currentTab === 'dev'
          && typeof AppView !== 'undefined' && AppView.refreshDevData) {
        AppView.refreshDevData('lock');
      }
    } else if (data.action === 'visibility_changed') {
      // Visibility flipped (a merged visibility PR's deploy-time
      // reconcile — see services/app-manifest.js). Reload the home grid
      // so badges update and newly-private apps drop out for outsiders;
      // patch the open app's in-memory row so member-list and tab gating see
      // the fresh values. App settings re-fetches the authoritative row each
      // time it opens, so it never needs a legacy DOM repaint here.
      const homeScreen = document.getElementById('home-screen');
      if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
        Home.load();
      }
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.collab_visibility = data.collabVisibility;
        AppView.appData.view_visibility = data.viewVisibility;
      }
    } else if (data.action === 'governance_changed') {
      // Proposal-approval settings applied (a merged governance PR's
      // deploy-time reconcile — issue #646). Patch the open app's
      // in-memory row and re-render the modal's pills if it's open.
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.approver_policy = data.approverPolicy;
        AppView.appData.approvals_required = data.approvalsRequired;
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView._renderMembersGovPills) {
          AppView._membersGov = {
            policy: data.approverPolicy === 'invited' ? 'invited' : 'anyone',
            atLeast: data.approvalsRequired != null ? Number(data.approvalsRequired) : null,
          };
          AppView._renderMembersGovPills();
          // The policy flip changes whether the Approvers section shows
          // (its visibility is roster-driven — see _renderApprovers) and
          // the merge may have auto-seeded the creator — refetch.
          if (AppView.loadApprovers) AppView.loadApprovers();
        }
        if (App.currentTab === 'dev' && AppView.refreshDevData) {
          AppView.refreshDevData('governance');
        }
      }
    } else if (data.action === 'admins_changed') {
      // Per-app admin roster applied (a merged admins PR's deploy-time
      // reconcile — issue #788, or a hand-edited dapp.json). Patch the
      // open app's in-memory row and refetch the Members modal's
      // App-admins section if it's open right now.
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.admin_usernames = Array.isArray(data.admins) ? data.admins : [];
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView.loadAppAdmins) {
          // The applied roster supersedes any in-progress draft — a
          // stale draft would misreport what the app now declares.
          AppView._appAdminsDraft = null;
          AppView.loadAppAdmins();
        }
      }
    }
  },

  // Refresh the relevant dev sub-tab when another user creates, votes on,
  // or closes an issue / governance proposal so everyone sees it live.
  handleIssueUpdate(data) {
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('issue');
    }
  },

  // The Workshop's grouping for the open app moved server-side (cards
  // placed into themes, or the themes re-drafted): re-fetch the themes
  // alone — the board's own data did not change — past the per-slug
  // throttle, so what is on screen is what the server just wrote.
  handleWorkshopUpdate(data) {
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
      && typeof AppView !== 'undefined' && AppView.applyWorkshopUpdate) {
      AppView.applyWorkshopUpdate(data);
    }
  },

  // A vote/session event landed that affects the viewer's own work:
  // refresh the header cog's drawer (which took over the home screen's
  // old "Your proposals" / "Your active sessions" strips) and, while the
  // home screen is visible, re-pull the app grid too (Home.load is cheap
  // and already the live-update pattern — its cards carry activity
  // counts that these same events move).
  refreshHomeProposals() {
    if (window.Improve && Improve.onSessionStateChanged) Improve.onSessionStateChanged();
    const homeScreen = document.getElementById('home-screen');
    if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
      Home.load();
    }
  },

  // #1015: a self-app merge no longer latches any platform-wide chrome.
  // The "Platform updating… write actions are paused" banner (and its
  // fetch write-block, 2s version poll, stuck timer and forced reload)
  // existed because a self-app merge restarted the ONE platform
  // container. Blue-green deploys (#1008, scripts/platform-rollout.sh)
  // keep the live color serving until the new one is health-gated and
  // cut over, so there is no downtime to announce and no reason to
  // pause writes. `data.selfHosted` still rides along on these
  // broadcasts (it's a cheap, honest fact) — this handler simply
  // doesn't branch on it, and per-proposal state is carried by the
  // proposal's own badges. A tab left open across a platform deploy is
  // caught up by the drawer's stale-revision indicator
  // (renderPlatformVersionPill) or by pull-to-refresh (_refreshOrReload).
  handleVoteUpdate(data) {
    // Refresh the proposals tab / inline chat vote state if we're in
    // this app's Dev view.
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('vote');
    }
    // #405: advance the OPEN dev session's header pill + change card live
    // (e.g. promoted → merging → merged) when this update is for the session
    // the user is currently looking at. No-op otherwise.
    if (typeof DevChat !== 'undefined' && DevChat.refreshCurrentSessionStatus) {
      DevChat.refreshCurrentSessionStatus(data.sessionId);
    }
    // The header cog's drawer tracks tallies live.
    App.refreshHomeProposals();
    // If merged, refresh the app view
    if (data.merged && App.currentApp === data.appSlug) {
      if (App.currentTab === 'app') {
        AppView.renderAppTab();
      }
      Home.load();
    }
  },

  // Drawer status/version rows + the hamburger drawer itself (#1079 chunk
  // B): both objects moved into the React bundle, beside the markup they
  // drive, as frontend/src/features/header/header-menu-controller.js. What
  // stays here is a forwarder apiece, because the call sites are spread over
  // app.js, app-view.js, native-chrome.js, node-pill.js and wallet-sheet.js
  // and none of them had any reason to change.
  //
  // Explicit method-by-method forwarding rather than a getter for App.X:
  // app.js is a classic script and the bundle is a module, so there is a
  // window in which window.ImproveStatus does not exist yet, and the two
  // unguarded refreshDeployDot() / setAppOpen() callers below would throw on
  // a bare getter. Forwarding no-ops instead, which is what those calls did
  // when the drawer was not on screen anyway.
  // The home screen shows the PLATFORM's Improve button (#1367) — "improve
  // Homeroom itself", pointed at its own self-hosted app row.
  //
  // THE UI OVERHAUL shipped this once and #1363 reverted it, and that revert
  // is why the publish does NOT live here. That version re-targeted the platform row
  // on the RETURN paths only, so a cold boot at `/` never published a target:
  // the button appeared after backing out of an app and vanished on refresh,
  // which every reporter read as a stale leftover from the app they had just
  // closed. setAppOpen(false) still clears the app's target on every path;
  // Home.render() then publishes home's own, which is the one call a cold
  // boot, a WS repaint and the return from an app all funnel through. See
  // Home.publishImproveTarget for the two gates it gets right.

  ImproveStatus: {
    setAppOpen(open) { window.ImproveStatus?.setAppOpen(open); },
    refreshDeployDot() { window.ImproveStatus?.refreshDeployDot(); },
  },


  // Pull-to-refresh on the static full-screen scrollers (element mode —
  // the platform is a fixed shell). The kit no-ops these on desktop.
  // The Dev tab feed's scroller is re-created per render and wires its
  // own PTR in AppView.renderDevView.
  _wirePullToRefresh() {
    const home = document.getElementById('home-screen');
    if (home) {
      PlatformUI.pullToRefresh(home,
        () => App._refreshOrReload(() => Home.load()));
    }
    // The #apps browse screen (home-screen split). Its own scroller and
    // its own fetch, so it must not be routed through Home.load().
    const browse = document.getElementById('browse-screen');
    if (browse) {
      PlatformUI.pullToRefresh(browse,
        () => App._refreshOrReload(() => (window.Browse ? Browse._load() : Promise.resolve())));
    }
    // The Leaderboard screen hosts three panes; refresh whichever is
    // active. The two Topochain panes keep their own event/page state and
    // their own fetches, so they must NOT be routed through
    // Leaderboard._cache.
    const lb = document.getElementById('leaderboard-screen');
    if (lb) {
      PlatformUI.pullToRefresh(lb, () => App._refreshLeaderboard());
    }
    // #notifications-list's pull-to-refresh moved with the panel (#1079
    // chunk B) — it is attached from the island's layout effect in
    // frontend/src/features/notifications/index.tsx, so the whole panel has
    // exactly one owner.
  },

  bindEvents() {
    // Note: the "Create new app" entry point lives in the home feed
    // now (the Create app section — frontend/src/features/home/panels/) —
    // no static header button to bind here anymore.
    // The drawer's own wiring is HeaderMenu.init(), called from the React
    // island's layout effect now (#1079 chunk B) — it has to run after
    // hydration has adopted #header-menu-panel, which is earlier than this.
    App._wirePullToRefresh();
    // The create dialog bound its cancel, backdrop, submit, mode-pill and
    // visibility-pill listeners here, and finished by calling
    // setCreateVisibility('collab', 'public') to put the pills in their
    // default state. It is a React island now
    // (frontend/src/features/dialogs/create-app.tsx): the listeners are JSX
    // props, the default state is the component's initial state, and the
    // backdrop rule — ghost-click guard included — comes from `useDialog`.

    // The members & visibility modal bound its close button and backdrop
    // here. Its island (frontend/src/features/dialogs/members.tsx) owns both
    // now; the behaviour inside the card moved to members-controller.js and
    // still publishes onto AppView, so the Dev "+" menu's Members item —
    // wired in AppView._wirePlusMenu — reaches it unchanged.

    // The header button shows a HOUSE icon and that's what users read
    // it as: "go to home", not "go back one step". So clicking it
    // navigates straight to the home screen, skipping any
    // intermediate tabs/sessions in the history stack.
    //
    // Step-by-step back is still available — it lives on the
    // device/system back button (Flutter delegates to
    // `WebViewController.canGoBack()`, which reads the same browser
    // history this app pushes via updateHash()) and on the browser
    // back arrow on desktop. Both route through the popstate handler
    // installed in init(), which calls restoreFromHash() to rebuild
    // state from the previous URL.
    // The header back button is "home" for every screen — except inside a
    // mobile admin/settings section, where it is that section's back arrow
    // and pops to that screen's section menu (handleBack returns true when
    // it consumed the press). Gating on App._inAdmin / App._inSettings
    // means there is no override state that can go stale.
    //
    // #1036: the button is an <a href> now, so a cmd/ctrl/shift/middle
    // click is the BROWSER's to handle (new tab / new window) — bail out
    // before preventDefault and let it. The guard is the first statement
    // in the callback; the screen-hook chain below it is unchanged.
    document.getElementById('back-btn').addEventListener('click', (e) => {
      if (window.NavLink && NavLink.isNativeClick(e)) return;
      e.preventDefault();
      if (App._inAdmin && window.AdminConsole?.handleBack?.()) return;
      if (App._inSettings && window.Settings?.handleBack?.()) return;
      // Browse's detail level (#apps/<slug>) claims the button as "up to
      // the list"; on the list itself it declines and we leave the screen.
      if (App._inBrowse && window.Browse?.handleBack?.()) return;
      // A challenge's detail page claims it as "up to the grid".
      if (App._inLeaderboard && window.TopochainChallenges?.handleBack?.()) return;
      // A dev SESSION claims it as "back to the Board" (Streamlined
      // Concept); declines when no session is open.
      if (App.currentApp && window.DevChat?.handleBack?.()) return;
      // FOLLOW THE ARROW'S OWN HREF. Every screen that shows the arrow tells
      // setBackIcon where it points, and until now that href was decorative
      // on a plain click: the chain preventDefault()s and then always went
      // home, so Settings and Admin — whose parent is the Profile screen now
      // — landed a level below where they came from. The href IS the answer;
      // home is the fallback for a screen that named no parent.
      const href = e.currentTarget?.getAttribute?.('href');
      if (href && href.startsWith('#') && href.length > 1) {
        window.location.hash = href;
        return;
      }
      App.navigateHome();
    });

    // The rename, close-issue, fork and import-a-PR dialogs bound their
    // cancel, backdrop and submit listeners here until #1078 chunk I. They
    // are React islands now (frontend/src/features/dialogs/), so each one
    // binds its own handlers as JSX props and shares the backdrop rule —
    // ghost-click dismiss guard included, plus import-a-PR's refusal to close
    // mid-request — through `useDialog`. Nothing replaced them here; the
    // entry points AppView still exposes (promptRename, promptCloseIssue,
    // promptFork, openImportPrModal) forward to the islands' controllers.

    // ── Send-feedback dialog ──────────────────────────────────────────
    // #1078 chunk I moved the whole block — the target toggle, the live
    // title generation (#556/#732), the drag-to-select screenshot
    // attachment (#683), the kudos-bounty row (#964), the offline outbox
    // seam (#1054) and the submit itself — into
    // frontend/src/features/dialogs/feedback-controller.js, which the island
    // `init()`s from its layout effect. That module also re-publishes
    // `App.openFeedbackModal`, so `App._applyFeedbackShot` and the Dev "+"
    // menu's "File an issue" item still reach the dialog by name.

    // The header's App/Dev segmented switch (#app-mode-switch) used to be
    // wired here. THE UI OVERHAUL retired it: an app is just an app now, and
    // "Dev" is a destination the Improve panel links to rather than a mode the
    // header toggles. Both tabs still exist as ROUTES — /app/<slug> and
    // /app/<slug>/board — so every deep link, notification target and history
    // entry keeps working; what is gone is the control that flipped between
    // them in place. features/improve/improve-controller.js's openDev() is the
    // caller that takes its place, and it goes through the same switchTab().

    // popstate fires on browser/device back when the new history
    // entry was created with pushState; hashchange fires when only the
    // fragment changes (initial load with a deep link, manual edits to
    // the URL bar). Both routes converge on restoreFromHash, which is
    // idempotent — re-applying the same hash is a no-op via the
    // currentApp/currentTab guards inside it.
    //
    // Both also re-apply the fragment-scoped `?shot=` states (#1146), which
    // is what makes a sibling-fragment hash switch render what a cold load
    // at that fragment renders. _applyRouteShots dedupes on the hash, so the
    // traversal's duplicate pair still applies them exactly once.
    // The address this document LOADED at, so the first navigation away from
    // it records a real previous route rather than null (#1565).
    App._currentRoute = location.hash || '';
    window.addEventListener('popstate', () => App._routeFromHash());
    window.addEventListener('hashchange', () => App._routeFromHash());
  },

  // What popstate / hashchange run: the router, then the fragment-scoped
  // `?shot=` states for the address it just landed on. Kept separate from
  // restoreFromHash so the many in-app callers that route WITHOUT the
  // address having moved (boot, the auth screens, the alias rewrites) don't
  // drag the shot appliers along.
  _routeFromHash() {
    // Recorded before the router runs, and guarded on a real change: one
    // history traversal fires popstate AND hashchange, so this runs twice in
    // a tick with the address already settled (#1102). Without the guard the
    // duplicate would overwrite the previous route with the current one.
    const arriving = location.hash || '';
    if (arriving !== App._currentRoute) {
      App._previousRoute = App._currentRoute;
      App._currentRoute = arriving;
    }
    App.restoreFromHash();
    App._applyRouteShots();
  },

  // Clean app URLs live in the pathname while the rest of the platform keeps
  // its established fragment routes. A hash always wins when both exist: a
  // legacy caller assigning `location.hash = '#settings'` from an app path
  // means "leave the app for Settings", and restoreFromHash canonicalises the
  // pathname back to `/` before dispatching it.
  _appRouteFromPath(pathname) {
    const raw = String(pathname || '');
    if (!/^\/app\/[a-z0-9][a-z0-9-]{0,254}(?:\/.*)?$/.test(raw)) return '';
    try {
      return raw.replace(/^\/+/, '').split('/').map(decodeURIComponent).join('/');
    } catch (_) {
      return '';
    }
  },

  // Preserve every platform query parameter byte-for-byte, except `path`,
  // which belongs exclusively to the chromeless app route. The inner child
  // path is encoded as ONE query value so its own `?`, `&`, and `=` survive.
  _routeSearch(innerPath) {
    const raw = String(location.search || '').replace(/^\?/, '');
    const kept = raw ? raw.split('&').filter((part) => {
      const key = part.split('=', 1)[0].replace(/\+/g, ' ');
      try { return decodeURIComponent(key) !== 'path'; } catch (_) { return true; }
    }) : [];
    if (innerPath) kept.push(`path=${encodeURIComponent(innerPath)}`);
    return kept.length ? `?${kept.join('&')}` : '';
  },

  _rootUrl(hash) {
    return `/${App._routeSearch(null)}${hash || ''}`;
  },

  // One serializer for cold links, ordinary navigation, Back/Forward, and
  // legacy-hash normalisation. Keeping all app-route spellings here is what
  // prevents a copied address and the screen it restores from drifting.
  _appUrl(slug, tab, ref, subTab, options) {
    const opts = options || {};
    const safeSlug = encodeURIComponent(String(slug || ''));
    const norm = App._normalizeTab(tab, ref, subTab);
    let suffix = '';
    if (opts.chromeless) {
      suffix = '/full';
    } else if (norm.tab === 'dev') {
      if (norm.subTab === 'sessions' && norm.ref) {
        suffix = `/dev/sessions/${norm.ref}`;
      } else if (norm.subTab === 'chat') {
        suffix = '/dev/chat';
      } else if (norm.subTab === 'topic' && norm.ref && norm.ref.id) {
        const seg = norm.ref.kind === 'issue' ? 'issues'
          : norm.ref.kind === 'proposal' ? 'proposals'
          : norm.ref.kind === 'session' ? 'shared' : 'governance';
        suffix = `/dev/${seg}/${norm.ref.id}`;
      } else if (opts.boardView === 'workshop') {
        suffix = '/workshop';
      } else if (opts.boardView === 'kanban') {
        suffix = '/board';
      } else {
        const kanban = typeof AppView !== 'undefined' && AppView._getViewMode
          && AppView._getViewMode() === 'kanban';
        suffix = `/${kanban ? 'board' : 'workshop'}`;
      }
    }
    return `/app/${safeSlug}${suffix}${App._routeSearch(
      opts.chromeless ? opts.innerPath : null
    )}`;
  },

  _deepLinkTarget() {
    if (location.hash) return location.hash;
    const appPath = App._appRouteFromPath(location.pathname);
    return appPath
      ? `${location.pathname}${location.search || ''}`
      : '';
  },

  restoreFromHash() {
    App._isRestoring = true;
    try {
      const rawHash = location.hash.replace('#', '');
      const pathRoute = App._appRouteFromPath(location.pathname);
      // A fragment names a non-app platform screen, so it outranks the clean
      // app pathname it was assigned from. Heal the mixed address in place;
      // all the existing hash-writing modules can stay small and correct.
      if (rawHash && pathRoute && !rawHash.startsWith('app/')) {
        try { history.replaceState(null, '', App._rootUrl(`#${rawHash}`)); } catch (_) {}
      }
      // Fragment-query (#743): a chromeless deep link carries the app's
      // inner path after a `?` INSIDE the fragment
      // (#app/<slug>/full?path=/t/123). Split it off before the segment
      // split so every existing route parses byte-for-byte as before.
      const qIdx = rawHash.indexOf('?');
      let hash = rawHash
        ? (qIdx === -1 ? rawHash : rawHash.slice(0, qIdx))
        : pathRoute;
      const fragQuery = qIdx === -1 ? '' : rawHash.slice(qIdx + 1);

      // ── Anonymous-shell routing (fold-auth-pages-into-SPA) ─────────
      // #landing / #login / #signup / #register[/<code>] / #waiting are
      // in-SPA screens (auth-screens.js). Which set of routes is live
      // depends on the boot stage:
      //   - no session: auth routes render; every other hash is a deep
      //     link — remembered for after login, which is offered first
      //     (parity with the old server redirect: '/' → landing.html,
      //     deeper paths → login.html).
      //   - gated session (waiting room): only #waiting and #landing
      //     (public-app browsing) render; everything else returns to
      //     the waiting room. The server's API 403 remains the actual
      //     security boundary.
      //   - full session: auth hashes are stale (bookmark / back
      //     button) — strip them and land on home.
      if (window.AuthScreens) {
        const authRoute = AuthScreens.routeFromHash(hash);
        const authSeg = hash.split('/')[1] || null;
        const publicProfileRoute = hash.split('/')[0] === 'profile' && !!hash.split('/')[1];
        if (!App.user) {
          if (publicProfileRoute) {
            AuthScreens.hideAll();
          } else {
            if (authRoute && authRoute !== 'waiting') {
              AuthScreens.show(authRoute, authSeg);
              return;
            }
            if (!hash || authRoute === 'waiting') {
              AuthScreens.show('landing');
              return;
            }
            AuthScreens.rememberDeepLink(App._deepLinkTarget());
            AuthScreens.show('login');
            return;
          }
        }
        if (App.user) {
          if (App.user.hasPlatformAccess === false) {
            if (publicProfileRoute) {
              AuthScreens.hideAll();
            } else {
              if (authRoute === 'landing') {
                AuthScreens.show('landing');
                return;
              }
              // #waitlist stays reachable from the waiting room (a bookmark,
              // the back button) — the screen shows them the "already on the
              // list" note instead of the join form, which beats bouncing them.
              if (authRoute === 'waitlist') {
                AuthScreens.show('waitlist');
                return;
              }
              // The stage-2 waitlist survey stays reachable from the waiting
              // room — a gated account is exactly who "Want in sooner?" is
              // for (the link arrives in the join email).
              if (authRoute === 'more') {
                AuthScreens.show('more', authSeg);
                return;
              }
              if (!authRoute && hash) AuthScreens.rememberDeepLink(App._deepLinkTarget());
              AuthScreens.showWaiting();
              return;
            }
          }
        }
        if (authRoute) {
          AuthScreens.hideAll();
          // `_rootUrl('')`, not a bare '/': this strips the STALE AUTH HASH
          // and nothing else. A hardcoded '/' dropped the QUERY too, which
          // silently defeats `?return_to=` for the one visitor most likely
          // to be carrying it — somebody whose session snapshot outlived
          // their cookie (30 days against 7, with no sliding refresh). That
          // person boots authed from the snapshot, so App.user is truthy
          // here, reaches this line and loses the return target; only then
          // does the unawaited _reconcileSession answer 401 and reload onto
          // the already-stripped URL. They sign in with nothing to return
          // to, which is the exact bug `?return_to=` exists to prevent.
          // Every other URL write in this file goes through the same
          // serializer for the same reason.
          history.replaceState(null, '', App._rootUrl(''));
          hash = '';
        }
      }

      if (!hash) {
        App.setChromeless(false);
        if (App.currentApp) App.navigateHome();
        else if (App._inLeaderboard) App.navigateHome();
        else if (App._inProfile) App.navigateHome();
        else if (App._inAdmin) App.navigateHome();
        else if (App._inSettings) App.navigateHome();
        else if (App._inBrowse) App.navigateHome();
        else if (App._inGlobalChat) App.navigateHome();
        else {
          // Already on home (no app, no leaderboard). Don't call
          // navigateHome() — that would pushState, AppView.close(),
          // etc., none of which are appropriate when we're already
          // here. But we still want to ensure the page title is
          // correct, since this branch is reached on initial page
          // load and on any popstate/hashchange that resolves to "/".
          // Without this the title can be stuck on a previous app's
          // name if document.title was set elsewhere (e.g. a stale
          // value persisted across a Flutter WebView session).
          App._ensureHomeVisible();
          App.setHeaderTitle('Homeroom');
          Home.load();
        }
        return;
      }

      const parts = hash.split('/');
      if (parts[0] === 'create') {
        // #create — deep link that opens the create-app modal over the
        // home feed. Doubles as the addressable route the dapp.json
        // regression test for the mode toggle uses (#748).
        App.setChromeless(false);
        if (App.currentApp || App._inLeaderboard || App._inProfile
          || App._inAdmin || App._inSettings || App._inBrowse
          || App._inGlobalChat) {
          App.navigateHome();
        } else {
          App._ensureHomeVisible();
          App.setHeaderTitle('Homeroom');
          Home.load();
        }
        App.showCreateModal();
        return;
      }
      if (parts[0] === 'leaderboard') {
        App.setChromeless(false);
        // Optional sub-view segment (#leaderboard/history etc.) — pass
        // it through so deep links land on the right tab. Bare
        // #leaderboard opens the default Challenges tab (#2374), so it
        // RESETS to that tab rather than keeping whatever was last active
        // (see _routeLeaderboard). A third segment
        // on the users tab (#leaderboard/users/<username>) deep-links a
        // user profile (#60). #leaderboard/kudos, #leaderboard/topochain
        // and #leaderboard/challenges select a SECTION rather than a
        // Kudos sub-tab; #leaderboard/kudos then self-heals its hash to
        // #leaderboard/prs (and a bare #leaderboard to
        // #leaderboard/challenges) through Leaderboard._syncHash.
        const profileUser = parts[1] === 'users' && parts[2]
          ? decodeURIComponent(parts[2])
          : null;
        // #leaderboard/challenges/<eventId>[/<challengeId>] (#982) — the
        // address the profile's completed-challenge rows link to. The
        // event id is part of the path because a challenge id alone is
        // meaningless: the challenge list is fetched per season event, so
        // without it the router would have to guess which event to load.
        // Non-numeric segments resolve to null and the whole target is
        // dropped, leaving a plain #leaderboard/challenges navigation.
        const challengeTarget = parts[1] === 'challenges' && parts[2]
          ? {
            eventId: App._numericSegment(parts[2]),
            challengeId: App._numericSegment(parts[3]),
          }
          : null;
        App.navigateToLeaderboard(parts[1], profileUser, challengeTarget);
        return;
      }
      if (parts[0] === 'challenges') {
        // Legacy address of the retired #challenges screen. Challenges are
        // the Leaderboard screen's third tab now, so this is an ALIAS:
        // rewrite the address in place so a bookmark self-heals to the
        // canonical form, then hand off. The replaceState fires BEFORE the
        // navigate so Leaderboard._syncHash sees a #leaderboard hash and
        // doesn't skip its own sync.
        App.setChromeless(false);
        try {
          history.replaceState(null, '', '#leaderboard/challenges');
        } catch (err) { /* non-fatal: navigation below still works */ }
        App.navigateToLeaderboard('challenges', null);
        return;
      }
      if (parts[0] === 'profile') {
        App.setChromeless(false);
        App.navigateToProfile(parts[1] ? decodeURIComponent(parts[1]) : null);
        return;
      }
      if (parts[0] === 'workshop') {
        // The Workshop screen (#workshop): the viewer's apps with their two
        // Workshop numbers. No gate beyond the anonymous-shell branch above —
        // the counts endpoint is me-scoped server-side and answers 401 to a
        // caller with no session. No second segment: the drill-in is the
        // app's own /app/<slug>/workshop route, not a level of this screen.
        App.setChromeless(false);
        App.navigateToWorkshop();
        return;
      }
      if (parts[0] === 'apps') {
        // Browse-all-apps screen (home-screen split). No gate: the list
        // is the visibility-filtered /api/apps payload, and the
        // anonymous-shell branch above already handled a signed-out
        // visitor. An optional second segment (#apps/<slug>) deep-links
        // that app's detail page — the screen's level 2.
        App.setChromeless(false);
        App.navigateToBrowse(parts[1] ? decodeURIComponent(parts[1]) : null);
        return;
      }
      if (parts[0] === 'admin') {
        // Admin & moderation console (#818). Optional section segment
        // (#admin/users etc.) deep-links a menu section; the gate on
        // App.user.isAdmin lives inside navigateToAdminConsole.
        App.setChromeless(false);
        let _adminSection = parts[1] || null;
        // Permanent aliases for the retired "Seasons, Events & Challenges"
        // umbrella section (#1179): its screens are first-class sections
        // now, so both legacy two-level address families —
        // #admin/seasons/<screen> and the even older
        // #admin/topochain/<screen> — promote the screen segment to the
        // section segment. Everything BELOW the screen segment is owned by
        // AdminTopochain and has to survive the rewrite VERBATIM — the
        // Season-events tail (season-events/<eventId>/new-challenge/
        // <templateId>) — otherwise a deep bookmark silently lands on the
        // section's default screen or, worse, on the right screen with the
        // wrong event. The old sub-nav's own "seasons" tab collapses onto
        // the Seasons section, and a bare #admin/topochain maps there too.
        // Same idiom as the #topochain branch below: rewrite the address
        // BEFORE navigating so the module's own _syncHash sees the
        // canonical prefix, and the bookmark self-heals.
        if (_adminSection === 'topochain' || _adminSection === 'seasons') {
          const rest = parts.slice(2);
          if (rest[0] === 'seasons') rest.shift();
          _adminSection = rest.length ? rest[0] : 'seasons';
          const tail = rest.slice(1).join('/');
          const target = tail
            ? `#admin/${_adminSection}/${tail}`
            : `#admin/${_adminSection}`;
          if (location.hash !== target) {
            try {
              history.replaceState(null, '', target);
            } catch (err) { /* non-fatal: navigation below still works */ }
          }
        }
        App.navigateToAdminConsole(_adminSection);
        return;
      }
      if (parts[0] === 'settings') {
        // Settings screen (settings-modal-to-screen conversion). Optional
        // section segment (#settings/password etc.) deep-links one section;
        // no extra gate — the anonymous-shell branch above already bounced
        // a signed-out visitor to login and remembered the deep link.
        App.setChromeless(false);
        App.navigateToSettings(parts[1] || null);
        return;
      }
      if (parts[0] === 'notifications') {
        // NOT a screen any more — a sheet (Streamlined Concept). The bell is
        // in the header on every route, so a full-screen view had to answer
        // "back to where?" and answered "home", which was wrong every time it
        // was opened from somewhere else.
        //
        // The hash survives as a DEEP LINK: a push notification, a bookmark
        // and a middle-clicked bell all land here. It resolves to a real
        // screen and then opens the sheet OVER it, so the address names the
        // screen underneath rather than the overlay — which is what keeps a
        // dismiss from having to rewrite history to put the address right.
        App.setChromeless(false);
        App.openNotificationsSheet();
        return;
      }
      if (parts[0] === 'messages') {
        // Platform-wide conversations — a SCREEN again (#1443): Messages is
        // a row in the chip's menu, and everything in that menu has its own
        // page. A malformed/oversized id degrades to the
        // list without ever reaching a fetch URL. Conversations use SERIAL
        // ids, so keep their signed-int32 bound local to this route;
        // _numericSegment also serves BIGSERIAL-backed Topochain routes.
        App.setChromeless(false);
        const conversationId = App._numericSegment(parts[1]);
        App.navigateToMessages(
          conversationId != null && conversationId <= 2147483647
            ? conversationId : null
        );
        return;
      }
      if (parts[0] === 'chat') {
        // #2543: Global Chat is an ordinary, resumable platform screen. Its
        // UUID names the exact session selected from Improve; a bare #chat
        // resumes the most recent one (and creates the first when needed).
        App.setChromeless(false);
        App.navigateToGlobalChat(parts[1] || null);
        return;
      }
      if (parts[0] === 'topochain') {
        // Topochain public screens (Task 14): #topochain/leaderboard and
        // #topochain/seasons. Both are public reads under /api/v4 — no
        // auth gate, unlike #admin above.
        //
        // Both are now TABS of the Leaderboard screen, so both are
        // ALIASES: rewrite the address in place so a bookmark self-heals
        // to the canonical form, then hand off. 'seasons' -> the
        // challenges tab (its challenge grid; its event hero became that
        // screen's shared event bar); anything else, including a bare
        // #topochain, -> the standings tab. Each is rewritten straight to
        // its canonical #leaderboard/<section> — never the bare
        // #leaderboard, which opens Challenges since #2374 — so this is one
        // replaceState, not one here and a second from _syncHash. The
        // replaceState fires BEFORE the navigate so Leaderboard._syncHash
        // sees a #leaderboard hash and doesn't skip its own sync.
        App.setChromeless(false);
        const _tcSection = parts[1] === 'seasons' ? 'challenges' : 'topochain';
        try {
          history.replaceState(null, '',
            _tcSection === 'challenges' ? '#leaderboard/challenges' : '#leaderboard/topochain');
        } catch (err) { /* non-fatal: navigation below still works */ }
        App.navigateToLeaderboard(_tcSection, null);
        return;
      }
      if (parts[0] === 'app' && parts[1]) {
        const slug = parts[1];
        // Card-list hashes (#194 revision): app/{slug}/app,
        // app/{slug}/dev (the card list), app/{slug}/dev/chat (general
        // chat), app/{slug}/dev/issues/{n} / dev/proposals/{id} /
        // dev/governance/{id} (full-screen topic views), and
        // app/{slug}/dev/sessions/{id} (session view). The retired
        // dev/settings form (#645) falls through to the card list.
        // Legacy hashes — group-chat, individual-chat[/{sessionId}], and
        // the old dev/chat|issues|proposals sub-tab forms — all map onto
        // the forum so old links and notification hrefs keep working.
        let tab = parts[2] || 'app';
        let subTab = null;
        let ref = null;
        // Chromeless full-screen App view (/app/<slug>/full). Old cached
        // clients that predate this route fall into the final `else`
        // below and get the regular App tab — a graceful degrade.
        const chromeless = tab === 'full';
        if (chromeless) tab = 'app';
        // Inner-path pass-through (#743): `path` is defined as the FINAL
        // fragment-query param — its value is everything after the first
        // `path=`, verbatim in wire encoding (an inner query may carry
        // `&` / `=` / `?`, and the Caddy rescue redirect can't
        // percent-encode placeholders, so no URLSearchParams here).
        // Honored only on the chromeless route; every other route
        // ignores the fragment-query entirely.
        let innerPath = null;
        if (chromeless && fragQuery) {
          const pm = fragQuery.match(/(?:^|&)path=(.*)$/);
          if (pm) innerPath = App._validateInnerPath(pm[1]);
        } else if (chromeless && pathRoute) {
          try {
            innerPath = App._validateInnerPath(
              new URLSearchParams(location.search).get('path') || ''
            );
          } catch (_) { /* malformed query — app root is the safe fallback */ }
        }
        // App / Board / Activity are the app's three views, and the last two
        // are ONE SCREEN READ TWO WAYS: `board` is the card area as a kanban
        // of work in flight, `activity` is the same cards newest-first.
        //
        // They used to be a destination plus a layout preference underneath it
        // — the Improve panel's Kanban|Feed pair, stored in localStorage — and
        // `activity` meant the app's general chat instead. A preference that
        // changes what the screen is CALLED is a destination, so the layout
        // rides the hash now and the pair is retired. The general chat keeps
        // `dev/chat`, which is the address it always had; it is simply no
        // longer what "Activity" names.
        //
        // `boardView` is applied below rather than here because the mode has
        // to be set BEFORE the dispatch (so a cold entry paints the right
        // layout on the board's first frame) and because switching between
        // the two leaves `tab` and `subTab` identical, which nothing else
        // would notice.
        let boardView = null;
        // `activity` is the retired Activity feed's address; the Workshop
        // replaced it as the lander, so the old links land there.
        if (tab === 'workshop' || tab === 'activity') { tab = 'dev'; parts[2] = 'dev'; parts[3] = null; boardView = 'workshop'; }
        // `board` is the retired Board view's address. Those columns are the
        // Workshop's "By stage" pane now, so an old link lands on the Workshop
        // with that pane up rather than on a mode that no longer exists — the
        // same treatment `activity` gets above, one pane deeper.
        else if (tab === 'board') {
          tab = 'dev'; parts[2] = 'dev'; parts[3] = null; boardView = 'workshop';
          // TWO answers, not one: those columns are the `stage` grouping of the
          // `all` TAB, and setting the grouping alone lands on the default tab,
          // where the grouping control is not rendered at all.
          if (typeof AppView !== 'undefined' && AppView._overrideWorkshopTab) {
            AppView._overrideWorkshopTab('all');
            AppView._overrideWorkshopGroup('stage');
          }
        }
        if (tab === 'dev') {
          const sec = parts[3] || null;
          if (sec === 'sessions' && parts[4]) {
            subTab = 'sessions';
            // #2241: `new` is the unsent change (see _normalizeTab).
            ref = parts[4] === 'new' ? 'new' : (parseInt(parts[4]) || null);
          } else if (sec === 'chat') {
            // Full-screen general chat (also where legacy group-chat
            // links land — the old Chat sub-tab's original meaning).
            subTab = 'chat';
          } else if (sec === 'issues' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'issue', id: parseInt(parts[4]) || null };
          } else if (sec === 'proposals' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'proposal', id: parseInt(parts[4]) || null };
          } else if (sec === 'governance' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'gov', id: parseInt(parts[4]) || null };
          } else if (sec === 'shared' && parts[4]) {
            // A shared dev session's public discussion page (distinct
            // from dev/sessions/{id}, which is the OWNER's dev chat).
            subTab = 'topic';
            ref = { kind: 'session', id: parseInt(parts[4]) || null };
          } else {
            // dev, dev/issues, dev/proposals, dev/sessions (no id) —
            // all land on the plain card list.
            subTab = 'forum';
          }
        } else if (tab === 'group-chat') {
          tab = 'dev'; subTab = 'chat';
        } else if (tab === 'individual-chat') {
          tab = 'dev';
          subTab = parts[3] ? 'sessions' : 'forum';
          ref = parts[3] ? parseInt(parts[3]) : null;
        } else {
          tab = 'app';
        }
        if (App._inLeaderboard) App._exitLeaderboard();
        if (App._inProfile) App._exitProfile();
        if (App._inAdmin) App._exitAdminConsole();
        if (App._inSettings) App._exitSettings();
            App.setChromeless(chromeless);
        // Stash the validated inner path where renderAppTab / the token
        // refresh read it. Set on EVERY pass (null when absent) so
        // leaving chromeless — e.g. via the pill — clears it without a
        // re-render of the already-mounted iframe.
        const prevInnerPath = typeof AppView !== 'undefined'
          ? (AppView.pendingInnerPath || null) : null;
        if (typeof AppView !== 'undefined') AppView.pendingInnerPath = innerPath;
        // The Board/Activity layout, applied from the route (see the alias
        // block above). Resolved BEFORE _setViewMode writes it, because the
        // dispatch below only re-renders when something it can see changed —
        // and between /app/x/board and /app/x/activity nothing it can see
        // does.
        const boardViewChanged = !!boardView
          && typeof AppView !== 'undefined' && AppView._getViewMode
          && AppView._getViewMode() !== boardView;
        if (boardView && typeof AppView !== 'undefined' && AppView._setViewMode) {
          AppView._setViewMode(boardView);
        }
        // Hash app URLs and older clean aliases are permanent inputs, never
        // permanent outputs. Replace before dispatch so reload/copy exposes
        // the clean canonical path without manufacturing a Back entry.
        const canonicalAppUrl = App._appUrl(slug, tab, ref, subTab, {
          chromeless, innerPath, boardView,
        });
        const currentAppUrl = `${location.pathname}${location.search}${location.hash}`;
        if (currentAppUrl !== canonicalAppUrl) {
          try { history.replaceState(null, '', canonicalAppUrl); } catch (_) {}
        }
        if (App.currentApp !== slug) {
          App.navigateToApp(slug, tab, ref, subTab);
          // navigateToApp's synchronous prefix runs AppView.close() when
          // jumping app-to-app, which clears pendingInnerPath — re-stash
          // after the call (renderAppTab only runs once the awaited
          // open() inside it resolves, so this always lands in time).
          if (typeof AppView !== 'undefined') AppView.pendingInnerPath = innerPath;
        } else if (App.currentTab !== tab
            || (tab === 'dev' && App.currentSubTab !== subTab)
            // Same tab + sub-tab but a (possibly different) deep-link
            // target — re-dispatch so the accordion / session moves.
            // switchTab is idempotent, so a same-target re-render is fine.
            || (tab === 'dev' && ref != null)
            // A chromeless hash carrying a DIFFERENT inner path than the
            // one already applied — re-render so the iframe moves (#743).
            || (chromeless && innerPath !== prevInnerPath)
            // Board ⇄ Activity: same tab, same sub-tab, different layout.
            || boardViewChanged) {
          App.switchTab(tab, ref, subTab);
        }
      } else {
        // Unrecognised hash: fall back to the home feed. The screen swap
        // is explicit here because the _exitX helpers are state-only
        // (#979) — without it the screen we were on would stay painted
        // under the platform's own name.
        App.setChromeless(false);
        if (App._inLeaderboard) App._exitLeaderboard();
        if (App._inProfile) App._exitProfile();
        if (App._inAdmin) App._exitAdminConsole();
        if (App._inSettings) App._exitSettings();
            if (App._inBrowse) App._exitBrowse();
            if (App._inWorkshop) App._exitWorkshop();
        App._showOnlyScreen('home-screen');
        App.setHeaderTitle('Homeroom');
        // Home has no Improve target: clear whatever screen published one, or
        // the header button would outlive the app it was about (the lingering
        // Improve-button bug, in its unrecognised-hash variant).
        App.ImproveStatus.setAppOpen(false);
        Home.load();
      }
    } finally {
      App._isRestoring = false;
    }
  },

  // Client-side mirror of testing-notes.validatePath (see
  // src/services/testing-notes.js) for the chromeless inner path (#743):
  // relative-only (leading `/`, never `//` — protocol-relative), no
  // whitespace/control chars, and none of \ ` ' " < > — the src is
  // interpolated into an innerHTML template in renderAppTab, so the
  // blacklist is attribute-breakout defense on top of the URL-API origin
  // check in AppView.buildAppIframeSrc. Invalid → null (app root, never
  // an error).
  _validateInnerPath(p) {
    if (typeof p !== 'string') return null;
    const path = p.trim();
    if (!path || path.length > 512) return null;
    if (!path.startsWith('/') || path.startsWith('//')) return null;
    if (/[\s\\`'"<>]/.test(path)) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    return path;
  },

  // ── Chromeless full-screen mode ──────────────────────────────────────
  // Hide/show the shared header and mount/unmount the floating "Open in
  // Homeroom" pill. Idempotent; only ever driven by restoreFromHash (the
  // mode is route-addressed, so history back/forward keeps working) plus a
  // defensive clear in navigateHome.
  //
  // The App/Dev switch needs no line of its own any more — it lives
  // INSIDE #platform-header (it used to be the separate #app-tabs bar at
  // the foot of #app-view), so hiding the header hides it too.
  //
  // The bottom safe-area inset needs NO special case here any more
  // (#970). It used to: #app-view carried `un-safe-bottom` for every
  // surface, so chromeless had to strip the class to render truly
  // edge-to-edge. The inset is now surface-dependent
  // (`data-app-surface`, set by AppView._setSurface) and chromeless
  // always lands on the app surface — which reserves nothing and
  // forwards the insets into the app instead. The floating pill still
  // insets itself via env(safe-area-inset-bottom).
  //
  // Hiding the header changes #app-view's rect, so re-broadcast the
  // per-frame insets: the app's top inset is 0 while the header covers
  // it and becomes the real status-bar inset once it doesn't.
  // Both DOM effects are React's now (#1079 chunk B): #platform-header is an
  // island, and the floating pill is a component beside it
  // (frontend/src/features/header/chromeless-pill.tsx). So this publishes two
  // flags through the shell's visibility store — the ONE way a converted
  // region's visibility may be driven from outside React — and the two
  // subscribers produce exactly the DOM the classList toggle and the
  // createElement/appendChild pair used to produce by hand.
  //
  // App.chromeless itself stays here: the router (restoreFromHash, the
  // navigate* methods, the iframe surface logic) reads it on every hash
  // change, and it is a routing fact, not a rendering one. Publishing before
  // the deferred bundle has evaluated is fine — the store is a plain object
  // on window, and the islands read it on mount.
  setChromeless(on) {
    const enable = !!on;
    if (App.chromeless === enable) return;
    App.chromeless = enable;
    App.Visibility.publish('platform-header', !enable);
    App.Visibility.publish('chromeless-pill', enable);
    if (typeof AppView !== 'undefined' && AppView.scheduleSafeAreaBroadcast) {
      AppView.scheduleSafeAreaBroadcast();
    }
  },

  // The single decision point for "what animation does entering this
  // screen get?" (#977). Every navigate* method passes the type it WANTS
  // and takes back the type it gets.
  //
  // One rule: a screen swap that begins while the slide-out drawer is on
  // screen — or that a link inside the drawer just started — runs with no
  // animation at all. The drawer's own exit spring is already a motion in
  // flight, and the kit's push/pop is a View Transition over the whole
  // document root: it snapshots the open drawer and parallaxes that
  // snapshot away while the live panel springs the other way, which is
  // the two-competing-motions bug. Cutting the screen swap leaves exactly
  // one motion — the drawer leaving, revealing the destination behind it.
  // (It also matches the kit's own guidance that panels and other
  // high-frequency UI must use type:'none'.)
  //
  // The resolved type is stamped on the screen element as `data-entered`,
  // mirroring the kit's own data-un-vt. Nothing reads it at runtime — it
  // exists so the dapp.json checks can assert an ordering that is
  // otherwise only observable mid-animation.
  // It used to have a second job, and that job was the whole reason it
  // existed: suppressing the entry animation when the navigation came from
  // the hamburger drawer, because a screen animating in behind a drawer
  // springing out was two motions competing (#977). The drawer is retired,
  // so there is nothing to suppress and every screen simply gets the type its
  // caller asked for. The STAMP stays — dapp.json asserts `data-entered`,
  // which is the only way a mid-animation state is testable at all.
  _entryTransition(preferred, screenEl) {
    if (screenEl && screenEl.setAttribute) screenEl.setAttribute('data-entered', preferred);
    return preferred;
  },

  // ── Screen swap — THE ORDERING RULE (issue #979) ────────────────────
  // The mutually exclusive full-screen roots. Exactly one of these is
  // visible at a time (they are `flex-1` siblings in the body column, so
  // two visible roots split the viewport 50/50 — see the #764 note on
  // the zoom transition).
  SCREEN_IDS: ['app-view', 'home-screen', 'browse-screen',
    'workshop-screen', 'leaderboard-screen', 'profile-screen', 'admin-screen',
    'settings-screen', 'messages-screen', 'global-chat-screen'],

  // Reveal `revealId`, hide every other screen root (except any id in
  // `keepAlso`), and publish the incoming screen's default back slot.
  // Home and the Browse list share a root header (#1569); other screens
  // keep the Home button. A module's chrome sync supplies a drill-in's arrow.
  //
  // *** CALL THIS INSIDE THE PlatformUI.transition CALLBACK, NEVER
  // BEFORE IT. *** A View Transition captures the OUTGOING page at the
  // next rendering opportunity, not at the startViewTransition() call —
  // so every DOM mutation made synchronously after that call, but before
  // the callback runs, is baked into the "previous page" snapshot the
  // animation slides out. That is exactly how the settings animation
  // ended up showing the INCOMING page behind itself (#979): the sibling
  // screens were hidden and the header retitled before the snapshot
  // existed. Same rule for the header title, the back button, and the
  // drawer's app-scoped rows: they are part of the swap, so they belong
  // in the same callback. The kit already documents the analogue for its
  // zoom types ("fn reveals the incoming screen, after conceals the
  // outgoing one" — usernode-native/v1/native.js).
  _showOnlyScreen(revealId, keepAlso) {
    window.UsernodeBrowserScroll?.capture();
    const keep = keepAlso || [];
    for (const id of App.SCREEN_IDS) {
      if (id === revealId || keep.includes(id)) continue;
      App._setScreenVisible(id, false);
    }
    App._setScreenVisible(revealId, true);
    // Which root the router has REVEALED, as opposed to which roots happen to
    // be painted. `keepAlso` is the whole reason the two can differ: a screen
    // named there stays on screen after this call deliberately, so that a
    // leaving animation still has something to animate (navigateHome keeps
    // #app-view for the length of the zoom-out — the shrinking card IS that
    // element). For the whole of that window the DOM says the app view is on
    // show and the router says home is, and the router is the one that is
    // right. See Home.publishImproveTarget, whose gate reads both.
    App._revealedScreen = revealId;
    if (revealId !== 'global-chat-screen' && App._inGlobalChat) {
      App._exitGlobalChat();
    }
    // The app-entry breadcrumb's single clearer (see App._appBackHref): every
    // reveal of a screen that is not the app view ends the visit it was about.
    // `app-view` is excluded because navigateToApp does not come through here
    // at all — it reveals #app-view itself — but a `keepAlso` reveal during a
    // zoom-out would, and clearing on the way OUT of an app is right anyway.
    if (revealId !== 'app-view') App._appBackHref = null;
    // Publish the final root state directly. Showing a house and then hiding
    // it in a per-screen callback shifts the shared title slot unnecessarily.
    App.setBackIcon(revealId === 'home-screen' || revealId === 'browse-screen' ? 'none' : 'home');
  },

  // The screen root _showOnlyScreen last revealed, or null before the first
  // screen swap of the session. Deliberately NOT a visibility fact: it is the
  // route's answer, so it is correct from the first frame of a transition
  // rather than from the frame the outgoing screen is finally hidden on.
  _revealedScreen: null,

  // ── The React seam (#1078) ─────────────────────────────────────────
  // Screen roots whose markup React owns. For these, visibility is
  // PUBLISHED as data and the component renders its own `hidden` class;
  // toggling the class from here would be a write into React-owned DOM
  // that the next render reconciles away. Everything not listed keeps
  // the classList path, so converted and unconverted screens coexist for
  // the whole migration. A conversion chunk adds its id here in the same
  // commit that converts the screen.
  REACT_SCREEN_IDS: [
    // #1080 chunk C — the anonymous shell's screens, converted in order.
    'auth-landing-screen',
    'auth-login-screen',
    'auth-register-screen',
    'auth-waiting-screen',
    'auth-waitlist-screen',
    'auth-more-screen',
    // #1082 chunk E — the Admin & moderation console.
    'admin-screen',
    // #1083 chunk F — the four app/community screens, converted in order.
    'browse-screen',
    'profile-screen',
    'leaderboard-screen',
    // ...and home last. This is the first converted root that ships
    // VISIBLE, which is why _isScreenVisible below grew a DOM fallback.
    'home-screen',
    // Messages. The island has owned #messages-screen's `hidden` through
    // useVisibilityHiddenClass since #1431, which ALSO took this entry out
    // when Messages became a sheet; #1444 made it a screen again and put it
    // back in SCREEN_IDS and _showOnlyScreen — everywhere but here. So
    // _setScreenVisible took the classList path and the class had two
    // owners: app.js toggled it off, and the hook — which re-applies on
    // every publish of ANY id and reads an unpublished id as its shipped
    // (hidden) state — put it back on whichever fetch-driven publish came
    // next. Six declared checks failed by arrival order on proposals that
    // had not touched Messages. Listed, app.js publishes and React applies:
    // one owner. tests/react-screen-ids-consistency.test.js pins the rule
    // for every screen root at once.
    'messages-screen',
    // Global Chat (#2543). It is a normal hash-routed screen now, so the
    // router publishes visibility through the same single-owner seam.
    'global-chat-screen',
    // Workshop (#workshop). React-owned end to end from the day it shipped —
    // features/workshop/index.tsx takes useVisibilityHiddenClass, so it has to
    // be listed here or the class gets the two owners the note above describes.
    'workshop-screen',
  ],

  // The publish/read half of that seam. The state is a plain object on
  // `window` because load order demands it: these classic scripts run
  // before the deferred React module, so app.js routes — and publishes —
  // first. The identical factory lives in
  // frontend/src/lib/visibility-store.ts; keep the two in sync.
  Visibility: {
    _store() {
      let store = window.__usernodeVisibility;
      if (!store) {
        store = { visible: Object.create(null), listeners: new Set() };
        window.__usernodeVisibility = store;
      }
      return store;
    },
    publish(id, visible) {
      const store = App.Visibility._store();
      if (store.visible[id] === visible) return;
      store.visible[id] = visible;
      // Copy first: a listener unsubscribing mid-notification would
      // otherwise mutate the set being iterated.
      for (const listener of [...store.listeners]) {
        try { listener(); } catch (e) { console.error('[visibility] listener failed', e); }
      }
    },
    // `undefined` when nothing has published it yet — deliberately not
    // `false`, so a converted region can fall back to whatever its
    // markup shipped with rather than flashing hidden on first render.
    read(id) { return App.Visibility._store().visible[id]; },
  },

  /**
   * The two "we are STAYING on home" branches of restoreFromHash say so
   * rather than assuming it.
   *
   * Both deliberately skip navigateHome() — it would pushState and close the
   * app view, neither of which is right when nothing is moving — and both
   * therefore relied on `#home-screen` already being visible, which was true
   * only because the prerendered document ships it that way.
   *
   * `_applyBootScreen` retired that guarantee: it hides home the moment the
   * address names anywhere else, and a guess it is allowed to get wrong (the
   * device's session record is display-only and can be stale) landed exactly
   * here — signed out by the record, signed in by the cookie, so the boot
   * screen revealed the landing page, enterAuthed's hideAll() took it away
   * again, and this branch left a blank document behind. Fourteen home checks
   * failed at once, which is what a shared assumption looks like when it
   * stops holding.
   *
   * A no-op on every path that was already correct, and the repair on the one
   * that was not. Cheaper than navigateHome() in exactly the way those
   * branches wanted.
   */
  _ensureHomeVisible() {
    if (App._revealedScreen === 'home-screen') return;
    App._setScreenVisible('home-screen', true);
    App._revealedScreen = 'home-screen';
  },

  // Show/hide one screen root through whichever half owns it.
  _setScreenVisible(id, visible) {
    if (App.REACT_SCREEN_IDS.includes(id)) { App.Visibility.publish(id, visible); return; }
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  },

  // Is a screen root on screen? Reads the store for converted roots and
  // the DOM for the rest, so callers don't have to know which is which.
  //
  // An UNPUBLISHED converted root falls back to the DOM rather than
  // answering `false`. That is the read-side half of what `undefined`
  // means in the store (see Visibility.read): "still showing whatever the
  // markup shipped with". It only started to matter with #home-screen —
  // every earlier converted root ships hidden, so store-says-nothing and
  // DOM-says-hidden agree — and home reaches the steady state where
  // nothing has published: the no-hash branch of restoreFromHash is
  // already-on-home, so it calls Home.load() without a screen swap.
  // Without the fallback every `_isScreenVisible('home-screen')` guard
  // (the WS app-event refreshes here, build-log.js, notifications.js)
  // would read false on a plain "/" boot and the grid would stop
  // live-updating. The island renders `hidden` from the same store with
  // the same shipped-visible default, so the two never disagree.
  _isScreenVisible(id) {
    if (App.REACT_SCREEN_IDS.includes(id)) {
      const published = App.Visibility.read(id);
      if (published !== undefined) return published === true;
    }
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden');
  },

  // The chrome every platform screen (leaderboard / profile / browse /
  // admin / settings) enters with: the header's back button visible, the
  // drawer's app-scoped rows hidden, the drawer's build/fork footer
  // closed. The per-screen title is set by the caller right after this,
  // so `setHeaderTitle('<Screen>')` stays greppable at each call site.
  // Same ordering rule as _showOnlyScreen: inside the transition
  // callback only.
  _enterScreenChrome() {
    // #back-btn visibility is setBackIcon's alone — the blanket reveal that
    // lived here fought it. Three modes now, and the default DRAWS a house,
    // so a screen entering through here gets its way out from the
    // setBackIcon('home') in _showOnlyScreen rather than from anything here.
    // The GitHub and Share drawer rows were hidden by hand here. Both are
    // Improve panel rows now, and setAppOpen(false) below clears the panel's
    // target — which retires them for the same reason and in one move.
    //
    // #1406 used to re-publish the PLATFORM target right after this clear, so
    // the improve button and the view selector survived onto settings,
    // profile and messages. The Streamlined Concept takes the other side of
    // that decision on purpose: a platform screen carries a plain title and
    // an empty right slot — navigation lives in the drawer, and the title
    // tab means "an app context is on screen", which these screens are not.
    App.ImproveStatus.setAppOpen(false);
  },

  // Show the Leaderboard screen. Sibling to navigateToApp/navigateHome —
  // hides home + app, reveals the dedicated #leaderboard-screen, lets
  // the Leaderboard module render the tab strip and hand the standings /
  // challenges panes to TopochainLeaderboard / TopochainChallenges (it
  // renders the Kudos pane into #leaderboard-root itself).
  //
  // `sub` is the hash's second segment: 'prs' | 'users' | 'history'
  // select a Kudos sub-tab, and the SECTION values 'topochain' (the
  // standings tab), 'kudos' and 'challenges' (the default) select a whole
  // section instead. `profileUser` (#60) opens the per-user PR profile
  // drill-in instead of a plain tab.
  // A hash segment that must be a positive integer id, or nothing. Returns
  // null for anything else (empty, '12abc', '-1', a username) so a
  // hand-typed or truncated address degrades to the plain screen rather
  // than sending NaN into a fetch URL.
  _numericSegment(raw) {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  },

  navigateToLeaderboard(sub, profileUser, challengeTarget) {
    // Already mounted: an in-screen change (a tab, the deep-linked
    // section, a user drill-in), not a screen entry — hand it to the
    // module instead of replaying the whole swap. Same idiom as
    // navigateToBrowse / navigateToAdminConsole / navigateToSettings,
    // and load-bearing for the entry animation (#979): a fragment
    // navigation fires BOTH popstate and hashchange, so restoreFromHash
    // runs twice in one tick, and without this guard the second run's
    // mutation lands while the first run's View Transition is still
    // pending — the kit applies it instantly, i.e. BEFORE the outgoing
    // page is captured, which is exactly how the incoming screen ended
    // up painted behind its own entry animation.
    if (App._inLeaderboard && window.Leaderboard?.isOpen?.()) {
      App._routeLeaderboard(sub, profileUser, challengeTarget);
      if (window.Leaderboard?.open) Leaderboard.open();
      return;
    }
    // Same iframe caveat as navigateHome: no animated snapshot over a
    // live App-tab iframe.
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    // The app teardown is a VISIBLE mutation (it blanks the drawer's
    // build/fork slots and resets the dev-chat panes), so it rides in the
    // transition callback below; only the flag flips synchronously, since
    // navigateToApp's async tail reads it as "what is on screen now".
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    // Screen reveal + chrome, all inside the transition callback so the
    // outgoing page is snapshotted as it actually looked (#979).
    const screen = document.getElementById('leaderboard-screen');
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('leaderboard-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Leaderboard');
      // NO DEAD ENDS: every screen the viewer can reach shows a way back.
      // The hamburger used to be that way — it was on every bar, and it held
      // the nav rows — so these screens shipped with the back slot hidden.
      //
      // This was `arrow` with no href, which RESOLVED to home: the right
      // destination drawn as the wrong glyph, a chevron promising a level
      // above where there is none. The house says the same thing honestly,
      // and it is the default, so the explicit call goes entirely — see the
      // 'home' publish in _showOnlyScreen. Left here as a comment because
      // "why does this screen not set its own back state" is a fair question
      // to have an answer to.
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
    App._inLeaderboard = true;
    App._routeLeaderboard(sub, profileUser, challengeTarget);
    if (window.Leaderboard?.open) Leaderboard.open();
  },

  // Apply the deep-linked section / sub-view / user profile before open()
  // renders — _setSection and _setSub both validate their value and no-op
  // on garbage. openProfile must run INSTEAD of _setSub (not after):
  // _setSub clears profile state and would replaceState the profile hash
  // away. When the screen is already open they re-render in place; the
  // open() each caller runs afterwards dedupes the in-flight load.
  //
  // #1146: the address is the source of truth on ENTRY, including the
  // absence of a segment. A bare #leaderboard means Challenges, the default
  // tab (#2374) — the declared check "Bare #leaderboard renders all three
  // tabs and opens on Challenges (#962, #2374)" says so — but the module
  // remembers its last section for the session, so arriving here from
  // #leaderboard/topochain would leave the standings up. Cold loading hides
  // it (a fresh module starts on 'challenges'); a sibling-fragment
  // hash switch, which is how the grouped capture runner reaches every
  // cohort of a document, does not. Reset explicitly so both arrivals render
  // the same screen. _setSection early-returns when the section is already
  // current, so the common case costs nothing.
  _routeLeaderboard(sub, profileUser, challengeTarget) {
    if (profileUser && window.Leaderboard?.openProfile) {
      Leaderboard.openProfile(profileUser);
    } else if (!sub && window.Leaderboard?._setSection) {
      Leaderboard._setSection('challenges');
    } else if ((sub === 'topochain' || sub === 'kudos' || sub === 'challenges')
               && window.Leaderboard?._setSection) {
      // Register the challenge deep link BEFORE the section mounts (#982).
      // Selecting the event first means the pane's very first fetch is
      // already for the right event — ordering it after _setSection would
      // load the default event, then throw that list away and reload.
      if (sub === 'challenges' && challengeTarget
          && window.TopochainChallenges?.openFromHash) {
        TopochainChallenges.openFromHash(
          challengeTarget.eventId, challengeTarget.challengeId
        );
      }
      Leaderboard._setSection(sub);
    } else if (sub && window.Leaderboard?._setSub) {
      Leaderboard._setSub(sub);
    }
  },

  // State-only teardown (#979): hiding #leaderboard-screen is the job of
  // the incoming navigation's _showOnlyScreen call, INSIDE its transition
  // callback — hiding it here would delete the outgoing page before the
  // View Transition has captured it.
  _exitLeaderboard() {
    App._inLeaderboard = false;
    if (window.Leaderboard?.close) Leaderboard.close();
  },

  // navigateToChallenges / _exitChallenges used to live here (the
  // app-as-SV-chrome migration's #challenges screen). Challenges are a TAB
  // of the Leaderboard screen now, so they have no navigate/exit pair of
  // their own: #challenges aliases onto
  // navigateToLeaderboard('challenges') in restoreFromHash, and
  // _exitLeaderboard tears down all three panes.

  // Show the profile screen (profile-and-settings-to-web migration).
  // Sibling to navigateToLeaderboard — hides home + app, reveals the
  // dedicated #profile-screen, lets the Profile module render itself
  // into #profile-root.
  navigateToProfile(username = null) {
    // Already mounted: nothing to swap, just re-render in place. Same
    // reason as navigateToLeaderboard's guard above — popstate AND
    // hashchange both reach restoreFromHash, and a second entry run would
    // apply its mutation before the first run's View Transition captured
    // the outgoing page (#979).
    if (App._inProfile && window.Profile?.isOpen?.()) {
      App._routeMountedProfile(username);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    const screen = document.getElementById('profile-screen');
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('profile-screen');
      App._enterScreenChrome();
      App.setHeaderTitle(username ? `@${username}` : 'Profile');
      // A HOUSE ON THE ACCOUNT SCREENS, not nothing and not a chevron.
      //
      // Profile, Settings and Admin & moderation lost the arrow once, on the
      // reasoning that they form a stack of their own (Home → Profile →
      // Settings/Admin) whose own rows are the way back up. What that left
      // was three screens with nothing in the bar at all — and "every page
      // should have a back or a home button, except Home" is the rule now.
      //
      // The arrow does not come back: these screens have no level above them
      // that is not home, and a chevron would promise one. The house is the
      // honest glyph, and it is what `'home'` DRAWS now rather than a synonym
      // for hidden (see features/header/back-button-store.js). The call is
      // kept explicit even though _showOnlyScreen publishes the same default
      // a moment earlier: this is the screen where the question was asked.
      App.setBackIcon('home');
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
    App._inProfile = true;
    if (window.Profile?.open) Profile.open(username);
  },

  // A hash change between the signed-in profile editor and a public
  // profile is a level change inside the already-visible profile screen,
  // not a new screen entry. Keep it out of the global transition gate so
  // drawer navigation still has exactly one transition per screen entry.
  _routeMountedProfile(username) {
    App.setHeaderTitle(username ? `@${username}` : 'Profile');
    if (window.Profile?.open) Profile.open(username);
  },

  // State-only (#979) — see _exitLeaderboard.
  _exitProfile() {
    App._inProfile = false;
    if (window.Profile?.close) Profile.close();
  },

  // Show the browse-all-apps screen (#apps). Sibling to
  // navigateToProfile — hides home + app, reveals #browse-screen, lets
  // the Browse module (public/js/browse.js) render into #browse-list.
  //
  // No permission gate: the grid is built from GET /api/apps, which is
  // already visibility-filtered per viewer, and restoreFromHash's
  // anonymous-shell branch bounced a signed-out visitor to login before
  // this can run. The top-level header matches Home, which stays accessible
  // through the navigation menu. Browser/OS back returns here from an app
  // opened out of this grid, because the screen has its own hash entry.
  navigateToBrowse(slug) {
    // Already mounted: this is an in-screen level change (#apps ↔
    // #apps/<slug>, the back button, a hand-typed hash), not a screen
    // entry. Hand it to the module — re-running the screen swap below
    // would re-hide every sibling and replay the entry animation on what
    // is really a level change. Same idiom as navigateToAdminConsole.
    if (App._inBrowse && window.Browse?.isOpen?.()) {
      Browse.route(slug || null);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inWorkshop) App._exitWorkshop();
    const screen = document.getElementById('browse-screen');
    App._inBrowse = true;
    // Renders into the still-hidden screen; `chrome: false` holds back its
    // level-dependent title/back-icon so the header only changes inside
    // the transition callback below (#979).
    if (window.Browse?.open) Browse.open(slug || null, { chrome: false });
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('browse-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('All apps');
      // Browse owns the header title / back icon for whichever level the
      // slug selected, so its sync runs after setHeaderTitle above.
      if (window.Browse?.syncChrome) Browse.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the detail
  // level borrowed is handed back by the next screen's _showOnlyScreen.
  _exitBrowse() {
    App._inBrowse = false;
    if (window.Browse?.close) Browse.close();
  },

  // The Workshop screen (#workshop): every app you have, with how much of its
  // own Workshop page is addressed to you.
  //
  // A SCREEN, not a sheet, on the same reasoning #1443 gave Messages: it is
  // a row in the chip's menu, and the rule for that menu is that everything
  // in it has its own page. It is also what the surface IS — a place you
  // start from and drill into, which is the shape a screen has and an overlay
  // does not.
  //
  // The re-entry guard exists because popstate AND hashchange both reach
  // restoreFromHash, so a second run would replay the entry animation on what
  // is already on screen (#979). There is no level below #workshop — the
  // drill-in is the app's OWN route — so it has nothing to route and simply
  // returns.
  //
  // `_inWorkshop` IS NOT ENOUGH ON ITS OWN, and neither is the controller's
  // `isOpen()`. Both stay true while the viewer is inside an app they opened
  // from here: nothing on the way into an app clears either, because
  // navigateToApp reveals #app-view through the kit's `after` callback rather
  // than through an exit chain. A guard built on one of them alone would
  // refuse to come BACK — the one navigation this screen exists to support.
  //
  // `App.currentApp` is what separates the two. It is the slug while an app
  // is on screen and this method nulls it synchronously, so "on the Workshop"
  // is the pair: the flag set, and no app open. Both halves are written
  // BEFORE the transition, which is what the double-run needs — popstate and
  // hashchange land in the same tick, and `_revealedScreen` is not assigned
  // until the callback runs, so it would let the second run straight through.
  navigateToWorkshop() {
    if (App._inWorkshop && !App.currentApp) return;
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inMessages) App._exitMessages();
    const screen = document.getElementById('workshop-screen');
    App._inWorkshop = true;
    // Loads into the still-hidden root: the island renders nothing remote
    // until these fetches land, so the screen is revealed empty and fills,
    // exactly as Home and Browse do.
    window.UsernodeReact?.workshop?.open?.();
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('workshop-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Workshop');
      // The house, like every other platform screen: there is no level above
      // this one that is not home. _showOnlyScreen has already published the
      // same default; the call is kept explicit because this is the screen
      // whose back slot the change is about.
      App.setBackIcon('home');
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard.
  _exitWorkshop() {
    App._inWorkshop = false;
    window.UsernodeReact?.workshop?.close?.();
  },

  // Where an app view was entered FROM, when that origin is a screen with a
  // level of its own to go back to. Null everywhere else, which is every
  // route the platform had before #workshop: an app reached from Home, a
  // notification or a cold deep link has no level above it but home, and the
  // house is the honest glyph for that (see features/header/back-button-store.js).
  //
  // Exactly one writer (navigateToApp, below) and exactly one clearer
  // (_showOnlyScreen, which runs on every reveal of a NON-app-view root and so
  // ends the app visit this breadcrumb was about). AppView._repaintDevBody
  // reads it on the Dev lander and turns it into `setBackIcon('arrow', href)`,
  // which is also what enables the native back gesture — see
  // features/header/native-back-navigation.ts, whose predicate is exactly
  // "arrow, with an href, and not the App tab".
  _appBackHref: null,

  // Sections of the admin console that were PUBLIC pages before #860
  // folded them in (/status and /node-status). A signed-in non-admin who
  // follows one of those old links still gets them — everything else in
  // the console, including bare #admin, still bounces a non-admin home.
  // Must stay in sync with the `public: true` flags in
  // AdminConsole.SECTIONS (public/js/admin-console.js).
  ADMIN_PUBLIC_SECTIONS: ['status', 'node'],

  // Show the admin & moderation console (#818, extended by #860). Sibling
  // to navigateToProfile — hides home + app, reveals the dedicated
  // #admin-screen, lets the AdminConsole module render itself into
  // #admin-root. Gate: App.user.isAdmin, which covers BOTH full and
  // view-only admins (see renderAdminButton above) — a hand-typed #admin
  // from a non-admin bails to home. The "View as non-admin" preview masks
  // App.user.isAdmin at boot, so preview mode is covered by the same
  // check. Every /api/admin/* endpoint the page calls is independently
  // enforced server-side.
  //
  // The one exception is PUBLIC MODE: a non-admin asking for #admin/status
  // or #admin/node gets the console mounted with only those two sections
  // in the menu and the header reading "Platform status". The data they
  // see is the same sanitized /api/status payload the old public /status
  // page served them (src/services/status.js redact()), so this widens no
  // boundary — it only keeps the old public URLs working.
  navigateToAdminConsole(section) {
    const isAdmin = !!App.user?.isAdmin;
    const publicMode = !isAdmin && App.ADMIN_PUBLIC_SECTIONS.includes(section);
    if (!isAdmin && !publicMode) {
      App.navigateHome();
      return;
    }
    // Already mounted: this is an in-console navigation (a mobile drill-in,
    // the back button, a hand-typed section hash), not a screen entry. Hand
    // it to the console — re-running the screen swap below would re-hide
    // every sibling screen and replay the entry push animation on what is
    // really a level change inside one screen. Deliberately AFTER the gate
    // above so it can never be used to bypass it.
    if (App._inAdmin && window.AdminConsole?.isOpen?.()) {
      AdminConsole.route(section, { public: publicMode });
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    const screen = document.getElementById('admin-screen');
    App._inAdmin = true;
    // Renders into the still-hidden screen; `chrome: false` holds its
    // section title / back arrow back for the callback below (#979).
    if (window.AdminConsole?.open) {
      AdminConsole.open(section, { public: publicMode, chrome: false });
    }
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('admin-screen');
      App._enterScreenChrome();
      App.setHeaderTitle(publicMode ? 'Platform status' : 'Admin & moderation');
      if (window.AdminConsole?.syncChrome) AdminConsole.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the mobile
  // section view borrowed is handed back by the next screen's
  // _showOnlyScreen.
  _exitAdminConsole() {
    App._inAdmin = false;
    if (window.AdminConsole?.close) AdminConsole.close();
  },

  // Show the Settings screen (settings-modal-to-screen conversion). Sibling
  // to navigateToAdminConsole — hides home + app, reveals the dedicated
  // #settings-screen and lets the Settings module (public/js/settings.js)
  // render its sidebar / two-level menu into the static shell in
  // index.html. No permission gate: Settings is every signed-in user's own
  // account surface, and restoreFromHash's anonymous-shell branch already
  // bounced a signed-out visitor to login (remembering the deep link).
  navigateToSettings(section) {
    // Already mounted: this is an in-screen navigation (a mobile drill-in,
    // the back button, a hand-typed section hash), not a screen entry. Hand
    // it to the module — re-running the screen swap below would re-hide
    // every sibling screen and replay the entry push animation on what is
    // really a level change inside one screen.
    if (App._inSettings && window.Settings?.isOpen?.()) {
      Settings.route(section);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    const screen = document.getElementById('settings-screen');
    App._inSettings = true;
    // Renders every section into the still-hidden screen — invisible, so
    // it may stay synchronous (which keeps Settings.isOpen() truthful for
    // the re-entry guard above). `chrome: false` holds back the one
    // VISIBLE thing it does: writing the header title / back icon, which
    // now happens inside the transition callback (#979).
    if (window.Settings?.open) Settings.open(section, { chrome: false });
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('settings-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Settings');
      // Runs after app.js's own setHeaderTitle, so on a mobile deep link
      // the header ends up showing the section's name rather than
      // "Settings".
      if (window.Settings?.syncChrome) Settings.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the mobile
  // section view borrowed is handed back by the next screen's
  // _showOnlyScreen.
  _exitSettings() {
    App._inSettings = false;
    if (window.Settings?.close) Settings.close();
  },

  // The Messages SHEET's deep-link resolver (Streamlined Concept).
  //
  // `#messages` and `#messages/<id>` were addresses for a SCREEN, and that
  // screen's back arrow had to answer "back to where?" from a chat bubble
  // that is in the header on every route. It is a sheet now, so the hash is
  // a deep link only: resolve a real screen (home, on a cold boot), present
  // over it, and put the address back — an overlay must never be what the
  // URL names, or a dismiss would leave a stale address behind.
  //
  // The `navigateToMessages` name is kept below because push handling and
  // notifications.js's conversation rows still say it.
  navigateToMessages(conversationId) {
    const messages = window.UsernodeReact?.messages;
    if (App._inMessages && messages?.isOpen?.()) {
      messages.route?.(conversationId || null);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    const screen = document.getElementById('messages-screen');
    App._inMessages = true;
    // Route the still-hidden island first. It renders no remote data until its
    // effects resolve, and chrome remains suspended until the callback below.
    messages?.route?.(conversationId || null);
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('messages-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Messages');
      messages?.syncChrome?.();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only teardown; the incoming transition hides the root.
  _exitMessages() {
    App._inMessages = false;
    window.UsernodeReact?.messages?.close?.();
  },

  // Global Chat is a first-class screen whose individual sessions have
  // stable #chat/<uuid> addresses. The React store owns transcript loading;
  // this classic router owns the same screen swap and chrome as every other
  // platform page.
  navigateToGlobalChat(threadId) {
    const globalChat = window.UsernodeReact?.globalChat;
    if (App._inGlobalChat && globalChat?.isOpen?.()) {
      globalChat.route?.(threadId || null);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    if (App._inMessages) App._exitMessages();
    const screen = document.getElementById('global-chat-screen');
    App._inGlobalChat = true;
    globalChat?.route?.(threadId || null);
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('global-chat-screen');
      App._enterScreenChrome();
      if (typeof Home !== 'undefined') Home.publishImproveTarget();
      App.setHeaderTitle('Chat');
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only teardown. _showOnlyScreen has already hidden the React root
  // in the incoming transition callback before this clears its live request.
  _exitGlobalChat() {
    App._inGlobalChat = false;
    window.UsernodeReact?.globalChat?.deactivate?.();
  },

  // The Notifications SHEET's deep-link resolver (Streamlined Concept).
  //
  // `#notifications` is an address for a SCREEN — there has to be one under
  // the sheet, because a sheet is an overlay and an overlay over nothing is a
  // blank page. So: if a screen is already showing, keep it and just present;
  // on a cold boot straight to this hash there is nothing yet, so go home
  // first. Either way the address is then REPLACED with the screen's own, so
  // the hash never names the overlay and a dismiss has no history to undo.
  //
  // The `navigateToNotifications` name is kept because push handling, the
  // `?shot=notifications` capture path and app.js's own callers all say it.
  // A SHEET IS NOT AN ADDRESS, so a deep link to one has to leave the bar
  // naming the screen underneath. Two halves:
  //
  //   1. There has to BE a screen. On a cold boot straight to #notifications
  //      nothing is up yet, and an overlay over a blank page is a blank page.
  //      (#messages used to need this too; it is a SCREEN again as of #1443,
  //      so it has an address of its own and never borrows one.)
  //   2. The address goes back to what that screen's address is — which is
  //      exactly what `updateHash` computes, and why this does not build one
  //      by hand. A hand-built `#app/<slug>/app` was wrong the moment the
  //      screen underneath was a dev session: it claimed the app's default
  //      view and threw the session's own address away.
  //
  // `updateHash` REPLACES rather than pushes when the screen id is unchanged,
  // so this leaves no history entry of its own for a dismiss to have to undo.
  //
  // ONE TICK LATER, and that is not a nicety: both callers run from inside
  // `restoreFromHash`, which holds `_isRestoring` for its whole body — and
  // `updateHash` returns early while that is set, precisely so a router pass
  // cannot fight the address it is currently reading. The flag clears in that
  // function's `finally`, so a task scheduled here is the first moment the
  // rewrite is allowed to land.
  _restoreAddressUnderSheet() {
    const onAScreen = App.currentApp || App.SCREEN_IDS.some(App._isScreenVisible);
    if (!onAScreen) {
      App.navigateHome();
      return;
    }
    setTimeout(() => {
      try { App.updateHash(); } catch (err) { /* opaque origin — the sheet still opens */ }
    }, 0);
  },

  openNotificationsSheet() {
    App._restoreAddressUnderSheet();
    App.openNotifications();
  },

  /** Present the sheet. The one call every entry point funnels through. */
  openNotifications() {
    window.NotificationsSheet?.open?.();
  },

  navigateToNotifications() {
    App.openNotificationsSheet();
  },

  // navigateToTopochainLeaderboard / _exitTopochainLeaderboard used to
  // live here (Task 14, public screens). The Topochain leaderboard is a
  // TAB of the Leaderboard screen now, so it has no navigate/exit pair of
  // its own: #topochain/leaderboard aliases onto
  // navigateToLeaderboard('topochain') in restoreFromHash, and
  // _exitLeaderboard tears down all three panes.
  //
  // Same for navigateToTopochainSeasons / _exitTopochainSeasons: the
  // seasons screen's challenge grid is the Leaderboard screen's third tab
  // and its event hero is that screen's shared event bar, so
  // #topochain/seasons aliases onto navigateToLeaderboard('challenges').

  // Push a new history entry on real screen transitions (entering an
  // app, switching tabs, going home) so the WebView builds a real
  // back stack; replace in-place when only secondary state changes
  // within the same screen (e.g. selecting a different dev-chat
  // session inside the individual-chat tab) — otherwise every session
  // click would add an entry the user has to back through.
  //
  // "Screen" here = the `/app/<slug>/<view>` prefix; the optional final
  // record id is intentionally NOT part of the screen id.
  updateHash(options) {
    if (App._isRestoring) return;
    const opts = options || {};

    let newUrl;
    if (App.currentApp) {
      let ref = opts.ref;
      let boardView = opts.boardView;
      if (App.currentTab === 'dev') {
        if (ref == null && App.currentSubTab === 'sessions'
            && typeof DevChat !== 'undefined' && DevChat.currentSession) {
          // #2241: an unsent change has no id, and `null` here would
          // normalize the whole route back to the board — so it serializes
          // as the word the router reserves for it.
          ref = DevChat.currentSession.id
            || (DevChat.currentSession.pending ? DevChat.NEW_SESSION_REF : null);
        } else if (ref == null && App.currentSubTab === 'topic'
            && typeof AppView !== 'undefined' && AppView._devTopic) {
          ref = AppView._devTopic;
        }
        if (!boardView && App.currentSubTab === 'forum') {
          boardView = typeof AppView !== 'undefined' && AppView._getViewMode
            && AppView._getViewMode() === 'kanban' ? 'kanban' : 'workshop';
        }
      }
      const innerPath = (App.chromeless && typeof AppView !== 'undefined'
        && AppView.pendingInnerPath) || null;
      newUrl = App._appUrl(
        App.currentApp, App.currentTab, ref, App.currentSubTab,
        { chromeless: App.chromeless, innerPath, boardView }
      );
    } else {
      // Home: drop the fragment entirely — but keep the query string. In
      // staging previews the shell-injected ?token= lives there, and the
      // WS connects re-read it as an auth fallback (see connectEvents /
      // GroupChat._openSocket).
      newUrl = App._rootUrl();
    }

    const currentFull = `${location.pathname}${location.search}${location.hash}`;
    if (currentFull === newUrl) return;

    // Screen ids: every full-screen sub-view (chat, topics, sessions)
    // is its own screen — list ↔ sub-view pushes a history entry, so
    // device/browser back mirrors the in-page back buttons — but which
    // session/topic isn't part of the id (moving between two topics of
    // the same kind replaces in place).
    const SUB_SCREENS = new Set(['sessions', 'chat', 'issues', 'proposals', 'governance', 'shared']);
    const screenIdOf = (value) => {
      let parsed;
      try { parsed = new URL(String(value || ''), location.origin); } catch (_) { return ''; }
      // A legacy hash outranks its pathname, exactly as restoreFromHash does.
      const route = parsed.hash
        ? parsed.hash.replace(/^#/, '').split('?')[0]
        : parsed.pathname.replace(/^\/+/, '');
      const segs = route.split('/');
      // Aliases (see restoreFromHash): /app/x/board and /app/x/workshop (and
      // the retired /app/x/activity) are all the card area, so an alias in
      // the address bar and the canonical form updateHash computes are the
      // SAME screen — replace, never a spurious push. The two are one screen
      // as far as history goes for the same reason Kanban|Feed never pushed
      // an entry: switching layout is not somewhere to go BACK from.
      if (segs[0] === 'app' && (segs[2] === 'workshop' || segs[2] === 'activity' || segs[2] === 'board')) {
        segs.splice(2, 1, 'dev');
      }
      if (segs[0] === 'app' && segs[2] === 'dev') {
        return SUB_SCREENS.has(segs[3])
          ? segs.slice(0, 4).join('/')
          : segs.slice(0, 3).join('/');
      }
      return segs.slice(0, 3).join('/');
    };
    const sameScreen = screenIdOf(currentFull) === screenIdOf(newUrl);

    if (opts.replace || sameScreen) {
      history.replaceState(null, '', newUrl);
    } else {
      history.pushState(null, '', newUrl);
    }
  },

  // ── Create-app dialog ─────────────────────────────────────────────
  // #1078 chunk I moved the whole thing — mode, visibility, the import
  // pre-flight sub-state machine and the POST — into
  // frontend/src/features/dialogs/create-app.tsx, where seven functions that
  // read each other's state out of the document became four useState calls.
  // This entry point stays because the home screen's empty-state and "+"
  // buttons (frontend/src/features/home/home.js) and the #create deep link
  // call `App.showCreateModal()` by name.
  showCreateModal() {
    window.UsernodeReact?.dialogs?.create?.open();
  },

  // ── Homescreen zoom transition ─────────────────────────────────────
  // Opening an app expands the app view out of the clicked tile's
  // on-screen rect (iOS-homescreen style) and Back shrinks it into the
  // tile again — the kit's 'zoom-in'/'zoom-out' transition types (#740;
  // this replaced the platform's hand-rolled _zoom* implementation).
  // The kit owns the pitfalls: pinning the LIVE #app-view as a fixed
  // overlay (no View Transition snapshot, so the app-iframe caveat
  // doesn't apply), the opaque --un-zoom-bg surface, exact inline-style
  // restore, and the fallback to push/pop or an instant cut when the
  // tile isn't on screen or the user prefers reduced motion.
  //
  // One pitfall needs a hint from us (#764): #app-view and #home-screen
  // are flex:1 siblings in the body column, so while BOTH are visible
  // (fn reveals app-view, home stays beneath the zoom) they split the
  // height 50/50 and the kit would measure app-view's destination as
  // the bottom half — the zoom then landed there and snapped to full
  // size when `after` hid home. Passing `outEl: #home-screen` lets the
  // kit hide it for the synchronous pre-paint measurement, so the zoom
  // targets app-view's true settled rect (full screen in chromeless
  // mode, the band between header and tab bar otherwise).

  // The home tile for `slug`, or null. A hidden home screen or
  // filtered-away tile yields no element / a 0×0 rect, which the kit
  // rejects — so the old home-visible checks live in the kit now.
  //
  // Scoped to the two authed launcher grids that still render icon TILES —
  // #app-list (home's "Your apps") and #home-featured-list (home's
  // featured row). NOT the anonymous landing directory (#landing-apps),
  // which renders `.app-card[data-slug]` tiles too and lives in this same
  // document after a reload-free login; and NOT #browse-list, which
  // renders app-store `.browse-row` rows rather than tiles, so there is no
  // tile rect to zoom out of there (the kit falls back to a push).
  //
  // Whichever grid the tap came from is the one whose tile is on screen,
  // so a single query across both lands on the right rect.
  _tileFor(slug) {
    try {
      const sel = CSS.escape(slug);
      return document.querySelector(
        `#app-list .app-card[data-slug="${sel}"], `
        + `#home-featured-list .app-card[data-slug="${sel}"]`
      );
    } catch { return null; }
  },

  // The screen the app view is expanding OUT of — home normally, the
  // browse screen when the tap came from there. The kit needs it twice:
  // as `outEl` (hidden for the synchronous pre-paint measurement so the
  // flex-sibling split doesn't skew the destination rect) and in `after`
  // (concealed once the zoom lands). Getting this wrong leaves the
  // outgoing grid painted behind the opened app.
  //
  // It must name whichever screen root is ACTUALLY visible, not just the
  // two launcher grids (#979): since the _exitX helpers became state-only,
  // the settings / admin / profile / leaderboard roots stay visible until
  // the transition callback runs, so opening an app straight out of one of
  // them (a work notification, a deep link) would otherwise leave that
  // root in the flex flow and skew the zoom's destination rect (#764).
  //
  // Read from the DOM rather than the _inX flags on purpose: callers reach
  // here both before and after those flags are cleared (restoreFromHash
  // runs the exits itself), and "which root is on screen" is exactly the
  // question the kit is asking. Home is the fallback — it's the root that
  // ships visible.
  _departingScreen() {
    for (const id of App.SCREEN_IDS) {
      if (id === 'app-view') continue;
      if (App._isScreenVisible(id)) return document.getElementById(id);
    }
    return document.getElementById('home-screen');
  },

  // Origins we've already asked the browser to connect to this page-load.
  // Preconnect is a hint, not a promise — repeating it per hover is just
  // noise, and one entry per app origin is a handful of strings.
  _preconnected: {},

  // #931: warm the two things a launch would otherwise wait on, on
  // pointerdown/hover — before the click even resolves:
  //
  //   1. The iframe token. AppView._mintToken is single-flight with a 60s
  //      freshness window, so the launch a moment later finds it in hand and
  //      can assign the iframe src synchronously in the tap's own tick.
  //      Deliberately NOT refreshToken(): that writes iframeToken /
  //      iframeTokenSlug, and merely hovering app B must not repoint the
  //      token held for the app that is currently OPEN (a token refresh or
  //      re-render for app A would then build a tokenless src).
  //   2. The TCP+TLS handshake to the app's origin, via preconnect. Every
  //      app lives on its own subdomain, so this is a fresh connection the
  //      first time — the one part of the launch the client can't overlap
  //      with anything else once the request is already out.
  //
  // Best-effort throughout: a miss just means the launch does the work
  // itself, exactly as it did before.
  prewarmApp(slug) {
    if (!slug || !window.AppView) return;
    const rec = AppView.launchRecordFor(slug);
    if (!rec || rec.demo || rec.self_hosted || rec.status !== 'running' || !rec.url) return;
    if (window.Offline && Offline.isOffline()) return;
    try { AppView._mintToken(slug); } catch (err) { /* ignore */ }
    try {
      const origin = new URL(resolveDevHost(rec.url), location.origin).origin;
      if (origin === location.origin || App._preconnected[origin]) return;
      App._preconnected[origin] = true;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      // No `crossorigin`: an iframe DOCUMENT load uses the credentialed
      // connection pool, and a preconnect made with crossorigin (anonymous)
      // warms the *other* pool — the socket would go unused.
      link.href = origin;
      document.head.appendChild(link);
    } catch (err) { /* unparseable url — nothing to warm */ }
  },

  _appNavigationGeneration: 0,
  _appLoad: null,

  async navigateToApp(slug, tab, ref, subTab) {
    const generation = ++App._appNavigationGeneration;
    // Clean up whatever app we had mounted. This is a no-op on the first
    // navigation into any app, but without it a direct app-A → app-B
    // jump (e.g. via hash) would carry the previous app's dev-chat
    // session state into the new view.
    //
    // Deliberately NOT deferred into the reveal callback the way the
    // screen navigations defer theirs (#979): restoreFromHash re-stashes
    // AppView.pendingInnerPath immediately after this call *because* this
    // teardown clears it (#743), and the outgoing page here is the other
    // app's, which the incoming app view covers either way.
    if (App.currentApp && App.currentApp !== slug) {
      AppView.close();
    }
    App.currentApp = slug;
    // Commit the destination while the click is still synchronous. App.open
    // may wait on metadata and the iframe may never load; neither is a reason
    // for the address bar to keep naming Home. A cached launcher record lets
    // the self-app choose Board immediately; an uncached cold visit is safely
    // normalised with replaceState after metadata arrives.
    let requestedTab = tab;
    if (!requestedTab) {
      let launchRecord = null;
      try { launchRecord = AppView.launchRecordFor?.(slug) || null; } catch (_) {}
      requestedTab = launchRecord?.self_hosted ? 'dev' : 'app';
    }
    const initialRoute = App._normalizeTab(requestedTab, ref, subTab);
    App.currentTab = initialRoute.tab;
    App.currentSubTab = initialRoute.tab === 'dev'
      ? (initialRoute.subTab || 'forum') : null;
    App.updateHash({ ref: initialRoute.ref });
    // Resolved BEFORE the _exitX flags are cleared — _departingScreen
    // reads them to name whichever screen root is actually on screen.
    const departing = App._departingScreen();
    // Resolved here for the same reason `departing` is: the _exitX flags below
    // are what says which screen the viewer is coming FROM. The Workshop
    // screen is the one origin with a level of its own to return to, so
    // entering an app from it leaves the Dev lander a real ← rather than the
    // house (AppView._repaintDevBody reads this). `_inWorkshop` is left set:
    // the next screen entry clears it, and _showOnlyScreen
    // clears this the moment any non-app root is revealed.
    //
    // A BARE FRAGMENT, not a resolved URL. #back-btn's click handler follows
    // its own href only when it `startsWith('#')` — anything else falls
    // through to navigateHome, which is the fallback for a screen that named
    // no parent, and an arrow that went home would be a lie. Set as the
    // anchor's href it reads as `/app/<slug>/workshop#workshop`, which
    // restoreFromHash's mixed-address healing rewrites to `/#workshop`, so a
    // middle-click into a new tab lands on the screen too.
    App._appBackHref = App._inWorkshop ? '#workshop' : null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    // Retire the directory's detail/back state as we leave. Otherwise its
    // hidden detail page intercepts the app's Home button, and returning to
    // #apps takes the in-screen shortcut without revealing the directory.
    // This exit is state-only; `departing` stays painted for the transition.
    if (App._inBrowse) App._exitBrowse();
    // Real screen navigation. From a launcher grid (home's "Your apps" /
    // featured row, or the #apps browse screen) the app view expands out
    // of the clicked tile (kit 'zoom-in'); from anywhere else (deep link,
    // history restore, tile off-screen, reduced motion) the kit falls
    // back to its native push.
    //
    // #931: the app frame IS mounted here now — beginLaunch runs inside the
    // reveal callback, so the app's document request goes out before the
    // zoom's first frame and the app loads *during* the animation instead of
    // after it. It mounts behind an opaque cover (the app's own icon and
    // name), so the zoom still animates a stable surface rather than a
    // half-painted iframe, and the cover cross-fades away the moment the
    // frame loads — often mid-zoom. Putting the call inside `fn` rather
    // than before the transition keeps it correct on the `push` fallback
    // too: either way it runs exactly when #app-view is revealed.
    // The departing screen stays visible beneath the zoom (fn reveals,
    // `after` conceals — kit contract).
    // #977: reachable from the drawer too (the footer's "Forked from"
    // link opens the source app), so the zoom goes through the same
    // single-motion gate — 'none' still runs fn + after as one mutation.
    const appViewEl = document.getElementById('app-view');
    PlatformUI.transition(() => {
      App._setScreenVisible('app-view', true);
      // Best-effort: returns false (and changes nothing) for anything whose
      // App tab wouldn't be a plain production iframe — self-hosted apps,
      // demo cards, non-running apps, an explicit non-app tab, offline.
      try { AppView.beginLaunch(slug, tab); } catch (err) { /* fall back to the plain path */ }
    }, {
      type: App._entryTransition('zoom-in', appViewEl),
      el: document.getElementById('app-view'),
      fromEl: () => App._tileFor(slug),
      // The outgoing screen: the kit hides it while measuring the
      // destination so the flex-sibling split doesn't skew the target
      // rect (see the comment block above).
      outEl: departing,
      fallback: 'push',
      // Conceal EVERY other screen root, not just `departing`: the _exitX
      // helpers no longer hide theirs (#979), so a screen entered before
      // this app would otherwise stay painted behind it.
      after: () => { App._showOnlyScreen('app-view'); },
    });
    // Intentionally NOT setting the header to `slug` here. Slugs are
    // generated as `${name}-${randomHex}` (see routes/apps.js), so a
    // slug-as-placeholder shows up to users as something like
    // "whiteboard-abc123" — which the Flutter WebView's AppBar then
    // mirrors via document.title. Leaving the previous header title
    // in place during the brief /api/apps/:slug round-trip is much
    // better UX: from home you see "Homeroom" briefly, then "Whiteboard";
    // from app A to app B you see "App A" briefly, then "App B". The
    // user never sees the raw slug.
    //
    // The display name lands once the await below resolves (see the
    // `AppView.appData?.name` block).

    // A route that NAMES a dev tab is not going to build the app iframe, so
    // it does not wait for the token mint (AppView.open's `needsToken`).
    // `!!tab` is load-bearing: without an explicit tab, `initialRoute.tab`
    // came from the launcher's cached record above, and a stale record must
    // never be what decides that an App-tab render can skip its token.
    const load = {
      slug,
      promise: AppView.open(slug, { needsToken: !(tab && initialRoute.tab === 'dev') }),
    };
    App._appLoad = load;
    try {
      await load.promise;
    } finally {
      if (App._appLoad === load) App._appLoad = null;
    }

    // The user can navigate away (back to home, into a different app,
    // to the leaderboard) while `AppView.open(slug)` is still resolving
    // its /api/apps/:slug fetch. Without this guard the rest of the
    // setup below would clobber the header title, re-show the
    // GitHub/Share icons, and force-switch the tab on the screen the
    // user has since moved to. `App.currentApp` is updated synchronously
    // at the top of every navigate* method, so it's the canonical
    // "what's actually on screen right now" signal.
    if (App.currentApp !== slug) return false;

    // After app data is loaded, swap header to the display name — unless a
    // Dev view owns the title by now (Streamlined Concept: Activity / Board
    // name themselves; the app's name lives on the center tab's sheet).
    if (AppView.appData?.name && App.currentTab !== 'dev') {
      App.setHeaderTitle(AppView.appData.name);
    }

    // "View on GitHub" and "Share app" were drawer rows revealed by hand
    // here — the first when the app had a repo_url, the second only for an
    // app with a real running URL (one in `creating`/`error`/
    // `awaiting_secrets` has nothing to share, and the SSE handler above
    // re-enables it on the flip to `running`). Both are Improve panel rows
    // now, and setAppOpen below carries the same two facts as `repoUrl` and
    // `canShare`, so the panel decides what to draw from one publish.
    //
    // Publish the app-open lifecycle for the Improve panel and the fork
    // lineage. A particular dApp's SHA is intentionally not shown in the
    // platform-information footer.
    App.ImproveStatus.setAppOpen(true);
    // Members & approvals moved from the drawer into the Dev tab's "+"
    // menu (#645) — AppView._plusMenuShowsMembers() is the single gate.
    // The App tab iframes appData.url, which doesn't resolve for the self-
    // hosted platform row (no per-slug subdomain). Land on the Dev forum
    // instead — that's where votes/discussion happen and what users
    // actually want when they open the self-app.
    const defaultTab = AppView.appData?.self_hosted ? 'dev' : 'app';
    const finalTab = tab || defaultTab;
    const actualFinalTab = finalTab === 'app' && AppView.appData?.self_hosted
      ? 'dev' : finalTab;
    // A notification may have requested a different item in this same app
    // while metadata was loading. Finish the shared setup above, but leave
    // that newer caller in charge of the destination.
    if (generation !== App._appNavigationGeneration) return false;
    return App.switchTab(finalTab, ref, subTab, {
      // A provisional App path becoming the self-hosted Board is one logical
      // navigation. Replace it so Back returns to the launch origin in one go.
      replaceRoute: App._normalizeTab(actualFinalTab, ref, subTab).tab
        !== initialRoute.tab,
    });
  },

  navigateHome() {
    App.setChromeless(false);
    const leavingSlug = App.currentApp;
    // Iframe caveat (spec): View Transitions snapshot the outgoing
    // page, and a live app iframe in that snapshot can flash on iOS
    // Safari. The kit 'zoom-out' transform-animates the LIVE view (no
    // snapshot), so it's iframe-safe; the fallback still cuts
    // instantly when leaving the App tab's iframe.
    const fallbackType = (App.currentApp && App.currentTab === 'app') ? 'none' : 'pop';
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    if (App._inWorkshop) App._exitWorkshop();
    // Preferred: shrink the app view back into its home tile (kit
    // 'zoom-out': fn reveals home beneath the pinned overlay, `after`
    // hides the app view and clears its content — exactly once on
    // every path, so the shrinking overlay keeps showing the app's
    // content until it lands).
    //
    // The screen the viewer is LEAVING (settings, admin, a grid…) is
    // hidden in `fn`, not in `after` (#979): on the pop fallback `fn` runs
    // after the View Transition captured it, so it still slides away with
    // its own content; and on the real zoom-out there is no snapshot at
    // all, so it must go before the pinned card starts moving or two
    // `flex-1` siblings would split the height behind it ('zoom-out'
    // ignores `outEl`, so the kit can't correct for that). #app-view is
    // the one root kept alive into `after` — that IS the shrinking card.
    const av = document.getElementById('app-view');
    PlatformUI.transition(() => {
      AppView.close();
      App._showOnlyScreen('home-screen', ['app-view']);
      // …and the GitHub / Share rows retire with the panel's target, rather
      // than being hidden one by one as drawer rows were. This clears the
      // app's target; the line below immediately republishes home's own.
      App.ImproveStatus.setAppOpen(false);
      // Home's Improve button is the PLATFORM's (#1367). Published here so
      // backing out of an app swaps the target in the same frame the app's
      // was cleared, rather than leaving a gap until the next grid paint.
      // This is a re-publish, NOT the only publish — that was the bug the
      // first attempt shipped, where home had a button on the return paths
      // and none on a cold boot at `/`. Home.render() is what makes it
      // consistent; see Home.publishImproveTarget.
      if (typeof Home !== 'undefined') Home.publishImproveTarget();
      App.setHeaderTitle('Homeroom');
    }, {
      type: App._entryTransition('zoom-out', av),
      el: av,
      fromEl: () => (leavingSlug ? App._tileFor(leavingSlug) : null),
      fallback: fallbackType,
      after: () => {
        av.classList.add('hidden');
        // #1084 chunk G: the Dev surfaces are React-rendered into an interim
        // root on #app-content, so clear that root before blanking the node —
        // otherwise its store subscription and effects outlive the screen.
        AppView._teardownDevRoots();
        // #1085 chunk H: and drop the React-owned app frame, for the same
        // reason and at the same moment. It is unmounted HERE rather than in
        // AppView.close() (which runs in `fn`, at the START of the zoom)
        // precisely so the shrinking card keeps showing the app until it
        // lands — the same reason #app-content is blanked here and not there.
        AppView._unmountAppFrame();
        const content = document.getElementById('app-content');
        if (content) content.innerHTML = '';
      },
    });
    App.updateHash();
    Home.load();
  },

  // Which affordance the header's single back button presents. 'home' (the
  // default for every screen) shows the house icon and leaves the current
  // screen entirely; 'arrow' shows the chevron and means "up one level
  // inside this screen" — currently only the mobile admin console's
  // section view, which is what #back-icon-arrow in index.html was
  // shipped for. Always reset to 'home' when leaving the screen that
  // asked for the arrow (see _exitAdminConsole).
  //
  // #1036: the control is a real <a href>, so this also owns its TARGET.
  // `href` is where the button would go if pressed — omit it and it
  // defaults to home, which is correct for every ROOT screen — profile,
  // leaderboard, notifications, messages, settings, admin, browse all point
  // there now, because nothing else offers a way off them since the hamburger
  // went. The screens that claim the chevron as "up one level" instead
  // (Browse detail, the mobile section views of Settings / the Admin console,
  // a message thread, a dev session) pass their own up-level hash. Because App._showOnlyScreen calls this
  // on EVERY screen change, there is no state in which the href can go
  // stale — same reasoning that makes the icon itself reliable.
  setBackIcon(mode, href) {
    const arrow = mode === 'arrow';
    // THREE modes now (features/header/back-button-store.js): 'arrow' is a
    // level up, 'home' is the house, and 'none' hides the slot outright.
    // Home and the top-level Browse list use 'none' for their shared root
    // header (#1569). Other screens keep the default Home button, or an arrow
    // when they have a level above them.
    const slot = arrow ? 'arrow' : (mode === 'none' ? 'none' : 'home');
    const target = href || (window.NavLink ? NavLink.homeHref() : '/');
    // The slot is React's (features/header/platform-header.tsx), so its
    // appearance is PUBLISHED, not written: a rendered className belongs to
    // React, and it rewrites the attribute from its own props on every
    // render of that island — which silently undid the classList writes
    // below the moment the header gained state (the app glyph, the session
    // status pill). See features/header/back-button-store.js.
    const published = typeof window.UsernodeReact?.backButton?.set === 'function';
    window.UsernodeReact?.backButton?.set?.(slot, target);
    // ONE OWNER, and once the bridge exists it is React's. The writes below
    // were kept as a belt-and-braces fallback on the theory that they would
    // agree with the render — and they do not always, which is worse than
    // either owner alone. The header derives the DEV-SESSION arrow from the
    // route now (see features/header/platform-header.tsx), so on that route
    // React renders the anchor visible while a later `setBackIcon('home')`
    // from a screen-swap would re-add `hidden` behind React's back — React
    // never corrects it, because its own props did not change. That is a
    // staging-only race (locally the swap lands before the store publishes)
    // and it is exactly what kept the two session-bar checks flaking.
    if (published) return;

    // Pre-hydration only: app.js is a classic script and the bundle is a
    // module, so there is a window in which the bridge does not exist yet
    // and the first navigation's back state would otherwise be dropped.
    const btn = document.getElementById('back-btn');
    if (btn) {
      // Only 'none' hides the anchor now; the other two both draw a glyph and
      // differ in WHICH. Hidden means the chip sits flush left, because the
      // group collapses with it.
      btn.classList.toggle('hidden', slot === 'none');
      btn.setAttribute('href', target);
      document.getElementById('back-icon-arrow')?.classList.toggle('hidden', !arrow);
      document.getElementById('back-icon-home')?.classList.toggle('hidden', arrow);
    }
  },

  // Mirror the visible header text into both the on-screen <h1> and
  // the browser tab title so the OS/window surface reflects the
  // current screen (home → "Homeroom", app open → app display name,
  // leaderboard → "Kudos leaderboard"). The browser tab title is
  // also used by Notifications._updateTitle() to prepend an unread
  // count "(N) "; we re-invoke it here so a navigation that happens
  // while there are pending notifications keeps the badge.
  //
  // Inside the Flutter WebView, the native AppBar mirrors
  // `document.title`. Flutter's `_refreshPageTitle` only re-reads the
  // title at navigation moments (onPageFinished + onUrlChange). Most
  // of our title sets are *after* a `pushState` (in navigateHome) or
  // *before* one (in navigateToApp, since setHeaderTitle runs before
  // `switchTab → updateHash → pushState`), but the AppBar still ends
  // up one navigation behind in practice — the getTitle() round-trip
  // races with the next JS task, and the result is that the AppBar
  // shows the title that was current at the *previous* pushState.
  // To pin the AppBar to whatever we just set, we also fire-and-forget
  // a `titleChanged` message over the existing Homeroom JS channel.
  // The native side handles it by setting `_pageTitle` directly
  // (see lib/features/dapps/dapp_webview_screen.dart). Older app
  // builds that don't know `titleChanged` ignore the message
  // (Flutter logs and drops unknown methods), so this is safe to ship
  // ahead of the Flutter rebuild.
  // `subtitle` is the destination WITHIN the screen the title names — the
  // Board and Activity screens pass it so the chip can keep saying which app
  // you are in (see header-title-store.js). Every other call site omits it and
  // gets the previous behaviour, including the clear: the bridge coerces the
  // missing argument to '', so navigating from a board to a root screen drops
  // the subtitle rather than leaving it stranded under the new title.
  //
  // `document.title` joins them the other way round: "Notes \u00b7 Board", widest
  // scope first, because a browser tab and the native AppBar truncate from the
  // RIGHT, so the app's name is the half that must survive. The separator is a
  // middle dot, not a dash — tests/no-em-dash-in-copy.test.js bans the em dash
  // in shipped copy and calls a plain hyphen a typo, and `\u00b7` is what this
  // file already joins title fragments with elsewhere.
  setHeaderTitle(text, subtitle) {
    // Streamlined Concept: #header-title is React-owned now
    // (frontend/src/features/header/app-switcher-chip.tsx renders it as the
    // tappable app-context tab), so the text goes through the bridge into
    // header-title-store — never a direct textContent write, which React
    // would reconcile away.
    window.UsernodeReact?.headerTitle?.set?.(text, subtitle);
    document.title = subtitle ? `${text} · ${subtitle}` : text;
    // Re-apply the dev-chat status marker ("⏳ thinking / ✅ done",
    // #108) that the plain title assignment above just wiped, then let
    // Notifications re-apply its "(N) " unread prefix outermost.
    if (window.DevChat && typeof DevChat.applyTitleStatus === 'function') {
      DevChat.applyTitleStatus();
    }
    if (window.Notifications && typeof Notifications._updateTitle === 'function') {
      Notifications._updateTitle();
    }
    try {
      if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
        window.Usernode.postMessage(JSON.stringify({
          method: 'titleChanged',
          // Use the final title (with the optional "(N) " unread prefix
          // that Notifications._updateTitle just applied) so the AppBar
          // matches what a desktop browser tab would show.
          value: document.title,
        }));
      }
    } catch (_) {
      // Non-critical — title sync via JS channel is just a fast path
      // for the native shell. Falling back to webview_flutter's
      // onUrlChange path is fine for desktop browsers.
    }
  },

  // Normalize every tab vocabulary onto the forum-era model (#194
  // revision). Returns { tab, subTab, ref } where tab ∈ 'app'|'dev' and
  // subTab ∈ 'forum'|'sessions'. Legacy names (group-chat,
  // individual-chat, and the old dev sub-tabs chat/issues/proposals)
  // keep working at every entry point — old sub-tab refs are converted
  // into typed forum deep links ({ kind: 'issue'|'proposal', id }).
  _normalizeTab(tab, ref, subTab) {
    if (tab === 'group-chat') { tab = 'dev'; subTab = 'chat'; }
    else if (tab === 'individual-chat') { tab = 'dev'; subTab = subTab || 'sessions'; }
    if (tab !== 'dev') return { tab: 'app', subTab: null, ref: null };

    if (subTab === 'sessions') {
      // #2241: `new` is the one session ref that is a WORD rather than an
      // id — /app/<slug>/dev/sessions/new is the change you have not sent
      // yet, which has no row and therefore no id to be addressed by. It
      // needs a route of its own precisely because of the line below: a
      // session sub-tab with no ref normalizes to the card list, so a
      // screen with nothing to name could not be navigated to at all.
      // DevChat.NEW_SESSION_REF holds the only other copy of this literal.
      if (ref === 'new') return { tab: 'dev', subTab: 'sessions', ref: 'new' };
      const id = (ref && typeof ref === 'object') ? ref.id : parseInt(ref, 10);
      // No session id → the card list (there is no session-list screen).
      return Number.isInteger(id) && id > 0
        ? { tab: 'dev', subTab: 'sessions', ref: id }
        : { tab: 'dev', subTab: 'forum', ref: null };
    }

    // Full-screen sub-views with no deep-link payload. (The 'settings'
    // sub-page is gone — #645 — so old dev/settings requests fall
    // through to the card list below.)
    if (subTab === 'chat') return { tab: 'dev', subTab: 'chat', ref: null };

    // A typed topic ref — from the 'topic' sub-view itself or the
    // legacy issues/proposals sub-tab vocabulary — opens that topic
    // full-screen; everything else lands on the card list.
    let fref = null;
    if (ref && typeof ref === 'object' && ref.kind && ref.id) {
      fref = { kind: ref.kind, id: ref.id };
    } else if (ref != null && subTab === 'issues') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'issue', id };
    } else if (ref != null && subTab === 'proposals') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'proposal', id };
    }
    return fref
      ? { tab: 'dev', subTab: 'topic', ref: fref }
      : { tab: 'dev', subTab: 'forum', ref: null };
  },

  // `ref` is the view's deep-link target: a dev-session id for the
  // session view, or { kind: 'issue'|'proposal', id } for a forum card
  // to expand. Ignored on the App tab.
  async switchTab(tab, ref, subTab, options) {
    const norm = App._normalizeTab(tab, ref, subTab);
    tab = norm.tab;
    subTab = norm.subTab;
    ref = norm.ref;
    // The App tab is hidden for self-hosted apps (its iframe target doesn't
    // resolve — see app-view.js renderAppTab). Coerce any incoming request
    // for it (URL hash, browser back/forward, programmatic) to the Dev
    // forum so we never render an unreachable iframe.
    if (tab === 'app' && AppView.appData?.self_hosted) {
      tab = 'dev';
      subTab = 'forum';
      ref = null;
    }
    // #771: a docked staging preview is pinned to the dev-chat session
    // layout, which every tab switch re-renders or unmounts — close it.
    // (A fullscreen preview keeps floating above the tabs, as before.)
    // open=false first so closeStagingOverlay skips its own chat
    // re-render; the switch repaints the destination view anyway.
    if (typeof AppView !== 'undefined' && AppView._stagingMode === 'docked'
        && AppView.closeStagingOverlay) {
      if (typeof DevChat !== 'undefined' && DevChat.stagingPanel) DevChat.stagingPanel.open = false;
      AppView.closeStagingOverlay();
    }
    // #621: the Dev mode is visible to non-collaborators too, read-only
    // (see AppView.readOnly).
    App.currentTab = tab;
    App.currentSubTab = tab === 'dev' ? (subTab || 'forum') : null;
    if (tab !== 'app') AppView._stopStatusPolling?.();
    // The `.app-mode-seg` repaint that used to sit here went with the switch
    // itself. There IS a control reflecting the active tab again — the
    // App/Feed/Kanban toggle (#1367) — but it is React-rendered from the
    // Improve store, so this publishes the fact instead of repainting a node:
    // one owner for the attribute, which is the whole ownership rule.
    window.Improve?.setTab(tab, App.currentSubTab);

    // Leaving the Sessions sub-tab. The cross-app active-sessions POLL used
    // to be torn down here; it and the panel it drove are retired (#1367),
    // so what is left is the two pieces of per-session state that are scoped
    // to "the user is on the dev-chat tab".
    const onSessions = tab === 'dev' && App.currentSubTab === 'sessions';
    if (!onSessions && typeof DevChat !== 'undefined') {
      // The title status indicator (#108) is scoped to "user is on the
      // dev-chat tab" — leaving the tab clears it. Re-entering while a
      // run is live re-applies it via openSession's busy check.
      if (DevChat.setTitleStatus) DevChat.setTitleStatus(null);
      // #161: switching away from a still-streaming dev session counts
      // as leaving it — arm its completion notification.
      if (DevChat.isStreaming && DevChat.currentSession && DevChat._setNotifyOnDone) {
        DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
      }
    }

    if (tab === 'app') {
      // The session screen's ← is renderDevView's; leaving Dev for the app
      // itself must take it back down (sub-view hops never pass
      // _showOnlyScreen, the usual owner of this reset).
      App.setBackIcon('home');
      AppView.renderAppTab();
    } else {
      await AppView.renderDevView(App.currentSubTab, ref);
    }

    // Dev console icon: only meaningful when an iframe is on screen. The
    // App tab mounts the production iframe (when status==='running'); the
    // chat tabs do not. Staging overlay manages its own toggle.
    if (window.DevConsole) {
      const showForApp = tab === 'app' && AppView.appData?.status === 'running';
      DevConsole.setButtonVisible(showForApp);
    }

    // #970: the switch changed which surface is mounted, so #app-view's
    // rect (and therefore the frame's own insets) may have changed.
    if (AppView.scheduleSafeAreaBroadcast) AppView.scheduleSafeAreaBroadcast();

    App.updateHash({ replace: !!options?.replaceRoute, ref });
  },

  // Explicit navigation entry point for in-app deep links (e.g. clicking
  // a notification) that must render even when the target route equals
  // the current one. Unlike assigning `location.hash`, this never relies
  // on a `hashchange` event firing — a same-value hash assignment fires
  // nothing, which is why notification clicks to the app/tab you're
  // already viewing used to do nothing. Mirrors restoreFromHash's
  // app/tab dispatch, plus a force-rerender branch for same app+tab.
  openAppTab(slug, tab, opts) {
    if (!slug) return;
    // This entry point always means the ordinary platform view. In particular,
    // the chromeless pill calls it while App.chromeless is still true; clear
    // that flag before switchTab serializes the destination or it would write
    // `/full` straight back and leave the platform header hidden.
    App.setChromeless(false);
    const ref = opts && opts.sessionId != null ? opts.sessionId
      : (opts && opts.ref != null ? opts.ref : null);
    const subTab = (opts && opts.subTab) || null;
    if (App.currentApp !== slug) {
      return App.navigateToApp(slug, tab, ref, subTab);
    } else {
      // Same app: switchTab normalizes legacy names, re-renders, and
      // syncs the clean route — idempotent when nothing changed, a forced
      // refresh when the target equals the current view.
      const generation = ++App._appNavigationGeneration;
      const load = App._appLoad;
      if (load && load.slug === slug) {
        return load.promise.then(() => {
          if (App.currentApp !== slug ||
              generation !== App._appNavigationGeneration) return false;
          return App.switchTab(tab, ref, subTab);
        });
      }
      return App.switchTab(tab, ref, subTab);
    }
  },
};

window.App = App;

// #1038: stale-tab recovery for live session state. A tab that was
// backgrounded (or a laptop that slept, or a phone that locked) can have
// missed every `session_state` push while its socket was frozen, and comes
// back showing a spinner for a turn that finished an hour ago. Reconcile on
// the way back in — throttled by SessionState.FOREGROUND_STALE_MS so
// alt-tabbing doesn't spam the endpoint.
//
// Deliberately global rather than per-screen: the cog is in the header on
// every route, so no single view owns this. Both events matter —
// visibilitychange fires on browser-tab switches, focus on window-to-window
// switches where the tab stays "visible" throughout.
App._foregroundResync = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (window.SessionState) SessionState.syncIfStale?.();
};
// Guarded: app.js is loaded into bare vm sandboxes by several unit tests,
// which stub `document` / `window` with only the members they need.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', App._foregroundResync);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('focus', App._foregroundResync);
}

// ── The FIRST screen, decided before anything hydrates ─────────────────
//
// The prerendered document ships `#home-screen` visible and every other root
// hidden, because a static render has no route to read. public/sw.js then
// serves that document to every navigation it can win, so the home feed was
// the first thing painted on EVERY address — a board deep link, a settings
// link, a signed-out visitor headed for the marketing page.
//
// Measured on a 4x-throttled cold load of `/app/<slug>/board`: home visible at
// 263ms and the app view finally taking over at 2225ms. Two seconds of
// watching the wrong page, and home's own skeleton filling in halfway through
// made it worse — a screen that is visibly working is a screen you believe.
//
// THIS RUNS AT MODULE SCOPE, NOT ON DOMContentLoaded, and that is the whole
// point. app.js is a classic script at the end of <body>; the React entry is a
// deferred module, so everything here happens BEFORE the first React render.
// Hydration is the real floor — it landed at ~2000ms in that same trace — so a
// correction applied after it (the seam lib/shell-snapshot-apply.ts uses)
// would buy almost nothing. This is the earliest moment the roots exist.
//
// BOTH HALVES, ALWAYS: the store publish AND the class. Publishing alone would
// leave React rendering `hidden` over a document that still says visible,
// which is a hydration mismatch — a console error, and a console error on any
// route fails proposal checks. Writing the class alone would be a write into
// React-owned DOM that its first render reconciles away. Doing both means the
// DOM and React's first render agree, which is exactly what the shared store
// exists for (features/header/../lib/visibility-store.ts).
App._applyBootScreen = function _applyBootScreen() {
  let target = null;
  try {
    target = App._bootScreenFor(
      location.hash, location.pathname, !!App.readSessionSnapshot()
    );
  } catch (err) { return; }
  if (!target || target === 'home-screen') return;
  App._revealBootScreen('home-screen', false);
  App._revealBootScreen(target, true);
};

/**
 * Show or hide one root through BOTH owners — see the note above.
 * `_setScreenVisible` cannot be reused here: it deliberately picks one half.
 */
App._revealBootScreen = function _revealBootScreen(id, visible) {
  if (App.REACT_SCREEN_IDS.includes(id)) App.Visibility.publish(id, visible);
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', !visible);
};

/**
 * The screen root an address lands on, or null to leave the prerender alone.
 *
 * A COARSE mirror of restoreFromHash, deliberately not a second copy of it: it
 * answers one question — which of the roots ends up visible — and every
 * sub-route inside a screen resolves to that screen. Anything it has not heard
 * of returns null and keeps today's behaviour rather than inventing a guess.
 *
 * It is ALLOWED TO BE WRONG. The session record is display-only and can be
 * stale (an expired cookie), so a signed-out viewer may see the app view for
 * the moment before the router sends them to the landing screen — which is
 * what happens today anyway, from home instead. A wrong guess costs what every
 * route already costs; a right one, which is the common case since people
 * return to where they were, costs nothing.
 */
App._bootScreenFor = function _bootScreenFor(hash, pathname, signedIn) {
  const frag = String(hash || '').replace(/^#/, '');
  const head = frag.split('/')[0] || '';
  // An app address is a fragment OR a clean path — the router reads both
  // (`_appRouteFromPath`), and it folds them into ONE `hash` before deciding
  // anything, so this has to as well. Reading only the fragment sent a
  // signed-out visitor opening `/app/<slug>` to the marketing page, because
  // an empty fragment looked like the bare root.
  const appPath = /^\/app\/[^/]/.test(String(pathname || ''));

  // A PUBLIC profile needs no session and is the one address that resolves to
  // the same screen either way, so it is answered before the split.
  if (head === 'profile' && frag.split('/')[1]) return 'profile-screen';

  // The anonymous shell owns the whole document when there is no session, so
  // it outranks the route — and the four cases below are restoreFromHash's
  // own, in its order. The last one is the easy one to get wrong: a signed-out
  // DEEP LINK does not land on the marketing page, it lands on LOGIN, with the
  // address remembered for after ("'/' → landing, deeper paths → login", which
  // is the parity with the old static documents the router notes).
  if (!signedIn) {
    if (head === 'login' || head === 'signup') return 'auth-login-screen';
    if (head === 'register') return 'auth-register-screen';
    if (head === 'waitlist') return 'auth-waitlist-screen';
    // No route at all, and 'waiting' — which the router redirects to landing
    // for a viewer with no session to be waiting on. `appPath` is why this
    // asks about the ROUTE and not the fragment.
    if ((head === '' && !appPath) || head === 'waiting') return 'auth-landing-screen';
    return 'auth-login-screen';
  }

  if (head === 'app' || appPath) return 'app-view';

  switch (head) {
    case '': return null;                    // home: the prerender is right
    case 'apps': return 'browse-screen';
    case 'profile': return 'profile-screen';
    case 'settings': return 'settings-screen';
    case 'admin': return 'admin-screen';
    case 'messages': return 'messages-screen';
    case 'chat': return 'global-chat-screen';
    case 'leaderboard': return 'leaderboard-screen';
    default: return null;                    // #notifications is a sheet over home
  }
};

// GUARDED, because this is a module-scope side effect in a file a dozen test
// harnesses load as a plain script into a `vm` context with a stub document.
// Those stubs are not obliged to have `getElementById`, and a throw here would
// take the whole file down before `App` was ever published — which is exactly
// what happened the first time this shipped unguarded. A boot screen is a
// nicety; the router is not.
try {
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    App._applyBootScreen();
  }
} catch (err) { /* no usable DOM — the router still routes, one paint later */ }

document.addEventListener('DOMContentLoaded', () => App.init());
