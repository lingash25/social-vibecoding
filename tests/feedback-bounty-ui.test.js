// Send Feedback dialog — the "Put a kudos bounty on this" row (#964).
//
// The contract that's easy to break later:
//   - the row and its checkbox exist in the modal markup, so the
//     screenshot deep link and the dapp.json checks have something to
//     select;
//   - the checkbox is UNCHECKED in the markup and re-cleared on every open
//     and every cancel — filing feedback must never quietly spend someone's
//     weekly allowance, which is the whole reason the pledge is opt-in;
//   - the note reads the live remaining/limit from Kudos.Budget rather than
//     hardcoding a number, and the checkbox is disabled at zero remaining;
//   - submitFeedback only sends `bounty` for a ticked, enabled box;
//   - `?shot=feedback` / `?shot=feedback-spent` both open the dialog, since
//     it is otherwise reachable only by tapping;
//   - the Kudos-tab subtitle no longer hardcodes the weekly allowance.
//
// Static-assertion style (cf. tests/standings-screen.test.js).
//
// Run with: node --test tests/feedback-bounty-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
// The dialog's behaviour moved out of app.js in #1078 chunk I, when the Send
// Feedback modal became a stateful island: the bounty row's reset, the submit
// path and the open/dismiss halves live in the island's controller now, which
// the component drives through useDialog. app.js keeps only what is still its
// own — the ?shot= deep links and the sign-in queue flush.
const feedbackJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/dialogs/feedback-controller.js'), 'utf8');
const kudosJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/kudos.js'), 'utf8');
const lbJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/leaderboard.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ── Markup ───────────────────────────────────────────────────────────

test('the feedback modal carries the bounty row, checkbox and note', () => {
  assert.match(html, /id="feedback-bounty-row"/);
  assert.match(html, /id="feedback-bounty-checkbox"/);
  assert.match(html, /id="feedback-bounty-note"/);
  assert.match(html, /Put a kudos bounty on this/);
  assert.match(html, /pledges 1 of your weekly kudos/);
});

test('the bounty row sits after the app-state row and before the status line', () => {
  const stateIdx = html.indexOf('id="feedback-state-row"');
  const bountyIdx = html.indexOf('id="feedback-bounty-row"');
  const statusIdx = html.indexOf('id="feedback-status"');
  assert.ok(stateIdx > 0 && bountyIdx > 0 && statusIdx > 0);
  assert.ok(stateIdx < bountyIdx, 'the bounty row follows "Include app state"');
  assert.ok(bountyIdx < statusIdx, '…and precedes the submit status line');
});

test('the checkbox ships unchecked in the markup', () => {
  // The state checkbox above it IS `checked` by default; this one must not
  // be — a default-on box would spend allowance for people who never read
  // the row.
  const row = html.slice(
    html.indexOf('id="feedback-bounty-row"'),
    html.indexOf('id="feedback-status"')
  );
  assert.match(row, /id="feedback-bounty-checkbox"/);
  assert.doesNotMatch(row, /id="feedback-bounty-checkbox"[^>]*\schecked/);
});

// ── Open / reset behaviour ───────────────────────────────────────────

test('the row is repainted from the live Kudos budget, not a literal', () => {
  assert.match(feedbackJs, /const resetBountyRow = \(\) => \{/);
  assert.match(feedbackJs, /window\.Kudos\?\.Budget\?\.state/);
  // Both copy variants interpolate the server's numbers.
  assert.match(feedbackJs, /\$\{remaining\} of \$\{limit\} kudos left this week/);
  assert.match(feedbackJs, /You've used all \$\{limit\} kudos this week/);
  assert.match(feedbackJs, /resets Monday 00:00 UTC/);
});

test('resetBountyRow unchecks the box and disables it at zero remaining', () => {
  const fn = feedbackJs.slice(
    feedbackJs.indexOf('const resetBountyRow = () => {'),
    feedbackJs.indexOf('const activeTargetClasses')
  );
  assert.ok(fn.length > 0, 'found resetBountyRow');
  assert.match(fn, /bountyCheckbox\.checked = false/);
  assert.match(fn, /const exhausted = remaining === 0/);
  assert.match(fn, /bountyCheckbox\.disabled = exhausted/);
  assert.match(fn, /bountyRow\.classList\.remove\('hidden'\)/);
});

test('the open half resets the row and refreshes the budget', () => {
  // `App.openFeedbackModal` is a one-line forward into the island now; the
  // state half it used to hold is `Feedback._open`, called from useDialog's
  // onOpen once the root has been revealed and its card lifted.
  const open = feedbackJs.slice(
    feedbackJs.indexOf('Feedback._open = (opts = {}) => {'),
    feedbackJs.indexOf("document.getElementById('feedback-btn').addEventListener")
  );
  assert.ok(open.length > 0, 'found the open half');
  assert.match(open, /resetBountyRow\(\)/);
  // A long-lived tab would otherwise show an hour-stale figure.
  assert.match(open, /window\.Kudos\?\.Budget\?\.refresh\?\.\(\)/);
});

test('cancelling the dialog clears any pledge intent', () => {
  // Cancel, the backdrop, a kit dismiss and the two post-submit auto-closes
  // all land in the same dismiss half now (useDialog's onClose).
  const cancel = feedbackJs.slice(
    feedbackJs.indexOf('Feedback._reset = () => {'),
    // The whole dismiss half, rather than a fixed number of characters into
    // it: #1284 added a guard at the top and the pledge reset is the LAST
    // line, so a length window just measures the comments above it.
    feedbackJs.indexOf("feedbackBtn.addEventListener('click', submitFeedback)"),
  );
  assert.match(cancel, /bountyCheckbox\.checked = false/);
  // Unconditionally — a pledge is always a deliberate tick, and #1284's
  // mid-capture guard covers the draft, not the bounty.
  assert.ok(!/if \(!captureInFlight\) \{[^}]*bountyCheckbox/s.test(cancel));
});

// ── Submit ───────────────────────────────────────────────────────────

test('submitFeedback sends bounty only for a ticked, enabled, visible box', () => {
  const submit = feedbackJs.slice(
    feedbackJs.indexOf('const submitFeedback = async () => {'),
    feedbackJs.indexOf('Feedback._open = (opts = {}) => {')
  );
  assert.match(submit, /const wantBounty = bountyCheckbox\.checked && !bountyCheckbox\.disabled/);
  assert.match(submit, /if \(wantBounty\) body\.bounty = true/);
  // A disabled box must never send the flag — that's the allowance-spent
  // state, where the server would refuse it anyway.
  assert.match(submit, /!bountyRow\.classList\.contains\('hidden'\)/);
});

test('the confirmation reports the bounty outcome and refreshes the meter', () => {
  const submit = feedbackJs.slice(
    feedbackJs.indexOf('const submitFeedback = async () => {'),
    feedbackJs.indexOf('Feedback._open = (opts = {}) => {')
  );
  assert.match(submit, /and pledged 1 kudos as a bounty/);
  assert.match(submit, /\$\{data\.bounty\.remaining\} left this week/);
  assert.match(submit, /Couldn't add the bounty/);
  // The drawer meter must show the number the user just spent down to.
  assert.match(submit, /data\.bounty\.placed[\s\S]{0,400}Kudos\?\.Budget\?\.refresh/);
});

// ── Screenshot deep links ────────────────────────────────────────────

test('_applyFeedbackShot handles both feedback and feedback-spent', () => {
  assert.match(appJs, /_applyFeedbackShot\(\) \{/);
  assert.match(appJs, /App\._applyFeedbackShot\(\);/);
  const shot = appJs.slice(
    appJs.indexOf('_applyFeedbackShot() {'),
    appJs.indexOf('renderAdminButton() {')
  );
  assert.match(shot, /shot !== 'feedback' && shot !== 'feedback-spent'/);
  assert.match(shot, /App\.openFeedbackModal\(\)/);
  // The spent variant forces a client-side zero so the disabled state is
  // reviewable without writing kudos rows for a real user. The display pin
  // must also beat an initial budget request that was already in flight.
  assert.match(shot, /Kudos\.Budget\._displayOverride = true/);
  assert.match(shot, /remaining: 0/);
  assert.match(kudosJs, /if \(Kudos\.Budget\._displayOverride\) return/);
});

test('dapp.json checks both shot links and the unchecked/disabled states', () => {
  const paths = dapp.tests.map((t) => t.path);
  assert.ok(paths.includes('/?shot=feedback'), 'the enabled state is checked');
  assert.ok(paths.includes('/?shot=feedback-spent'), 'the disabled state is checked');

  const enabled = dapp.tests.find(
    (t) => t.path === '/?shot=feedback' && t.expectSelector
  );
  assert.match(enabled.expectSelector, /#feedback-bounty-row:not\(\.hidden\)/);
  assert.match(enabled.expectSelector, /#feedback-bounty-checkbox:not\(:checked\)/);

  const spent = dapp.tests.find(
    (t) => t.path === '/?shot=feedback-spent' && t.expectSelector
  );
  assert.match(spent.expectSelector, /#feedback-bounty-checkbox:disabled/);

  // Deliberately NOT scoped under `#feedback-modal`: PlatformUI adopts the
  // modal into the native kit, which reparents the card out of that wrapper
  // (verified in a real browser — the descendant selector matched nothing).
  // Same trap as the secrets panel's check; see tests/platform-env-admin.js.
  // `#feedback-bounty-row:not(.hidden)` is the real discriminator, since the
  // row ships hidden and is only revealed once the dialog opens.
  for (const t of [enabled, spent]) {
    assert.doesNotMatch(t.expectSelector, /#feedback-modal/,
      'the adopted modal reparents its content — this selector would never match');
  }
});

test('both shot checks survive the manifest reader', () => {
  // dapp.json used to carry far more declared tests than the reader kept, so
  // a check appended to the end was silently dropped and never ran. #1019
  // runs every declared check; the reader now only refuses entries that are
  // malformed or past MAX_DECLARED_TESTS, and both of those are just as
  // invisible from the manifest as the old cap was.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests.filter((t) => /shot=feedback/.test(t.path));
  // Four of them run now, where the cap used to admit two. Assert the two
  // ROUTES rather than a count, so declaring another assertion against the
  // same screens doesn't fail a test that is about neither.
  for (const route of ['/?shot=feedback', '/?shot=feedback-spent']) {
    assert.ok(kept.some((t) => t.path === route),
      `${route} must survive the reader — a dropped check gates nothing`);
  }
});

// ── The 5 → 20 sweep ─────────────────────────────────────────────────

test('the Kudos-tab subtitle reads the cap from the budget', () => {
  assert.doesNotMatch(lbJs, /'5 kudos per week/);
  assert.match(lbJs, /window\.Kudos\?\.Budget\?\.state\?\.limit \|\| 20/);
  assert.match(lbJs, /kudos per week, resets Monday 00:00 UTC/);
});

test('a Dev-screen pledge also refreshes the drawer kudos meter', () => {
  const give = appViewJs.slice(
    appViewJs.indexOf('async giveIssueBounty(issueNumber) {'),
    appViewJs.indexOf('async markIssueInProgress(issueNumber) {')
  );
  assert.ok(give.length > 0, 'found giveIssueBounty');
  assert.match(give, /window\.Kudos\?\.Budget\?\.refresh\?\.\(\)/);
});
