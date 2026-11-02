/**
 * EXPERIMENTAL (Settings › Experimental, "New Needs you"; ./settings.ts):
 * the Communities tab's Needs you as one run through the changes waiting
 * on you: look, decide, move on, with nothing else in the way.
 *
 * ── The run ─────────────────────────────────────────────────────────────
 * Needs you opens straight on the first change waiting on you, across your
 * communities, in the feed's own order (GET /api/workshop/needs-feed). There
 * is no list to pick from. On a phone the page covers the shell's header
 * with a light bar of its own: Back, the change's title on one line, and ⌄.
 * Back always leaves the run, for Communities or the project's hub. Next
 * PUSHES the next change in from the side; it goes only to a change you have
 * not voted on or skipped, and carries how many are left after this one (the
 * same number the Communities tab's badge shows). Before you answer, Skip
 * holds Next's place: it turns the page at once and records nothing. With
 * none left the button says Done, and Done takes the page down onto the end.
 * When everything had your vote, the end says so. When you skipped some, it
 * is not done: the skipped changes wait as a small stack, with one way to
 * look at them again and a quiet way back.
 *
 * ── A change's page ─────────────────────────────────────────────────────
 * Under the bar, what the change does, in one or two lines of body text
 * (what the open screen shows, once one is open). ⌄, the title or that line
 * opens the change in full: the bar grows to the whole title, and a card
 * under it holds the description, who made it, the way on to the change's
 * page, and help: Ask privately, Discussion and Try it, each opened over the
 * page by the vote sheet.
 *
 * Its picture is its sheet (model.ts composeSheet): every screen it shows,
 * one plate each, on the ground that says how much it changes. A tap on a
 * plate opens that screen IN PLACE: the screen grows out of its plate to
 * the picture's framing (model.ts openPlace) and becomes the before/after
 * slider (./compare.tsx), with everything but the change dimmed for a
 * moment round one hard-edged hole. Under the picture, its own row, the
 * strip: the sheet's glyph, then one 64pt tile per screen. The glyph goes
 * back to the sheet; a tile pushes its screen in beside the open one. At the
 * foot the vote (./vote-sheet.tsx), part of the page until its help opens
 * over it. A change with one screen opens it by itself; a change with
 * nothing to compare shows its drawn picture, as before.
 *
 * From 768px the same page is a panel (app.css): under the app's header,
 * rounded, as tall as what it holds, with the vote sheet as its foot and
 * the pane behind it dimmed. A click on the dim is Back. A project's own
 * Needs you is the same run, under that project's header, which already
 * names the community and the place.
 *
 * ── Island rules ────────────────────────────────────────────────────────
 * Rendered only while the Needs you pane shows, from data the controller
 * loads in an effect; the page is a portal on <body>.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ChatIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon, SparklesIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { changeHref } from '../../lib/change-href';
import { callAppView } from '../dev-board/card/fold';
import type { NeedsFeedItem } from '../workshop/needs-reel';
import { CompareSlider } from './compare';
import { Illustration } from './illustrations';
import { readInks, useInks } from './ink';
import {
  composeSheet, glyphBars, nextIndex, openPlace, orderForReview, pictoMarks, screenLine, toReviewItems,
  type AreaKind, type BenefitKind, type DecisionKind, type GlyphBar, type Ink, type Placement, type ReviewItem, type SheetPlate,
} from './model';
import { VoteSheet, sheetOpen, type SheetState, type Vote } from './vote-sheet';
import { dirSign } from '../../lib/i18n/direction';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const OPEN_MS = 380;
const CLOSE_MS = OPEN_MS * 0.85;
const PUSH_MS = 440;
const MARKS_AFTER = 160;
/** How long the landing dim holds before it fades. */
const DIM_HOLD = 760;
/** A change with one screen opens it by itself, this long after it lands. */
const ONE_SCREEN_AFTER = 650;
/** The picture's side margin (app.css `.rf-picture`). */
const INSET = 12;
/** The strip: 64pt tiles, 8 apart, 12 under the picture (app.css `.rf-strip`). */
const TILE = 44;
const TILE_GAP = 8;
/** A screen's pictogram inside its tile: a phone's outline, and its inside. */
const PICTO = { w: 20, h: 30, inset: 3 };
const STRIP_H = 12 + TILE;
/**
 * What the page holds besides the picture: the line it leads with (6pt
 * under the bar, up to two lines, 14pt above the picture) and the vote at
 * rest (the room for a No's reason, the row, their padding). The strip is
 * added when there is one. The picture takes the rest, up to 3:2. On a short
 * screen (a small phone, a low window's panel) it gives way down to 2:1
 * before the line does: only past that does the page scroll.
 */
const PAGE_CHROME = 6 + 42 + 14 + 120;

/** The picture's height on a page `pageH` tall, `inner` wide. */
export function heroHeight(inner: number, pageH: number, strip: boolean): number {
  const room = pageH - PAGE_CHROME - (strip ? STRIP_H : 0);
  return Math.round(Math.max(inner * 0.5, Math.min(inner * 1.5, room)));
}
/** The change page is never wider than this (app.css `.rf-page`). */
const COLUMN = 520;

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function shape(visuals: unknown, shots: unknown) {
  const out = callAppView('_workshopVisuals', visuals, shots);
  return out && typeof out === 'object' ? (out as never) : null;
}

const cam = (p: Placement) => `translate(${p.tx}px, ${p.ty}px) scale(${p.scale})`;
const clipOf = (p: SheetPlate, w: number, h: number) =>
  `inset(${p.y}px ${w - p.x - p.w}px ${h - p.y - p.h}px ${p.x}px round ${p.r}px)`;
const OPEN_CLIP = 'inset(0px 0px 0px 0px round 32px)';

/* ── Drawn pictures ──────────────────────────────────────────────────── */

// Each label is a whole message id, so the language tools can find it.
const BENEFIT_LABEL: Record<BenefitKind, string> = {
  fixed: 'communities:review.benefit.fixed',
  stability: 'communities:review.benefit.stability',
  clarity: 'communities:review.benefit.clarity',
  more: 'communities:review.benefit.more',
  results: 'communities:review.benefit.results',
  speed: 'communities:review.benefit.speed',
  effort: 'communities:review.benefit.effort',
  security: 'communities:review.benefit.security',
  behind: 'communities:review.benefit.behind',
};
const AREA_LABEL: Record<Exclude<AreaKind, 'app'>, string> = {
  agents: 'communities:review.area.agents',
  proposals: 'communities:review.area.proposals',
  platform: 'communities:review.area.platform',
  projects: 'communities:review.area.projects',
  accounts: 'communities:review.area.accounts',
  admin: 'communities:review.area.admin',
  messages: 'communities:review.area.messages',
  challenges: 'communities:review.area.challenges',
};
const DECISION_LABEL: Record<DecisionKind, string> = {
  close_issue: 'communities:review.decision.closeIssue',
  rename: 'communities:review.decision.rename',
  secret_change: 'communities:review.decision.secret',
  decision: 'communities:review.decision.other',
};

/**
 * A drawn picture: a benefit object for a change with nothing (yet) to show,
 * a decision object for a group decision. Every card has a picture.
 */
function Drawn({ item, width, height, play }: { item: ReviewItem; width: number; height: number; play?: boolean }): ReactNode {
  const t = useMessages('communities');
  const p = item.picture;
  if (p.kind !== 'benefit' && p.kind !== 'decision') return null;
  const area = p.kind === 'benefit' && p.area !== 'app' ? t(AREA_LABEL[p.area]) : item.app?.name || null;
  return (
    <Illustration
      kind={p.kind === 'benefit' ? { benefit: p.benefit } : { decision: p.decision }}
      label={{ main: p.kind === 'benefit' ? t(BENEFIT_LABEL[p.benefit]) : t(DECISION_LABEL[p.decision]), area }}
      token={p.kind === 'benefit' ? p.token : null}
      ground={item.ground}
      width={width}
      height={height}
      play={play}
    />
  );
}

/* ── The strip ────────────────────────────────────────────────────────── */

/**
 * Its own row under the picture: the sheet's glyph, then one pictogram per
 * screen, each on a 44pt grey tile 8 apart, never stretched to fill the
 * row. A pictogram is the screen's outline with a bar on every place it
 * changed (model.ts pictoMarks): no screenshots here, so the picture above
 * stays the one thing with pixels in it. The glyph is the overview and
 * stays as it is whichever screen is open; where you are is the tile in the
 * lit tint and ink. When a change arrives its tiles start folded on the
 * glyph's bars and unfold once into their places.
 */
function Strip({ item, plates, shot, folded, ready, onAll, onTile }: {
  item: ReviewItem;
  plates: SheetPlate[];
  /** The open screen, or null on the sheet. */
  shot: number | null;
  folded: boolean;
  /** Whether a tap does anything yet (not while the picture moves). */
  ready: boolean;
  onAll: () => void;
  onTile: (k: number) => void;
}): ReactNode {
  const t = useMessages('communities');
  const n = item.screens.length;
  const bars = glyphBars(plates, 24, 10);
  const barOf = (k: number): GlyphBar | undefined => bars.find((b) => b.screen === k);
  const slot = (k: number) => (k + 1) * (TILE + TILE_GAP);
  const inW = PICTO.w - PICTO.inset * 2;
  const inH = PICTO.h - PICTO.inset * 2;
  return (
    <div className="rf-strip" role="group" aria-label={t('communities:review.thumbs.label')} data-rf-strip="">
      <button
        type="button"
        className="rf-strip-all"
        aria-current={shot == null ? 'true' : undefined}
        aria-label={t('communities:review.strip.all', { count: n })}
        onClick={ready ? onAll : undefined}
        data-rf-all=""
      >
        <span className="rf-gbox" aria-hidden="true" />
        {bars.map((b) => (
          <span key={b.screen} className="rf-gbar" aria-hidden="true" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
        ))}
      </button>
      {item.screens.map((s, k) => {
        const bar = barOf(k);
        const box = folded && bar ? { x: bar.x, y: bar.y, w: bar.w, h: bar.h, r: 2 } : { x: slot(k), y: 0, w: TILE, h: TILE, r: 14 };
        const marks = pictoMarks(s, inW, inH);
        return (
          <button
            key={`${s.viewport}-${k}`}
            type="button"
            className="rf-tile"
            aria-current={shot === k ? 'true' : undefined}
            aria-label={t('communities:review.thumbs.one', { n: k + 1, total: n })}
            aria-hidden={folded ? true : undefined}
            tabIndex={folded ? -1 : 0}
            data-rf-tile={k}
            data-folded={folded ? '' : undefined}
            style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: box.r }}
            onClick={ready ? () => onTile(k) : undefined}
          >
            <span className="rf-picto" aria-hidden="true">
              {marks.map((m, i) => (
                <span key={i} className="rf-picto-mark" style={{ left: PICTO.inset + m.x, top: PICTO.inset + m.y, width: m.w, height: m.h }} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── One change's page body (picture, strip, line) ────────────────────── */

/** What a change shows: its sheet, or one screen opening, open or closing. */
type View = { shot: number | null; phase: 'sheet' | 'opening' | 'live' | 'closing' };
const SHEET_VIEW: View = { shot: null, phase: 'sheet' };

function ChangeBody({ item, width, pageH, arrive, still = null, onView, onMore }: {
  item: ReviewItem;
  width: number;
  pageH: number;
  /**
   * How it came: 'enter' (the run opened on it: its plates are dealt),
   * 'push' (Next brought it), or 'still', the copy Next leaves behind,
   * drawn as it was seen (`still`) and deaf to taps.
   */
  arrive: 'enter' | 'push' | 'still';
  still?: View | null;
  onView?: (v: View) => void;
  /** A tap on the line: the change in full, over the page. */
  onMore?: () => void;
}): ReactNode {
  const t = useMessages('communities');
  const inner = Math.max(0, width - INSET * 2);
  const multi = item.screens.length > 1;
  const height = heroHeight(inner, pageH, multi);
  const live = arrive !== 'still';
  const rm = reducedMotion();
  // The change lands once its stills are read, so its crops can end on blank rows.
  const { inks, settled } = useInks(item.screens);
  const plates = useMemo(() => composeSheet(item.screens, { w: inner, h: height }, undefined, inks), [item.screens, inner, height, inks]);
  const opens = useMemo(() => item.screens.map((s) => openPlace(s, { w: inner, h: height })), [item.screens, inner, height]);

  const [view, setView] = useState<View>(still || SHEET_VIEW);
  const [dim, setDim] = useState(false);
  const [marks, setMarks] = useState(!!still && still.phase === 'live');
  const [folded, setFolded] = useState(live && multi && !rm);
  const [deal, setDeal] = useState(arrive === 'enter' && !rm);
  const [switching, setSwitching] = useState<{ from: number; dir: 1 | -1 } | null>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const whenDone = (anim: Animation | undefined, fn: () => void, ms: number) => {
    let ran = false;
    const once = () => { if (!ran) { ran = true; fn(); } };
    anim?.finished.then(once, once);
    later(once, ms + 1500);
  };
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  useEffect(() => { onView?.(view); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewRef = useRef(view);
  viewRef.current = view;
  const openShot = (k: number) => {
    if (viewRef.current.phase !== 'sheet') return;
    setDim(true);
    setMarks(false);
    setFolded(false);
    setView({ shot: k, phase: 'opening' });
  };

  // It arrives, once its stills are read: the plates are dealt (only when the
  // run opens on it), the strip unfolds once the page has landed, and a lone
  // screen opens itself.
  const arrived = useRef(false);
  useEffect(() => {
    if (!live || !settled || arrived.current) return;
    arrived.current = true;
    const landed = arrive === 'enter' ? OPEN_MS : PUSH_MS;
    if (folded) later(() => setFolded(false), landed + 40);
    if (deal) later(() => setDeal(false), 60 + 70 * (plates.length - 1) + 460 + 20);
    if (item.screens.length === 1) later(() => openShot(0), landed + ONE_SCREEN_AFTER);
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  // The screen grows out of its plate: the window opens from the plate's
  // rectangle to the picture's corners while the screen moves from the
  // plate's crop to its framing, both on one curve. The dim is on from the
  // first frame and rides the screen.
  const settle = (k: number) => {
    setView({ shot: k, phase: 'live' });
    later(() => setMarks(true), MARKS_AFTER);
    later(() => setDim(false), DIM_HOLD);
  };
  useLayoutEffect(() => {
    if (view.phase !== 'opening' || view.shot == null) return;
    const k = view.shot;
    const wrap = pictureRef.current?.querySelector<HTMLElement>(`[data-rf-open="${k}"]`);
    const plate = plates.find((p) => p.screen === k);
    if (!wrap || !plate || rm) {
      const fade = wrap?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 190, easing: EASE });
      whenDone(fade, () => settle(k), 190);
      return;
    }
    const opts = { duration: OPEN_MS, easing: EASE };
    const from = { scale: plate.s, tx: plate.x - plate.box.x * plate.s, ty: plate.y - plate.box.y * plate.s };
    const opening = wrap.animate([{ clipPath: clipOf(plate, inner, height) }, { clipPath: OPEN_CLIP }], opts);
    wrap.querySelectorAll<HTMLElement>('[data-rf-cam]').forEach((el) => {
      el.animate([{ transform: cam(from) }, { transform: cam(opens[k].place) }], opts);
    });
    whenDone(opening, () => settle(k), OPEN_MS);
  }, [view.phase, view.shot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back to the sheet: the same move in reverse, a little quicker.
  const closeShot = () => {
    if (view.phase !== 'live' || view.shot == null || switching) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setMarks(false);
    setDim(false);
    setView({ shot: view.shot, phase: 'closing' });
  };
  useLayoutEffect(() => {
    if (view.phase !== 'closing' || view.shot == null) return;
    const k = view.shot;
    const wrap = pictureRef.current?.querySelector<HTMLElement>(`[data-rf-open="${k}"]`);
    const plate = plates.find((p) => p.screen === k);
    const done = () => setView(SHEET_VIEW);
    if (!wrap || !plate || rm) {
      const fade = wrap?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 190, easing: EASE, fill: 'forwards' });
      whenDone(fade, done, 190);
      return;
    }
    const opts = { duration: CLOSE_MS, easing: EASE, fill: 'forwards' as FillMode };
    const to = { scale: plate.s, tx: plate.x - plate.box.x * plate.s, ty: plate.y - plate.box.y * plate.s };
    const closing = wrap.animate([{ clipPath: OPEN_CLIP }, { clipPath: clipOf(plate, inner, height) }], opts);
    wrap.querySelectorAll<HTMLElement>('[data-rf-cam]').forEach((el) => {
      el.animate([{ transform: cam(opens[k].place) }, { transform: cam(to) }], opts);
    });
    whenDone(closing, done, CLOSE_MS);
  }, [view.phase, view.shot]); // eslint-disable-line react-hooks/exhaustive-deps

  // From tile to tile: the new screen is pushed in from its tile's side and
  // the open one goes the other way, side by side, never blended. Both are
  // dimmed round their own change from the tap. The open tile again shows
  // its change again.
  const pick = (k: number) => {
    if (view.phase === 'sheet') { openShot(k); return; }
    if (view.phase !== 'live' || view.shot == null || switching) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setDim(true);
    if (k === view.shot) { later(() => setDim(false), DIM_HOLD); return; }
    setSwitching({ from: view.shot, dir: k > view.shot ? 1 : -1 });
    setView({ shot: k, phase: 'live' });
  };
  useLayoutEffect(() => {
    if (!switching || view.shot == null) return;
    const root = pictureRef.current;
    const arriving = root?.querySelector<HTMLElement>(`[data-rf-open="${view.shot}"]`);
    const leaving = root?.querySelector<HTMLElement>(`[data-rf-open="${switching.from}"]`);
    const end = () => { setSwitching(null); later(() => setDim(false), DIM_HOLD); };
    if (!arriving || rm) { end(); return; }
    const opts = { duration: OPEN_MS, easing: EASE };
    const sign = dirSign();
    const sliding = arriving.animate([{ transform: `translateX(${sign * switching.dir * inner}px)` }, { transform: 'none' }], opts);
    leaving?.animate([{ transform: 'none' }, { transform: `translateX(${sign * -switching.dir * inner}px)` }], { ...opts, fill: 'forwards' });
    whenDone(sliding, end, OPEN_MS);
  }, [switching]); // eslint-disable-line react-hooks/exhaustive-deps

  const visual = item.screens.length > 0 || !!(item.pair && (item.pair.after || item.pair.before));
  const shown = [switching ? switching.from : null, view.shot].filter((k): k is number => k != null);
  const line = view.shot != null && view.phase !== 'closing' ? screenLine(item, item.screens[view.shot] || null) : item.line;
  const ready = live && !switching && (view.phase === 'sheet' || view.phase === 'live');
  return (
    <div className="rf-page-body" data-rf-body={item.key} data-rf-view={view.shot == null ? 'sheet' : `screen-${view.shot}`}>
      {/* The line is a way in too: a tap anywhere on it opens the change in
          full, as the bar's ⌄ does. The copy Next leaves behind is still. */}
      {onMore ? (
        <button type="button" className="rf-claim-row" onClick={onMore} aria-controls="rf-desc" data-rf-more="">
          <span className="rf-claim" key={line || 'none'}>{line}</span>
          <span className="sr-only">{t('communities:review.desc.show')}</span>
        </button>
      ) : (
        <div className="rf-claim-row"><p className="rf-claim" key={line || 'none'}>{line}</p></div>
      )}
      <div ref={pictureRef} className="rf-picture" style={{ height, background: item.ground }} data-rf-picture="">
        {item.screens.length ? (
          <>
            <div className="rf-plates" role="group" aria-label={t('communities:review.thumbs.label')} style={settled ? undefined : { visibility: 'hidden' }}>
              {plates.map((p) => (
                <button
                  key={p.screen}
                  type="button"
                  className="rf-plate-btn"
                  data-rf-plate={p.screen}
                  aria-label={t('communities:review.thumbs.one', { n: p.screen + 1, total: item.screens.length })}
                  tabIndex={view.shot == null && live ? 0 : -1}
                  style={{
                    left: p.x, top: p.y, width: p.w, height: p.h, borderRadius: p.r,
                    animation: deal ? `rf-deal .46s ${EASE} ${60 + 70 * p.screen}ms backwards` : undefined,
                  }}
                  onClick={ready && view.phase === 'sheet' ? () => openShot(p.screen) : undefined}
                >
                  {p.img ? <img src={p.img.url} alt="" draggable={false} style={{ left: p.img.left, top: p.img.top, width: p.img.width, height: p.img.height }} /> : null}
                </button>
              ))}
            </div>
            {shown.map((k) => (
              <div
                key={k}
                className="rf-open"
                data-rf-open={k}
                // At rest it is open: an opening starts from the plate before the
                // first paint, and its last frame is what is left behind.
                style={{ zIndex: k === view.shot ? 3 : 2, clipPath: OPEN_CLIP }}
              >
                <CompareSlider
                  screen={item.screens[k]}
                  ground={item.ground}
                  width={inner}
                  height={height}
                  marks={marks && k === view.shot && view.phase === 'live'}
                  place={opens[k].place}
                  veil={{ cut: opens[k].cut, on: dim }}
                  onTouch={() => { if (dim) { setDim(false); } }}
                />
              </div>
            ))}
          </>
        ) : visual ? (
          <CompareSlider screen={null} pair={item.pair} ground={item.ground} width={inner} height={height} marks={live} />
        ) : (
          <div className="rf-hero-drawn" style={{ width: inner, height, background: item.ground }}>
            <Drawn item={item} width={inner} height={height} play={live} />
          </div>
        )}
      </div>
      {multi ? (
        <Strip
          item={item}
          plates={plates}
          shot={view.phase === 'closing' ? null : view.shot}
          folded={folded}
          ready={ready}
          onAll={closeShot}
          onTile={pick}
        />
      ) : null}
    </div>
  );
}

/* ── The run ──────────────────────────────────────────────────────────── */

export function ReviewFlow({ items, error, capped, onDone, doneLabel, onAnswered, onRetracted, header = 'communities' }: {
  items: NeedsFeedItem[] | null;
  error: boolean;
  capped: boolean;
  onDone: () => void;
  /** The end's way on; "Back to your communities" when not given. */
  doneLabel?: string;
  /**
   * Whose header the run sits under: the Communities screen's, which the run
   * names (../header/review-run-store.js), or a project's, which already
   * names the community and the place.
   */
  header?: 'communities' | 'project';
  onAnswered?: (id: number, epoch: number | null) => void;
  onRetracted?: (id: number) => void;
}) {
  const t = useMessages('communities');
  const anchorRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const foldedBar = useRef(0);
  const safeRef = useRef<HTMLDivElement>(null);
  // What the change does in full, dropped from under the bar over the page.
  const [desc, setDesc] = useState(false);
  const [barTop, setBarTop] = useState(0);
  // The run is fixed once it starts: a vote takes its change out of the
  // controller's feed, and the run must not move under you.
  const [list, setList] = useState<ReviewItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [from, setFrom] = useState<{ index: number; view: View } | null>(null);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState(true);
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const [skipped, setSkipped] = useState<Record<string, true>>({});
  const [sheet, setSheet] = useState<SheetState>('ask');
  const views = useRef<Record<string, View>>({});
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const whenDone = (anim: Animation | undefined, fn: () => void, ms: number) => {
    let ran = false;
    const once = () => { if (!ran) { ran = true; fn(); } };
    anim?.finished.then(once, once);
    later(once, ms + 1500);
  };
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const shaped = useMemo(() => (items ? orderForReview(toReviewItems(items, shape)) : null), [items]);
  useEffect(() => {
    if (!shaped || list) return;
    setList(shaped);
    setIndex(Math.max(0, shaped.findIndex((it) => it.kind !== 'governance')));
  }, [shaped, list]);

  const run = list || [];
  const passed = useMemo(() => ({ ...skipped, ...votes }), [skipped, votes]);
  const item = run[index] && run[index].kind !== 'governance' ? run[index] : null;
  const leaving = from ? run[from.index] : null;
  const next = item ? nextIndex(run, index, passed) : -1;
  const open = !!item && !done && shown;

  // The page's size once it is up; again if the window changes.
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!open || !page) return undefined;
    const measure = () => {
      const pr = page.getBoundingClientRect();
      // From 768px the panel is as tall as what it holds, up to its room.
      const max = parseFloat(getComputedStyle(page).maxHeight);
      // Less the bar over it, which on a phone also holds the status bar's
      // inset, and the home indicator's inset the vote bar keeps clear of.
      const safe = safeRef.current ? safeRef.current.offsetHeight : 0;
      // The folded bar's: open, it grows to the whole title over the page.
      if (barRef.current && !barRef.current.hasAttribute('data-open')) foldedBar.current = barRef.current.getBoundingClientRect().height;
      const bar = foldedBar.current;
      const h = (Number.isFinite(max) && max > 0 ? max : pr.height) - bar - safe;
      setSize({ w: Math.min(COLUMN, pr.width), h });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // The run comes up over the pane: the page fades in.
  useLayoutEffect(() => {
    if (!open || !pageRef.current || reducedMotion()) return;
    pageRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
    dimRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
  }, [open]);

  /* ── Push: this change → the next ── */
  const goTo = (n: number) => {
    if (busy.current || !item) return;
    if (n < 0) { finishAll(); return; }
    busy.current = true;
    setSheet(votes[run[n].key] ? 'voted' : 'ask');
    setFrom({ index, view: views.current[item.key] || SHEET_VIEW });
    setIndex(n);
  };
  const goNext = () => goTo(next);
  const skip = () => {
    if (!item) return;
    const now = { ...passed, [item.key]: true };
    setSkipped((cur) => ({ ...cur, [item.key]: true }));
    setSheet('ask');
    goTo(nextIndex(run, index, now));
  };

  useLayoutEffect(() => {
    if (!from) return;
    const stage = stageRef.current;
    const w = pageRef.current ? pageRef.current.getBoundingClientRect().width : 390;
    const settle = () => { setFrom(null); busy.current = false; };
    if (!stage || reducedMotion()) { settle(); return; }
    const arriving = stage.querySelector<HTMLElement>('[data-rf-arriving]');
    const gone = stage.querySelector<HTMLElement>('[data-rf-leaving]');
    const opts = { duration: PUSH_MS, easing: EASE };
    const sign = dirSign();
    const sliding = arriving?.animate([{ transform: `translateX(${sign * w}px)`, boxShadow: `${sign * -12}px 0 32px rgba(0,0,0,.4)` }, { transform: 'none', boxShadow: `${sign * -12}px 0 32px rgba(0,0,0,0)` }], opts);
    gone?.animate([{ transform: 'none', filter: 'none' }, { transform: `translateX(${sign * -0.3 * w}px)`, filter: 'brightness(0.55)' }], { ...opts, fill: 'forwards' });
    whenDone(sliding, settle, PUSH_MS);
  }, [from && from.index, index]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Votes ── */
  const vote = async (v: Vote, reason?: string): Promise<boolean> => {
    if (!item) return false;
    const key = item.key;
    setVotes((cur) => ({ ...cur, [key]: v }));
    setSheet('voted');
    const opts = v === 'no' ? { reason: reason || '' } : { reason: null };
    let ok = false;
    try {
      ok = (await callAppView('castVote', item.id, v, item.epoch, opts)) === true;
    } catch { ok = false; }
    if (!ok) {
      setVotes((cur) => { const copy = { ...cur }; delete copy[key]; return copy; });
      setSheet('ask');
      return false;
    }
    onAnswered?.(item.id, item.epoch);
    return true;
  };
  const undo = async (): Promise<boolean> => {
    if (!item) return false;
    const key = item.key;
    let ok = false;
    try {
      ok = (await callAppView('retractVote', item.id, item.epoch)) === true;
    } catch { ok = false; }
    if (!ok) return false;
    setVotes((cur) => { const copy = { ...cur }; delete copy[key]; return copy; });
    setSheet('ask');
    onRetracted?.(item.id);
    return true;
  };

  // Nothing left running behind the page.
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busy.current = false;
    setFrom(null);
    setSheet('ask');
  };
  // Done on the last change: the page comes down onto the end.
  const finishAll = () => { stop(); setDone(true); };
  // From the end: the skipped changes again, from the first one waiting.
  const again = () => {
    const first = run.findIndex((it) => it.kind !== 'governance' && !votes[it.key]);
    if (first < 0) return;
    setSkipped({});
    setIndex(first);
    setDone(false);
  };
  // A help sheet over the page, from the card: the card folds first.
  const help = (to: SheetState) => { setDesc(false); setSheet(to); };

  // Going anywhere else (a link on the page, a tab, Back) takes the page
  // down at once: it is fixed over the shell, and the screen under it may
  // only hide, not unmount. It comes back when the pane shows again.
  useEffect(() => {
    const route = () => {
      stop();
      setShown(false);
      requestAnimationFrame(() => setShown(!!anchorRef.current && anchorRef.current.getClientRects().length > 0));
    };
    window.addEventListener('hashchange', route);
    window.addEventListener('popstate', route);
    return () => {
      window.removeEventListener('hashchange', route);
      window.removeEventListener('popstate', route);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the help first, then leaves the run.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (desc) setDesc(false);
      else if (sheetOpen(sheet)) setSheet(item && votes[item.key] ? 'voted' : 'ask');
      else onDone();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, desc, sheet, item, votes, onDone]);
  // Open, the bar holds the whole title, so the card starts where it ends.
  useLayoutEffect(() => {
    if (barRef.current) setBarTop(barRef.current.getBoundingClientRect().height);
  }, [desc, item ? item.key : '', size]); // eslint-disable-line react-hooks/exhaustive-deps
  // The card folds away when the run moves on.
  const itemKey = item ? item.key : '';
  useEffect(() => { setDesc(false); }, [itemKey]);

  const nextItem = next >= 0 ? run[next] : null;
  const pw = size ? size.w : Math.min(COLUMN, typeof window !== 'undefined' ? window.innerWidth : 390);
  const ph = size ? size.h : (typeof window !== 'undefined' ? window.innerHeight - 64 : 700);
  // The next change's stills are read ahead, so it lands at once.
  useEffect(() => { if (nextItem) readInks(nextItem.screens); }, [nextItem]);
  // How far the run is: the changes still waiting after this one (Next's
  // number, and the Communities badge's).
  const changes = run.filter((it) => it.kind !== 'governance');
  const after = item ? changes.filter((it) => it.key !== item.key && !passed[it.key]).length : 0;

  // The bar: Back, the change's title and ⌄. ⌄, the title or the line under
  // the bar opens the change in full: the bar grows to the whole title, and
  // a card under it holds what the change does and the way on to its whole
  // page.
  // Back is the arrow alone, so the title has the row; its name says where
  // it goes: All communities, or the project a project's own Needs you was
  // opened from. The shell's header steps aside for it on a phone, as it did
  // for the run's old head.
  const toProject = header === 'project' && item && item.app ? item.app.name : '';
  const backName = t('communities:review.back.label', { place: toProject || t('communities:switcher.all.name') });

  /* ── Drawing ── */
  if (error) {
    return <p className="rf-feed-note px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-error="">{t('communities:reel.error')}</p>;
  }
  if (!items && !list) {
    return <div ref={anchorRef} className="rf-run rf-loading" data-review-flow="" aria-busy="true" aria-label={t('communities:reel.loading')} />;
  }
  const waiting = run.filter((it) => skipped[it.key] && !votes[it.key]);
  if (done || (list && !item && Object.keys(votes).length)) {
    // Everything here had your vote or was skipped: the end, where the run
    // was. Skipped changes still wait, so then it is not done: they show as
    // a small stack, with one way to look at them again.
    return (
      <div ref={anchorRef} className="rf-run rf-feed-done" data-review-flow="">
        {waiting.length ? (
          <div className="rf-end rf-end-alone" data-rf-end="" data-rf-end-waiting={waiting.length}>
            <span className="rf-end-stack" aria-hidden="true">
              {waiting.slice(0, 3).map((it, i, all) => (
                <span key={it.key} className="rf-end-tile" data-n={all.length > 1 ? i - (all.length - 1) / 2 : 0} style={{ background: it.ground }}><i /></span>
              ))}
            </span>
            <p className="rf-end-title">{t('communities:review.end.throughAll')}</p>
            <p className="rf-end-line rf-end-line-tight">{t('communities:review.end.waiting', { count: waiting.length })}</p>
            <button type="button" className="rf-end-btn rf-end-btn-go" onClick={again} data-rf-again="">{t('communities:review.end.again', { count: waiting.length })}</button>
            <button type="button" className="rf-end-back" onClick={onDone}>{doneLabel || t('communities:reel.done')}</button>
          </div>
        ) : (
          <div className="rf-end rf-end-alone" data-rf-end="">
            <span className="rf-end-mark" aria-hidden="true">
<CheckIcon width={24} height={24} strokeWidth="2.2" />
            </span>
            <p className="rf-end-line">{t('communities:review.end.line')}</p>
            <button type="button" className="rf-end-btn" onClick={onDone}>{doneLabel || t('communities:reel.done')}</button>
          </div>
        )}
        {capped ? <p className="rf-capped" data-needs-capped="">{t('communities:reel.capped', { count: run.length })}</p> : null}
      </div>
    );
  }
  if (!item) {
    return <p ref={anchorRef as never} className="rf-feed-note px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-empty="" data-review-flow="">{t('communities:reel.empty')}</p>;
  }

  const page = open ? createPortal(
    <div className="rf-page-wrap" data-rf-page="">
      {/* From 768px, the pane behind the panel, dimmed; a click on it is Back. */}
      <div ref={dimRef} className="rf-page-dim" onClick={onDone} aria-hidden="true" />
      <div ref={pageRef} className="rf-page" role="dialog" aria-modal="false" aria-label={item.title}>
        <div ref={safeRef} className="rf-safe-probe" aria-hidden="true" />
        <div ref={barRef} className="rf-bar" data-open={desc ? '' : undefined}>
          <button type="button" className="rf-back" onClick={onDone} aria-label={backName} data-rf-back="">
            <ChevronLeftIcon aria-hidden="true" width={24} height={24} strokeWidth="2.2" />
          </button>
          <h1 className="rf-bar-title" key={item.key}>
            <button type="button" className="rf-bar-title-btn" onClick={() => setDesc((d) => !d)} aria-expanded={desc} aria-controls="rf-desc">{item.title}</button>
          </h1>
          <button
            type="button"
            className="rf-bar-toggle"
            aria-expanded={desc}
            aria-controls="rf-desc"
            aria-label={desc ? t('communities:review.desc.hide') : t('communities:review.desc.show')}
            onClick={() => setDesc((d) => !d)}
            data-rf-desc-toggle=""
          >
            <ChevronDownIcon aria-hidden="true" width={18} height={18} strokeWidth="2.4" />
          </button>
        </div>
        <div className="rf-desc-wrap" data-open={desc ? '' : undefined} style={{ top: barTop }} aria-hidden={!desc} inert={!desc || undefined}>
          <div className="rf-desc-dim" onClick={() => setDesc(false)} />
          <div className="rf-desc" id="rf-desc" data-rf-desc="">
            <p className="rf-desc-text">{item.summary || item.line}</p>
            {item.author ? <p className="rf-desc-by">{t('communities:review.desc.by', { name: item.author })}</p> : null}
            <div className="rf-desc-foot">
              {item.app ? (
                <a className="rf-desc-go" href={changeHref(item.app.slug, item.id, item.number)}>{t('communities:review.more.open')}</a>
              ) : null}
            </div>
            <nav className="rf-desc-help" aria-label={t('communities:review.help.label')} data-rf-desc-help="">
              <button type="button" className="rf-help-row" data-rf-help="askq" onClick={() => help('askq')}><SparklesIcon aria-hidden="true" width={20} height={20} /><span>{t('communities:review.help.ask')}</span><ChevronRightIcon aria-hidden="true" width={18} height={18} /></button>
              <button type="button" className="rf-help-row" data-rf-help="talk" onClick={() => help('talk')}><ChatIcon aria-hidden="true" width={20} height={20} /><span>{t('communities:review.help.talk')}</span><ChevronRightIcon aria-hidden="true" width={18} height={18} /></button>
              <button type="button" className="rf-help-row" data-rf-help="try" onClick={() => help('try')}><PlayIcon aria-hidden="true" width={20} height={20} /><span>{t('communities:review.help.try')}</span><ChevronRightIcon aria-hidden="true" width={18} height={18} /></button>
            </nav>
          </div>
        </div>
        <div ref={stageRef} className="rf-stage">
          {leaving && from ? (
            <div className="rf-stage-layer rf-stage-leaving" data-rf-leaving="" aria-hidden="true" inert>
              <ChangeBody item={leaving} width={pw} pageH={ph} arrive="still" still={from.view} />
            </div>
          ) : null}
          <div className={leaving ? 'rf-stage-layer rf-stage-arriving' : 'rf-stage-layer'} data-rf-arriving="">
            <ChangeBody
              key={item.key}
              item={item}
              width={pw}
              pageH={ph}
              arrive={from ? 'push' : 'enter'}
              onView={(v) => { views.current[item.key] = v; }}
              onMore={() => setDesc(true)}
            />
          </div>
        </div>
        <div className={sheetOpen(sheet) ? 'rf-scrim rf-scrim-on' : 'rf-scrim'} onClick={() => setSheet(votes[item.key] ? 'voted' : 'ask')} aria-hidden="true" />
        <VoteSheet
          item={item}
          vote={votes[item.key] || null}
          state={sheet}
          setState={setSheet}
          onVote={vote}
          onUndo={undo}
          onNext={goNext}
          hasNext={next >= 0}
          maxHeight={Math.max(240, (typeof window !== 'undefined' ? window.innerHeight : 800) * 0.82)}
          left={after}
          onSkip={skip}
        />
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={anchorRef} className="rf-run" data-review-flow="" />
      {page}
    </>
  );
}

/**
 * A project's own Needs you, drawn by the same flow: the cross-project feed
 * (GET /api/workshop/needs-feed) narrowed to this project, so the two never
 * draw a change differently. Read in an effect, as every island does.
 */
export function ProjectReviewFlow({ slug, onDone }: { slug: string; onDone: () => void }) {
  const t = useMessages('communities');
  const [items, setItems] = useState<NeedsFeedItem[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    let demo = '';
    try { demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : ''; } catch { /* no query */ }
    fetch(`/api/workshop/needs-feed${demo}`, { cache: 'no-cache', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!live) return;
        const all: NeedsFeedItem[] = Array.isArray(data?.items) ? data.items : [];
        setItems(all.filter((it) => it.app && it.app.slug === slug));
      })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [slug]);
  return (
    <div className="rf-project" data-rf-project={slug}>
      <ReviewFlow
        items={items}
        error={error}
        capped={false}
        onDone={onDone}
        doneLabel={t('communities:review.end.backToProject')}
        header="project"
      />
    </div>
  );
}
