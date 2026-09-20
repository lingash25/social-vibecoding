'use strict';

// #249: meaningful default session names — the display-name layer over
// machine-generated branch names. Sessions are titled:
//   1. From their first interactive message (maybeTitleFirstMessage).
//   2. At pre-PR turn ends, from the full request history + latest
//      spec draft (refreshFromHistory) so the name sharpens as the
//      session's focus develops.
//   3. Once a PR exists, applyPrMetadata (pr-metadata.js) mirrors
//      pr_title into session_title and owns the name from then on —
//      every UPDATE here is guarded on `pr_number IS NULL` so a slow
//      in-flight early-title call can never clobber a PR-mirrored one.
//      A manual proposal rename also sets `proposed_pr_title`; that is an
//      author choice, so the same guard keeps later automatic refreshes from
//      replacing it before the PR is created.
//   4. Headless auto sessions get the deterministic, LLM-free
//      "#N · issue title" at creation (headlessTitle), inherited by
//      clones.
//   5. OpenRouter sessions (#1949) are named the moment their first ask
//      arrives, without a helper-model call, by titleFromFirstMessage —
//      the same trim pr-metadata.js gives their PR title, so the name a
//      session shows before its PR is the name it keeps after. Since
//      #2500 that is a FIRST name, not the final one: their turn end
//      goes through refreshFromHistory like every other in-platform
//      session, so the helper model gets to describe what the change
//      actually does.
//   6. #2500: every path above shares one scaffolding rule. A session
//      started from an issue card opens with the seed
//      `Please implement GitHub issue #N: "<title>".…`, and naming a
//      change after the instruction to make it is useless. parseIssueSeed
//      peels the wrapper off, so the deterministic name is the issue
//      title and the model is handed that title as its issueTitle input.
//      When no helper model is reachable at all, generateAndApply falls
//      back to the same deterministic name rather than leaving the
//      session showing its branch.
//
// Every entry point is fire-and-forget: the returned promise ALWAYS
// resolves (with the new title, or null on failure/skip) and never
// rejects, so callers can ignore it without risking an unhandled
// rejection — title generation must never fail or block a turn.

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');

// Deterministic headless display name: "#N · <issue title>", truncated
// to fit the VARCHAR(256) column. Returns null when the issue fetch
// degraded to number-only (no title to show — the branch-name fallback
// is better than a bare "#N · ").
function headlessTitle(issueNumber, issueTitle) {
  const n = parseInt(issueNumber, 10);
  const t = String(issueTitle || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(n) || n <= 0 || !t) return null;
  return `#${n} · ${t}`.slice(0, 256);
}

// The deterministic, LLM-free trim an OpenRouter session's display name
// and its PR title (deterministicPrMetadataDraft in pr-metadata.js) share:
// fenced code and markdown punctuation dropped, whitespace collapsed, and
// a hard 72-character ceiling with an ellipsis on truncation. Returns ''
// when nothing readable survives so each caller picks its own fallback.
// One derivation on purpose — the session name and the PR title stay
// identical only while they come from the same function.
const DETERMINISTIC_TITLE_MAX = 72;

// #2500: the issue card's "Create proposal" button seeds the composer with
// scaffolding around the issue (public/js/app-view.js createPrForIssue):
//
//   Please implement GitHub issue #N: "<issue title>".<issue body>
//   Open a PR that closes this issue (include "Closes #N" so it links …).
//
// Left alone that wrapper IS the name: the trim below strips the `#` along
// with the rest of the markdown punctuation and cuts at 72, which is how a
// session came to be called `Please implement GitHub issue 2496: "Add
// claimed issues to workshop cur…`. Peel the wrapper off wherever a title
// is derived, so the deterministic name is the ISSUE TITLE the scaffolding
// was wrapping, and hand that same title to the model as the issue-title
// signal generateSessionTitle already accepts.
const ISSUE_SEED_RE = /^\s*Please implement GitHub issue #(\d+):\s*"([\s\S]*?)"\.[ \t]*/;
// The closing instruction the same seed appends. It is guidance for the
// agent, never a description of the change, so it is dropped from the model
// prompt too.
const ISSUE_SEED_TAIL_RE = /\s*Open a PR that closes this issue \(include "Closes #\d+"[^)]*\)\.?\s*$/;

// { number, title, body } for a message that is the issue-card seed, or
// null for anything a user wrote themselves.
function parseIssueSeed(text) {
  const raw = String(text || '');
  const m = ISSUE_SEED_RE.exec(raw);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    title: m[2].replace(/\s+/g, ' ').trim(),
    body: raw.slice(m[0].length).replace(ISSUE_SEED_TAIL_RE, '').trim(),
  };
}

function deterministicTitle(text) {
  // A seeded message names the change after its issue, not after the
  // instruction wrapped around it. The body is the fallback for the
  // degraded seed whose issue fetch produced an empty title.
  const seed = parseIssueSeed(text);
  const source = seed ? (seed.title || seed.body) : text;
  const plain = String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > DETERMINISTIC_TITLE_MAX
    ? `${plain.slice(0, DETERMINISTIC_TITLE_MAX - 1).trimEnd()}…`
    : plain;
}

// Model inputs for a request history that may open with the issue-card
// seed: the scaffolding is replaced by the issue title + body it wrapped,
// and the issue title is lifted out as its own signal. Unseeded histories
// come back untouched with a null issueTitle.
function titleInputsFromRequests(requests) {
  let issueTitle = null;
  const prepared = (Array.isArray(requests) ? requests : [])
    .map((r) => String(r || ''))
    .filter((r) => r.trim())
    .map((text) => {
      const seed = parseIssueSeed(text);
      if (!seed) return text;
      if (!issueTitle && seed.title) issueTitle = seed.title;
      return [seed.title, seed.body].filter(Boolean).join('\n\n') || text;
    });
  return { requests: prepared, issueTitle };
}

// Guarded persist + broadcast shared by every title source. The
// Two guards make an explicit title authoritative: once applyPrMetadata
// mirrored a PR title in, or once an author manually chose the future PR
// title, a slower in-flight generated title must lose the race. `send` is
// the chat turn's event emitter (SSE + global WS + session bus), so open
// session lists update live via the `session_titled` event.
async function persistTitle({ pool, session, title, send }) {
  const { rowCount } = await pool.query(
    `UPDATE chat_sessions SET session_title = $1
      WHERE id = $2 AND pr_number IS NULL AND proposed_pr_title IS NULL`,
    [title, session.id]
  );
  if (!rowCount) return null;
  session.session_title = title;
  if (send) send('session_titled', { sessionTitle: title });
  return title;
}

// Core generate → debit → persist → broadcast path.
//
// #2500: the requests are prepared before they reach the model — an
// issue-card seed becomes the issue title plus the issue body, and the
// issue title rides along as its own input. An explicit `issueTitle` from
// the caller still wins; the derived one only fills the gap.
function generateAndApply({ pool, session, requests, specs, issueTitle, userId, apiKey, send }) {
  const prepared = titleInputsFromRequests(requests);
  const issue = issueTitle || prepared.issueTitle || null;
  return (async () => {
    const meta = await llm.generateSessionTitle({
      requests: prepared.requests,
      specs,
      issueTitle: issue,
      apiKey,
      telemetryContext: {
        pool,
        appId: session.app_id,
        sessionId: session.id,
      },
    });

    // Debit the Haiku call to the requesting user — BYOK bucket when
    // their own key paid for it, same as the PR-metadata call.
    if (meta.usage && userId != null && pool) {
      const costCents = llm.estimateCostCents(meta.usage, meta.model);
      await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
    }

    return persistTitle({ pool, session, title: meta.title, send });
  })().catch((err) => {
    log.warn('session-title', 'Title generation failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    // #2500: an unavailable helper model used to leave the session showing
    // its branch name forever. Name it deterministically instead — for an
    // issue-started session that is the issue title, which is the same name
    // deterministicPrMetadataDraft will give the pull request. Only for a
    // session that has no name yet: a refresh must never trade a generated
    // title for a worse one just because this call failed.
    if (!session || session.session_title) return null;
    const fallback = deterministicTitle(issue || prepared.requests[0]);
    if (!fallback) return null;
    return persistTitle({ pool, session, title: fallback, send }).catch(() => null);
  });
}

// Hook 1 — first interactive message: only a brand-new session (no
// title yet, no PR) gets named from its opening ask. Existing untitled
// sessions also land here on their next message, which is the
// backfill story for pre-#249 rows.
function maybeTitleFirstMessage({ pool, session, message, userId, apiKey, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  const requests = [String(message || '').trim()].filter(Boolean);
  if (!requests.length) return Promise.resolve(null);
  return generateAndApply({ pool, session, requests, specs: [], userId, apiKey, send });
}

// Hook 1, OpenRouter flavour (#1949) — same entry conditions as
// maybeTitleFirstMessage (untitled, no PR), but no model call and no
// payer to resolve. Reads the session's FIRST user message rather than
// trusting the turn's own: a session whose opening turn was refused
// (worker busy) or stopped is still named from its opening ask on the
// next one, and — since deterministicPrMetadataDraft titles the PR from
// the first request too — the name the session shows now is the one it
// keeps when the PR lands. The turn's `message` is the fallback when no
// row comes back. Fire-and-forget like its siblings: always resolves.
function titleFromFirstMessage({ pool, session, message, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  return (async () => {
    const { rows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC LIMIT 1`,
      [session.id]
    );
    const title = deterministicTitle((rows[0] && rows[0].content) || message);
    if (!title) return null;
    return persistTitle({ pool, session, title, send });
  })().catch((err) => {
    log.warn('session-title', 'First-message title failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 2 — pre-PR turn-end refresh: re-title from everything known so
// far (every user message plus the live spec draft). Callers gate on
// "no PR yet" and "didn't already title this turn"; the UPDATE guard
// above covers the race where a PR landed mid-generation.
function refreshFromHistory({ pool, session, userId, apiKey, send }) {
  return (async () => {
    const { rows: reqRows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC`,
      [session.id]
    );
    const { rows: csRows } = await pool.query(
      `SELECT spec_md FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const specMd = ((csRows[0] && csRows[0].spec_md) || '').trim();
    return generateAndApply({
      pool, session,
      requests: reqRows.map((r) => r.content).filter(Boolean),
      specs: specMd ? [specMd] : [],
      userId, apiKey, send,
    });
  })().catch((err) => {
    log.warn('session-title', 'Turn-end title refresh failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 3 (#2500) — the single turn-end entry point every in-platform
// session now shares, Claude and OpenRouter alike. It owns the one decision
// the route used to make inline: which of the hooks above to run, and what
// to do when there is no payer for the helper model.
//
// `resolveBilling` is injected rather than imported so this stays a pure
// decision with no opinion about how a payer is found. Its refusal — an
// `error` on the result, or a throw — is no longer the end of the matter:
// a session with no payer gets the payer-free deterministic name, which for
// an issue-started session is the issue title, instead of showing its branch
// name forever.
//
// `firstTurn` picks the cheaper first-message path; anything else re-titles
// from the full history. Fire-and-forget like its siblings: the returned
// promise always resolves.
function titleAtTurnEnd({ pool, session, message, userId, resolveBilling, firstTurn, send }) {
  if (!session || session.pr_number) return Promise.resolve(null);
  const deterministic = () => titleFromFirstMessage({ pool, session, message, send });
  return Promise.resolve()
    .then(() => (resolveBilling ? resolveBilling() : { error: 'no_resolver' }))
    .then((billing) => {
      if (!billing || billing.error) {
        log.info('session-title', 'Turn-end title: no payer, using the deterministic name', {
          sessionId: session.id, reason: (billing && billing.reason) || null,
        });
        return deterministic();
      }
      return firstTurn
        ? maybeTitleFirstMessage({
          pool, session, message, userId, apiKey: billing.apiKey, send,
        })
        : refreshFromHistory({
          pool, session, userId, apiKey: billing.apiKey, send,
        });
    })
    .catch((err) => {
      log.warn('session-title', 'Turn-end title billing resolve failed', {
        sessionId: session.id, err: err.message,
      });
      return deterministic();
    });
}

module.exports = {
  headlessTitle, deterministicTitle, generateAndApply,
  maybeTitleFirstMessage, titleFromFirstMessage, refreshFromHistory,
  titleAtTurnEnd, parseIssueSeed, titleInputsFromRequests,
};
