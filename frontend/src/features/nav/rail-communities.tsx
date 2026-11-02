/**
 * #platform-rail-communities — your communities, in the desktop's sidebar of
 * rows (D, 18 Oct 2026, ./sidebar-rows.ts).
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * Under a Communities heading, the five communities you opened last, each its
 * own tile, its name and the votes it waits on you for. Pressing one switches
 * to it in place, keeping the place you were on when it has it
 * (../workshop/community-scope.ts goToCommunity), as the phone's drawer does.
 * Pressing the one you are on goes up its page a level at a time and stops at
 * its Hub (../workshop/tab-ladder.ts pressLitTab). After them, the
 * Communities tab itself, drawn as "All 13 communities" (./tab-bar.tsx), opens
 * the list of every community.
 *
 * ── The places, under the row (v3) ───────────────────────────────────
 *
 * The community whose page is up opens under its row: Hub, Needs you and
 * Workshop, then #general under Channels and the topics under Topics, the
 * first two and "Show N more" (../dev-board/workshop/project-places.tsx, the
 * list the phone's drawer and tray draw too). A press moves the page in
 * place.
 * The row itself keeps `aria-current` but gives its fill to the place lit
 * under it, and its count to Needs you, which says the same votes. A
 * community you are only visiting, which is not one of the five, has a row
 * after them for as long as you are on its page, so its places are always
 * here. The part opens and shuts on the one clock ./rail-nest.tsx keeps.
 *
 * ── Its app, the first row (18 Oct 2026) ─────────────────────────────
 *
 * Above Hub, App: the community's app, which the sidebar's Recent apps
 * section used to list apart from its community. Being in the app is being
 * in the community, so its row opens there too, with App lit (one of yours:
 * an app you have not joined shows its App row alone, and nothing reads a
 * community record for it). App carries
 * the green "still open" dot while the app runs in a kept frame
 * (../app-frame/live-apps.tsx) — on the desktop that dot is the app's close
 * control too (#5525): on hover or keyboard focus an X takes its place, and
 * pressing it closes the app and folds the row — and THAT ROW STAYS: in another community,
 * one whose app is still running keeps its App row alone under its own row,
 * the rest folded away, until the frame goes. So App sits in an outer part
 * and the places in one inside it, and leaving shuts only the inner one.
 * Homeroom's own community has no App row: the platform is its app
 * (`selfHosted`), and you are in it already.
 *
 * A community whose app is running is always listed: one that is not among
 * the five, an app you use without having joined, has a row after them
 * while it runs, as a page you visit does.
 *
 * THE HEADING HOLDS A SEARCH, shown while the pointer is over the section or
 * the search has focus (app.css). It is All communities with its search box
 * focused and lit (../workshop/communities-search.ts).
 *
 * ── Which five ───────────────────────────────────────────────────────
 *
 * This device's own order, kept per viewer (`railCommunities`): the five
 * most recently active of your communities to begin with, and after that a
 * community you open that is not among them comes in at the top, pushing the
 * last one out (`noteOpened`, the last one whose app is not running).
 * Only communities you are in are listed: a page you are visiting is not one
 * of yours until you join it. The ones you pinned are not among the five
 * either: they have their own section above this one (./rail-pinned.tsx), so
 * a pin never pushes one of the five out.
 *
 * THE ORDER CHANGES ON THE NEXT LOAD, NEVER DURING A VISIT (#21 of the
 * 19 Oct polish board). Opening an app from Home used to put its community
 * at the top and drop the fifth there and then, so the rows moved under you
 * as you went about. Now the five this page drew first stay where they are
 * until it is loaded again: what you open is noted in the kept order, which
 * the next load draws. A community you are in that is not among them for
 * now (a page you visit, an app still running) has a row AFTER the five
 * (`railRows`), so nothing above it moves. One you leave or pin goes, and
 * the gap is filled at the end.
 *
 * ── Where it is, and when ─────────────────────────────────────────────
 *
 * Between the Messages tab and the Communities tab, in the reading order the
 * sidebar shows. On the phone's bar app.css does not draw it: the bar's five
 * cells are as they were.
 *
 * ── Dragging a row onto My apps (#6025) ──────────────────────────────
 *
 * While Home is the screen on show, a community row can be pressed and
 * dragged onto My apps, which adds that app in the cell it was dropped in:
 * the same gesture a Discover card makes. It is the same recognizer, attached
 * to this section by the effect in RailCommunities with the row selector
 * below; Home carries the row as the same incoming app a Discover card is
 * (`data-rail-community` is the slug). A committed drop adds the app exactly
 * as Add does, so it also joins you. Pinned rows are a different element
 * (#platform-rail-pinned), so their drag-out-to-unpin is untouched, and the
 * phone's drawer is not this file.
 *
 * The click a completed drag leaves behind is swallowed by the kit's
 * capture-phase listener on #platform-rail-communities: React's delegated
 * onClick listens at the island root, above that element, so a drag never
 * opens the community. A press with no movement is left alone and still does.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The heading and the search ship in the document; the rows do not. The
 * community list arrives from GET /api/apps after sign-in (warmCommunities)
 * and this device's order from localStorage in an effect, so the prerendered
 * document and the first client render agree on a heading and no rows.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { AppWindowIcon, SearchIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { useStoreState } from '../../lib/use-store-state';
import {
  closeLiveApp, currentAppOnScreen, liveAppLabel, LiveAppDot, useCurrentAppSlug, useLiveAppSlugs,
} from '../app-frame/live-apps';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { devWorkshopStore } from '../dev-board/card/cards-store';
import { useCommunity } from '../dev-board/workshop/community-card';
import { openPlace, placeStore } from '../dev-board/workshop/place-store';
import { ProjectPlaces } from '../dev-board/workshop/project-places';
import { openCommunitiesSearch } from '../workshop/communities-search';
import { communityScopeStore, goToCommunity, type CommunityInfo } from '../workshop/community-scope';
import { pressLitTab } from '../workshop/tab-ladder';
import { navStore } from './nav-store.js';
import { openPinMenu } from './pin-actions';
import { pinnedAppsStore } from './pinned-apps-store.js';
import { NestSlot } from './rail-nest';
import { recentAppsStore } from './recent-apps-store.js';
import { noteResumeOrigin } from './resume-motion';
import { useSidebarRows } from './sidebar-rows';

/** How many communities the sidebar lists. */
export const RAIL_COMMUNITIES = 5;

/** How many of a community's topics its nested places draw before "Show N more". */
export const RAIL_TOPICS = 2;

/**
 * The rows the sidebar drags onto My apps (#6025): the communities under
 * their heading, not their App line or the places nested beneath them.
 */
export const RAIL_DRAG_ITEMS = '.platform-rail-community[data-rail-community]';

/**
 * The rows the section draws: the five, then, while you are in it (on its
 * page or in its app), a community you are visiting that is not among them,
 * then any other whose app is still running (`live`, the frame store's
 * order) and is not among them. After the five, so a visit never moves them
 * (#21). Pure.
 */
export function railRows(shown: readonly string[], here: string | null, live: readonly string[] = []): string[] {
  const extra: string[] = [];
  for (const slug of [here, ...live]) {
    if (slug && !shown.includes(slug) && !extra.includes(slug)) extra.push(slug);
  }
  return [...shown, ...extra];
}

/** This device's order, per viewer. */
const KEY = 'platformRailCommunities:v1';

/**
 * The communities the sidebar lists: the ones this device kept that are still
 * among yours, in its order, then the most recently active of the rest, at
 * most `limit`. `list` is every community you are in, newest first (the
 * scope store's). Pure.
 */
export function railCommunities(kept: readonly string[], list: readonly string[] | null, limit = RAIL_COMMUNITIES): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const slug of [...kept, ...list]) {
    if (out.length >= limit) break;
    if (list.includes(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * The order after `slug` was opened: unchanged when it is already listed (or
 * is not one of yours), else `slug` first and the last one out: the last one
 * whose app is not still running (`keep`), so a running app's row stays.
 * Pure.
 */
export function noteOpened(
  shown: readonly string[],
  slug: string | null,
  list: readonly string[] | null,
  limit = RAIL_COMMUNITIES,
  keep: readonly string[] = [],
): string[] | null {
  if (!slug || !list || !list.includes(slug) || shown.includes(slug)) return null;
  const next = [slug, ...shown];
  while (next.length > limit) {
    let out = next.length - 1;
    while (out > 0 && keep.includes(next[out])) out -= 1;
    next.splice(out > 0 ? out : next.length - 1, 1);
  }
  return next;
}

/**
 * Whether a community's part leads with an App row: not Homeroom's own
 * (`selfHosted`, known once the list of yours is read), and not before it is
 * known. One that is not yours is never Homeroom, which every account is in.
 * Pure.
 */
export function hasAppRow(slug: string, info: Record<string, CommunityInfo>, list: readonly string[] | null): boolean {
  const known = info[slug]?.selfHosted;
  if (known != null) return !known;
  return !!list && !list.includes(slug);
}

export function readKept(viewer: string | null): string[] {
  if (!viewer) return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    return raw && raw.viewer === viewer && Array.isArray(raw.slugs)
      ? raw.slugs.filter((s: unknown): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveKept(viewer: string | null, slugs: string[]): void {
  if (!viewer) return;
  try { window.localStorage.setItem(KEY, JSON.stringify({ viewer, slugs })); } catch { /* the order lasts this visit */ }
}

/**
 * The five: read from this device once the viewer is named, and drawn in
 * that order for the rest of the visit (#21). Opening a community not among
 * them moves the kept order, for the next load. ./tab-bar.tsx reads it once
 * and hands it to the section and to the All row's count.
 */
export function useRailCommunities(): string[] {
  const { viewer } = useStoreState(navStore);
  const { slug, list: yours } = useStoreState(communityScopeStore);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  const live = useLiveAppSlugs();
  // The five are the most recent of yours that are not pinned.
  const pinned = pins.map((app: { slug: string }) => app.slug);
  const listKey = yours ? yours.filter((s) => !pinned.includes(s)).join() : null;
  const list = listKey == null ? null : listKey ? listKey.split(',') : [];
  const liveKey = live.join();
  // Whose order `slugs` is: a community opened before this viewer's order
  // has been read must not write over it.
  const [kept, setKept] = useState<{ viewer: string | null; slugs: string[] }>({ viewer: null, slugs: [] });
  useEffect(() => { setKept({ viewer, slugs: readKept(viewer) }); }, [viewer]);
  const ready = !!viewer && kept.viewer === viewer;
  // The kept order, which the next load draws.
  const saved = railCommunities(ready ? kept.slugs : [], list);
  const savedKey = saved.join();
  // THE VISIT'S ORDER (#21): the kept order as it stood once both it and the
  // list of yours were read, held for as long as this page is up.
  const [visit, setVisit] = useState<{ viewer: string | null; slugs: string[] }>({ viewer: null, slugs: [] });
  useEffect(() => {
    if (ready && list && visit.viewer !== viewer) setVisit({ viewer, slugs: saved });
  }, [ready, listKey, viewer, savedKey]);
  const shown = visit.viewer === viewer ? railCommunities(visit.slugs, list) : saved;
  useEffect(() => {
    if (!ready) return;
    const next = noteOpened(saved, slug, list, RAIL_COMMUNITIES, live);
    if (!next) return;
    setKept({ viewer, slugs: next });
    saveKept(viewer, next);
    // The kept order, the list and the running apps are read through their
    // keys: the same five are the same answer.
  }, [ready, slug, listKey, viewer, savedKey, liveKey]);
  return shown;
}

/** A community's places, nested under its row: the project's own list, kept short. */
function RailPlaces({ slug, onPage }: { slug: string; onPage: boolean }) {
  const place = useStoreState(placeStore);
  const v = useStoreState(devWorkshopStore);
  const community = useCommunity(slug);
  // In its app, no place is lit: App is.
  const here = onPage && place.slug === slug;
  return (
    <ProjectPlaces
      slug={slug}
      name={community?.name || slug}
      // Nothing lit until the page has said where it is.
      place={here ? place.place : null}
      owed={here ? place.owed : 0}
      places={community?.places}
      // #2915: the Workshop's dot, as the page's own list draws it.
      filtered={here && v.slug === slug && !!v.meta?.filtered && place.place !== 'all'}
      fold={RAIL_TOPICS}
      onPlace={(key) => { openPlace(slug, key); }}
    />
  );
}

function isNativeClick(event: MouseEvent): boolean {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  return !!nav?.isNativeClick?.(event);
}

/**
 * A COMMUNITY PRESSED IN THE SIDEBAR IS A PLACE SWITCH (1 Nov 2026), and it
 * swaps like the tabs above it, a cut (#2797, #2880). It went through
 * navigateToApp's zoom with nothing on screen to grow out of, so the kit
 * fell back to its sliding page transition: the old page, sidebar and all,
 * slid left over the new sidebar while the new page was still blank. The
 * router's own mark for a press (App._tabPress, as resumeWorkshopView sets
 * it) is read before navigateToApp's first await, and never outlives it.
 */
export function pressPlace(navigate: () => void): void {
  const app = (window as unknown as { App?: { _tabPress?: boolean } }).App;
  if (app) app._tabPress = true;
  try {
    navigate();
  } finally {
    if (app) app._tabPress = false;
  }
}

/** Where you are, as every row of the sidebar's communities reads it. */
export interface RailHere {
  sidebarRows: boolean;
  screen: string | null;
  /** The community whose page is up. */
  onPage: string | null;
  /** The community whose app is on screen. */
  onApp: string | null;
  /** The apps still running, the one on screen first. */
  live: string[];
}

export function useRailHere(): RailHere {
  const { slug: scoped } = useStoreState(communityScopeStore);
  const { screen, tab } = useStoreState(navStore);
  const sidebarRows = useSidebarRows();
  const live = useLiveAppSlugs();
  const frameSlug = useCurrentAppSlug();
  return {
    sidebarRows,
    screen,
    // The Communities tab is lit there (#app-view on its `dev` tab), and the scope names which.
    onPage: screen === 'app-view' && tab === 'workshop' ? scoped : null,
    onApp: currentAppOnScreen({ frameSlug, screen, tab }),
    live,
  };
}

/** What a pinned row adds: its drag back out (./rail-pinned.tsx). */
export interface PinnedRowHandlers {
  onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLAnchorElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLAnchorElement>) => void;
  onPointerCancel: () => void;
  /** The click a drag-out's release leaves behind, which must not open the community. */
  swallowClick: () => boolean;
}

/** A name and a face for a community the list of yours does not hold. */
export interface RailRecord {
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
}

/**
 * One community's row and its nested part: App (with its dot while the app
 * runs), then its places while you are in it. The sections draw every
 * community with it: the five, a visit, a running app's, a pin.
 */
export function RailCommunityRow({ slug, here, record = null, pin }: {
  slug: string;
  here: RailHere;
  /** Its name and face when the list of yours does not have them (a pin's own record). */
  record?: RailRecord | null;
  pin?: PinnedRowHandlers;
}) {
  const t = useMessages('core');
  const { info, list } = useStoreState(communityScopeStore);
  const { apps: recents } = useStoreState(recentAppsStore);
  const c = info[slug];
  const recent = c || record ? null : (recents as Array<{ slug: string } & RailRecord>).find((a) => a.slug === slug) || null;
  const { sidebarRows, screen, onPage, onApp, live } = here;
  // Only a page you are visiting is read for its name. A row a running app
  // brought is named from what is known: an app need not have a community
  // record to read (the shots' made-up apps have none, and a read that
  // 404s is a console error).
  const visit = useCommunity(c || record || recent || onPage !== slug ? '' : slug);
  const name = c?.name || record?.name || recent?.name || visit?.name || slug;
  const face = c || record || recent;
  const icon = { icon_url: face?.iconUrl || null, icon_emoji: face?.iconEmoji || null, name };
  const yours = !!record || (!!list && list.includes(slug));
  // Its places open while you are on its page, or in its app when it is one
  // of yours: an app you have not joined shows its App row alone.
  const inside = onPage === slug || onApp === slug;
  const open = sidebarRows && (onPage === slug || (onApp === slug && yours));
  const app = hasAppRow(slug, info, list);
  const running = live.includes(slug);
  // The part: everything while you are in it, its App row alone while its app runs.
  const part = open || (sidebarRows && app && (running || onApp === slug));
  // Open, its votes are Needs you's count under it.
  const votes = c && !c.unchosen && !open ? Number(c.needs) || 0 : 0;
  const appName = t('core:rail.appOf', { name });
  const href = `#app/${encodeURIComponent(slug)}/workshop`;
  // The App row, which the close control hands the focus to before it goes.
  const appRef = useRef<HTMLAnchorElement | null>(null);
  // While Home is on show, a section row can be dragged onto My apps (#6025).
  // A pin keeps its own drag-out to unpin, so it is not one of these.
  const dragToHome = !pin && sidebarRows && screen === 'home-screen';
  return (
    <Fragment>
      <a
        className="platform-rail-community"
        href={href}
        data-rail-community={slug}
        // The browser's own link drag would take the pointer and cancel the
        // placement gesture (#6025). It is set on the node, not rendered as an
        // attribute: the row's open tag is markup the sidebar's checks read.
        ref={(el) => {
          if (el) el.draggable = !dragToHome;
        }}
        {...(open ? { 'data-rail-open': '' } : {})}
        {...(pin ? { 'data-rail-pinned': '' } : {})}
        title={name}
        aria-current={inside ? 'page' : undefined}
        onClick={(event) => {
          if (pin?.swallowClick()) {
            event.preventDefault();
            return;
          }
          if (isNativeClick(event)) return;
          event.preventDefault();
          // On its page, a press goes up the page; from its app, to its page.
          if (onPage === slug) pressLitTab(screen, { stopAtCommunity: true });
          else pressPlace(() => goToCommunity(slug));
        }}
        // One of yours pins or unpins from its right-click menu, which
        // keeps the link's Open in new tab (./pin-actions.ts).
        {...(yours ? {
          onContextMenu: (event: MouseEvent<HTMLAnchorElement>) => {
            openPinMenu(event, { slug, name, iconUrl: icon.icon_url, iconEmoji: icon.icon_emoji }, href);
          },
        } : null)}
        {...(pin ? {
          onPointerDown: pin.onPointerDown,
          onPointerMove: pin.onPointerMove,
          onPointerUp: pin.onPointerUp,
          onPointerCancel: pin.onPointerCancel,
        } : null)}
      >
        <span className="app-icon-tile platform-rail-tile" data-icon={appIconKind(icon)} aria-hidden="true">
          <AppIconContent app={icon} />
        </span>
        <span className="platform-rail-name">{name}</span>
        {votes > 0 ? (
          <span className="platform-rail-votes" aria-label={t('core:tabs.votesWaiting', { count: votes })}>
            {votes > 99 ? '99+' : String(votes)}
          </span>
        ) : null}
      </a>
      <NestSlot open={part} className="platform-rail-nest" rows=".platform-rail-app, .dev-ws-place, .dev-ws-places-head">
        {app ? (
          // A row wrapper, because the close control cannot live inside the
          // anchor: a button in a link is not allowed. The dot stays in the
          // anchor where dapp.json's kept-apps check finds it.
          <div className="platform-rail-app-row">
            <a
              ref={appRef}
              className="platform-rail-sub platform-rail-app"
              href={`/app/${encodeURIComponent(slug)}`}
              data-rail-app={slug}
              {...(running ? { 'data-live': 'true' } : null)}
              title={appName}
              // "Game Corner app", and that it is still open: the row's words
              // are only "App", under the community's name.
              aria-label={running ? listText([appName, liveAppLabel()]) : appName}
              aria-current={onApp === slug ? 'page' : undefined}
              onClick={(event) => {
                if (isNativeClick(event)) return;
                event.preventDefault();
                // #3618: a running app grows back out of the row that was pressed.
                if (running && onApp !== slug) {
                  noteResumeOrigin(slug, event.currentTarget.querySelector('.platform-rail-sub-glyph') || event.currentTarget);
                }
                // The router's "this app, this tab" entry point: it switches to
                // an app that is still open and navigates to any other.
                (window as unknown as { App?: { openAppTab?: (slug: string, tab: string) => void } }).App?.openAppTab?.(slug, 'app');
              }}
            >
              <AppWindowIcon className="platform-rail-sub-glyph" aria-hidden="true" />
              <span className="platform-rail-sub-name">{t('core:rail.app')}</span>
              {running ? <LiveAppDot className="platform-rail-live" /> : null}
            </a>
            {/* Close the app (#5525): an X where the dot sits, shown on hover
                or keyboard focus (app.css). Not offered for the app on
                screen — there is nothing to close it away from. Pressing it
                must not press the row's own open. */}
            {running && onApp !== slug ? (
              <button
                type="button"
                className="platform-rail-live-stop"
                title={t('core:liveApp.closeTitle')}
                aria-label={t('core:liveApp.close', { app: appName })}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // The row folds away with the app, so the focus it had
                  // would fall to the body: it lands on the App row.
                  appRef.current?.focus();
                  closeLiveApp(slug);
                }}
              >
                <XIcon className="platform-rail-live-stop-glyph" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <NestSlot open={open} className="platform-rail-nest platform-rail-places" rows=".dev-ws-place, .dev-ws-places-head">
          <RailPlaces slug={slug} onPage={onPage === slug} />
        </NestSlot>
      </NestSlot>
    </Fragment>
  );
}

export function RailCommunities({ shown }: { shown: string[] }) {
  const t = useMessages('core');
  const here = useRailHere();
  const { apps: pins } = useStoreState(pinnedAppsStore);
  const pinned = pins.map((app: { slug: string }) => app.slug);
  // #6025: the rows drag onto My apps only while Home is the screen on show.
  // Anywhere else there is no grid to drop on, so nothing is attached, and
  // the detach the effect returns takes the gesture away when Home goes or
  // the window falls below the sidebar's 768px.
  const railRef = useRef<HTMLDivElement | null>(null);
  const onHome = here.sidebarRows && here.screen === 'home-screen';
  useEffect(() => {
    const el = railRef.current;
    if (!el || !onHome) return undefined;
    const Home = (window as unknown as {
      Home?: { _attachDiscoverPlacement?: (el: Element, opts?: { itemSelector: string }) => (() => void) | null };
    }).Home;
    return Home?._attachDiscoverPlacement?.(el, { itemSelector: RAIL_DRAG_ITEMS }) || undefined;
  }, [onHome]);
  // The five, then a visit and a running app that are not among them (#21);
  // a pinned one is in its own section.
  const rows = (here.sidebarRows ? railRows(shown, here.onPage || here.onApp, here.live) : shown)
    .filter((slug) => !pinned.includes(slug));
  return (
    <div
      ref={railRef}
      id="platform-rail-communities"
      className="platform-rail-communities"
      role="group"
      aria-labelledby="platform-rail-communities-label"
    >
      <div className="platform-rail-head">
        <span id="platform-rail-communities-label" className="platform-rail-head-label">{t('core:rail.communities')}</span>
        <a
          id="platform-rail-search"
          className="platform-rail-search"
          href="#communities"
          aria-label={t('core:rail.search')}
          title={t('core:rail.search')}
          onClick={(event) => {
            if (isNativeClick(event)) return;
            event.preventDefault();
            openCommunitiesSearch();
          }}
        >
          <SearchIcon className="platform-rail-search-glyph" aria-hidden="true" />
        </a>
      </div>
      {rows.map((slug) => <RailCommunityRow key={slug} slug={slug} here={here} />)}
    </div>
  );
}
