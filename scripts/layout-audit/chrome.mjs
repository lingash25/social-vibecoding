// Headless Chrome over the DevTools protocol, with nothing to install: Node's
// own WebSocket and fetch, and whichever Chrome the machine has.
//
// The layout audit drives one page at a time through a fixed list of device
// shapes, so this is the smallest client that does that: launch, open a page,
// send a command and await its answer, and listen for events.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** The Chrome this machine has, or null. `CHROME_PATH` wins. */
export function findChrome() {
  return CANDIDATES.find((path) => existsSync(path)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not answer at ${url}: ${lastError ? lastError.message : 'timed out'}`);
}

/**
 * One page's protocol connection. `send` resolves with the command's result
 * or rejects with its error; `on` subscribes to an event by name.
 */
class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluate an expression in the page and return its value (awaited). */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const text = exceptionDetails.exception?.description || exceptionDetails.text;
      throw new Error(`page threw: ${text}`);
    }
    return result.value;
  }
}

/**
 * Launch a headless Chrome and open one page. `args` are extra switches.
 * Returns { page, close }.
 */
export async function launch({ chromePath = findChrome(), args = [] } = {}) {
  if (!chromePath) {
    throw new Error('No Chrome found. Install Google Chrome or set CHROME_PATH to a Chrome or Chromium binary.');
  }
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'layout-audit-'));
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    '--mute-audio',
    ...args,
    'about:blank',
  ], { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  await waitForJson(`http://127.0.0.1:${port}/json/version`, deadline);
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, deadline);
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('Chrome opened no page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not connect to the page')), { once: true });
  });
  const page = new Session(ws);
  const close = () => {
    try { ws.close(); } catch { /* already closed */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { page, close };
}
