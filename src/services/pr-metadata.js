'use strict';

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');
const github = require('./github');
const turnEffects = require('./turn-effects');
const sessionTitles = require('./session-title');
const { visualHeadForSession } = require('./pr-vote-revision');

// Coerce an arbitrary array of "issue numbers" into a clean, deduped,
// ascending list of positive integers (#75). Defensive against malformed
// input from the Mayor's tool call or stale DB rows: anything that isn't a
// positive integer (NaN, <= 0, floats, strings, null) is silently dropped.
// Number() (not parseInt) is used so "75abc"/"75.5" don't sneak through.
function sanitizeIssueNumbers(arr) {
  if (!Array.isArray(arr)) return [];
  const set = new Set();
  for (const v of arr) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// Build the GitHub closing-keyword block for a PR body: one `Closes #N`
// line per issue, already sanitized + sorted. Empty string when there are
// no linked issues, so the body is byte-identical to the legacy output.
function buildClosingBlock(issues) {
  return sanitizeIssueNumbers(issues).map((n) => `Closes #${n}`).join('\n');
}

// Apply one dispatch's issue declarations (#733) to a session's existing
// linked set: union the additions in, then subtract the removals. A number
// listed in both lists in the same call is REMOVED — removal is the
// deliberate corrective action (a stale `Closes #N` silently closes a
// still-open issue on merge, while re-adding later is cheap). Removing a
// number that was never linked is a harmless no-op, and there are no
// tombstones: a later addition may re-link a previously removed number.
// Returns a sanitized (deduped, ascending) array.
function applyIssueDeclarations(existing, adds, removes) {
  const removed = new Set(sanitizeIssueNumbers(removes));
  return sanitizeIssueNumbers([
    ...sanitizeIssueNumbers(existing),
    ...sanitizeIssueNumbers(adds),
  ]).filter((n) => !removed.has(n));
}

// Strip the platform-format `Closes #N` line for each given number from a
// PR body (#733): the targeted patch that keeps an already-open PR's
// closing block truthful after a mid-session scope cut, without the
// full-body regeneration (and LLM call) a build turn performs. Only exact
// platform-emitted lines are touched — the whole line must be `Closes #N`
// with optional trailing whitespace, and its newline is consumed — so
// hand-written variants ("Fixes #166", prose like "see #166") and longer
// numbers sharing a prefix (#1660 vs #166) are left alone.
function stripClosingLines(body, numbers) {
  if (typeof body !== 'string' || !body) return typeof body === 'string' ? body : '';
  let out = body;
  for (const n of sanitizeIssueNumbers(numbers)) {
    out = out.replace(new RegExp(`^Closes #${n}[ \\t]*(?:\\r?\\n|$)`, 'gm'), '');
  }
  return out;
}

// Build the deterministic "How to test" section for a PR body (#127) from
// the session's bot-emitted testing guidance (chat_sessions.testing_md /
// testing_path, parsed by services/testing-notes.js). Like the closing
// block, this is assembled in code and deliberately NOT fed into the LLM
// prompt, so the model can never drop or paraphrase it. Empty string when
// the session carries no guidance, keeping legacy bodies byte-identical.
function buildTestingBlock(testingMd, testingPath) {
  const md = typeof testingMd === 'string' ? testingMd.trim() : '';
  const path = typeof testingPath === 'string' ? testingPath.trim() : '';
  if (!md && !path) return '';
  const parts = ['## How to test'];
  if (md) parts.push(md);
  if (path) parts.push(`Deep link: \`${path}\``);
  return parts.join('\n\n');
}

// HTML-comment markers wrapping the deterministic "Before / after" visuals
// section (#195) so it can be idempotently replaced — both by the suffix
// assembly below (full-body regeneration on a dev turn) and by the targeted
// post-capture body patch in src/services/visuals.js.
const VISUALS_MARKER_START = '<!-- usernode:visuals -->';
const VISUALS_MARKER_END = '<!-- /usernode:visuals -->';
const EVIDENCE_MARKER_START = '<!-- usernode:visual-evidence -->';
const EVIDENCE_MARKER_END = '<!-- /usernode:visual-evidence -->';

function safeMarkdownText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
    .replace(/@/g, '@\u200b')
    .replace(/[\\`*_[\]()<>]/g, '\\$&');
}

// Protected visual evidence is reviewed in Homeroom, never embedded through
// GitHub's public image proxy. The block names the claims and links to the
// authenticated proposal surface; its wording intentionally does not cache a
// run state that could become false on the next pushed commit.
function buildEvidenceBlock({ intent, appSlug, sessionId, domain }) {
  if (!intent || typeof intent !== 'object' || !appSlug || !domain
      || !Number.isInteger(Number(sessionId)) || Number(sessionId) <= 0) return '';
  const claims = Array.isArray(intent.stories)
    ? intent.stories.slice(0, 3).map((story) => safeMarkdownText(story?.claim)).filter(Boolean)
    : [];
  if (intent.impact !== 'none' && !claims.length) return '';
  const url = `https://${domain}/#app/${encodeURIComponent(appSlug)}/dev/proposals/${Number(sessionId)}`;
  const lines = [EVIDENCE_MARKER_START, '## Visual change preview', ''];
  if (intent.impact === 'none') {
    lines.push(`No user-visible change declared: ${safeMarkdownText(intent.rationale, 1000)}`, '');
  } else {
    for (const claim of claims) lines.push(`- ${claim}`);
    lines.push('');
  }
  lines.push(
    `[Review the current exact-revision visual change preview in Homeroom](${url})`,
    '',
    '_The visual change preview is authenticated and revision-scoped; protected images are not embedded in this public PR body._',
    EVIDENCE_MARKER_END
  );
  return lines.join('\n');
}

function upsertEvidenceBlock(body, block) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(EVIDENCE_MARKER_START);
  const end = base.indexOf(EVIDENCE_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const head = base.slice(0, start).replace(/\n+$/, '');
    const tail = base.slice(end + EVIDENCE_MARKER_END.length).replace(/^\n+/, '');
    return [head, block, tail].filter((part) => part && part.trim()).join('\n\n');
  }
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

function extractEvidenceBlock(body) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(EVIDENCE_MARKER_START);
  const end = base.indexOf(EVIDENCE_MARKER_END);
  if (start === -1 || end === -1 || end <= start) return '';
  return base.slice(start, end + EVIDENCE_MARKER_END.length);
}

// Normalize the visuals argument to an ordered list of capture groups
// (#270). Accepts BOTH the grouped shape from visuals.getForSession —
// { captures: [ { index, path, before, after } ] } — and the legacy flat
// shape { before: {png,webm,gif}, after: {...}, capturedPath } so already-
// stored / older-callsite visuals still render. Returns [] when there's
// nothing usable.
function visualGroups(visuals) {
  if (!visuals || typeof visuals !== 'object') return [];
  if (Array.isArray(visuals.captures)) return visuals.captures;
  if (visuals.before || visuals.after) {
    return [{ index: 0, path: visuals.capturedPath || '/', before: visuals.before || null, after: visuals.after || null }];
  }
  return [];
}

// Build the deterministic "Before / after" section for a PR body (#195,
// #270) from the session's stored capture artifacts. A proposal can point
// its screenshots at a short ordered list of routes, so this emits one
// labelled "Before / after — `<path>`" table per capture group. Per side
// we embed the GIF when one was stored (GitHub camo proxies + autoplays
// GIFs inline), falling back to the PNG when the GIF was skipped or
// over-cap. webm is never referenced here — GitHub PR bodies can only
// inline-embed images; the webm exists for the in-app <video> surfaces.
//
// Byte-identical to the pre-#270 output for the common single-group-at-`/`
// case: that one group renders as "## Before / after" with no path suffix.
// Empty string when there is nothing usable to show (no group with an
// "after"), keeping legacy bodies identical.
function buildVisualsBlock(visuals, domain) {
  if (!domain) return '';
  const groups = visualGroups(visuals);
  const embed = (v) => {
    if (!v) return null;
    const id = v.gif || v.png;
    return id ? `https://${domain}/visuals/${id}` : null;
  };

  // Only groups with a usable "after" produce output.
  const usable = [];
  for (const g of groups) {
    const after = embed(g.after);
    if (!after) continue;
    usable.push({
      path: g.path || '/',
      viewport: g.viewport === 'mobile' ? 'mobile' : null,
      before: embed(g.before),
      after,
      // The "before" side was actually shot at '/' because this route
      // didn't exist on production yet — captioned below so the pair
      // doesn't read as a mismatched comparison.
      beforeFellBack: g.beforeFellBack === true,
    });
  }
  if (!usable.length) return '';

  // Single DESKTOP group at the app root → the legacy heading with no
  // suffix, so existing PR bodies stay byte-identical. Otherwise label
  // each group with its captured path so reviewers know which screen each
  // pair shows — plus "(mobile)" for a group shot in the phone-sized
  // frame (#768), which also forces the label onto a lone root group.
  const single = usable.length === 1
    && (usable[0].path === '/' || !usable[0].path)
    && !usable[0].viewport;

  const lines = [VISUALS_MARKER_START];
  usable.forEach((g, i) => {
    if (i > 0) lines.push('');
    if (single) {
      lines.push('## Before / after', '');
    } else {
      lines.push(`### Before / after: \`${g.path}\`${g.viewport === 'mobile' ? ' (mobile)' : ''}`, '');
    }
    if (g.before) {
      lines.push(
        '| Before | After |',
        '| --- | --- |',
        `| ![Before](${g.before}) | ![After](${g.after}) |`
      );
      if (g.beforeFellBack) {
        lines.push(
          '',
          '_"Before" shows the production home page, because this route didn\'t exist in production yet._'
        );
      }
    } else {
      lines.push(
        '| After |',
        '| --- |',
        `| ![After](${g.after}) |`,
        '',
        '_No production version to compare, so this shows the staging preview only._'
      );
    }
  });
  lines.push(VISUALS_MARKER_END);
  return lines.join('\n');
}

// Replace the marker-delimited visuals block inside an existing PR body,
// or append it when no markers are present yet. Used by the post-capture
// targeted patch (visuals.js) — the dev-turn path regenerates the whole
// body instead and includes the block via the suffix assembly.
function upsertVisualsBlock(body, block) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(VISUALS_MARKER_START);
  const end = base.indexOf(VISUALS_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const head = base.slice(0, start).replace(/\n+$/, '');
    const tail = base.slice(end + VISUALS_MARKER_END.length).replace(/^\n+/, '');
    const parts = [head, block, tail].filter((p) => p && p.trim());
    return parts.join('\n\n');
  }
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

// The marker-delimited visuals block as it stands in a body, or '' when the
// body carries none (#1323). upsertVisualsBlock can REPLACE that block, but a
// caller rewriting the prose around it first has to lift it out — otherwise
// rewriting a description silently drops the before/after screenshots the
// group is voting on.
function extractVisualsBlock(body) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(VISUALS_MARKER_START);
  const end = base.indexOf(VISUALS_MARKER_END);
  if (start === -1 || end === -1 || end <= start) return '';
  return base.slice(start, end + VISUALS_MARKER_END.length);
}

async function syncEvidencePrBlock(pool, sessionId) {
  if (!pool || !Number.isInteger(Number(sessionId)) || Number(sessionId) <= 0) return { updated: false, reason: 'invalid_session' };
  const { rows } = await pool.query(
    `SELECT cs.id, cs.source, cs.pr_number, cs.pr_body, cs.visual_evidence_detail,
            a.slug AS app_slug, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [Number(sessionId)]
  );
  const session = rows[0];
  if (!session || !session.pr_number || session.source === 'imported') {
    return { updated: false, reason: session?.source === 'imported' ? 'imported_pr' : 'missing_pr' };
  }
  const detail = session.visual_evidence_detail;
  const intent = detail && typeof detail === 'object' ? detail.intent : null;
  const block = buildEvidenceBlock({
    intent,
    appSlug: session.app_slug,
    sessionId: Number(session.id),
    domain: require('./caddy').USERNODE_DOMAIN,
  });
  if (!block) return { updated: false, reason: 'missing_intent' };
  // Enrollment in evidence v2 retires the public legacy image embed for this
  // proposal. Historical artifact rows may remain during rollout, but the PR
  // carries only the authenticated evidence link from now on.
  const withoutLegacy = upsertVisualsBlock(session.pr_body || '', '');
  const nextBody = upsertEvidenceBlock(withoutLegacy, block);
  if (nextBody === (session.pr_body || '')) return { updated: false, reason: 'unchanged' };
  const match = String(session.repo_url || '').match(/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) return { updated: false, reason: 'invalid_repo' };
  await github.updatePR(match[1], match[2], session.pr_number, { body: nextBody });
  await pool.query(
    `UPDATE chat_sessions
        SET pr_body = $2, pr_visuals_applied = NULL
      WHERE id = $1`,
    [Number(session.id), nextBody]
  );
  return { updated: true, block };
}

// Extract the issue numbers a PR body declares it closes via GitHub's
// closing keywords (close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved), optionally followed by a colon, e.g. "Closes #75", "fixed: #80".
// Returns a sanitized (deduped, sorted, positive-int) list. Used by the
// migrate-time backfill to recover linked_issues for PRs whose bodies carry
// closing keywords but predate the #75 linkage plumbing. Cross-repo
// references ("owner/repo#12") are deliberately ignored — linked_issues only
// models same-repo issues, which is all the pill renders.
function parseClosingKeywords(body) {
  if (typeof body !== 'string' || !body) return [];
  const re = /(?<![A-Za-z0-9_/-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)\b/gi;
  const found = [];
  let m;
  while ((m = re.exec(body)) !== null) found.push(Number(m[1]));
  return sanitizeIssueNumbers(found);
}

// Order-independent equality for two sanitized issue-number lists.
function sameIssueSet(a, b) {
  const x = sanitizeIssueNumbers(a);
  const y = sanitizeIssueNumbers(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

// Generate a PR title + body from the user's latest message and
// Claude Code's own summary of what it built. Shared by:
//  - the normal dev-turn path in routes/sessions.js (SSE-backed)
//  - the orphan-recovery path in server.js (runs after a mid-flight
//    nodemon/server restart adopts an in-progress worker)
//
// Returns `{ title, body, fallback, usage?, model? }`. Never throws —
// falls back to the legacy template so PR creation is never blocked on
// LLM availability. `fallback` is true when the template fired (LLM
// disabled or the API call failed): applyPrMetadata persists it to
// chat_sessions.pr_title_fallback so the title-heal sweeper
// (services/title-heal.js) can regenerate later and the UI can mark the
// placeholder. `usage` is undefined on the fallback path (no API call
// was made) so callers can skip debiting in that case.
function fallbackPrMetadataDraft(username) {
  return {
    title: `${username}'s changes`,
    body: '',
    summary: '',
    fallback: true,
  };
}

// Bounds for the deterministic cumulative summary below (#2433). This path
// has no model to compress a long branch with, so the record is bounded by
// construction: the most recent DETERMINISTIC_SUMMARY_TURNS updates, each
// clipped to DETERMINISTIC_SUMMARY_PER_TURN characters. 12 × 1000 keeps the
// assembled PR body an order of magnitude inside GitHub's 65,536-character
// ceiling even with the deterministic testing/visuals/closing suffix on top,
// and the omitted-count line below keeps an over-long branch honest about it.
const DETERMINISTIC_SUMMARY_TURNS = 12;
const DETERMINISTIC_SUMMARY_PER_TURN = 1000;

// The whole proposal's record, oldest-first, as the deterministic stand-in for
// the model path's cumulative prose (#2433). Every turn's coding-agent summary
// is kept and labelled, because this text is what the About sheet shows as
// "What changes for you" and what leads the PR body: a follow-up turn that
// replaced it with its own summary alone described the last iteration rather
// than the change the group is voting on.
//
// `summaries` already carries the in-flight turn (gatherSessionContext appends
// it), so `ccSummary` is only a fallback for callers that pass the current turn
// on its own — and is deduped against the tail when both arrive.
//
// A single-update branch renders exactly as it did before the labels existed:
// its lone summary, untouched, so the overwhelmingly common first-turn PR body
// stays byte-identical.
function cumulativeDeterministicSummary(summaries, ccSummary) {
  const list = (Array.isArray(summaries) ? summaries : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const cur = String(ccSummary || '').trim();
  if (cur && list[list.length - 1] !== cur) list.push(cur);
  if (list.length <= 1) return list[0] || '';

  const kept = list.slice(-DETERMINISTIC_SUMMARY_TURNS);
  const dropped = list.length - kept.length;
  const parts = kept.map((text, i) => {
    const clipped = text.length > DETERMINISTIC_SUMMARY_PER_TURN
      ? `${text.slice(0, DETERMINISTIC_SUMMARY_PER_TURN - 1).trimEnd()}…`
      : text;
    // Numbered from the turn's real position on the branch, so the labels
    // still line up when the oldest updates fall outside the cap.
    return `**Update ${dropped + i + 1}**\n\n${clipped}`;
  });
  if (dropped) {
    parts.unshift(`_${dropped} earlier update${dropped === 1 ? '' : 's'} not shown._`);
  }
  return parts.join('\n\n');
}

// OpenRouter sessions must not buy a hidden Anthropic call just to name a
// pull request after their selected model has finished. Build stable metadata
// from the session's own requests and model-authored summaries instead. The
// first request owns the title for the life of the PR; later turns refresh the
// body without renaming the change after whichever follow-up happened last.
// This is also the over-budget path for a Claude session (applyPrMetadata's
// `allowModelGeneration` is false when no payer resolves), so the cumulative
// summary is not an OpenRouter-only concern.
function deterministicPrMetadataDraft({ userMessage, ccSummary, requests, summaries, username }) {
  const titleSource = (Array.isArray(requests) && requests.find((item) => typeof item === 'string' && item.trim()))
    || userMessage
    || ccSummary
    || `${username || 'User'}'s changes`;
  // The same trim names the session before its PR exists (#1949,
  // session-title.js), so the display name holds when the PR lands — and
  // since #2500 that trim peels the issue card's "Please implement GitHub
  // issue #N: …" scaffolding off first, so neither name is the instruction
  // to make the change rather than the change.
  const title = sessionTitles.deterministicTitle(titleSource)
    || `${username || 'User'}'s changes`;
  return {
    title,
    body: '',
    summary: cumulativeDeterministicSummary(summaries, ccSummary),
    fallback: false,
  };
}

// Keep the paid, non-deterministic provider result separate from the suffixes
// derived from current session state. Durable turns receipt this draft once;
// recovery can then re-render fresh issue/testing/visual blocks without buying
// another model call or replaying stale deterministic metadata.
async function generatePrMetadataDraft({ userMessage, ccSummary, requests, summaries, specs, username, apiKey, telemetryContext }) {
  const fallback = fallbackPrMetadataDraft(username);

  // When the caller passes a user's own key (BYOK, #30) we can hit the
  // Anthropic API even if the server has no admin key configured, so
  // check isEnabled only as a fallback guard.
  if (!apiKey && !llm.isEnabled()) return fallback;

  try {
    const meta = await llm.generatePrMetadata({
      userRequest: userMessage,
      ccSummary,
      requests,
      summaries,
      specs,
      username,
      apiKey,
      telemetryContext,
    });
    return {
      title: meta.title,
      body: meta.body,
      summary: typeof meta.summary === 'string' ? meta.summary.trim() : '',
      fallback: false,
      usage: meta.usage,
      model: meta.model,
    };
  } catch (err) {
    log.warn('pr-metadata', 'Generation failed; using fallback', { err: err.message });
    return fallback;
  }
}

function renderPrMetadataDraft(draft, {
  username, closingBlock, testingBlock, visualsBlock, evidenceBlock,
}) {
  // `closingBlock` (#75) is the deterministic `Closes #N` text,
  // `testingBlock` (#127) the deterministic "How to test" section, and
  // `visualsBlock` (#195) the "Before / after" media table. All are
  // inserted between the body and the footer (testing first, closing last)
  // and are deliberately NOT fed into the LLM prompt below, so the model
  // can never drop, duplicate, or paraphrase them.
  const suffix = (testingBlock ? `\n\n${testingBlock}` : '')
    + (evidenceBlock ? `\n\n${evidenceBlock}` : '')
    + (visualsBlock ? `\n\n${visualsBlock}` : '')
    + (closingBlock ? `\n\n${closingBlock}` : '');
  const safeDraft = draft && typeof draft === 'object'
    ? draft
    : fallbackPrMetadataDraft(username);
  if (safeDraft.fallback) {
    return {
      ...safeDraft,
      title: safeDraft.title || `${username}'s changes`,
      body: `Dev session by ${username} via Homeroom${suffix}`,
      summary: '',
      fallback: true,
    };
  }

  // Plain-language user-facing summary (optional). Prepend it as the very
  // first paragraph of the PR body — before the model's bullets and before
  // the deterministic testing/visuals/closing suffix and the footer — so
  // the GitHub PR literally leads with the user-facing explanation.
  const summary = typeof safeDraft.summary === 'string' ? safeDraft.summary.trim() : '';
  const bodyWithSummary = summary ? `${summary}\n\n${safeDraft.body}` : safeDraft.body;
  return {
    ...safeDraft,
    summary,
    body: `${bodyWithSummary}${suffix}\n\n---\n_Dev session by ${username} via Usernode_`,
    fallback: false,
  };
}

async function generatePrMetadata(args) {
  const draft = await generatePrMetadataDraft(args);
  return renderPrMetadataDraft(draft, args);
}

// Pull the full per-turn history for a session so the PR title/body can
// reflect every update on the branch, not just the latest turn (#26):
//  - `requests`:  every user-role message, chronological. The current
//                 turn's message is already persisted (sessions.js inserts
//                 it before the worker runs), so it's included here.
//  - `summaries`: each completed turn's coding-agent summary, persisted as
//                 a system row with metadata.ccOutput. The CURRENT turn's
//                 summary is NOT yet persisted when this runs, so callers
//                 pass it separately and we append it as the final entry.
//  - `specs`:     the session's spec doc(s) — the Mayor-maintained markdown
//                 that captures overall intent. Includes the live draft
//                 (chat_sessions.spec_md) plus any saved snapshots
//                 (chat_session_specs), since a single chat can carry more
//                 than one distinct spec (#27). Deduped, oldest-first.
//                 Used as a THEME signal: it describes intended scope (which
//                 may run ahead of what's actually built), so the prompt
//                 leans on requests/summaries for the concrete changes.
async function gatherSessionContext(pool, sessionId, currentCcSummary) {
  const ctx = {
    requests: [], summaries: [], specs: [], linkedIssues: [], appliedIssues: [],
    testingMd: null, testingPath: null, appliedTesting: null,
    visuals: null, appliedVisuals: null,
    visualEvidenceDetail: null, appSlug: null, currentPrBody: null,
    appliedSummary: null,
  };
  if (pool && sessionId != null) {
    try {
      const { rows } = await pool.query(
        `SELECT role, content, metadata FROM chat_session_messages
           WHERE session_id = $1
             AND (role = 'user'
                  OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL)
                  OR (role = 'assistant' AND metadata->>'handoffSummary' = 'true'))
           ORDER BY id ASC`,
        [sessionId]
      );
      for (const row of rows) {
        if (row.role === 'user' && row.content) {
          ctx.requests.push(row.content);
        } else if (row.role === 'system' && row.metadata && row.metadata.ccOutput) {
          ctx.summaries.push(String(row.metadata.ccOutput));
        } else if (row.role === 'assistant' && row.metadata && row.metadata.handoffSummary && row.content) {
          // Native CLI handoffs upload durable, user-visible summaries —
          // never hidden reasoning or raw tool logs. Treat them exactly like
          // the coding-agent summaries produced by a web Dev session so lazy
          // PR creation has the full cross-surface implementation history.
          ctx.summaries.push(String(row.content));
        }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session history; using current turn only', { err: err.message, sessionId });
    }

    // Spec(s): saved snapshots (oldest-first) then the live draft. We dedupe
    // exact duplicates so an unchanged draft that was also "saved" doesn't
    // appear twice. Querying by session.id keeps both call sites (sessions.js
    // and the server.js orphan path) working without passing spec text in.
    try {
      const specTexts = [];
      const { rows: specRows } = await pool.query(
        `SELECT content FROM chat_session_specs WHERE session_id = $1 ORDER BY version ASC`,
        [sessionId]
      );
      for (const r of specRows) {
        const c = (r.content || '').trim();
        if (c) specTexts.push(c);
      }
      const { rows: liveRows } = await pool.query(
        `SELECT spec_md, linked_issues, pr_linked_issues_applied,
                testing_md, testing_path, pr_testing_applied,
                pr_visuals_applied, pr_summary_md, source,
                visual_evidence_detail, pr_body,
                (SELECT slug FROM apps WHERE id = chat_sessions.app_id) AS app_slug,
                imported_pr_head_sha, reviewed_head_sha,
                checks_commit_sha, handoff_head_sha
           FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      const live = (liveRows[0] && liveRows[0].spec_md ? String(liveRows[0].spec_md) : '').trim();
      if (live) specTexts.push(live);

      // Issue linkage (#75). Read from the DB by id so BOTH call sites
      // (sessions.js dev-turn and server.js orphan recovery) pick it up
      // regardless of what columns they SELECT'd onto the session object.
      ctx.linkedIssues = sanitizeIssueNumbers(liveRows[0] && liveRows[0].linked_issues);
      ctx.appliedIssues = sanitizeIssueNumbers(liveRows[0] && liveRows[0].pr_linked_issues_applied);

      // Testing guidance (#127) — same read-by-id rationale as above. The
      // dev-turn path persists testing_md/testing_path BEFORE calling
      // applyPrMetadata, so this always sees the current turn's block.
      ctx.testingMd = (liveRows[0] && liveRows[0].testing_md) || null;
      ctx.testingPath = (liveRows[0] && liveRows[0].testing_path) || null;
      ctx.appliedTesting = (liveRows[0] && liveRows[0].pr_testing_applied) || null;

      // The last visuals block written to the pull request (#195). This is
      // the drift marker, not evidence that its artifact rows still describe
      // the proposal's current head; that check happens below.
      ctx.appliedVisuals = (liveRows[0] && liveRows[0].pr_visuals_applied) || null;
      ctx.visualEvidenceDetail = (liveRows[0] && liveRows[0].visual_evidence_detail) || null;
      ctx.appSlug = (liveRows[0] && liveRows[0].app_slug) || null;
      ctx.currentPrBody = (liveRows[0] && liveRows[0].pr_body) || null;

      // Plain-language summary last written to pr_summary_md (the in-app
      // proposal view's source of truth). Read here so the drift gate below
      // can push a revised summary to GitHub on a title-unchanged turn.
      ctx.appliedSummary = (liveRows[0] && liveRows[0].pr_summary_md) || null;
      try {
        // Lazy require avoids the top-level visuals → pr-metadata cycle.
        // getForSession owns both grouping and the exact-head provenance
        // gate, so lazy PR creation cannot resurrect screenshots from the
        // proposal's previous commit.
        ctx.visuals = await require('./visuals').getForSession(
          pool, sessionId, visualHeadForSession(liveRows[0])
        );
      } catch (err) {
        log.warn('pr-metadata', 'Failed to gather session visuals', { err: err.message, sessionId });
      }

      const seen = new Set();
      for (const s of specTexts) {
        if (!seen.has(s)) { seen.add(s); ctx.specs.push(s); }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session specs', { err: err.message, sessionId });
    }
  }
  // Append the in-flight turn's summary (not yet persisted). Skip if it's
  // already the last entry (e.g. orphan-recovery may re-read a row).
  const cur = (currentCcSummary || '').trim();
  if (cur && ctx.summaries[ctx.summaries.length - 1] !== cur) {
    ctx.summaries.push(cur);
  }
  return ctx;
}

// Either open a new PR with the generated title/body, or update the
// existing PR's title/body on GitHub when it changed. Persists to DB
// and fires a broadcast callback so connected clients update in real
// time. Returns the resulting { prNumber, prUrl, prTitle } (or null
// if PR operations aren't possible: no repo, no github app, etc.).
//
// `userId` is the user the platform-side Haiku call is debited to.
// Both call sites already know it (sessions.js: req.user.id; server.js
// orphan recovery: session.user_id). When the fallback template fires
// (no API call) or BYOK is used, no debit happens.
async function applyPrMetadata({
  pool, session, repoOwner, repoName,
  userMessage, ccSummary, username,
  broadcast, apiKey, userId,
  effectTurnId = null,
  effectSessionId = null,
  effectBillingByok = !!apiKey,
  metadataMode = null,
  allowModelGeneration = true,
  // A title the AUTHOR explicitly submitted with the work (an external
  // agent's submit_work `title`, stored as chat_sessions.proposed_pr_title).
  // Used verbatim for the PR title instead of the generated one, and never
  // marked as a fallback — the title-heal sweeper must not overwrite a
  // deliberate name with a generated guess. The body is still generated as
  // usual. Passed by the lazy-PR call sites (promote, staging recovery,
  // title heal); the interactive turn path deliberately does NOT pass it —
  // a session that keeps evolving keeps its regenerating titles.
  preferredTitle = null,
}) {
  if (!repoOwner || !repoName) return null;

  // Build cumulative context across all of this PR's turns. Falls back to
  // the single current turn when no history is available.
  const {
    requests, summaries, specs, linkedIssues, appliedIssues,
    testingMd, testingPath, appliedTesting,
    visuals, appliedVisuals, appliedSummary,
    visualEvidenceDetail, appSlug, currentPrBody,
  } = await gatherSessionContext(pool, session && session.id, ccSummary);

  // Deterministic `Closes #N` block (#75), regenerated from the linked set
  // on every turn so it's always current and never doubled.
  const closingBlock = buildClosingBlock(linkedIssues);

  // Deterministic "How to test" section (#127), regenerated from the
  // session's latest testing guidance on every turn.
  const testingBlock = buildTestingBlock(testingMd, testingPath);

  // Deterministic "Before / after" media section (#195), regenerated from
  // the session's stored capture artifacts. Mostly relevant on the lazy-PR
  // path (headless → promote), where the capture ran long before the PR
  // exists; on the interactive path visuals.js patches the live body
  // directly after each capture instead.
  const evidenceIntent = visualEvidenceDetail && typeof visualEvidenceDetail === 'object'
    ? visualEvidenceDetail.intent : null;
  const evidenceBlock = buildEvidenceBlock({
    intent: evidenceIntent,
    appSlug: appSlug || session?.app_slug || session?.slug,
    sessionId: session?.id,
    domain: require('./caddy').USERNODE_DOMAIN,
  });
  // Enrollment in v2 retires public legacy image embeds. The authenticated
  // Homeroom link is safe for member/admin flows and always resolves the
  // current exact-revision status instead of caching a verdict in GitHub.
  const visualsBlock = evidenceIntent
    ? ''
    : buildVisualsBlock(visuals, require('./caddy').USERNODE_DOMAIN);

  const generationArgs = {
    userMessage, ccSummary, requests, summaries, specs, username, apiKey,
    telemetryContext: {
      pool,
      appId: session && session.app_id,
      sessionId: session && session.id,
    },
  };
  let meta;
  let metadataBillingByok = !!effectBillingByok;
  const deterministic = metadataMode === 'deterministic'
    || (metadataMode == null && session?.agent_backend === 'codex_openrouter');
  if (deterministic || (!allowModelGeneration && !effectTurnId)) {
    meta = renderPrMetadataDraft(
      deterministicPrMetadataDraft(generationArgs),
      { username, closingBlock, testingBlock, visualsBlock, evidenceBlock },
    );
  } else if (effectTurnId) {
    try {
      const effect = await turnEffects.runExternalEffectFailClosed({
        pool,
        turnId: effectTurnId,
        effectKey: turnEffects.EFFECT_KEYS.PR_METADATA_GENERATION,
        sessionId: effectSessionId || session.id,
        intent: { billingByok: metadataBillingByok },
        run: async () => ({
          draft: allowModelGeneration
            ? await generatePrMetadataDraft(generationArgs)
            : deterministicPrMetadataDraft(generationArgs),
          billingByok: allowModelGeneration && metadataBillingByok,
        }),
        // A pending receipt means an earlier process may already have paid
        // for generation. Fail closed to the deterministic title template;
        // the title-heal sweeper can improve it later without double-charging
        // this logical turn.
        fallback: (_err, pendingIntent) => ({
          draft: fallbackPrMetadataDraft(username),
          billingByok: !!pendingIntent?.billingByok,
        }),
      });
      const settled = effect.value && typeof effect.value === 'object'
        ? effect.value
        : {};
      metadataBillingByok = !!settled.billingByok;
      meta = renderPrMetadataDraft(settled.draft, {
        username, closingBlock, testingBlock, visualsBlock, evidenceBlock,
      });
    } catch (err) {
      // Receipt uncertainty must keep the durable tail owned. Swallowing it
      // would clear active_turn and make the paid effect unreconcilable.
      err.retainActiveTurn = true;
      throw err;
    }
  } else {
    meta = await generatePrMetadata({
      ...generationArgs, closingBlock, testingBlock, visualsBlock, evidenceBlock,
    });
  }
  const { title: generatedTitle, body: prBody } = meta;
  // An author-submitted title outranks the generated one (see the
  // preferredTitle note in the signature). Normalized the way the route
  // bounded it: trimmed, single-spaced, GitHub's title length.
  const chosenTitle = typeof preferredTitle === 'string'
    ? preferredTitle.trim().replace(/\s+/g, ' ').slice(0, 256)
    : '';
  const prTitle = chosenTitle || generatedTitle;
  // True when the title/body came from the fallback template (LLM
  // unavailable). Persisted to chat_sessions.pr_title_fallback so the
  // title-heal sweeper retries later and the UI marks the placeholder. A
  // preferred title is never a fallback: it is the author's own name for
  // the change, and the sweeper must leave it alone.
  const isFallback = chosenTitle ? false : !!meta.fallback;
  // Plain-language user-facing summary (optional, empty string when absent).
  // Stored to chat_sessions.pr_summary_md and rendered at the top of the
  // in-app proposal view; the same string already leads the PR body above.
  const prSummary = typeof meta.summary === 'string' ? meta.summary.trim() : '';

  // Whether the linked-issue set drifted from what's reflected in the live
  // PR body. Drives the existing-PR update gate below so a newly-linked
  // issue reaches GitHub even when the title is unchanged.
  const issuesChanged = !sameIssueSet(linkedIssues, appliedIssues);

  // Same drift check for the testing section (#127): compare the freshly
  // rendered block against the snapshot last written to the PR body, so new
  // or revised guidance reaches GitHub on a title-unchanged turn.
  const testingChanged = testingBlock !== (appliedTesting || '');

  // And for the visuals section (#195): a capture that landed since the
  // last body write must reach GitHub even on a title-unchanged turn.
  const visualsChanged = visualsBlock !== (appliedVisuals || '');

  const evidenceChanged = evidenceBlock !== extractEvidenceBlock(currentPrBody || session?.pr_body || '');

  // Same drift check for the plain-language summary: a revised summary must
  // reach the PR body on a title-unchanged turn (the summary leads the body),
  // so compare the freshly-generated value against what's stored in
  // pr_summary_md (the applied snapshot).
  const summaryChanged = prSummary !== (appliedSummary || '');

  // Debit the Haiku call to the session owner — into the BYOK bucket
  // when the user's own key paid for it (#119). The fallback-template
  // path produces no usage, which recordSpend treats as a no-op.
  if (meta.usage && userId != null && pool) {
    const costCents = llm.estimateCostCents(meta.usage, meta.model);
    if (effectTurnId) {
      try {
        await limits.settleTurnSpend(pool, userId, costCents, {
          turnByok: metadataBillingByok,
          turnId: effectTurnId,
          sessionId: effectSessionId || session.id,
          effectKey: turnEffects.EFFECT_KEYS.PR_METADATA_SPEND,
        });
      } catch (err) {
        err.retainActiveTurn = true;
        throw err;
      }
    } else {
      await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
    }
  }

  if (!session.pr_number) {
    // New PR path.
    try {
      const pr = await github.createPR(repoOwner, repoName, {
        branch: session.branch_name,
        title: prTitle,
        body: prBody,
      });
      session.pr_number = pr.number;
      session.pr_url = pr.html_url;
      session.pr_title = prTitle;
      // #249: once a PR exists its title owns the session's display
      // name — mirror it so every list shows one name everywhere.
      session.session_title = prTitle;
      session.pr_summary_md = prSummary || null;
      session.pr_title_fallback = isFallback;
      // #1333. Mirror the body too. get_proposal reports it as `description`
      // — what the group is actually voting on — and #1323 wired only the
      // author's own update, so every proposal read back null until somebody
      // happened to send one.
      session.pr_body = prBody || null;
      await pool.query(
        `UPDATE chat_sessions SET pr_number = $1, pr_url = $2, pr_title = $3, session_title = $3, pr_linked_issues_applied = $4, pr_testing_applied = $5, pr_visuals_applied = $6, pr_summary_md = $7, pr_title_fallback = $8, pr_body = $9 WHERE id = $10`,
        [pr.number, pr.html_url, prTitle, linkedIssues, testingBlock || null, visualsBlock || null, prSummary || null, isFallback, prBody || null, session.id]
      );
      if (broadcast) broadcast('pr_created', { prNumber: pr.number, prUrl: pr.html_url, prTitle });
      return { prNumber: pr.number, prUrl: pr.html_url, prTitle };
    } catch (err) {
      // 422 "A pull request already exists for <branch>": the PR is real
      // but this session row never learned its number — the restart race
      // (the old process created the PR on GitHub and died before the DB
      // write landed; session 2262, 2026-07-14). Every later createPR
      // 422s forever, wedging staging recovery AND user-driven promotion
      // ("Could not create the pull request... Please retry" in a loop).
      // Heal by adopting the existing open PR: persist its number/url and
      // fall through to the existing-PR update path below, which brings
      // the title/body up to date exactly as a normal turn would.
      if (err && err.code === 'pr_exists') {
        let existing = null;
        try {
          existing = await github.findOpenPrByBranch(repoOwner, repoName, session.branch_name);
        } catch (lookupErr) {
          log.warn('pr-metadata', 'Existing-PR lookup failed after pr_exists', {
            sessionId: session.id, err: lookupErr.message,
          });
        }
        if (!existing) {
          // 422 said it exists but the lookup can't see it (closed in the
          // interim, or a transient API failure) — stay best-effort.
          log.warn('pr-metadata', 'PR exists on GitHub but could not be adopted', {
            sessionId: session.id, branch: session.branch_name,
          });
          return null;
        }
        session.pr_number = existing.number;
        session.pr_url = existing.html_url;
        // Adopt GitHub's current title as the known-applied title so the
        // update gate below compares against reality (and #249's mirror
        // keeps the session display name consistent in the meantime).
        session.pr_title = existing.title || null;
        session.session_title = existing.title || session.session_title;
        // #1333. Adopting a PR adopts its body as well — the row is learning
        // what is already on GitHub, and the description is part of that.
        session.pr_body = existing.body || null;
        await pool.query(
          `UPDATE chat_sessions SET pr_number = $1, pr_url = $2, pr_title = $3, session_title = COALESCE($3, session_title), pr_body = $4 WHERE id = $5`,
          [existing.number, existing.html_url, existing.title || null, existing.body || null, session.id]
        );
        log.info('pr-metadata', 'Adopted existing PR after pr_exists', {
          sessionId: session.id, prNumber: existing.number, branch: session.branch_name,
        });
        if (broadcast) broadcast('pr_created', { prNumber: existing.number, prUrl: existing.html_url, prTitle: existing.title });
        // Fall through to the existing-PR path below.
      } else {
        // describeGithubError (not err.message): Octokit's RequestError
        // message is empty when GitHub answers with an empty body, which
        // logged a useless `{"err":""}` throughout the 2026-07-24 outage.
        const describe = github.describeGithubError
          || ((e) => ({ message: (e && e.message) || String(e) }));
        log.warn('pr-metadata', 'PR creation failed', {
          sessionId: session.id, code: err.code || null, ...describe(err),
        });
        // Re-throw the typed failures the caller can act on: 'no_commits'
        // (permanent — the branch has no pushed commits) and
        // 'github_unavailable' (GitHub-side outage — the user should wait,
        // not re-run their request). Other failures stay best-effort
        // (return null) as before.
        if (err && (err.code === 'no_commits' || err.code === 'github_unavailable')) throw err;
        return null;
      }
    }
  }

  // Fallback fired on an EXISTING PR: never downgrade. If the stored title
  // is already the fallback template (this turn's prTitle matches it), just
  // make sure the row is marked so the heal sweeper retries; if the PR
  // already carries a real generated title, keep it untouched — the
  // deterministic suffix drift (issues/testing/visuals) will catch up on
  // the next successful turn or heal pass rather than shipping a body
  // whose lead text is the fallback template.
  if (isFallback) {
    if (prTitle === session.pr_title && !session.pr_title_fallback) {
      session.pr_title_fallback = true;
      await pool.query(`UPDATE chat_sessions SET pr_title_fallback = TRUE WHERE id = $1`, [session.id]);
    }
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle: session.pr_title };
  }

  // Existing PR: hit GitHub if the title changed OR the linked-issue set
  // changed (#75) OR the testing guidance changed (#127) OR the visuals
  // set changed (#195) — these would otherwise be skipped on a
  // title-unchanged turn, leaving the new `Closes #N` line / "How to
  // test" / "Before / after" section off the PR body.
  if (prTitle === session.pr_title && !issuesChanged && !testingChanged && !visualsChanged
      && !evidenceChanged && !summaryChanged) {
    // Generation succeeded and landed on the same title — clear a stale
    // fallback marker if one is set (defensive; in practice a generated
    // title never equals the fallback template).
    if (session.pr_title_fallback) {
      session.pr_title_fallback = false;
      await pool.query(`UPDATE chat_sessions SET pr_title_fallback = FALSE WHERE id = $1`, [session.id]);
    }
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle: session.pr_title };
  }

  try {
    await github.updatePR(repoOwner, repoName, session.pr_number, {
      title: prTitle,
      body: prBody,
    });
    session.pr_title = prTitle;
    // #249: keep the session display name tracking the PR title.
    session.session_title = prTitle;
    session.pr_summary_md = prSummary || null;
    session.pr_title_fallback = false;
    await pool.query(
      `UPDATE chat_sessions SET pr_title = $1, session_title = $1, pr_linked_issues_applied = $2, pr_testing_applied = $3, pr_visuals_applied = $4, pr_summary_md = $5, pr_body = $6, pr_title_fallback = FALSE WHERE id = $7`,
      [prTitle, linkedIssues, testingBlock || null, visualsBlock || null, prSummary || null, prBody || null, session.id]
    );
    if (broadcast) broadcast('pr_updated', { prNumber: session.pr_number, prUrl: session.pr_url, prTitle });
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle };
  } catch (err) {
    log.warn('pr-metadata', 'PR title update failed', { err: err.message, sessionId: session.id });
    return null;
  }
}

module.exports = {
  generatePrMetadata, applyPrMetadata, deterministicPrMetadataDraft, sanitizeIssueNumbers,
  buildClosingBlock, buildTestingBlock, parseClosingKeywords,
  buildVisualsBlock, upsertVisualsBlock, extractVisualsBlock,
  buildEvidenceBlock, upsertEvidenceBlock, extractEvidenceBlock, syncEvidencePrBlock,
  applyIssueDeclarations, stripClosingLines, sameIssueSet,
};
