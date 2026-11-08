/**
 * The home screen — `#home-screen`, the launcher grid a signed-in viewer lands
 * on (#1083 chunk F, step 4; the last of the chunk's four regions).
 *
 * ── What the island owns ───────────────────────────────────────────────
 *
 * The screen's STRUCTURE, and nothing else: the pull-to-reveal search bar, the
 * `.home-column` body, and the hosts inside it. THIS component renders once and
 * never again — it holds no state, and the only effect it runs is the
 * visibility subscription below. What lives inside it has moved on, one host at
 * a time:
 *
 *   * `<AppGrid/>`, `<WidgetStrip/>` and `<AppsMore/>` are stateful islands
 *     rendering plain view models `home.js` pushes (./grid-store.ts and
 *     ./chrome-store.ts) — the grid's trailing "Create an app" tile
 *     (./create-tile.tsx) included;
 *   * `<DiscoverSection/>` and `<ChallengesSection/>` are the same
 *     arrangement for the two blocks below the grid, from ./panels-store.ts.
 *
 * ── THREE AREAS, in this order ─────────────────────────────────────────
 *
 * THE UI OVERHAUL gave this screen a shape: Your apps, Discover, Challenges,
 * Create app, stacked. The middle two used to be draggable WIDGETS on the
 * launcher canvas — see the block comment beside them below for what that
 * traded away and why the fixed order is worth more than the freedom was.
 * Create app has since moved INTO Your apps, as the grid's last tile (the
 * prototype's scrHome), so the page reads: your apps and a way to make
 * another, then what to try next, then what the group is working towards.
 *
 * That is deliberate rather than incidental. Two things depend on it:
 *
 *   * **The search input keeps its focus and caret.** `Home.render()` replaces
 *     `#app-list`'s innerHTML on every WS app event and every keystroke, so the
 *     input has always had to live OUTSIDE the grid — that is why the bar is the
 *     scroller's first child and not part of it. Rendering it from React would
 *     regress the same thing in a new way if the island ever re-rendered, so it
 *     doesn't: `#home-search-input` is emitted once at hydration and no React
 *     update ever touches it again.
 *   * **Drag-to-rearrange stays with PlatformUI and the native kit.** The
 *     gesture, its grid overlay, the drop-cell maths and the layout write all
 *     stay in `home.js`, driving `#app-list`'s own children. React never
 *     reconciles inside that subtree, so a drag cannot race a render.
 *
 * ── What is stateful, and what that cost ───────────────────────────────
 *
 * The stateful-island rule (AGENTS.md): a region may hold state only when its
 * whole subtree is React-owned. This screen shipped with none — every dynamic
 * part of it was written by a `public/js`-era module — and it has gained three,
 * each paid for by moving that module's RENDERER (not its data, not its
 * gestures) across the line:
 *
 *   * `#app-list` (#1191): `Home.render()` computes a view model instead of an
 *     HTML string. The layout engine, the WS fan-out, the drag geometry and
 *     the kit attachment all stayed in home.js.
 *   * `#home-widget-strip-section` and `#home-apps-more`: the same split for
 *     the two hosts outside the canvas, on the same push.
 *   * the panel sections: `HomePanels.render()` computes their view models
 *     where it used to build ~800 lines of HTML string and then re-attach
 *     eight families of listener over the result.
 *
 * Nothing on this screen is an `innerHTML` host any more. The data, the
 * fetches and the gestures all stayed where they were.
 *
 * `data-revealed` on the search bar is written by `home.js` at runtime through
 * `dataset`, which is safe for exactly the reason
 * `frontend/src/lib/legacy-dom.ts` documents: React renders its `className`
 * once, as a constant prop, and never writes the attribute again. The two
 * `hidden` toggles that used to sit beside it are React's own state now.
 *
 * ── Visibility ─────────────────────────────────────────────────────────
 *
 * `#home-screen` is the first converted root that ships VISIBLE, so
 * `shippedVisible` is `true` here where every other island passes `false`. The
 * matching read-side change is in `App._isScreenVisible` (public/js/app.js),
 * which now falls back to the DOM for a converted screen nobody has published
 * yet — see the comment there.
 *
 * ── Prerender parity ───────────────────────────────────────────────────
 *
 * The initial render is byte-for-byte the markup the hand-written shell shipped:
 * an empty widget strip, an empty grid, an empty panels section, and no `hidden`
 * on the root. Nothing fetches from render — `Home.load()` is still called by
 * app.js's router.
 */

import { useEffect, useRef, useState } from 'react';

import { whenPlatformViewer } from '../../lib/platform-viewer';
import { useSkin } from '../../lib/skin';
import { HomeGlass } from './glass/home-glass';

import { SearchIcon } from '@/components/ui/icons';

import { AppGrid } from './app-grid';
import { openAddAppsSheet } from './add-apps-sheet';
import { AppsMore } from './apps-more';
import { CreateCompact } from './create-tile';
import { ChallengesSection } from './panels/sections';
import { HomeJoin } from './home-join';
import { PinnedCommunities } from './pinned-communities';
import { SectionHeading } from './panels/ui';
import { VerifyCard } from './verify-card';
import { WaitlistCard } from './waitlist-card';
import { WidgetStrip } from './widget-strip';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { gridStore } from './grid-store';
import { HOME_SEARCH_SHORTCUT_KEYS } from './search-shortcut';

// The three modules that fill this screen, imported in the order their
// <script> tags had: HomeLayout (pure geometry) is read by both of the others,
// and home-panels.js is read by home.js's grid renderer. Each still publishes
// its global for the classic half — see the note at the bottom of each file.
import './home-layout.js';
import './home-panels.js';
import './home.js';

export function HomeScreen() {
  const t = useMessages('home');
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'home-screen', true);
  // EDIT MODE (#4669) is read here for the heading's doors: "Edit" that
  // starts it (#5871) and "Done" that ends it. The store starts not ready,
  // with no items and editing off, so the prerender and the first client
  // render draw no action at all.
  const grid = useStoreState(gridStore);
  // The glass look draws this page in the one frame (./glass/home-glass.tsx).
  // Read after mount only: the first render must match the prerendered
  // document, which knows no look (lib/skin.ts says why).
  const skin = useSkin();
  // And for a viewer the member APIs answer: the signed-out landing and the
  // waiting room keep the standard body (lib/platform-viewer.ts says why a
  // member-only read from either is a console error).
  const [viewer, setViewer] = useState(false);
  useEffect(() => whenPlatformViewer(() => setViewer(true)), []);
  const canEdit = grid.ready && grid.view === 'grid' && !grid.editing
    && grid.items.some((item) => !item.app.demo);
  // ONE HOME (#6361): Pinned apps appears once something is pinned. A new
  // member meets their communities first, and the second kind of pin when
  // they choose it (the app's Pin to Home, the hub's ⋯, "Pin its app too").
  // Never hidden before the grid's first paint, so the prerender agrees.
  const noApps = grid.ready && grid.view === 'grid' && !grid.editing && grid.items.length === 0;

  return (
    <main ref={screenRef} id="home-screen" className="flex-1 overflow-y-auto" style={{ position: 'relative' }} data-page-bounce="">
      {/*
          Hidden-until-pulled search bar (iOS idiom). Deliberately the FIRST
          child of the scroller and NOT sticky: it occupies real scroll space
          above the content, so Home._searchReveal can park the scroller at
          scrollTop = <bar height> and a slight pull down (a scroll up on
          desktop) slides it into view. Keep pulling once it is fully shown
          and the kit's pull-to-refresh takes over — attachPullToRefresh only
          engages from scrollTop 0, so the two stages compose with no extra
          gesture code.
          Still OUTSIDE #app-list: Home.render() wholesale-replaces the
          grid's innerHTML on every WS app event and every keystroke, and the
          input must keep its focus/caret through those re-renders. Wired
          once by Home._wireSearch().
      */}
      {/*
          NO background of its own. It carried `bg-white dark:bg-zinc-950`,
          and in light mode that painted a white band across a #eaeaea page —
          a slab around the input rather than a field sitting on the ground.
          The bar is a real scroll-space child and never sticky, so nothing
          passes underneath it and there is nothing for an opaque fill to
          hide. Letting the page ground show through is both the correct
          colour and the one that cannot drift if the ground ever moves.
      */}
      <div id="home-search-bar" data-revealed="false">
        {/*
            The bar's box stays full-bleed; only its content sits in the
            1024px column, and the px-3 gutter lives here (not on the bar) so
            this column's content edges match #home-body's exactly.
        */}
        {/*
            #1951: the field spans the column. It was capped at `max-w-xl`
            (576px) and sat against the column's LEFT edge, so on anything
            wider than a phone it read as off-centre and short of the content
            below it. Uncapped, it lines up edge to edge with #home-body, and
            the column itself is what centres it.
        */}
        {/*
            `md:pt-5` (overnight audit W06 / D19): from 768px the header is
            the rounded bar with its 8px notch (`-mb-2`), and `pt-3` left the
            field ~4px under it, so it read as clipped by the bar. 8 for the
            notch and 12 of air, the step Discover, Communities and Settings
            already take. A phone keeps `pt-3`: its bar tucks under the
            header, and the reveal reads the bar's height, not a constant.
        */}
        <div className="home-column px-3 pt-3 md:pt-5 pb-2">
          <div className="relative w-full">
            <SearchIcon
              className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
              aria-hidden="true"
            />
            <input
              id="home-search-input"
              type="text"
              autoComplete="off"
              placeholder={t('home:search.placeholder')}
              aria-label={t('home:search.label')}
              aria-keyshortcuts={HOME_SEARCH_SHORTCUT_KEYS}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 ps-9 pe-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            />
            <button
              id="home-search-clear"
              className="hidden absolute end-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none dark:text-zinc-400"
              title={t('home:search.clear')}
              aria-label={t('home:search.clear')}
            >
              &times;
            </button>
          </div>
        </div>
      </div>
      {/*
          .home-body-fill (app.css) makes this a min-height:100% flex column:
          the min-height guarantees the scroller can always be scrolled by at
          least the search bar's height, even with an empty "Your apps" — a
          short page would otherwise leave the bar permanently on screen.
          (It used to do double duty as the flex context for
          .home-bottom-anchor on the two trailing sections; those are widgets
          in the grid now, so nothing below the grid is anchored any more.)
      */}
      <div id="home-body" className="home-column home-body-fill">
        {skin === 'glass' && viewer ? (
          <HomeGlass />
        ) : (<>
        {/*
            #1561's once-per-account explainer stood here, above everything,
            because it was the thing a first-time viewer needed before the
            grid meant anything. #2255 replaced it with the welcome tour,
            which goes on to POINT at the places the banner could only name;
            since #3240 it runs when asked, from Settings. The tour is a
            fixed overlay mounted from Shell.tsx (features/home/tour), not a
            block in this column, so nothing takes its place here: Home opens
            on the widget strip and the grid. The Getting started card that
            sat here for a while (communities, stage 5) is gone too (#4635):
            every new account gets a tour, and the season's First challenges
            are ordinary cards in the Challenges area below.
        */}
        {/*
            iOS in-app only: the "Homeroom widget" editing strip, mirroring
            the pinned grid the homescreen widget renders. It lives ABOVE the
            launcher grid rather than inside it — a full-width flow item
            cannot coexist with the explicit cell placement #app-list now
            uses. Stateful (chromeStore), and it ships EMPTY and hidden
            everywhere but the iOS app — see widget-strip.tsx for what the
            component took over from Home._wireWidgetStrip and what it left
            there.
        */}
        <WidgetStrip />
        {/* One Home (#6361): no continue card. The change you last worked on
            is a row of the bell and of Homeroom bot's list. */}
        {/*
            ── AREA 1 of 4: YOUR APPS ─────────────────────────────────

            THE LAUNCHER GRID. Every child is placed at an explicit
            (column, row) cell by Home.render() — so a viewer's arrangement
            can have holes in it, exactly like a phone home screen. Nothing
            here flows.

            FOUR COLUMNS AT EVERY WIDTH, and two rows by default. It was
            `grid-cols-4 sm:grid-cols-5` until THE UI OVERHAUL: a launcher
            reads as a launcher at phone density, and a second breakpoint
            bought a fifth column at the price of a whole second stored
            layout per viewer (see the note this removed in
            features/home/home-layout.js). The desktop grid is width-capped
            by .home-column rather than stretched, so four columns there are
            four bigger tiles, not four tiny ones with a gulf beside them.
            HomeLayout.COLS mirrors this and tests/home-layout-model.test.js
            greps both files.

            `grid-auto-rows` and `position: relative` (needed by the
            drag-time grid overlay) live in app.css. How many rows the
            collapsed grid draws is Home.visibleRowBudget: as many as fit in
            the first two-thirds of the screen, floored at
            HomeLayout.DEFAULT_ROWS. Either way it is a cap on what is SHOWN,
            never on what a viewer may have — a ninth app grows the grid
            rather than being stranded.

            NO TOP PADDING ON THIS SECTION. It used to carry `pt-1.5 sm:pt-2`
            on top of the `pt-1.5 sm:pt-2` #app-list already has, so the first
            row of tiles sat a doubled gutter below the header for no reason
            anybody could point at. The grid keeps its own — and it has to,
            because `.home-grid-overlay`'s inset mirrors #app-list's padding
            EXACTLY (app.css says so, twice, once per breakpoint) and
            Home._rectForCell measures those overlay cells to land a committed
            drop. Trim the padding here, never there.
        */}
        <section id="home-apps-section" className="px-3" hidden={noApps}>
          {/*
              The area's label, in the same treatment the two below it use —
              see ./panels/ui.tsx's SectionHeading for why every area on this
              screen is now "grey label, then the thing". It was "Your apps",
              then "Shortcuts" once the UI overhaul gave your communities
              (every project you are in) the Communities tab, which left this
              set as what it always was: the apps you keep a tile for. It is
              "My apps" since #4187, in the sentence case of Recents and
              Discover. The rest of the product names the set the same way
              (the tile menus' "Add to My apps", the browse screen's badge),
              because two names for one collection is worse than either.
          */}
          <SectionHeading
            action={grid.editing ? (
              /* The screen's one job while the tiles wiggle is arranging them,
                 and "Done" is its primary action. The treatment is BrowseLink's
                 own: 14px semibold in the accent, riding the heading row the way
                 Discover's link does. "Add other apps" rides beside it (#4669; #5959 named it): the
                 mode's second entry, opening the same sheet the tile menu's
                 "Add to My apps" opens, so growing the shelf does not cost the
                 trailing tile its place.

                 #5825: otherwise the seat carries New project whenever the
                 folded grid holds its trailing tile back — the grid draws no
                 tile then, and this is where the one Create control on the
                 screen rides, the way Discover's "See all" rides its heading.
                 With few apps, or unfolded, the tile ends the grid and the
                 heading has no action. `heldBack` is never true while
                 editing, so the two branches cannot both draw. */
              <span className="flex items-center gap-4">
                <button
                  type="button"
                  className="home-edit-add shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
                  aria-label={t('home:edit.addTile')}
                  onClick={() => { openAddAppsSheet(); }}
                >
                  <span className="whitespace-nowrap">{t('home:edit.addTile')}</span>
                </button>
                <button
                  type="button"
                  className="home-edit-done shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
                  aria-label={t('home:edit.done')}
                  onClick={() => { (window as any).Home?.setEditing?.(false); }}
                >
                  <span className="whitespace-nowrap">{t('home:edit.done')}</span>
                </button>
              </span>
            ) : (canEdit || grid.create?.heldBack) ? (
              /* #5871: "Edit" is edit mode's own door. A hold on a tile used
                 to start it beside the tile's menu, so one press showed both;
                 a hold is the menu alone now, and arranging is asked for
                 here (or from the menu's "Edit My apps"). Shown only on the
                 grid view with a tile of your own to arrange. */
              <span className="flex items-center gap-4">
                {canEdit ? (
                  <button
                    type="button"
                    className="home-edit-start shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
                    aria-label={t('home:edit.startLabel')}
                    onClick={() => { (window as any).Home?.setEditing?.(true); }}
                  >
                    <span className="whitespace-nowrap">{t('home:edit.start')}</span>
                  </button>
                ) : null}
                {grid.create?.heldBack ? <CreateCompact view={grid.create} /> : null}
              </span>
            ) : null}
          >
            {t('home:grid.heading')}
          </SectionHeading>
          <AppGrid />
          {/*
              "Show all N apps" — revealed by Home.render() only when the
              viewer has more than the visible rows hold. Ships hidden
              and empty; it is React's now (chromeStore), which is what lets
              its listener be attached once instead of on every paint.
          */}
          <AppsMore />
        </section>
        {/*
            ── AREAS 2-4: DISCOVER, WAITLIST, VERIFY, CHALLENGES ──────

            Discover moved up (#4937): it follows the launcher directly, so
            the community cards are on the first screen instead of a scroll
            below two cards that most viewers had already settled. The
            launcher's cap (Home.APPS_VIEWPORT_FRACTION, now a half) leaves
            the rail peeking under "Show all N apps".

            These were WIDGETS until THE UI OVERHAUL — draggable blocks
            placed on the launcher canvas alongside the app tiles, each with
            its own footprint, its own anchor cell and a per-column-count
            size table. They are fixed sections in a fixed order now, and the
            drag gesture applies to app tiles alone.

            What that bought: the home screen has a shape you can describe.
            "Your apps, then what to try next, then what the group is working
            towards" is a page; the same things at wherever-you-dropped-them
            was a canvas with no reading order, and it made every one of them
            optional in a way none of them are.

            CREATE APP WAS A FOURTH SECTION HERE, below Challenges. It is the
            launcher grid's trailing tile now (./create-tile.tsx, placed by
            Home.render()), as the prototype draws it: making an app is a
            thing you do from your shelf of apps, not a destination two
            sections further down. `#home-create-section` went with it
            (tests/shell-id-inventory.test.js records why).

            Each renders its own host now (./panels/sections.tsx) from a view
            model HomePanels.render() pushes — the `innerHTML` hosts and the
            `_stampState` pass that mirrored each block's state up onto them
            went together. Both still ship EMPTY and un-hidden: the panels
            cache is fetched, so drawing anything at hydration would disagree
            with the prerendered document.

            `data-panel-slot` rides along from the grid host each one
            replaces. It names WHICH block a host is for, which is as true of
            a section as it was of a cell, and it is the hook everything
            outside this file already selects on: the dapp.json checks and
            the screenshot assertions. That selector is why the block's own
            state attributes appear on the host as well as on the block — one
            model now feeds both, rather than a second pass copying one to
            the other.
        */}
        <PinnedCommunities />
        {/*
            A PRIVATE MEMBER'S WAITLIST CARD (./waitlist-card.tsx): an invite
            link let them into their group's apps, and this is where they join
            the waitlist to make their own. Nothing in the prerender; it draws
            once the shell knows who is signed in. Their Home has no
            Challenges (src/routes/home-panels.js leaves it out).
        */}
        <WaitlistCard />
        {/*
            "VERIFY YOUR ACCOUNT" (./verify-card.tsx): a member the
            verified-identity rule holds to it adds a phone here, or links
            GitHub and X. Nothing in the prerender, like the card above.
        */}
        <VerifyCard />
        <ChallengesSection />
        <HomeJoin />
        {/*
            THE "YOU" AREA IS GONE, and Profile did not go with it. A fifth
            area held one row — an avatar, "Profile", "Your points, settings
            and account" — as the entrance the retired hamburger took away.
            The chip's menu has carried that entrance since #1443: a "You"
            group with #switcher-row-profile and #switcher-row-settings in
            it, pinned by the destination-order check in dapp.json. So the
            row was a second door to the same screen, on the one screen
            people open to reach their apps, and the design's own answer is
            a Profile tab in a bottom bar rather than a card at the foot of
            the launcher.

            App.applyUserAvatar went with it: Home's pair was the only one
            left (the header chip's copy was retired in the same #1443
            round), so the function had no nodes to write to. Profile's own
            editor re-reads the picture from App.user when it saves.
        */}
        {/*
            #home-panels — the widgets' FALLBACK host — is gone with the
            placement it existed for. It caught the moment before the first
            grid paint and the active-search view, because a widget that
            lived IN the grid vanished whenever the grid did. The two
            sections above are outside #app-list and never re-rendered by a
            search keystroke, so there is nothing left to catch.
        */}
        </>)}
      </div>
    </main>
  );
}
