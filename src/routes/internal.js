'use strict';

const { Router, raw } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { internalAuthPurpose } = require('../middleware/internal-auth');
const log = require('../services/logger');
const worker = require('../services/worker');
const docker = require('../services/docker');
const applicationRuntime = require('../services/application-runtime');
const kubernetes = require('../services/kubernetes');
const statusSvc = require('../services/status');
const debugAccess = require('../services/debug-access');
const github = require('../services/github');
const repoRef = require('../services/repo-ref');
// #945: the issue's Homeroom-side Discussion thread, merged into the
// by-number issue response the worker's usernode-issues CLI prints.
const threadContext = require('../services/thread-context');
const { USERNODE_DOMAIN, USERNODE_APPS_DOMAIN } = require('../services/caddy');
const edgeGate = require('../services/edge-gate');
// #1037: shared draft-card creation (validation, de-dupe, insert, live
// push), also used by the Mayor's in-process draft_issue_report tool
// (src/routes/sessions.js). The ws / session-bus plumbing the draft card
// needs now lives inside that service.
const issueDraft = require('../services/issue-draft');
const platformJwt = require('../services/platform-jwt');
const benchRunner = require('../services/bench/runner');
const shotsControl = require('../services/shots-control');
const shotsState = require('../services/shots-state');
const shotsIdentities = require('../services/shots-identities');
const shotsReadyStates = require('../services/shots-ready-states');

// On-demand-TLS gate for Caddy. Caddy GETs this before issuing a Let's
// Encrypt cert for a hostname it has never seen (see Caddyfile's
// `on_demand_tls { ask ... }`). We approve a host iff it maps to a real
// app row (`<slug>.<domain>`) or a live staging session whose stored
// staging_url is exactly that host (`<slug>--s<id>--<hash>.<domain>`).
// Everything else is refused so random `*.<domain>` probes can't burn
// Let's Encrypt issuance quota for the registered domain.
async function isKnownHost(pool, rawDomain) {
  const domain = String(rawDomain || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!domain) return false;
  // The apex is served by its own (non-on-demand) site, but allow it
  // defensively so a stray on-demand handshake for it never gets stuck.
  if (domain === USERNODE_DOMAIN) return true;

  const suffix = '.' + USERNODE_APPS_DOMAIN;
  if (!domain.endsWith(suffix)) {
    // A custom domain (#4405): Caddy's on-demand site asks before issuing,
    // and only a claim the platform has verified or already serves may cost
    // a certificate. Unknown hosts never reach the database.
    if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.') || domain.endsWith('.' + USERNODE_DOMAIN)) return false;
    const custom = await pool.query(
      "SELECT 1 FROM app_domains WHERE hostname = $1 AND status IN ('verified', 'live') LIMIT 1",
      [domain]
    );
    return custom.rowCount > 0;
  }
  const label = domain.slice(0, -suffix.length);
  // Only single-level subdomains are routable (the wildcard matches one
  // label); reject anything with a further dot.
  if (!label || label.includes('.')) return false;

  // Production app: leftmost label is the app slug. (Staging labels carry
  // a `--s<id>--<hash>` suffix and so never collide with a real slug.)
  const appHit = await pool.query('SELECT 1 FROM apps WHERE slug = $1 LIMIT 1', [label]);
  if (appHit.rowCount) return true;

  // Staging preview: must match a session's current staging_url exactly,
  // so we don't vouch for stale (superseded) preview hostnames.
  const stagingHit = await pool.query(
    'SELECT 1 FROM chat_sessions WHERE staging_url = $1 LIMIT 1',
    ['https://' + domain]
  );
  return stagingHit.rowCount > 0;
}

// Worker → platform internal API surface.
//
// Mounted in server.js BEFORE the global authMiddleware so cookie auth
// doesn't apply. Auth is handled by the internalAuth middleware, which
// verifies a session-scoped JWT minted at warm-container bootstrap (see
// src/services/worker.js's mintWorkerJwt).
//
// Workers carry no Git credentials. Active callbacks expose only their
// declared purpose: request reads, visual declarations, model/debug access
// and platform-issue drafts. Git publication and PR creation belong to
// conductor completion/recovery; their old callback URLs return 410.

// ── App-host gate (Caddy forward_auth, and the Kubernetes gate proxy) ──
//
// Every request to an app or preview host is checked before it reaches the
// app: GET /__caddy/access below. The decision (members-only for private
// apps, the single-use sign-in code that signs a person in at the app's own
// address, identity only on same-origin requests) lives in
// src/services/edge-gate.js, whose header has the whole tree.

// A benchmark trial (services/bench/runner.js) replays a request as it stood
// at a past commit; GitHub and the platform answer as they are now (later
// comments, the request closed by its fix). Its prompt already carries the
// request's thread as it stood, so usernode-issues answers with nothing.
const BENCH_ISSUES_NOTE = 'Issues are not available in a benchmark trial: the request is in your prompt as it stood.';

function internalRoutes(_config) {
  const router = Router();
  const pool = getPool(_config);

  // Run-scoped shots control plane. The shots worker receives a
  // purpose-bound token naming both its session and run; it has no access to
  // push, issues, production diagnostics, or the generic worker API. Its
  // calls are answered from the run's workspace in Postgres, by whichever web
  // process serves them, while the run is current and its agent at work.
  const shotsAuth = internalAuthPurpose([platformJwt.PUR_SHOTS]);
  const shotsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `shots:${req.workerSession?.shotsRunId || 'anon'}`,
  });
  // Applies one of the agent's calls to its run's workspace, in whichever
  // process serves it (services/shots-control.js).
  function withShotsControl(req, fn, opts = {}) {
    const runId = String(req.params.runId || '');
    if (req.workerSession.shotsRunId !== runId) {
      throw new shotsControl.ShotsControlError(
        'shots_scope_mismatch', 'Shots token does not own this run.', 403
      );
    }
    return shotsControl.withControl(pool, { runId, sessionId: req.workerSession.sessionId }, fn,
      { store: require('../services/media-store').getStore(_config), ...opts });
  }
  function shotsError(res, err) {
    const status = Number(err?.status)
      || (err?.code === 'invalid_visible_changes' ? 400 : 500);
    if (status >= 500) log.warn('shots', 'Shots control request failed', { code: err?.code, error: err?.message });
    return res.status(status).json({ ok: false, code: err?.code || 'shots_control_failed', message: err?.message || 'Shots control failed.' });
  }

  router.get('/api/internal/shots/:runId/context', shotsAuth, shotsLimiter, async (req, res) => {
    try { return res.json({ ok: true, context: await withShotsControl(req, (c) => c.getContext(), { readOnly: true }) }); }
    catch (err) { return shotsError(res, err); }
  });

  // The app's tile on Homeroom's home screen, as one side's dapp.json draws
  // it. The shots proxy asks for it when the browser opens the home tile
  // path on that side's address (services/shots-home-tile.js).
  router.get('/api/internal/shots/:runId/home-tile/:side', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const page = await withShotsControl(req, (c) => c.homeTilePage(String(req.params.side || '')), { readOnly: true });
      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      });
      return res.send(page);
    } catch (err) { return shotsError(res, err); }
  });

  // One shot or clip the shots agent saved on the before or after build.
  // The file travels as the raw body (the global JSON parser ignores it) and
  // its change/screen/side/kind as query fields. The parser limit sits above
  // the clip limit so the structured clip_too_large code wins.
  const shotBody = raw({ type: 'application/octet-stream', limit: '21mb' });
  router.post('/api/internal/shots/:runId/shot', shotsAuth, shotsLimiter, shotBody, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c) => c.saveShot({
        change: req.query.change,
        screen: req.query.screen,
        side: req.query.side,
        kind: req.query.kind,
        theme: req.query.theme,
        // What the worker says the still was saved at; read only in a run
        // taken at device density (shots-control.stillDensity).
        density: req.query.density,
        // The agent's answer to whether the still shows anybody's private
        // things (shots-control.publicSafeOf).
        showsPrivate: req.query.showsPrivate,
      }, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  // The close-ups this run wants now (services/shots-closeups.js), each
  // with whether it is saved. Empty unless the run is taken at device density.
  router.get('/api/internal/shots/:runId/closeups', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c, db) => shotsControl.wantedCloseups(db, c), { readOnly: true });
      return res.json({ ok: true, result: { closeups: result } });
    } catch (err) { return shotsError(res, err); }
  });

  // One close-up the shots bridge took, as the raw body, with which one it
  // is as query fields: kept only when it is wanted, the size asked for, and
  // the after screen shot at that place.
  router.post('/api/internal/shots/:runId/closeup', shotsAuth, shotsLimiter, shotBody, async (req, res) => {
    try {
      const result = await withShotsControl(req, async (c, db) => {
        const raw = { change: req.query.change, screen: req.query.screen, part: Number(req.query.part) };
        const asked = await shotsControl.wantedCloseups(db, c);
        const stills = await shotsControl.stillsFor(db, c, { change: String(raw.change || ''), screen: String(raw.screen || '') });
        return c.saveCloseup(raw, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { asked, ...stills });
      });
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  router.post('/api/internal/shots/:runId/skip', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c) => c.skipChange(req.body || {}));
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  // What a change's shots leave out, shown beside them on the proposal.
  router.post('/api/internal/shots/:runId/note', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c) => c.noteChange(req.body || {}));
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  // A problem the shots agent noticed on the after build besides the
  // declared changes, shown on the proposal under "Also noticed".
  router.post('/api/internal/shots/:runId/problem', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c) => c.noteProblem(req.body || {}));
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  // What the shots agent is about to do to both builds to reach a change (an
  // API GET held or failed, a sample file uploaded), shown beside its shots.
  router.post('/api/internal/shots/:runId/condition', shotsAuth, shotsLimiter, async (req, res) => {
    try {
      const result = await withShotsControl(req, (c) => c.noteCondition(req.body || {}));
      return res.json({ ok: true, result });
    } catch (err) { return shotsError(res, err); }
  });

  // Build-agent declaration boundary. Claude build workers carry the legacy
  // worker:session capability; OpenRouter builds carry only a declaration token.
  // Both may record intent for their own session, but neither can execute a
  // replay, read artifacts, or address another proposal.
  const visibleChangesAuth = internalAuthPurpose([
    platformJwt.PUR_VISIBLE_CHANGES,
    // One-release verification-only compatibility for in-flight OpenRouter
    // builds. New code never mints this purpose; Git/PR callbacks stay 410.
    'worker:push',
    platformJwt.PUR_WORKER,
  ]);
  const visibleChangesLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `visible-changes:${req.workerSession?.sessionId || 'anon'}`,
  });
  const declareVisibleChanges = async (req, res) => {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ ok: false, code: 'bad_session_id', message: 'Invalid proposal session id.' });
    }
    if (Number(req.workerSession.sessionId) !== sessionId) {
      return res.status(403).json({ ok: false, code: 'session_mismatch', message: 'The worker token does not own this proposal.' });
    }
    if (!_config.shots?.collect) {
      return res.json({
        ok: true,
        shots: { accepted: false, state: 'disabled', reason: 'Collecting declared visible changes is disabled.' },
      });
    }
    let result;
    try {
      result = await shotsState.recordIntent(pool, sessionId, req.body?.intent);
    } catch (err) {
      return shotsError(res, err);
    }
    // Whose browser the shots agent will use, and what data the copies hold
    // (shots-ready-states.js), said while the building agent can still
    // declare again. Best-effort: a lookup that fails never fails a
    // declaration that was recorded.
    let warnings = [];
    let advice = null;
    try {
      const { rows } = await pool.query(
        'SELECT a.id, a.slug FROM chat_sessions s JOIN apps a ON a.id = s.app_id WHERE s.id = $1',
        [sessionId]
      );
      if (rows[0]) {
        const selfApp = rows[0].slug === _config.selfAppSlug;
        advice = shotsReadyStates.declarationAdvice(result.intent, { selfApp });
        warnings = await shotsIdentities.personaWarnings(pool, rows[0], result.intent, { selfApp });
      }
    } catch (err) {
      log.warn('internal-api', 'Could not check the declared personas', { sessionId, err: err.message });
    }
    if (advice) warnings = [...warnings, ...advice.warnings];
    return res.json({
      ok: true,
      shots: result,
      ...(advice ? { availableStates: advice.availableStates, dataNote: advice.dataNote } : {}),
      ...(warnings.length ? { warnings } : {}),
    });
  };
  router.post('/api/internal/sessions/:sessionId/visible-changes',
    visibleChangesAuth, visibleChangesLimiter, declareVisibleChanges);

  // #4490: a hosted build's diagram of its change (worker/visible-changes-mcp.js
  // declare_diagram), on the same boundary as its visible changes: its own
  // session only, the same validation submit_work applies, and Mermaid only
  // when the session's declared impact is "none".
  router.post('/api/internal/sessions/:sessionId/diagram',
    visibleChangesAuth, visibleChangesLimiter, async (req, res) => {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ ok: false, code: 'bad_session_id', message: 'Invalid proposal session id.' });
      }
      if (Number(req.workerSession.sessionId) !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch', message: 'The worker token does not own this proposal.' });
      }
      try {
        const { rows } = await pool.query(
          "SELECT shots_detail->'intent'->>'impact' AS impact FROM chat_sessions WHERE id = $1",
          [sessionId]
        );
        if (!rows[0]) return res.status(404).json({ ok: false, code: 'not_found', message: 'No such proposal session.' });
        let record;
        try {
          record = require('../services/diagram').parseDiagram(req.body?.diagram, { impact: rows[0].impact || null });
        } catch (err) {
          return res.status(400).json({ ok: false, code: 'invalid_diagram', message: err.message });
        }
        // The row and the pull request's block it owes commit together.
        const stored = await require('../services/proposal-diagram').storeDeclared(pool, sessionId, record);
        if (!stored) return res.status(500).json({ ok: false, code: 'diagram_not_stored', message: 'The diagram could not be stored.' });
        return res.json({ ok: true, diagram: record });
      } catch (err) {
        log.error('internal-api', 'declare_diagram failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'internal_error', message: 'Could not record the diagram.' });
      }
    });

  // Homeroom bot parity, P8: a build's pictures (worker/usernode-image), on
  // the build's own token (WORKER_JWT: build mode only, never a scout's).
  //
  //   POST /api/internal/sessions/:sessionId/pictures  { prompt, aspect?, variant? }
  //        → the image's bytes, made on the bot's picture model and billed
  //          to whoever pays for this build (services/bot-pictures.js)
  //   GET  /api/internal/sessions/:sessionId/request-pictures/:id
  //        → a picture a request links (/issue-images/:id), to save into the app
  const picturesLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `pictures:${req.workerSession?.sessionId || 'anon'}`,
  });
  const ownSession = (req, res) => {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      res.status(400).json({ ok: false, code: 'bad_session_id', message: 'Invalid session id.' });
      return null;
    }
    if (Number(req.workerSession.sessionId) !== sessionId) {
      res.status(403).json({ ok: false, code: 'session_mismatch', message: 'The worker token does not own this session.' });
      return null;
    }
    return sessionId;
  };
  router.post('/api/internal/sessions/:sessionId/pictures', visibleChangesAuth, picturesLimiter, async (req, res) => {
    const sessionId = ownSession(req, res);
    if (!sessionId) return undefined;
    try {
      const body = req.body || {};
      const out = await require('../services/bot-pictures').generateForSession(pool, _config, {
        sessionId,
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        aspect: typeof body.aspect === 'string' && body.aspect ? body.aspect : 'square',
        variant: body.variant === 'light' || body.variant === 'dark' ? body.variant : null,
      });
      if (!out.ok) return res.status(out.status || 400).json({ ok: false, code: 'refused', message: out.error });
      res.set('Content-Type', out.image.contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      if (out.image.width) res.set('X-Picture-Width', String(out.image.width));
      if (out.image.height) res.set('X-Picture-Height', String(out.image.height));
      res.set('X-Pictures-Left', String(out.left));
      return res.send(out.image.data);
    } catch (err) {
      log.error('internal-api', 'A build\'s picture failed', { sessionId, err: err.message });
      return res.status(500).json({ ok: false, code: 'internal_error', message: 'The picture could not be made just now.' });
    }
  });
  router.get('/api/internal/sessions/:sessionId/request-pictures/:id', visibleChangesAuth, picturesLimiter, async (req, res) => {
    const sessionId = ownSession(req, res);
    if (!sessionId) return undefined;
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ ok: false, code: 'not_found', message: 'No such picture.' });
    try {
      // The same picture /issue-images/:id serves anyone with its link.
      const { rows: [row] } = await pool.query('SELECT content_type, data FROM issue_screenshots WHERE id = $1', [id]);
      if (!row || !row.data) return res.status(404).json({ ok: false, code: 'not_found', message: 'No such picture.' });
      res.set('Content-Type', row.content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.send(row.data);
    } catch (err) {
      log.error('internal-api', 'A request\'s picture read failed', { sessionId, err: err.message });
      return res.status(500).json({ ok: false, code: 'internal_error', message: 'The picture could not be read just now.' });
    }
  });

  // The app-host gate (services/edge-gate.js): Caddy's forward_auth and the
  // Kubernetes gate proxy (scripts/app-gate.js) both ask here.
  router.get('/__caddy/access', async (req, res) => {
    try {
      return await edgeGate.handleAccess(pool, req, res);
    } catch (err) {
      // Fail closed: an error must never open a private app.
      log.error('internal-api', 'App-host gate check failed', {
        host: req.headers['x-forwarded-host'] || req.headers.host, err: err.message,
      });
      if (!res.headersSent) return res.status(503).send('unavailable');
      return undefined;
    }
  });

  // Caddy on-demand-TLS permission check. Public (called by Caddy from
  // inside the Docker network, before any cert exists), GET, no side
  // effects. 200 authorizes issuance; 404 refuses. Keep it cheap — Caddy
  // caches the decision per host, and the lookups are single-row indexed
  // probes.
  router.get('/__caddy/ask', async (req, res) => {
    const domain = req.query.domain;
    try {
      const ok = await isKnownHost(pool, domain);
      if (ok) return res.status(200).send('ok');
      log.warn('internal-api', 'Caddy ask refused unknown host', { domain });
      return res.status(404).send('unknown host');
    } catch (err) {
      // Fail closed: a DB blip must not let arbitrary hosts mint certs.
      log.error('internal-api', 'Caddy ask check failed', { domain, err: err.message });
      return res.status(503).send('unavailable');
    }
  });

  const sessionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Worker API rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // Old worker images still call this endpoint. A permanent response makes
  // them return their result immediately; the conductor publishes it. This
  // tombstone never authenticates a write capability or accesses a worker.
  router.post('/api/internal/sessions/:sessionId/push', (_req, res) => {
    res.status(410).json({ ok: false, code: 'push_retired', permanent: true,
      message: 'The conductor publishes completed turns.' });
  });

  // Homeroom bot parity (P5): the notes a person sent into one of the bot's
  // builds while it runs (services/homeroom-bot-steer.js), handed to the
  // build's Stop hook (worker/build-stop-hook.js) when its agent tries to
  // end the turn, each once: taking them marks them delivered. A build turn's
  // own token only (Claude on Anthropic holds worker:session, over OpenRouter
  // the declaration token), for its own session.
  const buildNotesAuth = internalAuthPurpose([platformJwt.PUR_WORKER, platformJwt.PUR_VISIBLE_CHANGES]);
  router.post('/api/internal/sessions/:sessionId/build-notes/take', buildNotesAuth, sessionLimiter, async (req, res) => {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ ok: false, code: 'bad_session_id', message: 'Invalid session id.' });
    }
    if (Number(req.workerSession.sessionId) !== sessionId) {
      return res.status(403).json({ ok: false, code: 'session_mismatch', message: 'The worker token does not own this session.' });
    }
    try {
      const notes = await require('../services/homeroom-bot-steer').takeNotes(pool, sessionId);
      return res.json({ ok: true, notes: notes.map((n) => ({ note: n.note, by: n.username || null })) });
    } catch (err) {
      log.warn('internal-api', 'Could not hand a build its notes', { sessionId, err: err.message });
      return res.status(500).json({ ok: false, code: 'internal_error', message: 'Could not read the notes.' });
    }
  });

  router.get(
    '/api/internal/sessions/:sessionId/issues',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    sessionLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issues)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url, u.username, u.is_synthetic AS user_is_synthetic
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
             LEFT JOIN users u ON u.id = cs.user_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        if (benchRunner.isBenchSession(rows[0])) {
          return res.json({ ok: true, issues: [], truncatedList: false, note: BENCH_ISSUES_NOTE });
        }
        repoUrl = rows[0].repo_url || '';
      } catch (err) {
        log.error('internal-api', 'Issues session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // Same .git-tolerant parse the push route uses. No repo → return the
      // well-formed empty-with-note shape so the agent gets a clean answer.
      const parsed = repoRef.ownerRepo(repoUrl);
      if (!parsed) {
        return res.json({ ok: true, issues: [], truncatedList: false, note: 'no repo' });
      }
      const { owner, repo } = parsed;
      // Clip verbose bodies for the agent's context — the cache carries
      // full bodies for the web route / Create-PR seeding (#158). The
      // marker names the CLI form that returns the full text on demand.
      const result = github.truncateIssueBodies(
        await github.fetchPublicIssues(owner, repo),
        (n) => `usernode-issues ${n}`
      );
      return res.json({ ok: true, ...result });
    }
  );

  // Read-only: fetch ONE GitHub issue with its FULL (untruncated) body and
  // BOTH of its discussion surfaces — the GitHub comment thread (#396) and
  // the issue's Homeroom-side Discussion thread (#945). Backs the worker's
  // `usernode-issues <number>` CLI form — the escape hatch for bodies the
  // list route clips (#158) and the discussion the original post doesn't
  // carry. Same auth posture as the list route (session-scoped ISSUES_JWT,
  // both scout and build), and the session_mismatch guard is what scopes
  // the thread read to the agent's OWN app.
  // Always 200 with `{ ok: true, issue, comments, commentsTruncated,
  // usernodeThread?, usernodeThreadTruncated?, note?, commentsNote? }` once
  // the session checks pass — every fetcher/loader never throws and
  // resolves failure to a well-formed shape, so the CLI always prints
  // parseable JSON.
  router.get(
    '/api/internal/sessions/:sessionId/issues/:number',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    sessionLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issue)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      let appId = null;
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url, cs.app_id, u.username, u.is_synthetic AS user_is_synthetic
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
             LEFT JOIN users u ON u.id = cs.user_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        if (benchRunner.isBenchSession(rows[0])) {
          return res.json({ ok: true, issue: null, comments: [], commentsTruncated: false, note: BENCH_ISSUES_NOTE });
        }
        repoUrl = rows[0].repo_url || '';
        appId = rows[0].app_id;
      } catch (err) {
        log.error('internal-api', 'Issue session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // #945: the platform-side Discussion thread is keyed on the app, not
      // the repo — so it resolves even for a session whose app has no
      // parseable GitHub remote.
      const thread = await threadContext.loadIssueThread(pool, appId, req.params.number);
      const threadFields = thread.messages.length
        ? { usernodeThread: thread.messages, usernodeThreadTruncated: thread.truncated }
        : {};

      const parsed = repoRef.ownerRepo(repoUrl);
      if (!parsed) {
        return res.json({ ok: true, issue: null, ...threadFields, note: 'no repo' });
      }
      const { owner, repo } = parsed;
      // fetchPublicIssue validates the number itself ('bad issue number').
      // #396: merge the issue's comment thread (clipped) so the worker CLI
      // surfaces the discussion, not just the body. Both fetchers never
      // throw; `comments` is always an array and `commentsNote` carries a
      // comment-fetch failure independently of the issue's own `note`.
      const { issue, note } = await github.fetchPublicIssue(owner, repo, req.params.number);
      const rawComments = await github.fetchIssueComments(owner, repo, req.params.number);
      const { comments, truncated } = github.clipIssueComments(
        rawComments.comments, { wasTruncated: rawComments.truncated }
      );
      return res.json({
        ok: true,
        issue,
        comments,
        commentsTruncated: truncated,
        ...threadFields,
        ...(note ? { note } : {}),
        ...(rawComments.note ? { commentsNote: rawComments.note } : {}),
      });
    }
  );

  // Read-only: list this session's dev-chat file attachments (#450).
  // Backs the worker's usernode-attachments CLI (scout + build) so
  // Claude Code can discover user-attached files. Same auth posture as
  // the issues routes: session-scoped ISSUES_JWT via internalAuth, so
  // scout (which never gets WORKER_JWT) can still read. Metadata only —
  // bytes come from the sibling route below. Only linked (sent)
  // attachments are listed; pending uploads aren't context yet.
  router.get(
    '/api/internal/sessions/:sessionId/attachments',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    sessionLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (attachments)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }
      try {
        // A change an agent session is building also reads the files sent
        // in that conversation (#2779 follow-up): those rows name the
        // conversation, not the change (schema.sql, agent_session_id).
        const { rows } = await pool.query(
          `SELECT id, kind, filename, content_type, size_bytes, meta, created_at
             FROM chat_session_attachments
            WHERE message_id IS NOT NULL
              AND (session_id = $1
                   OR agent_session_id = (SELECT agent_session_id FROM chat_sessions WHERE id = $1))
            ORDER BY created_at ASC, id ASC`,
          [sessionId]
        );
        return res.json({
          ok: true,
          attachments: rows.map((r) => ({
            id: r.id, kind: r.kind, filename: r.filename,
            contentType: r.content_type, sizeBytes: r.size_bytes,
            meta: r.meta || null,
            createdAt: r.created_at,
          })),
        });
      } catch (err) {
        log.error('internal-api', 'Attachment list failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }
    }
  );

  // Read-only: fetch ONE attachment's raw bytes (#450). Backs
  // `usernode-attachments <id> <outpath>` — the worker downloads an
  // image into its container and Reads it (Claude Code's Read tool
  // handles image files natively). Session-scoped like everything else
  // here: an id from another session 404s.
  router.get(
    '/api/internal/sessions/:sessionId/attachments/:attId',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    sessionLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (attachment)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }
      const attId = String(req.params.attId || '');
      if (!/^[a-f0-9]{32}$/.test(attId)) {
        return res.status(404).json({ ok: false, code: 'not_found' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT content_type, data FROM chat_session_attachments
            WHERE id = $1
              AND (session_id = $2
                   OR agent_session_id = (SELECT agent_session_id FROM chat_sessions WHERE id = $2))`,
          [attId, sessionId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, code: 'not_found' });
        res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.send(rows[0].data);
      } catch (err) {
        log.error('internal-api', 'Attachment fetch failed', { sessionId, attId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }
    }
  );

  // No worker calls this in the shipped protocol. Retire it explicitly for
  // external callers too: PR creation belongs to conductor finalization.
  router.post('/api/internal/sessions/:sessionId/pr', (_req, res) => {
    res.status(410).json({ ok: false, code: 'pr_retired', permanent: true,
      message: 'The conductor creates proposals after turn completion.' });
  });

  // ── Platform-issue escalation valve (build-turn coding agent) ─────────
  //
  // A build edits only its own app repository. Some blockers live
  // outside it — the shared bridge, wallet / native WebView, the
  // staging/preview pipeline, the checks gate. When the build-turn agent
  // is confident the root cause is platform-level (rather than looping on
  // a fix it structurally cannot make), it calls this to DRAFT a report.
  // Backs the worker's usernode-report-platform-issue CLI (WORKER_JWT,
  // build-only).
  //
  // Human-gated: this endpoint files NOTHING on GitHub. It persists a
  // pending draft as a system row in the session timeline (metadata.
  // platformIssueDraft) and pushes a live session event so the dev-chat
  // UI renders a card with "Report to platform" / "Dismiss" buttons. The
  // actual GitHub issue is only created when a user taps confirm — see
  // POST /api/sessions/:id/platform-issue/:msgId/confirm in
  // src/routes/sessions.js.
  //
  // Guardrails: session-scoped auth, a hard per-session
  // rate cap, and a normalised-title de-dupe against open agent reports
  // AND this session's earlier drafts, so a stuck turn can't spam either
  // the tracker or the timeline.
  const platformIssueLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Platform-issue proxy rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.post(
    '/api/internal/sessions/:sessionId/platform-issue',
    // Drafting an issue mutates platform state. The read-only Codex scout
    // token must never authorize it; only the general Claude worker token
    // used by build-capable sessions may reach this route.
    internalAuthPurpose([platformJwt.PUR_WORKER]),
    platformIssueLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      // All the real work (validation, destination resolution, both
      // de-dupes, the insert, the live push) lives in the shared service
      // so the Mayor's draft_issue_report tool cannot drift from the
      // agent's CLI. This route only maps the result object back onto the
      // HTTP contract `worker/usernode-report-platform-issue` expects.
      // The agent CLI always targets the PLATFORM repo — an app-repo
      // issue is something the agent would just fix in its own repo.
      const result = await issueDraft.createDraft(pool, _config, {
        sessionId,
        title: req.body?.title,
        body: req.body?.body,
        target: 'platform',
        source: 'agent',
      });

      if (result.ok) return res.json(result);

      const status = {
        bad_title: 400,
        title_too_long: 400,
        body_too_long: 400,
        session_not_found: 404,
        rate_limited: 429,
        not_configured: 503,
        no_repo: 500,
        db_error: 500,
      }[result.code] || 500;
      // Preserve the historical codes for the two config failures — the
      // CLI surfaces the raw body in its __USERNODE_WARN__ line and these
      // strings are what an operator greps for.
      const code = result.code === 'not_configured'
        ? 'github_unconfigured'
        : (result.code === 'no_repo' ? 'no_platform_repo' : result.code);
      return res.status(status).json({ ok: false, code });
    }
  );

  // ── Prod-debug surface (#616) ─────────────────────────────────────────
  //
  // Read-only production access for the usernode-debug worker CLI. Only
  // reachable with a purpose-bound PROD_DEBUG_JWT (worker.mintProdDebugJwt
  // — carries `worker:prod-debug` plus the `prod_debug: true` claim), which
  // the dispatch path mints solely
  // for build/scout turns of admin-owned sessions on the self-edit app.
  // The guard below ALSO re-checks eligibility in the DB on every request
  // so revoking admin (or the session moving off the self-edit app) cuts
  // access immediately despite the JWT's 24h TTL. Everything here is a
  // read: SQL runs under the deny-listed usernode_debug_ro role
  // (services/debug-access.js), docker access is `logs`/`ps` against an
  // allowlist — no write or exec path exists.
  const debugLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Prod-debug rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });
  const prodDebugAuth = internalAuthPurpose([platformJwt.PUR_PROD_DEBUG]);

  const requireProdDebug = async (req, res, next) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ ok: false, code: 'bad_session_id' });
    }
    if (req.workerSession.sessionId !== sessionId) {
      log.warn('prod-debug', 'Session mismatch between JWT and route', {
        jwt: req.workerSession.sessionId, route: sessionId,
      });
      return res.status(403).json({ ok: false, code: 'session_mismatch' });
    }
    if (!req.workerSession.prodDebug) {
      log.warn('prod-debug', 'Rejected token without prod_debug claim', { sessionId });
      return res.status(403).json({ ok: false, code: 'not_prod_debug' });
    }
    let check;
    try {
      check = await debugAccess.checkSessionEligibility(pool, sessionId);
    } catch (err) {
      log.error('prod-debug', 'Eligibility check failed', { sessionId, err: err.message });
      return res.status(500).json({ ok: false, code: 'db_error' });
    }
    if (!check.found) return res.status(404).json({ ok: false, code: 'session_not_found' });
    if (!check.eligible) {
      log.warn('prod-debug', 'Rejected ineligible session', {
        sessionId, selfHosted: check.selfHosted, isAdmin: check.isAdmin,
      });
      return res.status(403).json({ ok: false, code: 'not_eligible' });
    }
    // Audit trail: every prod-debug call, before it executes, with the
    // owner it's attributed to. Route handlers add call-specific detail
    // (the SQL text, the container name) on top.
    req.prodDebug = { sessionId, ownerId: check.ownerId };
    log.info('prod-debug', 'Prod-debug call', {
      sessionId, ownerId: check.ownerId, method: req.method, path: req.path,
    });
    next();
  };

  // Read-only SQL against the platform DB via the usernode_debug_ro
  // role. Deny-listed tables/columns error at the Postgres-grant layer;
  // writes are impossible (role-level default_transaction_read_only + no
  // write grants). Postgres errors are surfaced verbatim so the agent
  // can self-correct its query.
  router.post(
    '/api/internal/sessions/:sessionId/prod-debug/sql',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      // Audit the query text itself (redacted) before executing, so even
      // failed/unavailable attempts are on the record.
      log.info('prod-debug', 'SQL query', {
        sessionId: req.prodDebug.sessionId,
        ownerId: req.prodDebug.ownerId,
        query: log.redactString(query.slice(0, 2000)),
      });
      if (!query.trim()) {
        return res.status(400).json({ ok: false, code: 'bad_query' });
      }
      try {
        const result = await debugAccess.runQuery(query, { config: _config });
        return res.json({
          ok: true,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
      } catch (err) {
        if (err.code === 'unavailable') {
          return res.status(503).json({ ok: false, code: 'unavailable', message: err.message });
        }
        if (err.code === 'bad_query') {
          return res.status(400).json({ ok: false, code: 'bad_query', message: err.message });
        }
        // Postgres-level error (syntax, permission denied on a denied
        // column, read-only violation, timeout) — a 200-with-error so the
        // CLI prints something the agent can act on.
        return res.json({ ok: false, code: 'query_error', message: log.redactString(err.message || '') });
      }
    }
  );

  // Preserve the containers response shape across both runtime inventories.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/containers',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      try {
        const runtimeKind = applicationRuntime.mode(_config);
        const [containers, stats] = runtimeKind === 'kubernetes'
          ? [await kubernetes.listStatusResources(_config), {}]
          : await Promise.all([statusSvc.listContainers(_config), statusSvc.getStats(_config)]);
        return res.json({
          ok: true,
          runtimeKind,
          containers: containers.map((c) => ({
            ...c,
            mem: stats[c.name]?.mem || null,
            cpu: stats[c.name]?.cpu || null,
          })),
        });
      } catch (err) {
        log.error('prod-debug', 'Container list failed', {
          sessionId: req.prodDebug.sessionId, err: err.message,
        });
        return res.status(500).json({ ok: false, code: 'runtime_error' });
      }
    }
  );

  // Recent log lines from ONE allowlisted container. Output is capped
  // and passed through the logger's secret scrubber — the platform's own
  // stdout is already redacted at write time, but child-app logs are
  // not, so redact here as defense in depth.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/logs/:container',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      const name = String(req.params.container || '');
      const runtimeKind = applicationRuntime.mode(_config);
      if (!debugAccess.isAllowedLogContainer(name, runtimeKind)) {
        return res.status(400).json({ ok: false, code: 'bad_container' });
      }
      const tail = debugAccess.clampTail(req.query.tail);
      log.info('prod-debug', 'Container logs read', {
        sessionId: req.prodDebug.sessionId, container: name, tail,
      });
      try {
        let text;
        if (runtimeKind === 'kubernetes') {
          text = String(await kubernetes.getDebugLogs(_config, name, { tailLines: tail, maxBytes: debugAccess.MAX_LOG_BYTES }) || '');
        } else {
          const { stdout, stderr } = await docker.execFileAsync('docker', [
            'logs', '--tail', String(tail), name,
          ], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
          text = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`;
        }
        let truncated = false;
        if (Buffer.byteLength(text, 'utf8') > debugAccess.MAX_LOG_BYTES) {
          const bytes = Buffer.from(text, 'utf8');
          let start = bytes.length - debugAccess.MAX_LOG_BYTES;
          while ((bytes[start] & 0xc0) === 0x80) start++; // do not split a UTF-8 character
          text = bytes.subarray(start).toString('utf8');
          truncated = true;
        }
        return res.json({
          ok: true, container: name, tail, truncated,
          logs: log.redactString(text),
        });
      } catch (err) {
        return res.status(404).json({
          ok: false, code: 'container_unavailable',
          message: log.redactString(String(err.message || '')),
        });
      }
    }
  );

  // Platform health snapshot: the admin /status payload (stuck sessions,
  // warm workers, staging, budgets, deploy state) plus the recent
  // redacted platform log ring.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/status',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      try {
        const payload = await statusSvc.gather(_config, { isAdmin: true });
        return res.json({ ok: true, status: payload, recentLog: log.tail(100) });
      } catch (err) {
        log.error('prod-debug', 'Status snapshot failed', {
          sessionId: req.prodDebug.sessionId, err: err.message,
        });
        return res.status(500).json({ ok: false, code: 'status_error' });
      }
    }
  );

  return router;
}

module.exports = { internalRoutes, isKnownHost };
