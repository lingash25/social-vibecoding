/**
 * Comment mode (#4289 and its follow-ups). On by default: C turns it on
 * (../improve/suggest-shortcut.ts decides when C counts), and so does
 * "Suggest an improvement", or its form's Comment switch.
 *
 * ── What it looks like ────────────────────────────────────────────────
 *
 * A layer over the whole page with a comment cursor, and a bar: "Comment
 * mode", what to do next, how many are posted, the Form / Comment switch,
 * and Done. A click anywhere puts a pin there with a box beside it; Enter
 * posts the box as its own request and the pin stays, a marker the person
 * can open again, so they can go on to the next thing. "Add a comment" in
 * the box makes the next click the same request's next comment instead:
 * one request, its comments numbered, each with its own pin. A click
 * elsewhere moves the open comment's pin (the words stay). Esc closes what
 * is on top: an open marker, the wait for the next pin, the request (asking
 * first when it has words), then the mode. The page under the layer holds
 * still while the mode is up: a wheel turn or a finger drag does nothing;
 * a tap is a comment, as a click is.
 *
 * Over the inset picture the bar is that view's header: the picture leaves
 * a band for it at the top and it sits there, the picture's own width, so
 * nothing floats over the page. When the picture could not be taken, the
 * bar sits at the foot each time comment mode opens, until the person drags
 * its handle somewhere else (only for this visit). The first time comment
 * mode opens on a device, a short note says how it works, and that the Form
 * switch goes back to the form.
 *
 * ── The box ───────────────────────────────────────────────────────────
 *
 * The comments' words; the title the request will be posted with,
 * suggested from all of them as they are typed (the dialog's own POST
 * /api/feedback/title, with its rules: a pause, a dozen characters, a few
 * asks per request) and changed with a click; the page's screenshots,
 * removable, and the person's own images (the paperclip, a paste or a drop:
 * the server's three in all); Kudos for whoever solves it, the dialog's
 * bounty (#964); and where it goes. Its expand button hands it all to the
 * form instead.
 *
 * ── Where it goes ─────────────────────────────────────────────────────
 *
 * By default where the pin is: on the running app's frame, that app; on
 * Homeroom's own screens, Homeroom. The box shows both when the app can
 * take a request (the dialog's own rule: an open app with a GitHub repo
 * that is not the platform itself), so the person can switch.
 *
 * ── The screenshot ────────────────────────────────────────────────────
 *
 * Drawn the moment a pin goes down (./picture.ts), previewed in the box with
 * the pins over it, and posted CLEAN: the pins are sent beside it as data
 * (#4482, ./pin-data.ts), and the request's page draws them over the
 * picture where they can be hidden. A comment pinned on the same view as an
 * earlier one (nothing scrolled since) shares its picture; another view is
 * another picture, while there is room. The markers are this layer's, and
 * the layer is never in a picture.
 *
 * Mounted on demand through the shell's portal registry
 * (lib/legacy-portals.tsx) into a host appended to <body>; nothing of it is
 * in the prerendered shell.
 */

import {
  createElement, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, ArrowPathIcon, CheckIcon, ChatIcon, ChevronDownIcon, DescriptionIcon, DraftEditIcon,
  ArrowsMoveIcon, PaperclipIcon, PlusIcon, SparklesIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { isRepoAddress } from '../../lib/repo-link.js';
import { KB_OPEN_CLASS, PHONE_QUERY } from '../../lib/keyboard-open';
import { textFocused } from '../../lib/browser-scroll';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { PLANE_FILL } from '@/components/ui/grouped-list';
import { platformSlug } from '../messages/channel-hub';
import { KUDOS_PARKED } from '../leaderboard/kudos-parked';
import {
  changesPicture, loadLibrary, outOfPicture, textsUnchanged,
  closeUpView, coverCrop, cropCanvas, CROP_SHADE, describeElement, dragCrop, encodeUnder, FULL_CROP, inRect, insetFrame,
  isFullCrop, overlaysGone, pictureScale, pinInCrop, placeBeside,
  takeBase, thumbnail, toPage, toScreen,
  type Base, type CropHandle, type ElementInfo, type Point, type Rect, type Size,
} from './picture';
import { CloseUp } from './close-up';
import {
  MAX_COMMENTS, MAX_PICTURES, handOver, numberFromUrl, numberedWords, postComment, whereLines,
  type CommentPost, type CommentShot, type Spot, type Target,
} from './post';

export const HOST_ID = 'comment-pin-host';
const BOX_WIDTH = 360;
/** A control on a phone: a 44px target round a 32px grey disc, seen and
 *  hit. The sheet's ✕ was a 16px grey glyph in a 32px box, easy to miss and
 *  to tap past (14 Oct 2026). */
const PHONE_TOOL = 'grid h-11 w-11 shrink-0 place-items-center rounded-full disabled:opacity-40';
const PHONE_DISC = 'grid h-8 w-8 place-items-center rounded-full bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100';
/** Room kept clear at the foot for the bar. */
const BAR_SPACE = 76;
/** How far the inset picture keeps from the screen's edges. */
const INSET_MARGIN = 24;
const INSET_MARGIN_PHONE = 12;
/** The band kept clear above the picture for the mode's header (the bar),
 *  below the status bar: on a phone the band starts at the top safe area. */
const HEADER_BAND = 60;
/** How long after the comment's field gains or loses focus a pan or a
 *  resize of the page is still the keyboard's doing, not the person's (ms).
 *  iOS puts a pan back 50-80ms after the blur (ios-keyboard-timing). */
const KEYBOARD_SETTLE_MS = 800;
/** How long the mode takes to leave: the picture growing back over the page (app.css `.comment-mode-leaving`). */
const LEAVE_MS = 200;
const reducedMotion = (): boolean => {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
/** Whether this screen is a phone: the same narrow-touch test the shell's
 *  keyboard handling uses. A narrow desktop window keeps the desktop flow. */
function isPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return !!window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}

/** The page shown as a picture of itself while the mode is up (#4554). */
interface ViewShot {
  url: string;
  /** The view it shows: the value `view.current` had when it was drawn. */
  view: number;
  state: 'drawing' | 'ready' | 'failed';
}

/** The dialog's title rules (feedback-controller.js #556, #732, #4194). */
const TITLE_DEBOUNCE_MS = 900;
const TITLE_MIN = 12;
const TITLE_MAX_PER_BOX = 8;
const TITLE_SOURCE_MAX = 2000;

/** The images the server takes (validateScreenshotUpload). */
const IMAGE_TYPES = ['image/png', 'image/jpeg'];

/** The comment cursor: the pin's own shape with a plus, its point at the tip. */
const CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'30\' height=\'30\' viewBox=\'0 0 30 30\'%3E%3Cpath d=\'M3 27V15a12 12 0 1 1 12 12z\' fill=\'%230a6ee0\' stroke=\'white\' stroke-width=\'2\'/%3E%3Cpath d=\'M15 10.5v9M10.5 15h9\' stroke=\'white\' stroke-width=\'2.2\' stroke-linecap=\'round\'/%3E%3C/svg%3E") 3 27, crosshair';

/** A pin's shape: round, but for the corner that sits on the point. */
const PIN_SHAPE = 'rounded-[50%_50%_50%_0]';

interface AppTarget { slug: string; name: string }

/**
 * The running app, when a request can go to it: the feedback dialog's rule
 * (../dialogs/feedback-controller.js, `canTargetApp`), read the same way.
 */
function appTarget(): AppTarget | null {
  const w = window as unknown as {
    App?: { currentApp?: string | null; currentTab?: string };
    AppView?: {
      appData?: { repo_url?: string; self_hosted?: boolean; name?: string; slug?: string } | null;
      _stagingPreview?: { sessionId?: number; slug?: string; name?: string; self_hosted?: boolean } | null;
    };
  };
  const slug = w.App?.currentApp;
  const data = w.AppView?.appData;

  // A change's preview over the app: the request goes to the app the preview
  // is showing. When that is the app under the tab, the usual repo checks
  // decide, without the tab check (the preview may be open from a chat or a
  // message). A different app is filable whatever tab is open; a self-hosted
  // one never is (there is no repo to file against).
  if (visibleFrame()?.preview) {
    const pv = w.AppView?._stagingPreview || null;
    if (pv?.slug) {
      const sameApp = !!(data && data.slug === pv.slug);
      if (sameApp) {
        if (!slug || !data) return null;
        if (!isRepoAddress(data.repo_url) || data.self_hosted) return null;
        return { slug, name: data.name || slug };
      }
      if (pv.self_hosted) return null;
      return { slug: pv.slug, name: pv.name || pv.slug };
    }
  }

  if (!slug || !data) return null;
  if (w.App?.currentTab !== 'app' && w.App?.currentTab !== 'dev') return null;
  if (!isRepoAddress(data.repo_url) || data.self_hosted) return null;
  return { slug, name: data.name || slug };
}

/**
 * The frame comment mode takes its pins over, when it is on screen: the
 * change preview's frame first (it sits over the app), then the running
 * app's. `preview` is the previewed change's id, or null in the app frame.
 */
function visibleFrame(): { frame: HTMLIFrameElement; rect: Rect; preview: number | null } | null {
  for (const [id, preview] of [['staging-iframe', AppViewStagingPreviewId()], ['app-iframe', null]] as const) {
    const frame = document.getElementById(id) as HTMLIFrameElement | null;
    if (!frame || !frame.src) continue;
    const r = frame.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility()) continue;
    return { frame, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, preview };
  }
  return null;
}

/** The change a staging preview is showing (`AppView._stagingPreview`), or null. */
function AppViewStagingPreviewId(): number | null {
  const pv = (window as unknown as { AppView?: { _stagingPreview?: { sessionId?: unknown } | null } }).AppView?._stagingPreview;
  return pv && typeof pv.sessionId === 'number' ? pv.sessionId : null;
}

/** The page's own element under a point, looking through this layer. */
function underPoint(p: Point, host: HTMLElement): Element | null {
  const all = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(p.x, p.y) : [];
  for (const el of all) {
    if (!host.contains(el)) return el === document.documentElement || el === document.body ? null : el;
  }
  return null;
}

/**
 * Where a pin is kept: on the element it was put on, at the same offset, so
 * it moves with that element when the page scrolls. `at` is where it was.
 */
interface Anchor { el: Element | null; dx: number; dy: number; at: Point }

function anchorAt(p: Point, host: HTMLElement): Anchor {
  const el = underPoint(p, host);
  if (!el) return { el: null, dx: 0, dy: 0, at: p };
  const r = el.getBoundingClientRect();
  return { el, dx: p.x - r.left, dy: p.y - r.top, at: p };
}

/** Where an anchored pin is now; null when it is off the page or its element has gone. */
function anchorPoint(a: Anchor, size: Size): Point | null {
  if (!a.el) return a.at;
  if (!a.el.isConnected) return null;
  const r = a.el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const p = { x: r.left + a.dx, y: r.top + a.dy };
  if (p.x < 0 || p.y < 0 || p.x > size.width || p.y > size.height) return null;
  return p;
}

function clampToViewport(p: Point, size: Size): Point {
  return {
    x: Math.max(0, Math.min(size.width - 1, p.x)),
    y: Math.max(0, Math.min(size.height - 1, p.y)),
  };
}

/** The page's size now, from the window. */
const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

/** Whether a scroll's target is the page's own document rather than an element scroller in it. */
function isDocumentScroll(target: EventTarget | null): boolean {
  return target === document || target === document.documentElement
    || target === document.body || target === document.scrollingElement;
}

function toast(line: string): void {
  (window as unknown as { PlatformUI?: { toast?: (m: string) => void } }).PlatformUI?.toast?.(line);
}

interface Budget { remaining: number | null; limit: number | null }

/** The weekly kudos the header's meter already holds (Kudos.Budget). */
function kudosBudget(): Budget {
  const state = (window as unknown as { Kudos?: { Budget?: { state?: { remaining?: number; limit?: number } | null } } })
    .Kudos?.Budget?.state;
  return {
    remaining: typeof state?.remaining === 'number' ? state.remaining : null,
    limit: typeof state?.limit === 'number' ? state.limit : null,
  };
}

function refreshKudosBudget(): Promise<unknown> {
  try {
    const k = (window as unknown as { Kudos?: { Budget?: { refresh?: () => unknown } } }).Kudos;
    return Promise.resolve(k?.Budget?.refresh?.()).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** What the form hands over when the person switches to comment mode. */
export interface CommentCarry {
  text?: string;
  title?: string;
  images?: Blob[];
  bounty?: boolean;
  target?: Target | null;
}

export interface OpenOptions {
  /** How it was opened: the key, "Suggest an improvement", or the form's switch. */
  via?: 'key' | 'suggest' | 'switch';
  /** The form's draft, which the first comment takes. */
  carry?: CommentCarry | null;
}

interface Picture {
  key: number;
  /** Drawn, null when it could not be, undefined while drawing. */
  base: Base | null | undefined;
  promise: Promise<Base | null>;
  thumb: string;
  /** The whole picture, for the close-up: an object URL once drawn, '' until then. */
  url: string;
  /** Its size in its own pixels, once drawn. */
  size: Size | null;
  /** The crop applied to it, when the person cropped it: the frame's rect as
   *  fractions of the full picture, its own thumbnail and close-up, its size. */
  cut: { rect: Rect; thumb: string; url: string; size: Size } | null;
  /** The view it shows: how many times the page had scrolled, and its route, when it was drawn. */
  view: number;
  screen: string;
  /** The comment whose point the running app was asked about (its `at`), if that is still where it is. */
  askedFor: number | null;
}

interface Comment {
  key: number;
  anchor: Anchor;
  inApp: boolean;
  /** The change the preview was showing, when the pin went in a preview. */
  preview: number | null;
  /** The route the page was on, for the where line. */
  screen: string;
  /** The picture its pin is on, when it has one. */
  picture: number | null;
  /** Where its pin is on that picture, as fractions of its width and height. */
  pin: Point;
  text: string;
}

/**
 * An image the person added: its file's own name, or '' for none. `n`
 * numbers one the form handed over, which is named by its place ("Image 2").
 */
interface Image { blob: Blob; url: string; name: string; n: number | null }

type TitleState = 'none' | 'auto' | 'mine';

/** A request being written: one comment, or several, each with its own pin. */
interface Draft {
  key: number;
  comments: Comment[];
  /** The comment being written; null while the next one waits for its click. */
  active: number | null;
  pictures: Picture[];
  keepShot: boolean;
  title: string;
  titleState: TitleState;
  /** The words the suggested title was named from. */
  titleFor: string;
  titleAsks: number;
  editingTitle: boolean;
  images: Image[];
  kudos: boolean;
  chosen: Target | null;
  sending: boolean;
  error: string;
}

interface Posted {
  key: number;
  title: string;
  words: string;
  /** Where it went: the app's name, or Homeroom. */
  to: string;
  /** Its request's number, when the post's link said. */
  number: number | null;
  href: string | null;
  pictures: number;
  comments: number;
  kudos: boolean;
}

/** A posted comment's marker: its request, its number there when it has several. */
interface PostedPin { key: number; request: number; n: number | null; anchor: Anchor }

interface Session {
  host: HTMLElement;
  app: AppTarget | null;
  carry: CommentCarry | null;
}

const liveComments = (d: Draft) => d.comments.filter((c) => c.text.trim());
const draftWords = (d: Draft) => liveComments(d).map((c) => c.text.trim()).join('\n');
const hasWords = (d: Draft | null) => !!d && d.comments.some((c) => c.text.trim());
const activeComment = (d: Draft | null) => (d && d.active != null ? d.comments.find((c) => c.key === d.active) || null : null);
/** The pictures the request's comments are on, in order; none once the screenshot is removed. */
const usedPictures = (d: Draft) => (d.keepShot
  ? d.pictures.filter((p) => p.base !== null && d.comments.some((c) => c.picture === p.key)) : []);
const pictureCount = (d: Draft) => usedPictures(d).length + d.images.length;
const prune = (pictures: Picture[], comments: Comment[]) => pictures.filter((p) => comments.some((c) => c.picture === p.key));
const routeOf = () => (location.hash || '#home').split('?')[0].slice(0, 120);

/** The title a post carries: the person's, or a suggestion named from these very words (#732). */
function titleToSend(d: Draft): string {
  if (d.titleState === 'mine') return d.title.trim();
  if (d.titleState === 'auto' && d.titleFor === draftWords(d)) return d.title.trim();
  return '';
}

/** Whether comment mode's how-it-works note was shown on this device (#4541). */
const INTRO_KEY = 'usernode:comment-intro-seen';

function introSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) != null;
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_KEY, '1');
  } catch { /* private mode: the note shows again next time */ }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The crop over a picture: the picture full size in its frame, the frame's
 * rect cut out of it (the rest dimmed), corner and edge handles that drag
 * inward, and the request's pins on that picture — one outside the frame
 * drawn faded, on its way out with the part cut away.
 */
function CropFrame({ pic, rect, onRect, frame, page, phone, draft, numbered }: {
  pic: Picture;
  rect: Rect;
  onRect: (rect: Rect) => void;
  frame: { x: number; y: number; scale: number };
  page: Size;
  phone: boolean;
  draft: Draft;
  numbered: boolean;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: CropHandle; start: Point; from: Rect } | null>(null);
  const W = page.width * frame.scale;
  const H = page.height * frame.scale;
  // Forty points of the picture, at least, on either axis.
  const min = { width: 40 / Math.max(1, page.width), height: 40 / Math.max(1, page.height) };
  const onDown = (handle: CropHandle) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { handle, start: { x: e.clientX, y: e.clientY }, from: rect };
    rootRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    onRect(dragCrop(d.from, d.handle,
      { x: (e.clientX - d.start.x) / Math.max(1, W), y: (e.clientY - d.start.y) / Math.max(1, H) }, min));
  };
  const onUp = () => { drag.current = null; };
  const cursorOf = (h: CropHandle) => (h === 'nw' || h === 'se'
    ? 'cursor-nwse-resize'
    : h === 'ne' || h === 'sw'
      ? 'cursor-nesw-resize'
      : h === 'n' || h === 's' ? 'cursor-ns-resize' : 'cursor-ew-resize');
  const HIT = phone ? 44 : 24;
  const CORNER = phone ? 18 : 14;
  const EDGE = { w: 40, h: phone ? 10 : 8 };
  const handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  // A handle's anchor, in screen pixels: its two named sides, or the middle of its one.
  const anchor = (h: CropHandle): Point => ({
    x: rect.x * W + (h.includes('e') ? rect.width * W : h.includes('w') ? 0 : (rect.width * W) / 2),
    y: rect.y * H + (h.includes('s') ? rect.height * H : h.includes('n') ? 0 : (rect.height * H) / 2),
  });
  return (
    <div ref={rootRef} className="fixed inset-0" style={{ touchAction: 'none' }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div aria-hidden="true" className="absolute inset-0 bg-zinc-300 dark:bg-zinc-800" />
      <div
        className="absolute overflow-hidden rounded-2xl bg-white ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
        style={{ left: frame.x, top: frame.y, width: W, height: H }}
      >
        <img
          src={pic.url || pic.thumb}
          alt=""
          draggable={false}
          className="pointer-events-none absolute start-0 top-0 max-w-none select-none"
          style={{ width: W, height: H }}
        />
        {/* The part kept; what is outside it goes dark. */}
        <div
          aria-hidden="true"
          className="absolute border-2 border-white"
          style={{ left: rect.x * W, top: rect.y * H, width: rect.width * W, height: rect.height * H, boxShadow: CROP_SHADE }}
        />
        {/* Handles: a visible grip inside a bigger transparent hit box. */}
        {handles.map((h) => {
          const at = anchor(h);
          const corner = h.length === 2;
          return (
            <div
              key={h}
              onPointerDown={onDown(h)}
              className={`absolute grid place-items-center ${cursorOf(h)}`}
              style={{ left: at.x - HIT / 2, top: at.y - HIT / 2, width: HIT, height: HIT, touchAction: 'none' }}
            >
              {corner ? (
                <span aria-hidden="true" className="rounded-[3px] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)]" style={{ width: CORNER, height: CORNER }} />
              ) : (
                <span
                  aria-hidden="true"
                  className="rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
                  style={h === 'n' || h === 's' ? { width: EDGE.w, height: EDGE.h } : { width: EDGE.h, height: EDGE.w }}
                />
              )}
            </div>
          );
        })}
        {/* The request's pins on this picture, numbered as the draft numbers them. */}
        {draft.comments.map((c, i) => {
          if (c.picture !== pic.key) return null;
          const inside = pinInCrop(c.pin, rect) !== null;
          const s = toScreen({ x: c.pin.x * page.width, y: c.pin.y * page.height }, frame);
          return (
            <span
              key={c.key}
              aria-hidden="true"
              className={`absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white text-[13px] font-extrabold text-violet-600 shadow-[0_0_0_2.5px_#0a6ee0,0_3px_10px_rgba(0,0,0,0.2)] dark:bg-zinc-900${inside ? '' : ' opacity-40'}`}
              style={{ left: s.x, top: s.y - 30 }}
            >
              {numbered ? i + 1 : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function CommentMode({ session, onClose }: { session: Session; onClose: () => void }): ReactNode {
  const t = useMessages('devchat');
  const { host, app } = session;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [postedPins, setPostedPins] = useState<PostedPin[]>([]);
  // The last posted request, for the sent card on the screen: the toast is
  // gone in a moment and the bar's chip never shows on a phone.
  const [sent, setSent] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<'exit' | 'discard' | null>(null);
  const [carry, setCarry] = useState<CommentCarry | null>(session.carry);
  const [titleLoading, setTitleLoading] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [tick, setTick] = useState(0);
  // The first picture is on its way from the first render: until it lands
  // the live page shows through and nothing of the mode is drawn over it.
  const [viewShot, setViewShot] = useState<ViewShot | null>({ url: '', view: 0, state: 'drawing' });
  const [budget, setBudget] = useState<Budget>(kudosBudget);
  const [boxAt, setBoxAt] = useState<Point>({ x: -9999, y: -9999 });
  const [cardAt, setCardAt] = useState<Point>({ x: -9999, y: -9999 });
  const [barAt, setBarAt] = useState<Point | null>(null);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  /** Cropping in progress: which picture, and the frame's rect as fractions of it. */
  const [cropping, setCropping] = useState<{ picture: number; rect: Rect } | null>(null);
  // On a phone a comment starts small: its pin, and beside it a box that
  // looks like a field but is not one, so the keyboard stays down and the
  // page stays in sight. A tap on that box opens the sheet with the
  // keyboard; until then the comment can be dragged elsewhere or closed. A
  // tap that opened the sheet straight away put the keys up over the page
  // the person was still looking at (14 Oct 2026).
  const [expanded, setExpanded] = useState(false);
  /** The open comment's pin, on screen, while a finger drags it. */
  const [dragAt, setDragAt] = useState<Point | null>(null);
  const pinDrag = useRef<{ id: number; start: Point; from: Point; moved: boolean } | null>(null);
  /** When a drag last ended: the click the lift may still send is not a tap. */
  const draggedAt = useRef(-Infinity);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const keys = useRef(0);
  const hoverFrame = useRef(0);
  const view = useRef(0);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const touch = useRef<{ id: number; start: Point; moved: boolean } | null>(null);
  const viewShotKeys = useRef(0);
  const viewShotUrl = useRef<string | null>(null);
  // The page's size as the mode keeps it. The keyboard does not change it:
  // with the keys up iOS collapses `innerHeight` to what is above them (874
  // to 539 on an iPhone 17), and read from the window the picture shrank,
  // the bar narrowed and a pin went down against the wrong height.
  const [size, setSize] = useState<Size>(windowSize);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // The status bar's height (env(safe-area-inset-top), the shell's
  // --platform-safe-top), measured off a probe: the band for the bar starts
  // under it. 0 on a computer and in a phone browser.
  const safeRef = useRef<HTMLDivElement>(null);
  const [safeTop, setSafeTop] = useState(0);
  // And the home indicator's (--platform-safe-bottom): the phone's small box
  // keeps above it.
  const safeBottomRef = useRef<HTMLDivElement>(null);
  const [safeBottom, setSafeBottom] = useState(0);
  // Until when the keyboard is still arriving or leaving.
  const keyboardUntil = useRef(-Infinity);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [intro, setIntro] = useState(() => !introSeen());
  // The phone's sheet rides the keyboard: its fields reveal inside it, and
  // it moves with the keys the way the shell's own bottom sheets do.
  useKeyboardSurface(boxRef, { ride: true });

  const update = useCallback((key: number, patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => {
    setDraft((d) => (d && d.key === key ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d));
  }, []);

  // Cropping ends with its picture: if the picture goes while the frame is
  // up (the screenshots removed, the draft discarded), the mode goes back
  // to the page.
  useEffect(() => {
    if (cropping && (!draft || !draft.pictures.some((pic) => pic.key === cropping.picture))) setCropping(null);
  }, [draft, cropping]);
  // The sent card stands down once the next comment has words. Clearing
  // here, not only in the render, means deleting the words afterwards does
  // not bring it back.
  useEffect(() => {
    if (hasWords(draft)) setSent(null);
  }, [draft]);

  // The bar has the keyboard from the start, so Esc and C reach the shell
  // even when the app's frame had it.
  useEffect(() => { barRef.current?.focus({ preventScroll: true }); }, []);
  // The note counts as seen as soon as it appears (#4541).
  useEffect(() => { if (intro) markIntroSeen(); }, []);
  useEffect(() => { void refreshKudosBudget().then(() => setBudget(kudosBudget())); }, []);

  useLayoutEffect(() => {
    const h = safeRef.current?.offsetHeight || 0;
    if (h !== safeTop) setSafeTop(h);
    const b = safeBottomRef.current?.offsetHeight || 0;
    if (b !== safeBottom) setSafeBottom(b);
  });

  // The pins move with the page: a scroll of the page, or a new page size,
  // redraws, and is a new view (a picture of the old one no longer shows
  // it). Three things that move nothing on the page are not one:
  //  - the mode's own scrollers, the phone's sheet and its field;
  //  - the keyboard, which iOS announces as a resize of the visual viewport
  //    and, when it reveals a field, a pan of the document. On a phone every
  //    comment raised it, so every comment's close-up fell back to a
  //    stretched thumbnail (iPhone 17 simulator, 12 Oct 2026);
  //  - a height-only resize while the keyboard is about.
  // A document scroll while the keyboard is about is the keyboard's.
  useEffect(() => {
    let frame = 0;
    const redraw = () => {
      view.current += 1;
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1); });
    };
    const keyboardAbout = () => textFocused(document)
      || document.documentElement.classList.contains(KB_OPEN_CLASS)
      || performance.now() < keyboardUntil.current;
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && host.contains(target)) return;
      if (isDocumentScroll(target) && keyboardAbout()) return;
      redraw();
    };
    const onResize = () => {
      const next = windowSize();
      const was = sizeRef.current;
      if (next.width === was.width && next.height === was.height) return;
      if (next.width === was.width && keyboardAbout()) return;
      sizeRef.current = next;
      setSize(next);
      redraw();
    };
    const onFocusMove = () => { keyboardUntil.current = performance.now() + KEYBOARD_SETTLE_MS; };
    const vv = window.visualViewport;
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    vv?.addEventListener('resize', onResize);
    host.addEventListener('focusin', onFocusMove);
    host.addEventListener('focusout', onFocusMove);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
      host.removeEventListener('focusin', onFocusMove);
      host.removeEventListener('focusout', onFocusMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [host]);

  // ── The view picture ────────────────────────────────────────────────
  //
  // The page as a picture, shown inset so nothing reads as clickable. Taken
  // when the mode opens, and 250ms after the last scroll or resize (the
  // redraw above bumps `view` and re-renders for the pins; this redraws the
  // picture). Until a retake lands the last one shows faded and taps wait.
  // When the picture cannot be taken, the mode renders as it always did,
  // over the live page, so a comment can always be left.
  const takeViewShot = useCallback(() => {
    const shown = visibleFrame();
    const key = ++viewShotKeys.current;
    const at = view.current;
    setViewShot((s) => ({ url: s?.url || '', view: at, state: 'drawing' }));
    const page = sizeRef.current;
    takeBase({
      host,
      scale: pictureScale(window.devicePixelRatio, page),
      frame: shown?.frame ?? null,
      frameRect: shown?.rect ?? null,
      pin: { x: page.width / 2, y: page.height / 2 },
      viewport: page,
    }).then((b) => {
      const fail = () => setViewShot((s) => ({ url: s?.url || '', view: at, state: 'failed' }));
      if (key !== viewShotKeys.current) return;
      if (!b) { fail(); return; }
      b.canvas.toBlob((blob) => {
        if (key !== viewShotKeys.current) return;
        if (!blob) { fail(); return; }
        const url = URL.createObjectURL(blob);
        // Decoded before it is shown: put up undecoded, the picture's first
        // frame was its white box over the whole screen, a flash before it
        // shrank in (iPhone 17 Pro simulator, 12 Oct 2026).
        const decoded = new Image();
        decoded.src = url;
        const show = () => {
          if (key !== viewShotKeys.current) { URL.revokeObjectURL(url); return; }
          if (viewShotUrl.current) URL.revokeObjectURL(viewShotUrl.current);
          viewShotUrl.current = url;
          setViewShot({ url, view: at, state: 'ready' });
        };
        (typeof decoded.decode === 'function' ? decoded.decode() : Promise.resolve()).then(show, show);
      }, 'image/png');
    }, () => {
      if (key === viewShotKeys.current) {
        setViewShot((s) => ({ url: s?.url || '', view: at, state: 'failed' }));
      }
    });
  }, [host]);

  useEffect(() => {
    if (tick === 0) {
      // The first picture waits for the menu sheet or the form the mode was
      // opened from to finish leaving (`overlaysGone`). When one was drawn
      // ahead while that sheet was open (`prepareCommentView`) and the page
      // has not changed since, it goes up the moment the sheet is gone.
      let live = true;
      const ahead = takeAhead(sizeRef.current);
      void Promise.all([ahead, overlaysGone()]).then(([got]) => {
        if (!live) return;
        if (!got) { takeViewShot(); return; }
        if (got.size.height !== sizeRef.current.height) { sizeRef.current = got.size; setSize(got.size); }
        viewShotUrl.current = got.url;
        setViewShot({ url: got.url, view: view.current, state: 'ready' });
      });
      return () => { live = false; };
    }
    const timer = setTimeout(takeViewShot, 250);
    return () => clearTimeout(timer);
  }, [tick, takeViewShot]);

  useEffect(() => () => {
    if (viewShotUrl.current) URL.revokeObjectURL(viewShotUrl.current);
  }, []);

  // Whether the page is shown as the inset picture, and where it sits. The
  // picture leaves a band at the top for the mode's header, so the bar is
  // part of the view instead of floating over the page. A failed picture
  // keeps the mode over the live page, untransformed, bar at the foot.
  const phone = isPhone();
  // The band above the picture: under the status bar, then the bar's own 60px.
  const band = safeTop + HEADER_BAND;
  const inset = viewShot && viewShot.state !== 'failed'
    ? insetFrame(size, phone ? INSET_MARGIN_PHONE : INSET_MARGIN, band)
    : null;
  // The first picture, nothing drawn yet: the live page stays on show (the
  // mode's layer above it already keeps every press off it) instead of a
  // bare grey ground, and the picture shrinks into its frame once it lands
  // (#4665). `intro` below is the note about the mode; this is the shot's.
  const shotIntro = viewShot?.state === 'drawing' && !viewShot.url;
  // The word that names the picture, "Screenshot", leads the bar in the band
  // above it whenever the picture is on show: in the bar, never over the
  // picture, where it covered the page's own header (#4774).
  const shotLabel = !!inset && !shotIntro;
  // While cropping, the frame the crop happens over: the picture's own inset
  // frame when there is one, else the frame the picture would sit in — a
  // failed view keeps the mode over the live page, and the crop still works
  // on the picture it took.
  const cropFrame = cropping
    ? (inset ?? insetFrame(size, phone ? INSET_MARGIN_PHONE : INSET_MARGIN, band))
    : null;

  // ── Leaving ─────────────────────────────────────────────────────────
  //
  // The mode leaves the way it came: the picture grows back over the page it
  // shows while the ground and the controls fade, and only then does the
  // layer go and what follows (the form) open. Unmounted at once, it vanished
  // in a frame and the form slid up over a page that had just jumped (iPhone
  // 17 Pro simulator, 12 Oct 2026). With no picture on show, or under
  // reduced motion, it goes at once.
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const leave = useCallback((then?: () => void) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const finish = () => { onClose(); then?.(); };
    if (!inset || shotIntro || !viewShot?.url || reducedMotion()) { finish(); return; }
    setLeaving(true);
    setTimeout(finish, LEAVE_MS);
  }, [inset, shotIntro, viewShot, onClose]);

  // Images the person added are object URLs until the mode closes.
  const urls = useRef(new Set<string>());
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  /** Start drawing the page with a pin at `p`; the box shows it when it lands. */
  const drawPicture = useCallback((draftKey: number, p: Point, askedFor: number): Picture => {
    const shown = visibleFrame();
    const key = ++keys.current;
    const page = sizeRef.current;
    const promise = takeBase({
      host,
      scale: pictureScale(window.devicePixelRatio, page),
      frame: shown?.frame ?? null,
      frameRect: shown?.rect ?? null,
      pin: p,
      viewport: page,
    });
    const land = (patch: Partial<Picture>) => setDraft((d) => (d && d.key === draftKey
      ? { ...d, pictures: d.pictures.map((pic) => (pic.key === key && pic.promise === promise ? { ...pic, ...patch } : pic)) }
      : d));
    promise.then((b) => {
      let thumb = '';
      if (b) {
        try { thumb = thumbnail(b.canvas, 160); } catch { /* no preview, still attached */ }
      }
      land({ base: b, thumb, size: b ? { width: b.canvas.width, height: b.canvas.height } : null });
      // The whole picture for the close-up, at its own size.
      b?.canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        land({ url });
      }, 'image/png');
    }, () => land({ base: null, thumb: '' }));
    return { key, base: undefined, promise, thumb: '', url: '', size: null, cut: null, view: view.current, screen: routeOf(), askedFor };
  }, [host]);

  /**
   * The picture a pin at `p` goes on: one already drawn of this same view
   * (nothing has scrolled or moved since), else a new one while there is
   * room for it beside the others and the person's own images.
   */
  const pictureFor = useCallback((d: Draft, p: Point, commentKey: number): { pictures: Picture[]; picture: number | null } => {
    // A cropped picture takes the pin only when the pin's spot survived the
    // crop: otherwise a new picture of the same view is drawn, while there
    // is room for one.
    const pin = { x: p.x / Math.max(1, size.width), y: p.y / Math.max(1, size.height) };
    const same = d.pictures.find((pic) => pic.view === view.current && pic.screen === routeOf()
      && pic.base !== null && (!pic.cut || pinInCrop(pin, pic.cut.rect) !== null));
    if (same) return { pictures: d.pictures, picture: same.key };
    const others = d.comments.filter((c) => c.key !== commentKey);
    const inUse = d.pictures.filter((pic) => others.some((c) => c.picture === pic.key)).length;
    if (inUse + d.images.length >= MAX_PICTURES) return { pictures: d.pictures, picture: null };
    const pic = drawPicture(d.key, p, commentKey);
    return { pictures: [...d.pictures, pic], picture: pic.key };
  }, [drawPicture, size]);

  /**
   * A press on the page: the open comment's pin moved there, the request's
   * next comment there (after "Add a comment"), or a new request there. On
   * a phone with the sheet open it folds the sheet back to the small box.
   */
  const place = useCallback((at: Point) => {
    if (open != null) { setOpen(null); return; }
    // The page above the phone's sheet is out of the way of the sheet, not a
    // new spot: a press there puts the keys down and leaves the pin where it
    // is, as a tap outside any sheet closes it.
    if (phone && expanded && draft && draft.active != null) {
      if (!draft.sending) setExpanded(false);
      return;
    }
    // Over the inset picture the press is on the picture, not the page: back
    // to page coordinates, and nothing where the picture is not.
    let where = at;
    if (inset) {
      if (viewShot?.state === 'drawing') return;
      const page = toPage(at, inset);
      if (page.x < -1 || page.y < -1 || page.x > size.width || page.y > size.height) return;
      where = page;
    }
    const p = clampToViewport(where, size);
    const anchor = anchorAt(p, host);
    const shown = visibleFrame();
    const inApp = inRect(p, shown?.rect);
    const preview = inApp ? (shown?.preview ?? null) : null;
    const screen = routeOf();
    const pin = { x: p.x / Math.max(1, size.width), y: p.y / Math.max(1, size.height) };
    setConfirm(null);
    setIntro(false);
    if (draft) {
      if (draft.sending) return;
      const current = activeComment(draft);
      if (current) {
        // A click elsewhere moves the open comment's pin; its words stay.
        const got = pictureFor(draft, p, current.key);
        const comments = draft.comments.map((c) => (c.key === current.key
          ? { ...c, anchor, inApp, preview, screen, picture: got.picture, pin } : c));
        const pictures = prune(got.pictures, comments).map((pic) => (pic.key === got.picture && pic.askedFor === current.key && pic.key === current.picture
          ? { ...pic, askedFor: null } : pic));
        setDraft({ ...draft, comments, pictures, error: '' });
        textRef.current?.focus({ preventScroll: true });
        return;
      }
      if (draft.comments.length >= MAX_COMMENTS) return;
      const key = ++keys.current;
      const got = pictureFor(draft, p, key);
      setExpanded(false);
      setDraft({
        ...draft,
        pictures: got.pictures,
        comments: [...draft.comments, { key, anchor, inApp, preview, screen, picture: got.picture, pin, text: '' }],
        active: key,
        error: '',
      });
      return;
    }
    const c = carry;
    setCarry(null);
    const images: Image[] = (c?.images || []).filter((b) => IMAGE_TYPES.includes(b.type)).slice(0, MAX_PICTURES - 1)
      .map((blob, i) => {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        return { blob, url, name: '', n: i + 1 };
      });
    const empty: Draft = {
      key: ++keys.current,
      comments: [],
      active: null,
      pictures: [],
      keepShot: true,
      title: c?.title || '',
      titleState: c?.title ? 'mine' : 'none',
      titleFor: '',
      titleAsks: 0,
      editingTitle: false,
      images,
      // #5249: a draft saved before kudos was parked does not carry its kudos.
      kudos: !KUDOS_PARKED && !!c?.bounty,
      chosen: c?.target ?? null,
      sending: false,
      error: '',
    };
    const key = ++keys.current;
    const got = pictureFor(empty, p, key);
    setExpanded(false);
    setDraft({
      ...empty,
      pictures: got.pictures,
      comments: [{ key, anchor, inApp, preview, screen, picture: got.picture, pin, text: c?.text || '' }],
      active: key,
    });
  }, [open, phone, expanded, host, draft, carry, pictureFor, inset, viewShot, size]);

  /** A field that opens with the keyboard: focused without the pan `autoFocus` would cause. */
  const focusWithoutPan = useCallback((el: HTMLElement | null) => { el?.focus({ preventScroll: true }); }, []);

  // The open comment's words have the keyboard whenever a comment opens,
  // focused without a scroll: a plain focus() had iOS pan the whole page up
  // to reveal the field, the bar and the band with it, and left the sheet
  // over everything (iPhone 17 simulator, 12 Oct 2026). With no pan the
  // sheet stands on the keys (`.platform-kb-sheet`) under the bar. On a
  // phone that waits for the sheet: the small box has no field.
  const draftKey = draft?.key;
  const activeKey = draft?.active ?? null;
  const writing = !phone || expanded;
  useEffect(() => {
    const t = textRef.current;
    if (!t || !writing) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
  }, [draftKey, activeKey, writing]);

  // #556: the title, suggested from all the request's words after a pause.
  const words = draft ? draftWords(draft) : '';
  const titleMine = draft?.titleState === 'mine';
  const editingTitle = !!draft?.editingTitle;
  useEffect(() => {
    if (!draft || titleMine || editingTitle) return undefined;
    const key = draft.key;
    if (words.length < TITLE_MIN) {
      if (draft.title) update(key, { title: '', titleState: 'none', titleFor: '' });
      return undefined;
    }
    if (words === draft.titleFor || draft.titleAsks >= TITLE_MAX_PER_BOX) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      update(key, (d) => ({ titleAsks: d.titleAsks + 1 }));
      setTitleLoading(true);
      try {
        const res = await window.fetch('/api/feedback/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: words.slice(0, TITLE_SOURCE_MAX) }),
        });
        const data = (res.ok ? await res.json() : {}) as { title?: unknown };
        if (!live) return;
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title) {
          update(key, (d) => (d.titleState === 'mine' || draftWords(d) !== words
            ? {} : { title, titleState: 'auto', titleFor: words }));
        }
      } catch { /* silent: the server names it when it is posted */ }
      finally {
        if (live) setTitleLoading(false);
      }
    }, TITLE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); setTitleLoading(false); };
    // `draft` is read for its key and counters; a new keystroke is `words`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, words, titleMine, editingTitle]);

  const addImages = useCallback((files: File[]) => {
    if (!draft) return;
    const key = draft.key;
    const room = MAX_PICTURES - pictureCount(draft);
    const usable = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (usable.length < files.length) update(key, { error: t('devchat:commentPin.error.imageType') });
    if (room <= 0) {
      update(key, { error: t('devchat:commentPin.error.imageLimit', { count: MAX_PICTURES }) });
      return;
    }
    const added = usable.slice(0, room).map((f) => {
      const url = URL.createObjectURL(f);
      urls.current.add(url);
      return { blob: f as Blob, url, name: f.name || '', n: null };
    });
    if (added.length) update(key, (d) => ({ images: [...d.images, ...added], ...(usable.length === files.length ? { error: '' } : {}) }));
  }, [draft, update, t]);

  const removeImage = (key: number, url: string) => {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
    update(key, (d) => ({ images: d.images.filter((i) => i.url !== url) }));
  };

  /** The request as a post: its words (numbered when there are several), each picture clean with its pins beside it. */
  const postFor = useCallback(async (d: Draft): Promise<CommentPost> => {
    const live = liveComments(d);
    const many = live.length > 1;
    const bases = new Map<number, Base | null>();
    for (const pic of d.pictures) {
      bases.set(pic.key, pic.base === undefined ? await pic.promise.catch(() => null) : pic.base);
    }
    const spots: Spot[] = live.map((c) => {
      const pic = c.picture != null ? d.pictures.find((x) => x.key === c.picture) : null;
      const base = pic ? bases.get(pic.key) ?? null : null;
      let at: ElementInfo | null;
      if (c.inApp) at = pic && pic.askedFor === c.key ? base?.app?.at ?? null : null;
      else at = c.anchor.el && c.anchor.el.isConnected ? describeElement(c.anchor.el) : null;
      return { inApp: c.inApp, preview: c.inApp ? c.preview : null, screen: c.inApp ? (base?.app?.path || '') : c.screen, at };
    });
    const shots: CommentShot[] = [];
    if (d.keepShot) {
      for (const pic of d.pictures) {
        const base = bases.get(pic.key);
        // A cropped picture posts cropped: the frame is cut off the full
        // canvas, and each pin maps into the crop's own fractions — one
        // outside the crop has gone with the part cut away.
        const pins = live.map((c, i) => ({ c, i, at: pinInCrop(c.pin, pic.cut?.rect ?? null) }))
          .filter(({ c, at }) => c.picture === pic.key && at)
          .map(({ c, i, at }) => ({ x: at!.x, y: at!.y, n: many ? i + 1 : null, note: c.text.trim() }));
        if (!base || !pins.length) continue;
        const canvas = pic.cut ? cropCanvas(base.canvas, pic.cut.rect) : base.canvas;
        try {
          const blob = await encodeUnder(canvas);
          if (blob) shots.push({ blob, pins });
        } catch { /* that picture stays behind; the words go */ }
      }
    }
    const first = live[0] || d.comments[0];
    const target: Target = app ? (d.chosen ?? (first?.inApp ? 'app' : 'platform')) : 'platform';
    return {
      text: numberedWords(live.map((c) => c.text)),
      target,
      appSlug: app?.slug ?? null,
      shots,
      images: d.images.map((i) => i.blob),
      title: titleToSend(d),
      bounty: !KUDOS_PARKED && d.kudos && budget.remaining !== 0,
      where: live.length ? whereLines(spots, app?.slug ?? null) : '',
    };
  }, [app, budget.remaining]);

  const send = useCallback(async () => {
    const d = draft;
    if (!d || d.sending || !liveComments(d).length) return;
    update(d.key, { sending: true, error: '', editingTitle: false });
    const post = await postFor(d);
    const outcome = await postComment(post);
    if (outcome.ok) {
      const live = liveComments(d);
      const many = live.length > 1;
      const name = post.target === 'app' && app ? app.name : 'Homeroom';
      const number = numberFromUrl(outcome.url);
      const slug = post.target === 'app' ? app?.slug : platformSlug();
      setPosted((list) => [...list, {
        key: d.key,
        title: outcome.title || post.title || '',
        words: post.text,
        to: name,
        number: number || null,
        href: number && slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${number}` : null,
        pictures: (post.shots?.length || 0) + (post.images?.length || 0),
        comments: live.length,
        kudos: !!outcome.bounty?.placed,
      }]);
      setPostedPins((list) => [...list, ...live.map((c, i) => ({ key: c.key, request: d.key, n: many ? i + 1 : null, anchor: c.anchor }))]);
      setSent(d.key);
      setDraft(null);
      barRef.current?.focus({ preventScroll: true });
      // Whole sentences, one after another: where it went, then what came
      // of the kudos. What joins two of them is a message too.
      const postedLine = many
        ? (outcome.botWillBuild
          ? t('devchat:commentPin.toast.postedManyBuilding', { count: live.length, place: name })
          : t('devchat:commentPin.toast.postedMany', { count: live.length, place: name }))
        : (outcome.botWillBuild
          ? t('devchat:commentPin.toast.postedBuilding', { place: name })
          : t('devchat:commentPin.toast.posted', { place: name }));
      let kudosLine = '';
      // #5249: parked, no kudos sentence, whatever the answer held.
      if (outcome.bounty && !KUDOS_PARKED) {
        kudosLine = outcome.bounty.placed
          ? t('devchat:commentPin.toast.kudosPlaced')
          : outcome.bounty.error
            ? t('devchat:commentPin.toast.kudosFailed', { reason: outcome.bounty.error })
            : t('devchat:commentPin.toast.kudosFailedNoReason');
        void refreshKudosBudget().then(() => setBudget(kudosBudget()));
      }
      toast(kudosLine ? t('devchat:commentPin.toast.sentences', { first: postedLine, second: kudosLine }) : postedLine);
      return;
    }
    if (outcome.handover) {
      leave(() => handOver(post));
      return;
    }
    update(d.key, { sending: false, error: outcome.error });
  }, [draft, update, postFor, app, leave, t]);

  /** The form instead, with whatever the request holds. */
  const toForm = useCallback(async () => {
    const d = draft;
    const post = d && (hasWords(d) || d.images.length) ? await postFor(d) : null;
    leave(() => {
      if (post) {
        handOver(post);
        return;
      }
      (window as unknown as { App?: { openFeedbackModal?: (opts: unknown) => void } }).App?.openFeedbackModal?.({ mode: 'form' });
    });
  }, [draft, postFor, leave]);

  const discard = useCallback(() => {
    setDraft(null);
    setConfirm(null);
    barRef.current?.focus({ preventScroll: true });
  }, []);

  /** The box's ✕, and Esc: straight away when nothing is written, else asked on the bar. */
  const requestDiscard = useCallback(() => {
    if (hasWords(draft)) setConfirm('discard');
    else discard();
  }, [draft, discard]);

  /** Done: leave, unless that would drop words nobody has posted (the request's, or the form's still waiting for a click). */
  const requestExit = useCallback(() => {
    const unposted = draft ? !draft.sending && hasWords(draft) : !!carry?.text?.trim();
    if (unposted) {
      setConfirm('exit');
      return;
    }
    leave();
  }, [draft, carry, leave]);

  /** "Add a comment": the request's next comment goes where the next click is. */
  const addComment = useCallback(() => {
    const cur = activeComment(draft);
    if (!draft || draft.sending || !cur || !cur.text.trim() || draft.comments.length >= MAX_COMMENTS) return;
    update(draft.key, { active: null });
    barRef.current?.focus({ preventScroll: true });
  }, [draft, update]);

  const openComment = useCallback((key: number) => {
    if (!draft || draft.sending) return;
    update(draft.key, { active: key });
  }, [draft, update]);

  const removeComment = useCallback((key: number) => {
    if (!draft || draft.sending || draft.comments.length < 2) return;
    const comments = draft.comments.filter((c) => c.key !== key);
    setDraft({
      ...draft,
      comments,
      pictures: prune(draft.pictures, comments),
      active: draft.active === key || draft.active == null ? comments[comments.length - 1].key : draft.active,
    });
  }, [draft]);

  /**
   * Apply the crop: the comments whose pin fell outside the frame go, the
   * picture carries its crop, and the frame closes. Reset (back to the full
   * picture) takes the crop off again, but comments already dropped by an
   * earlier apply do not come back.
   */
  const applyCrop = useCallback(() => {
    const d = draft;
    const crop = cropping;
    if (!d || !crop || d.sending) return;
    const pic = d.pictures.find((p) => p.key === crop.picture);
    if (!pic || !pic.base) return;
    const onPic = d.comments.filter((c) => c.picture === pic.key);
    const dropped = onPic.filter((c) => pinInCrop(c.pin, crop.rect) === null);
    // Every pin on this picture would go: the Apply button is disabled
    // already, and this keeps a stale frame from cutting the last one.
    if (onPic.length && dropped.length === onPic.length) return;
    const droppedKeys = new Set(dropped.map((c) => c.key));
    const comments = d.comments.filter((c) => !droppedKeys.has(c.key));
    const active = droppedKeys.has(d.active ?? -1) || d.active == null
      ? (comments.length ? comments[comments.length - 1].key : null)
      : d.active;
    if (pic.cut) { URL.revokeObjectURL(pic.cut.url); urls.current.delete(pic.cut.url); }
    if (isFullCrop(crop.rect)) {
      const pictures = prune(d.pictures.map((p) => (p.key === pic.key ? { ...p, cut: null } : p)), comments);
      setDraft({ ...d, comments, pictures, active });
    } else {
      const canvas = cropCanvas(pic.base.canvas, crop.rect);
      let thumb = '';
      try { thumb = thumbnail(canvas, 160); } catch { /* no preview, still cropped */ }
      const cut: NonNullable<Picture['cut']> = { rect: crop.rect, thumb, url: '', size: { width: canvas.width, height: canvas.height } };
      const pictures = prune(d.pictures.map((p) => (p.key === pic.key ? { ...p, cut } : p)), comments);
      setDraft({ ...d, comments, pictures, active });
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setDraft((next) => (next
          ? { ...next, pictures: next.pictures.map((p) => (p.cut && p.cut.rect === crop.rect && !p.cut.url ? { ...p, cut: { ...p.cut, url } } : p)) }
          : next));
      }, 'image/png');
    }
    setCropping(null);
    if (dropped.length) toast(t('devchat:commentPin.crop.removed', { count: dropped.length }));
    requestAnimationFrame(() => { textRef.current?.focus({ preventScroll: true }); });
  }, [draft, cropping, t]);

  const escape = useCallback(() => {
    if (cropping) { setCropping(null); return; }
    if (open != null) { setOpen(null); return; }
    if (confirm) { setConfirm(null); return; }
    if (draft && draft.active == null && draft.comments.length) { openComment(draft.comments[draft.comments.length - 1].key); return; }
    if (draft) { if (!draft.sending) requestDiscard(); return; }
    leave();
  }, [cropping, open, confirm, draft, openComment, requestDiscard, leave]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape]);

  // C again, from ../improve/suggest-shortcut.ts, asks to leave.
  useEffect(() => {
    controller = { exit: requestExit };
    return () => { controller = null; };
  }, [requestExit]);

  // ── The bar ─────────────────────────────────────────────────────────
  //
  // Over the inset picture the bar is that view's header: it sits in the
  // band the picture leaves at the top, the picture's own width, and does
  // not float, so there is no handle to drag it by. Over the live page (a
  // picture that could not be taken) it is as it always was: at the foot,
  // centred, each time comment mode opens, until the person drags its
  // handle; then where they put it, for this visit only (a double-click on
  // the handle puts it back). It never moves out of the way on its own:
  // what is under it is reached by dragging the handle, which wears the
  // four-arrow move glyph and cursor.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    if (width !== barSize.width || height !== barSize.height) setBarSize({ width, height });
  });
  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIntro(false);
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setBarAt({ x: clamp01((e.clientX - d.dx) / Math.max(1, size.width)), y: clamp01((e.clientY - d.dy) / Math.max(1, size.height)) });
  };
  const onGripUp = () => {
    if (!drag.current) return;
    drag.current = null;
  };
  // Where a dragged bar was let go, on the live page.
  const barPlace = barAt && !inset
    ? {
      left: Math.round(Math.max(8, Math.min(size.width - barSize.width - 8, barAt.x * size.width - barSize.width / 2))),
      top: Math.round(Math.max(safeTop + 8, Math.min(size.height - barSize.height - 8, barAt.y * size.height - barSize.height / 2))),
    }
    : null;

  // The box and an open marker's card sit beside their pins: clear of the
  // header at the top over the picture, clear of the bar at the foot over
  // the live page, and above the home indicator.
  const viewport = () => ({ width: size.width, height: Math.max(200, size.height - (inset || barAt ? 0 : BAR_SPACE) - safeBottom) });
  const boxComment = draft ? activeComment(draft) || draft.comments[draft.comments.length - 1] || null : null;
  // Where the box and card go, in screen coordinates: the anchor reads the
  // live element in page coordinates, so it follows scrolls, and the inset
  // picture scales it back up.
  const boxPointPage = boxComment ? (anchorPoint(boxComment.anchor, size) ?? boxComment.anchor.at) : null;
  const boxPoint = dragAt ?? (boxPointPage ? (inset ? toScreen(boxPointPage, inset) : boxPointPage) : null);
  const openPin = open != null ? postedPins.find((p) => p.key === open) || null : null;
  const openRequest = openPin ? posted.find((r) => r.key === openPin.request) || null : null;
  const sentRequest = sent != null ? posted.find((r) => r.key === sent) || null : null;
  const openPointPage = openPin ? anchorPoint(openPin.anchor, size) : null;
  const openPoint = openPointPage ? (inset ? toScreen(openPointPage, inset) : openPointPage) : null;
  // The close-up at the top of the phone's sheet: the area around the open
  // comment's pin, on the picture the pin was put on. That is the comment's
  // own picture once it is drawn; until then the view picture stands in, if
  // it still shows the same view, and otherwise the close-up waits.
  const activePicture = draft && boxComment && boxComment.picture != null
    ? draft.pictures.find((pic) => pic.key === boxComment.picture) || null
    : null;
  const viewDiffers = !!viewShot && !!activePicture && activePicture.view !== viewShot.view;
  const closeUpSrc = activePicture?.url || (viewDiffers ? '' : viewShot?.url || '');
  // Beside the marker where there is room for it; on a narrow screen, under
  // the point (or over the marker), never on top of the pin it belongs to.
  const besidePin = (p: Point, size: { width: number; height: number }): Point => {
    const vp = viewport();
    const fits = p.x + 24 + size.width <= vp.width - 8 || p.x - 24 - size.width >= 8;
    let at: Point;
    if (fits) {
      at = placeBeside({ x: p.x + 10, y: p.y - 30 }, size, vp, 14);
    } else {
      const x = Math.max(8, Math.min(vp.width - 8 - size.width, p.x - size.width / 2));
      const below = p.y + 10;
      const y = below + size.height <= vp.height - 8 ? below : Math.max(8, p.y - 40 - size.height);
      at = { x, y };
    }
    // The header owns the top of the view: the box and a card never slide under it.
    return inset ? { x: at.x, y: Math.max(at.y, band + 8) } : at;
  };
  useLayoutEffect(() => {
    const box = boxRef.current ?? bubbleRef.current;
    if (box && boxPoint) {
      const at = besidePin(boxPoint, { width: box.offsetWidth || BOX_WIDTH, height: box.offsetHeight || 200 });
      if (at.x !== boxAt.x || at.y !== boxAt.y) setBoxAt(at);
    }
    const card = cardRef.current;
    if (card && openPoint) {
      const at = besidePin(openPoint, { width: card.offsetWidth || 300, height: card.offsetHeight || 140 });
      if (at.x !== cardAt.x || at.y !== cardAt.y) setCardAt(at);
    }
  });

  const onLayerMove = (e: { clientX: number; clientY: number }) => {
    const p = inset ? toPage({ x: e.clientX, y: e.clientY }, inset) : { x: e.clientX, y: e.clientY };
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const el = underPoint(p, host);
      if (!el || el.tagName === 'IFRAME') { setHover(null); return; }
      const r = el.getBoundingClientRect();
      // Something the size of the page says nothing about where you are.
      if (r.width * r.height > size.width * size.height * 0.4) { setHover(null); return; }
      setHover({ x: r.left, y: r.top, width: r.width, height: r.height });
    });
  };
  useEffect(() => () => { if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current); }, []);

  // The wheel, bound by hand: React's onWheel is passive, and a wheel over
  // the layer must not reach the page underneath — the page holds still
  // while the mode is up.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); };
    layer.addEventListener('wheel', onWheel, { passive: false });
    return () => layer.removeEventListener('wheel', onWheel);
  }, []);

  // A finger: a tap is a comment, a drag does nothing.
  const onLayerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    touch.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onLayerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || e.pointerId !== t.id) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!t.moved && Math.hypot(p.x - t.start.x, p.y - t.start.y) > 8) t.moved = true;
  };
  const onLayerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || e.pointerId !== t.id) return;
    touch.current = null;
    if (!t.moved) place({ x: e.clientX, y: e.clientY });
  };

  // ── The phone's small box ───────────────────────────────────────────
  //
  // A tap on its field opens the sheet, and the field there has the keys at
  // once: the sheet is drawn inside the tap (flushSync) and focused in it,
  // since iOS raises the keyboard only for a focus made in the person's own
  // gesture.
  const expand = () => {
    if (!draft || draft.sending || performance.now() - draggedAt.current < 400) return;
    flushSync(() => setExpanded(true));
    const field = textRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  };
  /** The sheet folded back to the small box; the keys go with its field. */
  const collapse = () => {
    textRef.current?.blur();
    setExpanded(false);
  };
  /** The small box's ✕: this comment off the request, or the request when it is the only one (asked first when it has words). */
  const closeSmall = () => {
    const cur = activeComment(draft);
    if (!draft || draft.sending || !cur) return;
    if (draft.comments.length > 1) removeComment(cur.key);
    else requestDiscard();
  };
  /** A point kept on the picture (or on the screen, over the live page). */
  const onPicture = (p: Point): Point => {
    const left = inset ? inset.x : 0;
    const top = inset ? inset.y : 0;
    const right = left + size.width * (inset?.scale ?? 1);
    const bottom = top + size.height * (inset?.scale ?? 1);
    return { x: Math.max(left, Math.min(right, p.x)), y: Math.max(top, Math.min(bottom, p.y)) };
  };
  // A finger on the small box or on its pin drags the pin, and the box with
  // it; a lift that did not move is a tap, left to the click.
  const onPinDragDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!draft || draft.sending || !boxPoint || e.pointerType === 'mouse') return;
    pinDrag.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, from: boxPoint, moved: false };
  };
  const onPinDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = pinDrag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) <= 8) return;
      d.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setDragAt(onPicture({ x: d.from.x + dx, y: d.from.y + dy }));
  };
  const onPinDragUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = pinDrag.current;
    if (!d || e.pointerId !== d.id) return;
    pinDrag.current = null;
    if (!d.moved) return;
    draggedAt.current = performance.now();
    setDragAt(null);
    place(onPicture({ x: d.from.x + e.clientX - d.start.x, y: d.from.y + e.clientY - d.start.y }));
  };
  const onPinDragCancel = () => {
    pinDrag.current = null;
    setDragAt(null);
  };

  const onBoxKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };

  const postedCount = posted.length;
  const hint = draft
    ? (viewShot?.state === 'drawing' ? t('devchat:commentPin.hint.taking')
      : draft.active == null ? t('devchat:commentPin.hint.next') : t('devchat:commentPin.hint.writing'))
    : carry ? t('devchat:commentPin.hint.carry') : postedCount ? t('devchat:commentPin.hint.another') : t('devchat:commentPin.hint.start');

  const first = draft ? draft.comments[0] : null;
  const target: Target | null = draft ? (app ? (draft.chosen ?? (first?.inApp ? 'app' : 'platform')) : 'platform') : null;
  const count = draft ? pictureCount(draft) : 0;
  const live = draft ? liveComments(draft).length : 0;
  const numbered = !!draft && (draft.comments.length > 1 || draft.active == null);
  const drawing = !!draft && draft.keepShot && draft.pictures.some((p) => p.base === undefined);
  const kudosOut = budget.remaining === 0;
  const kudosLeft = budget.remaining != null && budget.limit != null
    ? t('devchat:commentPin.kudos.costRemaining', { count: budget.remaining, limit: budget.limit })
    : t('devchat:commentPin.kudos.cost');
  const shotLine = !draft ? '' : !draft.keepShot
    ? t('devchat:commentPin.shot.none')
    : drawing
      ? t('devchat:commentPin.shot.taking')
      : !usedPictures(draft).length && !draft.images.length
        ? t('devchat:commentPin.shot.failed')
        : count >= MAX_PICTURES ? t('devchat:commentPin.shot.full', { used: count, count: MAX_PICTURES })
          : numbered ? t('devchat:commentPin.shot.attachedMany') : t('devchat:commentPin.shot.attached');
  // A posted request's place, as its marker and card say it: "#12 · Posted to Run Club".
  const placeOf = (r: Posted) => (r.number
    ? t('devchat:commentPin.posted.placeNumbered', { number: r.number, place: r.to })
    : t('devchat:commentPin.posted.place', { place: r.to }));
  /** An added image's name: its file's own, else the one its place gives it. */
  const imageName = (img: Image) => img.name
    || (img.n != null ? t('devchat:commentPin.image.numbered', { number: img.n }) : t('devchat:commentPin.image.pasted'));
  const quietTool = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold text-zinc-600 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-300 dark:ring-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-white';
  // What the crop in progress would do to the picture it is on: the picture
  // itself, how many of its comments would go with the part cut away, and
  // whether that would be all of them.
  const cropView = cropping && draft ? (() => {
    const pic = draft.pictures.find((p) => p.key === cropping.picture) ?? null;
    const onPic = pic ? draft.comments.filter((c) => c.picture === pic.key) : [];
    const dropped = onPic.filter((c) => pinInCrop(c.pin, cropping.rect) === null);
    return { pic, dropped: dropped.length, keepOne: onPic.length > 0 && dropped.length === onPic.length };
  })() : null;
  // While cropping the bar rides the frame the crop happens over, the way
  // it rides the picture's inset frame otherwise.
  const barFrame = inset || cropFrame;
  // The wait-for-the-next-pin row, as the box shows it and, on a phone, as
  // the whole collapsed sheet while the wait is on.
  const nextPinRow = draft && draft.active == null ? (
    <div className="flex items-center gap-2 rounded-[10px] bg-violet-600/10 px-2 py-1.5 ring-1 ring-inset ring-violet-600/30">
      <span aria-hidden="true" className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-white text-[11px] font-extrabold text-violet-600 ring-2 ring-inset ring-violet-600 dark:bg-zinc-900`}>{draft.comments.length + 1}</span>
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-violet-700 dark:text-violet-300">{t('devchat:commentPin.next.where')}</span>
      <button
        type="button"
        onClick={() => openComment(draft.comments[draft.comments.length - 1].key)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
      >
        {t('core:common.cancel')}
      </button>
    </div>
  ) : null;

  // The box's head: where the request goes, then its controls.
  const head = draft && target ? (
    <div className={phone ? '-me-1.5 flex items-center gap-0.5' : 'flex min-h-[30px] items-center gap-1.5'}>
      {app ? (
        <div className="flex min-w-0 items-center gap-1 text-[13px]" role="radiogroup" aria-label={t('devchat:commentPin.target.groupLabel')}>
          <span className="text-zinc-500 dark:text-zinc-400">{t('devchat:commentPin.target.to')}</span>
          {([['app', app.name], ['platform', 'Homeroom']] as Array<[Target, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={target === value}
              id={`comment-pin-to-${value}`}
              disabled={draft.sending}
              onClick={() => update(draft.key, { chosen: value })}
              className={target === value
                ? 'max-w-[120px] truncate rounded-full bg-zinc-200 px-2.5 py-1 font-medium text-zinc-900 dark:bg-zinc-700 dark:text-white'
                : 'max-w-[120px] truncate rounded-full px-2.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('devchat:commentPin.target.toHomeroom')}</span>
      )}
      <span className="min-w-0 flex-1" />
      {phone ? (
        /* On a phone the sheet folds back to the small box rather than
           handing over to the form: its arrows read as "make this bigger"
           and left comment mode instead (14 Oct 2026). The bar's Form
           switch still hands over. */
        <>
          <button
            type="button"
            title={t('devchat:commentPin.box.minimize')}
            aria-label={t('devchat:commentPin.box.minimize')}
            disabled={draft.sending}
            onClick={collapse}
            className={PHONE_TOOL}
          >
            <span className={PHONE_DISC}><ChevronDownIcon className="h-[18px] w-[18px]" /></span>
          </button>
          <button
            type="button"
            title={t('devchat:commentPin.box.discardTitle')}
            aria-label={t('devchat:commentPin.box.discardLabel')}
            disabled={draft.sending}
            onClick={requestDiscard}
            className={PHONE_TOOL}
          >
            <span className={PHONE_DISC}><XIcon className="h-4 w-4" /></span>
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            title={t('devchat:commentPin.box.toForm')}
            aria-label={t('devchat:commentPin.box.toForm')}
            disabled={draft.sending}
            onClick={() => { void toForm(); }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <ArrowsPointingOutIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            title={t('devchat:commentPin.box.discardTitle')}
            aria-label={t('devchat:commentPin.box.discardLabel')}
            disabled={draft.sending}
            onClick={requestDiscard}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  ) : null;
  // The phone's small box: the open comment before the sheet.
  const small = phone && !expanded && !!draft && draft.active != null;
  const smallComment = small ? activeComment(draft) : null;
  const smallIndex = draft && smallComment ? draft.comments.indexOf(smallComment) : -1;

  return (
    <div
      className={leaving ? 'comment-mode-leaving fixed inset-0' : 'fixed inset-0'}
      style={{ zIndex: 2147483000, ['--comment-band' as string]: `${inset ? band : safeTop}px` }}
    >
      {/* Measure the status bar's height and the home indicator's (see `safeTop`). */}
      <div ref={safeRef} aria-hidden="true" className="pointer-events-none invisible absolute start-0 top-0 w-px" style={{ height: 'var(--platform-safe-top, 0px)' }} />
      <div ref={safeBottomRef} aria-hidden="true" className="pointer-events-none invisible absolute start-0 top-0 w-px" style={{ height: 'var(--platform-safe-bottom, 0px)' }} />
      {/* The layer: a press anywhere is a comment. Its mousedown is
          prevented, so the box's field keeps the keyboard through it
          (tests/keyboard-dismiss.test.js); a finger taps, and a drag does
          nothing. The wheel is stopped by hand in the effect above. */}
      <div
        id="comment-pin"
        ref={layerRef}
        aria-hidden="true"
        data-keep-keyboard=""
        className="absolute inset-0"
        style={{ cursor: CURSOR, touchAction: 'none' }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          place({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={onLayerPointerDown}
        onPointerMove={onLayerPointerMove}
        onPointerUp={onLayerPointerUp}
        onPointerCancel={() => { touch.current = null; }}
        onMouseMove={onLayerMove}
        onMouseLeave={() => setHover(null)}
      />
      {/* The page as the person sees it. Over the inset picture: a grey
          ground, the picture drawn at the inset frame with the cards'
          rounded corners, one hairline and a lift; the word that names it
          leads the bar above it, outside the picture (#4774). Clearly a
          picture, not the live page, so the blue edge goes.
          While the first picture draws there is none of that: the live page
          shows through and the layer above it keeps every press off, and the
          picture, ground and that word mount together once it lands, shrinking
          from the full page into the frame (#4665). When the picture could
          not be taken, the mode renders as it always did, over the live
          page with the blue edge (#4554). */}
      {inset && viewShot ? (
        shotIntro ? null : (
          <>
            <div className="comment-shot-ground-in pointer-events-none absolute inset-0 bg-zinc-300 dark:bg-zinc-800" aria-hidden="true" />
            {viewShot.url ? (
              <img
                src={viewShot.url}
                alt=""
                aria-hidden="true"
                draggable={false}
                className={`pointer-events-none absolute rounded-2xl bg-white ring-1 ring-black/10 shadow-[0_8px_30px_rgba(0,0,0,0.18)] dark:bg-zinc-900 dark:ring-white/10 ${viewShot.state === 'drawing' ? 'opacity-60' : ''} ${inset.scale > 0 ? 'comment-shot-in' : ''}`}
                style={{
                  left: inset.x, top: inset.y, width: size.width * inset.scale, height: size.height * inset.scale,
                  ...(inset.scale > 0 ? { ['--comment-shot-from' as string]: `translate(${-inset.x}px, ${-inset.y}px) scale(${1 / inset.scale})` } : {}),
                }}
              />
            ) : null}
          </>
        )
      ) : (
        <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_3px_#0a6ee0]" aria-hidden="true" />
      )}
      {hover && !shotIntro ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg border-[1.5px] border-dashed border-violet-600 bg-violet-600/5"
          style={(() => {
            const v = inset ? toScreen(hover, inset) : hover;
            return { left: v.x - 3, top: v.y - 3, width: hover.width * (inset?.scale ?? 1) + 6, height: hover.height * (inset?.scale ?? 1) + 6 };
          })()}
        />
      ) : null}

      {/* Posted pins sit on the inset picture (toScreen against it); until
          the first picture has landed they would sit in the wrong spot over
          the full-size live page, so they wait with the hover outline. */}
      {!shotIntro && postedPins.map((p) => {
        const at = anchorPoint(p.anchor, size);
        const request = posted.find((r) => r.key === p.request);
        if (!at || !request) return null;
        const s = inset ? toScreen(at, inset) : at;
        return (
          <button
            key={p.key}
            type="button"
            data-comment-pin-posted={p.n ?? ''}
            aria-label={listText([
              p.n ? t('devchat:commentPin.marker.numbered', { number: p.n }) : t('devchat:commentPin.marker.single'),
              placeOf(request),
            ])}
            aria-expanded={open === p.key}
            onClick={() => setOpen((o) => (o === p.key ? null : p.key))}
            className={`absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-violet-600 text-[13px] font-extrabold text-white shadow-[0_0_0_2.5px_#fff,0_3px_10px_rgba(0,0,0,0.28)] hover:bg-violet-500`}
            style={{ left: s.x, top: s.y - 30 }}
          >
            {p.n ?? <ChatIcon className="h-4 w-4" />}
          </button>
        );
      })}

      {draft ? draft.comments.map((c, i) => {
        const at = anchorPoint(c.anchor, size) ?? (c.key === draft.active ? c.anchor.at : null);
        if (!at) return null;
        const on = c.key === draft.active;
        const s = on && dragAt ? dragAt : inset ? toScreen(at, inset) : at;
        const handle = on && small;
        return (
          <button
            key={c.key}
            type="button"
            data-comment-pin-dot=""
            aria-label={listText([t('devchat:commentPin.draftPin.number', { number: i + 1 }), t('devchat:commentPin.draftPin.unposted')])}
            disabled={draft.sending}
            onClick={() => openComment(c.key)}
            onPointerDown={handle ? onPinDragDown : undefined}
            onPointerMove={handle ? onPinDragMove : undefined}
            onPointerUp={handle ? onPinDragUp : undefined}
            onPointerCancel={handle ? onPinDragCancel : undefined}
            className={(handle ? 'touch-none ' : '') + (on
              ? `absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white text-[13px] font-extrabold text-violet-600 shadow-[0_0_0_2.5px_#0a6ee0,0_3px_10px_rgba(0,0,0,0.2)] dark:bg-zinc-900`
              : `absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white/90 text-[13px] font-extrabold text-violet-600/80 shadow-[0_0_0_2px_rgba(10,110,224,0.55),0_2px_6px_rgba(0,0,0,0.15)] dark:bg-zinc-900/90`)}
            style={{ left: s.x, top: s.y - 30 }}
          >
            {numbered ? i + 1 : ''}
          </button>
        );
      }) : null}

      {draft && target && smallComment ? (
        /* On a phone, the comment before the sheet: beside its pin, a field
           that is not one yet. A tap on it opens the sheet with the keys; a
           drag on it, or on the pin, moves the pin; its ✕ closes it. */
        <div
          ref={bubbleRef}
          id="comment-pin-small"
          role="group"
          aria-label={t('devchat:commentPin.box.label')}
          className="comment-small-in absolute flex w-[300px] max-w-[calc(var(--platform-float-w)-24px)] touch-none select-none items-center gap-0.5 rounded-2xl bg-white p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
          style={{ left: boxAt.x, top: boxAt.y }}
          onPointerDown={onPinDragDown}
          onPointerMove={onPinDragMove}
          onPointerUp={onPinDragUp}
          onPointerCancel={onPinDragCancel}
        >
          <button
            type="button"
            id="comment-pin-write"
            aria-label={smallComment.text.trim() ? undefined : t('devchat:commentPin.box.write')}
            disabled={draft.sending}
            onClick={expand}
            className="flex h-11 min-w-0 flex-1 items-center rounded-xl bg-zinc-100 px-3 text-start text-[15px] dark:bg-zinc-800"
          >
            {smallComment.text.trim() ? (
              <span className="truncate text-zinc-900 dark:text-zinc-100">{smallComment.text.trim()}</span>
            ) : (
              <span className="truncate text-zinc-400 dark:text-zinc-500">
                {smallIndex > 0 ? t('devchat:commentPin.placeholderMore') : t('devchat:commentPin.placeholder')}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={draft.comments.length > 1
              ? t('devchat:commentPin.comment.removeLabel', { number: smallIndex + 1 })
              : t('devchat:commentPin.box.discardLabel')}
            disabled={draft.sending}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={closeSmall}
            className={PHONE_TOOL}
          >
            <span className={PHONE_DISC}><XIcon className="h-4 w-4" /></span>
          </button>
        </div>
      ) : draft && target ? (
        <div
          ref={boxRef}
          id="comment-pin-box"
          role="dialog"
          aria-label={t('devchat:commentPin.box.label')}
          className={phone
            ? /* On a phone the box is a bottom sheet: it slides up from the
                 foot of the screen, clear of the keyboard, instead of a card
                 beside the pin (which the sheet would cover anyway). */
              `comment-sheet comment-sheet-in platform-kb-sheet absolute inset-x-0 bottom-0 flex flex-col gap-2 overflow-y-auto overscroll-contain rounded-t-[20px] ${PLANE_FILL} p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]`
            : 'absolute flex w-[360px] max-w-[calc(var(--platform-float-w)-24px)] flex-col gap-2 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10'}
          style={phone ? undefined : { left: boxAt.x, top: boxAt.y }}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); }}
          onDrop={onDrop}
        >
          {phone ? (
            /* The sheet's head stays at its top while the rest scrolls under
               it, so its ✕ is where a sheet's ✕ is looked for and never
               scrolled away with the keys up. */
            <div className="comment-sheet-head">
              <div aria-hidden="true" className="comment-sheet-grabber" />
              {draft.active != null ? head : null}
            </div>
          ) : null}
          {phone && draft.active == null ? (
            /* Waiting for the next pin: the sheet holds just that, so most
               of the page stays in sight to tap. */
            nextPinRow
          ) : (
            <>
              {phone ? (
                <CloseUp
                  view={closeUpSrc}
                  pin={boxComment?.pin ?? { x: 0.5, y: 0.5 }}
                  crop={activePicture?.cut?.rect ?? null}
                />
              ) : head}
          <div className="flex flex-col gap-1.5" id="comment-pin-comments">
            {draft.comments.map((c, i) => (c.key === draft.active ? (
              <div key={c.key} className="flex items-start gap-2">
                {numbered ? (
                  <span aria-hidden="true" className={`mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-white text-[11px] font-extrabold text-violet-600 ring-2 ring-inset ring-violet-600 dark:bg-zinc-900`}>{i + 1}</span>
                ) : null}
                <textarea
                  ref={textRef}
                  id="comment-pin-text"
                  aria-label={numbered ? t('devchat:commentPin.textLabelNumbered', { number: i + 1 }) : t('devchat:commentPin.textLabel')}
                  rows={numbered ? 2 : 3}
                  value={c.text}
                  readOnly={draft.sending}
                  onChange={(e) => {
                    const value = e.target.value;
                    update(draft.key, (d) => ({ comments: d.comments.map((x) => (x.key === c.key ? { ...x, text: value } : x)) }));
                  }}
                  onKeyDown={onBoxKeyDown}
                  onPaste={onPaste}
                  placeholder={i ? t('devchat:commentPin.placeholderMore') : t('devchat:commentPin.placeholder')}
                  className={`block max-h-[160px] w-full min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-snug text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500 ${numbered ? 'min-h-[44px]' : 'min-h-[62px]'}`}
                />
              </div>
            ) : (
              <div key={c.key} className="flex items-center gap-2">
                <span aria-hidden="true" className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-zinc-100 text-[11px] font-extrabold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400`}>{i + 1}</span>
                <button
                  type="button"
                  title={t('devchat:commentPin.comment.change')}
                  disabled={draft.sending}
                  onClick={() => openComment(c.key)}
                  className="min-w-0 flex-1 truncate rounded-lg px-1.5 py-0.5 text-start text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
                >
                  {c.text.trim() || t('devchat:commentPin.comment.empty')}
                </button>
                <button
                  type="button"
                  aria-label={t('devchat:commentPin.comment.removeLabel', { number: i + 1 })}
                  title={t('devchat:commentPin.comment.removeTitle')}
                  disabled={draft.sending}
                  onClick={() => removeComment(c.key)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )))}
            {nextPinRow}
          </div>
          <div id="comment-pin-title" className="flex min-h-[32px] items-center gap-2 rounded-[10px] bg-zinc-100 py-1 ps-2.5 pe-1 text-[13px] dark:bg-zinc-800">
            <span className="shrink-0 font-semibold text-zinc-500 dark:text-zinc-400">{t('devchat:commentPin.title.label')}</span>
            {draft.editingTitle ? (
              <input
                aria-label={t('devchat:commentPin.title.label')}
                ref={focusWithoutPan}
                maxLength={200}
                defaultValue={draft.title}
                placeholder={t('devchat:commentPin.title.placeholder')}
                className="min-w-0 flex-1 rounded-md bg-white px-1.5 py-1 font-semibold text-zinc-900 outline-none ring-[1.5px] ring-violet-600 dark:bg-zinc-900 dark:text-white"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === 'Escape') { e.preventDefault(); update(draft.key, { editingTitle: false }); textRef.current?.focus({ preventScroll: true }); }
                }}
                onBlur={(e) => {
                  const value = e.currentTarget.value.trim();
                  // Cleared, the suggestion comes back (the dialog's rule).
                  update(draft.key, value
                    ? { editingTitle: false, title: value, titleState: 'mine' }
                    : { editingTitle: false, title: '', titleState: 'none', titleFor: '', titleAsks: 0 });
                }}
              />
            ) : titleLoading && !draft.title ? (
              <span className="min-w-0 flex-1 animate-pulse font-semibold text-zinc-400 motion-reduce:animate-none dark:text-zinc-500">{t('devchat:commentPin.title.writing')}</span>
            ) : draft.title ? (
              <>
                <button
                  type="button"
                  title={t('devchat:commentPin.title.change')}
                  disabled={draft.sending}
                  onClick={() => update(draft.key, { editingTitle: true })}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-start font-semibold text-zinc-900 hover:bg-zinc-200 dark:text-white dark:hover:bg-zinc-700"
                >
                  <span className="truncate">{draft.title}</span>
                  <DraftEditIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                </button>
                {draft.titleState === 'auto' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 pe-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <SparklesIcon className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                    {titleLoading ? t('devchat:commentPin.title.updating') : t('devchat:commentPin.title.suggested')}
                  </span>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                disabled={draft.sending}
                onClick={() => update(draft.key, { editingTitle: true })}
                className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-start text-zinc-400 hover:bg-zinc-200 dark:text-zinc-500 dark:hover:bg-zinc-700"
              >
                {words.length >= TITLE_MIN ? t('devchat:commentPin.title.namedOnPost') : t('devchat:commentPin.title.asYouType')}
              </button>
            )}
          </div>
          <div className="flex min-h-[44px] flex-wrap items-center gap-2.5">
            {usedPictures(draft).map((pic) => {
              // The preview is a crop of the picture around its pins (the
              // middle of them), and the pins sit on the crop as it is drawn:
              // a phone's tall picture in this wide box shows a third of its
              // height at most, and a pin placed as a fraction of the box
              // landed on another part of the page.
              // A cropped picture is drawn whole, the part kept framed and
              // the rest dimmed (#5020): the pins are fractions of the full
              // picture and stay put on it — one the crop cut away is already
              // gone from the request, so it is not drawn.
              const shown = pic.size || size;
              const pins = draft.comments
                .filter((c) => c.picture === pic.key && (!pic.cut || pinInCrop(c.pin, pic.cut.rect) !== null))
                .map((c) => ({ c, at: c.pin }));
              const focus = pins.length
                ? { x: pins.reduce((n, x) => n + x.at.x, 0) / pins.length, y: pins.reduce((n, x) => n + x.at.y, 0) / pins.length }
                : pic.cut
                  ? { x: pic.cut.rect.x + pic.cut.rect.width / 2, y: pic.cut.rect.y + pic.cut.rect.height / 2 }
                  : { x: 0.5, y: 0 };
              const crop = coverCrop({ width: 64, height: 42 }, shown, focus);
              return (
              <span key={pic.key} className="relative block h-[42px] w-[64px] shrink-0">
                {pic.thumb ? (
                  <span className="block h-[42px] w-[64px] overflow-hidden rounded-lg ring-1 ring-black/10 dark:ring-white/10">
                    <img
                      src={pic.thumb}
                      alt=""
                      className="relative block max-w-none"
                      style={{ left: crop.x, top: crop.y, width: crop.width, height: crop.height }}
                    />
                    {pic.cut ? (
                      /* What was cropped away stays in sight, dimmed, the
                         kept part framed in white. */
                      <span
                        aria-hidden="true"
                        className="absolute border border-white"
                        style={{
                          left: crop.x + pic.cut.rect.x * crop.width,
                          top: crop.y + pic.cut.rect.y * crop.height,
                          width: pic.cut.rect.width * crop.width,
                          height: pic.cut.rect.height * crop.height,
                          boxShadow: CROP_SHADE,
                        }}
                      />
                    ) : null}
                  </span>
                ) : (
                  <span className="block h-[42px] w-[64px] animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800" />
                )}
                {/* The pins over the preview: data beside the picture, as they are posted.
                    Only those inside it: two pins far apart on a phone's tall
                    picture do not both fit the preview's slice, and the one
                    outside was drawn over the Title and Kudos rows. */}
                {pins.map(({ c, at }) => ({ c, left: crop.x + at.x * crop.width, top: crop.y + at.y * crop.height }))
                  .filter(({ left, top }) => left >= 0 && left <= 64 && top >= 0 && top <= 42)
                  .map(({ c, left, top }) => (
                    <span
                      key={c.key}
                      aria-hidden="true"
                      className={`absolute h-[10px] w-[10px] -translate-y-full ${PIN_SHAPE} bg-violet-600 shadow-[0_0_0_1.5px_#fff]`}
                      style={{ left, top }}
                    />
                  ))}
                {pic.base ? (
                  <>
                    <button
                      type="button"
                      aria-label={t('devchat:commentPin.shot.removeLabel')}
                      title={t('devchat:commentPin.shot.remove')}
                      disabled={draft.sending}
                      onClick={() => update(draft.key, { keepShot: false })}
                      className="absolute -end-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('devchat:commentPin.shot.cropLabel')}
                      title={t('devchat:commentPin.shot.crop')}
                      disabled={draft.sending}
                      onClick={() => setCropping({ picture: pic.key, rect: pic.cut?.rect ?? FULL_CROP })}
                      className="absolute -bottom-2 -end-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                    >
                      <ArrowsPointingInIcon className="h-3 w-3" />
                    </button>
                  </>
                ) : null}
              </span>
              );
            })}
            {draft.images.map((img) => (
              <span key={img.url} className="relative block h-[42px] w-[64px] shrink-0">
                <img src={img.url} alt={imageName(img)} className="h-[42px] w-[64px] rounded-lg object-cover ring-1 ring-black/10 dark:ring-white/10" />
                <button
                  type="button"
                  aria-label={img.name
                    ? t('devchat:commentPin.image.remove', { name: img.name })
                    : img.n != null
                      ? t('devchat:commentPin.image.removeNumbered', { number: img.n })
                      : t('devchat:commentPin.image.removePasted')}
                  title={t('devchat:commentPin.image.removeTitle')}
                  disabled={draft.sending}
                  onClick={() => removeImage(draft.key, img.url)}
                  className="absolute -end-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
            <span id="comment-pin-shot" className="min-w-[90px] flex-1 text-xs leading-tight text-zinc-500 dark:text-zinc-400">
              {shotLine}
              {!draft.keepShot ? (
                <button
                  type="button"
                  disabled={draft.sending || draft.images.length >= MAX_PICTURES}
                  onClick={() => update(draft.key, { keepShot: true })}
                  className="ms-1 font-semibold text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300"
                >
                  {t('devchat:commentPin.shot.addBack')}
                </button>
              ) : null}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => { addImages(Array.from(e.target.files || [])); e.target.value = ''; }}
            />
          </div>
          {/* Kudos (#964): one line, a switch. What it costs is said on hover
              and to a screen reader; the line itself says what it is for.
              Not drawn while kudos is parked (#5249, ../leaderboard/kudos-parked.ts). */}
          {KUDOS_PARKED ? null : <button
            type="button"
            id="comment-pin-kudos"
            role="switch"
            aria-checked={draft.kudos}
            aria-describedby="comment-pin-kudos-cost"
            title={kudosOut ? undefined : kudosLeft}
            disabled={draft.sending || kudosOut}
            onClick={() => update(draft.key, (d) => ({ kudos: !d.kudos }))}
            className={draft.kudos
              ? 'flex h-9 w-full items-center gap-2 rounded-[10px] bg-violet-600/10 px-2.5 text-start ring-1 ring-inset ring-violet-600/30'
              : 'flex h-9 w-full items-center gap-2 rounded-[10px] bg-zinc-100 px-2.5 text-start hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-800 dark:hover:bg-zinc-700'}
          >
            <span aria-hidden="true" className="text-base leading-none">{'\u{1F44F}'}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">{t('devchat:commentPin.kudos.label')}</span>
            <span id="comment-pin-kudos-cost" className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {kudosOut ? t('devchat:commentPin.kudos.noneLeft') : budget.remaining != null ? t('devchat:commentPin.kudos.left', { count: budget.remaining }) : ''}
              <span className="sr-only">{kudosOut ? '' : t('devchat:commentPin.kudos.costAfterCount', { cost: kudosLeft })}</span>
            </span>
            <span
              aria-hidden="true"
              className={draft.kudos
                ? 'relative h-5 w-[34px] shrink-0 rounded-full bg-violet-600'
                : 'relative h-5 w-[34px] shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600'}
            >
              <span className={draft.kudos
                ? 'absolute start-[17px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow'
                : 'absolute start-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow'}
              />
            </span>
          </button>}
          {draft.error ? (
            <p id="comment-pin-error" role="alert" className="text-[13px] text-red-700 dark:text-red-400">{draft.error}</p>
          ) : null}
          <div className={`flex items-center gap-1.5 border-t border-black/5 pt-2 dark:border-white/10${phone ? ' comment-sheet-actions' : ''}`}>
            <button
              type="button"
              title={t('devchat:commentPin.box.attachTitle')}
              aria-label={t('devchat:commentPin.box.attachLabel')}
              disabled={draft.sending || count >= MAX_PICTURES}
              onClick={() => fileRef.current?.click()}
              className={`${quietTool} w-8 justify-center px-0`}
            >
              <PaperclipIcon className="h-4 w-4" />
            </button>
            {draft.comments.length < MAX_COMMENTS ? (
              <button
                type="button"
                title={t('devchat:commentPin.box.addCommentTitle')}
                disabled={draft.sending || draft.active == null || !activeComment(draft)?.text.trim()}
                onClick={addComment}
                className={quietTool}
              >
                <PlusIcon className="h-4 w-4" />
                {t('devchat:commentPin.box.addComment')}
              </button>
            ) : null}
            <span className="min-w-0 flex-1" />
            <Button
              type="button"
              id="comment-pin-send"
              variant="pillAccent"
              size="sm"
              ink="solid"
              disabledStyle="block"
              className="whitespace-nowrap"
              disabled={draft.sending || !live}
              onClick={() => { void send(); }}
            >
              {draft.sending ? t('devchat:commentPin.posting') : live > 1 ? t('devchat:commentPin.postMany', { count: live }) : t('devchat:commentPin.post')}
            </Button>
          </div>
            </>
          )}
        </div>
      ) : null}

      {openPin && openRequest && openPoint ? (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={placeOf(openRequest)}
          className="absolute flex w-[300px] max-w-[calc(var(--platform-float-w)-24px)] flex-col gap-1.5 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
          style={{ left: cardAt.x, top: cardAt.y }}
        >
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-violet-600 text-[11px] font-extrabold text-white`} aria-hidden="true">{openPin.n ?? ''}</span>
            <span className="min-w-0 flex-1 truncate">{placeOf(openRequest)}</span>
            <button
              type="button"
              aria-label={t('core:common.close')}
              onClick={() => setOpen(null)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {openRequest.title ? <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-white">{openRequest.title}</p> : null}
          <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-zinc-600 dark:text-zinc-300">{openRequest.words}</p>
          <div className="mt-1 flex items-center gap-2 border-t border-black/5 pt-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <span className="min-w-0 flex-1 truncate">
              {[
                openRequest.comments > 1 ? t('devchat:commentPin.card.comments', { count: openRequest.comments }) : '',
                openRequest.pictures ? t('devchat:commentPin.card.images', { count: openRequest.pictures }) : '',
                openRequest.kudos ? t('devchat:commentPin.card.kudos') : '',
              ].filter(Boolean).reduce((first, second) => (first ? t('devchat:commentPin.card.facts', { first, second }) : second), '')}
            </span>
            {openRequest.href ? (
              <a
                href={openRequest.href}
                onClick={() => onClose()}
                className="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-500"
              >
                {t('devchat:commentPin.card.open')}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The first-use note (#4541): how comment mode works, shown once per
          device, above the bar's starting place. It takes no focus, and
          closes on "Got it", the first pin, or a drag of the bar. */}
      {intro && !confirm && !shotIntro ? (
        <div
          role="dialog"
          aria-label={t('devchat:commentPin.intro.title')}
          className={[
            'absolute left-1/2 flex w-[340px] max-w-[calc(var(--platform-float-w)-24px)] -translate-x-1/2 flex-col gap-2 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10',
          ].join(' ')}
          style={inset ? { top: band + 8 } : { bottom: 'calc(76px + var(--platform-safe-bottom, 0px))' }}
        >
          <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-white">{t('devchat:commentPin.intro.title')}</p>
          <ul className="flex flex-col gap-1 text-[13px] text-zinc-600 dark:text-zinc-300">
            <li>{t('devchat:commentPin.intro.tap')}</li>
            {!inset ? <li>{t('devchat:commentPin.intro.drag')}</li> : null}
            <li>{t('devchat:commentPin.intro.form')}</li>
          </ul>
          <div className="flex justify-end">
            <Button variant="pillAccent" size="sm" ink="solid" onClick={() => setIntro(false)}>{t('devchat:commentPin.intro.gotIt')}</Button>
          </div>
        </div>
      ) : null}

      {/* The sent card (#5008): where the comment just went, where the bar's
          own chip never shows (a phone) and the toast has gone in a moment.
          Dressed like the posted marker's card. It stands down when the next
          comment has words, when it is closed, or when another is posted. */}
      {sentRequest && !shotIntro && !cropping && !hasWords(draft) ? (
        <div
          role="status"
          aria-live="polite"
          aria-label={t('devchat:commentPin.sent.label')}
          data-comment-pin-sent=""
          className="absolute left-1/2 flex w-[340px] max-w-[calc(var(--platform-float-w)-24px)] -translate-x-1/2 flex-col gap-1.5 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
          style={inset ? { top: band + 8 } : { bottom: 'calc(76px + var(--platform-safe-bottom, 0px))' }}
        >
          <div className="flex items-center gap-2">
            <span className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-violet-600 text-white`} aria-hidden="true"><CheckIcon className="h-3.5 w-3.5" /></span>
            <span className="min-w-0 flex-1 truncate text-[15px] font-[650] text-zinc-900 dark:text-white">{placeOf(sentRequest)}</span>
            <button
              type="button"
              aria-label={t('core:common.close')}
              onClick={() => setSent(null)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {sentRequest.title ? <p className="text-[13px] text-zinc-600 dark:text-zinc-300">{sentRequest.title}</p> : null}
          <div className="mt-1 flex items-center gap-2 border-t border-black/5 pt-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <span className="min-w-0 flex-1 truncate">{t('devchat:commentPin.hint.another')}</span>
            {sentRequest.href ? (
              <a
                href={sentRequest.href}
                onClick={() => onClose()}
                className="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-500"
              >
                {t('devchat:commentPin.card.open')}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Cropping a picture: the frame over it, while the box, the pins and
          the cards stand down. The bar above it becomes the crop's. */}
      {cropping && draft && cropView?.pic && cropFrame ? (
        <CropFrame
          pic={cropView.pic}
          rect={cropping.rect}
          onRect={(r) => setCropping((c) => (c ? { ...c, rect: r } : c))}
          frame={cropFrame}
          page={size}
          phone={phone}
          draft={draft}
          numbered={numbered}
        />
      ) : null}

      {/* Over the picture the bar is the view's header: same width as the
          picture, in the band above it, nothing floating over the page and
          no handle to drag it by. Over the live page it is the floating bar
          it always was. */}
      <div
        ref={barRef}
        tabIndex={-1}
        role="toolbar"
        aria-label={t('devchat:commentPin.bar.label')}
        className={[
          'absolute flex max-w-[calc(var(--platform-float-w)-24px)] items-center gap-2 whitespace-nowrap rounded-full bg-white py-1.5 ps-1.5 pe-1.5 outline-none ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10 sm:gap-2.5',
          barFrame
            ? 'rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.18)]'
            : 'shadow-[0_8px_30px_rgba(0,0,0,0.22)]',
          !barFrame && !barPlace ? 'left-1/2 -translate-x-1/2' : '',
          // Not over the live page while the first picture draws: drawn there
          // it covered the page's own header for a few frames, then the
          // picture shrank in under it. It fades in with the picture.
          shotIntro ? 'pointer-events-none opacity-0' : 'comment-bar-in',
        ].filter(Boolean).join(' ')}
        style={barFrame
          ? {
            left: barFrame.x,
            top: safeTop + Math.max(6, Math.round((HEADER_BAND - barSize.height) / 2)),
            width: size.width * barFrame.scale,
          }
          : barPlace ? { left: barPlace.left, top: barPlace.top } : { bottom: 'calc(1rem + var(--platform-safe-bottom, 0px))' }}
      >
        {/* The live-page fallback's handle: the crop bar has none, so the
            grip stands down while the person crops. */}
        {!inset ? (
          <button
            type="button"
            aria-label={t('devchat:commentPin.bar.move')}
            title={t('devchat:commentPin.bar.moveTitle')}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onDoubleClick={() => { setBarAt(null); }}
            className={`grid h-8 w-6 shrink-0 cursor-move touch-none place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300${cropping ? ' hidden' : ''}`}
          >
            <ArrowsMoveIcon className="h-4 w-4" />
          </button>
        ) : null}
        {shotLabel ? (
          <>
            {/* Names the picture below the bar for as long as the picture
                shows, the bar's question included on a computer. It gives
                way first: it truncates before the controls do. On a phone
                the switch drops its two glyphs while it shows, so the whole
                word fits 390px, and the word steps aside while the bar asks
                its question, which otherwise read "Discard t…". */}
            <span
              aria-hidden="true"
              className={`comment-shot-label-in min-w-0 truncate ps-1.5 text-[13px] font-semibold text-zinc-500 dark:text-zinc-400${confirm ? ' hidden sm:inline' : ''}`}
            >
              {t('devchat:commentPin.view.chip')}
            </span>
            <span aria-hidden="true" className="comment-shot-label-in hidden h-4 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700 sm:block" />
          </>
        ) : null}
        {cropping && cropView ? (
          <>
            <span className="hidden min-w-0 truncate text-[13px] font-semibold text-zinc-900 sm:inline dark:text-white">
              {t('devchat:commentPin.crop.title')}
            </span>
            {cropView.keepOne ? (
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-violet-700 dark:text-violet-300">
                {t('devchat:commentPin.crop.keepOne')}
              </span>
            ) : cropView.dropped ? (
              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                {t('devchat:commentPin.crop.dropping', { count: cropView.dropped })}
              </span>
            ) : null}
            {barFrame ? <span className="min-w-0 flex-1" /> : null}
            <button
              type="button"
              onClick={() => setCropping(null)}
              className="h-[34px] shrink-0 rounded-full px-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 dark:text-white dark:hover:bg-zinc-800"
            >
              {t('core:common.cancel')}
            </button>
            <button
              type="button"
              disabled={isFullCrop(cropping.rect)}
              onClick={() => setCropping((c) => (c ? { ...c, rect: FULL_CROP } : c))}
              className={quietTool}
            >
              <ArrowPathIcon className="h-4 w-4" />
              {t('devchat:commentPin.crop.reset')}
            </button>
            <button
              type="button"
              disabled={cropView.keepOne}
              onClick={applyCrop}
              className="inline-flex h-[34px] shrink-0 items-center rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
            >
              {t('devchat:commentPin.crop.apply')}
            </button>
          </>
        ) : confirm ? (
          <>
            <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">
              {confirm === 'discard' ? t('devchat:commentPin.bar.confirmDiscard') : t('devchat:commentPin.bar.confirmExit')}
            </span>
            {inset ? <span className="min-w-0 flex-1" /> : null}
            <button
              type="button"
              onClick={() => { setConfirm(null); textRef.current?.focus({ preventScroll: true }); }}
              className="h-[34px] shrink-0 rounded-full px-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 dark:text-white dark:hover:bg-zinc-800"
            >
              {t('devchat:commentPin.bar.keepWriting')}
            </button>
            <button
              type="button"
              onClick={() => { if (confirm === 'discard') discard(); else leave(); }}
              className="h-[34px] shrink-0 rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
            >
              {t('devchat:commentPin.bar.discard')}
            </button>
          </>
        ) : (
          <>
            <span className={`${shotLabel ? 'hidden sm:inline-flex' : 'inline-flex'} shrink-0 items-center gap-1.5 text-sm font-bold text-violet-700 dark:text-violet-300`}>
              <ChatIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="hidden min-w-0 truncate text-sm font-bold text-violet-700 sm:inline dark:text-violet-300">{hint}</span>
            {postedCount ? (
              <span className="hidden shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600 md:inline dark:bg-zinc-800 dark:text-zinc-300">
                {t('devchat:commentPin.bar.posted', { count: postedCount })}
              </span>
            ) : null}
            {inset ? <span className="min-w-0 flex-1" /> : null}
            <span className="inline-flex shrink-0 gap-0.5 rounded-full bg-zinc-100 p-[3px] dark:bg-zinc-800" role="radiogroup" aria-label={t('devchat:commentPin.bar.switchLabel')}>
              <button
                type="button"
                role="radio"
                aria-checked="false"
                title={t('devchat:commentPin.bar.formTitle')}
                onClick={() => { void toForm(); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full ps-2 pe-2.5 text-[13px] font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                <DescriptionIcon className={`${shotLabel ? 'hidden sm:block' : ''} h-4 w-4`} />
                {t('devchat:commentPin.bar.form')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="true"
                title={t('devchat:commentPin.bar.commentTitle')}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white ps-2 pe-2.5 text-[13px] font-semibold text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-700 dark:text-white"
              >
                <ChatIcon className={`${shotLabel ? 'hidden sm:block' : ''} h-4 w-4`} />
                {t('devchat:commentPin.bar.comment')}
              </button>
            </span>
            <button
              type="button"
              onClick={requestExit}
              className="inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900 sm:pe-3"
            >
              {t('devchat:commentPin.bar.done')}
              <kbd className="hidden rounded-[5px] px-1 font-mono text-[11px] font-semibold opacity-70 ring-1 ring-inset ring-current sm:inline">{t('devchat:commentPin.bar.doneKey')}</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── The picture drawn ahead ─────────────────────────────────────────
//
// Between a tap on "Suggest an improvement" and the picture shrinking in,
// the page used to stand still for 0.3s, and 1.3s on the first open after
// the app launched (iPhone 17 simulator, production, 12 Oct 2026): the
// menu slid away, then the mode loaded its code and the drawing library,
// copied the page, fetched and inlined its images, drew it and encoded it,
// and only then could anything move. None of that can be animated before
// it is done, since the picture does not exist yet. But the page it draws
// sits still under the Homeroom menu, or under the form, for as long as
// either is open, and both are cut out of the picture anyway. So the menu
// and the form call `prepareCommentView` as they open, the picture is drawn
// then, and the mode puts it up the moment the sheet has gone.
//
// It is used only if nothing on the page has changed since it was drawn:
// any added or removed node or changed text outside the flow's own
// overlays, any scroll of the page, or a new width throws it away, and the
// mode draws a fresh one as before. It keeps for AHEAD_TTL_MS.

/** How long a picture drawn ahead stays usable (ms). */
const AHEAD_TTL_MS = 20000;
/** How long after the sheet opens the drawing starts, so its own slide-in runs undisturbed (ms). */
const AHEAD_SETTLE_MS = 350;

interface Ahead {
  size: Size;
  result: Promise<{ url: string; size: Size } | null>;
  dirty: boolean;
  /** Every text node changed since the drawing started, with what it said first. */
  texts: Map<Node, string | null>;
  stop: () => void;
}

/** Whether the picture still shows the page: no node change counted, and every changed text says what it said. */
function stillFresh(a: Ahead): boolean {
  return !a.dirty && textsUnchanged(a.texts);
}
let ahead: Ahead | null = null;

function dropAhead(): void {
  const a = ahead;
  if (!a) return;
  ahead = null;
  a.stop();
  void a.result.then((r) => { if (r) URL.revokeObjectURL(r.url); });
}

/**
 * Fetch the drawing library now, so the first picture of this session does
 * not wait for it (../improve/suggest-shortcut.ts `warmComment`, a few
 * seconds after the page loads unless this device has turned it off). This
 * module's own code is loaded by the import that calls it. Nothing is drawn.
 */
export function warmCommentMode(): void {
  loadLibrary().catch(() => { /* fetched again when a picture is drawn */ });
}

/**
 * Draw the page now, for the next comment mode to open on. A no-op while the
 * mode is open or a usable picture is already waiting.
 */
export function prepareCommentView(): void {
  if (openHost || typeof document === 'undefined' || !document.body) return;
  if (ahead && stillFresh(ahead)) return;
  dropAhead();
  const size = windowSize();
  const entry: Ahead = { size, result: Promise.resolve(null), dirty: false, texts: new Map(), stop: () => {} };
  const spoil = () => { if (!entry.dirty) { entry.dirty = true; entry.stop(); } };
  // Watched from the moment the drawing starts: what changed before it is
  // in the picture already.
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        if (!outOfPicture(r.target) && !entry.texts.has(r.target)) entry.texts.set(r.target, r.oldValue);
      } else if (changesPicture(r)) {
        spoil();
        return;
      }
    }
  });
  const onScroll = (e: Event) => { if (!outOfPicture(e.target instanceof Node ? e.target : null)) spoil(); };
  const onResize = () => { if (window.innerWidth !== size.width) spoil(); };
  const expiry = setTimeout(() => { if (ahead === entry) dropAhead(); }, AHEAD_TTL_MS);
  let watching = false;
  entry.stop = () => {
    clearTimeout(expiry);
    if (!watching) return;
    watching = false;
    observer.disconnect();
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };
  entry.result = new Promise<{ url: string; size: Size } | null>((resolve) => {
    setTimeout(() => {
      if (entry.dirty || ahead !== entry || window.innerWidth !== size.width) { resolve(null); return; }
      watching = true;
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      const shown = visibleFrame();
      takeBase({
        host: document.createElement('div'),
        scale: pictureScale(window.devicePixelRatio, size),
        frame: shown?.frame ?? null,
        frameRect: shown?.rect ?? null,
        pin: { x: size.width / 2, y: size.height / 2 },
        viewport: size,
      }).then((b) => {
        if (!b || !stillFresh(entry)) { resolve(null); return; }
        b.canvas.toBlob((blob) => {
          if (!blob || !stillFresh(entry)) { resolve(null); return; }
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.src = url;
          const done = () => resolve({ url, size });
          (typeof img.decode === 'function' ? img.decode() : Promise.resolve()).then(done, done);
        }, 'image/png');
      }, () => resolve(null));
    }, AHEAD_SETTLE_MS);
  });
  ahead = entry;
}

/**
 * The picture drawn ahead, for the mode opening now: its promise, or null
 * when there is none, the page has changed since, or it was drawn at
 * another width. Taken once; the mode owns its URL from here.
 */
function takeAhead(size: Size): Promise<{ url: string; size: Size } | null> | null {
  const a = ahead;
  if (!a) return null;
  ahead = null;
  a.stop();
  if (!stillFresh(a) || a.size.width !== size.width) {
    void a.result.then((r) => { if (r) URL.revokeObjectURL(r.url); });
    return null;
  }
  // Still drawing: the result is waited for. The page may change meanwhile;
  // it was still when the drawing started, which is what the picture shows.
  return a.result;
}

let openHost: HTMLElement | null = null;
let controller: { exit: () => void } | null = null;

export function commentModeOpen(): boolean {
  return !!openHost;
}

/** Leave comment mode at once, whatever the box holds. */
export function closeCommentMode(): void {
  const host = openHost;
  if (!host) return;
  unmountLegacyPortal(host);
  host.remove();
  openHost = null;
  controller = null;
}

/** Turn comment mode on. A second call while it is on does nothing. */
export function openCommentMode(opts: OpenOptions = {}): void {
  if (openHost || typeof document === 'undefined') return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  openHost = host;
  const session: Session = { host, app: appTarget(), carry: opts.carry ?? null };
  const close = () => { if (openHost === host) closeCommentMode(); };
  mountLegacyPortal(host, createElement(CommentMode, { session, onClose: close }));
}

/** C: on when it is off; when it is on, Done (which asks first about unposted words). */
export function toggleCommentMode(opts: OpenOptions = {}): void {
  if (openHost) {
    if (controller) controller.exit();
    else closeCommentMode();
    return;
  }
  openCommentMode(opts);
}
