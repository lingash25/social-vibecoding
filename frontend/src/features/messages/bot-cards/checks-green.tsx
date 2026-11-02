// Homeroom bot parity, P6: the "checks_green" card (see ./index.tsx).
//
// One of the bot's changes is red on a check that is not its own: the bot
// brings it up to date with main, finds or files the flaky check on
// Homeroom's board, fixes it, and runs the change's checks again once that
// fix is in (services/homeroom-bot-flaky-checks.js). This card follows it,
// posted once in the request's story and patched on every device as it
// moves:
//
//   { state: 'working' | 'green' | 'person',
//     steps: [{ state: 'done' | 'now' | 'todo' | 'failed', what, request? }],
//     change: { project, sessionId }, fix?: { project, number, sessionId?, prNumber? } }
//
// Its buttons open the fix: Vote on #N (its change, once it is up for a
// vote) and See the fix (its request). A step's words are the bot's own.

import { CheckIcon, SpinnerArcIcon, WarningTriangleIcon } from '@/components/ui/icons';

import { changeHref } from '../../../lib/change-href';
import { useMessages } from '../../../lib/i18n/react';
import { openRequestPage, requestPage } from '../request-page';
import type { BotCardProps } from './index';

export type CheckStepState = 'done' | 'now' | 'todo' | 'failed';
export interface CheckStep {
  state: CheckStepState;
  what: string;
  request: { project: string; number: number } | null;
}
export interface CheckFix {
  project: string;
  number: number;
  sessionId: number | null;
  prNumber: number | null;
}

const STATES: readonly CheckStepState[] = ['done', 'now', 'todo', 'failed'];

const num = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Pure: the card's steps, read defensively (a step it cannot read is left out). */
export function checkSteps(card: Record<string, unknown>): CheckStep[] {
  const list = Array.isArray(card.steps) ? card.steps : [];
  const out: CheckStep[] = [];
  for (const raw of list.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const what = str(row.what);
    const state = STATES.includes(row.state as CheckStepState) ? row.state as CheckStepState : 'todo';
    if (!what) continue;
    const req = row.request && typeof row.request === 'object' ? row.request as Record<string, unknown> : null;
    const number = req ? num(req.number) : null;
    out.push({ state, what, request: req && number && str(req.project) ? { project: str(req.project), number } : null });
  }
  return out;
}

/** Pure: the fix the card names, or null. */
export function checkFix(card: Record<string, unknown>): CheckFix | null {
  const f = card.fix && typeof card.fix === 'object' ? card.fix as Record<string, unknown> : null;
  const number = f ? num(f.number) : null;
  if (!f || !number || !str(f.project)) return null;
  return { project: str(f.project), number, sessionId: num(f.sessionId), prNumber: num(f.prNumber) };
}

/** Pure: where the card stands. */
export function checkCardState(card: Record<string, unknown>): 'working' | 'green' | 'person' {
  return card.state === 'green' || card.state === 'person' ? card.state : 'working';
}

function StepMark({ state, label }: { state: CheckStepState; label: string }) {
  // Done is settled, so it gets no fill; where it is now is the lit ink.
  if (state === 'done') return <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" role="img" aria-label={label} />;
  if (state === 'now') {
    return <SpinnerArcIcon className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[color:var(--lit-ink)]" role="img" aria-label={label} />;
  }
  if (state === 'failed') {
    return <WarningTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--state-blocked)]" role="img" aria-label={label} />;
  }
  return (
    <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center" role="img" aria-label={label}>
      <span className="h-2 w-2 rounded-full border border-zinc-400 dark:border-zinc-500" />
    </span>
  );
}

export function ChecksGreenCard({ conversationId, card }: BotCardProps) {
  const t = useMessages('messages');
  const fields = card as Record<string, unknown>;
  const steps = checkSteps(fields);
  const fix = checkFix(fields);
  const state = checkCardState(fields);
  const stateLabel: Record<CheckStepState, string> = {
    done: t('messages:botCards.checksGreen.stepDone'),
    now: t('messages:botCards.checksGreen.stepNow'),
    todo: t('messages:botCards.checksGreen.stepTodo'),
    failed: t('messages:botCards.checksGreen.stepFailed'),
  };
  const eyebrow = state === 'green' ? t('messages:botCards.checksGreen.eyebrowGreen')
    : state === 'person' ? t('messages:botCards.checksGreen.eyebrowPerson')
      : t('messages:botCards.checksGreen.eyebrowWorking');
  const openFixRequest = () => {
    if (!fix) return;
    const page = requestPage({ appSlug: fix.project, appName: null, issueNumber: fix.number });
    if (page) openRequestPage(page, conversationId);
  };
  const openFixChange = () => {
    if (!fix?.sessionId || typeof window === 'undefined') return;
    window.location.hash = changeHref(fix.project, fix.sessionId, fix.prNumber).replace(/^#/, '');
  };
  const voteNumber = fix?.prNumber || fix?.number || null;
  const canVote = !!fix?.sessionId && state === 'working';

  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={t('messages:botCards.checksGreen.label')}
      data-checks-green={state}
    >
      <div className="min-w-0">
        <div className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400" data-checks-green-eyebrow="">{eyebrow}</div>
        <div className="text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">{t('messages:botCards.checksGreen.title')}</div>
      </div>
      {steps.length ? (
        <ol className="flex flex-col gap-1.5">
          {steps.map((s, i) => (
            <li key={`${i}-${s.state}`} className="flex items-start gap-2" data-check-step={s.state}>
              <StepMark state={s.state} label={stateLabel[s.state]} />
              <span className={s.state === 'todo'
                ? 'text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400'
                : 'text-[0.8125rem] leading-[1.125rem] text-zinc-800 dark:text-zinc-200'}
              >
                {s.what}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {fix ? (
        <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.checksGreen.fixActions')}>
          {canVote && voteNumber ? (
            <button type="button" className="messages-bot-primary" onClick={openFixChange} data-checks-green-vote="">
              {t('messages:botCards.checksGreen.voteOn', { number: String(voteNumber) })}
            </button>
          ) : null}
          <button type="button" className="messages-bot-secondary" onClick={openFixRequest} data-checks-green-fix="">
            {t('messages:botCards.checksGreen.seeFix')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
