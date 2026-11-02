'use strict';

// Messages is one inbox (#2718).
//
// It was the `conversations` domain and nothing else. An app's own
// discussion lived on that app's board and an agent chat lived in the
// Improve panel's list, so neither was findable from the one screen somebody
// opens looking for "what was said to me". One list, one clock, a mark on
// the rows that are not a person — which is what Slack and Teams do with a
// channel, a DM and a bot thread in one sidebar.
//
// Five things are pinned, and each is a way one list becomes three stacked:
//
//   1. ONE CLOCK. Sorted per-kind, an inbox is three lists in a trench coat.
//   2. A ROW WITH NO TIMESTAMP SORTS LAST. "We do not know when" is not
//      "just now", and an agent chat never opened would otherwise lead.
//   3. AGENT CHATS ARE NOT COPIED into this store. A second copy of a list
//      loaded and invalidated elsewhere is a copy that drifts.
//   4. THE DISCUSSIONS READ FAILS QUIETLY. Conversations are this screen's
//      reason to exist; a second request must not be able to blank it.
//   5. MEMBERSHIP, NOT VISIBILITY. A public app you have never joined is
//      something to go and read, not something in your messages. (#2967
//      widens this to "an app you have taken part in", in a second "more"
//      section — still never an app you have not touched, and never one you
//      cannot open.)
//
// #2783 sections the list the way Discord does: the CHATS (people and
// agents) on the one clock, then the CHANNELS — #general, then one per app
// the viewer is a member of, including one nobody has spoken in yet.
//
// 16 Oct 2026: the channels live on their hubs now, and the one clock is
// sections, each on its own. One clock had put the bot's news and every
// agent turning above the people, so a person was easily three screens
// down. The filter chips went with it: the headings say which is which.
// Then the same day: the Homeroom bot is Agents' first row, pinned, rather
// than a section of its own; Agents shows at most five from its week and
// the rest behind "N older chats"; and only Agents folds.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const ROUTE = read('src/routes/messages-overview.js');

const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const at = (iso) => iso;

test('three sections in a fixed order, each on its own clock; the channels are not listed here: they live on their hubs', () => {
  const merged = inbox.buildInbox({
    conversations: [
      { id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') },
      { id: 9, kind: 'channel', lastActivityAt: at('2026-01-09T00:00:00Z') },
    ],
    discussions: [
      { slug: 'quiet', lastAt: null },
      { slug: 'notes', lastAt: at('2026-01-03T00:00:00Z') },
    ],
    mayors: [{ id: 5, lastActivityAt: at('2026-01-01T00:00:00Z') }],
    filter: 'all',
  });
  // Messages is people and agents. #general is the Homeroom community's
  // channel and each app's channel is its own community's, drawn on the
  // hub (features/dev-board/workshop/hub-cards.tsx), so neither is a row.
  // Agents before People, whatever the clock says between them.
  assert.deepEqual(merged.map((e) => e.key), ['mayor:5', 'person:1']);
  assert.deepEqual(merged.map((e) => e.section), ['agents', 'people']);
});

test('a row with no timestamp sorts last in its section, not first', () => {
  const merged = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2020-01-01T00:00:00Z') }],
    mayors: [{ id: 1, lastActivityAt: null }, { id: 2, lastActivityAt: at('2019-01-01T00:00:00Z') }],
  });
  assert.deepEqual(merged.map((e) => e.key), ['mayor:2', 'mayor:1', 'person:1']);
});

test('the sections are Agents and Direct messages, and there are no filter chips', () => {
  assert.deepEqual([...inbox.INBOX_SECTIONS], ['agents', 'people']);
  assert.deepEqual(inbox.INBOX_SECTIONS.map((section) => message(`messages:inbox.section.${section}`)),
    ['Agents', 'Direct messages'], 'People\'s section is headed Direct messages (16 Oct 2026)');
  assert.equal(inbox.INBOX_FILTERS, undefined, 'the chips went: the headings say which is which');
  assert.equal(inbox.admits, undefined);
  assert.doesNotMatch(SCREEN, /InboxFilters|setFilter|messages-filter/);
  const people = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }, { id: 9, kind: 'channel', lastActivityAt: null }],
  });
  assert.deepEqual(people.map((e) => e.key), ['person:1'], 'a channel is no one\'s person row');
});

test('#6019: the Homeroom bot\'s DM is the AI tab, not a row of Messages', () => {
  const conversations = [
    { id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') },
    { id: 2, kind: 'direct', homeroomBot: true, lastActivityAt: at('2026-01-01T00:00:00Z') },
  ];
  const sessions = [{ key: 's7', lastActivityAt: at('2026-01-03T00:00:00Z') }];
  const merged = inbox.buildInbox({ conversations, sessions });
  assert.deepEqual(merged.map((e) => e.key), ['session:s7', 'person:1'], 'its row left the list');
  assert.deepEqual(merged.map((e) => e.section), ['agents', 'people']);
  assert.deepEqual(merged.map((e) => !!e.pinned), [false, false], 'nothing is pinned now');
  assert.match(SCREEN, /conversations: snap\.conversations,/, 'the screen hands the merge the summaries that carry the mark');
});

test('the discussions read fails quietly', () => {
  const fn = STORE.slice(STORE.indexOf('export async function loadAppDiscussions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!response\.ok\) return;/, 'a bad status changes nothing');
  assert.match(body, /\} catch \{/, 'and neither does being offline');
  assert.doesNotMatch(body, /publish\(\{ error/, 'it never blanks the conversations');
});

test('the "+" sits beside the search, and opens a choice rather than guessing (#2778)', () => {
  // It was a disc at the far end of the filter row, taken off in #2718's
  // review because ONE control could only mean one of the things the inbox
  // holds, and came back as a popover of three choices: DM, group, agent.
  // The filter row went (16 Oct 2026), so it sits beside the search.
  const toolbar = SCREEN.slice(SCREEN.indexOf('<div className="messages-toolbar">'));
  const body = toolbar.slice(0, toolbar.indexOf('<NewMessageButton />') + 20);
  assert.ok(body.indexOf('id="messages-search"') > 0 && body.indexOf('id="messages-search"') < body.indexOf('<NewMessageButton />'),
    'the plus sits after the search, to its right');
  assert.ok(!SCREEN.includes('function InboxCompose'), 'the row of compose buttons under the strip is gone');
  assert.ok(!SCREEN.includes('id="messages-new-agent"'));

  const button = SCREEN.slice(SCREEN.indexOf('function NewMessageButton'));
  const fn = button.slice(0, button.indexOf('\n}\n'));
  assert.match(fn, /id="messages-new"/);
  assert.match(fn, /aria-haspopup="menu"/);
  // THE VOTE POPUP'S MECHANICS, shared rather than copied: placement from
  // the button's rect, dismissal on outside click / Escape / scroll / resize.
  assert.match(fn, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/);
  // B8: sized to its rows, which are three.
  assert.match(fn, /placeUnderAnchor\(rect, \{ width: 260, height: 54 \* NEW_CHOICES\.length \+ 2 \}/);
  assert.match(fn, /createPortal\(/, 'portalled, so the list\'s scroller cannot clip it');
  assert.match(fn, /role="menu"/);
  assert.match(fn, /pu\.actionSheet\(\{/, 'a phone gets the kit\'s action sheet');
  const card = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(card, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/, 'the vote picker reads the same helper');
  assert.match(card, /placeUnderAnchor\(rect, \{ width: w, height: h \}/);

  assert.equal(message('messages:inbox.new.direct.label'), 'Direct message');
  assert.match(SCREEN, /\{ key: 'direct', label: 'messages:inbox\.new\.direct\.label'/);
  assert.equal(message('messages:inbox.new.group.label'), 'Group chat');
  assert.match(SCREEN, /\{ key: 'group', label: 'messages:inbox\.new\.group\.label'/);
  // #5380: the agent row is "Agent chat", and Homeroom bot is out of the
  // menu: it starts new conversations, and the bot's one conversation is
  // reached from the top of Agents.
  assert.equal(message('messages:inbox.new.agent.label'), 'Agent chat');
  assert.equal(message('messages:inbox.new.agent.hint'), 'Plan and build a change with a coding agent');
  assert.match(SCREEN, /\{ key: 'agent', label: 'messages:inbox\.new\.agent\.label', hint: 'messages:inbox\.new\.agent\.hint' \}/);
  assert.throws(() => message('messages:inbox.new.bot.label'));
  assert.throws(() => message('messages:inbox.new.bot.hint'));
  assert.doesNotMatch(SCREEN, /key: 'bot'/);
  assert.doesNotMatch(SCREEN, /hasHomeroomBot/);
  // The order is agent, then people.
  const agentAt = SCREEN.indexOf("key: 'agent'");
  const directAt = SCREEN.indexOf("key: 'direct'");
  const groupAt = SCREEN.indexOf("key: 'group'");
  assert.ok(agentAt > -1 && directAt > agentAt && groupAt > directAt, 'the menu is Agent chat, Direct message, Group chat');
  const start = SCREEN.slice(SCREEN.indexOf('function startNew'));
  const starter = start.slice(0, start.indexOf('\n}\n'));
  assert.doesNotMatch(starter, /openBot/, 'Homeroom bot is not a new conversation to start');
  assert.match(starter, /if \(choice === 'agent'\) void startAgentSession\(\{ entry: 'messages' \}\);/,
    'Agent chat opens one new conversation with the Mayor, with no app to pick first (#2779)');
  assert.match(starter, /else openDialog\('messagesCreate', choice\);/,
    'DM and group open the create flow on the matching tab');
  const create = read('frontend/src/features/messages/create-dialog.tsx');
  assert.match(create, /setMode\(tab === 'group' \? 'group' : 'direct'\)/);
});

test('the "+" asks no app first and opens no classic session any more (#2779)', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/messages/agent-dialog.tsx')), false,
    'the "which app?" dialog led to a classic dev session, which is no longer created');
  assert.doesNotMatch(SCREEN, /messagesAgent|agentSessionsEnabled/);
  const improve = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(improve, /startSessionFor/);
});

test('the endpoint lists yours then more, one row per app, never an app the viewer cannot open', () => {
  // #2967 widened #2783's members-only scope into two sections: "yours" is
  // Home's `isYours` (member and not hidden from Your apps, or favorited),
  // "more" is every other app the viewer took part in. Pinned by clause
  // here; tests/app-chat-postgres.test.js runs the SQL against the real
  // schema.
  assert.match(ROUTE, /FROM app_collaborators me\s+WHERE me\.user_id = \$1 AND me\.status = 'member'/,
    'membership is one way in');
  assert.match(ROUTE, /LEFT JOIN app_favorites fav ON fav\.app_id = a\.id AND fav\.user_id = \$1/,
    'a favorite (or a hidden-from-Your-apps opt-out) is read per viewer');
  assert.match(ROUTE, /WHEN \(member\.app_id IS NOT NULL AND NOT COALESCE\(fav\.hidden, FALSE\)\)\s+OR \(fav\.app_id IS NOT NULL AND NOT fav\.hidden\)\s+THEN 'yours'/,
    'yours = Home.isYours: a visible membership, or a favorite');
  for (const [source, why] of [
    [/FROM chat_messages posted\s+WHERE posted\.user_id = \$1/, 'posted in its chat'],
    [/FROM message_reactions reaction/, 'reacted in its chat'],
    [/FROM pr_votes vote/, 'voted on a proposal'],
    [/FROM issue_votes vote/, 'voted on a governance question'],
    [/FROM chat_sessions proposed[\s\S]{0,120}is_headless = FALSE/, 'proposed a change (not an auto session)'],
    [/FROM issues filed\s+WHERE filed\.created_by = \$1/, 'filed a request'],
  ]) assert.match(ROUTE, source, `activity: ${why}`);
  // Visibility is the app routes' view rule, whatever put the app in scope.
  assert.match(ROUTE, /\(\$2::boolean OR a\.view_visibility = 'public' OR member\.app_id IS NOT NULL\)/,
    'an app gone view-private drops out for a non-member, favorite or no favorite');
  assert.match(ROUTE, /NOT a\.self_hosted OR \$2::boolean/,
    'and the platform’s own app keeps its admin gate');
  assert.match(ROUTE, /WHERE a\.moderation_suspended_at IS NULL\s+AND \(NOT a\.self_hosted/,
    'an app suspended by moderation refuses to open, so it is no discussion either');
  assert.match(ROUTE, /AND view_visibility = 'public' AND NOT self_hosted\s+AND moderation_suspended_at IS NULL/,
    'nor a staging demo row');
  assert.match(ROUTE, /SELECT DISTINCT ON \(m\.app_id\)/, 'one row per app');
  assert.match(ROUTE, /ORDER BY m\.app_id, m\.created_at DESC, m\.id DESC/,
    'the id tiebreak matters: created_at defaults to NOW() and two messages '
    + 'in one transaction share it');
  assert.match(ROUTE, /WHERE m\.thread_type IS NULL\s+AND m\.deleted_at IS NULL/,
    'the general thread, not a card’s or a reply thread’s, and never a deleted message');
  // #2783: EVERY app in scope is a channel, including one nobody has
  // spoken in — so the latest message is joined optionally, and those sort
  // after the ones with activity.
  assert.match(ROUTE, /LEFT JOIN latest ON latest\.app_id = mine\.id/);
  assert.match(ROUTE, /ORDER BY \(mine\.section = 'yours'\) DESC,\s+latest\.created_at DESC NULLS LAST, LOWER\(mine\.name\), mine\.slug/,
    'yours before more; newest first inside each, silent last');
  // #2387 gives chat_messages a per-viewer read cursor (app_chat_reads), so
  // the count this test used to forbid is now a real one — and it is
  // computed from that cursor, not invented.
  assert.match(ROUTE, /JOIN app_chat_reads rc ON rc\.app_id = m\.app_id AND rc\.user_id = \$1/);
  assert.match(ROUTE, /m\.id > rc\.last_read_message_id/);
  assert.match(ROUTE, /m\.user_id IS NOT NULL AND m\.user_id <> \$1/,
    'from other people: your own lines and authorless system lines are not unread');
  assert.match(ROUTE, /appChat\.ensureReadCursors\(pool, req\.user\.id, missing\)/,
    'an app seen for the first time starts at zero');
});

test('the route is registered after the workshop one', () => {
  const server = read('server.js');
  assert.match(server, /const \{ messagesOverviewRoutes \} = require\('\.\/src\/routes\/messages-overview'\);/);
  assert.match(server, /app\.use\(messagesOverviewRoutes\(config\)\);/);
});

test('the search and the plus ship in the prerendered document; the filter row is gone', () => {
  for (const id of ['messages-search', 'messages-new']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  for (const id of ['messages-filters', 'messages-filter-all', 'messages-filter-people', 'messages-filter-agents',
    'messages-filter-apps', 'messages-filter-channels', 'messages-compose', 'messages-new-agent']) {
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is retired`);
  }
  assert.match(HTML, /<div class="messages-toolbar"><div class="messages-search">[\s\S]*?id="messages-search"[^>]*\/><\/div><button[^>]*id="messages-new"/,
    'the plus is right after the search, on its line');
  assert.ok(!HTML.includes('id="messages-new-menu"'), 'the popover renders only when pressed');
  assert.ok(!HTML.includes('data-inbox-section'), 'the sections draw once the rows arrive, after mount');
});

test('one row shape per kind, under two headed sections; Agents shows the bot, then five from its week', () => {
  assert.match(SCREEN, /const MayorSessionRow = memo\(function MayorSessionRow/);
  assert.doesNotMatch(SCREEN, /<KindPill kind="app" \/>/, 'a section heading says it once');
  assert.match(SCREEN, /const SECTION_LABELS: Record<InboxSection, string> = \{\s*agents: 'messages:inbox\.section\.agents',\s*people: 'messages:inbox\.section\.people',\s*\};/);
  assert.match(SCREEN, /\{INBOX_SECTIONS\.map\(\(section\) => \{/, 'every section, in order');
  assert.match(SCREEN, /<SectionHead section=\{section\} folded=\{folded\} aside=\{asides\[section\]\.text\} ask=\{asides\[section\]\.ask\} \/>/);
  assert.match(SCREEN, /<div className="messages-section-card" data-inbox-card=\{section\}>/,
    'each section\'s rows in a card of their own, so the last row of a section drops its separator');
  // Agents folds from its heading; People is the list's last section and
  // has a plain heading, its unread count and no fold.
  const head = SCREEN.slice(SCREEN.indexOf('function SectionHead'));
  const fn = head.slice(0, head.indexOf('\n}\n'));
  assert.match(fn, /if \(!FOLDABLE\.includes\(section\)\) \{\s*return <h3 className="messages-section-head" data-inbox-section=\{section\}>\{words\}<\/h3>;/);
  assert.match(fn, /data-inbox-fold=\{section\}\s*aria-expanded=\{!folded\}\s*onClick=\{\(\) => setSectionFolded\(section, !folded\)\}/);
  // A search opens Agents and shows every match.
  assert.match(SCREEN, /const folded = !searching && FOLDABLE\.includes\(section\) && snap\.folded\.includes\(section\);/);
  assert.match(SCREEN, /expanded: agentsExpanded, searching, folded, openKey, keep: asksForYou,/);
  // #5289: an open work order is kept too (it is listed nowhere else).
  assert.match(SCREEN, /const asksForYou = \(entry: \{ kind: string; key: string \}\) => agentAsksForYou\(entry, bySession, byMayor\);/);

  const NOW = Date.parse('2026-10-16T12:00:00Z');
  const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
  const e = (key, at, extra = {}) => ({ key, section: 'agents', kind: 'mayor', at, ...extra });
  const bot = e('bot', daysAgo(30), { kind: 'person', pinned: true });
  const week = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => e(k, daysAgo(i * 0.5)));
  const old = [e('g', daysAgo(8)), e('h', daysAgo(20)), e('n', null)];
  const agents = [bot, ...week, ...old];
  const shown = (opts = {}) => {
    const r = inbox.shownInSection('agents', agents, { now: NOW, ...opts });
    return [r.shown.map((x) => x.key), r.older, r.olderShown.map((x) => x.key)];
  };
  assert.equal(inbox.AGENTS_SHOWN, 5);
  assert.equal(inbox.AGENTS_RECENT_DAYS, 7);
  assert.deepEqual(shown(), [['bot', 'a', 'b', 'c', 'd', 'e'], 4, []],
    'the bot whatever its age and taking none of the five, then the five newest of the week; the sixth, the older and the clockless wait');
  assert.deepEqual(shown({ expanded: true }), [['bot', 'a', 'b', 'c', 'd', 'e'], 4, ['f', 'g', 'h', 'n']],
    'the link opens the rest under it, and still counts them so it can fold them again');
  assert.deepEqual(shown({ openKey: 'h' })[0], ['bot', 'a', 'b', 'c', 'd', 'e', 'h'], 'the open one wherever it sits');
  assert.deepEqual(shown({ keep: (x) => x.key === 'g' || x.key === 'f' })[0], ['bot', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    'and whatever asks for you, past the five and past the week: nothing waiting on you is folded away');
  const quiet = inbox.shownInSection('agents', [bot, ...old], { now: NOW });
  assert.deepEqual([quiet.shown.map((x) => x.key), quiet.older], [['bot'], 3], 'a quiet week is the bot and the link, never an empty heading');
  assert.deepEqual(inbox.shownInSection('agents', agents, { now: NOW, folded: true }).shown.map((x) => x.key), ['bot'],
    'folded, Agents keeps the bot');
  const search = inbox.shownInSection('agents', agents, { now: NOW, searching: true });
  assert.deepEqual([search.shown.length, search.older], [agents.length, 0], 'a search shows every match');
  assert.deepEqual(inbox.shownInSection('people', old, { now: NOW }).shown.length, old.length, 'People shows all of them');
  assert.deepEqual(inbox.sectionRuns([bot, e('a', null), e('p', null, { section: 'people' })])
    .map((r) => [r.section, r.entries.length]), [['agents', 2], ['people', 1]]);

  // The link: muted words in the titles' column, no chevron; pressed it
  // stays where it is and the rest open under it.
  assert.match(SCREEN, /className="messages-inbox-older"\s*data-inbox-more="agents"\s*aria-expanded=\{agentsExpanded\}/);
  assert.match(SCREEN, /\{agentsExpanded \? t\('messages:inbox\.older\.hide'\) : t\('messages:inbox\.older\.show', \{ count: older \}\)\}/);
  assert.match(SCREEN, /\{shown\.map\(inboxRow\)\}\s*\{more\}\s*\{olderShown\.map\(inboxRow\)\}/);
  assert.equal(message('messages:inbox.older.show', { count: 1 }), '1 older chat');
  assert.equal(message('messages:inbox.older.show', { count: 13 }), '13 older chats');
  assert.equal(message('messages:inbox.older.hide'), 'Hide older chats');
  const conversationRow = SCREEN.slice(SCREEN.indexOf('function ConversationRow'), SCREEN.indexOf('const GeneralChannelRow = memo('));
  assert.doesNotMatch(conversationRow, /KindPill/,
    'a person gets none: they are the majority, and a pill on every row says nothing');
});

test('the bot\'s row says what waits on you, and the headings say what in them asks for you', () => {
  // Its chat's own activity bar words, from the same store, once it has read.
  assert.match(SCREEN, /const parts = summaryParts\(stripGroups\(botWork\.work\)\);/);
  assert.match(SCREEN, /return parts\.length \? parts\.slice\(0, 2\)\.map\(\(part\) => part\.text\)\.join\(' · '\) : null;/);
  // #5392: the row stays current, the same live reads the DM's strip runs:
  // again whenever the list opens or the bot's work moves, fresh, and every
  // POLL_MS while the bot has work in hand and the page is in view.
  assert.match(SCREEN, /if \(mounted && botConversation\) loadBotWork\(\);/, 'fresh, after mount and whenever the bot\'s last activity moves');
  assert.match(SCREEN, /window\.addEventListener\(WORK_CHANGED_EVENT, changed\);/, 'again when the bot\'s work changes');
  assert.match(SCREEN, /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'hidden'\) loadBotWork\(\);\s*\}, POLL_MS\);/, 'every POLL_MS while it has work in hand');
  assert.match(SCREEN, /preview=\{conversation\.homeroomBot \? botLine : null\}/);
  // #5393: a group's preview names its last sender ahead of this; the bot's
  // own line (`preview`) still leads the fallback the DM rows draw.
  assert.match(SCREEN, /: groupPreview \?\? \(ownDirection\(preview \|\| conversation\.latestSummary \|\| ''\) \|\| t\('messages:inbox\.noMessages'\)\)/,
    'its last message until then — the bot\'s own line first, then a group\'s sender-prefixed one');
  assert.equal(message('messages:inbox.section.working', { count: 1 }), '1 working');
  assert.equal(message('messages:inbox.section.unread', { count: 3 }), '3 unread');
  assert.match(SCREEN, /people: \{ text: unreadFromPeople \? t\('messages:inbox\.section\.unread', \{ count: unreadFromPeople \}\) : null, ask: false \},/,
    'a zero says nothing, and the people count is grey: new to read, not waiting on you (#18)');
});

test('#5393: a group row shows its members\' faces and names the person who spoke last', () => {
  // The tile is the people in it, not the title's first letters. Only
  // people who have joined count; the viewer is never one of the faces; at
  // most two are drawn, stacked in the same 44px box the `lg` square takes
  // so the row's separator inset holds.
  const faces = SCREEN.slice(SCREEN.indexOf('function GroupFaces('), SCREEN.indexOf('const ConversationRow = memo('));
  assert.ok(faces.length > 0, 'GroupFaces is defined before the row');
  assert.match(faces, /member\.status === 'member' && Number\(member\.id\) !== viewerId/,
    'joined members only, and never the viewer');
  assert.match(faces, /\.slice\(0, 2\)/, 'two faces at most');
  assert.match(faces, /<span className="messages-group-faces" aria-hidden="true">/, 'two members: the stacked pair');
  assert.match(faces, /<UserAvatar user=\{others\[0\]\} size="sm" shape="square" \/>/, 'each face the kit\'s own sm square');
  // The row draws it for a group the viewer is in; a DM and an unanswered
  // invitation keep today's tile.
  const row = SCREEN.slice(SCREEN.indexOf('const ConversationRow = memo('), SCREEN.indexOf('const GeneralChannelRow = memo('));
  assert.match(row, /conversation\.kind === 'group' && !invited\s*\? <GroupFaces conversation=\{conversation\} \/>/);
  assert.doesNotMatch(row.slice(row.indexOf('<UserAvatar')), /<GroupFaces/, 'the fallback tile is the old one');
  // The preview names its last sender, the way #general's row already does.
  assert.match(row, /const groupSender = conversation\.kind === 'group' && !invited\s*\? conversation\.latestMessage\?\.sender \|\| null\s*: null;/);
  assert.match(row, /t\('messages:inbox\.previewYou', \{ message: ownDirection\(conversation\.latestSummary\) \}\)/, 'the viewer\'s own message reads "You: …"');
  assert.match(row, /t\('messages:inbox\.previewBy', \{ username: groupSender\.username, message: ownDirection\(conversation\.latestSummary\) \}\)/, 'anyone else reads "@name: …"');
  assert.equal(message('messages:inbox.previewYou', { message: 'hi' }), 'You: hi');
  assert.equal(message('messages:inbox.previewBy', { username: 'ada', message: 'hi' }), '@ada: hi');
  // The pair keeps the row's own geometry: a 44px box on the 74px inset.
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-group-faces \{ position: relative; flex: 0 0 44px; width: 44px; height: 44px; \}/);
  assert.match(css, /\.messages-conversation-row::after \{[^}]*inset-inline-start: 74px;/);
  assert.match(css, /\.messages-group-faces > :last-child \{ inset-inline-end: 0; bottom: 0; box-shadow: 0 0 0 2px var\(--dc-sheet-solid, var\(--app-bg\)\); \}/);
  // v3: the desktop's sidebar nests the latest conversations, with room for
  // one face: the first member who is not the viewer, at 18px.
  const rail = SCREEN.slice(SCREEN.indexOf('function railRow('), SCREEN.indexOf('function inboxRow('));
  assert.match(rail, /conversation\.members\.find\(\(member\) => member\.status === 'member' && Number\(member\.id\) !== viewerId\)/);
  assert.match(rail, /<UserAvatar user=\{face\} size="sm" shape="square" \/>/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-face > \* \{\n    width: 18px;\n    height: 18px;/);
});

test('on a desktop the list is the page, and the sidebar nests the latest conversations (v3)', () => {
  const css = read('public/css/app.css');
  // The list stood beside the strip as a 264px column of compact rows; the
  // sidebar of rows is on every desktop window now, and the list is a page.
  const P = 'html:not(.un-kb) body:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek):not(.platform-tabs-folded)) #messages-screen > .messages-layout > .messages-list-pane';
  assert.ok(!css.includes(`${P} .messages-conversation-row {`), 'no compact column rows');
  assert.ok(!css.includes(`${P} {`), 'no column');
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-list-pane \{\n    flex: 1 1 auto;/);
  assert.doesNotMatch(css, /messages-more-channels/, 'the chevron row is gone');
  // The open one is lit in the sidebar like a place.
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-place, \.platform-rail-sub\)\[aria-current="page"\] \{\n    background: var\(--lit-tint\);\n    color: var\(--lit-ink\);/);
});

test('a change in flight in Agents wears a pencil in its project\'s colour, not the project\'s icon', () => {
  // Homeroom's icon is the bot's face: with the bot first in Agents, a
  // change to Homeroom drawn with it read as a second bot.
  assert.match(SCREEN, /<SessionRow session=\{session\} showApp onNavigate=\{\(\) => \{\}\} tile=\{<ChangeTile session=\{session\} \/>\} \/>/);
  const tile = SCREEN.slice(SCREEN.indexOf('function ChangeTile'), SCREEN.indexOf('function ChangeTile') + 900);
  assert.match(tile, /const color = useCommunityColor\(\{/);
  assert.match(tile, /style=\{\{ '--change-ink': color \} as CSSProperties\} aria-hidden="true"/);
  assert.match(tile, /<PencilSparklesIcon \/>/);
  assert.match(read('frontend/src/features/improve/session-row.tsx'), /\{tile \|\| <AppTile session=\{session\} \/>\}/,
    'the Improve panel keeps the app\'s tile');
  assert.match(read('public/css/app.css'),
    /\.messages-inbox-change-tile \{[^}]*color: var\(--change-ink, var\(--text-muted\)\);\s*background: color-mix\(in srgb, var\(--change-ink, var\(--text-muted\)\) 14%, transparent\);/);
});

test('a change in flight lines up with the conversation rows on the cards (#5378)', () => {
  // The bell's row brings Tailwind's own spacing; Messages' wrapper gives it
  // the conversation row's padding, gap and type, so its tile shares the
  // avatars' edge and its title their 74px column.
  const css = read('public/css/app.css');
  assert.match(css, /\n\.messages-inbox-session > a \{ min-height: 66px; gap: 14px; padding: 13px 16px; \}/);
  assert.match(css, /\n\.messages-inbox-session > a > \.min-w-0 > :first-child \{ font-size: 15px; font-weight: 650; line-height: 20px; \}/);
  assert.match(css, /\n\.messages-inbox-session > a > \.min-w-0 > :first-child \+ \* \{ margin-top: 2px; font-size: 13px; line-height: 18px; \}/);
  const at = css.indexOf('.messages-inbox-change-tile {');
  assert.match(css.slice(at, css.indexOf('}', at)), /width: 44px;\s*height: 44px;\s*border-radius: 12px;/, 'the avatars\' 44px');
});

// ── A change is an agent conversation (#2770, #2772) ────────────────────

test('a change sorts on the Agents clock and files under Agents', () => {
  const merged = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }],
    mayors: [{ id: 4, lastActivityAt: at('2026-01-01T00:00:00Z') }],
    sessions: [{ key: 's7', lastActivityAt: at('2026-01-03T00:00:00Z') }],
  });
  assert.deepEqual(merged.map((e) => e.key), ['session:s7', 'mayor:4', 'person:1']);
  assert.deepEqual(merged.map((e) => e.section), ['agents', 'agents', 'people']);
});

test('changes are read from the Improve store and drawn by SessionRow', () => {
  assert.match(SCREEN, /useStoreState\(improveStore\)/, 'one list, the Improve store’s');
  assert.match(SCREEN, /<SessionRow\b/, 'drawn by the same row the bell’s Messages tab uses for agents');
  const list = SCREEN.slice(SCREEN.indexOf('function ConversationList'));
  const body = list.slice(0, list.indexOf('\n}\n'));
  assert.match(body, /const sessions = useMemo<SessionRowView\[\]>\(\(\) => \(mounted\s*\?/,
    'after mount only, so the first client render matches the prerender');
  // #2813: the row's address is the inbox's own, so on a desktop the session
  // opens beside the list. On a phone the router swaps it for the session
  // itself and records Messages as where it hangs off.
  assert.match(SCREEN, /href: agentThreadAddress\(\{ kind: 'session', slug: session\.appSlug, id: session\.id \}\)/,
    'a row opens the conversation itself');
  assert.match(STORE, /`#app\/\$\{encodeURIComponent\(agent\.slug\)\}\/dev\/sessions\/\$\{agent\.id\}`/);
  assert.match(read('public/js/app.js'), /Improve\.enterSessionFrom\?\.\('#messages'\)/,
    'and records Messages as where it hangs off');
  assert.doesNotMatch(STORE, /sessions:/, 'and this store holds no second copy of that list');
});

// ── Channels as things a message can name (#2783) ─────────────────────

const channels = loadTsx('frontend/src/features/messages/channels.ts');
const overview = require('../src/routes/messages-overview');

test('#general and the viewer\'s apps are the channel directory, #general first', () => {
  const list = channels.channelDirectory(
    [{ id: 3, kind: 'direct', title: 'ada' }, { id: 7, kind: 'channel', title: 'general', channelKey: 'general' }],
    [{ slug: 'recipe-ab12', name: 'Recipe Box', channel: 'recipe-box' }, { slug: 'Odd_Slug', name: '42' }],
  );
  assert.deepEqual(list.map((c) => [c.handle, c.target]), [
    ['general', '#messages/7'],
    ['recipe-box', '#messages/app/recipe-ab12'],
  ], 'a handle must start with a letter, so an app whose only name is a number has none to be named by');
  assert.equal(channels.channelHref('general'), '#messages/channel/general');
});

test('#name is a channel only when the viewer has one; #123 stays an issue and PR#123 a PR', () => {
  const known = new Set(['general', 'recipe-box']);
  const segs = channels.tokenizeRefs('see #general and #recipe-box, not #todo — #123 and PR#9 @ada', known);
  assert.deepEqual(segs.filter((s) => s.type !== 'text'), [
    { type: 'channel', handle: 'general' },
    { type: 'channel', handle: 'recipe-box' },
    { type: 'ref', isPr: false, num: '123' },
    { type: 'ref', isPr: true, num: '9' },
    { type: 'mention', name: 'ada' },
  ]);
  assert.equal(segs.map((s) => s.value || '').join('').includes('#todo'), true, 'an unknown #word is left as text');
  assert.deepEqual(channels.tokenizeRefs('x#general', known), [{ type: 'text', value: 'x#general' }],
    'not inside a word');
});

test('the app chat chips the same channels, as a link and not as a drawer ref', () => {
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /window\.UsernodeReact\?\.messages\?\.channels\?\.\(\)/, 'it reads the Messages store\'s directory');
  assert.match(gc, /link\.className = 'gc-channel-ref';/);
  assert.match(gc, /return \{ href: `#messages\/channel\/\$\{handle\}`, handle, topic: false \};/);
  // #4417: inside a project, its topics' handles (and the ones they had
  // before a rename) come first, and link to the topic's channel there.
  assert.match(gc, /window\.UsernodeReact\?\.places\?\.topicHandles\?\.\(slug\)/);
  assert.match(gc, /href: `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/c\/\$\{topic\}`, handle: topic, topic: true/);
  assert.doesNotMatch(gc, /gc-ref gc-ref-channel/, 'never `.gc-ref`, which the chat sends to the activity drawer');
  const app = read('public/js/app.js');
  assert.match(app, /parts\[1\] === 'channel'[\s\S]{0,160}openChannel\?\.\(parts\[2\] \|\| ''\)/);
  assert.match(STORE, /export function openChannel\(raw: string\): void/);
  assert.match(STORE, /window\.location\.replace\(found\.target\)/, 'the link\'s own history entry is replaced');
});

test('an app\'s channel handle is its name folded, unique within the viewer\'s list', () => {
  assert.equal(overview.channelHandle('Recipe Box!'), 'recipe-box');
  assert.equal(overview.channelHandle('42'), null);
  const list = overview.channelHandles([
    overview.toDiscussion({ slug: 'recipe-ab12', name: 'Recipe Box' }),
    overview.toDiscussion({ slug: 'recipe-cd34', name: 'recipe box' }),
    overview.toDiscussion({ slug: 'general-99', name: 'General' }),
  ]);
  assert.deepEqual(list.map((d) => d.channel), ['recipe-box', 'recipe-cd34', 'general-99'],
    'a second "Recipe Box" and an app named General fall back to their slugs');
  // #2967: the handles stay unique across BOTH sections — a `#name` in a
  // message resolves against the whole list, not one half of it.
  const sectioned = overview.channelHandles([
    overview.toDiscussion({ slug: 'notes-a1', name: 'Notes', section: 'yours' }),
    overview.toDiscussion({ slug: 'notes-b2', name: 'Notes', section: 'more' }),
  ]);
  assert.deepEqual(sectioned.map((d) => [d.section, d.channel]), [['yours', 'notes'], ['more', 'notes-b2']]);
});

test('a discussion row carries its section and unread count (#2967, #2387)', () => {
  const row = overview.toDiscussion({
    slug: 'recipe-ab12', name: 'Recipe Box', section: 'more', unread_count: '4',
    last_message: 'hi', last_at: '2026-01-02T00:00:00Z', last_by: 'ada',
  });
  assert.equal(row.section, 'more');
  assert.equal(row.unreadCount, 4, 'COUNT(*) arrives as a number; a string one is coerced');
  const bare = overview.toDiscussion({ slug: 'x', name: 'X' });
  assert.equal(bare.section, 'yours', 'anything but "more" is yours');
  assert.equal(bare.unreadCount, 0);
});

test('an app channel opened in Messages mounts its chat after React commits, so its composer is wired', () => {
  // renderGroupChatTab mounts the chat as a portal and then looks up
  // `#gc-input` to wire send, drafts and the @ / # menus. Called inside the
  // effect, the portal could not flush and nothing typed there ever sent.
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  assert.match(body, /const timer = window\.setTimeout\(\(\) => \{\s*if \(live\) view\?\.renderGroupChatTab\?\.\(\{ host: el, slug, name, readOnly, archived \}\);\s*\}, 0\);/);
  assert.match(body, /live = false;\s*window\.clearTimeout\(timer\);/);
});

// ── Bug h: the discussion pane's header tile is the app's own ────────────
//
// The pane header built its tile from `{ name }` alone, so `iconViewFor`
// could only ever fall through to the name's first letter: a "W" over the
// Whiteboard channel whose inbox row, one column to the left, wears the
// palette emoji. The header now draws the ROW's icon fields, and the app
// record the pane fetches when there is no row.

test('bug h: the discussion header draws the tile the inbox row draws', () => {
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  // The row, once, feeding both the #handle and the artwork.
  assert.match(body, /const row = snap\.discussions\.find\(\(item\) => item\.slug === slug\) \|\| null;/);
  assert.match(body, /const handle = row\?\.channel \|\| null;/);
  // The row's own two fields first — the same pair AppChannelRow hands the
  // tile — and the fetched app record when there is no row.
  assert.match(body, /icon_url: row \? row\.iconUrl : \(ready \? context\.iconUrl : null\),/);
  assert.match(body, /icon_emoji: row \? row\.iconEmoji : \(ready \? context\.iconEmoji : null\),/);
  const header = body.slice(body.indexOf('<header className="messages-thread-header">'));
  assert.match(header, /data-icon=\{appIconKind\(iconRecord as never\)\}/);
  assert.match(header, /<AppIconContent app=\{iconRecord as never\} \/>/);
  assert.doesNotMatch(header, /\{ name \} as never/, 'never the name alone again');
  // ...which is what the row itself does, so the two tiles are one recipe.
  const rowFn = SCREEN.slice(SCREEN.indexOf('function AppChannelRow'));
  assert.match(rowFn.slice(0, rowFn.indexOf('\n}\n')),
    /icon_url: discussion\.iconUrl,\s*icon_emoji: discussion\.iconEmoji,/);
});

test('bug h: the discussion context carries the app artwork, for a header with no inbox row', async () => {
  // EXECUTED against the store, with `fetch` stubbed: a discussion opened by
  // address for an app the viewer has no channel row for (a non-member
  // following a link), whose record has an emoji, and one with an uploaded
  // icon — which `/api/apps/:slug` sends as the raw row's `icon_image_id`,
  // so the store spells the platform's own `/app-icons/<id>` address, as
  // src/routes/messages-overview.js does for the row.
  const { navStore } = loadTsx('frontend/src/features/nav/nav-store.js');
  const api = {
    MessagesApiError: class MessagesApiError extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [],
  };
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, '../nav/nav-store.js': { navStore } },
  });
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const APPS = {
    'karaoke-77aa': { slug: 'karaoke-77aa', name: 'Karaoke Night', icon_emoji: '🎤', icon_image_id: null, can_collaborate: false },
    'garden-12ab': { slug: 'garden-12ab', name: 'Pixel Garden', icon_emoji: null, icon_image_id: 31, can_collaborate: true },
  };
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { search: '', hash: '' }, App: { user: { id: 7 } } };
  globalThis.fetch = async (url) => {
    const m = /^\/api\/apps\/([^/?]+)(?:\?manifest=summary)?$/.exec(url);
    if (m && APPS[m[1]]) return { ok: true, json: async () => ({ app: APPS[m[1]] }) };
    if (String(url).startsWith('/api/messages/app-discussions')) return { ok: true, json: async () => ({ discussions: [] }) };
    return { ok: false, json: async () => null };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The snapshot, read the way the pane reads it.
  const context = () => {
    let out = null;
    renderToHtml(createElement(() => { out = store.useMessagesSnapshot().discussionContext; return null; }));
    return out;
  };
  try {
    store.route(null, 'karaoke-77aa');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'karaoke-77aa', name: 'Karaoke Night', archived: false, readOnly: true, iconUrl: null, iconEmoji: '🎤',
    });
    store.route(null, 'garden-12ab');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'garden-12ab', name: 'Pixel Garden', archived: false, readOnly: false, iconUrl: '/app-icons/31', iconEmoji: null,
    });
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test('a new account\'s Messages says it is empty: #general is read but never listed here (sign-up test, 19 Oct 2026)', () => {
  // Every account is in #general, so the read always has it, and the list
  // leaves it out: the empty state has to ask the list, or it never shows.
  assert.deepEqual(inbox.buildInbox({ conversations: [{ id: 3, kind: 'channel', lastActivityAt: at('2026-10-19T00:00:00Z') }] }), []);
  assert.match(SCREEN, /\{!snap\.loadingList && !snap\.error && snap\.listLoaded && !inbox\.length\n\s+\? <div className="messages-empty"><h3>\{t\('messages:inbox\.empty\.title'\)\}<\/h3>/);
  assert.doesNotMatch(SCREEN, /!snap\.conversations\.length && !inbox\.length/);
  assert.equal(message('messages:inbox.empty.title'), 'No messages yet');
});
