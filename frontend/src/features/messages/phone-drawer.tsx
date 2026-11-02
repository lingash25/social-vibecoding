/**
 * THE MESSAGES SCREEN AS A DRAWER, ON A PHONE (Evan's design, 18 Oct 2026;
 * ../nav-drawer/messages-drawer.ts says what it is and when it applies).
 *
 * The screen's own two panes become the drawer's levels, moved by transform
 * on a phone only: the list (`.messages-list-pane`) at 85% of the screen,
 * the conversation (`.messages-thread-pane`) beside it at 85%. On the list
 * the last conversation you had open peeks in at the right, drawn from what
 * it showed when you left it (`ConversationPeek`, ./index.tsx), and a press
 * on it opens it; with none yet the list takes the whole screen. The pan
 * follows a finger: a sideways drag on the list, and in a conversation a
 * swipe right from anywhere that is not sideways UI, or from the left edge
 * (EDGE_PX) except in Safari on an iPhone, where that edge is the browser's
 * own Back: the Communities drawer's rule (../nav-drawer/sideways.ts). Let go
 * past a quarter of the way and it opens the conversation or the list,
 * through `open()` like a row or the arrow does: the levels are addresses,
 * and the panes slide on from wherever the finger left them.
 *
 * An agent chat and an agent session are the second level too, named in the
 * header by the screen (`agentWords`); the list shows nothing peeking after
 * one, since it has no picture of an agent's pane to show.
 *
 * Nothing changes at 768px and up, nor on a phone for a dev session, a
 * channel or a reply thread: the drawer does not hold those routes, and the
 * panes keep the classes and the layout they had.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { pageTakesEdge } from '../dev-board/workshop/places-tray';
import {
  afterSlideStarts, depthIn, EDGE_PX, isPan, landingIn, MESSAGES_AT, PAN_SLOP_PX, SLIDE_EASE, SLIDE_MS,
} from '../nav-drawer/drawer-math';
import { reducedMotion } from '../nav-drawer/drawer-store';
import {
  messagesDepth, messagesDrawerApplies, publishMessagesDrawer, registerMessagesBack,
} from '../nav-drawer/messages-drawer';
import { startsOnSideways, swipeBackMayStart } from '../nav-drawer/sideways';
import { open as openConversation } from './store';
import type { ConversationDetail, ConversationMessage } from './types';
import { stripWidth } from '../../lib/side-strip';
import { dirSign } from '../../lib/i18n/direction';

const PHONE_QUERY = '(max-width: 767.98px)';

/** What the list shows peeking: the last conversation, as it was left. */
export interface Peek {
  conversation: ConversationDetail;
  messages: ConversationMessage[];
}

/** How many of its last messages the peek keeps. */
export const PEEK_MESSAGES = 30;

/** What the drawer needs to know from the screen's snapshot. */
export interface DrawerRoute {
  open: boolean;
  conversationId: number | null;
  appSlug: string | null;
  agent: unknown;
  threadRootId: number | null;
  embedded?: boolean;
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return phone;
}

export interface MessagesDrawer {
  on: boolean;
  level: 0 | 1;
  peek: Peek | null;
  /** The pan's handlers, for the layout. */
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => void;
  } | null;
}

export function useMessagesDrawer(
  layoutRef: RefObject<HTMLDivElement | null>,
  route: DrawerRoute,
  active: ConversationDetail | null,
  messages: ConversationMessage[],
  names: (conversation: ConversationDetail) => { title: string; sub: string },
  /** The header's words for the open agent chat or agent session, if one is open. */
  agentWords: { title: string; sub: string } | null = null,
): MessagesDrawer {
  const phone = usePhone();
  const on = messagesDrawerApplies({
    phone,
    open: route.open,
    conversationId: route.conversationId,
    appSlug: route.appSlug,
    agent: route.agent,
    threadRootId: route.threadRootId,
    embedded: route.embedded,
    activeKind: active && active.id === route.conversationId ? active.kind : null,
    bot: !!(active && active.id === route.conversationId && active.homeroomBot),
  });
  const level: 0 | 1 = route.conversationId || route.agent ? 1 : 0;
  const agentOpen = on && level === 1 && !!route.agent;
  // The conversation on show, kept for the list to show peeking once you go
  // back to it: a conversation with people, as the server last drew it.
  const [peek, setPeek] = useState<Peek | null>(null);
  const showing = on && level === 1 && !!active && active.id === route.conversationId && active.kind !== 'channel'
    ? active : null;
  useEffect(() => {
    if (!showing) return;
    setPeek((was) => {
      const kept = messages.slice(-PEEK_MESSAGES);
      if (was && was.conversation === showing && was.messages.length === kept.length
        && was.messages[was.messages.length - 1] === kept[kept.length - 1]) return was;
      return { conversation: showing, messages: kept };
    });
  }, [showing, messages]);
  // After an agent, nothing peeks: the last thing open is not one it can draw.
  useEffect(() => {
    if (agentOpen) setPeek(null);
  }, [agentOpen]);
  const peekShown = on && level === 0 ? peek : null;

  // The header's words: the conversation on show, or the one peeking, which
  // a pan brings in.
  const named = showing || peek?.conversation || null;
  const words = agentOpen ? (agentWords || { title: '', sub: '' }) : named ? names(named) : { title: '', sub: '' };
  useIsomorphicLayoutEffect(() => {
    publishMessagesDrawer({ on, level, title: words.title, sub: words.sub });
  }, [on, level, words.title, words.sub]);
  useEffect(() => () => publishMessagesDrawer({ on: false, level: 0, title: '', sub: '' }), []);
  useEffect(() => (on ? registerMessagesBack(() => openConversation(null)) : undefined), [on]);

  // ── Putting the panes somewhere ──
  // Their transform only. The conversation's pane is also the kit's keyboard
  // column (`platform-kb-column`), and the kit owns that node's inline
  // `transition` (it sets it to none so its own ride is the only motion), so
  // a slide is an animation of the transform, never a transition.
  const panes = () => {
    const layout = layoutRef.current;
    return {
      layout,
      list: layout?.querySelector<HTMLElement>(':scope > .messages-list-pane') || null,
      thread: layout?.querySelector<HTMLElement>(':scope > .messages-thread-pane') || null,
    };
  };
  // Where the panes were last put: a pan leaves them part of the way, and the
  // pane the route swaps in (the peek and the conversation are two, and the
  // list's empty pane is not drawn) starts from there.
  const lastOffset = useRef<number>(MESSAGES_AT[level]);
  // The slide each pane is on: its node, the animation, and where it runs
  // from and to. By PANE, not by node: a release starts the slide before the
  // route that lands it swaps the conversation's pane for the peek's
  // (`landAt`), and the new node carries on the slide the old one was on.
  type Slide = { el: HTMLElement; anim: Animation; start: string; end: string; t0: number };
  const slides = useRef(new Map<'list' | 'thread', Slide>());
  const at = (pane: 'list' | 'thread', offset: number, w: number) =>
    `translate3d(${(pane === 'list' ? -offset : MESSAGES_AT[1] - offset) * w * dirSign()}px, 0, 0)`;
  const run = (pane: 'list' | 'thread', el: HTMLElement, start: string, end: string, t0: number, elapsed = 0) => {
    const anim = el.animate([{ transform: start }, { transform: end }], { duration: SLIDE_MS, easing: SLIDE_EASE });
    if (elapsed > 0) anim.currentTime = Math.min(SLIDE_MS, elapsed);
    const slide: Slide = { el, anim, start, end, t0 };
    slides.current.set(pane, slide);
    const done = () => { if (slides.current.get(pane) === slide) slides.current.delete(pane); };
    anim.onfinish = done;
    anim.oncancel = done;
  };
  const put = (offset: number, animate: boolean) => {
    const { layout, list, thread } = panes();
    const w = Math.max(1, (layout?.clientWidth || 1) - stripWidth());
    const from = lastOffset.current;
    lastOffset.current = offset;
    for (const [pane, el] of [['list', list], ['thread', thread]] as const) {
      if (!el) continue;
      const running = slides.current.get(pane);
      const end = at(pane, offset, w);
      if (animate && running && running.end === end) {
        // Already on its way there: the route confirming a release's slide.
        if (running.el === el) continue;
        // A node the route swapped in mid-slide joins the slide where it is.
        const elapsed = typeof running.anim.currentTime === 'number'
          ? running.anim.currentTime : performance.now() - running.t0;
        running.anim.cancel();
        el.style.transform = end;
        if (!reducedMotion() && typeof el.animate === 'function') run(pane, el, running.start, end, running.t0, elapsed);
        continue;
      }
      // From where it is on screen: mid-slide, where the slide has it.
      const own = running && running.el === el ? running : null;
      const shown = own ? getComputedStyle(el).transform : 'none';
      const start = own && shown !== 'none' ? shown : at(pane, from, w);
      running?.anim.cancel();
      el.style.transform = end;
      if (!animate || reducedMotion() || typeof el.animate !== 'function' || start === end) continue;
      run(pane, el, start, end, performance.now());
    }
  };
  const clear = () => {
    for (const slide of [...slides.current.values()]) slide.anim.cancel();
    const { list, thread } = panes();
    for (const el of [list, thread]) {
      if (el) el.style.transform = '';
    }
  };
  // A release's level, from the moment it set the panes sliding until the
  // route lands on it (`landAt`).
  const landing = useRef<null | 0 | 1>(null);
  // Where the route says, sliding there from where it was; at once the
  // first time.
  const placed = useRef<null | 0 | 1>(null);
  const peekId = peekShown?.conversation.id ?? null;
  useIsomorphicLayoutEffect(() => {
    if (!on) {
      placed.current = null;
      clear();
      messagesDepth.cut(0);
      return;
    }
    const first = placed.current === null;
    if (!first && landing.current === level) {
      // The release started this slide already, and the header's with it.
      landing.current = null;
      put(MESSAGES_AT[level], true);
      placed.current = level;
      return;
    }
    landing.current = null;
    put(MESSAGES_AT[level], !first);
    if (first) messagesDepth.cut(level);
    else messagesDepth.slide(level);
    placed.current = level;
  }, [on, level, peekId]);
  // Again whenever the layout's width changes. Not only a window's resize:
  // a route that lands straight on a conversation or an agent (a link, a
  // reload, `#agent/new`) is placed before the screen is shown, at no width,
  // and the list stayed in view behind the pane.
  useEffect(() => {
    if (!on) return undefined;
    let width = layoutRef.current?.clientWidth || 0;
    const again = () => {
      const now = layoutRef.current?.clientWidth || 0;
      if (now === width) return;
      width = now;
      if (!pan.current?.on && !fingerOn.current) put(MESSAGES_AT[placed.current ?? level], false);
    };
    window.addEventListener('resize', again);
    const layout = layoutRef.current;
    const watch = layout && typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    if (layout) watch?.observe(layout);
    return () => {
      window.removeEventListener('resize', again);
      watch?.disconnect();
    };
  }, [on, level]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Letting go: the level a pan lands on, and its address ──
  // Short of a quarter, back where it was; past it, the other address, and
  // the slide runs on from where the finger left the panes as it lands.
  //
  // THE SLIDE FIRST, THE ROUTE AFTER (polish board #16, 19 Oct 2026). The
  // address used to change on release and the slide to start from the
  // route's render: on an iPhone the panes stood still for 85ms under the
  // lifted finger, and 163ms under a 6x CPU throttle in Chrome, then jumped
  // on. Now the panes and the header start sliding in the release's own
  // task, and the address changes once the slide is running
  // (afterSlideStarts), in a task of its own so its render runs between
  // frames rather than inside one; the route's placement then finds them
  // already on their way (`put`, `landing`).
  const landAt = (from: 0 | 1, offset: number, dx: number) => {
    const to = landingIn(MESSAGES_AT, from, offset, dx) as 0 | 1;
    put(MESSAGES_AT[to], true);
    messagesDepth.slide(to);
    if (to === from) return;
    landing.current = to;
    const id = to === 1 ? peekId : null;
    afterSlideStarts(() => { window.setTimeout(() => openConversation(id), 0); });
  };

  // ── A mouse on the list ──
  // A finger is the touch handlers' (below): a pointer is cancelled the
  // moment the browser starts scrolling the list under it, so a drag had to
  // be exactly sideways to pan at all.
  const pan = useRef<null | { id: number; x0: number; y0: number; w: number; on: boolean; dx: number }>(null);
  const swallow = useRef(false);
  const fingerOn = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !on || level !== 0 || !peekId || !e.isPrimary || e.button !== 0) return;
    pan.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, w: Math.max(1, (layoutRef.current?.clientWidth || 1) - stripWidth()), on: false, dx: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || e.pointerId !== p.id) return;
    // In reading direction: the panes run the other way in Arabic.
    const dx = (e.clientX - p.x0) * dirSign();
    const dy = e.clientY - p.y0;
    if (!p.on) {
      if (!isPan(dx, dy)) {
        if (Math.abs(dy) > PAN_SLOP_PX * 2) pan.current = null;
        return;
      }
      p.on = true;
      try { layoutRef.current?.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
      if (layoutRef.current) layoutRef.current.style.userSelect = 'none';
    }
    p.dx = dx;
    const offset = Math.max(0, Math.min(MESSAGES_AT[1], -dx / p.w));
    put(offset, false);
    messagesDepth.set(depthIn(MESSAGES_AT, offset));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    pan.current = null;
    if (!p || e.pointerId !== p.id || !p.on) return;
    if (layoutRef.current) layoutRef.current.style.userSelect = '';
    swallow.current = true;
    window.setTimeout(() => { swallow.current = false; }, 0);
    landAt(0, Math.max(0, Math.min(MESSAGES_AT[1], -p.dx / p.w)), p.dx);
  };

  // ── A finger ──
  // From touch events, which keep coming while the browser scrolls the list
  // or the conversation under the same finger, so a swipe a little off level
  // still pans, as a community's page does. On the list a sideways drag
  // anywhere brings the peek in; in a conversation a swipe right goes back,
  // from anywhere but sideways UI or from the left edge where that is the
  // page's (../nav-drawer/sideways.ts).
  const landRef = useRef(landAt);
  landRef.current = landAt;
  const putRef = useRef(put);
  putRef.current = put;
  useEffect(() => {
    if (!on || (level === 0 && !peekId)) return undefined;
    const from = level;
    const takesEdge = pageTakesEdge();
    let p: null | { x0: number; y0: number; w: number; on: boolean; dx: number } = null;
    const offsetOf = (dx: number, w: number) => Math.max(0, Math.min(MESSAGES_AT[1], MESSAGES_AT[from] - dx / w));
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!p || !touch) return;
      // In reading direction, as the Communities drawer's pan reads it: `dx > 0`
      // is the swipe back, whichever way the screen runs.
      const dx = (touch.clientX - p.x0) * dirSign();
      const dy = touch.clientY - p.y0;
      if (!p.on) {
        if (isPan(dx, dy) && (from === 0 || dx > 0)) {
          // Its moves may not be cancelable, and the pan follows them all the
          // same, as the Communities drawer's does (../nav-drawer/nav-drawer.tsx
          // says why): in the iPhone app they were uncancelable over plain
          // messages, and standing down on them left the swipe dead there.
          p.on = true;
          fingerOn.current = true;
        } else if (Math.abs(dy) > PAN_SLOP_PX || (from === 1 && dx < -PAN_SLOP_PX)) { stop(); return; } else return;
      }
      if (e.cancelable) e.preventDefault();
      p.dx = dx;
      const offset = offsetOf(dx, p.w);
      putRef.current(offset, false);
      messagesDepth.set(depthIn(MESSAGES_AT, offset));
    };
    const stop = () => {
      p = null;
      document.removeEventListener('touchmove', move);
    };
    const down = (e: TouchEvent) => {
      stop();
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch) return;
      const target = e.target as Element | null;
      const layout = layoutRef.current;
      if (!target || !layout || !layout.contains(target)) return;
      if (from === 1) {
        const rtl = dirSign() === -1;
        const pastEdge = rtl ? touch.clientX < window.innerWidth - EDGE_PX : touch.clientX > EDGE_PX;
        const sideways = pastEdge && startsOnSideways(target, layout, window);
        if (!swipeBackMayStart({ x: touch.clientX, takesEdge, sideways, rtl, width: window.innerWidth })) return;
      } else if (startsOnSideways(target, layout, window)) {
        // The list: anywhere on it but a field (the search).
        return;
      }
      p = { x0: touch.clientX, y0: touch.clientY, w: Math.max(1, (layout.clientWidth || 1) - stripWidth()), on: false, dx: 0 };
      document.addEventListener('touchmove', move, { passive: false });
    };
    const up = () => {
      const was = p;
      stop();
      fingerOn.current = false;
      if (!was || !was.on) return;
      // A row the finger started on is not pressed by the pan.
      swallow.current = true;
      window.setTimeout(() => { swallow.current = false; }, 0);
      landRef.current(from, offsetOf(was.dx, was.w), was.dx);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      stop();
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
  }, [on, level, peekId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    on,
    level,
    peek: peekShown,
    handlers: on ? {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture: (e) => {
        if (!swallow.current) return;
        swallow.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    } : null,
  };
}
