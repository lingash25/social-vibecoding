const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const { sendSystemMessage, pushAppUpdate, pushIssueUpdate } = require('../services/ws');
const { getActiveUserStats } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminUpVote } = require('../services/admin-approval');
const appManifest = require('../services/app-manifest');
const appSecrets = require('../services/app-secrets');
const platformEnv = require('../services/platform-env');
const staging = require('../services/staging');
const { encrypt, decrypt } = require('../services/secrets');
const { issueKindLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const { weekStartUtc, countWeeklyBountiesUsed, WEEKLY_BOUNTY_LIMIT } = require('./kudos');
const { placeBounty } = require('../services/bounties');
const { claimIssueForUser } = require('../services/issue-claims');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const topicAttrs = require('../services/topic-attributes');
// #2086: the featured-illustration governance kind. Its proposals are
// opened by src/routes/app-illustrations.js (the bytes travel with the
// save, which the generic create route below cannot carry, so the kind is
// deliberately absent from VALID_KINDS); the apply lives here beside the
// other governance kinds so the vote, sweeper and force-apply paths share
// one gate.
const illustrationProposals = require('../services/illustration-proposals');
// #1112: the same in-process "a turn is running" predicate /api/sessions
// reports as `busy`, so an issue's work-state chip and the session card it
// points at can never disagree about whether an agent is actually running.
const { isSessionBusy } = require('../services/active-workers');
const { FEEDBACK_FALLBACK_TITLE } = require('../services/llm');

// #2089: the board search's server half. Shorter queries are not asked
// (the browser applies the same floor); the hit list is capped because the
// browser only ever intersects it with the cards it already holds.
const BOARD_SEARCH_MIN_CHARS = 2;
const BOARD_SEARCH_MAX_HITS = 200;

// Pull owner/repo out of a stored repo_url. Same shape used across the
// codebase (e.g. the rename-apply path below, routes/votes.js).
function parseOwnerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo } : null;
}

// #136: platform-filed GitHub issues are authored by the bot account, but
// the real creator is recorded in the body's first "**Source:**" line
// (written by routes/feedback.js): "usernode user (name)" for regular
// users, "usernode admin (name)" for admins (#140; older issues used a
// bare "usernode admin" with no name). Returns the creator's display name
// or null when no Source line can be parsed.
function creatorFromSourceLine(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/\*\*Source:\*\*\s*([^\n]+)/);
  if (!m) return null;
  const source = m[1].trim();
  const named = source.match(/^usernode (?:user|admin) \(([^)]+)\)/);
  if (named) return named[1];
  if (/^usernode admin\b/.test(source)) return 'admin';
  return null;
}

// Durable authorship for issue edits. Platform-created issue rows are the
// strongest record; feedback reports are the equivalent record for issues
// filed directly into GitHub by routes/feedback.js. The Source line remains
// the compatibility fallback for older reports. Keeping the feedback row in
// the check means an author who deliberately clears the whole body can still
// add a new description later.
async function isIssueAuthor(pool, appId, parsed, issueNumber, user, currentBody) {
  const { rows } = await pool.query(
    `SELECT 1 FROM issues
      WHERE app_id = $1 AND github_issue_number = $2 AND created_by = $3
     UNION ALL
     SELECT 1 FROM feedback_reports
      WHERE issue_owner = $4 AND issue_repo = $5 AND issue_number = $2 AND user_id = $3
     LIMIT 1`,
    [appId, issueNumber, user.id, parsed.owner, parsed.repo]
  );
  return rows.length > 0 || creatorFromSourceLine(currentBody) === user.username;
}

// Renames are no longer an issue kind — they open a dapp.json `name` PR
// via POST /api/apps/:slug/rename (see src/routes/apps.js). The vote-apply
// path below (maybeApplyRenameProposal) is retained only so any rename
// issues already open at rollout can still resolve.
// maintenance_campaign (#853's generalization) is self-app-only,
// admin-proposed fleet maintenance — see the create branch below and
// services/fleet-maintenance.js for the engine the apply path starts.
const VALID_KINDS = ['general', 'secret_change', 'close_issue', 'maintenance_campaign'];
const MAX_SECRET_VALUE_LENGTH = 4096;
// Campaign instructions are an LLM prompt, not an essay — but audits
// with embedded code snippets are legitimate, so the cap is generous.
const MAX_CAMPAIGN_INSTRUCTIONS_LENGTH = 20000;
const MAX_CAMPAIGN_TITLE_LENGTH = 200;
// "In progress" status windows, and what keeps a claim live.
//
// #1903: both constants and the claim-liveness predicates now live in
// services/issue-progress.js, because the Workshop's lane assignment needs
// exactly the same rules and a second copy of them is a second copy to
// drift. The bulk read below stays here: it needs per-issue DETAIL for the
// chip and already holds the thread timestamps, so calling the Set helper
// would be a redundant query on a hot path.
const {
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
  claimExpiresAt,
  claimIsLive,
} = require('../services/issue-progress');
// #2431: which proposal closed an issue, or is working on it. One query for
// the whole list, so the board pays for it once and not per card.
const { resolveIssueProposalRefs } = require('../services/issue-proposal-ref');
const MAX_CLOSE_REASON_LENGTH = 2000;
// #556: cap for author-edited issue titles (rename route below). Matches
// the feedback form's optional title input; far below GitHub's own limit.
const MAX_ISSUE_TITLE_LENGTH = 200;
// Matches the issue-draft service and feedback form. Empty is valid: GitHub
// issues may deliberately have no description, but an accidental novel must
// not ride through the app's JSON limit or make the topic unusable.
const MAX_ISSUE_BODY_LENGTH = 10000;

// #132: should this issue kind get a GitHub twin on the app's repo?
// Env-var change proposals (kind='secret_change') are in-app governance —
// they're proposed, voted, applied, and audited entirely on the platform,
// so opening a "Set secret …" issue on GitHub just pollutes the repo's
// issue list (GitHub issues are reserved for real issues). Close-issue
// proposals (kind='close_issue') target an EXISTING GitHub issue — a twin
// would be pure noise, and the target's number deliberately lives in the
// payload, not github_issue_number (see the create route). Everything
// downstream already tolerates a null github_issue_number: the apply path
// guards its close/comment on it, and the UI omits the kudos button when
// no twin exists.
// Maintenance campaigns are likewise platform governance: the per-app
// PRs the engine opens are the repo-visible artifact; a twin issue on
// the PLATFORM repo would be noise.
function shouldCreateGithubTwin(kind) {
  return kind !== 'secret_change' && kind !== 'close_issue' && kind !== 'maintenance_campaign'
    && kind !== 'featured_illustration';
}

// Staging-only mock issues for GET /api/apps/:slug/github-issues. A
// staging preview whose repo has no open issues (or can't reach GitHub
// from the preview container) would render an empty Topics feed in the
// Dev card list, making the UI impossible to review. When the live
// fetch comes back empty in staging, these are served instead — clearly
// "[Mock]"-prefixed so testers know they're synthetic. High numbers
// keep them clear of any real bounty / thread rows in the cloned DB;
// updatedAt is computed per request so the feed's activity sort places
// them naturally. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function stagingMockIssues(repoUrl) {
  const base = (repoUrl || 'https://github.com/example/app')
    .replace(/\.git$/, '').replace(/\/$/, '');
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const mk = (number, title, body, hours) => ({
    number,
    title,
    body,
    labels: ['usernode'],
    updatedAt: hoursAgo(hours),
    htmlUrl: `${base}/issues/${number}`,
    user: 'staging-tester',
  });
  return [
    mk(900001, '[Mock] Dark mode toggle resets after refresh',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Steps to reproduce:\n1. Enable dark mode in the header\n'
      + '2. Refresh the page\n3. The app is back in light mode\n\n'
      + 'Expected: the preference persists across reloads.', 2),
    mk(900002, '[Mock] Add a keyboard shortcut for voting',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Power users vote on a lot of proposals — pressing Y/N while a '
      + 'proposal card is focused should cast the vote without reaching '
      + 'for the mouse.', 9),
    mk(900003, '[Mock] Topic cards overflow on narrow phones',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'On a 360px-wide viewport the action buttons on issue cards can '
      + 'push past the card edge. They should wrap onto their own row '
      + 'instead.', 30),
    // Long-title variants (~90 and ~120 chars) for verifying the dev
    // card list's progressive title wrapping on narrow screens: the 💬
    // badge should drop to the next line first, then the bounty pill,
    // and only then should the title wrap — never an ellipsis.
    mk(900004, '[Mock] Long-title test: the settings panel re-expands '
      + 'every advanced section after navigating back to it',
      'Staging-only mock issue with a deliberately long title for '
      + 'checking that dev-card titles wrap instead of truncating on '
      + 'narrow phone screens.', 5),
    mk(900005, '[Mock] Long-title test: scrolling the leaderboard on a '
      + 'narrow phone while the keyboard is open jumps back to the top '
      + 'whenever a new kudos event arrives',
      'Staging-only mock issue with a deliberately long title (~120 '
      + 'chars) for checking that dev-card titles wrap instead of '
      + 'truncating on narrow phone screens.', 14),
    // #361: row for the headless `code` outcome — an auto-run that produced
    // a reviewable commit. Its viewer-owned clones (seeded in migrate.js)
    // demonstrate both "Changes ready" card variants (preview-OK and
    // preview-failed).
    mk(900006, '[Mock] Voting buttons need a clearer disabled state',
      'Staging-only mock issue for previewing the headless "code" outcome.\n\n'
      + 'When a proposal is closed, the Yes/No buttons stay full-colour but '
      + 'do nothing on click. They should render visibly disabled (greyed '
      + 'out, no hover) so it is obvious voting is over.', 11),
    // #287: dedicated row for reviewing the has-session button state. The
    // synthetic-myPrSessionId block below targets this number so the
    // "Create new proposal" variant of the start-work button is reviewable
    // in a staging preview.
    mk(900007, '[Mock] issue with an in-progress proposal',
      'Staging-only mock issue for previewing the "Create new proposal" '
      + 'button state. A synthetic per-viewer session is attached to this '
      + "row so the start-work button reads \"Create new proposal\" "
      + 'instead of "Create proposal" — exactly what a viewer who already '
      + 'started a dev chat on this issue would see.', 7),
    // #556: dedicated row for reviewing the author-only "edit title"
    // pencil in the topic head. The staging enrichment block in
    // GET /github-issues marks it as authored by whoever is viewing, so
    // the affordance renders for every staging tester.
    mk(900008, '[Mock] issue you authored — title is editable',
      'Staging-only mock issue for previewing the author-only title edit '
      + 'affordance (#556). Open this topic and a pencil appears next to '
      + 'the title because the row is marked as authored by you. Saving '
      + 'a new title will fail — there is no real GitHub issue behind '
      + 'this mock row — so this is purely for visual review.', 3),
    // #617: the NEWEST mock row, deliberately absent from the demo drag
    // order (stagingMockOrder in board-order.js ranks only 900002/900001).
    // With the fix, an issue filed after the last drag surfaces at the TOP
    // of the kanban Issues column, so this card must render first there.
    mk(900009, '[Mock] Newly filed issue — should render on top',
      'Staging-only mock issue for previewing the #617 fix: this row is '
      + 'the most recent and is NOT part of the saved drag order, so it '
      + 'must appear at the top of the Issues column, above the manually '
      + 'ordered cards.', 1),
    // Card-as-pointer revision: a deliberately BARE issue — no attributes,
    // no bounty, no claim, no headless run — so the "a card with no metadata
    // carries no grey Set-priority / Set-category / Unassigned chips" rule is
    // visible in a preview. Every other mock row is enriched by the
    // staging-attributes block in GET /github-issues; this number is
    // deliberately absent from that map (as is 900002, which keeps its own
    // unset-dropdown demo).
    mk(900013, '[Mock] Bare issue — no priority, no category, nobody assigned',
      'Staging-only mock issue with NO community-voted attributes, so the '
      + 'card renders with just its icon, title, meta line and one primary '
      + 'action. Compare it against #900001, which has all three chips set.', 6),
    // #683: dedicated row for reviewing the inline screenshot embed in
    // the topic view. Real filed issues embed the public
    // /issue-images/:id URL; the mock points at an existing same-origin
    // static asset so the image renders in a staging preview without an
    // issue_screenshots row (staging:private → always empty).
    mk(900010, '[Mock] issue with an attached screenshot',
      'Staging-only mock issue for previewing the #683 screenshot embed: '
      + 'the image below should render inline in the topic view, the '
      + 'same way a reporter-captured screenshot attached from the '
      + 'feedback modal does.\n\n'
      + '**Screenshot:**\n![Screenshot](/icons/icon-192.png)', 4),
    // #1010: the two targets of the applying / retry-pending mock close
    // proposals below (stagingMockGovernance 9100005 / 9100006), so the
    // ?demo=1 preview shows the governance card's spinner state AND the
    // matching "Closing…" state on the target issue's own row.
    mk(900011, '[Mock] Close vote passed — issue is being closed',
      'Staging-only mock issue for previewing the #1010 in-progress close '
      + 'indicator. A mock close proposal for this issue has passed its '
      + 'vote and its window has just elapsed, so both the governance card '
      + 'and this row render the "Closing…" spinner state.', 6),
    mk(900012, '[Mock] Close vote passed a while ago — retry pending',
      'Staging-only mock issue for previewing the #1010 stalled-apply '
      + 'state. Its mock close proposal passed long enough ago that the '
      + 'spinner has timed out, so the card reads "Close pending — will '
      + 'retry automatically" instead of spinning forever.', 8),
    // #1112: the two work-states that no other mock row can show, because
    // both need a session in a state the other rows never sit in. The
    // in-progress enrichment below attaches a 5-day-old PAUSED session to
    // this one, so the chip reads "Paused · maya-builder" in the grey tone
    // and the topic head prints the self-clear date.
    mk(900014, '[Mock] Someone started this and paused',
      'Staging-only mock issue for previewing the #1112 "Paused" work '
      + 'state. A dev session on this row was last touched five days ago '
      + 'and is paused, so the card carries the grey "Paused" chip rather '
      + 'than the old catch-all "In progress" one, and the topic head '
      + 'explains in a sentence when the mark clears itself.', 26),
    // #1112: the amber "Needs an answer" state — a headless auto-solve run
    // that finished with the `question` outcome and is waiting on a human.
    mk(900015, '[Mock] Auto-solve run asked a question',
      'Staging-only mock issue for previewing the #1112 "Needs an answer" '
      + 'work state: the synthetic headless run below reports the '
      + '`question` outcome, so the card asks for a reply instead of '
      + 'claiming that work is happening right now.', 19),
    // #1112: keep the finished-draft state on its own row. Reusing 900005
    // made the check depend on older staging fixtures that already use that
    // number for the failed-run demo, so the synthetic state could be
    // shadowed by seed history instead of rendering `draft_ready`.
    mk(900016, '[Mock] Auto-solve draft ready to review',
      'Staging-only mock issue for previewing the #1112 "Draft ready to '
      + 'review" work state. Its synthetic headless run finished with a '
      + 'draft, and no other staging fixture shares this issue number.', 17),
    // #1251: the row that makes the fix reviewable. Mock proposal 9000013
    // declares this number in linked_issues and NOTHING else touches it —
    // no session, no claim, no synthetic headless state — so before the fix
    // it appeared in the list feed and in no kanban column at all, and
    // after it sits in In progress alongside its proposal in In review.
    // Every other mock issue is already in-progress for some other reason,
    // which is why this needs a number of its own.
    mk(900017, '[Mock] Issue with an open proposal against it',
      'Staging-only mock issue for previewing #1251: an issue whose work '
      + 'is already up for a vote. It must appear on the kanban board (In '
      + 'progress) as well as in the list view — the proposal card in In '
      + 'review is not the only place it exists.', 8),
  ];
}

// Staging-only mock GOVERNANCE proposals (DB-issue shaped) for the
// Proposals-tab vote panel, so the dynamic threshold + visibility-window
// countdown is exercisable on a prod-cloned staging DB via ?demo=1. Distinct
// from stagingMockIssues above (which mocks external GitHub issues). Each row
// carries precomputed gate fields because mocks bypass the live computation.
function stagingMockGovernance() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const secsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
  const mk = (id, kind, title, payload, hours, up, down, gate = {}) => ({
    id,
    app_id: 0,
    kind,
    title,
    description: 'Staging demo governance proposal (?demo=1).',
    status: 'open',
    payload,
    created_by: 0,
    created_by_username: 'staging-tester',
    created_at: hoursAgo(hours),
    up_count: up,
    down_count: down,
    my_vote: null,
    chat_count: 0,
    last_message_at: null,
    votes_required: gate.required ?? Math.max(up, 1),
    merge_window_ends_at: gate.windowEndsAt ?? null,
    contested: gate.contested ?? false,
    // Request-time staging fixture marker. The client uses this only to
    // keep the synthetic apply-state examples visible even when the cloned
    // self-app is locked; real governance rows never carry it.
    demo: true,
  });
  return [
    // Unopposed rename, threshold met, window still running → countdown.
    mk(9100001, 'rename', '[Mock] Rename app to "Staging Demo App"',
      { newName: 'Staging Demo App' }, 6, 2, 0,
      { required: 2, windowEndsAt: hoursAhead(36) }),
    // #2086: an open featured-illustration proposal, so the card's preview
    // (proposed image beside the current one) is reviewable via ?demo=1 on
    // an empty staging DB. The image is a shipped static asset rather than
    // an app-illustrations id, which the empty DB could not serve.
    mk(9100008, 'featured_illustration', '[Mock] Change the featured illustration',
      {
        proposed: { url: '/icons/icon-512.png', darkUrl: null, zoom: 1.2, x: 10, y: -5, tint: 'teal' },
        current: { url: '/icons/icon-192.png', darkUrl: null, zoom: 1, x: 0, y: 0 },
        remove: false,
      }, 5, 1, 0,
      { required: 2, windowEndsAt: hoursAhead(30) }),
    // Contested secret change (down >= 1/3) → no countdown, full count gate.
    mk(9100002, 'secret_change', '[Mock] Set FEATURE_FLAG to "on"',
      { key: 'FEATURE_FLAG', action: 'set', hasValue: true }, 8, 4, 3,
      { required: 6, windowEndsAt: null, contested: true }),
    // Close-issue proposal targeting mock issue 900001 (served by
    // stagingMockIssues above), so the ?demo=1 preview shows the new
    // governance card AND the target issue row's disabled "Close
    // proposed" button state.
    mk(9100003, 'close_issue',
      '[Mock] Close issue #900001: "Dark mode toggle resets after refresh"',
      {
        issueNumber: 900001,
        issueTitle: 'Dark mode toggle resets after refresh',
        reason: 'Obsolete since the theme rework.',
      }, 4, 1, 0,
      { required: 2, windowEndsAt: hoursAhead(40) }),
    // #695: an invited-approver governance row with a non-approver
    // surplus — the approver-only pill + "+2 advisory" chip and the
    // "Yes (0✓ +2)" button labels are reviewable via ?demo=1.
    {
      ...mk(9100004, 'secret_change',
        '[Mock] Approver-mode test: set DEMO_FLAG (non-approver votes are advisory)',
        { key: 'DEMO_FLAG', action: 'set', hasValue: true }, 3, 2, 0,
        { required: 1 }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // #1010: the two DERIVED "being applied" states. Both have passed their
    // gate (up_count >= required, uncontested) with the visibility window
    // already elapsed — the shape a proposal has in the seconds between the
    // deciding vote and the apply landing. They differ only in HOW LONG ago
    // the window ended, which is what selects the state:
    //   9100005 — 30s ago  → inside the 120s grace → spinner, "Closing issue #900011…"
    //   9100006 — 10m ago  → past the grace        → "Close pending — will retry automatically"
    mk(9100005, 'close_issue',
      '[Mock] Close issue #900011: "Close vote passed — issue is being closed"',
      {
        issueNumber: 900011,
        issueTitle: 'Close vote passed — issue is being closed',
        reason: 'Fixed by the theme rework — closing.',
      }, 5, 2, 0,
      { required: 2, windowEndsAt: secsAgo(30) }),
    mk(9100006, 'close_issue',
      '[Mock] Close issue #900012: "Close vote passed a while ago — retry pending"',
      {
        issueNumber: 900012,
        issueTitle: 'Close vote passed a while ago — retry pending',
        reason: 'Duplicate of an older report.',
      }, 7, 2, 0,
      { required: 2, windowEndsAt: secsAgo(600) }),
    // Card-as-pointer revision: a SETTLED governance row. The vote is
    // history, so it renders the frozen pill and — with nothing left to
    // demote — no ⋯ trigger at all. Every other mock here is 'open', so
    // without this row the "no dead ⋯ button" rule is invisible in a
    // preview. (The Done column's own applied close-issue cards come from
    // stagingMockCompletedCloseIssues in votes.js; this one exercises the
    // gov card renderer's settled branch in the In-review column's shape.)
    {
      ...mk(9100007, 'close_issue',
        '[Mock] Settled: closed issue #900003 by vote — pill only, no ⋯',
        {
          issueNumber: 900003,
          issueTitle: '[Mock] Topic cards overflow on narrow phones',
          reason: 'Fixed by the responsive rework.',
          appliedAt: hoursAgo(2),
          appliedBy: 'group-vote',
          required: 2,
        }, 20, 2, 0, { required: 2 }),
      status: 'closed',
    },
  ];
}

// #396: staging-only mock comment threads for the topic view's GitHub
// comment section, served by GET /api/apps/:slug/github-issues/:number/
// comments when the live fetch is empty/unavailable. Obviously-fake
// "[Mock]" bodies, oldest-first (the same order fetchIssueComments
// returns), and at least one BOT-authored comment (`usernode-bot`) so the
// bot-labelling renders. Strictly a no-op in production.
//
// EVERY issue number gets a thread, not just the three mock ones. It used
// to be a lookup table keyed by stagingMockIssues' own 900001-900003, and
// `[]` for anything else — which meant the fallback both callers describe
// as "so the section is reviewable" did nothing for a REAL issue. That is
// the common case on a prod-cloned staging preview: the board's freshly
// triaged requests carry no replies yet, their live thread comes back
// empty, and the substitution had no row to make. Every feed slot rendered
// blank, and the declared check that asserts a rendered relative age
// (#1585) had nothing to find — it failed on every proposal, against code
// none of them had touched.
//
// The generic thread is deterministic in the issue number, so a preview and
// a declared check see the same two rows on every run; only the ages are
// clock-relative, which is the thing those rows exist to exercise.

// #2603: the voters behind a mock governance row's tally, so a ?demo=1 deep
// link into a close proposal shows the same roster — names and lines — a real
// one does. Obviously synthetic names; the counts are the row's own, so the
// roster can never disagree with the tally the card drew.
function stagingMockGovernanceVotes(id) {
  const row = stagingMockGovernance().find((m) => m.id === id);
  if (!row) return [];
  const LINES = {
    up: ['Checked it myself, nothing left to fix.', 'Happy for this one to go.'],
    down: ['It still happens on my phone.', 'I would rather leave this one open a while.'],
  };
  const out = [];
  const add = (vote, n) => {
    for (let i = 0; i < n; i += 1) {
      out.push({
        vote,
        username: `staging-voter-${vote}-${i + 1}`,
        // A No always carries its line; a Yes may go without one, and the
        // later mock voters do, so both readings are reviewable.
        reason: (vote === 'down' || i === 0) ? LINES[vote][i % LINES[vote].length] : null,
      });
    }
  };
  add('up', parseInt(row.up_count, 10) || 0);
  add('down', parseInt(row.down_count, 10) || 0);
  return out;
}

// Is `number` one of stagingMockIssues' own rows? The repo URL only shapes
// each row's htmlUrl, so any base answers the membership question.
function isStagingMockIssueNumber(number) {
  const n = Number(number);
  return stagingMockIssues('https://github.com/example/app').some((i) => i.number === n);
}

function stagingMockIssueComments(number) {
  const n = Number(number);
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const daysAgo = (d) => hoursAgo(d * 24);
  // #1808: every thread opens with three rows whose stamps land in the three
  // branches the comment thread formats. An earlier year (fixed, so that
  // branch is reachable for as long as this fixture lives), earlier this
  // year, and inside the last few days. Before the fix all three read as a
  // bare time of day, so the ladder is what makes the change reviewable:
  // read down a thread and the stamps have to answer "when".
  const stampLadder = () => ([
    {
      author: 'staging-tester',
      body: '[Mock] Filing this from an earlier year, so the stamp on it has to carry one.',
      createdAt: '2024-03-05T09:15:00Z',
    },
    {
      author: 'usernode-bot',
      body: '[Mock] Picked this up about six weeks ago, far enough back that the day matters more than the hour.',
      createdAt: daysAgo(40),
    },
    {
      author: 'another-tester',
      body: '[Mock] And a reply from a few days ago, for the middle of the range.',
      createdAt: daysAgo(3),
    },
  ]);
  // #2556: one deliberately LONG reply per thread, so the "Show more" a
  // comment grows past four lines actually has something to hide in a
  // preview. Staging only, like every row in this function, and marked
  // "[Mock]" like every row in this function. It is last in each thread on
  // purpose: the Workshop's inline slot renders only the last two comments,
  // so a long row further up would be invisible on the surface that most
  // needed the clamp.
  const longReply = () => ({
    author: 'staging-tester',
    body: '[Mock] Writing this one out at length on purpose, because a short '
      + 'reply cannot show what a long one does to a card. Steps to reproduce: '
      + 'open the board on a narrow window, scroll to any row that has a '
      + 'conversation under it, and watch the row below it get pushed off the '
      + 'bottom of the screen by a single pasted stack trace. It happens on '
      + 'the topic page too, where three replies of this size turn the '
      + 'discussion into a page of scrolling before you reach the box to '
      + 'answer in. What I expected was the first few lines and a way to ask '
      + 'for the rest, the way the app list already offers one. What I got '
      + 'was the whole thing, every time, on every surface that renders a '
      + 'comment. Adding a few more sentences here so this stays longer than '
      + 'four lines at a desktop width as well as on a phone, since that is '
      + 'the case the control has to be measured against.',
    createdAt: hoursAgo(1),
  });
  const threads = {
    900001: [
      ...stampLadder(),
      { author: 'staging-tester', body: '[Mock] I can reproduce this every time on Firefox — the toggle flips back to light as soon as I reload.', createdAt: hoursAgo(40) },
      { author: 'usernode-bot', body: '[Mock] Thanks for the report. Is the preference meant to persist per-device or per-account? Defaulting to per-device unless you say otherwise.', createdAt: hoursAgo(36) },
      { author: 'staging-tester', body: '[Mock] Per-device is fine — just make it survive a refresh.', createdAt: hoursAgo(30) },
      longReply(),
    ],
    900002: [
      ...stampLadder(),
      { author: 'another-tester', body: '[Mock] +1, Y/N shortcuts would be a huge time-saver during a voting spree.', createdAt: hoursAgo(20) },
      { author: 'usernode-bot', body: '[Mock] Should the shortcut act on the focused card only, or the top card in the list? Going with the focused card.', createdAt: hoursAgo(18) },
      longReply(),
    ],
    900003: [
      ...stampLadder(),
      { author: 'staging-tester', body: '[Mock] Happens on my iPhone SE in portrait — the Vote and Preview buttons spill off the right edge.', createdAt: hoursAgo(28) },
      longReply(),
    ],
  };
  if (threads[n]) return threads[n];
  // A number that is not an issue at all (an unparseable :number reaches
  // the first caller before Number.isFinite is consulted) gets nothing.
  if (!Number.isFinite(n) || n <= 0) return [];
  return [
    ...stampLadder(),
    {
      author: 'staging-tester',
      body: `[Mock] Staging stand-in for issue #${n}: the live thread came back `
        + 'empty or unreachable from this preview container, so this is what the '
        + 'comment section renders instead.',
      createdAt: hoursAgo(26),
    },
    {
      author: 'usernode-bot',
      body: '[Mock] Replies you see here are fixtures, not the real thread. '
        + 'Staging only, and never served in production.',
      createdAt: hoursAgo(5),
    },
    longReply(),
  ];
}

// Pick the "In progress" chip's link destination from an issue's live
// linked sessions, per viewer. Priority: a promoted/merging session (the
// proposal — group-visible to everyone) > the viewer's own session (their
// dev chat) > a shared session (its public discussion). Other users'
// PRIVATE sessions yield no target — by current semantics they appear on
// no group surface, so the chip stays informational for those viewers.
// Ties within a class break to the most recently active session.
function pickInProgressTarget(sessions, viewerId) {
  const ts = (s) => {
    const t = Date.parse(s.last_activity_at || s.created_at || '');
    return Number.isFinite(t) ? t : 0;
  };
  const newest = (pred) => {
    let best = null;
    for (const s of sessions) {
      if (!pred(s)) continue;
      if (!best || ts(s) > ts(best)) best = s;
    }
    return best;
  };
  const proposal = newest((s) => s.status === 'promoted' || s.status === 'merging');
  if (proposal) return { kind: 'proposal', sessionId: proposal.id };
  const own = newest((s) => viewerId != null && s.user_id === viewerId);
  if (own) return { kind: 'session-own', sessionId: own.id };
  const shared = newest((s) => !!s.shared_at);
  if (shared) return { kind: 'session-shared', sessionId: shared.id };
  return null;
}

// Compose one issue's `in_progress` field from its live linked sessions
// and live claims (already expiry-filtered). Returns null when neither
// exists — the FE treats null as "no chip" (headless runs contribute via
// the separate issue.headless enrichment, ORed client-side).
function composeInProgress(sessions, claims, viewerId) {
  const sess = sessions || [];
  const live = claims || [];
  if (!sess.length && !live.length) return null;
  // Distinct session owners, in the order the query returned them. The
  // loop visits every session (#1112 — it used to `break` at 3, which is
  // how a five-person issue read "In progress · 3"); only the DISPLAY
  // list is capped, and the true headcount rides on peopleTotal below.
  const allUsers = [];
  for (const s of sess) {
    if (s.username && !allUsers.includes(s.username)) allUsers.push(s.username);
  }
  const users = allUsers.slice(0, 5);
  // #1112: the true distinct headcount over every session owner AND every
  // claimer, computed before any cap. The FE's "+N" suffix reads this, so
  // the chip can no longer understate a crowded issue.
  const everyone = new Set(allUsers);
  for (const c of live) if (c.username) everyone.add(c.username);
  // #1112: per-session detail so the FE can name WHICH work state an issue
  // is in (a proposal up for vote / a live chat / a paused chat) instead of
  // collapsing all of them into one "In progress" label. Most-recent
  // activity first, capped at 5 — the label names at most a couple, and the
  // tooltip enumerates roles rather than every row.
  const activityTs = (s) => {
    const t = Date.parse(s.last_activity_at || s.created_at || '');
    return Number.isFinite(t) ? t : 0;
  };
  const detail = [...sess]
    .sort((a, b) => activityTs(b) - activityTs(a))
    .slice(0, 5)
    .map((s) => ({
      sessionId: s.id,
      username: s.username || null,
      mine: s.user_id === viewerId,
      status: s.status || null,
      // In-process only: a multi-process platform would under-report this,
      // in which case switch to `active_turn IS NOT NULL` on the query.
      busy: isSessionBusy(s.id),
      lastActivityAt: s.last_activity_at || null,
    }));
  return {
    count: sess.length,
    users,
    peopleTotal: everyone.size,
    sessions: detail,
    mine: sess.some((s) => s.user_id === viewerId) || live.some((c) => c.user_id === viewerId),
    // Oldest-first, capped at 10 — beyond that only the names matter less
    // than the count, which the FE derives from the list it gets.
    claims: live.slice(0, 10).map((c) => ({
      username: c.username,
      // userId rides along solely for the admin per-claim clear control
      // (DELETE /claim with a userId body) — not sensitive, ids are used
      // in URLs/payloads platform-wide.
      userId: c.user_id,
      mine: c.user_id === viewerId,
      claimedAt: c.claimed_at,
      expiresAt: c.expires_at,
    })),
    target: pickInProgressTarget(sess, viewerId),
  };
}

function issueRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for issue-id-addressed routes (/vote,
  // /close): collab-level access via the issue's app, 404 on deny.
  router.use('/api/issues/:id', appAccess.issueCollabGuard(pool));

  // List issues for an app. View-level (#621): read-only viewers see
  // the issue board; creating/voting stays collab-gated.
  router.get('/api/apps/:slug/issues', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const appId = gatedApp.id;

      const { rows } = await pool.query(
        `SELECT i.*, u.username as created_by_username,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up') as up_count,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'down') as down_count,
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $2) as my_vote,
           -- #194: governance-thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. chat_count counts human messages only
           -- (msg_type='message') so vote/lifecycle system rows don't
           -- inflate the 💬 badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) as last_message_at
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
         WHERE i.app_id = $1 AND i.status = 'open'
         ORDER BY (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up') DESC, i.created_at DESC`,
        [appId, req.user.id]
      );

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appId);

      // #646: governance-aware per-row gate (mirrors /promoted). Under
      // the default settings this is the old mergeGate over the raw
      // tallies; under 'invited' only approver votes qualify (batched in
      // one query); under at-least-N the gate is the clock-free count.
      const governanceSvc = require('../services/governance');
      const gov = await governanceSvc.getGovernance(pool, appId);
      const electorate = await governanceSvc.getElectorate(pool, appId, gov);
      const qualifiedByRow = electorate.approverIds
        ? await governanceSvc.qualifiedCountsBatch(
          pool, 'issue', rows.map((r) => r.id), electorate.approverIds
        )
        : null;

      // Strip ciphertext from secret_change rows before serializing —
      // the value should never be readable from this endpoint, even
      // by other admins. The committed value lands in app_secrets via
      // maybeApplySecretChangeProposal once the vote passes.
      // Also attach the per-row dynamic merge gate (eased threshold +
      // visibility window) anchored on the issue's created_at, mirroring
      // the PR /promoted endpoint so governance pills get the same
      // countdown/Contested treatment.
      const sanitized = rows.map((r) => {
        const q = qualifiedByRow
          ? (qualifiedByRow.get(r.id) || { yes: 0, no: 0 })
          : { yes: r.up_count, no: r.down_count };
        const gate = governanceSvc.computeGate(gov, electorate.active, q.yes, q.no, r.created_at);
        const withGate = {
          ...r,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        };
        if (withGate.kind !== 'secret_change' || !withGate.payload) return withGate;
        const { valueEnc, ...rest } = withGate.payload;
        return { ...withGate, payload: { ...rest, hasValue: !!valueEnc } };
      });

      // Staging-only demo mode (?demo=1): append mock governance proposals
      // spanning the gate regimes (countdown + contested). No-op in prod.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(sanitized.map((r) => r.id));
        sanitized.push(...stagingMockGovernance().filter((m) => !have.has(m.id)));
      }

      res.json({ issues: sanitized, activeUsers, majority });
    } catch (err) {
      log.error('issues', 'Failed to list issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // (#1115) Single-governance-proposal-by-id fetch — the recovery path for
  // opening a governance proposal whose row isn't in the client's cached
  // lists, and the exact twin of GET /api/apps/:slug/proposals/:id in
  // votes.js. The list endpoint above returns OPEN rows only, and APPLIED
  // close-issue proposals live in the keyset-paginated Completed stream
  // (/merged), of which the client caches just the first page — so clicking
  // or deep-linking a settled close proposal beyond that page resolved to
  // nothing and bounced back to the dev board. The FE
  // (_fetchGovProposalById) calls this when _findTopicItem() comes up empty.
  //
  // Serves rows of ANY status (a status transition between list-render and
  // click still resolves), restricted to the four governance kinds the
  // client's gov topic view can actually render — anything else 404s, so
  // this never becomes a read path for other issue kinds' payloads.
  router.get('/api/apps/:slug/governance/:id', async (req, res) => {
    try {
      // View-level (#621): read-only viewers can open a governance
      // proposal's topic view (my_vote resolves to null for them).
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const appId = gatedApp.id;
      const userId = req.user?.id || null;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      // Same row shape the list endpoints return (the open-issues subqueries
      // above and the close-row select in /merged), so the topic header/card
      // renders identically whether the row came from a list or from here.
      const { rows } = await pool.query(
        `SELECT i.*, u.username as created_by_username,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up') as up_count,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'down') as down_count,
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $3) as my_vote,
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) as last_message_at
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
         WHERE i.app_id = $1 AND i.id = $2
           AND i.kind IN ('secret_change', 'rename', 'close_issue', 'maintenance_campaign',
                          'featured_illustration')
         LIMIT 1`,
        [appId, id, userId]
      );

      let proposal = rows[0] || null;
      if (proposal) {
        // Same per-row dynamic gate the list attaches, so an OPEN row's pill
        // gets its threshold / countdown / Contested treatment here too.
        // Settled rows carry it harmlessly (the card reads the frozen pill).
        const governanceSvc = require('../services/governance');
        const gov = await governanceSvc.getGovernance(pool, appId);
        const electorate = await governanceSvc.getElectorate(pool, appId, gov);
        const q = electorate.approverIds
          ? ((await governanceSvc.qualifiedCountsBatch(
            pool, 'issue', [proposal.id], electorate.approverIds
          )).get(proposal.id) || { yes: 0, no: 0 })
          : { yes: proposal.up_count, no: proposal.down_count };
        const gate = governanceSvc.computeGate(
          gov, electorate.active, q.yes, q.no, proposal.created_at
        );
        proposal = {
          ...proposal,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        };
        // Never leak a secret_change's ciphertext, exactly as the list does.
        if (proposal.kind === 'secret_change' && proposal.payload) {
          const { valueEnc, ...rest } = proposal.payload;
          proposal.payload = { ...rest, hasValue: !!valueEnc };
        }
        // An applied close proposal is a Completed-stream row; stamp the
        // discriminator so it's interchangeable with the /merged shape for
        // any consumer that branches on row_type (e.g. _showExplorePill).
        if (proposal.kind === 'close_issue' && proposal.status === 'closed'
            && proposal.payload && proposal.payload.appliedAt) {
          proposal.row_type = 'close_issue';
          // /merged also attaches the closed issue's priority/assignee/
          // category tally to these rows (a task moved to Done keeps its
          // chips); mirror it here so the by-id recovery path stays
          // shape-interchangeable with the stream.
          const closedRef = parseInt(proposal.payload.issueNumber, 10);
          if (Number.isInteger(closedRef) && closedRef > 0) {
            const closedAttrs = await topicAttrs.summarizeForTargets(
              pool, appId, 'issue', [closedRef], userId
            );
            const s = closedAttrs.get(closedRef) || topicAttrs.emptySummary();
            proposal.priority = s.priority;
            proposal.assignee = s.assignee;
            proposal.category = s.category;
          }
        }
      }

      // Staging demo mode (?demo=1): the mock governance rows aren't in the
      // DB, so resolve a mock id straight from the generators. This is what
      // lets a staging tester deep-link mock close proposal 9100062, which is
      // deliberately too old to ever reach the demo Completed stream's first
      // page and is therefore reachable ONLY through this endpoint. The
      // applied-close mocks live in votes.js (they belong to that stream);
      // lazy-required here to keep the issues <-> votes load order safe.
      if (!proposal && IS_STAGING && req.query.demo === '1') {
        proposal = stagingMockGovernance().find((m) => m.id === id)
          || require('./votes').stagingMockCompletedCloseIssues()
            .find((m) => m.id === id)
          || null;
      }

      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      res.json({ proposal });
    } catch (err) {
      log.error('issues', 'Failed to get governance proposal by id', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2603: who voted which way on a governance proposal, and the line each
  // vote carries — the issue-side mirror of GET /api/sessions/:id/votes, and
  // the source the close-issue card's roster reads. View-level like the by-id
  // handler above it, and keyed by slug for the same reason: a ?demo=1 mock
  // id is not a row, so it never reaches the id-addressed collab guard.
  router.get('/api/apps/:slug/governance/:id/votes', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      const { rows } = await pool.query(
        `SELECT iv.vote, iv.reason, u.username
           FROM issue_votes iv
           JOIN users u ON u.id = iv.user_id
           JOIN issues i ON i.id = iv.issue_id
          WHERE iv.issue_id = $1 AND i.app_id = $2
          ORDER BY iv.created_at ASC, iv.id ASC`,
        [id, gatedApp.id]
      );

      // The mock governance rows aren't in the DB, so a ?demo=1 deep link
      // reads its roster from the same generators the card came from.
      const votes = (!rows.length && IS_STAGING && req.query.demo === '1')
        ? stagingMockGovernanceVotes(id)
        : rows;

      // 'up'/'down' is the issue vocabulary; 'yes'/'no' is what a roster
      // says, and what the shared roster component renders.
      res.json({
        yes: votes.filter((r) => r.vote === 'up').map((r) => r.username),
        no: votes.filter((r) => r.vote === 'down').map((r) => r.username),
        reasons: votes.filter((r) => r.reason).map((r) => ({
          username: r.username,
          vote: r.vote === 'down' ? 'no' : 'yes',
          reason: r.reason,
        })),
      });
    } catch (err) {
      log.error('issues', 'Failed to list governance votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create an issue / proposal — kinds per VALID_KINDS above (general is
  // the default). Rate-limited per kind: close_issue proposals draw from
  // their own bucket, everything else from issue-create.
  router.post('/api/apps/:slug/issues', issueKindLimiter, async (req, res) => {
    let { title, description, kind = 'general', payload = {} } = req.body || {};

    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Invalid kind; must be one of ${VALID_KINDS.join(', ')}` });
    }

    // api:access is intentionally not a credential-management capability.
    // This route multiplexes ordinary issues and secret-change proposals, so
    // the path policy alone cannot distinguish them. Enforce the boundary at
    // the kind dispatch before reading, validating, or encrypting a value.
    if (req.cliAuthenticated && kind === 'secret_change') {
      return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Kind-specific validation + auto-filled title/description.
      if (kind === 'secret_change') {
        const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
        const action = typeof payload?.action === 'string' ? payload.action : 'set';
        // Trimmed HERE, at proposal creation, not at apply. The apply path
        // for a child app writes app_secrets with raw SQL (see
        // maybeApplySecretChangeProposal below) and never reaches
        // appSecrets.setValue, so creation is the only boundary that covers
        // both stores — and normalizing before encrypt/valueLast4 keeps the
        // proposal card's preview identical to what will actually be stored.
        // Both DAOs implement the identical rule, so either normalizeValue
        // serves both scopes.
        const value = platformEnv.normalizeValue(
          typeof payload?.value === 'string' ? payload.value : ''
        );
        if (!appManifest.KEY_RE.test(key)) {
          return res.status(400).json({ error: 'payload.key must be UPPER_SNAKE_CASE' });
        }
        if (appManifest.RESERVED_KEYS.has(key)) {
          return res.status(400).json({ error: `${key} is reserved by the platform` });
        }
        // The self-hosted app's proposals write platform_env_values, so the
        // key has to clear the same bar a direct admin write does: no
        // credential and no deploy-owned key, ever. Refusing at CREATION
        // (rather than at apply) matters \u2014 a vote that can only ever be
        // refused is worse than no vote, and "let's rotate JWT_SECRET by
        // majority" must never appear on the proposals list at all.
        if (app.self_hosted && !platformEnv.isWritableKey(key)) {
          return res.status(400).json({
            error: 'This variable is set by the deploy from a GitHub secret and cannot be edited here.',
          });
        }
        if (!['set', 'delete'].includes(action)) {
          return res.status(400).json({ error: 'payload.action must be "set" or "delete"' });
        }
        if (action === 'set' && (!value.length || value.length > MAX_SECRET_VALUE_LENGTH)) {
          return res.status(400).json({
            error: `payload.value is required and must be \u2264 ${MAX_SECRET_VALUE_LENGTH} chars`,
          });
        }
        // Representability, same rule and same message the panel's direct
        // write uses: a value carrying a single quote or a bare CR cannot
        // survive being written into the platform's .env, so it is rejected
        // now rather than accepted and silently dropped by a deploy days
        // later. (MAX_SECRET_VALUE_LENGTH above is the tighter of the two
        // length caps, so the DAO's 8192 never binds on this path.)
        if (app.self_hosted && action === 'set') {
          const unrepresentable = platformEnv.validateValue(value);
          if (unrepresentable) return res.status(400).json({ error: unrepresentable });
        }

        const manifest = (app.manifest_snapshot && typeof app.manifest_snapshot === 'object')
          ? app.manifest_snapshot : { secrets: [] };
        // Which block declares this key depends on which store the apply
        // will write. For the platform that's `platform_env`; reading
        // `secrets` there would classify a private tunable as public and
        // capture its last-4 into the proposal payload.
        const declared = app.self_hosted
          ? (manifest.platform_env || []).find((s) => s.key === key)
          : (manifest.secrets || []).find((s) => s.key === key);
        // `private` is canonical; manifest.read() also accepts the
        // legacy `sensitive` alias and normalizes to `.private`.
        //
        // An UNDECLARED key on the platform defaults to private, matching
        // platform-env.setValue(): the safe default for a variable nothing
        // has declared yet is "don't display it".
        const isPrivate = app.self_hosted
          ? (declared ? !!declared.private : true)
          : !!declared?.private;

        // Encrypt the proposed value before it ever lands in the DB.
        // Even other admins reading the issues table see only ciphertext;
        // the GET /api/apps/:slug/issues route strips it from the
        // payload before serializing (see further below).
        const valueEnc = action === 'set' ? encrypt(value, config.dataEncryptionKey) : null;
        const valueLast4 = action === 'set' && !isPrivate
          ? value.slice(-4) : null;

        // Persist BOTH `private` (canonical) and `sensitive` (BC) on the
        // issue payload so any in-flight issue serialized by an older
        // build keeps deserializing cleanly when the votes complete.
        payload = { key, action, valueEnc, valueLast4, private: isPrivate, sensitive: isPrivate };
        title = action === 'delete'
          ? `Remove secret "${key}"`
          : `Set secret "${key}"`;
        // The platform's own variables reach the process through the next
        // DEPLOY, not through a rebuild of a container — so don't promise a
        // redeploy the apply path deliberately never performs.
        description = description?.trim() ||
          `${req.user.username} (via Homeroom) proposed ${
            action === 'delete' ? 'removing' : 'setting'
          } the env var "${key}". ${app.self_hosted
            ? 'Auto-applies when a majority of active users vote up; the value reaches the platform on its next deploy.'
            : 'Auto-applies + redeploys when a majority of active users vote up.'}`;
      } else if (kind === 'close_issue') {
        const issueNumber = Number(payload?.issueNumber);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          return res.status(400).json({ error: 'payload.issueNumber must be a positive integer' });
        }
        const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
        if (reason.length > MAX_CLOSE_REASON_LENGTH) {
          return res.status(400).json({
            error: `payload.reason must be ≤ ${MAX_CLOSE_REASON_LENGTH} chars`,
          });
        }

        // Verify the target is a CURRENTLY OPEN GitHub issue on this repo
        // before creating the proposal — same policy as the bounty route:
        // fetchPublicIssues never throws; a degraded fetch (note) means no
        // positive confirmation, so refuse and change nothing.
        const parsed = parseOwnerRepo(app.repo_url);
        if (!github.isEnabled() || !parsed) {
          return res.status(422).json({
            error: 'Cannot verify the issue right now: GitHub is unavailable for this app.',
          });
        }
        const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
        if (ghResult.note) {
          return res.status(422).json({
            error: "Couldn't confirm this issue is open right now. Try again in a moment.",
          });
        }
        const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
        if (!target) {
          return res.status(404).json({
            error: `Issue #${issueNumber} isn't an open issue on this repo.`,
          });
        }

        // Dedupe: one open close proposal per issue per app. The UI also
        // disables the button, but two clients can race — refuse here.
        const { rows: dupRows } = await pool.query(
          `SELECT id FROM issues
            WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
              AND (payload->>'issueNumber')::int = $2`,
          [app.id, issueNumber]
        );
        if (dupRows.length) {
          return res.status(409).json({
            error: `A close proposal for issue #${issueNumber} is already open`,
          });
        }

        // The target's number lives ONLY in the payload — never in
        // github_issue_number, which means "this proposal's GitHub twin"
        // and would make the withdraw route close the target issue.
        const issueTitle = String(target.title || '').slice(0, 300);
        payload = { issueNumber, issueTitle, reason: reason || null };
        title = `Close issue #${issueNumber}: "${issueTitle}"`.slice(0, 512);
        description = reason || null;
      } else if (kind === 'maintenance_campaign') {
        // Fleet maintenance (#853): only proposable on the self-hosted
        // platform app (the campaign's blast radius is EVERY child app,
        // so the vote belongs to the platform's own governance surface),
        // and only by users who could force the result anyway — the
        // campaign instructions are executed by an AI with write access
        // to every app repo, so authorship is admin-gated even though
        // approval still goes through the community vote.
        if (!app.self_hosted) {
          return res.status(400).json({
            error: 'Maintenance campaigns can only be proposed on the platform app',
          });
        }
        if (!req.user?.canAdminWrite) {
          return res.status(403).json({ error: 'Full admin access required' });
        }
        if (!github.isEnabled()) {
          return res.status(422).json({ error: 'GitHub is not configured, so campaigns cannot run' });
        }
        const campaignTitle = typeof title === 'string' ? title.trim() : '';
        const instructions = typeof payload?.instructions === 'string' ? payload.instructions.trim() : '';
        if (!campaignTitle || campaignTitle.length > MAX_CAMPAIGN_TITLE_LENGTH) {
          return res.status(400).json({
            error: `Title is required and must be ≤ ${MAX_CAMPAIGN_TITLE_LENGTH} chars`,
          });
        }
        if (!instructions || instructions.length > MAX_CAMPAIGN_INSTRUCTIONS_LENGTH) {
          return res.status(400).json({
            error: `payload.instructions is required and must be ≤ ${MAX_CAMPAIGN_INSTRUCTIONS_LENGTH} chars`,
          });
        }
        // Optional slug allowlist; anything else in the payload is dropped.
        const targetFilter = Array.isArray(payload?.targetFilter)
          ? payload.targetFilter.map((s) => String(s).trim()).filter(Boolean).slice(0, 500)
          : null;
        // payload.title is the RAW campaign title (it becomes the per-app
        // PR title); issues.title carries the display prefix.
        payload = {
          title: campaignTitle,
          instructions,
          ...(targetFilter && targetFilter.length ? { targetFilter } : {}),
        };
        title = `Maintenance campaign: ${campaignTitle}`.slice(0, 512);
        description = description?.trim()
          || `${req.user.username} proposed a platform-wide maintenance campaign. If approved, `
          + 'an AI will apply the campaign instructions to '
          + (targetFilter && targetFilter.length ? `${targetFilter.length} selected app(s)` : 'every app')
          + ', opening one PR per app for its community to review and merge.';
      } else {
        if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
        title = title.trim();
        description = description || null;
        payload = typeof payload === 'object' && payload ? payload : {};
      }

      // GitHub twin — skipped only for platform-governance kinds. A general
      // issue is represented by its GitHub issue throughout the board, so
      // never claim success by inserting a local-only row the UI cannot
      // render. Configuration and upstream failures return before any local
      // issue/chat state is written.
      let githubIssueNumber = null;
      if (shouldCreateGithubTwin(kind)) {
        const parsed = parseOwnerRepo(app.repo_url);
        if (!github.isEnabled() || !parsed) {
          return res.status(422).json({
            error: 'GitHub is not configured for this app; no issue was created.',
          });
        }
        try {
          const ghIssue = await github.createIssue(parsed.owner, parsed.repo, {
            title,
            body: description || '',
          });
          if (!Number.isInteger(ghIssue?.number) || ghIssue.number <= 0) {
            throw new Error('GitHub returned an invalid issue number');
          }
          githubIssueNumber = ghIssue.number;
          // #125: seed the open-issues cache so the panel refresh the
          // pushIssueUpdate below triggers (loadVotePanel → GET
          // /github-issues) shows this issue immediately instead of
          // waiting out the cache TTL. Cache bookkeeping is non-authoritative
          // and must not turn a completed remote create into a retry/duplicate.
          try {
            github.noteIssueCreated(parsed.owner, parsed.repo, ghIssue);
          } catch (cacheErr) {
            log.warn('issues', 'Created GitHub issue but could not seed cache', {
              err: cacheErr.message,
            });
          }
        } catch (err) {
          log.warn('issues', 'GitHub issue creation failed', { err: err.message });
          return res.status(503).json({
            error: 'GitHub issue creation failed; no local issue was created.',
          });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [app.id, githubIssueNumber, title, description, kind, JSON.stringify(payload), req.user.id]
      );

      let chatPrefix;
      if (kind === 'secret_change') {
        chatPrefix = payload.action === 'delete'
          ? `${req.user.username} proposed removing secret ${payload.key}`
          : `${req.user.username} proposed setting secret ${payload.key}`;
      } else if (kind === 'close_issue') {
        chatPrefix = `${req.user.username} proposed closing issue #${payload.issueNumber}: "${payload.issueTitle}"`;
      } else if (kind === 'maintenance_campaign') {
        chatPrefix = `${req.user.username} proposed a maintenance campaign: "${payload.title}"`;
      } else {
        chatPrefix = `${req.user.username} created issue: "${title}"`;
      }
      const createdMsg = `${chatPrefix}${githubIssueNumber ? ` (#${githubIssueNumber})` : ''}`;
      await sendSystemMessage(pool, app.id, createdMsg, 'system');

      // #1374: a new issue notified nobody before this. Fanned out to the
      // app's stakeholders and gated on the `new_issues` category, which
      // DEFAULTS OFF — so on a platform with no stored preferences this
      // sends nothing at all, and it is opt-in per app from the tile menu.
      //
      // Best-effort and never awaited into the response: filing an issue
      // must not fail because a notification insert did. The issue is on
      // the board either way, which is the whole reason suppressing a
      // notification here is not destructive.
      // Wrapped: a `.catch()` covers a rejected promise, not a synchronous
      // throw, and filing an issue must not fail because of a notification.
      try {
        notifications.createIssueOpenedNotifications?.(pool, {
          appId: app.id,
          issueNumber: githubIssueNumber || rows[0].id,
          authorId: req.user.id,
        })?.then((created) => Promise.all(
          created.map((row) => notifications.hydrateAndPush(pool, row))
        ))?.catch((err) => log.error('issues',
          'Issue-opened notification failed', { appId: app.id, err: err.message }));
      } catch (err) {
        log.error('issues', 'Issue-opened notification threw', { appId: app.id, err: err.message });
      }
      // Dual-post the creation into the topic's own thread so the
      // discussion opens with its origin in context: governance proposals
      // (secret_change / rename / close_issue) thread on the local issue
      // id; general issues thread on the GitHub twin number (no twin → no
      // thread yet). A close_issue proposal ALSO posts into its target
      // issue's thread so followers of the issue see the vote start.
      if (kind === 'secret_change' || kind === 'rename' || kind === 'close_issue'
          || kind === 'maintenance_campaign' || kind === 'featured_illustration') {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'governance', ref: rows[0].id }).catch(() => {});
        if (kind === 'close_issue' && payload.issueNumber) {
          await sendSystemMessage(pool, app.id, createdMsg, 'system',
            null, { type: 'issue', ref: payload.issueNumber }).catch(() => {});
        }
      } else if (githubIssueNumber) {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'issue', ref: githubIssueNumber }).catch(() => {});
      }

      pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: rows[0].id, kind });

      log.info('issues', 'Issue created', { issueId: rows[0].id, kind, title });
      res.status(201).json({ issue: rows[0] });
    } catch (err) {
      log.error('issues', 'Failed to create issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Vote on an issue — for rename proposals, a passing up-vote auto-applies.
  //
  // #2603: a governance vote carries the same one line a proposal vote does.
  // The rules are votes.js's, reused rather than restated: the same
  // normaliser, the same 280-character cap, required on a No and optional on
  // a Yes. Lazily required, matching the direction this module already uses
  // for './votes' (see the demo close rows in the by-id handler above).
  router.post('/api/issues/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['up', 'down'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "up" or "down"' });
    }
    const votesModule = require('./votes');
    const normalized = votesModule.normalizeVoteReason(req.body?.reason);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const reason = normalized.reason;

    try {
      // Join to apps so we have the slug for the WS broadcast below;
      // without it, other users' vote panels wouldn't refresh until they
      // reload the page.
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [req.params.id]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];

      // A vote can be the transition that decrypts and applies a proposed
      // secret value. api:access deliberately excludes credential management,
      // so enforce the issue kind after lookup and before touching votes.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      if (issue.status !== 'open') {
        return res.status(409).json({ error: 'Issue is not open' });
      }

      // Toggle off when re-voting the same direction.
      const { rows: existing } = await pool.query(
        'SELECT vote FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
        [issue.id, req.user.id]
      );

      if (existing.length && existing[0].vote === vote) {
        await pool.query(
          'DELETE FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
          [issue.id, req.user.id]
        );
        pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, toggled: true });
        return res.json({ ok: true, toggled: true });
      }

      // #2603: a No comes with a line, so the proposer learns what is wrong
      // rather than only that somebody minded — votes.js's rule, and its
      // wording. Checked AFTER the toggle branch above: retracting a No is
      // not casting one, and asking for a sentence to take a vote back would
      // be a trap. The same-side re-cast votes.js exempts cannot arrive here
      // at all, because on an issue that click is the retraction.
      if (vote === 'down' && !reason) {
        return res.status(400).json({
          error: 'reason_required',
          message: votesModule.VOTE_REASON_REQUIRED,
          maxLength: votesModule.VOTE_REASON_MAX,
        });
      }

      // A flip REPLACES the line rather than keeping it: the old sentence
      // argued for the side this vote just left. (votes.js keeps an earlier
      // line on a same-side re-cast; here that click is the toggle above.)
      await pool.query(
        `INSERT INTO issue_votes (issue_id, user_id, vote, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (issue_id, user_id) DO UPDATE
           SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, created_at = NOW()`,
        [issue.id, req.user.id, vote, reason]
      );

      let voteSubject;
      if (issue.kind === 'rename') {
        voteSubject = `rename proposal "${issue.payload?.newName || issue.title}"`;
      } else if (issue.kind === 'secret_change') {
        const action = issue.payload?.action === 'delete' ? 'removal' : 'change';
        voteSubject = `secret ${action} "${issue.payload?.key || issue.title}"`;
      } else if (issue.kind === 'close_issue') {
        voteSubject = `close proposal for issue #${issue.payload?.issueNumber || '?'}`;
      } else if (issue.kind === 'maintenance_campaign') {
        voteSubject = `maintenance campaign "${issue.payload?.title || issue.title}"`;
      } else if (issue.kind === 'featured_illustration') {
        voteSubject = issue.payload?.remove
          ? 'the proposal to remove the featured illustration'
          : 'the proposed featured illustration';
      } else {
        voteSubject = `issue: "${issue.title}"`;
      }
      // #2603: with a line, the row is the person's sentence as well as their
      // tally — the same shape votes.js gives a proposal vote's thread line.
      await sendSystemMessage(pool, issue.app_id,
        reason
          ? `${req.user.username} voted ${vote} on ${voteSubject}: “${reason}”`
          : `${req.user.username} voted ${vote} on ${voteSubject}`,
        'vote',
        null,
        // #194: per-vote activity lands in the proposal's own thread
        // (the governance card on the Proposals tab), not general chat.
        { type: 'governance', ref: issue.id }
      );

      // #1010: broadcast the VOTE before the apply, not after. A deciding
      // up-vote on a governance proposal runs the whole apply (GitHub close
      // + comment for close_issue — seconds of latency) inside this request,
      // and the old ordering held this event behind all of it, so every other
      // client's tally sat stale for the duration and none of them could
      // derive the "being applied" state. The apply pushes its own events
      // when it settles, so this one is purely "a vote landed".
      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, vote });

      let renamed = null;
      let secretChanged = null;
      let issueClosed = null;
      let campaignStarted = null;
      let illustrationChanged = null;
      if (vote === 'up' && issue.kind === 'rename') {
        renamed = await maybeApplyRenameProposal(pool, issue);
      } else if (vote === 'up' && issue.kind === 'secret_change') {
        secretChanged = await maybeApplySecretChangeProposal(config, pool, issue);
      } else if (vote === 'up' && issue.kind === 'close_issue') {
        issueClosed = await maybeApplyCloseIssueProposal(pool, issue);
      } else if (vote === 'up' && issue.kind === 'maintenance_campaign') {
        campaignStarted = await maybeApplyMaintenanceCampaignProposal(config, pool, issue);
      } else if (vote === 'up' && issue.kind === 'featured_illustration') {
        illustrationChanged = await maybeApplyFeaturedIllustrationProposal(pool, issue);
      }

      res.json({ ok: true, renamed, secretChanged, issueClosed, campaignStarted, illustrationChanged });
    } catch (err) {
      log.error('issues', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues
  //
  // Lists the repo's OPEN GitHub issues (via github.fetchPublicIssues —
  // anonymous, cached, never-throws) for the "Open Issues" activity-panel
  // section. Augments each issue with this app's OPEN-bounty count and a
  // per-viewer `my_bounty` flag, the issue's creating user
  // (`created_by_username`, #133), the latest live headless auto session
  // (`headless`, #155 — including the viewer's own derived session as
  // `headless.mySessionId`, #172), plus the viewer's remaining weekly kudos
  // allowance so the FE can disable the "Give kudos" button when the shared
  // budget is spent. Distinct from the platform-internal `issues` table
  // (governance proposals) listed by GET /api/apps/:slug/issues above.
  //
  // #192: `?refresh=1` forces a refetch past the server-side cache TTL
  // (throttled per repo inside github.refreshPublicIssues — within the
  // cooldown it serves the cache). Refresh responses additionally carry
  // `refreshed` and `refreshRetryMs` so the FE can disable its button for
  // the cooldown window; the normal payload shape is unchanged.
  // ----------------------------------------------------------------
  // #2089: the board search reads past the title. Titles, authors, numbers
  // and the bodies the board payload already carries filter in the browser;
  // the discussion under a card does not travel with it (a thread loads when
  // its card opens), so this answers "which threads on this app mention the
  // query" and the browser folds the keys in. One thread type per card
  // family, mirroring the thread_type / thread_ref pairs chat.js writes:
  //   issue      -> GitHub issue number   (issue cards)
  //   session    -> chat_sessions.id      (proposal, merged and session cards)
  //   governance -> issues.id             (governance cards)
  // Human messages only (msg_type = 'message'), so a vote or lifecycle row
  // quoting the query does not surface a card. View-gated like the board.
  router.get('/api/apps/:slug/board-search', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const q = String(req.query.q || '').trim().slice(0, 200);
      const out = { q, issues: [], sessions: [], gov: [] };
      if (q.length < BOARD_SEARCH_MIN_CHARS) return res.json(out);
      // A substring match: the query is data, so its LIKE metacharacters
      // are escaped rather than interpreted.
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const { rows } = await pool.query(
        `SELECT thread_type, thread_ref
           FROM chat_messages
          WHERE app_id = $1
            AND msg_type = 'message'
            AND thread_type IN ('issue', 'session', 'governance')
            AND thread_ref IS NOT NULL
            AND content ILIKE $2 ESCAPE '\\'
          GROUP BY thread_type, thread_ref
          ORDER BY MAX(created_at) DESC
          LIMIT $3`,
        [app.id, pattern, BOARD_SEARCH_MAX_HITS]
      );
      for (const r of rows) {
        const ref = r.thread_ref == null ? NaN : Number(r.thread_ref);
        if (!Number.isInteger(ref) || ref <= 0) continue;
        if (r.thread_type === 'issue') out.issues.push(ref);
        else if (r.thread_type === 'session') out.sessions.push(ref);
        else out.gov.push(ref);
      }
      return res.json(out);
    } catch (err) {
      log.error('issues', 'Failed to search the board', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/github-issues', async (req, res) => {
    try {
      // View-level (#621): the GitHub issue list is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      const wantRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      let result;
      if (!github.isEnabled() || !parsed) {
        if (!IS_STAGING) {
          return res.json({ issues: [], truncatedList: false, note: 'unavailable' });
        }
        // Staging: serve mocks so the Dev card list is reviewable even
        // when GitHub isn't reachable from the preview container.
        result = { issues: stagingMockIssues(app.repo_url), truncatedList: false };
      } else {
        // Neither fetcher ever throws or returns null; on any failure mode
        // they return { issues:[], truncatedList:false, note }.
        result = wantRefresh
          ? await github.refreshPublicIssues(parsed.owner, parsed.repo)
          : await github.fetchPublicIssues(parsed.owner, parsed.repo);
        // Staging-only fallback: an empty (or degraded) live list would
        // render an empty Topics feed in the preview — substitute mocks.
        if (IS_STAGING && (!Array.isArray(result.issues) || result.issues.length === 0)) {
          result = {
            ...result,
            issues: stagingMockIssues(app.repo_url),
            truncatedList: false,
            note: undefined,
          };
        }
      }

      // Staging-only demo mode: with ?demo=1 the mocks are appended even
      // when the live list has rows, so layout work (e.g. long-title
      // wrapping) is verifiable against a prod-cloned DB. The FE forwards
      // the page's own ?demo=1 here (see _demoQS in app-view.js). The
      // number check keeps this idempotent against the empty-list
      // fallback above having already served the same mocks. Strictly a
      // no-op in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set((result.issues || []).map((i) => i.number));
        result = {
          ...result,
          issues: [
            ...(result.issues || []),
            ...stagingMockIssues(app.repo_url).filter((m) => !have.has(m.number)),
          ],
        };
      }

      // Open-bounty tallies for this app, keyed by issue number, in one
      // round-trip. BOOL_OR gives the viewer's own-open-bounty flag.
      const { rows: bountyRows } = await pool.query(
        `SELECT github_issue_number AS n,
                COUNT(*)::int AS cnt,
                BOOL_OR(giver_user_id = $2) AS mine
           FROM issue_bounties
          WHERE app_id = $1 AND status = 'open'
          GROUP BY github_issue_number`,
        [app.id, req.user.id]
      );
      const byNumber = new Map(bountyRows.map((r) => [r.n, r]));

      // #133/#136/#2427: resolve each issue's creating user so the panel can show
      // it next to the title the way PR rows show their author. Platform-
      // filed issues record created_by in the local issues table; feedback-
      // filed ones use feedback_reports, with the body's "**Source:**" line
      // as the compatibility fallback for older rows (the "usernode user
      // (name)" / "usernode admin (name)" forms, plus the legacy bare
      // "usernode admin" written before #140);
      // issues opened directly on GitHub fall back to the GitHub login —
      // but never the platform bot account itself, which would just name
      // "usernode-bot" on every platform-filed row.
      const { rows: creatorRows } = await pool.query(
        `SELECT DISTINCT ON (n) n, username
           FROM (
             SELECT i.github_issue_number AS n, u.username, 0 AS source_rank
               FROM issues i JOIN users u ON u.id = i.created_by
              WHERE i.app_id = $1 AND i.github_issue_number IS NOT NULL
             UNION ALL
             SELECT fr.issue_number AS n, u.username, 1 AS source_rank
               FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
              WHERE fr.issue_owner = $2 AND fr.issue_repo = $3
                AND fr.issue_number IS NOT NULL
           ) creators
          ORDER BY n, source_rank`,
        [app.id, parsed?.owner || null, parsed?.repo || null]
      );
      const creatorByNumber = new Map(creatorRows.map((r) => [r.n, r.username]));

      // #194: per-issue thread message counts (and the latest message
      // timestamp, for the forum feed's activity sort) in one grouped
      // query. Keyed by GitHub issue number (thread_ref for
      // thread_type='issue'). The badge count covers human messages only
      // (msg_type='message') so dual-posted lifecycle system rows don't
      // inflate it; last_at stays over all rows so system activity still
      // freshens the feed sort.
      const { rows: chatRows } = await pool.query(
        `SELECT thread_ref AS n,
                (COUNT(*) FILTER (WHERE msg_type = 'message'))::int AS cnt,
                MAX(created_at) AS last_at
           FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue'
          GROUP BY thread_ref`,
        [app.id]
      );
      const chatByNumber = new Map(chatRows.map((r) => [r.n, r]));

      // #155: latest live headless auto session per issue, so the panel can
      // render the right button state (Generate proposal / Generating… / the
      // outcome-specific "Review … & start session" clone button). 'failed'
      // rows are excluded — the button recovers to Generate proposal so the
      // run can be retried.
      // staging_url/pr_number ride along (#183) so the panel can render the
      // changes-ready label + Preview button for auto runs that pushed code
      // and built a preview. staging_url is nulled on teardown, so a GC'd
      // preview degrades the label back to the plain outcome wording.
      const { rows: headlessRows } = await pool.query(
        `SELECT DISTINCT ON (cs.headless_issue_number)
                cs.headless_issue_number AS n, cs.id, cs.headless_status,
                cs.headless_outcome, cs.staging_url, cs.pr_number, u.username,
                cs.user_id
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.is_headless = TRUE
            AND cs.headless_status IN ('generating', 'ready')
          ORDER BY cs.headless_issue_number, cs.created_at DESC`,
        [app.id]
      );
      // #172: the viewer's own most recent non-archived clone of each
      // listed headless session, so the FE can swap the clone button for
      // "Go to session" once they've already started one. Strictly
      // per-viewer — sessions are owner-scoped, so another user's clone
      // isn't navigable and must not hide the clone button. 'archived'
      // clones are excluded (one-way abandoned state) so the user can
      // start over. No dedicated index: the lookup filters by user_id +
      // cloned_from_session_id over a handful of ids, fine at current
      // volumes.
      const headlessIds = headlessRows.map((r) => r.id);
      const myCloneByHeadlessId = new Map();
      if (headlessIds.length) {
        const { rows: cloneRows } = await pool.query(
          `SELECT DISTINCT ON (cloned_from_session_id)
                  cloned_from_session_id AS src, id
             FROM chat_sessions
            WHERE user_id = $1 AND cloned_from_session_id = ANY($2)
              AND status <> 'archived'
            ORDER BY cloned_from_session_id, created_at DESC`,
          [req.user.id, headlessIds]
        );
        for (const r of cloneRows) myCloneByHeadlessId.set(r.src, r.id);
      }

      const headlessByNumber = new Map(headlessRows.map((r) => [r.n, {
        sessionId: r.id,
        status: r.headless_status,
        outcome: r.headless_outcome,
        username: r.username,
        // #1372: whether the VIEWER started this run. `username` cannot
        // stand in for it — comparing display names client-side is not an
        // authorization answer, and the client needs a real one here: the
        // question-outcome button navigates into the run's own session,
        // which /api/sessions/:id serves only to its owner.
        mine: r.user_id === req.user.id,
        mySessionId: myCloneByHeadlessId.get(r.id) || null,
        stagingUrl: r.staging_url || null,
        prNumber: r.pr_number || null,
      }]));

      // #287: the viewer's own most recent non-archived dev chat started
      // from each issue's start-work button (created_from_issue_number),
      // so the row can swap "Create proposal" → "Create new proposal".
      // Strictly per-viewer (sessions are owner-scoped — another user's
      // session must not flip the label) and 'archived' rows are excluded
      // so the button reverts to "Create proposal" after the viewer
      // abandons their session. Independent of the headless lookup above.
      const { rows: prSessionRows } = await pool.query(
        `SELECT DISTINCT ON (created_from_issue_number)
                created_from_issue_number AS n, id
           FROM chat_sessions
          WHERE app_id = $1 AND user_id = $2
            AND created_from_issue_number IS NOT NULL
            AND status <> 'archived'
          ORDER BY created_from_issue_number, created_at DESC`,
        [app.id, req.user.id]
      );
      const myPrSessionByNumber = new Map(prSessionRows.map((r) => [r.n, r.id]));

      // "In progress" derivation — the dispatch-driven half. Every LIVE
      // non-headless session that declared linked_issues (via the Mayor's
      // addresses_issues at dispatch time) marks its issues in progress.
      // Live = active/promoted/merging always; paused only within the
      // IN_PROGRESS_PAUSED_WINDOW_DAYS activity window (rejection,
      // withdrawal, and stale-PR takedown all land in 'archived' and merge
      // in 'merged', so those exclude themselves). Headless runs are
      // deliberately NOT part of this field — they already ship as
      // issue.headless above, and the FE ORs the two (keeps the 8s
      // headless poller's field-scoped merge correct).
      const { rows: inProgressRows } = await pool.query(
        `SELECT UNNEST(cs.linked_issues) AS n,
                cs.id, cs.user_id, cs.status, cs.shared_at,
                cs.last_activity_at, cs.created_at, u.username
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.is_headless = FALSE
            AND cardinality(cs.linked_issues) > 0
            AND (cs.status IN ('active','promoted','merging')
                 OR (cs.status = 'paused'
                     AND cs.last_activity_at > NOW() - make_interval(days => $2)))`,
        [app.id, IN_PROGRESS_PAUSED_WINDOW_DAYS]
      );
      const inProgressByNumber = new Map();
      for (const r of inProgressRows) {
        const list = inProgressByNumber.get(r.n) || [];
        list.push(r);
        inProgressByNumber.set(r.n, list);
      }

      // Manual claims — the hand-set half. Expiry is a read-time filter:
      // a claim is live while GREATEST(claimed_at, the issue thread's
      // last activity) is within ISSUE_CLAIM_TTL_DAYS. Thread activity is
      // already in chatByNumber (last_at over ALL rows), so liveness and
      // expiresAt are computed here at zero extra query cost.
      const { rows: claimRows } = await pool.query(
        `SELECT ic.github_issue_number AS n, ic.user_id, ic.claimed_at, u.username
           FROM issue_claims ic JOIN users u ON u.id = ic.user_id
          WHERE ic.app_id = $1
          ORDER BY ic.claimed_at ASC`,
        [app.id]
      );
      const claimsByNumber = new Map();
      const claimNow = Date.now();
      for (const c of claimRows) {
        const lastAt = chatByNumber.get(c.n)?.last_at;
        if (!claimIsLive(c.claimed_at, lastAt, claimNow)) continue; // expired — inert row
        const list = claimsByNumber.get(c.n) || [];
        list.push({ ...c, expires_at: claimExpiresAt(c.claimed_at, lastAt).toISOString() });
        claimsByNumber.set(c.n, list);
      }

      // #2431: the proposal addressing each issue, resolved for every listed
      // number in ONE query — the topic page of an OPEN issue renders from
      // this payload, so the reference has to travel with the list.
      const addressedBy = await resolveIssueProposalRefs(
        pool, app.id, (result.issues || []).map((i) => i.number), req.user.id
      );

      const issues = (result.issues || []).map((issue) => {
        const b = byNumber.get(issue.number);
        const ghLogin = issue.user && !issue.user.endsWith('[bot]') && issue.user !== 'usernode-bot'
          ? issue.user
          : null;
        return {
          ...issue,
          bounty_count: b ? b.cnt : 0,
          my_bounty: b ? !!b.mine : false,
          created_by_username: creatorByNumber.get(issue.number)
            || creatorFromSourceLine(issue.body)
            || ghLogin,
          headless: headlessByNumber.get(issue.number) || null,
          // Dispatch/claim-derived "In progress" status (sessions + manual
          // claims; headless rides separately on `headless` above). The
          // `target` inside is per-viewer — see pickInProgressTarget.
          in_progress: composeInProgress(
            inProgressByNumber.get(issue.number),
            claimsByNumber.get(issue.number),
            req.user.id
          ),
          // #287: per-viewer proposal session id, or null. Drives the
          // "Create proposal" → "Create new proposal" swap on the issue row.
          myPrSessionId: myPrSessionByNumber.get(issue.number) || null,
          // #2431: the change addressing this issue, or null.
          addressed_by: addressedBy.get(issue.number) || null,
          chatCount: chatByNumber.get(issue.number)?.cnt || 0,
          lastMessageAt: chatByNumber.get(issue.number)?.last_at || null,
          // The Haiku title call failed when this feedback issue was
          // filed, so it carries the placeholder template. Drives the
          // "Auto-title pending" chip on the issue row; the title-heal
          // sweeper regenerates it (services/title-heal.js), after which
          // the refreshed title no longer matches and the chip drops.
          title_fallback: issue.title === FEEDBACK_FALLBACK_TITLE,
        };
      });

      // #227: the staging mocks have no chat_sessions rows, so the feed's
      // auto-solve-first ordering would be unreviewable in a preview.
      // Attach synthetic headless state to two [Mock] rows — 900003
      // 'generating' (30h old, naturally last by recency, so the re-rank
      // is unmistakable) and 900005 'ready'/spec — only where no real
      // headless row already claimed the number, so prod-cloned data is
      // never overridden. Request-time and read-only; strictly a no-op
      // in production.
      if (IS_STAGING) {
        const mockHeadless = new Map([
          [900003, { status: 'generating', outcome: null }],
          [900005, { status: 'ready', outcome: 'spec' }],
          // #1112: the `question` outcome — a finished run that is waiting on
          // a human answer, which the work-state chip reports as amber
          // "Needs an answer" rather than as work in flight.
          [900015, { status: 'ready', outcome: 'question' }],
          // #1112: dedicated row for the finished-draft state. Unlike the
          // older 900005 ranking fixture, this number is not also used by a
          // persisted staging headless seed.
          [900016, { status: 'ready', outcome: 'spec' }],
        ]);
        for (const issue of issues) {
          const m = mockHeadless.get(issue.number);
          if (m && !issue.headless) {
            issue.headless = {
              sessionId: issue.number,
              status: m.status,
              outcome: m.outcome,
              username: 'staging-tester',
              // No chat_sessions row backs these numbers, so the run-session
              // navigation has nothing to open — the mock exercises the
              // not-my-run path on purpose.
              mine: false,
              mySessionId: null,
              stagingUrl: null,
              prNumber: null,
            };
          }
        }
        // #287: the staging mocks have no chat_sessions rows, so the
        // "Create new proposal" variant of the start-work button would
        // never render in a preview. Attach a synthetic myPrSessionId to
        // the dedicated [Mock] row (900007, "issue with an in-progress
        // proposal") so the has-session button is reviewable — only where
        // no real session already claimed it. The id is synthetic (the
        // mock issue number); clicking "Create new proposal" still just
        // spawns a fresh dev chat, so this is purely for visual review of
        // the button label. Request-time, read-only, no-op in production.
        for (const issue of issues) {
          if (issue.number === 900007 && !issue.myPrSessionId) {
            issue.myPrSessionId = issue.number;
          }
        }
        // #556: the [Mock] rows resolve no platform creator, so the
        // author-only "edit title" pencil in the topic head would never
        // render in a preview. Mark the dedicated row (900008) as authored
        // by the viewer — only where no real creator resolved — so the
        // affordance is reviewable. Saving still fails (no real GitHub
        // issue behind the mock); purely visual. No-op in production.
        //
        // "No real creator resolved" has to include the mock's OWN author
        // sentinel: stagingMockIssues stamps every row `user:
        // 'staging-tester'`, and the enrichment above promotes that to
        // created_by_username as a GitHub login — so the `!created_by_username`
        // guard never fired and the pencil never rendered. Only the sentinel
        // is treated as unresolved; a genuinely prod-cloned row that happens
        // to be numbered 900008 keeps its real author.
        for (const issue of issues) {
          if (issue.number === 900008
            && (!issue.created_by_username || issue.created_by_username === 'staging-tester')) {
            issue.created_by_username = req.user.username;
          }
        }
        // #964: `issue_bounties` is staging:private, so it arrives
        // schema-only and EVERY row in a preview shows a bounty count of 0 —
        // the ★ pill and the "★ Bountied" button state would be unreviewable,
        // and the Send Feedback dialog's new create-with-bounty checkbox
        // couldn't be seen to have done anything (staging also has no
        // GITHUB_BOT_TOKEN, so no issue is really filed there). Attach
        // synthetic bounty state to two dedicated [Mock] rows — only where no
        // real row already claimed the number, so prod-cloned data is never
        // overridden. Request-time, read-only, no-op in production.
        const mockBounties = new Map([
          [900002, { bounty_count: 2, my_bounty: false }],
          [900004, { bounty_count: 1, my_bounty: true }],
        ]);
        for (const issue of issues) {
          const b = mockBounties.get(issue.number);
          if (b && !issue.bounty_count) {
            issue.bounty_count = b.bounty_count;
            issue.my_bounty = b.my_bounty;
          }
        }
        // "In progress" chip states on dedicated [Mock] rows, so every
        // variant is reviewable in a preview — only where no real data
        // claimed the number. 900001/900002/900009 are deliberately left
        // untouched: they anchor the kanban drag-order (#613) and
        // newest-on-top (#617) demos, and an in-progress mark would move
        // them out of the Issues column. Request-time, read-only, no-op
        // in production.
        const hoursAgoIso = (hrs) => new Date(Date.now() - hrs * 3600 * 1000).toISOString();
        const hoursAheadIso = (hrs) => new Date(Date.now() + hrs * 3600 * 1000).toISOString();
        const mkMockClaim = (username, mine, hrs) => ({
          username, userId: mine ? req.user.id : 0, mine,
          claimedAt: hoursAgoIso(hrs), expiresAt: hoursAheadIso(7 * 24 - hrs),
        });
        const mkMockSession = (sessionId, username, status, hrs, busy) => ({
          sessionId, username, mine: false, status, busy: !!busy,
          lastActivityAt: hoursAgoIso(hrs),
        });
        const mockInProgress = new Map([
          // #1112 `in_review`: the session was promoted, so the work is
          // waiting on reviewers rather than on an agent. CLICKABLE styling
          // (synthetic proposal target — clicking lands on the topic view's
          // not-found fallback, same visual-review-only caveat as the
          // synthetic myPrSessionId above).
          [900007, {
            count: 1, users: ['staging-tester'], peopleTotal: 1, mine: false, claims: [],
            sessions: [mkMockSession(900007, 'staging-tester', 'promoted', 4, false)],
            target: { kind: 'proposal', sessionId: 900007 },
          }],
          // #1112 `working` with a live turn: two active sessions, the
          // most-recent one busy, so the chip renders emerald with its
          // spinner and a "+1" for the second person. NON-clickable
          // (private-work) styling.
          [900006, {
            count: 2, users: ['maya-builder', 'staging-tester'], peopleTotal: 2, mine: false,
            claims: [],
            sessions: [
              mkMockSession(900106, 'maya-builder', 'active', 0.2, true),
              mkMockSession(900206, 'staging-tester', 'active', 3, false),
            ],
            target: null,
          }],
          // #1112 `claimed`, with the VIEWER among the claimers — reviews
          // the multi-claimer "+1" plus the "Release my claim" button state.
          [900004, {
            count: 0, users: [], peopleTotal: 2, mine: true, sessions: [],
            claims: [mkMockClaim(req.user.username, true, 2), mkMockClaim('maya-builder', false, 5)],
            target: null,
          }],
          // #1112 `claimed` by someone else — the viewer's button stays
          // "Claim this issue" and the admin per-claim clear is reviewable
          // in the topic view.
          [900008, {
            count: 0, users: [], peopleTotal: 1, mine: false, sessions: [],
            claims: [mkMockClaim('maya-builder', false, 8)],
            target: null,
          }],
          // #1112 `paused`: one session, paused, last touched 5 days ago —
          // two days short of the 7-day self-clear, which is exactly the
          // case the topic head's dated sentence exists to explain.
          [900014, {
            count: 1, users: ['maya-builder'], peopleTotal: 1, mine: false, claims: [],
            sessions: [mkMockSession(900114, 'maya-builder', 'paused', 5 * 24, false)],
            target: null,
          }],
        ]);
        for (const issue of issues) {
          const m = mockInProgress.get(issue.number);
          if (m && !issue.in_progress) issue.in_progress = m;
        }
      }

      // Community-voted priority + assigned-person summary per issue (the
      // chip top value + count + the viewer's pick), keyed by GitHub issue
      // number — mirroring the bounty enrichment above. The dropdown's full
      // tally lazy-loads from /api/apps/:slug/topics/issue/:n/attributes.
      const attrByNumber = await topicAttrs.summarizeForTargets(
        pool, app.id, 'issue', issues.map((i) => i.number), req.user.id
      );
      for (const issue of issues) {
        const s = attrByNumber.get(issue.number) || topicAttrs.emptySummary();
        issue.priority = s.priority;
        issue.assignee = s.assignee;
        issue.category = s.category;
      }
      // Staging: the [Mock] rows have no topic_attribute_votes, so seed a
      // synthetic summary onto a few so the chips' states are reviewable in
      // a preview — a clear leader, a tie, and an untouched (placeholder)
      // row. Only where the real query found nothing. No-op in production.
      if (IS_STAGING) {
        // #600: so both assignee-dropdown states are reviewable, 900001's
        // assignee is seeded to the VIEWING user (myValue = their own
        // username) — opening its dropdown shows the viewer's name already
        // checked and the name box empty (no pre-fill, since they've voted).
        // 900002 stays untouched (Unassigned) so opening ITS dropdown shows
        // the name box PRE-FILLED with the viewer's username.
        const viewer = (req.user && req.user.username) || 'staging-tester';
        const mockAttrs = new Map([
          // Clear leader on all fields; the viewer is their own assignee.
          [900001, {
            priority: { top: 'high', count: 3, myValue: null },
            assignee: { top: viewer, count: 2, myValue: viewer },
            // #504: a clear category leader (count 3) so the chip + colour
            // and the category filter dropdown are reviewable.
            category: { top: 'bug', count: 3, myValue: null },
          }],
          // A tie (count 1 vs 1) — the earlier-suggested value wins the chip.
          [900003, {
            priority: { top: 'low', count: 1, myValue: null },
            assignee: { top: 'staging-demo-user', count: 1, myValue: null },
            category: { top: 'docs', count: 1, myValue: null },
          }],
          // #489: a third assignee whose first letter (M) differs from the
          // others (S), so the deterministic initial-avatar colouring is
          // reviewable across several visibly-distinct avatars on the board.
          [900006, {
            priority: { top: 'medium', count: 2, myValue: null },
            assignee: { top: 'maya-builder', count: 3, myValue: null },
            // A second, distinct category leader so the filter has choices.
            category: { top: 'feature', count: 2, myValue: null },
          }],
          // #780: a CUSTOM category leader, matching one of the two demo
          // entries listCategories() appends in staging — so the custom chip
          // colour, and narrowing the board by a custom category in the
          // filter bar, are both reviewable in a preview.
          [900007, {
            priority: { top: 'high', count: 1, myValue: null },
            assignee: { top: 'staging-demo-user', count: 1, myValue: null },
            category: { top: 'staging-demo-perf', count: 2, myValue: null },
          }],
          // 900002 deliberately left untouched → muted "Set priority" /
          // "Unassigned" / "Set category"; opening its assignee dropdown
          // pre-fills the viewer's own username.
        ]);
        for (const issue of issues) {
          const m = mockAttrs.get(issue.number);
          if (m && (!issue.priority || !issue.priority.top) && (!issue.assignee || !issue.assignee.top)) {
            issue.priority = m.priority;
            issue.assignee = m.assignee;
            issue.category = m.category;
          }
        }
      }

      // #1688: what the board shows beside the bounty button is the BOUNTY
      // allowance, which has its own count now (services/bounties.js).
      const used = await countWeeklyBountiesUsed(pool, req.user.id, weekStartUtc());
      const myRemaining = Math.max(0, WEEKLY_BOUNTY_LIMIT - used);

      res.json({
        issues,
        truncatedList: !!result.truncatedList,
        ...(result.note ? { note: result.note } : {}),
        // #2261: the list is the last one GitHub gave, not a fresh read —
        // the board keeps what it has rather than repainting on it.
        ...(result.stale ? { stale: true } : {}),
        ...(wantRefresh
          ? { refreshed: !!result.refreshed, refreshRetryMs: result.retryInMs || 0 }
          : {}),
        myRemaining,
        limit: WEEKLY_BOUNTY_LIMIT,
      });
    } catch (err) {
      log.error('issues', 'Failed to list GitHub issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues/:number
  //
  // #2365: ONE GitHub issue, open or CLOSED, for the topic view. The list
  // route above carries open issues only, so a proposal's link to the issue
  // it closed opened a page that could not find it and silently bounced to
  // the board. github.fetchPublicIssue is cache-first, never throws, resolves
  // closed issues through the single-issue endpoint and refuses pull
  // requests — anything it cannot return is a 404 here. View-gated like the
  // list. Returns `{ issue }` in the list's row shape: creator, bounty tally,
  // discussion count and attributes are resolved the same way; the
  // per-viewer work fields (headless run, in-progress, own session) are left
  // empty, because a closed issue's page offers no work on it. `addressed_by`
  // (#2431) is the exception the closed page needs most: the change that
  // closed it is a record, not an offer of work.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues/:number', async (req, res) => {
    try {
      // View-level (#621): reading an issue is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const number = /^\d+$/.test(req.params.number) ? Number(req.params.number) : NaN;
      if (!Number.isSafeInteger(number) || number <= 0) {
        return res.status(400).json({ error: 'Invalid issue number' });
      }
      const parsed = parseOwnerRepo(app.repo_url);

      // Staging: the list route's mock rows resolve here too, so a mock
      // issue's page opened by URL behaves like one opened from the board.
      // With ?demo=1 the mock is served without the live round trip, for the
      // reason the comments route below gives; without it the live fetch
      // goes first and the mock is only the fallback. No-op in production.
      const mock = IS_STAGING
        ? stagingMockIssues(app.repo_url).find((i) => i.number === number) || null
        : null;
      let issue = null;
      if (mock && req.query.demo === '1') {
        issue = mock;
      } else if (github.isEnabled() && parsed) {
        ({ issue } = await github.fetchPublicIssue(parsed.owner, parsed.repo, number));
      }
      if (!issue) issue = mock;
      if (!issue) return res.status(404).json({ error: 'Issue not found' });

      const { rows: bountyRows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt, BOOL_OR(giver_user_id = $3) AS mine
           FROM issue_bounties
          WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
        [app.id, number, req.user.id]
      );
      const { rows: creatorRows } = await pool.query(
        `SELECT username
           FROM (
             SELECT u.username, 0 AS source_rank, i.id AS source_id
               FROM issues i JOIN users u ON u.id = i.created_by
              WHERE i.app_id = $1 AND i.github_issue_number = $2
             UNION ALL
             SELECT u.username, 1 AS source_rank, fr.id AS source_id
               FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
              WHERE fr.issue_owner = $3 AND fr.issue_repo = $4 AND fr.issue_number = $2
           ) creators
          ORDER BY source_rank, source_id DESC
          LIMIT 1`,
        [app.id, number, parsed?.owner || null, parsed?.repo || null]
      );
      const { rows: chatRows } = await pool.query(
        `SELECT (COUNT(*) FILTER (WHERE msg_type = 'message'))::int AS cnt,
                MAX(created_at) AS last_at
           FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2`,
        [app.id, number]
      );
      const b = bountyRows[0];
      const chat = chatRows[0];
      const ghLogin = issue.user && !issue.user.endsWith('[bot]') && issue.user !== 'usernode-bot'
        ? issue.user
        : null;
      const attrs = (await topicAttrs.summarizeForTargets(
        pool, app.id, 'issue', [number], req.user.id
      )).get(number) || topicAttrs.emptySummary();
      // #2431: for a CLOSED issue this is the whole answer to "what closed
      // this?" — the merged change that linked it. Same resolver the list
      // uses, so both pages name the same proposal.
      const addressedBy = await resolveIssueProposalRefs(
        pool, app.id, [number], req.user.id
      );

      return res.json({
        issue: {
          state: 'open',
          closedAt: null,
          ...issue,
          bounty_count: b ? b.cnt : 0,
          my_bounty: b ? !!b.mine : false,
          created_by_username: (creatorRows[0] && creatorRows[0].username)
            || creatorFromSourceLine(issue.body)
            || ghLogin,
          headless: null,
          in_progress: null,
          myPrSessionId: null,
          addressed_by: addressedBy.get(number) || null,
          chatCount: (chat && chat.cnt) || 0,
          lastMessageAt: (chat && chat.last_at) || null,
          title_fallback: issue.title === FEEDBACK_FALLBACK_TITLE,
          priority: attrs.priority,
          assignee: attrs.assignee,
          category: attrs.category,
        },
      });
    } catch (err) {
      log.error('issues', 'Failed to fetch GitHub issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues/:number/comments
  //
  // #396: the GitHub comment thread for ONE issue, for the Dev topic
  // view's comment section. Lazy — fetched only when a viewer opens an
  // issue topic, never as part of the list payload, so the panel's
  // rate-limit cost is unchanged. Collab-gated like the list route above.
  // Returns `{ comments: [{ author, body, createdAt }], truncated, note? }`;
  // github.fetchIssueComments never throws (failures degrade to an empty
  // list with a note). In staging the thread is backed by mock comments
  // when the live fetch is empty/unavailable, so the section is reviewable.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues/:number/comments', async (req, res) => {
    try {
      // View-level (#621): comment history is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const number = parseInt(req.params.number, 10);
      const parsed = parseOwnerRepo(app.repo_url);

      if (!github.isEnabled() || !parsed || !Number.isFinite(number)) {
        if (!IS_STAGING) {
          return res.json({ comments: [], truncated: false, note: 'unavailable' });
        }
        const mocks = stagingMockIssueComments(number);
        const clipped = github.clipIssueComments(mocks);
        return res.json({ comments: clipped.comments, truncated: clipped.truncated });
      }

      // Staging demo mode (?demo=1) on one of the MOCK rows: the page is on
      // fixtures by choice — the list route appends these rows for it — so
      // the thread is the fixture too, served without the live round trip.
      // No real issue has these numbers, so the live fetch can only come
      // back empty and fall through to the same mocks; what it costs is
      // time. From a preview container whose outbound fetch hangs, that is
      // the whole ISSUES_FETCH_TIMEOUT_MS, and the check runner polls a
      // presence assertion for five seconds after the page settles
      // (capture/capture.js ASSERT_MAX_MS) — which is exactly how the
      // declared issue-page check found no comment bubbles on staging while
      // passing locally, where GitHub is off and the mocks are immediate.
      if (IS_STAGING && req.query.demo === '1' && isStagingMockIssueNumber(number)) {
        const clipped = github.clipIssueComments(stagingMockIssueComments(number));
        return res.json({ comments: clipped.comments, truncated: clipped.truncated });
      }

      const raw = await github.fetchIssueComments(parsed.owner, parsed.repo, number);
      let { comments, truncated } = github.clipIssueComments(raw.comments, { wasTruncated: raw.truncated });

      // Staging-only fallback: an empty (or degraded) live thread would
      // render nothing in the preview — substitute mocks so the section is
      // reviewable. Strictly a no-op in production.
      if (IS_STAGING && comments.length === 0) {
        const clipped = github.clipIssueComments(stagingMockIssueComments(number));
        comments = clipped.comments;
        truncated = clipped.truncated;
        return res.json({ comments, truncated });
      }

      return res.json({
        comments,
        truncated,
        ...(raw.note ? { note: raw.note } : {}),
      });
    } catch (err) {
      log.error('issues', 'Failed to fetch GitHub issue comments', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // PATCH /api/apps/:slug/github-issues/:number/title
  //
  // #556: author-only rename of an open GitHub issue from inside the app.
  // The GitHub issue is retitled FIRST (nothing local changes if that
  // fails), then best-effort follow-ups: the local `issues` mirror row
  // (platform-filed issues only), removal of any pending title_heal_queue
  // row (so the sweeper can't clobber the author's choice), a system
  // message in the issue's own discussion thread recording old → new, and
  // the cache-bust + issue_update broadcast that live-refreshes open
  // panels (same pair title-heal uses).
  //
  // Authorship: platform-filed issues record created_by in the local issues
  // table; feedback-filed ones record user_id in feedback_reports, with the
  // body's "**Source:**" line as a compatibility fallback. GitHub-native
  // issues match neither and stay read-only — author-only by design, no admin
  // override.
  // ----------------------------------------------------------------
  router.patch('/api/apps/:slug/github-issues/:number/title', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    const rawTitle = req.body?.title;
    const newTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!newTitle) return res.status(400).json({ error: 'Title required' });
    if (newTitle.length > MAX_ISSUE_TITLE_LENGTH) {
      return res.status(400).json({
        error: `Title too long (max ${MAX_ISSUE_TITLE_LENGTH} chars)`,
      });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo —
      // same policy as the bounty route: fetchPublicIssues never throws;
      // a degraded fetch (note) means no positive confirmation, so refuse
      // and change nothing. The snapshot also yields the old title + body.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now: GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
      if (!target) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const isAuthor = await isIssueAuthor(
        pool, app.id, parsed, issueNumber, req.user, target.body
      );
      if (!isAuthor) {
        return res.status(403).json({ error: "Only the issue's author can edit its title" });
      }

      const oldTitle = String(target.title || '');
      if (newTitle === oldTitle) {
        return res.json({ ok: true, unchanged: true, title: oldTitle });
      }

      // GitHub first — a failed PATCH must leave everything untouched.
      try {
        await github.patchIssueTitle(parsed.owner, parsed.repo, issueNumber, newTitle);
      } catch (err) {
        log.warn('issues', 'GitHub issue title PATCH failed', { issueNumber, message: err.message });
        return res.status(502).json({
          error: "Couldn't update the title on GitHub. Try again in a moment.",
        });
      }

      // Local mirror row (platform-filed issues only; no-op otherwise).
      await pool.query(
        `UPDATE issues SET title = $3 WHERE app_id = $1 AND github_issue_number = $2`,
        [app.id, issueNumber, newTitle]
      ).catch((err) => log.warn('issues', 'Local issue title update failed', { issueNumber, err: err.message }));

      // A pending auto-title heal must not overwrite the author's choice.
      await pool.query(
        `DELETE FROM title_heal_queue WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
        [parsed.owner, parsed.repo, issueNumber]
      ).catch((err) => log.warn('issues', 'title_heal_queue cleanup failed', { issueNumber, err: err.message }));

      // On-the-record rename note in the issue's own thread. Thread-only —
      // renames are issue-local housekeeping, unlike creation's dual-post.
      await sendSystemMessage(pool, app.id,
        `${req.user.username} changed the title from "${oldTitle}" to "${newTitle}"`,
        'system', null, { type: 'issue', ref: issueNumber }
      ).catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));

      github.invalidateIssuesCache(parsed.owner, parsed.repo);
      pushIssueUpdate({
        action: 'updated', source: 'github',
        appSlug: app.slug, appId: app.id, issueNumber,
      });

      log.info('issues', 'Issue title edited', { appId: app.id, issueNumber, by: req.user.username });
      res.json({ ok: true, title: newTitle });
    } catch (err) {
      log.error('issues', 'Issue title edit failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // PATCH /api/apps/:slug/github-issues/:number/body
  //
  // #2427: author-only editing of an open GitHub issue's Markdown body from
  // its Homeroom topic. This deliberately mirrors the title route's access,
  // open-issue verification and authorship rules. GitHub remains the source
  // of truth: it is written first, then the optional local mirror, thread
  // audit note, cache and live viewers are updated best-effort.
  // ----------------------------------------------------------------
  router.patch('/api/apps/:slug/github-issues/:number/body', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    const rawBody = req.body?.body;
    if (typeof rawBody !== 'string') {
      return res.status(400).json({ error: 'Body must be a string' });
    }
    if (rawBody.length > MAX_ISSUE_BODY_LENGTH) {
      return res.status(400).json({
        error: `Body too long (max ${MAX_ISSUE_BODY_LENGTH} chars)`,
      });
    }
    const newBody = github.safeMention(rawBody);

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now: GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
      if (!target) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const isAuthor = await isIssueAuthor(
        pool, app.id, parsed, issueNumber, req.user, target.body
      );
      if (!isAuthor) {
        return res.status(403).json({ error: "Only the issue's author can edit its body" });
      }

      const oldBody = String(target.body || '');
      if (newBody === oldBody) {
        return res.json({ ok: true, unchanged: true, body: oldBody });
      }

      try {
        await github.patchIssueBody(parsed.owner, parsed.repo, issueNumber, newBody);
      } catch (err) {
        log.warn('issues', 'GitHub issue body PATCH failed', { issueNumber, message: err.message });
        return res.status(502).json({
          error: "Couldn't update the body on GitHub. Try again in a moment.",
        });
      }

      await pool.query(
        `UPDATE issues SET description = $3 WHERE app_id = $1 AND github_issue_number = $2`,
        [app.id, issueNumber, newBody]
      ).catch((err) => log.warn('issues', 'Local issue body update failed', { issueNumber, err: err.message }));

      await sendSystemMessage(pool, app.id,
        `${req.user.username} edited the issue description`,
        'system', null, { type: 'issue', ref: issueNumber }
      ).catch((err) => log.warn('issues', 'Issue body chat message failed', { err: err.message }));

      github.invalidateIssuesCache(parsed.owner, parsed.repo);
      pushIssueUpdate({
        action: 'updated', source: 'github',
        appSlug: app.slug, appId: app.id, issueNumber,
      });

      log.info('issues', 'Issue body edited', { appId: app.id, issueNumber, by: req.user.username });
      res.json({ ok: true, body: newBody });
    } catch (err) {
      log.error('issues', 'Issue body edit failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // POST /api/apps/:slug/issues/:number/bounty
  //
  // Place a "Give kudos" bounty on a GitHub issue. A bounty is a symbolic
  // off-chain pledge (no tokens) that debits the giver's SHARED weekly kudos
  // allowance (the same WEEKLY_KUDOS_LIMIT cap PR kudos uses, counted across
  // both ledgers). When a merged PR closes this issue, the open bounty is
  // awarded to that PR's author (see routes/votes.js checkAndMerge).
  //
  // The same pledge can also be made at issue-CREATION time, from the Send
  // Feedback dialog's "Put a kudos bounty on this" checkbox — both surfaces
  // run services/bounties.js placeBounty, so the ledger row, the chat posts
  // and the WS broadcast are identical whichever one was used.
  //
  // Status codes:
  //   200 ok        — bounty recorded; body carries { remaining, limit }
  //   400 bad input — non-positive issue number
  //   404 not_found — app doesn't exist
  //   409 conflict  — viewer already has an open bounty on this issue
  //   429 too_many  — shared weekly kudos allowance exhausted
  // ----------------------------------------------------------------
  router.post('/api/apps/:slug/issues/:number/bounty', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo BEFORE
      // spending quota, inserting a row, or posting chat noise. Otherwise a
      // user could bounty a closed/nonexistent issue and a later PR carrying
      // `Closes #N` would award that fake/stale bounty. fetchPublicIssues
      // never throws and surfaces degraded fetches via a `note`; if we can't
      // positively confirm the issue is open (closed, nonexistent, or GitHub
      // unavailable) we refuse and change nothing.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now: GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        // 'rate limited' / 'issues unavailable' / 'fetch failed' — no
        // positive confirmation the issue is open.
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const isOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!isOpen) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      // Ledger + side effects live in services/bounties.js, shared with the
      // Send Feedback dialog's create-with-bounty path (POST /api/feedback).
      // This route keeps what is ITS OWN: the collab gate and the
      // open-issue verification above, plus the status-code mapping below.
      const result = await placeBounty(pool, {
        app, user: req.user, issueNumber,
      });
      if (!result.ok) {
        const status = result.code === 'quota' ? 429 : 409;
        const body = { error: result.error };
        // The quota response has always carried the budget figures; the
        // duplicate one never did. Keep both shapes exactly as they were.
        if (result.code === 'quota') {
          body.remaining = result.remaining;
          body.limit = result.limit;
        }
        return res.status(status).json(body);
      }

      res.json({
        ok: true,
        bountyId: result.bountyId,
        bountyCount: result.bountyCount,
        remaining: result.remaining,
        limit: result.limit,
      });
    } catch (err) {
      log.error('issues', 'Bounty create failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // POST /api/apps/:slug/github-issues/:number/claim
  //
  // Manually mark a GitHub issue "In progress" for the calling user. An
  // issue can hold many concurrent claims — at most one per user — so
  // this is a plain upsert of the CALLER's own claim: first click
  // creates it, any later click renews it (fresh TTL clock), other
  // users' claims are untouched and irrelevant (no 409, ever). The
  // target must be a currently-open GitHub issue — same positive-
  // confirmation policy as the bounty route above. A successful claim also
  // moves the caller's assignee vote to their own username, so taking the
  // work and assigning it are one gesture. Both writes are platform-local:
  // no GitHub write. Expiry is a read-time filter in the /github-issues
  // enrichment (ISSUE_CLAIM_TTL_DAYS).
  // ----------------------------------------------------------------
  router.post('/api/apps/:slug/github-issues/:number/claim', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo —
      // fetchPublicIssues never throws; a degraded fetch (note) means no
      // positive confirmation, so refuse and change nothing.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now: GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const isOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!isOpen) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      // #2364: the upsert, the #1648 assignee vote, the thread note and the
      // push live in services/issue-claims.js, shared with the two routes
      // that start work on an issue.
      const { created, claimedAt } = await claimIssueForUser(pool, {
        app, issueNumber, user: req.user,
      });

      log.info('issues', created ? 'Issue claimed' : 'Issue claim renewed', {
        appId: app.id, issueNumber, by: req.user.username,
      });
      res.json({ ok: true, created, claimedAt });
    } catch (err) {
      log.error('issues', 'Issue claim failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // DELETE /api/apps/:slug/github-issues/:number/claim
  //
  // Clear an in-progress claim. With no body: the CALLER's own claim. A
  // write-capable admin may pass { userId } to clear another user's
  // stuck claim; anyone else passing a foreign userId gets 403 — each
  // claim belongs to its claimer, so the status can't be kicked back
  // and forth between users. Idempotent: clearing a nonexistent (or
  // already-expired-and-replaced) claim is a soft 200.
  // ----------------------------------------------------------------
  router.delete('/api/apps/:slug/github-issues/:number/claim', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const rawTarget = req.body && req.body.userId;
      const targetUserId = rawTarget != null ? parseInt(rawTarget, 10) : req.user.id;
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      if (targetUserId !== req.user.id && !req.user.canAdminWrite) {
        return res.status(403).json({ error: 'Only the claimer or an admin can clear this' });
      }

      const { rows } = await pool.query(
        `DELETE FROM issue_claims
          WHERE app_id = $1 AND github_issue_number = $2 AND user_id = $3
          RETURNING user_id`,
        [app.id, issueNumber, targetUserId]
      );
      const cleared = rows.length > 0;

      if (cleared) {
        const content = targetUserId === req.user.id
          // #1112: "released their claim" — the DELETE only ever removes one
          // person's claim, never the derived state the board used to call
          // "In progress".
          ? `${req.user.username} released their claim on this issue`
          : `${req.user.username} released someone else's claim on this issue`;
        await sendSystemMessage(pool, app.id, content,
          'system', null, { type: 'issue', ref: issueNumber }
        ).catch((err) => log.warn('issues', 'Claim-clear chat message failed', { err: err.message }));
        pushIssueUpdate({
          action: 'unclaimed', appSlug: app.slug, appId: app.id, issueNumber,
        });
        log.info('issues', 'Issue claim cleared', {
          appId: app.id, issueNumber, by: req.user.username, targetUserId,
        });
      }

      res.json({ ok: true, cleared });
    } catch (err) {
      log.error('issues', 'Issue claim clear failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin force-apply for secret_change proposals — the issue-side
  // counterpart of POST /api/sessions/:id/admin-merge. Lets an admin
  // apply an environment-variable proposal right now, bypassing the
  // active-user majority (and the locked-app admin-up gate, which is
  // trivially satisfied by the admin acting). Same visibility rules:
  // the chat message + GitHub comment name the admin so the override
  // is never silent.
  router.post('/api/issues/:id/admin-apply', async (req, res) => {
    try {
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.created_by AS app_created_by
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [req.params.id]
      );
      if (!issueRows.length) {
        if (!req.user?.canAdminWrite) {
          return res.status(403).json({ error: 'Full admin access required' });
        }
        return res.status(404).json({ error: 'Issue not found' });
      }
      const issue = issueRows[0];

      // This multiplexed route force-applies several governance kinds. Keep
      // the non-secret kinds available to the CLI, but never let api:access
      // become authority to apply a stored credential value.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      // #788: the issue-side counterpart of the force-merge widening —
      // an app's own declared admins may force-apply that app's
      // governance proposals. Issue proposals never carry the
      // explicit-approval flag (they don't edit dapp.json's admins
      // block; only a PR can), so no exception applies here.
      const appForGate = { id: issue.app_id, created_by: issue.app_created_by };
      if (!(await appAdmins.canForceMerge(pool, appForGate, req.user))) {
        return res.status(403).json({ error: 'Full admin access required' });
      }

      if (issue.status !== 'open') {
        return res.status(409).json({ error: 'Issue is not open' });
      }
      if (issue.kind !== 'secret_change' && issue.kind !== 'close_issue'
          && issue.kind !== 'maintenance_campaign' && issue.kind !== 'featured_illustration') {
        return res.status(400).json({ error: 'Only secret-change, close-issue, maintenance-campaign, and featured-illustration proposals can be admin-applied' });
      }
      // Campaigns are self-app governance with fleet-wide blast radius:
      // only a FULL platform admin may force one, never an app admin.
      if (issue.kind === 'maintenance_campaign' && !req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }

      log.info('issues', 'Admin force-apply requested', {
        issueId: issue.id, kind: issue.kind, by: req.user.username,
      });

      const applied = issue.kind === 'close_issue'
        ? await maybeApplyCloseIssueProposal(pool, issue, { force: true, forceBy: req.user })
        : issue.kind === 'maintenance_campaign'
          ? await maybeApplyMaintenanceCampaignProposal(config, pool, issue, { force: true, forceBy: req.user })
          : issue.kind === 'featured_illustration'
            ? await maybeApplyFeaturedIllustrationProposal(pool, issue, { force: true, forceBy: req.user })
            : await maybeApplySecretChangeProposal(config, pool, issue, { force: true, forceBy: req.user });

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id });

      res.json({
        ok: true,
        applied,
        // BC alias for clients written when only secret_change existed.
        secretChanged: issue.kind === 'secret_change' ? applied : null,
      });
    } catch (err) {
      log.error('issues', 'Admin force-apply failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Withdraw a governance proposal (secret_change / legacy rename). This was
  // originally an unguarded "close any issue" route with no caller; it is now
  // the creator-gated self-service withdraw for governance proposals (the
  // PR-proposal equivalent is POST /api/sessions/:id/archive). Only the
  // proposal's creator may withdraw, and only while it is still open, so a
  // stale double-tap or a race against a passing vote is a harmless no-op.
  router.post('/api/issues/:id/close', async (req, res) => {
    try {
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url AS repo_url
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [req.params.id]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];

      // Withdrawing a secret proposal changes credential state just as voting
      // or force-applying it does. Keep this multiplexed close route usable for
      // ordinary governance proposals, but not through a CLI bearer grant.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      // Creator-only. (Admins already have other paths — admin merge / direct
      // GitHub close — so the gate stays creator-scoped per the spec.)
      if (!issue.created_by || issue.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only the proposer can withdraw this proposal' });
      }

      // Restrict to open proposals: a withdraw that loses the race against a
      // passing vote (which flips status to 'closed') simply no-ops here.
      const auditPayload = {
        ...(issue.payload || {}),
        withdrawnAt: new Date().toISOString(),
        withdrawnBy: req.user.username,
      };
      const { rows } = await pool.query(
        `UPDATE issues SET status = 'closed', payload = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id, app_id`,
        [issue.id, JSON.stringify(auditPayload)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Proposal not open' });

      // Announce the withdrawal in group chat, and dual-post into the
      // proposal's governance thread (mirrors the create path).
      const withdrewMsg = `${req.user.username} withdrew their proposal: "${issue.title}"`;
      await sendSystemMessage(pool, issue.app_id, withdrewMsg, 'system')
        .catch((err) => log.warn('issues', 'Withdraw chat message failed', { err: err.message }));
      await sendSystemMessage(pool, issue.app_id, withdrewMsg, 'system',
        null, { type: 'governance', ref: issue.id }).catch(() => {});

      // Best-effort close the GitHub twin (legacy renames carry one;
      // secret_change proposals have no twin, so this is skipped silently).
      if (issue.github_issue_number) {
        const [, owner, repo] = (issue.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        const pat = process.env.GITHUB_BOT_TOKEN;
        if (owner && repo && pat) {
          try {
            const { Octokit } = await import('@octokit/rest');
            const ok = new Octokit({ auth: pat });
            await ok.rest.issues.update({
              owner, repo, issue_number: issue.github_issue_number, state: 'closed',
            });
          } catch (err) {
            log.warn('issues', 'GitHub issue close on withdraw failed', {
              issue: issue.github_issue_number, status: err.status, err: err.message || '(empty)',
            });
          }
        }
      }

      pushIssueUpdate({ action: 'closed', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('issues', 'Withdraw failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Check the up-vote tally against the active-user majority. If the threshold
// is met, apply the rename atomically (inside a txn guarded by SELECT FOR
// UPDATE on the issue row so two near-simultaneous tripping votes can't
// double-apply).
async function maybeApplyRenameProposal(pool, issue) {
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  // #646: governance-aware gate. Down votes feed both governance gates,
  // mirroring PRs; the window is anchored on the issue's created_at (no
  // separate promote step exists). Under 'invited' only approver votes
  // qualify; under at-least-N the gate is the clock-free count.
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = gate.required;
  // Apply paths mirror PR merges (services/active-users.js → mergeGate):
  // threshold met + window elapsed, OR the lazy-consensus clock elapsed
  // (unopposed support below threshold — silence is consent). Not yet →
  // leave the proposal open (the next vote, or the sweeper's
  // window-elapsed pass, re-checks).
  if (!gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked apps additionally require at least one admin up vote (see
  // services/admin-approval.js + the apps.locked column). The majority
  // gate above still has to pass — the admin up is an extra condition.
  if (await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Rename majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const locked = lockRows[0];

    const newName = (locked.payload?.newName || '').trim();
    if (!newName) {
      await client.query('ROLLBACK');
      log.warn('issues', 'Rename proposal missing newName', { issueId: issue.id });
      return { applied: false, upCount, majority, active };
    }

    const { rows: appRows } = await client.query(
      'SELECT id, name, slug FROM apps WHERE id = $1 FOR UPDATE',
      [locked.app_id]
    );
    if (!appRows.length) {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const app = appRows[0];
    const oldName = app.name;

    await client.query('UPDATE apps SET name = $1 WHERE id = $2', [newName, app.id]);

    const auditPayload = { ...locked.payload, appliedAt: new Date().toISOString(), appliedBy: 'group-vote', upCount, required, active };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + GitHub + WS) are best-effort and live outside the txn.
    const renamedMsg = `App renamed from "${oldName}" to "${newName}" by group vote (${upCount}/${required})`;
    await sendSystemMessage(pool, app.id, renamedMsg, 'system')
      .catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));
    // Dual-post the outcome into the governance proposal's thread.
    await sendSystemMessage(pool, app.id, renamedMsg, 'system',
      null, { type: 'governance', ref: locked.id }).catch(() => {});

    if (locked.github_issue_number) {
      // Prefer the PAT (bot token) here — its scopes are known-good for
      // issue mutation, whereas the GitHub App installation token may lack
      // `Issues: Write`. Close BEFORE commenting so a stale "renamed"
      // comment can't land on an issue we failed to close.
      const { rows: r } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]);
      const repoUrl = r[0]?.repo_url || '';
      const [, owner, repo] = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      const pat = process.env.GITHUB_BOT_TOKEN;

      if (owner && repo && pat) {
        try {
          const { Octokit } = await import('@octokit/rest');
          const ok = new Octokit({ auth: pat });

          await ok.rest.issues.update({
            owner, repo, issue_number: locked.github_issue_number, state: 'closed',
          });
          log.info('issues', 'GitHub issue closed', {
            repo: `${owner}/${repo}`, issue: locked.github_issue_number,
          });

          // Best-effort audit comment after the close succeeds.
          await ok.rest.issues.createComment({
            owner, repo, issue_number: locked.github_issue_number,
            body: github.safeMention(`Applied by group vote (${upCount}/${required}). App renamed to "${newName}".`),
          }).catch((err) => log.warn('issues', 'Rename comment failed', {
            issue: locked.github_issue_number, status: err.status, err: err.message,
          }));
        } catch (err) {
          log.warn('issues', 'GitHub issue close failed', {
            issue: locked.github_issue_number,
            status: err.status,
            err: err.message || '(empty)',
          });
        }
      } else if (locked.github_issue_number) {
        log.warn('issues', 'Skipping GitHub issue close (missing repo_url or GITHUB_BOT_TOKEN)', {
          issue: locked.github_issue_number, repoUrl, hasPat: !!pat,
        });
      }
    }

    pushAppUpdate({ action: 'renamed', appId: app.id, slug: app.slug, oldName, newName });

    log.info('issues', 'Rename applied', { appId: app.id, oldName, newName, upCount, active });
    return { applied: true, newName, oldName, upCount, majority, active };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Rename apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Vote-apply path for `kind='featured_illustration'` issues (#2086). Same
 * shape as maybeApplyRenameProposal, the card it is modelled on: gate
 * check, lock the issue row, write the proposed record onto the app
 * (services/illustration-proposals.js applyProposal) and stamp the audit
 * payload, all in one transaction; then chat + WS outside it.
 *
 * `options.force` (admin force-apply, POST /api/issues/:id/admin-apply)
 * skips the majority and locked-app gates, like the other kinds.
 */
async function maybeApplyFeaturedIllustrationProposal(pool, issue, options = {}) {
  const force = !!options.force;
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked apps additionally require at least one admin up vote, the same
  // rule as the rename path. An admin force-apply trivially satisfies it.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Illustration majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const locked = lockRows[0];

    const { rows: appRows } = await client.query(
      'SELECT id, slug, name FROM apps WHERE id = $1 FOR UPDATE',
      [locked.app_id]
    );
    if (!appRows.length) {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const app = appRows[0];

    const illustration = await illustrationProposals.applyProposal(
      client, app.id, locked.payload || {}, locked.id
    );

    const auditPayload = {
      ...locked.payload,
      appliedAt: new Date().toISOString(),
      appliedBy: force ? `admin:${options.forceBy?.username || 'unknown'}` : 'group-vote',
      upCount, required, active,
    };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + WS) are best-effort and live outside the txn.
    const appliedHow = force
      ? `by admin override (${options.forceBy?.username || 'admin'})`
      : `by group vote (${upCount}/${required})`;
    const msg = illustration
      ? `Featured illustration changed ${appliedHow}`
      : `Featured illustration removed ${appliedHow}`;
    await sendSystemMessage(pool, app.id, msg, 'system')
      .catch((err) => log.warn('issues', 'Illustration chat message failed', { err: err.message }));
    await sendSystemMessage(pool, app.id, msg, 'system',
      null, { type: 'governance', ref: locked.id }).catch(() => {});

    pushAppUpdate({ action: 'illustration_changed', appId: app.id, slug: app.slug, illustration });
    pushIssueUpdate({ action: 'closed', appSlug: app.slug, appId: app.id, issueId: locked.id });

    log.info('issues', 'Featured illustration proposal applied', {
      appId: app.id, issueId: locked.id, removed: !illustration, force, upCount, active,
    });
    return { applied: true, illustration, upCount, majority, active };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Illustration apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Vote-apply path for `kind='secret_change'` issues. Same shape as
 * maybeApplyRenameProposal: count up-votes, lock the issue row, write
 * the change atomically, then trigger an async production rebuild so
 * the new value reaches the running container without a manual step.
 *
 * TWO STORES, ONE PATH. For an ordinary app the write lands in
 * `app_secrets` and is followed by a production rebuild. For the
 * SELF-HOSTED app it lands in `platform_env_values` through the
 * platform-env DAO and is followed by NOTHING: the platform's env is
 * materialized by its own deploy (scripts/dump-platform-env.js writes
 * /opt/usernode/.env), so the value goes live on the next deploy.
 * Calling staging.rebuildProduction() on the self-app row would try to
 * rebuild the platform as if it were a child container — exactly what
 * refuseIfSelfHosted() prevents on the direct route in routes/apps.js —
 * so the branch below skips it. That is not an optimization; it is the
 * whole reason this function has to know which app it is applying to.
 *
 * `options.force` (admin force-apply, POST /api/issues/:id/admin-apply):
 * skip the majority + locked-app gates entirely — the row lock below
 * still prevents a double-apply racing a vote-driven one. `options.forceBy`
 * is the admin user (id, username) named in the chat message, audit
 * payload, and GitHub comment so the override is visible.
 */
async function maybeApplySecretChangeProposal(config, pool, issue, options = {}) {
  const force = !!options.force;
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  // Resolved BEFORE the transaction so both the write branch and the
  // side-effect branch read the same flag. A missing row can't happen
  // (the issue FKs to it) but degrade to the ordinary app path rather
  // than throwing if it somehow does.
  const { rows: appRows } = await pool.query(
    'SELECT id, self_hosted FROM apps WHERE id = $1',
    [issue.app_id]
  );
  const selfHosted = !!appRows[0]?.self_hosted;

  // #646: governance-aware gate (down votes feed both gates, anchored
  // on created_at). An admin force-apply skips it, like force-merge.
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  // Same two apply paths as maybeApplyRenameProposal (threshold or lazy
  // consensus); an admin force-apply skips both, like force-merge.
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked apps additionally require at least one admin up vote (see
  // services/admin-approval.js + the apps.locked column). Same rule as
  // the rename path above. An admin force-apply trivially satisfies it.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Secret-change majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const locked = lockRows[0];
    const payload = locked.payload || {};
    const key = (payload.key || '').trim();
    const action = payload.action === 'delete' ? 'delete' : 'set';
    if (!key) {
      await client.query('ROLLBACK');
      log.warn('issues', 'Secret-change proposal missing key', { issueId: issue.id });
      return { applied: false, upCount, majority, active };
    }

    // A declaration can change under an open proposal (the manifest edit
    // that makes a key deploy-owned merges while the vote runs). Refuse
    // rather than write, and CLOSE the issue — leaving it open would re-run
    // this failure, and re-post its message, on every subsequent vote.
    if (selfHosted && !platformEnv.isWritableKey(key)) {
      const refusedPayload = {
        key, action,
        private: !!(payload.private || payload.sensitive),
        sensitive: !!(payload.private || payload.sensitive),
        valueLast4: null,
        appliedAt: new Date().toISOString(),
        appliedBy: 'refused:unwritable',
        upCount, required, active,
      };
      await client.query(
        `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
        [JSON.stringify(refusedPayload), locked.id]
      );
      await client.query('COMMIT');
      log.warn('issues', 'Secret-change refused: key is not writable', {
        issueId: issue.id, key,
      });
      const refusedMsg = `Proposal for "${key}" was closed without applying: that variable is `
        + 'now set by the deploy from a GitHub secret and cannot be written here.';
      await sendSystemMessage(pool, issue.app_id, refusedMsg, 'system').catch(() => {});
      await sendSystemMessage(pool, issue.app_id, refusedMsg, 'system',
        null, { type: 'governance', ref: locked.id }).catch(() => {});
      return { applied: false, refused: true, upCount, majority, active };
    }

    if (action === 'set') {
      const valueEnc = payload.valueEnc || null;
      const plaintext = valueEnc ? decrypt(valueEnc, config.dataEncryptionKey) : null;
      if (!plaintext) {
        await client.query('ROLLBACK');
        log.warn('issues', 'Secret-change proposal could not decrypt value', { issueId: issue.id });
        return { applied: false, upCount, majority, active };
      }
      if (selfHosted) {
        // Through the DAO, not raw SQL: it re-encrypts with a fresh IV,
        // re-checks isWritableKey, and derives `private` (and therefore
        // whether a last-4 is kept) from the DECLARATION rather than from
        // the proposal payload — so a proposal can't smuggle in a
        // classification the manifest doesn't agree with.
        await platformEnv.setValue(client, issue.app_id, key, plaintext, {
          userId: locked.created_by || null,
          dataKey: config.dataEncryptionKey,
        });
      } else {
        // Read canonical `private`, fall back to `sensitive` for issues
        // proposed by an older build before the field was renamed.
        const isPrivate = !!(payload.private || payload.sensitive);
        const valueLast4 = isPrivate ? null : plaintext.slice(-4);
        // Re-encrypt to ensure the stored row uses a fresh IV (the
        // payload ciphertext was captured at proposal time).
        const reEnc = encrypt(plaintext, config.dataEncryptionKey);
        await client.query(
          `INSERT INTO app_secrets (app_id, key, value_enc, value_last4, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (app_id, key)
           DO UPDATE SET value_enc = EXCLUDED.value_enc,
                         value_last4 = EXCLUDED.value_last4,
                         updated_at = NOW(),
                         updated_by = EXCLUDED.updated_by`,
          [issue.app_id, key, reEnc, valueLast4, locked.created_by || null]
        );
      }
    } else if (selfHosted) {
      await platformEnv.deleteValue(client, issue.app_id, key);
    } else {
      await client.query(
        'DELETE FROM app_secrets WHERE app_id = $1 AND key = $2',
        [issue.app_id, key]
      );
    }

    // Strip the ciphertext from the audit-trail payload so a closed
    // issue doesn't leave behind any reversible data. The audit
    // metadata (who, when, how many votes) is what matters here.
    const auditPayload = {
      key, action,
      private: !!(payload.private || payload.sensitive),
      sensitive: !!(payload.private || payload.sensitive),
      valueLast4: payload.valueLast4 || null,
      appliedAt: new Date().toISOString(),
      appliedBy: force ? `admin:${options.forceBy?.username || 'unknown'}` : 'group-vote',
      upCount, required, active,
    };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + redeploy + GitHub close) live outside the txn.
    const verb = action === 'delete' ? 'removed' : 'set';
    const appliedHow = force
      ? `by admin override (${options.forceBy?.username || 'admin'})`
      : `by group vote (${upCount}/${required})`;
    // Say what actually happens next. Promising a redeploy the platform
    // path deliberately doesn't perform is how someone concludes the
    // feature is broken while watching for an immediate change.
    const secretMsg = selfHosted
      ? `Platform variable "${key}" ${verb} ${appliedHow}; takes effect on the platform's next deploy.`
      : `Secret "${key}" ${verb} ${appliedHow}; redeploying…`;
    await sendSystemMessage(pool, issue.app_id, secretMsg, 'system')
      .catch((err) => log.warn('issues', 'Secret-change chat msg failed', { err: err.message }));
    // Dual-post the outcome into the governance proposal's thread.
    await sendSystemMessage(pool, issue.app_id, secretMsg, 'system',
      null, { type: 'governance', ref: locked.id }).catch(() => {});

    if (selfHosted) {
      // One event type for a platform-variable change regardless of which
      // path wrote it, so the audit trail reads as one series. The value is
      // never carried — only the key, its privacy flag and how it applied.
      events.record(pool, {
        type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
        userId: force ? (options.forceBy?.id || null) : (locked.created_by || null),
        appId: issue.app_id,
        metadata: {
          key,
          action: action === 'delete' ? 'clear' : 'set',
          private: !!(payload.private || payload.sensitive),
          appliedBy: force ? 'admin-force-apply' : 'group-vote',
        },
      });
    } else {
      // Auto-redeploy: same fan-out the drift poller and dev-chat merge use.
      // Failures (including MissingSecretsError if the dapp still requires
      // additional unset keys) propagate via the existing deploy-status
      // broadcast and don't poison the vote-apply success.
      //
      // NEVER for the self-hosted row: rebuildProduction() would treat the
      // platform like a child container (see this function's header).
      pool.query('SELECT * FROM apps WHERE id = $1', [issue.app_id])
        .then(({ rows }) => rows[0] && staging.rebuildProduction(config, rows[0]))
        .then(async (result) => {
          if (!result) return;
          await pool.query(
            `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                             last_deploy_at = NOW()
             WHERE id = $3`,
            [result.containerId, result.sha || null, issue.app_id]
          );
        })
        .catch((err) => {
          log.warn('issues', 'Post-secret-change redeploy failed', {
            slug: issue.app_slug, err: err.message,
          });
        });
    }

    if (locked.github_issue_number) {
      const { rows: r } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [issue.app_id]);
      const repoUrl = r[0]?.repo_url || '';
      const [, owner, repo] = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      const pat = process.env.GITHUB_BOT_TOKEN;
      if (owner && repo && pat) {
        try {
          const { Octokit } = await import('@octokit/rest');
          const ok = new Octokit({ auth: pat });
          await ok.rest.issues.update({
            owner, repo, issue_number: locked.github_issue_number, state: 'closed',
          });
          await ok.rest.issues.createComment({
            owner, repo, issue_number: locked.github_issue_number,
            body: github.safeMention(
              force
                ? `Applied by admin override (${options.forceBy?.username || 'admin'}). Secret "${key}" ${verb}.`
                : `Applied by majority vote (${upCount}/${active}). Secret "${key}" ${verb}.`
            ),
          }).catch(() => {});
        } catch (err) {
          log.warn('issues', 'GitHub issue close (secret-change) failed', {
            issue: locked.github_issue_number, err: err.message,
          });
        }
      }
    }

    log.info('issues', 'Secret change applied', { appId: issue.app_id, key, action, upCount, active, force });
    return { applied: true, key, action, upCount, majority, active, force };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Secret-change apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Auto-resolve open close-issue proposals whose target was closed by other
 * means (a merged PR carrying `Closes #N`, or a manual close on GitHub).
 * Called from the merge path (routes/votes.js checkAndMerge), the post-merge
 * issue-close watcher, and maybeApplyCloseIssueProposal's superseded guard.
 *
 * `cause` is { kind: 'pr-merge', prNumber } or { kind: 'github-close' } and
 * drives both the audit payload's supersededBy value and the chat wording.
 *
 * Race-safe: each row flips via a single `WHERE status = 'open'` UPDATE (the
 * same guard the withdraw route uses), so a concurrent vote-apply or
 * withdraw that wins produces zero rows here and no duplicate messages.
 * Best-effort throughout — never throws; callers must never be failed by it.
 * No GitHub writes (the issue is already closed; the proposer's reason is
 * NOT posted — the group never approved it) and no bounty changes.
 */
async function resolveSupersededCloseProposals(pool, { appId, appSlug, numbers, cause } = {}) {
  const nums = (Array.isArray(numbers) ? numbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);
  const resolved = [];
  if (!appId || !nums.length) return { resolved };

  try {
    const { rows } = await pool.query(
      `SELECT id, app_id, payload FROM issues
        WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
          AND (payload->>'issueNumber')::int = ANY($2::int[])`,
      [appId, nums]
    );

    const supersededBy = cause?.kind === 'pr-merge'
      ? `pr-merge:#${cause.prNumber}`
      : 'github-close';

    for (const row of rows) {
      const n = Number(row.payload?.issueNumber);
      const auditPayload = {
        ...(row.payload || {}),
        supersededAt: new Date().toISOString(),
        supersededBy,
      };
      const { rows: updated } = await pool.query(
        `UPDATE issues SET status = 'closed', payload = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [row.id, JSON.stringify(auditPayload)]
      );
      if (!updated.length) continue; // lost the race to a vote-apply/withdraw

      resolved.push(row.id);
      const msg = cause?.kind === 'pr-merge'
        ? `Close proposal for issue #${n} resolved automatically: PR #${cause.prNumber} closed the issue`
        : `Close proposal for issue #${n} resolved automatically: the issue was closed on GitHub`;
      await sendSystemMessage(pool, row.app_id, msg, 'system')
        .catch((err) => log.warn('issues', 'Superseded chat message failed', { err: err.message }));
      await sendSystemMessage(pool, row.app_id, msg, 'system',
        null, { type: 'governance', ref: row.id }).catch(() => {});
      // Same event the withdraw path emits — open clients drop the card and
      // the target issue's row reverts to "Propose to close".
      pushIssueUpdate({ action: 'closed', appSlug: appSlug || null, appId: row.app_id, issueId: row.id });
      log.info('issues', 'Close proposal superseded', {
        issueId: row.id, appId: row.app_id, target: n, supersededBy,
      });
    }
  } catch (err) {
    log.warn('issues', 'Superseded close-proposal resolve failed', {
      appId, numbers: nums, err: err.message,
    });
  }
  return { resolved };
}

/**
 * Vote-apply path for `kind='close_issue'` issues. Same shape as
 * maybeApplyRenameProposal: gate check, lock the issue row, mark the
 * proposal closed atomically, then best-effort side effects (chat, GitHub
 * close + explanation comment, bounty voiding, cache/UI sync).
 *
 * Runs a SUPERSEDED GUARD first, on every invocation (including
 * non-mergeable sweeper calls): when a healthy cached open-issues fetch
 * shows the target is no longer open, the proposal is resolved as
 * superseded instead of applied — this doubles as the hourly catch-all for
 * issues closed by hand on GitHub.
 *
 * `options.force` (admin force-apply) skips the majority + locked-app gates,
 * like the secret-change path; the row lock still prevents a double-apply.
 */
async function maybeApplyCloseIssueProposal(pool, issue, options = {}) {
  const force = !!options.force;
  const issueNumber = Number(issue.payload?.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    log.warn('issues', 'Close proposal missing issueNumber', { issueId: issue.id });
    return { applied: false, error: 'missing issueNumber' };
  }

  // Repo coordinates for the superseded guard and the GitHub close below.
  // (The vote route's issue row carries app_slug but not repo_url.)
  const { rows: appRows } = await pool.query(
    'SELECT slug, repo_url FROM apps WHERE id = $1',
    [issue.app_id]
  );
  const appSlug = issue.app_slug || appRows[0]?.slug || null;
  const parsed = parseOwnerRepo(appRows[0]?.repo_url);

  // Superseded guard: a healthy fetch (no degradation note) that doesn't
  // list the target means it was already closed by other means — retire the
  // proposal instead of applying. A degraded fetch skips the guard and
  // proceeds optimistically.
  if (github.isEnabled() && parsed) {
    const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
    if (!ghResult.note) {
      const stillOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!stillOpen) {
        await resolveSupersededCloseProposals(pool, {
          appId: issue.app_id,
          appSlug,
          numbers: [issueNumber],
          cause: { kind: 'github-close' },
        });
        return { applied: false, superseded: true };
      }
    }
  }

  // #646: governance-aware gate (down votes feed both gates, anchored
  // on created_at). An admin force-apply skips it, like force-merge.
  const { majority } = await getActiveUserStats(pool, issue.app_id);
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked apps additionally require at least one admin up vote — same rule
  // as the rename/secret paths. An admin force-apply trivially satisfies it.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Close-issue majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  const client = await pool.connect();
  let locked;
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    locked = lockRows[0];

    const auditPayload = {
      ...(locked.payload || {}),
      appliedAt: new Date().toISOString(),
      appliedBy: force ? `admin:${options.forceBy?.username || 'unknown'}` : 'group-vote',
      upCount, required, active,
    };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    // Also close any internal open twin rows for the target (a platform-
    // filed 'general' issue whose GitHub twin is the number being closed),
    // so creator-attribution rows don't linger open.
    await client.query(
      `UPDATE issues SET status = 'closed'
        WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open' AND id <> $3`,
      [issue.app_id, issueNumber, locked.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Close-issue apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }

  // ---- Side effects: best-effort, outside the txn. ----

  // #1010: announce the decision the moment it is DURABLE, ahead of the
  // bounty/chat/GitHub tail below. Two reasons the old single broadcast at
  // the very end wasn't enough: (1) it sat behind the GitHub close+comment
  // round-trips, so every open card kept rendering the proposal as live for
  // seconds after it was decided, and (2) it lived inside the
  // `github.isEnabled() && parsed` branch — an app with GitHub off or an
  // unparsable repo_url got NO event at all and its cards lingered until a
  // manual reload. Same event shape the withdraw path emits, so clients need
  // no new handling; the trailing `github_synced` push stays where it is
  // (it additionally means "the open-issues cache is now correct").
  try {
    pushIssueUpdate({
      action: 'closed', appSlug, appId: issue.app_id, issueId: locked.id,
    });
  } catch (err) {
    log.warn('issues', 'Close-issue applied broadcast failed', {
      issueId: locked.id, err: err.message,
    });
  }

  // Void open bounties on the target: the issue is closing without a merged
  // PR, so no one earns the kudos — and an 'open' row would linger forever
  // and keep inflating the issue's bounty count (same rationale as the
  // self-bounty voiding in routes/votes.js resolveIssueBounty). Allowance
  // slots stay forfeited, consistent with existing policy.
  try {
    await pool.query(
      `UPDATE issue_bounties SET status = 'voided', awarded_at = NOW()
        WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
      [issue.app_id, issueNumber]
    );
  } catch (err) {
    log.warn('issues', 'Bounty voiding on close-issue apply failed', {
      issueId: issue.id, issueNumber, err: err.message,
    });
  }

  const appliedHow = force
    ? `by admin override (${options.forceBy?.username || 'admin'})`
    : `by group vote (${upCount}/${required})`;
  const closedMsg = `Issue #${issueNumber} closed ${appliedHow}`;
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system')
    .catch((err) => log.warn('issues', 'Close-issue chat msg failed', { err: err.message }));
  // Dual-post the outcome into the proposal's governance thread AND the
  // target issue's thread (mirrors the create path's dual-post).
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system',
    null, { type: 'governance', ref: locked.id }).catch(() => {});
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system',
    null, { type: 'issue', ref: issueNumber }).catch(() => {});

  // GitHub: close FIRST, then comment (same ordering rationale as the
  // rename path — a stale "closed by vote" comment must not land on an
  // issue we failed to close). Both helpers route through getOctokit
  // (PAT-preferred) and safeMention.
  if (github.isEnabled() && parsed) {
    try {
      await github.closeIssue(parsed.owner, parsed.repo, issueNumber);

      let commentBody = force
        ? `Closed by admin override (${options.forceBy?.username || 'admin'}) on Homeroom.`
        : `Closed by group vote (${upCount}/${required}) on Homeroom.`;
      const reason = typeof locked.payload?.reason === 'string'
        ? locked.payload.reason.trim() : '';
      if (reason) {
        let proposerName = null;
        try {
          const { rows: userRows } = await pool.query(
            'SELECT username FROM users WHERE id = $1', [locked.created_by]
          );
          proposerName = userRows[0]?.username || null;
        } catch {}
        commentBody += `\n\n${proposerName || 'The proposer'}'s reason: ${reason}`;
      }
      await github.createIssueComment(parsed.owner, parsed.repo, issueNumber, commentBody)
        .catch((err) => log.warn('issues', 'Close-issue comment failed', {
          issue: issueNumber, status: err.status, err: err.message,
        }));
    } catch (err) {
      log.warn('issues', 'GitHub issue close (close-issue vote) failed', {
        issue: issueNumber, status: err.status, err: err.message || '(empty)',
      });
    }

    // Cache/UI sync (mirrors the issue-close watcher's bustAndBroadcast):
    // suppress the number so the eventually-consistent GitHub list can't
    // resurrect it, bust the cache, and tell every open panel to refetch.
    try {
      github.noteIssuesClosed(parsed.owner, parsed.repo, [issueNumber]);
      github.invalidateIssuesCache(parsed.owner, parsed.repo);
      pushIssueUpdate({
        action: 'github_synced',
        appSlug,
        appId: issue.app_id,
        source: 'close_issue_vote',
      });
    } catch (err) {
      log.warn('issues', 'Cache bust after close-issue apply failed', {
        issueNumber, err: err.message,
      });
    }
  }

  log.info('issues', 'Close-issue proposal applied', {
    issueId: issue.id, appId: issue.app_id, issueNumber, upCount, active, force,
  });
  return { applied: true, issueNumber, upCount, majority, active, force };
}

/**
 * Vote-apply path for `kind='maintenance_campaign'` issues (#853's
 * generalization). Same shape as maybeApplySecretChangeProposal: gate,
 * lock the issue row, write the outcome atomically — here that's the
 * maintenance_campaigns row — then start the campaign engine
 * (services/fleet-maintenance.js) fire-and-forget. The engine is
 * restart-proof (per-app state in maintenance_campaign_apps + boot
 * resume), so "started but the process died" is not a lost campaign.
 *
 * `options.force` (admin force-apply): skip the vote gate; the route
 * has already verified FULL platform-admin rights for this kind.
 */
async function maybeApplyMaintenanceCampaignProposal(config, pool, issue, options = {}) {
  const force = !!options.force;
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked-app admin-up gate, parity with the other governance kinds.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  let campaignId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const locked = lockRows[0];
    const payload = locked.payload || {};
    const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';
    if (!instructions) {
      await client.query('ROLLBACK');
      log.warn('issues', 'Maintenance-campaign proposal missing instructions', { issueId: issue.id });
      return { applied: false, upCount, majority, active };
    }
    const campaignTitle = (typeof payload.title === 'string' && payload.title.trim())
      || locked.title.replace(/^Maintenance campaign:\s*/, '');
    const targetFilter = Array.isArray(payload.targetFilter) && payload.targetFilter.length
      ? payload.targetFilter : null;

    const { rows: campRows } = await client.query(
      `INSERT INTO maintenance_campaigns (issue_id, title, instructions, target_filter, status, created_by)
       VALUES ($1, $2, $3, $4, 'running', $5)
       RETURNING id`,
      [locked.id, String(campaignTitle).slice(0, 300), instructions,
        targetFilter ? JSON.stringify(targetFilter) : null, locked.created_by || null]
    );
    campaignId = campRows[0].id;

    await client.query(
      `UPDATE issues SET status = 'closed',
          payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [locked.id, JSON.stringify({
        campaignId,
        appliedAt: new Date().toISOString(),
        appliedBy: force ? `admin:${options.forceBy?.username || 'admin'}` : 'vote',
        upCount, required, active,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Maintenance-campaign apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }

  const appliedHow = force
    ? `by admin override (${options.forceBy?.username || 'admin'})`
    : `by group vote (${upCount}/${required})`;
  const startedMsg = `Maintenance campaign "${issue.payload?.title || issue.title}" approved ${appliedHow}. `
    + 'The platform is now opening one PR per app. Progress is on the campaign dashboard.';
  await sendSystemMessage(pool, issue.app_id, startedMsg, 'system')
    .catch((err) => log.warn('issues', 'Campaign chat msg failed', { err: err.message }));
  await sendSystemMessage(pool, issue.app_id, startedMsg, 'system',
    null, { type: 'governance', ref: issue.id }).catch(() => {});

  // Fire-and-forget: the engine owns its own error handling + resume.
  const fleetMaintenance = require('../services/fleet-maintenance');
  fleetMaintenance.runCampaign(config, pool, campaignId).catch((err) =>
    log.error('issues', 'Campaign run failed after apply', { campaignId, err: err.message }));

  log.info('issues', 'Maintenance-campaign proposal applied', {
    issueId: issue.id, campaignId, upCount, active, force,
  });
  return { applied: true, campaignId, upCount, majority, active, force };
}

module.exports = {
  issueRoutes,
  creatorFromSourceLine,
  shouldCreateGithubTwin,
  // Exported so the stale-PR sweeper can fire window-elapsed governance
  // applies (parity with PR window-elapsed merges).
  maybeApplyRenameProposal,
  maybeApplySecretChangeProposal,
  maybeApplyCloseIssueProposal,
  maybeApplyMaintenanceCampaignProposal,
  maybeApplyFeaturedIllustrationProposal,
  // Exported for the merge path and the issue-close watcher (auto-resolve
  // of close proposals whose target was closed by other means).
  resolveSupersededCloseProposals,
  // "In progress" derivation pieces, exported for unit tests.
  pickInProgressTarget,
  composeInProgress,
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
};
