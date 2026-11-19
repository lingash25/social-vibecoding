/**
 * The rail's peek, shared by every element that can summon it.
 *
 * Moved out of ./tab-bar.tsx when #sidebar-toggle became a second way in
 * (#2764): with the rail folded, pointing at the toggle fades the rail in over
 * the page exactly as pointing at the window's left edge does. The toggle sits
 * in the header's left corner, directly above where the rail appears, so it
 * is where the pointer already is when the reader goes looking for the
 * navigation they folded away.
 *
 * ── Why the grace timer is module state ───────────────────────────────
 *
 * The pointer has to cross a gap to get from whatever summoned the rail onto
 * the rail itself, and on the way back out it crosses the same gap. Un-peeking
 * the moment either element is left makes the rail flicker away under a
 * pointer that is on its way to it, so leaving starts a short delay that
 * entering ANY peek target cancels. With two components involved that
 * delay has to be ONE timer: the toggle's leave and the rail's enter are
 * different components, and a per-component timer would let the toggle's fire
 * after the pointer was already on the rail.
 */
import { navStore } from './nav-store.js';

export const PEEK_GRACE_MS = 280;

/**
 * How long the peeked rail takes to fade away once the grace period is up
 * (#2795). It used to snap: the grace timer set `peek: false` and the rail
 * went straight to `display: none`, so a rail that FADED IN vanished in one
 * frame on the way out. Now the grace timer starts the fade (`peekOut`, which
 * app.css turns into an opacity transition) and a second timer, this long,
 * takes the rail away once the fade has finished.
 *
 * The SAME timer slot holds both stages, so a pointer that comes back onto
 * the rail at any point — during the grace period or halfway through the
 * fade — cancels whichever is pending and brings the rail straight back.
 */
export const PEEK_FADE_MS = 200;

let timer: ReturnType<typeof setTimeout> | null = null;

export function clearPeekTimer(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** The pointer is on something that shows the rail: show it now. */
export function enterPeek(): void {
  clearPeekTimer();
  // Standard (WIP): a folded sidebar stays folded until its arrow is pressed
  // (asked 19 Nov 2026). Pointing at the edge or at the arrow peeks nothing.
  if (typeof document !== 'undefined' && document.documentElement?.hasAttribute('data-skin-wip')) return;
  const { peek, peekOut } = navStore.get();
  if (!peek || peekOut) navStore.set({ peek: true, peekOut: false });
}

/** The pointer left one: fade the rail away unless it arrives at another. */
export function leavePeek(): void {
  clearPeekTimer();
  timer = setTimeout(() => {
    navStore.set({ peekOut: true });
    timer = setTimeout(() => {
      timer = null;
      navStore.set({ peek: false, peekOut: false });
    }, PEEK_FADE_MS);
  }, PEEK_GRACE_MS);
}

/**
 * ── Only a real mouse peeks ───────────────────────────────────────────
 *
 * A phone has no pointer to hover with, but iOS WebKit still fires the
 * compatibility mouse events (`mouseenter`, `mouseleave`) around every tap.
 * Bound to those, every tap on the phone's bar entered a peek and the next
 * tap somewhere else left it, so the grace and fade timers above ran in the
 * middle of taps, and each store update they made re-rendered the bar while
 * WebKit was still deciding whether to deliver the click. Taps that needed
 * two or three tries were reported on exactly that bar (first-session test,
 * #27).
 *
 * Pointer events say which device moved, so every peek target listens to
 * `pointerenter` / `pointerleave` through this filter and answers only
 * `pointerType === 'mouse'` (a trackpad reports as one). A finger or a pen
 * does nothing here, and its compatibility mouse events have no listener.
 */
export function mouseOnly(handler: () => void): (event: { pointerType?: string }) => void {
  return (event) => {
    if (event.pointerType === 'mouse') handler();
  };
}

export const enterPeekByMouse = mouseOnly(enterPeek);
export const leavePeekByMouse = mouseOnly(leavePeek);
export const clearPeekTimerByMouse = mouseOnly(clearPeekTimer);
