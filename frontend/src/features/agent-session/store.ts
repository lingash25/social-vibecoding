// Agent sessions (#2779): the conversation screen's state. Module-level, read
// through useSyncExternalStore like the other islands' stores, with a
// controller published on window.UsernodeReact.agentSession for the classic
// router (public/js/app.js) and the entry points that start a conversation.
//
// The server is the one source of truth, and the screen converges on it:
//   - What the server has persisted (the session, whether the Mayor is
//     working, the rows, the cards) is read in ONE consistent snapshot
//     (GET .../state, `sync`) whenever this screen may be behind: when the
//     conversation opens or is routed to again, when the server announces a
//     newer version of it (the database's own notice, on every pod), when a
//     turn's events say it moved, when the page comes back to the
//     foreground or the network or socket returns, and every few seconds
//     while the Mayor works. Reads never overlap, and a read never publishes
//     over a newer one.
//   - What a turn is doing right now (streamed text, the tool it is running,
//     the coding agent's latest progress line) is drawn from its events, and
//     stays on screen until the read that brings in the saved rows replaces
//     it, in one publish, so nothing flashes away and back.
//   - What this screen sent and the server has not shown back yet is the
//     outbox (./outbox.ts): drawn at once, replaced in place by the server's
//     row, and marked Not sent, with Retry, if the server never took it.
// Whether the Mayor is working is the server's answer, never this screen's
// guess: a stale guess is what used to turn Send into Save with nobody
// working.
//
// A conversation New change opens is UNSENT (`draft`, addressed `new`): no
// row exists until its first message, so opening and leaving it leaves
// nothing behind in Messages. The first send creates the session with what
// the draft carried (the hint, the model picked while it was unsent), swaps
// the address for the session's own in place, and posts the message.

import { useRef, useSyncExternalStore } from 'react';

import { hasPlatformViewer, whenPlatformViewer } from '../../lib/platform-viewer';
import * as api from './api';
import { acceptFiles, pickedKind, type PendingFile } from './attachments';
import type {
  AgentAction,
  AgentCard,
  AgentChange,
  AgentChoice,
  AgentHint,
  AgentMessage,
  AgentSession,
  AgentTurnEvent,
  AgentTurnState,
  ModelCatalog,
  SavedDraft,
} from './api';
import { sameChoice } from './model-choice';
import {
  markStranded, mergeRows, newClientId, readOutbox, withoutLanded, writeOutbox, type OutboxItem,
} from './outbox';
import { draftSeed } from './request-seed';
import { toolActivity } from './transcript';
import { writeUnsent } from './unsent';

export type AgentSessionHost = 'screen' | 'messages';

/** A conversation's id, or `new` for the one not sent yet. */
export type AgentSessionTarget = number | 'new';

/** An unsent conversation: what it is about, and the model picked for it. */
export interface AgentDraft {
  hint: AgentHint | null;
  focusApp: AgentSession['focusApp'];
  focusContext: Record<string, unknown>;
  agent: AgentChoice | null;
}

export interface LiveTurn {
  running: boolean;
  phase: 'mayor' | 'cc' | 'mayor2' | null;
  stopping: boolean;
  stopRequestedAt: number | null;
  stopToken: string | null;
  stopPending: boolean;
  stopError: string | null;
  streamText: string;
  activity: string;
  progress: string;
  startedAt: number | null;
  cards: AgentCard[];
  /**
   * The running turn's id, as the server gave it (the lease a read returns,
   * or this screen's own send's `accepted`). Events of any other turn are
   * not drawn: a buffer's tail from an earlier turn cannot restart the dots.
   */
  turnId: string | null;
  /**
   * The saved row the streamed words stand in for (`mayor_reasoning`'s
   * messageId): they stay on screen until a read brings that row in.
   */
  settleOn: number | null;
}

/** The spec viewer over the conversation: one change's spec, one version. */
export interface SpecSheetState {
  changeId: number;
  /** The version on screen; null is the latest. */
  version: number | null;
  versions: number[];
  text: string;
  phase: 'loading' | 'ready' | 'error';
  error: string;
  /**
   * Which half of a two-half spec is showing (the platform's convention, see
   * public/js/spec-sections.js): the plain-language half first, as the dev
   * chat's viewer does. Kept across a version switch, reset for another change.
   */
  tab: SpecTab;
}

export type SpecTab = 'user' | 'tech';

/**
 * A change's staging preview in the side pane (#2779 follow-up), beside the
 * spec: the platform's own preview (AppView.ensureStaging), docked over the
 * pane's slot. Only on a wide screen; a narrow one opens the preview in a tab.
 */
export interface PreviewPaneState {
  changeId: number;
  url: string;
  prNumber: number | null;
  /** The app the preview is of, for signing in to it. */
  app: { slug: string; self_hosted: boolean } | null;
}

/** Which of the side pane's two pages is showing, when it holds both. */
export type PaneTab = 'spec' | 'preview';

/** The coding agents a change can be handed to on the web. */
export type HandoffAgent = 'claude-code' | 'codex';

/**
 * A message the platform credits refused (POST .../turns answered 429
 * `budget_exceeded`): the card that says so and how to keep building, in
 * place of a raw error line.
 */
export interface CreditsRefusal {
  error: string;
  reason: string | null;
  verificationRequired: boolean;
}

export interface AgentSessionState {
  open: boolean;
  host: AgentSessionHost;
  id: number | null;
  session: AgentSession | null;
  /** Set while the conversation on screen is unsent (`id` is null). */
  draft: AgentDraft | null;
  messages: AgentMessage[];
  actions: AgentAction[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  turn: LiveTurn;
  drawerOpen: boolean;
  deciding: string | null;
  sessions: AgentSession[];
  sessionsLoaded: boolean;
  /** The picker's options, read once per page. */
  catalog: ModelCatalog | null;
  /** A pick on its way to the server. */
  choosing: boolean;
  /** A message the server refused, handed back to the composer to send again. */
  returnedText: string | null;
  /**
   * A suggested reply the user tapped (#3033): it goes INTO the box, to be
   * edited or sent, the way the dev chat's pills do, rather than straight
   * out. `seq` makes the same pill tapped twice a second fill.
   */
  composerFill: { text: string; seq: number } | null;
  specSheet: SpecSheetState | null;
  preview: PreviewPaneState | null;
  paneTab: PaneTab;
  /** A staging card's action on its way: proposing, retrying the build, or re-running its checks. */
  changeAction: { changeId: number; kind: 'propose' | 'retry' | 'recheck' } | null;
  /** The last message was refused for credits; cleared by the next send. */
  credits: CreditsRefusal | null;
  /**
   * A request to open "Build with" on this agent's tab (the credits card's
   * hand-off rows); the composer opens its sheet there and clears it.
   */
  handoff: HandoffAgent | null;
  /**
   * The conversation's saved drafts (#2779 follow-up, the dev chat's #798
   * list): what the owner parked while the Mayor worked, oldest first, as
   * the server holds them for every device.
   */
  drafts: SavedDraft[];
  /** Files in the tray above the box, sent with the next message (./attachments.ts). */
  attachments: PendingFile[];
  /** What this screen sent that the server has not shown back yet (./outbox.ts). */
  outbox: OutboxItem[];
  /** The conversation's version the screen last read (null before the first read). */
  version: number | null;
}

const IDLE_TURN: LiveTurn = {
  running: false,
  phase: null,
  stopping: false,
  stopRequestedAt: null,
  stopToken: null,
  stopPending: false,
  stopError: null,
  streamText: '',
  activity: '',
  progress: '',
  startedAt: null,
  cards: [],
  turnId: null,
  settleOn: null,
};

export const INITIAL_STATE: AgentSessionState = {
  open: false,
  host: 'screen',
  id: null,
  session: null,
  draft: null,
  messages: [],
  actions: [],
  phase: 'idle',
  error: '',
  turn: IDLE_TURN,
  drawerOpen: false,
  deciding: null,
  sessions: [],
  sessionsLoaded: false,
  catalog: null,
  choosing: false,
  returnedText: null,
  composerFill: null,
  specSheet: null,
  preview: null,
  paneTab: 'spec',
  changeAction: null,
  drafts: [],
  attachments: [],
  credits: null,
  handoff: null,
  outbox: [],
  version: null,
};

let state: AgentSessionState = INITIAL_STATE;
const listeners = new Set<() => void>();
let navigation = 0;
let turnAbort: AbortController | null = null;
let events: EventSource | null = null;
const seen = new Set<string>();
// The hint the next `new` open starts from: undefined when nothing has been
// prepared (a reload of `#agent/new`, or the same draft routed again).
let pendingHint: AgentHint | null | undefined;
let catalogRequest: Promise<void> | null = null;

function publish(patch: Partial<AgentSessionState> | ((current: AgentSessionState) => Partial<AgentSessionState>)) {
  // Streamed text still waiting for its frame lands first, so every publish
  // (and every patch computed from `current`) sees the reply as it stands.
  absorbStream();
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  syncTabTitle();
  for (const listener of listeners) listener();
}

// ── Streamed text, one publish per frame ──────────────────────────────
//
// A reply arrives a token at a time, dozens a second, and each token used to
// be a publish: every subscriber re-rendered for every word (the panel, the
// composer, every row of the transcript, and the inbox, Recents and the app
// sheet, which only read `sessions`). Tokens now collect here and land in ONE
// publish per animation frame, which is as often as a change can be seen.
// Any other event flushes them first (handleEvent), and every publish folds
// them in before its own patch (`publish` above), so nothing that follows a
// token (a tool, a card, a phase, an error, a stop, the turn's end) is ever
// applied ahead of the words that came before it.
let streamBuffer = '';
let streamFrame: number | null = null;

function cancelStreamFrame() {
  if (streamFrame == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(streamFrame);
  else clearTimeout(streamFrame);
  streamFrame = null;
}

/** Fold the buffered tokens into `state` without notifying: the caller publishes. */
function absorbStream() {
  if (!streamBuffer) return;
  const text = streamBuffer;
  streamBuffer = '';
  cancelStreamFrame();
  state = { ...state, turn: { ...state.turn, running: true, streamText: state.turn.streamText + text } };
}

/** Publish the buffered tokens now, if there are any. */
function flushStream() {
  if (streamBuffer) publish({});
  else cancelStreamFrame();
}

function bufferToken(text: string) {
  streamBuffer += text;
  if (streamFrame != null) return;
  const land = () => { streamFrame = null; flushStream(); };
  streamFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(land)
    : (setTimeout(land, 16) as unknown as number);
}

// The browser tab says "⏳ Thinking…" while the conversation on screen is
// working, as the dev chat's does (#108). The dev chat's module stays the
// title's one writer: this only tells it when an agent turn is running.
let tabThinking = false;
function syncTabTitle() {
  const thinking = state.open && state.turn.running;
  if (thinking === tabThinking || typeof window === 'undefined') return;
  tabThinking = thinking;
  try { window.DevChat?.setAgentSessionThinking?.(thinking); } catch { /* the title keeps its last marker */ }
}

function patchTurn(patch: Partial<LiveTurn>) {
  publish((current) => ({ turn: { ...current.turn, ...patch } }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAgentSessionState() {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL_STATE);
}

/**
 * One value from the store, re-rendering only when THAT value changes.
 * `select` must return something stable: a primitive, or an object the store
 * already holds (`s.session`, `s.messages`), never a fresh one.
 *
 * Most readers need a field or two, and the whole snapshot changes on every
 * publish: a component that reads `sessions` through useAgentSessionState()
 * re-renders for a streamed reply it does not draw.
 */
export function useAgentSessionSelector<T>(select: (current: AgentSessionState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(INITIAL_STATE));
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Several values at once, as an object compared field by field: the same
 * object comes back until one of them changes, so a render follows only a
 * change the component draws. Each field follows useAgentSessionSelector's
 * rule: a primitive, or an object the store holds.
 */
export function useAgentSessionPick<T extends Record<string, unknown>>(select: (current: AgentSessionState) => T): T {
  const last = useRef<{ client: T | null; server: T | null }>({ client: null, server: null });
  const read = (source: AgentSessionState, slot: 'client' | 'server') => {
    const next = select(source);
    const held = last.current[slot];
    if (held && shallowEqual(held, next)) return held;
    last.current[slot] = next;
    return next;
  };
  return useSyncExternalStore(subscribe, () => read(state, 'client'), () => read(INITIAL_STATE, 'server'));
}

/**
 * The conversation list, for the readers outside the conversation (the
 * inbox, Recents, the app sheet). A streamed reply leaves it alone, so they
 * do not re-render with it.
 */
export function useAgentSessions(): AgentSession[] {
  return useAgentSessionSelector((current) => current.sessions);
}

export function getAgentSessionState() {
  return state;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function composerId(host: AgentSessionHost) {
  return host === 'messages' ? 'agent-session-pane-composer' : 'agent-session-composer';
}

function syncTitle() {
  if (!state.open || state.host !== 'screen') return;
  const title = state.session?.title || 'New session';
  try { window.App?.setHeaderTitle?.(title); } catch { /* the bar keeps its last title */ }
}

// ── Reading: one consistent snapshot, whenever the screen may be behind ──

/**
 * The lists (Recents, the mark's menu, Messages) read the same session as
 * the screen: reading it marked it seen, and a turn that just ended is no
 * longer working, so their mark follows the conversation on screen at once.
 */
function withListed(current: AgentSessionState, session: AgentSession): AgentSession[] {
  return current.sessions.map((s) => (s.id === session.id ? session : s));
}

// Where the open conversation's screen stands: the version and rev it last
// read, so the next read asks only for what moved. Reset whenever another
// conversation opens.
let cursor: { id: number; version: number | null; rev: number | null } | null = null;
// One read at a time. A trigger that arrives while one is running asks for
// one more after it (never a second one alongside it), so the last read
// always starts after the last trigger, and an older answer can never be
// published over a newer one.
let syncing: { id: number; promise: Promise<void> } | null = null;
let syncAgain = false;
let syncWhole = false;
// When this screen's own send was last accepted. A read that started before
// it cannot know the turn it started, so its "not working" is not believed.
let acceptedAt = 0;
// The sends this page is waiting on the server to accept: client id to the
// conversation it was sent to. While one of a conversation's is out, its
// screen stays "working" whatever a read says.
const awaiting = new Map<string, number>();

function sendingIn(id: number): boolean {
  for (const conversation of awaiting.values()) if (conversation === id) return true;
  return false;
}
// Sends the server accepted whose row this screen has not read yet: in
// flight still, never "Not sent".
const accepted = new Set<string>();

function inFlight(): Set<string> {
  return new Set([...awaiting.keys(), ...accepted]);
}

const NOT_SENT_TEXT = 'Could not reach Homeroom, so this was not sent.';
const BUSY_REFUSED_TEXT = 'The Mayor was still answering, so this was not sent.';
const STRANDED_TEXT = 'This was not sent.';

/**
 * Bring the open conversation up to date with the server. Resolves once the
 * screen holds a read that started after this call.
 */
export function requestSync(id: number | null = state.id, { whole = false }: { whole?: boolean } = {}): Promise<void> {
  if (!id || state.id !== id || !state.open) return Promise.resolve();
  if (whole) syncWhole = true;
  if (syncing && syncing.id === id) {
    syncAgain = true;
    return syncing.promise;
  }
  const run = (async () => {
    do {
      syncAgain = false;
      const all = syncWhole;
      syncWhole = false;
      // eslint-disable-next-line no-await-in-loop
      await syncOnce(id, all).catch((error) => syncFailed(id, error));
    } while (syncAgain && state.id === id && state.open);
  })().finally(() => {
    if (syncing && syncing.id === id) syncing = null;
  });
  syncing = { id, promise: run };
  return run;
}

function syncFailed(id: number, error: unknown) {
  if (state.id !== id) return;
  // The first read of a conversation is the screen: say what went wrong.
  // Any later one only missed a beat; the next trigger or poll reads again.
  if (state.phase === 'loading') {
    publish({ phase: 'error', error: errorText(error, 'Could not load this agent session.') });
  }
}

async function syncOnce(id: number, whole: boolean) {
  const held = !whole && cursor && cursor.id === id ? cursor : null;
  const startedAt = Date.now();
  const answer = await api.getState(id, held ? { version: held.version, rev: held.rev } : {});
  if (state.id !== id || !state.open) return;
  if (answer.unchanged) {
    // Nothing was written, but a lease can go stale with no write (its
    // process died): when the server's "working" differs from what it last
    // said, or the screen thinks a turn runs that the server does not know,
    // read it all.
    const working = !!answer.busy;
    if (working !== !!state.session?.busy || (working && !state.turn.running)) {
      syncWhole = true;
      syncAgain = true;
      return;
    }
    // The screen's own guess (a send it started, refused since) settles on
    // the server's word: not working, and nothing of this screen's waiting
    // to be accepted, is not working.
    const stale = startedAt < acceptedAt;
    if (!working && state.turn.running && !sendingIn(id) && !stale) {
      publish({ turn: IDLE_TURN });
      following(id);
    } else if (working) {
      // A job's stop stamp and the force-stop deadline can change without
      // a conversation revision. Reconnects and other devices still need it.
      publish({ turn: settleTurn(state.turn, { busy: true, turn: answer.turn, messages: state.messages, sending: sendingIn(id) }) });
    }
    return;
  }
  let messages: AgentMessage[];
  if (answer.full) {
    messages = [...answer.messages];
    let after = answer.nextAfter;
    // A conversation can outgrow one page; follow the cursor to the end.
    for (let page = 0; after && page < 20; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const next = await api.getMessages(id, after);
      if (state.id !== id) return;
      messages.push(...next.messages);
      after = next.nextAfter;
    }
  } else {
    messages = mergeRows(state.messages, answer.messages);
  }
  cursor = {
    id,
    version: typeof answer.version === 'number' ? answer.version : null,
    rev: typeof answer.rev === 'number' ? answer.rev : null,
  };
  const session = answer.busy && !answer.session.busy ? { ...answer.session, busy: true } : answer.session;
  // A read from before this screen's own send was accepted says "not
  // working" about a turn it could not see: keep the screen's, and read again.
  const stale = !answer.busy && startedAt < acceptedAt;
  if (stale) syncAgain = true;
  publish((current) => {
    const outbox = markStranded(withoutLanded(current.outbox, messages), inFlight(), STRANDED_TEXT);
    for (const clientId of accepted) {
      if (!outbox.some((item) => item.clientId === clientId)) accepted.delete(clientId);
    }
    return {
      session,
      sessions: withListed(current, session),
      messages,
      actions: Array.isArray(answer.actions) ? answer.actions : current.actions,
      outbox,
      version: cursor ? cursor.version : null,
      phase: 'ready',
      turn: settleTurn(current.turn, {
        busy: !!answer.busy || stale, turn: answer.turn, messages, sending: sendingIn(id),
      }),
    };
  });
  storeOutbox(id);
  syncTitle();
  following(id);
}

/**
 * The live turn as the server's read leaves it. Working: the turn the server
 * names, with the streamed words kept until their saved row is in. Not
 * working (and no send of this screen's still waiting to be accepted): the
 * turn is over, and everything it streamed is in `messages` by now, so the
 * words go in the same publish that brings their row.
 */
export function settleTurn(turn: LiveTurn, read: {
  busy: boolean;
  turn: AgentTurnState | null | undefined;
  messages: AgentMessage[];
  sending: boolean;
}): LiveTurn {
  if (!read.busy) return read.sending ? { ...turn, running: true } : (turn === IDLE_TURN ? turn : IDLE_TURN);
  const server = read.turn || null;
  let next: LiveTurn = { ...turn, running: true };
  if (server && ((server.id && turn.turnId && server.id !== turn.turnId)
    || (server.stopToken && turn.stopToken && server.stopToken !== turn.stopToken))) {
    // Another turn than the one drawn (started on another device, or the
    // follow-up after a card): start its drawing afresh.
    next = { ...IDLE_TURN, running: true };
  }
  if (server) {
    if (server.id) next.turnId = server.id;
    if (!next.phase || server.phase !== 'mayor') next.phase = server.phase;
    if (typeof server.startedAt === 'number' && server.startedAt > 0) next.startedAt = server.startedAt;
    next.stopping = next.stopPending || !!server.stopping;
    next.stopRequestedAt = server.stopRequestedAt || null;
    next.stopToken = server.stopToken || null;
  }
  if (!next.phase) next.phase = 'mayor';
  if (!next.startedAt) next.startedAt = Date.now();
  if (next.settleOn != null && read.messages.some((row) => row.id === next.settleOn)) {
    next = { ...next, streamText: '', cards: [], settleOn: null };
  }
  return next;
}

// ── Following a turn, and the polls that catch what events miss ────────

function closeEvents() {
  if (events) {
    try { events.close(); } catch { /* already closed */ }
  }
  events = null;
}

/**
 * Draw a turn this screen is not streaming itself (one already running when
 * it opened, the follow-up after a card, one started on another device)
 * from the conversation's bus (GET .../events), which replays what the
 * running turn has said so far. Events only animate: a read settles it.
 */
function followEvents(id: number) {
  closeEvents();
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource(`/api/agent-sessions/${id}/events`, { withCredentials: true });
  events = source;
  source.onmessage = (message) => {
    try {
      handleEvent(id, JSON.parse(message.data) as AgentTurnEvent);
    } catch { /* malformed frame */ }
  };
  // The browser reconnects by itself (with Last-Event-Id); what happened
  // meanwhile is read. One that gave up is dropped, to be opened again by
  // the next read that finds the turn still running.
  source.onerror = () => {
    if (events === source && source.readyState === 2) events = null;
    void requestSync(id);
  };
}

/** Follow the running turn when nothing else is drawing it; let go once it ends. */
function following(id: number) {
  if (state.id !== id || !state.open) return;
  if (state.turn.running && !turnAbort && !events) followEvents(id);
  else if (!state.turn.running && events) closeEvents();
  schedulePoll();
}

// While the Mayor works the screen re-reads every few seconds (almost always
// "unchanged", a one-row read): an event lost between pods, or a turn that
// died with its process, cannot leave it spinning. Otherwise now and then,
// in case the socket that carries the server's notices is down.
const BUSY_POLL_MS = 4000;
const IDLE_POLL_MS = 30000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function schedulePoll() {
  stopPoll();
  const id = state.id;
  if (!id || !state.open) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (state.id !== id || !state.open) return;
    if (pageHidden()) { schedulePoll(); return; }
    void requestSync(id).finally(() => { if (!pollTimer) schedulePoll(); });
  }, state.turn.running ? BUSY_POLL_MS : IDLE_POLL_MS);
  (pollTimer as unknown as { unref?: () => void }).unref?.();
}

// The page coming back (a phone unlocking, a tab refocused) and the network
// returning are the moments a screen is most likely behind.
let lifecycleBound = false;
function bindLifecycle() {
  if (lifecycleBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  lifecycleBound = true;
  const wake = () => {
    if (state.open && state.id && !pageHidden()) void requestSync(state.id);
  };
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', wake);
  }
}

/** The socket that carries the server's notices came back (app.js resyncCurrentView): read what it missed. */
export function resyncAgentSession() {
  if (state.open && state.id) void requestSync(state.id);
}

/** The turn's id prefix its events carry (`_seq` is `<first 8 of the id>-<n>`). */
function turnPrefix(turnId: string | null): string | null {
  return turnId ? `${turnId.slice(0, 8)}-` : null;
}

export function handleEvent(id: number, event: AgentTurnEvent) {
  if (state.id !== id) return;
  if (typeof event._seq === 'string') {
    if (seen.has(event._seq)) return;
    seen.add(event._seq);
  }
  const fromChange = event.changeId != null;
  // An event of another turn than the one drawn (an earlier turn's tail in
  // the bus, a hand-back's `done`) only says something moved: read it.
  const prefix = turnPrefix(state.turn.turnId);
  if (!fromChange && event.type !== 'accepted' && prefix && typeof event._seq === 'string' && !event._seq.startsWith(prefix)) {
    void requestSync(id);
    return;
  }
  // Anything but the Mayor's own words lands after the words before it; the
  // cases below also read `state.turn` to build their patches.
  if (event.type !== 'token' || fromChange) flushStream();
  switch (event.type) {
    case 'accepted': {
      acceptedAt = Date.now();
      const turnId = typeof event.turnId === 'string' ? event.turnId : null;
      if (turnId && turnId !== state.turn.turnId) patchTurn({ turnId });
      void requestSync(id);
      break;
    }
    case 'phase': {
      const phase = event.phase === 'cc' || event.phase === 'mayor2' ? event.phase : 'mayor';
      patchTurn({
        running: true,
        phase,
        streamText: phase === 'mayor2' ? '' : state.turn.streamText,
        activity: phase === 'cc' ? 'The coding agent is working' : '',
        startedAt: phase === 'cc'
          ? (typeof event.startedAt === 'number' ? event.startedAt : Date.now())
          : (state.turn.startedAt || Date.now()),
        progress: phase === 'cc' ? '' : state.turn.progress,
      });
      break;
    }
    case 'token':
      if (fromChange || typeof event.text !== 'string') break;
      // The first words of a turn show at once and mark it running; the
      // rest collect for the next frame (bufferToken).
      if (state.turn.running) bufferToken(event.text);
      else patchTurn({ running: true, streamText: state.turn.streamText + event.text });
      break;
    case 'tool':
      if (event.state === 'running') patchTurn({ activity: toolActivity(String(event.name || '')) });
      else if (state.turn.phase !== 'cc') patchTurn({ activity: '' });
      break;
    case 'confirmation_required':
      if (event.card && typeof event.card === 'object') patchTurn({ cards: [...state.turn.cards, event.card as AgentCard] });
      break;
    case 'status':
    case 'cc_progress':
      if (typeof event.text === 'string' && event.text.trim()) patchTurn({ progress: progressLine(event.text.trim()) });
      if (event.type === 'status' && fromChange) void requestSync(id);
      break;
    case 'staging_ready':
    case 'staging_failed':
      if ((event.type === 'staging_ready' || event.type === 'staging_failed') && fromChange) {
        const changeId = Number(event.changeId);
        // A preview in the pane waiting on this rebuild opens (or says why not).
        try {
          window.AppView?.onStagingRebuildResult?.(changeId, {
            url: typeof event.url === 'string' ? event.url : null,
            failed: event.type === 'staging_failed',
            error: typeof event.error === 'string' ? event.error : null,
          });
        } catch { /* the preview's own loader says so */ }
        if (state.changeAction && state.changeAction.kind === 'retry' && state.changeAction.changeId === changeId) {
          publish({ changeAction: null });
        }
      }
      // falls through
    case 'pr_created':
    case 'pr_updated':
    case 'spec_updated':
    case 'checks_ready':
    case 'active_change':
    case 'focus_app':
      void requestSync(id);
      break;
    case 'mayor_reasoning':
      // The reply is saved. Its words stay where they are until the read
      // that brings the saved row replaces them (settleTurn).
      patchTurn({ settleOn: typeof event.messageId === 'number' ? event.messageId : state.turn.settleOn });
      void requestSync(id);
      break;
    case 'stopping':
      patchTurn({ stopping: true });
      break;
    case 'stopped':
      if (!fromChange) {
        patchTurn({ stopping: false });
        void requestSync(id);
      }
      break;
    case 'error':
      if (!fromChange) {
        publish({ error: typeof event.error === 'string' ? event.error : 'The Mayor could not finish this turn.' });
        void requestSync(id);
      }
      break;
    case 'done':
      // The turn is over on the server. The read that says so, and brings
      // in what it saved, settles the screen in one publish.
      if (fromChange) break;
      void requestSync(id);
      break;
    default:
      break;
  }
}

/**
 * A progress line as the build card shows it. The runner's phase markers
 * arrive as "[codex (resume <thread>, mode build)]"; the dev chat labels
 * them through cc-progress-summary.js's ccPhaseLabel ("Coding agent is
 * working"), and so does this, rather than printing the marker.
 */
export function progressLine(text: string): string {
  const marker = /^\[([^\]]+)\]$/.exec(text);
  if (!marker) return text;
  const label = typeof window !== 'undefined'
    && typeof (window as unknown as { ccPhaseLabel?: (phase: string) => string }).ccPhaseLabel === 'function'
    ? (window as unknown as { ccPhaseLabel: (phase: string) => string }).ccPhaseLabel(marker[1])
    : '';
  return label && label !== marker[1].trim() ? label : 'The coding agent is working';
}

/** Keep the open conversation's outbox where a reload finds it. */
function storeOutbox(id: number) {
  if (state.id === id) writeOutbox(id, state.outbox);
}

// ── Opening and closing ────────────────────────────────────────────────

export async function openAgentSession({ id, host = 'screen', drawer = false }: {
  id: AgentSessionTarget;
  host?: AgentSessionHost;
  drawer?: boolean;
}) {
  // Every route into a conversation, the same one again included, asks for
  // any part of the model catalog that did not answer (loadModelCatalog).
  void loadModelCatalog();
  if (id === 'new') return openDraft(host);
  // THE SAME SESSION AGAIN changes where it is drawn and nothing else — and in
  // particular does not claim the load (QA 2026-09-24 Q23). A cold deep link
  // opens it twice (the screen's own effect, then app.js's router), and the
  // second call used to take a new `navigation` version and return. The first
  // call's answer then belonged to nobody: a session that does not exist left
  // the full screen blank, with no "Agent session not found" and no spinner,
  // while the Messages pane, opened once, said so. It also used to clear the
  // error it would never set again.
  //
  // It is also the moment a screen is most likely behind (the user tapped
  // the conversation again, or came back to it): read it.
  if (state.id === id && state.open) {
    publish({ open: true, host, drawerOpen: drawer || state.drawerOpen });
    syncTitle();
    applyCarriedPane();
    // Still loading: that read is this one's too.
    if (state.phase !== 'loading') void requestSync(id);
    return;
  }
  const version = ++navigation;
  overPreview = null;
  cursor = null;
  publish({
    open: true,
    host,
    id,
    phase: 'loading',
    error: '',
    drawerOpen: drawer,
    session: null, draft: null, messages: [], actions: [], turn: IDLE_TURN, specSheet: null, preview: null, changeAction: null, drafts: [],
    credits: null, handoff: null, attachments: dropAllAttachments(), outbox: readOutbox(id), version: null,
  });
  syncTitle();
  seen.clear();
  closeEvents();
  bindLifecycle();
  await requestSync(id, { whole: true });
  if (version !== navigation || state.id !== id || state.phase !== 'ready') return;
  applyCarriedPane();
  void loadDrafts(id);
  refreshCredits();
}

/**
 * Where to start the next unsent conversation from. Called by New change
 * (startAgentSession) in this document, and by the side panel's own document
 * with the hint the top window handed it.
 */
export function prepareAgentDraft(hint: AgentHint | null | undefined) {
  pendingHint = hint || null;
}

/**
 * Show an unsent conversation. A freshly prepared hint starts a new draft;
 * routing the one already on screen again (a resize, a same-address
 * restore) keeps it, typed model pick included.
 */
function openDraft(host: AgentSessionHost) {
  const fresh = pendingHint !== undefined;
  // The same unsent conversation again (a phone routes Start work twice, to
  // Messages and then to the full screen) keeps it and does not claim the
  // load, as the same SESSION again does not (openAgentSession): the first
  // call's preview then still lands, and the bar names the app instead of
  // staying on "Any app".
  if (!fresh && state.open && state.id === null && state.draft) {
    publish({ host });
    syncTitle();
    return;
  }
  const version = ++navigation;
  const hint = fresh ? (pendingHint || null) : null;
  pendingHint = undefined;
  // Started from a request (Start work), or handed a message (Global Chat,
  // Explore): the box offers that first message (the composer reads it off
  // the hint, ./request-seed.ts), not the text an earlier unsent
  // conversation left behind.
  if (draftSeed(hint)) writeUnsent('new', '');
  seen.clear();
  closeEvents();
  stopPoll();
  cursor = null;
  const draft: AgentDraft = {
    hint,
    focusApp: null,
    focusContext: hint && hint.entry ? { entry: hint.entry } : {},
    agent: null,
  };
  publish({
    open: true,
    host,
    id: null,
    session: null,
    draft,
    messages: [],
    actions: [],
    phase: 'ready',
    error: '',
    drawerOpen: false,
    specSheet: null,
    turn: IDLE_TURN,
    drafts: [],
    attachments: dropAllAttachments(),
    credits: null,
    // The out-of-credits card's "Use Claude Code" / "Use Codex" opens the
    // conversation on its "Build with" tab (AppView.createProposal).
    handoff: hint?.handoff === 'claude-code' || hint?.handoff === 'codex' ? hint.handoff : null,
    outbox: [],
    version: null,
  });
  syncTitle();
  refreshCredits();
  if (!hint || !(hint.slug || hint.issueNumber || hint.proposalId)) return;
  // What it is about, resolved as creating it would resolve it, written
  // nowhere. A failure only leaves the bar saying "Any app".
  void api.previewDraft(hint).then((preview) => {
    if (version !== navigation || state.draft?.hint !== hint) return;
    publish((current) => ({
      draft: current.draft ? { ...current.draft, focusApp: preview.focusApp, focusContext: preview.focusContext } : null,
    }));
  }).catch(() => {});
}

/**
 * The screen or pane stopped showing this conversation. A running turn goes
 * on server-side, and so does a send still on its way: it is not aborted,
 * so the server gets the message and this page learns whether it did.
 */
export function deactivateAgentSession() {
  navigation += 1;
  overPreview = null;
  closeEvents();
  stopPoll();
  turnAbort = null;
  if (state.preview) closePreview();
  publish({ open: false, drawerOpen: false, specSheet: null, preview: null, turn: IDLE_TURN, handoff: null });
}

/** Where a conversation lives: beside the inbox on a desktop, its own screen on a phone (app.js swaps). */
export function agentSessionAddress(id: AgentSessionTarget) {
  return `#messages/agent/${id}`;
}

/**
 * The unsent conversation became session `id`: give the page the session's
 * own address in place, so a reload, Back or Expand finds it, and let the
 * router hear it (its same-id checks make that a no-op for this store).
 */
function adoptAddress(id: number) {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash;
  const next = /^#agent\/new(?:\/|$)/.test(hash)
    ? `#agent/${id}`
    : /^#messages\/agent\/new(?:\/|$)/.test(hash) ? agentSessionAddress(id) : null;
  if (!next) return;
  try {
    window.history.replaceState(window.history.state, '', next);
  } catch {
    return;
  }
  const restore = window.App?.restoreFromHash;
  if (typeof restore === 'function') restore.call(window.App);
}

/**
 * THE SIDE PANEL (desktop): while an app runs on its App tab, a conversation
 * opens in the panel beside it instead of replacing it, as a change or a
 * thread does (frontend/src/features/side-panel/). False whenever that is not
 * the moment — no app on screen, a narrow window, or this IS the panel's own
 * document, where the address below is followed in place.
 */
function sidePanelTakes(hash: string, agentHint?: AgentHint | null): boolean {
  const panel = (window as unknown as {
    UsernodeReact?: { sidePanel?: { take?: (route: string, hint?: { agentHint?: AgentHint | null } | null) => boolean } };
  }).UsernodeReact?.sidePanel;
  try {
    return !!panel?.take?.(hash.replace(/^#/, ''), agentHint !== undefined ? { agentHint } : null);
  } catch {
    return false;
  }
}

function go(hash: string, agentHint?: AgentHint | null) {
  if (sidePanelTakes(hash, agentHint)) return;
  if (window.location.hash === hash) {
    const restore = window.App?.restoreFromHash;
    if (typeof restore === 'function') restore.call(window.App);
  } else {
    window.location.hash = hash;
  }
}

/**
 * Start a conversation from an entry point, carrying what it knows (the app,
 * a request, a proposal) as the hint, and open it UNSENT — in the side panel
 * when an app is running beside it, where the hint rides into the panel's own
 * document. Nothing is created here: the first message creates the session,
 * in whichever document is showing it.
 */
export function startAgentSession(hint: AgentHint | null = null) {
  prepareAgentDraft(hint);
  if (sidePanelTakes(agentSessionAddress('new'), hint)) {
    // The panel's document starts the draft; this one has nothing to open.
    pendingHint = undefined;
    return;
  }
  // Already showing an unsent conversation: the address may not change, and
  // then no router pass would pick the new hint up. Start it here.
  if (state.open && state.id === null && state.draft) openDraft(state.host);
  go(agentSessionAddress('new'));
}

export function closeAgentSession() {
  deactivateAgentSession();
  go(state.host === 'messages' ? '#messages' : '#messages');
}

// ── Talking ────────────────────────────────────────────────────────────

/**
 * Create the session an unsent conversation stands for, with what it carried.
 * Its id, or null when the create was refused (said on screen, and the draft
 * stays as it was).
 */
async function createFromDraft(draft: AgentDraft): Promise<number | null> {
  try {
    const session = await api.createSession(draft.hint, draft.agent);
    publish((current) => ({ sessions: [session, ...current.sessions.filter((s) => s.id !== session.id)] }));
    // Still on screen: this is the conversation now. Left meanwhile: it
    // still gets its message, it just is not what the screen shows.
    if (state.open && state.draft === draft) {
      publish({ id: session.id, session, draft: null, phase: 'ready' });
      syncTitle();
      adoptAddress(session.id);
    }
    return session.id;
  } catch (error) {
    if (state.draft === draft) publish({ error: errorText(error, 'Could not start an agent session.') });
    return null;
  }
}

// ── Attachments (#2779 follow-up) ──────────────────────────────────────
//
// Files wait in a tray above the box and go with the next message. In a
// conversation that exists each one uploads as it is picked, so a refusal
// (too big, the wrong bytes) shows at once; an unsent conversation has
// nowhere to upload to yet, so its files upload on send, after the
// conversation is created — nothing is created before the first message.

let attachmentSeq = 0;

function revokeThumb(item: PendingFile) {
  if (item.thumbUrl) {
    try { URL.revokeObjectURL(item.thumbUrl); } catch { /* not ours to keep */ }
  }
}

/** Empties the tray, letting its previews go; returns the empty tray for a publish. */
function dropAllAttachments(): PendingFile[] {
  for (const item of state.attachments || []) revokeThumb(item);
  return [];
}

function patchAttachment(key: string, patch: Partial<PendingFile>) {
  publish((current) => ({
    attachments: current.attachments.map((item) => (item.key === key ? { ...item, ...patch } : item)),
  }));
}

function dropAttachments(keys: string[]) {
  const gone = state.attachments.filter((item) => keys.includes(item.key));
  gone.forEach(revokeThumb);
  publish((current) => ({ attachments: current.attachments.filter((item) => !keys.includes(item.key)) }));
}

async function uploadPending(id: number, key: string): Promise<boolean> {
  const item = state.attachments.find((entry) => entry.key === key);
  if (!item) return false;
  if (item.status === 'ready' && item.id) return true;
  patchAttachment(key, { status: 'uploading' });
  try {
    const uploaded = await api.uploadAttachment(id, item.file, item.name);
    if (state.id !== id) return false;
    patchAttachment(key, { status: 'ready', id: uploaded.id, kind: uploaded.kind });
    return true;
  } catch (error) {
    if (state.id === id) {
      dropAttachments([key]);
      toast(errorText(error, `Could not attach ${item.name}.`));
    }
    return false;
  }
}

/** Put picked, pasted or dropped files in the tray; the first refusal is said once. */
export function addAttachments(files: Array<{ name: string; size: number; type?: string } & Blob>) {
  if (state.session?.status === 'archived') return;
  const { accepted, error } = acceptFiles(state.attachments.length, files);
  if (error) toast(error);
  if (!accepted.length) return;
  const id = state.id;
  const added: PendingFile[] = accepted.map((file) => {
    const kind = pickedKind(file.name);
    let thumbUrl: string | null = null;
    if (kind === 'image' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try { thumbUrl = URL.createObjectURL(file); } catch { thumbUrl = null; }
    }
    attachmentSeq += 1;
    return {
      key: `att${attachmentSeq}`,
      file,
      name: file.name,
      kind,
      size: file.size,
      thumbUrl,
      status: id ? 'uploading' : 'local',
      id: null,
    };
  });
  publish((current) => ({ attachments: [...current.attachments, ...added] }));
  if (id) for (const item of added) void uploadPending(id, item.key);
}

/** The tray's remove control; an upload in flight has none (pending-strip.tsx). */
export function removeAttachment(index: number) {
  const item = state.attachments[index];
  if (!item || item.status === 'uploading') return;
  dropAttachments([item.key]);
}

// ── Sending ────────────────────────────────────────────────────────────
//
// A message is drawn at once, as the outbox's row (./outbox.ts), and posted
// with the screen's own id for it. The server writes it together with the
// turn that answers it and says `accepted`; from then on it is the server's,
// and the read that brings its row in replaces the outbox row in place. A
// send the server did not take stays in the conversation, Not sent, with
// Retry; nothing is dropped, and nothing is quietly handed back to the box.

// How long a send may wait for the server to take it. A connection that has
// said nothing by then (a phone waking on a weak signal) is given up on, and
// the server asked, by a read, whether the message got there.
const ACCEPT_TIMEOUT_MS = 20_000;
// A server that is restarting (a deploy) answers 503 for a few seconds, and
// a dropped connection says nothing at all: the same message is sent again,
// with the same id, which the server recognises if it had it after all.
const SEND_RETRY_MS = [1500, 4000];

function wait(ms: number) {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** The server's own answer (api.ts's json() carries its status); anything else is the connection. */
function refusedByServer(error: unknown): boolean {
  return typeof (error as { status?: unknown } | null)?.status === 'number';
}

function restarting(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 503
    && /restarting/i.test(String((error as { message?: unknown }).message || ''));
}

/** Change (or with `null`, drop) one of a conversation's outbox rows, on screen and in storage. */
function updateOutbox(id: number, clientId: string, patch: Partial<OutboxItem> | null) {
  const apply = (items: OutboxItem[]) => (patch === null
    ? items.filter((item) => item.clientId !== clientId)
    : items.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item)));
  if (state.id === id && state.open) {
    publish((current) => ({ outbox: apply(current.outbox) }));
    storeOutbox(id);
  } else {
    writeOutbox(id, apply(readOutbox(id)));
  }
}

/**
 * Send a message, or (with `retryOf`) send an outbox row that was not sent
 * again, under the same id. Refused while the Mayor is working: the
 * composer saves a draft instead (saveComposerDraft).
 */
export async function sendAgentMessage(text: string, { retryOf = null }: { retryOf?: OutboxItem | null } = {}) {
  const draft = state.id ? null : state.draft;
  const message = (retryOf ? retryOf.message : text).trim();
  const files = retryOf
    ? state.attachments.filter((item) => retryOf.attachmentKeys.includes(item.key))
    : state.attachments;
  if ((!state.id && !draft) || (!message && !files.length) || state.turn.running) return;
  // The button waits for uploads in flight; Enter must too.
  if (files.some((item) => item.status === 'uploading')) return;
  const item: OutboxItem = retryOf
    ? { ...retryOf, status: 'sending', error: '', attachmentKeys: files.map((file) => file.key) }
    : {
      clientId: newClientId(),
      message,
      shown: message || (files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`),
      status: 'sending',
      error: '',
      createdAt: Date.now(),
      attachmentKeys: files.map((file) => file.key),
    };
  // An unsent conversation has no id yet: its send is keyed to 0 until the
  // conversation it creates has one.
  awaiting.set(item.clientId, state.id ?? 0);
  publish((current) => ({
    error: '',
    credits: null,
    outbox: [...current.outbox.filter((entry) => entry.clientId !== item.clientId), item],
    turn: { ...IDLE_TURN, running: true, phase: 'mayor', startedAt: Date.now() },
  }));
  const id = draft ? await createFromDraft(draft) : state.id;
  if (!id) {
    awaiting.delete(item.clientId);
    // Refused before the conversation existed (said on screen): the unsent
    // conversation keeps its words in the box, as it always has.
    if (draft && state.draft === draft) publish({ outbox: [], turn: IDLE_TURN, returnedText: message });
    return;
  }
  awaiting.set(item.clientId, id);
  storeOutbox(id);
  const fail = (error: string) => {
    awaiting.delete(item.clientId);
    updateOutbox(id, item.clientId, { status: 'failed', error });
  };
  // The files an unsent conversation held: they upload now that it exists.
  for (const file of state.attachments.filter((entry) => entry.status === 'local' && item.attachmentKeys.includes(entry.key))) {
    // eslint-disable-next-line no-await-in-loop
    if (!await uploadPending(id, file.key)) {
      fail(`Could not attach ${file.name}, so this was not sent.`);
      if (state.id === id) publish({ turn: IDLE_TURN });
      return;
    }
  }
  const sending = state.attachments.filter((entry) => item.attachmentKeys.includes(entry.key) && entry.status === 'ready' && entry.id);
  const attachmentIds = sending.map((entry) => entry.id as string);
  let taken = false;
  const took = () => {
    if (taken) return;
    taken = true;
    accepted.add(item.clientId);
    awaiting.delete(item.clientId);
    // The tray empties once the server has the message, not before: a
    // refused message keeps its files for the retry.
    if (sending.length && state.id === id) dropAttachments(sending.map((entry) => entry.key));
  };
  for (let attempt = 0; ; attempt += 1) {
    const abort = new AbortController();
    if (state.id === id) turnAbort = abort;
    const giveUp = setTimeout(() => { if (!taken) abort.abort(); }, ACCEPT_TIMEOUT_MS);
    let retryable = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const answer = await api.sendTurn(id, message, {
        signal: abort.signal,
        attachmentIds,
        clientMessageId: item.clientId,
        onEvent: (event) => {
          took();
          handleEvent(id, event);
        },
      });
      // The server already had it: an earlier try got there.
      if (answer.duplicate) took();
    } catch (error) {
      if (!taken && refusedByServer(error)) {
        if (restarting(error) && attempt < SEND_RETRY_MS.length) {
          retryable = true;
        } else {
          const refused = creditsRefusal(error);
          if (refused) {
            // Out of platform credits: the card that says how to keep
            // building, and the message kept to send once there is a way.
            publish({ credits: refused });
            refreshCredits(true);
            fail('Not sent: you are out of credits for now.');
          } else if ((error as { body?: { busy?: boolean } }).body?.busy) {
            fail(BUSY_REFUSED_TEXT);
          } else {
            fail(errorText(error, 'The Mayor could not take this, so it was not sent.'));
          }
        }
      } else if (!taken) {
        // No answer at all (a dropped connection, a stalled one given up
        // on): the same message again, with the same id, is safe.
        retryable = attempt < SEND_RETRY_MS.length;
      }
      // Accepted, then the stream broke (a deploy, a network change): the
      // turn goes on, or has ended, on the server. The read below says which.
    } finally {
      clearTimeout(giveUp);
      if (turnAbort === abort) turnAbort = null;
    }
    if (!retryable) break;
    // eslint-disable-next-line no-await-in-loop
    await wait(SEND_RETRY_MS[attempt]);
  }
  // No answer after every try: Not sent, with Retry. Where the message
  // stands is still the server's answer: the read below removes the row
  // if the message got there after all.
  if (!taken && awaiting.has(item.clientId)) fail(NOT_SENT_TEXT);
  await requestSync(id);
}

/** An outbox row's Retry: the same message, under the same id. */
export function retryOutbox(clientId: string) {
  const item = state.outbox.find((entry) => entry.clientId === clientId);
  if (!item || item.status !== 'failed' || state.turn.running) return;
  void sendAgentMessage('', { retryOf: item });
}

/** An outbox row's Edit: its words go back to the box, and the row goes. Returns them for the composer. */
export function editOutbox(clientId: string): string | null {
  const id = state.id;
  const item = state.outbox.find((entry) => entry.clientId === clientId);
  if (!id || !item || item.status !== 'failed') return null;
  updateOutbox(id, clientId, null);
  return item.message;
}

/** An outbox row's Discard. */
export function discardOutbox(clientId: string) {
  const id = state.id;
  if (!id || !state.outbox.some((entry) => entry.clientId === clientId && entry.status === 'failed')) return;
  updateOutbox(id, clientId, null);
}

/**
 * Retry a turn that did not finish (interrupted by a platform update, or
 * failed part way): the Mayor answers the conversation as it stands, with
 * no new message (POST .../turns { retry: true }).
 */
export async function retryTurn() {
  const id = state.id;
  if (!id || state.turn.running || state.session?.status === 'archived') return;
  const key = `retry-${Date.now().toString(36)}`;
  awaiting.set(key, id);
  publish({ error: '', turn: { ...IDLE_TURN, running: true, phase: 'mayor', startedAt: Date.now() } });
  const abort = new AbortController();
  turnAbort = abort;
  try {
    await api.sendTurn(id, '', {
      retry: true,
      signal: abort.signal,
      onEvent: (event) => {
        awaiting.delete(key);
        handleEvent(id, event);
      },
    });
  } catch (error) {
    if (refusedByServer(error)) {
      const refused = creditsRefusal(error);
      if (refused) {
        publish({ credits: refused });
        refreshCredits(true);
      } else {
        publish({ error: errorText(error, 'Could not try that again.') });
      }
    }
  } finally {
    awaiting.delete(key);
    if (turnAbort === abort) turnAbort = null;
  }
  await requestSync(id);
}

/**
 * A turn the platform credits refused: POST .../turns answers 429 with
 * `code: 'budget_exceeded'` (services/mayor/agent-turn.js, the dev chat's
 * own shape), and the error text names the limit and when it resets.
 */
export function creditsRefusal(error: unknown): CreditsRefusal | null {
  const failure = error as { status?: number; body?: { code?: unknown; error?: unknown; reason?: unknown; verificationRequired?: unknown } };
  if (!failure || failure.status !== 429 || !failure.body || failure.body.code !== 'budget_exceeded') return null;
  return {
    error: typeof failure.body.error === 'string' ? failure.body.error : '',
    reason: typeof failure.body.reason === 'string' ? failure.body.reason : null,
    verificationRequired: failure.body.verificationRequired === true,
  };
}

/**
 * The viewer's AI credits, which the composer's meter shows: the header's
 * own figures (features/header/ai-credit.js), kept live by the server's
 * `budget_updated` pushes. Read when a conversation opens, throttled there,
 * and again at once after a refusal.
 */
function refreshCredits(force = false) {
  if (typeof window === 'undefined') return;
  const budget = (window as unknown as { AiCredit?: { Budget?: { refresh?: (opts?: { force?: boolean }) => unknown } } }).AiCredit?.Budget;
  try { void budget?.refresh?.({ force }); } catch { /* the meter keeps its last figures */ }
}

export function dismissCredits() {
  if (state.credits) publish({ credits: null });
}

/** The composer took a refused message back. */
export function clearReturnedText() {
  if (state.returnedText !== null) publish({ returnedText: null });
}

let fillSeq = 0;

/** Put a suggested reply in the box (#3033); the composer takes it and clears it. */
export function fillComposer(text: string) {
  const body = String(text || '');
  if (!body.trim()) return;
  fillSeq += 1;
  publish({ composerFill: { text: body, seq: fillSeq } });
}

/** The composer took the tapped reply. */
export function clearComposerFill() {
  if (state.composerFill !== null) publish({ composerFill: null });
}

/**
 * The message a Stop hands back: the one still waiting to be answered, or the
 * newest the user sent. The composer takes it only when it is empty, so a
 * half-typed follow-up is never overwritten (the dev chat's rule).
 */
export function stoppedText(current: Pick<AgentSessionState, 'messages'> & { outbox?: OutboxItem[] }): string | null {
  const waiting = (current.outbox || []).filter((item) => item.status === 'sending' && item.message);
  if (waiting.length) return waiting[waiting.length - 1].message;
  for (let i = current.messages.length - 1; i >= 0; i -= 1) {
    const row = current.messages[i];
    if (row.role === 'user' && typeof row.content === 'string' && row.content.trim()) return row.content;
  }
  return null;
}

export async function stopAgentTurn() {
  const id = state.id;
  if (!id || !state.turn.running || state.turn.stopPending) return;
  const token = state.turn.stopToken;
  const turnId = state.turn.turnId;
  const sameTurn = () => state.id === id && state.turn.running
    && state.turn.stopToken === token && state.turn.turnId === turnId;
  // Back in the box to edit and send again, as the dev chat's Stop does. The
  // sent bubble stays: that turn really ran. Stopping first, so the box
  // filling up never turns the button under this click into Save.
  const text = stoppedText(state);
  patchTurn({ stopping: true, stopPending: true, stopError: null });
  if (text) publish({ returnedText: text });
  try {
    const answer = await api.stopTurn(id, { token });
    if (!sameTurn()) { if (state.id === id) await requestSync(id); return; }
    patchTurn({ stopPending: false });
    if (answer.stopRequestedAt) patchTurn({ stopRequestedAt: answer.stopRequestedAt });
    if (!answer.stopped && answer.reason === 'wrap_up_not_stoppable') patchTurn({ stopping: false });
    if (!answer.stopped && answer.reason === 'no_active_turn') {
      // Nothing is running here to send a `done`: settle from the server.
      patchTurn({ stopping: false });
      await requestSync(id);
    }
    if (answer.stopped) await requestSync(id);
  } catch (error) {
    if (!sameTurn()) { if (state.id === id) await requestSync(id); return; }
    patchTurn({ stopPending: false, stopError: errorText(error, 'Could not stop the agent. Try again.') });
    await requestSync(id);
  }
}

/** Stop the active change's before/after shots; the conversation re-reads to drop them. */
export async function stopPreviewCapture() {
  const id = state.id;
  const change = state.session?.activeChange;
  if (!id || !change || !change.appSlug || !change.previewCapture) return;
  try {
    await api.stopPreviewCapture(change.appSlug, change.id);
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not stop capturing previews.') });
  }
  if (state.id === id) await requestSync(id);
}

export async function decideCard(actionId: string, decision: 'confirm' | 'dismiss') {
  const id = state.id;
  if (!id || state.deciding) return;
  publish({ deciding: actionId, error: '' });
  try {
    if (decision === 'confirm') {
      const outcome = await api.confirmAction(id, actionId);
      // The Mayor's follow-up turn (the server's to run): the read below
      // finds it working and follows it.
      if (outcome.followUp && outcome.followUp.turnId) {
        patchTurn({ running: true, phase: 'mayor', startedAt: Date.now(), turnId: outcome.followUp.turnId });
      }
    } else {
      await api.dismissAction(id, actionId);
    }
  } catch (error) {
    publish({ error: errorText(error, 'That did not go through.') });
  } finally {
    publish({ deciding: null });
    void requestSync(id);
  }
}

export async function switchActiveChange(changeId: number) {
  const id = state.id;
  if (!id) return;
  try {
    const session = await api.switchChange(id, changeId);
    publish({ session, drawerOpen: false });
    void requestSync(id);
  } catch (error) {
    publish({ error: errorText(error, 'Could not switch to that change.') });
  }
}

export function setDrawerOpen(open: boolean) {
  publish({ drawerOpen: open });
}

// ── The session's own actions (the bar's ⋯) ────────────────────────────

/** Rename the conversation; asks for the name. */
export async function renameCurrentSession() {
  const id = state.id;
  const session = state.session;
  if (!id || !session) return;
  const title = await window.PlatformUI?.prompt?.({
    title: 'Rename this session',
    value: session.title || '',
    placeholder: 'What this conversation is about',
    confirmLabel: 'Rename',
  });
  if (title == null || !title.trim() || title.trim() === session.title || state.id !== id) return;
  try {
    const renamed = await api.renameSession(id, title.trim());
    if (state.id !== id) return;
    publish((current) => ({ session: renamed, sessions: withListed(current, renamed) }));
    syncTitle();
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not rename this session.') });
  }
}

/**
 * Archive the conversation, after a confirm. It leaves the lists; its
 * active change is paused (a change up for a vote keeps its vote), and the
 * conversation stays on screen, read-only, with Unarchive.
 */
export async function archiveCurrentSession() {
  const id = state.id;
  if (!id || state.session?.status === 'archived') return;
  const ok = await window.PlatformUI?.confirm?.({
    title: 'Archive this session?',
    message: 'It leaves your lists and its change is paused. A change up for a vote keeps its vote, and you can unarchive the session at any time.',
    confirmLabel: 'Archive',
  });
  if (!ok || state.id !== id) return;
  try {
    const session = await api.archiveSession(id);
    if (state.id !== id) return;
    publish((current) => ({ session, sessions: current.sessions.filter((s) => s.id !== id) }));
    void loadAgentSessions();
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not archive this session.') });
  }
}

export async function unarchiveCurrentSession() {
  const id = state.id;
  if (!id || state.session?.status !== 'archived') return;
  try {
    const session = await api.unarchiveSession(id);
    if (state.id !== id) return;
    publish({ session });
    void loadAgentSessions();
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not unarchive this session.') });
  }
}

// ── Handing the work to a coding agent on the web ──────────────────────

/** Open "Build with" on `agent`'s tab: the hand-off of this conversation's change. */
export function openHandoff(agent: HandoffAgent) {
  if (state.handoff !== agent) publish({ handoff: agent });
}

export function closeHandoff() {
  if (state.handoff) publish({ handoff: null });
}

// ── Checks ─────────────────────────────────────────────────────────────

/**
 * Re-run a change's checks on its current commit: the platform's own
 * recheck (AppView.castRecheck, POST /api/sessions/:id/recheck), which says
 * itself when it cannot. The change's `checks_ready` event, or the re-read
 * here, moves the card's line.
 */
export async function recheckChange(changeId: number) {
  const id = state.id;
  if (!id || state.changeAction) return;
  const cast = window.AppView?.castRecheck;
  if (typeof cast !== 'function') return;
  publish({ changeAction: { changeId, kind: 'recheck' } });
  try {
    await cast.call(window.AppView, changeId);
  } finally {
    if (actionOn(changeId, 'recheck')) publish({ changeAction: null });
    if (state.id === id) void requestSync(id);
  }
}

// ── Saved drafts ───────────────────────────────────────────────────────
//
// The dev chat's #798 list, per account (#940), for the conversation with the
// Mayor. While a turn runs the composer's button saves instead of sending:
// the text is parked here and sent later, always by a tap, never on its own.
// The server's list is the truth and every write answers with it; the screen
// updates first and settles on the answer.

export const MAX_SAVED_DRAFTS = 20;

function newDraftId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function loadDrafts(id: number) {
  try {
    const drafts = await api.listDrafts(id);
    if (state.id === id) publish({ drafts });
  } catch { /* the list stays as it was; the next write or event re-reads it */ }
}

/** Another device saved, sent or deleted one of this conversation's drafts. */
export function agentSessionDraftsChanged(event: { agentSessionId?: unknown } | null | undefined) {
  const id = Number(event?.agentSessionId);
  if (state.open && state.id && state.id === id) void loadDrafts(id);
}

async function parkDraft(id: number, text: string): Promise<boolean> {
  const draft: SavedDraft = { id: newDraftId(), text, savedAt: new Date().toISOString() };
  publish((current) => ({ drafts: [...current.drafts, draft] }));
  try {
    const drafts = await api.saveDraft(id, draft);
    if (state.id === id) publish({ drafts });
    return true;
  } catch (error) {
    if (state.id === id) {
      publish((current) => ({ drafts: current.drafts.filter((d) => d.id !== draft.id) }));
      toast(errorText(error, 'Could not save that draft.'));
    }
    return false;
  }
}

/**
 * The composer's Save while the Mayor works. Refused when no turn is running,
 * when the list is full, or with nothing typed: false, and the text stays in
 * the box. True once the list shows the draft, and the composer empties; a
 * save the server then refuses hands the text back to it.
 */
export function saveComposerDraft(text: string): boolean {
  const id = state.id;
  const body = text.trim();
  if (!id || !body || !state.turn.running) return false;
  if (state.drafts.length >= MAX_SAVED_DRAFTS) {
    toast(`That's ${MAX_SAVED_DRAFTS} saved drafts. Send or delete one first`);
    return false;
  }
  void parkDraft(id, body).then((saved) => {
    if (!saved && state.id === id) publish({ returnedText: body });
  });
  toast("Draft saved. Send it whenever you're ready");
  return true;
}

async function dropDraft(id: number, draftId: string) {
  publish((current) => ({ drafts: current.drafts.filter((d) => d.id !== draftId) }));
  try {
    const drafts = await api.deleteDraft(id, draftId);
    if (state.id === id) publish({ drafts });
  } catch (error) {
    if (state.id === id) {
      toast(errorText(error, 'Could not delete that draft.'));
      void loadDrafts(id);
    }
  }
}

/**
 * Send a saved draft now. Refused while the Mayor is working. What the box
 * held is kept as a draft of its own first, so emptying it for the send
 * never throws away something the user wrote (the dev chat's #1962 rule).
 */
export async function sendSavedDraft(draftId: string, typed = '') {
  const id = state.id;
  if (!id || state.turn.running) return;
  const draft = state.drafts.find((d) => d.id === draftId);
  if (!draft) return;
  const parked = typed.trim();
  void dropDraft(id, draftId);
  if (parked && parked !== draft.text && state.drafts.length < MAX_SAVED_DRAFTS) {
    void parkDraft(id, parked);
    toast('Kept what you had typed as another draft');
  }
  await sendAgentMessage(draft.text);
}

/**
 * Put a saved draft back in the box to reword it. Its text, for the composer
 * to take; what the box held is kept as a draft of its own first.
 */
export function editSavedDraft(draftId: string, typed = ''): string | null {
  const id = state.id;
  const draft = state.drafts.find((d) => d.id === draftId);
  if (!id || !draft) return null;
  const parked = typed.trim();
  void dropDraft(id, draftId);
  if (parked && parked !== draft.text && state.drafts.length < MAX_SAVED_DRAFTS) void parkDraft(id, parked);
  return draft.text;
}

export function deleteSavedDraft(draftId: string) {
  const id = state.id;
  if (!id || !state.drafts.some((d) => d.id === draftId)) return;
  void dropDraft(id, draftId);
}

// ── The spec viewer ────────────────────────────────────────────────────

let specRequest = 0;

/**
 * Open a change's spec over the conversation: the version a spec card names,
 * or the latest. The text is the change's own (GET /api/sessions/:id/spec and
 * /specs/:version), so it is what the change page's viewer shows.
 */
export async function openSpec(changeId: number, version: number | null = null) {
  const ticket = ++specRequest;
  const same = state.specSheet?.changeId === changeId ? state.specSheet : null;
  const tab: SpecTab = same ? same.tab : 'user';
  publish({
    drawerOpen: false,
    paneTab: 'spec',
    specSheet: { changeId, version, versions: same ? same.versions : [], text: '', phase: 'loading', error: '', tab },
  });
  try {
    const { spec, versions } = await api.getSpec(changeId);
    const numbers = versions.map((v) => Number(v.version)).filter((v) => Number.isInteger(v) && v > 0);
    const newest = numbers.length ? Math.max(...numbers) : null;
    const text = version != null && version !== newest ? await api.getSpecVersion(changeId, version) : spec;
    if (ticket !== specRequest) return;
    publish((current) => ({
      specSheet: { changeId, version: version ?? newest, versions: numbers, text, phase: 'ready', error: '', tab: current.specSheet?.tab ?? tab },
    }));
  } catch (error) {
    if (ticket !== specRequest) return;
    publish((current) => ({
      specSheet: current.specSheet
        ? { ...current.specSheet, phase: 'error', error: errorText(error, 'Could not load the spec.') }
        : null,
    }));
  }
}

export function closeSpec() {
  specRequest += 1;
  publish({ specSheet: null, paneTab: 'preview' });
}

// ── The preview in the side pane (#2779 follow-up) ─────────────────────

export const PREVIEW_SLOT_ID = 'agent-session-preview-slot';

/** The change a staging card is about, from the conversation on screen. */
export function changeById(changeId: number | null | undefined): AgentChange | null {
  if (changeId == null || !state.session) return null;
  return [state.session.activeChange, ...(state.session.changes || [])]
    .find((change) => change && change.id === changeId) || null;
}

/**
 * Show a change's preview in the side pane. The pane mounts its slot, then
 * asks the platform's preview to open docked over it (`dockPreview`).
 */
export function openPreview(preview: { changeId: number; url: string; prNumber: number | null }) {
  const change = changeById(preview.changeId);
  const app = change && change.appSlug ? { slug: change.appSlug, self_hosted: !!change.appSelfHosted } : null;
  publish({ drawerOpen: false, paneTab: 'preview', preview: { ...preview, app } });
}

/**
 * Called by the pane once its slot is on screen: this conversation becomes
 * the preview's dock host, and the platform's preview opens over the slot,
 * signed in to the change's app. Its own chrome (Full screen, the dev
 * console, x) works as it does beside the dev chat.
 */
export function dockPreview(preview: PreviewPaneState) {
  const view = typeof window !== 'undefined' ? window.AppView : null;
  if (!view || typeof view.ensureStaging !== 'function') return;
  view.setStagingDockHost?.({
    slotId: PREVIEW_SLOT_ID,
    live: () => state.open && !!state.preview,
    // Full screen leaves the slot where it is: exiting puts the preview back.
    collapse: () => {},
    redock: () => publish({ paneTab: 'preview' }),
    closed: () => {
      if (state.preview) publish({ preview: null, paneTab: 'spec' });
    },
  });
  void view.ensureStaging(preview.changeId, preview.url, null, {
    dock: true,
    readOnly: false,
    ...(preview.app ? { app: preview.app } : {}),
  });
}

/** Close the preview: the platform's overlay closes, and tells us (`closed`). */
export function closePreview() {
  const view = typeof window !== 'undefined' ? window.AppView : null;
  if (view && typeof view.closeStagingOverlay === 'function') view.closeStagingOverlay();
  if (state.preview) publish({ preview: null, paneTab: 'spec' });
}

let overPreview: PreviewPaneState | null = null;

/**
 * A change's preview where there is no room for the side pane (a phone, a
 * narrow window, the side panel beside a running app): the platform's own
 * preview over the conversation, signed in to the change's app, with its own
 * Back. It used to open the bare staging address in a new tab, signed out
 * and away from the chat. In the side panel it covers the panel, not the app
 * beside it; the panel's Expand takes it into the full-width chat, beside
 * the conversation (paneToCarry).
 */
export function openPreviewOver(preview: { changeId: number; url: string; prNumber: number | null }) {
  const view = typeof window !== 'undefined' ? window.AppView : null;
  if (!view || typeof view.ensureStaging !== 'function') {
    try { window.open(preview.url, '_blank', 'noopener'); } catch { /* nothing to open it with */ }
    return;
  }
  const change = changeById(preview.changeId);
  const app = change && change.appSlug ? { slug: change.appSlug, self_hosted: !!change.appSelfHosted } : null;
  const shown: PreviewPaneState = { ...preview, app };
  overPreview = shown;
  if (state.drawerOpen) publish({ drawerOpen: false });
  // Not a dock: this host only hears the preview close, so Expand knows
  // whether there is still one to carry.
  view.setStagingDockHost?.({
    slotId: PREVIEW_SLOT_ID,
    live: () => false,
    collapse: () => {},
    redock: () => {},
    closed: () => { if (overPreview === shown) overPreview = null; },
  });
  void view.ensureStaging(preview.changeId, preview.url, null, {
    readOnly: false,
    ...(app ? { app } : {}),
  });
}

/**
 * What a conversation has open beside it (or over it), to hand to another
 * document: the side panel's Expand opens the same conversation full width,
 * and the spec and the preview come along, beside it there.
 */
export interface CarriedPane {
  sessionId: number;
  spec: { changeId: number; version: number | null; tab: SpecTab } | null;
  preview: { changeId: number; url: string; prNumber: number | null } | null;
  tab: PaneTab;
}

export function paneToCarry(): CarriedPane | null {
  if (!state.open || typeof state.id !== 'number') return null;
  const sheet = state.specSheet;
  const shown = state.preview || overPreview;
  if (!sheet && !shown) return null;
  return {
    sessionId: state.id,
    spec: sheet ? { changeId: sheet.changeId, version: sheet.version, tab: sheet.tab } : null,
    preview: shown ? { changeId: shown.changeId, url: shown.url, prNumber: shown.prNumber } : null,
    tab: sheet && shown ? state.paneTab : (shown ? 'preview' : 'spec'),
  };
}

let carriedPane: CarriedPane | null = null;

/** Another document's open spec and preview, shown once that conversation is open here. */
export function adoptPane(pane: CarriedPane | null) {
  carriedPane = pane && typeof pane.sessionId === 'number' ? pane : null;
  applyCarriedPane();
}

function applyCarriedPane() {
  const pane = carriedPane;
  if (!pane || !state.open || state.id !== pane.sessionId || !state.session) return;
  carriedPane = null;
  if (pane.preview) openPreview(pane.preview);
  if (pane.spec) {
    void openSpec(pane.spec.changeId, pane.spec.version);
    setSpecTab(pane.spec.tab);
  }
  setPaneTab(pane.tab);
}

export function setPaneTab(tab: PaneTab) {
  if (state.paneTab !== tab) publish({ paneTab: tab });
}

function toast(message: string) {
  try { window.PlatformUI?.toast?.(message); } catch { /* the card keeps its buttons */ }
}

/** Read afresh: the action can end while an await is outstanding. */
function actionOn(changeId: number, kind?: NonNullable<AgentSessionState['changeAction']>['kind']): boolean {
  const action: AgentSessionState['changeAction'] = state.changeAction;
  return !!action && action.changeId === changeId && (!kind || action.kind === kind);
}

/**
 * The staging card's Propose, once confirmed: the owner's propose route. The
 * confirmation is the card's own panel under the button (#3032,
 * ./propose-confirm.tsx), no longer a dialog asked for here. The card then
 * reads "In vote" from the refreshed change.
 */
export async function proposeChange(changeId: number) {
  if (state.changeAction) return;
  publish({ changeAction: { changeId, kind: 'propose' } });
  try {
    await api.promoteChange(changeId);
    if (state.id != null) await requestSync(state.id);
  } catch (error) {
    toast(errorText(error, 'Could not put this change up for the vote.'));
  } finally {
    if (actionOn(changeId)) publish({ changeAction: null });
  }
}

/**
 * The failed card's Retry: rebuild the preview. The build's own
 * staging_ready or staging_failed comes back through the conversation and
 * writes the next card; this one reads "Retrying" until then.
 */
export const RETRY_GIVE_UP_MS = 180_000;

export async function retryStaging(changeId: number) {
  if (state.changeAction) return;
  publish({ changeAction: { changeId, kind: 'retry' } });
  try {
    const result = await api.ensureChangeStaging(changeId);
    if (result.status === 'rebuilding') {
      // The dev chat preview's give-up: a build whose answer never lands (a
      // restart, a lost event) must not leave the card saying "Retrying…".
      const timer = setTimeout(() => {
        const action: AgentSessionState['changeAction'] = state.changeAction;
        if (action && action.changeId === changeId && action.kind === 'retry') {
          publish({ changeAction: null });
          toast('The rebuild is still running. Its result will appear in this conversation.');
        }
      }, RETRY_GIVE_UP_MS) as unknown as { unref?: () => void };
      timer.unref?.();
      return;
    }
    if (result.status === 'unavailable') toast('This preview can\'t be rebuilt right now. Ask the agent to look at the build.');
    if (state.id != null) await requestSync(state.id);
  } catch (error) {
    toast(errorText(error, 'Could not rebuild the preview.'));
  }
  if (actionOn(changeId)) publish({ changeAction: null });
}

/** Switch the open spec between its plain-language and technical halves. No fetch. */
export function setSpecTab(tab: SpecTab) {
  const next: SpecTab = tab === 'tech' ? 'tech' : 'user';
  publish((current) => (current.specSheet && current.specSheet.tab !== next
    ? { specSheet: { ...current.specSheet, tab: next } }
    : {}));
}

// ── The model ──────────────────────────────────────────────────────────

/**
 * Read the picker's options once per page. Whatever answered is published at
 * once, so the model pill appears; a part that did not answer (a failure, an
 * error, or a read that ran out of time: ./api.ts) is read again on the next
 * call, which comes when a conversation is opened or routed to
 * (openAgentSession), when the page comes back to the foreground and when the
 * network returns (the composer, ./index.tsx). A complete catalog is never
 * read again.
 *
 * Member-only, so it waits for a viewer the endpoint answers (QA 2026-09-24
 * Q35, ../../lib/platform-viewer.ts) instead of spending a 401 or 403 on a
 * signed-out or waitlisted document; `sv:authed` asks again.
 */
let catalogDeferred = false;
// null until the first read; then the parts still owed.
let catalogMissing: api.CatalogPart[] | null = null;
export function loadModelCatalog(): Promise<void> {
  if (state.catalog && catalogMissing && !catalogMissing.length) return Promise.resolve();
  if (!hasPlatformViewer()) {
    if (!catalogDeferred) {
      catalogDeferred = true;
      whenPlatformViewer(() => { catalogDeferred = false; void loadModelCatalog(); });
    }
    return Promise.resolve();
  }
  if (!catalogRequest) {
    catalogRequest = api.loadModelCatalog(state.catalog, catalogMissing)
      .then(({ catalog, missing }) => {
        catalogMissing = missing;
        publish({ catalog });
      })
      .catch(() => {})
      .finally(() => { catalogRequest = null; });
  }
  return catalogRequest;
}

/**
 * The picker. On an unsent conversation the pick is held and sent with the
 * first message; on a session it is saved now and applies from the Mayor's
 * next turn and the active change's next build, so it may be made mid-turn.
 */
export async function chooseAgent(choice: AgentChoice) {
  if (!state.id && state.draft) {
    if (!sameChoice(state.draft.agent, choice)) publish({ draft: { ...state.draft, agent: choice } });
    return;
  }
  const id = state.id;
  if (!id || state.choosing) return;
  if (sameChoice(state.session?.agent || null, choice)) return;
  publish({ choosing: true, error: '' });
  try {
    const session = await api.setAgentChoice(id, choice);
    if (state.id === id) publish({ session });
  } catch (error) {
    if (state.id === id) publish({ error: errorText(error, 'Could not change the model.') });
  } finally {
    publish({ choosing: false });
  }
}

// ── The list, for Messages ─────────────────────────────────────────────

// One of the user's conversations changed (the server's
// `agent_session_changed`, routed by app.js): the database announces every
// write a screen draws, with the conversation's new version, on every pod;
// a turn starting or ending, or a read in another tab, says so too. The
// lists redraw their marks from a fresh read; a burst of events is one read.
let listTimer: ReturnType<typeof setTimeout> | null = null;
export function agentSessionListChanged(event?: { agentSessionId?: unknown; version?: unknown } | null) {
  // The conversation on screen: read it, unless this screen already holds
  // that version (its own read got there first).
  const openId = state.id;
  if (openId && state.open && event && Number(event.agentSessionId) === openId) {
    const announced = typeof event.version === 'number' ? event.version : null;
    if (announced == null || state.version == null || announced > state.version) void requestSync(openId);
  }
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void loadAgentSessions();
  }, 250);
}

/**
 * The list is per-user, and this is called at mount by Messages, the nav's
 * recents and the app sheet, all of which are mounted on every document. So
 * it waits for a viewer `/api/agent-sessions` answers (QA 2026-09-24 Q35,
 * ../../lib/platform-viewer.ts) rather than logging a 401 on the signed-out
 * landing or a 403 in the waiting room, and loads on `sv:authed` instead.
 */
let sessionsDeferred = false;
// Which read of the list is the newest (#3073). Opening the Homeroom menu
// reads it, and so does every push that a turn started or ended, so two reads
// are often in flight at once; an older answer landing last used to put back
// the marks from before the turn started, and the lists stopped spinning
// while the session worked. Only the newest read's answer is published.
let listRead = 0;
export async function loadAgentSessions() {
  if (!hasPlatformViewer()) {
    if (!sessionsDeferred) {
      sessionsDeferred = true;
      whenPlatformViewer(() => { sessionsDeferred = false; void loadAgentSessions(); });
    }
    return;
  }
  const read = ++listRead;
  try {
    const sessions = await api.listSessions();
    if (read !== listRead) return;
    publish({ sessions, sessionsLoaded: true });
  } catch {
    if (read !== listRead) return;
    publish({ sessionsLoaded: true });
  }
}

export const agentSessionController = {
  open: (id: AgentSessionTarget, options: { host?: AgentSessionHost } = {}) => openAgentSession({ id, host: options.host }),
  route: (id: AgentSessionTarget, options: { drawer?: boolean } = {}) => openAgentSession({ id, host: 'screen', drawer: !!options.drawer }),
  start: (hint: AgentHint | null = null) => startAgentSession(hint),
  prepareDraft: prepareAgentDraft,
  deactivate: deactivateAgentSession,
  isOpen: () => state.open,
  /** The conversation on screen: its id, `new` while it is unsent, or null. */
  currentId: (): AgentSessionTarget | null => (state.id ?? (state.draft ? 'new' : null)),
  refreshList: loadAgentSessions,
  listChanged: agentSessionListChanged,
  /** The notices' socket came back (app.js resyncCurrentView): read what it missed. */
  resync: resyncAgentSession,
  draftsChanged: agentSessionDraftsChanged,
  /** The side panel's Expand: what this document's conversation has open, and taking it in the other. */
  paneToCarry,
  adoptPane,
};

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.agentSession = agentSessionController;
}
