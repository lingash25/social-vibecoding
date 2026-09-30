// Agent sessions (#2779, docs/agent-sessions.md): the HTTP surface the
// conversation screen reads and writes. Every route is owner-scoped on the
// server (src/routes/agent-sessions.js); nothing here decides access.

export interface AgentChange {
  id: number;
  appSlug: string | null;
  appName: string | null;
  status: string | null;
  title: string | null;
  prNumber: number | null;
  stagingUrl?: string | null;
  checkState?: string | null;
  /** Checks that failed on the last run. */
  checkFailing?: number;
  /** Why the checks were skipped, when they were and a reason was recorded. */
  checkSkipReason?: string | null;
  /** The change is to the platform's own (self-hosted) app. */
  appSelfHosted?: boolean;
  /** Its before/after shots, while they are being taken. */
  previewCapture?: { state: string; startedAt: string | null } | null;
}

/**
 * The conversation's model (the composer's picker): Claude Code on an
 * Anthropic model, or Codex on an OpenRouter model with a reasoning effort
 * where the model offers one. Null on a session follows the user's default.
 */
export interface AgentChoice {
  backend: 'claude_code' | 'codex_openrouter';
  model: string | null;
  reasoningEffort: string | null;
}

export interface AgentSession {
  id: number;
  title: string | null;
  status: 'open' | 'archived';
  focusApp: {
    id: number;
    slug: string | null;
    name: string | null;
    /** True for the platform's own row: its app surface is the platform. */
    selfHosted?: boolean;
    /** The app's own tile artwork, as the launcher draws it. */
    iconUrl?: string | null;
    iconEmoji?: string | null;
  } | null;
  focusContext: Record<string, unknown>;
  agent?: AgentChoice | null;
  activeChange: AgentChange | null;
  changes?: AgentChange[];
  busy: boolean;
  /** A turn finished after the owner last read the conversation (the lists' green dot). */
  doneUnseen?: boolean;
  lastActivityAt: string | null;
  createdAt: string | null;
  /**
   * The server's count of writes to this conversation (schema.sql, "Keeping
   * every screen of a conversation in step"): a screen holding an older one
   * re-reads its state.
   */
  version?: number;
}

export interface AgentTurnState {
  /** The running turn's id, where it is known: the lease every pod reads. */
  id?: string | null;
  phase: 'mayor' | 'cc' | 'mayor2';
  stopping?: boolean;
  stopRequestedAt?: number | null;
  stopToken?: string | null;
  canForceStop?: boolean;
  changeId?: number | null;
  /** Epoch ms the running work started: the build once dispatched, else the turn. */
  startedAt?: number | null;
}

export interface AgentMessage {
  id: number;
  changeId: number | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** The model that wrote an assistant row, as recorded. */
  model?: string | null;
  /** What the row cost, in (fractional) cents; null or 0 for none recorded. */
  costCents?: number | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  /** The sending screen's own id for a user message, when it gave one. */
  clientMessageId?: string | null;
  /** When the row was written or last edited, in the database's order. */
  rev?: number;
}

/**
 * A file sent with a message (#2779 follow-up): the dev chat's attachment
 * shape, as routes/agent-sessions.js answers an upload and as a user row's
 * `metadata.attachments` carries it.
 */
export interface AgentAttachment {
  id: string;
  /** 'image' | 'text' | 'zip' | 'binary', decided by the server. */
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  meta?: Record<string, unknown> | null;
}

/** One saved draft (#798's list, per account): the server's wire shape. */
export interface SavedDraft {
  id: string;
  text: string;
  savedAt: string | null;
}

export interface AgentCard {
  id: string;
  toolName: string;
  title: string;
  input: Record<string, unknown>;
  expiresAt: string;
}

export type AgentActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'dismissed' | 'expired';

export interface AgentAction {
  id: string;
  toolName: string;
  title: string;
  status: AgentActionStatus;
  result: { ok?: boolean; code?: string | null; text?: string; structured?: Record<string, unknown> | null } | null;
  /** What happened, in plain words: the card's "Confirmed · …" line. */
  outcome?: string | null;
  expiresAt: string;
}

export interface AgentTurnEvent {
  type: string;
  _seq?: string;
  [key: string]: unknown;
}

export interface ChangeDetail {
  id: number;
  status?: string;
  staging_url?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  checks_state?: string | null;
  [key: string]: unknown;
}

export interface AgentHint {
  slug?: string;
  issueNumber?: number;
  proposalId?: number;
  entry?: string;
  /**
   * The request's title, when the entry point had it (a request card's Start
   * work). For the screen only: the unsent conversation names the request and
   * seeds its first message with it (./request-seed.ts). The server reads the
   * request itself, so this never leaves the browser (serverHint).
   */
  issueTitle?: string;
  /**
   * The first message the unsent conversation offers, unsent and editable,
   * when the entry point has one to hand over: Global Chat's development
   * task, or Explore's message about a proposal. For the screen only, like
   * the title (./request-seed.ts draftSeed).
   */
  message?: string;
  /**
   * Open the composer's "Build with" sheet on this agent's tab: the
   * out-of-credits card's "Use Claude Code" / "Use Codex". Screen only.
   */
  handoff?: 'claude-code' | 'codex';
}

/** The hint as the server takes it: the fields it resolves, nothing the screen added. */
export function serverHint(hint: AgentHint | null | undefined): AgentHint | null {
  if (!hint) return null;
  const out: AgentHint = {};
  if (hint.slug != null) out.slug = hint.slug;
  if (hint.issueNumber != null) out.issueNumber = hint.issueNumber;
  if (hint.proposalId != null) out.proposalId = hint.proposalId;
  if (hint.entry != null) out.entry = hint.entry;
  return out;
}

/** What an unsent conversation is about: its hint, resolved and not saved. */
export interface AgentDraftPreview {
  focusApp: AgentSession['focusApp'];
  focusContext: Record<string, unknown>;
}

export interface AnthropicModel {
  id: string;
  label: string;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  /** The catalog's published prices, for the cost of a typical change. */
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
  supportsReasoning?: boolean;
  isRecommended?: boolean;
  isDefaultFavorite?: boolean;
  isFavorite?: boolean;
  /** Which CLI the platform runs this model in (#3296). */
  harness?: 'claude' | 'codex';
}

/** Everything the picker offers, read once per page. */
export interface ModelCatalog {
  anthropic: AnthropicModel[];
  anthropicDefault: string | null;
  /** The user's saved default, which a conversation with no choice follows. */
  defaultBackend: AgentChoice['backend'];
  savedOpenRouter: { model: string | null; reasoningEffort: string | null } | null;
  defaultReasoningEffort: string | null;
  codexAvailable: boolean;
  openrouter: OpenRouterModel[];
  recommendedOpenRouterId: string | null;
  /** What a typical change costs on each model (GET /api/model-notes). */
  notes: ModelNotes | null;
}

/**
 * The platform's per-model notes and estimates (#2570): an estimate for each
 * curated model, and the token profile of a typical change, which prices any
 * other model from its catalog prices.
 */
export interface ModelNotes {
  typicalChange: { inputTokens: number; outputTokens: number } | null;
  models: Record<string, { note?: string | null; estimateCents?: number | null }>;
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error || fallback) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function request(path: string, init: RequestInit = {}) {
  return fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
}

/** Called on the first message of an unsent conversation, with what was picked while it was unsent. */
export async function createSession(hint: AgentHint | null, agent: AgentChoice | null = null): Promise<AgentSession> {
  const payload: { hint?: AgentHint; agent?: AgentChoice } = {};
  const sent = serverHint(hint);
  if (sent) payload.hint = sent;
  if (agent) payload.agent = agent;
  const body = await json<{ session: AgentSession }>(
    await request('/api/agent-sessions', { method: 'POST', body: JSON.stringify(payload) }),
    'Could not start an agent session.',
  );
  return body.session;
}

export async function previewDraft(hint: AgentHint | null): Promise<AgentDraftPreview> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(serverHint(hint) || {})) {
    if (value != null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  const body = await json<{ draft: AgentDraftPreview }>(
    await request(`/api/agent-sessions/draft${suffix}`),
    'Could not load this agent session.',
  );
  return body.draft;
}

export async function setAgentChoice(id: number, agent: AgentChoice): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/agent`, { method: 'PATCH', body: JSON.stringify(agent) }),
    'Could not change the model.',
  );
  return body.session;
}

/** The reads the picker is built from, each of which can be asked again on its own. */
export type CatalogPart = 'models' | 'prefs' | 'notes' | 'openrouter';

export interface CatalogRead {
  catalog: ModelCatalog;
  /** The parts that did not answer this time, to ask again later; empty once all have. */
  missing: CatalogPart[];
}

// How long the picker waits for one read. A request that never settles (a
// stalled socket, a phone app resuming on a radio that is still waking) used
// to hold the whole catalog, and with it the model pill, for the rest of the
// page. The OpenRouter list waits longer: the server reads the key's own
// catalogue from OpenRouter for it, and gives that read 20 seconds.
const CATALOG_READ_MS = 10_000;
const CATALOG_LIST_MS = 30_000;

/** A read's JSON, or null when it failed, answered an error, or ran out of time. */
function readWithin(path: string, ms: number): Promise<unknown> {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => { abort?.abort(); resolve(null); }, ms);
  });
  const read = request(path, abort ? { signal: abort.signal } : {})
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return Promise.race([read, expired]).finally(() => clearTimeout(timer));
}

/**
 * The picker's options: the Anthropic models (GET /api/models), the saved
 * default (GET /api/me/coding-agent) and, where OpenRouter is offered, the
 * viewer's OpenRouter catalog. A part that does not load is left out rather
 * than failing the picker, and named in `missing` so the caller can ask for
 * it again: pass back the catalog and those parts, and only they are read,
 * over what was already known. The server validates every pick anyway.
 */
export async function loadModelCatalog(
  previous: ModelCatalog | null = null,
  retry: CatalogPart[] | null = null,
): Promise<CatalogRead> {
  const catalog: ModelCatalog = previous ? { ...previous } : {
    anthropic: [],
    anthropicDefault: null,
    defaultBackend: 'claude_code',
    savedOpenRouter: null,
    defaultReasoningEffort: null,
    codexAvailable: false,
    openrouter: [],
    recommendedOpenRouterId: null,
    notes: null,
  };
  const wanted = (part: CatalogPart) => !previous || !retry || retry.includes(part);
  const missing: CatalogPart[] = [];
  const read = (part: CatalogPart, path: string) => (wanted(part)
    ? readWithin(path, CATALOG_READ_MS).then((body) => {
      if (!body) missing.push(part);
      return body;
    })
    : Promise.resolve(null));
  const [models, prefs, notes] = await Promise.all([
    read('models', '/api/models'),
    read('prefs', '/api/me/coding-agent'),
    read('notes', '/api/model-notes'),
  ]) as [
    { models?: Array<{ id?: unknown; label?: unknown }>; default?: unknown } | null,
    {
      defaultBackend?: unknown;
      backends?: Record<string, { model?: unknown; reasoningEffort?: unknown } | undefined>;
      codexAvailable?: unknown;
      defaultReasoningEffort?: unknown;
    } | null,
    { typicalChange?: { inputTokens?: unknown; outputTokens?: unknown } | null; models?: unknown } | null,
  ];
  if (notes && notes.models && typeof notes.models === 'object') {
    const profile = notes.typicalChange;
    const input = Number(profile?.inputTokens);
    const output = Number(profile?.outputTokens);
    catalog.notes = {
      typicalChange: Number.isFinite(input) && Number.isFinite(output) ? { inputTokens: input, outputTokens: output } : null,
      models: notes.models as ModelNotes['models'],
    };
  }
  if (models && Array.isArray(models.models)) {
    catalog.anthropic = models.models
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: String(m.id), label: typeof m.label === 'string' && m.label ? m.label : String(m.id) }));
    catalog.anthropicDefault = typeof models.default === 'string' ? models.default : null;
  }
  if (prefs) {
    catalog.defaultBackend = prefs.defaultBackend === 'codex_openrouter' ? 'codex_openrouter' : 'claude_code';
    const saved = prefs.backends?.codex_openrouter;
    if (saved) {
      catalog.savedOpenRouter = {
        model: typeof saved.model === 'string' && saved.model ? saved.model : null,
        reasoningEffort: typeof saved.reasoningEffort === 'string' && saved.reasoningEffort ? saved.reasoningEffort : null,
      };
    }
    catalog.codexAvailable = prefs.codexAvailable === true;
    catalog.defaultReasoningEffort = typeof prefs.defaultReasoningEffort === 'string' ? prefs.defaultReasoningEffort : null;
  }
  // The list is read once the preferences say OpenRouter is offered. Until
  // they have answered nobody knows whether it is, so it stays owed.
  if (missing.includes('prefs')) {
    if (wanted('openrouter')) missing.push('openrouter');
  } else if (catalog.codexAvailable && (wanted('openrouter') || prefs)) {
    const list = await readWithin('/api/me/coding-agent/models?backend=codex_openrouter', CATALOG_LIST_MS) as
      { models?: OpenRouterModel[]; recommendedModelId?: unknown } | null;
    if (list && Array.isArray(list.models)) {
      catalog.openrouter = list.models.filter((m) => m && typeof m.id === 'string');
      catalog.recommendedOpenRouterId = typeof list.recommendedModelId === 'string' ? list.recommendedModelId : null;
    } else {
      missing.push('openrouter');
    }
  }
  return { catalog, missing };
}

export async function listDrafts(id: number): Promise<SavedDraft[]> {
  const body = await json<{ drafts: SavedDraft[] }>(await request(`/api/agent-sessions/${id}/drafts`), 'Could not load your saved drafts.');
  return body.drafts || [];
}

export async function saveDraft(id: number, draft: SavedDraft): Promise<SavedDraft[]> {
  const body = await json<{ drafts: SavedDraft[] }>(
    await request(`/api/agent-sessions/${id}/drafts`, { method: 'POST', body: JSON.stringify(draft) }),
    'Could not save that draft.',
  );
  return body.drafts || [];
}

export async function deleteDraft(id: number, draftId: string): Promise<SavedDraft[]> {
  const body = await json<{ drafts: SavedDraft[] }>(
    await request(`/api/agent-sessions/${id}/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }),
    'Could not delete that draft.',
  );
  return body.drafts || [];
}

export async function renameSession(id: number, title: string): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/title`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    'Could not rename this session.',
  );
  return body.session;
}

export async function archiveSession(id: number): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/archive`, { method: 'POST' }),
    'Could not archive this session.',
  );
  return body.session;
}

export async function unarchiveSession(id: number): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/unarchive`, { method: 'POST' }),
    'Could not unarchive this session.',
  );
  return body.session;
}

/**
 * Where a hand-off to Claude Code or Codex on the web stands for this
 * person and app (GET /api/apps/:slug/dev-flow/status, the dev chat's own
 * walkthrough): GitHub linked, the fork, the connector, and the instructions
 * to paste. `change` names the change the hand-off continues, whose spec
 * the instructions then carry.
 */
export interface HandoffStatus {
  available?: boolean;
  reason?: string | null;
  github?: { linked?: boolean; login?: string | null };
  connectors?: { count?: number };
  fork?: { state?: string; owner?: string; repo?: string; url?: string; pageUrl?: string } | null;
  targetKind?: 'session' | 'proposal' | null;
  instructions?: string;
  /** Whether `instructions` carry the change's spec (asked for with `specFrom`). */
  specCarried?: boolean;
  [key: string]: unknown;
}

export async function handoffStatus(slug: string, change: { id: number; kind: 'session' | 'proposal' } | null): Promise<HandoffStatus> {
  const query = new URLSearchParams();
  if (change) {
    query.set('sessionId', String(change.id));
    query.set('proposalId', String(change.id));
    query.set('targetKind', change.kind);
    // #3078: the instructions carry this change's spec. Only a claim: the
    // server reads it only when the change is the viewer's own.
    query.set('specFrom', String(change.id));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return json(
    await request(`/api/apps/${encodeURIComponent(slug)}/dev-flow/status${suffix}`),
    'Could not check where the hand-off stands.',
  );
}

export async function listSessions(): Promise<AgentSession[]> {
  const body = await json<{ sessions: AgentSession[] }>(await request('/api/agent-sessions'), 'Could not load agent sessions.');
  return body.sessions || [];
}

export async function getSession(id: number): Promise<{ session: AgentSession; turn: AgentTurnState | null }> {
  return json(await request(`/api/agent-sessions/${id}`), 'Could not load this agent session.');
}

/**
 * A conversation read in one consistent snapshot (GET .../state): what the
 * screen draws, the version and rev it was read at, and the running turn.
 * Sent the version it holds, the server answers only `unchanged` (and
 * `busy`) while that is still current; sent a rev, only the rows written or
 * edited since (`full: false`).
 */
export type AgentStateRead =
  | { unchanged: true; version: number; busy: boolean; turn: AgentTurnState | null }
  | {
    unchanged: false;
    version: number;
    busy: boolean;
    turn: AgentTurnState | null;
    session: AgentSession;
    messages: AgentMessage[];
    full: boolean;
    nextAfter: number | null;
    rev: number;
    actions: AgentAction[];
  };

export async function getState(id: number, { version = null, rev = null }: { version?: number | null; rev?: number | null } = {}): Promise<AgentStateRead> {
  const query = new URLSearchParams();
  if (version != null) query.set('version', String(version));
  if (rev != null) query.set('rev', String(rev));
  const suffix = query.toString() ? `?${query}` : '';
  return json(await request(`/api/agent-sessions/${id}/state${suffix}`), 'Could not load this agent session.');
}

export async function getMessages(id: number, after = 0): Promise<{ messages: AgentMessage[]; nextAfter: number | null }> {
  return json(await request(`/api/agent-sessions/${id}/messages?after=${after}&limit=200`), 'Could not load the conversation.');
}

export async function getActions(id: number): Promise<AgentAction[]> {
  const body = await json<{ actions: AgentAction[] }>(await request(`/api/agent-sessions/${id}/actions`), 'Could not load confirmations.');
  return body.actions || [];
}

export async function confirmAction(id: number, actionId: string) {
  return json<{ status: string; result: AgentAction['result']; followUp: { turnId: string } | null }>(
    await request(`/api/agent-sessions/${id}/actions/${encodeURIComponent(actionId)}/confirm`, { method: 'POST' }),
    'That confirmation did not go through.',
  );
}

export async function dismissAction(id: number, actionId: string) {
  return json<{ ok: boolean }>(
    await request(`/api/agent-sessions/${id}/actions/${encodeURIComponent(actionId)}/dismiss`, { method: 'POST' }),
    'Could not dismiss that confirmation.',
  );
}

export async function switchChange(id: number, changeId: number): Promise<AgentSession> {
  const body = await json<{ session: AgentSession }>(
    await request(`/api/agent-sessions/${id}/active-change`, { method: 'POST', body: JSON.stringify({ changeId }) }),
    'Could not switch to that change.',
  );
  return body.session;
}

export async function stopTurn(id: number, options: { token?: string | null; force?: boolean } = {}): Promise<{ stopped: boolean; reason?: string; stopRequestedAt?: number | null }> {
  return json<{ stopped: boolean; reason?: string; stopRequestedAt?: number | null }>(
    await request(`/api/agent-sessions/${id}/stop`, { method: 'POST', body: JSON.stringify(options) }),
    'Could not stop the agent. Try again.',
  );
}

/** Stop the change's running before/after shots (the proposal's Take again starts them again). */
export async function stopPreviewCapture(appSlug: string, changeId: number): Promise<{ stopped: boolean; reason?: string }> {
  return json<{ stopped: boolean; reason?: string }>(
    await request(`/api/apps/${encodeURIComponent(appSlug)}/proposals/${changeId}/shots/stop`, { method: 'POST', body: '{}' }),
    'Could not stop capturing previews.',
  );
}

export interface SpecVersion {
  version: number;
  built_at?: string | null;
  pr_number?: number | null;
}

/**
 * A change's spec, from the change's own routes (the conversation's owner
 * owns its changes): the latest text and its saved versions, newest first.
 */
export async function getSpec(changeId: number): Promise<{ spec: string; versions: SpecVersion[] }> {
  const body = await json<{ spec?: string; versions?: SpecVersion[] }>(
    await request(`/api/sessions/${changeId}/spec`),
    'Could not load the spec.',
  );
  return { spec: typeof body.spec === 'string' ? body.spec : '', versions: Array.isArray(body.versions) ? body.versions : [] };
}

/**
 * Put a change up for the group's vote: the owner's propose route, the same
 * one the dev chat's Propose button and an imported PR's use.
 */
export async function promoteChange(changeId: number): Promise<void> {
  await json(await request(`/api/sessions/${changeId}/promote`, { method: 'POST' }), 'Could not put this change up for the vote.');
}

/**
 * Rebuild a change's preview when it is not running (the staging card's
 * Retry): the owner's ensure route. `rebuilding` means a build started and
 * its staging_ready or staging_failed reaches the conversation.
 */
export async function ensureChangeStaging(changeId: number): Promise<{ status: string; url?: string | null; reason?: string | null }> {
  return json(await request(`/api/sessions/${changeId}/ensure-staging`, { method: 'POST' }), 'Could not rebuild the preview.');
}

export async function getSpecVersion(changeId: number, version: number): Promise<string> {
  const body = await json<{ spec?: { content?: string } }>(
    await request(`/api/sessions/${changeId}/specs/${version}`),
    'Could not load that version of the spec.',
  );
  return body.spec && typeof body.spec.content === 'string' ? body.spec.content : '';
}

export async function getChange(changeId: number): Promise<ChangeDetail | null> {
  const response = await request(`/api/sessions/${changeId}`);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { session?: ChangeDetail } | ChangeDetail | null;
  if (!body) return null;
  return (body as { session?: ChangeDetail }).session || (body as ChangeDetail);
}

/**
 * Read a server-sent event stream from a fetch response. The agent turn
 * writes `data: {json}` frames whose JSON carries its own `type`; an
 * `event:` line, when present, names it instead.
 */
export async function readEventStream(
  response: Response,
  onEvent: (event: AgentTurnEvent) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) { eventName = ''; return; }
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      onEvent({ ...parsed, type: eventName || String(parsed.type || 'message') });
    } catch {
      // A malformed frame is dropped rather than rendered.
    }
    eventName = '';
    dataLines = [];
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line) dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
  dispatch();
}

/**
 * POST a turn and stream its events. Throws with the server's answer when it
 * refuses. `clientMessageId` is this screen's own id for the message: sent
 * again after a dropped connection, the server recognises it and answers
 * that it already has it (`duplicate`), with no second turn. `retry` re-runs
 * a turn that did not finish, with no message of its own.
 */
export async function sendTurn(
  id: number,
  message: string,
  { signal, onEvent, attachmentIds = [], clientMessageId = null, retry = false }: {
    signal?: AbortSignal;
    onEvent: (event: AgentTurnEvent) => void;
    /** Uploads to this conversation (uploadAttachment), sent with the message. */
    attachmentIds?: string[];
    clientMessageId?: string | null;
    retry?: boolean;
  },
): Promise<{ duplicate: boolean; messageId?: number | null }> {
  const payload: Record<string, unknown> = retry ? { retry: true } : { message };
  if (attachmentIds.length) payload.attachmentIds = attachmentIds;
  if (clientMessageId) payload.clientMessageId = clientMessageId;
  const response = await fetch(`/api/agent-sessions/${id}/turns`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    await json(response, 'The Mayor could not take that message.');
    return { duplicate: false };
  }
  // The stream is the answer; JSON is the exception: the server already had
  // this message (a retry after a dropped connection).
  if (/application\/json/.test(response.headers?.get?.('Content-Type') || '')) {
    const body = await json<{ duplicate?: boolean; messageId?: number }>(response, 'The Mayor could not take that message.');
    return { duplicate: !!body.duplicate, messageId: body.messageId ?? null };
  }
  await readEventStream(response, onEvent);
  return { duplicate: false };
}

/**
 * One file's bytes, uploaded to the conversation before the message that
 * sends it (the dev chat's two-step, #450): the server decides its kind from
 * the name and the bytes, never from what the browser says it is.
 */
export async function uploadAttachment(id: number, file: Blob, filename: string): Promise<AgentAttachment> {
  return json<AgentAttachment>(
    await fetch(`/api/agent-sessions/${id}/attachments?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      body: file,
    }),
    `Could not attach ${filename}.`,
  );
}

/** Where a sent file is served, to the conversation's owner only. */
export function attachmentUrl(id: number, attachmentId: string): string {
  return `/api/agent-sessions/${id}/attachments/${encodeURIComponent(attachmentId)}`;
}
