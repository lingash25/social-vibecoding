'use strict';

// Settings > Agent files: every row has a View and a Delete, so a screen
// reader heard a list of identical "View, Delete" pairs and could not tell
// which file a Delete would remove. Each button now names its file, and View
// reports aria-expanded and points aria-controls at the row's <pre>.
//
// This renders the real component (frontend/src/features/settings/agent-files-list.tsx)
// with a stubbed store. `react` is stubbed only to open a row: the first
// useState in a row is its open flag.
//
// Run with: node --test tests/agent-files-list-aria.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement, FRONTEND } = require('./lib/render-tsx');

const RealReact = require(require.resolve('react', { paths: [FRONTEND] }));
const ENTRY = 'frontend/src/features/settings/agent-files-list.tsx';

const FILES = [
  { kind: 'instruction', name: 'CLAUDE.md', description: '', kb: 1 },
  { kind: 'skill', name: 'deploy notes.md', description: 'How to deploy', kb: 2 },
];

function staticStore(state) {
  return { get: () => state, subscribe: () => () => {} };
}

function load({ open = false } = {}) {
  const stubs = {
    './agent-files-store.js': { agentFilesStore: staticStore({ phase: 'ready', files: FILES, demo: false }) },
  };
  if (open) {
    let n = 0;
    stubs.react = {
      ...RealReact,
      // Row hooks, in order: open, content, failed.
      useState(initial) {
        const i = n++ % 3;
        if (i === 0) return [true, () => {}];
        if (i === 1) return ['file body', () => {}];
        return [initial, () => {}];
      },
    };
  }
  return loadTsx(ENTRY, { stubs });
}

function render(mod, kind) {
  return renderToHtml(createElement(mod.AgentFilesList, { kind, empty: 'None yet.' }));
}

test('View and Delete name their file; View is collapsed and controls its pane', () => {
  const mod = load();
  const html = render(mod, 'instruction');
  const id = mod.agentFileContentId('instruction', 'CLAUDE.md');
  assert.match(html, new RegExp(`<button type="button" data-role="view"[^>]*aria-expanded="false" aria-controls="${id}" aria-label="View CLAUDE.md">View</button>`));
  assert.match(html, /<button type="button" data-role="delete"[^>]*aria-label="Delete CLAUDE.md">Delete<\/button>/);
  assert.doesNotMatch(html, /data-role="content"/, 'the pane is not rendered while closed');
  // Classes are unchanged: the tap-target suite counts them.
  assert.equal((html.match(/font-medium touch-target-32"/g) || []).length, 2);
});

test('an open row says Hide <file>, aria-expanded=true, and its <pre> carries the controlled id', () => {
  const mod = load({ open: true });
  const html = render(mod, 'skill');
  const id = mod.agentFileContentId('skill', 'deploy notes.md');
  assert.match(html, new RegExp(`aria-expanded="true" aria-controls="${id}" aria-label="Hide deploy notes.md">Hide</button>`));
  assert.match(html, new RegExp(`<pre id="${id}" data-role="content"[^>]*>file body</pre>`));
  assert.match(html, /aria-label="Delete deploy notes.md"/);
});

test('content ids are valid, stable and distinct for names that differ only in punctuation', () => {
  const { agentFileContentId: idOf } = load();
  const ids = [
    idOf('skill', 'a.md'), idOf('skill', 'a-md'), idOf('skill', 'a_md'), idOf('skill', 'a md'),
    idOf('instruction', 'a.md'),
  ];
  for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, id);
  assert.equal(new Set(ids).size, ids.length, ids.join(' '));
  assert.equal(idOf('skill', 'a.md'), idOf('skill', 'a.md'));
});
