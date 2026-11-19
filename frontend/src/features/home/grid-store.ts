/**
 * The launcher grid's view model — what `#app-list` is about to hold.
 *
 * ── Why a store rather than props ──────────────────────────────────────
 *
 * `Home.render()` used to build the grid's `innerHTML` and hand it to the
 * element. It now computes THIS — plain data, no markup — and pushes it here;
 * `app-grid.tsx` is the only writer of the DOM below `#app-list`. That split
 * is what makes the grid convertible at all: home.js keeps owning the data
 * (the WS fan-out, the layout fetch, the favourite ordering, the card menus),
 * and React owns the rendering, with nothing writing into the other's half.
 *
 * The store lives in its own module, imports nothing from React, and holds
 * only serialisable values — so tests can drive `Home.render()` in Node and
 * assert on the pushed model without a DOM. That is the same property
 * lib/plain-store.js was written for (see its header) and the reason the
 * placement maths stays in home-layout.js: this file is a shape, not a
 * calculation.
 *
 * ── The initial value IS the pre-conversion markup ────────────────────
 *
 * `ready: false` with no items renders nothing, which is exactly the empty
 * `<div id="app-list">` the hand-written shell shipped and the SSG pass in
 * frontend/scripts/build-shell.mjs prerenders. Anything else here would be a
 * hydration mismatch, and a console error on any route fails proposal checks.
 * Nothing fetches from render — `Home.load()` is still called by app.js's
 * router, exactly as before.
 *
 * ── `dragActive` is not in this store, on purpose ─────────────────────
 *
 * The kit's grid placement physically moves `#app-list`'s children during a
 * lift, which is the one window where React must not reconcile. home.js
 * already had that guard (`Home._dragActive`, set in the kit's `onLift` and
 * cleared in `onSettle`, with `_rerenderPending` flushing afterwards), and it
 * keeps it: `Home.render()` returns early while a drag is live, so no push
 * ever reaches this store mid-gesture. Moving the flag in here would have made
 * it look like React state that a render could depend on, when what it
 * actually guards is the ABSENCE of a render.
 */

import { createStore } from '../../lib/plain-store.js';
import type { BuildLineState } from '../first-session/build-line';

/** Where an item sits on the canvas. `null` = flow after it (overflow items). */
export interface GridPlacement {
  col: number;
  row: number;
  w: number;
  h: number;
}

/** The icon choice, as data — from AppCard.iconViewFor, shared with browse. */
export type IconView =
  | { kind: 'image'; src: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'letter'; letter: string };

/**
 * One app tile's rendered facts. Deliberately flat and pre-decided: every
 * conditional the old template string evaluated inline (`statusLabel`,
 * `showRetry`, the fork name, whether the tile is clickable) is resolved by
 * home.js, where the `App.user` gates and the status vocabulary already live.
 * The component renders; it does not decide.
 */
export interface HomeAppView {
  slug: string;
  name: string;
  status: string;
  icon: IconView;
  locked: boolean;
  demo: boolean;
  /** '' for a running app; otherwise the words shown under the name. */
  statusLabel: string;
  /**
   * #4053: the first version's build line while Homeroom bot makes it
   * (../first-session/build-line.tsx); `statusLabel` holds its tile words.
   */
  buildLine: BuildLineState | null;
  isAwaiting: boolean;
  isError: boolean;
  /** Running and awaiting-secrets tiles open; every other status does not. */
  clickable: boolean;
  /** #416 — creator/collaborator/admin only; the server gates the field. */
  failureReason: string | null;
  showRetry: boolean;
  /** Resolved live name of the app this was forked from, or null. */
  forkName: string | null;
  /** The original app is gone; `forkName` is a placeholder and the badge has its own wording. */
  forkDeleted?: boolean;
  /**
   * Who the project is for (communities; services/communities.js): 'open'
   * (a Public community), 'invited' (a Private community) or 'solo' (Just
   * you). The tile draws a small mark for the last two and none for a public
   * community, which is what most of the grid is.
   */
  audience: 'open' | 'invited' | 'solo';
  /** dapp.json's one sentence about the app; '' when it has none. Drawn by Standard (WIP)'s tile. */
  description?: string;
  /** How many people have contributed to it (GET /api/apps `contributor_count`); zero says nothing. */
  contributors?: number;
  /** How many people are in its community (GET /api/apps `member_count`); zero says nothing. */
  members?: number;
}

/**
 * One placed tile. A single shape rather than a union: since the UI overhaul
 * moved the three widgets out to fixed sections, every item on the launcher
 * canvas is an app.
 */
export type GridItem = { kind: 'card'; placement: GridPlacement | null; app: HomeAppView };

/**
 * The launcher's trailing "Create an app" tile (the prototype's scrHome ends
 * Your apps with it). NOT a `GridItem`: it has no app, no layout entry and no
 * drag. Its cell is derived per paint by HomeLayout.trailingCell — straight
 * after the last tile on screen — so the tile always ends the grid, collapsed
 * or expanded. A collapsed grid whose last shown row is full holds it behind
 * "Show all N apps" rather than drawing a row for it alone (#3047;
 * HomeLayout.createTileCollapsed). `placement` is null when the tile must FLOW instead: after the
 * empty-launcher note, or after overflow tiles that have no cell of their own.
 */
export interface CreateTileView {
  /** Home.canCreate(): creation is available, or the locked treatment. */
  enabled: boolean;
  /** The ask-an-admin sentence the locked tile announces. */
  hint: string;
  /**
   * #4757: a collapsed grid whose last shown row is full holds the tile back
   * (#3047) — heldBack marks that state, and the My apps heading answers it
   * with a compact New project entry (#5825; it rode "Show all N apps"
   * before). False whenever the
   * tile IS the grid's trailing cell, expanded or not.
   */
  heldBack: boolean;
  /**
   * True under Standard (WIP), where New project is a button on the search
   * row (Home.hasSideCard): the grid draws no tile.
   */
  inCard?: boolean;
  placement: GridPlacement | null;
}

export interface HomeGridState {
  /** False until the first `Home.render()` push — see the header. */
  ready: boolean;
  /** Drives `#app-list`'s `data-view`; app.css keys `grid-auto-rows` off it. */
  view: 'grid' | 'search';
  /** `grid-template-rows`, or '' for "let app.css size the rows". */
  rowTemplate: string;
  items: GridItem[];
  /** Search view only: the "N results" line, or null. */
  resultsHeading: string | null;
  /** Search view only: the query that matched nothing, or null. */
  emptyQuery: string | null;
  /**
   * The words the last `Home.render()` judged (trimmed), `''` in the grid
   * view. Home's search is debounced (home.js `_wireSearch`), so this trails
   * the field by about 100 ms: everything that filters beside the grid reads
   * it (./use-home-query.ts `settledQuery`), so no two lists disagree.
   */
  query: string;
  /**
   * A whole-grid message from the LOAD path — offline with an empty cache, or
   * a failed fetch. It is in the model rather than written into `#app-list`
   * because React owns that subtree: an imperative write here would be a
   * second writer, and would be painted straight back over by the next push.
   */
  notice: { text: string; tone: 'muted' | 'error' } | null;
  /**
   * The trailing Create tile, or null: before the first paint (so the
   * prerender and the first client render agree — the tile is data-placed),
   * in the search view, and with a load notice on screen. A collapsed grid
   * whose last shown row is full keeps the view with `heldBack: true` (#4757):
   * app-grid.tsx then draws no tile, and the compact New project entry on the
   * My apps heading stands in for it (#5825).
   */
  create: CreateTileView | null;
  /**
   * EDIT MODE (#4669): the launcher is being arranged. The tiles wiggle, each
   * one shows its remove button, and the trailing tile is "Add apps" rather
   * than "New project". False in the search view even while the flag holds —
   * a search is a transient list, not the shelf — and false in INITIAL_GRID,
   * so the prerendered document is unchanged.
   */
  editing: boolean;
}

export const INITIAL_GRID: HomeGridState = {
  ready: false,
  view: 'grid',
  rowTemplate: '',
  items: [],
  resultsHeading: null,
  emptyQuery: null,
  query: '',
  notice: null,
  create: null,
  editing: false,
};

export const gridStore = createStore<HomeGridState>(INITIAL_GRID);

if (typeof window !== 'undefined') {
  // Published for the same reason every relocated module publishes its global:
  // tests/home-card-menu.test.js and the declared checks reach the shell's
  // pieces by name, and home.js itself is imported by index.tsx rather than
  // importing it back.
  (window as unknown as { HomeGridStore?: unknown }).HomeGridStore = gridStore;
}
