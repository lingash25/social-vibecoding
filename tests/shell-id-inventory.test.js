// The shell's element-id inventory, pinned.
//
// Every id in public/index.html is an API. public/js/** reaches for them with
// getElementById (57,799 lines of it, none of which the type checker sees),
// public/css/app.css styles some of them, and dapp.json's declared checks
// select against deep chains of them — so a single lost id is a silently
// broken screen plus a blocked merge, and it is by far the most damaging way
// a markup conversion can go wrong.
//
// So: the set of ids the generated document carries must equal the set the
// hand-written one carried, exactly — minus whatever a conversion chunk has
// deliberately retired, plus whatever it has deliberately added.
//
// ── The baseline, not the fixture (#1078) ──────────────────────────────
//
// Step 1 compared against a byte copy of the pre-migration document
// (tests/fixtures/pre-migration-index.html). Step 2 converts screens on
// purpose, so whole-document comparison is the thing that has to go — but the
// id inventory outlives it. The id list now lives in
// tests/baselines/shell-markup.json, derived once from that fixture by
// scripts/derive-shell-baseline.js; the fixture itself is gone.
//
// EVERY CHUNK RECORDS ITS OWN ID CHANGES HERE, in the same commit, with a
// reason. That is the whole mechanism: the baseline stays frozen, and the two
// maps below are the reviewable log of what the migration moved.
//
// Run with: node --test tests/shell-id-inventory.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

const baseline = require('./baselines/shell-markup.json');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ── The interiors that mount on reveal ─────────────────────────────────
//
// public/index.html is no longer the whole inventory. #settings-screen's
// sixteen panes and the six anonymous-shell screens render their interiors
// on FIRST REVEAL (frontend/src/lib/mount-on-reveal.ts) rather than shipping
// in the prerender: they were 681 of the document's 1,485 elements, parsed,
// styled and hydrated on every load for screens most loads never open. Their
// roots stay in the document exactly as they were; only the children wait.
//
// So the id inventory is resolved against the document PLUS each of those
// interiors, rendered through the same component with its root marked
// mounted (tests/lib/lazy-interiors.js). None of the 187 ids that left the
// prerender is retired — every one is still here, in the interior that owns
// it — and the test at the bottom pins the other half: that the prerender
// really does not carry them any more, which is the whole point.
const { MOUNT_ON_REVEAL, interiorHtmlFor, lazyInteriorsHtml } = require('./lib/lazy-interiors');
const withInteriors = `${after}\n${lazyInteriorsHtml()}`;

// Ids a conversion chunk deliberately removed, each with the reason.
const RETIRED_IDS = {
  // ── #4073: the waiting screen says the waitlist in one line ────────
  'waiting-who': 'The username inside "Your account … doesn\'t have platform access yet." on the waiting screen. The screen says "You\'re on the waitlist" and one line about your spot now (features/auth/waiting.tsx), as the onboarding canvas draws it, so nothing names the account there.',
  'waiting-check-state': 'The waiting screen\'s "Last checked …" / "Connection issue, will retry" line. The screen still checks every 30 seconds and lets the account in the moment access is granted; it no longer reports each check, and a check that fails is tried again on the next one.',
  // ── The create-project dialog is retired ───────────────────────────
  // Create opens "What do you want to make?" (features/first-session/
  // make.tsx), the screen the first session asks with, for everyone. It
  // imports a GitHub repo in place (import-repo.tsx), and every new project
  // ends on its made screen. Who a project is for and who approves are its
  // own levers afterwards (Invite, "Make it public", Members & approvals),
  // and the starter templates are gone. The ids the dialog ADDED since the
  // baseline (its step indicator, Next, the invite and approval steps, the
  // brief and the one-line description) left ADDED_IDS with it.
  'create-modal': 'The create-project dialog\'s root, one of the nine static dialogs. Create opens the make screen instead (App.showCreateModal → window.UsernodeReact.firstSession.create()); #create is its route and #create/import its import form.',
  'create-card': 'The dialog\'s card, which carried every answer as data-* for app.css. The make screen has two questions and no steps to unfold.',
  'create-title': 'The dialog\'s "New project" / "Import a project" title. The make screen says "New project" over "What do you want to make?", or "Import a GitHub repo".',
  'create-form': 'The dialog\'s form. The make screen\'s two forms (make.tsx, import-repo.tsx) render only once it is opened, so they are not in the prerendered shell.',
  'create-import-block': 'The repo URL and Check under "Import a GitHub repo". They are the make screen\'s import form now (#make-import-url, [data-make-import-check]), opened by its small "Import from a GitHub repo" or #create/import.',
  'import-url': 'The repo URL field. #make-import-url in the import form.',
  'import-check': 'The Check pill. [data-make-import-check] in the import form; GET /api/github/verify-access as before.',
  'import-status': 'The check\'s status row. #make-import-status in the import form, which also says what is missing on a press of Import it.',
  'create-name-block': 'The name (and "What should it do?") card. The make screen asks the same two, and the import form asks the name.',
  'app-name': 'The project name field. #first-session-name on the make screen, #make-import-name on the import form.',
  'create-error': 'The dialog\'s error line. Each form says its own (role="alert"), and POST /api/apps\'s answer is read by dialogs/post-create-app.ts for both.',
  'create-cancel': 'Cancel. The make screen has ✕ ([data-make-close]), Escape and the device back press.',
  'create-submit': 'Create / Import. Make it, or Import it, never pale for a missing answer.',
  // ── Communities, stage 3: the create dialog asks who it is for ─────
  'create-visibility-block': 'The create dialog\'s last step, two rails for who can build and who can see. The dialog now opens on who a project is FOR (Just me, A group, A community: #create-card[data-audience]), and each answer implies both columns (services/create-options.js); "public to use, invite-only building" stays in the project\'s settings. The approval rule a group or a community picks takes the last step instead (#create-approve-block).',
  'create-vis-hint': 'The rails\' "Apps everyone can build are always public to view" hint. With no rails there is no invalid combination left to explain.',
  // ── Create moves into the launcher grid (the prototype's scrHome) ─
  // Never in the frozen baseline — THE UI OVERHAUL added it through
  // ADDED_IDS — so it leaves that map and is recorded here instead, which
  // also puts it under the dereference guard at the bottom of this file.
  'home-create-section': 'Home\'s fourth area, a full-width "Create app" card in a section of its own below Challenges. Create is the launcher grid\'s trailing tile now (#home-create-tile, features/home/create-tile.tsx), rendered inside #app-list on the first grid paint, so it is not in the prerendered shell. It keeps `data-panel-slot="create"` and `data-create-enabled`, the hooks the declared checks select on; the welcome tour\'s create step points at the tile.',
  // ── #2568: the included key is not claimed, it is created ────────
  // Every account is created with its included OpenRouter key, so the
  // three ids that existed to ASK for one have nothing left to do. The
  // card they sat in is replaced by #settings-openrouter-included, a
  // status line (ADDED_IDS below).
  'settings-openrouter-beta-gated': 'The "Codex/OpenRouter is being rolled out gradually" notice. There is no gradual rollout any more — CODEX_OPENROUTER_ENABLED is a deployment switch, not a per-account allowlist, and with it off the section renders nothing rather than an explanation of a queue nobody is in.',
  // ── #2304: app access moved to App settings ─────────────────────
  'members-visibility-section': 'The duplicate visibility editor in Members & visibility. App settings is the canonical access surface now; Members keeps collaborators, app admins and proposal approvals.',
  'members-vis-hint': 'The dependent build/view hint belonged to the retired two-axis editor. App settings presents only the three valid access combinations, so an invalid combination cannot be selected.',
  'members-vis-error': 'The visibility proposal status line moved with the editor to #app-access-status. The dialog-level loading failure has the accurately named #members-load-error.',
  // ── Home's fifth area went; Profile kept its door ───────────────
  // The chip's menu has carried the entrance since #1443 (a "You" group
  // holding #switcher-row-profile and #switcher-row-settings, pinned by
  // the destination-order check in dapp.json), so the row at the foot of
  // the launcher was a second door to the same screen. The design's own
  // answer is a Profile tab in a bottom bar, not a card under Create app.
  'home-account-section': 'The "You" area, last in Home\'s reading order. Home ends on "make something" now.',
  'home-account-row': 'The row inside it, linking #profile. The entrance is #switcher-row-profile.',
  'home-account-avatar': 'The viewer\'s picture on that row. Its writer, App.applyUserAvatar, went with it — this was the last pair it wrote to (the header chip\'s copy was retired in the same #1443 round), and Profile\'s editor re-reads App.user when it saves.',
  'home-account-glyph': 'Its fallback person glyph.',
  // ── #1610: the completed-task count moved to the bell ───────────
  'notifications-badge-ai': 'The green session count on #improve-btn. It counted unread session-related notifications, split out of the bell\'s number so the two would not double-count. Nothing behind that button could CLEAR it: a session notification is marked read by clicking its row in the bell\'s list, by a group-chat mark-read, or by mark-all, and opening the Improve panel marks nothing. So a finished session raised a number on the one control with no way to dismiss it, and the reporter pressed Improve again looking for a notification that was in the bell. The count is folded back into #notifications-badge, which now carries `data-session-done` in its place; what was left on the button is #improve-working-dot, which outlived the button itself (#2718) and is on the Homeroom mark now.',
  // ── Andrea's 27 Aug 2026 waitlist review ────────────────────────
  // Three stage-1 fields and one stage-2 field, all removed for the same
  // reason: each asked for something nothing read back.
  'waitlist-city': 'The free-text city beside #waitlist-country. Cohorts are balanced by REGION, which the country select already answers; the city was stored and never queried. Rows that hold one keep it, and waitlist-signals.js still reads `a.city` so a signup that answered it does not lose the section.',
  'waitlist-discovery-detail': 'The "Which one?" follow-up under the discovery chips. It asked people to type a second answer to a question they had just answered with a tap, and no screen or export read the free text.',
  'waitlist-referrer': 'The "did someone refer you?" handle on the join form. A typed handle is a claim nobody can resolve; the stage-2 invite link records the same relationship as a row reference (`invite_code` / `invited_by`), which is what the admin screen actually counts.',
  'more-referrer': 'The same question on the stage-2 form, retired for the same reason and doubly redundant there — it sat directly beneath the invite link that attributes the relationship properly.',
  // ── The chip's menu is the APP PICKER, and only that ─────────────
  // Its copy of the App | Board | Activity strip went. The strip is one
  // module rendered from a caller-supplied id map, and the Improve panel's
  // map (#improve-views / #app-context-row-*) is the one every declared
  // check and getElementById already named — so nothing moved, a second
  // rendering of it stopped. See frontend/src/features/improve/view-tabs.tsx.
  'switcher-views': 'The chip menu\'s copy of the three-view strip. The menu answers WHICH APP; a control about the app you are already in sat between you and the list you opened the menu for. The Improve panel keeps the strip, and the header\'s back arrow is the way OUT of a Board now.',
  'switcher-view-app': 'Its App segment. `#app-context-row-app` in the Improve panel is the surviving one.',
  'switcher-view-board': 'Its Board segment; `#app-context-row-board` survived it, and then retired in turn — the Workshop and the kanban are one screen in two layouts, so the strip stopped offering the layout as a destination. `#app/<slug>/board` and `?view=kanban` still resolve onto the kanban board.',
  'switcher-view-activity': 'Its Activity segment; `#app-context-row-activity` survived it, and then retired in turn (below).',
  // ── The Workshop replaced the Activity feed ─────────────────────
  // The strip's middle segment names the lander now: the same cards as the
  // Board, grouped by what they are about. The old #app/<slug>/activity
  // address resolves onto it, so nothing a link named is lost.
  'app-context-row-activity': 'The strip\'s Activity segment. The Workshop (`#app-context-row-workshop`) replaced the Activity feed as the Dev screen\'s lander; the feed\'s two answers — what needs your vote, what changed since you were here — are strips above its themes.',
  // ── #1443: one control names where you are ──────────────────────
  // The chip's menu lists every destination with its own page, so the header
  // stopped needing a second, third and fourth way to say the same thing.
  //
  // #back-icon-home WAS retired here and is NOT any more — it is back in the
  // document, so it belongs to neither map: the baseline already lists it.
  // The reason it came back is the cost that retirement turned out to carry.
  // "Home is a row of the chip's menu" is true, and what it left behind was
  // five screens — the app itself, Profile, Settings, Admin, Messages — with
  // nothing in the bar at all, because 'home' had quietly come to mean
  // HIDDEN rather than "draw a house". The rule is now "every page has a
  // back or a home button, except Home", and the slot is still only one
  // control: chevron where there is a level above, house where there is not.
  // What made it affordable is the OTHER half of #1443 — the fixed 28px box
  // is still gone, so the glyph takes space only on screens that have
  // somewhere to send you.
  // ── Streamlined Concept: the drawer became the APP's surface ──────
  // The Figma board draws ONE app-scoped drawer (the app, its Board, its
  // Activity, "+ New change", the changes here and elsewhere, over a
  // Profile/Settings foot). The short-lived split — a platform drawer plus an
  // #app-context-sheet behind the title tab — collapsed into it. What the
  // drawer gave up in exchange: alerting, which is the two header glyphs
  // (#notifications-btn, #messages-btn), and the app list, which is the Apps
  // sheet behind the title tab.
  'app-context-sheet': 'The second surface is gone: its rows ARE the drawer now (features/app-context/app-context-rows.tsx). The element id lives on as #apps-switcher-sheet, which reuses its controller and kit bottom-sheet lifecycle.',
  'app-context-overlay': 'Backdrop of that surface — #apps-switcher-overlay now.',
  'app-context-body': 'Scroller of that surface; the drawer\'s own #header-menu-rows is the scroller now.',
  'app-context-close': 'Close control of that surface — #apps-switcher-close now.',
  'drawer-top-rows': 'The drawer\'s Notifications + Messages block. Both are header glyphs now, because platform-wide alerting has no business inside the app\'s own surface.',
  'drawer-row-notifications': 'Became #notifications-btn, the bell in the header\'s right group. Same #notifications route, same badge id.',
  'drawer-row-messages': 'Became #messages-btn, the chat bubble beside it. Same #messages route; its badge keeps the id its row used.',
  'drawer-notifications-badge': 'The notifications count rides #notifications-badge on the bell again — one badge, not two.',
  'drawer-your-apps': 'The Your-apps section. Switching apps is the Apps sheet behind the title tab (#apps-switcher-sheet), which is what the board draws.',
  'drawer-row-your-apps': 'Nav row of that section; the sheet\'s Home button is the way to the grid now.',
  'drawer-your-apps-toggle': 'Its fold, retired with the section.',
  // ── Streamlined Concept: the notification list left the drawer ───
  // The rows render on the full-screen #notifications view now
  // (notifications-sheet.tsx, its own ids in ADDED_IDS below); the saved +
  // invites sections moved WITH the surface keeping their ids, so only the
  // drawer-specific chrome is gone.
  'notifications-mark-all': 'The drawer block\'s mark-all control; the screen renders its own (#notifications-screen-mark-all), React-wired.',
  'notifications-list': 'The drawer\'s list scroller; the screen renders rows directly.',
  'notifications-empty': 'Drawer-only never-had-one hint; the screen\'s All tab empty state says it now.',
  'drawer-row-app-version': 'Per-dApp SHA removed from platform information; app versions remain on app cards.',
  'app-version-pill-slot': 'Drawer-only per-dApp SHA renderer removed with its row.',
  // ── THE UI OVERHAUL: four header controls became one ──────────────
  // An app is just an app now, and everything you do *to* it lives behind
  // #improve-btn. Each id below moved to a row of that panel rather than
  // simply going away; the behaviour it named is still reachable.
  'app-mode-switch': 'App/Dev segmented switch retired — Dev is a destination the Improve panel links to, not a header mode. Both #app/<slug>/app and #app/<slug>/dev survive as routes.',
  'app-mode-seg-app': 'Segment of the retired App/Dev switch.',
  'app-mode-seg-dev': 'Segment of the retired App/Dev switch.',
  'feedback-btn': 'Header feedback bubble retired — the dialog opens from the Improve panel\'s "Give feedback" row. App.openFeedbackModal is unchanged.',
  'work-drawer-btn': 'Header work cog retired — its session list is the Improve panel\'s two session sections (this app, and an overflow for every other).',
  'work-drawer-icon': 'The cog glyph, retired with its button. The spinning-while-busy cue is the per-row busy dot in the Improve panel now.',
  'dev-console-btn': 'Header terminal icon retired — the Improve panel\'s "Developer terminal" row is shown on the same DevConsole signal. #staging-dev-console-btn survives; the staging overlay has its own chrome.',
  'dev-console-badge': 'Unseen-error count on the retired header terminal icon. #staging-dev-console-badge survives.',
  // ── The version dot's round trip ──────────────────────────────────
  // #1412 renamed #header-menu-deploy-dot to #improve-version-dot and moved
  // it onto #improve-btn; the Streamlined Concept moved it straight back to
  // the hamburger under its ORIGINAL id — the board keeps the hamburger as
  // the badge cluster, and the Improve slot slims to a text action. So the
  // id matches the baseline again and neither map lists it. What #1412
  // actually added is kept: the violet "the platform rolled past the SHA
  // this tab loaded against" state, and a reader
  // (DrawerStatus.refreshDeployDot) that publishes a state through
  // improveStore instead of toggling a class — the dot renders from
  // <MenuIndicators/> in platform-header.tsx now.
  // ── #1367: two Improve rows became a segmented toggle ────────────
  // "Development kanban" and "Latest development activity" were list rows
  // with a chevron. They are two segments of the App/Feed/Kanban control now
  // (frontend/src/features/improve/view-toggle.tsx), which renders inside the
  // panel on a phone and in the header beside #improve-btn on a wide screen.
  // Improve.openDev(mode) — the handler both rows called — is unchanged, so
  // the behaviour each id named is reachable by one tap rather than two.
  'improve-row-kanban': 'Kanban row retired — the "Kanban" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'kanban\') call.',
  'improve-row-feed': 'Feed row retired — the "Feed" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'feed\') call.',
  // ── THE UI OVERHAUL: three top-right drawers became one ──────────
  // The bell and the cog merged INTO the hamburger. Nothing they carried was
  // dropped without a new home; each entry below names it.
  // (#notifications-btn's own round trip: THE UI OVERHAUL folded the bell into
  // the hamburger, and the Streamlined Concept gives it back its control in the
  // header's right group — the drawer is the APP's surface now, so platform
  // alerting needs a seat of its own. The id matches the baseline again, so it
  // is listed in neither map; what changed is only which panel it opens.)
  'notifications-panel': 'The bell dropdown. features/notifications keeps its store, list components and module — only the panel around them is gone.',
  'work-drawer-panel': 'The cog drawer. Its session list is the Improve panel\'s (this app, plus an overflow for every other); its pinned rows are ordinary notifications in the merged hamburger.',
  'work-drawer-close': 'Close button of the retired cog drawer.',
  'work-drawer-mark-all': 'Mark-all-read of the retired cog drawer — the merged list has one, #notifications-mark-all.',
  'work-drawer-list': 'Body of the retired cog drawer.',
  'work-drawer-empty': 'Empty hint of the retired cog drawer.',
  // ── …and the hamburger itself lost everything that was not navigation ──
  'drawer-row-theme': 'Theme is a SETTING now, and the first one. A live control that changes how the whole product looks is not navigation. See features/settings/sections/theme.tsx — the track keeps its ids, so app.css draws it unchanged.',
  'drawer-status-pane': 'The kudos + AI-credit meters were ambient numbers nobody acts on from a menu.',
  'drawer-row-kudos': 'Kudos is a leaderboard concern; the home screen\'s Challenges area links there.',
  'kudos-budget-slot': 'Slot of the retired kudos row. Kudos.Budget still resolves it by id and no-ops when absent, so the figure can be re-homed without touching the module.',
  'drawer-row-leaderboard': 'Moved to the HOME SCREEN, into the Challenges area\'s header — beside the shared progress it links to, rather than in a menu you open from memory. #leaderboard is unchanged as a route.',
  'drawer-footer': 'The bottom-anchored reference block moved wholesale into the Improve panel: every line in it was about an app, and that panel is the surface scoped to one.',
  'drawer-row-github': 'View on GitHub — an Improve panel row now.',
  'drawer-row-share': 'Share App — an Improve panel row now.',
  // ── Streamlined Concept: the reference footer has no successor ───
  // The block THE UI OVERHAUL carried from the drawer into the Improve panel
  // (and the Streamlined Concept then carried into the drawer again, as
  // #improve-footer) is dissolved. The board draws a drawer of navigation and
  // work only, and every line of that footer was a different KIND of thing
  // wearing the same row: two of them described the platform, two described
  // the app, and exactly one was an action. Each went where it belongs.
  // ── Streamlined Concept: the hamburger, and the rows it held ─────
  // The drawer's app rows merged into the Improve panel — one surface for
  // the app's navigation AND its work, rather than two that half-overlapped —
  // and the button that opened it went with them. The header's left slot is
  // the board's own cluster now: the app glyph (or a back arrow) beside the
  // title tab, both opening the Apps sheet.
  // ── Streamlined Concept, second pass: the two alerting screens
  //    became SHEETS. A screen reachable from every route has to answer
  //    "back to where?", and both answered "home".
  // ── The hamburger, and the drawer it opened, are gone ────────────
  // The Streamlined Concept retired the hamburger button and left the drawer
  // with no trigger — its rows were reachable only through the ?shot=menu
  // capture links, which is why ten declared checks kept passing over a
  // surface no user could open. The whole panel goes; every row it held has
  // a home on a SCREEN now, with an address and a back arrow of its own.
  'header-menu-panel': 'The drawer itself. Its account rows are the Profile screen\'s account group (features/profile/account-panel.tsx), reached from Home\'s account row.',
  'header-menu-overlay': 'Its backdrop.',
  'header-menu-rows': 'Its scroller.',
  'header-menu-close': 'Its close control.',
  'drawer-main-rows': 'The account group inside it — #profile-account now.',
  'drawer-row-profile': 'Profile is #switcher-row-profile, a row of the chip\'s menu (#1443). It went to Home\'s #home-account-row first, which the menu made redundant and Home has since dropped.',
  'drawer-avatar': 'The viewer\'s picture on that row. No surface carries one now: the chip names the APP you are in, and Home\'s copy went with its account row.',
  'drawer-profile-glyph': 'Its fallback glyph, retired with the picture.',
  'drawer-row-settings': 'Settings is #switcher-row-settings, a row of the chip\'s menu (#1443) — it has its own page, and the menu lists everything that does.',
  'drawer-byok-dot': 'The BYOK dot on that row — #switcher-byok-dot. settings.js publishes the flag through the visibility store rather than writing the class by id, because the row renders inside a React-owned subtree.',
  'drawer-row-admin': 'Admin & moderation is #switcher-row-admin, same isAdmin gate, published rather than class-written for the same reason.',
  'drawer-node-dot': 'Its status dot — #account-node-dot. It also stops PRERENDERING: the row renders inside the Profile screen\'s account group, which draws from profile data, where the drawer shipped on every page.',
  'drawer-node-status': 'Its status text — #account-node-status, same note.',
  'drawer-wallet-balance': 'The wallet row\'s balance readout — #account-wallet-balance, same note.',
  'drawer-row-node': 'The native node row — #account-row-node, same component, same module.',
  'drawer-row-wallet': 'The native wallet row — #account-row-wallet, ditto.',
  'notifications-screen': 'The Notifications screen ROOT. It is #notifications-sheet now — an overlay over the current screen, out of App.SCREEN_IDS entirely, so there is no back arrow to point anywhere. Its children kept their ids.',
  'header-menu-btn': 'The hamburger. Its slot is the app-glyph/back-arrow pair (features/header/header-app-icon.tsx + #back-btn), and its badge cluster moved to #improve-btn — the control whose panel actually holds the work those badges report. #2718 retired that button in turn and the badges moved on again, to the Homeroom mark, which is the control whose MENU holds that work now.',
  'header-menu-deploy-dot': 'Renamed #improve-version-dot with that move. A `header-menu-*` id on the Improve button would be a lie that outlives everyone who remembers it.',
  'drawer-app-rows': 'The app rows\' scroller in the drawer. The Improve panel renders them now, and #improve-sessions is the scroller.',
  'app-context-new-change': 'Merged INTO #improve-row-new-session, the panel\'s middle quick action. Two ids calling one Improve.startSession() was the duplication the merge exists to remove.',
  'improve-row-share': 'Share app is the Improve panel\'s third action (features/improve/improve-panel.tsx) — the one line in that footer that was an action rather than a reference. Same id, same `canShare` gate.',
  'drawer-row-app-fork': 'Fork lineage renders on the app\'s page from the detail descriptor (features/apps/browse-detail.tsx, #browse-detail-fork) — lineage is a fact about an app, not about the drawer you have open.',
  'app-fork-badge-slot': 'Slot AppView.renderForkBadge wrote into. Both the function and App.DrawerStatus.setForkVisible are gone with it.',
  // ── THE UI OVERHAUL: the home screen's widgets became four fixed areas ──
  // Discover, Challenges and Create app were draggable blocks on the launcher
  // canvas; they are sections in a fixed order under the grid now, so the
  // hosts and settings that existed for the PLACEMENT go with it.
  'home-panels': 'The widgets\' stacked FALLBACK host below the grid. It caught the moment before the first grid paint and the active-search view, because a block that lived IN #app-list vanished whenever #app-list did. The three sections are outside it and never re-rendered by a search keystroke, so there is nothing left to catch.',
  'settings-home-panels-section': 'Settings → Home screen widgets. A checkbox per widget only made sense while the blocks were optional furniture a viewer arranged; they are three fixed areas of the screen now. The ⋮ menu on a block still hides one, and POST /api/home-panels/:key/visibility is untouched.',
  'settings-home-panels-list': 'The checkbox list inside that retired section.',
  'settings-home-panels-status': 'Save/error line of that retired section.',
  // ── Andrea's simpler waitlist flow: joining is email-only ─────────
  // "Link something you've made" was a REQUIRED stage-1 field, which
  // contradicted the flow the onboarding doc settled on and that Andrea
  // and Evan agreed in its comments ("Just an email!"). The question is
  // not gone — it moved to the stage-2 "Want in sooner?" form as
  // #more-made-url / #more-made-note, where it is one of the things that
  // helps you move up rather than a gate on joining.
  'waitlist-made-url': 'Moved to the stage-2 survey as #more-made-url; joining no longer asks it.',
  'waitlist-made-note': 'Moved to the stage-2 survey as #more-made-note, with its url field.',
  // ── Andrea's simpler waitlist flow: the invite link is real now ────
  // The five typed-address rows collected emails and did nothing with
  // them: no invite was sent, no attribution was recorded, no count was
  // ever shown. They are replaced by a share link whose joins ARE
  // attributed (waitlist_signups.invited_by), which is the mechanic the
  // doc asks for. Nothing that worked was removed, because nothing here
  // worked.
  'more-invites': 'Typed-address invite rows retired for the share link (#more-invite-url); they sent nothing.',
  'more-invite-add': 'The "add another" button for the retired invite rows.',
  // ── The buddy checkbox promised something nothing delivered (#1534) ──
  // "Only let me in when at least one person from my link gets in too"
  // was stored on the answers blob and read by no admission path, so it
  // held nobody back and let nobody in. The invite link beside it, and
  // the copy saying we try to admit people together, are untouched.
  'more-admit-together': 'The "only let me in when someone from my link gets in too" checkbox. Nothing read the flag, so the promise it made was never kept; the field is dropped on input the way #more-invites was.',
  // ── The signed-out landing stops being a website ──────────────────
  // Measured on production at 375x812: 3328px of scroll, four screens,
  // three of them a grid of app tiles 36 of which were locked and
  // captioned "Account required". The screen now carries the logotype,
  // the illustration, one heading, one sentence and two pills. What the
  // retired ids held either moved into the body or was the grid itself.
  // #landing-back-to-waiting, #landing-header, #landing-header-title,
  // #landing-back-btn, #landing-waitlist-link and #landing-status-link
  // all SURVIVE — see the design spec's slice B.
  'landing-header-ctas': 'The bar\'s CTA wrapper. Both ways in are full-width pills in the body now, under the sentence that says what the product is, so the wrapper had nothing left to hold. The bar carries the wordmark and the back disc only.',
  'landing-signin-cta': 'The header\'s 28px "Sign in" chip. Its job moved to the body\'s secondary pill, href="#login" unchanged, drawn as the same white pill the sign-in screen already uses.',
  'landing-waitlist-cta': 'The header\'s 28px "Join waitlist" chip. Its job moved to #landing-waitlist-link, which carries the MARKETING waitlist URL with target="_blank" now instead of the in-app #waitlist route, so the join happens where the form already lives.',
  'landing-waitlist': 'The pitch card <section>: 67 words of explanation in a tinted box above the grid. Replaced by the eyebrow, one heading and one sentence, with no box around them — the card was the largest single block on a screen whose problem was that it read as a website.',
  'landing-cta-queued': 'The "You\'re already on the waitlist" line inside that card. A waiting-room session\'s whole action area is one pill to #waiting now (#landing-back-to-waiting, which is deliberately NOT retired), which says the same thing and gives them somewhere to go.',
  'landing-apps': 'The directory grid. 41 tiles, 36 locked, three of the four screens a visitor scrolled through, and none of them usable signed out. The directory is still FETCHED — ?shot=anon-back picks its target from it, pull-to-refresh re-runs it, and _loadLandingApps stays a router seam — it simply renders nothing.',
  // ── #2979: the activation-code prompt leaves sign-in ────────────────
  'register-link': 'The "Have an activation code? Register" foot pin under the password sign-in step. The #register route (register.tsx) and its own activation-code field are untouched — this retires only the login screen\'s entry point into it, along with the foot-pinning spacer and the now-unused REGISTER_LINE class constant.',
  // ── #3027: Send feedback takes several images ──────────────────────
  // The one-image preview row held one <img>, one status line and one ✕.
  // With up to three images each gets its own of all three, built by
  // feedback-controller.js inside the (kept) #feedback-screenshot-preview
  // list, so three fixed ids would be duplicates. Nothing selected on them
  // outside the controller.
  'feedback-screenshot-img': 'The single attachment preview <img>. Each attached image is now an item the controller appends to #feedback-screenshot-preview, with its own preview and an alt text numbered by position.',
  'feedback-screenshot-state': 'The single attachment\'s status line ("Uploading…", "Saved with your feedback…"). Each thumbnail item carries its own status span now, so an upload failing on one image is reported beside that image.',
  'feedback-screenshot-remove': 'The single ✕ that dropped the only attachment. Each thumbnail has its own 48px remove button, labelled "Remove image N", so one picture can go without the others.',
  // ── #4311: the Settings choice of where changes get built is gone ────
  // #1191 made these three markup in Settings → Connectors & CLI (they had
  // been injected at runtime), so they were declared in ADDED_IDS; the
  // frozen baseline never recorded them. Nothing acted on the saved value
  // after #4268 (agent sessions pick where work runs in their own Build-with
  // sheet), so the row, its save route and its /api/auth/me field went
  // together. users.dev_flow_preference stays in the schema so a rollback
  // still reads it.
  'dev-flow-pref-section': '#4311: the "Where changes get built" part of Settings → Connectors & CLI. Nothing chose a venue from its value any more.',
  'settings-dev-flow': '#4311: that part\'s dropdown, which saved users.dev_flow_preference through POST /api/me/dev-flow (removed).',
  'settings-dev-flow-status': '#4311: the dropdown\'s save/error line.',
  // ── #4891: the email sign-up asks for no password ──────────────────
  // The set-password step (#otp-step-password, named for its route) asks a
  // new account for its username and nothing else: it signs in with an
  // emailed code and adds a password in Settings (#cp-title-add below).
  'otp-new-password': '#4891: the set-password step\'s optional New password field. A password is one more decision at the very first step; Settings → Account offers "Add a password" instead.',
  'otp-confirm-password': '#4891: the same step\'s Confirm password field, gone with the password it confirmed.',
  // ── #5261: one way onto the waitlist ─────────────────────────────
  // The in-app join form made a waitlist row of its own beside the one
  // Continue's account gets: two ways in, two records. Continue makes the
  // account and puts it in line; the two optional questions are asked in the
  // waiting room after it (features/auth/waiting-about.tsx) and saved to the
  // same keys on the account's row. #waitlist keeps only check your status.
  'waitlist-form': 'The join form on #waitlist. Retired with the second way onto the waitlist: a bare #waitlist opens Continue now (AuthScreens.retireWaitlistLink).',
  'waitlist-email': 'The join form\'s address field. Continue asks for the address, and the account it makes is what waits in line.',
  'waitlist-country': 'The join form\'s country select. Asked after the account is made, in the waiting room, as #waiting-about-country, and saved to the same answers.country.',
  'waitlist-discovery-chips': 'The join form\'s "How did you find us?" chips. Asked in the waiting room as #waiting-about-discovery, and saved to the same answers.discovery.source.',
  'waitlist-submit': 'The join form\'s submit. Continue is the one way to join.',
  'waitlist-queued': 'The "already on the list" note a signed-in visitor saw in place of the join form. A signed-in #waitlist goes to the waiting room now, which shows their spot.',
};

// Ids a conversion chunk deliberately added, each with the reason.
const ADDED_IDS = {
  // ── #5927: the Homeroom menu says what it is ────────────────────────
  'apps-switcher-title': 'The app menu\'s title, "Feedback & info", over the app\'s name in small caps, which was the whole label before (features/app-context/app-context-sheet.tsx). Rendered on the menu pane only; the second panes keep their back disc there.',
  // ── iPhone Duo: the side strip (24 Oct 2026) ───────────────────────
  'platform-side-strip-top': 'iPhone Duo: the top of the column of system chrome down the screen\'s edge, holding the header\'s back controls while <html data-side-strip> is set (features/nav/strip-back.tsx, app.css THE SIDE STRIP). Ships drawn as nothing; display:none off the strip.',
  'platform-side-strip-back': 'iPhone Duo: #back-btn\'s copy in the side strip, rendered from the same useBackSlot hook and handing its press to #back-btn. Ships hidden with no href, as #back-btn does.',
  // ── New Needs you (an experiment) ──────────────────────────────────
  'review-flow-enabled': 'New Needs you: the switch in Settings, Experimental (off by default, kept on the device by features/review-flow/settings.ts) that draws the Communities tab\'s Needs you as the new review flow. settings.js paints and saves it through window.UsernodeReact.reviewFlow.',
  // ── New look (an experiment) ───────────────────────────────────────
  'new-look-enabled': 'New look: the switch in Settings, Experimental (off by default, kept on the device by the head\'s window.Skin) that sets data-skin="brand" on <html>, which app.css draws the new look from in light mode. settings.js paints and saves it through window.Skin.',
  // ── #5097: Settings > Privacy, "Share usage analytics" ──────────────
  'settings-usage-analytics': '#5097: the Share usage analytics switch (features/settings/sections/usage-analytics.tsx, the last block of Settings > Privacy). Off, and disabled until the saved choice is read.',
  'settings-usage-analytics-section': '#5097: the Usage analytics block, the last of Settings > Privacy under #5104\'s contact settings (features/settings/sections/usage-analytics.tsx).',
  'settings-usage-analytics-description': '#5097: the line under that switch saying what is collected; the switch\'s aria-describedby.',
  // ── #5286: the admin console marks itself ─────────────────────────
  'admin-console-bar': '#5286: the admin console\'s own band at the top of #admin-root, ships hidden and is revealed through classList by AdminConsole._renderShell for an admin (never in public mode).',
  'admin-exit': '#5286: the band\'s Exit link, href #profile, which goes back to the address the console was entered from when one is known.',
  // ── #5405: search over the loaded notifications ───────────────────
  'notifications-search': '#5405: the search field\'s block between the notifications sheet\'s title and the Unread | All tabs.',
  'notifications-search-input': '#5405: the field itself (type="search"). Filters the tab that is open, over the rows already loaded, by project, kind and subject; Escape with text empties it.',
  // #notifications-search-empty (the "No notifications match “…”" line) is
  // NOT here: it renders only while a query is active and nothing matches,
  // so it is not in the prerendered document — the same treatment the maps
  // give ids behind an open dialog.
  // ── #5048: private requests ──────────────────────────────────────────────
  'feedback-private-row': '#5048: the Suggest an improvement dialog\'s "Private request" box, which files the request in Homeroom only (POST /api/private-requests) where only platform admins can see it, never as a GitHub issue. Ships hidden; feedback-controller.js shows it to full admins on each open.',
  'feedback-private-checkbox': '#5048: the box itself, unticked on every open.',
  'feedback-sent-edit': '#4803: correct a just-filed request from its confirmation for five minutes.',
  'feedback-first-edit': '#4803: the same correction action on the first-request confirmation.',
  'feedback-edit': '#4803: shared correction form, initially hidden; its controller owns the fields and visibility.',
  'feedback-edit-heading': '#4803: accessible heading of the feedback correction form.',
  'feedback-edit-window': '#4803: server-authorized time remaining to correct the request.',
  'feedback-edit-title': '#4803: the existing request title, ready to correct.',
  'feedback-edit-text': '#4803: the existing request description, ready to correct.',
  'feedback-edit-status': '#4803: save failure, expiry or stale-edit message without losing the typed corrections.',
  'feedback-edit-cancel': '#4803: return to the confirmation or close a profile-opened editor.',
  'feedback-edit-save': '#4803: save the title and description to the same request.',
  // ── #4405: custom domains ───────────────────────────────────────────────
  'app-domain-modal': '#4405: the Custom domain dialog (features/dialogs/app-domain.tsx), opened from the hub\'s ⋯ menu\'s Settings & rules row for whoever manages the project, or by `?shot=app-domain`. Ships hidden and EMPTY but for its title, its error line and the Close pill; everything else arrives from GET /api/apps/:slug/domain in its onOpen, so the prerender and the first client render agree. The ids that render behind that read (and so are not in the prerender, nor here): #app-domain-input and #app-domain-add (the claim form), #app-domain-section with #app-domain-status (the state in words and the sentence that says why), #app-domain-records (the CNAME and TXT rows dapp.json\'s declared check selects on), #app-domain-check, #app-domain-open and #app-domain-remove.',
  'app-domain-error': '#4405: the dialog\'s error line, hidden until a request fails.',
  'topics-modal': '#4417: the Topics dialog (features/dialogs/topics.tsx), opened from the project page\'s Settings & rules › Topics row. Each change it makes (a new topic, a rename, a merge, an archive) opens a PR against dapp.json\'s `topics` for the group\'s vote. Ships hidden and EMPTY but for its title, its line and its error line; everything else is drawn from the community record once it is open, so the prerender and the first client render agree. The ids behind the open (not in the prerender, nor here): #topics-form with #topics-name, #topics-handle and #topics-about, #topics-into, #topics-submit and #topics-status.',
  'who-decides-modal': '#4666: the Who can see & change it sheet (features/dialogs/who-decides.tsx), opened from the Workshop rule line\'s Rules, Settings & rules, App settings and Members. Who can see the project and how its changes are approved (four presets, or groups and rules of its own) go up as ONE PR against dapp.json\'s `visibility` and `governance` blocks. Ships hidden and EMPTY but for its root and card; everything is drawn from the community record once it is open, so the prerender and the first client render agree. The one id behind the open (not in the prerender, nor here): #who-group-name.',
  'members-who-decides': '#4666: Members & approvals\' row that opens the Who can see & change it sheet, in place of the approval controls on every project but the platform\'s own. Ships hidden; members-controller.js shows it to whoever manages the project.',
  'topics-error': '#4417: the Topics dialog\'s error line, hidden until a proposal is refused.',
  'share-homeroom-address': '#4405: the "Also at <homeroom host>" line under Share\'s link, shown only when the link offered is the project\'s custom domain. Ships hidden and empty.',
  // ── #4127: one paperclip for Photo and Video in Send feedback ─────────
  'feedback-queue-retry': '#3994: Try again under Send feedback\'s status line, shown while a message saved on this device has not been sent. It sends the outbox now (FeedbackQueue.retryNow) instead of waiting for reconnect, sign-in or the backoff timer. Shown and worded by ./feedback-controller.',
  'feedback-attach-btn': '#4127: the paperclip in Send feedback\'s attachment row. It opens #feedback-attach-menu, which holds the Photo (#feedback-screenshot-picker-btn) and Video (#feedback-video-btn) rows that were two buttons of their own, so the row fits on one line. dapp.json\'s feedback check selects on it.',
  'feedback-attach-menu': '#4127: the paperclip\'s popover, in the vote popover\'s frame. Opened and closed by ./feedback-controller (outside click, Escape, a choice).',
  'report-modal': '#2721 shared reporting dialog',
  // ── B8: Suggest an improvement answered by Homeroom bot ─────────────────
  'feedback-sent-line': 'B8: the line under the filed-request confirmation\'s heading, worded by the controller: "Your idea is on the board now.", or, where Homeroom bot builds it, "Homeroom bot is building it now, usually about 8 minutes…" (#3971).',
  'feedback-sent-chat': 'B8: Open chat, the secondary button under Done when Homeroom bot builds the request: the chat where its card is.',
  'feedback-sent-fix': 'B8: the confirmation\'s small "Build it now with a coding agent" link, for somebody who could start a change there.',
  // ── #3971: a first request Homeroom bot builds is a first request ───────
  'feedback-sent-first': '#3971: "Your first request!" inside the bot\'s confirmation. B8 skipped the first-request moment whenever the bot built the request; it comes back here, beside Open chat rather than in place of it. Hidden unless the post was the person\'s first request and the bot builds it.',
  'feedback-sent-first-line': '#3971: that block\'s "You just helped shape <app>." line, named by the controller after the app the request was filed to.',
  // #3230: the spend card's reset line, rewritten by Settings._refreshSpend()
  // in the viewer's own clock (it prerenders the server's UTC boundary).
  'settings-spend-reset': '#3230 spend card reset line, localized at reveal',
  // #3319: Settings → Theme's "Keep sidebar open in apps" switch, React-wired
  // (features/settings/sections/theme.tsx) and desktop only.
  'settings-rail-pinned': '#3319 keep-sidebar-open-in-apps switch',
  // ── #3969: Settings → Accessibility, the reading controls ──────────
  // A page of one part in Preferences, right after Appearance. Stateful like
  // Theme (features/settings/sections/accessibility.tsx); nothing in
  // settings.js binds inside it.
  'settings-accessibility-section': '#3969: the Accessibility page root, inside its [data-settings-section="accessibility"] wrapper.',
  'settings-text-size-track': '#3969: the Normal / Large / Larger segmented control. Reuses the .theme-seg classes app.css keys the recessed track off; deliberately no caret — --theme-caret-index belongs to the theme control.',
  'settings-contact-privacy-section': '#5104: the Privacy page root, inside its [data-settings-section="contact-privacy"] wrapper.',
  'settings-who-can-message': '#5104: the "Who can message or invite me" radio group (People in projects I\'m in, the default, or Anyone).',
  'settings-profile-discoverable': '#5104: the "Let people find my profile" switch, off by default.',
  'settings-phones-section': '#4938: the Linked phones page root, inside its [data-settings-section="phones"] wrapper.',
  'settings-phones-list': '#4938: the list of phones signed in with the Homeroom app, one row per phone with Unlink; empty until the account is read.',
  'settings-high-contrast': '#3969: the High contrast switch (the RailPinnedRow pattern, at every width).',
  // ── #4289: comment mode stops being an experiment ───────────────
  //
  // #suggest-shortcut-enabled leaves THIS map rather than entering
  // RETIRED_IDS, because the frozen baseline never recorded it: comment mode
  // is the default now, so the switch in Settings → Experimental is gone.
  //
  // ── #2718: the platform's destinations leave the app's menu ──────
  //
  // Eleven ids leave THIS map rather than entering RETIRED_IDS, because the
  // frozen baseline never recorded any of them: #switcher-row-home,
  // -workshop, -discover, -challenges, -messages, -profile, -wallet,
  // -validator, -settings, -admin and #switcher-byok-dot.
  //
  // They were the app chip menu's "Platform" and "You" groups, on #1443's
  // rule that one control names where you are and its menu lists everywhere
  // you can go. That rule is now split the way every mini-app host it was
  // modelled on already had it: the host's sections live on a permanent bar
  // (#platform-tabs) and the menu under a mini-app holds the MINI-APP's
  // options. Home, Discover, Messages, Workshop and Profile are TABS;
  // Challenges, Settings and Admin are rows of the Profile screen the Me tab
  // lands on (features/profile/account-panel.tsx); Wallet and Validator were
  // already rows there and are only rows there again.
  //
  // `switcher-row-admin` survives as a published FLAG name — app.js still
  // publishes it and Profile reads it — which is a capability, not a row.
  // ── #2718: Messages is one inbox ─────────────────────────────────
  //
  // #messages-filter-empty and the two row kinds' own elements are NOT in
  // this map: they render only once a filter has narrowed to nothing or once
  // a discussion or an agent chat has arrived, so none of them is in the
  // prerendered document, which is what this map is for.
  // #messages-filters and its three chips (#messages-filter-all, -people,
  // -agents) left this map on 16 Oct 2026: the list was split into headed
  // sections (Homeroom bot, Agents, People), which say which is which, so
  // the strip went. They were only ever ADDED ids, so they simply leave, as
  // #messages-filter-apps did.
  'messages-new': '#2718, then #2778: the "+" at the filter strip\'s trailing end, beside the search since the strip went (16 Oct 2026). #2718\'s review took it off the strip because ONE control saying "new" could only mean one of the kinds the inbox holds, and replaced it with a row of compose buttons under the strip (#messages-compose, retired below). #2778 brings it back as a CHOICE: pressing it opens a small popover — the vote picker\'s placement and dismissal, shared through lib/anchor-popover.ts and lib/popover-dismiss.ts — offering a direct message, a group chat or an agent chat, so it no longer has to guess. On touch the choice is the kit\'s action sheet. The popover (#messages-new-menu) renders only once pressed, so it is not in the prerendered document and not in this map.',
  // ── #2718: the Workshop gets a scope, three tabs and a plus ──────
  //
  // #workshop-picker, #workshop-picker-all, #workshop-plus-change,
  // #workshop-plus-issue, #workshop-plus-create and #workshop-tab-empty are
  // NOT in this map and that is not an omission: all six render only once
  // somebody has tapped or once a tab has filtered to nothing, so none of
  // them is in the prerendered document, which is what this map is for.
  // #workshop-scope left this map with the chip itself (#2759), came back
  // with it in #3051, and left again in #852: the Communities screen's "All
  // ⌄" is the header's #header-scope-switch at every width now, which is
  // conditional and so not in this map. The chip on an app's own Workshop
  // was #dev-ws-scope-chip, which rendered client-side and was never in the
  // prerendered document; #3295 retired it for the header's
  // #header-app-switch, which is conditional and so not in this map either.
  // #workshop-tab-status and #workshop-tab-needs (#3051) left with the
  // tabs they named: the Communities screen is one page, and the Needs you
  // feed opens from a row at its top ([data-workshop-needs-open]) as a page
  // with a way back, so neither is in the document any more.
  'platform-parked': '#2718: the app you left, offered above the tab bar until it is resumed or dismissed. The bar makes the platform\'s five places one tap each and in doing so makes the app you were IN the one thing that is not: it has no tab, the header\'s app strip goes with it, and Home\'s grid is every app rather than the one you were halfway through. Every host that runs other people\'s programs keeps a handle to the thing you stepped out of — the app switcher, the taskbar, Telegram\'s minimised bot window, WeChat\'s floating capsule — and this is that handle at phone scale. The ROOT ships in the document, `hidden` and EMPTY, which is what an empty store renders; the app arrives from localStorage in an effect, so the prerender and the first client render agree and the id stays in this inventory whatever is parked. Its two children (#platform-parked-resume, #platform-parked-forget) are conditional and therefore not in this map, like #header-app-tile above.',
  // #4417: the rail's Recents (#platform-recents, #platform-recents-head,
  // both ADDED here by #2802 and never in the frozen baseline) is retired:
  // the desktop strip's five recent apps and the section column beside it
  // took its place, and the conversations it listed are Messages' own list.
  // The strip's apps (#platform-strip-apps) went in turn on 18 Oct 2026, for
  // an App row under each community: see #platform-rail-pinned below. So did
  // #platform-section-column (also ADDED here, by #4417): the sidebar of rows
  // nests a project's places under its row from 768px, the drawer holds
  // them on a phone, and with the strip gone no width drew the column.
  // #app-menu-row-discussion ("Go to app discussion", #2718) left the menu in
  // the UI overhaul: the project's channel is on its hub, one row above it.
  // ── Three ids from #2718's second pass that are NOT in this map ──
  //
  // #workshop-total-working, #workshop-total-needs (both retired again with
  // the Communities screen's legend, UI overhaul) and
  // #app-menu-workshop-owed are figures read from data, so they do not exist
  // until a fetch answers and the prerender carries none of them. ADDED_IDS
  // is checked BOTH ways — an entry here that is not in the document fails
  // the same test a stray id does — so a conditional id is recorded in prose
  // rather than in the map. They are listed here so the inventory is still
  // the complete log of what this branch added.
  // #app-menu-row-invite ("Invite to community") left the menu in the UI
  // overhaul (#3362): invite links open from the hub's Invite, and the
  // sheet's invite pane is unchanged.
  'app-menu-row-about': '#2718: the row that opens the sheet\'s SECOND PANE — the repository, sharing, the running version and how to add the app to a home screen. A button and not an anchor, which is the honest shape: there is no address to open in a new tab, because the pane is this sheet in another state. Two panes of one sheet rather than two sheets, because the kit cannot present a sheet while it is still dismissing another.',
  // ── #2718: the platform's five places get a bar ──────────────────
  // The app chip's menu was carrying two unlike lists — the app's own
  // options and the platform's destinations — because there was no bar for
  // the second one to live on. Every host this shell is modelled on keeps
  // both: a flat per-mini-app menu AND a permanent bar of the host's own
  // sections, with the menu's deeper rows linking OUT to those sections.
  // This is that bar; the rows that moved onto it leave the menu in the
  // same change (see RETIRED_IDS).
  'platform-tabs': '#2718: the shell\'s five sections as a permanent bar at the foot of every platform screen — Home, Discover, Messages, Workshop, Me. A React island (frontend/src/features/nav/tab-bar.tsx) and a direct child of <body>, not a child of any screen root: a bar rebuilt on every screen swap is a bar that flickers when you use it. `position: fixed` rather than a flex item at the end of the body column, because on `html[data-browser-scroller]` routes the DOCUMENT scrolls and body height goes `auto`, so a flex child there leaves the screen with the page. It ships VISIBLE, which is what the prerendered document carries; the three routes that hide it (a running app, chromeless, the signed-out shell) publish `platform-tabs` false through the visibility store, and App._syncPlatformTabs is the one place that decides.',
  'platform-tab-home': '#2718: the Home tab. The one tab whose href is a real path (`/`) rather than a hash route, so a cmd-click opens the launcher in a new tab; a plain click is intercepted and handed to App.navigateHome(), guarded by NavLink.isNativeClick exactly as the app menu\'s Home row was.',
  'platform-tab-discover': '#2718: the Discover tab, to #apps. Keeps the magnifier the retired #switcher-row-discover carried rather than taking a grid glyph — moving a destination should not also rename it.',
  'platform-tab-messages': '#2718: the Messages tab, to #messages. The only tab that can carry a count (see #platform-tabs-badge).',
  'platform-tab-workshop': '#2718: the Workshop tab, to #workshop — which of your apps wants something from you, the question Home does not answer.',
  'platform-tab-me': '#2718: the Me tab, to #profile. Challenges, Settings, Wallet, Validator and Admin are all reached from it, which is what keeps the bar to five: a sixth tab would be a section nobody opens daily.',
  'platform-rail-settings': '#3120: a Settings cog beside Me at the foot of the desktop rail, straight to #settings — the admin asked for settings one click from the sidebar rather than Me → scroll → the Settings row. After #platform-tab-me in the markup (so the declared sibling chain ending at Me is unchanged) and not a `.platform-tab`, because the phone bar is five equal cells: app.css gives it a box only inside `@media (min-width: 768px)`. It lights (`aria-current="page"`) on #settings-screen, which the nav store\'s `screen` says, and ships unlit because INITIAL has no screen.',
  'platform-tabs-badge': '#2718: the Messages tab\'s unread count, and the SECOND badge in the shell. #1443 argued for exactly one, on #notifications-badge, on the grounds that an unread message IS a notification and a menu row is where you say where you are going rather than where you learn something happened. That argument is about a MENU: a tab is visible without opening anything, and a Messages tab that cannot say "there is something here" leaves the bell as the only way to find out — which puts a conversation back behind the sheet the bar exists to get things out of. It counts CONVERSATIONS with something unread, not messages, and renders only above zero so the prerender (navStore\'s INITIAL is 0) and the first client render agree on no badge at all.',
  // #notifications-tab-agents left this map in #2815: the bell's Agents tab
  // folded into Messages, which now lists the running sessions and the agent
  // notifications beside the conversations, as the Messages screen's chats
  // section already did. It was only ever an ADDED id, so it simply leaves.
  // #messages-compose left this map in #2778: what starts something is the
  // "+" at the strip's end again (#messages-new), opening a popover of three
  // choices rather than a row of buttons under the strip. Its agent half,
  // #messages-new-agent, never shipped in the prerendered document (it is
  // gated on the global-chat flags), so it was never in this map. Both were
  // only ever ADDED ids, so they simply leave.
  // #messages-agent-dialog and #messages-agent-apps left this map in #2779:
  // the "+"'s Agent choice asked which app and opened a classic dev session
  // there, and classic sessions are no longer created; it opens an unsent
  // agent session instead, which needs no app first. Both were only ever
  // ADDED ids, so they simply leave.
  "messages-search": "#2718 review: the Messages inbox's search. It takes the place of the <h2> that used to name the screen under a bar already naming it \u2014 two titles, one word, an inch apart. A CLIENT-SIDE match over the three lists already in memory (people, app discussions, agent chats), so it answers on every keystroke and adds no endpoint; what it matches is the text each row DRAWS, because a search that found rows by a field the reader cannot see returns results they cannot explain. It composes with the filter strip rather than replacing it, and a query that matches nothing says so in its own line rather than borrowing the empty inbox's offer to start a conversation.",
  'sidebar-toggle': '#2718 review: folds and unfolds the desktop rail, from the header\'s left group — the window\'s top-left corner, where VS Code, Slack, Linear and Notion all put this control. DESKTOP ONLY: app.css gives it `display` inside `@media (min-width: 768px)` and nothing else does, because a phone\'s bar is at the FOOT of the screen and is the only navigation there is, so folding must never reach it. It ships PRESSED, matching navStore\'s `railOpen: true` and the visible bar the prerender carries; a folded rail is always something the viewer did, and it is session-only for the same reason. It renders nothing at all where the route has no rail (inside an app, chromeless, signed out), which is also what makes the header\'s left group empty on those screens rather than holding a dead control. The way back from folded is #platform-rail-peek, the same hot zone an open app already uses.',
  // ── #2370: the social-account scope disclosure ───────────────────
  'github-link-scope': '#2370: the scope line under the provider rows — no repository access, no provider token, and that this is account control rather than proof of unique humanity. It used to sit in a 76-word section lead ahead of the rows, read before anyone could act. It is deliberately NOT a disclosure: dapp.json asserts these phrases with no interaction step, which is the product stating they must be readable without a tap.',
  // ── #2266: password-reset completion ─────────────────────────────
  'login-reset-success': '#2266: the durable success notice shown on the login form after a completed email password reset. The reset form is terminal now, so its old inline status has no successful state to render.',
  // ── QA 2026-09-24 Q11: the register form states the account rules ──
  'reg-username-hint': 'The line under the register form\'s username field: the handle rule (letters, numbers and underscores, 3 to 32 characters) while the field is fine, and the server\'s sentence about the name when POST /api/auth/register refuses it (`field: "username"`). Registration now applies the same rule a rename does; the input names it through aria-describedby.',
  'reg-password-hint': 'The same line under the password field: "At least 8 characters", the rule Change password already enforced and registration now does too, or the server\'s refusal when it is `field: "password"`.',
  // ── #3575: the person chooses the handle, and is told it is public ──
  'reg-username-public': '#3575: "Your username will be public to other users on Homeroom." directly under the register form\'s username field, ahead of #reg-username-hint. Its own element rather than a clause of the hint, because the hint is swapped whole for the server\'s refusal and this sentence has to stay beside the field while the person fixes the name. The input names both lines through aria-describedby. The email sign-up\'s set-password step and the first-run gate say the same sentence beside their fields.',
  // ── Communities, stage 5: the first run ─────────────────────────────
  // #home-getting-started left this map in #4635: every new account gets a
  // tour, so Home's Getting started card went, and a new account's
  // First challenges are ordinary cards in Home's Challenges area. It was
  // only ever an ADDED id, so it simply leaves.
  // ── #1374: per-app notification settings ─────────────────────────
  // One switch per category governs the bell here AND the phone push,
  // because the preference gates whether the notification is CREATED and
  // mobile_push_deliveries references notifications(id).
  'app-notifications-modal': '#1374: the per-app Notifications dialog, opened from the app tile\'s "..." menu. Its own root rather than a section of #app-settings-modal, because that dialog is offered only to admins and the creator while these switches belong to everybody who uses the app.',
  'app-notifications-done': '#1374: that dialog\'s only footer control. Each switch saves on change, so there is nothing to confirm and no Cancel that could mean anything.',
  'settings-notification-prefs': '#1374: the Settings roll-up under Notifications & alerts — your account-wide defaults plus every app you have set differently. Without it a muted app can only be found by opening its tile menu and looking.',
  'notification-prefs-list': '#1374: the roll-up\'s rows host, React-owned end to end (features/settings/notification-prefs-list.tsx). Ships EMPTY, like #llm-grants-list and #app-permissions-list beside it: the list is fetched when the section opens, so contents in the prerender would be a hydration mismatch.',
  'notification-prefs-status': '#1374: that section\'s status line, written by Settings._setNotificationPrefsStatus after a default change or an app reset. Same controller-host contract as #llm-grants-status.',
  // ── #2219: App device permissions ────────────────────────────────
  // The Settings sibling of the App AI permissions section. It exists
  // because a permission the platform asks for has to be one a person can
  // take back somewhere other than the app that asked, and because a
  // capability an app stops declaring should be visible as gone.
  'app-permissions-section': '#2219: the App device permissions pane — every app the viewer has let reach their location, microphone, camera, screen or a connected device, with Revoke and Re-enable per capability.',
  'app-permissions-list': '#2219: the rows host, React-owned end to end (features/settings/app-permissions-list.tsx). Ships EMPTY, like #llm-grants-list beside it: the list is fetched when the section opens, so contents in the prerender would be a hydration mismatch.',
  'app-permissions-status': '#2219: the section\'s status line, written by Settings._setAppPermissionsStatus after a revoke or a re-enable. Same controller-host contract as #llm-grants-status.',
  // ── #1823: Challenges in the app menu ────────────────────────────
  // ── #2382: Wallet and Validator under the app chip ───────────────
  // Profile's native account rows stay where they are; these are second
  // entrances in the menu's You group, between Profile and Settings.
  // ── The Workshop screen ──────────────────────────────────────────
  // The app's own Workshop page answers "what is happening in THIS app";
  // nothing answered "which of my apps wants something from me", short of
  // opening each one in turn. This is that page's two numbers, once per app.
  'workshop-screen': 'The Workshop SCREEN root (#workshop), a React-owned sibling of #messages-screen: every app in the viewer\'s "Your apps", with how many items that app\'s own Workshop page holds for them. Ships hidden and EMPTY — the rows arrive from GET /api/apps + GET /api/workshop/counts in the controller\'s open() — so the prerender and the first client render agree.',
  'profile-proposals-screen': '#5310: the "Your proposals" SCREEN root (#profile/proposals), a React-owned sibling of #workshop-screen: every proposal the viewer has started, grouped by status. Ships hidden and EMPTY; the rows arrive from GET /api/me/proposal-history in the controller\'s open(), so the prerender and the first client render agree.',
  'workshop-list': 'That screen\'s card of rows — a <GroupedList> from @/components/ui/grouped-list, the widget language\'s primary content shape, so the id sits on the primitive rather than on a hand-rolled div. It carries no rows in the prerender, like #browse-list beside it; a row is a <ListRow as="a"> with `[data-workshop-app="<slug>"]` carrying `[data-workshop-working]` and `[data-workshop-needs]`, which is what the declared checks select on.',
  'workshop-empty': 'Its nothing-to-show state, for an account with no apps. #2445 made it a CARD rather than the grey caption line it shipped as — a <ListRow as="a" href="#apps"> reading as an invitation to the directory, the way Home\'s Discover block\'s own empty card does (#1913): title over subtitle with the row\'s disclosure chevron. THE ID IS ON A WRAPPER <div>, NOT ON THAT ANCHOR, and that is load-bearing in two directions. dapp.json selects `#workshop-empty.hidden`, so the id and the `hidden` class toggle stay together on one element and visibility is never conditional rendering; and a SECOND declared check selects `#workshop-list a[data-workshop-app]:first-of-type`, which an `<a id="workshop-empty">` sibling of the rows silently steals — `:first-of-type` is structural and `display: none` does not exempt it. That shipped once and failed on the next run; the wrapper is the fix. Ships `hidden`, and stays hidden while the list is still loading — the skeleton rows are that state, and an empty list that reads as "you have no apps" before the fetch lands is the bug this distinction prevents. It is the list\'s FIRST child, not its last: GroupedList\'s row separator is `[&:not(:last-child)]:after:*` on the row, so a note after the rows would leave the last one drawing a hairline under nothing.',
  'app-settings-modal': '#2158: dedicated app settings and danger zone.',
  'app-delete-name': '#2158: named confirmation before app deletion.',
  // ── #2304: access is an app setting ──────────────────────────────
  'app-access-section': '#2304: the canonical app access editor, above the existing Danger zone. It ships hidden and appears only for a manageable, non-self-hosted app.',
  'app-access-open': '#4666: the Access section\'s one button, which opens the Who can see & change it sheet (features/dialogs/who-decides.tsx). It replaced the three access choices and their Propose button (#app-access-propose) and status line (#app-access-status): who can see it and how changes are approved are one proposal now.',
  'members-load-error': '#2304: dialog-level feedback when Members & approvals is opened before its app row has loaded, replacing the misleading visibility-specific status target.',
  'staging-retry-btn': '#1993: retry preview sign-in after token acquisition fails; initially hidden.',
  // ── OpenRouter catalog controls ──────────────────────────────────
  'settings-openrouter-model-search': 'Filters the OpenRouter catalog by model name, id or provider without another network request.',
  'settings-openrouter-favorites-only': 'Limits the settings picker to the viewer\'s saved OpenRouter model favorites.',
  'settings-openrouter-refresh-models': 'Asks OpenRouter for a fresh catalog (at most once a minute) and reports when it was refreshed.',
  'settings-openrouter-star-model': 'Adds or removes the selected OpenRouter model from the viewer\'s persistent favorites.',
  'settings-openrouter-catalog-meta': 'Shows the visible and total model counts plus catalog freshness beside the picker.',
  // ── #1538: check my status ────────────────────────────────────────
  // The waitlist confirm step doubles as "read where I stand", so the panel
  // that used to print one fixed sentence now prints what the row actually
  // says. Four of the five ids are inside #waitlist-confirmed; the fifth
  // is the landing page's way in.
  'waitlist-status-pill': 'The three-state queue pill on #waitlist-confirmed, rendered from the SAME table as the stage-2 screen\'s #more-status-pill (waitlist-shared.tsx) so one row cannot be described two ways. Always in the markup and hidden until a code lands: the prerender has no status, and contents rendered before the fetch are a hydration mismatch, which console.errors and fails proposal checks.',
  'waitlist-status-since': 'The joined-on date, offered in place of the queue position this panel deliberately does not show. Nothing on the platform ranks the waitlist (services/waitlist-signals.js computes no score on purpose), so a number would be invented; the date is a fact the row actually holds. Same always-present, hidden-until-filled contract as #waitlist-confirmed-email beside it.',
  'waitlist-status-action': 'The one thing a RELEASED signup can act on: Create my account (#signup) or Sign in (#login), chosen on whether the invite has already been redeemed. Before this, somebody who lost the access-ready mail was told by this panel to keep waiting for it. Hidden for a signup that is still queued.',
  'landing-status-link': 'The landing card\'s "Already joined? Check your status" link, into the same code-entry step #waitlist-enter-code opens. It is the entry point for the case the issue is about — checking from a device that knows nothing about the signup — and it is on the landing page because that is where such a device arrives. Hidden for a session, like the CTA above it.',
  // ── #1876: the check-my-status errand is two steps ────────────────
  // It asked for the address and the six-digit code in one breath, and the
  // control that actually SENT the code was a tertiary "Didn't get it?" link
  // underneath the field. Split, on the codeOnly path only: the post-join
  // path is untouched, because there the join WAS step 1.
  'waitlist-confirm-address': 'Step 1 of that errand: the address, the send, and its own status line. A wrapper rather than a set of per-element class expressions, because the whole half comes and goes together; and a wrapper rather than `display: contents`, which `.hidden` cannot override. Ships hidden: nothing here is on screen until somebody asks to check their status.',
  'waitlist-confirm-code': 'Step 2: the six-digit field, the resend and the way back, which is everything #waitlist-confirm used to hold on its own. Visible in the prerender, because that is what the hand-written shell shipped and what the post-join path still shows; the split only hides it while the address step is up.',
  'waitlist-request-code': 'The address step\u2019s primary action, and the promotion the issue was about: sending the code is what somebody came here to do, so it is a filled button rather than a footnote under the field. Its cooldown and its label are the resend\u2019s, because it is the same request to the same endpoint.',
  'waitlist-request-note': 'That step\u2019s own status line. Separate from #waitlist-resend-note so the two cannot overwrite each other: a request that failed says why here and stays put, and one the server accepted advances and says so on the next step, beside the field it is about.',
  'waitlist-have-code': 'For the reader who arrived from the status mail with a code already in hand. It sends NOTHING on purpose: issueVerificationCode deletes every unconsumed code for an address before minting the next one, so making this button send would invalidate the code in the inbox of the very person who followed that mail here.',
  'waitlist-change-email': 'The way back from the code step to the address step, for the address that was a typo. It assigns the fragment rather than only setting state, so the browser\u2019s own Back does the same thing and the URL and the screen cannot disagree.',
  // ── #2201: the address step's third answer ───────────────────────
  // POST /api/public/waitlist/status made "that address is not on the list"
  // something the step can actually say, and saying it needs somewhere to go.
  'waitlist-join-instead': 'The way out of the one dead end step 1 had. An address that is not on the waitlist used to be told a code was coming and left waiting for a mail nobody sent; it is told the truth now, and the truth is half an answer unless the next move is beside it. Opens Continue since #5261, which joins now. Always in the markup and hidden until the status read says not-found, which is why the class rides on the button itself: the declared checks assert presence, so `:not(.hidden)` on this id is the only way one can tell the offered state from the withheld one.',
  'feedback-form': 'The existing feedback form is hidden while the first-feedback confirmation is visible (#1583).',
  'feedback-first-success': 'Persistent first-feedback confirmation inside the existing feedback dialog (#1583).',
  'feedback-first-title': 'Accessible heading congratulating the first feedback submission (#1583).',
  'feedback-first-notice': 'Preserves the successful filing and optional bounty outcome in the first-feedback confirmation (#1583).',
  'feedback-first-fix': 'Starts an editable fix draft for the feedback issue (#1583).',
  'feedback-first-fix-note': 'Explains the fix draft or the collaboration access requirement (#1583).',
  'feedback-first-board': 'Opens the board of the app that received the feedback (#1583).',
  'feedback-first-done': 'Dismisses the first-feedback confirmation without starting work (#1583).',
  // ── #3186: "Your feedback", reachable from the confirmation ──────────
  'feedback-first-mine': 'Opens the Me screen\'s "Your feedback" list (#profile?feedback) from the first-feedback confirmation, where the report just filed is listed with its status (#3186).',
  'feedback-sent': 'Every other filed report\'s confirmation (#3186). It was the status line, and the dialog closed itself 1.5 s later, which read as the report vanishing and was too short to reach a link in; it is a section of its own now, drawn like #feedback-first-success, and stays until Done.',
  'feedback-sent-title': 'Accessible heading of the sent confirmation (#3186).',
  'feedback-sent-notice': 'The "Thanks! Filed against …" line and any bounty outcome, carried into the sent confirmation (#3186).',
  'feedback-sent-mine': 'Opens the Me screen\'s "Your requests" list (#profile/your-requests) from the sent confirmation (#3186). A quiet link under the buttons, beside Edit (#feedback-sent-edit).',
  'feedback-sent-done': 'Dismisses the sent confirmation (#3186).',
  // ── #4680: the form and the list point at each other ─────────────────
  'feedback-form-mine': '#4680: the form\'s small "See your requests" link, under the intro line — the same route the two confirmations\' links open (#profile/your-requests), so what is already asked for is one tap away before writing a new one. Not hidden in the prerender, so the server render and the client render agree. Worded by React (t()); the click is ./feedback-controller\'s openMine, the same split as #feedback-sent-mine.',
  'improve-working-dot': 'What was left on #improve-btn once the session COUNT moved to the bell (#1610): a bare 8px emerald pulse (a small blue corner spinner since the #2779 follow-up), rendered only while a dev session the viewer can see is mid-turn (their own, since the same follow-up). It carries no text and no count, because that is the distinction the move was about — a count is an event waiting to be read and belongs where reading happens, while "a turn is running right now" is a live fact that needs no dismissal. #2718 retired the button and the dot outlived it: it is on the Homeroom mark\'s tile now, which is the control on screen on every route. Top-right, so it cannot hide under the bottom-left outbox dot, which followed it there.',
  'wallet-recovery-modal': 'Native-only recovery for a pre-merge email wallet when authoritative session admission reports that the seeded wallet pool is empty. Opened ONLY from Settings → Homeroom app → connection ("Connect existing wallet"); it used to open itself on every failed admission attempt, which is the pop-up that was reported.',
  // ── Home area labels: the block chrome moved above the card ──────
  'home-browse-btn': 'Discover\'s way into the #apps directory. Not a new control — it has always been the block\'s browse link — but it is in the COLD DOCUMENT now, which is why it is a new id here. The block\'s title moved out of the card to become the section\'s label, its controls followed (a card whose first row was chrome with one link floating at the end of it reads worse than one that opens on content), and a section heading is constant markup where the block behind it is fetched. So the control ships with the shell instead of appearing when /api/home-panels answers — which is also one less thing that pops in on a cached load.',
  // ── Platform UI pass: the update state, and where the versions live ──
  'settings-about-section': 'Settings → About: the three version rows. They have moved twice before (#1431 built an About block, #1443 took them to the Improve panel\'s footer). They are back because the question they were being read for — "is something happening, and is there a new version yet" — is answered directly by that footer now, as a note and a reload button. What is left over is reference material, and this is the reference screen.',
  'about-row-app-version': 'The open app\'s latest merged main, in that pane. Gated on `slug && !selfHosted`, exactly as the Improve panel\'s copy was: on the platform\'s own app this row IS the platform, so it and "Platform version" under it printed the same seven characters twice.',
  'about-app-version-slot': 'Its value. A store-fed island rather than a legacy innerHTML target — the pane around it is static, and a version arriving when an app opens should repaint one row, not the settings screen.',
  // ── #5094, #5106: the terms and the privacy notice in Settings → About ──
  'settings-about-legal': 'Settings → About\'s Legal block, under the version rows: where a signed-in person finds the terms and Homeroom\'s privacy notice again after the sign-in screens named them (#5094, #5106). The Homeroom app shows this same screen, which is what puts them in the app\'s Settings too.',
  'settings-about-terms': 'Its Terms row: opens the terms sheet settings.js owns (Settings.showTermsSheet), the same one the Homeroom app\'s "about & legal" block opens.',
  'settings-about-privacy': 'Its Privacy notice row: a new-tab link to the address GET /api/public/waitlist/options serves as privacy_link (src/services/marketing-links.js). Inside the Homeroom app public/js/nav-link.js hands it to the bridge\'s openExternal. No href in the prerender; it arrives with the options.',
  // ── Andrea's 27 Aug 2026 waitlist review: "Follow along" ────────
  'more-follow-row': 'Holds the "Follow on X / LinkedIn / Instagram" links on the stage-2 form. Empty in this document by design: each link renders only when WAITLIST_FOLLOW_<NETWORK>_URL is set, so an unconfigured network shows nothing rather than a dead profile link.',
  'more-followed': 'The "I followed along" checkbox, stored as `answers.followed_claim`. It is a SELF-REPORT and is deliberately kept out of `answers.verified`: LinkedIn returns aggregate follower statistics with no identity, Instagram exposes a count and no relationship lookup, and X retired its boolean friendship endpoint, so no network will confirm a follow for us. Hidden here because its label is shown only once at least one follow URL is configured.',
  // ── #1443: what came back ───────────────────────────────────────
  'messages-screen': 'The Messages screen root, restored. #1431 made it #messages-sheet because a header chat bubble on every route left a full-screen Messages with no honest answer to "back to where?" — the bubble is gone and Messages is a menu row now, so the screen is both the honest shape and the one every messaging product uses for reading past conversations.',
  'drawer-row-native-app-version': 'The installed Flutter release, back in that footer. #1431 renamed it #about-row-native-app-version for the Settings About block it built; the block is gone with the rows it existed to hold, so the name goes back too. `.drawer-ver-row` is the shared CSS recipe, not a claim about a drawer.',
  // ── #2761: the app's views are a ROW, not a toggle ────────────────
  // #improve-views, #app-context-row-app and #app-context-row-workshop were
  // the App | Workshop strip under the mark. They were added after the frozen
  // baseline, so they leave this map rather than entering RETIRED_IDS. The
  // owner asked for a plain "Go to workshop" row instead of a toggle, and for
  // nothing in place of the App segment — the parked app on the bar (#2762)
  // is the way back to a running app.
  'app-menu-row-workshop': '#2761: "Go to workshop" — the row that replaced the App | Workshop strip under the mark. It links to #app/<slug>/workshop and carries the vote-count badge (#app-menu-workshop-owed, conditional, so not in this map) the strip\'s Workshop segment carried. Rendered unconditionally, like the strip, so the prerender and the hydrating render agree.',
  // ── #1443: the chip and its menu ────────────────────────────────
  // ── #2718: the chip came back apart ──────────────────────────────
  // #app-switcher-btn was the header's label AND the one control that opened
  // a list, on the reading that one control should name where you are and
  // list everywhere you can go. The tab bar (#platform-tabs) carries the
  // platform's destinations now, so the menu behind the name holds the APP's
  // options — and a name that opens a menu about something else is a label
  // that lies about its button. The name went back to being a name and the
  // menu got its own button. Both of the chip's ids leave THIS map rather
  // than entering RETIRED_IDS: the frozen baseline never recorded them.
  'platform-mark-btn': '#2718: the Homeroom mark with a chevron, at the far right of the bar, opening the app-context menu that #app-switcher-btn used to open. THE MARK RATHER THAN A "…", which is what WeChat, Telegram, Alipay and Chrome\'s Custom Tabs all draw in this seat: the hosts whose mini-apps are made BY the people using them use their logo instead (Roblox, the Steam button on a Deck), and inside somebody else\'s app "whose menu is this" is the question the button answers. It is UNFRAMED beside the framed bell on purpose — two identical containers side by side read as one segmented control, so the pair differ in kind instead.',
  'header-title-name': '#2718: the heading\'s label, a named slot so a declared check can assert WHAT the header says and not merely that it exists. It holds the Homeroom logotype on a platform screen and the app\'s name inside an app (frontend/@/components/ui/wordmark.tsx), so a check that wants the platform case asserts the <svg> rather than text — the mark has no text to match. It replaces #app-switcher-name one-for-one; the id changed because the element is no longer inside a switcher.',
  // #header-subtitle and #header-app-tile are NOT in this map, and that is
  // not an omission. Both render conditionally — the subtitle only on a
  // screen that publishes one, the tile only inside the app view — so
  // neither is in the prerendered document, and this map is for ids that ARE
  // (the check below asserts exactly that). They replace
  // #app-switcher-subtitle, which was absent from here for the same reason.
  //   #header-subtitle: the destination WITHIN the screen the title names —
  //     "Board", "Activity", or a dev session's lifecycle pill — beside the
  //     name on one baseline rather than under it. #header-status-pill is
  //     still its child on a session route, same id, same writer.
  //   #header-app-tile: the open app's own artwork beside its name, which is
  //     what makes the launcher → app step read as one movement. Drawn from
  //     features/improve/improve-store.js, which already carried the name,
  //     icon url and emoji for the panel that used to live in this bar, so
  //     there is no new fetch and no new publisher.
  'back-icon-close': '#2718: the ✕ in the header\'s left slot, shown inside a running app. NOT a fourth name for the chevron — leaving an app is not going up a level, it is stepping out of somebody else\'s program, and every mini-app host in the study draws that as an ✕. Where it LANDS is unchanged (App._appBackHref, so ✕ from a session still returns to that app\'s Workshop): only the glyph knows the difference. It ships `hidden`, like #back-icon-arrow, and each of the three glyphs now names its own mode rather than one of them being "not the other".',
  'switcher-nav': 'The menu\'s destination list, and its ONLY vertical scroller. The app strip above is horizontal and therefore vertically bounded, so no number of apps can push a destination out of reach — the clipping bug that hid Home and Profile on a 39-app account cannot occur in this shape.',
  // ── …and the Apps sheet behind the title tab ─────────────────────
  'apps-switcher-sheet': 'The board\'s Apps sheet — its "Switching between Apps" connector. Reuses the retired #app-context-sheet\'s controller, store and kit bottom-sheet lifecycle.',
  'apps-switcher-overlay': 'Its backdrop.',
  'apps-switcher-close': 'Its close control.',
  // ── Streamlined Concept: the drawer leads with Your apps ─────────
  // ── Andrea's simpler waitlist flow ────────────────────────────────
  // The relocated join question (see RETIRED_IDS above).
  'more-made-url': "The \"link something you've made\" field, relocated from the join form (was #waitlist-made-url).",
  'more-made-note': 'Its one-line description (was #waitlist-made-note).',
  // The doc asks for "Email + verification code". The mailed link still
  // works and confirms the same row; the code exists for the phone, where
  // leaving for the mail app and back loses the WebView's place.
  'waitlist-confirm': 'The confirm-your-email block on the join success state. Hides once the code is accepted.',
  'waitlist-code': 'Six-digit email verification code; confirms the same row the mailed link does.',
  'waitlist-code-submit': 'Submits the verification code.',
  'waitlist-confirm-email': 'The address the code belongs to, asked for only when the confirm step was reached without a join. Hidden after a join, where the form field still holds it.',
  'waitlist-resend': 'Requests a fresh confirmation code (POST /api/public/waitlist/resend). Disabled for the advertised 60-second gap.',
  'waitlist-resend-note': 'The resend result, kept apart from #waitlist-msg so a wrong code and a resend answer cannot overwrite each other.',
  // The share link that replaced the typed rows (see RETIRED_IDS above).
  'more-invite-url': "The signup's shareable invite link; joins through it set waitlist_signups.invited_by.",
  'more-invite-copy': 'Copies the invite link to the clipboard.',
  'more-invite-joined': 'How many people joined through this link. Empty until the stage-2 load effect fills it.',
  // ── The two-step waitlist: each step of the join ends visibly ────
  // The join screen stacked three states in one column and only the middle
  // one ever ended: the pitch stayed up after a join, and a correct code
  // merely HID #waitlist-confirm with nothing taking its place. Five ids,
  // all additive — nothing is retired, so every dapp.json selector on this
  // screen still resolves.
  // #waitlist-step, the "Step 1 of 2" line, left with #5262: the code
  // step carries its own label and way back, and the answer speaks as the
  // waiting room does. Added after the frozen baseline, so it leaves this
  // map rather than entering RETIRED_IDS.
  'waitlist-confirmed': 'The panel that replaces #waitlist-confirm once the six-digit code is accepted. Before it, `confirmed` only removed the block being typed into, and a control that disappears without a word reads as a failure.',
  'more-saved': 'The stage-2 survey\'s ending. A successful save wrote one line into #more-msg and left the whole three-minute form on screen under a heading still asking "Want in sooner?"; this panel takes the screen instead. #more-msg survives for the error and ?connect= cases.',
  'more-saved-edit': 'Returns to that form with every value still in place \u2014 the form is hidden, never unmounted, and answers merge server-side, so adding to them later is the intended path rather than a recovery.',
  'more-saved-back': 'The way out of the ending, to #landing.',
  'more-status-pill': "Where this signup stands in the queue, on the stage-2 form: waiting for confirmation, on the waitlist, or you're in. It is not a new fact \u2014 the row's submitted_at / confirmed_at / released_at have always said this \u2014 it is the first place the person it is about can read it, and it answers the question the survey otherwise leaves open ('I filled this in, then what?'). Present but empty and hidden here by design: the row ships in the markup, and its contents arrive with the stage-2 load effect, because a pill with data in it before the fetch would be a hydration mismatch.",
  // ── #1537: both "you're on the list" surfaces name the address ───
  // Every other fact about a signup was on screen and the one people wrote in
  // about was not: which address they had used. Both ids are always in the
  // markup and `hidden` until there is an address to name, the same contract
  // #more-status-pill above documents — a line that reads "Registered with"
  // and then stops is worse than no line.
  'waitlist-confirmed-email': 'The address inside #waitlist-confirmed, on the join flow. Read from the same client-side value the confirm step already echoes, so no request was added; it is stored lower-cased now, matching what the server normalizes and stores, so this surface and the stage-2 one cannot disagree about the same address.',
  'more-signup-email': "The address on the stage-2 form at #more/<token>, beneath the queue pill. This screen is where the mailed confirm link lands, so it is the surface a RETURNING visitor sees, and it has no client-side memory of the join to read — the value is a new `email` field on the full GET /api/public/waitlist/more/:token payload, which discloses nothing: the 48-hex token is only obtainable by joining with that address or receiving the join mail at it. Plain text, never a mailto: anchor.",
  // ── #1372: the mobile-browser install strip ──────────────────────
  // A visitor on a phone browser is offered the native app. The strip is
  // always in the document and starts `hidden` (the island rule: data loads
  // in effects, so the first render must match the prerender), which is why
  // these ids are present here even on a build where no store listing has
  // been published and the strip can never show.
  'mobile-install-banner': 'The phone-browser strip offering the native app (#1372). Sits under #offline-banner and stacks with it.',
  'mobile-install-open': 'The strip\'s primary control. An anchor to the store when a listing is published for this OS (href from app_version_configs.update_url via GET /api/public/mobile-app); a button revealing the Add-to-Home-Screen steps when none is (#1513).',
  'mobile-install-dismiss': 'Dismisses the strip for this session; the answer is kept in sessionStorage, so the next visit is offered the app once more (#1514).',
  // #2255 — the eight-step welcome tour, and the two ids it took off the
  // list. #1561's `#home-welcome` / `#home-welcome-dismiss` stood here: the
  // once-per-account explainer at the top of #home-body. They are NOT in
  // RETIRED_IDS, because that map is for ids the frozen baseline records and
  // these two were added after it; a declared id that is no longer in the
  // document is removed from THIS map, and the test below fails on a stale
  // entry either way.
  //
  // The tour replaces the banner rather than joining it. The banner said the
  // two things the launcher never says and then went for good; the tour says
  // the same two things in its first step and then POINTS at the four places
  // the banner could only name (Create app, Improve and what is behind it,
  // Challenges, and the way back to Settings). Like the install strip above
  // it is always in the document and starts `hidden`, because the viewer is
  // not known at prerender time.
  'home-tour': 'The welcome tour overlay, mounted from Shell.tsx and hidden until the first sign-in that reaches Home (#2255).',
  // The dim is FOUR panels tiling the viewport minus the hole, not one
  // box-shadow. A shadow paints but receives no pointer events, so it cannot
  // block a click -- and the Improve step needs exactly that split: the
  // cut-out passes the press through to the real Improve control while the
  // dimmed area keeps swallowing clicks.
  'home-tour-shade-top': 'The dim above the cut-out, and the whole screen on a step with nothing to point at.',
  'home-tour-shade-right': 'The dim to the right of the cut-out.',
  'home-tour-shade-bottom': 'The dim below the cut-out.',
  'home-tour-shade-left': 'The dim to the left of the cut-out.',
  'home-tour-spotlight': 'The cut-out\'s outline. It blocks the press on a step that only describes its target and passes it through on the Improve steps, which press real controls.',
  'home-tour-card': 'The tooltip card, positioned against the cut-out and re-measured on resize and scroll.',
  'home-tour-body': 'The card\'s step half. Hidden while the Skip question is up.',
  'home-tour-counter': 'The "3 of 8" step counter.',
  'home-tour-title': 'The step heading, and the card\'s accessible name.',
  'home-tour-text': 'The step copy.',
  'home-tour-skip': 'Skip, offered on every step.',
  'home-tour-back': 'Back, disabled on step 1.',
  'home-tour-next': 'Next, and Finish on the last step.',
  'home-tour-confirm': 'The Skip question. Hidden until Skip or Escape.',
  'home-tour-confirm-text': '"Are you sure? You can reopen this from Settings."',
  'home-tour-confirm-cancel': 'The way back out of the question.',
  'home-tour-confirm-skip': 'Confirms the skip, which records the tour as finished for this account.',
  // The other half of the tour's promise: Settings -> Welcome tour.
  'settings-tour-section': 'Settings -> Welcome tour, the pane holding the replay control (#2255).',
  'settings-tour-replay': 'Clears this account\'s "finished" flag, asks for the tour and goes to Home.',
  'settings-tour-hint': 'The line under it saying where the tour starts.',
  // #1281 — the session-CLI bridge opt-in. The spec marks that venue
  // settings-gated and "most users: no", so the gate needs somewhere to
  // live: Settings → Experimental, beside the other per-user preview flag.
  'session-bridge-enabled': 'Opt-in switch for the session-CLI bridge venue (#1281).',
  'session-bridge-status': 'Save/error line for the session-bridge switch (#1281).',
  // Username changes — Settings -> Username, the change-your-@handle form. It sits in
  // Settings rather than the profile edit sheet because the endpoint requires
  // the current password, which is the same reason Change password is here.
  'change-username-section': 'Settings -> Username section wrapper.',
  'cu-current': 'The handle the viewer holds right now, painted by Settings._renderChangeUsernameSection.',
  // The `cu-` prefix mirrors the `cp-` one the change-password controls
  // beside them have always used — and stays clear of the native kit's
  // `.un-*` class vocabulary.
  'cu-new': 'Requested new handle.',
  'cu-password': 'Current password, required by POST /api/me/username.',
  'cu-save': 'Submit for the username change.',
  'cu-status': 'Status line for the username change.',
  'settings-mobile-push-preferences': 'Account-level Social mobile-push category controls in Settings → Alerts.',
  // (#1412's #improve-version-dot came and went: the Streamlined Concept
  // returned the version cue to the hamburger under its original
  // #header-menu-deploy-dot id — see the note in RETIRED_IDS.)
  'cli-setup-guide': 'Always-visible local-agent setup in Settings → CLI access (#1609). It is static section markup so capability detection and credential-list state cannot blank the instructions.',
  'native-app-version-slot': 'Mobile app version/build rendered through the native bridge (#1101).',
  'feedback-queue-dot': 'Header dot for feedback saved offline and still waiting to send (#1054). It has changed parents twice without changing id or writer — off the retired #feedback-btn onto #improve-btn, and off that onto the Homeroom mark when #2718 retired it — because it belongs on whichever control is the way to this dialog from the header. Bottom-left, opposite the working dot.',
  'feedback-screenshot-picker-btn': 'Photos fallback for mobile feedback screenshots (#824).',
  'feedback-screenshot-input': 'PNG/JPEG picker backing the mobile feedback fallback (#824).',
  'feedback-screenshot-count': 'How many images fit and how many are attached (#3027: "You can attach up to 3 images.", "2 of 3 images attached."). Ships empty and hidden like #feedback-status; the controller fills it on every open and every add or remove.',
  // ── #1603: the description's requirement, said out loud ─────────
  // The field was always mandatory — submitFeedback returned early on an
  // empty one — but nothing on screen said so and the refusal was a bare
  // `return`, so Submit read as broken. Four additive ids: two that state
  // the rule before you type, one that states it back on the field when it
  // is broken, and one naming the field that is NOT required, because
  // marking one of two fields required only reads as a rule if the other's
  // silence is deliberate rather than an omission.
  'feedback-text-label': 'The Description label on #feedback-text, which had a placeholder and no label at all. Also the anchor the declared check selects the asterisk through, so the marker is asserted where a reader would look for it rather than anywhere on the card.',
  // #feedback-text-required, the red asterisk in the description's label
  // (#1603), left with the label's old words: "What should change?" is plainly
  // the one thing the request needs (UI overhaul). aria-required on the field
  // and the refusal under it are unchanged.
  'feedback-target-label': 'UI overhaul: "Where should this go?", the Suggest an improvement dialog\'s label for its destination row (#feedback-target is aria-labelledby it). It asks the question the grey #feedback-target-hint used to; the hint is only the refusal now.',
  'feedback-target-app-name': 'UI overhaul: the app option\'s first line, the app\'s NAME ("Run Club"), written by feedback-controller.js on each open ("This app" with no name, "No app open" with no app). It was the whole button\'s text, "This app (Run Club)".',
  'feedback-target-app-sub': 'UI overhaul: the app option\'s second line, "This app", mirroring the platform option\'s "Homeroom / The platform itself". The controller hides it when the first line already says "This app".',
  'feedback-text-error': "The inline refusal under the description: \"Please add a description.\" Deliberately its OWN node rather than a fifth writer of #feedback-status, which has an explicit newer-and-more-specific-wins rule (paintQueueState) that would either swallow this message or let it erase the offline hint. Ships empty and hidden, like #feedback-status: the controller owns the text, and a message rendered before the submit that earns it would both lie on open and mismatch on hydration.",
  'feedback-title-label': 'The Title label, marked optional. The title generates itself from the description and the server names the issue when it is blank, so its emptiness is a working state - which is worth saying next to a field that is now visibly required.',
  // ── THE UI OVERHAUL: the Improve panel ───────────────────────────
  // One surface for everything you do *to* the app on screen rather than
  // *with* it. It absorbed four header controls (see RETIRED_IDS above)
  // plus the drawer's Share action. Fully React-owned,
  // so unlike most of the shell it holds real state — nothing in
  // public/js/** writes a node inside it.
  // #improve-btn LEAVES THIS MAP rather than entering RETIRED_IDS, because the
  // frozen baseline never recorded it: the UI overhaul added it, #2718 removed
  // it, and the baseline is untouched either way. It was the header's filled
  // violet "Improve" pill, between the bell and the mark. The panel it opened
  // is reached from #app-menu-row-improve below; its glyph and both its dots
  // kept their ids and are listed here still, on the row and on the mark.
  'improve-row-feedback': 'Opens the feedback dialog — the retired #feedback-btn. The Homeroom menu\'s one button since the UI overhaul, "Suggest an improvement".',
  'improve-quick-actions': 'The panel\'s three circular actions — Feedback, New change, Share — captioned beneath so three fit across a phone.',
  // #improve-version-dot is NOT here any more, and did not move: it is
  // retired. Amber while a build was deploying or downloading, violet once
  // one was here to reload onto — and the button's LEADING GLYPH already
  // draws the spinner for exactly the amber pair and the arrow-path for
  // exactly the violet one, off the same `versionState`. Two cues for one
  // fact, one of them 8px of colour whose meaning depends on which colour
  // it is. `Improve.setVersionState` and the store field stay; the second
  // renderer is what went. It never reached tests/baselines, so it leaves
  // this map without entering RETIRED_IDS.
  // #improve-row-new-session and #app-menu-sessions LEAVE THIS MAP rather
  // than entering RETIRED_IDS, because the frozen baseline never recorded
  // either: the UI overhaul added them to the prerender, and the
  // first-session run-through (5 Oct 2026) took them out of it. They are
  // the Homeroom menu's Agent chats section (it was "Continue", then "Agent
  // sessions", then "More") and the Build it now row that leads it,
  // same ids, same call. The section is shown only to somebody who has had
  // an agent session, which is their own data, known after mount
  // (app-context-sheet.tsx AgentChats), so the prerender draws nothing
  // there, as it never drew the sessions inside it. dapp.json's checks
  // select both in the open menu, as a viewer with sessions.
  'settings-theme-section': 'The Theme settings pane\'s inner node, matching every other section\'s wrapper/inner pair.',
  // ── THE UI OVERHAUL: the home screen's four areas ────────────────
  // Your apps, Discover, Challenges, Create app — stacked, in that order.
  // The last three were draggable widgets on the launcher canvas; each is a
  // fixed <section> host now, carrying the same `data-panel-slot` key its
  // grid host did so the dapp.json checks still select on it.
  'home-apps-section': 'Wraps the launcher grid and its "Show all" control, so area 1 is a section like the others.',
  'home-apps-more': '"Show all N apps" — revealed only when a viewer has more than the two-row default shows. The cap is on what is DRAWN, never on what they may have.',
  'home-discover-section': 'Area 2: featured tiles, the Popular lane and the way into the app directory.',
  'home-challenges-section': 'Area 3: the season\'s open challenges, and under them the leaderboard standings the retired #drawer-row-leaderboard used to point at.',
  // #home-create-section (area 4) left this map when Create moved into the
  // launcher grid; it is recorded in RETIRED_IDS.
  // #1082 chunk E — the admin console's CHASSIS. These ids are not new to the
  // running page: admin-console.js._renderShell() has always created them, by
  // writing #admin-root.innerHTML on every open. They are new to
  // public/index.html because the chassis is React-owned markup now, so it is
  // prerendered instead of assembled at mount. Nothing below them moved —
  // #admin-section-content is still an innerHTML host owned by the module.
  'admin-nav-desktop': 'Admin console desktop sidebar host, empty until AdminConsole._renderShell fills it (#1082).',
  'admin-view-only-banner': 'Admin console view-only banner (#311), ships hidden and is toggled through classList (#1082).',
  'admin-section-content': 'Admin console section host — the phone level-1 menu and every section render into it (#1082).',
  'admin-temp-pw-modal': 'Admin console temporary-password dialog root (#282), now static React markup (#1082).',
  'admin-temp-pw-username': 'Recipient name in the temporary-password dialog (#1082).',
  'admin-temp-pw-value': 'The one-time plaintext temporary password (#1082).',
  'admin-temp-pw-copy': 'Copy button in the temporary-password dialog (#1082).',
  'admin-temp-pw-close': 'Done button in the temporary-password dialog (#1082).',
  // #1085 chunk H, step 2 — the ONE new id in the chunk. #app-content keeps its
  // id, its classes and its role as a hand-written innerHTML host; the embedded
  // app's iframe moves out from under it into this React-owned sibling, because a
  // region may only become stateful when its whole subtree is React-owned and
  // #app-content is written by half of public/js/**. Ships hidden and empty, so
  // the prerendered document is unchanged in what it renders. Exactly one of the
  // two is visible; both are flex-1 + min-height:0 children of #app-view's
  // column flex, so the visible one gets the box #app-content used to have.
  'app-frame-host': "React-owned host for the embedded app's #app-iframe, a hidden empty sibling of #app-content (#1085).",
  // #1218 follow-up — the "Stop the permission prompts" block in
  // Settings → Connectors. Static markup with a copy button, the same shape
  // as #connector-url / #connector-url-copy directly above it. It exists
  // because the scaffolded .claude/settings.json fixes one repo at a time and
  // the user's personal ~/.claude/settings.json is the only thing that fixes
  // every repo at once — so the block has to be somewhere they can copy it.
  'connector-prompt-help': 'Settings → Connectors block explaining how to stop the per-call connector permission prompts (#1218).',
  'connector-allow-rules': 'The three read-only allow rules, rendered for copying into a personal ~/.claude/settings.json (#1218).',
  'connector-allow-rules-copy': 'Copy button for that block (#1218).',
  // #1607: the two product walkthroughs below the connector URL are six and
  // seven steps, and the reported cost was reading them. These open a new
  // chat pre-loaded with the server URL and the job, so the assistant that
  // will use the connector answers "where is that button" instead. The href
  // is written by Settings._renderConnectors() from the live #connector-url
  // value, never hardcoded, so a fork shows its own.
  'connector-open-claude': 'Settings → Connectors link opening a pre-loaded Claude chat to walk through connector setup (#1607).',
  'connector-open-chatgpt': 'The same for ChatGPT (#1607).',
  // The in-chat setup tip fired once in production and locked itself out, and
  // the panel it points at had one flaw of its own: a single block headed "add
  // this to ~/.claude/settings.json", which is the wrong file for Claude Code
  // on the WEB — that container is built fresh, so nothing from the user's
  // machine is in it and only the repo's committed copy travels. So the block
  // became three labelled cases with a second copy block for the per-repo
  // file, plus a read-only line reporting the tip's own throttle state.
  //
  // The three case ids are toggled by Settings._renderConnectorCases() and
  // render VISIBLE, so a client name it cannot classify — or a page whose
  // script has not run — shows every case rather than none.
  'connector-case-cc-local': 'Settings → Connectors case for Claude Code on the user\'s own machine (personal settings file).',
  'connector-case-cc-web': 'Settings → Connectors case for Claude Code on the web, where only the repo\'s committed file travels.',
  'connector-case-chat': 'Settings → Connectors case for Claude.ai chat and ChatGPT, which have no per-call prompts to stop.',
  'connector-repo-allow-rules': 'The same three rules, rendered for committing as a repo\'s .claude/settings.json.',
  'connector-repo-allow-rules-copy': 'Copy button for the per-repo block.',
  'connector-hint-status': 'Read-only status of the in-chat setup tip; ships empty and hidden, filled by Settings._renderConnectorHint().',
  // A permission rule names the MCP server LITERALLY — there is no
  // `mcp__*__` — so a connector registered under any name but the one the
  // shipped rules were written for matches none of them, prompts on every
  // read, and produces no error saying why. Usernode now ships both
  // spellings it can predict (`usernode` and `Usernode`); this field covers
  // everything it cannot, because the user is the only party in the exchange
  // who can see what their tools are actually called. Typing a name rewrites
  // BOTH blocks above in place, so the copy buttons already there pick up the
  // corrected rules — hence a field and no button of its own.
  'connector-name-spelling': 'Settings → Connectors input that rewrites both allow-rule blocks for a connector registered under a different server name (#1222 follow-up).',
  // #1892: only Claude and ChatGPT had a walkthrough. The Codex CLI gets one
  // with the two copyable forms its setup takes (the `codex mcp add` command
  // and the ~/.codex/config.toml entry), and any other MCP client gets the
  // transport, auth-discovery, callback and tool-name facts the product
  // walkthroughs leave implicit. The pre blocks ship with a URL placeholder
  // that Settings._renderConnectors() swaps for the live connector URL.
  'connector-setup-codex': 'Settings → Connectors walkthrough for the Codex CLI (#1892).',
  'connector-codex-add': 'The `codex mcp add homeroom --url …` command, URL filled in at render time.',
  'connector-codex-add-copy': 'Copy button for the Codex command.',
  'connector-codex-config': 'The `[mcp_servers.homeroom]` entry for ~/.codex/config.toml, URL filled in at render time.',
  'connector-codex-config-copy': 'Copy button for the config.toml entry.',
  'connector-setup-generic': 'Settings → Connectors walkthrough for any other MCP client or agent (#1892).',
  'messages-create-dialog': 'React-owned direct/group conversation creation dialog (#488).',
  'messages-members-dialog': 'React-owned group membership and invitation dialog (#488).',
  'messages-share-dialog': 'React-owned typed Homeroom item chooser for Messages (#488).',
  // #3660: a card's ⋯ menu said "Share to Messages" and took the sharer to
  // the Messages screen to pick a conversation and attach the card there.
  // Share to… is one dialog instead, mounted beside the Messages dialogs.
  'share-to-dialog': 'React-owned Share to… dialog (#3660): pick a DM, a group, #general or an app\'s discussion, and the card is posted there (features/messages/share-to-dialog.tsx).',
  'notifications-saved': 'Pinned "Saved" section at the top of the bell drawer, holding the messages this user bookmarked (#1280).',
  // #1344 — eligible users may claim one company-funded OpenRouter key.
  // These are static settings controls; settings.js owns their state. The
  // four plaintext reveal controls originally added here were removed when
  // company-funded credentials became internal-only; like other post-baseline
  // ids, they leave this map rather than entering RETIRED_IDS.
  // #2568 replaced the claim card with a status line: the key exists
  // before anybody opens this screen, so #settings-openrouter-managed-card,
  // #settings-openrouter-managed-message and #settings-openrouter-claim
  // went with the act of claiming. They were never in the baseline (they
  // arrived with #1344, after it was cut), so they leave this map rather
  // than entering RETIRED_IDS.
  'settings-openrouter-included': 'Included OpenRouter key status card (#2568) — the key\'s state, its last four and its allowance, with nothing to press.',
  'settings-openrouter-included-status': 'The sentence inside it, written from the credential and managed-key state (#2568).',
  'settings-openrouter-personal-controls': 'Personal-BYOK controls hidden while a managed key owns the credential slot (#1344).',
  // #1383's Sort control moved into the Filters sheet, which is mounted on
  // reveal and never ships in the prerender, so its ids left this map with
  // it: 'browse-sort-bar' and 'browse-sort-select' are retired.
  // ── Streamlined Concept: the Board Filters dialog ────────────────
  // The Figma board (Streamlined Concept / Dev Sessions and Navigation)
  // moves the Board's filter selects and the needs-vote toggle off the
  // filter bar into a dialog; the bar keeps search and gains a
  // `Filters (n)` chip plus dismissable active-filter chips (those are
  // runtime-injected, so only the dialog's ids land in the shell).
  'board-filters-modal': 'The Filters dialog root — tenth shell dialog, same useDialog/static-modal contract as the nine.',
  'board-filters-priority': 'Priority select inside the Filters dialog (was #dev-kanban-priority on the bar).',
  'board-filters-category': 'Category select inside the Filters dialog (was #dev-kanban-category on the bar).',
  'board-filters-assignee': 'Assignee select inside the Filters dialog (was #dev-kanban-assignee on the bar).',
  'board-filters-needsvote': 'The "Needs my vote" switch inside the Filters dialog (was the bar chip #dev-kanban-needsvote).',
  'board-filters-done': 'The dialog\'s Done button — applies the staged filters via AppView.applyKanbanFilters.',
  // ── Streamlined Concept: the app-context sheet ───────────────────
  // The surface behind the header's "app name ⌄" tab: the app's three
  // views, its changes in progress/elsewhere, and the reference footer
  // (which moved here from the Improve panel keeping its ids).
  // ── Streamlined Concept: the full-screen Notifications view ──────
  // A real screen behind the drawer's Notifications row, on the Messages
  // screen's fully-React pattern: All | Unread tabs, Today/Earlier
  // sections, avatar-initial rows. Renders from the same notifications
  // store as the drawer's list.
  'notifications-sheet': 'The Notifications SHEET root. It was #notifications-screen, a screen root in App.SCREEN_IDS — but the bell is in the header on every route, so a full-screen view had to answer "back to where?" and answered "home", wrong every time it was opened from anywhere else. A sheet presents over the current screen and dismisses back to it.',
  'notifications-sheet-overlay': 'Its backdrop.',
  'notifications-sheet-close': 'Its close control — the desktop slide-over needs a visible dismiss, as the Apps sheet has.',
  'notifications-screen-tabs': 'The sheet\'s sticky Unread | All tab row (#5289 took Messages out). Keeps the `-screen-` id it was born with: the declared checks select on it, and renaming a node that did not move would be churn. It no longer carries Mark-all-read — see #notifications-screen-mark-all below.',
  'notifications-tab-unread': 'The sheet\'s FIRST tab, and the one it opens on. All led for a round, which meant opening an inbox on everything you had already read: the bell is tapped because it has a count, and the count is the unread.',
  // (#notifications-see-older and #notifications-hide-older, the Unread
  // footer's reveal and collapse pair, are NOT here: they render only when
  // there is something more to see — rows the Unread filter is hiding, or
  // another server page — and the prerendered sheet has no rows at all. The
  // Unread footer stays on Unread (#4700); its counterpart
  // #notifications-load-older, the real pager, renders on All and under an
  // expanded Unread.)
  'notifications-tab-all': 'The whole archive, LAST: the count you came for, then the archive holding it, and it is the only tab that pages more rows in on its own cursor. The Unread footer\'s reveal stays on Unread (#4700).',
  // #notifications-tab-messages, the sheet's Messages filter, leaves this
  // map (it was never in the baseline). #5289: it repeated the Messages tab
  // in the bar, which lists the same conversations and the agents beside
  // them; its 'All messages' row and its pager went with it.
  'notifications-screen-mark-all': 'Mark-all-read on the sheet — same controller action as the drawer\'s #notifications-mark-all, React-wired instead of id-bound. Same naming note as the tab row above. It sat at the far RIGHT END of that tab row, in tab-sized ink on the same baseline as the three tabs, so a control that changes data read as a fourth place to go; it is a row UNDER the Unread tab now, with the list it empties, and renders nowhere else.',
  // #global-chat-screen and #global-chat-composer left this map when
  // Global Chat (#2377, #2543) was removed with its screen. They were only
  // ever ADDED ids, so they simply leave.
  // ── #2779: agent sessions (on for everyone; the Experimental pane's
  //    switch and its status line are retired and left this map) ──
  'agent-session-screen': '#2779: the React-owned agent session screen, one conversation with the Mayor that works on any app. Ships hidden and empty for hydration parity; the hash router reveals it at #agent/<id>, and App.REACT_SCREEN_IDS keeps its visibility single-owned. Everything inside it renders only once a conversation is open, so the root is its one static id.',
  // ── #2707: the feedback destination is chosen, never assumed ────
  'feedback-target-hint': 'The line under the Send Feedback destination row. With both destinations selectable nothing is preselected any more, so Submit is disabled until one is tapped — and a control that refuses without saying why is the dead button #1603 fixed one field down. Ships empty and hidden (the controller owns the text, and the one-destination case never shows it), and carries the radiogroup\'s aria-describedby while it is up.',
  // ── #2718 REVIEW: the Improve panel retired, and ten ids with it ─────
  //
  // These were added by this branch and by the two chunks before it, so they
  // leave this map rather than entering RETIRED_IDS — the frozen baseline
  // never had them, and an id the baseline never had cannot be retired from
  // it. Listed here as a group so the removal reads as one decision:
  //
  //   improve-panel, improve-overlay, improve-body, improve-sessions,
  //   improve-footer, improve-target-name, improve-close
  //       The drawer itself: its root, its backdrop, its scroller, the
  //       changes in flight, the reference footer, the app name in its title
  //       bar and the control that shut it. The sessions became the
  //       Workshop's and the notifications sheet's Agents tab, the footer's
  //       facts became the menu's About pane, and what was left was two
  //       buttons behind a tap — so the buttons moved up into the menu
  //       (#improve-quick-actions, still here) and the drawer went.
  //   app-menu-row-improve, improve-btn-glyph
  //       The row that opened it and the three-state glyph that row carried.
  //       The glyph's states are the mark's two dots (#feedback-queue-dot,
  //       #improve-working-dot), which are on screen on every route rather
  //       than inside a closed menu.
  //   app-menu-row-workshop
  //       "Open in Workshop". Retired here in favour of the view strip's
  //       Workshop segment, and back as "Go to workshop" when the strip
  //       retired in turn (#2761) — so it is in the map above again.

  // ── The side panel beside a running app (features/side-panel/) ──────
  // On a desktop-width window, the app's Workshop, its discussion, messages,
  // agent chats, proposals and issues open in a panel BESIDE the running app
  // instead of replacing it. The panel is one React island, placed after the
  // app view; it ships hidden and frameless, and its <iframe> (the platform
  // itself at /?panel=1#<route>) exists only while a panel is open, so the
  // frame's id is not in the static markup.
  'platform-side-panel': 'The side panel\'s root — an <aside> named by its title, shown only while a panel page is open beside a running app on a desktop-width window. Its presence also sets html[data-side-panel], which narrows #app-view by the panel\'s width instead of hiding or moving the app\'s frame.',
  'side-panel-back': 'The panel\'s Back: climbs the pages opened in the panel, then to the list the page belongs to (a discussion or a message to Messages; a proposal, an issue or a change to the app\'s Workshop). Ships hidden, because a freshly opened list has nowhere to climb to.',
  'side-panel-title': 'The panel\'s title — the page\'s own header title as the panel\'s document reports it, and the aside\'s accessible name.',
  'side-panel-expand': 'Expand ("Open full width, leaving the app"): the page the panel is showing, full width, as one ordinary navigation of the top window — which closes the app and parks it, so Resume brings it back.',
  'side-panel-close': 'Close ("Close panel"): closes only the panel; the app keeps running beside where it was.',
  'side-panel-body': 'The panel\'s body: the one <iframe> of the panel\'s document (#side-panel-frame, rendered only while open, so absent here) and the loading spinner after it.',
  'side-panel-loading': 'The spinner shown over the panel\'s body until its document has booted and drawn its first page. Ships hidden.',
  // ── Discover's view switch, type row and Filters button ────────────
  'browse-view-switch': 'The For you / Browse / Joined switch under Discover\'s search field. It replaced the All / Featured / Not joined / Joined / New chip row; the store\'s prerender value (For you) is the pressed part.',
  'browse-type-row': 'The always-drawn row holding Discover\'s app-type chips and the Filters button at its end. It is rendered even when no project has a type, because the Filters button lives here and must stay reachable.',
  'browse-filters-btn': 'The Filters button at the end of Discover\'s type row. It opens the Filters sheet, and carries data-active-count (the number of filters on) only when one is on.',
  // The prototype's History segment (#leaderboard-history-root, added above
  // as the Leaderboard screen's fourth pane) retired with the seasons it
  // listed (the Semi design, 2026-10-16); #leaderboard/seasons lands on
  // Challenges. It was never in the baseline, so it leaves this map rather
  // than entering RETIRED_IDS.
  'side-panel-divider': '#2886: the divider between the running app and the panel, as a handle on the panel\'s left edge — a vertical `separator` that drags (or takes the arrow keys, Home and End) to share the window differently, keeping at least 320px of panel and 480px of app, remembers the chosen width on this device, and resets to the default on a double-click. Ships with no value: the width is read in an effect, never in the first render.',
  // The channels moved out of Messages onto their communities' hubs, so the
  // Channels filter (#2783, added above as messages-filter-channels) is gone
  // with the section it narrowed to; it was never in the baseline.
  'platform-tabs-badge-communities': 'The Communities tab\'s quiet count: how many of your communities\' channels (#general, Homeroom\'s, among them) have unread messages. The channels live on each community\'s hub now rather than in Messages, so the count moved with them. Rendered always, hidden at zero, for the same reason as #platform-tabs-badge.',
  // ── The settings restructure: Account opens with a Profile part ─────
  'settings-profile-section': 'The Profile part at the head of Settings\' Account page (features/settings/sections/profile.tsx): who is signed in, and the way to Me\'s Edit profile sheet, where name, photo, bio and the public page are edited. Settings had no route to that sheet, so someone who came to Settings to change their name found only the username form. A settings-pane root with a stable id, like its siblings; it mounts on reveal, never in the prerender.',
  'settings-profile-card': 'The Profile part\'s one control: an anchor to #profile?edit (features/profile/profile.js opens the Edit profile sheet off that address, as #profile?friends opens Friends), showing the avatar, the name and the @handle. dapp.json selects on it to pin that a bare #settings now opens Account.',
  // ── #3940: Send Feedback takes one video clip ──────────────────────
  // Three ids beside the screenshot pickers in the attachment row. The
  // button and the hidden file input mirror #feedback-screenshot-* (the
  // picker is a native surface, so the input never renders); the preview
  // row's one item is built by feedback-controller.js, like the screenshot
  // thumbnails, so it carries no id of its own.
  'feedback-video-btn': '#3940: the Video row of the paperclip popover (#4127; label becomes Replace video once a clip is attached). dapp.json\'s feedback check selects on it.',
  'feedback-video-input': '#3940: the hidden video file input behind the button (MP4, WebM and MOV).',
  'feedback-video-preview': '#3940: the clip preview row (first-frame thumbnail, progress bar, status, remove), empty and hidden until a clip is chosen.',
  // ── #4891: Settings offers "Add a password" to an account with none ───
  // Each pair is rendered once (features/settings/sections/password.tsx) and
  // settings.js _setChangePasswordMode shows the one that fits, as it does
  // #cp-current-row: the email sign-up no longer asks for a password, and
  // sends the person here to add one.
  'cp-title-change': '#4891: the Password part\'s "Change password" title, shown to an account that has a password.',
  'cp-title-add': '#4891: its "Add a password" title, shown instead to an account that has none and signs in with an emailed code.',
  'cp-save-change': '#4891: #cp-save\'s "Change password" label, beside its "Add password" one.',
  'cp-save-add': '#4891: #cp-save\'s "Add password" label, for an account with no password yet.',
  // ── #5281: the Account page's sign-in rows read first ────────────────
  // Username and Password each became a row (what it is, what it holds) with
  // a Change link, and their forms open under the row only when asked
  // (features/settings/sections/username.tsx, password.tsx). settings.js
  // binds the links and Cancels by id and opens one form at a time
  // (_openAccountEditor). An account with no password confirms a rename with
  // an emailed code instead of the password it does not have.
  'cu-edit': '#5281: the Username row\'s Change link, which opens #cu-form.',
  'cu-form': '#5281: the change-username form under its row, shipped hidden.',
  'cu-cancel': '#5281: closes #cu-form.',
  'cu-password-row': '#5281: wraps #cu-password, shown to an account that has a password.',
  'cu-code-row': '#5281: the emailed-code confirmation, shown instead to an account with no password.',
  'cu-code': '#5281: the six-digit code POST /api/me/username takes from an account with no password.',
  'cu-send-code': '#5281: emails that code (POST /api/me/username/code).',
  'cp-edit': '#5281: the Password row\'s Change (or Add) link, which opens #cp-form.',
  'cp-edit-change': '#5281: #cp-edit\'s "Change" label, for an account with a password.',
  'cp-edit-add': '#5281: #cp-edit\'s "Add" label, for an account with none.',
  'cp-state-set': '#5281: the Password row\'s "Set" line.',
  'cp-state-unset': '#5281: its "Not set" line, for an account that signs in with an emailed code.',
  'cp-form': '#5281: the change-password form under its row, shipped hidden.',
  'cp-cancel': '#5281: closes #cp-form.',
  // ── D (18 Oct 2026): the desktop's sidebar of rows ──────────────────
  // From 1024px the rail lists your communities itself (features/nav/
  // rail-communities.tsx), between Messages and the Communities tab, which is
  // their All row there; app.css draws none of it on the strip or the
  // phone's bar. The heading and its search ship in the document; the five
  // rows arrive with the community list, so they carry no ids.
  'platform-rail-communities': 'D: the sidebar\'s Communities section (role=group), between #platform-tab-messages and #platform-tab-workshop. dapp.json pins the bar order through it.',
  'platform-rail-communities-label': 'D: the section\'s "Communities" heading, which names the group.',
  'platform-rail-conversations': 'v3: the conversations nested under Messages in the sidebar of rows, right after #platform-tab-messages; an empty element while shut, so the bar\'s order is one order. dapp.json pins it there.',
  // 18 Oct 2026: the communities you pinned, under their own heading above
  // yours (features/nav/rail-pinned.tsx). Each community's app is a row
  // under it now, so #platform-strip-apps, the strip's Pinned and Recent
  // apps (#4417), went: a pin is a community's. It ships hidden with its
  // heading and no rows; the pins arrive from localStorage after mount.
  'platform-rail-pinned': 'The sidebar\'s Pinned section (role=group), between #platform-rail-conversations and #platform-rail-communities, hidden while nothing is pinned. Home\'s drag recognizer drops a My apps tile on it; dapp.json pins the bar order through it.',
  'platform-rail-pinned-label': 'The section\'s "Pinned" heading, which names the group.',
  'platform-rail-search': 'D: the search beside that heading, shown on hover or focus: All communities with its search box focused and lit (features/workshop/communities-search.ts). dapp.json selects on it.',
  'workshop-search': 'D: the search at the head of All communities (features/workshop/index.tsx), at every width since #5296: your communities by name, in the one list. Prerendered empty.',
};

test('the shell still carries every id in the frozen baseline', () => {
  // The baseline was taken from main's hand-written markup at the point the
  // fixture was retired. It is asserted anyway: a SILENT drop (a truncated
  // JSON write, a bad merge) would otherwise make the comparison below
  // vacuous.
  assert.equal(
    baseline.ids.length, 444,
    `tests/baselines/shell-markup.json has ${baseline.ids.length} ids, not the expected 444. The `
    + 'baseline is frozen — record deliberate changes in RETIRED_IDS / ADDED_IDS rather than '
    + 'refreshing it.',
  );

  const actual = new Set(idsOf(withInteriors));
  const missing = baseline.ids.filter((id) => !actual.has(id) && !(id in RETIRED_IDS));

  assert.deepEqual(
    [...new Set(missing)], [],
    `${new Set(missing).size} element id(s) disappeared from public/index.html and from every `
    + 'mount-on-reveal interior. public/js/** looks these up by getElementById and dapp.json '
    + 'selects on them, so each one is a broken screen. If a removal is intentional, add it to '
    + 'RETIRED_IDS with a reason in the same commit.',
  );
});

test('the shell has not grown ids nobody declared', () => {
  const expected = new Set(baseline.ids);
  const added = [...new Set(idsOf(withInteriors))].filter((id) => !expected.has(id) && !(id in ADDED_IDS));
  assert.deepEqual(
    added, [],
    'public/index.html gained element id(s) the baseline does not have. A new id is fine, but '
    + 'declare it in ADDED_IDS with a reason so the inventory stays a deliberate list.',
  );
});

test('a retired id is really gone, and an added id is really there', () => {
  // Keeps the two maps honest: a stale entry that no longer describes the
  // markup is a hole in the inventory, not a harmless leftover.
  const actual = new Set(idsOf(withInteriors));
  for (const id of Object.keys(RETIRED_IDS)) {
    assert.ok(
      !actual.has(id),
      `#${id} is listed in RETIRED_IDS but is still in public/index.html — drop the entry.`,
    );
  }
  for (const id of Object.keys(ADDED_IDS)) {
    assert.ok(
      actual.has(id),
      `#${id} is listed in ADDED_IDS but is not in public/index.html — drop the entry.`,
    );
  }
});

// Ids that appear more than once in the hand-written shell. getElementById
// returns the first match, so a duplicate is latent breakage — but these
// predate the React chassis swap and fixing one is a behavioural change to a
// live screen, which the scaffolding steps must not make. They are pinned
// here so the count can only go DOWN, and so a chunk converting either screen
// has the problem in front of it.
//
//   wallet-status — one in the Settings screen's wallet-link row, one in the
//   anonymous login screen's wallet sign-in block. Only one is ever mounted
//   at a time in practice, which is why this has never bitten.
const KNOWN_DUPLICATE_IDS = { 'wallet-status': 2 };

test('no id is used twice beyond the duplicates that predate this migration', () => {
  const seen = new Map();
  for (const id of idsOf(withInteriors)) seen.set(id, (seen.get(id) || 0) + 1);
  const duplicates = Object.fromEntries([...seen.entries()].filter(([, n]) => n > 1));

  assert.deepEqual(
    duplicates, KNOWN_DUPLICATE_IDS,
    'the set of duplicated element ids in public/index.html plus the mount-on-reveal interiors '
    + 'changed. getElementById returns the '
    + 'first match, so a NEW duplicate silently binds handlers to the wrong element — and JSX '
    + 'makes pasting a subtree easy. If you FIXED one, delete its entry from KNOWN_DUPLICATE_IDS.',
  );
});

test('the known duplicates are the ones the baseline recorded', () => {
  // Guards the allow-list: if a duplicate turns out to have been introduced by
  // the conversion rather than inherited, it must not be excused here.
  assert.deepEqual(
    baseline.duplicateIds, KNOWN_DUPLICATE_IDS,
    'KNOWN_DUPLICATE_IDS no longer matches the duplicates the frozen baseline recorded, so one of '
    + 'them was introduced by the conversion and needs fixing rather than excusing.',
  );
});

test('the ids the dev-console and staging overlay bind are present', () => {
  // The dev-console island binds these on mount (#1079 chunk B moved the
  // module into frontend/src/features/dev-console). The staging twin in
  // particular lives deep inside #staging-overlay and is easy to lose in a
  // conversion, and its absence only shows up while previewing staging —
  // late, and far from the change that caused it.
  // #dev-console-btn and #dev-console-badge are NOT in this list any more:
  // THE UI OVERHAUL retired the header terminal icon in favour of the Improve
  // panel's "Developer terminal" row, which is driven by the same
  // DevConsole._refreshButtonVisibility signal. The staging twin is exactly
  // the one this test was written for, so it matters more than ever.
  for (const id of [
    'staging-dev-console-btn', 'dev-console-close',
    'dev-console-clear', 'dev-console-filter', 'dev-console-log',
  ]) {
    assert.ok(after.includes(`id="${id}"`), `the dev-console island binds #${id}, which is missing`);
  }
});

// ── No module may DEREFERENCE a retired id ────────────────────────────
//
// The regression guard for the worst kind of failure this whole inventory
// exists to prevent, and one THE UI OVERHAUL actually shipped for a moment.
//
// Retiring an id is only half the job: something usually still looks it up.
// `HeaderMenu.init()` kept two of them —
//
//   document.getElementById('drawer-row-github').addEventListener(…)
//   document.getElementById('drawer-row-share').addEventListener(…)
//
// — after both rows moved into the Improve panel. Each threw on null. The
// first one threw inside a React layout effect, which unmounted the whole
// shell root; the second threw out of App.init() before it had fetched the
// session. The page rendered nothing and 218 declared checks failed at once,
// none of them naming the actual cause.
//
// So: a retired id may still be MENTIONED (the comments recording where each
// one went are the point of RETIRED_IDS), and it may still be looked up
// GUARDED — `?.`, or a `const el = …; if (el)` — because a module that
// no-ops when its node is absent is exactly how a row gets re-homed without
// touching it. What it may not be is dereferenced on the spot.
// ── The prerender no longer carries the mount-on-reveal interiors ──────
//
// The union above says every id is still SOMEWHERE. This says where it is
// not: each mount-on-reveal root ships in public/index.html as the empty
// element the hand-written shell's converted siblings (#admin-screen,
// #leaderboard-screen, …) always did, and none of the ids an interior owns
// appears in the document. Without this the inventory would pass just as
// happily if a screen quietly went back to prerendering, and the 681
// elements would be back on every load without anyone noticing.
test('a mount-on-reveal interior is rendered by its component, not by the prerender', () => {
  const shipped = new Set(idsOf(after));
  for (const { id } of MOUNT_ON_REVEAL) {
    assert.ok(shipped.has(id), `#${id} — the ROOT — must still be in public/index.html`);
    const interiorIds = idsOf(interiorHtmlFor(id)).filter((x) => x !== id);
    assert.ok(interiorIds.length > 0, `#${id} renders an interior with ids once mounted`);
    const leaked = interiorIds.filter((x) => shipped.has(x) && !(x in KNOWN_DUPLICATE_IDS));
    assert.deepEqual(
      leaked, [],
      `#${id}'s interior is in the prerendered document. It mounts on first reveal — see `
      + 'frontend/src/lib/mount-on-reveal.ts — so the document must carry only the root.',
    );
  }
});

test('no module dereferences a retired id without a guard', () => {
  const roots = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(js|ts|tsx)$/.test(entry.name)) roots.push(full);
    }
  };
  walk(path.join(ROOT, 'public/js'));
  walk(path.join(ROOT, 'frontend/src'));

  const offenders = [];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    for (const id of Object.keys(RETIRED_IDS)) {
      // `getElementById('x').`  /  `querySelector('#x').` — a dot that is not
      // part of `?.` is an immediate dereference of a value that is null.
      const lookups = [
        new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
        new RegExp(`querySelector\\(\\s*['"]#${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
      ];
      for (const re of lookups) {
        let m;
        while ((m = re.exec(src)) !== null) {
          if (m[1] === '?.') continue; // guarded — fine
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file)}:${line} dereferences #${id}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'a retired id is looked up and dereferenced on the spot, which throws on null. '
    + 'Inside a React effect that unmounts the shell; inside App.init() it stops the boot. '
    + 'Delete the lookup with the row it belonged to, or guard it with `?.`.',
  );
});
