/**
 * `#dc-session-header`'s children — the dev chat's top strip.
 * See ./session-header-store.ts for what stays the module's and why.
 */

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { EllipsisHorizontalIcon, EyeIcon, LockIcon, PencilSparklesIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import {
  sessionHeaderStore,
  type MergeLife,
  type SessionHeaderState,
} from './session-header-store';
import type { SessionAction } from './session-list-store';
import { dirSign } from '../../lib/i18n/direction';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

function platformUi(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * `MergeStatus.pillHtml`'s markup, drawn from the descriptor rather than from
 * a string.
 *
 * The text is assembled into ONE run before it is rendered, which is not
 * tidiness: the string version emitted `glyph + ' ' + label` as a single text
 * node, and splitting it into two JSX children would put a comment separator
 * between them in the server-rendered pass. Same for the space that precedes
 * the advisory chip — it belongs to the label's text node, exactly as the
 * template wrote it.
 */
export function MergeStatusPill({ life }: { life: MergeLife }): ReactNode {
  const t = useMessages('devchat');
  if (!life || !life.label) return null;
  const votes = life.key === 'in_vote' ? life.votes : null;
  const advisory = votes && votes.advisory > 0 ? votes.advisory : 0;
  let text = life.glyph ? `${life.glyph} ` : '';
  text += votes ? `${life.label} · ${votes.yes}/${votes.majority}` : life.label;
  if (advisory) text += ' ';
  return (
    <span className={`ms-pill ms-pill-${life.tone || 'neutral'}`} title={life.title || undefined}>
      {life.spinner ? <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span> : null}
      {text}
      {advisory ? (
        <span
          className="ms-advisory"
          title={t('devchat:header.advisoryVotes', { count: advisory })}
        >
          {`+${advisory}`}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The venue dropdown, top right.
 *
 * `data-venue-change` is the hook every caller already looked the old
 * "change how this is built" link up by, and three of them still resolve this
 * button by id at call time to anchor the sheet against — so the id, the
 * attributes and the position all stay exactly as `selectorHtml` wrote them.
 */
function VenueSelect({ venue }: { venue: NonNullable<SessionHeaderState['venue']> }): ReactNode {
  const t = useMessages('devchat');
  const busyTitle = t('devchat:header.venue.busyTitle');
  return (
    <button
      type="button"
      id="dc-venue-select"
      className="dc-venue-select"
      data-venue-change="1"
      data-venue-current={venue.id}
      data-venue-busy={venue.disabled ? '1' : undefined}
      aria-haspopup="menu"
      aria-label={venue.disabled ? t('devchat:header.venue.busyLabel', { venue: venue.label }) : undefined}
      disabled={venue.disabled}
      title={venue.disabled ? busyTitle : venue.title}
      onClick={venue.disabled
        ? undefined
        : (e: MouseEvent<HTMLButtonElement>) => controller()?.openVenueSheet?.(e.currentTarget)}
    >
      <span className="dc-venue-name">{venue.label}</span>
      {venue.disabled ? (
        <span className="dc-venue-busy" aria-hidden="true">
          <LockIcon className="dc-venue-busy-icon" />
          <span>{t('devchat:header.venue.thinking')}</span>
        </span>
      ) : (
        <span className="dc-venue-caret" aria-hidden="true">{'▾'}</span>
      )}
    </button>
  );
}

/**
 * The doing<->seeing switch — the Figma session bar's quick loop.
 *
 * ── Why it is here and not in the header ───────────────────────────────
 *
 * It was an eye/pencil PAIR in the platform header's right slot, where it
 * displaced Improve. That slot is gone entirely — Improve became the header's
 * standing action and then a row of the app's own menu (#2718) — and this loop
 * belongs beside the name of the change it acts on anyway: it is the only
 * genuinely contextual control the product has, and a dev session is the only
 * place it means anything.
 *
 * ── What it says ──────────────────────────────────────────────────────
 *
 * ── ONE control, not two buttons ──────────────────────────────────────
 *
 * A segmented switch on the iOS model: a single track with a THUMB that
 * slides between the two segments, rather than two pills that swap fills.
 * The difference matters because the two states are one choice — you are
 * either seeing the change or building it — and two independently-filled
 * pills read as two buttons that happen to sit together.
 *
 * The thumb is measured rather than fixed at 50%, because the segments are
 * NOT equal width: the current one carries a label and the other collapses to
 * a bare glyph, which is what keeps the strip usable at 375px next to the
 * change's name and the venue. A layout effect reads the active segment's
 * offset and width and hands them to the thumb as CSS variables; the thumb
 * animates `transform` and `width`, so the label growing and the fill
 * travelling are one movement.
 *
 * ── What the thumb says ───────────────────────────────────────────────
 *
 * The EYE opens the staging preview (seeing); the pencil-sparkles brings the
 * chat back (doing). The thumb is yellow under the eye and accent blue under
 * the pencil, and WHICHEVER segment it is under carries the label — `Preview`
 * one side, `Building` the other. Symmetrical on purpose: the label belongs
 * to the thumb, so a switch that reads `Preview` in one position has to read
 * `Building` in the other, or the control looks like it lost its word.
 *
 * `Building` used to appear only while an AI turn was in flight, on the
 * reasoning that "you are in the chat and nothing is running" is not news.
 * That made the two sides asymmetric — the thumb sat wordless half the time —
 * and a busy turn already announces itself in the transcript and the header's
 * status pill. The label keeps `#dc-mode-chip`'s id so the one thing that read
 * it still resolves.
 *
 * ── The gate ──────────────────────────────────────────────────────────
 *
 * No staging preview, no switch: a change has no preview until one is built,
 * and the rest of the platform already treats this eye as exactly that gated
 * affordance (AppView.cardPreviewHtml renders its eye only for a session with
 * a `staging_url`). With nothing to see there is no loop to draw, so the
 * strip falls back to the bare `Building` chip it used to carry.
 */
function ModeSwitch({ busy }: { busy: boolean }): ReactNode {
  const t = useMessages('devchat');
  const { previewSessionId, previewUrl, previewBuildable, previewActive } = useStoreState(improveStore) as {
    previewSessionId: number | null; previewUrl: string | null;
    previewBuildable: boolean; previewActive: boolean;
  };
  // #2069: a live preview OR one the click can build. ensure-staging rebuilds
  // from the branch's latest commit and has authorized this case since #439;
  // only this gate had not caught up, so the single control that would restore
  // a missing preview disappeared exactly when the preview went missing.
  const hasPreview = !!previewUrl || !!previewBuildable;
  const seeing = !!previewActive;
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const eyeRef = useRef<HTMLButtonElement | null>(null);
  const penRef = useRef<HTMLButtonElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  // Measure AFTER the labels have laid out — the active segment's width is
  // its text's, so this cannot be computed ahead of the paint. `seeing` and
  // `busy` are the two inputs that change which segment is wide.
  useIsomorphicLayoutEffect(() => {
    if (!hasPreview) { setThumb(null); return undefined; }
    const measure = () => {
      const active = seeing ? eyeRef.current : penRef.current;
      if (!active) return;
      // The thumb sits at `start-0`, so in Arabic it moves from the right edge.
      const parentW = (active.offsetParent as HTMLElement | null)?.clientWidth ?? 0;
      const x = dirSign() === -1 ? active.offsetLeft + active.offsetWidth - parentW : active.offsetLeft;
      setThumb({ x, w: active.offsetWidth });
    };
    measure();
    // The label is text, so a font swap or a width change under it moves the
    // thumb — the same reason the docked staging panel watches its slot.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && trackRef.current) ro.observe(trackRef.current);
    return () => ro?.disconnect();
  }, [seeing, busy, hasPreview]);

  // #1594: with no preview to switch to, Building is status, not an action.
  // Keep it compact and neutral; the accent-filled controls remain clickable.
  //
  // #2069 narrows "no preview to switch to": a session whose branch has a
  // commit HAS one to switch to, it just has to be built first. Only a session
  // with nothing to build falls through to the status chip.
  if (!hasPreview) {
    if (!busy) return null;
    return (
      <span
        id="dc-mode-chip"
        role="status"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-100 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 shrink-0 cursor-default"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
        {t('devchat:header.mode.building')}
      </span>
    );
  }

  const SEG_ON = 'relative z-10 flex items-center gap-1 h-6 rounded-full py-1 pe-2.5 ps-1.5 '
    + 'text-xs font-semibold un-touch-target';
  const SEG_OFF = 'relative z-10 flex items-center justify-center h-6 w-6 rounded-full '
    + 'text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 un-touch-target';

  return (
    <span
      id="dc-mode-switch"
      ref={trackRef}
      className="relative shrink-0 flex items-center rounded-full bg-zinc-200 p-0.5 dark:bg-zinc-800"
      role="group"
      aria-label={t('devchat:header.mode.groupLabel')}
    >
      {/* THE THUMB. One element for both states, so the fill travels rather
          than one pill vanishing and another appearing. Hidden until the
          first measurement lands, which is the same frame. */}
      <span
        aria-hidden="true"
        className={'absolute top-0.5 bottom-0.5 start-0 rounded-full transition-[transform,width] '
          + 'duration-200 ease-out '
          + (thumb ? '' : 'opacity-0 ')
          + (seeing ? 'bg-amber-300' : 'bg-violet-600')}
        style={thumb
          ? { transform: `translateX(${thumb.x}px)`, width: `${thumb.w}px` }
          : undefined}
      >
      </span>
      <button
        id="app-eye-btn"
        ref={eyeRef}
        type="button"
        className={seeing ? `${SEG_ON} text-zinc-900` : SEG_OFF}
        aria-label={previewUrl ? t('devchat:header.mode.previewLabel') : t('devchat:header.mode.buildPreviewLabel')}
        aria-pressed={seeing ? 'true' : 'false'}
        title={previewUrl
          ? t('devchat:header.mode.previewTitle')
          : t('devchat:header.mode.buildPreviewTitle')}
        onClick={() => {
          if (seeing) return;
          (window as any).AppView?.swapToStagingForSession?.(previewSessionId, previewUrl);
        }}
      >
        <EyeIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {seeing ? <span id="dc-mode-chip">{t('devchat:header.mode.preview')}</span> : null}
      </button>
      <button
        id="session-build-btn"
        ref={penRef}
        type="button"
        className={seeing ? SEG_OFF : `${SEG_ON} text-white`}
        aria-label={t('devchat:header.mode.backToBuilding')}
        aria-pressed={seeing ? 'false' : 'true'}
        title={t('devchat:header.mode.backToChat')}
        onClick={() => {
          if (!seeing) return;
          (window as any).AppView?.closeStagingOverlay?.();
        }}
      >
        <PencilSparklesIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {!seeing ? <span id="dc-mode-chip">{t('devchat:header.mode.building')}</span> : null}
      </button>
    </span>
  );
}

/**
 * The session's own actions — Pause / Free worker / Resume / Unarchive /
 * Archive — behind a ⋯ at the strip's right edge (#1904).
 *
 * ── Why a menu, and why these rows ────────────────────────────────────
 *
 * Those buttons live on the session's row in the list, and opening the
 * session put every one of them out of reach: the strip carried the name,
 * the PR link, the venue and the mode switch, and nothing that acted on the
 * session itself. The rows here are THE LIST'S — `DevChat._sessionRow`
 * decides them once and the store carries them (see
 * ./session-header-store.ts) — so the two surfaces cannot disagree about
 * what is offered or how Archive is gated, and each row dispatches the same
 * `DevChat` method by name the list's button does, confirm dialog included.
 *
 * ── One call, both idioms ─────────────────────────────────────────────
 *
 * `PlatformUI.menu` is the venue dropdown's own presenter (BuildVenues.open):
 * a bottom action sheet on touch, an anchored popover on desktop, from one
 * actionSheet-shaped call. The rows are handed to the kit rather than
 * rendered here for the reason that sheet gives — the kit reparents what it
 * is handed, and a React subtree under it would reconcile against a parent
 * that no longer holds it.
 *
 * With nothing to offer — a viewer who does not own the session, a merged
 * one — there is no button at all, rather than a menu with no rows.
 */

/** A row as `PlatformUI.menu` takes it — the kit's own actionSheet shape. */
export interface SessionActionItem {
  label: string;
  title?: string;
  destructive: boolean;
  handler: () => void;
}

/**
 * The rows the ⋯ hands the kit, from the store's actions. Each `handler` is
 * the list button's click: the named `DevChat` method, with the row's own
 * args — so Archive still goes through `_sessionListArchive`'s confirm, and
 * Free worker still answers "Worker freed". The list flashed that answer on
 * the button it was about to replace; a menu row is gone by then, so the
 * answer becomes a toast.
 */
export function sessionActionItems(actions: SessionAction[]): SessionActionItem[] {
  return actions.map((a) => ({
    label: a.label,
    ...(a.title ? { title: a.title } : null),
    destructive: a.tone === 'danger',
    handler: () => {
      const dc = controller();
      if (!dc || typeof dc[a.fn] !== 'function') return;
      void Promise.resolve(dc[a.fn](...a.args)).then((flash: unknown) => {
        if (flash) platformUi()?.toast?.(String(flash));
      });
    },
  }));
}

/**
 * Present the rows against the trigger. Resolves once the menu has settled
 * — a pick or a dismissal — which is what the trigger's `aria-expanded`
 * follows. Nothing to present without the kit, the same silent degradation
 * the venue sheet has.
 */
export async function openSessionActionsMenu(
  actions: SessionAction[],
  anchorEl?: HTMLElement | null,
): Promise<void> {
  const pu = platformUi();
  if (!pu || typeof pu.menu !== 'function') return;
  await pu.menu({ anchorEl: anchorEl || undefined, items: sessionActionItems(actions) });
}

function SessionActionsMenu({ actions }: { actions: SessionAction[] }): ReactNode {
  const [open, setOpen] = useState(false);
  const t = useMessages('devchat');
  if (!actions.length) return null;
  return (
    <button
      type="button"
      id="dc-session-actions"
      className={'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full '
        + 'text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900 '
        + 'dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 un-touch-target'}
      data-session-actions="1"
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={t('devchat:header.actions')}
      title={t('devchat:header.actions')}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (open) return;
        setOpen(true);
        void openSessionActionsMenu(actions, e.currentTarget).finally(() => setOpen(false));
      }}
    >
      <EllipsisHorizontalIcon className="w-4 h-4" aria-hidden="true" />
    </button>
  );
}

export function SessionHeader({ embedded = false }: { embedded?: boolean }): ReactNode {
  const s = useStoreState(sessionHeaderStore);
  const t = useMessages('devchat');
  return (
    <>
      {/* The in-strip ← retired (Streamlined Concept): the platform header's
          own back arrow leads the session bar now — App.setBackIcon('arrow',
          '#app/<slug>/board') on the way in, DevChat.handleBack on the way
          out. One back control, in the bar the board draws it in. */}
      {/* The board makes the change's NAME the subject of this row — dark and
          semibold, taking whatever width the controls leave it. It was a 12px
          grey caption, which read as metadata about the bar rather than as
          the thing the bar is about. */}
      <span
        className="dc-session-title text-sm font-semibold text-zinc-900 truncate flex-1 min-w-0 dark:text-zinc-100"
        title={s.branch}
      >
        {s.title}
      </span>
      {/* #1941: `shrink-0 whitespace-nowrap` on this link, because it is
          the one child that could WRAP: at 375px it broke over two lines and
          made the strip two lines tall with nothing on the second line but
          half a word. It sits on the title's line at every width.

          #2821: it names its destination, "Open proposal card" (the new-change
          banner's wording), instead of "PR #12", and it goes to the card page,
          where the retired "Change overview" strip above this header went. */}
      {s.pr ? (
        <button
          id="dc-pr-header-link"
          className="shrink-0 whitespace-nowrap text-xs text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
          title={s.prTitle}
          onClick={() => controller()?.openProposalCard?.()}
        >
          {t('devchat:header.openCard')}
        </button>
      ) : (
        /* "New change" is the PR link's resting state — it says only "no PR
           yet", and it was taking room from the change's own name on a 375px
           strip that also carries the venue and the mode switch. The board's
           row is the name and the switch, nothing else; hiding it below `sm`
           is the nearest thing to that which still shows it where there is
           room. */
        <span className="max-sm:hidden shrink-0 whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400" title={s.newChangeTitle}>{t('devchat:header.newChange')}</span>
      )}
      {/* #1348: where this session is built. It states the venue and opens the
          sheet that changes it. Here it survives the launchpad swap, and it is
          not competing with the meter, the runner and the budget menu for the
          same strip. A direct child, which a declared check pins; the mode
          switch sits after it, on the strip's right edge.

          #1940: it shows at EVERY width again. #1816 hid it (and the PR link)
          below `sm` behind a "Details ▾" button that opened a Session details
          dialog, which put the one thing people look this strip up for — what
          the session is built with — a tap and a sheet away. The control caps
          its own width (`max-width: min(45%, 14rem)`, app.css).

          #1941: on a phone it is the first thing on the strip's SECOND line.
          "The title is what gives way" gave way completely — at 375px the
          venue, the switch and the ⋯ together are wider than the strip, so
          the title's width went to zero and the ⋯ ran off the right edge.
          The strip wraps below `sm` now (view.tsx): the name and the PR
          number on one line, this control, the switch and the ⋯ on the next.
          Two lines, every fact still on the strip, and it stays ONE line
          from `sm` up. */}
      {s.venue ? <VenueSelect venue={s.venue} /> : null}
      {!embedded ? <ModeSwitch busy={!!s.busy} /> : null}
      {/* #1904: the session's own actions, last — the far right of the strip,
          beside the two switchers. Absent, not empty, when there is nothing
          to offer. */}
      <SessionActionsMenu actions={s.actions || []} />
    </>
  );
}
