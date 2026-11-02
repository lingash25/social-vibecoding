// bot-lane: how much the Homeroom bot runs at once, and when it looks at
// GitHub. One instance (`bot`), so the caps hold however many processes run
// the workflow: at most `liveAtOnce` looks and builds in all, `perPerson`
// for any one person, one read at a time on a project's triage session,
// BUILDS_PER_PROJECT builds per project. A request owed a look tells it
// (Look); it grants slots under its lock, in the queue's order, as messages
// (Granted), and reads what is in use from the requests themselves (their
// `slot`, and grants not applied yet), so a slot is never counted from this
// process's memory nor lost with it. It also pauses every grant while the
// platform fails under the bot (a fault: 2 minutes, doubling to an hour,
// ended by a look that ran) or the bot's weekly cap is reached, and it
// keeps the refresh's clock: every five minutes, and soon after a project
// is asked for (bot.refresh: services/homeroom-bot.js refresh), with the
// loop's five-minute sweeps beside it (bot.sweep).
// workflow-foundation's design-bot-loop.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, MessageRequest, Outcome, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import {
  BOT_LANE, BOT_REQUEST, BUDGET_PAUSE_MS, LANE_KEY, REFRESH_EVERY_MS, REFRESH_SOON_MS,
  faultMs, pickLive, pickLiveBuilds, requestKey,
} from '../rules/bot-loop.ts';
import type { Slot } from '../rules/bot-loop.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = BOT_LANE;
export const KEY = LANE_KEY;
export const WORK = Object.freeze({ refresh: 'bot.refresh', sweep: 'bot.sweep' });

type Name = 'open';
export interface Data {
  // Grants so far: each grant's number, so a request's slot is told apart.
  grants: number;
  // The platform failing under the bot: no grant until `until`.
  fault: { until: string; attempts: number } | null;
  // The bot's weekly cap reached: no grant until `until`.
  budget: { until: string } | null;
  // GitHub's hourly budget nearly used up: no grant and no refresh until it
  // resets (services/github-budget.js; a look, a build's start or the
  // refresh found it so).
  github?: { until: string } | null;
  // The refresh: when the next full one is due, the projects asked for
  // since (null: all), the one under way.
  refresh: { due: string; asked: number[] | null; soon: string | null; n: number; running: number | null };
}
export type LState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<LState, { data: Data }>;

const optInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const optTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

const EVENTS = {
  // Look again: a request owed a look, a hold or a backoff ended.
  Look: () => ({}),
  // A request let its slot go (or took none): `ran` a look that ran (ends a
  // fault pause), `fault` the platform failed under it, `budget` the cap.
  // `github`: GitHub's hourly budget resets then.
  Released: (p: any) => ({ ran: !!p?.ran, fault: !!p?.fault, budget: !!p?.budget, github: optTime(p?.github) }),
  // A project to refresh soon (null: every project); `now`: at once.
  RefreshAsked: (p: any) => ({ appId: optInt(p?.appId), now: !!p?.now }),
  // Its clock: the refresh due, a pause over, a request now eligible.
  Tick: () => ({}),
};

const step = (data: Data, more: Omit<Outcome<LState>, 'next'> = {}): Outcome<LState> => ({ next: { name: 'open', data }, ...more });
const at = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms).toISOString();
const created = (ctx: TransitionContext): Data => ({
  grants: 0, fault: null, budget: null,
  refresh: { due: ctx.now.toISOString(), asked: null, soon: null, n: 0, running: null },
});
const live = (s: LState, ctx: TransitionContext): Data => (s.name === NONE ? created(ctx) : (s as Live).data);
const before = (iso: string | null | undefined, ctx: TransitionContext) => !!iso && Date.parse(iso) <= ctx.now.getTime();

// Grant what may start now, and set the clock for what comes next.
function decide(d0: Data, f: Facts, ctx: TransitionContext): Outcome<LState> {
  let d = d0;
  const work: WorkRequest[] = [];
  const messages: MessageRequest[] = [];
  if (d.budget && before(d.budget.until, ctx)) d = { ...d, budget: null };
  if (d.github && before(d.github.until, ctx)) d = { ...d, github: null };
  // The refresh: the full one due, or a project asked for whose burst has
  // settled, and none under way (nor GitHub's budget held).
  const r = d.refresh;
  const fullDue = before(r.due, ctx);
  const soonDue = r.soon && before(r.soon, ctx);
  if (f.acting && !d.github && r.running == null && (fullDue || soonDue)) {
    const n = r.n + 1;
    const apps = fullDue ? null : r.asked;
    work.push({ kind: WORK.refresh, key: `refresh:${n}`, input: { n, apps: apps as Json } });
    if (fullDue) work.push({ kind: WORK.sweep, key: `sweep:${n}`, input: { n } });
    // Whatever starts, nothing is asked for since (a full one covers all).
    d = { ...d, refresh: { due: fullDue ? at(ctx, REFRESH_EVERY_MS) : r.due, asked: [], soon: null, n, running: n } };
  }
  // Grants: none while the bot is off, paused on a fault or on its cap.
  const paused = (d.fault && !before(d.fault.until, ctx)) || (d.budget && !before(d.budget.until, ctx)) || !!d.github;
  if (f.acting && !paused) {
    const inUse: Slot[] = f.inUse.slice();
    let room = Math.max(0, f.settings.liveAtOnce - inUse.length);
    const reads = pickLive(f.reads, { inUse, slots: room, perPerson: f.settings.perPerson, raised: f.raised });
    for (const pick of reads) {
      const grant = d.grants + 1;
      d = { ...d, grants: grant };
      const kind = pick.followUp ? 'followUp' : 'read';
      const sessionId = pick.followUp ? Number(pick.follow_up_session_id) : (pick.triage_session_id == null ? null : Number(pick.triage_session_id));
      messages.push(grantTo(Number(pick.app_id), Number(pick.issue_number), { grant, kind, sessionId, person: pick.person }));
      inUse.push({ kind, appId: Number(pick.app_id), person: pick.person });
    }
    room = Math.max(0, f.settings.liveAtOnce - inUse.length);
    const builds = pickLiveBuilds(f.builds, { inUse, slots: room, perPerson: f.settings.perPerson, raised: f.raised });
    for (const pick of builds) {
      const grant = d.grants + 1;
      d = { ...d, grants: grant };
      messages.push(grantTo(Number(pick.app_id), Number(pick.issue_number), { grant, kind: 'build', sessionId: null, person: pick.person }));
      inUse.push({ kind: 'build', appId: Number(pick.app_id), person: pick.person });
    }
  }
  // The clock: the earliest of the refresh, a project asked for, the end
  // of a pause, and the next request to become eligible.
  const times = [d.refresh.running == null ? d.refresh.due : null, d.refresh.running == null ? d.refresh.soon : null,
    d.fault?.until ?? null, d.budget?.until ?? null, d.github?.until ?? null, f.nextEligible]
    .filter((t): t is string => !!t).map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && t > ctx.now.getTime());
  const timer = times.length ? { at: new Date(Math.min(...times)), event: { type: 'Tick' } } : null;
  return step(d, { work, messages, timer });
}

const grantTo = (appId: number, issueNumber: number, p: { grant: number; kind: string; sessionId: number | null; person: string }): MessageRequest =>
  ({ to: { machine: BOT_REQUEST, key: requestKey(appId, issueNumber) }, event: { type: 'Granted', payload: { appId, issueNumber, ...p } as Json }, appId });

function released(s: LState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  let d = live(s, ctx);
  const p = e.payload;
  if (p.fault) {
    const attempts = (d.fault?.attempts || 0) + 1;
    d = { ...d, fault: { until: at(ctx, faultMs(attempts)), attempts } };
  } else if (p.ran && d.fault) {
    d = { ...d, fault: null };
  }
  if (p.budget) d = { ...d, budget: { until: at(ctx, BUDGET_PAUSE_MS) } };
  if (p.github) d = { ...d, github: { until: p.github } };
  return decide(d, f, ctx);
}

function refreshAsked(s: LState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const d = live(s, ctx);
  const r = d.refresh;
  const appId = e.payload.appId as number | null;
  // Every project (a settings change): the full refresh comes soon.
  if (appId == null) return decide({ ...d, refresh: { ...r, due: at(ctx, REFRESH_SOON_MS) < r.due ? at(ctx, REFRESH_SOON_MS) : r.due } }, f, ctx);
  const asked = r.asked == null ? null : [...new Set([...r.asked, appId])].slice(0, 500);
  // Soon: once things have been quiet a while (a burst of messages is one
  // refresh), and never later than the full one; at once when asked so.
  return decide({ ...d, refresh: { ...r, asked, soon: e.payload.now ? ctx.now.toISOString() : at(ctx, REFRESH_SOON_MS) } }, f, ctx);
}

function workDone(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const p = e.payload as WorkResultPayload;
  let d = s.data;
  if (p.kind === WORK.refresh && d.refresh.running != null && p.workKey === `refresh:${d.refresh.running}`) {
    // A refresh that failed for good is tried again at the next clock.
    d = { ...d, refresh: { ...d.refresh, running: null } };
  }
  // A refresh or sweep GitHub's budget held: nothing was read; a full
  // refresh runs once the budget resets, and nothing is granted until then.
  const held = e.type === 'WorkSucceeded' ? optTime((p.result as any)?.github) : null;
  if (held && (p.kind === WORK.refresh || p.kind === WORK.sweep)) {
    d = { ...d, github: { until: held }, refresh: { ...d.refresh, due: held } };
  }
  return decide(d, f, ctx);
}

export interface Deps { staging: boolean }

export function botLane(deps: Deps = { staging: false }) {
  const any = (to: (s: LState, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<LState>) => ({ to });
  const look = (s: LState, _e: Event<any>, f: Facts, ctx: TransitionContext) => decide(live(s, ctx), f, ctx);
  const row = {
    Look: any(look), Tick: any(look), Released: any(released), RefreshAsked: any(refreshAsked),
    WorkSucceeded: { to: workDone }, WorkFailed: { to: workDone }, WorkExhausted: { to: workDone },
  };
  return defineMachine<LState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Look', 'Released', 'RefreshAsked', 'Tick'],
    decode: (r) => ({ name: r.state as Name, data: r.data as Data }),
    facts: (tx) => readFacts(tx, deps),
    authorize: {
      Look: () => ok(), Released: () => ok(), RefreshAsked: () => ok(),
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
    },
    transitions: {
      [NONE]: { Look: any(look), Tick: any(look), Released: any(released), RefreshAsked: any(refreshAsked), '*': { ignore: 'not_started' } },
      open: row,
    } as any,
  });
}

export { NO_FACTS };
