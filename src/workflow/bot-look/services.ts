// bot-look's work: the look itself, and recording one whose run failed for
// good. Both are the look's own module's (services/homeroom-bot-thread-tools/
// look-into.js): the handler hands it the work item, whose steps keep the
// turn (services/durable-turn.js), the end and the post, so a retry after a
// restart follows the turn and says nothing twice.

import { legacy } from '../legacy.ts';
import type { WorkHandler } from '../kernel/index.ts';
import { WORK } from './machine.ts';

// `deps`: what the module reaches for instead of its own (a test's fakes).
interface Deps { config: any; pool: any; deps?: any }

export function botLookServices(deps: Deps): Record<string, WorkHandler> {
  const look = () => legacy('services/homeroom-bot-thread-tools/look-into');
  return {
    [WORK.run]: {
      resumable: true,
      // A look that throws is tried once more from its checkpoint, then failed.
      maxAttempts: 2,
      maxLostAttempts: 20,
      concurrency: 16,
      leaseMs: 120 * 1000,
      run: (ctx) => look().runLookWork(ctx, deps),
    },
    [WORK.failed]: {
      maxAttempts: 5,
      concurrency: 4,
      run: (ctx) => look().lookFailed(ctx, deps),
    },
  };
}
