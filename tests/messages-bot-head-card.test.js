'use strict';

// #4097: a Homeroom bot message shows what it is about as a card, not as the
// line that names it.
//
// The bot names what a message is about in a line of its own: "**Todo List**
// · request #93: Only close category when last item is checked" on a
// request's news (services/homeroom-bot-dm.js requestLine), "**Todo List**,
// its first version" or "**Todo List**" on a first version's, and "**Todo
// List** · proposal: …" or "**Todo List** · new request: …" in an offer
// (services/homeroom-bot-mayor.js). The transcript drew each as bold text
// and a number. Pinned here:
//
//   1. Which lines count: the bot's, about what its metadata names, where
//      the line stands (first; after the maker's hello; anywhere in an
//      offer), never a lookalike. The server's own lines parse, so a change
//      to their shape fails here.
//   2. The card, from the best source there is. A request's: the card the
//      message carries, else the server's reading for this reader, else the
//      line's own, with no "by" and no status (a request whose change went
//      live is GitHub's "closed"). A project's, a change's and a draft's.
//      No fetch it does not need, and no card where the message's own Open
//      button already opens the project.
//   3. Where it is drawn: in the row in place of the line, the card not drawn
//      again under the words, and in the two-questions card's lead.
//
// Run with: node --test tests/messages-bot-head-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HEAD = 'frontend/src/features/messages/bot-head-card.tsx';

// What useLinkCards was asked for, and what it answers: a stand-in for the
// server's reading (tests/messages-link-embeds.test.js pins the real one).
let asked = [];
let answer = null;
const { botHead, draftPreviewOf, isHeadCard, BotHeadWords } = loadTsx(HEAD, {
  stubs: {
    './link-cards': {
      useLinkCards: (links) => {
        asked.push(links.map((link) => link.key));
        return links.length && answer ? [{ link: links[0], card: answer }] : [];
      },
    },
  },
});

const META = { kind: 'build_failed', appSlug: 'todo-list-b91765', appName: 'Todo List', issueNumber: 93, issueTitle: 'Only close category when last item is checked' };
const LINE = '**Todo List** · request #93: Only close category when last item is checked';
const WORDS = 'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.';
const FIRST = { kind: 'question', appSlug: 'todo-list-b91765', appName: 'Todo List', issueNumber: 1, firstVersion: true };

const dm = require('../src/services/homeroom-bot-dm');

/** A head's fields, with its link as its key and address. */
const shape = (head) => head && { ...head, link: head.link && { key: head.link.key, href: head.link.href } };

// ── 1. Which lines count ────────────────────────────────────────────────

test('the bot’s line about the request its metadata names splits from the words after it', () => {
  assert.deepEqual(shape(botHead(`${LINE}\n\n${WORDS}`, META)), {
    kind: 'request',
    link: { key: 'issue:todo-list-b91765:93', href: '#app/todo-list-b91765/dev/issues/93' },
    appSlug: 'todo-list-b91765',
    appName: 'Todo List',
    issueNumber: 93,
    title: 'Only close category when last item is checked',
    before: '',
    rest: WORDS,
    hidden: false,
  });
  assert.equal(botHead(LINE, META).rest, '', 'a line with nothing after it');
  assert.equal(botHead(`**Todo List** · request #93\n\n${WORDS}`, { ...META, issueTitle: undefined }).title, null,
    'a request with no title');
  assert.equal(botHead(`**Todo List** · request #93: Clipped at the li…\n\nx`, { ...META, issueTitle: undefined }).title,
    'Clipped at the li…', 'the line’s title when the metadata has none');
  const demo = botHead(`${LINE}\n\n${WORDS}`, { ...META, appSlug: undefined });
  assert.equal(demo.link, null, 'a message that names no project (the staging demo) has no page to open');
  assert.equal(demo.appSlug, null);
});

test('a first version’s line is its project, and the maker’s hello stays before it', () => {
  assert.deepEqual(shape(botHead(`**Todo List**, its first version\n\nI have a question before I build the first version:`, FIRST)), {
    kind: 'project',
    link: { key: 'app:todo-list-b91765:', href: '#app/todo-list-b91765/app' },
    appSlug: 'todo-list-b91765',
    appName: 'Todo List',
    issueNumber: null,
    title: null,
    before: '',
    rest: 'I have a question before I build the first version:',
    hidden: false,
  });
  const started = { kind: 'first_version_started', appSlug: 'todo-list-b91765', appName: 'Todo List' };
  assert.equal(botHead('**Todo List**\n\nThanks! I\'m setting up Todo List now.', started).kind, 'project', 'its bare name');
  const hello = 'Hi, I\'m Homeroom bot. I build apps and changes from what you describe.';
  const greeted = botHead(`${hello}\n\n**Todo List**\n\nI'm setting up Todo List now.`, { ...started, hello });
  assert.equal(greeted.kind, 'project');
  assert.equal(greeted.before, hello);
  assert.equal(greeted.rest, 'I\'m setting up Todo List now.');
  assert.equal(botHead('**Todo List**\n\nx', { ...started, appName: 'Herbs' }), null, 'only the project its metadata names');
});

test('sign-up test, 19 Oct 2026: a ready-made app\'s maker hears hello over the project\'s card', () => {
  const meta = { kind: 'hello_maker', appSlug: 'city-tier-list', appName: 'City Tier List', hello: dm.MAKER_HELLO, actions: dm.promptActions(dm.READY_MADE_PROMPTS), status: 'open' };
  const head = botHead(dm.readyMadeHello('City Tier List', 'add a photo of each city'), meta);
  assert.equal(head.kind, 'project');
  assert.equal(head.before, dm.MAKER_HELLO);
  assert.equal(head.rest, 'Ask me here for changes, like “add a photo of each city”.');
  assert.deepEqual(shape(head).link, { key: 'app:city-tier-list:', href: '#app/city-tier-list/app' }, 'its card opens the app');
});

test('#4604: the hello after the tour names no project, so it draws no card', () => {
  const meta = { kind: 'hello_tour', hello: dm.TOUR_HELLO, actions: dm.promptActions(dm.TOUR_PROMPTS), status: 'open' };
  assert.equal(botHead(dm.TOUR_HELLO, meta), null, 'plain words, no head line');
});

test('a first version that went live with its Open button keeps the button and drops the line', () => {
  const live = { ...FIRST, kind: 'merged', actions: [{ id: 'open_app', label: 'Open Todo List', style: 'primary', type: 'open', target: '#app/todo-list-b91765/app' }] };
  const head = botHead('**Todo List**, its first version\n\nIt\'s live now. Open Todo List below to try it.', live);
  assert.equal(head.hidden, true);
  assert.equal(botHead('**Todo List**, its first version\n\nx', { ...live, actions: [{ ...live.actions[0], target: '#app/other/app' }] }).hidden, false,
    'a button to another project is no reason');
});

test('an offer’s line is the change it would withdraw, or the request it would file, wherever it stands', () => {
  const offer = { kind: 'confirm', appSlug: 'plant-pal', appName: 'Plant pal' };
  const withdraw = botHead('Want me to withdraw it? Tap Withdraw it below.\n\n**Plant pal** · proposal: Plant photos\n\nWhy: She wants to rethink it', offer);
  assert.deepEqual(shape(withdraw), {
    kind: 'change', link: null, appSlug: 'plant-pal', appName: 'Plant pal', issueNumber: null, title: 'Plant photos',
    before: 'Want me to withdraw it? Tap Withdraw it below.', rest: 'Why: She wants to rethink it', hidden: false,
    // 18 Nov 2026: an offer's line, whose words after it fold away when long (tests/bot-one-card.test.js).
    offer: true,
  });
  const file = botHead('Want me to file this on Plant pal?\n\nOne more line.\n\n**Plant pal** · new request: Add a search box\n\nSearch notes by their text.', offer);
  assert.equal(file.kind, 'draft');
  assert.equal(file.title, 'Add a search box');
  assert.equal(file.before, 'Want me to file this on Plant pal?\n\nOne more line.', 'a reply of more than one paragraph');
  assert.equal(botHead('**Note board** · new request: x', offer), null, 'only the project the offer names');
  assert.equal(botHead('**Plant pal** · new request: x', { ...offer, kind: 'chat' }), null, 'only in an offer');
});

test('nothing else is a line', () => {
  const text = `${LINE}\n\n${WORDS}`;
  assert.equal(botHead(text, null), null, 'a person’s message (botMeta is null for any sender but the bot)');
  assert.equal(botHead(text, { ...META, issueNumber: 94 }), null, 'a line about another request');
  assert.equal(botHead(text, { ...META, issueNumber: undefined }), null);
  assert.equal(botHead(text, { ...META, firstVersion: true }), null, 'a first version has no request line');
  assert.equal(botHead(`Here it is.\n\n${text}`, META), null, 'news leads with its line');
  assert.equal(botHead(`I looked at **Todo List** · request #93 again.\n\n${WORDS}`, META), null);
  assert.equal(botHead('**Todo List**\n\nx', { kind: 'chat' }), null, 'a reply names no project of its own');
  assert.equal(botHead('', META), null);
});

test('the server’s own lines parse, in the messages the bot sends', () => {
  const context = { appName: 'Todo List', issueNumber: 93, issueTitle: META.issueTitle };
  const said = dm.dmText('build_failed', { reason: 'the build ran past its time limit' }, context);
  const head = botHead(said, META);
  assert.ok(head, said);
  assert.equal(head.title, META.issueTitle);
  assert.equal(`${dm.requestLine(context)}\n\n${head.rest}`, said, 'the words are everything after the line');
  assert.doesNotMatch(head.rest, /request #93/);
  assert.ok(botHead(dm.requestLine({ ...context, issueTitle: null }), { ...META, issueTitle: undefined }), 'and the line with no title');
  assert.equal(botHead(dm.requestLine({ ...context, firstVersion: true }), META).kind, 'project',
    'a first version’s line names its project, whatever the metadata’s flag (a restart’s carries none)');
  assert.equal(botHead(dm.dmText('question', { question: 'Which colour?' }, { ...context, issueNumber: 1, firstVersion: true }), FIRST).kind, 'project');
  // The weekly limit, Filed and already filed lead with the same line (homeroom-bot-mayor.js).
  const held = dm.overAllowanceText({ line: dm.requestLine(context), appName: 'Todo List' });
  // One request, one story (spec 3, Stream 1 item 5): the on-hold words.
  assert.equal(botHead(held, { ...META, kind: 'allowance' }).rest, 'On hold until Monday: your building time for this week is used up.');
  const mayor = read('src/services/homeroom-bot-mayor.js');
  assert.match(mayor, /`\$\{line\}\\n\\nFiled\. \$\{builds/);
  assert.match(mayor, /requestLine\(\{ appName: name, issueNumber: n, issueTitle: action\.title \}\)\}\\n\\nI already filed that\./);
  // The offers' lines (homeroom-bot-mayor.js offer).
  assert.match(mayor, /`\*\*\$\{name\}\*\* · proposal: \$\{o\.title\}`/);
  assert.match(mayor, /`\*\*\$\{name\}\*\* · new request: \$\{o\.title\}`/);
  // A maker's first project: the hello, then the project's line (homeroom-bot-dm.js
  // firstVersionStartedText), with and without the made screen's plan.
  const started = { kind: 'first_version_started', appSlug: 'todo-list-b91765', appName: 'Todo List' };
  for (const earlyPlan of [true, false]) {
    const greeted = dm.firstVersionStartedText({ name: 'Todo List', hello: true, earlyPlan });
    const head = botHead(greeted, { ...started, hello: dm.MAKER_HELLO });
    assert.equal(head.kind, 'project');
    assert.equal(head.before, dm.MAKER_HELLO);
    assert.match(head.rest, /^I'm setting up Todo List now\. /);
    const again = botHead(dm.firstVersionStartedText({ name: 'Todo List', earlyPlan }), started);
    assert.equal(again.kind, 'project');
    assert.match(again.rest, /^Thanks! I'm setting up Todo List now\. /);
  }
});

// ── 2. The card ─────────────────────────────────────────────────────────

const draw = (head, objects = []) => {
  asked = [];
  return renderToHtml(createElement(BotHeadWords, { head, objects }));
};

test('the request card the message carries is the card, and nothing is fetched for it', () => {
  answer = { type: 'issue', available: true, title: 'Read title', subtitle: 'Todo List', state: 'open' };
  const head = botHead(`${LINE}\n\n${WORDS}`, META);
  const carried = {
    type: 'issue', available: true, appSlug: 'todo-list-b91765', issueNumber: 93,
    title: 'Only close a category when its last item is checked', subtitle: 'Todo List', state: 'closed', author: 'usernode-bot',
    href: '#app/todo-list-b91765/dev/issues/93',
  };
  const html = draw(head, [carried]);
  assert.deepEqual(asked, [[]], 'no link asked for');
  assert.match(html, /^<div class="mb-1\.5 mt-1 max-w-\[480px\]" data-bot-head-card="request" data-bot-request-card="93"><a href="#app\/todo-list-b91765\/dev\/issues\/93" class="messages-object-card"/,
    'the card leads, linking the request');
  assert.match(html, />Request #93</, '#4212: the eyebrow names its number, as the bot\'s words do');
  assert.match(html, /Only close a category when its last item is checked/);
  assert.match(html, />Todo List</, 'its project alone');
  assert.doesNotMatch(html, /closed|by usernode-bot|request #93|(?<!Request )#93</,
    'no status (a live request is GitHub\'s "closed", which read as turned down), no "by", and no line');
  assert.ok(html.indexOf('messages-object-card') < html.indexOf('messages-markdown'), 'then the words');
  assert.match(html, /<div class="messages-markdown gc-msg-content">I couldn't finish building this/);
  assert.equal(isHeadCard(head, carried), true, 'which the row then leaves out from under the words');
  assert.equal(isHeadCard(head, { ...carried, issueNumber: 94 }), false);
  assert.equal(isHeadCard(head, { type: 'proposal', appSlug: 'todo-list-b91765', sessionId: 93 }), false, 'a change’s card stays');
});

test('else the server’s reading of the request for this reader; until it comes, the line’s own', () => {
  const head = botHead(`${LINE}\n\n${WORDS}`, META);
  answer = { type: 'issue', available: true, title: 'Renamed since', subtitle: 'Todo List', state: 'open', author: 'usernode-bot', href: '#elsewhere' };
  let html = draw(head, [{ type: 'issue', available: false }]);
  assert.deepEqual(asked, [['issue:todo-list-b91765:93']], 'the request’s link, asked once');
  assert.match(html, /Renamed since/);
  assert.match(html, />Todo List</);
  assert.match(html, /<a href="#app\/todo-list-b91765\/dev\/issues\/93"/, 'the request’s page, not the answer’s address');
  assert.doesNotMatch(html, /usernode-bot|· open/);

  answer = null;
  html = draw(head);
  assert.match(html, /Only close category when last item is checked/, 'the title the bot knew');
  assert.match(html, />Todo List</, 'its project');
  assert.match(html, /<a href="#app\/todo-list-b91765\/dev\/issues\/93" class="messages-object-card"/);
  assert.doesNotMatch(html, /Unavailable/);
});

test('a message that names no project draws the card without a link and asks nothing', () => {
  answer = { type: 'issue', available: true, title: 'Never asked' };
  const html = draw(botHead(`**Staging demo app** · request #12\n\n${WORDS}`, { kind: 'question', appName: 'Staging demo app', issueNumber: 12 }));
  assert.deepEqual(asked, [[]]);
  assert.match(html, /<div class="messages-object-card"><span class="messages-object-icon">#<\/span>/, 'a card, not a link');
  assert.match(html, /Request #12/, 'named by its number when it has no title');
  assert.match(html, />Staging demo app</);
  assert.doesNotMatch(html, /Never asked|href=/);
});

test('a project’s card opens its App tab, and a first version gone live with its Open button draws none', () => {
  answer = { type: 'hub', available: true, title: 'Never asked' };
  const html = draw(botHead('**Todo List**, its first version\n\nBuilding the first version now.', FIRST));
  // B21: with no icon from the viewer's tracks or the message, the project's hub card
  // is read for its icon alone; the line is still the card.
  assert.deepEqual(asked, [['hub:todo-list-b91765:']], 'its hub, read for its icon');
  assert.match(html, /data-bot-head-card="project"><a href="#app\/todo-list-b91765\/app" class="messages-object-card" rel="noopener noreferrer"><span class="messages-object-icon">◆<\/span>/,
    'a hub with no icon of its own leaves the glyph');
  answer = { type: 'hub', available: true, title: 'Never asked', iconUrl: '/app-icons/f00d' };
  assert.match(draw(botHead('**Todo List**, its first version\n\nBuilding the first version now.', FIRST)),
    /data-bot-head-card="project"><a href="#app\/todo-list-b91765\/app" class="messages-object-card" rel="noopener noreferrer"><span class="messages-object-icon overflow-hidden" data-object-icon="image"><img src="\/app-icons\/f00d"/,
    'B21: a newcomer\'s first project, with no track of the viewer\'s, wears its own icon');
  assert.match(html, />Todo List<\/div><div class="text-sm text-zinc-500 dark:text-zinc-400 truncate">First version</);
  assert.doesNotMatch(html, /data-bot-request-card|Never asked/);

  const live = { ...FIRST, kind: 'merged', actions: [{ id: 'open_app', label: 'Open Todo List', style: 'primary', type: 'open', target: '#app/todo-list-b91765/app' }] };
  const said = draw(botHead('**Todo List**, its first version\n\nIt\'s live now. Open Todo List below to try it.', live));
  assert.equal(said, '<div class="messages-markdown gc-msg-content">It&#x27;s live now. Open Todo List below to try it.</div>'.replace('&#x27;', '\''),
    'the words alone: the button is its way in');
});

// Run four (13 Oct 2026): the card for the maker's new app read "◆". It
// wears the app's own icon, its requests' tracks' as the news lines draw
// it, else the emoji the message carries; with neither, the glyph.
test('a project’s card wears the project’s own icon when it is known', () => {
  let work = null;
  const iconic = loadTsx(HEAD, {
    stubs: {
      './link-cards': { useLinkCards: () => [] },
      './bot-work': { useBotWork: () => ({ work }) },
    },
  });
  const drawn = (meta = FIRST) => renderToHtml(createElement(iconic.BotHeadWords, {
    head: iconic.botHead('**Todo List**, its first version\n\nBuilding the first version now.', meta), objects: [],
  }));
  // The viewer's tracks (./bot-work.tsx), which carry each project's artwork.
  const job = (patch) => ({ appSlug: 'todo-list-b91765', appName: 'Todo List', iconUrl: null, iconEmoji: null, work: { stage: 'building' }, ...patch });
  work = { tracks: [job({ iconUrl: '/app-icons/a1b2c3' })] };
  assert.match(drawn(), /<span class="messages-object-icon overflow-hidden" data-object-icon="image"><img src="\/app-icons\/a1b2c3" alt="" class="h-full w-full object-cover" loading="lazy" decoding="async" draggable="false"\/><\/span>/);
  assert.doesNotMatch(drawn(), /◆/);
  work = { tracks: [job({ iconEmoji: '🗳️', work: { stage: 'live' } })] };
  assert.match(drawn(), /<span class="messages-object-icon text-\[22px\] leading-none" data-object-icon="emoji" aria-hidden="true">🗳️<\/span>/);
  // No track for the project: the emoji the message carries, else the glyph.
  work = { tracks: [job({ appSlug: 'elsewhere', iconUrl: '/app-icons/zz' })] };
  assert.match(drawn({ ...FIRST, appEmoji: '📚' }), /data-object-icon="emoji" aria-hidden="true">📚</);
  assert.match(drawn(), /<span class="messages-object-icon">◆<\/span>/);
  // A request's card keeps its number sign, whatever the tracks say.
  work = { tracks: [job({ iconUrl: '/app-icons/a1b2c3' })] };
  const request = renderToHtml(createElement(iconic.BotHeadWords, { head: iconic.botHead(`${LINE}\n\n${WORDS}`, META), objects: [] }));
  assert.match(request, /<span class="messages-object-icon">#<\/span>/);
});

test('an offer draws the change it carries in its line’s place, or the request it would file, not filed yet', () => {
  answer = null;
  const offer = { kind: 'confirm', appSlug: 'plant-pal', appName: 'Plant pal' };
  const withdraw = botHead('Want me to withdraw it?\n\n**Plant pal** · proposal: Plant photos\n\nWhy: She wants to rethink it', offer);
  const change = {
    type: 'proposal', available: true, appSlug: 'plant-pal', sessionId: 77, title: 'Plant photos', subtitle: 'Plant pal',
    state: 'waiting for approval', href: '#app/plant-pal/dev/proposals/77',
  };
  const html = draw(withdraw, [change]);
  assert.deepEqual(asked, [[]]);
  assert.ok(html.indexOf('Want me to withdraw it?') < html.indexOf('data-bot-head-card="change"'), 'the reply, then the card');
  assert.ok(html.indexOf('data-bot-head-card="change"') < html.indexOf('Why: She wants'), 'then why');
  assert.match(html, /<a href="#app\/plant-pal\/dev\/proposals\/77" class="messages-object-card" rel="noopener noreferrer">/);
  assert.match(html, />Change</);
  assert.match(html, /Plant pal · waiting for approval</, 'a change keeps its status: the platform’s own words');
  assert.equal(isHeadCard(withdraw, change), true, 'and the row does not draw it again under the buttons');

  const draft = draw(botHead('Want me to file this?\n\n**Plant pal** · new request: Add a search box\n\nSearch notes by their text.', offer));
  assert.match(draft, /data-bot-head-card="draft"><div class="messages-object-card">/, 'nothing to open yet');
  assert.match(draft, />Add a search box</);
  assert.match(draft, />Plant pal · not filed yet</);

  // 31 Oct 2026: filed by File it, the same offer carries its number and is
  // drawn as the request it became, linked, never "not filed yet" again.
  asked.length = 0;
  const filed = botHead('Want me to file this?\n\n**Plant pal** · new request: Add a search box\n\nSearch notes by their text.',
    { ...offer, issueNumber: 14, issueTitle: 'Add a search box', status: 'answered', chosen: 'yes' });
  assert.deepEqual([filed.kind, filed.issueNumber, filed.title], ['request', 14, 'Add a search box']);
  assert.equal(filed.link.href, '#app/plant-pal/dev/issues/14');
  const filedHtml = draw(filed);
  assert.match(filedHtml, /data-bot-head-card="request" data-bot-request-card="14"/);
  assert.match(filedHtml, /<a href="#app\/plant-pal\/dev\/issues\/14"/);
  assert.doesNotMatch(filedHtml, /not filed yet/);
  // A change offered for withdrawal never takes a number for a request.
  assert.equal(botHead('Want me to withdraw it?\n\n**Plant pal** · proposal: Plant photos', { ...offer, issueNumber: 14 }).kind, 'change');
});

// #6248: while a file-request offer waits, its draft's card opens the
// read-only preview in the AI tab's column. A filed or declined draft's card
// goes back to what it did.
test('an open draft’s card offers a preview, and only while the offer waits', () => {
  const offer = { kind: 'confirm', appSlug: 'plant-pal', appName: 'Plant pal', actionId: 42, status: 'open' };
  const head = botHead('Want me to file this?\n\n**Plant pal** · new request: Add a search box\n\nSearch notes by their text.', offer);
  const at = draftPreviewOf(head, offer, null, 7);
  assert.deepEqual(at, {
    conversationId: 7, rootId: null, actionId: 42,
    title: 'Add a search box', project: 'Plant pal', details: 'Search notes by their text.', appSlug: 'plant-pal',
  }, 'a draft said in Main: no thread root, and the message’s own copy');
  assert.equal(draftPreviewOf(head, offer, 9, 7).rootId, 9, 'in its own thread: that thread');
  assert.equal(draftPreviewOf(head, { ...offer, status: 'answered' }, null, 7), null, 'answered');
  assert.equal(draftPreviewOf(head, { ...offer, actionId: undefined }, null, 7), null, 'no action to read');
  assert.equal(draftPreviewOf(head, offer, null, 0), null, 'no conversation');
  assert.equal(draftPreviewOf({ ...head, kind: 'change' }, offer, null, 7), null, 'a change’s offer has no draft');
  const filed = botHead('Want me to file this?\n\n**Plant pal** · new request: Add a search box',
    { ...offer, issueNumber: 14, issueTitle: 'Add a search box', status: 'answered', chosen: 'yes' });
  assert.equal(draftPreviewOf(filed, offer, null, 7), null, 'filed: it is the request’s card now');

  // Drawn with the preview it opens: a button, with the › every openable card has.
  const html = renderToHtml(createElement(BotHeadWords, { head, objects: [], draft: at }));
  assert.match(html, /data-bot-head-card="draft"><button type="button" class="messages-object-card w-full text-start">/);
  assert.match(html, /<span aria-hidden="true" class="text-zinc-500 dark:text-zinc-400">›<\/span>/);
  assert.match(html, />Add a search box</);
  assert.match(html, />Plant pal · not filed yet</);
});

test('a line with nothing after it is the card alone', () => {
  answer = null;
  assert.doesNotMatch(draw(botHead(LINE, META)), /messages-markdown/);
});

// ── 3. Where it is drawn ────────────────────────────────────────────────

test('the row draws the card in place of the line, and not again under the words', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /import \{ BotHeadWords, botHead, draftPreviewOf, isHeadCard \} from '\.\/bot-head-card';/);
  assert.match(row, /const head = botHead\(message\.content, botMeta\(message\)\);/,
    'only the bot’s own messages (botMeta reads it off a bot sender only)');
  // 18 Nov 2026: and a reply's live card's request is not drawn again either (tests/bot-one-card.test.js).
  assert.match(row, /const objects = message\.objects\.filter\(\(object\) => !\(head && isHeadCard\(head, object\)\) && !isLiveCardObject\(liveWork, object\)\);/);
  // #6248: only in the bot's DM, and only for a draft.
  assert.match(row, /const draft = botChat && kind === 'direct'\n\s+\? draftPreviewOf\(head, botMeta\(message\), message\.threadRootId, message\.conversationId \|\| conversationId\)\n\s+: null;/);
  assert.match(row, /<BotHeadWords head=\{head\} objects=\{message\.objects\} channels=\{channels\} draft=\{draft\} marks=\{marks\} \/>/);
  assert.match(row, /\{objects\.length \? <div className="messages-object-list">\{objects\.map\(/);
  assert.doesNotMatch(row, /message\.objects\.map\(/);
});

test('the two-questions card leads with the request’s card too', () => {
  const plan = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(plan, /const head = meta\.lead \? botHead\(meta\.lead, meta\) : null;/);
  assert.match(plan, /\{head \? <BotHeadWords head=\{head\} objects=\{message\.objects\} \/>\s*: meta\.lead \? <MessageMarkdown content=\{meta\.lead\} appSlug=\{meta\.appSlug\} \/> : null\}/);
});

test('#6207: the staging preview’s declared check finds the bot\'s chat without any request’s news', () => {
  // 3 Nov 2026: a request's news (its rows, the finished group, its
  // question) is on the request's page, which its row on the Homeroom bot
  // page opens. 14 Nov 2026: Main Chat is gone; its old address opens the
  // thread its messages were moved under, or a new chat, and the check finds
  // none of a request's news drawn there.
  const check = JSON.parse(read('dapp.json')).tests.find((t) => t.id === 'homeroom-bot-old-main-address');
  assert.ok(check, 'declared');
  assert.equal(check.path, '/?demo=1#homeroom-bot/main');
  // A request's row wore its number tag, and the selector still says none is
  // drawn there. The thread it lands on is Earlier chat, alone under its own
  // head, and the bot's offer to file a request is still a message there,
  // with File it and Not now (the staging fixture moves the demo's old Main
  // Chat under it).
  assert.equal(check.expectSelector, '#ai-screen:not(.hidden) #ai-main-pane[data-ai-column] > .messages-layout[data-bot-threads] > .messages-reply-pane:has([data-reply-head=alone]) .messages-reply-scroll:not(:has([data-request-tag])) .messages-quote ~ * > [aria-label^="File this"] > button:last-child:not(.messages-bot-other)');
  assert.match(read('frontend/src/features/messages/bot-strip.tsx'), /data-request-tag=\{number\}/, 'the tag, as a request\'s number wears it');
  // The rows that wore it in a transcript were the chat's own stream's, which no screen draws.
  assert.doesNotMatch(read('frontend/src/features/messages/message-row.tsx'), /RequestTag/);
  const limit = Number(/const MAX_SELECTOR_LEN = (\d+);/.exec(read('capture/capture.js'))[1]);
  assert.ok(check.expectSelector.length <= limit, 'within what the runner reads');
  assert.equal(check.expectText, 'Earlier chat', 'the server\'s name for the thread the old Main Chat messages are under');
  assert.match(read('src/services/private-threads.js'), /const EARLIER_TITLE = 'Earlier chat';/);
  // The fixture still writes the story (services/staging-messages.js ensureBotDmStory).
  const fixture = read('src/services/staging-messages.js');
  assert.match(fixture, /const question = 'Which night should the rota start on\?';/);
});


// ── Chat replies (homeroom-bot-mayor.js) ────────────────────────────────

test('a chat reply carries a card for each request its words name that its tools showed, and opens their project’s #N', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const ctx = {};
  mayor.noteRequests(ctx, {
    workingOnNow: [{ project: 'ear-trainer', projectName: 'Ear Trainer', number: 14 }, { project: 'seed-swap', number: 3 }],
    proposals: [{ proposal: 6011, project: 'ear-trainer', number: 15 }],
    projects: [{ project: 'note-board', projectName: 'Note board' }],
  });
  assert.deepEqual(mayor.namedCards('Ear Trainer #14 is building, and #15 is up for a vote.', ctx), {
    cards: [{ kind: 'request', project: 'ear-trainer', number: 14 }, { kind: 'request', project: 'ear-trainer', number: 15 }],
    project: 'ear-trainer',
  });
  assert.equal(mayor.namedCards('Ear Trainer #14 and Seed swap #3.', ctx).project, null, 'two projects: no one place for its #N');
  assert.deepEqual(mayor.namedCards('#14 and #99.', ctx), {
    cards: [{ kind: 'request', project: 'ear-trainer', number: 14 }], project: null,
  }, 'a number nothing showed gets no card, and leaves the #N where they were');
  assert.deepEqual(mayor.namedCards('Proposal #6011 is up.', ctx), { cards: [], project: null }, 'a proposal’s number is no request');
  mayor.noteRequests(ctx, { project: 'seed-swap', number: 14 });
  assert.deepEqual(mayor.namedCards('#14 is building.', ctx).cards, [], 'a number on two projects is no one card');
  assert.match(read('src/services/homeroom-bot-mayor.js'), /const project = named\.project \? \{ appSlug: named\.project \} : \{\};\n\s+return sayHere\(text, \{\n\s+objects: unique,\n\s+metadata: \{\n\s+kind: 'chat', \.\.\.project,/);
});
