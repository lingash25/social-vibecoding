// Homeroom bot parity, P4: the "batch" card (see ./index.tsx).
//
// "Work through these" in a chat with the bot puts this under its reply
// (services/homeroom-bot-batches.js propose): one row per request with what
// the bot last found on it, and under them Build the N (decided on the
// server: services/homeroom-bot-cards/batch.js), Answer the questions and,
// for one that is done, Close #N (both said as the person, so the bot asks
// its questions or offers its close vote).
//
// Once Build is tapped the card is a roll-up of those builds, read from the
// bot's records on the server and patched in place as they move: how many
// are live, ready for a yes, in checks, building and waiting, as a bar and
// a legend in words. A batch the project's owner works through may run more
// at once than the usual limit, and the card says so.
//
// Every field is read defensively: the card is whatever the server stored.

import { useState } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { i18n } from '../../../lib/i18n/runtime';
import { decideCard, sayAsMe, type BotCardProps } from './index';

export type BatchRead = 'ready' | 'question' | 'person' | 'done' | 'reading' | 'underway' | 'unread';
export type BatchBucket = 'live' | 'ready' | 'checks' | 'building' | 'waiting' | 'stopped';

export interface BatchRow { number: number; title: string | null; read: BatchRead; note: string | null; why: string | null }
export interface BatchProgress { number: number; state: BatchBucket; title?: string | null }
export interface BatchRaise { perPerson: number | null; proposalsPerApp: number | null; as: 'owner' | 'admin' }
export interface BatchCardData {
  state: 'proposed' | 'running' | 'done';
  projectName: string;
  requests: BatchRow[];
  rollup: Record<BatchBucket, number> | null;
  progress: BatchProgress[];
  raise: BatchRaise | null;
  refused: number[];
}

const READS: readonly BatchRead[] = ['ready', 'question', 'person', 'done', 'reading', 'underway', 'unread'];
export const BUCKETS: readonly BatchBucket[] = ['live', 'ready', 'checks', 'building', 'waiting', 'stopped'];
const MAX_ROWS = 8;
const MAX_CLOSE = 2;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const text = (v: unknown, max = 240) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Pure: the card as stored, read defensively. */
export function batchOf(card: Record<string, unknown>): BatchCardData {
  const state = card.state === 'running' || card.state === 'done' ? card.state : 'proposed';
  const requests = (Array.isArray(card.requests) ? card.requests : []).flatMap((r) => {
    const row = (r || {}) as Record<string, unknown>;
    const n = num(row.number);
    if (!n) return [];
    const read = READS.includes(row.read as BatchRead) ? row.read as BatchRead : 'unread';
    return [{ number: n, title: text(row.title, 160), read, note: text(row.note), why: text(row.why, 40) }];
  }).slice(0, 20);
  const rawRoll = card.rollup && typeof card.rollup === 'object' ? card.rollup as Record<string, unknown> : null;
  const rollup = rawRoll
    ? Object.fromEntries(BUCKETS.map((b) => [b, Math.max(0, Math.floor(Number(rawRoll[b]) || 0))])) as Record<BatchBucket, number>
    : null;
  const progress = (Array.isArray(card.progress) ? card.progress : []).flatMap((p) => {
    const row = (p || {}) as Record<string, unknown>;
    const n = num(row.number);
    return n && BUCKETS.includes(row.state as BatchBucket) ? [{ number: n, state: row.state as BatchBucket, title: text(row.title, 160) }] : [];
  });
  const raw = card.raise && typeof card.raise === 'object' ? card.raise as Record<string, unknown> : null;
  const raise = raw ? { perPerson: num(raw.perPerson), proposalsPerApp: num(raw.proposalsPerApp), as: raw.as === 'admin' ? 'admin' as const : 'owner' as const } : null;
  const refused = (Array.isArray(card.refused) ? card.refused : []).flatMap((r) => {
    const n = num((r as Record<string, unknown>)?.number);
    return n ? [n] : [];
  });
  return {
    state, projectName: text(card.projectName, 120) || text(card.project, 120) || '',
    requests, rollup, progress, raise: raise && (raise.perPerson || raise.proposalsPerApp) ? raise : null, refused,
  };
}

/** Pure: how many rows of each read. */
export function readCounts(rows: BatchRow[]): Record<BatchRead, number> {
  return Object.fromEntries(READS.map((r) => [r, rows.filter((row) => row.read === r).length])) as Record<BatchRead, number>;
}

/** Pure: "#3 and #7", "#3, #7 and #9": the numbers a sentence names, as the language lists them. */
export function numberList(numbers: number[], locale: string = i18n.language || 'en'): string {
  const all = numbers.map((n) => `#${n}`);
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(all);
  } catch {
    return all.join(', ');
  }
}

// The read tag on each row, and what a row says when the bot left no words.
const READ_TAGS: Record<BatchRead, string> = {
  ready: 'messages:botCards.batch.read.ready',
  question: 'messages:botCards.batch.read.question',
  person: 'messages:botCards.batch.read.person',
  done: 'messages:botCards.batch.read.done',
  reading: 'messages:botCards.batch.read.reading',
  underway: 'messages:botCards.batch.read.underway',
  unread: 'messages:botCards.batch.read.unread',
};
const WHY_LINES: Record<string, string> = {
  plan: 'messages:botCards.batch.why.plan',
  held: 'messages:botCards.batch.why.held',
  allowance: 'messages:botCards.batch.why.allowance',
  not_built_here: 'messages:botCards.batch.why.notBuiltHere',
  not_member: 'messages:botCards.batch.why.notMember',
  empty: 'messages:botCards.batch.why.empty',
  live: 'messages:botCards.batch.why.live',
  vote: 'messages:botCards.batch.why.vote',
  checks: 'messages:botCards.batch.why.checks',
  building: 'messages:botCards.batch.why.building',
  going_live: 'messages:botCards.batch.why.goingLive',
  build_queued: 'messages:botCards.batch.why.buildQueued',
};
// The summary under the title, one counted phrase per read with any.
const READ_COUNTS: Record<BatchRead, string> = {
  ready: 'messages:botCards.batch.count.ready',
  question: 'messages:botCards.batch.count.question',
  person: 'messages:botCards.batch.count.person',
  done: 'messages:botCards.batch.count.done',
  reading: 'messages:botCards.batch.count.reading',
  underway: 'messages:botCards.batch.count.underway',
  unread: 'messages:botCards.batch.count.unread',
};
// The roll-up's legend, and each running row's state.
const BUCKET_COUNTS: Record<BatchBucket, string> = {
  live: 'messages:botCards.batch.rollup.live',
  ready: 'messages:botCards.batch.rollup.ready',
  checks: 'messages:botCards.batch.rollup.checks',
  building: 'messages:botCards.batch.rollup.building',
  waiting: 'messages:botCards.batch.rollup.waiting',
  stopped: 'messages:botCards.batch.rollup.stopped',
};
const BUCKET_TAGS: Record<BatchBucket, string> = {
  live: 'messages:botCards.batch.state.live',
  ready: 'messages:botCards.batch.state.ready',
  checks: 'messages:botCards.batch.state.checks',
  building: 'messages:botCards.batch.state.building',
  waiting: 'messages:botCards.batch.state.waiting',
  stopped: 'messages:botCards.batch.state.stopped',
};
// The bar's segments: live in the finished green, ready for a yes in the
// accent (it asks for the viewer), checks in its light tint, building grey.
// Waiting and stopped are the bar's own ground.
export const SEGMENTS: Record<BatchBucket, string> = {
  live: 'bg-[color:var(--state-ok)]',
  ready: 'bg-violet-500 dark:bg-violet-400',
  checks: 'bg-violet-200 dark:bg-violet-400/40',
  building: 'bg-zinc-400 dark:bg-zinc-500',
  waiting: 'bg-zinc-200 dark:bg-zinc-700',
  stopped: 'bg-zinc-200 dark:bg-zinc-700',
};

type T = ReturnType<typeof useMessages>;

/** The roll-up in words, zero saying nothing: "2 live · 3 ready for your yes · 4 building". */
export function rollupWords(t: T, rollup: Record<BatchBucket, number> | null): string {
  if (!rollup) return '';
  return BUCKETS.filter((b) => rollup[b] > 0).map((b) => t(BUCKET_COUNTS[b], { count: rollup[b] })).join(' · ');
}

export interface BatchCardViewProps {
  data: BatchCardData;
  busy?: boolean;
  error?: string | null;
  onBuild?: () => void;
  onAnswer?: (numbers: number[]) => void;
  onClose?: (number: number) => void;
}

/** One batch card, from its data: pure, so a test can draw every state. */
export function BatchCardView({ data, busy = false, error = null, onBuild, onAnswer, onClose }: BatchCardViewProps) {
  const t = useMessages('messages');
  const [all, setAll] = useState(false);
  const counts = readCounts(data.requests);
  const project = data.projectName;
  const title = data.state === 'proposed'
    ? t('messages:botCards.batch.title', { project })
    : data.state === 'running' ? t('messages:botCards.batch.titleRunning', { project }) : t('messages:botCards.batch.titleDone', { project });
  const summary = data.state === 'proposed'
    ? [t('messages:botCards.batch.count.total', { count: data.requests.length }),
      ...READS.filter((r) => counts[r] > 0).map((r) => t(READ_COUNTS[r], { count: counts[r] }))].join(' · ')
    : rollupWords(t, data.rollup);
  const total = data.rollup ? BUCKETS.reduce((sum, b) => sum + data.rollup![b], 0) : 0;
  const questions = data.requests.filter((r) => r.read === 'question').map((r) => r.number);
  const done = data.requests.filter((r) => r.read === 'done').map((r) => r.number).slice(0, MAX_CLOSE);
  const raise = data.raise && data.raise.perPerson
    ? (data.state === 'proposed'
      ? t(data.raise.as === 'admin' ? 'messages:botCards.batch.raise.offerAdmin' : 'messages:botCards.batch.raise.offerOwner', { count: data.raise.perPerson })
      : t(data.raise.as === 'admin' ? 'messages:botCards.batch.raise.runningAdmin' : 'messages:botCards.batch.raise.runningOwner', { count: data.raise.perPerson }))
    : null;
  const rows = data.state === 'proposed' ? data.requests : [];
  const shown = all ? rows : rows.slice(0, MAX_ROWS);
  const titleOf = (n: number) => data.requests.find((r) => r.number === n)?.title || data.progress.find((p) => p.number === n)?.title || null;
  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={title}
      data-bot-batch={data.state}
    >
      <div className="min-w-0">
        <div className="text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100" data-bot-batch-title="">{title}</div>
        {summary ? <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-batch-summary="">{summary}</p> : null}
      </div>
      {data.state !== 'proposed' && data.rollup && total > 0 ? (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="img" aria-label={rollupWords(t, data.rollup)} data-bot-batch-bar="">
          {BUCKETS.filter((b) => data.rollup![b] > 0).map((b) => (
            <i key={b} className={`block h-full ${SEGMENTS[b]}`} style={{ width: `${(100 * data.rollup![b]) / total}%` }} data-bot-batch-segment={b} />
          ))}
        </div>
      ) : null}
      {rows.length ? (
        <ul className="flex flex-col gap-2" data-bot-batch-rows="">
          {shown.map((row) => (
            <li key={row.number} className="flex items-start gap-2" data-bot-batch-row={row.number} data-bot-batch-read={row.read}>
              <span className="mt-[1px] shrink-0 text-[0.8125rem] font-semibold tabular-nums text-zinc-500 dark:text-zinc-400">#{row.number}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">
                  {row.title || t('messages:botCards.batch.untitled', { number: String(row.number) })}
                </div>
                {row.note || (row.why && WHY_LINES[row.why]) ? (
                  <p className="line-clamp-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
                    {row.note || t(WHY_LINES[row.why!])}
                  </p>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[0.75rem] font-semibold ${row.read === 'ready' ? 'bg-[color:var(--accent-tint)] text-[color:var(--accent-tint-ink)]' : 'bg-[color:var(--dc-raised)] text-zinc-600 dark:text-zinc-300'}`}
              >
                {t(READ_TAGS[row.read])}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > MAX_ROWS ? (
        <button type="button" className="self-start text-[0.8125rem] font-semibold text-[color:var(--accent)]" onClick={() => setAll(!all)} data-bot-batch-more="">
          {all ? t('messages:botCards.batch.fewer') : t('messages:botCards.batch.more', { count: rows.length - MAX_ROWS })}
        </button>
      ) : null}
      {data.state !== 'proposed' && data.progress.length ? (
        <ul className="flex flex-col gap-1" data-bot-batch-progress="">
          {data.progress.map((p) => (
            <li key={p.number} className="flex items-center gap-2 text-[0.8125rem] leading-[1.125rem]" data-bot-batch-progress-row={p.number} data-state={p.state}>
              <i className={`block h-2 w-2 shrink-0 rounded-full ${SEGMENTS[p.state]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">
                {titleOf(p.number) ? `#${p.number} ${titleOf(p.number)}` : `#${p.number}`}
              </span>
              <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t(BUCKET_TAGS[p.state])}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {raise ? <p className="messages-bot-answered" data-bot-batch-raise="">{raise}</p> : null}
      {data.refused.length ? (
        <p className="messages-bot-answered" data-bot-batch-refused="">
          {t('messages:botCards.batch.refused', { count: data.refused.length, numbers: numberList(data.refused) })}
        </p>
      ) : null}
      {data.state === 'proposed' && (counts.ready || questions.length || done.length) ? (
        <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.batch.choices')}>
          {counts.ready ? (
            <button type="button" className="messages-bot-primary" disabled={busy} onClick={() => onBuild?.()} data-bot-batch-action="build">
              <span>{t('messages:botCards.batch.build', { count: counts.ready })}</span>
            </button>
          ) : null}
          {questions.length ? (
            <button type="button" className="messages-bot-secondary" disabled={busy} onClick={() => onAnswer?.(questions)} data-bot-batch-action="answer">
              <span>{t('messages:botCards.batch.answer', { count: questions.length })}</span>
            </button>
          ) : null}
          {done.map((n) => (
            <button key={n} type="button" className="messages-bot-secondary" disabled={busy} onClick={() => onClose?.(n)} data-bot-batch-action="close">
              <span>{t('messages:botCards.batch.close', { number: String(n) })}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}

export function BatchCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const data = batchOf(card as Record<string, unknown>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(run: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.batch.failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BatchCardView
      data={data}
      busy={busy}
      error={error}
      onBuild={() => { void act(() => decideCard(message, 'build')); }}
      onAnswer={(numbers) => { void act(() => sayAsMe(message, t('messages:botCards.batch.say.answer', { count: numbers.length, numbers: numberList(numbers) }))); }}
      onClose={(n) => { void act(() => sayAsMe(message, t('messages:botCards.batch.say.close', { number: String(n) }))); }}
    />
  );
}
