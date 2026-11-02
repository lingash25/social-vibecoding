// The audit's report: report.json for tools, and index.html for people, with
// every screen at every shape side by side and each rule it broke drawn on
// its screenshot. Returns a short text summary for the terminal.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function overlay(rect, profile, cls, label) {
  const pct = (n, of) => `${(n / of * 100).toFixed(2)}%`;
  return `<div class="box ${cls}" style="left:${pct(rect.x, profile.width)};top:${pct(rect.y, profile.height)};width:${pct(rect.w, profile.width)};height:${pct(rect.h, profile.height)}">${label ? `<span>${esc(label)}</span>` : ''}</div>`;
}

function shot(src, profile, violations, title) {
  const zones = (profile.system || []).map((z) => overlay(z, profile, 'zone', '')).join('');
  const marks = violations.filter((v) => v.rect).map((v) => overlay(v.rect, profile, v.severity, String(v.n))).join('');
  return `<figure><div class="frame" style="aspect-ratio:${profile.width}/${profile.height}"><img loading="lazy" src="${esc(src)}" alt="${esc(title)}">${zones}${marks}</div><figcaption>${esc(title)}</figcaption></figure>`;
}

export function writeReport(outDir, { results, profiles, screens, base }) {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ base: base || null, profiles, screens, results }, null, 2));

  const byRule = new Map();
  for (const r of results) for (const v of r.violations) {
    const key = `${v.severity} ${v.rule}`;
    byRule.set(key, (byRule.get(key) || 0) + 1);
  }
  const missing = new Map();
  for (const r of results) for (const m of r.missingReads) missing.set(m, (missing.get(m) || 0) + 1);

  const cards = screens.map((screen) => {
    const row = profiles.map((profile) => {
      const r = results.find((x) => x.profile === profile.id && x.screen === screen.id);
      if (!r) return '';
      r.violations.forEach((v, i) => { v.n = i + 1; });
      const rest = r.violations.filter((v) => v.state === 'rest');
      const up = r.violations.filter((v) => v.state === 'keyboard');
      const errs = r.violations.filter((v) => v.severity === 'error').length;
      const warns = r.violations.length - errs;
      const list = r.violations.map((v) => `<li class="${v.severity}"><b>${v.n}</b> <code>${esc(v.rule)}</code>${v.state === 'keyboard' ? ' <em>keys up</em>' : ''} ${esc(v.message)}</li>`).join('');
      return `<article class="card"><header><h3>${esc(profile.label)}</h3><span class="count ${errs ? 'bad' : warns ? 'meh' : 'ok'}">${errs ? `${errs} error${errs > 1 ? 's' : ''}` : ''}${errs && warns ? ', ' : ''}${warns ? `${warns} warning${warns > 1 ? 's' : ''}` : ''}${!errs && !warns ? 'clean' : ''}</span></header>
<div class="shots">${shot(r.shots.rest, profile, rest, 'At rest')}${r.shots.keyboard ? shot(r.shots.keyboard, profile, up, 'Keyboard up') : ''}</div>
${list ? `<ol class="found">${list}</ol>` : ''}
${r.missingReads.length ? `<p class="note">Reads the made-up world does not answer: ${r.missingReads.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` : ''}
${r.pageErrors.length ? `<p class="note">Page errors: ${r.pageErrors.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` : ''}</article>`;
    }).join('');
    return `<section><h2>${esc(screen.id)} <code>${esc(screen.route)}</code></h2><div class="row">${row}</div></section>`;
  }).join('');

  const ruleRows = [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const [severity, rule] = k.split(' ');
    return `<tr><td class="${severity}">${severity}</td><td><code>${esc(rule)}</code></td><td>${n}</td></tr>`;
  }).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Layout audit</title>
<style>
:root { --bg:#fafaf7; --fg:#18181b; --muted:#68686c; --card:#fff; --line:#e4e4e7; --err:#d92d20; --warn:#c77700; --ok:#1a7f37; --zone:rgba(217,45,32,.12); }
@media (prefers-color-scheme: dark) { :root { --bg:#111113; --fg:#ececef; --muted:#a1a1aa; --card:#1c1c1f; --line:#2e2e33; --zone:rgba(255,90,80,.16); } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, system-ui, sans-serif; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 12px; } h2 code { color: var(--muted); font-weight: 400; }
p.lead { color: var(--muted); margin: 0 0 16px; max-width: 70ch; }
table { border-collapse: collapse; margin: 8px 0 16px; } td { padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); }
td.error, li.error b { color: var(--err); } td.warn, li.warn b { color: var(--warn); }
.row { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 8px; align-items: flex-start; }
.card { flex: 0 0 auto; width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px; }
.card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.card h3 { font-size: 14px; margin: 0 0 8px; }
.count { font-size: 12px; font-weight: 600; } .count.bad { color: var(--err); } .count.meh { color: var(--warn); } .count.ok { color: var(--ok); }
.shots { display: flex; gap: 8px; } figure { margin: 0; flex: 1 1 0; min-width: 0; }
figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
.frame { position: relative; width: 100%; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #ddd; }
.frame img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.box { position: absolute; pointer-events: none; }
.box.zone { background: var(--zone); }
.box.error { outline: 2px solid var(--err); } .box.warn { outline: 2px dashed var(--warn); }
.box span { position: absolute; top: -1px; left: -1px; background: var(--err); color: #fff; font: 600 10px/1 system-ui; padding: 2px 4px; border-radius: 0 0 4px 0; }
.box.warn span { background: var(--warn); }
ol.found { margin: 10px 0 0; padding: 0; list-style: none; font-size: 13px; }
ol.found li { padding: 4px 0; border-top: 1px solid var(--line); }
ol.found em { font-style: normal; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.note { font-size: 12px; color: var(--muted); margin: 8px 0 0; word-break: break-word; }
code { font-size: 12px; }
</style></head><body>
<h1>Layout audit</h1>
<p class="lead">The shell at ${profiles.length} screen shapes on ${screens.length} screens${base ? `, against ${esc(base)}` : ', with made-up data'}. Shaded areas are where the device draws its own controls. Outlined boxes are what broke a rule, numbered as in the list under each pair of shots.</p>
<table><tbody>${ruleRows || '<tr><td>Nothing broke a rule.</td></tr>'}</tbody></table>
${missing.size ? `<p class="lead">Reads the made-up world does not answer yet (screens may be emptier than real): ${[...missing.keys()].map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` : ''}
${cards}
</body></html>`;
  writeFileSync(join(outDir, 'index.html'), html);

  const lines = [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`);
  return lines.length ? `Rules broken:\n${lines.join('\n')}` : 'Nothing broke a rule.';
}
