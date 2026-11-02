// The audit's whole network: every request the page makes is answered here,
// through the DevTools protocol's request interception, and nothing leaves
// the machine. Files come from the built `public/` directory (the same
// shell a release ships), `/api/*` from the audit's made-up world
// (./fixtures.mjs), and anything on another origin is refused.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

export const ORIGIN = 'https://homeroom.test';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function headers(contentType) {
  return [
    { name: 'Content-Type', value: contentType },
    { name: 'Cache-Control', value: 'no-store' },
  ];
}

/** The file under `root` a path names, or null. Never escapes `root`. */
function fileFor(root, pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, clean);
  if (!full.startsWith(root)) return null;
  try {
    if (existsSync(full) && statSync(full).isFile()) return full;
  } catch { /* unreadable is missing */ }
  return null;
}

/**
 * Answer every request `page` makes. `api(method, url, body)` returns
 * `{ status, json }` for an `/api/*` request; `log` collects what was asked
 * and how it was answered, so a report can show which reads the made-up
 * world does not cover.
 */
export async function serve(page, { publicDir, api, log }) {
  page.on('Fetch.requestPaused', async (event) => {
    const { requestId, request } = event;
    const respond = (status, contentType, body) => page.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: headers(contentType),
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
    let url;
    try { url = new URL(request.url); } catch { url = null; }
    if (!url || url.origin !== ORIGIN) {
      page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      let answer;
      try {
        answer = await api(request.method, url, request.postData || null);
      } catch (err) {
        answer = { status: 500, json: { error: String(err && err.message || err) } };
      }
      if (log) log.push({ method: request.method, path: url.pathname, query: url.search, status: answer.status, fixture: !!answer.fixture });
      respond(answer.status, 'application/json; charset=utf-8', JSON.stringify(answer.json ?? {}));
      return;
    }
    // No service worker: every load reads the files below, as a first visit does.
    if (url.pathname === '/sw.js') { respond(404, 'text/plain', 'no service worker in the audit'); return; }
    if (url.pathname === '/health') { respond(200, 'text/plain', 'ok'); return; }
    const file = fileFor(publicDir, url.pathname === '/' ? '/index.html' : url.pathname);
    if (file) {
      respond(200, TYPES[extname(file)] || 'application/octet-stream', readFileSync(file));
      return;
    }
    // A path with no extension is a route of the shell's own.
    if (!extname(url.pathname)) {
      respond(200, TYPES['.html'], readFileSync(join(publicDir, 'index.html')));
      return;
    }
    if (log) log.push({ method: request.method, path: url.pathname, query: '', status: 404, fixture: false, asset: true });
    respond(404, 'text/plain', 'not in public/');
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
}
