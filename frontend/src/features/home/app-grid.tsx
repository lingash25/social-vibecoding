/**
 * `#app-list` — the launcher grid, as the only React writer below that node.
 *
 * ── The ownership split this conversion makes ─────────────────────────
 *
 * Before: `Home.render()` built the whole grid as an HTML string, assigned it
 * to `#app-list.innerHTML`, and then re-attached every listener with four
 * `querySelectorAll` sweeps (`Home._wireCards`). Every WS app event and every
 * search keystroke destroyed and rebuilt the subtree.
 *
 * After: `Home.render()` computes the view model in ./grid-store.ts and this
 * component renders it. React reconciles — a status change repaints one tile's
 * label instead of rebuilding forty nodes, and a card element survives across
 * renders, which is what lets the per-card gesture wiring below attach once.
 *
 * home.js keeps everything that is NOT markup: the app list and its WS
 * fan-out, the layout fetch and its persistence, the card menus, the drag
 * geometry (`_targetCellFor` / `_planFor` / `_rectForCell`), and the kit
 * attachment. That is the boundary the migration skill asks for — one owner
 * per subtree — and it is why the gesture code below is CALLED from here
 * rather than reimplemented here: those functions attach listeners to nodes,
 * they do not write markup, so they are not a second writer.
 *
 * ── The markup is like-for-like, and that is load-bearing ─────────────
 *
 * Same classes, same `data-*`, same structure as the string this replaces.
 * Four separate consumers depend on it and none of them would fail loudly:
 *
 *   * the kit's placement recognizer selects
 *     `.app-card[data-yours]:not([data-demo])`;
 *   * `App._tileFor(slug)` (public/js/app.js) finds the zoom-out rect with
 *     `#app-list .app-card[data-slug="…"]`;
 *   * app.css styles `.app-card`, `.app-icon-tile[data-icon]`,
 *     `.app-card-title` and `.app-card-status`;
 *   * dapp.json's declared checks select on these chains.
 *
 * The new widget language reaches these tiles through the token layer
 * (tailwind.config.js) and app.css, not by respelling the classes here — so
 * the reskin and this conversion stay independently reviewable.
 *
 * ── Why the cell is an inline style, written as an ATTRIBUTE ──────────
 *
 * Per-cell placement is `grid-column`/`grid-row` on the item. Those cannot be
 * Tailwind utilities: the values are per-viewer data, and Tailwind's extractor
 * is a regex over source text, so an arbitrary-value class built from a
 * variable would never compile. Inline is also what the string version did.
 *
 * It is written with `setAttribute`, not through React's `style` prop, and
 * that is load-bearing. React sets styles through the CSSOM, one longhand at
 * a time, and `grid-column` + `grid-row` together cover all four longhands of
 * `grid-area` — so the browser re-serializes the declaration block as the
 * SHORTHAND: `style="grid-area: 1 / 2 / span 1 / span 1"`. The text
 * `grid-row` disappears from the attribute, and dapp.json's declared check
 * for placed tiles selects on `.app-card[data-yours="true"][style*="grid-row"]`.
 * Writing the attribute keeps the exact spelling the string version emitted,
 * which is the like-for-like rule applied to a value the CSSOM would
 * otherwise rewrite underneath us. React does not manage `style` on this
 * element (no `style` prop is passed), so there is no writer to race.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { CopyIcon, LockIcon, UserGroupIcon, UserPenIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { useLiveSkin } from '../../lib/skin';
import { useStoreState } from '../../lib/use-store-state';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { liveAppLabel, LiveAppDot, useLiveAppSlugs } from '../app-frame/live-apps';
import { AppsLoadError } from '../apps/load-error';
import { TileSkeleton } from '../apps/tile-skeleton';
import { buildLineTileClass } from '../first-session/build-line-words.js';
import { recentAppsStore, recentAppTimes } from '../nav/recent-apps-store.js';
import { CreateTile } from './create-tile';
import { gridStore, type GridItem, type GridPlacement, type HomeAppView, type IconView } from './grid-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

function placementStyle(p: GridPlacement | null): string | undefined {
  if (!p) return undefined;
  return `grid-column:${p.col + 1}/span ${p.w};grid-row:${p.row + 1}/span ${p.h}`;
}

function cellStyle(item: GridItem): string | undefined {
  return placementStyle(item.placement);
}

function AppIcon({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    // w-full/h-full, not a fixed size: the tile draws a 1px hairline border
    // and the image fills the CONTENT box so it stays flush inside the ring
    // rather than being cropped by it (same note as AppCard.iconTileFor).
    return <img src={icon.src} alt="" draggable={false} className="w-full h-full object-cover" />;
  }
  if (icon.kind === 'emoji') return <span className="text-3xl leading-none">{icon.emoji}</span>;
  return <>{icon.letter}</>;
}

/**
 * One launcher tile.
 *
 * `wireRef` receives the card element once (React keeps the node across
 * re-renders because the list is keyed by slug), and hands it to the gesture
 * wiring in home.js. The WeakSet guard is belt-and-braces for a remount:
 * attaching the prewarm listener twice would fire two `mountFrame` calls for
 * one press.
 */
const wired = new WeakSet<Element>();

// The edit-mode remove badges (#4669), for the same reason: one native
// pointerdown stopper per button element.
const removeWired = new WeakSet<Element>();

/**
 * The launcher's loading state.
 *
 * ── It is in the PRERENDER now, and that is the whole point ───────────
 *
 * These used to wait one effect tick behind a `mounted` flag, so that the
 * first client render matched the empty `<div id="app-list">` the shell
 * prerendered — hydrating anything else is a mismatch, which `console.error`s,
 * which fails proposal checks. The cost was written off as "one frame of the
 * same blank the prerender already shows".
 *
 * It is not one frame. public/sw.js serves that prerendered document to every
 * navigation it can win, and the React bundle does not hydrate until it has
 * parsed and executed — measured at ~2.2s on a 4x-throttled cold load. For all
 * of that time the home screen showed an EMPTY launcher, which does not read
 * as "loading", it reads as "you have no apps".
 *
 * The fix is not to render them earlier on the client but to render them in
 * NODE as well: `renderToStaticMarkup(<Shell/>)` walks this same branch with
 * the same INITIAL store, so the placeholders are baked into the shipped
 * document and the first client render produces the identical tree. Same
 * agreement, one less blank screen — and the `mounted` gate goes with it,
 * because what it was protecting against no longer exists.
 *
 * ── Why eight ─────────────────────────────────────────────────────────
 *
 * Two full rows of the 4-column grid: enough to read as a launcher filling
 * up, short enough that a viewer with three apps does not watch five
 * placeholders evaporate.
 */
const SKELETON_TILES = 8;

/*
 * THE ERRORED TILE'S RETRY (QA 2026-09-24 Q9). It used to be a text button
 * pinned to the tile's top-right corner (`absolute top-2 end-2`): on a phone
 * the 56px icon, painted later with no z-index, covered it, so a tap landed on
 * the icon and did nothing; on desktop it sat about 90px from the icon, and the
 * whole tile was `grayscale` and `cursor-not-allowed`, so the one working
 * control on it looked disabled.
 *
 * It is a small filled pill in the caption lane now, beside "Error". The lane
 * is the tile's fixed 12px line (see --home-cell-h in app.css), so the pill is
 * drawn at that height and its hit area is grown by an invisible `::before`
 * rather than by padding, which would push the tile past its row. A tile with
 * Retry greys only its ICON, so "Error" and the pill keep their colour.
 * home.js's renderAppCard spells the same classes.
 */
const RETRY_BTN = 'retry-btn relative inline-flex items-center rounded-full bg-violet-600 hover:bg-violet-500 '
  + 'px-1.5 text-[11px] leading-3 font-semibold text-white cursor-pointer transition-colors '
  + "before:absolute before:-inset-x-1.5 before:-inset-y-2 before:content-[''] "
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1';

/** How long ago, in the shell's short words: "just now", "12m ago", "2h ago", "30d ago". */
function openedAgo(at: number, t: (id: string, params?: Record<string, unknown>) => string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (minutes < 1) return t('core:time.ago.justNow');
  if (minutes < 60) return t('core:time.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('core:time.ago.hours', { count: hours });
  return t('core:time.ago.days', { count: Math.floor(hours / 24) });
}

function AppCardTile({ app, style, yours, live, editing, rich = false, openedAt = null }: {
  /** Standard (WIP): under the name, the app's sentence and its contributors. */
  rich?: boolean;
  app: HomeAppView; style?: string; yours: boolean; live: boolean; editing: boolean;
  /** When this account last left the app on this device, in milliseconds; null says nothing. */
  openedAt?: number | null;
}) {
  const t = useMessages('home');
  // "Opened 2h ago" (#4025), in the caption lane a running app leaves empty:
  // a status has that lane first. Never part of the first render: the list
  // it is read from is empty until an effect fills it (recent-apps-store.js).
  // Always "30d ago" at most, never a date: lib/timestamp.ts's agoStamp turns
  // to a date past a week, and across a new year that date carries its year,
  // which a phone's tile has no room for.
  const openedWhen = openedAt && !app.statusLabel && !app.buildLine ? openedAgo(openedAt, t) : '';
  const opened = openedWhen ? t('home:grid.tile.opened', { when: openedWhen }) : '';
  const node = useRef<HTMLDivElement | null>(null);
  const wireRef = useCallback((el: HTMLDivElement | null) => {
    node.current = el;
    if (!el || wired.has(el)) return;
    wired.add(el);
    const N = controller();
    N?._wirePrewarm?.(el);
  }, [app.demo, yours]);

  useEffect(() => {
    if (!node.current) return;
    return controller()?._wireCardLongPressMenu?.(node.current);
  }, [app.slug, app.demo, yours]);

  // See the header note: the cell is an attribute so the CSSOM cannot fold
  // `grid-column` + `grid-row` into a `grid-area` shorthand. Layout effect,
  // not `useEffect`, because the tile must be in its cell in the same frame
  // it appears — a paint at the grid's default flow position is a visible
  // jump, and home.js measures cards right after a re-render.
  //
  // Keyed on `style`, so a repaint that did not MOVE the tile leaves the
  // attribute alone. That matters mid-gesture: home.js's displacement preview
  // writes `transform` onto real cards through the CSSOM, and rewriting the
  // whole attribute under it would drop the slide. When the placement does
  // change, the drop has already landed and the stale transform should go
  // with it — which is what this then does.
  useIsomorphicLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    if (style) el.setAttribute('style', style);
    else el.removeAttribute('style');
  }, [style]);

  return (
    <div
      ref={wireRef}
      className={`app-card app-card-draggable touch-pan-y relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 ${
        app.clickable ? (yours ? 'cursor-grab' : 'cursor-pointer')
          : app.showRetry ? 'cursor-not-allowed' : 'cursor-not-allowed grayscale-[0.75]'
      }`}
      data-slug={app.slug}
      data-status={app.status}
      data-locked={String(app.locked)}
      tabIndex={0}
      role="button"
      aria-label={live || opened
        ? listText([app.name, ...(live ? [liveAppLabel()] : []), ...(opened ? [opened] : [])])
        : app.name}
      aria-haspopup="menu"
      title={t('home:grid.tile.tip', { app: app.name })}
      {...(app.demo ? { 'data-demo': 'true' } : null)}
      {...(yours ? { 'data-yours': 'true' } : null)}
      {...(live ? { 'data-live': 'true' } : null)}
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement).closest('.retry-btn')
          // #4669: the edit-mode remove button owns its own press.
          || (e.target as HTMLElement).closest('.app-card-remove')) { e.stopPropagation(); return; }
        const N = controller();
        if (N) N._cardPointerType = e.pointerType;
      }}
      onPointerCancel={() => { controller()?.closeCardMenu?.(); }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.retry-btn')) return;
        e.preventDefault();
        const N = controller();
        if (!N) return;
        // Mobile browsers (Android Chrome) emit contextmenu during the same
        // held touch, so touch keeps the bail verbatim — it is the only thing
        // stopping a mid-hold double-open, and #1838 changes nothing here.
        if (N._cardPointerType === 'touch') {
          if (!N._menu) N.openCardMenu?.(app.slug, e.currentTarget);
          return;
        }
        // #1838: a mouse needs this idempotent — same tile toggles closed, a
        // different tile moves the menu in one action. Decide from the anchor
        // snapshot taken at pointerdown, NOT from whether a menu happens to
        // still be open: the kit dismisses on the right button's pointerdown,
        // and some platforms deliver contextmenu on mouse UP, so `_menu` says
        // nothing useful by the time we get here.
        if ((N._menuAnchor || N._menuAnchorAtPress) === e.currentTarget) {
          N.closeCardMenu?.();
          return;
        }
        N.openCardMenu?.(app.slug, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          controller()?.openCardMenu?.(app.slug, e.currentTarget);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // #4669: while the grid is being arranged, a tile's own activation
          // is off — arranging must never open an app by mistake.
          if (!e.repeat && app.clickable && !editing) (window as any).App?.navigateToApp(app.slug);
        }
      }}
      onClick={(e) => {
        const N = controller();
        // A completed drag (or a long-press that opened the menu) ends with
        // the pointer still on the card, so the browser fires a click right
        // after pointerup — eat it so the gesture doesn't also open the app.
        if (N?._suppressClick) { N._suppressClick = false; return; }
        const t = e.target as HTMLElement;
        if (t.closest('.retry-btn')) return;
        if (t.closest('.app-card-remove')) return;
        // #4669: a tap while editing does nothing — the grid's one job is
        // arranging, and a tile under the finger is a thing being moved, not
        // a door.
        if (editing) return;
        if (!app.clickable) return;
        (window as any).App?.navigateToApp(app.slug);
      }}
    >
      <div className={app.showRetry ? 'relative w-14 h-14 shrink-0 grayscale-[0.75]' : 'relative w-14 h-14 shrink-0'}>
        {/*
            EDIT MODE (#4669). The remove badge sits on the icon wrapper, not
            the card, so the wiggle's transform on this node and the kit's
            drag transform on the card never meet. One per tile of your own,
            never on a demo tile — their menu has no remove item either.
            The pointerdown stopper is NATIVE (ref, not a React prop) for the
            same reason home.js gives for the Discover lanes' stopDrag: React
            attaches at the root, and the kit's recognizer on #app-list has
            already claimed the event by the time a synthetic handler runs.
        */}
        {editing && yours && !app.demo ? (
          <button
            ref={(el) => {
              // Same once-per-element guard the card's own wireRef uses: an
              // inline ref runs again on every render that keeps the node,
              // and a second listener would still be only one stopPropagation,
              // but the WeakSet keeps the intent honest.
              if (!el || removeWired.has(el)) return;
              removeWired.add(el);
              el.addEventListener('pointerdown', (e) => e.stopPropagation());
            }}
            type="button"
            className="app-card-remove absolute -top-1.5 -start-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-white shadow-[0_0_0_1.5px_var(--app-sheet-line)] dark:bg-zinc-500"
            aria-label={t('home:edit.removeNamed', { app: app.name })}
            onClick={(e) => {
              e.stopPropagation();
              controller()?._editRemove?.(app.slug);
            }}
          >
            {/* No MinusIcon in the kit's set: the glyph is the minus itself,
                a text node at the badge's 20px scale. */}
            <span aria-hidden="true" className="text-[14px] leading-none font-semibold">&minus;</span>
          </button>
        ) : null}
        {/*
            The tile KEEPS its 3.5rem box — the grid's cell height, the drag
            overlay's mirror and HomeLayout's geometry are all measured
            against it, so growing it to the deck's 4rem is a layout change,
            not a reskin, and belongs in its own commit.

            No `data-tint`: the reskin gave every tile a slug-derived identity
            colour, and a launcher of six pastels reads as six unrelated
            things rather than as one shelf. `.app-icon-tile` alone is the
            single off-white face with a hairline — the same one on every
            surface, which is the point.
        */}
        <div
          className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
          data-icon={app.icon.kind}
        >
          <AppIcon icon={app.icon} />
        </div>
        {/*
            A VERSION OF ANOTHER APP (docs/plans/versions.md): "Made from
            <original>" as the badge's name and tooltip, on the icon's
            bottom-left corner. It was an amber disc with the ⑂ fork sign;
            the word on screen is "version" now, never "fork", and a note
            about where an app came from is not a status, so it wears the
            audience badge's quiet face beside it (white, a hairline, muted
            ink) with a glyph of one tile over another. `.fork-tag` stays:
            a declared check finds the badge by it.
        */}
        {app.forkName ? (
          <span
            className="fork-tag absolute -bottom-1 -start-1 w-5 h-5 flex items-center justify-center rounded-full bg-white text-zinc-600 shadow-[0_0_0_1.5px_var(--app-sheet-line)] dark:bg-zinc-800 dark:text-zinc-300"
            title={app.forkDeleted ? t('home:grid.tile.remixedFromDeleted', { open: '<', close: '>' }) : t('home:grid.tile.remixedFrom', { app: app.forkName })}
            aria-label={app.forkDeleted ? t('home:grid.tile.remixedFromDeleted', { open: '<', close: '>' }) : t('home:grid.tile.remixedFrom', { app: app.forkName })}
          >
            <CopyIcon className="w-3 h-3" aria-hidden="true" />
          </span>
        ) : null}
        {/* #2902: still loaded — opening it resumes it as it was left. */}
        {live ? <LiveAppDot className="app-card-live-dot" /> : null}
        {/*
            WHERE IT LIVES (communities, stage 4): people for a Private
            community, a lock for a project that is Just you, and nothing for
            a Public community, which is what most tiles are. The icon's
            bottom-right corner, the one
            the fork tag (bottom-left) and the live dot (top-right) leave.
        */}
        {app.audience !== 'open' ? (
          <span
            className="app-card-stage absolute -bottom-1 -end-1 w-5 h-5 flex items-center justify-center rounded-full bg-white text-zinc-600 shadow-[0_0_0_1.5px_var(--app-sheet-line)] dark:bg-zinc-800 dark:text-zinc-300"
            data-stage={app.audience}
            title={app.audience === 'invited' ? t('home:grid.tile.audience.invited') : t('home:grid.tile.audience.solo')}
            aria-label={app.audience === 'invited' ? t('home:grid.tile.audience.invited') : t('home:grid.tile.audience.solo')}
          >
            {app.audience === 'invited'
              ? <UserGroupIcon className="w-3 h-3" aria-hidden="true" />
              : <LockIcon className="w-3 h-3" aria-hidden="true" />}
          </span>
        ) : null}
      </div>
      <div className="w-full min-w-0">
        <div className="app-card-title" title={app.name}>{app.name}</div>
        {app.statusLabel && app.showRetry ? (
          <div className="app-card-retry flex items-center justify-center gap-1">
            <p
              className="app-card-status text-[color:var(--state-blocked)]"
              {...(app.failureReason ? { title: app.failureReason } : null)}
            >
              {app.statusLabel}
            </p>
            <button
              type="button"
              className={RETRY_BTN}
              data-slug={app.slug}
              aria-label={t('home:grid.tile.retryNamed', { app: app.name })}
              onClick={(e) => { e.stopPropagation(); controller()?._onRetry?.(app.slug, e.currentTarget); }}
            >
              {t('core:common.retry')}
            </button>
          </div>
        ) : app.buildLine ? (
          // #4053: the first version's build line, in the tile's words.
          <p className={buildLineTileClass(app.buildLine)} data-build-line={app.buildLine}>
            {app.statusLabel}
          </p>
        ) : app.statusLabel ? (
          <p
            className={`app-card-status ${app.isAwaiting ? 'text-[color:var(--state-attention)]' : 'text-[color:var(--state-blocked)]'}`}
            {...(app.failureReason ? { title: app.failureReason } : null)}
          >
            {app.statusLabel}
          </p>
        ) : null}
        {rich && !app.statusLabel ? (
          <>
            {app.description ? <p className="app-card-desc" title={app.description}>{app.description}</p> : null}
            {app.members ? (
              <p className="app-card-people">
                <UserGroupIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{t('home:grid.tile.members', { count: app.members, formatted: app.members.toLocaleString() })}</span>
              </p>
            ) : null}
            {app.contributors ? (
              <p className="app-card-people">
                <UserPenIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{t('home:discover.card.contributors', { count: app.contributors })}</span>
              </p>
            ) : null}
          </>
        ) : null}
        {/* Two forms, switched by app.css at the tile's own 640px breakpoint:
            a phone's text lane is narrower than the sentence, and a line
            that is only a time is never cut. The tile's aria-label has the
            sentence at every width. */}
        {opened ? (
          <p className="app-card-status app-card-opened">
            <span className="app-card-opened-long">{opened}</span>
            <span className="app-card-opened-short">{t('home:grid.tile.openedShort', { when: openedWhen })}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Your apps" with nothing in it says nothing (the owner, 6 October 2026): a
 * new account's Home is the New project tile alone, which says what to do,
 * and the "Look around first" tour points at it. It used to carry the line
 * "No apps added yet. Make one with New project, or find one in the Discover
 * section." (#2564), which told a new account what the tile beside it
 * already showed. A failed load and a search that matched nothing keep their
 * own lines.
 */
export function AppGrid() {
  const t = useMessages('home');
  const state = useStoreState(gridStore);
  // Standard (WIP), lib/skin.ts: the tile also says what the app is.
  const rich = useLiveSkin() === 'wip';
  const live = useLiveAppSlugs();
  // When each app was last left on this device, for the tiles' "Opened" line.
  const { apps: recents } = useStoreState(recentAppsStore);
  const openedTimes = useMemo(() => recentAppTimes(recents), [recents]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // `grid-template-rows` is written to the ELEMENT rather than rendered as a
  // style prop for one reason: app.css's `grid-auto-rows` must remain the only
  // row sizing when the template is '' (desktop and the search view), and an
  // empty `style={{gridTemplateRows: ''}}` still emits a style attribute that
  // reads as an author-level override. Writing it imperatively lets '' mean
  // "remove the declaration", which is what the string version's
  // `listEl.style.gridTemplateRows = ''` did.
  useIsomorphicLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.style.gridTemplateRows = state.rowTemplate;
  }, [state.rowTemplate]);

  // The kit's placement recognizer, re-attached whenever the canvas it
  // measures against changes. home.js owns every callback (the geometry is
  // its); this owns only WHEN the attachment happens, which used to be the
  // tail of _wireCards. Detach on unmount so a remount cannot leave two
  // recognizers fighting for the same gesture.
  const canDrag = state.view === 'grid' && state.ready;

  useEffect(() => {
    const el = listRef.current;
    const N = controller();
    if (!el || !N) return undefined;
    N._attachGridPlacement?.(el, canDrag);
    return () => { N._detachGridPlacement?.(); };
  }, [canDrag, state.items.length, state.rowTemplate]);

  // Everything below runs AFTER the grid has painted, exactly where the tail
  // of the old Home.render() ran it.
  useEffect(() => {
    if (!state.ready) return;
    const N = controller();
    const el = listRef.current;
    if (el) { N?._maybeOpenShotMenu?.(el); }
    N?._searchReveal?.sync?.();
    if (el) N?._maybeShowShotGrid?.(el);
    // And the one for the drop into the Homeroom widget strip (#2894).
    if (el) N?._maybeShowShotWidgetDrop?.(el);
  });

  return (
    <div
      ref={listRef}
      id="app-list"
      // FOUR COLUMNS STAY FOUR (Home.currentCols, HomeLayout.COLS: a stored
      // layout is keyed by its column count), and they share the column's whole
      // width like every section under them. A 40rem cap held them to the left
      // (overnight audit W06 / D18) and left a block empty on their right; #6154
      // asked for it gone. A tile's icon and name keep their size, centred in
      // a wider cell.
      className="grid grid-cols-4 gap-1.5 sm:gap-2 p-2 pt-1.5 sm:p-3 sm:pt-2"
      data-view={state.ready ? state.view : undefined}
      // EDIT MODE (#4669). app.css keys the wiggle on this attribute; absent
      // otherwise, so the resting grid's markup is untouched.
      data-editing={state.editing ? 'true' : undefined}
    >
      {state.notice && state.notice.tone === 'error' ? (
        // #1899: a failed load is the shared error card, with a Retry.
        <AppsLoadError
          className="col-span-full"
          title={state.notice.text}
          onRetry={() => controller()?.load?.()}
        />
      ) : state.notice ? (
        <div className="col-span-full p-4 text-sm text-zinc-500 dark:text-zinc-400">
          {state.notice.text}
        </div>
      ) : null}
      {state.emptyQuery !== null ? (
        <div className="col-span-full py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {t('home:grid.noMatches', { query: state.emptyQuery })}
        </div>
      ) : null}
      {state.resultsHeading ? (
        <div className="home-section-header col-span-full">{state.resultsHeading}</div>
      ) : null}
      {!state.ready && !state.notice ? (
        <TileSkeleton
          n={SKELETON_TILES}
          label={t('home:grid.loading')}
          className="col-span-full grid grid-cols-4 gap-1.5 sm:gap-2"
        />
      ) : null}
      {state.items.map((item) => (
        <AppCardTile
          key={`card:${item.app.slug}`}
          app={item.app}
          style={cellStyle(item)}
          yours={state.view === 'grid'}
          live={live.includes(item.app.slug)}
          editing={state.editing}
          rich={rich}
          openedAt={state.view === 'grid' && !item.app.demo ? openedTimes.get(item.app.slug) ?? null : null}
        />
      ))}
      {/*
          "Create an app", the grid's LAST child (./create-tile.tsx). Null
          until Home.render() has painted the launcher — the store's initial
          value — so the prerender and the first client render agree on this
          node's children. Its cell comes from the same paint as the tiles'.

          In EDIT MODE (#4669) it stays exactly what it is at rest — same
          face, same label, same cell — so the shelf's last tile never
          changes identity under the viewer. The mode's other entry, the
          "Add apps" sheet, lives in the heading's action seat instead
          (index.tsx), beside "Done".

          A held-back tile (#4757) draws nothing HERE: that grid state's
          compact New project entry rides the My apps heading (#5825; it was
          on the "Show all N apps" line before), outside this canvas, so the
          markup in every state is what it was.
      */}
      {state.create && !state.create.heldBack && !state.create.inCard ? (
        <CreateTile view={state.create} style={placementStyle(state.create.placement)} />
      ) : null}
    </div>
  );
}
