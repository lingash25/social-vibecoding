/**
 * `#workshop-screen` — Needs you: every decision owed by you, across all of
 * your projects, as one page (`#needs`).
 *
 * ── What is left of the Communities screen (One Home, #6361) ───────────
 *
 * This root was the Communities screen: the list of every community you
 * are in, under a search and audience chips, with a Needs you row at its
 * top that opened the cross-project feed as a page of its own. One Home
 * made Home the one page of apps and communities (its Pinned communities
 * and their All communities tile are the list now), and the list went. The
 * feed stays, as its own page: the vote digest's notification opens it, and
 * so does Home's Needs you tile, which carries the number of votes waiting.
 * `#communities` and `#workshop`, the screen's addresses, land on Home; with
 * `?ws=needs` they land here (public/js/app.js restoreFromHash).
 *
 * The header names the page and holds the way back, an arrow up to Home
 * (App._BACK_SLOT): the page is a level under Home, as Challenges is under
 * Me. The root keeps its id, so the router, App.REACT_SCREEN_IDS and the
 * declared checks address it as they did.
 *
 * ── The feed ────────────────────────────────────────────────────────────
 *
 * GET /api/workshop/needs-feed (src/routes/workshop-overview.js): every
 * decision owed by you across your projects, newest first, drawn by the
 * review flow (../review-flow/): a page per change with a before/after
 * picture and a vote bar. GET /api/workshop/counts is read beside it for the
 * one count of votes waiting (`takeCounts`, ./community-scope.ts), which
 * Home's tile and the tab badge read: a vote cast here lowers both.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, and nothing in
 * it — and both reads run from `open()`, never during render. Screen
 * visibility is the shell's store (`#workshop-screen` is in
 * App.REACT_SCREEN_IDS) and the root's `className` is a constant, so the
 * class has exactly one owner.
 */

import { useRef } from 'react';
import { flushSync } from 'react-dom';

import { useStoreState } from '../../lib/use-store-state';
import { sharedJson } from '../../lib/shared-read';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { withoutClosedVote } from '../../lib/work-state';
import { WORK_CHANGED_EVENT } from '../messages/bot-shared';
import {
  publishVoteSaved,
  voteSavedStore,
} from '../dev-board/card/cards-store';
import { takeCounts } from './community-scope';
import type { NeedsFeedItem } from './needs-reel';
import { ReviewFlow } from '../review-flow/review-flow';
import { useNeedsSeen } from './needs-seen';
import { workshopStore } from './workshop-store.js';

// The legacy router reads the DOM on the line after it routes — the ?shot=
// capture fixtures assert the revealed screen inside the same task — so the
// store's notification has to land synchronously. Same install, same reason,
// as features/header/mount.ts.
workshopStore.setFlush(flushSync);

type WorkshopState = {
  open: boolean;
  feed: NeedsFeedItem[] | null;
  feedError: boolean;
  feedCapped: boolean;
};

/**
 * The reel is done, or there was nothing in it: back to Home, by a step Back
 * when Home is the entry below (the way the header's arrow goes), else to it.
 */
function leaveNeeds(): void {
  const app = (window as any).App;
  try {
    if (app?._stepBackTo?.('/')) return;
  } catch { /* fall through to Home */ }
  if (app?.navigateHome) app.navigateHome();
  else window.location.hash = '';
}

export function WorkshopScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(workshopStore) as WorkshopState;
  useVisibilityHiddenClass(screenRef, 'workshop-screen', false);
  useNeedsSeen();

  return (
    <main
      ref={screenRef}
      id="workshop-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      style={{ position: 'relative' }}
    >
      <div className="max-w-2xl mx-auto pb-8">
        {/* `pt-5` CLEARS THE HEADER'S NOTCH (#2718 review): the bar is
            `rounded-b-2xl -mb-2`, so a screen starts 8px under its bottom
            edge, and what leads it steps down the 8 plus 12 of air. No title
            here: the bar says "Needs you". */}
        <div className="pt-5" aria-hidden="true" />
        {/* ONE FEED, EVERYTHING MIXED (#3270): every decision owed by you
            across your projects, one per screen, newest first. All client
            data, so it renders only while the page is open, which keeps the
            cold document as small as it was. */}
        {state.open ? (
          <div data-workshop-pane="needs">
            <ReviewFlow
              items={state.feed}
              error={state.feedError}
              capped={state.feedCapped}
              onDone={leaveNeeds}
              onAnswered={(id, epoch) => workshopController.answered(id, epoch)}
              onRetracted={(id) => workshopController.retracted(id)}
              onSettled={(id) => workshopController.settled(id)}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}

/**
 * The votes cast in a Needs you feed this visit, by `proposal:<id>@<epoch>`
 * (`proposal:<id>` when the row carried no epoch). The store's feed is a copy
 * read BEFORE the vote: once the reel unmounts its "Voted yes" state goes
 * with it, and a remount would redraw the answered card as still owed — the
 * report this answers. The set takes the voted items out of every read that
 * hands the feed its rows, so a read issued before the vote and landing after
 * it cannot bring one back. A NEWER epoch passes: the card changed under the
 * vote and asks again. `close()` clears the set — a fresh visit starts from
 * what the server says.
 */
const answeredVotes = new Set<string>();

function answeredVoteKey(id: number, epoch: number | null): string {
  return `proposal:${id}@${epoch == null ? '' : epoch}`;
}

/** Whether this feed item is a vote answered here, at its own epoch. */
function voteAnswered(item: NeedsFeedItem): boolean {
  if (item.kind !== 'proposal') return false;
  for (const key of answeredVotes) {
    const at = key.indexOf('@');
    if (Number(key.slice('proposal:'.length, at)) !== item.id) continue;
    const raw = key.slice(at + 1);
    const epoch = raw === '' ? null : Number(raw);
    if (item.epoch == null || epoch == null || item.epoch === epoch) return true;
  }
  return false;
}

/** The feed's rows, less the votes answered here. */
function stripAnswered(items: NeedsFeedItem[]): NeedsFeedItem[] {
  return answeredVotes.size ? items.filter((item) => !voteAnswered(item)) : items;
}

/** How often the open page quietly re-reads what waits on you (#5164). */
export const WORKSHOP_REFRESH_MS = 30_000;

/**
 * The quiet refresh behind #5164: while the page is showing, the counts and
 * the feed are read again every WORKSHOP_REFRESH_MS, and once more the
 * moment the browser tab comes back to the front — the moment people most
 * often notice the lag and reach for a page reload.
 *
 * A module-level watch rather than an effect, because the page's root
 * outlives React's mounts the way the controller does: `open()` starts it and
 * `close()` stops it, so nothing runs while the page is hidden and
 * re-entering never stacks a second timer. The interval skips its tick while
 * the tab is hidden; the listener answers the return instead. Guarded on
 * `document` because the tests run in node with only `window` faked.
 */
let watchTimer: number | null = null;
let watchVisibility: (() => void) | null = null;

function startWatch() {
  if (typeof document === 'undefined') return;
  stopWatch();
  watchTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void workshopController.refreshNeeds();
  }, WORKSHOP_REFRESH_MS);
  watchVisibility = () => {
    if (document.visibilityState === 'visible') void workshopController.refreshNeeds();
  };
  document.addEventListener('visibilitychange', watchVisibility);
}

function stopWatch() {
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
  if (watchVisibility) {
    document.removeEventListener('visibilitychange', watchVisibility);
    watchVisibility = null;
  }
}

/** `?demo=1` on the page's own address reads the demo's answers. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/** The counts read: handed to the one count of votes waiting (#5296). */
async function takeCountsFrom(res: Response | null): Promise<void> {
  if (!res || !res.ok) return;
  takeCountsBody(await res.json().catch(() => null));
}

/** The same, from an answer already parsed. Read only: it may be shared. */
function takeCountsBody(data: any): void {
  if (data && data.counts && typeof data.counts === 'object') takeCounts(data.counts);
}

/** The feed read, or null when it failed. */
async function feedFrom(res: Response | null): Promise<{ feed: NeedsFeedItem[]; capped: boolean } | null> {
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.items)) return null;
  const feed = stripAnswered(data.items as NeedsFeedItem[]);
  return { feed, capped: Number(data.max) > 0 && feed.length >= Number(data.max) };
}

/**
 * The legacy seam, the same shape as `window.UsernodeReact.messages`.
 *
 * `App.navigateToWorkshop()` calls `open()` on the still-hidden root and
 * `_exitWorkshop` calls `close()` on the way out. `open` is not decoration:
 * it is the LIVENESS flag a load checks before it publishes, so a fetch that
 * lands after the viewer has left cannot paint into a page they are no
 * longer on — and cannot race the next entry's own load. The re-entry guard
 * is the router's (see App.navigateToWorkshop), not this flag's.
 */
export const workshopController = {
  open() {
    workshopStore.set({ open: true });
    // #5164: the quiet refresh runs for as long as the page is showing.
    startWatch();
    return workshopController.reload();
  },
  close() {
    workshopStore.set({ open: false });
    answeredVotes.clear();
    stopWatch();
  },
  isOpen() {
    return workshopStore.get().open;
  },
  /**
   * A vote taken back (the review flow's Undo, DELETE /api/sessions/:id/vote):
   * the change is owed again, so it may come back into every read, and the
   * counts and the feed are read again quietly.
   */
  retracted(id: number) {
    for (const key of [...answeredVotes]) {
      if (Number(key.slice('proposal:'.length, key.indexOf('@'))) === id) answeredVotes.delete(key);
    }
    void this.refreshNeeds();
  },
  /**
   * A vote cast in the feed, taken down at once (#4794): the item leaves the
   * store's feed, so leaving and coming back cannot draw it as still owed,
   * and every read until the page closes skips it too.
   */
  answered(id: number, epoch: number | null) {
    answeredVotes.add(answeredVoteKey(id, epoch));
    const state = workshopStore.get();
    if (state.feed) workshopStore.set({ feed: stripAnswered(state.feed) });
  },
  /**
   * #6101: a vote refused because the change had already merged (or left the
   * vote) while this feed was on screen. No epoch is recorded — the id alone
   * matches, so no read at any epoch can draw the card as still owed — and
   * the store's copy loses it at once, then is read again.
   */
  settled(id: number) {
    answeredVotes.add(answeredVoteKey(id, null));
    const state = workshopStore.get();
    if (state.feed) workshopStore.set({ feed: stripAnswered(state.feed) });
    void this.refreshNeeds();
  },
  /**
   * The quiet reload: the counts and the feed again. What is on screen stays
   * until the answers land, and a failed read leaves its half untouched. A
   * read that lands after the viewer left the page publishes nothing.
   */
  async refreshNeeds() {
    if (!workshopStore.get().open) return;
    const demo = demoQuery();
    try {
      // `no-cache` (the #4177 spelling): a quiet read asks for the CURRENT
      // answer, not the worker's saved copy.
      const [countsRes, feedRes] = await Promise.all([
        fetch(`/api/workshop/counts${demo}`, { cache: 'no-cache' }).catch(() => null),
        fetch(`/api/workshop/needs-feed${demo}`, { cache: 'no-cache' }).catch(() => null),
      ]);
      if (!workshopStore.get().open) return;
      await takeCountsFrom(countsRes);
      const read = await feedFrom(feedRes);
      if (!workshopStore.get().open || !read) return;
      workshopStore.set({ feed: read.feed, feedError: false, feedCapped: read.capped });
    } catch {
      // Offline is a state, not a crash: the page keeps what it had.
    }
  },
  async reload() {
    const demo = demoQuery();
    // #5462: RE-ENTRY asks for the current answer, the same spelling
    // refreshNeeds() sends — the store already holding a feed is what says
    // this is not the first read. Without it the worker's boot lane answers
    // a read whose network leg misses its deadline with the saved copy from
    // BEFORE a vote, and the proposal just voted on is drawn as still owed.
    // The FIRST entry keeps the boot lane (#5164): the cold start's fast
    // paint.
    const fresh = workshopStore.get().feed != null;
    const opts = fresh ? { cache: 'no-cache' as const } : undefined;
    let read: { feed: NeedsFeedItem[]; capped: boolean } | null = null;
    try {
      // THE FIRST ENTRY'S COUNTS ARE THE COMMUNITY LIST'S READ TOO (#6591).
      // On a page load that lands here the scope asks the same address in
      // the same moment (./community-scope.ts loadCommunities, from the
      // sidebar and the tab bar), and each sent its own. This read says
      // nothing new happened, so it takes a request already on its way, or
      // lends its own (lib/shared-read.ts: in flight only, nothing kept).
      // A re-entry may follow a vote, so it asks the server itself, as
      // refreshNeeds() does, and so does the feed either way.
      const countsRead: Promise<unknown> = fresh
        ? fetch(`/api/workshop/counts${demo}`, opts)
          .then((res) => (res.ok ? res.json() : null))
        : sharedJson(`/api/workshop/counts${demo}`);
      const [countsBody, feedRes] = await Promise.all([
        countsRead.catch(() => null),
        fetch(`/api/workshop/needs-feed${demo}`, opts).catch(() => null),
      ]);
      takeCountsBody(countsBody);
      read = await feedFrom(feedRes);
    } catch {
      // The feed says it could not load, and offers the read again.
    }
    if (!workshopStore.get().open) return;
    workshopStore.set({ feed: read ? read.feed : [], feedError: !read, feedCapped: read ? read.capped : false });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.workshop = workshopController;
}

/**
 * #5463: a vote the server saved ANYWHERE — in the feed, on the change's own
 * page, from a notification's "Still yes" — reaches the page through the dev
 * board's voteSavedStore, shown or not: `open()` paints the kept store copy,
 * so it has to be right before that paint, not corrected by the read that
 * lands after it. Each new entry takes the card out of the feed, exactly as
 * `answered()` does for a vote cast in the feed. The seq (cards-store.ts)
 * marks what is new, so a re-vote of the same side is seen too.
 */
let savedVoteSeqSeen = 0;
voteSavedStore.subscribe(() => {
  const saved = voteSavedStore.get();
  let seen = savedVoteSeqSeen;
  for (const [id, entry] of Object.entries(saved)) {
    if (!entry || entry.seq <= seen) continue;
    seen = entry.seq;
    workshopController.answered(Number(id), entry.epoch);
  }
  savedVoteSeqSeen = seen;
});

// 11 Nov 2026 (one model): a change whose vote a `work_state` push says
// closed leaves the feed at once (lib/work-state.ts withoutClosedVote), and
// the feed is read again.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(WORK_CHANGED_EVENT, (event) => {
    const state = workshopStore.get();
    const feed = withoutClosedVote(state.feed, (event as CustomEvent).detail);
    if (feed === state.feed) return;
    workshopStore.set({ feed });
    void workshopController.refreshNeeds();
  });
}

// `publishVoteSaved` and `voteSavedStore` are re-exported so the saved-vote
// tests can drive the real publish path against this page's own store.
export { workshopStore, publishVoteSaved, voteSavedStore };
