'use strict';

// The build contract: the one set of rules every on-platform coding turn that
// may change an app's code works under — a dev chat build the Mayor
// dispatches, a direct OpenRouter turn, a headless auto session, and the
// Homeroom bot.
//
// Why one copy. Until this module the platform had two, and they had drifted
// as far apart as two lists can. The dev chat's Mayor-dispatched builds still
// ran on the platform's first prompt (2026-04-25, "Initial commit: extract
// from evanshapi.ro monorepo"):
//
//   - Spend minimal time reading files. Focus on writing and editing.
//   - After all changes are made, stage everything with "git add -A" …
//   - Do NOT ask questions or request clarification. Just build it.
//
// The Homeroom bot, meanwhile, had grown the strictest rules on the platform
// from its own shadow builds (the ones pinned below and in
// tests/homeroom-bot-question-bar.test.js). Sheep countrr
// (usernode-bot/sheep-countrr-a08857#48) showed what the first list produces:
// an agent that never opened the Dockerfile answered the app's own compiled
// `/tailwind.css` with 204 to quiet a sandbox error and blanked production
// for days (#38); a save/resume feature rewired the frame loop every round
// runs on and froze it (#37); an agent unsure where its edits had gone ran
// `git checkout <another member's commit> -- …` and shipped that member's
// unmerged feature inside its own proposal (#34). Each of those maps to a
// rule here.
//
// Rules are pre-wrapped lines, joined as written, so a test can pin a rule's
// exact text and a prompt reads the same everywhere it appears.

const RULES = Object.freeze({
  readInstructions:
    "- Read the repository's own agent instructions (AGENTS.md, CLAUDE.md) first, and follow them.",
  readBeforeWrite: [
    '- Before you edit, read how the code you are changing is used (what calls it, what depends on it) and how',
    '  the app is built and served (its package.json scripts and Dockerfile). Do not assume a file or path is',
    '  served by the platform: check.',
  ].join('\n'),
  keepSmall:
    '- Keep the change as small as the request needs. Do not refactor or tidy unrelated code.',
  unrelatedProblems: [
    '- A problem the request does not ask about (a console error, a failing check, an error from a platform',
    '  path, untidy code) is not yours to fix in this change unless your change caused it: name it in your',
    '  summary instead. Never silence an error or empty a response to make a check pass.',
  ].join('\n'),
  ownBranchOnly: [
    '- Work only on the branch you were given. Never check out, cherry-pick, merge or copy files from another',
    "  branch or commit the request does not name: other `dev/*` branches are other people's unfinished work.",
    '  If your edits seem to have gone missing, stop and say so.',
  ].join('\n'),
  runTests:
    '- Run the tests that cover what you changed, if the repository has them.',
  existingFlow: [
    '- If you change code the whole app relies on (its main loop, shared state, routing, server setup or',
    "  startup), exercise the app's existing main flow afterwards, not only the part you added.",
  ].join('\n'),
  userGesture: [
    '- Browser features that need a user gesture (sound through an AudioContext, notification permission,',
    '  clipboard, fullscreen) must be started or unlocked inside a tap or click handler. Started later, from a',
    '  timer or a render, phones refuse them or keep them silent.',
  ].join('\n'),
  lockfiles: [
    '- Do not change a lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml and the like) unless the change',
    '  adds or removes a dependency. If installing dependencies rewrote one, restore it before you finish',
    '  (for example `git checkout -- package-lock.json`).',
  ].join('\n'),
  checksProve: [
    '- A test or check you add must fail without your change: assert what the change makes true, not only that',
    '  the page loads. Where you can run it, run it against the code as it was before your edit and see it fail.',
  ].join('\n'),
  realCodePath: [
    '- A screen that renders hardcoded demo data (a screenshot fixture such as a `?scene=` route) does not test',
    '  your feature: at least one check must run the real code path your change affects.',
  ].join('\n'),
  existingChecks: [
    '- Do not loosen, skip, delete or rewrite an existing test or check to make it pass. Change one only where',
    '  the spec changes the behaviour it pins, and name it in your summary.',
  ].join('\n'),
  realDatabase: [
    '- A database query you add or change must run in a test against a real database, where the repository has',
    "  such tests (for example its *-postgres tests). A test that only matches the query's text does not count.",
    '  Do not stub the code you changed in the test that checks it: stub what it calls, not what it is.',
  ].join('\n'),
  noReports:
    '- Do not add reports, notes or other documents to the repository unless the spec asks for that file.',
  // Homeroom bot parity, P8: a build's pictures (worker/usernode-image).
  pictures: [
    '- A picture the change needs (a hero image, an illustration): `usernode-image "<what it shows>" --out',
    '  <path>.png` makes one, paid from this build\'s allowance; `usernode-image --from <link> --out <path>`',
    '  saves one a request links.',
  ].join('\n'),
  bugFirst: [
    '- If the request reports a bug, find where in the code it happens before changing anything. If you cannot',
    '  find it, stop and say so instead of changing code: do not ship a guessed fix.',
  ].join('\n'),
  agentCommits: [
    '- Commit on the session branch with a message that says what you built. Commit only the files you changed',
    '  for this request: check `git status` first and leave out anything else (screenshots, logs, build output).',
  ].join('\n'),
  harnessCommits:
    '- Do not commit or push yourself: when you finish, your working tree is committed and pushed for you.',
  stopIfUnsafe:
    '- If you find you cannot make the change safely, stop and say why instead of changing code.',
});

// The order a reader meets them in: understand first, then scope, then how
// to prove the change, then the hand-off.
const ORDER = Object.freeze([
  'readInstructions', 'readBeforeWrite', 'keepSmall', 'unrelatedProblems', 'ownBranchOnly',
  'runTests', 'existingFlow', 'userGesture', 'lockfiles', 'checksProve', 'realCodePath', 'existingChecks',
  'realDatabase', 'noReports', 'pictures', 'bugFirst', 'COMMIT', 'stopIfUnsafe',
]);

const SUMMARY_LINE = [
  'End with a short, plain-language summary of what you changed, then list each file you changed with one',
  'line on why, and anything you noticed but left alone.',
].join('\n');

/**
 * The contract as prompt text.
 *
 * @param {object} [opts]
 * @param {string} [opts.heading] the line that introduces the rules.
 * @param {'agent'|'harness'} [opts.commits] who commits: the agent itself (the
 *   dev chat asks it to) or the harness after it finishes (the Homeroom bot).
 * @param {boolean} [opts.summary] whether to close with the summary line. The
 *   dev chat puts its own required blocks after the rules, so it asks for the
 *   same summary in its own words.
 */
function buildContractBlock({
  heading = 'When you change files, work under these rules:',
  commits = 'agent',
  summary = true,
} = {}) {
  if (commits !== 'agent' && commits !== 'harness') {
    throw new Error(`build-contract: unknown commits mode ${commits}`);
  }
  const rules = ORDER.map((key) => (key === 'COMMIT'
    ? RULES[commits === 'agent' ? 'agentCommits' : 'harnessCommits']
    : RULES[key]));
  return [heading, ...rules, ...(summary ? [SUMMARY_LINE] : [])].join('\n');
}

module.exports = {
  RULES,
  SUMMARY_LINE,
  buildContractBlock,
};
