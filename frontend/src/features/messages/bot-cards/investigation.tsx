// Homeroom bot parity, P9: the "investigation" card (see ./index.tsx and
// services/homeroom-bot-thread-tools/investigate.js).
//
// An investigation the bot offered, or runs, on one of the reader's
// projects: a goal checked on every few hours for up to so many days within
// its own budget. The card is the place to see and steer it:
//
//   - its small-caps label ("Investigation · day 2 of up to 5"), the goal as
//     its title, and a line with how often it checks in (and on which model);
//   - what it has spent of its budget, in words and as a thin bar in the lit
//     ink: the budget is the reader's own, so money is right here (the bot's
//     chat words never name it);
//   - when it checks in next, its last three check-ins (time and one line),
//     or why it ended;
//   - Start and Not now while it is offered (decided on the server, nothing
//     runs or spends before Start), Stop while it runs, Notes (everything it
//     found, opened on the card) and "File what it found", said as the reader
//     so the bot offers requests through its usual draft.
//
// Every field is read defensively: the server patches the card as it goes
// (setCardState), and an older card may carry fewer of them.

import { useState } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { getLanguage } from '../../../lib/i18n/runtime';
import type { BotCardProps } from './index';
import { decideCard, sayAsMe } from './index';

type Translate = (id: string, values?: Record<string, unknown>) => string;

export interface InvestigationCheckin { at: string; line: string; worth?: boolean; skipped?: boolean }
export interface InvestigationView {
  state: 'proposed' | 'running' | 'ended' | 'declined';
  goal: string;
  projectName: string | null;
  everyHours: number;
  days: number;
  budgetCents: number;
  spentCents: number;
  model: string | null;
  startedAt: string | null;
  nextAt: string | null;
  endedReason: string | null;
  endedAt: string | null;
  checkins: InvestigationCheckin[];
  notes: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STATES = new Set(['proposed', 'running', 'ended', 'declined']);
const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const text = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const when = (v: unknown) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null);

/** Pure: the card as stored, read defensively. */
export function investigationOf(card: Record<string, unknown>): InvestigationView {
  const project = card.project && typeof card.project === 'object' ? card.project as Record<string, unknown> : {};
  const checkins = (Array.isArray(card.checkins) ? card.checkins : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !!when((c as Record<string, unknown>).at))
    .slice(-3)
    .map((c) => ({ at: String(c.at), line: text(c.line, 200), ...(c.worth === true ? { worth: true } : {}), ...(c.skipped === true ? { skipped: true } : {}) }));
  return {
    state: (STATES.has(String(card.state)) ? card.state : 'proposed') as InvestigationView['state'],
    goal: text(card.goal),
    projectName: text(project.name, 80) || text(project.slug, 80) || null,
    everyHours: int(card.everyHours, 6, 1, 24),
    days: int(card.days, 5, 1, 14),
    budgetCents: int(card.budgetCents, 300, 0, 100000),
    spentCents: int(card.spentCents, 0, 0, 100000),
    model: text(card.model, 60) || null,
    startedAt: when(card.startedAt),
    nextAt: when(card.nextAt),
    endedReason: text(card.endedReason, 40) || null,
    endedAt: when(card.endedAt),
    checkins,
    notes: typeof card.notes === 'string' ? card.notes.slice(0, 4000) : '',
  };
}

/** Pure: which day of its run it is (or was, once it ended), never past its last. */
export function dayOfRun(view: InvestigationView, now: Date): number {
  if (!view.startedAt) return 1;
  const end = view.state === 'ended' && view.endedAt ? new Date(view.endedAt) : now;
  const day = Math.floor((end.getTime() - new Date(view.startedAt).getTime()) / DAY_MS) + 1;
  return Math.max(1, Math.min(view.days, day));
}

/** Pure: dollars as the reader's language writes them. */
export function money(cents: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function timeOf(at: string, now: Date, locale?: string): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === now.toDateString();
  try {
    return new Intl.DateTimeFormat(locale, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

// Why it ended, by the server's reason (rules/investigation.ts ENDED_REASONS).
const ENDED_WORDS: Record<string, string> = {
  answered: 'messages:botCards.investigation.ended.answered',
  budget: 'messages:botCards.investigation.ended.budget',
  days: 'messages:botCards.investigation.ended.days',
  stopped: 'messages:botCards.investigation.ended.stopped',
  bot_off: 'messages:botCards.investigation.ended.botOff',
  paused: 'messages:botCards.investigation.ended.paused',
  gone: 'messages:botCards.investigation.ended.gone',
  failed: 'messages:botCards.investigation.ended.failed',
};

/** Pure: the card's small-caps label. */
export function investigationLabel(t: Translate, view: InvestigationView, now: Date): string {
  if (view.state === 'proposed') return t('messages:botCards.investigation.labelProposed', { count: view.days });
  if (view.state === 'declined') return t('messages:botCards.investigation.labelDeclined');
  return t('messages:botCards.investigation.label', { day: dayOfRun(view, now), days: view.days });
}

/** Pure: the line under the goal: how often it checks in, on which project and model when it says. */
export function cadenceLine(t: Translate, view: InvestigationView): string {
  const count = view.everyHours;
  if (view.projectName && view.model) return t('messages:botCards.investigation.cadenceProjectModel', { count, project: view.projectName, model: view.model });
  if (view.projectName) return t('messages:botCards.investigation.cadenceProject', { count, project: view.projectName });
  if (view.model) return t('messages:botCards.investigation.cadenceModel', { count, model: view.model });
  return t('messages:botCards.investigation.cadence', { count });
}

export function InvestigationCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const view = investigationOf(card as Record<string, unknown>);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const now = new Date(Date.now());
  const locale = getLanguage();
  const spent = money(view.spentCents, locale);
  const budget = money(view.budgetCents, locale);
  const share = view.budgetCents > 0 ? Math.min(100, Math.round((view.spentCents / view.budgetCents) * 100)) : 0;
  const nextLine = view.state === 'running'
    ? (view.nextAt && new Date(view.nextAt).getTime() > now.getTime()
      ? t('messages:botCards.investigation.next', { time: timeOf(view.nextAt, now, locale) })
      : t('messages:botCards.investigation.checkingNow'))
    : null;
  const endedLine = view.state === 'ended'
    ? t(ENDED_WORDS[view.endedReason || ''] || 'messages:botCards.investigation.ended.other')
    : view.state === 'declined' ? t('messages:botCards.investigation.declined') : null;
  const found = view.notes.trim().length > 0;

  async function tap(action: string) {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await decideCard(message, action);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.investigation.failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2 rounded-[20px] bg-[color:var(--messages-surface)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]"
      data-bot-investigation={view.state}
    >
      <div className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400" data-bot-investigation-label="">
        {investigationLabel(t, view, now)}
      </div>
      <div>
        <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100" data-bot-investigation-goal="">{view.goal}</div>
        <div className="mt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-investigation-cadence="">
          {cadenceLine(t, view)}
        </div>
      </div>
      <div className="flex flex-col gap-1" data-bot-investigation-budget="">
        <div className="text-[0.8125rem] leading-[1.125rem] text-zinc-600 dark:text-zinc-300">
          {view.spentCents > 0
            ? t('messages:botCards.investigation.spent', { spent, budget })
            : t('messages:botCards.investigation.budget', { budget })}
        </div>
        {view.spentCents > 0 ? (
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" aria-hidden="true">
            <div
              className={view.state === 'ended' ? 'h-full rounded-full bg-zinc-400 dark:bg-zinc-500' : 'h-full rounded-full bg-[color:var(--lit-ink)]'}
              style={{ width: `${share}%` }}
            />
          </div>
        ) : null}
      </div>
      {nextLine ? <div className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-investigation-next="">{nextLine}</div> : null}
      {endedLine ? <div className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" role="status" data-bot-investigation-ended={view.endedReason || view.state}>{endedLine}</div> : null}
      {view.checkins.length ? (
        <ol className="flex flex-col gap-1 border-t border-[color:var(--app-sheet-line)] pt-2" aria-label={t('messages:botCards.investigation.timeline')} data-bot-investigation-timeline="">
          {view.checkins.map((c) => (
            <li key={c.at} className="flex min-w-0 gap-2 text-[0.8125rem] leading-[1.125rem]">
              <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{timeOf(c.at, now, locale)}</span>
              <span className={c.skipped ? 'min-w-0 text-zinc-500 dark:text-zinc-400' : 'min-w-0 text-zinc-800 dark:text-zinc-200'}>{c.line}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {notesOpen && found ? (
        <div
          className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[color:var(--dc-raised)] px-3 py-2 text-[0.8125rem] leading-[1.125rem] text-zinc-700 dark:text-zinc-300"
          data-bot-investigation-notes=""
        >
          {view.notes.trim()}
        </div>
      ) : null}
      <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.investigation.choices')}>
        {view.state === 'proposed' ? (
          <>
            <button type="button" className="messages-bot-primary" disabled={!!busy} onClick={() => void tap('start')} data-bot-investigation-start="">
              {t('messages:botCards.investigation.start')}
            </button>
            <button type="button" className="messages-bot-secondary" disabled={!!busy} onClick={() => void tap('not_now')} data-bot-investigation-not-now="">
              {t('messages:botCards.investigation.notNow')}
            </button>
          </>
        ) : null}
        {view.state === 'running' ? (
          <button type="button" className="messages-bot-secondary" disabled={!!busy} onClick={() => void tap('stop')} data-bot-investigation-stop="">
            {t('messages:botCards.investigation.stop')}
          </button>
        ) : null}
        {found && (view.state === 'running' || view.state === 'ended') ? (
          <>
            <button type="button" className="messages-bot-secondary" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)} data-bot-investigation-notes-toggle="">
              {notesOpen ? t('messages:botCards.investigation.hideNotes') : t('messages:botCards.investigation.notes')}
            </button>
            <button type="button" className="messages-bot-secondary" onClick={() => void sayAsMe(message, t('messages:botCards.investigation.fileWords'))} data-bot-investigation-file="">
              {t('messages:botCards.investigation.file')}
            </button>
          </>
        ) : null}
      </div>
      {error ? <p className="text-[0.8125rem] text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
