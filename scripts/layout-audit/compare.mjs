#!/usr/bin/env node
// Two layout audit runs side by side: what moved between them. For a change
// meant to leave the layout alone (a refactor), the answer should be nothing;
// for one meant to move something, it should be that and nothing else.
//
//   node scripts/layout-audit/compare.mjs before/report.json after/report.json
//
// Compares, screen by screen and shape by shape, the page's large parts
// (by their stable names), each chat's transcript and reply box, and the
// controls a finger can reach (matched by what they say), at rest and with
// the keyboard up; and the rules each run broke. Exits 1 when anything moved.

import { readFileSync } from 'node:fs';

export const MOVE_TOL = 1;

const rectDelta = (a, b) => Math.max(
  Math.abs(a.x - b.x), Math.abs(a.y - b.y),
  Math.abs(a.x + a.w - (b.x + b.w)), Math.abs(a.y + a.h - (b.y + b.h)),
);
const fmt = (r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`;

/** What differs between two snapshots of one screen at one shape. */
export function compareSnapshots(a, b) {
  const out = [];
  if (!a || !b) return a || b ? [`only ${a ? 'before' : 'after'} has this state`] : [];
  const before = new Map(a.landmarks.map((l) => [l.key, l]));
  const after = new Map(b.landmarks.map((l) => [l.key, l]));
  for (const [key, l] of before) {
    const m = after.get(key);
    if (!m) out.push(`${key} gone (was ${fmt(l.rect)})`);
    else if (rectDelta(l.rect, m.rect) > MOVE_TOL) out.push(`${key} ${fmt(l.rect)} -> ${fmt(m.rect)}`);
  }
  for (const [key, m] of after) if (!before.has(key)) out.push(`${key} new at ${fmt(m.rect)}`);
  a.chats.forEach((c, i) => {
    const d = b.chats[i];
    if (!d) { out.push(`chat ${i + 1} gone`); return; }
    if (rectDelta(c.scrollerRect, d.scrollerRect) > MOVE_TOL) out.push(`chat ${i + 1} transcript ${fmt(c.scrollerRect)} -> ${fmt(d.scrollerRect)}`);
    if (rectDelta(c.cardRect, d.cardRect) > MOVE_TOL) out.push(`chat ${i + 1} reply box ${fmt(c.cardRect)} -> ${fmt(d.cardRect)}`);
  });
  if (b.chats.length > a.chats.length) out.push(`${b.chats.length - a.chats.length} more chat(s)`);
  // Controls, matched by what they say; several with the same words pair up
  // in order.
  const group = (list) => {
    const g = new Map();
    for (const t of list.filter((x) => x.reachable)) g.set(t.desc, [...(g.get(t.desc) || []), t]);
    return g;
  };
  const ta = group(a.targets);
  const tb = group(b.targets);
  for (const [desc, list] of ta) {
    const other = tb.get(desc) || [];
    list.forEach((t, i) => {
      const u = other[i];
      if (!u) out.push(`control gone: ${desc}`);
      else if (rectDelta(t.rect, u.rect) > MOVE_TOL) out.push(`control moved: ${desc} ${fmt(t.rect)} -> ${fmt(u.rect)}`);
    });
  }
  for (const [desc, list] of tb) {
    const had = (ta.get(desc) || []).length;
    for (const t of list.slice(had)) out.push(`control new: ${desc} at ${fmt(t.rect)}`);
  }
  return out;
}

function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    process.stderr.write('usage: compare.mjs before/report.json after/report.json\n');
    process.exitCode = 2;
    return;
  }
  const A = JSON.parse(readFileSync(fileA, 'utf8'));
  const B = JSON.parse(readFileSync(fileB, 'utf8'));
  let moved = 0;
  for (const ra of A.results) {
    const rb = B.results.find((x) => x.profile === ra.profile && x.screen === ra.screen);
    if (!rb) continue;
    const lines = [];
    for (const state of ['rest', 'keyboard']) {
      for (const d of compareSnapshots(ra.snapshots?.[state], rb.snapshots?.[state])) lines.push(`${state === 'keyboard' ? '[keys up] ' : ''}${d}`);
    }
    const rules = (r) => new Set(r.violations.map((v) => `${v.state} ${v.rule}: ${v.message}`));
    const va = rules(ra);
    const vb = rules(rb);
    for (const v of vb) if (!va.has(v)) lines.push(`newly broken: ${v}`);
    for (const v of va) if (!vb.has(v)) lines.push(`no longer broken: ${v}`);
    if (lines.length) {
      moved += lines.length;
      process.stdout.write(`\n${ra.profile} / ${ra.screen}\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
    }
  }
  process.stdout.write(moved ? `\n${moved} difference(s).\n` : 'No differences.\n');
  if (moved) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
