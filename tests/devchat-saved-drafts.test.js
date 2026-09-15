// #798: saved draft messages in the dev-chat composer.
//
// While a turn is running the composer stays typable and the save icon
// parks the typed text as a DRAFT: a per-session, localStorage-backed list
// rendered above the box, each row with send / edit / trash. The invariants
// worth locking in (they're the whole point of the feature):
//
//   1. Save moves the composer text into the list (newest LAST) and clears
//      the box, so the next thought can be typed straight away.
//   2. The list is scoped per session id and survives a "reload" (a fresh
//      DevChat instance reading the same storage).
//   3. Sending is NEVER automatic and is REFUSED while a turn streams —
//      no draft can join a running turn.
//   4. Send (when idle) removes the draft and hands exactly its text to
//      sendMessage.
//   5. Edit puts the draft back in the composer, drops it from the list,
//      and parks whatever was already typed as another draft (nothing the
//      user wrote is ever thrown away) — in every chat state.
//   6. Trash removes just that draft, and an emptied list STAYS empty.
//   7. The composer is not disabled while streaming (that's what made
//      typing-while-thinking impossible before).
//   8. #1962: Send EMPTIES the composer — the visible field and the stored
//      per-session draft both — so nothing walks back in on the next
//      render. Anything typed at the time is parked as a draft of its own,
//      the same way Edit does it.
//   9. #810: the save ICON itself is only present while a TURN IS RUNNING —
//      i.e. exactly while the send button shows Stop. When the chat is
//      stopped the user can simply SEND, so the icon is hidden and saving
//      is refused (not just un-clickable). The drafts list and the typed
//      text are untouched by that. (This inverts the #801 rule.)
//
// Same harness style as devchat-composer-restore.test.js: dev-chat.js is a
// plain browser script, so we load its source into a vm context, expose
// DevChat, and drive the real methods against a minimal fake DOM.
//
// Run with: node --test tests/devchat-saved-drafts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge } = require('./lib/dev-composer-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    // #801/#810: _syncSaveDraftBtn toggles the `hidden` property, so the
    // stub must start with a real boolean (not undefined) for the
    // visibility assertions to be meaningful.
    hidden: false,
    title: '',
    placeholder: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    setSelectionRange() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

// `storage` is shared across harnesses on purpose when a test wants to
// simulate a page reload (a fresh DevChat over the same localStorage).
//
// #940: `net` is the fake server. It records every request the sync layer
// makes and answers from an in-memory draft list, so the optimistic-write
// and reconcile paths can be driven without a real backend.
//   net.server   — the drafts the "server" holds ({id, text, savedAt}[])
//   net.calls    — [{ method, url, body }] in order
//   net.fail     — when true, every request rejects (offline)
function makeHarness(storage = new Map(), net = {}) {
  net.server = net.server || [];
  net.calls = net.calls || [];
  // #1078: the drafts list, the save icon and the shortcut hint are three
  // fields of the composer's view model — `_renderSavedDrafts` and
  // `_syncSaveDraftBtn` publish rather than write. The MODEL is what these
  // tests read; the rendering of each is pinned in
  // tests/dev-chat-composer.test.js.
  const composer = makeComposerBridge();
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };

  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage,
    AbortController,
    URLSearchParams,
    // _wantsDemoDrafts reads location.search for the ?shot deep link.
    location: { search: '' },
    navigator: { maxTouchPoints: 0 },
    fetch: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const body = opts.body ? JSON.parse(opts.body) : null;
      net.calls.push({ method, url: String(url), body });
      if (net.fail) throw new Error('offline');

      const m = /^\/api\/sessions\/(\d+)\/drafts(?:\/(.+))?$/.exec(String(url));
      if (m) {
        const draftId = m[2] ? decodeURIComponent(m[2]) : null;
        if (method === 'POST') {
          if (net.server.length >= 20 && !net.server.some((d) => d.id === body.id)) {
            return {
              ok: false, status: 409,
              json: async () => ({ error: "That's 20 saved drafts — send or delete one first", code: 'draft_cap' }),
            };
          }
          if (!net.server.some((d) => d.id === body.id)) {
            net.server.push({ id: body.id, text: body.text, savedAt: body.savedAt });
          }
        } else if (method === 'DELETE') {
          net.server = net.server.filter((d) => d.id !== draftId);
        }
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, drafts: net.server.map((d) => ({ ...d })), max: 20 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.UsernodeReact = { devChat: composer.bridge };

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Render plumbing that has nothing to do with drafts.
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._renderQuickReplies = () => {};
  DevChat._applySyncBanner = () => {};
  DevChat.setTitleStatus = () => {};

  return {
    DevChat, sandbox, document, getEl, storage, net, composer,
    /** The composer's last published model. */
    view: () => composer.state(),
    /** The rendered composer, for the assertions that are about markup. */
    html: () => composer.html(),
  };
}

const SESSION_ID = 4242;
const KEY = `usernode:dc-saved-drafts:${SESSION_ID}`;

function open(DevChat, { streaming = false } = {}) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = streaming;
  DevChat.pendingAttachments = [];
}

// Array.from(): the list comes back from inside the vm context, so its
// prototype is not this realm's Array and deepStrictEqual would reject an
// otherwise identical value. Copy into a host array before asserting.
function texts(DevChat, sessionId = SESSION_ID) {
  return Array.from(DevChat._getSavedDrafts(sessionId), (d) => d.text);
}

// Saving is only possible while a turn runs (#810), so every fixture that
// needs a parked draft opens the session mid-turn.
test('save parks the composer text as a draft (newest last) and clears the box', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');

  input.value = 'first thought';
  DevChat._saveComposerDraft();
  input.value = 'second thought';
  DevChat._saveComposerDraft();

  assert.deepEqual(texts(DevChat), ['first thought', 'second thought'],
    'drafts are ordered newest LAST');
  assert.equal(input.value, '', 'composer cleared so the next note can be typed');
  assert.equal(DevChat._getDraft(SESSION_ID), '',
    'the single-composer draft is cleared too (the text lives in the list now)');
});

test('drafts are scoped per session and survive a reload', () => {
  const { DevChat, document, storage } = makeHarness();
  open(DevChat, { streaming: true });
  document.getElementById('dc-input').value = 'keep me';
  DevChat._saveComposerDraft();

  // A different session in the same browser sees none of it.
  assert.deepEqual(texts(DevChat, 999), []);

  // Fresh DevChat over the same localStorage == a page reload.
  const reloaded = makeHarness(storage);
  open(reloaded.DevChat);
  assert.deepEqual(texts(reloaded.DevChat), ['keep me'],
    'draft still there after a reload');
});

test('a draft is never sent automatically while the agent is thinking', () => {
  const { DevChat, document, view, html } = makeHarness();
  open(DevChat, { streaming: true });
  document.getElementById('dc-input').value = 'do this next';
  DevChat._saveComposerDraft();

  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  const [draft] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._sendSavedDraft(draft.id);

  assert.deepEqual(sent, [], 'send refused mid-turn');
  assert.deepEqual(texts(DevChat), ['do this next'], 'the draft is still parked');

  // And the row renders its Send button disabled while streaming.
  DevChat._renderSavedDrafts();
  assert.equal(view().drafts.busy, true);
  assert.match(html(), /dc-draft-send[^>]*disabled=""/,
    'the row Send button is rendered disabled while thinking');
});

test('send (once idle) removes the draft and sends exactly its text', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'draft A';
  DevChat._saveComposerDraft();
  input.value = 'draft B';
  DevChat._saveComposerDraft();

  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  DevChat.isStreaming = false;
  const [a] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._sendSavedDraft(a.id);

  assert.deepEqual(sent, ['draft A'], 'exactly the draft text was sent');
  assert.deepEqual(texts(DevChat), ['draft B'], 'the sent draft left the list');
});

// #1962: reported as "sending a draft populates input with an existing saved
// draft instead of clearing". Edit is how the box comes to hold another
// draft's text; Send used to leave it there, and — because the per-session
// draft key was left written too — `_restoreDraft` put it back on every
// later render, tab switch and reopen.
test('send clears the composer and the stored draft, and no render refills it', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'draft A';
  DevChat._saveComposerDraft();
  input.value = 'draft B';
  DevChat._saveComposerDraft();

  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);
  DevChat.isStreaming = false;

  // Edit A: its text is now in the box AND under the session's draft key.
  const [a, b] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._editSavedDraft(a.id);
  assert.equal(input.value, 'draft A');
  assert.equal(DevChat._getDraft(SESSION_ID), 'draft A');

  // Now send B, the draft still in the list.
  DevChat._sendSavedDraft(b.id);

  assert.deepEqual(sent, ['draft B'], 'exactly the sent draft went out');
  assert.equal(input.value, '', 'the composer is empty after the send');
  assert.equal(DevChat._getDraft(SESSION_ID), '',
    'and so is the stored draft, so nothing can restore it');

  // A re-render is where the old text used to come back.
  DevChat._restoreDraft();
  assert.equal(input.value, '', 'a render does not refill the box');

  // Nothing the user had typed was thrown away: A is a draft again.
  assert.deepEqual(texts(DevChat), ['draft A'],
    'the text displaced from the box was parked as a draft');
});

test('send parks nothing when the box holds the same text as the draft', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'only thought';
  DevChat._saveComposerDraft();

  DevChat.sendMessage = () => {};
  DevChat.isStreaming = false;

  // The box holds a copy of the draft about to be sent (the shape Edit
  // leaves behind). Parking it would keep a draft of a message that was
  // just sent, which is worse than losing nothing.
  input.value = 'only thought';
  DevChat._setDraft(SESSION_ID, 'only thought');

  const [draft] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._sendSavedDraft(draft.id);

  assert.equal(input.value, '', 'the composer is empty');
  assert.deepEqual(texts(DevChat), [], 'no duplicate of the sent text is left behind');
});

test('a render never clobbers text typed in the session it belongs to', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  DevChat._setDraft(SESSION_ID, 'stale');

  DevChat._restoreDraft();
  assert.equal(input.value, 'stale', 'first render restores the stored draft');

  // Mid-keystroke: the field is ahead of storage.
  input.value = 'stale and then some';
  DevChat._restoreDraft();
  assert.equal(input.value, 'stale and then some',
    're-rendering the same session leaves the live field alone');

  // …but switching sessions makes storage authoritative again, so session
  // A's text cannot sit in session B's composer.
  DevChat.currentSession = { id: 777, status: 'active' };
  DevChat._restoreDraft();
  assert.equal(input.value, '', 'the other session had no draft');
});

test('edit loads the draft back into the composer and parks the typed text', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');

  // Park the draft mid-turn (#810: that's the only state where saving is
  // offered), then let the turn end — edit must still work throughout,
  // since its job is to not throw away text, not to offer the save
  // affordance.
  input.value = 'reword me';
  DevChat._saveComposerDraft();
  DevChat.isStreaming = false;
  input.value = 'a half-typed follow-up';

  const [draft] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._editSavedDraft(draft.id);

  assert.equal(input.value, 'reword me', 'draft is back in the box for editing');
  assert.deepEqual(texts(DevChat), ['a half-typed follow-up'],
    'the text already in the box was parked as a draft instead of being lost');
  assert.equal(DevChat._getDraft(SESSION_ID), 'reword me',
    'composer draft persisted so the edit survives a tab switch');

  // Re-saving puts it back at the end of the list — once a turn is running.
  DevChat.isStreaming = true;
  DevChat._saveComposerDraft();
  assert.deepEqual(texts(DevChat), ['a half-typed follow-up', 'reword me']);
});

test('trash removes only that draft, and an emptied list stays empty', () => {
  const { DevChat, document, storage } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'one';
  DevChat._saveComposerDraft();
  input.value = 'two';
  DevChat._saveComposerDraft();

  const [one] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._deleteSavedDraft(one.id);
  assert.deepEqual(texts(DevChat), ['two']);

  DevChat._deleteSavedDraft(DevChat._getSavedDrafts(SESSION_ID)[0].id);
  assert.deepEqual(texts(DevChat), []);
  // #940: the mirror is a v2 object now, but the invariant is unchanged —
  // the emptied list is WRITTEN, not removed, so nothing can resurrect it
  // (key presence is what suppresses the ?shot demo seed).
  assert.ok(storage.has(KEY));
  assert.deepEqual(JSON.parse(storage.get(KEY)).drafts, [],
    'the emptied list is written, not removed, so nothing can resurrect it');
});

test('the circle is Stop until there is text, and the cap holds', () => {
  // The "disabled save icon" is gone: an empty box mid-turn is simply STOP,
  // which is a live control rather than a greyed-out one. Same rule, one
  // fewer dead affordance.
  const { DevChat, document, view } = makeHarness();
  open(DevChat, { streaming: true });
  // Through the real transition: `_composerBusy` is what decides Stop vs
  // Send, and only `_setStreamingUI` sets it. `open({streaming:true})` sets
  // the honest `isStreaming` flag but paints nothing.
  DevChat._setStreamingUI(true, 'claude');
  const input = document.getElementById('dc-input');

  DevChat._syncSaveDraftBtn();
  assert.equal(view().send.kind, 'stop', 'nothing typed → nothing to save');
  input.value = '   ';
  DevChat._syncSaveDraftBtn();
  assert.equal(view().send.kind, 'stop', 'whitespace is not a draft');
  input.value = 'something';
  DevChat._syncSaveDraftBtn();
  assert.equal(view().send.kind, 'save', 'text typed → save available');

  for (let i = 0; i < DevChat.MAX_SAVED_DRAFTS + 3; i++) {
    input.value = `note ${i}`;
    DevChat._saveComposerDraft();
  }
  assert.equal(DevChat._getSavedDrafts(SESSION_ID).length, DevChat.MAX_SAVED_DRAFTS,
    'the list is capped instead of growing without bound');
  assert.equal(input.value, `note ${DevChat.MAX_SAVED_DRAFTS + 2}`,
    'a refused save leaves the text in the box rather than dropping it');
});

test('the composer stays typable while a turn streams', () => {
  const { DevChat, view, html } = makeHarness();
  open(DevChat);

  DevChat._setStreamingUI(true, 'claude');
  assert.equal(view().placeholder, DevChat.COMPOSER_PLACEHOLDER_BUSY,
    'the busy placeholder points at saving for later');

  DevChat._setStreamingUI(false);
  assert.equal(view().placeholder, DevChat.COMPOSER_PLACEHOLDER,
    'the normal placeholder comes back when the turn ends');

  // #798: typing while the agent thinks is the point, so nothing renders
  // `disabled` on the field — which is also why nothing writes it any more.
  assert.doesNotMatch(html().slice(html().indexOf('<textarea')), /^[^>]*disabled/,
    'the box is never disabled');
});

test('typed-but-unsent text still cannot be submitted mid-turn', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'this must not join the running turn';
  const sent = [];
  DevChat.sendMessage = (m) => sent.push(m);

  DevChat._submitFromInput();

  assert.deepEqual(sent, [], 'Ctrl+Enter mid-turn sends nothing');
  assert.equal(input.value, 'this must not join the running turn',
    'and the text is left alone');
});

// ── #810: the icon is present only while a turn is RUNNING ─────────────

test('saving is offered only while a turn streams', () => {
  const { DevChat, document, view } = makeHarness();
  open(DevChat);
  const input = document.getElementById('dc-input');
  const kind = () => view().send.kind;
  input.value = 'something worth saving';

  DevChat._syncSaveDraftBtn();
  assert.equal(kind(), 'send',
    'no save affordance when the text can just be sent — the circle sends');

  DevChat.isStreaming = true;
  DevChat._syncSaveDraftBtn();
  assert.equal(kind(), 'save', 'saving takes the circle once the stop sign is up');
});

test('every streaming transition repaints the circle (incl. the mayor2 wrap-up)', () => {
  const { DevChat, document, view } = makeHarness();
  open(DevChat);
  const kind = () => view().send.kind;
  document.getElementById('dc-input').value = 'a note';

  // _setStreamingUI is the single choke point every transition funnels
  // through (send, reconnect, phase change, finish, stop).
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'claude');
  assert.equal(kind(), 'save', 'as soon as the turn starts, text makes it Save');

  DevChat._setStreamingUI(true, 'mayor2');
  assert.equal(kind(), 'save',
    'still Save through the un-stoppable wrap-up — text outranks the spinner, '
    + 'because parking it is the only thing left to do with it');

  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  assert.equal(kind(), 'send', 'and back to Send the moment the turn settles');
});

test('mid-turn, the circle swaps between Stop and Save on the field alone', () => {
  // The whole of the new rule, and the reason Stop is not lost: an empty box
  // is Stop, and SAVING EMPTIES THE BOX — so one press of the green circle
  // parks the note and hands the interrupt back.
  const { DevChat, document, view } = makeHarness();
  open(DevChat, { streaming: true });
  DevChat._setStreamingUI(true, 'claude');
  const input = document.getElementById('dc-input');
  const kind = () => view().send.kind;

  DevChat._syncSaveDraftBtn();
  assert.equal(kind(), 'stop', 'an empty box is the interrupt…');

  input.value = 'now there is something';
  DevChat._syncSaveDraftBtn();
  assert.equal(kind(), 'save', '…and typing takes it');

  DevChat._saveComposerDraft();
  assert.equal(input.value, '', 'saving blanks the field');
  assert.equal(kind(), 'stop', 'which is what gives Stop back');
});

test('saving is refused while stopped, not merely un-clickable', () => {
  const { DevChat, document } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'parked during the turn';
  DevChat._saveComposerDraft();

  // A click landing exactly as a turn ends, or any programmatic call.
  DevChat.isStreaming = false;
  input.value = 'must not become a draft while it could just be sent';
  DevChat._saveComposerDraft();

  assert.deepEqual(texts(DevChat), ['parked during the turn'],
    'the list is unchanged while the chat is stopped');
  assert.equal(input.value, 'must not become a draft while it could just be sent',
    'and the typed text is left in the box rather than swallowed');

  // Once another turn is running the same call works normally again.
  DevChat.isStreaming = true;
  DevChat._saveComposerDraft();
  assert.deepEqual(texts(DevChat),
    ['parked during the turn', 'must not become a draft while it could just be sent'],
    'saving resumes as soon as a turn is running');
  assert.equal(input.value, '', 'and the box is cleared for the next thought');
});

// ── #940: the drafts belong to the ACCOUNT, not the browser ────────────
//
// localStorage stays in the loop as a MIRROR — instant paint plus an
// offline buffer — and every mutation is optimistic-then-pushed. The
// invariants that make that safe:
//
//   9.  A save writes locally AND uploads; the row is marked synced when
//       the POST lands.
//   10. Trash / send / edit-take-back delete server-side too, via a
//       tombstone recorded FIRST so an offline delete still replays.
//   11. A failed push never loses text: the draft stays listed and
//       unsynced, and the next reconcile uploads it.
//   12. _reconcileDrafts is both the cross-device sync and the migration:
//       it unions server + local, honours tombstones, uploads local-only
//       rows, and caps the union.
//   13. A LEGACY BARE-ARRAY mirror (everything written before #940) is
//       read correctly and uploaded once.

const flush = () => new Promise((r) => setImmediate(r));

// dev-chat.js fetches /api/models at load, so "did the sync layer call the
// server?" has to look at the drafts requests specifically.
const draftCalls = (net) => net.calls.filter((c) => /\/drafts(\/|$)/.test(c.url));

// A draft as the fake server would hand it back.
const srv = (id, text, minute) => ({
  id, text, savedAt: `2026-01-01T00:0${minute}:00.000Z`,
});

test('#940: saving uploads the draft and marks it synced', async () => {
  const { DevChat, document, storage, net } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'ship it';
  DevChat._saveComposerDraft();
  await flush();

  const post = net.calls.find((c) => c.method === 'POST');
  assert.ok(post, 'a save must POST');
  assert.equal(post.url, `/api/sessions/${SESSION_ID}/drafts`);
  assert.equal(post.body.text, 'ship it');
  assert.match(post.body.id, /^[A-Za-z0-9_-]{1,32}$/);
  assert.deepEqual(net.server.map((d) => d.text), ['ship it']);

  const mirror = JSON.parse(storage.get(KEY));
  assert.equal(mirror.v, 2);
  assert.equal(mirror.drafts[0].synced, true, 'a landed upload marks the row synced');
});

test('#940: trashing a draft deletes it server-side, and a later reconcile clears the tombstone', async () => {
  // CHANGED BY #1960. This used to assert that the tombstone was gone the
  // moment the DELETE returned 200, which is what _pushDraftDelete did.
  // That is wrong, and it is the resurrection bug: the DELETE's own 200
  // says nothing about the GETs already in flight, and dropping the
  // tombstone leaves a stale one with nothing to suppress the draft it is
  // still listing. Retirement now belongs to the reconcile — which can
  // tell a snapshot older than the delete from a newer one — so the
  // tombstone outlives the round trip by design. The next reconcile is
  // the one that clears it, and this test now covers both halves.
  const { DevChat, document, storage, net } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'regrettable';
  DevChat._saveComposerDraft();
  await flush();

  const [d] = DevChat._getSavedDrafts(SESSION_ID);
  DevChat._deleteSavedDraft(d.id);
  await flush();

  const del = net.calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'trash must DELETE');
  assert.equal(del.url, `/api/sessions/${SESSION_ID}/drafts/${d.id}`);
  assert.deepEqual(net.server, [], 'the server copy is gone');
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones.map((t) => t.id), [d.id],
    'the tombstone survives the delete round trip');

  // The delete's own WS echo comes back and reconciles. THIS list is newer
  // than the delete, so it can prove the server has honoured it.
  await DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones, [],
    'a reconcile over a post-delete snapshot retires the tombstone');
  assert.deepEqual(texts(DevChat), [], 'and the draft stays gone');
});

test('#940: sending a draft removes it on every device', async () => {
  const { DevChat, document, net } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'also make it sticky';
  DevChat._saveComposerDraft();
  await flush();

  const [d] = DevChat._getSavedDrafts(SESSION_ID);
  const sent = [];
  DevChat.sendMessage = (t) => sent.push(t);
  DevChat.isStreaming = false;
  DevChat._sendSavedDraft(d.id);
  await flush();

  assert.deepEqual(sent, ['also make it sticky']);
  assert.deepEqual(net.server, [], 'a sent draft is deleted server-side too');
});

test('#940: a failed push keeps the draft listed and unsynced (nothing is lost)', async () => {
  const { DevChat, document, storage, net } = makeHarness(new Map(), { fail: true });
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'typed on a train';
  DevChat._saveComposerDraft();
  await flush();

  assert.deepEqual(texts(DevChat), ['typed on a train'], 'the text survives the failure');
  assert.equal(JSON.parse(storage.get(KEY)).drafts[0].synced, false);

  // Back online: reconcile flushes it.
  net.fail = false;
  await DevChat._reconcileDrafts(SESSION_ID, []);
  assert.deepEqual(net.server.map((d) => d.text), ['typed on a train']);
  assert.equal(JSON.parse(storage.get(KEY)).drafts[0].synced, true);
});

test('#940: an offline delete replays on the next reconcile', async () => {
  const storage = new Map();
  const net = { server: [srv('remote1', 'parked elsewhere', 1)] };
  const { DevChat } = makeHarness(storage, net);
  open(DevChat);

  // Adopt the server row, then go offline and trash it.
  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((d) => ({ ...d })));
  assert.deepEqual(texts(DevChat), ['parked elsewhere']);

  net.fail = true;
  DevChat._deleteSavedDraft('remote1');
  await flush();
  assert.deepEqual(texts(DevChat), [], 'it is gone locally straight away');
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones.map((t) => t.id), ['remote1']);

  // Reconnect: the reconcile must NOT resurrect it, and must delete it.
  net.fail = false;
  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((d) => ({ ...d })));
  assert.deepEqual(texts(DevChat), [], 'a tombstoned draft is never resurrected');
  assert.deepEqual(net.server, [], 'and the delete reached the server');
});

test('#940: reconcile unions the server list with local drafts', async () => {
  const storage = new Map();
  const net = { server: [srv('remote1', 'from the laptop', 3)] };
  const { DevChat, document } = makeHarness(storage, net);
  open(DevChat, { streaming: true });

  // A draft typed here while the server already had one of its own.
  net.fail = true;
  const input = document.getElementById('dc-input');
  input.value = 'from the phone';
  DevChat._saveComposerDraft();
  await flush();
  net.fail = false;

  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((d) => ({ ...d })));

  assert.deepEqual(texts(DevChat).sort(), ['from the laptop', 'from the phone'],
    'both devices\' drafts survive the merge');
  assert.deepEqual(net.server.map((d) => d.text).sort(), ['from the laptop', 'from the phone'],
    'and the local-only one is uploaded');
});

test('#940: reconcile orders oldest-first and caps the union at 20', async () => {
  const storage = new Map();
  // 15 on the server + 10 local = 25; the OLDEST 20 survive, matching the
  // existing cap rule (a full list refuses new saves, it never evicts).
  const server = Array.from({ length: 15 }, (_, i) => ({
    id: `s${String(i).padStart(2, '0')}`,
    text: `server ${i}`,
    savedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
  }));
  const local = Array.from({ length: 10 }, (_, i) => ({
    id: `l${String(i).padStart(2, '0')}`,
    text: `local ${i}`,
    savedAt: `2026-01-01T01:${String(i).padStart(2, '0')}:00.000Z`,
    synced: false,
  }));
  storage.set(KEY, JSON.stringify({ v: 2, drafts: local, tombstones: [] }));

  const { DevChat } = makeHarness(storage, { server: server.map((d) => ({ ...d })) });
  open(DevChat);
  await DevChat._reconcileDrafts(SESSION_ID, server.map((d) => ({ ...d })));

  // Array.from(): the list crosses the vm realm boundary (see `texts`).
  const merged = Array.from(DevChat._getSavedDrafts(SESSION_ID));
  assert.equal(merged.length, 20, 'the cap holds across the merge');
  assert.equal(merged[0].text, 'server 0', 'oldest first');
  assert.equal(merged[19].text, 'local 4', 'the newest overflow is what gets dropped');
  // Sorted ascending by savedAt throughout.
  const stamps = merged.map((d) => Date.parse(d.savedAt));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));
});

test('#940: a LEGACY bare-array mirror is read and uploaded exactly once', async () => {
  const storage = new Map();
  // Exactly what pre-#940 browsers wrote: a bare array, no sync state.
  storage.set(KEY, JSON.stringify([
    { id: 'old1', text: 'typed before the migration', savedAt: '2026-01-01T00:01:00.000Z' },
    { id: 'old2', text: 'and another one', savedAt: '2026-01-01T00:02:00.000Z' },
  ]));
  const net = { server: [] };
  const { DevChat } = makeHarness(storage, net);
  open(DevChat);

  assert.deepEqual(texts(DevChat), ['typed before the migration', 'and another one'],
    'the legacy shape still renders');

  await DevChat._reconcileDrafts(SESSION_ID, []);
  assert.deepEqual(net.server.map((d) => d.text),
    ['typed before the migration', 'and another one'],
    'the whole legacy list is adopted by the server');

  // Second pass: they are synced now, so nothing is re-posted.
  const before = draftCalls(net).filter((c) => c.method === 'POST').length;
  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((d) => ({ ...d })));
  assert.equal(draftCalls(net).filter((c) => c.method === 'POST').length, before,
    'an adopted draft is not uploaded again');
});

test('#940: reconcile never writes into another session\'s mirror', async () => {
  const storage = new Map();
  const { DevChat } = makeHarness(storage, { server: [srv('remote1', 'for session A', 1)] });
  open(DevChat);

  // The user navigates away mid-flight. `null` forces the fetch path, so
  // there is a real await for the switch to land inside.
  const pending = DevChat._reconcileDrafts(SESSION_ID, null);
  DevChat.currentSession = { id: 9999, status: 'active' };
  await pending;

  assert.equal(storage.get(KEY), undefined,
    'a session switch mid-reconcile must abandon the write');
});

test('#940: applyDraftsUpdate only reacts for the session on screen', async () => {
  const net = { server: [srv('remote1', 'saved on the laptop', 1)] };
  const { DevChat } = makeHarness(new Map(), net);
  open(DevChat);

  // A push for some other session is a no-op.
  DevChat.applyDraftsUpdate(4141);
  await flush();
  assert.equal(draftCalls(net).length, 0);

  // A push for THIS session pulls the new list in.
  DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  assert.deepEqual(texts(DevChat), ['saved on the laptop']);
});

test('#940: the drafts header tells the user the list is cross-device', () => {
  const { DevChat, document, html } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'anything';
  DevChat._saveComposerDraft();

  assert.match(html(), /Saved drafts \(1\)/);
  assert.match(html(), /on all your devices/);
});

test('#940: the ?shot demo seed still paints when nothing is stored', () => {
  // The screenshot deep link must keep working in EVERY environment (the
  // "before" shot is taken from production), with zero writes.
  const { DevChat, sandbox } = makeHarness();
  sandbox.location.search = '?shot=drafts';
  open(DevChat);
  const drafts = Array.from(DevChat._getSavedDrafts(SESSION_ID));
  assert.equal(drafts.length, 2);
  assert.match(drafts[0].text, /^Staging demo draft:/);
});

test('#940: a reconcile that finds nothing must NOT create the mirror key', async () => {
  // REGRESSION: writing an empty mirror on every session open would make the
  // key present, and key presence is exactly what suppresses the ?shot demo
  // seed — so simply opening a session would kill the screenshot deep link
  // (in production too, where the "before" shot is taken).
  const storage = new Map();
  const { DevChat, sandbox } = makeHarness(storage, { server: [] });
  sandbox.location.search = '?shot=drafts';
  open(DevChat);

  await DevChat._reconcileDrafts(SESSION_ID, []);

  assert.equal(storage.has(KEY), false, 'no drafts anywhere → no key written');
  assert.equal(Array.from(DevChat._getSavedDrafts(SESSION_ID)).length, 2,
    'so the ?shot demo seed still paints');
});

test('#940: an emptied list still stays empty across a reconcile', () => {
  // The other half of the same rule: once the user has actually emptied the
  // list, the key IS present and must keep winning over the demo seed.
  const storage = new Map();
  storage.set(KEY, JSON.stringify({ v: 2, drafts: [], tombstones: [] }));
  const { DevChat, sandbox } = makeHarness(storage, { server: [] });
  sandbox.location.search = '?shot=drafts';
  open(DevChat);

  assert.deepEqual(texts(DevChat), [],
    'an explicitly emptied list is never re-seeded by the demo drafts');
});

// ── #1960: "deleting drafts is broken" ─────────────────────────────────
//
// The trash button always worked on a quiet list; what was broken was a
// delete that landed while a reconcile was in flight. Saving a draft POSTs,
// the POST fans a `session_drafts_changed` out to every one of that user's
// sockets INCLUDING the one that sent it, and the echo runs a reconcile —
// so there is a GET in the air over exactly the seconds the user is reading
// the row they just saved and deciding to trash it. (Returning to the tab
// opens the same window, via the visibilitychange reconcile.)
//
// That GET was issued before the delete and answers with the draft still
// listed. The tombstone is what stops a reconcile re-adopting a deleted
// draft, and _pushDraftDelete used to drop it the instant the DELETE
// returned 200 — so the stale list arrived with nothing left to suppress
// it and the reconcile put the draft back in the rendered list, back in
// localStorage, and re-uploaded it on the pass after that. From the user's
// side the row reappears a moment after they trash it, and stays.
//
// The fix is a mutation counter: a snapshot taken across a local change
// may still be merged, but it may not retire a tombstone.

// A fetch wrapper that takes the drafts GET's snapshot NOW and delivers it
// LATER — a list genuinely in flight across whatever the test does next.
function holdOneGet(sandbox) {
  const real = sandbox.fetch;
  let release;
  const held = new Promise((r) => { release = r; });
  let armed = true;
  sandbox.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (armed && method === 'GET' && /\/drafts$/.test(String(url))) {
      armed = false;
      const res = await real(url, opts);
      const snapshot = await res.json();   // taken before the delete…
      await held;                          // …delivered after it
      return { ok: true, status: 200, json: async () => snapshot };
    }
    return real(url, opts);
  };
  return () => { release(); };
}

test('#1960: a delete during an in-flight reconcile is not undone', async () => {
  const { DevChat, document, storage, sandbox, net } = makeHarness();
  open(DevChat, { streaming: true });
  const input = document.getElementById('dc-input');
  input.value = 'regrettable';
  DevChat._saveComposerDraft();
  await flush();
  const [d] = DevChat._getSavedDrafts(SESSION_ID);
  assert.deepEqual(net.server.map((x) => x.id), [d.id], 'saved and uploaded');

  // The save's own WS echo starts a reconcile. Its GET sees the draft.
  const deliver = holdOneGet(sandbox);
  const reconciling = DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();

  // The user trashes the row while that list is still in the air.
  DevChat._deleteSavedDraft(d.id);
  await flush();
  assert.deepEqual(net.server, [], 'the DELETE lands');

  // Now the stale list arrives, still listing the draft.
  deliver();
  await reconciling;
  await flush();

  assert.deepEqual(texts(DevChat), [], 'the draft does not come back');
  assert.deepEqual(JSON.parse(storage.get(KEY)).drafts, [],
    'and it does not come back in storage either');
  assert.deepEqual(net.server, [], 'nor is it re-uploaded to the server');

  // One more reconcile, this time over a list nobody raced: it is safe to
  // retire the tombstone, and the draft is still gone.
  await DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  assert.deepEqual(texts(DevChat), []);
  assert.deepEqual(net.server, []);
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones, [],
    'the tombstone retires once a fresh snapshot confirms the delete');
});

test('#1960: a snapshot that predates the delete may not retire its tombstone', async () => {
  // The guard on its own. The server holds nothing, so the in-flight list
  // is EMPTY — and an empty list looks exactly like "the delete landed".
  // It isn't: it was taken before the user trashed anything, so its
  // silence is about a draft that had not been uploaded yet, not about a
  // delete being honoured. Retiring on it would leave the pending upload
  // with nothing to stop it.
  const storage = new Map();
  storage.set(KEY, JSON.stringify({
    v: 2,
    drafts: [{ ...srv('local1', 'typed here', 1), synced: false }],
    tombstones: [],
  }));
  const { DevChat, sandbox, net } = makeHarness(storage, { server: [] });
  open(DevChat);

  const deliver = holdOneGet(sandbox);
  const reconciling = DevChat._reconcileDrafts(SESSION_ID, null);
  await flush();

  DevChat._deleteSavedDraft('local1');
  await flush();

  deliver();
  await reconciling;
  await flush();

  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones.map((t) => t.id), ['local1'],
    'the tombstone survives a list that cannot speak to the delete');
  assert.deepEqual(texts(DevChat), [], 'and the draft stays deleted');
  assert.deepEqual(net.server, [], 'and is never uploaded by the reconcile flush');
});

test('#1960: a caller-supplied list never retires a tombstone', async () => {
  // openSession hands reconcile the drafts from its session payload. That
  // payload's age is invisible from here, so it is merged but not trusted
  // to declare a delete honoured — the next self-fetching pass does that.
  const storage = new Map();
  const net = { server: [srv('remote1', 'parked elsewhere', 1)] };
  const { DevChat } = makeHarness(storage, net);
  open(DevChat);
  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((x) => ({ ...x })));
  assert.deepEqual(texts(DevChat), ['parked elsewhere']);

  DevChat._deleteSavedDraft('remote1');
  await flush();
  await DevChat._reconcileDrafts(SESSION_ID, []);
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones.map((t) => t.id), ['remote1'],
    'a payload of unknown age leaves the tombstone alone');

  await DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones, [],
    'a fetch of our own retires it');
  assert.deepEqual(texts(DevChat), []);
});

test('#1960: a draft trashed before its upload lands does not survive on the server', async () => {
  // The same race in the other direction: save (POST in flight), trash
  // (DELETE reaches a server that has no such row yet), then the POST
  // lands and creates it. Nobody asked for that row, so it is undone.
  const { DevChat, document, sandbox, net, storage } = makeHarness();
  open(DevChat, { streaming: true });

  const real = sandbox.fetch;
  let releasePost;
  const heldPost = new Promise((r) => { releasePost = r; });
  sandbox.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET').toUpperCase() === 'POST') await heldPost;
    return real(url, opts);
  };

  document.getElementById('dc-input').value = 'never mind';
  DevChat._saveComposerDraft();
  await flush();
  const [d] = DevChat._getSavedDrafts(SESSION_ID);

  DevChat._deleteSavedDraft(d.id);
  await flush();
  assert.deepEqual(net.server, [], 'the DELETE hit an empty server');

  releasePost();
  await flush();
  await flush();

  assert.deepEqual(net.server, [], 'the late POST is undone rather than left behind');
  assert.deepEqual(texts(DevChat), []);
  assert.deepEqual(JSON.parse(storage.get(KEY)).drafts, []);
});

test('#1960: reconcile still re-issues the DELETE for a draft the server kept', async () => {
  // The tombstone living longer must not stop the replay it exists for.
  const storage = new Map();
  const net = { server: [srv('remote1', 'delete me', 1)] };
  const { DevChat } = makeHarness(storage, net);
  open(DevChat);
  await DevChat._reconcileDrafts(SESSION_ID, net.server.map((x) => ({ ...x })));

  net.fail = true;
  DevChat._deleteSavedDraft('remote1');
  await flush();
  net.fail = false;

  // A snapshot that still lists it, twice over: each pass re-sends the
  // idempotent DELETE rather than adopting the row.
  await DevChat._reconcileDrafts(SESSION_ID, [srv('remote1', 'delete me', 1)]);
  assert.deepEqual(texts(DevChat), []);
  assert.deepEqual(net.server, [], 'the replay reached the server');

  await DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  assert.deepEqual(JSON.parse(storage.get(KEY)).tombstones, [],
    'and the tombstone retires once the server agrees');
});

test('#1960: an ordinary save during a reconcile is still adopted', async () => {
  // The freshness guard must not make reconcile drop work — only refuse to
  // retire tombstones. A draft saved mid-reconcile is merged and uploaded.
  const { DevChat, document, sandbox, net } = makeHarness(new Map(), {
    server: [srv('remote1', 'from the laptop', 3)],
  });
  open(DevChat, { streaming: true });

  const deliver = holdOneGet(sandbox);
  const reconciling = DevChat._reconcileDrafts(SESSION_ID, null);
  await flush();

  document.getElementById('dc-input').value = 'from the phone';
  DevChat._saveComposerDraft();
  await flush();

  deliver();
  await reconciling;
  await flush();

  assert.deepEqual(texts(DevChat).sort(), ['from the laptop', 'from the phone']);
  assert.deepEqual(net.server.map((x) => x.text).sort(),
    ['from the laptop', 'from the phone']);
});

// ── #1960 / #1961: a delete must not be undone by another device ───────
//
// Every DELETE pushes a drafts-changed event to the account's OTHER tabs
// and devices, and each of them reconciles. A device still holding the
// draft in its mirror used to treat "synced here, missing on the server"
// as "local-only, upload it" — so it POSTed the draft straight back, which
// pushed another update, and the trashed (or sent) draft reappeared
// everywhere. The rule pinned here: a row this device has already seen on
// the server (`synced: true`) that the server no longer has was deleted
// elsewhere, and is dropped — never re-uploaded. Only `synced: false` rows
// (typed offline, the legacy migration) are local-only.

// Two devices on one account: separate storage, one shared server.
function twoDevices(server) {
  const net = { server };
  const a = makeHarness(new Map(), net);
  const b = makeHarness(new Map(), net);
  open(a.DevChat, { streaming: true });
  open(b.DevChat, { streaming: true });
  return { net, a, b };
}

test('#1960: a draft trashed on one device stays deleted when another syncs', async () => {
  const { net, a, b } = twoDevices([srv('shared1', 'drop me', 1), srv('shared2', 'keep me', 2)]);
  await a.DevChat._reconcileDrafts(SESSION_ID, null);
  await b.DevChat._reconcileDrafts(SESSION_ID, null);
  assert.deepEqual(texts(b.DevChat), ['drop me', 'keep me'], 'both devices adopted the list');

  a.DevChat._deleteSavedDraft('shared1');
  await flush();
  assert.deepEqual(net.server.map((d) => d.id), ['shared2']);

  // The drafts-changed push reaches device B, which reconciles.
  b.DevChat.applyDraftsUpdate(SESSION_ID);
  await flush();
  await flush();

  assert.deepEqual(net.server.map((d) => d.id), ['shared2'],
    'device B must not upload the trashed draft back');
  assert.equal(draftCalls(net).filter((c) => c.method === 'POST').length, 0,
    'no re-upload at all');
  assert.deepEqual(texts(b.DevChat), ['keep me'], 'and B drops it from its own list');

  // Device A's next sync finds it gone too.
  await a.DevChat._reconcileDrafts(SESSION_ID, null);
  assert.deepEqual(texts(a.DevChat), ['keep me']);
});

test('#1961: a draft sent on one device is not resurrected by another', async () => {
  const { net, a, b } = twoDevices([srv('shared1', 'send me', 1)]);
  await a.DevChat._reconcileDrafts(SESSION_ID, null);
  await b.DevChat._reconcileDrafts(SESSION_ID, null);

  const sent = [];
  a.DevChat.sendMessage = (t) => sent.push(t);
  a.DevChat.isStreaming = false;
  a.DevChat._sendSavedDraft('shared1');
  await flush();
  assert.deepEqual(sent, ['send me']);

  await b.DevChat._reconcileDrafts(SESSION_ID, null);
  await a.DevChat._reconcileDrafts(SESSION_ID, null);

  assert.deepEqual(net.server, [], 'the sent draft stays deleted server-side');
  assert.deepEqual(texts(a.DevChat), [], 'the sender does not get it back');
  assert.deepEqual(texts(b.DevChat), [], 'nor does the other device');
});

test('#1960: an unsynced draft is still uploaded, even after a deletion elsewhere', async () => {
  const { net, a, b } = twoDevices([srv('shared1', 'drop me', 1)]);
  await b.DevChat._reconcileDrafts(SESSION_ID, null);

  // B parks a draft while offline; meanwhile A trashes the shared one.
  net.fail = true;
  b.document.getElementById('dc-input').value = 'typed offline on B';
  b.DevChat._saveComposerDraft();
  await flush();
  net.fail = false;
  await a.DevChat._reconcileDrafts(SESSION_ID, null);
  a.DevChat._deleteSavedDraft('shared1');
  await flush();

  await b.DevChat._reconcileDrafts(SESSION_ID, null);
  assert.deepEqual(net.server.map((d) => d.text), ['typed offline on B'],
    'the offline draft is flushed, the deleted one is not');
  assert.deepEqual(texts(b.DevChat), ['typed offline on B']);
});
