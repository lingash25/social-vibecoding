// Settings → User guide (#5973): a page of its own beside Welcome tour, one
// row per stop of the tour plus how a change gets voted in, its words read
// from the catalog. What it says is pinned here where the claim could drift:
// it names the tabs the bar names, and no number of votes, because that is
// each project's own rule.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SECTION = 'frontend/src/features/settings/sections/guide.tsx';
const CATALOG = JSON.parse(read('frontend/locales/en/settings.json'));
const guideIds = Object.keys(CATALOG).filter((k) => k.startsWith('guide.'));

test('the pane ships hidden, with a row per tour stop and the voting card', () => {
  const html = renderComponent(SECTION, 'GuideSection');
  assert.match(html, /data-settings-section="guide" class="hidden"/);
  assert.match(html, /id="settings-guide-section"/);
  assert.match(html, /id="settings-guide-voting"/);
  const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const text = unescape(html);
  for (const id of guideIds) {
    assert.ok(text.includes(CATALOG[id].text), `${id} is on the page`);
  }
});

test('it has one row per stop of the tour, in the tour\'s order', () => {
  const steps = read('frontend/src/features/home/tour/tour-steps.ts');
  const stops = [...steps.matchAll(/^\s+id: '([a-z-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(stops, ['communities', 'apps', 'app-menu', 'menu-actions', 'meet-bot', 'settings']);
  const src = read(SECTION);
  const rows = [...src.matchAll(/settings:guide\.place\.(\w+)\.title/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['communities', 'apps', 'appMenu', 'suggest', 'bot', 'you']);
});

test('#6513: Start here comes first, then the places, how a change goes live and the rest', () => {
  const src = read(SECTION);
  const heads = [...src.matchAll(/settings:guide\.([\w]+)\.heading/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['start', 'places', 'vote', 'compare', 'terms', 'faq']);
  const steps = [...src.matchAll(/settings:guide\.vote\.(\w+)\.title/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['request', 'build', 'up', 'checks', 'rule']);
  // The subtitle promises how a change goes live, and the card is called that.
  assert.match(message('settings:guide.intro'), /how a change goes live/);
  assert.equal(message('settings:guide.vote.heading'), 'How a change goes live');
  // Text and nothing else: no state, no handlers.
  assert.doesNotMatch(src, /useState|useEffect|onClick/);
});

test('every id the pane asks for exists, as a title and a body', () => {
  const src = read(SECTION);
  for (const m of src.matchAll(/settings:(guide\.[\w.]+)/g)) {
    assert.ok(CATALOG[m[1]], `${m[1]} is in the catalog`);
  }
  for (const id of guideIds.filter((k) => k.endsWith('.title') && k !== 'guide.title')) {
    assert.ok(CATALOG[id.replace(/\.title$/, '.body')], `${id} has a body`);
  }
});

test('it is a registered page under Help & about, right after Welcome tour, and searchable', () => {
  const settings = read('frontend/src/features/settings/settings.js');
  assert.match(settings, /\{ key: 'tour',[^\n]*\n\s+\/\/[^\n]*\n\s+\{ key: 'guide', label: 'settings:nav\.part\.guide', group: 'settings:nav\.group\.helpAbout' \}/);
  assert.match(settings, /guide: 'settings:nav\.keywords\.guide',/);
  assert.equal(message('settings:nav.part.guide'), 'User guide');
  assert.match(read('frontend/src/features/settings/sections/index.tsx'), /<TourSection \/>\s+<GuideSection \/>/);
});

test('the words stay true: the tabs as the bar names them, and no rule it did not verify', () => {
  const all = guideIds.map((id) => CATALOG[id].text).join('\n');
  // The bot's tab is its own, not a row of Messages (AGENTS.md, #6019), and
  // the tab's word is the catalog's.
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  assert.equal(message('core:tabs.me'), 'You');
  assert.doesNotMatch(all, /Find it in Messages/);
  // Build it comes out of the presser's own week.
  assert.match(message('settings:guide.vote.build.body'), /any member can press Build it, and the bot's building time comes out of that member's week/);
  // The checks gate going live whatever the vote says.
  assert.match(message('settings:guide.vote.checks.body'), /can't go live until they pass/);
  // #6513: One Home (#6361) took the Communities tab off the bar, so the
  // guide sends people to Home for communities and Needs you, and Pinned
  // apps is the apps you pin or build (Home.isYours), not every app of your
  // communities.
  assert.doesNotMatch(all, /Communities tab/);
  assert.match(message('settings:guide.place.communities.body'), /Yours are on Home, under Pinned communities and All communities/);
  assert.match(message('settings:guide.vote.up.body'), /listed under Needs you\./);
  // Home's Needs you tile shows only while a vote waits; the list holds more.
  assert.match(message('settings:guide.term.needsYou.body'), /Home shows a shortcut to it while a vote waits/);
  assert.match(message('settings:guide.place.apps.body'), /holds the apps you pin and the ones you help build/);
  assert.doesNotMatch(all, /apps from your communities/);
  // Codex review: joining pins the community, not its app; a member is
  // needed to take part but is not always enough; one request can hold
  // several pinned comments; an offline comment is not sent by itself.
  assert.match(message('settings:guide.start.open.body'), /hub and select Open app/);
  assert.match(message('settings:guide.place.communities.body'), /You need to join a community/);
  assert.match(message('settings:guide.faq.whoCan.body'), /a project can ask for more/);
  assert.doesNotMatch(all, /each comment is posted as a request|sent once you are back online|About this app/);
  // An invite link alone leaves a project Just you: it is private once someone joins.
  assert.match(message('settings:guide.term.justYou.body'), /someone you invite joins/);
  assert.doesNotMatch(all, /Inviting someone makes it/);
  // The names it quotes are the screen's own.
  assert.equal(message('home:communities.heading'), 'Pinned communities');
  assert.equal(message('home:communities.all'), 'All communities');
  assert.equal(message('home:communities.new'), 'New community');
  assert.equal(message('home:join.heading'), 'Communities to join');
  assert.equal(message('home:communities.needs'), 'Needs you');
  assert.equal(message('project:communityCard.openApp'), 'Open app');
  assert.match(message('agent:appContext.row.about', { app: 'Run Club' }), /^About Run Club/);
  assert.equal(message('agent:appContext.about.addToMyApps'), 'Pin to Home');
  assert.equal(message('dialogs:feedback.target.platformSub'), 'The platform itself');
  assert.equal(message('messages:store.header.main'), 'Main Chat');
  assert.equal(message('dialogs:whoDecides.see.publicSub'), 'Anyone can open it and join.');
  assert.equal(message('dialogs:whoDecides.see.privateSub'), 'Only members can open it.');
  // The shortcuts it lists are the ones the code binds.
  const filter = read('frontend/src/features/settings/filter-shortcut.ts');
  assert.match(filter, /e\.key === 'k' \|\| e\.key === 'K'/);
  assert.match(filter, /e\.key === '\/'/);
  assert.match(read('frontend/src/features/improve/suggest-shortcut.ts'), /The C key turns comment mode on and off/);
  // No thresholds: how many yeses is each project's own rule.
  assert.doesNotMatch(all, /\b\d+\b\s*(%|percent|votes?|yes|yeses|approvals?|members?|people)/i);
  assert.doesNotMatch(all, /\b(two|three|four|majority)\b\s*(votes?|yes|yeses|approvals?|members?|people)?/i);
});
