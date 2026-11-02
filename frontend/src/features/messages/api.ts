import type {
  DesignPin,
  ConversationDetail,
  ConversationMember,
  ConversationMessage,
  ConversationSummary,
  ConversationUser,
  HomeroomBotActivity,
  HomeroomBotActivityOutcome,
  HomeroomBotActivityRead,
  HomeroomBotJob,
  HomeroomBotAction,
  HomeroomBotGoesLive,
  HomeroomBotMeta,
  HomeroomBotPastJob,
  HomeroomBotPhase,
  HomeroomBotPlan,
  HomeroomBotPlanQuestion,
  HomeroomBotReadyNow,
  HomeroomBotWork,
  BotSlotEntry,
  BotSlotsView,
  BotTrack,
  BotTrackState,
  BotTrackStep,
  MessageAttachment,
  DiscussionMessage,
  DiscussionState,
  MessageReaction,
  MessageThreadSummary,
  SharedObjectCard,
  SharedObjectReference,
  ThreadRootRef,
  UserSearchResult,
  HomeroomBotCard,
  HomeroomBotLooked,
} from './types';
import { t } from '../../lib/i18n/runtime';
import { countOf } from './approval-words';
import { releaseOf } from '../../lib/release-eta';
import type { HomeroomLink } from './homeroom-links';
import { botRowPreview, plainText } from './plain-text';

const MAX_ID = 2_147_483_647;

type JsonRecord = Record<string, unknown>;

export class MessagesApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MessagesApiError';
    this.status = status;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function strictId(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
}

/**
 * A read cursor: a message id, or 0 for "read nothing yet", which a strict
 * id refuses. Null when the server did not say (an invitation, an older
 * server), so the conversation opens at its newest message as it always did.
 */
function readCursor(value: unknown): number | null {
  if (value === 0 || value === '0') return 0;
  return strictId(value);
}

function dateText(value: unknown): string {
  const candidate = text(value);
  return candidate || new Date(0).toISOString();
}

function pick(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

export function normalizeUser(input: unknown): ConversationUser {
  const row = record(input);
  const username = pick(row, 'username', 'name');
  return {
    id: strictId(pick(row, 'id', 'userId', 'user_id')) || 0,
    username: typeof username === 'string' ? username : t('messages:api.unknownUser'),
    // No username came with the row: `username` is a stand-in, never a name in a sentence.
    ...(typeof username === 'string' ? {} : { unnamed: true }),
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || null,
    // #3624: a platform account (the Homeroom bot). Named here, or dropped.
    ...(pick(row, 'bot') === true ? { bot: true } : {}),
    // B5: and the name it is shown by, for a platform account only.
    ...(pick(row, 'bot') === true && text(pick(row, 'displayName')) ? { displayName: text(pick(row, 'displayName')).slice(0, 80) } : {}),
  };
}

const BOT_QUESTION_STATES = new Set(['open', 'answered', 'closed']);
// B3: the kinds of button the client knows how to press (types.ts
// HomeroomBotAction). An unknown one is dropped, never drawn as a dead button.
// B7: a change's ready card adds three: its preview (Try it), the person's
// own Yes (Approve) and a reply quoting the card (Change something).
// #4231: and `invite`, under a new project's first version going live.
// 1 Nov 2026: `design` (the screen picker) retired: the bot draws a screen
// from words now, and an old Pick the screen button is no longer drawn.
// `make` opens the sheet that makes a project from a design (./bot-make.tsx).
const BOT_ACTION_TYPES = new Set(['server', 'open', 'prompt', 'preview', 'vote', 'reply', 'invite', 'make']);
const MAX_BOT_ACTIONS = 3;

/** B3: a bot message's buttons, as types.ts HomeroomBotAction: at most three, one primary. */
function normalizeBotActions(input: unknown): HomeroomBotAction[] {
  const out: HomeroomBotAction[] = [];
  let primary = false;
  for (const entry of array(input)) {
    if (out.length >= MAX_BOT_ACTIONS) break;
    const row = record(entry);
    const id = text(pick(row, 'id')).slice(0, 40);
    const label = text(pick(row, 'label')).slice(0, 60);
    const type = text(pick(row, 'type'));
    if (!id || !label || !BOT_ACTION_TYPES.has(type)) continue;
    const target = type === 'open' ? inAppHref(pick(row, 'target')) : null;
    if (type === 'open' && !target) continue;
    // B7: the change a preview or a vote is of, and the version a vote is for.
    const sessionId = type === 'preview' || type === 'vote' ? strictId(pick(row, 'sessionId')) : null;
    if ((type === 'preview' || type === 'vote') && !sessionId) continue;
    const epoch = type === 'vote' && Number.isInteger(pick(row, 'epoch')) ? Number(pick(row, 'epoch')) : null;
    const style = pick(row, 'style') === 'primary' && !primary ? 'primary' : 'secondary';
    if (style === 'primary') primary = true;
    out.push({
      id, label, style, type: type as HomeroomBotAction['type'],
      ...(target ? { target } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(epoch !== null ? { epoch } : {}),
      ...(type === 'prompt' && pick(row, 'quote') === true ? { quote: true } : {}),
      // #5506: Try it for someone who does not build there: the look-only preview.
      ...(type === 'preview' && pick(row, 'readOnly') === true ? { readOnly: true } : {}),
    });
  }
  return out;
}

/** B6: a plan's choices, or two questions: each with two to four answers, the suggested one first. */
function normalizePlanQuestions(input: unknown): HomeroomBotPlanQuestion[] {
  const out: HomeroomBotPlanQuestion[] = [];
  for (const entry of array(input)) {
    if (out.length >= 2) break;
    const row = record(entry);
    const question = text(pick(row, 'question')).slice(0, 300);
    const answers = array(pick(row, 'answers')).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 4);
    if (question && answers.length >= 2) out.push({ question, answers });
  }
  return out;
}

/**
 * B6: a first version's plan, or null: at most five bullets. #4488: or a
 * complicated change's, with the spec version it asks about. Until 20 Oct
 * 2026 both were dropped here, so the card's note never showed and it could
 * not show its plan (request #5580's card).
 */
function normalizePlan(input: unknown): HomeroomBotPlan | null {
  const row = record(input);
  const bullets = array(pick(row, 'bullets')).filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 5);
  if (!bullets.length) return null;
  const plan: HomeroomBotPlan = { bullets, questions: normalizePlanQuestions(pick(row, 'questions')) };
  if (pick(row, 'complicated') !== true) return plan;
  const spec = record(pick(row, 'spec'));
  const sessionId = strictId(pick(spec, 'sessionId'));
  const version = strictId(pick(spec, 'version'));
  return { ...plan, complicated: true, ...(sessionId && version ? { spec: { sessionId, version } } : {}) };
}

/**
 * B7: what happens next to a change its person approved, from a ready
 * card's metadata or the vote's own answer (services/homeroom-bot-dm.js
 * goesLiveAfterYes), or null for anything else.
 */
export function normalizeGoesLive(input: unknown): HomeroomBotGoesLive | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const row = record(input);
  if (pick(row, 'soon') === true) return { soon: true, at: null, missing: 0, waitingOn: [], more: 0 };
  if (pick(row, 'soon') !== false) return null;
  const at = text(pick(row, 'at'));
  return {
    soon: false,
    at: at && Number.isFinite(Date.parse(at)) ? at : null,
    missing: Math.max(Math.floor(Number(pick(row, 'missing')) || 0), 0),
    waitingOn: array(pick(row, 'waitingOn')).filter((u): u is string => typeof u === 'string' && !!u).slice(0, 3),
    more: Math.max(Math.floor(Number(pick(row, 'more')) || 0), 0),
  };
}

/**
 * #3624: the Homeroom bot's structured part of a message (services/
 * conversations.js publicMetadata), field by field like everything else
 * here: its question, the answers to tap and their state. Null for any
 * message without one.
 */
export function normalizeBotMeta(input: unknown): { homeroomBot: HomeroomBotMeta } | null {
  const bot = record(pick(record(input), 'homeroomBot'));
  const kind = text(pick(bot, 'kind'));
  if (!kind) return null;
  const issueNumber = strictId(pick(bot, 'issueNumber'));
  const status = text(pick(bot, 'status'));
  const optional = (key: string) => text(pick(bot, key)) || undefined;
  const answers = array(pick(bot, 'answers')).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 6);
  const actions = normalizeBotActions(pick(bot, 'actions'));
  const actionId = strictId(pick(bot, 'actionId'));
  const plan = normalizePlan(pick(bot, 'plan'));
  const questions = normalizePlanQuestions(pick(bot, 'questions'));
  const choices = array(pick(bot, 'choices')).filter((c): c is string => typeof c === 'string').slice(0, 2);
  const readyRow = pick(bot, 'ready');
  // What does not work yet, when its before & after shots showed a change failing.
  const broken = readyRow && typeof readyRow === 'object'
    ? array(pick(record(readyRow), 'broken')).filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 3)
    : [];
  // How many more approvals it needed, and in all, when it was sent: absent on older cards.
  const missing = readyRow && typeof readyRow === 'object' ? countOf(pick(record(readyRow), 'missing')) : null;
  const needed = readyRow && typeof readyRow === 'object' ? countOf(pick(record(readyRow), 'needed')) : null;
  const ready = readyRow && typeof readyRow === 'object' ? {
    group: pick(record(readyRow), 'group') === true,
    last: pick(record(readyRow), 'last') === true,
    waitingOn: array(pick(record(readyRow), 'waitingOn')).filter((u): u is string => typeof u === 'string' && !!u).slice(0, 3),
    more: Math.max(Number(pick(record(readyRow), 'more')) || 0, 0),
    ...(missing !== null ? { missing } : {}),
    ...(needed !== null ? { needed } : {}),
    ...(broken.length ? { broken } : {}),
  } : null;
  const goesLive = normalizeGoesLive(pick(bot, 'goesLive'));
  // C2.4: the project a design's card offers to make, and what it made.
  const makeRow = record(pick(bot, 'makeProject'));
  const makeRoot = strictId(pick(makeRow, 'rootId'));
  const makeName = text(pick(makeRow, 'name')).slice(0, 60);
  const makeProject = makeRoot && makeName
    ? { name: makeName, rootId: makeRoot, version: strictId(pick(makeRow, 'version')) } : null;
  return {
    homeroomBot: {
      kind,
      appSlug: optional('appSlug'),
      appName: optional('appName'),
      ...(strictId(pick(bot, 'designVersion')) ? { designVersion: strictId(pick(bot, 'designVersion'))! } : {}),
      designTitle: optional('designTitle'),
      // 1 Nov 2026: a thread about a request or a change is named by it.
      ...(['request', 'change'].includes(String(pick(bot, 'aboutKind'))) && strictId(pick(bot, 'aboutNumber'))
        ? { aboutKind: String(pick(bot, 'aboutKind')) as 'request' | 'change', aboutNumber: strictId(pick(bot, 'aboutNumber'))! }
        : {}),
      aboutTitle: optional('aboutTitle'),
      ...(['fix', 'add', 'design', 'project'].includes(String(pick(bot, 'changeKind'))) ? { changeKind: String(pick(bot, 'changeKind')) as HomeroomBotMeta['changeKind'] } : {}),
      ...(issueNumber ? { issueNumber } : {}),
      issueTitle: optional('issueTitle'),
      ...(pick(bot, 'firstVersion') === true ? { firstVersion: true } : {}),
      ...(pick(bot, 'mirrors') === true ? { mirrors: true } : {}),
      question: optional('question'),
      ...(answers.length ? { answers } : {}),
      ...(BOT_QUESTION_STATES.has(status) ? { status: status as HomeroomBotMeta['status'] } : {}),
      answer: optional('answer'),
      link: optional('link'),
      ...(actionId ? { actionId } : {}),
      ...(actions.length ? { actions } : {}),
      chosen: optional('chosen'),
      startedAt: optional('startedAt'),
      askedText: optional('askedText'),
      changeTitle: optional('changeTitle'),
      hello: optional('hello'),
      ...(pick(bot, 'live') === true ? { live: true } : {}),
      // B6: a plan, or two questions at once, and how its buttons went.
      ...(plan ? { plan } : {}),
      ...(questions.length > 1 ? { questions, lead: optional('lead') } : {}),
      ...(pick(bot, 'replaced') === true ? { replaced: true } : {}),
      ...(pick(bot, 'stopped') === true ? { stopped: true } : {}),
      ...(pick(bot, 'changing') === true ? { changing: true } : {}),
      ...(choices.length ? { choices } : {}),
      // B7: a change ready to try, drawn as its card.
      ...(ready ? { ready } : {}),
      ...(strictId(pick(bot, 'sessionId')) ? { sessionId: strictId(pick(bot, 'sessionId'))! } : {}),
      ...(Number.isInteger(pick(bot, 'epoch')) ? { epoch: Number(pick(bot, 'epoch')) } : {}),
      ...(pick(bot, 'updated') === true ? { updated: true } : {}),
      // B6: a card Build it moved under its plan.
      ...(strictId(pick(bot, 'movedTo')) ? { movedTo: strictId(pick(bot, 'movedTo'))! } : {}),
      ...(goesLive ? { goesLive } : {}),
      // Why its buttons were closed, said in their place.
      ...(text(pick(bot, 'closedWhy')) ? { closedWhy: text(pick(bot, 'closedWhy')).slice(0, 120) } : {}),
      // One request, one story: the thread it is in, the moment it rings
      // as, and the names its label and its push use.
      ...(strictId(pick(bot, 'threadRootId')) ? { threadRootId: strictId(pick(bot, 'threadRootId'))! } : {}),
      moment: optional('moment'),
      said: optional('said'),
      requestTitle: optional('requestTitle'),
      waiting: optional('waiting'),
      ...(countOf(pick(bot, 'count')) !== null ? { count: countOf(pick(bot, 'count'))! } : {}),
      ...(pick(bot, 'alsoInChat') === true ? { alsoInChat: true } : {}),
      ...(makeProject ? { makeProject } : {}),
      madeSlug: optional('madeSlug'),
      madeName: optional('madeName'),
      // Homeroom bot parity (P1-P9): the reply's card, as the server stored it
      // (./bot-cards/ reads each type's own fields defensively).
      ...(normalizeBotCard(pick(bot, 'card')) ? { card: normalizeBotCard(pick(bot, 'card'))! } : {}),
      // Homeroom bot parity, P1: what the reply looked at (./bot-looked.tsx).
      ...(normalizeBotLooked(pick(bot, 'looked')) ? { looked: normalizeBotLooked(pick(bot, 'looked'))! } : {}),
    },
  };
}

/**
 * Homeroom bot parity, P1: what a reply looked at, when it says: at most 20
 * things, each a line of words, and how long it took. Null for none.
 */
export function normalizeBotLooked(input: unknown): HomeroomBotLooked | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const items = array(pick(record(input), 'items'))
    .map((item) => text(pick(record(item), 'what')).replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 20)
    .map((what) => ({ what }));
  if (!items.length) return null;
  const ms = Number(pick(record(input), 'ms'));
  return { items, ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null };
}

/** Homeroom bot parity (P1-P9): a card, when it is one: a plain object with a string type. */
export function normalizeBotCard(input: unknown): HomeroomBotCard | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const type = (input as { type?: unknown }).type;
  if (typeof type !== 'string' || !/^[a-z_]{1,40}$/.test(type)) return null;
  return input as HomeroomBotCard;
}

/**
 * Homeroom bot parity (P1-P9): a tap on a card the bot put under a reply,
 * decided on the server (services/homeroom-bot-cards/). Throws with the
 * server's words when it was refused.
 */
export async function cardAction(messageId: number, action: string, value?: unknown): Promise<Record<string, unknown>> {
  return record(await request<unknown>(`/api/conversations/homeroom-bot/cards/${messageId}`, {
    method: 'POST', body: JSON.stringify(value === undefined ? { action } : { action, value }),
  }));
}

export function normalizeMember(input: unknown): ConversationMember {
  const row = record(input);
  const user = normalizeUser(record(pick(row, 'user') ?? row));
  const status = text(pick(row, 'status', 'membershipStatus', 'membership_status'));
  const role = text(pick(row, 'role', 'memberRole', 'member_role'));
  return {
    ...user,
    role: role === 'owner' ? 'owner' : 'member',
    status: ['invited', 'declined', 'left', 'removed'].includes(status)
      ? status as ConversationMember['status']
      : 'member',
    joinedAt: text(pick(row, 'joinedAt', 'joined_at')) || null,
  };
}

function normalizeReaction(input: unknown): MessageReaction {
  const row = record(input);
  return {
    emoji: text(pick(row, 'emoji', 'reaction')),
    count: Number(pick(row, 'count', 'total')) || 0,
    reacted: bool(pick(row, 'reacted', 'mine', 'hasReacted', 'has_reacted')),
    users: array(pick(row, 'users', 'usernames')).map((name) => text(name)).filter(Boolean),
  };
}

function normalizeAttachment(input: unknown, conversationId: number): MessageAttachment {
  const row = record(input);
  const rawId = text(pick(row, 'id', 'attachmentId', 'attachment_id')).toLowerCase();
  const id = /^[a-f0-9]{32}$/.test(rawId) ? rawId : '';
  const base = `/api/conversations/${conversationId}/attachments/${id}`;
  const rawViewUrl = pick(row, 'viewUrl', 'view_url');
  return {
    id,
    name: text(pick(row, 'name', 'filename', 'originalName', 'original_name'), 'attachment'),
    size: Number(pick(row, 'size', 'sizeBytes', 'size_bytes')) || 0,
    contentType: text(pick(row, 'contentType', 'content_type', 'mimeType', 'mime_type'), 'application/octet-stream'),
    kind: text(pick(row, 'kind', 'fileKind', 'file_kind')) || null,
    url: text(pick(row, 'url', 'downloadUrl', 'download_url'), base),
    // A deliberate null means the backend judged this attachment unsafe to
    // render inline. Never fabricate a preview URL in that case.
    viewUrl: rawViewUrl === null ? null : text(rawViewUrl) || `${base}/view`,
  };
}

function normalizeObject(input: unknown): SharedObjectCard {
  const row = record(input);
  const ref = record(pick(row, 'reference', 'ref') ?? row);
  const type = text(pick(ref, 'type', 'kind')) as SharedObjectCard['type'];
  return {
    type: ['app', 'issue', 'proposal', 'governance', 'spec', 'hub', 'discussion'].includes(type) ? type : 'app',
    appId: strictId(pick(ref, 'appId', 'app_id')) || undefined,
    appSlug: text(pick(ref, 'appSlug', 'app_slug')) || undefined,
    issueNumber: strictId(pick(ref, 'issueNumber', 'issue_number')) || undefined,
    sessionId: strictId(pick(ref, 'sessionId', 'session_id')) || undefined,
    prNumber: strictId(pick(ref, 'prNumber', 'pr_number')) || undefined,
    proposalId: strictId(pick(ref, 'proposalId', 'proposal_id', 'governanceId', 'governance_id')) || undefined,
    version: strictId(pick(ref, 'version', 'specVersion', 'spec_version')) || undefined,
    available: pick(row, 'available') !== false && !bool(pick(row, 'unavailable')),
    title: text(pick(row, 'title', 'name')) || null,
    subtitle: text(pick(row, 'subtitle', 'appName', 'app_name')) || null,
    state: text(pick(row, 'state', 'status')) || null,
    author: text(pick(row, 'author', 'username')) || null,
    href: text(pick(row, 'href', 'url', 'webPath', 'web_path')) || null,
    // An app's or a community's own icon (services/shared-objects.js appIcon).
    iconUrl: appIconUrl(pick(row, 'iconUrl')),
    iconEmoji: text(pick(row, 'iconEmoji')) || null,
  };
}

/** A thread's summary on the message it hangs off, or null when it has no replies. */
export function normalizeThreadSummary(input: unknown): MessageThreadSummary | null {
  if (!input || typeof input !== 'object') return null;
  const row = record(input);
  const replyCount = Number(pick(row, 'replyCount', 'reply_count')) || 0;
  if (replyCount < 1) return null;
  const last = pick(row, 'lastReply', 'last_reply');
  const lastRow = last && typeof last === 'object' ? record(last) : null;
  const lastId = lastRow ? strictId(pick(lastRow, 'id')) : null;
  return {
    replyCount,
    lastReplyAt: dateText(pick(row, 'lastReplyAt', 'last_reply_at')),
    participants: array(pick(row, 'participants')).map(normalizeUser).filter((user) => user.id).slice(0, 3),
    lastReply: lastRow && lastId ? {
      id: lastId,
      sender: normalizeUser(pick(lastRow, 'sender') ?? {
        id: pick(lastRow, 'userId', 'user_id'), username: pick(lastRow, 'username'),
      }),
      content: text(pick(lastRow, 'content')),
      createdAt: dateText(pick(lastRow, 'createdAt', 'created_at')),
    } : null,
  };
}

/** A reply's thread root, as the main stream's line names it (#2387 follow-up). */
export function normalizeThreadRoot(input: unknown): ThreadRootRef | null {
  if (!input || typeof input !== 'object') return null;
  const row = record(input);
  const id = strictId(pick(row, 'id'));
  if (!id) return null;
  return {
    id,
    senderUsername: text(pick(row, 'senderUsername', 'sender_username', 'username')) || t('messages:api.deletedUser'),
    content: text(pick(row, 'content')),
    deleted: pick(row, 'deleted') === true,
  };
}

export function normalizeMessage(input: unknown, fallbackConversationId = 0): ConversationMessage {
  const row = record(input);
  const conversationId = strictId(pick(row, 'conversationId', 'conversation_id')) || fallbackConversationId;
  const senderSource = pick(row, 'sender', 'user', 'author') ?? {
    id: pick(row, 'senderId', 'sender_id', 'userId', 'user_id'),
    username: pick(row, 'senderUsername', 'sender_username', 'username'),
    avatarUrl: pick(row, 'senderAvatarUrl', 'sender_avatar_url', 'avatar_url'),
  };
  const replyRow = record(pick(row, 'reply', 'replyTo', 'reply_to'));
  const replyId = strictId(pick(replyRow, 'id', 'messageId', 'message_id'));
  const botMeta = normalizeBotMeta(pick(row, 'metadata'));
  const designPin = normalizeDesignPin(pick(record(pick(row, 'metadata')), 'designPin'));
  return {
    id: strictId(pick(row, 'id', 'messageId', 'message_id')) || 0,
    conversationId,
    sender: normalizeUser(senderSource),
    content: text(pick(row, 'content', 'text')),
    createdAt: dateText(pick(row, 'createdAt', 'created_at')),
    editedAt: text(pick(row, 'editedAt', 'edited_at')) || null,
    reply: replyId ? {
      id: replyId,
      sender: normalizeUser(pick(replyRow, 'sender', 'user', 'author') ?? replyRow),
      content: text(pick(replyRow, 'content', 'text')),
      deleted: pick(replyRow, 'deleted') === true,
    } : null,
    deleted: pick(row, 'deleted') === true,
    threadRootId: strictId(pick(row, 'threadRootId', 'thread_root_id')),
    threadRoot: normalizeThreadRoot(pick(row, 'threadRoot', 'thread_root')),
    thread: normalizeThreadSummary(pick(row, 'thread')),
    reactions: array(pick(row, 'reactions')).map(normalizeReaction).filter((reaction) => reaction.emoji),
    attachments: array(pick(row, 'attachments')).map((attachment) => normalizeAttachment(attachment, conversationId)),
    objects: array(pick(row, 'objects', 'objectCards', 'object_cards', 'sharedObjects', 'shared_objects')).map(normalizeObject),
    // This normalizer builds an explicit object rather than spreading the row,
    // so a field the server adds is DROPPED until it is named here — which is
    // exactly what happened to `saved` the first time: the API returned it,
    // the star rendered empty, and nothing anywhere errored.
    saved: pick(row, 'saved', 'bookmarked') === true,
    // #3624: the Homeroom bot's question and its answers, when it has one.
    // #6071: a person's comment pinned on a design carries its point.
    ...(botMeta || designPin ? { metadata: { ...(botMeta || {}), ...(designPin ? { designPin } : {}) } } : {}),
  };
}

/** #6071: a design pin as the server sends it, or null. */
export function normalizeDesignPin(input: unknown): DesignPin | null {
  const row = record(input);
  const version = strictId(pick(row, 'version'));
  const x = Number(pick(row, 'x'));
  const y = Number(pick(row, 'y'));
  if (!version || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
  const el = record(pick(row, 'element'));
  const element = { tag: text(pick(el, 'tag')).slice(0, 30), id: text(pick(el, 'id')).slice(0, 60), text: text(pick(el, 'text')).slice(0, 80) };
  return { version, x, y, ...(element.tag || element.text ? { element } : {}) };
}

export function normalizeConversation(input: unknown): ConversationDetail {
  const row = record(input);
  const id = strictId(pick(row, 'id', 'conversationId', 'conversation_id')) || 0;
  const members = array(pick(row, 'members', 'participants')).map(normalizeMember);
  const rawKind = text(pick(row, 'kind', 'type'));
  // #2783: `channel` is #general — a room everybody is in.
  const kind = rawKind === 'group' ? 'group' : rawKind === 'channel' ? 'channel' : 'direct';
  const peerRaw = pick(row, 'peer', 'otherUser', 'other_user', 'recipient');
  const peer = peerRaw ? normalizeUser(peerRaw) : null;
  const membershipStatus = text(pick(row, 'membershipStatus', 'membership_status', 'myStatus', 'my_status', 'status'));
  const latestRaw = pick(row, 'latestMessage', 'latest_message', 'lastMessage', 'last_message');
  const latestMessage = latestRaw ? normalizeMessage(latestRaw, id) : null;
  // What it is called: its own title, or in a direct conversation the other
  // person. With neither, `title` is a stand-in to show where a name would be,
  // and `untitled` tells a sentence to use its own wording, not that word.
  const named = text(pick(row, 'title', 'name'))
    || (kind === 'direct' ? peer?.username || members.find((member) => member.status === 'member')?.username : '')
    || '';
  const title = named || t('messages:api.conversationTitle');
  const canSendValue = pick(row, 'canSend', 'can_send');
  const homeroomBot = kind === 'direct' && pick(row, 'homeroomBot') === true;
  const summary = plainText(text(pick(row, 'latestSummary', 'latest_summary', 'preview')) || latestMessage?.content || '');
  return {
    id,
    kind,
    title,
    untitled: !named,
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || peer?.avatarUrl || null,
    members,
    memberCount: Number(pick(row, 'memberCount', 'member_count')) || members.filter((member) => member.status === 'member').length,
    membershipStatus: ['invited', 'declined', 'left', 'removed'].includes(membershipStatus)
      ? membershipStatus as ConversationDetail['membershipStatus']
      : 'member',
    myRole: text(pick(row, 'myRole', 'my_role', 'role')) === 'owner' ? 'owner' : 'member',
    requester: pick(row, 'requester', 'inviter') ? normalizeUser(pick(row, 'requester', 'inviter')) : null,
    // #3228: the inviter's note, on the invitation only (the server returns
    // null everywhere else).
    inviteNote: text(pick(row, 'inviteNote', 'invite_note')) || null,
    peer,
    latestMessage,
    // One line of plain text: the row is a preview, not the message, and a
    // bot message's `**Project**` should not show its asterisks. The
    // Homeroom bot's row leaves out the request's number (botRowPreview).
    latestSummary: homeroomBot ? botRowPreview(summary) : summary,
    lastActivityAt: dateText(pick(row, 'lastActivityAt', 'last_activity_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at')),
    unreadCount: Number(pick(row, 'unreadCount', 'unread_count')) || 0,
    lastReadMessageId: readCursor(pick(row, 'lastReadMessageId', 'last_read_message_id')),
    awaitingAcceptance: kind === 'direct' && pick(row, 'awaitingAcceptance', 'awaiting_acceptance') === true,
    canSend: typeof canSendValue === 'boolean' ? canSendValue : membershipStatus !== 'invited',
    canInvite: bool(pick(row, 'canInvite', 'can_invite'), kind === 'group' && membershipStatus !== 'invited'),
    canManage: bool(pick(row, 'canManage', 'can_manage'), text(pick(row, 'myRole', 'my_role', 'role')) === 'owner'),
    archived: bool(pick(row, 'archived')) || text(pick(row, 'status')) === 'archived',
    channelKey: kind === 'channel' ? text(pick(row, 'channelKey', 'channel_key')) || null : null,
    ...(homeroomBot ? { homeroomBot: true } : {}),
  };
}

function demoQuery(path: string): string {
  if (typeof window === 'undefined') return path;
  if (new URLSearchParams(window.location.search).get('demo') !== '1') return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

/**
 * How a read is asked for (#3705, #3706). `fresh` is a read made because
 * something CHANGED — a realtime event, a send settling, a reconnect — and it
 * needs the server's answer, not the service worker's.
 *
 * The worker answers an ordinary GET /api/* from its offline copy once the
 * network has taken a second (public/sw.js, API_TIMEOUT_MS). For a read like
 * this one that copy is the transcript from BEFORE the change: the message the
 * event announced is missing, and the store, taking the page as the server's
 * word, dropped the sender's own just-confirmed row with it. The Homeroom
 * bot's DM is where it showed, because its page is the slowest to answer.
 *
 * `cache: 'no-store'` is the worker's existing "leave this to the network"
 * signal: its fetch handler returns before classifying such a request.
 *
 * Opening a conversation reads fresh too while the browser is online
 * (#4243): its offline copy was the last visit's transcript, drawn for a
 * moment before the newest messages snapped in. The open takes the ordinary
 * read, and with it the offline copy, only when the browser is offline or
 * the fresh read failed (store.ts loadThread).
 */
export interface ReadOptions {
  fresh?: boolean;
}

function readInit(options?: ReadOptions): RequestInit {
  return options?.fresh ? { cache: 'no-store' } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
  }
  headers.set('Accept', 'application/json');
  const response = await fetch(demoQuery(path), { credentials: 'same-origin', ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = record(data);
    // #5104: the person takes new conversations and invitations only from
    // people in projects with them. Said in the screen's own words.
    if (pick(body, 'code') === 'contact_restricted') {
      throw new MessagesApiError(response.status, t('messages:api.contactRestricted'));
    }
    throw new MessagesApiError(response.status, text(pick(body, 'error', 'message'), t('messages:api.requestFailed', { status: response.status })));
  }
  return data as T;
}

export async function listConversations(options?: ReadOptions): Promise<ConversationSummary[]> {
  const data = record(await request<unknown>('/api/conversations', readInit(options)));
  return array(pick(data, 'conversations', 'items')).map(normalizeConversation).filter((item) => item.id);
}

export async function getConversation(id: number, options?: ReadOptions): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`, readInit(options)));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

// #3361: the `@` list for a conversation whose roster the client does not
// hold — a channel, whose members the server counts rather than loads. A
// username prefix in, at most `limit` people out (friends first, then whoever
// spoke there last), from exactly the people who can read the room.
export async function getMentionCandidates(id: number, prefix: string, limit = 8): Promise<ConversationUser[]> {
  const q = encodeURIComponent(prefix.slice(0, 64));
  const data = record(await request<unknown>(`/api/conversations/${id}/mention-candidates?q=${q}&limit=${limit}`));
  return array(pick(data, 'users')).map(normalizeUser).filter((user) => user.id);
}

export async function createConversation(body: { kind: 'direct'; userId: number } | { kind: 'group'; title: string; memberIds: number[]; inviteNote?: string }): Promise<ConversationDetail> {
  const payload = body.kind === 'direct'
    ? { kind: 'direct', user_id: body.userId }
    : { kind: 'group', title: body.title, member_ids: body.memberIds, invite_note: body.inviteNote };
  const data = record(await request<unknown>('/api/conversations', { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function updateConversation(id: number, body: { title: string }): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function respondToInvitation(id: number, action: 'accept' | 'decline'): Promise<ConversationDetail | null> {
  const data = record(await request<unknown>(`/api/conversations/${id}/respond`, { method: 'POST', body: JSON.stringify({ action }) }));
  const raw = pick(data, 'conversation');
  if (raw === null || (action === 'decline' && raw === undefined)) return null;
  const conversation = normalizeConversation(raw ?? data);
  return conversation.id ? conversation : null;
}

export async function addMembers(id: number, userIds: number[], inviteNote?: string): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}/members`, { method: 'POST', body: JSON.stringify({ user_ids: userIds, invite_note: inviteNote }) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function removeMember(id: number, userId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/members/${userId}`, { method: 'DELETE' });
}

export async function leaveConversation(id: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/leave`, { method: 'POST', body: '{}' });
}

export async function listMessages(id: number, before?: number | null, options?: ReadOptions, limit = 50): Promise<{ messages: ConversationMessage[]; nextBefore: number | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`, readInit(options)));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
  };
}

export async function sendMessage(id: number, input: { content: string; replyToId?: number; threadRootId?: number; attachmentIds?: string[]; object?: SharedObjectReference; idempotencyKey: string; designPin?: DesignPin }): Promise<ConversationMessage> {
  const payload: JsonRecord = { content: input.content, idempotency_key: input.idempotencyKey };
  if (input.designPin) payload.design_pin = input.designPin as unknown as JsonRecord;
  if (input.replyToId) payload.reply_to_id = input.replyToId;
  if (input.threadRootId) payload.thread_root_id = input.threadRootId;
  if (input.attachmentIds?.length) payload.attachment_ids = input.attachmentIds;
  if (input.object) payload.object = input.object;
  const data = record(await request<unknown>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeMessage(pick(data, 'message') ?? data, id);
}

// ── #6071: design threads ─────────────────────────────────────────────────

/** A design thread as its pane reads it (routes/conversations.js). */
export interface DesignThread {
  rootId: number;
  conversationId: number;
  state: string;
  number: number | null;
  app: { slug: string; name: string } | null;
  title: string;
  /** 1 Nov 2026: 'new', a screen of a project not made yet, drawn with the native kit. */
  surface: 'platform' | 'app' | 'new';
  route: string | null;
  width: number;
  height: number;
  latest: number;
  versions: Array<{ version: number; author: string; note: string | null; messageId: number | null }>;
  /** 1 Nov 2026 (C2.2): the open request Propose it posts the plan on (the thread's), or null for a new one. */
  planOn?: number | null;
}

export interface DesignCapture {
  html: string;
  surface: 'platform' | 'app';
  title: string;
  route: string | null;
  appSlug: string | null;
  width: number;
  height: number;
}

const DESIGNS = '/api/conversations/homeroom-bot/designs';

/**
 * #6071 follow-up: make the thread a blank one from Homeroom bot's "+" is
 * about to be, with what its welcome block picked (the project, by slug, or
 * any; the kind of change). Its first message is then sent into it.
 */
export async function startBotThread(input: { project: string | null; kind: string }): Promise<{ conversationId: number; rootId: number }> {
  const data = record(await request<unknown>('/api/conversations/homeroom-bot/new-thread', { method: 'POST', body: JSON.stringify(input) }));
  const rootId = strictId(pick(data, 'rootId'));
  if (!rootId) throw new Error(text(pick(data, 'error')) || 'The thread could not be started');
  return { conversationId: strictId(pick(data, 'conversationId')) || 0, rootId };
}

/** Open a design thread for a captured screen: where it is, to open it. */
export async function startDesign(capture: DesignCapture): Promise<{ conversationId: number; rootId: number; href: string }> {
  const data = record(await request<unknown>(DESIGNS, { method: 'POST', body: JSON.stringify(capture) }));
  return {
    conversationId: strictId(pick(data, 'conversationId')) || 0,
    rootId: strictId(pick(data, 'rootId')) || 0,
    href: text(pick(data, 'href')),
  };
}

export async function getDesign(rootId: number): Promise<DesignThread> {
  const data = record(await request<unknown>(`${DESIGNS}/${rootId}`));
  const app = record(pick(data, 'app'));
  return {
    rootId: strictId(pick(data, 'rootId')) || rootId,
    conversationId: strictId(pick(data, 'conversationId')) || 0,
    state: text(pick(data, 'state')) || 'open',
    number: strictId(pick(data, 'number')),
    app: text(pick(app, 'slug')) ? { slug: text(pick(app, 'slug')), name: text(pick(app, 'name')) || text(pick(app, 'slug')) } : null,
    title: text(pick(data, 'title')),
    surface: pick(data, 'surface') === 'app' ? 'app' : pick(data, 'surface') === 'new' ? 'new' : 'platform',
    route: text(pick(data, 'route')) || null,
    width: Number(pick(data, 'width')) || 1280,
    height: Number(pick(data, 'height')) || 800,
    latest: Number(pick(data, 'latest')) || 0,
    planOn: strictId(pick(data, 'planOn')),
    versions: array(pick(data, 'versions')).map((v) => {
      const row = record(v);
      return {
        version: Number(pick(row, 'version')) || 0,
        author: text(pick(row, 'author')),
        note: text(pick(row, 'note')) || null,
        messageId: strictId(pick(row, 'messageId')),
      };
    }).filter((v) => v.version > 0),
  };
}

export async function getDesignVersion(rootId: number, version: number): Promise<{ version: number; html: string }> {
  const data = record(await request<unknown>(`${DESIGNS}/${rootId}/versions/${version}`));
  return { version: Number(pick(data, 'version')) || version, html: typeof pick(data, 'html') === 'string' ? String(pick(data, 'html')) : '' };
}

export async function proposeDesign(rootId: number, input: { version: number; title: string; notes: string }): Promise<{ number: number | null; href: string; plan: boolean }> {
  const data = record(await request<unknown>(`${DESIGNS}/${rootId}/propose`, { method: 'POST', body: JSON.stringify(input) }));
  return { number: strictId(pick(data, 'number')), href: text(pick(data, 'href')), plan: pick(data, 'plan') !== false };
}

/**
 * The page a message link opens on (#2387): the messages around one, with a
 * cursor each way. When the linked message is a reply inside a thread, the
 * window is around the thread's first message and `focus.threadRootId` names
 * it, so the thread opens beside it.
 */
export async function listMessagesAround(id: number, messageId: number, options?: ReadOptions): Promise<{
  messages: ConversationMessage[];
  nextBefore: number | null;
  nextAfter: number | null;
  focus: { messageId: number; threadRootId: number | null };
}> {
  const params = new URLSearchParams({ limit: '50', around: String(messageId) });
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`, readInit(options)));
  const focus = record(pick(data, 'focus'));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
    nextAfter: strictId(pick(data, 'nextAfter', 'next_after')),
    focus: {
      messageId: strictId(pick(focus, 'messageId', 'message_id')) || messageId,
      threadRootId: strictId(pick(focus, 'threadRootId', 'thread_root_id')),
    },
  };
}

/** The newer half of a linked page: messages after one, oldest first. */
export async function listMessagesAfter(id: number, after: number): Promise<{ messages: ConversationMessage[]; nextAfter: number | null }> {
  const params = new URLSearchParams({ limit: '50', after: String(after) });
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextAfter: strictId(pick(data, 'nextAfter', 'next_after')),
  };
}

/** #5219: one discussion message the thread pane draws beside the DM replies. */
function normalizeDiscussionMessage(input: unknown): DiscussionMessage | null {
  const row = record(input);
  const id = strictId(pick(row, 'id', 'message_id'));
  if (!id) return null;
  return {
    id,
    source: 'discussion',
    sender: normalizeUser(record(pick(row, 'sender'))),
    content: text(pick(row, 'content')),
    createdAt: dateText(pick(row, 'createdAt', 'created_at')),
    ...(text(pick(row, 'editedAt', 'edited_at')) ? { editedAt: text(pick(row, 'editedAt', 'edited_at')) } : {}),
  };
}

/** #5219: a request's public discussion riding its bot-card thread, or null. */
function normalizeDiscussion(input: unknown): DiscussionState | null {
  const row = record(input);
  const appSlug = text(pick(row, 'appSlug', 'app_slug'));
  const issueNumber = strictId(pick(row, 'issueNumber', 'issue_number'));
  if (!appSlug || !issueNumber) return null;
  return {
    appSlug,
    issueNumber,
    more: pick(row, 'more') === true,
    messages: array(pick(row, 'messages')).map(normalizeDiscussionMessage).filter((m): m is DiscussionMessage => !!m),
  };
}

/** A thread: the message it hangs off, and its replies oldest first (#2387). */
export async function listThread(id: number, rootId: number, before?: number | null, options?: ReadOptions): Promise<{
  root: ConversationMessage | null;
  messages: ConversationMessage[];
  nextBefore: number | null;
  discussion: DiscussionState | null;
}> {
  const params = new URLSearchParams({ limit: '50' });
  if (before) params.set('before', String(before));
  const data = record(await request<unknown>(`/api/conversations/${id}/threads/${rootId}?${params}`, readInit(options)));
  const root = pick(data, 'root');
  const discussion = pick(data, 'discussion') === undefined || pick(data, 'discussion') === null
    ? null
    : normalizeDiscussion(pick(data, 'discussion'));
  return {
    root: root ? normalizeMessage(root, id) : null,
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
    discussion,
  };
}

/** Delete your own message (#2387). The server keeps a "deleted" placeholder. */
export async function deleteMessage(conversationId: number, messageId: number): Promise<ConversationMessage | null> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }));
  const raw = pick(data, 'message');
  return raw ? normalizeMessage(raw, conversationId) : null;
}

/** Make this message, and everything after it, unread again (#2387). */
export async function markUnread(conversationId: number, messageId: number): Promise<{ unreadCount: number }> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/unread`, {
    method: 'POST', body: JSON.stringify({ message_id: messageId }),
  }));
  return { unreadCount: Number(pick(data, 'unreadCount', 'unread_count')) || 0 };
}

export async function editMessage(conversationId: number, messageId: number, content: string): Promise<ConversationMessage> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) }));
  return normalizeMessage(pick(data, 'message') ?? data, conversationId);
}

export async function toggleReaction(conversationId: number, messageId: number, emoji: string): Promise<MessageReaction[]> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }));
  return array(pick(data, 'reactions')).map(normalizeReaction);
}

export async function markRead(conversationId: number, messageId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
}

export async function setTyping(conversationId: number, typing: boolean, threadRootId: number | null = null): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/typing`, {
    method: 'POST', body: JSON.stringify({ typing, ...(threadRootId ? { thread_root_id: threadRootId } : {}) }),
  });
}

export async function uploadAttachment(conversationId: number, file: File): Promise<MessageAttachment> {
  const response = await fetch(`/api/conversations/${conversationId}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' }, body: file,
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new MessagesApiError(response.status, text(pick(record(data), 'error', 'message'), t('messages:api.uploadFailed', { status: response.status })));
  return normalizeAttachment(pick(record(data), 'attachment') ?? data, conversationId);
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const data = record(await request<unknown>(`/api/users/search?q=${encodeURIComponent(query.trim().slice(0, 255))}&scope=messages`));
  return array(pick(data, 'users')).map(normalizeUser).filter((user) => user.id);
}

/**
 * The apps the viewer can see, for the Share item dialog. `mine` is a
 * project they are in (its community, or building it), which the dialog
 * lists first.
 */
export async function listApps(): Promise<Array<{ id: number; slug: string; name: string; mine: boolean }>> {
  const data = record(await request<unknown>('/api/apps'));
  return array(pick(data, 'apps')).map((item) => {
    const row = record(item);
    return {
      id: strictId(row.id) || 0, slug: text(row.slug), name: text(row.name, text(row.slug)),
      mine: row.is_member === true || row.is_collaborator === true,
    };
  }).filter((app) => app.id && app.slug);
}

export async function listAppItems(slug: string, type: 'issue' | 'proposal' | 'governance'): Promise<Array<{ id: number; title: string; status?: string }>> {
  const endpoint = type === 'proposal' ? 'promoted' : 'issues';
  const data = record(await request<unknown>(`/api/apps/${encodeURIComponent(slug)}/${endpoint}`));
  const candidates = type === 'proposal'
    ? array(pick(data, 'proposals', 'sessions', 'items'))
    : array(pick(data, 'issues', 'items'));
  return candidates.map((item) => {
    const row = record(item);
    return {
      id: strictId(pick(row, 'number', 'id')) || 0,
      title: text(pick(row, 'title', 'pr_title', 'session_title'), t('messages:api.untitledItem')),
      status: text(pick(row, 'status')) || undefined,
    };
  }).filter((item) => item.id);
}

/**
 * #3660: the cards a message's Homeroom links stand for, as the server
 * resolves them for THIS viewer — one answer per link, in order, and an
 * unavailable one for a page they cannot see. Only the parsed page goes up
 * (./homeroom-links.ts), never the link itself.
 */
export async function resolveLinkCards(links: ReadonlyArray<Pick<HomeroomLink, 'type' | 'appSlug' | 'issueNumber' | 'sessionId' | 'proposalId'> & { prNumber?: number }>): Promise<SharedObjectCard[]> {
  const refs = links.map((link) => ({
    type: link.type,
    app_slug: link.appSlug,
    ...(link.issueNumber ? { issue_number: link.issueNumber } : {}),
    ...(link.sessionId ? { session_id: link.sessionId } : {}),
    ...(link.prNumber ? { pr_number: link.prNumber } : {}),
    ...(link.proposalId ? { proposal_id: link.proposalId } : {}),
  }));
  const data = record(await request<unknown>('/api/link-cards', { method: 'POST', body: JSON.stringify({ refs }) }));
  return array(pick(data, 'cards')).map(normalizeObject);
}

/**
 * #3660: post a message to an app's discussion (its general stream) over
 * the REST twin of the chat socket — the same canonical write
 * (routes/chat.js), for a page that has no socket open to that app.
 */
export async function postAppMessage(slug: string, content: string): Promise<void> {
  await request<unknown>(`/api/apps/${encodeURIComponent(slug)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: content.slice(0, 8000) }),
  });
}

export async function reportMessage(
  conversationId: number,
  messageId: number,
  reason: 'harassment' | 'spam' | 'threats' | 'hate' | 'sexual_content' | 'other',
  detail?: string,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/report`, {
    method: 'POST', body: JSON.stringify({ reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) }),
  });
}

/**
 * Save or unsave one message — the Messages half of the bookmark app group
 * chat has carried since #1280. PUT saves, DELETE unsaves, matching that
 * surface's verbs so the two behave identically.
 */
export async function setMessageSaved(
  conversationId: number,
  messageId: number,
  saved: boolean,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/bookmark`, {
    method: saved ? 'PUT' : 'DELETE', ...(saved ? { body: '{}' } : {}),
  });
}

/**
 * B3: press one of a bot message's `server` buttons. Decided once, by the
 * person it was offered to: a 409 means it was decided already (on another
 * device, say), and the message's own update shows how.
 */
/**
 * B7: Approve, from a change's ready card: the person's own Yes, cast from
 * their own browser on the version the card was sent for, as the change
 * page's vote is. `stale` when that version was replaced (a 409 that says
 * so), with the version it is at now.
 */
/**
 * #5452: a saved Yes belongs in Your votes and the Kudos My history tab.
 * Both listen on the window bridge, so this says the vote landed without
 * this chunk importing the profile screen. Optional at every link: neither
 * listener needs to be up for the Yes itself to be counted.
 */
function announceApprovalVote() {
  (window as any).UsernodeReact?.profileProposals?.voted?.();
  (window as any).Leaderboard?.invalidateHistory?.();
}

export async function approveChange(sessionId: number, epoch: number | null): Promise<{
  ok: boolean; stale: boolean; epoch: number | null; error: string | null;
  /** B7: what happens next, when the Yes settled a ready card of theirs. */
  goesLive?: HomeroomBotGoesLive | null;
}> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(epoch === null ? { vote: 'yes' } : { vote: 'yes', expectedEpoch: epoch }),
    });
  } catch {
    return { ok: false, stale: false, epoch: null, error: t('messages:api.approve.unreachable') };
  }
  const data = record(await response.json().catch(() => ({})));
  // #5452: the Yes now belongs in Your votes and the Kudos My history tab,
  // so tell both through the window bridge, the way the kudos give path
  // does, so this chunk does not pull in the profile screen. Never
  // optimistic: only on the server's yes. Announced ahead of the return so
  // the one-line ok return keeps the shape the B7 check pins.
  if (response.ok) announceApprovalVote();
  if (response.ok) return { ok: true, stale: false, epoch, error: null, goesLive: normalizeGoesLive(pick(data, 'goesLive')) };
  const stale = response.status === 409 && pick(data, 'headChanged') === true;
  const next = Number.isInteger(pick(data, 'approvalEpoch')) ? Number(pick(data, 'approvalEpoch')) : null;
  // #5506: a Yes from someone who does not build on the project, said in
  // words of the card's own, not the guard's.
  if (response.status === 403 && pick(data, 'code') === 'collab_required') {
    return { ok: false, stale: false, epoch: null, error: t('messages:api.approve.notBuilder') };
  }
  return { ok: false, stale, epoch: next, error: stale ? null : (text(pick(data, 'message')) || text(pick(data, 'error')) || t('messages:api.approve.failed')) };
}

/**
 * #5506: Withdraw it, from a ready card: the bot withdraws its change, if
 * the reader asked for it or owns its project and it is still up for a vote
 * (routes/conversations.js). `error` is what to say when it was not.
 */
export async function withdrawChange(sessionId: number): Promise<{ ok: boolean; error: string | null }> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/homeroom-bot/withdraw/${sessionId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    return { ok: false, error: t('messages:api.withdraw.unreachable') };
  }
  if (response.ok) return { ok: true, error: null };
  const data = record(await response.json().catch(() => ({})));
  return { ok: false, error: text(pick(data, 'error')) || t('messages:api.withdraw.failed') };
}

export async function decideBotAction(actionId: number, choice: string, answers?: string[]): Promise<{ label: string | null }> {
  // B6: Build it under a plan carries the answers tapped, in order.
  const data = record(await request<unknown>(`/api/conversations/homeroom-bot/actions/${actionId}`, {
    method: 'POST', body: JSON.stringify(answers ? { choice, answers } : { choice }),
  }));
  return { label: text(pick(data, 'label')) || null };
}

/**
 * Run six: whether the signed-in person is told when their first version of
 * `slug` is ready and live (on from Make it), and turning it on or off.
 * Null when it is not their first version.
 */
export async function getFirstVersionNotify(slug: string): Promise<boolean | null> {
  try {
    const data = record(await request<unknown>(`/api/conversations/homeroom-bot/first-versions/${encodeURIComponent(slug)}/notify`));
    return bool(pick(data, 'on'), true);
  } catch (err) {
    if (err instanceof MessagesApiError && err.status === 404) return null;
    throw err;
  }
}

export async function setFirstVersionNotify(slug: string, on: boolean): Promise<boolean> {
  const data = record(await request<unknown>(`/api/conversations/homeroom-bot/first-versions/${encodeURIComponent(slug)}/notify`, {
    method: 'PUT', body: JSON.stringify({ on }),
  }));
  return bool(pick(data, 'on'), on);
}

/** B8: the signed-in person's chat with Homeroom bot, made the first time. */
export async function openBotConversation(): Promise<number | null> {
  const data = record(await request<unknown>('/api/conversations/homeroom-bot', { method: 'POST', body: '{}' }));
  return strictId(pick(data, 'conversationId')) || null;
}

export async function setBlock(userId: number, blocked: boolean): Promise<void> {
  await request<unknown>(`/api/me/blocks/${userId}`, { method: blocked ? 'PUT' : 'DELETE', ...(blocked ? { body: '{}' } : {}) });
}

export async function listBlocks(): Promise<ConversationUser[]> {
  const data = record(await request<unknown>('/api/me/blocks'));
  return array(pick(data, 'blocks', 'users')).map((entry) => {
    const row = record(entry);
    return normalizeUser(pick(row, 'user', 'blockedUser', 'blocked_user') ?? row);
  }).filter((user) => user.id);
}

const ACTIVITY_OUTCOMES = new Set<HomeroomBotActivityOutcome>([
  'question', 'proposed', 'live', 'closed', 'blocked', 'build_failed',
  'person', 'empty', 'failed', 'held', 'stopped', 'answer', 'revise',
  'checking', 'needs_look', 'going_live',
]);

/** An in-app address (`#app/…`), or null: a card's link never leaves the shell. */
function inAppHref(value: unknown): string | null {
  const href = text(value);
  return href.startsWith('#app/') ? href : null;
}

/** #4201: an app's icon as the platform serves it (`/app-icons/<id>`), or null. */
function appIconUrl(value: unknown): string | null {
  const src = text(value);
  return /^\/app-icons\/[\w-]+$/.test(src) ? src : null;
}

const BOT_PHASES = new Set<HomeroomBotPhase>([
  'setting_up', 'queued', 'looking', 'building', 'follow_up_queued', 'following_up', 'merging',
]);

/**
 * #3692: who one of the Homeroom bot's tray entries is about, and where it
 * opens, field by field. Every address is kept only when it is one of the
 * platform's own in-app addresses (`#app/…`): the tray draws them as links,
 * and a link it draws never leaves the shell. An earlier run with an
 * unknown ending reads as one that stopped, as a card's does.
 */
function normalizeBotJob(row: JsonRecord): HomeroomBotJob {
  const links = record(pick(row, 'links'));
  const appSlug = text(pick(row, 'appSlug')) || null;
  const issueNumber = strictId(pick(row, 'issueNumber'));
  const firstVersion = pick(row, 'firstVersion') === true;
  const named = text(pick(row, 'appName')) || appSlug;
  return {
    key: text(pick(row, 'key')) || `${appSlug || ''}#${issueNumber || 'first'}`,
    appSlug,
    appName: named || t('messages:bot.job.unnamedProject'),
    // A slug is the project's own address and names it; only the stand-in is unnamed.
    appUnnamed: !named,
    iconUrl: appIconUrl(pick(row, 'iconUrl')),
    iconEmoji: text(pick(row, 'iconEmoji')) || null,
    issueNumber,
    title: text(pick(row, 'title')) || null,
    firstVersion,
    href: inAppHref(pick(row, 'href')),
    links: {
      request: inAppHref(pick(links, 'request')),
      proposal: inAppHref(pick(links, 'proposal')),
      project: inAppHref(pick(links, 'project')),
    },
    earlier: array(pick(row, 'earlier')).map((entry) => {
      const run = record(entry);
      const outcome = text(pick(run, 'outcome')) as HomeroomBotActivityOutcome;
      return {
        id: strictId(pick(run, 'id')) || 0,
        outcome: ACTIVITY_OUTCOMES.has(outcome) ? outcome : 'stopped',
        at: text(pick(run, 'at')) || null,
      };
    }).filter((run) => run.id),
    ...threadFieldsOf(row),
  };
}

const ASK_KINDS = new Set([
  'question', 'followup_ask', 'plan', 'person', 'blocked', 'empty', 'build_failed', 'checks', 'needs_look', 'first_version_failed',
]);
const JOB_STOP_CAUSES = new Set(['time', 'restart', 'restarts', 'no_change', 'unproposed', 'no_start', 'other']);

/**
 * One request, one story: where a tray entry's request is in the chat with
 * the bot (services/homeroom-bot-tray.js threadsOf), field by field: its
 * card (`cardId`), its newest message waiting on the person (`ask`, a known
 * kind only) and its newest ready card (`ready`).
 */
function threadFieldsOf(row: JsonRecord): Pick<HomeroomBotJob, 'cardId' | 'ask' | 'ready' | 'stopCause'> {
  const cardId = strictId(pick(row, 'cardId'));
  const askRow = pick(row, 'ask');
  const ask = askRow && typeof askRow === 'object' ? record(askRow) : null;
  const askKind = ask ? text(pick(ask, 'kind')) : '';
  const readyRow = pick(row, 'ready');
  const ready = readyRow && typeof readyRow === 'object' ? record(readyRow) : null;
  const stopCause = text(pick(row, 'stopCause'));
  return {
    ...(cardId ? { cardId } : {}),
    ...(ask && ASK_KINDS.has(askKind) ? {
      ask: {
        messageId: strictId(pick(ask, 'messageId')),
        kind: askKind,
        ...(text(pick(ask, 'said')) ? { said: text(pick(ask, 'said')).slice(0, 40) } : {}),
        ...(text(pick(ask, 'question')) ? { question: text(pick(ask, 'question')).slice(0, 300) } : {}),
      },
    } : {}),
    ...(ready ? {
      ready: {
        messageId: strictId(pick(ready, 'messageId')),
        sessionId: strictId(pick(ready, 'sessionId')),
        epoch: Number.isInteger(pick(ready, 'epoch')) ? Number(pick(ready, 'epoch')) : 0,
        open: pick(ready, 'open') === true,
        approve: pick(ready, 'approve') === true,
        waiting: text(pick(ready, 'waiting')).slice(0, 120) || null,
      },
    } : {}),
    ...(JOB_STOP_CAUSES.has(stopCause) ? { stopCause: stopCause as HomeroomBotJob['stopCause'] } : {}),
  };
}

/** A past entry (Needs you or History). One without a known ending says what waits instead, or is dropped. */
function normalizeBotPastJob(entry: unknown): HomeroomBotPastJob | null {
  const row = record(entry);
  const outcome = text(pick(row, 'outcome')) as HomeroomBotActivityOutcome;
  const known = ACTIVITY_OUTCOMES.has(outcome);
  const doing = text(pick(row, 'doing')) || null;
  if (!known && !doing && !outcome) return null;
  const release = outcome === 'going_live' ? releaseOf(pick(row, 'release')) : null;
  return {
    ...normalizeBotJob(row),
    ...(release ? { release } : {}),
    id: strictId(pick(row, 'id')) || 0,
    outcome: known ? outcome : (outcome ? 'failed' : null),
    doing,
    at: text(pick(row, 'at')) || null,
  };
}

export function normalizeBotWork(input: unknown): HomeroomBotWork {
  const data = record(input);
  const now = array(pick(data, 'now')).map((entry) => {
    const row = record(entry);
    const phase = text(pick(row, 'phase')) as HomeroomBotPhase;
    const step = strictId(pick(row, 'step'));
    const of = strictId(pick(row, 'of'));
    const whole = !!step && !!of && step <= of && of <= 12;
    // A merge of Homeroom itself going live: when its release comes.
    const release = phase === 'merging' ? releaseOf(pick(row, 'release')) : null;
    return {
      ...normalizeBotJob(row),
      ...(release ? { release } : {}),
      phase: BOT_PHASES.has(phase) ? phase : 'looking',
      ...(/^[a-z_]{1,40}$/.test(text(pick(row, 'stage'))) ? { stage: text(pick(row, 'stage')) } : {}),
      step: whole ? step : null,
      of: whole ? of : null,
      stepName: whole ? text(pick(row, 'stepName')) || null : null,
      doing: text(pick(row, 'doing')) || null,
      since: text(pick(row, 'since')) || null,
    };
  });
  const past = (key: string) => array(pick(data, key)).map(normalizeBotPastJob)
    .filter((job): job is HomeroomBotPastJob => !!job);
  const tracks = pick(data, 'tracks');
  return {
    now, needsYou: past('needsYou'), history: past('history'),
    ...(Array.isArray(tracks) ? { tracks: tracks.map(normalizeBotTrack).filter((track): track is BotTrack => !!track) } : {}),
  };
}

const TRACK_STATES = new Set<BotTrackState>([
  'queued', 'planning', 'waiting', 'building', 'checks', 'vote', 'going_live', 'live', 'held', 'stopped', 'done_elsewhere', 'closed',
]);
const TRACK_STEPS = new Set<BotTrackStep>(['plan', 'build', 'checks', 'vote', 'live']);
const CODE = /^[a-z_]{1,40}$/;

/**
 * 16 Oct 2026: one request's track (services/homeroom-bot-track.js), field
 * by field. Null for one in a state the client does not know, which it
 * then draws nowhere rather than guessing at.
 */
export function normalizeBotTrack(input: unknown): BotTrack | null {
  const row = record(input);
  const state = text(pick(row, 'state')) as BotTrackState;
  if (!TRACK_STATES.has(state)) return null;
  const job = normalizeBotJob(row);
  const step = text(pick(row, 'step')) as BotTrackStep;
  const why = text(pick(row, 'why'));
  const waitingOn = text(pick(row, 'waitingOn'));
  const held = record(pick(row, 'held'));
  const queue = record(pick(row, 'queue'));
  const doneBy = record(pick(row, 'doneBy'));
  const tries = strictId(pick(row, 'try')) || 1;
  const release = state === 'going_live' ? releaseOf(pick(row, 'release')) : null;
  return {
    key: job.key,
    appSlug: job.appSlug,
    appName: job.appName,
    ...(job.appUnnamed ? { appUnnamed: true } : {}),
    iconUrl: job.iconUrl,
    iconEmoji: job.iconEmoji,
    issueNumber: job.issueNumber,
    title: job.title,
    firstVersion: job.firstVersion,
    state,
    step: TRACK_STEPS.has(step) ? step : null,
    why: CODE.test(why) ? why : null,
    waitingOn: waitingOn === 'you' || waitingOn === 'group' ? waitingOn : null,
    ...(waitingOn === 'you' && text(pick(row, 'waitingFor')) ? { waitingFor: text(pick(row, 'waitingFor')).slice(0, 64) } : {}),
    busy: bool(pick(row, 'busy')),
    try: Math.min(tries, 99),
    tryStartedAt: text(pick(row, 'tryStartedAt')) || null,
    tryStarts: array(pick(row, 'tryStarts')).map((at) => text(at)).filter(Boolean).slice(0, 20),
    since: text(pick(row, 'since')) || null,
    rootId: strictId(pick(row, 'rootId')),
    askId: strictId(pick(row, 'askId')),
    proposalId: strictId(pick(row, 'proposalId')),
    sessionId: strictId(pick(row, 'sessionId')),
    links: job.links,
    ...(state === 'held' ? {
      held: {
        limit: CODE.test(text(pick(held, 'limit'))) ? text(pick(held, 'limit')) : 'slots',
        position: strictId(pick(held, 'position')),
        until: text(pick(held, 'until')) || null,
        ...(text(pick(held, 'limit')) === 'taken' ? { by: text(pick(held, 'by')) || null } : {}),
      },
    } : {}),
    ...(state === 'queued' && pick(queue, 'ahead') !== undefined ? { queue: { ahead: Math.max(0, Number(pick(queue, 'ahead')) || 0) } } : {}),
    ...(state === 'done_elsewhere' && pick(row, 'doneBy') ? {
      doneBy: { username: text(pick(doneBy, 'username')) || null, prNumber: strictId(pick(doneBy, 'prNumber')) },
    } : {}),
    ...(release ? { release } : {}),
  };
}

function normalizeSlotEntry(input: unknown): BotSlotEntry {
  const row = record(input);
  const kind = text(pick(row, 'kind'));
  const trial = text(pick(row, 'trial'));
  return {
    ...(kind === 'proposal' || kind === 'build' || kind === 'queued' || kind === 'older' ? { kind } : {}),
    ...(CODE.test(trial) ? { trial } : {}),
    issueNumber: strictId(pick(row, 'issueNumber')),
    title: text(pick(row, 'title')) || null,
    askedBy: text(pick(row, 'askedBy')) || null,
    excerpt: text(pick(row, 'excerpt')).slice(0, 200) || null,
    by: text(pick(row, 'by')) || null,
    position: strictId(pick(row, 'position')),
    limit: CODE.test(text(pick(row, 'limit'))) ? text(pick(row, 'limit')) : null,
    since: text(pick(row, 'since')) || null,
    until: text(pick(row, 'until')) || null,
    track: pick(row, 'track') ? normalizeBotTrack(pick(row, 'track')) : null,
  };
}

/** A project's bot slots view, field by field (services/homeroom-bot-track.js slotsView). */
export function normalizeBotSlots(input: unknown): BotSlotsView | null {
  const view = record(pick(record(input), 'slots'));
  const app = record(pick(view, 'app'));
  const slug = text(pick(app, 'slug'));
  if (!slug) return null;
  const week = record(pick(view, 'week'));
  const share = Number(pick(week, 'usedShare'));
  return {
    app: { slug, name: text(pick(app, 'name')) || slug },
    botOn: bool(pick(view, 'botOn')),
    acts: bool(pick(view, 'acts')),
    paused: bool(pick(view, 'paused')),
    cap: strictId(pick(view, 'cap')) || 5,
    buildsAtOnce: strictId(pick(view, 'buildsAtOnce')),
    slots: array(pick(view, 'slots')).map(normalizeSlotEntry).slice(0, 50),
    waiting: array(pick(view, 'waiting')).map(normalizeSlotEntry).slice(0, 100),
    taken: array(pick(view, 'taken')).map(normalizeSlotEntry).slice(0, 100),
    onHold: array(pick(view, 'onHold')).map(normalizeSlotEntry).slice(0, 100),
    waitingOn: array(pick(view, 'waitingOn')).map(normalizeSlotEntry).slice(0, 100),
    upNext: array(pick(view, 'upNext')).map(normalizeSlotEntry).slice(0, 100),
    stopped: array(pick(view, 'stopped')).map(normalizeSlotEntry).slice(0, 100),
    leftToPeople: array(pick(view, 'leftToPeople')).map(normalizeSlotEntry).slice(0, 100),
    withPeople: Math.max(0, Math.floor(Number(pick(view, 'withPeople')) || 0)),
    reading: Math.max(0, Number(pick(view, 'reading')) || 0),
    week: pick(view, 'week') ? {
      limited: bool(pick(week, 'limited')),
      usedShare: Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : null,
      usedUp: bool(pick(week, 'usedUp')),
      resetsAt: text(pick(week, 'resetsAt')) || null,
    } : null,
  };
}

/**
 * 16 Oct 2026: a project's bot slots, for the page under its Workshop. The
 * staging demo's `?demo=1` rides on every read already (demoQuery); adding
 * it here too sent it twice, which the server reads as a list, not '1'.
 */
export async function getBotSlots(slug: string): Promise<BotSlotsView | null> {
  const path = `/api/apps/${encodeURIComponent(slug)}/homeroom-bot/slots`;
  return normalizeBotSlots(await request<unknown>(path, readInit({ fresh: true })));
}

/**
 * #3692: what the Homeroom bot is doing for the signed-in person, what waits
 * on them, and what it did before. #8 (WP3): a re-read after news passes
 * `fresh`, as the activity cards' does: it was the one read of the bot's
 * that never did, so a slow answer was the worker's offline copy, and the
 * header said "Working on…" for work long finished (see ReadOptions).
 */
export async function getHomeroomBotWork(options?: ReadOptions): Promise<HomeroomBotWork> {
  return normalizeBotWork(await request<unknown>('/api/conversations/homeroom-bot/work', readInit(options)));
}

/**
 * #3736: the state of the activity cards in the bot's DM, field by field.
 * A card without a message id is dropped; a step is kept only as a whole
 * "N of M"; an unknown state or outcome reads as a piece of work that
 * stopped, never as one still going.
 */
const STOP_CAUSES = new Set(['time', 'restart', 'restarts', 'no_change', 'unproposed', 'no_start', 'other']);
const HELD_BY = new Set(['proposals_per_app', 'proposals_total', 'questions_per_day']);

export function normalizeBotActivity(input: unknown): HomeroomBotActivity[] {
  return array(pick(record(input), 'cards')).map((entry): HomeroomBotActivity | null => {
    const row = record(entry);
    const messageId = strictId(pick(row, 'messageId'));
    if (!messageId) return null;
    const links = record(pick(row, 'links'));
    const step = strictId(pick(row, 'step'));
    const of = strictId(pick(row, 'of'));
    const whole = !!step && !!of && step <= of && of <= 12;
    const working = text(pick(row, 'state')) === 'working';
    const outcome = text(pick(row, 'outcome')) as HomeroomBotActivityOutcome;
    const typical = record(pick(row, 'typicalMinutes'));
    const from = strictId(pick(typical, 'from'));
    const to = strictId(pick(typical, 'to'));
    const workedFrom = text(pick(row, 'workedFrom'));
    const waitedFor = text(pick(row, 'waitedFor'));
    // A merge of Homeroom itself going live: when its release comes.
    const release = !working && outcome === 'going_live' ? releaseOf(pick(row, 'release')) : null;
    return {
      messageId,
      state: working ? 'working' : 'done',
      startedAt: text(pick(row, 'startedAt')) || null,
      // The work's own start, never a date that does not read as one.
      workedFrom: workedFrom && Number.isFinite(Date.parse(workedFrom)) ? workedFrom : null,
      ...(waitedFor === 'first_version' || waitedFor === 'turn' ? { waitedFor } : {}),
      links: { request: inAppHref(pick(links, 'request')), proposal: inAppHref(pick(links, 'proposal')) },
      step: working && whole ? step : null,
      of: working && whole ? of : null,
      stepName: working ? text(pick(row, 'stepName')) || null : null,
      doing: working ? text(pick(row, 'doing')) || null : null,
      outcome: working ? null : (ACTIVITY_OUTCOMES.has(outcome) ? outcome : 'stopped'),
      endedAt: working ? null : text(pick(row, 'endedAt')) || null,
      // Whole minutes, the shorter first, and under two hours.
      ...(working && from && to && from <= to && to <= 120 ? { typicalMinutes: { from, to } } : {}),
      // Who the work waits on while it waits (`them`: the viewer), so the card can say it needs them.
      ...(working && text(pick(row, 'waitingOn')) ? { waitingOn: text(pick(row, 'waitingOn')).slice(0, 40) } : {}),
      // The stage it is at while it works (`on_hold`: until Monday), a short word.
      ...(working && /^[a-z_]{1,40}$/.test(text(pick(row, 'stage'))) ? { stage: text(pick(row, 'stage')) } : {}),
      // Why a build stopped, and which limit holds a request back: known words only.
      ...(!working && outcome === 'build_failed' && STOP_CAUSES.has(text(pick(row, 'stopCause')))
        ? { stopCause: text(pick(row, 'stopCause')) as HomeroomBotActivity['stopCause'] } : {}),
      ...(!working && outcome === 'held' && HELD_BY.has(text(pick(row, 'heldBy')))
        ? { heldBy: text(pick(row, 'heldBy')) as HomeroomBotActivity['heldBy'] } : {}),
      ...(release ? { release } : {}),
    };
  }).filter((card): card is HomeroomBotActivity => !!card);
}

const READY_NOW_STATES = new Set<HomeroomBotReadyNow['state']>(['open', 'going_live', 'live', 'closed']);

/**
 * 5 October: the bot DM's ready cards as their changes stand now (services/
 * homeroom-bot-dm.js readyStates), field by field. One without a message id
 * or with a state not known here is dropped: its card says what it was sent
 * with. Counts are whole and not below zero; names are strings.
 */
export function normalizeBotReadyNow(input: unknown): HomeroomBotReadyNow[] {
  return array(pick(record(input), 'ready')).map((entry): HomeroomBotReadyNow | null => {
    const row = record(entry);
    const messageId = strictId(pick(row, 'messageId'));
    const state = text(pick(row, 'state')) as HomeroomBotReadyNow['state'];
    if (!messageId || !READY_NOW_STATES.has(state)) return null;
    const approvalRow = pick(row, 'approval');
    const approval = approvalRow && typeof approvalRow === 'object' && !Array.isArray(approvalRow) ? record(approvalRow) : null;
    const missing = approval ? countOf(pick(approval, 'missing')) : null;
    const needed = approval ? countOf(pick(approval, 'needed')) : null;
    const goesLive = normalizeGoesLive(pick(row, 'goesLive'));
    // A merge of Homeroom itself going live: when its release comes.
    const release = state === 'going_live' ? releaseOf(pick(row, 'release')) : null;
    return {
      messageId,
      state,
      // Only the live card's button, which opens the app.
      actions: state === 'live' ? normalizeBotActions(pick(row, 'actions')).filter((action) => action.type === 'open') : [],
      ...(state === 'open' && approval && missing !== null && needed !== null ? {
        approval: {
          missing,
          needed,
          last: pick(approval, 'last') === true,
          approved: pick(approval, 'approved') === true,
          waitingOn: array(pick(approval, 'waitingOn')).filter((u): u is string => typeof u === 'string' && !!u).slice(0, 3),
          more: Math.max(Math.floor(Number(pick(approval, 'more')) || 0), 0),
        },
      } : {}),
      ...(state === 'open' && goesLive ? { goesLive } : {}),
      ...(release ? { release } : {}),
      // #5506: what the reader can do on a card still up for approval.
      ...(state === 'open' && typeof pick(row, 'canBuild') === 'boolean' ? { canBuild: pick(row, 'canBuild') === true } : {}),
      ...(state === 'open' && pick(row, 'canWithdraw') === true ? { canWithdraw: true } : {}),
    };
  }).filter((entry): entry is HomeroomBotReadyNow => !!entry);
}

/**
 * #3736: how far along each activity card in the signed-in person's bot DM
 * is, and (5 October) where each of its ready cards' changes stands now. A
 * re-read after news passes `fresh`, so the worker's offline copy of an
 * older state never stands in for it (see ReadOptions).
 */
export async function getHomeroomBotActivity(options?: ReadOptions): Promise<HomeroomBotActivityRead> {
  const data = await request<unknown>('/api/conversations/homeroom-bot/activity', readInit(options));
  return { cards: normalizeBotActivity(data), ready: normalizeBotReadyNow(data) };
}

/**
 * The bot's DM opened: any of the signed-in person's work the bot has under
 * way without an activity card gets one, sent by the server at the end of
 * the DM (services/homeroom-bot-activity.js catchUpCards). The request names
 * nothing. How many cards it added.
 */
export async function catchUpHomeroomBotActivity(): Promise<number> {
  const data = record(await request<unknown>('/api/conversations/homeroom-bot/activity', { method: 'POST', body: '{}' }));
  const added = Number(pick(data, 'added'));
  return Number.isSafeInteger(added) && added > 0 ? added : 0;
}
