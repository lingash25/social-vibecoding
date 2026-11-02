#!/usr/bin/env node
// THE LAYOUT AUDIT: the platform shell at every screen shape, checked by rule.
//
// Most of the shell's layout bugs reached people on one shape the author did
// not look at: the iPhone Duo's column and band, a phone held sideways, an
// iPad with the keyboard up. And the unit suite checks source text, not what
// is on screen. This lays the built shell out in headless Chrome at each
// shape in ./profiles.mjs, on each screen in ./fixtures.mjs SCREENS, at rest
// and with the keyboard up, and checks the rules in ./rules.mjs, which hold
// everywhere: nothing runs off the screen or sits under the system's clock,
// the keyboard moves nothing sideways, a chat meets its reply box.
//
// No services: the page's whole network is answered by ./serve.mjs from the
// built `public/` and a made-up world (./fixtures.mjs). Or, with --base, it
// runs against a running stack, signed in with a saved session.
//
//   npm run ensure:shell            # build public/ first
//   npm run audit:layout            # every shape, every screen
//   npm run audit:layout -- --profiles duo-sideways,ipad --screens homeroom-bot
//   npm run audit:layout -- --base http://localhost:3000 --auth auth.json
//   node scripts/layout-audit/compare.mjs before/report.json after/report.json
//
// It writes report.json and index.html (the screens side by side, each rule
// it broke drawn on its screenshot) to --out (default layout-audit-report/),
// and prints a summary. Advisory: it exits 0 unless --strict is given and an
// error-level rule broke.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from './chrome.mjs';
import { COLLECT_EXPRESSION } from './collect.mjs';
import { answer, SCREENS } from './fixtures.mjs';
import { PROFILES } from './profiles.mjs';
import { writeReport } from './report.mjs';
import { checkKeyboard, checkSnapshot } from './rules.mjs';
import { ORIGIN, serve } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

function parseArgs(argv) {
  const args = { out: 'layout-audit-report', profiles: null, screens: null, base: null, auth: null, strict: false, publicDir: join(REPO, 'public') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--profiles') args.profiles = next().split(',');
    else if (a === '--screens') args.screens = next().split(',');
    else if (a === '--base') args.base = next().replace(/\/$/, '');
    else if (a === '--auth') args.auth = next();
    else if (a === '--public') args.publicDir = resolve(next());
    else if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the page has asked for nothing new for `quiet` ms. */
async function settle(activity, { min = 1500, quiet = 700, max = 9000 } = {}) {
  const start = Date.now();
  await sleep(min);
  while (Date.now() - start < max) {
    if (Date.now() - activity.last >= quiet) return;
    await sleep(100);
  }
}

async function shoot(page, file) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

// Focus the reply box of the chat on screen (the last one, which is the
// open conversation beside a list), as a tap on it would.
// A reply box in a same-origin frame (the side panel) counts: the kit treats
// focus in a frame as the keyboard possibly up, as iOS does.
const FOCUS_COMPOSER = `(() => {
  const SEL = '.messages-composer-card textarea, .gc-composer-card textarea, .messages-composer-card [contenteditable="true"]';
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument && frame.getBoundingClientRect().width > 0) docs.push(frame.contentDocument); } catch { /* another origin */ }
  }
  const fields = docs.flatMap((doc) => [...doc.querySelectorAll(SEL)])
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const field = fields[fields.length - 1];
  if (!field) return false;
  field.focus();
  return field.ownerDocument.activeElement === field;
})()`;

async function auditProfile(profile, screens, args, outDir) {
  const { page, close } = await launch();
  const results = [];
  const activity = { last: Date.now() };
  const log = [];
  let errors = [];
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception?.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 200)));
    page.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') errors.push(e.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0].slice(0, 200));
    });
    page.on('Fetch.requestPaused', () => { activity.last = Date.now(); });
    page.on('Network.requestWillBeSent', () => { activity.last = Date.now(); });
    if (args.base) {
      await page.send('Network.enable');
      if (args.auth) {
        const state = JSON.parse(readFileSync(args.auth, 'utf8'));
        if (Array.isArray(state.cookies) && state.cookies.length) await page.send('Network.setCookies', { cookies: state.cookies });
      }
    } else {
      await serve(page, { publicDir: args.publicDir, api: async (method, url) => answer(method, url), log });
    }
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(HERE, 'page-setup.js'), 'utf8') });
    await page.send('Emulation.setDeviceMetricsOverride', { width: profile.width, height: profile.height, deviceScaleFactor: 2, mobile: !!profile.touch });
    await page.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'light' },
    ] });
    await page.send('Emulation.setSafeAreaInsetsOverride', { insets: profile.insets });
    if (profile.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (profile.userAgent) await page.send('Emulation.setUserAgentOverride', { userAgent: profile.userAgent });

    const origin = args.base || ORIGIN;
    // The Homeroom app's web view and the iOS skin, which a headless browser
    // cannot be detected as: the shell's and the kit's own overrides.
    const query = profile.native ? '?un-native-webview=1&un-platform=ios' : '';
    for (const screen of screens) {
      errors = [];
      const before = log.length;
      // Each screen from a cold start. Only the part after `#` differs between
      // screens, which the browser would take as a move within the page: the
      // last screen's state (an open column, a remembered tab) carried over.
      await page.send('Page.navigate', { url: 'about:blank' });
      await sleep(100);
      await page.send('Storage.clearDataForOrigin', { origin, storageTypes: args.base ? 'local_storage,session_storage,indexeddb,cache_storage,service_workers' : 'all' });
      activity.last = Date.now();
      await page.send('Page.navigate', { url: `${origin}/${query}${screen.route}` });
      await settle(activity);
      const shotRest = `shots/${profile.id}--${screen.id}.jpg`;
      const rest = await page.evaluate(COLLECT_EXPRESSION);
      await shoot(page, join(outDir, shotRest));
      const found = checkSnapshot(rest, profile).map((v) => ({ ...v, state: 'rest' }));
      let up = null;
      let shotUp = null;
      if (profile.keyboard && screen.composer && await page.evaluate(FOCUS_COMPOSER)) {
        await sleep(150);
        await page.evaluate(`window.__layoutAudit.keyboard(${profile.keyboard})`);
        await sleep(700);
        up = await page.evaluate(COLLECT_EXPRESSION);
        shotUp = `shots/${profile.id}--${screen.id}--keyboard.jpg`;
        await shoot(page, join(outDir, shotUp));
        found.push(...checkSnapshot(up, { ...profile, system: (profile.system || []).filter((z) => z.name !== 'home indicator') }).map((v) => ({ ...v, state: 'keyboard' })));
        found.push(...checkKeyboard(rest, up, profile).map((v) => ({ ...v, state: 'keyboard' })));
        await page.evaluate('window.__layoutAudit.keyboard(0); document.activeElement && document.activeElement.blur(); true');
      }
      const missing = [...new Set(log.slice(before).filter((l) => !l.fixture && !l.asset).map((l) => `${l.method} ${l.path}`))];
      results.push({
        profile: profile.id,
        screen: screen.id,
        route: screen.route,
        shots: { rest: shotRest, keyboard: shotUp },
        facts: rest.facts,
        violations: found,
        missingReads: missing,
        pageErrors: [...new Set(errors)].slice(0, 10),
        // The measurements themselves, for ./compare.mjs to set two runs side by side.
        snapshots: { rest, keyboard: up },
      });
      process.stdout.write(`  ${profile.id.padEnd(15)} ${screen.id.padEnd(16)} ${found.filter((v) => v.severity === 'error').length} errors, ${found.filter((v) => v.severity === 'warn').length} warnings\n`);
    }
  } finally {
    close();
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n');
    return;
  }
  if (!args.base && !existsSync(join(args.publicDir, 'index.html'))) {
    throw new Error(`No built shell at ${args.publicDir}/index.html. Run \`npm run ensure:shell\` first.`);
  }
  const profiles = args.profiles ? PROFILES.filter((p) => args.profiles.includes(p.id)) : PROFILES;
  const screens = args.screens ? SCREENS.filter((s) => args.screens.includes(s.id)) : SCREENS;
  if (!profiles.length || !screens.length) throw new Error('No profiles or screens match.');
  const outDir = resolve(args.out);
  mkdirSync(join(outDir, 'shots'), { recursive: true });
  process.stdout.write(`Layout audit: ${profiles.length} shapes x ${screens.length} screens${args.base ? ` against ${args.base}` : ', made-up data'}\n`);
  const results = [];
  for (const profile of profiles) results.push(...await auditProfile(profile, screens, args, outDir));
  const summary = writeReport(outDir, { results, profiles, screens, base: args.base });
  process.stdout.write(`\n${summary}\nReport: ${join(outDir, 'index.html')}\n`);
  const errors = results.reduce((n, r) => n + r.violations.filter((v) => v.severity === 'error').length, 0);
  if (args.strict && errors) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 2;
});
