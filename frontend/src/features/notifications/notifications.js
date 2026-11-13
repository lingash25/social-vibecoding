// Top-right notifications dropdown.
//
// MOVED, NOT REWRITTEN (#1079 chunk B). This was public/js/notifications.js —
// a classic <script> — until #notifications-panel became a React island. The
// body is unchanged so the rendered rows stay byte-identical (dapp.json
// selects against them); only the two window publications at the bottom and
// the init() trigger moved. It is plain .js rather than .ts deliberately: a
// mechanical retype of 1,300 lines of untyped DOM code would hide the "this is
// the same module" property that makes the move reviewable, and the tests that
// load this file in a vm keep working unchanged.
//
// The panel's chassis (root, header row, the three leaf containers) is
// rendered by ./index.tsx. This module owns everything INSIDE those
// containers — it is now the only writer, since no public/js/** module
// reaches into them.
//
// Lifecycle:
//  - init() wires the bell button + dropdown controls, does the initial
//    /api/notifications fetch (so the badge is correct on page load even
//    if all pending notifs were queued while the user was offline).
//  - handleIncoming() is called by app.js when a `notification_new`
//    WS event arrives — updates the in-memory list, badge, and dropdown
//    if open.
//  - clicking a leaf item navigates to the app's group-chat tab and
//    marks that one read.
//
// #1385 flat list: `items` stays the single newest-first source of truth, and
// the dropdown renders ONE ROW PER NOTIFICATION in that order — no per-app
// headers, no expand/collapse, no per-group leaf pager.
//
// It used to nest (#84): a collapsed header row per app carrying a count and
// the newest item's preview, expandable to reveal per-kind leaves, with the
// expansion set persisted to localStorage. That earned its keep when the
// drawer showed everything ever received, where one busy app could bury
// another's single row. Two later changes took the premise away —
// notifications arrive newest-first, and #1367's follow-up moved the READ ones
// behind "See older notifications", so the default list is only what is new.
// Grouping a short unread list by app costs a tap to read anything and buys
// nothing back. Every row also NAMES its own app in its text already (see
// rowView, which builds every kind's segments around `appLine`), so the header
// was repeating the row directly beneath it.
//
// Older pages still load through the keyset cursor (nextBefore/hasMore). The
// control that pulls them is now ONE button at the foot of the list instead of
// one inside each expanded group, and that relocation is load-bearing rather
// than cosmetic: `_showMoreGroup` was the only caller of `loadMore()` in the
// codebase, so removing the group chrome without replacing it would have
// stranded server pagination on page one.

// The module's one import (#1808). Notification rows used to carry a
// hand-rolled relative age with no floor, so a year-old row read "412d ago";
// the shared helper prints a real date past a week. Bundled, not imported by
// Node, in tests/notification-row-lines.test.js — see the note there.
import { agoStamp } from '../../lib/timestamp';

// The rows' own words (frontend/locales/en/notifications.json), read when a
// row is built so they follow the language on screen. Through the global the
// language runtime publishes rather than a second import: the tests that
// evaluate this file in a vm strip the one import above and nothing else.
const t = (id, values) => PlatformI18n.t(id, values);
const listText = (parts) => PlatformI18n.listText(parts);

const NATIVE_INVALIDATION_TIMEOUT_MS = 10000;
const NATIVE_INVALIDATION_REFRESH_VERSION = 1;

// #18: a plain message belongs to the Messages tab rather than the bell — the
// Unread tab neither lists nor counts it. rowView prints this as `plainMessage`
// (using an item's `appId` rather than the raw row's `app_id`), and the
// controller's app-less clear reads the same rule so it leaves those messages
// unread (#6579).
function isPlainMessageNotification(n) {
  return !!n && ((n.kind === 'conversation_message' && n.appId == null) || n.kind === 'channel_message');
}

const Notifications = {
  // #1191 slice 6: the drawer's two innerHTML hosts are React now. This module
  // still owns the fetches, the mark-read discipline, the click routing and
  // the badges; what it no longer does is build DOM. `_renderList` and
  // `_renderInvites` compute a descriptor tree and push it here, and
  // ./notifications-list.tsx renders it.
  //
  // Planted by ./mount.ts, which is the only module in this feature that may
  // import React. It stays null in the vm harnesses that evaluate this file as
  // a classic script (see ./notifications-store.js for why that matters), and
  // both render methods no-op when it is — exactly as they used to when
  // getElementById came back null.
  _store: null,
  // social-push.js is cached independently from the React shell bundle. It
  // must not trust the older refreshAfterInvalidation implementation, which
  // reported success even when its ordinary cacheable refresh failed.
  nativeInvalidationRefreshVersion: NATIVE_INVALIDATION_REFRESH_VERSION,
  items: [],   // newest-first; the single source of truth
  // Pending collaborator invites (authoritative, from the first-page
  // /api/notifications payload). Rendered as a pinned section above the
  // grouped list with Accept / Decline actions.
  invites: [],
  // #1280: messages this user saved with the bookmark button in group
  // chat, newest save first (also from the first-page payload). Rendered
  // as the TOP pinned section — above the invites and the grouped list —
  // and they stay there until unsaved, from the message or from here.
  //
  // Deliberately NOT folded into `items`: a save is not a notification. It
  // has no unread state, so it must not touch the badge, the mark-all
  // path, the grouping transform or the pagination cursor — all of which
  // operate on `items` alone.
  saved: [],
  // #4769: the pinned section's other half, saved NOTIFICATIONS. Deliberately
  // NOT folded into `items`, for the same reasons as `saved` above — a save
  // has no unread state and must not touch the badge, mark-all, grouping or
  // pagination.
  savedNotifications: [],
  unread: 0,
  // #18 (19 Oct 2026 polish board): how many of `unread` are a plain message
  // in a conversation or a channel (`conversation_message`,
  // `channel_message`), which the bell leaves to the Messages tab. The
  // server's figure (countUnreadSplit), walked with `unread` wherever that
  // is. The kinds are spelled out at each use: the harnesses rebuild single
  // methods with `new Function`, which can close over nothing.
  messageUnread: 0,

  // #5249: whether a notification is drawn at all. While kudos is parked
  // (features/leaderboard/kudos-parked.ts; the bundle then publishes no
  // window.Kudos) a kudos row is not: nobody can give kudos, so an old one
  // would point at a feature that is not there. The rows stay in the
  // database; every way a row enters `items` asks this first.
  _shown(n) {
    if (!n) return false;
    if (n.kind === 'kudos' && !(typeof window !== 'undefined' && window.Kudos)) return false;
    return true;
  },
  // `open` is a GETTER now, defined beside show()/hide() below — the drawer
  // owns the presentation, so this module derives the state rather than
  // storing a flag that would disagree with the screen during the drawer's
  // deferred exit. A plain `open: false` here would shadow it.
  // Pagination cursor for the list's foot "Load older notifications" pager.
  nextBefore: null,  // { createdAt, id } | null
  hasMore: false,
  loading: false,
  // #5527: the Unread tab's own cursor, walked by loadMoreUnread() over
  // `?unread=1` — pages of unread rows only, under the exact filters
  // countUnread counts the badge with. Separate from nextBefore because the
  // unread query skips rows the shared one keeps, so advancing a shared
  // cursor would strand rows the tab behind it can never reach.
  // unreadHasMore starts false because refresh() seeds it from the first
  // page's own hasMore: every unread row newer than the first page's last
  // row is already loaded, so there is nothing to discover before asking.
  unreadNextBefore: null,  // { createdAt, id } | null
  unreadHasMore: false,
  unreadLoading: false,
  // #5527: bumped by every refresh() whose first page landed and published
  // on the store — the Unread tab's auto-fill arms on sheet-open and fires
  // when this changes while the sheet is open (see the store field's note).
  refreshTick: 0,
  // Only the newest first-page refresh may replace the authoritative feed.
  // This prevents an older boot/bell request from completing after a native
  // network-only invalidation and overwriting its fresher result.
  _refreshGeneration: 0,
  // Once a native invalidation starts, this document must never replace its
  // feed with the service worker's older API-cache fallback. Raise the floor
  // before the request awaits so a later overlapping ordinary refresh is also
  // network-only. Failed reads preserve the last rendered snapshot while the
  // Social coordinator retains and retries the invalidation.
  _networkFreshnessFloor: false,

  init() {
    // THE UI OVERHAUL merged the bell into the hamburger, so #notifications-btn
    // is gone and so is the outside-click dismissal that used to live here:
    // opening, closing and dismissing this list are all the drawer's business
    // now (features/header/header-menu-controller.js). What is left is the
    // "Mark all read" control, which is still this module's.
    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.addEventListener('click', Notifications.markAllRead);

    // Every drawer open starts on the "new" list rather than wherever the last
    // visit left it: the drawer opens on what is NEW. This used to re-fold the
    // app groups on the same announcement; #1385 removed them, so the show-older
    // reset is all that is left of that pair.
    document.addEventListener('sv:drawer-open', () => {
      Notifications._setShowOlder(false);
    });

    // The rows hold their words, so a new language rebuilds them from the
    // same notifications.
    document.addEventListener('homeroom:language-changed', () => {
      Notifications._renderSaved();
      Notifications._renderInvites();
      Notifications._renderList();
    });

    // Anonymous SPA boot (fold-auth-pages-into-SPA): the initial fetch
    // waits for the authed boot stage instead of firing a guaranteed 401
    // on a sessionless document. `sv:authed` fires at most once.
    //
    // FROM THE NETWORK (polish board #7, 19 Oct 2026). A boot read is in a
    // crowd of requests, and past the service worker's API deadline it was
    // answered from the worker's copy: the bell opened on "Unread (1)", and
    // the read on open replaced it a few seconds later with "You're all
    // caught up". `fresh` asks the worker for the current answer, which it
    // falls back from only when the network fails (public/sw.js
    // wantsFreshAnswer).
    if (window.App && App.user) Notifications.refresh({ fresh: true });
    else document.addEventListener('sv:authed',
      () => Notifications.refresh({ fresh: true }), { once: true });
  },

  // --- fetching --------------------------------------------------------

  async refresh(options) {
    const generation = ++Notifications._refreshGeneration;
    try {
      // ?demo=1 forwarding (preserved on the page URL): staging injects
      // mock session-related rows on the first page so the cog drawer's
      // pinned section is reviewable (routes/notifications.js
      // stagingMockNotifications). No-op in production.
      const demo = new URLSearchParams(location.search).get('demo') === '1' ? '&demo=1' : '';
      const explicitlyNetworkOnly = options && options.networkOnly === true;
      if (explicitlyNetworkOnly) Notifications._networkFreshnessFloor = true;
      const networkOnly = explicitlyNetworkOnly ||
        Notifications._networkFreshnessFloor;
      // The previous service worker classifies this request as an ordinary
      // cacheable API read. A per-attempt URL prevents that worker from
      // replaying an earlier invalidation response while a new page is waiting
      // for the updated worker to take control.
      const invalidationNonce = networkOnly
        ? (typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${generation.toString(36)}-` +
            Math.random().toString(36).slice(2))
        : null;
      const invalidation = networkOnly
        ? `&native_invalidation=1&native_invalidation_nonce=${encodeURIComponent(invalidationNonce)}`
        : '';
      // EVERY READ OF THE FEED ASKS FOR THE NETWORK'S ANSWER, not only the
      // boot read's (21 Oct 2026). Past its 1 s deadline the worker answers an
      // API read from its copy, and this feed can take longer than that. On a
      // socket reconnect the bell was drawn from a copy from hours before
      // ("0" over three unread) and stayed so for 36 minutes: the worker's
      // `api-updated` correction re-runs the visible screen's loader, never
      // this feed's. A fresh read uses the copy only when the network fails
      // (public/sw.js wantsFreshAnswer).
      const fresh = !networkOnly;
      let timeout = null;
      let controller = null;
      if (networkOnly && typeof AbortController === 'function') {
        controller = new AbortController();
        timeout = setTimeout(
          () => controller.abort(),
          NATIVE_INVALIDATION_TIMEOUT_MS
        );
      }
      let res;
      let data;
      try {
        res = await fetch(
          `/api/notifications?limit=100${demo}${invalidation}`,
          networkOnly ? {
            credentials: 'same-origin',
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          } : fresh ? { cache: 'no-cache' } : undefined
        );
        if (!res.ok) return false;
        data = await res.json();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (generation !== Notifications._refreshGeneration) return false;
      Notifications.items = Array.isArray(data.notifications)
        ? data.notifications.filter(Notifications._shown) : [];
      Notifications.invites = Array.isArray(data.pendingInvites) ? data.pendingInvites : [];
      Notifications.saved = Array.isArray(data.savedMessages) ? data.savedMessages : [];
      // #4769: the pinned section's other half, saved NOTIFICATIONS. Same
      // contract as `saved`: whatever the server sent, else an empty list.
      // #5249: through _shown like the feed, so a kudos row saved before
      // kudos was parked is not drawn here either (the server skips the kind
      // too; this holds for an older server or a staging demo row).
      Notifications.savedNotifications = Array.isArray(data.savedNotifications)
        ? data.savedNotifications.filter(Notifications._shown) : [];
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      // #5527: the Unread tab's cursor is seeded from the first page too.
      // Every unread row newer than the first page's last row is already in
      // `items` (the page holds them all), so paging starts exactly where
      // the shared page stopped. A refresh resets this pair, so a reload
      // never mixes two cursors.
      Notifications.unreadHasMore = !!data.hasMore;
      Notifications.unreadNextBefore = data.nextBefore || null;
      Notifications.refreshTick += 1;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      // Rendered UNCONDITIONALLY now, where this was gated on `open`.
      //
      // The gate existed because the bell's panel was presented on demand and
      // filled at that moment: show() rendered the three sections before
      // handing the node to the kit, precisely so the sheet measured the right
      // height. THE UI OVERHAUL moved the list into the hamburger, which is
      // always mounted — translated off-screen rather than built on open — so
      // there is no "before presenting" to render at, and no cost to keeping
      // the store current. The payoff is that the drawer opens onto CURRENT
      // rows instead of last-open's.
      Notifications._renderSaved();
      Notifications._renderInvites();
      Notifications._renderList();
      // After the first populated refresh, so a deep-linked drawer opens
      // onto real rows rather than an empty-state flash.
      Notifications._maybeShotOpen();
      return true;
    } catch (err) {
      console.warn('[notifications] refresh failed', err);
      return false;
    }
  },

  // Native foreground push is only an invalidation signal. Re-read the
  // authenticated notification feed; no notification copy crosses the
  // WebView bridge.
  async refreshAfterInvalidation() {
    if (!window.App || !App.user) return false;
    return Notifications.refresh({ networkOnly: true });
  },

  // Resolve a native push's opaque id through the current Social session,
  // then reuse the existing click router and mark-read behavior. The exact
  // endpoint is ownership-scoped and intentionally returns no route from the
  // untrusted push payload.
  async openById(rawId) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return false;
    let item = Notifications.items.find((candidate) => candidate.id === id);
    if (!item) {
      try {
        const res = await fetch(`/api/notifications/${id}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json();
        item = data && data.notification;
        if (!item || item.id !== id) return false;
        Notifications.items.unshift(item);
      } catch (err) {
        console.warn('[notifications] exact lookup failed', err);
        return false;
      }
    }
    try {
      return await Notifications._onItemClick(id) !== false;
    } catch (err) {
      console.warn('[notifications] destination failed', err);
      return false;
    }
  },

  async loadMore() {
    if (Notifications.loading || !Notifications.hasMore || !Notifications.nextBefore) return;
    Notifications.loading = true;
    try {
      const { createdAt, id } = Notifications.nextBefore;
      const params = new URLSearchParams({
        limit: '100',
        before: String(createdAt),
        before_id: String(id),
      });
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = Array.isArray(data.notifications) ? data.notifications.filter(Notifications._shown) : [];
      // Append, deduping on id (a concurrent prepend could overlap).
      const seen = new Set(Notifications.items.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          Notifications.items.push(n);
          seen.add(n.id);
        }
      }
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] loadMore failed', err);
    } finally {
      Notifications.loading = false;
    }
  },

  // #5527: TRUE while the bell counts more unread notifications than the
  // list holds. `unread` is countUnread's account-wide figure — the number
  // the badge paints — and the loaded unread rows are what has been fetched
  // so far. The comparison is the same one the badge makes: a settled
  // decided-ask row serializes read (the server stamps read_at live off the
  // change's status), and a parked kind never reaches either side.
  //
  // #18: plain messages on both sides. The bell leaves them to the Messages
  // tab (_badgeTotal), and `?unread=1` no longer pages them.
  _unreadShort() {
    const loaded = Notifications.items
      .filter((n) => n && !n.readAt && !/^(conversation|channel)_message$/.test(n.kind)).length;
    return loaded < Notifications.unread - (Notifications.messageUnread || 0);
  },

  /**
   * #5527: fill the Unread list up to the bell's number.
   *
   * The badge counts every unread row on the account (countUnread) while
   * the sheet's Unread tab shows the unread rows among the newest 100
   * fetched — so a backlog of unread sitting behind a long run of read rows
   * read as a bell of 46 over a list of 1. `?unread=1`
   * (routes/notifications.js) pages those rows directly, under the exact
   * filters the badge counts with, on a cursor of its own: advancing
   * `nextBefore` here would strand every row between the two positions.
   *
   * Up to `pages` batches per call. The sheet auto-fills five (500 rows) on
   * opening so a huge backlog cannot hang it; anything further waits for
   * the foot button's next tap. It stops as soon as `_unreadShort()` is
   * false — loaded has caught up with counted — and never touches
   * `nextBefore` or `hasMore`, the All tab's cursor.
   */
  async loadMoreUnread(options) {
    const pages = (options && options.pages) || 5;
    if (Notifications.unreadLoading) return;
    Notifications.unreadLoading = true;
    Notifications._renderList();
    try {
      for (let page = 0; page < pages; page += 1) {
        if (!Notifications.unreadHasMore || !Notifications._unreadShort()) break;
        const generation = Notifications._refreshGeneration;
        const params = new URLSearchParams({ limit: '100', unread: '1' });
        // First batch has no cursor of its own: it starts from the shared
        // first page's last row (refresh seeded unreadNextBefore), and the
        // dedupe below drops anything already on screen.
        if (Notifications.unreadNextBefore) {
          params.set('before', String(Notifications.unreadNextBefore.createdAt));
          params.set('before_id', String(Notifications.unreadNextBefore.id));
        }
        const res = await fetch(`/api/notifications?${params.toString()}`);
        if (!res.ok) break;
        const data = await res.json();
        // A refresh that landed while the page was in flight replaced the
        // feed and re-seeded the unread cursor; this page is from before
        // that, so drop it whole rather than mixing two cursors.
        if (generation !== Notifications._refreshGeneration) return;
        const incoming = Array.isArray(data.notifications) ? data.notifications.filter(Notifications._shown) : [];
        const seen = new Set(Notifications.items.map((n) => n.id));
        for (const n of incoming) {
          if (!seen.has(n.id)) {
            Notifications.items.push(n);
            seen.add(n.id);
          }
        }
        // An unread-only page reaches further back than the shared cursor
        // has, so its rows do not simply append in feed order the way
        // loadMore's do. Sorted by the server's own ORDER BY: created_at
        // DESC, id as the tiebreak.
        Notifications.items.sort((a, b) => {
          const at = new Date(a.createdAt || a.created_at || 0).getTime();
          const bt = new Date(b.createdAt || b.created_at || 0).getTime();
          return (bt - at) || (Number(b.id) - Number(a.id));
        });
        Notifications.unreadHasMore = !!data.hasMore;
        Notifications.unreadNextBefore = data.nextBefore || null;
        Notifications._renderList();
      }
    } catch (err) {
      console.warn('[notifications] loadMoreUnread failed', err);
    } finally {
      Notifications.unreadLoading = false;
      Notifications._renderList();
    }
  },

  handleIncoming(notif) {
    if (!notif) return;
    if (!Notifications._shown(notif)) return;
    // Dedup on id — a reconnect might replay the same notification that
    // /api/notifications already returned.
    //
    // A row can also come back GROWN: a small group's discussion row folds
    // the next message into itself (src/services/group-channel-notify.js),
    // and an invite's moments fold the same way. It was already unread, so
    // it is not a second unread notification, and when it is newer than it
    // was it moves to the top, where the feed's newest-first order puts it.
    const existing = Notifications.items.findIndex((n) => n.id === notif.id);
    const wasUnread = existing >= 0 && !Notifications.items[existing].readAt;
    if (existing >= 0) {
      const before = Date.parse(Notifications.items[existing].createdAt) || 0;
      const after = Date.parse(notif.createdAt) || 0;
      if (after > before) {
        Notifications.items.splice(existing, 1);
        Notifications.items.unshift(notif);
      } else {
        Notifications.items[existing] = notif;
      }
    } else {
      Notifications.items.unshift(notif);
    }
    if (!notif.readAt && !wasUnread) {
      Notifications.unread += 1;
      if (/^(conversation|channel)_message$/.test(notif.kind)) {
        Notifications.messageUnread = (Notifications.messageUnread || 0) + 1;
      }
    }
    // #161: a completion arriving while the user is away from the
    // browser tab sets the dedicated tab-title marker (the replacement
    // for the old streaming-driven "✅ Done"). If they're actively
    // looking at the page, the badge + drawer suffice.
    // #3181: a turn that stopped before finishing is the other half of a
    // finished one, and arrives on the same channels with its own marker.
    if (PRIORITY_KINDS.has(notif.kind)
        && !notif.readAt
        && window.DevChat && DevChat.setCompletionTitle
        && DevChat._userIsAway && DevChat._userIsAway()) {
      DevChat.setCompletionTitle(notif.kind === 'session_done'
        ? 'sessionDone'
        : notif.kind === 'session_stalled'
          ? 'sessionStalled'
          : (notif.detail === 'failed' ? 'autoSolveFailed' : 'autoSolveDone'));
    }
    // #138: route an arriving completion through the alert channels — a
    // chime when the app is visible, an OS notification when it's hidden.
    // The visible/hidden split lives in DevAlerts.onCompletion. This is the
    // "user is elsewhere in the app, or backgrounded" path (notify_on_done
    // was armed, so a notification_new arrives); the "watching the same dev
    // chat" path is handled by DevChat._finishStreaming's direct tone.
    if (PRIORITY_KINDS.has(notif.kind)
        && !notif.readAt
        && window.DevAlerts && typeof DevAlerts.onCompletion === 'function') {
      DevAlerts.onCompletion(completionAlertInfo(notif));
    }
    // A live collab invite needs the authoritative pendingInvites list
    // (the notification row alone can't drive the actionable section) —
    // refresh re-pulls it along with the first page.
    if (notif.kind === 'collab_invite' || notif.kind === 'approver_invite') {
      Notifications.refresh();
      return;
    }
    Notifications._renderBadge();
    Notifications._renderList();
  },

  // ── Presentation: the hamburger drawer ──────────────────────────
  //
  // This module used to own a surface of its own — #notifications-panel, an
  // anchored dropdown on desktop and a kit bottom sheet on touch, both
  // presented from here. THE UI OVERHAUL merged the bell into the hamburger,
  // so the list is rendered inside #header-menu-panel and the DRAWER owns the
  // presentation, including the kit adoption. These three forward to it so
  // every existing caller — a notification click, a screenshot deep link, the
  // native Social coordinator — keeps working unchanged.
  //
  // `open` is derived rather than stored because both surfaces defer their
  // exit behind a spring (see HeaderMenu.isPresenting and the sheet
  // controller's dismiss promise), so a flag set here would disagree with
  // what is on screen for ~200ms after a close.
  //
  // It asks about the SHEET and the drawer both. The rows are the sheet's now
  // (Streamlined Concept), but this module's own dismiss-before-you-navigate
  // rule predates that and still has to cover a drawer somebody opened.
  get open() {
    return !!window.NotificationsSheet?.isOpen?.();
  },

  toggle() {
    if (Notifications.open) Notifications.hide();
    else Notifications.show();
  },

  show() {
    window.NotificationsSheet?.open?.();
  },

  hide() {
    window.NotificationsSheet?.close?.();
  },

  // Screenshot-state deep link (`?shot=notifications`): the list only exists
  // behind a click on the hamburger, so the capture pipeline and any dapp.json
  // test would otherwise never see it — and #1280's saved section lives
  // nowhere else. Pair it with ?demo=1 in staging so the pinned sections have
  // mock rows to render. Once per page load — reopening after a manual
  // dismiss would fight the user, and refresh() runs again on live events.
  //
  // #5289: `?shot=notifications-messages` opened it on the Messages tab.
  // That tab is gone (the Messages screen, one tab away in the bar, is where
  // conversations and agents are), so the old link still opens the sheet,
  // on Unread like any other opening. `?shot=notifications-all` opens it on
  // All (the sheet reads the parameter for the tab; this only opens it).
  //
  _shotOpened: false,
  _maybeShotOpen() {
    if (Notifications._shotOpened || Notifications.open) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== 'notifications' && shot !== 'notifications-messages' && shot !== 'notifications-all') return;
    Notifications._shotOpened = true;
    // The list is the Notifications SHEET now (Streamlined Concept), so the
    // deep link resolves a screen underneath and presents over it rather
    // than opening the drawer.
    if (window.App?.openNotificationsSheet) window.App.openNotificationsSheet();
    else Notifications.show();
  },

  // #1329: a presented drawer is MODAL on touch — it covers the screen the
  // action navigates to, so leaving it up strands the user under a stuck,
  // mostly-empty sheet over a dimmed backdrop. Every action below that
  // actually routes calls this first.
  //
  // It closes the drawer at EVERY width now. The rule used to be sheet-gated,
  // so the desktop anchored dropdown could keep its documented keep-open
  // behaviour; there is no anchored dropdown any more, and a side drawer left
  // open over the screen you just navigated to is the same problem the touch
  // sheet had.
  // #4367: a change's topic ref. #6099: the row's own session id is what its
  // title comes from, so when we have one the ref names that session and
  // nothing else. A pull request number is only a fallback for a row that has
  // no usable session id: several sessions can share one (a change carried in
  // another change's PR), and looking the number up on the server picks one of
  // them, so a notice could open an older change than its text names.
  _changeRef(sessionId, prNumber) {
    const id = parseInt(sessionId, 10);
    if (Number.isInteger(id) && id > 0) return { kind: 'proposal', id };
    const pr = Number(prNumber);
    return Number.isInteger(pr) && pr > 0 ? { kind: 'proposal', pr } : { kind: 'proposal', id };
  },

  // The same change as an address (lib/change-href.ts; spelled out here,
  // as this module keeps its one bundle import). Once the page has drawn,
  // AppView._canonicalizeChangeAddress replaces a session-id address with the
  // change's `dev/changes/<N>` one.
  _changeHash(slug, sessionId, prNumber) {
    const ref = Notifications._changeRef(sessionId, prNumber);
    return ref.id ? `#app/${slug}/dev/proposals/${ref.id}` : `#app/${slug}/dev/changes/${ref.pr}`;
  },

  _dismissSheetForNav() {
    if (Notifications.open) Notifications.hide();
  },

  // --- mark read -------------------------------------------------------

  async markAllRead() {
    // Mark-all clears EVERYTHING the bell counts, session kinds included.
    //
    // It used to exclude them (`exclude_kinds: [...SESSION_NOTIF_KINDS]`) on
    // the grounds that the session badge was a second surface with a mark-all
    // of its own. That surface is gone: the completed-session count is part of
    // the bell's number now, and an exclusion here would leave a count nothing
    // in the drawer can dismiss — which is the bug this change exists to fix.
    if (Notifications.unread === 0) return;
    // Nothing is cleared until the server answers, so a failed request leaves
    // every unread mark where it was. It still has to say so: a tap that
    // silently did nothing reads as a broken button.
    const failed = () => window.PlatformUI?.toast?.(t('notifications:toast.markAllFailed'));
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) { failed(); return; }
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      const now = new Date().toISOString();
      Notifications.items = Notifications.items.map((n) => (
        { ...n, readAt: n.readAt || now }
      ));
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449: an open group chat may be showing unread dots for the
      // mentions/replies/reactions that were just cleared — reconcile
      // them from the now-read items list right away, instead of relying
      // solely on the server's notifications_changed round-trip.
      window.GroupChat?.reconcileDotsFromNotifications?.();
    } catch (err) {
      console.warn('[notifications] markAllRead failed', err);
      failed();
    }
  },

  // #6527: opening the bell no longer marks anything read. The sheet only
  // refreshes on open; reading is explicit (markAllRead, clearNotification,
  // markOlderRead, opening a row). The server's narrow-clear option that
  // opening used to send (#6498) remains on the route, though nothing in the
  // app sends it now.

  // #5929 (item 13): mark every unread notification older than `days` whole
  // days read — the Unread tab's "Mark everything older than a week as
  // read", which lets a 99+ backlog go while this week's news stays unread.
  //
  // The route's `{ all: true, older_than_days }` window (markRead) is the
  // whole of what the server does: the clear reaches every unread row of
  // that age the server has, including ones the sheet has not paged in,
  // and its `unread` figure is the account-wide truth the badge adopts.
  // Cross-tab refresh is the route's own `notifications_changed` push.
  //
  // markAllRead's rule: nothing clears until the server answers, so a failed
  // request leaves every unread mark where it was and says so with the same
  // toast. Locally only the rows the window covers flip, by the same cutoff
  // the server applies (created more than `days` days before now).
  async markOlderRead(days = 7) {
    const span = Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7;
    const cutoff = Date.now() - span * 24 * 60 * 60 * 1000;
    const inWindow = (n) => !!n && !n.readAt && (Date.parse(n.createdAt) || 0) < cutoff;
    // Nothing in hand that old (another tab or a refresh got there first):
    // no request, and the caller's button has nothing to wait on.
    if (!Notifications.items.some(inWindow)) return false;
    const failed = () => window.PlatformUI?.toast?.(t('notifications:toast.markAllFailed'));
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, older_than_days: span }),
      });
      if (!res.ok) { failed(); return false; }
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      // Flip only what is still unread and old enough: a refresh that landed
      // while the request was running replaced `items` with the server's
      // own rows, which already say what is true.
      const now = new Date().toISOString();
      for (const n of Notifications.items) {
        if (inWindow(n)) n.readAt = now;
      }
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449's reason: an open group chat may be drawing dots for the
      // notifications that were just cleared.
      window.GroupChat?.reconcileDotsFromNotifications?.();
      return true;
    } catch (err) {
      console.warn('[notifications] markOlderRead failed', err);
      failed();
      return false;
    }
  },

  // #5580: what happened on the request or proposal notification `id` is
  // about (GET /api/notifications/:id/history: { steps }, newest first), for
  // the history a card in the sheet opens to. Null when there is none or the
  // read failed; the card says which it was not able to tell apart.
  async loadHistory(id) {
    const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    try {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/history${demo}`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && Array.isArray(data.steps) ? data : null;
    } catch (_) {
      return null;
    }
  },

  // #5580: who is signed in, so a card's history says "You" for them.
  viewerUsername() {
    return (window.App && App.user && typeof App.user.username === 'string') ? App.user.username : null;
  },

  // #5406: mark every unread notification from ONE app read — the per-app
  // "Mark read" button on the sheet's Unread tab. A busy app can be cleared
  // in one tap while every other app's unread rows stay where they are.
  //
  // It reuses the route's `{ app_id }` branch (markReadForApp), which is the
  // whole of what the server does here: the clear reaches every unread row
  // for that app the server has, including ones the sheet has not paged in,
  // and its `unread` figure is the account-wide truth the badge adopts.
  // Cross-tab refresh is the route's own `notifications_changed` push.
  //
  // The same rule markAllRead follows: nothing clears until the server
  // answers, so a failed request leaves every unread mark where it was and
  // says so with a toast. No optimistic flip and no kinds scoping — the
  // app branch of the route ignores them.
  async markAppRead(appId) {
    if (appId == null) return false;
    // Nothing in hand to clear (another tab or a refresh got there first):
    // no request, and the caller's button has nothing to wait on.
    if (!Notifications.items.some((n) => n && n.appId === appId && !n.readAt)) return false;
    const failed = () => window.PlatformUI?.toast?.(t('notifications:toast.markAppFailed'));
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      });
      if (!res.ok) { failed(); return false; }
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      // Flip only what is still unread: a refresh that landed while the
      // request was running replaced `items` with the server's own rows,
      // which already say what is true.
      const now = new Date().toISOString();
      for (const n of Notifications.items) {
        if (n && n.appId === appId && !n.readAt) n.readAt = now;
      }
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449's reason, for one app: an open group chat may be drawing dots
      // for the notifications that were just cleared.
      window.GroupChat?.reconcileDotsFromNotifications?.();
      return true;
    } catch (err) {
      console.warn('[notifications] markAppRead failed', err);
      failed();
      return false;
    }
  },

  // #6579: mark every unread notification that belongs to NO project read —
  // the Unread tab's "Across Homeroom" heading's Mark read. The route's
  // `{ no_app: true }` branch (markReadForNoApp) clears every such unread row
  // the server has, including ones the sheet has not paged in, while every
  // project's rows and the plain messages stay unread. Same discipline as
  // markAppRead: nothing flips until the server answers, and a failure keeps
  // every mark and says so with a toast.
  async markNoAppRead() {
    const inHand = (n) => !!n && n.appId == null && !n.readAt && !isPlainMessageNotification(n);
    // Nothing in hand to clear (another tab or a refresh got there first):
    // no request, and the caller's button has nothing to wait on.
    if (!Notifications.items.some(inHand)) return false;
    const failed = () => window.PlatformUI?.toast?.(t('notifications:toast.markAppFailed'));
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ no_app: true }),
      });
      if (!res.ok) { failed(); return false; }
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      // Flip only what is still unread: a refresh that landed while the
      // request was running replaced `items` with the server's own rows,
      // which already say what is true.
      const now = new Date().toISOString();
      for (const n of Notifications.items) {
        if (inHand(n)) n.readAt = now;
      }
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449's reason, for the app-less group: an open group chat may be
      // drawing dots for the notifications that were just cleared.
      window.GroupChat?.reconcileDotsFromNotifications?.();
      return true;
    } catch (err) {
      console.warn('[notifications] markNoAppRead failed', err);
      failed();
      return false;
    }
  },

  // #161: drop the tab-title completion marker once no unread completion
  // notification remains (drawer click, group/app mark-read, mark-all,
  // or a cross-tab notifications_changed refresh). The visibility/focus
  // return handler in dev-chat.js is the other clearing path.
  _reconcileCompletionTitle() {
    if (!window.DevChat || !DevChat.setCompletionTitle || !DevChat._titleCompletion) return;
    if (!Notifications.items.some(isPriorityNotif)) DevChat.setCompletionTitle(null);
  },

  // Resolves whether the server took it (#3538). The row click ignores the
  // answer, as it always has, because it is already on its way somewhere
  // else; clearNotification below reads it to put a refused clear back.
  async _markOneRead(id) {
    // Optimistically mark read in-memory and re-render the open drawer
    // right away: the unread dot disappears and unread-first sorting
    // updates live, instead of waiting for the network round-trip (which
    // is why a clicked item used to stay unread until close/reopen).
    const item = Notifications.items.find((n) => n.id === id);
    // Already read here: whatever read it (a clear, a conversation read, the
    // server's own rows) has told the server, and a second request would only
    // race it for the count (21 Oct 2026: opening a folded row sent the row's
    // own read beside its group's, and the slower answer won).
    if (item && item.readAt) return true;
    if (item) {
      item.readAt = new Date().toISOString();
      if (Notifications.unread > 0) Notifications.unread -= 1;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      // Reconcile with the server's authoritative unread count.
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      Notifications._renderBadge();
      return true;
    } catch (err) {
      console.warn('[notifications] markOneRead failed', err);
      return false;
    }
  },

  // #3538: CLEAR A ROW WITHOUT OPENING IT — a swipe on a phone, the × on a
  // hovered row at a desk (./notifications-sheet.tsx). "Clear" is the meaning
  // `readAt` already has here: the notification is marked read, exactly as
  // tapping it would, so it leaves Unread and stays in All without its dot.
  // Nothing new is stored and nothing is deleted, the same promise the
  // "New vs older" note further down makes, which is why All can always
  // bring a cleared row back into view.
  //
  // ONE ROW CAN BE SEVERAL NOTIFICATIONS. A collapsed conversation run is one
  // row standing for `count` of them, unread together
  // (collapseConversationRuns). Clearing only the newest would split the run
  // and put an unread row for the rest straight back where the cleared one
  // was, so the whole run the row draws is cleared, in one request with the
  // rest of the clear.
  //
  // OPTIMISTIC, AND PUT BACK ON FAILURE. A swipe has taken the row off the
  // screen before anything is asked (the kit collapses it, then calls in), so
  // waiting for the server the way markAllRead does is not on offer. What
  // markAllRead's rule protects still holds: a clear the server refused must
  // not leave the screen claiming it worked. Every member is flipped here
  // first, in one render, so the row leaves in one step; one request then
  // reads them all (_markIdsRead) and the server's count is adopted.
  // Anything refused is unread again, the count goes back up, and a toast
  // says so.
  //
  // Resolves true when the row's notifications are read, false when the
  // server refused some of them.
  //
  // #5289: a row on the Unread tab can also stand for several notifications
  // of ONE kind in ONE project ("3 changes you voted on are live"). Those
  // are not consecutive, so the sheet hands their ids over as `groupIds`,
  // and each one's own row members are cleared with it.
  async clearNotification(id, groupIds) {
    const ids = [id, ...(Array.isArray(groupIds) ? groupIds : [])];
    const seen = new Set();
    const members = ids.flatMap((rowId) => Notifications._rowMembers(rowId))
      .filter((n) => {
        if (n.readAt || seen.has(n.id)) return false;
        seen.add(n.id);
        return true;
      });
    if (!members.length) {
      // Nothing left to clear: another tab, or a refresh, got there first.
      // Re-render anyway. A full swipe has already taken the row out of the
      // document, and only a list drawn from the truth puts it back right.
      Notifications._renderList();
      return true;
    }
    const stamp = new Date().toISOString();
    for (const n of members) n.readAt = stamp;
    Notifications.unread = Math.max(0, Notifications.unread - members.length);
    Notifications.messageUnread = Math.max(0, (Notifications.messageUnread || 0)
      - members.filter((n) => /^(conversation|channel)_message$/.test(n.kind)).length);
    Notifications._reconcileCompletionTitle();
    Notifications._renderBadge();
    Notifications._renderList();
    // #449's reason, for one row: an open chat may be drawing a dot for a
    // mention that was just cleared.
    window.GroupChat?.reconcileDotsFromNotifications?.();
    // ONE REQUEST FOR THE WHOLE CLEAR (21 Oct 2026). A story card is several
    // notifications, and one request per member raced: each answer carried
    // the count after its own row only, so the slower one put "Unread (2)"
    // back on screen after the clear had said 1. `{ ids }` reads them all in
    // one statement and answers with the count after all of them.
    if (await Notifications._markIdsRead(members.map((n) => n.id))) return true;
    // A refresh that landed meanwhile replaced `items` with the server's own
    // rows, which already say what is true. Only a notification still in
    // hand, still carrying this clear's stamp, is this clear's to put back,
    // and the count goes back up by what was put back.
    const refused = members.filter((n) => n.readAt === stamp && Notifications.items.includes(n));
    for (const n of refused) n.readAt = null;
    Notifications.unread += refused.length;
    Notifications._renderBadge();
    Notifications._renderList();
    window.GroupChat?.reconcileDotsFromNotifications?.();
    window.PlatformUI?.toast?.(t('notifications:toast.clearFailed'));
    return false;
  },

  // #5289: a grouped row ("3 changes you voted on are live") opens its
  // NEWEST member, the one it is drawn as, and reading it reads the whole
  // group: the rest are cleared with it, so the row leaves Unread in one tap
  // rather than coming back as "2 changes…". Opening every member is not on
  // offer (they are different pages), and the group says how many there
  // were before it went; All still lists each one.
  openGroupRow(id, groupIds) {
    const rest = (Array.isArray(groupIds) ? groupIds : []).filter((other) => other !== id);
    // The opened one with the rest, in the clear's one request: the click's
    // own read finds it already read and asks nothing (_markOneRead).
    void Notifications.clearNotification(id, rest);
    return Notifications._onItemClick(id);
  },

  // The server side of a clear: `{ id }` for one notification (the row
  // click's request), `{ ids }` for several. Adopts the server's count,
  // which is the count after every one of them. Resolves whether it took.
  async _markIdsRead(ids) {
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids.length === 1 ? { id: ids[0] } : { ids }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      Notifications._renderBadge();
      return true;
    } catch (err) {
      console.warn('[notifications] clear failed', err);
      return false;
    }
  },

  // The notifications one sheet row stands for: its own, plus the rest of
  // its conversation run when the row is a collapse (screenViews draws a run
  // as its newest member's row, with that member's id). Walks the same rule
  // the sheet drew with, so the two cannot disagree about what a row is.
  _rowMembers(id) {
    const items = Notifications.items;
    const at = items.findIndex((n) => n && n.id === id);
    if (at < 0) return [];
    const [run] = collapseConversationRuns(items.slice(at));
    return items.slice(at, at + run.count);
  },

  // Reading a conversation clears its notifications. Reflect that in THIS
  // document, without a second round-trip.
  //
  // `POST /api/conversations/:id/read` already marks every unread
  // notification row for that conversation read server-side (see markRead in
  // services/conversations.js — including the invite, which carries no
  // message id and so matches its NULL branch). Nothing needs asking for.
  // What needs fixing is local: this tab's `items`/`unread` would otherwise
  // stay stale until the next refresh, so the bell would go on counting
  // messages you have just sat and read.
  //
  // That was survivable while the Messages row owned the messages count and
  // the bell subtracted it. The bell owns it now, so a stale badge is the
  // visible bug — which is why this reconcile lands in the same change.
  //
  // Called by the Messages store on a local read, and on a `conversation_read`
  // for this same viewer in another tab. `window.Notifications` is the seam:
  // this module stays import-free (see the top of the file), so the store
  // calls in rather than being imported.
  markConversationRead(conversationId) {
    const id = Number(conversationId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const now = new Date().toISOString();
    let cleared = 0;
    let messages = 0;
    for (const n of Notifications.items) {
      if (!n || n.readAt || Number(n.conversationId) !== id) continue;
      // #2387: an alert about a message inside a reply thread waits for that
      // thread to be read, as it does server-side.
      if (n.conversationThreadRootId) continue;
      n.readAt = now;
      cleared += 1;
      if (/^(conversation|channel)_message$/.test(n.kind)) messages += 1;
    }
    if (!cleared) return;
    // `unread` is the server's account-wide total; only ever walk it down by
    // what was actually cleared here, and never below zero.
    Notifications.unread = Math.max(0, Notifications.unread - cleared);
    Notifications.messageUnread = Math.max(0, (Notifications.messageUnread || 0) - messages);
    Notifications._renderBadge();
    Notifications._renderList();
  },

  // #2387: one reply thread of a conversation was read — its alerts (a reply
  // in it, a mention in it) clear, and nothing else of the conversation's.
  markConversationThreadRead(conversationId, rootId) {
    const id = Number(conversationId);
    const root = Number(rootId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(root) || root <= 0) return;
    const now = new Date().toISOString();
    let cleared = 0;
    let messages = 0;
    for (const n of Notifications.items) {
      if (!n || n.readAt || Number(n.conversationId) !== id) continue;
      if (Number(n.conversationThreadRootId) !== root) continue;
      n.readAt = now;
      cleared += 1;
      if (/^(conversation|channel)_message$/.test(n.kind)) messages += 1;
    }
    if (!cleared) return;
    Notifications.unread = Math.max(0, Notifications.unread - cleared);
    Notifications.messageUnread = Math.max(0, (Notifications.messageUnread || 0) - messages);
    Notifications._renderBadge();
    Notifications._renderList();
  },


  // #2847: the viewer opened a proposal card, or touched something on it, so
  // its "New proposal" nudge is answered — clear it the way a vote already
  // does server-side. Called by AppView (the topic page and the dev board's
  // delegated card click) through `window.Notifications`. Skipped when
  // nothing is unread, so the common click costs no request; the server
  // scopes the clear to pr_proposed rows for this one session.
  // #6441: opening a change's page (which for most changes is its request's
  // page) or its before-and-after also answers its "ready to try", so the
  // same call clears that too.
  async markProposalSeen(sessionId) {
    const id = Number(sessionId);
    if (!Number.isSafeInteger(id) || id <= 0 || Notifications.unread === 0) return;
    const now = new Date().toISOString();
    for (const n of Notifications.items) {
      if (n && !n.readAt && (n.kind === 'pr_proposed' || n.kind === 'build_ready')
        && Number(n.sessionId) === id) n.readAt = now;
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.cleared) return;
      Notifications.unread = data.unread || 0;
      Notifications.messageUnread = Number(data.messageUnread) || 0;
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markProposalSeen failed', err);
    }
  },

  // #1688: a row's own button. 'still_yes' re-casts a Yes on the proposal a
  // re-confirm ask names — the server carries the earlier line along, and
  // the vote's auto-dismiss clears the row. Anything else opens the row.
  async _onRowAction(id, key) {
    const item = Notifications.items.find((n) => n.id === id);
    if (!item) return false;
    if ((key === 'friend_accept' || key === 'friend_decline') && item.kind === 'friend_request') {
      return Notifications._answerFriendRequest(item, key === 'friend_accept');
    }
    // The leaked-link guard's rows: turn the link off, or open a paused one
    // again, right on the row.
    if ((key === 'invite_turn_off' || key === 'invite_reopen')
      && (item.kind === 'invite_link_busy' || item.kind === 'invite_link_paused')) {
      return Notifications._actOnInviteLink(item, key === 'invite_reopen');
    }
    // #3227: the kudos row's button opens the Kudos leaderboard, where the
    // change it thanks is ranked; the row itself still opens the change.
    if (key === 'kudos_board' && item.kind === 'kudos') {
      Notifications._dismissSheetForNav();
      window.location.hash = '#leaderboard/prs';
      return true;
    }
    const sessionId = Number(item.sessionId);
    if (key === 'still_yes' && Number.isFinite(sessionId) && sessionId > 0
        && window.AppView && typeof AppView.castVote === 'function') {
      // #3984: a vote that did not go through (castVote resolves false and
      // says why in its toast) leaves the row, and its button, where it was.
      const ok = await AppView.castVote(sessionId, 'yes', null, { reason: null });
      if (ok === false) return false;
      Notifications._markOneRead(id);
      if (typeof Notifications.refresh === 'function') Notifications.refresh();
      return true;
    }
    return Notifications._onItemClick(id);
  },

  // #2386: Accept / Decline right on a friend request row. The server marks
  // the row read and answers the relationship; the row stops offering the
  // buttons (`friendRequestPending`), and the page's friend caches hear about
  // it through the same DOM event the profile button raises
  // (features/friends/api.ts FRIENDS_CHANGED_EVENT) — an event, not an
  // import, because this module stays import-free. A decline tells the sender
  // nothing; the toast is only ever the viewer's own confirmation.
  async _answerFriendRequest(item, accept) {
    const userId = Number(item.sourceUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return false;
    const toast = (message) => {
      if (typeof PlatformUI !== 'undefined' && PlatformUI.toast) PlatformUI.toast(message);
    };
    try {
      const init = {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      };
      const res = accept
        ? await fetch(`/api/friends/${userId}/accept`, init)
        : await fetch(`/api/friends/${userId}/decline`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error && res.status === 429 ? data.error : t('notifications:friend.answerFailed'));
        return false;
      }
      item.friendRequestPending = false;
      if (!item.readAt) {
        item.readAt = new Date().toISOString();
        if (Notifications.unread > 0) Notifications.unread -= 1;
        Notifications._renderBadge();
      }
      Notifications._renderList();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('usernode:friends-changed'));
      }
      if (accept) {
        toast(data.state !== 'friends' ? t('notifications:friend.withdrawn')
          : item.sourceUsername ? t('notifications:friend.nowFriends', { username: item.sourceUsername })
            : t('notifications:friend.nowFriendsUnnamed'));
      } else toast(t('notifications:friend.declined'));
      return true;
    } catch (err) {
      console.warn('[notifications] friend answer failed', err);
      toast(t('notifications:friend.answerFailed'));
      return false;
    }
  },

  // The leaked-link guard's buttons (src/services/community-invites.js
  // GUARD): Turn off this link (DELETE /api/invite-links/:id, as the invite
  // pane's Turn off) or Open it again (POST /api/invite-links/:id/reopen).
  // The row is read once acted on, and stops offering what no longer
  // applies; the toast is the reader's own confirmation.
  async _actOnInviteLink(item, reopen) {
    const guard = parseInviteGuardDetail(item.detail);
    if (!guard || !(guard.inviteId > 0)) return false;
    const toast = (message, error) => {
      if (typeof PlatformUI !== 'undefined' && PlatformUI.toast) PlatformUI.toast(message, error ? { error: true } : undefined);
    };
    try {
      const res = await fetch(
        reopen ? `/api/invite-links/${guard.inviteId}/reopen` : `/api/invite-links/${guard.inviteId}`,
        reopen
          ? { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } }
          : { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' } },
      );
      if (!res.ok) {
        toast(t('notifications:row.inviteGuard.failed'), true);
        return false;
      }
      item.inviteLinkState = reopen ? 'live' : 'ended';
      Notifications._markOneRead(item.id);
      Notifications._renderList();
      toast(reopen ? t('notifications:row.inviteGuard.reopened') : t('notifications:row.inviteGuard.turnedOff'));
      return true;
    } catch (err) {
      console.warn('[notifications] invite link action failed', err);
      toast(t('notifications:row.inviteGuard.failed'), true);
      return false;
    }
  },

  _onItemClick(id) {
    // #4769: saved rows route the same.
    const item = Notifications.items.find((n) => n.id === id)
      || Notifications.savedNotifications.find((n) => n.id === id);
    if (!item) return false;
    // Every notification tap, in-app or a native push (openById), comes
    // through here: the screen it opens was reached by a nudge (#3369).
    try { window.UITelemetry?.markNextVia?.('nudged'); } catch (_) { /* best effort */ }
    // Desktop: deliberately do NOT hide the anchored panel here — it stays
    // open over the navigated-to view so the user can keep clicking through
    // other notifications, and only dismisses via outside-click or the
    // explicit close button. Touch is the opposite contract (#1329): the kit
    // bottom sheet is modal and would COVER the destination screen, so each
    // branch below that actually routes calls _dismissSheetForNav() first —
    // a no-op when no sheet is presented.
    Notifications._markOneRead(id);
    if (item.kind === 'test_alert') {
      Notifications._dismissSheetForNav();
      window.location.hash = '#settings/alerts';
      return;
    }
    // Platform conversations are never routed through an app tab. Prefer the
    // React bridge because it re-renders even when this is the current hash;
    // the hash fallback keeps native exact-notification opens functional
    // during shell startup before the island publishes its controller.
    if (CONVERSATION_NOTIF_KINDS.has(item.kind)) {
      const conversationId = Number(item.conversationId);
      if (Number.isSafeInteger(conversationId) && conversationId > 0
          && conversationId <= 2147483647) {
        Notifications._dismissSheetForNav();
        const messages = window.UsernodeReact?.messages;
        // #2387: a row about a message or a thread opens that ADDRESS. The
        // bridge's openAddress re-runs the router when it is the address
        // already in the bar; open(id) would move to the bare conversation
        // and close the thread the row is about.
        const href = conversationNotificationHref(item);
        if (messages?.openAddress) messages.openAddress(href);
        else window.location.hash = href;
      } else {
        // A request's moment with no chat behind it opens the request.
        const href = conversationNotificationHref(item);
        if (href) {
          Notifications._dismissSheetForNav();
          window.location.hash = href;
        }
      }
      return;
    }
    // #2386: a friend request or acceptance is about a PERSON, so it opens
    // their page — where the relationship's own button lives.
    if (FRIEND_NOTIF_KINDS.has(item.kind)) {
      if (item.sourceUsername) {
        Notifications._dismissSheetForNav();
        window.location.hash = `#profile/${encodeURIComponent(item.sourceUsername)}`;
      }
      return;
    }
    if (item.kind === 'app_quota_changed' || item.kind === 'app_quota_request_declined') {
      Notifications._dismissSheetForNav();
      App.showCreateModal();
      return;
    }
    // #2161: the app this row is about no longer exists, so there is nothing
    // to open. Home is the one screen that is still true.
    if (item.kind === 'app_deleted') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateHome) App.navigateHome();
      else window.location.hash = '#home';
      return;
    }
    if (item.kind === 'app_quota_requested') {
      Notifications._dismissSheetForNav();
      App.navigateToAdminConsole('users');
      return;
    }
    if (item.kind === 'openrouter_key_created' || item.kind === 'openrouter_key_review') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole('users');
      } else {
        window.location.hash = '#admin/users';
      }
      return;
    }
    // A platform limit opens where it is raised: the app limit and the
    // session limit are both set in Admin → Limits (services/app-limit.js,
    // services/session-limit.js), which works on every deploy, and GitHub's
    // budget has its GitHub requests card there too.
    if (item.kind === 'platform_limit') {
      Notifications._dismissSheetForNav();
      const section = 'limits';
      if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole(section);
      } else {
        window.location.hash = `#admin/${section}`;
      }
      return;
    }
    // #4296: an unexpected events alert opens the section that lists them.
    // A platform signal opens its request on Homeroom's own board.
    const signal = item.kind === 'platform_incident' ? parsePlatformIncidentDetail(item.detail) : null;
    const privateSlug = signal && signal.type === 'private' ? window.PlatformTarget?.slug?.() : null;
    if (privateSlug) {
      // A private request has no page: it opens in place in the Workshop's
      // Private requests section.
      Notifications._dismissSheetForNav();
      window.UsernodeReact?.devBoard?.showPrivateRequest?.(privateSlug, signal.privateRequestId);
      if (typeof AppView !== 'undefined' && AppView._landOnTab) AppView._landOnTab(privateSlug, 'workshop');
      window.location.hash = `#app/${encodeURIComponent(privateSlug)}/workshop`;
      return;
    }
    const platformSlug = signal && signal.type === 'signal' ? window.PlatformTarget?.slug?.() : null;
    if (platformSlug) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(platformSlug, 'dev', { subTab: 'issues', ref: signal.issueNumber });
      } else {
        window.location.hash = `#app/${platformSlug}/dev/issues/${signal.issueNumber}`;
      }
      return;
    }
    if (item.kind === 'platform_incident') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole('incidents');
      } else {
        window.location.hash = '#admin/incidents';
      }
      return;
    }
    // #161/#194: completion notifications deep-link to their change.
    // session_done opens the lifecycle-aware detail page around its workspace;
    // auto_solve_done opens the Issues tab with that issue's accordion
    // expanded.
    // #2779: a change an agent session started is worked on in that
    // conversation, so its completion opens the conversation.
    // #3181: a session that stopped before finishing opens exactly where a
    // finished one does, since continuing it is what the row asks for.
    const sessionTurnEnd = item.kind === 'session_done' || item.kind === 'session_stalled';
    if (sessionTurnEnd && item.agentSessionId) {
      Notifications._dismissSheetForNav();
      window.location.hash = `#messages/agent/${encodeURIComponent(item.agentSessionId)}`;
      return;
    }
    if (sessionTurnEnd && item.appSlug && item.sessionId) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'topic',
          ref: Notifications._changeRef(item.sessionId, item.prNumber),
        });
      } else {
        window.location.hash = Notifications._changeHash(item.appSlug, item.sessionId, item.prNumber);
      }
      return;
    }
    // (#86) Private spec share: persist the spec-panel open state for
    // the app, then open its chat — its project page's Discussion tab
    // since #3653 (App.switchTab turns the request there). GroupChat's
    // mount path (_restoreSpecPanelIfSaved) opens the read-only panel and fetches
    // the version through the share-widened access check. GroupChat is
    // a same-script-scope global (const-declared, so not on window) —
    // hence the bare reference behind a typeof guard.
    if (item.kind === 'spec_shared' && item.appSlug && item.sessionId) {
      const version = parseInt(item.detail, 10);
      if (Number.isInteger(version) && version > 0
          && typeof GroupChat !== 'undefined' && GroupChat._writeSpecPanelOpen) {
        GroupChat._writeSpecPanelOpen(item.appSlug, {
          sessionId: item.sessionId,
          version,
          title: t('notifications:spec.panelTitle', { version }),
        });
      }
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', { subTab: 'chat' });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/chat`;
      }
      return;
    }
    // #1405 path A: your agent submitted or shared work. Both are about ONE
    // change, and both used to fall through to the app's general chat with
    // everything else that had a slug — a screen that says nothing about the
    // thing the notification is announcing. A submission is up for a vote and
    // a share is still underway, but the lifecycle-aware change page handles
    // both states around the same full card.
    if (item.kind === 'connector_submitted' && item.appSlug && item.sessionId) {
      Notifications._dismissSheetForNav();
      const id = parseInt(item.sessionId, 10);
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'topic',
          ref: Notifications._changeRef(id, item.prNumber),
        });
      } else {
        window.location.hash = Notifications._changeHash(item.appSlug, id, item.prNumber);
      }
      return;
    }
    if (item.kind === 'auto_solve_done' && item.appSlug) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'issues',
          ref: item.headlessIssueNumber || null,
        });
      } else {
        window.location.hash = item.headlessIssueNumber
          ? `#app/${item.appSlug}/dev/issues/${item.headlessIssueNumber}`
          : `#app/${item.appSlug}/dev/issues`;
      }
      return;
    }
    // #1374's daily digest of what waits for your approval. With one change
    // the row names it (services/vote-digest.js puts its app and session on
    // the row), and it opens that change with the other proposal kinds
    // below. With several there is no app: it opens the Communities
    // screen's Needs you, which lists every vote owed across your projects.
    // It used to open nothing at all, so a tap (or a push) left you on
    // whatever screen was showing (4 October).
    // 5 October (Page Turners): a "ready to try" whose change went live says
    // Live, and opens the app it is live in: there is nothing left to try or
    // approve on the change page.
    if (item.kind === 'change_ready' && item.sessionStatus === 'merged' && item.appSlug) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) return App.openAppTab(item.appSlug, 'app');
      window.location.hash = `#app/${encodeURIComponent(item.appSlug)}`;
      return;
    }
    // #4396: a project the reader joined while it was made is open: the
    // row opens the app itself, which is what there now is to see.
    if (item.kind === 'project_opened' && item.appSlug) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) return App.openAppTab(item.appSlug, 'app');
      window.location.hash = `#app/${encodeURIComponent(item.appSlug)}`;
      return;
    }
    // #6371: the one weekly digest covers every project and names none, so
    // its row (no app) opens the This week page. An older per-project row
    // still falls through with its app and opens that project's discussion.
    if (item.kind === 'weekly_digest' && !item.appSlug && /^w:/.test(String(item.detail || ''))) {
      Notifications._dismissSheetForNav();
      window.location.hash = '#week';
      return;
    }
    if (item.kind === 'vote_digest' && !item.appSlug) {
      Notifications._dismissSheetForNav();
      // Needs you, the page of every vote owed across your projects (One
      // Home, #6361: the Communities screen's list is gone).
      window.location.hash = '#needs';
      return;
    }
    // #5404: the Monday count of the changes you voted on that were decided
    // names no change and no project; the Homeroom bot tab's History lists
    // them, narrowed to votes (it was Me › Your votes until 5 Nov 2026).
    if (item.kind === 'voted_digest') {
      Notifications._dismissSheetForNav();
      window.location.hash = '#homeroom-bot/history?kind=vote';
      return;
    }
    if (item.appSlug) {
      // Every path below navigates (the topic sub-branch returns after
      // routing; an invalid topic ref falls through to the chat/proposals
      // navigation), so one dismiss covers the whole block.
      Notifications._dismissSheetForNav();
      // Mentions/replies/reactions land on the app's discussion, its project
      // page's Discussion tab (see _openAppDiscussion) — unless the message
      // lives in a topic thread (#194 parity), in which case the click opens that
      // issue/proposal/governance discussion where the message is actually
      // visible. Vote nudges and kudos land on the Proposals tab where their
      // PR card lives (deep-linked when we know the session).
      //
      // Navigate via App.openAppTab rather than assigning location.hash:
      // a same-value hash assignment fires no `hashchange`, so clicking a
      // notification for the app/tab already on screen wouldn't re-render.
      // openAppTab always renders (and keeps the URL in sync internally).
      const chatKinds = new Set(['mention', 'reply', 'reaction', 'thread_reply', 'issue_thread_reply', 'change_thread_reply']);
      // #2387: a message in a REPLY thread (thread_type 'message', its ref
      // the thread's first message) opens that thread beside the channel,
      // at the address the server worked out for the row — which the router
      // takes to the project page's Discussion tab, the thread open there
      // (#3653).
      if (chatKinds.has(item.kind) && item.threadType === 'message' && item.threadRef != null) {
        const root = parseInt(item.threadRef, 10);
        const href = typeof item.href === 'string' && item.href.startsWith('#messages/app/')
          ? item.href
          : (Number.isInteger(root) && root > 0
            ? `#messages/app/${encodeURIComponent(item.appSlug)}/thread/${root}` : null);
        if (href) {
          const messages = window.UsernodeReact?.messages;
          if (messages?.openAddress) messages.openAddress(href);
          else window.location.hash = href;
          return;
        }
      }
      // #4417 follow-up: a message in one of the project's TOPIC channels
      // (thread_type 'category', its ref the topic) opens that channel on its
      // project page, brought into view and marked as a #general message is,
      // at the address the server worked out for the row
      // (`#messages/app/<slug>/c/<topic>/m/<id>`, which the router takes to
      // the channel's place). A reply in one of its reply threads is a
      // 'message' row above, whose address names the topic too.
      if (chatKinds.has(item.kind) && item.threadType === 'category' && item.threadRef != null) {
        const topic = parseInt(item.threadRef, 10);
        const message = parseInt(item.chatMessageId, 10);
        const href = typeof item.href === 'string' && item.href.startsWith('#messages/app/')
          ? item.href
          : (Number.isInteger(topic) && topic > 0 && Number.isInteger(message) && message > 0
            ? `#messages/app/${encodeURIComponent(item.appSlug)}/c/${topic}/m/${message}` : null);
        if (href) {
          const messages = window.UsernodeReact?.messages;
          if (messages?.openAddress) messages.openAddress(href);
          else window.location.hash = href;
          return;
        }
      }
      if (chatKinds.has(item.kind) && item.threadType && item.threadRef != null) {
        const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
        const topicKind = kindMap[item.threadType];
        const topicId = parseInt(item.threadRef, 10);
        if (topicKind && Number.isInteger(topicId) && topicId > 0) {
          if (typeof App !== 'undefined' && App.openAppTab) {
            return App.openAppTab(item.appSlug, 'dev', {
              subTab: 'topic',
              ref: { kind: topicKind, id: topicId },
            });
          } else {
            const seg = topicKind === 'issue' ? 'issues'
              : topicKind === 'proposal' ? 'proposals' : 'governance';
            window.location.hash = `#app/${item.appSlug}/dev/${seg}/${topicId}`;
          }
          return;
        }
      }
      // Every kind that is ABOUT A PROPOSAL opens that proposal — the vote
      // nudge, the going-stale warning, the blocked check and the kudos.
      // #6099: the row's own session id is passed as a typed topic ref, so
      // _normalizeTab opens exactly the change the row's title names; the
      // legacy `subTab: 'proposals'` spelling (an id ref too) is no longer
      // needed. Only a row with no session id falls back to its pull request
      // number, and with neither it lands on the board, which is where the
      // card is.
      // #1374 adds three more that are ABOUT A PROPOSAL: it merged, somebody
      // voted on it, and the daily digest of what is waiting on you. The
      // digest reaches here only when it names its one change; a digest of
      // several has no app and opens Needs you (above).
      // #1688: the re-confirm ask names one proposal and opens it; the
      // weekly card is a chat message, so its row opens the chat it is in.
      // B7: "ready to try" opens the change, its preview one tap away.
      const proposalKinds = new Set([
        'pr_proposed', 'stale_pr', 'kudos', 'check_failed',
        'pr_merged', 'proposal_vote', 'vote_digest', 'revision_recheck', 'change_ready',
        // #4787: a change the viewer voted on going live opens that change,
        // the same way the author's own "Live" row does.
        // #6643: an admin asked to approve a held change opens that change.
        'release_hold',
        'voted_change_merged',
      ]);
      const toProposals = proposalKinds.has(item.kind);
      // Run four (13 Oct 2026): a row that asks for the reader's vote (the
      // asks a vote clears, and the digest that names one change) opens the
      // change at its Votes card, not at its title a screen and a half above
      // it (dev-board/topic/votes-in-view.ts).
      if (VOTE_ASK_KINDS.has(item.kind) && item.sessionId) {
        window.UsernodeReact?.devBoard?.showVotes?.(Number(item.sessionId));
      }
      // A new issue opens THAT ISSUE. `detail` is its number (the producer
      // has no issue column), and this row fell through to the app's general
      // chat, a screen that says nothing about the issue it announces.
      // #3952: so does a mention in one, where the words that named you are.
      const issueNumber = (item.kind === 'issue_opened' || item.kind === 'issue_mention')
        && /^\d+$/.test(String(item.detail || ''))
        ? Number(item.detail) : null;
      if (!toProposals && !issueNumber) {
        // Everything else is about a message in the app's general chat — a
        // mention, a reply, a reaction, the weekly card — or has no better
        // page than it.
        Notifications._openAppDiscussion(item.appSlug, item.chatMessageId);
        return;
      }
      // #6099: a row that names a change always opens by its OWN session id
      // when it has one, on every change kind and on both tabs, so two notices
      // about two changes cannot both land on an older change that shares a
      // pull request number. A row with only a number keeps that as its
      // address; one with neither still falls back to the board.
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', toProposals
          ? (item.sessionId || Number(item.prNumber) > 0
            ? { subTab: 'topic', ref: Notifications._changeRef(item.sessionId, item.prNumber) }
            : { subTab: 'proposals', ref: item.sessionId || null })
          : { subTab: 'issues', ref: issueNumber });
      } else {
        window.location.hash = toProposals
          ? (item.sessionId || Number(item.prNumber) > 0
            ? Notifications._changeHash(item.appSlug, item.sessionId, item.prNumber)
            : `#app/${item.appSlug}/dev/proposals`)
          : `#app/${item.appSlug}/dev/issues/${issueNumber}`;
      }
    }
  },

  // AN APP'S DISCUSSION IS ITS PROJECT PAGE'S DISCUSSION TAB (#3653), so a
  // row about a message in it opens it THERE, under the page's own header
  // and tabs. The door is the room's address, `#messages/app/<slug>`: the
  // side panel takes it beside a running app (#2854), a page already open
  // for the project turns to the tab in place, and the router takes it to
  // the tab otherwise (app.js). These rows opened the room on a page of its
  // own — the old full-screen `#app/<slug>/dev/chat`, then the Messages
  // screen — each with a back button of its own.
  //
  // When the row names ONE message, the discussion opens on it rather than
  // at the newest: GroupChat scrolls it into view and flashes it, the same
  // highlight a quote's jump-to-original lands on, once the transcript has
  // loaded (or at once, when that discussion is already open). A message
  // older than the page the discussion loads cannot be shown, and the
  // thread opens at the newest as before. The Messages controller is the
  // one door, with the address as the fallback for a shell still starting.
  _openAppDiscussion(slug, messageId) {
    if (!slug) return;
    if (messageId && typeof GroupChat !== 'undefined' && GroupChat.revealMessage) {
      GroupChat.revealMessage(slug, messageId);
    }
    const messages = window.UsernodeReact?.messages;
    if (messages?.openDiscussion) messages.openDiscussion(slug);
    else window.location.hash = `#messages/app/${encodeURIComponent(slug)}`;
  },

  // --- rendering -------------------------------------------------------

  // Badge total folds in pending invites so an invite is as loud as an
  // unread notification (its underlying collab_invite row may already
  // be read while the invite is still actionable). Less the plain messages
  // (#18, `messageUnread`): the Messages tab counts those, in grey, and one
  // message lit three numbers while the bell counted it too.
  _badgeTotal() {
    return Math.max(0, Notifications.unread - (Notifications.messageUnread || 0)) + Notifications.invites.length;
  },

  // #5289: ONE COUNT, SHOWN ONE WAY. The bell said 99+, the sheet's Unread
  // tab said (81) and the browser tab said (300): three numbers for one
  // question. All three now read _badgeTotal(), the server's account-wide
  // unread (messages included, since the bell owns them) plus the pending
  // invites pinned at the top of the sheet, and all three print it through
  // this one cap. The tab used to sum the rows it had paged in, which is a
  // count of the LIST, not of what is waiting; it is now the bell's number.
  _badgeText(count) {
    return count > 99 ? '99+' : String(count);
  },

  // Of the loaded items, the ones that are a finished dev session
  // specifically. Published on the bell badge as `data-session-done`, so a
  // route check can assert the badge is showing BECAUSE a session finished
  // rather than because something else is unread. Counted from the loaded
  // items page; the unread-dedup keeps completions to one-per-session and
  // they're recent, so they sit within the first page in practice.
  _sessionDoneUnread() {
    return Notifications.items.filter((n) => n && n.kind === 'session_done' && !n.readAt).length;
  },

  _renderBadge() {
    // ONE EVENT, ONE BADGE, ON THE SURFACE THAT OWNS IT — and one count.
    //
    // The bell's number is every unread notification plus pending invites,
    // session kinds included, less the plain messages the Messages tab
    // counts (#18, _badgeTotal). There is no second badge for the bell.
    //
    // The split it replaces put unread session kinds on #improve-btn — the
    // header pill #2718 has since retired altogether — on the grounds that
    // the sessions themselves are behind that button so its
    // count sent you somewhere the bell could not. What it actually did was
    // put a count on a control that CANNOT CLEAR IT: the only things that
    // mark a session notification read are a click on its row in this list,
    // a group-chat mark-read, and mark-all — all of them behind the bell.
    // Opening the Improve panel marks nothing, so a finished session left a
    // number pointing at the one surface with no way to dismiss it, and the
    // viewer never found the notification that was waiting for them. Folding
    // it back in also re-aligned the bell with the two counts that never
    // learned about the split: the tab title (_updateTitle) and the
    // home-screen icon badge (_publishAppBadge, which reads `unread`). Both
    // still count the plain messages the bell leaves out since #18.
    //
    // The pulse dot survived both moves and is the reason the distinction
    // matters: "a session is running right now" is a live fact, true only
    // while it is true, so it needs no dismissal and belongs wherever the
    // work is — the Homeroom mark, since #2718 — while a COUNT is an event
    // waiting to be read and belongs where reading happens.
    const notifCount = Notifications._badgeTotal();

    const paint = (id, count) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (count > 0) {
        el.textContent = Notifications._badgeText(count);
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    };
    // The bell's badge, in the header's right group. The only badge this
    // function paints, and the only one there is.
    //
    // Painting it by id is the sanctioned arrangement rather than an
    // exception: the span is rendered once by <PlatformHeader/> with a
    // CONSTANT className and a constant `data-session-done="0"`, so React
    // never reconciles over what is written here. This module also does not
    // import the store: most of its test harnesses rebuild individual method
    // bodies with `new Function`, so a method that closed over a module-scope
    // binding would be a method those harnesses cannot run.
    paint('notifications-badge', notifCount);

    // How many of those are specifically "your session finished", published
    // as an attribute so a declared check can assert the badge is showing for
    // that reason rather than merely being present.
    const badgeEl = document.getElementById('notifications-badge');
    if (badgeEl) {
      badgeEl.setAttribute('data-session-done', String(Notifications._sessionDoneUnread()));
    }
    // The app-context sheet's per-change unread dots (Streamlined Concept):
    // which sessions have an unread session-kind notification right now.
    // Published into the notifications store — the sheet's rows subscribe.
    //
    // Only when the SET changes. The store compares by identity, so pushing a
    // freshly-built array every time would notify every subscriber (the
    // screen, the pinned sections and every session row) on every badge
    // repaint — and _renderBadge runs on each WS event and each refresh.
    // #5289: the sheet's Unread tab prints the same number, from the store.
    if (Notifications._store && Notifications._store.get().badgeTotal !== notifCount) {
      Notifications._store.set({ badgeTotal: notifCount });
    }
    if (Notifications._store) {
      const ids = Notifications.items
        .filter((n) => isSessionNotif(n) && !n.readAt && n.sessionId)
        .map((n) => n.sessionId);
      const prev = Notifications._store.get().sessionUnreadIds || [];
      const same = prev.length === ids.length && prev.every((v, i) => v === ids[i]);
      if (!same) Notifications._store.set({ sessionUnreadIds: ids });
    }
    Notifications._updateTitle();
    Notifications._publishAppBadge();
    // The cog drawer used to render a pinned section from this same items
    // store and was nudged here whenever the store changed. It is retired;
    // the list in the hamburger is React-rendered from the store directly,
    // so it re-renders on its own.
  },

  // The tab's title keeps counting everything, messages too (#18): it is the
  // one number a tab in the background shows, and it never lit a badge.
  _updateTitle() {
    // "(99+)" as well as "(12)": the prefix is the bell's own text (#5289).
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    const total = Notifications._badgeTotal();
    if (total > 0) document.title = `(${Notifications._badgeText(total)}) ${base}`;
    else document.title = base;
  },

  // #1445: the homescreen icon badge. Two feature-detected targets, both
  // fed the server's account-wide unread total (`Notifications.unread` —
  // the same number countUnread stamps into every push payload, so the
  // icon never disagrees with what the next push would set):
  //
  //   - navigator.setAppBadge / clearAppBadge for installed PWAs. The
  //     Flutter WebView has neither, so the detect no-ops there.
  //   - window.SocialPush.publishBadgeCount for the native shell.
  //     SocialPush owns capability probing and session-admission gating
  //     (it is a classic script loaded before this deferred bundle, but
  //     the optional chain also tolerates a mixed cache generation that
  //     predates the seam).
  //
  // Publishes 0 when signed out so a device is not left badged for a
  // session that ended in-app. Best-effort throughout: a badge failure
  // must never break the bell render this rides on.
  _publishAppBadge() {
    const signedIn = typeof window !== 'undefined' && window.App && App.user;
    const count = signedIn ? Math.max(0, Number(Notifications.unread) || 0) : 0;
    try {
      if (typeof navigator !== 'undefined') {
        if (count > 0 && typeof navigator.setAppBadge === 'function') {
          Promise.resolve(navigator.setAppBadge(count)).catch(() => {});
        } else if (count === 0 && typeof navigator.clearAppBadge === 'function') {
          Promise.resolve(navigator.clearAppBadge()).catch(() => {});
        }
      }
    } catch { /* Unsupported surface — the OS badge is best-effort. */ }
    try {
      if (typeof window !== 'undefined' && window.SocialPush
        && typeof window.SocialPush.publishBadgeCount === 'function') {
        window.SocialPush.publishBadgeCount(count);
      }
    } catch { /* Same stance for the native seam. */ }
  },

  // --- pinned saved-messages section (#1280) ----------------------------

  // Same contract as _renderInvites below: compute descriptors, push them
  // into the store, let ./notifications-list.tsx render them. Empty stays
  // empty — nothing saved renders no "Saved" header at all.
  _renderSaved() {
    const store = Notifications._store;
    if (!store) return;
    // #4769: ONE section over two kinds of save. Each list arrives
    // newest-save-first from the server, but the merge has to interleave
    // them by save time, not concatenate — a message saved today sits
    // above a notification saved last week wherever each belongs. The
    // combined cap is messageBookmarks.MAX_SAVED (SAVED_SECTION_CAP),
    // applied here across both kinds so neither can crowd the other out.
    const savedAtMs = (v) => Date.parse(v && v.savedAt) || 0;
    const merged = [
      ...Notifications.saved.map((s) => ({ ...savedView(s), type: 'message', savedAt: s.savedAt || '' })),
      ...Notifications.savedNotifications.map((n) => ({ ...savedNotificationView(n), type: 'notification' })),
    ].sort((a, b) => savedAtMs(b) - savedAtMs(a))
      .slice(0, SAVED_SECTION_CAP);
    store.set({
      saved: merged,
      touch: isTouchNow(),
    });
  },

  // Clicking a saved row opens the message where it actually lives: the
  // topic discussion when it was posted in one (#194 parity with the
  // mention/reply rows), otherwise the app's discussion in Messages, opened
  // on the saved message (_openAppDiscussion). Deliberately does
  // NOT unsave — a save is not a to-do item, and a row that vanished the
  // moment you looked at it would make the section unusable.
  _onSavedClick(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved) return;
    // A conversation save opens the Messages screen on that conversation, via
    // the island's controller with the hash as the fallback — the same pair
    // _onItemClick uses for the conversation notification kinds, and for the
    // same reason: the hash keeps a native exact-open working during startup
    // before the island publishes. There is no per-message deep link in
    // Messages yet, so it lands on the thread and the reader scrolls, which is
    // the resolution the app-chat branch below settles for too when a message
    // was posted outside a topic.
    if (saved.conversationId) {
      Notifications._dismissSheetForNav();
      const messages = window.UsernodeReact?.messages;
      if (messages?.open) messages.open(saved.conversationId);
      else window.location.hash = `#messages/${saved.conversationId}`;
      return;
    }
    if (!saved.appSlug) return;
    // Both branches below navigate — see _onItemClick for the touch-sheet
    // contract (#1329).
    Notifications._dismissSheetForNav();
    const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
    const topicKind = kindMap[saved.threadType];
    const topicId = parseInt(saved.threadRef, 10);
    if (topicKind && Number.isInteger(topicId) && topicId > 0) {
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(saved.appSlug, 'dev', {
          subTab: 'topic',
          ref: { kind: topicKind, id: topicId },
        });
      } else {
        const seg = topicKind === 'issue' ? 'issues'
          : topicKind === 'proposal' ? 'proposals' : 'governance';
        window.location.hash = `#app/${saved.appSlug}/dev/${seg}/${topicId}`;
      }
      return;
    }
    Notifications._openAppDiscussion(saved.appSlug, saved.messageId);
  },

  // Unsave from the drawer — the "or there" half of "until unsaved in the
  // message / there". Optimistic like the message-side toggle, and it
  // repaints the message's own button when that chat happens to be on
  // screen (GroupChat is a classic-script global lexical binding, so it is
  // reachable by a bare reference behind a typeof guard, not on window).
  async _unsave(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved || !(saved.appSlug || saved.conversationId)) return;
    const endpoint = saved.conversationId
      ? `/api/conversations/${saved.conversationId}/messages/${messageId}/bookmark`
      : `/api/apps/${saved.appSlug}/messages/${messageId}/bookmark`;
    const previous = Notifications.saved;
    Notifications.saved = Notifications.saved.filter((s) => s.messageId !== messageId);
    Notifications._renderSaved();
    if (saved.conversationId) {
      // The Messages twin of the GroupChat repaint below: if that
      // conversation is open, its row's star stops being filled.
      window.UsernodeReact?.messages?.paintSaved?.(messageId, false);
    } else if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
      GroupChat._paintBookmark(messageId, false);
      const msg = GroupChat._findMessage && GroupChat._findMessage(messageId);
      if (msg) msg.bookmarked = false;
    }
    try {
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Put it back rather than leaving the drawer disagreeing with the
      // server about what is saved.
      Notifications.saved = previous;
      Notifications._renderSaved();
      if (saved.conversationId) {
        window.UsernodeReact?.messages?.paintSaved?.(messageId, true);
      } else if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
        GroupChat._paintBookmark(messageId, true);
      }
      console.warn('[notifications] unsave failed', err);
    }
  },

  // #4769: SAVE / UNSAVE A NOTIFICATION. The bookmark button at the feed
  // row's right end and the pinned section's Unsave control are two doors
  // into this one toggle: the row's `saved` flag and the section's list are
  // two views of one fact, so both move together, and a refusal puts both
  // back. Saving deliberately does not touch the row's read state.
  //
  // Optimistic like _unsave above, with clearNotification's guard: only a
  // row still in hand and still carrying THIS toggle's stamp is rolled
  // back, and the saved list is only restored while it is still the very
  // array this toggle edited — a refresh that landed meanwhile replaced it
  // with the server's own truth, which already says what is saved.
  async toggleSave(id) {
    const item = Notifications.items.find((n) => n.id === id);
    const savedEntry = Notifications.savedNotifications.find((n) => n.id === id);
    if (!item && !savedEntry) return;
    // The feed row is the truth when both views exist; a saved row whose
    // feed row is out of reach (older pages, a collapsed run that no longer
    // carries it) still unsaves via its section row.
    const save = item ? !item.saved : false;
    const stamp = new Date().toISOString();

    // 1. Optimistic: flip the feed row's flag and grow or shrink the pinned
    //    section's list, then repaint both.
    const previousSaved = Notifications.savedNotifications;
    if (item) {
      item._saveStamp = stamp;
      item.saved = save;
    }
    let optimisticSaved;
    if (save) {
      // The section row is the feed row's own data plus the save time, so
      // the same per-kind routing opens it on click.
      optimisticSaved = [{ ...item, savedAt: stamp }, ...previousSaved];
    } else {
      optimisticSaved = previousSaved.filter((n) => n.id !== id);
    }
    Notifications.savedNotifications = optimisticSaved;
    Notifications._renderSaved();
    Notifications._renderList();
    try {
      const res = await fetch(`/api/notifications/${id}/save`, {
        method: save ? 'PUT' : 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // 2. Roll back what this toggle touched, and say so.
      if (item && item._saveStamp === stamp && Notifications.items.includes(item)) {
        item.saved = !save;
        delete item._saveStamp;
      }
      if (Notifications.savedNotifications === optimisticSaved) {
        Notifications.savedNotifications = previousSaved;
      }
      Notifications._renderSaved();
      Notifications._renderList();
      window.PlatformUI?.toast?.(t(save
        ? 'notifications:toast.saveFailed'
        : 'notifications:toast.unsaveFailed'));
      console.warn('[notifications] save toggle failed', err);
    }
  },

  // The pinned section's Unsave control — the same toggle the feed row's
  // bookmark runs, reached from its other end.
  async _unsaveNotification(id) {
    return Notifications.toggleSave(id);
  },

  // --- pinned invites section -------------------------------------------

  // The pinned section is a descriptor list now; ./notifications-list.tsx
  // renders it and owns the stopPropagation, the swipe tray and the header.
  // Empty stays empty — an invite-less drawer renders no "Invites" header,
  // exactly as `box.innerHTML = ''` did.
  _renderInvites() {
    const store = Notifications._store;
    if (!store) return;
    store.set({
      invites: Notifications.invites.map(inviteView),
      touch: isTouchNow(),
    });
  },

  _removeInviteLocal(appId, kind) {
    Notifications.invites = Notifications.invites.filter(
      (i) => !(i.appId === appId && (i.kind || 'collab') === (kind || 'collab'))
    );
    Notifications._renderBadge();
    Notifications._renderInvites();
  },

  // An accept that has just brought them into the project answers with
  // `welcome` (src/routes/collaborators.js): it opens "You're in" and its
  // tour (features/first-session), the welcome an invite link ends on
  // (App._followInvite), which ends in the group's chat with the inviter's
  // note waiting and the reply chips under it. Without one, or once that
  // welcome has been shown for this project, the chat opens as before.
  async _acceptInvite(appId, slug, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    // The row's own name for the project, read before the local removal (and
    // the refresh that replaces the list) takes it away (#4740).
    const invite = Notifications.invites.find(
      (i) => i.appId === appId && (i.kind || 'collab') === (kind || 'collab')
    );
    try {
      const res = await fetch(`${base}/${appId}/accept`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        PlatformUI.toast(data.error || t('notifications:invite.acceptFailed', { status: res.status }));
        // The invite may have been revoked — re-sync.
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
      // Pull the fresh state (the invite row is now read) and refresh
      // the home grid — a view-private app just became visible.
      Notifications.refresh();
      if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
        Home.load();
      }
      const target = data.appSlug || slug;
      if (target) {
        // About to navigate — on touch the sheet would otherwise stay
        // presented over the screen this opens (#1329). The people you just
        // joined are in the app's discussion, which is a thread of Messages.
        Notifications._dismissSheetForNav();
        if (kind !== 'approver') {
          if (Notifications._welcome(data.welcome, target)) return;
          // #4740: an accept that lands where the viewer already was said
          // nothing — say what the tap did. When "You're in" opened, that
          // welcome is the confirmation instead. An approver accept is
          // unchanged: it says nothing new.
          const project = (invite && invite.appName) || '';
          window.PlatformUI?.toast?.(project
            ? t('notifications:invite.acceptedBuild', { project })
            : t('notifications:invite.acceptedBuildUnnamed'));
        }
        Notifications._openAppDiscussion(target);
      }
    } catch (err) {
      console.warn('[notifications] acceptInvite failed', err);
    }
  },

  // "You're in" for an accepted invite, through the bridge the invite link
  // uses (window.UsernodeReact.firstSession.welcome). True when it shows.
  _welcome(welcome, slug) {
    const fs = window.UsernodeReact && window.UsernodeReact.firstSession;
    if (!welcome || typeof welcome !== 'object' || !fs || typeof fs.welcome !== 'function') return false;
    const shown = fs.welcome({ ...welcome, slug: welcome.slug || slug, name: welcome.name || slug });
    // The tour opens on Home, where the challenge this join counted is read
    // from a minute's cache (as after an invite link, App._followInvite).
    if (shown) window.HomePanels?.ensureLoaded?.({ force: true });
    return !!shown;
  },

  async _declineInvite(appId, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    try {
      const res = await fetch(`${base}/${appId}/decline`, { method: 'POST' });
      if (!res.ok) {
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
      // #4740: the tap used to only take the row away; say so.
      window.PlatformUI?.toast?.(t('notifications:invite.declined'));
      Notifications.refresh();
    } catch (err) {
      console.warn('[notifications] declineInvite failed', err);
    }
  },

  // Pure transform: items (newest-first) -> ordered groups, in two tiers
  // (#161). Base tier: the first time an app is seen is its newest
  // notification, so insertion order yields most-recent-activity-first
  // group ordering, and each group's items stay newest-first. Priority
  // tier: UNREAD completion notifications (session_done /
  // auto_solve_done) pin to the top — their group floats above the
  // others and the pinned items lead within their group (so they also
  // become the collapsed header's preview). Both re-sorts are stable
  // partitions, so ordering inside each tier is unchanged; once a
  // completion is read it drops back to its chronological spot.
  // Items the list renders: ALL of them.
  //
  // This used to exclude the session-related kinds (session_done,
  // auto_solve_done, stale_pr, check_failed), because those rendered in the
  // header cog's pinned "Needs attention" section instead. THE UI OVERHAUL
  // retired the cog, so keeping the filter would make four notification kinds
  // invisible everywhere — the one thing a drawer merge must not do.
  //
  // The badge split is gone too — one bell, one number, session kinds
  // included (see _renderBadge). isSessionNotif is still here for the
  // app-context sheet's per-change unread dots, which need to know which
  // sessions have an unread notification against them.
  // ── New vs older (#1367 follow-up) ───────────────────────────────
  //
  // The drawer shows what is NEW. A notification you have already read has
  // done its job — it told you a thing — and leaving it in the list means the
  // one that arrived this morning is buried under three weeks of things you
  // have already dealt with. So the default list is the UNREAD ones, and the
  // read ones are one tap away behind "See older notifications".
  //
  // `readAt` is the existing server-side field and the existing meaning of
  // "viewed": it is set when you click a notification, when you use a group's
  // "Mark read", and by "Mark all read". Nothing new is stored, and nothing is
  // deleted — "go away" here means "leave the new list", which is why the
  // older view can always bring them back.
  //
  // Per drawer OPEN, not persisted: `sv:drawer-open` resets it to false (see
  // init), so a visit always starts on what is new.
  showOlder: false,

  _setShowOlder(next) {
    const value = !!next;
    if (Notifications.showOlder === value) return;
    Notifications.showOlder = value;
    if (Notifications.items.length) Notifications._renderList();
  },

  /** The controller entry point behind the footer button. */
  toggleOlder() {
    Notifications._setShowOlder(!Notifications.showOlder);
  },

  /** Every notification the bell owns, read or not. */
  _allBellItems() {
    return Notifications.items;
  },

  /** What the list actually renders: unread only, unless older is revealed. */
  _bellItems() {
    if (Notifications.showOlder) return Notifications.items;
    return Notifications.items.filter((n) => !n.readAt);
  },

  // One descriptor per notification, newest-first — the whole list, flat
  // (#1385). The list component owns every handler this method used to attach
  // by querySelectorAll: the row clicks, the foot pager and the touch swipe
  // tray. All of them still stopPropagation, for the reason they always did: a
  // re-render detaches the clicked node, and the document-level outside-click
  // handler would then see a target outside the panel and wrongly dismiss the
  // drawer.
  _renderList() {
    const store = Notifications._store;
    if (!store) return;
    const touch = isTouchNow();

    // How many read notifications the older view would add. Drives the footer
    // button's presence AND its count, and separates the two empty states
    // below: "nothing has ever arrived" is not the same as "you are caught
    // up", and telling a viewer the first when the second is true reads as
    // the drawer having lost their history.
    const olderCount = Notifications._allBellItems().filter((n) => n.readAt).length;

    if (Notifications._bellItems().length === 0) {
      // The pinned sections may still have content — only show the empty
      // hint when there's truly nothing in the drawer. #1280 added the
      // saved section to that "truly nothing" test: a drawer showing your
      // saved messages while telling you nothing has arrived yet reads as
      // a bug.
      store.set({
        list: [],
        // The full screen shows read rows regardless of the drawer's
        // showOlder reveal, so its list maps ALL items even when the
        // drawer's own list is empty (Streamlined Concept).
        screenList: screenViews(Notifications.items),
        // `empty` is still the ORIGINAL "you have never had a notification"
        // hint, so it now also requires that there be no older ones to
        // reveal — otherwise a fully-read drawer would claim nothing had
        // ever arrived while offering to show you what had.
        empty: Notifications.invites.length === 0
          && Notifications.saved.length === 0
          && Notifications.savedNotifications.length === 0
          && olderCount === 0,
        // …and this is the new one: caught up, with history behind it.
        caughtUp: olderCount > 0 && !Notifications.showOlder,
        olderCount,
        showOlder: Notifications.showOlder,
        // Nothing to append a pager to — see the note in the populated branch.
        canLoadMore: false,
        // The screen HAS rows to append to (the read ones above), so its
        // pager follows the server cursor even while the drawer's is off.
        screenCanLoadMore: Notifications.hasMore,
        loadingMore: Notifications.loading,
        // #5527: the Unread tab's own pager. Offered only while the bell
        // counts more unread than the list has loaded — a viewer who is
        // caught up (or whose whole unread fit on the first page) gets
        // nothing to tap.
        unreadCanLoadMore: Notifications.unreadHasMore && Notifications._unreadShort(),
        loadingUnread: Notifications.unreadLoading,
        refreshTick: Notifications.refreshTick,
        touch,
      });
      return;
    }

    // Straight through, in `items` order. No partition and no re-sort: the
    // feed is already newest-first, and a flat list that reorders itself is
    // exactly the thing #1385 asked to stop. (Unread completion notifications
    // used to float to the top of the grouped list; see PRIORITY_KINDS.)
    store.set({
      list: Notifications._bellItems().map(rowView),
      screenList: screenViews(Notifications.items),
      empty: false,
      caughtUp: false,
      olderCount,
      showOlder: Notifications.showOlder,
      // The foot pager, and whether a page is already in flight. Offered only
      // when there are rows to append to — with none, the empty/caught-up hint
      // owns that space and the older-toggle is the affordance that belongs
      // there.
      canLoadMore: Notifications.hasMore,
      screenCanLoadMore: Notifications.hasMore,
      loadingMore: Notifications.loading,
      // #5527: the Unread tab's pager, on its own cursor — see loadMoreUnread().
      unreadCanLoadMore: Notifications.unreadHasMore && Notifications._unreadShort(),
      loadingUnread: Notifications.unreadLoading,
      refreshTick: Notifications.refreshTick,
      touch,
    });
  },

  /**
   * The list's foot pager: pull the next page of older notifications.
   *
   * This is the flat-list replacement for `_showMoreGroup`, which #1385
   * retired along with the group chrome it lived in. It is deliberately a
   * method rather than a direct `loadMore` binding on the button, because the
   * two are not the same thing: `loadMore()` is the transport (it no-ops while
   * a page is in flight, or once the cursor is exhausted) and this is the
   * user-facing action, which the drawer may later want to guard differently.
   *
   * There is NO client-side reveal cap any more. The old one existed to keep
   * an expanded group from unrolling thirty rows inside a collapsed list; a
   * flat list already shows what it has loaded, so a second cap on top of the
   * server's page size would only hide rows the viewer had already paid to
   * fetch. `loadMore()` re-renders on completion, so the arriving page simply
   * appears at the bottom.
   */
  loadOlder() {
    if (!Notifications.hasMore || Notifications.loading) return;
    Notifications.loadMore();
  },

};

const CONVERSATION_NOTIF_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
  // #2387: a reply in a thread the viewer started or replied in.
  'conversation_thread_reply',
  // WP-E: the Homeroom bot's message at one of its build moments
  // (src/services/notifications.js); its own kinds only so the push
  // category can be its own. It opens the bot's chat like any message.
  'build_ready',
  'build_needs_you',
  'build_stopped',
  'build_live',
]);

// #2387: where a conversation row opens. A thread alert opens its thread; a
// row about one message (mention, quote-reply, reaction) opens that message's
// permalink, which lands inside its thread when it lives in one; an invite or
// a plain new-message row opens the conversation itself.
function conversationNotificationHref(n) {
  const valid = (v) => Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
  const conversationId = Number(n && n.conversationId);
  // 5 Nov 2026: a request's moment rung from its stage (services/work-state.js)
  // to somebody who never wrote to the bot names no chat; it opens the request.
  if (!valid(conversationId) && n && BUILD_KIND_MOMENTS[n.kind]) {
    const detail = parseBotDetail(n.detail) || {};
    const slug = BOT_SLUG_RE.test(String(n.appSlug || '')) ? String(n.appSlug) : (detail.appSlug || '');
    const issue = storyIssueOf(n) || detail.issueNumber;
    return slug && valid(Number(issue)) ? `#homeroom-bot/request/${slug}/${Number(issue)}` : null;
  }
  if (!valid(conversationId)) return null;
  const messageId = Number(n.conversationMessageId);
  const rootId = Number(n.conversationThreadRootId);
  if (n.kind === 'conversation_thread_reply' && valid(rootId)) {
    return `#messages/${conversationId}/thread/${rootId}`;
  }
  // "One story": one of Homeroom bot's moments opens its request's thread in
  // the chat with the bot: the thread its message is in, or the card the
  // detail names (services/homeroom-bot-notify-copy.js); else the message
  // itself, whose permalink lands inside its thread. 1 Nov 2026: on the bot's
  // tab, the chat's only place (features/ai/door.ts botTabAddress).
  // 4 Nov 2026 (#6290): a request's news lives in the request's OWN thread
  // since #6207, so a moment (or a bot reply) that names a request opens it
  // there (#homeroom-bot/request/<slug>/<n>, features/ai/door.ts
  // botItemAddress) rather than landing in Main Chat with nothing about it.
  if (BUILD_KIND_MOMENTS[n.kind] || isBotMomentDetail(n.detail)
      || (isBotUsername(n.sourceUsername) && storyIssueOf(n) && n.appSlug)) {
    const root = valid(rootId) ? rootId : (parseBotDetail(n.detail) || {}).threadRootId;
    if (valid(root)) return `#homeroom-bot/thread/${root}`;
    const detail = parseBotDetail(n.detail) || {};
    const slug = BOT_SLUG_RE.test(String(n.appSlug || '')) ? String(n.appSlug) : (detail.appSlug || '');
    const issue = storyIssueOf(n) || detail.issueNumber;
    if (slug && valid(Number(issue))) return `#homeroom-bot/request/${slug}/${Number(issue)}`;
    if (valid(messageId)) return `#homeroom-bot/main/m/${messageId}`;
    return '#homeroom-bot/main';
  }
  if (['conversation_mention', 'conversation_reply', 'conversation_reaction'].includes(n.kind)
      && valid(messageId)) {
    return `#messages/${conversationId}/m/${messageId}`;
  }
  return `#messages/${conversationId}`;
}

// #2386: the two friend kinds (src/services/notifications.js
// FRIEND_NOTIFICATION_KINDS). No app and no conversation — a person.
const FRIEND_NOTIF_KINDS = new Set(['friend_request', 'friend_accept']);

// services/platform-limit-alerts.js detailToken(): "<limit>_<level>:<used>:<cap>".
const PLATFORM_LIMIT_DETAIL_RE = /^(apps|sessions|github|github_app)_(warn|full):(\d{1,7}):(\d{1,7})$/;

function parsePlatformLimitDetail(detail) {
  const m = PLATFORM_LIMIT_DETAIL_RE.exec(String(detail || ''));
  return m ? { limit: m[1], level: m[2], used: Number(m[3]), cap: Number(m[4]) } : null;
}

// services/platform-incident-alerts.js tokens (#4296): "digest:<total>:<kind>=<n>,..."
// (the previous UTC day, per kind) or "hour:<kind>:<n>" (one kind past its
// hourly line).
const PLATFORM_INCIDENT_DIGEST_RE = /^digest:(\d{1,5}):((?:[a-z][a-z0-9_]{0,23}=\d{1,5})(?:,[a-z][a-z0-9_]{0,23}=\d{1,5})*)?$/;
const PLATFORM_INCIDENT_HOUR_RE = /^hour:([a-z][a-z0-9_]{0,23}):(\d{1,5})$/;
// services/platform-signals.js: "signal:<n>", a problem the platform found in
// itself and filed as request #n on its own board, for a person to fix; and
// "private:<id>", one it filed as private request <id> (a security finding),
// which only admins see, in the Workshop's Private requests.
const PLATFORM_INCIDENT_SIGNAL_RE = /^signal:(\d{1,9})$/;
const PLATFORM_INCIDENT_PRIVATE_RE = /^private:(\d{1,10})$/;

function parsePlatformIncidentDetail(detail) {
  const s = String(detail || '');
  const sig = PLATFORM_INCIDENT_SIGNAL_RE.exec(s);
  if (sig) return { type: 'signal', issueNumber: Number(sig[1]) };
  const priv = PLATFORM_INCIDENT_PRIVATE_RE.exec(s);
  if (priv) return { type: 'private', privateRequestId: Number(priv[1]) };
  const h = PLATFORM_INCIDENT_HOUR_RE.exec(s);
  if (h) return { type: 'hour', kind: h[1], n: Number(h[2]) };
  const d = PLATFORM_INCIDENT_DIGEST_RE.exec(s);
  if (!d) return null;
  const kinds = d[2] ? d[2].split(',').map((p) => { const [kind, n] = p.split('='); return { kind, n: Number(n) }; }) : [];
  return { type: 'digest', total: Number(d[1]), kinds };
}

// #161 defined these as the kinds that "demand attention": a finished dev
// session or headless run, while still unread.
//
// #1385 stopped the DRAWER acting on it. The pin was a grouped-list device — it
// floated an app's group above the others and led within it, which is also what
// made it the collapsed header's preview — and a flat list the request asked to
// be chronological cannot also reorder itself. Nothing was deleted: the set
// still drives DevChat's completion title through isPriorityNotif() below, and
// restoring a top-of-list pin is one stable partition in _renderList if the
// group decides it wants one.
//
// Deliberately limited to these kinds; grow this set rather than adding a
// server-side priority column if more "priority" kinds emerge. #3181 grew it
// by session_stalled: a session that stopped before finishing demands the
// same attention as one that finished, on the same channels (the tab title,
// the chime, the OS notification; see handleIncoming).
const PRIORITY_KINDS = new Set(['session_done', 'session_stalled', 'auto_solve_done']);
// The rows that ask for the reader's vote on one change: the asks a vote
// clears (services/notifications.js, `vote_cast`), and the daily digest
// when it names one change. Each opens the change at its Votes card.
const VOTE_ASK_KINDS = new Set(['pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready', 'vote_digest']);
function isPriorityNotif(n) {
  return !!n && PRIORITY_KINDS.has(n.kind) && !n.readAt;
}

// The system-generated (source-user-less) notifications about the
// viewer's OWN sessions and proposals. Everything social — mentions,
// replies, reactions, kudos, vote nudges, invites, spec shares — is
// everything else.
//
// These used to render in the header cog's drawer INSTEAD of the bell, and
// this set was the filter that kept the two apart. THE UI OVERHAUL merged
// both into the hamburger, so all of it renders in one list now. The badge
// split that outlived the drawer is gone as well — the bell counts these
// along with everything else — so what the set is left doing is naming the
// kinds the app-context sheet draws a per-change unread dot for
// (`sessionUnreadIds`, published by _renderBadge). #3181 adds the fifth,
// session_stalled: a change that stopped before finishing is exactly what
// that dot should point at.
const SESSION_NOTIF_KINDS = new Set([
  'session_done', 'session_stalled', 'auto_solve_done', 'stale_pr', 'check_failed',
]);
function isSessionNotif(n) {
  return !!n && SESSION_NOTIF_KINDS.has(n.kind);
}
if (typeof window !== 'undefined') window.SESSION_NOTIF_KINDS = SESSION_NOTIF_KINDS;

// PlatformUI is a classic-script global. The vm harnesses that evaluate this
// file don't define it, and neither does the SSG prerender pass.
function isTouchNow() {
  return typeof PlatformUI !== 'undefined' && !!PlatformUI.isTouch && PlatformUI.isTouch();
}

// #1280: one saved message, as data. The row reads "@author in AppName ·
// 2h ago" over a two-line snippet of the message, which is the same shape
// the mention/reply rows use — a saved message and a message you were
// mentioned in are the same object, and looking different for no reason
// would just make the drawer harder to read.
//
// `time` is the age of the SAVE, not of the message: the section is
// ordered by when you saved things, so a timestamp measuring anything else
// would contradict the order the rows are in.
// One section, two kinds of save. A conversation save carries a
// `conversationId` and no `appSlug`; an app-chat save the reverse — that
// field IS the discriminator, here and at the click and unsave sites, so
// nothing has to carry a separate `kind` string that could disagree with it.
//
// `appName` keeps its name in the descriptor because the component renders it
// as "@who in <that>", and the answer to "in what" is the app for one kind
// and the conversation for the other. Renaming the field to suit both would
// have touched every call site to say the same thing.
// The row's first line is one message, "@who in <place> · 2h ago", chosen
// here by what is known: `line` is its id, `author` and `appName` its
// parameters (an unnamed place is in the message's own words).
const SAVED_LINE_IDS = {
  author: ['notifications:saved.line.author', 'notifications:saved.line.authorConversation', 'notifications:saved.line.authorApp'],
  system: ['notifications:saved.line.system', 'notifications:saved.line.systemConversation', 'notifications:saved.line.systemApp'],
};
function savedView(s) {
  const conversationId = Number(s.conversationId) || 0;
  const place = conversationId ? (s.conversationTitle || '') : (s.appName || s.appSlug || '');
  return {
    messageId: s.messageId,
    slug: s.appSlug || '',
    conversationId,
    who: s.author ? `@${s.author}` : t('notifications:saved.system'),
    author: s.author || '',
    appName: place,
    line: SAVED_LINE_IDS[s.author ? 'author' : 'system'][place ? 0 : (conversationId ? 1 : 2)],
    ...stampFields(s.savedAt),
    text: (s.content || '').slice(0, 140),
  };
}

// #4769: a saved NOTIFICATION in the same pinned section, as data. The
// section is one renderer over two kinds of save, so this carries the fields
// that row needs: the kind line and subject the feed row shows (rowView's
// `label` and `segments`, by kind) and the feed row's glyph for the tile.
// `time` is the age of the SAVE — when the user pinned it — not of the
// notification, for the same reason savedView's is; a week-old notification
// saved today was saved today.
const SAVED_SECTION_CAP = 50; // messageBookmarks.MAX_SAVED, applied client-side
function savedNotificationView(n) {
  const view = rowView(n);
  return {
    id: n.id,
    icon: view.icon,
    label: view.label,
    segments: view.segments,
    savedAt: n.savedAt || '',
    ...stampFields(n.savedAt),
  };
}

// #646: approver invites share the pinned section, with distinct copy and
// their own accept/decline endpoints. The descriptor carries the endpoint
// discriminator (`kind`) as well as the copy, because the component's
// buttons and its swipe tray both need it.
//
// A collaborator invite into a private project is an invitation to JOIN it
// (`joins`, src/services/notifications.js listPendingInvites): being invited
// in is how anybody joins a group. It reads the way an invite link's page
// does, with the inviter's note and how many are in it. "Invited you to
// build" is left for a project anyone can use but only its invited people
// build. First-session run-through, 5 October 2026: a group's invite by
// username said "invited you to build", with no note and no headcount.
// The invite's sentence is one message, "@who invited you to join <project>",
// chosen here by what is asked and what is known: `line` is its id,
// `inviter` and `appName` its parameters. In each row: both named, the
// project unnamed, the inviter unnamed, neither named.
const INVITE_LINE_IDS = {
  approve: ['notifications:invite.line.approve', 'notifications:invite.line.approveUnnamed',
    'notifications:invite.line.someoneApprove', 'notifications:invite.line.someoneApproveUnnamed'],
  join: ['notifications:invite.line.join', 'notifications:invite.line.joinUnnamed',
    'notifications:invite.line.someoneJoin', 'notifications:invite.line.someoneJoinUnnamed'],
  build: ['notifications:invite.line.build', 'notifications:invite.line.buildUnnamed',
    'notifications:invite.line.someoneBuild', 'notifications:invite.line.someoneBuildUnnamed'],
};
function inviteView(inv) {
  const isApprover = inv.kind === 'approver';
  const count = Number(inv.memberCount) || 0;
  const project = inv.appName || inv.appSlug || '';
  return {
    appId: inv.appId,
    slug: inv.appSlug || '',
    kind: isApprover ? 'approver' : 'collab',
    icon: isApprover ? '🗳️' : '✉️',
    who: inv.invitedBy ? `@${inv.invitedBy}` : t('notifications:invite.someone'),
    inviter: inv.invitedBy || '',
    line: INVITE_LINE_IDS[isApprover ? 'approve' : inv.joins ? 'join' : 'build'][
      (inv.invitedBy ? 0 : 2) + (project ? 0 : 1)],
    appName: project,
    note: !isApprover && inv.note ? String(inv.note) : '',
    // #4740: on a project the viewer already joined (by a link or the Join
    // button) a build invite still offers something they do not have — the
    // right to build it — so the row stays, and its meta line says they are
    // already in it instead of a headcount they are part of.
    members: isApprover ? '' : (inv.inCommunity
      ? t('notifications:invite.alreadyIn')
      : (count ? t('notifications:invite.members', { count }) : '')),
    ...stampFields(inv.createdAt),
  };
}


// #138: derive the title/body + deep-link fields for a completion alert
// (chime/OS notification) from a notification row. Mirrors the per-kind copy in
// rowView so the OS notification reads the same as the bell-menu entry. (It
// used to name previewText too — that was the collapsed group header's
// one-liner, which #1385 retired with the rest of the group chrome.)
// Each body is a whole message, picked by what is known. In order: the
// request's number and the app both known, the app unknown ("your app"), the
// number unknown ("a request"), neither known.
const ALERT_CHANGE_IDS = {
  failed: {
    title: 'notifications:alert.change.failed.title',
    body: ['notifications:alert.change.failed.body', 'notifications:alert.change.failed.bodyYourApp',
      'notifications:alert.change.failed.bodyARequest', 'notifications:alert.change.failed.bodyARequestYourApp'],
  },
  question: {
    title: 'notifications:alert.change.question.title',
    body: ['notifications:alert.change.question.body', 'notifications:alert.change.question.bodyYourApp',
      'notifications:alert.change.question.bodyARequest', 'notifications:alert.change.question.bodyARequestYourApp'],
  },
  ready: {
    title: 'notifications:alert.change.ready.title',
    body: ['notifications:alert.change.ready.body', 'notifications:alert.change.ready.bodyYourApp',
      'notifications:alert.change.ready.bodyARequest', 'notifications:alert.change.ready.bodyARequestYourApp'],
  },
};
// The same for a finished session: the app and the title both known, the app
// unknown, the title unknown ("your session"), neither known.
const ALERT_AGENT_DONE_IDS = ['notifications:alert.agentDone.body', 'notifications:alert.agentDone.bodyYourApp',
  'notifications:alert.agentDone.bodyYourSession', 'notifications:alert.agentDone.bodyYourAppYourSession'];
const ALERT_SESSION_DONE_IDS = ['notifications:alert.sessionDone.body', 'notifications:alert.sessionDone.bodyYourApp',
  'notifications:alert.sessionDone.bodyYourSession', 'notifications:alert.sessionDone.bodyYourAppYourSession'];

function completionAlertInfo(n) {
  const app = n.appName || '';
  if (n.kind === 'auto_solve_done') {
    const number = n.headlessIssueNumber || null;
    const copy = ALERT_CHANGE_IDS[n.detail === 'failed' ? 'failed' : n.detail === 'question' ? 'question' : 'ready'];
    const title = t(copy.title);
    const body = t(copy.body[(number ? 0 : 2) + (app ? 0 : 1)], { number, app });
    return {
      kind: n.kind,
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      headlessIssueNumber: n.headlessIssueNumber || null,
      title,
      body,
    };
  }
  // #3181: the turn stopped before finishing (an error, a timeout, a lost
  // worker). Same deep link as a finished one; the copy says what to do.
  if (n.kind === 'session_stalled') {
    return {
      kind: 'session_stalled',
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      ...(n.agentSessionId ? { agentSessionId: n.agentSessionId } : {}),
      headlessIssueNumber: null,
      title: t('notifications:alert.stalled.title'),
      body: app ? t('notifications:alert.stalled.body', { app }) : t('notifications:alert.stalled.bodyYourApp'),
    };
  }
  // session_done — #971: the session's own title first, then the PR title,
  // and only then the machine-generated branch name.
  const title = n.sessionTitle || n.prTitle || n.branchName || '';
  const which = (title ? 0 : 2) + (app ? 0 : 1);
  if (n.agentSessionId) {
    // #2779: a run in an agent session (a spec drafted or a build done).
    return {
      kind: 'session_done',
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      agentSessionId: n.agentSessionId,
      headlessIssueNumber: null,
      title: t('notifications:alert.agentDone.title'),
      body: t(ALERT_AGENT_DONE_IDS[which], { app, title }),
    };
  }
  return {
    kind: 'session_done',
    appSlug: n.appSlug || null,
    sessionId: n.sessionId || null,
    headlessIssueNumber: null,
    title: t('notifications:alert.sessionDone.title'),
    body: t(ALERT_SESSION_DONE_IDS[which], { app, title }),
  };
}


// Consecutive notifications from ONE conversation, as a single row.
//
// A message notification is created per member PER MESSAGE (sendMessage in
// services/conversations.js), so a friend sending four lines puts four
// near-identical rows in the sheet and buries everything else under them.
// The per-conversation count was the one thing the retired Messages tag did
// better than the bell, and this is where it comes back: the run collapses to
// its newest row carrying `count`, so a thread reads as one thing.
//
// CONSECUTIVE, not "all rows for this conversation". The feed is newest-first
// chronological and the collapsed row sits exactly where its newest member
// sat, so nothing reorders and nothing jumps a section boundary. Two bursts
// with other notifications between them stay two rows, which is honest: they
// happened at different times, and merging them would date the older one
// wrongly.
//
// The read state has to match too. A run is entirely unread or entirely read,
// which is what lets the sheet's Unread tab filter whole rows without ever
// hiding an unread message inside a row it counted as read.
function collapseConversationRuns(items) {
  const runs = [];
  for (const n of items) {
    const prev = runs[runs.length - 1];
    const id = n && n.conversationId != null ? Number(n.conversationId) : null;
    // B4: the bot's moments are each their own news ("I have a question",
    // then "is live"), so none of them folds into a run or takes one in.
    // ("hrbot:<said>:<app>" on a row from before "one story", "hrbot2:{…}"
    // now; kept to the shape here so the function stands on its own.)
    const moment = !!(n && /^hrbot(?::[a-z_]{1,20}:|2:\{)/.test(String(n.detail || '')));
    if (prev && id !== null && prev.conversationId === id
        && prev.read === !!n.readAt && !moment && !prev.moment) {
      prev.count += 1;
      continue;
    }
    runs.push({ item: n, conversationId: id, read: !!(n && n.readAt), count: 1, moment });
  }
  return runs;
}

// The sheet's rows: one descriptor per run. `count` rides only on a genuine
// collapse, so a lone notification's view is byte-identical to what it was.
function screenViews(items) {
  return collapseConversationRuns(items).map((run) => {
    const view = rowView(run.item);
    return run.count > 1 ? { ...view, count: run.count } : view;
  });
}

// One notification row, as data. It has ONE renderer — ScreenRow in
// ./notifications-sheet.tsx — which draws THREE lines:
//
//     <kind>                                        ← `label`
//     <subject>                                     ← `segments`
//     <where> · by @<who> · <when>                  ← `appLine` / `by` / `time`
//
// ── WHAT KIND, THEN WHICH ONE, THEN WHERE FROM ───────────────────────
//
// Every kind used to write a SENTENCE about itself: "@evan proposed a PR to
// vote on in Notes", "Your dev session in Notes finished", "Proposal for issue
// #12 in Notes is ready". Three problems, and they compound:
//
//   1. The app's name was in the sentence AND in the meta line directly under
//      it. Every row said where it came from twice.
//   2. The actor was in the sentence, so the row led with a username rather
//      than with what happened — and a list of them all started the same way.
//   3. The SUBJECT (the PR's title, the session's name) was in `body`, a
//      third line this renderer does not draw. So the one thing that told two
//      proposal notifications apart was not on screen at all.
//
// So the sentence is gone. What is left are three FACTS, and the row now gives
// each of them its own line instead of packing two into a headline:
//
//   `label`     what KIND of thing this is: "New proposal", "Submitted by
//               your agent", "Session finished". A short category, and the
//               same words for every row of that kind, so a list of them
//               scans down the left edge.
//   `segments`  WHICH one: the PR's title, the session's name, the message.
//               This used to be `body`, a third field nothing rendered, so
//               the one thing telling two proposal rows apart was invisible.
//   the meta    WHERE it came from and who did it — everything the old
//               sentence was repeating out of the line under itself.
//
// They were one line for a round, joined by a colon ("New proposal: Fix the
// header spacing"), and that line is where a row runs out of width first: the
// subject is the part that varies and the part that truncates, and it was
// paying for a label of fixed length in front of it on every row. Split, the
// label sits in the kind's own smaller ink and the subject gets the full
// width — the same three facts, in falling order of how much of the row's
// width they deserve.
//
// `segments` is the subject, as parts:
//   { t: 'who' }    → @username, in the strong ink
//   { t: 'strong' } → a title, a conversation, an issue ref
//   { t: 'text' }   → connecting words
// Every value is RAW text. Escaping is the renderer's job, and React does it
// by construction — which is the point of moving the rows there.
//
// A kind with nothing to name — a collaborator invite is entirely its own
// label — leaves `segments` EMPTY, and the renderer then draws the label on
// the subject's line and no kind line at all. Two lines when there are two
// things to say; a category heading over nothing would be worse than either.
//
// `by` is the meta line's attribution and is set ONLY where the source user is
// the ACTOR. The two OpenRouter-key rows carry a `sourceUsername` that is the
// SUBJECT instead — it names whose key it is — and "by @them" would be a false
// claim about who did something, so those keep the name in the headline and
// set no `by` at all. A system row — a stale PR, a failed check, a finished
// session — has no actor and no `by` either.
// The two lines of a row's own copy. Spread into the view — `...headline(…)`
// — rather than assigned to one field, because it fills two.
// B4 / "one story": the Homeroom bot's moments, and its answer to what
// somebody just wrote to it, as notifications.detail carries them:
// `hrbot2:{…}` (services/homeroom-bot-notify-copy.js botNotificationDetail),
// or `hrbot:<said>:<app>` on a row from before. The bell heads the row with
// the moment ("Needs you", "Ready to try", "Stopped", "On hold", "Live")
// over the request's title, with the project and "Homeroom bot" under it;
// the push says the same request and project (botMomentCopy there;
// tests/homeroom-bot-notify.test.js holds the two together).
const BOT_DETAIL_PREFIX = 'hrbot2:';
const BOT_LEGACY_RE = /^hrbot:([a-z_]{1,20}):(.*)$/;
// A project slug, as features/ai/door.ts reads one (SLUG there): a request's
// address is `#homeroom-bot/request/<slug>/<n>`, so both parts must be its shape.
const BOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const BOT_MOMENT_ALIASES = { question: 'needs_you', held: 'on_hold' };
const BOT_LABEL_IDS = {
  needs_you: 'notifications:row.bot.label.needsYou',
  ready: 'notifications:row.bot.label.ready',
  stopped: 'notifications:row.bot.label.stopped',
  on_hold: 'notifications:row.bot.label.onHold',
  live: 'notifications:row.bot.label.live',
  done_elsewhere: 'notifications:row.bot.label.doneElsewhere',
};
// 16 Oct 2026: what a "needs you" asks for, heading its row in place of the
// bare moment (homeroom-bot-notify-copy.js NEEDS_YOU_ASKS, held to these by
// tests/homeroom-bot-notify.test.js). By `said`; any other keeps "Needs you".
const BOT_ASK_IDS = {
  question: 'notifications:row.bot.ask.question',
  questions: 'notifications:row.bot.ask.questions',
  followup_ask: 'notifications:row.bot.ask.question',
  plan: 'notifications:row.bot.ask.plan',
  plan_first: 'notifications:row.bot.ask.plan',
  decide: 'notifications:row.bot.ask.decide',
  blocked: 'notifications:row.bot.ask.moreDetail',
  empty: 'notifications:row.bot.ask.moreDetail',
  done: 'notifications:row.bot.ask.done',
  platform: 'notifications:row.bot.ask.platform',
};
// A row from before "one story": the moment each old token is.
const BOT_LEGACY_MOMENTS = {
  question: 'needs_you',
  ready: 'ready', ready_group: 'ready', ready_broken: 'ready',
  stopped: 'stopped', stopped_build: 'stopped', stopped_first: 'stopped', stopped_preview: 'stopped', stopped_look: 'stopped',
  stopped_blocked: 'needs_you', stopped_person: 'needs_you', stopped_empty: 'needs_you',
  held: 'on_hold',
  live: 'live', live_soon: 'live', live_first: 'live', live_first_soon: 'live',
  reply: 'reply',
};
// The build kinds' moments, for a row that carries no detail.
const BUILD_KIND_MOMENTS = {
  build_ready: 'ready', build_needs_you: 'needs_you', build_stopped: 'stopped', build_live: 'live',
};
function oneLine(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}
// A detail read back, or null when it is not the bot's.
function parseBotDetail(detail) {
  const s = typeof detail === 'string' ? detail : '';
  if (s.startsWith(BOT_DETAIL_PREFIX)) {
    let raw = null;
    try { raw = JSON.parse(s.slice(BOT_DETAIL_PREFIX.length)); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const moment = BOT_MOMENT_ALIASES[raw.m] || raw.m;
    if (moment === 'reply') return { moment };
    if (!Object.prototype.hasOwnProperty.call(BOT_LABEL_IDS, moment)) return null;
    return {
      moment,
      said: typeof raw.s === 'string' ? raw.s : '',
      appName: oneLine(raw.a, 80),
      requestTitle: oneLine(raw.t, 120),
      firstVersion: raw.f === 1 || raw.f === true,
      deciders: oneLine(raw.d, 120),
      count: positiveId(raw.c),
      issueNumber: positiveId(raw.i),
      appSlug: BOT_SLUG_RE.test(String(raw.p || '')) ? String(raw.p) : '',
      threadRootId: positiveId(raw.r),
    };
  }
  const m = BOT_LEGACY_RE.exec(s);
  if (!m || !BOT_LEGACY_MOMENTS[m[1]]) return null;
  const moment = BOT_LEGACY_MOMENTS[m[1]];
  if (moment === 'reply') return { moment };
  return {
    moment,
    said: '',
    appName: oneLine(m[2], 80),
    requestTitle: '',
    firstVersion: /^live_first/.test(m[1]) || m[1] === 'stopped_first',
    deciders: '',
    count: null,
    issueNumber: null,
    appSlug: '',
    threadRootId: null,
  };
}
// #5929 item 5: why a request is on hold, by which of the moment's words the
// server chose (homeroom-bot-notify-copy.js, SAID_BY_MOMENT.on_hold, and its
// thread copy for each). Only `allowance` is about this week's building time,
// so the reason follows `said`; a row from before `said` was written says none.
const BOT_ON_HOLD_NOTE_IDS = {
  allowance: 'notifications:row.bot.onHoldNote.allowance',
  paused: 'notifications:row.bot.onHoldNote.paused',
  slots: 'notifications:row.bot.onHoldNote.slots',
  builds: 'notifications:row.bot.onHoldNote.builds',
  taken: 'notifications:row.bot.onHoldNote.taken',
};
function isBotMomentDetail(detail) {
  const d = parseBotDetail(detail);
  return !!d && d.moment !== 'reply';
}
function plainMarkdown(value) {
  return String(value || '')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// The Homeroom bot's account (services/conversations.js HOMEROOM_BOT_USERNAME): a
// synthetic account nobody else can hold.
function isBotUsername(username) {
  return String(username || '').toLowerCase() === 'homeroom_bot';
}

// A reply's words on the row: at most 140 characters, cut at the last whole
// word with "…" (overnight audit D04: a bare cut read "Tap File it under my
// mes", a typo hiding the ask). The server's bellSubjectOf
// (services/homeroom-bot-notify-copy.js) cuts the same way.
function bellWords(words) {
  if (words.length <= 140) return words;
  const room = words.slice(0, 139);
  const space = room.lastIndexOf(' ');
  return `${(space > 70 ? room.slice(0, space) : room).replace(/[\s.,;:!?-]+$/, '')}…`;
}

// A message's words as a row's title (#5929 item 3): the markdown stripped,
// its lines joined, and cut at the last whole word, the way the bot's own
// replies already read. A bare `slice(0, 140)` put a raw message on the row:
// "Feedback: This is a strong settings screen. The copy is clear and the…"
// was the start of a reply, cut mid-word, under a label that said what it
// was. The label stays the kind ("Mentioned you", "Replied on request #12");
// the words are what was said, readable.
function messageWords(content) {
  return bellWords(plainMarkdown(content));
}

// The row's words for one of the bot's notifications: { label, subject, meta },
// or null when the detail is not the bot's. Its answer is what it wrote,
// under its name.
function botMomentLine(detail, message) {
  const d = parseBotDetail(detail);
  if (!d) return null;
  if (d.moment === 'reply') {
    const words = bellWords(plainMarkdown(message));
    return words ? { label: t('notifications:row.bot.name'), subject: words, meta: null } : null;
  }
  let subject;
  if (d.moment === 'on_hold' && d.count > 1) subject = t('notifications:row.bot.subject.onHold', { count: d.count });
  else if (d.firstVersion) {
    subject = d.appName
      ? t('notifications:row.bot.subject.firstVersion', { project: d.appName })
      : t('notifications:row.bot.subject.firstVersionUnnamed');
  } else if (d.requestTitle) subject = d.requestTitle;
  // A request whose title is not known is named by its number, never by its
  // project alone ("Needs you / Homeroom / Homeroom · Homeroom bot").
  else if (d.issueNumber) subject = t('notifications:row.bot.subject.request', { number: d.issueNumber });
  else subject = d.appName || t('notifications:row.bot.name');
  let label = t(BOT_LABEL_IDS[d.moment]);
  if (d.moment === 'needs_you' && d.said === 'decide_others') {
    label = d.deciders
      ? t('notifications:row.bot.ask.waitingOn', { people: d.deciders })
      : t('notifications:row.bot.ask.waitingOnUnnamed');
  } else if (d.moment === 'needs_you' && Object.prototype.hasOwnProperty.call(BOT_ASK_IDS, d.said)) {
    label = t(BOT_ASK_IDS[d.said]);
  }
  let meta = t('notifications:row.bot.name');
  if (d.appName && d.requestTitle && d.issueNumber && !d.firstVersion) {
    meta = t('notifications:row.bot.metaRequest', { project: d.appName, number: d.issueNumber });
  } else if (d.appName) meta = t('notifications:row.bot.meta', { project: d.appName });
  // #5929: a needs-you asks the reader for something, except the one that
  // says it waits on somebody else.
  const needsYou = d.moment === 'needs_you' && d.said !== 'decide_others';
  const noteId = d.moment === 'on_hold' && Object.prototype.hasOwnProperty.call(BOT_ON_HOLD_NOTE_IDS, d.said)
    ? BOT_ON_HOLD_NOTE_IDS[d.said] : null;
  return { label, subject, meta, needsYou, ...(noteId ? { note: t(noteId) } : {}) };
}

// #6494: a storage token carries MiB used and MiB of cap. MB below 1 GiB,
// else GB with at most one decimal ("1.6 GB", "3 GB").
function storageSizeText(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} MB`;
  return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
}

// A whole message with one emphasised part, as a row's segments: the catalog
// text is "<0>12 of 50 apps in use.</0> New apps are refused…", and what is
// inside the tag is the strong segment. A parameter is filled in after the
// tags are read, so a value that looks like a tag stays text.
function messageSegments(id, values = {}) {
  const text = t(id, {
    count: typeof values.count === 'number' ? values.count : undefined,
    interpolation: { prefix: '[[unused:', suffix: ']]' },
  });
  const fill = (part) => part.replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(values[name] ?? ''));
  const segments = [];
  for (const part of text.split(/(<0>[\s\S]*?<\/0>)/)) {
    if (!part) continue;
    const strong = /^<0>([\s\S]*)<\/0>$/.exec(part);
    segments.push(strong ? { t: 'strong', v: fill(strong[1]) } : { t: 'text', v: fill(part) });
  }
  return segments;
}

function headline(label, subject) {
  return {
    label,
    segments: subject ? [{ t: 'strong', v: String(subject) }] : [],
  };
}

// #3233: `detail` is "<old>:<new>" (services/app-allowance.js). Say it in
// words, and which way it moved; a token this build cannot read still says
// what happened.
function appQuotaChangeText(detail) {
  const m = /^(\d{1,6}):(\d{1,6})$/.exec(String(detail || '').trim());
  if (!m) return t('notifications:row.quota.changed.unknown');
  const before = Number(m[1]);
  const after = Number(m[2]);
  if (after > before) return t('notifications:row.quota.changed.up', { before, count: after });
  if (after < before) return t('notifications:row.quota.changed.down', { before, count: after });
  return t('notifications:row.quota.changed.same', { count: after });
}

// A discussion row's first line, by what is known. In order: the author and
// the project both named, the project unnamed, the author unnamed, neither.
const CHANNEL_ASKED_IDS = ['notifications:row.channel.askedIn', 'notifications:row.channel.askedInUnnamed',
  'notifications:row.channel.someoneAskedIn', 'notifications:row.channel.someoneAskedInUnnamed'];
const CHANNEL_SAID_IDS = ['notifications:row.channel.saidIn', 'notifications:row.channel.saidInUnnamed',
  'notifications:row.channel.someoneIn', 'notifications:row.channel.someoneInUnnamed'];

// #5580: the request (GitHub issue number) a row is about, when one is known:
// the server's story columns, the bot's rows' own (serialize puts the number
// in storyIssueNumber), or the request kinds' `detail`.
const REQUEST_DETAIL_KINDS = new Set(['issue_opened', 'issue_mention', 'issue_thread_reply']);
function storyIssueOf(n) {
  const story = Number(n.storyIssueNumber);
  if (Number.isSafeInteger(story) && story > 0) return story;
  if (REQUEST_DETAIL_KINDS.has(n.kind) && /^\d+$/.test(String(n.detail || ''))) return Number(n.detail);
  return null;
}
// One story per request in a project, else per proposal; null for a row
// about neither (it stays a card of its own).
function storyKeyOf(n) {
  const app = n.appId != null ? n.appId : 'none';
  const issue = storyIssueOf(n);
  if (issue) return `r:${app}:${issue}`;
  const session = Number(n.storySessionId);
  if (Number.isSafeInteger(session) && session > 0) return `s:${app}:${session}`;
  return null;
}
function storyRefOf(n) {
  const bot = BUILD_KIND_MOMENTS[n.kind] || isBotUsername(n.sourceUsername) ? parseBotDetail(n.detail) : null;
  const number = storyIssueOf(n) || (Number(n.storyPrNumber) > 0 ? Number(n.storyPrNumber) : null);
  if (!number) return null;
  return { number, title: n.storyTitle || (bot && bot.requestTitle) || null };
}

// #5929 item 4: where an unread row stands, which the sheet draws as a chip
// first on the row (RowLabel): 'needs' it waits on the reader, 'blocked' its
// votes are met and its merge stands still, 'hold' the bot has put it on
// hold. A read row has none: a vote cast or a merge decided reads the row
// (DECIDED_ASK_KINDS, change-notifications.ts), so on a read row the colour
// could be saying what is no longer so.
function rowTone(n, view) {
  if (n.readAt) return null;
  if (view.needsYou) return 'needs';
  if (n.kind === 'stale_pr' && n.detail === 'blocked') return 'blocked';
  const bot = view.botMoment ? parseBotDetail(n.detail) : null;
  return bot && bot.moment === 'on_hold' ? 'hold' : null;
}

function rowView(n) {
  const view = rowWords(n);
  const tone = rowTone(n, view);
  return tone ? { ...view, tone } : view;
}

/**
 * The leaked-link guard's `detail` ("<inviteId>:<joins>",
 * src/services/invite-activity.js noteGuard) as { inviteId, joins }, or null.
 */
function parseInviteGuardDetail(detail) {
  const m = /^(\d{1,9}):(\d{1,9})$/.exec(String(detail || ''));
  return m ? { inviteId: Number(m[1]), joins: Number(m[2]) } : null;
}

function rowWords(n) {
  // #6506: the subject line's weight and ink. An unread notice is bold in the
  // strong ink; a read one is regular and softer, so a list holding both
  // tells them apart at a glance. The unread dot in ./notifications-sheet.tsx
  // is the other cue; the sheet chooses by `unread` so a story card, whose
  // view is rebuilt, reads its own state.
  const unreadCls = n.readAt
    ? 'font-normal text-zinc-700 dark:text-zinc-300'
    : 'font-semibold text-zinc-900 dark:text-zinc-100';
  // WHERE this came from, for the meta line — and EMPTY when there is no
  // app, not the literal string 'app'. Plenty of kinds have no app at all (a
  // conversation, an account-level key, an agent question the platform cannot
  // place), and every one of them used to render "app · 4m ago" under itself.
  // The renderer drops a falsy part, so an app-less row simply says less.
  const appLine = n.appName ? n.appName : '';
  const who = n.sourceUsername ? n.sourceUsername : t('notifications:row.unknownPerson');
  const base = {
    id: n.id,
    // #5289: what the sheet's Unread groups fold repeats on: the kind, with
    // the label it printed (a kind can print more than one label).
    kind: n.kind,
    unread: !n.readAt,
    // #18 (19 Oct 2026 polish board): a plain message in a conversation or a
    // channel, which the bell leaves to the Messages tab: the sheet's Unread
    // tab neither lists nor counts it, so it says what the badge says.
    // #5580: the Homeroom bot's reply about a project is the exception: it
    // carries that project, files under it on Unread, and the bell counts it.
    plainMessage: isPlainMessageNotification(n),
    // #4769: whether the user has bookmarked this row — the feed row's
    // bookmark button and the pinned section both read it. A save is not a
    // read state; the two flags never derive from each other.
    saved: !!n.saved,
    unreadCls,
    ...stampFields(n.createdAt),
    // The sheet buckets rows into Today/Earlier and leads each with an
    // avatar-initial chip, so the raw timestamp and the resolved names ride
    // along as data.
    createdAtMs: Date.parse(n.createdAt) || 0,
    who,
    appLine,
    // Which app the row came from, for the Unread tab's per-project stacks
    // (#5406, #5580). Conversation kinds carry no app, except the Homeroom
    // bot's news about a project, which carries that project.
    appId: n.appId ?? null,
    // #5580: the project's own name, for the heading of the stack a row
    // files under (`appLine` is what its meta line says, and a bot row's
    // says more than the name).
    appName: n.appName || null,
    // #5877: that project's icon, so its bot row wears the project's own
    // tile instead of the Homeroom mark. Null on every row that is not the
    // bot's news about a project.
    appIconUrl: n.appIconUrl || null,
    appIconEmoji: n.appIconEmoji || null,
    // #5580: the request or proposal this row is about. A project's stack
    // folds one story's news into one card by `storyKey`; `storyRef` is what
    // a card about it says it is on ("on #5588") and what its history is.
    storyKey: storyKeyOf(n),
    storyRef: storyRefOf(n),
    // #5929: the row waits on the reader: a change asking for their vote
    // (VOTE_ASK_KINDS, less stale_pr: that is the author's warning that
    // OTHERS have not voted, or, 'blocked', that the merge stands still),
    // Homeroom bot's needs-you (botMomentLine), a friend request still to
    // answer. A project's group holding one comes first on Unread
    // (groupUnreadByApp in ./notifications-sheet.tsx).
    needsYou: (VOTE_ASK_KINDS.has(n.kind) && n.kind !== 'stale_pr') || n.kind === 'build_needs_you',
    // Meta-line attribution. Null unless the source user actually DID this.
    by: null,
    // The kind line. Every branch below overwrites it; '' would render a
    // blank first line, which is why nothing is allowed to fall through
    // with the default.
    label: '',
    // The meta line's own layout. `mb` and `wrap` differ per kind, and the
    // plain mention/reply row is the only one that is not a flex row at all.
    mb: true,
    metaFlex: true,
    wrap: false,
    icon: null,
    segments: [],
  };

  if (n.kind === 'test_alert') {
    return { ...base, label: t('notifications:row.testAlert.label'), icon: '🔔',
      segments: [{ t: 'text', v: t('notifications:row.testAlert.body') }] };
  }

  if (CONVERSATION_NOTIF_KINDS.has(n.kind)) {
    // QA 2026-09-24 Q33a: a direct conversation has no title of its own
    // (the column is NULL), so a DM's row used to be headed "Messages" —
    // the surface, not who wrote. The person on the other end of a DM is
    // the sender, so it is headed with them.
    const conversation = n.conversationTitle
      || (n.conversationKind === 'direct' && n.sourceUsername ? `@${n.sourceUsername}` : t('notifications:row.conversation.untitled'));
    const snippet = messageWords(n.messageContent);
    // The conversation is the SUBJECT of every one of these, so it leads —
    // and for a plain message the snippet follows it, which is the only part
    // of a message notification anybody reads. The other four say what
    // happened in it instead, because "@you" is the whole news there.
    //
    // The three that used to read "Mentioned you in <conversation>" lost the
    // trailing preposition when the line broke under them: "Mentioned you in"
    // alone above its object is a sentence cut in half, and the line below is
    // plainly what it is in.
    const copy = {
      conversation_invite: headline(t('notifications:row.conversation.invite'), conversation),
      // The only kind whose label is not a fixed category. A message's kind
      // IS its thread — "Message" over the snippet would name the surface,
      // which the meta line already does.
      conversation_message: headline(conversation, snippet),
      conversation_mention: headline(t('notifications:row.conversation.mention'), conversation),
      conversation_reply: headline(t('notifications:row.conversation.reply'), conversation),
      conversation_thread_reply: headline(t('notifications:row.conversation.threadReply'), conversation),
      conversation_reaction: headline(t('notifications:row.conversation.reaction'), conversation),
      // WP-E: a build moment without its detail (botMomentLine words the
      // rest): its moment, from Homeroom bot.
      build_ready: headline(t(BOT_LABEL_IDS[BUILD_KIND_MOMENTS.build_ready]), t('notifications:row.bot.name')),
      build_needs_you: headline(t(BOT_LABEL_IDS[BUILD_KIND_MOMENTS.build_needs_you]), t('notifications:row.bot.name')),
      build_stopped: headline(t(BOT_LABEL_IDS[BUILD_KIND_MOMENTS.build_stopped]), t('notifications:row.bot.name')),
      build_live: headline(t(BOT_LABEL_IDS[BUILD_KIND_MOMENTS.build_live]), t('notifications:row.bot.name')),
    }[n.kind];
    // #3228: the inviter's note rides the invite row after the group's name,
    // so the bell says why too.
    if (n.kind === 'conversation_invite' && n.conversationInviteNote) {
      copy.segments.push({ t: 'text', v: t('notifications:row.conversation.inviteNote', { note: n.conversationInviteNote }) });
    }
    const icons = {
      conversation_invite: '✉️',
      conversation_message: '💬',
      conversation_mention: '@',
      conversation_reply: '↩️',
      conversation_thread_reply: '🧵',
      conversation_reaction: n.detail || '❤️',
      build_ready: '💬',
      build_needs_you: '💬',
      build_stopped: '💬',
      build_live: '💬',
    };
    // B4 / "one story": one of the bot's moments is headed by the moment
    // over the request it is about, with its project and "Homeroom bot"
    // under it; its answer to what somebody wrote is its words, under its
    // name. Either way the meta line drops the "by @homeroom_bot" that
    // would say it twice.
    const bot = n.kind === 'conversation_reaction' ? null : botMomentLine(n.detail, n.messageContent);
    if (bot) {
      return {
        ...base,
        wrap: true,
        icon: icons[n.kind],
        by: null,
        conversation: true,
        conversationId: n.conversationId != null ? Number(n.conversationId) : null,
        appLine: bot.meta || t('notifications:row.source.messages'),
        botMoment: true,
        needsYou: !!bot.needsYou,
        ...(bot.note ? { note: bot.note } : {}),
        // Run six: the row wears the bot's own face (the sheet's AvatarChip),
        // never a letter tile of its handle — unless it is about a project,
        // which then wears that project's tile (#5877).
        bot: true,
        ...headline(bot.label, bot.subject),
      };
    }
    return {
      ...base,
      wrap: true,
      icon: icons[n.kind],
      // A build moment always comes from the bot; so does anything its
      // account sent, a moment without its detail included.
      ...(BUILD_KIND_MOMENTS[n.kind] || isBotUsername(n.sourceUsername) ? { bot: true } : {}),
      by: n.sourceUsername || null,
      // A PERSON speaking: the sheet draws the swatch avatar for it and never
      // folds it into a kind group (#5289). Carried as a flag rather than
      // re-deriving it there from `kind`: CONVERSATION_NOTIF_KINDS lives in
      // this module and the sheet must never drift from the set the rest of
      // the routing, grouping and copy already agree on.
      conversation: true,
      conversationId: n.conversationId != null ? Number(n.conversationId) : null,
      // A conversation row names MESSAGES as its source, not "app".
      //
      // `appLine` is the sheet's secondary line and falls back to the literal
      // string 'app' when a notification has no app, which every conversation
      // row is by construction (serialize nulls the app fields on one). So the
      // sheet rendered "app · 4m ago" under every message.
      //
      // Deliberately the SURFACE and not the conversation's title: the title
      // is the headline's own subject, and repeating it under itself reads as
      // a rendering fault rather than as attribution.
      appLine: t('notifications:row.source.messages'),
      ...copy,
    };
  }

  // #2386: the person is the SUBJECT of both friend rows, so their name is
  // the headline and `by` stays null (as on the key rows). A request still
  // waiting on you carries Accept and Decline beside the row; once answered —
  // here, on your profile, or withdrawn by its sender — it is a plain row that
  // opens their page.
  if (FRIEND_NOTIF_KINDS.has(n.kind)) {
    const request = n.kind === 'friend_request';
    return {
      ...base,
      appLine: t('notifications:row.source.friends'),
      wrap: true,
      icon: request ? '👋' : '🤝',
      label: request ? t('notifications:row.friend.request') : t('notifications:row.friend.accepted'),
      segments: [{ t: 'who', v: who }],
      ...(request && n.friendRequestPending ? {
        needsYou: true,
        actions: [
          { key: 'friend_accept', label: t('notifications:row.friend.accept'), primary: true },
          { key: 'friend_decline', label: t('notifications:row.friend.decline') },
        ],
      } : {}),
    };
  }

  // #2161: the two deletion rows. An attempt still has its app (the meta
  // line names it, the click opens it); a completed deletion has no app row
  // left, so the name rides in `detail` and the meta line says Account.
  if (n.kind === 'app_delete_attempted') {
    return {
      ...base,
      wrap: true,
      icon: '🗑️',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.appDeleteAttempted'), null),
    };
  }
  if (n.kind === 'app_deleted') {
    return {
      ...base,
      appLine: t('notifications:row.source.account'),
      wrap: true,
      icon: '🗑️',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.appDeleted.label'), n.detail || t('notifications:row.appDeleted.unnamed')),
    };
  }

  if (n.kind === 'moderation_report' || n.kind === 'moderation_action') {
    return { ...base, appLine: t('notifications:row.source.account'), wrap: true, icon: '⚑',
      ...headline(n.kind === 'moderation_report'
        ? t('notifications:row.moderation.report') : t('notifications:row.moderation.action'), n.detail || '') };
  }

  if (n.kind === 'app_quota_changed') {
    return { ...base, appLine: t('notifications:row.source.account'), wrap: true, icon: '＋',
      label: t('notifications:row.quota.changed.label'),
      segments: [{ t: 'text', v: appQuotaChangeText(n.detail) }] };
  }
  if (n.kind === 'app_quota_requested') {
    return { ...base, appLine: t('notifications:row.source.admin'), wrap: true, icon: '＋',
      label: t('notifications:row.quota.requested'), segments: [{ t: 'who', v: who }] };
  }
  if (n.kind === 'app_quota_request_declined') {
    return { ...base, appLine: t('notifications:row.source.account'), wrap: true, icon: 'ℹ️',
      label: t('notifications:row.quota.declined.label'),
      segments: [{ t: 'text', v: t('notifications:row.quota.declined.body') }] };
  }

  // Managed OpenRouter review alerts, plus historical successful-issuance
  // rows created before #2121. `who` is WHOSE KEY it is, not who acted, so
  // the name stays in the headline and `by` stays null. They carry no app and
  // click through to Admin → Users, so that is what the meta line names.
  if (n.kind === 'openrouter_key_created' || n.kind === 'openrouter_key_review') {
    const review = n.kind === 'openrouter_key_review';
    return {
      ...base,
      appLine: t('notifications:row.source.admin'),
      wrap: true,
      icon: review ? '⚠️' : '🔑',
      label: review ? t('notifications:row.openrouter.review') : t('notifications:row.openrouter.enabled'),
      segments: [{ t: 'who', v: who }],
    };
  }

  // A server-wide cap nearing or at its ceiling (services/platform-limit-
  // alerts.js). Full admins only, no app: the meta line says Admin like the
  // two kinds above. `detail` is "<limit>_<level>:<used>:<cap>"; a token this
  // build cannot read still says which kind of alert it is.
  if (n.kind === 'platform_limit') {
    const limit = parsePlatformLimitDetail(n.detail);
    if (!limit) {
      return { ...base, appLine: t('notifications:row.source.admin'), wrap: true, icon: '\u26A0\uFE0F',
        ...headline(t('notifications:row.limit.unknown.label'), t('notifications:row.limit.unknown.body')) };
    }
    const full = limit.level === 'full';
    // GitHub's hourly budget (services/github-budget.js): the bot token's,
    // or the GitHub App's. The card under Admin → Limits has the figures.
    if (limit.limit === 'github' || limit.limit === 'github_app') {
      const app = limit.limit === 'github_app';
      const figures = { used: limit.used, count: limit.cap };
      return {
        ...base,
        appLine: t('notifications:row.source.admin'),
        wrap: true,
        icon: full ? '\u{1F6A8}' : '\u26A0\uFE0F',
        label: app
          ? (full ? t('notifications:row.limit.githubApp.full.label') : t('notifications:row.limit.githubApp.warn.label'))
          : (full ? t('notifications:row.limit.github.full.label') : t('notifications:row.limit.github.warn.label')),
        // One message each: the figures, strong, then what follows from them.
        segments: app ? messageSegments('notifications:row.limit.githubApp.body', figures)
          : (full ? messageSegments('notifications:row.limit.github.full.body', figures)
            : messageSegments('notifications:row.limit.github.warn.body', figures)),
      };
    }
    const figures = { used: limit.used, count: limit.cap };
    return {
      ...base,
      appLine: t('notifications:row.source.admin'),
      wrap: true,
      icon: full ? '\u{1F6A8}' : '\u26A0\uFE0F',
      label: full
        ? (limit.limit === 'apps' ? t('notifications:row.limit.apps.full.label') : t('notifications:row.limit.sessions.full.label'))
        : (limit.limit === 'apps' ? t('notifications:row.limit.apps.warn.label') : t('notifications:row.limit.sessions.warn.label')),
      segments: limit.limit === 'apps'
        ? (full ? messageSegments('notifications:row.limit.apps.full.body', figures)
          : messageSegments('notifications:row.limit.apps.warn.body', figures))
        : (full ? messageSegments('notifications:row.limit.sessions.full.body', figures)
          : messageSegments('notifications:row.limit.sessions.warn.body', figures)),
    };
  }

  // #4296: errors that should not happen, counted for full admins (services/
  // platform-incident-alerts.js). No app, so the meta line says Admin like
  // platform_limit above; a token this build cannot read still says what it is.
  if (n.kind === 'platform_incident') {
    const alert = parsePlatformIncidentDetail(n.detail);
    const words = (kind) => String(kind).replace(/_/g, ' ');
    if (alert && alert.type === 'private') {
      return {
        ...base,
        appLine: t('notifications:row.source.admin'),
        wrap: true,
        icon: '\u{1F512}',
        label: t('notifications:row.incident.private.label'),
        segments: [{ t: 'text', v: t('notifications:row.incident.private.body') }],
      };
    }
    if (alert && alert.type === 'signal') {
      return {
        ...base,
        appLine: t('notifications:row.source.admin'),
        wrap: true,
        icon: '\u{1F6E0}\uFE0F',
        label: t('notifications:row.incident.signal.label'),
        segments: [{ t: 'text', v: t('notifications:row.incident.signal.body', { number: alert.issueNumber }) }],
      };
    }
    if (alert && alert.type === 'hour') {
      return {
        ...base,
        appLine: t('notifications:row.source.admin'),
        wrap: true,
        icon: '\u{1F6A8}',
        label: t('notifications:row.incident.hour.label'),
        segments: messageSegments('notifications:row.incident.hour.body', { count: alert.n, kind: words(alert.kind) }),
      };
    }
    if (alert && alert.type === 'digest') {
      const listed = alert.kinds.reduce((sum, k) => sum + k.n, 0);
      const parts = alert.kinds.map((k) => t('notifications:row.incident.digest.kindCount', { kind: words(k.kind), count: k.n }));
      if (alert.total > listed) parts.push(t('notifications:row.incident.digest.otherCount', { count: alert.total - listed }));
      return {
        ...base,
        appLine: t('notifications:row.source.admin'),
        wrap: true,
        icon: '\u26A0\uFE0F',
        label: t('notifications:row.incident.digest.label', { count: alert.total }),
        segments: [{ t: 'text', v: parts.length
          ? t('notifications:row.incident.digest.list', { kinds: listText(parts) })
          : t('notifications:row.incident.digest.empty') }],
      };
    }
    return { ...base, appLine: t('notifications:row.source.admin'), wrap: true, icon: '\u26A0\uFE0F',
      ...headline(t('notifications:row.incident.unknown.label'), t('notifications:row.incident.unknown.body')) };
  }

  const prLabel = n.prTitle || null;

  // #3227: a first kudos arrived with nothing saying what it was. The note
  // under the subject says it in one breath: a thank-you, that it stays,
  // and where it counts. The weekly allowance is read from the budget the
  // Kudos badge already fetched (the leaderboard subtitle does the same, so
  // the two never quote different numbers); the button opens the board.
  if (n.kind === 'kudos') {
    const limit = (typeof window !== 'undefined' && window.Kudos?.Budget?.state?.limit) || 20;
    return {
      ...base,
      icon: '\u{1F44F}',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.kudos.label'), prLabel || t('notifications:row.kudos.yourChange')),
      note: t('notifications:row.kudos.note', { limit }),
      actions: [{ key: 'kudos_board', label: t('notifications:row.kudos.board') }],
    };
  }

  if (n.kind === 'reaction') {
    return {
      ...base,
      icon: n.detail || '❤️',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.reaction.label'), messageWords(n.messageContent)),
    };
  }

  // A system warning, no actor: the author's promoted PR has gone quiet and is
  // heading for auto-archive. The old copy spelled the whole mechanism out
  // ("is going stale, it'll auto-archive soon without votes"); what the row
  // has to say is that it needs votes, and the rest is on the proposal.
  // `detail` 'blocked': its votes are met and its merge is what stands
  // still, so the row says that rather than asking for votes.
  if (n.kind === 'stale_pr') {
    return {
      ...base,
      icon: '⏳',
      // #5929 item 5: the server knows the votes are met and the merge has
      // stood still (machine.ts staleWarned), not why, so this names no cause
      // as the cause. It can also be shots not ready or a variable with no value.
      ...(n.detail === 'blocked' ? { note: t('notifications:row.stale.blockedNote') } : {}),
      ...headline(t(n.detail === 'blocked' ? 'notifications:row.stale.blocked' : 'notifications:row.stale.label'),
        prLabel || n.sessionTitle || t('notifications:row.stale.yourChange')),
    };
  }

  // Also a system warning: the staging preview would not boot, so the checks
  // that gate merge never ran.
  if (n.kind === 'check_failed') {
    return {
      ...base,
      icon: '⚠️',
      ...headline(t('notifications:row.checkFailed.label'), prLabel || n.sessionTitle || t('notifications:row.checkFailed.yourChange')),
    };
  }

  // Someone promoted a PR and this is the nudge to come and vote. THE row this
  // whole rewrite is measured against: it read "@evan proposed a PR to vote on
  // in Notes" with the PR's own title on an unrendered third line, so the one
  // thing that distinguished two of them was invisible.
  if (n.kind === 'pr_proposed') {
    return {
      ...base,
      icon: '\u{1F5F3}️',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.proposed.label'), prLabel || t('notifications:row.proposed.aChange')),
    };
  }

  // #6643: a change held until an admin approves it (services/release-
  // holds.js), for full admins. The warning sign is the point of the row: it
  // is the one ask in the bell that something risky waits on this reader.
  if (n.kind === 'release_hold') {
    // A detail that starts "notice:" is a change the rules could not read
    // in full: the admins are told, and it is not held, so the row asks for
    // nothing and carries no warning sign.
    if (/^notice:/.test(String(n.detail || ''))) {
      return {
        ...base,
        icon: '\u2139\uFE0F',
        by: n.sourceUsername || null,
        ...headline(t('notifications:row.releaseHold.noticeLabel'), prLabel || n.sessionTitle || t('notifications:row.releaseHold.noticeBody')),
      };
    }
    return {
      ...base,
      needsYou: true,
      icon: '\u26A0\uFE0F',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.releaseHold.label'), prLabel || n.sessionTitle || t('notifications:row.releaseHold.body')),
    };
  }

  // B7: a change Homeroom bot built for somebody is ready to try, and it
  // needs this reader's Yes. Who asked for it is the row's `by`.
  // 5 October (Page Turners): once it is decided the row stops asking. It
  // says what became of it, read live off the change (`sessionStatus`,
  // services/notifications.js): Live (a tap opens the app), Going live, or
  // Closed.
  if (n.kind === 'change_ready') {
    const subject = prLabel || n.sessionTitle || t('notifications:row.changeReady.aChange');
    if (n.sessionStatus === 'merged') {
      return { ...base, needsYou: false, icon: '\u{1F389}', by: n.sourceUsername || null, ...headline(t('notifications:row.changeReady.live'), subject) };
    }
    if (n.sessionStatus === 'merging') {
      return { ...base, needsYou: false, icon: '\u{1F680}', by: n.sourceUsername || null, ...headline(t('notifications:row.changeReady.goingLive'), subject) };
    }
    if (n.sessionStatus === 'archived') {
      return { ...base, needsYou: false, icon: '\u{1F5C2}\uFE0F', by: n.sourceUsername || null, ...headline(t('notifications:row.changeReady.closed'), subject) };
    }
    return {
      ...base,
      icon: '\u{1F440}',
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.changeReady.ready'), subject),
    };
  }

  // ── #1374's five ────────────────────────────────────────────────────
  //
  // Each of these was a silence before that change: nothing told you your
  // proposal had merged, that somebody had voted on it, or that an issue had
  // been filed on an app you look after.

  // The good-news row. `detail === 'forced'` is an admin override rather than
  // a vote that carried, and the label says which: to the person who wrote
  // the change those are the same event with very different meanings.
  // #5064: until production runs it (`sessionStatus` 'merging', read live
  // off the change as a "ready to try" row is), it says Going live.
  if (n.kind === 'pr_merged') {
    const going = n.sessionStatus === 'merging';
    const head = headline(
      n.detail === 'forced' ? t('notifications:row.merged.forced')
        : (going ? t('notifications:row.merged.goingLive') : t('notifications:row.merged.live')),
      prLabel || n.sessionTitle || t('notifications:row.merged.yourChange'),
    );
    // #1688: on a merge the vote carried, `detail` names who backed and
    // shaped it. An admin override's marker is not a sentence to show.
    const credits = n.detail && n.detail !== 'forced' ? String(n.detail) : '';
    return {
      ...base,
      icon: going ? '\u{1F680}' : '\u{1F389}',
      label: head.label,
      segments: credits ? [...head.segments, { t: 'text', v: credits }] : head.segments,
    };
  }

  // #4787: a change the viewer voted on (yes or no) went live. Drawn like
  // the author's "Live" row above: the same tile, a small grey first line
  // naming the kind, the change's title in bold below it. No button of its
  // own; the row itself opens the change (proposalKinds).
  // #5064: "going live" until production runs it, as the author's row.
  if (n.kind === 'voted_change_merged') {
    const going = n.sessionStatus === 'merging';
    const head = headline(
      going ? t('notifications:row.votedMerged.goingLive') : t('notifications:row.votedMerged.label'),
      prLabel || n.sessionTitle || t('notifications:row.votedMerged.aChange'),
    );
    return {
      ...base,
      icon: going ? '\u{1F680}' : '\u{1F389}',
      ...head,
    };
  }

  // Somebody voted. The DIRECTION is in the label rather than the subject,
  // because it is the part you want at a glance and the proposal title is
  // usually long enough to push it off the row.
  if (n.kind === 'proposal_vote') {
    const head = headline(
      n.detail === 'no' ? t('notifications:row.vote.no') : t('notifications:row.vote.yes'),
      prLabel || n.sessionTitle || t('notifications:row.vote.yourChange'),
    );
    // #1688: the voter's own line rides after the subject, quoted — the
    // proposer's first sight of an objection is the sentence, not the thumb.
    const reason = typeof n.voteReason === 'string' ? n.voteReason.trim() : '';
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: n.detail === 'no' ? '\u{1F44E}' : '\u{1F44D}',
      label: head.label,
      segments: reason
        ? [...head.segments, { t: 'text', v: t('notifications:row.vote.reason', { reason }) }]
        : head.segments,
    };
  }

  // #1688: the author pushed a new version of a proposal this person had
  // said yes to. The row's own button re-casts the yes with one tap (the
  // server carries their earlier line along); the row itself opens the
  // proposal for another look. Once read — by either — the button goes.
  if (n.kind === 'revision_recheck') {
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: '\u{1F501}',
      ...headline(t('notifications:row.recheck.label'), prLabel || n.sessionTitle || t('notifications:row.recheck.aChange')),
      actions: n.readAt ? [] : [{ key: 'still_yes', label: t('notifications:row.recheck.stillYes'), primary: true }],
    };
  }

  // #1688: the Friday card. `detail` is "<merged>:<open>" — what went live
  // this week and what is waiting on votes. This is the whole card now: a
  // channel carries no activity (services/ws.js sendSystemMessage).
  //
  // #6371: one row now covers every project, with `w:<projects>:<merged>:<open>`
  // (services/weekly-digest.js notifyPeople). Its label says the digest is
  // ready and its subject adds up the week; tapping it opens This week. An
  // older per-project row keeps its wording and still opens its project.
  if (n.kind === 'weekly_digest') {
    const week = /^w:(\d+):(\d+):(\d+)$/.exec(String(n.detail || ''));
    if (week) {
      const merged = Number(week[2]);
      const open = Number(week[3]);
      const shipped = merged === 0
        ? t('notifications:row.weekly.nothing')
        : t('notifications:row.weekly.wentLive', { count: merged });
      const waiting = open
        ? t('notifications:row.weekly.waiting', { count: open })
        : '';
      return {
        ...base,
        // The shell's own newspaper glyph (components/ui/icons), drawn by
        // the sheet's tile: an icon is a line icon, never an emoji.
        icon: null,
        lineIcon: 'newspaper',
        ...headline(
          t('notifications:row.weekly.ready'),
          waiting ? t('notifications:row.factPair', { first: shipped, second: waiting }) : shipped,
        ),
      };
    }
    const counts = /^(\d+):(\d+)$/.exec(String(n.detail || ''));
    const merged = counts ? Number(counts[1]) : 0;
    const open = counts ? Number(counts[2]) : 0;
    const shipped = merged === 0
      ? t('notifications:row.weekly.nothing')
      : t('notifications:row.weekly.wentLive', { count: merged });
    const waiting = open
      ? t('notifications:row.weekly.waiting', { count: open })
      : '';
    return {
      ...base,
      icon: '\u{1F4F0}',
      ...headline(
        n.appName ? t('notifications:row.weekly.label', { project: n.appName }) : t('notifications:row.weekly.labelUnnamed'),
        waiting ? t('notifications:row.factPair', { first: shipped, second: waiting }) : shipped,
      ),
    };
  }

  // A new issue on an app you have a stake in. `detail` is the issue number
  // (notifications has no issue column; see the producer), so the subject is
  // the number rather than the title — the title is one tap away and a
  // truncated one here would be worse than a precise reference.
  if (n.kind === 'issue_opened') {
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: '\u{1F4DD}',
      ...headline(t('notifications:row.issueOpened.label'),
        n.detail ? t('notifications:row.issueOpened.number', { number: n.detail }) : t('notifications:row.issueOpened.filed')),
    };
  }

  // #3952: somebody named you with @ in a request they filed. Said the way a
  // chat mention is, with the request in place of the message: its number,
  // since `detail` carries nothing else.
  if (n.kind === 'issue_mention') {
    return {
      ...base,
      by: n.sourceUsername || null,
      ...headline(t('notifications:row.issueMention.label'), /^\d+$/.test(String(n.detail || ''))
        ? t('notifications:row.issueMention.request', { number: n.detail }) : t('notifications:row.issueMention.aRequest')),
    };
  }

  // The app is unwell, and this row goes only to people who can fix it.
  //
  // `detail` is a short TOKEN, never a reason line: notifications.detail is
  // VARCHAR(32), so a build failure's own message would arrive as a
  // meaningless fragment. The copy is rendered from the token here, and the
  // full reason is on the app (apps.last_failure) where the row leads.
  // Rendering `detail` directly would also put an internal identifier on
  // screen, which is the thing tests/settings-mobile-push.test.js bars
  // elsewhere for good reason.
  if (n.kind === 'app_health') {
    // #2253: the app storage cap speaks through this channel too, and its
    // two tokens carry copy that says what happened and what it means for
    // the app. The app name leads the line on purpose: this row is only
    // ever about one app, and "has used most of its storage" with nothing
    // in front of it reads as the platform talking about itself.
    // #6494: the early and warning tokens carry the figures, so the row says
    // how full the database is ("1.6 GB of 3 GB") instead of only "most of".
    // A bare token from a row written before this change keeps its old words.
    const storage = /^storage_(early|warn):(\d{1,9}):(\d{1,9})$/.exec(String(n.detail || ''));
    if (storage) {
      const key = storage[1] === 'early' ? 'early' : 'warnSized';
      const values = { used: storageSizeText(Number(storage[2])), limit: storageSizeText(Number(storage[3])) };
      return {
        ...base,
        wrap: true,
        icon: '\u{1F4BE}',
        label: t('notifications:row.health.storage.label'),
        segments: n.appName
          ? messageSegments(`notifications:row.health.storage.${key}`, { ...values, app: n.appName })
          : messageSegments(`notifications:row.health.storage.${key}Unnamed`, values),
      };
    }
    if (n.detail === 'storage_warn') {
      return {
        ...base,
        wrap: true,
        icon: '\u{1F4BE}',
        ...headline(t('notifications:row.health.storage.label'), n.appName
          ? t('notifications:row.health.storage.warn', { app: n.appName })
          : t('notifications:row.health.storage.warnUnnamed')),
      };
    }
    if (n.detail === 'storage_full') {
      return {
        ...base,
        wrap: true,
        icon: '\u{1F4BE}',
        label: t('notifications:row.health.storage.label'),
        segments: n.appName
          ? messageSegments('notifications:row.health.storage.full', { app: n.appName })
          : messageSegments('notifications:row.health.storage.fullUnnamed'),
      };
    }
    // release_stalled: the platform's own app, a merged commit that has not
    // become the running release (services/release-watch.js).
    const APP_HEALTH_COPY = {
      deploy_failed: 'notifications:row.health.problem.deployFailed',
      release_stalled: 'notifications:row.health.problem.releaseStalled',
    };
    return {
      ...base,
      wrap: true,
      icon: '\u{1F6A8}',
      ...headline(t('notifications:row.health.problem.label'), Object.prototype.hasOwnProperty.call(APP_HEALTH_COPY, n.detail)
        ? t(APP_HEALTH_COPY[n.detail]) : t('notifications:row.health.problem.other')),
    };
  }

  // The daily digest, and the counterweight to `new_proposals` defaulting
  // off. `detail` is the COUNT, so the subject is a plural-aware phrase
  // rather than a bare number nobody can parse without the label.
  // 5 October (Page Turners): it counts what STILL waits (`digestWaiting`,
  // read live, services/notifications.js), so a change that went live since
  // stops being one of them; and when nothing does, the row says so rather
  // than "0 changes". Without the live count (an older server), the count it
  // was sent with.
  if (n.kind === 'vote_digest') {
    const count = Number.isFinite(Number(n.digestWaiting)) && n.digestWaiting != null
      ? Number(n.digestWaiting) : (Number(n.detail) || 0);
    if (count === 0) {
      return { ...base, needsYou: false, icon: '\u{1F5F3}\uFE0F', ...headline(t('notifications:row.voteDigest.none'), null) };
    }
    return {
      ...base,
      icon: '\u{1F5F3}\uFE0F',
      ...headline(
        t('notifications:row.voteDigest.label'),
        n.appName
          ? t('notifications:row.voteDigest.countIn', { count, project: n.appName })
          : t('notifications:row.voteDigest.count', { count }),
      ),
    };
  }

  // #5404: the Monday count. `detail` is the count when it was sent, with no
  // project on the row (services/voted-digest.js), and a tap opens Your votes.
  if (n.kind === 'voted_digest') {
    return {
      ...base,
      icon: '\u{1F4CB}',
      ...headline(
        t('notifications:row.votedDigest.label'),
        t('notifications:row.votedDigest.count', { count: Number(n.detail) || 0 }),
      ),
    };
  }

  // #1405 path A: your agent put work somewhere while you were away. The label
  // carries the DESTINATION, because that is the part you cannot infer —
  // "submitted" is at a vote with checks running, "shared" is visible on the
  // Dev board with nobody being asked to decide anything.
  if (n.kind === 'connector_submitted') {
    const shared = n.detail === 'shared';
    return {
      ...base,
      wrap: true,
      icon: shared ? '\u{1F441}️' : '\u{1F4E4}',
      ...headline(
        shared ? t('notifications:row.connector.shared') : t('notifications:row.connector.submitted'),
        n.sessionTitle || prLabel || t('notifications:row.connector.yourChange'),
      ),
    };
  }

  // #1405 path B: the agent asked you something and you have not answered.
  //
  // The copy says it was ASKED, never that you are currently being waited on.
  // Clearing depends on the agent calling back and it may forget, so "is
  // waiting on you" would be FALSE on the row you see after already replying —
  // and a notification making a false claim reads as broken. This phrasing
  // stays true either way, which is what makes a stale one merely redundant.
  if (n.kind === 'agent_awaiting_input') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4AC}',
      ...headline(t('notifications:row.agentAsked'), n.sessionTitle || null),
    };
  }

  // #161: dev-session completion — the owner left mid-turn and it finished.
  // #971: label precedence is sessionTitle → prTitle → branchName. The session
  // title is the canonical display name (schema.sql #249) and is mirrored from
  // pr_title once a PR exists, so a promoted session reads exactly as it did
  // before; a pre-PR session shows its real title instead of
  // `dev/<user>-<epoch>`.
  if (n.kind === 'session_done') {
    return {
      ...base,
      wrap: true,
      icon: '✅',
      ...headline(
        // #2779: a run in an agent session says what finished, not "session".
        n.agentSessionId ? t('notifications:row.session.agentFinished') : t('notifications:row.session.finished'),
        n.sessionTitle || prLabel || n.branchName || t('notifications:row.session.yourSession'),
      ),
    };
  }

  // #3181: the other way a turn ends. It errored, timed out or lost its
  // worker, or the platform paused the session mid-turn, so the work is not
  // done and nothing else would say so. Same subject ladder as session_done;
  // the app is on the meta line, so the label is the whole message.
  if (n.kind === 'session_stalled') {
    return {
      ...base,
      wrap: true,
      icon: '⏸️',
      ...headline(
        n.agentSessionId ? t('notifications:row.session.agentStopped') : t('notifications:row.session.stopped'),
        n.sessionTitle || prLabel || n.branchName || t('notifications:row.session.yourSession'),
      ),
    };
  }

  // #161: headless proposal-run completion. #150: a question outcome isn't
  // "ready" work product — it is the run asking the reporter for input, so the
  // label says so.
  if (n.kind === 'auto_solve_done') {
    const failed = n.detail === 'failed';
    const label = failed ? t('notifications:row.autoSolve.failed')
      : (n.detail === 'question' ? t('notifications:row.autoSolve.question') : t('notifications:row.autoSolve.ready'));
    return {
      ...base,
      wrap: true,
      icon: failed ? '⚠️' : '\u{1F916}',
      ...headline(
        label,
        n.headlessIssueNumber
          ? t('notifications:row.autoSolve.request', { number: n.headlessIssueNumber })
          : t('notifications:row.autoSolve.aRequest'),
      ),
    };
  }

  // (#86) Private spec share: someone sent this user a spec version. Clicking
  // opens the app's general chat with the read-only spec panel showing that
  // exact version (see _onItemClick).
  if (n.kind === 'spec_shared') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4CB}',
      by: n.sourceUsername || null,
      ...headline(
        t('notifications:row.spec.label'),
        n.sessionTitle || prLabel || n.branchName || t('notifications:row.spec.version', { version: n.detail || '?' }),
      ),
    };
  }

  // A person's message in a small private group's discussion
  // (src/services/group-channel-notify.js). One row per discussion: the
  // messages that arrive before you read it fold in, `detail` counting them
  // and the newest one its message and author. Headed by the person and the
  // project, as a group chat's banner is, over what they said; the meta line
  // names the surface (Discussion), as a conversation row's names Messages,
  // so the project's name is not said twice.
  // 5 October (Page Turners): a message Homeroom bot filed as a request
  // (`requestNumber`, read live, services/notifications.js) is somebody
  // asking for a change, as a joiner's first message says (below). Several
  // messages folded into one row stay messages.
  if (n.kind === 'channel_message') {
    const count = /^\d{1,6}$/.test(String(n.detail || '')) ? Number(n.detail) : 1;
    const project = n.appName || '';
    const snippet = messageWords(n.messageContent);
    const username = n.sourceUsername || '';
    const asked = count === 1 && n.requestNumber != null;
    // Each line is a whole message, picked by what is known: who wrote, and
    // the project's name.
    const which = (username ? 0 : 2) + (project ? 0 : 1);
    const names = { username, project };
    return {
      ...base,
      wrap: true,
      icon: asked ? '\u{1F4A1}' : '💬',
      by: null,
      appLine: t('notifications:row.source.discussion'),
      ...(count > 1
        ? headline(
          project ? t('notifications:row.channel.many', { count, project }) : t('notifications:row.channel.manyUnnamed', { count }),
          snippet
            ? (username ? t('notifications:row.channel.snippet', { username, message: snippet })
              : t('notifications:row.channel.snippetSomeone', { message: snippet }))
            : (username ? `@${username}` : t('notifications:row.channel.someone')),
        )
        : headline(asked ? t(CHANNEL_ASKED_IDS[which], names) : t(CHANNEL_SAID_IDS[which], names), snippet || null)),
    };
  }

  // #4396: a project the reader joined while it was made is open
  // (src/services/project-opened.js). The meta line names the project, so
  // the label is the whole headline.
  if (n.kind === 'project_opened') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F389}',
      by: null,
      ...headline(t('notifications:row.projectOpened.label'), null),
    };
  }

  // WP-E: what an invite link brought back to its maker
  // (src/services/invite-activity.js). A day's moments of one kind fold into
  // one row, `detail` counting them, the newest person its `by`. An open is
  // never anybody's name.
  if (n.kind === 'invite_opened' || n.kind === 'member_joined' || n.kind === 'first_message') {
    const count = /^\d{1,6}$/.test(String(n.detail || '')) ? Number(n.detail) : 1;
    if (n.kind === 'invite_opened') {
      return {
        ...base,
        wrap: true,
        icon: '\u{1F517}',
        by: null,
        ...headline(count > 1 ? t('notifications:row.inviteLink.openedMany', { count }) : t('notifications:row.inviteLink.openedOne'), null),
      };
    }
    // 5 October (Page Turners): a first message is often what they want from
    // the app, and when Homeroom bot filed it as a request (`requestNumber`,
    // read live: it is filed seconds, or a "Suggest it", after the message
    // rang) it is called that. Several people's hellos folded into one row
    // stay hellos.
    const asked = n.kind === 'first_message' && count === 1 && n.requestNumber != null;
    return {
      ...base,
      wrap: true,
      icon: asked ? '\u{1F4A1}' : '\u{1F44B}',
      by: n.sourceUsername || null,
      ...(n.kind === 'member_joined'
        ? headline(count > 1
          ? t('notifications:row.inviteLink.joinedWithOthers', { count: count - 1 })
          : t('notifications:row.inviteLink.joined'), null)
        : headline(asked ? t('notifications:row.inviteLink.asked')
          : (count > 1 ? t('notifications:row.inviteLink.saidHiWithOthers', { count: count - 1 })
            : t('notifications:row.inviteLink.saidHi')), messageWords(n.messageContent))),
    };
  }

  // The leaked-link guard (src/services/community-invites.js GUARD): one of
  // the reader's invite links brought in a lot of people today, or paused
  // itself. `detail` is "<inviteId>:<joins>"; `inviteLinkState` is where the
  // link stands now, so a button shows only while it still does something:
  // Turn off on a link that works or is paused, Open it again on a paused one.
  if (n.kind === 'invite_link_busy' || n.kind === 'invite_link_paused') {
    const guard = parseInviteGuardDetail(n.detail);
    const count = guard ? guard.joins : 0;
    const project = n.appName || null;
    const paused = n.kind === 'invite_link_paused';
    const label = paused
      ? (project ? t('notifications:row.inviteGuard.paused', { project, count }) : t('notifications:row.inviteGuard.pausedPlain', { count }))
      : (project ? t('notifications:row.inviteGuard.busy', { project, count }) : t('notifications:row.inviteGuard.busyPlain', { count }));
    const state = guard && guard.inviteId > 0 ? n.inviteLinkState : null;
    const actions = [];
    if (state === 'paused') actions.push({ key: 'invite_reopen', label: t('notifications:row.inviteGuard.reopen'), primary: true });
    if (state === 'live' || state === 'paused') actions.push({ key: 'invite_turn_off', label: t('notifications:row.inviteGuard.turnOff') });
    return {
      ...base,
      wrap: true,
      icon: paused ? '\u23F8\uFE0F' : '\u{1F517}',
      by: null,
      ...headline(label, null),
      ...(actions.length ? { actions } : {}),
    };
  }

  // Collab-invite history rows (the actionable Accept/Decline buttons live
  // ONLY in the pinned Invites section, driven by pendingInvites — once
  // resolved this is just a plain history row). The app's name is the meta
  // line's job, so the label is the whole headline. An invite into a private
  // project is to join it (`detail: 'join'`, src/services/collab-invites.js).
  // 5 October (Page Turners): an invite by username accepted is somebody
  // joining through your invite, in the words a link's join uses
  // (member_joined above), not a second phrase for the same thing.
  if (n.kind === 'collab_invite' || n.kind === 'collab_invite_accepted'
    || n.kind === 'approver_invite' || n.kind === 'approver_invite_accepted') {
    const label = n.kind === 'collab_invite'
      ? (n.detail === 'join' ? t('notifications:row.collab.invitedJoin') : t('notifications:row.collab.invitedBuild'))
      : n.kind === 'collab_invite_accepted'
        ? t('notifications:row.collab.accepted')
        : n.kind === 'approver_invite'
          ? t('notifications:row.collab.approverInvite')
          : t('notifications:row.collab.approverAccepted');
    return {
      ...base,
      mb: false,
      wrap: true,
      icon: n.kind === 'collab_invite' ? '✉️'
        : n.kind === 'approver_invite' ? '🗳️' : '✅',
      by: n.sourceUsername || null,
      ...headline(label, null),
    };
  }

  // Mentions and replies, and anything else that carries a chat message.
  return {
    ...base,
    metaFlex: false,
    by: n.sourceUsername || null,
    ...headline(
      n.kind === 'mention' ? t('notifications:row.chat.mention')
        : n.kind === 'reply' ? t('notifications:row.chat.reply')
          // #2387: somebody answered in a reply thread you started or joined.
          : n.kind === 'thread_reply' ? t('notifications:row.chat.threadReply')
            // #4535: somebody posted in a request's discussion you filed or
            // posted in; `detail` is the request's number.
            : n.kind === 'issue_thread_reply'
              ? (/^\d+$/.test(String(n.detail || ''))
                ? t('notifications:row.chat.requestReply', { number: n.detail })
                : t('notifications:row.chat.requestReplyUnnumbered'))
              // #6019: the same in a thread a change or a decision leads;
              // `detail` is the change's number, empty for a decision.
              : n.kind === 'change_thread_reply'
                ? (/^\d+$/.test(String(n.detail || ''))
                  ? t(n.changeOnGithub ? 'notifications:row.chat.changeReplyPr' : 'notifications:row.chat.changeReply', { number: n.detail })
                  : t('notifications:row.chat.decisionReply'))
                : t('notifications:row.chat.posted'),
      messageWords(n.messageContent),
    ),
  };
}

// `relativeTime` lived here. It never stopped being relative, so a row from
// last spring read "412d ago" — a duration, not a date. It is `agoStamp` from
// lib/timestamp.ts now, which prints "Mar 4" past a week (#1808).
//
// Both halves of a row's stamp cross to the component as descriptor fields:
// `time` is what the row prints and `timeTitle` is what it hangs on `title`,
// so a "3d ago" is one hover from the exact instant.
function stampFields(ts) {
  const { text, title } = agoStamp(ts);
  return { time: text, timeTitle: title };
}

// #1079 chunk B published this row builder on the object rather than leaving
// it in file scope: the cog drawer's "Needs attention" section rendered these
// very same per-kind rows, and once each module had its own scope inside the
// bundle it could no longer just call a neighbour's function.
//
// #1191 slice 6 conversion 4 then made what crosses here a DESCRIPTOR rather
// than an HTML string, so both drawers rendered the rows with one React
// component (NotificationRow in ./notifications-list.tsx).
//
// THE UI OVERHAUL retired the cog drawer and merged its pinned rows into this
// list, so there is one caller again. The seam stays as it is: the descriptor
// is what keeps ./notifications-list.tsx presentational, and it is what let the
// list be lifted wholesale into the hamburger without this module noticing.
Notifications._rowView = rowView;
// B4: the sheet's rows, folded, for tests (a bot moment never folds).
Notifications._screenViews = screenViews;
// "One story": where a conversation row (and its push) opens, for tests.
Notifications._conversationHref = conversationNotificationHref;

// Published exactly where the classic <script> published it: at module
// evaluation, which for the React entry is still before DOMContentLoaded. The
// guard is for the SSG prerender pass, which evaluates this module in node.
// init() is called by the island's layout effect (see ./index.tsx) rather than
// from a DOMContentLoaded handler — that runs during hydration, i.e. EARLIER
// than the old handler did, so it still lands before app.js's init.
if (typeof window !== 'undefined') window.Notifications = Notifications;
