/**
 * `PR#123` / `#123` suggestions for the Activity feed's reply box (#2497).
 *
 * ── Why it is a sibling of mention-typeahead.tsx ──────────────────────
 *
 * `RefAutocomplete` in public/js/group-chat.js is the platform's reference
 * typeahead: it opens on `PR#` (open PRs) or a bare `#` (open issues first,
 * then open PRs) in the card page's chat composer, and inserts the canonical
 * `PR#N ` / `#N ` forms the message renderer chips. Three of its parts are
 * reused here — the ENDPOINTS (`/promoted` + `/github-issues`, the two the
 * activity panel already reads, cached per app for the same two minutes), the
 * TRIGGER GRAMMAR (its `_triggerRe`, character for character, so the dropdown
 * never offers a completion where the renderer would not chip), and the ROWS,
 * which are features/group-chat/autocomplete.tsx's `RefMenuView` — the same
 * `gc-ref-option` markup with the same violet/emerald badges, so the card
 * page's list and the feed's are one object.
 *
 * What cannot be reused is the module itself, for exactly the reasons
 * mention-typeahead.tsx's header sets out: it is a singleton with one
 * `_input`, one body-level `#gc-ref-menu` it measures against that field, and
 * an accept that writes `input.value` directly. The feed has one composer PER
 * ROW, each a React-controlled textarea, so this list is React's — state in
 * the component, the value changed through `onChange`, and the host a sibling
 * of the textarea inside the form.
 *
 * ── Two lists, one caret ──────────────────────────────────────────────
 *
 * The composer chains this hook after the `@` one. A token under the caret is
 * `@`-shaped or `#`-shaped and never both (the triggers exclude each other),
 * so both are asked on every keystroke and at most one of them opens.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { RefMenuView } from '../../group-chat/autocomplete';
import type { RefOption } from '../../group-chat/autocomplete-store';
import { menuKeyFor, visibleTop } from './mention-typeahead';

/** Rows kept after the prefix filter; the menu scrolls past about eight. */
export const REF_MAX_RESULTS = 50;
/**
 * A stale list only means a just-opened PR or issue is not suggested for a
 * couple of minutes (the issues endpoint is itself cached server-side for
 * five) — the number can still be typed by hand and it chips exactly the same.
 */
export const REF_CACHE_TTL_MS = 2 * 60 * 1000;

/**
 * `RefAutocomplete._triggerRe`, unchanged. Anchored at the caret: a boundary
 * (start, or a character that is neither a word character nor `&`), then
 * `PR#` / `PR #` (PR mode) or a bare `#` (combined mode), then digits only.
 * Typing a non-digit after the `#` stops it matching and the list closes. The
 * `&` exclusion mirrors the renderer's own boundary, and `[^\w]` excludes `@`,
 * so a `@name` token can never also be a ref token.
 */
const TRIGGER_RE = /(^|[^\w&])(pr ?#|#)(\d{0,7})$/i;

export type RefMode = 'pr' | 'combined';

export interface RefToken {
  /** Index of the `P` or the `#` in the value. */
  start: number;
  /** The digits typed after it, possibly none. */
  query: string;
  /** `pr` lists open PRs; `combined` lists open issues, then open PRs. */
  mode: RefMode;
}

/** The ref token immediately before `caret`, or null when there is none. */
export function detectRefToken(value: string, caret: number): RefToken | null {
  if (caret < 0 || caret > value.length) return null;
  const m = value.slice(0, caret).match(TRIGGER_RE);
  if (!m || m.index == null) return null;
  return {
    start: m.index + m[1].length,
    query: m[3],
    // `#` is one character; `PR#` and `PR #` are three or four.
    mode: m[2].length > 1 ? 'pr' : 'combined',
  };
}

export interface RefCandidates {
  prs: RefOption[];
  issues: RefOption[];
}

/**
 * Prefix match on the stringified number ("1" matches #1, #12, #130), capped.
 * Combined mode lists the issues block first and the PRs after it, which is
 * the order the chat's menu shows them in.
 */
export function filterRefCandidates(
  candidates: RefCandidates, query: string, mode: RefMode,
): RefOption[] {
  const pool = mode === 'pr' ? candidates.prs : [...candidates.issues, ...candidates.prs];
  const out: RefOption[] = [];
  for (const item of pool) {
    if (!query || String(item.number).startsWith(query)) {
      out.push(item);
      if (out.length >= REF_MAX_RESULTS) break;
    }
  }
  return out;
}

/**
 * Replace the ref token that starts at `start` and runs to `caret` with the
 * canonical `PR#N ` or `#N ` (trailing space), and say where the caret lands
 * after it. A PR picked from the combined menu still inserts `PR#N`, as the
 * chat composer's does.
 */
export function spliceRef(
  value: string, start: number, caret: number, kind: RefOption['kind'], number: number,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const insert = kind === 'pr' ? `PR#${number} ` : `#${number} `;
  return { value: before + insert + value.slice(caret), caret: before.length + insert.length };
}

export function promotedPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/promoted`;
}

export function githubIssuesPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/github-issues`;
}

// ── The candidate lists: one pair of fetches per app, shared by every row ──

interface CacheEntry extends RefCandidates { fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RefCandidates>>();

const EMPTY: RefCandidates = { prs: [], issues: [] };

/** The fresh lists for `slug`, or null when there are none yet. */
export function cachedRefCandidates(slug: string, now: number = Date.now()): RefCandidates | null {
  const hit = cache.get(slug);
  return hit && now - hit.fetchedAt < REF_CACHE_TTL_MS ? { prs: hit.prs, issues: hit.issues } : null;
}

/**
 * The lists for `slug`, from the cache or the two endpoints, fetched together.
 * An endpoint that answers with anything but a 200 contributes nothing and the
 * pair is still cached, so a viewer who may not read one of them does not
 * re-ask within the TTL; a failed fetch is not cached, so the next `#` retries
 * once the network is back.
 *
 * Open (promoted or merging) PRs only, which is the set the drawer's "Open
 * PRs" section shows. A merged PR is deliberately not suggested; typed out it
 * still chips and still links.
 */
export function loadRefCandidates(slug: string): Promise<RefCandidates> {
  const fresh = cachedRefCandidates(slug);
  if (fresh) return Promise.resolve(fresh);
  const pending = inflight.get(slug);
  if (pending) return pending;
  const p = (async () => {
    try {
      const [prRes, issueRes] = await Promise.all([
        fetch(promotedPath(slug)),
        fetch(githubIssuesPath(slug)),
      ]);
      const prData = prRes.ok ? await prRes.json() : {};
      const issueData = issueRes.ok ? await issueRes.json() : {};
      const prs: RefOption[] = (Array.isArray(prData?.promoted) ? prData.promoted : [])
        .filter((pr: any) => pr && pr.pr_number != null)
        .map((pr: any) => ({
          kind: 'pr' as const,
          number: Number(pr.pr_number),
          title: String(pr.pr_title || `by ${pr.username || ''}`),
        }));
      const issues: RefOption[] = (Array.isArray(issueData?.issues) ? issueData.issues : [])
        .filter((i: any) => i && i.number != null)
        .map((i: any) => ({ kind: 'issue' as const, number: Number(i.number), title: String(i.title || '') }));
      const entry: RefCandidates = { prs, issues };
      cache.set(slug, { ...entry, fetchedAt: Date.now() });
      return entry;
    } catch {
      return EMPTY;
    } finally {
      inflight.delete(slug);
    }
  })();
  inflight.set(slug, p);
  return p;
}

/** Tests only: forget every cached pair. */
export function resetRefCache(): void {
  cache.clear();
  inflight.clear();
}

export interface RefTypeahead {
  /** References on show; empty means closed. */
  items: RefOption[];
  /** The highlighted row; -1 when closed. */
  active: number;
  /** The list has no room above the field and opens under it instead. */
  below: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Re-read the field's value and caret; open, refresh or close the list. */
  sync: () => void;
  close: () => void;
  /** Replace the active ref token with `PR#N ` / `#N ` through `onChange`. */
  accept: (kind: RefOption['kind'], number: number) => void;
  /** True when an open list owned the key (and consumed it). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Start the app's lists loading, so they are warm by the first `#`. */
  warm: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

export function useRefTypeahead({
  slug, inputRef, value, onChange,
}: {
  slug: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The controlled value; the caret is restored once it has been written. */
  value: string;
  onChange: (next: string) => void;
}): RefTypeahead {
  const [items, setItems] = useState<RefOption[]>([]);
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
    const apply = (candidates: RefCandidates) => {
      // Read the field as it is NOW — this also runs when the fetches land,
      // after which the person may have moved on, or away.
      const caret = el.selectionStart;
      const token = document.activeElement === el && caret != null && caret === el.selectionEnd
        ? detectRefToken(el.value, caret)
        : null;
      const next = token ? filterRefCandidates(candidates, token.query, token.mode) : [];
      if (!token || !next.length) { close(); return; }
      tokenStart.current = token.start;
      setItems(next);
      // The top row is highlighted whenever the set changes, as the chat's is.
      setActive(0);
    };
    const candidates = cachedRefCandidates(slug);
    if (candidates) { apply(candidates); return; }
    close();
    const caret = el.selectionStart;
    if (caret == null || !detectRefToken(el.value, caret)) return;
    void loadRefCandidates(slug).then(apply);
  }, [slug, inputRef, close]);

  const warm = useCallback(() => {
    if (!cachedRefCandidates(slug)) void loadRefCandidates(slug);
  }, [slug]);

  const accept = useCallback((kind: RefOption['kind'], number: number) => {
    const el = inputRef.current;
    const start = tokenStart.current;
    if (!el || !number || start < 0) { close(); return; }
    const caret = el.selectionStart ?? el.value.length;
    const next = spliceRef(el.value, start, caret, kind, number);
    pendingCaret.current = next.caret;
    close();
    onChange(next.value);
  }, [inputRef, onChange, close]);

  // The caret lands after the inserted reference once React has written the
  // new value — a layout effect, so the field never paints with it at the end.
  useIsomorphicLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = inputRef.current;
    if (pos == null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [value]);

  // Above the field by default, as the chat composers' menus are; under it
  // when there is no room above. Measured against the form the list hangs
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
    const item = items[active];
    // Nothing highlighted to take: Enter and Tab stay the textarea's.
    if (key === 'accept' && !item) return false;
    e.preventDefault();
    e.stopPropagation();
    if (key === 'close') close();
    else if (key === 'accept') accept(item.kind, item.number);
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
 * The list's host: the same box and the same placement the `@` list uses
 * (`gc-mention-menu` + `dev-feed-mention-menu`, app.css), since the two are
 * never open at once and a second placement rule would only be the first one
 * copied. `RefMenuView`'s rows go inside it, and `data-feed-ref-menu` is what
 * tells the two hosts apart. Draws nothing while closed, so a row's markup is
 * exactly what it was until somebody types `#`.
 */
export function FeedRefMenu({
  items, active, below, menuRef, onPick,
}: {
  items: RefOption[];
  active: number;
  below: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onPick: (kind: RefOption['kind'], number: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div
      ref={menuRef}
      className={below
        ? 'gc-mention-menu dev-feed-mention-menu dev-feed-mention-menu-below'
        : 'gc-mention-menu dev-feed-mention-menu'}
      role="listbox"
      aria-label="Insert a pull request or issue reference"
      data-feed-ref-menu=""
      // mousedown, not click, and prevented — the field keeps focus, so the
      // list is still open when the pick lands (a blur would close it first).
      // Delegated to the host and read off the row's `data-kind` /
      // `data-number`, the same contract the chat menu's host has with these
      // rows.
      onMouseDown={(e) => {
        const target = e.target as HTMLElement | null;
        const opt = target?.closest?.('.gc-ref-option') as HTMLElement | null;
        if (!opt) return;
        e.preventDefault();
        const kind = opt.dataset.kind === 'pr' ? 'pr' : 'issue';
        onPick(kind, Number(opt.dataset.number || 0));
      }}
    >
      <RefMenuView items={items} active={active} />
    </div>
  );
}
