/**
 * The Dev board card — every band of it — rendered from a `DevCardModel`.
 *
 * ── Where the vocabulary lives ────────────────────────────────────────
 *
 * Everything here renders RESOLVED data (see ./model.ts): the icon arrives
 * as tint classes and an SVG path, a chip as its label and tint, an action
 * as its class string. The tables and derivations stay in app-view.js —
 * which Tailwind's extractor also scans, so the class literals compile from
 * where they already were. The few literals this file does own (the shell
 * geometry, the pencil, the grip, the eye) are the ones `_cardContentHtml`
 * and its siblings owned before the conversion, moved with the markup.
 *
 * ── The seams that stay legacy-owned ──────────────────────────────────
 *
 * - **The kudos slot.** `<span data-kudos-host>` is rendered ONCE, empty,
 *   with a constant className; `AppView._fillKudosHosts` writes
 *   `Kudos.renderButton`'s markup into it after every publish and
 *   `Kudos.attach`/`_refreshButton`/`_renderPopover` keep writing inside.
 *   React never looks in — the controller-host seam AGENTS.md documents.
 * - **The feed's inline-comments slot.** `.dev-feed-comments` ships empty
 *   and `AppView._fillFeedComments` innerHTMLs it when the row scrolls
 *   into view.
 * - **The ⋯ trigger's `aria-expanded`.** `_openCardMenu` sets and removes
 *   it at open/close. React renders the attribute never, so a reconcile
 *   cannot stomp it.
 * - **The title editor's error line and disabled state.** `saveIssueTitle`
 *   writes `#dev-issue-title-error` and disables the input by id, exactly
 *   as it did against the innerHTML editor.
 *
 * ── The countdown pill ticks from a store ─────────────────────────────
 *
 * `statusPillHtml` baked "Goes live in ~2h" into the string and a 30s module
 * interval rewrote the label in place. The model still carries the baked
 * label (so the first paint needs no store), plus the window's epoch; the
 * module interval now publishes `Date.now()` through `cardNowStore` and
 * every pill with a `countdown` re-derives its label here. `fmtCountdown`
 * is transcribed from `AppView._fmtCountdown` — this bundle cannot import
 * a classic script — and tests/dev-status-pill.test.js reads both ends.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { Bars3Icon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, Glyph, PencilSquareIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useStoreState } from '../../../lib/use-store-state';
import { cardTintClass } from '../../home/panels/ui';
import { aiEnabledStore, cardNowStore } from './cards-store';
import type {
  ActionRef,
  ActionSpec,
  BadgeSpec,
  CardIconSpec,
  DevCardModel,
  ExtraSpec,
  MetaPart,
  PreviewSpec,
  RailSpec,
  StatusPillState,
  TitleSpec,
} from './model';

/** Layout-timed on the client; a no-op under the server renderer, warning-free. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Dispatch a named call back into app-view.js. Unknown names are a no-op. */
function call(ref: ActionRef | undefined, node?: HTMLElement): void {
  if (!ref) return;
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  const fn = av && av[ref.fn];
  if (typeof fn !== 'function') return;
  const args: unknown[] = [...(ref.args || [])];
  if (node) args.push(node);
  fn.apply(av, args);
}

/**
 * `AppView.voteFillWidths`, transcribed (see the header): how wide each
 * side's bar is, as a percentage of the pill.
 *
 * Yes grows from the left, No from the right (app.css), both full height, so
 * the gap between them is what is still undecided. Each side is its share of
 * the majority threshold, and where those two shares would CROSS both are
 * scaled by the same factor, so the bars meet instead of overlapping —
 * which keeps the ratio between them true rather than painting one over the
 * other.
 */
export function voteFillWidths(yes: number, no: number, majority: number): { yes: number; no: number } {
  const maj = majority > 0 ? majority : 1;
  let y = Math.min(100, (Math.max(yes, 0) / maj) * 100);
  let n = Math.min(100, (Math.max(no, 0) / maj) * 100);
  const total = y + n;
  if (total > 100) {
    y = (y / total) * 100;
    n = (n / total) * 100;
  }
  return { yes: y, no: n };
}

/**
 * `AppView._fmtCountdown`, transcribed (see the header): two-unit,
 * floor-rounded — ~Xd Yh above a day, ~Xh Ym above an hour, ~Xm below.
 */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  if (d >= 1) {
    const h = Math.floor((s % 86400) / 3600);
    return h >= 1 ? `~${d}d ${h}h` : `~${d}d`;
  }
  const h = Math.floor(s / 3600);
  if (h >= 1) {
    const m = Math.floor((s % 3600) / 60);
    return m >= 1 ? `~${h}h ${m}m` : `~${h}h`;
  }
  const m = Math.max(1, Math.floor(s / 60));
  return `~${m}m`;
}

/** A vote still being taken: the tally tiers, before either side has won. */
function isOpenVote(s: StatusPillState): boolean {
  return (s.key === 'needs_vote' || s.key === 'tally') && s.tone === 'progress';
}

/** The in-flight arc — `.dc-status-spinner-arc` everywhere on the platform. */
function Spinner(): ReactNode {
  return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
}

/**
 * The per-type icon (`_devCardIcon`'s markup).
 *
 * On a board card it draws as an 18px GLYPH in the type's colour, not the
 * 36px tinted tile it used to be: app.css's `.dev-card-dense .dev-card-icon`
 * strips the tile's box and fill, so the only thing on the card's left edge
 * is the glyph and every line of the card starts at one x. The tile's
 * classes stay in the markup — the tint utilities still carry the glyph's
 * colour, and `rounded-lg` is what a declared check finds the head by.
 *
 * `<Glyph>` rather than a named icon: the path comes out of app-view.js's
 * `DEV_CARD_ICONS` table at render time, which is exactly the case the
 * escape hatch exists for (see @/components/ui/icons.tsx).
 */
export function CardIcon({ spec }: { spec: CardIconSpec }): ReactNode {
  const box = spec.small ? 'w-7 h-7' : 'w-9 h-9';
  const glyph = spec.small ? 'w-4 h-4' : 'w-5 h-5';
  return (
    <span
      className={`${box} rounded-lg dev-card-icon ${spec.tint} flex items-center justify-center shrink-0${spec.pulse ? ' animate-pulse' : ''}`}
      title={spec.title}
    >
      <Glyph className={glyph} d={spec.path} aria-hidden="true" />
    </span>
  );
}

/** The tap-through chevron (`DEV_CARD_CHEVRON`). */
export function Chevron(): ReactNode {
  return <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" />;
}

/**
 * The composite status pill (`statusPillHtml`'s markup). The derived STATE
 * stays `AppView.statusPillState`'s; this only draws it.
 */
export function StatusPill({ s, inline }: { s: StatusPillState; inline?: boolean }): ReactNode {
  const { now } = useStoreState(cardNowStore);
  if (!s || !s.label) return null;
  let fills: ReactNode = null;
  const fullFill = (side: 'yes' | 'no') => (
    <span className={`gc-vote-fill gc-vote-fill-full gc-vote-fill-full-${side}`}></span>
  );
  if (s.fill === 'full-yes') {
    fills = fullFill('yes');
  } else if (s.fill === 'full-no') {
    fills = fullFill('no');
  } else if (s.fill) {
    const maj = s.majority || 1;
    if (s.yes >= maj) {
      fills = fullFill('yes');
    } else if (s.no >= maj) {
      fills = fullFill('no');
    } else {
      const w = voteFillWidths(s.yes, s.no, maj);
      fills = (
        <>
          <span className="gc-vote-fill gc-vote-fill-yes" style={{ width: `${w.yes}%` }}></span>
          <span className="gc-vote-fill gc-vote-fill-no" style={{ width: `${w.no}%` }}></span>
        </>
      );
    }
  }
  // The 30s tick: re-derive the countdown label from the store's `now`;
  // before the first tick the baked label carries the paint.
  const label = s.countdown && now > 0
    ? `${s.reject ? 'Set aside' : 'Goes live'} in ${fmtCountdown(s.countdown - now)}${s.suffix || ''}`
    : s.label;
  const extra = Array.isArray(s.reasons) ? Math.max(0, s.reasons.length - 1) : 0;
  const titleParts: string[] = [];
  if (s.title) titleParts.push(s.title);
  else if (s.reasons && s.reasons[0]) titleParts.push(s.reasons[0].detail);
  if (s.tier === 2 && extra > 0) {
    titleParts.push(`and ${extra} more reason${extra === 1 ? '' : 's'}, open for details`);
  }
  const cd = s.countdown ? (s.reject ? ' gc-reject-countdown' : ' gc-merge-countdown') : '';
  // An OPEN vote is the bar's own tone on a board card — accent blue, with an
  // accent fill — where the tier's `progress` violet is kept for the merge
  // pipeline. app.css keys `.dev-status-pill-vote`; edgeFor mirrors the rule.
  const vote = !inline && isOpenVote(s) ? ' dev-status-pill-vote' : '';
  const block = inline ? '' : ' dev-status-pill-block';
  return (
    <span
      className={`gc-vote-count gc-vote-count-${s.tone} dev-status-pill${block}${vote}${cd}`}
      data-window-ends={s.countdown ? String(s.countdown) : undefined}
      data-label-suffix={s.countdown && s.suffix ? s.suffix : undefined}
      title={titleParts.length ? titleParts.join(' · ') : undefined}
    >
      {fills}
      <span className="gc-vote-count-label">
        {s.dot ? (
          <span className="gc-vote-count-dot"><span className="gc-vote-count-dot-ping"></span><span className="gc-vote-count-dot-core"></span></span>
        ) : null}
        {s.spinner ? <Spinner /> : null}
        {label}
        {s.advisory > 0 ? (
          <span
            className="gc-vote-count-suffix"
            title={`${s.advisory} advisory vote${s.advisory === 1 ? '' : 's'} from non-approvers, so they don't count toward merging`}
          >{`+${s.advisory}`}</span>
        ) : null}
        {s.lock ? (
          <span
            className="gc-vote-count-lock"
            aria-hidden="true"
            title="This changes who can administer the app, so it won’t merge on a timer: it needs real Yes votes to reach the app’s normal threshold."
          >{'\u{1F512}'}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The Preview affordance in its three states (`cardPreviewHtml`'s markup).
 *
 * The labelled form (`iconOnly: false`) is a pill with the eye AND the word:
 * it is what the board card shows now, at the right end of its action band,
 * because a 24px eye in the corner was the hardest thing on the card to hit.
 * The icon-only form is kept for the group-chat rows that still ask for it.
 *
 * #2585: the BUILDING state is the same pill as the live one, in gray and
 * disabled, so the slot keeps its box and the card does not shift when the
 * build finishes and the pill becomes the real Preview button. (The
 * unavailable state is still a chip — it is a dead end, not a control that
 * is about to arrive.)
 */
export function Preview({ spec }: { spec: PreviewSpec }): ReactNode {
  if (spec.state === 'live') {
    return (
      <button
        type="button"
        className={`gc-vote-btn gc-vote-btn-preview${spec.iconOnly ? ' gc-vote-btn-icon' : ''}`}
        aria-label="Open preview"
        title={spec.title}
        onClick={() => call({ fn: 'swapToStagingForSession', args: [spec.sessionId, spec.url] })}
      >
        {spec.iconOnly ? <EyeIcon aria-hidden="true" /> : <><EyeIcon aria-hidden="true" />{'Preview'}</>}
      </button>
    );
  }
  if (spec.state === 'building') {
    if (!spec.iconOnly) {
      // #2585: a PILL, not a bare badge floating in the band. It wears the
      // Preview button's own frame (`gc-vote-btn`) so the band does not
      // reflow when the build finishes and this very slot becomes that
      // button — only the fill and the ink change — and it renders as a real
      // disabled <button>, which is what stops the pointer AND tells
      // assistive tech the control is there but not available yet. A <span>
      // did neither. `gc-checks-running-badge` stays on it: it carries the
      // neutral ink and the 4px spinner gap, and it is what the declared
      // checks and the other surfaces select the building state by.
      return (
        <button
          type="button"
          className="gc-vote-btn gc-vote-btn-building gc-checks-running-badge"
          disabled
          title={spec.title}
        >
          <Spinner />
          {'Preview building…'}
        </button>
      );
    }
    return (
      <span className="gc-vote-btn gc-vote-btn-icon gc-checks-running-badge" role="img" aria-label="Preview building" title={spec.title}>
        <Spinner />
      </span>
    );
  }
  if (!spec.iconOnly) {
    return <span className="gc-conflict-badge" title={spec.title}>Preview unavailable</span>;
  }
  return (
    <span className="gc-vote-btn gc-vote-btn-icon gc-conflict-badge" role="img" aria-label="Preview unavailable" title={spec.title}>
      <EyeOffIcon aria-hidden="true" />
    </span>
  );
}

/** One entry of the status band, dispatched over the tagged union. */
export function Badge({ b }: { b: BadgeSpec }): ReactNode {
  switch (b.t) {
    case 'chip':
      return (
        <span className={b.cls} title={b.title} {...(b.data || {})}>
          {b.spinner ? <Spinner /> : null}
          {b.label}
        </span>
      );
    case 'chipBtn':
      return (
        <button
          type="button"
          className={`${b.cls} ${b.hover}`}
          title={b.title}
          {...(b.data || {})}
          onClick={() => call(b.act)}
        >
          {b.spinner ? <Spinner /> : null}
          {b.label}
        </button>
      );
    case 'chat':
      // Rendered at 0 too, wearing `hidden`, so a live bump has a target.
      return (
        <span
          className={`dev-chat-badge dev-badge ${b.count ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400' : 'hidden bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'}`}
          data-count={b.count}
          title="Messages in this thread"
        >{`\u{1F4AC} ${b.count}`}</span>
      );
    case 'attr': {
      const count = b.count > 1 ? <span className="opacity-60">{`·${b.count}`}</span> : null;
      let label: ReactNode;
      if (b.label.kind === 'glyph') {
        label = b.label.glyph + ' ' + b.label.text;
      } else if (b.label.kind === 'dot') {
        label = (
          <>
            <span className={`attr-dot ${b.label.cls}`}></span>
            {b.label.text}
          </>
        );
      } else if (b.label.kind === 'avatar') {
        label = (
          <>
            <span className={`attr-avatar ${b.label.tint}`}>{b.label.initial}</span>
            <span className="dev-badge-name">{b.label.text}</span>
          </>
        );
      } else {
        label = (
          <>
            <span className="attr-avatar attr-avatar-empty"></span>
            <span className="dev-badge-name">{b.label.text}</span>
          </>
        );
      }
      if (b.readonly) {
        return <span className={`attr-chip dev-badge ${b.cls}`}>{label}{count}</span>;
      }
      return (
        <button
          type="button"
          className={`attr-chip dev-badge ${b.cls} ${b.hover}`}
          data-attr-chip=""
          data-attr-field={b.field}
          data-attr-target-type={b.targetType}
          data-attr-target-ref={b.targetRef}
          title={b.title}
        >
          {label}
          {count}
        </button>
      );
    }
    case 'issueChip':
      return (
        <button
          type="button"
          className={b.cls}
          title={b.title}
          data-issue-chip={b.n}
          onClick={() => call({ fn: 'openTopic', args: ['issue', b.n] })}
        >{`${b.prefix}#${b.n}`}</button>
      );
    case 'issueLink':
      return (
        <a href={b.href} target="_blank" rel="noopener" className={b.cls} title={b.title}>
          {`${b.verb} #${b.n}`}
        </a>
      );
    case 'ms':
      // MergeStatus.badgeHtml's shell; the descriptor comes from
      // MergeStatus.lifecycle, resolved by the builder.
      return (
        <span className={`ms-badge ms-badge-${b.tone || 'neutral'}`} title={b.title}>
          {b.spinner ? <Spinner /> : null}
          {b.glyph ? `${b.glyph} ${b.label}` : b.label}
        </span>
      );
    case 'venue':
      return <span className="dc-venue-chip" title={b.title}>{b.label}</span>;
    default:
      return null;
  }
}

/**
 * The status band caps the STATE chips at four; the pill, the linkage and the
 * 💬 count ride outside the cap (`_cardBadgesHtml`'s contract, transcribed
 * with the markup it governed). The tags — priority, assignee, category —
 * are not under it: they ride on the meta line, which wraps for them.
 *
 * The action band has no count cap any more. It shows as many pills as fit
 * its one line and folds the rest into the menu (useFoldedActions).
 */
export const BADGE_MAX = 4;

/**
 * The card's vote control: one button beside the state bar.
 *
 * The Yes/No pair used to be two pills in the action band — two of the three
 * pills a card could show, on every open proposal, whether or not the reader
 * meant to vote. They are one button now: "Vote ▾" until the viewer has cast
 * one, then "✓ Yes ▾" (filled accent) or "✕ No ▾" (blocked tint), and the
 * caret says it can always be changed. Pressing it opens the picker: ONE
 * panel (`VotePicker`) — a two-way switch across its top with Yes on by
 * default, the line box under it, and Cancel beside one button that reads
 * "Vote yes" or "Vote no" with the switch. The two sides are the SAME two
 * ActionSpecs the pills were (`castVote` / `castIssueVote`, with the
 * reviewed revision in their args), so the server's head-revision guard and
 * the tally in each label are untouched. A Yes is one click once the picker
 * is open, and nothing appears as a second step: the box is there from the
 * start, optional on a Yes and required on a No.
 *
 * The picker is portalled to `document.body` and positioned fixed from the
 * button's rect, exactly as `_toggleCardMenu` places the ⋯ menu: the kanban
 * columns scroll sideways, so anything left inside a card would be clipped
 * by its own column.
 *
 * On touch the SAME panel is a kit bottom sheet (#1688 follow-up): the
 * switch at tap-target size and the box inline under it — one place, not a
 * native action sheet followed by the kit's prompt card. The kit keeps a
 * sheet above the on-screen keyboard (`--un-kb-inset`), which is what makes
 * a box inside one usable. The action sheet + prompt-card path survives
 * only as the fallback where no sheet can be presented (the kit missing),
 * and desktop is untouched.
 */
/**
 * How many POSITIONAL arguments sit before the options bag, per vote call.
 * `castVote(sessionId, vote, expectedEpoch, opts)` takes three;
 * `castIssueVote(issueId, vote, opts)` takes two. The card models leave
 * trailing slots out, so `send` pads to this count and appends the bag —
 * a single constant here would put the line in the epoch's place.
 */
const VOTE_ARITY: Record<string, number> = { castVote: 3, castIssueVote: 2 };

export function VoteButton({ yes, no }: { yes: ActionSpec; no: ActionSpec }): ReactNode {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; bottom: number; right: number } | null>(null);
  // The switch's side while the picker is up: Yes by default, the viewer's
  // own vote when they have one, so changing a No starts from No.
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [line, setLine] = useState('');
  // The touch picker: the kit sheet's content element while it is up, and
  // the handle that takes it down. `sheetEl` is what the panel portals into.
  const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null);
  const sheetRef = useRef<{ dismiss: () => void } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const mine: 'yes' | 'no' | null = /\bgc-vote-active\b/.test(yes.cls || '')
    ? 'yes'
    : (/\bgc-vote-active\b/.test(no.cls || '') ? 'no' : null);
  // #1688: the viewer's Yes was on an EARLIER version of the proposal. The
  // face asks "Still yes?", the switch reads "Still yes" / "Not this time",
  // and a Yes sent without a line keeps the earlier one — the server carries
  // it onto this version.
  const prior: 'yes' | 'no' | null = !mine && (yes.prior === 'yes' || yes.prior === 'no') ? yes.prior : null;
  // "Yes (2/3)" → "2/3": the tally rides in the spec's label already.
  const tally = (a: ActionSpec) => {
    const m = /\(([^)]*)\)\s*$/.exec(a.label || '');
    return m ? m[1] : '';
  };
  const reasonId = `dev-vote-reason-${String(yes.act?.args?.[0] ?? 'x')}`;
  // #2603: a governance vote carries a line too — every proposal the group
  // votes on does. Anything else demoted into this button (there is nothing
  // today) keeps the plain panel and the spec's own call.
  const isVote = yes.act?.fn === 'castVote' || yes.act?.fn === 'castIssueVote';
  const startSide = (): 'yes' | 'no' => (mine === 'no' ? 'no' : 'yes');
  const shut = () => {
    setOpen(false);
    setLine('');
    // The kit tears the sheet down with a spring and then calls onDismiss,
    // which is where the sheet state is cleared — once, whichever side
    // started the dismissal (this, the backdrop, or a drag).
    const sheet = sheetRef.current;
    if (sheet) {
      sheetRef.current = null;
      sheet.dismiss();
    }
  };
  // castVote(sessionId, vote, expectedEpoch, { reason }) and
  // castIssueVote(issueId, vote, { reason }): a string is the line to send,
  // null sends none without asking. Slots the model left out are filled in
  // so the options bag always lands LAST — which is why the count is read
  // per function (VOTE_ARITY) rather than fixed at castVote's three.
  const send = (a: ActionSpec, reason: string | null) => {
    shut();
    if (!a.act) return;
    if (!isVote) { call(a.act); return; }
    const args = [...(a.act.args || [])];
    const positional = VOTE_ARITY[a.act.fn] ?? 3;
    while (args.length < positional) args.push(null);
    call({ fn: a.act.fn, args: [...args, { reason }] });
  };
  // The fallback's rows are the native action sheet's, and the line is then
  // asked for by castVote itself through the kit's prompt card — the one
  // path left where the box is not inline, and only where no sheet can be
  // presented at all.
  const pickTouch = (a: ActionSpec) => {
    shut();
    call(a.act);
  };
  // The touch picker: a kit bottom sheet holding the same panel. The element
  // handed to the kit is the portal's target; the kit reparents it into its
  // sheet body and hands back the dismiss handle. False when there is no
  // sheet to be had.
  const openSheet = (pu: any): boolean => {
    if (typeof pu.sheet !== 'function' || typeof document === 'undefined') return false;
    const panel = document.createElement('div');
    panel.className = 'dev-vote-sheet-host';
    const handle = pu.sheet({
      contentEl: panel,
      onDismiss: () => {
        sheetRef.current = null;
        setSheetEl(null);
        setLine('');
      },
    });
    if (!handle || typeof handle.dismiss !== 'function') return false;
    sheetRef.current = handle;
    setSheetEl(panel);
    return true;
  };
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (open || sheetRef.current) { shut(); return; }
    setSide(startSide());
    setLine('');
    const pu = (window as any).PlatformUI;
    if (pu && typeof pu.isTouch === 'function' && pu.isTouch()) {
      if (openSheet(pu)) return;
      if (typeof pu.actionSheet === 'function') {
        pu.actionSheet({
          actions: [
            { label: `✓  ${prior === 'yes' ? 'Still yes' : 'Yes'}${tally(yes) ? ` (${tally(yes)})` : ''}`, handler: () => pickTouch(yes) },
            { label: `✕  ${prior === 'yes' ? 'Not this time' : 'No'}${tally(no) ? ` (${tally(no)})` : ''}`, handler: () => pickTouch(no) },
          ],
        });
        return;
      }
    }
    const r = e.currentTarget.getBoundingClientRect();
    setRect({ top: r.top, bottom: r.bottom, right: r.right });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = () => shut();
    const onDoc = (ev: Event) => {
      const t = ev.target as Node | null;
      if (t && (btnRef.current?.contains(t) || popRef.current?.contains(t))) return;
      close();
    };
    const onKey = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  // A card that goes away under an open sheet (a repaint that replaces it)
  // takes the sheet with it rather than leaving a kit surface pointing at a
  // portal target nothing renders into any more.
  useEffect(() => () => {
    const sheet = sheetRef.current;
    if (sheet) { sheetRef.current = null; sheet.dismiss(); }
  }, []);
  // The box takes focus when the popover opens, and in either home the
  // moment the switch lands on No — the side that needs a line. A layout
  // effect, so on touch the focus still counts as part of that tap and
  // raises the keyboard. Not on a sheet opening on Yes: a keyboard rising
  // over a one-tap "Vote yes" would be in the way.
  useIsoLayoutEffect(() => {
    if (open || (sheetEl && side === 'no')) boxRef.current?.focus();
  }, [open, sheetEl, side]);
  const face = mine === 'yes' ? 'Yes' : (mine === 'no' ? 'No' : (prior === 'yes' ? 'Still yes?' : 'Vote'));
  // A governance apply in flight disables the pair; the one button goes
  // inert with them, wearing the spec's own explanation.
  const disabled = !!(yes.disabled || no.disabled);
  const title = disabled && yes.title ? yes.title : mine
    ? `You voted ${face}. Press to change your vote.`
    : prior === 'yes'
      ? `You said yes to an earlier version. One tap carries it onto this one.`
      : `Cast your vote · Yes ${tally(yes)} · No ${tally(no)}`;
  // The popover's frame: the switch, the box and the buttons (no box on a
  // governance vote). Placed from the button's rect each render, exactly as
  // `_toggleCardMenu` places the ⋯ menu.
  const w = 312;
  const h = isVote ? 190 : 100;
  const pos = rect ? (() => {
    const left = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    return { top: Math.round(top), left: Math.round(left) };
  })() : null;
  const spec = side === 'yes' ? yes : no;
  const trimmed = line.replace(/\s+/g, ' ').trim();
  // A No needs its line; a Yes may go without one.
  const canSend = !isVote || side === 'yes' || !!trimmed;
  const submit = () => {
    if (!canSend) return;
    send(spec, isVote ? (trimmed || null) : null);
  };
  const onBoxKey = (ev: globalThis.KeyboardEvent | { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  };
  // The panel, drawn once for both homes: the anchored popover on desktop,
  // the kit sheet on touch.
  const picker = (
    <VotePicker
      yes={yes}
      no={no}
      prior={prior}
      side={side}
      line={line}
      reasonId={reasonId}
      boxRef={boxRef}
      tally={tally}
      withLine={isVote}
      onSide={setSide}
      onLine={setLine}
      onBoxKey={onBoxKey}
      onCancel={shut}
      onSend={submit}
    />
  );
  const popover = open && pos ? createPortal(
    <div
      ref={popRef}
      className="dev-vote-pop"
      role="dialog"
      aria-label="Your vote"
      data-side={side}
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
      onClick={(ev) => ev.stopPropagation()}
    >
      {picker}
    </div>,
    document.body,
  ) : null;
  const sheet = sheetEl ? createPortal(
    <div className="dev-vote-sheet" role="dialog" aria-label="Your vote" data-vote-sheet="" data-side={side}>
      {picker}
    </div>,
    sheetEl,
  ) : null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dev-vote-btn${mine ? ` dev-vote-btn-${mine}` : (prior === 'yes' ? ' dev-vote-btn-prior' : '')}`}
        data-vote-btn={mine || (prior === 'yes' ? 'prior-yes' : 'open')}
        aria-haspopup="dialog"
        aria-expanded={open || !!sheetEl ? 'true' : undefined}
        title={title}
        disabled={disabled}
        onClick={toggle}
      >
        {mine === 'yes' ? <CheckIcon aria-hidden="true" /> : null}
        {mine === 'no' ? <XIcon aria-hidden="true" /> : null}
        {face}
        <ChevronDownIcon className="dev-vote-caret" aria-hidden="true" />
      </button>
      {popover}
      {sheet}
    </>
  );
}

/**
 * The picker's one panel: a "Your vote" header over the two-way switch
 * across the top (Yes on by default, each half carrying its tally), the line
 * box under its own label, and Cancel beside the one button that reads
 * "Vote yes" or "Vote no" with the switch — off on a No until there is a
 * line. One drawing for both of its homes,
 * `VoteButton`'s anchored popover on desktop and its kit bottom sheet on
 * touch, so the wording and the rules cannot drift between the two.
 * `withLine` is false on a governance vote, which carries no line. Exported
 * for the tests that render it directly; the state lives in `VoteButton`.
 */
export function VotePicker({
  yes, no, prior, side, line, reasonId, boxRef, tally, withLine, onSide, onLine, onBoxKey, onCancel, onSend,
}: {
  yes: ActionSpec;
  no: ActionSpec;
  prior: 'yes' | 'no' | null;
  side: 'yes' | 'no';
  line: string;
  reasonId: string;
  boxRef?: RefObject<HTMLTextAreaElement | null>;
  tally: (a: ActionSpec) => string;
  withLine: boolean;
  onSide: (side: 'yes' | 'no') => void;
  onLine: (line: string) => void;
  onBoxKey: (ev: globalThis.KeyboardEvent | { key: string; shiftKey: boolean; preventDefault: () => void }) => void;
  onCancel: () => void;
  onSend: () => void;
}): ReactNode {
  const trimmed = line.replace(/\s+/g, ' ').trim();
  const yesOn = side === 'yes';
  // The header over the switch is also the switch's accessible name.
  const headId = `${reasonId}-head`;
  return (
    <>
      <div className="dev-vote-switch-label" id={headId}>Your vote</div>
      <div className="dev-vote-switch" role="group" aria-labelledby={headId}>
        <button
          type="button"
          className="dev-vote-switch-opt dev-vote-switch-yes"
          aria-pressed={yesOn}
          title={yes.title}
          data-act={yes.act?.fn}
          onClick={() => onSide('yes')}
        >
          <CheckIcon aria-hidden="true" />
          {prior === 'yes' ? 'Still yes' : 'Yes'}
          <span className="dev-vote-n">{tally(yes)}</span>
        </button>
        <button
          type="button"
          className="dev-vote-switch-opt dev-vote-switch-no"
          aria-pressed={!yesOn}
          title={no.title}
          data-act={no.act?.fn}
          onClick={() => onSide('no')}
        >
          <XIcon aria-hidden="true" />
          {prior === 'yes' ? 'Not this time' : 'No'}
          <span className="dev-vote-n">{tally(no)}</span>
        </button>
      </div>
      {withLine ? (
        <div className="dev-vote-reason" data-vote-reason={side}>
          <label className="dev-vote-reason-label" htmlFor={reasonId}>
            {yesOn
              ? 'Add a line for the group, if you like.'
              : 'What’s not working for you? One line is plenty.'}
          </label>
          <textarea
            id={reasonId}
            ref={boxRef}
            className="dev-vote-reason-box"
            rows={2}
            maxLength={280}
            placeholder={yesOn ? 'What do you like about it?' : 'What would you want to change?'}
            value={line}
            onChange={(ev) => onLine(ev.target.value)}
            onKeyDown={onBoxKey}
          />
        </div>
      ) : null}
      <div className="dev-vote-reason-actions">
        <button type="button" className="dev-vote-reason-cancel" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className={`dev-vote-reason-send dev-vote-reason-send-${side}`}
          disabled={withLine && !yesOn && !trimmed}
          onClick={onSend}
        >
          {yesOn ? 'Vote yes' : 'Vote no'}
        </button>
      </div>
    </>
  );
}

/** A Yes or No spec — the vote pair the band demotes into `VoteButton`. */
export function isVoteSpec(a: ActionSpec, side: 'yes' | 'no'): boolean {
  return new RegExp(`\\bgc-vote-btn-${side}\\b`).test(a.cls || '');
}

/** One action pill; the kudos slot and the Explore pill are its two specials. */
export function ActionButton({ a, fold, hidden }: { a: ActionSpec; fold?: number; hidden?: boolean }): ReactNode {
  const { enabled } = useStoreState(aiEnabledStore);
  // `data-fold` marks a pill the one-line band may hide; every pill carries
  // one but the kudos host.
  const foldAttrs = fold ? { 'data-fold': String(fold), 'data-folded': hidden ? '1' : undefined } : {};
  if (a.kudos != null) {
    // The controller host — `AppView._fillKudosHosts` owns everything below.
    return <span className="contents" data-kudos-host={a.kudos}></span>;
  }
  // The topic head's LABELLED preview — the same component as the card's
  // eye, which is also what covers its two badge states.
  if (a.preview) return <Preview spec={a.preview} />;
  if (a.explore != null) {
    // #313/#827/#621. Availability is `/api/budget`'s answer, published
    // through aiEnabledStore — the store replaces the
    // `_applyExploreChatAvailability` DOM pass for card pills.
    return (
      <button
        type="button"
        className={`gc-vote-btn gc-explore-chat-btn${enabled ? '' : ' opacity-50 cursor-not-allowed'}`}
        disabled={!enabled}
        {...foldAttrs}
        data-proposal-id={a.explore}
        title={enabled ? a.title : "AI chat isn't configured on this deployment."}
        onClick={(e) => call({ fn: 'exploreProposalInDevChat', args: [a.explore!] }, e.currentTarget)}
      >
        <span aria-hidden="true">{'✨'}</span>
        {' Explore in dev chat'}
      </button>
    );
  }
  // `data-act` is the name of the AppView method this pill calls.
  //
  // These handlers were inline `onclick="AppView.markIssueInProgress(12)"`
  // strings, and two of dapp.json's declared checks assert that a particular
  // action is offered IN THE BAND rather than buried in the ⋯ menu by
  // matching `[onclick*="markIssueInProgress"]` / `[onclick*="_setSessionShared"]`.
  // The migration replaced those strings with closures, which is what made
  // the attribute — and with it the checks' only hook — disappear.
  //
  // The model already carries the answer (`act.fn`), so publishing it keeps
  // the assertion expressible without reintroducing a global-name handler.
  // Both checks select on `[data-act="…"]` now: the same claim about the same
  // button, matched exactly instead of by substring over a fragment of
  // JavaScript source.
  return (
    <button
      className={a.cls || 'gc-vote-btn'}
      disabled={a.disabled}
      title={a.title}
      {...foldAttrs}
      data-act={a.act?.fn}
      onClick={a.act ? (e) => call(a.act, a.passNode ? e.currentTarget : undefined) : undefined}
    >
      {a.label}
    </button>
  );
}

/**
 * The card's menu trigger: a hamburger at the far right of the action band,
 * after Preview when there is one.
 *
 * It was a ⋯ in the card's top-right rail. The band is where the card's
 * other controls are, and the menu is where the pills that do not fit the
 * band go (useFoldedActions), so the trigger sits at the end of that row,
 * pushed to its right edge, as the row's own "more". Same `data-card-menu`
 * hook, same `dev-card-menu-btn` class: `_openCardMenu`, `_reanchorCardMenu`
 * and the declared checks find it where they always did.
 */
export function MenuTrigger({ menuKey }: { menuKey: string }): ReactNode {
  return (
    <button
      type="button"
      className="gc-vote-btn gc-vote-btn-icon dev-card-menu-btn"
      data-card-menu={menuKey}
      aria-haspopup="true"
      aria-label="More actions"
      title="More actions"
    >
      <Bars3Icon aria-hidden="true" />
    </button>
  );
}

/**
 * The card's right edge: the tap-through chevron, or nothing.
 *
 * This was a column (`.dev-card-rail`) holding the ⋯ up top, the preview eye
 * at the bottom and the chevron centred between them. Both controls live in
 * the action band now — the hamburger at its right edge, the labelled
 * Preview after it — so the chevron is the card's only right-edge child and
 * needs no column to be centred in. `rail.preview` is still handed over by
 * the builders; DevCard draws it in the band, never here.
 */
function Rail({ rail }: { rail: RailSpec }): ReactNode {
  return rail.chevron ? <Chevron /> : null;
}

function MetaPartView({ p }: { p: MetaPart }): ReactNode {
  if (p.t === 'link') {
    return <a href={p.href} target="_blank" rel="noopener" className={p.cls} title={p.title}>{p.s}</a>;
  }
  if (p.t === 'span') {
    return <span className={p.cls} title={p.title}>{p.s}</span>;
  }
  return p.s;
}

/** The title band's content: lead/trail runs, the edit pencil, the editor. */
export function TitleContent({ t }: { t: TitleSpec }): ReactNode {
  if (t.editing) {
    const session = 'session' in t.editing;
    const n = session ? t.editing.session : t.editing.issue;
    const kind = session ? 'session' : 'issue';
    const save = session ? 'saveSessionTitle' : 'saveIssueTitle';
    const cancel = session ? 'cancelSessionTitleEdit' : 'cancelIssueTitleEdit';
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); call({ fn: save, args: [n] }); }
      if (e.key === 'Escape') { e.preventDefault(); call({ fn: cancel }); }
    };
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`dev-${kind}-title-input`}
          type="text"
          maxLength={session ? 256 : 200}
          defaultValue={t.editing.initial}
          autoFocus
          width="flex"
          box="tight"
          onKeyDown={onKeyDown}
        />
        <button type="button" className="gc-vote-btn" onClick={() => call({ fn: save, args: [n] })}>Save</button>
        <button type="button" className="gc-vote-btn" onClick={() => call({ fn: cancel })}>Cancel</button>
        <span id={`dev-${kind}-title-error`} className="w-full text-xs text-red-400 hidden"></span>
      </div>
    );
  }
  // The space before the pencil rides INSIDE the title string: a bare
  // {' '} between two text runs is two adjacent children, which cannot
  // survive hydration (React #418) and the shell build refuses it.
  const text = t.lead ? ` ${t.text}` : t.text;
  const edit = t.edit;
  const editSession = !!edit && 'session' in edit;
  const editId = edit ? ('session' in edit ? edit.session : edit.issue) : null;
  return (
    <>
      {t.lead ? <span className={t.lead.cls}>{t.lead.s}</span> : null}
      {t.edit ? `${text} ` : text}
      {t.trail ? <span className={t.trail.cls}>{` · ${t.trail.s}`}</span> : null}
      {edit ? (
        <>
          <button
            type="button"
            className="align-middle text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors dark:text-zinc-400"
            title={editSession ? 'Edit this proposal title' : "Edit this issue's title (you created it)"}
            aria-label="Edit title"
            onClick={() => call({
              fn: editSession ? 'beginSessionTitleEdit' : 'beginIssueTitleEdit',
              args: [editId],
            })}
          >
            <PencilSquareIcon className="w-3.5 h-3.5 inline -mt-0.5" />
          </button>
        </>
      ) : null}
    </>
  );
}

// #2061 — the whole ordered list of what a proposal still needs.
//
// The tags say what is WRONG. They never say what is REQUIRED, so an absent
// tag is ambiguous between "the gate passed", "the gate does not apply here"
// and "the gate has no UI at all" — and two of the seven really had none. A
// tick is what tells those apart.
//
// Stateful on purpose: `open` seeds from the model's viewer-aware rule, and
// then belongs to the reader. Rendering it straight from the model would snap
// a card the reader opened shut again on the next websocket repaint.
//
// With one re-seed: when the rule flips from "nothing here is yours" to "the
// step it is stuck on is yours to clear", the ledger opens. A card that
// mounted while main was fine and then saw main go red — the admin's Resume
// is now the verb the card is waiting on — kept its collapsed seed for an
// afternoon, and the only control that would have ended the pause sat one
// click below a line that read like everything else. A reader who closes it
// after that keeps it closed: the re-seed fires on the transition, not on
// every repaint while the condition holds.
const REQ_MARK: Record<string, string> = {
  done: '✓', active: '', waiting: '!', blocked: '✕', pending: '·',
};
const REQ_TONE: Record<string, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  active: 'text-zinc-500 dark:text-zinc-400',
  waiting: 'text-amber-600 dark:text-amber-400',
  blocked: 'text-red-600 dark:text-red-400',
  pending: 'text-zinc-400 dark:text-zinc-500',
};
const REQ_ACTOR: Record<string, string> = {
  auto: 'automatic', author: 'the author', admin: 'an admin', group: 'the group',
};

function RequirementsRow({ x }: { x: Extract<ExtraSpec, { t: 'requirements' }> }): ReactNode {
  const [open, setOpen] = useState(x.open);
  // The model's seed as of the previous render, so the effect below can tell
  // a false→true FLIP from a repaint that merely still says true.
  const seedRef = useRef(x.open);
  useEffect(() => {
    const was = seedRef.current;
    seedRef.current = x.open;
    if (x.open && !was) setOpen(true);
  }, [x.open]);
  return (
    <details
      className="mt-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 overflow-hidden"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      data-merge-requirements={x.gates.length ? '1' : '0'}
    >
      <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[0.72rem] leading-snug text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <span className="font-semibold text-zinc-800 dark:text-zinc-100" data-req-headline>{x.headline}</span>
        {x.detail ? <span className="truncate text-zinc-500 dark:text-zinc-400">{`· ${x.detail}`}</span> : null}
        <span className="ml-auto tabular-nums text-[0.68rem] text-zinc-400 dark:text-zinc-500" data-req-count>
          {`${x.done}/${x.total}`}
        </span>
      </summary>
      <ol className="list-none m-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 py-1">
        {x.gates.map((g) => (
          <li
            key={g.key}
            className="px-2.5 py-1 grid grid-cols-[1rem_1fr_auto] gap-x-1.5 items-baseline text-[0.72rem]"
            data-req-gate={g.key}
            data-req-state={g.state}
          >
            <span className={`text-center font-bold ${REQ_TONE[g.state] || REQ_TONE.pending}`} aria-hidden="true">
              {g.state === 'active'
                ? <span className="dc-status-spinner inline-block align-[-1px]" />
                : (REQ_MARK[g.state] || '·')}
            </span>
            <span className={g.state === 'done' || g.state === 'pending'
              ? 'text-zinc-500 dark:text-zinc-400'
              : 'text-zinc-900 dark:text-zinc-100 font-semibold'}>
              {g.label}
            </span>
            <span className="text-[0.65rem] text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
              {REQ_ACTOR[g.actor] || g.actor}
            </span>
            {g.note
              ? <span className="col-start-2 text-[0.68rem] leading-snug text-zinc-400 dark:text-zinc-500">{g.note}</span>
              : null}
            {g.action
              ? (
                <span className="col-start-2 mt-0.5">
                  <button
                    type="button"
                    className="gc-vote-btn"
                    title={g.action.title}
                    data-req-action={g.key}
                    onClick={(e) => call(g.action!.act, e.currentTarget)}
                  >
                    {g.action.label}
                  </button>
                </span>
              )
              : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * A featured-illustration card's preview (#2086): the current illustration
 * beside the proposed one, each a captioned thumbnail on the card colour it
 * wears. The image URL is API-supplied, so it is an <img> with alt text and
 * nothing else, never an anchor. A side with no illustration says so in
 * words, because the empty state (the app icon shows instead) is a real
 * outcome a voter is deciding on, not a missing picture.
 */
function IllustrationPreviewRow({ x }: { x: Extract<ExtraSpec, { t: 'illustration' }> }): ReactNode {
  const side = (label: string, which: 'current' | 'proposed', art: typeof x.proposed) => (
    <figure className="m-0 flex min-w-0 flex-1 flex-col gap-1" data-illustration-side={which}>
      <figcaption className="text-[0.65rem] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</figcaption>
      {art ? (
        <div
          className={`${cardTintClass(art.tint) || ''} overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700`}
          style={{ background: cardTintClass(art.tint) ? 'var(--tone-50)' : undefined }}
        >
          <img
            src={art.url}
            alt={`${which === 'proposed' ? 'Proposed' : 'Current'} featured illustration`}
            loading="lazy"
            className="block h-24 w-full object-cover"
          />
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-zinc-300 text-[0.7rem] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {which === 'proposed' && x.remove ? 'Removed, the app icon shows instead' : 'No illustration, the app icon shows'}
        </div>
      )}
    </figure>
  );
  return (
    <div className="mt-2 flex gap-3 px-0.5" data-illustration-preview="1">
      {side('Current', 'current', x.current)}
      {side('Proposed', 'proposed', x.proposed)}
    </div>
  );
}

function ExtraRow({ x }: { x: ExtraSpec }): ReactNode {
  if (x.t === 'requirements') return <RequirementsRow x={x} />;
  if (x.t === 'illustration') return <IllustrationPreviewRow x={x} />;
  if (x.t === 'note') {
    return (
      <div className="mt-1 px-0.5 text-[0.7rem] leading-snug text-zinc-500 dark:text-zinc-400" data-work-note={x.workState}>
        {x.text}
      </div>
    );
  }
  // The topic-view-only admin claim list, with its per-claim clear control.
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 px-0.5 text-[0.65rem] text-zinc-500 dark:text-zinc-400">
      {'Claims:'}
      {x.claims.map((c) => (
        <span key={c.userId} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-400">
          {c.username}
          <button
            type="button"
            className="hover:text-sky-700 dark:hover:text-sky-300 dark:text-sky-400"
            title={`Release ${c.username}'s claim (admin)`}
            onClick={() => call({ fn: 'clearIssueClaim', args: [c.issue, c.userId] })}
          >{'×'}</button>
        </span>
      ))}
    </div>
  );
}

/**
 * The meta line's content, shared by both sizes of the card (the folded row
 * in card/fold.tsx draws the same nodes): the parts ' · '-joined — number,
 * author, when — then the TAGS (priority, assignee, category) and the
 * linked-issue chips ("Closes #N", the session's "#N"). All of it is what
 * the item IS rather than what state it is in, so all of it rides under the
 * title, and the line may wrap.
 */
export function metaLineNodes(m: DevCardModel): ReactNode[] {
  const nodes: ReactNode[] = [];
  (m.meta || []).forEach((p, i) => {
    if (i) nodes.push(' · ');
    nodes.push(<MetaPartView key={`p${i}`} p={p} />);
  });
  for (const b of (m.badges || []).filter((b) => b && b.t === 'attr')) nodes.push(<Badge key={b.key} b={b} />);
  // The status tags — checks, conflicts, behind main — ride HERE, beside the
  // item's own tags, rather than in the facts row under the bar. The line's
  // rule used to be "what the item IS, not what state it is in"; the state
  // bar's rule is now narrower still (the vote and nothing else), and of the
  // two lines this is the one with room for a list that grows.
  for (const b of (m.badges || []).filter((b) => b && b.t === 'chip' && b.meta)) nodes.push(<Badge key={b.key} b={b} />);
  // A proposal's linkage arrives as `linked`; a session's "#N" chips arrive
  // among its badges. Same chip, same line.
  for (const b of m.linked || []) nodes.push(<Badge key={b.key} b={b} />);
  for (const b of (m.badges || []).filter((b) => b && b.t === 'issueChip')) nodes.push(<Badge key={b.key} b={b} />);
  // And the message count, when there is one: it is a fact about the item,
  // not a state, and it used to sit in a different place at each size (the
  // row's last line, the card's facts row). Nothing is drawn at 0 — a live
  // bump repaints from the model rather than revealing a hidden badge.
  const count = m.chatCount || 0;
  if (count > 0) nodes.push(<Badge key="chat" b={{ t: 'chat', key: 'chat', count }} />);
  return nodes;
}

/**
 * The action band: every pill the card has, then the caller's `actionEnd`
 * control, then Preview, then the hamburger closing the band. The band's
 * measurement (useFoldedActions) shows as many pills as fit its one line
 * and folds the rest, from the end, into the menu behind the hamburger;
 * the controls after the pills are fixed children it folds around, and so
 * is `lead` — the change page's Vote button, which opens the band.
 *
 * The old cap of three text pills is gone: the line is the cap now. That
 * is the seat both surfaces use for "Open card" (card/fold.tsx), so an
 * open card on the Board and on the Workshop is one drawing — and the
 * change page's hero (topic/topic-head.tsx) is the same band again, under
 * a Needs-you title instead of a card's.
 *
 * (A second seat, the right end of the facts line with the card's own
 * pills moved up beside it, existed for a round and had no caller left;
 * the band is the one seat now.)
 */
export function ActionBand({ actions, menuKey, preview, lead, actionEnd, dense }: {
  actions: ActionSpec[];
  menuKey: string;
  preview: PreviewSpec | null;
  /** A fixed control before the pills; it never folds. */
  lead?: ReactNode;
  actionEnd?: ReactNode;
  /** The dense (board) band holds its row open even with nothing in it. */
  dense: boolean;
}): ReactNode {
  const previewSpec = preview ? { ...preview, iconOnly: false } : null;
  const bandPreview = previewSpec ? <Preview spec={previewSpec} /> : null;
  const bandPrimary = actions;
  const menuTrigger = menuKey ? <MenuTrigger menuKey={menuKey} /> : null;
  const hasActions = bandPrimary.length > 0 || !!actionEnd || !!menuTrigger || !!bandPreview;
  const folded = useFoldedActions(bandPrimary, menuKey || '', !!bandPreview);
  if (!hasActions && !lead) return dense ? <div className="gc-card-actions"></div> : null;
  return (
    <div className="gc-card-actions" ref={folded.ref} data-band-measured={folded.measured ? '1' : undefined}>
      {lead}
      {bandPrimary.map((a, i) => (
        <ActionButton key={a.key} a={a} fold={a.kudos == null ? i + 1 : undefined} hidden={i >= bandPrimary.length - folded.n} />
      ))}
      {actionEnd}
      {bandPreview}
      {menuTrigger}
    </div>
  );
}

/** The whole card. `m.attrs` carries the outer element's data-*, role and title. */
export function DevCard(
  { model: m, actionEnd, headEnd }: {
    model: DevCardModel;
    actionEnd?: ReactNode;
    /** The fold's mark at the head's end (card/fold.tsx FoldMark); the card draws none of its own. */
    headEnd?: ReactNode;
  },
): ReactNode {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.attrs || {})) {
    // `tabindex` must reach React by its DOM-property name or React warns —
    // and a console error on any route fails proposal checks.
    if (k === 'tabindex') attrs.tabIndex = Number(v);
    else attrs[k] = v;
  }

  const dense = m.dense;
  // The vote pair leaves the action band for the status band, as one button
  // beside the bar — on the board card and on the topic head alike.
  const allActions = m.actions || [];
  const yesSpec = allActions.find((a) => isVoteSpec(a, 'yes'));
  const noSpec = allActions.find((a) => isVoteSpec(a, 'no'));
  const voteBtn = yesSpec && noSpec ? <VoteButton yes={yesSpec} no={noSpec} /> : null;
  const bandActions = voteBtn ? allActions.filter((a) => a !== yesSpec && a !== noSpec) : allActions;
  // ── One anatomy, two sizes ──────────────────────────────────────────
  //
  // The folded row (card/fold.tsx) is this card compressed, and the two are
  // built from the same fields in the same order so they read as one object:
  //
  //   head   the glyph, then the title, wrapping in full at both sizes
  //   meta   number · author · when, the tags, the linked-issue chips, the
  //          message count — tabbed in under the title (metaLineNodes,
  //          shared with the row)
  //   status the STATE: on the card the full bar with the vote button beside
  //          it, spanning the card; on the row a chip of the same state,
  //          with the vote button at the row's bottom-right
  //   facts  the state chips — the work-state chip, the imported / paused
  //          chips — tabbed in like the meta line
  //   band   the actions, spanning the card (the card only)
  //
  // So the card is the row plus the bar expanded and the buttons added, and
  // nothing else moves between the two.
  const chips = (m.badges || []).filter(Boolean);
  // `meta` chips are drawn on the meta line above (metaLineNodes), so they
  // must not be drawn again here.
  const states = chips.filter((b) => b.t !== 'attr' && b.t !== 'issueChip' && !(b.t === 'chip' && b.meta));
  const kept = m.uncapped ? states : states.slice(0, BADGE_MAX);

  // The preview sits at the band's right end just before the hamburger,
  // with the card's other controls: a fixed child of the band, which the
  // pills fold around, and always the LABELLED pill — the eye and the word —
  // whichever builder handed it over. (It closed the facts line for a round,
  // and before that sat as a bare eye in the corner rail; the board's
  // builders still hand it over as `rail.preview`, the detail head's as
  // `actionPreview`, and the model did not move.)
  //
  // The band itself is `ActionBand` below — one drawing for the card here
  // and for the change page's hero (topic/topic-head.tsx), which composes
  // the same pills, Preview and hamburger under a Needs-you title.
  // ── The status row, then the facts row ──
  //
  // Two rows, not one wrapping band with a break in it: the bar spans the
  // card with the vote button at its right end, and the facts under it are
  // tabbed in with the meta line. A dense card always emits the status row —
  // stamped data-empty and hidden when it has no bar and no vote (#1139), so
  // the sibling chain the checks walk stays intact — and emits the facts row
  // only when a reader could see something in it. The detail head keeps its
  // one uncapped row, the pill as an inline capsule among the chips.
  const pill = m.pill ? <StatusPill s={m.pill.state} inline={m.pill.inline} /> : null;
  const factsShown = kept.length > 0;
  const statusRow = dense ? (
    <div className="dev-card-badges dev-card-status" data-empty={pill || voteBtn ? undefined : '1'}>{pill}{voteBtn}</div>
  ) : (pill || voteBtn || factsShown ? (
    <div className="dev-card-badges">{pill}{voteBtn}{kept.map((b) => <Badge key={b.key} b={b} />)}</div>
  ) : null);
  const factsRow = dense && factsShown ? (
    <div className="dev-card-badges dev-card-facts">{kept.map((b) => <Badge key={b.key} b={b} />)}</div>
  ) : null;

  const actionRow = (
    <ActionBand
      actions={bandActions}
      menuKey={m.rail.menuKey || ''}
      preview={m.actionPreview || m.rail.preview || null}
      actionEnd={actionEnd}
      dense={dense}
    />
  );
  const edge = edgeFor(m);

  // The meta line. Dense reserves the line even when empty; the detail head
  // collapses it, exactly as `_cardContentHtml` did.
  const metaNodes = metaLineNodes(m);
  const metaRow = dense || metaNodes.length ? <div className="dev-card-meta">{metaNodes}</div> : null;

  return (
    <div className={`${m.cls} ${dense ? 'dev-card-dense' : 'dev-card-topic'}`} data-edge={edge} {...attrs}>
      <div className="flex-1 min-w-0">
        <div className="dev-card-head">
          {m.icon ? <CardIcon spec={m.icon} /> : null}
          <div className="dev-card-head-main">
            <div
              // The title wraps in full at both sizes, as the row's does: the
              // two-line clamp (and the tooltip that made up for it) lined a
              // column of open cards up, and a column holds one open card now.
              className="dev-card-title"
              data-issue-title={m.title.edit || m.title.editing
                ? (m.title.edit ? m.title.edit.issue : m.title.editing!.issue)
                : undefined}
            >
              <TitleContent t={m.title} />
            </div>
          </div>
          {headEnd}
        </div>
        {metaRow}
        {statusRow}
        {factsRow}
        {actionRow}
        {(m.extra || []).map((x) => <ExtraRow key={x.key} x={x} />)}
      </div>
      <Rail rail={m.rail} />
    </div>
  );
}

/**
 * The card's left edge: the bar's tone, and the card's TYPE where it has no
 * bar. 4px at a third strength (app.css `[data-edge]`), so a column reads as
 * a stack of tinted spines — blue while a vote is open, violet while merging,
 * amber behind main, red on a conflict, green once merged, grey while paused
 * — and an open issue, which has no state, wears its type's amber so the
 * Issues column is not the one bare column.
 */
export function edgeFor(m: DevCardModel): string {
  const s = m.pill?.state;
  if (s && s.label) return isOpenVote(s) ? 'vote' : (s.tone || 'neutral');
  const kind = String(m.key || '').split(':')[0];
  if (kind === 'issue') return 'attention';
  if (kind === 'proposal') return 'vote';
  if (kind === 'gov') return 'progress';
  return 'ok';
}

/** One face of the kudos slot and the width the band spends on it. */
export type SlotFace = { stage: 'full' | 'short' | 'clap'; width: number };

/**
 * The kudos slot's faces, widest first, read off the pill at its full face:
 * the whole line; the name alone (the line's tail hidden), when the pill is
 * the thanks face; and the clap alone, a square of the pill's own height
 * (app.css `[data-thanks="clap"]`).
 */
export function slotFaces(pill: HTMLElement): SlotFace[] {
  const full = pill.offsetWidth;
  const faces: SlotFace[] = [{ stage: 'full', width: full }];
  const tail = pill.querySelector('.dev-thanks-tail') as HTMLElement | null;
  if (tail && tail.offsetWidth) faces.push({ stage: 'short', width: full - tail.offsetWidth });
  faces.push({ stage: 'clap', width: pill.offsetHeight });
  return faces;
}

/**
 * The widest face that fits the room the fixed controls leave, or null when
 * not even the clap does — the slot then folds into ⋯. The pure half of the
 * measurement, so the ladder is pinned at a few widths without a layout.
 */
export function slotFace(room: number, faces: SlotFace[]): SlotFace | null {
  for (const f of faces) if (f.width <= room) return f;
  return null;
}

/**
 * One line of actions, folding into ⋯.
 *
 * The dense band always clipped at one row, so a pill that did not fit
 * wrapped onto a row nobody saw. It folds now: after layout the band
 * measures its pills, keeps the first (the card's primary) and the Preview
 * pill, marks as many of the rest as do not fit `data-folded`, and publishes
 * those specs to app-view.js (`_setFoldedCardActions`) so `_toggleCardMenu`
 * lists them at the top of the card's ⋯ menu.
 *
 * A folded pill is NOT `hidden`: app.css sends it to the clipped second row
 * with `order` (so the Preview pill keeps the first row's right end) and
 * it stays rendered. That is deliberate — `innerText`, which the declared
 * checks read their `expectText` from, drops `display: none` content, and
 * "Claim this issue" is one of those texts. Measured in a layout effect,
 * before paint, re-measured on resize, and mirrored into React state so a
 * re-render draws what the measurement decided.
 *
 * The kudos slot is the one pill that cannot fold like the others: a host
 * app-view.js fills after the fact (`_fillKudosHosts`), with no box of its
 * own. It is measured through that host and yields LAST, in stages — the
 * whole line, the name alone, the clap alone (`data-thanks` on the band) —
 * and with no room for even the clap it folds into ⋯ like any pill
 * (`data-folded` on the host, `_kudosMenuItem` for the row). "Open card",
 * Preview and the hamburger are the fixed controls it yields to: they never
 * leave the row, whatever the column's width.
 */
function useFoldedActions(
  primary: ActionSpec[], menuKey: string, hasPreview: boolean,
): { ref: (el: HTMLDivElement | null) => void; n: number; measured: boolean } {
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [n, setN] = useState(0);
  // True when the kudos slot did not fit at any face and folded into ⋯.
  const [kudosFolded, setKudosFolded] = useState(false);
  // Until this is true the band renders every foldable pill on the clipped
  // row (app.css `:not([data-band-measured])`). The alternative — draw them
  // all and fold after — is what made an opening board card show the wrong
  // button for a frame.
  const [measured, setMeasured] = useState(false);
  // Every pill but a kudos host may fold — the first included. The fixed
  // children ("Open card", the hamburger, Preview) sit at the band's right
  // and a narrow column may leave no room before them. The topic head hands
  // its labelled Preview over as an action spec too (ActionButton draws it
  // as the fixed control, with no fold mark), so it is not a fold either:
  // counting it put the folded window one spec off, and a folded first pill
  // never reached the menu.
  const foldSpecs = primary.filter((a) => a.kudos == null && !a.preview);
  const foldable = foldSpecs.length;
  // A band whose one pill is the kudos slot still measures: the slot's
  // stages are decided here too.
  const hasKudos = primary.some((a) => a.kudos != null);
  useIsoLayoutEffect(() => {
    const band = bandRef.current;
    if (!band || (!foldable && !hasKudos)) {
      if (n) setN(0);
      if (kudosFolded) setKudosFolded(false);
      return undefined;
    }
    const measure = () => {
      const kids = Array.from(band.children) as HTMLElement[];
      const folds = kids.filter((k) => k.dataset.fold);
      folds.forEach((k) => { k.removeAttribute('data-folded'); });
      // The kudos slot, measured through its host (no box of its own) at
      // its widest face, so every read below starts from the same place.
      const host = kids.find((k) => k.dataset.kudosHost != null) || null;
      const pill = host ? (host.firstElementChild as HTMLElement | null) : null;
      band.removeAttribute('data-thanks');
      if (host) host.removeAttribute('data-folded');
      const gap = 6;
      const avail = band.clientWidth;
      let used = 0;
      let count = 0;
      for (const k of kids) {
        if (k.dataset.fold || k === host) continue;
        used += k.offsetWidth + (count ? gap : 0);
        count += 1;
      }
      // The slot yields last and in stages: the widest of its faces that
      // fits beside the fixed controls, or none — then it folds into ⋯.
      const faces = pill && pill.offsetWidth ? slotFaces(pill) : null;
      let face = faces ? slotFace(avail - used - (count ? gap : 0), faces) : null;
      const setFace = () => {
        band.removeAttribute('data-thanks');
        if (!host) return;
        host.removeAttribute('data-folded');
        if (faces && !face) host.setAttribute('data-folded', '1');
        else if (face && face.stage !== 'full') band.setAttribute('data-thanks', face.stage);
      };
      setFace();
      if (face) { used += face.width + (count ? gap : 0); count += 1; }
      let shown = 0;
      for (const k of folds) {
        const w = k.offsetWidth + (count ? gap : 0);
        if (used + w <= avail) { used += w; count += 1; shown += 1; } else break;
      }
      folds.forEach((k, i) => { if (i >= shown) k.setAttribute('data-folded', '1'); });
      // The arithmetic mirrors the flex line-break; if a rounding edge still
      // let one wrap, fold it too so the menu and the row agree — and step
      // the slot down a face while a fixed control is still off the row.
      // Off the row: at or below the band's clipped height, the same
      // offsetParent as the band's own.
      const top = band.offsetTop;
      const offRow = (k: HTMLElement) => k.offsetTop - top >= band.clientHeight;
      folds.forEach((k, i) => {
        if (i < shown && offRow(k)) { k.setAttribute('data-folded', '1'); shown = i; }
      });
      const fixed = kids.filter((k) => !k.dataset.fold && k !== host);
      while (faces && face && fixed.some(offRow)) {
        const next = faces.indexOf(face) + 1;
        face = next < faces.length ? faces[next] : null;
        setFace();
      }
      setN(folds.length - shown);
      setKudosFolded(!!faces && !face);
      setMeasured(true);
    };
    measure();
    // Re-measure when the band's width changes — and when its CONTENT does:
    // a merged card's kudos slot is filled by app-view.js after this effect
    // has run (the column's layout effect, a parent's, runs after the
    // card's), and a pill that measured 0px wide then grows to a button.
    // The observer fires as a microtask, still before the frame paints, so
    // the band folds around the filled slot on the card's first frame.
    // `data-folded` is not observed: measure() writes it.
    const off: Array<() => void> = [];
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(band);
      off.push(() => ro.disconnect());
    }
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(measure);
      mo.observe(band, { childList: true, subtree: true, characterData: true });
      off.push(() => mo.disconnect());
    }
    return () => { off.forEach((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldable, hasKudos, hasPreview, primary.map((a) => a.key + a.label).join('|')]);
  // Tell the ⋯ menu which specs it now carries.
  useEffect(() => {
    if (!menuKey) return undefined;
    const av = typeof window !== 'undefined' ? (window as any).AppView : null;
    if (!av || typeof av._setFoldedCardActions !== 'function') return undefined;
    const hidden = n > 0 ? foldSpecs.slice(-n) : [];
    // The kudos slot, when not even its clap fit, goes last: app-view.js
    // draws its row (`_kudosMenuItem`) through the slot's own button.
    const slot = kudosFolded ? primary.filter((a) => a.kudos != null) : [];
    av._setFoldedCardActions(menuKey, hidden.concat(slot));
    return () => { av._setFoldedCardActions(menuKey, []); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuKey, n, kudosFolded, primary.map((a) => a.key + a.label).join('|')]);
  return { ref: (el) => { bandRef.current = el; }, n, measured };
}
