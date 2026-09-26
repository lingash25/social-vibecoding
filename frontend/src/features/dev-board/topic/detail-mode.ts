/**
 * #2841 / #2842 — a change page's Basic / Advanced details preference.
 *
 * A change page opens BASIC: what a voter needs (the title, the summary, who
 * proposed it, the preview, the vote, and one line per merge step). The
 * technical half — the pull request link, the per-check rows, the build
 * pipeline, the pull request's own description and testing steps — is
 * one switch away ("Advanced details", topic-head.tsx `DetailModeToggle`).
 *
 * The choice is the VIEWER's, remembered in this browser's localStorage. It
 * is presentation only: every fact the advanced view shows is already in the
 * page the viewer was sent, so this hides nothing from anyone who could read
 * it and reveals nothing to anyone who could not.
 *
 * Basic hides by CSS (app.css `.dev-topic[data-detail-mode="basic"]`), not
 * by leaving nodes out: the declared presence checks select on the ledger's
 * nodes, and a render that dropped them would be a different page for the
 * checker than for the reader who flips the switch.
 *
 * Storage can throw (a private window, blocked site data) and can hold
 * anything (an older build, a hand edit). Both read as the default: only the
 * exact string 'advanced' opens the advanced view.
 */

import { createStore } from '../../../lib/plain-store.js';

export type DetailMode = 'basic' | 'advanced';

export const DETAIL_MODE_KEY = 'homeroom.changeDetailMode';
export const DEFAULT_DETAIL_MODE: DetailMode = 'basic';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The stored preference, or the default for a missing, stale or unreadable one. */
export function readDetailMode(from: StorageLike | null = storage()): DetailMode {
  try {
    return from && from.getItem(DETAIL_MODE_KEY) === 'advanced' ? 'advanced' : DEFAULT_DETAIL_MODE;
  } catch {
    return DEFAULT_DETAIL_MODE;
  }
}

/** Persist the preference; a storage that refuses it only costs the memory. */
export function writeDetailMode(mode: DetailMode, to: StorageLike | null = storage()): void {
  try {
    if (to) to.setItem(DETAIL_MODE_KEY, mode);
  } catch {
    /* private mode or quota: the switch still works for this page view */
  }
}

/**
 * One store, so every change page mounted at once (the topic page and a
 * Workshop row that unfolded the same change) agrees on the mode.
 */
export const detailModeStore = createStore<{ mode: DetailMode }>({ mode: readDetailMode() });

export function setDetailMode(mode: DetailMode): void {
  writeDetailMode(mode);
  detailModeStore.set({ mode });
}
