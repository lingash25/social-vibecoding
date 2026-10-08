/**
 * The Profile screen's state, and the pure shaping that turns it into what
 * ./profile-view.tsx renders (#1191 slice 6, conversion 1).
 *
 * ── Me is the prototype's Me now ───────────────────────────────────────
 *
 * The screen the Me tab lands on was the older long Profile: identity,
 * public-profile controls, a points figure, rank, the token card, a points
 * breakdown, the completed challenges, then Platform and Account groups. The
 * navigation prototype's Me (`scrMe`) is a compact profile card, three stat
 * cards (merged, kudos, challenges), and lists of rows that say what is
 * behind them: "Your work" (Your changes, Your requests, Your votes) and
 * "More", since the UI overhaul, which also retired "Your contributions"
 * under them (Your changes lists every merged change) — and that is what
 * this file shapes now. Nothing that was here was dropped; each piece moved to the
 * place the prototype gives it:
 *
 *   points, rank, breakdown, token  → the Challenges tab's standing card
 *                                     (features/leaderboard/your-standing.tsx),
 *                                     behind "Challenges & standings"
 *   completed challenges            → the "challenges" stat card's count, and
 *                                     the Challenges tab, where each one is a
 *                                     card with its own page
 *   public-profile publishing       → the Edit profile sheet ("Public page")
 *   Settings                        → a "More" row, as before
 *   Admin & moderation, the node,
 *   wallet and staking rows, Log out → Settings (the spec's retired-chip table:
 *                                     "Me, with Admin and Validator inside
 *                                     Settings"), features/settings/account-rows.tsx
 *   the builder-profile chip        → the Kudos tab's builders, behind
 *                                     "Kudos" (it was "See all" on Your
 *                                     contributions until the UI overhaul)
 *
 * Plain JS, no React import, for the reason lib/plain-store.js documents: the
 * root test suite is `node --test` with no JSX transform, and
 * tests/topochain-profile-web.test.js and
 * tests/profile-completed-challenges.test.js read the real shipped source. Every
 * decision this screen makes about WHAT to show — which of the six load states
 * it is in, whether the token figure is gated or merely blurred, how a
 * completion row's meta line reads — is therefore in this file, where those
 * suites can still reach it. The .tsx beside it only turns the result into
 * elements.
 *
 * The initial state is `open: false`, which `buildProfileView` maps to a view of
 * kind `empty` and the component renders as no children at all. That is exactly
 * the empty `#profile-root` the hand-written shell shipped, which is what the
 * prerender pass emits and what hydration then has to match. Nothing here reads
 * `window`, `localStorage` or the clock at module scope for the same reason.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {Object} ProfileState
 * @property {boolean} open      — the #profile route is active
 * @property {any} data          — { ranking, summary, ownerPublicProfile, season }
 * @property {any} user          — a snapshot of App.user, taken by the controller
 * @property {string|null} pendingAvatarUrl — object URL of a staged photo
 * @property {boolean} pendingRemove        — the staged change is a deletion
 * @property {{url: string, width: number, height: number}|null} cropSource
 *   — the chosen photo while "Position your photo" is up (#3525): its object
 *   URL and decoded size. The File itself stays on Profile, as the staged
 *   Blob does.
 * @property {boolean} sheetOpen
 * @property {string} publicStatus
 * @property {boolean} publishing
 * @property {boolean} previewOpen
 * @property {number|null} friendsPending — the incoming request being answered (#2386)
 * @property {string} friendsStatus         — why the last answer failed, if it did
 * @property {boolean} feedbackOpen         — the "Your feedback" list is up (#3186)
 * @property {boolean} friendsOpen          — the Friends card is up (UI overhaul)
 */

export const profileStore = createStore(/** @type {ProfileState} */ ({
  open: false,
  data: null,
  user: null,
  pendingAvatarUrl: null,
  pendingRemove: false,
  cropSource: null,
  sheetOpen: false,
  publicStatus: '',
  publishing: false,
  previewOpen: false,
  friendsPending: null,
  friendsStatus: '',
  feedbackOpen: false,
  friendsOpen: false,
}));

/** Only ever render an http(s) URL as a real anchor. Escaping alone would not
 *  stop a `javascript:` href, which executes on click with no markup injection
 *  at all — the same discipline TopochainChallenges.safeHref applies. */
export function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** The name shown large on the card: the display name when set, else the
 *  @username. Never blank — a signed-in profile always has a username. */
export function displayNameOf(user) {
  const u = user || {};
  const name = u.displayName ? String(u.displayName).trim() : '';
  return name || (u.username ? `@${u.username}` : 'Your profile');
}

/**
 * The letter in the fallback circle. Takes the first LETTER OR DIGIT, not
 * simply the first character: a display name is free text, so it can easily
 * start with punctuation or an emoji ("[Staging demo] admin", "…hello") and a
 * circle reading "[" tells the viewer nothing. Falls back to the username,
 * then to '?'.
 */
export function initialOf(user) {
  const u = user || {};
  for (const src of [u.displayName, u.username]) {
    const match = String(src || '').match(/[\p{L}\p{N}]/u);
    if (match) return match[0].toUpperCase();
  }
  return '?';
}

/** A staged pick wins over the saved photo so the edit preview is live. */
export function avatarUrlOf(state) {
  const u = state.user || {};
  if (state.pendingAvatarUrl) return state.pendingAvatarUrl;
  if (state.pendingRemove) return null;
  return u.avatarUrl || null;
}

/** "today" / "3 days ago" / a plain date past a fortnight. Returns null for
 *  anything unparseable, so the caller just omits the segment. */
export function relativeDate(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch (_) {
    return null;
  }
}

/**
 * Flattens the /me/breakdown response (event | season | global scope) into
 * label/points rows: one per event, plus offchain points when present.
 */
export function breakdownRows(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return [];
  const rows = [];
  const pushEvent = (ev) => {
    if (!ev) return;
    const name = (ev.event && ev.event.name) || ev.event_name || 'Event';
    rows.push({ label: name, points: ev.total_points });
  };
  if (breakdown.scope === 'event') {
    pushEvent(breakdown);
  } else if (Array.isArray(breakdown.events)) {
    breakdown.events.forEach(pushEvent);
  } else if (Array.isArray(breakdown.seasons)) {
    for (const season of breakdown.seasons) {
      (season.events || []).forEach(pushEvent);
    }
  }
  if (Number(breakdown.offchain_points || 0) > 0) {
    rows.push({ label: 'Bonus points', points: breakdown.offchain_points });
  }
  return rows;
}

const CHIP_ZINC =
  'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
  'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 ' +
  'hover:bg-zinc-200 dark:hover:bg-zinc-700';

/** Provider links in both the owner's card and the public card. The server
 * supplies this `links` object exclusively from OAuth-backed identity rows;
 * keeping the word Verified in the label makes that boundary visible rather
 * than asking a reader to infer it from where the link appeared. */
export function verifiedSocialLinksView(profile) {
  const links = (profile && profile.links) || {};
  const rows = [];
  const add = (key, label, href) => {
    const safe = safeHref(href);
    if (safe) {
      rows.push({
        key, label, href: safe, external: true, className: CHIP_ZINC,
      });
    }
  };
  if (typeof links.github === 'string' && links.github) {
    add('github', `Verified GitHub · ${links.github}`,
      `https://github.com/${encodeURIComponent(links.github)}`);
  }
  if (typeof links.x === 'string' && links.x) {
    add('x', `Verified X · @${links.x}`,
      `https://x.com/${encodeURIComponent(links.x)}`);
  }
  return rows;
}

/** "Building since March 2026" — the prototype card's second line. */
export function memberSinceLabel(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  try {
    return `Building since ${new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
  } catch (_) {
    return null;
  }
}

/**
 * The identity card (#982) — who this profile belongs to. Compact now, as
 * the prototype draws it: the name, then ONE muted line of facts (the @handle
 * when a display name is the headline, how long they have been building, how
 * many apps they have shipped to), the bio, and the verified links.
 *
 * The "Your builder profile" chip left: it pointed at the viewer's proposed
 * PRs, which Your changes lists now.
 */
export function identityView(state) {
  const u = state.user || {};
  const summary = (state.data && state.data.summary) || null;
  const handle = (u.displayName && String(u.displayName).trim() && u.username)
    ? `@${u.username}` : null;
  const facts = [];
  if (handle) facts.push(handle);
  const since = summary ? memberSinceLabel(summary.memberSince) : null;
  if (since) facts.push(since);
  const apps = summary ? Number(summary.apps) || 0 : 0;
  if (apps > 0) facts.push(`${apps} app${apps === 1 ? '' : 's'}`);
  return {
    avatarUrl: avatarUrlOf(state),
    initial: initialOf(u),
    name: displayNameOf(u),
    handle,
    sub: facts.length ? facts.join(' · ') : null,
    bio: u.bio || null,
    chips: verifiedSocialLinksView(u),
  };
}

/**
 * The three stat cards (the prototype's `.stat`): merged, kudos, challenges.
 * From GET /api/me/summary. A read that failed or has not answered shows a
 * dash rather than a zero — a 0 would be a claim.
 */
export function statsView(summary) {
  const has = !!summary;
  const value = (n) => (has ? Number(n || 0).toLocaleString() : '–');
  return [
    { key: 'merged', value: value(summary && summary.merged), label: 'live' },
    { key: 'kudos', value: value(summary && summary.kudos), label: 'kudos' },
    {
      key: 'challenges',
      value: value(summary && summary.challenges && summary.challenges.done),
      label: 'challenges',
    },
  ];
}

/**
 * The "More" rows' second lines — each says what is behind its row, as the
 * prototype's do ("Season 3 · rank #3 · 2 of 3 this week", "3 received").
 * Null when there is nothing true to say yet.
 */
export function moreRowsView(data) {
  const d = data || {};
  const r = d.ranking || {};
  const summary = d.summary || null;
  const challenges = [];
  const seasonName = r.season_name || (summary && summary.challenges && summary.challenges.season
    && summary.challenges.season.name) || null;
  if (seasonName) challenges.push(seasonName);
  if (r.rank) challenges.push(`rank #${Number(r.rank)}`);
  if (summary && summary.challenges && Number(summary.challenges.total) > 0) {
    challenges.push(`${Number(summary.challenges.done || 0)} of ${Number(summary.challenges.total)} done`);
  }
  const kudos = summary ? Number(summary.kudos) || 0 : null;
  return {
    challenges: challenges.length ? challenges.join(' · ') : null,
    kudos: kudos == null ? null : `${kudos.toLocaleString()} received`,
    changes: changesLine(summary),
    requests: requestsLine(d.requests),
    votes: votesLine(d.votes),
    friends: friendsLine(d.friends),
    feedback: feedbackLine(d.feedback),
  };
}

// ── Your work's lines (UI overhaul) ─────────────────────────────────────
//
// Each says what is there in words, and a zero says nothing: "12 merged ·
// 2 in progress" drops the half that is zero, and when both are, the row
// falls back to saying what is behind it. Null whenever the read failed or
// has not answered, for the same reason.

/** "12 live · 2 in progress", from GET /api/me/summary. */
function changesLine(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const parts = [];
  const merged = Number(summary.merged) || 0;
  const underway = Number(summary.inProgress) || 0;
  if (merged) parts.push(`${merged.toLocaleString()} live`);
  if (underway) parts.push(`${underway.toLocaleString()} in progress`);
  return parts.length ? parts.join(' · ') : null;
}

/** "2 open · 1 done", from GET /api/me/requests. */
function requestsLine(requests) {
  if (!requests || typeof requests !== 'object' || !Array.isArray(requests.requests)) return null;
  const parts = [];
  const open = Number(requests.open) || 0;
  const done = Number(requests.done) || 0;
  if (open) parts.push(`${open.toLocaleString()} open`);
  if (done) parts.push(`${done.toLocaleString()} done`);
  return parts.length ? parts.join(' · ') : null;
}

/** "Latest: <what you voted on>", from GET /api/me/history?type=votes&limit=1. */
function votesLine(votes) {
  const item = votes && Array.isArray(votes.items) ? votes.items[0] : null;
  if (!item) return null;
  const title = voteTitle(item);
  return title ? `Latest: ${title}` : null;
}

/** "1 request waiting". Friends are never counted (#2386), only requests to answer. */
function friendsLine(friends) {
  const incoming = friends && Array.isArray(friends.incoming) ? friends.incoming.length : 0;
  if (!incoming) return null;
  return `${incoming.toLocaleString()} ${incoming === 1 ? 'request' : 'requests'} waiting`;
}

/** "4 sent · 1 counted", from GET /api/feedback/mine (#3186); "4 sent" while
 *  none has counted, since a zero says nothing. Null when the read failed or
 *  has not answered, so the row falls back to saying what is behind it rather
 *  than claiming none were sent. */
function feedbackLine(feedback) {
  if (!feedback || typeof feedback !== 'object' || !Number.isFinite(Number(feedback.sent))) return null;
  const sent = Number(feedback.sent) || 0;
  if (sent === 0) return 'Nothing sent yet';
  const counted = Number(feedback.counted) || 0;
  return counted
    ? `${sent.toLocaleString()} sent · ${counted.toLocaleString()} counted`
    : `${sent.toLocaleString()} sent`;
}

/** A report's status as the list says it. Two, not three: see
 *  MY_FEEDBACK_SQL in src/routes/feedback.js for why there is no "reviewed". */
const FEEDBACK_STATUS = {
  received: {
    label: 'Received',
    className: 'shrink-0 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-zinc-700 dark:text-zinc-300',
  },
  counted: {
    label: 'Counted',
    className: 'shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-emerald-700 dark:text-emerald-400',
  },
};

/** A slug the shell routes to, the shape an app slug has. Anything else gets
 *  no link at all rather than an address built from it. */
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * "Your feedback" (#3186): the viewer's own reports, newest first, from
 * GET /api/feedback/mine. Each row says what was sent (its title and where
 * it went), its status, and links to the request it became, on that app's
 * board. `loaded: false` is a read that failed, told apart from "nothing
 * sent yet".
 */
export function feedbackListView(feedback, now = Date.now()) {
  const valid = feedback && typeof feedback === 'object' && Array.isArray(feedback.reports);
  if (!valid) return { loaded: false, summary: null, truncated: false, rows: [] };
  const rows = feedback.reports.filter((r) => r && r.id != null).map((r) => {
    const status = r.status === 'counted' ? 'counted' : 'received';
    const issue = Number(r.issueNumber);
    const slug = typeof r.appSlug === 'string' && APP_SLUG.test(r.appSlug) ? r.appSlug : null;
    const linked = !!slug && Number.isSafeInteger(issue) && issue > 0;
    const meta = [r.appName ? String(r.appName) : (r.target === 'platform' ? 'Homeroom' : 'An app')];
    if (linked) meta.push(`request #${issue}`);
    const when = mergedAgo(r.createdAt, now);
    if (when) meta.push(`sent ${when}`);
    const points = Number(r.points);
    return {
      key: String(r.id),
      title: r.title ? String(r.title) : 'Feedback',
      meta: meta.join(' · '),
      status,
      statusLabel: status === 'counted' && points > 0
        ? `${FEEDBACK_STATUS.counted.label} · ${points.toLocaleString()} pts`
        : FEEDBACK_STATUS[status].label,
      statusClassName: FEEDBACK_STATUS[status].className,
      href: linked ? `#app/${encodeURIComponent(slug)}/dev/issues/${issue}` : null,
    };
  });
  return {
    loaded: true,
    summary: feedbackLine(feedback),
    truncated: !!feedback.truncated,
    rows,
  };
}

/** "3 days ago", or "Sep 3" (with the year once it is not this one) past a
 *  fortnight — a month and day reads in every locale, "9/3/2026" does not. */
export function mergedAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / 86400000);
  if (days >= 0 && days < 14) return relativeDate(iso, now);
  const date = new Date(t);
  const opts = date.getFullYear() === new Date(now).getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return date.toLocaleDateString(undefined, opts);
  } catch (_) {
    return null;
  }
}

/**
 * "Your changes" (UI overhaul; it was "Your proposals", #5310): every change
 * the viewer has started, from GET /api/me/proposal-history, in three groups.
 * In progress takes what is in an agent session and what is up for a vote,
 * newest first, each saying which (it was two sections, and also the
 * Communities tab's "What you are working on"); then Merged; then Closed. A
 * group with no rows is left out. `loaded: false` is a read that has not
 * answered yet, distinct from a real "you have started nothing".
 */
export function proposalsView(data, now = Date.now()) {
  const buckets = data && data.proposals && typeof data.proposals === 'object'
    ? data.proposals : null;
  if (!buckets) return { loaded: false, sections: [], empty: true };
  const rowsOf = (key) => (Array.isArray(buckets[key]) ? buckets[key] : [])
    .filter((row) => row && row.appSlug && Number(row.sessionId) > 0)
    .map((row) => ({ row, key }));
  const shape = ({ row, key }) => {
    const app = row.appName || row.appSlug;
    const when = mergedAgo(row.at, now);
    let where = when;
    if (key === 'openForVote') where = 'waiting for approval';
    else if (key === 'inProgress') where = 'in progress';
    else if (key === 'closed') where = 'closed without going live';
    const slug = encodeURIComponent(row.appSlug);
    const id = Number(row.sessionId);
    return {
      key: String(row.sessionId),
      href: key === 'inProgress' ? `#app/${slug}/dev/sessions/${id}` : `#app/${slug}/dev/proposals/${id}`,
      title: row.title || 'Change',
      meta: [app, where].filter(Boolean).join(' · '),
      // The project's own icon leads the row, so one list across every
      // project still reads project by project (#3364). In app-card.js's
      // field names, which is what AppIconContent draws from.
      app: {
        slug: row.appSlug,
        name: app,
        icon_emoji: row.appIconEmoji || null,
        icon_url: row.appIconUrl || null,
      },
      at: Date.parse(row.at || '') || 0,
    };
  };
  const underway = rowsOf('openForVote').concat(rowsOf('inProgress')).map(shape)
    .sort((x, y) => y.at - x.at);
  const sections = [
    { key: 'inProgress', label: 'In progress', rows: underway },
    { key: 'merged', label: 'Live', rows: rowsOf('merged').map(shape) },
    { key: 'closed', label: 'Closed', rows: rowsOf('closed').map(shape) },
  ].filter((section) => section.rows.length > 0);
  return { loaded: true, sections, empty: sections.length === 0 };
}

/** Where a request stands, as its line says it. See MY_REQUESTS_SQL in
 *  src/routes/profile.js for what each is read from. */
const REQUEST_STATE = {
  waiting: 'nobody on it yet',
  underway: 'someone is on it',
  shipped: 'live',
  closed: 'closed',
};

/**
 * "Your requests" (UI overhaul; it was "Your feedback", #3186): every
 * request the viewer asked for, from the Suggest an improvement dialog or a
 * board, from GET /api/me/requests. Open (nobody on it yet, or someone is),
 * then Done (shipped, or closed by a vote). Each opens the request.
 */
export function requestsView(data) {
  const list = data && Array.isArray(data.requests) ? data.requests : null;
  if (!list) return { loaded: false, sections: [], empty: true, truncated: false };
  const rows = list.filter((r) => r && Number(r.number) > 0).map((r) => {
    const slug = typeof r.appSlug === 'string' && APP_SLUG.test(r.appSlug) ? r.appSlug : null;
    const state = REQUEST_STATE[r.state] ? r.state : 'waiting';
    return {
      key: `${r.appSlug || ''}#${r.number}`,
      href: slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${Number(r.number)}` : null,
      title: r.title ? String(r.title) : `Request #${Number(r.number)}`,
      meta: [r.appName || 'An app', REQUEST_STATE[state]].join(' · '),
      done: state === 'shipped' || state === 'closed',
    };
  });
  const sections = [
    { key: 'open', label: 'Open', rows: rows.filter((r) => !r.done) },
    { key: 'done', label: 'Done', rows: rows.filter((r) => r.done) },
  ].filter((section) => section.rows.length > 0);
  return { loaded: true, sections, empty: sections.length === 0, truncated: !!data.truncated };
}

/** What a vote was on, in the words its row leads with. */
function voteTitle(item) {
  if (item.type === 'pr_vote') {
    const pr = item.pr || {};
    return pr.title ? String(pr.title) : (pr.number ? `Change #${Number(pr.number)}` : 'A change');
  }
  const issue = item.issue || {};
  return issue.title ? String(issue.title) : 'A group decision';
}

/** Whether the thing voted on is still being decided. */
function voteOpen(item) {
  if (item.type === 'pr_vote') return item.status === 'promoted' || item.status === 'merging';
  return item.status === 'open';
}

/** How it was decided, once it was. */
function voteOutcome(item) {
  if (item.type === 'pr_vote') {
    if (item.status === 'merged') return 'live';
    // Merged, its deploy still to come (api/me/history).
    if (item.status === 'going_live') return 'going live';
    return 'closed';
  }
  return 'decided';
}

/**
 * What happens next to a change still being decided (#4003): one phrase from
 * its votes against what the merge needs (`progress`, from
 * /api/me/history) and then its checks. The decided rows say how it ended
 * (voteOutcome), so every row says where the change is now. A row without
 * `progress` says nothing more than it did: the server could not tell.
 */
function voteNext(item) {
  if (item.type !== 'pr_vote') return null;
  if (item.status === 'merging') return 'merging';
  const p = item.progress;
  if (!p || typeof p !== 'object') return null;
  if (p.needsMember) return 'needs another member\u2019s yes';
  if (!p.votesDone) {
    if (p.lazy) return 'goes live after a wait if nobody objects';
    const missing = Math.max((Number(p.required) || 1) - (Number(p.yes) || 0), 1);
    return `needs ${missing} more ${missing === 1 ? 'approval' : 'approvals'}`;
  }
  if (p.checkState === 'failing') return 'approved, checks failing';
  if (p.checkState === 'error') return 'approved, checks couldn\u2019t run';
  if (p.checkState === 'passing' || p.checkState === 'skipped') return 'approved, waiting to merge';
  return 'approved, checks running';
}

/**
 * "Your votes" (UI overhaul; it was a filter of Kudos › My history): the
 * changes and group decisions the viewer voted on, from GET
 * /api/me/history?type=votes. Still open, then Decided. Only the vote
 * standing now is kept (a vote can be changed while it is open), so each
 * row says the vote as it stands, then where the change is now.
 */
export function votesView(data) {
  const items = data && Array.isArray(data.items) ? data.items : null;
  if (!items) return { loaded: false, sections: [], empty: true, more: false };
  const rows = items
    .filter((item) => item && (item.type === 'pr_vote' || item.type === 'proposal_vote'))
    .map((item, index) => {
      const app = item.app || {};
      const slug = typeof app.slug === 'string' && APP_SLUG.test(app.slug) ? app.slug : null;
      const open = voteOpen(item);
      const vote = item.vote === 'yes' || item.vote === 'no' ? item.vote : null;
      const meta = [app.name || app.slug || 'An app'];
      if (vote) meta.push(`you voted ${vote}`);
      const where = open ? voteNext(item) : voteOutcome(item);
      if (where) meta.push(where);
      let href = null;
      if (slug && item.type === 'pr_vote' && Number(item.pr && item.pr.sessionId) > 0) {
        href = `#app/${encodeURIComponent(slug)}/dev/proposals/${Number(item.pr.sessionId)}`;
      } else if (slug && item.type === 'proposal_vote' && Number(item.issue && item.issue.id) > 0) {
        href = `#app/${encodeURIComponent(slug)}/dev/governance/${Number(item.issue.id)}`;
      }
      return {
        key: `${item.type}:${(item.pr && item.pr.sessionId) || (item.issue && (item.issue.id || item.issue.number)) || index}`,
        href,
        title: voteTitle(item),
        meta: meta.join(' · '),
        open,
      };
    });
  const sections = [
    { key: 'open', label: 'Still open', rows: rows.filter((r) => r.open) },
    { key: 'decided', label: 'Decided', rows: rows.filter((r) => !r.open) },
  ].filter((section) => section.rows.length > 0);
  return { loaded: true, sections, empty: sections.length === 0, more: !!data.nextBefore };
}

/** The opt-in public profile's owner controls (#582). */
export function publicControlsView(state) {
  const owner = state.data && state.data.ownerPublicProfile;
  if (!owner) return null;
  const profile = owner.profile || {};
  return {
    profile,
    published: !!owner.published,
    moderationDisabled: !!owner.moderationDisabled,
    // #2787: the second line of the sheet's "Public profile" switch row, so it
    // says what the state MEANS rather than a bare "Published"/"Private".
    visibility: owner.moderationDisabled
      ? 'Hidden by moderation'
      : owner.published
        ? 'On: anyone with the link can view it, no account needed'
        : 'Off: your profile has no public link',
    visibilityClass: owner.moderationDisabled
      ? 'text-red-700 dark:text-red-400'
      : owner.published
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-zinc-500 dark:text-zinc-400',
    openHref: profile.url || `#profile/${encodeURIComponent(profile.username || '')}`,
  };
}

/** The avatar block on a PUBLIC profile card, which is a different shape: the
 *  initial sits behind an absolutely-positioned image so a failed load can drop
 *  the image and reveal the fallback without shifting layout. */
export function publicAvatarView(profile) {
  const source = String(profile.displayName || profile.username || '?');
  const match = source.match(/[\p{L}\p{N}]/u);
  const url = (typeof profile.avatarUrl === 'string'
    && /^\/avatars\/[a-f0-9]{32}$/.test(profile.avatarUrl))
    ? profile.avatarUrl : null;
  return { initial: match ? match[0].toUpperCase() : '?', url };
}

/** "March 2026" — how long two people have been friends. */
function monthYear(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } catch (_) {
    return null;
  }
}

/**
 * The own profile's private Friends section (#2386): requests waiting on you,
 * then your friends, each a link to their page, then the requests you sent
 * and can still withdraw. From GET /api/friends, which only ever answers the
 * viewer's own lists — this is never drawn on anybody else's page, and it
 * counts nothing.
 *
 * The sent requests are here because the pending cap (20) tells you to cancel
 * one, and this is the one place they are all listed. A request that was
 * declined still reads "Requested": the sender is never told.
 *
 * `loaded: false` is a read that failed (or has not answered), told apart
 * from "no friends yet", as every list here tells a failure from an empty one.
 */
export function friendsView(lists, now = Date.now()) {
  const valid = lists && typeof lists === 'object'
    && Array.isArray(lists.friends) && Array.isArray(lists.incoming);
  if (!valid) return { loaded: false, incoming: [], friends: [], outgoing: [] };
  const row = (p, meta) => {
    const username = String(p.username || '');
    const match = username.match(/[\p{L}\p{N}]/u);
    return {
      key: String(p.id),
      id: Number(p.id),
      username,
      href: `#profile/${encodeURIComponent(username)}`,
      avatarUrl: typeof p.avatarUrl === 'string' && /^\/avatars\/[a-f0-9]{32}$/.test(p.avatarUrl)
        ? p.avatarUrl : null,
      initial: match ? match[0].toUpperCase() : '?',
      meta,
    };
  };
  const people = (items) => items.filter((p) => p && Number(p.id) > 0 && p.username);
  return {
    loaded: true,
    incoming: people(lists.incoming).map((p) => {
      // Short, because the row also carries Accept and Decline: on a phone
      // the name and this line share what the two buttons leave.
      const when = mergedAgo(p.requestedAt, now);
      return row(p, when ? `Asked ${when}` : 'Asked to be friends');
    }),
    friends: people(lists.friends).map((p) => {
      const since = monthYear(p.since);
      return row(p, since ? `Friends since ${since}` : 'Friends');
    }),
    outgoing: people(Array.isArray(lists.outgoing) ? lists.outgoing : []).map((p) => {
      const when = mergedAgo(p.requestedAt, now);
      return row(p, when ? `Requested ${when}` : 'Requested');
    }),
  };
}

/**
 * The backend zeroes total_tokens until terms are accepted, so a gated
 * allocation must show the terms notice, never a fake 0 balance (mirrors the
 * native TokenAllocationGatedNotice).
 */
export function tokenView(ranking, revealed) {
  if (ranking.terms_accepted === false) return { gated: true };
  const amount = Number(ranking.total_tokens || 0);
  return {
    gated: false,
    // #1552: nothing allocated yet is its own state, not a zero to reveal.
    // `total_tokens` sums this user's `token_allocation.allocated_tokens`
    // across seasons, so it is 0 for everyone who has not been allocated
    // any — which is most people. Blurring that 0 behind a "Reveal" button
    // builds up to nothing and reads as either a bug or a snub; the card
    // says so in words instead.
    empty: amount === 0,
    amount: amount.toLocaleString(),
    revealed: !!revealed,
  };
}

/**
 * The whole screen, as one discriminated view. `empty` is the initial value and
 * the only one the prerender pass can produce.
 */
export function buildProfileView(state, now = Date.now()) {
  if (!state.open) return { kind: 'empty' };
  const d = state.data;
  if (!d) return { kind: 'loading' };
  if (d.signedOut) return { kind: 'signedOut' };
  if (d.error) return { kind: 'error' };
  if (d.publicNotFound) return { kind: 'publicNotFound' };
  if (d.publicProfile) {
    const viewer = state.user || {};
    // Someone else's page, seen by a signed-in viewer with platform access.
    // No self-report, no report from a signed-out or access-less visitor —
    // and the same for Message: Messages is a signed-in, admitted surface,
    // and you do not message yourself. The handle comparison ignores case,
    // as the username directory does.
    const other = !!viewer.username
      && viewer.hasPlatformAccess !== false
      && String(viewer.username).toLowerCase() !== String(d.publicProfile.username || '').toLowerCase();
    // #2386: the viewer's own relationship with this person, as the payload
    // carried it. Drawn only where Message is — someone else's page, seen by
    // a signed-in viewer with access — and only when the server sent one.
    const f = d.publicFriendship;
    const friendship = other && f && Number(f.userId) > 0
      && ['none', 'outgoing', 'incoming', 'friends'].includes(f.state)
      ? { userId: Number(f.userId), state: f.state }
      : null;
    return {
      kind: 'public',
      profile: d.publicProfile,
      allowReport: other,
      allowMessage: other,
      friendship,
    };
  }

  return {
    kind: 'own',
    identity: identityView(state),
    publicControls: publicControlsView(state),
    stats: statsView(d.summary || null),
    rows: moreRowsView(d),
    friends: friendsView(d.friends || null, now),
    feedback: feedbackListView(d.feedback || null, now),
  };
}
