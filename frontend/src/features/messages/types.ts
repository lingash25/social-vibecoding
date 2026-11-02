import type { ReleaseOutlook } from '../../lib/release-eta';
import type { UnreadMark } from './unread-anchor';

/**
 * `channel` is a room every user is in (#2783) — today only #general. It has
 * no roster (just a count), no owner and no invitations.
 */
export type ConversationKind = 'direct' | 'group' | 'channel';
export type MembershipStatus = 'invited' | 'member' | 'declined' | 'left' | 'removed';
export type MemberRole = 'owner' | 'member';

export interface ConversationUser {
  id: number;
  username: string;
  /** `username` is the stand-in for a person whose username did not come with the row. */
  unnamed?: boolean;
  avatarUrl?: string | null;
  /** A platform account (the Homeroom bot), not a person (#3624). */
  bot?: boolean;
  /** B5: a platform account's name, shown in place of its handle ("Homeroom bot"). */
  displayName?: string;
}

/**
 * #3624: the structured part of a message from the Homeroom bot. Every one
 * about a request says which; a question carries the answers to tap, the
 * default first, and its state (open until answered, or closed when newer
 * news on the request replaced it). `mirrors`: a reply to it is posted on
 * the request's public discussion.
 */
/** #6071: a comment pinned on a design's preview: the version, the point as fractions of its drawn size, what was under it. */
export interface DesignPin {
  version: number;
  x: number;
  y: number;
  element?: { tag: string; id: string; text: string };
}

/**
 * Homeroom bot parity (P1-P9): a card the bot put under a reply beyond its
 * request, change and project cards: options to pick from, a question set,
 * a table, a batch, a confirm card, a gallery, an investigation, … Drawn by
 * ./bot-cards/ (one component per `type`), tapped through
 * POST /api/conversations/homeroom-bot/cards/:messageId.
 */
export interface HomeroomBotCard {
  type: string;
  v?: number;
  [field: string]: unknown;
}

/**
 * Homeroom bot parity, P1: what a reply looked at, as one line above its
 * words (./bot-looked.tsx): each thing in plain words, and how long the
 * answer took, in milliseconds.
 */
export interface HomeroomBotLooked {
  items: Array<{ what: string }>;
  ms: number | null;
}

export interface HomeroomBotMeta {
  kind: string;
  /** Homeroom bot parity (P1-P9): the reply's card, drawn by ./bot-cards/. */
  card?: HomeroomBotCard;
  /** Homeroom bot parity, P1: what the reply looked at (./bot-looked.tsx). */
  looked?: HomeroomBotLooked;
  /** #6071: a design thread's version this message says (kind 'design_version'). */
  designVersion?: number;
  /** #6071: the screen a design thread is of (kind 'opened_design', and 1 Nov 2026 a version's and a drawn thread's line). */
  designTitle?: string;
  /** #6071 follow-up: what a thread from the bot's "+" is for (kind 'opened_thread'); none is any kind of change. 1 Nov 2026: 'project', a new project's thread. */
  changeKind?: 'fix' | 'add' | 'design' | 'project';
  /** 1 Nov 2026: what a thread opened from a request's or change's page is about (kind 'opened_about'): never `issueNumber`, which would make it the request's story. */
  aboutKind?: 'request' | 'change';
  aboutNumber?: number;
  aboutTitle?: string;
  appSlug?: string;
  appName?: string;
  issueNumber?: number;
  issueTitle?: string;
  firstVersion?: boolean;
  mirrors?: boolean;
  question?: string;
  answers?: string[];
  status?: 'open' | 'answered' | 'closed';
  answer?: string;
  link?: string;
  // B3: the decision a message's `server` buttons settle
  // (homeroom_bot_dm_actions.id), the buttons themselves, and which one was
  // chosen. An activity card's start and its live state ride along too.
  actionId?: number;
  actions?: HomeroomBotAction[];
  chosen?: string;
  startedAt?: string;
  live?: boolean;
  /** B4: an activity card's request, in the words its person asked for it. */
  askedText?: string;
  /** #3870: a ready card's change, by its own title (its proposal's). */
  changeTitle?: string;
  /** B5: the bot's hello, which leads the card it introduces. */
  hello?: string;
  /**
   * B6: a first version's plan (kind `plan`): its bullets and up to two
   * choices, each with its suggested answer first. Built by Build it
   * (`actionId`); `choices` are the answers it went with.
   */
  plan?: HomeroomBotPlan;
  /** B6: a question post that asks two at once, and the words above them. */
  questions?: HomeroomBotPlanQuestion[];
  lead?: string;
  /** B6: why a plan's buttons went: a newer plan, a week with no tap, or a reply asking for changes. */
  replaced?: boolean;
  stopped?: boolean;
  changing?: boolean;
  choices?: string[];
  /**
   * B7: a change ready to try (kind `proposal`), drawn as its card: whether
   * others are in its project, whether the person's Yes would be the last
   * one needed, and who else it waits on. `sessionId` and `epoch` are the
   * change and the version the card was sent for; `updated` when a newer
   * version's card replaced it.
   */
  ready?: HomeroomBotReady;
  sessionId?: number;
  epoch?: number;
  updated?: boolean;
  /**
   * B6: an activity card Build it moved under its plan: the card that
   * follows the request now. This one is no longer drawn.
   */
  movedTo?: number;
  /**
   * #4392: the activity card Build it moved under a plan, drawn as the bot's
   * thanks for answering: its words over the project's thumbnail row
   * (./bot-thanks-card.tsx), the project's icon (`appEmoji`) as its tile.
   */
  thanks?: boolean;
  appEmoji?: string;
  /** B7: once its person approved it, what happens next (services/homeroom-bot-dm.js goesLiveAfterYes). */
  goesLive?: HomeroomBotGoesLive;
  /** Why its buttons were closed ("No longer needed", "A newer plan replaced this"), said in their place. */
  closedWhy?: string;
  /**
   * One request, one story: the request's activity card (its thread's root)
   * that this message was posted under. Set on every message in a request's
   * thread, as the message's own `threadRootId` is.
   */
  threadRootId?: number;
  /**
   * Which of the four moments that ring this is (`needs_you`, `ready`,
   * `stopped`, `on_hold`, `live`), `reply` for the bot's own replies, or
   * absent for a quiet one; `said` is its variant (services/homeroom-bot-
   * dm.js). The bell and the push word them; the chat draws the message.
   */
  moment?: string;
  said?: string;
  /** The request's title, as the request page has it; absent for a first version. */
  requestTitle?: string;
  /** Who a ready change waits on ("you and @ada"), as the push says it. */
  waiting?: string;
  /** An on-hold summary: how many of the person's requests are held. */
  count?: number;
  /** A moment in a request's thread the main chat also lists, under its "↳ in …" label. */
  alsoInChat?: boolean;
  /**
   * 1 Nov 2026 (C2.4): the new project a design's card offers to make (kind
   * `make_offer`): its name, the design's thread and version. Once made, the
   * project it made (`madeSlug`, `madeName`).
   */
  makeProject?: { name: string; rootId: number; version: number | null };
  madeSlug?: string;
  madeName?: string;
}

export interface HomeroomBotReady {
  group: boolean;
  last: boolean;
  waitingOn: string[];
  more: number;
  /**
   * How many more approvals it needed when the card was sent (0 when it had
   * them), and how many it needs in all (homeroom-bot-dm.js approvalState).
   * With fewer needed than the people listed, the card says how many and
   * that any of them will do (./approval-words.ts). Absent on older cards.
   */
  missing?: number;
  needed?: number;
  /**
   * What does not work yet: the declared changes its before & after shots
   * showed failing, after the bot's own fix round (homeroom-bot-dm.js
   * tellReady). The card then says so instead of "ready to try".
   */
  broken?: string[];
}

/**
 * B7: what happens next to a change its person approved. `soon`: nothing
 * more is needed, it goes live in a minute or two. Otherwise it needs
 * `missing` more Yes votes (0 when only its clock runs), from `waitingOn`
 * (up to three names) and `more` others, and `at` is when it goes live
 * anyway if nobody objects, when a clock runs on it.
 */
export interface HomeroomBotGoesLive {
  soon: boolean;
  at: string | null;
  missing: number;
  waitingOn: string[];
  more: number;
}

/** B6: one of a plan's choices, or one of two questions: the suggested answer first. */
export interface HomeroomBotPlanQuestion {
  question: string;
  answers: string[];
}

export interface HomeroomBotPlan {
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  /**
   * #4488: a complicated change on a project that already exists, checked
   * with the person who asked for it before it is built. Its spec (with its
   * before and after screens) is on the request, whose card goes under it.
   */
  complicated?: boolean;
  spec?: { sessionId: number; version: number } | null;
}

/**
 * B3: one of a bot message's buttons. `server` is decided by the action
 * endpoint, once (store.tapBotAction); `open` goes to an in-app address
 * (`target`, always `#app/…`); `prompt` sends its label as the person's own
 * message. At most three, at most one `primary`.
 */
export interface HomeroomBotAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary';
  /**
   * B7: `preview` opens a change's preview, `vote` casts the person's own Yes, `reply` quotes the card.
   * #4231: `invite` opens the invite sheet for the message's project (`appSlug`), in place.
   * #5506: `withdraw` has the bot withdraw the change (`sessionId`), drawn by
   * the ready card itself when its reader may (HomeroomBotReadyNow.canWithdraw).
   * 1 Nov 2026: `design` (the screen picker) retired: the bot draws a screen from words.
   * `make` opens the sheet that makes the project a design's card offers
   * (`makeProject`), in place (./bot-make.tsx).
   */
  type: 'server' | 'open' | 'prompt' | 'preview' | 'vote' | 'reply' | 'invite' | 'withdraw' | 'make';
  target?: string;
  sessionId?: number;
  epoch?: number;
  /**
   * #5506: a `preview` for someone who does not build on the project: it
   * opens the look-only preview, the one a non-builder may open.
   */
  readOnly?: boolean;
  /**
   * #4097 follow-up: a `prompt` sent replying to the message it sits on, so it
   * is about what that message is about ("Try again" under a build that did
   * not finish). Any other prompt is sent on its own.
   */
  quote?: boolean;
}

/**
 * #3692: the Homeroom bot's work for the viewer, as its DM's activity tray
 * reads it (services/homeroom-bot-tray.js). An entry is one request of
 * theirs, or a project's first version, and appears once: in `now` while
 * the bot has it in hand, in `needsYou` while it waits on them, else in
 * `history`. `href` is where it opens (its proposal once people can open
 * one, else the request), and `links` each place a tile offers; null for
 * one that opens nowhere (the staging demo's). `earlier` is the request's
 * other runs, newest first.
 */
export type HomeroomBotPhase =
  | 'setting_up' | 'queued' | 'looking' | 'building' | 'follow_up_queued' | 'following_up' | 'merging';

export interface HomeroomBotLinks {
  request: string | null;
  proposal: string | null;
  project: string | null;
}

/** One of an entry's earlier runs: what came of it, and when. */
export interface HomeroomBotRun {
  id: number;
  outcome: HomeroomBotActivityOutcome;
  at: string | null;
}

export interface HomeroomBotJob {
  key: string;
  appSlug: string | null;
  appName: string;
  /** `appName` is the stand-in for a project with neither a name nor a slug. */
  appUnnamed?: boolean;
  /** #4201: the app's own icon, `/app-icons/<id>`, else null. */
  iconUrl: string | null;
  /** #4201: the app's emoji icon, for an app with no image; else null. */
  iconEmoji: string | null;
  issueNumber: number | null;
  title: string | null;
  firstVersion: boolean;
  href: string | null;
  links: HomeroomBotLinks;
  earlier: HomeroomBotRun[];
  /**
   * Going live (Now's `merging`, or an ending of `going_live`), on a merge
   * of the platform's own app: when the platform's next release carries it
   * (services/release-watch.js), which the tray words. Absent otherwise.
   */
  release?: ReleaseOutlook;
  /**
   * One request, one story (services/homeroom-bot-tray.js threadsOf): the
   * request's card in the chat with the bot, the root of its thread.
   */
  cardId?: number;
  /** Its newest message there still waiting on the person: what the strip's Needs you button opens. */
  ask?: HomeroomBotAsk;
  /** Its newest "ready to try" card there, and what that card's buttons do. */
  ready?: HomeroomBotReadyRef;
  /** A build that stopped: why (as an activity card's `stopCause`). */
  stopCause?: HomeroomBotActivity['stopCause'];
}

/** The newest message about a request still waiting on its person (tray entry `ask`). */
export interface HomeroomBotAsk {
  messageId: number | null;
  /** question, followup_ask, plan, person, blocked, empty, build_failed, checks, needs_look, first_version_failed. */
  kind: string;
  said?: string;
  /** A question's own words. */
  question?: string;
}

/** A request's newest "ready to try" card (tray entry `ready`). */
export interface HomeroomBotReadyRef {
  messageId: number | null;
  sessionId: number | null;
  epoch: number;
  /** Its buttons are still open. */
  open: boolean;
  /** The person's yes would count: Approve is theirs to press. */
  approve: boolean;
  /** Who it waits on ("@ada"), when not on them. */
  waiting: string | null;
}

/** What the bot is doing for them now: its step of the request's steps, what it is doing, since when. */
export interface HomeroomBotCurrentJob extends HomeroomBotJob {
  phase: HomeroomBotPhase;
  /** The progress stage it is at (reading, planning, building, on_hold…), when the server says. */
  stage?: string | null;
  step: number | null;
  of: number | null;
  stepName: string | null;
  doing: string | null;
  since: string | null;
}

/**
 * A request the bot is not working on now: what came of it last, and when.
 * `outcome` is null only for something waiting on them that no run says
 * (a new project waiting for its secrets), which `doing` words instead.
 */
export interface HomeroomBotPastJob extends HomeroomBotJob {
  id: number;
  outcome: HomeroomBotActivityOutcome | null;
  doing: string | null;
  at: string | null;
}

export interface HomeroomBotWork {
  now: HomeroomBotCurrentJob[];
  needsYou: HomeroomBotPastJob[];
  history: HomeroomBotPastJob[];
  /**
   * 16 Oct 2026: one track per request (services/homeroom-bot-track.js),
   * which every surface draws. Absent from an older server's answer.
   */
  tracks?: BotTrack[];
}

/**
 * Where a request the Homeroom bot has is, as one track every surface draws
 * the same way (services/homeroom-bot-track.js). A loop: queued, planning,
 * building, checks, vote, going live, live, going back to `waiting` (on the
 * person) for a question and to `building` for its next try; or held at a
 * limit, stopped, done another way, or closed. Codes only: the client words
 * them (./bot-track.tsx).
 */
export type BotTrackState =
  | 'queued' | 'planning' | 'waiting' | 'building' | 'checks' | 'vote' | 'going_live' | 'live'
  | 'held' | 'stopped' | 'done_elsewhere' | 'closed';
export type BotTrackStep = 'plan' | 'build' | 'checks' | 'vote' | 'live';

export interface BotTrack {
  key: string;
  appSlug: string | null;
  appName: string;
  appUnnamed?: boolean;
  iconUrl: string | null;
  iconEmoji: string | null;
  issueNumber: number | null;
  title: string | null;
  firstVersion: boolean;
  state: BotTrackState;
  /** The step of the five its bar lights, or null for one before them all. */
  step: BotTrackStep | null;
  /** Why it is where it is, as a code (bot.track.why.*), or null. */
  why: string | null;
  waitingOn: 'you' | 'group' | null;
  /**
   * Who a track waiting on "you" waits on, by username, where it is drawn
   * for somebody else (a request's page: homeroom-bot-track.js forViewer).
   */
  waitingFor?: string;
  /** The bot is working on it this minute. */
  busy: boolean;
  /** Which try it is on: 2 after its checks failed once and it built again. */
  try: number;
  /** When this try's work began: its clock. */
  tryStartedAt: string | null;
  /** When each try began, oldest first, for a request with more than one. */
  tryStarts: string[];
  since: string | null;
  /** The root of its thread in the chat with the bot, when known. */
  rootId: number | null;
  /** Its message still waiting on the person, when there is one. */
  askId: number | null;
  /** Its change up for a vote, when there is one. */
  proposalId: number | null;
  /** The session its plan and change live in. */
  sessionId: number | null;
  links: HomeroomBotLinks;
  /** `by`: who has it, for a request a person took (limit 'taken'). */
  held?: { limit: string; position: number | null; until: string | null; by?: string | null };
  queue?: { ahead: number };
  doneBy?: { username: string | null; prNumber: number | null };
  release?: ReleaseOutlook;
}

/** One request in the slots view: what it is, and its track. */
export interface BotSlotEntry {
  /** In a slot: a change or a build. Up next: in the queue, or an older request. */
  kind?: 'proposal' | 'build' | 'queued' | 'older';
  /** An older request: what the bot's trial run made of it (a verdict code), or null. */
  trial?: string | null;
  issueNumber: number | null;
  title: string | null;
  /** Who asked for it, when the bot knows. */
  askedBy?: string | null;
  /** A line of what it asks, in the person's own words. */
  excerpt?: string | null;
  /** Who has it, for one a person took (BotSlotsView.taken). */
  by?: string | null;
  position?: number | null;
  limit?: string | null;
  since?: string | null;
  until?: string | null;
  track: BotTrack | null;
}

/** A project's bot slots (GET /api/apps/:slug/homeroom-bot/slots). */
export interface BotSlotsView {
  app: { slug: string; name: string };
  botOn: boolean;
  acts: boolean;
  paused: boolean;
  cap: number;
  buildsAtOnce: number | null;
  slots: BotSlotEntry[];
  waiting: BotSlotEntry[];
  /** Held requests a person has now: the bot leaves them alone. */
  taken: BotSlotEntry[];
  onHold: BotSlotEntry[];
  /** Every other open request, by where the bot is on it (16 Oct 2026). */
  waitingOn: BotSlotEntry[];
  upNext: BotSlotEntry[];
  stopped: BotSlotEntry[];
  leftToPeople: BotSlotEntry[];
  /** Open requests people have taken on, counted only. */
  withPeople: number;
  reading: number;
  week: { limited: boolean; usedShare: number | null; usedUp: boolean; resetsAt: string | null } | null;
}

/**
 * #3736: one activity card in the bot's DM, drawn in the message the bot
 * sent when it started a piece of work for the viewer (metadata kind
 * `activity`), with that work's state as services/homeroom-bot-activity.js
 * reads it. While `working`: the step it is at of the request's steps, and
 * what it is doing. Once `done`: what it came to, and when, where the
 * records say. Links are in-app addresses, or null.
 */
export type HomeroomBotActivityOutcome =
  | 'question' | 'proposed' | 'live' | 'closed' | 'blocked' | 'build_failed'
  | 'person' | 'empty' | 'failed' | 'held' | 'stopped' | 'answer' | 'revise'
  // #4242 / #4227: built and being checked before it is offered, built and
  // needing a person to look, and merged but not live yet.
  | 'checking' | 'needs_look' | 'going_live';

export interface HomeroomBotActivity {
  messageId: number;
  state: 'working' | 'done';
  startedAt: string | null;
  /**
   * When the work the card's time counts began (services/homeroom-bot-
   * activity.js workClock): the work, never the wait before it. Null while
   * nothing has begun, when its time is that wait.
   */
  workedFrom: string | null;
  /** What it waited for before the work began, from `startedAt`, when that wait is worth saying. */
  waitedFor?: 'first_version' | 'turn';
  links: { request: string | null; proposal: string | null };
  step: number | null;
  of: number | null;
  stepName: string | null;
  doing: string | null;
  /** While it is working, the stage it is at (services/homeroom-bot-progress.js stageOf). */
  stage?: string | null;
  outcome: HomeroomBotActivityOutcome | null;
  endedAt: string | null;
  /** How long the step it is at usually takes, in minutes, when it takes a while. */
  typicalMinutes?: { from: number; to: number };
  /** While it is working: who it waits on (`them`, the viewer; `the group`; `time`, on hold until Monday), when it waits (services/homeroom-bot-progress.js). */
  waitingOn?: string;
  /** A `build_failed` ending: why the build stopped. */
  stopCause?: 'time' | 'restart' | 'restarts' | 'no_change' | 'unproposed' | 'no_start' | 'other';
  /** A `held` ending: which of the bot's limits holds it back. */
  heldBy?: 'proposals_per_app' | 'proposals_total' | 'questions_per_day';
  /**
   * `going_live`, on a merge of the platform's own app: when the platform's
   * next release carries it (services/release-watch.js), which the card
   * words (../../lib/release-eta.ts). Absent on any other change.
   */
  release?: ReleaseOutlook;
}

/**
 * A ready card's change as it stands now, read with the activity cards
 * (services/homeroom-bot-dm.js readyStates): `live` (with the button that
 * opens the app), `going_live`, `closed` without going live, or `open`, up
 * for approval, with who it still waits on and, once the reader's Yes is
 * in, what happens next. The card was sent with what was true then.
 */
export interface HomeroomBotReadyNow {
  messageId: number;
  state: 'open' | 'going_live' | 'live' | 'closed';
  actions: HomeroomBotAction[];
  approval?: {
    missing: number;
    needed: number;
    last: boolean;
    /** The reader's own Yes is in. */
    approved: boolean;
    waitingOn: string[];
    more: number;
  };
  goesLive?: HomeroomBotGoesLive;
  /** `going_live`, on a merge of the platform's own app: when its release comes (as HomeroomBotActivity's). */
  release?: ReleaseOutlook;
  /**
   * #5506, `open` only: whether the reader builds on the project. False: a
   * Yes from them would be refused, so the card offers no Approve and its
   * Try it opens the look-only preview.
   */
  canBuild?: boolean;
  /** #5506, `open` only: whether the reader may have the bot withdraw the change (they asked for it, or own the project). */
  canWithdraw?: boolean;
}

/** One read of the bot DM's cards: its activity cards and its ready cards. */
export interface HomeroomBotActivityRead {
  cards: HomeroomBotActivity[];
  ready: HomeroomBotReadyNow[];
}

export interface ConversationMember extends ConversationUser {
  role: MemberRole;
  status: MembershipStatus;
  joinedAt?: string | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  users?: string[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  kind?: string | null;
  url: string;
  viewUrl?: string | null;
}

export type SharedObjectType = 'app' | 'issue' | 'proposal' | 'governance' | 'spec';

export interface SharedObjectReference {
  type: SharedObjectType;
  appId?: number;
  appSlug?: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  version?: number;
}

/**
 * An item staged on the composer: its reference, and the title the page that
 * staged it knew, shown on the chip until the server's reading of it comes.
 * The title is never sent: the server reads the live one.
 */
export interface StagedObject extends SharedObjectReference {
  title?: string | null;
}

/**
 * What a card under a message can be: anything that can be shared, plus the
 * two pages a pasted Homeroom link can name that are not items (#3660) — a
 * community's hub and its discussion. Those two are never stored on a
 * message; they are drawn from the message's own text (./link-cards.tsx).
 */
export type ObjectCardType = SharedObjectType | 'hub' | 'discussion';

export interface SharedObjectCard extends Omit<SharedObjectReference, 'type'> {
  type: ObjectCardType;
  available: boolean;
  /** A change's pull request number, when it has one (#4367). */
  prNumber?: number;
  title?: string | null;
  subtitle?: string | null;
  state?: string | null;
  author?: string | null;
  href?: string | null;
  /** An app's or a community's own icon, `/app-icons/<id>`, when it has one: drawn in place of the glyph. */
  iconUrl?: string | null;
  /** An app's or a community's emoji icon, for one with no image. */
  iconEmoji?: string | null;
}

export interface ConversationMessage {
  id: number;
  conversationId: number;
  sender: ConversationUser;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  moderated?: boolean;
  reply?: {
    id: number;
    sender: ConversationUser;
    content: string;
    /** The quoted message was deleted: the quote says so instead of its words (#2387). */
    deleted?: boolean;
  } | null;
  /**
   * Deleted by its author (#2387): a placeholder that keeps its place, its
   * sender and its thread, with no words, files, cards or reactions left.
   */
  deleted?: boolean;
  /**
   * A platform line rather than a person's message. Homeroom no longer
   * writes any into a channel; one kept as the root of somebody's thread is
   * deleted (services/conversations.js). Its sender reads Homeroom.
   */
  system?: boolean;
  /** A reply inside a thread: the id of the message the thread hangs off. */
  threadRootId?: number | null;
  /**
   * On a reply read as part of the main stream (#2387 follow-up): the start
   * of the message its thread hangs off, which the reply's line there names.
   */
  threadRoot?: ThreadRootRef | null;
  /** On a message a thread hangs off: how many replies, when the last, and who. */
  thread?: MessageThreadSummary | null;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  objects: SharedObjectCard[];
  /** Set by the platform only, on the Homeroom bot's messages (#3624); a person's carries a design pin at most (#6071). */
  metadata?: { homeroomBot?: HomeroomBotMeta; designPin?: DesignPin } | null;
  /**
   * Whether the VIEWER has saved this message — their own private bookmark,
   * never an aggregate. Hydrated with the page (services/conversations.js), so
   * the row's button renders already filled rather than flashing empty.
   * Optional because an optimistic local echo has no server answer yet.
   */
  saved?: boolean;
  pending?: boolean;
  failed?: boolean;
  clientKey?: string;
}

export interface MessageThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  /** Up to three of the most recent distinct repliers. */
  participants: ConversationUser[];
  /** The newest reply, which the card under the message shows (#2387 follow-up). */
  lastReply?: { id: number; sender: ConversationUser; content: string; createdAt: string } | null;
}

/** The message a thread hangs off, as a reply's line in the main stream names it. */
export interface ThreadRootRef {
  id: number;
  senderUsername: string;
  /** Its start, one line's worth; empty when it was deleted. */
  content: string;
  deleted: boolean;
}

export interface ConversationSummary {
  id: number;
  kind: ConversationKind;
  title: string;
  /** `title` is the stand-in for a conversation nobody named and whose other member is not known. */
  untitled?: boolean;
  avatarUrl?: string | null;
  members: ConversationMember[];
  memberCount: number;
  membershipStatus: MembershipStatus;
  myRole: MemberRole;
  requester?: ConversationUser | null;
  peer?: ConversationUser | null;
  latestMessage?: ConversationMessage | null;
  latestSummary?: string;
  lastActivityAt: string;
  unreadCount: number;
  /**
   * The viewer's read cursor, as the server keeps it: the newest message
   * they have read, 0 when they have read none. Where the conversation opens
   * and where its "New" line goes (./unread-anchor.ts). Absent for an
   * invitation, whose unread state is hidden, and from an older server.
   */
  lastReadMessageId?: number | null;
  /**
   * QA 2026-09-24 Q2: the viewer asked for this direct conversation and the
   * other person has not accepted yet. One opening message is allowed; after
   * it `canSend` turns false and the thread says who it is waiting for.
   */
  awaitingAcceptance?: boolean;
  canSend: boolean;
  canInvite: boolean;
  canManage: boolean;
  archived?: boolean;
  /** A channel's `#handle` (`general`); null for everything else. */
  channelKey?: string | null;
  /** #3692: the viewer's direct conversation with the Homeroom bot, which carries its activity tray. */
  homeroomBot?: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMember[];
  /** #3228: the inviter's note, set on the invitation only. */
  inviteNote?: string | null;
}

export interface UserSearchResult extends ConversationUser {}

export interface ConversationEvent {
  type: string;
  conversationId?: number;
  conversation_id?: number;
  conversation?: unknown;
  message?: unknown;
  messageId?: number;
  message_id?: number;
  reactions?: unknown;
  unreadCount?: number;
  unread_count?: number;
  [key: string]: unknown;
}

export interface MessagesRoute {
  open: boolean;
  conversationId: number | null;
  /**
   * #2718 review: an app's general discussion, open as a thread of THIS
   * inbox rather than as the app view's own screen.
   *
   * It is listed here beside the people and the agent chats, so it opens
   * here too — beside the list, at `#messages/app/<slug>`. Addressing it as
   * `#app/<slug>/dev/chat` made a row in this list navigate to a different
   * SCREEN ROOT: no conversation list beside it, and the app view's back
   * slot instead of this screen's. A row in a list opens beside that list.
   *
   * Mutually exclusive with `conversationId` — one thread is open, and the
   * two kinds are addressed differently because one is a conversation row
   * in this database and the other is an app.
   */
  appSlug: string | null;
  /**
   * #2813: an AGENT thread open beside the list on a desktop — an agent
   * session (`#messages/agent/<id>`) or an app's dev session
   * (`#messages/session/<slug>/<id>`). Both used to navigate away to a
   * screen of their own (`#agent/<id>`, `#app/<slug>/dev/sessions/<id>`).
   * On a PHONE a dev session still goes to its own: the router swaps that
   * address there. An agent session opens here on a phone too, as the
   * second level of the inbox's drawer (Evan, 18 Oct 2026).
   *
   * Mutually exclusive with the other two, for the same reason they are
   * with each other: one thread is open.
   */
  agent: MessagesAgentThread | null;
  /**
   * #2387: a reply thread open beside the conversation or app channel — the
   * id of the message it hangs off (`#messages/<id>/thread/<root>`,
   * `#messages/app/<slug>/thread/<root>`). Null when no thread is open.
   */
  threadRootId: number | null;
  /**
   * #2387: a message link (`…/m/<id>`) — the message the transcript opens
   * scrolled to and flashes. Cleared once shown.
   */
  focusMessageId: number | null;
  /**
   * #3494: the conversation is open IN ITS COMMUNITY'S PAGE, not on this
   * screen — #general, on Homeroom's Discussion tab (`embed` in ./store.ts).
   * `open` stays false while it is, so nothing that asks whether Messages is
   * on screen (its chrome, Back, the router) hears yes. Optional so a
   * fixture without it reads as false.
   */
  embedded?: boolean;
}

/** An agent thread of the inbox (#2813). See `MessagesRoute.agent`. */
export type MessagesAgentThread =
  | { kind: 'session'; slug: string; id: number }
  // #2779: an agent session, a conversation with the Mayor (a serial id), or
  // `new`: the one New change opens, unsent until its first message.
  | { kind: 'agent'; id: number | 'new' };

/** The app whose discussion is open, once its metadata has landed. */
export interface DiscussionContext {
  slug: string;
  name: string;
  /** `can_collaborate === false` — the composer does not render. */
  readOnly: boolean;
  /** Homeroom's old project discussion, kept read-only (#general is its channel now). */
  archived?: boolean;
  /**
   * The app's artwork, for the pane header's tile when the inbox has no row
   * to take it from (a discussion opened from a link by a non-member). The
   * row's own `iconUrl` / `iconEmoji` win when there is one.
   */
  iconUrl: string | null;
  iconEmoji: string | null;
}

import type { AppDiscussion, InboxSection } from './inbox';

export interface MessagesSnapshot {
  route: MessagesRoute;
  conversations: ConversationSummary[];
  active: ConversationDetail | null;
  messages: ConversationMessage[];
  loadingList: boolean;
  loadingThread: boolean;
  loadingOlder: boolean;
  listLoaded: boolean;
  error: string | null;
  threadError: string | null;
  /**
   * Why the open conversation cannot be shown when trying again cannot change
   * it (QA 2026-09-24 Q16): `left`, the viewer left it in this tab (Back
   * after Leave group lands here); `missing`, the server says it is not theirs
   * to read. Null otherwise. Optional so a fixture without it reads as null.
   */
  threadGone?: 'left' | 'missing' | null;
  nextBefore: number | null;
  online: boolean;
  demo: boolean;
  revision: number;
  /**
   * #2718: the other two kinds of thread this screen lists.
   *
   * `discussions` is GET /api/messages/app-discussions — the general thread
   * on each app the viewer is a member of, one row per app. Agent sessions
   * are NOT here: they are already in features/agent-session's own store,
   * and a second copy of a list that is loaded, merged and invalidated
   * elsewhere is a copy that drifts.
   */
  discussions: AppDiscussion[];
  discussionsLoaded: boolean;
  /**
   * The open discussion's app, or null while it loads or when the open
   * thread is a conversation. The row carries the name, but not whether the
   * viewer may write — that is `can_collaborate` on the app itself, so it
   * comes from GET /api/apps/<slug> when the thread opens.
   */
  discussionContext: DiscussionContext | null;
  discussionError: string | null;
  /**
   * The list's sections folded away from their headings (16 Oct 2026):
   * Agents, People, or both. Remembered per device; the bot's never folds.
   */
  folded: InboxSection[];
  /**
   * #2387: the reply thread open beside the conversation, or null. Its own
   * page of messages, loaded from `/threads/<root>`, so a thread never pushes
   * the conversation's own transcript out of the store.
   */
  thread: ReplyThreadState | null;
  /**
   * #2387: a message link opened the transcript part-way back, so there are
   * newer messages than the ones drawn; the cursor to fetch them. Null when
   * the transcript ends at the present.
   */
  nextAfter: number | null;
  /** #2387: the list pane folded away on a desktop — single-panel mode. */
  listCollapsed: boolean;
  /** #2967: the channels outside Your apps shown, under "Show more". */
  showMoreChannels: boolean;
  /**
   * Where reading had stopped in the open conversation when it was opened,
   * taken from the server before the open reads it, and kept until the
   * conversation closes: it opens at the first message after it, and the
   * "New" line stays there while it is open (./unread-anchor.ts). Null when
   * nothing was unread. Optional so a fixture without it reads as null.
   */
  unreadMark?: UnreadMark | null;
  /**
   * The message a reply thread opens at (store.openThreadAt): the strip's
   * Needs you button opens a request's thread at the question it asks.
   * Scrolled to and flashed once by the thread pane, never by the
   * conversation beside it. Optional so a fixture without it reads as null.
   */
  threadFocusId?: number | null;
}

export interface ReplyThreadState {
  conversationId: number;
  rootId: number;
  root: ConversationMessage | null;
  messages: ConversationMessage[];
  loading: boolean;
  error: string | null;
  nextBefore: number | null;
  /**
   * #5219: when this thread hangs off a Homeroom bot request card, the
   * request's public discussion on its request page, read alongside the DM
   * replies; the pane merges the two by time. Null when the root is no bot
   * card naming a request, the viewer cannot view that project, or the
   * thread is loading.
   */
  discussion?: DiscussionState | null;
}

/** One message from the request's public discussion, shown in its bot-card thread (#5219). */
export interface DiscussionMessage {
  id: number;
  source: 'discussion';
  sender: ConversationUser;
  content: string;
  createdAt: string;
  editedAt?: string | null;
}

/** #5219: a request's public discussion, as its bot-card thread carries it. */
export interface DiscussionState {
  appSlug: string;
  issueNumber: number;
  /** The discussion has older messages than the ones shown: they stay on the request page. */
  more: boolean;
  messages: DiscussionMessage[];
}
