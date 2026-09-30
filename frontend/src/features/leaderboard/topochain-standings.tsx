/**
 * The Topochain standings pane — `#topochain-leaderboard-root` (#1191 slice 6,
 * conversion 5, the first of the Leaderboard screen's three panes).
 *
 * The only writer of the DOM below that root. ./topochain-leaderboard.js still
 * owns everything that makes this pane WORK — the four public `/api/v4` reads,
 * the event-context subscription, the staleness guards, the page cursor, the
 * season-vs-event column decision — and hands over two descriptors,
 * `bodyView()` and `drillView()`. This file spells them as markup, class string
 * for class string.
 *
 * ── The table's columns ────────────────────────────────────────────────
 *
 * `view.columns` drives BOTH the header row and every body row, so the season
 * board (which drops "Success rate", #999) cannot skew: a column that is not in
 * that list produces neither a `<th>` nor a `<td>`. The string version spelled
 * the two out separately behind matching `isSeason ? '' : …` conditionals, and
 * tests/standings-screen.test.js counted the tags to catch exactly the case
 * where one of the two was edited and the other was not.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `mounted: false` renders NOTHING — not the pane's two hosts, not a loading
 * line. That is the prerender contract: the hand-written shell shipped
 * `#topochain-leaderboard-root` empty, because `_renderShell()` wrote its
 * interior on the section's first open. The SSG pass in
 * frontend/scripts/build-shell.mjs reproduces the empty root, and the store's
 * initial value is what makes it do so.
 */

import type { ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useStoreState } from '../../lib/use-store-state';
import { topochainStandingsStore } from './topochain-standings-store.js';

type ColumnKey = 'rank' | 'user' | 'points' | 'blocks' | 'success';

type RowView = {
  index: number;
  rank: string;
  nonPodium: boolean;
  user: string;
  points: string;
  extra: string;
  blocks: string;
  success: string;
};

type BodyView =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'empty'; message: string }
  | { state: 'none' }
  | { state: 'private'; disclaimer: string | null }
  | {
      state: 'noentries';
      challengeLine: { done: string | null; total: string } | null;
      disclaimer: string | null;
    }
  | {
      state: 'table';
      challengeLine: { done: string | null; total: string } | null;
      disclaimer: string | null;
      isSeason: boolean;
      columns: ColumnKey[];
      headers: Record<ColumnKey, string>;
      rows: RowView[];
      pagination: {
        page: number;
        totalPages: number;
        total: number;
        prevDisabled: boolean;
        nextDisabled: boolean;
      } | null;
    };

type Triple = { loading: boolean; error: string | null };

type DrillView = {
  displayName: string;
  walletAddress: string | null;
  profile: Triple & {
    shown: boolean;
    stats: {
      rank: string;
      totalPoints: string;
      producedBlocks: string;
      clientSuccessRate: string | null;
      canonicalSuccessRate: string | null;
    } | null;
  };
  activities: Triple & { items: { label: string; points: string }[] | null };
  epoch: Triple & {
    rows: { epoch: string; wonSlots: string; produced: string; successRate: string }[] | null;
  };
};

const controller = () => (window as any).TopochainLeaderboard;

/** Every column's alignment, so the head and the body cannot disagree. */
const ALIGN: Record<ColumnKey, string> = {
  rank: 'text-left',
  user: 'text-left',
  points: 'text-right',
  blocks: 'text-right',
  success: 'text-right',
};

const HINT = 'text-sm text-zinc-500 py-8 text-center dark:text-zinc-400';

function Disclaimer({ text }: { text: string | null }): ReactNode {
  if (!text) return null;
  return <p id="tc-lb-disclaimer" className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">{text}</p>;
}

/**
 * The #981 cross-link. `_goToChallenges` is still the module's — real hash
 * navigation, so the section switch goes through the router and the shared
 * event selection survives it.
 */
function ChallengeLine(
  { line }: { line: { done: string | null; total: string } | null },
): ReactNode {
  if (!line) return null;
  return (
    <p id="tc-lb-challenge-link" className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
      {/* The tally is the VIEWER's, and a signed-out reader has none — then
          the cross-link stands on its own rather than carrying a zero that
          reads as theirs. "done" is the word Home uses for this same number;
          the two must not drift apart again. */}
      {line.done == null ? null : `${line.done} of ${line.total} challenges done `}
      {/* QA 2026-09-24 Q32c: a space after the dot as well as before it,
          inside the span rather than as a whitespace-only child (React
          #418, see notifications-list.tsx). */}
      <span className="text-zinc-500 dark:text-zinc-500">{'· '}</span>
      <button
        id="tc-lb-to-challenges"
        className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
        onClick={() => controller()?._goToChallenges()}
      >
        View challenges →
      </button>
    </p>
  );
}

function Cell({ column, row }: { column: ColumnKey; row: RowView }): ReactNode {
  if (column === 'rank') {
    return <td className="px-3 py-2 text-sm font-mono text-zinc-500 dark:text-zinc-400">{row.rank}</td>;
  }
  if (column === 'user') {
    return (
      <td className="px-3 py-2 text-sm">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.user}</span>
        {row.nonPodium ? (
          <span
            className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400"
            title="Excluded from podium ranking"
          >{' non-podium'}</span>
        ) : null}
      </td>
    );
  }
  if (column === 'points') {
    return (
      <td className="px-3 py-2 text-sm font-mono text-right">
        {row.points}
        <span className="text-zinc-500 dark:text-zinc-400">{` +${row.extra}`}</span>
      </td>
    );
  }
  if (column === 'blocks') {
    return <td className="px-3 py-2 text-sm font-mono text-right">{row.blocks}</td>;
  }
  return <td className="px-3 py-2 text-sm font-mono text-right">{`${row.success}%`}</td>;
}

function StandingsTable(
  { view }: { view: Extract<BodyView, { state: 'table' }> },
): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full">
        <thead className="bg-zinc-50 dark:bg-zinc-900 text-[0.9375rem] text-zinc-500 dark:text-zinc-400">
          <tr>
            {view.columns.map((c) => (
              <th key={c} className={`px-3 py-2 ${ALIGN[c]}`}>{view.headers[c]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* A row stays a table row (no role override, so the cells keep
              their column headers) but takes focus and opens on Enter or
              Space, as the Kudos rows do. The label says what it opens. */}
          {view.rows.map((row) => (
            <tr
              key={row.index}
              className="tc-lb-row border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800/60"
              data-row-index={row.index}
              tabIndex={0}
              aria-label={`Open ${row.user}'s details`}
              onClick={() => controller()?._openRowAt(row.index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  controller()?._openRowAt(row.index);
                }
              }}
            >
              {view.columns.map((c) => <Cell key={c} column={c} row={row} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination(
  { meta }: { meta: Extract<BodyView, { state: 'table' }>['pagination'] },
): ReactNode {
  if (!meta) return null;
  const btn = 'rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium disabled:opacity-40';
  return (
    <div className="flex items-center justify-between mt-3 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">
        {`Page ${meta.page} of ${meta.totalPages} · ${meta.total} total`}
      </span>
      <div className="flex gap-2">
        <button
          id="tc-lb-prev"
          className={btn}
          disabled={meta.prevDisabled}
          onClick={() => controller()?._prevPage()}
        >
          Prev
        </button>
        <button
          id="tc-lb-next"
          className={btn}
          disabled={meta.nextDisabled}
          onClick={() => controller()?._nextPage()}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * The standings' loading state, at the TABLE's own shape.
 *
 * This was the pane the bare `#leaderboard` address landed on until #2374
 * made Challenges the default, so it was the first thing the screen showed —
 * and it was the word "Loading…" on an otherwise blank panel.
 *
 * The container is the table's own (`rounded-lg` + the hairline), with a
 * header strip in the same `bg-zinc-50` the real `<thead>` uses, so the table
 * arrives INSIDE an outline that is already the right size rather than
 * replacing a line of text.
 *
 * Four columns rather than `view.columns.length`, because the columns are not
 * known until the payload that is still in flight arrives — the one thing a
 * skeleton for this table genuinely cannot predict. Four is what every event
 * type draws at minimum (rank, who, and two figures), and the cells are
 * proportional so a fifth arriving does not shift the row heights.
 */
function StandingsSkeleton(): ReactNode {
  return (
    <SkeletonGroup
      label="Loading the standings"
      className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
    >
      <div className="bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5 flex items-center gap-3">
        <Skeleton shape="muted" className="w-8" />
        <Skeleton shape="muted" className="w-20" />
        <Skeleton shape="muted" className="ml-auto w-12" />
        <Skeleton shape="muted" className="w-12" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="border-t border-zinc-100 dark:border-zinc-800 px-3 py-2.5 flex items-center gap-3"
        >
          <Skeleton shape="muted" className="w-4" />
          <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
          <Skeleton shape="muted" className="ml-auto w-10" />
          <Skeleton shape="muted" className="w-14" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

function Body({ view }: { view: BodyView | null }): ReactNode {
  if (!view || view.state === 'loading') return <StandingsSkeleton />;
  if (view.state === 'error') {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
        {view.message}
      </div>
    );
  }
  if (view.state === 'empty') return <p className={HINT}>{view.message}</p>;
  if (view.state === 'none') return <p className="text-sm text-zinc-500 dark:text-zinc-400">No data.</p>;
  if (view.state === 'private') {
    return (
      <>
        <Disclaimer text={view.disclaimer} />
        <p className={HINT}>The leaderboard for this event isn't public yet.</p>
      </>
    );
  }
  if (view.state === 'noentries') {
    return (
      <>
        <ChallengeLine line={view.challengeLine} />
        <Disclaimer text={view.disclaimer} />
        {/* data-tc-lb-empty marks the LEGITIMATE no-scores state for the
            dapp.json standings checks: a fresh season has an empty
            leaderboard, and the checks accept "table or this hint" while
            still rejecting the red error state. */}
        <p className={HINT} data-tc-lb-empty="">No leaderboard entries yet.</p>
      </>
    );
  }
  return (
    <>
      <ChallengeLine line={view.challengeLine} />
      <Disclaimer text={view.disclaimer} />
      <StandingsTable view={view} />
      <Pagination meta={view.pagination} />
    </>
  );
}

function Activities({ view }: { view: DrillView['activities'] }): ReactNode {
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading activities…</p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.items || !view.items.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">No activities recorded for this event.</p>;
  }
  return (
    <ul className="space-y-1">
      {view.items.map((a, i) => (
        <li key={i} className="flex items-center justify-between gap-3 text-xs">
          <span className="text-zinc-600 dark:text-zinc-300">{a.label}</span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400">{`+${a.points}`}</span>
        </li>
      ))}
    </ul>
  );
}

function EpochBreakdown({ view }: { view: DrillView['epoch'] }): ReactNode {
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading epoch breakdown…</p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.rows || !view.rows.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">No epoch data for this event.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="text-left py-1">Epoch</th>
            <th className="text-right py-1">Won slots</th>
            <th className="text-right py-1">Produced</th>
            <th className="text-right py-1">Success rate</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((e, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-1 font-mono">{e.epoch}</td>
              <td className="py-1 font-mono text-right">{e.wonSlots}</td>
              <td className="py-1 font-mono text-right">{e.produced}</td>
              <td className="py-1 font-mono text-right">{`${e.successRate}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="font-mono">{value}</div>
    </div>
  );
}

function Profile({ view }: { view: DrillView['profile'] }): ReactNode {
  if (!view.shown) return null;
  let inner: ReactNode;
  if (view.loading) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading your profile…</p>;
  } else if (view.error) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  } else if (view.stats) {
    const s = view.stats;
    inner = (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <ProfileStat label="Rank" value={s.rank} />
        <ProfileStat label="Total points" value={s.totalPoints} />
        <ProfileStat label="Produced blocks" value={s.producedBlocks} />
        <ProfileStat
          label="Client success rate"
          value={s.clientSuccessRate == null ? '—' : `${s.clientSuccessRate}%`}
        />
        <ProfileStat
          label="Canonical success rate"
          value={s.canonicalSuccessRate == null ? '—' : `${s.canonicalSuccessRate}%`}
        />
      </div>
    );
  } else {
    inner = null;
  }
  return (
    <div className="mb-4">
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">Your profile</div>
      {inner}
    </div>
  );
}

function Drill({ view }: { view: DrillView | null }): ReactNode {
  // `hidden` is part of the rendered class string here rather than a legacy
  // `classList` toggle, because this whole subtree is React's — the pane's
  // module no longer touches the node at all.
  if (!view) return <div id="tc-lb-drill" className="hidden mt-4" />;
  return (
    <div id="tc-lb-drill" className="mt-4">
      <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {view.displayName}
          </h3>
          <button
            id="tc-lb-drill-close"
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none dark:text-zinc-400"
            aria-label="Close"
            onClick={() => controller()?._closeDrill()}
          >
            ×
          </button>
        </div>
        {view.walletAddress ? (
          <p className="text-xs font-mono text-zinc-500 mb-3 break-all dark:text-zinc-400">{view.walletAddress}</p>
        ) : null}
        <Profile view={view.profile} />
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">Activities</div>
            <Activities view={view.activities} />
          </div>
          <div>
            <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">Epoch breakdown</div>
            <EpochBreakdown view={view.epoch} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TopochainStandingsPane(): ReactNode {
  const state = useStoreState(topochainStandingsStore) as {
    mounted: boolean;
    body: BodyView | null;
    drill: DrillView | null;
  };
  if (!state.mounted) return null;
  return (
    <>
      <div id="tc-lb-body"><Body view={state.body} /></div>
      <Drill view={state.drill} />
    </>
  );
}
