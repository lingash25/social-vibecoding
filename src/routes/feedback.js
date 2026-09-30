const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const log = require('../services/logger');
const llm = require('../services/llm');
const limits = require('../services/limits');
const github = require('../services/github');
const { announceIssueCreated, findAppByRepo } = require('../services/issue-announce');
const appAccess = require('../services/app-access');
const { placeBounty } = require('../services/bounties');
const { getPool } = require('../db/pool');
const { sniffImageType } = require('../services/attachments');
const { feedbackTitleLimiter, feedbackSubmitLimiter, issueScreenshotLimiter } = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// #683: feedback-modal screenshot attachments. Uploads are raw bytes
// (application/octet-stream — deliberately sidesteps the global 100 KB
// express.json() parser, same reasoning as dev-chat attachments), sniffed
// to PNG/JPEG by magic bytes, capped at 4 MB, and stored bytea-in-Postgres
// (issue_screenshots). At filing time POST /api/feedback links the row to
// the created issue and appends the public embed line the coding agents
// and GitHub's camo proxy can fetch (GET /issue-images/:id).
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_ID_RE = /^[a-f0-9]{32}$/;

// Pure (exported for tests): validate an uploaded screenshot body.
// Returns { ok: true, contentType } or { ok: false, error }.
function validateScreenshotUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: 'Empty upload' };
  }
  if (data.length > MAX_SCREENSHOT_BYTES) {
    return {
      ok: false,
      error: `Screenshot too large (max ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)} MB)`,
    };
  }
  const contentType = sniffImageType(data);
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
    return { ok: false, error: 'Screenshot must be a PNG or JPEG image' };
  }
  return { ok: true, contentType };
}

// Pure (exported for tests): the exact markdown suffix appended to the
// issue body for an attached screenshot.
function buildScreenshotEmbed(id, domain) {
  return `\n\n**Screenshot:**\n![Screenshot](https://${domain}/issue-images/${id})`;
}

// #3027: how many images one feedback submit may carry ("one before saving
// and one after saving", with room for a third). Enforced here, on the ids
// the server itself validates; the dialog's own limit is only a courtesy.
// Each image is still its own ≤4 MB upload under issueScreenshotLimiter, so
// this bounds the issue body and the per-submit lookup, not upload volume.
const MAX_SCREENSHOTS_PER_ISSUE = 3;

// Pure (exported for tests): the image ids a POST /api/feedback body asks to
// attach. `screenshotIds` is the array the dialog sends; `screenshotId` is
// the single id every client sent before #3027, which an outbox entry queued
// back then still carries — both are accepted and merged, and both count
// toward the one limit. The count is taken from the raw array BEFORE dedupe,
// so padding with repeats cannot slip a long array through, and no element
// is examined once the array is known to be too long.
// Returns { ok: true, ids } (deduped, in order) or { ok: false, error }.
function parseScreenshotIds(body) {
  const b = body || {};
  const ids = [];
  const tooMany = { ok: false, error: `You can attach at most ${MAX_SCREENSHOTS_PER_ISSUE} images` };
  if (b.screenshotIds !== undefined && b.screenshotIds !== null) {
    if (!Array.isArray(b.screenshotIds)) return { ok: false, error: 'screenshotIds must be an array' };
    if (b.screenshotIds.length > MAX_SCREENSHOTS_PER_ISSUE) return tooMany;
    for (const sid of b.screenshotIds) {
      if (typeof sid !== 'string' || !SCREENSHOT_ID_RE.test(sid)) {
        return { ok: false, error: 'Invalid screenshotId' };
      }
      ids.push(sid);
    }
  }
  if (b.screenshotId !== undefined && b.screenshotId !== null && b.screenshotId !== '') {
    if (typeof b.screenshotId !== 'string' || !SCREENSHOT_ID_RE.test(b.screenshotId)) {
      return { ok: false, error: 'Invalid screenshotId' };
    }
    ids.push(b.screenshotId);
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_SCREENSHOTS_PER_ISSUE) return tooMany;
  return { ok: true, ids: unique };
}

// Pure (exported for tests): the issue-body suffix for every attached image.
// One image keeps the exact pre-#3027 line, so an issue with one screenshot
// reads as it always has; several are numbered under one heading, in the
// order they were attached.
function buildScreenshotsEmbed(ids, domain) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  if (ids.length === 1) return buildScreenshotEmbed(ids[0], domain);
  const lines = ids.map((id, i) => `![Screenshot ${i + 1}](https://${domain}/issue-images/${id})`);
  return `\n\n**Screenshots:**\n${lines.join('\n')}`;
}

// #685: app-provided state snapshots ("Include app state" checkbox).
// The bridge caps the serialized snapshot at 32,768 chars client-side;
// 40,000 is a defensive server ceiling that keeps the JSON request body
// under the global 100 KB express.json() limit and the final issue body
// (description ≤ 2,000 chars + this) under GitHub's 65,536-char maximum.
const MAX_PAGE_STATE_CHARS = 40000;

// Pure (exported for tests): the collapsed <details> suffix appended to
// the issue body for an app-provided state snapshot. Four-backtick fence
// so snapshot content containing ``` can't break out of the block.
function buildPageStateEmbed(pageState, truncated) {
  const summary = `App state snapshot (provided by the app${truncated ? ', truncated' : ''})`;
  return `\n\n<details>\n<summary>${summary}</summary>\n\n\`\`\`\`json\n${pageState}\n\`\`\`\`\n</details>`;
}

// #1054: an offline-queued submit says when it was written. The client's
// outbox (public/js/feedback-queue.js) may hold a message for minutes or
// days, so "opened 3 minutes ago" on the GitHub issue would be a lie about
// when the bug was seen — and a maintainer reading a report about a screen
// that has since changed needs to know that.
//
// Client-asserted and therefore never trusted as data: it only ever adds one
// cosmetic body line, and anything implausible is SILENTLY dropped rather
// than failing the request. Losing the line costs a nicety; rejecting the
// request would lose the feedback the queue exists to protect.
//
// Pure (exported for tests). Returns the ISO-8601 UTC string to print, or
// null to print nothing:
//   * not a short string / unparseable    → null (garbage)
//   * in the future                       → null (clock skew ahead)
//   * less than a minute old              → null (a live submit; the issue's
//                                           own timestamp already says this)
//   * older than 90 days                  → null (a clock stuck in 1970, or a
//                                           queue nobody can still act on)
const MAX_QUEUED_AT_CHARS = 40;
const MIN_QUEUED_AT_AGE_MS = 60 * 1000;
const MAX_QUEUED_AT_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function normalizeQueuedAt(raw, nowMs) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_QUEUED_AT_CHARS) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const age = now - t;
  if (age < MIN_QUEUED_AT_AGE_MS) return null;
  if (age > MAX_QUEUED_AT_AGE_MS) return null;
  return new Date(t).toISOString();
}

// Derive `owner/repo` from a github.com URL. We do this at module
// load (well, at route-factory load) so a malformed
// USERNODE_PLATFORM_REPO fails the platform fast at startup rather
// than 500-ing the first time a user clicks "Send feedback".
function parseGitHubRepo(url) {
  const u = new URL(url);
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
    throw new Error(`Expected github.com URL, got: ${url}`);
  }
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Expected /<owner>/<repo> path, got: ${url}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

// #125 announce (cache seed + issue_update broadcast) lives in
// services/issue-announce.js — shared with the platform-issue draft
// confirm path in routes/sessions.js.

// #964: attach a kudos bounty to the issue this request just filed.
//
// Never throws and never rejects: the GitHub issue already exists by the time
// this runs, so a bounty problem must cost the user their pledge, never their
// written feedback. Every failure mode comes back as `{ placed: false, error }`
// for the modal to show beside the "Thanks! Filed against…" line.
//
// Deliberately skips the open-issue re-verification the standalone bounty
// route performs (routes/issues.js): the platform created this issue
// microseconds ago, so it is open by construction — asking GitHub again would
// only add a round-trip and a failure mode.
//
// `app` is the resolved target row for app-targeted feedback, or null for
// platform-targeted feedback (looked up by repo here, exactly as
// announceIssueCreated does, so the bounty and the issue_update address the
// same app).
async function attachBounty(pool, { app, owner, repo, issueNumber, user }) {
  try {
    const target = app || await findAppByRepo(pool, owner, repo);
    if (!target) {
      return { placed: false, issueNumber, error: "this repository isn't an app on this platform" };
    }
    // Bounties are a build-surface action, so they carry the same collab gate
    // the standalone route applies. Feedback itself has no such gate — a
    // collab-private app still accepts your issue, it just won't take your
    // pledge. checkAppAccess throws if the visibility columns are missing,
    // hence the ACCESS_COLUMNS re-select below/above at both call sites.
    const allowed = await appAccess.checkAppAccess(pool, target, user, 'collab');
    if (!allowed) {
      return { placed: false, issueNumber, error: 'you need collaborator access on this app to place a bounty' };
    }
    const result = await placeBounty(pool, { app: target, user, issueNumber });
    if (!result.ok) {
      return {
        placed: false,
        issueNumber,
        error: result.code === 'quota'
          ? 'weekly kudos allowance is spent'
          : result.error,
        remaining: result.remaining,
        limit: result.limit,
      };
    }
    return {
      placed: true,
      issueNumber,
      remaining: result.remaining,
      limit: result.limit,
    };
  } catch (err) {
    log.warn('feedback', 'Bounty attach failed', { issueNumber, message: err.message });
    return { placed: false, issueNumber, error: "couldn't place the bounty just now" };
  }
}

// A local receipt for a report that reached GitHub.
//
// The issue is still the real output; this row exists because the issue
// cannot answer the two questions the season's feedback challenge asks. It
// was filed by the platform's bot account, so GitHub does not know WHO on
// this platform wrote it, and reading every issue back over the API once a
// tick to find out would be absurd. Written only after the issue exists, so
// the scorer can never pay for feedback that reached nobody.
//
// Best-effort like the acknowledgement below it: the report is filed and the
// person has been helped, so a bookkeeping failure must not turn their
// submission into an error and invite a duplicate.
async function recordFeedbackReport(pool, { user, app, owner, repo, issueNumber, title, description }) {
  if (!user?.id) return;
  try {
    await pool.query(
      `INSERT INTO feedback_reports
         (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [user.id, app ? 'app' : 'platform', app ? app.id : null,
        owner || null, repo || null,
        Number.isSafeInteger(issueNumber) ? issueNumber : null,
        title ? String(title).slice(0, 512) : null, description]
    );
  } catch (err) {
    log.warn('feedback', 'Feedback report record failed', { issueNumber, message: err.message });
  }
}

// ── "Your feedback" (#3186) ─────────────────────────────────────────────
//
// GET /api/feedback/mine reads the caller's own feedback_reports back to
// them, newest first, with the status the Me screen's list shows. Scoped to
// `req.user.id` in the WHERE clause and nowhere else: there is no parameter
// that could ask for somebody else's rows.
//
// Two statuses, not three. "Received" is the row itself, which exists only
// once the GitHub issue was filed. "Counted" is a challenge credit the
// automatic scorer wrote for it: USEFUL_FEEDBACK names every credit
// `feedback:<report id>` in `metadata.source_key`
// (services/topochain/challenge-scorer.js), so the join below is exact.
// A "reviewed" state between them would need to know whether a maintainer
// closed or acted on the issue, and the platform keeps no durable record of
// that: an issue's open/closed state lives on GitHub and in a five-minute
// in-memory cache whose open list is truncated on a busy repo, so "missing
// from the open list" is not "closed". A status that is sometimes wrong is
// worse than one fewer status, so this says only what it can prove.
//
// The totals are window counts over the whole set, taken before the LIMIT,
// so the Me row's "4 sent · 1 counted" is true even when the list is capped.
const MY_FEEDBACK_LIMIT = 50;

const MY_FEEDBACK_SQL = `
  SELECT fr.id, fr.target, fr.title, fr.issue_owner, fr.issue_repo, fr.issue_number,
         fr.created_at, a.slug AS app_slug, a.name AS app_name,
         cr.points AS credited_points,
         COUNT(*) OVER () AS total_sent,
         COUNT(cr.source_key) OVER () AS total_counted
    FROM feedback_reports fr
    LEFT JOIN apps a ON a.id = fr.app_id
    LEFT JOIN (
      SELECT ua.metadata->>'source_key' AS source_key, SUM(ua.points) AS points
        FROM user_activities ua
       WHERE ua.user_id = $1
         AND ua.metadata->>'source_key' LIKE 'feedback:%'
       GROUP BY ua.metadata->>'source_key'
    ) cr ON cr.source_key = 'feedback:' || fr.id
   WHERE fr.user_id = $1
   ORDER BY fr.created_at DESC, fr.id DESC
   LIMIT $2
`;

// Platform feedback files into the platform repo, which is the self-hosted
// app's own repository, so its requests live on that app's board. Read once
// per request, and used only when its repo is the one the report went to.
const MY_FEEDBACK_SELF_APP_SQL = `
  SELECT slug, name, repo_url
    FROM apps
   WHERE self_hosted = TRUE
   ORDER BY id ASC
   LIMIT 1
`;

// Pure (exported for tests): whether `repoUrl` is github.com/<owner>/<repo>,
// with the case and `.git` tolerance findAppByRepo applies.
function repoMatches(repoUrl, owner, repo) {
  const [, o, r] = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!o || !r || !owner || !repo) return false;
  const norm = (s) => String(s).replace(/\.git$/, '').toLowerCase();
  return norm(o) === norm(owner) && norm(r) === norm(repo);
}

// Pure (exported for tests): the rows → the response body.
function shapeMyFeedback(rows, selfApp) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list[0] || {};
  const reports = list.map((r) => {
    const platform = r.target === 'platform';
    const onSelf = platform && !!selfApp && repoMatches(selfApp.repo_url, r.issue_owner, r.issue_repo);
    const n = Number(r.issue_number);
    const counted = r.credited_points != null;
    return {
      id: Number(r.id),
      title: r.title ? String(r.title) : null,
      target: platform ? 'platform' : 'app',
      appSlug: platform ? (onSelf ? selfApp.slug : null) : (r.app_slug || null),
      appName: platform ? 'Homeroom' : (r.app_name || r.app_slug || null),
      issueNumber: Number.isSafeInteger(n) && n > 0 ? n : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      status: counted ? 'counted' : 'received',
      points: counted ? Number(r.credited_points) || 0 : null,
    };
  });
  const sent = Number(first.total_sent) || 0;
  return {
    sent,
    counted: Number(first.total_counted) || 0,
    reports,
    ...(sent > reports.length ? { truncated: true } : {}),
  };
}

// Staging-only ?demo=1 rows. `feedback_reports` is staging:private, so a
// prod-cloned preview has none and the list could only ever show its empty
// state. These are four of the mock requests routes/issues.js serves on
// staging (stagingMockIssues), by number and title, so each row opens the
// very request it names; one is counted, so both statuses are on screen.
// REAL DATA WINS: a staging viewer who filed feedback sees their own rows.
const DEMO_FEEDBACK = [
  { issueNumber: 900006, days: 0, points: null, title: '[Mock] Voting buttons need a clearer disabled state' },
  { issueNumber: 900003, days: 2, points: 180, title: '[Mock] Topic cards overflow on narrow phones' },
  { issueNumber: 900002, days: 9, points: null, title: '[Mock] Add a keyboard shortcut for voting' },
  { issueNumber: 900001, days: 20, points: null, title: '[Mock] Dark mode toggle resets after refresh' },
];

// Pure (exported for tests): the ?demo=1 overlay.
function withDemoFeedback(body, selfApp, now = Date.now()) {
  if (!selfApp || body.sent > 0 || body.reports.length > 0) return body;
  const reports = DEMO_FEEDBACK.map((d, i) => ({
    id: -(i + 1),
    title: d.title,
    target: 'platform',
    appSlug: selfApp.slug,
    appName: 'Homeroom',
    issueNumber: d.issueNumber,
    createdAt: new Date(now - d.days * 86400000).toISOString(),
    status: d.points ? 'counted' : 'received',
    points: d.points,
  }));
  return {
    sent: reports.length,
    counted: reports.filter((r) => r.status === 'counted').length,
    reports,
    demo: true,
  };
}

// The issue already exists. A failed acknowledgement must never turn a
// successful submission into an error (and encourage a duplicate report).
async function firstFeedbackMoment(pool, { user, app, owner, repo, issueNumber }) {
  if (!user?.id || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET first_feedback_at = NOW()
        WHERE id = $1 AND first_feedback_at IS NULL
        RETURNING id`,
      [user.id]
    );
    if (!rows.length) return null;
    const moment = { userId: user.id, issueNumber, appSlug: null, canFix: false };
    // Use the repository that received the feedback, including platform
    // feedback sent while the user was looking at a different app.
    try {
      const target = app
        ? await appAccess.getAppForUser(pool, app.slug, user, 'view', appAccess.ACCESS_COLUMNS)
        : await findAppByRepo(pool, owner, repo);
      if (target && await appAccess.checkAppAccess(pool, target, user, 'view')) {
        moment.appSlug = target.slug;
        moment.canFix = await appAccess.checkAppAccess(pool, target, user, 'collab');
      }
    } catch (err) {
      log.warn('feedback', 'First-feedback destination unavailable', { message: err.message });
    }
    return moment;
  } catch (err) {
    log.warn('feedback', 'First-feedback acknowledgement failed', { message: err.message });
    return null;
  }
}

function feedbackRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const { owner: feedbackOwner, repo: feedbackRepo } = parseGitHubRepo(config.platformRepoUrl);

  // Feedback titles are small calls, but they are still billable. Resolve
  // the payer before every generation so neither the preview endpoint nor
  // repeated issue filing becomes a zero-credit platform-spend bypass.
  // Callers deliberately soft-degrade when this returns an error: feedback
  // submission itself must never depend on AI availability.
  const resolveTitleBilling = async (userId) => {
    if (!userId) return { error: 'credits' };
    const billing = await limits.resolveBillingPath(
      pool,
      config.dataEncryptionKey,
      userId
    );
    if (billing.error) return { error: 'credits' };
    return billing;
  };

  // #556: live title preview for the feedback modal. The FE debounces
  // calls while the user types the description and fills the editable
  // Title field with the result; whatever ends up in that field is what
  // POST /api/feedback below receives. Soft-degrades on every failure
  // mode — LLM unavailable or a failed generation is a 200 with
  // `title: null`, because an empty Title field is a fully working
  // state (the server names the issue at submit time as before).
  router.post('/api/feedback/title', feedbackTitleLimiter, async (req, res) => {
    const { description } = req.body || {};
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }
    try {
      const billing = await resolveTitleBilling(req.user?.id);
      if (billing.error) return res.json({ title: null, note: billing.error });
      if (!billing.apiKey && !llm.isEnabled()) {
        return res.json({ title: null, note: 'unavailable' });
      }
      const gen = await llm.generateIssueTitle({
        description,
        apiKey: billing.apiKey || undefined,
      });
      if (gen.usage && req.user?.id) {
        const costCents = llm.estimateCostCents(gen.usage, gen.model);
        await limits.recordSpend(pool, req.user.id, costCents, { byok: billing.byok });
      }
      // Defensive clip to the Title field's maxlength; Haiku's 5-10-word
      // titles never approach it.
      res.json({ title: gen.title.slice(0, 200) });
    } catch (err) {
      log.warn('feedback', 'Title preview generation failed', { message: err.message });
      res.json({ title: null, note: 'failed' });
    }
  });

  // #683: screenshot upload for the feedback modal. Upload happens
  // BEFORE submit: the client POSTs the captured image's raw bytes here,
  // gets back an id, and passes it in `screenshotIds` to /api/feedback
  // below, which links the row to the filed issue. Rows never linked are
  // GC'd by the server.js orphan sweeper after 24h.
  router.post(
    '/api/feedback/screenshot',
    issueScreenshotLimiter,
    // Limit must exceed the 4 MB screenshot cap so over-cap uploads get
    // the friendly 400 from validateScreenshotUpload, not a parser 413.
    express.raw({ type: 'application/octet-stream', limit: '5mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = validateScreenshotUpload(data);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO issue_screenshots (id, user_id, content_type, size_bytes, data)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, req.user.id, verdict.contentType, data.length, data]
        );
        return res.json({ id });
      } catch (err) {
        log.error('feedback', 'Screenshot upload failed', { message: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // #2520: the submission route files a real GitHub issue and may spend a
  // Haiku call naming it, so it carries a limiter like both of its
  // siblings above (feedbackTitleLimiter, issueScreenshotLimiter). 10 per
  // hour per user, sized in rate-limits.js. Authorization is unchanged and
  // deliberately open: filing against a collab-private repo is by design
  // and nothing private is read back, so this bounds the outbound cost
  // only.
  router.post('/api/feedback', feedbackSubmitLimiter, async (req, res) => {
    const { description, appSlug } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }

    // #556: optional user-chosen title. When present (non-empty after
    // trim) it is used verbatim and the Haiku naming call is skipped
    // entirely; when absent/blank the title is auto-generated as before.
    // Over-long titles are rejected rather than silently clipped.
    let customTitle = null;
    if (req.body.title !== undefined && req.body.title !== null && req.body.title !== '') {
      if (typeof req.body.title !== 'string') {
        return res.status(400).json({ error: 'title must be a string' });
      }
      if (req.body.title.length > 200) {
        return res.status(400).json({ error: 'Title too long (max 200 chars)' });
      }
      customTitle = req.body.title.trim() || null;
    }

    // #683: optional attached screenshots. #3027 made it up to
    // MAX_SCREENSHOTS_PER_ISSUE of them. Each must be a 32-hex id
    // referencing an existing, not-yet-linked upload owned by this user —
    // ALL of them, verified before any GitHub call, so one bad id fails fast
    // and files nothing.
    const parsedShots = parseScreenshotIds(req.body);
    if (!parsedShots.ok) return res.status(400).json({ error: parsedShots.error });
    const screenshotIds = parsedShots.ids;
    if (screenshotIds.length) {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM issue_screenshots
            WHERE id = ANY($1::varchar[]) AND user_id = $2 AND issue_number IS NULL`,
          [screenshotIds, req.user?.id]
        );
        if (rows.length !== screenshotIds.length) {
          return res.status(400).json({ error: 'Unknown or already-used screenshot' });
        }
      } catch (err) {
        log.error('feedback', 'Screenshot lookup failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // #685: optional app-provided state snapshot. Validated whenever
    // present (a bad payload fails fast, before any GitHub call), but
    // only honored for app-targeted feedback below — the shell itself
    // has no provider, so it's silently ignored for platform feedback.
    let pageState = null;
    let pageStateTruncated = false;
    if (req.body.pageState !== undefined && req.body.pageState !== null && req.body.pageState !== '') {
      if (typeof req.body.pageState !== 'string') {
        return res.status(400).json({ error: 'pageState must be a string' });
      }
      if (req.body.pageState.length > MAX_PAGE_STATE_CHARS) {
        return res.status(400).json({ error: 'pageState too large' });
      }
      pageState = req.body.pageState;
      // Client-asserted, cosmetic only (drives the "truncated" label in
      // the <summary> line).
      pageStateTruncated = req.body.pageStateTruncated === true;
    }

    // #1054: when an offline-queued message was actually written. Never a
    // 400 — see normalizeQueuedAt: an unusable value just prints nothing.
    const queuedAt = normalizeQueuedAt(req.body.queuedAt, Date.now());

    // #964: optional kudos bounty on the issue about to be filed. Validated
    // up front (like title / screenshotIds / pageState) so a malformed flag
    // fails fast rather than after an issue exists. Strict boolean: a
    // truthy string would make "false" pledge, which is exactly the kind of
    // accident that spends someone's allowance without their say-so.
    if (req.body.bounty !== undefined && typeof req.body.bounty !== 'boolean') {
      return res.status(400).json({ error: 'bounty must be a boolean' });
    }
    const wantsBounty = req.body.bounty === true;

    // Normalise the feedback target. Anything other than the explicit
    // 'app' opt-in falls back to platform feedback (today's behaviour).
    const target = req.body.target === 'app' ? 'app' : 'platform';

    const pat = process.env.GITHUB_BOT_TOKEN;
    if (!pat) {
      return res.status(503).json({ error: 'GitHub token not configured' });
    }

    // Resolve the destination repo up front so we fail fast (before
    // spending a Haiku call on title generation) when the app target is
    // unusable. `appContext` is non-null only for app-targeted feedback.
    let issueOwner = feedbackOwner;
    let issueRepo = feedbackRepo;
    let appContext = null;
    // The app row a bounty would attach to, carrying appAccess.ACCESS_COLUMNS.
    // Non-null only for app-targeted feedback that asked for a bounty; the
    // platform target resolves its app by repo at placement time instead.
    let bountyApp = null;
    if (target === 'app') {
      if (!appSlug || typeof appSlug !== 'string') {
        return res.status(400).json({ error: 'appSlug is required for app feedback' });
      }
      if (!github.isEnabled()) {
        return res.status(503).json({ error: 'GitHub token not configured' });
      }
      let appRow;
      try {
        // The visibility columns always ride along: feedback is filed only on
        // an app the reporter can view, and checkAppAccess throws on a row
        // whose access columns were projected away. `name` / `repo_url` are
        // not in ACCESS_COLUMNS, so both sets are selected together.
        const { rows } = await pool.query(
          `SELECT name, repo_url, ${appAccess.ACCESS_COLUMNS} FROM apps WHERE slug = $1`,
          [appSlug]
        );
        appRow = rows[0];
        // A private, suspended or blocked app answers exactly like a missing
        // one, before anything about it (its repository included) is revealed.
        if (appRow && !(await appAccess.checkAppAccess(pool, appRow, req.user, 'view'))) {
          appRow = null;
        }
      } catch (err) {
        log.error('feedback', 'App lookup failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!appRow) {
        return res.status(404).json({ error: 'App not found' });
      }
      const [, owner, repo] = (appRow.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!owner || !repo) {
        return res.status(409).json({ error: 'This app has no repository yet. Try platform feedback instead' });
      }
      issueOwner = owner;
      issueRepo = repo;
      appContext = { id: appRow.id, slug: appRow.slug, name: appRow.name };
      // Keep the full row (access columns included) for the bounty's collab
      // check; appContext stays the narrow shape announceIssueCreated and
      // the issue body already expect.
      bountyApp = wantsBounty ? appRow : null;
    }

    // #140: include the admin's actual username so the issues panel can show
    // who filed it instead of a bare "admin" (mirrors the user form).
    // #3132: the product is Homeroom; issues filed before that read
    // "usernode user (name)", which creatorFromSourceLine still accepts.
    const source = req.user?.isAdmin
      ? `Homeroom admin (${req.user?.username || 'unknown'})`
      : `Homeroom user (${req.user?.username || 'unknown'})`;

    try {
      // Title via the shared Haiku helper (services/llm.js) — unless the
      // user supplied one themselves (#556), in which case their exact
      // title is used and no LLM call is made. On any generation failure
      // (LLM disabled, credits exhausted, API error) the issue is still
      // filed with the fallback template — feedback must never block on
      // LLM availability — and `titleFallback` drives a title_heal_queue
      // row below so the sweeper regenerates the title later. Feedback the
      // model finds nothing to title in ("Lfg") is not a failure: it comes
      // back as the reporter's own words with `actionable: false` (#3193),
      // files as-is, and queues no heal, since a retry gets the same answer.
      let title = llm.FEEDBACK_FALLBACK_TITLE;
      let titleFallback = true;
      if (customTitle) {
        title = customTitle;
        titleFallback = false;
      } else {
        try {
          const billing = await resolveTitleBilling(req.user?.id);
          if (billing.error) throw new Error(`title billing unavailable: ${billing.error}`);
          const gen = await llm.generateIssueTitle({
            description,
            apiKey: billing.apiKey || undefined,
          });
          title = gen.title;
          titleFallback = false;
          if (gen.usage && req.user?.id) {
            const costCents = llm.estimateCostCents(gen.usage, gen.model);
            await limits.recordSpend(pool, req.user.id, costCents, { byok: billing.byok });
          }
        } catch (err) {
          log.warn('feedback', 'Title generation failed; filing with fallback title', { message: err.message });
        }
      }

      // Queue the filed issue for title regeneration (services/title-heal.js).
      // Best-effort: a queue failure must never fail the request — the
      // issue is already on GitHub by the time this runs.
      const queueTitleHeal = async (owner, repo, issueNumber) => {
        if (!titleFallback) return;
        try {
          await pool.query(
            `INSERT INTO title_heal_queue (user_id, owner, repo, issue_number, description)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (owner, repo, issue_number) DO NOTHING`,
            [req.user?.id || null, owner, repo, issueNumber, description.trim()]
          );
        } catch (err) {
          log.warn('feedback', 'Failed to queue title heal', { repo: `${owner}/${repo}`, issueNumber, message: err.message });
        }
      };

      // #683: server-appended embed line for the attached screenshot —
      // the public /issue-images/:id URL GitHub's camo proxy, the in-app
      // topic view, and the coding agents can all fetch. Appended after
      // the description-length validation, so it never eats user budget.
      const screenshotSuffix = buildScreenshotsEmbed(screenshotIds, require('../services/caddy').USERNODE_DOMAIN);
      // #1054: one header line for an offline-queued message, empty for a
      // live submit (whose filing time IS its writing time).
      const queuedLine = queuedAt ? `**Saved offline:** ${queuedAt}\n` : '';
      // Stamp the row with the filed issue so the orphan GC skips it.
      // Best-effort: the issue is already on GitHub by the time this
      // runs, so a failure only risks the image 404ing after the 24h
      // sweep — never a failed request.
      // #3027: every attached row, still bound to its uploader and to rows
      // nobody has linked yet — the same conditions the lookup above checked.
      const linkScreenshot = async (owner, repo, issueNumber) => {
        if (!screenshotIds.length) return;
        try {
          await pool.query(
            `UPDATE issue_screenshots
                SET issue_owner = $2, issue_repo = $3, issue_number = $4
              WHERE id = ANY($1::varchar[]) AND user_id = $5 AND issue_number IS NULL`,
            [screenshotIds, owner, repo, issueNumber, req.user?.id]
          );
        } catch (err) {
          log.warn('feedback', 'Screenshot link failed', { screenshotIds, message: err.message });
        }
      };

      // App-targeted feedback files into the app's own repo, which the
      // bot reaches through the GitHub App installation (same path as
      // routes/issues.js) rather than the platform PAT — the PAT isn't
      // guaranteed to have access to every app repo.
      if (target === 'app') {
        // #685: the collapsed state-snapshot block goes last, after the
        // screenshot embed, so it never buries the description.
        const pageStateSuffix = pageState
          ? buildPageStateEmbed(pageState, pageStateTruncated)
          : '';
        // #1054: the "written while offline" line sits with the other header
        // lines, above the description — it is context for reading the report,
        // not part of it.
        const body = `**Source:** ${source}\n**App:** ${appContext.name} (${appContext.slug})\n${queuedLine}\n${description.trim()}${screenshotSuffix}${pageStateSuffix}`;
        let issue;
        try {
          issue = await github.createIssue(issueOwner, issueRepo, { title, body });
        } catch (err) {
          log.error('feedback', 'App GitHub issue creation failed', {
            repo: `${issueOwner}/${issueRepo}`,
            message: err.message,
          });
          // Never silently reroute to the platform repo — the user
          // explicitly chose this app. Surface an actionable hint.
          return res.status(502).json({
            error: "Failed to create GitHub issue: couldn't file to this app's repo. The bot may not be installed on it",
          });
        }
        await queueTitleHeal(issueOwner, issueRepo, issue.number);
        await linkScreenshot(issueOwner, issueRepo, issue.number);
        await announceIssueCreated(pool, issueOwner, issueRepo, issue, appContext);
        // #964: the pledge goes last — after the issue exists and after the
        // announce — and can only ever add a `bounty` field to the response.
        // The filed issue is never at risk from it.
        const bounty = wantsBounty
          ? await attachBounty(pool, {
            app: bountyApp, owner: issueOwner, repo: issueRepo,
            issueNumber: issue.number, user: req.user,
          })
          : null;
        await recordFeedbackReport(pool, {
          user: req.user, app: appContext, owner: issueOwner, repo: issueRepo,
          issueNumber: issue.number, title, description: description.trim(),
        });
        const firstFeedback = await firstFeedbackMoment(pool, {
          user: req.user, app: appContext, owner: issueOwner, repo: issueRepo, issueNumber: issue.number,
        });
        return res.json({
          url: issue.html_url, title, titleFallback,
          ...(bounty ? { bounty } : {}),
          ...(firstFeedback ? { firstFeedback } : {}),
        });
      }

      const ghRes = await fetch(`https://api.github.com/repos/${issueOwner}/${issueRepo}/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${pat}`,
          'User-Agent': 'usernode-social-vibecoding',
        },
        // This hand-rolled fetch bypasses github.js's write helpers, so
        // apply safeMention here — the user-typed description/title are
        // free-form text that could carry live @mentions (#723).
        body: JSON.stringify({
          title: github.safeMention(title),
          body: github.safeMention(`**Source:** ${source}\n${queuedLine}\n${description.trim()}${screenshotSuffix}`),
          labels: ['usernode'],
        }),
      });

      if (!ghRes.ok) {
        const err = await ghRes.text();
        log.error('feedback', 'GitHub API error', { status: ghRes.status, body: err });
        // Surface the underlying status in the client-facing error so we
        // don't have to spelunk server logs to tell "bot has no access to
        // the feedback repo" (404) from "PAT revoked" (401) from rate
        // limiting (403). Never include the raw body — it can leak repo
        // metadata — but the status alone is safe + actionable.
        const hint = ghRes.status === 404
          ? 'feedback repo not visible to the bot. Add usernode-bot as a collaborator or install the GitHub App on it'
          : ghRes.status === 401
            ? 'GITHUB_BOT_TOKEN is invalid or expired'
            : ghRes.status === 403
              ? 'bot lacks Issues:write on the feedback repo, or is rate-limited'
              : `GitHub returned ${ghRes.status}`;
        return res.status(502).json({ error: `Failed to create GitHub issue: ${hint}` });
      }

      const issue = await ghRes.json();
      await queueTitleHeal(issueOwner, issueRepo, issue.number);
      await linkScreenshot(issueOwner, issueRepo, issue.number);
      // Platform feedback: the platform repo is itself an app on
      // self-hosted instances, so its Open Issues panel should refresh
      // too. announceIssueCreated resolves the app row by repo (no-op
      // when none matches).
      await announceIssueCreated(pool, issueOwner, issueRepo, issue, null);
      // #964: same placement as the app branch. `app: null` sends
      // attachBounty to findAppByRepo, which resolves the platform repo to
      // the self-hosted platform app — the same row announceIssueCreated
      // just broadcast against, so the pill and the broadcast agree.
      const bounty = wantsBounty
        ? await attachBounty(pool, {
          app: null, owner: issueOwner, repo: issueRepo,
          issueNumber: issue.number, user: req.user,
        })
        : null;
      await recordFeedbackReport(pool, {
        user: req.user, app: null, owner: issueOwner, repo: issueRepo,
        issueNumber: issue.number, title, description: description.trim(),
      });
      const firstFeedback = await firstFeedbackMoment(pool, {
        user: req.user, app: null, owner: issueOwner, repo: issueRepo, issueNumber: issue.number,
      });
      res.json({
        url: issue.html_url, title, titleFallback,
        ...(bounty ? { bounty } : {}),
        ...(firstFeedback ? { firstFeedback } : {}),
      });
    } catch (err) {
      log.error('feedback', 'Error filing issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3186: the caller's own reports, for "Your feedback" on the Me screen.
  // See MY_FEEDBACK_SQL above for the two statuses and why there are two.
  router.get('/api/feedback/mine', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(MY_FEEDBACK_SQL, [req.user.id, MY_FEEDBACK_LIMIT]);
      const demo = IS_STAGING && req.query.demo === '1';
      let selfApp = null;
      if (demo || rows.some((r) => r.target === 'platform')) {
        const { rows: selfRows } = await pool.query(MY_FEEDBACK_SELF_APP_SQL);
        selfApp = selfRows[0] || null;
      }
      let body = shapeMyFeedback(rows, selfApp);
      if (demo) body = withDemoFeedback(body, selfApp);
      res.set('Cache-Control', 'no-store');
      return res.json(body);
    } catch (err) {
      log.error('feedback', 'Own feedback read failed', { userId: req.user.id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  feedbackRoutes,
  // #3186: pure helpers exported for tests/feedback-mine.test.js.
  shapeMyFeedback,
  withDemoFeedback,
  repoMatches,
  DEMO_FEEDBACK,
  MY_FEEDBACK_LIMIT,
  // #683: pure helpers exported for tests/issue-screenshots.test.js.
  validateScreenshotUpload,
  buildScreenshotEmbed,
  MAX_SCREENSHOT_BYTES,
  // #3027: several images per submit — tests/feedback-multi-screenshot-server.test.js.
  parseScreenshotIds,
  buildScreenshotsEmbed,
  MAX_SCREENSHOTS_PER_ISSUE,
  // #685: pure helpers exported for tests/feedback-page-state.test.js.
  buildPageStateEmbed,
  MAX_PAGE_STATE_CHARS,
  normalizeQueuedAt,
  MAX_QUEUED_AT_CHARS,
};
