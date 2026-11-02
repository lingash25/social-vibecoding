'use strict';

// Homeroom bot parity, P6 and P7: the checks_green and confirm cards, drawn
// from the metadata the server stores (services/homeroom-bot-flaky-checks.js
// cardFor, homeroom-bot-thread-tools/admin.js), in each state.
//
// Run with: node --test tests/bot-parity-p6-p7-cards-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const flaky = require('../src/services/homeroom-bot-flaky-checks');

const message = (card) => ({
  id: 7, conversationId: 3, content: 'x', createdAt: 'now', reactions: [], attachments: [], objects: [],
  sender: { id: 2, username: 'homeroom_bot', bot: true }, metadata: { homeroomBot: { kind: 'chat', card } },
});

const { ChecksGreenCard, checkSteps, checkFix } = loadTsx('frontend/src/features/messages/bot-cards/checks-green.tsx', {
  stubs: { './index': {} },
});
const { ConfirmCard, confirmState, confirmRows } = loadTsx('frontend/src/features/messages/bot-cards/confirm.tsx', {
  stubs: { './index': { async decideCard() { return {}; } } },
});

const CHANGE = { id: 5001, slug: 'usernode-2d5619', pr_number: 6125 };
const FLAKE = { issue_number: 6131, filed: true, test_name: 'kudos are counted once', state: 'building', project: 'usernode-2d5619', fixSessionId: 5010, fixPrNumber: 6133 };
const WAIT = { stage: 'fixing', synced: true, tests: [{ name: 'kudos are counted once' }] };
const drawChecks = (card) => renderToHtml(createElement(ChecksGreenCard, { message: message(card), conversationId: 3, card }));

test('the checks card draws each step, and its fix to vote on while it works', () => {
  const working = flaky.cardFor({ wait: WAIT, flakes: [FLAKE], change: CHANGE, platformSlug: 'usernode-2d5619' });
  const html = drawChecks(working);
  assert.match(html, /data-checks-green="working"/);
  assert.match(html, /Working on its checks/);
  assert.match(html, /Filed it on Homeroom&#x27;s board/);
  assert.equal((html.match(/data-check-step="/g) || []).length, working.steps.length);
  assert.match(html, /data-check-step="now"/);
  assert.match(html, /Vote on #6133/);
  assert.match(html, /See the fix/);
  assert.deepEqual(checkFix(working), { project: 'usernode-2d5619', number: 6131, sessionId: 5010, prNumber: 6133 });

  const green = flaky.cardFor({ wait: { ...WAIT, stage: 'green' }, flakes: [{ ...FLAKE, state: 'merged' }], change: CHANGE, platformSlug: 'usernode-2d5619' });
  const greenHtml = drawChecks(green);
  assert.match(greenHtml, /data-checks-green="green"/);
  assert.match(greenHtml, /Checks pass/);
  assert.doesNotMatch(greenHtml, /Vote on/, 'nothing to vote on once it is done');
  assert.doesNotMatch(greenHtml, /data-check-step="(now|todo)"/);

  const person = flaky.cardFor({ wait: { ...WAIT, stage: 'person', why: 'fix_failed' }, flakes: [{ ...FLAKE, state: 'failed' }], change: CHANGE, platformSlug: 'usernode-2d5619' });
  assert.match(drawChecks(person), /Needs a person/);

  // A card from an older or newer server, read defensively.
  assert.deepEqual(checkSteps({ steps: [{ state: 'weird', what: 'x' }, { what: '' }, 'no', { state: 'done', what: 'y', request: { project: 'p', number: 'n' } }] }),
    [{ state: 'todo', what: 'x', request: null }, { state: 'done', what: 'y', request: null }]);
  assert.match(drawChecks({ type: 'checks_green' }), /data-checks-green="working"/);
});

const CONFIRM = {
  type: 'confirm', v: 1, confirmId: '5bd69098-182d-4818-baa8-a87f5522f441', tool: 'launch_bench_run', title: 'Launch a bench run',
  rows: [{ label: 'Spend cap', value: '$20' }, { label: 'Models', value: 'z-ai/glm-5.3-flash' }], state: 'pending',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const drawConfirm = (card) => renderToHtml(createElement(ConfirmCard, { message: message(card), conversationId: 3, card }));

test('the confirm card shows exactly what will run, with Confirm and Cancel while it waits', () => {
  const html = drawConfirm(CONFIRM);
  assert.match(html, /data-confirm-card="pending"/);
  assert.match(html, /Waits for your Confirm/);
  assert.match(html, /Launch a bench run/);
  assert.match(html, /<dt[^>]*>Spend cap<\/dt><dd[^>]*>\$20<\/dd>/);
  assert.match(html, /data-confirm-action="confirm"[^>]*>Confirm</);
  assert.match(html, /data-confirm-action="cancel"[^>]*>Cancel</);

  const done = drawConfirm({ ...CONFIRM, state: 'done', result: 'Launched run 12: 8 trials, about $1.5 against a cap of $20.' });
  assert.match(done, /data-confirm-card="done"/);
  assert.match(done, /Launched run 12/);
  assert.doesNotMatch(done, /data-confirm-action/, 'no buttons once it ran');

  const failed = drawConfirm({ ...CONFIRM, state: 'failed', result: 'It did not go through: The suite is frozen.' });
  assert.match(failed, /Did not go through/);

  const expired = drawConfirm({ ...CONFIRM, expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.match(expired, /data-confirm-card="expired"/);
  assert.match(expired, /This card expired, so nothing ran/);
  assert.doesNotMatch(expired, /data-confirm-action/);

  assert.equal(confirmState({ state: 'pending', expiresAt: '2020-01-01T00:00:00Z' }), 'expired');
  assert.equal(confirmState({ state: 'cancelled' }), 'cancelled');
  assert.deepEqual(confirmRows({ rows: [{ label: 'A', value: 1 }, { value: 'no label' }, null] }), [{ label: 'A', value: '1' }]);
});
