// bot-investigation's work: a check-in (its look, its notes, its short
// update in the chat), the card drawn from what the machine decided, and its
// end said once. Each is the investigation's own module's
// (services/homeroom-bot-thread-tools/investigate.js), handed the work item:
// a check-in keeps its look's turn, its notes and its update in the item's
// steps, so a retry after a restart follows the turn and writes and says
// nothing twice; the card and the end are idempotent writes.

import { legacy } from '../legacy.ts';
import type { WorkHandler } from '../kernel/index.ts';
import { WORK } from './machine.ts';

// `deps`: what the module reaches for instead of its own (a test's fakes).
interface Deps { config: any; pool: any; deps?: any }

// A minute, doubling, at most ten between tries.
const backoff = (attempt: number) => Math.min(10 * 60 * 1000, 60 * 1000 * 2 ** (attempt - 1));

export function botInvestigationServices(deps: Deps): Record<string, WorkHandler> {
  const inv = () => legacy('services/homeroom-bot-thread-tools/investigate');
  return {
    [WORK.checkIn]: {
      resumable: true,
      maxAttempts: 3,
      maxLostAttempts: 20,
      backoffMs: backoff,
      concurrency: 8,
      leaseMs: 120 * 1000,
      run: (ctx) => inv().checkIn(ctx, deps),
    },
    [WORK.card]: {
      maxAttempts: 5,
      backoffMs: backoff,
      concurrency: 8,
      run: (ctx) => inv().drawCard(ctx, deps),
    },
    [WORK.ended]: {
      maxAttempts: 5,
      backoffMs: backoff,
      concurrency: 4,
      run: (ctx) => inv().sayEnded(ctx, deps),
    },
  };
}
