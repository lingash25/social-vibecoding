// An investigation's rules (Homeroom bot parity, P9): what one may ask for,
// and when it checks in and ends. One copy, read by the bot-investigation
// machine's transitions and by the bot's own modules
// (services/homeroom-bot-thread-tools/investigate.js, its card's taps).
// Pure: no state, no clock but the one handed in, no I/O.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export const DEFAULTS = Object.freeze({ everyHours: 6, days: 5, budgetDollars: 3 });
export const LIMITS = Object.freeze({
  everyHours: [1, 24] as const,
  days: [1, 14] as const,
  budgetDollars: [0.25, 10] as const,
});
// How many of one person's run at once.
export const MAX_RUNNING = 2;
// Check-ins that failed in a row before it gives up.
export const MAX_FAILURES = 3;
// A check-in that found another look of theirs running is asked again this much later.
export const BUSY_RETRY_MS = 10 * 60 * 1000;
// A failed check-in's next try, at the latest.
export const FAILED_RETRY_MS = HOUR_MS;
export const MIN_GOAL_CHARS = 10;
export const MAX_GOAL_CHARS = 600;

// Why one ended, as its card says it (frontend bot-cards/investigation.tsx).
export const ENDED_REASONS = Object.freeze(['answered', 'budget', 'days', 'stopped', 'bot_off', 'paused', 'gone', 'failed'] as const);
export type EndedReason = typeof ENDED_REASONS[number];

export interface Spec { ok: true; project: string; goal: string; everyHours: number; days: number; budgetCents: number }
export interface SpecError { ok: false; error: string }

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/^\$/, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** What the bot asked for, checked: the defaults where it named nothing. */
export function investigationSpec(args: any): Spec | SpecError {
  const project = typeof args?.project === 'string' ? args.project.trim().replace(/^#/, '').slice(0, 120) : '';
  const goal = typeof args?.goal === 'string' ? args.goal.replace(/\s+/g, ' ').trim() : '';
  if (!project) return { ok: false, error: 'Say which project to investigate.' };
  if (goal.length < MIN_GOAL_CHARS) return { ok: false, error: 'Say what the investigation should find out, in a sentence.' };
  const every = num(args?.everyHours);
  const days = num(args?.days);
  const dollars = num(args?.budgetDollars);
  const everyHours = every == null ? DEFAULTS.everyHours : every;
  const dayCount = days == null ? DEFAULTS.days : days;
  const budget = dollars == null ? DEFAULTS.budgetDollars : dollars;
  if (!Number.isInteger(everyHours) || everyHours < LIMITS.everyHours[0] || everyHours > LIMITS.everyHours[1]) {
    return { ok: false, error: 'It can check in every 1 to 24 hours, in whole hours.' };
  }
  if (!Number.isInteger(dayCount) || dayCount < LIMITS.days[0] || dayCount > LIMITS.days[1]) {
    return { ok: false, error: 'It can run for 1 to 14 days, in whole days.' };
  }
  if (!Number.isFinite(budget) || budget < LIMITS.budgetDollars[0] || budget > LIMITS.budgetDollars[1]) {
    return { ok: false, error: 'Its budget can be from $0.25 to $10.' };
  }
  return { ok: true, project, goal: goal.slice(0, MAX_GOAL_CHARS), everyHours, days: dayCount, budgetCents: Math.round(budget * 100) };
}

/** When one started at `startedAt` and running for `days` ends. */
export function endsAtOf(startedAt: Date, days: number): Date {
  return new Date(startedAt.getTime() + days * DAY_MS);
}

/** Which day of its run `now` is (1-based), never past its last. */
export function dayOf(startedAt: Date | string | null, now: Date, days: number): number {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(start)) return 1;
  return Math.max(1, Math.min(days, Math.floor((now.getTime() - start) / DAY_MS) + 1));
}

export interface Ledger { spentCents: number; budgetCents: number; everyMs: number; endsAt: string; failures: number }
export interface CheckInResult {
  costCents?: number; answered?: boolean; ran?: boolean; failed?: boolean;
  stop?: string | null; busy?: boolean; skipped?: string | null;
}
export type Next =
  | { end: EndedReason; spentCents: number; ran: boolean; failures: number }
  | { at: Date; spentCents: number; ran: boolean; failures: number };

const STOPS: ReadonlySet<string> = new Set(['bot_off', 'paused', 'gone', 'budget']);

/**
 * What follows a check-in: its spend added, and then the end (answered,
 * budget, days, a stop it was told of, too many failures in a row) or the
 * time of the next one. Pure.
 */
export function afterCheckIn(l: Ledger, r: CheckInResult, now: Date): Next {
  const spentCents = l.spentCents + Math.max(0, Math.ceil(Number(r.costCents) || 0));
  const ran = r.ran === true;
  const failures = r.failed ? l.failures + 1 : (ran ? 0 : l.failures);
  if (r.stop && STOPS.has(r.stop)) return { end: r.stop as EndedReason, spentCents, ran, failures };
  if (r.busy) return { at: new Date(now.getTime() + BUSY_RETRY_MS), spentCents, ran, failures };
  if (ran && r.answered && !r.failed) return { end: 'answered', spentCents, ran, failures };
  if (spentCents >= l.budgetCents) return { end: 'budget', spentCents, ran, failures };
  if (failures >= MAX_FAILURES) return { end: 'failed', spentCents, ran, failures };
  const every = r.failed ? Math.min(l.everyMs, FAILED_RETRY_MS) : l.everyMs;
  const at = new Date(now.getTime() + every);
  if (at.getTime() >= new Date(l.endsAt).getTime()) return { end: 'days', spentCents, ran, failures };
  return { at, spentCents, ran, failures };
}

/** Whether a check-in that comes due now runs: null when it does, else why it ends instead. Pure. */
export function dueCheck(l: Ledger, now: Date): EndedReason | null {
  if (now.getTime() >= new Date(l.endsAt).getTime()) return 'days';
  if (l.spentCents >= l.budgetCents) return 'budget';
  return null;
}
