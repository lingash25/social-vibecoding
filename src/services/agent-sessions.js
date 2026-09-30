'use strict';

// Agent sessions (#2779, spec: docs/agent-sessions.md).
//
// An agent session is one long-lived conversation between a user and the
// Mayor. It is not bound to an app and never closes on its own. The work it
// does happens in CHANGES, which are ordinary chat_sessions rows linked back
// through chat_sessions.agent_session_id, so staging, checks, votes and merge
// run exactly as they do for any proposal. The session tracks one active
// change at a time (D4): starting or switching to another change parks the
// current one, which is today's `paused`.
//
// This module is the data layer: creating and reading sessions, linking a
// change to its session, and the notes the conversation gets when a change
// closes. The Mayor's turn arrives in the next step of #2779.
//
// Every read and write is scoped to the owner. A session is private to the
// user who started it; other members see its changes the way they see any
// proposal.

const log = require('./logger');
const appAccess = require('./app-access');

const TITLE_MAX = 256;
const LIST_LIMIT_MAX = 50;
const MESSAGES_LIMIT_MAX = 200;
const ENTRIES = Object.freeze(['improve', 'workshop', 'app', 'issue', 'feedback', 'proposal', 'messages', 'banner', 'global-chat']);

class AgentSessionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AgentSessionError';
    this.status = status;
  }
}

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null);

// ── The app hint ───────────────────────────────────────────────────────
//
// Whatever the entry point knew — an app, and perhaps the request or the
// proposal the user was looking at — stored as the session's focus. It is a
// starting assumption for the Mayor, never a limit. An app the user cannot
// see is dropped rather than refused: the hint is a convenience, and refusing
// the session over it would make a stale link a dead end.
function parseHint(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentSessionError(400, 'hint must be an object');
  }
  const allowed = ['slug', 'issueNumber', 'proposalId', 'entry'];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AgentSessionError(400, `Unsupported hint field: ${unknown[0]}`);
  const slug = raw.slug == null ? null : String(raw.slug);
  if (slug !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new AgentSessionError(400, 'hint.slug must be an app slug');
  }
  const issueNumber = raw.issueNumber == null ? null : positiveInt(raw.issueNumber);
  const proposalId = raw.proposalId == null ? null : positiveInt(raw.proposalId);
  if ((raw.issueNumber != null && issueNumber === null) || (raw.proposalId != null && proposalId === null)) {
    throw new AgentSessionError(400, 'hint.issueNumber and hint.proposalId must be positive integers');
  }
  if ((issueNumber || proposalId) && !slug) {
    throw new AgentSessionError(400, 'hint.slug is required with an issue or a proposal');
  }
  const entry = raw.entry == null ? null : String(raw.entry);
  if (entry !== null && !ENTRIES.includes(entry)) {
    throw new AgentSessionError(400, `hint.entry must be one of ${ENTRIES.join(', ')}`);
  }
  return { slug, issueNumber, proposalId, entry };
}

async function resolveHint(pool, user, hint) {
  if (!hint || !hint.slug) {
    return { focusAppId: null, focusApp: null, focusContext: hint && hint.entry ? { entry: hint.entry } : {} };
  }
  const app = await appAccess.getAppForUser(pool, hint.slug, user, 'view',
    `${appAccess.ACCESS_COLUMNS}, name, self_hosted, icon_emoji, icon_image_id`);
  if (!app) return { focusAppId: null, focusApp: null, focusContext: hint.entry ? { entry: hint.entry } : {} };
  const context = {};
  if (hint.entry) context.entry = hint.entry;
  if (hint.issueNumber) context.issueNumber = hint.issueNumber;
  if (hint.proposalId) context.proposalId = hint.proposalId;
  return {
    focusAppId: app.id,
    focusApp: {
      id: app.id,
      slug: app.slug || null,
      name: app.name || null,
      selfHosted: !!app.self_hosted,
      iconUrl: app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
      iconEmoji: app.icon_emoji || null,
    },
    focusContext: context,
  };
}

// An UNSENT conversation (New change before the first message) is not a row:
// nothing is created until the viewer sends something, so opening and leaving
// New change leaves nothing behind in Messages. The screen still has to say
// what it is about, so the hint is resolved exactly as creating would resolve
// it, with the same access rule, and nothing is written.
async function previewDraft(pool, { user, hint = null }) {
  const parsed = parseHint(hint);
  const { focusApp, focusContext } = await resolveHint(pool, user, parsed);
  return { focusApp, focusContext };
}

// ── Shaping ────────────────────────────────────────────────────────────

// A run that has started and not settled. A 'planned' run has not started
// (or never will: see the proposal's "not started" reason).
const CAPTURING_STATES = new Set(['provisioning', 'exploring', 'replaying', 'reviewing']);

function shapeChangeRow(row) {
  if (!row || row.change_id == null) return null;
  return {
    id: row.change_id,
    appSlug: row.change_app_slug || null,
    appName: row.change_app_name || null,
    status: row.change_status || null,
    title: row.change_title || null,
    prNumber: row.change_pr_number || null,
    // For the changes drawer: the owner's own preview and checks verdict.
    stagingUrl: row.change_staging_url || null,
    checkState: row.change_check_state || null,
    // The staging card (#2779 follow-up): how many checks failed on the last
    // run, and whether the preview is the platform's own (its preview is
    // signed into as the self-hosted app, with its review fixtures on).
    checkFailing: Number(row.change_check_failing) || 0,
    // #3180: why a skipped run was skipped, which the card and the drawer
    // say in words. Read only for 'skipped': an error's detail is the
    // checks panel's to show.
    checkSkipReason: row.change_check_skip_reason || null,
    appSelfHosted: !!row.change_app_self_hosted,
    // The before/after shots being taken now, which the conversation
    // shows with a Stop. Null once it settles, and on the changes-list rows,
    // which do not read it.
    previewCapture: CAPTURING_STATES.has(row.change_shots_state)
      ? {
        state: row.change_shots_state,
        startedAt: row.change_shots_started_at ? new Date(row.change_shots_started_at).toISOString() : null,
      }
      : null,
  };
}

function shapeSession(row) {
  return {
    id: row.id,
    title: row.title || null,
    titleSource: row.title_source,
    status: row.status,
    focusApp: row.focus_app_id
      ? {
        id: row.focus_app_id,
        slug: row.focus_app_slug || null,
        name: row.focus_app_name || null,
        // "Open app" hides itself for the platform's own row, whose app
        // surface is the platform the viewer is already in.
        selfHosted: !!row.focus_app_self_hosted,
        iconUrl: row.focus_app_icon_id ? `/app-icons/${row.focus_app_icon_id}` : null,
        iconEmoji: row.focus_app_icon_emoji || null,
      }
      : null,
    focusContext: row.focus_context || {},
    // The composer's model choice; null follows the user's default.
    agent: row.agent_backend
      ? {
        backend: row.agent_backend,
        model: row.agent_model || null,
        reasoningEffort: row.agent_reasoning_effort || null,
      }
      : null,
    activeChange: shapeChangeRow(row),
    // A lease its turn stopped renewing is not work in progress: the
    // process holding it died, and the next message takes it over.
    busy: !!row.turn_live,
    // Finished something the owner has not seen yet: the green dot.
    doneUnseen: !row.turn_live && !!row.last_done_at
      && (!row.seen_at || new Date(row.last_done_at) > new Date(row.seen_at)),
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    // Bumped by the database on every write a screen draws (schema.sql,
    // "Keeping every screen of a conversation in step"). A screen holding an
    // older one re-reads GET .../state.
    version: Number(row.state_version) || 0,
  };
}

// ── Sessions ───────────────────────────────────────────────────────────

// `agent` is an already-validated choice ({ backend, model, reasoningEffort },
// see routes/agent-sessions.js) or null to follow the user's default.
async function createAgentSession(pool, { user, hint = null, agent = null }) {
  const parsed = parseHint(hint);
  const { focusAppId, focusContext } = await resolveHint(pool, user, parsed);
  const { rows } = await pool.query(
    `INSERT INTO agent_sessions
       (user_id, focus_app_id, focus_context, agent_backend, agent_model, agent_reasoning_effort)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING id`,
    [user.id, focusAppId, JSON.stringify(focusContext),
      agent ? agent.backend : null, agent ? agent.model || null : null,
      agent ? agent.reasoningEffort || null : null]
  );
  log.info('agent-sessions', 'Agent session created', {
    userId: user.id, agentSessionId: rows[0].id, focusAppId,
  });
  return getAgentSession(pool, { userId: user.id, id: rows[0].id });
}

async function listAgentSessions(pool, { userId, status = 'open', limit = 20, before = null }) {
  if (!['open', 'archived'].includes(status)) throw new AgentSessionError(400, 'status must be open or archived');
  const bounded = Math.max(1, Math.min(LIST_LIMIT_MAX, Number(limit) || 20));
  const cursor = before == null ? null : new Date(before);
  if (cursor && Number.isNaN(cursor.valueOf())) throw new AgentSessionError(400, 'before must be a timestamp');
  const { rows } = await pool.query(
    // The same projection as getAgentSession below, so the list and the
    // detail cannot disagree about what a session looks like.
    `SELECT s.id, s.user_id, s.title, s.title_source, s.status, s.focus_app_id,
            s.focus_context, s.active_change_id, s.active_turn,
            s.agent_backend, s.agent_model, s.agent_reasoning_effort,
            s.last_activity_at, s.created_at, s.archived_at, s.last_done_at, s.seen_at, s.state_version,
            (s.active_turn IS NOT NULL
             AND COALESCE(s.active_turn->>'renewedAt', s.active_turn->>'startedAt')::timestamptz
                 >= NOW() - make_interval(secs => $5)) AS turn_live,
            fa.slug AS focus_app_slug, fa.name AS focus_app_name,
            fa.self_hosted AS focus_app_self_hosted, fa.icon_emoji AS focus_app_icon_emoji,
            fa.icon_image_id AS focus_app_icon_id,
            c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            CASE WHEN c.check_state = 'skipped' THEN c.check_error_detail END AS change_check_skip_reason,
            c.shots_state AS change_shots_state,
            (SELECT r.started_at FROM shot_runs r WHERE r.id = c.shots_run_id) AS change_shots_started_at,
            ca.slug AS change_app_slug, ca.name AS change_app_name, ca.self_hosted AS change_app_self_hosted,
            (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.test_results) = 'array' THEN c.test_results ELSE '[]'::jsonb END) t WHERE t->>'status' = 'fail') AS change_check_failing
       FROM agent_sessions s
       LEFT JOIN apps fa ON fa.id = s.focus_app_id
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
       LEFT JOIN apps ca ON ca.id = c.app_id
      WHERE s.user_id = $1 AND s.status = $2
        AND ($3::timestamptz IS NULL OR s.last_activity_at < $3::timestamptz)
      ORDER BY s.last_activity_at DESC, s.id DESC
      LIMIT $4`,
    [userId, status, cursor, bounded + 1, TURN_LEASE_STALE_SECONDS]
  );
  const page = rows.slice(0, bounded).map(shapeSession);
  return {
    sessions: page,
    nextBefore: rows.length > bounded ? page[page.length - 1].lastActivityAt : null,
  };
}

async function getAgentSession(pool, { userId, id }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.title, s.title_source, s.status, s.focus_app_id,
            s.focus_context, s.active_change_id, s.active_turn,
            s.agent_backend, s.agent_model, s.agent_reasoning_effort,
            s.last_activity_at, s.created_at, s.archived_at, s.last_done_at, s.seen_at, s.state_version,
            (s.active_turn IS NOT NULL
             AND COALESCE(s.active_turn->>'renewedAt', s.active_turn->>'startedAt')::timestamptz
                 >= NOW() - make_interval(secs => $3)) AS turn_live,
            fa.slug AS focus_app_slug, fa.name AS focus_app_name,
            fa.self_hosted AS focus_app_self_hosted, fa.icon_emoji AS focus_app_icon_emoji,
            fa.icon_image_id AS focus_app_icon_id,
            c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            CASE WHEN c.check_state = 'skipped' THEN c.check_error_detail END AS change_check_skip_reason,
            c.shots_state AS change_shots_state,
            (SELECT r.started_at FROM shot_runs r WHERE r.id = c.shots_run_id) AS change_shots_started_at,
            ca.slug AS change_app_slug, ca.name AS change_app_name, ca.self_hosted AS change_app_self_hosted,
            (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.test_results) = 'array' THEN c.test_results ELSE '[]'::jsonb END) t WHERE t->>'status' = 'fail') AS change_check_failing
       FROM agent_sessions s
       LEFT JOIN apps fa ON fa.id = s.focus_app_id
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
       LEFT JOIN apps ca ON ca.id = c.app_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId, TURN_LEASE_STALE_SECONDS]
  );
  if (!rows.length) return null;
  const session = shapeSession(rows[0]);
  // Every change this conversation has started, newest first: the active one,
  // the parked ones the user can switch back to, and the closed ones.
  const { rows: changes } = await pool.query(
    `SELECT c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            CASE WHEN c.check_state = 'skipped' THEN c.check_error_detail END AS change_check_skip_reason,
            a.slug AS change_app_slug, a.name AS change_app_name, a.self_hosted AS change_app_self_hosted,
            (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.test_results) = 'array' THEN c.test_results ELSE '[]'::jsonb END) t WHERE t->>'status' = 'fail') AS change_check_failing
       FROM chat_sessions c JOIN apps a ON a.id = c.app_id
      WHERE c.agent_session_id = $1 AND c.user_id = $2
      ORDER BY c.id DESC
      LIMIT 50`,
    [sessionId, userId]
  );
  session.changes = changes.map(shapeChangeRow);
  return session;
}

// The composer's model choice (#2779). The Mayor reads it at the start of its
// next turn and a dispatch at the start of its next build, so a turn or build
// already running finishes on the model it started with.
async function setAgentChoice(pool, { userId, id, agent }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET agent_backend = $3, agent_model = $4, agent_reasoning_effort = $5
      WHERE id = $1 AND user_id = $2 AND status = 'open'
      RETURNING id`,
    [sessionId, userId, agent.backend, agent.model || null, agent.reasoningEffort || null]
  );
  if (!rows.length) return null;
  return getAgentSession(pool, { userId, id: sessionId });
}

// The choice alone, for the Mayor, a dispatch and a change being started.
// Null when the conversation follows the user's default.
async function getAgentChoice(pool, agentSessionId) {
  const sessionId = positiveInt(Number(agentSessionId));
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT agent_backend, agent_model, agent_reasoning_effort
       FROM agent_sessions WHERE id = $1`,
    [sessionId]
  );
  const row = rows[0];
  if (!row || !row.agent_backend) return null;
  return {
    backend: row.agent_backend,
    model: row.agent_model || null,
    reasoningEffort: row.agent_reasoning_effort || null,
  };
}

async function renameAgentSession(pool, { userId, id, title }) {
  const clean = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!clean) throw new AgentSessionError(400, 'Title required');
  if (clean.length > TITLE_MAX) throw new AgentSessionError(400, `Title too long (max ${TITLE_MAX} chars)`);
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET title = $1, title_source = 'manual'
      WHERE id = $2 AND user_id = $3
      RETURNING id`,
    [clean, positiveInt(Number(id)), userId]
  );
  return rows.length ? getAgentSession(pool, { userId, id }) : null;
}

// Archiving parks the active change and hides the session. It never
// withdraws a proposal: a change up for a vote keeps its vote, and every
// change stays reachable from its own page.
async function archiveAgentSession(pool, { userId, id }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET status = 'archived', archived_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'open'
      RETURNING active_change_id`,
    [positiveInt(Number(id)), userId]
  );
  if (!rows.length) return null;
  if (rows[0].active_change_id) {
    await parkChange(pool, { userId, changeId: rows[0].active_change_id, reason: 'agent-session-archived' });
  }
  return getAgentSession(pool, { userId, id });
}

async function unarchiveAgentSession(pool, { userId, id }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET status = 'open', archived_at = NULL, last_activity_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'archived'
      RETURNING id`,
    [positiveInt(Number(id)), userId]
  );
  return rows.length ? getAgentSession(pool, { userId, id }) : null;
}

// The conversation: every row the session and its changes wrote, oldest
// first, paged by id. The owner check is the join, so another user's id
// reads as an empty session rather than as a probe.
async function listMessages(pool, { userId, id, afterId = 0, limit = 100 }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows: owner } = await pool.query(
    'SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  if (!owner.length) return null;
  const bounded = Math.max(1, Math.min(MESSAGES_LIMIT_MAX, Number(limit) || 100));
  const after = Number.isSafeInteger(Number(afterId)) && Number(afterId) > 0 ? Number(afterId) : 0;
  const { rows } = await pool.query(
    `SELECT id, session_id, role, content, model, cost_cents, metadata, created_at, client_message_id, rev
       FROM chat_session_messages
      WHERE agent_session_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [sessionId, after, bounded + 1]
  );
  const page = rows.slice(0, bounded);
  return {
    messages: page.map(shapeMessage),
    nextAfter: rows.length > bounded ? page[page.length - 1].id : null,
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    changeId: row.session_id || null,
    role: row.role,
    content: row.content,
    model: row.model || null,
    costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    metadata: row.metadata || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    // The id the sending screen gave the message, so its "Sending" copy is
    // replaced by this row in place.
    clientMessageId: row.client_message_id || null,
    // When the row was written or last edited, in the order the database
    // did it: a screen asks for rows past the newest rev it holds.
    rev: row.rev == null ? 0 : Number(row.rev),
  };
}

// ── One consistent read of a conversation (GET .../state) ──────────────
//
// What a screen draws, read together: the session with its changes, whether
// a turn is running, the messages, the cards, and the version and rev they
// were read at, so none of them can be from before another. `version` is the
// screen's own; when it is still current the answer is only that, and
// `busy`, which can change with no write (a dead process's lease going
// stale). `rev` asks for the rows written or edited since.
const STATE_ROWS_MAX = 500;

function leaseTurn(activeTurn) {
  const turn = activeTurn || {};
  const startedAt = Date.parse(turn.startedAt || '');
  const phaseStartedAt = Number(turn.phaseStartedAt);
  const phase = ['mayor', 'cc', 'mayor2'].includes(turn.phase) ? turn.phase : 'mayor';
  return {
    id: typeof turn.id === 'string' ? turn.id : null,
    phase,
    stopping: !!turn.stopRequestedAt,
    stopRequestedAt: Date.parse(turn.stopRequestedAt || '') || null,
    // What the screen's clock counts from: the build once one was
    // dispatched, else the turn (agent-turn.js turnState's rule).
    startedAt: phase !== 'mayor' && Number.isFinite(phaseStartedAt) && phaseStartedAt > 0
      ? phaseStartedAt
      : (Number.isFinite(startedAt) ? startedAt : null),
  };
}

async function readState(pool, { userId, id, version = null, rev = null }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows: head } = await pool.query(
    `SELECT state_version, active_turn, active_change_id,
            (active_turn IS NOT NULL
             AND COALESCE(active_turn->>'renewedAt', active_turn->>'startedAt')::timestamptz
                 >= NOW() - make_interval(secs => $3)) AS turn_live
       FROM agent_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId, TURN_LEASE_STALE_SECONDS]
  );
  if (!head.length) return null;
  const current = Number(head[0].state_version) || 0;
  // The running turn as its lease records it, for a screen on any pod.
  const lease = head[0].turn_live && head[0].active_turn ? leaseTurn(head[0].active_turn) : null;
  // A lease nobody renews any more: its process died mid-turn, and nothing
  // has said so yet (the route ends it before answering).
  const stale = !!head[0].active_turn && !head[0].turn_live;
  const activeChangeId = head[0].active_change_id == null ? null : Number(head[0].active_change_id);
  if (version != null && Number(version) === current) {
    return { unchanged: true, version: current, busy: !!head[0].turn_live, lease, stale, activeChangeId };
  }
  const since = rev == null || !Number.isSafeInteger(Number(rev)) || Number(rev) < 0 ? null : Number(rev);
  const read = async (db) => {
    const session = await getAgentSession(db, { userId, id: sessionId });
    if (!session) return null;
    const { rows: top } = await db.query(
      'SELECT COALESCE(MAX(rev), 0) AS rev FROM chat_session_messages WHERE agent_session_id = $1',
      [sessionId]
    );
    let messages;
    let nextAfter = null;
    let full = true;
    if (since != null) {
      const { rows } = await db.query(
        `SELECT id, session_id, role, content, model, cost_cents, metadata, created_at, client_message_id, rev
           FROM chat_session_messages
          WHERE agent_session_id = $1 AND rev > $2
          ORDER BY id ASC
          LIMIT $3`,
        [sessionId, since, STATE_ROWS_MAX + 1]
      );
      // More changed than one answer carries: the screen reads it whole.
      if (rows.length <= STATE_ROWS_MAX) {
        messages = rows.map(shapeMessage);
        full = false;
      }
    }
    if (!messages) {
      const page = await listMessages(db, { userId, id: sessionId, afterId: 0, limit: MESSAGES_LIMIT_MAX });
      // Gone between the two reads (deleted with its account): not found.
      if (!page) return null;
      messages = page.messages;
      nextAfter = page.nextAfter;
    }
    const actions = await require('./agent-session-actions').listActions(db, { userId, agentSessionId: sessionId });
    return {
      unchanged: false,
      version: session.version,
      lease,
      stale,
      activeChangeId,
      session,
      messages,
      // true: `messages` is the transcript from its first row (with
      // `nextAfter` to page the rest from GET .../messages); false: only the
      // rows written or edited since `rev`, to merge by id.
      full,
      nextAfter,
      rev: Number(top[0].rev) || 0,
      actions,
    };
  };
  // One snapshot for all of it. A test pool without connect() reads each
  // statement as it comes, which is all a fake needs.
  if (typeof pool.connect !== 'function') return read(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await read(client);
    await client.query('COMMIT');
    return state;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A row that belongs to the conversation itself rather than to any one
// change: a change starting, a change closing. `session_id` is NULL on
// purpose, so a change's own transcript slice stays exactly what it wrote.
async function appendConversationEvent(pool, { agentSessionId, content, event, metadata = {} }) {
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
     VALUES (NULL, $1, 'system', $2, $3::jsonb)`,
    [agentSessionId, content, JSON.stringify({ ...metadata, agentSessionEvent: event })]
  );
  await pool.query('UPDATE agent_sessions SET last_activity_at = NOW() WHERE id = $1', [agentSessionId]);
}

// ── Changes ────────────────────────────────────────────────────────────

// Park a change: today's pause, which releases its worker and keeps its
// branch, preview and pull request. A promoted change keeps its vote and its
// status; pauseSession only ever demotes an `active` one.
async function parkChange(pool, { userId, changeId, reason }) {
  const sessionLifecycle = require('./session-lifecycle');
  try {
    return await sessionLifecycle.pauseSession({ pool, sessionId: changeId, userId, reason });
  } catch (err) {
    log.warn('agent-sessions', 'Could not park change', { changeId, reason, err: err.message });
    return { paused: false };
  }
}

// Before a new change starts in a session, the one it was working on is
// parked, so the one-active-change rule (D4) holds and the parked change's
// worker slot is free for the new one. Returns the session row the new
// change will link to, or throws if the session is not the caller's or is
// archived — which the delegation's own liveness check makes unreachable in
// practice, and which is checked again here because this is the write.
async function prepareChangeStart(pool, { agentSessionId, userId }) {
  const { rows } = await pool.query(
    `SELECT id, active_change_id FROM agent_sessions
      WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [agentSessionId, userId]
  );
  if (!rows.length) throw new AgentSessionError(404, 'Agent session not found');
  if (rows[0].active_change_id) {
    await parkChange(pool, { userId, changeId: rows[0].active_change_id, reason: 'agent-session-switch' });
  }
  return rows[0];
}

// Make a freshly created change this session's active change. Rows the
// change wrote before it was linked (none, in the normal path) are stamped
// too, so nothing it said is missing from the conversation.
async function linkChange(pool, { agentSessionId, userId, change }) {
  const { rows } = await pool.query(
    `UPDATE chat_sessions SET agent_session_id = $1
      WHERE id = $2 AND user_id = $3 AND agent_session_id IS NULL
      RETURNING id, app_id`,
    [agentSessionId, change.id, userId]
  );
  if (!rows.length) return false;
  await pool.query(
    `UPDATE chat_session_messages SET agent_session_id = $1
      WHERE session_id = $2 AND agent_session_id IS NULL`,
    [agentSessionId, change.id]
  );
  await pool.query(
    `UPDATE agent_sessions
        SET active_change_id = $1, focus_app_id = $2, last_activity_at = NOW()
      WHERE id = $3 AND user_id = $4`,
    [change.id, rows[0].app_id, agentSessionId, userId]
  );
  const title = change.session_title || change.title || null;
  const where = change.app_name || change.app_slug || 'the app';
  await appendConversationEvent(pool, {
    agentSessionId,
    content: title ? `Started a change on ${where}: ${title}` : `Started a change on ${where}`,
    event: 'change_started',
    // The name the change started with. The change's own session_title
    // follows its PR title from then on (#249); this is what pr-metadata
    // reads as the change's request when it writes the proposal's title and
    // description (gatherSessionContext).
    metadata: { changeId: change.id, ...(title ? { title } : {}) },
  });
  return true;
}

// The sentence the conversation gets when one of its changes closes.
function closedSentence({ prNumber, outcome }) {
  const ref = prNumber ? `PR #${prNumber}` : 'The change';
  switch (outcome) {
    case 'merged': return `${ref} merged. It is part of the app now.`;
    case 'rejected': return `${ref} was set aside by the group's vote.`;
    case 'withdrawn': return `${ref} was withdrawn.`;
    case 'replaced': return `${ref} was replaced by a newer proposal.`;
    default: return `${ref} was closed.`;
  }
}

// How an archive reason reads to the person whose conversation it was.
function outcomeForArchiveReason(reason) {
  if (reason === 'auto-rejected') return 'rejected';
  if (reason === 'proposal-replaced') return 'replaced';
  if (reason === 'manual') return 'withdrawn';
  return 'closed';
}

// Called when a change closes, from the merge path and the archive path.
// Posts a note to the parent conversation and, if the change was the active
// one, clears it so the next dispatch has to name a change. Best-effort and
// never throws: a merge or an archive must not fail over a conversation note.
//
// `change` is the row the caller already holds. A classic session carries
// `agent_session_id: null`, and returns here without a query; a row that did
// not select the column (undefined) is looked up.
async function noteChangeClosed(pool, { change, outcome }) {
  if (!change || change.agent_session_id === null) return false;
  try {
    let agentSessionId = change.agent_session_id;
    let prNumber = change.pr_number || null;
    if (agentSessionId === undefined) {
      const { rows } = await pool.query(
        `SELECT agent_session_id, pr_number FROM chat_sessions
          WHERE id = $1 AND agent_session_id IS NOT NULL`,
        [change.id]
      );
      agentSessionId = rows.length ? rows[0].agent_session_id : null;
      prNumber = prNumber || (rows.length ? rows[0].pr_number : null);
    }
    if (!positiveInt(Number(agentSessionId))) return false;
    await pool.query(
      `UPDATE agent_sessions SET active_change_id = NULL
        WHERE id = $1 AND active_change_id = $2`,
      [agentSessionId, change.id]
    );
    await appendConversationEvent(pool, {
      agentSessionId,
      content: closedSentence({ prNumber, outcome }),
      event: 'change_closed',
      metadata: { changeId: change.id, outcome },
    });
    return true;
  } catch (err) {
    log.warn('agent-sessions', 'Could not note a closed change', {
      changeId: change && change.id, outcome, err: err.message,
    });
    return false;
  }
}

// ── The Mayor's own moves (#2779 step 3b) ──────────────────────────────

// Make one of this conversation's earlier changes the active one again. The
// change must be the user's, started from this session, and still open; the
// change it replaces is parked. Resuming a parked change's worker happens on
// the next dispatch, not here.
async function switchActiveChange(pool, { agentSessionId, userId, changeId }) {
  const id = positiveInt(Number(changeId));
  if (!id) throw new AgentSessionError(400, 'changeId must be a positive integer');
  const { rows: change } = await pool.query(
    `SELECT c.id, c.status, c.app_id, c.pr_number, COALESCE(c.pr_title, c.session_title) AS title
       FROM chat_sessions c
      WHERE c.id = $1 AND c.user_id = $2 AND c.agent_session_id = $3`,
    [id, userId, agentSessionId]
  );
  if (!change.length) throw new AgentSessionError(404, 'That change was not started from this conversation.');
  if (['archived', 'merged'].includes(change[0].status)) {
    throw new AgentSessionError(409, `That change is ${change[0].status}, so it cannot be made active.`);
  }
  const { rows: session } = await pool.query(
    `SELECT active_change_id FROM agent_sessions
      WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [agentSessionId, userId]
  );
  if (!session.length) throw new AgentSessionError(404, 'Agent session not found');
  const previous = session[0].active_change_id;
  if (previous === id) return { changed: false, change: change[0] };
  if (previous) await parkChange(pool, { userId, changeId: previous, reason: 'agent-session-switch' });
  await pool.query(
    `UPDATE agent_sessions SET active_change_id = $1, focus_app_id = $2, last_activity_at = NOW()
      WHERE id = $3 AND user_id = $4`,
    [id, change[0].app_id, agentSessionId, userId]
  );
  const ref = change[0].pr_number ? `PR #${change[0].pr_number} (change ${id})` : `change ${id}`;
  await appendConversationEvent(pool, {
    agentSessionId,
    content: `Switched to ${ref}.`,
    event: 'change_switched',
    metadata: { changeId: id, previousChangeId: previous || null },
  });
  return { changed: true, change: change[0] };
}

// Record which app the user means. Resolved with the user's own access, so
// the focus can never name an app they cannot see.
async function setFocusApp(pool, { agentSessionId, user, slug }) {
  const clean = typeof slug === 'string' ? slug : '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean)) throw new AgentSessionError(400, 'slug must be an app slug');
  const app = await appAccess.getAppForUser(pool, clean, user, 'view', appAccess.ACCESS_COLUMNS);
  if (!app) throw new AgentSessionError(404, 'That app does not exist, or the user cannot see it.');
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET focus_app_id = $1
      WHERE id = $2 AND user_id = $3 AND status = 'open'
      RETURNING id`,
    [app.id, agentSessionId, user.id]
  );
  if (!rows.length) throw new AgentSessionError(404, 'Agent session not found');
  return { id: app.id, slug: app.slug };
}

// ── The turn lease ─────────────────────────────────────────────────────
//
// One Mayor turn at a time per conversation. The lease is a row write, not a
// process-local lock, so two tabs (or two pods) cannot both start a turn. A
// running turn renews it every 15 seconds (a dispatch can run far longer than
// the stale window), so a lease not renewed for TURN_LEASE_STALE_SECONDS
// belongs to a turn whose process died without releasing it: it is not busy,
// it is taken over, and the sweeper (services/mayor/agent-turn.js,
// sweepInterruptedTurns) tells the conversation the turn was interrupted.
// Every deploy replaces the platform's one pod and kills the turns in it, so
// this window is how long a conversation can look busy with nobody working.
// schema.sql's agent_session_state_announce reads the same 90 seconds.
const TURN_LEASE_STALE_SECONDS = 90;

async function acquireTurnLease(pool, { agentSessionId, userId, turnId }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET active_turn = jsonb_build_object('id', $3::text, 'startedAt', NOW(), 'phase', 'mayor'),
            last_activity_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions c WHERE c.id = agent_sessions.active_change_id
            AND c.user_id = $2 AND c.active_turn IS NOT NULL
            AND COALESCE(c.active_turn->>'mode', 'build') <> 'shots'
        )
        AND (active_turn IS NULL
             OR COALESCE(active_turn->>'renewedAt', active_turn->>'startedAt')::timestamptz
                < NOW() - make_interval(secs => $4))
      RETURNING id`,
    [agentSessionId, userId, turnId, TURN_LEASE_STALE_SECONDS]
  );
  return rows.length > 0;
}

// The message and the turn that answers it, in one transaction: the lease
// is taken and the user's row written together, before the stream opens, so
// a message the server answered "accepted" to is in the conversation however
// the connection ends, and a refusal (busy) writes nothing. `clientMessageId`
// makes a retried send safe: a message already written answers
// `{ duplicate }` and starts no second turn.
//
// Resolves to `{ ok: true, messageId }`, `{ duplicate: true, messageId,
// turnId }` or `{ busy: true }`.
async function startTurnWithMessage(pool, {
  agentSessionId, userId, turnId, changeId = null, text, attachments = [], clientMessageId = null, title = null,
}) {
  const findSent = async (db) => {
    if (!clientMessageId) return null;
    const { rows } = await db.query(
      `SELECT id, metadata->>'agentTurnId' AS turn_id FROM chat_session_messages
        WHERE agent_session_id = $1 AND client_message_id = $2`,
      [agentSessionId, clientMessageId]
    );
    return rows[0] ? { duplicate: true, messageId: rows[0].id, turnId: rows[0].turn_id || null } : null;
  };
  const write = async (db) => {
    const sent = await findSent(db);
    if (sent) return sent;
    if (!await acquireTurnLease(db, { agentSessionId, userId, turnId })) return { busy: true };
    const { rows } = await db.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, client_message_id)
       VALUES ($1, $2, 'user', $3, $4::jsonb, $5)
       RETURNING id`,
      [changeId, agentSessionId, text,
        JSON.stringify({ agentTurnId: turnId, ...(attachments.length ? { attachments } : {}) }),
        clientMessageId]
    );
    const messageId = rows[0].id;
    // The files belong to this message now: out of the orphan sweep's
    // reach, and what the Mayor's history reads back.
    if (attachments.length) {
      await db.query(
        `UPDATE chat_session_attachments SET message_id = $1
          WHERE id = ANY($2) AND agent_session_id = $3 AND message_id IS NULL`,
        [messageId, attachments.map((att) => att.id), agentSessionId]
      );
    }
    if (title) {
      await db.query(
        `UPDATE agent_sessions SET title = $1
          WHERE id = $2 AND title IS NULL AND title_source = 'auto'`,
        [title, agentSessionId]
      );
    }
    return { ok: true, messageId };
  };
  if (typeof pool.connect !== 'function') return write(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await write(client);
    if (outcome.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two sends of the same message at once: the second one's insert meets
    // the first one's row.
    if (err && err.code === '23505' && clientMessageId) {
      const sent = await findSent(pool);
      if (sent) return sent;
    }
    throw err;
  } finally {
    client.release();
  }
}

// Only the turn holding the lease renews it.
async function renewTurnLease(pool, { agentSessionId, turnId }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW())
      WHERE id = $1 AND active_turn->>'id' = $2
      RETURNING id`,
    [agentSessionId, turnId]
  );
  return rows.length > 0;
}

async function markTurnStopRequested(pool, { agentSessionId, userId, turnId, by }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object(
       'stopRequestedAt', COALESCE(active_turn->>'stopRequestedAt', NOW()::text),
       'stopRequestedBy', COALESCE(active_turn->>'stopRequestedBy', $4::text))
     WHERE id = $1 AND user_id = $2 AND active_turn->>'id' = $3
       AND COALESCE(active_turn->>'phase', 'mayor') <> 'mayor2'
     RETURNING active_turn`,
    [agentSessionId, userId, turnId, by || null],
  );
  return rows[0]?.active_turn || null;
}

async function readTurnStopRequest(pool, { agentSessionId, turnId }) {
  const { rows } = await pool.query(
    `SELECT active_turn FROM agent_sessions WHERE id = $1 AND active_turn->>'id' = $2`,
    [agentSessionId, turnId],
  );
  return rows[0]?.active_turn?.stopRequestedAt ? rows[0].active_turn : null;
}

// Where the turn is (the Mayor, the coding agent, the wrap-up), on the lease
// every screen reads, so one on another pod, or opened mid-turn, shows it.
async function setTurnPhase(pool, { agentSessionId, turnId, phase, startedAt = null }) {
  await pool.query(
    `UPDATE agent_sessions
        SET active_turn = active_turn || jsonb_strip_nulls(jsonb_build_object(
              'phase', $3::text, 'phaseStartedAt', $4::bigint))
      WHERE id = $1 AND active_turn->>'id' = $2`,
    [agentSessionId, turnId, phase, startedAt]
  );
}

// `finished` is a turn that ran, ending: it stamps last_done_at, which the
// lists read as "finished something". A lease handed back before the turn
// started (no Mayor, no payer) is not one.
async function releaseTurnLease(pool, { agentSessionId, turnId, finished = false }) {
  await pool.query(
    `UPDATE agent_sessions
        SET active_turn = NULL,
            last_done_at = CASE WHEN $3::boolean THEN NOW() ELSE last_done_at END
      WHERE id = $1 AND active_turn->>'id' = $2`,
    [agentSessionId, turnId, !!finished]
  );
}

// Hand back a lease whose turn died, whoever held it. Only a stale one: a
// live lease may belong to a turn on the other pod during a rollout. True
// when there was one to clear.
async function releaseStaleTurnLease(pool, { agentSessionId, userId, finished = false }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET active_turn = NULL,
            last_done_at = CASE WHEN $4::boolean THEN NOW() ELSE last_done_at END
      WHERE id = $1 AND user_id = $2 AND active_turn IS NOT NULL
        AND COALESCE(active_turn->>'renewedAt', active_turn->>'startedAt')::timestamptz
            < NOW() - make_interval(secs => $3)
      RETURNING id`,
    [agentSessionId, userId, TURN_LEASE_STALE_SECONDS, !!finished]
  );
  return rows.length > 0;
}

// The leases whose turn stopped renewing them: the process died (a deploy,
// a crash). `changeTurn` says whether the active change still has a run of
// its own on record: a build the dead turn dispatched, which restart recovery
// adopts and hands back itself (agent-turn.js handBackAfterRecovery).
async function staleTurnLeases(pool, { limit = 50, agentSessionId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.active_turn->>'id' AS turn_id, s.active_change_id,
            (c.active_turn IS NOT NULL) AS change_turn
       FROM agent_sessions s
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
      WHERE s.active_turn IS NOT NULL
        AND COALESCE(s.active_turn->>'renewedAt', s.active_turn->>'startedAt')::timestamptz
            < NOW() - make_interval(secs => $1)
        AND ($3::bigint IS NULL OR s.id = $3::bigint)
      ORDER BY s.id
      LIMIT $2`,
    [TURN_LEASE_STALE_SECONDS, limit, agentSessionId == null ? null : Number(agentSessionId)]
  );
  return rows.map((row) => ({
    agentSessionId: Number(row.id),
    userId: Number(row.user_id),
    turnId: row.turn_id,
    activeChangeId: row.active_change_id == null ? null : Number(row.active_change_id),
    changeTurn: !!row.change_turn,
  }));
}

// A turn that ended without finishing (its process died, or is shutting
// down): the lease is handed back and the conversation says so, together,
// so a screen never sees one without the other. `stale` only takes a lease
// nobody has renewed within the window; a shutting-down process ends its own
// live one. The note carries `retryable`, which the screen offers as Retry.
// True when this call ended it (a second caller finds it already ended).
async function endInterruptedTurn(pool, { agentSessionId, turnId, content, stale = true }) {
  const run = async (db) => {
    const { rows } = await db.query(
      `UPDATE agent_sessions
          SET active_turn = NULL
        WHERE id = $1 AND active_turn->>'id' = $2
          AND (NOT $3::boolean
               OR COALESCE(active_turn->>'renewedAt', active_turn->>'startedAt')::timestamptz
                  < NOW() - make_interval(secs => $4))
        RETURNING id`,
      [agentSessionId, turnId, !!stale, TURN_LEASE_STALE_SECONDS]
    );
    if (!rows.length) return false;
    await db.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
       VALUES (NULL, $1, 'system', $2, $3::jsonb)`,
      [agentSessionId, content, JSON.stringify({ agentSessionEvent: 'turn_interrupted', agentTurnId: turnId, retryable: true })]
    );
    return true;
  };
  if (typeof pool.connect !== 'function') return run(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ended = await run(client);
    if (ended) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return ended;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The open conversations a change is the active change of: the ones whose
// Mayor dispatched its current run.
async function conversationsOfChange(pool, changeId) {
  const { rows } = await pool.query(
    `SELECT id, user_id FROM agent_sessions
      WHERE active_change_id = $1 AND status = 'open'`,
    [changeId]
  );
  return rows.map((r) => ({ agentSessionId: Number(r.id), userId: Number(r.user_id) }));
}

// The owner read the conversation: whatever it finished is seen. True when
// that cleared a green dot, so the caller can tell the owner's other tabs.
// Written only when there is something unseen: an open screen re-reads its
// conversation every few seconds while the Mayor works.
async function markSeen(pool, { userId, id }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return false;
  const { rows } = await pool.query(
    `WITH prev AS (
       SELECT id, seen_at, last_done_at, active_turn
         FROM agent_sessions
        WHERE id = $1 AND user_id = $2
          AND last_done_at IS NOT NULL AND (seen_at IS NULL OR last_done_at > seen_at)
     )
     UPDATE agent_sessions s SET seen_at = NOW()
       FROM prev
      WHERE s.id = prev.id
     RETURNING (prev.active_turn IS NULL
                OR COALESCE(prev.active_turn->>'renewedAt', prev.active_turn->>'startedAt')::timestamptz
                   < NOW() - make_interval(secs => $3)) AS cleared`,
    [sessionId, userId, TURN_LEASE_STALE_SECONDS]
  );
  return !!(rows[0] && rows[0].cleared);
}

module.exports = {
  TITLE_MAX,
  ENTRIES,
  AgentSessionError,
  parseHint,
  resolveHint,
  shapeSession,
  previewDraft,
  createAgentSession,
  setAgentChoice,
  getAgentChoice,
  listAgentSessions,
  getAgentSession,
  renameAgentSession,
  archiveAgentSession,
  unarchiveAgentSession,
  listMessages,
  shapeMessage,
  readState,
  leaseTurn,
  markTurnStopRequested,
  readTurnStopRequest,
  appendConversationEvent,
  parkChange,
  prepareChangeStart,
  linkChange,
  closedSentence,
  outcomeForArchiveReason,
  noteChangeClosed,
  switchActiveChange,
  setFocusApp,
  TURN_LEASE_STALE_SECONDS,
  acquireTurnLease,
  startTurnWithMessage,
  renewTurnLease,
  setTurnPhase,
  releaseTurnLease,
  releaseStaleTurnLease,
  staleTurnLeases,
  endInterruptedTurn,
  conversationsOfChange,
  markSeen,
};
