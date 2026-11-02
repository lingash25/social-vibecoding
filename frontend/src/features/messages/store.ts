import { useSyncExternalStore } from 'react';

import { t } from '../../lib/i18n/runtime';
import { botTabAddress, botTabFromMessages, goBotAddress, knownBotConversation, noteBotConversation, openBotTab } from '../ai/door';
import { navStore } from '../nav/nav-store.js';
import { messagesDrawerApplies } from '../nav-drawer/messages-drawer';
import * as api from './api';
import { WORK_CHANGED_EVENT, inMainStream, openAppTarget, threadsAllowed } from './bot-shared';
import { channelDirectory, normalizeHandle, type ChannelRef } from './channels';
import { platformHubServed, platformSlug, subscribePlatformSlug } from './channel-hub';
import { type AppDiscussion, type InboxSection } from './inbox';
import { openRequestPage, requestPageOf, type RequestPage } from './request-page';
import { markFor } from './unread-anchor';
import type {
  ConversationDetail,
  DiscussionContext,
  ConversationEvent,
  ConversationMessage,
  ConversationSummary,
  HomeroomBotAction,
  MessagesAgentThread,
  MessagesSnapshot,
  ReplyThreadState,
  SharedObjectReference,
  StagedObject,
} from './types';

const MAX_ID = 2_147_483_647;

interface PendingSend {
  content: string;
  replyToId?: number;
  /** #2387: a reply inside this thread rather than the conversation's own transcript. */
  threadRootId?: number;
  attachmentIds?: string[];
  object?: SharedObjectReference;
  idempotencyKey: string;
}

/**
 * A name on the typing line. The line shows each name once, as it always has:
 * two people shown by the same word are one entry, and that word leaves when
 * either of them stops (see `typingHolders`). `unnamed` says the word is only
 * the stand-in for a member with no username; it is worked out from who is
 * typing under the word now, so it leaves with that person.
 */
export interface Typist {
  name: string;
  unnamed: boolean;
  /**
   * 1 Nov 2026: the Homeroom bot, whose typing is drawn as its working card
   * at the transcript's foot (./bot-working.tsx), not as a name on the line.
   */
  bot?: boolean;
  /** What the bot says it is doing now (its typing event's `doing`); null while it thinks. */
  doing?: BotDoing | null;
}

/**
 * 1 Nov 2026: what the Homeroom bot is doing as it answers, as its typing
 * event carries it (services/homeroom-bot-dm.js typingDoing): a kind and
 * what it names. The words are this screen's (./bot-working.tsx).
 */
export interface BotDoing {
  kind: string;
  number?: number;
  project?: string;
  /** Homeroom bot parity, P1: the answer so far, while it is written (kind 'writing'). */
  text?: string;
}

/** The longest answer-so-far a working card shows (the server sends its newest 1800 characters). */
export const MAX_BOT_DRAFT_CHARS = 2000;

/** The `doing` of a typing event, or null: only a kind word, a request number, a short name, and the answer being written. */
export function botDoingOf(raw: unknown): BotDoing | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = typeof value.kind === 'string' && /^[a-z_]{1,32}$/.test(value.kind) ? value.kind : null;
  if (!kind) return null;
  const number = Number(value.number);
  const project = typeof value.project === 'string' ? value.project.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const text = kind === 'writing' && typeof value.text === 'string' ? value.text.trim().slice(-MAX_BOT_DRAFT_CHARS) : '';
  return {
    kind,
    ...(Number.isSafeInteger(number) && number > 0 ? { number } : {}),
    ...(project ? { project } : {}),
    ...(text ? { text } : {}),
  };
}

interface InternalState extends MessagesSnapshot {
  // By composer scope (scopeKey): a conversation's main stream under its id,
  // a thread under `<id>:t<root>` (31 Oct 2026: typing in a thread is drawn
  // in that thread's pane).
  typing: Record<ComposerScope, Typist[]>;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: InternalState = {
  route: { open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null },
  conversations: [],
  active: null,
  messages: [],
  loadingList: false,
  loadingThread: false,
  loadingOlder: false,
  listLoaded: false,
  error: null,
  threadError: null,
  threadGone: null,
  nextBefore: null,
  online: true,
  demo: false,
  revision: 0,
  typing: {},
  discussions: [],
  discussionsLoaded: false,
  discussionContext: null,
  discussionError: null,
  folded: [],
  thread: null,
  nextAfter: null,
  listCollapsed: false,
  showMoreChannels: false,
  unreadMark: null,
  threadFocusId: null,
};

/*
 * DRAFTS AND STAGED REPLIES ARE PER COMPOSER, not per conversation (#2387):
 * a conversation's own composer and the composer of a thread open beside it
 * each keep their own half-typed words and their own quoted reply. A scope is
 * the conversation id alone, or `<id>:t<root>` for a thread — the first is the
 * key the drafts were always stored under, so existing drafts survive.
 */
export type ComposerScope = number | string;
export function scopeKey(conversationId: number, threadRootId?: number | null): ComposerScope {
  return threadRootId ? `${conversationId}:t${threadRootId}` : conversationId;
}
function scopeConversation(scope: ComposerScope): number {
  return typeof scope === 'number' ? scope : Number(String(scope).split(':')[0]);
}
function scopeThread(scope: ComposerScope): number | null {
  if (typeof scope === 'number') return null;
  const match = /:t(\d+)$/.exec(scope);
  return match ? Number(match[1]) : null;
}

const drafts = new Map<ComposerScope, string>();
const replyTargets = new Map<ComposerScope, ConversationMessage>();
const pendingByConversation = new Map<number, PendingSend[]>();
/*
 * THE SENDER'S OWN ROWS OUTLIVE A REFRESH (#2907). A send draws its message
 * at once, faded, and nothing else: no spinner, no "sending…" line. The
 * realtime echo of that same send re-reads the thread, and the page it reads
 * back must not take the row away (it is still in flight) nor draw it twice
 * (the server already has it). `unsent` holds each local row's payload by its
 * client key — what a failed row's Retry sends again, under the same
 * idempotency key so the server never stores it twice — and `sentKeys` maps a
 * confirmed server id back to the client key the row was drawn under, so the
 * row keeps its React key and is updated in place rather than remounted.
 * `after` is the newest server id the transcript held when the row was drawn:
 * the server's copy of that send can only be newer (withLocalRows).
 */
const unsent = new Map<string, { conversationId: number; payload: PendingSend; after: number }>();
const sentKeys = new Map<number, string>();
const typingSentAt = new Map<ComposerScope, number>();
const typingExpiry = new Map<string, number>();
/**
 * #4220: a "stopped typing" that waits for its message. The bot sends its
 * message and then stops typing (services/homeroom-bot-dm.js whileTyping),
 * but realtime carries ids only, so the message shows once the re-read it
 * started publishes, and in the bot's DM that read is the slow one: the line
 * went away and the conversation sat still before the answer came. So while
 * a re-read for a new message is in flight in a conversation (`landing`, by
 * how many), a stop there holds its name (`heldTyping`, by the typingExpiry
 * key) until that read publishes, and never longer than TYPING_HOLD_MS.
 */
const landing = new Map<number, number>();
const heldTyping = new Map<string, { conversationId: number; scope: ComposerScope; shown: string }>();
/**
 * Who is typing under each shown word: `conversationId:word` to user id to
 * whether that person has no username. The word is the stand-in only while
 * everybody typing under it is nameless; one real account makes it a name.
 * Emptied when the word leaves the line, so nothing outlives the person.
 */
const typingHolders = new Map<string, Map<number, boolean>>();
const TYPING_HOLD_MS = 5000;
let pendingShare: SharedObjectReference | null | undefined;
/**
 * A change the change page's Ask for changes put straight on the chat with
 * Homeroom bot's composer (see openBot), for that conversation only.
 */
let pendingAttach: { conversationId: number; object: StagedObject; placeholder: string } | null = null;
/** A `#messages/channel/<handle>` link followed before the lists landed. */
let pendingChannel: string | null = null;
let listRequest = 0;
let threadRequest = 0;
let replyThreadRequest = 0;
/**
 * The conversation the viewer just marked unread (#2387), which stays unread
 * while it is still the open one: opening a thread normally reads it to the
 * end, and doing that here would undo the act a second after it was done.
 * Leaving the conversation lifts it.
 */
let unreadHold: number | null = null;

function browserDemo(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === '1';
}

function publish(next: Partial<InternalState>): void {
  state = { ...state, ...next, revision: state.revision + 1 };
  for (const listener of [...listeners]) listener();
  if (next.conversations || next.discussions || next.route || next.active) syncTabBadge();
}

/**
 * The Messages tab's badge (#2794): how many conversations have something
 * unread, i.e. how many rows on this screen draw a count.
 *
 * Derived here, from every write to `conversations`, rather than from each
 * caller, because every path that changes an unread count already ends in
 * one: the boot load, a socket event's reload, markRead's local zeroing, a
 * leave or a block. The nav store drops a patch that changes nothing, so the
 * common case — a reload with the same unread rows — notifies no one.
 */
function syncTabBadge(): void {
  // A CHANNEL IS A COMMUNITY'S, NOT MESSAGES'. #general is Homeroom's
  // channel and every project's channel lives on its hub, so a channel with
  // something unread counts on the Communities tab and Messages counts the
  // people and group chats alone. Only your own communities' channels count
  // there — the `more` rows are apps you were merely active in.
  //
  // #6019: THE HOMEROOM BOT'S CHAT IS THE AI TAB'S, not Messages': its row
  // left this list, so its unread counts on AI, and the AI tab is the one
  // lit while it is the conversation on screen.
  const botId = state.conversations.find((item) => item.homeroomBot && item.kind !== 'channel')?.id
    || (state.active?.homeroomBot ? state.active.id : null);
  navStore.set({
    messages: state.conversations
      .filter((item) => item.kind !== 'channel' && !item.homeroomBot && item.unreadCount > 0).length,
    communities: state.conversations.filter((item) => item.kind === 'channel' && item.unreadCount > 0).length
      + state.discussions.filter((item) => item.section !== 'more' && (item.unreadCount || 0) > 0).length,
    ai: Math.max(0, Number(state.conversations.find((item) => item.homeroomBot && item.kind !== 'channel')?.unreadCount) || 0),
    bot: !!state.route.open && !!botId && state.route.conversationId === botId,
  });
}

/**
 * Unread messages in a project's channel, for its row on the Communities
 * screen: the app's own discussion, or #general for Homeroom's own row
 * (`selfHosted`), whose channel it is. Zero when nothing is known.
 */
export function channelUnread(slug: string, selfHosted = false): number {
  if (selfHosted) {
    const general = state.conversations.find((item) => item.kind === 'channel' && item.channelKey === 'general');
    return general ? general.unreadCount || 0 : 0;
  }
  const row = state.discussions.find((item) => item.slug === slug);
  return row ? row.unreadCount || 0 : 0;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): InternalState {
  return state;
}

export function useMessagesSnapshot(): InternalState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function sortConversations(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((a, b) => {
    const time = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    return time || b.id - a.id;
  });
}

function upsertConversation(conversation: ConversationSummary): void {
  leftConversations.delete(conversation.id);
  const items = state.conversations.filter((item) => item.id !== conversation.id);
  items.push(conversation);
  const active = state.active?.id === conversation.id
    ? { ...state.active, ...conversation }
    : state.active;
  publish({ conversations: sortConversations(items), active });
}

function currentUser(): { id: number; username: string; avatarUrl?: string | null } {
  const user = typeof window !== 'undefined' ? window.App?.user : null;
  return {
    id: Number(user?.id) || 0,
    username: typeof user?.username === 'string' ? user.username : t('messages:store.you'),
    avatarUrl: typeof user?.avatarUrl === 'string' ? user.avatarUrl : null,
  };
}

/**
 * QA 2026-09-24 Q2: the server's answer to a second message into a direct
 * request the other person has not accepted yet (409 `awaiting_acceptance`).
 */
function isAwaitingAcceptance(error: unknown): boolean {
  return error instanceof api.MessagesApiError && error.status === 409 && error.message === 'awaiting_acceptance';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof api.MessagesApiError) {
    if (isAwaitingAcceptance(error)) return t('messages:store.error.awaitingAcceptance');
    if (error.status === 404) return t('messages:store.error.gone');
    if (error.status === 429) return t('messages:store.error.tooFast');
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The sections that can fold from their headings: the bot's never does. */
/**
 * The sections that fold from their heading: Agents alone. People is the
 * list's last section, so folding it saved no scrolling (16 Oct 2026).
 */
export const FOLDABLE: ReadonlyArray<InboxSection> = ['agents'];

/** Pure: the folded sections a saved value names, ignoring anything else. */
export function savedFolded(raw: string | null | undefined): InboxSection[] {
  const names = String(raw || '').split(',');
  return FOLDABLE.filter((section) => names.includes(section));
}

/**
 * Fold a section of the list away from its heading, or open it again (16
 * Oct 2026), remembered per device. Presentation, so not in the route; a
 * fresh device starts with everything open.
 */
export function setSectionFolded(section: InboxSection, folded: boolean): void {
  if (!FOLDABLE.includes(section)) return;
  const next = FOLDABLE.filter((name) => (name === section ? folded : state.folded.includes(name)));
  if (next.length === state.folded.length && next.every((name) => state.folded.includes(name))) return;
  try { localStorage.setItem('usernode:messages-folded', next.join(',')); } catch { /* storage unavailable */ }
  publish({ folded: next });
}

/**
 * The channels the viewer can name — #general and their apps' (#2783).
 *
 * Memoised on the two arrays it is built from, so a caller that asks on
 * every render (a transcript row, the legacy app chat) gets the same object
 * until one of them actually changes.
 */
let directoryCache: { conversations: unknown; discussions: unknown; value: ChannelRef[] } | null = null;
export function channels(): ChannelRef[] {
  if (!directoryCache || directoryCache.conversations !== state.conversations
      || directoryCache.discussions !== state.discussions) {
    directoryCache = {
      conversations: state.conversations,
      discussions: state.discussions,
      value: channelDirectory(state.conversations, state.discussions),
    };
  }
  return directoryCache.value;
}

/** The handles alone, for the renderers that chip `#name`. */
export function useChannelHandles(): ReadonlySet<string> {
  useMessagesSnapshot();
  const list = channels();
  return handleSetFor(list);
}
const handleSets = new WeakMap<ChannelRef[], ReadonlySet<string>>();
function handleSetFor(list: ChannelRef[]): ReadonlySet<string> {
  let set = handleSets.get(list);
  if (!set) { set = new Set(list.map((item) => item.handle)); handleSets.set(list, set); }
  return set;
}

/**
 * Follow a `#handle` link: `#messages/channel/<handle>` becomes the address
 * of the channel it names, in place (the link's own entry is replaced, so
 * Back does not bounce through it).
 *
 * The lists may not have landed yet — a chip clicked in an app's chat on a
 * cold Messages store — so an unknown handle waits for both reads and then
 * resolves, or falls back to the bare inbox when nothing answers to it.
 */
export function openChannel(raw: string): void {
  if (typeof window === 'undefined') return;
  const handle = normalizeHandle(raw);
  if (!handle) { window.location.replace('#messages'); return; }
  pendingChannel = handle;
  void loadConversations();
  void loadAppDiscussions();
  resolvePendingChannel();
}

/**
 * The address a `#handle` names, when the lists already know it — the
 * router follows it at once rather than drawing the inbox on the way
 * (#3653) — or null, and openChannel waits for the lists.
 */
export function channelTarget(raw: string): string | null {
  const handle = normalizeHandle(raw);
  if (!handle) return null;
  return channels().find((item) => item.handle === handle)?.target || null;
}

/**
 * #3653: A CHANNEL IS ITS COMMUNITY'S DISCUSSION TAB, #general included.
 *
 * #general is a conversation of this store, of kind `channel`, and the
 * Homeroom community's room: Homeroom's Discussion tab draws it in place
 * (EmbeddedConversation, #3494). Its address here, `#messages/<id>` (and a
 * thread or a message in it), is what its notifications, message links and
 * `#general` references open — and they opened it on this screen, with a
 * chevron up to the hub, a page apart from the community it belongs to.
 *
 * The project whose tab it is: the platform's, once anything has said its
 * slug (channelHub's answer). Null for any other conversation, while nothing
 * knows the conversation is a channel or the platform's slug, and for a
 * viewer the platform's page is not served to, whose room stays here.
 */
export function channelHubSlug(conversationId: number): string | null {
  if (!validId(conversationId) || typeof window === 'undefined') return null;
  const row = state.active && state.active.id === conversationId
    ? state.active
    : state.conversations.find((item) => item.id === conversationId) || null;
  if (!row || row.kind !== 'channel' || !platformHubServed()) return null;
  return platformSlug();
}

/**
 * The conversation on this screen turned out to be a channel (its detail or
 * the list landed, or the platform's slug did): take the reader to its tab,
 * at the thread or the message the address named, replacing the address
 * (App.openDiscussionInHub). The router does the same at once when it
 * already knows; this is a cold link's half.
 */
function channelToHub(): boolean {
  if (typeof window === 'undefined' || !state.route.open || state.route.embedded) return false;
  const conversationId = state.route.conversationId;
  if (!conversationId) return false;
  const hub = channelHubSlug(conversationId);
  const door = (window as { App?: { openDiscussionInHub?: (slug: string, target: unknown) => void } }).App?.openDiscussionInHub;
  if (!hub || !door) return false;
  // Only from this conversation's own address: a route that has already
  // moved on is not this redirect's to take.
  if (!new RegExp(`^#messages/${conversationId}(?:/|$)`).test(window.location.hash)) return false;
  door(hub, {
    conversationId,
    threadRootId: state.route.threadRootId,
    focusMessageId: state.route.focusMessageId,
  });
  return true;
}

/**
 * The person's chat with Homeroom bot, when anything has said which it is:
 * the list, the conversation on screen, or the bot tab that opened it.
 */
function botConversationId(): number | null {
  return state.conversations.find((item) => item.homeroomBot && item.kind !== 'channel')?.id
    || (state.active?.homeroomBot && state.active.kind !== 'channel' ? state.active.id : null)
    || knownBotConversation();
}

/**
 * 1 Nov 2026: the conversation on this screen turned out to be the chat with
 * Homeroom bot (its detail or the list landed), which is its tab's alone
 * (../ai/door.ts): take the reader there, at the thread or the message the
 * address named, replacing the address. The router does the same at once
 * when it already knows; this is a cold link's half, as channelToHub is.
 */
function botToTab(): boolean {
  if (typeof window === 'undefined' || !state.route.open || state.route.embedded) return false;
  const conversationId = state.route.conversationId;
  if (!conversationId || conversationId !== botConversationId()) return false;
  if (!new RegExp(`^#messages/${conversationId}(?:/|$)`).test(window.location.hash)) return false;
  const href = botTabAddress({ threadRootId: state.route.threadRootId, focusMessageId: state.route.focusMessageId });
  try {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${href}`);
  } catch {
    window.location.replace(href);
    return true;
  }
  (window as { App?: { restoreFromHash?: () => void } }).App?.restoreFromHash?.();
  return true;
}

function resolvePendingChannel(): void {
  if (!pendingChannel || typeof window === 'undefined') return;
  const found = channels().find((item) => item.handle === pendingChannel);
  if (found) {
    pendingChannel = null;
    window.location.replace(found.target);
    return;
  }
  if (state.listLoaded && state.discussionsLoaded) {
    pendingChannel = null;
    window.location.replace('#messages');
  }
}

/**
 * The app discussions beside the conversations.
 *
 * FAILS QUIETLY. The conversations are this screen's reason to exist and the
 * discussions are an addition to it; a list that refuses to draw because a
 * second request failed is worse than one that draws what it has. The Apps
 * filter then shows nothing, which is the honest report of what arrived.
 */
export async function loadAppDiscussions(): Promise<void> {
  try {
    const query = browserDemo() ? '?demo=1' : '';
    const response = await fetch(`/api/messages/app-discussions${query}`);
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.discussions)) return;
    publish({ discussions: data.discussions as AppDiscussion[], discussionsLoaded: true });
  } catch {
    // Offline is a state, not a crash.
  } finally {
    // A failed read still settles a waiting `#handle`: it falls back to the
    // inbox rather than leaving the link going nowhere.
    if (pendingChannel && !state.discussionsLoaded) publish({ discussionsLoaded: true });
    resolvePendingChannel();
  }
}

export async function loadConversations(force = false): Promise<void> {
  // A forced reconciliation must supersede an older request. This matters
  // after block/removal: the pre-revocation response may still contain the
  // now-inaccessible direct conversation and must never win the race.
  if (state.loadingList && !force) return;
  if (state.listLoaded && !force) return;
  const request = ++listRequest;
  publish({ loadingList: true, error: null, demo: browserDemo() });
  try {
    // A forced read follows a change, so it asks the server (api.ts ReadOptions).
    const conversations = await api.listConversations({ fresh: force });
    if (request !== listRequest) return;
    for (const item of conversations) leftConversations.delete(item.id);
    publish({
      conversations: sortConversations(conversations),
      loadingList: false,
      listLoaded: true,
      online: true,
    });
    noteBotConversation(conversations.find((item) => item.homeroomBot && item.kind !== 'channel')?.id);
    resolvePendingChannel();
    channelToHub();
    botToTab();
  } catch (error) {
    if (request !== listRequest) return;
    publish({
      loadingList: false,
      listLoaded: true,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      error: errorMessage(error, t('messages:store.error.loadList')),
    });
    resolvePendingChannel();
  }
}

/**
 * The message link whose window has been read (#2387). The link's message
 * anchors the FIRST read of the conversation only: every later refresh — the
 * realtime echo of a message or a reaction — keeps the window the reader is
 * on now (`reading` below), or the present once they have reached it.
 * Anchoring each refresh on the link snapped a reader who had paged on back
 * to it, and dropped their own new message outside the window.
 */
let focusLoaded: number | null = null;

/**
 * The newest message of the conversation itself on screen — the read cursor's
 * position. Since the #2387 follow-up the main stream also carries its
 * threads' replies as lines, and a reply is no position in it: the server
 * reads a thread when handed one, and leaves the cursor where it was. One
 * request, one story: a moment the chat with Homeroom bot also lists in its
 * main stream (`alsoInChat`) is a position in it, as the server counts it.
 */
function newestMainId(messages: ConversationMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.id > 0 && inMainStream(item)) return item.id;
  }
  return null;
}

/** Server rows by id; local rows (negative ids) after them, in the order sent. */
function transcriptOrder(a: ConversationMessage, b: ConversationMessage): number {
  return a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id;
}

/**
 * Conversations the viewer left in this tab (QA 2026-09-24 Q16). Their
 * addresses are still in the history, so Back after Leave group opens one:
 * it used to fetch, get the 404 that leaving is supposed to produce, and draw
 * it in red beside a Try again that could never work. A left conversation is
 * answered from here instead, and stops being one the moment it is listed
 * again (invited back).
 */
const leftConversations = new Set<number>();

/**
 * #4243: whether the browser says it is offline. Only a `false` counts: where
 * the property is missing nothing says the network is gone.
 */
function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * How many messages a page of a conversation reads. The Homeroom bot's chat
 * folds most of its news into a few "N finished" lines (./bot-news-line.tsx),
 * so a page of 50 fills little of the screen and opening it read page after
 * page to fill it, behind its spinner (./open-hold.ts). There it reads the
 * server's most (services/conversations.js caps a page at 100).
 */
function pageSize(conversation: Pick<ConversationDetail, 'homeroomBot'> | null): number {
  return conversation?.homeroomBot === true ? 100 : 50;
}

/**
 * `offlineCopy` is the retry of an open whose read from the server failed
 * (#4243): the one read that takes the service worker's offline copy while
 * the browser says it is online.
 */
export async function loadThread(conversationId: number, force = false, offlineCopy = false): Promise<void> {
  if (!validId(conversationId)) return;
  if (leftConversations.has(conversationId)) {
    threadRequest += 1;
    publish({
      loadingThread: false, threadError: null, threadGone: 'left',
      active: null, messages: [], nextBefore: null, nextAfter: null,
    });
    return;
  }
  const linked = state.route.conversationId === conversationId ? state.route.focusMessageId : null;
  const focus = linked && linked !== focusLoaded ? linked : null;
  if (!force && !focus && state.active?.id === conversationId && state.messages.length) return;
  const request = ++threadRequest;
  const preserveVisibleThread = force && state.active?.id === conversationId;
  // A refresh of a linked page (#2387) re-reads the same window rather than
  // snapping to the present: the realtime echo of a reaction would otherwise
  // take the reader away from the message they followed a link to.
  const reading = preserveVisibleThread && state.nextAfter ? state.messages.find((item) => item.id > 0)?.id || null : null;
  // THE PANE OPENS AT ITS FINAL SHAPE. With nothing active until the detail
  // answered, the header and composer mounted only then: the transcript drew
  // full height on the first frames and shrank under them as they arrived.
  // The inbox row is already a full summary (ConversationDetail adds nothing
  // to it), so it stands in until the detail replaces it.
  const listed = preserveVisibleThread ? null : state.conversations.find((item) => item.id === conversationId) || null;
  publish({
    loadingThread: true,
    threadError: null,
    threadGone: null,
    active: preserveVisibleThread ? state.active : listed,
    messages: preserveVisibleThread ? state.messages : [],
    nextBefore: preserveVisibleThread ? state.nextBefore : null,
    nextAfter: preserveVisibleThread ? state.nextAfter : null,
  });
  // A FORCED READ RE-READS WHAT IS ON SCREEN BECAUSE SOMETHING CHANGED — a
  // realtime event, a send, a reconnect — so it goes to the server, past the
  // service worker's offline copy (#3705, #3706; api.ts ReadOptions). That
  // copy was the page from before the change, and drawing it lost the very
  // message the event was about.
  // AN OPEN GOES TO THE SERVER TOO WHILE THE BROWSER IS ONLINE (#4243). Its
  // offline copy is the last visit's transcript: on a read slower than the
  // worker's second it was drawn, and the newest messages snapped in under
  // the reader when the worker's correction came. The skeleton stays a beat
  // longer instead. Offline, or once that read has failed, the open takes
  // the copy (`offlineCopy`, from the catch below).
  const fresh = force || (!offlineCopy && !browserOffline());
  const read = { fresh };
  try {
    // Invitation metadata is deliberately readable before acceptance, but
    // retained history is not. Resolve membership first and never request
    // message bytes for an invitee.
    const active = await api.getConversation(conversationId, read);
    if (request !== threadRequest || state.route.conversationId !== conversationId) return;
    // Old Preview links resolve to the viewer's persisted sample thread.
    // Use its canonical address for messages, writes, drafts and WS events.
    if (active.id !== conversationId) {
      const suffix = state.route.threadRootId ? `/thread/${state.route.threadRootId}`
        : state.route.focusMessageId ? `/m/${state.route.focusMessageId}` : '';
      openAddress(`#messages/${active.id}${suffix}`);
      return;
    }
    // #3653: a channel opened on this screen goes to its community's tab as
    // soon as this says it is one, before its messages are read here.
    if (active.kind === 'channel' && state.route.open && !state.route.embedded) {
      publish({ active });
      if (channelToHub()) return;
    }
    // 1 Nov 2026: and the chat with Homeroom bot to its tab, the same way.
    if (active.homeroomBot && active.kind !== 'channel') {
      noteBotConversation(active.id);
      if (state.route.open && !state.route.embedded) {
        publish({ active });
        if (botToTab()) return;
      }
    }
    const member = active.membershipStatus === 'member';
    const anchor = focus || reading;
    const page: { messages: ConversationMessage[]; nextBefore: number | null; nextAfter: number | null; threadRootId?: number | null; focusMessageId?: number | null } = !member
      ? { messages: [], nextBefore: null, nextAfter: null }
      : anchor
        ? await api.listMessagesAround(conversationId, anchor, read).then((around) => ({
          messages: around.messages, nextBefore: around.nextBefore, nextAfter: around.nextAfter,
          threadRootId: around.focus.threadRootId, focusMessageId: around.focus.messageId,
        })).catch(() => api.listMessages(conversationId, null, read, pageSize(active)).then((latest) => ({ ...latest, nextAfter: null })))
        : { ...(await api.listMessages(conversationId, null, read, pageSize(active))), nextAfter: null };
    if (request !== threadRequest || state.route.conversationId !== conversationId) return;
    if (focus && page.focusMessageId && page.focusMessageId !== focus) {
      // In its community's page the room has no address of its own (#3653):
      // the message it lands on moves in place.
      if (state.route.embedded) {
        publish({ route: { ...state.route, focusMessageId: page.focusMessageId } });
        void loadThread(conversationId);
        return;
      }
      openAddress(`#messages/${conversationId}/m/${page.focusMessageId}`);
      return;
    }
    const messages = withLocalRows(conversationId, [...page.messages].sort((a, b) => a.id - b.id), member && !page.nextAfter);
    if (focus) focusLoaded = focus;
    // WHERE READING HAD STOPPED, taken from this read of the conversation
    // and before anything below reads it (readMainWhenThere), so the
    // transcript can open there and draw its "New" line (./unread-anchor.ts).
    // Once per open: a refresh of the conversation on screen is not an open,
    // and the line stays where it was until the conversation closes (route,
    // close and embed let it go).
    const unreadMark = state.unreadMark?.conversationId === conversationId
      ? state.unreadMark
      : preserveVisibleThread ? null : markFor(conversationId, active);
    publish({ active, messages, nextBefore: page.nextBefore, nextAfter: page.nextAfter, loadingThread: false, online: true, unreadMark });
    upsertConversation(active);
    applyPendingQuote();
    // A link to a reply inside a thread opens that thread beside it.
    if (focus && page.threadRootId && state.route.threadRootId !== page.threadRootId) {
      publish({ route: { ...state.route, threadRootId: page.threadRootId } });
    }
    if (state.route.threadRootId) void loadReplyThread(conversationId, state.route.threadRootId);
    const last = newestMainId(messages);
    // Read up to the newest message DRAWN — and only once the transcript
    // reaches the present, or a message link would mark everything after it
    // read. Never straight after "Mark unread" (#2387): the reader asked for
    // this conversation to stay unread, and it is still open. And only with
    // somebody there to read it (readWhenThere): a message that lands in a
    // conversation left open on an unattended screen waits for them.
    if (last && member && !page.nextAfter && unreadHold !== conversationId) readMainWhenThere(conversationId);
  } catch (error) {
    if (request !== threadRequest) return;
    // An open that failed on the network or the server, not with an answer
    // like a 404, reads again and takes the offline copy (#4243).
    const answered = error instanceof api.MessagesApiError && error.status < 500;
    if (fresh && !force && !answered) {
      await loadThread(conversationId, false, true);
      return;
    }
    publish({
      // A failed open says so on its own, as it did before the inbox row
      // stood in: no header or composer for a conversation that did not load.
      ...(preserveVisibleThread ? {} : { active: null }),
      loadingThread: false,
      threadError: errorMessage(error, t('messages:store.error.loadThread')),
      // A 404 is an answer, not a failure: trying again reads the same one.
      threadGone: error instanceof api.MessagesApiError && error.status === 404 ? 'missing' : null,
    });
  }
}

/**
 * A page read from the server, with the viewer's own rows it cannot know of
 * kept.
 *
 * Confirmed rows get back the client key they were first drawn under. A
 * local row (pending or failed) stays at the end unless the page already
 * holds it: the realtime echo can land before the POST that caused it
 * returns, and then the server's copy — the viewer's, same words, NEWER than
 * anything the transcript held when the row was drawn, not yet claimed by
 * another local row — IS that row, so it takes its key and the local one
 * goes. Newer, because the same words are sent again and again in the
 * Homeroom bot's DM, whose suggested answers are "Yes" and "File it" every
 * time (#3706): matched on the words alone, the OLDEST such message on the
 * page took the new row's key, the next confirmation took that old message
 * off the screen, and two rows went on sharing one React key.
 *
 * And a row the POST already confirmed stays when the page is older than it
 * (#3706): a page that reaches the present and holds nothing as new was read
 * before the send landed — a refresh already in flight, or a cached copy —
 * and taking its word took the sender's message away until a reload. A
 * later page that holds it, or anything newer, settles it as usual.
 */
function withLocalRows(conversationId: number, page: ConversationMessage[], reachesPresent = true): ConversationMessage[] {
  const me = currentUser().id;
  const claimed = new Set(sentKeys.values());
  const messages = page.map((item) => {
    const key = sentKeys.get(item.id);
    return key ? { ...item, clientKey: key } : item;
  });
  const newest = newestServerId(messages);
  const local: ConversationMessage[] = [];
  for (const row of state.messages) {
    if (row.conversationId !== conversationId || !row.clientKey) continue;
    if (row.id > 0) {
      if (reachesPresent && row.id > newest && sentKeys.get(row.id) === row.clientKey) local.push(row);
      continue;
    }
    if (claimed.has(row.clientKey)) continue;
    const after = unsent.get(row.clientKey)?.after || 0;
    const match = messages.find((item) => !item.clientKey && item.id > after
      && item.sender.id === me && item.content === row.content);
    if (match && row.pending) {
      sentKeys.set(match.id, row.clientKey);
      match.clientKey = row.clientKey;
      continue;
    }
    local.push(row);
  }
  return messages.concat(local.sort(transcriptOrder));
}

/** The newest message the server has given these rows, or 0. */
function newestServerId(rows: ConversationMessage[]): number {
  return rows.reduce((top, item) => Math.max(top, item.id), 0);
}

async function refreshActiveAfterMembershipChange(conversationId: number): Promise<void> {
  await loadThread(conversationId, true);
  if (state.route.conversationId !== conversationId) return;
  // The reload answered 404: read from state, not from the sentence shown.
  if (state.threadGone === 'missing') {
    await finishDirectBlock(conversationId);
  }
}

/**
 * #2387: the newer half of a transcript a message link opened part-way back.
 * Reaching the present marks it read, as opening it normally would have.
 */
export async function loadNewer(): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId || !state.nextAfter || state.loadingOlder) return;
  publish({ loadingOlder: true });
  try {
    const page = await api.listMessagesAfter(conversationId, state.nextAfter);
    if (state.route.conversationId !== conversationId) return;
    const known = new Set(state.messages.map((message) => message.id));
    const newer = page.messages.filter((message) => !known.has(message.id));
    const messages = [...state.messages, ...newer].sort(transcriptOrder);
    publish({ messages, nextAfter: page.nextAfter, loadingOlder: false });
    const last = newestMainId(messages);
    if (!page.nextAfter && last && unreadHold !== conversationId) readMainWhenThere(conversationId);
  } catch (error) {
    publish({ loadingOlder: false, threadError: errorMessage(error, t('messages:store.error.loadNewer')) });
  }
}

/** #2387: leave a linked page for the newest messages. */
export function jumpToPresent(): void {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  publish({ route: { ...state.route, focusMessageId: null }, nextAfter: null });
  void loadThread(conversationId, true);
}

// #5019: resolves `true` when a page was read (or there was nothing to read),
// `false` only when the request failed — the caller offers the button back as
// a manual retry on `false`.
export async function loadOlder(): Promise<boolean> {
  const conversationId = state.route.conversationId;
  if (!conversationId || !state.nextBefore || state.loadingOlder) return true;
  publish({ loadingOlder: true });
  try {
    const page = await api.listMessages(conversationId, state.nextBefore, undefined, pageSize(state.active));
    if (state.route.conversationId !== conversationId) return true;
    const known = new Set(state.messages.map((message) => message.id));
    const older = page.messages.filter((message) => !known.has(message.id));
    publish({
      messages: [...older, ...state.messages].sort(transcriptOrder),
      nextBefore: page.nextBefore,
      loadingOlder: false,
    });
    return true;
  } catch (error) {
    publish({ loadingOlder: false, threadError: errorMessage(error, t('messages:store.error.loadOlder')) });
    return false;
  }
}

function validId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_ID;
}

/**
 * Tell the bell that a conversation has been read.
 *
 * `POST /api/conversations/:id/read` clears that conversation's notification
 * rows server-side; this is the same clearing applied to the copy the open
 * document is holding, so the badge falls when you read rather than at the
 * next refresh. See Notifications.markConversationRead for why it is a window
 * seam rather than an import (that module loads as a classic script in two
 * test harnesses and cannot carry one).
 *
 * A no-op wherever the shell has not booted — the notifications module
 * publishes itself on load, and the first refresh reconciles anything missed.
 */
function notifyConversationRead(conversationId: number): void {
  if (typeof window === 'undefined') return;
  window.Notifications?.markConversationRead?.(conversationId);
}

export function route(
  conversationId?: number | null,
  appSlug?: string | null,
  agent?: MessagesAgentThread | null,
  extras: { threadRootId?: number | null; focusMessageId?: number | null } = {},
): void {
  const nextId = validId(conversationId) ? conversationId : null;
  // #2387: a reply thread and a message link ride on a conversation or an
  // app channel, never on an agent thread or the bare list.
  const nextRoot = (nextId || validSlug(appSlug)) && validId(extras.threadRootId) ? extras.threadRootId : null;
  const nextFocus = (nextId || validSlug(appSlug)) && validId(extras.focusMessageId) ? extras.focusMessageId : null;
  if (unreadHold && unreadHold !== nextId) unreadHold = null;
  // ONE THREAD IS OPEN (#2718 review). An app's discussion and a conversation
  // are both threads of this inbox, addressed differently because one is an
  // app and the other a row in this database — so naming one clears the
  // other rather than leaving two panes' worth of state half-set. #2813's
  // agent threads join the same rule, last in precedence.
  const nextSlug = nextId ? null : validSlug(appSlug);
  const nextAgent = nextId || nextSlug ? null : validAgentThread(agent);
  if (state.route.open && state.route.conversationId === nextId
      && state.route.appSlug === nextSlug && sameAgentThread(state.route.agent, nextAgent)) {
    const threadChanged = state.route.threadRootId !== nextRoot;
    const focusChanged = !!nextFocus && state.route.focusMessageId !== nextFocus;
    if (threadChanged || focusChanged) {
      publish({ route: { ...state.route, threadRootId: nextRoot, focusMessageId: nextFocus || state.route.focusMessageId } });
      if (!nextRoot) publish({ thread: null });
    }
    if (!state.listLoaded) void loadConversations();
    if (!state.discussionsLoaded) void loadAppDiscussions();
    if (nextId && (!state.active || state.active.id !== nextId || focusChanged)) void loadThread(nextId, focusChanged);
    else if (nextId && nextRoot && threadChanged) void loadReplyThread(nextId, nextRoot);
    if (nextSlug && state.discussionContext?.slug !== nextSlug) void loadDiscussion(nextSlug);
    revealAppFocus(nextSlug, nextFocus);
    return;
  }
  // A new address reads its link afresh, even one followed before.
  focusLoaded = null;
  publish({
    route: { open: true, conversationId: nextId, appSlug: nextSlug, agent: nextAgent, threadRootId: nextRoot, focusMessageId: nextFocus },
    thread: null,
    nextAfter: null,
    // A conversation opened again is read afresh: its "New" line was the
    // last visit's (loadThread takes the next one).
    unreadMark: null,
    threadError: null,
    discussionError: null,
    // The previous thread's app, if there was one. Held until the next one
    // lands and cleared outright when the next thread is a conversation, so
    // the pane never draws one app's name over another's transcript.
    discussionContext: nextSlug && state.discussionContext?.slug === nextSlug
      ? state.discussionContext : null,
  });
  void loadConversations();
  // #2718: beside the conversations, never instead of them. It is a separate
  // request with its own failure, so a slow or broken discussions read costs
  // the Apps filter and nothing else — see loadAppDiscussions.
  void loadAppDiscussions();
  if (nextId) void loadThread(nextId);
  else publish({ active: null, messages: [], nextBefore: null, loadingThread: false });
  if (nextSlug) void loadDiscussion(nextSlug);
  revealAppFocus(nextSlug, nextFocus);
}

/**
 * An agent thread out of the address bar (#2813). A session's id is a
 * serial; anything else is not a thread this inbox can open, and the pane
 * falls back to "choose a conversation".
 */
export function validAgentThread(agent?: MessagesAgentThread | null): MessagesAgentThread | null {
  if (!agent || typeof agent !== 'object') return null;
  if (agent.kind === 'session') {
    const slug = validSlug(agent.slug);
    return slug && validId(agent.id) ? { kind: 'session', slug, id: agent.id } : null;
  }
  if (agent.kind === 'agent') {
    if (agent.id === 'new') return { kind: 'agent', id: 'new' };
    return validId(agent.id) ? { kind: 'agent', id: agent.id } : null;
  }
  return null;
}

function sameAgentThread(a: MessagesAgentThread | null, b: MessagesAgentThread | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'session' && b.kind === 'session') return a.slug === b.slug && a.id === b.id;
  if (a.kind === 'agent' && b.kind === 'agent') return a.id === b.id;
  return false;
}

/**
 * The inbox's own address for an agent thread (#2813). The rows link here on
 * every viewport; on a phone the router swaps it for `fullScreenAddress`.
 */
export function agentThreadAddress(agent: MessagesAgentThread): string {
  if (agent.kind === 'agent') return `#messages/agent/${agent.id}`;
  return `#messages/session/${encodeURIComponent(agent.slug)}/${agent.id}`;
}

/** Where the same thread lives as a screen of its own — a phone's destination. */
export function fullScreenAddress(agent: MessagesAgentThread): string {
  if (agent.kind === 'agent') return `#agent/${agent.id}`;
  return `#app/${encodeURIComponent(agent.slug)}/dev/sessions/${agent.id}`;
}

/**
 * A slug out of the address bar. Same shape the platform mints (#2718) —
 * `<name>-<hex>` — and nothing here builds a URL from it without encoding,
 * but a route segment is viewer input and the pane renders its name.
 */
function validSlug(slug?: string | null): string | null {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed) ? trimmed : null;
}

/**
 * The open discussion's app.
 *
 * The inbox row already carries the name, but not whether this viewer may
 * WRITE: that is `can_collaborate`, a fact about the app rather than about
 * its last message, so it comes from the app itself. Getting it wrong either
 * way is worse than waiting — a composer that cannot send, or no composer
 * where there should be one — so the pane holds until this lands.
 */
export async function loadDiscussion(slug: string): Promise<void> {
  const want = validSlug(slug);
  if (!want) return;
  const telemetry = (window as any).UITelemetry;
  telemetry?.screen?.('app_discussion', { appSlug: want });
  const attemptId = telemetry?.attempt?.('app_discussion_load', {
    screen: 'app_discussion', appSlug: want, timeoutMs: 10_000, abandonOnHide: true,
  });
  let errorCode = 'network';
  try {
    // `manifest=summary`: the same address AppView and the Improve target read,
    // so the service worker's cached copy is shared rather than kept twice;
    // nothing here reads the manifest's declared tests or platform env.
    const response = await fetch(`/api/apps/${encodeURIComponent(want)}?manifest=summary`);
    if (!response.ok) {
      errorCode = telemetry?.errorCodeFor?.(response.status) || 'unavailable';
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => null);
    const app = (data && (data.app || data)) || null;
    if (!app || !app.slug) { errorCode = 'invalid_response'; throw new Error('No such app'); }
    // A slower request for a thread the reader has already left must not
    // paint over the one they are looking at.
    if (state.route.appSlug !== want) { telemetry?.cancel?.(attemptId); return; }
    publish({
      discussionContext: {
        slug: app.slug,
        name: app.name || app.slug,
        // Homeroom's own row: its old project discussion, read-only since
        // #general became the Homeroom community's channel.
        archived: app.self_hosted === true,
        readOnly: app.can_collaborate === false || app.self_hosted === true,
        // The header tile's artwork when the inbox has no row for this app.
        // `/api/apps/:slug` sends the raw row, so the image is its
        // `icon_image_id` at the platform's own `/app-icons/<id>` address —
        // the one spelling src/routes/messages-overview.js uses for the row.
        iconUrl: app.icon_url || (app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null),
        iconEmoji: app.icon_emoji || null,
      },
      discussionError: null,
    });
    telemetry?.outcome?.(attemptId, 'success');
  } catch {
    if (state.route.appSlug !== want) { telemetry?.cancel?.(attemptId); return; }
    telemetry?.outcome?.(attemptId, 'failure', { errorCode });
    publish({ discussionContext: null, discussionError: t('messages:store.error.discussion') });
  }
}

export function close(): void {
  threadRequest += 1;
  // An external share waiting on the bare list is navigation intent, not a
  // durable draft. Leaving Messages cancels it instead of surprising the user
  // in an unrelated conversation later.
  pendingShare = undefined;
  pendingAttach = null;
  replyThreadRequest += 1;
  unreadHold = null;
  publish({
    route: { open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null },
    active: null, messages: [], loadingThread: false, threadError: null,
    discussionContext: null, discussionError: null, thread: null, nextAfter: null, unreadMark: null,
  });
}

/**
 * #3494: a conversation open IN ITS COMMUNITY'S PAGE rather than on this
 * screen. #general is the Homeroom community's channel, and Homeroom's
 * Discussion tab mounts it in place (ConversationThread, `embedded`) the way
 * any other project's tab mounts its own chat, so the page keeps its header
 * and its tabs. It is the same thread, drafts and realtime included — the
 * store has one route, so the page takes it and the Messages screen shows
 * none while it does (MessagesScreen).
 *
 * `open` stays false: this screen's chrome, Back and the router all ask
 * whether Messages is ON SCREEN, and it is not. Any route here takes the
 * store back (route() never short-circuits an embedded route), and the page
 * gives it back when it leaves the screen (release).
 */
export function embed(
  conversationId: number,
  at: { threadRootId?: number | null; focusMessageId?: number | null } | null = null,
): void {
  if (!validId(conversationId) || state.route.open) return;
  // #3653: a door into the room can name a place in it — a reply thread to
  // open beside it, or a message to land on — as its addresses here do.
  const askedRoot = at?.threadRootId;
  const askedFocus = at?.focusMessageId;
  const root = validId(askedRoot) ? askedRoot : null;
  const focus = validId(askedFocus) ? askedFocus : null;
  if (state.route.embedded && state.route.conversationId === conversationId) {
    // Already in place: the room stays, and moves to what the door names.
    if (root && state.route.threadRootId !== root) {
      publish({ thread: null, route: { ...state.route, threadRootId: root } });
    }
    if (focus && state.route.focusMessageId !== focus) {
      focusLoaded = null;
      publish({ route: { ...state.route, focusMessageId: focus } });
      void loadThread(conversationId);
    }
    return;
  }
  focusLoaded = null;
  unreadHold = null;
  publish({
    route: { open: false, embedded: true, conversationId, appSlug: null, agent: null, threadRootId: root, focusMessageId: focus },
    thread: null, nextAfter: null, threadError: null, discussionContext: null, discussionError: null, unreadMark: null,
  });
  void loadConversations();
  void loadThread(conversationId);
}

/** The page is leaving: close the room it embedded, unless Messages has since taken the store. */
export function release(conversationId: number): void {
  if (state.route.embedded && state.route.conversationId === conversationId) close();
}

export function isOpen(): boolean {
  return state.route.open;
}

export function handleBack(): boolean {
  const onThread = !!state.route.conversationId || !!state.route.appSlug || !!state.route.agent;
  if (!state.route.open || !onThread || !listAside()) return false;
  // A CHANNEL is not a level of this list: it is its community's room, and
  // its way back is that community's hub, which the header's arrow names
  // (syncChrome). Declining leaves the press to follow it.
  if (!state.route.threadRootId && channelHub()) return false;
  // #4229: wider than a phone a channel's reply thread sits beside it, and
  // the arrow still names the hub.
  if (!isMobile() && channelHub()) return false;
  // #2387: on a phone a reply thread is a level of its own over the
  // conversation, so Back closes it first. Wider than a phone it sits beside
  // its chat, and the arrow goes to the list (#4229).
  if (state.route.threadRootId && isMobile()) {
    const parent = state.route.appSlug
      ? `#messages/app/${encodeURIComponent(state.route.appSlug)}`
      : `#messages/${state.route.conversationId}`;
    try { history.replaceState(null, '', parent); } catch { /* non-fatal */ }
    route(state.route.conversationId, state.route.appSlug, null);
    syncChrome();
    return true;
  }
  const current = typeof location !== 'undefined' ? location.hash : '';
  if (current.startsWith('#messages/') && typeof history !== 'undefined') {
    try { history.replaceState(null, '', '#messages'); } catch { /* non-fatal */ }
  }
  route(null);
  syncChrome();
  return true;
}

export function isMobile(): boolean {
  try { return typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches; }
  catch { return false; }
}

/**
 * One pane at a time: a phone. (#4229's strip too narrow for both is gone:
 * on a desktop the list is in the sidebar, never beside the conversation,
 * ./index.tsx `messages-list-in-rail`.)
 */
function listAside(): boolean {
  return isMobile();
}

/**
 * The hub a CHANNEL on screen belongs to, or null when the route is not a
 * channel. A project's channel (`#messages/app/<slug>`) is its own hub's;
 * #general (a conversation of kind `channel`) is the Homeroom community's,
 * whose slug the platform target knows once the shell has read it.
 *
 * Channels live in their communities now, not in Messages: they are not
 * listed here, and one that is open lights the Communities tab and hangs off
 * its hub rather than off this list.
 */
export function channelHub(): string | null {
  if (state.route.appSlug) return `#app/${encodeURIComponent(state.route.appSlug)}/workshop`;
  const id = state.route.conversationId;
  if (!id) return null;
  const row = state.active && state.active.id === id
    ? state.active
    : state.conversations.find((item) => item.id === id) || null;
  if (!row || row.kind !== 'channel') return null;
  // The same read the pane's own disc draws from (channel-hub.ts), so the
  // header's arrow and the disc name one hub.
  const platform = typeof window !== 'undefined' ? platformSlug() : null;
  return platform ? `#app/${encodeURIComponent(platform)}/workshop` : '#communities';
}

/**
 * #general's hub is found late on a cold load (#3407): the platform's slug
 * lands after the header was set, and the disc in the pane hears it through
 * PlatformTarget.onSlug. This keeps the header's arrow hearing the same
 * thing, so the two never point at different places. Returns the
 * unsubscribe; the screen holds it for as long as it is mounted.
 */
export function followPlatformSlug(): () => void {
  // #3653: and once it is known, a channel on screen goes to that hub's tab.
  return subscribePlatformSlug(() => { if (state.route.open && !channelToHub()) syncChrome(); });
}

/** Whether the conversation open here, not embedded elsewhere, is the chat with Homeroom bot (Main). */
function botOnShow(): boolean {
  return !!state.route.conversationId && !state.route.embedded
    && !!state.active && state.active.id === state.route.conversationId && !!state.active.homeroomBot;
}

export function syncChrome(): void {
  const app = typeof window !== 'undefined' ? window.App : undefined;
  if (!app) return;
  // WHICH TAB IS LIT follows what is open: a channel is its community's, so
  // Communities; anything else here is Messages'. Only while this screen is
  // the one on screen — the router lights the tab for every other.
  const hub = channelHub();
  if (navStore.get().screen === 'messages-screen') {
    navStore.set({ tab: hub ? 'workshop' : 'messages' });
  }
  if (hub && !(isMobile() && state.route.threadRootId)) {
    app.setBackIcon?.('arrow', hub);
    app.setHeaderTitle?.(state.route.appSlug
      ? state.discussionContext?.name || t('messages:store.header.channel')
      : `#${chromeTitle(state.active)}`);
    return;
  }
  // A DISCUSSION IS A THREAD OF THIS SCREEN (#2718 review), so it answers the
  // chrome the same way: the list's chevron on a phone, nothing on a desktop
  // where the list is still beside it. It used to be a route into #app-view,
  // which is why backing out of one landed wherever that screen's slot
  // pointed — the Workshop, when that is where the app had been opened from.
  // #4229: and on a strip too narrow for the list beside it, where the list
  // has stepped aside just as it does on a phone.
  // THE PHONE'S DRAWER (../nav-drawer/messages-drawer.ts): a conversation
  // with people, an agent chat or an agent session is its second level, and
  // the header draws the drawer's own arrow (a button, not this href'd one,
  // so WebKit's history swipe stays off while a finger pans the drawer) and
  // names it.
  if ((state.route.conversationId || state.route.agent) && messagesDrawerApplies({
    phone: isMobile(),
    open: state.route.open,
    conversationId: state.route.conversationId,
    appSlug: state.route.appSlug,
    agent: state.route.agent,
    threadRootId: state.route.threadRootId,
    embedded: state.route.embedded,
    activeKind: state.active && state.active.id === state.route.conversationId ? state.active.kind : null,
    bot: botOnShow(),
  })) {
    app.setBackIcon?.('none');
    app.setHeaderTitle?.(t('messages:store.header.messages'));
    return;
  }
  // #6019: Main, the chat with Homeroom bot, is a level under the AI tab's
  // page (features/ai/): its arrow goes back there, at every width, and the
  // bar names it. A thread of it is a level under Main, as any reply thread is.
  if (botOnShow() && !(isMobile() && state.route.threadRootId)) {
    app.setBackIcon?.('arrow', '#homeroom-bot');
    app.setHeaderTitle?.(t('messages:store.header.main'));
    return;
  }
  const thread = listAside() && !!(state.route.conversationId || state.route.appSlug || state.route.agent);
  // #2387: a reply thread, on a phone, is a level over its conversation: the
  // chevron goes back to the conversation, and the bar says "Thread".
  if (isMobile() && state.route.threadRootId && (state.route.conversationId || state.route.appSlug)) {
    app.setBackIcon?.('arrow', state.route.appSlug
      ? `#messages/app/${encodeURIComponent(state.route.appSlug)}`
      : `#messages/${state.route.conversationId}`);
    app.setHeaderTitle?.(t('messages:store.header.thread'));
    return;
  }
  // 'none' ON THE INBOX (#2718 review). This is a second writer over the
  // slot App._BACK_SLOT already set for #messages-screen, and it was
  // publishing the house — so Messages was the one tab root still offering
  // a jump to a screen its own bar already reaches. A THREAD is a level
  // inside this screen and keeps its chevron up to the list.
  app.setBackIcon?.(thread ? 'arrow' : 'none', thread ? '#messages' : undefined);
  // #5383: a conversation's own header under the bar is the one place its
  // name appears, so the bar over it says "Messages" — on a phone as it
  // already does on a desktop, where the list stays beside the conversation.
  app.setHeaderTitle?.(t('messages:store.header.messages'));
}

/**
 * The bar's name for a channel (#5383: an open conversation is named by its
 * own header now, and the bar over it says "Messages"): its title — which
 * for an accepted direct one is the other person's username. QA 2026-09-24
 * Q33a: an unanswered direct request has no peer yet and is titled "Direct
 * message", so it takes its requester's name instead, as its header and row
 * do.
 */
function chromeTitle(active: ConversationDetail | null): string {
  if (!active) return t('messages:store.header.messages');
  if (active.kind === 'direct' && active.membershipStatus === 'invited' && active.requester?.username) {
    return active.requester.username;
  }
  return active.title || t('messages:store.header.messages');
}

/**
 * THE SIDE PANEL (desktop): while an app is running on its App tab, a
 * conversation opened from outside the inbox — a notification, a saved
 * message — goes to a panel beside the app instead of replacing it
 * (frontend/src/features/side-panel/). False whenever that is not the moment,
 * and the caller navigates as it always has.
 */
function sidePanelTakes(target: string): boolean {
  const panel = (window as unknown as {
    UsernodeReact?: { sidePanel?: { take?: (route: string) => boolean } };
  }).UsernodeReact?.sidePanel;
  try {
    return !!panel?.take?.(target.replace(/^#/, ''));
  } catch {
    return false;
  }
}

/**
 * #3653: a channel's address — an app's, or #general's — while its project
 * page is the page on screen: the page turns to its Discussion tab, at the
 * place the address names, instead of a second address for the page the
 * reader is already on (App._discussionInPlace). False whenever that is not
 * the moment, and the caller navigates, which the router takes to the tab.
 */
function turnsPageInPlace(href: string): boolean {
  try {
    return !!(window as { App?: { _discussionInPlace?: (href: string) => boolean } }).App?._discussionInPlace?.(href);
  } catch {
    return false;
  }
}

export function open(conversationId?: number | null): void {
  if (typeof window === 'undefined') return;
  // 1 Nov 2026: the chat with Homeroom bot opens on its tab, as Main Chat.
  if (validId(conversationId) && conversationId === botConversationId()) { openBotTab(null); return; }
  const target = validId(conversationId) ? `#messages/${conversationId}` : '#messages';
  if (sidePanelTakes(target)) return;
  if (window.location.hash === target) route(conversationId || null);
  else window.location.hash = target;
}

/**
 * B8: open the signed-in person's chat with Homeroom bot, from any door that
 * says "ask Homeroom bot". It is made the first time. 1 Nov 2026: it opens
 * on the bot's tab, as Main Chat (../ai/door.ts), never on this screen.
 */
export async function openBot(reference?: StagedObject | null): Promise<void> {
  let id: number | null = botConversationId();
  if (!id) {
    try { id = await api.openBotConversation(); } catch { id = null; }
    noteBotConversation(id);
  }
  // B8: a change to write about ("Ask for changes"). One that names its
  // project and itself is attached on the composer as it is, with the caret
  // in the box and the box asking what should change: no dialog to fill in
  // (the change page knows both). Anything less is chosen in the Share item
  // dialog, as Share stages one (see share below).
  const attach = !!id && !!reference && stagedComplete(reference);
  if (attach && id && reference) pendingAttach = { conversationId: id, object: reference, placeholder: t(ASK_FOR_CHANGES_PLACEHOLDER) };
  else if (reference) pendingShare = reference;
  const already = !!id && state.route.conversationId === id;
  openBotTab(null);
  if (reference && already && typeof window !== 'undefined') {
    if (attach) window.dispatchEvent(new CustomEvent('usernode:messages-attach'));
    else window.dispatchEvent(new CustomEvent('usernode:messages-share', { detail: pendingShare }));
  }
}

/**
 * 16 Oct 2026 (C4): "See progress" on a request's page. The chat with the
 * bot, opened at that request: at the message waiting on the person when
 * there is one, read off the request's track (services/homeroom-bot-track.js),
 * else at the last thing the chat said about it. Before, it opened the chat
 * alone, and the person had to find the request in it. 31 Oct 2026: never
 * in a thread of the request's: its story is the page this was pressed on
 * (./request-page.ts), so a message in one of the old ones is passed over.
 */
export async function openBotRequest(slug: string, number: number): Promise<void> {
  await openBot();
  try {
    const work = await api.getHomeroomBotWork({ fresh: true });
    const track = (work.tracks || []).find((item) => item.appSlug === slug && item.issueNumber === Number(number));
    const known = track?.askId ? state.messages.find((item) => item.id === track.askId) : null;
    const ask = track?.askId && !known?.threadRootId ? track.askId : null;
    const about = (item: ConversationMessage) => !item.threadRootId && item.sender.bot
      && item.metadata?.homeroomBot?.appSlug === slug && Number(item.metadata?.homeroomBot?.issueNumber) === Number(number);
    const last = [...state.messages].reverse().find(about);
    const at = ask || last?.id || null;
    if (at) openBotTab({ threadRootId: null, focusMessageId: at });
  } catch { /* the chat itself, then */ }
}

/** What the composer's box asks once Ask for changes has attached a change. */
export const ASK_FOR_CHANGES_PLACEHOLDER = 'messages:store.askForChangesPlaceholder';

/** Pure: whether a staged item names its project and itself, so it can be attached as it is. */
export function stagedComplete(reference: SharedObjectReference): boolean {
  const app = validId(reference.appId) || (typeof reference.appSlug === 'string' && reference.appSlug.trim() !== '');
  if (!app) return false;
  if (reference.type === 'app') return true;
  if (reference.type === 'issue') return validId(reference.issueNumber);
  if (reference.type === 'governance') return validId(reference.proposalId);
  if (reference.type === 'spec') return validId(reference.sessionId) && validId(reference.version);
  return validId(reference.sessionId);
}

/**
 * The change Ask for changes staged for `conversationId`'s composer, once:
 * null for any other conversation, which leaves it waiting for its own.
 */
export function takePendingAttach(conversationId: number): { object: StagedObject; placeholder: string } | null {
  if (!pendingAttach || pendingAttach.conversationId !== conversationId) return null;
  const { object, placeholder } = pendingAttach;
  pendingAttach = null;
  return { object, placeholder };
}

// B6: a message of the bot's to quote in the composer once its chat has
// loaded: the App tab's Change something, under a first version's plan.
let pendingQuote: { conversationId: number; messageId: number } | null = null;

/**
 * B6: open the chat with Homeroom bot with one of its messages quoted in the
 * composer, as a reply to it, and the caret after it. A message not in the
 * chat's newest page is not quoted: the chat still opens.
 */
export async function quoteBotMessage(conversationId?: number | null, messageId?: number | null): Promise<void> {
  let id: number | null = validId(conversationId) ? Number(conversationId) : null;
  if (!id) id = botConversationId();
  if (!id) {
    try { id = await api.openBotConversation(); } catch { id = null; }
  }
  noteBotConversation(id);
  pendingQuote = id && validId(messageId) ? { conversationId: id, messageId: Number(messageId) } : null;
  // 1 Nov 2026: on the bot's tab, as Main Chat (open() sends it there).
  if (id) openBotTab(null);
  else open(id);
  applyPendingQuote();
}

/** Quote the pending message once its chat is the one on screen with it loaded. */
function applyPendingQuote(): void {
  const wanted = pendingQuote;
  if (!wanted || state.route.conversationId !== wanted.conversationId || state.active?.id !== wanted.conversationId) return;
  pendingQuote = null;
  const message = state.messages.find((item) => item.id === wanted.messageId);
  if (!message) return;
  setReply(scopeKey(wanted.conversationId, null), message);
  if (typeof window !== 'undefined') {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
    });
  }
}

/** The app-channel message link last revealed (see revealAppFocus). */
let revealedAppFocus: string | null = null;

/**
 * Open any Messages address (#2387): a thread, a message link. The bell's
 * rows come through here rather than assigning the hash themselves, because
 * assigning the address already in the bar fires no hashchange — and the
 * fallback that used to run then, open(conversationId), moved to the bare
 * conversation and shut the very thread the row was about. When the address
 * is already current, the router runs on it again instead.
 */
export function openAddress(href: string): void {
  if (typeof window === 'undefined') return;
  // 1 Nov 2026: the chat with Homeroom bot is its tab's, by either address.
  if (/^#homeroom-bot(?:\/|$)/.test(href)) { goBotAddress(href); return; }
  if (!/^#messages(?:\/|$)/.test(href)) return;
  const botTab = botTabFromMessages(href, botConversationId());
  if (botTab) { goBotAddress(botTab); return; }
  if (turnsPageInPlace(href)) return;
  if (sidePanelTakes(href)) return;
  if (window.location.hash !== href) { window.location.hash = href; return; }
  revealedAppFocus = null;
  (window as { App?: { restoreFromHash?: () => void } }).App?.restoreFromHash?.();
}

/**
 * An app channel's message link (#2387) lands on its message. The channel's
 * transcript is the legacy GroupChat's, so the scroll and the flash are its
 * revealMessage — which pages back for a message older than the first page,
 * and opens the reply thread a reply lives in.
 */
function revealAppFocus(slug: string | null, messageId: number | null): void {
  // Once per address: the router re-runs on the same address for reasons of
  // its own, and a re-run must not drag a reader back who has scrolled on.
  const key = slug && messageId ? `${slug}:${messageId}` : null;
  if (key === revealedAppFocus) return;
  revealedAppFocus = key;
  if (!slug || !messageId) return;
  (window as { GroupChat?: { revealMessage?: (slug: string, id: number) => void } })
    .GroupChat?.revealMessage?.(slug, messageId);
}

/** The same, for the app-discussion half of the inbox (#2718 review). */
export function openDiscussion(slug: string): void {
  if (typeof window === 'undefined') return;
  const safe = validSlug(slug);
  if (!safe) return;
  const target = `#messages/app/${encodeURIComponent(safe)}`;
  if (turnsPageInPlace(target)) return;
  if (sidePanelTakes(target)) return;
  if (window.location.hash === target) route(null, safe);
  else window.location.hash = target;
}

/**
 * The same, for an agent thread (#2813). The rows are ordinary links to
 * `agentThreadAddress`; this is for the callers that are not a link — and
 * for re-selecting the thread already open, which a link cannot do.
 */
export function openAgentThread(agent: MessagesAgentThread): void {
  if (typeof window === 'undefined') return;
  const safe = validAgentThread(agent);
  if (!safe) return;
  const target = agentThreadAddress(safe);
  if (window.location.hash === target) route(null, null, safe);
  else window.location.hash = target;
}

export function selectConversation(conversationId: number): void {
  if (!validId(conversationId) || typeof window === 'undefined') return;
  window.location.hash = `#messages/${conversationId}`;
}

export async function createDirect(userId: number): Promise<ConversationDetail> {
  const conversation = await api.createConversation({ kind: 'direct', userId });
  upsertConversation(conversation);
  open(conversation.id);
  return conversation;
}

export async function createGroup(title: string, memberIds: number[], inviteNote?: string): Promise<ConversationDetail> {
  const conversation = await api.createConversation({ kind: 'group', title, memberIds, inviteNote: inviteNote || undefined });
  upsertConversation(conversation);
  open(conversation.id);
  return conversation;
}

export async function respond(action: 'accept' | 'decline'): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  const conversation = await api.respondToInvitation(id, action);
  if (action === 'accept' && conversation) {
    upsertConversation(conversation);
    await loadThread(id, true);
  } else {
    publish({ conversations: state.conversations.filter((item) => item.id !== id) });
    open(null);
  }
}

export async function inviteMembers(userIds: number[], inviteNote?: string): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  const conversation = await api.addMembers(id, userIds, inviteNote || undefined);
  upsertConversation(conversation);
}

/**
 * QA 2026-09-24 Q14: rename the open group. The server keeps 1 to 80
 * characters with the whitespace collapsed (normalizeTitle) and takes the
 * change from the owner only; the bounds are checked here first so an empty
 * or overlong name says why rather than coming back as a 404.
 */
export async function renameConversation(title: string): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  const next = title.trim().replace(/\s+/g, ' ');
  if (!next) throw new Error(t('messages:store.error.groupNeedsName'));
  if (next.length > 80) throw new Error(t('messages:store.error.groupNameTooLong'));
  if (next === state.active?.title) return;
  try {
    upsertConversation(await api.updateConversation(id, { title: next }));
  } catch (error) {
    throw new Error(errorMessage(error, 'Couldn’t rename this group.'));
  }
}

export async function removeMember(userId: number): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  await api.removeMember(id, userId);
  await loadThread(id, true);
}

export async function leave(): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  await api.leaveConversation(id);
  leftConversations.add(id);
  publish({ conversations: state.conversations.filter((item) => item.id !== id) });
  open(null);
}

/**
 * Apply the local half of a successful direct-message block. The server has
 * already made this conversation inaccessible; remove every retained byte
 * before refreshing the authoritative list and returning to level 1.
 */
export async function finishDirectBlock(conversationId: number): Promise<void> {
  if (!validId(conversationId)) return;
  threadRequest += 1;
  publish({
    conversations: state.conversations.filter((item) => item.id !== conversationId),
    active: null,
    messages: [],
    loadingThread: false,
    threadError: null,
    nextBefore: null,
  });
  open(null);
  await loadConversations(true);
}

/** Reconcile the open thread and inbox after changing a sender block. */
export async function setUserBlocked(userId: number, blocked: boolean): Promise<void> {
  await api.setBlock(userId, blocked);
  await refreshBlockedView(userId, blocked);
}

async function refreshBlockedView(userId: number, blocked: boolean): Promise<void> {
  void loadAppDiscussions();
  (window as any).GroupChat?.refreshAfterBlock?.();
  const active = state.active;
  if (blocked && active?.kind === 'direct'
      && (active.peer?.id === userId || active.requester?.id === userId
        || active.members.some((member) => member.id === userId))) {
    await finishDirectBlock(active.id);
    return;
  }
  const conversationId = state.route.conversationId;
  if (blocked) publish({ messages: [] });
  await Promise.all([
    loadConversations(true),
    ...(conversationId ? [loadThread(conversationId, true)] : []),
  ]);
}

export function draftFor(scope: ComposerScope): string {
  if (drafts.has(scope)) return drafts.get(scope) || '';
  try {
    const value = localStorage.getItem(`usernode:messages-draft:${scope}`) || '';
    drafts.set(scope, value);
    return value;
  } catch { return ''; }
}

export function setDraft(scope: ComposerScope, value: string): void {
  drafts.set(scope, value);
  try {
    if (value) localStorage.setItem(`usernode:messages-draft:${scope}`, value);
    else localStorage.removeItem(`usernode:messages-draft:${scope}`);
  } catch { /* storage unavailable */ }
  // NOT published. Nothing reads a draft from the snapshot: the composer
  // holds its own text and reads `draftFor` only when its scope changes. A
  // publish here ran on every keystroke and re-rendered every subscriber —
  // the open thread and all of its rows, the inbox, the nav recents — which
  // on a phone made typing in a long chat visibly lag.
}

export function replyFor(scope: ComposerScope): ConversationMessage | null {
  return replyTargets.get(scope) || null;
}

export function setReply(scope: ComposerScope, message: ConversationMessage | null): void {
  if (message) replyTargets.set(scope, message);
  else replyTargets.delete(scope);
  publish({});
}

/**
 * One request, one story: the request thread a bot message belongs to in the
 * chat with Homeroom bot (a reply's root), or null: the main stream, and
 * any chat that keeps no threads (bot-shared.ts threadsAllowed).
 */
function botThreadOf(message: ConversationMessage): number | null {
  if (!message.sender.bot || !threadsAllowed(state.active) || state.active?.kind !== 'direct') return null;
  const root = validId(message.threadRootId) ? message.threadRootId as number : null;
  if (!root || state.route.threadRootId === root) return root;
  // 31 Oct 2026: a request's story thread from before is not drawn any more
  // (./request-page.ts), so what answers a moment from one, shown in the
  // main stream, is said there. A thread of the person's own keeps its own.
  const rootRow = findRow(root);
  if (rootRow) return requestPageFor(rootRow) ? null : root;
  return requestPageOf(message) ? null : root;
}

/**
 * Quote a bot message in the composer and put the caret there, for an
 * answer of one's own (Write my own, Change something, a `reply` button).
 * A message in a request's thread is quoted in that thread's composer, the
 * thread opened beside the chat first when it is not the one open.
 */
export function quoteInComposer(message: ConversationMessage, conversationId: number): void {
  const rootId = conversationId === state.route.conversationId ? botThreadOf(message) : null;
  setReply(scopeKey(conversationId, rootId), message);
  if (rootId && state.route.threadRootId !== rootId) openThread(rootId);
  if (typeof window === 'undefined') return;
  // The thread's composer is drawn once its pane is: look for it a few frames.
  const selector = rootId ? '.messages-reply-pane .messages-composer-input' : '.messages-composer-input';
  let tries = 10;
  const focus = () => {
    const input = document.querySelector<HTMLTextAreaElement>(selector);
    if (input) { input.focus({ preventScroll: true }); return; }
    tries -= 1;
    if (tries > 0) window.requestAnimationFrame(focus);
  };
  window.requestAnimationFrame(focus);
}

/**
 * #3624: answer the Homeroom bot's question with one of its suggested
 * answers. Sent as an ordinary message quoting the question, which is how
 * the server knows which request it answers; whatever the person had
 * typed, and any other reply they had staged, is left as it was.
 */
export async function answerBotQuestion(question: ConversationMessage, answer: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId || conversationId !== question.conversationId) return;
  // One request, one story: the answer goes in the request's thread,
  // whether it was tapped there or on the moment the main chat also shows.
  const rootId = botThreadOf(question);
  const scope = scopeKey(conversationId, rootId);
  const draft = draftFor(scope);
  const staged = replyFor(scope);
  replyTargets.set(scope, question);
  const sending = send({ content: answer, threadRootId: rootId, anyThread: true });
  if (draft) setDraft(scope, draft);
  if (staged && staged.id !== question.id) setReply(scope, staged);
  await sending;
}

/**
 * B3: press one of a bot message's buttons (types.ts HomeroomBotAction).
 * A `server` one is decided once on the server (api.decideBotAction), which
 * updates the message on every device; `prompt` sends its words as the
 * person's own message, quoting nothing; `open` goes to its in-app address,
 * a project's app the way the shell opens one (bot-shared.ts openAppTarget).
 * Rejects when a `server` press was refused (a 409: decided already).
 */
export async function tapBotAction(message: ConversationMessage, action: HomeroomBotAction): Promise<void> {
  if (action.type === 'open') {
    openAppTarget(action.target);
    return;
  }
  if (action.type === 'prompt') {
    const conversationId = state.route.conversationId;
    if (!conversationId || conversationId !== message.conversationId) return;
    // In the chat with Homeroom bot, a button on a message in a request's
    // thread says its words in that thread.
    const rootId = botThreadOf(message);
    const scope = scopeKey(conversationId, rootId);
    const staged = replyFor(scope);
    // A `quote` prompt replies to the message it sits on, so it is about what
    // that message is about; any other is sent on its own. Either way a
    // reply they had staged is theirs again after.
    if (action.quote) setReply(scope, message);
    else if (staged) setReply(scope, null);
    const sending = send({ content: action.label, threadRootId: rootId, anyThread: true });
    if (action.quote || staged) setReply(scope, staged || null);
    await sending;
    return;
  }
  const actionId = message.metadata?.homeroomBot?.actionId;
  if (!actionId) throw new Error('This choice has nothing to decide');
  await api.decideBotAction(actionId, action.id);
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function send(input: {
  content: string; attachmentIds?: string[]; object?: SharedObjectReference; attachments?: ConversationMessage['attachments']; threadRootId?: number | null;
  /**
   * Send into `threadRootId`'s thread even when it is not the one open: an
   * answer tapped on a moment the chat with Homeroom bot also shows in its
   * main stream goes in its request's thread (answerBotQuestion).
   */
  anyThread?: boolean;
}): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const open = !!input.threadRootId && state.thread?.rootId === input.threadRootId;
  const threadRootId = input.threadRootId && (open || (input.anyThread && validId(input.threadRootId))) ? input.threadRootId : null;
  const scope = scopeKey(conversationId, threadRootId);
  const content = input.content.slice(0, 8000);
  const reply = replyFor(scope);
  const pending: PendingSend = {
    content,
    attachmentIds: input.attachmentIds,
    object: input.object,
    replyToId: reply?.id,
    ...(threadRootId ? { threadRootId } : {}),
    idempotencyKey: idempotencyKey(),
  };
  const optimistic: ConversationMessage = {
    id: -Date.now(),
    conversationId,
    sender: currentUser(),
    content,
    createdAt: new Date().toISOString(),
    reply: reply ? { id: reply.id, sender: reply.sender, content: reply.content } : null,
    // The files already uploaded draw with the row, so a file-only send is
    // not an empty line while it is in flight.
    reactions: [], attachments: input.attachments || [], objects: [], pending: true, clientKey: pending.idempotencyKey,
    threadRootId,
  };
  unsent.set(pending.idempotencyKey, { conversationId, payload: pending, after: newestServerId(state.messages) });
  setDraft(scope, '');
  setReply(scope, null);
  if (threadRootId && open && state.thread) {
    publish({ thread: { ...state.thread, messages: [...state.thread.messages, optimistic], error: null } });
  } else if (threadRootId) {
    // Into a thread that is not open: drawn in that thread once it lands,
    // and the row it answers says so meanwhile (its own pressed state).
  } else {
    publish({ messages: [...state.messages, optimistic], threadError: null });
    // Sending from a linked window part-way back (#2387) goes to the present,
    // where the message lands — the way every messenger does it.
    if (state.nextAfter) jumpToPresent();
  }
  await deliver(conversationId, pending);
}

/**
 * Send a local row's payload and settle the row: the server's message in its
 * place (same client key, so it is updated rather than remounted), or the
 * row marked failed with its Retry. The row is found by client key, not by
 * its temporary id, because a refresh can have re-read the thread meanwhile.
 */
async function deliver(conversationId: number, pending: PendingSend): Promise<void> {
  const key = pending.idempotencyKey;
  if (pending.threadRootId) { await deliverToThread(conversationId, pending); return; }
  try {
    const message = await api.sendMessage(conversationId, pending);
    unsent.delete(key);
    sentKeys.set(message.id, key);
    if (state.route.conversationId === conversationId) {
      // The member-scoped WS event can win the race with this HTTP response
      // and refresh the real row into the thread first. Remove both the
      // local row and any already-present server id before the
      // authoritative POST response is inserted.
      const messages = state.messages
        .filter((item) => item.clientKey !== key && item.id !== message.id)
        .concat({ ...message, clientKey: key })
        .sort(transcriptOrder);
      publish({ messages });
    }
    await loadConversations(true);
  } catch (error) {
    if (isAwaitingAcceptance(error)) {
      // QA 2026-09-24 Q2: a send that cannot go through until the other
      // person accepts is not a failed row — a Retry there could never
      // succeed, and a reload dropped it. The words go back to the draft
      // (unless a new one has been started) and the conversation is re-read,
      // so the thread says who it is waiting for in place of the composer.
      unsent.delete(key);
      const scope = scopeKey(conversationId, null);
      if (!draftFor(scope) && pending.content) setDraft(scope, pending.content);
      publish({ messages: state.messages.filter((item) => item.clientKey !== key) });
      if (state.route.conversationId === conversationId) void loadThread(conversationId, true);
      return;
    }
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (offline) {
      const queue = pendingByConversation.get(conversationId) || [];
      queue.push(pending);
      pendingByConversation.set(conversationId, queue.slice(-50));
    }
    publish({
      online: !offline,
      messages: state.messages.map((item) => item.clientKey === key ? { ...item, pending: false, failed: true } : item),
      threadError: offline ? t('messages:store.error.queued') : errorMessage(error, t('messages:store.error.send')),
    });
  }
}

/**
 * A reply sent into the thread open beside the conversation (#2387). The
 * same optimistic row and idempotency key as a send into the conversation,
 * settled in the thread's own page; the conversation's transcript is then
 * re-read for the reply count on the message the thread hangs off.
 */
async function deliverToThread(conversationId: number, pending: PendingSend): Promise<void> {
  const key = pending.idempotencyKey;
  const rootId = pending.threadRootId as number;
  try {
    const message = await api.sendMessage(conversationId, pending);
    unsent.delete(key);
    sentKeys.set(message.id, key);
    const thread = state.thread;
    if (thread && thread.conversationId === conversationId && thread.rootId === rootId) {
      const messages = thread.messages
        .filter((item) => item.clientKey !== key && item.id !== message.id)
        .concat({ ...message, clientKey: key })
        .sort((a, b) => (a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id));
      publish({ thread: { ...thread, messages } });
    }
    if (state.route.conversationId === conversationId) void loadThread(conversationId, true);
  } catch (error) {
    const thread = state.thread;
    if (thread && thread.rootId === rootId) {
      publish({
        thread: {
          ...thread,
          messages: thread.messages.map((item) => item.clientKey === key ? { ...item, pending: false, failed: true } : item),
          error: errorMessage(error, t('messages:store.error.sendReply')),
        },
      });
    } else if (state.route.conversationId === conversationId) {
      // Sent into a thread that is not open (send `anyThread`): it has no
      // row of its own to fail on, so the conversation says it.
      unsent.delete(key);
      publish({ threadError: errorMessage(error, t('messages:store.error.sendReply')) });
      throw error;
    }
  }
}

/** Apply `fn` to the matching rows of the conversation AND of the open thread. */
function mapRows(fn: (item: ConversationMessage) => ConversationMessage): void {
  const thread = state.thread;
  publish({
    messages: state.messages.map(fn),
    ...(thread ? { thread: { ...thread, root: thread.root ? fn(thread.root) : null, messages: thread.messages.map(fn) } } : {}),
  });
}

/** Every row this store is drawing, wherever it is drawn. */
function findRow(messageId: number): ConversationMessage | undefined {
  return state.messages.find((item) => item.id === messageId)
    || (state.thread?.root?.id === messageId ? state.thread.root : undefined)
    || state.thread?.messages.find((item) => item.id === messageId);
}

/** Send a failed row again, in place (#2907). */
export async function retrySend(clientKey: string): Promise<void> {
  const entry = unsent.get(clientKey);
  if (!entry) return;
  const queue = pendingByConversation.get(entry.conversationId);
  if (queue) pendingByConversation.set(entry.conversationId, queue.filter((item) => item.idempotencyKey !== clientKey));
  publish({ threadError: null });
  mapRows((item) => item.clientKey === clientKey ? { ...item, pending: true, failed: false } : item);
  await deliver(entry.conversationId, entry.payload);
}

/** Drop a failed row the sender no longer wants to send. */
export function discardFailed(clientKey: string): void {
  const entry = unsent.get(clientKey);
  unsent.delete(clientKey);
  if (entry) {
    const queue = pendingByConversation.get(entry.conversationId);
    if (queue) pendingByConversation.set(entry.conversationId, queue.filter((item) => item.idempotencyKey !== clientKey));
  }
  const keep = (item: ConversationMessage) => !(item.clientKey === clientKey && item.failed);
  const thread = state.thread;
  publish({
    messages: state.messages.filter(keep),
    ...(thread ? { thread: { ...thread, messages: thread.messages.filter(keep) } } : {}),
  });
}

export async function retryPending(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  publish({ online: true });
  for (const [conversationId, queue] of [...pendingByConversation]) {
    const remaining: PendingSend[] = [];
    for (const pending of queue) {
      try {
        const message = await api.sendMessage(conversationId, pending);
        unsent.delete(pending.idempotencyKey);
        sentKeys.set(message.id, pending.idempotencyKey);
      }
      catch { remaining.push(pending); }
    }
    if (remaining.length) pendingByConversation.set(conversationId, remaining);
    else pendingByConversation.delete(conversationId);
  }
  if (state.route.conversationId) await loadThread(state.route.conversationId, true);
  await loadConversations(true);
}

export async function edit(messageId: number, content: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const message = await api.editMessage(conversationId, messageId, content.slice(0, 8000));
  // The server's copy of the edited row, keeping what the row already knew
  // that an edit response does not carry (its thread summary, its client key).
  mapRows((item) => item.id === message.id ? { ...item, ...message, thread: item.thread, clientKey: item.clientKey } : item);
}

export async function react(messageId: number, emoji: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const reactions = await api.toggleReaction(conversationId, messageId, emoji);
  mapRows((item) => item.id === messageId ? { ...item, reactions } : item);
}

/**
 * Delete your own message (#2387). The row becomes the placeholder at once —
 * the server keeps the same placeholder — and comes back if it refuses.
 */
export async function deleteMessage(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const before = findRow(messageId);
  if (!before) return;
  const placeholder = (item: ConversationMessage): ConversationMessage => ({
    ...item, deleted: true, content: '', attachments: [], objects: [], reactions: [], editedAt: null, saved: false,
  });
  mapRows((item) => item.id === messageId ? placeholder(item) : item);
  try {
    const message = await api.deleteMessage(conversationId, messageId);
    if (message) mapRows((item) => item.id === messageId ? { ...placeholder(item), ...message, thread: item.thread } : item);
    void loadConversations(true);
  } catch (error) {
    mapRows((item) => item.id === messageId ? before : item);
    throw error;
  }
}

/**
 * Make a message and everything after it unread (#2387). The conversation's
 * row takes its count back, and it stays unread while it is open (unreadHold)
 * — on a phone the list comes back, the way a mail client leaves a message
 * you have just marked unread.
 */
export async function markUnread(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const { unreadCount } = await api.markUnread(conversationId, messageId);
  unreadHold = conversationId;
  publish({
    conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, unreadCount } : item),
    // The "New" line moves to the message, as the reader asked: the first
    // unread is now the first message from somebody else at or after it.
    ...(unreadCount > 0 && state.route.conversationId === conversationId
      ? { unreadMark: { conversationId, lastReadId: messageId - 1, count: unreadCount } }
      : {}),
  });
  void loadConversations(true);
  // Not from a community's page (#3494): there is no list there to return to.
  if (isMobile() && !state.route.embedded) open(null);
}

/** The address a message link opens (#2387): the conversation, scrolled to it. */
export function messageAddress(conversationId: number, messageId: number): string {
  return `#messages/${conversationId}/m/${messageId}`;
}

/** The address of a reply thread beside its conversation (#2387). */
export function threadAddress(conversationId: number, rootId: number): string {
  return `#messages/${conversationId}/thread/${rootId}`;
}

/**
 * Open a request's thread at one of its messages (the strip's buttons, a
 * news line in the chat with Homeroom bot): the thread pane scrolls to it
 * and flashes it (`threadFocusId`). Without a root it opens the message
 * itself, wherever it is, by its link.
 */
export function openThreadAt(rootId: number | null | undefined, focusId: number | null | undefined = null): void {
  const conversationId = state.route.conversationId;
  if (typeof window === 'undefined' || !conversationId) return;
  if (!validId(rootId)) {
    if (validId(focusId)) openAddress(messageAddress(conversationId, focusId));
    return;
  }
  publish({ threadFocusId: validId(focusId) && focusId !== rootId ? focusId : null });
  openThread(rootId);
}

/** The open conversation's main stream as loaded, for a request's story (./bot-request.ts storyRootIn). */
export function loadedMessages(): readonly ConversationMessage[] {
  return state.messages;
}

/** The thread pane has shown the message it was opened at. */
export function clearThreadFocus(): void {
  if (state.threadFocusId) publish({ threadFocusId: null });
}

/**
 * 31 Oct 2026: in the chat with Homeroom bot, the page a thread off `root`
 * stands for, when it is a request's story rather than a thread of the
 * person's own (./request-page.ts). Null anywhere else.
 */
function requestPageFor(root: ConversationMessage | null | undefined): RequestPage | null {
  if (!root || state.active?.kind !== 'direct' || !threadsAllowed(state.active)) return null;
  return requestPageOf(root);
}

/** Open the thread that hangs off a message of the open conversation. */
export function openThread(rootId: number): void {
  const conversationId = state.route.conversationId;
  if (typeof window === 'undefined' || !conversationId || !validId(rootId)) return;
  // A request's story opens on the request's page, never as a thread here.
  const page = requestPageFor(findRow(rootId));
  if (page) { openRequestPage(page, conversationId); return; }
  // #3494: in its community's page the thread opens beside the room there,
  // with no address of its own: the page's address is the page's.
  if (state.route.embedded) {
    if (state.route.threadRootId !== rootId) publish({ thread: null, route: { ...state.route, threadRootId: rootId } });
    return;
  }
  const target = threadAddress(conversationId, rootId);
  if (window.location.hash === target) route(conversationId, null, null, { threadRootId: rootId });
  else window.location.hash = target;
}

/**
 * #3701: is a reply thread open beside `conversationId`'s room in its
 * community's page (#general on Homeroom's)? The Communities tab pressed
 * while it is lit closes it before it goes any higher
 * (features/workshop/tab-ladder.ts).
 */
export function embeddedThreadOpen(conversationId: number): boolean {
  return !!state.route.embedded && state.route.conversationId === conversationId && !!state.route.threadRootId;
}

/** Close the thread beside the conversation, keeping the conversation open. */
export function closeThread(): void {
  const conversationId = state.route.conversationId;
  replyThreadRequest += 1;
  publish({ thread: null, route: { ...state.route, threadRootId: null } });
  if (typeof window === 'undefined' || !conversationId || state.route.embedded) return;
  const target = `#messages/${conversationId}`;
  if (window.location.hash !== target) {
    try { history.replaceState(null, '', target); } catch { window.location.hash = target; }
  }
}

/**
 * A reply thread's page (#2387): the message it hangs off and its replies.
 * Its own request counter, so a slow thread cannot paint over the next one.
 */
export async function loadReplyThread(conversationId: number, rootId: number, force = false): Promise<void> {
  if (!validId(conversationId) || !validId(rootId)) return;
  const current = state.thread;
  const same = current && current.conversationId === conversationId && current.rootId === rootId;
  if (same && !force && current.messages.length && !current.error) return;
  const request = ++replyThreadRequest;
  publish({
    thread: same && current
      ? { ...current, loading: true, error: null }
      : { conversationId, rootId, root: findRow(rootId) || null, messages: [], loading: true, error: null, nextBefore: null, discussion: null },
  });
  try {
    // Forced: a re-read after a change, from the server (see loadThread).
    const page = await api.listThread(conversationId, rootId, null, { fresh: force });
    if (request !== replyThreadRequest || state.route.threadRootId !== rootId) return;
    if (page.root?.id && page.root.id !== rootId) {
      // In its community's page the thread has no address of its own
      // (#3653): it moves to its canonical root in place.
      if (state.route.embedded) {
        publish({ thread: null, route: { ...state.route, threadRootId: page.root.id } });
        void loadReplyThread(conversationId, page.root.id);
        return;
      }
      openAddress(threadAddress(conversationId, page.root.id));
      return;
    }
    const local = (state.thread?.messages || []).filter((item) => item.id < 0 && item.threadRootId === rootId
      && !page.messages.some((row) => row.sender.id === item.sender.id && row.content === item.content));
    const known = page.messages.map((item) => {
      const key = sentKeys.get(item.id);
      return key ? { ...item, clientKey: key } : item;
    });
    // A link to a request's story from before (a bookmark, a notification)
    // lands on the request's page: the thread is not drawn.
    const story = requestPageFor(page.root || findRow(rootId));
    if (story) {
      closeThread();
      openRequestPage(story, conversationId);
      return;
    }
    publish({
      thread: {
        conversationId, rootId, root: page.root || findRow(rootId) || null,
        messages: [...known.sort((a, b) => a.id - b.id), ...local],
        loading: false, error: null, nextBefore: page.nextBefore,
        // #5219: the request's public discussion behind a bot-card thread, merged in by the pane.
        discussion: page.discussion,
      },
    });
    const newest = known.reduce((top, item) => Math.max(top, item.id), 0);
    if (newest) {
      readWhenThere(`thread:${conversationId}:${rootId}`, conversationId, () => {
        // The newest reply drawn when they are back, in the thread still open.
        if (state.thread?.conversationId !== conversationId || state.thread.rootId !== rootId) return;
        const now = state.thread.messages.reduce((top, item) => Math.max(top, item.id), 0);
        if (now > 0) void markThreadRead(conversationId, rootId, now);
      });
    }
  } catch (error) {
    if (request !== replyThreadRequest) return;
    const thread = state.thread;
    publish({
      thread: thread ? { ...thread, loading: false, error: errorMessage(error, t('messages:store.error.loadReplies')) } : null,
    });
  }
}

/** The thread's earlier replies. */
export async function loadOlderReplies(): Promise<void> {
  const thread = state.thread;
  if (!thread || !thread.nextBefore || thread.loading) return;
  publish({ thread: { ...thread, loading: true } });
  try {
    const page = await api.listThread(thread.conversationId, thread.rootId, thread.nextBefore);
    const now = state.thread;
    if (!now || now.rootId !== thread.rootId) return;
    const known = new Set(now.messages.map((item) => item.id));
    publish({
      thread: {
        ...now,
        loading: false,
        messages: [...page.messages.filter((item) => !known.has(item.id)), ...now.messages].sort((a, b) => (a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id)),
        nextBefore: page.nextBefore,
      },
    });
  } catch (error) {
    const now = state.thread;
    if (now) publish({ thread: { ...now, loading: false, error: errorMessage(error, t('messages:store.error.loadEarlierReplies')) } });
  }
}

/** #2387: fold the list pane away on a desktop, or bring it back. Remembered per device. */
export function setListCollapsed(collapsed: boolean): void {
  if (state.listCollapsed === collapsed) return;
  try { localStorage.setItem('usernode:messages-list-collapsed', collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  publish({ listCollapsed: collapsed });
}

/** #2967: show or hide the channels outside Your apps. Remembered per device. */
export function setShowMoreChannels(show: boolean): void {
  if (state.showMoreChannels === show) return;
  try { localStorage.setItem('usernode:messages-more-channels', show ? '1' : '0'); } catch { /* storage unavailable */ }
  publish({ showMoreChannels: show });
}

/**
 * Toggle the viewer's save on one message.
 *
 * OPTIMISTIC, and for the reason app group chat's toggle is (see
 * GroupChat.toggleBookmark): a save is a personal, instantly reversible act,
 * and a spinner on a bookmark reads as breakage. The flip is published first
 * and reverted if the server refuses, so the button never sits in a state the
 * server disagrees with — and the error is rethrown so the row can say so.
 *
 * The drawer's pinned "Saved" section is fed by the notifications payload, so
 * it only learns about this through a refresh. Notifications is published on
 * `window` by the React bundle; guard for the harnesses where it is absent.
 */
export async function toggleSaved(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const current = findRow(messageId);
  if (!current) return;
  const next = !current.saved;
  const paint = (saved: boolean) => mapRows((item) => item.id === messageId ? { ...item, saved } : item);
  paint(next);
  try {
    await api.setMessageSaved(conversationId, messageId, next);
    const host = window as unknown as { Notifications?: { refresh?: () => void } };
    host.Notifications?.refresh?.();
  } catch (err) {
    paint(!next);
    throw err;
  }
}

/**
 * A reply thread read up to its newest reply (#2387). The server clears that
 * thread's alerts — a reply, a mention in it — and leaves the conversation's
 * own read position alone: thread and main-stream ids interleave. The bell
 * clears the same rows here, and only those.
 */
const threadReadUpTo = new Map<string, number>();

async function markThreadRead(conversationId: number, rootId: number, replyId: number): Promise<void> {
  // Once per new reply: a refresh for a reaction reads nothing new.
  const key = `${conversationId}:${rootId}`;
  if ((threadReadUpTo.get(key) || 0) >= replyId) return;
  threadReadUpTo.set(key, replyId);
  if (typeof window !== 'undefined') window.Notifications?.markConversationThreadRead?.(conversationId, rootId);
  try { await api.markRead(conversationId, replyId); } catch { /* the next open reads it again */ }
}

/**
 * A MESSAGE IS READ WHEN SOMEBODY IS THERE TO READ IT (5 October, Page
 * Turners). A conversation open on screen used to be read up to its newest
 * message the moment one landed, whoever was looking: a background tab, an
 * app whose socket outlived the screen, a phone left on the table. Alex
 * approved his first version from his chat with Homeroom bot and put the
 * phone down; "Page Turners is live" landed in that open chat four minutes
 * later and was read on the spot, which cleared its bell row and the
 * Messages badge (both read off the same cursor,
 * services/conversations.js markRead) before he ever looked.
 *
 * Now a read waits while the page is hidden or nobody has touched it for
 * PRESENCE_MS, and happens when they are back: their next touch, key,
 * scroll or return to the page (initializeMessagesStore), if that
 * conversation is still on screen and not marked unread. Opening a
 * conversation is touching the page, so an open still reads at once; a
 * conversation left before they came back stays unread, as it should.
 */
const PRESENCE_MS = 2 * 60 * 1000;
let lastPresence = Date.now();
const heldReads = new Map<string, { conversationId: number; read: () => void }>();

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function someoneThere(): boolean {
  return !pageHidden() && Date.now() - lastPresence < PRESENCE_MS;
}

/** Run `read` now if somebody is there, or when they are back (notePresence). The newest wins per `key`. */
function readWhenThere(key: string, conversationId: number, read: () => void): void {
  if (someoneThere()) {
    heldReads.delete(key);
    read();
    return;
  }
  heldReads.set(key, { conversationId, read });
}

/** The open conversation read up to its newest message drawn, then. */
function readMainWhenThere(conversationId: number): void {
  readWhenThere(`main:${conversationId}`, conversationId, () => {
    if (state.route.conversationId !== conversationId || state.nextAfter) return;
    const last = newestMainId(state.messages);
    if (last) void markRead(last);
  });
}

/**
 * Somebody used the page (or came back to it): reads that waited for them
 * happen now, for the conversation still on screen.
 */
export function notePresence(): void {
  if (pageHidden()) return;
  lastPresence = Date.now();
  if (!heldReads.size) return;
  const held = [...heldReads.values()];
  heldReads.clear();
  for (const item of held) {
    if (onScreen(item.conversationId) && unreadHold !== item.conversationId) item.read();
  }
}

export async function markRead(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const items = state.conversations.map((item) => item.id === conversationId ? { ...item, unreadCount: 0 } : item);
  publish({ conversations: items });
  notifyConversationRead(conversationId);
  try { await api.markRead(conversationId, messageId); } catch { /* next open reconciles */ }
}

function eventConversationId(event: ConversationEvent): number | null {
  return api.strictId(event.conversationId ?? event.conversation_id);
}

/** Is this conversation's thread drawn — on this screen, or in its community's page (#3494)? */
function onScreen(conversationId: number): boolean {
  return showing() && state.route.conversationId === conversationId;
}

/** Is anything of this store's on screen: the Messages screen, or a room embedded in its community's page? */
function showing(): boolean {
  return state.route.open || !!state.route.embedded;
}

/**
 * Re-read everything this store draws, from the server (#3705): the inbox
 * and, when one is on screen, the conversation and the thread open beside it.
 *
 * Two callers, both of which used to stop at the inbox. A reconnect of the
 * events socket (App.resyncCurrentView): a message that arrived while it was
 * down — a phone locked, a network handed over — had its event dropped, and
 * the conversation open in front of the reader never read it. And the service
 * worker's late-answer correction (App.refreshActiveScreen): a conversation
 * opened on a slow link is drawn from the worker's offline copy after a
 * second, and the worker's word that the server has since said otherwise had
 * nothing on this screen listening to it.
 *
 * #8 (WP3): and, in the Homeroom bot's DM, its activity tray and cards
 * (./bot-work.tsx, ./bot-activity-store.ts): their reads are the worker's to
 * correct too, and the header's status line read from a stale copy said
 * "Working on…" for work long done. Through the window event both already
 * re-read on, fresh: this module cannot import them, since the cards' store
 * imports this one.
 */
export async function resync(): Promise<void> {
  void loadAppDiscussions();
  const reads = [loadConversations(true)];
  const conversationId = state.route.conversationId;
  if (conversationId && onScreen(conversationId)) {
    reads.push(loadThread(conversationId, true));
    const rootId = state.route.threadRootId;
    if (rootId && state.thread?.rootId === rootId) reads.push(loadReplyThread(conversationId, rootId, true));
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(WORK_CHANGED_EVENT));
  }
  await Promise.all(reads);
}

export function handleEvent(raw: ConversationEvent): void {
  const event = raw || { type: '' };
  const conversationId = eventConversationId(event);
  if (!conversationId) return;
  switch (event.type) {
    case 'conversation_message_created':
    case 'conversation_message_updated': {
      // Realtime deliberately carries ids only: hydrated messages and shared
      // object cards must be resolved under this viewer's REST permissions.
      // A reply inside a thread (#2387) re-reads that thread when it is the
      // one open, and the conversation either way — the reply count on the
      // message the thread hangs off is the conversation's to draw.
      const rootId = api.strictId(event.threadRootId ?? event.thread_root_id);
      if (onScreen(conversationId)) {
        const load = loadThread(conversationId, true);
        // The open thread's own read, when the message is in it: a stop
        // typed there holds its line until that read has drawn it too.
        const threadLoad = rootId && state.thread?.rootId === rootId
          ? loadReplyThread(conversationId, rootId, true) : null;
        if (event.type === 'conversation_message_created') {
          landing.set(conversationId, (landing.get(conversationId) || 0) + 1);
          const landed = () => {
            const left = (landing.get(conversationId) || 1) - 1;
            if (left > 0) { landing.set(conversationId, left); return; }
            landing.delete(conversationId);
            releaseHeldTyping(conversationId);
          };
          void Promise.all([load, threadLoad]).then(landed, landed);
        }
      }
      void loadConversations(true);
      break;
    }
    case 'conversation_reaction_updated': {
      const messageId = api.strictId(event.messageId ?? event.message_id);
      if (!messageId) break;
      // Like message create/edit, reaction realtime is intentionally id-only.
      // Rehydrate under this viewer's current membership/block permissions.
      if (onScreen(conversationId)) {
        void loadThread(conversationId, true);
        // A reply in the open thread pane (#2387), or its first message.
        const thread = state.thread;
        if (thread && thread.conversationId === conversationId
            && (thread.rootId === messageId || thread.messages.some((item) => item.id === messageId))) {
          void loadReplyThread(conversationId, thread.rootId, true);
        }
      }
      break;
    }
    case 'conversation_read':
      void loadConversations(true);
      // The reader's OWN other tabs, and only those: the event goes to every
      // member, and someone else reaching the end of the thread has cleared
      // nothing of this viewer's.
      // …and not when the reader marked it UNREAD (#2387): that moved the
      // cursor back, and nothing in the bell was read by it.
      if (api.strictId(event.userId ?? event.user_id) === currentUser().id && event.unread !== true) {
        // A thread read clears that thread's alerts only (#2387).
        const threadRoot = api.strictId(event.threadRootId ?? event.thread_root_id);
        if (threadRoot) window.Notifications?.markConversationThreadRead?.(conversationId, threadRoot);
        else notifyConversationRead(conversationId);
      }
      break;
    case 'conversation_membership_changed':
      void loadConversations(true);
      if (state.route.conversationId === conversationId) {
        // A removal, departure, or either-side block can make the active
        // conversation 404. Treat that as revocation: discard retained local
        // content and return to the list instead of showing a stale thread.
        void refreshActiveAfterMembershipChange(conversationId);
      }
      break;
    case 'conversation_typing': {
      const userId = api.strictId(event.userId ?? event.user_id);
      // The wire event carries no profile data. Resolve the active member
      // locally so a typing event cannot smuggle a stale/unauthorized name.
      const typist = state.active?.id === conversationId
        ? state.active.members.find((member) => member.id === userId && member.status === 'member') || null
        : null;
      const username = typist?.username || '';
      // B5: the bot types as its name, "Homeroom bot is typing…".
      const botPeer = state.active?.id === conversationId && state.active.peer?.bot && state.active.peer.id === userId
        ? state.active.peer.displayName || '' : '';
      if (!userId || userId === currentUser().id || !username) break;
      // Where they type: the main stream, or the thread the event names.
      const scope = scopeKey(conversationId, api.strictId(event.threadRootId ?? event.thread_root_id) || null);
      const current = state.typing[scope] || [];
      const expiryKey = `${scope}:${userId}`;
      const existingExpiry = typingExpiry.get(expiryKey);
      if (existingExpiry && typeof window !== 'undefined') window.clearTimeout(existingExpiry);
      typingExpiry.delete(expiryKey);
      heldTyping.delete(expiryKey);
      const shown = botPeer || username;
      const isShown = current.some((entry) => entry.name === shown);
      // #4220: a stop while the message it typed is still being read keeps
      // the line until that read publishes (releaseHeldTyping), or the cap.
      if (event.typing === false && landing.get(conversationId) && isShown && typeof window !== 'undefined') {
        heldTyping.set(expiryKey, { conversationId, scope, shown });
        typingExpiry.set(expiryKey, window.setTimeout(() => {
          typingExpiry.delete(expiryKey);
          heldTyping.delete(expiryKey);
          dropTyping(scope, shown);
        }, TYPING_HOLD_MS));
        break;
      }
      const holdersKey = `${scope}:${shown}`;
      let next: Typist[];
      if (event.typing === false) {
        // The word leaves the line, and with it everybody typing under it.
        typingHolders.delete(holdersKey);
        next = current.filter((entry) => entry.name !== shown);
      } else {
        const holders = typingHolders.get(holdersKey) || new Map<number, boolean>();
        holders.set(userId, !botPeer && !!typist?.unnamed);
        typingHolders.set(holdersKey, holders);
        // The stand-in only while every holder is nameless: a real account under the same word is named.
        // 1 Nov 2026: the bot, with what it says it is doing (its card's words);
        // nobody else's event carries that.
        const entry: Typist = botPeer
          ? { name: shown, unnamed: false, bot: true, doing: botDoingOf(event.doing) }
          : { name: shown, unnamed: [...holders.values()].every(Boolean) };
        next = isShown ? current.map((each) => (each.name === shown ? entry : each)) : [...current, entry];
      }
      publish({ typing: { ...state.typing, [scope]: next } });
      if (event.typing !== false && typeof window !== 'undefined') {
        typingExpiry.set(expiryKey, window.setTimeout(() => {
          typingExpiry.delete(expiryKey);
          dropTyping(scope, shown);
        }, 6000));
      }
      break;
    }
  }
}

function dropTyping(scope: ComposerScope, shown: string): void {
  const now = state.typing[scope] || [];
  const next = now.filter((entry) => entry.name !== shown);
  if (next.length === now.length) return;
  typingHolders.delete(`${scope}:${shown}`);
  publish({ typing: { ...state.typing, [scope]: next } });
}

/** #4220: the message the held names were typing has been drawn. */
function releaseHeldTyping(conversationId: number): void {
  for (const [key, held] of [...heldTyping]) {
    if (held.conversationId !== conversationId) continue;
    heldTyping.delete(key);
    const timer = typingExpiry.get(key);
    if (timer && typeof window !== 'undefined') window.clearTimeout(timer);
    typingExpiry.delete(key);
    dropTyping(held.scope, held.shown);
  }
}

/** The names on a conversation's typing line, or a thread's in it, in the order they came. */
export function typingUsers(conversationId: number, threadRootId: number | null = null): Typist[] {
  return state.typing[scopeKey(conversationId, threadRootId)] || [];
}

/** That the viewer is typing, or stopped, in the open conversation, or in a thread of it (`threadRootId`). */
export function notifyTyping(typing: boolean, threadRootId: number | null = null): void {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const scope = scopeKey(conversationId, threadRootId);
  const now = Date.now();
  if (typing && now - (typingSentAt.get(scope) || 0) < 1800) return;
  // "Stopped typing" is only news after "typing" was sent. The composer
  // says it on blur and on unmount, and its unmount for one conversation
  // runs after the route has already moved to the next one — so without
  // this a hop between threads pinged a conversation nobody had typed in,
  // which the demo routes answer with a 404 and the check harness counts
  // as a console error.
  if (!typing && !typingSentAt.get(scope)) return;
  typingSentAt.set(scope, typing ? now : 0);
  void api.setTyping(conversationId, typing, threadRootId).catch(() => { /* ephemeral */ });
}

export async function share(reference?: SharedObjectReference): Promise<void> {
  if (typeof window === 'undefined') return;
  const conversationId = state.route.conversationId;
  pendingShare = reference || null;
  open(conversationId || null);
  // With a current destination the mounted composer consumes this event
  // synchronously. On the bare list, retain pendingShare until selecting or
  // creating a conversation changes the composer route to a nonzero id.
  if (conversationId) {
    window.dispatchEvent(new CustomEvent('usernode:messages-share', { detail: pendingShare }));
  }
}

/**
 * #3660: a card posted straight into a conversation from outside it — the
 * Share to… dialog (./share-to-dialog.tsx) — with the sharer's note as its
 * words. Not `send()`, which writes into whichever conversation is open:
 * this one names its destination. The server checks the sharer can see the
 * card, and each reader's view of it, exactly as for a card shared from the
 * composer. When that conversation is the one on screen the message is
 * drawn at once, as the composer's own send draws it; either way the inbox
 * is re-read so the conversation moves to the top.
 */
export async function shareToConversation(conversationId: number, object: SharedObjectReference, note = ''): Promise<void> {
  if (!validId(conversationId)) throw new Error(t('messages:store.error.chooseConversation'));
  const message = await api.sendMessage(conversationId, {
    content: note.trim().slice(0, 8000),
    object,
    idempotencyKey: idempotencyKey(),
  });
  if (state.route.conversationId === conversationId && message.id > 0) {
    publish({
      messages: state.messages
        .filter((item) => item.id !== message.id)
        .concat(message)
        .sort(transcriptOrder),
    });
  }
  await loadConversations(true);
}

export function takePendingShare(): SharedObjectReference | null | undefined {
  const value = pendingShare;
  pendingShare = undefined;
  return value;
}

/**
 * Repaint one message's save state from OUTSIDE this feature.
 *
 * The notifications drawer can unsave a message from its pinned section, and
 * when that conversation happens to be open the star behind it must stop being
 * filled. This is the Messages twin of GroupChat._paintBookmark, and it works
 * the same way: it writes the MODEL and lets the component re-render, rather
 * than reaching for the button — the row is React's, and a direct DOM write
 * would be a second author that the next publish silently reverted.
 *
 * A no-op when that message is not on screen, which is the common case.
 */
function paintSaved(messageId: number, saved: boolean): void {
  if (!state.messages.some((item) => item.id === messageId)) return;
  publish({
    messages: state.messages.map((item) => (
      item.id === messageId ? { ...item, saved } : item
    )),
  });
}

export const messagesController = {
  open,
  // B8: the chat with Homeroom bot (app-view.js's doors to it).
  openBot: (reference?: StagedObject | null) => { void openBot(reference); },
  // 16 Oct 2026: a request's page's See progress, at the request's own thread.
  openBotRequest: (slug: string, number: number) => { void openBotRequest(slug, number); },
  // #6019: one of the bot chat's threads, on the bot's tab (1 Nov 2026: ../ai/door.ts).
  openBotThread: (rootId: number) => { openBotTab({ threadRootId: rootId, focusMessageId: null }); },
  // B6: the App tab's Change something, under a first version's plan.
  quoteBotMessage: (conversationId?: number | null, messageId?: number | null) => { void quoteBotMessage(conversationId, messageId); },
  openAddress,
  openDiscussion,
  openThread,
  closeThread,
  openAgentThread,
  route,
  close,
  isOpen,
  handleBack,
  syncChrome,
  handleEvent,
  refreshBlockedView: (userId: number, blocked: boolean) => { void refreshBlockedView(userId, blocked); },
  share,
  paintSaved,
  // #2783: the channel directory, for the app chat's `#name` chips and its
  // `#` autocomplete (public/js/group-chat.js), and the link resolver.
  channels,
  openChannel,
  // #3653: what the router asks before it draws a channel on this screen.
  channelTarget,
  channelHubSlug,
  refresh: () => {
    void loadAppDiscussions();
    return loadConversations(true);
  },
  // #3705: the inbox AND the conversation on screen (see resync).
  resync,
  showing,
};

export function initializeMessagesStore(): () => void {
  const onOnline = () => { void retryPending(); };
  const onOffline = () => publish({ online: false });
  // #2783: the app channels too, so a `#name` for one chips in any chat — an
  // app's own discussion included — before Messages has ever been opened.
  const onAuthed = () => { void loadConversations(); void loadAppDiscussions(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  // 5 October: somebody using the page, or coming back to it, is somebody
  // there to read what is open (notePresence, readWhenThere). Captured and
  // passive: it only notes the time, and never stands in a gesture's way.
  const PRESENCE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll', 'focus'];
  const presence = { capture: true, passive: true };
  const onPresence = () => { notePresence(); };
  for (const type of PRESENCE_EVENTS) window.addEventListener(type, onPresence, presence);
  document.addEventListener('visibilitychange', onPresence);
  // The header's title is written from here: say it again in the language on screen.
  const onLanguage = () => { if (state.route.open) syncChrome(); };
  document.addEventListener('homeroom:language-changed', onLanguage);
  // The store is always mounted, but the endpoint is session-gated. Seed the
  // conversation list as soon as an already-resolved user exists, or wait for
  // the shell's one-shot authenticated boot event on an anonymous document.
  //
  // It also seeds the Messages tab's unread badge (#2794, see syncTabBadge),
  // which is why it runs on every signed-in load and not only when the
  // screen opens — and a warm list is the difference between Messages
  // opening populated and opening on a spinner.
  if (window.App?.user) void loadConversations();
  else document.addEventListener('sv:authed', onAuthed, { once: true });
  if (window.App?.user) void loadAppDiscussions();
  // #2387 / #2967: the two layout preferences, read after mount so the first
  // render matches the prerendered shell. The folded sections are the third,
  // remembered the same way.
  let listCollapsed = false;
  let showMoreChannels = false;
  let folded: InboxSection[] = [];
  try {
    listCollapsed = localStorage.getItem('usernode:messages-list-collapsed') === '1';
    showMoreChannels = localStorage.getItem('usernode:messages-more-channels') === '1';
    folded = savedFolded(localStorage.getItem('usernode:messages-folded'));
  } catch { /* storage unavailable */ }
  publish({ online: navigator.onLine, demo: browserDemo(), listCollapsed, showMoreChannels, folded });
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    for (const type of PRESENCE_EVENTS) window.removeEventListener(type, onPresence, presence);
    document.removeEventListener('visibilitychange', onPresence);
    document.removeEventListener('homeroom:language-changed', onLanguage);
    document.removeEventListener('sv:authed', onAuthed);
  };
}
