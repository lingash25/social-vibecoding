/**
 * #4417: THE TRAY, the places list on a phone.
 *
 * Opened from the place bar's button (./place-bar.tsx), or by a swipe right
 * that starts at the screen's left edge; a swipe left on it, Escape, the
 * scrim, the button again and the device's Back each close it. It slides in
 * from the left over a scrim, under the header (#5384: the header stays as
 * it is, undimmed and pressable), as wide as the list needs (296px, never
 * more than the screen less a strip of the page), and holds the list
 * (./project-places.tsx) with "Switch community" at its foot.
 *
 * Like the community switcher it is rendered while open — and while it
 * slides back out — into `document.body`, from state that only ever changes
 * after the first paint: nothing here is in the prerendered shell, and
 * nothing legacy writes into it. Focus moves into it (onto the place you are
 * on) and back to the button that opened it.
 *
 * WHERE THE BROWSER OWNS THE EDGE. Safari on an iPhone (the browser, not an
 * installed app or the native shell) takes a swipe from the left edge for
 * its own Back, so the edge is left to it there and the button is the way
 * in (`edgeSwipeAllowed`).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { pushDismissible, type Release } from '../../../lib/back-stack';
import { dirSign } from '../../../lib/i18n/direction';

/** How far from the inline-start edge a swipe must start to open the tray. */
export const EDGE_PX = 24;
/** How far it must travel, mostly sideways, to count. */
export const SWIPE_PX = 48;

/** Whether a swipe that started at `x0,y0` and ended at `x1,y1` is the edge's: inward, from the edge, mostly flat (from the right edge in Arabic, `width` being the screen's). Pure. */
export function isEdgeSwipe(x0: number, y0: number, x1: number, y1: number, rtl = false, width = 0): boolean {
  const dx = rtl ? x0 - x1 : x1 - x0;
  const dy = Math.abs(y1 - y0);
  return (rtl ? x0 >= width - EDGE_PX : x0 <= EDGE_PX) && dx >= SWIPE_PX && dy < dx * 0.6;
}

/** Whether a swipe from `x0,y0` to `x1,y1` closes the tray: back toward its edge, mostly flat. Pure. */
export function isCloseSwipe(x0: number, y0: number, x1: number, y1: number, rtl = false): boolean {
  const dx = rtl ? x1 - x0 : x0 - x1;
  const dy = Math.abs(y1 - y0);
  return dx >= SWIPE_PX && dy < dx * 0.6;
}

/**
 * Whether the page may take the left edge. Not in Safari on an iPhone or
 * iPad in the browser, where the edge is the browser's Back; an installed
 * app (standalone) and the native shell have no such gesture. Pure, given
 * what it reads.
 */
export function edgeSwipeAllowed(env: { ua: string; maxTouchPoints: number; standalone: boolean; native: boolean }): boolean {
  const ios = /iPhone|iPad|iPod/i.test(env.ua) || (/Macintosh/i.test(env.ua) && env.maxTouchPoints > 1);
  if (!ios) return true;
  return env.standalone || env.native;
}

function readEnv() {
  let standalone = false;
  try {
    standalone = !!window.matchMedia?.('(display-mode: standalone)').matches
      || (window.navigator as { standalone?: boolean }).standalone === true;
  } catch { standalone = false; }
  const bridge = (window as { usernode?: { isNative?: boolean } }).usernode;
  return {
    ua: String(window.navigator?.userAgent || ''),
    maxTouchPoints: Number(window.navigator?.maxTouchPoints) || 0,
    standalone,
    native: !!(bridge && bridge.isNative === true),
  };
}

/** Whether the page may take the left edge here (`edgeSwipeAllowed`, of this browser). */
export function pageTakesEdge(): boolean {
  if (typeof window === 'undefined') return false;
  return edgeSwipeAllowed(readEnv());
}

/**
 * Open the tray on a swipe right from the left edge, while `enabled` (a
 * phone's width, the page up, the tray shut). Listens on the document,
 * passively: it never holds a scroll up.
 */
export function useEdgeSwipe(enabled: boolean, onOpen: () => void): void {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    if (!edgeSwipeAllowed(readEnv())) return undefined;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      const rtl = dirSign() === -1;
      const atEdge = t && (rtl ? t.clientX >= window.innerWidth - EDGE_PX : t.clientX <= EDGE_PX);
      start = t && e.touches.length === 1 && atEdge ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && isEdgeSwipe(start.x, start.y, t.clientX, t.clientY, dirSign() === -1, window.innerWidth)) openRef.current();
      start = null;
    };
    const cancel = () => { start = null; };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', cancel);
    };
  }, [enabled]);
}

export function PlacesTray({ id, label, onClose, closing, onClosed, returnTo, navigating, children }: {
  id: string;
  /** What the tray is, for a screen reader: "Homeroom's places". */
  label: string;
  onClose: () => void;
  /** Whether it is sliding back out, the open played in reverse. */
  closing?: boolean;
  /** Called when the slide is over (or skipped) and the tray may go. */
  onClosed?: () => void;
  /** The button that opened it, which takes focus back. */
  returnTo: () => HTMLElement | null;
  /**
   * Whether it is closing because a place was pressed, which pushes an
   * entry of its own in the same task. Its Back claim is then handed back
   * as a navigating one, so the queued Back that spends it cannot undo the
   * press (lib/back-stack.ts, as useDialog's closeForNavigation).
   */
  navigating?: () => boolean;
  children: ReactNode;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const closingRef = useRef(!!closing);
  closingRef.current = !!closing;
  const returnRef = useRef(returnTo);
  returnRef.current = returnTo;
  const navRef = useRef(navigating);
  navRef.current = navigating;

  // Focus in, onto the place you are on, and back out to the button. While
  // it slides out the focus went back already, in the close's own commit.
  useEffect(() => {
    if (closing) return undefined;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[aria-current="page"]')
      || panel?.querySelector<HTMLElement>('a[href], button');
    first?.focus({ preventScroll: true });
    return () => {
      const back = returnRef.current();
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [closing]);

  // Escape closes; Tab stays inside while it is up.
  useEffect(() => {
    if (closing) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closing]);

  // The device's Back closes it, as it does a dialog (lib/back-stack.ts).
  useEffect(() => {
    if (closing) return undefined;
    let release: Release | null = pushDismissible(() => {
      release = null;
      closeRef.current();
      return true;
    });
    return () => {
      const r = release;
      release = null;
      r?.(navRef.current?.() ? { navigating: true } : undefined);
    };
  }, [closing]);

  // The slide's end: the card's animationend, or a fallback timer a little
  // past it, so a missed event never leaves the tray on screen. Reduced
  // motion skips the slide, as the open does, and closes at once.
  useEffect(() => {
    if (!closing) return undefined;
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      closedRef.current?.();
      return undefined;
    }
    const timer = window.setTimeout(() => closedRef.current?.(), 320);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // A swipe left on the tray closes it.
  const start = useRef<{ x: number; y: number } | null>(null);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={closing ? 'dev-ws-tray-root is-closing' : 'dev-ws-tray-root'}
      data-places-tray=""
      inert={!!closing}
      aria-hidden={closing || undefined}
    >
      <div className="dev-ws-tray-scrim" aria-hidden="true" onClick={() => closeRef.current()} />
      <div
        ref={panelRef}
        id={id}
        className="dev-ws-tray"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget || e.animationName !== 'dev-ws-tray-out') return;
          if (!closingRef.current) return;
          closedRef.current?.();
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          start.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const t = e.changedTouches[0];
          const s = start.current;
          start.current = null;
          if (s && t && isCloseSwipe(s.x, s.y, t.clientX, t.clientY, dirSign() === -1)) closeRef.current();
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
