// bot-look: one look into a project's code that a person's chat with the
// Homeroom bot started (look_into, services/homeroom-bot-thread-tools/
// look-into.js). One instance per look (`look:<id>`, its row in
// homeroom_bot_looks):
//
//   (none) ──Requested──▶ looking ──its run ends──▶ done
//                            └──the run failed for good──▶ failed
//
// The look is one resumable work item, `look.run`: a read-only turn of the
// bot's in a worker, on durable steps over the item's checkpoint, so a
// restart that takes the process leaves the turn to the next one, which
// follows it to its end (services/durable-turn.js) rather than starting it
// again. Where the turn is, and whether its findings were posted, is that
// checkpoint and the look's row, not more states here (the kernel's rule 5).
// The chat that asked waits on the row for a few minutes; one that stopped
// waiting has its findings posted when the run ends (`deliver = 'post'`).
// A run that fails for good is recorded as failed, and said in that chat
// when it stopped waiting (`look.failed`).

import { NONE, appendEvent, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, Queryable, State, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'bot-look';
export const lookKey = (id: number) => `look:${id}`;
export const WORK = Object.freeze({ run: 'look.run', failed: 'look.failed' });

export interface Data { lookId: number; userId: number; requestedAt: string; endedAt?: string; error?: string | null }
type S = State<Data>;

const id = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) <= 0 || (v as number) > 2 ** 53) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const decodeRequested = (p: any) => ({ lookId: id(p?.lookId, 'lookId'), userId: id(p?.userId, 'userId') });

const runResult = (e: Event<any>) => (e.payload as WorkResultPayload).workKey === 'run';

/** Ask for look `lookId` to run: keyed by the look, so asking again is the same request. */
export function requestLook(db: Queryable, p: { lookId: number; appId: number; userId: number }): Promise<number> {
  return appendEvent(db, MACHINE, lookKey(p.lookId), { type: 'Requested', payload: { lookId: p.lookId, userId: p.userId } },
    { requestKey: `look:${p.lookId}`, appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'system', name: 'look_into' } });
}

function failed(s: S, e: Event<any>, now: Date): Outcome<S> {
  const error = (e.payload as WorkResultPayload).error;
  const d: Data = { ...s.data, endedAt: now.toISOString(), error: String(error?.message || 'the look failed').slice(0, 500) };
  return { next: { name: 'failed', data: d }, work: [{ kind: WORK.failed, key: 'failed', input: { lookId: d.lookId } }] };
}

export function botLook() {
  return defineMachine<S, null>({
    name: MACHINE,
    version: 1,
    retainDays: 14,
    events: { Requested: decodeRequested },
    create: ['Requested'],
    terminal: ['done', 'failed'],
    decode: (row) => ({ name: row.state, data: row.data as Data }),
    authorize: {
      // The chat's answer (its work item) asks; an admin may ask again.
      Requested: (e) => (['system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform')),
    },
    transitions: {
      [NONE]: {
        Requested: {
          to: (_s, e, _f, ctx): Outcome<S> => ({
            next: { name: 'looking', data: { lookId: e.payload.lookId, userId: e.payload.userId, requestedAt: ctx.now.toISOString() } },
            work: [{ kind: WORK.run, key: 'run', input: { lookId: e.payload.lookId } as Json }],
          }),
        },
      },
      looking: {
        Requested: { ignore: 'already_looking' },
        WorkSucceeded: {
          guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')),
          to: (s, _e, _f, ctx) => ({ next: { name: 'done', data: { ...s.data, endedAt: ctx.now.toISOString() } } }),
        },
        WorkFailed: { guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')), to: (s, e, _f, ctx) => failed(s, e, ctx.now) },
        WorkExhausted: { guard: (_s, e) => (runResult(e) ? ok() : reject('not_the_look')), to: (s, e, _f, ctx) => failed(s, e, ctx.now) },
      },
      // Terminal states still take their work's results (the kernel's rule 7).
      done: { '*': { ignore: 'ended' } },
      failed: { '*': { ignore: 'ended' } },
    },
  });
}
