/**
 * The C key turns comment mode on and off (#4289 and its follow-ups).
 * On by default, and kept per device (a keyboard shortcut is a property of
 * the keyboard in front of you; ./suggest-settings.ts). What it opens is
 * ../comment-pin/: a layer where every click leaves a comment, each posted
 * as its own request with a screenshot of the page and its pin beside it.
 *
 * ── The other way in ────────────────────────────────────────────────────
 *
 * "Suggest an improvement" opens comment mode on a computer, and the form is
 * one switch away (Form, on comment mode's bar or in its box). On a phone it
 * opens the form, and comment mode is the switch (#5762): the mode shows the
 * page as a smaller picture of itself with its bar at the top, which on a
 * phone read as the screen shrinking, the text box jammed at the top. The
 * form's own Comment switch opens comment mode with the form's draft. Both reach this module through
 * `openCommentMode` (the form's island imports it; feedback-controller.js,
 * which cannot import, through window.UsernodeReact.suggestShortcut).
 *
 * ── Only a C nobody else used ─────────────────────────────────────────
 *
 * A bare C, on a computer, with nothing selected. It does nothing while the
 * person is typing (an input, a textarea, a select, an editable element, read
 * off the event's real target so a shadow root counts), has text selected,
 * holds a modifier or is composing with an input method, or while a dialog,
 * sheet or menu is up. And it does nothing when a screen has already used the
 * key: the Workshop's feed answers C with an item's comments, and says so the
 * standard way, by calling `preventDefault`. The decision waits one task
 * after the key, so every handler on the page has run by then, wherever and
 * whenever it was registered.
 *
 * ── From inside an app or a preview ─────────────────────────────────────
 *
 * While a person works in an app, its document has the keyboard and the shell
 * never sees the key. The bridge every app and preview loads watches for the
 * same unused C in there and tells the shell (`__usernode_shortcut`, the
 * __USERNODE_SHORTCUTS_ block of public/usernode-bridge/v1/bridge.js). The
 * shell takes that message only from the running app's own frame or the
 * change preview's frame (`#staging-iframe`), and only while that frame holds
 * focus: a frame without focus cannot have had a key pressed in it, so a
 * message from one is not a person pressing C.
 *
 * ── Where the pointer is ────────────────────────────────────────────────
 *
 * Over the shell, this module watches the pointer itself; over the app's
 * frame the shell sees no pointer events at all, so the bridge sends its own
 * last position with the C (x, y in the frame's viewport), placed by the
 * frame's rectangle. Comment mode takes its pins from clicks, so the point
 * is not used for one; it is still passed along, for the day it is.
 *
 * C turns the mode off again (asking first about words nobody has posted),
 * by the same rules: not while typing in its box.
 *
 * The comment's code is loaded on the first C, not with the shell. If it
 * cannot load, C opens what the "Suggest an improvement" button opens
 * (`Improve.giveFeedback`) instead.
 *
 * The side panel (`?panel=1`) is the platform framed beside an app; its own
 * copy of this module stands down there.
 */

import { PHONE_QUERY } from '../../lib/keyboard-open';
import { EMBEDDED_PANEL_CLASS } from '../../lib/side-panel-mode';
import type { OpenOptions } from '../comment-pin/comment-pin';
import {
  defaultStorage, setSuggestShortcutEnabled, suggestShortcutEnabled, type StorageLike,
} from './suggest-settings';

export { SUGGEST_SHORTCUT_STORAGE_KEY, setSuggestShortcutEnabled, suggestShortcutEnabled } from './suggest-settings';

/** The bridge's message from inside an app; its one value is `'suggest'`. */
export const SHORTCUT_MESSAGE_KEY = '__usernode_shortcut';

interface KeyLike {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/**
 * A C with no Ctrl, Cmd or Alt, not held down, not mid-composition. `key`,
 * not `code`, so it is the letter C on whatever layout the keyboard has;
 * Shift and Caps Lock give `'C'`, which counts.
 */
export function isBareC(e: KeyLike | null | undefined): boolean {
  if (!e || (e.key !== 'c' && e.key !== 'C')) return false;
  return !(e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing);
}

interface NodeLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const TEXT_ROLES = '[role="textbox"], [role="searchbox"], [role="combobox"]';

/** Whether a key pressed with this node as its target is somebody typing. */
export function isTypingTarget(node: unknown): boolean {
  const el = node as NodeLike | null | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  try {
    return typeof el.closest === 'function' && !!el.closest(TEXT_ROLES);
  } catch {
    return false;
  }
}

interface SelectionHost {
  getSelection?: () => { isCollapsed?: boolean; toString(): string } | null;
}

/** Whether the person has text selected. A caret is not a selection. */
export function hasTextSelection(win: SelectionHost | null | undefined): boolean {
  try {
    const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
    return !!sel && !sel.isCollapsed && String(sel) !== '';
  } catch {
    return false;
  }
}

interface ShortcutEvent extends KeyLike {
  defaultPrevented?: boolean;
  target?: unknown;
  composedPath?: () => unknown[];
}

/** The key's real target: inside a shadow root, the node itself, not its host. */
function realTarget(e: ShortcutEvent): unknown {
  try {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.length) return path[0];
  } catch { /* fall back to the retargeted target */ }
  return e.target;
}

interface ElementLike {
  closest?: (selector: string) => unknown;
  checkVisibility?: (options?: Record<string, boolean>) => boolean;
  getClientRects?: () => { length: number };
}

export interface DocLike {
  activeElement?: unknown;
  documentElement?: { classList?: { contains(name: string): boolean } } | null;
  getElementById(id: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

export interface Point { x: number; y: number }

function finitePoint(x: unknown, y: unknown): Point | null {
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y } : null;
}

interface WinLike extends SelectionHost {
  addEventListener(type: string, fn: (event: any) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  matchMedia?: (query: string) => { matches: boolean };
}

export interface SuggestShortcutDeps {
  win: WinLike;
  doc: DocLike;
  storage?: StorageLike | null;
  /** Turn comment mode on, or off (a viewport point, null when nobody has pointed). */
  open: (point: Point | null) => void;
  /** Whether somebody is signed in: a visitor has no dialog to open. */
  signedIn: () => boolean;
}

/**
 * Whether a dialog is really in front of the person. The shell ships most of
 * them `hidden`, but not all: the header's sheets (the app switcher, the
 * notifications sheet) stay laid out while closed, `inert`, invisible and
 * see-through, so they can animate in. Laid out is therefore not enough.
 */
function onScreen(el: ElementLike | null): boolean {
  if (!el) return false;
  try {
    if (typeof el.closest === 'function' && el.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  } catch {
    return false;
  }
}

/**
 * Anything presenting itself as a dialog: the kit's modals and sheets
 * (`aria-modal`), and the shell's own dialogs and menus (`role="dialog"`).
 * ⌘K reads it too (../workshop/community-shortcut.ts).
 */
export function dialogShowing(doc: DocLike): boolean {
  let nodes: ArrayLike<unknown>;
  try {
    nodes = doc.querySelectorAll('[aria-modal="true"], [role="dialog"]');
  } catch {
    return false;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (onScreen(nodes[i] as ElementLike | null)) return true;
  }
  return false;
}

/**
 * Listen for the shortcut: the shell's own keys, and the bridge's message
 * from inside the running app. Returns nothing; there is one per document.
 */
export function installSuggestShortcut(deps: SuggestShortcutDeps): void {
  const { win, doc, open, signedIn } = deps;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  // The pointer over the shell's own page, passively.
  let pointer: Point | null = null;
  const notePointer = (e: { clientX?: number; clientY?: number }) => {
    const p = finitePoint(e?.clientX, e?.clientY);
    if (p) pointer = p;
  };
  win.addEventListener('pointermove', notePointer);
  win.addEventListener('pointerdown', notePointer);

  // What has to hold for a C, from wherever, to open the comment.
  const ready = (): boolean => {
    if (!suggestShortcutEnabled(storage)) return false;
    try {
      if (doc.documentElement?.classList?.contains(EMBEDDED_PANEL_CLASS)) return false;
    } catch { /* no root to ask: not the panel */ }
    // On a computer: a fine pointer is there. A phone or a tablet with only a
    // finger has no use for a letter key that opens a dialog.
    try {
      if (!win.matchMedia || !win.matchMedia('(any-pointer: fine)').matches) return false;
    } catch {
      return false;
    }
    if (!signedIn()) return false;
    return !dialogShowing(doc);
  };

  win.addEventListener('keydown', (e: ShortcutEvent) => {
    if (!isBareC(e)) return;
    if (isTypingTarget(realTarget(e)) || isTypingTarget(doc.activeElement)) return;
    if (hasTextSelection(win)) return;
    if (!ready()) return;
    const at = pointer;
    // A task later, every listener on the page has had the key; one that
    // used it said so with preventDefault. `ready()` runs again too, so a
    // screen that answered C by opening something of its own (without
    // claiming the key) is not covered by a second dialog.
    win.setTimeout(() => {
      if (e.defaultPrevented) return;
      if (!ready()) return;
      open(at);
    }, 0);
  });

  win.addEventListener('message', (e: { data?: unknown; source?: unknown }) => {
    const data = (e ? e.data : null) as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== 'object' || data[SHORTCUT_MESSAGE_KEY] !== 'suggest') return;
    // The app's frame and the change preview's frame both carry the bridge.
    // The message counts only from the one that is on screen, checked
    // staging first: it sits over the app, so when both are up it is the
    // one showing.
    const frames = [
      doc.getElementById('staging-iframe'),
      doc.getElementById('app-iframe'),
    ] as Array<{
      contentWindow?: unknown;
      getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
    } | null>;
    const frame = frames.find((f) => f && e.source && f.contentWindow === e.source) || null;
    if (!frame) return;
    if (doc.activeElement !== frame) return;
    if (!ready()) return;
    open(framePoint(frame, finitePoint(data.x, data.y)));
  });
}

/**
 * A point in the app frame's viewport, as a point in the shell's: offset by
 * the frame's rectangle and kept inside it. No point: the frame's middle.
 */
export function framePoint(
  frame: { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } },
  inFrame: Point | null,
): Point | null {
  let r: { left: number; top: number; width: number; height: number };
  try {
    if (typeof frame.getBoundingClientRect !== 'function') return null;
    r = frame.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const p = inFrame ?? { x: r.width / 2, y: r.height / 2 };
  return {
    x: r.left + Math.max(0, Math.min(r.width - 1, p.x)),
    y: r.top + Math.max(0, Math.min(r.height - 1, p.y)),
  };
}

/** C: comment mode on, or off; what the "Suggest an improvement" button opens, if it cannot load. */
function toggleComment(_point: Point | null): void {
  import('../comment-pin/comment-pin')
    .then((m) => m.toggleCommentMode({ via: 'key' }))
    .catch(() => openSuggest());
}

/** How long after the page has loaded comment mode's code and library are fetched (ms). */
export const WARM_DELAY_MS = 3000;
let warmed = false;

/**
 * Whether this document is a `?shot=` / `?demo=` capture route. Those render
 * ONE state deterministically for a declared check or a before/after shot,
 * and comment mode's chunk, its 250 KB library or a picture being drawn in
 * the background is exactly the nondeterminism they exist to be free of: the
 * `?shot=app-context` check, whose menu now prepares comment mode because the
 * mode is the default, sat in network idle past 29 s while the picture of the
 * page fetched its images. Same guard, for the same reason, as
 * `AdminConsole.prefetchSections` and `prefetchSettings`. Nothing is lost: an
 * open still loads the mode, which is what a real open does anyway.
 */
export function onCaptureRoute(
  win: { location?: { search?: string } } | null = typeof window !== 'undefined' ? window : null,
): boolean {
  try {
    const q = new URLSearchParams(win?.location?.search || '');
    return !!(q.get('shot') || q.get('demo'));
  } catch {
    return false;
  }
}

/**
 * Comment mode's code and its drawing library, fetched ahead of time unless
 * this device has turned it off: a few seconds after the page loads, and
 * when it is turned back on. Without it the first picture of a session
 * waited on both downloads (about 250 KB for the library), and a quick tap
 * on "Suggest an improvement" right after the app opened sat on a still
 * screen for over a second (iPhone 17 simulator, production, 12 Oct 2026).
 * Once per page; nothing is drawn, nothing at all where the device has
 * turned it off, and nothing on a capture route.
 */
export function warmComment(): void {
  if (warmed || !suggestOpensComment() || onCaptureRoute()) return;
  warmed = true;
  import('../comment-pin/comment-pin')
    .then((m) => m.warmCommentMode())
    .catch(() => { warmed = false; });
}

/** Run `warmComment` once the page has loaded and settled, out of the way of the first paint. */
export function scheduleWarmComment(win: Pick<Window, 'setTimeout' | 'addEventListener'> & { document?: { readyState?: string } }): void {
  const later = () => { win.setTimeout(() => warmComment(), WARM_DELAY_MS); };
  if (win.document?.readyState === 'complete') later();
  else win.addEventListener('load', later, { once: true });
}

/**
 * The Homeroom menu, the hub's ⋯ menu or the form has opened, and comment
 * mode is one tap away: load its code and draw the page now, while it sits
 * still under the sheet, so the mode opens on it at once (comment-pin.tsx
 * `prepareCommentView`). Nothing at all where the device has turned it off,
 * on a phone (the form opens there), and on a capture route (`onCaptureRoute`).
 */
export function prepareComment(): void {
  if (!suggestOpensComment() || onCaptureRoute()) return;
  import('../comment-pin/comment-pin')
    .then((m) => m.prepareCommentView())
    .catch(() => { /* the mode loads when it opens, as before */ });
}

/**
 * Comment mode, from "Suggest an improvement" or the form's switch, with the
 * form's draft when there is one. The form itself if the mode cannot load.
 */
export function openCommentMode(opts: OpenOptions = {}): void {
  import('../comment-pin/comment-pin')
    .then((m) => m.openCommentMode(opts))
    .catch(() => {
      (window as unknown as { App?: { openFeedbackModal?: (o?: unknown) => void } }).App?.openFeedbackModal?.({ mode: 'form' });
    });
}

type MediaHost = {
  document?: { documentElement?: { classList?: { contains(name: string): boolean } } | null };
  matchMedia?: (query: string) => { matches: boolean };
};

/**
 * Where comment mode can be: anywhere but the side panel (`?panel=1`), which
 * is the platform framed beside an app and would cover only itself. A phone
 * can: a tap is a comment there.
 */
function commentable(win: MediaHost | null): boolean {
  try {
    return !!win && !win.document?.documentElement?.classList?.contains(EMBEDDED_PANEL_CLASS);
  } catch {
    return false;
  }
}

/** Whether this screen is a phone: the test comment mode itself lays out by. */
function onPhone(win: MediaHost | null): boolean {
  try {
    return !!win?.matchMedia?.(PHONE_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Whether "Suggest an improvement" opens comment mode: this device has not
 * turned it off, it can be here, and this is not a phone, where the form
 * opens first and comment mode is its switch (#5762).
 */
export function suggestOpensComment(
  win: MediaHost | null = typeof window !== 'undefined' ? window : null,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  return suggestShortcutEnabled(storage) && commentable(win) && !onPhone(win);
}

/** Whether the form offers the switch to comment mode: the same. */
export function formOffersComment(
  win: MediaHost | null = typeof window !== 'undefined' ? window : null,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  return suggestShortcutEnabled(storage) && commentable(win);
}

/** What the "Suggest an improvement" button does. */
function openSuggest(): void {
  const w = window as unknown as {
    Improve?: { giveFeedback?: () => void };
    App?: { openFeedbackModal?: (opts?: unknown) => void };
  };
  if (typeof w.Improve?.giveFeedback === 'function') {
    w.Improve.giveFeedback();
    return;
  }
  w.App?.openFeedbackModal?.();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installSuggestShortcut({
    win: window as unknown as WinLike,
    doc: document as unknown as DocLike,
    open: toggleComment,
    signedIn: () => !!(window as unknown as { App?: { user?: unknown } }).App?.user,
  });
  // The feedback dialog's controller asks where "Suggest an improvement"
  // goes, and its C key's `ready()` check reads the setting; that code is
  // classic there and cannot import. `prepare` is for the hub's ⋯ menu
  // (public/js/app-view.js `_wirePlusMenu`), which gets the picture ready
  // while it is open, as the Homeroom menu does for its own row.
  const bridge = ((window as unknown as { UsernodeReact?: Record<string, unknown> }).UsernodeReact ||= {});
  scheduleWarmComment(window);
  bridge.suggestShortcut = {
    enabled: () => suggestShortcutEnabled(),
    setEnabled: (on: boolean) => {
      setSuggestShortcutEnabled(!!on);
      if (on) warmComment();
    },
    opensComment: () => suggestOpensComment(),
    openComment: (opts?: OpenOptions) => openCommentMode(opts || {}),
    prepare: () => prepareComment(),
  };
}
