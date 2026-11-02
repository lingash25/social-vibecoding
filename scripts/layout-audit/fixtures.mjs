// The audit's made-up world: one signed-in person, a few projects, a
// Homeroom bot conversation, a direct message and a group with enough lines
// to scroll, and a project's channel. Every name is obviously invented and
// nothing is read from a real account. The shapes follow what the platform's
// routes answer (src/routes/*), down to the fields the screens read.
//
// `answer(method, url)` returns `{ status, json, fixture }`. A read the world
// does not cover answers 404 with `fixture: false` and the report lists it,
// so a screen that comes up empty for want of data says so rather than
// passing quietly.

const NOW = Date.parse('2026-11-01T15:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

const ME_ID = 9001;
const BOT = { id: 9000, username: 'homeroom', avatarUrl: null, bot: true, displayName: 'Homeroom bot' };
const ADA = { id: ME_ID, username: 'audit_ada', avatarUrl: null };
const PAT = { id: 9002, username: 'pat_parrot', avatarUrl: null };
const KAI = { id: 9003, username: 'kai_kestrel', avatarUrl: null };
const SELF_SLUG = 'audit-homeroom';

const ME = {
  id: ME_ID,
  username: ADA.username,
  isAdmin: false,
  canAdminWrite: false,
  role: 'user',
  uiTelemetryEligible: false,
  homeroomBotDm: true,
  canCreateApps: true,
  appCreationQuota: { used: 2, limit: 5, remaining: 3 },
  appQuotaRequestedAt: null,
  aiProgressEstimate: false,
  sessionBridgeEnabled: false,
  reviewFlowEnabled: false,
  agentSessionsEnabled: true,
  locale: 'en',
  hasPlatformAccess: true,
  privateMember: false,
  usernameProvisional: false,
  needsUsernameChoice: false,
  hasPassword: true,
  needsCommunitiesChoice: false,
  storyFirstSession: false,
  waitlistIdea: null,
  identityNeeded: false,
  adultAttested: true,
  tourDone: true,
  homeWalkOwed: false,
  homeroomReached: true,
  hasApiKey: false,
  openrouterAvailable: false,
  usernodePubkey: null,
  walletLinkEnabled: false,
  profile: { displayName: 'Ada Audit', bio: null, avatarUrl: null, links: { github: null, x: null } },
};

// ── Projects ────────────────────────────────────────────────────────────

function app({ id, slug, name, emoji, audience, member = true, favorite = false, featured = false, community }) {
  return {
    id, name, slug,
    repo_url: `https://example.invalid/${slug}`,
    container_id: null,
    status: 'running',
    retry_count: 0,
    created_by: ME_ID,
    created_at: ago(60 * 24 * 30),
    main_sha: 'a'.repeat(40),
    main_pr_number: 12,
    last_deploy_at: ago(60 * 5),
    manifest_snapshot: { name, icon: { color: null, emoji, image: null }, admins: [ADA.username], topics: null, secrets: [], category: null, governance: null, visibility: null, description: null, permissions: [] },
    locked: false,
    self_hosted: slug === SELF_SLUG,
    moderation_suspended_at: null,
    collab_visibility: audience === 'open' ? 'public' : 'invite',
    view_visibility: audience === 'solo' ? 'private' : (audience === 'invited' ? 'members' : 'public'),
    approver_policy: 'members',
    approvals_required: null,
    screenshot_device_scale: 2,
    icon_emoji: emoji,
    icon_image_id: null,
    icon_color: null,
    icon_url: null,
    featured_illustration: null,
    forked_from: null,
    admin_usernames: [ADA.username],
    directory_review_status: 'approved',
    main_check_state: 'passing',
    main_check_sha: 'a'.repeat(40),
    main_check_at: ago(60),
    main_check_detail: null,
    release_stall: null,
    release_run: null,
    demo_mode: false,
    community_id: community,
    deploy_state: null,
    message_count: '42',
    total_seconds: '3600',
    active_users: '3',
    is_favorited: favorite,
    your_apps_hidden: false,
    favorite_order: favorite ? 1 : null,
    featured,
    featured_order: featured ? 1 : null,
    is_collaborator: member,
    is_member: member,
    member_count: audience === 'solo' ? 1 : 6,
    audience,
    last_active_at: ago(30),
    open_prs: 2,
    active_sessions: 1,
    merged_prs: 14,
    merged_prs_recent: 3,
    last_merged_at: ago(60 * 20),
    open_issues: 4,
    contributor_count: 3,
    first_version_line: null,
    first_version_phase: null,
    last_failure_reason: null,
    last_failure_at: null,
    url: `https://${slug}.example.invalid`,
    custom_domain: null,
    share_url: `https://example.invalid/app/${slug}`,
    staging_sample: false,
    // The detail route's extras.
    template: null,
    contributor_count_detail: 3,
    directory: { state: 'listed', tier: 'standard', label: null, flagged: false, flaggedAt: null },
    lastFailure: null,
    creationPhase: null,
    first_version: null,
    exampleChange: null,
    missingSecrets: null,
    shotsEnforced: false,
    mainCheck: { state: 'passing', sha: 'a'.repeat(40), at: ago(60), detail: null, paused: false, confirming: false, failingTest: null },
    releaseStall: { stalled: false },
    codeChangesPaused: false,
    can_collaborate: true,
    can_manage: true,
    can_report: true,
    can_delete: false,
    upstream_link: null,
    versions: null,
  };
}

const APPS = [
  app({ id: 801, slug: SELF_SLUG, name: 'Homeroom', emoji: '🏫', audience: 'open', featured: true, community: 500 }),
  app({ id: 802, slug: 'audit-garden', name: 'Audit Garden', emoji: '🌱', audience: 'invited', favorite: true, community: 501 }),
  app({ id: 803, slug: 'tide-tables', name: 'Tide Tables', emoji: '🌊', audience: 'open', featured: true, community: 502 }),
  app({ id: 804, slug: 'pocket-quiz', name: 'Pocket Quiz', emoji: '🧩', audience: 'solo', community: 503 }),
];
const appBySlug = (slug) => APPS.find((a) => a.slug === slug);

// ── Conversations ───────────────────────────────────────────────────────

const SAID = [
  'Morning! Is the garden plan still on for Saturday?',
  'Yes, from ten. Bring gloves if you have them.',
  'I sketched the beds on the board last night, have a look when you can.',
  'Looks good. The tomatoes want the sunny corner, the herbs can go by the path.',
  'Agreed. Should we ask the group about the compost bin too?',
  'Let us. I will post it in the channel after lunch so everyone sees it before the weekend.',
  'Perfect, thanks.',
  'One more thing: the watering rota keeps slipping. Could the app remind whoever is on that day?',
  'That would help a lot. I will write it up as a request.',
  'Great. Long message to see how a few lines wrap in a narrow column: the reminder should go out at eight in the morning, name the person whose turn it is, and let them hand the turn to someone else with one tap if they cannot make it.',
  'Noted.',
  'See you Saturday!',
];

function message(id, conversationId, sender, content, minutes, extra = {}) {
  return {
    id, conversationId, sender, content,
    moderated: false,
    createdAt: ago(minutes),
    editedAt: null,
    reply: null,
    reactions: [],
    attachments: [],
    objects: [],
    saved: false,
    deleted: false,
    threadRootId: null,
    thread: null,
    threadRoot: null,
    ...extra,
  };
}

function lines(conversationId, a, b, startId) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const sender = i % 2 ? b : a;
    out.push(message(startId + i, conversationId, sender, SAID[i % SAID.length], 600 - i * 20));
  }
  return out;
}

const BOT_MESSAGES = [];
{
  const said = [
    [ADA, 'Can you help me plan a watering rota for Audit Garden?'],
    [BOT, 'Happy to. Who is in the group, and which days need watering?'],
    [ADA, 'Six of us, every day from May to September.'],
    [BOT, 'Then a weekly rota works: each person takes a day, and the seventh rotates. I can draft it as a request on Audit Garden, in a thread only you can see. Nothing is filed until you file it.'],
    [ADA, 'Yes please.'],
    [BOT, 'Drafted. Open the thread to read it, change anything, and file it when it reads right.'],
  ];
  let id = 70100;
  for (let round = 0; round < 3; round++) {
    for (const [who, text] of said) BOT_MESSAGES.push(message(id++, 7001, who, text, 900 - id + 70100));
  }
}

const CONVERSATIONS = [
  {
    id: 7001, kind: 'direct', title: 'Homeroom bot', peer: BOT, homeroomBot: true,
    members: [ADA, BOT], messages: BOT_MESSAGES,
  },
  { id: 7002, kind: 'direct', title: PAT.username, peer: PAT, members: [ADA, PAT], messages: lines(7002, PAT, ADA, 70200) },
  { id: 7003, kind: 'group', title: 'Weekend planners', peer: null, members: [ADA, PAT, KAI], messages: lines(7003, KAI, PAT, 70300) },
];

function conversation(c) {
  const latest = c.messages[c.messages.length - 1];
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    status: 'active',
    archived: false,
    deletedPeer: false,
    members: c.members.map((m) => ({ ...m, role: 'member', status: 'member', joinedAt: ago(60 * 24 * 10), invitedBy: ME_ID })),
    memberCount: c.members.length,
    channelKey: null,
    membershipStatus: 'member',
    myRole: 'member',
    inviteNote: null,
    requester: ADA,
    peer: c.peer,
    latestMessage: latest,
    latestSummary: latest.content,
    lastActivityAt: latest.createdAt,
    unreadCount: c.id === 7002 ? 2 : 0,
    lastReadMessageId: latest.id,
    awaitingAcceptance: false,
    canSend: true,
    canInvite: c.kind !== 'direct',
    canManage: c.kind !== 'direct',
    homeroomBot: !!c.homeroomBot,
  };
}

const CHANNEL = [];
for (let i = 0; i < 30; i++) {
  const who = [PAT, KAI, ADA][i % 3];
  CHANNEL.push({
    id: 50000 + i, user_id: who.id, username: who.username,
    content: SAID[i % SAID.length], msg_type: 'text', metadata: {},
    thread_type: null, thread_ref: null, created_at: ago(400 - i * 10), edited_at: null,
    posted_via: null, moderation_hidden_at: null, deleted: false, reactions: [],
    bookmarked: false, has_unread_notification: false, thread: null,
  });
}

// ── The bot's lists, the Workshop and notifications ─────────────────────

const appRef = (slug) => {
  const a = appBySlug(slug);
  return { slug, name: a.name, icon_url: null, icon_emoji: a.icon_emoji };
};
const workItem = (threadId, number, kind, title, slug, what, minutes, extra = {}) => ({
  threadId, number, kind, title, app: appRef(slug), change: null,
  href: `#app/${slug}/dev/issues/${number}`, group: slug, what, at: ago(minutes), ...extra,
});

const AI_WORK = {
  private: [{ rootId: 70104, title: 'Watering rota', kind: 'ask', app: appRef('audit-garden'), at: ago(40) }],
  needs: [
    workItem(81001, 21, 'work', 'Remind whoever is on watering duty', 'audit-garden', 'Pick one', 50),
    workItem(81002, 7, 'decision', 'Show high tide in the list', 'tide-tables', 'Decide', 90),
  ],
  next: [],
  waiting: [
    workItem(81003, 22, 'work', 'A seed swap page', 'audit-garden', 'Waiting for a slot', 120, { myVote: null, heldBy: 'slot' }),
    workItem(81004, 9, 'decision', 'Weekly quiz streaks', 'pocket-quiz', 'Waiting on votes', 300, { myVote: null, heldBy: 'votes' }),
  ],
  live: [
    workItem(81005, 18, 'work', 'Bed labels on the garden map', 'audit-garden', 'Live', 2000, { change: { id: 9101, number: 31 } }),
    workItem(81006, 4, 'work', 'Tide times in the local timezone', 'tide-tables', 'Live', 4000, { change: { id: 9102, number: 12 } }),
  ],
};

const NOTIFICATIONS = [1, 2, 3].map((n) => ({
  id: 60000 + n, kind: 'connector_submitted', readAt: n === 1 ? null : ago(100), createdAt: ago(n * 45),
  appId: 802, appSlug: 'audit-garden', appName: 'Audit Garden', appIconUrl: null, appIconEmoji: '🌱',
  storyIssueNumber: null, storySessionId: null, storyPrNumber: 30 + n, storyTitle: `Change ${n} to Audit Garden`,
  chatMessageId: null, conversationId: null, conversationKind: null, conversationTitle: null,
  conversationInviteNote: null, conversationMessageId: null, conversationThreadRootId: null, messageContent: null,
  threadType: null, threadRef: null, sessionId: null, sessionTitle: null, prTitle: `Change ${n} to Audit Garden`,
  prNumber: 30 + n, headlessIssueNumber: null, branchName: null, agentSessionId: null, sourceUsername: PAT.username,
  detail: null, voteReason: null, href: null, saved: false,
}));

const NEEDS_FEED = [
  { kind: 'proposal', id: 9201, title: 'Bed labels on the garden map', summary: 'Each bed on the map shows what is planted in it.', author: PAT.username, number: 33, epoch: 1, at: ago(80), yes: 1, no: 0, staging_url: 'https://example.invalid/staging', shots: null, touches: null, app: { slug: 'audit-garden', name: 'Audit Garden', icon_url: null, icon_emoji: '🌱' }, request: { number: 18, title: 'Bed labels on the garden map' }, diagram: null, diagram_source: 'none' },
];

// ── Routes ──────────────────────────────────────────────────────────────

const json = (status, body) => ({ status, json: body, fixture: true });
const ok = (body) => json(200, body);

const ROUTES = [
  ['GET', /^\/api\/auth\/me$/, () => ok({ user: ME })],
  ['GET', /^\/api\/version$/, () => ok({ sha: 'audit', name: 'Homeroom', repoUrl: 'https://example.invalid/homeroom', deployProgress: { runtimeKind: 'audit', scope: 'rollout', deploying: false, failed: false, phase: 'complete', sha: 'audit', startedAt: ago(600) }, env: null, selfAppSlug: SELF_SLUG })],
  ['GET', /^\/api\/languages$/, () => ok({ languages: { en: 'English' }, manifest: {} })],
  ['GET', /^\/api\/public\/waitlist\/options$/, () => ok({ discovery_sources: {}, group_sizes: {}, group_roles: {}, group_tools: {}, loss_answers: {}, loss_kinds: {}, countries: {}, waitlist_url: 'https://example.invalid/waitlist', marketing_url: 'https://example.invalid', story_landing: false, sign_in_providers: [], phone_sign_in: false, terms_link: 'https://example.invalid/terms', privacy_link: 'https://example.invalid/privacy', child_safety_link: 'https://example.invalid/safety', account_deletion_link: 'https://example.invalid/delete', native_sign_in_providers: [] })],
  ['GET', /^\/api\/platform\/about$/, () => ok({ name: 'Homeroom', tagline: 'Build things together', repoUrl: 'https://example.invalid/homeroom', version: 'audit', updatedAt: ago(600), stats: { apps: 4, members: 3, merged: 40 }, selfAppSlug: SELF_SLUG, served: true })],
  ['GET', /^\/api\/me\/community-pins$/, () => ok({ pins: [] })],
  ['GET', /^\/api\/me\/session-state$/, () => ok({ bootId: 'audit', at: NOW, sessions: [] })],
  ['GET', /^\/api\/me\/app-allowance$/, () => ok({ quota: { used: 2, limit: 5, remaining: 3 }, canCreateApps: true, requestedAt: null, server: null })],
  ['GET', /^\/api\/me\/ai-budget$/, () => ok({ creditPolicy: 'weekly', tier: 'standard', limitSource: 'tier', verificationRequired: false, entitlementAvailable: true, tierLimitCents: 500, identityTier: 'basic', weeklySource: 'tier', limitCents: 500, spentCents: 120, remainingCents: 380, byokCents: 0, hasByokKey: false, resetsAt: ago(-60 * 24 * 3), lowBalancePct: 20, capWindow: 'week', windowLabel: 'this week', resetLabel: 'Resets Thursday', dailyApplies: false, dailyLimitCents: 0, dailySpentCents: 0, weeklyApplies: true, weeklyLimitCents: 500, weeklySpentCents: 120 })],
  ['GET', /^\/api\/me\/summary$/, () => ok({ merged: 6, apps: 3, proposalsTotal: 9, inProgress: 1, kudos: 4, memberSince: ago(60 * 24 * 90), challenges: { done: 2, total: 6, season: { id: 1, name: 'Autumn' } }, contributions: [] })],
  ['GET', /^\/api\/models$/, () => ok({ models: [{ id: 'audit-standard', label: 'Standard', tier: 'standard', outputCostPerMTok: 10, changeSize: { short: 'Small', long: 'Small changes' } }], default: 'audit-standard' })],
  ['GET', /^\/api\/notifications$/, () => ok({ notifications: NOTIFICATIONS, hasMore: false, nextBefore: null, unread: 1, messageUnread: 2, pendingInvites: [], savedMessages: [], savedNotifications: [] })],
  ['GET', /^\/api\/agent-sessions$/, () => ok({ sessions: [], nextBefore: null, started: false })],
  ['GET', /^\/api\/home-panels$/, () => ok({ registry: [], hidden: [], panels: [] })],
  ['GET', /^\/api\/home-layout$/, () => ok({ maxCols: 4, maxRows: 6, breakpoints: [480, 768], layouts: {} })],
  ['GET', /^\/api\/apps$/, () => ok({ apps: APPS })],
  ['GET', /^\/api\/apps\/([^/]+)$/, (m) => (appBySlug(decodeURIComponent(m[1])) ? ok({ app: appBySlug(decodeURIComponent(m[1])) }) : json(404, { error: 'not found' }))],
  ['GET', /^\/api\/apps\/([^/]+)\/messages$/, () => ok({ messages: CHANNEL, has_more_before: false, has_more_after: false, read: { last_read_message_id: CHANNEL[CHANNEL.length - 1].id, unread_count: 0 } })],
  ['GET', /^\/api\/messages\/app-discussions$/, () => ok({ discussions: APPS.filter((a) => a.is_member).map((a) => ({ slug: a.slug, name: a.name, channel: 'general', iconUrl: null, iconEmoji: a.icon_emoji, lastMessage: SAID[1], lastAt: ago(30), lastBy: PAT.username, section: 'projects', unreadCount: a.slug === 'audit-garden' ? 3 : 0 })) })],
  ['GET', /^\/api\/workshop\/counts$/, () => ok({ counts: { 'audit-garden': { working: 1, needs: 2, owed: ['vote', 'review'] }, 'tide-tables': { working: 0, needs: 1, owed: ['decide'] }, [SELF_SLUG]: { working: 2, needs: 0, owed: [] } } })],
  ['GET', /^\/api\/workshop\/needs-feed$/, () => ok({ items: NEEDS_FEED, max: 50 })],
  ['GET', /^\/api\/ai\/work$/, () => ok(AI_WORK)],
  ['GET', /^\/api\/conversations$/, () => ok({ conversations: CONVERSATIONS.map(conversation) })],
  ['POST', /^\/api\/conversations\/homeroom-bot$/, () => ok({ conversationId: 7001 })],
  ['GET', /^\/api\/conversations\/homeroom-bot\/work$/, () => ok({ now: [], needsYou: [], history: [], tracks: [] })],
  ['GET', /^\/api\/conversations\/homeroom-bot\/activity$/, () => ok({ cards: [], ready: [] })],
  ['GET', /^\/api\/conversations\/(\d+)$/, (m) => {
    const c = CONVERSATIONS.find((x) => x.id === Number(m[1]));
    return c ? ok({ conversation: conversation(c) }) : json(404, { error: 'not found' });
  }],
  ['GET', /^\/api\/conversations\/(\d+)\/messages$/, (m) => {
    const c = CONVERSATIONS.find((x) => x.id === Number(m[1]));
    return c ? ok({ messages: c.messages, nextBefore: null }) : json(404, { error: 'not found' });
  }],
  // Writes the screens make on their own while they open (marking a
  // conversation read, the typing ping): accepted and dropped.
  ['POST', /^\/api\/conversations\/\d+\/(read|typing)$/, () => ok({ ok: true })],
  ['PUT', /^\/api\/conversations\/\d+\/read$/, () => ok({ ok: true })],
];

export function answer(method, url) {
  for (const [m, pattern, build] of ROUTES) {
    if (m !== method) continue;
    const match = url.pathname.match(pattern);
    if (match) return build(match, url);
  }
  return { status: 404, json: { error: 'not in the layout audit\'s made-up world' }, fixture: false };
}

/** The routes the audit walks, each with the id of the screen it shows. */
export const SCREENS = [
  { id: 'home', route: '#home', screen: '#home-screen' },
  { id: 'communities', route: '#communities', screen: '#workshop-screen' },
  { id: 'homeroom-bot', route: '#ai', screen: '#ai-screen', composer: true },
  { id: 'messages', route: '#messages', screen: '#messages-screen' },
  { id: 'direct-message', route: '#messages/7002', screen: '#messages-screen', composer: true },
  { id: 'group', route: '#messages/7003', screen: '#messages-screen', composer: true },
  { id: 'project-hub', route: '#app/audit-garden', screen: '#app-view', composer: true },
  { id: 'profile', route: '#profile', screen: '#profile-screen' },
  { id: 'settings', route: '#settings', screen: '#settings-screen' },
];
