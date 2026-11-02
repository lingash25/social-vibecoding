// Homeroom bot parity, P2: the "compare" card (see ./index.tsx), under the
// designer's reply in a design thread (services/design-bot-compare.js):
// two or three of the thread's versions, or the screen as it is now beside
// them, drawn small side by side, each in the design card's own frame
// (../design-card.tsx: its own origin, scripts and nothing else).
//
//   SIDE BY SIDE                    [Phone] [Desktop]
//   ┌──────┐ ┌──────┐ ┌──────┐
//   │ now  │ │  v2  │ │  v3  │       a tap opens that version beside the chat
//   └──────┘ └──────┘ └──────┘
//   Now      Bigger    Darker
//   [Pick]   [Pick]    [Picked ✓]
//   [Propose version 3]
//
// Pick is decided on the server (homeroom-bot-cards/compare.js: the card's
// `picked`, on every device), then said as the person ("Pick version 3"),
// which the designer reads. Propose opens the design pane's own Propose it
// card for that version (../design-pane.tsx ProposeCard). Nothing is read
// in the first render: the design and its versions load in effects.

import { useEffect, useState, type ReactNode } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { currentSheets, designFrameDoc, DESIGN_SANDBOX } from '../../design/frame';
import { inlinePictures } from '../../design/pictures';
import { openPreview } from '../../ai/preview';
import type { DesignThread } from '../api';
import { readDesign, readVersion } from '../design-card';
import { ProposeCard } from '../design-pane';
import { decideCard, sayAsMe, type BotCardProps } from './index';

export type CompareKey = 'now' | number;
export interface CompareItem { key: CompareKey; version: number; label: string | null }
export type CompareSize = 'phone' | 'desktop';

// The two sizes a screen is drawn at (services/design-threads.js SCREEN_SIZES).
const SCREENS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
// Each picture's width on the card, and the most it may be tall.
const BOX_W = { phone: 140, desktop: 240 } as const;
const MAX_H = 240;
const POSTABLE = ['open', 'posted', 'filed'];

/** Pure: an item's key as the card stores it, or null. */
export function compareKeyOf(value: unknown): CompareKey | null {
  if (value === 'now') return 'now';
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pure: the card's items, read defensively: 'now' is version 1, the screen the thread began from. */
export function compareItems(card: Record<string, unknown>): CompareItem[] {
  const raw = Array.isArray(card.items) ? card.items : [];
  const out: CompareItem[] = [];
  for (const entry of raw.slice(0, 3)) {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const key = compareKeyOf(item.version);
    if (key == null || out.some((o) => o.key === key)) continue;
    out.push({
      key,
      version: key === 'now' ? 1 : key,
      label: key === 'now' ? null : (typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 40) : null),
    });
  }
  return out;
}

/** Pure: the size a design is drawn at first: its own. */
export function sizeOf(design: { width: number } | null): CompareSize {
  return design && design.width >= 768 ? 'desktop' : 'phone';
}

/** Pure: the frame a screen is drawn in at `size`, and the box and scale it is shown at. */
export function compareBox(design: { width: number; height: number } | null, size: CompareSize): { frame: { width: number; height: number }; width: number; height: number; scale: number } {
  const own = design && sizeOf(design) === size && design.width > 0 && design.height > 0;
  const frame = own ? { width: design!.width, height: design!.height } : SCREENS[size];
  const width = BOX_W[size];
  const scale = Math.min(1, width / frame.width);
  return { frame, width, height: Math.min(MAX_H, Math.round(frame.height * scale)), scale };
}

export function CompareCard({ message, conversationId, card }: BotCardProps): ReactNode {
  const t = useMessages('messages');
  const items = compareItems(card);
  const rootId = Number(card.rootId);
  const validRoot = Number.isSafeInteger(rootId) && rootId > 0;
  const [design, setDesign] = useState<DesignThread | null>(null);
  const [docs, setDocs] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<CompareSize | null>(null);
  const [mine, setMine] = useState<CompareKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposing, setProposing] = useState(false);
  const newest = items.reduce((n, item) => Math.max(n, item.version), 0);
  const versionsKey = items.map((item) => item.version).join(',');

  useEffect(() => {
    if (!validRoot || !newest) return undefined;
    let live = true;
    readDesign(rootId, newest).then((found) => {
      if (!live) return;
      setDesign(found);
      const sheets = found.surface === 'platform' ? currentSheets() : [];
      for (const version of new Set(versionsKey.split(',').map(Number))) {
        readVersion(rootId, version)
          .then((v) => inlinePictures(v.html))
          .then((html) => {
            if (live) setDocs((had) => ({ ...had, [version]: designFrameDoc(html, { origin: window.location.origin, sheets }) }));
          })
          .catch(() => { if (live) setFailed(true); });
      }
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [rootId, validRoot, newest, versionsKey]);

  if (!validRoot || items.length < 2) return null;
  const shown = size || sizeOf(design);
  const picked = compareKeyOf(card.picked) ?? mine;
  const labelOf = (item: CompareItem) => (item.key === 'now'
    ? t('messages:botCards.compare.now')
    : item.label || t('messages:botCards.compare.version', { version: item.version }));
  const pick = async (item: CompareItem) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await decideCard(message, 'pick', item.key);
      setMine(item.key);
      await sayAsMe(message, item.key === 'now'
        ? t('messages:botCards.compare.keepNowWords')
        : t('messages:botCards.compare.pickWords', { version: item.version }));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.compare.failed'));
    } finally {
      setBusy(false);
    }
  };
  const postable = !!design?.app && POSTABLE.includes(design.state);
  const pickedVersion = typeof picked === 'number' ? picked : null;
  const box = compareBox(design, shown);

  return (
    <div className="mt-2 flex max-w-full flex-col gap-2" data-bot-compare={rootId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">
          {t('messages:botCards.compare.heading')}
        </span>
        <div className="inline-flex rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800" role="group" aria-label={t('messages:botCards.compare.sizeGroup')}>
          {(['phone', 'desktop'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={shown === s}
              className={shown === s
                ? 'h-8 rounded-full bg-white px-3 text-[13px] font-semibold text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
                : 'h-8 rounded-full px-3 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300'}
              onClick={() => setSize(s)}
              data-bot-compare-size={s}
            >
              {s === 'phone' ? t('messages:botCards.compare.phone') : t('messages:botCards.compare.desktop')}
            </button>
          ))}
        </div>
      </div>
      <ul className="flex max-w-full gap-2 overflow-x-auto pb-1" aria-label={t('messages:botCards.compare.groupLabel')}>
        {items.map((item) => {
          const label = labelOf(item);
          const doc = docs[item.version];
          const isPicked = picked === item.key;
          return (
            <li key={String(item.key)} className="flex shrink-0 flex-col gap-1.5" style={{ width: box.width }} data-bot-compare-item={String(item.key)}>
              <div
                className="relative overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_var(--app-sheet-line)]"
                style={{ width: box.width, height: box.height }}
              >
                {doc && design ? (
                  <iframe
                    key={shown}
                    title={t('messages:botCards.compare.frameTitle', { label })}
                    sandbox={DESIGN_SANDBOX}
                    referrerPolicy="no-referrer"
                    srcDoc={doc}
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{
                      width: box.frame.width, height: box.frame.height, transform: `scale(${box.scale})`, transformOrigin: '0 0',
                      border: 0, background: '#fff', pointerEvents: 'none',
                    }}
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-[12px] text-zinc-500">
                    {failed ? t('messages:design.card.failed') : t('messages:design.pane.loading')}
                  </span>
                )}
                <button
                  type="button"
                  className="absolute inset-0 h-full w-full cursor-pointer"
                  onClick={() => openPreview({ conversationId, rootId, version: item.version })}
                  aria-label={t('messages:botCards.compare.open', { label })}
                  data-bot-compare-open={String(item.key)}
                />
              </div>
              <span className="truncate text-[13px] font-[650] text-zinc-900 dark:text-zinc-100">{label}</span>
              <div className="messages-bot-answers">
                <button
                  type="button"
                  className={isPicked ? 'messages-bot-done' : 'messages-bot-secondary'}
                  disabled={busy || isPicked}
                  aria-label={isPicked ? t('messages:botCards.compare.pickedLabel', { label }) : t('messages:botCards.compare.pickLabel', { label })}
                  onClick={() => void pick(item)}
                  data-bot-compare-pick={String(item.key)}
                >
                  {isPicked ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                  <span>{isPicked ? t('messages:botCards.compare.picked') : t('messages:botCards.compare.pick')}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {pickedVersion && postable && !proposing ? (
        <div className="messages-bot-answers">
          <button type="button" className="messages-bot-secondary" onClick={() => setProposing(true)} data-bot-compare-propose={pickedVersion}>
            <span>{t('messages:botCards.compare.propose', { version: pickedVersion })}</span>
          </button>
        </div>
      ) : null}
      {proposing && design && pickedVersion ? (
        <ProposeCard design={design} version={pickedVersion} onClose={() => setProposing(false)} onDone={() => setProposing(false)} />
      ) : null}
      {error ? <p className="messages-bot-note" role="alert">{error}</p> : null}
    </div>
  );
}
