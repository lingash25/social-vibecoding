// Homeroom bot parity, P5: the "build_note" card (see ./index.tsx).
//
// A note the person sent into one of the bot's builds while it runs
// (services/homeroom-bot-steer.js), under the bot's reply: their words, and
// where the note is. It waits for the build's next step, then the build has
// it (the server patches the card when the build's Stop hook takes it), or
// the build finished first and the card offers to put it in the change's
// next update (decided on the server: services/homeroom-bot-cards/
// build-note.js `forward`, which posts it on the change's discussion).
//
// The same card offers Stop and redo: nothing stops until Stop and redo is
// tapped (`redo`); Keep going sends the note into the build instead (`keep`).

import { useState } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { decideCard, type BotCardProps } from './index';

export type BuildNoteState = 'waiting' | 'delivered' | 'missed' | 'forwarded' | 'offer_redo' | 'redone' | 'gone';
const STATES: readonly BuildNoteState[] = ['waiting', 'delivered', 'missed', 'forwarded', 'offer_redo', 'redone', 'gone'];

export interface BuildNoteData {
  state: BuildNoteState;
  number: number | null;
  title: string | null;
  note: string;
  change: number | null;
  posted: boolean | null;
}

/** Pure: the card as stored, read defensively. */
export function buildNoteOf(card: Record<string, unknown>): BuildNoteData {
  const n = Number(card.number);
  const change = card.change && typeof card.change === 'object' ? Number((card.change as Record<string, unknown>).sessionId) : NaN;
  return {
    state: STATES.includes(card.state as BuildNoteState) ? card.state as BuildNoteState : 'waiting',
    number: Number.isInteger(n) && n > 0 ? n : null,
    title: typeof card.title === 'string' && card.title.trim() ? card.title.trim().slice(0, 160) : null,
    note: typeof card.note === 'string' ? card.note.slice(0, 2000) : '',
    change: Number.isInteger(change) && change > 0 ? change : null,
    posted: typeof card.posted === 'boolean' ? card.posted : null,
  };
}

const TITLES: Record<BuildNoteState, string> = {
  waiting: 'messages:botCards.buildNote.title.waiting',
  delivered: 'messages:botCards.buildNote.title.delivered',
  missed: 'messages:botCards.buildNote.title.missed',
  forwarded: 'messages:botCards.buildNote.title.forwarded',
  offer_redo: 'messages:botCards.buildNote.title.offerRedo',
  redone: 'messages:botCards.buildNote.title.redone',
  gone: 'messages:botCards.buildNote.title.gone',
};

/** Pure: the line under the title, by state; null when the title says it all. */
export function buildNoteLine(data: BuildNoteData): string | null {
  switch (data.state) {
    case 'waiting': return 'messages:botCards.buildNote.line.waiting';
    case 'missed': return data.change ? 'messages:botCards.buildNote.line.missedChange' : 'messages:botCards.buildNote.line.missed';
    case 'forwarded': return 'messages:botCards.buildNote.line.forwarded';
    case 'offer_redo': return 'messages:botCards.buildNote.line.offerRedo';
    case 'redone': return data.posted === false ? 'messages:botCards.buildNote.line.redoneCarried' : 'messages:botCards.buildNote.line.redone';
    default: return null;
  }
}

export interface BuildNoteViewProps {
  data: BuildNoteData;
  busy?: boolean;
  error?: string | null;
  onAction?: (action: 'redo' | 'keep' | 'forward') => void;
}

/** One build note card, from its data: pure, so a test can draw every state. */
export function BuildNoteView({ data, busy = false, error = null, onAction }: BuildNoteViewProps) {
  const t = useMessages('messages');
  const number = data.number ? String(data.number) : '';
  const title = t(TITLES[data.state], { number });
  const line = buildNoteLine(data);
  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={title}
      data-bot-build-note={data.state}
    >
      <div className="min-w-0">
        <div className="text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100" data-bot-build-note-title="">{title}</div>
        {data.title ? <p className="truncate text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{data.title}</p> : null}
      </div>
      {data.note ? (
        <blockquote className="messages-quote" data-bot-build-note-text="">
          <p className="line-clamp-4 !whitespace-pre-wrap">{data.note}</p>
        </blockquote>
      ) : null}
      {line ? <p className="messages-bot-answered" role="status">{t(line)}</p> : null}
      {data.state === 'offer_redo' ? (
        <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.buildNote.choices')}>
          <button type="button" className="messages-bot-primary" disabled={busy} onClick={() => onAction?.('redo')} data-bot-build-note-action="redo">
            <span>{t('messages:botCards.buildNote.redo')}</span>
          </button>
          <button type="button" className="messages-bot-secondary" disabled={busy} onClick={() => onAction?.('keep')} data-bot-build-note-action="keep">
            <span>{t('messages:botCards.buildNote.keep')}</span>
          </button>
        </div>
      ) : null}
      {data.state === 'missed' && data.change ? (
        <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.buildNote.choices')}>
          <button type="button" className="messages-bot-primary" disabled={busy} onClick={() => onAction?.('forward')} data-bot-build-note-action="forward">
            <span>{t('messages:botCards.buildNote.forward')}</span>
          </button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}

export function BuildNoteCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const data = buildNoteOf(card as Record<string, unknown>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: 'redo' | 'keep' | 'forward') {
    setError(null);
    setBusy(true);
    try {
      await decideCard(message, action);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.buildNote.failed'));
    } finally {
      setBusy(false);
    }
  }
  return <BuildNoteView data={data} busy={busy} error={error} onAction={(a) => { void act(a); }} />;
}
