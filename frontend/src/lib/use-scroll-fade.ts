/**
 * A sideways-scrolling strip that SAYS it scrolls (QA 2026-09-24 Q21).
 *
 * The Leaderboard's section strip scrolls sideways on a narrow phone rather
 * than wrapping, with its scrollbar hidden. At 360px that cut "History" to
 * "Histo" at the track's edge with nothing to say there was more: a clipped
 * word, not a control. This fades whichever edge has content beyond it, so
 * the cut reads as "keeps going", and brings the selected trigger into view
 * when the selection changes, so a deep link to the last tab is not opened
 * with its own tab off-screen.
 *
 * STATE IN AN EFFECT, NEVER IN THE FIRST RENDER. The first render returns no
 * style at all, which is exactly what the prerender emitted, so hydration
 * matches; the measurement lands after mount and on every scroll and resize.
 * A strip that fits never gets a mask.
 *
 * `selectedKey` is anything that changes when the selected trigger (or the
 * set of triggers) does; the trigger is found by `aria-current="page"`, the
 * attribute the Tabs primitive puts on it.
 */

import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

/** How wide the fade is, in CSS pixels. */
export const SCROLL_FADE_PX = 20;

interface Edges { start: boolean; end: boolean }

export function scrollFadeStyle(edges: Edges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const stops = [
    edges.start ? `transparent 0, #000 ${SCROLL_FADE_PX}px` : '#000 0',
    edges.end ? `#000 calc(100% - ${SCROLL_FADE_PX}px), transparent 100%` : '#000 100%',
  ].join(', ');
  const mask = `linear-gradient(to right, ${stops})`;
  return { WebkitMaskImage: mask, maskImage: mask };
}

export function useScrollFade(
  ref: RefObject<HTMLElement | null>,
  selectedKey?: string,
): CSSProperties | undefined {
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      // scrollLeft runs negative from the start in a right-to-left scroller.
      const at = Math.abs(el.scrollLeft);
      const start = max > 1 && at > 1;
      const end = max > 1 && at < max - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [ref, selectedKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const strip = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    // Scroll the strip itself, never the page: scrollIntoView would move the
    // screen's own scroller too.
    if (tab.left < strip.left + SCROLL_FADE_PX) {
      el.scrollLeft -= strip.left + SCROLL_FADE_PX - tab.left;
    } else if (tab.right > strip.right - SCROLL_FADE_PX) {
      el.scrollLeft += tab.right - (strip.right - SCROLL_FADE_PX);
    }
  }, [ref, selectedKey]);

  return scrollFadeStyle(edges);
}
