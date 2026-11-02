'use strict';

// Homeroom bot parity, P3: look_into. See ./index.js for this module's shape.
//
// The chat model is the cheap one, and reading a file or two (read_source)
// is all it can do with a project's code itself. So it can send a helper
// instead: ONE read-only Claude Code turn (a "scout") on the platform's
// default cheap model, in a worker of the bot's own with the project's
// repository on main, which reads what it needs, may run read-only commands
// (its checks, git log), and reports back. The worker's scout mode refuses
// Edit, Write and NotebookEdit and never commits or pushes
// (worker/run-cc.sh), so "nothing is changed" is structural.
//
// Who may: anybody who can see the project and build on it, the rule of
// list_source and read_source (homeroom-bot-mayor.js sourceRepo): never
// wider. What it costs is building time: the look is the person's, recorded
// in homeroom_bot_looks and counted by homeroom-bot-dm.js weeklySpentCents
// like the bot's builds for them, and the bot's own weekly cap is debited as
// its other turns' are. It runs only while the bot is on and the project is
// one it works on and not paused, one look at a time per person (the table's
// unique index), on a clock of LOOK_CLOCK_MS.
//
// The chat's turn waits for it, up to INLINE_WAIT_MS, saying "Looking into
// it in <project>" on its working card. The look itself is the bot-look
// machine's work (src/workflow/bot-look/), so a restart never loses it: a
// look that takes longer goes on, and its findings are posted in the same
// chat, as a reply of the bot's, when it ends (`deliver = 'post'`). The
// reply that turn sends may then say so, and only then (the claims check:
// ctx.lookRunning, homeroom-bot-mayor.js CLAIMS).
//
// `lookInto` is the turn itself, which an investigation's check-in runs too
// (./investigate.js), on its own work item's steps.

const log = require('../logger');
const durableSteps = require('../durable-steps');
const { withoutEmDashes } = require('../em-dashes');

const TOOL = 'look_into';
const MACHINE = 'bot-look';
const TELEMETRY = 'homeroom_bot_look';
// The look's own clock, and the least an investigation may give one.
const LOOK_CLOCK_MS = 6 * 60 * 1000;
const MIN_CLOCK_MS = 60 * 1000;
// How long the chat's turn waits for a look before it lets it finish on its
// own (the bot's typing card lasts as long: homeroom-bot-dm.js TYPING_MAX_MS).
const INLINE_WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 2000;
// A look still `running` this long after it started is one nothing finishes
// (its work lost for good): it is failed, so the person can look again.
const STALE_LOOK_MS = 20 * 60 * 1000;
const MAX_QUESTION_CHARS = 1200;
const MAX_NOTES_CHARS = 6000;
const MAX_SUMMARY_CHARS = 2400;
const MAX_LINE_CHARS = 200;
const MAX_FILES_KEPT = 40;
const FILES_SHOWN = 5;
const MAX_PROGRESS_LINES = 600;
// The words a look's reply ends with, which this module reads.
const FINDINGS_FORMAT = '```json\n{"summary": "...", "answered": false, "worth_acting": false, "line": "...", "files": ["path/one.js"], "checks": ["npm test"]}\n```';
// Files that hold secrets by convention (homeroom-bot-mayor.js SECRET_PATH_RE).
const SECRET_PATH_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i;

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+$/g, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const plainWords = (value, max) => clip(withoutEmDashes(String(value ?? '').trim()), max);

// ── Pure ───────────────────────────────────────────────────────────────────

/** Pure: a look's arguments, checked: { ok, project, question } or { ok: false, error }. */
function lookArgs(args) {
  const project = typeof args?.project === 'string' ? args.project.trim().replace(/^#/, '') : '';
  const question = typeof args?.question === 'string' ? args.question.replace(/\s+/g, ' ').trim() : '';
  if (!project) return { ok: false, error: 'Say which project to look into.' };
  if (question.length < 8) return { ok: false, error: 'Say what to find out, in a sentence.' };
  return { ok: true, project: project.slice(0, 120), question: question.slice(0, MAX_QUESTION_CHARS) };
}

/** Pure: the prompt the scout reads. */
function lookPrompt({ projectName, username, question, notes = null, since = null, clockMinutes = 6 }) {
  const lines = [
    `You are a helper of Homeroom bot. @${username} asked the bot a question about the project "${projectName}",`,
    'whose repository is checked out here on main. Find the answer in the code.',
    '',
    'THE QUESTION',
    question,
    '',
  ];
  const kept = String(notes || '').trim();
  if (kept) {
    lines.push(
      'NOTES SO FAR',
      'This is one check-in of an investigation that runs over several days. What earlier check-ins found:',
      kept.length > MAX_NOTES_CHARS ? `…${kept.slice(-MAX_NOTES_CHARS)}` : kept,
      '',
    );
  }
  if (since) {
    lines.push(
      'WHAT CHANGED',
      `The last check-in was at ${since}. Look first at what changed since then (for example`,
      `\`git log --since="${since}" --stat\`), and say what is new. Do not repeat what the notes already say.`,
      '',
    );
  }
  lines.push(
    'HOW',
    '- Read what you need: search, open files, read the git history. You may run read-only commands, such as the',
    '  project\'s own tests or checks when they are quick. Never change, commit or push anything: you cannot, and',
    '  nothing you do here is kept.',
    '- Never read or print secrets (.env files, keys, tokens).',
    `- You have about ${clockMinutes} minutes. Stop reading once you can answer.`,
    '',
    'YOUR ANSWER',
    'Write for a person who does not read code: plain, everyday words, short (under 150 words), no code, and file',
    'names only where they help. Say what you found, and say plainly what you could not find out.',
    'END YOUR REPLY WITH EXACTLY ONE fenced JSON block, and nothing after it:',
    FINDINGS_FORMAT,
    '"summary" is your answer as above. "answered" is true only when the question is fully answered. "worth_acting"',
    'is true only when you found something the person should act on now (a bug, a broken check). "line" is one short',
    'sentence of what you found. "files" lists the files you read; "checks" the commands you ran to test anything.',
  );
  return lines.join('\n');
}

/** Pure: the last fenced JSON block of `text`, parsed, or null. */
function lastJsonBlock(text) {
  const s = String(text || '');
  const re = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(s)) !== null) last = m[1];
  if (last == null) {
    const brace = s.lastIndexOf('{"summary"');
    if (brace >= 0) last = s.slice(brace);
  }
  if (last == null) return null;
  try {
    const v = JSON.parse(last.trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pure: what a look's reply says: { summary, answered, worth, line, files,
 * checks }. A reply with no block is its own words, as the summary.
 */
function parseFindings(text) {
  const block = lastJsonBlock(text);
  const words = String(text || '').replace(/```(?:json)?\s*\n[\s\S]*?```/g, '').trim();
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)) : []);
  const summary = plainWords(block && typeof block.summary === 'string' && block.summary.trim() ? block.summary : words, MAX_SUMMARY_CHARS);
  const line = plainWords(block && typeof block.line === 'string' ? block.line : summary.split(/(?<=[.!?])\s/)[0], MAX_LINE_CHARS);
  return {
    summary,
    answered: block?.answered === true,
    worth: block?.worth_acting === true,
    line,
    files: list(block?.files).filter((f) => !SECRET_PATH_RE.test(f)),
    checks: list(block?.checks).slice(0, 10),
  };
}

const WORKSPACE_PREFIX = /^(?:\/home\/node\/workspace|\/workspace)\/+/;
const CHECK_COMMAND = /\b(?:npm (?:run )?(?:test|lint|check|build)|node --test|npx (?:tsc|vitest|jest|eslint|playwright)|pytest|cargo test|go test|vitest|jest|tsc\b)/i;

/** Pure: a path as the worker named it, relative to the repository. */
function repoPath(raw, repoName = null) {
  let p = String(raw || '').trim().replace(WORKSPACE_PREFIX, '');
  if (repoName && p.startsWith(`${repoName}/`)) p = p.slice(repoName.length + 1);
  return p.replace(/^\.\//, '');
}

/**
 * Pure: what a scout's progress lines say it did (worker.js labels its tool
 * calls "Reading <path>" and "$ <command>"): the files it read, once each,
 * and the checks it ran.
 */
function activityOf(lines, repoName = null) {
  const files = [];
  const checks = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '');
    const read = /^Reading (.+)$/.exec(line);
    if (read) {
      const p = repoPath(read[1], repoName);
      if (p && !files.includes(p) && !SECRET_PATH_RE.test(p)) files.push(p);
      continue;
    }
    const cmd = /^\$ (.+)$/.exec(line);
    if (cmd && CHECK_COMMAND.test(cmd[1])) {
      const c = cmd[1].trim().slice(0, 120);
      if (!checks.includes(c)) checks.push(c);
    }
  }
  return { files, checks };
}

/** Pure: the "what I looked at" lines of a finished look (P1's ctx.looked). */
function lookedItems({ appName, filesRead = 0, checks = [] }) {
  const items = [];
  const n = Number(filesRead) || 0;
  items.push({ what: n > 0 ? `Read ${n} ${n === 1 ? 'file' : 'files'} in ${appName}` : `Looked into ${appName}'s code` });
  if (Array.isArray(checks) && checks.length) items.push({ what: `Ran its checks in ${appName}` });
  return items;
}

/** Pure: a look's row as the chat model reads it. */
function compactResult(row, appName) {
  const files = Array.isArray(row.files) ? row.files : [];
  const checks = Array.isArray(row.checks) ? row.checks : [];
  return {
    ok: row.state === 'done',
    project: appName,
    summary: row.summary || null,
    answered: row.answered === true,
    filesRead: { count: Number(row.files_read) || files.length, some: files.slice(0, FILES_SHOWN) },
    ...(checks.length ? { checksRun: checks.slice(0, 5) } : {}),
    minutes: Math.max(1, Math.round((Number(row.duration_ms) || 0) / 60000)),
    ...(row.state === 'failed' ? { error: row.error || 'The look did not finish.' } : {}),
  };
}

// ── The project and the gates ─────────────────────────────────────────────

/** The project by name or slug, and its repository, when this person can see it and build on it. */
async function projectFor(pool, user, project) {
  const access = require('../app-access');
  const q = String(project || '').trim().replace(/^#/, '');
  if (!q || !user?.id) return { error: 'No such project whose code they can read. Check my_projects.' };
  const { rows } = await pool.query(
    `SELECT ${access.nonSecretAppColumnList()} FROM apps
      WHERE slug = LOWER($1) OR LOWER(name) = LOWER($1)
      ORDER BY (slug = LOWER($1)) DESC, id
      LIMIT 1`,
    [q],
  );
  const app = rows[0] || null;
  let allowed = false;
  if (app) {
    try {
      allowed = await access.checkAppAccess(pool, app, user, 'view') && await access.checkAppAccess(pool, app, user, 'collab');
    } catch { allowed = false; }
  }
  if (!allowed) return { error: 'No such project whose code they can read. Check my_projects.' };
  const repo = require('../repo-ref').ownerRepo(app.repo_url);
  if (!repo) return { error: 'That project has no code yet.' };
  return { app, repo };
}

/**
 * Whether a look (or an investigation's check-in) may run now, for `user`
 * on `app`: null when it may, else { code, error } in words the chat model
 * passes on. Reads only; never throws for a refusal.
 */
// What a refusal says it cannot do, by what was asked.
const GATE_DOING = Object.freeze({ look: 'look into its code', investigation: 'run an investigation on it' });

async function gate(pool, { user, app, settings, bot = null, deps = {}, doing = 'look' }) {
  const live = deps.live || require('../homeroom-bot-live');
  const what = GATE_DOING[doing] || GATE_DOING.look;
  if (!settings || settings.mode === 'off') return { code: 'bot_off', error: `Homeroom bot is turned off just now, so it cannot ${what}.` };
  if ((settings.pausedApps || []).includes(app.slug) || !live.isLiveFor(settings, app)) {
    return { code: 'paused', error: `Homeroom bot is not working on that project just now, so it cannot ${what}.` };
  }
  const dm = deps.dm || require('../homeroom-bot-dm');
  if (await dm.overWeeklyAllowance(pool, settings, user.id)) {
    return { code: 'allowance', error: `Their building time for this week is used up, so Homeroom bot cannot ${what} until it resets.` };
  }
  if (bot?.id) {
    const limits = deps.limits || require('../limits');
    const budget = await limits.checkBudget(pool, bot.id).catch(() => ({ error: 'unreadable' }));
    if (budget?.error) return { code: 'bot_budget', error: `Homeroom bot has used its own time for this week, so it cannot ${what} just now.` };
  }
  return null;
}

/** A look nothing finishes any more, failed so the person can look again. */
async function clearStale(pool, userId) {
  await pool.query(
    `UPDATE homeroom_bot_looks SET state = 'failed', error = 'it did not finish', ended_at = NOW()
      WHERE user_id = $1 AND state = 'running' AND created_at < NOW() - make_interval(secs => $2)`,
    [userId, STALE_LOOK_MS / 1000],
  ).catch((err) => log.warn('homeroom-bot-look', 'Could not clear a stale look', { userId, err: err.message }));
}

/**
 * A look's row, written before it runs: { id, existing } for this chat
 * message's (or check-in's) look, or { busy: true } when another look of the
 * person's is still running.
 */
async function startLookRow(pool, {
  user, app, question, conversationId = null, messageId = null, threadRootId = null, investigationId = null, checkin = null,
}) {
  await clearStale(pool, user.id);
  const key = messageId ? 'message_id' : 'investigation_id';
  const mine = () => (messageId
    ? pool.query('SELECT id, state FROM homeroom_bot_looks WHERE message_id = $1', [Number(messageId)])
    : pool.query('SELECT id, state FROM homeroom_bot_looks WHERE investigation_id = $1 AND checkin = $2', [Number(investigationId), Number(checkin)]));
  const { rows: found } = await mine();
  if (found[0]) return { id: Number(found[0].id), existing: true, state: found[0].state };
  try {
    const { rows } = await pool.query(
      `INSERT INTO homeroom_bot_looks
         (user_id, app_id, conversation_id, message_id, thread_root_id, investigation_id, checkin, question)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [user.id, app.id, conversationId || null, messageId || null, threadRootId || null,
        investigationId || null, checkin == null ? null : Number(checkin), clip(question, MAX_QUESTION_CHARS * 6)],
    );
    return { id: Number(rows[0].id), existing: false, state: 'running' };
  } catch (err) {
    if (err?.code !== '23505') throw err;
    // Its own row, written meanwhile by a retry of the same answer, or another look of theirs running.
    const { rows: again } = await mine();
    if (again[0]) return { id: Number(again[0].id), existing: true, state: again[0].state };
    log.info('homeroom-bot-look', 'A look was refused: another of theirs is running', { userId: user.id, by: key });
    return { busy: true };
  }
}

/**
 * The bot's session for this person's looks into this project: on main,
 * paused between looks, apart from the project's triage session.
 */
async function lookSession(pool, config, { bot, app, user, model }) {
  const { rows: found } = await pool.query(
    `SELECT cs.* FROM homeroom_bot_look_sessions l
       JOIN chat_sessions cs ON cs.id = l.session_id
      WHERE l.app_id = $1 AND l.user_id = $2 AND cs.status IN ('active', 'paused') AND cs.branch_name = 'main'`,
    [app.id, user.id],
  );
  let session = found[0] || null;
  if (!session) {
    const { rows } = await pool.query(
      `WITH made AS (
         INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                    session_title, agent_backend, agent_provider, agent_model, agent_reasoning_effort)
         VALUES ($1, $2, 'main', 'paused', FALSE, '{}', 'Homeroom bot look', 'codex_openrouter', 'openrouter', $3, $4)
         RETURNING *
       ), kept AS (
         INSERT INTO homeroom_bot_look_sessions (app_id, user_id, session_id)
         SELECT $1, $5, id FROM made
         ON CONFLICT (app_id, user_id) DO UPDATE SET session_id = EXCLUDED.session_id, created_at = NOW()
       )
       SELECT * FROM made`,
      [app.id, bot.id, model, config.openrouterDefaultCodexReasoning || 'low', user.id],
    );
    session = rows[0];
    log.info('homeroom-bot-look', 'Look session created', { app: app.slug, sessionId: session.id });
  }
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

// ── The look itself ───────────────────────────────────────────────────────

/**
 * ONE read-only turn of the bot's in this person's look session on `app`,
 * on the platform's cheap model: reads the code on main and answers
 * `question` (with an investigation's `notes` and the time of its last
 * check-in, `since`). Resolves
 *   { ok: true, summary, answered, worth, line, filesRead, files, checks, ms, costUsd, model }
 *   { ok: false, error, code, costUsd, ms }
 * and never throws but a stop of its steps (deps.steps: the work item's).
 * The gates are the caller's (gate()).
 */
async function lookInto(pool, config, { user, app, question, notes = null, since = null, budget = {}, deps = {} }) {
  const startedMs = Date.now();
  const steps = deps.steps || durableSteps.none();
  const worker = deps.worker || require('../worker');
  const agentTurn = deps.agentTurn || require('../agent-turn');
  const sessions = deps.sessions || require('../../routes/sessions');
  const live = deps.live || require('../homeroom-bot-live');
  const botSvc = deps.botSvc || require('../homeroom-bot');
  const repo = require('../repo-ref').ownerRepo(app.repo_url);
  if (!repo) return { ok: false, code: 'no_code', error: 'That project has no code yet.', costUsd: null, ms: 0 };
  const bot = deps.bot || await botSvc.ensureBotUser(pool, config);
  const settings = deps.settings || await botSvc.readSettings(pool);
  // The platform's default model, as the bot's own turns pick it when no
  // configuration overrides (default-model.js), on the CLI its map gives it.
  const model = deps.model || require('../default-model').fromSettings(settings, config);
  const harness = live.recipeHarness(model, config);
  const clockMs = Math.min(LOOK_CLOCK_MS, Math.max(MIN_CLOCK_MS, Number(budget.clockMs) || LOOK_CLOCK_MS));
  const session = await lookSession(pool, config, { bot, app, user, model });
  const progress = [];
  const onProgress = (line) => {
    if (progress.length < MAX_PROGRESS_LINES) progress.push(String(line || ''));
    if (typeof deps.onProgress === 'function') { try { deps.onProgress(line); } catch { /* a watcher never stops a look */ } }
  };
  let containerName;
  try {
    containerName = await live.ensureBuildWorker({ worker, session, repo, branchName: 'main', steps });
  } catch (err) {
    durableSteps.rethrowStop(err, 'look worker');
    log.warn('homeroom-bot-look', 'A look\'s worker could not start', { app: app.slug, err: err.message });
    return { ok: false, code: 'worker', infra: true, error: 'Its worker could not start just now.', costUsd: null, ms: Date.now() - startedMs };
  }
  await require('../session-lifecycle').takeSlot({ pool, sessionId: session.id, source: 'homeroom-bot' });
  // A fresh conversation for every look, on the model chosen now.
  await pool.query('UPDATE chat_sessions SET agent_thread_id = NULL, agent_model = $2 WHERE id = $1', [session.id, model]);
  session.agent_thread_id = null;
  session.agent_model = model;
  const prompt = lookPrompt({
    projectName: app.name || app.slug, username: user.username, question, notes, since,
    clockMinutes: Math.round(clockMs / 60000),
  });
  let pricing = null;
  const dispatch = (extra = {}) => sessions.runCodexAttemptLoop({
    pool, session, userId: bot.id, config, isCodexSession: true,
    turnModel: model, resumeThreadId: null, mode: 'scout',
    telemetryComponent: TELEMETRY,
    owner: extra.owner || null,
    resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
      pool, session, userId: bot.id, model, resumeThreadId: null, config, harness,
    }),
    dispatchOnce: (ctx) => {
      pricing = ctx?.pricingSnapshot || pricing;
      return worker.execInWorker(session.id, {
        mode: 'scout', prompt, model, commitMsg: '', resumeSessionId: null, branchName: session.branch_name,
        ...(ctx || {}), ...extra, telemetryComponent: TELEMETRY, onProgress,
      });
    },
    retryPredicate: () => null,
    sendStatus: async () => {},
    waitForStopped: async () => {},
    prepareRetry: async () => false,
    classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
    containerName,
  });
  let ran;
  try {
    ran = await require('../durable-turn').runTurn(steps, deps.turnKey || 'look', {
      pool, session, mode: 'scout', budgetMs: clockMs, dispatch, onProgress, fullBudgetAgain: true,
      stop: () => require('../durable-turn').clockStop(worker, pool, session.id, steps.turnOwner),
      deps: { worker, agentTurn },
    });
  } catch (err) {
    durableSteps.rethrowStop(err, 'look turn');
    ran = { routed: { error: `dispatch: ${err.message}` }, stopped: false };
  } finally {
    if (!steps.stopped) await require('../session-lifecycle').restSession({ pool, sessionId: session.id }).catch(() => {});
  }
  const routed = ran?.routed || null;
  const result = (routed && routed.result) || {};
  const ledger = Number.isFinite(routed?.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  const relay = botSvc.relaySpend(result.relayUsage, pricing, agentTurn);
  const costUsd = ledger ?? relay?.costUsd ?? null;
  // The bot's own weekly cap, once across the item's attempts.
  if (costUsd > 0) {
    await steps.once(`${deps.turnKey || 'look'}:debit`, async () => {
      try {
        const managed = deps.managedOpenRouter || require('../openrouter-managed-keys');
        if (await managed.usesIncludedKey(pool, bot.id)) {
          await (deps.limits || require('../limits')).recordSpend(pool, bot.id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
        }
      } catch (err) {
        log.warn('homeroom-bot-look', 'Could not debit a look\'s spend', { err: err.message });
      }
      return true;
    });
  }
  const ms = Date.now() - startedMs;
  if (ran?.stopped || ran?.stoppedBy) {
    return { ok: false, code: 'time', error: 'It ran out of time before it finished.', costUsd, ms, model };
  }
  if (!routed || routed.error) {
    log.warn('homeroom-bot-look', 'A look\'s turn failed', { app: app.slug, err: clip(routed?.error || 'no result', 300) });
    return { ok: false, code: 'failed', error: 'The look did not finish just now.', costUsd, ms, model };
  }
  const text = [result.lastResultText, ...(Array.isArray(result.answerParts) ? result.answerParts : [])]
    .filter((p) => typeof p === 'string' && p.trim()).find((p) => /```json/.test(p)) || result.lastResultText || '';
  const found = parseFindings(text);
  if (!found.summary) return { ok: false, code: 'empty', error: 'The look came back with nothing to say.', costUsd, ms, model };
  const seen = activityOf(progress, repo.repo);
  const files = [...new Set([...seen.files, ...found.files])].slice(0, MAX_FILES_KEPT);
  const checks = [...new Set([...seen.checks, ...found.checks])].slice(0, 10);
  return {
    ok: true, summary: found.summary, answered: found.answered, worth: found.worth, line: found.line,
    filesRead: seen.files.length || files.length, files, checks, ms, costUsd, model,
  };
}

// ── A chat's look, as the bot-look machine runs it ────────────────────────

async function loadLook(pool, id) {
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_looks WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

async function personOf(pool, userId) {
  const { rows } = await pool.query('SELECT id, username, is_admin FROM users WHERE id = $1', [Number(userId)]);
  return rows[0] ? { id: Number(rows[0].id), username: rows[0].username, isAdmin: rows[0].is_admin === true } : null;
}

async function appOf(pool, appId) {
  const { rows } = await pool.query(
    `SELECT ${require('../app-access').nonSecretAppColumnList()} FROM apps WHERE id = $1`, [Number(appId)],
  );
  return rows[0] || null;
}

/** A look's end, recorded once: what it found, or why it did not. Resolves the row after. */
async function finishLook(pool, id, out) {
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_looks
        SET state = $2, summary = $3, answered = $4, worth_acting = $5, line = $6, files_read = $7,
            files = $8::jsonb, checks = $9::jsonb, error = $10, model = $11, cost_usd = $12,
            duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::int), ended_at = NOW()
      WHERE id = $1 AND state = 'running'
      RETURNING *`,
    [Number(id), out.ok ? 'done' : 'failed', out.ok ? out.summary : null, out.ok ? !!out.answered : null,
      out.ok ? !!out.worth : null, out.ok ? out.line || null : null, out.ok ? Number(out.filesRead) || 0 : null,
      JSON.stringify(out.ok ? out.files || [] : []), JSON.stringify(out.ok ? out.checks || [] : []),
      out.ok ? null : clip(out.error || 'it did not finish', 300), out.model || null,
      Number.isFinite(out.costUsd) ? out.costUsd : null],
  );
  return rows[0] || loadLook(pool, id);
}

/**
 * The findings of a look the chat stopped waiting for, said in that chat as
 * a reply of the bot's, under the look's key: never twice.
 */
async function postFindings(pool, config, row, { deps = {} } = {}) {
  const dm = deps.dm || require('../homeroom-bot-dm');
  const bot = deps.bot || await (deps.botSvc || require('../homeroom-bot')).ensureBotUser(pool, config);
  const app = await appOf(pool, row.app_id);
  const name = app?.name || app?.slug || 'the project';
  const done = row.state === 'done';
  const content = done
    ? `I finished looking into it in ${name}.\n\n${row.summary}`
    : `I couldn't finish looking into it in ${name}: ${String(row.error || 'it did not finish').replace(/\.$/, '')}. Ask me again if you want me to try once more.`;
  const items = done ? lookedItems({ appName: name, filesRead: row.files_read, checks: row.checks }) : [];
  const sent = await dm.sendDm(pool, {
    bot, userId: Number(row.user_id), content: withoutEmDashes(content),
    idempotencyKey: `hrbot-look:${row.id}`,
    replyToId: row.message_id ? Number(row.message_id) : null,
    ...(row.thread_root_id ? { threadRootId: Number(row.thread_root_id) } : {}),
    moment: 'reply',
    metadata: {
      kind: 'chat', ...(app?.slug ? { appSlug: app.slug } : {}),
      ...(items.length ? { looked: { items, ms: Number(row.duration_ms) || 0 } } : {}),
    },
  });
  if (sent?.messageId) {
    await pool.query('UPDATE homeroom_bot_looks SET posted_message_id = $2 WHERE id = $1', [Number(row.id), Number(sent.messageId)]);
  }
  return sent?.messageId ?? null;
}

/**
 * The bot-look machine's `look.run` (src/workflow/bot-look/services.ts): the
 * look on the work item's steps, its end recorded, and its findings posted
 * when the chat stopped waiting. A retry after a restart follows the turn
 * (durable-turn.js) and says nothing twice.
 */
async function runLookWork(ctx, { pool, config, deps = {} }) {
  const id = Number(ctx.input?.lookId);
  const key = `look:${id}`;
  const steps = ctx.steps({ owner: `${MACHINE}/${key}` });
  steps.turnOwner = { machine: MACHINE, key, kind: ctx.kind || 'look.run', workKey: ctx.key || 'run', workId: ctx.workId || null };
  let row = await loadLook(pool, id);
  if (!row) return { skipped: 'gone' };
  if (row.state === 'running') {
    const out = await steps.once('look', async () => {
      const [user, app] = await Promise.all([personOf(pool, row.user_id), appOf(pool, row.app_id)]);
      const botSvc = deps.botSvc || require('../homeroom-bot');
      const settings = await botSvc.readSettings(pool, { strict: true });
      const bot = deps.bot || await botSvc.ensureBotUser(pool, config);
      if (!user || !app) return { ok: false, code: 'gone', error: 'The project is gone.' };
      // Asked earlier: the person may have lost the project since, or the bot been turned off.
      const found = await projectFor(pool, user, app.slug);
      if (found.error) return { ok: false, code: 'gone', error: 'They can no longer build on that project.' };
      const refused = await gate(pool, { user, app, settings, bot, deps });
      if (refused) return { ok: false, code: refused.code, error: refused.error };
      const looked = deps.lookInto || lookInto;
      return looked(pool, config, { user, app, question: row.question, deps: { ...deps, steps, settings, bot } });
    });
    row = await finishLook(pool, id, out);
  }
  if (row && row.state !== 'running' && row.deliver === 'post' && !row.posted_message_id) {
    await steps.once('post', () => postFindings(pool, config, row, { deps }));
  }
  return { state: row?.state || 'gone' };
}

/** The bot-look machine's `look.failed`: a look whose work failed for good, recorded and said once. */
async function lookFailed(ctx, { pool, config, deps = {} }) {
  const id = Number(ctx.input?.lookId);
  let row = await finishLook(pool, id, { ok: false, error: 'it did not finish' });
  if (row && row.deliver === 'post' && !row.posted_message_id) {
    await postFindings(pool, config, row, { deps });
    row = await loadLook(pool, id);
  }
  return { state: row?.state || 'gone' };
}

// ── The chat's tool ──────────────────────────────────────────────────────

const LOOK_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: TOOL,
    description: 'Send a helper to look into a project\'s code for them: it reads the project on main (files, history), '
      + 'may run its quick read-only checks, and reports what it found in a few minutes. Use it when the question needs '
      + 'more than a file or two of read_source: how something works across the code, why a check fails, where a bug '
      + 'comes from. It never changes anything. Only for a project they can build on; one look at a time; it counts '
      + 'toward their building time.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by its name or slug.' },
        question: { type: 'string', description: 'What to find out, in a sentence or two, with anything they said that helps.' },
      },
      required: ['project', 'question'],
    },
  },
});

/** The words of a refusal or a result of the look for the model. */
async function waitForLook(pool, id, { waitMs = INLINE_WAIT_MS, pollMs = POLL_MS, sleep = null } = {}) {
  const pause = sleep || ((ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
  const until = Date.now() + Math.max(0, waitMs);
  let row = await loadLook(pool, id);
  while (row && row.state === 'running' && Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await pause(Math.min(pollMs, Math.max(0, until - Date.now())));
    // eslint-disable-next-line no-await-in-loop
    row = await loadLook(pool, id);
  }
  return row;
}

/** Ask the bot-look machine to run look `id`. Never twice: the request is keyed by the look. */
async function requestLook(pool, { id, appId, userId }) {
  const { requestLook: ask } = require('../../workflow/bot-look/machine.ts');
  return ask(pool, { lookId: id, appId, userId });
}

async function runTool(pool, ctx, args) {
  const a = lookArgs(args);
  if (!a.ok) return { ok: false, error: a.error };
  const deps = ctx.deps || {};
  const found = await projectFor(pool, ctx.user, a.project);
  if (found.error) return { ok: false, error: found.error };
  const { app } = found;
  if (ctx.appIds && typeof ctx.appIds.add === 'function') ctx.appIds.add(Number(app.id));
  const name = app.name || app.slug;
  // One look per turn: a second call reads the first.
  if (ctx.lookStarted && Number(ctx.lookStarted.appId) !== Number(app.id)) {
    return { ok: false, error: 'One look per answer. Answer from the look you already started.' };
  }
  const botSvc = deps.botSvc || require('../homeroom-bot');
  const bot = ctx.bot || await botSvc.ensureBotUser(pool, ctx.config || {});
  const refused = await gate(pool, { user: ctx.user, app, settings: ctx.settings, bot, deps });
  if (refused) return { ok: false, error: refused.error };
  const started = ctx.lookStarted && ctx.lookStarted.id
    ? { id: ctx.lookStarted.id, existing: true }
    : await startLookRow(pool, {
      user: ctx.user, app, question: a.question, conversationId: ctx.conversationId,
      messageId: ctx.messageId, threadRootId: deps.threadRequest?.rootId || deps.threadRootId || null,
    });
  if (started.busy) return { ok: false, error: 'Another look of theirs is still running. It has to finish before the next one starts.' };
  ctx.lookStarted = { id: started.id, appId: Number(app.id) };
  // A retry of this same answer, after an earlier try stopped waiting: the
  // look posts its findings itself, so this one does not wait again.
  const before = started.existing ? await loadLook(pool, started.id) : null;
  if (before && before.deliver === 'post') {
    if (before.state === 'running') {
      ctx.lookRunning = true;
      return { ok: true, running: true, project: name, note: 'The look is still running; its findings will be posted in this chat. Say so in one short line.' };
    }
    return { ...compactResult(before, name), note: 'Its findings were posted in this chat already.' };
  }
  if (!started.existing || started.state === 'running') {
    await (deps.requestLook || requestLook)(pool, { id: started.id, appId: Number(app.id), userId: Number(ctx.user.id) });
  }
  // The working card says "Looking into it in <project>" meanwhile
  // (homeroom-bot-mayor.js sayDoing, doingFor 'look_into').
  let row = await waitForLook(pool, started.id, {
    waitMs: Number.isFinite(deps.lookWaitMs) ? deps.lookWaitMs : INLINE_WAIT_MS,
    pollMs: Number.isFinite(deps.lookPollMs) ? deps.lookPollMs : POLL_MS,
    // Its own key: a test's no-op `sleep` for the model's retries would make this a busy loop.
    sleep: deps.lookSleep || null,
  });
  if (row && row.state === 'running') {
    // Still going: it finishes on its own and is posted here, unless it ended just now.
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_looks SET deliver = 'post' WHERE id = $1 AND state = 'running' RETURNING id`, [started.id],
    );
    if (rows.length) {
      ctx.lookRunning = true;
      return {
        ok: true, running: true, project: name,
        note: 'The look is still running. Its findings will be posted in this chat as soon as it ends: say so in one short line '
          + '(for example "I\'ll post what I find here"), and say nothing about what it will find.',
      };
    }
    row = await loadLook(pool, started.id);
  }
  if (!row) return { ok: false, error: 'The look did not start just now.' };
  const out = compactResult(row, name);
  if (row.state === 'done') {
    ctx.looked = Array.isArray(ctx.looked) ? ctx.looked : [];
    ctx.looked.push(...lookedItems({ appName: name, filesRead: row.files_read, checks: row.checks }));
    ctx.lookedMs = (Number(ctx.lookedMs) || 0) + (Number(row.duration_ms) || 0);
  }
  return out;
}

module.exports = {
  tools: (ctx) => (ctx && ctx.user && ctx.settings && ctx.settings.mode !== 'off' ? [LOOK_TOOL] : []),
  run: async (pool, ctx, name, args) => (name === TOOL ? runTool(pool, ctx, args) : undefined),
  promptLines: (ctx) => (ctx && ctx.user && ctx.settings && ctx.settings.mode !== 'off' ? [
    '- Send a helper to look into a project\'s code (look_into) when answering needs more than a file or two of',
    '  read_source: how something works across the code, why a check fails, where a bug comes from. It reads the',
    '  project on main and reports back in a few minutes; it changes nothing. Only for a project they can build on,',
    '  one look at a time. If it is still running when you reply, say in one short line that you will post what it',
    '  finds here, and nothing else about it.',
  ] : []),
  // The look itself, for an investigation's check-in (./investigate.js).
  lookInto,
  gate,
  projectFor,
  startLookRow,
  lookSession,
  finishLook,
  loadLook,
  personOf,
  appOf,
  lookedItems,
  // The bot-look machine's work (src/workflow/bot-look/services.ts).
  runLookWork,
  lookFailed,
  postFindings,
  // Pure, for tests.
  lookArgs,
  lookPrompt,
  parseFindings,
  activityOf,
  repoPath,
  compactResult,
  waitForLook,
  TOOL,
  LOOK_TOOL,
  LOOK_CLOCK_MS,
  INLINE_WAIT_MS,
  STALE_LOOK_MS,
};
