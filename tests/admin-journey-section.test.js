'use strict';

// The admin Journey section (#3369, slice 2): frontend/src/features/admin/
// admin-journey.tsx, the page over the endpoints slice 1 shipped under
// /api/admin/journey/*.
//
// Text-pinning, in the style of the other admin section tests: the section is
// a React module behind the console's lazily imported barrel, and the
// properties that matter are visible in its source. The payload shapes are
// pinned on the server side by tests/journey-routes.test.js and
// tests/journey-routes-demo.test.js.
//
// What is pinned:
//  - the section is registered everywhere the console looks for one;
//  - it reads only the Journey routes (plus Support's search, to pick a
//    person for the left-out list) and writes only the left-out list;
//  - a reading the platform does not record reads "not recorded yet", and
//    Hear back reads "coming", never a number;
//  - it is drawn as eight chart cards, and every mark carries its count: a
//    percentage only sizes a mark, except the invite funnel's conversion
//    from step to step (#4176), printed beside its counts and only from
//    enough people;
//  - nothing from the API becomes a link;
//  - the demo payloads ride on ?demo=1, and the demo list cannot be edited;
//  - details open in dialogs, so nothing expands inside the page;
//  - one declared check opens it in a staging preview.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const src = read('frontend/src/features/admin/admin-journey.tsx');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const sections = read('frontend/src/features/admin/sections.ts');
const audit = read('scripts/audit-react-ownership.mjs');
const manifest = JSON.parse(read('dapp.json'));

test('Journey is registered wherever the console looks for a section', () => {
  assert.match(consoleJs, /\{ key: 'journey', label: 'Journey', group: 'Insights' \}/,
    'a menu entry under Insights');
  assert.match(consoleJs, /journey: 'AdminJourney',/, 'SECTION_MODULES dispatches to the module');
  assert.match(consoleJs, /'journey': '<svg /, 'the menu entry has an icon');
  assert.match(sections, /import '\.\/admin-journey\.tsx';/, 'the lazily imported barrel loads it');
  assert.match(src, /\(window as any\)\.AdminJourney = AdminJourney;/, 'it publishes itself for _renderModule');
  assert.match(src, /mountLegacyPortal\(el, <JourneySection \/>\)/, 'render(host) mounts the React section');
  assert.match(src, /unmountLegacyPortal\(host\)/, 'destroy() unmounts it');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/journey' \}/,
    'the ownership audit scopes the shared host to this route');
  assert.match(audit, /'#admin\/journey'/, 'and visits the route');
});

test('it reads the Journey routes and writes only the left-out list', () => {
  const reads = [...src.matchAll(/'(\/api\/[^'`$?]+)/g)].map((m) => m[1]);
  const templated = [...src.matchAll(/`(\/api\/[^`$?]+)/g)].map((m) => m[1]);
  for (const p of [...reads, ...templated]) {
    assert.ok(p.startsWith('/api/admin/journey/') || p === '/api/admin/support/search',
      `${p} is a Journey route or Support's search`);
  }
  for (const route of ['summary', 'cohorts', 'first-mile', 'stages', 'loops', 'next-steps', 'people/', 'left-out', 'creation', 'pairs']) {
    assert.ok(src.includes(`/api/admin/journey/${route}`), `the page reads ${route}`);
  }
  const writes = [...src.matchAll(/method: '(POST|DELETE|PUT|PATCH)'/g)].map((m) => m[1]);
  assert.deepEqual(writes.sort(), ['DELETE', 'POST'], 'one add and one remove');
  assert.equal((src.match(/fetch\('\/api\/admin\/journey\/left-out', \{/g) || []).length, 1);
  assert.match(src, /fetch\(`\/api\/admin\/journey\/left-out\/\$\{entry\.userId\}`, \{ method: 'DELETE' \}\)/);
});

test('a missing record reads "not recorded yet", and Hear back reads "coming"', () => {
  assert.match(src, /function Num\(\{ v \}: \{ v: Count \}\) \{\n  if \(isNotRecorded\(v\)\) return <span className=\{JUI\.fine\} title=\{v\.reason\}>not recorded yet<\/span>;/,
    'a count that is not recorded never renders as a number');
  assert.match(src, /typeof v === 'number' \? \([\s\S]{0,900}?not recorded yet<\/span>/,
    'a stage that is not recorded draws a dashed "not recorded yet" bar, not an empty one');
  assert.match(src, /\{coming \? 'coming' : String\(v \?\? 0\)\}/, 'a loop step that is coming says so on its node');
  assert.match(src, /const coming = isComing\(v\);/);
  assert.match(src, /\(v as Coming\)\.status === 'coming'/);
});

test('eight chart cards, every mark counted, no percentage printed, no links from data', () => {
  for (const id of ['groups', 'checks', 'mile', 'stages', 'loop', 'invite', 'next', 'coverage', 'team', 'creation', 'pairs']) {
    assert.ok(src.includes(`id="admin-journey-${id}"`), `the ${id} card`);
  }
  // The one share printed is the invite funnel's conversion, which the
  // product owner asked for (#4176): beside its counts, and only once the
  // step before has FUNNEL_RATE_FROM people, since at a handful a rate
  // claims more than the data holds.
  const printed = src.split('\n').filter((l) => l.includes('%') && !/(width|height): `\$\{[^`]*\}%`/.test(l));
  assert.deepEqual(printed.map((l) => l.trim()), ['return `${n} of ${of} · ${Math.round((n / of) * 100)}%`;'],
    'a percentage only sizes a mark, or follows the funnel\'s counts');
  assert.match(src, /const FUNNEL_RATE_FROM = 10;\n[\s\S]*?if \(of < FUNNEL_RATE_FROM\) return `\$\{n\} of \$\{of\}`;/,
    'below it, the counts alone');
  assert.match(src, /<Trend trend=\{trend\} shown=\{g\.week\} \/>/, 'the North Star carries its eight weeks');
  assert.match(src, /const STATUS_ORDER: Array<\[string, string\]> = \[/, 'groups sit under one heading per status');
  assert.match(src, /const UNIT_MAX = 24;/, 'small totals are drawn as countable units');
  assert.match(src, /<Ring label="The change loop, turns at each step"/, 'the change loop is drawn as a ring');
  assert.match(src, /<Ring label="The invite loop, people at each step"/, 'and so is the invite loop, on a card of its own');
  assert.match(src, /className=\{JUI\.mileGrid\}/, 'the first-mile staircase and tracks share one grid');
  assert.ok(!/<canvas|from '[^']*chart/i.test(src), 'no chart library: plain elements and one SVG');
  assert.ok(!/<a[\s>]|href=/.test(src), 'nothing is rendered as an anchor');
  assert.match(src, /location\.hash = `#admin\/support\/\$\{p\.userId\}`/,
    'the one jump is to Support, by a numeric id, through the hash');
  assert.ok(!/\bapp\b/.test(src.match(/>[^<{]*</g).join(' ')), 'on screen it says project, not app');
});

test('every first-mile column says what it counts on a tap, and onboard follows act', () => {
  const keys = ['admitted', 'mail_sent', 'code_asked', 'account', 'access', 'opened', 'username', 'join', 'first_act', 'onboard'];
  const help = src.match(/const MILE_HELP: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(help, 'one table of column notes');
  for (const key of keys) assert.match(help[1], new RegExp(`\\n  ${key}: '`), `${key} has a note`);
  const label = src.match(/function MileLabel\([\s\S]*?\n\}\n/)[0];
  assert.match(label, /<button type="button" className=\{JUI\.mileLabel\} aria-expanded=\{open != null\}/,
    'the label is a button that says whether its note is open');
  assert.match(label, /onClick=\{\(\) => \(open === 'tap' \? onClose\(\) : onOpen\('tap'\)\)\}/, 'a tap opens and closes it');
  assert.match(label, /e\.pointerType === 'mouse'/, 'hover only opens it for a mouse');
  assert.ok(!/title=/.test(label), 'never a title: a phone has no hover');
  assert.match(src, /e\.key === 'Escape'/, 'Escape closes it');
  assert.match(src, /\{labelFor\('onboard', 'onboard'\)\}/, 'onboard is labelled like the steps');
  assert.match(src, /<OnboardCell onboard=\{p\.onboard\} \/>/, 'every track ends in its onboard cell');
  assert.match(src, /repeat\(10,minmax\(0,1fr\)\)/, 'the grid has the tenth column');
});

test('the mail column tells opened from sent but not opened, and each cohort says its count (#6138)', () => {
  const fills = src.match(/const MAIL_FILL = \{([\s\S]*?)\n\};/);
  assert.ok(fills, 'one table of mail shades');
  for (const part of ['opened', 'unopened', 'untracked']) assert.match(fills[1], new RegExp(`\\n  ${part}: '`), `${part} has a shade`);
  assert.match(fills[1], /untracked: 'bg-\[repeating-linear-gradient\(/, 'a mail sent before tracking is striped');
  assert.match(src, /key === 'mail_sent' \? mailFill\(p, st\.state\)/, 'each track\'s mail cell takes its shade');
  assert.match(src, /\{mailParts\.opened\}\/\{mailTracked\}/, 'the mail bar counts opened of tracked');
  assert.match(src, /\{label\(m\.cohort\)\} · \{m\.people\.length\}\{cohortMail\(m\.people, nowMs\)\}/,
    'the cohort line carries its mail');
  assert.match(src, /of \$\{tracked\.length\} opened`/, 'as a count, not a rate');
  assert.match(src, /sent, not opened\$\{oldest != null \? `, \$\{Math\.floor\(\(nowMs - oldest\) \/ 86_400_000\)\} d`/,
    'and how long the oldest unopened mail has sat');
  assert.ok(!/clicked of \$\{/.test(src), 'the meta line no longer repeats it');
});

test('the demo rides on ?demo=1 and cannot be edited', () => {
  assert.match(src, /new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/);
  assert.match(src, /`\$\{path\}\$\{path\.includes\('\?'\) \? '&' : '\?'\}demo=1`/);
  assert.match(src, /const canWrite = !DEMO && !!consoleApi\(\)\?\.canWrite\?\.\(\);/,
    'the left-out controls need a full admin and real data');
  assert.match(src, /\{s\?\.demo \? <span className=\{AdminUI\.badge\.warn\}>demo<\/span> : null\}/);
});

test('details open in dialogs, one at a time on top', () => {
  for (const id of ['names', 'leftout', 'checks']) {
    assert.ok(src.includes(`id="admin-journey-${id}-dialog"`), `${id} is a dialog`);
  }
  assert.match(src, /if \(open\[open\.length - 1\] === panel\.current\) onClose\(\);/,
    'Escape closes only the topmost dialog');
  assert.ok(!src.includes('_confirm('), 'confirmations stay inside the dialog');
});

test('filters: all time or a week, everyone or one cohort; a person gets a view of their own', () => {
  assert.match(src, /useState<Scope>\(\{ week: 'all', cohort: null \}\)/, 'the default is all time, for everyone');
  assert.match(src, /if \(week\) q\.set\('week', scope\.week\);\n  if \(scope\.cohort\) q\.set\('cohort', scope\.cohort\);/,
    'the summary, stages and loops reads carry the scope');
  for (const read of ['summary', 'stages', 'loops', 'creation', 'pairs', 'first-session']) {
    assert.ok(src.includes(`scoped('/api/admin/journey/${read}', scope)`), `${read} follows the filters`);
  }
  assert.match(src, /\{person != null \? <PersonView userId=\{person\}/, 'one person replaces the cards');
  assert.match(src, /\{scope\.cohort \? null : \(?\s*<div id="admin-journey-checks"/,
    'the platform-wide checks leave a cohort view instead of reading as the cohort\'s');
  assert.match(src, /\{scope\.cohort \? null : <div className="mt-1 mb-4" id="admin-journey-team">/);
});

test('the creation path and the pairs: steps against targets, by week, and the aha out of second members', () => {
  assert.match(src, /<CreationCard scope=\{scope\} onOpen=\{openPerson\} \/>\n\s*<FirstSessionCard scope=\{scope\} onOpen=\{openPerson\} \/>\n\s*<PairsCard scope=\{scope\} onOpen=\{openPerson\} \/>/,
    'both sit under the first mile and follow the filters, with the first session between them');
  for (const [key, label] of [['created', 'Created'], ['running', 'Running'], ['first_version', 'First version ready'],
    ['preview', 'Preview opened'], ['change_live', 'Requested change live']]) {
    assert.ok(src.includes(`['${key}', '${label}', `), `the ${label} step`);
  }
  assert.match(src, /\{shown == null \? <Num v=\{st\.reached\} \/>/, 'a step not recorded yet reads so, never 0');
  assert.match(src, /if \(!cell \|\| isNotRecorded\(cell\.reached\)\) \{/, 'and so does a week before it was recorded');
  assert.match(src, /id="admin-journey-creation-weeks"/, 'by week');
  assert.match(src, /median <span className=\{targetTone\(st\.medianSeconds, st\.targetSeconds\)\}>/,
    'each step\'s median, coloured against its target');
  assert.match(src, /id="admin-journey-pairs-count" className=\{JUI\.headline\}>\{data\.count\}</);
  assert.match(src, /of \{plural\(data\.of, 'project', 'projects'\)\} that got a second member/);
  assert.match(src, /<Trend trend=\{data\.trend\} shown=\{data\.week === 'all' \? last : data\.week\} label="Pairs" \/>/,
    'a small weekly trend');
  assert.match(src, /data-journey-pair=\{e\.slug\}/, 'and a few example rows');
});

test('the first session: a maker\'s and an invited person\'s first hour, timed from its start', () => {
  for (const [key, label] of [['reward', 'Sketch shown'], ['invited', 'Invite sent'], ['running', 'Running'],
    ['said', 'Wrote in its chat'], ['suggested', 'Filed a request']]) {
    assert.ok(src.includes(`${key}: ['${label}', `), `the ${label} step`);
  }
  assert.match(src, /\{data\.make\.notRecorded \? <Num v=\{data\.make\.notRecorded\} \/>/,
    'before projects from the first session were marked, it reads so, never 0');
  assert.match(src, /of \$\{plural\(data\.make\.people, 'maker', 'makers'\)\} sent an invite within \$\{minutes\} min/);
  assert.match(src, /of \$\{plural\(data\.join\.people, 'person', 'people'\)\} wrote or asked for something within \$\{minutes\} min/);
  // The invite funnel (#4176): links opened, sign-ins through one, joins,
  // and what dropped off between each. Everyone's, so a cohort view leaves
  // it out, and before sign-ins through an invite were counted it reads so.
  for (const [key, label] of [['opened', 'Opened the link'], ['signedIn', 'Signed in'], ['joined', 'Joined']]) {
    assert.ok(src.includes(`['${key}', '${label}', `), `the ${label} step`);
  }
  assert.match(src, /\{scope\.cohort \? null : \(\s*<div id="admin-journey-first-session-opens">/);
  assert.match(src, /\{isNotRecorded\(data\.opens\) \? <Num v=\{data\.opens\} \/> : <InviteFunnelRows funnel=\{data\.opens\} \/>\}/);
  // #4272: Signed in is everyone who reached Homeroom signed in through a
  // link, so it reads as a total, and its two ways are lines of their own:
  // signed up or in from the link, the step's conversion out of the people
  // who opened one, and already signed in, a count only. Joined is still
  // out of everyone signed in.
  assert.match(src, /\{before == null \|\| ways \? plural\(n, 'person', 'people'\) : conversion\(n, before\)\}/,
    'each step after the first is counted out of the one before, but Signed in is a total');
  assert.match(src, /const ways = key === 'signedIn';/);
  for (const [key, label] of [['signedInByInvite', 'From the link'], ['signedInAlready', 'Already signed in']]) {
    assert.ok(src.includes(`['${key}', '${label}', `), `the ${label} way`);
  }
  assert.match(src, /\{way === 'signedInByInvite' \? conversion\(funnel\[way\], funnel\.opened\) : plural\(funnel\[way\], 'person', 'people'\)\}/,
    'the sign-ins the link brought are its conversion, from FUNNEL_RATE_FROM people like any other');
  assert.match(src, /data-journey-invite-funnel-way=\{way\}/);
  assert.match(src, /<UnitBar n=\{funnel\.signedInByInvite\} also=\{funnel\.signedInAlready\} of=\{most\}/,
    'one bar in two parts');
  assert.match(src, /i < n \? fill : i < n \+ also \? alsoFill : rest/);
  assert.match(src, /\{before > n \? `\$\{before - n\} dropped off` : 'nobody dropped off'\}/, 'and says what dropped off');
  assert.match(src, /median <span className=\{targetTone\(st\.medianSeconds, st\.targetSeconds\)\}>/);
  assert.match(src, /data-journey-first-session-example=\{e\.path\}/, 'and the newest few');
});

// #4272: the funnel drawn, not only read. Signed in is a total with its two
// ways under it; the ones the link brought are its conversion, printed as a
// share only once FUNNEL_RATE_FROM people opened a link.
test('the invite funnel renders Signed in as a total, split into from the link and already signed in', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');
  const mod = loadTsx('frontend/src/features/admin/admin-journey.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key)
            ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` })
            : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const draw = (funnel) => renderToHtml(createElement(mod.InviteFunnelRows, { funnel: { from: '2026-09-28T00:00:00.000Z', ...funnel } }));
  const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  const html = draw({ opened: 26, signedIn: 12, signedInByInvite: 8, signedInAlready: 4, joined: 7 });
  const step = (key) => text(html.slice(html.indexOf(`data-journey-invite-funnel-step="${key}"`)).split('data-journey-invite-funnel-step=')[1]);
  assert.match(step('opened'), /\|Opened the link\|26 people\|/);
  assert.match(step('signedIn'), /\|Signed in\|12 people\|/, 'the total, not a share');
  assert.match(step('signedIn'), /\|From the link\|8 of 26 · 31%\|/, 'the sign-ins the link brought, out of everyone who opened one');
  assert.match(step('signedIn'), /\|Already signed in\|4 people\|/, 'counted, never a share');
  assert.match(step('signedIn'), /\|14 dropped off\|/, 'everyone who opened a link and never got signed in');
  assert.match(step('joined'), /\|Joined\|7 of 12 · 58%\|5 dropped off\|/, 'joined out of everyone signed in');
  assert.ok(html.indexOf('data-journey-invite-funnel-way="signedInByInvite"') < html.indexOf('data-journey-invite-funnel-way="signedInAlready"'));
  // The bar: 26 is past UNIT_MAX, so one bar in two parts, sized by share.
  assert.match(html, /bg-violet-500" style="width:31%"><\/div><div class="h-2 bg-violet-300 dark:bg-violet-400\/50" style="width:15%">/);

  // Below FUNNEL_RATE_FROM people opening a link, the counts alone; and a
  // small total is countable units, the two ways in their own fills.
  const few = draw({ opened: 6, signedIn: 3, signedInByInvite: 1, signedInAlready: 2, joined: 1 });
  assert.match(text(few), /\|From the link\|1 of 6\|Already signed in\|2 people\|3 dropped off\|/);
  assert.equal(few.includes('%'), false);
  const units = few.slice(few.indexOf('data-journey-invite-funnel-step="signedIn"'), few.indexOf('data-journey-invite-funnel-way='));
  assert.deepEqual(units.match(/h-2 flex-1 rounded-sm [^"]+/g),
    ['h-2 flex-1 rounded-sm bg-violet-500', 'h-2 flex-1 rounded-sm bg-violet-300 dark:bg-violet-400/50',
      'h-2 flex-1 rounded-sm bg-violet-300 dark:bg-violet-400/50', 'h-2 flex-1 rounded-sm bg-zinc-200 dark:bg-zinc-700',
      'h-2 flex-1 rounded-sm bg-zinc-200 dark:bg-zinc-700', 'h-2 flex-1 rounded-sm bg-zinc-200 dark:bg-zinc-700']);
});

// #4895: under the creation path, where the time to running goes: each
// stage's median, sized by the slowest and printed beside it, and each newest
// project's slowest stages and how its image was built.
test('the creation path says where the time to running goes', () => {
  assert.match(src, /<div id="admin-journey-creation-timing">\n\s*<CreationTimingRows timing=\{data\.timing\} \/>/);
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');
  const mod = loadTsx('frontend/src/features/admin/admin-journey.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  const html = renderToHtml(createElement(mod.CreationTimingRows, { timing: {
    from: '2026-10-12T15:00:00.000Z', of: 3, totalMs: 45000,
    stages: [{ key: 'database', medianMs: 800 }, { key: 'repository', medianMs: 4300 }, { key: 'build', medianMs: 28000 }, { key: 'rollout', medianMs: 9200 }],
    pod: { scheduleMs: 1000, startMs: 5000, readyMs: 3000 },
  } }));
  assert.match(text(html), /\|Database\|0\.8 s\|Repository\|4\.3 s\|Image build\|28 s\|Start\|9\.2 s\|/);
  assert.match(html, /data-journey-creation-stage="build"[^>]*>[\s\S]*?style="width:100%"/, 'the slowest stage fills its bar');
  assert.match(text(html), /placed 1 s · image pulled and started 5 s · booted until healthy 3 s/);
  assert.match(text(html), /Median per stage over 3 projects made from a starter, 45 s in all\./);
  const none = renderToHtml(createElement(mod.CreationTimingRows, { timing: { from: null, of: 0, totalMs: null, stages: [], pod: null } }));
  assert.match(text(none), /Not timed yet/);
  assert.equal(mod.exampleTiming({
    kind: 'new_repo', totalMs: 45000, stages: { database: 800, repository: 4300, build: 28000, rollout: 9200 },
    build: { engine: 'buildkit', steps: [{ name: 'exporting cache to registry', ms: 8100 }] },
  }), 'Image build 28 s · Start 9.2 s · Repository 4.3 s · built with buildkit, slowest exporting cache to registry 8.1 s');
});

test('one declared check opens the demo page', () => {
  const checks = manifest.tests.filter((t) => t.path === '/?demo=1#admin/journey');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectSelector, '#admin-journey-north-star');
});
