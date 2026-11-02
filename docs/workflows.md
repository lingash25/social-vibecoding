# Workflows

Homeroom runs a number of long-lived processes: a governance proposal waits for votes and
then applies, a preview builds and runs its checks, a merge sets off a list of follow-ups.
`src/workflow/` runs them as **persistent state machines on PostgreSQL**. Each process
(an *instance*) has one row holding its state, one ordered stream of events that change
it, and one code path that applies those events. Everything it does to the outside world
is a durable work item whose result comes back as another event.

Governance proposals, a proposal's lifecycle, its preview and required checks, its
before & after shots, what follows a merge, every production deploy of an app, and the
Homeroom bot's answers to the people who speak to it run on machines whose old paths are
deleted: none has a flag, and each decides every case of its kind. The others move over
one at a time.

## What it solves

Before this, each of these processes was spread over several places that each decided a
little: the route that took the vote, a 60-second ticker, an hourly sweeper, in-memory
timers, and fire-and-forget calls after a commit. Governance proposals showed the
typical problems:

- **Decisions made outside the lock.** The vote gate was computed, then the row was
  locked and written. A vote, the ticker and an admin could race on the same proposal.
- **Side effects lost on a crash.** The GitHub close, the comment and the chat line ran
  after the commit. A restart in between dropped them, with no record that they were
  owed.
- **States nobody owns.** A proposal that could not be applied (its image gone, its key
  unwritable) stayed open forever, retried by every sweep.
- **No history.** There was no record of why a proposal was in its state, or what had
  been tried.

The workflow kernel answers each one with a rule:

| Problem | Rule |
|---|---|
| Decisions made outside the lock | One code path changes state, one event at a time, under the instance's row lock. |
| Side effects lost on a crash | External calls are durable work items, committed with the decision that asked for them. |
| States nobody owns | Every state is declared, and every (state, event) pair is either handled or explicitly ignored. |
| No history | Every event stays in the stream with its result, its reason and the state before and after. Admin → Workflows shows it. |

## The model

```
 routes ──────────┐  append an event (and wait briefly for its outcome)
 services ────────┤  append work results
 timers, messages ┤
                  ▼
            ┌───────────┐     ┌──────────────────────────────────────────────┐
            │ wf_events │ ──▶ │ pipeline slots (any number, any process)     │
            │ (stream)  │     │ one event per transaction, under the         │
            └───────────┘     │ instance's row lock:                         │
                  ▲           │ admit → replay → facts → authorise → guard →   │
                  │           │ transition → persist                         │
                  │           └───────────────┬──────────────────────────────┘
                  │                           │ work items
                  │                     ┌─────▼─────┐     ┌───────────────────────┐
                  └──── result events ──│  wf_work  │ ──▶ │ services: GitHub,     │
                                        └───────────┘     │ rebuilds, … (all I/O) │
                                                          └───────────────────────┘
```

- **Only the pipeline changes machine state.** Routes, services, timers and other
  instances *append* events to `wf_events`. Nothing else writes `wf_instances` or the
  legacy columns a machine owns, and the database enforces it (see
  [Ownership](#storage-projections-and-ownership)).
- **Serial within an instance, concurrent across instances.** A slot locks one instance
  row (`FOR UPDATE SKIP LOCKED`) and applies its oldest pending event. Other slots, in
  this process or another, skip that instance and take others. Correctness comes from the
  row lock, not from which process is the leader.
- **Transitions never wait on the outside world.** They read the database, decide, and
  write the database. Each transaction runs with a 2 s lock timeout and a 5 s statement
  timeout.
- **Everything commits together.** The new state, the domain writes (a vote row, an app's
  new name), the legacy projection, the receipt, the work items, the messages and the
  event's own result commit in one transaction, or none of them do.
- **One instance per transaction.** An effect on another instance is a *message*: an
  event appended in the same transaction and applied later, in that instance's own
  transaction. State that must change together belongs to one machine.

### Vocabulary

| Term | Meaning |
|---|---|
| **Machine** | The code for one kind of workflow, such as `governance-proposal`: states, events, transitions, writes, projection. |
| **Instance** | One occurrence, such as `governance-proposal` / `issue:42`. One row in `wf_instances`, with its state, data, version and at most one deadline. |
| **Event** | A data-only request to change an instance (`VoteCast`, `Withdraw`). It has a type, a payload, a source, an actor and a request key. |
| **Source** | Who produced the event: `route`, `service`, `timer`, `message`, `admin` or `system`. |
| **Request key** | Identifies the request behind an event, so a retry is recognised as the same request. |
| **Facts** | What a transition reads from the database inside its transaction: the issue row, vote counts, settings. |
| **Guard** | A pure check that accepts the event or rejects it with a reason, such as `not_open` or `reason_required`. |
| **Outcome** | What a transition returns: the next state, plus writes, work, messages, a timer and pushes. Nothing runs after it commits. |
| **Push** | What browsers should hear, published in the transition's transaction. Every web process relays it to its sockets once the transaction commits, whichever process decided. |
| **Work item** | A durable request for I/O, run by a service. Its result returns as an event. |
| **Projection** | The legacy columns (`issues.status`, audit fields in `issues.payload`) written from the machine's state in the same transaction, so existing readers keep working. |

## The life of an event

**Producing.** `runtime.append(machine, key, { type, payload }, { requestKey, source,
actor, appId })` decodes the payload against the machine's declared events, inserts one
row into `wf_events` and notifies the slots. An undeclared type is refused right there
(`unknown_event`). A route that needs an answer calls `appendAndWait`, which waits up to
3 s for the outcome. If the outcome is not there yet, the route answers `202` with the
request key, and a retry with the same key returns the original result once it exists.

**Answers.** A route answers from the outcome's `reply`, never by reading the tables
afterwards. A machine that answers routes defines `reply(tx, event, after, ctx, facts)`:
- **When it runs.** In the event's transaction, after the writes and the projection. It
  gets the facts the transition decided on, so an answer they already hold needs no
  query.
- **Where it is stored.** With the event and its receipt.
- **On a replay.** Current application admission is checked first; an authorized replay returns the stored reply. A route that reads the
  tables later would describe today's state instead (a vote since retracted, counts
  that moved on).

**Consuming.** A free slot:

1. picks the oldest pending event that is its instance's head (the instance's oldest
   pending event), not in backoff, of an instance that is not faulted;
2. locks the event, skipping any another slot holds (`SKIP LOCKED`), then its instance's
   row, which is what keeps two slots from processing one instance at once. An event
   appended in a caller's transaction can commit after a later one, so two slots can
   hold two events of one instance; the second waits for the first's row lock, then
   reads the receipt again. An instance with no row yet first gets a placeholder row in
   the pseudo-state `(none)`, so its first events are serialised the same way;
3. leaves it alone if a newer machine version last wrote the instance (old and new code
   overlap during a deploy);
4. runs one transaction for that event:
   1. **Application admission.** The runtime's optional `authorizeEvent` checks current
      application authority on the serialized event, inside this transaction. A denial
      writes no receipt, domain change, work or message. Database errors fault the event.
   2. **Replay check.** If a receipt exists for this request key with the same payload, the
      event is `replayed` with the original outcome. Machine facts and guards are skipped.
      A different payload under the same key is `rejected: request_key_conflict`.
   3. **Facts.** The machine's read-only queries.
   4. **Authorise, then guard.** A rejection marks the event `rejected` with its reason
      and writes **no receipt**, so a later retry with the same key can still succeed.
   5. **Transition.** It returns the outcome, and the next state must be declared.
   6. **Persist,** in this order: domain writes, projection, the machine's reply, the
      pushes, work items, messages, then the instance row, receipt and the event's own
      result in one statement. A placeholder row whose event is rejected is deleted again.
5. commits, then wakes whoever waits for the outcome. Nothing else runs after COMMIT:
   the kernel has no post-commit kicks (a crash between the commit and a kick lost it),
   and a transition that returns one faults. What an event sets off is a push, work or
   a message, all committed with it.

**Platform command authority.** Production creates its runtime through
`createPlatformRuntime` in `src/workflow/event-authority.ts`. Human admin commands
carry the authenticated numeric `user:<id>` actor. Admission rereads `users` and, for
project overrides, the actual target proposal and `app_admins`; it holds share locks
through the decision's commit. A producer label or a username grants no permission.
Project admins keep their existing powers on their own project, with protected changes
and fleet campaigns restricted to full platform admins. Shots waivers also retain the
project creator's management power. Faulted-instance release uses the same check.
Internal cleanup reports itself as `system`, not as a human admin. The HTTP permission
checks remain necessary: ordinary commands still depend on their callers and their
machine's rules. Admission does not cancel external work already authorized and queued.

This admission boundary does not authenticate an arbitrary process that can forge
actors or write workflow rows. `PROCESS_ROLE` separates loops, not credentials; database
login privileges, migration/provisioning credentials and Kubernetes service accounts
need independent isolation. All deciding processes must run the updated code before a
new admission rule applies across the fleet.

**Pushes.** What browsers should hear is part of the transition. A transition returns
`push`, and a domain write adds what it inserted with `ctx.push` (a thread line with its
id). `src/workflow/pushes.ts` shapes them as `services/ws.js`'s helpers do. The runtime's
`publish` (`platform.ts publishPushes`) sends each one with `pg_notify` on the WebSocket
bus's channel before `COMMIT`, so it is heard only if the transition commits. The
sender is `workflow` (`services/ws-bus.js WORKFLOW_SENDER`), so every web process relays
it, the one whose slot decided included. No machine calls into web code to reach a
browser. What `ws.js`'s push helpers also kick in the process that calls them rides
the push or its statement:
- **the Workshop's board-change reaction**: a push marked `routing.boardChange`
  (`pushes.ts boardMoved`) is handed to the Workshop's listener in every web process
  that relays it (`ws.js _onBusMessage`): each owes the app a pass on its row
  (`app_workshop_themes.reconcile_due_at`, due 30 s after the first change, so a second
  relay changes nothing), and the `workshop-changes` clock runs each pass due as a
  target: the pass claims the row (its due moved ten minutes on, so a pass its process
  died in is owed again then), and takes itself off only if no change came meanwhile (a
  change pulls a claim back to its quiet period);
- **the phone badge sync**: everyone a push tells `notifications_changed` is owed a
  re-badge, a row of `mobile_push_badge_syncs` written in the same statement as the
  pushes (`publishPushes`, where phone push is on) and drained by the push sender,
  coalesced per person (`mobile-push-worker.js drainBadges`).

Delivery is at most once, as a WebSocket broadcast always was, with two differences
from a push helper called in the deciding process:
- every process, the deciding one included, hears it through its own `LISTEN`
  connection; while that connection is down its sockets miss it, and get the resync
  nudge when it is back (a client also resyncs after its own reconnect);
- a push over the NOTIFY budget becomes the resync nudge for every socket, the deciding
  process's included.

A notification is named, not carried: the transition pushes its id
(`notification_new` with `notificationId`), and the relaying process reads it for the
recipient's open tabs, so the bell's query never runs in the transition.

**Round trips.** A producer waits on every query of the transaction, so the kernel keeps
its own to three: one batch opens the transaction and picks (`BEGIN`, the writer marker,
the timeouts, the pick with its receipt and the clock), one statement records the
outcome, then `COMMIT`; a transition with pushes adds one statement that publishes them. A route registers for the outcome's notification before it
appends, so it reads the outcome once, when it is there. The rest is the machine's: keep
its facts to as few queries as the rules allow, and fold a write and what goes with it
into one statement. `tests/workflow-query-budget-postgres.test.js` counts the queries of
a governance vote and fails above its budget.

A failed event (a timeout or a throw) rolls back whole. Its failure is recorded in a
transaction of its own, after locking the event again and checking it is still the one
the slot saw.

Every event ends with one of these results: `accepted`, `rejected` (with a reason),
`replayed` or `faulted` (with the error).

## Work items and services

A transition asks for I/O as data, for example
`{ kind: 'github.closeIssue', key: 'close', input: { owner, repo, number, comment } }`.
The work row commits with the decision. Re-emitting the same `key` on the same instance
creates nothing new.

A service is a `WorkHandler` registered for a kind:

```ts
'github.closeIssue': {
  maxAttempts: 5,                        // default 5; an error with `permanent: true` is not retried
  async run({ input, resumeFrom, checkpoint, signal }) {
    if (!resumeFrom?.closed) { await closeIssue(input); await checkpoint({ closed: true }); }
    await comment(input);                // a retry after the checkpoint never closes twice
    return { closed: true };
  },
}
```

- **Claim.** A service loop claims work with `FOR UPDATE SKIP LOCKED` and a lease (60 s by
  default, renewed while it runs). If the lease is lost, the handler's `signal` aborts and
  the attempt reports nothing. The next claim resumes from the last checkpoint.
- **Concurrency.** A handler's `concurrency` (default 4) is how many items of its kind run
  at once **across every process**, counted under the kind's claim lock: replicas add
  failover, not more at once (Running it).
- **A release's own work.** A handler marked `ownRelease` is claimed only by a process of
  the release its input names (`input.release`, the runtime's `release` option): an older
  build still running during a rollout never runs a newer build's work (the `release`
  machine's adoptions).
- **A lapsed lease.** An attempt whose item is claimed again on a lease that ran out with
  no word from its process is closed `lost` with code `lapsed`; a graceful stop (`stopped`)
  and a cancel (`cancelled`) say so. A process that cannot renew stops the handler itself
  three quarters of a lease after its last renewal.
- **A move nobody decided in time.** An event its caller stopped waiting for can be
  refused at once (`refuseIfPending`, under the event's row lock, so one a slot is deciding
  keeps its answer): platform.ts does so for every move with a deadline, so a route that
  says "nothing changed" is right, and the move is never applied after that.
- **Report.** The service appends a result event to the owning instance, with `workId`,
  `kind`, `workKey`, `attempt` and the result or error:
  - `WorkSucceeded` when the handler returns;
  - `WorkFailed` at once for an error marked `permanent: true`;
  - `WorkExhausted` when the attempts run out. Until then, any other error is retried
    with backoff.

  The instance decides what each result means.
- **Settle.** The pipeline settles the work row in the same transaction that applies the
  result. A result the instance no longer expects is rejected (`stale_result`) and still
  settled.
- **A lease does not fence the outside world.** An earlier attempt may still be running,
  so handlers checkpoint before creating anything and treat "already done" (a 404 or 410
  on a close) as success.
- **A retry the machine asks for keeps the progress.** A work request may name an earlier
  item of the same kind with `continues: '<work key>'`. The new item then starts from that
  item's last checkpoint, so a manual retry of a close that already commented does not
  comment again. Without `continues`, a new key starts fresh.
- **Steps within one item.** A long handler (a sync with main, a shots agent's turn, a
  Homeroom bot build) keeps what it has done in the item's checkpoint with `ctx.steps()`
  (`kernel/steps.ts`): `once(key, fn)` runs a step one time across attempts, `fence()`
  throws once the item is no longer this process's, and a failed save is tried again within
  the attempt. There is no other place durable work keeps anything. Code the kernel does
  not run gets the inert steps of `services/durable-steps.js`, where every step just runs.
- **An event can cancel work it made obsolete.** An outcome's `cancel: [{ kind, key }]`
  settles those items of the instance as cancelled in the event's transaction (`result`
  gains `cancelled: true`):
  - a queued item never runs;
  - a running item loses its claim, so its `signal` aborts at the next lease renewal
    (within a third of the lease) and it reports nothing;
  - an item that already reported has its result refused (`work_cancelled`).

  The kernel stops nothing outside the database. A build or Job the item started is
  cleaned up by the machine's own work (the preview machine's `checks.cancel`).

## Timers and messages

- **Timers.** An instance has at most one deadline. An outcome sets it
  (`timer: { at, event }`), clears it (`null`) or leaves it alone (`undefined`). A timer
  loop appends the stored event when the deadline passes, with request key
  `timer:<version>`, so a deadline fires at most once per instance version. The
  governance machine uses it for the vote window and for a 10-minute backstop that
  catches changes no event announces, such as the electorate shrinking.
- **Messages.** `messages: [{ to: { machine, key }, event }]` appends events for other
  instances in the same transaction, with `caused_by` pointing at the cause. They cannot
  be lost and cannot deadlock. They arrive in order per target, and a rejection shows on
  both timelines. A domain write may add one with `ctx.message`, for an instance whose key
  only it knows: the row it has just inserted (the governance apply's campaign, a
  campaign's proposal). It commits with the event like any other.

## Failures

| What happens | Where it shows | What to do |
|---|---|---|
| **Lock or statement timeout, serialisation failure, deadlock** | The event goes back to pending with a backoff. After 5 in a row the instance is flagged `stalled`. | Usually nothing: it clears when the contention does. |
| **The transition throws** (a bug, a broken invariant) | The event is `faulted` with the error, the instance is flagged `faulted`, and its later events are `held`. Every other instance keeps going. | Fix the cause, then in Admin → Workflows **release** the instance: *retry* the faulted event, or *skip* it. |
| **Work exhausts its attempts** | The instance receives `WorkExhausted`. The problems panel lists it. | The machine decides. For governance, an admin can retry a follow-up. |

Machine code gets a query-only transaction handle. It cannot `BEGIN`, `COMMIT` or
`ROLLBACK`, and a query error that the machine code catches and ignores still fails the
event.

## Admin → Workflows

`#admin/workflows` (`frontend/src/features/admin/admin-workflows.tsx`, backed by
`src/routes/admin-workflow.js`) shows:

- **Problems first:**
  - faulted or stalled instances, with their held events;
  - work that is exhausted or overdue;
  - instances in a state their machine names as waiting on something outside (its
    `attention`, with the words shown beside it): a merge GitHub has not answered.
- **Counts per machine and state.**
- **An instance list,** which can be filtered.
- **One instance's timeline:** every event with its source, actor, result, reason, the
  transition it made, its cause and what it emitted, plus its work items and the state
  data.
- **Actions** (full admins, runtime running). The admin view never edits rows. Each
  action is an event on the timeline, like any other:
  - release a faulted instance;
  - "Re-check now" (`Evaluate`);
  - "Apply" (`AdminApply`);
  - "Retry follow-up".

## Storage, projections and ownership

All of it is in `src/db/schema.sql`. The tables are `staging:private`.

| Table | Holds |
|---|---|
| `wf_instances` | One row per instance: `state`, `data`, `version`, `machine_version`, the deadline, the `faulted` / `stalled` flag. |
| `wf_events` | The stream and, once processed, each instance's history. |
| `wf_receipts` | Outcomes of accepted requests, for replay. |
| `wf_work`, `wf_work_attempts` | Work items and each attempt at them. |
| `wf_settings` | Settings the triggers read: `enabled:<machine>`, written at every boot. |

**Retention.** The pipeline purges every hour:
- processed events after 90 days;
- settled work after 90 days;
- receipts 30 days after their instance ends.

A machine whose history is mostly a clock's ticks keeps less (its definition's `retainDays`):
the `clock` machine keeps a week.

Instances keep their latest state indefinitely.

**Projections.** Existing readers (API, frontend, `dapp.json` checks) keep reading the
legacy columns. The machine's `project` writes them in the transition's transaction, so
they cannot drift from the instance.

**Ownership.** Every pipeline transaction runs `SET LOCAL app.wf_writer = 'transition'`.

- **Kernel tables.** Triggers refuse writes to them made without that marker.
- **Legacy columns.** A machine claims the legacy columns it owns with
  `wf_guard_owned_columns()`, for example on `issues`:

  ```sql
  CREATE TRIGGER issues_wf_governance_owned BEFORE UPDATE ON issues FOR EACH ROW
    WHEN (OLD.kind IN ('secret_change', 'rename', ...))
    EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=governance-proposal/issue:', 'status',
      'payload.appliedAt', 'payload.appliedBy', 'payload.withdrawnAt', 'payload.supersededAt');
  ```

  - A write from anywhere else is refused (`WF_OWNERSHIP_VIOLATION`), so a forgotten
    writer fails, in a test or in production.
  - The `@enrolled=` argument limits the guard to rows that have an instance, and only
    while `wf_settings` has `enabled:<machine>` (every boot writes it for every machine;
    a database nothing has booted on yet has none).
  - The `@enabled=<machine>` argument guards every row the trigger's `WHEN` selects,
    enrolled or not. merge-followups uses it for the move of a proposal into `merged`,
    which is what enrolls the row:

    ```sql
    CREATE TRIGGER chat_sessions_wf_merged BEFORE UPDATE ON chat_sessions FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM 'merged' AND NEW.status = 'merged')
      EXECUTE FUNCTION wf_guard_owned_columns('@enabled=merge-followups', 'status');
    ```

## Writing a machine

A machine is a folder under `src/workflow/<machine>/`:

| File | Holds |
|---|---|
| `machine.ts` | The definition. |
| `facts.ts` | Its reads. |
| `services.ts` | Its work handlers. |

**Its decisions' own code lives in `src/workflow/rules/`** when the code not migrated yet
uses it too: the merge gate and the electorate, the governance kinds, platform variables and
the encryption helper, the merged line's credits, bounties, notification preferences and the
merged notification. Each is one copy: the old module imports it back under its old name
(`services/governance.js` re-exports `computeGate`). A file in `rules/` imports only `node:`
built-ins and other `rules/` files, because old modules `require` it at load. It is held to a
transition's limits (no state, timers, hooks or outside I/O), and a function that throws
where its old copy swallowed keeps a never-throw wrapper on the old side.

`src/workflow/governance-proposal/` is the reference. The definition is a plain object
that `defineMachine` validates once and turns into `Map`s:

```ts
defineMachine<State, Facts>({
  name: 'governance-proposal',
  version: 1,                         // bump when the shape of `data` changes
  events: { Filed: decodeFiled, VoteCast: decodeVote, ... },   // decoder per event type
  create: ['Filed'],                  // events that may create the instance
  terminal: ['applied', 'refused', 'withdrawn', 'superseded'],
  decode: (row) => ({ name: row.state, data: row.data }),
  facts: (tx, state, event, ctx) => readFacts(tx, ...),
  authorize: { VoteCast: (e) => (e.source.kind === 'route' ? ok() : reject('not_the_voter')), ... },
  transitions: {
    '(none)': { Filed: { guard, to } },                 // the instance does not exist yet
    open: { VoteCast: { guard, to }, Filed: { ignore: 'already_filed' }, ... },
    applied: { '*': { ignore: 'not_open' }, WorkSucceeded: { guard, to }, ... },
  },
  writes: { vote: writeVote, chat: writeChat, apply: applyKind },   // named domain writes
  project: async (tx, before, after) => { /* UPDATE issues ... */ },
  reply: async (tx, event, after) => ({ result: ... }),   // the routes' answer, replayed as recorded
});
```

`defineMachine` refuses a definition where:
- a state neither handles nor ignores one of the machine's events (`'*'` ignores the
  rest);
- an event has no `authorize` rule;
- a table names an undeclared event;
- a terminal state or a creating event is not declared.

A type the machine does not declare, including inherited names such as `toString`, is
always `unknown_event`.

**Rules:**

1. **Transitions are pure.** They take `(state, event, facts, ctx)` and return an outcome.
   They make no I/O and do not read the clock: use `ctx.now`, the transaction's time.
2. **Facts are cheap, bounded, indexed queries.** Lock a row with `FOR UPDATE` when
   something outside the machine can still decide it (the governance machine locks its
   issue row).
3. **External I/O is work, and its result is an event.** Anything a person or another
   system relies on (a GitHub call, an email, the next merge) is work or a message.
   What browsers hear is a push. Nothing runs after the transition commits:
   `defineMachine` refuses `notifiers`, and an outcome with `notify` faults.
4. **A machine relies only on what `src/workflow/setup.ts` sets up.** That is the
   configuration and the clients of outside services every process running the
   machines makes at boot (activity mail, the account-deletion guard on workers, the
   phone push sender, GitHub, the model); `server.js` runs it, and so does the
   two-process tests' child. Nothing only the web server has (its sockets, the
   Workshop's board-change listener) may be needed:
   a machine relying on one fails its two-process tests.
5. **States are phases a person would recognise.** I/O progress belongs in the work
   item's checkpoint, not in more states.
6. **Rejection reasons are stable snake_case codes.** They appear in the admin view and in
   API answers.
7. **Terminal states still accept work results,** so follow-ups can report after the
   instance has finished.
8. **One instance per transaction.** Reach other instances with messages.
9. **A machine replaces its old paths.** The step that moves a flow onto a machine
   deletes the old flow in the same change: no flag, no second path. Rollback is a
   release revert.

**Wiring it in.** `src/workflow/platform.ts` owns the process's runtime: its own pool,
the machines, the services and the boot backfill. It also exports the helpers routes
call (`voteOnProposal`, `withdrawProposal`, …), which map outcomes and rejection reasons
to HTTP answers. Routes keep their request checks (session, membership, input), then
append and answer with the outcome.

## Running it

**Where it runs.** On Kubernetes the workflow runs on the conductor
(`PROCESS_ROLE=conductor`, docs/plans/web-and-conductor.md), in as many replicas as the
chart runs (two in production). No process leads: every replica runs the same work, under
the workflow's leases and locks. The web Pods only append and wait. Locally, in docker-compose and on a staging preview, one process (`all`)
does both.

- **Every process** turns every machine's ownership guard on at boot (`enabled:<machine>`
  in `wf_settings`, `startWorkflow` in `server.js`). A process whose runtime fails to
  start exits. It also starts the runtime on its own pool (`application_name`
  `homeroom-workflow`), registers every machine, and listens for outcomes so routes can
  wait for them.
- **A web process decides nothing.** It runs no pipeline slot (`WF_SLOTS` defaults to 0 by
  role, config.js). A route appends its event and waits for a conductor's outcome
  (3 to 8 seconds); when none comes in time it answers retryably: `202` with the request key,
  or, for a move with a deadline (resume, pause, unpromote, reopen), `503` with
  `Retry-After` and `code: 'not_decided'` (`session-lifecycle.answerNotDecided`), since such
  a move is refused as `expired` when it is decided late and so changes nothing.
- **A process that runs the workflow** (a conductor, or `all`;
  `process-role.runsWorkflow`) starts its loops once it listens and its bus is up
  (`startWorkflowLoops` in `start()`): pipeline slots, the timer and retention loop, and the
  service loops. The work it claims calls its own port (the bot's platform tools,
  `services/mayor/mcp-shim.js`) and pushes over the bus. A failure to start them ends the
  process. Its last step appends `Booted` to the `release` machine (below).
- **Any number of them at once.** Events are taken `SKIP LOCKED` and applied under the
  instance's row lock; timers fire under `SKIP LOCKED` with keyed events; work is claimed
  under a lease. A kind's `concurrency` holds **across every process**: a claim takes the
  kind's try-lock (another process claiming the kind is skipped, never waited for), counts
  the items running on a live lease anywhere, a draining process's included, and claims
  at most the rest. A full kind costs no claims until an item of it ends (`finish`
  notifies `wf_work` with its kind) or its earliest lease end. Replicas therefore add
  failover, not concurrency. The retention purge runs in one process at a time.
- **A work item that keeps taking its process down** is held back by its own lease: a
  lease that lapses with no word from its process (it died, hung or lost the database) is
  claimed again only once it has run out, and the attempt is recorded as `lapsed` (a stop
  or a cancel says so instead). Nothing ends an item for it beyond `maxLostAttempts`; the
  metrics report the most lapses of one item in the hour, and an alert fires at three.
- **A process that cannot reach the database** stops its own running work once three
  quarters of a lease pass without a renewal, before another process may claim it, so two
  replicas never run one item side by side.
- **A process lost with its node** gives its locks up within about 40 seconds: the
  runtime's sessions carry the server keepalives (`services/db-locks.js`
  `SERVER_KEEPALIVE`), and an idle-in-transaction timeout of 30 seconds (`deadPeerOptions`
  in platform.ts).
- **What a release owes what an older one left** (open governance rows, sessions the
  proposal machine does not hold, claims with no clock, merge queues, the platform's own
  faults, the bot lane's clock) is the `release` machine's: `release:<GIT_SHA>`, one
  `release.adopt` work item per release, run by whichever process of that release claims it
  (never an older build's), each adoption a step. So is what the cluster runs for every app as
  this build says (the shared hosted-asset backend) and the bench suites from this build's
  definitions, on no staging preview.
  Booting waits for none of it. A release none of whose processes took it within 10 minutes
  (it was replaced first) is `abandoned`, and the next release adopts what is left; one whose
  processes live while its work waits out a retry is waited for. A route that meets an open row the machine does not hold enrolls it itself,
  and a session's insert enrols it in the proposal machine (`wf_enrol_proposal`, a trigger on
  `chat_sessions` that appends `Adopted` in the insert's own statement).
- **The platform's scheduled jobs** (retention, probes, digests, the push sender, title heal,
  Workshop themes, the challenge scorer, and what is read about previews and proposals from
  outside: runtimes, GitHub, the mirrors) are the `clock` machine's: one instance per job,
  each run a work item at most one at a time across every process, armed by the release's
  work and on no staging preview (below).
- **A Pod a release replaced** quiesces its runtime as it starts draining
  (`quiesceWorkflow`: no slot, timer or claim) and keeps running the work it had
  claimed, its leases renewed, until it ends or the drain does
  (docs/plans/draining-releases.md). Its items keep counting against their kinds' limits.
- **Waking.** Each `wf_events` notification wakes one slot in each process. Idle loops
  sleep until a notification, the next thing they know is due (an event's backoff, a
  deadline, a work item), or a 30-second fallback; nothing polls every second. A
  transition that sets a deadline announces it on `wf_timer` with the time, in the
  statement that ends the event. The timer loop wakes only for a deadline earlier than
  the one it sleeps until, so a vote that re-arms the 10-minute backstop costs it
  nothing. The fallback only covers a lost notification.
- **A staging preview** never stands for election and runs the loops itself. A
  preview has no GitHub credentials and no app fleet, so its work items fail and show in
  Admin → Workflows, where [main]'s inline calls only failed in the logs.

Which process runs a decision or a work item decides nothing: row locks and leases do.
What the machines' work handlers still reach in process memory would: a restart
erases it, and a machine resumes its work right after a boot, when memory is empty.
Every place a machine calls into code outside the workflow is reviewed, per machine, in
`tests/baselines/workflow-process-state.json` (below), and nothing unreviewed is left.

### What the machines still depend on (the list)

`tests/lib/workflow-boundary.js` reads each machine's code (`src/workflow/<machine>/`, the
shared workflow modules it imports, `platform.ts` for the routes' side, the kernel) and
lists, per part (transitions and domain writes, work handlers), the boundary
between it and the code not migrated yet:
- each place its code names code outside `src/workflow/` (`uses`), as written there:
  `legacy('services/x').fn` is `uses src/services/x.js:fn`, a module handed on whole is
  `(whole module)`, a member chosen at run time is `[computed]`, a dynamic `import()`
  counts too;
- what its own code does that the part may not: module state that changes after load,
  timers, process listeners, and outside I/O from a transition;
- each table a work handler's own code writes;
- each other writer of a column the machine owns: SQL anywhere under `src/` that
  updates it (an `INSERT … ON CONFLICT DO UPDATE` included), and triggers that assign it
  on an update (schema.sql's ownership triggers). A SET list built from a named fragment
  (`${INVALIDATE_SQL}`, `${invalidateHeadMoveSql(…)}`) is read with the fragment's own
  columns; one built at run time is "dynamic", counted as writing every owned column, so
  a SET list is written out in full (a `CASE` on a flag keeps a column as it was). A write
  that leaves the guarded rows alone by what it says itself is not another writer: one
  that excludes the rows the machine holds with the guard's own predicate
  (`NOT wf_holds('<machine>', '<key prefix>' …)`, or the column set to itself where it
  holds the row), one pinned to a kind the guard's `WHEN` does not cover, and one that
  only ever sets another value than the move an `@enabled` guard owns. A trigger on
  `INSERT` only fills a row no machine holds yet, which no guard covers.
- a workflow module outside a machine's folder (`github-work.ts`) is read with the role
  of the part that imports it: a work handler's I/O, or a transition's.

It reads only the text, never what lies behind a call: the two-process and restart
tests (below) show that. Transitions are held to the strictest form of it: a step moves
the helpers its transitions use into the machine's own code, so that `decider | uses`
reaches zero, and nothing outside the workflow code runs inside a transaction.

**The list is empty.** `tests/baselines/workflow-process-state.json` holds only what was
reviewed, each with its reason, and `tests/workflow-process-state.test.js` fails on
anything else (a new call, another writer of an owned column, module state, a timer):
- `allowed`: the kernel's own timers, the bot-build machine's build pipeline, and the
  routes' side's wiring in `platform.ts` (the runtime handle, its pool and its dead-peer
  settings, and the logger, set once at boot and deciding nothing);
- `io`: a work handler's **I/O core**, a function outside `src/workflow/` that does the
  work's I/O and keeps no process memory: cut out of the per-process wrapper the old flow
  ran it through (the build without `_stagingBuilds`, the checks run without its seat, the
  close watcher without its polls), reading governance, a teardown or who works on a
  session from Postgres rather than from a cache, a registry or a hold of this process;
- nothing is handed off: the last two hand-offs (the sync with main's turn and the shots
  agent's turn) left with step 9, which put every turn workflow work starts on durable
  presence ([Turns workflow work runs](#turns-workflow-work-runs)). The test refuses a
  `handOff` section.

An entry that is gone fails until it leaves the list (`node tests/lib/workflow-boundary.js
--shrink`, which never adds anything; with no flag the script prints what is not
reviewed, `--all` everything).

### In production (Kubernetes)

- **The workloads.** The `social-vibecoding` Deployment serves people (`PROCESS_ROLE=web`,
  `platform.replicas`) and appends workflow commands without running their loops; the `social-vibecoding-conductor` Deployment
  runs the workflow (`platform.conductor.replicas`, two in production), deployed by Argo
  CD from the Helm chart in `deploy/helm/` with values from the infra repository. The
  conductor's replicas spread across nodes, and its PodDisruptionBudget lets a node drain
  evict one at a time.
- **During a rollout.** Each Deployment rolls `maxSurge: 1, maxUnavailable: 0`: a new
  conductor is Ready, its loops running, before an old one drains, so the workflow never
  stops. Nothing is elected (`PLATFORM_LEADER_LOCK` now only serializes a boot migration
  where one runs: `services/db-locks.js`).
- **Schema.** The `wf_*` tables and triggers come from `schema.sql`. The chart's
  migration Job applies it before the Deployment rolls.
- **Connections.** The runtime's pool adds `WF_POOL_MAX` connections per Pod, beside the
  main pool's `DB_POOL_MAX` (`platform.conductor.dbPoolMax` on a conductor).
- **Alerts.** The conductors serve the workflow's metrics on `WF_METRICS_PORT`
  (`src/workflow/metrics.ts`), which a PodMonitor scrapes and a PrometheusRule alerts on
  (docs/kubernetes-operations.md, "Workflow alerts").

| Variable | Default | Set in production by | Meaning |
|---|---|---|---|
| `WF_SLOTS` | 4 where the workflow runs, 0 in a web process (1 on a staging preview) | the default | Pipeline slots in each process. |
| `WF_POOL_MAX` | 10 where the workflow runs, 2 in a web process or on a staging preview | the default | Connections in the runtime's own pool, the outcome listener's included. Keep it above `WF_SLOTS`. |
| `WF_METRICS_PORT` | unset: no metrics | the chart, on the conductor (`platform.conductor.metricsPort`) | The port the workflow's metrics are served on (`GET /metrics`). |

**Where the variables are set.**
- **The Helm chart.** A Kubernetes Pod gets only the variables the chart lists, so a
  variable an operator needs to change is a chart value.
- **`platform_env`.** All of them are also declared in `dapp.json`'s `platform_env`, as
  the platform requires of every variable it reads. Values stored through the Platform
  variables panel only ever reached the retired VPS deploy.

**No flags.** Every machine is the only path for what it decides: its guards are on in
every process, and refuse a write from outside it. Rolling a step back is reverting its
release (`docs/kubernetes-operations.md`).
- **The rolling deploy.** While old and new Pods overlap, an old one may still decide a
  row the machine also decides. Both sides lock the row, so whichever commits first wins
  and the other stands down. The machine ends such an instance `superseded`
  (`closed_outside`). While no conductor runs, routes answer `202` with the request key:
  the event is recorded and applied once one does. A machine whose new version changes
  what an instance means raises its `version`: an old Pod leaves the instances a newer
  version wrote alone.

## TypeScript

`src/workflow` is plain TypeScript run directly by Node's type stripping (Node 22.18+ or
24). There is no build step and there are no generated `.js` files.

- **Module format.** The folder is ESM (`src/workflow/package.json`), and imports name
  their `.ts` extension.
- **Allowed syntax.** Only erasable syntax: no enums, no namespaces, no parameter
  properties.
- **CommonJS interop.** CommonJS code loads it with `require('./src/workflow/platform.ts')`.
  In the other direction, workflow code reaches CommonJS services through
  `legacy('services/…')` (`src/workflow/legacy.ts`).
- **Checks.** `npm run check:types` type-checks it against `tsconfig.server.json`.
  `tests/workflow-types.test.js` pins the setup, including the Node version of every
  Docker stage.
- **Collections.** Lookup tables are `Map`s and `Set`s, never plain objects indexed by
  string. A plain object is fine as authoring syntax (converted once, as `defineMachine`
  does) and for JSON data.

## Testing

| Suite | Covers |
|---|---|
| `tests/workflow-kernel-postgres.test.js` | The kernel's guarantees (K1–K20) against real PostgreSQL. |
| `tests/workflow-kernel-machine.test.js` | Definition validation. |
| `tests/workflow-governance-postgres.test.js` | The governance machine, one subtest per guarantee (G1–G13), plus the rollout cases. |
| `tests/workflow-governance-routes-postgres.test.js` | The routes with the runtime on. |
| `tests/workflow-governance-services.test.js` | The governance work handlers. |
| `tests/workflow-proposal-postgres.test.js` | The proposal machine, every move from every state it can be made in, against real PostgreSQL. |
| `tests/admin-workflows.test.js` | The admin section. |
| `tests/workflow-process-state.test.js` | The list of what the machines still depend on only shrinks. |
| `tests/workflow-boundary.test.js` | The boundary check's rules, on a small source tree of its own. |
| `tests/workflow-bot-replies-postgres.test.js` | The Homeroom bot's reply machines (`bot-voice`, `bot-dm`), one subtest per rule, with their work faked. |
| `tests/workflow-main-check-postgres.test.js` | The main-check machine, one subtest per rule (a provisional first red, flakes, a confirmed red, rechecks, Resume, a superseded run, a run carried on after a crash, a pause no instance holds lifted by Resume). |
| `tests/app-teardown-mark-postgres.test.js` | An app's teardown is marked on its row, which a deploy in any process reads. |
| `tests/workflow-processes-postgres.test.js` | Each machine's flows with every decision and work item in a child process, the test process being the web side (no pipeline slot, as a web Pod); the same flows with the child killed (SIGKILL) mid-item, restarted, and compared with an uninterrupted run; and two children at once. The child is server.js itself, booted as a conductor (`tests/lib/workflow-child.js`), so its bus, its process row and its listener are production's. Only outside services are faked (`tests/fixtures/workflow-outside-fakes.js`); the harness is `tests/lib/workflow-processes.js`. |
| `tests/workflow-release-postgres.test.js` | The release machine: a release's adoptions run once between its processes, a failed step is tried again without the done ones, adoptions that keep failing are shown. |
| `tests/workflow-dead-peer-postgres.test.js` | The runtime's sessions reap a dead peer and an abandoned transaction. |
| `tests/workflow-metrics.test.js` | The metrics a conductor serves, and that every metric an alert rule names is served. |

The kernel guarantees cover:
- replay;
- no partial commit;
- fault isolation;
- timeouts;
- leases;
- bounded retries;
- message order;
- timers;
- two processes running at once;
- a kind's limit across processes, and no claims while it is full;
- a lapsed lease recorded and ending nothing; a process that cannot renew stops itself;
- an event refused once its caller gave up on it, never applied later;
- the mixed-version rule;
- ownership.

The PostgreSQL suites create a throwaway database. Set
`TEST_DATABASE_URL=postgres://…` to run them; without it they skip.

A new machine brings the same two layers:

- **One subtest per guarantee** it promises, against real PostgreSQL.
- **A route test** that goes through the running runtime.

## Machines

| Machine | Instance | States | Status |
|---|---|---|---|
| `governance-proposal` | `issue:<id>`, for the five governance kinds (rename, secret change, close issue, maintenance campaign, featured illustration) | `open` → `applied` / `refused` / `withdrawn` / `superseded` | On everywhere; its old paths are deleted |
| `merge-followups` | `session:<id>`, for each merged proposal and each change that went live inside one | `delivering` → `live`, or `deploy_failed` → `live` | On everywhere; its old paths are deleted |
| `app-delivery` | `app:<id>`, for each app a deploy was asked for, main moved for, or that was reported down | `idle` ⇄ `deploying`, `idle` ⇄ `healing` | On everywhere; its old paths are deleted |
| `app-creation` | `app:<id>`, for each project made since (its row's insert enrols it) | `setting_up` → `deploying` → `running` / `awaiting_secrets`; `failed` (⇄ `setting_up` on a Retry); `waiting` for a row an older build makes | On everywhere; its old paths are deleted |
| `preview` | `session:<id>`, for each proposal with a preview, a checks run or work recorded on it, and each App bench studio preview | `idle`, `preparing`, `checking`, `deferred`, `settled`, `failed`, `retiring` → `retired` | On everywhere; its old paths are deleted |
| `shots` | `session:<id>`, for each proposal that declares visible changes or whose UI change owes a declaration | `undeclared`, `not_needed`, `waiting_for_preview`, `building_copies`, `waiting_for_agent`, `taking_shots`, `publishing`, `published`, `failed`, `waived`, `closed` | On everywhere; its old paths are deleted |
| `proposal` | `session:<id>`, for every session (a proposal from its start), adopted from its row by its first event | `underway` → `proposing` → `in_review` ⇄ `merging` (⇄ `unconfirmed`) → `merged`; `closed` (reopened to `underway`) | On everywhere; its old paths are deleted |
| `merge-queue` | `app:<id>`, for each app a merge was asked for | `idle` ⇄ `working` | On everywhere; its old paths are deleted |
| `campaign` | `campaign:<id>`, for each fleet maintenance campaign | `running` → `done` (⇄ `running` on a retry), `stopped` | On everywhere; its old paths are deleted |
| `bot-change` | `session:<id>`, for each change of the Homeroom bot's that goes up for a vote | `checking`, `waiting_on_shots`, `with_the_bot`, `ready`, `stopped`, `merged` → `live`; `closed` | On everywhere; its old paths are deleted |
| `bot-voice` | `place:<appId>:<type>:<ref>`, for each place in a project people speak to the Homeroom bot in | `quiet` ⇄ `settling` → `answering` | On everywhere; its old paths are deleted |
| `bot-dm` | `person:<userId>`, for each person's DM with the Homeroom bot | `idle` ⇄ `answering` ⇄ `trying_later` | On everywhere; its old paths are deleted |
| `main-check` | `app:<id>`, for each app whose main was checked after a merge or a new commit | `idle` → `running` (→ `confirming`) → `idle`; `idle` ⇄ `rechecking` while paused | On everywhere; its old paths are deleted |
| `bot-request` | `request:<appId>:<issue>`, for each request the Homeroom bot is owed a look at | `idle` → `queued` → `reading` / `following_up` → `idle`; `building` | On everywhere; its old paths are deleted |
| `bot-lane` | `bot`, one for the Homeroom bot | `open` | On everywhere; its old paths are deleted |
| `bench-lane` | `lane`, one for the App bench | `open` | Grants benchmark trials (each a `bot-build`); the leader's lane loop is deleted |
| `shots-eval` | `evals`, one for the shots evals | `open` | Grants eval trials and runs each one's phases; the leader's eval runner is deleted |
| `release` | `release:<GIT_SHA>`, one per release of the platform | `adopting` → `done`, `failed` or `abandoned` | Runs the boot adoptions once per release (`release.adopt`), in that release's own processes |
| `clock` | `clock:<job>`, one per scheduled platform job | `waiting` ⇄ `running`; `retired` | Runs each job on its schedule (`clock.<job>`), wherever the workflow runs; its old leader timers are deleted |
| `turn` | `agent:<id>` for a conversation, `session:<id>` for a change | `idle` ⇄ `running` | A person's turn is its `turn.run` work item; the leader's turn recovery, its watchdog, the conversation lease's renewal and the process holds' mirror are deleted |
| `bot-look` | `look:<id>`, for each look into a project's code a chat with the Homeroom bot asked for (`look_into`) | `looking` → `done` / `failed` | New: the look is its `look.run` work item, a read-only turn on durable steps |
| `bot-investigation` | `investigation:<id>`, for each investigation the Homeroom bot runs for a person, from its Start | `checking` ⇄ `waiting` → `ended` | New: each check-in is its `investigation.checkIn` work item, the next one its deadline |

### turn

A person's turn (`src/workflow/turn/`, the handler `services/turns.js`): one instance per
stream (`agent:<id>`, a conversation; `session:<id>`, a change), one `turn.run` work item
per turn, run whole in whichever workflow process claims it.
- **Asked with the message.** The route writes the person's message, the conversation's
  claim and the turn's `Asked` in one transaction (`platform.askTurn`), then follows the
  turn's stream from any process (`services/session-bus.js`, rows in `stream_events`)
  until that turn's own end: a `done` carrying its `turnId`, published when its item ends
  (`turns.js`) or, for a turn that failed for good or ran out of time, by the machine's
  `released` write. An agent turn whose claim no longer names it when its item starts
  runs nothing. Turns asked while one runs wait, in order; the same turn twice is
  one. Kinds: `agent` (a conversation's Mayor, the coding run it dispatches, its
  wrap-up), `classic` (a change's own dev chat: a CLI hand-off, a request's spec),
  `headless` (an auto session on a request), `recover` (a coding record nothing carries).
- **The item owns what the turn writes.** Its coding run's record and its local agent's
  turn name it (`turnOwner`); the claim lasts as long as the turn, released when the item
  ends; a turn that failed for good ends interrupted, with Retry. Its spend is kept as it
  happens (`turn_spend`), its worker by `session_workers` and the worker-eviction clock.
- **Resumed, not recovered.** A process that goes loses only the item's lease. A process
  that loses a lease while it runs on (the database out of reach for most of a lease)
  exits rather than follow the turn beside the next claim, unless the item was cancelled
  or the process is stopping (`turns.js endOnLostLease`). The next claim carries the
  turn on (`resume`): the coding run its record names it the owner of
  is followed to its end (the leader's old adoption, `services/turn-recovery.js`), a
  local agent's turn is taken over by its waiter, a Mayor turn cut before its answer
  ends interrupted with Retry, a dev chat cut before its reply gets its note once.
- **Stop.** `StopRequested` on the instance; the turn hears it (an agent turn from its
  claim, a dev chat turn by polling its instance until its handle takes it) and `turn.stop`
  kills a coding run by its journal. A headless run between its steps is no Stop's target
  (its Stop takes the person's own path, as before). Past six hours the turn is ended
  (`Tick`).
- **Busy, for every process.** Whether a change is worked on is read from these records
  (`session-work.ts` `workedOnSql`: a turn's record, a running turn instance, a local
  turn, shots, a live operation, a build, a sync, the bot's look), never from another
  process's memory. A process's holds (`services/processes.js`) are its own drain's.
- **What a turn owes after it** is the machine's work, never a call after its end: a
  turn that stopped before finishing tells its person once (`turn.stalled`,
  `turns.tellStalled`), a change's dev chat turn that did not end its own way (failed,
  out of time or of claims) gets the dev chat's repair once, unless another turn runs on
  the change (`turn.repair`, `turns.repairCut`), and a conversation opened on a request is named from it beside its
  run (`turn.name`, `agent-sessions.nameFromRequest`). A change's `session_state` (busy or
  idle) is pushed from the transition that starts or ends its turn (`pushes.ts
  sessionState`), from the change's row; `session-state.js` reads busy from the durable
  records above, never from what one process last published.
- **Leftovers** (`services/turn-leftovers.js`, the `turn-leftovers` clock, every minute):
  a coding record whose item settled without releasing it gets a `recover` turn, asked
  again ten minutes after the last while it is still there, four times at most; the last
  ends it as a forced Stop would (`RECORD_RETRY`).
- **No release from before the turn machine runs beside this one.** What #5714 kept for
  one (its claims, headless runs and local turns taken over, the holds written for it, the
  claim renewed, the spend mark, the Stop forward) is deleted; a rollback past #5714 is not
  supported (docs/kubernetes-operations.md, "Rolling back past this release").

### Turns workflow work runs

A coding turn that a machine's work starts (the proposal's sync with main, the shots agent,
the Homeroom bot's builds, reads and fixes, a bench trial) is its work item's:
- **Its record names its owner.** `execInWorker` (and `agent-turn.startCodexAttempt`)
  writes `active_turn.owner` (`{ machine, key, kind, workKey, workId }`) in the statement
  that claims the record, so "a turn runs" and "whose it is" commit together. The item's
  lease is the turn's presence: no process hold, registry entry or stop handle says whose
  it is. Every sweep (orphans, the stale-turn watchdog) leaves a record whose owner's item
  is outstanding alone (`session-work.ts workflowTurnHeldSql`), and the machines read a
  sync or a bot look spinning a turn up from the work itself (`syncWorkingSql`,
  `botLookingSql`).
- **A Stop is an event to the owner.** A person's Stop of the session (`POST
  /api/sessions/:id/stop`, the agent conversation's Stop) finds the instance whose turn it
  is (`TURN_OWNER_SQL`: the record's owner; else, only while the session has no turn record,
  the sync, shots run, build or bot look spinning one up) and appends `StopRequested` there
  (`platform.stopWorkflowTurn`). A person's turn is the `turn` machine's, found the same
  way (a running `turn` instance on the session, for a dev chat turn before its record).
  A record no work item holds (an older release's) answers nothing there, so that Stop
  takes the durable path and never ends a platform job that merely waits beside it. The machine records it as
  stopped by that person (never a failure or a conflict), ends its work, and queues
  `turn.stop`.
- **`turn.stop`** (`src/workflow/turn-stop.ts`, one handler for every machine): stamps the
  record stopped, kills only that turn, by its journal (`worker.stopTurnByJournal`: a turn
  started after it is never touched), and releases the record when its work was cancelled.
  It names the work item whose turn it is (`workKey`), so a retry after that item ended
  never touches the instance's next turn of the same kind. A Stop landing before the turn
  exists needs no kill: the cancelled item's next checkpoint refuses the dispatch and
  releases the record it wrote (nobody follows a cancelled item's record). One landing
  between the record and the exec is read by `execInWorker` right after the exec: a record
  stamped, gone or now another turn's means its turn is killed by its journal. The
  proposal machine's merge and close stop a running sync's turn the same way.
- **Its clock ends only its own turn** (`durable-turn.clockStop`: by its record, recorded as
  nobody's Stop), and `durable-turn` reports a Stop asked on the record as `stoppedBy`.

### bot-request

One request the Homeroom bot may look at (`src/workflow/bot-request/`), from the moment
something owes it a look to the look's end and the build a ready look asks for. One
instance per request (`request:<appId>:<issue>`); the queue (`homeroom_bot_queue`) is its
projection, guarded so only its transitions write a row it holds.
- **Owed.** The refresh (`bot.refresh` on the lane), a person's ask (`enqueueFront`'s
  callers: the DM, the Mayor, the voice's asks, a filed or asked request, main-red-fix),
  admin Run now and triage again append `Owed`; the queue's merge rules apply (a person's
  ask first, a debt the bot owes itself kept while its request is quiet). While a look
  runs, a person's ask, a voice ask or a fix waits for after it; the refresh's own finds
  are read again by the next refresh. `NotOwed` from the refresh prunes what it no longer
  wants.
- **A look** starts when the lane grants a slot (`Granted`): `bot.look` (`homeroom-bot.js
  lookAt`), a read on the project's triage session or a reply or fix on its change. Its
  turns are durable steps naming the item, and every effect (the run, the spend, the
  notes, the act, the asks' tag) is a keyed step, so a restart follows the turn and says
  and spends nothing twice. A project's first read is granted before its triage session
  exists; its look tells the instance the session it made (`LookOn`), so a Stop, a merge or
  a person writing finds the look by it. Its result decides: done (or a build owed),
  failed (a try spent), busy (its change's session is somebody else's: backed off 2
  minutes doubling to an hour), a fault or the budget (owed as it was; the lane pauses),
  held for its payer's week, requeued (a budget stop), or interrupted. A request the
  platform keeps failing on waits on its own count as well (the same backoff), and its
  third fault in a row is recorded as a failed read the refresh counts, as a provider's
  error is at once, so one request cannot keep the lane pausing for ever. A look whose work
  threw on every attempt pauses nothing else, waits on its own count, and after five in a
  row is held a day (a person's ask lifts it).
- **A person writing during a read** (`Activity`, appended in the statement that stores
  the message, beside the voice's `Heard`, when the request has an instance; otherwise its
  project is refreshed) stops the read's turn (`turn.stop`) and reads the request again from
  the start, once, carrying what it spent. During a look that does not start over for it
  (a follow-up, a read already read again) or a build, its project is refreshed soon,
  which owes the request what was said, taken once that ends. The person a look or build
  is for hears it start and end (their tray).
- **A build** (`BuildOwed`: a ready verdict, Build it in the DM) waits for a build slot,
  then `bot.build` (`startBuild`: the checks a build starts with) asks bot-build for it
  with this instance as `replyTo`; bot-build's end (`BuildEnded`) frees the slot. A live
  run waiting for its build that no instance holds (an older release's, an append that
  never landed, one turned away while another build of the request ran) is told to its
  request again by the lane's sweep (`sweepWaitingBuilds`), once a refresh window.
- **A fix** bot-change asks for (`FixAsked`, from its `bot.queueFix` work) is owed at
  priority 1 and answered: `FixRoundEnded` with how the round came out (looked, lost,
  stopped), or `FixRefused` at once when the bot is off or not on the project, or when the
  refresh drops the debt it rode on.
- **Its request merged** (`RequestMerged`, from bot-change's `bot.stopRequestWork`):
  debts owed before the merge are dropped, a look begun before stops, its build is stopped.

### bot-lane

How much the Homeroom bot runs at once, and when it looks at GitHub
(`src/workflow/bot-lane/`). One instance (`bot`), so the caps hold however many processes
run the workflow: `liveAtOnce` looks and builds, `perPerson`, one read at a time on a
project's triage session, three builds per project.
- **Grants** under its lock, in the queue's order (a person's ask, follow-ups, priority,
  age), as `Granted` messages; what is in use is read from the requests (their `slot`, and
  grants not applied yet), never kept here.
- **Pauses**: a fault (a look's platform failure) pauses every grant 2 minutes doubling to
  an hour, ended by a look that ran; the bot's weekly cap a minute at a time; GitHub's
  hourly budget nearly used up (`services/github-budget.js`: a look, a build's start, the
  refresh or a sweep found it so, reading nothing), with no grant and no refresh until it
  resets, then a full refresh. A request an admin must look at (its instance flagged)
  holds no slot.
- **The refresh** (`bot.refresh`) every five minutes, and 20 seconds after a project is asked
  for (a person wrote on an idle request, a merge, a settings change), at once for a first
  version just filed, with the five-minute sweeps beside each full one (`bot.sweep`). Its one deadline is the earliest of those, a
  pause's end and the next waiting request becoming eligible.

### bench-lane

Which of the App bench's trials run, and when (`src/workflow/bench-lane/`,
`services/bench/lane.js`). One instance (`lane`), so its limits hold however many processes
run the workflow: a run's `concurrency` (at most 9), at most three heavy trials of a run (a
build, a checks fix, a spec, a first version, a capture; a studio run, its concurrency),
eleven in flight across every run, none while the live bot's work fills `liveAtOnce` (its
slots read as bot-lane reads them), a later change's side builds only in the slots live work
leaves free, and each run's dollar cap (what it spent, plus every trial of it running at its
estimate, plus the next one's).
- **A grant** is the trial's claim (`running`, its `build_key`) written in the transition
  that sends its build's `Requested` to `bot-build/trial:<id>@<nonce>`, with `replyTo` the
  lane: a granted trial is counted at once, from its row, whether or not its build has
  started. Its build hears `BuildEnded`; a lost build's record (`build.lost`) asks for a
  `Look`; a running lane looks again every five minutes anyway, and an idle one every ten,
  so an ask to look that was lost (a launch's, an older release's wake) waits no longer. A
  claim whose trial changed outside the lock (an older release's write) is retried, so no
  build goes for a claim that did not happen.
- **Recording** is the trial's own build's (`recordTrial`): the trial's result and its
  run's charge in one statement, by the build its claim named (`build_key`), the branch it
  cut kept for the sweep, and every session it opened (`session_ids`) charged when it is
  lost. A build sent for a claim that did not happen runs nothing. A trial whose build
  ended without recording it (ten minutes on), or a claim whose build never started (an
  hour on), is recorded lost by the lane (`bench.lost`); a build a restart caught
  between its record and saving it redoes what follows the record (sessions put away, the
  grade, a side build's result).
- **Cancels** (a run, a trial; a side build given up) are its events: written in the
  transition, a trial running stopped by `StopRequested` to its build, which always comes
  after that build's `Requested` from this instance. A run marked done or capped is
  decided here, its write checking again that nothing of it waits; a trial added to an
  ended run reopens it (`Look` with `runId`).
- **The allowance** (the bench user's week) is legacy code: looked at by `bench.gate`, kept a
  minute in the instance, nothing granted while it is unknown or spent. A provider refusing
  the bench key for its limit pauses grants half an hour (read from the trials).
- **Only it claims**: a trigger refuses `pending → running` outside a transition, so an older
  build's lane, during a rollout, starts nothing. A run's queue is read heavy and light
  trials apart, so one holding its heavy trials still finds its light ones. Its sweeps (kept branches, side results a
  trial never filled, the studio's previews) are the `bench-sweep` clock.

### shots-eval

Before & after shots evals' trials (`src/workflow/shots-eval/`, `services/shots-eval.js`):
an admin's comparison of shots agent recipes on merged proposals. One instance (`evals`):
at most `SHOTS_EVAL_CONCURRENCY` trials at once (2, at most 4), never two on one proposal,
never beside the proposal's own shots run, and each eval's cap (what it spent, plus each
trial running at what it has spent or its estimate, the larger, plus the next one's).
- **A trial's phases are this instance's work**, the shots machine's steps on the trial's
  attempt id: `eval.copies` (`buildCopies`, stopped between phases once the trial's row
  says it ended or is stopping; its recipe kept on the trial from here), `eval.agent` (`dispatchAgent` with the arm's model, prompts and time, the
  turn owned by the item; busy or gone, tried again 20 seconds later while a minute is
  left), `eval.compare` (`compareScreens`, its light files kept), and, however it ends,
  `eval.cleanup` (`cleanupRun`: its turn by its record, copies, workspace, and the
  proposal's temporary worker unless another run of the proposal uses it), tried until
  done. Each phase has its own deadline; past it the trial fails and is cleaned up. A
  trial that ends while its copies are built waits for them to stop (its row's
  `stopping_at` stops them at their next step) before its cleanup, as the shots machine
  does. No trial starts on a proposal with a turn under way. A row ended elsewhere ends
  its trial here too.
- **Its end** is written once its cleanup is done, and settles its attempt's cost
  (`shots_eval_attempt_costs`, `workflow/shots-eval/costs.ts`): what the proxy billed and
  what Claude Code reported, each a running total for the attempt, and the larger charged to
  the trial and its eval, counted in that transition's own cap check. A call or a report
  that comes after (a straggler, a dispatch that returns after a cancel) charges only what it
  adds to the larger total.
- **Billing**: the proxy reads the session's turn record; a shots turn the eval machine's
  work owns is that trial's (`shots-eval.billFor`), on whatever attempt. The platform key,
  the eval's cap from rows, each call added to its attempt's costs. Never this process's
  memory, and
  never the session alone (the proposal's own shots rerun is its author's).
- **Cancel** (`EvalCancelled`): the eval and its trials not ended read cancelled at once;
  what runs is stopped (its work cancelled, its turn stopped) and cleaned up. A trigger
  refuses a claim or a re-queue outside a transition.

### governance-proposal

A governance proposal from filing to its outcome (`src/workflow/governance-proposal/`):
votes, the gate (`rules/governance-gate.ts`, the same rule every merge path uses), the
vote window and a 10-minute backstop as the instance's timer, then the kind's own change
in the transaction that closes it. What talks to the outside is durable work: GitHub's
close and comment (`github.closeIssue`), the production redeploy a secret change needs
(asked of `app-delivery` by message), the target check of a close proposal, and, when a
close vote closes a request, the Homeroom bot's proposals for it (`bot.requestsClosed`). A
passed maintenance campaign is inserted by the apply's write, which starts the `campaign`
machine with a message naming the row.

### merge-queue

An app's line of proposals in review (`src/workflow/merge-queue/`), and the one place that
decides which of them is merged or brought up to date next. Everything that may make a
proposal mergeable asks it (`MergeWanted`, through `platform.wantMerge`): a vote, a passing
verdict, a merge that landed, main green again or resumed, a review check whose window
elapsed, an admin's force, and each boot (`adoptMergeQueues`). It reads the line in its
transaction (`facts.ts`: every promoted row, its proposal's data, the vote gate) and asks the
proposal machine, which decides under its own lock:
- **the direct lane:** every approved (or forced) candidate that merges cleanly with main,
  cheapest first (forced, measured clean, settled verdict, the group's stronger preference,
  the longer wait), one attempt at a time per app (`MergeRequested` → `AttemptEnded`).
  Being behind main is no reason to wait.
- **the conflict lane:** at most one resolution at a time (`SyncRequested` reason
  `conflict` → `ResolutionEnded`), and only while no attempt is under way. Rule C admits
  it: approved or forced, or the authored head's first conflict; never a fork's head, a
  head the agent gave up on against this main, a failure's backoff, or failing checks.
  The lane's reasons (`awaiting_approval`, `unresolvable`, `fork_head`) are written to the
  row for the card. Merges go on while a resolution runs.

A pass tries each candidate once; an ask during a pass makes one more pass after it. What
is under way, what the pass tried and what is owed are the instance's data, never process
memory. A slot it waits on for 30 minutes from when it was given is looked at again
(`Check`), and freed when its proposal no longer holds it. While nothing is under way and
its line is not empty it sweeps the line every four minutes (`Sweep`, the old eligible-merge
sweep), and a proposal going up for a vote asks it, so a vote window that elapses, a
conflict before any vote, a decline for a turn that has since ended and a back-off that
ran out are all looked at.

### merge-followups

What a merged pull request still has to do once GitHub has merged it
(`src/workflow/merge-followups/`).

- **Created by `Merged`.** The proposal machine sends it by message in the transition
  that records GitHub's merge (its `merge.attempt`, or its `merge.observe` once GitHub
  answers a merge nobody heard), and the `merged-by-hand` clock (every six hours) and the
  `imported-prs` clock (each imported pull request every three minutes, and the webhook)
  append it for a promoted row GitHub has merged (`platform.mergeObserved`,
  `services/proposal-scans.js`). Either way
  the merge gets every follow-up, and the app's merge queue is told to go on
  (`MergeWanted`).
- **One transaction with the merge:**
  - the move into `merged` (with `merge_commit_sha` and the vote snapshot);
  - the secret values the proposal declared;
  - `PR_MERGED`;
  - the bounties, with their events and lines.
- **Its deploy**, for a child app, is asked of `app-delivery` by message
  (`DeployRequested`); its answer (`Delivered` with the build's sha, or `DeliveryFailed`)
  decides. The platform's own release is heard from the processes serving it; on a Docker
  host, its host deployer is told by durable work (`host.nudgeDeployer`).
- **Messages, in the merge's transaction:** the preview's retirement
  (`RetireRequested`, to the preview machine: at once, unless demo mode deploys the
  preview's own build, which waits for app-delivery's answer), and the unit
  suite on the merge commit (`CheckRequested`, to the app's `main-check` instance).
- **Durable work for the rest:**
  - `worker.retire`: the worker and its Claude Code volume, through the proposal machine's
    strict, fenced removal (`worker.removeCcVolume`);
  - `included.find`, then an `Included` message to each change it carried, which gets
    its own instance;
  - `issues.closeAfterMerge`: one look at the requests the merge closes per attempt
    (`issue-close-watcher.closeAfterMerge`). At the first look a linked request still open
    is left to GitHub, and the transition asks for a second look 30 s later, at which the
    platform closes it. The close proposals whose target the look saw closed (or gone) are
    told by message, in the transition that applies it (`Filed`, then `TargetClosed`, to
    each one's own governance instance), never before the close is confirmed.

  A change of the Homeroom bot's tells its change machine (`bot-change`) with the
  merge's own write (`Merged`), and again once it is live (`Live`).
- **Merged, then live.** The change is `live` once production runs a build that contains
  it: its own deploy's answer, or a `Deployed` report checked against GitHub
  (`delivery.verify`). Every successful app-delivery deploy reports one to the merges
  still waiting, and so does the platform's own release, once a process serving people
  runs it (`releaseServing`, from the listener's start; never a conductor, which serves
  nobody and can be up before the release's web Pods).
  - Only then are these written: `chat_sessions.live_at`, the "is live" line, the
    author's notification and the journey record (and, for a change of the bot's, its
    change machine is told: the requester's DM and the request's "It's live").
  - Until then the change reads merged and going live.
- **A failed deploy** ends in `deploy_failed`, said in the thread. Any later deploy that
  contains the change makes it live, and so does **Retry delivery** in Admin → Workflows.

- **What a merge leaves alone.** `worker.retire` waits while the change's shots run is
  still heard from (its `shot_runs` row, heartbeated; `facts.ts liveShotsRun`), asking
  again two minutes later (`notBefore`). A change is carried only if, under its own lock,
  its head is still the one the carrier listed and no turn, shots run or checks run is
  working on it. An operation (a sync with main or a dispatch starting its worker, a
  hand-off's commit upload, a local agent run) is recorded on the preview machine's
  instance and read by the guard (`worked_on`, below), in whichever process decides.
- **Every web process's issue lists.** GitHub's open-issues list is cached per process,
  with the requests just closed hidden from it. A merge and its close work publish an
  `issues_closed` push, which every web process applies to its own copy (`ws.js`); no
  browser receives it.
- **Follow-ups from before.** A follow-up of a kind no handler runs any more, in an old
  instance's record (`app.deliver`, `main.check`, `preview.teardown`), is not retried; a
  merge whose own deploy failed is asked again through Retry delivery.

### app-delivery

An app's production runtime (`src/workflow/app-delivery/`): its deploys and its heals, one
thing at a time per app, for everyone who asks: a merge and a secret change (by message,
from merge-followups and governance-proposal), a project's first deploy (by message, from
app-creation), **Redeploy**, rollover's rebuild and a demo reset
(`platform.requestDeploy`); main moving (the `main-drift` clock and **Check for updates**,
`MainMoved`); and an app reported down (the `app-health` clock, `Unhealthy`, and the error
page, `Unreachable`).

- **A request** (`DeployRequested`) is recorded on the app's instance. The rule for every
  request is the same: it is satisfied by the first successful deploy that started after
  it was recorded. A deploy takes main's tip as it starts, so that deploy contains every
  merge confirmed and every setting or key stored before the request.
- **One thing at a time.** Requests that arrive during a deploy or a heal are served by one
  more deploy after it, however many there are. The deploy is the work item `app.deploy`
  (`staging.deployProduction`, under the cross-process build lock), at most four at a time.
  A merge's commit already running is not deployed again, and an offered image is reused
  (demo mode's preview image; a ready-made project's image built ahead, for its first
  deploy of the starter commit), only when every request the deploy serves offers it. A
  deploy serving a request made by hand (Redeploy, Check for updates, a demo reset) retries
  even a commit refused for running as root; missing keys and an image that runs as root
  are answers, not errors to retry. An app deleted while it deploys keeps no runtime
  (`app-teardown.removeRuntimeIfDeleted`). Without GitHub an app has no repository: its
  deploy builds its starter's files.
- **The answer.** On success the transition writes `main_sha`, `main_pr_number`,
  `last_deploy_at` and `status`, pushes the end and the version, and answers every
  request it served (`Delivered`, with where it runs and, for a first deploy, where its
  time went). A failure (missing keys, a broken build, retries spent) is told once to whoever
  asked; their request stays open, so the next deploy that succeeds, whoever asks for it,
  still answers it. Every merge of the app still waiting to go live hears each deploy that
  did not answer it (`Deployed`). A request another machine sent that no deploy here can
  serve (no repository, no app) is answered `DeliveryFailed`.
- **Main moving.** `MainMoved` is keyed by the commit, so the clock's next look adds
  nothing; one for the commit production runs, or for one a deploy already owes, is
  refused. A drift whose deploy fails is kept and tried again by the instance's own
  deadline (`RetryDue`: 30 minutes, doubling to 6 hours), unless no retry can help (its
  image runs as root, keys are missing): the next commit, or the keys' change, asks again.
  A commit whose deploy failed in the last 30 minutes (a merge's, or one that failed before
  it knew its commit) waits the same before a drift deploys it. By hand, it goes now. A
  retry that nothing here can serve any more (the app lost its repository, or is gone)
  tells whoever waits and ends.
- **Health.** An app reported down is healed as the machine's own work (`app.heal`,
  `services/app-heal.js heal`): a Kubernetes restart (a conflict read again, not a
  rebuild), a Docker start or restart, a probe first when a person could not reach an app
  its runtime calls running, its image run again when it has no repository (or GitHub is
  off); or `needs_deploy`, which the machine answers with a deploy. A report during a deploy
  or a heal is ignored. Heals back off: the next may start 10 minutes after the last
  (`APP_HEAL_COOLDOWN_MS`), doubling while they follow one another, to 6 hours; an app that
  stayed up an hour past its backoff starts a new count, and so does a deploy that succeeds
  (a new runtime). A Docker container seen restarting is given a minute's grace. A report
  inside the backoff or the grace is refused and keeps no receipt (a dead app is reported
  every minute for days), and the error page reports an app at most once a minute. Nothing
  else restarts an app: the error page only reports.
- **A deploy or a heal that never answers** (a hung build or lock, a result skipped in
  Admin → Workflows) is ended by an admin there (`EndDeploy`): read as a failure, its work
  cancelled, its late result stale. A drift it was deploying is kept for its retry.
- **"Deploying" is durable.** `apps.deploy_state`, `deploy_started_at` and
  `deploy_from_sha` are its projection, owned by the machine, with its
  `app_redeploy_status` pushes. The version pill, rollover and the merged list read it
  (`app-deploy-status.read(slug, row)`), on every Pod and after a restart. Rollover's respawn
  of an existing image and the boot respawn stay old flows, and leave an app alone while it
  reads deploying.

### app-creation

A new project's making (`src/workflow/app-creation/`), whichever door it came through:
Make it, an import, a ready-made app, a remix, the bench studio's host.

- **Enrolled by its insert.** A row inserted `creating` appends `Started` in the insert's
  own transaction (`wf_enrol_app_creation`, a trigger on
  `apps`), so its setup starts once everything the route wrote with it has committed (the
  create route writes the row, its rule, its description, its starter, the card it owes
  and the first request it owes in one transaction; the card and the first request are
  savepoints, so neither failing loses the project).
- **Its setup** is one resumable work item (`app.setup`, `services/app-creator.js setUp`):
  the database (and the card, then the repository, side by side with it), each a step a
  restart carries on from, never done twice. The card (`app-sketch.drawFor`) is made before
  the first commit, which carries it. A resumed setup finds its first commit at the
  repository's head and does not push it again. A remix copies its source; an import adds
  its scaffold and the create answers. Its failure is a record the machine writes to
  `last_failure`; processes that kept going away under it make it `interrupted` (a free
  Retry).
- **Its first deploy** is app-delivery's, asked by message with the starter commit
  offered (its layer cache, a ready-made app's image built ahead); `Delivered` makes it
  `running` (and marks its first run), missing keys `awaiting_secrets`, anything else
  `failed`. Every 2 minutes until it answers, the machine looks whether app-delivery holds
  the ask (a request of its own open there, or a deploy since it asked), and asks again if
  not: an older build's app-delivery, during a rollout, refuses an asker it does not
  know.
- **Its first request**, when it was made with a description, is filed once beside the
  first deploy (`app.firstRequest`, `homeroom-bot-dm.fileFirstRequest`): the GitHub issue a
  step, a resumed try finding its own by the marker in its body, its rows in one write, its
  announcement a step of its own; three tries, the last failure told to its maker. It is
  claimed from `waiting`, or from `filing` (a try of its own that stopped before it kept
  its claim): the work item is its only filer.
- **A first version's plan** at Make it is claimed with `PlanOwed` (from
  `first-version-plan.startEarlyPlan`, its row claimed in the same statement): `app.plan`
  drafts it (`runEarlyPlan`), then `app.earlyLook` draws its first look, each work a
  restart carries on. They were promises in the memory of the process that made the
  project.
- **One deadline: its time limit** (15 minutes from its setup's start). Past it a setup
  still running is cancelled and the project reads failed; a first deploy still to come
  makes it run when it answers. One whose ask app-delivery never took up reads
  `interrupted` (the platform's doing: a free Retry).
- **Retry** (`POST /api/apps/:slug/retry`, after its permission and count checks) sets a
  failed project up again (`setup:<n+1>`), only from `failed`, and not while app-delivery
  still holds its first deploy (`still_deploying`, a 409 that says so): a new setup would
  make its database again under that deploy.
- **Every status a person sees while it is made** is the transition's write, with the
  `app_status` frames the made screen follows; the step it is on is read from the machine
  (`services/app-creation-phase.js`: its setup's steps, or its first deploy).
- **Where its time went** is one `app_creation_timed` event from both halves
  (`app-creation/timing.ts`).

### preview

A proposal's preview and its required checks (`src/workflow/preview/`), from the first
revision announced until the preview is retired. What is being built, what serves and
which revision the verdict is for are separate facts on the instance; the
`chat_sessions` columns are its projection, so every reader keeps working. A session it
has never seen is adopted from its row by the first event about it (a preview an earlier
release built is known, and retired by identity once a newer attempt serves).

- **Requests.** Every source of a preview or a checks run (a turn's commit, a CLI upload,
  a fork update, a sync with main, an imported pull request's head, the merge gate, a
  person's Preview, Deploy or Recheck, recovery, fleet) appends `RevisionSubmitted` with
  an exact head, `PreviewRequested` or `RecheckRequested`, through
  `services/preview-workflow.js`. An App bench studio preview is `PreviewRequested` with
  reason `preview`: it builds and serves, and nothing runs against it (no checks, no
  verdict, no retry; the studio reads the outcome off the instance). A head that is not the row's pin for its kind (an
  import's head, a promoted proposal's reviewed head, a submitted hand-off) is refused
  `head_superseded`; the head being built or served joins.
- **A deferred head that measures clean** tells it (`ConflictResolved`) in the
  measurement's own statement (`integration.js`), so a restart between the two cannot
  leave it deferred; the boot hook that did it after the commit is gone.
- **One build at a time, one checks run at a time.** A build is an attempt
  (`preview.prepare`): its own checkout, database and env Secret, then the session's
  runtime updated in place, fenced by attempt and claim (`n.k`), the serving template
  restored if the rollout fails. Each claim of a build clones into a database and a
  checkout of its own, so a claim that runs again after a crash never re-clones the
  database an earlier claim's pods may already use; the receipt names the one that
  serves, and the earlier claims' go. A claim that lost its lease and runs on never
  writes, restores or deletes what a later claim of the same attempt deployed, its env
  Secret included (the claims of an attempt share it; it carries the same fence). A failed
  attempt deletes only the Deployment exactly its claim wrote, and only as it read it
  (UID and version), never one a newer attempt or claim has written since. A recheck whose inputs changed
  (`testing-update`, `shots-update`) replaces a run going; any other joins it. A newer head cancels the obsolete build or run (the kernel's
  `cancel`) and retires what it created, never while it still serves (a build cancelled
  after its deploy gives the Deployment back to the attempt that serves). Each claim of a
  checks run (`checks.run`) gives its Jobs an id of its own, and its manifest names the
  run: a retry after a lost claim collects the Jobs the earlier claim left on the cluster,
  and runs again only when there is nothing to read.
- **The unit suite starts with the build.** Beside each attempt's build, `checks.unitEarly`
  launches the repo's unit suite under an id derived from the attempt (not for a head
  whose last checks errored, and only while the cluster runs fewer unit suites than the
  checks queue admits). The checks run against that attempt reads its Jobs
  (`unit-suite.collectUnitSuite`) instead of launching its own, and launches its own only
  when there is nothing to read; the attempt's retirement deletes them.
- **One transition settles a run:** the verdict, `test_results`, console, capture outcome,
  the run's media (held under its run id until then, `check_run_media`) and the app's
  check history (`rules/check-store.ts`), with the pushes browsers hear (`checks_ready`,
  `staging_ready`, `visuals_ready`). A verdict about a head the row has left stores
  nothing. A passing or skipped verdict on a proposal in review asks the app's merge queue
  by message (`MergeWanted`); a change of the Homeroom bot's tells its change machine
  with the settle's own write (`Verdict`); the shots machine hears the
  head by message. A build that fails because the proposal no longer starts against main
  asks the proposal machine for its one sync (`SyncRequested`, reason `boot_failure`).
- **Liveness is the work lease;** nothing is judged stuck by clock. An `error` runs again
  on the instance's timer (2 minutes doubling to 30, at most `CHECK_MAX_AUTO_RETRIES`, or
  for a day for the platform's own fault; a release re-arms those platform faults at
  boot). A proposal going up for a vote whose head errored before it was in that scope
  (an ordinary session's error has no retry) arms the retry then. An admin can retry,
  retire, or end a build or run that never answers (`AdminEnd`).
- **Its own housekeeping deadline** (`restTimer`), whenever an outcome leaves none: the
  earliest of `ChecksDue`, ten minutes after it rests with checks the row owes and nothing
  runs (a person's "Run checks again" a restart lost, a verdict left pending or missing in
  the error lane's scope), which runs them once nobody works on the session; and
  `IdleDue`, when a preview that serves has gone unused for `STAGING_IDLE_TEARDOWN_MS`
  (read from `last_activity_at` when it comes, so a heartbeat costs no event), which gives
  it back unless it is under review or worked on (then it comes again). A fired deadline
  the state cannot use is still taken and sets the next one, so an instance is never left
  without one; the release gives one to each instance an older build left without
  (`restPreviews`). These replaced the leader's idle staging GC and its three stuck-checks
  sweeps.
- **A stale environment** is the `preview-env` clock's to find (every 15 minutes, acting
  only in the newest build): each preview built with another platform environment is told
  (`EnvStale`, once per attempt and environment), and is built again if it backs a vote,
  else given back. An older Pod during a rollout never judges the new build's previews by
  its own fingerprint.
- **What people read.** The transitions write the lines: the dev chat's "Staging
  deployed!" when a new attempt serves, and "Staging build failed" when a build fails
  while a turn's "Building staging preview..." card is still open; an imported pull
  request's thread hears when its preview is being built and when it is ready; the first
  failure of a streak tells the author once.
- **Retirement:** archive, merge, included changes and app deletion retire the preview
  for good; idle, a stale environment and connection pressure only when nobody is working
  on the session (a refusal reads as busy to whoever asked). The runtime and its Secrets are deleted
  by the identities read first, every attempt's database by name.
- **Who is working on a session.** The instance is also its durable record: its own build
  or run while it is `preparing` or `checking`, and the operations old flows keep no
  record of (a sync with main or a dispatch starting its worker, an upload, a promote, a
  turn before its container starts), recorded by `services/active-workers.js`
  (`OperationStarted` / `OperationEnded`). Such a record names the process that holds it
  and counts only while that process holds its presence lock
  (`services/process-presence.js`, `rules/presence.ts`): a crash or a release ends it at
  once, without a heartbeat. `session-work.ts` is what other machines read.
- **Observers.** What asks whether a build or run is under way reads the row
  (`check_phase = 'building'`, the preview display state) or the instance. The clocks only
  hand work to it: `preview-runtimes` reports a vote-backed preview whose runtime or
  database is gone (`PreviewLost`); `preview-gc` retires previews whose session finished
  or that no row names (or removes one no instance holds by name); `preview-pressure`
  asks it to give back one preview at a time while the database server is saturated,
  none while the last one asked for is still retiring; `preview-orphan-dbs` drops
  databases nothing reaches. A vote-backed row it never held is handed over by the
  release as a revision of its reviewed head. It refuses to retire while it works.

### shots

A proposal's before & after shots (`src/workflow/shots/`): its declaration of visible
changes, and the runs that shoot them. One instance per proposal, because what is decided
is about the proposal's one slot: one run at a time, a new head or declaration supersedes
the run under way, a Stop or a waiver applies to whatever is current, and an automatic
retry is counted per head. `chat_sessions.shots_state`, `shots_run_id`, `shots_detail` and
every `shot_runs` row are its projection and domain writes, guarded; their values and shape
are what every reader (the vote and merge gate, the cards, the bot, the gallery) already
read. A proposal it has never seen is adopted from its row by its first event (any event,
its close included); a run an earlier release was taking is ended as interrupted (its
copies go) and taken again once while the proposal is open.

- **Requests.** A declaration (`Declared`: the hosted worker's tool, `submit_work`, a
  hand-off, PR import in its own transaction, the bot's own proposal) and a head move
  (`HeadMoved`) are appended by `services/shots-state.js` where they were written before.
  Each names the revision column its caller moved (`pin`: the imported head, the reviewed
  head, the hand-off's; with `from`, the head the caller read there, when it appends before
  it writes or moves nothing): one a newer move overtook is refused (`stale_head`) instead
  of taking the slot back to an older head. A declaration from a submission that names a
  head (an update, a resubmit, a hand-off build, an import) is always fenced.
  The preview machine says when a head is ready to be shot (`HeadReady`: its preview serves,
  or its checks settled), when an imported proposal's preview will not start
  (`PreviewStopped`), when a UI change declares nothing (`UiUndeclared`, from its checks
  run) and when the proposal leaves review (`Closed`). People: Retry, Stop, waive
  (`RetryRequested`, `StopRequested`, `WaiveRequested`, routes/shots.js). A head ready
  before its declaration is shot as soon as the declaration arrives.
- **A run is four steps, each a work item:** `shots.revision` (the exact before revision,
  from GitHub), `shots.copies` (the two copies built, deployed and seeded, and the agent's
  workspace written; resumable, its images in the checkpoint, so a restart does not build
  them again), `shots.agent` (the shots agent's turn as a durable step over the item's
  checkpoint, `services/durable-turn.js`: a restart follows the turn the worker still runs),
  `shots.publish` (the outlines). Publication is the transition: the ready files become
  `shot_artifacts` in the same transaction that writes `verified`. Whatever way a run
  ends, `shots.cleanup` removes its copies (and its turn, and a temporary worker no newer
  run is in), `github.prShotsBlock` tells the pull request, and the settle's own write
  tells the Homeroom bot's change machine (`ShotsSettled`) when the change is the bot's. Copies still being built when their run ends are not cancelled: they
  stop at their next phase (the step asks whether its run is still current), and the
  cleanup starts once they report, so nothing they make afterwards is left. An agent's step
  whose run ended starts no turn.
- **The agent's control plane is in Postgres** (`shot_run_control`, `shot_run_files`,
  `services/shots-control.js`): any web process answers its calls, and nothing it saved
  is lost to a restart. A call is answered only while its run is current and its agent at
  work.
- **The machine decides:** at most 4 copy builds and 32 agent turns at a time; it waits
  for the proposal's agent (`waiting_for_agent`, rechecked every 20 seconds, within the
  run's time from the moment its copies serve) instead of taking it from a turn; another
  turn taking it is waited for again
  twice, a dispatch whose process died is tried once more. Each step has a deadline: copies
  that take over 45 minutes fail, an agent's turn 15 minutes past its own clock fails (its
  process is stuck), a comparison past 15 minutes publishes without outlines. A platform
  fault (the copies' database, a clone, the worker's bootstrap, GitHub's limit, the agent's
  exit or a stuck turn, copies too slow, a run a release cut off) is taken again once;
  one whose revision never resolved (GitHub's limit) never got a row, so the slot says it
  did not start, and it is taken again when the limit resets. Each timer names the run and
  the step it was set for, so one that fired as a transition replaced it is ignored. A
  run under way
  holds the proposal's worker: `session-work.ts` `shotsRunningSql` is what the preview
  machine and merge-followups (its `worker.retire`) read.
- **Shots evals** (an admin's comparison of the agent's prompts) run the same steps as the
  `shots-eval` machine's work, on their own tables (below).

### proposal

A proposal's lifecycle (`src/workflow/proposal/`), from the moment somebody starts it until
it is merged or closed. One instance per session, every one included (the Homeroom bot's
triage and build sessions, the App bench's), adopted from its row by its first event: a
session's insert appends `Adopted` (`wf_enrol_proposal`, a trigger), and each release adopts
every row in review, being merged or holding a slot from before that, and every closed row
whose CC volume is still there. `chat_sessions.status` is its projection with the values it
always had (the move into `merged` stays merge-followups', which tells this machine with a
`Merged` message), and it owns the columns that move with it: `promoted_at`, `archived_at`,
`stale_notified_at`, `merge_attempt_at`, `active_users_at_promote`, what the group votes
on, `reviewed_head_sha` and `approval_epoch`, and what makes each platform sync once:
`boot_failure_sync_head`, `fixed_check_sync_head`, `fixed_check_sync_keys` and
`integration_resolved_epoch`.

- **States as a person names them.** `underway` (being worked on; the session's slot is data
  of it: held reads `active`, released `paused`, an imported proposal holds none and reads
  `active`), `proposing` (GitHub is opening or readying its pull request; the status reads
  what it read before), `in_review` (`promoted`), `merging`, `merged`, `closed` (`archived`,
  its reason recorded; reopened to `underway`).
- **Every move is an event that names what its caller read** (`from`, the status it saw; a
  head move names the head): one a newer move overtook is refused rather than undoing it.
  The decoders require it, so a caller that leaves it out fails at the append. A move whose
  caller acts on the answer (a merge claim, a head move, a pause, a resume, an unpromote)
  carries a deadline a few seconds out: past it the machine refuses it (`expired`), so an
  answer the caller stopped waiting for never applies later. A close carries none.
- **Teardown and coming back.** A pause, an unpromote or a close queues the worker's removal
  (and a close that asks, the CC volume's). The removal (`worker.removeWorker`,
  `removeCcVolume`) is strict (a refusal throws and is tried again), fenced (it reads the
  resources' identities, Kubernetes uids or the container's id, checks its claim is still its
  own and the session has not come back, and deletes only those, so a stalled call never
  removes a newer worker) and finished (it reports once they are gone, not when the delete is
  accepted). A resume or a reopen reads that work under lock: one no attempt has started is
  cancelled; one any attempt has started (running, its lease lapsed or not; reported; waiting
  for a retry) makes the move wait (`tearing_down`, asked again for up to 30 s).
- **Promote** (the button, the connector's tools, the local CLI, the Homeroom bot, an import
  going straight to a vote in its own transaction): under the owner's promoted cap, counted
  under a lock on their `users` row; refused while somebody works on the session, and for a
  pull request merged on GitHub or an imported one closed or kept as a draft. Nothing on
  GitHub moves before the proposal is claimed: `review.open` then creates its pull request if
  it has none, reopens a closed one of ours, links its originating request, marks a draft of
  ours ready for review and reads the head, and the proposal is in review once it reports
  (never while its pull request is still a draft). The route waits up to twenty seconds and
  answers as before, else 202. The move into review writes its clock, its head, the
  electorate it opened with, the line, the vote requests and the agent's "submitted" note in
  its transaction, and asks the preview machine to check the reviewed head.
- **The session's slot.** `Pause` gives it back (the platform's own reasons, `lru`,
  `pressure` and `auto-idle`, never under somebody working on it or a durable build that
  holds it); `Resume` takes it under the owner's and the platform's caps, counted under the
  owner's row lock and a transaction-scoped advisory lock: over one it is refused, the route
  asks the least recently active session nobody works on to pause, and asks once more. A
  closed proposal is never resumed. An instance timer gives back a slot nobody has used for
  `SESSION_AUTOPAUSE_IDLE_MS` (the session sweeper's old first pass).
- **Retention.** A close queues the CC volume's purge (`cc.purge`) for when
  `ARCHIVED_RETENTION_MS` has passed since it closed; it waits doomed, so a Reopen cancels
  it (the leader's hourly GC purged unfenced and could race a Reopen).
- **What is read from outside** is a clock's (`services/proposal-scans.js`), and each
  consequence the machine's: `imported-prs` (each imported pull request's head and
  description, and GitHub merging or closing it: a merge of one up for a vote is
  merge-followups', any other closes the proposal), `merged-by-hand`, `proposal-revisions`
  (a native head pushed outside Homeroom, the explicit-approval flag), `proposal-measure`
  (against main, every minute; it never rewrites the merge gate's reasons) and
  `fixed-check-sync`.
- **The review check** is the instance's hourly timer: the vote gate read under the lock
  (`rules/pr-gate.ts`), so a Yes since counts; voted down closes it; quiet for
  `PR_STALE_NOTIFY_MS` warns its author once; still quiet `PR_STALE_GRACE_MS` after the
  warning closes it, and a vote since the warning clears it instead.
- **One close for every reason** (withdrawn, voted down, gone quiet, replaced, superseded,
  its request closed, red and untouched, the bot's and the bench's own endings): the votes
  voided, its work orders abandoned, a secret it held discarded, the conversation that started
  it told, the bell settled and the thread line written in the transaction; its pull request
  closed, its worker destroyed and its CC volume purged when asked, as work; a change of
  the Homeroom bot's tells its change machine (`Closed`) and, withdrawn because its
  requests closed, says so in each request's thread; the preview machine asked to retire its preview for good (which tells shots). A
  reopen reopens the pull request.
- **A proposal's GitHub moves run one at a time:** a close during a promote waits for
  GitHub to open the pull request, then closes it; a reopen during a close waits for it.
- **The merge.** The app's merge queue asks (`MergeRequested`), and the proposal answers
  whatever its state (a refusal goes back to the queue with its reason). `merge.gate`
  measures the gate (`votes.evaluateMergeGate`: the tally, checks, shots, main's health,
  the pull request's own state); its report is read again under the lock with every
  deciding input (`rules/merge-claim.ts`, and the vote gate unless an admin forced it), so a
  No, a moved head or epoch since refuses the claim. Claimed, it reads `merging` and
  `merge.attempt` asks GitHub once (`votes.attemptMerge`); a retry reads the pull request
  first and never asks twice. Merged: merge-followups is told. Refused: the reason is
  written once per head (a conflict is marked on the row at once), and the head is not
  asked again until it, main or the votes change; a base that moved is tried once more, a
  native draft is readied and tried once more, an imported draft is reported (a base that
  moved twice is not remembered against the head: the next ask tries it). The head
  moved: back to review, with the votes kept or cleared as the reconcile decides. GitHub
  never answered: `unconfirmed` (still `merging` on the row), and the instance's clock asks
  GitHub every minute, doubling to ten, until it says; there is no override, and Admin →
  Workflows lists it under "Needs a person". A pull
  request closed for good takes the proposal off the vote (voiding the votes, and ending a
  force with it). An admin's force (`ForceMerge`) lasts until it merges, leaves review or
  its author pushes. Once GitHub merged it, merge-followups is told again every five
  minutes (doubling to thirty) until the row reads `merged`, since an older release's pod
  may refuse the message during a rollout; a second `Merged` is ignored there. A merge
  that lands any other way while the gate, an attempt or a sync runs ends them and tells
  the queue. A `merging` row adopted with no attempt of its own is asked about on GitHub
  once it is five minutes old, and each boot re-arms a proposal waiting on GitHub with no
  clock (`Rearm`). Every other exit from review voids the votes.
- **Sync with main** is a move of this machine too (`SyncRequested`: a person's Sync, the
  resume auto-sync, the queue's conflict lane, a boot failure, a check main fixed, the
  Homeroom bot's fix or hand-off). Under the lock it refuses a sync while one runs, while
  the proposal is merging or somebody works on it, and checks each reason's own rule (the
  failing head still the head, not tried for this head yet, one resolution per authored
  head before approval, not a fork's head, not a head it already gave up on against this
  main, not inside a failure's backoff). A platform sync for a head (a boot failure, a
  failing check) is not refused while somebody works on the session: its work waits for
  them, up to ten minutes. While a sync is asked for, the session is neither promoted nor
  paused. What makes it once is written in the same transaction as its work, so a restart
  resumes the sync instead of reading it as tried, and given back when the sync did nothing
  to the branch (unmeasured, out of budget, still busy, failed), so it may be asked again.
  A conflict GitHub reported on a head the mirror measures clean is the conflict lane's,
  and its sync runs the turn all the same.
  `branch.sync` (`sync-main.runSyncWork`) measures, runs the worker's sync turn as a
  durable turn over the item's checkpoint (a restart follows the turn the worker still
  runs), and records what came of it; a sync that failed backs off 2 minutes doubling to
  30. Its end tells the queue (`ResolutionEnded`) and writes the card's block reasons.
  The session status route (`GET /api/sessions/:id/status`) reads it off the instance.
- **The review revision** moves through it: `votes.reconcileNativeReviewedHead`,
  `pr-import-sync.applyHeadChange`, `vote-revision`'s authored push and
  `integration.clearApprovals` append `ReviewHeadMoved` / `ApprovalsCleared`, never on a
  closed or merged proposal, and the move tells the shots machine (`HeadMoved`).
- **A hosted build's diagram** is stored together with this machine's `DiagramStored`
  (`proposal-diagram.storeDeclared`, one transaction), and its block in the pull request's
  body is a GitHub move of the proposal (`pr.diagram`): one at a time, the newest waiting.
  GitHub refusing the write ends it; a limit or an outage is tried again twice, briefly,
  as the proposal's other GitHub moves wait behind it.
- **Who works on a session** is `session-work.ts` read under the lock, in every one of these
  decisions; a hand-off's promote names its own operation, and the pipeline checking the very
  commit being proposed does not count.

### campaign

A fleet maintenance campaign (`src/workflow/campaign/`), from the moment its governance
vote passes until every app it reaches has an outcome: an AI makes one small change in
each app's repository and each change goes up for that app's vote. One instance per
campaign, started by the governance apply's message.
`maintenance_campaigns.status` and every `maintenance_campaign_apps` row are its
projections, and its guard refuses them to anyone else.

- **Its targets are fixed when it starts:** every live app with a repository, but the
  platform itself and an app moderation suspended, within the proposal's slug filter. A
  retry never adds an app created since.
- **One app at a time.** `campaign.change` (work) runs the AI's tool loop
  (`fleet-maintenance.runAppChange`), sets the campaign's own branch for the app
  (`maint/c<id>/<slug>`) to main and pushes the change as one commit, then opens its pull
  request, using the one GitHub already has for the branch. It checkpoints after the push
  and after the pull request, so a restart never pushes or opens twice; a restart before
  the push runs the AI again. A change too big or a model gone astray fails the app at
  once; GitHub's and the model's temporary errors are retried for about an hour. An app
  deleted meanwhile is failed (its result's facts lock the app row), not faulted.
- **Each change goes up for a vote through the proposal machine's promote.** The result's
  transition writes the proposal's row (the platform account's, `source 'maintenance'`,
  holding no worker slot) and its `Promote` in one transaction (`ctx.message`); the
  promote records what any promote does (the reviewed head, the electorate, the vote line,
  the requests, the preview of that head) and tells the campaign `ProposalOpened` or
  `ProposalRefused`. A promote the proposal's guard refused outright sends no answer: the
  campaign's clock (set once an app goes up for a vote, not pushed back by later events)
  reads it off the event within five minutes; one not applied yet is waited for. A proposal
  that could not go up for a vote is closed with its pull request (`Close`, reason
  `campaign-refused`): nobody can act on the platform account's underway change. The
  next app starts as soon as the previous change is pushed. From then on each proposal is the proposal machine's;
  the dashboard reads what came of it (merged, closed) off its row.
- **Done** once no app waits, is being changed or is going up for a vote; the completion
  line goes to the governance thread in the same transaction.
- **An admin's moves** (`routes/campaigns.js`, each answered from the outcome): `RetryApp`
  (a failed or skipped app: a failure after the push carries its checkpoint on; an app
  whose proposal was closed is changed again from scratch on a branch of its own, so the
  closed one's pull request is never reused), `MergeGreen` (forces, at once, the
  campaign's proposals in review whose checks pass at the press; each merges through its
  app's queue, and app delivery paces the rebuilds; during a rollout an older release may
  refuse a force, and pressing again asks again), `Stop` (no further app is reached; the
  change under way is not cancelled: its work reads the stop before the AI's every call,
  before the push and before the pull request, and a change that already opened its
  pull request goes up for a vote like the opened ones, which stay).

### bot-change

One of the Homeroom bot's changes from the moment it goes up for a vote until it is live
or closed (`src/workflow/bot-change/`): what its requester and its approvers hear, and
when it goes back to the bot to fix first. One instance per change, created by the first
thing a machine tells it: the proposal machine's promote (`Proposed`), the preview's
verdict (`Verdict`), the shots settling (`ShotsSettled`), the preview that will not start
(`PreviewStopped`), the merge (`Merged`, `Live`). Each sender tells it with a domain write
in its own transition (`rules/bot-notes.ts writeBotChange`), which sends the message only
for a session of the bot's: it commits with its cause and cannot be lost. The bot's loop
answers how its fix round on a head ended (bot-request's `FixRoundEnded`, `FixRefused`).
Its creating guard
requires a run of the bot's that proposed the session.

- **One rule decides, from the row, with the transaction's clock**
  (`rules/bot-readiness.ts`, the one copy the old modules import back): a message is only
  "look now", so a late or repeated one decides the same thing again.
  - **Ready to try**: up for a vote, its checks passed or skipped on the head up for a
    vote, its shots on that head settled. Said once per approval epoch: the card, its
    record, the approvers' bells when nothing is broken, the chip (`bot.tellReady`).
  - **Waiting on its shots**: held until 45 minutes after the later of the verdict and
    the slot's last move, by the instance's own timer (the bot's refresh sweep and its
    20-minute window are gone).
  - **Back to the bot**: its checks fail, or its shots show part of it failing or could
    not reach part of it for want of seed data, and no round looked at that head
    (`bot.queueFix`: its request's instance hears `FixAsked`, bot-request). It waits for
    that instance's answer: a round that looked at the head decides at once; one a person
    stopped is not asked again for that head (the next verdict, settle or promote asks when
    it is needed); one lost (its look ended without it, or failed for good) is asked once more; lost
    again, a change whose checks pass is ready to try saying what does not work, and one
    whose checks fail is left as it was (nobody is told). A bot that is off, not
    working on the app, or facing a failure that looks like the platform's (which it tells
    the requester itself) does not take it, and says why in the result; the next verdict
    or settle asks again. A fix result about a head the change has left settles nothing.
  - **Its preview will not start**: a quiet line, once per epoch (`bot.tellStopped`).
  - **Merged**: the bot's other work on the request stops, bounded to what had started
    before the merge (`bot.stopRequestWork`). **Live**: the requester's DM, the chip, a
    first version's line (`bot.tellLive`), and the request's "It's live" on GitHub and in
    its thread (`bot.commentLive`).
  - **Closed**: the requester's tray reads again (a push the close's own write sends),
    and nothing more is said; a closed change reopened and put up for a vote again is
    followed again. **Live** is the end.
- **A vote on it** tells it in the vote's own statement (`Voted`, from `routes/votes.js`
  `recordVote`, and from `retractVote` in its transaction): the requester's tray reads
  again, and a yes is said to the requester once per voter and approval epoch
  (`bot.tellApproved`, `homeroom-bot-dm.sayApproved`, only while the yes stands). It was
  a call after the vote's commit, which a restart in between lost. Like every notice
  owed as work, one owed more than six hours earlier (work a rollback left queued) is not
  said (`rules/late-notice.ts`).
- **Its work only sends, strict:** a failure throws and is retried, instead of reporting
  success with nothing done. Each is keyed so a retry says nothing twice: the DMs by their
  idempotency keys (a duplicate send records what its first attempt never got to), the
  "It's live" by its post record (its comment found again by a lookup that throws when it
  cannot read, its thread message by the post's mark on it). Admin → Workflows retries a
  note that failed for good (`RetryFollowup`).

### bot-voice

One place in a project where people speak to the Homeroom bot (`src/workflow/bot-voice/`):
a change's or a request's discussion, the project's chat, a topic's channel, a reply
thread. One instance per place (`place:<appId>:<type>:<ref>`), created by the first thing
that happens there.

- **Heard where it is stored.** Every person's message in a project, but a governance
  vote's and a connector's, is inserted together with its `Heard` event in one statement
  (`services/ws.js handleMessage` → `platform.ts insertHeard`), so an answer owed is never
  only in the memory of the process that took it.
- **A burst is one turn.** `Heard` settles the place: its timer fires 8 s after the last
  message, never more than 25 s after the first (`rules/bot-replies.ts`). A message
  written while a turn runs gets a turn of its own after it.
- **The turn decides whether to speak** (`voice.turn` → `homeroom-bot-voice.js runTurn`):
  it reads what was said since the place's `through`, runs the voice's gate on every new
  message (settings, the person's access, the change, the request's open question: I/O,
  reported in the result), and answers or stays quiet. In a project's chat it also hands
  what nobody said to the bot to the chat's own path (a newcomer's idea, offered to be
  suggested; the older ask with the voice's chat switch off). Its reply carries the
  turn's mark (`metadata.homeroomBot.turn`): a retry after a restart finds it and says
  nothing twice; the asks it records are one per change and message. A turn that fails
  for good is followed by one that tells whoever spoke to the bot it could not answer,
  once.
- **What the place owes others**, each said once as work: a tap under one of its offers,
  decided once by the person it was offered to (`OfferTapped` → `voice.act`, claimed by
  its work item so a retry carries the act on and says its line once; an act that fails
  for good settles the offer as failed and says so); what came of a change people asked for
  (`Report`, appended by the bot's follow-up in the transaction that ends their asks →
  `voice.report`); the answer to a mention on a request a person holds (`HeldAnswer`,
  from the bot's refresh: its post row is written pending with the decision, so the
  refresh counts it as said only once it is certain to be → `voice.post`).
- **During a rollout** an older Pod's messages still go to its in-memory path. A turn of
  this machine takes the place's turn record (`homeroom_bot_voice_turns`, whose one
  unfinished row per place stays for one release): while an older release's turn holds
  it, the turn's work asks again.

### bot-dm

One person's DM with the Homeroom bot (`src/workflow/bot-dm/`), from the first thing the
bot owes them there. One instance per person (`person:<userId>`).

- **Heard where it is stored.** A person's message in their DM with the bot appends
  `Wrote` in `conversations.sendMessage`'s own transaction (`routes/conversations.js` →
  `homeroom-bot-dm.js heardInDm`).
- **One answer at a time, in the order written**, wherever the work runs (`dm.answer` →
  `homeroom-bot-dm.js answerOwed`: every code path, and the model's turn). An answer
  already sent under the message's keys ends a retry; the words it passes on to a request
  or a change carry their mark, a platform report it files is kept in the item's
  checkpoint, an offer it drafts is one per message.
- **Asked again later.** An answer no model could give says so, and the work reports
  `later`: the instance's timer asks again after 60 s, 3 min and 10 min (the last try says
  it could not). A newer message from them drops the try, as its own answer reads the old
  one. An answer whose work fails for good gets one fixed line (`dm.sorry`: "I couldn't
  answer just now", or for a later try, that it still could not), and a retry of an answer
  that had said "I'll get back to you" still owes the later try it promised.
- **Taps and hellos.** A tap under one of the bot's offers, or Build it under a plan, is
  decided once here (`Tapped` → `dm.act`, claimed by its work item; an act that fails for
  good is settled as failed and said). A hello owed (joining a project by an invite, the
  tour's end) is appended in the transaction that makes it owed (`Greet` → `dm.hello`, one
  per trigger: each project joined owes its own); every hello is claimed in the transaction
  that sends it (`sendDm`'s `hello`), so none is claimed and then not sent, and a person
  has one.
- **Its email.** A bot DM that rang a person owes them its email when no phone push
  reached them: `MailOwed`, appended with the message (`sendDm`'s write), and `dm.mail`
  sends it (`activity-mail.emailIfNoPush`, which waits for the send and throws when it
  cannot decide, so the work retries). It was a send after the commit, lost to a restart.

### main-check

The safety net under direct merges (`src/workflow/main-check/`, the run and the rules'
history in `services/main-watch.js`). One instance per app (`app:<id>`), which owns the
`apps.main_check_*` columns: the merge gate's pause (`main_check_paused_sha`) and the
board's banner read them.

- **Asked.** Every merge sends `CheckRequested` with its commit (merge-followups), and the
  `main-drift` clock appends one for any new main it sees (`platform.requestMainCheck`). A
  commit the row is already about is not checked twice; one whose last run could not
  happen is.
- **A run** is durable work (`main.suite`): a checks-queue slot, the repo's unit suite as
  Jobs, the verdict. The queue row's run id is in the item's checkpoint before the Jobs
  exist, so a process that dies mid-suite leaves the run to the next attempt, which reads
  the dead run's Jobs. A run whose commit is no longer the row's when its slot comes
  starts nothing.
- **The verdict.** A first red is provisional: merges pause and the suite runs again
  (`confirming`). Green then is passing, and the tests that flaked are recorded with a
  request filed for each (`main.flakes`); red again is confirmed, and the Homeroom bot is
  asked to fix it (`main.fixRequest`); red on other tests only is flakes. A red made only
  of tests known to flake pauses nothing. Green after a pause, or flakes, ask the app's
  merge queue to go on. Every verdict is kept (`main_watch_verdicts`), and a pause's start
  and end are events.
- **A paused red is asked again** by the instance's deadline (`RecheckDue`): three minutes
  after a confirmation that could not run, a quarter of an hour after a confirmed red, at
  most three times (`MAIN_WATCH_RECHECKS`).
- **Resume.** An admin's "resume merges" (`POST /api/apps/:slug/main-check/resume`)
  lifts the pause for that commit and asks the queue to go on.
- **A newer commit** while a run is under way starts its own first run; the older run's
  verdict is recorded as superseded and changes nothing.
- **Rolling back past it.** The guard stays on (its `enabled:main-check` row and the
  instances outlive the release), so an older release's writes to `main_check_*` are
  refused, a pause included: an app paused then stays paused. Delete the
  `enabled:main-check` row of `wf_settings` after such a rollback (the same holds for every
  machine's guard).

### bot-look

A look into a project's code that a person's chat with the Homeroom bot asked for
(`src/workflow/bot-look/`, the look's own code in
`services/homeroom-bot-thread-tools/look-into.js`). One instance per look (`look:<id>`, its
row in `homeroom_bot_looks`).

- **Asked** by the chat's `look_into` tool, keyed by the look, after it wrote the look's row
  (one running per person at a time, by the table's unique index).
- **The look** is one resumable work item (`look.run`): a read-only scout turn of the bot's,
  on the platform's default model, in the person's look session on the project's main, on
  the item's steps (`services/durable-turn.js`), so a restart follows the turn rather than
  starting another. Its end is a compare-and-set on the row.
- **The chat waits** on the row for up to three minutes. One that stopped waiting set the
  row's `deliver` to `post`, and the findings are posted in that chat once the look ends,
  under the look's idempotency key. A run that fails for good is recorded and, when the
  chat stopped waiting, said there (`look.failed`).

### bot-investigation

An investigation the Homeroom bot runs for a person over days
(`src/workflow/bot-investigation/`, its rules in `rules/investigation.ts`, its work in
`services/homeroom-bot-thread-tools/investigate.js`). One instance per investigation
(`investigation:<id>`), created by its owner's tap on Start; while it is only offered, it is
a row in `homeroom_bot_investigations` and a card, and nothing runs.

- **A check-in** is one work item (`investigation.checkIn`, keyed by its sequence number):
  a look into the project's code (the same turn as `bot-look`'s) asked the goal, the notes
  so far and what changed since the last check-in, its notes written once and its short
  update said once in the investigation's thread. The first runs at Start; each next one is
  the instance's deadline (`CheckInDue`), one interval after the last ended.
- **The money** is added up here from each check-in's result, against the budget it was
  started with; every check-in also counts toward the person's weekly building time.
- **It ends** when a check-in says the question is answered, the budget or the days run
  out, its owner taps Stop (a check-in under way is cancelled), the bot is turned off or
  stops working on the project, or three check-ins in a row fail. Its end is said once
  (`investigation.ended`), and its card is drawn from every decision
  (`investigation.card`).
- **The row's** `state`, `spent_cents`, `next_at` and `ended_*` are its projection.

### clock

The platform's scheduled jobs (`src/workflow/clock/`): what the leader's timers ran, now on
whichever process runs the workflow. One instance per job (`clock:<job>`); the jobs, their
intervals and their I/O are the table in `clock/services.ts` (`JOBS`).

- **Due.** The instance's deadline is when the job is next due. When it passes, the job runs
  as one work item (`clock.<job>`, key `run:<n>`) with a limit of 1 across every process, so
  no two runs of a job overlap and no job needs a leader. The next run is due one interval
  after this one ends; after a failure, sooner (30 s doubling, never later than the interval),
  and the failure is recorded as one. A job with no interval (the push sender's drain) runs
  again as soon as a run ends.
- **What a run found** is the instance's last run: when, ok or its error, how long, its
  result. That is the status an admin page reads (`platform.clockStatus`: the custom-domain
  sweep, the storage cap), and the last good result is handed to the next run as
  `input.previous`, so what a job carries from run to run (the build it last ran under, when
  it last looked at the challenge standings) lives here and not in a process.
- **Targets.** An effect a sweep finds owed once per target (a title's model call, an app's
  Workshop re-draft) is never made by the sweep: its result lists `items`
  (`{ target, gen, input }`), and each becomes a work item of its own
  (`clock.<job>.item`, key `item:<target>@<gen>`), at most 200 a run (the Workshop's whole list). The generation is the run
  unless the job names one, so each run asks again for what is still owed; a target with an
  item still outstanding gets no second one, and a named generation only one.
- **Safe to run twice.** A lease is weaker than a lock: a run whose process stalls stops
  itself only at three quarters of its lease. So every run is an age DELETE, a delete
  preconditioned on what it read, or a state change written as a compare-and-set with the
  notice it causes (custom domains, the storage cap, connector waits, the vote digest), and
  the push sender claims each row with its run's work item and attempt: a row left sending
  is sent again only when that attempt is no longer live.
- **Armed by the release** (`release.adopt`'s `clocks` step): every job the build defines
  gets `Arm` with its interval, a new one first due within the next two minutes; a job the build no longer defines is `Retire`d (no
  deadline, its run cancelled). On a staging preview nothing is armed
  (`config.runsClusterMaintenance`), as no leader duty ran there.
- **A continuous job** (no interval) runs again as soon as a run ends, unless its result asks
  to rest (`restMs`, at most 5 minutes: the push sender in a process that sends none).
- **Run now.** Admin → Workflows' "Run now" (`RunNow`), and the storage page's "Measure now",
  which waits for the run it asked for (`platform.runClockNow`; on a staging preview, where
  nothing is armed, it measures on the spot). During a run it runs once more after it.
- **Asked for, not scheduled** (`onDemand`): an admin's fleet job, `container-rollover`
  (Admin › Rollover) and `preview-reap` (Admin › Staging's "reap now"), has no deadline and
  runs only when an admin asks (`platform.askClockRun`: `RunNow` with who asked, which the
  run's input carries as `asked`). One asked while it runs is refused (`running`), so two
  presses on two processes are one sweep, and none is asked while an older build's
  workflow process serves (`rollout`: it would take the ask without knowing who asked).
  Each unit (an app, a preview) is a step of the run's work item (`services/fleet-job.js`):
  a restart carries the job on after the units it finished (a stopping run waits for the
  units under way to be kept first), and its progress, the units under way included, is
  that checkpoint, which the console reads from any process (`platform.clockRunOf`). A run
  first started more than six hours earlier is not carried on. Progress reaches the admins'
  sockets through the bus: a job too big for one NOTIFY goes as a nudge, and the console
  reads it again. An older build, which knows no on-demand job, arms one on a day's
  interval; a run nobody asked for does nothing (`skipped: not_asked`) and is no job on the
  console, and the next press marks the job asked-for again.
- **Refused by an older build** (`reask-refused`, every minute, newest build only): during
  a rollout an older workflow process refuses an event type its machine gained in the
  newer build (`unknown_event`), and what it owed would be lost. Once no older build
  serves, each refusal since this build's rollout began whose type this build's machine
  knows is appended again as it was, keyed `reask:<id>` and caused by the refusal, so it
  is asked once (`platform.reaskRefused`, over `wf_events_refused_unknown_idx`). What it
  sets off checks it still holds: a re-asked yes says nothing once retracted, a re-asked
  plan asks no model once its window passed.
- **First runs** are spread over the next two minutes.
- **The newest build only** (`newestOnly`): a job whose work depends on the build (its
  keys, its catalogs, its environment) does nothing in an older build still running during a
  rollout (`skipped: older_build`), and its targets name the release that found them, so only
  a process of it claims them (`WorkHandler.ownRelease`): `preview-env`, `starter-images` (the
  ready-made apps' images, each key a target), `language-sync` (the translation of the
  build's new text: the catalog, or a batch to collect, a target), `app-gate` (every managed
  Ingress routed through the app-host gate or straight back, per `APP_GATE`, every 10
  minutes on Kubernetes). The newest build is the build of the live workflow process that
  started serving last (`platform_processes`), so a rollback, or a rollout of the same build
  with another configuration, is the newest once it serves. An item an older build's run
  handed out, once nobody works it (queued, or its lease lapsed), is given up by the next run
  and its target asked for again; the run reads those items locked, so none is claimed in
  between. One a live process of that build is working stays its own.
- **A target's progress is the target's.** A new item for a target carries on from the
  checkpoint of the target's last item when that one did not finish (given up, failed, out of
  tries), so an effect it made is not made again: a translation batch it paid for is
  recorded, not submitted a second time. The translation target is `catalog` whatever the
  English, so a deploy that changes a string carries the batch on too.
- **The App bench.** `bench-sweep` (every 10 minutes): kept `bench/` branches past their
  time, side builds' results a trial never filled, and the studio's previews past their
  day. Which trials run is the `bench-lane` machine's.
- **Production apps.** `app-health` (each running app's runtime, every minute) and
  `main-drift` (each running app's main on GitHub, every 5 minutes) report to app-delivery
  (`Unhealthy`, `MainMoved`), which decides.
- **People's round trips and limits.** `wallet-links` reads the explorer for wallet-link
  memos (continuous, resting 4 s, longer while the explorer fails), its chain, cursor and
  outage streak carried in its result; `rate-limit-retention` deletes the shared limiters'
  spent windows (`rate_limit_hits`); `notice-mail` sends the email a notice owes when no
  phone could take its push (an invite moment, a project opening:
  `notifications.mailed_at` NULL, written with the notice); `workshop-changes` (every 10 s) runs each
  Workshop pass a board change owed.
- **Previews and proposals.** `preview-runtimes`, `preview-gc`, `preview-env`,
  `preview-orphan-dbs`, `preview-pressure` and `worker-volumes` read the runtimes
  and the database servers;
  `imported-prs`, `merged-by-hand`, `proposal-revisions`, `proposal-measure` and
  `fixed-check-sync` read GitHub and the mirrors. Each hands what it found to the preview or
  proposal machine as an event, or retires through it, so none decides anything about an
  instance; a per-target effect (a GitHub read, a removal by name) is a target.
