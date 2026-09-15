const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const row = id => ({
  id, row_type: 'pr', pr_number: id, pr_title: `Change ${id}`,
  created_at: new Date(Date.UTC(2026, 8, 14) + id * 1000).toISOString(),
});
const key = item => `${item.row_type || 'pr'}:${item.id}`;
const compare = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  || (b.row_type === 'close_issue' ? 0 : 1) - (a.row_type === 'close_issue' ? 0 : 1)
  || b.id - a.id;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function fixture(rows = Array.from({ length: 100 }, (_, i) => row(i + 1))) {
  const state = { rows, calls: [], beforeResponse: null, repaints: 0, errors: [] };
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    App: { user: { id: 3 }, currentApp: 'demo', currentTab: 'dev', currentSubTab: 'forum' },
    location: { search: '', hash: '' }, localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    document: { getElementById: () => ({ set innerHTML(value) { state.errors.push(value); } }) },
    fetch: async address => {
      const url = new URL(address, 'https://example.test');
      state.calls.push(url);
      let data = {};
      if (url.pathname.endsWith('/merged')) {
        const sorted = state.rows.slice().sort(compare);
        const q = url.searchParams;
        const cursor = q.has('before') ? { created_at: q.get('before'), id: Number(q.get('before_id')), row_type: q.get('before_type') } : null;
        const remaining = cursor ? sorted.filter(r => compare(r, cursor) > 0) : sorted;
        const limit = Number(q.get('limit')) || 20;
        data = { merged: remaining.slice(0, limit), hasMore: remaining.length > limit, total: sorted.length };
      }
      // Freeze the response before waiting, to model an older in-flight snapshot.
      data = plain(data);
      const override = state.beforeResponse && await state.beforeResponse(url, data);
      return override || { ok: true, json: async () => data };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.subject = AppView;`, sandbox);
  const av = sandbox.subject;
  av.appData = { slug: 'demo' };
  av._repaintDevBody = () => { state.repaints += 1; };
  av._renderLockedNotice = () => {};
  av._loadWorkshopThemes = () => {};
  av._syncChecksPoll = () => {};
  const load = async () => { assert.equal(await av._loadDevData(), true); };
  const expand = async () => { await load(); av.showAllDone(); await av.loadMoreMerged(); await av.loadMoreMerged(); };
  return { av, state, sandbox, load, expand };
}

test('live refresh preserves three loaded pages, updates rows and continues after the old boundary', async () => {
  const { av, state, expand, load } = fixture();
  await expand();
  assert.equal(av._merged.length, 60);
  const boundary = plain(av._mergedCursor);
  const oldKeys = av._merged.map(key);
  av._kanbanFilters = { q: 'Change', assignee: 'viewer' };
  av._kanbanTab = 'done';
  state.rows.push(row(101));
  state.rows.find(r => r.id === 55).pr_title = 'Updated completed title';
  await load();
  assert.equal(av._merged.length, 61);
  for (const id of oldKeys) assert.ok(av._merged.some(r => key(r) === id));
  assert.equal(av._merged[0].id, 101);
  assert.equal(av._merged.find(r => r.id === 55).pr_title, 'Updated completed title');
  assert.equal(av.voteState.bySession['55'].pr_title, 'Updated completed title');
  assert.deepEqual(plain(av._mergedCursor), boundary);
  assert.equal(av._mergedTotal, 101);
  assert.equal(av._doneShowAll, true);
  assert.deepEqual(plain(av._kanbanFilters), { q: 'Change', assignee: 'viewer' });
  assert.equal(av._kanbanTab, 'done');
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 81);
  assert.equal(new Set(av._merged.map(key)).size, 81);
  assert.equal(av._mergedCursor.id, 21);
});

test('refresh removes stale rows, tolerates a removed boundary and keeps a working cursor', async () => {
  const { av, state, expand, load } = fixture();
  await expand();
  state.rows = state.rows.filter(r => r.id !== 41 && r.id !== 70);
  await load();
  assert.equal(av._merged.length, 58);
  assert.equal(av._mergedCursor.id, 42);
  assert.equal(av.voteState.bySession['70'], undefined);
  assert.equal(av._mergedTotal, 98);
  await av.loadMoreMerged();
  assert.equal(av._mergedCursor.id, 21);
  await av.loadMoreMerged();
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 98);
  assert.equal(av._mergedHasMore, false);
  await load();
  assert.equal(av._merged.length, 98);
  assert.equal(av._mergedHasMore, false);
});

test('Show all alone preserves the revealed boundary; an unexpanded first load stays one page', async () => {
  const { av, state, load } = fixture();
  await load();
  state.rows.push(row(101));
  await load();
  assert.equal(av._merged.length, 20);
  av.showAllDone();
  const oldest = av._mergedCursor.id;
  state.rows.push(row(102));
  await load();
  assert.equal(av._merged.length, 21);
  assert.equal(av._mergedCursor.id, oldest);
});

test('older history stays reachable if every previously loaded card is removed', async () => {
  const { av, state, expand, load } = fixture();
  await expand();
  state.rows = state.rows.filter(r => r.id < 41);
  await load();
  assert.equal(av._merged.length, 0);
  assert.equal(av._mergedHasMore, true);
  assert.equal(av._mergedCursor.id, 41);
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 20);
  assert.equal(av._merged[0].id, 40);
  assert.equal(av._mergedCursor.id, 21);
});

test('mixed PR and closed-issue ids sharing timestamps remain distinct across refresh and paging', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => ['pr', 'close_issue'].map(type => ({
    ...row(i + 1), row_type: type, created_at: '2026-09-14T00:00:00.000Z',
  }))).flat();
  const { av, state, expand, load } = fixture(rows);
  await expand();
  const boundary = plain(av._mergedCursor);
  state.rows.push({ ...row(36), created_at: rows[0].created_at });
  await load();
  assert.equal(av._merged.length, 61);
  assert.deepEqual(plain(av._mergedCursor), boundary);
  assert.ok(av._merged.some(r => r.row_type === 'close_issue' && r.id === 35));
  assert.ok(av._merged.some(r => r.row_type === 'pr' && r.id === 35));
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 71);
  assert.equal(new Set(av._merged.map(key)).size, 71);
  assert.equal(av._mergedHasMore, false);
});

test('a refresh queued during Load more keeps the newly loaded page', async () => {
  const { av, state, load } = fixture();
  await load();
  const started = deferred(), finish = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && url.searchParams.has('before')) {
      state.beforeResponse = null;
      started.resolve(); await finish.promise;
    }
  };
  const more = av.loadMoreMerged();
  await started.promise;
  const before = state.calls.length;
  state.rows.push(row(101));
  const refresh = av._loadDevData();
  assert.equal(state.calls.length, before, 'refresh waits for the page establishing its boundary');
  finish.resolve();
  await more;
  assert.equal(await refresh, true);
  assert.equal(av._merged.length, 41);
  assert.equal(av._mergedCursor.id, 61);
  assert.equal(av._merged[0].id, 101);
});

test('Load more queued during refresh continues from the refreshed oldest row', async () => {
  const { av, state, expand } = fixture();
  await expand();
  state.rows.push(row(101));
  const started = deferred(), finish = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged') && !url.searchParams.has('before')) {
      state.beforeResponse = null; started.resolve(); await finish.promise;
    }
  };
  const refresh = av._loadDevData();
  await started.promise;
  const more = av.loadMoreMerged();
  assert.equal(av._mergedLoadingMore, true);
  finish.resolve();
  await refresh; await more;
  assert.equal(av._merged.length, 81);
  assert.equal(av._mergedCursor.id, 21);
  assert.equal(av._mergedLoadingMore, false);
});

test('failed refresh keeps rows, cursor and rendered content, then retries successfully', async () => {
  const { av, state, expand, load } = fixture();
  await expand();
  const saved = plain({ rows: av._merged, cursor: av._mergedCursor, total: av._mergedTotal });
  state.rows.push(row(101));
  state.beforeResponse = async url => url.pathname.endsWith('/merged') && url.searchParams.has('before')
    ? { ok: false } : null;
  await av._loadDevFeed();
  assert.deepEqual(plain({ rows: av._merged, cursor: av._mergedCursor, total: av._mergedTotal }), saved);
  assert.equal(av._mergedHasMore, true);
  assert.deepEqual(state.errors, [], 'the visible board is not replaced by an error or empty list');
  state.beforeResponse = null;
  await load();
  assert.equal(av._merged.length, 61);
});

test('HTTP and network pagination failures do not turn off Load more or poison the queue', async () => {
  const { av, state, load } = fixture();
  await load();
  const cursor = plain(av._mergedCursor);
  for (const fail of [async () => ({ ok: false }), async () => { throw new Error('offline'); }]) {
    state.beforeResponse = fail;
    await av.loadMoreMerged();
    assert.equal(av._merged.length, 20);
    assert.deepEqual(plain(av._mergedCursor), cursor);
    assert.equal(av._mergedHasMore, true);
    assert.equal(av._mergedLoadingMore, false);
  }
  state.beforeResponse = null;
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 40);
});

test('app/visit reset invalidates a pending page even after returning to the same slug', async () => {
  const { av, state, expand, load } = fixture();
  await expand();
  const started = deferred(), finish = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged')) {
      state.beforeResponse = null; started.resolve(); await finish.promise;
    }
  };
  const old = av.loadMoreMerged();
  await started.promise;
  av._resetMergedPagination();
  av.appData = { slug: 'other' };
  await load();
  av._resetMergedPagination();
  av.appData = { slug: 'demo' };
  await load();
  assert.equal(av._merged.length, 20);
  assert.equal(av._doneShowAll, false);
  const paints = state.repaints;
  finish.resolve(); await old;
  assert.equal(av._merged.length, 20);
  assert.equal(state.repaints, paints, 'an old page cannot repaint a new visit');
});

test('late full refresh cannot replace another app’s data', async () => {
  const { av, state, load } = fixture();
  const started = deferred(), finish = deferred();
  state.beforeResponse = async url => {
    if (url.pathname.endsWith('/merged')) {
      state.beforeResponse = null; started.resolve(); await finish.promise;
    }
  };
  const old = av._loadDevData();
  await started.promise;
  av._resetMergedPagination();
  av.appData = { slug: 'other' };
  state.rows = [row(500)];
  await load();
  finish.resolve();
  assert.equal(await old, null);
  assert.deepEqual(plain(av._merged.map(r => r.id)), [500]);
});

test('a delayed category response from a previous visit cannot overwrite the new app vocabulary', async () => {
  const { av, state, load } = fixture();
  const started = deferred(), finish = deferred();
  state.beforeResponse = async url => {
    if (url.pathname === '/api/apps/demo/topic-categories') {
      started.resolve(); await finish.promise;
      return { ok: true, json: async () => ({ categories: [{ value: 'old' }] }) };
    }
    if (url.pathname === '/api/apps/other/topic-categories') {
      return { ok: true, json: async () => ({ categories: [{ value: 'new' }] }) };
    }
  };
  const old = av._loadDevData();
  await started.promise;
  av._resetMergedPagination();
  av.appData = { slug: 'other' };
  await load();
  finish.resolve();
  assert.equal(await old, null);
  assert.deepEqual(plain(av._appCategories), [{ value: 'new' }]);
});

test('a nonadvancing page stays retryable instead of discarding the loaded history', async () => {
  const { av, state, load } = fixture();
  await load();
  const saved = plain(av._merged);
  state.beforeResponse = async () => ({ ok: true, json: async () => ({ merged: saved, hasMore: true }) });
  await av.loadMoreMerged();
  assert.deepEqual(plain(av._merged), saved);
  assert.equal(av._mergedHasMore, true);
  assert.equal(av._mergedLoadingMore, false);
  state.beforeResponse = null;
  await av.loadMoreMerged();
  assert.equal(av._merged.length, 40);
});

test('data publications anchor the visible card for both element and document scrolling', () => {
  for (const pageScroll of [false, true]) {
    const { av, sandbox } = fixture();
    let cardTop = 120;
    const card = { isConnected: true, getBoundingClientRect: () => ({ top: cardTop, bottom: cardTop + 100, width: 300 }) };
    const scroller = {
      isConnected: true, scrollTop: 900,
      getBoundingClientRect: () => ({ top: 50, bottom: 700 }),
      scrollTo({ top }) { this.scrollTop = top; },
    };
    const done = { querySelectorAll: () => [card] };
    sandbox.document.getElementById = id => id === 'dev-forum-scroll' ? scroller : id === 'dev-kanban-col-done' ? done : null;
    sandbox.document.scrollingElement = pageScroll ? scroller : {};
    sandbox.innerHeight = 700;
    av._repaintDevBody = () => { cardTop += 110; };
    av._repaintDevBodyKeepingPosition();
    assert.equal(scroller.scrollTop, 1010, 'compensates for the inserted card’s height');
    scroller.scrollTop = 0;
    av._repaintDevBodyKeepingPosition();
    assert.equal(scroller.scrollTop, 0, 'new cards can appear normally when already at the top');
    scroller.scrollTop = 900;
    av._repaintDevBody = () => { card.isConnected = false; };
    av._repaintDevBodyKeepingPosition();
    assert.equal(scroller.scrollTop, 900, 'removing the anchor falls back to ordinary scrolling');
  }
});
