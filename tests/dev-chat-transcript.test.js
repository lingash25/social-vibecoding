// #dc-messages — the dev chat's transcript, as a React island.
//
// This was `renderMessages`: one 560-line `container.innerHTML = …` and, on
// top of it, five separate writers that reached back into the string it had
// just produced because a full repaint mid-turn was too expensive —
//
//   • `_renderStreamingMarkdown` assigned `innerHTML` on the last
//     `.dc-msg-assistant .dc-msg-content` up to sixty times a second;
//   • `_patchProgressDom` / `_patchProgressSummary` wrote the streaming log's
//     `<pre>` and four sibling spans by persist-id;
//   • `_applyEstimate` wrote a run's `.dc-cc-estimate`, and `_clearEstimate`
//     blanked every one of them;
//   • `_tickElapsed` walked three `data-*` anchors and wrote `textContent`
//     once a second;
//   • `_syncActivityNode` appended and removed `#dc-spinner`.
//
// Every one of those is a publish now, and the two things that made them
// necessary are what this file pins:
//
//   1. A republish is a RECONCILE, so a mid-turn patch costs the one node
//      whose text changed instead of re-parsing the whole conversation.
//   2. The live bubble has its OWN store, so a 60fps publish re-renders one
//      row rather than the list.
//
// Run with: node --test tests/dev-chat-transcript.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  makeTranscriptBridge, transcriptHtml, rowHtml, setTranscriptNow, setStream,
} = require('./lib/dev-transcript-html');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const SUMMARY_SRC = read('public', 'js', 'cc-progress-summary.js');
const TRANSCRIPT_TSX = read('frontend', 'src', 'features', 'dev-chat', 'transcript.tsx');
const STORE_TS = read('frontend', 'src', 'features', 'dev-chat', 'transcript-store.ts');

function makeDevChat(over = {}) {
  const t = makeTranscriptBridge();
  const messagesEl = {
    innerHTML: '', scrollTop: 0, scrollHeight: 0,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  // The heartbeat gate: `_syncElapsedTicker` asks the DOM whether this render
  // left anything that ticks, so the stub answers for whatever the last
  // publish put on screen.
  let ticking = false;
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    App: { currentApp: 'demo-app', switchTab: () => {} },
    document: {
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => (ticking ? { ...noopEl } : null),
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(), attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }), swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    requestAnimationFrame: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.UsernodeReact = { devChat: t.bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${SUMMARY_SRC}\n${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (s) => `<p>${String(s || '')}</p>`;
  DevChat.currentSession = { id: 7, status: 'active' };
  Object.assign(DevChat, over);
  return {
    DevChat, sandbox, t,
    setTicking(v) { ticking = v; },
    render(messages, session) {
      if (messages) DevChat.messages = messages;
      if (session !== undefined) DevChat.currentSession = session;
      DevChat.renderMessages();
      return t.html();
    },
  };
}

const sys = (content, over) => ({
  role: 'system', content, id: null, _slug: 's1',
  created_at: '2026-08-24T00:00:00.000Z', ...over,
});
const ai = (content, over) => ({
  role: 'assistant', content, id: 9, created_at: '2026-08-24T00:00:00.000Z', ...over,
});
const user = (content, over) => ({
  role: 'user', content, id: 8, created_at: '2026-08-24T00:00:00.000Z', ...over,
});

// ── 1. The five writers are gone ───────────────────────────────────────

test('no path writes into #dc-messages any more', () => {
  // The host is features/dev-chat/view.tsx's now — the whole screen
  // converted — and it still carries the pane's scroll geometry, the
  // click/keydown/scroll `initScrollTracking` binds on it, and the
  // MutationObserver that follows the transcript to the bottom. What must not
  // come back is a WRITER inside it.
  const at = DEV_CHAT_SRC.indexOf('  renderMessages() {');
  assert.ok(at > 0, 'renderMessages is still the entry point every caller uses');
  const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  assert.match(body, /react\.publishTranscript\(DevChat\._transcriptView\(\)\)/,
    'the rows are one publish');
  assert.doesNotMatch(body, /innerHTML\s*=/, 'renderMessages assigns no markup');

  // The four in-place patch paths all collapse onto one publish.
  for (const fn of ['_patchProgressDom', '_syncActivityNode', '_clearEstimate']) {
    const fnAt = DEV_CHAT_SRC.indexOf(`  ${fn}(`);
    assert.ok(fnAt > 0, `${fn} is still the entry point`);
    const fnBody = DEV_CHAT_SRC.slice(fnAt, DEV_CHAT_SRC.indexOf('\n  },', fnAt));
    assert.match(fnBody, /DevChat\._publishTranscript\(\)/, `${fn} publishes`);
    assert.doesNotMatch(fnBody, /innerHTML|textContent|insertAdjacentHTML/,
      `${fn} touches no node`);
  }

  // And the string builders whose jobs moved into the model are retired.
  // Matched as a DEFINITION, not as a bare word: the comments explaining what
  // each one was legitimately name it.
  for (const gone of [
    '_countdownSpanHtml', '_statusElapsedHtml', '_ccOpenAttrs',
    '_attachmentsRowHtml', '_qaChipsHtml', '_activityHtml',
    '_applyDetailsPersistence', '_patchProgressSummary',
  ]) {
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`\n  ${gone}\\(`), `${gone} is retired`);
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`DevChat\\.${gone}\\(`), `nothing calls ${gone}`);
  }
});

test('nothing resolves the live bubble by "the last .dc-msg-content"', () => {
  // The old writer took an ELEMENT, found as
  // `querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content')
  // [length - 1]`. Three call sites did that, and one of them lives in
  // public/js/app.js — outside the module that was converted, which is why
  // the sweep has to be repo-wide. It takes the MESSAGE now and publishes a
  // frame keyed to that message's row.
  // The comments explaining what was retired legitimately quote the selector,
  // so strip comments first — what is left is what actually runs.
  const strip = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const appSrc = read('public', 'js', 'app.js');
  for (const [name, raw] of [['dev-chat.js', DEV_CHAT_SRC], ['app.js', appSrc]]) {
    const src = strip(raw);
    assert.doesNotMatch(src, /\.dc-msg-assistant \.dc-msg-content/,
      `${name} must not resolve a bubble's content node by selector`);
    for (const m of src.matchAll(/_renderStreamingMarkdown\(([^,)]+)/g)) {
      assert.match(m[1].trim(), /^(am|msg|assistantMsg|DevChat\._streamPending)/,
        `${name} passes a message to the streaming writer, not an element`);
    }
  }
});

test('the transcript and its live bubble flush synchronously', () => {
  // `DevChat.scrollToBottom()` runs on the line after `renderMessages()` in
  // nineteen places and after every streamed frame, and it measures the
  // container the publish above it just grew.
  const mount = read('frontend', 'src', 'features', 'dev-chat', 'mount.ts');
  assert.match(mount, /transcriptStore\.setFlush\(flushSync\);/);
  assert.match(mount, /streamStore\.setFlush\(flushSync\);/);
  // The clock is the one that must NOT: nobody measures after a tick.
  assert.doesNotMatch(mount, /nowStore\.setFlush/);
});

// ── 2. The live bubble's own store ─────────────────────────────────────

test('exactly one component subscribes to the stream store', () => {
  // This is the whole reason there are two stores. If any row above the live
  // one read `streamStore`, a 60fps publish would re-render the list.
  const subs = TRANSCRIPT_TSX.match(/useStoreState\((\w+)\)/g) || [];
  assert.deepEqual(
    subs.filter((m) => m.includes('streamStore')).length, 1,
    'only LiveContent may read the stream store'
  );
  const at = TRANSCRIPT_TSX.indexOf('function LiveContent');
  assert.ok(at > 0);
  const body = TRANSCRIPT_TSX.slice(at, TRANSCRIPT_TSX.indexOf('\nfunction ', at + 1));
  assert.match(body, /s\.key === rowKey \? s\.html : ''/,
    'a frame from the previous turn must not paint into this row');
});

test('a streamed frame publishes the row it belongs to, and only while a turn runs', () => {
  const h = makeDevChat({ isStreaming: true });
  // The bubble always has content by the time the writer runs: every call
  // site appends the token to `msg.content` first. An assistant row that is
  // still empty is skipped by the model — it exists only as the target the
  // first token will land in.
  const msg = ai('partial text');
  h.DevChat.messages = [user('go'), msg];
  h.DevChat._renderStreamingMarkdown(msg, 'partial text');
  // No requestAnimationFrame in the sandbox → the setTimeout(16) path.
  return new Promise((done) => setTimeout(() => {
    const s = h.t.stream();
    assert.equal(s.key, '9', 'keyed to the assistant row');
    assert.match(s.html, /partial text/);
    assert.equal(h.DevChat._streamKey, '9', 'a turn is writing');

    // The live row renders the stream; every other row renders its model.
    h.render();
    const rows = h.t.state().rows;
    assert.deepEqual(rows.filter((r) => r.live).map((r) => r.key), ['9']);
    setStream(s.key, '<em>the live frame</em>');
    assert.match(h.t.html(), /dc-msg-content"><em>the live frame<\/em>/,
      'the live bubble paints the frame, not the model content');
    setStream('', '');
    done();
  }, 25));
});

test('sealing a turn clears the live key BEFORE the render that follows', () => {
  // `renderMessages` runs on the very next line of the `done` handler, and
  // `_transcriptView` reads `_streamKey` to decide which row is live. A row
  // that is no longer being written must render from the model — `msg.content`
  // is authoritative by then — or the sealed text vanishes on that render.
  const h = makeDevChat({ isStreaming: true });
  const msg = ai('the whole reply');
  h.DevChat.messages = [msg];
  h.DevChat._streamKey = '9';
  h.DevChat._streamPending = { key: '9', fullText: 'the whole reply', breaks: true };
  h.DevChat._flushStreamingFinal();
  assert.equal(h.DevChat._streamKey, null, 'cleared first');
  assert.match(h.t.stream().html, /the whole reply/, 'and the sealed text was published');

  const at = DEV_CHAT_SRC.indexOf('  _flushStreamingFinal() {');
  const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  const clearAt = body.indexOf('DevChat._streamKey = null;');
  const flushAt = body.indexOf('_writeStreamingHtml');
  assert.ok(clearAt > 0 && flushAt > clearAt, 'the clear must precede the final write');
});

test('only the last conversational row is marked live, and only mid-turn', () => {
  const h = makeDevChat({ isStreaming: false });
  const rowsOf = () => h.t.state().rows;

  h.render([user('go'), ai('hello')]);
  assert.ok(rowsOf().every((r) => !r.live), 'an idle transcript has no live row');

  h.DevChat.isStreaming = true;
  h.render([user('go'), ai('hel')]);
  assert.deepEqual(rowsOf().filter((r) => r.live).map((r) => r.key), ['9']);

  // A status line arriving mid-turn sits BELOW the bubble; the bubble is
  // still the row being written.
  h.render([user('go'), ai('hel'), sys('Claude Code is running', { _active: true })]);
  assert.deepEqual(rowsOf().filter((r) => r.live).map((r) => r.key), ['9']);

  // …but a credits card is not a bubble a turn writes into.
  h.render([user('go'), ai('', { creditsCard: {} })]);
  assert.ok(rowsOf().every((r) => !r.live), 'the out-of-credits reply is not live');
});

// ── 3. The ticking spans are derived, not patched ──────────────────────

test('a live status row re-derives its elapsed label from the clock', () => {
  const since = 1_800_000_000_000;
  const row = {
    t: 'status', key: 'k', icon: 'spinner', text: 'Thinking…',
    elapsed: { kind: 'since', since }, stamp: '1 2',
  };
  setTranscriptNow(0);
  assert.match(rowHtml(row), /data-elapsed-since="1800000000000"><\/span>/,
    'before the first tick the span is empty — the anchor is all it carries');
  setTranscriptNow(since + 64_000);
  assert.match(rowHtml(row), />\(1m 04s\)</, 'and the label is derived from the clock');
  setTranscriptNow(0);
});

test('a settled step carries its frozen label in the model, not a ticker', () => {
  const h = makeDevChat();
  h.render([sys('Claude Code finished', { durationMs: 64_000 })]);
  assert.deepEqual(h.t.state().rows[0].elapsed, { kind: 'fixed', label: '(took 1m 04s)' });
  assert.doesNotMatch(h.t.html(), /data-elapsed-since/,
    'a finished step must not leave an anchor that keeps the heartbeat alive');
});

test('the heartbeat publishes the clock and nothing else', () => {
  const h = makeDevChat();
  h.setTicking(true);
  h.DevChat._tickElapsed();
  assert.ok(h.t.now() > 0, 'the tick is one publish of Date.now()');

  // …and it stops itself when the render left nothing that ticks.
  h.setTicking(false);
  h.DevChat._elapsedTimer = 1;
  h.DevChat._tickElapsed();
  assert.equal(h.DevChat._elapsedTimer, null, 'the timer stops when no anchor is left');
});

// ── 4. The progress run's summary ──────────────────────────────────────

const RUN = () => [
  sys('Claude Code is running', { id: 101, _active: true, created_at: '2026-08-24T00:00:00.000Z' }),
  sys('progress', { id: 102, progressLog: ['[claude (mode build)]', 'Editing src/a.js'] }),
];

test('a streamed progress line is one publish, and the pair still merges', () => {
  const h = makeDevChat();
  const msgs = RUN();
  h.render(msgs);
  const [row] = h.t.state().rows;
  assert.equal(row.t, 'attached', 'the status line is the summary of its log');
  assert.equal(row.body.persistId, '102:progress', 'the inner pre keeps the progress pid');
  assert.equal(row.details.persistId, '101:ccrun', '#647: the outer pid follows the STATUS row');

  assert.equal(row.progress.phase, 'Claude is working', 'the deterministic stage reads the marker');
  msgs[1].progressLog.push('[commit]');
  h.DevChat._patchProgressDom(msgs[1]);
  const after = h.t.state().rows[0];
  assert.match(after.body.text, /\[commit\]$/, 'the log grew');
  assert.equal(after.progress.phase, 'Committing', 'and the deterministic stage followed it');
});

test('the AI guess lands on the row that owns it and nowhere else', () => {
  const h = makeDevChat();
  const msgs = [...RUN(), sys('Building staging preview…', { id: 103, _active: true })];
  h.render(msgs);
  h.DevChat._applyEstimate('about 2 min', 120, { estimatedAt: Date.now() });

  const rows = h.t.state().rows;
  const withGuess = rows.filter((r) => r.t === 'attached' && r.progress && r.progress.estimate);
  assert.equal(withGuess.length, 1, 'exactly one row carries the guess');
  assert.equal(withGuess[0].key, '101', 'and it is the live coding run');

  h.DevChat._clearEstimate();
  assert.ok(h.t.state().rows.every((r) => !r.progress || !r.progress.estimate),
    'clearing wipes every trace without touching a node');
});

test('the cohort hint is resolved from elapsed alone, on every tick', () => {
  const since = 1_800_000_000_000;
  const row = {
    t: 'attached', key: 'k', details: { persistId: 'p', defaultOpen: true },
    icon: 'spinner', text: 'Claude Code is running', elapsed: null, stamp: '1 2',
    progress: {
      current: '', steps: 0, phase: '', estimate: '', countdownTo: null, cohortSince: since,
    },
    body: { kind: 'log', persistId: 'q', text: '' },
  };
  setTranscriptNow(0);
  assert.match(rowHtml(row), /data-cohort-since="1800000000000"><\/span>/,
    'the span renders empty until the first tick, exactly as the template did');
  setTranscriptNow(since + 15 * 60_000);
  // The ` · ` separator moved into CSS with the chips/note split
  // (`.dc-cc-cohort:not(:empty)::before`), so the span's text is the hint
  // and nothing else — which is what makes "empty span, never a bare
  // separator" true by construction rather than by a ternary.
  assert.match(rowHtml(row), /dc-cc-cohort[^>]*>[^<]+</, 'past the gate it says something');
  setTranscriptNow(0);
});

// ── 5. What stays another module's markup ──────────────────────────────

test('three foreign builders arrive whole, through hosts that generate no box', () => {
  // Each has callers outside this transcript, so the model carries the html
  // rather than the inputs. `contents` keeps `#dc-messages`' own children the
  // direct children of the scroll container.
  for (const sink of ['visualsHtml', 'devFlowHtml']) {
    assert.match(TRANSCRIPT_TSX, new RegExp(`__html: (r|s)\\.${sink}`), `${sink} is rendered whole`);
  }
  const at = TRANSCRIPT_TSX.indexOf("case 'credits':");
  assert.match(TRANSCRIPT_TSX.slice(at, at + 200), /className="contents"/,
    "CreditOptions' card generates no box of its own");
});

test('the two foreign cards are wired after every render, not once per mount', () => {
  // `_wireCreditsCards` / `_wireDevFlowCard` scan `#dc-messages` and hand each
  // card to its module's idempotent `wire()`. A ref on a stable wrapper fires
  // once per MOUNT, which would leave a card that appears later unwired — the
  // #1304 failure. They stay three unconditional calls at the end of
  // `renderMessages`, on the line after the synchronous publish.
  const at = DEV_CHAT_SRC.indexOf('  renderMessages() {');
  const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  for (const fn of ['_wireDevFlowCard', '_bindDevFlowVisibility', '_wireCreditsCards']) {
    assert.match(body, new RegExp(`DevChat\\.${fn}\\(\\)`), `${fn} runs after every render`);
  }
  assert.doesNotMatch(TRANSCRIPT_TSX, /_wireCreditsCards\?\.\(|_wireDevFlowCard\?\.\(/,
    'and not from a ref inside the component');
});

// ── 6. The store's shape ───────────────────────────────────────────────

test('every row carries answers, not inputs', () => {
  // dev-chat.js is loaded as a classic SCRIPT by a dozen test files, so this
  // bundle cannot import from it; and Tailwind's extractor is a regex over
  // source text, so a class name that only exists in a model never compiles.
  assert.doesNotMatch(STORE_TS, /^import .* from '\.\/dev-chat/m);
  assert.doesNotMatch(TRANSCRIPT_TSX, /from '\.\/dev-chat/);
  // A tagged union, so an unknown row is a compile error rather than a blank.
  assert.match(STORE_TS, /export type TranscriptRow =/);
  for (const tag of ['status', 'spec', 'issueDraft', 'ccLog', 'attached', 'changes', 'credits', 'msg']) {
    assert.match(TRANSCRIPT_TSX, new RegExp(`case '${tag}':`), `Row renders ${tag}`);
  }
});

test('the empty transcript renders nothing at all', () => {
  assert.equal(transcriptHtml({ rows: [], devFlowHtml: '', activity: null }), '');
});

test('a row is keyed by its persisted id, so a repaint reconciles', () => {
  const h = makeDevChat();
  h.render([user('one'), ai('two')]);
  assert.deepEqual(h.t.state().rows.map((r) => r.key), ['8', '9']);
  // An unsaved optimistic row falls back to its slug, then to its index —
  // never to a value that changes between two renders of the same list.
  h.render([user('one', { id: null, _slug: 'u1' }), ai('two', { id: null, _slug: null })]);
  assert.deepEqual(h.t.state().rows.map((r) => r.key), ['u1', 'i1']);
});

test('the live bubble falls back to the model when no frame has landed', () => {
  setStream('', '');
  const row = {
    t: 'msg', key: '9', who: 'ai', model: '', stamp: '9 1',
    contentHtml: '<p>from the model</p>', live: true,
  };
  assert.match(rowHtml(row), /from the model/);
  setStream('9', '<p>from the stream</p>');
  assert.match(rowHtml(row), /from the stream/);
  setStream('other', '<p>someone else</p>');
  assert.match(rowHtml(row), /from the model/, 'a frame for another row is ignored');
  setStream('', '');
});

// ── #1942: a new session's empty state ────────────────────────────────

test('an open, idle session with no messages shows its empty state', () => {
  const h = makeDevChat();
  const html = h.render([]);
  assert.equal(h.t.state().empty, true);
  assert.match(html, /id="dc-empty-state"/);
  assert.match(html, /What should this session change\?/);
});

test('the empty state goes the moment there is a message, a run, or no session', () => {
  let h = makeDevChat();
  assert.doesNotMatch(h.render([user('hello')]), /dc-empty-state/, 'a message replaces it');
  h = makeDevChat({ isStreaming: true });
  h.render([]);
  assert.equal(h.t.state().empty, false, 'a turn in flight is not empty');
  h = makeDevChat();
  h.render([], null);
  assert.equal(h.t.state().empty, false, 'no open session, nothing to describe');
});

test('a walkthrough or a hand-off launchpad answers "what now?" instead (#1942)', () => {
  let h = makeDevChat({ _devFlowHtml: () => '<div data-flow-wizard="1"></div>' });
  h.render([]);
  assert.equal(h.t.state().empty, false, 'the walkthrough is already in the pane');
  h = makeDevChat({ _launchpadVenue: () => 'web-claude-code' });
  h.render([]);
  assert.equal(h.t.state().empty, false, 'the launchpad is already in the pane');
});

test('on a wide screen the new session’s composer comes up to meet the empty state (#1905)', () => {
  const css = read('public', 'css', 'app.css');
  const block = css.slice(css.indexOf('/* #1905:'), css.indexOf('}\n}', css.indexOf('/* #1905:')) + 3);
  assert.match(block, /@media \(min-width: 768px\)/, 'tablet width and up; a phone keeps the box by the keyboard');
  assert.match(block, /\.dc-chat-pane:has\(#dc-empty-state\) \{ justify-content: center; \}/);
  assert.match(block, /\.dc-chat-pane:has\(#dc-empty-state\) > #dc-messages \{ flex: 0 0 auto;/,
    'the message pane stops filling the column, so the pair can centre');
  assert.match(block, /\.dc-chat-pane:has\(#dc-empty-state\) > #dc-composer-bar \{[^}]*max-width: 44rem;[^}]*align-self: center;/);
  // Keyed on the empty state alone: the first message removes it, and the
  // composer goes back to the bottom with no state of its own to clear.
  assert.doesNotMatch(block, /data-|\.dc-new-session/);
});
