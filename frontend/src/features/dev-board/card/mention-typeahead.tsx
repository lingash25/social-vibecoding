/**
 * `@name` suggestions for the Activity feed's reply box (#2145).
 *
 * ── What it shares with the group chat's, and why it is not that module ──
 *
 * `MentionAutocomplete` in public/js/group-chat.js is the platform's `@`
 * typeahead: it opens on `@` in a chat composer, lists the app's people from
 * GET /api/apps/:slug/mention-suggestions, and inserts `@username `. Three of
 * its parts are reused here — the ENDPOINT (one list per app, cached for the
 * same two minutes), the TOKEN GRAMMAR (`MENTION_CHARS` / `MENTION_MAX_LEN`,
 * kept in step with the server's MENTION_RE in src/services/notifications.js
 * so a picked name is one the server will notify), and the ROWS, which are
 * features/group-chat/autocomplete.tsx's `MentionMenuView`: the same
 * `gc-mention-option` markup the chat menu draws, so the two lists are one
 * object.
 *
 * What cannot be reused is the module itself. It is a singleton bound to one
 * `#gc-input`: one `_input`, one body-level `#gc-mention-menu` it measures
 * against that field, a dismiss listener on `#gc-messages`, and an accept
 * that writes `input.value` and dispatches a synthetic `input` event. The feed
 * has one composer PER ROW, each a React-controlled textarea, so its list has
 * to be React's — state in the component, the value changed through
 * `onChange`, and the host a sibling of the textarea inside the form rather
 * than a second writer to a node the island owns. That is what this file is.
 *
 * ── Keys, while the list is open ─────────────────────────────────────
 *
 * ArrowUp / ArrowDown move the highlight, Enter or Tab take it, Escape closes,
 * and each of those is consumed so it never reaches the textarea's default
 * (an Enter would otherwise add the newline AND the mention). Closed, every
 * key is the textarea's: plain Enter still adds a line, and ⌘/Ctrl+Enter is
 * the composer's send chord (feed-thread.tsx).
 */

import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { MentionMenuView } from '../../group-chat/autocomplete';

/** The character class the server's MENTION_RE recognises. */
export const MENTION_CHARS = 'A-Za-z0-9_';
export const MENTION_MAX_LEN = 32;
/** Rows kept after the prefix filter; the menu scrolls past about eight. */
export const MENTION_MAX_RESULTS = 50;
/** A stale list only means a just-joined person is not suggested yet. */
export const MENTION_CACHE_TTL_MS = 2 * 60 * 1000;

// Anchored to the caret: a boundary (start or a non-mention char), `@`, then
// up to MENTION_MAX_LEN mention chars, end of the text before the caret.
const TRIGGER_RE = new RegExp(
  `(^|[^${MENTION_CHARS}])@([${MENTION_CHARS}]{0,${MENTION_MAX_LEN}})$`,
);

export interface MentionToken {
  /** Index of the `@` in the value. */
  start: number;
  /** What has been typed after it, possibly nothing. */
  query: string;
}

/** The `@token` immediately before `caret`, or null when there is none. */
export function detectMentionToken(value: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > value.length) return null;
  const m = value.slice(0, caret).match(TRIGGER_RE);
  if (!m || m.index == null) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/** Case-insensitive prefix match, canonical casing kept, capped. */
export function filterMentionCandidates(names: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  for (const name of names) {
    if (!q || name.toLowerCase().startsWith(q)) {
      out.push(name);
      if (out.length >= MENTION_MAX_RESULTS) break;
    }
  }
  return out;
}

/**
 * Replace the `@token` that starts at `start` and runs to `caret` with
 * `@username ` (trailing space), and say where the caret lands after it.
 */
export function spliceMention(
  value: string, start: number, caret: number, username: string,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const insert = `@${username} `;
  return { value: before + insert + value.slice(caret), caret: before.length + insert.length };
}

export function mentionSuggestionsPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/mention-suggestions`;
}

// ── The candidate list: one fetch per app, shared by every row ────────
//
// A Workshop page mounts a composer under every unfolded row. The list is the
// app's, not the row's, so it is cached by slug (with the group chat's TTL)
// and a fetch in flight is handed to every caller that asks while it runs.

interface CacheEntry { users: string[]; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string[]>>();

/** The fresh list for `slug`, or null when there is none yet. */
export function cachedMentionCandidates(slug: string, now: number = Date.now()): string[] | null {
  const hit = cache.get(slug);
  return hit && now - hit.fetchedAt < MENTION_CACHE_TTL_MS ? hit.users : null;
}

/**
 * The list for `slug`, from the cache or the endpoint. A response the server
 * refused (a 404 for a viewer who may not post) is cached as empty — it will
 * not change within the TTL — while a failed fetch is not, so the next `@`
 * retries once the network is back.
 */
export function loadMentionCandidates(slug: string): Promise<string[]> {
  const fresh = cachedMentionCandidates(slug);
  if (fresh) return Promise.resolve(fresh);
  const pending = inflight.get(slug);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(mentionSuggestionsPath(slug));
      let users: string[] = [];
      if (res.ok) {
        const data = await res.json();
        users = Array.isArray(data?.users)
          ? data.users.map((u: any) => String((u && u.username) || '')).filter(Boolean)
          : [];
      }
      cache.set(slug, { users, fetchedAt: Date.now() });
      return users;
    } catch {
      return [];
    } finally {
      inflight.delete(slug);
    }
  })();
  inflight.set(slug, p);
  return p;
}

/** Tests only: forget every cached list. */
export function resetMentionCache(): void {
  cache.clear();
  inflight.clear();
}

// ── Keys ──────────────────────────────────────────────────────────────

export type MenuKey = 'up' | 'down' | 'accept' | 'close';

/** What a key means to an OPEN list; null for a key the textarea keeps. */
export function menuKeyFor(key: string): MenuKey | null {
  switch (key) {
    case 'ArrowDown': return 'down';
    case 'ArrowUp': return 'up';
    case 'Enter':
    case 'Tab': return 'accept';
    case 'Escape': return 'close';
    default: return null;
  }
}

/** The signed-in viewer's handle, lowercased, for the "you" tag (App.user is app.js's). */
function viewerName(): string {
  const u = typeof window !== 'undefined' ? (window as any).App?.user : null;
  return String((u && u.username) || '').toLowerCase();
}

/**
 * The top edge, in viewport pixels, above which `el` cannot be seen: the
 * nearest scrolling ancestor's, or the viewport's own. Exported because the
 * `#` list (./ref-typeahead.tsx) flips against the same measurement.
 */
export function visibleTop(el: HTMLElement): number {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const overflow = getComputedStyle(a).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      return Math.max(0, a.getBoundingClientRect().top);
    }
  }
  return 0;
}

export interface MentionTypeahead {
  /** Usernames on show; empty means closed. */
  items: string[];
  /** The highlighted row; -1 when closed. */
  active: number;
  /** The list has no room above the field and opens under it instead. */
  below: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Re-read the field's value and caret; open, refresh or close the list. */
  sync: () => void;
  close: () => void;
  /** Replace the active `@token` with `@username ` through `onChange`. */
  accept: (username: string) => void;
  /** True when an open list owned the key (and consumed it). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Start the app's list loading, so it is warm by the first `@`. */
  warm: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

export function useMentionTypeahead({
  slug, inputRef, value, onChange,
}: {
  slug: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The controlled value; the caret is restored once it has been written. */
  value: string;
  onChange: (next: string) => void;
}): MentionTypeahead {
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [below, setBelow] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const tokenStart = useRef(-1);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);

  const close = useCallback(() => {
    tokenStart.current = -1;
    // A closed list that is asked to close again must not re-render the row.
    setItems((prev) => (prev.length ? [] : prev));
    setActive(-1);
  }, []);

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!el || composing.current) return;
    const apply = (names: string[]) => {
      // Read the field as it is NOW — this also runs when a fetch lands,
      // after which the person may have moved on, or away.
      const caret = el.selectionStart;
      const token = document.activeElement === el && caret != null && caret === el.selectionEnd
        ? detectMentionToken(el.value, caret)
        : null;
      const next = token ? filterMentionCandidates(names, token.query) : [];
      if (!token || !next.length) { close(); return; }
      tokenStart.current = token.start;
      setItems(next);
      // The top row is highlighted whenever the set changes, as the chat's is.
      setActive(0);
    };
    const names = cachedMentionCandidates(slug);
    if (names) { apply(names); return; }
    close();
    const caret = el.selectionStart;
    if (caret == null || !detectMentionToken(el.value, caret)) return;
    void loadMentionCandidates(slug).then(apply);
  }, [slug, inputRef, close]);

  const warm = useCallback(() => {
    if (!cachedMentionCandidates(slug)) void loadMentionCandidates(slug);
  }, [slug]);

  const accept = useCallback((username: string) => {
    const el = inputRef.current;
    const start = tokenStart.current;
    if (!el || !username || start < 0) { close(); return; }
    const caret = el.selectionStart ?? el.value.length;
    const next = spliceMention(el.value, start, caret, username);
    pendingCaret.current = next.caret;
    close();
    onChange(next.value);
  }, [inputRef, onChange, close]);

  // The caret lands after the inserted name once React has written the new
  // value — a layout effect, so the field never paints with it at the end.
  useIsomorphicLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = inputRef.current;
    if (pos == null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [value]);

  // Above the field by default, as the chat composers' menus are; under it
  // when there is no room above (a short thread in the Needs-you comments
  // sheet, whose body scrolls). Measured against the form the list hangs
  // from, so the answer does not depend on where the list currently is.
  useIsomorphicLayoutEffect(() => {
    const host = menuRef.current;
    const anchor = host?.offsetParent as HTMLElement | null | undefined;
    if (!host || !anchor || !items.length) return;
    const room = anchor.getBoundingClientRect().top - visibleTop(host);
    setBelow(room < host.offsetHeight + 8);
  }, [items]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!items.length) return false;
    const key = menuKeyFor(e.key);
    if (!key) return false;
    const name = items[active];
    // Nothing highlighted to take: Enter and Tab stay the textarea's.
    if (key === 'accept' && !name) return false;
    e.preventDefault();
    e.stopPropagation();
    if (key === 'close') close();
    else if (key === 'accept') accept(name);
    else setActive((prev) => (prev + (key === 'down' ? 1 : -1) + items.length) % items.length);
    return true;
  }, [items, active, accept, close]);

  const onCompositionStart = useCallback(() => { composing.current = true; }, []);
  const onCompositionEnd = useCallback(() => { composing.current = false; sync(); }, [sync]);

  return {
    items, active, below, menuRef, sync, close, accept, onKeyDown, warm,
    onCompositionStart, onCompositionEnd,
  };
}

/**
 * The list's host: the chat menu's box (`gc-mention-menu`, app.css), placed
 * against the composer form rather than the body (`dev-feed-mention-menu`),
 * with `MentionMenuView`'s rows inside. Draws nothing while closed, so a
 * row's markup is exactly what it was until somebody types `@`.
 */
export function FeedMentionMenu({
  items, active, below, menuRef, onPick,
}: {
  items: string[];
  active: number;
  below: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onPick: (username: string) => void;
}) {
  if (!items.length) return null;
  const me = viewerName();
  return (
    <div
      ref={menuRef}
      className={below
        ? 'gc-mention-menu dev-feed-mention-menu dev-feed-mention-menu-below'
        : 'gc-mention-menu dev-feed-mention-menu'}
      role="listbox"
      aria-label="Mention someone"
      data-feed-mention-menu=""
      // mousedown, not click, and prevented — the field keeps focus, so the
      // list is still open when the pick lands (a blur would close it first).
      // Delegated to the host and read off the row's `data-username`, the
      // same contract the chat menu's host has with these rows.
      onMouseDown={(e) => {
        const target = e.target as HTMLElement | null;
        const opt = target?.closest?.('.gc-mention-option') as HTMLElement | null;
        if (!opt) return;
        e.preventDefault();
        onPick(opt.dataset.username || '');
      }}
    >
      <MentionMenuView
        items={items.map((username) => ({ username, you: username.toLowerCase() === me }))}
        active={active}
      />
    </div>
  );
}
