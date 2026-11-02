// What the audit measures in the page: a plain-data snapshot of where things
// are, which ./rules.mjs then judges. `collect` runs IN the page (the driver
// sends its source), so it may use the DOM and nothing from this module's
// scope. Keeping the judging out of the page is what lets the rules be unit
// tested without a browser.

/* global document, window, getComputedStyle */

export function collect(offset = { x: 0, y: 0 }) {
  const round = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left + offset.x), y: round(r.top + offset.y), w: round(r.width), h: round(r.height) };
  };
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  };
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).filter((c) => !/^(hidden|flex|grid|block|inline|relative|absolute)$/.test(c)).slice(0, 2).join('.')
      : '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${label ? ` "${label}"` : ''}`;
  };
  // Is the point at the middle of `el` actually `el` (or inside it), or is
  // something drawn over it? Only what a finger can reach counts as a target.
  const reachable = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  // A horizontal scroller or a clipping box between `el` and the page keeps
  // what pokes past the window from being seen there.
  const clippedInside = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible') {
        const r = p.getBoundingClientRect();
        if (r.left >= -1 && r.right <= window.innerWidth + 1) return true;
      }
    }
    return false;
  };

  // Inside something that scrolls, so it passes under whatever is drawn at
  // the screen's edge and can be scrolled back out: a row in a list, a line
  // in a chat. Fixed chrome (a header, a tab bar, a reply box) cannot.
  const scrolls = (el) => {
    // Walking up: a fixed or sticky box first means it stays put (a sticky
    // header inside a list included); a box that scrolls first means it moves.
    // A box that scrolls is checked before its own position: a fixed sidebar
    // that scrolls still moves the rows inside it.
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (p !== el && /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return true;
      if (p !== el && /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      if (cs.position === 'fixed' || cs.position === 'sticky') return false;
    }
    const se = document.scrollingElement;
    return !!se && se.scrollHeight > se.clientHeight + 1;
  };

  const root = document.documentElement;
  const bodyStyle = getComputedStyle(document.body);
  const vv = window.visualViewport;
  const facts = {
    sideStrip: root.dataset.sideStrip || null,
    topBand: root.hasAttribute('data-top-band'),
    sideCorner: root.dataset.sideCorner || null,
    keyboardClass: root.classList.contains('un-kb'),
    keyboardOpen: root.classList.contains('platform-kb-open'),
    keyboardInset: root.style.getPropertyValue('--un-kb-inset') || null,
    railWidth: bodyStyle.getPropertyValue('--platform-rail-w').trim(),
    stripWidth: bodyStyle.getPropertyValue('--platform-strip-w').trim(),
    hash: window.location.hash,
    coarse: window.matchMedia('(pointer: coarse)').matches,
  };
  const viewport = {
    w: window.innerWidth,
    h: window.innerHeight,
    visibleH: vv ? round(vv.height) : window.innerHeight,
    scrollW: root.scrollWidth,
  };

  // The page's large parts, by a stable name, so two snapshots of the same
  // screen can be compared part by part.
  const LANDMARKS = [
    ['header', '#platform-header'],
    ['sidebar', '#platform-tabs'],
    ['header-title', '#header-title'],
    ['bot-list', '#ai-screen .ai-drawer-list, #ai-screen [data-ai-list]'],
    ['bot-main', '#ai-main-pane'],
    ['bot-main-head', '#ai-main-pane .ai-main-head'],
    ['bot-divider', '#ai-main-divider'],
    ['side-panel', '#platform-side-panel'],
    ['side-panel-head', '#platform-side-panel .side-panel-head'],
    ['messages-list', '#messages-screen .messages-list-pane'],
    ['messages-thread', '.messages-thread-pane'],
    ['messages-thread-head', '.messages-thread-head, .messages-header'],
    ['channel', '#gc-messages'],
  ];
  const landmarks = [];
  for (const [key, sel] of LANDMARKS) {
    const el = [...document.querySelectorAll(sel)].find(shown);
    if (el) landmarks.push({ key, desc: describe(el), rect: box(el) });
  }

  const TARGETS = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="separator"][tabindex], [contenteditable="true"]';
  const targets = [];
  for (const el of document.querySelectorAll(TARGETS)) {
    if (!shown(el) || el.closest('[aria-hidden="true"], [inert]')) continue;
    if (el.disabled) continue;
    // What a finger can hit, which an invisible layer can make larger than
    // what is drawn: the kit's `un-touch-target` is a 44px ::after.
    const hit = box(el);
    const after = getComputedStyle(el, '::after');
    if (after.content !== 'none' && after.position === 'absolute') {
      const w = parseFloat(after.width);
      const h = parseFloat(after.height);
      if (Number.isFinite(w) && w > hit.w) { hit.x -= (w - hit.w) / 2; hit.w = w; }
      if (Number.isFinite(h) && h > hit.h) { hit.y -= (h - hit.h) / 2; hit.h = h; }
    }
    targets.push({ desc: describe(el), rect: box(el), hit, reachable: reachable(el), clipped: clippedInside(el), scrolls: scrolls(el), inline: getComputedStyle(el).display === 'inline' });
  }

  // What the page draws to be read or seen, in its fixed chrome: a label, an
  // icon, a picture. Text that scrolls is left out, as above.
  const marks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el && marks.length < 600; el = walker.nextNode()) {
    const tag = el.tagName.toLowerCase();
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!ownText && tag !== 'svg' && tag !== 'img') continue;
    if (!shown(el) || el.closest('[aria-hidden="true"]') && tag !== 'svg') continue;
    if (scrolls(el)) continue;
    marks.push({ desc: describe(el), rect: box(el) });
  }

  // Each transcript and the reply box under it: the scroller, the status
  // line between them (and whether it says anything), and the card.
  const chats = [];
  for (const scroller of document.querySelectorAll('.messages-thread-scroll, #gc-messages, #gc-thread-scroll')) {
    if (!shown(scroller)) continue;
    let column = scroller.parentElement;
    let card = null;
    for (let hop = 0; column && hop < 4 && !card; hop++, column = column.parentElement) {
      card = [...column.querySelectorAll('.messages-composer-card, .gc-composer-card')].find((c) => shown(c) && (scroller.compareDocumentPosition(c) & 4));
    }
    if (!card) continue;
    const status = [...(column || document).querySelectorAll('.messages-typing, #gc-typing, #gc-thread-typing')].find((s) => s.isConnected && (scroller.compareDocumentPosition(s) & 4));
    chats.push({
      scroller: describe(scroller),
      scrollerRect: box(scroller),
      cardRect: box(card),
      statusEmpty: status ? !status.textContent.trim() : true,
      focused: card.contains(document.activeElement),
    });
  }

  // A page in a same-origin frame (the side panel is one): measured the same
  // way, inside it, and placed where the frame is on the screen.
  for (const frame of document.querySelectorAll('iframe')) {
    if (!shown(frame)) continue;
    let sub = null;
    try {
      const r = frame.getBoundingClientRect();
      sub = frame.contentWindow.eval(`(${collect.toString()})(${JSON.stringify({ x: r.left + offset.x, y: r.top + offset.y })})`);
    } catch { sub = null; }
    if (!sub) continue;
    for (const l of sub.landmarks) landmarks.push({ ...l, key: `frame:${l.key}` });
    targets.push(...sub.targets);
    marks.push(...(sub.marks || []));
    chats.push(...sub.chats.map((c) => ({ ...c, inFrame: true })));
  }

  return { facts, viewport, landmarks, targets, chats, marks };
}

/** The expression a driver evaluates to take a snapshot. */
export const COLLECT_EXPRESSION = `(${collect.toString()})()`;
