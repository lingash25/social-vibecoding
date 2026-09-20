// The Challenges tab's card parts — ITERATION 03's challenge card, drawn in
// the shell's own tokens rather than the board's.
//
// ── What maps to what ──────────────────────────────────────────────────
//
// The board's cream ground, pastel tiles and hand-picked hexes are not here.
// Its rail blue is the shell accent (`violet-*`, which tailwind.config.js
// remaps to BLUE) at a quarter strength so the label on top stays readable;
// its success green is the emerald every other "completed" mark in the shell
// uses; its reward tan is the amber of the shell's medium-priority chip. No
// hue is added and nothing in tailwind.config.js moved.
//
// ── One card, two surfaces ─────────────────────────────────────────────
//
// `ChallengeCard` below is the whole card, and both places that list
// challenges draw it: the Leaderboard screen's Challenges tab
// (./challenges-pane.tsx) and Home's Challenges block
// (../home/panels/challenges.tsx). They used to be two designs of one thing —
// a white card with a rail here, a tinted card with a count capsule and a
// deadline on Home — and a viewer moving between them read two different
// states for the same challenge. Each surface keeps its own root class
// (`tc-se-card`, `home-challenge-card`) because declared checks and legacy
// hooks select on them; everything inside is this file.
//
// It is not in @/components/ui: it is a domain card, not a primitive.
//
// ── Title, meta line, rail ─────────────────────────────────────────────
//
// Under the title, ONE meta line says when the challenge ends and what it
// pays: "5d left · 500 pts", or "Earned 900 pts" in emerald on a finished
// challenge the viewer scored on. It takes the slot a description would —
// never the task, which the tab's detail overlay carries. Under a group
// header that carries the clock (This week, Always open, Season challenges;
// ./group-header.tsx) the card leaves the deadline to that header and the
// line keeps only the reward; Get started's cards and an ungrouped grid keep it. A
// finished card has nothing to count down to.
//
// The RAIL IS CLEAN: its own full-width row holding the state and nothing
// else — the ring, the label, and for a counted challenge (a target above
// one) a bar drawn from zero, with a stub at the left edge so "0/3 Apps tried"
// reads as a track not yet run. A yes-or-no challenge has no steps to fill and
// keeps its words ("Not started", "Started", "Done").
//
// ── Copy never wraps ───────────────────────────────────────────────────
//
// Every line is one line. A 320px phone leaves the card body about 170px.
// The title truncates; on the meta line the deadline never shrinks (a short
// token — even a season-long "183d left" is about 60px) and the reward
// truncates after it; the rail is the body's
// full width and its label truncates inside it. The labels are composed short
// in ./topochain-challenges.js (`_stateOf`), because the ring already says
// which state it is.
//
// ── The detail page draws the same parts ──────────────────────────────
//
// The Challenges tab's detail page (./challenges-pane.tsx) shows the same
// meta line under its title (`ChallengeMeta`) and the same clean rail, both at
// a larger `size` for a page that is read rather than scanned. Only the size
// differs; the words, tones and rules are these.
//
// Every class below is a complete literal: Tailwind's extractor is a regex
// over source text, so a computed class name never compiles.

import { useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';

import { IconTile } from '@/components/ui/icon-tile';
import { CheckIcon } from '@/components/ui/icons';
import { resolveIllustration } from '../../lib/challenge-illustrations';

export type ChallengeState = 'new' | 'progress' | 'done';

export type PartSize = 'md' | 'lg';

// `md` is the card's 36px rail; `lg` the detail page's 40px rail with 15px copy.
// The card's rail has the tile's 11px corners (see CARD below); the page's
// rail sits on no card, so it keeps its own 12px.
const RAIL = 'relative flex w-full min-w-0 items-center gap-1.5 overflow-hidden font-medium';
const RAIL_SIZE: Record<PartSize, string> = {
  md: 'h-9 rounded-[0.6875rem] px-2.5 text-[0.8125rem]',
  lg: 'h-10 rounded-[0.75rem] px-3 text-[0.9375rem]',
};
const RAIL_TONE: Record<ChallengeState, string> = {
  new: 'bg-zinc-200/70 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-300',
  progress: 'bg-zinc-200/70 text-zinc-900 dark:bg-zinc-700/60 dark:text-zinc-100',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};
const RAIL_FILL = 'absolute inset-y-0 left-0 bg-violet-500/25';
// The least a drawn bar ever is: 6px against the rail's left edge, inside its
// 10px padding, so it sits clear of the state ring. It is the whole bar at 0
// of N, and the floor under a small real fraction — 1 of 50 is 2%, about 3px
// on a phone, and a first step must never look like less than none.
const RAIL_STUB = '0.375rem';
const RAIL_LABEL = 'relative min-w-0 truncate';

const TITLE = 'truncate text-base font-medium leading-6 text-zinc-900 dark:text-zinc-100';
const META: Record<PartSize, string> = {
  md: 'flex min-w-0 items-baseline gap-1.5 text-[0.8125rem] leading-5',
  lg: 'flex min-w-0 items-baseline gap-1.5 text-sm leading-5',
};
const META_DEADLINE = 'shrink-0 text-zinc-500 dark:text-zinc-400';
const META_DOT = 'shrink-0 text-zinc-400 dark:text-zinc-500';
const META_REWARD = 'min-w-0 truncate font-medium text-amber-800 dark:text-amber-300';
const META_EARNED = 'min-w-0 truncate font-medium text-emerald-700 dark:text-emerald-400';
// The artwork's face: whatever `--tint-art` the registry's tone class sets.
// The `dark:` twin is not a second colour — the tone class already switches
// the property in dark mode — it is what displaces IconTile's own
// `dark:bg-zinc-800`, because tailwind-merge replaces a class only within its
// variant.
const TILE_ART = 'bg-[var(--tint-art)] dark:bg-[var(--tint-art)]';
// The tile's 11px corners, concentric inside the card's 24px (CARD below).
// Passed through `className` on both faces, where tailwind-merge displaces the
// xl size's own `rounded-2xl` rather than layering a second radius on it.
const TILE_RADIUS = 'rounded-[0.6875rem]';


// The three state marks. The board draws an empty ring, a dashed ring and a
// ringed check; the first two are borders rather than glyphs, so the icon
// set gains nothing it would have to keep out of the prerender.
function StateMark({ state }: { state: ChallengeState }): ReactNode {
  if (state === 'done') {
    return (
      <span aria-hidden="true" className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-current">
        <CheckIcon className="h-2.5 w-2.5" strokeWidth="3" />
      </span>
    );
  }
  if (state === 'progress') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0 rounded-full border-2 border-dashed border-violet-600 dark:border-violet-400" />
    );
  }
  return <span aria-hidden="true" className="relative h-4 w-4 shrink-0 rounded-full border-2 border-current" />;
}

// The rail. Always a progressbar to assistive tech; `aria-valuenow` only
// when the fill is a real number — an indeterminate rail says so by leaving
// it out, which is what the ARIA pattern means by indeterminate.
//
// EVERY RAIL CARRIES A WORD. `label` is required and never empty: every
// branch of _stateOf returns one ('Done', 'Started', 'Not started', 'N/T
// unit'). Block production used to be the exception — an empty label drew
// the ring alone, for a challenge whose count this screen could not see —
// and the result was a dot with nothing beside it (#2492). Its count now
// rides on the challenge row, so the exception is gone and the label span
// and `aria-valuetext` are unconditional; a dapp.json check on the tab
// holds them that way.
//
// `counted` is what draws the bar: a challenge with a target above one,
// from 0 of N (the stub) up to one short of done. A finished rail is the
// green tone instead, and an uncounted one is words alone.
export function ProgressRail({ state, label, fill, name, counted = false, size = 'md' }: {
  state: ChallengeState;
  label: string;
  fill: number | null;
  name: string;
  counted?: boolean;
  size?: PartSize;
}): ReactNode {
  const pct = fill == null ? null : Math.round(Math.max(0, Math.min(fill, 1)) * 100);
  const bar = counted && state !== 'done' && pct != null;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : pct}
      // The spoken value is the visible one: a rounded percent says 0% at
      // 1/500 and 100% at 499/500.
      aria-valuetext={label}
      aria-label={name ? `${name}: ${label}` : label}
      className={`${RAIL} ${RAIL_SIZE[size]} ${RAIL_TONE[state]}`}
    >
      {bar ? <span className={RAIL_FILL} style={{ width: pct ? `max(${RAIL_STUB}, ${pct}%)` : RAIL_STUB }} /> : null}
      <StateMark state={state} />
      <span className={RAIL_LABEL}>{label}</span>
    </div>
  );
}

// The meta line: "5d left · 500 pts". `text` is the amount — the reward on
// offer, or with `earned` what the viewer earned, in emerald. Nothing to say
// is no line at all, never a stray dot.
export function ChallengeMeta({ deadline = null, text = null, earned = false, size = 'md' }: {
  deadline?: string | null;
  text?: string | null;
  earned?: boolean;
  size?: PartSize;
}): ReactNode {
  if (!deadline && !text) return null;
  return (
    <div className={META[size]}>
      {deadline ? <span className={META_DEADLINE}>{deadline}</span> : null}
      {deadline && text ? <span aria-hidden="true" className={META_DOT}>·</span> : null}
      {text ? <span className={earned ? META_EARNED : META_REWARD}>{text}</span> : null}
    </div>
  );
}

// The 5rem artwork tile. A challenge whose template names an illustration
// the registry resolves (../../lib/challenge-illustrations.ts: a built-in by
// MEMBERSHIP, or an admin upload by its `u-` slug) draws that artwork on its
// pale harmonic tone. A built-in brings its own tone; an upload's is
// `illustrationTone` from the payload, which the registry honours only when it
// is one of its TONES and otherwise draws on gray. The same file serves both
// themes, on the tone's dark surface; there is no dark copy.
//
// An upload need not be square, so the image is `object-contain`: a wide or
// tall one fits inside the 64px art box on its tone rather than stretching.
//
// Anything else is the tile as it was: a neutral face holding the challenge
// kind's icon when the payload carries one (both surfaces do, from
// `challenge_kinds.icon`) and empty otherwise. That includes artwork that
// fails to load. The service worker leaves both image paths to the network, so
// offline the image errors, and the error puts back the tile it replaced
// rather than a broken-image glyph on a tone. It is component state, not a
// write to the node: the card is a React island.
//
// It never holds the category: headings name it, and a category word in an
// 80px square was the "ONBOARDIN / G" break on both surfaces.
export function ChallengeTile({ icon = null, illustration = null, illustrationTone = null }: {
  icon?: string | null;
  illustration?: string | null;
  illustrationTone?: string | null;
}): ReactNode {
  const art = resolveIllustration(illustration, illustrationTone);
  // Keyed by the file rather than a flag, so a tile handed a different
  // illustration tries that one instead of inheriting the last failure.
  const [failed, setFailed] = useState<string | null>(null);
  if (art && failed !== art.src) {
    return (
      <IconTile size="xl" aria-hidden="true" className={`${art.toneClass} ${TILE_ART} ${TILE_RADIUS}`}>
        <img src={art.src} alt="" draggable={false} className="object-contain" onError={() => setFailed(art.src)} />
      </IconTile>
    );
  }
  return (
    <IconTile size="xl" aria-hidden="true" className={TILE_RADIUS}>
      {icon ? <span className="text-[2.5rem] leading-none">{icon}</span> : null}
    </IconTile>
  );
}

export type ChallengeCardView = {
  goal: string;
  reward: string | null;
  icon?: string | null;
  /** The template's illustration slug; the tile draws it when the registry resolves it. */
  illustration?: string | null;
  /** An uploaded illustration's tone (shape-checked); built-ins ignore it. */
  illustrationTone?: string | null;
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  /** A target above one: the rail draws a bar, from zero. */
  counted?: boolean;
  /** "5d left"; null on a finished card or with no end in the future. */
  deadline?: string | null;
  earned: string | null;
};

// The corners are concentric: the card's 24px (`rounded-3xl`, 1.5rem in
// tailwind.config.js) less its 12px padding and 1px border is the 11px the
// tile and the rail take (TILE_RADIUS, RAIL_SIZE.md), so the inner shapes
// follow the outer one instead of looking pinched inside it.
// The FACE — the ground, the hairline, the 24px corners, the 12px padding and
// the three-column layout, and nothing that implies the card can be pressed.
// Exported because the Challenges tab's loading placeholder
// (./challenges-pane.tsx) stands in for a card and must draw the card's own
// geometry rather than a second copy of it, which goes wrong silently the
// first time this line moves. A placeholder is not pressable, so the
// affordances below are deliberately NOT part of it.
export const CHALLENGE_CARD_FACE = 'flex items-center gap-3 bg-white dark:bg-zinc-900 rounded-3xl '
  + 'border border-zinc-200 dark:border-zinc-800 p-3';
const CARD = CHALLENGE_CARD_FACE
  + ' cursor-pointer hover:border-violet-400 dark:hover:border-violet-600 transition-colors';

// The card: tile, then title, the meta line ("5d left · 500 pts") and the
// rail — nothing else. The task is not on the card (the tab's detail overlay
// carries it in full).
//
// TITLE AND RAIL ARE ONE GROUP. The title and its meta line sit 8px above the
// rail and the whole group is centred against the tile as a unit, rather than
// stretched to the tile's top and bottom edges: the title belongs to its
// rail, not to the illustration beside it. With a meta line the group is 88px
// against the 80px tile, without one 68px, at every width — nothing in it
// wraps.
//
// A card that opens something IS a button (#1918): role="button", in the tab
// order, and Enter/Space open it like a click. The role is also what gives a
// tap its feedback — the native kit scales and dims every [role="button"] on
// press, the same press the Dev board's rows and the session rows give — so
// the card no longer sits unchanged under a finger until the page swaps. On
// touch that press waits a beat (app.css), so a scroll that starts on a card
// does not flash it. A card with no onClick stays a plain, inert div.
export function ChallengeCard({ view, className, onClick, onKeyDown, ...rest }: {
  view: ChallengeCardView;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>): ReactNode {
  const reward = view.earned || view.reward;
  const pressable = onClick
    ? {
      role: 'button',
      tabIndex: 0,
      onClick,
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.currentTarget.click();
        }
      },
    }
    : { onKeyDown };
  return (
    <div className={className ? `${className} ${CARD}` : CARD} {...pressable} {...rest}>
      <ChallengeTile icon={view.icon} illustration={view.illustration} illustrationTone={view.illustrationTone} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <div className={TITLE}>{view.goal}</div>
          <ChallengeMeta deadline={view.deadline} text={reward} earned={!!view.earned} />
        </div>
        <ProgressRail
          state={view.state}
          label={view.stateLabel}
          fill={view.fill}
          name={view.goal}
          counted={!!view.counted}
        />
      </div>
    </div>
  );
}
