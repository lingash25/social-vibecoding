'use strict';

// #3624: the Homeroom bot, in a DM.
//
// The bot already reads a request, asks one question when something real
// is missing, writes a spec, builds it and opens a proposal
// (homeroom-bot.js, homeroom-bot-live.js). It says all of that on the
// request itself: a GitHub comment and the request's Homeroom thread. This
// module brings the same news to the person the request is FOR, in their
// direct conversation with the bot, so somebody who is not a developer can
// build without opening the agent chat:
//
//   - a question the bot asks arrives in the DM with suggested answers to
//     tap (and the composer for anything else);
//   - an answer given in the DM is posted on the request's discussion, as
//     the person's own message, which is what wakes the bot to look again.
//     The DM says so under every question: the request stays the public
//     record, and nobody in the group is left out of a decision;
//   - "building", "ready to vote on" and "live" reach the DM too;
//   - a project created with a description is built by the bot: it files
//     the description as the project's first-version request once the
//     project is running, and the loop above takes it from there. (Anybody
//     else's description is filed the same way, as the project's first
//     request, and left to the group: the bot is not involved.) A project
//     they import, fork or create without a description is acted on for
//     real too, with nothing filed first.
//
// Stage 2 (homeroom-bot-mayor.js): anything else a person writes in the DM
// is read by the bot's model, which can say what the bot is working on for
// them, pass an answer on, or offer to file a new request (filed only on a
// tap). The bot's news carries cards for its request or proposal.
//
// #3707: what the bot says back to a person's message quotes it, the way
// a person's reply does, and its later news about a request they started
// in the DM quotes the message it started from. With several requests in
// flight in one DM, each answer points at what it answers.
//
// It talks to everybody Homeroom has let in (hasBot). It was tried out one
// person at a time first, on a list an admin kept. What each person's
// requests may cost the platform in a week is capped
// (`homeroom_bot_user_weekly_cents`, $50 to start; an admin's by
// `homeroom_bot_admin_weekly_cents`, $100), apart from their own allowance
// for agents.
//
// Never a reason anything else fails: every entry point here is called
// best-effort, after the request, the post or the merge it follows.

const log = require('./logger');
const conversations = require('./conversations');
const repoRef = require('./repo-ref');
// Newcomer run five: a first version's stages, as they happen.
const timeline = require('./first-version-timeline');
const notifyCopy = require('./homeroom-bot-notify-copy');

const BOT_USERNAME = 'homeroom_bot';
const META = conversations.BOT_METADATA_KEY;

// The kinds of post that ask the requester something: their DM message
// carries suggested answers, and a reply without a quote answers the
// newest one still open.
const QUESTION_KINDS = new Set(['question', 'followup_ask']);
// B3: the news a reply quoting it is posted on the request's public
// discussion for: a question, and the three that ask for a reply to look
// again with ("Reply to this message with more detail"). A reply to anything
// else the bot said about a request (an activity card, a ready or live
// message) stays in the DM and is read by the bot: quoting a progress card
// to ask "can the reminder be at 9am?" used to post that on the request.
// The client's reply bar reads the same list (messages/bot-question.tsx).
const MIRRORED_KINDS = new Set([...QUESTION_KINDS, 'blocked', 'person', 'empty']);
// The most a project description may hold. Long enough for a real brief,
// short enough to be one request body.
const MAX_BRIEF_CHARS = 4000;
const MIN_BRIEF_CHARS = 10;
// How often a person the bot does not work for (an account not let in yet)
// hears why the bot does not answer: once a day is enough.
const NOT_ENABLED_KEY_HOURS = 24;
// How often somebody writing to the bot with nothing open hears its help.
const HELP_EVERY_MS = 10 * 60 * 1000;

// A staging copy never files a GitHub issue: like the bot's own live posts
// (homeroom-bot-live.js isLiveFor), that is an irreversible side effect of
// a preview.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lower(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

// ── Who it talks to ──────────────────────────────────────────────────────

function settingsModule() {
  // Lazy: homeroom-bot.js requires this module from readSettings.
  return require('./homeroom-bot');
}

/**
 * Whether the bot works for this person: builds the projects they describe,
 * brings their requests' news to their DM, and answers them there. That is
 * anybody who may use the platform (platform access, which an admin always
 * has), and never a synthetic account. A private member
 * (users.private_member_since) may: every read below takes
 * `has_platform_access` as "may use the platform", and req.user callers
 * fold `privateMember` in.
 * `person` is the signed-in user (req.user), or a requester (requesterFrom):
 * { username, isSynthetic, hasPlatformAccess, isAdmin }.
 * Pure. Whether the bot is switched on at all is its Mode's, not this: a
 * project described while it is off waits for it, and says so.
 */
function hasBot(settings, person) {
  if (!settings || !person?.username) return false;
  return !person.isSynthetic && !!(person.hasPlatformAccess || person.isAdmin || person.privateMember);
}

/** Whether this signed-in person builds through the bot's DM (the create dialog asks). */
async function isEnabledFor(pool, user) {
  if (!user || user.isSynthetic) return false;
  const settings = await settingsModule().readSettings(pool);
  return hasBot(settings, user);
}

/**
 * A requester row, read with what hasBot needs about the person (u.username,
 * u.is_synthetic, u.has_platform_access, u.is_admin), as the rest of this
 * module passes it.
 */
function requesterFrom(row, overrides = {}) {
  return {
    userId: row.user_id,
    username: row.username,
    firstVersion: !!row.first_version,
    issueTitle: row.issue_title,
    askedText: row.asked_text || null,
    isSynthetic: !!row.is_synthetic,
    hasPlatformAccess: !!row.has_platform_access,
    isAdmin: !!row.is_admin,
    // #4645: their language preference (users.locale, Settings → Language;
    // null unset), for the prompts that write to them (live.localeRule).
    locale: row.locale || null,
    ...overrides,
  };
}

async function botAccount(pool) {
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE username = $1 AND is_synthetic = TRUE',
    [BOT_USERNAME],
  );
  return rows[0] || null;
}

// How a project with nothing to build first came to be (homeroom_bot_dm_projects).
const PROJECT_ORIGINS = Object.freeze(['import', 'fork', 'blank']);

/**
 * A project was just made with no description to build from
 * (routes/apps.js): imported, forked, or created without one. When the bot
 * works for its maker it is recorded, so an import's backlog waits
 * (importedAt). Nothing is filed and nothing is said in the DM: there is no
 * first version to build. Resolves true when it was recorded.
 */
async function noteProjectMade(pool, { app, user, origin }) {
  if (!app?.id || !user?.id || !PROJECT_ORIGINS.includes(origin)) return false;
  const settings = await settingsModule().readSettings(pool);
  if (!hasBot(settings, user)) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO homeroom_bot_dm_projects (app_id, user_id, origin) VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO NOTHING`,
    [app.id, user.id, origin],
  );
  if (rowCount) log.info('homeroom-bot-dm', 'Project made without a description recorded for the bot', { app: app.slug, userId: user.id, origin });
  return rowCount > 0;
}

/**
 * When a project was imported by somebody the bot works for, or null: the
 * issues it arrived with are left until something happens on them after this.
 */
async function importedAt(pool, appId) {
  const { rows } = await pool.query(
    `SELECT created_at FROM homeroom_bot_dm_projects WHERE app_id = $1 AND origin = 'import'`,
    [appId],
  );
  return rows[0]?.created_at || null;
}

// ── Sending ──────────────────────────────────────────────────────────────

// Cards under one bot message (Messages allows six; three is plenty).
const MAX_CARDS = 3;

/** Pure: whether a post's news carries its proposal's card (cardsFor below). */
function hasProposalCard(dm) {
  const sessionId = Number(dm?.sessionId);
  return Number.isInteger(sessionId) && sessionId > 0;
}

/**
 * #3624 stage 2: the card a post's news is about. The proposal once there
 * is one (built, revised, merged), else the request itself. The news that
 * it went live opens the app with its own button (openAppAction), not a
 * card: an app card is one the bot can attach only to a project it can see,
 * and Page Turners (5 October), a group the bot is not in, got its "It's
 * live now." with no way in at all.
 */
function cardsFor(kind, dm, app, issueNumber) {
  const appId = Number(app?.id);
  if (!Number.isInteger(appId) || appId <= 0) return [];
  const sessionId = Number(dm?.sessionId);
  if ((kind === 'proposal' || kind === 'followup_revise' || kind === 'followup_failed' || kind === 'merged') && hasProposalCard(dm)) {
    return [{ type: 'proposal', appId, sessionId }];
  }
  const n = Number(issueNumber);
  return Number.isInteger(n) && n > 0 ? [{ type: 'issue', appId, issueNumber: n }] : [];
}

/**
 * Pure (5 October): the button that opens a project's app, on its App tab,
 * as the rest of the shell opens it (frontend/src/features/messages/
 * bot-shared.ts openAppTarget: App.openAppTab). An `open` button is drawn
 * from the message itself, so nothing about who the bot may see can keep it
 * off: the person it is for can open their own project. Null for no slug.
 */
function openAppAction({ slug, appName }) {
  if (typeof slug !== 'string' || !slug) return null;
  const name = clip(String(appName || slug).replace(/\s+/g, ' '), 40);
  return { id: 'open_app', label: `Open ${name}`, style: 'primary', type: 'open', target: `#app/${encodeURIComponent(slug)}/app` };
}

/**
 * Pure (#4231): the buttons under a NEW project's first version going live,
 * after its Open: its community page, where the project's hub is
 * (`#app/<slug>/workshop`, frontend/src/features/messages/bot-shared.ts
 * openAppTarget lands it on the hub), and Invite people, which the client
 * answers itself by opening the first-session invite sheet in place
 * (bot-question.tsx; an invite link is made from the browser, as the sheet
 * always makes it). Empty for no slug.
 */
function firstLiveActions({ slug }) {
  if (typeof slug !== 'string' || !slug) return [];
  return [
    { id: 'open_community', label: 'Open community', style: 'secondary', type: 'open', target: `#app/${encodeURIComponent(slug)}/workshop` },
    { id: 'invite_people', label: 'Invite people', style: 'secondary', type: 'invite' },
  ];
}

// What routes/conversations.js does after a send, done here because the
// service pushes nothing (the welcome DM does the same).
async function pushLive(pool, result, conversationId, { opened = false, threadRootId = null, actorUserId } = {}) {
  const ws = require('./ws');
  const notificationSvc = require('./notifications');
  for (const row of result.notifications || []) await notificationSvc.hydrateAndPush(pool, row);
  if (opened) ws.pushConversationEvent(result.memberIds, { type: 'conversation_membership_changed', conversationId });
  ws.pushConversationEvent(result.memberIds, {
    type: 'conversation_message_created',
    conversationId,
    messageId: result.message?.id ?? result.messageId,
    threadRootId: threadRootId || null,
  }, { actorUserId });
}

/**
 * #3707: the person's message a bot message may quote, or null. Only their
 * own, in this DM's main stream, and still there to read: a send refuses a
 * quote from another conversation outright, and a message deleted or
 * hidden by moderation is not one to put back in front of them.
 */
async function quotable(pool, conversationId, userId, messageId) {
  const id = conversations.strictId(messageId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND thread_root_id IS NULL
        AND deleted_at IS NULL AND moderation_hidden_at IS NULL`,
    [id, conversationId, userId],
  );
  return rows.length ? id : null;
}

/**
 * The thread a bot message goes in, in the person's chat with the bot, or
 * null for Main, the chat itself. Main is one conversation (#6019): what the
 * bot says about a request is said there, beside the request's card, and the
 * request's own page is its thread. Only an answer to something the person
 * wrote in a thread of theirs (a private thread, stage 5) goes in that
 * thread. The threads the bot opened per request before this stay where they
 * are, readable, and nothing new is added to them. Never throws.
 */
async function threadRootFor(pool, { conversationId, replyToId = null }) {
  try {
    const replyId = conversations.strictId(replyToId);
    if (!replyId) return null;
    const { rows: [quoted] = [] } = await pool.query(
      'SELECT thread_root_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
      [replyId, conversationId],
    );
    return quoted?.thread_root_id ? Number(quoted.thread_root_id) : null;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not find the thread a reply was in (saying it in Main)', { conversationId, err: err.message });
    return null;
  }
}

/** Whether a message is a request's activity card (homeroom-bot-activity.js). Never throws. */
async function isRequestCard(pool, messageId) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM homeroom_bot_dm_messages WHERE message_id = $1 AND kind = 'activity' LIMIT 1`, [messageId],
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell whether a message is a request\'s card (saying it in Main)', { messageId, err: err.message });
    return true;
  }
}

/**
 * One message from the bot to a person, in their DM with it (opened if it
 * is not yet). `metadata` is the message's structured part, shown to the
 * reader as `metadata.homeroomBot`. `objects` are cards under it (#3624
 * stage 2): the request or proposal it is about, as Messages' shared
 * objects ({ type: 'issue', appId, issueNumber } / { type: 'proposal',
 * appId, sessionId }). A card the bot cannot attach (a private project it
 * is not in) never costs the message: it is sent without its cards.
 * `replyToId` (#3707) is the person's message this one answers, quoted
 * above it as a person's reply quotes; one that cannot be quoted (see
 * quotable) is left off, never the message. #20 (WP3): `withoutCards` is
 * what the message says when its cards cannot go with it, for a message
 * whose words point at a card ("open the proposal below"): with the link
 * written out instead.
 * Resolves { conversationId, messageId, duplicate } or null when the person
 * blocked the bot or left the chat.
 */
// ── When the bot rings ───────────────────────────────────────────────────

// B4: a message from the bot notifies (a bell row and a push) only at four
// moments in a request's life, and when it answers what the person just
// wrote to it ('reply'). A first version used to ring six times: "setting
// up", its card, the question, a second card, "it's built", "it's live".
// Everything else (its progress card, "I'm building it now", a restart, a
// revision, an ack) is stored and counts as unread, and rings nothing.
const MOMENTS = Object.freeze({
  // Needs your answer.
  question: 'question', followup_ask: 'question', plan: 'question',
  // Ready to try.
  proposal: 'ready', ready: 'ready',
  // Stopped: it did not finish, or waits on something only time or a person changes.
  build_failed: 'stopped', blocked: 'stopped', person: 'stopped', empty: 'stopped',
  first_version_failed: 'stopped', preview_failed: 'stopped', allowance: 'held', paused: 'held',
  // #4242: built, but nothing will offer it to try without a person.
  needs_look: 'stopped',
  // Its checks still fail and a person needs to look at them.
  checks: 'stopped',
  // An update they asked for that did not happen ("your change stopped. I
  // said why in our chat", the stop's own words).
  followup_failed: 'stopped',
  // Live.
  merged: 'live',
  // An answer to what they wrote: the model's, and its offer to file.
  chat: 'reply', confirm: 'reply',
});

// WP-E: the notification kind each moment rings as, in the "Your builds" push
// category (mobile-push-preferences.js), so turning Messages off does not
// silence them. An answer to what somebody wrote ('reply') is a message.
// "One story": the moments by their names (homeroom-bot-notify-copy.js), and
// the older names a sender may still use.
const BUILD_KINDS = Object.freeze({
  ...notifyCopy.MOMENT_KINDS,
  question: 'build_needs_you',
  needs_you: 'build_needs_you',
  ready: 'build_ready',
  stopped: 'build_stopped',
  held: 'build_stopped',
  on_hold: 'build_stopped',
  live: 'build_live',
});

/** Pure: the moment a message of the bot's rings at, by its kind, or null (the names MOMENTS gives). */
function momentOf(metadata) {
  return MOMENTS[metadata?.kind] || null;
}

// ── One request, one story: the moment and what was said (contract 2.1) ──
//
// Every message the bot sends about a request says, in its metadata, which
// of the four moments that ring it is (`moment`: needs_you, ready, stopped,
// on_hold, live; none for a quiet line), and which of each moment's words
// (`said`), with the request and project it is about. The push, the bell and
// the email word themselves from these (homeroom-bot-notify-copy.js). MOMENTS
// above keeps the names older rows were written with, for their details.
const STORY_MOMENTS = Object.freeze({
  question: 'needs_you', followup_ask: 'needs_you', plan: 'needs_you',
  blocked: 'needs_you', person: 'needs_you', empty: 'needs_you',
  proposal: 'ready', ready: 'ready',
  build_failed: 'stopped', first_version_failed: 'stopped', preview_failed: 'stopped', needs_look: 'stopped',
  followup_failed: 'stopped', checks: 'stopped',
  allowance: 'on_hold', paused: 'on_hold',
  // 16 Oct 2026 (V4): a build held because the project's slots are all in
  // use rings once, as on hold: where it stands is no longer silent.
  held_proposals_per_app: 'on_hold', held_proposals_total: 'on_hold',
  merged: 'live',
  // 16 Oct 2026: somebody else's change shipped it (homeroom-bot-closed-requests.js).
  request_closed: 'done_elsewhere',
  // 16 Oct 2026: a person took on what it had promised (homeroom-bot-holds.js tellTaken).
  request_taken: 'on_hold',
  chat: 'reply', confirm: 'reply',
});
// The moments that ring, shown in the main chat as well as the request's thread.
const RINGING_MOMENTS = new Set(['needs_you', 'ready', 'stopped', 'on_hold', 'live', 'done_elsewhere']);
// A build that did not finish, by its cause (buildFailedCause).
const BUILD_SAID = Object.freeze({
  time: 'build_time', restart: 'build_restart', restarts: 'build_restart', no_change: 'build_no_change',
  unproposed: 'build_not_proposed', no_start: 'build_no_start', other: 'build_other',
});

/** Pure: the contract's moment for a message of the bot's, by its kind, or null. */
function storyMomentOf(metadata) {
  return STORY_MOMENTS[metadata?.kind] || null;
}

/**
 * Pure: which words a moment says (`said`, contract 2.1), from the message's
 * kind and what it carries. `info` adds what the message does not carry
 * itself (a verdict's `platform`, `done`, `deciders`; a build's `cause`;
 * whether others approve). Null for a kind with no moment.
 */
function saidOf(kind, info = {}) {
  const first = !!info.firstVersion;
  switch (kind) {
    case 'question': return Array.isArray(info.questions) && info.questions.length > 1 ? 'questions' : 'question';
    case 'followup_ask': return 'followup_ask';
    case 'plan': return first ? 'plan_first' : 'plan';
    case 'person':
      if (info.platform) return 'platform';
      if (info.done) return 'done';
      return Array.isArray(info.deciders) && info.deciders.length ? 'decide_others' : 'decide';
    case 'blocked': return 'blocked';
    case 'empty': return info.done ? 'done' : 'empty';
    case 'proposal': case 'ready':
      if (Array.isArray(info.ready?.broken) && info.ready.broken.length) return 'ready_broken';
      if (first) return 'ready_first';
      return info.group || info.ready?.group ? 'ready_group' : 'ready';
    case 'build_failed': return BUILD_SAID[info.cause] || 'build_other';
    case 'first_version_failed': return 'first_failed';
    case 'preview_failed': case 'needs_look': return 'needs_look';
    case 'checks': return 'checks';
    case 'followup_failed': return 'update_failed';
    case 'allowance': return 'allowance';
    case 'paused': return 'paused';
    case 'held_proposals_per_app': case 'held_proposals_total': return 'slots';
    case 'request_taken': return 'taken';
    case 'request_closed': return 'done_elsewhere';
    case 'merged': {
      const soon = info.live === false;
      if (first) return soon ? 'live_first_soon' : 'live_first';
      return soon ? 'live_soon' : 'live';
    }
    default: return null;
  }
}

/**
 * Pure: a message's metadata with the story's fields (contract 2.1) filled
 * in: `moment` (a ringing one only), `said`, the request's title (null for a
 * first version, which says `firstVersion`), and, in a request's thread,
 * `threadRootId` and `alsoInChat` for a moment that rings. What the caller
 * set itself wins.
 */
function storyMetadata(metadata, { moment = null, threadRootId = null, quiet = false } = {}) {
  if (!metadata) return metadata;
  const said = metadata.said || saidOf(metadata.kind, metadata);
  const ringing = RINGING_MOMENTS.has(moment);
  const about = Number.isInteger(Number(metadata.issueNumber)) && Number(metadata.issueNumber) > 0 && metadata.appSlug;
  return {
    ...metadata,
    ...(ringing ? { moment } : {}),
    ...(said && moment ? { said } : {}),
    ...(about && !('requestTitle' in metadata)
      ? { requestTitle: metadata.firstVersion ? null : (metadata.issueTitle || null) } : {}),
    ...(threadRootId ? { threadRootId } : {}),
    ...(threadRootId && ringing ? { alsoInChat: true } : {}),
    // #6019: a quiet line about a request, said in Main now that requests
    // have no thread there: it counts as nothing unread (conversations.js
    // countUnread), as it did in the thread it used to go in.
    ...(quiet && !ringing ? { quiet: true } : {}),
  };
}

/**
 * B4: what a ringing message's notification carries (notifications.detail),
 * for the push, the bell and the email to word it by
 * (homeroom-bot-notify-copy.js botNotificationDetail, from the message's
 * metadata). `moment` is what it rings at. A "ready to try" whose sender did
 * not say which one is "ready_group" on a project with others in it. Never
 * throws.
 */
async function notificationDetail(pool, moment, metadata) {
  if (!moment) return null;
  const meta = { ...(metadata || {}), moment };
  if (!meta.said && notifyCopy.normalizeMoment(moment) === 'ready' && !meta.firstVersion && meta.appSlug) {
    if (await hasOthers(pool, null, meta.appSlug)) meta.group = true;
  }
  return notifyCopy.botNotificationDetail(meta);
}

/**
 * B4: whether anybody but one person is in a project's community: who
 * approves a change to it, and how its news is worded. By id, or by slug.
 * Never throws; false when it cannot tell.
 */
async function hasOthers(pool, appId, appSlug = null) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members
       FROM apps a WHERE a.id = $1 OR ($1::int IS NULL AND a.slug = $2)`,
    [appId == null ? null : Number(appId), appSlug],
  ).catch(() => ({ rows: [] }));
  return (Number(rows?.[0]?.members) || 0) > 1;
}

/**
 * Send one message from the bot to `userId`, in their DM with it. `moment`
 * (B4): whether it rings, and as what ('reply' for an answer to what they
 * just wrote); left out, its kind decides (STORY_MOMENTS), and anything
 * else is silent.
 *
 * One story per request: a message about a request goes in that request's
 * thread, under its card (threadRootFor), and one of the four moments that
 * ring is shown in the main chat too (`alsoInChat`). `threadRootId` names
 * the thread outright; false keeps the message in the main chat.
 */
// B5: a person's one hello, claimed in the transaction that sends it (a
// row per person, homeroom_bot_hellos): `known` when the bot wrote to them
// before hellos existed, else the kind asked for. It returns the kind stored.
const CLAIM_HELLO_SQL = `
  INSERT INTO homeroom_bot_hellos (user_id, kind)
  SELECT $1::int, CASE WHEN EXISTS (
           SELECT 1 FROM conversation_messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
             JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1::int
            WHERE m.sender_id = $2::int
         ) THEN 'known' ELSE $3::text END
  ON CONFLICT (user_id) DO NOTHING
  RETURNING kind`;

// #5580: the project a ringing message is about, for its notification's
// app_id: the app its metadata names, or, for a reply in a request's thread,
// the app that request's card was sent about (homeroom_bot_dm_messages).
// Null when it is about no project (a hello, a reply in the main chat).
// Never throws: a message rings without a project rather than not at all.
async function storyAppId(pool, metadata, root) {
  try {
    if (metadata?.appSlug) {
      const { rows: [app] = [] } = await pool.query('SELECT id FROM apps WHERE slug = $1', [String(metadata.appSlug)]);
      if (app) return Number(app.id);
    }
    const rootId = conversations.strictId(root);
    if (rootId) {
      const { rows: [card] = [] } = await pool.query(
        'SELECT app_id FROM homeroom_bot_dm_messages WHERE message_id = $1',
        [rootId],
      );
      if (card) return Number(card.app_id);
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell which project a notification is about', { err: err.message });
  }
  return null;
}

async function sendDm(pool, {
  bot, userId, content, metadata = null, idempotencyKey = null, objects = null, replyToId = null, withoutCards = null,
  moment = undefined, threadRootId = undefined, hello = null,
}) {
  if (!bot?.id || !userId) return null;
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, userId);
  if (!opened) return null;
  const input = { content: clip(content, conversations.MAX_MESSAGE_LENGTH || 8000) };
  const key = conversations.normalizeIdempotencyKey(idempotencyKey);
  if (key) input.idempotency_key = key;
  // Main is one conversation (#6019): a message a caller would have put in
  // a request's thread, under its card, is said in Main beside the card.
  // A thread of the person's own (a private thread) keeps its messages.
  const asked = threadRootId === false ? null : conversations.strictId(threadRootId);
  const root = threadRootId === false ? null
    : (asked && !(await isRequestCard(pool, asked)) ? asked
      : await threadRootFor(pool, { conversationId: opened.conversationId, replyToId }));
  if (root) {
    // In a thread, what it answers is the line above it: no quote.
    input.thread_root_id = root;
  } else {
    const quote = await quotable(pool, opened.conversationId, userId, replyToId);
    if (quote) input.reply_to_id = quote;
  }
  const cards = Array.isArray(objects) ? objects.filter(Boolean).slice(0, MAX_CARDS) : [];
  const story = moment === undefined ? storyMomentOf(metadata) : (moment || null);
  // A "ready to try" says whether others approve it (contract 2.2's ready_group).
  const group = story === 'ready' && metadata && !metadata.said && !metadata.firstVersion && metadata.appSlug
    && !metadata.ready ? await hasOthers(pool, null, metadata.appSlug) : false;
  // #5582: a ringing message about a request whose sender passed no title
  // names it by the request's own one, so the bell says which request it is
  // and not just "Request #5580". A first version keeps naming the project.
  const title = story && wantsStoryTitle(metadata) ? await titleForStory(pool, metadata) : null;
  if (title) metadata = { ...metadata, issueTitle: title };
  if (title && hello?.metadata && wantsStoryTitle(hello.metadata)
    && hello.metadata.appSlug === metadata.appSlug
    && Number(hello.metadata.issueNumber) === Number(metadata.issueNumber)) {
    hello = { ...hello, metadata: { ...hello.metadata, issueTitle: title } };
  }
  // Said in Main instead of under the request's card (above).
  const quiet = !!asked && !root;
  const stored = metadata
    ? storyMetadata(group ? { ...metadata, group: true } : metadata, { moment: story, threadRootId: root, quiet })
    : null;
  // The notification's detail: homeroom-bot-notify-copy.js words the push,
  // the bell and the email from the story's fields (contract 2.1).
  const detail = story ? await notificationDetail(pool, story, stored) : null;
  // #5580: and the project it is about, so the bell files the bot's news
  // under that project as it files everybody else's.
  const notificationAppId = story ? await storyAppId(pool, metadata, root) : null;
  // Run six: a first version's ready and live, for a maker who turned
  // "We'll tell you when it's live" off, are said here and ring nothing.
  const firstNews = !!metadata?.firstVersion && (story === 'ready' || story === 'live');
  const muted = firstNews
    && (await firstVersionNotify(pool, { appSlug: metadata.appSlug, userId }).catch(() => null)) === false;
  // `hello` ({ kind, content, metadata }): the person's one hello, said by
  // this message when it is theirs to have, decided in the message's own
  // transaction, so a hello is never claimed and then not sent (a crash
  // between the two used to leave somebody greeted by nobody, ever).
  // `content` and `metadata` are the message as it reads with the hello;
  // without them the message is the hello alone, and is not sent at all when
  // the person has had theirs.
  let greeted = false;
  const helloStored = hello?.metadata
    ? storyMetadata(hello.metadata, { moment: story, threadRootId: root }) : null;
  // WP-E: the email that stands in for the push when no phone can take it,
  // for "ready to try", or a first version's LIVE, the moment its maker was
  // promised. A first version goes live without a vote a minute or two after
  // it is ready to try (D1), and two emails that close together would be one
  // too many (mail/rate-limit.js holds build mail five minutes apart), so its
  // ready sends none; its live is worded as its push is, from the detail.
  // Owed in the message's own transaction (the bot-dm machine's `dm.mail`):
  // sent after the commit, a restart in between lost it for good.
  const mailFor = metadata?.firstVersion ? 'live' : 'ready';
  const mail = !muted && story === mailFor ? {
    kind: 'build_ready', appName: metadata?.appName || null, appSlug: metadata?.appSlug || null,
    conversationId: opened.conversationId, threadRootId: root || null,
    ...(story === 'live' ? { detail } : {}),
    // Built, but part of it failed when Homeroom tried it: not "ready to try".
    ...(Array.isArray(metadata?.ready?.broken) && metadata.ready.broken.length ? { notWorking: true } : {}),
  } : null;
  // #4396: a first version's live tells the people who joined while it was
  // made that it is open (services/project-opened.js), whatever its maker
  // chose for their own: owed in the message's own transaction.
  const opens = story === 'live' && !!metadata?.firstVersion && !!metadata?.appSlug;
  let toldOpen = [];
  const hooks = {
    ...(hello?.kind ? {
      prepare: async (db) => {
        const { rows: claimed } = await db.query(CLAIM_HELLO_SQL, [Number(userId), Number(bot.id), String(hello.kind)]);
        greeted = claimed[0]?.kind === hello.kind;
        if (!greeted) return hello.content ? null : { refuse: true };
        return hello.content
          ? { content: clip(hello.content, conversations.MAX_MESSAGE_LENGTH || 8000), metadata: helloStored ? { [META]: helloStored } : null }
          : null;
      },
    } : {}),
    ...(hello?.kind || mail || opens ? {
      afterInsert: async (db, { messageId: id }) => {
        if (greeted) await db.query('UPDATE homeroom_bot_hellos SET message_id = $2 WHERE user_id = $1', [Number(userId), id]);
        if (mail) await require('../workflow/platform.ts').dmMailOwed(db, { userId: Number(userId), messageId: id, mail });
        if (opens) toldOpen = await require('./project-opened').oweTold(db, { appSlug: metadata.appSlug, makerId: userId });
      },
    } : {}),
  };
  const send = (withCards) => conversations.sendMessage(pool, { id: bot.id }, opened.conversationId,
    withCards.length
      ? { ...input, objects: withCards }
      : { ...input, ...(cards.length && withoutCards ? { content: clip(withoutCards, conversations.MAX_MESSAGE_LENGTH || 8000) } : {}) },
    {
      metadata: stored ? { [META]: stored } : null, notify: !!story && !muted, notificationDetail: detail,
      notificationKind: (story && BUILD_KINDS[story]) || null, notificationAppId, ...hooks,
    });
  let result = await send(cards);
  if (!result && cards.length) {
    log.info('homeroom-bot-dm', 'Cards refused; sending the message without them', { userId, cards: cards.length });
    result = await send([]);
  }
  if (!result || result.error) {
    log.warn('homeroom-bot-dm', 'DM refused', { userId, error: result?.error || 'refused' });
    return null;
  }
  const messageId = result.messageId ?? result.message?.id ?? null;
  // #4396: after the commit, the bells of the members its "live" told
  // (their notices, phone pushes and emails are owed in the message's own
  // transaction: afterInsert).
  if (toldOpen.length) await require('./project-opened').pushTold(pool, toldOpen);
  if (!result.duplicate) {
    await retireSuggestions(pool, {
      botId: bot.id, conversationId: opened.conversationId, keepMessageId: messageId, userId,
      about: stored, kind: metadata?.kind || null,
    });
    try {
      await pushLive(pool, result, opened.conversationId, { opened: opened.created, threadRootId: root, actorUserId: bot.id });
    } catch (err) {
      // The message and its bell row are in; a missed live refresh catches
      // up on the next load.
      log.warn('homeroom-bot-dm', 'Live fan-out failed', { userId, err: err.message });
    }
  }
  return {
    conversationId: opened.conversationId,
    messageId,
    duplicate: !!result.duplicate,
    threadRootId: root || null,
    ...(hello?.kind ? { hello: greeted } : {}),
  };
}

// ── Typing, while the bot answers ────────────────────────────────────────

// #3684: from the moment the bot starts on a person's message until its
// answer is sent, it shows as typing in their DM. It is the same
// `conversation_typing` event a person's composer sends (routes/
// conversations.js), to the same audience, so the Messages screen draws
// "homeroom_bot is typing…" with nothing new. A reader drops a typing line
// it has not heard again within 6 seconds (frontend/src/features/messages/
// store.ts), and a model's answer can take minutes, so the bot says it again
// every TYPING_RENEW_MS. It stops when the answer is sent or the handling
// fails, and at the latest TYPING_MAX_MS after it started whatever the
// handling is still doing, so the bot is never left typing forever: once
// nothing renews it, every reader clears the line on its own.
const TYPING_RENEW_MS = 4000;
// Homeroom bot parity, P1: a turn of sixteen rounds can run for minutes (it
// was three, when a turn had six).
const TYPING_MAX_MS = 8 * 60 * 1000;

// Where the bot types: a conversation's main chat, or one thread in it
// (31 Oct 2026: an answer to a message written in a thread lands in that
// thread, and its typing line is drawn there; it used to be the main chat's
// alone, which a phone does not show while a thread is open).
const typingPlace = (conversationId, threadRootId) => `${conversationId}:${threadRootId || 0}`;

// place -> { holders: Map<holder, deadline>, timer, doing }. A person can
// write again while the bot still answers their last message (the model's
// turns run one after another): the line stays up until the last answer is
// out, rather than going off between them.
const typingNow = new Map();
// place -> the send in flight: a place's typing events go out in order, so
// a quick answer's "stopped" never overtakes its "typing".
const typingSends = new Map();

// 1 Nov 2026: what the bot is doing while it types, said on its typing event
// as `doing` so the Messages screen draws a working card ("Reading request
// #12", "Drawing the screen") instead of a bare "is typing" line. A kind and
// what it names, never words: the screen says them in the reader's language
// (frontend/locales/en/messages.json `thread.botWorking.*`), as the agent
// session's activity line does from a tool's name. No `doing` is "Thinking".
// A person's typing event (routes/conversations.js) never carries one.
// Homeroom bot parity, P1: 'writing' carries the answer as it is written
// (homeroom-bot-mayor.js draftWriter), its own words and the only `text`
// a typing event has: the newest MAX_DRAFT_CHARS of it, so the event fits
// the bus between servers (ws-bus.js: 8000 bytes, or it becomes a nudge to
// reload) and the card stays a card. The message sent takes its place.
// 'looking': a helper sent to look into a project's code (P3, look_into).
const DOING_KINDS = Object.freeze(['progress', 'request', 'code', 'drawing', 'designing', 'drafting', 'writing', 'looking']);
const MAX_DOING_PROJECT = 60;
const MAX_DRAFT_CHARS = 1800;
const MAX_DRAFT_BYTES = 5600;

/** Pure: the end of an answer being written, as a typing event carries it: '…' and the newest words, when it is long. */
function draftTail(text) {
  let out = String(text || '').replace(/\r/g, '').trim();
  if (!out) return '';
  const fits = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_DRAFT_BYTES;
  if (out.length <= MAX_DRAFT_CHARS && fits(out)) return out;
  let keep = MAX_DRAFT_CHARS;
  let tail = out.slice(-keep);
  while (keep > 100 && !fits(`… ${tail}`)) {
    keep = Math.floor(keep * 0.8);
    tail = out.slice(-keep);
  }
  // From a word, not the middle of one.
  const space = tail.search(/\s/);
  if (space > 0 && space < 40) tail = tail.slice(space + 1);
  return `… ${tail.trimStart()}`;
}

/** Pure: `what` as a typing event carries it ({ kind, number?, project? }), or null for "thinking". */
function typingDoing(what) {
  if (!what || typeof what !== 'object' || !DOING_KINDS.includes(what.kind)) return null;
  if (what.kind === 'request') {
    const number = Number(what.number);
    return Number.isSafeInteger(number) && number > 0 ? { kind: 'request', number } : null;
  }
  if (what.kind === 'code' || what.kind === 'looking') {
    const project = typeof what.project === 'string' ? clip(what.project.replace(/\s+/g, ' ').trim(), MAX_DOING_PROJECT) : '';
    return project ? { kind: what.kind, project } : { kind: what.kind };
  }
  if (what.kind === 'writing') {
    const text = typeof what.text === 'string' ? draftTail(what.text) : '';
    return text ? { kind: 'writing', text } : null;
  }
  return { kind: what.kind };
}

const sameDoing = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

async function pushTyping(pool, botId, conversationId, typing, ws, threadRootId = null, doing = null) {
  try {
    await conversations.withLockedAudience(pool, { id: botId }, conversationId, (audience) => {
      ws.pushConversationEvent(audience, {
        type: 'conversation_typing', conversationId, userId: botId, typing,
        ...(threadRootId ? { threadRootId } : {}),
        ...(typing && doing ? { doing } : {}),
      }, { excludeUserId: botId, actorUserId: botId });
    });
  } catch (err) {
    // Ephemeral: a missed typing event costs nothing the answer needs.
    log.warn('homeroom-bot-dm', 'Typing event failed', { conversationId, typing, err: err.message });
  }
}

function sendTyping(pool, botId, conversationId, typing, ws, threadRootId = null, doing = null) {
  const place = typingPlace(conversationId, threadRootId);
  const prior = typingSends.get(place) || Promise.resolve();
  const next = prior.then(() => pushTyping(pool, botId, conversationId, typing, ws, threadRootId, doing));
  typingSends.set(place, next);
  next.then(() => { if (typingSends.get(place) === next) typingSends.delete(place); });
  return next;
}

/**
 * Show the bot typing in one conversation until the returned stop() is
 * called, or TYPING_MAX_MS passes. Never throws. `stop.doing(what)` says
 * what it is doing now (typingDoing; null: thinking): at once, if it
 * changed, and on every renewal after.
 */
function startTyping(pool, { botId, conversationId, threadRootId = null, ws = null }) {
  const id = Number(conversationId);
  if (!botId || !Number.isSafeInteger(id) || id <= 0) {
    const none = async () => {};
    none.doing = async () => {};
    return none;
  }
  const root = Number.isSafeInteger(Number(threadRootId)) && Number(threadRootId) > 0 ? Number(threadRootId) : null;
  const place = typingPlace(id, root);
  const io = ws || require('./ws');
  let entry = typingNow.get(place);
  if (!entry) {
    const created = { holders: new Map(), timer: null, doing: null, doingBy: null };
    created.end = () => {
      clearInterval(created.timer);
      if (typingNow.get(place) === created) typingNow.delete(place);
      return sendTyping(pool, botId, id, false, io, root);
    };
    created.timer = setInterval(() => {
      const now = Date.now();
      for (const [holder, deadline] of created.holders) if (now >= deadline) created.holders.delete(holder);
      if (!created.holders.size) {
        log.warn('homeroom-bot-dm', 'Stopped typing: the answer took too long', { conversationId: id });
        created.end();
        return;
      }
      // One renewal at a time: a slow database never queues them up.
      if (!typingSends.has(place)) sendTyping(pool, botId, id, true, io, root, created.doing);
    }, TYPING_RENEW_MS);
    created.timer.unref?.();
    typingNow.set(place, created);
    created.first = sendTyping(pool, botId, id, true, io, root);
    entry = created;
  }
  const holder = Symbol('typing');
  entry.holders.set(holder, Date.now() + TYPING_MAX_MS);
  const stop = async () => {
    // Already timed out, or another answer is still being written.
    if (!entry.holders.delete(holder)) return;
    if (entry.holders.size) {
      // What this answer was doing is not what the one still going is.
      if (entry.doingBy === holder) { entry.doing = null; entry.doingBy = null; }
      return;
    }
    await entry.end();
  };
  // Settles once "typing" has gone out (whileTyping waits for it).
  stop.ready = entry.first || Promise.resolve();
  stop.doing = (what) => {
    const next = typingDoing(what);
    // Stopped already, or saying what it already said.
    if (!entry.holders.has(holder) || typingNow.get(place) !== entry || sameDoing(next, entry.doing)) return Promise.resolve();
    entry.doing = next;
    entry.doingBy = next ? holder : null;
    return sendTyping(pool, botId, id, true, io, root, next);
  };
  return stop;
}

// The longest the answer waits for its "typing" to go out first.
const TYPING_FIRST_WAIT_MS = 2000;

/**
 * Run `work` with the bot typing in the conversation, and stop when it
 * settles. `work` is handed { doing, moveTo }: `doing` says what it is
 * doing now (startTyping's stop.doing); `moveTo(threadRootId)` carries the
 * typing, and what it last said it was doing, to another thread of the
 * same conversation where the answer goes on (null: the main chat).
 */
async function whileTyping(pool, { botId, conversationId, threadRootId = null, ws = null }, work) {
  let stop = startTyping(pool, { botId, conversationId, threadRootId, ws });
  let here = Number(threadRootId) || null;
  // What it last said it is doing, for the place it moves to.
  let said = null;
  // "typing" goes out before anything the answer does: a quick answer's own
  // events (its quote answered, its message) used to reach the reader first
  // when the typing event's audience lookup was slower than the answer.
  let waited = null;
  await Promise.race([
    Promise.resolve(stop.ready).catch(() => {}),
    new Promise((resolve) => { waited = setTimeout(resolve, TYPING_FIRST_WAIT_MS); waited.unref?.(); }),
  ]);
  clearTimeout(waited);
  const typing = {
    doing: (what) => { said = what; return stop.doing(what); },
    // 1 Nov 2026: a screen asked for in Main Chat is drawn in a thread the
    // designer opens (design-bot.js draw), so the working card waited in
    // Main Chat while the new thread looked idle. The typing goes there:
    // started in the thread first, saying what it was doing, then stopped
    // here, so the card is never gone from both.
    moveTo: async (rootId) => {
      const there = Number(rootId) || null;
      if (there === here) return;
      const was = stop;
      stop = startTyping(pool, { botId, conversationId, threadRootId: there, ws });
      here = there;
      if (said) await stop.doing(said);
      await was();
    },
  };
  try {
    return await work(typing);
  } finally {
    await stop();
  }
}

// ── Who a request is for ─────────────────────────────────────────────────

/**
 * The person a request is for, recorded the first time the live loop looks
 * at it: whoever filed it (homeroom-bot-live.js issuePoster), or for a
 * first version the creator it was filed for. Resolves { userId, username,
 * firstVersion, issueTitle } or null when nobody on Homeroom filed it.
 */
async function recordRequester(pool, { app, repo, issueNumber, issue = null }) {
  const title = issue?.title ? clip(issue.title, 300) : null;
  const { rows: found } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, q.asked_text, u.username, u.is_synthetic, u.locale, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [app.id, issueNumber],
  );
  if (found.length) {
    const row = found[0];
    if (title && title !== row.issue_title) {
      await pool.query(
        'UPDATE homeroom_bot_requesters SET issue_title = $3 WHERE app_id = $1 AND issue_number = $2',
        [app.id, issueNumber, title],
      ).catch(() => {});
    }
    return requesterFrom(row, { issueTitle: title || row.issue_title });
  }
  const live = require('./homeroom-bot-live');
  const poster = await live.issuePoster(pool, { app, repo, issueNumber, issue });
  if (!poster) return null;
  // B4: in their own words, when they wrote it here: the description of the
  // request they filed on the platform (Suggest an improvement).
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
     SELECT $1, $2, u.id, $4,
            (SELECT LEFT(NULLIF(BTRIM(i.description), ''), 2000) FROM issues i
              WHERE i.app_id = $1 AND i.github_issue_number = $2 AND i.created_by = u.id
              ORDER BY i.id DESC LIMIT 1)
       FROM users u
      WHERE LOWER(u.username) = LOWER($3) AND u.is_synthetic = FALSE
     ON CONFLICT (app_id, issue_number) DO UPDATE SET issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title)
     RETURNING user_id, first_version, issue_title, asked_text`,
    [app.id, issueNumber, poster, title],
  );
  if (!rows.length) return null;
  // Who they are, as hasBot reads it.
  const { rows: who } = await pool.query(
    'SELECT u.username, u.is_synthetic, u.locale, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [rows[0].user_id],
  );
  return requesterFrom({ ...rows[0], ...(who[0] || {}) }, { username: who[0]?.username || poster });
}

/** A person, as hasBot and noteOverAllowance read them, by id; null when there is none. */
async function personOf(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    'SELECT u.id AS user_id, u.username, u.is_synthetic, u.locale, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [userId],
  );
  return rows[0] ? requesterFrom(rows[0]) : null;
}

async function requesterOf(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, q.asked_text, u.username, u.is_synthetic, u.locale, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [appId, issueNumber],
  );
  return rows[0] ? requesterFrom(rows[0]) : null;
}

/**
 * 16 Oct 2026: request `issueNumber`'s title, for a requester the bot kept
 * none for (a row recorded where only the number was known): Homeroom's own
 * row of it, else GitHub's (cached), and kept on the requester's row from
 * then on. Its news named only the project without it: the bell read
 * "Needs you / Homeroom / Homeroom · Homeroom bot". Null when neither has
 * one. Never throws.
 */
async function requestTitleFor(pool, app, issueNumber, deps = {}) {
  const n = Number(issueNumber);
  if (!app?.id || !Number.isInteger(n) || n <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT title FROM issues
        WHERE app_id = $1 AND github_issue_number = $2 AND NULLIF(BTRIM(title), '') IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [app.id, n],
    );
    let title = rows[0]?.title || null;
    if (!title) {
      const github = deps.github || require('./github');
      let repoUrl = app.repo_url;
      if (repoUrl === undefined) {
        const { rows: found } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]);
        repoUrl = found[0]?.repo_url || null;
      }
      const repo = repoUrl && github.isEnabled?.() !== false ? repoRef.ownerRepo(repoUrl) : null;
      if (repo && typeof github.fetchPublicIssue === 'function') {
        const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, n);
        title = fetched?.issue?.title || null;
      }
    }
    title = title ? clip(String(title).trim(), 300) : null;
    if (!title) return null;
    await pool.query(
      `UPDATE homeroom_bot_requesters SET issue_title = $3
        WHERE app_id = $1 AND issue_number = $2 AND NULLIF(BTRIM(issue_title), '') IS NULL`,
      [app.id, n, title],
    );
    return title;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not look up a request\'s title', { app: app?.slug, issueNumber: n, err: err.message });
    return null;
  }
}

/**
 * #5582: a request's title for a message about it whose sender passed none
 * (sendPlanCard's card does): the requester row's cached one, else
 * requestTitleFor (Homeroom's own copy of the request, else GitHub's, cached
 * on the requester row from then on). Null when neither has one or the
 * lookup fails: the send is never blocked by it.
 */
async function titleForStory(pool, metadata) {
  const n = Number(metadata?.issueNumber);
  if (!metadata?.appSlug || !Number.isInteger(n) || n <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.repo_url, q.issue_title
         FROM apps a LEFT JOIN homeroom_bot_requesters q ON q.app_id = a.id AND q.issue_number = $2
        WHERE a.slug = $1`,
      [metadata.appSlug, n],
    );
    const row = rows[0];
    if (!row) return null;
    const cached = row.issue_title ? clip(String(row.issue_title).trim(), 300) : null;
    if (cached) return cached;
    return row.id ? await requestTitleFor(pool, { id: row.id, repo_url: row.repo_url }, n) : null;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not look up a story\'s request title', { app: metadata.appSlug, issueNumber: n, err: err.message });
    return null;
  }
}

/** Whether a message about a request still wants its title filled in. */
function wantsStoryTitle(metadata) {
  return !!metadata
    && Number.isInteger(Number(metadata.issueNumber)) && Number(metadata.issueNumber) > 0
    && !!metadata.appSlug
    && !metadata.firstVersion
    && !metadata.issueTitle
    && !('requestTitle' in metadata);
}

/**
 * #3707: the person's DM message a request of theirs started from, for the
 * bot's later news about it to quote. A request starts in the DM when File
 * it files the bot's offer, and the offer quotes the message it answered
 * (homeroom-bot-mayor.js offer); a draft in a private thread of its own
 * (#6019 follow-up) does not, and Main's line that opened the thread does.
 * Null for a request filed anywhere else.
 */
async function requestStart(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT COALESCE(o.reply_to_id, root.reply_to_id) AS reply_to_id
       FROM homeroom_bot_dm_actions a
       JOIN conversation_messages o ON o.id = a.message_id
       LEFT JOIN conversation_messages root ON root.id = o.thread_root_id
      WHERE a.user_id = $1 AND a.app_id = $2 AND a.issue_number = $3 AND a.status = 'done'
      ORDER BY a.id DESC
      LIMIT 1`,
    [userId, appId, issueNumber],
  );
  return rows[0]?.reply_to_id ?? null;
}

// ── The weekly allowance ─────────────────────────────────────────────────

/**
 * What one person's building time has cost the bot this week, in cents: the
 * triage, spec, build and follow-up turns they paid for. A run is theirs
 * when they are its payer (the person whose action started it), or, with no
 * payer recorded, when the request is theirs. A run the bot caused itself is
 * not charged (homeroom_bot_runs.charged) and counts for nobody, and the
 * bot's answers in their DM are not building time at all: chatting never
 * runs out. The week starts Monday 00:00 UTC, as every weekly limit on the
 * platform does (limits.weekStartUtc) and as weekKey reads it.
 */
async function weeklySpentCents(pool, userId) {
  // Homeroom bot parity (P3, P9): and the looks into code they asked for,
  // an investigation's check-ins among them (homeroom_bot_looks). P8: and the
  // pictures it made for them (services/bot-pictures.js), in the chat or for a
  // build they pay for.
  const { rows } = await pool.query(
    `SELECT COALESCE((SELECT SUM(COALESCE(r.cost_usd, 0) + COALESCE(r.build_cost_usd, 0))
       FROM homeroom_bot_runs r
       LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
      WHERE r.charged AND COALESCE(r.payer_user_id, q.user_id) = $1 AND r.created_at >= $2), 0)
      + COALESCE((SELECT SUM(l.cost_usd) FROM homeroom_bot_looks l
      WHERE l.charged AND l.user_id = $1 AND l.created_at >= $2), 0)
      + COALESCE((SELECT SUM(p.cost_usd) FROM homeroom_bot_pictures p
      WHERE p.payer_user_id = $1 AND p.created_at >= $2), 0) AS usd`,
    [userId, require('./limits').weekStartUtc()],
  );
  return Math.round((Number(rows[0]?.usd) || 0) * 100);
}

// The share of a week's building time left under which the next start card
// says so (activity.js), and the bot's own status answer calls it low.
const ALLOWANCE_LOW_SHARE = 0.2;

/**
 * This person's week of building time, in cents: the per-admin cap
 * (`homeroom_bot_admin_weekly_cents`) for an admin, view-only ones included,
 * else the per-person one. 0 means no cap. Reads the account only when the
 * two differ.
 */
async function weeklyCapCents(pool, settings, userId) {
  const cap = Number(settings?.userWeeklyCents);
  const adminCap = Number(settings?.adminWeeklyCents);
  if (!userId || !Number.isFinite(adminCap) || adminCap === cap) return cap;
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true ? adminCap : cap;
}

/** Whether this person has less than ALLOWANCE_LOW_SHARE of their week left. False with no cap. */
async function allowanceLow(pool, settings, userId) {
  if (!userId) return false;
  const cap = await weeklyCapCents(pool, settings, userId);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return cap - await weeklySpentCents(pool, userId) < cap * ALLOWANCE_LOW_SHARE;
}

/** Whether this person's requests have used their week's allowance. 0 means no cap. */
async function overWeeklyAllowance(pool, settings, userId) {
  if (!userId) return false;
  const cap = await weeklyCapCents(pool, settings, userId);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return (await weeklySpentCents(pool, userId)) >= cap;
}

function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Pure: what the person whose building time is used up hears (contract
 * 2.2, `allowance`). No amount: the limit is building time, not money, and
 * on a project with others in it, somebody else can ask for it on theirs
 * (homeroom-bot-mayor.js start_request). `line` (#4097), the request's line,
 * leads it when it is said outside the request's thread.
 */
function overAllowanceText({ line = null, appName, group = false }) {
  const said = group
    ? `On hold until Monday: your building time for this week is used up. Someone else in ${appName} can ask me for it sooner.`
    : 'On hold until Monday: your building time for this week is used up.';
  return line ? `${line}\n\n${said}` : said;
}

/**
 * Said once a week, to the person whose building time holds a request back
 * (its payer; the requester unless somebody else asked for it), when the bot
 * talks to them. One story: ONE message a week that rings (on_hold, with
 * `count`, how many of their requests are held), and each held request's
 * thread says it quietly; its card says On hold until Monday.
 */
async function noteOverAllowance(pool, { settings, requester, payer = null, app, issueNumber, bot }) {
  const who = payer || requester;
  if (!who || !hasBot(settings, who)) return null;
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members
       FROM apps a WHERE a.id = $1`,
    [app.id],
  ).catch(() => ({ rows: [] }));
  const { rows: [held] = [] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM homeroom_bot_queue q
       JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
      WHERE r.user_id = $1 AND q.held_until > NOW()`,
    [who.userId],
  ).catch(() => ({ rows: [] }));
  const appName = app.name || app.slug;
  const group = (Number(rows[0]?.members) || 0) > 1;
  const count = Math.max(Number(held?.n) || 0, 1);
  const context = { appName, issueNumber, issueTitle: requester?.issueTitle || null, firstVersion: !!requester?.firstVersion };
  const mine = !payer || Number(payer.userId) === Number(requester?.userId);
  // The held request's own thread says it, quietly, whichever week it is.
  if (mine) {
    await noteStep(pool, {
      bot, userId: who.userId, app, issueNumber, step: 'on_hold', key: `hrbot-step-held-${app.id}-${issueNumber}-${weekKey()}`,
      content: overAllowanceText({ appName, group }),
    });
  }
  return sendDm(pool, {
    bot,
    userId: who.userId,
    idempotencyKey: `hrbot-allowance-${who.userId}-${weekKey()}`,
    // One message for every held request: the main chat, not a thread.
    threadRootId: false,
    replyToId: count > 1 ? null : await requestStart(pool, { userId: who.userId, appId: app.id, issueNumber }),
    content: overAllowanceText({ line: count > 1 ? null : requestLine(context), appName, group }),
    metadata: {
      kind: 'allowance', appSlug: app.slug, appName, issueNumber, count,
      ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
      ...(context.firstVersion ? { firstVersion: true } : {}),
    },
  });
}

// What the person hears when the bot's own weekly budget (its users row,
// limits.checkBudget) stops work of theirs that was about to start
// (contract 2.2, `paused`).
const PAUSED_FOR_WEEK_TEXT = 'On hold until Monday: I\'ve used my budget for this week. Your requests are saved and I\'ll pick them up on Monday.';

/**
 * The bot's own weekly budget is spent (homeroom-bot.js pauseOnBudget), and
 * work of this person's was next: they hear it once a week, whichever
 * request it was, rather than finding the bot quiet. `apps` names the
 * projects held, when the caller knows them. Resolves what sendDm did, or
 * null for somebody the bot does not talk to.
 */
async function notePausedForWeek(pool, { settings, bot, userId, apps = [] }) {
  if (!bot?.id || !userId) return null;
  const { rows } = await pool.query(
    'SELECT u.id AS user_id, u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [userId],
  );
  if (!rows[0] || !hasBot(settings, requesterFrom(rows[0]))) return null;
  const names = (Array.isArray(apps) ? apps : []).map((a) => a?.name || a?.slug).filter(Boolean).slice(0, 3);
  return sendDm(pool, {
    bot,
    userId,
    idempotencyKey: `hrbot-paused-${userId}-${weekKey()}`,
    content: PAUSED_FOR_WEEK_TEXT,
    threadRootId: false,
    metadata: { kind: 'paused', ...(names.length ? { appName: names.join(', ') } : {}) },
  });
}

/**
 * WP1 (#9): a build of one of their requests was interrupted (a restart
 * took its worker, or cut its plan short) and the request was sent back to
 * be built again. Says nothing: the request's card and the tray say it is
 * building, as they did before. The caller stays, so a restart that does
 * need the person can be said here again. Resolves null.
 */
async function noteBuildRestarted() {
  return null;
}


// ── The request's news, in the DM ────────────────────────────────────────

/**
 * Pure (B4): what somebody asked for, in their own words, as one line of
 * about `max` characters, cut at a word: what their activity card leads with.
 * Null for nothing.
 */
function askedLine(text, max = 120) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

function requestLine({ appName, issueNumber, issueTitle, firstVersion }) {
  if (firstVersion) return `**${appName}**, its first version`;
  return `**${appName}** · request #${issueNumber}${issueTitle ? `: ${clip(issueTitle, 140)}` : ''}`;
}

/** Pure (B6): whether a question post asks two questions at once. */
function twoQuestions(dm) {
  return Array.isArray(dm?.questions) && dm.questions.length > 1;
}

/** Pure (B6): the words above two questions' card. */
function questionLead(line, it, dm) {
  return `${line}\n\nI have ${twoQuestions(dm) ? 'two questions' : 'a question'} before I build ${it}:`;
}

/**
 * Pure: what ended a build that did not finish, as one of a few causes
 * ({ cause, times }). `reason` is the run's own record (homeroom-bot.js,
 * homeroom-bot-live.js), written for the platform: on 5 Oct 2026 a
 * requester read "the build ran past its time limit (finished after a
 * restart)". It is read for what happened and never quoted. "(finished
 * after a restart)" only says which process recorded it, never why it
 * ended: a build that ran too long or changed nothing is said as that.
 */
function buildFailedCause(reason) {
  // Read from the reason alone: what a failed turn was last doing and its
  // final message follow it (homeroom-bot-live.js failureDetail), and an
  // agent that wrote "the server would not start" did not fail to start.
  const r = String(reason || '').split(/; (?:last activity|it last said):/)[0]
    .replace(/\s*\(finished after a restart\)/g, '');
  const restarts = /restarted in the middle of each of its last (\d+) tries/.exec(r);
  if (restarts) return { cause: 'restarts', times: Number(restarts[1]) };
  if (/ran past its time limit/.test(r)) return { cause: 'time' };
  if (/restarted|by a restart/.test(r)) return { cause: 'restart' };
  if (/built but could not be proposed/.test(r)) return { cause: 'unproposed' };
  if (/produced no change/.test(r)) return { cause: 'no_change' };
  if (/could not start|would not start|could not open a session|could not create its branch/.test(r)) {
    return { cause: 'no_start' };
  }
  return { cause: 'other' };
}

// What the bot was doing when it stopped: building a request, or updating
// a change it had already built, after somebody asked for something
// different on it (homeroom-bot-followup.js revisionFailedText).
const FAILED_DOING = Object.freeze({
  build: Object.freeze({ verb: 'finish building', noun: 'build', starting: 'building' }),
  update: Object.freeze({ verb: 'update', noun: 'update', starting: 'updating' }),
});

// Each cause in words, two ways (5 Oct 2026). `me`: the bot to the person
// it was building for, in its DM. `bot`: about the bot, on the request
// itself, where everybody in the project reads it (homeroom-bot-live.js
// buildFailedText, also its GitHub comment), as the bot's other posts there
// are worded.
const FAILED_SAID = Object.freeze({
  me: Object.freeze({
    restarts: (d, it, n) => `I couldn't ${d.verb} ${it}: Homeroom restarted while I was working on it, ${n} times in a row.`,
    time: (d, it) => `I couldn't ${d.verb} ${it}: it took longer than I'm allowed.`,
    restart: (d, it) => `I couldn't ${d.verb} ${it}: Homeroom restarted while I was working on it.`,
    unproposed: (d, it) => `I built ${it}, but I couldn't put it up for approval.`,
    no_change: (d, it) => `I couldn't ${d.verb} ${it}: I ended up with no changes to show you.`,
    no_start: (d, it) => `I couldn't get started on ${d.starting} ${it}.`,
    other: (d, it) => `I couldn't ${d.verb} ${it}: something went wrong while I was working on it.`,
  }),
  bot: Object.freeze({
    restarts: (d, it, n) => `Homeroom bot couldn't ${d.verb} ${it}: Homeroom restarted in the middle of the ${d.noun}, ${n} times in a row.`,
    time: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: the ${d.noun} took longer than it's allowed.`,
    restart: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: Homeroom restarted in the middle of the ${d.noun}.`,
    unproposed: (d, it) => `Homeroom bot built ${it}, but couldn't put it up for approval.`,
    no_change: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: it ended up with no changes to show.`,
    no_start: (d, it) => `Homeroom bot couldn't get started on ${d.starting} ${it}.`,
    other: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: something went wrong during the ${d.noun}.`,
  }),
});

// 14 Oct 2026 (newcomer run eight, Club Votes): a first version that was
// built and then not proposed was "I built the first version, but I couldn't
// put it up for approval." A first version needs nobody's approval (D1), so
// it says what is true: it is built and not live yet. Its other causes say
// nothing about approval, and read as a change's do.
const FIRST_UNPROPOSED_SAID = Object.freeze({
  me: (it) => `I built ${it} but couldn't put it live yet.`,
  bot: (it) => `Homeroom bot built ${it} but couldn't put it live yet.`,
});

/**
 * Pure: why the bot stopped, in plain words, from the run's own record
 * (read by buildFailedCause, never quoted). `voice` is 'me' (the default:
 * the bot to the person it was for, in its DM) or 'bot' (about the bot, on
 * the request); `doing` is 'build' (the default) or 'update' (a change it
 * had built, which has nothing left to put up for approval). `first`: a
 * project's first version, which goes live without approval.
 */
function failedWords(reason, { it = 'this', voice = 'me', doing = 'build', first = false } = {}) {
  const read = buildFailedCause(reason);
  const d = FAILED_DOING[doing] || FAILED_DOING.build;
  const cause = d === FAILED_DOING.update && read.cause === 'unproposed' ? 'other' : read.cause;
  if (first && cause === 'unproposed') return (FIRST_UNPROPOSED_SAID[voice] || FIRST_UNPROPOSED_SAID.me)(it);
  return (FAILED_SAID[voice] || FAILED_SAID.me)[cause](d, it, read.times);
}

/**
 * Pure: why a build of `it` did not finish (failedWords), in the DM's voice
 * or ('bot') on the request; `first` for a project's first version.
 */
function buildFailedWords(reason, it = 'this', voice = 'me', { first = false } = {}) {
  return failedWords(reason, { it, voice, doing: 'build', first });
}

/**
 * Pure (5 Oct 2026): why the bot could not update `it`, a change it had
 * built, after it was asked for something different on it: the same causes
 * as a build's, from the same reading of the run's record
 * (homeroom-bot.js runFollowUp: "the turn produced no change", "its change
 * could not be pushed", "the turn failed (...), so its change was not
 * kept"), said in the same two voices.
 */
function updateFailedWords(reason, it = 'this change', voice = 'me') {
  return failedWords(reason, { it, voice, doing: 'update' });
}

/**
 * A request the triage found already done (`done`: it exists in the app, or
 * a merged change did it). It was a dead end: "a person needs to decide",
 * with nothing to decide. One story: the offer is folded into this message,
 * Propose to close and Tell me what's missing (homeroom-bot-move.js
 * foldOffer); a reply still asks the bot to look again.
 */
function doneText(line, dm) {
  return `${line}\n\nThis looks done already: ${clip(dm.reason, 600)}`;
}

/**
 * Who a person hand-off waits on, when it is not the requester: the
 * project's creator and admins (homeroom-bot.js whoDecides), at most four,
 * as usernames.
 */
function personDeciders(dm) {
  return (Array.isArray(dm?.deciders) ? dm.deciders : [])
    .filter((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name))
    .slice(0, 4);
}

/** "@a", "@a or @b", "@a, @b or @c". */
function deciderNames(dm) {
  const names = personDeciders(dm).map((name) => `@${name}`);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * The DM text for one of the bot's posts on a request, from the structured
 * `dm` its caller passed (homeroom-bot.js): plain words, no code. Returns
 * null for a kind the DM does not carry. In the request's thread
 * (`context.threaded`) it is said under the request's card, so it does not
 * name the request again.
 */
function dmText(kind, dm, context) {
  const text = requestNews(kind, dm, context);
  return typeof text === 'string' ? text.replace(/^\s+/, '') : text;
}

function requestNews(kind, dm, context) {
  const line = context.threaded ? '' : requestLine(context);
  const it = context.firstVersion ? 'the first version' : 'this';
  switch (kind) {
    case 'question':
      // B6: two questions, asked at once (the card under it draws both).
      if (twoQuestions(dm)) return `${questionLead(line, it, dm)}\n\n${dm.questions.map((q, i) => `${i + 1}. ${clip(q.question, 300)}`).join('\n')}`;
      return `${line}\n\nI have a question before I build ${it}:\n\n${clip(dm.question, 2000)}`;
    case 'followup_ask':
      return `${line}\n\nI have a question before I update your change:\n\n${clip(dm.question, 2000)}`;
    case 'spec':
      // One story: a quiet line in the request's thread. A first version
      // tried once more on its own (homeroom-bot.js buildLive) says so.
      if (dm.retry) return `${line}\n\nMy first try didn't finish, so I'm trying once more from the same plan.`;
      if (dm.plan) return `${line}\n\nPlan: ${clip(String(dm.plan).replace(/[.\s]+$/, ''), 200)}. I'm building it now.`;
      return `${line}\n\nI'm building ${it} now.`;
    // #20 (WP3): the change's card under the message is its link (cardsFor
    // attaches it whenever the news names its session), so the text points
    // at the card. The address is written out only when there is no card:
    // beside one it was a raw URL next to the same link, in the DM and in
    // its push. B4: sent once it is ready to try (tellReady), and in
    // plain words: on a project of theirs alone they approve it themselves;
    // with others in it, it goes live once it is approved.
    case 'proposal':
      // B7: the ready card, whose buttons say the rest (Try it, Approve).
      // A change part of which does not work says so first, plainly.
      if (dm.card && brokenWords(dm.card.broken).length) {
        const said = brokenWords(dm.card.broken).map((words) => words.replace(/[.\s]+$/, ''));
        const what = said.length === 1
          ? `one thing isn't working yet: ${said[0]}`
          : `${said.length} things aren't working yet: ${said.join('; ')}`;
        return dm.card.approve
          ? `${line}\n\nIt's built, but ${what}. Try it, and approve it only if you're happy with it as it is.`
          : `${line}\n\nIt's built, but ${what}. Try it to see.`;
      }
      // D1 (13 Oct 2026): a project's first version needs nobody's
      // approval; it is ready because its checks passed, and goes live now.
      if (dm.card && dm.card.noVote) {
        return `${line}\n\nIt's ready to try. As the first version, it goes live without a vote in a minute or two.`;
      }
      if (dm.card) {
        return dm.card.approve
          ? `${line}\n\nIt's ready to try. Approve it when you're happy with it${dm.card.last ? ', and it goes live' : ''}.`
          : `${line}\n\nIt's ready to try. It goes live once it's approved.`;
      }
      if (hasProposalCard(dm)) {
        return context.group
          ? `${line}\n\nIt's ready to try. Open the change below to see the preview. It goes live once it's approved.`
          : `${line}\n\nIt's ready to try. Open the change below to see the preview, and approve it when you're happy with it.`;
      }
      return context.group
        ? `${line}\n\nIt's ready to try. See the preview here: ${dm.link}\n\nIt goes live once it's approved.`
        : `${line}\n\nIt's ready to try. See the preview, and approve it when you're happy with it: ${dm.link}`;
    case 'followup_revise': {
      let look = '';
      if (hasProposalCard(dm)) look = '\n\nTake another look at it below.';
      else if (dm.link) look = `\n\nTake another look: ${dm.link}`;
      return `${line}\n\nI updated your change after the latest replies: ${clip(dm.summary, 600)}${look}`;
    }
    case 'blocked':
      return `${line}\n\nI looked into this and can't build it as it's written: ${clip(dm.reason, 600)}\n\n`
        + 'Reply to this message with more detail and I\'ll look again.';
    case 'build_failed':
      // What happened in plain words, never the run's own record of it
      // (buildFailedWords), and what to do about it, as #3772 gave `person`:
      // "A person can pick it up from here" was a dead end for somebody who
      // was the person. A reply here, quoting this or not, is read by the
      // bot (it is not one of MIRRORED_KINDS), which starts the request
      // again (homeroom-bot-mayor.js start_request): on 5 Oct 2026 "Oh no,
      // can you try again?" had it building again within seconds.
      // 14 Oct 2026 (newcomer run eight): a first version is named, never
      // said to wait for approval it does not need, and points at the Try
      // again under the message. Try again reads it again and writes a new
      // plan for Build it (it does not re-propose what was built), so it
      // says it starts over.
      // 15 Oct 2026: except one that was built and only not proposed: Try
      // again proposes what was built (finishOnTryAgain), so it says it
      // finishes it. Every other cause still starts over.
      if (context.firstVersion) {
        const finishes = buildFailedCause(dm.reason).cause === 'unproposed';
        return `${line}\n\n${buildFailedWords(dm.reason, context.appName || it, 'me', { first: true })} `
          + (finishes ? 'Tap Try again and I\'ll finish it.' : 'Tap Try again and I\'ll start over.');
      }
      return `${line}\n\n${buildFailedWords(dm.reason, it)} Reply here and I'll try again.`;
    case 'followup_failed': {
      // 5 Oct 2026: an update to their change that did not happen, in plain
      // words (updateFailedWords), never the run's own record, and how to
      // try again that is sure to reach the bot: Change something on the
      // change, which posts what they write in its discussion and puts its
      // follow-up first in the queue (homeroom-bot-mayor.js reviseAttached).
      // A reply here goes to the bot's chat model, which can send it on the
      // same way (revise_proposal) once it knows what to change, so the DM
      // names the way that does not depend on it.
      const change = context.firstVersion ? 'the first version' : 'your change';
      if (dm.canRevise === false) {
        return `${line}\n\nI couldn't update ${change}: I've already updated it as many times as I can on my own, `
          + 'so a person needs to make this one. It\'s as it was.';
      }
      const words = updateFailedWords(dm.reason, change, 'me');
      let next = `To try again, open it on ${context.appName} and tap Change something.`;
      if (hasProposalCard(dm)) next = 'To try again, tap Change something on it below.';
      else if (dm.link) next = `To try again, open it and tap Change something: ${dm.link}`;
      return `${line}\n\n${words} It's as it was. ${next}`;
    }
    case 'checks': {
      // One story: red checks the bot could not fix reach the requester as
      // a stop, with the change to open (Open the change).
      const n = Number(dm.failing) || 0;
      const k = Number(dm.tries) || 0;
      const fail = n === 1 ? '1 check still fails' : `${n || 'Some'} checks still fail`;
      const after = k ? ` after ${k} ${k === 1 ? 'try' : 'tries'}` : '';
      return `${line}\n\nI can't get its checks to pass on my own: ${fail}${after}. A person needs to look at them.`;
    }
    case 'person':
      // #4239: about Homeroom itself, so nothing on this project can do it.
      // One story: the offer to move it to Homeroom's own board is this
      // message's own buttons (homeroom-bot-move.js foldOffer).
      if (dm.platform) {
        return `${line}\n\nThis is about Homeroom itself rather than ${context.appName}, so no change to ${context.appName} `
          + `can do it: ${clip(dm.reason, 600)}`;
      }
      if (dm.done) return doneText(line, dm);
      // #3772: and what to do about it. "Left for the group" was a dead end
      // for somebody who was the group: a reply here is posted on the
      // request, and the bot looks at it again with it.
      // On a project where somebody else decides (its creator or admins,
      // homeroom-bot.js whoDecides), a go-ahead from the requester would
      // only be read to the same answer: they are told who it waits on.
      if (personDeciders(dm).length) {
        const several = personDeciders(dm).length > 1;
        return `${line}\n\nThis needs a person to decide, so I haven't built it: ${clip(dm.reason, 600)}\n\n`
          + `On ${context.appName}, ${deciderNames(dm)} ${several ? 'decide' : 'decides'} things like this. `
          + `Once ${several ? 'one of them says' : 'they say'} to go ahead on the request, I'll look at it again.`;
      }
      return `${line}\n\nThis needs a person to decide, so I haven't built it: ${clip(dm.reason, 600)}\n\n`
        + 'If you decide to go ahead (or the group does), reply to this message and say so, and I\'ll look at it again.';
    case 'followup_person':
      return `${line}\n\nThis needs a person to decide, so I've left it for the group: ${clip(dm.reason, 600)}`;
    case 'empty':
      if (dm.done) return doneText(line, dm);
      return `${line}\n\nI couldn't find anything to build in this yet. Reply to this message with what you'd like `
        + 'changed and I\'ll look again.';
    // A cap on how many changes the bot keeps waiting for approval held a
    // request it would build (homeroom-bot.js actOnVerdict). The cap's own
    // refresh brings it back when there is room, so nothing is asked of them:
    // a quiet line in the request's thread, and its card says Waiting.
    case 'held_proposals_per_app':
      return `${line}\n\nI'll start when one of my ${Number(dm.limit) || ''} changes on ${context.appName} is voted in or closed.`
        .replace('my  changes', 'my changes');
    case 'held_proposals_total':
      return `${line}\n\nI'll start when one of my ${Number(dm.limit) || ''} changes across Homeroom is voted in or closed.`
        .replace('my  changes', 'my changes');
    default:
      return null;
  }
}

/**
 * Close the questions still open on a request: a newer post about it (a
 * new question, the proposal, a hand-off) means the old ones are not what
 * the bot is waiting on any more. Their chips go away.
 */
async function closeOpenQuestions(pool, { userId, appId, issueNumber, ws = null }) {
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_dm_messages SET question_status = 'closed'
      WHERE user_id = $1 AND app_id = $2 AND issue_number = $3 AND question_status = 'open'
      RETURNING message_id, conversation_id`,
    [userId, appId, issueNumber],
  );
  for (const row of rows) await setQuestionState(pool, row.message_id, { status: 'closed' }, { ws, conversationId: row.conversation_id, userId });
  return rows.length;
}

/**
 * The requester of a request when the bot tells them its news in a DM:
 * { userId, username }, or null. Whether the bot's post on the request then
 * leaves them untagged is for untaggedRequester, from what the DM did.
 */
async function dmRecipient(pool, appId, issueNumber) {
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, appId, issueNumber);
  return requester && hasBot(settings, requester)
    ? { userId: requester.userId, username: requester.username }
    : null;
}

/**
 * #3698: the requester the bot's post on a request leaves untagged, once
 * relayIssuePost has run for it (`told` is what it resolved). Decided by
 * what the DM actually did, not by who it would go to: the requester when
 * it reached them (it rang in their DM, and the post would ring twice), or
 * when they blocked the bot (nothing from it is for them). Resolves their
 * username, or null when the post tags them like anybody else: they left
 * the bot's DM, the DM was refused or the relay failed, and the news still
 * has to reach them once.
 */
async function untaggedRequester(pool, { appId, issueNumber, bot, told = null }) {
  // WP1 (#6): news that was stale by the time it was relayed reached
  // nobody's DM on purpose, and the post does not ring them about it either.
  // B4: nor does "it's built" while the requester waits to hear it is ready.
  if ((told?.messageId || told?.stale || told?.deferred || told?.quiet) && told.username) return told.username;
  if (!bot?.id) return null;
  const recipient = await dmRecipient(pool, appId, issueNumber);
  if (!recipient) return null;
  return await conversations.blockedEitherWay(pool, bot.id, recipient.userId) ? recipient.username : null;
}

/** Update a DM question's state in the message itself, so the reader's chips follow. */
async function setQuestionState(pool, messageId, patch, { ws = null, conversationId = null, userId = null } = {}) {
  const { rows } = await pool.query(
    'SELECT metadata, conversation_id, sender_id, thread_root_id FROM conversation_messages WHERE id = $1',
    [messageId],
  );
  if (!rows.length) return;
  const metadata = rows[0].metadata && typeof rows[0].metadata === 'object' ? rows[0].metadata : {};
  const bot = metadata[META] && typeof metadata[META] === 'object' ? metadata[META] : {};
  await conversations.setMessageMetadata(pool, messageId, { ...metadata, [META]: { ...bot, ...patch } });
  const io = ws || require('./ws');
  const members = [rows[0].sender_id, userId].filter(Boolean);
  io.pushConversationEvent(members, {
    type: 'conversation_message_updated', conversationId: conversationId || rows[0].conversation_id, messageId,
    // In a request's thread, the open thread reads it again too.
    threadRootId: rows[0].thread_root_id ? Number(rows[0].thread_root_id) : null,
  }, { actorUserId: rows[0].sender_id });
}

// News the request's card and the tray above the DM show, and that the
// person can do nothing about, is never a message that rings: "I'm building
// it now", a build held because the project already has changes waiting, an
// update made where they asked for it (said there). One story per request:
// in the request's thread it is a quiet line (no bell, no push, no unread in
// the main chat); a request with no thread (no card) keeps it on the card
// and the tray alone. The DM rings when it needs them or has news they act
// on: a question, a plan, a change to try, a stop, live. On 9 October 2026
// one person's DM got 123 messages in an afternoon, 53 of which rang.
// 16 Oct 2026 (V4): a build held because the project's slots are all in use
// is no longer card-only: it rings once, as on hold (STORY_MOMENTS), so the
// wait is never silent. It is said once per hold (actOnVerdict, quietHold).
const CARD_ONLY = new Set(['spec', 'followup_revise']);

/** Pure: whether a post's news is quiet: a line in its thread, or nothing without one (CARD_ONLY). */
function cardOnly(kind, dm = null) {
  // Trying once more is news the card alone would not say: it reads
  // "building" either way.
  if (kind === 'spec' && dm?.retry) return true;
  return CARD_ONLY.has(kind);
}

/** Pure: the kind a post's news is told as: red checks handed to a person are a stop of their own. */
function newsKind(kind, dm = null) {
  return kind === 'followup_person' && dm?.checks ? 'checks' : kind;
}

// WP1 (#6): the news of one build, which can be overtaken before it is told.
const BUILD_NEWS = new Set(['spec', 'proposal', 'build_failed']);

/**
 * WP1 (#6): why one build's news (BUILD_NEWS) is stale by the time it is
 * relayed, or null. Another run's proposal for the request is up for a
 * vote, being merged, or merged since this run's verdict: the request is
 * answered, and this run is a second build of it. Or, for its plan and its
 * failure, a newer look at the request overtook this run. On 3 October a
 * second build of Plant Pal #1 said "I'm building this now" after the first
 * had said "It's built". A proposal is never stale for being older than the
 * newest look: it is the one people vote on, and they hear it is built.
 */
async function staleBuildNews(pool, { appId, issueNumber, runId, kind }) {
  const { rows: [row] = [] } = await pool.query(
    `SELECT EXISTS (
              SELECT 1 FROM homeroom_bot_runs n
               WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.id > r.id AND n.mode = 'live'
            ) AS overtaken,
            (SELECT cs.id FROM homeroom_bot_runs o
               JOIN chat_sessions cs ON cs.id = o.proposal_session_id
              WHERE o.app_id = r.app_id AND o.issue_number = r.issue_number AND o.id <> r.id
                AND cs.id IS DISTINCT FROM r.proposal_session_id AND cs.id IS DISTINCT FROM r.build_session_id
                AND (cs.status IN ('promoted', 'merging') OR (cs.status = 'merged' AND cs.merged_at >= r.created_at))
              ORDER BY o.id LIMIT 1) AS other_proposal
       FROM homeroom_bot_runs r
      WHERE r.id = $1 AND r.app_id = $2 AND r.issue_number = $3`,
    [runId, appId, issueNumber],
  );
  if (!row) return null;
  if (row.other_proposal) return `proposal ${Number(row.other_proposal)} already answers the request`;
  if (kind !== 'proposal' && row.overtaken) return 'a newer look at the request overtook it';
  return null;
}

/**
 * #3767: whether a person's DM has an activity card for this request:
 * null, or { messageId, conversationId, current } where `current` is true
 * while the card is the newest thing the DM says about the request.
 */
async function cardShown(pool, userId, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, kind FROM homeroom_bot_dm_messages
      WHERE user_id = $1 AND app_id = $2 AND issue_number = $3
      ORDER BY message_id DESC LIMIT 20`,
    [userId, appId, issueNumber],
  );
  const card = rows.find((r) => r.kind === 'activity');
  if (!card) return null;
  return { messageId: card.message_id, conversationId: card.conversation_id, current: rows[0] === card };
}

/**
 * Called by the bot's post on a request (homeroom-bot-live.js `post`) when
 * the post carries `dm`: the same news, in the requester's DM, when they
 * are somebody the bot talks to there. Resolves what was sent, with who it
 * went to ({ conversationId, messageId, duplicate, userId, username }), or
 * null when nothing reached them.
 */
// B9: what the bot's news about a request says on the chat message it was
// asked in, if it was (homeroom-bot-chat.js): building, or stopped.
const CHAT_STATUS_OF_KIND = Object.freeze({
  spec: 'building', build_failed: 'stopped', blocked: 'stopped', person: 'stopped', empty: 'stopped',
});

async function relayIssuePost({
  pool, ws = null, app, issueNumber, kind, runId = null, postId = null, bot, dm, ready = false, key = null, strict = false,
}) {
  if (CHAT_STATUS_OF_KIND[kind] && app?.id) {
    await require('./homeroom-bot-chat').noteRequestStatus(pool, { appId: app.id, issueNumber, status: CHAT_STATUS_OF_KIND[kind] });
  }
  if (!dm || !bot?.id) return null;
  // A verdict about Homeroom itself offers a move (below); where it cannot,
  // the run records why (homeroom-bot-move.js noteMoveOffer).
  const noteMove = (outcome) => (kind === 'person' && dm.platform
    ? require('./homeroom-bot-move').noteMoveOffer(pool, runId, outcome) : null);
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (!requester || !hasBot(settings, requester)) {
    await noteMove(requester ? 'no_bot' : 'no_requester');
    return null;
  }
  if (!requester.issueTitle && !requester.firstVersion) {
    const title = await requestTitleFor(pool, app, issueNumber);
    if (title) requester.issueTitle = title;
  }
  // One story: red checks handed to a person reach them as a stop of its own.
  kind = newsKind(kind, dm);
  if (kind === 'checks' && hasProposalCard(dm)) {
    const { rows: [tries] = [] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND verdict = 'revise'`,
      [Number(dm.sessionId)],
    ).catch(() => ({ rows: [] }));
    dm = { ...dm, tries: tries?.n || 0 };
  }
  // #3767 / one story: the request's card in their chat with the bot, whose
  // thread everything about the request is said in.
  const shown = await cardShown(pool, requester.userId, app.id, issueNumber);
  const context = {
    appName: app.name || app.slug,
    appSlug: app.slug,
    issueNumber,
    issueTitle: requester.issueTitle,
    firstVersion: requester.firstVersion,
    // B4: whether others are in the project, for who approves it.
    group: kind === 'proposal' ? await hasOthers(pool, app.id) : false,
    threaded: !!shown,
  };
  const content = dmText(kind, dm, context);
  if (!content) return null;
  // WP1 (#6): a build's news that something newer overtook is not sent.
  if (BUILD_NEWS.has(kind) && runId) {
    const stale = await staleBuildNews(pool, { appId: app.id, issueNumber, runId, kind }).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not check whether news is stale (sending it)', { app: app.slug, issueNumber, kind, err: err.message });
      return null;
    });
    if (stale) {
      log.info('homeroom-bot-dm', 'Stale news not sent', { app: app.slug, issueNumber, kind, runId, why: stale });
      return { conversationId: null, messageId: null, stale: true, userId: requester.userId, username: requester.username };
    }
  }
  if (cardOnly(kind, dm)) {
    // Their card and tray read it from the records; the post does not tag
    // them for it either (untaggedRequester). It is still the request's
    // newest news: a question about it is not waiting for an answer now.
    await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws })
      .catch((err) => log.warn('homeroom-bot-dm', 'Could not close an older question', { app: app.slug, issueNumber, err: err.message }));
    require('./homeroom-bot-tray').noteWorkChanged(requester.userId);
    // One story: in the request's thread, a quiet line.
    const line = shown ? await stepLine(pool, {
      bot, userId: requester.userId, app, issueNumber, context, content, card: shown, step: kind,
      key: postId ? `hrbot-post-${postId}` : key,
      actions: kind === 'spec' && !dm.retry ? [readPlanAction(app.slug, issueNumber)] : null,
    }) : null;
    log.info('homeroom-bot-dm', line ? 'A quiet line in the request\'s thread' : 'On the card, not a message', { app: app.slug, issueNumber, kind });
    return {
      conversationId: line?.conversationId || null, messageId: line?.messageId || null, quiet: true,
      userId: requester.userId, username: requester.username,
    };
  }
  // B4: "it's built" waits until it is ready to try: its preview is up and
  // its checks passed or were skipped (tellReady, which the bot's change
  // machine asks for). Said to the post as told, so the post does not tag
  // them either: they hear it once, when they can try it. One story: its
  // thread says, quietly, that it is built and being tested.
  let sendKey = key;
  if (kind === 'proposal' && !ready && hasProposalCard(dm)) {
    const state = await changeReadiness(pool, dm.sessionId);
    if (state && !state.ready) {
      log.info('homeroom-bot-dm', 'A change is up; its requester hears when it is ready to try', {
        app: app.slug, issueNumber, sessionId: Number(dm.sessionId) || null,
      });
      if (shown) {
        await stepLine(pool, {
          bot, userId: requester.userId, app, issueNumber, context, card: shown, step: 'built',
          content: BUILT_TESTING_TEXT, key: `hrbot-built-${Number(dm.sessionId)}`,
        });
      }
      return { conversationId: null, messageId: null, deferred: true, userId: requester.userId, username: requester.username };
    }
    if (state) sendKey = readyKey(dm.sessionId, state.epoch);
  }
  const asks = QUESTION_KINDS.has(kind);
  const answers = asks ? (Array.isArray(dm.answers) ? dm.answers : []).filter((a) => typeof a === 'string' && a.trim()) : [];
  const metadata = {
    kind,
    appSlug: app.slug,
    appName: context.appName,
    issueNumber,
    ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
    ...(context.firstVersion ? { firstVersion: true } : {}),
    // A reply to this message is posted on the request, publicly.
    ...(MIRRORED_KINDS.has(kind) ? { mirrors: true } : {}),
    ...(asks ? { question: clip(dm.question, 2000), answers, status: 'open' } : {}),
    // B6: two questions, answered together (the card above Build it).
    ...(kind === 'question' && twoQuestions(dm) ? {
      questions: dm.questions.slice(0, 2).map((q) => ({
        question: clip(q.question, 300),
        answers: (Array.isArray(q.answers) ? q.answers : []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 4),
      })),
      lead: questionLead(requestLine(context), context.firstVersion ? 'the first version' : 'this', dm),
    } : {}),
    ...(dm.link ? { link: dm.link } : {}),
    // Where it is stuck, what to tap (STUCK_ACTIONS).
    // #4239: not Go ahead on a request about Homeroom itself; its own
    // message offers the move instead. Nor to a requester who does not
    // decide on the project: theirs would be read to the same answer.
    // Nor under a request that is done already: the close offer follows.
    ...(STUCK_ACTIONS[kind] && !(kind === 'person' && (dm.platform || personDeciders(dm).length)) && !dm.done
      ? { actions: STUCK_ACTIONS[kind], status: 'open' } : {}),
    // B7: a change ready to try, as a card with its buttons: whether it is
    // one person's project (the title), who else it waits on and how many of
    // them it needs, their words.
    ...(kind === 'proposal' && dm.card ? {
      ready: {
        group: !!context.group,
        last: !!dm.card.last,
        waitingOn: Array.isArray(dm.card.waitingOn) ? dm.card.waitingOn : [],
        ...(dm.card.more ? { more: Number(dm.card.more) } : {}),
        // How many more approvals it needs, and in all: with fewer than the
        // people listed, the card says how many and that any of them will do.
        ...(Number.isInteger(dm.card.missing) ? { missing: Number(dm.card.missing) } : {}),
        ...(Number.isInteger(dm.card.needed) ? { needed: Number(dm.card.needed) } : {}),
        // What its shots show not working (tellReady), said on the card.
        ...(brokenWords(dm.card.broken).length ? { broken: brokenWords(dm.card.broken) } : {}),
      },
      sessionId: Number(dm.sessionId),
      epoch: Number(dm.epoch) || 0,
      actions: readyActions({ sessionId: dm.sessionId, epoch: dm.epoch, approve: !!dm.card.approve, readOnly: !!dm.card.lookOnly }),
      status: 'open',
      // #3870: what the change is, so the card says more than "is ready".
      ...(typeof dm.title === 'string' && dm.title.trim() ? { changeTitle: clip(dm.title.trim(), 200) } : {}),
      ...(requester.askedText ? { askedText: askedLine(requester.askedText) } : {}),
    } : {}),
    // One story: red checks the bot could not fix, with the change to open.
    ...(kind === 'checks' && hasProposalCard(dm) ? {
      sessionId: Number(dm.sessionId),
      actions: [{ id: 'open_change', label: 'Open the change', style: 'primary', type: 'open', target: changeHrefOf(app.slug, dm.sessionId) }],
      status: 'open',
    } : {}),
    // Which words the moment says (contract 2.1), from what the verdict carried.
    said: saidOf(kind, {
      ...dm, firstVersion: context.firstVersion, group: context.group,
      ...(kind === 'build_failed' ? { cause: buildFailedCause(dm.reason).cause } : {}),
    }),
    ...(kind === 'proposal' && dm.card ? { waiting: waitingPhrase(dm.card) } : {}),
  };
  if (!metadata.said) delete metadata.said;
  if (!metadata.waiting) delete metadata.waiting;
  // One story: an offer is folded into the verdict that gives its reason,
  // so one verdict is one message and rings once (homeroom-bot-move.js).
  const move = require('./homeroom-bot-move');
  const offerKind = kind === 'person' && dm.platform ? 'move_request'
    : (kind === 'person' || kind === 'empty') && dm.done ? 'close_request' : null;
  const offer = offerKind ? await move.foldOffer(pool, {
    kind: offerKind, userId: requester.userId, app, issueNumber, title: requester.issueTitle, reason: dm.reason, runId,
  }) : null;
  if (offer) Object.assign(metadata, offer.metadata);
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content,
    withoutCards: dmText(kind, { ...dm, sessionId: null }, context),
    metadata,
    idempotencyKey: sendKey || (postId ? `hrbot-post-${postId}` : null),
    // B7: a ready card's Try it is its way to the change; it carries no card.
    objects: dm.card ? [] : cardsFor(kind, dm, app, issueNumber).filter((c) => !(shown && c.type === 'issue')),
    // #3707: news about a request they started here points back at it.
    replyToId: shown ? null : await requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
    ...(shown ? { threadRootId: shown.messageId } : {}),
    // 16 Oct 2026: said, and rings nothing (`quiet`, homeroom-bot.js
    // actOnVerdict): an older request's first read that is not ready to
    // try, and a request that names who builds it. Its card and the bot's
    // Needs you list still show what it waits on.
    ...(dm.quiet ? { moment: null } : {}),
  });
  await move.foldedOfferSent(pool, offer, sent);
  if (!sent?.messageId) {
    if (!offer) await noteMove('not_sent');
    return null;
  }
  const told = { ...sent, userId: requester.userId, username: requester.username };
  // #3698: from here the DM is in front of them, so what follows failing
  // is logged rather than thrown: a relay that throws is one the post
  // makes up for by tagging them, and this one did reach them. A durable
  // caller (`strict`, the bot's change machine) is told instead: its retry
  // finds the DM sent (a duplicate) and does what is left.
  try {
    // The same post relayed again (a retry): done if it was recorded. One
    // that went out and was never recorded (the first attempt ended between
    // the two) is recorded now, with what follows it, or its card would
    // read "checking" for good.
    if (sent.duplicate) {
      const { rows: had } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE message_id = $1', [sent.messageId]);
      if (had.length) return told;
    }
    // Whatever this post says, it is the request's news now: an older
    // question about it is not waiting for an answer any more.
    await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws });
    // B7: and a ready card about an older version of the change gives way.
    if (kind === 'proposal' && dm.card) {
      await closeOlderReadyCards(pool, { userId: requester.userId, appId: app.id, issueNumber, keepMessageId: sent.messageId, ws });
    }
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages
         (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (message_id) DO NOTHING`,
      [sent.messageId, requester.userId, sent.conversationId, app.id, issueNumber, kind, runId, asks ? 'open' : null],
    );
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Told the requester, but could not record it', {
      app: app.slug, issueNumber, kind, userId: requester.userId, err: err.message,
    });
    return told;
  }
  log.info('homeroom-bot-dm', 'Told the requester in their DM', {
    app: app.slug, issueNumber, kind, userId: requester.userId, question: asks,
  });
  return told;
}

// One story: the quiet line that says a change is built and being tried.
const BUILT_TESTING_TEXT = 'Built. Testing it: its checks, and its before and after screens.';

/** Pure: a change's page (change-destination.js changeHref). */
function changeHrefOf(slug, sessionId) {
  return require('./change-destination').changeHref(slug, Number(sessionId));
}

/** Pure: the button under a plan's quiet line, to the request's page where the plan is. */
function readPlanAction(slug, issueNumber) {
  return {
    id: 'read_plan', label: 'Read the plan', style: 'secondary', type: 'open',
    target: `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}`,
  };
}

/**
 * Pure: who a change ready to try waits on (contract 2.1 `waiting`), from
 * its ready card: "you and @ada", "@ada", or null when it waits on nobody
 * named.
 */
function waitingPhrase(card) {
  const names = (Array.isArray(card?.waitingOn) ? card.waitingOn : [])
    .map((w) => (typeof w === 'string' ? w : w?.username))
    .filter((name) => typeof name === 'string' && name)
    .slice(0, 3)
    .map((name) => `@${name.replace(/^@/, '')}`);
  const who = card?.approve ? ['you', ...names] : names;
  if (!who.length) return null;
  return who.length < 2 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
}

/**
 * One story: a quiet line in a request's thread (kind 'step'): what the
 * bot is doing, said under the request's card. It rings nothing and counts
 * as nothing unread in the main chat. `step` names which. Resolves what
 * sendDm did, or null. Never throws.
 */
async function stepLine(pool, {
  bot, userId, app, issueNumber, context = null, content, card, step, key = null, actions = null,
}) {
  try {
    const n = Number(issueNumber);
    return await sendDm(pool, {
      bot, userId, content, threadRootId: card.messageId, idempotencyKey: key, moment: null,
      metadata: {
        kind: 'step', step,
        appSlug: app.slug, appName: context?.appName || app.name || app.slug, issueNumber: n,
        ...(context?.issueTitle ? { issueTitle: context.issueTitle } : {}),
        ...(context?.firstVersion ? { firstVersion: true } : {}),
        ...(actions?.length ? { actions, status: 'open' } : {}),
      },
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not say a step in a request\'s thread', { app: app?.slug, issueNumber, step, err: err.message });
    return null;
  }
}

/**
 * One story: a quiet line in the thread of `userId`'s request, when it has
 * a card in their chat with the bot. For callers that do not hold the card
 * (homeroom-bot-activity.js, noteApproved). Resolves what sendDm did, or
 * null. Never throws.
 */
async function noteStep(pool, { bot = null, userId, app, issueNumber, content, step, key = null, actions = null, strict = false }) {
  try {
    const sender = bot || await botAccount(pool);
    if (!sender?.id || !userId || !app?.id) return null;
    const card = await cardShown(pool, userId, app.id, issueNumber);
    if (!card) return null;
    const requester = await requesterOf(pool, app.id, issueNumber).catch(() => null);
    return await stepLine(pool, {
      bot: sender, userId, app, issueNumber, card, step, key, actions, content,
      context: {
        appName: app.name || app.slug,
        issueTitle: requester?.userId === userId ? requester.issueTitle : null,
        firstVersion: requester?.userId === userId && requester.firstVersion,
      },
    });
  } catch (err) {
    // Strict (a workflow machine's work): thrown, so the item tries again.
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not note a step', { app: app?.slug, issueNumber, step, err: err.message });
    return null;
  }
}

// ── B6: a first version's plan ───────────────────────────────────────────
//
// A project's first version is not built the moment the bot has read its
// description: its creator gets the plan first (homeroom-bot.js awaitGo), 3
// to 5 plain bullets and up to two choices with the suggested answer
// marked, then Build it and Change something. Build it is a button the
// server decides once (decidePlanTap, through the same endpoint as every
// bot button, B3), from the DM or the App tab; Change something is a reply
// quoting the card (changePlan), kept private and read by the next look. A
// newer plan, a new look at the request and a week with no tap each close
// the card (closePlanCards); its bullets stay.

const PLAN_KIND = 'plan';

// B6: the message under a plan that stopped waiting (closePlanCards). It
// rings nothing: it is news, not a decision, and the card above it is what
// a reply picks up again.
const PLAN_STOPPED_KIND = 'plan_stopped';

function planStoppedText(appName) {
  return `Nobody tapped Build it on the plan${appName ? ` for ${appName}` : ''} for a week, so I put it away and built nothing. `
    + 'Reply to the plan above to pick it up again.';
}
const BUILD_IT = 'Build it';
// A reply to a plan that says to go ahead, rather than what to change.
const PLAN_GO_WORDS = new Set([
  'build it', 'build', 'yes', 'yes please', 'go', 'go ahead', 'do it', 'ok', 'okay', 'looks good', 'looks great',
  'sounds good', 'build it please',
]);

// Papote #3 (18 Oct 2026): "@Homeroom bot build it" on the request is the
// same go word as "build it": the bot's mentions in front of it come off
// first, its handle or its display name (with the zero-width character the
// composer writes after the @: homeroom-bot-holds.js mentionPattern).
const LEADING_MENTIONS_RE = new RegExp(
  `^\\s*(?:@[\\u200b\\u200c\\u200d\\u2060]?(?:${BOT_USERNAME}|homeroom bot)(?![a-z0-9_-])[\\s,:;.!-]*)+`, 'i',
);

/** Pure (#4488): whether words written under a plan say to go ahead (PLAN_GO_WORDS). */
function isPlanGoWord(text) {
  const words = String(text || '').replace(LEADING_MENTIONS_RE, '');
  return PLAN_GO_WORDS.has(words.trim().toLowerCase().replace(/[.!\s]+$/, '').replace(/\s+/g, ' '));
}

/** Pure (B6): a plan card's words, for the inbox, the push and anything that does not draw the card. */
function planCardText({ appName, plan, issueNumber = null }) {
  const bullets = (plan?.bullets || []).map((b) => `- ${b}`).join('\n');
  const asks = (plan?.questions || []).length
    ? `\n\n${plan.questions.length === 1 ? 'One choice' : 'Two choices'} for you, or I'll go with what I suggest.`
    : '';
  // #4488: a complicated change on a project that already exists: its plan,
  // and its before and after screens, are on the request too.
  if (plan?.complicated) {
    const line = issueNumber ? `**${appName}** request #${issueNumber}` : `your request on **${appName}**`;
    return `Before I build ${line}, here's my plan:\n\n${bullets}${asks}\n\nIts before and after screens are on the request. `
      + `Tap ${BUILD_IT} when it looks right, or Change something.`;
  }
  return `Here's my plan for **${appName}**:\n\n${bullets}${asks}\n\nTap ${BUILD_IT} when it looks right, or Change something.`;
}

/** The plan cards a person was sent about one request, newest first, with their state. */
async function planCards(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, d.run_id, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = $4
      ORDER BY d.message_id DESC`,
    [userId, appId, issueNumber, PLAN_KIND],
  );
  return rows;
}

/**
 * B6: send a first version's plan to its creator, when they are somebody the
 * bot talks to: the card with its buttons (metadata.plan, actionId), a "needs
 * your answer" moment. Earlier plans for it now read "Replaced by a newer
 * plan". Resolves what sendDm did; { messageId: null, stop } when there is
 * nobody to send it to (`no_requester`, or `no_bot`: the requester is no
 * longer someone the bot works for); or null when the send failed.
 */
async function sendPlanCard(pool, { app, issueNumber, runId, plan, bot, ws = null, quiet = false }) {
  if (!bot?.id || !app?.id || !runId || !plan?.bullets?.length) return null;
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  // #4175: nobody to send it to is said apart from a send that failed: the
  // first stops its run at once, the second is tried again.
  if (!requester) return { messageId: null, stop: 'no_requester' };
  if (!hasBot(settings, requester)) return { messageId: null, stop: 'no_bot' };
  const name = app.name || app.slug;
  const questions = (plan.questions || []).slice(0, 2);
  const { rows: [action] } = await pool.query(
    `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title)
     VALUES ($1, $2, 'build_plan', $3) RETURNING id`,
    [requester.userId, app.id, clip(`The plan for ${name}`, 200)],
  );
  // #4488: a complicated change on an existing project: not a first version,
  // with its spec (read on the request, whose card goes under the plan).
  const complicated = plan.complicated === true;
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content: planCardText({ appName: name, plan: { bullets: plan.bullets, questions, complicated }, issueNumber }),
    idempotencyKey: `hrbot-plan-${runId}`,
    metadata: {
      kind: PLAN_KIND, appSlug: app.slug, appName: name, issueNumber: Number(issueNumber),
      // #5582: a complicated plan on an existing project names its request
      // when the requester row has its title, and sendDm's lookup covers it
      // when it does not.
      ...(complicated && requester.issueTitle ? { issueTitle: requester.issueTitle } : {}),
      firstVersion: !complicated,
      plan: {
        bullets: plan.bullets, questions,
        ...(complicated ? { complicated: true, ...(plan.spec ? { spec: plan.spec } : {}) } : {}),
      },
      actionId: Number(action.id), status: 'open',
    },
    ...(complicated ? { objects: cardsFor(PLAN_KIND, {}, app, issueNumber) } : {}),
    // 13 Oct 2026: a plan its maker already decided on the made screen
    // (homeroom-bot.js planFromEarly) rings nothing: it is built at once.
    ...(quiet ? { moment: null } : {}),
    replyToId: await requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
  });
  if (!sent?.messageId) {
    await pool.query('UPDATE homeroom_bot_dm_actions SET status = \'failed\', error = $2 WHERE id = $1', [action.id, 'not_sent']);
    return null;
  }
  await pool.query(
    'UPDATE homeroom_bot_dm_actions SET message_id = $2, conversation_id = $3 WHERE id = $1',
    [action.id, sent.messageId, sent.conversationId],
  ).catch(() => {});
  if (sent.duplicate) return sent;
  try {
    // Older plans for it give way to this one, and a question it had is done.
    for (const card of await planCards(pool, { userId: requester.userId, appId: app.id, issueNumber })) {
      if (Number(card.message_id) === Number(sent.messageId) || card.meta?.status === 'answered' || card.meta?.replaced) continue;
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'replaced\' WHERE message_id = $1 AND status = \'open\'',
        [card.message_id],
      );
      await setQuestionState(pool, Number(card.message_id), { status: 'closed', replaced: true }, {
        ws, conversationId: card.conversation_id, userId: requester.userId,
      });
    }
    await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_id) DO NOTHING`,
      [sent.messageId, requester.userId, sent.conversationId, app.id, issueNumber, PLAN_KIND, runId],
    );
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Sent a plan, but could not record it', { app: app.slug, issueNumber, err: err.message });
  }
  log.info('homeroom-bot-dm', 'Sent a first version\'s plan', { app: app.slug, issueNumber, userId: requester.userId, runId });
  return sent;
}

/**
 * B6: the cards of plans that stopped waiting (`runIds`): their buttons go on
 * every device. `stopped` (a week with no tap) says so and asks for a reply;
 * otherwise the card reads "No longer needed", until a newer plan replaces
 * it. A stopped plan is also said once, in a message of its own with its
 * request's card (planStoppedText): a card that changes a week up the
 * conversation is one nobody sees, and the plan just went quiet. Never
 * throws.
 */
async function closePlanCards(pool, runIds, { stopped = false, ws = null, bot = null } = {}) {
  const ids = (runIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT d.message_id, d.conversation_id, d.user_id, d.run_id, d.app_id, d.issue_number,
              COALESCE(NULLIF(a.name, ''), a.slug) AS app_name, a.slug AS app_slug
         FROM homeroom_bot_dm_messages d LEFT JOIN apps a ON a.id = d.app_id
        WHERE d.kind = $2 AND d.run_id = ANY($1::int[])`,
      [ids, PLAN_KIND],
    );
    let sender = bot;
    for (const row of rows) {
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = $2 WHERE message_id = $1 AND status = \'open\'',
        [row.message_id, stopped ? 'stopped' : 'closed'],
      );
      await setQuestionState(pool, Number(row.message_id), stopped ? { status: 'closed', stopped: true } : { status: 'closed' }, {
        ws, conversationId: row.conversation_id, userId: row.user_id,
      });
      if (!stopped) continue;
      try {
        sender = sender || await botAccount(pool);
        await sendDm(pool, {
          bot: sender,
          userId: row.user_id,
          content: planStoppedText(row.app_name),
          // The request it is about, as a card: a bot message quotes only
          // the person's own (quotable).
          objects: cardsFor(PLAN_STOPPED_KIND, {}, { id: row.app_id }, row.issue_number),
          idempotencyKey: `hrbot-plan-stopped-${row.run_id}`,
          metadata: {
            kind: PLAN_STOPPED_KIND, appSlug: row.app_slug, appName: row.app_name, issueNumber: Number(row.issue_number),
          },
        });
      } catch (err) {
        log.warn('homeroom-bot-dm', 'Closed a stopped plan, but could not say so', { runId: row.run_id, err: err.message });
      }
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not close a plan\'s card', { runs: ids, err: err.message });
    return 0;
  }
}

/**
 * B6: Build it, tapped under a plan (`action`, a `build_plan`), on any device:
 * decided once, as decideOfferTap decides an offer. `answers` are the choices
 * tapped, in order; one left untouched goes with the suggested answer. The
 * card then reads "Building it", with its answers, everywhere. Resolves { ok: true,
 * choice, label } or { ok: false, status, error }.
 */
// Newcomer run seven (14 Oct 2026): `planShown` false when it was decided
// without the card's Build it (buildFromAnswers): the plan's bullets were
// never put to its maker, so goAhead writes them as the plan's own lines.
async function decidePlanTap(pool, { user, action, choice, answers = [], deps = {}, planShown = true, claimKey = null }) {
  if (choice !== 'build') return { ok: false, status: 400, error: 'choice must be build' };
  const { rows: [card] } = await pool.query(
    'SELECT run_id, conversation_id FROM homeroom_bot_dm_messages WHERE message_id = $1 AND user_id = $2 AND kind = $3',
    [action.message_id, user.id, PLAN_KIND],
  );
  if (!card?.run_id) return { ok: false, status: 404, error: 'No such choice' };
  // Decided once. `claimKey` (or the answer's own, deps.workKey): the
  // workflow work item deciding it; a retry of that item after a restart
  // passes its own claim and goes ahead (goAhead is guarded by the run's
  // own state, so a plan gone ahead with already is not built twice).
  const key = claimKey || deps.workKey || null;
  const { rows: claimed } = await pool.query(
    `UPDATE homeroom_bot_dm_actions SET status = 'done', decided_at = COALESCE(decided_at, NOW()), decided_key = $3
      WHERE id = $1 AND user_id = $2 AND (status = 'open' OR ($3::text IS NOT NULL AND decided_key = $3 AND status = 'done'))
      RETURNING id`,
    [action.id, user.id, key],
  );
  if (!claimed.length) return { ok: false, status: 409, error: 'already_decided' };
  let went = await (deps.botSvc || settingsModule()).goAhead(pool, {
    runId: Number(card.run_id), answers: Array.isArray(answers) ? answers.slice(0, 2) : [],
    ...(planShown === false ? { planShown: false } : {}),
  });
  // Retried after it went ahead (a restart after goAhead): it went, with
  // the choices recorded then; the rest is done now.
  if (!went.ok && key && action.decided_key === key) {
    const { rows: [run] } = await pool.query(
      `SELECT app_id, issue_number, plan->'chosen' AS chosen FROM homeroom_bot_runs WHERE id = $1 AND go_ahead_at IS NOT NULL`,
      [Number(card.run_id)]);
    if (run) went = { ok: true, appId: Number(run.app_id), issueNumber: Number(run.issue_number), chosen: Array.isArray(run.chosen) ? run.chosen : [] };
  }
  if (!went.ok) {
    await pool.query('UPDATE homeroom_bot_dm_actions SET status = \'failed\', error = $2 WHERE id = $1', [action.id, 'plan_gone']);
    return { ok: false, status: 409, error: 'plan_gone' };
  }
  await setQuestionState(pool, Number(action.message_id), {
    status: 'answered', chosen: 'build', answer: BUILD_IT, choices: went.chosen.map((c) => c.answer),
  }, { ws: deps.ws || null, conversationId: card.conversation_id, userId: user.id }).catch(() => {});
  // A first version's plan is decided now, wherever it was: when, for the
  // steps its App tab lists (first-version-plan.js noteDecided).
  await require('./first-version-plan').noteDecided(pool, {
    appId: went.appId, issueNumber: went.issueNumber, answers: went.chosen.map((c) => c.answer),
  });
  // The build's progress shows under the plan, where they tapped: the
  // request's card moves here (homeroom-bot-activity.js cardUnderPlan), as
  // the bot's thanks for answering (#4392).
  try {
    const { rows: [app] } = await pool.query('SELECT id, slug, name, icon_emoji FROM apps WHERE id = $1', [went.appId]);
    const requester = await requesterOf(pool, went.appId, went.issueNumber);
    const bot = deps.bot || await botAccount(pool);
    if (app && requester && Number(requester.userId) === Number(user.id) && bot) {
      await require('./homeroom-bot-activity').cardUnderPlan(pool, {
        app, issueNumber: went.issueNumber, runId: Number(card.run_id), planMessageId: Number(action.message_id),
        requester, bot, deps: { ws: deps.ws || null },
      });
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not move the card under the plan', { runId: Number(card.run_id), err: err.message });
  }
  try { require('./homeroom-bot-tray').noteWorkChanged(user.id, deps); } catch { /* the tray re-reads on its own */ }
  return { ok: true, choice: 'build', label: BUILD_IT };
}

/**
 * 13 Oct 2026: a first version's plan its maker decided before they were
 * asked in the chat (the made screen's Submit, or a plan from Make it that
 * asks nothing: homeroom-bot.js goAheadIfDecided), gone ahead with as Build
 * it is: through its chat card when it has an open one (decidePlanTap, so
 * the card says it is being built, with the answers it went with), else
 * straight on (goAhead: a card that could not be sent). Resolves what
 * decidePlanTap or goAhead did, or null when nothing waits.
 *
 * Newcomer run seven (14 Oct 2026, Club Votes): either way its maker was
 * not shown the plan's bullets (the made screen shows its questions alone,
 * and a plan decided before it was sent goes ahead the moment it is), so
 * they go ahead with `planShown: false` (goAhead): the bullets are the
 * plan's own lines, and only the answers are theirs.
 */
async function buildFromAnswers(pool, { appId, issueNumber, runId = null, userId, answers = [], deps = {} }) {
  const { rows: [run] } = await pool.query(
    `SELECT id FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND awaiting_go_at IS NOT NULL
        AND build_ok IS NULL AND build_session_id IS NULL
        AND ($3::int IS NULL OR id = $3::int)
      ORDER BY id DESC LIMIT 1`,
    [appId, issueNumber, runId],
  );
  if (!run) return null;
  const { rows: [action] } = await pool.query(
    `SELECT a.* FROM homeroom_bot_dm_messages d
       JOIN homeroom_bot_dm_actions a ON a.message_id = d.message_id
      WHERE d.run_id = $1 AND d.kind = $2 AND d.user_id = $3 AND a.kind = 'build_plan' AND a.status = 'open'
      ORDER BY d.message_id DESC LIMIT 1`,
    [run.id, PLAN_KIND, userId],
  );
  const picks = Array.isArray(answers) ? answers.slice(0, 2).map((a) => (typeof a === 'string' ? a : null)) : [];
  if (action) return decidePlanTap(pool, { user: { id: userId }, action, choice: 'build', answers: picks, deps, planShown: false });
  const went = await (deps.botSvc || settingsModule()).goAhead(pool, { runId: Number(run.id), answers: picks, planShown: false });
  if (went.ok) {
    await require('./first-version-plan').noteDecided(pool, {
      appId: went.appId, issueNumber: went.issueNumber, answers: went.chosen.map((c) => c.answer),
    });
  }
  return went;
}

/**
 * 13 Oct 2026: the made screen's Submit (POST /api/apps/:slug/first-version
 * /answers): its maker's answers to their first version's questions. Only
 * its maker answers. The questions answered are the plan's that waits for
 * Build it when there is one (the chat's card, the same plan), else the
 * plan from Make it (first-version-plan.js). The answers are kept once
 * (recordAnswers); a plan waiting for them goes ahead now
 * (buildFromAnswers), and one not made yet goes ahead with them the moment
 * it is (homeroom-bot.js planFromEarly). Idempotent: a second Submit
 * changes nothing. Resolves { ok: true, building, answers } or
 * { ok: false, status, error }.
 */
async function answerFirstVersion(pool, { user, appId, answers = [], deps = {} }) {
  const fvPlan = require('./first-version-plan');
  const row = await fvPlan.readEarlyPlan(pool, appId);
  if (!row || row.bot_builds === false) return { ok: false, status: 404, error: 'no_first_version' };
  if (Number(row.user_id) !== Number(user?.id)) return { ok: false, status: 403, error: 'not_the_maker' };
  const waiting = row.issue_number
    ? await waitingPlan(pool, { userId: user.id, appId, issueNumber: row.issue_number }).catch(() => null)
    : null;
  const early = fvPlan.planOf(row);
  const questions = waiting ? waiting.questions : early ? early.questions : null;
  if (!questions) return { ok: false, status: 409, error: 'no_plan' };
  const kept = await fvPlan.recordAnswers(pool, { appId, userId: user.id, questions, answers });
  let building = false;
  if (row.issue_number) {
    const went = await buildFromAnswers(pool, {
      appId, issueNumber: Number(row.issue_number), userId: user.id, answers: kept.answers, deps,
    }).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not go ahead with a first version\'s answers', { appId, err: err.message });
      return null;
    });
    building = !!went?.ok;
  }
  log.info('homeroom-bot-dm', 'A first version\'s questions were answered on the made screen', {
    appId, userId: user.id, recorded: kept.recorded, building,
  });
  return { ok: true, building, answers: kept.answers };
}

/**
 * B6: a reply quoting a plan card (Change something, or a reply to a plan
 * that stopped waiting): their words are kept with the plan, never posted,
 * and the request is read again first in line with them (homeroom-bot.js
 * planChangesFor), which sends a new plan. The card's buttons go. Resolves
 * what the bot said back.
 */
async function changePlan(pool, { bot, user, target, message, deps = {} }) {
  const text = String(message.content || '').trim();
  const { rows: [app] } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  if (!app) return null;
  const name = app.name || app.slug;
  const issueNumber = Number(target.issue_number);
  const reply = (content) => sendDm(pool, {
    bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-plan-change-${message.id}`, content, moment: 'reply',
    metadata: { kind: 'ack', appSlug: app.slug, appName: name, issueNumber, firstVersion: true },
  });
  if (!text) return reply(`Write what you'd like changed in the plan as a message, and I'll plan ${name} again.`);
  // "Build it" (or "yes") written under the plan is its button.
  if (isPlanGoWord(text)) {
    const { rows: [action] } = await pool.query(
      'SELECT * FROM homeroom_bot_dm_actions WHERE message_id = $1 AND user_id = $2 AND kind = \'build_plan\'',
      [target.message_id, user.id],
    );
    if (action?.status === 'open') {
      const went = await decidePlanTap(pool, { user, action, choice: 'build', answers: [], deps });
      // #4392: the thanks Build it sent under the plan is the answer, said
      // once; said as words alone only when that card could not be sent.
      if (went.ok) {
        const activity = require('./homeroom-bot-activity');
        const thanks = await activity.requestCard(pool, { userId: user.id, appId: app.id, issueNumber });
        // One story: a plan in its request's thread was answered there
        // already (the activity card's quiet line).
        const { rows: [planRow] = [] } = await pool.query(
          'SELECT thread_root_id FROM conversation_messages WHERE id = $1', [Number(target.message_id)],
        );
        if (thanks && (thanks.messageId > Number(target.message_id) || Number(planRow?.thread_root_id) === thanks.messageId)) {
          return { conversationId: thanks.conversationId, messageId: thanks.messageId, duplicate: true };
        }
        return reply(activity.thanksText(name));
      }
    }
  }
  // Built already, or being built: a change then is a change to it, once it is ready to try.
  const { rows: [newest] } = await pool.query(
    `SELECT build_ok, live_build_waiting_at, build_session_id, proposal_session_id FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' ORDER BY id DESC LIMIT 1`,
    [app.id, issueNumber],
  );
  if (newest && newest.build_ok !== false
    && (newest.live_build_waiting_at || newest.build_session_id || newest.proposal_session_id)) {
    return reply(`I've already started building ${name}. Once it's ready to try, tell me here what to change.`);
  }
  // #4488: a complicated change's plan is the request's, shared with its
  // group: what to change is said there, and its next look plans it again.
  const { rows: [planned] = [] } = await pool.query('SELECT plan FROM homeroom_bot_runs WHERE id = $1', [target.run_id]);
  if (planned?.plan?.complicated === true) {
    return changeOnRequest(pool, { bot, user, target, text, message, deps });
  }
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET plan_change = $2, awaiting_go_at = NULL, build_ok = COALESCE(build_ok, FALSE),
            build_error = COALESCE(build_error, 'skipped: its creator asked to change the plan')
      WHERE id = $1 AND build_session_id IS NULL AND proposal_session_id IS NULL`,
    [target.run_id, clip(text, 3000)],
  );
  await pool.query(
    'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'changed\' WHERE message_id = $1 AND status = \'open\'',
    [target.message_id],
  );
  await setQuestionState(pool, Number(target.message_id), { status: 'closed', changing: true }, {
    ws: deps.ws || null, conversationId: target.conversation_id, userId: user.id,
  });
  let queued = null;
  try {
    queued = await settingsModule().enqueueFront(pool, { appId: app.id, issueNumber, userId: user.id, reason: 'plan_change' });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not put a changed plan first', { app: app.slug, issueNumber, err: err.message });
  }
  // The request's card follows the new look from here.
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (queued?.id && requester) {
    await require('./homeroom-bot-activity').startCard(pool, {
      app, issueNumber, bot, jobKey: String(queued.id), queued: true, inDm: true, requester,
    });
  }
  log.info('homeroom-bot-dm', 'A first version\'s plan is planned again with its creator\'s words', {
    app: app.slug, issueNumber, userId: user.id,
  });
  return reply(`Thanks. I'll work that into a new plan for ${name} and send it here.`);
}

/**
 * #4488: Change something under a complicated change's plan. Their words go
 * on the request's public discussion as theirs, and its next look plans it
 * again with them. #6019: the chat with the bot is private, so they are put
 * under the bot's reply as a draft first (homeroom-bot-mayor.js offerPost,
 * reason 'plan_change'), and Post it posts them; then notePlanChanged stops
 * the plan waiting. Resolves what the bot said back.
 */
async function changeOnRequest(pool, { bot, user, target, text, message, deps = {} }) {
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  return mayor.offerPost(pool, {
    bot, user, conversationId: target.conversation_id || null, message, target, text, reason: 'plan_change', deps,
  });
}

/**
 * #4488: what posting a change to a complicated change's plan does after
 * the words are on the request (decidePost, on Post it): the plan stops
 * waiting and its card says changes were asked for; its next look plans it
 * again with them, and the new plan comes to the chat and the request.
 * `target` is the plan's own message (quotedTarget). Never throws.
 */
async function notePlanChanged(pool, { user, target, app, deps = {} }) {
  try {
    if (!target?.run_id || !target?.message_id) return;
    await pool.query(
      `UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, build_ok = COALESCE(build_ok, FALSE),
              build_error = COALESCE(build_error, 'skipped: its requester asked to change the plan')
        WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_session_id IS NULL AND proposal_session_id IS NULL`,
      [target.run_id],
    );
    await pool.query(
      'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'changed\' WHERE message_id = $1 AND status = \'open\'',
      [target.message_id],
    );
    // Papote #3: its row on the request says a new plan follows.
    await require('./homeroom-bot-live').notePlanRows(pool, [target.run_id], 'replaced', { ws: deps.ws || null });
    await setQuestionState(pool, Number(target.message_id), { status: 'closed', changing: true }, {
      ws: deps.ws || null, conversationId: target.conversation_id, userId: user.id,
    });
    log.info('homeroom-bot-dm', 'A complicated change\'s plan is planned again with its requester\'s words, posted on the request', {
      app: app?.slug, issueNumber: Number(target.issue_number), userId: user.id,
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not stop a plan after its change was posted', { runId: target?.run_id, err: err.message });
  }
}

/**
 * #4488: a complicated change's plan its requester said Build it to on the
 * request itself: its card, wherever it was sent, says "Building it" with
 * the answers it went with. Never throws.
 */
async function markPlanBuilt(pool, runId, { chosen = [], ws = null } = {}) {
  try {
    const { rows } = await pool.query(
      'SELECT message_id, conversation_id, user_id FROM homeroom_bot_dm_messages WHERE kind = $2 AND run_id = $1',
      [Number(runId), PLAN_KIND],
    );
    for (const row of rows) {
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'done\', decided_at = NOW() WHERE message_id = $1 AND status = \'open\'',
        [row.message_id],
      );
      await setQuestionState(pool, Number(row.message_id), {
        status: 'answered', chosen: 'build', answer: BUILD_IT, choices: (chosen || []).map((c) => c.answer),
      }, { ws, conversationId: row.conversation_id, userId: row.user_id });
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not mark a plan as built', { runId, err: err.message });
    return 0;
  }
}

/**
 * Papote #3 (18 Oct 2026): the newest plan on a request still waiting for
 * Build it, as goAhead finds one (homeroom-bot.js): { id, complicated }, or
 * null.
 */
async function waitingPlanRun(pool, appId, issueNumber) {
  const { rows: [run] = [] } = await pool.query(
    `SELECT id, (plan->>'complicated')::boolean IS TRUE AS complicated FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND awaiting_go_at IS NOT NULL
        AND build_ok IS NULL AND build_session_id IS NULL
      ORDER BY id DESC LIMIT 1`,
    [appId, issueNumber],
  );
  return run ? { id: Number(run.id), complicated: run.complicated === true } : null;
}

/**
 * Papote #3 (18 Oct 2026): Build it, said to the bot by a complicated
 * change's requester (start_request, in their chat or on the request) under
 * the plan waiting for it. Through the plan's card in their chat when it is
 * still open (decidePlanTap: it reads "Building it" and the request's card
 * moves under it), else straight on (goAhead) with every card of it marked
 * built, as "build it" written on the request is (homeroom-bot.js
 * buildItOnRequest). Resolves { ok: true, runId } or { ok: false, why }.
 */
async function buildWaitingPlan(pool, { user, appId, issueNumber, deps = {} }) {
  const run = await waitingPlanRun(pool, appId, issueNumber);
  if (!run?.complicated) return { ok: false, why: 'gone' };
  const { rows: [action] = [] } = await pool.query(
    `SELECT a.* FROM homeroom_bot_dm_messages d
       JOIN homeroom_bot_dm_actions a ON a.message_id = d.message_id
      WHERE d.run_id = $1 AND d.kind = $2 AND d.user_id = $3 AND a.kind = 'build_plan' AND a.status = 'open'
      ORDER BY d.message_id DESC LIMIT 1`,
    [run.id, PLAN_KIND, user.id],
  );
  if (action) {
    const tapped = await decidePlanTap(pool, { user, action, choice: 'build', answers: [], deps });
    return tapped.ok ? { ok: true, runId: run.id } : { ok: false, why: tapped.error };
  }
  const went = await (deps.botSvc || settingsModule()).goAhead(pool, { runId: run.id });
  if (!went.ok) return { ok: false, why: went.why };
  await markPlanBuilt(pool, run.id, { chosen: went.chosen, ws: deps.ws || null });
  log.info('homeroom-bot-dm', 'Build it, said to the bot under a complicated change\'s plan', {
    appId, issueNumber, runId: run.id, userId: user.id,
  });
  return { ok: true, runId: run.id };
}

/**
 * B6: the plan a first version waits on, for its App tab: { bullets,
 * questions, actionId, messageId, conversationId }, or null.
 */
async function waitingPlan(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, a.id AS action_id, m.metadata->'homeroomBot'->'plan' AS plan
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
       JOIN homeroom_bot_dm_actions a ON a.message_id = d.message_id AND a.status = 'open'
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = $4
      ORDER BY d.message_id DESC LIMIT 1`,
    [userId, appId, issueNumber, PLAN_KIND],
  );
  const row = rows[0];
  if (!row || !Array.isArray(row.plan?.bullets)) return null;
  return {
    bullets: row.plan.bullets,
    questions: Array.isArray(row.plan.questions) ? row.plan.questions : [],
    actionId: Number(row.action_id),
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id) || null,
  };
}

// ── Ready to try ─────────────────────────────────────────────────────────

// B4: the check verdicts that make a change ready to try.
const READY_CHECKS = new Set(['passing', 'skipped']);

/** Pure: the key one change's "ready" is sent once under, per approval epoch. */
function readyKey(sessionId, epoch) {
  return `hrbot-ready-${Number(sessionId)}-${Number(epoch) || 0}`;
}

/**
 * B4: whether one of the bot's changes is ready to try: up for approval, with
 * its checks passed or skipped, and its before & after shots on that head
 * settled (shots-state.holdsReady): the shots agent tries what the change
 * says it does, and a change whose main action fails is not offered as
 * ready (Flat 4B Chores, whose "mark as done" answered a 500 on every tap
 * while its checks passed). Resolves { ready, epoch, waitingOnShots, broken,
 * skipped }, `broken` being the declared changes those shots show failing
 * (shots-state.brokenOnHead) and `skipped` those they could not reach for
 * want of data the change can seed (shots-state.skippedOnHead), or null for
 * no such change.
 */
async function changeReadiness(pool, sessionId, { now = Date.now() } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(
    `SELECT status, check_state, approval_epoch, source, reviewed_head_sha, imported_pr_head_sha,
            checks_commit_sha, handoff_head_sha, checks_checked_at,
            shots_state, shots_run_id, shots_detail, shots_updated_at,
            pr_title, pr_title_fallback, session_title
       FROM chat_sessions WHERE id = $1`, [id],
  );
  const row = rows[0];
  if (!row) return null;
  const shotsState = require('./shots-state');
  const revision = require('./pr-vote-revision');
  const head = revision.visualHeadForSession(row);
  // N5: and its verdict is about the head up for approval. One about
  // another commit (a fix the restart recovery rolled back, Club Votes, 12
  // October 2026) is not its own: its checks are still to come.
  const reviewed = revision.reviewedHeadForSession(row);
  const onHead = !reviewed || !row.checks_commit_sha || revision.sameSha(row.checks_commit_sha, reviewed);
  const checked = row.status === 'promoted' && READY_CHECKS.has(row.check_state) && onHead;
  const waitingOnShots = checked && shotsState.holdsReady(row, head, { now });
  return {
    ready: checked && !waitingOnShots,
    // Up for a vote with its checks passed or skipped on its head (the
    // change machine's own `checked`): what a card may still be sent for.
    checked,
    epoch: Number(row.approval_epoch) || 0,
    waitingOnShots,
    broken: checked ? shotsState.brokenOnHead(row, head) : [],
    skipped: checked ? shotsState.skippedOnHead(row, head) : [],
    // #3870: what the change is, for its ready card: its proposal's title,
    // unless that is the placeholder written while titles could not be
    // made, else its session's.
    title: changeTitle(row),
  };
}

/** Pure (#3870): a change's own title, in one line, or null. */
function changeTitle(row) {
  const pr = !row?.pr_title_fallback && typeof row?.pr_title === 'string' ? row.pr_title.trim() : '';
  const own = pr || (typeof row?.session_title === 'string' ? row.session_title.trim() : '');
  return own ? clip(own.replace(/\s+/g, ' '), 200) : null;
}

/**
 * Pure: the short words a ready card uses for what does not work, one per
 * failed change, from shots-state.brokenOnHead's entries or from words
 * already made (the card's own `broken`).
 */
function brokenWords(broken) {
  return (Array.isArray(broken) ? broken : []).slice(0, 3)
    .map((b) => clip(String((typeof b === 'string' ? b : b?.claim) || '').replace(/\s+/g, ' '), 200)).filter(Boolean);
}

/**
 * B4: one of the bot's changes is ready to try, for approval epoch `epoch`
 * (the bot's change machine decided it: src/workflow/bot-change/). Its
 * requester's card goes out once per epoch, saying what its shots show not
 * working (`broken`, the claims' words), and, when nothing is broken, the
 * people who must approve it are asked; the chat message it was asked in,
 * if it was, says Try it. A durable caller's: it throws what it could not
 * read or send, and a retry says nothing twice (the card's key, the bells'
 * NOT EXISTS, the chip). Resolves what was sent, `{ stale: true }` when the
 * epoch moved on since it was decided (the machine decides again), or null
 * when there is nobody to tell.
 */
async function tellReady(pool, sessionId, { epoch, broken: brokenClaims = [], deps = {} } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const state = await changeReadiness(pool, id);
  if (!state) return null;
  // Decided for another epoch, or no longer up for a vote with its checks
  // passed (merged, closed, a newer verdict since: a retry, or an admin's,
  // after the fact): the machine decides again from its next look.
  // `notUp`: nothing was sent for it, and the machine considers the epoch
  // again (a merge that GitHub refuses puts it back up for its vote).
  if (Number(state.epoch) !== Number(epoch) || !state.checked) return { stale: true, notUp: true };
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name
       FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
      ORDER BY r.id DESC LIMIT 1`,
    [id],
  );
  if (!rows[0]) return null;
  const run = rows[0];
  // Homeroom bot parity (P4): ready for its yes; a batch's roll-up says so.
  require('./homeroom-bot-batches').noteRequestChanged(pool, run.id, Number(run.issue_number));
  const broken = brokenWords(brokenClaims);
  const bot = deps.bot || await botAccount(pool);
  if (!bot) return null;
  const domain = deps.domain || require('./caddy').USERNODE_DOMAIN;
  const link = require('./homeroom-bot-live').proposalLink(domain, run.slug, id);
  // B7: what its asker can do on the card, and who else must approve it.
  const requester = await requesterOf(pool, run.id, Number(run.issue_number));
  const approval = await approvalState(pool, { sessionId: id, userId: requester?.userId || null });
  // #5506: a Yes from someone who does not build on the project is refused
  // by the session guard ("Session not found"), whatever its governance
  // says, so their card offers no Approve. Its Try it opens the look-only
  // preview (readyActions `readOnly`), the one a non-builder may open.
  const canBuild = await requesterCanBuild(pool, run.id, requester?.userId);
  // A first version goes live without a vote (D1): nobody is waited on,
  // and the card offers Try it and Change something, never Approve.
  const noVote = !!approval?.firstVersion;
  const waiting = approval && !noVote
    ? await usernamesOf(pool, await needsYesFrom(pool, approval, { except: requester?.userId ? [requester.userId] : [] }))
    : [];
  const told = await relayIssuePost({
    pool, ws: deps.ws || null, app: { id: run.id, slug: run.slug, name: run.name }, issueNumber: Number(run.issue_number),
    kind: 'proposal', runId: Number(run.run_id), bot, ready: true, key: readyKey(id, state.epoch), strict: true,
    dm: {
      link, sessionId: id, epoch: state.epoch,
      ...(state.title ? { title: state.title } : {}),
      card: {
        approve: canBuild && !noVote && !!(approval?.counts && !approval.already),
        ...(canBuild ? {} : { lookOnly: true }),
        // D1: a project's first version goes live without a vote.
        ...(noVote ? { noVote: true } : {}),
        last: !!approval?.last,
        // Nobody else is asked on a project of one; and never a long list.
        waitingOn: waiting.slice(0, 3),
        more: Math.max(waiting.length - 3, 0),
        // How many of them it needs (Page Turners, 5 October: two of
        // three, not all three), so the card can say any of them will do.
        ...(approval ? { missing: approval.missing, needed: approval.needed } : {}),
        // What its shots show not working, said on the card.
        ...(broken.length ? { broken } : {}),
      },
    },
  });
  // Nobody else is asked to approve a change part of which does not work:
  // its requester's card says what, and the bot's hand-off said so where
  // the group talks about it.
  // Nor is anybody asked to approve a first version (D1): it needs no Yes,
  // so needsYesFrom names nobody and nothing is sent.
  if (approval && !broken.length) {
    await noteApproversReady(pool, { sessionId: id, epoch: state.epoch, requesterId: requester?.userId || null, state: approval, strict: true });
  }
  // B9: and the chat message it was asked in, if it was, says Try it.
  await require('./homeroom-bot-chat').noteRequestStatus(pool, {
    appId: run.id, issueNumber: Number(run.issue_number), status: 'ready', sessionId: id, deps: { strict: true },
  });
  // Homeroom bot parity P6: a change that was working past a check that is
  // not its own passes now; its card says so (never throws).
  await require('./homeroom-bot-flaky-checks').noteGreen(pool, id, { deps });
  return told;
}

/**
 * #5506: whether whoever asked for a change builds on its project: passes
 * the session guard's collab bar (app-access.js checkAppAccess 'collab'),
 * which every POST on a change (a Yes, a preview's rebuild) goes through.
 * True when nobody is named, so a card for nobody changes nothing.
 */
async function requesterCanBuild(pool, appId, userId) {
  if (!userId) return true;
  try {
    const appAccess = require('./app-access');
    const [{ rows: [app] }, { rows: [person] }] = await Promise.all([
      pool.query(`SELECT ${appAccess.ACCESS_COLUMNS} FROM apps WHERE id = $1`, [appId]),
      pool.query('SELECT id, is_admin AS "isAdmin" FROM users WHERE id = $1', [userId]),
    ]);
    if (!app || !person) return true;
    return await appAccess.checkAppAccess(pool, app, person, 'collab');
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read whether a requester builds on the project', { appId, userId, err: err.message });
    return true;
  }
}

// ── B7: ready to try, and who approves it ───────────────────────────────

/**
 * B7: where approval of one change stands, for whoever asked for it
 * (`userId`): whose Yes counts on its project (governance.js: the approvers
 * a project names, else everybody), how many it needs and has, how many
 * more it needs (`missing`: 0 once it has them, the count behind the change
 * page's "1/2"), and whether this person's Yes counts, is in already, and
 * would be the last one needed. `gate` is the merge gate as it stands
 * (governance.governedGate, with the change's own explicit-approval flag,
 * so no clock is promised to a change that has none). Null for no such
 * change.
 *
 * `firstVersion` (13 Oct 2026, D1): it is its project's first version, which
 * goes live without a vote once it passes its checks. Nobody's Yes is asked
 * for, so none is missing, none would be the last, and the card offers no
 * Approve.
 */
async function approvalState(pool, { sessionId, userId = null }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const communities = require('./communities');
  const { rows: [session] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.approval_epoch, COALESCE(cs.promoted_at, cs.created_at) AS opened_at,
            COALESCE(cs.requires_explicit_approval, FALSE) AS explicit_approval,
            ${communities.audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}
              AS audience
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [id],
  );
  if (!session) return null;
  const governance = require('./governance');
  const { countedVotePredicateSql } = require('./pr-vote-revision');
  // Read uncached: who is belled is decided here, from the work of the
  // bot-change machine (tellReady), in whichever process runs it.
  const gov = await governance.readGovernance(pool, session.app_id);
  const electorate = await governance.getElectorate(pool, session.app_id, gov);
  const gate = await governance.governedGate(pool, session.app_id, {
    kind: 'pr', id, openedAt: session.opened_at,
    explicitApproval: session.explicit_approval === true, authorId: session.user_id ?? null, fresh: true,
  });
  const { rows: yes } = await pool.query(
    `SELECT pv.user_id FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND pv.vote = 'yes' AND ${countedVotePredicateSql('pv', 'cs')}`,
    [id],
  );
  const yesIds = new Set(yes.map((r) => Number(r.user_id)));
  const who = Number(userId) || null;
  const counts = !!who && (electorate.approverIds == null || electorate.approverIds.map(Number).includes(who));
  const already = !!who && yesIds.has(who);
  const firstVersion = gate.firstVersion === true;
  const needed = firstVersion ? 0 : Math.max(Number(gate.required ?? gate.approvalsRequired ?? 1) || 1, 1);
  const have = Math.max(Number(gate.qualifiedYes) || 0, 0);
  const missing = gate.thresholdMet ? 0 : Math.max(needed - have, 1);
  return {
    session, gov, electorate, gate, yesIds, needed, have, missing,
    counts, already,
    last: !firstVersion && counts && !already && have + 1 >= needed,
    audience: session.audience,
    firstVersion,
  };
}

/**
 * B7: who still has to approve a change before it goes live, for its "ready
 * to try" notification: the approvers its project names; otherwise, on a
 * project that is just one person's or a private community's, the people
 * active on it (or, when nobody is yet, its members). A public community
 * tells nobody this way (decided: everybody there could vote), unless it
 * names its approvers. Never the bot, a test account, whoever proposed it,
 * anybody whose Yes is in, or `except`. Nobody at all for a project's first
 * version, which goes live without a vote (approvalState `firstVersion`).
 * Resolves user ids.
 */
async function needsYesFrom(pool, state, { except = [] } = {}) {
  if (!state?.session || state.firstVersion) return [];
  const appId = Number(state.session.app_id);
  let ids;
  if (state.gov.approverPolicy === 'invited') {
    ids = state.electorate.adminFallback ? [] : state.electorate.approverIds;
  } else if (state.audience === 'open') {
    ids = [];
  } else {
    ids = await require('./active-users').listActiveUserIds(pool, appId);
    if (!ids.length) {
      const { rows } = await pool.query(
        `SELECT m.user_id FROM apps a JOIN community_members m ON m.community_id = a.community_id WHERE a.id = $1`,
        [appId],
      );
      ids = rows.map((r) => r.user_id);
    }
  }
  const skip = new Set([...state.yesIds, Number(state.session.user_id), ...except.map(Number)]);
  const wanted = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && !skip.has(n));
  if (!wanted.length) return [];
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
      WHERE u.id = ANY($1::int[]) AND u.is_synthetic = FALSE AND counts_toward_session_outcome(u.id, $2)`,
    [wanted, Number(state.session.id)],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Pure (B7): the buttons of a change's "ready to try" card: Try it (its
 * preview), Approve when the person's Yes counts and is not in yet (their
 * own Yes, cast from their own browser), and Change something (a reply to
 * the card). One is filled: Approve when there is one, else Try it.
 */
function readyActions({ sessionId, epoch, approve, readOnly = false }) {
  const id = Number(sessionId);
  return [
    { id: 'try', label: 'Try it', style: approve ? 'secondary' : 'primary', type: 'preview', sessionId: id, ...(readOnly ? { readOnly: true } : {}) },
    ...(approve ? [{ id: 'approve', label: 'Approve', style: 'primary', type: 'vote', sessionId: id, epoch: Number(epoch) || 0 }] : []),
    { id: 'change', label: 'Change something', style: 'secondary', type: 'reply' },
  ];
}

/** Usernames, for "Waiting for approval from …". */
async function usernamesOf(pool, ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query('SELECT id, username FROM users WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r.username]));
  return ids.map((n) => byId.get(Number(n))).filter(Boolean);
}

/**
 * B7: tell the people whose Yes a change still needs that it is ready to
 * try, once per approval epoch: a `change_ready` notification (on by
 * default, and pushed), from whoever asked for it. Never its asker, who has
 * the card. Resolves the rows made. Never throws.
 */
async function noteApproversReady(pool, { sessionId, epoch, requesterId = null, state = null, strict = false }) {
  try {
    const known = state || await approvalState(pool, { sessionId });
    if (!known) return [];
    const recipients = await needsYesFrom(pool, known, { except: requesterId ? [requesterId] : [] });
    if (!recipients.length) return [];
    const notifications = require('./notifications');
    const rows = await notifications.createChangeReadyNotifications(pool, {
      appId: Number(known.session.app_id), sessionId: Number(sessionId), sourceUserId: requesterId, recipientIds: recipients, epoch,
    });
    for (const row of rows) await notifications.hydrateAndPush(pool, row).catch(() => {});
    if (rows.length) log.info('homeroom-bot-dm', 'Told who must approve that a change is ready to try', { sessionId, people: rows.length });
    return rows;
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not tell who must approve that a change is ready', { sessionId, err: err.message });
    return [];
  }
}

/**
 * Pure (B7): what happens next to a change once its person has said Yes,
 * for the line their ready card shows from then on ("You approved it. It
 * goes live …"). `gate` is the change's merge gate counted with their Yes
 * (approvalState), `waiting` the usernames of whoever else it still waits on
 * (needsYesFrom). Either it goes live in a minute or two, because nothing
 * more is needed (`soon`); or it needs `missing` more Yes votes (0 when it
 * has them and only its clock runs), `waitingOn` names up to three of the
 * people asked and `more` counts the rest, and `at` is when it goes live
 * anyway if nobody objects: the lazy-consensus window's end
 * (active-users.js lazyWindowMs, from when it went up for approval), or the
 * visibility window of a change that has its approvals. A change with
 * neither clock has no `at`. The client words it, in the reader's own time
 * zone (frontend/src/features/messages/bot-ready.tsx approvedLine).
 */
function goesLiveAfterYes(gate, waiting = []) {
  if (!gate) return null;
  if (gate.mergeable) return { soon: true };
  const clock = (gate.thresholdMet || gate.lazyArmed) && gate.windowEndsAt ? String(gate.windowEndsAt) : null;
  const missing = gate.thresholdMet
    ? 0
    : Math.max((Number(gate.required) || 1) - (Number(gate.qualifiedYes) || 0), 1);
  const names = missing ? waiting.filter((name) => typeof name === 'string' && name) : [];
  return { soon: false, at: clock, missing, waitingOn: names.slice(0, 3), more: Math.max(names.length - 3, 0) };
}

/** B7: goesLiveAfterYes for one change, read now, after `userId`'s Yes was recorded. Null when it cannot be read. */
async function goesLiveFor(pool, sessionId, userId) {
  const state = await approvalState(pool, { sessionId, userId });
  if (!state) return null;
  const waiting = await usernamesOf(pool, await needsYesFrom(pool, state, { except: [Number(userId)] }));
  return goesLiveAfterYes(state.gate, waiting);
}

// The cards about one change sent to one person (noteApproved,
// noteApprovalWithdrawn).
const CHANGE_CARDS_SQL = `SELECT d.message_id, d.conversation_id, m.metadata->'homeroomBot' AS meta
         FROM homeroom_bot_dm_messages d
         JOIN conversation_messages m ON m.id = d.message_id
         JOIN homeroom_bot_runs r ON r.id = d.run_id
        WHERE d.user_id = $1 AND d.kind = 'proposal' AND r.proposal_session_id = $2`;

/**
 * B7: `userId` said Yes to one of the bot's changes (routes/votes.js), from
 * its card, the change page or anywhere else: the "ready to try" cards they
 * were sent about it stop offering Approve, on every device, and say what
 * happens next instead (`goesLive`, goesLiveAfterYes). Resolves that, for
 * the vote's own answer to carry to the card that was tapped; null when no
 * card of theirs was waiting on this Yes, or when what happens next could
 * not be read (the card then words it from what it was sent with). Never
 * throws.
 */
async function noteApproved(pool, sessionId, userId, deps = {}) {
  try {
    const { rows } = await pool.query(CHANGE_CARDS_SQL, [userId, sessionId]);
    const open = rows.filter((row) => row.meta?.ready && row.meta.status === 'open');
    if (!open.length) return null;
    // Read once, for every card about it. A card still settles without it.
    const goesLive = await goesLiveFor(pool, sessionId, userId).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not read what happens next to an approved change', { sessionId, err: err.message });
      return null;
    });
    for (const row of open) {
      await setQuestionState(pool, Number(row.message_id), {
        status: 'answered', chosen: 'approve', answer: 'Approve', ...(goesLive ? { goesLive } : {}),
      }, {
        ws: deps.ws || null, conversationId: row.conversation_id, userId,
      });
    }
    return goesLive;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not settle a change\'s ready card after a Yes', { sessionId, userId, err: err.message });
    return null;
  }
}

/**
 * The review flow's Undo: `userId` took back their Yes on one of the bot's
 * changes (DELETE /api/sessions/:id/vote) while it was still up for a vote.
 * The "ready to try" cards noteApproved settled for them about it offer
 * Approve again, on every device, instead of saying it goes live. Only the
 * cards their Yes answered: one closed for a newer version stays closed.
 * Resolves how many were reopened. Never throws.
 */
async function noteApprovalWithdrawn(pool, sessionId, userId, deps = {}) {
  try {
    const { rows } = await pool.query(CHANGE_CARDS_SQL, [userId, sessionId]);
    const answered = rows.filter((row) => row.meta?.ready && row.meta.status === 'answered' && row.meta.chosen === 'approve');
    for (const row of answered) {
      await setQuestionState(pool, Number(row.message_id), {
        status: 'open', chosen: null, answer: null, goesLive: null,
      }, {
        ws: deps.ws || null, conversationId: row.conversation_id, userId,
      });
    }
    return answered.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not reopen a change\'s ready card after a Yes was taken back', { sessionId, userId, err: err.message });
    return 0;
  }
}

/** B7: the "ready to try" cards sent about older versions of a change give way to the newest. */
async function closeOlderReadyCards(pool, { userId, appId, issueNumber, keepMessageId, ws = null }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = 'proposal' AND d.message_id <> $4`,
    [userId, appId, issueNumber, keepMessageId],
  );
  for (const row of rows) {
    if (!row.meta?.ready || row.meta.status !== 'open') continue;
    await setQuestionState(pool, Number(row.message_id), { status: 'closed', updated: true }, {
      ws, conversationId: row.conversation_id, userId,
    });
  }
}

// ── A ready card, read as it stands now ─────────────────────────────────
//
// A ready card is a message, sent once, and what it says about approval was
// true when it was sent. Page Turners, 5 October: the maker's card still
// said "It goes live when one more person approves" twenty minutes after the
// change went live, and "Needs 2 approvals from you, @priya or @mo" never
// moved as the others said Yes. So a ready card is read again whenever the
// DM reads its activity cards (homeroom-bot-activity.js cardsFor), on the
// same events: the bot's news landing in the DM (its "It's live now." is
// one), the loop's work changing (a merge or a close announces it,
// the change machine's tray push), and a vote on the change (the same push). What is read
// is where the change stands now and, while it is up for approval, who it
// still waits on and what happens next once the reader has said Yes.
// Nothing is written: the message keeps its words for the inbox and the push.

// The most ready cards one read answers for, newest first (an older one
// keeps what its message says), and the most changes up for approval whose
// approval it reads (a few reads of the project's rules each).
const MAX_READY_READS = 12;
const MAX_READY_APPROVALS = 4;

/** The reader's newest ready cards, each with its change and its app (with the columns app-access reads). */
async function readyRows(pool, userId) {
  const { rows } = await pool.query(
    `SELECT d.message_id, cs.id AS session_id, cs.status, cs.live_at,
            a.id, a.slug, a.name, a.created_by, a.self_hosted, a.collab_visibility, a.view_visibility,
            a.moderation_suspended_at
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
       JOIN apps a ON a.id = d.app_id
       JOIN chat_sessions cs ON cs.app_id = d.app_id
        AND cs.id = (CASE WHEN m.metadata->'homeroomBot'->>'sessionId' ~ '^[1-9][0-9]{0,8}$'
                          THEN (m.metadata->'homeroomBot'->>'sessionId')::int END)
      WHERE d.user_id = $1 AND d.kind = 'proposal'
        AND jsonb_typeof(m.metadata->'homeroomBot'->'ready') = 'object'
      ORDER BY d.message_id DESC
      LIMIT $2`,
    [userId, MAX_READY_READS],
  );
  return rows;
}

/**
 * Pure: where a ready card's change stands, from a readyRows row: `live`
 * (merged), `going_live` (being merged), `closed` (closed without going
 * live), or `open` (still up for approval; its approval is read apart).
 * Null for anything else: the card keeps what it said.
 *
 * #4228: a live card has no button. The news that it went live comes right
 * after it with its own Open (noteProposalMerged), and the card's second
 * Open just above it was the same button twice.
 */
function readyStateOf(row) {
  const base = { messageId: Number(row.message_id) };
  // Merged is live once production runs it (chat_sessions.live_at); until
  // then it is going live, as while it merges.
  if (row.status === 'merged' && !row.live_at) return { ...base, state: 'going_live', actions: [] };
  if (row.status === 'merged') return { ...base, state: 'live', actions: [] };
  if (row.status === 'merging') return { ...base, state: 'going_live', actions: [] };
  if (row.status === 'closed' || row.status === 'archived') return { ...base, state: 'closed', actions: [] };
  if (row.status === 'promoted') return { ...base, state: 'open', actions: [] };
  return null;
}

/**
 * Where approval of one change stands for `userId`, as their card draws it:
 * how many more it needs and in all, whether theirs would be the last, whom
 * else it waits on (needsYesFrom, as the card was sent with), whether their
 * Yes is in and, once it is, what happens next (goesLiveAfterYes).
 */
async function readyApproval(pool, sessionId, userId) {
  const state = await approvalState(pool, { sessionId, userId });
  if (!state) return null;
  const names = state.missing === 0 ? [] : await usernamesOf(pool, await needsYesFrom(pool, state, { except: [Number(userId)] }));
  return {
    approval: {
      missing: state.missing,
      needed: state.needed,
      last: !!state.last,
      approved: !!state.already,
      waitingOn: names.slice(0, 3),
      more: Math.max(names.length - 3, 0),
    },
    ...(state.already ? { goesLive: goesLiveAfterYes(state.gate, names) } : {}),
  };
}

/**
 * #5506: whether `user` may have the bot withdraw the change `sessionId`, by
 * the gate its "Withdraw it" offer keeps (homeroom-bot-mayor.js
 * withdrawGate): the bot's own, still up for a vote, and theirs to withdraw
 * (they asked for its request, or own its project). False on any doubt.
 */
async function canWithdrawReady(pool, user, sessionId) {
  try {
    const bot = await botAccount(pool);
    if (!bot) return false;
    const gate = await require('./homeroom-bot-mayor').withdrawGate(pool, { bot, user, sessionId });
    return !!gate?.ok;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read whether a ready card\'s change can be withdrawn', { sessionId, err: err.message });
    return false;
  }
}

/**
 * The signed-in person's ready cards as they stand now (see the note above):
 * [{ messageId, state, actions, approval?, goesLive?, canBuild?, canWithdraw? }],
 * newest first. Their
 * own cards only, on projects they can still view. A change whose approval
 * could not be read is left out, and its card says what it was sent with.
 */
async function readyStates(pool, { user }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const rows = await readyRows(pool, userId);
  if (!rows.length) return [];
  const appAccess = require('./app-access');
  const viewable = new Map();
  const canBuild = new Map();
  const approvals = new Map();
  const withdrawable = new Map();
  const out = [];
  // Cards going live, by their change: a merge of Homeroom itself says
  // when the platform's next release carries it (below).
  const goingLive = new Map();
  for (const row of rows) {
    const appId = Number(row.id);
    if (!viewable.has(appId)) viewable.set(appId, await appAccess.checkAppAccess(pool, row, user, 'view').catch(() => false));
    if (!viewable.get(appId)) continue;
    const state = readyStateOf(row);
    if (!state) continue;
    if (state.state === 'open') {
      const sessionId = Number(row.session_id);
      if (!approvals.has(sessionId)) {
        if (approvals.size >= MAX_READY_APPROVALS) continue;
        approvals.set(sessionId, await readyApproval(pool, sessionId, userId).catch((err) => {
          log.warn('homeroom-bot-dm', 'Could not read where a ready card\'s change stands', { sessionId, err: err.message });
          return null;
        }));
      }
      const read = approvals.get(sessionId);
      if (!read) continue;
      Object.assign(state, read);
      // #5506: what the reader can do on it. A Yes and the preview's
      // rebuild are POSTs behind the session guard, which lets only the
      // project's builders through: on a project where building is by
      // invitation, anybody else's Approve and Try it were refused with
      // "Session not found". So the card says whether they build there
      // (`canBuild`), and drops Approve and opens the look-only preview
      // when they do not. And whether they may have the bot withdraw the
      // change (`canWithdraw`, the gate the DM's own "Withdraw it" offer
      // keeps), so the card can offer that instead of a dead end.
      if (!canBuild.has(appId)) canBuild.set(appId, await appAccess.checkAppAccess(pool, row, user, 'collab').catch(() => false));
      state.canBuild = canBuild.get(appId);
      if (!withdrawable.has(sessionId)) withdrawable.set(sessionId, await canWithdrawReady(pool, user, sessionId));
      state.canWithdraw = withdrawable.get(sessionId);
    }
    if (state.state === 'going_live' && row.status === 'merged' && row.self_hosted) {
      goingLive.set(state, Number(row.session_id));
    }
    out.push(state);
  }
  // Merged into the platform's own app and not live yet: it waits for the
  // platform's next release (services/release-watch.js), and the card says
  // when, "Merged; goes live in the next release (about 8 minutes)". A child
  // app's merge goes live in a minute or two, and keeps "going live now".
  if (goingLive.size) {
    const releases = await require('./release-watch').releasesFor(pool, [...goingLive.values()]);
    for (const [state, sessionId] of goingLive) {
      const release = releases.get(sessionId);
      if (release) state.release = release;
    }
  }
  return out;
}

/**
 * A yes on one of the bot's changes (the bot-change machine's
 * `bot.tellApproved`, from the vote's own statement): a quiet line in the
 * request's thread, "ada approved it." (or "You approved it." for its
 * requester), once per voter and approval epoch. Throws when it could not be
 * said, so the work tries again. Resolves what was sent, or null.
 */
async function sayApproved(pool, sessionId, { voterId, voter = null, epoch = 0 } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0 || !Number(voterId)) return null;
  const { rows } = await pool.query(
    `SELECT q.user_id, r.issue_number, a.id AS app_id, a.slug, a.name
       FROM homeroom_bot_runs r
       JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
       JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id = $1
      ORDER BY r.id DESC LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const mine = Number(voterId) === Number(row.user_id);
  if (!mine && !voter) return null;
  // Said only while the yes stands: a retraction (or a new epoch) since it
  // was owed says nothing.
  const { rows: [stands] } = await pool.query(
    `SELECT 1 FROM pr_votes WHERE session_id = $1 AND user_id = $2 AND vote = 'yes' AND approval_epoch = $3`,
    [id, Number(voterId), Number(epoch) || 0],
  );
  if (!stands) return null;
  return noteStep(pool, {
    userId: Number(row.user_id), app: { id: row.app_id, slug: row.slug, name: row.name }, issueNumber: Number(row.issue_number),
    step: 'approved', content: mine ? 'You approved it.' : `@${voter} approved it.`,
    key: `hrbot-step-approved-${id}-${Number(voterId)}-${Number(epoch) || 0}`, strict: true,
  });
}

/**
 * B4: one of the bot's changes cannot be tried yet for a reason that is not
 * the bot's to fix in it (`why`: 'preview', its preview did not start). Its
 * requester hears it once per approval epoch, as the "stopped" moment; the
 * retries go on, and "ready" follows if one of them works. Never throws.
 */
// What a change whose preview did not start says while it is tried again.
const PREVIEW_RETRY_TEXT = 'I built it, but its preview didn\'t start, so it isn\'t ready to try yet. I\'m trying again.';

async function noteChangeStopped(pool, sessionId, { why = 'preview', deps = {}, strict = false } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT r.issue_number, a.id, a.slug, a.name, cs.status, cs.approval_epoch
         FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id JOIN chat_sessions cs ON cs.id = $1
        WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    const run = rows[0];
    if (!run || run.status !== 'promoted') return null;
    // Strict (the bot-change machine's work): a failed read is retried, never
    // read as "no bot" and the line taken for said.
    const settings = await settingsModule().readSettings(pool, { strict });
    const requester = await requesterOf(pool, run.id, Number(run.issue_number));
    if (!requester || !hasBot(settings, requester)) return null;
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const context = {
      appName: run.name || run.slug, issueNumber: Number(run.issue_number),
      issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
    };
    const key = `hrbot-stopped-${why}-${id}-${Number(run.approval_epoch) || 0}`;
    // One story: while the platform is still trying its preview again, this
    // is quiet: a line in the request's thread, no bell and no push.
    const card = await cardShown(pool, requester.userId, run.id, context.issueNumber);
    if (card) {
      return await stepLine(pool, {
        bot, userId: requester.userId, app: { id: run.id, slug: run.slug, name: run.name }, issueNumber: context.issueNumber,
        context, card, step: 'preview_failed', key, content: PREVIEW_RETRY_TEXT,
      });
    }
    return await sendDm(pool, {
      bot,
      userId: requester.userId,
      replyToId: await requestStart(pool, { userId: requester.userId, appId: run.id, issueNumber: context.issueNumber }),
      idempotencyKey: key,
      content: `${requestLine(context)}\n\n${PREVIEW_RETRY_TEXT}`,
      moment: null,
      metadata: {
        kind: 'preview_failed', appSlug: run.slug, appName: context.appName, issueNumber: context.issueNumber,
        ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
        ...(context.firstVersion ? { firstVersion: true } : {}),
      },
      objects: cardsFor('proposal', { sessionId: id }, { id: run.id }, context.issueNumber),
    });
  } catch (err) {
    // The bot's change machine's durable work asks for the error, to retry.
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change is stuck', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * Pure (#4242): what the "needs a look" message says: `checks`, its checks
 * failed in a way that looks like the platform's (the bot leaves those for
 * the platform's own re-run, homeroom-bot.js queueChecksFix); `built`,
 * its build finished and no change came of it.
 */
function needsLookText(line, why) {
  if (why === 'checks') {
    return `${line}\n\nI built it, but its checks failed in a way that looks like a problem on Homeroom's side, `
      + 'not in the change, so it isn\'t ready to try yet. Homeroom runs them again, and I\'ll tell you here if they pass. '
      + 'If nothing changes, the change needs a person to look at it.';
  }
  return `${line}\n\nI built it, but it didn't become a change you can try, and I can't fix that from here. `
    + 'It needs a person to look at it. Your request is still open.';
}

/**
 * #4242: one of the bot's builds came to nothing anybody will be told about
 * without a person: its proposal's checks failed on what looks like the
 * platform (`why` 'checks', by `sessionId`), or its build succeeded and no
 * proposal was recorded for it (`why` 'built', by `runId`). Its requester
 * hears it, ringing, once per approval epoch or per run, and the request's
 * activity card stops saying it is still being checked (homeroom-bot-
 * activity.js outcomeOf, which reads the row recorded here). Never throws.
 */
async function noteNeedsLook(pool, { sessionId = null, runId = null, why = 'checks', deps = {}, strict = false } = {}) {
  const id = Number(why === 'checks' ? sessionId : runId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = why === 'checks'
      ? await pool.query(
        `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name, cs.status, cs.approval_epoch
           FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id JOIN chat_sessions cs ON cs.id = $1
          WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
          ORDER BY r.id DESC LIMIT 1`,
        [id],
      )
      : await pool.query(
        `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name, NULL::text AS status, 0 AS approval_epoch
           FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
          WHERE r.id = $1 AND r.build_ok IS TRUE AND r.proposal_session_id IS NULL`,
        [id],
      );
    const run = rows[0];
    if (!run || (why === 'checks' && run.status !== 'promoted')) return null;
    const settings = await settingsModule().readSettings(pool);
    const issueNumber = Number(run.issue_number);
    const requester = await requesterOf(pool, run.id, issueNumber);
    if (!requester || !hasBot(settings, requester)) return null;
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const context = {
      appName: run.name || run.slug, issueNumber, issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
    };
    // One story: said in the request's thread (and the main chat), when it has one.
    const card = await cardShown(pool, requester.userId, run.id, issueNumber);
    const sent = await sendDm(pool, {
      bot,
      userId: requester.userId,
      replyToId: card ? null : await requestStart(pool, { userId: requester.userId, appId: run.id, issueNumber }),
      ...(card ? { threadRootId: card.messageId } : {}),
      idempotencyKey: why === 'checks'
        ? `hrbot-needs-look-checks-${id}-${Number(run.approval_epoch) || 0}`
        : `hrbot-needs-look-built-${id}`,
      content: needsLookText(card ? '' : requestLine(context), why).replace(/^\s+/, ''),
      metadata: {
        kind: 'needs_look', appSlug: run.slug, appName: context.appName, issueNumber,
        ...(context.issueTitle && !context.firstVersion ? { issueTitle: context.issueTitle } : {}),
        ...(context.firstVersion ? { firstVersion: true } : {}),
      },
      objects: why === 'checks' ? cardsFor('proposal', { sessionId: id }, { id: run.id }, issueNumber) : [],
    });
    // Recorded on a retry too (a duplicate send whose first attempt ended
    // before its record): the activity card reads it.
    if (sent?.messageId) {
      await pool.query(
        `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
         VALUES ($1, $2, $3, $4, $5, 'needs_look', $6)
         ON CONFLICT (message_id) DO NOTHING`,
        [sent.messageId, requester.userId, sent.conversationId, run.id, issueNumber, Number(run.run_id) || null],
      );
    }
    if (sent?.messageId && !sent.duplicate) {
      require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
      log.info('homeroom-bot-dm', 'Told the requester their change needs a look', {
        app: run.slug, issueNumber, why, sessionId: why === 'checks' ? id : null, runId: Number(run.run_id) || null,
      });
    }
    return sent;
  } catch (err) {
    // The bot's change machine's durable work asks for the error, to retry.
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change needs a look', { why, id, err: err.message });
    return null;
  }
}

// How long a build that succeeded may go without a proposal before its
// requester is told it needs a look, and how far back the bot's refresh
// looks for one (a few passes of it, so a short pause does not miss it).
const UNPROPOSED_AFTER_MS = 30 * 60 * 1000;
const UNPROPOSED_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * #4242: the bot's refresh: a live build of the bot's that succeeded and
 * recorded no proposal for UNPROPOSED_AFTER_MS (homeroom-bot.js
 * announceBuilt records it right after the build) came to nothing anybody
 * is told about, so its requester hears it needs a look (noteNeedsLook,
 * once per run). Resolves how many were looked at; never throws.
 */
async function sweepUnproposedBuilds(pool, deps = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT r.id FROM homeroom_bot_runs r
        WHERE r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS TRUE AND r.proposal_session_id IS NULL
          AND r.created_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
          AND r.created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM homeroom_bot_dm_messages d WHERE d.run_id = r.id AND d.kind = 'needs_look'
          )
        ORDER BY r.id LIMIT 20`,
      [UNPROPOSED_AFTER_MS, UNPROPOSED_WINDOW_MS],
    );
    for (const row of rows) await noteNeedsLook(pool, { runId: row.id, why: 'built', deps });
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not look for builds that recorded no proposal', { err: err.message });
    return 0;
  }
}


/**
 * Pure (#7, WP3): what the requester is told when the bot's proposal for
 * them merged. "Live now" only once the app answered its health check on
 * the build that merge deployed (`live`). The platform's own app
 * (`platform`) is released after the merge and outside this process, so it
 * merged and will be live in a few minutes, as the merge's own line in its
 * discussion says (routes/votes.js liveSoon); so is a child app whose
 * health could not be confirmed yet. `card`: a way to open the app goes
 * under it (its Open button, openAppAction).
 */
function mergedText({ line, appName, live, platform = false, card = true, change = false }) {
  // One story: a change is "it" (its thread is about it); a first version is
  // the project's own. With nothing to open (the platform's own app), it
  // says only when.
  let said;
  if (platform || !card) {
    said = live ? 'It\'s live.' : 'It\'s going live now. It will be live in a few minutes.';
  } else if (change) {
    said = live ? `It's live. Open ${appName} to see it.` : `It's going live now. Open ${appName} in a few minutes to see it.`;
  } else {
    said = live ? `Your first version is live. Open ${appName} to try it.`
      : `Your first version is going live now. Open ${appName} in a few minutes to try it.`;
  }
  return line ? `${line}\n\n${said}` : said;
}

function noteChatLive(pool, run, deps = {}) {
  return require('./homeroom-bot-chat').noteRequestStatus(pool,
    { appId: run.app_id, issueNumber: Number(run.issue_number), status: 'live', deps: deps.strict ? { strict: true } : {} });
}

/**
 * Pure (#4238): what Homeroom bot says in a new project's channel when its
 * first version is made. Its Open button (openAppAction) is the way in.
 */
function firstVersionText({ appName, live }) {
  const ready = live ? '' : ' It will be ready to open in a few minutes.';
  return `I've made the first version of ${appName}!${ready} Let me know if you need anything else.`;
}

/**
 * #4238: the one line the bot writes in a project's channel (the group
 * chat), when its first version is made: ws.sendFirstVersionMessage, which
 * writes it once per project. Never throws: the DM still goes.
 */
async function announceFirstVersion(pool, run, { live = false, deps = {} } = {}) {
  try {
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const appName = run.name || run.slug;
    const open = openAppAction({ slug: run.slug, appName });
    const ws = deps.ws || require('./ws');
    return await ws.sendFirstVersionMessage(pool, run.app_id, {
      user: bot,
      content: firstVersionText({ appName, live }),
      metadata: { appSlug: run.slug, ...(open ? { actions: [open] } : {}) },
    });
  } catch (err) {
    if (deps.strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not announce a first version in its channel', { app: run?.slug, err: err.message });
    return null;
  }
}

/**
 * A proposal the bot built is live: its requester hears it in their DM.
 * Asked by the merge-followups workflow machine once production runs a
 * build containing the change. The news carries a button that opens the app
 * (openAppAction) and the proposal's card, and records the app's address as
 * its link. The button is the message's own, so it is there even when the
 * card cannot be (a project the bot cannot see). Its ready card says it is
 * live by itself: that card reads where the change stands each time it is
 * read (readyStates), and this news landing is one of those times.
 *
 * The machine's durable work passes `deps.strict`: the chip and the
 * first-version line throw what they could not write, so the work is retried
 * (the DM itself is sent once, by its idempotency key).
 */
async function noteProposalMerged(pool, session, { deps = {} } = {}) {
  // What was still asked of it goes: it can no longer change.
  // Strict in durable work: a drop that failed is retried with it.
  if (session?.id) await (deps.voice || require('./homeroom-bot-voice')).dropAsks(pool, session.id, { strict: !!deps.strict });
  if (!session?.id) return null;
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.app_id, r.issue_number, a.slug, a.name, a.self_hosted, a.runtime_kind, a.runtime_name
       FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
      ORDER BY r.id DESC LIMIT 1`,
    [session.id],
  );
  if (!rows.length) return null;
  const run = rows[0];
  // A first version's timeline (first-version-timeline.js): merged, and
  // live, each once (this runs again when a later part fails).
  await timeline.record(pool, { runId: run.run_id, stage: 'merged', sessionId: session.id, once: true, strict: !!deps.strict });
  const platform = !!run.self_hosted;
  const live = true;
  // B9: the chat message it was asked in, if it was, says it is live.
  await noteChatLive(pool, run, deps);
  await timeline.record(pool, { runId: run.run_id, stage: 'live', sessionId: session.id, once: true, strict: !!deps.strict });
  const requester = await requesterOf(pool, run.app_id, run.issue_number);
  // #8: their activity tray reads again, whether or not the DM says it.
  if (requester) require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
  const settings = await settingsModule().readSettings(pool, { strict: !!deps.strict });
  // #4238: a new project's first version: the bot says so in its channel, once.
  if (requester?.firstVersion && !platform) await announceFirstVersion(pool, run, { live, deps });
  if (!requester || !hasBot(settings, requester)) return null;
  const bot = await botAccount(pool);
  if (!bot) return null;
  await closeOpenQuestions(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number });
  // One story: every change's requester hears it is live, in the request's
  // thread and the main chat (a moment that rings), with its Open button. A
  // first version also offers its community and inviting people to it.
  const card = await cardShown(pool, requester.userId, run.app_id, run.issue_number);
  const context = {
    appName: run.name || run.slug, issueNumber: run.issue_number,
    issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
    threaded: !!card,
  };
  // The platform's own app has no app of its own to open: its proposal.
  const open = platform ? null : openAppAction({ slug: run.slug, appName: context.appName });
  // #4231: a new project's first version also offers its community and
  // inviting people to it.
  const actions = open ? [open, ...(context.firstVersion ? firstLiveActions({ slug: run.slug }) : [])] : [];
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    replyToId: card ? null : await requestStart(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number }),
    ...(card ? { threadRootId: card.messageId } : {}),
    idempotencyKey: `hrbot-merged-${session.id}`,
    content: mergedText({
      line: card ? null : requestLine(context), appName: context.appName, live, platform, card: !!open, change: !context.firstVersion,
    }),
    metadata: {
      kind: 'merged', appSlug: run.slug, appName: context.appName, issueNumber: run.issue_number,
      link: `#app/${encodeURIComponent(run.slug)}`, live,
      ...(context.issueTitle && !context.firstVersion ? { issueTitle: context.issueTitle } : {}),
      ...(context.firstVersion ? { firstVersion: true } : {}),
      ...(actions.length ? { actions } : {}),
    },
    objects: cardsFor('merged', { sessionId: session.id }, { id: run.app_id }, run.issue_number),
  });
}

// ── A person writing to the bot ──────────────────────────────────────────

const HELP_TEXT = [
  'I build things for you on Homeroom. Create a project and describe what it should do, or post a request on a',
  'project, and I\'ll take it from there. When I have a question I\'ll ask it here: tap one of my suggested',
  'answers or write your own.',
].join(' ');

// What somebody the bot does not answer is told: the people it does not
// work for are the accounts Homeroom has not let in yet (hasBot).
const NOT_ENABLED_TEXT = 'I\'m not taking requests from your account yet. I will as soon as Homeroom lets '
  + 'your account in.';

/** Whether this conversation is the person's direct conversation with the bot. */
async function isBotDirect(pool, conversationId, botId, userId) {
  const [low, high] = conversations.normalizePair(botId, userId);
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_direct_pairs
      WHERE conversation_id = $1 AND user_low_id = $2 AND user_high_id = $3`,
    [conversationId, low, high],
  );
  return rows.length > 0;
}

/** The bot message a person quoted, when it was about a request of theirs. */
async function quotedTarget(pool, userId, quotedId) {
  if (!quotedId) return null;
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status, run_id
       FROM homeroom_bot_dm_messages WHERE message_id = $1 AND user_id = $2`,
    [quotedId, userId],
  );
  return rows[0] || null;
}

/**
 * One story: the request whose thread a person's message was written in,
 * from the thread's first message: { rootId, appId, appSlug, appName,
 * issueNumber, title, firstVersion }, or null for a message in the main chat
 * (or in a thread that is no request's). The first message is the request's
 * card, or for a request from before threads any of the bot's messages about
 * it: the chat opens that request's story on its oldest one, and a reply
 * written there is about the request all the same.
 */
async function threadRequest(pool, { userId, conversationId, message }) {
  let rootId = Number(message?.threadRootId) || null;
  if (!rootId && message?.id) {
    const { rows: [row] = [] } = await pool.query(
      'SELECT thread_root_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
      [Number(message.id), conversationId],
    ).catch(() => ({ rows: [] }));
    rootId = Number(row?.thread_root_id) || null;
  }
  if (!rootId) return null;
  const { rows: [card] = [] } = await pool.query(
    `SELECT d.app_id, d.issue_number, a.slug, a.name, q.issue_title, q.first_version
       FROM homeroom_bot_dm_messages d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN homeroom_bot_requesters q ON q.app_id = d.app_id AND q.issue_number = d.issue_number
      WHERE d.message_id = $1 AND d.user_id = $2`,
    [rootId, userId],
  );
  if (!card) return null;
  return {
    rootId,
    appId: Number(card.app_id),
    appSlug: card.slug,
    appName: card.name || card.slug,
    issueNumber: Number(card.issue_number),
    title: card.issue_title || null,
    firstVersion: !!card.first_version,
  };
}

/**
 * 31 Oct 2026: the thread a person's message was written in when it is no
 * request's (threadRequest): its root, and for a private thread the bot
 * opened for a draft (private_threads, a request to file or words to post)
 * what became of the draft: { rootId, draft: { kind, state, appSlug,
 * appName, title, issueNumber } | null }. Null in the main chat. A turn
 * written there reads that thread: it used to read the main chat, which
 * leaves thread replies out, so the model never saw what they wrote in a
 * draft's thread and answered an older message, or nothing at all.
 */
async function messageThread(pool, { userId, conversationId, message }) {
  let rootId = Number(message?.threadRootId ?? message?.thread_root_id) || null;
  if (!rootId && message?.id) {
    const { rows: [row] = [] } = await pool.query(
      'SELECT thread_root_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
      [Number(message.id), conversationId],
    ).catch(() => ({ rows: [] }));
    rootId = Number(row?.thread_root_id) || null;
  }
  if (!rootId) return null;
  const { rows: [p] = [] } = await pool.query(
    `SELECT p.kind, p.state, p.result_ref, a.slug, a.name, p.about_kind, p.about_number,
            (p.holds_bot AND p.hold_lifted_at IS NULL) AS holding,
            (SELECT r.metadata->'homeroomBot'->>'changeKind' FROM conversation_messages r
              WHERE r.id = p.root_message_id) AS change_kind,
            (SELECT d.title FROM homeroom_bot_dm_actions d
               JOIN conversation_messages m ON m.id = d.message_id
              WHERE m.thread_root_id = p.root_message_id AND d.user_id = p.user_id
              ORDER BY d.id DESC LIMIT 1) AS title
       FROM private_threads p
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`,
    [rootId, userId],
  ).catch(() => ({ rows: [] }));
  const draft = p && ['draft_request', 'draft_reply'].includes(p.kind) && p.slug
    ? {
      kind: p.kind,
      state: p.state,
      appSlug: p.slug,
      appName: p.name || p.slug,
      title: p.title || null,
      issueNumber: Number(p.result_ref) || null,
    }
    : null;
  // #6071 follow-up: a thread started from the bot's "+", with what its
  // welcome block picked: the project (or any) and the kind of change.
  const started = p && p.kind === 'ask'
    ? {
      kind: 'ask',
      state: p.state,
      appSlug: p.slug || null,
      appName: p.slug ? p.name || p.slug : null,
      // 1 Nov 2026 (C2.4): 'project', a thread for a new project (homeroom-bot-mayor.js start_project_thread).
      changeKind: ['fix', 'add', 'design', 'project'].includes(p.change_kind) ? p.change_kind : 'any',
      // 1 Nov 2026: a thread about a request or a change (private-threads.js
      // startAbout), which the turn reads (aboutContext); `holds` while the
      // bot waits for their plan on their own request.
      ...(p.about_kind && p.about_number ? {
        about: { kind: p.about_kind, number: Number(p.about_number) },
        holds: p.holding === true,
      } : {}),
    }
    : null;
  return { rootId, draft: draft || started };
}

/**
 * What a turn is told about where a message was written: a request's thread
 * ({ threadRequest }), any other thread ({ threadRootId, threadDraft }), or
 * the main chat ({}).
 */
async function threadDeps(pool, { userId, conversationId, message }) {
  const request = await threadRequest(pool, { userId, conversationId, message });
  if (request) return { threadRequest: request };
  const other = await messageThread(pool, { userId, conversationId, message });
  return other ? { threadRootId: other.rootId, threadDraft: other.draft } : {};
}

/** The newest question the bot asked this person that is still open. */
async function newestOpenQuestion(pool, userId, { appId = null, issueNumber = null } = {}) {
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status
       FROM homeroom_bot_dm_messages
      WHERE user_id = $1 AND question_status = 'open'
        AND ($2::int IS NULL OR app_id = $2) AND ($3::int IS NULL OR issue_number = $3)
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`,
    [userId, appId, issueNumber],
  );
  return rows[0] || null;
}

/**
 * The tail of every mirrored DM answer's text ("(Sent|Answered in a chat
 * with Homeroom bot.)"), shared with conversations.js requestDiscussion so
 * both read one constant.
 */
const MIRRORED_FROM_DM = 'in a chat with Homeroom bot.)';

/** The text a DM answer is posted on the request with. */
function mirroredText(content, { question = false } = {}) {
  return `${clip(content, 3500)}\n\n(${question ? 'Answered' : 'Sent'} ${MIRRORED_FROM_DM}`;
}

/**
 * #4974: close the bot's asks on a request that a reply on the request's
 * discussion has answered — the question still open in the DM, and a
 * blocked/empty/person note still showing its buttons. Only asks recorded
 * before the reply (`before`) settle, so news the bot sends after it stays
 * open. The ask's stamp is kept in microseconds by Postgres, but a reply's
 * stamp arrives as a JS Date, cut to the millisecond, so the comparison is
 * made at the millisecond too: a reply in the same millisecond as an ask
 * settles it. A question reads answered; the others closed, with `answeredOnRequest`
 * saying where the answer went. Resolves the rows settled (newest first),
 * each with its message's thread root for the line noteRequestReply writes.
 * Never throws.
 */
async function settleMirroredAsks(pool, { userId, appId, issueNumber, before = null, ws = null }) {
  const appIdNum = Number(appId);
  const n = Number(issueNumber);
  try {
    if (!userId || !appIdNum || !n) return [];
    const { rows } = await pool.query(
      `SELECT d.message_id, d.conversation_id, d.kind, d.question_status, m.thread_root_id
         FROM homeroom_bot_dm_messages d
         JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
        WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3
          AND d.kind = ANY($4::text[])
          AND ($5::timestamptz IS NULL OR date_trunc('milliseconds', d.created_at) <= $5)
          AND (d.question_status = 'open'
            OR (d.question_status IS NULL AND m.metadata->'homeroomBot'->>'status' = 'open'))
        ORDER BY d.message_id DESC`,
      [userId, appIdNum, n, [...MIRRORED_KINDS], before],
    );
    for (const row of rows) {
      const question = QUESTION_KINDS.has(row.kind);
      if (question) {
        await pool.query(
          `UPDATE homeroom_bot_dm_messages
              SET question_status = 'answered', answered_at = COALESCE(answered_at, NOW())
            WHERE message_id = $1 AND question_status IS DISTINCT FROM 'answered'`,
          [row.message_id],
        );
      } else {
        await pool.query(
          `UPDATE homeroom_bot_dm_messages
              SET answered_at = COALESCE(answered_at, NOW())
            WHERE message_id = $1 AND answered_at IS NULL`,
          [row.message_id],
        );
      }
      await setQuestionState(pool, row.message_id,
        question ? { status: 'answered', answeredOnRequest: true } : { status: 'closed', answeredOnRequest: true },
        { ws, conversationId: row.conversation_id, userId });
    }
    return rows;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not settle the asks a request reply answers', { issueNumber: n, err: err.message });
    return [];
  }
}

/**
 * #4974: a person's reply landed on a request's discussion (ws, once the
 * message is in): the bot's asks on it stop waiting on the requester, and
 * their DM's thread for the request says so with one quiet line. Whoever
 * replied, the requester is whose DM carries the news; the bot's own and
 * other synthetic posts never get here (ws skips them, and so does this).
 * The line is written only when an ask was settled, so of two replies before
 * the bot looks again the first alone says it. Resolves
 * { settled, line } — the rows settled and the line written — or null when
 * the request has no requester. Never throws.
 */
async function noteRequestReply(pool, { appId, issueNumber, userId, chatMessageId, content, createdAt = null, deps = {} }) {
  const appIdNum = Number(appId);
  const n = Number(issueNumber);
  const authorId = Number(userId);
  try {
    if (!appIdNum || !n || !authorId) return null;
    const { rows: authors } = await pool.query(
      'SELECT id, username, is_synthetic FROM users WHERE id = $1', [authorId],
    );
    // A synthetic account's post is the bot's or the platform's own, never
    // a person's answer.
    if (!authors.length || authors[0].is_synthetic) return null;
    const requester = await requesterOf(pool, appIdNum, n).catch(() => null);
    if (!requester) return null;
    const ws = deps.ws || null;
    const settled = await settleMirroredAsks(pool, {
      userId: requester.userId, appId: appIdNum, issueNumber: n, before: createdAt, ws,
    });
    if (!settled.length) return { settled, line: null };
    try {
      require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
    } catch { /* the tray re-reads on its own */ }
    // One quiet line, in the request's thread: theirs if they wrote it, else
    // who did. The thread hangs off the card, else off the ask it settled.
    const mine = Number(requester.userId) === authorId;
    const author = mine ? null
      : (await pool.query('SELECT username FROM users WHERE id = $1', [authorId])).rows[0]?.username || null;
    const said = clip(content, 140);
    const card = await cardShown(pool, requester.userId, appIdNum, n).catch(() => null);
    const line = await stepLine(pool, {
      bot: await botAccount(pool),
      userId: requester.userId,
      app: (await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [appIdNum])).rows[0] || null,
      issueNumber: n,
      card: { messageId: card?.messageId || settled[0].thread_root_id || settled[0].message_id },
      step: 'replied',
      key: chatMessageId ? `hrbot-replied-${Number(chatMessageId)}` : null,
      content: mine
        ? `You replied on the request's discussion: “${said}”`
        : `@${author || 'someone'} replied on the request's discussion: “${said}”`,
    });
    return { settled, line };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not note a reply on a request', { issueNumber: n, err: err.message });
    return null;
  }
}

/**
 * Post a person's words on a request's discussion, as their own message:
 * an answer to the bot's open question there, or a reply about the request.
 * That is what wakes the bot, and the request goes to the front of its
 * queue (#3624 stage 2) so the answer is looked at next. `prepared` text
 * already says it was sent from the chat (#3768, the model's
 * comment_on_request); `reason` is the queue's. Resolves
 * { ok, app, line, question } or { ok: false, why, app, line }.
 */
async function postOnRequest(pool, { user, target, text, prepared = false, reason = 'dm_answer', deps = {} }) {
  const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  const app = apps[0];
  if (!app) return { ok: false, why: 'gone', app: null, line: null };
  const line = `${app.name || app.slug} request #${target.issue_number}`;
  const question = target.question_status === 'open';
  const ws = deps.ws || require('./ws');
  const content = prepared ? clip(text, 3900) : mirroredText(text, { question });
  // Posted once per answer (its work item's key): a retry finds it.
  const relayKey = deps.workKey ? `${deps.workKey}:on:${app.id}:${Number(target.issue_number)}` : undefined;
  const posted = await ws.handleMessage(
    pool,
    { user, appId: app.id, appSlug: app.slug, postedVia: null, viaBotDm: true, relayKey },
    { type: 'chat', content, thread: { type: 'issue', ref: Number(target.issue_number) } },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    log.warn('homeroom-bot-dm', 'Could not post a DM answer on its request', {
      app: app.slug, issueNumber: target.issue_number, userId: user.id, code: posted?.code || null,
    });
    const why = posted?.code === 'not_collaborator' || posted?.code === 'join_required'
      ? `you need to be a member of ${app.name || app.slug} to take part in its requests`
      : 'something went wrong on my side';
    return { ok: false, why, app, line, question };
  }
  if (question) {
    await pool.query(
      `UPDATE homeroom_bot_dm_messages
          SET question_status = 'answered', answered_at = NOW(), answer_message_id = $2
        WHERE message_id = $1`,
      [target.message_id, deps.answerMessageId || null],
    );
    await setQuestionState(pool, target.message_id, { status: 'answered', answer: clip(text, 300) }, {
      ws, conversationId: target.conversation_id, userId: user.id,
    });
  } else if (MIRRORED_KINDS.has(target.kind)) {
    // #4974: a non-question ask (a stop with its buttons) is answered by the
    // same DM answer: its buttons go, and the tray stops calling it Needs you.
    const { rows: open } = await pool.query(
      `SELECT 1 FROM conversation_messages
        WHERE id = $1 AND deleted_at IS NULL AND metadata->'homeroomBot'->>'status' = 'open'`,
      [target.message_id],
    );
    if (open.length) {
      await pool.query(
        `UPDATE homeroom_bot_dm_messages
            SET answered_at = COALESCE(answered_at, NOW())
          WHERE message_id = $1 AND answered_at IS NULL`,
        [target.message_id],
      );
      await setQuestionState(pool, target.message_id, { status: 'closed', answeredOnRequest: true }, {
        ws, conversationId: target.conversation_id, userId: user.id,
      });
    }
  }
  try {
    require('./homeroom-bot-tray').noteWorkChanged(user.id, deps);
  } catch { /* the tray re-reads on its own */ }
  try {
    await settingsModule().enqueueFront(pool, {
      appId: app.id, issueNumber: Number(target.issue_number), userId: user.id, reason,
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not put the answered request first', { app: app.slug, err: err.message });
  }
  log.info('homeroom-bot-dm', 'Posted a DM reply on its request', {
    app: app.slug, issueNumber: target.issue_number, userId: user.id, question,
  });
  return { ok: true, app, line, question };
}

/**
 * #3740: post a person's words in the discussion of the bot's own proposal,
 * as their own message: exactly what a reply typed there is, under the same
 * gates (somebody who may write in the project's discussion), and what the
 * bot's follow-up on that proposal reads (homeroom-bot.js runFollowUp). The
 * request it answers then goes to the front of the queue, as an answered
 * question's does, so the follow-up is next rather than after the next
 * sweep. Resolves { ok, queued } or { ok: false, why }. `queued` is false
 * while a follow-up on it runs right now (that run ends first, and the
 * reply is read after it), and null when it could not be put first: the
 * post still wakes the bot, as any reply there does.
 */
async function postOnProposal(pool, {
  user, app, sessionId, issueNumber, text, deps = {}, payerId = null, queueReason = 'dm_revise',
}) {
  const ws = deps.ws || require('./ws');
  // Posted once per answer (its work item's key): a retry finds it.
  const relayKey = deps.workKey ? `${deps.workKey}:on-change:${Number(sessionId)}` : undefined;
  const posted = await ws.handleMessage(
    pool,
    { user, appId: app.id, appSlug: app.slug, postedVia: null, relayKey },
    { type: 'chat', content: clip(text, 3900), thread: { type: 'session', ref: Number(sessionId) } },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    log.warn('homeroom-bot-dm', 'Could not post a DM change on its proposal', {
      app: app.slug, sessionId, userId: user.id, code: posted?.code || null,
    });
    const why = posted?.code === 'not_collaborator' || posted?.code === 'join_required'
      ? `you need to be a member of ${app.name || app.slug} to take part in its discussion`
      : 'something went wrong on my side';
    return { ok: false, why };
  }
  let queued = null;
  // 10 October: with the bot's voice on in changes' discussions, the words
  // are an ask its next follow-up takes, whether or not one runs now, and
  // the voice tells them what came of it, under their message
  // (homeroom-bot-voice.js recordAsk). It queues the follow-up itself.
  const asked = await (deps.voice || require('./homeroom-bot-voice')).recordAsk(pool, {
    appId: app.id, sessionId, issueNumber, askerId: user.id, instruction: text,
    source: queueReason === 'vote_no' ? 'vote_no' : 'dm', place: { type: 'session', ref: Number(sessionId) },
    messageId: Number(posted.message?.id) || null, payerId, deps, queueReason,
  });
  if (asked) {
    queued = asked.queued;
  } else {
    try {
      queued = !!(await settingsModule().enqueueFront(pool, {
        appId: app.id, issueNumber: Number(issueNumber), userId: user.id, reason: queueReason,
        // Whoever asked for the change pays for it (homeroom-bot.js billingOf).
        payerId,
      }));
    } catch (err) {
      log.warn('homeroom-bot-dm', 'Could not put the proposal\'s follow-up first', { app: app.slug, err: err.message });
    }
  }
  log.info('homeroom-bot-dm', 'Posted a DM change on the bot\'s proposal', {
    app: app.slug, sessionId, issueNumber, userId: user.id, queued,
  });
  return { ok: true, queued };
}

// ── A No vote's line, on one of its own changes (#3977) ──────────────────
//
// A No may come with a line (#1688), and on a change the bot built that line
// is what it should fix. It used to stop at the vote row in the change's
// discussion, a system row the bot neither wakes on nor reads (its
// follow-up reads people's messages there, homeroom-bot.js runFollowUp).
// Now, while the change is still up for a vote, the line is handed to the
// bot exactly as Change something hands a DM: posted in that discussion as
// the voter's own reply (postOnProposal), with its follow-up queued first,
// which revises the change (clearing its votes, as any revision does) or
// asks one question. The vote row then reads "voted no" without the line,
// so the discussion shows it once, as theirs (routes/votes.js).

/**
 * Pure: the line a vote just recorded hands the bot, or null. A No, with
 * words sent with it now (not the earlier line a re-cast keeps), that moved
 * something: a new vote, a flip, or new words on the same No. A re-cast
 * with the same words (`unchanged`, the route's own test) hands nothing,
 * so one line is handed once.
 */
function voteLineFor({ vote, reason, unchanged }) {
  if (vote !== 'no' || unchanged) return null;
  const line = typeof reason === 'string' ? reason.trim() : '';
  return line || null;
}

/**
 * Where a No's line on `sessionId` goes, when every gate a reply's
 * follow-up meets holds now: the bot's own change, up for a vote (not
 * merging, merged or closed), answering a request, on a project the bot
 * works on and has not paused, revised fewer than MAX_REVISIONS times.
 * Resolves { app, sessionId, issueNumber }, or null and the line stays on
 * the vote row as it always has. Never throws.
 */
async function voteLineTarget(pool, { sessionId }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows: [row] } = await pool.query(
      `SELECT cs.linked_issues, a.id AS app_id, a.slug, a.name
         FROM chat_sessions cs
         JOIN users u ON u.id = cs.user_id
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1 AND u.username = $2 AND cs.status = 'promoted'
          AND cs.is_headless IS NOT TRUE`,
      [id, BOT_USERNAME],
    );
    if (!row) return null;
    const issueNumber = Array.isArray(row.linked_issues) ? Number(row.linked_issues[0]) : null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
    const app = { id: Number(row.app_id), slug: row.slug, name: row.name };
    const settings = await settingsModule().readSettings(pool);
    if (!require('./homeroom-bot-live').isLiveFor(settings, app)
      || (settings?.pausedApps || []).includes(app.slug)) return null;
    const { rows: [revisions] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND verdict = 'revise'`,
      [id],
    );
    if ((revisions?.n || 0) >= require('./homeroom-bot-followup').MAX_REVISIONS) return null;
    return { app, sessionId: id, issueNumber };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read where a No\'s line goes', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * Hand `line` to the bot as `user`'s reply on `target` (voteLineTarget).
 * Resolves postOnProposal's answer; { ok: false } when it could not be
 * posted, and the caller keeps the line on the vote row. Never throws.
 */
async function handVoteLine(pool, { user, target, line, deps = {} }) {
  try {
    return await postOnProposal(pool, {
      user, app: target.app, sessionId: target.sessionId, issueNumber: target.issueNumber,
      text: line, deps, queueReason: 'vote_no',
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not hand a No\'s line to the bot', { sessionId: target?.sessionId, err: err.message });
    return { ok: false, why: 'something went wrong on my side' };
  }
}

/**
 * Whether `text` is one of the answers the bot suggested under its question
 * (the chips a person taps, which send that answer as their message).
 */
async function isSuggestedAnswer(pool, questionMessageId, text) {
  if (!questionMessageId || !text) return false;
  const { rows: [row] = [] } = await pool.query(
    `SELECT metadata->'homeroomBot'->'answers' AS answers FROM conversation_messages WHERE id = $1`,
    [Number(questionMessageId)],
  ).catch(() => ({ rows: [] }));
  const said = String(text).trim().toLowerCase();
  return Array.isArray(row?.answers) && row.answers.some((a) => typeof a === 'string' && a.trim().toLowerCase() === said);
}

/**
 * The deterministic path: words written in reply to the bot's question or
 * ask about a request. #6019: this chat is private. A suggested answer the
 * person tapped under the question is posted on the request's discussion as
 * theirs at once, the tap being the choice to; anything they typed is
 * drafted under the bot's reply with Post it (homeroom-bot-mayor.js
 * offerPost), and goes public only when they tap that.
 */
async function answerOnRequest(pool, { bot, user, target, message, conversationId = null, deps = {} }) {
  const text = String(message.content || '').trim();
  const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  if (!apps[0]) return null;
  const line = `${apps[0].name || apps[0].slug} request #${target.issue_number}`;
  if (!text) {
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I can only pass words on to ${line} for now. Write your answer as a message.`,
      moment: 'reply',
    });
  }
  const tapped = target.question_status === 'open' && await isSuggestedAnswer(pool, target.message_id, text);
  if (!tapped) {
    const mayor = deps.mayor || require('./homeroom-bot-mayor');
    return mayor.offerPost(pool, {
      bot, user, conversationId: conversationId || target.conversation_id || null, message, target, text,
      reason: 'dm_answer', deps,
    });
  }
  const posted = await postOnRequest(pool, { user, target, text, deps: { ...deps, answerMessageId: message.id } });
  if (!posted.ok) {
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I couldn't post that on ${line}: ${posted.why}. Nothing was sent.`,
      moment: 'reply',
    });
  }
  return sendDm(pool, {
    bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
    content: `Thanks. I posted your answer on ${line}'s public discussion and I'm looking at it again now.`,
    metadata: {
      kind: 'ack', appSlug: posted.app.slug, appName: posted.app.name || posted.app.slug,
      issueNumber: Number(target.issue_number),
    },
  });
}

/**
 * Called after a person's message lands in a conversation
 * (routes/conversations.js). When it is their DM with the bot:
 *   - a tap on File it / Not now under something the bot offered decides it
 *     (homeroom-bot-mayor.js);
 *   - a reply quoting one of the bot's messages about a request is posted on
 *     that request's discussion as their message (which wakes the bot), and
 *     the bot says where it went: a tapped answer always takes this path;
 *   - Try again under a first version that was built and not proposed
 *     finishes it (finishOnTryAgain, 15 Oct 2026);
 *   - anything else is read by the bot's model (#3624 stage 2), which can
 *     say what it is working on for them, pass an answer on, or offer to
 *     file a new request. With that switched off, it is the answer to the
 *     newest open question, or else the bot's short help.
 * Whichever it is, what the bot says back quotes the message (#3707).
 * The bot shows as typing in the DM until its answer is sent (#3684).
 */
async function noteUserMessage(pool, config, { user, conversationId, message, deps = {} }) {
  if (!user?.id || !message?.id || user.isSynthetic) return null;
  const bot = deps.bot || await botAccount(pool);
  if (!bot || bot.id === user.id) return null;
  if (!(await isBotDirect(pool, conversationId, bot.id, user.id))) return null;
  const settings = await settingsModule().readSettings(pool);
  // B5: words that are one of its open prompts settle those buttons.
  await settlePrompt(pool, { botId: bot.id, userId: user.id, conversationId, content: message.content });
  if (!hasBot(settings, user)) {
    const hour = Math.floor(Date.now() / (NOT_ENABLED_KEY_HOURS * 3600 * 1000));
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, content: NOT_ENABLED_TEXT, idempotencyKey: `hrbot-notyet-${user.id}-${hour}`,
      moment: 'reply',
    });
  }
  // #3684: typing from here until the answer is sent (whileTyping above).
  // In the thread they wrote in, where the answer lands (sendDm's threadRootFor).
  const threadRootId = Number(message.threadRootId ?? message.thread_root_id) || null;
  // 1 Nov 2026: and what it is doing as it works (deps.doing: typing's
  // stop.doing), for the working card the screen draws in its place.
  return whileTyping(pool, { botId: bot.id, conversationId, threadRootId, ws: deps.ws },
    (typing) => answerUserMessage(pool, config, {
      bot, user, settings, conversationId, message, deps: { ...deps, doing: typing.doing, moveTyping: typing.moveTo },
    }));
}

/**
 * A person wrote in a conversation (routes/conversations.js, inside
 * conversations.sendMessage's transaction, `db`): when it is their DM with
 * the bot, their DM machine hears it in that transaction, so the answer it
 * owes outlives the process that took the message.
 */
async function heardInDm(db, { user, conversationId, messageId, membership, memberIds = [] }) {
  if (!user?.id || user.isSynthetic || membership?.kind !== 'direct' || memberIds.length !== 1) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND username = $2 AND is_synthetic = TRUE', [Number(memberIds[0]), BOT_USERNAME]);
  if (!rows.length) return false;
  await require('../workflow/platform.ts').dmWritten(db, {
    userId: Number(user.id), conversationId: Number(conversationId), messageId: Number(messageId),
  });
  return true;
}

/**
 * The answer to one message in a person's DM with the bot (their DM
 * machine's `dm.answer` work, src/workflow/bot-dm/; `workKey` its key): what
 * noteUserMessage always did, or a later try at an answer the model could
 * not give (`attempt`). Said once: a reply already sent under this message's
 * keys (an attempt a restart cut short) ends it; every effect it has on the
 * way is keyed by `workKey` (a post by its mark, an ask by its message, a
 * claimed offer by its item, a report by the checkpoint `once`). Throws on a
 * failure a retry can cure. Resolves { sent, later }: `later` is the try the
 * machine asks next, when the model could not answer.
 */
async function answerOwed(pool, config, {
  userId, conversationId, messageId, attempt = 0, workKey, once = null, also = [], deps = {},
}) {
  const bot = deps.bot || await botAccount(pool);
  if (!bot) return { sent: false, skipped: 'no_bot' };
  if (await answeredAlready(pool, { botId: bot.id, conversationId, messageId, attempt })) {
    // Said already, by an attempt a restart cut short: if what it said was
    // "I'll get back to you", the later try it promised is still owed.
    return { sent: true, skipped: 'answered', later: await laterPromised(pool, { messageId, attempt }) };
  }
  const { rows: [u] } = await pool.query(
    `SELECT id, username, is_synthetic, has_platform_access, is_admin, private_member_since FROM users
      WHERE id = $1 AND anonymised_at IS NULL`, [Number(userId)]);
  if (!u) return { sent: false, skipped: 'gone' };
  // What hasBot reads about the person, as the auth middleware builds it.
  const user = {
    id: Number(u.id), username: u.username, isSynthetic: !!u.is_synthetic, hasPlatformAccess: !!u.has_platform_access,
    isAdmin: !!u.is_admin, privateMember: !u.has_platform_access && !u.is_admin && u.private_member_since != null,
  };
  const message = await conversations.getMessage(pool, user, Number(conversationId), Number(messageId));
  if (!message || message.deletedAt || message.deleted_at) return { sent: false, skipped: 'gone' };
  let later = null;
  // Strict: an answer that could not be delivered fails the work, which is
  // retried and then says it could not (dm.sorry), never counted as said.
  const turnDeps = {
    ...deps, bot, workKey, once, strict: true, onLater: (n) => { later = n; },
    // 31 Oct 2026: their earlier messages whose answer this one took over
    // (the bot-dm machine's `also`): the turn answers them too.
    ...(Array.isArray(also) && also.length ? { alsoUnanswered: also } : {}),
  };
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const sent = attempt > 0
    ? await mayor.answerLater(pool, config, { bot, user, conversationId: Number(conversationId), message, deps: turnDeps }, attempt)
    : await noteUserMessage(pool, config, { user, conversationId: Number(conversationId), message, deps: turnDeps });
  return { sent: !!sent, later };
}

/**
 * Whether the bot already answered message `messageId` (a later try:
 * `attempt`), by the keys its answers to that message use (`hrbot-<kind>-
 * <messageId>`, a later try's `hrbot-mayor-<messageId>-d<n>`).
 */
/**
 * The later try an answer to `messageId` (try `attempt`) promised, by its
 * turn's record (a model that could not answer: 'deferred', 'plain_later'),
 * or null.
 */
async function laterPromised(pool, { messageId, attempt = 0 }) {
  const { rows: [turn] } = await pool.query(
    `SELECT fallback FROM homeroom_bot_dm_turns WHERE message_id = $1 ORDER BY id DESC LIMIT 1`, [Number(messageId)]);
  const next = Number(attempt) + 1;
  const tries = require('../workflow/rules/bot-replies.ts').DEFER_DELAYS_MS.length;
  return turn && ['deferred', 'plain_later'].includes(turn.fallback) && next <= tries ? next : null;
}

// The keys an answer to a person's message is sent under, by what answered it.
const ANSWER_KEY_KINDS = Object.freeze(['mayor', 'ack', 'plan-change', 'finish', 'revise', 'offer']);
async function answeredAlready(pool, { botId, conversationId, messageId, attempt = 0 }) {
  const pattern = attempt > 0
    ? `^hrbot-mayor-${Number(messageId)}-d${Number(attempt)}$`
    : `^hrbot-(${ANSWER_KEY_KINDS.join('|')})-${Number(messageId)}$`;
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key ~ $3 LIMIT 1`,
    [Number(conversationId), Number(botId), pattern],
  );
  return rows.length > 0;
}

/**
 * The answer to a message failed for good (its work exhausted): the person
 * hears the bot could not answer, once, under the answer's own key (so it
 * is nothing when an answer did go out). Throws on a failure.
 */
async function sayCouldNotAnswer(pool, { userId, conversationId, messageId, attempt = 0, deps = {} }) {
  const bot = deps.bot || await botAccount(pool);
  if (!bot) return null;
  if (await answeredAlready(pool, { botId: bot.id, conversationId, messageId, attempt })) return null;
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  // A later try's: it had promised to come back, so it says it could not.
  return sendDm(pool, {
    bot, userId: Number(userId), content: attempt ? mayor.DEFERRED_GAVE_UP_TEXT : mayor.BROKEN_TEXT,
    idempotencyKey: mayor.answerKey(messageId, attempt), replyToId: Number(messageId), moment: 'reply',
  });
}

/** What noteUserMessage does with a message from somebody it works for, while the bot types. */
async function answerUserMessage(pool, config, { bot, user, settings, conversationId, message, deps }) {
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const quoted = message?.reply?.id || null;
  // One story per request: written in a request's thread, it is about that
  // request. Not quoting anything, it answers the request's open question,
  // or changes its waiting plan; anything else is the model's, told which
  // request it is about. What the bot says back goes in the same thread
  // (sendDm's threadRootFor, from the message it answers).
  // #6071: written in one of their design threads, it is about the design:
  // the bot edits it (design-bot.js), and nothing else answers there. 1 Nov
  // 2026: any private thread that holds a design is one ("+", an idea, a
  // thread about a request or a change, a draft); one that holds none yet
  // goes to the turn below, whose draw_screen hands the design bot version 1.
  const design = await (deps.designThreads || require('./design-threads')).threadOf(pool, { userId: user.id, conversationId, message });
  if (design) {
    return (deps.designBot || require('./design-bot')).answer(pool, config, { bot, user, settings, conversationId, message, design, deps });
  }
  const thread = await threadRequest(pool, { userId: user.id, conversationId, message });
  if (thread && !quoted) {
    const open = await newestOpenQuestion(pool, user.id, { appId: thread.appId, issueNumber: thread.issueNumber });
    if (open) return answerOnRequest(pool, { bot, user, target: open, message, conversationId, deps });
    const plan = await waitingPlan(pool, { userId: user.id, appId: thread.appId, issueNumber: thread.issueNumber });
    if (plan) {
      const target = await quotedTarget(pool, user.id, plan.messageId);
      if (target) return changePlan(pool, { bot, user, target, message, deps });
    }
  }
  if (thread) deps = { ...deps, threadRequest: thread };
  else {
    // 31 Oct 2026: any other thread (a draft's private one among them) is
    // read as that thread too, never as the main chat.
    const other = await messageThread(pool, { userId: user.id, conversationId, message });
    if (other) deps = { ...deps, threadRootId: other.rootId, threadDraft: other.draft };
  }
  if (quoted) {
    const decided = await mayor.decideOffer(pool, config, { bot, user, settings, conversationId, message, deps });
    if (decided) return decided;
    // B3: only an answer to a question, or a reply a message asked for, goes
    // on the request; any other quote is for the bot (MIRRORED_KINDS).
    const target = await quotedTarget(pool, user.id, quoted);
    // 15 Oct 2026: Try again under a first version that was built and not
    // proposed finishes it, decided here and never by the model; one it
    // cannot finish goes on below, to the model, which starts it over.
    if (target && target.kind === 'build_failed' && saysTryAgain(message.content)) {
      const finished = await finishOnTryAgain(pool, config, { bot, user, target, message, deps });
      if (finished) return finished;
    }
    if (target && MIRRORED_KINDS.has(target.kind)) return answerOnRequest(pool, { bot, user, target, message, conversationId, deps });
    // B6: a reply to a plan (Change something) plans it again with their words.
    if (target && target.kind === PLAN_KIND) return changePlan(pool, { bot, user, target, message, deps });
  }
  // #3772: "file it" typed under a draft decides it as the tap does. Typed,
  // it went to the model, which answered "Filed: … #14" for a request that
  // was never filed.
  let turnDeps = deps;
  if (!quoted && typeof mayor.decideTyped === 'function') {
    const typed = await mayor.decideTyped(pool, config, { bot, user, settings, conversationId, message, deps });
    if (typed?.sent) return typed.sent;
    if (typed?.decisionWithoutOffer) turnDeps = { ...deps, decisionWithoutOffer: true };
  }
  // A message that carries one of the bot's own changes still waiting for
  // approval (the change page's Ask for changes) is about that change: it is
  // fixed there before it goes live, as Change something on its ready card
  // does, never filed as a new request. Null when a gate refused it, and the
  // model reads it with the card in front of it.
  if (typeof mayor.reviseAttached === 'function') {
    const revised = await mayor.reviseAttached(pool, config, { bot, user, settings, conversationId, message, deps: turnDeps });
    if (revised) return revised;
  }
  if (settings.dmChat !== false) {
    return mayor.runDmTurn(pool, config, { bot, user, settings, conversationId, message, deps: turnDeps });
  }
  // A quote of anything but a question is not an answer to some other open
  // question (MIRRORED_KINDS): without the model, it gets the help text.
  const target = quoted ? null : await newestOpenQuestion(pool, user.id);
  if (!target) {
    // Once in a while, not after every message.
    const window = Math.floor(Date.now() / HELP_EVERY_MS);
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, content: HELP_TEXT, idempotencyKey: `hrbot-help-${user.id}-${window}`,
      moment: 'reply',
    });
  }
  return answerOnRequest(pool, { bot, user, target, message, conversationId, deps });
}

// ── A request filed elsewhere ────────────────────────────────────────────

// B8: how long the bot usually takes from starting on a request to its change
// being ready to try, when there is not enough of its own record to say.
const TYPICAL_BUILD_MINUTES = 8;

/**
 * B8: about how many minutes the bot takes from reading a request to the
 * change it builds going up: the median over its last 30 days, once it has
 * built at least five, else TYPICAL_BUILD_MINUTES. Never throws.
 */
async function typicalMinutes(pool) {
  const { rows } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (cs.promoted_at - r.created_at)) / 60.0
              + COALESCE(r.duration_ms, 0) / 60000.0) AS minutes,
            COUNT(*)::int AS built
       FROM homeroom_bot_runs r JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE r.mode = 'live' AND cs.promoted_at IS NOT NULL AND cs.promoted_at >= r.created_at
        AND r.created_at > NOW() - INTERVAL '30 days'`,
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row || Number(row.built) < 5 || !Number.isFinite(Number(row.minutes))) return TYPICAL_BUILD_MINUTES;
  return Math.min(60, Math.max(2, Math.round(Number(row.minutes))));
}

// WP-E: the same answer for a screen that asks every few seconds while a
// first version is built (GET /api/apps/:slug), read at most every five
// minutes per process. It is a median over thirty days; it does not move
// faster than that.
const TYPICAL_CACHE_MS = 5 * 60 * 1000;
let typicalCache = null;
async function typicalMinutesCached(pool, now = Date.now()) {
  if (typicalCache && now - typicalCache.at < TYPICAL_CACHE_MS) return typicalCache.minutes;
  const minutes = await typicalMinutes(pool);
  typicalCache = { at: now, minutes };
  return minutes;
}

/**
 * B8: a request somebody filed through Suggest an improvement (routes/feedback.js),
 * told to the bot the way its own filing from a DM is (homeroom-bot-mayor.js
 * fileRequest): recorded as theirs, in their own words, and, on a project the
 * bot builds on, put first in its queue with its card in their DM. Resolves
 * { botWillBuild, typicalMinutes } for the confirmation, or null when they
 * are not somebody the bot talks to. Never throws.
 */
async function noteRequestFiled(pool, { app, user, issueNumber, title = null, askedText = null }) {
  try {
    const n = Number(issueNumber);
    if (!app?.id || !user?.id || user.isSynthetic || !Number.isInteger(n) || n <= 0) return null;
    const settings = await settingsModule().readSettings(pool);
    if (!hasBot(settings, user)) return null;
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id,
         issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title),
         asked_text = COALESCE(EXCLUDED.asked_text, homeroom_bot_requesters.asked_text)`,
      [app.id, n, user.id, clip(title, 300) || null, clip(askedText, 2000) || null],
    );
    if (!require('./homeroom-bot-live').isLiveFor(settings, app)) return { botWillBuild: false };
    const queued = await settingsModule().enqueueFront(pool, {
      appId: app.id, issueNumber: n, userId: user.id, reason: 'asked', payerId: user.id,
    });
    const bot = await botAccount(pool);
    if (queued?.id && bot) {
      await require('./homeroom-bot-activity').startCard(pool, {
        app, issueNumber: n, bot, jobKey: String(queued.id), settings, filed: true,
        requester: {
          userId: user.id, username: user.username, issueTitle: title, firstVersion: false, askedText,
          isSynthetic: !!user.isSynthetic, hasPlatformAccess: !!(user.hasPlatformAccess || user.privateMember), isAdmin: !!user.isAdmin,
        },
      });
    }
    log.info('homeroom-bot-dm', 'A request asked for on the platform goes to the bot first', { app: app.slug, issueNumber: n, userId: user.id });
    return { botWillBuild: true, typicalMinutes: await typicalMinutes(pool) };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not hand a filed request to the bot', { app: app?.slug, issueNumber, err: err.message });
    return null;
  }
}

// ── Asking it to build a request ─────────────────────────────────────────

/**
 * B8: whether a request's page offers `user` "Ask Homeroom bot to build
 * this": Homeroom bot is theirs, and it builds on `app`. Resolves
 * { typicalMinutes } or null. Never throws.
 */
async function botDoorFor(pool, app, user) {
  try {
    if (!app?.slug || !user?.id || user.isSynthetic) return null;
    const settings = await settingsModule().readSettings(pool);
    if (!hasBot(settings, user) || !require('./homeroom-bot-live').isLiveFor(settings, app)) return null;
    return { typicalMinutes: await typicalMinutes(pool) };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read whether the bot builds here', { app: app?.slug, err: err.message });
    return null;
  }
}

// #4530: what "Ask Homeroom bot to build this" answers while the bot is
// waiting on people about the request, by the kind of its last note.
const WAITING_TEXT = Object.freeze({
  question: 'Homeroom bot asked a question here and is waiting for an answer. Answer it in the request\'s discussion, and it reads the request again.',
  person: 'Homeroom bot said a person needs to decide this one. Reply to it in the request\'s discussion once that is settled, and it reads the request again.',
  empty: 'Homeroom bot found nothing to build here yet. Reply to it in the request\'s discussion with more to go on, and it reads the request again.',
});

/**
 * #4530: whether the bot is waiting on people about request `n` of `app`
 * (homeroom-bot-addressed.js waitingOnRequest), or null. Never throws.
 */
async function botWaitingOn(pool, app, n, deps = {}) {
  const bot = await botAccount(pool).catch(() => null);
  if (!bot) return null;
  const github = deps.github || require('./github');
  let repoUrl = app.repo_url;
  if (repoUrl === undefined) {
    const { rows } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]).catch(() => ({ rows: [] }));
    repoUrl = rows[0]?.repo_url || null;
  }
  const repo = repoUrl && github.isEnabled?.() !== false ? repoRef.ownerRepo(repoUrl) : null;
  return require('./homeroom-bot-addressed').waitingOnRequest(pool, {
    appId: app.id, issueNumber: n, botId: bot.id, github, repo,
  });
}

/**
 * B8: somebody pressed "Ask Homeroom bot to build this" on request
 * `issueNumber` of `app` (routes/issues.js): it goes first in the bot's
 * queue, paid from their building time (B2). The request stays its asker's:
 * whoever it is recorded for keeps it, and its card and news reach them; a
 * request nobody is recorded for becomes this person's. Resolves
 * { ok: true, typicalMinutes, mine } or { ok: false, status, error, code }.
 *
 * #4530: not while the bot is waiting on people there: its last note is a
 * question, "a person needs to decide", or "nothing to build", and nobody
 * has answered it, replied to it, mentioned it or edited the request since
 * (botWaitingOn). Asking then read the same request again and posted the
 * same note again (number-guessing #52: one question three times). It
 * answers 409 `awaiting_reply`, and the card offers to answer the bot
 * instead (public/js/app-view.js).
 */
async function askBotToBuild(pool, { app, user, issueNumber, deps = {} }) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'Invalid request number' };
  if (!app?.id || !user?.id || user.isSynthetic) return { ok: false, status: 403, error: 'forbidden' };
  const settings = await settingsModule().readSettings(pool);
  if (!hasBot(settings, user)) return { ok: false, status: 403, error: 'Homeroom bot is not on for you yet.' };
  if (!require('./homeroom-bot-live').isLiveFor(settings, app)) {
    return { ok: false, status: 409, error: 'Homeroom bot does not build on this project.', code: 'not_building' };
  }
  const busy = (await require('./homeroom-bot-progress').botWorkByIssue(pool, app.id)).get(n);
  if (busy) return { ok: false, status: 409, error: 'Homeroom bot is already on it.', code: 'already_building' };
  const waiting = await botWaitingOn(pool, app, n, deps);
  if (waiting) {
    return { ok: false, status: 409, error: WAITING_TEXT[waiting.kind] || WAITING_TEXT.question, code: 'awaiting_reply' };
  }
  let requester = await requesterOf(pool, app.id, n);
  if (!requester) {
    const { rows } = await pool.query(
      `SELECT title FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id DESC LIMIT 1`,
      [app.id, n],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [app.id, n, user.id, clip(rows[0]?.title, 300) || null],
    );
    requester = await requesterOf(pool, app.id, n);
  }
  const queued = await settingsModule().enqueueFront(pool, {
    appId: app.id, issueNumber: n, userId: user.id, reason: 'asked', payerId: user.id,
  });
  // A look already started on it holds the row, and nothing is queued again.
  if (!queued?.id) return { ok: false, status: 409, error: 'Homeroom bot is already on it.', code: 'already_building' };
  const bot = await botAccount(pool);
  if (bot && requester) {
    await require('./homeroom-bot-activity').startCard(pool, {
      app, issueNumber: n, bot, jobKey: String(queued.id), settings, queued: true, requester,
    });
  }
  log.info('homeroom-bot-dm', 'Asked to build a request from its page', { app: app.slug, issueNumber: n, userId: user.id });
  return { ok: true, typicalMinutes: await typicalMinutes(pool), mine: Number(requester?.userId) === Number(user.id) };
}

/**
 * #4530: which of `issues` ({ number, updatedAt }) on `appId` Homeroom bot
 * is waiting on people about, for the request list and a request's page
 * (routes/issues.js `botAwaits`): Map(number → { kind, messageId }). Never
 * throws.
 */
async function botWaitingByIssue(pool, appId, issues) {
  const bot = await botAccount(pool).catch(() => null);
  if (!bot) return new Map();
  return require('./homeroom-bot-addressed').waitingByIssue(pool, { appId, botId: bot.id, issues });
}

/**
 * B8: who each of `numbers` on `app` is being built for, for the request
 * page's note ("Ada asked Homeroom bot to build this"): Map(number →
 * { username, userId }). Never throws.
 */
async function askersOf(pool, appId, numbers) {
  const list = [...new Set((numbers || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    `SELECT q.issue_number, q.user_id, u.username FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[])`,
    [appId, list],
  ).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [Number(r.issue_number), { username: r.username, userId: Number(r.user_id) }]));
}

// ── Saying hello ─────────────────────────────────────────────────────────

// B5: the bot introduces itself once per person, ever, and offers a few
// questions to tap (B3 `prompt` buttons: a tap sends the words as theirs,
// and the bot answers them like any message). A maker hears it with their
// first project; anybody else with their first request, above its card.
const MAKER_HELLO = 'Hi, I\'m Homeroom bot. I build apps and changes from what you describe, and I\'ll message you '
  + 'when something\'s ready to try.';
const MAKER_PROMPTS = Object.freeze(['How long will this take?', 'What can I ask for?', 'How do I invite friends?']);
const MEMBER_PROMPTS = Object.freeze(['What else can I ask for?', 'How long will this take?']);

/** Pure: the hello somebody hears with their first request on a project they did not make. */
function memberHello(appName) {
  return `Hi, I'm Homeroom bot. I build the changes people in ${appName || 'this project'} ask for. Here's yours:`;
}

// WP-F: somebody who joins a community through an invite link meets the
// bot there too, once, if it builds for them: what it is and what to ask it.
const JOINER_PROMPTS = Object.freeze(['What can I ask for?', 'How does the group decide?']);

/** Pure: the hello somebody hears when they join `appName` by an invite link. */
function joinerHello(appName) {
  const name = appName || 'this project';
  return `Hi, I'm Homeroom bot, the AI that builds things for the groups on Homeroom. Welcome to ${name}! `
    + `When you'd like something in ${name} to change, tell me here or tap Suggest an improvement on its page. `
    + 'I\'ll build it, and the group tries it and decides whether it goes live.';
}

/**
 * WP-F: greet somebody who just joined a community through an invite link
 * (community-invites.js redeem, collaborators.js accept: their DM machine's
 * `dm.hello` work, src/workflow/bot-dm/), once ever, and only when the bot
 * builds for them and is switched on: a hello offering what it cannot do
 * would be a false claim. Quiet: it rings nothing. `strict` (the work):
 * a failure throws, so it is tried again; else it never throws.
 */
async function greetJoiner(pool, { user, app, strict = false }) {
  try {
    if (!user?.id || !app?.id) return null;
    const settings = await settingsModule().readSettings(pool);
    if (settings.mode === 'off') return null;
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic, (has_platform_access OR private_member_since IS NOT NULL) AS has_platform_access, is_admin FROM users WHERE id = $1', [user.id],
    );
    const person = rows[0];
    if (!person || !hasBot(settings, {
      username: person.username, isSynthetic: !!person.is_synthetic,
      hasPlatformAccess: !!person.has_platform_access, isAdmin: !!person.is_admin,
    })) return null;
    const bot = await botAccount(pool);
    if (!bot) return null;
    const name = app.name || app.slug;
    const hello = joinerHello(name);
    // The message is the hello alone: sent only when it is theirs to have
    // (one already sent is not sent again).
    const sent = await sendDm(pool, {
      bot,
      userId: user.id,
      idempotencyKey: `hrbot-joiner-${user.id}`,
      content: hello,
      metadata: {
        kind: 'hello_joiner', appSlug: app.slug, appName: name,
        hello, actions: promptActions(JOINER_PROMPTS), status: 'open',
      },
      hello: { kind: 'joiner' },
    });
    return sent && !sent.duplicate ? sent : null;
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not greet a joiner', { userId: user?.id, err: err.message });
    return null;
  }
}

// #4604: somebody who finishes the welcome tour (or skips it) meets the bot
// in Messages, once, if it builds for them and it has not met them yet: the
// tour's "Meet Homeroom bot" stop points at Messages, and this is what they
// find there. Kept short: who it is, and what to ask it.
const TOUR_HELLO = 'Hi, I\'m Homeroom bot, the AI that builds things on Homeroom. Ask me here to build a change, '
  + 'file an idea or fix a bug in any project you\'re in, and I\'ll tell you how it goes.';
const TOUR_PROMPTS = Object.freeze(['What can I ask for?', 'How does the group decide?', 'How do I start a project?']);

/**
 * #4604: greet somebody who has just ended the welcome tour
 * (onboarding.js markTourDone, through their DM machine's `dm.hello` work),
 * once ever: their one hello (sendDm's `hello`, as a 'tour', claimed in the
 * message's own transaction), so somebody already greeted as a maker,
 * member, joiner or in the welcome of 9 Oct 2026, or written to before
 * hellos existed, hears nothing. Only when the bot is on and builds for
 * them, as greetJoiner. #4897: a test account is greeted like anybody, as
 * every other hello greets it, so a tester finds in Messages what the tour
 * promised; only the welcome DM, which puts staff into a group with it,
 * waits for test_account_welcome_dm. Quiet: it rings nothing. `strict` (the
 * work): a failure throws, so it is tried again; else it never throws.
 */
async function greetTourFinisher(pool, { userId, strict = false }) {
  try {
    if (!userId) return null;
    const settings = await settingsModule().readSettings(pool);
    if (settings.mode === 'off') return null;
    const { rows } = await pool.query(
      `SELECT id, username, is_synthetic, (has_platform_access OR private_member_since IS NOT NULL) AS has_platform_access,
              is_admin
         FROM users WHERE id = $1 AND anonymised_at IS NULL`, [userId],
    );
    const person = rows[0];
    if (!person || !hasBot(settings, {
      username: person.username, isSynthetic: !!person.is_synthetic,
      hasPlatformAccess: !!person.has_platform_access, isAdmin: !!person.is_admin,
    })) return null;
    const bot = await botAccount(pool);
    if (!bot) return null;
    // The message is the hello alone: sent only when it is theirs to have
    // (one already sent is not sent again).
    const sent = await sendDm(pool, {
      bot,
      userId,
      idempotencyKey: `hrbot-tour-${userId}`,
      content: TOUR_HELLO,
      metadata: { kind: 'hello_tour', hello: TOUR_HELLO, actions: promptActions(TOUR_PROMPTS), status: 'open' },
      hello: { kind: 'tour' },
    });
    return sent && !sent.duplicate ? sent : null;
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not greet a tour finisher', { userId, err: err.message });
    return null;
  }
}

// Sign-up test, 19 Oct 2026: somebody who made a ready-made app (a tier
// list, a find-a-time, ...) heard nothing from the bot. A described project
// gets the maker's hello as its first version starts (startFirstVersion),
// but a ready-made app works as it is, has nothing to build first, and
// nothing was said, so the first-session walk's "Homeroom bot is in
// Messages" pointed at an empty chat. Its maker hears the maker's hello now,
// with the project's card and one thing to ask for: the starter's own
// example change (services/app-templates.js exampleChange), as the walk's
// card offers it.
const READY_MADE_PROMPTS = Object.freeze(['What can I ask for?', 'How do I invite friends?', 'How does the group decide?']);

/**
 * Pure: the hello a maker hears with a ready-made app: the maker's hello,
 * the project's name as a line of its own (Messages draws it as the
 * project's card, as with a described project's), and what to ask for, with
 * `example` as the change when the starter has one. It no longer opens "It
 * works as it is." (Evan, sign-up test, 20 Oct 2026: it read as random).
 */
function readyMadeHello(appName, example = null) {
  const name = appName || 'Your app';
  const ask = example ? `Ask me here for changes, like “${example}”.` : 'Ask me here for any change you\'d like.';
  return `${MAKER_HELLO}\n\n**${name}**\n\n${ask}`;
}

/**
 * Greet the maker of a ready-made app (routes/apps.js, through their DM
 * machine's `dm.hello` work), once ever: their one hello, as a 'maker', so
 * somebody already greeted any way hears nothing, and their next project
 * says nothing either. The same gates as greetTourFinisher: the bot on, and
 * building for them; a test account is greeted like anybody (#4897). Only
 * the project's own maker, and only a ready-made app: anything else is
 * greeted where it is made. Quiet: it rings nothing. `strict` (the work): a
 * failure throws, so it is tried again; else it never throws.
 */
async function greetReadyMadeMaker(pool, { userId, app, strict = false }) {
  try {
    if (!userId || !app?.id) return null;
    const appTemplates = require('./app-templates');
    if (Number(app.created_by) !== Number(userId) || !appTemplates.isReadyMade(app.template)) return null;
    const settings = await settingsModule().readSettings(pool);
    if (settings.mode === 'off') return null;
    const { rows } = await pool.query(
      `SELECT id, username, is_synthetic, (has_platform_access OR private_member_since IS NOT NULL) AS has_platform_access,
              is_admin
         FROM users WHERE id = $1 AND anonymised_at IS NULL`, [userId],
    );
    const person = rows[0];
    if (!person || !hasBot(settings, {
      username: person.username, isSynthetic: !!person.is_synthetic,
      hasPlatformAccess: !!person.has_platform_access, isAdmin: !!person.is_admin,
    })) return null;
    const bot = await botAccount(pool);
    if (!bot) return null;
    const name = app.name || app.slug;
    const content = readyMadeHello(name, appTemplates.exampleChangeOf(app.template));
    // The message is the hello alone: sent only when it is theirs to have
    // (one already sent is not sent again).
    const sent = await sendDm(pool, {
      bot,
      userId,
      idempotencyKey: `hrbot-readymade-${app.id}`,
      content,
      metadata: {
        kind: 'hello_maker', appSlug: app.slug, appName: name,
        hello: MAKER_HELLO, actions: promptActions(READY_MADE_PROMPTS), status: 'open',
      },
      hello: { kind: 'maker' },
    });
    return sent && !sent.duplicate ? sent : null;
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-dm', 'Could not greet a ready-made app\'s maker', { userId, appId: app?.id, err: err.message });
    return null;
  }
}

/**
 * A hello owed to a person (their DM machine's `dm.hello` work): the
 * joiner's, the tour's, or a ready-made app's maker's. Throws on a failure
 * a retry can cure. Resolves what was sent, or null (the bot is off, does
 * not build for them, or they had their hello).
 */
async function greet(pool, { userId, kind, appId = null }) {
  if (kind === 'tour') return greetTourFinisher(pool, { userId, strict: true });
  if (kind === 'joiner') {
    const { rows: [app] } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [Number(appId)]);
    if (!app) return null;
    return greetJoiner(pool, { user: { id: Number(userId) }, app, strict: true });
  }
  if (kind === 'maker') {
    const { rows: [app] } = await pool.query('SELECT id, slug, name, template, created_by FROM apps WHERE id = $1', [Number(appId)]);
    if (!app) return null;
    return greetReadyMadeMaker(pool, { userId: Number(userId), app, strict: true });
  }
  return null;
}

/** Pure: `labels` as prompt buttons (types.ts HomeroomBotAction), at most three. */
function promptActions(labels) {
  return labels.slice(0, 3).map((label, i) => ({ id: `ask-${i + 1}`, label, style: 'secondary', type: 'prompt' }));
}

/*
 * What to tap where the bot's work on a request is stuck, instead of "reply
 * here" with nothing to press. A `quote` prompt is sent as the person's own
 * words, replying to the message, so it is about that request: on a build
 * that did not finish it reaches the bot's chat, which starts the request
 * again (homeroom-bot-mayor.js start_request), unless it is a first version
 * that was built and only not proposed, which it finishes (finishOnTryAgain
 * below, 15 Oct 2026); on a mirrored kind it is
 * posted on the request's public discussion, which the buttons say
 * (frontend/src/features/messages/bot-question.tsx). `reply` quotes the
 * message in the composer for them to write the detail it asks for.
 */
const STUCK_ACTIONS = Object.freeze({
  build_failed: Object.freeze([{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }]),
  blocked: Object.freeze([{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }]),
  empty: Object.freeze([{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }]),
  person: Object.freeze([{ id: 'go_ahead', label: 'Go ahead', style: 'primary', type: 'prompt', quote: true }]),
});

// ── Try again finishes a first version that was built (15 Oct 2026) ─────
//
// A first version built to the end whose proposal was refused stops "built
// but could not be proposed", its session paused and its branch pushed
// (homeroom-bot-live.js buildAndPropose). Its Try again is the person's own
// "Try again", replying to the message that said it stopped (STUCK_ACTIONS),
// and it reached the bot's chat model, which started the request over
// (start_request): read again, a new plan to say Build it to, and a new build
// of tens of minutes paid from its maker's allowance, with the built session
// left behind. That tap (or the same words written under the message) is now
// decided here, as Build it under a plan is (PLAN_GO_WORDS) and File it under
// an offer (homeroom-bot-mayor.js decideOffer): homeroom-bot.js
// finishBuiltFirstVersion proposes the session the build left, and the bot
// says so under the tap. Anything else written under it is still the
// model's, and a first version that cannot be finished that way (any other
// cause, its session or branch gone or moved, a newer look at it, the
// proposal refused again) is started over by it, as before.
const TRY_AGAIN_WORDS = new Set(STUCK_ACTIONS.build_failed.map((action) => action.label.toLowerCase()));

// Said under the tap once the session is proposed. What follows is what
// every first version says: built and being tested (BUILT_TESTING_TEXT), its
// ready card, and going live.
const FINISHING_TEXT = 'Finishing it now. I\'ll tell you here when it\'s ready to try.';
// A second tap (another device, or the words again) while it is finished, or
// once it is: nothing more is proposed.
const ALREADY_FINISHING_TEXT = 'I\'m already finishing it. I\'ll tell you here when it\'s ready to try.';

/** Pure: whether a reply's words are Try again's, tapped or typed. */
function saysTryAgain(content) {
  const said = String(content || '').trim().toLowerCase().replace(/[.!\s]+$/, '').replace(/\s+/g, ' ');
  return TRY_AGAIN_WORDS.has(said);
}

/**
 * Try again (saysTryAgain) quoting `target`, the bot's message that said a
 * build stopped: its run finished when it is a first version that was built
 * and only not proposed (homeroom-bot.js finishBuiltFirstVersion), and said
 * under the tap. Resolves what the bot said, or null when it was not
 * finished: the message then goes on to the model, as every Try again did
 * before, which starts the request over. Never throws.
 */
async function finishOnTryAgain(pool, config, { bot, user, target, message, deps = {} }) {
  let runId = Number(target?.run_id) || null;
  try {
    if (!runId) {
      // A message recorded without its run: the request's newest, which is
      // the only one Try again finishes.
      const { rows: [newest] = [] } = await pool.query(
        'SELECT id FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 ORDER BY id DESC LIMIT 1',
        [Number(target.app_id), Number(target.issue_number)],
      );
      runId = Number(newest?.id) || null;
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read the run Try again is about; it starts over', { userId: user?.id, err: err.message });
    return null;
  }
  if (!runId) return null;
  const reply = (content, app) => sendDm(pool, {
    bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-finish-${message.id}`, content, moment: 'reply',
    metadata: {
      kind: 'ack', appSlug: app?.slug || null, appName: app?.name || app?.slug || null,
      issueNumber: Number(target.issue_number), firstVersion: true,
    },
  }).catch((err) => {
    log.warn('homeroom-bot-dm', 'Could not say a first version is being finished', { userId: user.id, runId, err: err.message });
    // In the DM machine's answer work, a line that did not go is retried.
    if (deps.strict) throw err;
    return null;
  });
  let said = null;
  // Never throws, and answers ok:false only when nothing was proposed.
  const out = await (deps.botSvc || settingsModule()).finishBuiltFirstVersion(pool, config, {
    runId, user, bot, deps,
    // Said before the bot's own news of it (announceBuilt), so the thread
    // reads in order: finishing it, then built and being tested.
    onProposed: async (app) => { said = await reply(FINISHING_TEXT, app); },
  });
  if (!out?.ok) return null;
  if (out.already) return (await reply(ALREADY_FINISHING_TEXT, out.app)) || { finishing: true, already: true };
  try { require('./homeroom-bot-tray').noteWorkChanged(user.id, deps); } catch { /* the tray re-reads on its own */ }
  return said || { finishing: true, sessionId: out.sessionId || null };
}

// A suggestion is something to say next, never a decision the bot waits on
// (an offer's File it, a ready card's Approve, a plan's Build it).
const SUGGESTION_TYPES = new Set(['prompt', 'reply']);

/** Pure: which request a bot message is about ("slug#n"), or null. */
function requestOf(meta) {
  const n = Number(meta?.issueNumber);
  return meta?.appSlug && Number.isInteger(n) && n > 0 ? `${meta.appSlug}#${n}` : null;
}

/** Pure: whether a bot message's buttons are all suggestions. */
function suggestsOnly(meta) {
  const actions = Array.isArray(meta?.actions) ? meta.actions : [];
  return actions.length > 0 && actions.every((action) => SUGGESTION_TYPES.has(action?.type));
}

/**
 * Only the newest message's suggestions stay live. Once the bot says
 * something new in a DM, the suggestion buttons on its older messages
 * (suggestsOnly) close, and Messages draws a closed suggestion as nothing
 * at all; they used to stay open until somebody typed one's exact words,
 * far up the chat. A question's answers, an offer, a plan or a ready card
 * keep their own lifecycle. Never throws.
 *
 * One story per request (contract 2.3): the buttons on a message about a
 * request (Try again, Add detail, Go ahead) stay until they are used or
 * newer news about the SAME request (`about`, the new message's metadata)
 * replaces them, and then say why. News about another request, or the bot's
 * answer to something said in the chat, leaves them be. Suggestions about
 * no request (a hello's questions to ask) give way to anything newer.
 */
async function retireSuggestions(pool, {
  botId, conversationId, keepMessageId, userId = null, ws = null, about = null, kind = null,
}) {
  if (!botId || !conversationId || !keepMessageId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, metadata FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND id < $3 AND deleted_at IS NULL
          AND metadata->'homeroomBot'->>'status' = 'open'
          AND jsonb_typeof(metadata->'homeroomBot'->'actions') = 'array'
        ORDER BY id DESC LIMIT 20`,
      [conversationId, botId, keepMessageId],
    );
    for (const row of rows) {
      const meta = row.metadata?.[META];
      if (!suggestsOnly(meta)) continue;
      // A card's hello questions are about no request in particular.
      const older = meta?.kind === 'activity' ? null : requestOf(meta);
      if (older) {
        const newer = requestOf(about);
        if (!newer || newer !== older) continue;
        await setQuestionState(pool, Number(row.id), {
          status: 'closed', closedWhy: kind === PLAN_KIND ? 'A newer plan replaced this' : 'No longer needed',
        }, { ws, conversationId, userId });
        continue;
      }
      await setQuestionState(pool, Number(row.id), { status: 'closed' }, { ws, conversationId, userId });
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not retire older suggestions', { conversationId, err: err.message });
  }
}

/**
 * B5: a person wrote the words of one of the bot's open prompts (tapped, or
 * typed): those buttons give way to "You asked: ..." on every device. Never
 * throws; resolves whether one was settled.
 */
async function settlePrompt(pool, { botId, userId, conversationId, content }) {
  const said = String(content || '').trim().toLowerCase();
  if (!said || !botId || !conversationId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT id, metadata FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND deleted_at IS NULL
          AND metadata->'homeroomBot'->>'status' = 'open'
          AND jsonb_typeof(metadata->'homeroomBot'->'actions') = 'array'
        ORDER BY id DESC LIMIT 5`,
      [conversationId, botId],
    );
    for (const row of rows) {
      const actions = row.metadata?.[META]?.actions || [];
      const hit = actions.find((a) => a?.type === 'prompt' && String(a.label || '').trim().toLowerCase() === said);
      if (!hit) continue;
      await setQuestionState(pool, Number(row.id), { status: 'answered', answer: hit.label, chosen: hit.id }, { conversationId, userId });
      return true;
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not settle a prompt', { userId, err: err.message });
  }
  return false;
}

// ── A project built from its description ─────────────────────────────────

/** A description fit to build from, or null. */
function normalizeBrief(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < MIN_BRIEF_CHARS) return null;
  return text.slice(0, MAX_BRIEF_CHARS);
}

/**
 * Pure: what the bot says in its maker's DM at Make it, while the project is
 * set up (startFirstVersion). #4097: the project's name is a line of its
 * own, which Messages draws as the project's card (frontend/src/features/
 * messages/bot-head-card.tsx); with the hello, after it.
 *
 * Run six (14 Oct 2026): it described the old flow, a plan sent here first
 * and a first version "for you to try". Made from a door that lands on the
 * made screen (`earlyPlan`), the plan's questions are answered THERE, and a
 * first version goes live without a vote (D1): so it says what comes next
 * from here, and that it tells them here once it is live. Made anywhere else
 * (a connector's create), the plan still comes here as a card with Build it.
 */
function firstVersionStartedText({ name, hello = false, earlyPlan = false, fromDesign = false, off = false }) {
  const head = hello
    ? `${MAKER_HELLO}\n\n**${name}**\n\nI'm setting up ${name} now.`
    : `**${name}**\n\nThanks! I'm setting up ${name} now.`;
  // 1 Nov 2026: made from a design (the design bot's Make the project), its
  // screens are drawn already: the first version is built from them.
  const next = fromDesign
    ? 'Your design is its plan: I\'ll build the first version from it and tell you here when it\'s live.'
    : earlyPlan
    ? 'I\'ll draw its screens, build the first version and tell you here when it\'s live.'
    : 'Once it\'s ready I\'ll send you my plan here first, then build its first version and tell you here when it\'s live.';
  const paused = off ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : '';
  return `${head} ${next}${paused}`;
}

/**
 * A project was just created with a description (routes/apps.js): what the
 * create dialog asks as "What should it do?". Recorded, so it is filed as
 * the project's first request once its repository is made (app-creation),
 * under its creator's name. When the creator is somebody the bot talks to
 * in a DM, the bot builds that first version and the person is told in their
 * DM; for anybody else the request is filed and left to the group, with no
 * DM.
 * Resolves { conversationId } when the bot builds it and said so, else null.
 */
// `earlyPlan` (13 Oct 2026): made from a door that lands on the made screen
// (routes/apps.js MAKE_ORIGINS), so its plan is written now, while the
// project is set up, for its maker to answer there
// (services/first-version-plan.js).
// The first request owed, written in the route's transaction (`db`) with
// the project, so its making (src/workflow/app-creation/) finds it once its
// setup ends. startFirstVersion, after the commit, says so.
async function recordFirstVersion(db, pool, config, { app, user, brief, design = null }) {
  const text = normalizeBrief(brief);
  if (!text || !app?.id || !user?.id) return false;
  // Read on the caller's transaction connection, never another from the pool
  // while it holds one (a full pool would wait on itself).
  const settings = await settingsModule().readSettings(db);
  const botBuilds = hasBot(settings, user);
  const { rows } = await db.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id) DO NOTHING
     RETURNING app_id`,
    [app.id, user.id, text, botBuilds],
  );
  if (rows.length && design?.design) await recordDesignFirstVersion(db, { app, design, botBuilds });
  return rows.length > 0;
}

// ── A project from a design (threads, one loop: C2.4) ─────────────────────
//
// 1 Nov 2026: a design drawn in one of the person's private threads with
// Homeroom bot, for a project that does not exist yet, is made into one
// (the design bot's Make the project card, POST /api/apps `design`). Its
// first request is filed with the design as its plan, as its maker
// (fileFirstRequest's design_plan), and the bot builds its first version
// from that plan (homeroom-bot.js usePersonPlan): its early plan is
// written from the design, asking nothing, so it is built at once.

/** Pure: a design-made project's brief: their words (or the design's title) and what the design came to. */
function designBrief(design, version, said = null) {
  const own = typeof said === 'string' ? said.replace(/\r\n?/g, '\n').trim() : '';
  const notes = (design.versions || [])
    .filter((v) => v.version <= version && v.note && v.author !== 'capture')
    .map((v) => `- ${clip(v.note, 200)}`);
  return [
    own || design.title,
    `Its first screen is "${design.title}", designed with Homeroom bot in a private thread (version ${version}). `
      + 'The first request\'s plan draws it.',
    notes.length ? `How the design came to be, version by version:\n${notes.join('\n')}` : null,
  ].filter(Boolean).join('\n\n').slice(0, MAX_BRIEF_CHARS);
}

/**
 * The design POST /api/apps is asked to make a project from ({ rootId,
 * version? }): one of the person's own private threads with a design and no
 * project yet, that made none before. Resolves { ok, design, version, brief }
 * or a refusal { ok: false, status, error }.
 */
async function designForProject(pool, { user, design: ref, brief = null, deps = {} }) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return { ok: false, status: 400, error: 'design must be { rootId, version }' };
  const rootId = Number(ref.rootId);
  const asked = ref.version == null ? null : Number(ref.version);
  if (!Number.isSafeInteger(rootId) || rootId <= 0 || (asked != null && !(Number.isSafeInteger(asked) && asked > 0))) {
    return { ok: false, status: 400, error: 'design must be { rootId, version }' };
  }
  if (!user?.id || user.isSynthetic) return { ok: false, status: 403, error: 'Not available for this account' };
  const design = await (deps.designThreads || require('./design-threads')).designFor(pool, { userId: user.id, rootId });
  if (!design || !design.latest) return { ok: false, status: 404, error: 'No such design' };
  if (design.app) return { ok: false, status: 409, error: `This design is a screen of ${design.app.name || design.app.slug}.` };
  const version = asked || design.latest;
  if (!design.versions.some((v) => v.version === version)) return { ok: false, status: 404, error: 'No such version' };
  const { rows: [made] } = await pool.query(
    `SELECT a.slug, a.name FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.design_thread_id = $1 LIMIT 1`,
    [design.threadId],
  );
  if (made) return { ok: false, status: 409, error: `This design already made ${made.name || made.slug}.` };
  return { ok: true, design, version, brief: designBrief(design, version, brief) };
}

// In the create's transaction (`db`): the first version is the design's,
// its plan is ready, and the design's thread is the new project's.
async function recordDesignFirstVersion(db, { app, design, botBuilds }) {
  const plan = botBuilds ? require('./first-version-plan').designPlan(design.design, design.version) : null;
  await db.query(
    `UPDATE homeroom_bot_first_versions
        SET design_thread_id = $2, design_version = $3,
            early_plan = COALESCE($4::jsonb, early_plan),
            early_plan_status = CASE WHEN $4::jsonb IS NULL THEN early_plan_status ELSE 'ready' END,
            early_plan_at = CASE WHEN $4::jsonb IS NULL THEN early_plan_at ELSE NOW() END
      WHERE app_id = $1`,
    [app.id, design.design.threadId, design.version, plan ? JSON.stringify(plan) : null],
  );
  await db.query(
    `UPDATE private_threads SET app_id = $2, state = 'filed', updated_at = NOW() WHERE id = $1`,
    [design.design.threadId, app.id],
  );
  // Drawn for no project, it is a screen of this one now.
  await db.query(`UPDATE design_threads SET surface = 'app' WHERE private_thread_id = $1 AND surface <> 'app'`, [design.design.threadId]);
}

/**
 * fileFirstRequest's `design_plan`: the design a project was made from,
 * posted as its first request's plan, as its maker (design-threads.js
 * postDesignPlan, one screen). Never throws: the request stands without it,
 * and the bot reads it as any first version.
 */
async function postFirstDesignPlan(pool, config, { row, issueNumber, deps = {} }) {
  try {
    const { rows: [thread] } = await pool.query(
      'SELECT root_message_id FROM private_threads WHERE id = $1 AND user_id = $2', [row.design_thread_id, row.user_id]);
    if (!thread) return { posted: false, why: 'gone' };
    await pool.query('UPDATE private_threads SET result_ref = $2, updated_at = NOW() WHERE id = $1', [row.design_thread_id, issueNumber]);
    const { rows: [u] } = await pool.query('SELECT id, username, is_admin FROM users WHERE id = $1', [row.user_id]);
    if (!u) return { posted: false, why: 'gone' };
    const posted = await (deps.designThreads || require('./design-threads')).postDesignPlan(pool, config, {
      user: { id: Number(u.id), username: u.username, isAdmin: !!u.is_admin },
      rootId: Number(thread.root_message_id), version: Number(row.design_version) || null, issueNumber, deps,
    });
    if (!posted.ok) {
      log.warn('homeroom-bot-dm', 'A first version\'s design was not posted as its plan', { app: row.slug, issueNumber, error: posted.error });
      return { posted: false, why: clip(String(posted.error || 'refused'), 200) };
    }
    return { posted: true, version: posted.planVersion || null };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not post a first version\'s design as its plan', { app: row?.slug, issueNumber, err: err.message });
    return { posted: false, why: clip(err.message, 200) };
  }
}

async function startFirstVersion(pool, config, { app, user, brief, earlyPlan = false, fromDesign = false }) {
  const text = normalizeBrief(brief);
  if (!text || !app?.id || !user?.id) return null;
  const settings = await settingsModule().readSettings(pool);
  const bot = hasBot(settings, user) ? await settingsModule().ensureBotUser(pool, config) : null;
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id) DO NOTHING`,
    [app.id, user.id, text, !!bot],
  );
  if (bot && earlyPlan) await require('./first-version-plan').startEarlyPlan(pool, { app, user, brief: text, config, bot });
  if (!bot) {
    log.info('homeroom-bot-dm', 'Project will file its description as its first request', { app: app.slug, userId: user.id });
    return null;
  }
  const name = app.name || app.slug;
  // B5: a maker's first project is where the bot says hello, once: decided
  // in the message's own transaction (sendDm's `hello`).
  const plain = { kind: 'first_version_started', appSlug: app.slug, appName: name };
  const sent = await sendDm(pool, {
    bot,
    userId: user.id,
    idempotencyKey: `hrbot-create-${app.id}`,
    content: firstVersionStartedText({ name, hello: false, earlyPlan, fromDesign, off: settings.mode === 'off' }),
    metadata: plain,
    hello: {
      kind: 'maker',
      content: firstVersionStartedText({ name, hello: true, earlyPlan, fromDesign, off: settings.mode === 'off' }),
      metadata: { ...plain, hello: MAKER_HELLO, actions: promptActions(MAKER_PROMPTS), status: 'open' },
    },
  });
  log.info('homeroom-bot-dm', 'Project will be built from its description', { app: app.slug, userId: user.id });
  return sent ? { conversationId: sent.conversationId } : null;
}

// ── "We'll tell you when it's live" ──────────────────────────────────────
//
// Run six (14 Oct 2026): a first version takes about 23 minutes, so its
// maker leaves, and the tour's last step promised "we'll message you when
// it's live". Being told is ON from Make it, unless its maker turns it off
// (homeroom_bot_first_versions.notify_live, true on the row's insert):
// its "ready to try" and "live" ring (the bell and the phone's push), and
// when no phone can take the push its live is emailed (sendDm, below).
// Off, both are still said in the chat, quietly: no bell, no push, no email.
// The plan card's switch (frontend/src/features/messages/notify-me.tsx)
// reads and sets it through routes/conversations.js.

function slugOf(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

/**
 * Whether the maker of `appSlug`'s first version is told when it is ready
 * and live. Null when `userId` did not make it (or it was made with no
 * description, so there is none).
 */
async function firstVersionNotify(pool, { appSlug, userId }) {
  const slug = slugOf(appSlug);
  if (!slug || !Number.isInteger(Number(userId)) || Number(userId) <= 0) return null;
  const { rows } = await pool.query(
    `SELECT f.notify_live FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE a.slug = $1 AND f.user_id = $2`,
    [slug, Number(userId)],
  );
  return rows.length ? rows[0].notify_live !== false : null;
}

/** Turn it on or off for the first version's maker. Resolves what it is now, or null when it is not theirs. */
async function setFirstVersionNotify(pool, { appSlug, userId, on }) {
  const slug = slugOf(appSlug);
  if (!slug || !Number.isInteger(Number(userId)) || Number(userId) <= 0 || typeof on !== 'boolean') return null;
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_first_versions f SET notify_live = $3
       FROM apps a
      WHERE a.id = f.app_id AND a.slug = $1 AND f.user_id = $2
      RETURNING f.notify_live`,
    [slug, Number(userId), on],
  );
  if (!rows.length) return null;
  log.info('homeroom-bot-dm', 'First version notifications set', { app: slug, userId: Number(userId), on });
  return rows[0].notify_live !== false;
}

/**
 * The request a project's description is filed as: its title and body.
 * Pure. Shared with the benchmark's taste eval (services/bench/taste.js),
 * whose first-version trials are given the same request the bot reads.
 */
function firstVersionIssue({ name, username, brief, botBuilds = true, card = null }) {
  return {
    title: clip(`First version of ${name}`, 200),
    body: [
      `**Source:** Homeroom user (${username})`,
      '',
      brief,
      '',
      // The first session's card (services/app-sketch.js), when it was made:
      // what its creator has already seen, a short summary of the idea. Never
      // a design: until 5 October 2026 it was a mock of a screen, and this
      // line told the build to make that screen.
      ...(card ? [
        `**Featured card:** while it was made, ${username} was shown a card of the idea`
          + `${card.committed ? ' (\`design/sketch.json\`)' : ''}: "${clip(card.tagline, 120)}"`
          + `${(card.points || []).length ? `, with the points ${card.points.map((p) => `"${clip(p, 100)}"`).join(', ')}` : ''}.`
          + ' It sums up the description above in a few words and shows no screen, so it sets no layout, words or'
          + ' colours. Build from the description; where the two differ, the description wins.',
        '',
      ] : []),
      '---',
      botBuilds
        ? `${username} described this when they created the project. Homeroom bot is building its first version from it.`
        : `${username} described this when they created the project.`,
    ].join('\n'),
  };
}

// Newcomer run nine (15 Oct 2026): Submit to the first version's spec took
// 40 s, 18 of them waiting for the starter app to be built, deployed and
// answering before its request was filed, though the request needs only the
// repository. A project's first request is filed by its making
// (src/workflow/app-creation/): once its setup has made the repository with
// the starter and its card, beside its first deploy. Never a project whose
// creation failed: its Retry files it once it is set up again. The bot's
// build waits for the project to run before it is proposed (homeroom-bot.js
// projectSetUpStop): its preview copies the project's database and its merge
// deploys over the project's container.

// What a first request's GitHub issue carries so a filing cut between
// GitHub's answer and its record finds it rather than filing a second.
const firstRequestMarker = (appId) => `<!-- homeroom-first-version:app-${appId} -->`;

// The claim: a waiting row, or one left filing (this work's own try that
// stopped before it kept its claim). Its making's work item is the only
// filer of a project, so nothing else can be filing it.
const CLAIM_SQL = `UPDATE homeroom_bot_first_versions f SET status = 'filing', attempts = f.attempts + 1
   WHERE f.app_id = $1 AND f.status IN ('waiting', 'filing')`;

/**
 * File one project's first request (app-creation's `app.firstRequest`
 * work, once): a GitHub issue under the creator's name and the platform's
 * issue row. When the bot builds it, the creator is recorded as its
 * requester (so the bot's news reaches their DM) and the bot is woken for
 * it; otherwise nothing of the bot's is touched. Each part is a step of the
 * work (`steps`): the issue is asked for once, and a try that resumes after
 * GitHub answered looks for it (its marker) before asking again. A failure
 * throws while tries are left; the last one (`last`) is recorded and told
 * to the maker. Resolves what it did.
 */
async function fileFirstRequest(pool, config, appId, { steps, last = false, deps = {} } = {}) {
  if (isStaging() && !deps.allowStaging) return { skipped: 'staging' };
  const { rows: [row] } = await pool.query(
    `SELECT f.app_id, f.user_id, f.brief, f.bot_builds, f.status, f.design_thread_id, f.design_version,
            a.slug, a.name, a.repo_url
       FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.app_id = $1`,
    [appId],
  );
  // Filed, unless this work filed it and stopped before saying so (its
  // `record` step kept, its `announce` not): then it says so now.
  if (!row || row.status === 'failed' || (row.status === 'filed' && !steps.has('record'))) return { skipped: row ? row.status : 'none' };
  const github = deps.github || require('./github');
  const ws = deps.ws || require('./ws');
  const { rows: people } = await pool.query('SELECT username FROM users WHERE id = $1', [row.user_id]);
  const username = people[0]?.username || 'unknown';
  const name = row.name || row.slug;
  const botBuilds = row.bot_builds !== false;
  const appSketch = require('./app-sketch');
  const sketchRow = await appSketch.readSketch(pool, row.app_id).catch(() => null);
  const cardRow = sketchRow && sketchRow.status === 'ready' ? appSketch.cardOf(sketchRow.design) : null;
  const card = cardRow ? { ...cardRow, committed: !!sketchRow.committed_at } : null;
  const { title, body } = firstVersionIssue({ name, username, brief: row.brief, botBuilds, card });
  try {
    // Claimed once, from waiting, or from a filing this work's own try left.
    await steps.once('claim', async () => {
      const { rowCount } = await pool.query(CLAIM_SQL, [appId]);
      if (rowCount) return true;
      const { rows: [now] } = await pool.query('SELECT status FROM homeroom_bot_first_versions WHERE app_id = $1', [appId]);
      throw Object.assign(new Error(`it is ${now?.status ?? 'gone'}`), { settled: now?.status ?? 'none' });
    });
    const parsed = repoRef.ownerRepo(row.repo_url);
    if (!parsed || !github.isEnabled()) throw new Error('github_unavailable');
    const marker = firstRequestMarker(appId);
    const issueNumber = await steps.once('issue', async () => {
      // Asked before, by a try that stopped before it kept the answer: the
      // issue is there if GitHub made it.
      if (steps.get('asked')) {
        const found = await github.findIssueByMarker(parsed.owner, parsed.repo, marker);
        if (found) return found.number;
      }
      await steps.set('asked', true);
      const filedBody = `${typeof github.safeMention === 'function' ? github.safeMention(body) : body}\n\n${marker}`;
      const created = await github.createIssue(parsed.owner, parsed.repo, { title, body: filedBody });
      const number = Number(created?.number);
      if (!Number.isInteger(number) || number <= 0) throw new Error('invalid issue number');
      return number;
    });
    // 1 Nov 2026 (C2.4): a project made from a design: the design is its
    // first request's plan, posted before the request is recorded as the
    // bot's to build, so the bot never reads it without it.
    if (row.design_thread_id) {
      await steps.once('design_plan', () => postFirstDesignPlan(pool, config, { row, issueNumber, deps }));
    }
    const issueId = await steps.once('record', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // A try that committed this and stopped before it kept the step
        // finds its own row.
        const { rows: had } = await client.query(
          'SELECT id FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id LIMIT 1', [row.app_id, issueNumber]);
        const { rows: issueRows } = had.length ? { rows: had } : await client.query(
          `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
           VALUES ($1, $2, $3, $4, 'general', '{}', $5) RETURNING id`,
          [row.app_id, issueNumber, title, body, row.user_id],
        );
        if (botBuilds) {
          await client.query(
            `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
             VALUES ($1, $2, $3, $4, TRUE, $5)
             ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id, first_version = TRUE,
               asked_text = COALESCE(homeroom_bot_requesters.asked_text, EXCLUDED.asked_text)`,
            // B4: the brief they wrote is what they asked for.
            [row.app_id, issueNumber, row.user_id, title, clip(row.brief, 2000) || null],
          );
        }
        await client.query(
          `UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = $2, filed_at = NOW(), error = NULL
            WHERE app_id = $1`,
          [row.app_id, issueNumber],
        );
        await client.query('COMMIT');
        return issueRows[0]?.id ?? null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
    await steps.once('announce', async () => {
      await ws.sendSystemMessage(pool, row.app_id, `${username} created issue: "${title}" (#${issueNumber})`,
        'system', null, { type: 'issue', ref: issueNumber }).catch(() => {});
      ws.pushIssueUpdate({ action: 'created', appSlug: row.slug, appId: row.app_id, issueId, kind: 'general' });
      // #3952: the people the creator's description names with @. Never rejects.
      (deps.notifications || require('./notifications')).notifyIssueMentions?.(pool, {
        appId: row.app_id, issueNumber, authorId: row.user_id, text: `${title}\n\n${body}`,
      });
      if (botBuilds) settingsModule().noteIssueActivity({ appId: row.app_id, issueNumber, reason: 'first_version' });
      return true;
    });
    log.info('homeroom-bot-dm', 'Filed a first version', { app: row.slug, issueNumber, userId: row.user_id, botBuilds });
    return { issueNumber };
  } catch (err) {
    if (steps.stopped) throw err;
    // Another process filed it, or gave it up, meanwhile: its outcome is
    // its own to tell.
    if (err.settled) return { skipped: err.settled };
    // Held while this work tries again (its claim is kept), given up on its
    // last try.
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = $2, error = $3 WHERE app_id = $1 AND status <> 'filed'`,
      [row.app_id, last ? 'failed' : 'filing', clip(err.message, 300)],
    ).catch(() => {});
    log.warn('homeroom-bot-dm', 'Could not file a first version', { app: row.slug, err: err.message, final: last });
    if (!last) throw err;
    if (botBuilds) {
      const bot = await botAccount(pool);
      if (bot) {
        await sendDm(pool, {
          bot, userId: row.user_id, idempotencyKey: `hrbot-filefail-${row.app_id}`,
          content: `**${name}**\n\nI couldn't start building ${name}'s first version. You can still post a request on `
            + 'its page, or start a change from there yourself.',
          metadata: { kind: 'first_version_failed', appSlug: row.slug, appName: name, firstVersion: true },
        }).catch(() => null);
      }
    }
    return { failed: clip(err.message, 300) };
  }
}

/**
 * Where approval of a first version that is ready to try stands, for one
 * person reading its App tab (firstVersionState below), so the screen can
 * say what it waits on rather than only that it waits:
 *
 *   sessionId    the change, for Try it (its preview) and See the change
 *   mustApprove  their Yes counts on the project (approvalState: its named
 *                approvers, else every member), is not in yet, and is
 *                still needed
 *   approved     their Yes counts and is in
 *   waitingOn    up to three of the people it still waits on, never the
 *                reader (needsYesFrom: who the "ready to try" notification
 *                asked), and `more` the rest; empty once no Yes is missing
 *   missing      how many more Yes votes it needs (0 when it has them)
 *   goesLiveAt   when it goes live anyway if nobody objects: the end of the
 *                merge clock that runs (active-users.js mergeGate: the
 *                lazy-consensus window while a Yes is missing, the
 *                visibility window once it has them), from when it went up
 *                for approval. Null when no clock runs (an "at least N"
 *                project, a change to protected settings, no Yes yet).
 *   soon         nothing more is needed: it goes live in a minute or two
 *   noVote       it goes live without a vote (13 Oct 2026, D1: a project's
 *                first version needs nobody's Yes once it passes its checks;
 *                governance-gate.ts applyFirstVersion). Then nobody must
 *                approve it, nobody has, and nobody is waited on: the App tab
 *                says it goes live without a vote. False only for a first
 *                version that changes protected settings, whose rule still
 *                asks for a Yes.
 *
 * The gate is the change's real one, counted with its explicit-approval
 * flag so no clock is promised to a change that has none. Null for no such
 * change.
 */
async function firstVersionApproval(pool, sessionId, viewerId = null) {
  const viewer = Number(viewerId) || null;
  const state = await approvalState(pool, { sessionId, userId: viewer });
  if (!state) return null;
  const id = Number(state.session.id);
  const appId = Number(state.session.app_id);
  // approvalState's own gate when it carries one; else read here, with the
  // change's explicit-approval flag (governance.js applyNoTimerMerge).
  let gate = state.gate || null;
  if (!gate) {
    const { rows: [flags] } = await pool.query(
      'SELECT COALESCE(requires_explicit_approval, FALSE) AS explicit_approval FROM chat_sessions WHERE id = $1', [id],
    );
    gate = await require('./governance').governedGate(pool, appId, {
      kind: 'pr', id, openedAt: state.session.opened_at,
      explicitApproval: flags?.explicit_approval === true, authorId: state.session.user_id ?? null,
    });
  }
  if (gate.firstVersion === true) {
    return {
      sessionId: id,
      noVote: true,
      mustApprove: false,
      approved: false,
      waitingOn: [],
      more: 0,
      missing: 0,
      goesLiveAt: null,
      soon: !!gate.mergeable,
    };
  }
  const missing = gate.thresholdMet
    ? 0
    : Math.max((Number(gate.required) || 1) - (Number(gate.qualifiedYes) || 0), 1);
  // Voting is a member's (communities.requireSessionMembership), so a Yes
  // that would count is asked only of a member.
  const member = viewer ? await require('./communities').isMember(pool, appId, viewer) : false;
  const approved = state.counts && state.already;
  const waiting = missing
    ? await usernamesOf(pool, await needsYesFrom(pool, state, { except: viewer ? [viewer] : [] }))
    : [];
  const clock = (gate.thresholdMet || gate.lazyArmed) && gate.windowEndsAt ? new Date(gate.windowEndsAt) : null;
  return {
    sessionId: id,
    mustApprove: state.counts && !state.already && member && missing > 0,
    approved,
    waitingOn: waiting.slice(0, 3),
    more: Math.max(waiting.length - 3, 0),
    missing,
    goesLiveAt: clock && Number.isFinite(clock.getTime()) ? clock.toISOString() : null,
    soon: !!gate.mergeable,
    noVote: false,
  };
}

/**
 * #15 (D9): whether the Homeroom bot is still building a project's first
 * version from its description, and where it is, for the App tab. While it
 * builds, the app's own page is the starter its repo was scaffolded with
 * (services/template.js), which says "Start a new change" to somebody whose
 * change is already being made; the shell shows this state instead.
 *
 * Building while the bot builds it (`bot_builds`) and either the request is
 * not filed yet (waiting or filing: the project is being set up), or it is
 * filed and no proposal for it has merged. Null once one has, once filing
 * failed, once the project failed to set up, and once the request came to
 * something other than a merge (the bot left it to the group, its proposal
 * was closed): then the app is what there is. A build that stopped is not
 * that (14 Oct 2026): `line` 'stopped', with `stopped` saying where its
 * maker was told (stoppedThreadOf), until Try again starts it over, or (15
 * Oct 2026) proposes what was built (finishOnTryAgain): its run is then
 * proposed, and this is the step that proposal is on.
 *
 * `{ userId, creator, conversationId, step, of, line, question, ready }`:
 * whose description it is, their DM with the bot, the step of
 * homeroom-bot-progress.js's FIRST_VERSION_STEPS, the build line its
 * thumbnail shows to whoever reads it (`deps.viewerId`; buildLineOf, #4053),
 * whether the bot waits on an answer from them, and whether its proposal is
 * ready to try (N5: up for the vote by the rule its ready card goes out on,
 * changeReadiness, with no follow-up queued or running on it; until then it
 * is on the step before, Testing it). While it is ready, `approval` is where
 * approval of it stands for that reader (firstVersionApproval above), when
 * that could be read. While it is built and tested, `chosenPlan` is the plan
 * its maker chose (chosenPlanOf, #4396). GET /api/apps/:slug reads it
 * best-effort: a read that fails is no state, never a failed page.
 */
async function firstVersionState(pool, appId, deps = {}) {
  if (!appId) return null;
  const rows = await firstVersionRows(pool, [appId]);
  return firstVersionStateOf(pool, rows.get(Number(appId)), deps);
}

/**
 * firstVersionState for every one of `appIds`, for a list of them (GET
 * /api/apps's tiles): Map(appId -> state), with no entry where it is null.
 * One query reads every app's record. Only the few still building go on to
 * read their progress, and they do it one after another, never one query
 * per app at once: the list ran them in parallel, and one load checked out
 * a connection per app, which held the web's whole pool (22 Oct 2026). Most
 * records it reads are long merged and end at the first gate.
 */
async function firstVersionStates(pool, appIds, deps = {}) {
  const states = new Map();
  const rows = await firstVersionRows(pool, appIds);
  for (const [appId, row] of rows) {
    const state = await firstVersionStateOf(pool, row, deps);
    if (state) states.set(appId, state);
  }
  return states;
}

// The first-version record of each of `appIds` the bot builds, with what
// firstVersionStateOf needs from its app, maker and proposals: Map(appId ->
// row), one query for them all.
async function firstVersionRows(pool, appIds) {
  const ids = [...new Set(appIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT f.app_id, f.user_id, f.status, f.issue_number, f.created_at,
            f.early_plan, f.early_plan_status, f.answers, f.answered_at,
            a.slug, a.name, a.status AS app_status, a.created_at AS app_created_at,
            u.username,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
                JOIN chat_sessions cs ON cs.id = r.proposal_session_id
               WHERE r.app_id = f.app_id AND r.issue_number = f.issue_number AND cs.status = 'merged'
                 AND cs.live_at IS NOT NULL
            ) AS merged,
            (SELECT p.conversation_id
               FROM users b
               JOIN conversation_direct_pairs p
                 ON p.user_low_id = LEAST(b.id, f.user_id) AND p.user_high_id = GREATEST(b.id, f.user_id)
               JOIN conversation_members m
                 ON m.conversation_id = p.conversation_id AND m.user_id = f.user_id AND m.status = 'member'
              WHERE b.username = $2 AND b.is_synthetic = TRUE
              LIMIT 1) AS conversation_id
       FROM homeroom_bot_first_versions f
       JOIN apps a ON a.id = f.app_id
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.app_id = ANY($1::int[]) AND f.bot_builds = TRUE`,
    [ids, BOT_USERNAME],
  );
  return new Map(rows.map((row) => [Number(row.app_id), row]));
}

async function firstVersionStateOf(pool, row, deps = {}) {
  if (!row ||!['waiting', 'filing', 'filed'].includes(row.status) || row.merged) return null;
  const progress = deps.progress || require('./homeroom-bot-progress');
  const fvPlan = require('./first-version-plan');
  const forCreator = deps.viewerId != null && Number(deps.viewerId) === Number(row.user_id);
  // 13 Oct 2026: its plan from Make it (first-version-plan.js), once its
  // maker answered it or when it asks nothing: decided, so it is being
  // built from here, not planned, whatever the setup and the request's
  // first look are doing.
  const decidedEarly = fvPlan.decided(row);
  // The step, for Homeroom bot's chat, and the build line its thumbnail
  // shows this reader (#4053): "Your plan is ready to review" to the person
  // who started it, "Planning it" to everyone else, while the plan waits.
  const at = (stage, { question = false } = {}) => {
    const line = progress.buildLineOf(stage, { forCreator, question });
    return {
      step: progress.stepNumber(stage, true),
      of: progress.FIRST_VERSION_STEPS.length,
      line: decidedEarly && line === 'planning' ? 'building' : line,
    };
  };
  // Its maker's own: the plan from Make it while it is written, and once it
  // is, its lines and questions, for the made screen to ask them.
  const earlyStatus = fvPlan.planStatus(row);
  const earlyPlan = fvPlan.planOf(row);
  const early = forCreator && (earlyStatus === 'pending' || (earlyStatus === 'ready' && earlyPlan))
    ? {
      early: earlyStatus === 'pending'
        ? { status: 'pending' }
        : { status: 'ready', bullets: earlyPlan.bullets, questions: earlyPlan.questions, answered: !!row.answered_at },
    }
    : {};
  // N4: the step list from the start, while nothing is built yet: a plan
  // decided at Make it is done, and its screens are next in hand.
  const steps = (phase, times = {}) => ({
    steps: progress.firstVersionSteps(
      phase || (decidedEarly ? { key: 'drawing', since: row.answered_at ? new Date(row.answered_at).toISOString() : null } : null),
      { made: row.created_at, decided: row.answered_at, ...times },
    ),
  });
  const base = { userId: Number(row.user_id), creator: row.username || null, conversationId: Number(row.conversation_id) || null };
  // Run five: decided, and its build not picked up yet: the build starting,
  // named so on every screen, never "Drawing the screens" before any are.
  const starting = decidedEarly
    ? { phase: { key: 'starting', since: row.answered_at ? new Date(row.answered_at).toISOString() : null } }
    : {};
  if (row.status !== 'filed') {
    if (progress.setupOf(row).outcome) return null;
    return { ...base, ...at('setting_up'), question: false, ready: false, ...starting, ...early, ...steps(null) };
  }
  const states = await progress.requestStates(pool, { userId: row.user_id });
  const found = states.find((s) => Number(s.row.app_id) === Number(row.app_id)
    && Number(s.row.issue_number) === Number(row.issue_number));
  if (found?.state) {
    // B6: the plan it waits on, for the creator to build from the App tab too.
    const plan = found.state.stage === 'plan'
      ? await waitingPlan(pool, { userId: row.user_id, appId: row.app_id, issueNumber: row.issue_number }).catch(() => null)
      : null;
    // A plan its creator asked to change is read again (changePlan puts it
    // first in line as 'plan_change'). That read is the plan being redone,
    // not the description being read for the first time, so it stays on the
    // plan's step rather than going back one. Its line is planning either way.
    const replanning = found.row?.queue_reason === 'plan_change'
      && (found.state.stage === 'queued' || found.state.stage === 'reading');
    const question = found.state.stage === 'question' && found.state.waitingOn === 'them';
    // N5: ready to try by the rule its ready card goes out on
    // (changeReadiness: its checks passed on its head, and its before &
    // after shots settled), never off the vote step alone: a follow-up
    // queued or running on it (a fix of its failing checks, say) is not
    // ready, and neither is a pass its shots still hold back. A read that
    // fails is not ready.
    const proposalId = Number(found.row?.proposal_session_id) || null;
    const readiness = found.state.stage === 'vote' && proposalId
      ? await (deps.readiness || changeReadiness)(pool, proposalId).catch((err) => {
        log.warn('homeroom-bot-dm', 'Could not read whether a first version is ready to try', { appId: row.app_id, err: err.message });
        return null;
      })
      : null;
    const ready = found.state.stage === 'vote' && readiness?.ready === true;
    const stage = progress.firstVersionStage(found.state.stage, { ready });
    // Ready to try: who it waits on, for the App tab to say. A read that
    // fails leaves the screen as it was before it said so.
    const approval = ready && found.row?.proposal_session_id
      ? await firstVersionApproval(pool, found.row.proposal_session_id, deps.viewerId).catch((err) => {
        log.warn('homeroom-bot-dm', 'Could not read who a first version waits on', { appId: row.app_id, err: err.message });
        return null;
      })
      : null;
    const where = replanning ? { ...at('reading'), step: progress.stepNumber('plan', true) } : at(stage, { question });
    // N4: the stage named, with when it began, and the App tab's steps.
    const firstLookAt = found.row?.run_id && !ready && LOOKED_STAGES.has(found.state.stage)
      ? await firstLookAtOf(pool, found.row.run_id).catch(() => null)
      : null;
    const phase = !replanning && !ready ? progress.firstVersionPhase({ ...found.state, stage }, found.row, { firstLookAt }) : null;
    // Run five (13 Oct 2026, fix 7): merged and not live yet, its steps
    // stay done and Live is under way. With no phase they were drawn from
    // the start ("Plan written: now") for the half minute until live_at.
    const goingLive = found.state.stage === 'merging';
    const listed = ready ? {} : steps(goingLive ? progress.GOING_LIVE : phase, {
      decided: row.answered_at || (phase ? found.row.build_started_at : null),
      firstLook: firstLookAt,
      spec: found.row.spec_at,
      review: found.row.review_started_at,
      proposal: found.row.proposal_at,
    });
    // #4396: the plan its maker chose, while it is built and tested, for
    // the members waiting on it (routes/apps.js sharedPlan cuts it). Build
    // it (homeroom-bot.js goAhead) keeps the plan on its run and marks it
    // `chosen`; nothing is read before the build step or once it is ready.
    const chosenPlan = !ready && !plan && !replanning
      && where.step >= progress.FIRST_VERSION_STEPS.indexOf('Building it') + 1
      ? await chosenPlanOf(pool, row.app_id, row.issue_number).catch(() => null)
      : null;
    return {
      ...base,
      ...where,
      question,
      ready,
      ...(plan ? { plan } : {}),
      ...(chosenPlan ? { chosenPlan } : {}),
      ...(approval ? { approval } : {}),
      ...(phase ? { phase } : {}),
      ...listed,
      ...(plan ? {} : early),
    };
  }
  // 14 Oct 2026 (newcomer run eight, Club Votes): its build stopped, and
  // nothing is live yet (progress.firstVersionStopped). This answered null
  // here, so the App tab showed the starter template its repo was made from
  // ("Welcome to your new app!") with nothing to say that anything had gone
  // wrong. It says Stopped on every screen that draws the line, and where
  // Try again is: the build's thread in its maker's chat with Homeroom bot
  // (stoppedThreadOf). No steps: nothing is under way.
  if (found && progress.firstVersionStopped(found.row)) {
    const thread = await stoppedThreadOf(pool, {
      userId: row.user_id, appId: row.app_id, issueNumber: row.issue_number,
    }).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not read where a stopped first version was said', { appId: row.app_id, err: err.message });
      return null;
    });
    return {
      ...base,
      step: progress.stepNumber('building', true),
      of: progress.FIRST_VERSION_STEPS.length,
      line: 'stopped',
      question: false,
      ready: false,
      stopped: thread || {},
    };
  }
  // Filed, and nothing in progress: either it came to something, or the bot
  // has not picked it up yet (filing wakes it, and it reads it next).
  if (found && progress.outcomeOf(found.row)) return null;
  return { ...base, ...at('queued'), question: false, ready: false, ...starting, ...early, ...steps(null) };
}

/**
 * 14 Oct 2026: where Homeroom bot told the maker of a first version that its
 * build stopped, the message with Try again under it (relayIssuePost,
 * 'build_failed'): `{ conversationId, messageId, threadRootId }`, the root
 * when it was said in the request's thread, or null when it was not said in
 * their chat (they left it, or the DM was refused).
 */
async function stoppedThreadOf(pool, { userId, appId, issueNumber }) {
  const { rows: [said] } = await pool.query(
    `SELECT d.message_id, d.conversation_id, m.thread_root_id
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = 'build_failed'
      ORDER BY d.message_id DESC
      LIMIT 1`,
    [Number(userId), Number(appId), Number(issueNumber)],
  );
  if (!said) return null;
  return {
    conversationId: Number(said.conversation_id) || null,
    messageId: Number(said.message_id) || null,
    threadRootId: Number(said.thread_root_id) || null,
  };
}

// N4: the stages from its spec turn on, when a first look may be drawn.
const LOOKED_STAGES =new Set(['planning', 'building', 'reviewing', 'proposing', 'checks', 'checks_failed', 'fix_queued', 'fixing', 'merging']);

/** N4: when a first version's run had its first look drawn, or null. */
async function firstLookAtOf(pool, runId) {
  const { rows: [r] } = await pool.query(
    `SELECT MIN(created_at) AS at FROM first_version_screens WHERE bot_run_id = $1 AND kind = 'first_look'`,
    [Number(runId)],
  );
  return r && r.at ? r.at : null;
}

/**
 * #4396: the plan a first version's maker chose with Build it, the newest
 * run's that went ahead (goAhead writes `chosen` onto it): { bullets,
 * questions }, or null. The answers chosen are not read.
 */
async function chosenPlanOf(pool, appId, issueNumber) {
  const { rows: [run] } = await pool.query(
    `SELECT plan FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND plan ? 'chosen'
      ORDER BY id DESC LIMIT 1`,
    [appId, issueNumber],
  );
  if (!run || !Array.isArray(run.plan?.bullets)) return null;
  return {
    bullets: run.plan.bullets,
    questions: Array.isArray(run.plan.questions) ? run.plan.questions : [],
  };
}

/** The create dialog's suggested one-line description, from the longer one. */
async function suggestShortDescription({ name, brief, max = 90, deps = {} }) {
  const text = normalizeBrief(brief);
  if (!text) return null;
  const llm = deps.llm || require('./llm');
  try {
    const out = await llm.generateShortDescription({ name, brief: text, max });
    if (out?.description) return { description: clip(out.description, max).slice(0, max), usage: out.usage, model: out.model };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Short description suggestion failed; using the first sentence', { err: err.message });
  }
  return { description: firstSentence(text, max), usage: null, model: null };
}

/** The description's first sentence, cut at a word to fit `max`. */
function firstSentence(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0].replace(/[.!?]+$/, '');
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

module.exports = {
  PLAN_STOPPED_KIND,
  planStoppedText,
  BOT_USERNAME,
  QUESTION_KINDS,
  MIRRORED_KINDS,
  MOMENTS,
  BUILD_KINDS,
  momentOf,
  STORY_MOMENTS,
  RINGING_MOMENTS,
  storyMomentOf,
  saidOf,
  storyMetadata,
  threadRootFor,
  notePlanChanged,
  threadRequest,
  messageThread,
  threadDeps,
  noteStep,
  // Homeroom bot parity P6: a request's card in a person's chat with the bot.
  cardShown,
  waitingPhrase,
  BUILT_TESTING_TEXT,
  PREVIEW_RETRY_TEXT,
  notificationDetail,
  askedLine,
  hasOthers,
  TYPICAL_BUILD_MINUTES,
  typicalMinutes,
  typicalMinutesCached,
  noteRequestFiled,
  botDoorFor,
  askBotToBuild,
  WAITING_TEXT,
  botWaitingByIssue,
  askersOf,
  MAKER_HELLO,
  joinerHello,
  TOUR_HELLO,
  TOUR_PROMPTS,
  greetTourFinisher,
  greetJoiner,
  READY_MADE_PROMPTS,
  readyMadeHello,
  greetReadyMadeMaker,
  MAKER_PROMPTS,
  MEMBER_PROMPTS,
  memberHello,
  promptActions,
  STUCK_ACTIONS,
  // 15 Oct 2026: Try again finishes a first version that was built.
  TRY_AGAIN_WORDS,
  FINISHING_TEXT,
  ALREADY_FINISHING_TEXT,
  saysTryAgain,
  finishOnTryAgain,
  suggestsOnly,
  retireSuggestions,
  greet,
  settlePrompt,
  READY_CHECKS,
  readyKey,
  changeReadiness,
  brokenWords,
  tellReady,
  noteChangeStopped,
  needsLookText,
  noteNeedsLook,
  sweepUnproposedBuilds,
  MAX_BRIEF_CHARS,
  designBrief,
  designForProject,
  postFirstDesignPlan,
  MIN_BRIEF_CHARS,
  HELP_TEXT,
  NOT_ENABLED_TEXT,
  hasBot,
  isEnabledFor,
  botAccount,
  PROJECT_ORIGINS,
  noteProjectMade,
  importedAt,
  sendDm,
  TYPING_RENEW_MS,
  TYPING_MAX_MS,
  startTyping,
  whileTyping,
  typingDoing,
  draftTail,
  MAX_DRAFT_CHARS,
  MAX_DRAFT_BYTES,
  DOING_KINDS,
  recordRequester,
  requesterOf,
  requestTitleFor,
  personOf,
  weeklySpentCents,
  weeklyCapCents,
  overWeeklyAllowance,
  noteOverAllowance,
  overAllowanceText,
  allowanceLow,
  ALLOWANCE_LOW_SHARE,
  notePausedForWeek,
  PAUSED_FOR_WEEK_TEXT,
  weekKey,
  dmText,
  buildFailedWords,
  updateFailedWords,
  failedWords,
  twoQuestions,
  // B7: ready to try, and who approves it.
  approvalState,
  needsYesFrom,
  readyActions,
  noteApproversReady,
  noteApproved,
  noteApprovalWithdrawn,
  goesLiveAfterYes,
  usernamesOf,
  // 5 October: a ready card read as it stands now, and the live news's way in.
  MAX_READY_READS,
  MAX_READY_APPROVALS,
  readyStateOf,
  readyStates,
  sayApproved,
  openAppAction,
  firstLiveActions,
  // B6: a first version's plan.
  PLAN_KIND,
  planCardText,
  planCards,
  sendPlanCard,
  closePlanCards,
  decidePlanTap,
  changePlan,
  changeOnRequest,
  markPlanBuilt,
  isPlanGoWord,
  waitingPlan,
  // Papote #3: Build it said to the bot (start_request).
  waitingPlanRun,
  buildWaitingPlan,
  // 13 Oct 2026: a first version's plan answered on the made screen.
  buildFromAnswers,
  answerFirstVersion,
  dmRecipient,
  untaggedRequester,
  requestLine,
  closeOpenQuestions,
  setQuestionState,
  relayIssuePost,
  staleBuildNews,
  noteBuildRestarted,
  CARD_ONLY,
  cardOnly,
  buildFailedCause,
  newsKind,
  cardsFor,
  quotedTarget,
  quotable,
  requestStart,
  newestOpenQuestion,
  postOnRequest,
  postOnProposal,
  settleMirroredAsks,
  noteRequestReply,
  voteLineFor,
  voteLineTarget,
  handVoteLine,
  noteProposalMerged,
  firstVersionText,
  announceFirstVersion,
  // #7, #8, #20 (WP3)
  hasProposalCard,
  mergedText,
  isBotDirect,
  MIRRORED_FROM_DM,
  mirroredText,
  noteUserMessage,
  heardInDm,
  answerOwed,
  answeredAlready,
  sayCouldNotAnswer,
  normalizeBrief,
  firstVersionIssue,
  firstVersionStartedText,
  startFirstVersion,
  firstVersionNotify,
  setFirstVersionNotify,
  fileFirstRequest,
  recordFirstVersion,
  firstVersionApproval,
  firstVersionState,
  firstVersionStates,
  suggestShortDescription,
  firstSentence,
};
