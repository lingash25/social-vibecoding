/**
 * THE BOT TAB ON A PHONE, AS A DRAWER (30 Oct 2026, Evan: "the same as
 * Messages and Communities"; ../nav-drawer/messages-drawer.ts is the model).
 *
 * Under 768px the list is the drawer's first level, 85% of the screen, with
 * the column, Main Chat or one thread of it, peeking in at its right. The
 * column is the second level, the whole screen. Main Chat's row, a private
 * thread's row, the peek and the Ask bar slide the strip in; the column's
 * arrow and a swipe right slide it back. 1 Nov 2026: a thread is alone in
 * it, under its own head, whose arrow goes back to the list (Main Chat is a
 * row of it). A pan follows the finger and, let go past a quarter of the way,
 * lands on the next level, as the Messages drawer's does: the same strip
 * (MESSAGES_AT), the same slide (SLIDE_MS, SLIDE_EASE) and the same landing
 * rule (landingIn). The drawer holds only Main and its threads: a request,
 * a change or a decision opens on its own page, as it does from Messages
 * (Evan, 30 Oct).
 *
 * The level not in view is inert as well as hidden, so a keyboard or a
 * screen reader never lands in the 15% of the list left showing, or in the
 * peek's thread behind its button.
 *
 * From 768px nothing here is drawn: the list is its own column, beside the
 * column Main Chat docks in (1 Nov 2026: from 768px, not 1024px). The list
 * is never folded into the platform's sidebar (Evan, 30 Oct).
 *
 * NO PEEK UNTIL A THREAD HAS BEEN OPENED (Evan, 1 Nov 2026: "we shouldn't
 * show the sidebar until the user has opened a thread once, until then full
 * screen"). Until then the list is the whole screen and the column waits off
 * its right edge (FULL_AT); the first time it is opened, the device
 * remembers, and from then on the drawer is the one above.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { ChevronLeftIcon, LockIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { EmbeddedConversation } from '../messages';
import { BOT_AVATAR } from '../messages/format';
import { isPan, landingIn, MESSAGES_AT, SLIDE_EASE, SLIDE_MS } from '../nav-drawer/drawer-math';
import { reducedMotion } from '../nav-drawer/drawer-store';
import { dirSign } from '../../lib/i18n/direction';

const PHONE_QUERY = '(max-width: 767.98px)';

/** Whether this is a phone's width. False on the first render, as the prerender is. */
export function usePhone(): boolean {
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

/**
 * The second level: Main Chat's header and the chat, or a thread of it
 * alone (`threadUp`), whose own head has the arrow back to the list.
 */
export function MainPane({ botId, active, at, onBack, threadUp = false }: {
  botId: number | null;
  active: boolean;
  at: { threadRootId: number | null; focusMessageId: number | null } | null;
  onBack: () => void;
  threadUp?: boolean;
}): ReactNode {
  const t = useMessages('messages');
  return (
    <>
      {threadUp ? null : <header className="ai-drawer-head" data-ai-drawer-head="">
        <button type="button" className="ai-drawer-back" onClick={onBack} aria-label={t('messages:ai.drawer.back')}>
          <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
        </button>
        <img src={BOT_AVATAR} alt="" className="w-8 h-8 rounded-[10px] object-cover shrink-0" />
        <span className="min-w-0 flex flex-col">
          <span className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{t('messages:store.header.main')}</span>
          <span className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
            <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{t('messages:ai.main.sub')}</span>
          </span>
        </span>
      </header>}
      {botId ? <EmbeddedConversation conversationId={botId} active={active} at={at} mainChat onBack={onBack} /> : null}
    </>
  );
}

// ── Before a thread has been opened, the list is the whole screen ──

const OPENED_KEY = 'homeroom:botDrawer:threadOpened';

/** Where the strip rests with no peek: the column a whole screen to the right. */
export const FULL_AT: readonly [number, number] = [0, 1];

/** Whether a thread has ever been opened on this device. */
export function rememberedThreadOpened(): boolean {
  try {
    return window.localStorage.getItem(OPENED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberThreadOpened(): void {
  try { window.localStorage.setItem(OPENED_KEY, '1'); } catch { /* a private window: this visit only */ }
}

/** The strip: the list at 85%, Main beside it; level 0 the list, 1 Main. */
export function AiDrawer({ level, onLevel, list, pane, peekLabel }: {
  level: 0 | 1;
  onLevel: (next: 0 | 1) => void;
  list: ReactNode;
  pane: ReactNode;
  peekLabel: string;
}): ReactNode {
  const root = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const pan = useRef<{ x: number; y: number; from: 0 | 1; panning: boolean; id: number } | null>(null);
  const swallow = useRef(false);
  const [opened, setOpened] = useState(rememberedThreadOpened);
  const [snap, setSnap] = useState(false);
  const at = opened ? MESSAGES_AT : FULL_AT;
  // The first thread opened gives the drawer its peek, remembered at once
  // but laid out only once the slide has landed: the list narrowing to 85%
  // under a moving strip would jump, and off screen it is never seen. The
  // strip's rest moves from 100% to 85% with it, in one frame and with no
  // slide (snap), or the column would slide out and back.
  useEffect(() => {
    if (opened || level !== 1) return undefined;
    rememberThreadOpened();
    const id = window.setTimeout(() => { setSnap(true); setOpened(true); }, SLIDE_MS + 50);
    return () => window.clearTimeout(id);
  }, [opened, level]);
  // Two frames: the first paints the new rest with no transition, the
  // second gives the slide back.
  useEffect(() => {
    if (!snap) return undefined;
    let id = window.requestAnimationFrame(() => {
      id = window.requestAnimationFrame(() => setSnap(false));
    });
    return () => window.cancelAnimationFrame(id);
  }, [snap]);
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setWidth(el.clientWidth));
    ro?.observe(el);
    setWidth(el.clientWidth);
    return () => ro?.disconnect();
  }, []);
  const offset = drag ?? at[level];
  const still = drag != null || snap || reducedMotion();

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    pan.current = { x: e.clientX, y: e.clientY, from: level, panning: false, id: e.pointerId };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || !width) return;
    // In reading direction, so "toward the other level" and the offset below
    // are the same sums in Arabic, where the strip runs the other way.
    const dx = (e.clientX - p.x) * dirSign();
    const dy = e.clientY - p.y;
    if (!p.panning) {
      if (!isPan(dx, dy)) return;
      // Only toward the other level: inline-start from the list (left in
      // English), inline-end from Main.
      if ((p.from === 0 && dx > 0) || (p.from === 1 && dx < 0)) { pan.current = null; return; }
      p.panning = true;
      try { root.current?.setPointerCapture(p.id); } catch { /* released already */ }
      // A mouse dragging the strip would otherwise select the text under it.
      try { window.getSelection()?.removeAllRanges(); } catch { /* nothing selected */ }
    }
    setDrag(Math.max(0, Math.min(at[1], at[p.from] - dx / width)));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    pan.current = null;
    if (!p?.panning) return;
    const now = drag ?? at[p.from];
    swallow.current = true;
    setDrag(null);
    onLevel(landingIn(at, p.from, now, (e.clientX - p.x) * dirSign()) as 0 | 1);
  };
  const cancel = () => { pan.current = null; setDrag(null); };

  return (
    <div
      ref={root}
      className="ai-drawer"
      data-level={level}
      data-peek={opened ? '' : undefined}
      data-panning={drag != null ? '' : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClickCapture={(e) => { if (swallow.current) { swallow.current = false; e.preventDefault(); e.stopPropagation(); } }}
    >
      <div
        className="ai-drawer-strip"
        style={{
          transform: `translateX(${-offset * width * dirSign()}px)`,
          transition: still ? 'none' : `transform ${SLIDE_MS}ms ${SLIDE_EASE}`,
        }}
      >
        <div className="ai-drawer-list" inert={level === 1} aria-hidden={level === 1 ? true : undefined}>{list}</div>
        <section className="ai-drawer-thread">
          <div className="ai-drawer-pane" inert={level === 0} aria-hidden={level === 0 ? true : undefined}>{pane}</div>
          {/* The peek: Main as it is, pressed as one (Messages' own). */}
          {opened && level === 0 && drag == null ? (
            <button type="button" className="messages-peek-open ai-drawer-peek" aria-label={peekLabel} onClick={() => onLevel(1)} />
          ) : null}
        </section>
      </div>
    </div>
  );
}
