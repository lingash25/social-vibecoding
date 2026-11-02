/**
 * THE HEADER, MOVING WITH THE PHONE'S DRAWER (Evan's design, 18 Oct 2026).
 *
 * While the drawer applies (./drawer-store.ts `on`: a phone, a community's
 * page), the platform header draws three things of its own in place of the
 * places button and the community switcher:
 *
 *   DrawerBack     the back arrow, in the left group: up one level. None on
 *                  level 0, the outermost. A button, not an href'd #back-btn:
 *                  an arrow with an address is what turns on WebKit's own
 *                  history swipe (../header/native-back-navigation.ts), which
 *                  would fight the drawer's pan.
 *   DrawerTitles   in the h1: "Communities" on level 0, the community's name
 *                  on its places, and its name over the page's ("Workshop",
 *                  "#general") on a page.
 *   DrawerUntint   the bar as it is off a community, laid over the
 *                  community's colour and faded out with depth, so the colour
 *                  blends in from level 0 to level 1 and the bar at rest on a
 *                  page is exactly the tinted bar it was. Its ink follows the
 *                  same value (`--nav-k`, app.css), from the bar's own to white.
 *
 * Messages (./messages-drawer.ts) takes the arrow and the titles too: on
 * its list "Messages", in a conversation the conversation's name over who
 * it is with, and no colour.
 *
 * Every one of them is drawn from the live depth (./drawer-math.ts
 * headerFrame): a tap animates it over the slide and a pan sets it from the
 * finger, and each writes only its own nodes' transform, opacity and
 * `--nav-k`. React renders the words; the frames never re-render.
 */

import { useRef, type ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { placeHandle, placeName, type PlaceKey } from '../dev-board/workshop/places';
import { headerFrame, titleSlot, type HeaderFrame } from './drawer-math';
import { back, communitiesDepth, drawerStore, reducedMotion, type DepthChannel } from './drawer-store';
import { messagesBack, messagesDepth, messagesDrawerStore } from './messages-drawer';

type Mode = 'communities' | 'messages' | null;

/** Which drawer the header is drawn for: Communities', Messages', or none. */
export function useDrawerMode(): Mode {
  const { on } = useStoreState(drawerStore);
  const { on: messages } = useStoreState(messagesDrawerStore);
  return on ? 'communities' : messages ? 'messages' : null;
}

/** Draw `apply` from the drawer's live depth now, and on every change, while mounted. */
function useHeaderFrame(
  mode: Mode,
  apply: (frame: HeaderFrame) => void,
  slot: () => number = () => 0,
  redraw?: { current: () => void },
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useIsomorphicLayoutEffect(() => {
    if (!mode) return undefined;
    const channel: DepthChannel = mode === 'messages' ? messagesDepth : communitiesDepth;
    const drawAt = (f: number) => applyRef.current(headerFrame(f, slotRef.current(), reducedMotion(), mode === 'messages'));
    if (redraw) redraw.current = () => drawAt(channel.live());
    drawAt(channel.live());
    return channel.on(drawAt);
  }, [mode]);
}

/** A box's start edge as a figure that grows in reading direction, for the slot's distance. */
function inlineStart(el: Element): number {
  const box = el.getBoundingClientRect();
  return dirSign() === -1 ? -box.right : box.left;
}

/** `x` is in reading direction: headerFrame's sums are the same in Arabic, drawn the other way. */
function translate(x: number, y = 0): string {
  return x || y ? `translate3d(${x * dirSign()}px, ${y}px, 0)` : '';
}

/** A place's words in the header: a channel by its #handle. */
export function pageLabel(place: string): string {
  const handle = placeHandle(place);
  return handle ? `#${handle}` : placeName(place as PlaceKey);
}

// The bar's back disc (platform-header.tsx BACK_BTN_CLASS), as complete literals.
const BACK_CLASS = 'nav-drawer-back inline-flex items-center justify-center w-7 h-7 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

export function DrawerBack(): ReactNode {
  const t = useMessages('core');
  const mode = useDrawerMode();
  const { level, shown } = useStoreState(drawerStore);
  if (mode === 'messages') return <BackDisc mode={mode} label={t('core:header.drawer.toMessages')} onBack={messagesBack} />;
  if (mode !== 'communities') return null;
  return <BackDisc mode={mode} label={level === 2 ? t('core:header.drawer.toPlaces', { community: shown.name }) : t('core:header.drawer.toCommunities')} onBack={back} />;
}

function BackDisc({ mode, label, onBack }: { mode: Mode; label: string; onBack: () => void }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);
  useHeaderFrame(mode, (frame) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = String(frame.back.opacity);
    el.style.transform = translate(frame.back.x);
    el.style.pointerEvents = frame.back.live ? '' : 'none';
    el.tabIndex = frame.back.live ? 0 : -1;
    el.setAttribute('aria-hidden', frame.back.live ? 'false' : 'true');
  });
  return (
    <button ref={ref} type="button" className={BACK_CLASS} data-nav-drawer-back="" aria-label={label} onClick={() => onBack()}>
      <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

export function DrawerTitles(): ReactNode {
  const t = useMessages('core');
  const mode = useDrawerMode();
  const { level: placeLevel, shown } = useStoreState(drawerStore);
  const conversation = useStoreState(messagesDrawerStore);
  const messages = mode === 'messages';
  // Where it rests, for a screen reader: the title on show, and the small
  // line only where it says something.
  const outerShown = messages ? conversation.level === 0 : placeLevel === 0;
  const subShown = messages ? conversation.level === 1 && !!conversation.sub : placeLevel === 2;
  const box = useRef<HTMLSpanElement>(null);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLElement>(null);
  // How far the bar's left edge is from where the name sits: the arrow and
  // its gap. "Communities" sits there, with no arrow beside it.
  // Measured when it mounts and when the window changes, never per frame.
  const slot = useRef(44);
  const redraw = useRef(() => {});
  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const el = box.current;
      const left = el?.closest('#platform-header')?.querySelector('.platform-header-left');
      if (!el || !left) return;
      const at = titleSlot(
        { laidOut: el.getClientRects().length > 0, left: inlineStart(el) },
        { laidOut: left.getClientRects().length > 0, left: inlineStart(left) },
      );
      if (at !== null && at !== slot.current) {
        slot.current = at;
        redraw.current();
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useHeaderFrame(mode, (frame) => {
    const a = outer.current;
    const b = inner.current;
    const s = sub.current;
    if (!a || !b || !s) return;
    a.style.opacity = String(frame.outer.opacity);
    a.style.transform = translate(frame.outer.x, frame.outer.y);
    b.style.opacity = String(frame.inner.opacity);
    b.style.transform = translate(frame.inner.x, frame.inner.y);
    s.style.opacity = String(frame.inner.subOpacity);
    s.style.transform = translate(frame.inner.subX, frame.inner.subY);
  }, () => slot.current, redraw);
  return (
    <span ref={box} className="nav-drawer-titles" data-nav-drawer-titles="">
      <span ref={outer} className="nav-drawer-title" aria-hidden={!outerShown || undefined}>
        <b className="nav-drawer-title-name">{messages ? t('core:header.drawer.messages') : t('core:header.communities')}</b>
      </span>
      <span ref={inner} className="nav-drawer-title" aria-hidden={outerShown || undefined}>
        <b className="nav-drawer-title-name">
          {messages ? conversation.title : shown.selfHosted ? (
            <>
              <Wordmark className="nav-drawer-title-mark" aria-hidden="true" />
              <span className="sr-only">{shown.name}</span>
            </>
          ) : shown.name}
        </b>
        <small ref={sub} className="nav-drawer-title-page" aria-hidden={!subShown || undefined}>
          {messages ? conversation.sub : pageLabel(shown.place)}
        </small>
      </span>
    </span>
  );
}

export function DrawerUntint(): ReactNode {
  const { on } = useStoreState(drawerStore);
  return on ? <Untint /> : null;
}

function Untint(): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useHeaderFrame('communities', (frame) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = String(1 - frame.tint);
    el.parentElement?.style.setProperty('--nav-k', String(frame.tint));
  });
  useIsomorphicLayoutEffect(() => {
    const header = ref.current?.parentElement || null;
    return () => { header?.style.removeProperty('--nav-k'); };
  }, []);
  return <span ref={ref} className="nav-drawer-untint" aria-hidden="true" />;
}
