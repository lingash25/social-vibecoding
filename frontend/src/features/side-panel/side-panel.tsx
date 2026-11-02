/**
 * #platform-side-panel — the panel beside a running app, on a desktop-width
 * window. ./controller.ts carries the whole of why and how; this is its
 * markup.
 *
 * ── The first render is the prerender, exactly ────────────────────────
 *
 * The store is at its initial state at hydration — closed, no frame, no
 * title — and nothing writes it before App.init has run. So this renders the
 * same markup the static document carries: the root hidden, the header row's
 * four controls with Back hidden, an empty title and an empty body. The
 * `hidden` classes are CONSTANT in the rendered className and toggled through
 * refs (lib/legacy-dom.ts useHiddenClass), never derived from the store in
 * render — the rule every island in this shell keeps.
 *
 * ── The frame ──────────────────────────────────────────────────────────
 *
 * The <iframe> exists only while there is a panel document (`frameSrc`), and
 * it is created ONCE per panel: keyed by `frameKey`, its `src` constant for
 * its whole life. Every later page is a navigation INSIDE it (the controller
 * talks to its document), because a new `src` would be a reload. It is the
 * body's first child and the spinner the second, so the spinner coming and
 * going can never move it.
 *
 * ── The header row ─────────────────────────────────────────────────────
 *
 * Back, the page's title, Expand, Close — the shell's own Button primitive
 * and glyphs, in the header's disc style (the app header's ✕ is the same
 * disc), so the row reads as the platform's rather than as the page's.
 *
 * ── Beside the AI tab's page: that page's own column (29 Oct 2026) ─────
 *
 * There the panel is in Main's place, the chat docked beside the list, and
 * is drawn as that column rather than as a panel of its own (Evan: "not in
 * a new side panel that can be maximized and has its own Workshop back
 * button"): ‹ Main Chat, which gives Main its place back, and the project the
 * page is in, which opens it; no title, Expand, Close, Back or divider, and
 * the page in it leaves out its own "‹ Workshop" (controller BESIDE_AI_CLASS).
 * Both rows are always rendered and app.css shows the one that applies
 * (`body:has(#ai-screen:not(.hidden))`), so the prerender is one markup.
 *
 * ── The divider (#2886) ────────────────────────────────────────────────
 *
 * The panel's left edge is a handle: drag it (or focus it and use the arrow
 * keys) to share the window differently between the app and the panel, and
 * double-click it to go back to the default. ./resize.ts carries the width's
 * rules. Its first render is the prerender too — no width, no value — and
 * the stored width is read in an effect, never in render.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon, ExpandIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { SidePanel as controller } from './controller';
import { panelPage, titleFor } from './routes';
import {
  KEY_STEP,
  applyWidth,
  bounds,
  clampWidth,
  clearStoredWidth,
  probeLayout,
  readStoredWidth,
  inlineStartOf,
  shownWidth,
  writeStoredWidth,
} from './resize';
import { sidePanelRefs, sidePanelStore } from './store.js';
import { dirSign } from '../../lib/i18n/direction';

/** The app header's round control, as its #back-btn draws it — less its
 *  display, which the two ways of drawing it below each supply. */
const DISC_BOX = 'items-center justify-center w-7 h-7 shrink-0 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

/** Expand and Close: always there. */
const DISC = `inline-flex ${DISC_BOX}`;

/**
 * Back: SHIPS HIDDEN, and `hidden` cannot share a className with
 * `inline-flex` here — the Button primitive merges its classes with
 * tailwind-merge, which keeps only the last display utility and would drop
 * `hidden` from the prerender. So Back carries no display utility at all:
 * `hidden` while there is nowhere to go (toggled through its ref), and
 * app.css's `.side-panel-head > #side-panel-back:not(.hidden)` supplies the
 * inline-flex the other two spell out.
 */
const BACK = `hidden ${DISC_BOX}`;

export function SidePanel(): ReactNode {
  const t = useMessages('agent');
  const s = useStoreState(sidePanelStore);
  const rootRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const loadingRef = useRef<HTMLDivElement | null>(null);

  useHiddenClass(rootRef, !(s.open && !!s.frameSrc));
  useHiddenClass(backRef, !s.canBack);
  useHiddenClass(loadingRef, !s.loading);

  // React detaches the old frame's ref before it attaches a new one, so this
  // always holds the frame on screen, or null.
  const frameRef = useCallback((el: HTMLIFrameElement | null) => {
    sidePanelRefs.frame = el;
  }, []);

  return (
    <aside
      id="platform-side-panel"
      ref={rootRef}
      className="side-panel hidden"
      aria-labelledby="side-panel-title"
    >
      <SidePanelDivider panelRef={rootRef} shown={s.open && !!s.frameSrc} />
      <div className="side-panel-head flex items-center gap-2 shrink-0">
        <Button
          id="side-panel-back"
          ref={backRef}
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={BACK}
          aria-label={t('core:common.back')}
          title={t('core:common.back')}
          onClick={() => controller.back()}
        >
          <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
        </Button>
        <h2
          id="side-panel-title"
          className="flex-1 min-w-0 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100"
        >
          {s.title}
        </h2>
        <Button
          id="side-panel-expand"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label={t('agent:sidePanel.expandLabel')}
          title={t('agent:sidePanel.expand')}
          onClick={() => controller.expand()}
        >
          <ExpandIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button
          id="side-panel-close"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label={t('agent:sidePanel.close')}
          title={t('agent:sidePanel.close')}
          onClick={() => controller.close()}
        >
          <XIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
        {/* Beside the AI tab's page only (app.css): ‹ Main Chat, which gives
            Main its place back, and the column's heading as Main's own reads,
            the project's tile, what is open, and its project and number
            (30 Oct 2026). The chip is the topic's own back chip. */}
        <button
          type="button"
          className="side-panel-main dev-topic-back un-touch-target"
          aria-label={t('agent:sidePanel.mainLabel')}
          onClick={() => controller.close()}
        >
          <ChevronLeftIcon className="dev-topic-back-icon" aria-hidden="true" />
          <span>{t('agent:sidePanel.main')}</span>
        </button>
        <PanelHeading route={s.route} place={s.place} reported={s.reported} label={s.label} />
      </div>
      <div id="side-panel-body" className="side-panel-body">
        {/* data-un-keyboard-relay: a tap in the panel that closes the
            keyboard is reported here, so the app beside it puts its field
            away too (the kit, native.js; request #4314). */}
        {s.frameSrc ? (
          <iframe
            key={s.frameKey}
            ref={frameRef}
            id="side-panel-frame"
            title={t('agent:sidePanel.frameTitle')}
            src={s.frameSrc}
            className={s.loading ? 'side-panel-frame' : 'side-panel-frame side-panel-frame-ready'}
            data-un-keyboard-relay=""
          />
        ) : null}
        <div
          id="side-panel-loading"
          ref={loadingRef}
          className="side-panel-loading hidden"
          aria-hidden="true"
        >
          <div className="dc-status-spinner-arc side-panel-spinner"></div>
        </div>
      </div>
    </aside>
  );
}

type Place = { slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null };

/** Which "Project · …" line a page's route reads as, and its number. */
function whereOf(route: string): { id: string; number: number | null } {
  const m = route.match(/\/dev\/(issues|changes|proposals|sessions|shared|governance)\/(\d+)/);
  if (!m) return { id: 'agent:sidePanel.where.project', number: null };
  if (m[1] === 'issues') return { id: 'agent:sidePanel.where.request', number: Number(m[2]) };
  if (m[1] === 'governance') return { id: 'agent:sidePanel.where.decision', number: null };
  return { id: 'agent:sidePanel.where.change', number: Number(m[2]) };
}

/**
 * The column's heading beside the AI tab's page, as Main's own header reads
 * (30 Oct 2026): the project's tile, then what is open, over its project and
 * its number. The title is the door's (the row that opened it) while the
 * panel is still on that page; after a link inside the panel, the page's own
 * (its kind, for a piece of work). The project's name is a link to its page
 * (its Hub). Its tile and name are the ones the door named, while the page is
 * still in that project; after a link to another one, the name its page
 * reported. Only the title on a page that is in no project.
 */
function PanelHeading({ route, place, reported, label }: {
  route: string | null; place: Place | null; reported: string; label: { route: string; text: string } | null;
}): ReactNode {
  const t = useMessages('agent');
  if (!route) return null;
  const slug = panelPage(route)?.slug || null;
  const same = !!place && place.slug === slug;
  const project = slug ? ((same ? place!.name : '') || String(reported || '').trim() || slug) : '';
  const title = (label && label.route === route && label.text) || titleFor(route, reported);
  const where = whereOf(route);
  return (
    <div className="side-panel-place">
      {same ? (
        <span className="app-icon-tile w-8 h-8 shrink-0 rounded-[10px] overflow-hidden flex items-center justify-center font-bold text-sm" data-icon={appIconKind(place as any)} aria-hidden="true">
          <AppIconContent app={place as any} />
        </span>
      ) : null}
      <span className="min-w-0 flex flex-col">
        <span className="side-panel-place-title truncate">{title}</span>
        {slug ? (
          <span className="side-panel-place-where truncate">
            <RichMessage
              id={where.id}
              values={{ project, number: where.number }}
              components={[
                <a
                  className="side-panel-place-link"
                  href={`#app/${encodeURIComponent(slug)}/workshop`}
                  aria-label={t('agent:sidePanel.openProject', { project })}
                  onClick={() => {
                    // A door to the project: its Hub, not the tab its page was last on.
                    try { (window as any).AppView?._landOnHub?.(slug); } catch { /* the page as it opens */ }
                  }}
                />,
              ]}
            />
          </span>
        ) : null}
      </span>
    </div>
  );
}

interface WidthRange {
  now: number;
  min: number;
  max: number;
}

/**
 * The handle on the panel's left edge. A `separator` whose value is the
 * panel's width in pixels: the arrows move the divider the way they point
 * (Left widens the panel), Home and End go to the narrowest and the widest,
 * and a double-click forgets the chosen width.
 *
 * The value is published only once it is known — after mount, while the panel
 * is on screen — so the prerender and the first client render carry none.
 *
 * The Homeroom bot page's Main is the same column (features/ai, 30 Oct
 * 2026): its left edge is this handle too, with its own `id` and the pane it
 * controls, and it sets the same width.
 */
export function SidePanelDivider({
  panelRef,
  shown,
  id = 'side-panel-divider',
  controls = 'platform-side-panel',
}: {
  panelRef: RefObject<HTMLElement | null>;
  shown: boolean;
  id?: string;
  controls?: string;
}): ReactNode {
  const t = useMessages('agent');
  const [range, setRange] = useState<WidthRange | null>(null);
  const drag = useRef<{ id: number; startX: number; startW: number; width: number | null } | null>(null);

  // What is on screen now: the stored width, held inside this window, or the
  // stylesheet's default when there is none. Never writes the store — a
  // window that narrows gives the width back, and one that grows returns it.
  const settle = useCallback(() => {
    const probe = probeLayout();
    const b = bounds(probe);
    const stored = readStoredWidth();
    applyWidth(stored == null ? null : clampWidth(stored, b));
    const panel = panelRef.current;
    // Its width as chosen, which on the Duo held sideways leaves out the
    // column of system chrome it runs under (./resize.ts).
    const box = panel ? panel.getBoundingClientRect() : null;
    const now = box && box.width > 0 ? shownWidth(inlineStartOf(box), probe) : 0;
    setRange(now > 0 ? { now, ...b } : null);
  }, [panelRef]);

  useEffect(() => {
    settle();
    if (!shown) return undefined;
    window.addEventListener('resize', settle);
    return () => window.removeEventListener('resize', settle);
  }, [shown, settle]);

  // A drag that never ended (the island unmounting mid-drag) must not leave
  // the whole document stuck in the resize cursor.
  useEffect(() => () => {
    document.documentElement.classList.remove('side-panel-resizing');
  }, []);

  const set = (width: number, persist: boolean): number => {
    const b = bounds(probeLayout());
    const next = clampWidth(width, b);
    applyWidth(next);
    setRange({ now: next, ...b });
    if (persist) writeStoredWidth(next);
    return next;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags while over the handle */ }
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startW: shownWidth(inlineStartOf(panel.getBoundingClientRect()), probeLayout()),
      width: null,
    };
    // Frames swallow pointer events that cross them; while a drag is on, the
    // app's and the panel's both stand aside (app.css).
    document.documentElement.classList.add('side-panel-resizing');
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // The panel is pinned to the inline-end edge, so moving toward inline-start
    // widens it: left in English, right in Arabic.
    d.width = set(d.startW + (d.startX - e.clientX) * dirSign(), false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    document.documentElement.classList.remove('side-panel-resizing');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // A press that never moved is half of a double-click, not a choice.
    if (d.width != null) writeStoredWidth(d.width);
  };

  const onDoubleClick = () => {
    clearStoredWidth();
    settle();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const now = shownWidth(inlineStartOf(panel.getBoundingClientRect()), probeLayout());
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = now + step * dirSign();
    else if (e.key === 'ArrowRight') next = now - step * dirSign();
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = Number.POSITIVE_INFINITY;
    if (next == null) return;
    e.preventDefault();
    set(next, true);
  };

  return (
    <div
      id={id}
      className="side-panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={t('agent:sidePanel.resize')}
      aria-valuenow={range ? range.now : undefined}
      aria-valuemin={range ? range.min : undefined}
      aria-valuemax={range ? range.max : undefined}
      title={t('agent:sidePanel.resizeTitle')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    ></div>
  );
}
