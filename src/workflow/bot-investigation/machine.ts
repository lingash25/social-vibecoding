// bot-investigation: one investigation the Homeroom bot runs for a person
// over days (Homeroom bot parity, P9; services/homeroom-bot-thread-tools/
// investigate.js). One instance per investigation (`investigation:<id>`,
// its row in homeroom_bot_investigations), from the tap on Start:
//
//   (none) ──Started──▶ checking ──its check-in ends──▶ waiting ──CheckInDue──▶ checking …
//                          │                              │
//                          └──Stop, answered, budget, days, the bot off, the project paused──▶ ended
//
// A check-in is one work item, `investigation.checkIn`, keyed by its
// sequence number: a timer that fires twice (a deadline fires once per
// instance version) or an event replayed never makes a second. Its look is
// a read-only turn of the bot's on the item's steps (look-into.js lookInto),
// so a restart follows the turn rather than starting another, and its notes
// and its short update in the chat are kept once each. What it cost comes
// back as the item's result: this machine adds it up against the budget and
// decides what follows (rules/investigation.ts afterCheckIn). The card under
// the bot's reply is drawn from what it decides (`investigation.card`), and
// its end is said once (`investigation.ended`). The row's state,
// spent_cents, next_at and ended_* are this machine's projection.

import { NONE, appendEvent, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, Queryable, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { HOUR_MS, MAX_RUNNING, afterCheckIn, dueCheck, endsAtOf } from '../rules/investigation.ts';
import type { EndedReason, Ledger } from '../rules/investigation.ts';

export const MACHINE = 'bot-investigation';
export const investigationKey = (id: number) => `investigation:${id}`;
export const WORK = Object.freeze({ checkIn: 'investigation.checkIn', card: 'investigation.card', ended: 'investigation.ended' });

export interface Data {
  id: number;
  userId: number;
  appId: number;
  everyMs: number;
  days: number;
  budgetCents: number;
  spentCents: number;
  startedAt: string;
  endsAt: string;
  // Check-ins that ran, and the sequence of the check-in work (one more per
  // check-in asked, run or not).
  n: number;
  seq: number;
  failures: number;
  nextAt: string | null;
  endedReason?: EndedReason | null;
  endedAt?: string | null;
  stoppedBy?: string | null;
}
type Name = 'checking' | 'waiting' | 'ended';
export type IState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<IState, { data: Data }>;

interface Row { id: string; user_id: number; app_id: number; state: string; every_hours: number; days: number; budget_cents: number }
interface Facts { row: Row | null; running: number }
const NO_FACTS: Facts = { row: null, running: 0 };

const id = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const EVENTS = {
  // Its owner tapped Start on its card (homeroom-bot-cards/investigation.js).
  Started: (p: any) => ({ investigationId: id(p?.investigationId, 'investigationId') }),
  // The instance's deadline: the next check-in is due.
  CheckInDue: () => ({}),
  // Its owner tapped Stop, or the platform stopped it.
  StopRequested: (p: any) => ({ by: typeof p?.by === 'string' && p.by.trim() ? p.by.trim().slice(0, 80) : null }),
};

/** Ask for investigation `id` to start, as its owner: keyed by it, so a second tap is the same request. */
export function requestStart(db: Queryable, p: { investigationId: number; appId: number; userId: number }): Promise<number> {
  return appendEvent(db, MACHINE, investigationKey(p.investigationId), { type: 'Started', payload: { investigationId: p.investigationId } },
    { requestKey: `start:${p.investigationId}`, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: 'investigation-card' } });
}

/** Ask for investigation `id` to stop, as its owner. */
export function requestStop(db: Queryable, p: { investigationId: number; appId: number; userId: number; by?: string | null }): Promise<number> {
  return appendEvent(db, MACHINE, investigationKey(p.investigationId), { type: 'StopRequested', payload: { by: p.by ?? null } },
    { requestKey: `stop:${p.investigationId}`, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: 'investigation-card' } });
}

async function readFacts(tx: Tx, e: Event<any>, ctx: TransitionContext): Promise<Facts> {
  if (e.type !== 'Started') return NO_FACTS;
  const m = /^investigation:(\d+)$/.exec(ctx.key);
  if (!m || Number(m[1]) !== e.payload.investigationId) return NO_FACTS;
  const { rows: [row] } = await tx.query<Row>(
    `SELECT id, user_id, app_id, state, every_hours, days, budget_cents
       FROM homeroom_bot_investigations WHERE id = $1 FOR UPDATE`, [e.payload.investigationId]);
  if (!row) return NO_FACTS;
  const { rows: [c] } = await tx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM homeroom_bot_investigations WHERE user_id = $1 AND state = 'running' AND id <> $2`,
    [row.user_id, row.id]);
  return { row, running: Number(c?.n) || 0 };
}

const ledger = (d: Data): Ledger => ({ spentCents: d.spentCents, budgetCents: d.budgetCents, everyMs: d.everyMs, endsAt: d.endsAt, failures: d.failures });

// What the card shows of what this machine decided (the handler adds the
// check-ins and the notes from the row).
function cardPatch(name: Name, d: Data): Json {
  return {
    state: name === 'ended' ? 'ended' : 'running',
    startedAt: d.startedAt, endsAt: d.endsAt, spentCents: d.spentCents, budgetCents: d.budgetCents,
    nextAt: name === 'ended' ? null : d.nextAt, checkinsDone: d.n,
    ...(name === 'ended' ? { endedReason: d.endedReason ?? null, endedAt: d.endedAt ?? null } : {}),
  } as Json;
}
const card = (name: Name, d: Data, ctx: TransitionContext): WorkRequest =>
  ({ kind: WORK.card, key: `card:${ctx.version}`, input: { id: d.id, patch: cardPatch(name, d) } as Json });

function checkIn(d: Data, ctx: TransitionContext): Outcome<IState> {
  const data: Data = { ...d, seq: d.seq + 1, nextAt: ctx.now.toISOString() };
  return {
    next: { name: 'checking', data },
    timer: null,
    work: [{ kind: WORK.checkIn, key: `checkin:${data.seq}`, input: { id: d.id, seq: data.seq, n: d.n + 1 } as Json }, card('checking', data, ctx)],
  };
}

// Its end. A Stop while a check-in runs cancels that check-in (its look's
// turn is stopped by its lease: services/durable-turn.js); an end its own
// check-in's result decided cancels nothing.
function end(s: Live, reason: EndedReason, ctx: TransitionContext, extra: Partial<Data> = {}, { cancel = false } = {}): Outcome<IState> {
  const data: Data = { ...s.data, ...extra, endedReason: reason, endedAt: ctx.now.toISOString(), nextAt: null };
  return {
    next: { name: 'ended', data },
    timer: null,
    ...(cancel && s.name === 'checking' ? { cancel: [{ kind: WORK.checkIn, key: `checkin:${s.data.seq}` }] } : {}),
    work: [{ kind: WORK.ended, key: 'ended', input: { id: data.id, reason, patch: cardPatch('ended', data) } as Json }],
  };
}

const current = (s: Live, e: Event<any>) => (e.payload as WorkResultPayload).workKey === `checkin:${s.data.seq}`;

export function botInvestigation() {
  return defineMachine<IState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Started'],
    terminal: ['ended'],
    decode: (row) => ({ name: row.state, data: row.data }) as IState,
    facts: (tx, _s, e, ctx) => readFacts(tx, e, ctx),
    authorize: {
      // Only its owner's tap starts it.
      Started: (e, f) => (e.source.kind !== 'route' ? reject('not_a_tap')
        : !f.row ? reject('no_such_investigation')
          : e.actor !== `user:${f.row.user_id}` ? reject('not_the_owner') : ok()),
      CheckInDue: (e) => (e.source.kind === 'timer' || e.source.kind === 'admin' ? ok() : reject('not_the_clock')),
      StopRequested: (e) => (['route', 'system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
    },
    transitions: {
      [NONE]: {
        Started: {
          guard: (_s, _e, f) => (f.row!.state !== 'proposed' ? reject('not_proposed')
            : f.running >= MAX_RUNNING ? reject('too_many_running') : ok()),
          to: (_s, _e, f, ctx) => {
            const r = f.row!;
            const startedAt = ctx.now;
            const d: Data = {
              id: Number(r.id), userId: Number(r.user_id), appId: Number(r.app_id),
              everyMs: Number(r.every_hours) * HOUR_MS, days: Number(r.days), budgetCents: Number(r.budget_cents),
              spentCents: 0, startedAt: startedAt.toISOString(), endsAt: endsAtOf(startedAt, Number(r.days)).toISOString(),
              n: 0, seq: 0, failures: 0, nextAt: startedAt.toISOString(),
            };
            // The first check-in at once.
            return checkIn(d, ctx);
          },
        },
        CheckInDue: { ignore: 'not_started' },
        StopRequested: { ignore: 'not_started' },
      },
      waiting: {
        Started: { ignore: 'already_started' },
        CheckInDue: {
          to: (s, _e, _f, ctx) => {
            const live = s as Live;
            const why = dueCheck(ledger(live.data), ctx.now);
            return why ? end(live, why, ctx) : checkIn(live.data, ctx);
          },
        },
        StopRequested: { to: (s, e, _f, ctx) => end(s as Live, 'stopped', ctx, { stoppedBy: e.payload.by ?? e.actor ?? null }) },
      },
      checking: {
        Started: { ignore: 'already_started' },
        CheckInDue: { ignore: 'checking' },
        StopRequested: { to: (s, e, _f, ctx) => end(s as Live, 'stopped', ctx, { stoppedBy: e.payload.by ?? e.actor ?? null }, { cancel: true }) },
        WorkSucceeded: {
          guard: (s, e) => (current(s as Live, e) ? ok() : reject('not_this_check_in')),
          to: (s, e, _f, ctx) => {
            const live = s as Live;
            const r = ((e.payload as WorkResultPayload).result || {}) as any;
            const next = afterCheckIn(ledger(live.data), r, ctx.now);
            const data: Data = { ...live.data, spentCents: next.spentCents, failures: next.failures, n: live.data.n + (next.ran ? 1 : 0) };
            if ('end' in next) return end({ ...live, data }, next.end, ctx);
            const waiting: Data = { ...data, nextAt: next.at.toISOString() };
            return { next: { name: 'waiting', data: waiting }, timer: { at: next.at, event: { type: 'CheckInDue' } }, work: [card('waiting', waiting, ctx)] };
          },
        },
        WorkFailed: { guard: (s, e) => (current(s as Live, e) ? ok() : reject('not_this_check_in')), to: (s, _e, _f, ctx) => failedCheckIn(s as Live, ctx) },
        WorkExhausted: { guard: (s, e) => (current(s as Live, e) ? ok() : reject('not_this_check_in')), to: (s, _e, _f, ctx) => failedCheckIn(s as Live, ctx) },
      },
      // Terminal: a check-in cancelled by a Stop reports nothing, and its
      // card and its end report here, changing nothing (the kernel's rule 7).
      ended: {
        '*': { ignore: 'ended' },
        WorkSucceeded: { to: (s) => ({ next: s }) },
        WorkFailed: { to: (s) => ({ next: s }) },
        WorkExhausted: { to: (s) => ({ next: s }) },
      },
    },
    // The row, as the bot's modules and its card read it.
    project: async (tx, _before, after) => {
      if (after.name === NONE) return;
      const d = (after as Live).data;
      await tx.query(
        `UPDATE homeroom_bot_investigations
            SET state = $2, spent_cents = $3, next_at = $4, started_at = COALESCE(started_at, $5),
                ended_reason = $6, ended_at = $7
          WHERE id = $1`,
        [d.id, after.name === 'ended' ? 'ended' : 'running', d.spentCents, d.nextAt, d.startedAt,
          after.name === 'ended' ? d.endedReason ?? null : null, after.name === 'ended' ? d.endedAt ?? null : null]);
    },
  });
}

// A check-in whose work failed: one more try later (an hour, at most its own
// interval), unless that was the last of MAX_FAILURES in a row.
function failedCheckIn(s: Live, ctx: TransitionContext): Outcome<IState> {
  const next = afterCheckIn(ledger(s.data), { failed: true, ran: false }, ctx.now);
  const data: Data = { ...s.data, failures: next.failures };
  if ('end' in next) return end({ ...s, data }, next.end, ctx);
  const waiting: Data = { ...data, nextAt: next.at.toISOString() };
  return { next: { name: 'waiting', data: waiting }, timer: { at: next.at, event: { type: 'CheckInDue' } }, work: [card('waiting', waiting, ctx)] };
}
