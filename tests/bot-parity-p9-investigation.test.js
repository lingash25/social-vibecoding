'use strict';

// Homeroom bot parity, P9: an investigation's rules (src/workflow/rules/
// investigation.ts: what may be asked, the schedule's maths, when it ends),
// the bot-investigation machine's definition, the bot's own pure parts
// (services/homeroom-bot-thread-tools/investigate.js) and the card the
// client draws (frontend/src/features/messages/bot-cards/investigation.tsx),
// rendered for each state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../src/workflow/rules/investigation.ts');
const { botInvestigation, WORK } = require('../src/workflow/bot-investigation/machine.ts');
const inv = require('../src/services/homeroom-bot-thread-tools/investigate');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-02T08:00:00.000Z');

test('what may be asked: the defaults, and each limit refused in words', () => {
  assert.deepEqual(rules.investigationSpec({ project: 'gym-tracker', goal: 'Find out why the sync check fails now and then.' }),
    { ok: true, project: 'gym-tracker', goal: 'Find out why the sync check fails now and then.', everyHours: 6, days: 5, budgetCents: 300 });
  assert.deepEqual(rules.investigationSpec({ project: 'gym', goal: 'Watch the sign-up errors.', everyHours: 2, days: 14, budgetDollars: 10 }),
    { ok: true, project: 'gym', goal: 'Watch the sign-up errors.', everyHours: 2, days: 14, budgetCents: 1000 });
  assert.equal(rules.investigationSpec({ project: 'gym', goal: 'Watch it.', budgetDollars: '$2.50' }).ok, false, 'a goal of a sentence');
  assert.equal(rules.investigationSpec({ project: 'gym', goal: 'Watch the sign-up errors.', budgetDollars: '$2.50' }).budgetCents, 250);
  for (const bad of [{ everyHours: 0 }, { everyHours: 25 }, { everyHours: 1.5 }, { days: 15 }, { days: 0 }, { budgetDollars: 11 }, { budgetDollars: 0 }, { budgetDollars: 'lots' }]) {
    const out = rules.investigationSpec({ project: 'gym', goal: 'Watch the sign-up errors.', ...bad });
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.ok(out.error.length > 10 && !/\u2014/.test(out.error));
  }
  assert.equal(rules.investigationSpec({ goal: 'Watch the sign-up errors.' }).ok, false);
});

test('the schedule: when it ends, which day it is, when the next check-in is', () => {
  assert.equal(rules.endsAtOf(T0, 5).toISOString(), '2026-11-07T08:00:00.000Z');
  assert.equal(rules.dayOf(T0, T0, 5), 1);
  assert.equal(rules.dayOf(T0, new Date(T0.getTime() + 23 * HOUR), 5), 1);
  assert.equal(rules.dayOf(T0, new Date(T0.getTime() + 25 * HOUR), 5), 2);
  assert.equal(rules.dayOf(T0, new Date(T0.getTime() + 30 * 24 * HOUR), 5), 5, 'never past its last day');
  assert.equal(rules.dayOf(null, T0, 5), 1);

  const ledger = { spentCents: 40, budgetCents: 300, everyMs: 6 * HOUR, endsAt: rules.endsAtOf(T0, 5).toISOString(), failures: 0 };
  const now = new Date(T0.getTime() + 6 * HOUR);
  assert.deepEqual(rules.afterCheckIn(ledger, { ran: true, costCents: 12.2 }, now),
    { at: new Date(now.getTime() + 6 * HOUR), spentCents: 53, ran: true, failures: 0 }, 'its spend rounded up, the next one an interval later');
  assert.equal(rules.afterCheckIn(ledger, { ran: true, answered: true, costCents: 5 }, now).end, 'answered');
  assert.equal(rules.afterCheckIn(ledger, { ran: true, costCents: 260 }, now).end, 'budget');
  const late = new Date(rules.endsAtOf(T0, 5).getTime() - 2 * HOUR);
  assert.equal(rules.afterCheckIn(ledger, { ran: true, costCents: 5 }, late).end, 'days', 'no check-in past its last day');
  assert.equal(rules.afterCheckIn(ledger, { stop: 'bot_off' }, now).end, 'bot_off');
  assert.equal(rules.afterCheckIn(ledger, { stop: 'paused' }, now).end, 'paused');
  const busy = rules.afterCheckIn(ledger, { busy: true }, now);
  assert.equal(busy.at.getTime() - now.getTime(), rules.BUSY_RETRY_MS);
  assert.equal(busy.spentCents, 40);
  assert.equal(rules.afterCheckIn(ledger, { skipped: 'allowance' }, now).at.getTime() - now.getTime(), 6 * HOUR);
  // Failures: an hour later at most, and the third in a row ends it.
  const failed = rules.afterCheckIn(ledger, { failed: true }, now);
  assert.equal(failed.failures, 1);
  assert.equal(failed.at.getTime() - now.getTime(), HOUR);
  assert.equal(rules.afterCheckIn({ ...ledger, failures: 2 }, { failed: true }, now).end, 'failed');
  assert.equal(rules.afterCheckIn({ ...ledger, failures: 2 }, { ran: true, costCents: 1 }, now).failures, 0, 'a check-in that ran clears the streak');
  // When one comes due.
  assert.equal(rules.dueCheck(ledger, now), null);
  assert.equal(rules.dueCheck({ ...ledger, spentCents: 300 }, now), 'budget');
  assert.equal(rules.dueCheck(ledger, rules.endsAtOf(T0, 5)), 'days');
});

test('the machine is a valid definition with its work kinds', () => {
  const m = botInvestigation();
  assert.equal(m.name, 'bot-investigation');
  assert.deepEqual([...m.terminal], ['ended']);
  assert.deepEqual(Object.values(WORK).sort(), ['investigation.card', 'investigation.checkIn', 'investigation.ended']);
  for (const type of ['Started', 'CheckInDue', 'StopRequested']) assert.ok(m.events.has(type), type);
});

test('the bot\'s own parts: the model\'s name, the proposed card, the card\'s rows, its words', () => {
  assert.equal(inv.modelName('deepseek/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(inv.modelName('z-ai/glm-5.3-flash'), 'GLM 5.3 Flash');
  assert.equal(inv.modelName(null), null);
  const card = inv.proposedCard({ id: 7, goal: 'Why does the sync check fail now and then?', every_hours: 6, days: 5, budget_cents: 300 },
    { slug: 'gym-tracker', name: 'Gym Tracker' }, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(card, {
    type: 'investigation', v: 1, investigationId: 7, state: 'proposed', goal: 'Why does the sync check fail now and then?',
    project: { slug: 'gym-tracker', name: 'Gym Tracker' }, everyHours: 6, days: 5, budgetCents: 300, spentCents: 0, model: 'DeepSeek V4.1 Flash',
  });
  const parts = inv.rowParts({
    notes: 'n'.repeat(5000),
    checkins: [1, 2, 3, 4].map((n) => ({ n, seq: n, at: `2026-11-0${n}T08:00:00.000Z`, line: `Check-in ${n}.`, ok: true })),
  });
  assert.deepEqual(parts.checkins.map((c) => c.line), ['Check-in 2.', 'Check-in 3.', 'Check-in 4.'], 'the last three');
  assert.ok(parts.notes.length <= 3001 && parts.notes.startsWith('…'));
  assert.equal(inv.lastRanAt([{ at: 'a' }, { at: 'b', skipped: true }]), 'a');
  assert.equal(inv.lastRanAt([]), null);
  assert.match(inv.endedText('answered', 'Why does sync fail?'), /has ended: it found the answer/);
  assert.equal(inv.endedText('stopped', 'x'), null, 'a Stop is theirs: nothing is said');
  assert.match(inv.updateText({ n: 2, line: 'The check failed again at 3am.', ok: true }), /^Check-in 2 of your investigation: The check failed again at 3am\./);
  const words = [inv.endedText('budget', 'x'), inv.endedText('days', 'x'), inv.endedText('paused', 'x'), JSON.stringify(inv.INVESTIGATION_TOOL),
    inv.promptLines({ user: { id: 1 }, settings: { mode: 'live' } }).join('\n')].join('\n');
  assert.ok(!/\u2014/.test(words), 'no em dash in what the bot says');
  assert.doesNotMatch(inv.promptLines({ user: { id: 1 }, settings: { mode: 'live' } }).join(' '), /\$\d/, 'its prompt names no money');
  assert.deepEqual(inv.tools({ user: { id: 1 }, settings: { mode: 'off' } }), []);
});

// ── The card ───────────────────────────────────────────────────────────

const ENTRY = 'frontend/src/features/messages/bot-cards/investigation.tsx';
function cardModule(taps = []) {
  return loadTsx(ENTRY, {
    stubs: {
      '../../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
      '../../../lib/i18n/runtime': { getLanguage: () => 'en-US' },
      './index': {
        decideCard: async (_m, action) => { taps.push(['decide', action]); return { ok: true }; },
        sayAsMe: async (_m, words) => { taps.push(['say', words]); },
      },
    },
  });
}
const msg = { id: 91, sender: { bot: true }, metadata: {} };
const render = (mod, card) => renderToHtml(createElement(mod.InvestigationCard, { message: msg, conversationId: 4, card }));

test('the card, proposed: its label, goal, cadence and model, budget in money, Start and Not now', () => {
  const mod = cardModule();
  const html = render(mod, {
    type: 'investigation', v: 1, investigationId: 7, state: 'proposed', goal: 'Why does the sync check fail now and then?',
    project: { slug: 'gym-tracker', name: 'Gym Tracker' }, everyHours: 6, days: 5, budgetCents: 300, spentCents: 0, model: 'DeepSeek V4.1 Flash',
  });
  assert.match(html, /data-bot-investigation="proposed"/);
  assert.ok(html.includes(message('messages:botCards.investigation.labelProposed', { count: 5 })));
  assert.ok(html.includes('Why does the sync check fail now and then?'));
  assert.ok(html.includes(message('messages:botCards.investigation.cadenceProjectModel', { count: 6, project: 'Gym Tracker', model: 'DeepSeek V4.1 Flash' })));
  assert.ok(html.includes('Budget $3.00'));
  assert.match(html, /data-bot-investigation-start=""/);
  assert.match(html, /data-bot-investigation-not-now=""/);
  assert.doesNotMatch(html, /data-bot-investigation-stop|rounded-full bg-\[color:var\(--lit-ink\)\]/, 'no Stop, and no bar before anything is spent');
});

test('the card, running: day N of M, spent of budget over a bar in the lit ink, the next check-in, the timeline, Stop and Notes', () => {
  const mod = cardModule();
  const startedAt = new Date(Date.now() - 26 * HOUR).toISOString();
  const nextAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const html = render(mod, {
    type: 'investigation', v: 1, investigationId: 7, state: 'running', goal: 'Why does the sync check fail now and then?',
    project: { slug: 'gym-tracker', name: 'Gym Tracker' }, everyHours: 6, days: 5, budgetCents: 300, spentCents: 38,
    startedAt, nextAt, checkinsDone: 2, notes: 'Check-in 1: it fails near midnight.',
    checkins: [{ at: startedAt, line: 'It fails near midnight.' }, { at: new Date(Date.now() - 4 * HOUR).toISOString(), line: 'Failed again at 3am.' }],
  });
  assert.ok(html.includes(message('messages:botCards.investigation.label', { day: 2, days: 5 })));
  assert.ok(html.includes('$0.38 of $3.00 spent'));
  assert.match(html, /bg-\[color:var\(--lit-ink\)\]" style="width:13%"/);
  assert.match(html, /data-bot-investigation-next="">Next check-in at /);
  assert.ok(html.includes('Failed again at 3am.'));
  assert.match(html, /data-bot-investigation-stop=""/);
  assert.match(html, /data-bot-investigation-notes-toggle=""/);
  assert.match(html, /data-bot-investigation-file=""/);
  assert.doesNotMatch(html, /data-bot-investigation-start/);
  assert.doesNotMatch(html, /data-bot-investigation-notes=""/, 'the notes stay shut until asked for');
});

test('the card, ended: why it ended, its spend in grey, Notes and File what it found, no Stop', () => {
  const mod = cardModule();
  const startedAt = new Date(Date.now() - 5 * 24 * HOUR).toISOString();
  const html = render(mod, {
    type: 'investigation', v: 1, investigationId: 7, state: 'ended', goal: 'Why does the sync check fail now and then?',
    everyHours: 6, days: 5, budgetCents: 300, spentCents: 300, startedAt, endedAt: new Date().toISOString(),
    endedReason: 'budget', nextAt: null, notes: 'Everything it found.', checkins: [],
  });
  assert.ok(html.includes(message('messages:botCards.investigation.ended.budget')));
  assert.ok(html.includes(message('messages:botCards.investigation.label', { day: 5, days: 5 })));
  assert.match(html, /h-full rounded-full bg-zinc-400/);
  assert.doesNotMatch(html, /data-bot-investigation-stop|data-bot-investigation-next/);
  assert.match(html, /data-bot-investigation-file=""/);
  const stopped = render(mod, { type: 'investigation', state: 'ended', goal: 'G', endedReason: 'stopped' });
  assert.ok(stopped.includes(message('messages:botCards.investigation.ended.stopped')));
  const declined = render(mod, { type: 'investigation', state: 'declined', goal: 'G' });
  assert.ok(declined.includes(message('messages:botCards.investigation.declined')));
  assert.doesNotMatch(declined, /<button/);
  // A card from an older or newer server, read defensively.
  assert.doesNotThrow(() => render(mod, { type: 'investigation' }));
  assert.doesNotThrow(() => render(mod, { type: 'investigation', state: 'nonsense', checkins: 'x', project: 3, everyHours: 'a' }));
});

test('the card\'s source keeps the shell\'s rules: catalog words, the palette, whole class literals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', ENTRY), 'utf8');
  assert.doesNotMatch(src, /\b(?:gray|indigo)-\d/);
  assert.ok(!src.includes('\u2014'));
  assert.match(src, /messages:botCards\.investigation\.fileWords/);
  assert.match(src, /sayAsMe\(message, t\('messages:botCards\.investigation\.fileWords'\)\)/);
  for (const action of ['start', 'not_now', 'stop']) assert.ok(src.includes(`tap('${action}')`), action);
  const registry = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/messages/bot-cards/registry.ts'), 'utf8');
  assert.match(registry, /investigation: InvestigationCard/);
});
