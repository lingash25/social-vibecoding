const { Router } = require('express');
const { getPool } = require('../db/pool');
const { connectionExhaustionMessage } = require('../db/connection-census');
const log = require('../services/logger');
const github = require('../services/github');
const githubMock = require('../services/github-mock');
const staging = require('../services/staging');
const docker = require('../services/docker');
const applicationRuntime = require('../services/application-runtime');
const { checkAndResolveConflicts, isResolving } = require('../services/conflict-resolver');
const { sendSystemMessage, pushNotificationToUser } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminYesVote } = require('../services/admin-approval');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const { effectiveSessionCaps } = require('../services/session-caps');
const topicAttrs = require('../services/topic-attributes');
const limits = require('../services/limits');
const { weekStartUtc } = require('../services/leaderboard-users');
const { usesMockGithubForImports } = require('../config');
const { drainGuard } = require('../services/lifecycle');
const { isCliCredentialManagementSession } = require('../services/cli-api-policy');
const visualEvidencePlan = require('../services/visual-evidence-plan');
const visualEvidenceState = require('../services/visual-evidence-state');
const visualEvidenceView = require('../services/visual-evidence-view');
const {
  reviewedHeadForSession,
  visualHeadForSession,
  currentVotePredicateSql,
  sameSha,
} = require('../services/pr-vote-revision');

const CLI_CREDENTIAL_MANAGEMENT_ERROR = 'credential_management_not_available_via_cli';
const VISUAL_EVIDENCE_GATE_STATES = new Set(['verified', 'not_required', 'overridden']);

// Evidence enforcement is deliberately scoped to proposals that have entered
// the v2 contract. Historical proposals with no declaration keep their old
// voting lifecycle; a proposal whose detail says evidence is required must
// have an accepted verdict for the exact current head. The artifact route
// independently enforces the same revision fence.
function visualEvidenceGateForSession(config, session) {
  if (!config?.visualEvidence?.enforce) return { applies: false, allowed: true, state: null };
  const detail = session?.visual_evidence_detail;
  if (!detail || typeof detail !== 'object') return { applies: false, allowed: true, state: null };
  const required = detail.required !== false;
  const evidenceState = session.visual_evidence_state || detail.state || 'planned';
  const currentHead = visualHeadForSession(session);
  const recordedHead = detail.headSha || null;
  const exactHead = !!currentHead && !!recordedHead && sameSha(currentHead, recordedHead);
  if (!required && evidenceState === 'not_required' && exactHead) {
    return { applies: true, allowed: true, state: evidenceState, currentHead, recordedHead };
  }
  const allowed = exactHead && VISUAL_EVIDENCE_GATE_STATES.has(evidenceState);
  const reason = !exactHead
    ? 'The visual change preview has not been verified for the proposal’s current commit.'
    : evidenceState === 'failed'
      ? (detail.failureReason || 'The visual change preview failed and must be retried or overridden by an app administrator.')
      : `The visual change preview is ${String(evidenceState).replace(/_/g, ' ')}.`;
  return { applies: true, allowed, state: evidenceState, currentHead, recordedHead, reason };
}

async function readVisualEvidenceGate(config, pool, session) {
  if (!config?.visualEvidence?.enforce) return visualEvidenceGateForSession(config, session);
  const { rows } = await pool.query(
    `SELECT source, imported_pr_head_sha, reviewed_head_sha,
            visual_evidence_state, visual_evidence_detail
       FROM chat_sessions WHERE id = $1`,
    [session.id]
  );
  return visualEvidenceGateForSession(config, { ...session, ...(rows[0] || {}) });
}

// #687: pick the GitHub client the imported-PR flow talks to. Staging
// previews use the in-memory mock (no GitHub credentials there — see
// usesMockGithubForImports in config.js); production always uses the real
// client. Only the client swaps; the surrounding flow is identical.
function importGithubClient() {
  return usesMockGithubForImports() ? githubMock : github;
}

// Staging-only mock PR proposals for GET /api/apps/:slug/promoted,
// appended only when the request carries ?demo=1 (forwarded from the
// page URL by _demoQS in app-view.js). Sibling of stagingMockIssues in
// routes/issues.js: deliberately long titles (~90-120 chars) so the dev
// card list's progressive title wrapping can be verified on narrow
// screens against a prod-cloned DB. Rows are "[Mock]"-prefixed and use
// ids/PR numbers far above anything real so they can't collide with
// (or be mistaken for) live sessions; user_id 0 matches no viewer, so
// owner-only affordances ("Open session") never render on them. Casting
// a vote on one 404s harmlessly. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// `viewer` (the requesting user's username, when known) seeds ONE mock
// proposal's assignee as the viewer's own so the #600 "already voted"
// assignee-dropdown state (name box empty, viewer's pick checked) is
// reviewable on staging via ?demo=1; the rest stay assigned to
// staging-tester with myValue null, so opening their dropdown pre-fills
// the viewer's own username.
function stagingMockProposals(viewer) {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  // gate = { required, windowEndsAt, contested } — precomputed because mock
  // rows bypass the live `active`/promoted_at gate computation in /promoted.
  const mk = (id, prNumber, title, hours, yes, no, chat, gate = {}) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_title_fallback: false,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation that now appears at the top of a proposal, written '
      + 'in everyday words, with no technical jargon.',
    // The technical half, so a reviewer can see BOTH sections of the About
    // sheet on ?demo=1 rather than only the labelled one. Obviously fake and
    // deliberately written in the register the summary above must not use —
    // the contrast between the two is the thing being reviewed.
    pr_body: '## What changed\n\n- `renderTopicHead` now emits the summary '
      + 'behind its own label\n- `parseImportSummary` bounds the field at 600 '
      + 'characters\n\nSee `src/routes/votes.js` for the import path.',
    staging_url: null,
    testing_md: null,
    testing_path: null,
    user_id: 0,
    status: 'promoted',
    linked_issues: null,
    username: 'staging-tester',
    created_at: hoursAgo(hours),
    promoted_at: hoursAgo(hours),
    yes_count: yes,
    no_count: no,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    revert_of_session_id: null,
    // #967: which external coding agent wrote it, for the "built with …"
    // chip. NULL on every native row — the connector-imported mock below is
    // the one that sets it.
    external_agent: null,
    original_pr_number: null,
    original_pr_title: null,
    chat_count: chat,
    last_message_at: chat ? hoursAgo(Math.max(0, hours - 1)) : null,
    visuals: null,
    resolving: false,
    // Dynamic merge-gate fields (span every regime across the mock set).
    votes_required: gate.required ?? Math.max(yes, 1),
    merge_window_ends_at: gate.windowEndsAt ?? null,
    contested: gate.contested ?? false,
    // Auto-takedown (rejection) fields.
    reject_window_ends_at: gate.rejectEndsAt ?? null,
    rejection_armed: gate.rejectionArmed ?? false,
    // #788: ordinary rows are not admins-changing; the three
    // explicit-approval mocks below override this to true.
    requires_explicit_approval: false,
    // #381: console-error check snapshot. Clean by default; the dedicated
    // error mock below overrides these so the warning badge + detail block
    // are reviewable on staging via ?demo=1.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: hoursAgo(hours),
    // #47: "CI for proposals" check snapshot. Passing by default; the
    // dedicated failing/pending/error mocks below override these so every
    // checks-badge variant + the per-test detail are reviewable via ?demo=1.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: hoursAgo(hours),
    // #1442: the freshness snapshot. Measured-and-clean by default, which
    // is what the great majority of real promoted proposals look like, so
    // adding these columns does not make every existing fixture render an
    // "unknown" caption. The four dedicated fixtures below override them so
    // each of the three states this issue is about is reviewable via
    // ?demo=1 rather than only reachable by waiting for main to move.
    mergeability: 'clean',
    mergeability_files: [],
    mergeability_files_complete: true,
    checks_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    checks_base_verdict: 'current',
    checks_base_behind_by: 0,
    freshness_main_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    freshness_behind_by: 0,
    freshness_ahead_by: 1,
    freshness_checked_at: hoursAgo(0),
    freshness_error: null,
    // Community-voted priority + assignee + category chips. Populated so
    // the card states are reviewable on staging via ?demo=1.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 3, myValue: null },
    category: { top: 'improvement', count: 2, myValue: null },
  });
  // The four build steps every mock run shares: the live fifth-step row
  // (9000028 below) draws them under "Preparing the staging preview…", and
  // the finished shape a verdict keeps (#2170, applied after the literals)
  // sums them to "built in 20s". A fresh array per call, so no row can
  // mutate another's.
  const mockBuildSteps = () => [
    { key: 'source_fetch', ms: 2555 },
    { key: 'image_build', ms: 5372, phases: [
      { name: 'FROM docker.io/library/node:22-…', ms: 212 },
      { name: 'COPY . .', ms: 276 },
      { name: 'COPY --from=css /build/public/c…', ms: 3708 },
    ] },
    { key: 'clone', ms: 2426, via: 'template' },
    { key: 'health', ms: 9585 },
  ];
  const rows = [
    // Unopposed, thin support: threshold met but a multi-day visibility
    // window still running → "Goes live in ~2d" countdown pill.
    mk(9000001, 900101,
      '[Mock] Long-title test: rework the proposal card header so the '
      + 'discussion badge and vote tally wrap gracefully on narrow phones',
      3, 2, 0, 4, { required: 2, windowEndsAt: hoursAhead(46) }),
    // Near-majority, no opposition: window almost elapsed → short
    // "Goes live in Xh" countdown.
    // #1251: the only mock proposal that declares a linked issue. 900017 is
    // a mock issue nothing else touches, so this pair is what makes the
    // board's "an issue with an open proposal is still on the board"
    // behaviour visible in a ?demo=1 preview — the issue renders in In
    // progress, this card in In review, and the report prints it once.
    { ...mk(9000013, 900113,
      '[Mock] Near-majority test: tighten the proposal card spacing on tablet widths',
      20, 5, 0, 3, { required: 3, windowEndsAt: hoursAhead(5) }),
    linked_issues: [900017] },
    // Majority reached: no window, would merge immediately in prod.
    // my_vote is set on this one mock (#482) so the kanban "Waiting on you"
    // filter visibly removes a card in the ?demo=1 preview instead of
    // matching every mock proposal.
    { ...mk(9000014, 900114,
      '[Mock] Majority test: bump the vote pill contrast for accessibility',
      6, 6, 0, 2, { required: 5, windowEndsAt: null }), my_vote: 'up' },
    // Lazy consensus: BELOW the eased threshold (1 of 2 yes) but unopposed —
    // the count-based lazy clock is running, so the pill shows the countdown
    // with the tally riding along ("Goes live in ~2d · 1/2").
    mk(9000019, 900119,
      '[Mock] Lazy-consensus test: one supporter, nobody objecting — merges when the clock elapses',
      5, 1, 0, 1, { required: 2, windowEndsAt: hoursAhead(67) }),
    // Placeholder title: the LLM was unavailable when this PR was titled,
    // so it carries the fallback template and the "Auto-title pending"
    // chip (pr_title_fallback → _autoTitleChip) is reviewable via ?demo=1.
    {
      ...mk(9000020, 900120, "[Mock] staging-tester's changes",
        4, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(60) }),
      pr_title_fallback: true,
    },
    // #1688: the viewer said yes to an EARLIER version of this one, and the
    // author has since pushed a new one. Their vote is on the row but no
    // longer counted, so the card's button asks "Still yes?" instead of
    // "Vote" — reviewable on staging via ?demo=1.
    {
      ...mk(9000039, 900139,
        '[Mock] Re-confirm test: you said yes to an earlier version of this proposal',
        30, 0, 0, 2, { required: 2, windowEndsAt: null }),
      my_prior_vote: 'yes',
    },
    // One No vote: eased threshold restored, window pushed back out.
    mk(9000002, 900102,
      '[Mock] Long-title test: walk brand-new collaborators through '
      + 'voting, kudos and dev sessions step by step',
      11, 1, 1, 0, { required: 5, windowEndsAt: hoursAhead(120) }),
    // Contested (No >= 1/3): window no longer applies, pure full-majority
    // count gate — no countdown, "Contested" treatment.
    mk(9000015, 900115,
      '[Mock] Contested test: switch the default theme from light to dark',
      8, 4, 3, 5, { required: 6, windowEndsAt: null, contested: true }),
    // #239/#388: a row mid-auto-conflict-resolution so the "Resolving
    // conflicts…" badge is verifiable on staging via ?demo=1 without
    // manufacturing a real merge conflict. Aged to ~10h so that, without
    // the #388 merge-pipeline pin, recency alone would sink it down the
    // list — making the pin (which lifts it near the top) obvious.
    {
      ...mk(9000003, 900103,
        '[Mock] Resolving-state test: add a dark-mode toggle to the settings drawer',
        10, 2, 0, 2, { required: 2, windowEndsAt: hoursAhead(40) }),
      resolving: true,
    },
    // #388: a row in the GitHub merge pipeline ('merging') so the
    // "Merging…" badge — and the top-of-stack pin — are verifiable on
    // staging via ?demo=1. Deliberately the OLDEST mock (~13h) so without
    // the pin it would sort dead last; the pin must lift it to rank 0,
    // above every other proposal.
    {
      ...mk(9000006, 900106,
        '[Mock] Merging-state test: this PR is mid-merge and should pin to the very top',
        13, 4, 0, 5),
      status: 'merging',
    },
    // #388: a row whose automatic conflict resolution failed
    // (merge_conflict_state 'failed') so the "⚠ Conflict resolution
    // failed" badge, the expanded conflicting-file list, and the pin
    // (just below merging + resolving) are verifiable via ?demo=1. Aged
    // ~12h so recency alone wouldn't float it.
    {
      ...mk(9000007, 900107,
        '[Mock] Conflict-failed test: auto-resolve could not finish; owner must fix it',
        12, 3, 1, 2, { required: 5 }),
      merge_conflict_state: 'failed',
      behind_main: 2,
      conflict_files: ['src/app.js', 'public/index.html'],
      conflict_checked_at: hoursAgo(11),
    },
    // #124: a visibility-change proposal (a dapp.json PR opened by the
    // Members & visibility modal) so its self-describing card is
    // reviewable on staging via ?demo=1.
    mk(9000004, 900104,
      '[Mock] Make this app invite-only build, public to view',
      2, 1, 0, 1, { required: 2, windowEndsAt: hoursAhead(60) }),
    // #695: the issue's exact report — an invited-approver row where MORE
    // THAN ONE non-approver has voted and no approver has. The approver-only
    // headline pill ("0 of 1 approvals"), the "+2 advisory" chip, and the
    // "Yes (0✓ +2)" button labels are reviewable via ?demo=1 without
    // hand-seeding an approver roster. (Sibling of 9000023, which shows the
    // single-advisory-vote variant.)
    {
      ...mk(9000025, 900125,
        '[Mock] Approver-mode test: two supporters, but no invited approver has voted yet',
        2, 2, 0, 1, { required: 1 }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // Auto-takedown — slim No majority (No just edges ahead of Yes, under the
    // 1/3 keep-alive line): long rejection window → "Set aside in ~6d".
    mk(9000016, 900116,
      '[Mock] Rejection test: replace the home feed with an infinite-scroll redesign',
      30, 2, 3, 6, { required: 6, rejectEndsAt: hoursAhead(140), rejectionArmed: true }),
    // Auto-takedown — lopsided opposition (No heavily outweighs Yes): short
    // rejection window → "Set aside in ~Xh".
    mk(9000017, 900117,
      '[Mock] Rejection test: drop dark mode entirely to simplify the theme code',
      18, 1, 6, 4, { required: 6, rejectEndsAt: hoursAhead(7), rejectionArmed: true }),
    // Kept-alive despite No > Yes: Yes fraction >= 1/3 cancels the rejection
    // clock entirely (Contested, not rejected) → normal tally, no countdown.
    mk(9000018, 900118,
      '[Mock] Kept-alive test: add keyboard shortcuts even though some object',
      9, 7, 9, 5, { required: 11, contested: true, rejectionArmed: false }),
    // #788: explicit-approval rows. app_admins is a table this change
    // creates, so a staging clone has none, and no real proposal there
    // touches dapp.json's admins block — without these three the chip,
    // the suppressed countdown and the new help text are unreviewable in
    // any PR preview. All carry merge_window_ends_at: null (the no-timer
    // modifier zeroes the window), which is exactly what makes the
    // countdown disappear.
    //
    // (a) Below threshold. Normally 1 Yes / 0 No with a 3-vote threshold
    // arms lazy consensus and renders "merges in ~3d — silence counts as
    // agreement"; flagged, it renders NO countdown at all.
    {
      ...mk(9000030, 900130,
        '[Mock] Explicit-approval test: add @staging-demo-maintainer as an app admin',
        20, 1, 0, 2, { required: 3 }),
      requires_explicit_approval: true,
    },
    // (b) Threshold met. No visibility window to sit out — it goes
    // straight to "queued to merge shortly" the moment the third Yes
    // lands, instead of starting a multi-day countdown.
    {
      ...mk(9000031, 900131,
        '[Mock] Explicit-approval test: remove an app admin (threshold reached)',
        26, 3, 0, 4, { required: 3 }),
      requires_explicit_approval: true,
    },
    // (c) Rejection still applies. The auto-takedown countdown is
    // untouched by the modifier, so a flagged proposal the group is
    // voting down still shows "Set aside in ~Xh" and still auto-closes.
    {
      ...mk(9000032, 900132,
        '[Mock] Explicit-approval test: admins change nobody wants (rejecting)',
        22, 0, 3, 3, { required: 3, rejectEndsAt: hoursAhead(9), rejectionArmed: true }),
      requires_explicit_approval: true,
    },
    // ── #1442 freshness fixtures ───────────────────────────────────────
    //
    // The three states the issue is about, each of which used to be
    // invisible on a promoted proposal because nothing re-measured it. They
    // exist as fixtures because none of them can be reached in a preview by
    // clicking: they need main to move underneath a proposal that is already
    // waiting for votes.
    //
    // (a) Behind main but still merging cleanly. This is the mild case, and
    // the one the old card got LOUDEST about — being behind used to render
    // an amber "Behind main · N" block reason, which meant the pill said
    // "attention" for something that resolves itself. It is now a plain
    // caption and the vote tally stays visible.
    {
      ...mk(9000033, 900133,
        '[Mock] Freshness test: eight commits behind main, still merges cleanly',
        6, 2, 0, 3, { required: 3, windowEndsAt: hoursAhead(20) }),
      behind_main: 8,
      freshness_behind_by: 8,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      mergeability: 'clean',
    },
    // (b) The issue's own proposal: behind main AND predicted to conflict.
    // The seven paths are the ones `git merge-tree` reported for PR #1431,
    // so the conflicting-file list renders at a realistic length. This is a
    // PREDICTION, which is why it sets `mergeability` and NOT
    // merge_conflict_state — nothing has attempted a merge, so the
    // conflict-resolver must not see this row as one it can drain.
    {
      ...mk(9000034, 900134,
        '[Mock] Freshness test: conflicts with main in seven files',
        9, 3, 0, 5, { required: 4 }),
      behind_main: 8,
      freshness_behind_by: 8,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      mergeability: 'conflict',
      mergeability_files: [
        'public/js/app-view.js',
        'public/js/merge-status.js',
        'src/routes/votes.js',
        'src/services/mcp-tools.js',
        'src/services/visuals.js',
        'src/db/schema.sql',
        'dapp.json',
      ],
      mergeability_files_complete: true,
    },
    // (e) #2038: the three states the SERVER now names, rather than the
    // browser guessing from a precedence table. Each carries its own
    // measuredAt, because the card says how old the answer is — a number
    // stated without its age is a claim about the present that a cache
    // cannot support, and that was the whole shape of the "the UI is out of
    // sync" reports.
    {
      ...mk(9000081, 900181,
        '[Mock] #2038: the votes are in, the checks are still running',
        4, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 40 * 1000).toISOString(),
      integration_behind_by: 0,
      integration_merges_clean: true,
      check_state: 'pending',
    },
    {
      ...mk(9000082, 900182,
        '[Mock] #2038: approved, and being brought up to date with main',
        5, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 5 * 1000).toISOString(),
      integration_behind_by: 6,
      integration_merges_clean: true,
      integration_block_reasons: ['integrating'],
    },
    {
      ...mk(9000083, 900183,
        '[Mock] #2038: GitHub refused the merge, measured ten minutes ago',
        7, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      integration_behind_by: 12,
      integration_merges_clean: false,
      integration_conflict_paths: ['src/routes/votes.js', 'public/js/merge-status.js'],
      // Derived by the card from this column, not restated by the server.
      merge_conflict_state: 'conflict',
    },
    // (f) #2061: what a proposal still NEEDS, rather than only what is
    // currently wrong with it. Each carries a merge_requirements record in
    // exactly the shape checkAndMerge writes, so the card's checklist — and
    // the three declared checks over it — are reviewable on ?demo=1 without
    // manufacturing a locked app or an unset platform variable.
    //
    // The four differ in WHO is waiting, which is the axis the whole feature
    // turns on: the card opens itself only for the person who can act.
    {
      ...mk(9000091, 900191,
        '[Mock] #2061: nothing needs you — being brought up to date',
        3, 3, 0, 2, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: true },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'active', detail: { behindBy: 2, note: '2 commits behind, so the platform is merging main in' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 20 * 1000).toISOString(),
    },
    {
      ...mk(9000092, 900192,
        '[Mock] #2061: waiting on an admin, because this app is locked',
        6, 4, 0, 3, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: true, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '4 of 3' } },
          { key: 'admin_yes', state: 'waiting', detail: { note: 'This app is locked, so an admin has to vote yes as well' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    },
    {
      ...mk(9000093, 900193,
        '[Mock] #2061: waiting on the author — two checks are failing',
        5, 3, 0, 4, { required: 3 }),
      check_state: 'failing',
      test_results: [
        { name: 'Kudos totals survive a rename', path: '/dev', status: 'fail' },
        { name: 'The board folds on a narrow screen', path: '/dev', status: 'fail' },
      ],
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'done', detail: { note: 'level with main, merges cleanly' } },
          { key: 'checks', state: 'blocked', detail: { checkState: 'failing', failingCount: 2, note: '2 failing. They re-run on the next push' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 90 * 1000).toISOString(),
    },
    {
      ...mk(9000094, 900194,
        '[Mock] #2061: everything cleared, merging now',
        2, 3, 0, 1, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'done', detail: { note: 'level with main, merges cleanly' } },
          { key: 'checks', state: 'done', detail: { checkState: 'passing' } },
          { key: 'github', state: 'done', detail: { note: 'merged' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 8 * 1000).toISOString(),
    },
    // (c) Checks passed, against a base main has since moved past. The
    // verdict is real and the tests did pass; what they passed against is no
    // longer what this would merge into. Soft on purpose: it is a caveat on
    // a green result, not a failure, so it never blocks the vote.
    {
      ...mk(9000035, 900135,
        '[Mock] Freshness test: checks passed on a base main has moved past',
        14, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      checks_base_sha: '1111aaaa2222bbbb3333cccc4444dddd5555eeee',
      checks_base_verdict: 'superseded',
      checks_base_behind_by: 12,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      behind_main: 3,
      freshness_behind_by: 3,
    },
    // (d) Nothing measured yet, plus a recorded failure. GitHub answers
    // `mergeable: null` while it computes a merge, and the whole point of
    // the nullable columns is that this reads as "not measured" rather than
    // as "clean" — a fixture exists so the unknown wording is reviewable
    // instead of only appearing during a GitHub outage.
    {
      ...mk(9000036, 900136,
        '[Mock] Freshness test: freshness not measured yet (GitHub unreachable)',
        1, 1, 0, 0, { required: 3 }),
      mergeability: 'unknown',
      mergeability_files: [],
      mergeability_files_complete: null,
      checks_base_verdict: 'unknown',
      checks_base_behind_by: null,
      freshness_behind_by: null,
      freshness_ahead_by: null,
      freshness_main_sha: null,
      freshness_merge_base_sha: null,
      freshness_error: 'Could not read the repository from GitHub (request failed).',
    },
    // #381: a proposal whose staging preview logged console errors, so the
    // amber "⚠ Console errors" badge and the expanded error list in the
    // detail view are reviewable on staging via ?demo=1.
    {
      ...mk(9000005, 900105,
        '[Mock] Console-error test: refactor the feed renderer (logs errors on load)',
        4, 1, 0, 3, { required: 2 }),
      console_check_state: 'errors',
      console_errors: [
        { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
        { kind: 'console', message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', source: '/api/feed:0' },
      ],
      // #47: same proposal fails its checks — the amber "⚠ Checks failing"
      // badge + the per-test detail (a console-error failure plus a
      // missing-selector failure) are reviewable via ?demo=1, and the gate
      // would block this merge.
      check_state: 'failing',
      // #447: `recheckable` makes the "Re-run checks" button render under
      // ?demo=1 regardless of the viewer's owner/admin status (real rows
      // never carry it). Set on every non-passing checks mock.
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        {
          name: 'Feed renders', path: '/#/feed', status: 'fail',
          consoleErrors: [
            { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
          ],
          failureReason: '1 console error on load',
        },
        {
          name: 'Composer is visible', path: '/#/feed', status: 'fail',
          consoleErrors: [],
          failureReason: 'Expected element ".composer" was not found',
        },
      ],
    },
    // #47: a proposal still running its checks — the grey "Checks running…"
    // spinner badge is reviewable via ?demo=1, and the gate would block the
    // merge until the run reports. #607: the run started ~2 minutes ago
    // (checks_checked_at override), so the detail shows the fresh state —
    // spinner + "Started 2 minutes ago" with NO re-run button (recheckable
    // is set, but the freshness gate hides the escape hatch).
    {
      ...mk(9000008, 900108,
        '[Mock] Checks-pending test: tests are still running on the staging build',
        5, 2, 0, 1),
      check_state: 'pending',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.03),
    },
    // The two STAGE captions a 'pending' run can render. A checks run has two
    // very differently-sized halves (build + DB clone, then the headless
    // suite) and both used to show one opaque "Checks are still running…", so
    // a mid-flight build was indistinguishable from a wedged one. These two
    // rows are the only way to review both captions in a preview — a real
    // staging clone has no in-flight run to look at. The fixture above keeps
    // check_phase absent on purpose: it is the NULL/legacy-wording case, and
    // it carries no check_trigger either — the pre-#1144 rows that predate the
    // column render with no "why is this running" caption at all.
    //
    // #1144: check_trigger is the other half of the pending detail. A run that
    // the platform started for itself (a boot reconcile, a stuck sweep) used to
    // be indistinguishable from one the author asked for, which is exactly the
    // confusion that made re-runs look like flakes. These two rows carry the
    // two ends of that range — an author's commit, and a platform restart.
    {
      ...mk(9000022, 900122,
        '[Mock] Checks-phase test: preparing the staging preview (build + DB clone)',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'building',
      check_trigger: 'commit-push',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
    },
    {
      // 9000026, not 9000023: the "at least N approvals" fixture further
      // down already owns 9000023, and a duplicate id meant this row won the
      // render — an approvals proposal that permanently showed
      // "Checks running…" instead of its approvals pill.
      ...mk(9000026, 900126,
        '[Mock] Checks-phase test: running the automated tests against the preview',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'testing',
      check_trigger: 'stuck-sweep',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
    },
    // The fifth build step. The container is up (four steps done, 20s) but
    // the run is parked behind an earlier capture on the same proposal —
    // the state the card used to spend minutes in reading "4/4" under
    // "Preparing the staging preview…". The step row names the wait; the
    // only way to review it, since a real preview has no queued run to show.
    {
      ...mk(9000028, 900128,
        '[Mock] Checks-phase test: preview built, waiting behind an earlier run',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'building',
      check_trigger: 'pr-import',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
      checks_progress: {
        build: {
          step: 'prepare_checks',
          queued: true,
          startedAt: hoursAgo(0.015),
          steps: mockBuildSteps(),
          totalMs: 19964,
        },
        updatedAt: hoursAgo(0.015),
      },
    },
    // #607: a freshly promoted proposal whose first checks run hasn't even
    // stamped 'pending' yet (staging build still going) — NO verdict, NO
    // console snapshot. The grey "Checks starting…" spinner badge + the
    // "Checks are starting…" detail block (with no re-run button, since the
    // row is minutes old) are reviewable via ?demo=1.
    {
      ...mk(9000021, 900121,
        '[Mock] Checks-starting test: just promoted, the first run has not begun yet',
        0.05, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(71) }),
      check_state: null,
      console_check_state: null,
      console_errors: [],
      console_checked_at: null,
      test_results: [],
      checks_checked_at: null,
    },
    // #447: a proposal STUCK in 'pending' — it crossed the vote threshold but
    // its checks have been "running" far longer than any real run takes
    // (checks_checked_at ~2h ago, well past CHECKS_STALE_MS). This is the
    // exact #447 failure: permanently blocked from merging with the old
    // "still running its tests" message. Verifies the stale-pending copy +
    // the "Re-run checks" button (and, on a live server, the boot/sweep
    // reconcile that would re-run it). yes_count is set above any plausible
    // staging majority so the row reads as past-threshold.
    {
      ...mk(9000011, 900111,
        '[Mock] Stuck-checks test: pending past the stale window',
        2, 9, 0, 1),
      check_state: 'pending',
      recheckable: true,
      test_results: [],
    },
    // #47: a proposal whose checks could not run (staging build / capture
    // broke) — the red "⚠ Checks couldn't run" badge is reviewable via
    // ?demo=1, and the gate blocks fail-closed.
    {
      ...mk(9000009, 900109,
        '[Mock] Checks-error test: the staging build or test run itself broke',
        6, 1, 0, 0, { required: 2 }),
      check_state: 'error',
      recheckable: true,
      test_results: [],
    },
    // #1771: the same red badge, for the one cause that is NOT the author's
    // to fix. A staging preview starved of Postgres connections used to
    // record its 500s as assertion failures against the diff; it is an
    // 'error' with an attribution sentence now, and this row is how that
    // sentence is reviewable in a preview. The detail comes from the
    // function that writes the real ones, so the fixture cannot drift from
    // the copy an author actually sees.
    {
      ...mk(9000045, 900145,
        '[Mock] Checks-error test: the preview was starved of database connections',
        4, 1, 0, 1, { required: 2 }),
      check_state: 'error',
      check_error_detail: connectionExhaustionMessage(
        { max: 100, used: 98 }, { where: 'ran its checks' }
      ),
      recheckable: true,
      test_results: [],
    },
    // #461: a proposal whose checks were explicitly SKIPPED (nothing to
    // test — e.g. the branch carries no commits beyond main). The grey
    // non-blocking "Checks skipped" badge + its reason tooltip are
    // reviewable via ?demo=1; the gate treats 'skipped' like 'passing', so
    // with yes_count past any plausible staging majority this row reads as
    // vote-complete and NOT checks-blocked.
    {
      ...mk(9000012, 900112,
        '[Mock] Checks-skipped test: nothing to test for this proposal',
        3, 9, 0, 1),
      check_state: 'skipped',
      check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
      recheckable: true,
      test_results: [],
    },
    // #405: a proposal that PASSED the vote with green checks and is not
    // behind — eligible and queued to merge. Verifies the new green
    // "Passed — merging shortly" badge on the feed card + home strip via
    // ?demo=1. yes_count is set well above any plausible staging majority so
    // the row reliably reads as past-threshold (the vote pill fills green).
    mk(9000010, 900110,
      '[Mock] Ready-to-merge test: votes passed and checks are green — queued to merge',
      4, 9, 0, 3),
    // #646: an "at least N approvals" proposal awaiting its approval —
    // approval_policy/approvals_required drive the clock-free
    // "x of N approvals" pill and the new How-voting-works copy. The raw
    // tally carries an advisory community vote (yes_count 1) while the
    // QUALIFYING count is still 0, so the advisory-vs-approver split is
    // reviewable via ?demo=1.
    {
      ...mk(9000023, 900123,
        '[Mock] Approvals test: needs 1 approval from an invited approver before it merges',
        3, 1, 0, 2, { required: 1, windowEndsAt: null }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // #646: the reached counterpart — the approval target is met, so the
    // pill fills green ("2 of 2 approvals") and the help text reads
    // "queued to merge shortly".
    {
      ...mk(9000024, 900124,
        '[Mock] Approvals test: target reached — 2 of 2 approvals, merging shortly',
        5, 3, 0, 1, { required: 2, windowEndsAt: null }),
      approval_policy: 'invited',
      approvals_required: 2,
      qualified_yes_count: 2,
      qualified_no_count: 0,
    },
    // #639: an issue-linked proposal that carries NO attribute votes of its
    // own, so its priority/assignee chips are INHERITED from the origin issue
    // (#900006, seeded medium / maya-builder in the issues feed). This makes
    // the "chips no longer vanish when a task is proposed for voting" fix
    // reviewable on the In-review card via ?demo=1. linked_issues points the
    // card at that mock issue; the inline priority/assignee stand in for what
    // the inheritance query computes (mock rows bypass the DB summarize path).
    {
      ...mk(9000027, 900127,
        '[Mock] Inherited-attrs test: promoted from issue #900006 — chips carry over',
        7, 2, 0, 1, { required: 2, windowEndsAt: hoursAhead(50) }),
      linked_issues: [900006],
      priority: { top: 'medium', count: 2, myValue: null },
      assignee: { top: 'maya-builder', count: 3, myValue: null },
    },
    // #866: the three states of the Preview slot on an IMPORTED proposal.
    //
    // These can't be seeded in the DB the way the imported-PR fixtures in
    // migrate.js are: `staging_building` is derived per request from the
    // in-memory build registry (staging.hasInFlightBuild — deliberately not a
    // persisted column), so a seeded row can only ever render the "no
    // preview" state. Mock rows carry the derived flags explicitly, which is
    // the only way to review all three pills in a staging preview.
    //
    // The fork label lives on the IMPORT PICKER, not the card (mock candidate
    // 9403 in services/github-mock.js is the fork-headed one) — a card has no
    // head-repo of its own to report.
    //
    // (a) Preview ready: the build landed, so the ordinary Preview button
    // renders. The URL is deliberately unroutable — clicking it opens the
    // loader and reports the host as unreachable, which is the point of a
    // mock; the button's presence is what's under review.
    {
      ...mk(9000041, 900141,
        '[Mock] Imported-preview test: preview built — the Preview button is live',
        3, 2, 0, 2, { required: 2, windowEndsAt: hoursAhead(44) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: 'https://mock-preview--000000.staging.invalid',
      staging_building: false,
      staging_error: null,
    },
    // (b) Preview building: imported moments ago, the SHA-pinned build is
    // still running. Renders the non-interactive "Preview building…" spinner
    // pill plus the prose note in the detail view, with checks pending
    // because they run against the preview that doesn't exist yet.
    {
      ...mk(9000042, 900142,
        '[Mock] Imported-preview test: preview still building — spinner pill, no button',
        0.08, 0, 0, 0, { required: 2, windowEndsAt: hoursAhead(71) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: null,
      staging_building: true,
      staging_error: null,
      check_state: 'pending',
      test_results: [],
      checks_checked_at: hoursAgo(0.05),
    },
    // (c) Preview unavailable: the build failed, so there is nothing to
    // preview and checks can't run. Renders the "Preview unavailable" chip
    // (reason in the tooltip), the amber prose note, and — for a viewer who
    // can act — the "Retry preview" button beside it. check_error_detail
    // carries the same reason the chip shows, exactly as a real error row
    // does (recordStagingBootFailure writes both).
    {
      ...mk(9000043, 900143,
        '[Mock] Imported-preview test: preview failed to build — unavailable chip + retry',
        2, 1, 0, 1, { required: 2 }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: null,
      staging_building: false,
      staging_error: 'app failed to boot in its staging container: missing required secret DEMO_API_KEY',
      check_state: 'error',
      check_error_detail: 'app failed to boot in its staging container: missing required secret DEMO_API_KEY',
      recheckable: true,
      test_results: [],
    },
    // A proposal submitted through the hosted MCP connector — Claude Code
    // wrote it in the user's own fork, and submit_work carried the testing
    // routes and steps with the import. THREE things only line up on one row:
    // the "built with Claude Code" chip beside the imported badge, a "How to
    // test" panel + "Test this change" deep link on an IMPORTED proposal, and
    // failing checks on work the platform did not build itself.
    //
    // Seeded because a staging clone cannot have one: every imported row in
    // production carries testing_md / testing_path NULL, since until this
    // change nothing on the import path could set them.
    {
      ...mk(9000044, 900144,
        '[Mock] Connector test: imported from Claude Code with testing notes, checks failing',
        7, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      source: 'imported',
      imported_pr_author: 'staging-tester',
      external_agent: 'claude-code',
      testing_md: '1. Open the board. The new "Snap to grid" toggle sits above the columns.\n'
        + '2. Turn it on and drag a card: it should snap to the nearest column.\n'
        + '3. Reload the page. The toggle keeps its setting.',
      testing_path: '/board?demo-pr=1',
      check_state: 'failing',
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        {
          name: 'Board shows the snap toggle', path: '/board?demo-pr=1', status: 'fail',
          consoleErrors: [],
          failureReason: 'Expected element ".snap-toggle" was not found',
        },
      ],
    },
    // ── Card-as-pointer revision fixtures ──
    // A row with several reasons at once, which no other mock has. It was
    // added when the status bar named ONE reason and counted the rest in a
    // tooltip; it proves the opposite now — the bar is the vote, and every
    // reason is its own tag, colour-coded by whether it blocks the merge. The
    // three here are deliberately one hard and two soft, so a preview shows
    // both tints beside a live tally.
    {
      ...mk(9000050, 900150,
        '[Mock] Multi-reason test: behind main AND checks failing AND console errors',
        7, 2, 0, 4, { required: 3 }),
      behind_main: 3,
      console_check_state: 'errors',
      console_errors: [
        { kind: 'pageerror', message: "TypeError: Cannot read properties of null (reading 'id')", source: 'board.js:88' },
        { kind: 'console', message: 'Failed to load resource: 502 (Bad Gateway)', source: '/api/board:0' },
      ],
      check_state: 'failing',
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        { name: 'Board renders', path: '/#/board', status: 'fail', consoleErrors: [], failureReason: 'expected selector .board not found' },
        { name: 'Settings opens', path: '/#/settings', status: 'fail', consoleErrors: [], failureReason: 'navigation timed out' },
      ],
    },
    // Unset metadata: EVERY other mock carries priority + assignee +
    // category (the mk factory stamps all three), so without this row the
    // "no grey Set-priority / Set-category / Unassigned placeholders" rule
    // is invisible in a preview. The nulls are applied after mk() below.
    mk(9000051, 900151,
      '[Mock] Bare-card test: no priority, no category, nobody assigned',
      9, 1, 0, 0, { required: 2 }),
    // Provenance overload: four facts that used to be four badges competing
    // for the four badge slots, now all on the meta line. Proves the badge
    // cap holds and the provenance still reads.
    {
      ...mk(9000052, 900152, "[Mock] staging-tester's changes",
        6, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      external_agent: 'codex',
      pr_title_fallback: true,
      staging_url: 'https://mock-preview.invalid',
    },
    // Band overload: the worst case for the four-band card, in one row. A
    // title long enough to need a THIRD line (so the two-line clamp is
    // visibly doing something), a long meta line, all four metadata chips,
    // two linked issues AND the widest action set a card can carry (Yes / No
    // / Explore / Preview) — so a preview shows whether any band clips a
    // pill through the middle rather than dropping the surplus row whole.
    // Every other mock exercises one band; this one loads all four at once.
    {
      ...mk(9000053, 900153,
        '[Mock] Band-overload test: a deliberately enormous proposal title that runs '
        + 'well past two lines in a kanban column so the clamp, the reserved band '
        + 'heights and the pill clipping can all be judged on one card',
        2, 2, 1, 7, { required: 4, windowEndsAt: hoursAhead(28) }),
      linked_issues: [900004, 900005],
      staging_url: 'https://mock-preview.invalid',
      priority: { top: 'high', count: 4, myValue: null },
      assignee: { top: 'maya-builder', count: 2, myValue: null },
      category: { top: 'staging demo onboarding', count: 3, myValue: null },
    },
  ];
  // Spread the community-voted priority/assignee across a few rows (the mk
  // factory otherwise stamps every proposal high / staging-tester) so the
  // kanban board's Priority and Assignee filters have >1 distinct value to
  // choose from and filtering visibly narrows the board. The assignees mirror
  // the mock issues' (staging-demo-user, maya-builder), so filtering by one of
  // them catches cards across both the issue and proposal columns.
  const attrOverrides = new Map([
    [9000001, { priority: { top: 'medium', count: 2, myValue: null }, assignee: { top: 'staging-demo-user', count: 2, myValue: null }, category: { top: 'improvement', count: 2, myValue: null } }],
    [9000002, { priority: { top: 'low', count: 1, myValue: null }, assignee: { top: 'maya-builder', count: 1, myValue: null }, category: { top: 'design', count: 1, myValue: null } }],
    // #780: a CUSTOM category on a PROPOSAL card too (matching the second
    // demo entry listCategories() appends in staging), so the custom chip is
    // reviewable across both card types and the filter catches both columns.
    [9000013, { priority: { top: 'low', count: 3, myValue: null }, assignee: { top: 'staging-demo-user', count: 1, myValue: null }, category: { top: 'staging demo onboarding', count: 2, myValue: null } }],
  ]);
  for (const row of rows) {
    const o = attrOverrides.get(row.id);
    if (o) { row.priority = o.priority; row.assignee = o.assignee; row.category = o.category; }
  }
  // The deliberately BARE card: mk() stamps all three attributes, so the
  // "unset chips don't render" rule needs one row to opt back out. Kept as
  // an explicit clear rather than a separate factory so a future field added
  // to mk() is visibly missing here too.
  for (const row of rows) {
    if (row.id === 9000051) {
      row.priority = null;
      row.category = null;
      row.assignee = null;
    }
  }
  // #2170: the run's cost survives its verdict — storeChecks reduces the
  // live progress to the finished build and the checks' wall clock instead
  // of dropping it — so every mock that HAS a verdict carries the shape a
  // real passed or failed row does, and the ledger's "built in 20s ·
  // checked in 4m 12s" line is reviewable via ?demo=1. Applied after the
  // literals, like the attribute overrides above, because mk() cannot
  // stamp it without leaking into the pending mocks: a run in flight keeps
  // its live shape (9000028) or has none, exactly as a real one would.
  for (const row of rows) {
    if ((row.check_state === 'passing' || row.check_state === 'failing') && row.checks_progress === undefined) {
      row.checks_progress = {
        build: { step: 'done', steps: [...mockBuildSteps(), { key: 'prepare_checks', ms: 3011 }], totalMs: 19964 },
        checksMs: 252000,
      };
    }
  }
  return rows.map((p) => {
    // #600: seed the FIRST mock proposal's assignee as the viewer's own so
    // opening its dropdown shows the "already voted" state (name box empty,
    // viewer's pick checked). Everyone else stays assigned to staging-tester
    // with myValue null, so their dropdown pre-fills the viewer's username.
    if (viewer && p.id === 9000001) {
      return { ...p, assignee: { top: viewer, count: 2, myValue: viewer } };
    }
    return p;
  });
}

// #194: staging demo rows for the Completed (merged) list, mirroring
// stagingMockProposals. Lets ?demo=1 verify the new clickable Completed
// rows, the chevron/hover affordance, and the 💬 badge against a
// prod-cloned DB. Caveat: these mock rows have NO backing chat_messages,
// so opening one shows an empty (but still postable) thread — useful for
// the card affordance + badge, not for existing-comment display.
function stagingMockMerged() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, prNumber, title, days, chat) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation at the top of a completed proposal, in everyday '
      + 'words, with no technical jargon.',
    user_id: 0,
    status: 'merged',
    linked_issues: null,
    username: 'staging-tester',
    created_at: daysAgo(days),
    // #1264: mocks merge the moment they were created — good enough for
    // reviewing the report's "Merged <date>" label and monthly strip.
    merged_at: daysAgo(days),
    promoted_at: daysAgo(days),
    revert_of_session_id: null,
    votes_required: 2,
    active_users_at_merge: 3,
    yes_count: 2,
    no_count: 0,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    chat_count: chat,
    revert_session_id: null,
    revert_pr_number: null,
    revert_pr_url: null,
    revert_status: null,
    // #381: merged mocks are clean by default (the warning is reviewable on
    // the promoted list); these keep the detail view from reading undefined.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: daysAgo(days),
    // #47: a merged proposal passed its checks by definition of the gate.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: daysAgo(days),
    // Read-only priority + assignee chips persist on completed proposals.
    priority: { top: 'medium', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 2, myValue: null },
  });
  // #429: 26 mock rows (> one 20-row page) so the "Load more" pager and
  // the hasMore flag are exercisable in a ?demo=1 staging preview. Each
  // has a distinct created_at (1..26 days ago) so keyset paging orders
  // them deterministically, newest first.
  const titles = [
    'tighten the empty-state copy on the dev forum',
    'bump the chat composer hit area on mobile',
    'fix the dark-mode contrast on vote pills',
    'debounce the proposal search box',
    'add keyboard focus rings to the kebab menu',
    'shorten the merged-PR relative timestamps',
    'collapse long PR summaries behind a toggle',
    'align the kudos count with the avatar row',
    'cache the leaderboard avatars for a session',
    'wrap long usernames in the activity feed',
    'add a copy-link button to merged proposals',
    'fix the sticky header on the issues tab',
    'lazy-load the kanban Done column images',
    'trim trailing whitespace in PR titles',
    'add an empty-state for the Completed list',
    'fix the scroll jump when expanding a thread',
    'show the merge date in the card tooltip',
    'group governance proposals under one header',
    'dim already-voted proposals in the list',
    'add a subtle divider between feed sections',
    'fix the wrap on long linked-issue chips',
    'preload the vote roster on hover',
    'add a “back to top” affordance on long lists',
    'fix the badge alignment on RTL locales',
    'shorten the undo-confirmation copy',
    'add a hover state to the Load more button',
  ];
  // #451: the merged-list counterpart to the #405 "Ready-to-merge" promoted
  // mock — the same shape of proposal (votes passed, checks green) AFTER it
  // auto-merged on its own. Lets a ?demo=1 preview show the before/after of
  // the In-review → Completed transition the auto-merge trigger produces,
  // without staging ever performing a real GitHub merge. Newest row (0 days)
  // so it sorts to the top of the Completed list next to the live demo.
  const autoMerged = mk(
    9100000,
    910100,
    '[Mock] Auto-merged: votes passed and checks turned green — merged automatically (#451)',
    0,
    3
  );
  // #639: a COMPLETED proposal whose chips were inherited from its origin
  // issue (#900006, seeded medium / maya-builder). Confirms priority/assignee
  // stay visible (read-only) in the Done column after "close done", not just
  // while in review — the second half of the reported loss. linked_issues +
  // inline chip values mirror the promoted inherited-attrs mock above.
  const inheritedAttrs = {
    ...mk(9100027, 910127,
      '[Mock] Completed: inherited priority/assignee from issue #900006', 0, 2),
    linked_issues: [900006],
    priority: { top: 'medium', count: 2, myValue: null },
    assignee: { top: 'maya-builder', count: 3, myValue: null },
  };
  // Card-as-pointer revision: a merged proposal that ALREADY has a revert
  // in flight. Its "Undone by PR#…" relationship is a FACT about the change,
  // so it reads on the meta line rather than displacing the Undo action —
  // and Undo itself is correctly absent from the ⋯ menu (undoing an undo
  // would be an infinite loop).
  const undone = {
    ...mk(9100028, 910128,
      '[Mock] Completed: this one was undone — revert already merged', 0, 1),
    revert_session_id: 9100029,
    revert_pr_number: 910129,
    revert_pr_url: null,
    revert_status: 'merged',
  };
  // #1264: older completed rows (~35–150 days) so the report's
  // "Completed by month" strip shows several distinct months in a ?demo=1
  // preview instead of one bar. A little kudos variety rides along so the
  // report's new "N kudos" meta is reviewable too.
  const older = [
    [9100030, 910130, '[Mock] Completed: rework the onboarding checklist', 35, 2],
    [9100031, 910131, '[Mock] Completed: ship the notification digest', 70, 0],
    [9100032, 910132, '[Mock] Completed: split settings into sections', 110, 3],
    [9100033, 910133, '[Mock] Completed: first pass at the activity feed', 150, 0],
  ].map(([id, pr, title, days, kudos]) => ({
    ...mk(id, pr, title, days, 0),
    kudos_count: kudos,
  }));
  // #1264: a LEGACY completed row — merged before merged_at existed, so it
  // carries no merge time. Keeps the report's "Started <date>" fallback and
  // its conditional disclaimer reviewable in a preview.
  const legacy = {
    ...mk(9100034, 910134,
      '[Mock] Completed: legacy change with no recorded merge time', 95, 0),
    merged_at: null,
  };
  return [autoMerged, inheritedAttrs, undone].concat(titles.map((t, i) => mk(
    9100001 + i,
    910101 + i,
    `[Mock] Completed: ${t}`,
    i + 1,
    // Sprinkle a few discussion counts so the 💬 badge is visible.
    i % 3 === 0 ? 5 : 0
  ))).concat(older, [legacy]);
}

// Staging demo rows for APPLIED close-issue proposals in the Completed
// stream (row_type='close_issue'), so a ?demo=1 preview shows the new
// "Issue close" card interleaved among the merged mocks. One group-vote
// apply and one admin force-apply, exercising both "closed by vote" and
// "closed by admin" meta lines. Ids live outside the merged-mock range so
// the type-scoped de-dup never collides. The payload mirrors what
// maybeApplyCloseIssueProposal stamps (appliedAt/appliedBy + tally
// snapshot); the target is mock issue 900003 from stagingMockIssues.
function stagingMockCompletedCloseIssues() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, appliedBy, appliedDays, createdDays, chat) => ({
    row_type: 'close_issue',
    id,
    kind: 'close_issue',
    status: 'closed',
    title: '[Mock] Close issue #900003: "Topic cards overflow on narrow phones"',
    description: '[Mock] Fixed by the responsive rework — the buttons wrap now.',
    payload: {
      issueNumber: 900003,
      issueTitle: '[Mock] Topic cards overflow on narrow phones',
      reason: '[Mock] Fixed by the responsive rework — the buttons wrap now.',
      appliedAt: daysAgo(appliedDays),
      appliedBy,
      upCount: 2,
      required: 2,
      active: 3,
    },
    github_issue_number: null,
    created_by: 0,
    created_by_username: 'staging-tester',
    created_at: daysAgo(createdDays),
    up_count: 2,
    down_count: 0,
    chat_count: chat,
    last_message_at: null,
    // The tally the target issue carried while open — a closed task keeps
    // its priority/assignee/category chips in the Done column. Baked in
    // because mock rows are injected after the real rows' summarize pass.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'maya-builder', count: 2, myValue: null },
    category: { top: 'bug', count: 1, myValue: null },
  });
  return [
    mk(9100060, 'group-vote', 1, 2, 3),
    mk(9100061, 'admin:staging-admin', 4, 5, 0),
    // (#1115) A DELIBERATELY OLD applied close proposal. The mocks are only
    // injected on the demo stream's FIRST page and the merged mocks span
    // up to ~150 days (#1264 extended them for the report's monthly strip),
    // so a 400-day-old row can never appear in any /merged page — making it
    // reachable ONLY through GET /api/apps/:slug/governance/:id.
    // That is exactly the regression this mock exists to test: before the
    // by-id recovery path, deep-linking it bounced back to the board.
    mk(9100062, 'group-vote', 400, 402, 4),
  ];
}

// Global ordering for the unified Completed stream: newest created_at
// first; on a timestamp tie PR rows rank before close-issue rows (rank
// pr=1 > close_issue=0 — the same constant ranks the SQL keyset
// predicates encode), then id DESC. Deterministic even across the two
// id sequences (chat_sessions vs issues), which can collide numerically.
const COMPLETED_TYPE_RANK = { pr: 1, close_issue: 0 };
function completedRowCompare(a, b) {
  const ta = Date.parse(a.created_at) || 0;
  const tb = Date.parse(b.created_at) || 0;
  if (tb !== ta) return tb - ta;
  const ra = COMPLETED_TYPE_RANK[a.row_type || 'pr'] ?? 1;
  const rb = COMPLETED_TYPE_RANK[b.row_type || 'pr'] ?? 1;
  if (rb !== ra) return rb - ra;
  return b.id - a.id;
}

// Native proposals used to trust a mutable branch name all the way through
// voting and merge. A branch can move independently of the platform's review
// state, so every approval must be tied to an immutable PR head just like
// imported proposals already are.
//
// Imported proposals deliberately keep imported_pr_head_sha as their source of
// truth; this helper is native-only so their established sync behaviour stays
// unchanged.
function nativeGithubTarget(session) {
  if (!session || session.source === 'imported' || !session.pr_number) return null;
  const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

async function kickNativeRevisionChecks({ config, pool, session, headSha }) {
  const visuals = require('../services/visuals');
  await visuals.setChecksPending(pool, session.id, headSha, 'building', 'commit-push')
    .catch((err) => log.warn('votes', 'Native revision setChecksPending failed (non-fatal)', {
      sessionId: session.id, headSha, err: err.message,
    }));
  try { visuals.notifyChecksPending(session.id, headSha, 'building', 'commit-push'); } catch (_) {}

  const prImportSync = require('../services/pr-import-sync');
  prImportSync.rerunChecksForNewHead({
    config,
    pool,
    session,
    newHead: headSha,
  }).catch((err) => log.warn('votes', 'Native revision checks re-run failed', {
    sessionId: session.id, headSha, err: err.message,
  }));
}

// Imported PRs use their GitHub head as the reviewed revision. Stamp that
// revision pending before returning control to a promotion/vote request, then
// let the SHA-pinned preview rebuild continue in the background. The merge
// gate independently compares the verdict SHA, so even a failed pending write
// cannot let an older green result authorize this head.
async function kickImportedRevisionChecks({ config, pool, session, headSha }) {
  const visuals = require('../services/visuals');
  await visuals.setChecksPending(pool, session.id, headSha, 'building', 'pr-import')
    .catch((err) => log.warn('votes', 'Imported revision setChecksPending failed (non-fatal)', {
      sessionId: session.id, headSha, err: err.message,
    }));
  try { visuals.notifyChecksPending(session.id, headSha, 'building', 'pr-import'); } catch (_) {}

  const prImportSync = require('../services/pr-import-sync');
  prImportSync.rerunChecksForNewHead({
    config,
    pool,
    session,
    newHead: headSha,
  }).catch((err) => log.warn('votes', 'Imported revision checks re-run failed', {
    sessionId: session.id, headSha, err: err.message,
  }));
}

const SHA40_RE = /^[0-9a-f]{40}$/i;

function normalizedSha(value) {
  return typeof value === 'string' && SHA40_RE.test(value) ? value.toLowerCase() : null;
}

// #2038 — what a head move costs a proposal's approvals.
//
// This replaced a provenance ledger: session_platform_pushes, a five-hop
// first-parent walk, a three-way classifier keyed on recorded pushes, a
// "platform sync in flight, ask me later" race state, and a fail-closed
// branch for when GitHub would not say who a commit's parents were. All of
// that existed to tell the platform's own sync commit from an author's push,
// and it had to be built on recorded provenance because a commit's SHAPE can
// be forged — anyone can craft a merge whose first parent is the reviewed sha.
//
// services/integration.js answers the same question by REDOING the merge and
// comparing trees. Nothing to record, nothing to walk, nothing to forge, and
// no network: the mirror already has both commits.
//
// The outcome is spent in one place — the approval epoch. A mechanical merge
// does not touch it, so the approvals keep counting with nothing carried or
// advanced. Anything authored bumps it, and every tally in the platform stops
// counting the old votes in the same statement.
//
// `fresh` (#2619): this reads the branch tip out of the repo mirror, and the
// mirror coalesces one fetch per repository. A caller that has just PUSHED and
// is reading its own write back has to opt out of that, or it joins a fetch
// older than the push and is told the head did not move. Pass it whenever the
// push and this call are in the same request; leave it off for the sweeps and
// read paths, which have nothing of their own to see.
async function reconcileNativeReviewedHead({
  config, pool, session, fresh = false, notify = true, deferChecks = false,
}) {
  const integration = require('../services/integration');
  const mirror = require('../services/repo-mirror');

  const epochOf = (s) => {
    const n = parseInt(s?.approval_epoch, 10);
    return Number.isFinite(n) ? n : 0;
  };

  if (!session || session.source === 'imported') {
    return { enforced: false, headSha: reviewedHeadForSession(session), epoch: epochOf(session) };
  }
  if (!github.isEnabled()) {
    // Local/mock installations keep their PR-less behaviour: there is no
    // external mutable branch to protect.
    return { enforced: false, headSha: session.reviewed_head_sha || null, epoch: epochOf(session) };
  }
  if (!session.repo_url) {
    // No repository identity at all. A row that claims a pull request but has
    // lost its repository cannot be verified and must not merge on an
    // unverified head — this is the one case that still fails closed, because
    // there is nothing to fail open TO.
    if (!session.pr_number) {
      return { enforced: false, headSha: session.reviewed_head_sha || null, epoch: epochOf(session) };
    }
    return {
      enforced: true, blocked: true,
      reason: 'This proposal has no GitHub repository to verify.',
    };
  }
  if (!session.branch_name) {
    // A repository but no recorded branch: legacy rows, and imported
    // proposals whose head lives on the author's fork where the mirror cannot
    // see it. The head cannot be resolved locally, so leave the revision as it
    // stands — the exact-sha merge remains the guard. Same reasoning as the
    // unreadable-mirror path below.
    return {
      enforced: true, headSha: session.reviewed_head_sha || null,
      epoch: epochOf(session), unchanged: true, measurementUnavailable: true,
    };
  }

  const parsed = integration._parseRepo(session.repo_url);
  if (!parsed) {
    return {
      enforced: true, blocked: true,
      reason: 'This proposal has no valid GitHub repository to verify.',
    };
  }

  const oldHead = normalizedSha(session.reviewed_head_sha);
  let dir; let liveHead; let mainSha;
  try {
    dir = await mirror.ensureMirror(parsed.owner, parsed.repo, {
      refs: [oldHead, normalizedSha(session.checks_commit_sha)].filter(Boolean),
      // #2619: `fresh` was accepted here and then never used — seven call
      // sites asked for a re-read and silently got whatever fetch happened
      // to be in flight. It is the callers that have just PUSHED who need
      // it (proposal-update's two, merge-queue, cli-handoff-sync): without
      // it their reconcile reads the pre-push tip, concludes the head did
      // not move, and leaves the tally and the verdict on the old commit.
      fresh,
    });
    mainSha = await mirror.defaultBranchSha(dir);
    liveHead = await mirror.resolveBranch(dir, session.branch_name);
  } catch (err) {
    // Fail OPEN, deliberately, and this is the one place in the merge path
    // where that is the safe direction.
    //
    // The mirror is a cache of a repository, not the authority on it. The
    // authority is the exact-sha merge at the end of checkAndMerge, which
    // pins to the revision recorded here: if the head has moved and this
    // read did not notice, GitHub refuses the merge with a 409 and the
    // proposal comes straight back round to be reconciled properly. Nothing
    // can be merged on the strength of a head we failed to check.
    //
    // Failing closed, by contrast, would block every vote and every merge on
    // every app behind one unreachable git host — the same wedge the
    // explicit-approval check documents avoiding for a GitHub outage. A
    // proposal nobody can vote on is a worse outcome than a merge attempt
    // that GitHub declines.
    log.warn('votes', 'Mirror unreadable; leaving the reviewed revision as it stands', {
      sessionId: session.id, err: err.message,
    });
    return {
      enforced: true, headSha: oldHead, epoch: epochOf(session),
      unchanged: true, measurementUnavailable: true,
    };
  }

  if (!liveHead) {
    // The branch is not in the mirror: deleted, renamed, never pushed, or an
    // imported head that lives on a fork. Not a head move, and nothing here
    // may clear approvals over an absence. Same fail-open reasoning as above.
    log.info('votes', 'Branch not present in the mirror; revision left as it stands', {
      sessionId: session.id, branch: session.branch_name,
    });
    return {
      enforced: true, headSha: oldHead, epoch: epochOf(session),
      unchanged: true, measurementUnavailable: true,
    };
  }
  if (sameSha(liveHead, oldHead)) {
    return { enforced: true, headSha: liveHead, epoch: epochOf(session), unchanged: true };
  }

  // A row with no pin yet is being bound for the first time. Pre-#872
  // semantics counted its unbound votes anyway, so binding costs nothing and
  // must not clear anything.
  if (!oldHead) {
    await pool.query(
      `UPDATE chat_sessions SET reviewed_head_sha = $1, stale_notified_at = NULL WHERE id = $2`,
      [liveHead, session.id]
    );
    session.reviewed_head_sha = liveHead;
    if (session.visual_evidence_state || session.visual_evidence_detail) {
      await visualEvidenceState.markStaleForHead(pool, session.id, liveHead).catch((err) =>
        log.warn('votes', 'Visual evidence invalidation after revision bind failed', {
          sessionId: session.id, headSha: liveHead, err: err.message,
        }));
    }
    return {
      enforced: true, headSha: liveHead, epoch: epochOf(session),
      updated: true, initialized: true, changed: false, kind: 'initialized',
    };
  }

  const move = await integration.classifyHeadMove(dir, {
    approvedHead: oldHead, newHead: liveHead, mainSha,
  });

  // 'resolved' keeps the approvals — the bytes that differ from the
  // mechanical attempt all lie in files git itself could not merge, so the
  // resolution is bounded by the conflict — but the tree is one nobody has
  // tested, so its checks are always re-run below.
  const keepsApprovals = move.kind === 'mechanical' || move.kind === 'resolved';

  // One statement. If the epoch bump and the head install could land
  // separately, a crash between them would leave a row whose approvals
  // describe neither the old code nor the new.
  const { rows: claimed } = await pool.query(
    `UPDATE chat_sessions
        SET reviewed_head_sha = $1,
            stale_notified_at = NULL,
            approval_epoch = approval_epoch + CASE WHEN $3::boolean THEN 0 ELSE 1 END
      WHERE id = $2
        AND reviewed_head_sha IS NOT DISTINCT FROM $4::varchar
      RETURNING approval_epoch`,
    [liveHead, session.id, keepsApprovals, oldHead]
  );

  if (!claimed.length) {
    // Another verifier installed a revision while we were reading. Re-read
    // rather than reset a second time.
    const { rows } = await pool.query(
      `SELECT reviewed_head_sha, approval_epoch FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    session.reviewed_head_sha = rows[0]?.reviewed_head_sha || null;
    session.approval_epoch = rows[0]?.approval_epoch;
    if (sameSha(session.reviewed_head_sha, liveHead)) {
      return { enforced: true, headSha: liveHead, epoch: epochOf(session), unchanged: true };
    }
    return {
      enforced: true, blocked: true, transient: true,
      reason: 'The proposal changed while its revision was being verified. Try again.',
    };
  }

  const epoch = parseInt(claimed[0].approval_epoch, 10);
  session.reviewed_head_sha = liveHead;
  session.approval_epoch = epoch;
  if (session.visual_evidence_state || session.visual_evidence_detail) {
    await visualEvidenceState.markStaleForHead(pool, session.id, liveHead).catch((err) =>
      log.warn('votes', 'Visual evidence invalidation after head move failed', {
        sessionId: session.id, oldHead, headSha: liveHead, err: err.message,
      }));
  }

  // Checks policy follows who wrote the tree. A mechanical merge is pure git
  // over a tested branch and a tested main, so the verdict carries. Anything
  // else is an unverified tree and is re-checked against this exact commit.
  //
  // Only a SETTLED verdict about the OLD head can carry. The merge queue
  // supersedes any run in flight before it moves the branch (#1728), so a
  // 'pending' stamp here describes a run that will never report; carrying
  // it onto the new head would leave the row 'pending' with nothing building
  // until the stale sweeper noticed ten minutes later — the exact dead wait
  // #1728 measured. 'error' is a preview that did not boot, which a rebuild
  // against the merged commit is the right way to find out about.
  const checksCarry = move.kind === 'mechanical'
    && sameSha(session.checks_commit_sha, oldHead)
    && ['passing', 'skipped', 'failing'].includes(session.check_state);
  const needsChecks = !sameSha(session.checks_commit_sha, liveHead) && !checksCarry;
  if (needsChecks) {
    if (deferChecks) {
      const visuals = require('../services/visuals');
      await visuals.setChecksPending(pool, session.id, liveHead, 'building', 'commit-push')
        .catch((err) => log.warn('votes', 'Deferred setChecksPending failed (non-fatal)', {
          sessionId: session.id, headSha: liveHead, err: err.message,
        }));
      try { visuals.notifyChecksPending(session.id, liveHead, 'building', 'commit-push'); } catch (_) {}
    } else {
      await kickNativeRevisionChecks({ config, pool, session, headSha: liveHead });
    }
  } else if (checksCarry && !sameSha(session.checks_commit_sha, liveHead)) {
    await pool.query(
      `UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = $2`,
      [liveHead, session.id]
    ).catch((err) => log.warn('votes', 'Carrying checks stamp failed (non-fatal)', {
      sessionId: session.id, headSha: liveHead, err: err.message,
    }));
    session.checks_commit_sha = liveHead;
  }

  if (notify) {
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug || null,
        merged: false,
        headMoved: true,
        ...(keepsApprovals ? { votesKept: true } : {}),
      });
    } catch (_) { /* ws failures are non-fatal */ }

    const label = session.pr_title
      ? `PR #${session.pr_number}: ${session.pr_title}`
      : `PR #${session.pr_number}`;
    const message = move.kind === 'mechanical'
      ? `${label} was brought up to date with main. Nothing in the proposal changed, so its votes still stand.`
      : move.kind === 'resolved'
        ? `${label} was brought up to date with main and ${move.conflictPaths?.length || 'its'} conflicting file${move.conflictPaths?.length === 1 ? '' : 's'} were resolved automatically. The votes still stand; its checks are re-running against the merged code and it will merge on its own once they pass.`
        : move.kind === 'unknown'
          ? `${label} moved to a commit the platform could not verify (${move.reason}). Earlier votes were cleared, so please re-review commit ${liveHead.slice(0, 8)}.`
          : `${label} was updated on GitHub. Earlier votes were cleared, so please re-review commit ${liveHead.slice(0, 8)}.`;
    await sendSystemMessage(
      pool, session.app_id, message, 'system',
      { headChanged: true, votesKept: keepsApprovals, prNumber: session.pr_number, headSha: liveHead },
      { type: 'session', ref: session.id }
    ).catch(() => {});
  }

  log.info('votes', 'Proposal revision reconciled', {
    sessionId: session.id, oldHead, newHead: liveHead,
    moveKind: move.kind, keepsApprovals, epoch, checksReset: needsChecks,
  });

  return {
    enforced: true,
    headSha: liveHead,
    epoch,
    updated: true,
    changed: true,
    kind: move.kind,
    votesKept: keepsApprovals,
    checksDeferred: needsChecks && deferChecks,
  };
}

/**
 * Is the vote the browser is casting a vote on the proposal it was shown?
 *
 * The old guard compared the rendered COMMIT to the live head and rejected
 * any difference. That cost a voter their click on every platform sync —
 * including the ones the platform had just certified changed nothing — because
 * the comparison could not tell "this is different code" from "this is the
 * same code, rebased". An epoch can: it only moves when somebody writes bytes
 * that were not already approved.
 *
 * An absent stamp is accepted. A client that sends no epoch is voting on
 * whatever is current, which is the pre-#872 behaviour and is safe now that
 * the epoch — not the vote's own revision — is what decides whether it counts.
 */
function voteMatchesApprovalEpoch(expectedEpoch, revision) {
  if (!revision?.enforced) return true;
  if (expectedEpoch === undefined || expectedEpoch === null || expectedEpoch === '') return true;
  const expected = parseInt(expectedEpoch, 10);
  if (!Number.isFinite(expected)) return true;
  const current = parseInt(revision.epoch, 10);
  if (!Number.isFinite(current)) return true;
  return expected === current;
}

// Optional testing metadata on a PR import. Returns the three column values
// the imported session row is created with — all null when the request body
// carries nothing, which is the browser import button's case and leaves that
// path byte-identical to before.
//
// Every rule is BORROWED, not restated: services/testing-notes.js's
// `parseSubmitted` owns what a valid capture route is, how many are shot, how
// the viewport labels are spelled and how long the markdown may be. It is
// shared with the UPDATE path (#1199), which is the point — the same routes
// must not behave differently depending on whether an import or an update
// submitted them. Only the three COLUMNS are kept: an import writes all three
// on INSERT either way, so `provided` carries no extra meaning on this path,
// and the rejected-entry list (#1214) is reported to the submitter by the
// connector that shaped the routes rather than written to a column here.
function parseImportTesting(body) {
  const {
    testingMd, testingPath, testingPaths,
  } = require('../services/testing-notes').parseSubmitted(body);
  return { testingMd, testingPath, testingPaths };
}

// Structured evidence intent supplied by coding agents. There is deliberately
// no markdown fallback: one strict parser owns the contract at every process
// boundary, and an omitted value preserves browser imports exactly as before.
function parseImportVisualEvidence(body) {
  if (!body || body.visualEvidence === undefined) return undefined;
  return visualEvidencePlan.parseIntent(body.visualEvidence);
}

// Keep internal failures opaque, but name the import boundary a caller can
// act on. The connector turns these fields into an `import_failed` response,
// so an agent can retry the SAME open pull request instead of manufacturing a
// fresh one without knowing whether parsing, persistence, or evidence failed.
function prImportFailureBody(err) {
  if (err?.prImportStage === 'visual_evidence_intent') {
    return {
      error: 'PR import failed while recording visualEvidence.',
      stage: 'visual_evidence_intent',
      field: 'visualEvidence',
      retryable: true,
    };
  }
  return { error: 'Internal server error' };
}

// The linked-issue set an import may carry (#1217). Bounded and sanitized by
// pr-metadata's own helper — the one that renders `Closes #N` — so the column
// and the PR body can never disagree about what counts as a linked issue.
// The cap matches the local-agent handoff route's.
const MAX_IMPORT_LINKED_ISSUES = 50;

function parseImportLinkedIssues(body) {
  const { sanitizeIssueNumbers } = require('../services/pr-metadata');
  return sanitizeIssueNumbers(body && body.linkedIssues).slice(0, MAX_IMPORT_LINKED_ISSUES);
}

// The plain-language summary an import may carry (the About sheet's user-facing
// half). On-platform sessions get one from llm.generatePrMetadata; an imported
// or connector-submitted PR had no way to supply one at all, so those proposals
// rendered the technical description as their only content — which is what the
// two-section About sheet exists to avoid.
//
// Bounded, because it is the body text a voter reads FIRST. An agent that
// pastes its whole PR body here would collapse the two sections back into one,
// so the cap is deliberately much smaller than the description's: a few
// sentences, not a document. Truncation is silent for the same reason the
// testing note's is — one over-long field must not cost somebody their whole
// submission — and the field is optional, so an omitted one behaves exactly as
// before rather than inventing a summary nobody wrote.
const MAX_IMPORT_SUMMARY = 600;

function parseImportSummary(body) {
  const raw = body && typeof body.summary === 'string' ? body.summary : '';
  const trimmed = raw.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_IMPORT_SUMMARY);
}

function revisionChangedVoteResponse(res, headSha, message = null, epoch = null) {
  return res.status(409).json({
    error: message
      || 'This proposal changed since it was shown. Refresh it, review the new revision, then vote again.',
    headChanged: true,
    refreshRequired: true,
    reviewedHeadSha: headSha || null,
    // #2038: the client re-arms its buttons from this instead of refetching
    // and hoping. A rejection that does not say what the current epoch IS
    // leaves an impatient second click carrying the same stale stamp — which
    // is how one head move produced two identical rejections.
    approvalEpoch: epoch == null ? null : parseInt(epoch, 10),
  });
}

// Record a vote, stamped with the epoch it was cast under.
//
// The epoch is read INSIDE the statement (`SELECT ... FOR UPDATE`) rather
// than passed in, so a reconciliation racing this write either lands first —
// and the vote is stamped with the new epoch, which is correct, because the
// voter is voting on whatever the reconciliation decided — or lands after,
// against a row this statement already holds a lock on. There is no window in
// which a vote is written carrying an epoch that never existed.
//
// head_sha is still recorded. It no longer decides anything, but it is the
// only record of which commit a person was looking at when they approved,
// and that is worth keeping.
// The longest line a vote may carry (#1688). One sentence, not a review:
// the roster, the thread line and the proposer's notification all quote it
// whole, and a paragraph in any of those is worse than none.
const VOTE_REASON_MAX = 280;
const VOTE_REASON_REQUIRED = 'A No comes with a line: what is not working for you?';

// The one-line reason on a vote, normalised: whitespace collapsed, empty
// becomes null (no line), anything else trimmed. `{ error }` when the line is
// not a string or runs past the cap — the caller answers 400 with it.
function normalizeVoteReason(raw) {
  if (raw == null) return { reason: null };
  if (typeof raw !== 'string') return { error: 'Reason must be a string' };
  const reason = raw.replace(/\s+/g, ' ').trim();
  if (!reason) return { reason: null };
  if (reason.length > VOTE_REASON_MAX) {
    return { error: `Reason must be ${VOTE_REASON_MAX} characters or fewer` };
  }
  return { reason };
}

// The reason column on the upsert (#1688). A line that arrives replaces the
// old one. When none arrives, the earlier line is KEPT if the person is
// re-casting the same side — that is what carries a Yes, and its sentence,
// onto a proposal's next version with one tap — and dropped on a flip, where
// the old sentence argued for the other side.
const VOTE_REASON_UPSERT_SQL = `reason = CASE
             WHEN EXCLUDED.reason IS NOT NULL THEN EXCLUDED.reason
             WHEN pr_votes.vote = EXCLUDED.vote THEN pr_votes.reason
             ELSE NULL END`;

async function recordVote({ pool, session, userId, vote, headSha, revisionEnforced, reason = null }) {
  if (!revisionEnforced) {
    return pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch, reason)
       SELECT $1, $2, $3, $4, cs.approval_epoch, $5 FROM chat_sessions cs WHERE cs.id = $1
       ON CONFLICT (session_id, user_id) DO UPDATE
         SET vote = EXCLUDED.vote, head_sha = EXCLUDED.head_sha,
             approval_epoch = EXCLUDED.approval_epoch, created_at = NOW(),
             ${VOTE_REASON_UPSERT_SQL}
       RETURNING id, reason`,
      [session.id, userId, vote, headSha, reason]
    );
  }

  return pool.query(
    `WITH current_session AS (
       SELECT id, approval_epoch
         FROM chat_sessions
        WHERE id = $1
          AND status IN ('promoted', 'merging')
        FOR UPDATE
     )
     INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch, reason)
     SELECT id, $2, $3, $4, approval_epoch, $5 FROM current_session
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET vote = EXCLUDED.vote, head_sha = EXCLUDED.head_sha,
           approval_epoch = EXCLUDED.approval_epoch, created_at = NOW(),
           ${VOTE_REASON_UPSERT_SQL}
     RETURNING id, reason`,
    [session.id, userId, vote, headSha, reason]
  );
}

// The background merge/rejection sweep has no user vote event to refresh a
// native PR first. Give it one shared, testable preparation step: imported PRs
// keep their existing synchronized head, while native PRs are always checked
// live before a governance gate is allowed to count votes.
async function reconcilePromotedSweepHead({ config, pool, session }) {
  if (session?.source === 'imported') {
    return {
      enforced: true,
      imported: true,
      headSha: session.imported_pr_head_sha || null,
    };
  }
  const revision = await reconcileNativeReviewedHead({
    config,
    pool,
    session,
    fresh: true,
  });
  return {
    ...revision,
    headSha: revision.blocked ? null : reviewedHeadForSession(session),
  };
}

// Shared SELECT column list + FROM/JOIN block for a "merged-shaped"
// proposal row. Used by BOTH `GET /api/apps/:slug/merged` (the paginated
// Completed list) and `GET /api/apps/:slug/proposals/:id` (single-row
// fetch-on-demand recovery — see app-view.js _fetchProposalById). Kept as
// ONE fragment so the two endpoints can never drift in row shape: the FE
// card renderer (_renderMergedCard / _renderTopicHead) depends on every
// field below being present. Placeholders: $1 = app_id, $2 = the viewer's
// user id (for the per-viewer my_vote / my_kudos subqueries). Callers
// append their own WHERE / ORDER / LIMIT.
function mergedRowSelect() {
  return `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_summary_md, cs.pr_body, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           -- #1264: the exact merge time (and the promotion time beside it)
           -- so the progress report can date completed work by when it
           -- actually landed instead of when it was started. NULL on rows
           -- merged before the column existed — consumers must keep the
           -- created_at fallback forever.
           cs.merged_at, cs.promoted_at, cs.shared_at, cs.session_title,
           cs.revert_of_session_id,
           -- Transcript sharing: true when this proposal's owner published
           -- the dev chat that produced it, so the proposal page can offer
           -- "Read the dev chat". A boolean only — the transcript itself is
           -- served by GET /api/sessions/:id/transcript, which re-checks
           -- both share flags. shared_at survives promotion and merge, so
           -- this stays meaningful on merged rows too (the post-hoc "how
           -- did this change come about?" read).
           (cs.transcript_shared_at IS NOT NULL) AS transcript_shared,
           -- #687 (PR-import): provenance for the "Imported PR" badge +
           -- GitHub-maintained note (kept visible on merged rows too).
           cs.source, cs.imported_pr_author, cs.imported_pr_head_sha,
           cs.reviewed_head_sha,
           cs.visual_evidence_state, cs.visual_evidence_run_id,
           cs.visual_evidence_detail, cs.visual_evidence_updated_at,
           -- #967: which external coding agent wrote it, for the "built
           -- with …" chip. Kept on merged rows for the same post-hoc read.
           cs.external_agent,
           -- #381: console-error check snapshot so the warning + detail
           -- block stay visible on a merged proposal for post-hoc review.
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: checks snapshot, kept visible on merged proposals for
           -- post-hoc review (a merged proposal passed, by the gate).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           -- Which half of a 'pending' run is in flight ('building' |
           -- 'testing'), so the checks card names the stage instead of
           -- showing one opaque "still running". NULL = legacy wording.
           cs.check_phase,
           cs.check_trigger,
           cs.checks_progress,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: when checks are in 'error' (staging preview wouldn't boot),
           -- the captured reason powers the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
           -- #58: the vote threshold + active-user count snapshotted at merge
           -- time. The merged-PR pill renders against votes_required (falling
           -- back to the live majority for legacy rows where it's NULL), and a
           -- tooltip surfaces "needed N of M active users at merge time" when
           -- both are present.
           cs.votes_required,
           cs.active_users_at_merge,
           -- Vote tally + per-viewer vote carried through so the group-chat
           -- activity row can keep its "x / y" pill and "You voted X" box
           -- after the PR merges (status='merged'), rather than the controls
           -- vanishing. Mirrors the /promoted subqueries.
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${currentVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${currentVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #194: per-proposal human-message count so the Completed list
           -- renders the same 💬 badge as the active proposals (and signals
           -- which merged proposals have a discussion worth opening). Counts
           -- msg_type='message' only — matching the /promoted subquery — so
           -- dual-posted lifecycle/vote system rows don't inflate the badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           rv.id        as revert_session_id,
           rv.pr_number as revert_pr_number,
           rv.pr_url    as revert_pr_url,
           rv.status    as revert_status
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions rv ON rv.revert_of_session_id = cs.id
           AND rv.status IN ('promoted', 'merging', 'merged')`;
}

function voteRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for the session-id-addressed vote routes
  // (promote / vote / votes / undo / admin-merge): collab-level access,
  // 404 on deny. Admins always pass inside the guard.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // Promote a session's PR for voting
  // drainGuard (#767): promote/merge kick container work (staging build,
  // production rebuild) that must not be started by a process seconds from
  // exiting — a half-run rebuild leaves the app down until the next heal
  // sweep. 503 here is honest and the client retries against the new
  // container. Read-only vote/undo paths stay ungated.
  router.post('/api/sessions/:id/promote', drainGuard, async (req, res) => {
    try {
      // #183: headless rows are excluded — auto sessions are never
      // promotable themselves; users clone them and propose the clone.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = rows[0];
      const imported = session.source === 'imported';
      const previousReviewedHead = imported
        ? (session.imported_pr_head_sha || null)
        : (session.reviewed_head_sha || null);

      // Promoted-PR cap: worker-less promoted sessions don't count
      // against the per-user active-session cap (see the create-session
      // cap in routes/sessions.js), so this is the bound that keeps one
      // user from accumulating unlimited open-for-vote PRs (each holding a
      // staging preview and vote-panel attention). Checked before the
      // lazy PR creation below so an over-cap promote doesn't open a
      // PR it then refuses to put up for vote.
      //
      // The ceiling is per-REQUESTER: full platform admins get a raised
      // cap (services/session-caps.js). Never compare against
      // config.maxUserPromotedSessions directly here.
      const caps = effectiveSessionCaps(config, req.user);
      const { rows: promotedRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
         WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
        [req.user.id]
      );
      if (parseInt(promotedRows[0].cnt) >= caps.promotedSessions) {
        return res.status(429).json({
          error: `You already have ${caps.promotedSessions} PRs up for vote. Wait for one to merge, or archive one first.`,
        });
      }

      const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

      // #2500 / #2537: backfill the originating issue for the sessions that
      // predate the creation-time seed (routes/sessions.js). They recorded
      // the issue only in `created_from_issue_number`, so their proposal
      // showed "No issues linked yet" and, since the closing block is built
      // from `linked_issues`, the pull request opened just below carried no
      // `Closes #N` either. Promote time is the last moment that can still
      // be fixed before the group sees the proposal.
      //
      // Only ever for a row the seed never touched: on a seeded row an empty
      // `linked_issues` is an author's deliberate removal, and resurrecting
      // it here would make the linked-issues editor look broken. Routed
      // through proposal-update.updateLinkedIssues so a session that already
      // has a pull request gets the `Closes #N` appended to its live body
      // too — the lazy-creation block below only runs when there is no PR
      // yet, or no title on it. Best-effort: a proposal must never fail to
      // go up for a vote over its issue linkage.
      if (!session.issue_link_seeded
          && Number.isInteger(session.created_from_issue_number)
          && session.created_from_issue_number > 0
          && !(Array.isArray(session.linked_issues) ? session.linked_issues : []).length) {
        try {
          const proposalUpdate = require('../services/proposal-update');
          await proposalUpdate.updateLinkedIssues({
            pool, gh: github, session,
            owner: repoOwner,
            repo: repoName ? repoName.replace(/\.git$/, '') : repoName,
            addIssues: [session.created_from_issue_number],
            removeIssues: [],
          });
          await pool.query(
            'UPDATE chat_sessions SET issue_link_seeded = TRUE WHERE id = $1',
            [session.id]
          );
          session.issue_link_seeded = true;
          log.info('votes', 'Backfilled the originating issue onto the proposal', {
            sessionId: session.id, issueNumber: session.created_from_issue_number,
          });
        } catch (err) {
          log.warn('votes', 'Originating-issue backfill failed (continuing)', {
            sessionId: session.id, err: err.message,
          });
        }
      }

      // #183 lazy PR creation: sessions cloned from a headless auto run
      // arrive here without a PR (the headless contract defers it). Create
      // it now on THIS session's branch — the clone's, never the auto
      // branch — so the vote has something to merge. applyPrMetadata reads
      // the clone's copied history via gatherSessionContext, so the PR
      // title/body get the full auto-session context.
      //
      // Also runs when a PR exists but pr_title is missing: staging
      // recovery (server.js rebuildSessionStaging) can mint a PR before
      // promotion without a generated title, and a NULL pr_title would
      // otherwise render as "Change by <user>" forever. Backfilling it
      // here updates both GitHub and pr_title/session_title.
      if (!session.pr_number || !session.pr_title) {
        // Distinguish creating a PR (no pr_number → a failure must block
        // promotion) from merely backfilling a missing title on an
        // existing PR (best-effort — never block promotion on it).
        const isBackfill = !!session.pr_number;
        const { rows: msgRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'user'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        const prMetadata = require('../services/pr-metadata');
        let prResult = null;
        let prError = null;
        try {
          let metadataApiKey = null;
          let metadataGenerationAllowed = false;
          try {
            const billing = await limits.resolveBillingPath(
              pool, config.dataEncryptionKey, req.user.id,
            );
            if (!billing.error) {
              metadataApiKey = billing.apiKey;
              metadataGenerationAllowed = true;
            } else {
              log.info('votes', 'Using deterministic PR metadata: no payer available', {
                sessionId: session.id, reason: billing.reason || null,
              });
            }
          } catch (billingErr) {
            log.warn('votes', 'PR metadata billing resolve failed; using deterministic draft', {
              sessionId: session.id, err: billingErr.message,
            });
          }
          prResult = await prMetadata.applyPrMetadata({
            pool, session, repoOwner, repoName,
            userMessage: msgRows[0]?.content || '',
            ccSummary: '',
            username: req.user.username,
            apiKey: metadataApiKey,
            userId: req.user.id,
            allowModelGeneration: metadataGenerationAllowed,
            // A title the author submitted with the work (submit_work's
            // `title`, stored at update time) names the PR verbatim instead
            // of "<user>'s changes · auto-title pending".
            preferredTitle: session.proposed_pr_title || null,
          });
        } catch (err) {
          prError = err;
          log.warn('votes', 'Lazy PR creation/backfill threw', {
            sessionId: session.id, backfill: isBackfill,
            code: err.code || null, ...github.describeGithubError(err),
          });
        }
        if (!isBackfill && (!prResult || !session.pr_number)) {
          // Refuse to promote PR-less — a vote with nothing to merge is a
          // dead end. Nothing was mutated yet.
          if (prError && prError.code === 'no_commits') {
            // Permanent condition: the branch has no commits on GitHub
            // (typically committed locally but never pushed). "Try again
            // in a moment" would loop forever — tell the truth instead.
            return res.status(409).json({
              error: 'This change has no committed code on its branch yet, so there is nothing to open a pull request for. Re-run your request in the session so it produces and pushes a commit, then propose again.',
            });
          }
          if (prError && prError.code === 'github_unavailable') {
            // GitHub-side outage (2026-07-24: hours of empty-body 500s on
            // POST /pulls only). Retrying immediately or re-running the
            // request in the session cannot help — say so honestly. This
            // message also reaches the Mayor, which stops it from making
            // no-op commits to "fix" a problem that isn't in the change.
            const detail = [
              prError.status ? `HTTP ${prError.status} from GitHub` : 'network error reaching GitHub',
              prError.requestId ? `request id ${prError.requestId}` : null,
            ].filter(Boolean).join(', ');
            return res.status(503).json({
              error: `GitHub is currently failing to create pull requests (${detail}). This is a GitHub-side problem, not this change: the work is safe on its branch. Try proposing again in a few minutes; do not re-run the request or push extra commits.`,
            });
          }
          return res.status(502).json({
            error: 'Could not create the pull request for this change. Please retry; if it keeps failing, re-run your request in the session.',
          });
        }
      }

      // Reconcile the PR's GitHub state before putting it up for vote and
      // capture the immutable head revision this review starts from. The PR
      // head can move outside the vote flow, so failing to read it must
      // fail closed: checks/votes cannot honestly describe an unknown revision.
      // A session that was withdrawn (archived) carries a CLOSED PR —
      // GitHub reports closed PRs as permanently unmergeable, so
      // promoting one without a reopen creates a proposal that can
      // never merge (session 2398 / PR #26: every merge 405'd and the
      // auto-resolver looped still_conflicting forever). Reopen it here;
      // if GitHub refuses (head branch deleted, a newer PR on the same
      // head), refuse the promote with an actionable error instead of
      // minting a doomed proposal.
      let promotedHeadSha = null;
      if (github.isEnabled() && session.repo_url && session.pr_number) {
        const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (!owner || !repo) {
          return res.status(409).json({
            error: 'This proposal has no valid GitHub repository to verify.',
          });
        }
        if (owner && repo) {
          let pr = null;
          try {
            pr = await github.getPR(owner, repo, session.pr_number);
          } catch (err) {
            log.warn('votes', 'Promote PR revision check failed', {
              sessionId: session.id, pr: session.pr_number, err: err.message,
            });
            return res.status(503).json({
              error: 'GitHub could not verify the pull request revision. Try promoting again shortly.',
            });
          }
          if (pr && pr.merged) {
            return res.status(409).json({
              error: `PR #${session.pr_number} was already merged on GitHub. This change has landed, so there is nothing to vote on.`,
            });
          }
          if (pr && pr.state === 'closed') {
            if (imported) {
              return res.status(409).json({
                error: `PR #${session.pr_number} is closed on GitHub and cannot be put up for vote.`,
              });
            }
            try {
              await github.reopenPR(owner, repo, session.pr_number);
              log.info('votes', 'Reopened closed PR at promote time', {
                sessionId: session.id, pr: session.pr_number,
              });
            } catch (err) {
              log.warn('votes', 'Could not reopen closed PR at promote time', {
                sessionId: session.id, pr: session.pr_number, err: err.message,
              });
              return res.status(409).json({
                error: `This proposal's pull request (#${session.pr_number}) was closed on GitHub and couldn't be reopened. Re-propose it as a fresh proposal.`,
              });
            }
          }
          promotedHeadSha = pr?.head?.sha || null;
          if (!promotedHeadSha || !/^[0-9a-f]{40}$/i.test(promotedHeadSha)) {
            return res.status(409).json({
              error: 'GitHub did not return a valid pull-request head commit.',
            });
          }
          if (req.cliHandoffCheckedHead
              && String(promotedHeadSha).toLowerCase()
                !== String(req.cliHandoffCheckedHead).toLowerCase()) {
            // A direct push landed after the CLI-handoff middleware verified
            // the managed branch but before lazy PR creation / this PR read.
            // Keep the session active so the new head can be rebuilt; never
            // open voting on code that did not produce the ready verdict.
            const detail = 'The proposal branch changed after checks. Rebuild the new head locally or from the web Dev session before promoting.';
            await pool.query(
              `UPDATE chat_sessions SET check_state = 'error', check_error_detail = $1
                WHERE id = $2 AND status = 'active' AND source = 'cli_handoff'
                  AND COALESCE(checks_commit_sha, handoff_head_sha)
                      IS NOT DISTINCT FROM $3`,
              [detail, session.id, req.cliHandoffCheckedHead]
            ).catch(() => {});
            return res.status(409).json({
              error: 'branch_head_changed',
              message: detail,
            });
          }

          // Native proposals are platform-owned drafts, so crossing the local
          // review boundary also marks them ready on GitHub. Imported PRs are
          // externally owned: promotion changes only Homeroom's local state
          // and must not publish an external author's draft.
          if (!imported) {
            try {
              // octokit.request rather than .rest.pulls.update —
              // @octokit/app's installation Octokit is a bare core
              // instance without the rest-endpoint-methods plugin, so
              // .rest is undefined.
              const octokit = await github.getInstallationOctokit(owner);
              await octokit.request(
                'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
                { owner, repo, pull_number: session.pr_number, draft: false }
              );
            } catch (err) {
              log.warn('votes', 'Failed to update PR on GitHub', { err: err.message });
            }
          }
        }
      }

      // promoted_at anchors the stale-PR sweeper's "no interest since"
      // clock; clearing stale_notified_at handles the re-promote case
      // (a previously-stale PR that's proposed again starts fresh).
      const promoted = await pool.query(
        `UPDATE chat_sessions
            SET status = 'promoted', promoted_at = NOW(),
                stale_notified_at = NULL,
                reviewed_head_sha = CASE WHEN source = 'imported'
                  THEN reviewed_head_sha ELSE COALESCE($2, reviewed_head_sha) END,
                imported_pr_head_sha = CASE WHEN source = 'imported'
                  THEN COALESCE($2, imported_pr_head_sha) ELSE imported_pr_head_sha END
          WHERE id = $1 AND status = 'active'`,
        [session.id, promotedHeadSha]
      );
      if (!promoted.rowCount) {
        return res.status(409).json({ error: 'session_state_changed' });
      }
      if (promotedHeadSha) {
        if (imported) session.imported_pr_head_sha = promotedHeadSha;
        else session.reviewed_head_sha = promotedHeadSha;

        // A withdrawn proposal may retain votes from its earlier review.
        // Preserve only votes explicitly cast for this exact revision; this
        // also removes legacy unbound votes while keeping same-head re-promotes
        // stable. The governance gate is head-scoped too, so this cleanup keeps
        // the visible tally aligned with what can actually count.
        const cleared = await pool.query(
          `DELETE FROM pr_votes
            WHERE session_id = $1 AND head_sha IS DISTINCT FROM $2`,
          [session.id, promotedHeadSha]
        );
        if ((cleared.rowCount || 0) > 0) {
          try {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug || null,
              merged: false,
              headMoved: previousReviewedHead != null,
            });
          } catch (_) { /* ws failures are non-fatal */ }
        }

        // If this is a re-promotion on a new commit and an existing preview
        // still describes the old one, invalidate it immediately and rebuild
        // checks against the captured SHA. A proposal without staging is
        // handled by the ordinary post-response build below.
        if (session.checks_commit_sha !== promotedHeadSha) {
          if (imported) {
            // Import-time checks may still describe the head captured when
            // the row entered In progress. Promotion re-read GitHub above;
            // if that head moved, start a SHA-pinned rebuild even when the
            // earlier preview has not finished yet.
            await kickImportedRevisionChecks({
              config, pool, session, headSha: promotedHeadSha,
            });
          } else if (previousReviewedHead !== promotedHeadSha && session.staging_url) {
            await kickNativeRevisionChecks({
              config, pool, session, headSha: promotedHeadSha,
            });
          }
        }
      }

      // #788: classify the proposal now that it's up for vote — does its
      // diff change dapp.json's `admins` block? A flagged proposal loses
      // the time-based merge paths (no countdown, no silence-is-consent)
      // and can't be force-merged by an app admin. Best-effort and
      // awaited so the first vote-panel render already carries the flag;
      // checkAndMerge re-verifies authoritatively before merging anyway.
      await appAdmins.refreshExplicitApproval(pool, session, session);

      // Post to group chat. Include the PR title when we have one so
      // the feed reads like "evan promoted PR #8 — Add emoji stamp
      // centering fix for voting" instead of the opaque "PR #8 for
      // voting" which gives no hint about what's being voted on.
      const promoLabel = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } }
      );
      // Dual-post into the proposal's own thread so the topic discussion
      // carries its lifecycle in context (general chat stays the
      // app-wide entry point).
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        { type: 'session', ref: session.id }
      ).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: session.app_slug });
      log.info('votes', 'Session promoted', { sessionId: session.id });
      events.record(pool, {
        type: events.EVENT_TYPES.PR_PROMOTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { prNumber: session.pr_number || null },
      });
      // #183: return the PR info so the dev-chat staging card can flip
      // its "Changes ready" header to the PR link without a refetch —
      // the promote may have just created the PR lazily.
      res.json({
        ok: true,
        prNumber: session.pr_number || null,
        prUrl: session.pr_url || null,
        prTitle: session.pr_title || null,
      });

      // #183: a clone promoted straight off a headless auto run's pre-built
      // preview may not have its own staging yet (the copied card points at
      // the auto session's URL — same content, since the clone branch was
      // forked from it). Build the clone's own staging from its branch head,
      // fire-and-forget; the Pass-3 heal sweeper in server.js is the backstop.
      if (imported) {
        // Imported rows already start their SHA-pinned preview/check build at
        // import time. Never fall through to the native branch-name build:
        // a fork head may not exist in the app repository at all.
      } else if (!session.staging_url) {
        (async () => {
          // Use the exact revision captured before promotion. The fallback
          // exists only for GitHub-disabled local development.
          let commitHash = session.reviewed_head_sha || 'latest';
          if (commitHash === 'latest' && github.isEnabled() && repoOwner && repoName) {
            try {
              const octokit = await github.getInstallationOctokit(repoOwner);
              const { data: ref } = await octokit.request(
                'GET /repos/{owner}/{repo}/git/ref/{+ref}',
                { owner: repoOwner, repo: repoName, ref: `heads/${session.branch_name}` }
              );
              commitHash = ref.object.sha;
            } catch {}
          }
          const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
          // #607: stamp 'pending' + broadcast before the (minutes-long)
          // staging build so the freshly promoted proposal's card shows
          // "Checks running…" instead of a bare NULL-verdict "Re-run
          // checks" button. captureForSession re-stamps idempotently.
          {
            const visualsService = require('../services/visuals');
            await visualsService.setChecksPending(
              pool, session.id, commitHash === 'latest' ? null : commitHash, 'building'
            ).catch((err) => log.warn('votes', 'promote setChecksPending failed (non-fatal)', {
              sessionId: session.id, err: err.message,
            }));
            visualsService.notifyChecksPending(session.id, commitHash === 'latest' ? null : commitHash, 'building', 'promote-kick');
          }
          let result;
          try {
            result = await staging.buildAndDeployStaging(config, session, app, commitHash);
          } catch (err) {
            // #461: the proposal is already promoted, so a swallowed build
            // failure would leave check_state NULL — merge-blocked as
            // "still running its tests" with no signal. Record a terminal
            // 'error' verdict (with reason + once-per-streak owner nudge)
            // before surfacing the failure to the outer catch's WARN log.
            const stagingRecovery = require('../services/staging-recovery');
            await stagingRecovery.recordStagingBootFailure({
              config, pool, session,
              commitHash: commitHash === 'latest' ? null : commitHash, err,
            }).catch((e) => log.warn('votes', 'recordStagingBootFailure failed (non-fatal)', {
              sessionId: session.id, err: e.message,
            }));
            throw err;
          }
          await pool.query(
            `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
            [result.containerId, result.stagingUrl, session.id]
          );
          await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
          // #195: capture before/after visuals off the fresh preview so
          // headless proposals promoted from clones get media on the vote
          // card + PR body even though the auto session's own staging (and
          // its capture window) may be long gone. Fire-and-forget; the
          // heuristic + all failure handling live inside the service.
          const visualsService = require('../services/visuals');
          visualsService.captureForSession(
            config, session, app, commitHash === 'latest' ? null : commitHash, result,
            // The promote path must merge on a verdict it just took, so this
            // one runs even when the row already reads passing for the commit.
            { trigger: 'promote-kick', force: true }
          ).catch((err) => {
            log.warn('votes', 'Post-promote visuals capture failed', { sessionId: session.id, err: err.message });
          });
        })().catch((err) => {
          log.warn('votes', 'Post-promote staging build failed', { sessionId: session.id, err: err.message });
        });
      } else {
        // #461: the preview already exists (e.g. built via the manual
        // deploy-staging button, which historically never ran checks, or
        // inherited from an earlier turn whose capture described an older
        // commit). Kick a recheck NOW when the verdict is missing or
        // describes a different commit than the branch head, instead of
        // leaving the freshly-promoted proposal merge-blocked until a
        // background sweep notices. Fire-and-forget; recheckSessionChecks
        // re-runs against the live container (or rebuilds a dead one) and
        // captureForSession is _inFlight-guarded.
        (async () => {
          let needsKick = !session.check_state;
          if (!needsKick && github.isEnabled() && repoOwner && repoName) {
            try {
              const octokit = await github.getInstallationOctokit(repoOwner);
              const { data: ref } = await octokit.request(
                'GET /repos/{owner}/{repo}/git/ref/{+ref}',
                { owner: repoOwner, repo: repoName, ref: `heads/${session.branch_name}` }
              );
              needsKick = !!ref.object.sha && ref.object.sha !== session.checks_commit_sha;
            } catch {}
          }
          if (!needsKick) return;
          const stagingRecovery = require('../services/staging-recovery');
          await stagingRecovery.recheckSessionChecks({
            config, pool, session, reason: 'promote-kick',
          });
        })().catch((err) => {
          log.warn('votes', 'Promote-time checks kick failed', { sessionId: session.id, err: err.message });
        });
      }

      // Vote-request fan-out. Non-fatal + post-response: the promote
      // itself has already succeeded, so a notification hiccup must not
      // 500 the request. Pings the app's active users + creator +
      // favoriters (minus the proposer) so the right people come vote,
      // and de-dupes per session so a re-promote doesn't re-spam.
      try {
        const notifRows = await notifications.createPrProposedNotifications(pool, {
          appId: session.app_id,
          sessionId: session.id,
          proposerId: req.user.id,
        });
        for (const row of notifRows) {
          pushNotificationToUser(row.user_id, {
            type: 'notification_new',
            notification: notifications.serialize({
              ...row,
              app_slug: session.app_slug,
              app_name: session.app_name,
              pr_title: session.pr_title,
              pr_number: session.pr_number,
              source_username: req.user.username,
            }),
          });
        }
        if (notifRows.length) {
          log.info('votes', 'PR-proposed notifications sent', {
            sessionId: session.id, count: notifRows.length,
          });
        }
      } catch (err) {
        log.warn('votes', 'pr_proposed notify failed', { sessionId: session.id, err: err.message });
      }
    } catch (err) {
      log.error('votes', 'Promote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #687: import an existing GitHub PR as a proposal ────────────────
  //
  // The three endpoints (candidate list, preview, import) let a collaborator pull an
  // externally-authored PR into the vote flow instead of building it in the
  // platform's AI dev-chat. Preview/candidates are read-only; import creates
  // a shared `source='imported'` In-progress row. Automated submission paths
  // may explicitly request the historical straight-to-vote result.
  //
  // Parse owner/repo from an app's repo_url, or null.
  const parseRepo = (url) => {
    const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    return owner && repo ? { owner, repo } : null;
  };

  // Fire-and-forget: build the imported PR's staging preview pinned to its
  // exact head SHA (Slice 1 clone fix) and run its checks, mirroring the
  // post-promote path so an imported proposal gets a preview + checks verdict
  // like any native one. The implementation lives in services/pr-import-sync
  // (#846) beside its head-change sibling rerunChecksForNewHead, so it is
  // unit-testable; it never throws, so nothing can escape into the request.
  const kickImportedChecks = (session, app, headSha) => {
    const prImportSync = require('../services/pr-import-sync');
    prImportSync.kickImportedChecks({ config, pool, session, app, headSha });
  };

  // Which of this app's PR numbers are already imported and still live/merged
  // (so the picker + import guard don't offer/allow a duplicate). Archived
  // imports are excluded so a withdrawn import can be re-imported.
  const importedPrNumbers = async (appId) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT pr_number FROM chat_sessions
        WHERE app_id = $1 AND source = 'imported' AND pr_number IS NOT NULL
          AND status IN ('active', 'promoted', 'merging', 'merged')`,
      [appId]
    );
    return new Set(rows.map((r) => r.pr_number));
  };

  // #866: is this PR headed by a branch that lives in a DIFFERENT repo (a
  // fork)? GitHub answers this by comparing head.repo.full_name against
  // base.repo.full_name; `head.label` ("owner:branch") is the fallback for
  // the case where the fork was deleted and head.repo comes back null.
  //
  // This matters to a reviewer BEFORE they import: a fork-headed PR's branch
  // does not exist in the app's own repo, so the preview is built from
  // refs/pull/<N>/head (see staging.js) and the code being previewed is an
  // outside contributor's, not the group's. Unknown/absent metadata reads as
  // "not a fork" — the label is an extra caution, never a gate, so guessing
  // "fork" from missing data would only cry wolf.
  function prForkInfo(pr, repo) {
    const baseFull = pr?.base?.repo?.full_name
      || (repo ? `${repo.owner}/${repo.repo}` : null);
    let headFull = pr?.head?.repo?.full_name || null;
    if (!headFull && typeof pr?.head?.label === 'string' && pr.head.label.includes(':')) {
      const owner = pr.head.label.split(':')[0];
      const name = baseFull ? baseFull.split('/')[1] : null;
      if (owner && name) headFull = `${owner}/${name}`;
    }
    const fromFork = !!(headFull && baseFull
      && headFull.toLowerCase() !== baseFull.toLowerCase());
    return { fromFork, headRepo: fromFork ? headFull : null };
  }

  // GET candidate PRs to import (open PRs on the app's repo not already
  // imported). Collab access.
  router.get('/api/apps/:slug/pr-import/candidates', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) return res.json({ candidates: [] });

      const imported = await importedPrNumbers(app.id);
      let pulls = [];
      try {
        pulls = await gh.listOpenPulls(repo.owner, repo.repo);
      } catch (err) {
        log.warn('votes', 'listOpenPulls failed', { slug: req.params.slug, err: err.message });
        return res.json({ candidates: [] });
      }
      const candidates = pulls
        .filter((p) => !imported.has(p.number))
        .map((p) => ({
          number: p.number,
          title: p.title,
          author: p.user?.login || null,
          headBranch: p.head?.ref || null,
          baseBranch: p.base?.ref || null,
          headSha: p.head?.sha || null,
          htmlUrl: p.html_url || null,
          // #866: fork provenance for the picker's "from a fork — …" label.
          ...prForkInfo(p, repo),
        }));
      res.json({ candidates });
    } catch (err) {
      log.error('votes', 'PR-import candidates failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET a read-only preview of a single PR before importing. Collab access.
  router.get('/api/apps/:slug/pr-import/preview', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const prNumber = parseInt(req.query.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return res.status(400).json({ error: 'A valid PR number is required' });
      }
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) {
        return res.status(409).json({ error: 'GitHub is not configured for this app' });
      }

      let pr;
      try {
        pr = await gh.getPR(repo.owner, repo.repo, prNumber);
      } catch (err) {
        return res.status(404).json({ error: `PR #${prNumber} not found on GitHub` });
      }
      const headSha = pr.head?.sha || null;
      const baseRef = pr.base?.ref || 'main';
      const baseSha = visualEvidenceState.validSha(pr.base?.sha) ? pr.base.sha : null;
      let changedFiles = [];
      try {
        changedFiles = await gh.listChangedFiles(
          repo.owner, repo.repo, `${baseRef}...${headSha || pr.head?.ref}`
        );
      } catch (err) {
        log.warn('votes', 'PR-import preview listChangedFiles failed', { prNumber, err: err.message });
      }
      const imported = await importedPrNumbers(app.id);
      res.json({
        preview: {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login || null,
          state: pr.state,
          headBranch: pr.head?.ref || null,
          baseBranch: baseRef,
          baseSha,
          headSha,
          // GitHub's mergeable is true/false/null (null = still computing).
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state || null,
          changedFiles,
          changedFileCount: changedFiles.length,
          htmlUrl: pr.html_url || null,
          alreadyImported: imported.has(pr.number),
          // #866: same fork provenance the candidate list carries, so the
          // preview pane can repeat the caution before the import lands.
          ...prForkInfo(pr, repo),
        },
      });
    } catch (err) {
      log.error('votes', 'PR-import preview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST import a PR. Collab access. Creates a shared In-progress
  // `source='imported'` session by default and kicks its SHA-pinned checks
  // build; trusted automated callers can request `promote: true`.
  router.post('/api/apps/:slug/pr-import', drainGuard, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const prNumber = parseInt(req.body?.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return res.status(400).json({ error: 'A valid PR number is required' });
      }
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) {
        return res.status(409).json({ error: 'GitHub is not configured for this app' });
      }

      // 409 if this PR is already imported and still live/merged.
      const imported = await importedPrNumbers(app.id);
      if (imported.has(prNumber)) {
        return res.status(409).json({ error: `PR #${prNumber} has already been imported.` });
      }

      let pr;
      try {
        pr = await gh.getPR(repo.owner, repo.repo, prNumber);
      } catch (err) {
        return res.status(404).json({ error: `PR #${prNumber} not found on GitHub` });
      }
      if (pr.state !== 'open') {
        return res.status(409).json({ error: `PR #${prNumber} is not open.` });
      }
      const headSha = pr.head?.sha || null;
      // GitHub returns the immutable commit at the PR's base side. Persist it
      // with the imported proposal so evidence never has to reconstruct the
      // pair later from a moving default branch.
      const baseSha = visualEvidenceState.validSha(pr.base?.sha) ? pr.base.sha : null;
      const headBranch = pr.head?.ref || null;
      if (!headBranch) {
        return res.status(409).json({ error: 'Could not determine the PR head branch.' });
      }
      // WHICH REPOSITORY that branch is in (#1196). An imported PR usually
      // comes from the author's fork, but not always: the connector's mirror
      // rung copies a verified fork branch into THIS repository and opens a
      // same-repo pull request, and a proposal whose head only the platform
      // bot can write has to be reported — and advanced — as such. Recorded
      // once, here, because it is a fact about the pull request that never
      // changes while it is open; `branchHomeOf` reads it.
      const headRepoFullName = pr.head?.repo?.full_name || null;

      // Optional testing metadata (#945 follow-up). A connector submission
      // can carry the same two things a build turn's "==== TESTING ===="
      // block carries — the routes the change is visible on, and how to see
      // it — so an imported proposal gets before/after screenshots of the
      // screen that changed instead of the app's home page.
      //
      // Re-validated here rather than trusted from the caller: the route is
      // reachable by any collaborator, and testing_path is joined onto the
      // staging origin and loaded in the preview iframe. Same validator, same
      // caps as the block parser — services/testing-notes.js owns both.
      // Absent (the browser's import button never sends them) leaves all
      // three columns NULL, exactly as before.
      const importTesting = parseImportTesting(req.body);
      let importVisualEvidence;
      try {
        importVisualEvidence = parseImportVisualEvidence(req.body);
      } catch (err) {
        return res.status(400).json({
          error: err.code || 'invalid_visual_evidence',
          message: err.message,
        });
      }
      // The request this pull request implements (#1217). A submission
      // prepared from a request knows its number — prepare_work records it,
      // and the work order prints it — but it stopped at the task, so a
      // proposal built FROM a request was linked to it nowhere the platform
      // could act on: no `Closes #N` for GitHub to honour on merge, nothing
      // for the post-merge close watcher to expect, and no "in progress"
      // chip on the request it came from.
      //
      // Sanitized here rather than trusted, like the testing metadata beside
      // it: same validator the PR-body producer uses, and the browser's own
      // import button sends none, which leaves the column at the empty array
      // it defaulted to before.
      const importLinkedIssues = parseImportLinkedIssues(req.body);
      const importSummary = parseImportSummary(req.body);
      const promote = req.body?.promote === true;
      const initialStatus = promote ? 'promoted' : 'active';

      // Browser imports join the shared In-progress board first. Automated
      // submission paths may opt into the historical straight-to-vote flow
      // with `promote: true`.
      const importClient = await pool.connect();
      let inserted;
      let visualEvidenceResult = null;
      try {
        await importClient.query('BEGIN');
        ({ rows: inserted } = await importClient.query(
          `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
            source, imported_pr_head_sha, handoff_base_sha,
            imported_pr_author, imported_pr_head_repo,
            promoted_at, shared_at, created_at,
            testing_md, testing_path, testing_paths, linked_issues, pr_body,
            pr_summary_md)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text,
            'imported', $8, $9, $10, $11,
            CASE WHEN $7::text = 'promoted' THEN NOW() END,
            CASE WHEN $7::text = 'active' THEN NOW() END,
            NOW(), $12, $13, $14::jsonb, $15, $16, $17)
           RETURNING id, status`,
          [
            app.id, req.user.id, headBranch, prNumber, pr.html_url || null,
            pr.title || `PR #${prNumber}`, initialStatus,
            headSha, baseSha, pr.user?.login || null, headRepoFullName,
            importTesting.testingMd, importTesting.testingPath,
            importTesting.testingPaths ? JSON.stringify(importTesting.testingPaths) : null,
            // Always an array, never null: the column is INTEGER[] NOT NULL
            // DEFAULT '{}', so an import with no request writes the empty
            // array the omitted column used to default to — byte-identical to
            // the row this route wrote before the field existed.
            importLinkedIssues,
            // #1333. The imported PR's body, mirrored on the way in. The route
            // already holds `pr`, so this costs no extra GitHub call and the
            // proposal reports a description from its very first read.
            pr.body || null,
            // The user-facing half of the About sheet. Null when the submitter
            // sent none: the platform does not generate one here, so a proposal
            // without it renders exactly as it did before this field existed.
            importSummary,
          ]
        ));
        await topicAttrs.selfAssignProposal(
          importClient, app.id, inserted[0].id, req.user
        );
        if (config.visualEvidence?.collect && importVisualEvidence) {
          try {
            visualEvidenceResult = await visualEvidenceState.recordIntentInTransaction(
              importClient,
              inserted[0].id,
              importVisualEvidence,
              visualEvidenceState.validSha(headSha) ? { headSha } : {}
            );
          } catch (err) {
            // This transaction owns `importClient`; recordIntent must neither
            // reconnect nor release it. Preserve a safe boundary marker for
            // the outer HTTP error without exposing the database exception.
            if (err && typeof err === 'object') {
              err.prImportStage = 'visual_evidence_intent';
              err.prImportField = 'visualEvidence';
            }
            throw err;
          }
        }
        await importClient.query('COMMIT');
      } catch (err) {
        await importClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        importClient.release();
      }
      const sessionId = inserted[0].id;
      const session = {
        id: sessionId, app_id: app.id, app_slug: app.slug, user_id: req.user.id,
        branch_name: headBranch, pr_number: prNumber, pr_title: pr.title || null,
        pr_body: pr.body || null,
        repo_url: app.repo_url, staging_url: null, source: 'imported',
        status: initialStatus, imported_pr_head_sha: headSha,
        handoff_base_sha: baseSha,
        imported_pr_head_repo: headRepoFullName,
        // #1330: the capture reads its routes off THIS object — the INSERT
        // above is not what it consults. kickImportedChecks hands this literal
        // to visuals.captureForSession, which derives both `pathDefaulted` and
        // `capturePaths` from `session.testing_paths` / `session.testing_path`.
        // Leaving them off meant EVERY connector submission's before/after pair
        // was shot on the app's home page, however carefully its `testingPaths`
        // named the screen that changed — and `submit_work` still echoed the
        // routes back as accepted, because they genuinely were: the row had
        // them all along. That is also why only the FIRST capture was wrong.
        // syncImportedProposal re-captures from a session loaded with
        // `SELECT cs.*`, so a later re-shoot used the routes; the one the
        // voters actually look at never did.
        testing_md: importTesting.testingMd,
        testing_path: importTesting.testingPath,
        testing_paths: importTesting.testingPaths,
        visual_evidence_state: visualEvidenceResult?.state || null,
        visual_evidence_detail: visualEvidenceResult?.detail || null,
      };

      if (promote) {
        // Explicit submissions still announce the vote exactly as before.
        const label = pr.title ? `PR #${prNumber}: ${pr.title}` : `PR #${prNumber}`;
        await sendSystemMessage(pool, app.id,
          `${req.user.username} imported ${label} for voting`,
          'vote',
          { vote: { sessionId, prNumber } }
        ).catch(() => {});
        await sendSystemMessage(pool, app.id,
          `${req.user.username} imported ${label} for voting`,
          'vote',
          { vote: { sessionId, prNumber } },
          { type: 'session', ref: sessionId }
        ).catch(() => {});
      }

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: promote ? 'promoted' : 'imported', sessionId, appSlug: app.slug });
      if (promote) {
        try {
          events.record(pool, {
            type: events.EVENT_TYPES.PR_PROMOTED,
            userId: req.user.id, appId: app.id, sessionId,
            metadata: { prNumber, source: 'imported' },
          });
        } catch { /* events are best-effort */ }
      }

      log.info('votes', 'PR imported', { sessionId, prNumber, appId: app.id, status: initialStatus });
      const evidenceSubmission = require('../services/proposal-update').visualEvidenceSubmissionFields(
        visualEvidenceResult || {
          state: null,
          accepted: false,
          rejected: !!importVisualEvidence,
          required: false,
          nextStep: importVisualEvidence
            ? 'visual_evidence_collection_disabled'
            : 'none',
        }
      );
      res.json({
        ok: true,
        sessionId,
        prNumber,
        status: initialStatus,
        ...evidenceSubmission,
      });

      // Kick the SHA-pinned staging build + checks after responding.
      const appForBuild = { id: app.id, slug: app.slug, name: app.name, repo_url: app.repo_url };
      kickImportedChecks(session, appForBuild, headSha);
    } catch (err) {
      log.error('votes', 'PR-import failed', {
        message: err.message,
        stage: err?.prImportStage || null,
        field: err?.prImportField || null,
      });
      res.status(500).json(prImportFailureBody(err));
    }
  });

  // #687 Slice 6: mock-control endpoint — simulate the external author
  // pushing a new commit to an imported PR, so a preview reviewer can drive
  // the head-change and merge-409 outcomes live (the sweeper would eventually
  // do the same, but this makes it a click). Mounted always but 404 unless
  // BOTH the master flag and the opt-in mock flag are on, so it can never do
  // anything in production (mock flag default off there). Collab access.
  //   body: { sessionId, mode }
  //     mode 'push-and-sync' (default) — bump the mock head AND run the sync
  //       poller path immediately: tally reset + "please re-review" note +
  //       checks re-run, and imported_pr_head_sha advances to the new head.
  //     mode 'push-only' — bump the mock head but DO NOT sync, leaving
  //       imported_pr_head_sha stale so the next merge attempt hits the
  //       exact-sha 409 (head-moved) path.
  router.post('/api/apps/:slug/pr-import/_mock/advance', async (req, res) => {
    try {
      if (!usesMockGithubForImports()) {
        return res.status(404).json({ error: 'Not found' });
      }
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const sessionId = parseInt(req.body?.sessionId, 10);
      const mode = req.body?.mode === 'push-only' ? 'push-only' : 'push-and-sync';
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ error: 'A valid sessionId is required' });
      }
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
          WHERE cs.id = $1 AND cs.app_id = $2 AND cs.source = 'imported'`,
        [sessionId, app.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Imported proposal not found' });
      const session = rows[0];
      if (!session.pr_number) return res.status(409).json({ error: 'Session has no PR number' });

      const newHead = githubMock.bumpHead(session.pr_number);
      let synced = false;
      if (mode !== 'push-only') {
        const prImportSync = require('../services/pr-import-sync');
        const result = await prImportSync.syncImportedProposal({ config, pool, session });
        synced = result === 'updated';
      }
      log.info('votes', 'Mock PR head advanced', { sessionId, prNumber: session.pr_number, mode, newHead, synced });
      res.json({ ok: true, mode, newHead, synced });
    } catch (err) {
      log.error('votes', 'PR-import mock advance failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cast a vote on a promoted PR
  router.post('/api/sessions/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    }
    // #1688: the sentence behind the vote. Optional on a Yes; a No without
    // one is refused further down, once the voter's earlier row is known.
    const normalized = normalizeVoteReason(req.body?.reason);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const reason = normalized.reason;

    try {
      // Accept votes on 'promoted' OR 'merging' sessions — once a merge
      // has started, a user flipping their vote shouldn't 404. But we
      // only *do* anything with the vote (chat message, merge check) if
      // it actually changed; see below.
      const { rows: sessionRows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status IN ('promoted', 'merging')`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Promoted session not found' });
      const session = sessionRows[0];

      // Verify the live head before recording a native vote. The PR may have
      // moved since the proposal was opened; in that case
      // reconcileNativeReviewedHead advances the reviewed revision,
      // drops only stale-revision votes, invalidates old checks, and this vote
      // is then safely recorded against the new commit.
      const revision = await reconcileNativeReviewedHead({
        config, pool, session, fresh: true,
      });
      if (revision.blocked) {
        return res.status(revision.transient ? 503 : 409).json({ error: revision.reason });
      }

      const evidenceGate = await readVisualEvidenceGate(config, pool, session);
      if (evidenceGate.applies && !evidenceGate.allowed) {
        return res.status(409).json({
          error: 'visual_evidence_required',
          message: evidenceGate.reason,
          visualEvidenceState: evidenceGate.state,
        });
      }

      // A Yes vote can be the operation that applies a value held by a
      // secret-declaration proposal. The generic session vote path stays
      // available for ordinary PRs, but api:access is not credential authority.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // A click approves the PROPOSAL the voter was shown, which is not the
      // same claim as "the commit the voter was shown". The old guard compared
      // commits and so rejected this click on every platform sync — including
      // the ones reconciliation had just certified changed nothing, which is
      // how a vote-preserving merge still cost somebody their vote (#2038).
      // The epoch only moves when bytes nobody approved were written.
      if (!voteMatchesApprovalEpoch(req.body?.expectedEpoch, revision)) {
        return revisionChangedVoteResponse(res, revision.headSha, null, revision.epoch);
      }

      // Was this a new vote, or a flip? Distinguishing matters because
      // without this, a user mashing "Yes" would post the same
      // "X voted yes on PR #N" line to group chat every time AND fire a
      // fresh checkAndMerge on every click — which, before the merge
      // concurrency guard, caused 7× parallel GitHub merges + docker
      // rebuilds stepping on each other's tempdirs and container names.
      // The DB upsert itself is still safe (UNIQUE(session_id,user_id))
      // but we avoid the side-effects on a no-op.
      const { rows: prevRows } = await pool.query(
        `SELECT pv.vote, pv.reason, pv.approval_epoch, cs.approval_epoch AS current_epoch
           FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
          WHERE pv.session_id = $1 AND pv.user_id = $2`,
        [session.id, req.user.id]
      );
      const previousVote = prevRows[0]?.vote || null;
      const previousReason = prevRows[0]?.reason || null;
      const voteHeadSha = reviewedHeadForSession(session);
      // #1688: a No always carries a line, so the proposer learns what to
      // fix rather than only that somebody minded. The one No that need not
      // bring a new one is a re-cast of a No that already has its line —
      // the upsert keeps it (see VOTE_REASON_UPSERT_SQL).
      if (vote === 'no' && !reason && !(previousVote === 'no' && previousReason)) {
        return res.status(400).json({
          error: 'reason_required',
          message: VOTE_REASON_REQUIRED,
          maxLength: VOTE_REASON_MAX,
        });
      }
      // #2038: "unchanged" means the same person voting the same way on the
      // same PROPOSAL. Keying it on the commit made a re-vote after a
      // mechanical sync look like a change, re-posting to group chat and
      // re-entering checkAndMerge for a click that moved nothing.
      const sameSide = previousVote === vote
        && prevRows[0]?.approval_epoch != null
        && prevRows[0].approval_epoch === prevRows[0].current_epoch;
      const unchanged = sameSide && (reason === null || reason === previousReason);
      // Same side, new words (#1688): the row is updated and the roster
      // re-reads it, but nothing is announced or re-counted — the vote did
      // not move.
      const reasonOnly = sameSide && !unchanged;

      // Stamp every GitHub proposal vote with its reviewed PR head. Imported
      // proposals retain imported_pr_head_sha; native proposals use the new
      // reviewed_head_sha populated above. Governance counts only approvals
      // matching the current revision.
      const recorded = await recordVote({
        pool,
        session,
        userId: req.user.id,
        vote,
        headSha: voteHeadSha,
        revisionEnforced: !!revision.enforced,
        reason,
      });
      // The line the row now carries: the one sent, or the earlier one the
      // upsert kept for a same-side re-cast (a Yes carried onto a new
      // version brings its sentence along).
      const recordedReason = recorded?.rows?.[0]?.reason ?? reason ?? null;
      if (revision.enforced && (recorded.rowCount || 0) === 0) {
        // The DB head moved after the GitHub read but before the write lock.
        // Refresh the proposal state, but never transfer this click to it.
        const latest = await reconcileNativeReviewedHead({
          config, pool, session, fresh: true,
        }).catch(() => null);
        return revisionChangedVoteResponse(
          res,
          latest && !latest.blocked ? latest.headSha : reviewedHeadForSession(session),
          'This proposal changed while your vote was being recorded. Refresh it, review the new revision, then vote again.'
        );
      }

      // Any voting activity revives a going-stale PR: clear the warning
      // flag so the stale sweeper restarts its clock instead of archiving.
      if (session.stale_notified_at) {
        await pool.query(
          `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
          [session.id]
        );
      }

      // Auto-dismiss this voter's PR notifications for this session now that
      // the vote is recorded in the DB (i.e. confirmed, not optimistic). Runs
      // before the `unchanged` early-return below so a re-vote still ensures
      // the nudge is cleared, and it's idempotent (clears only unread rows).
      // Non-fatal: a notification hiccup must never 500 a successful vote.
      try {
        const cleared = await notifications.markReadForSession(pool, req.user.id, session.id);
        if (cleared > 0) {
          // Fan out to the voter's OTHER tabs/devices so their unread badge
          // syncs without a manual refresh; the acting tab refreshes itself.
          pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('votes', 'notification auto-dismiss failed', {
          sessionId: session.id, userId: req.user.id, err: err.message,
        });
      }

      if (unchanged) {
        log.debug('votes', 'Vote unchanged, skipping broadcast+merge', {
          sessionId: session.id, userId: req.user.id, vote,
        });
        return res.json({ ok: true, merged: false, unchanged: true });
      }
      if (reasonOnly) {
        // #1688: the same vote with new words. The roster and the proposer's
        // notification read the row live, so a tally push is all the
        // clients need; no line is re-posted and no merge is re-checked.
        const { pushVoteUpdate: pushReason } = require('../services/ws');
        pushReason({ sessionId: session.id, appSlug: session.app_slug, merged: false });
        log.debug('votes', 'Vote reason updated', { sessionId: session.id, userId: req.user.id });
        return res.json({ ok: true, merged: false, unchanged: false, reasonUpdated: true });
      }

      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;

      // #1374: tell the author somebody voted. Reached only on a real vote,
      // because the `unchanged` branch above already returned — and the
      // producer additionally de-dupes per (voter, session), so flipping a
      // vote back and forth is not a way to ping somebody repeatedly.
      //
      // Best-effort: a vote is recorded whether or not its notification is.
      try {
        notifications.createProposalVoteNotification?.(pool, {
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          voterId: req.user.id,
          vote,
        })?.then((created) => Promise.all(
          created.map((row) => notifications.hydrateAndPush(pool, row))
        ))?.catch((err) => log.error('votes',
          'Vote notification failed', { sessionId: session.id, err: err.message }));
      } catch (err) {
        log.error('votes', 'Vote notification threw', { sessionId: session.id, err: err.message });
      }

      // #1688: with a line, the row is the person's sentence rather than
      // their tally — the thread it lands in is the proposal's own, so the
      // PR label it used to repeat is the thread's title. Without one, the
      // line reads exactly as before.
      const voteLine = recordedReason
        ? `${req.user.username} voted ${vote}: “${recordedReason}”`
        : `${req.user.username} voted ${vote} on ${voteLabel}`;
      await sendSystemMessage(pool, session.app_id,
        voteLine,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null, reason: recordedReason } },
        // #194: per-vote activity lands in the proposal's own thread, not
        // general chat — the promote/merge announcements remain the
        // general-chat entry points.
        { type: 'session', ref: session.id }
      );

      // Broadcast the new tally *before* we try to merge, and respond
      // to the voter right away. checkAndMerge can take 30+ seconds on
      // the majority path (GitHub merge + prod rebuild + staging
      // teardown) and blocking on it here meant:
      //   - every other user's vote count sat stale until merge
      //     finished, which looked like "votes don't update live",
      //   - the voter's own UI sat mid-click with a spinning button
      //     while the merge ran, sometimes for the full 30s.
      // The merge itself still runs atomically (checkAndMerge claims
      // the session via 'promoted' → 'merging'), so kicking it into
      // the background doesn't change correctness.
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false });
      log.info('votes', 'Vote cast', { sessionId: session.id, vote, userId: req.user.id });

      // #1688: a No is the one vote that can make a proposal contested. When
      // it does, the proposal's thread gets its script — once per version
      // (services/conversation-prompt.js). Never in the vote's way.
      if (vote === 'no') {
        require('../services/conversation-prompt').promptIfContested(pool, session)
          .then((r) => { if (r.prompted) log.info('votes', 'Conversation prompt posted', { sessionId: session.id, epoch: r.epoch }); })
          .catch((err) => log.warn('votes', 'Conversation prompt failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));
      }

      // Emit only on a real (new or flipped) vote — the `unchanged`
      // no-op already returned above. pr_vote_cast credits the voter;
      // pr_vote_received credits the PR author (when still attributed),
      // so the PR-promotion funnel can measure "got a vote" reach.
      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_CAST,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { vote },
      });
      if (session.user_id && session.user_id !== req.user.id) {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_VOTE_RECEIVED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { vote, voterId: req.user.id },
        });
      }
      res.json({ ok: true, merged: false });

      // Kick off the majority check in the background. If it turns
      // into a merge, we send a second broadcast so clients flip the
      // PR out of the vote panel and update the "merged" list.
      checkAndMerge(config, pool, session)
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background merge failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get vote tally for a session. #646: when the app restricts
  // approvals to invited approvers, `approvers` lists the usernames
  // whose votes QUALIFY (the roster, incl. the full-admin fallback) so
  // the FE can tag approver votes; it's absent under the default
  // 'anyone' policy.
  router.get('/api/sessions/:id/votes', async (req, res) => {
    try {
      // Every row, with whether it still counts: the ones from an earlier
      // version are the people the page names as asked back (#1688), so
      // they are read here rather than filtered out in SQL.
      const { rows: allRows } = await pool.query(
        `SELECT pv.vote, pv.reason, u.username, pv.user_id,
                ${currentVotePredicateSql('pv', 'cs')} AS current
         FROM pr_votes pv
         JOIN users u ON pv.user_id = u.id
         JOIN chat_sessions cs ON cs.id = pv.session_id
         WHERE pv.session_id = $1
         ORDER BY pv.created_at ASC, pv.id ASC`,
        [req.params.id]
      );
      const rows = allRows.filter((r) => r.current === true);
      const earlierRows = allRows.filter((r) => r.current !== true);

      const yes = rows.filter((r) => r.vote === 'yes');
      const no = rows.filter((r) => r.vote === 'no');

      const out = {
        yes: yes.map((r) => r.username),
        no: no.map((r) => r.username),
        // #1688: the sentence each counted vote carries, in vote order.
        reasons: rows.filter((r) => r.reason)
          .map((r) => ({ username: r.username, vote: r.vote, reason: r.reason })),
        // Votes cast on an earlier version of the proposal — still on the
        // row, no longer counted, their owners asked to take another look.
        earlier: {
          yes: earlierRows.filter((r) => r.vote === 'yes').map((r) => r.username),
          no: earlierRows.filter((r) => r.vote === 'no').map((r) => r.username),
        },
      };

      try {
        const { rows: sessRows } = await pool.query(
          'SELECT app_id FROM chat_sessions WHERE id = $1', [req.params.id]
        );
        const appId = sessRows[0]?.app_id;
        if (appId) {
          const governance = require('../services/governance');
          const gov = await governance.getGovernance(pool, appId);
          if (gov.approverPolicy === 'invited') {
            const { ids } = await governance.getApproverSet(pool, appId);
            const idSet = new Set(ids);
            out.approvers = rows.filter((r) => idSet.has(r.user_id)).map((r) => r.username);
          }
        }
      } catch (err) {
        log.warn('votes', 'approver tagging failed (non-fatal)', { err: err.message });
      }

      res.json(out);
    } catch (err) {
      log.error('votes', 'Failed to get votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #194: the viewer's own proposals currently open for voting, across
  // all apps — PR proposals (their promoted/merging sessions) plus their
  // open governance (secret_change) proposals. Backs the home screen's
  // "Your proposals" section. Like /api/me/active-sessions, no extra
  // visibility filter is needed: these are the viewer's own rows, so the
  // apps are by construction ones they can collaborate on.
  router.get('/api/me/proposals', async (req, res) => {
    try {
      const { rows: sessions } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_title_fallback, cs.status,
                cs.created_at, cs.promoted_at,
                cs.merge_conflict_state, cs.behind_main,
                cs.check_state, cs.check_error_detail, cs.check_phase, cs.check_trigger, cs.checks_progress,
                -- #1442: the same freshness cache /promoted reads, so the
                -- home strip's pill and the proposal card cannot disagree
                -- about whether a proposal is ready to merge.
                cs.checks_base_sha, cs.checks_base_verdict, cs.checks_base_behind_by,
                cs.mergeability, cs.mergeability_files, cs.mergeability_files_complete,
                cs.freshness_behind_by, cs.freshness_checked_at,
                cs.requires_explicit_approval,
                -- #866: so the home strip can derive the same
                -- building/unavailable preview state the proposal card
                -- shows (see staging.previewDisplayState below).
                cs.staging_url, cs.source,
                cs.imported_pr_head_sha, cs.reviewed_head_sha,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
         WHERE cs.user_id = $1 AND cs.status IN ('promoted', 'merging')
           AND cs.is_headless = FALSE
         ORDER BY cs.promoted_at DESC NULLS LAST, cs.created_at DESC`,
        [req.user.id]
      );

      const { rows: governance } = await pool.query(
        `SELECT i.id, i.title, i.kind, i.created_at,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up') AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
         FROM issues i JOIN apps a ON a.id = i.app_id
         WHERE i.created_by = $1 AND i.kind = 'secret_change' AND i.status = 'open'
         ORDER BY i.created_at DESC`,
        [req.user.id]
      );

      // Per-app active-user majority (the denominator for the tally
      // pill). One getActiveUserStats call per distinct app, cached in
      // a map — most users have proposals on a handful of apps at most.
      // #646: plus the per-app governance settings + electorate, so the
      // gate matches the app's configured approval mode.
      const governanceSvc = require('../services/governance');
      const appIds = [...new Set([...sessions, ...governance].map((r) => r.app_id))];
      const statsByApp = {};
      const govByApp = {};
      const electorateByApp = {};
      for (const appId of appIds) {
        statsByApp[appId] = await getActiveUserStats(pool, appId);
        govByApp[appId] = await governanceSvc.getGovernance(pool, appId);
        electorateByApp[appId] = await governanceSvc.getElectorate(pool, appId, govByApp[appId]);
      }

      const proposals = [];
      for (const s of sessions) {
        const gov = govByApp[s.app_id];
        const electorate = electorateByApp[s.app_id];
        const q = electorate?.approverIds
          ? await governanceSvc.qualifiedCounts(
            pool, 'pr', s.id, electorate.approverIds, reviewedHeadForSession(s)
          )
          : { yes: s.yes_count, no: s.no_count };
        // Per-row dynamic merge gate + rejection countdown, mirroring
        // /api/apps/:slug/promoted (same anchor: promoted_at || created_at).
        // #788: the stamped flag rides on the row (added to this
        // endpoint's SELECT), so the no-timer modifier applies here
        // without a per-row GitHub call.
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, s.promoted_at || s.created_at, null,
          { explicitApproval: !!s.requires_explicit_approval }
        );
        proposals.push({
          ...s,
          ...require('../services/staging').previewDisplayState(s),
          majority: statsByApp[s.app_id]?.majority || 1,
          activeUsers: statsByApp[s.app_id]?.active || 1,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          reject_window_ends_at: gate.rejectionEndsAt,
          rejection_armed: gate.rejectionArmed,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          requires_explicit_approval: !!s.requires_explicit_approval,
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        });
      }

      // #405: staging-only demo rows (?demo=1) so the home "Your proposals"
      // strip's canonical merge-lifecycle chips — In vote, Behind, Resolving
      // conflicts…, Checks running…, Passed — merging shortly, Merging… — are
      // all reviewable against a prod-cloned DB. Reuses the same fixtures the
      // proposal feed uses (stagingMockProposals), mapped into this endpoint's
      // shape with a fixed demo majority of 3 so the tally-dependent states
      // (in-vote vs. ready) resolve deterministically regardless of the
      // staging app's live active-user count. Gated on IS_STAGING — a no-op
      // in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(proposals.map((p) => p.id));
        const DEMO_MAJORITY = 3;
        const demoRows = stagingMockProposals()
          .filter((m) => (m.status === 'promoted' || m.status === 'merging') && !have.has(m.id))
          .map((m) => ({
            id: m.id,
            pr_number: m.pr_number,
            pr_url: m.pr_url,
            pr_title: m.pr_title,
            status: m.status,
            created_at: m.created_at,
            promoted_at: m.promoted_at,
            merge_conflict_state: m.merge_conflict_state || null,
            behind_main: m.behind_main || 0,
            check_state: m.check_state || null,
            test_results: m.test_results || [],
            checks_checked_at: m.checks_checked_at || null,
            // #1442: the freshness fixtures carry through here too, so the
            // home strip's pill can be reviewed against the same three
            // states the proposal card renders.
            mergeability: m.mergeability || null,
            mergeability_files: m.mergeability_files || [],
            mergeability_files_complete: m.mergeability_files_complete == null
              ? null : m.mergeability_files_complete,
            checks_base_sha: m.checks_base_sha || null,
            checks_base_verdict: m.checks_base_verdict || null,
            checks_base_behind_by: m.checks_base_behind_by == null ? null : m.checks_base_behind_by,
            freshness_behind_by: m.freshness_behind_by == null ? null : m.freshness_behind_by,
            freshness_checked_at: m.freshness_checked_at || null,
            // #866: carry the mock preview state through so the imported-PR
            // fixtures read the same on the home strip as on the card.
            source: m.source || null,
            staging_url: m.staging_url || null,
            staging_building: !!m.staging_building,
            staging_error: m.staging_error || null,
            // #447: demo-only hint that renders the "Re-run checks" button
            // for any ?demo=1 viewer (real rows gate on owner/admin instead).
            recheckable: m.recheckable || false,
            resolving: m.resolving || false,
            app_id: 0,
            app_slug: 'staging-demo',
            app_name: 'Staging demo app',
            yes_count: m.yes_count,
            no_count: m.no_count,
            majority: DEMO_MAJORITY,
            activeUsers: DEMO_MAJORITY,
          }));
        proposals.push(...demoRows);
      }

      const governanceRows = [];
      for (const g of governance) {
        const gov = govByApp[g.app_id];
        const electorate = electorateByApp[g.app_id];
        const q = electorate?.approverIds
          ? await governanceSvc.qualifiedCounts(pool, 'issue', g.id, electorate.approverIds)
          : { yes: g.up_count, no: g.down_count };
        // Governance proposals have no promote step — created_at is the
        // visibility-window anchor. down votes feed both gates.
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, g.created_at
        );
        governanceRows.push({
          ...g,
          majority: statsByApp[g.app_id]?.majority || 1,
          activeUsers: statsByApp[g.app_id]?.active || 1,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          // #695: qualifying tallies, matching the PR rows above, so the
          // home strip pill counts approver votes only on invited apps.
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        });
      }

      res.json({
        proposals,
        governance: governanceRows,
      });
    } catch (err) {
      log.error('votes', 'Failed to list my proposals', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List promoted sessions (for the vote panel in group chat).
  // View-level (#621): read-only viewers see proposals + tallies;
  // voting itself stays collab-gated on POST /api/sessions/:id/vote.
  router.get('/api/apps/:slug/promoted', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, locked`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;
      // Include 'merging' alongside 'promoted' so the PR stays visible
      // during the GitHub merge + prod rebuild + staging teardown
      // pipeline (~30s). Otherwise the card disappears the instant the
      // majority threshold is crossed and only reappears in the "merged"
      // list at the very end, making it look like the vote was lost.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_title_fallback, cs.pr_summary_md, cs.pr_body, cs.staging_url, cs.testing_md, cs.testing_path, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           cs.visual_evidence_state, cs.visual_evidence_run_id,
           cs.visual_evidence_detail, cs.visual_evidence_updated_at,
           -- #687 (PR-import): provenance so the client can render the
           -- "Imported PR" badge + GitHub-maintained note and hide the
           -- dev-side controls for externally-authored proposals.
           cs.source, cs.imported_pr_author, cs.imported_pr_head_sha,
           cs.reviewed_head_sha,
           -- Where the imported head lives. The card decides from it (against
           -- the app's repo_url it already has) whether the platform syncs
           -- this branch itself or only the author can — without it the
           -- browser fell back to a branch-name guess and told the group
           -- "the author must update this branch in their fork" about a
           -- branch in the app's own repository (#2100).
           cs.imported_pr_head_repo,
           -- #967: which external coding agent wrote it, when the proposal
           -- came in through the hosted MCP connector ('claude-code' |
           -- 'codex' | 'external'). NULL for everything else. Drives the
           -- "built with …" chip beside the imported badge.
           cs.external_agent,
           -- #361: persisted merge-conflict snapshot for the card badge +
           -- detail block (state, conflicting file paths, last-checked).
           cs.merge_conflict_state, cs.behind_main, cs.conflict_files, cs.conflict_checked_at,
           -- #381: console-error check snapshot for the "may break the app"
           -- warning badge + detail block (advisory, never gates the vote).
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: "CI for proposals" check snapshot for the checks badge +
           -- per-test detail block. Unlike the console snapshot this GATES
           -- merge (checkAndMerge blocks a non-'passing' proposal).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           cs.checks_commit_sha,
           -- #1442: the freshness cache. behind_main above is now written
           -- THROUGH from freshness_behind_by, so it and these agree; the
           -- rest are the answers nothing used to re-derive once a proposal
           -- was promoted — whether it still merges cleanly, and whether the
           -- base its checks passed against is still on main. All nullable:
           -- NULL is "not measured", which the card reads as unknown rather
           -- than as a claim.
           cs.checks_base_sha, cs.checks_base_verdict, cs.checks_base_behind_by,
           cs.mergeability, cs.mergeability_files, cs.mergeability_files_complete,
           cs.freshness_main_sha, cs.freshness_merge_base_sha,
           cs.freshness_behind_by, cs.freshness_ahead_by,
           cs.freshness_checked_at, cs.freshness_error,
           -- #2038: the single integration record, and the epoch a vote is
           -- pinned to. The card reads these; the six groups above are kept
           -- written-through for one release so nothing that still reads
           -- them breaks mid-rollout.
           cs.integration_measured_at, cs.integration_head_sha, cs.integration_main_sha,
           cs.integration_base_sha, cs.integration_behind_by, cs.integration_ahead_by,
           cs.integration_merges_clean, cs.integration_conflict_paths,
           cs.integration_merged_tree, cs.integration_checks_base_current,
           cs.integration_block_reasons, cs.integration_error,
           cs.approval_epoch,
           -- #2061: the recording of what the merge gate last did, which the
           -- card turns into "what this still needs before it merges".
           cs.merge_requirements, cs.merge_requirements_at,
           -- Which half of a 'pending' run is in flight ('building' |
           -- 'testing'), so the checks card names the stage instead of
           -- showing one opaque "still running". NULL = legacy wording.
           cs.check_phase,
           cs.check_trigger,
           cs.checks_progress,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: captured reason when checks are 'error' (staging preview
           -- failed to boot) — drives the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
           -- #788: does this proposal change dapp.json's admins block? A
           -- flagged row loses the time-based merge paths (the gate below
           -- reports no merge_window_ends_at, so no countdown renders) and
           -- shows the "Explicit approval" chip.
           cs.requires_explicit_approval,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${currentVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${currentVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- #1688: the viewer's vote on an EARLIER version — still on their
           -- row, no longer counted. The card asks "Still yes?" from it.
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND NOT COALESCE(${currentVotePredicateSql('pv', 'cs')}, FALSE)) as my_prior_vote,
           -- Kudos counts piggy-back on this query so the vote panel
           -- doesn't fan out to N extra round-trips per PR card. The
           -- (session_id, giver_user_id) UNIQUE constraint makes EXISTS
           -- a single-index probe; COUNT runs against the per-session
           -- index added in schema.sql.
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #11: revert_of_session_id is non-null on PRs that are
           -- themselves a git-revert of an earlier merged PR. The
           -- vote panel uses this to render a Revert label
           -- instead of the regular title so voters know what they
           -- are voting on.
           cs.revert_of_session_id,
           orig.pr_number as original_pr_number,
           orig.pr_title  as original_pr_title,
           -- #194: per-proposal thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. The partial thread index makes these
           -- index-only probes per row. promoted_at is the proposal's own
           -- activity anchor (falls back to created_at client-side).
           -- chat_count counts human messages only (msg_type='message')
           -- so dual-posted lifecycle/vote system rows don't make the 💬
           -- badge claim a discussion that hasn't happened.
           cs.promoted_at,
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id) as last_message_at,
           -- #195/#270: before/after capture artifacts, aggregated to one
           -- jsonb per row. Key is 'kind_index_media' ('before_0_png',
           -- 'after_1_webm', ...) so multiple captured routes
           -- (capture_index) don't collide; the value carries the artifact
           -- id plus the group label / frame / before-fallback flag so the
           -- vote-panel tiles render real path labels and the fell-back
           -- caption. Shaped into the grouped client form below via
           -- visuals.shapeAgg (which also still accepts the legacy
           -- 'kind_media' key and bare-id string values from older rows).
           (SELECT jsonb_object_agg(
                     sv.kind || '_' || sv.capture_index || '_' || sv.media,
                     jsonb_build_object(
                       'id', sv.id,
                       'path', sv.captured_path,
                       'viewport', sv.captured_viewport,
                       'commit', sv.commit_hash,
                       'scenarioId', sv.scenario_id,
                       'scenarioFingerprint', sv.scenario_fingerprint,
                       'fellBack', sv.before_fell_back))
              FROM session_visuals sv WHERE sv.session_id = cs.id) as visuals_agg
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions orig ON orig.id = cs.revert_of_session_id
         WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
         ORDER BY cs.created_at DESC`,
        [appRows[0].id, userId]
      );

      const visualsService = require('../services/visuals');
      const stagingService = require('../services/staging');
      for (const row of rows) {
        row.visuals = visualsService.shapeAgg(
          row.visuals_agg, visualHeadForSession(row)
        );
        delete row.visuals_agg;
        // #866: three-state Preview affordance. An imported PR is promoted
        // before its preview finishes building, so `staging_url IS NULL`
        // alone can't tell "building" from "failed" — derive both here
        // (in-memory build map + the captured checks error) rather than
        // persisting a staging_state column that a crash could strand.
        Object.assign(row, stagingService.previewDisplayState(row));
        // #239: surface in-flight auto-conflict-resolution so the vote
        // panel can render a "Resolving conflicts…" badge. Process-local
        // map lookup (no SQL) — authoritative in the single-process
        // platform, and self-healing on every panel refresh.
        row.resolving = isResolving(row.id);
      }
      const evidenceBySession = config.visualEvidence?.present
        ? await visualEvidenceView.getForSessions(pool, rows, req.params.slug)
        : new Map();
      for (const row of rows) row.visualEvidence = evidenceBySession.get(Number(row.id)) || null;

      // Community-voted priority + assigned-person summary per proposal,
      // keyed by session id (target_type='proposal'). Same minimal shape
      // the issue feed attaches; the dropdown lazy-loads the full tally
      // from /api/apps/:slug/topics/proposal/:id/attributes.
      const promotedAttrs = await topicAttrs.summarizeForProposals(
        pool, appRows[0].id,
        rows.map((r) => ({ id: r.id, linked_issues: r.linked_issues })), userId
      );
      for (const row of rows) {
        const s = promotedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
        row.category = s.category;
      }

      // Staging-only demo mode (?demo=1): append long-title mock
      // proposals for layout verification. The id check keeps the
      // append idempotent should a mock id ever materialize in the
      // result. See stagingMockProposals above.
      const demoMode = IS_STAGING && req.query.demo === '1';
      if (demoMode) {
        const have = new Set(rows.map((r) => r.id));
        rows.push(...stagingMockProposals(req.user?.username).filter((m) => !have.has(m.id)));
      }

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appRows[0].id);
      // Whether the viewer themself counts as active for this app —
      // surfaced on the group-chat dashboard so they can see their
      // own status and (if not counted) understand what to do about
      // it. Cheap query (two EXISTS lookups), runs alongside the
      // existing active-stats query.
      const viewerActive = await isUserActive(pool, appRows[0].id, userId);

      // Per-row dynamic merge gate. The eased threshold and the visibility
      // window both depend on this row's own yes/no counts and open time, so
      // they can't be a single app-level number. Mock rows (?demo=1) already
      // carry precomputed values that bypass the live `active` lookup — leave
      // those untouched.
      //
      // #646: governance-aware. Under the default settings this is the
      // old per-row mergeGate over the raw tallies; under
      // approver_policy='invited' the qualifying counts (approver votes
      // only) are batch-fetched in one query and the electorate is the
      // approver roster; under approvals_required=N the gate is the
      // clock-free "at least N" check. Every live row also carries
      // approval_policy / approvals_required / qualified_* so the vote
      // pill + help text can describe the configured mode.
      const governance = require('../services/governance');
      const gov = await governance.getGovernance(pool, appRows[0].id);
      const electorate = await governance.getElectorate(pool, appRows[0].id, gov);
      let qualifiedByRow = null;
      if (electorate.approverIds) {
        qualifiedByRow = await governance.qualifiedCountsBatch(
          pool, 'pr',
          rows.filter((r) => r.votes_required == null).map((r) => r.id),
          electorate.approverIds
        );
      }
      for (const row of rows) {
        if (row.votes_required != null) continue;
        const q = qualifiedByRow
          ? (qualifiedByRow.get(row.id) || { yes: 0, no: 0 })
          : { yes: row.yes_count, no: row.no_count };
        // #788: the stamped flag rides on the row (chat_sessions.* is
        // selected here), so the no-timer modifier applies with no extra
        // per-row work — a flagged row simply reports no
        // merge_window_ends_at and never renders a countdown.
        const gate = governance.computeGate(
          gov, electorate.active, q.yes, q.no,
          row.promoted_at || row.created_at, null,
          { explicitApproval: !!row.requires_explicit_approval }
        );
        row.votes_required = gate.required;
        row.merge_window_ends_at = gate.windowEndsAt;
        row.contested = gate.contested;
        row.reject_window_ends_at = gate.rejectionEndsAt;
        row.rejection_armed = gate.rejectionArmed;
        row.approval_policy = gate.policy;
        row.approvals_required = gate.approvalsRequired;
        row.requires_explicit_approval = !!row.requires_explicit_approval;
        row.qualified_yes_count = gate.qualifiedYes;
        row.qualified_no_count = gate.qualifiedNo;
      }

      // #1442: the freshness snapshot also rides as a nested camelCase block
      // for API consumers (the connector's get_proposal shapes from the same
      // vocabulary). The flat snake_case columns stay exactly where they were
      // — public/js/app-view.js reads those — so this is additive on both
      // sides rather than a rename anything has to follow.
      // The app's main, as services/main-watch.js last saw it. One read per
      // panel, not per row: a red main pauses every merge on the app, and
      // the provisional ledger below names that step off these columns.
      const mainCheck = await require('../services/main-watch').mergePause(pool, appRows[0].id);
      // And, for the platform's own app, a merged commit that has not become
      // the running release (services/release-watch.js). Only that row ever
      // carries one, so a child app's panel does not pay the read; the board
      // banner draws it.
      const releaseWatch = require('../services/release-watch');
      const releaseStall = appRows[0].self_hosted
        ? await releaseWatch.readStall(pool, appRows[0].id)
        : releaseWatch.describe(null);
      {
        const freshnessSvc = require('../services/proposal-freshness');
        const integrationSvc = require('../services/integration');
        const requirementsSvc = require('../services/merge-requirements');
        for (const row of rows) {
          row.freshness = freshnessSvc.readFreshness(row);
          // #2038: the one answer the card actually renders, carrying its own
          // measuredAt so it can say how old it is instead of implying it is
          // live. `blockReason` rides along so the card stops re-deriving a
          // guess from a thirteen-state precedence table — the gate knows
          // which rung refused and now says so.
          row.integration = integrationSvc.readIntegration(row);
          row.evidenceEnforced = !!config.visualEvidence?.enforce
            && !!(row.visual_evidence_detail && typeof row.visual_evidence_detail === 'object');
          // #2061: the whole ordered list of what is still required, rather
          // than only what is currently wrong. The card's tags say the second;
          // nothing said the first, so two of the seven gates had no UI at all.
          row.mergeRequirements = requirementsSvc.readRequirements({
            ...row,
            evidenceEnforced: row.evidenceEnforced,
            app_main_check_state: mainCheck.state,
            app_main_check_sha: mainCheck.sha,
            app_main_check_resumed_sha: mainCheck.resumedSha,
            // The pause is its own fact (main_check_paused_sha), and a red
            // names its test; the ledger says both rather than re-deriving.
            app_main_check_paused: mainCheck.paused,
            app_main_check_paused_sha: mainCheck.pausedSha,
            app_main_check_confirming: mainCheck.confirming,
            app_main_check_failing_test: mainCheck.failingTest,
          });
        }
      }

      res.json({
        promoted: rows,
        // services/main-watch.js: the unit suite's verdict on the last
        // merge commit, and whether it is pausing this app's merges.
        mainCheck,
        // services/release-watch.js: a merged self-app commit that is not
        // the running release. `stalled: false` everywhere but there.
        releaseStall,
        activeUsers,
        majority,
        viewerActive,
        // Surfaced so the vote panel can render the "(locked — also
        // needs an admin yes)" hint on the Open PRs / Rename proposals
        // sections without a second round-trip. See loadVotePanel in
        // public/js/app-view.js.
        //
        // FORCED OPEN IN DEMO MODE, staging only. A locked app legitimately
        // suppresses every DERIVED vote state on the client — a
        // threshold-met proposal there is waiting on an admin's Yes, not
        // being applied, so _derivedGovApplying / _govMergeDue in
        // app-view.js return nothing rather than promise a merge that isn't
        // happening. The mock rows exist precisely to show those states,
        // and they carry precomputed gate fields for the same reason (see
        // stagingMockProposals / stagingMockGovernance): a prod-cloned
        // staging DB brings the real app row with it, and the platform's own
        // app row is locked, so ?demo=1 rendered every mock as a plain
        // waiting card and the states were unreviewable. Only this
        // fixture-preview mode lies; the ordinary staging board still
        // reports the clone's real lock state, hint and notice included.
        locked: !!appRows[0].locked && !demoMode,
        // #646: the app's configured approval settings, for the vote
        // panel context (_proposalsCtx in public/js/app-view.js).
        approverPolicy: gov.approverPolicy,
        approvalsRequired: gov.approvalsRequired,
        // #788: whether the viewer is one of this app's declared admins,
        // so the vote panel can render the "Admin merge" affordance for
        // them without a second round-trip. Server-side gates re-check.
        isAppAdmin: await appAdmins.isAppAdmin(pool, appRows[0].id, req.user?.id),
      });
    } catch (err) {
      log.error('votes', 'Failed to list promoted', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List merged sessions. View-level (#621) — read-only history.
  router.get('/api/apps/:slug/merged', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;

      // #429: keyset pagination so the Completed list can reach every
      // merged PR, not just the most-recent page. `limit` defaults to 20
      // (the historical cap) and is clamped to 50. `before` + `before_id`
      // form the cursor — the (created_at, id) of the last row the client
      // already has — and we page strictly older than it. Keyset (not
      // OFFSET) because new merges insert at the top and would otherwise
      // drift the offset. created_at isn't unique, so id is the tiebreaker.
      //
      // The stream now interleaves TWO row types (merged PR sessions and
      // applied close-issue proposals — see below), whose ids come from
      // independent sequences, so the cursor carries a third part:
      // `before_type` ('pr' | 'close_issue', defaulting to 'pr' so older
      // clients keep paging PRs exactly as before). Global order is
      // (created_at DESC, type-rank DESC, id DESC) with rank pr=1 >
      // close_issue=0 — see completedRowCompare.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 20;
      if (limit > 50) limit = 50;
      const beforeRaw = req.query.before;
      const beforeIdRaw = parseInt(req.query.before_id, 10);
      const before = new Date(beforeRaw);
      // A cursor only applies when BOTH parts parse cleanly; otherwise we
      // ignore it and return the newest page (defensive against malformed
      // query strings).
      const hasCursor = beforeRaw != null && !Number.isNaN(before.getTime())
        && Number.isFinite(beforeIdRaw);
      const isFirstPage = !hasCursor;
      const beforeType = req.query.before_type === 'close_issue' ? 'close_issue' : 'pr';

      // Same kudos subqueries as /promoted so the merged card can show
      // its count + per-viewer "you gave kudos" state without a second
      // round-trip per row. cs.user_id is also surfaced so the FE
      // kudos button can disable itself client-side for self-PRs
      // (server still 403s as authority).
      //
      // #11/#16: surfaces the revert-session metadata (pr_number, status)
      // when one exists — so the UI can render "Undone by PR #N" /
      // "Revert in vote (PR #N)" labels without a per-row round-trip.
      // (Undo is now a single direct action that opens a revert PR, so
      // there are no separate undo-vote tallies to surface.)
      //
      // Per-source keyset predicates against the mixed-type cursor:
      // a cursor sitting on a PR row (rank 1) keeps the historical tuple
      // comparison for PRs; when it sits on a close-issue row (rank 0),
      // every PR at that same timestamp already sorted BEFORE it, so PRs
      // page strictly older (<). The close-issue query mirrors this: at a
      // PR cursor, close rows at the same timestamp sort AFTER it, so
      // they page <= ; at a close cursor they use their own tuple.
      const prCursorSql = !hasCursor ? ''
        : beforeType === 'pr'
          ? 'AND (cs.created_at, cs.id) < ($3, $4)'
          : 'AND cs.created_at < $3';
      const prParams = !hasCursor
        ? [appRows[0].id, userId, limit + 1]
        : beforeType === 'pr'
          ? [appRows[0].id, userId, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, userId, before.toISOString(), limit + 1];
      const { rows: prRows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.status = 'merged'
           ${prCursorSql}
         ORDER BY cs.created_at DESC, cs.id DESC
         LIMIT $${prParams.length}`,
        // Fetch limit+1 so an extra row signals there's another page.
        prParams
      );
      const mergedEvidence = config.visualEvidence?.present
        ? await visualEvidenceView.getForSessions(pool, prRows, req.params.slug)
        : new Map();
      for (const row of prRows) {
        row.visualEvidence = mergedEvidence.get(Number(row.id)) || null;
      }

      // Applied close-issue proposals join the Completed stream: a
      // kind='close_issue' governance row whose vote (or an admin
      // force-apply) actually closed the target carries payload.appliedAt
      // (see maybeApplyCloseIssueProposal). Withdrawn (withdrawnAt) and
      // superseded (supersededAt) rows never carry it, so they stay out.
      // chat_count / last_message_at mirror the open-issues endpoint's
      // governance-thread subqueries so the 💬 badge and activity sort
      // behave identically.
      const closeCursorSql = !hasCursor ? ''
        : beforeType === 'close_issue'
          ? 'AND (i.created_at, i.id) < ($2, $3)'
          : 'AND i.created_at <= $2';
      const closeParams = !hasCursor
        ? [appRows[0].id, limit + 1]
        : beforeType === 'close_issue'
          ? [appRows[0].id, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, before.toISOString(), limit + 1];
      const { rows: closeRows } = await pool.query(
        `SELECT i.id, i.kind, i.title, i.description, i.payload, i.status,
                i.github_issue_number, i.created_by, i.created_at,
                u.username AS created_by_username,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up') AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count,
                (SELECT COUNT(*)::int FROM chat_messages cm
                  WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
                    AND cm.msg_type = 'message') AS chat_count,
                (SELECT MAX(cm.created_at) FROM chat_messages cm
                  WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) AS last_message_at
           FROM issues i
           LEFT JOIN users u ON i.created_by = u.id
          WHERE i.app_id = $1 AND i.kind = 'close_issue' AND i.status = 'closed'
            AND i.payload ? 'appliedAt'
            ${closeCursorSql}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT $${closeParams.length}`,
        closeParams
      );

      // Merge-sort the two already-sorted sources into one page. Each
      // source fetched limit+1, so the page can never need a row beyond
      // what was fetched; anything left over means another page exists.
      // With a single populated source, keep the DB's ordering verbatim
      // (byte-identical to the pre-close-issue behaviour for PR-only apps).
      const combined = prRows.map((r) => ({ ...r, row_type: 'pr' }))
        .concat(closeRows.map((r) => ({ ...r, row_type: 'close_issue' })));
      if (prRows.length && closeRows.length) combined.sort(completedRowCompare);
      let hasMore = combined.length > limit;
      const rows = combined.slice(0, limit);

      // #433: the Kanban "Done" column header counts merged tasks, but the
      // board only loads the first page (default 20), so its count was
      // pinned at 20 on any app with ≥20 merges. Return the true column
      // total — a cheap COUNT over the same base set the paged query draws
      // from (status='merged' for this app), with NO cursor predicate (the
      // total is the whole column, not the remaining page) and WITHOUT the
      // revert LEFT JOIN (which can multiply rows). Indexed on (app_id,
      // status), so this is far lighter than the per-row subqueries above.
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM chat_sessions
          WHERE app_id = $1 AND status = 'merged'`,
        [appRows[0].id]
      );
      // Applied close-issue proposals count toward the same Done total —
      // they render in the column. Distinct alias (close_total) so test
      // stubs keyed on the PR count's SQL never double-answer.
      const { rows: closeTotalRows } = await pool.query(
        `SELECT COUNT(*)::int AS close_total
           FROM issues
          WHERE app_id = $1 AND kind = 'close_issue' AND status = 'closed'
            AND payload ? 'appliedAt'`,
        [appRows[0].id]
      );
      let total = (totalRows[0]?.total || 0) + (closeTotalRows[0]?.close_total || 0);

      // #1922: what shipped this week and the week before, counted over the
      // WHOLE history. The Workshop's "shipped this week" used to count the
      // loaded page, so on any week with more merges than a page holds it
      // could only say "20+". Same rows and same timestamp as the client's
      // count (public/js/app-view.js `mergedAtOf`: a PR's merged_at, falling
      // back to created_at; an applied close-issue proposal's created_at), so
      // the two agree wherever both can see everything. First page only — it
      // is a fact about the column, not about the page being fetched. Plain
      // aliases on purpose: test stubs key on `AS total` and `cs.status`.
      //
      // #2176: "this week" is the CALENDAR week, Monday 00:00 UTC to now,
      // and "the week before" the whole seven days ahead of that Monday —
      // not a trailing 7-day window, which read as a rolling total that
      // moved every day. Same Monday the digest weeks and the kudos
      // allowance use (weekStartUtc, which mirrors date_trunc('week')).
      let shipped = null;
      if (isFirstPage) {
        const weekStart = `${weekStartUtc()}T00:00:00Z`;
        const { rows: shippedRows } = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE t >= $2::timestamptz)::int AS shipped_week,
                  COUNT(*) FILTER (WHERE t < $2::timestamptz
                                     AND t >= $2::timestamptz - interval '7 days')::int AS shipped_prev_week
             FROM (
               SELECT COALESCE(merged_at, created_at) AS t
                 FROM chat_sessions
                WHERE app_id = $1 AND status = 'merged'
               UNION ALL
               SELECT created_at AS t
                 FROM issues
                WHERE app_id = $1 AND kind = 'close_issue' AND status = 'closed'
                  AND payload ? 'appliedAt'
             ) shipped_rows`,
          [appRows[0].id, weekStart]
        );
        const week = Number(shippedRows[0]?.shipped_week);
        const prevWeek = Number(shippedRows[0]?.shipped_prev_week);
        if (Number.isFinite(week) && Number.isFinite(prevWeek)) shipped = { week, prevWeek };
      }

      // Same priority + assigned-person summary on completed proposals, so
      // the read-only chips stay visible after a PR merges.
      const prPageRows = rows.filter((r) => r.row_type !== 'close_issue');
      const mergedAttrs = await topicAttrs.summarizeForProposals(
        pool, appRows[0].id,
        prPageRows.map((r) => ({ id: r.id, linked_issues: r.linked_issues })), userId
      );
      for (const row of prPageRows) {
        const s = mergedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
        row.category = s.category;
      }

      // Close-issue rows carry the CLOSED ISSUE's own tally, keyed by the
      // target issue number from the proposal payload. Attribute votes are
      // never deleted when an issue closes, so a task moved to Done keeps
      // the priority / assignee / category it accumulated while open — the
      // chips just have to keep reading them (they used to be dropped here
      // on purpose, which made moving a task to Done look like it wiped
      // those fields).
      const closePageRows = rows.filter((r) => r.row_type === 'close_issue');
      const closeIssueRef = (r) => {
        const n = parseInt(r.payload && r.payload.issueNumber, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
      };
      const closeAttrs = await topicAttrs.summarizeForTargets(
        pool, appRows[0].id, 'issue',
        closePageRows.map(closeIssueRef).filter((n) => n != null), userId
      );
      for (const row of closePageRows) {
        const ref = closeIssueRef(row);
        const s = (ref != null && closeAttrs.get(ref)) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
        row.category = s.category;
      }

      // Staging-only demo mode (?demo=1): prepend mock merged rows so the
      // clickable Completed list + 💬 badge + "Load more" pager are
      // verifiable against a prod-cloned DB. Idempotent by id. The mock
      // rows are gated to the FIRST page only (no cursor) — there are
      // enough of them (#429) to fill a page and force hasMore=true, so a
      // tester can exercise "Load more" without depending on real merged
      // history. See stagingMockMerged above.
      if (IS_STAGING && req.query.demo === '1' && isFirstPage) {
        // De-dup by (type, id) — the two row types draw ids from
        // independent sequences, so a bare id isn't unique in the stream.
        const key = (r) => `${r.row_type || 'pr'}:${r.id}`;
        const have = new Set(rows.map(key));
        const injected = stagingMockMerged().map((m) => ({ ...m, row_type: 'pr' }))
          .concat(stagingMockCompletedCloseIssues())
          .filter((m) => !have.has(key(m)));
        // #1788: make room for the mocks BEFORE merging them in, rather than
        // letting them compete with real history for the page.
        //
        // The old order was unshift, sort newest-first, then truncate to
        // `limit`. That trims the mocks like anything else, and these rows are
        // dated in DAYS — 9100060 is two days old — so they only survived
        // while fewer than `limit` real completed rows were newer than them.
        // On a day with 63 merges they fell off page one entirely, and since
        // the mocks are first-page-only by design they then appeared nowhere.
        //
        // That is what made the "A task moved to Done keeps its chips" check
        // look flaky: it was failing whenever the platform had been busy, so
        // its recorded flake rate rose with our own merge rate and it began
        // blocking unrelated proposals.
        //
        // Reserving the slots is the fix rather than re-dating the mocks to a
        // few hours old: that would work today and rot again at a higher merge
        // rate, and it would fight #1264, which spread these deliberately over
        // ~150 days so the report's monthly strip has something to draw.
        if (rows.length + injected.length > limit) {
          hasMore = true;
          rows.length = Math.max(0, limit - injected.length);
        }
        rows.unshift(...injected);
        // Re-sort so the mock close-issue rows interleave among the mock
        // merged PRs by date instead of clumping at the top.
        rows.sort(completedRowCompare);
        // The COUNT(*) above can't see the mock rows (they aren't in the
        // DB), so bump the total by however many we injected to keep the
        // demo badge self-consistent with the rows the board renders.
        total += injected.length;
        // Same for the week counts (#1922), with the client's timestamp rule
        // and the same calendar-week bounds as the query above (#2176).
        if (shipped) {
          const weekStartMs = Date.parse(`${weekStartUtc()}T00:00:00Z`);
          const WEEK = 7 * 86400000;
          for (const m of injected) {
            const t = new Date(m.merged_at || m.closed_at || m.created_at).getTime();
            if (!Number.isFinite(t)) continue;
            if (t >= weekStartMs) shipped.week += 1;
            else if (t >= weekStartMs - WEEK) shipped.prevWeek += 1;
          }
        }
      }

      res.json({ merged: rows, hasMore, total, ...(shipped ? { shipped } : {}) });
    } catch (err) {
      log.error('votes', 'Failed to list merged', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Single-proposal-by-id fetch — the recovery path for opening a
  // proposal whose row isn't in the client's cached lists. The Completed
  // list is keyset-paginated (only the first page lives in client state),
  // so clicking / deep-linking a merged proposal beyond that page would
  // otherwise resolve to nothing and bounce back to the dev forum. The FE
  // (_fetchProposalById) calls this when _findTopicItem() comes up empty.
  //
  // Collab-gated (same as /merged and /promoted) and returns the SAME
  // merged-shaped row via the shared mergedRowSelect() fragment, so the
  // topic header/card renders identically whether the row came from the
  // list or from here. Accepts promoted / merging / merged so a proposal
  // that transitioned status between list-render and click still resolves
  // (active rows are normally fully cached, but this stays robust).
  router.get('/api/apps/:slug/proposals/:id', async (req, res) => {
    try {
      // View-level (#621): read-only viewers can open a proposal's
      // topic view (my_vote resolves to null for them).
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const userId = req.user?.id || null;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      const { rows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.id = $3
           AND (cs.status IN ('promoted', 'merging', 'merged')
             OR (cs.status IN ('active', 'paused')
               AND (cs.user_id = $2 OR cs.shared_at IS NOT NULL)))
         LIMIT 1`,
        [gatedApp.id, userId, id]
      );

      let proposal = rows[0] || null;
      if (proposal) {
        // Same read-only priority + assigned-person chips the list rows carry.
        const attrs = await topicAttrs.summarizeForProposals(
          pool, gatedApp.id,
          [{ id: proposal.id, linked_issues: proposal.linked_issues }], userId
        );
        const s = attrs.get(proposal.id) || topicAttrs.emptySummary();
        proposal.priority = s.priority;
        proposal.assignee = s.assignee;
        proposal.category = s.category;
        proposal.visualEvidence = config.visualEvidence?.present
          ? await visualEvidenceView.getForSession(pool, proposal, req.params.slug)
          : null;
      }

      // Staging demo mode (?demo=1): the mock merged/promoted rows aren't in
      // the DB, so resolve a mock id straight from the generators. This lets
      // a staging tester deep-link a mock Completed proposal that never
      // reached the first page (ids ~9100021+) and confirm it opens on
      // demand. Strictly a no-op in production (gated on IS_STAGING).
      if (!proposal && IS_STAGING && req.query.demo === '1') {
        proposal = stagingMockMerged().find((m) => m.id === id)
          || stagingMockProposals().find((m) => m.id === id)
          || null;
      }

      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      res.json({ proposal });
    } catch (err) {
      log.error('votes', 'Failed to get proposal by id', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #11/#16: undo a merged PR by opening a revert PR ───────────────
  //
  // Undo is symmetric with proposing a forward change: a single click
  // opens a revert PR (clone repo, `git revert <merge_sha>`, push, open
  // PR), inserted as a `promoted` session, which then goes through the
  // SAME merge vote as any other PR. There is no separate "undo vote"
  // gate anymore (#16) — previously undo was double-gated (a majority to
  // open the revert, then a second majority to merge it), which was
  // confusing and redundant. The merge vote on the revert PR is now the
  // single checkpoint, mirroring the forward propose→vote flow.
  //
  // The caller becomes the revert session's owner (user_id) so they
  // "own" the resulting PR for chat / status purposes.
  router.post('/api/sessions/:id/undo', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'merged'`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Merged session not found' });
      const session = sessionRows[0];

      // Reverting a secret-declaration PR changes credential configuration
      // through an otherwise-generic session endpoint.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // Revert PRs are not themselves undoable — would create an endless
      // undo-undo-undo loop. The button is hidden on the client already;
      // this is the server-side enforcement.
      if (session.revert_of_session_id) {
        return res.status(409).json({ error: 'Cannot undo a revert PR' });
      }

      // Block if a revert is already in flight or landed for this merge.
      const { rows: existingRevert } = await pool.query(
        `SELECT id, status, pr_number, pr_url FROM chat_sessions
         WHERE revert_of_session_id = $1 AND status IN ('promoted', 'merging', 'merged')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      if (existingRevert.length) {
        const rv = existingRevert[0];
        return res.status(409).json({
          error: `A revert PR for this merge already exists (status: ${rv.status})`,
          revertSessionId: rv.id,
          revertPrNumber: rv.pr_number,
          revertPrUrl: rv.pr_url,
        });
      }

      log.info('votes', 'Undo requested — opening revert PR', {
        sessionId: session.id, by: req.user.username,
      });
      // Respond immediately; the revert (clone + git revert + push + PR)
      // runs in the background and announces itself in group chat. The
      // vote panel refreshes via the pushVoteUpdate broadcast below.
      res.json({ ok: true, opening: true });

      const { pushVoteUpdate } = require('../services/ws');
      checkAndOpenRevert(config, pool, session, req.user)
        .then((result) => {
          if (result?.reverted) {
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              kind: 'undo',
              revertSessionId: result.revertSessionId,
              revertPrNumber: result.revertPrNumber,
            });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background revert failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Undo failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin force-merge ─────────────────────────────────────────────
  //
  // Admin-only escape hatch: merge a promoted PR right now, regardless
  // of vote tally or the locked-app admin-yes gate. Used when an admin
  // is confident the change should ship and doesn't want to wait for
  // the active-user majority. The frontend gates this behind a
  // ConfirmModal so a misclick can't accidentally bypass voting.
  //
  // The actual merge pipeline (atomic 'promoted → merging' claim,
  // GitHub merge, prod rebuild, staging teardown, broadcasts) is the
  // same `checkAndMerge` path the regular vote route uses — we just
  // pass `force: true` to skip the early gates. The chat message
  // distinguishes the override so users see who did it and why a PR
  // landed without the usual tally.
  router.post('/api/sessions/:id/admin-merge', drainGuard, async (req, res) => {
    try {
      // Cheap pre-gate, preserving the old 403-before-404 stance: a
      // caller who can't force-merge ANYWHERE never gets to probe
      // whether a session id exists. #788 widens this from
      // "platform admin" to "platform admin, or an app admin of at
      // least one app" — the per-app check follows once we know which
      // app the session belongs to.
      const adminAppIds = req.user?.canAdminWrite
        ? null
        : await appAdmins.getAdminAppIdsForUser(pool, req.user?.id);
      if (adminAppIds && adminAppIds.size === 0) {
        return res.status(403).json({ error: 'Full admin access required' });
      }

      const { rows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.repo_url,
                a.self_hosted as app_self_hosted, a.created_by as app_created_by
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'promoted'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Promoted session not found' });
      }
      const session = rows[0];

      // #788: force-merge is no longer platform-admin-only — an app's
      // own declared admins may force-merge that app's proposals. The
      // one exception is a proposal that changes the admins block
      // itself: letting an app admin force-merge that would be
      // unilateral self-escalation, so it stays platform-admin-only.
      const explicitApproval = !!session.requires_explicit_approval;
      const appForGate = { id: session.app_id, created_by: session.app_created_by };
      if (!(await appAdmins.canForceMerge(pool, appForGate, req.user, { explicitApproval }))) {
        if (explicitApproval && await appAdmins.isAppAdmin(pool, session.app_id, req.user?.id)) {
          return res.status(403).json({
            error: "This proposal changes the app's admins, so it needs explicit approval: only a platform admin can force-merge it",
          });
        }
        return res.status(403).json({ error: 'Full admin access required' });
      }

      // Force-merging this platform-created proposal would apply its held
      // credential value. Keep ordinary admin merges available to the CLI.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // Force bypasses the vote/check gates, not the evidence audit. Refuse
      // before returning `queued:true`; otherwise the UI would report a merge
      // that the background task is guaranteed not to perform. An app admin
      // can use the dedicated reasoned override endpoint, then retry.
      const evidenceGate = await readVisualEvidenceGate(config, pool, session);
      if (evidenceGate.applies && !evidenceGate.allowed) {
        return res.status(409).json({
          error: 'visual_evidence_required',
          message: evidenceGate.reason,
          visualEvidenceState: evidenceGate.state,
        });
      }

      // Respond immediately; the merge itself runs in the background
      // exactly like the regular vote-driven path. Clients refresh via
      // the `pushVoteUpdate` broadcasts emitted by checkAndMerge.
      log.info('votes', 'Admin force-merge requested', {
        sessionId: session.id, by: req.user.username,
      });
      res.json({ ok: true, queued: true });

      checkAndMerge(config, pool, session, { force: true, forceBy: req.user })
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Admin force-merge failed', {
            sessionId: session.id, err: err.message,
          });
        });
    } catch (err) {
      log.error('votes', 'Admin force-merge route failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// `options.force` (admin force-merge): skip the vote-count, locked-app
// admin-yes, and behind_main gates entirely and proceed straight to the
// claim+merge pipeline. The atomic `promoted → merging` claim still
// races against any concurrent vote-driven merge, so we won't double-
// merge. `options.forceBy` is the admin user object (id, username) used
// for the "merged by <admin> overriding vote" chat message.
// Resolve open issue bounties for a single closed issue when a PR merges.
//
// A bounty pledged via the Open Issues panel ("Give kudos") flips 'open' →
// 'awarded' and credits the merged PR's author — EXCEPT a bounty whose
// pledger IS that author, which would be self-kudos (the same thing the
// direct PR-kudos give path refuses with a 403; see routes/kudos.js). The
// awardee isn't known until merge, so the self-check lives here: self-pledged
// rows are 'voided' instead — not left 'open', because the issue is now
// closed on GitHub and no later PR will close it again, so an open row would
// linger forever and keep inflating the issue's open-bounty count. Voided
// rows keep awarded_session_id/awarded_at for audit but no awarded_user_id,
// so they earn no leaderboard credit. The pledger's weekly allowance slot is
// still forfeited (no refund) — every pledged bounty consumes a slot.
//
// `IS DISTINCT FROM` keeps a NULL giver (deleted pledger) and a NULL awardee
// (deleted PR author) on the award path. Self-voiding only runs when the PR
// has an author. Returns { awarded, voided } id arrays. Extracted from
// checkAndMerge so the self-bounty guard is unit-testable without driving the
// whole merge pipeline.
async function resolveIssueBounty(pool, { appId, sessionId, awardeeUserId, issueNumber }) {
  const { rows: awarded } = await pool.query(
    `UPDATE issue_bounties
        SET status = 'awarded',
            awarded_session_id = $1,
            awarded_user_id = $2,
            awarded_at = NOW()
      WHERE app_id = $3 AND github_issue_number = $4 AND status = 'open'
        AND giver_user_id IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, awardeeUserId || null, appId, issueNumber]
  );

  let voided = [];
  if (awardeeUserId) {
    const { rows } = await pool.query(
      `UPDATE issue_bounties
          SET status = 'voided',
              awarded_session_id = $1,
              awarded_at = NOW()
        WHERE app_id = $2 AND github_issue_number = $3 AND status = 'open'
          AND giver_user_id = $4
        RETURNING id`,
      [sessionId, appId, issueNumber, awardeeUserId]
    );
    voided = rows;
  }

  return { awarded, voided };
}

// #687 Slice 4: shared post-merge finalizer. Everything AFTER the
// irreversible github.mergePR call — rebuild production (unless self-hosted),
// stamp apps.main_sha/main_pr_number/last_deploy_at, broadcast
// app_version_changed, teardown staging, pay out bounties, refresh issues,
// transition the session to 'merged', and announce it — factored out so that
// NATIVE and IMPORTED merges run byte-for-byte the same tail. Called from
// inside checkAndMerge's try, so a throw here still lands in that catch, which
// honours the `githubMerged` guard (never roll a GitHub-merged PR back to
// 'promoted') and the merge-debug tracing. Only ever leaves the row in
// 'merged' — a state recoverStuckMerges already understands.
// #1688: who to name when a proposal lands.
//   author  — the proposer.
//   backers — everyone whose Yes counted at merge, in vote order, the author
//             excluded (voting for your own is allowed; being thanked for it
//             reads oddly).
//   shapers — everyone else who took part: a No with a line on the version
//             that merged (an objection that did not stop it), or a word in
//             the proposal's thread before it landed. Nobody is named twice.
async function mergeCredits(pool, session) {
  const { rows: authorRows } = session.user_id
    ? await pool.query('SELECT username FROM users WHERE id = $1', [session.user_id])
    : { rows: [] };
  const author = authorRows[0]?.username || null;
  const { rows: votes } = await pool.query(
    `SELECT u.username, pv.vote, pv.reason
       FROM pr_votes pv
       JOIN users u ON u.id = pv.user_id
       JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND ${currentVotePredicateSql('pv', 'cs')}
      ORDER BY pv.created_at ASC, pv.id ASC`,
    [session.id]
  );
  const { rows: talkers } = await pool.query(
    `SELECT u.username, MIN(cm.created_at) AS first_at
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.app_id = $1 AND cm.thread_type = 'session' AND cm.thread_ref = $2
        AND cm.msg_type = 'message'
      GROUP BY u.username
      ORDER BY first_at ASC`,
    [session.app_id, session.id]
  );
  const seen = new Set(author ? [author] : []);
  const backers = [];
  for (const v of votes || []) {
    if (v.vote === 'yes' && v.username && !seen.has(v.username)) {
      seen.add(v.username);
      backers.push(v.username);
    }
  }
  const shapers = [];
  for (const v of votes || []) {
    if (v.vote === 'no' && v.reason && v.username && !seen.has(v.username)) {
      seen.add(v.username);
      shapers.push(v.username);
    }
  }
  for (const t of talkers || []) {
    if (t.username && !seen.has(t.username)) {
      seen.add(t.username);
      shapers.push(t.username);
    }
  }
  return { author, backers, shapers };
}

// "alice", "alice and bob", "alice, bob and carol", "… and 2 more" past
// eight — the announcement is a sentence, not a roll call.
function nameList(names) {
  const list = names.slice(0, 8);
  const rest = names.length - list.length;
  if (rest > 0) return `${list.join(', ')} and ${rest} more`;
  return list.length <= 1
    ? list.join('')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// "Built by evan, backed by alice and bob, shaped by carol." The author is
// left out for the push that goes to the author. With nobody to name, the
// wording the announcement carried before #1688.
function creditsSentence(credits, { withAuthor = true } = {}) {
  const parts = [];
  if (withAuthor && credits.author) parts.push(`Built by ${credits.author}`);
  if (credits.backers?.length) parts.push(`${parts.length ? 'backed' : 'Backed'} by ${nameList(credits.backers)}`);
  if (credits.shapers?.length) parts.push(`${parts.length ? 'shaped' : 'Shaped'} by ${nameList(credits.shapers)}`);
  if (!parts.length) return withAuthor ? 'Thanks to everyone who voted' : '';
  return `${parts.join(', ')}.`;
}

// On an app in DEMO MODE, the preview the checks ran against is an image of
// the very tree the merge just squashed onto main, so production can deploy
// it instead of building the same source again — which is the ~9s of an ~18s
// merge-to-live that a recording sits through with nothing on screen.
//
// Demo mode only, on purpose. The image's baked GIT_SHA names the commit it
// was built from, so a reused image reports the proposal's head where
// apps.main_sha reports the merge commit. On a demo app nothing reads it and
// the whole app is rewound between takes; making this the fleet's merge path
// means resolving that difference rather than tolerating it.
//
// Fails open at every step: no preview image, no tree to compare, a GitHub
// that will not answer — all of them mean "build it", which is what the
// platform did before. staging.rebuildProduction re-verifies the tree itself
// against the clone; this only offers.
async function demoPreviewImage(pool, app, session) {
  if (!app?.demo_mode) return null;
  try {
    const { rows } = await pool.query(
      `SELECT staging_image_ref, staging_build_ref, staging_commit_sha
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const row = rows[0];
    if (!row?.staging_image_ref || !row.staging_commit_sha) return null;
    const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo || !github.isEnabled()) return null;
    const treeSha = await github.getCommitTree(owner, repo, row.staging_commit_sha);
    if (!treeSha) return null;
    return {
      imageRef: row.staging_image_ref,
      buildRef: row.staging_build_ref || null,
      treeSha,
      fromSha: row.staging_commit_sha,
    };
  } catch (err) {
    log.warn('votes', 'Could not offer the preview image to the rebuild; it will build', {
      sessionId: session.id, err: err.message,
    });
    return null;
  }
}

async function finalizeMerge({ config, pool, session, mergeCommitSha, required, activeCount, yesCount, majority, force, forceBy, dstep, dend, gateTrace, gateSave }) {
    // Rebuild production
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    const app = appRows[0];

    // Apply any values this proposal carried for the variables it
    // DECLARES (services/pending-secrets.js — the "+ New variable" panel
    // flow). BEFORE the rebuild, deliberately: a newly `required` child-app
    // secret whose value arrived with the proposal has to be in
    // `app_secrets` before mergeForDeploy() looks for it, or the merge
    // would park the app in `awaiting_secrets` over its own change.
    //
    // Best-effort: the GitHub merge has already happened and can't be
    // rolled back, so a failure here logs and lets the rest of the tail
    // run. The pending row stays claimed either way, and the panel shows
    // the key as unset — recoverable by setting it directly.
    if (app) {
      try {
        const pendingSecrets = require('../services/pending-secrets');
        const { applied } = await pendingSecrets.applyForSession(config, pool, session.id);
        for (const a of applied) {
          if (!a.hadValue) continue;
          dstep({
            phase: 'pending_secrets',
            message: `Applied the value declared with this proposal for ${a.key}.`,
            detail: { key: a.key, scope: a.scope, private: a.private },
          });
          // Say what actually happens next — the platform's env is
          // materialized by its own deploy, a child app's by the rebuild
          // that follows a few lines below.
          const msg = a.scope === 'platform'
            ? `Platform variable "${a.key}" was declared and set by this proposal; takes effect on the platform's next deploy.`
            : `Secret "${a.key}" was declared and set by this proposal; redeploying…`;
          await sendSystemMessage(pool, session.app_id, msg, 'system').catch(() => {});
          await sendSystemMessage(pool, session.app_id, msg, 'system',
            null, { type: 'session', ref: session.id }).catch(() => {});
          if (a.scope === 'platform') {
            events.record(pool, {
              type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
              userId: a.userId,
              appId: session.app_id,
              metadata: {
                key: a.key, action: 'set', private: a.private,
                appliedBy: 'declaration-proposal',
              },
            });
          }
        }
      } catch (err) {
        log.error('votes', 'Pending secret-declaration apply failed', {
          sessionId: session.id, err: err.message,
        });
        dstep({
          phase: 'pending_secrets', level: 'warn',
          message: `Couldn't apply the value declared with this proposal: ${err.message}`,
        });
      }
    }

    if (app) {
      let sha = null;
      // SELF-HOSTING.md sub-step 2g (Guard B): for the self-app,
      // there's no platform-managed prod container to rebuild — the
      // host-side deployer (nudged below) rolls the harness through a
      // blue-green rollout when the merge lands on main. Skip
      // rebuildProduction entirely, but keep the app_version_changed
      // broadcast firing so the app's own commit pills refresh.
      // main_sha is refreshed by seedSelfApp() on the next boot, which
      // clients pick up via /api/version.
      if (!app.self_hosted) {
        dstep({ phase: 'prod_rebuild', message: 'Production rebuild started.' });
        const reuseImage = await demoPreviewImage(pool, app, session);
        const result = await staging.rebuildProduction(config, app, reuseImage ? { reuseImage } : {});
        sha = result.sha;
        dstep({
          phase: 'prod_rebuild',
          message: `Production rebuild finished${sha ? ` (deployed ${String(sha).slice(0, 9)})` : ''}${result.imageReused ? ', on the image the checks ran against' : ''}.`,
          detail: { sha: sha || null, imageReused: !!result.imageReused },
        });
        // Also record the SHA + originating PR so the main app view can
        // show "live on <sha> · PR #<n>" (#21). pr_number comes from the
        // session we just merged; sha is what `rebuildProduction` cloned.
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3,
                           last_deploy_at = NOW()
           WHERE id = $4`,
          [result.containerId, sha || null, session.pr_number || null, app.id]
        );
      } else {
        const clusterRuntime = applicationRuntime.mode(config) === 'kubernetes';
        log.info('votes', clusterRuntime
          ? 'Self-app PR merged; GitHub Actions publishes the release for Argo CD'
          : 'Self-app PR merged; host deployer will roll the harness', {
          appId: app.id, prNumber: session.pr_number,
        });
        // Skip the deployer's ~2-min baseline poll: tell it main just
        // moved so it fetches within seconds. Best-effort by design —
        // if the nudge mount is missing (local dev, pre-deployer host)
        // the baseline poll still delivers the deploy.
        try {
          const { nudgeHostDeployer } = require('../services/deploy-nudge');
          if (!clusterRuntime) nudgeHostDeployer({ sha: mergeCommitSha, prNumber: session.pr_number });
        } catch (_) { /* never fail a merge over a hint */ }
      }
      // Let every tab watching this app refresh its commit pill without
      // polling. The existing vote_update event already fires on merge
      // but is scoped to vote panel refreshes; a dedicated event keeps
      // the concerns separated and avoids over-broadcasting. Fires for
      // self-hosted too (sha=null): the platform's own row refreshes
      // from /api/version, which has no new SHA to report until the
      // blue-green rollout cuts over.
      try {
        const { broadcastGlobalScoped } = require('../services/ws');
        broadcastGlobalScoped({
          type: 'app_version_changed',
          appSlug: session.app_slug,
          sha: sha || null,
          prNumber: session.pr_number || null,
        }, { appId: session.app_id, appSlug: session.app_slug });
      } catch {}
    }

    // Teardown staging. #851: this is the path that produced the ten known
    // orphans — a swallowed removal failure while the session row was nulled
    // anyway. teardownStaging now reports a leak instead of hiding it, and the
    // trace says so rather than claiming a teardown that didn't happen. The
    // merge itself must not fail over a container that won't die: the row keeps
    // pointing at it and the stale-preview sweeper retries.
    const stagingTeardown = await staging.teardownStaging(session, app)
      .catch((err) => ({ removed: false, leaked: true, error: err.message }));
    if (stagingTeardown && stagingTeardown.leaked) {
      dstep({
        phase: 'staging_teardown',
        message: 'Staging container could not be removed. It is left for the stale-preview sweeper.',
      });
    } else {
      dstep({ phase: 'staging_teardown', message: 'Staging container torn down.' });
    }

    // #58: snapshot the vote threshold + active-user count in effect at
    // this merge, so the merged-PR pill shows the historical "yes / N"
    // instead of drifting with the live threshold. `required` is the eased
    // dynamic threshold (services/active-users.js → requiredVotes) actually
    // applied to this merge; activeCount comes from getActiveUserStats() at
    // the top of this function. The visibility window is intentionally NOT
    // snapshotted (a merged row just shows its historical count). COALESCE
    // keeps any earlier snapshot (defensive; the promoted→merging claim
    // already guarantees a single merge transition).
    await pool.query(
      `UPDATE chat_sessions SET status = 'merged', merged_at = NOW(),
                                merge_commit_sha = COALESCE($2, merge_commit_sha),
                                votes_required = COALESCE(votes_required, $3),
                                active_users_at_merge = COALESCE(active_users_at_merge, $4)
       WHERE id = $1`,
      [session.id, mergeCommitSha, required, activeCount]
    );

    // pr_merged is the terminal stage of the PR-promotion funnel and the
    // signal behind the "merges over time" growth chart (now exact thanks
    // to merged_at above). Attributed to the PR author (session.user_id),
    // which may be NULL if the author was deleted.
    events.record(pool, {
      type: events.EVENT_TYPES.PR_MERGED,
      userId: session.user_id || null,
      appId: session.app_id,
      sessionId: session.id,
      metadata: {
        prNumber: session.pr_number || null,
        forced: !!force,
        ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
      },
    });

    // #1374: the author's change landed, and before this nothing told them.
    // Beside the funnel event on purpose — the two mark the same moment, so
    // a future edit that moves one should have to look at the other.
    // Wrapped, and optional-called, because a notification must never be
    // able to fail a MERGE. A `.catch()` alone would not do it: a
    // synchronous throw (the module stubbed, the export renamed) escapes a
    // promise chain entirely, and the first thing that noticed was a merge
    // test going red.
    // #1688: read once, used twice — the author's notification here and the
    // announcement further down. Never for a force merge, and never a
    // reason the merge fails: no names is the old wording, not an error.
    const mergedCredits = force ? null : await mergeCredits(pool, session).catch((err) => {
      log.warn('votes', 'Merge credits unavailable; announcing without names', {
        sessionId: session.id, err: err.message,
      });
      return null;
    });
    try {
      notifications.createPrMergedNotification?.(pool, {
        userId: session.user_id,
        appId: session.app_id,
        sessionId: session.id,
        forced: !!force,
        // #1688: the names, for the author's own notification and push —
        // without "Built by", since it goes to the builder.
        credits: mergedCredits ? creditsSentence(mergedCredits, { withAuthor: false }) : null,
      })?.then((created) => Promise.all(
        created.map((row) => notifications.hydrateAndPush(pool, row))
      ))?.catch((err) => log.error('votes',
        'Merged notification failed', { sessionId: session.id, err: err.message }));
    } catch (err) {
      log.error('votes', 'Merged notification threw', { sessionId: session.id, err: err.message });
    }

    // Resolve any open issue bounties for the issues this PR closes (declared
    // through the session's linked_issues → `Closes #N` in the PR body).
    // Bounties pledged by OTHER users flip 'open' → 'awarded' and credit this
    // PR's author; a bounty the author pledged on their own resolved issue is
    // 'voided' instead (self-kudos guard — see resolveIssueBounty). Idempotent
    // (only status='open' rows transition, so a later PR closing the same
    // issue finds none) and best-effort — a failure here must never roll back
    // or fail the merge, same as the CC volume teardown below.
    try {
      const linked = Array.isArray(session.linked_issues) ? session.linked_issues : [];
      const seen = new Set();
      for (const raw of linked) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        const { awarded, voided } = await resolveIssueBounty(pool, {
          appId: session.app_id,
          sessionId: session.id,
          awardeeUserId: session.user_id || null,
          issueNumber: n,
        });
        if (voided.length) {
          log.info('votes', 'Self-bounty voided on merge', {
            sessionId: session.id, issueNumber: n, count: voided.length,
          });
        }
        // Only announce / record genuine awards; a purely self-voided issue
        // produces no "awarded" chat noise or event.
        if (!awarded.length) continue;
        events.record(pool, {
          type: events.EVENT_TYPES.BOUNTY_AWARDED,
          userId: session.user_id || null,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { issueNumber: n, prNumber: session.pr_number || null, count: awarded.length },
        });
        const recipient = session.user_id ? `<@${session.user_id}>` : 'the author';
        const bountyMsg = `Bounty on issue #${n} (${awarded.length} kudos) awarded to ${recipient} for PR #${session.pr_number || session.id}`;
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system').catch(() => {});
        // Dual-post into the proposal's thread (lifecycle in context).
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
      }
    } catch (err) {
      log.warn('votes', 'Bounty payout failed', { sessionId: session.id, err: err.message });
    }

    // Keep the "Open Issues" panel honest. A merged PR carrying `Closes #N`
    // has just closed those issues on GitHub, but the panel reads
    // github.fetchPublicIssues (cached, state=open) and nothing else learns
    // the issue closed — so without this the closed issue lingers until the
    // cache TTL expires AND something separately triggers a panel reload.
    // Bust this repo's open-issues cache and broadcast a refresh so every
    // client viewing the app's group chat refetches (App.handleIssueUpdate →
    // AppView.loadVotePanel). Use the same repo_url regex as parseOwnerRepo
    // (routes/issues.js) so the invalidated key matches the cached one.
    // Best-effort and post-merge — a failure here must never fail the merge.
    try {
      const [, ghOwner, ghRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (ghOwner && ghRepo) {
        // #144: record the linked issues as closed BEFORE busting the
        // cache + broadcasting. GitHub's auto-close is async and its
        // anonymous list endpoint lags even further, so the refetch this
        // broadcast triggers can read the issues as still open and
        // re-cache them — the suppression list makes fetchPublicIssues
        // drop them no matter what the list says. Optimistic on purpose:
        // GitHub closes `Closes #N` reliably (just late), and the
        // suppression TTL self-heals the rare case where it doesn't.
        const { sanitizeIssueNumbers } = require('../services/pr-metadata');
        const closedNumbers = sanitizeIssueNumbers(session.linked_issues);
        if (closedNumbers.length) github.noteIssuesClosed(ghOwner, ghRepo, closedNumbers);
        // Auto-resolve any open close-issue proposals targeting the issues
        // this merge closes — their vote is moot now. Same optimism as the
        // suppression above (GitHub closes `Closes #N` reliably, just
        // late); the watcher hook below catches hand-edited `Closes #N`
        // beyond linked_issues. Lazy require to avoid an import cycle;
        // fired-and-forgotten so a failure never fails the merge.
        if (closedNumbers.length) {
          try {
            const { resolveSupersededCloseProposals } = require('./issues');
            resolveSupersededCloseProposals(pool, {
              appId: session.app_id,
              appSlug: session.app_slug,
              numbers: closedNumbers,
              cause: { kind: 'pr-merge', prNumber: session.pr_number || session.id },
            }).catch((err) => log.warn('votes', 'Superseded close-proposal resolve failed', {
              sessionId: session.id, err: err.message,
            }));
          } catch (err) {
            log.warn('votes', 'Superseded close-proposal resolve setup failed', {
              sessionId: session.id, err: err.message,
            });
          }
        }
        github.invalidateIssuesCache(ghOwner, ghRepo);
        const { pushIssueUpdate } = require('../services/ws');
        pushIssueUpdate({
          action: 'github_synced',
          appSlug: session.app_slug,
          appId: session.app_id,
          source: 'pr_merged',
        });
      }
    } catch (err) {
      log.warn('votes', 'Open-issues refresh after merge failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // #135: GitHub closes `Closes #N`-referenced issues itself, but a few
    // seconds AFTER the merge — so the cache bust + refetch above can race
    // it, re-caching the issue as open and leaving the group-chat panel
    // stale for the cache TTL. Watch the referenced issues (PR-body closing
    // keywords ∪ linked_issues) with retry/backoff until GitHub reports
    // them closed, then bust the cache and broadcast the refresh again.
    // Fired-and-forgotten — the polling must never slow down or fail the
    // merge flow, and nothing is ever written to GitHub.
    try {
      if (github.isEnabled() && session.pr_number) {
        const [, wOwner, wRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (wOwner && wRepo) {
          const { watchIssuesClosedAfterMerge } = require('../services/issue-close-watcher');
          watchIssuesClosedAfterMerge({
            owner: wOwner,
            repo: wRepo,
            prNumber: session.pr_number,
            linkedIssues: session.linked_issues,
            appSlug: session.app_slug,
            appId: session.app_id,
            // Lets the watcher auto-resolve close-issue proposals for the
            // numbers it observes closed (incl. hand-edited `Closes #N`).
            pool,
          }).catch((err) => {
            log.warn('votes', 'Post-merge issue-close watch failed', {
              sessionId: session.id, err: err.message,
            });
          });
        }
      }
    } catch (err) {
      log.warn('votes', 'Post-merge issue-close watch setup failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // Chat session is done — no further turns will reference CC memory,
    // so drop the persistent `.claude` volume.
    try {
      const worker = require('../services/worker');
      await worker.destroyCcVolume(session.id);
    } catch (err) {
      log.warn('votes', 'Failed to destroy CC volume', { sessionId: session.id, err: err.message });
    }

    // Announce in group chat, and dual-post into the proposal's own
    // thread so its discussion carries the outcome in context.
    // The ordinary line leads with the change and thanks the voters; the
    // "(yes/active votes)" figure stays at the end in the same shape, since
    // migrate.js's votes_required backfill parses it out of historical
    // announcements (rows merged since the snapshot columns exist never need
    // that backfill, so the changed lead-in costs nothing there).
    const prRef = `PR #${session.pr_number || session.id}`;
    const mergedLabel = session.pr_title ? `${prRef}: ${session.pr_title}` : prRef;
    // #1688: the announcement names the people. mergeCredits reads the
    // author, the Yes voters whose votes counted and whoever shaped it (a No
    // with a line, or a word in the thread before it landed); the sentence
    // sits between the lead-in and the tally, whose "(yes/active votes)"
    // shape migrate.js's backfill still parses. Without credits — a force
    // merge, or a read that failed — the line reads as it did.
    const credits = mergedCredits;
    const creditLine = credits ? creditsSentence(credits) : 'Thanks to everyone who voted';
    const mergedLine = force && forceBy
      ? `${mergedLabel} force-merged by admin ${forceBy.username} (${yesCount}/${activeCount} vote${yesCount === 1 ? '' : 's'} at the time)`
      : session.pr_title
        ? `${session.pr_title} is live (${prRef}). ${creditLine} (${yesCount}/${activeCount} votes)`
        : `${prRef} is live. ${creditLine} (${yesCount}/${activeCount} votes)`;
    // The names ride as metadata too, so the general chat's event row draws
    // from data rather than from the wording.
    const mergedMeta = credits ? {
      merged: {
        sessionId: session.id,
        prNumber: session.pr_number || null,
        title: session.pr_title || '',
        author: credits.author || '',
        backers: credits.backers,
        shapers: credits.shapers,
        votes: `${yesCount}/${activeCount}`,
      },
    } : null;
    await sendSystemMessage(pool, session.app_id, mergedLine, 'system', mergedMeta);
    await sendSystemMessage(pool, session.app_id, mergedLine,
      'system', mergedMeta, { type: 'session', ref: session.id }
    ).catch(() => {});

    // Cascade: drain the next eligible promoted PR for this app. The
    // app-level drain serializes this with any vote-triggered resolves so
    // only one PR per app resolves+merges at a time. Exclude the session we
    // just merged so it's never re-picked.
    checkAndResolveConflicts(config, { app_id: session.app_id, excludeSessionId: session.id }).catch((err) => {
      log.error('votes', 'Conflict resolution check failed', { err: err.message });
    });

    // The whole-tree check under direct merges (services/main-watch.js): the
    // repo's unit suite on the merge commit, red pausing the app's merges.
    // Fire-and-forget; a merge never waits on it and never fails because of it.
    if (app && mergeCommitSha) {
      require('../services/main-watch').afterMerge(config, pool, {
        app, session, mergeSha: mergeCommitSha,
      }).catch((err) => {
        log.warn('votes', 'Main watch failed to run (non-fatal)', {
          appId: session.app_id, sha: mergeCommitSha, err: err.message,
        });
      });
    }

    dstep({ phase: 'merged', message: `Marked session merged${mergeCommitSha ? ` (commit ${String(mergeCommitSha).slice(0, 9)})` : ''}.`, detail: { sha: mergeCommitSha, yesCount, majority } });
    // Optional: finalizeMerge is exported and called directly (the imported-PR
    // suite drives it on its own), and the recording is a description. A merge
    // must never fail because nobody passed it something to narrate into.
    gateTrace?.revise('github', 'done', { note: 'merged' });
    gateSave?.();
    dend('merged', `Merged${force ? ` (force by ${forceBy?.username || 'admin'})` : ''}.`);
    return { merged: true };
}

async function checkAndMerge(config, pool, session, options = {}) {
  // `options.autoResolve` (default true): when a merge is blocked by a
  // conflict / behind-main, kick off the worker-based auto-resolver
  // (sync with main + retry). The resolver re-invokes checkAndMerge with
  // autoResolve:false so its own conflict paths don't re-trigger the
  // resolver — this bounds the resolve+retry to a single cycle.
  const { force = false, forceBy = null, autoResolve = true } = options;

  // Legacy native rows may predate reviewed_head_sha. Establish their live
  // GitHub revision before looking at votes (and clear any unbound legacy
  // approvals); all newly promoted rows already carry the value. We do not
  // refetch an existing stamp here because the exact-SHA merge below is the
  // final race guard, while every interactive vote performs a fresh read.
  const revision = await reconcileNativeReviewedHead({
    config, pool, session, fresh: false,
  });
  if (revision.blocked) {
    log.warn('votes', 'Merge blocked: native proposal revision unavailable', {
      sessionId: session.id, reason: revision.reason,
    });
    return {
      merged: false,
      revisionBlocked: true,
      transient: !!revision.transient,
      error: revision.reason,
    };
  }
  // #955: a revision the PLATFORM advanced (its own sync/conflict-resolution
  // commit, sitting on the reviewed head) kept its approvals, so there is no
  // review to return to — carry on and let the real gates decide. The pin now
  // matches the live head, which is exactly what the merge needs.
  if (revision.updated && !revision.votesKept) {
    // No approval predating the first immutable stamp may merge. A force
    // request also returns to review here; a second explicit request can merge
    // the now-pinned revision if that is still intended.
    return {
      merged: false,
      headMoved: !!revision.changed,
      reviewReset: true,
      reviewedHeadSha: revision.headSha,
    };
  }

  // The imported twin of the step above. An imported proposal's pin used to
  // advance only when the sync poller's next getPR noticed the head had
  // moved — so when the merge queue had just pushed a sync commit onto the
  // branch, the merge below was offered the PRE-sync commit, GitHub refused
  // it (409), the group was told "the PR was updated on GitHub", and when
  // the poller did catch up it read the platform's own commit as an author
  // push and cleared the votes (#2100, #2095). Re-pinning from the mirror
  // here, with the same classifier the native path uses, is what makes that
  // loop unreachable. Checks are deferred to the checks gate below, which
  // rebuilds exactly the pinned head when the verdict's commit does not
  // match. A head on the author's fork is left to the poller, as before;
  // the exact-sha merge remains the guard for it.
  if (session.source === 'imported') {
    const importedRevision = await require('../services/pr-import-sync').reconcileImportedHead({
      config, pool, session, checks: 'defer',
    });
    if (importedRevision.reconciled && importedRevision.changed && !importedRevision.votesKept) {
      return {
        merged: false,
        headMoved: true,
        reviewReset: true,
        reviewedHeadSha: importedRevision.headSha,
      };
    }
  }

  // Force merge bypasses voting/checks by design, but it does not manufacture
  // visual evidence. An administrator who intentionally accepts missing
  // evidence must use the audited override endpoint first.
  if (force && config?.visualEvidence?.enforce) {
    const evidenceGate = await readVisualEvidenceGate(config, pool, session);
    if (evidenceGate.applies && !evidenceGate.allowed) {
      return {
        merged: false,
        blockReason: 'visual_evidence',
        visualEvidenceBlocked: true,
        visualEvidenceState: evidenceGate.state,
        error: evidenceGate.reason,
      };
    }
  }

  // The proposal's "opened for voting" anchor is promoted_at (falls back to
  // created_at defensively). All gates derive from one snapshot.
  //
  // #646: the gate is now governance-aware (services/governance.js).
  // Under the default settings this is bit-for-bit the old
  // getActiveUserStats + pr_votes counts + mergeGate; under
  // approver_policy='invited' only approver votes count (and the
  // electorate is the approver roster); under approvals_required=N the
  // proposal is mergeable as soon as it has N qualifying yes votes,
  // with every clock (window / lazy / rejection) off.
  const openedAt = session.promoted_at || session.created_at || null;
  const governance = require('../services/governance');

  // #788: does this proposal change dapp.json's `admins` block? This is
  // the AUTHORITATIVE check — the stamped column can be stale (a push
  // that raced its own stamp), so we re-diff against the live head here,
  // right before the gate.
  //
  // Fail-open on a GitHub transport error: fall back to the stored
  // column, and treat NULL as false. Failing closed would wedge EVERY
  // merge on the platform during a GitHub outage, and the highest-risk
  // path (a manifest PR opened by the platform itself) is stamped at
  // creation time, so the stale-and-outage case is vanishingly narrow.
  let explicitApproval = !!session.requires_explicit_approval;
  let explicitApprovalSource = 'stored';
  let explicitApprovalDetail = null;
  try {
    const detected = await appAdmins.detectAdminsChange(session, {
      headRef: appAdmins.headRefForSession(session),
    });
    // An INDETERMINATE result (no head ref / GitHub off / unparseable
    // repo / no merge base) keeps the stored flag — only a real diff
    // may overwrite it.
    if (detected.determinate) {
      explicitApproval = detected.changed;
      explicitApprovalSource = 'live';
      explicitApprovalDetail = {
        from: detected.from, to: detected.to, mergeBaseSha: detected.mergeBaseSha,
      };
      if (detected.changed !== !!session.requires_explicit_approval) {
        // The flip itself is worth a trace: a below-threshold clear
        // returns before any merge_debug_run opens, so without this
        // line a disappearing chip has no server-side explanation.
        log.info('votes', 'Explicit-approval flag overwritten by live check', {
          sessionId: session.id, stored: !!session.requires_explicit_approval,
          live: detected.changed, from: detected.from, to: detected.to,
          mergeBaseSha: detected.mergeBaseSha,
        });
        await appAdmins.stampExplicitApproval(pool, session.id, detected.changed);
      }
    }
  } catch (err) {
    log.warn('votes', 'Explicit-approval re-verify failed; using stored flag', {
      sessionId: session.id, stored: explicitApproval, err: err.message,
    });
  }

  const gate = await governance.governedGate(pool, session.app_id, {
    kind: 'pr', id: session.id, openedAt, explicitApproval,
    // #2038: scoped by approval epoch inside the gate. No revision is passed,
    // because a proposal's commit changes for reasons that say nothing about
    // whether its approvals still describe it.
  });
  const yesCount = gate.qualifiedYes;
  const noCount = gate.qualifiedNo;
  const activeCount = gate.activeCount;
  const majority = Math.floor(activeCount / 2) + 1;
  const required = gate.required;

  // Admin /debug capture. We deliberately do NOT open a run for the
  // common "not enough votes yet" early-return below — that fires on every
  // sub-threshold vote and would bury the interesting attempts. A run opens
  // only once a merge actually has a shot (majority reached, or a
  // force-merge), so the /debug list reads as real merge attempts — the
  // ones that either merge or get blocked. When the conflict-resolver
  // re-enters us (autoResolve:false) it passes its own run id so the retry
  // merge nests under the resolution run instead of spawning a duplicate.
  const md = require('../services/merge-debug');
  let debugRunId = options.debugRunId || null;
  const ownDebugRun = !debugRunId;
  const startDebugIfNeeded = async () => {
    if (ownDebugRun && debugRunId == null) {
      debugRunId = await md.startRun(pool, {
        appId: session.app_id, sessionId: session.id, prNumber: session.pr_number || null,
        kind: 'merge', trigger: force ? 'force' : 'vote',
      });
    }
  };
  const dstep = (o) => md.step(pool, debugRunId, o);
  // Only the run's owner stamps its terminal status; a passed-in run id
  // belongs to the resolver, which ends it itself.
  const dend = (status, summary) => { if (ownDebugRun) md.endRun(pool, debugRunId, { status, summary }); };

  // #2061 — the same run, recorded for the CARD rather than for an admin
  // reading merge_debug_steps. `gateTrace` marks ride beside the dstep() calls below
  // so the two cannot describe different runs; services/merge-requirements.js
  // holds the static gate order and turns this recording into the list a voter
  // sees. Purely descriptive: `gateSave` never gates anything, and it is
  // deliberately swallowed — a proposal must not fail to merge because its
  // explanation could not be written down.
  const requirements = require('../services/merge-requirements');
  const gateTrace = requirements.trace();
  const gateSave = () => requirements.store(pool, session.id, gateTrace).catch(() => {});
  // A run is a statement about one (reviewed head, approval epoch). Stamping
  // both lets readRequirements tell a recording about THIS proposal from one
  // about the proposal it used to be — after a head move released the claim,
  // or an epoch bump cleared the approvals it counted — and fall back to the
  // live columns instead of a "merging now" that stopped being true.
  gateTrace.context({
    headSha: reviewedHeadForSession(session) || null,
    approvalEpoch: Number.isFinite(parseInt(session.approval_epoch, 10))
      ? parseInt(session.approval_epoch, 10) : 0,
    evidenceEnforced: !!config?.visualEvidence?.enforce
      && !!session.visual_evidence_detail,
  });

  if (!force) {
    // Merge paths (services/active-users.js → mergeGate):
    //   A. Threshold: eased Yes threshold met AND visibility window elapsed.
    //   B. Lazy consensus: below threshold, but Yes strictly leads with no
    //      contest and the lazy merge clock has elapsed — silence is consent.
    if (!gate.mergeable) {
      // A clock is running (threshold-met visibility window, or an armed
      // lazy-consensus window) — stay 'promoted' (don't claim the merge) so
      // the proposal keeps gathering votes; the next vote after the window,
      // or the stale-PR sweeper pass, re-attempts the merge.
      if ((gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed) {
        log.info('votes', 'Merge clock running; deferring merge', {
          sessionId: session.id, yesCount, noCount, required,
          lazyArmed: gate.lazyArmed,
          windowMs: gate.windowMs, windowEndsAt: gate.windowEndsAt,
        });
        gateTrace.context({ explicitApproval, locked: null, selfHosted: null })
          .stop('approvals', 'waiting', {
            yesCount, required, windowEndsAt: gate.windowEndsAt,
            note: `${yesCount} of ${required}, or it merges on its own once the window closes`,
          });
        gateSave();
        return {
          merged: false, yesCount, needed: required,
          windowEndsAt: gate.windowEndsAt, waitingForWindow: true,
        };
      }
      // No clock at all: not enough support (or contested / No leading).
      gateTrace.context({ explicitApproval, locked: null, selfHosted: null })
        .stop('approvals', 'waiting', {
          yesCount, required,
          note: `${yesCount} of ${required}`,
        });
      gateSave();
      return { merged: false, yesCount, needed: required, windowEndsAt: gate.windowEndsAt };
    }

    await startDebugIfNeeded();
    if (explicitApproval) {
      dstep({
        phase: 'gate:explicit_approval',
        message: `Proposal changes dapp.json's admins block (${explicitApprovalSource} check). Time-based merge paths are off: no visibility window, no lazy consensus. The app's normal threshold still applies.`,
        detail: {
          explicitApproval: true, source: explicitApprovalSource, mode: gate.mode,
          ...(explicitApprovalDetail || {}),
        },
      });
    }
    dstep({
      phase: 'gate:majority',
      message: gate.mode === 'at_least'
        ? `Approval target reached: ${yesCount} qualifying approval${yesCount === 1 ? '' : 's'} (needed at least ${required}${gate.policy === 'invited' ? ' from invited approvers' : ''}).`
        : gate.thresholdMet
          ? `Vote threshold reached: ${yesCount} yes votes (needed ${required}) with the visibility window elapsed.`
          : `Lazy-consensus window elapsed: ${yesCount} yes vote${yesCount === 1 ? '' : 's'} (threshold ${required}) with no opposition, so silence is consent.`,
      detail: { yesCount, required, majority, noCount, activeCount, lazyArmed: gate.lazyArmed, mode: gate.mode, policy: gate.policy },
    });
    gateTrace.context({ explicitApproval })
      .pass('approvals', { yesCount, required, note: `${yesCount} of ${required}` });
    if (explicitApproval) gateTrace.pass('explicit', { source: explicitApprovalSource });

    // Locked apps additionally require at least one admin yes vote (see
    // services/admin-approval.js + the apps.locked column). The active-user
    // majority gate above still has to pass — the admin yes is an extra
    // condition, not a replacement. Toggled via the home-card lock icon
    // (admin-only); see POST /api/apps/:slug/lock in routes/apps.js.
    if (await isAppLocked(pool, session.app_id)) {
      // Epoch-scoped, like every other tally: an admin's yes survives the
      // platform's own sync exactly as the group's approvals do.
      const adminYes = await hasAdminYesVote(pool, session.id);
      if (!adminYes) {
        log.info('votes', 'Threshold + window met but app is locked; awaiting admin yes', {
          sessionId: session.id, yesCount, required,
        });
        dstep({ phase: 'gate:lock', level: 'warn', message: 'App is locked and has no admin yes vote yet, so the merge is blocked.', detail: { locked: true, adminYes: false } });
        gateTrace.context({ locked: true }).stop('admin_yes', 'waiting', {
          note: 'This app is locked, so an admin has to vote yes as well',
        });
        gateSave();
        dend('blocked', 'Blocked: locked app awaiting an admin yes vote.');
        return { merged: false, yesCount, needed: required, awaitingAdmin: true };
      }
      dstep({ phase: 'gate:lock', message: 'App is locked, and an admin yes vote is present.', detail: { locked: true, adminYes: true } });
      gateTrace.context({ locked: true }).pass('admin_yes');
    } else {
      dstep({ phase: 'gate:lock', message: 'App is not locked, so there is no admin-yes requirement.' });
      // Not applicable rather than satisfied: an admin-approval row on an
      // unlocked app is noise, and the count should read 4 of 4, not 4 of 5.
      gateTrace.context({ locked: false });
    }

    // #2038 — the integration gate.
    //
    // This replaced a behind-main gate that blocked the merge, posted
    // "syncing automatically", and queued a drain that only ever touched
    // proposals ALREADY eligible to merge — so for anything below threshold
    // the message was a promise nobody was keeping, and the proposal sat
    // drifting with no actor at all. That was #2038's F2.
    //
    // Under direct-merge lanes (services/merge-queue.js) the gate asks one
    // question: does this head merge cleanly with main RIGHT NOW? Clean
    // merges as it stands, however far behind. A conflict is refused and
    // handed to the conflict lane, whose resolution pushes a new head that
    // comes back through here on its own.
    //
    // Measured, not remembered: the old gate read session.behind_main off a
    // row that could be hours old, and a cached 0 let a genuinely-behind
    // proposal through to a 405 that nobody expected.
    // Required lazily and only where used. services/merge-queue pulls in the
    // worker and docker chain, and this gate runs on every vote — including
    // in unit suites that drive checkAndMerge with those collaborators
    // deliberately absent.
    const integrationSvc = require('../services/integration');
    const enqueueIntegration = () => {
      try {
        require('../services/merge-queue').enqueue(config, session.app_id);
      } catch (err) {
        log.warn('votes', 'Could not enqueue for integration', {
          sessionId: session.id, err: err.message,
        });
      }
    };
    const measured = await integrationSvc.measureDeduped(
      { pool, session }, { force: true }
    ).catch((err) => {
      // A measurement that cannot run must not block a merge: the exact-sha
      // merge is still the real guard, and GitHub refuses anything genuinely
      // unmergeable. Failing closed here would wedge every merge on the
      // platform behind a git hiccup.
      log.warn('votes', 'Integration measurement failed; not blocking the merge', {
        sessionId: session.id, err: err.message,
      });
      return { behindBy: null, mergesClean: null, conflictPaths: [] };
    });

    if (measured.mergesClean === false) {
      // A real conflict, from a real merge — not GitHub's lazily-computed
      // guess, and the paths are the ones git could not resolve rather than
      // the superset the old prediction had to settle for.
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      const n = (measured.conflictPaths || []).length;
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      // Who resolves it, in the words the card uses: the conflict lane's
      // verdict on this head, read off the row (services/merge-queue.js
      // writes it; services/merge-requirements.js reads it). The approvals
      // gate has passed, so an 'awaiting_approval' left from before the
      // vote is stale here and is not repeated.
      const step = requirements.integrationStep({
        ...session,
        integration_merges_clean: false,
        integration_behind_by: measured.behindBy,
        integration_conflict_paths: measured.conflictPaths || [],
        integration_block_reasons: (Array.isArray(session.integration_block_reasons)
          ? session.integration_block_reasons : []).filter((r) => r !== 'awaiting_approval'),
      });
      const msg = `${label} conflicts with main in ${n} file${n === 1 ? '' : 's'}`
        + `${n ? ` (${measured.conflictPaths.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''})` : ''}. `
        + (step.actor === 'author'
          ? `The platform cannot resolve this one; ${owner} needs to resolve it from the session's dev-chat.`
          : `The platform will try to resolve it automatically; if it can't, ${owner} needs to resolve it from the session's dev-chat.`);
      await sendSystemMessage(pool, session.app_id, msg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      dstep({
        phase: 'gate:integration', level: 'warn',
        message: `Conflicts with main in ${n} file(s); ${step.actor === 'author' ? 'the author has to resolve it' : 'handed to the conflict lane'}.`,
        detail: { conflictPaths: measured.conflictPaths, behindBy: measured.behindBy, actor: step.actor },
      });
      gateTrace.stop('integration', step.state, {
        conflictPaths: measured.conflictPaths, behindBy: measured.behindBy,
        actor: step.actor, note: step.note,
      });
      gateSave();
      dend('conflict_resolving', 'Conflicts with main: queued for integration.');
      // 'conflict' is derivable by the browser from the columns it already
      // reads, so the server does not restate it — only 'integrating' is its
      // to report, and the queue sets that when it actually starts.
      if (autoResolve) enqueueIntegration();
      return {
        merged: false, yesCount, needed: required,
        blockReason: 'conflict', conflictPaths: measured.conflictPaths,
      };
    }

    // Being behind main is not a reason to refuse. A head that merges
    // cleanly merges as it stands — GitHub produces the same merge commit
    // the platform's own sync would have pushed, without the worker turn,
    // the rebuild and the re-run that used to precede it (and that put
    // every sibling one further behind per merge). The measurement is
    // still recorded; the card shows it as information, not as a step.
    // The tree that results is judged afterwards, as a whole, by
    // services/main-watch.js — the main_healthy gate below.
    const behind = measured.behindBy || 0;
    dstep({
      phase: 'gate:integration',
      message: behind
        ? `Merges cleanly with main (${behind} commit${behind === 1 ? '' : 's'} behind; merging as it stands).`
        : 'Level with main, merges cleanly.',
      detail: { behindBy: measured.behindBy, mergesClean: measured.mergesClean },
    });
    gateTrace.pass('integration', {
      behindBy: measured.behindBy,
      note: behind
        ? `${behind} commit${behind === 1 ? '' : 's'} behind main; merges as it stands`
        : 'level with main',
    });

    // #47: "CI for proposals" gate. A proposal merges only when its
    // automated tests (the dapp.json `tests` suite, run against the staging
    // build by services/visuals.js — see check_state) are PASSING — or,
    // since #461, explicitly SKIPPED (there was genuinely nothing to test:
    // branch level with main, or no GitHub wired up). Anything else blocks
    // fail-closed: 'failing' (a test broke), 'pending' (the check is still
    // running, or a fresh commit reset it and the rebuild hasn't reported
    // yet), 'error' ("couldn't run"), or NULL (never checked). This is the
    // answer to "everything got super broken" (#47).
    // Re-read fresh: the in-memory `session` row can predate the latest
    // build's verdict. Admin force-merge bypasses (skipped under !force).
    const { rows: checkRows } = await pool.query(
      `SELECT check_state, test_results, checks_checked_at,
              check_error_detail, checks_commit_sha, check_phase
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    // A verdict deferred while the head conflicted (check_phase 'deferred',
    // services/check-admission.js). The integration gate just measured this
    // head clean, so the run that judges it can start now — the same kick
    // integration.onBecameClean makes, made here too so a merge attempt
    // never waits on a hook that did not fire. recheckSessionChecks is
    // _inFlight-guarded at the capture, so a double kick costs nothing.
    const checksDeferred = checkRows[0]?.check_state === 'pending'
      && checkRows[0]?.check_phase === 'deferred';
    if (checksDeferred && measured.mergesClean === true) {
      const stagingRecovery = require('../services/staging-recovery');
      stagingRecovery.recheckSessionChecks({
        config, pool, session, reason: 'conflict-resolved',
      }).catch((err) => {
        log.warn('votes', 'Deferred-checks kick failed', {
          sessionId: session.id, err: err.message,
        });
      });
    }
    const reviewedHead = reviewedHeadForSession(session);
    const returnedChecksSha = checkRows[0]?.checks_commit_sha;
    const checksRevisionMismatch = !!reviewedHead
      // `undefined` exists only in narrow unit-test row adapters that predate
      // the selected column; PostgreSQL returns null for a real unset value.
      && returnedChecksSha !== undefined
      && !sameSha(returnedChecksSha, reviewedHead);
    // A green verdict for an older commit is not a green verdict for the
    // reviewed code. Treat it as pending and rebuild exactly the pinned SHA.
    const checkState = checksRevisionMismatch
      ? 'pending'
      : (checkRows[0]?.check_state || null);
    if (checkState !== 'passing' && checkState !== 'skipped') {
      // #447: when a vote reaches threshold but the checks are NULL or stuck
      // 'pending' past the stale window, kick a recheck right now rather than
      // waiting for the periodic sweep — so a legitimately-passing PR clears
      // its block on the next vote instead of sitting indefinitely. The
      // recheck rebuilds staging if the preview is gone, else re-runs the
      // tests against the live container. Fire-and-forget; the gate still
      // blocks this attempt (the verdict isn't ready yet).
      const CHECKS_STALE_MS = parseInt(process.env.CHECKS_STALE_MS || String(10 * 60 * 1000), 10);
      const checkedAt = checkRows[0]?.checks_checked_at
        ? new Date(checkRows[0].checks_checked_at).getTime()
        : 0;
      // A deferred row is not stale: nothing was started for it, so nothing
      // is overdue, and the kick above (or the hook) owns its next run.
      const stalePending = !checksDeferred && (checkState === null
        || (checkState === 'pending' && (Date.now() - checkedAt) > CHECKS_STALE_MS));
      if (checksRevisionMismatch) {
        if (session.source === 'imported') {
          await kickImportedRevisionChecks({
            config, pool, session, headSha: reviewedHead,
          });
        } else {
          await kickNativeRevisionChecks({
            config, pool, session, headSha: reviewedHead,
          });
        }
      } else if (stalePending) {
        const stagingRecovery = require('../services/staging-recovery');
        stagingRecovery.recheckSessionChecks({
          config, pool, session, reason: 'stale-pending-vote-kick',
        }).catch((err) => {
          log.warn('votes', 'Stale-pending recheck kick failed', {
            sessionId: session.id, err: err.message,
          });
        });
      }
      const failingCount = Array.isArray(checkRows[0]?.test_results)
        ? checkRows[0].test_results.filter((r) => r && r.status !== 'pass').length
        : 0;
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      // #237: for the 'error' state, surface the captured reason (usually a
      // staging preview that crashed on boot, e.g. a bad migration/seed) so
      // the block isn't an unexplained dead-end — the owner can act on it.
      const errorDetail = checkState === 'error' ? (checkRows[0]?.check_error_detail || null) : null;
      const reason = checkState === 'failing'
        ? `has ${failingCount || 'failing'} test${failingCount === 1 ? '' : 's'} failing`
        : checkState === 'error'
          ? (errorDetail
            ? `couldn't run its tests, because its staging preview failed to start (${errorDetail})`
            : "couldn't run its tests")
          : 'is still running its tests';
      const blockMsg = `${label} reached the vote threshold but ${reason}. Merge is blocked until checks pass. The proposal's tests re-run automatically when its owner pushes a fix.`;
      // Said once. This gate runs on every vote and every check re-run, and
      // it used to post the same sentence each time — eight copies on one
      // topic thread. If the latest system line in this proposal's thread
      // already says exactly this, there is nothing new to say.
      const alreadySaid = await pool.query(
        `SELECT content FROM chat_messages
          WHERE app_id = $1 AND msg_type = 'system'
            AND thread_type = 'session' AND thread_ref = $2
          ORDER BY id DESC LIMIT 1`,
        [session.app_id, session.id]
      ).then((r) => !!(r.rows[0] && r.rows[0].content === blockMsg)).catch(() => false);
      if (!alreadySaid) {
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system').catch(() => {});
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
      }
      log.info('votes', 'Merge blocked: checks not passing', {
        sessionId: session.id, checkState, failingCount,
        checksRevisionMismatch,
      });
      dstep({ phase: 'gate:checks', level: 'warn', message: `Merge blocked: checks not passing (state = ${checkState || 'pending'}${failingCount ? `, ${failingCount} failing` : ''}).`, detail: { checkState: checkState || 'pending', failingCount, checksRevisionMismatch } });
      // 'pending' is in flight and needs nobody; 'failing' and 'error' need
      // the author. The card tones them differently for exactly that reason.
      gateTrace.stop('checks',
        (checkState === 'failing' || checkState === 'error') ? 'blocked' : 'active',
        {
          checkState: checkState || 'pending', failingCount,
          note: checkState === 'failing'
            ? `${failingCount || 'some'} failing. They re-run on the next push`
            : checkState === 'error'
              ? 'the staging preview could not start, so the tests could not run'
              : checksDeferred
                ? 'waited for the head to merge cleanly; running now'
                : 'still running',
        });
      gateSave();
      dend('blocked', 'Blocked: votes reached, but checks must pass first.');
      return {
        merged: false, yesCount, needed: required, blockReason: 'checks',
        checksBlocked: true, checkState: checkState || 'pending', failingCount,
        checksRevisionMismatch,
      };
    }
    dstep({ phase: 'gate:checks', message: `Checks gate: state = ${checkState}.`, detail: { checkState } });
    gateTrace.pass('checks', { checkState });

    // #2380: when enforcement is enabled, a required UI-evidence run is an
    // exact-head merge gate. This is not pixel-regression approval: the hard
    // replay and relevance reviewer have already done their bounded jobs.
    // `overridden` is accepted only because the override endpoint records an
    // app-admin identity and a visible reason.
    const evidenceGate = await readVisualEvidenceGate(config, pool, session);
    if (evidenceGate.applies && !evidenceGate.allowed) {
      dstep({
        phase: 'gate:visual_evidence', level: 'warn',
        message: `Merge blocked: ${evidenceGate.reason}`,
        detail: { state: evidenceGate.state, currentHead: evidenceGate.currentHead, recordedHead: evidenceGate.recordedHead },
      });
      gateTrace.stop('visual_evidence', evidenceGate.state === 'failed' ? 'blocked' : 'active', {
        state: evidenceGate.state,
        note: evidenceGate.reason,
      });
      gateSave();
      dend('blocked', 'Blocked: exact-revision visual evidence is not ready.');
      return {
        merged: false, yesCount, needed: required,
        blockReason: 'visual_evidence', visualEvidenceBlocked: true,
        visualEvidenceState: evidenceGate.state,
      };
    }
    if (evidenceGate.applies) {
      dstep({
        phase: 'gate:visual_evidence',
        message: `Visual evidence gate: state = ${evidenceGate.state}.`,
        detail: { state: evidenceGate.state, headSha: evidenceGate.currentHead },
      });
      gateTrace.pass('visual_evidence', { state: evidenceGate.state });
    }

    // Platform-variables gate. A self-app proposal that ADDS a required
    // `platform_env` declaration with no value set would deploy the
    // platform into a crash-loop, so it blocks here.
    //
    // Evaluated LIVE rather than read from platform_env_state. The stored
    // column exists for display; trusting it here would mean an admin who
    // sets the missing value has to wait for a staging rebuild before the
    // merge unblocks, which is absurd for a change that has nothing to do
    // with the build. Setting the value and voting again is enough.
    //
    // Fails open on everything indeterminate (see the service) — a GitHub
    // hiccup must not freeze every platform merge. Admin force-merge
    // bypasses along with the rest of this block.
    const platformEnvCheck = require('../services/platform-env-check');
    const { rows: gateAppRows } = await pool.query(
      'SELECT id, repo_url, self_hosted FROM apps WHERE id = $1',
      [session.app_id]
    );
    const gateApp = gateAppRows[0] || null;
    if (gateApp && gateApp.self_hosted) {
      const envVerdict = await platformEnvCheck.resolvePlatformEnvCheck({
        pool, app: gateApp, session,
      });
      // Persist what we just computed so the Checks card agrees with the
      // gate rather than showing an older verdict.
      await platformEnvCheck.storePlatformEnvCheck(pool, session.id, envVerdict);

      if (envVerdict.state === 'failing') {
        const label = session.pr_title
          ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
          : `PR #${session.pr_number || session.id}`;
        const blockMsg = platformEnvCheck.describeBlock(envVerdict.detail, label);
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system').catch(() => {});
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
        log.info('votes', 'Merge blocked: platform variables unset', {
          sessionId: session.id, missing: envVerdict.detail.missing.map((m) => m.key),
        });
        dstep({
          phase: 'gate:platform-env', level: 'warn',
          message: `Merge blocked: ${envVerdict.detail.missing.length} platform variable(s) declared but not set.`,
          detail: envVerdict.detail,
        });
        gateTrace.context({ selfHosted: true }).stop('platform_env', 'waiting', {
          missing: envVerdict.detail.missing.map((m) => m.key),
          note: `${envVerdict.detail.missing.length} variable${envVerdict.detail.missing.length === 1 ? '' : 's'} declared with no value set`,
        });
        gateSave();
        dend('blocked', 'Blocked: a new platform variable has no value set.');
        return {
          merged: false, yesCount, needed: required, blockReason: 'platform_env',
          platformEnvBlocked: true,
          platformEnvMissing: envVerdict.detail.missing.map((m) => m.key),
        };
      }
      dstep({
        phase: 'gate:platform-env',
        message: `Platform-variables gate: ${envVerdict.state}.`,
        detail: { state: envVerdict.state, reason: envVerdict.detail.reason },
      });
      gateTrace.context({ selfHosted: true }).pass('platform_env', { state: envVerdict.state });
    } else {
      // Not a self-hosted app, so the gate does not exist for it — omitted
      // from the list rather than shown as satisfied.
      gateTrace.context({ selfHosted: false });
    }

    // Main-health gate (services/main-watch.js). Every merge lands a tree
    // nobody ran the checks against as a whole, so the repo's unit suite
    // runs once more on each merge commit, and a red result pauses the
    // app's merges — whatever this proposal's own checks said — until a
    // fix lands or an admin resumes them. This is the app's state rather
    // than the proposal's, which is why it is the last thing asked before
    // GitHub: nothing about the proposal changes it, and nothing the author
    // does clears it.
    //
    // With one exception, and it is what the pause is FOR. The pause holds
    // back merges whose tree nobody has tested — a head checked against an
    // older main lands a tree the red could be hiding in. A head that is
    // level with main, merges clean, and whose own checks (the same unit
    // suite) passed on this exact tree lands exactly the tree that was
    // tested: it is not hiding anything, it is the fix candidate, and its
    // own post-merge run re-tests main. It goes.
    const mainWatch = require('../services/main-watch');
    const mainHealth = await mainWatch.mergePause(pool, session.app_id);
    if (mainHealth.paused) {
      // The red commit the pause is ABOUT — not the one a newer merge may be
      // re-testing right now, which is what main_check_sha says meanwhile.
      const redSha = mainHealth.pausedSha || mainHealth.sha;
      const since = redSha ? String(redSha).slice(0, 7) : 'the last merge';
      const culprit = mainHealth.failingTest ? ` (${mainHealth.failingTest})` : '';
      const what = mainHealth.confirming
        ? `main's unit suite failed once since ${since}${culprit} and is being re-run to confirm`
        : `main's unit suite is failing since ${since}${culprit}`;
      const levelAndGreen = measured.behindBy === 0 && measured.mergesClean === true
        && checkState === 'passing' && require('../services/unit-suite').passedIn(checkRows[0]?.test_results);
      if (!levelAndGreen) {
        dstep({
          phase: 'gate:main_healthy', level: 'warn',
          message: `Merge blocked: ${what}; merges for this app are paused.`,
          detail: {
            sha: mainHealth.sha, at: mainHealth.at, confirming: mainHealth.confirming,
            failingTest: mainHealth.failingTest,
            behindBy: measured.behindBy, mergesClean: measured.mergesClean, checkState,
          },
        });
        gateTrace.stop('main_healthy', 'blocked', {
          sha: mainHealth.sha,
          paused: true,
          confirming: mainHealth.confirming,
          note: `${what}; merges are paused until a fix lands or an admin resumes them`,
        });
        gateSave();
        dend('blocked', 'Blocked: main is red, merges paused.');
        return {
          merged: false, yesCount, needed: required, blockReason: 'main_failing',
          mainCheck: mainHealth,
        };
      }
      dstep({
        phase: 'gate:main_healthy',
        message: `Main's unit suite is red (since ${since}), but this head is level with main and its own checks passed on this exact tree; merging it re-tests main.`,
        detail: { sha: mainHealth.sha, confirming: mainHealth.confirming, passThrough: 'level_and_green' },
      });
      gateTrace.pass('main_healthy', {
        state: mainHealth.state,
        sha: mainHealth.sha,
        passThrough: 'level_and_green',
        note: `${what}; this head is level with main and its own checks passed on this exact tree, so it merges and re-tests main`,
      });
    } else {
      dstep({
        phase: 'gate:main_healthy',
        message: mainHealth.state
          ? `Main's unit suite: ${mainHealth.state}${(mainHealth.state === 'failing' || mainHealth.state === 'confirming') ? ' (an admin resumed merges)' : ''}.`
          : 'Main has not been watched yet for this app.',
        detail: { state: mainHealth.state, sha: mainHealth.sha },
      });
      gateTrace.pass('main_healthy', {
        state: mainHealth.state,
        note: mainHealth.state === 'passing' ? 'main is green'
          : (mainHealth.state === 'failing' || mainHealth.state === 'confirming') ? 'main is red, but an admin resumed merges'
            : mainHealth.state === 'running' ? 'main is being checked after the last merge'
              : 'no verdict about main yet',
      });
    }
  }
  // For admin force-merge we deliberately skip the behind_main pre-check
  // — GitHub will still reject the merge if there's a real conflict,
  // and the catch-block below surfaces that the same way it does for
  // votes. Admins overriding the vote can decide whether to push the
  // branch sync themselves.

  // Majority reached. Try to claim the merge by atomically flipping
  // status 'promoted' → 'merging'. Only one concurrent caller will
  // win this; everyone else bails out. This guards against the
  // previous bug where hammering "Yes" fired N parallel merge+rebuild
  // pipelines that stomped on each other (GitHub lock, /tmp/usernode-
  // rebuild-* git clone races, duplicate `docker run --name ...`, etc).
  // Force-merge skips the gate block above, so its run opens here.
  await startDebugIfNeeded();
  if (force) {
    dstep({ phase: 'gate:majority', message: `Force-merge by ${forceBy?.username || 'an admin'}, bypassing the vote/checks gates.`, detail: { yesCount, majority, forced: true } });
  }

  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET status = 'merging'
     WHERE id = $1 AND status = 'promoted'
     RETURNING id`,
    [session.id]
  );
  // #2061 — gate 7 starts here, and until now none of its outcomes were
  // written anywhere a card could read: they are reached only inside a merge
  // attempt, which either succeeded or logged and moved on. That is why
  // "checks are running, so it merges next" was a guess the reader had to
  // make rather than something the card could say.
  gateTrace.stop('github', 'active', { note: 'merging now' });
  gateSave();
  if (!claim.length) {
    log.info('votes', 'Merge already claimed by another request, skipping', {
      sessionId: session.id,
    });
    dstep({ phase: 'claim', message: 'Merge already claimed by another request, so skipping.' });
    dend('noop', 'Another request is already merging this proposal.');
    return { merged: false, inProgress: true };
  }
  dstep({ phase: 'claim', message: 'Claimed merge (promoted → merging).' });
  // Nothing is blocking it any more; the card should stop saying so.
  await require('../services/integration')
    .setBlockReasons(pool, session.id, []);

  // Broadcast the 'merging' transition so every client refreshes its
  // vote panel and re-renders the PR as "Merging…" — rather than having
  // it silently disappear between the vote and the eventual 'merged'
  // state (30s+ on the majority path). `merged:false` here means "still
  // in flight"; the final `merged:true` broadcast fires below after the
  // GitHub merge + prod rebuild + staging teardown finish.
  //
  // `selfHosted` rides along as a cheap, honest fact about the merge:
  // whether this proposal deploys the platform itself. It used to arm
  // the platform-wide "Platform updating…" banner, which was removed in
  // #1015 — blue-green deploys (#1008) keep the live color serving
  // through a platform redeploy, so there is no downtime to announce
  // and no reason for a client to pause writes. No client branches on
  // the flag today; it stays on the payload for admin/debug parity and
  // any future surface that wants to distinguish a platform merge.
  const { pushVoteUpdate } = require('../services/ws');
  pushVoteUpdate({
    sessionId: session.id,
    appSlug: session.app_slug,
    merged: false,
    merging: true,
    selfHosted: !!session.app_self_hosted,
  });

  log.info('votes',
    force ? 'Admin force-merge invoked, merging' : 'Majority reached, merging',
    {
      sessionId: session.id, yesCount, needed: required,
      ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
    });

  let mergeCommitSha = null;
  // Tracks whether the irreversible GitHub merge has already happened. Once
  // it has, a failure in any LATER step (prod rebuild, staging teardown,
  // bounty payout, …) must NOT roll the session back to 'promoted' — the PR
  // is merged on GitHub and re-opening it for voting is the bug behind
  // "merged PRs still show up for voting" (the rebuild can keep failing —
  // e.g. a newly-required secret with no production value — yet the merge is
  // done). See the catch block below.
  let githubMerged = false;

  try {
    // Merge PR on GitHub
    // Pin every GitHub merge to the exact reviewed commit so GitHub refuses
    // (409) if the head moved. Imported staging previews still use their
    // existing in-memory mock; native proposals always use the real client.
    const isImported = session.source === 'imported';
    const useMockMerge = isImported && usesMockGithubForImports();
    const mergeClient = useMockMerge ? githubMock : github;
    if ((mergeClient.isEnabled() || useMockMerge) && session.repo_url && session.pr_number) {
      const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (owner && repo) {
        const pinnedSha = reviewedHeadForSession(session);
        dstep({ phase: 'github_merge', message: `Calling GitHub merge for PR #${session.pr_number}…`, detail: { owner, repo, pinnedSha, mock: useMockMerge } });
        let mergeData;
        try {
          mergeData = await mergeClient.mergePR(owner, repo, session.pr_number, pinnedSha);
        } catch (err) {
          // Head moved between the review and the merge. Do NOT error the proposal: release
          // the 'merging' claim back to 'promoted' so the row stays recoverable
          // (recoverStuckMerges understands both states). Both sources re-pin
          // from the mirror right here: native rows always did; imported rows
          // used to be left to the sync poller, which read the platform's own
          // sync commit as an author push and cleared the votes (#2100). An
          // imported head the mirror cannot see (author's fork) is still left
          // to the poller. Return a distinct { headMoved } outcome; nothing
          // merged.
          if (err && err.headMoved) {
            let nativeRefresh = null;
            let importedRefresh = null;
            if (isImported) {
              importedRefresh = await require('../services/pr-import-sync').reconcileImportedHead({
                config, pool, session, checks: 'defer', notify: false,
              });
              // The mirror says the branch still sits on the pinned commit:
              // this 409 was GitHub's word for an ordinary conflict, not a
              // head move. Same routing as the native branch below.
              if (importedRefresh.reconciled && !importedRefresh.changed
                  && sameSha(importedRefresh.headSha, pinnedSha)) {
                err.headMoved = false;
                err.status = 405;
                throw err;
              }
            } else {
              nativeRefresh = await reconcileNativeReviewedHead({
                config, pool, session, fresh: true, notify: false,
              }).catch((syncErr) => {
                log.warn('votes', 'Native head-moved reconciliation failed', {
                  sessionId: session.id, err: syncErr.message,
                });
                return null;
              });

              // GitHub also uses 409 for an ordinary merge conflict. If a
              // fresh read says the native PR is still on the exact pinned
              // SHA, this was not a revision change; route it through the
              // existing conflict recovery path instead of clearing review.
              if (!nativeRefresh?.blocked && nativeRefresh?.headSha === pinnedSha) {
                err.headMoved = false;
                err.status = 405;
                throw err;
              }

              // A 409 plus an unverifiable revision is ambiguous. Release the
              // claim and fail closed without claiming either a head move or a
              // merge conflict; a later vote/sweep can retry the live read.
              if (!nativeRefresh || nativeRefresh.blocked || !nativeRefresh.headSha) {
                await pool.query(
                  `UPDATE chat_sessions SET status = 'promoted' WHERE id = $1 AND status = 'merging'`,
                  [session.id]
                ).catch(() => {});
                try {
                  const { pushVoteUpdate } = require('../services/ws');
                  // merging:false + merged:false is the terminal "attempt
                  // ended, no deploy coming" shape — clients un-latch the
                  // self-app "Platform updating…" banner off it (see
                  // handleVoteUpdate). Every terminal broadcast must carry
                  // merging:false or self-app tabs stay read-only waiting
                  // for a SHA flip that never comes.
                  pushVoteUpdate({
                    sessionId: session.id, appSlug: session.app_slug,
                    merged: false, merging: false,
                    selfHosted: !!session.app_self_hosted,
                  });
                } catch (_) { /* ws failures non-fatal */ }
                const reason = nativeRefresh?.reason
                  || 'GitHub could not verify the pull request revision after refusing the merge.';
                await sendSystemMessage(pool, session.app_id,
                  `PR #${session.pr_number} was not merged because its current GitHub revision could not be verified. Please retry after GitHub is reachable.`,
                  'system', null, { type: 'session', ref: session.id }
                ).catch(() => {});
                dstep({
                  phase: 'github_merge', level: 'warn',
                  message: 'GitHub refused the merge and the live native revision could not be verified.',
                  detail: { revisionBlocked: true, pinnedSha, reason },
                });
                gateTrace.revise('github', 'active', {
                  note: 'waiting for GitHub to confirm the current revision',
                });
                gateSave();
                dend('deferred', 'Merge deferred: the current GitHub revision could not be verified.');
                return {
                  merged: false,
                  revisionBlocked: true,
                  transient: !!nativeRefresh?.transient,
                  error: reason,
                };
              }
            }
            await pool.query(
              `UPDATE chat_sessions SET status = 'promoted' WHERE id = $1 AND status = 'merging'`,
              [session.id]
            ).catch(() => {});
            try {
              const { pushVoteUpdate } = require('../services/ws');
              // merging:false ends the merge attempt for clients: the
              // merging:true broadcast above armed the self-app "Platform
              // updating…" banner, and no deploy — hence no SHA flip —
              // follows an aborted merge. A head move is deliberately NOT
              // flagged mergeFailed; the client un-latches off the
              // merging:false + merged:false shape itself.
              pushVoteUpdate({
                sessionId: session.id, appSlug: session.app_slug,
                merged: false, merging: false, headMoved: true,
                selfHosted: !!session.app_self_hosted,
              });
            } catch (_) { /* ws failures non-fatal */ }
            // #955: the head may have moved because the PLATFORM synced this
            // branch with main. Those approvals survived the refresh, so this
            // is a re-pin and an immediate retry — not a return to review.
            const refreshed = isImported
              ? (importedRefresh?.reconciled && importedRefresh.changed ? importedRefresh : null)
              : nativeRefresh;
            const votesKept = !!refreshed?.votesKept;
            const refreshedHeadSha = refreshed?.headSha || null;
            const movedLabel = session.pr_title
              ? `PR #${session.pr_number}: ${session.pr_title}`
              : `PR #${session.pr_number}`;
            const movedMessage = (isImported && !refreshed)
              ? `${movedLabel} wasn't merged, because the PR was updated on GitHub since the vote, so GitHub declined to merge the older commit. It'll be re-checked against the new commit and can merge again once it passes.`
              : votesKept
                ? `${movedLabel} wasn't merged on this attempt: it had just been synced with main, so the merge is now pinned to commit ${String(refreshedHeadSha).slice(0, 8)}. Existing votes were kept and the merge retries automatically.`
                : `${movedLabel} wasn't merged, because its GitHub head changed after review. Earlier-revision votes were cleared and the new commit is being checked; please re-review it.`;
            await sendSystemMessage(pool, session.app_id,
              movedMessage,
              'system', null, { type: 'session', ref: session.id }
            ).catch(() => {});
            dstep({ phase: 'github_merge', level: 'warn', message: (isImported && !refreshed)
              ? 'GitHub refused the merge: the PR head moved since the reviewed commit. Released the merge claim; the sync poller will pick up the new head.'
              : votesKept
                ? 'GitHub refused the merge: the pinned commit was superseded by the platform\'s own sync. Re-pinned to it with votes intact and re-queued the merge.'
                : 'GitHub refused the merge: the PR head moved since review. Released the merge claim and reset the proposal to the new revision.', detail: { headMoved: true, votesKept, pinnedSha, refreshedHeadSha } });
            dend('deferred', (isImported && !refreshed)
              ? 'Head moved since the reviewed commit, so it is deferred to the sync poller.'
              : votesKept
                ? 'Superseded by the platform\'s own sync commit, so it is re-queued with votes intact.'
                : 'Head moved since review, so it returned to review on the new commit.');
            // #2061: gate 7 was marked 'active — merging now' at the claim,
            // and the claim has just been released. Whatever the card reads
            // next must not still say the merge is under way (readRequirements
            // also retires a recording whose head or epoch moved on, but the
            // fork-hosted imported case moves neither).
            gateTrace.revise('github', votesKept ? 'active' : 'waiting', {
              note: (isImported && !refreshed)
                ? 'GitHub declined the reviewed commit because the branch moved; waiting for the new head to be picked up'
                : votesKept
                  ? `re-pinned to the synced commit ${String(refreshedHeadSha).slice(0, 8)}; the merge retries automatically`
                  : 'the branch moved after review, so it is back to review on the new commit',
            });
            gateSave();
            if (votesKept) {
              // Re-drive the app drain so the merge is re-attempted against the
              // corrected pin instead of waiting for the hourly sweeper. It
              // cannot loop: the pin now equals the live head, so the retry
              // either merges or blocks on a real gate (usually checks).
              checkAndResolveConflicts(config, { app_id: session.app_id }).catch((e) => {
                log.warn('votes', 'Post-sync merge re-kick failed', {
                  sessionId: session.id, err: e.message,
                });
              });
            }
            return {
              merged: false, headMoved: true, needed: required, yesCount,
              ...(votesKept ? { votesKept: true } : {}),
              ...(refreshedHeadSha ? { reviewedHeadSha: refreshedHeadSha } : {}),
            };
          }
          throw err;
        }
        // #11: capture the squash-merge commit SHA so future vote-to-undo
        // can `git revert <sha>` against main. The Octokit `pulls.merge`
        // response shape is { sha, merged: true, message }.
        mergeCommitSha = mergeData?.sha || null;
        githubMerged = true;
        dstep({ phase: 'github_merge', message: `GitHub merged PR #${session.pr_number}${mergeCommitSha ? ` as commit ${String(mergeCommitSha).slice(0, 9)}` : ''}.`, detail: { sha: mergeCommitSha } });
      }
    } else {
      dstep({ phase: 'github_merge', message: 'GitHub not enabled or PR-less, so skipping the GitHub merge call.' });
    }

    // #687 Slice 4: run the shared post-merge finalizer. Both native and
    // imported merges converge here after the (only-difference) github.mergePR
    // call above, so the deploy/teardown/announce tail is byte-for-byte
    // identical for both. A throw inside still lands in this try's catch,
    // which honours the githubMerged guard and the merge-debug tracing.
    return await finalizeMerge({
      config, pool, session,
      mergeCommitSha, required, activeCount, yesCount, majority,
      force, forceBy, dstep, dend,
      // #2061: finalizeMerge owns the success end, so it has to be able to
      // record gate 7's real outcome. Threaded like dstep/dend for the same
      // reason — it is a separate top-level function, not a closure.
      gateTrace, gateSave,
    });
  } catch (err) {
    log.error('votes', 'Merge failed', { sessionId: session.id, err: err.message, githubMerged });
    dstep({ phase: 'merge_error', level: 'error', message: `Merge step threw: ${err.message}`, detail: { githubMerged, status: err.status || null } });

    // The GitHub merge is irreversible. If it already succeeded and a
    // LATER step threw (most commonly `staging.rebuildProduction` — e.g. a
    // PR that introduces a new required secret with no production value
    // raises MissingSecretsError, or two sibling rebuilds race on the
    // container name), the PR *is* merged. Rolling the session back to
    // 'promoted' here is exactly what left whiteboard PRs #41/#44/#52/#54
    // showing "up for voting" forever: `GET /api/apps/:slug/promoted`
    // returns `status IN ('promoted','merging')`, and any "retry" merge
    // 405s because GitHub has nothing left to merge. Instead, record the
    // merge and surface the deploy failure separately so an operator can
    // fix the cause and re-run the rebuild ("Check for updates" / drift
    // poller). The pre-merge conflict/behind_main handling further down is
    // premised on the merge NOT having happened, so we return early.
    if (githubMerged) {
      await pool.query(
        `UPDATE chat_sessions
            SET status = 'merged',
                merged_at = COALESCE(merged_at, NOW()),
                merge_commit_sha = COALESCE(merge_commit_sha, $2),
                votes_required = COALESCE(votes_required, $3),
                active_users_at_merge = COALESCE(active_users_at_merge, $4)
          WHERE id = $1 AND status IN ('merging', 'merged')`,
        [session.id, mergeCommitSha, required, activeCount]
      ).catch((e) => log.error('votes',
        'Failed to mark session merged after post-merge error', {
          sessionId: session.id, err: e.message,
        }));

      const failLabel = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${failLabel} merged on GitHub, but the production deploy failed: ${err.message}. ` +
        `The change is on main; an operator can retry the deploy once the cause is resolved.`,
        'system'
      ).catch(() => {});

      try {
        const { pushVoteUpdate } = require('../services/ws');
        pushVoteUpdate({
          sessionId: session.id,
          appSlug: session.app_slug,
          merged: true,
          merging: false,
          deployFailed: true,
          selfHosted: !!session.app_self_hosted,
        });
      } catch (_) { /* ws failures non-fatal */ }

      dstep({ phase: 'merged', level: 'warn', message: `PR merged on GitHub but the production deploy failed: ${err.message}`, detail: { deployFailed: true } });
      dend('merged', 'Merged on GitHub; production deploy failed (operator retry needed).');
      return { merged: true, deployFailed: true, error: err.message };
    }

    // GitHub merge did NOT happen (conflict, auth, transient API error).
    // Release the 'merging' claim so a subsequent vote (or retry) can
    // try again. Without this the session would be stuck in 'merging'
    // forever on any transient failure.
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted'
       WHERE id = $1 AND status = 'merging'`,
      [session.id]
    ).catch(() => {});

    // #9: detect GitHub's "merge conflict" rejection specifically.
    // Octokit returns status 405 with a message containing "merge
    // conflict" or "not mergeable" when `pulls.merge` is called on
    // an unmergeable PR. Computed before the mergeFailed broadcast
    // below so the broadcast can flag whether the auto-resolver is
    // about to kick in (#239).
    const msg = String(err.message || '').toLowerCase();
    const isConflict =
      err.status === 405 ||
      msg.includes('merge conflict') ||
      msg.includes('not mergeable') ||
      msg.includes('pull request is not mergeable');

    // A 405 on a CLOSED PR is not a merge conflict — GitHub reports
    // closed PRs as permanently unmergeable ('dirty'), so handing this
    // to the auto-resolver spins forever (session 2398 / PR #26:
    // withdraw closed the PR, re-promote never reopened it, every merge
    // 405'd and every resolve ended still_conflicting). Distinguish the
    // two with one PR GET: closed-unmerged → reopen and fall through to
    // the normal conflict handling; reopen refused → terminal pr_closed
    // (off the vote panel, honest group-chat message, no resolver). A
    // transient GET failure falls through to the conflict path unchanged.
    if (isConflict && github.isEnabled() && session.repo_url && session.pr_number) {
      const [, prOwner, prRepo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      let prState = null;
      if (prOwner && prRepo) {
        try {
          prState = await github.getPR(prOwner, prRepo, session.pr_number);
        } catch (e) {
          log.warn('votes', 'PR state check after merge 405 failed', {
            sessionId: session.id, pr: session.pr_number, err: e.message,
          });
        }
      }
      if (prState && prState.state === 'closed' && !prState.merged) {
        try {
          await github.reopenPR(prOwner, prRepo, session.pr_number);
          dstep({ phase: 'reopened_closed_pr', message: `PR #${session.pr_number} was closed on GitHub. Reopened it; continuing with the normal conflict handling.` });
        } catch (reopenErr) {
          const closedLabel = session.pr_title
            ? `PR #${session.pr_number}: ${session.pr_title}`
            : `PR #${session.pr_number}`;
          // Drop out of 'promoted' so no vote/sweep re-picks a proposal
          // whose PR can never merge. 'paused' keeps the branch + CC
          // memory restorable; the owner can re-propose from dev-chat.
          await pool.query(
            `UPDATE chat_sessions SET status = 'paused'
             WHERE id = $1 AND status = 'promoted'`,
            [session.id]
          ).catch(() => {});
          await sendSystemMessage(pool, session.app_id,
            `${closedLabel} is closed on GitHub and couldn't be reopened, so it has been taken off the vote panel. Re-propose it from the session's dev-chat.`,
            'system'
          ).catch(() => {});
          try {
            const { pushVoteUpdate, pushSessionUpdate } = require('../services/ws');
            // Un-latch clients (the merging:true broadcast above armed
            // banners) and refresh session lists off the pause.
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              merging: false,
              mergeFailed: true,
              resolving: false,
              selfHosted: !!session.app_self_hosted,
            });
            pushSessionUpdate({ action: 'paused', sessionId: session.id, appSlug: session.app_slug });
          } catch (_) { /* ws failures non-fatal */ }
          dstep({
            phase: 'pr_closed', level: 'error',
            message: `PR #${session.pr_number} is closed on GitHub and couldn't be reopened: ${reopenErr.message}`,
            detail: {},
          });
          gateTrace.revise('github', 'blocked', {
            note: 'the pull request is closed on GitHub and could not be reopened',
          });
          gateSave();
          dend('pr_closed', `PR #${session.pr_number} is closed on GitHub (reopen failed).`);
          return { merged: false, error: err.message, conflict: false, prClosed: true };
        }
      }
    }

    // Terminal counter-event to the `merging:true` broadcast above: this
    // merge attempt is over and nothing merged. Every client surface
    // that advanced to "Merging…" needs it to fall back — the vote
    // panel, the session header pill, the proposal's own state badge —
    // so the shape (`merging:false` + `merged:false`) is the contract,
    // not an optimization. (It also un-latched the platform-wide
    // "Platform updating…" banner until #1015 removed it.)
    //
    // #239: `resolving` rides along when the failure is a conflict AND
    // the auto-resolver is about to be fired below, so the proposal's
    // badge reads "Resolving conflicts…" rather than a bare failure
    // while the resolver spends 1–2 minutes fixing the branch. The
    // resolver's own start broadcast can lag by a few seconds
    // (pollMergeable runs first), so this flag closes the gap.
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug,
        merged: false,
        merging: false,
        mergeFailed: true,
        resolving: isConflict && autoResolve,
        selfHosted: !!session.app_self_hosted,
      });
    } catch (_) { /* ws failures non-fatal */ }

    // The pre-merge gate in checkAndMerge catches
    // the common case (our recorded behind_main > 0), but races
    // (another PR merging in the window between our last sync and
    // the vote crossing threshold) can slip past it. When that
    // happens, our local behind_main is stale (= 0) but the branch
    // really is behind main, so we:
    //   1. Bump behind_main to at least 1 so the dev-chat banner
    //      reappears for the owner. The next worker turn will
    //      recompute the exact count.
    //   2. Broadcast session_update(behind_main) so any open dev-chat
    //      banner refreshes in place.
    //   3. Post a tailored group-chat message that matches the
    //      pre-merge gate's wording, so the user knows it's a
    //      "owner needs to click Sync" situation rather than a
    //      mysterious GitHub blowup.
    if (isConflict) {
      try {
        const { rows: bumpRows } = await pool.query(
          `UPDATE chat_sessions
             SET behind_main = GREATEST(behind_main, 1),
                 -- #361: a real merge-time conflict — reflect it on the
                 -- card immediately (conflict_files fills in on the next
                 -- sync, which captures the --diff-filter=U set).
                 merge_conflict_state = 'conflict',
                 conflict_checked_at = NOW()
           WHERE id = $1 RETURNING behind_main`,
          [session.id]
        );
        const newBehind = bumpRows[0]?.behind_main || 1;
        try {
          const { pushSessionUpdate } = require('../services/ws');
          pushSessionUpdate({
            action: 'behind_main',
            sessionId: session.id,
            appSlug: session.app_slug,
            behindMain: newBehind,
          });
        } catch (_) { /* ws failures non-fatal */ }
      } catch (_) { /* DB bump failures non-fatal — chat msg still goes out */ }

      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      // Honest wording: the auto-resolver drain only picks up proposals
      // that are vote-eligible to merge, so "syncing automatically" was a
      // false promise for anything below the gate. On the FORCED path the
      // resolve really is about to run (dispatched directly below), so the
      // message can promise it; otherwise lead with the creator's "Sync
      // with main", which is the path that always works.
      await sendSystemMessage(pool, session.app_id,
        (force && autoResolve)
          ? `${label} hit a conflict with main during an admin merge. Resolving the conflict automatically and retrying the merge.`
          : `${label} hit a conflict with main during a merge attempt. ${owner}: finish the merge by running "Sync with main" from the session's dev-chat. (Auto-resolution retries only when the proposal is eligible to merge on votes.)`,
        'system'
      );
      // Auto-heal the conflict the same way the behind_main gate does.
      // autoResolve guards against the resolver's own retry re-entering
      // this path (it calls checkAndMerge with autoResolve:false).
      if (autoResolve) {
        if (force) {
          // Force-carry-through: an admin explicitly asked for this merge,
          // so the recovery must not be handed to the gate-filtered app
          // drain (which re-applies the vote check the admin just bypassed
          // and skips anything below threshold — the "starts auto merging,
          // then nothing" dead end). Resolve THIS session directly — same
          // worker sync the owner's "Sync with main" runs — and retry the
          // merge with the force intent preserved.
          const { resolveAndMaybeRetry } = require('../services/conflict-resolver');
          resolveAndMaybeRetry(config, { sessionId: session.id }, {
            mergeOnly: false, force: true, forceBy, trigger: 'force',
          }).catch((e) => {
            log.error('votes', 'Auto-resolve (forced merge conflict) failed', {
              sessionId: session.id, err: e.message,
            });
          });
        } else {
          // Same app-level drain as the behind_main path — serialized,
          // one-proposal-at-a-time-per-app resolution.
          checkAndResolveConflicts(config, { app_id: session.app_id }).catch((e) => {
            log.error('votes', 'Auto-resolve (merge conflict) failed', {
              sessionId: session.id, err: e.message,
            });
          });
        }
      }
    } else {
      await sendSystemMessage(pool, session.app_id,
        `Failed to merge PR #${session.pr_number || session.id}: ${err.message}`,
        'system'
      );
    }
    if (isConflict) {
      dstep({
        phase: 'conflict_detected', level: 'warn',
        message: 'GitHub rejected the merge as a conflict. '
          + (!autoResolve ? 'auto-resolver not run (resolver re-entry).'
            : force ? 'per-session resolver dispatched directly with the force intent preserved.'
              : 'auto-resolver queued.'),
        detail: { autoResolve, forced: !!force },
      });
      gateTrace.revise('github', autoResolve ? 'active' : 'blocked', {
        note: autoResolve
          ? 'GitHub refused the merge, so the platform is resolving it automatically'
          : 'GitHub refused the merge',
      });
      gateSave();
      dend(autoResolve ? 'conflict_resolving' : 'conflict_failed', 'Merge conflict at GitHub.');
    } else {
      gateTrace.revise('github', 'blocked', { note: 'the merge failed' });
      gateSave();
      dend('error', `Merge failed: ${err.message}`);
    }
    return { merged: false, error: err.message, conflict: isConflict };
  }
}

// #11/#16: undo helper. Called from the /undo route. Opens a revert PR
// for a merged session (clone, `git revert <merge_sha>`, push, open PR)
// and inserts a `promoted` chat_sessions row for it that then goes
// through the normal merge vote. As of #16 there's no undo-vote gate —
// the merge vote on the revert PR is the single checkpoint.
//
// `decider` is the user who requested the undo — becomes the revert
// session's user_id so they own the resulting PR in dev-chat.
async function checkAndOpenRevert(config, pool, session, decider) {
  // #16: opening a revert is now a direct action (like proposing a
  // forward change) — there's no separate undo-vote gate to clear. We
  // still read activeCount/majority so the announcement can tell users
  // how many votes the revert PR will need to actually land. The
  // locked-app admin-yes gate is NOT applied here: it's a merge-time
  // control and is enforced when the revert PR's own merge vote is
  // tallied (checkAndMerge), exactly like a forward proposal.
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  // Atomic claim — race-safe against parallel undo requests. We mark
  // the original session with revert_of_session_id = its own id as a
  // sentinel "claimed" value; the real revert session id swaps in
  // below once we have it. The WHERE NULL guarantees only one caller
  // wins this transition.
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = id
     WHERE id = $1 AND revert_of_session_id IS NULL
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Revert already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { reverted: false, inProgress: true };
  }

  // Sanity precondition: we need a merge SHA to revert. For pre-#11
  // merged rows the column is NULL because mergePR's response wasn't
  // captured at the time. GitHub still knows the SHA via pulls.get —
  // try to backfill on demand, persist for next time, and proceed.
  // Only fall through to the manual-revert message if GitHub can't
  // help either (auth disabled, repo gone, PR never actually merged,
  // etc.).
  if (!session.merge_commit_sha) {
    let backfilledSha = null;
    let backfillReason = 'unknown';
    if (!github.isEnabled()) {
      backfillReason = 'GitHub auth not configured on this deployment';
    } else if (!session.repo_url) {
      backfillReason = 'session has no repo_url';
    } else if (!session.pr_number) {
      backfillReason = 'session has no pr_number';
    } else {
      const bm = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!bm) {
        backfillReason = `unparseable repo_url ${session.repo_url}`;
      } else {
        const [, bOwner, bRepo] = bm;
        try {
          // Use octokit.request rather than octokit.rest.pulls.get —
          // @octokit/app's installation octokit is a bare @octokit/core
          // instance and does not include the rest-endpoint-methods
          // plugin, so .rest is undefined.
          const octokit = await github.getInstallationOctokit(bOwner);
          const { data: pr } = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            { owner: bOwner, repo: bRepo, pull_number: session.pr_number }
          );
          if (pr.merged && pr.merge_commit_sha) {
            await pool.query(
              `UPDATE chat_sessions SET merge_commit_sha = $2
               WHERE id = $1 AND merge_commit_sha IS NULL`,
              [session.id, pr.merge_commit_sha]
            );
            session.merge_commit_sha = pr.merge_commit_sha;
            backfilledSha = pr.merge_commit_sha;
            log.info('votes', 'Backfilled merge_commit_sha from GitHub', {
              sessionId: session.id, prNumber: session.pr_number,
              sha: pr.merge_commit_sha,
            });
          } else {
            backfillReason = pr.merged
              ? 'GitHub returned a merged PR with no merge_commit_sha'
              : 'GitHub says this PR is not merged';
          }
        } catch (err) {
          backfillReason = `GitHub lookup failed: ${err.message}`;
          log.warn('votes', 'merge_commit_sha backfill from GitHub failed', {
            sessionId: session.id, prNumber: session.pr_number, err: err.message,
          });
        }
      }
    }

    if (!backfilledSha) {
      await pool.query(
        `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
        [session.id]
      ).catch(() => {});
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `Couldn't auto-revert ${label}: ${backfillReason}. Please open the revert PR manually.`,
        'system'
      );
      return { reverted: false, error: 'no merge_commit_sha', backfillReason };
    }
  }
  if (!session.repo_url) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'no repo_url' };
  }

  const m = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'unparseable repo_url' };
  }
  const [, repoOwner, repoName] = m;

  log.info('votes', 'Opening revert PR', {
    sessionId: session.id, needed: majority, requestedBy: decider.username,
  });

  let revertInfo;
  try {
    revertInfo = await createRevertPR({
      session,
      mergeSha: session.merge_commit_sha,
      repoOwner,
      repoName,
      deciderUsername: decider.username,
    });
  } catch (err) {
    // Release the claim so a future vote can retry. Most common
    // failure here is `git revert` conflict — surface it clearly.
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    log.error('votes', 'Revert PR creation failed', { sessionId: session.id, err: err.message });
    const label = session.pr_title
      ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    await sendSystemMessage(pool, session.app_id,
      `Couldn't auto-revert ${label}: ${err.message}. ` +
      `Most likely later commits depend on it. Please open the revert PR manually.`,
      'system'
    );
    return { reverted: false, error: err.message };
  }

  // Insert the revert session row. status=promoted means it lands
  // directly in the vote panel ready for a second checkpoint vote.
  const { rows: revertRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title,
        status, revert_of_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', $7)
     RETURNING id`,
    [
      session.app_id, decider.id, revertInfo.branch,
      revertInfo.prNumber, revertInfo.prUrl, revertInfo.prTitle,
      session.id,
    ]
  );
  const revertSessionId = revertRows[0].id;
  await topicAttrs.selfAssignProposal(
    pool, session.app_id, revertSessionId, decider
  );

  // Patch the original's revert_of_session_id pointer to actually
  // point at the revert session (was set to its own id as a claim
  // sentinel above). Now `revert_of_session_id IS NOT NULL` on the
  // original correctly identifies "has a revert in flight".
  await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = $1 WHERE id = $2`,
    [revertSessionId, session.id]
  );

  // Announce in group chat so the new revert PR shows up in the vote
  // panel with context. Tag the original PR # for breadcrumbs.
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  await sendSystemMessage(pool, session.app_id,
    `${decider.username} proposed undoing ${label}. Opened revert PR #${revertInfo.prNumber}, which needs ${majority}/${activeCount} votes to land.`,
    'system'
  );

  return {
    reverted: true,
    revertSessionId,
    revertPrNumber: revertInfo.prNumber,
    revertPrUrl: revertInfo.prUrl,
  };
}

// Clone the repo to a tmpdir, branch off main, `git revert <sha>`,
// push, open a PR. Returns { branch, prNumber, prUrl, prTitle }.
// Throws on revert conflict or network errors; caller surfaces the
// failure to chat.
async function createRevertPR({ session, mergeSha, repoOwner, repoName, deciderUsername }) {
  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) throw new Error('GITHUB_BOT_TOKEN not set');

  const cloneUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const tmpDir = `/tmp/usernode-revert-${session.id}-${Date.now()}`;
  // Branch naming pattern: revert/<original-branch>-<timestamp>. The
  // timestamp suffix avoids collisions if a prior revert attempt left
  // a stale branch on the remote.
  const safeBase = (session.branch_name || `pr-${session.pr_number || session.id}`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  const revertBranch = `revert/${safeBase}-${Date.now()}`;

  try {
    // Full clone — we need history reaching back to the merge SHA, so
    // the rebuildProduction shallow-clone pattern doesn't apply here.
    await docker.execFileAsync('git', ['clone', cloneUrl, tmpDir], { timeout: 180000 });

    // Committer identity for the revert commit. Matches the
    // usernode-bot convention used elsewhere.
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'usernode-bot']);
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'usernode-bot@users.noreply.github.com']);

    // Branch off the current main. main has already been updated by
    // the original merge + any subsequent merges by the time we get
    // here, so this is the "current" main.
    await docker.execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', revertBranch], { timeout: 10000 });

    // `git revert --no-edit <sha>` — squash merges produce single-parent
    // commits, so no `-m 1` needed. If the revert conflicts (later
    // commits depend on this one), git exits non-zero and the docker
    // helper rejects.
    try {
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--no-edit', mergeSha], { timeout: 30000 });
    } catch (revertErr) {
      // Clean up the conflicted state inside the tmp dir for hygiene
      // (best-effort), then surface a tight error.
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--abort']).catch(() => {});
      const m = String(revertErr.message || '').toLowerCase();
      if (m.includes('conflict')) {
        throw new Error('Revert produced merge conflicts');
      }
      throw new Error(`git revert failed: ${revertErr.message.slice(0, 200)}`);
    }

    await docker.execFileAsync('git', ['-C', tmpDir, 'push', '-u', 'origin', revertBranch], { timeout: 60000 });

    const origLabel = session.pr_title
      ? `${session.pr_title} (PR #${session.pr_number || session.id})`
      : `PR #${session.pr_number || session.id}`;
    const prTitle = `Revert: ${session.pr_title || `PR #${session.pr_number || session.id}`}`.slice(0, 200);
    const prBody =
      `Automated revert of ${origLabel}.\n\n` +
      `Undo vote reached majority on the original PR; deciding vote cast by \`${deciderUsername}\`. ` +
      `This PR still needs a regular merge vote to land. Vote in the app's group chat panel.\n\n` +
      `Reverts commit ${mergeSha}.`;

    const prData = await github.createPR(repoOwner, repoName, {
      branch: revertBranch,
      title: prTitle,
      body: prBody,
    });

    return {
      branch: revertBranch,
      prNumber: prData.number,
      prUrl: prData.html_url,
      prTitle,
    };
  } finally {
    await docker.execFileAsync('rm', ['-rf', tmpDir]).catch(() => {});
  }
}

// checkAndMerge is exported (in addition to voteRoutes) so the
// auto-conflict-resolver can re-attempt a merge for an already-approved
// PR after it syncs cleanly with main. Consumers should lazy-require
// this module from inside a function to avoid the votes <-> conflict-
// resolver circular-require load-order trap.
// createRevertPR is exported for tests (tests/github-mention-safety.test.js
// asserts its PR body never carries a live @mention).
module.exports = {
  voteRoutes,
  checkAndMerge,
  resolveIssueBounty,
  createRevertPR,
  finalizeMerge,
  // #demo: the preview image a demo-mode merge offers its rebuild.
  demoPreviewImage,
  // Focused revision-safety tests exercise the reconciliation without
  // driving the full HTTP router.
  reconcileNativeReviewedHead,
  reconcilePromotedSweepHead,
  reviewedHeadForSession,
  voteMatchesApprovalEpoch,
  // Connector-submitted testing metadata on an import, unit-tested directly.
  parseImportTesting,
  parseImportVisualEvidence,
  prImportFailureBody,
  visualEvidenceGateForSession,
  readVisualEvidenceGate,
  // The request an imported pull request implements (#1217), likewise.
  parseImportLinkedIssues,
  MAX_IMPORT_LINKED_ISSUES,
  recordVote,
  // #1688: the line on a vote and the names at merge, unit-tested directly.
  normalizeVoteReason,
  VOTE_REASON_MAX,
  VOTE_REASON_REQUIRED,
  mergeCredits,
  creditsSentence,
  // (#1115) The applied-close demo rows live here because they belong to the
  // Completed stream, but GET /api/apps/:slug/governance/:id in issues.js has
  // to resolve them too for a ?demo=1 deep link. Exported for that handler's
  // lazy require (issues.js requires this from inside the function, matching
  // the direction this module already uses for './issues').
  stagingMockCompletedCloseIssues,
};
