// The rules a layout has to keep on every screen shape. Each takes the plain
// snapshots ./collect.mjs returns (and the shape, ./profiles.mjs) and returns
// what broke, as `{ rule, severity, message, rect? }`. Nothing here touches
// a browser, so tests/layout-audit-rules.test.js drives every rule with
// made-up snapshots.
//
// Each rule is here because it would have caught a bug that shipped:
//
//   page-overflow          the page scrolls sideways
//   target-past-edge       a control runs off the side of the screen
//   target-under-system    a control under the clock, the camera or the home
//                          indicator (the Duo's top band cleared 84px of a
//                          130px clock pill, 1 Nov 2026)
//   content-under-system   fixed text or an icon under the clock, the camera
//                          or the island, where it cannot be read
//   small-target           a control smaller than a fingertip, on touch
//   keyboard-shift         raising the keyboard moves the page sideways (the
//                          sidebar vanished and the page slid 212px left on
//                          the Duo and iPad, PR 6087)
//   reply-box-covered      the reply box being typed in is behind the keys
//   transcript-gap         a chat stops short of its reply box (24px of bare
//                          page, PR 6087)
//   head-spans-column      a column's header is not as wide as its column

const TOL = 1.5;

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;


/** WCAG 2.5.8's floor for a pointer target, in CSS px. */
export const MIN_TARGET = 24;

/** Everything one snapshot breaks on its own. */
export function checkSnapshot(snap, profile) {
  const out = [];
  const { w } = snap.viewport;

  if (snap.viewport.scrollW > w + TOL) {
    out.push({ rule: 'page-overflow', severity: 'error', message: `The page is ${snap.viewport.scrollW - w}px wider than the screen and scrolls sideways.` });
  }

  for (const t of snap.targets) {
    if (!t.reachable) continue;
    if (!t.clipped && (t.rect.x < -TOL || right(t.rect) > w + TOL)) {
      const past = t.rect.x < -TOL ? -t.rect.x : right(t.rect) - w;
      out.push({ rule: 'target-past-edge', severity: 'error', message: `${t.desc} runs ${Math.round(past)}px off the ${t.rect.x < -TOL ? 'left' : 'right'} of the screen.`, rect: t.rect });
    }
    // Content in a scroller passes under the edges and scrolls back out; a
    // fixed control has to clear them.
    // Judged where a finger aims, the control's middle: a column-long handle
    // whose foot reaches the home indicator is not a control placed there,
    // and a border that brushes the clock is not one under it.
    const cx = t.rect.x + t.rect.w / 2;
    const cy = t.rect.y + t.rect.h / 2;
    for (const zone of t.scrolls ? [] : profile.system || []) {
      if (cx >= zone.x && cx <= right(zone) && cy >= zone.y && cy <= bottom(zone)) {
        out.push({ rule: 'target-under-system', severity: zone.severity, message: `${t.desc} is under the ${zone.name}.`, rect: t.rect });
      }
    }
    // Sized by what a finger can hit, which may be larger than what is drawn.
    const hit = t.hit || t.rect;
    if (profile.touch && !t.inline && (hit.w < MIN_TARGET - 0.5 || hit.h < MIN_TARGET - 0.5)) {
      out.push({ rule: 'small-target', severity: 'warn', message: `${t.desc} is ${Math.round(hit.w)}x${Math.round(hit.h)}px, under ${MIN_TARGET}x${MIN_TARGET} for a finger.`, rect: t.rect });
    }
  }

  // Where a control is aimed is judged above; what is drawn is judged here,
  // so a wide row whose label starts under the island is caught though its
  // middle is clear. Once per mark and zone; scrolling content is left out.
  for (const m of snap.marks || []) {
    for (const zone of (profile.system || []).filter((z) => z.severity === 'error')) {
      const ow = Math.min(right(m.rect), right(zone)) - Math.max(m.rect.x, zone.x);
      const oh = Math.min(bottom(m.rect), bottom(zone)) - Math.max(m.rect.y, zone.y);
      if (ow >= 6 && oh >= 6) {
        out.push({ rule: 'content-under-system', severity: 'warn', message: `${m.desc} is drawn under the ${zone.name}.`, rect: m.rect });
      }
    }
  }

  for (const chat of snap.chats) {
    const gap = chat.cardRect.y - bottom(chat.scrollerRect);
    if (chat.statusEmpty && gap > TOL) {
      out.push({ rule: 'transcript-gap', severity: 'warn', message: `${chat.scroller} stops ${Math.round(gap)}px above its reply box.`, rect: { x: chat.scrollerRect.x, y: bottom(chat.scrollerRect), w: chat.scrollerRect.w, h: gap } });
    }
  }

  const byKey = new Map(snap.landmarks.map((l) => [l.key, l]));
  for (const [column, head] of [['bot-main', 'bot-main-head'], ['side-panel', 'side-panel-head']]) {
    const c = byKey.get(column);
    const h = byKey.get(head);
    if (!c || !h) continue;
    // The column's own hairline is inside its box; the head may sit inside it.
    if (Math.abs(h.rect.x - c.rect.x) > 2 || Math.abs(right(h.rect) - right(c.rect)) > 2) {
      out.push({ rule: 'head-spans-column', severity: 'warn', message: `${h.desc} spans ${Math.round(h.rect.x)} to ${Math.round(right(h.rect))}, its column ${Math.round(c.rect.x)} to ${Math.round(right(c.rect))}.`, rect: h.rect });
    }
  }
  return out;
}

/**
 * What raising the keyboard broke: the same screen at rest (`rest`) and with
 * the keys up (`up`). The page may get shorter; it must not move sideways,
 * and from 768px nothing beside the page goes away.
 */
export function checkKeyboard(rest, up, profile) {
  const out = [];
  const after = new Map(up.landmarks.map((l) => [l.key, l]));
  for (const before of rest.landmarks) {
    const now = after.get(before.key);
    if (!now) {
      // On a phone the tab bar at the foot goes with the keys, by design.
      if (before.key === 'sidebar' && rest.viewport.w < 768) continue;
      // A header may fold away while the keys take the room of a short screen;
      // what must not go is what stands beside the page.
      if (/head|title/.test(before.key)) continue;
      if (rest.viewport.w >= 768) {
        out.push({ rule: 'keyboard-shift', severity: 'error', message: `${before.desc} disappears when the keyboard comes up.`, rect: before.rect });
      }
      continue;
    }
    const dx = Math.max(Math.abs(now.rect.x - before.rect.x), Math.abs(right(now.rect) - right(before.rect)));
    if (dx > TOL) {
      out.push({ rule: 'keyboard-shift', severity: 'error', message: `${before.desc} moves ${Math.round(dx)}px sideways when the keyboard comes up.`, rect: now.rect });
    }
  }
  for (const chat of up.chats) {
    if (!chat.focused) continue;
    if (bottom(chat.cardRect) > up.viewport.visibleH + TOL) {
      out.push({ rule: 'reply-box-covered', severity: 'error', message: `The reply box being typed in ends ${Math.round(bottom(chat.cardRect) - up.viewport.visibleH)}px behind the keyboard.`, rect: chat.cardRect });
    }
  }
  if (!profile.keyboard) return [];
  return out;
}
