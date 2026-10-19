'use strict';

/**
 * Reader for `dapp.json` — the per-dapp manifest declaring which env
 * vars the dapp needs at runtime.
 *
 * Lives in the dapp repo root, alongside Dockerfile and package.json. The
 * platform reads it from the freshly-cloned working tree on every deploy
 * (createApp / buildAndDeployStaging / deployProduction) so the manifest
 * is always the current code's source of truth. It is NEVER snapshotted
 * into the platform DB — staleness is a guaranteed pain we don't want.
 *
 * Shape:
 *   {
 *     "description": "...",                    // one line, what the app IS.
 *                                             // The launcher's Discover cards
 *                                             // draw it; there is no such
 *                                             // column on `apps`, and the
 *                                             // directory derives a meta line
 *                                             // instead. Read off the stored
 *                                             // manifest snapshot by the
 *                                             // client and capped at 160
 *                                             // chars there; absent on most
 *                                             // apps, and the card simply
 *                                             // draws no sentence.
 *     "secrets": [
 *       {
 *         "key": "ECHO_APP_SECRET_KEY",       // env var name
 *         "description": "...",               // human help text for UI
 *         "required": true,                   // deploy blocks if unset
 *         "private": true,                    // encrypted at rest, never
 *                                             // returned by API, AND not
 *                                             // propagated from prod into
 *                                             // staging — sibling to
 *                                             // staging:private for SQL.
 *                                             // See app-conventions.md.
 *         "default": "...",                   // applied if no stored value
 *         "staging_default": "..."            // committed staging fallback
 *                                             // for private entries.
 *                                             // Wins over `default` in
 *                                             // staging.
 *       },
 *       ...
 *     ]
 *   }
 *
 * `sensitive: true` is accepted as a backward-compatible alias for
 * `private: true` — the canonical field is `private`. Existing
 * dapp.json files written before the rename keep working unchanged.
 *
 * Missing file or unparseable JSON is treated as `{ secrets: [] }` — i.e.
 * exactly the legacy behavior. The platform never refuses to deploy on
 * an absent manifest; only on declared-required-but-unset values.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const usernames = require('./usernames');
const governanceRules = require('./governance-rules');
const appPermissions = require('./app-permissions');
const { validatePath } = require('./testing-notes');
const topicFigures = require('./topic-figures');

const MANIFEST_FILENAME = 'dapp.json';

// #47: per-app automated tests (the "CI for proposals" framework). Each
// test navigates one staging route and asserts load + no-console-errors
// (+ optional selector/text). A representative flow can also declare
// `{ id, visual: true, impact: [...] }`; services/visuals.js then uses that
// executable check as an automatic screenshot scenario when its file globs
// overlap the proposal diff.
//
// THE READER NO LONGER CAPS AT 12. It used to keep only the first
// MAX_TESTS entries, which meant this repo's own 240-odd declared checks
// were 12 real ones and 229 pieces of decoration — never parsed, never
// run, never able to fail. The capture container now runs EVERY declared
// check through a bounded parallel page pool (capture/capture.js), so the
// only remaining bound is a validation ceiling that keeps a pathological
// manifest from queueing an unbounded suite. Entries past the ceiling are
// dropped and logged, and services/visuals.js turns "this proposal pushed
// the list past the ceiling" into a blocking check row so the silent-drop
// bug cannot come back.
//
// Raised 300 → 400 (PR #1125). This repo's own manifest crossed 300 and the
// tail — including the two `?shot=feedback-*` checks added for #1054 — was
// being dropped, which turns the over-ceiling guard into a blocker on every
// subsequent proposal rather than a warning about a pathological manifest.
//
// Raised 400 → 430 when the manifest reached 382 and the 20-slot headroom
// floor tests/proposal-tests-manifest.test.js pins was crossed. 430 is the
// most the UNCHANGED capture budget clears: at the ~3.9s marginal cost per
// check over a pool of 8, a full 430-check suite is ~210s of ideal work
// against the 420s TESTS_DEADLINE_MS — right at the 2x margin
// tests/checks-budget.test.js pins. Raising it any further means raising
// that deadline (and the container run timeout above it) in the same
// change.
//
// Raised 430 → 480 (#1417), and that is the bump the note above says has to
// move the deadline with it, so TESTS_DEADLINE_MS goes 420s → 470s in
// services/visuals.js. The arithmetic is the same one: 480 checks at ~3.9s
// over a pool of 8 is ~234s of ideal work, and 470s clears the 2x margin
// with 2s to spare. RUN_TIMEOUT_MS stays at 600s — it only has to sit
// 120s above the deadline, and 130s does.
//
// The manifest was at 410 when this was raised, which is EXACTLY the
// 20-slot floor: the previous ceiling had no room for a single further
// check, so any proposal declaring one at all was blocked. That is the
// state this bump clears, not one feature's three checks.
//
// Raised 480 → 530 when the manifest reached 461 and crossed the 20-slot
// floor again (19 left), which made the unit suite red on main itself and so
// on every proposal after it. Same arithmetic, same coupled move: 530 checks
// at ~3.9s over a pool of 8 is ~258s of ideal work, so TESTS_DEADLINE_MS
// goes 470s → 520s to keep the 2x margin (clears it by ~3s), and because the
// deadline has passed 480s this time RUN_TIMEOUT_MS moves too, 600s → 640s,
// to stay the required 120s above it.
//
// Raised 530 → 560 when the manifest reached 512 and crossed the 20-slot floor
// again (18 left) — the same event as the line above, for the third time, and
// again it made the unit suite red on main itself and so on every proposal
// after it. #1699 added the two checks that crossed it.
//
// Same arithmetic, same coupled move: 560 checks at ~3.9s over a pool of 8 is
// ~273s of ideal work, so TESTS_DEADLINE_MS goes 520s → 560s to keep the 2x
// margin (clears it by 14s, where the last move cleared by 3), and
// RUN_TIMEOUT_MS goes 640s → 680s to stay the required 120s above it.
//
// The step is 30 rather than the 50 last time on purpose: 560 is what the
// budget test's 2x rule allows without the deadline crossing 600s, and the
// jump buys 48 slots — about two years at the rate the last three moves
// happened. Deleting checks to make room is the thing the failing test
// explicitly refuses, so the ceiling is the only lever.
//
// Raised again, 560 → 580, by a proposal in flight at the same time (this
// one, which declares two checks of its own): same coupled move, 580 checks
// at ~3.9s over a pool of 8 is ~283s of ideal work, so TESTS_DEADLINE_MS goes
// 560s → 570s to keep the 2x margin (clears it by ~4s), and RUN_TIMEOUT_MS
// 680s → 690s to stay the required 120s above it.
//
// Raised 580 → 600 by #1824, which declares two checks of its own and found
// the manifest at 560 — exactly ON the 20-slot floor, so ANY proposal that
// declared a check was red before it started. That is the fifth time this has
// happened, and the reason it keeps happening is that the floor is a floor:
// clearing it by zero is indistinguishable from crossing it until the next
// person adds a check.
//
// Same arithmetic, same coupled move: 600 checks at ~3.9s over a pool of 8 is
// ~293s of ideal work, so TESTS_DEADLINE_MS goes 570s → 590s to keep the 2x
// margin (clears it by ~5s), and RUN_TIMEOUT_MS 690s → 710s to stay the
// required 120s above it. The step buys 38 slots over the 562 declared here.
//
// Raised 600 → 630 by #1876, which splits the waitlist confirm errand into two
// screens and so declares eight checks where one stood: there are two states
// now, they cannot be photographed at once, and each needs its visible half,
// its hidden half and its step line asserted. That put the manifest at 587
// against a 580 floor. Sixth crossing, and the first one caused by a
// proposal's own checks rather than by finding the floor already met — which
// is the same lesson from the other side: a floor cleared by seven is a floor
// the next feature crosses.
//
// Same arithmetic, same coupled move: 630 checks at ~3.9s over a pool of 8 is
// ~307s of ideal work, so TESTS_DEADLINE_MS goes 590s → 620s to keep the 2x
// margin (clears it by ~6s), and RUN_TIMEOUT_MS 710s → 740s to stay the
// required 120s above it. The step is 30 again, and buys 23 slots over the 587
// declared here.
//
// Raised 630 → 660 by #1960, whose two draft-delete checks put the manifest at
// 611 against the 610 floor, landing beside main's own growth to 609. Same
// arithmetic, same coupled move: 660 checks at ~3.9s over a pool of 8 is ~322s
// of ideal work, so TESTS_DEADLINE_MS goes 620s → 650s to keep the 2x margin
// (clears it by ~6s), and RUN_TIMEOUT_MS 740s → 770s to stay the required 120s
// above it. The step buys 29 slots over the 611 declared here.
//
// Raised 660 → 690 by #2201, whose three confirmed-re-join checks put the
// manifest at 641 against the 640 floor. The first bump after the capture
// pool doubled 8 → 16 (services/visuals.js), and the free one that note
// promised: 690 checks at ~3.9s over 16 pages is ~168s of ideal work, still
// under a quarter of the 650s TESTS_DEADLINE_MS, so neither the deadline nor
// RUN_TIMEOUT_MS moves. The step buys 29 slots over the 641 declared here.
//
// Raised 690 → 710 by #2219, whose four checks put the manifest at 646
// against the 690 floor, landing on main's own growth from #2201 above —
// this branch was cut before that merged, so its own count (643 against a
// 640 floor) is superseded by the merged total.
//
// STILL NOT A COUPLED MOVE, same reason as before: the pool is 16, so 710
// checks at ~3.9s over 16 is ~173s, and the UNCHANGED 650s deadline clears
// the 2x margin by ~304s. So the deadline and the run timeout stay exactly
// where #1960 left them. The next few bumps are free on the same arithmetic
// — tests/checks-budget.test.js says so from the other side, and it is the
// assertion that will stop being satisfied first if that ever changes.
//
// Raised 710 → 730 by #2563, whose three checks for the first-run
// "Choose your username" step put the manifest at 693 against the 690
// floor. Eighth crossing, and the floor was ALREADY met before those three
// landed: main stood at 690 exactly, so any proposal declaring a single
// check was red before it started — the same state #1824 and #2201 found,
// and the same reason, which is that clearing a floor by zero is
// indistinguishable from crossing it.
//
// STILL NOT A COUPLED MOVE, same arithmetic as the two bumps above: the
// pool is 16, so 730 checks at ~3.9s over 16 is ~178s, and the UNCHANGED
// 650s TESTS_DEADLINE_MS clears the 2x margin by ~294s. The deadline and
// RUN_TIMEOUT_MS stay exactly where #1960 left them. The step buys 17
// slots over the 693 declared here.
//
// Raised 730 → 750 by #2679/#2680 (PR #2683), whose one check on the
// hand-off walkthrough's "Link GitHub" step put the manifest at 711 against
// the 710 floor. Ninth crossing, and once more the floor was ALREADY met
// before that check landed: main stood at 710 exactly after the #2684
// Homeroom-bot pair and the native-Android-header check arrived beside
// each other, so any proposal declaring a single check was red before it
// started. tests/improve-session-spinner.test.js and
// tests/proposal-tests-manifest.test.js both state the floor, and both say
// to move the ceiling rather than delete a check.
//
// STILL NOT A COUPLED MOVE, same arithmetic as the three bumps above: the
// pool is 16, so 750 checks at ~3.9s over 16 is ~183s, and the UNCHANGED
// 650s TESTS_DEADLINE_MS clears the 2x margin by ~284s. The deadline and
// RUN_TIMEOUT_MS stay exactly where #1960 left them. The step buys 19
// slots over the 711 declared here.
//
// Raised 750 → 770 by #2760 and #2748 (PR #2750), landing beside each
// other: #2760's one check on the fifth tab carrying the signed-in user's
// name and #2748's one check on the waitlist analytics dashboard put the
// manifest at 732 against the 730 floor. Tenth crossing, and the floor was
// ALREADY met before either check landed: the #2718 follow-ups landing
// beside each other (#2773, #2774, #2780, #2781) left main at 730 exactly,
// so any proposal declaring a single check was red before it started.
//
// STILL NOT A COUPLED MOVE, same arithmetic as the four bumps above: the
// pool is 16, so 770 checks at ~3.9s over 16 is ~188s, and the UNCHANGED
// 650s TESTS_DEADLINE_MS clears the 2x margin by ~274s. The deadline and
// RUN_TIMEOUT_MS stay exactly where #1960 left them. The step buys 18
// slots over the 732 declared here.
//
// 770 → 790 (#2802, #2798): the sidebar recents proposal's two checks put
// the merged manifest at 751 against the 750 floor. Eleventh crossing, same
// arithmetic: 790 checks at ~3.9s over the pool of 16 is ~193s, and the
// unchanged 650s TESTS_DEADLINE_MS still clears the 2x margin by ~264s, so
// neither the deadline nor RUN_TIMEOUT_MS moves. The step buys 39 slots over
// the 751 declared here.
//
// 790 → 810 (Homeroom task 598, the navigation prototype's remaining gaps):
// its fifteen checks put the merged manifest at 775 against the 770 floor,
// landing on main's own growth to 760. Twelfth crossing, same arithmetic:
// 810 checks at ~3.9s over the pool of 16 is ~197s, and the unchanged 650s
// TESTS_DEADLINE_MS still clears the 2x margin by ~255s, so neither the
// deadline nor RUN_TIMEOUT_MS moves. The step buys 35 slots over the 775
// declared here.
//
// 810 → 830 (#2386, mutual friends): main stood at 790 exactly, the 20-slot
// floor, after #2779 folded its four checks into two to fit, so any proposal
// declaring a single check was red before it started. The friends change
// declares two (a person's friend button, the own profile's Friends section),
// already folded from five with :has(). Thirteenth crossing, same
// arithmetic: 830 checks at ~3.9s over the pool of 16 is ~202s, and the
// unchanged 650s TESTS_DEADLINE_MS still clears the 2x margin by ~245s, so
// neither the deadline nor RUN_TIMEOUT_MS moves. The step buys 38 slots over
// the 792 declared here; #2387's six, merged beside it, leave 32 over 798.
//
// 830 → 840 (#4868): main stood at 810 exactly, the 20-slot floor, after the
// QA sweep's six; the "Open app" proposal declares one — its two assertions
// (the button offered on an ordinary app's chat, absent on the platform's
// own) already folded into a single :has()/:not(:has()) selector over the two
// staging conversations 990803 and 990801, the way #2779 folded its four.
// A proposal red before it started is the case #2386 raised the ceiling for,
// and the same arithmetic holds: 840 checks at ~3.9s over the pool of 16 is
// ~206s of ideal work, and the unchanged 650s TESTS_DEADLINE_MS still clears
// the 2x margin by ~238s, so neither the deadline nor RUN_TIMEOUT_MS moves.
// The step buys 29 slots over the 811 declared here.
//
// 840 → 850 (welcome messages): main stood at 820 exactly, the 20-slot
// floor; the new Admin → Welcome messages section declares one check on its
// own route (#admin/welcome-dm), which no existing check shares, so there
// was nothing to fold it into. Same arithmetic: 850 checks at ~3.9s over the
// pool of 16 is ~207s of ideal work, and the unchanged 650s
// TESTS_DEADLINE_MS still clears the 2x margin by ~236s, so neither the
// deadline nor RUN_TIMEOUT_MS moves. The step buys 29 slots over the 821
// declared here.
//
// 850 → 860 (#3233, #3489): two proposals in flight together each assumed
// they were the only one moving the count off 829 — the notification
// sheet's plain-words app allowance row, and the hub's idle Your work state
// — and merged together they crossed the 20-slot floor at 831 against 850.
// Same arithmetic: 860 checks at ~3.9s over the pool of 16 is ~210s of ideal
// work, and the unchanged 650s TESTS_DEADLINE_MS still clears the 2x margin
// by ~231s, so neither the deadline nor RUN_TIMEOUT_MS moves. The step buys
// 29 slots over the 831 declared here.
//
// 860 → 870 (#3699): main stood at 840 exactly, the 20-slot floor; the HTML
// spec viewer declares one check on its own route, a new staging session
// (#app/usernode-2d5619/dev/sessions/900831), which no existing check shares.
// The nearest, 900830's shared-spec check, is a fixture whose version history
// the boot-time draft backfill also writes, so an HTML version could not join
// it without changing what that check proves. Same arithmetic: 870 checks at
// ~3.9s over the pool of 16 is ~212s of ideal work, and the unchanged 650s
// TESTS_DEADLINE_MS still clears the 2x margin by ~226s, so neither the
// deadline nor RUN_TIMEOUT_MS moves. The step buys 29 slots over the 841
// declared here.
//
// 870 → 880 (#3826): the member floor's words on the card. The mock row
// whose votes are all in and whose floor is unmet has a route of its own
// (the proposal page for 9000095), and no existing check shares it — the
// #788 family's checks sit on rows below threshold or floor-met — so there
// was nothing to fold it into, and the manifest stood at 840, exactly the
// floor. Same arithmetic: 880 checks at ~3.9s over the pool of 16 is ~215s
// of ideal work, and the unchanged 650s TESTS_DEADLINE_MS still clears the
// 2x margin by ~220s, so neither the deadline nor RUN_TIMEOUT_MS moves.
// The step buys 36 slots over the 844 declared here.
//
// THE RULE AT THE FLOOR, stated once because three guards enforce it and on
// #4868 they gave opposite advice. Fold first: a check that can share a
// route with an existing one joins that check's expectSelector with :has()
// instead of taking a slot. If the merged manifest still crosses the 20-slot
// floor, the proposal that crosses it raises this ceiling in the same change
// and adds its paragraph above, with the arithmetic;
// tests/checks-budget.test.js decides whether TESTS_DEADLINE_MS and
// RUN_TIMEOUT_MS move with it. Every raise above was made that way, and a
// feature is not held behind a second vote because main already sat at the
// floor. Never delete a check to make room. tests/lib/check-cap.js puts
// the same words in the failing guards' messages.
const MAX_DECLARED_TESTS = 880;

// The pre-pool cap, kept for exactly one purpose: services/check-history.js
// bootstraps an app with no recorded history by marking its first
// LEGACY_GATING_HEAD declared checks as already-graduated, so the set of
// checks that block a merge on the first build after this ships is exactly
// the set that blocked one before it. Nothing else reads it, and no check
// needs to sit near the top of the array any more.
const LEGACY_GATING_HEAD = 12;
// Deprecated alias — `MAX_TESTS` meant "the parse cap" and there is no
// parse cap now. Exported so a stale reference resolves to something sane
// rather than `undefined`.
const MAX_TESTS = LEGACY_GATING_HEAD;
const MAX_TEST_NAME_LEN = 120;
const MAX_TEST_SELECTOR_LEN = 256;
const MAX_TEST_TEXT_LEN = 256;
const MAX_VISUAL_SCENARIO_ID_LEN = 96;
const MAX_VISUAL_IMPACT_PATTERNS = 20;
const MAX_VISUAL_IMPACT_PATTERN_LEN = 256;
const VISUAL_SCENARIO_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;

// A visual scenario is a declared check with enough repository-level
// provenance to answer both questions the screenshot runner needs:
//
//   * which deterministic UI state should be photographed? (`id` + the
//     check's existing path/assertions)
//   * which code changes make that state relevant? (`impact` file globs)
//
// Keep this metadata on dapp.json checks, not beside individual source
// functions. The check remains executable documentation of the flow, while
// source files stay free of capture-pipeline annotations. Malformed visual
// metadata never drops the underlying check; it only prevents that check
// from being auto-selected as a screenshot scenario. At least one presence
// assertion is required: a route alone says where to navigate, not whether
// the feature state is ready to photograph.
function normalizeVisualScenario(test) {
  if (!test || test.visual !== true) return null;
  const id = typeof test.id === 'string' ? test.id.trim() : '';
  if (!id || id.length > MAX_VISUAL_SCENARIO_ID_LEN || !VISUAL_SCENARIO_ID_RE.test(id)) {
    return null;
  }
  const hasReadinessAssertion = (typeof test.expectSelector === 'string' && test.expectSelector.trim())
    || (typeof test.expectText === 'string' && test.expectText.trim());
  if (!hasReadinessAssertion) return null;
  if (!Array.isArray(test.impact)) return null;
  const impact = [];
  const seen = new Set();
  for (const raw of test.impact) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim().replace(/\\/g, '/');
    if (!pattern || pattern.length > MAX_VISUAL_IMPACT_PATTERN_LEN
      || pattern.startsWith('/') || pattern.startsWith('!')
      || pattern.split('/').includes('..') || seen.has(pattern)) continue;
    seen.add(pattern);
    impact.push(pattern);
    if (impact.length >= MAX_VISUAL_IMPACT_PATTERNS) break;
  }
  return impact.length ? { id, visual: true, impact } : null;
}

// Normalize the optional top-level `tests` array. Each entry must carry a
// valid `path` (same rules as a testing-block path: relative, single
// leading slash, no scheme/whitespace/markup). `name` falls back to the
// path. `expectSelector` / `expectText` are optional presence assertions;
// `allowConsoleErrors` opts a test out of the baseline no-console-errors
// rule (for a route that legitimately logs errors). A check carries no say
// in how its page is loaded: that is the app's top-level `bootParams` and
// `routingBoundaries` (readLoadRules below), and the retired per-check
// `coldLoad` key is ignored. `visual: true` requires
// a stable `id`, a presence assertion, and at least one repository-relative
// `impact` glob; malformed visual metadata is ignored without dropping the
// underlying check. Invalid entries are dropped, duplicate (name+path) pairs
// collapse, and the list is bounded by MAX_DECLARED_TESTS. A non-array /
// absent block resolves to [] — exactly the legacy behaviour (no declared
// tests → the orchestrator synthesizes the baseline). Never throws.
//
// readTestsWithMeta is the same pass with its bookkeeping exposed, because
// the over-ceiling guard has to compare LIKE WITH LIKE: the ceiling applies
// to VALID, DE-DUPLICATED entries, so a manifest with 305 raw entries of
// which 290 survive validation has dropped nothing for ceiling reasons and
// must not be failed. `ceilingDropped` counts only the entries this pass
// refused because the list was already full.
function readTestsWithMeta(parsed) {
  const raw = Array.isArray(parsed?.tests) ? parsed.tests : [];
  const out = [];
  const seen = new Set();
  let invalidDropped = 0;
  let ceilingDropped = 0;
  let invalidVisualDropped = 0;
  let retiredColdLoad = 0;
  const visualIds = new Set();
  for (const t of raw) {
    if (!t || typeof t !== 'object') { invalidDropped++; continue; }
    const p = validatePath(t.path);
    if (!p) { invalidDropped++; continue; }
    const name = (typeof t.name === 'string' && t.name.trim())
      ? t.name.trim().slice(0, MAX_TEST_NAME_LEN)
      : p;
    const dedupeKey = `${name}${p}`;
    if (seen.has(dedupeKey)) continue;
    if (out.length >= MAX_DECLARED_TESTS) { ceilingDropped++; continue; }
    seen.add(dedupeKey);
    let visual = normalizeVisualScenario(t);
    if (t.visual === true && !visual) invalidVisualDropped++;
    if (visual && visualIds.has(visual.id)) {
      invalidVisualDropped++;
      visual = null;
    }
    if (visual) visualIds.add(visual.id);
    out.push({
      name,
      path: p,
      expectSelector: typeof t.expectSelector === 'string' && t.expectSelector.trim()
        ? t.expectSelector.trim().slice(0, MAX_TEST_SELECTOR_LEN) : null,
      expectText: typeof t.expectText === 'string' && t.expectText.trim()
        ? t.expectText.trim().slice(0, MAX_TEST_TEXT_LEN) : null,
      allowConsoleErrors: !!t.allowConsoleErrors,
      // No per-check load setting is kept: how a check's page is loaded is
      // the app's rule (readLoadRules below), never the check's. A leftover
      // `coldLoad` key is ignored, and counted for the warning below.
      ...(visual || {}),
    });
    if (Object.prototype.hasOwnProperty.call(t, 'coldLoad')) retiredColdLoad++;
  }
  const dropped = invalidDropped + ceilingDropped;
  if (dropped > 0 || invalidVisualDropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-ceiling test entries', {
      dropped, invalidDropped, ceilingDropped, invalidVisualDropped,
      kept: out.length, ceiling: MAX_DECLARED_TESTS,
    });
  }
  if (retiredColdLoad > 0) {
    log.warn('app-manifest', 'Ignored the retired per-check "coldLoad" key: declare the app\'s "bootParams" or "routingBoundaries" instead (app-conventions.md)', {
      checks: retiredColdLoad,
    });
  }
  return {
    tests: out, rawCount: raw.length, ceilingDropped, invalidVisualDropped,
    loadRules: readLoadRules(parsed),
  };
}

// ── How a check's page is loaded: the app's rules, never a check's ──────
//
// The browser checks group a document's checks and reach all but the first
// by writing `location.hash` (capture/capture.js groupTests). Two kinds of
// address legitimately cannot be shared that way, and both are facts about
// the APP, so dapp.json declares them once at its top level:
//
//   * `bootParams`: query parameters the app reads only when a page loads,
//     a one-time deep link scripted at boot (Homeroom's `?shot=`, and
//     `?details=1`, which opens Details once). An address change rightly
//     does not replay them, so every check whose address carries one (in
//     its query or its fragment's) gets a load of its own, shared only with
//     its own address's checks.
//   * `routingBoundaries`: fragment routes whose screen sends the NEXT
//     address change somewhere else (Homeroom: on a desktop, a running
//     app's App tab opens the pages about it in a side panel beside it).
//     A check at such a route is still reached by a switch like any other;
//     the only thing that changes is that no other check is switched to
//     after it: it ends its group. It never changes which checks get a
//     load, its own or another's (capture.js groupTestsByDocument): where it
//     cannot end a group without that, it stays an ordinary cohort.
//
// There is deliberately no per-check form, and no rule exempts an address
// that carries no boot parameter from being reached by a switch: a check
// that falls back on a plain address is a navigation bug, and the fix is
// that an address change draws what a fresh load of that address draws.
// The per-check `"coldLoad": true` #5280 introduced is retired and ignored
// (counted in the warning above). Ignored, not refused: the reader's only
// refusal is dropping the check, which would lose a check to remove a
// speed hint that never changed a verdict.
//
// What reaches the runner is two bits per check (checkLoadFlags), computed
// by the platform from these rules against the address it visits: the
// `coldLoad` bit every runner since #5280 already honours, and `endsGroup`.
const MAX_BOOT_PARAMS = 8;
const BOOT_PARAM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_ROUTING_BOUNDARIES = 8;
const MAX_BOUNDARY_ROUTE_LEN = 128;
const MAX_BOUNDARY_REASON_LEN = 300;
const BOUNDARY_SEGMENT_RE = /^(?:\*|[A-Za-z0-9._~%-]+)$/;

// A short list of plain parameter names. Anything else in an entry (an
// `=`, a `&`, a space, a pattern) is dropped, as is a non-array field.
function readBootParams(parsed) {
  const raw = parsed && parsed.bootParams;
  if (raw === undefined) return [];
  const out = [];
  let dropped = Array.isArray(raw) ? 0 : 1;
  for (const p of (Array.isArray(raw) ? raw : [])) {
    if (typeof p !== 'string' || !BOOT_PARAM_RE.test(p) || out.length >= MAX_BOOT_PARAMS) { dropped++; continue; }
    if (!out.includes(p)) out.push(p);
  }
  if (dropped) log.warn('app-manifest', 'Dropped invalid "bootParams" entries', { dropped, kept: out.length });
  return out;
}

// The segments of a fragment route, without its `#`, one leading `/`, or
// its own `?query`.
function fragmentSegments(fragment) {
  return String(fragment || '').replace(/^#/, '').split('?')[0].replace(/^\//, '').split('/');
}

// `{ route, reason }`. `route` is a fragment route: `#`, then `/`-separated
// segments, each literal or `*` (exactly one non-empty segment). It matches
// a whole route, never a prefix, and its first segment is literal, so no
// entry can cover every address. `reason` says why the screen hands the
// next address change elsewhere; an entry without one is dropped.
function readRoutingBoundaries(parsed) {
  const raw = parsed && parsed.routingBoundaries;
  if (raw === undefined) return [];
  const out = [];
  let dropped = Array.isArray(raw) ? 0 : 1;
  for (const e of (Array.isArray(raw) ? raw : [])) {
    const route = e && typeof e.route === 'string' ? e.route.trim() : '';
    const reason = e && typeof e.reason === 'string' ? e.reason.trim() : '';
    const segs = route.startsWith('#') && !route.includes('?') ? fragmentSegments(route) : [];
    const ok = route.length <= MAX_BOUNDARY_ROUTE_LEN
      && !!reason && reason.length <= MAX_BOUNDARY_REASON_LEN
      && segs.length > 0 && segs.every((s) => BOUNDARY_SEGMENT_RE.test(s)) && segs[0] !== '*';
    if (!ok || out.length >= MAX_ROUTING_BOUNDARIES) { dropped++; continue; }
    if (!out.some((b) => b.route === route)) out.push({ route, reason });
  }
  if (dropped) log.warn('app-manifest', 'Dropped invalid "routingBoundaries" entries', { dropped, kept: out.length });
  return out;
}

function readLoadRules(parsed) {
  return { bootParams: readBootParams(parsed), routingBoundaries: readRoutingBoundaries(parsed) };
}

function paramNames(query) {
  const names = [];
  for (const part of String(query || '').split('&')) {
    const raw = part.split('=')[0];
    if (!raw) continue;
    try { names.push(decodeURIComponent(raw.replace(/\+/g, ' '))); } catch { names.push(raw); }
  }
  return names;
}

// The wire bits for one check, from the app's rules and the address the
// platform VISITS (for Homeroom, after selfAppHashPath: `/messages/x` is
// visited as `/#messages/x`, while a clean `/app/<slug>` path stays a path, a
// document of its own). Plain string surgery, like capture.js
// splitDocumentUrl, so a malformed address degrades to no bits rather than
// throwing.
function checkLoadFlags(address, rules) {
  const r = rules || {};
  const boot = Array.isArray(r.bootParams) ? r.bootParams : [];
  const bounds = Array.isArray(r.routingBoundaries) ? r.routingBoundaries : [];
  if (!boot.length && !bounds.length) return {};
  const s = String(address == null ? '' : address);
  const h = s.indexOf('#');
  const doc = h === -1 ? s : s.slice(0, h);
  const frag = h === -1 ? '' : s.slice(h + 1);
  const q = doc.indexOf('?');
  const fq = frag.indexOf('?');
  const names = paramNames(q === -1 ? '' : doc.slice(q + 1))
    .concat(paramNames(fq === -1 ? '' : frag.slice(fq + 1)));
  const out = {};
  if (names.some((n) => boot.includes(n))) out.coldLoad = true;
  if (frag) {
    const segs = fragmentSegments(frag);
    const hit = bounds.some((b) => {
      const pat = fragmentSegments(b.route);
      return pat.length === segs.length
        && pat.every((p, i) => (p === '*' ? !!segs[i] : p === segs[i]));
    });
    if (hit) out.endsGroup = true;
  }
  return out;
}

function readTests(parsed) {
  return readTestsWithMeta(parsed).tests;
}

// The durable identity of one declared check, and the ONLY thing the
// per-check history is keyed by (services/check-history.js). It is the
// same (name + path) pair readTests already de-duplicates on, hashed so
// the column is fixed-width regardless of how long a check's name is.
//
// Consequence, and it is deliberate: renaming or re-pathing a check mints
// a NEW key, so the check drops back to advisory and has to be observed
// passing again before it can block a merge. An edited check is a new
// check as far as "has this ever actually worked?" is concerned.
function checkKey(name, path) {
  return crypto.createHash('sha256')
    .update(`${String(name == null ? '' : name)}\n${String(path == null ? '' : path)}`)
    .digest('hex');
}

// Reserved keys the platform owns, the prefixes of its env-var families, a
// key's shape, and the platform variables only the deploy may write
// (PLATFORM_ENV_UNWRITABLE, in the platform_env block below): the lists and
// their reasons are src/workflow/rules/platform-keys.ts, which the workflow
// machines refuse an unwritable key with. A manifest entry using a reserved
// key is rejected on read so a dapp can't shadow / spoof the
// platform-injected values that all dapps depend on.
const { RESERVED_KEYS, RESERVED_KEY_PREFIXES, KEY_RE, PLATFORM_ENV_UNWRITABLE } = require('../workflow/rules/platform-keys.ts');

// ---------------------------------------------------------------------------
// platform_env: the platform's own environment-variable manifest.
//
// This block is read ONLY from the self-hosted platform repo's dapp.json.
// It is deliberately separate from `secrets`, which describes a *child
// dapp's* container env and is merged by services/app-secrets.js at
// deploy time. Nothing in the child-dapp path reads platform_env, and
// mergeForDeploy() never learns about it — that containment is the whole
// point: a value declared here lands in the VPS `.env` of the platform
// process, never in a dapp container.
// ---------------------------------------------------------------------------


const MAX_PLATFORM_ENV = 200;
const MAX_PLATFORM_ENV_DESC_LEN = 400;
const MAX_PLATFORM_ENV_GROUP_LEN = 48;
const MAX_PLATFORM_ENV_DEFAULT_LEN = 2048;

// Normalize the optional top-level `platform_env` array. Follows the same
// lenient contract as every other reader here: never throws, drops what it
// can't understand with a log.warn, and resolves an absent/invalid block to
// [] so a platform repo without the block behaves exactly as it did before
// this feature existed.
//
// Entry shape: { key, description?, required?, private?, group?, default? }.
// `unwritable` is derived, not declared — a manifest cannot opt a key out of
// PLATFORM_ENV_UNWRITABLE, only into it by naming one of those keys.
function readPlatformEnv(parsed) {
  const raw = Array.isArray(parsed?.platform_env) ? parsed.platform_env : [];
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const e of raw) {
    if (!e || typeof e !== 'object') { dropped++; continue; }
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!KEY_RE.test(key)) {
      log.warn('app-manifest', 'Skipping invalid platform_env key', { key: e.key });
      dropped++;
      continue;
    }
    // Note: RESERVED_KEYS is NOT a rejection here the way it is for
    // `secrets`. Those keys are reserved against *dapps* shadowing the
    // platform; the platform declaring its own DATABASE_URL is legitimate
    // documentation. They land as unwritable instead.
    if (seen.has(key)) {
      log.warn('app-manifest', 'Skipping duplicate platform_env key', { key });
      dropped++;
      continue;
    }
    if (out.length >= MAX_PLATFORM_ENV) { dropped++; continue; }
    seen.add(key);
    const unwritable = PLATFORM_ENV_UNWRITABLE.has(key)
      || RESERVED_KEYS.has(key)
      || RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p));
    out.push({
      key,
      description: typeof e.description === 'string'
        ? e.description.slice(0, MAX_PLATFORM_ENV_DESC_LEN) : '',
      required: !!e.required,
      private: !!e.private || !!e.sensitive,
      group: typeof e.group === 'string' && e.group.trim()
        ? e.group.trim().slice(0, MAX_PLATFORM_ENV_GROUP_LEN) : 'General',
      // Documentation of the compiled-in fallback, shown in the admin UI
      // as "defaults to X". Never applied as a value — the deploy's own
      // `${{ vars.X || 'default' }}` expressions remain authoritative.
      default: typeof e.default === 'string'
        ? e.default.slice(0, MAX_PLATFORM_ENV_DEFAULT_LEN) : null,
      unwritable,
    });
  }
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-cap platform_env entries', {
      dropped, kept: out.length, cap: MAX_PLATFORM_ENV,
    });
  }
  return out;
}

// Normalize the top-level `secrets` array: the child dapp's container env.
// Lenient like every reader here: an entry with an invalid key, a reserved
// key, a key also declared in `platform_env`, or a duplicate key is dropped
// with a log.warn, and an absent/invalid block resolves to [].
//
// A key declared in BOTH blocks is a mistake with a dangerous failure mode:
// `secrets` values are handed to a dapp container, platform_env values are
// not. Rather than guess, platform_env wins and the `secrets` entry is
// dropped, so the containment guarantee (a platform variable never leaks
// into a dapp's env) holds by construction rather than by review.
//
// `opts.platformEnv` is readPlatformEnv(parsed) when the caller already has
// it; `opts.filePath` only labels the warnings.
function readSecrets(parsed, opts = {}) {
  const platformEnv = Array.isArray(opts.platformEnv) ? opts.platformEnv : readPlatformEnv(parsed);
  const platformEnvKeys = new Set(platformEnv.map((e) => e.key));
  const filePath = opts.filePath;

  const secretsIn = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
  const seen = new Set();
  const secrets = [];

  for (const s of secretsIn) {
    if (!s || typeof s !== 'object') continue;
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    if (!KEY_RE.test(key)) {
      log.warn('app-manifest', 'Skipping invalid key', { filePath, key: s.key });
      continue;
    }
    if (RESERVED_KEYS.has(key) || RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      log.warn('app-manifest', 'Skipping reserved key', { filePath, key });
      continue;
    }
    if (platformEnvKeys.has(key)) {
      log.warn('app-manifest', 'Skipping secrets key also declared in platform_env', { filePath, key });
      continue;
    }
    if (seen.has(key)) {
      log.warn('app-manifest', 'Skipping duplicate key', { filePath, key });
      continue;
    }
    seen.add(key);
    secrets.push({
      key,
      description: typeof s.description === 'string' ? s.description : '',
      required: !!s.required,
      // `private` is the canonical field; `sensitive` is accepted as
      // a backward-compatible alias. Either present (and truthy) flips
      // the entry to private. Internally we expose only `.private`.
      private: !!s.private || !!s.sensitive,
      default: typeof s.default === 'string' ? s.default : null,
      staging_default: typeof s.staging_default === 'string' ? s.staging_default : null,
    });
  }
  return secrets;
}

// Bounds for the optional top-level `name` field (see readName). Matches
// the rename flow's MAX_APP_NAME_LENGTH so a hand-written manifest name
// can't outrun the apps.name column or the rename UI's validation.
const MAX_APP_NAME_LENGTH = 64;
const MIN_APP_NAME_LENGTH = 1;

// Bound for a generated app SLUG, which — unlike the display name — ends up
// inside DNS labels the platform must be able to resolve (#1381):
//
//   usernode-app-<slug>            the production container name, resolved by
//                                  Caddy and by the screenshot capture
//   <slug>--s<sessionId>.<domain>  the staging preview host label
//
// A DNS label caps at 63 bytes and nothing will even send a query for a
// longer one. `usernode-app-` is 13, so 50 is the largest slug that keeps the
// production name legal, and it also leaves the preview host label at 60 for
// a seven-digit session id. Nothing here bounds the staging CONTAINER name,
// which is longer still — that one is unreachable by design now and carries a
// short network alias instead.
//
// Existing longer slugs are grandfathered: renaming an app does not re-slug
// it, and a slug is a permanent URL.
const MAX_APP_SLUG_LENGTH = 50;

// Build the slug for a newly created (or forked) app from its display name
// and a random suffix. The suffix is what makes the slug unique, so it is
// never what gets cut — the human-readable base is truncated around it, and a
// truncation that lands mid-word must not leave a trailing hyphen.
// Returns null when the name has no alphanumerics at all.
function buildAppSlug(name, code) {
  const base = String(name == null ? '' : name)
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) return null;
  const suffix = `-${String(code || '')}`;
  const room = MAX_APP_SLUG_LENGTH - suffix.length;
  const kept = base.length <= room ? base : base.slice(0, room).replace(/-+$/, '');
  return `${kept}${suffix}`;
}

// Normalize a raw top-level `name` into a trimmed string or null. Anything
// that isn't a string, is empty after trimming, or busts the length bound
// resolves to null — i.e. "no manifest name", so the platform name (the
// apps.name column) stays the effective display name. Never throws.
function readName(parsed) {
  const raw = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  if (raw.length < MIN_APP_NAME_LENGTH || raw.length > MAX_APP_NAME_LENGTH) return null;
  return raw;
}

// The top-level `description`: one line about what the app IS, which the
// join screen, Discover, the project page and the PWA manifest read off the
// stored manifest snapshot. Whitespace collapses to single spaces and the
// line is capped at MAX_DESCRIPTION_LENGTH (the longest any surface shows);
// anything else resolves to null. Never throws.
//
// read() used to leave it out, and every deploy snapshots read()'s output
// over `apps.manifest_snapshot`, so a description written into dapp.json
// never reached any of those surfaces: the first deploy dropped it.
//
// #3572: the create screen takes at most 90 characters (two lines of the hub
// hero on a phone; services/create-options.js DESCRIPTION_MAX). This reader
// does NOT hold a repository to that: an imported repo's line, or one a
// proposal lengthened, is kept up to 280 rather than failing the deploy, and
// each surface clamps what it draws to its lines.
const MAX_DESCRIPTION_LENGTH = 280;
function readDescription(parsed) {
  if (typeof parsed?.description !== 'string') return null;
  const text = parsed.description.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd() : text;
}

// Allowed values for the optional top-level `visibility` block (issue
// #124). `build` maps to apps.collab_visibility, `view` to
// apps.view_visibility — same value set as the DB columns.
const VISIBILITY_VALUES = new Set(['public', 'private']);

// Normalize the optional top-level `visibility` block:
//   "visibility": { "build": "public"|"private", "view": "public"|"private" }
// Each axis resolves independently to 'public', 'private', or null
// (= leave the platform value untouched — the same absent-field
// semantics as the top-level `name`). Lenient like the rest of the
// reader: a non-object block, an absent key, or any other value drops
// to null with a warn. Returns null when the block is absent or
// carries nothing usable. Never throws.
function readVisibility(parsed) {
  const raw = parsed?.visibility;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object visibility block');
    return null;
  }
  const norm = (axis) => {
    const v = raw[axis];
    if (v == null) return null;
    if (typeof v === 'string' && VISIBILITY_VALUES.has(v)) return v;
    log.warn('app-manifest', 'Ignoring invalid visibility value', { axis, value: v });
    return null;
  };
  const build = norm('build');
  const view = norm('view');
  if (build == null && view == null) return null;
  return { build, view };
}

// Human description of a (collab, view) visibility pair — shared by the
// reconcile chat message and the visibility-PR title so every surface
// describes the same state with the same words. Matches the wording the
// old direct-PATCH route used.
function describeVisibility(collab, view) {
  if (collab === 'public') return 'public';
  return view === 'private'
    ? 'private (collaborators only)'
    : 'invite-only build, public to view';
}

// Allowed values for the optional top-level `governance` block (issue
// #646). `approvers` maps to apps.approver_policy; `approvals` maps to
// apps.approvals_required (NULL = the default time-&-majority
// strategy, N = "at least N" mode).
const APPROVER_POLICY_VALUES = new Set(['anyone', 'invited']);
const MAX_APPROVALS_REQUIRED = 50;

// Normalize the optional top-level `governance` block:
//   "governance": {
//     "approvers": "anyone" | "invited",
//     "approvals": "default" | { "atLeast": 1 }
//   }
// Each axis resolves independently:
//   - approvers → 'anyone' | 'invited' | null (leave untouched),
//   - approvals → 'default' | <int 1..50> | null (leave untouched),
// with the same absent-field semantics as the `visibility` block.
// Lenient like the rest of the reader: a non-object block, an absent
// key, or any invalid value drops to null with a warn. Returns null
// when the block is absent or carries nothing usable. Never throws.
function readGovernance(parsed) {
  const raw = parsed?.governance;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object governance block');
    return null;
  }
  let approvers = null;
  if (raw.approvers != null) {
    if (typeof raw.approvers === 'string' && APPROVER_POLICY_VALUES.has(raw.approvers)) {
      approvers = raw.approvers;
    } else {
      log.warn('app-manifest', 'Ignoring invalid governance.approvers value', { value: raw.approvers });
    }
  }
  let approvals = null;
  if (raw.approvals != null) {
    if (raw.approvals === 'default') {
      approvals = 'default';
    } else if (raw.approvals && typeof raw.approvals === 'object' && !Array.isArray(raw.approvals)
      && Number.isInteger(raw.approvals.atLeast)
      && raw.approvals.atLeast >= 1 && raw.approvals.atLeast <= MAX_APPROVALS_REQUIRED) {
      approvals = raw.approvals.atLeast;
    } else {
      log.warn('app-manifest', 'Ignoring invalid governance.approvals value', { value: raw.approvals });
    }
  }
  // #4666: `preset`, or `groups` + `rules` (services/governance-rules.js).
  // A block that carries either is decided by them, and its old two keys
  // are not read: the rules replace them. One that cannot be read is
  // reported and dropped, so the project keeps the rule it has.
  const { value: rules, error: rulesError } = governanceRules.readRulesBlock(raw);
  if (rulesError) log.warn('app-manifest', 'Ignoring invalid governance rules', { error: rulesError });
  if (rules) return { approvers: null, approvals: null, rules };
  if (approvers == null && approvals == null) return null;
  return { approvers, approvals };
}

// Human description of a (policy, approvalsRequired) governance pair —
// shared by the reconcile chat message and the governance-PR title so
// every surface describes the same state with the same words. Sibling
// of describeVisibility above.
function describeGovernance(policy, approvalsRequired) {
  const who = policy === 'invited' ? 'invited approvers' : 'any user';
  const howMany = approvalsRequired != null
    ? `at least ${approvalsRequired} approval${approvalsRequired === 1 ? '' : 's'}`
    : 'the default time-&-majority vote';
  return `approvals by ${who}, requiring ${howMany}`;
}

// Bounds for the optional top-level `admins` block (issue #788). The
// cap keeps a hand-written (or generated) manifest from turning into an
// unbounded roster; 255 mirrors the users.username column width.
const MAX_APP_ADMINS = 20;
const MAX_ADMIN_USERNAME_LENGTH = 255;

// Normalize the optional top-level `admins` block:
//   "admins": ["alice", "bob"]
// A bare array of platform usernames. Semantics deliberately differ
// from `icon` (fully authoritative including absence) and match
// `name` / `visibility` on the ABSENCE side only:
//   - absent key / null / non-array  -> null, i.e. "leave the platform
//     roster untouched" (a clean no-op for every app that never
//     declares the block);
//   - a valid array, INCLUDING []    -> the declared list, which the
//     reconcile treats as fully authoritative set semantics. `[]` is
//     therefore how a roster is cleared — without that, revocation
//     would be inexpressible.
// Entries are trimmed, dropped when empty / over-long / not a string,
// and deduped case-insensitively (first occurrence wins the display
// casing, since usernames are matched case-insensitively at reconcile
// time). Over-cap entries are dropped with a warn rather than silently
// truncated, per readTests. Lenient like the rest of the reader; never
// throws.
function readAdmins(parsed) {
  const raw = parsed?.admins;
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-array admins block', { value: typeof raw });
    return null;
  }
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!name || name.length > MAX_ADMIN_USERNAME_LENGTH) { dropped++; continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= MAX_APP_ADMINS) { dropped++; continue; }
    seen.add(key);
    out.push(name);
  }
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-cap admin entries', {
      dropped, kept: out.length, cap: MAX_APP_ADMINS,
    });
  }
  return out;
}

// Human description of a declared admin roster — shared by the
// reconcile chat message and any future admins-PR title so every
// surface describes the same state with the same words. Sibling of
// describeVisibility / describeGovernance.
function describeAdmins(usernames) {
  const list = Array.isArray(usernames) ? usernames.filter((u) => typeof u === 'string' && u.trim()) : [];
  if (!list.length) return 'no per-app admins (only the creator and platform admins)';
  return list.map((u) => `@${u}`).join(', ');
}

// Bound on the consent dialog's purpose line — one short sentence, not
// a marketing paragraph.
const MAX_LLM_PURPOSE_LENGTH = 140;

// Normalize the optional top-level `llm` block (issue #34) — consent
// metadata for the platform's app-LLM proxy:
//   "llm": {
//     "purpose": "Summarizes long threads for you",
//     "suggested_daily_cap_cents": 300
//   }
// `purpose` is shown in the platform's consent dialog; the suggested
// cap pre-fills the dialog's editable cap field (instead of the $1.00
// default). Both presentation-only — the dialog's server-side grant
// validation is the authority on what cap actually gets stored, and
// the user can always edit the pre-fill. Lenient like everything else
// here: garbage values (non-string purpose, non-positive or
// non-integer cap) are dropped, an absent/empty block resolves to
// null and the dialog falls back to generic copy. Never throws.
function readLlm(parsed) {
  const raw = parsed?.llm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const purpose = typeof raw.purpose === 'string' && raw.purpose.trim()
    ? raw.purpose.trim().slice(0, MAX_LLM_PURPOSE_LENGTH)
    : null;
  const cap = raw.suggested_daily_cap_cents;
  const suggestedCap = Number.isInteger(cap) && cap > 0 ? cap : null;
  if (purpose == null && suggestedCap == null) return null;
  const out = {};
  if (purpose != null) out.purpose = purpose;
  if (suggestedCap != null) out.suggested_daily_cap_cents = suggestedCap;
  return out;
}

// Bound on a permission's reason line, same budget as the LLM consent
// dialog's purpose above: one short sentence, not a paragraph.
const MAX_PERMISSION_REASON_LENGTH = 140;

// Normalize the optional top-level `permissions` block (#2219) — the
// browser capabilities this app may ASK the platform for:
//   "permissions": [
//     "geolocation",
//     { "capability": "microphone", "reason": "Records your voice notes" }
//   ]
// A bare string and the object form mean the same thing; `reason` is the
// app's own one-line explanation, shown in the platform's permission
// prompt exactly as `llm.purpose` is shown in the AI one.
//
// DECLARING IS NOT BEING GRANTED. This list only bounds what the app is
// allowed to ask for: services/app-permissions.js gates the capability
// itself on a per-user grant, and an undeclared capability is refused
// before any prompt is shown. That is deliberate — it is what puts the
// set of capabilities an app can ever reach into its own diff, where the
// group reviewing a proposal can see it.
//
// Lenient like every other reader here: unknown capability names (a typo,
// or a Permissions Policy feature the platform does not gate) are dropped
// rather than thrown, a non-array block resolves to [] and duplicates
// collapse. normalizeCapabilities settles the ordering, so the stored
// snapshot is stable regardless of how the manifest listed them.
function readPermissions(parsed) {
  const raw = parsed?.permissions;
  if (!Array.isArray(raw)) {
    if (raw != null) log.warn('app-manifest', 'Ignoring non-array permissions block');
    return [];
  }
  const reasons = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = entry.capability;
    if (typeof name !== 'string') continue;
    const reason = typeof entry.reason === 'string' && entry.reason.trim()
      ? entry.reason.trim().slice(0, MAX_PERMISSION_REASON_LENGTH)
      : null;
    if (reason != null) reasons.set(name, reason);
  }
  const names = appPermissions.normalizeCapabilities(raw);
  // Count what the catalogue actually REFUSED, not what collapsing
  // duplicates removed — a manifest listing one capability twice is
  // untidy, not a misconfiguration worth a warning.
  const dropped = raw.filter((entry) => !appPermissions.isGatedCapability(
    typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.capability : null)
  )).length;
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped unrecognized permission entries', { dropped });
  }
  return names.map((capability) => ({
    capability,
    reason: reasons.get(capability) || null,
  }));
}

// Allowed device-scale values for the optional top-level `screenshot`
// block (issue #360). The platform's before/after preview screenshots
// default to 2× (HiDPI/retina); an app declares `1` to opt its previews
// back to standard density (pixel art, deliberately low-res canvases).
const SCREENSHOT_SCALE_VALUES = new Set([1, 2]);
const DEFAULT_SCREENSHOT_SCALE = 2;

// Normalize the optional top-level `screenshot` block:
//   "screenshot": { "deviceScaleFactor": 1 }
// Resolves to a `{ deviceScaleFactor: 1 | 2 }` object. Default is 2×
// (HiDPI) for everything that says nothing — a non-object block, an
// absent/garbage `deviceScaleFactor`, or any value other than 1/2 drops
// to 2 (with a warn for an explicitly-invalid value). Always returns an
// object so the deploy-time reconcile always has a concrete scale to
// write. Lenient like the rest of the reader; never throws.
function readScreenshot(parsed) {
  const raw = parsed?.screenshot;
  if (raw == null) return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object screenshot block');
    return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  }
  const v = raw.deviceScaleFactor;
  if (v == null) return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  if (typeof v === 'number' && SCREENSHOT_SCALE_VALUES.has(v)) {
    return { deviceScaleFactor: v };
  }
  log.warn('app-manifest', 'Ignoring invalid screenshot.deviceScaleFactor', { value: v });
  return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
}

// Bounds for the optional top-level `icon` block. The emoji cap of 16
// UTF-16 code units covers ZWJ sequences (👨‍👩‍👧‍👦 is 11) without letting a
// paragraph through; ASCII is deliberately NOT banned — keycap emoji
// like 1️⃣ contain a digit, and a silly non-emoji string is harmless
// (it's the app's own tile and changes arrive via voted PRs). The
// image byte cap is generous for a tile rendered at 56 CSS px (112 px
// at 2×) while keeping the app_icons rows small.
const MAX_ICON_EMOJI_LENGTH = 16;
const MAX_ICON_IMAGE_PATH_LENGTH = 256;
const MAX_ICON_IMAGE_BYTES = 256 * 1024;

// Magic-byte sniffing for the icon image — the committed file's bytes,
// not its extension, decide the served Content-Type. SVG is deliberately
// absent: served inline it can execute script when navigated directly.
function sniffIconContentType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Validate the icon block's `image` value: a repo-relative file path.
// Anything absolute, traversing, scheme-ish, or containing whitespace /
// backslashes resolves to null (the realpath containment check in
// loadIconImage is the authoritative escape guard; this just rejects
// the obviously-wrong shapes early with a warn).
function normalizeIconImagePath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p || p.length > MAX_ICON_IMAGE_PATH_LENGTH) return null;
  if (p.startsWith('/') || p.includes('\\') || /\s/.test(p)) return null;
  if (p.includes('://') || p.startsWith('data:')) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return p;
}

// A project's colour, as dapp.json may set it beside its icon: a hex
// colour, #rgb or #rrggbb, stored lower-case and expanded to six digits. The
// page it tints darkens it until white text on it is readable, so any hex is
// accepted here; anything else is ignored with a warn.
function normalizeIconColor(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${hex}`;
}

// Normalize the optional top-level `icon` block:
//   "icon": { "emoji": "🎮" }  or  "icon": { "image": "public/icon.png" }
//   plus, optionally, "color": "#2e6660" (the project's colour)
// Returns `{ emoji, image, color }` (each string-or-null) or null when the
// block is absent / carries nothing usable. Both keys are retained when
// both are valid — the image takes precedence at reconcile time, with
// the emoji as the fallback should the committed file fail validation.
// Lenient like the rest of the reader; never throws.
function readIcon(parsed) {
  const raw = parsed?.icon;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object icon block');
    return null;
  }
  let emoji = null;
  if (raw.emoji != null) {
    const e = typeof raw.emoji === 'string' ? raw.emoji.trim() : '';
    if (e.length >= 1 && e.length <= MAX_ICON_EMOJI_LENGTH && !/\s/.test(e)) {
      emoji = e;
    } else {
      log.warn('app-manifest', 'Ignoring invalid icon.emoji', { value: raw.emoji });
    }
  }
  let image = null;
  if (raw.image != null) {
    image = normalizeIconImagePath(raw.image);
    if (!image) log.warn('app-manifest', 'Ignoring invalid icon.image path', { value: raw.image });
  }
  let color = null;
  if (raw.color != null) {
    color = normalizeIconColor(raw.color);
    if (!color) log.warn('app-manifest', 'Ignoring invalid icon.color', { value: raw.color });
  }
  if (emoji != null && image != null) {
    log.warn('app-manifest', 'icon declares both emoji and image; image takes precedence');
  }
  if (emoji == null && image == null && color == null) return null;
  return { emoji, image, color };
}

// ── Topics (#4417) ──────────────────────────────────────────────────────
//
// The optional top-level `topics` array: a project's lasting conversations,
// each a channel and a category at once.
//
//   "topics": [
//     { "id": "onboarding", "handle": "onboarding", "name": "Onboarding",
//       "icon": "🚪", "about": "Signing up and the first week" },
//     { "id": "signup", "handle": "signup", "name": "Sign-up",
//       "mergedInto": "onboarding" },
//     { "id": "old", "handle": "old", "name": "Old things", "archived": true }
//   ]
//
//   id          set once and never changed: the CATEGORY KEY, so the
//               literal value a category vote carries. No rename moves a
//               vote.
//   handle      the channel's name: 2 to 32 lowercase letters, digits and
//               hyphens, starting with a letter (a `#123` is an issue, so a
//               `#handle` reference has to begin with one), unique in the
//               project and never `general`. A rename may change it; the
//               reconcile keeps the old one as an alias.
//   name        3 to 48 characters (topic-attributes MAX_CATEGORY_LEN).
//   icon        one emoji, optional.
//   about       up to 140 characters, optional.
//   archived    true keeps a retired topic in the file, so its channel and
//               history keep their key; read-only from then on.
//   mergedInto  the id of the LIVE topic it was merged into: never itself,
//               never a topic that was itself merged or archived.
//   figures     optional: up to twelve figure ids from services/topic-figures.js,
//               the numbers the channel shows above its room. An unknown id
//               is an error; the reader keeps the known ones.
//
// The array's order is the list's order. At most MAX_LIVE_TOPICS live.
//
// Inside the platform a topic is a category row with origin 'topic'
// (app_category_registry), its channel a 'category' thread: "topic" already
// names one request or proposal in this code (topic_attribute_votes).
const MAX_LIVE_TOPICS = 12;
// Retired entries stay in the file, so the whole array is bounded too.
const MAX_TOPIC_ENTRIES = 64;
const MIN_TOPIC_NAME_LENGTH = 3;
const MAX_TOPIC_NAME_LENGTH = 48;
const MAX_TOPIC_ABOUT_LENGTH = 140;
const TOPIC_HANDLE_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const RESERVED_TOPIC_HANDLES = new Set(['general']);
// The built-in categories (services/topic-attributes.js CATEGORY_VALUES):
// a topic's id is a category key, so it may not be one of those six.
const BUILTIN_CATEGORY_KEYS = new Set(['feature', 'bug', 'improvement', 'design', 'docs', 'chore']);

/** One emoji: a single grapheme with a pictograph in it, or a keycap. */
function isOneEmoji(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > MAX_ICON_EMOJI_LENGTH || /\s/.test(s)) return false;
  const keycap = /^[0-9#*]️?⃣$/.test(s);
  if (!keycap && !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;
  if (!keycap && /[A-Za-z0-9]/.test(s)) return false;
  try {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return [...seg.segment(s)].length === 1;
  } catch {
    return true;
  }
}

/** A topic handle as dapp.json may spell it, normalised, or null. */
function normalizeTopicHandle(raw) {
  const h = typeof raw === 'string' ? raw.trim().replace(/^#/, '').toLowerCase() : '';
  return TOPIC_HANDLE_RE.test(h) && !RESERVED_TOPIC_HANDLES.has(h) ? h : null;
}

/**
 * Validate a `topics` array. Returns `{ topics, errors }`: the entries that
 * hold, normalised to `{ id, handle, name, icon, about, state, mergedInto }`
 * (and `figures`, when the entry names any)
 * in the file's order, and one sentence per problem. STRICT callers (the
 * topics PR, services/topics-pr.js) refuse on any error; the deploy reader
 * (readTopics) keeps what holds and logs the rest, like every other block.
 *
 * Cross-entry rules are applied in order: a duplicate id or handle is the
 * later entry's error, live entries past MAX_LIVE_TOPICS are errors, and a
 * `mergedInto` that names no live topic is an error (the reader keeps such
 * an entry as archived, so its history stays readable and no vote moves).
 */
function validateTopics(raw) {
  const errors = [];
  if (raw == null) return { topics: [], errors };
  if (!Array.isArray(raw)) return { topics: [], errors: ['topics must be an array'] };
  if (raw.length > MAX_TOPIC_ENTRIES) {
    errors.push(`topics holds at most ${MAX_TOPIC_ENTRIES} entries`);
  }
  const out = [];
  const ids = new Set();
  const handles = new Set();
  raw.slice(0, MAX_TOPIC_ENTRIES).forEach((entry, index) => {
    const where = `topics[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!TOPIC_HANDLE_RE.test(id)) {
      errors.push(`${where}.id must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter`);
      return;
    }
    if (BUILTIN_CATEGORY_KEYS.has(id)) {
      errors.push(`${where}.id "${id}" is a built-in category`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${where}.id "${id}" is used twice`);
      return;
    }
    const handle = normalizeTopicHandle(entry.handle == null ? id : entry.handle);
    if ((entry.handle != null && typeof entry.handle !== 'string') || !handle) {
      errors.push(`${where}.handle must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter, and never "general"`);
      return;
    }
    if (handles.has(handle)) {
      errors.push(`${where}.handle "#${handle}" is used twice`);
      return;
    }
    const name = typeof entry.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim() : '';
    if (name.length < MIN_TOPIC_NAME_LENGTH || name.length > MAX_TOPIC_NAME_LENGTH) {
      errors.push(`${where}.name must be ${MIN_TOPIC_NAME_LENGTH} to ${MAX_TOPIC_NAME_LENGTH} characters`);
      return;
    }
    let icon = '';
    if (entry.icon != null && entry.icon !== '') {
      if (!isOneEmoji(entry.icon)) {
        errors.push(`${where}.icon must be one emoji`);
        return;
      }
      icon = entry.icon.trim();
    }
    let about = '';
    if (entry.about != null) {
      about = typeof entry.about === 'string' ? entry.about.replace(/\s+/g, ' ').trim() : null;
      if (about == null || about.length > MAX_TOPIC_ABOUT_LENGTH) {
        errors.push(`${where}.about must be at most ${MAX_TOPIC_ABOUT_LENGTH} characters`);
        return;
      }
    }
    let mergedInto = null;
    if (entry.mergedInto != null) {
      mergedInto = typeof entry.mergedInto === 'string' ? entry.mergedInto.trim() : '';
      if (!mergedInto) {
        errors.push(`${where}.mergedInto must name a topic id`);
        return;
      }
    }
    if (entry.archived != null && typeof entry.archived !== 'boolean') {
      errors.push(`${where}.archived must be true or false`);
      return;
    }
    // Figures never cost a topic its place: an unknown id is an error for
    // the strict callers, and the reader keeps the ids it knows.
    let figures = [];
    if (entry.figures != null) {
      if (!Array.isArray(entry.figures) || entry.figures.some((f) => typeof f !== 'string')) {
        errors.push(`${where}.figures must be a list of figure ids`);
      } else {
        const unknown = entry.figures.filter((f) => !topicFigures.isFigureId(f));
        if (unknown.length) errors.push(`${where}.figures names an unknown figure: ${unknown.join(', ')}`);
        if (entry.figures.length > topicFigures.MAX_TOPIC_FIGURES) {
          errors.push(`${where}.figures holds at most ${topicFigures.MAX_TOPIC_FIGURES} figures`);
        }
        figures = topicFigures.knownFigureIds(entry.figures);
      }
    }
    ids.add(id);
    handles.add(handle);
    out.push({
      id, handle, name, icon, about,
      state: mergedInto ? 'merged' : (entry.archived === true ? 'archived' : 'live'),
      mergedInto,
      ...(figures.length ? { figures } : {}),
    });
  });
  // A merge names a LIVE topic: never itself, never one that was itself
  // merged or archived. An entry that fails is kept, as archived, so it
  // moves no vote and its channel stays readable.
  const live = new Set(out.filter((t) => t.state === 'live').map((t) => t.id));
  for (const t of out) {
    if (t.state !== 'merged') continue;
    if (t.mergedInto === t.id || !live.has(t.mergedInto)) {
      errors.push(`topic "${t.id}" can only be merged into a live topic`);
      t.state = 'archived';
      t.mergedInto = null;
    }
  }
  let liveCount = 0;
  const kept = [];
  for (const t of out) {
    if (t.state === 'live') {
      liveCount += 1;
      if (liveCount > MAX_LIVE_TOPICS) {
        errors.push(`a project has at most ${MAX_LIVE_TOPICS} live topics`);
        continue;
      }
    }
    kept.push(t);
  }
  return { topics: kept, errors: [...new Set(errors)] };
}

// The deploy reader's view: what holds, the rest logged. `null` when the
// block is absent, which leaves the project's topics as they are; an empty
// array archives every topic it had.
function readTopics(parsed) {
  if (!parsed || parsed.topics === undefined || parsed.topics === null) return null;
  const { topics, errors } = validateTopics(parsed.topics);
  if (errors.length) log.warn('app-manifest', 'Ignoring part of the topics block', { errors: errors.slice(0, 10) });
  if (!Array.isArray(parsed.topics)) return null;
  return topics;
}

function read(cloneDir) {
  const filePath = path.join(cloneDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { name: null, description: null, secrets: [], llm: null, permissions: [], visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [], topics: null };
    log.warn('app-manifest', 'Read failed (treating as empty)', { filePath, err: err.message });
    return { name: null, description: null, secrets: [], llm: null, permissions: [], visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [], topics: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('app-manifest', 'Parse failed (treating as empty)', { filePath, err: err.message });
    return { name: null, description: null, secrets: [], llm: null, permissions: [], visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [], topics: null };
  }

  const platformEnv = readPlatformEnv(parsed);
  const secrets = readSecrets(parsed, { platformEnv, filePath });

  return {
    name: readName(parsed),
    description: readDescription(parsed),
    secrets,
    llm: readLlm(parsed),
    permissions: readPermissions(parsed),
    visibility: readVisibility(parsed),
    governance: readGovernance(parsed),
    screenshot: readScreenshot(parsed),
    tests: readTests(parsed),
    icon: readIcon(parsed),
    admins: readAdmins(parsed),
    platform_env: platformEnv,
    topics: readTopics(parsed),
  };
}

/**
 * Write-through name resolution. Given a freshly-read manifest and the
 * app row it was read for, reconcile `apps.name` to the manifest's
 * top-level `name` when one is present and differs (case-sensitively)
 * from the stored name. This is how a `dapp.json` name takes precedence
 * over the platform name: it's resolved once, at deploy time, so the
 * large surface of display sites that read `apps.name` directly keeps
 * working unchanged.
 *
 * No-op (returns false) when the manifest carries no name — existing
 * apps with no `name` in `dapp.json` keep their platform name exactly.
 * Broadcasts the existing `app_update` `renamed` event on a real change
 * so connected clients update live (public/js/app.js handleAppUpdate).
 *
 * Best-effort and self-contained: a DB or WS hiccup here must never
 * fail the deploy that called it, so callers fire-and-log.
 */
async function reconcileAppName(pool, app, manifest) {
  const manifestName = manifest && typeof manifest.name === 'string' ? manifest.name : null;
  if (!manifestName) return false;
  const oldName = app.name || '';
  if (manifestName === oldName) return false;

  await pool.query('UPDATE apps SET name = $1 WHERE id = $2', [manifestName, app.id]);
  log.info('app-manifest', 'Reconciled app name from dapp.json', {
    appId: app.id, slug: app.slug, oldName, newName: manifestName,
  });

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'renamed',
      appId: app.id,
      slug: app.slug,
      oldName,
      newName: manifestName,
    });
  } catch (err) {
    log.warn('app-manifest', 'Rename broadcast failed', { appId: app.id, err: err.message });
  }
  return true;
}

/**
 * #4417: reconcile dapp.json's `topics` into the app's category registry,
 * on the rebuild a merged topics PR triggers (staging.deployProduction),
 * on an import's first deploy, and at boot for the platform's own app.
 *
 * Each topic is the registry row whose category_key is its `id`, origin
 * 'topic', pinned. What changes, and what follows from it:
 *
 *   add      a new row, or an existing category of the same key becomes the
 *            topic (its votes are the topic's from then on);
 *   rename   name, about, icon and handle are written; a changed handle
 *            keeps the old one in topic_aliases. No vote moves: the id is
 *            what a vote carries;
 *   merge    the topic is retired into the survivor: every category vote
 *            for it moves to the survivor (a voter who already backs the
 *            survivor on that card keeps that vote and loses the old one),
 *            and so do the Workshop's placements;
 *   archive  the topic is retired: its votes stay (the tally skips them),
 *            and its placements are dropped, so the cards count as churn
 *            and are placed again.
 *
 * A topic missing from the file is archived, so its channel stays readable.
 * An ABSENT block (`topics: null`) changes nothing.
 *
 * Writes only what differs, and returns what it did:
 * `{ added, renamed, merged, archived, revived, changed }` (null for an
 * absent block). Best-effort like its siblings: callers fire-and-log.
 */
async function reconcileAppTopics(pool, app, manifest) {
  const topics = manifest && Array.isArray(manifest.topics) ? manifest.topics : null;
  if (!topics || !app || !app.id) return null;
  const { rows } = await pool.query(
    `SELECT id, category_key, origin, label, description, icon, topic_handle, topic_aliases,
            topic_state, merged_into, topic_order, retired_at, topic_figures
       FROM app_category_registry
      WHERE app_id = $1`,
    [app.id]
  );
  const byKey = new Map(rows.map((r) => [r.category_key, r]));
  const handlesNow = new Set(topics.map((t) => t.handle));
  const aliasTaken = new Set();
  const result = { added: [], renamed: [], merged: [], archived: [], revived: [], changed: false };
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  for (let order = 0; order < topics.length; order += 1) {
    const t = topics[order];
    const row = byKey.get(t.id) || null;
    const wasTopic = !!row && row.origin === 'topic';
    const prevState = wasTopic ? (row.topic_state || 'live') : null;
    // Aliases: the old ones, less any that is somebody's handle now or
    // another topic's alias already, plus the handle this one just left.
    const aliases = [];
    const keep = (a) => {
      if (!a || a === t.handle || handlesNow.has(a) || aliasTaken.has(a) || aliases.includes(a)) return;
      aliases.push(a);
    };
    for (const a of (wasTopic && Array.isArray(row.topic_aliases) ? row.topic_aliases : [])) keep(a);
    if (wasTopic && row.topic_handle && row.topic_handle !== t.handle) keep(row.topic_handle);
    for (const a of aliases) aliasTaken.add(a);

    const differs = !wasTopic
      || row.label !== t.name || (row.description || '') !== t.about || (row.icon || '') !== t.icon
      || row.topic_handle !== t.handle || !sameList(row.topic_aliases || [], aliases)
      || prevState !== t.state || (row.merged_into || null) !== (t.mergedInto || null)
      || row.topic_order !== order || (t.state === 'live') !== (row.retired_at == null)
      || !sameList(row.topic_figures || [], t.figures || []);
    if (!differs) continue;

    await pool.query(
      `INSERT INTO app_category_registry
         (app_id, category_key, label, description, icon, origin, pinned_at, retired_at,
          topic_handle, topic_aliases, topic_state, merged_into, merged_at, topic_order, topic_figures)
       VALUES ($1, $2, $3, $4, $5, 'topic', NOW(),
               CASE WHEN $8::text = 'live' THEN NULL ELSE NOW() END,
               $6, $7::text[], $8, $9, CASE WHEN $8::text = 'merged' THEN NOW() ELSE NULL END, $10, $11::text[])
       ON CONFLICT (app_id, category_key) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         origin = 'topic',
         pinned_at = COALESCE(app_category_registry.pinned_at, NOW()),
         retired_at = CASE WHEN EXCLUDED.topic_state = 'live' THEN NULL
                           ELSE COALESCE(app_category_registry.retired_at, NOW()) END,
         topic_handle = EXCLUDED.topic_handle,
         topic_aliases = EXCLUDED.topic_aliases,
         topic_state = EXCLUDED.topic_state,
         merged_into = EXCLUDED.merged_into,
         merged_at = CASE
           WHEN EXCLUDED.topic_state <> 'merged' THEN NULL
           WHEN app_category_registry.topic_state = 'merged'
            AND app_category_registry.merged_into IS NOT DISTINCT FROM EXCLUDED.merged_into
             THEN COALESCE(app_category_registry.merged_at, NOW())
           ELSE NOW() END,
         topic_order = EXCLUDED.topic_order,
         topic_figures = EXCLUDED.topic_figures`,
      [app.id, t.id, t.name, t.about, t.icon, t.handle, aliases, t.state, t.mergedInto, order, t.figures || []]
    );
    result.changed = true;
    if (!wasTopic) result.added.push(t.id);
    else if (row.topic_handle !== t.handle || row.label !== t.name
      || (row.description || '') !== t.about || (row.icon || '') !== t.icon) result.renamed.push(t.id);
    if (prevState && prevState !== 'live' && t.state === 'live') result.revived.push(t.id);

    if (t.state === 'merged' && (prevState !== 'merged' || (row.merged_into || null) !== t.mergedInto)) {
      await moveCategory(pool, app.id, t.id, t.mergedInto);
      result.merged.push({ from: t.id, into: t.mergedInto });
    } else if (t.state === 'archived' && prevState !== 'archived') {
      await dropPlacements(pool, app.id, t.id);
      result.archived.push(t.id);
    }
  }

  // A topic the file no longer names is archived, never deleted: its
  // channel's history stays readable under its key.
  const inFile = new Set(topics.map((t) => t.id));
  for (const row of rows) {
    if (row.origin !== 'topic' || inFile.has(row.category_key) || row.topic_state === 'archived') continue;
    await pool.query(
      `UPDATE app_category_registry
          SET topic_state = 'archived', retired_at = COALESCE(retired_at, NOW()),
              merged_into = NULL, merged_at = NULL
        WHERE id = $1 AND app_id = $2`,
      [row.id, app.id]
    );
    if ((row.topic_state || 'live') === 'live') await dropPlacements(pool, app.id, row.category_key);
    result.archived.push(row.category_key);
    result.changed = true;
  }

  if (result.changed) {
    log.info('app-manifest', 'Reconciled topics from dapp.json', {
      appId: app.id, slug: app.slug,
      added: result.added, renamed: result.renamed, merged: result.merged, archived: result.archived,
    });
    // Open pages re-read the places and the Workshop regroups (a merge or
    // an archive moved placements; a new topic is a category to place
    // into). Best-effort.
    try {
      require('./ws').pushAppUpdate({ action: 'topics_changed', appId: app.id, appSlug: app.slug, slug: app.slug });
    } catch (err) {
      log.warn('app-manifest', 'Topics broadcast failed', { appId: app.id, err: err.message });
    }
    try {
      require('./workshop-themes').noteBoardChange(pool, { appId: app.id, appSlug: app.slug });
    } catch (err) {
      log.warn('app-manifest', 'Workshop regroup after topics failed', { appId: app.id, err: err.message });
    }
  }
  return result;
}

// A merge: every category vote for `from` becomes one for `into`. A voter
// who already backs `into` on that card keeps that vote and loses this one
// (only possible for rows without a voter, given the one-vote-per-field
// key, but said in SQL rather than assumed). Then the Workshop's placements
// follow, and the merged definition leaves the draft.
async function moveCategory(pool, appId, from, into) {
  await pool.query(
    `DELETE FROM topic_attribute_votes v
      WHERE v.app_id = $1 AND v.field = 'category' AND v.value = $2
        AND EXISTS (
          SELECT 1 FROM topic_attribute_votes o
           WHERE o.app_id = v.app_id AND o.target_type = v.target_type
             AND o.target_ref = v.target_ref AND o.field = 'category'
             AND o.value = $3 AND o.user_id IS NOT DISTINCT FROM v.user_id
        )`,
    [appId, from, into]
  );
  await pool.query(
    `UPDATE topic_attribute_votes SET value = $3
      WHERE app_id = $1 AND field = 'category' AND value = $2`,
    [appId, from, into]
  );
  await pool.query(
    `UPDATE app_workshop_themes
        SET placements_json = COALESCE((
              SELECT jsonb_object_agg(e.key, CASE WHEN e.value = to_jsonb($2::text) THEN to_jsonb($3::text) ELSE e.value END)
                FROM jsonb_each(placements_json) e
            ), '{}'::jsonb),
            themes_json = COALESCE((
              SELECT jsonb_agg(d.def ORDER BY d.n)
                FROM jsonb_array_elements(themes_json) WITH ORDINALITY AS d(def, n)
               WHERE d.def->>'id' IS DISTINCT FROM $2::text
            ), '[]'::jsonb)
      WHERE app_id = $1`,
    [appId, from, into]
  );
}

// An archive: the Workshop forgets where it put the topic's cards, and its
// definition leaves the draft. The cards are then new to the next pass,
// which counts them as churn and places them again.
async function dropPlacements(pool, appId, key) {
  await pool.query(
    `UPDATE app_workshop_themes
        SET placements_json = COALESCE((
              SELECT jsonb_object_agg(e.key, e.value)
                FROM jsonb_each(placements_json) e
               WHERE e.value IS DISTINCT FROM to_jsonb($2::text)
            ), '{}'::jsonb),
            themes_json = COALESCE((
              SELECT jsonb_agg(d.def ORDER BY d.n)
                FROM jsonb_array_elements(themes_json) WITH ORDINALITY AS d(def, n)
               WHERE d.def->>'id' IS DISTINCT FROM $2::text
            ), '[]'::jsonb)
      WHERE app_id = $1`,
    [appId, key]
  );
}

/**
 * Apply a visibility change to an app row with the full transition
 * semantics the old direct-PATCH route had (issue #124 moved the
 * authority into dapp.json, so this now lives here, shared by the
 * deploy-time reconcile below and any future caller):
 *   - UPDATE both columns;
 *   - collab private→public: pending invites become meaningless —
 *     delete them, mark their drawer notifications read, ping clients;
 *   - flush the WS-broadcast / edge-gate visibility caches;
 *   - group-chat system message + `visibility_changed` app update;
 *   - VISIBILITY_CHANGED analytics event.
 * `app` must carry id, slug, collab_visibility, view_visibility (the
 * CURRENT values — used for the transition checks and the event's
 * `from`). All side effects beyond the column UPDATE are best-effort.
 */
async function applyVisibilityChange(pool, app, { collab, view }, { actorLabel = 'dapp.json', userId = null } = {}) {
  await pool.query(
    `UPDATE apps SET collab_visibility = $1, view_visibility = $2 WHERE id = $3`,
    [collab, view, app.id]
  );

  // collab private → public: pending invites become meaningless.
  // Delete them and resolve their drawer notifications.
  if (app.collab_visibility === 'private' && collab === 'public') {
    try {
      const { rows: pending } = await pool.query(
        `DELETE FROM app_collaborators WHERE app_id = $1 AND status = 'invited'
         RETURNING user_id`,
        [app.id]
      );
      const notifications = require('./notifications');
      const { pushNotificationToUser } = require('./ws');
      for (const p of pending) {
        await notifications.markInviteNotificationsRead(pool, p.user_id, app.id)
          .catch(() => {});
        try { pushNotificationToUser(p.user_id, { type: 'notifications_changed' }); } catch {}
      }
    } catch (err) {
      log.warn('app-manifest', 'Pending-invite cleanup failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./app-access').invalidateVisibility(app.id, app.slug);
  } catch (err) {
    log.warn('app-manifest', 'Visibility cache invalidation failed', { appId: app.id, err: err.message });
  }

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'visibility_changed',
      appSlug: app.slug,
      appId: app.id,
      collabVisibility: collab,
      viewVisibility: view,
    });
  } catch (err) {
    log.warn('app-manifest', 'Visibility broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.VISIBILITY_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: { collab: app.collab_visibility, view: app.view_visibility },
        to: { collab, view },
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Visibility event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied visibility change', {
    appId: app.id, slug: app.slug, collab, view, actorLabel,
  });
}

/**
 * Deploy-time visibility reconcile — sibling of reconcileAppName. The
 * manifest's optional top-level `visibility` block is the source of
 * truth for apps.collab_visibility ("build") / apps.view_visibility
 * ("view"); an absent block / axis leaves the platform value untouched.
 *
 * Re-reads the app row fresh (callers pass rows of varying width and
 * the columns here must be current), resolves the target pair, and:
 *   - no-ops when nothing changes, when the manifest carries no
 *     visibility, or for self_hosted apps (the platform's own row stays
 *     out of repo control, matching the old PATCH route's refusal);
 *   - skips with a warn when the resolved pair violates the invariant
 *     (build=public AND view=private — the DB CHECK would reject it);
 *   - otherwise applies via applyVisibilityChange above.
 *
 * Best-effort like reconcileAppName: callers fire-and-log; a failure
 * here must never fail the deploy.
 */
async function reconcileAppVisibility(pool, app, manifest) {
  const vis = manifest?.visibility;
  if (!vis || (vis.build == null && vis.view == null)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, self_hosted, collab_visibility, view_visibility FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  if (cur.self_hosted) {
    log.warn('app-manifest', 'Skipping visibility reconcile for self-hosted app', { appId: cur.id });
    return false;
  }

  const collab = vis.build || cur.collab_visibility;
  const view = vis.view || cur.view_visibility;
  if (collab === cur.collab_visibility && view === cur.view_visibility) return false;

  if (collab === 'public' && view === 'private') {
    log.warn('app-manifest', 'Skipping invalid visibility combo from dapp.json', {
      appId: cur.id, slug: cur.slug, collab, view,
    });
    return false;
  }

  await applyVisibilityChange(pool, cur, { collab, view }, { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Apply a proposal-approval governance change to an app row (issue
 * #646) — sibling of applyVisibilityChange, shared by the deploy-time
 * reconcile below and any future caller:
 *   - UPDATE both columns;
 *   - policy invited→anyone: pending approver invites become
 *     meaningless — delete them, mark their drawer notifications read,
 *     ping clients (accepted 'member' rows are kept dormant so a later
 *     flip back to 'invited' restores the roster);
 *   - policy →invited with an EMPTY roster: auto-seed the app creator
 *     as an approver member so a child app can never lock itself out
 *     (the self-app has no created_by; the governed gate's full-admin
 *     fallback covers it);
 *   - flush the governance cache (services/governance.js);
 *   - group-chat system message + `governance_changed` app update;
 *   - GOVERNANCE_CHANGED analytics event.
 * `app` must carry id, slug, approver_policy, approvals_required (the
 * CURRENT values — used for transition checks and the event's `from`).
 * All side effects beyond the column UPDATE are best-effort.
 */
async function applyGovernanceChange(pool, app, { approverPolicy, approvalsRequired, rules }, { actorLabel = 'dapp.json', userId = null } = {}) {
  await pool.query(
    `UPDATE apps SET approver_policy = $1, approvals_required = $2 WHERE id = $3`,
    [approverPolicy, approvalsRequired, app.id]
  );
  // #4666: the rules column moves only when the caller says what it is now
  // (`rules` undefined: an old-style change, which leaves it as it was).
  if (rules !== undefined) {
    await pool.query(
      'UPDATE apps SET governance_rules = $1::jsonb WHERE id = $2',
      [rules ? JSON.stringify(rules) : null, app.id]
    );
  }

  // invited → anyone: pending approver invites become meaningless.
  if (app.approver_policy === 'invited' && approverPolicy === 'anyone') {
    try {
      const { rows: pending } = await pool.query(
        `DELETE FROM app_approvers WHERE app_id = $1 AND status = 'invited'
         RETURNING user_id`,
        [app.id]
      );
      const notifications = require('./notifications');
      const { pushNotificationToUser } = require('./ws');
      for (const p of pending) {
        await notifications.markApproverInviteNotificationsRead(pool, p.user_id, app.id)
          .catch(() => {});
        try { pushNotificationToUser(p.user_id, { type: 'notifications_changed' }); } catch {}
      }
    } catch (err) {
      log.warn('app-manifest', 'Pending approver-invite cleanup failed', { appId: app.id, err: err.message });
    }
  }

  // anyone → invited with an empty roster: seed the creator so the
  // approval gate is never unreachable on a child app.
  if (approverPolicy === 'invited') {
    try {
      const { rows: members } = await pool.query(
        `SELECT 1 FROM app_approvers WHERE app_id = $1 AND status = 'member' LIMIT 1`,
        [app.id]
      );
      if (!members.length) {
        const { rows: creatorRows } = await pool.query(
          'SELECT created_by FROM apps WHERE id = $1', [app.id]
        );
        const creatorId = creatorRows[0]?.created_by || null;
        if (creatorId) {
          await pool.query(
            `INSERT INTO app_approvers (app_id, user_id, status, accepted_at)
             VALUES ($1, $2, 'member', NOW())
             ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member', accepted_at = COALESCE(app_approvers.accepted_at, NOW())`,
            [app.id, creatorId]
          );
          log.info('app-manifest', 'Auto-seeded app creator as approver', { appId: app.id, creatorId });
        }
      }
    } catch (err) {
      log.warn('app-manifest', 'Approver creator auto-seed failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./governance').invalidateGovernance(app.id);
  } catch (err) {
    log.warn('app-manifest', 'Governance cache invalidation failed', { appId: app.id, err: err.message });
  }

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'governance_changed',
      appSlug: app.slug,
      appId: app.id,
      approverPolicy,
      approvalsRequired,
      ...(rules !== undefined ? { rules: rules ? (rules.preset || 'own') : null } : {}),
    });
  } catch (err) {
    log.warn('app-manifest', 'Governance broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.GOVERNANCE_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: {
          approverPolicy: app.approver_policy,
          approvalsRequired: app.approvals_required,
          ...(rules !== undefined ? { rules: describeRulesColumn(app.governance_rules) } : {}),
        },
        to: {
          approverPolicy,
          approvalsRequired,
          ...(rules !== undefined ? { rules: describeRulesColumn(rules) } : {}),
        },
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Governance event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied governance change', {
    appId: app.id, slug: app.slug, approverPolicy, approvalsRequired, actorLabel,
  });
}

/**
 * #4666: a rules value (governance-rules.js parseRulesBlock) as
 * apps.governance_rules stores it: each named group with its people
 * resolved to user ids, through the retired-handle ledger as the admins
 * reconcile does, so a member who renames stays in their group. A name that
 * matches nobody is kept in `people` and simply has no id yet.
 */
async function storedRules(pool, value) {
  const idsByGroup = new Map();
  for (const g of value.groups || []) {
    const resolved = g.people && g.people.length ? await usernames.resolveHandles(pool, g.people) : [];
    idsByGroup.set(governanceRules.groupKey(g.name), [...new Set(resolved.map((r) => r.id))].sort((a, b) => a - b));
  }
  return governanceRules.storedForm(value, idsByGroup);
}

async function currentRulesColumn(pool, appId) {
  try {
    const { rows } = await pool.query('SELECT governance_rules FROM apps WHERE id = $1', [appId]);
    const v = rows[0]?.governance_rules;
    return v && typeof v === 'object' ? v : null;
  } catch (err) {
    log.warn('app-manifest', 'Could not read the approval rules', { appId, err: err.message });
    return null;
  }
}

function sameRules(a, b) {
  const canon = (v) => (v ? JSON.stringify({
    preset: v.preset || null,
    groups: (v.groups || []).map((g) => ({ name: g.name, people: g.people || [], ids: g.ids || [] })),
    rules: (v.rules || []).map((r) => ({ group: r.group, kind: r.kind, n: r.n ?? null })),
  }) : null);
  return canon(a) === canon(b);
}

function describeRulesColumn(v) {
  if (!v || !Array.isArray(v.rules)) return null;
  return v.preset || governanceRules.matchPreset(v.rules) || 'own';
}

/**
 * Deploy-time governance reconcile (issue #646) — sibling of
 * reconcileAppVisibility. The manifest's optional top-level
 * `governance` block is the source of truth for apps.approver_policy
 * ("approvers") / apps.approvals_required ("approvals"); an absent
 * block / axis leaves the platform value untouched.
 *
 * Unlike the visibility reconcile, self_hosted apps are NOT skipped —
 * the platform's own app is the primary consumer (its apply point is
 * boot: db/migrate.js seedSelfApp calls this next to the name/icon
 * reconciles, since the self-app deploys via GitHub Actions and never
 * runs deployProduction).
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppGovernance(pool, app, manifest) {
  const gov = manifest?.governance;
  if (!gov || (gov.approvers == null && gov.approvals == null && !gov.rules)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, approver_policy, approvals_required FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];
  cur.governance_rules = await currentRulesColumn(pool, app.id);

  // #4666: a block with rules sets them, and puts the two old columns back
  // to their defaults (the rules replace them); one with only the old keys
  // clears any rules, so the old keys decide again.
  if (gov.rules) {
    const stored = await storedRules(pool, gov.rules);
    const same = sameRules(cur.governance_rules, stored)
      && cur.approver_policy === 'anyone' && cur.approvals_required == null;
    if (same) return false;
    await applyGovernanceChange(pool, cur, { approverPolicy: 'anyone', approvalsRequired: null, rules: stored },
      { actorLabel: 'dapp.json', userId: null });
    return true;
  }
  if (cur.governance_rules) {
    const approverPolicy = gov.approvers || 'anyone';
    const approvalsRequired = gov.approvals == null || gov.approvals === 'default' ? null : gov.approvals;
    await applyGovernanceChange(pool, cur, { approverPolicy, approvalsRequired, rules: null },
      { actorLabel: 'dapp.json', userId: null });
    return true;
  }

  const approverPolicy = gov.approvers || cur.approver_policy;
  // 'default' is the explicit spelling of the NULL column state.
  const approvalsRequired = gov.approvals == null
    ? cur.approvals_required
    : (gov.approvals === 'default' ? null : gov.approvals);

  if (approverPolicy === cur.approver_policy
    && (approvalsRequired ?? null) === (cur.approvals_required ?? null)) return false;

  await applyGovernanceChange(pool, cur, { approverPolicy, approvalsRequired }, { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Apply a per-app admin roster change (issue #788) — sibling of
 * applyVisibilityChange / applyGovernanceChange, shared by the
 * deploy-time reconcile below and any future caller:
 *   - replace the app_admins rows so they match `userIds` exactly;
 *   - persist the DECLARED name list (incl. names that resolved to no
 *     user) into apps.admin_usernames for the settings panel;
 *   - upsert an app_collaborators 'member' row for every resolved
 *     admin, so an admin of a build-private app can actually reach it
 *     (mirrors the creator auto-seed in applyGovernanceChange).
 *     Demotion deliberately does NOT remove collaborator rows —
 *     revoking collaboration stays a separate, explicit action;
 *   - flush the app-admin + visibility caches;
 *   - group-chat system message + `admins_changed` app update;
 *   - APP_ADMINS_CHANGED analytics event.
 * `app` must carry id, slug, admin_usernames (the CURRENT declared
 * list — used for the event's `from`). All side effects beyond the
 * roster writes are best-effort.
 */
async function applyAdminsChange(pool, app, { usernames, userIds }, { actorLabel = 'dapp.json', userId = null } = {}) {
  const ids = Array.isArray(userIds) ? userIds : [];
  const declared = Array.isArray(usernames) ? usernames : [];

  // Set semantics: the declared list is authoritative, so anything not
  // in it goes. `= ANY('{}')` is never true, so an empty list clears.
  await pool.query(
    `DELETE FROM app_admins WHERE app_id = $1 AND NOT (user_id = ANY($2::int[]))`,
    [app.id, ids]
  );
  if (ids.length) {
    await pool.query(
      `INSERT INTO app_admins (app_id, user_id)
         SELECT $1, uid FROM UNNEST($2::int[]) AS uid
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [app.id, ids]
    );
  }
  await pool.query(
    'UPDATE apps SET admin_usernames = $1::text[] WHERE id = $2',
    [declared, app.id]
  );

  // An admin who can't see the app is a broken grant — seed membership.
  if (ids.length) {
    try {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT $1, uid, 'member', NOW() FROM UNNEST($2::int[]) AS uid
         ON CONFLICT (app_id, user_id) DO UPDATE
           SET status = 'member',
               -- #5104: a pending invite made a member this way was never
               -- accepted, so it records no acceptance (and no accepted_via,
               -- which users_connected reads as consent).
               accepted_at = CASE WHEN app_collaborators.status = 'member'
                                  THEN COALESCE(app_collaborators.accepted_at, NOW())
                                  ELSE app_collaborators.accepted_at END`,
        [app.id, ids]
      );
    } catch (err) {
      log.warn('app-manifest', 'App-admin collaborator seed failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./app-admins').invalidateAppAdmins(app.id);
  } catch (err) {
    log.warn('app-manifest', 'App-admin cache invalidation failed', { appId: app.id, err: err.message });
  }
  try {
    require('./app-access').invalidateVisibility(app.id, app.slug);
  } catch (err) {
    log.warn('app-manifest', 'Visibility cache invalidation failed (admins)', { appId: app.id, err: err.message });
  }

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'admins_changed',
      appSlug: app.slug,
      appId: app.id,
      admins: declared,
    });
  } catch (err) {
    log.warn('app-manifest', 'Admins broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.APP_ADMINS_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: Array.isArray(app.admin_usernames) ? app.admin_usernames : [],
        to: declared,
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Admins event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied app-admins change', {
    appId: app.id, slug: app.slug, declared, resolved: ids.length, actorLabel,
  });
}

/**
 * Deploy-time per-app admins reconcile (issue #788) — sibling of
 * reconcileAppVisibility / reconcileAppGovernance. The manifest's
 * optional top-level `admins` array is the source of truth for the
 * app_admins roster:
 *   - an ABSENT (or non-array) block leaves the roster untouched — a
 *     no-op for every app that never declares it;
 *   - a PRESENT array is fully authoritative, so `[]` clears the
 *     roster. That asymmetry is deliberate: without it, revocation
 *     would be inexpressible.
 *
 * Usernames are resolved case-insensitively (same precedent as the
 * collaborator invite route). A name matching no registered user is
 * NOT an error — it is kept in apps.admin_usernames so the settings
 * panel can show "declared, not a registered user", and it starts
 * granting the moment that person signs up and the app next deploys.
 *
 * Self-hosted apps are skipped with a warn, like the visibility
 * reconcile: the platform's own repo must never be able to mint app
 * admins (they'd inherit force-merge on platform proposals).
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppAdmins(pool, app, manifest) {
  const declared = manifest?.admins;
  if (!Array.isArray(declared)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, self_hosted, created_by, admin_usernames FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  if (cur.self_hosted) {
    log.warn('app-manifest', 'Skipping admins reconcile for self-hosted app', { appId: cur.id });
    return false;
  }

  // Resolved through src/services/usernames.js, NOT with a plain
  // `LOWER(username) = ANY(...)` on `users`. A dapp.json lives in
  // somebody else's repository and the platform cannot rewrite it, so a
  // contributor who renames would otherwise silently lose admin on every
  // app that declares their old handle — the manifest keeps saying `alice`
  // long after alice became `ada`. resolveHandles reads the retired-handle
  // ledger alongside `users`, so an old declared name keeps resolving to
  // the same person; `declared` comes back as the name that MATCHED (old or
  // new), which is what keeps the unresolved diff below honest.
  let resolved = [];
  if (declared.length) {
    resolved = await usernames.resolveHandles(pool, declared);
  }
  const resolvedIds = resolved.map((r) => r.id).sort((a, b) => a - b);
  const resolvedNames = new Set(resolved.map((r) => r.declared));
  const unresolved = declared.filter((u) => !resolvedNames.has(u.toLowerCase()));
  if (unresolved.length) {
    log.warn('app-manifest', 'dapp.json admins name(s) match no registered user', {
      appId: cur.id, slug: cur.slug, unresolved,
    });
  }

  const { rows: existing } = await pool.query(
    'SELECT user_id FROM app_admins WHERE app_id = $1', [cur.id]
  );
  const existingIds = existing.map((r) => r.user_id).sort((a, b) => a - b);
  const curDeclared = Array.isArray(cur.admin_usernames) ? cur.admin_usernames : [];
  const sameIds = existingIds.length === resolvedIds.length
    && existingIds.every((id, i) => id === resolvedIds[i]);
  const sameDeclared = curDeclared.length === declared.length
    && curDeclared.every((n, i) => n === declared[i]);
  if (sameIds && sameDeclared) return false;

  await applyAdminsChange(pool, cur, { usernames: declared, userIds: resolvedIds },
    { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Deploy-time screenshot-scale reconcile (issue #360) — sibling of
 * reconcileAppName / reconcileAppVisibility. The manifest's optional
 * top-level `screenshot.deviceScaleFactor` is the source of truth for
 * the density the platform captures this app's before/after preview
 * shots at; it persists into apps.screenshot_device_scale so the
 * capture orchestrator (visuals.captureForSession) can read it without
 * re-cloning. readScreenshot always returns a concrete scale (default
 * 2), so this writes on every deploy and no-ops only when the stored
 * value already matches.
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppScreenshot(pool, app, manifest) {
  const scale = manifest?.screenshot?.deviceScaleFactor;
  if (scale !== 1 && scale !== 2) return false;

  const { rows } = await pool.query(
    'SELECT screenshot_device_scale FROM apps WHERE id = $1', [app.id]
  );
  if (!rows.length) return false;
  if (rows[0].screenshot_device_scale === scale) return false;

  await pool.query(
    'UPDATE apps SET screenshot_device_scale = $1 WHERE id = $2', [scale, app.id]
  );
  log.info('app-manifest', 'Reconciled screenshot scale from dapp.json', {
    appId: app.id, slug: app.slug, deviceScaleFactor: scale,
  });
  return true;
}

/**
 * Load + validate the icon image file the manifest points at, from the
 * freshly-cloned working tree. Returns `{ data, contentType, sha256 }`
 * or null on any validation failure (missing file, symlink escaping the
 * clone, oversized, unrecognized format) — always with a warn, never a
 * throw. The realpath containment check is the authoritative guard
 * against a committed symlink pointing outside the clone.
 */
async function loadIconImage(cloneDir, relPath, appSlug) {
  try {
    const rootReal = await fs.promises.realpath(cloneDir);
    let real;
    try {
      real = await fs.promises.realpath(path.resolve(rootReal, relPath));
    } catch {
      log.warn('app-manifest', 'Icon image file missing', { slug: appSlug, image: relPath });
      return null;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      log.warn('app-manifest', 'Icon image path escapes the repo', { slug: appSlug, image: relPath });
      return null;
    }
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || stat.size > MAX_ICON_IMAGE_BYTES) {
      log.warn('app-manifest', 'Icon image not a regular file or over size cap', {
        slug: appSlug, image: relPath, size: stat.size, cap: MAX_ICON_IMAGE_BYTES,
      });
      return null;
    }
    const data = await fs.promises.readFile(real);
    const contentType = sniffIconContentType(data);
    if (!contentType) {
      log.warn('app-manifest', 'Icon image is not PNG/JPEG/WebP/GIF', { slug: appSlug, image: relPath });
      return null;
    }
    return { data, contentType, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  } catch (err) {
    log.warn('app-manifest', 'Icon image load failed', { slug: appSlug, image: relPath, err: err.message });
    return null;
  }
}

/**
 * Deploy-time icon reconcile — sibling of reconcileAppName /
 * reconcileAppVisibility / reconcileAppScreenshot. The manifest's
 * optional top-level `icon` block is the source of truth for the
 * homescreen tile: an image file committed in the repo (stored into
 * app_icons, served at /app-icons/:id) or an emoji (apps.icon_emoji).
 *
 * Unlike `name`/`visibility` and like `screenshot`, the manifest is
 * FULLY authoritative: an absent block clears both columns and deletes
 * the app_icons row, restoring the letter-tile fallback. There is no
 * platform-side icon setter to clobber, so "what's in dapp.json is
 * what you get" holds unconditionally.
 *
 * Precedence: a valid, loadable image wins; the emoji applies when no
 * image is declared or the declared file fails validation; neither →
 * clear. A re-deploy with unchanged image bytes keeps the existing
 * app_icons id (the /app-icons/:id cache header is immutable, so the
 * id only rotates when the bytes change — rotation doubles as the
 * cache-buster).
 *
 * Broadcasts an `icon_changed` app update on a real change so open
 * home screens patch the tile in place (public/js/app.js
 * handleAppUpdate). Best-effort like its siblings: callers
 * fire-and-log; a failure here must never fail the deploy.
 */
async function reconcileAppIcon(pool, app, manifest, cloneDir) {
  const icon = manifest?.icon || null;

  let image = null;
  if (icon?.image && cloneDir) {
    image = await loadIconImage(cloneDir, icon.image, app.slug);
  }
  const emoji = !image && icon?.emoji ? icon.emoji : null;

  const { rows } = await pool.query(
    'SELECT icon_emoji, icon_image_id, icon_color FROM apps WHERE id = $1', [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  let imageId = null;
  if (image) {
    const { rows: iconRows } = await pool.query(
      'SELECT id, sha256 FROM app_icons WHERE app_id = $1', [app.id]
    );
    if (iconRows.length && iconRows[0].sha256 === image.sha256
      && cur.icon_image_id === iconRows[0].id) {
      // Unchanged bytes: keep the stored id so immutable caches stay valid.
      imageId = iconRows[0].id;
    } else {
      imageId = crypto.randomBytes(16).toString('hex');
      await pool.query('DELETE FROM app_icons WHERE app_id = $1', [app.id]);
      await pool.query(
        `INSERT INTO app_icons (id, app_id, content_type, data, sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [imageId, app.id, image.contentType, image.data, image.sha256]
      );
    }
  } else if (cur.icon_image_id) {
    await pool.query('DELETE FROM app_icons WHERE app_id = $1', [app.id]);
  }

  // The project's colour rides the same block and the same rule: what
  // dapp.json says, and nothing when it says nothing (the page then derives
  // one from the icon, in the browser).
  const color = icon?.color || null;

  if ((cur.icon_emoji || null) === emoji && (cur.icon_image_id || null) === imageId
    && (cur.icon_color || null) === color) {
    return false;
  }

  await pool.query(
    'UPDATE apps SET icon_emoji = $1, icon_image_id = $2, icon_color = $3 WHERE id = $4',
    [emoji, imageId, color, app.id]
  );
  log.info('app-manifest', 'Reconciled app icon from dapp.json', {
    appId: app.id, slug: app.slug, emoji, imageId, color,
  });

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'icon_changed',
      appId: app.id,
      slug: app.slug,
      iconEmoji: emoji,
      iconUrl: imageId ? `/app-icons/${imageId}` : null,
      iconColor: color,
    });
  } catch (err) {
    log.warn('app-manifest', 'Icon broadcast failed', { appId: app.id, err: err.message });
  }
  return true;
}

/**
 * Write-through reconciliation of the platform's own `platform_env`
 * declarations into `platform_env_declarations`.
 *
 * Mirrors the other reconcile* helpers: called once at boot from
 * seedSelfApp() with the manifest freshly read off the checked-out repo,
 * best-effort, and never allowed to break the caller. The DB table is a
 * *cache* of what the committed manifest says — it exists so the admin
 * console and the pre-merge check can query declarations by SQL without
 * re-reading the working tree, and so a stored value that no longer has a
 * declaration ("orphan") is detectable.
 *
 * Declarations are upserted; declarations that disappeared from the
 * manifest are deleted. Stored *values* are never touched here — losing a
 * declaration must not destroy the value, because the merge that removes
 * a variable and the deploy that stops using it are two different events,
 * and a rollback needs the value to still be there. The orphaned value
 * simply surfaces in the admin UI as "no longer declared".
 *
 * Returns { declared, added, removed } for logging. Throws only on a DB
 * error, which the caller is expected to swallow.
 */
async function reconcilePlatformEnv(pool, appId, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const keys = list.map((e) => e.key);

  const before = await pool.query(
    'SELECT key FROM platform_env_declarations WHERE app_id = $1',
    [appId]
  );
  const beforeKeys = new Set(before.rows.map((r) => r.key));

  for (const e of list) {
    await pool.query(
      `INSERT INTO platform_env_declarations
         (app_id, key, description, required, private, grouping, default_value, unwritable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (app_id, key) DO UPDATE SET
         description = EXCLUDED.description,
         required = EXCLUDED.required,
         private = EXCLUDED.private,
         grouping = EXCLUDED.grouping,
         default_value = EXCLUDED.default_value,
         unwritable = EXCLUDED.unwritable,
         updated_at = NOW()`,
      [appId, e.key, e.description || '', !!e.required, !!e.private,
        e.group || 'General', e.default ?? null, !!e.unwritable]
    );
  }

  // Delete declarations no longer in the manifest. `= ANY($2)` with an
  // empty array is valid SQL and removes everything, which is the correct
  // behaviour when the block was deleted wholesale.
  const removed = await pool.query(
    'DELETE FROM platform_env_declarations WHERE app_id = $1 AND NOT (key = ANY($2::text[])) RETURNING key',
    [appId, keys]
  );

  const added = keys.filter((k) => !beforeKeys.has(k));
  if (added.length || removed.rowCount) {
    log.info('app-manifest', 'Reconciled platform_env declarations', {
      appId, declared: keys.length, added, removed: removed.rows.map((r) => r.key),
    });
  }
  return { declared: keys.length, added, removed: removed.rows.map((r) => r.key) };
}

module.exports = {
  read,
  readName,
  readDescription,
  MAX_DESCRIPTION_LENGTH,
  readLlm,
  readVisibility,
  readGovernance,
  readScreenshot,
  readTests,
  readTestsWithMeta,
  readLoadRules,
  checkLoadFlags,
  MAX_BOOT_PARAMS,
  MAX_ROUTING_BOUNDARIES,
  checkKey,
  readIcon,
  loadIconImage,
  normalizeIconColor,
  readAdmins,
  readPlatformEnv,
  readSecrets,
  reconcilePlatformEnv,
  PLATFORM_ENV_UNWRITABLE,
  MAX_PLATFORM_ENV,
  MAX_TESTS,
  MAX_DECLARED_TESTS,
  LEGACY_GATING_HEAD,
  MAX_APP_ADMINS,
  MAX_ADMIN_USERNAME_LENGTH,
  MAX_ICON_EMOJI_LENGTH,
  MAX_ICON_IMAGE_BYTES,
  MAX_APPROVALS_REQUIRED,
  describeVisibility,
  describeGovernance,
  describeAdmins,
  reconcileAppName,
  reconcileAppVisibility,
  reconcileAppGovernance,
  reconcileAppScreenshot,
  reconcileAppIcon,
  reconcileAppAdmins,
  reconcileAppTopics,
  readTopics,
  validateTopics,
  normalizeTopicHandle,
  isOneEmoji,
  MAX_LIVE_TOPICS,
  MAX_TOPIC_ENTRIES,
  MIN_TOPIC_NAME_LENGTH,
  MAX_TOPIC_NAME_LENGTH,
  MAX_TOPIC_ABOUT_LENGTH,
  TOPIC_HANDLE_RE,
  applyVisibilityChange,
  applyGovernanceChange,
  storedRules,
  applyAdminsChange,
  RESERVED_KEYS,
  RESERVED_KEY_PREFIXES,
  KEY_RE,
  MANIFEST_FILENAME,
  MAX_APP_NAME_LENGTH,
  MAX_APP_SLUG_LENGTH,
  buildAppSlug,
  MIN_APP_NAME_LENGTH,
};
