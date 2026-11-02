'use strict';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Journey (#admin/journey, #3369): the user journey and the North Star.
//
// One read surface over the endpoints slice 1 shipped under
// /api/admin/journey/* (src/services/journey.js), drawn as eight chart cards
// so it reads at a glance: the North Star (active groups, with eight weeks
// of trend, the week's lifecycle as units, and the votes behind it), the
// seven stages, the first mile per admit cohort (one track per newcomer,
// under the staircase it sums to), the creation path (making a project to a
// change of theirs going live, against its targets, with each first
// version's stages and how it ended), the first session (with the made
// screen and the tour after Make it, card by card) and the pairs (the aha:
// two people active on a project together), the change loop and the invite
// loop as rings, and where newcomers go next. Each check sits on the card whose
// reading it qualifies: group votes and lockstep under the North Star, the
// team's share of live changes beside the change loop, navigation coverage
// under the paths. Names are chips that open one person; a stage bar opens
// its names. Nothing expands inside the page.
//
// Three rules from the endpoints are kept on screen, and the section test
// pins them:
// - a reading the platform does not record arrives as
//   `{ recorded: false, reason }` and reads "not recorded yet", never 0;
// - Hear back arrives as `{ status: 'coming' }` and reads "coming";
// - every mark carries its count, and no share is printed as a percentage:
//   at one to six people a rate claims more than the data holds. The one
//   exception is the invite funnel's conversion from step to step (#4176),
//   printed beside its counts and only from FUNNEL_RATE_FROM people; the
//   made screen's steps after Make it are read the same way.
// - what a maker asked for is shown in their own words, as text, never as
//   markup or a link.
//
// Analytics is a separate section with its own definitions; this one does
// not read or change it. On screen it is "project", never "app".
//
// PERMISSIONS: any admin reads. Only the left-out list writes, and its
// controls show for a full admin only (the routes enforce the same).

// Under staging with ?demo=1 every Journey route answers a whole, labelled
// demo payload (src/services/journey-demo.js). Guarded: the SSG prerender
// pass evaluates this module in Node.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const consoleApi = () => (window as any).AdminConsole;

// ── Vocabulary ─────────────────────────────────────────────────────────

const MILE_STEPS: Record<string, string> = {
  admitted: 'Admitted',
  mail_sent: 'Admit mail sent',
  code_asked: 'Followed the mail',
  account: 'Account created',
  access: 'Has access',
  opened: 'Opened Homeroom',
  username: 'Username chosen',
  join: 'Join screen answered',
  first_act: 'First act',
};

const STAGES: Array<[string, string, string]> = [
  ['arrive', 'Arrive', 'did anything we record'],
  ['explore', 'Explore', 'found something new on their own, or came back to something'],
  ['activate', 'Activate', 'gave feedback, voted or made a change'],
  ['belong', 'Belong', 'acted on another real person\'s work'],
  ['use', 'Use', 'had a change go live with someone else\'s yes'],
  ['stay', 'Stay', 'arrived this week and again the next'],
  ['invite', 'Invite', 'let someone in who then did something'],
];

const LOOP_STEPS: Record<string, string> = {
  notice: 'Notice',
  make_sense: 'Make sense',
  sketch: 'Sketch',
  decide: 'Decide',
  go_live: 'Go live',
  hear_back: 'Hear back',
};

const INVITE_STEPS: Record<string, string> = {
  invited: 'Invited',
  arrived: 'Arrived',
  did_something: 'Did something',
  invited_someone: 'Invited someone',
};

const SCREENS: Record<string, string> = {
  home: 'Home',
  discover: 'Discover',
  communities: 'Communities',
  challenges: 'Challenges',
  profile: 'Profile',
  my_proposals: 'My proposals',
  settings: 'Settings',
  messages: 'Messages',
  assistant: 'Assistant',
  agent_session: 'Agent session',
  app: 'A project',
  project: 'Project page',
  username_sheet: 'Username sheet',
  terms_sheet: 'Terms sheet',
  join_sheet: 'Join screen',
  tour: 'Tour',
  back: 'Back',
};

const WAYS: Record<string, string> = {
  own: 'on their own',
  nudged: 'from a notification',
  handed: 'from an invite link',
  address: 'from an address',
  back: 'by going back',
  returned: 'coming back after a break',
};

// Local class recipes: complete literals, because Tailwind's extractor is a
// regex over this file's source (see the AdminUI note in admin-console.js).
const JUI = Object.freeze({
  card: `${AdminUI.card} p-4 sm:p-5`,
  blockTitle: 'text-base font-semibold text-zinc-900 dark:text-zinc-100',
  headline: 'text-5xl font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100',
  label: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  fine: 'text-xs text-zinc-500 dark:text-zinc-400',
  row: 'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0',
  name: 'font-medium text-violet-700 dark:text-violet-400 hover:underline',
  dialogPanel: 'w-full max-w-2xl max-h-[82vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-xl',
  chip: 'inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 py-0.5 ps-0.5 pe-2 text-xs font-medium text-zinc-800 dark:text-zinc-200 transition-colors',
  chipOn: 'bg-violet-600 text-white',
  chipOff: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
  path: 'flex flex-wrap gap-1 text-xs',
  empty: 'bg-zinc-200 dark:bg-zinc-700',
  avatar: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-500/25 text-[11px] font-semibold text-violet-800 dark:text-violet-200',
  chipTap: 'hover:bg-zinc-200 dark:hover:bg-zinc-700',
  chipDashed: 'border border-dashed border-zinc-300 dark:border-zinc-600 bg-transparent dark:bg-transparent text-zinc-500 dark:text-zinc-400',
  // The filter bar's controls are one family: 24px pills, chips, arrows and
  // the search alike, so nothing in the bar stands taller than the rest.
  cohort: 'inline-flex h-6 items-center rounded-full px-3 text-xs font-medium transition-colors',
  stepper: 'inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40',
  search: 'h-6 w-full sm:w-44 rounded-full border-0 bg-zinc-100 dark:bg-zinc-800 px-3 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500',
  // Nine steps, then the onboard column, then days since.
  mileGrid: 'grid items-center gap-x-1 gap-y-1.5 grid-cols-[repeat(10,minmax(0,1fr))_2.5rem] sm:grid-cols-[7.5rem_repeat(10,minmax(0,1fr))_2.5rem]',
  // A column label is a button: tapping it says what the column counts.
  mileLabel: 'w-full min-w-0 rounded text-center text-[10px] leading-tight tracking-tight text-zinc-500 dark:text-zinc-400 underline decoration-dotted decoration-zinc-400 dark:decoration-zinc-500 underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
  mileHelp: 'absolute top-full z-20 mt-1 w-56 max-w-[70vw] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-start text-xs font-normal normal-case leading-snug tracking-normal text-white dark:text-zinc-900 shadow-lg',
  // The creation path by week: the week, then one column per step.
  weekGrid: 'grid items-start gap-x-2 gap-y-1 grid-cols-[3.5rem_repeat(5,minmax(0,1fr))]',
  pathStep: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300',
});

// ── Types (the parts of the payloads this page reads) ──────────────────

type NotRecorded = { recorded: false; reason: string };
type Count = number | NotRecorded | null | undefined;
type Person = { userId: number | null; name: string };
type Group = { slug: string; name: string; changes?: number; people: Person[]; lifecycle: string; why?: string };
type Turn = {
  project: string; slug: string; number: number; title: string; reporter?: Person | null;
  step: string; since: string; days: number; holder: string | null;
};
type Stuck = { userId: number | null; name: string; cohort: string; stuckAt: string; reason: string | null; days: number; failedAttempts: number };
type MileStep = { key: string; state: string; at: string | null; note: string | null; weak?: boolean };
type MilePerson = {
  userId: number | null; name: string; steps: MileStep[]; furthest: string | null; stuckAt: string | null;
  stuckReason: string | null; daysSince: number; failedAttempts: number; repeatedTaps: number;
  tour: { ended: string; step: number | null; at: string | null } | null;
  // The first-run list: the tour and the season's First challenges, x of n.
  // `null` without an account; `shown: false` for an account from before it.
  onboard?: { shown: boolean; done: number | null; total: number | null; complete: boolean } | null;
  // What the admit mail's tracking saw; `null` when it was not tracked.
  mail?: { opened: boolean; clicked: boolean } | null;
};
type Summary = {
  demo?: boolean;
  allTime?: boolean;
  week: string;
  thisWeekSoFar: { week: string; count: number };
  groups: {
    week: string; finished: boolean; count: number; trend?: Array<{ week: string; count: number }>;
    groups: Group[]; wentQuiet: Group[];
    oneShort: Group[]; homeroom: { changes: number; people: number } | null;
  };
  stuck: Stuck[];
  openTurns: Turn[];
  trust: {
    withoutGroupVote: { count: number; of: number; atLeastForced: number; changes: Array<{ slug: string; project: string; author: string; forced: boolean }> };
    teamShare: { team: number; of: number };
    lockstep: { possible: Array<{ userId: number; name: string; yesVotes: number; withinSeconds: number }>; cutoffs: Record<string, number> };
  };
  coverage: { week?: string; activePeople: number; withNavigation: number; byDay: Array<{ day: string; build: string; rows: number }> };
};

type OpenPerson = (userId: number) => void;
type DialogKey = 'leftout' | 'checks';

// ── Small pieces ───────────────────────────────────────────────────────

function isNotRecorded(v: unknown): v is NotRecorded {
  return !!v && typeof v === 'object' && (v as NotRecorded).recorded === false;
}

/** A count, or "not recorded yet" with its reason: never a silent zero. */
function Num({ v }: { v: Count }) {
  if (isNotRecorded(v)) return <span className={JUI.fine} title={v.reason}>not recorded yet</span>;
  if (v == null) return <span>—</span>;
  return <span>{v}</span>;
}

function weekLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

function gap(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return '';
  const mins = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 60) return `+${mins} min`;
  if (mins < 48 * 60) return `+${Math.round(mins / 60)} h`;
  return `+${Math.round(mins / 1440)} days`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function days(n: number | null | undefined): string {
  if (n == null) return '';
  return n === 1 ? '1 day' : `${n} days`;
}

function screenLabel(code: string): string {
  const [screen, slug] = code.split(':');
  if (slug) return slug;
  return SCREENS[screen] || screen;
}

function NameButton({ person, onOpen }: { person: Person | null | undefined; onOpen: OpenPerson }) {
  if (!person) return <span className={JUI.fine}>nobody</span>;
  if (person.userId == null) return <span>{person.name}</span>;
  const id = person.userId;
  return (
    <button type="button" className={JUI.name} data-journey-person={id} onClick={() => onOpen(id)}>
      {person.name}
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={AdminUI.muted}>{children}</p>;
}

// ── Data loading ───────────────────────────────────────────────────────

function withDemo(path: string): string {
  if (!DEMO) return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

// What the page is narrowed to: a week (YYYY-MM-DD) or "all", and one admit
// cohort or everyone. A person is not a filter: they get a view of their own.
type Scope = { week: string; cohort: string | null };

function scoped(path: string, scope: Scope, { week = true }: { week?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (week) q.set('week', scope.week);
  if (scope.cohort) q.set('cohort', scope.cohort);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** One GET, re-run when `path` changes; a late answer never replaces a newer one. */
function useJourney<T>(path: string | null): { data: T | null; failed: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) return undefined;
    const mine = ++seq.current;
    setFailed(false);
    consoleApi().fetchJson(withDemo(path)).then((res: { ok: boolean; data: T | null }) => {
      if (mine !== seq.current) return;
      if (!res.ok || !res.data) { setFailed(true); setData(null); return; }
      setData(res.data);
    });
    return () => { seq.current += 1; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, failed, reload };
}

function Loading({ failed, what }: { failed: boolean; what: string }) {
  if (failed) return <p className={AdminUI.muted}>Could not load {what}. Try Refresh.</p>;
  return <p className={AdminUI.loading}>Loading {what}…</p>;
}

// ── Dialog shell ───────────────────────────────────────────────────────

function Dialog({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Only the topmost dialog answers Escape: a person opened from inside
    // another dialog closes on its own.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('[data-journey-dialog]');
      if (open[open.length - 1] === panel.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={AdminUI.dialogOverlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div id={id} ref={panel} tabIndex={-1} data-journey-dialog="" role="dialog" aria-modal="true" aria-label={title}
        className={`${JUI.dialogPanel} outline-none`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className={AdminUI.sectionTitle}>{title}</h3>
          <button type="button" className={`${AdminUI.btn.ghost} text-xl leading-none px-1`} aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}


type Cohorts = { cohorts: Array<{ day: string; admitted: number; withAccount: number }>; otherWay: { people: number } };
type FirstMile = {
  cohort: string; people: MilePerson[];
  steps: Array<{ key: string; passed: number; stuck: Array<Person & { days: number; reason: string | null }> }>;
  mail?: { tracked: number; opened: number; clicked: number } | NotRecorded;
  notRecorded?: Record<string, NotRecorded>;
};

type Stages = {
  week: string; finished: boolean; counts: Record<string, Count>;
  stoppedAt: Record<string, Person[]>;
  people: Array<Person & { activateKinds: string[] }>;
};

type Coming = { status: 'coming' };
type Loops = {
  change: {
    week: string; steps: string[]; atStep: Record<string, number | Coming>; turnsClosed: Coming | number;
    live: Turn[]; open: Turn[];
    perProject: Array<{ slug: string; project: string; thisWeek: number; lastWeek: number; alsoLastWeek: boolean }>;
  };
  invite: {
    steps: string[]; counts: Record<string, number>;
    pairs: Array<{ host: Person; invitee: Person; letInAt: string; arrived: boolean; didSomething: boolean; invitedSomeone: boolean }>;
  };
};

type InvitePair = Loops['invite']['pairs'][number];

function isComing(v: unknown): v is Coming {
  return !!v && typeof v === 'object' && (v as Coming).status === 'coming';
}

type NextSteps = {
  people: number;
  leftOut: { droppedEvents: number[]; noNavigation: number[] };
  starts: Array<{ screen: string; visits: number; people: number }>;
  rows: Array<{
    screen: string; moves: number; people: number;
    next: Array<{ to: string; moves: number; people: number }>;
    other: number; left: { moves: number; people: number }; deadEnd: boolean; few: boolean;
  }>;
};

// ── Chart pieces ───────────────────────────────────────────────────────
//
// Every mark carries its count. At one to six people a share or a rate
// would claim more than the data holds, so small counts are drawn as units
// you can count (one cell per change or person) and only a large total
// becomes a single bar.

const UNIT_MAX = 24;

// `also` more after the first `n`, in `alsoFill`: one count in two parts.
function UnitBar({ n, of, fill, rest = JUI.empty, also = 0, alsoFill = fill }: {
  n: number; of: number; fill: string; rest?: string; also?: number; alsoFill?: string;
}) {
  if (of <= 0) return <div className={`h-2 rounded-sm ${JUI.empty}`} />;
  if (of > UNIT_MAX) {
    return (
      <div className={`flex h-2 rounded-sm overflow-hidden ${rest}`}>
        <div className={`h-2 ${fill}`} style={{ width: `${Math.round((n / of) * 100)}%` }} />
        {also > 0 ? <div className={`h-2 ${alsoFill}`} style={{ width: `${Math.round((also / of) * 100)}%` }} /> : null}
      </div>
    );
  }
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`h-2 flex-1 rounded-sm ${i < n ? fill : i < n + also ? alsoFill : rest}`} />
      ))}
    </div>
  );
}

function Dot({ cls }: { cls: string }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />;
}

/** A person as a small chip: their initial and name; tapping opens them. */
function PersonChip({ person, onOpen, dashed = false }: { person: Person; onOpen: OpenPerson; dashed?: boolean }) {
  const initial = (person.name || '?').replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?';
  const body = (
    <>
      <span aria-hidden="true" className={JUI.avatar}>{initial}</span>
      <span className="truncate min-w-0 max-w-[7rem]">{person.name}</span>
    </>
  );
  if (person.userId == null) return <span className={`${JUI.chip} max-w-full ${dashed ? JUI.chipDashed : ''}`}>{body}</span>;
  const id = person.userId;
  return (
    <button type="button" className={`${JUI.chip} ${JUI.chipTap} max-w-full`} data-journey-person={id} onClick={() => onOpen(id)}>{body}</button>
  );
}

function Chips({ people, onOpen }: { people: Person[]; onOpen: OpenPerson }) {
  return (
    <span className="flex flex-wrap gap-1">
      {people.map((p, i) => <PersonChip key={`${p.userId ?? p.name}-${i}`} person={p} onOpen={onOpen} />)}
    </span>
  );
}

function Card({ id, title, note, action, children }: {
  id: string; title: string; note?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section id={id} className={JUI.card}>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className={JUI.blockTitle}>{title}</h3>
        <span className="flex items-baseline gap-2">
          {note ? <span className={JUI.fine}>{note}</span> : null}
          {action}
        </span>
      </div>
      {children}
    </section>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className={`flex flex-wrap gap-x-3 gap-y-1 mt-2 ${JUI.fine}`}>
      {items.map(([cls, label]) => <span key={label} className="inline-flex items-center gap-1"><Dot cls={cls} />{label}</span>)}
    </div>
  );
}

// ── North Star ─────────────────────────────────────────────────────────

const LIFECYCLE_FILL: Record<string, string> = {
  new: 'bg-emerald-500',
  back: 'bg-violet-500',
  still_active: 'bg-zinc-400 dark:bg-zinc-500',
  went_quiet: 'bg-amber-400',
};

// Up to twelve weeks sit beside the number with a count on every bar; a
// longer history ("all time") takes the card's width, and only the week
// shown and the highest week carry their count.
const TREND_LABELLED = 12;

function Trend({ trend, shown, label = 'Active groups' }: { trend: Array<{ week: string; count: number }>; shown: string; label?: string }) {
  if (!trend.length) return null;
  const max = Math.max(1, ...trend.map((t) => t.count));
  const many = trend.length > TREND_LABELLED;
  return (
    <div className={many ? 'w-full' : 'shrink-0'} aria-label={`${label} over ${trend.length} weeks`}>
      <div className={`flex items-end h-14 ${many ? 'gap-0.5' : 'gap-1'}`}>
        {trend.map((t) => (
          <div key={t.week} className={`flex flex-col items-center justify-end h-full ${many ? 'flex-1 min-w-0' : 'w-5'}`}>
            <span className="text-[11px] leading-none mb-0.5 text-zinc-500 dark:text-zinc-400">
              {!many || t.week === shown || t.count === max ? t.count : ''}
            </span>
            <div className={`w-full rounded-sm ${t.week === shown ? 'bg-violet-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
              style={{ height: `${Math.max(4, Math.round((t.count / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className={`flex justify-between mt-1 ${JUI.fine}`}>
        <span>{weekLabel(trend[0].week)}</span><span>{weekLabel(trend[trend.length - 1].week)}</span>
      </div>
    </div>
  );
}

// The card in three blocks, each holding one kind of thing:
//   the number (count, change, trend, and what it leaves out);
//   the groups, under one heading per status, so the status is said once;
//   the votes behind it, in an inset, since both readings ask one question.
const STATUS_ORDER: Array<[string, string]> = [
  ['new', 'New'], ['back', 'Back'], ['still_active', 'Still active'], ['went_quiet', 'Went quiet'],
];

function GroupRow({ grp, onOpen, note }: { grp: Group; onOpen: OpenPerson; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 ps-4" data-journey-group={grp.slug}>
      <span className="text-sm font-medium truncate w-28 shrink-0">{grp.name}</span>
      <Chips people={grp.people} onOpen={onOpen} />
      {note ? <span className={JUI.fine}>{note}</span> : null}
    </div>
  );
}

function StatusHeading({ dot, label, count }: { dot: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
      <Dot cls={dot} />{label}<span className="tabular-nums text-zinc-500 dark:text-zinc-400">{count}</span>
    </div>
  );
}

function NorthStarCard({ s, scope, onOpen, onDetails }: { s: Summary; scope: Scope; onOpen: OpenPerson; onDetails: () => void }) {
  const g = s.groups;
  const trend = g.trend || [];
  const prev = trend.length > 1 ? trend[trend.length - 2].count : null;
  const delta = prev == null ? null : g.count - prev;
  const vote = s.trust.withoutGroupVote;
  const lockstep = s.trust.lockstep.possible || [];
  const statuses = STATUS_ORDER.map(([key, label]) => ({
    key, label, groups: key === 'went_quiet' ? g.wentQuiet : g.groups.filter((x) => x.lifecycle === key),
  })).filter((x) => x.groups.length);
  return (
    <Card id="admin-journey-groups" title="Active groups"
      note={`week of ${weekLabel(g.week)}${g.finished ? '' : ', so far'}`}
      action={<button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={onDetails}>Details</button>}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div id="admin-journey-north-star" className={JUI.headline}>{g.count}</div>
          <div className={`${JUI.fine} mt-1`}>
            {delta == null ? '' : delta === 0 ? 'same as the week before' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} on the week before`}
          </div>
          {g.homeroom && !scope.cohort ? (
            <div className={JUI.fine}>Homeroom itself not counted ({g.homeroom.changes} live, {g.homeroom.people} people)</div>
          ) : null}
        </div>
        <Trend trend={trend} shown={g.week} />
      </div>

      <div className="mt-5 space-y-3" id="admin-journey-statuses">
        {statuses.map((st) => (
          <div key={st.key} className="space-y-1.5" data-journey-status={st.key}>
            <StatusHeading dot={LIFECYCLE_FILL[st.key]} label={st.label} count={st.groups.length} />
            {st.groups.map((grp) => <GroupRow key={grp.slug} grp={grp} onOpen={onOpen} />)}
          </div>
        ))}
        {g.oneShort.length ? (
          <div className="space-y-1.5" data-journey-status="one_short">
            <StatusHeading dot="border border-dashed border-zinc-400 dark:border-zinc-500" label="One short" count={g.oneShort.length} />
            {g.oneShort.map((grp, i) => <GroupRow key={`${grp.slug}-${i}`} grp={grp} onOpen={onOpen} note={grp.why} />)}
          </div>
        ) : null}
        {!statuses.length && !g.oneShort.length ? <Empty>No project had a group this week.</Empty> : null}
      </div>

      {/* The votes behind the number, read for the whole platform, so a
          cohort view leaves them out rather than show them as the cohort's. */}
      {scope.cohort ? null : (
        <div id="admin-journey-checks" className="mt-5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 p-3 space-y-2.5">
          <div className={JUI.label}>The votes behind it</div>
          <div>
            <div className="flex justify-between gap-2 text-sm mb-1">
              <span>Live changes with a yes from someone else</span>
              <span className="tabular-nums shrink-0">{vote.of - vote.count} / {vote.of}</span>
            </div>
            <UnitBar n={vote.of - vote.count} of={vote.of} fill="bg-violet-500" rest="bg-amber-400" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span aria-hidden="true" className={lockstep.length ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>
              {lockstep.length ? '!' : '✓'}
            </span>
            <span>{lockstep.length ? 'Voting in lockstep' : 'Nobody voting in lockstep'}</span>
            {lockstep.length ? <Chips people={lockstep} onOpen={onOpen} /> : null}
          </div>
        </div>
      )}
    </Card>
  );
}

// ── First mile ─────────────────────────────────────────────────────────

const MILE_SHORT: Record<string, string> = {
  admitted: 'admit', mail_sent: 'mail', code_asked: 'link', account: 'acct', access: 'in',
  opened: 'open', username: 'name', join: 'join', first_act: 'act',
};

const STEP_FILL: Record<string, string> = {
  done: 'bg-violet-500',
  skipped: 'bg-violet-300 dark:bg-violet-400/50',
  unknown: 'bg-violet-300 dark:bg-violet-400/50',
  stuck: 'bg-amber-400',
  not_yet: 'bg-zinc-200 dark:bg-zinc-700',
};

// The mail column in three shades (#6138): opened is the step's done fill,
// sent but not opened is the staircase's plain fill, and a mail sent before
// tracking began is striped, because nothing is known about it either way.
const MAIL_FILL = {
  opened: 'bg-violet-500',
  unopened: 'bg-violet-300 dark:bg-violet-400/50',
  untracked: 'bg-[repeating-linear-gradient(135deg,theme(colors.violet.500)_0_2px,theme(colors.violet.100)_2px_5px)] dark:bg-[repeating-linear-gradient(135deg,theme(colors.violet.500)_0_2px,theme(colors.violet.900)_2px_5px)]',
};

/** A person's mail cell: what its tracking saw, once the mail is past. */
function mailFill(p: MilePerson, state: string): string {
  if (state !== 'done' && state !== 'skipped' && state !== 'unknown') return STEP_FILL[state] || STEP_FILL.not_yet;
  return !p.mail ? MAIL_FILL.untracked : p.mail.opened ? MAIL_FILL.opened : MAIL_FILL.unopened;
}

/**
 * One cohort's admit mail, said on its line: "3 of 5 opened", then how
 * many sit unopened and for how long (the oldest of them: a cohort's mail
 * goes out on its admit day, so they are usually all the same). Empty when
 * nobody in the cohort was mailed (they came in another way).
 */
function cohortMail(people: MilePerson[], nowMs: number): string {
  const mailed = people.filter((p) => p.steps.some((st) => st.key === 'mail_sent' && st.state !== 'stuck' && st.state !== 'not_yet'));
  if (!mailed.length) return '';
  const tracked = mailed.filter((p) => p.mail);
  if (!tracked.length) return ' · mail not tracked';
  const unopened = tracked.filter((p) => !p.mail!.opened);
  let said = ` · ${tracked.length - unopened.length} of ${tracked.length} opened`;
  if (unopened.length) {
    const sentAt = unopened.map((p) => p.steps.find((st) => st.key === 'mail_sent')?.at).filter((at): at is string => !!at);
    const oldest = sentAt.length ? Math.min(...sentAt.map((at) => new Date(at).getTime())) : null;
    // In the tracks' own unit, "4 d", like the days column beside them.
    said += ` · ${unopened.length} sent, not opened${oldest != null ? `, ${Math.floor((nowMs - oldest) / 86_400_000)} d` : ''}`;
  }
  return said;
}

const MILE_KEYS = Object.keys(MILE_STEPS);

// What each column counts, said where its label is tapped. Plain words and
// the evidence behind each, because a three-letter label does not say that
// "mail" is the provider taking the message, not the inbox getting it.
const MILE_HELP: Record<string, string> = {
  admitted: 'Let in from the waitlist.',
  mail_sent: 'Our mail provider accepted the \u201cYou\u2019re in\u201d mail. Dark: opened. Light: sent, not opened. Striped: sent before tracking began on 7 Oct, so there is no record either way. The number over the bar is opened of tracked. An open is approximate, and no open is not proof it went unread.',
  code_asked: 'The mail\u2019s button was followed: its one-time sign-in link was used, or a sign-in code was asked for after the admit (the page asks for one when the link no longer works). A used link counts as a click on the mail even where opens are not tracked.',
  account: 'Account created and finished.',
  access: 'The account has platform access.',
  opened: 'Opened Homeroom for the first time.',
  username: 'Chose a username. No time is recorded for it.',
  join: 'Answered \u201cWhat communities do you want to join?\u201d, or was not asked (an invite link or the story landing).',
  first_act: 'The first thing they did themselves: a message, a vote, feedback, a request, a change, using a project or joining a community.',
  onboard: 'How much of a new account\u2019s first run is done: the tour, then the season\u2019s First challenges. \u2014 means the account is from before the first-run list.',
};

const HELP_KEYS = [...MILE_KEYS, 'onboard'];

/**
 * A column label that says what its column counts. Tap (or click) opens a
 * small note under it and tap again, Escape or a tap anywhere else closes
 * it; a mouse hovering shows the same note. Never a `title`: a phone has no
 * hover, so the note has to open on a tap.
 */
function MileLabel({ id, label, open, onOpen, onClose }: {
  id: string; label: string; open: 'tap' | 'hover' | null;
  onOpen: (how: 'tap' | 'hover') => void; onClose: () => void;
}) {
  const i = HELP_KEYS.indexOf(id);
  // Keep the note on the card: the first columns open rightwards, the last
  // ones leftwards, the middle ones centred under the label.
  const side = i < 3 ? 'start-0' : i > HELP_KEYS.length - 4 ? 'end-0' : 'left-1/2 -translate-x-1/2';
  return (
    <span className="relative min-w-0" data-journey-mile-label={id}>
      <button type="button" className={JUI.mileLabel} aria-expanded={open != null}
        aria-controls={open ? `journey-mile-help-${id}` : undefined}
        onClick={() => (open === 'tap' ? onClose() : onOpen('tap'))}
        // Over/out rather than enter/leave: the console's sections render
        // through a portal, where React's synthetic enter/leave did not fire.
        onPointerOver={(e) => { if (e.pointerType === 'mouse' && !open) onOpen('hover'); }}
        onPointerOut={(e) => { if (e.pointerType === 'mouse' && open === 'hover') onClose(); }}>
        {label}
      </button>
      {open ? (
        <span id={`journey-mile-help-${id}`} role="note" className={`${JUI.mileHelp} ${side}`}>{MILE_HELP[id]}</span>
      ) : null}
    </span>
  );
}

/** The onboard cell: x/n, a dash for an account from before the first-run list. */
function OnboardCell({ onboard }: { onboard: MilePerson['onboard'] }) {
  if (!onboard || !onboard.shown) {
    return <span className="text-center text-[11px] leading-none text-zinc-400 dark:text-zinc-500">{'\u2014'}</span>;
  }
  return (
    <span className={`text-center text-[11px] leading-none tabular-nums ${onboard.complete
      ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
      {onboard.done}/{onboard.total}
    </span>
  );
}

// The first mile of several cohorts at once ("everyone"): one read per
// cohort, all or nothing.
function useMiles(days: string[] | null): { miles: FirstMile[] | null; failed: boolean } {
  const [miles, setMiles] = useState<FirstMile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = days ? days.join(',') : null;
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    setMiles(null);
    setFailed(false);
    Promise.all(key.split(',').map((d) => consoleApi().fetchJson(withDemo(`/api/admin/journey/first-mile?admitted=${d}`))))
      .then((rs: Array<{ ok: boolean; data: FirstMile | null }>) => {
        if (!live) return;
        if (rs.some((x) => !x.ok || !x.data)) { setFailed(true); return; }
        setMiles(rs.map((x) => x.data as FirstMile));
      });
    return () => { live = false; };
  }, [key]);
  return { miles, failed };
}

function FirstMileCard({ cohorts, scope, onOpen }: { cohorts: Cohorts | null; scope: Scope; onOpen: OpenPerson }) {
  const days = scope.cohort ? [scope.cohort]
    : cohorts ? [...cohorts.cohorts.map((c) => c.day), 'other_way'] : null;
  const { miles, failed } = useMiles(days);
  const groups = (miles || []).filter((m) => m.people.length);
  const people = groups.flatMap((m) => m.people);
  const n = people.length;
  // Every person on the same nine columns. Someone who came in another way
  // has no admit, mail or code step: those cells are drawn empty, dashed.
  const cellOf = (p: MilePerson, key: string) => p.steps.find((st) => st.key === key) || null;
  const passed = (key: string) => people.filter((p) => {
    const st = cellOf(p, key);
    return st && (st.state === 'done' || st.state === 'skipped' || st.state === 'unknown');
  }).length;
  const label = (cohort: string) => (cohort === 'other_way' ? 'Came in another way' : `Admitted ${weekLabel(cohort)}`);
  const onboarded = people.filter((p) => p.onboard && p.onboard.complete).length;
  const nowMs = Date.now();
  // The mail bar in the three shades of its cells, and its count as opened
  // of tracked; with nothing tracked it is a plain bar with a plain count.
  const mailPast = people.filter((p) => {
    const st = cellOf(p, 'mail_sent');
    return st && (st.state === 'done' || st.state === 'skipped' || st.state === 'unknown');
  });
  const mailParts = {
    opened: mailPast.filter((p) => p.mail && p.mail.opened).length,
    unopened: mailPast.filter((p) => p.mail && !p.mail.opened).length,
    untracked: mailPast.filter((p) => !p.mail).length,
  };
  const mailTracked = mailParts.opened + mailParts.unopened;
  // One column note open at a time, and how it opened: a tap keeps it until
  // the next tap, a hover only while the mouse stays.
  const [help, setHelp] = useState<{ id: string; how: 'tap' | 'hover' } | null>(null);
  useEffect(() => {
    if (!help || help.how !== 'tap') return undefined;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-journey-mile-label]')) setHelp(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelp(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [help]);
  const labelFor = (id: string, text: string) => (
    <MileLabel key={id} id={id} label={text} open={help && help.id === id ? help.how : null}
      onOpen={(how) => setHelp({ id, how })} onClose={() => setHelp(null)} />
  );
  return (
    <Card id="admin-journey-mile" title="First mile" note={`admit mail to first act · ${scope.cohort ? 'this cohort' : 'every cohort'}, any week`}>
      {miles ? (n ? (
        <>
          {/* One grid for the staircase and every track, so each bar stands
              over its own column of cells. On a phone the name takes a row
              of its own and the nine columns keep the full width. */}
          <div className={JUI.mileGrid}>
            <span className="hidden sm:block" />
            {MILE_KEYS.map((key, i) => (key === 'mail_sent' && mailTracked ? (
              <div key={key} className="flex flex-col items-stretch justify-end h-16" data-journey-mile-step={key}>
                <span className="text-center text-[11px] leading-none mb-0.5 font-semibold text-violet-700 dark:text-violet-400">{mailParts.opened}/{mailTracked}</span>
                <div className="flex flex-col-reverse rounded-sm overflow-hidden"
                  style={{ height: `${Math.max(4, Math.round((passed(key) / n) * 100))}%` }}>
                  {(['opened', 'unopened', 'untracked'] as const).map((part) => (mailParts[part]
                    ? <div key={part} className={`basis-0 min-h-0 ${MAIL_FILL[part]}`} style={{ flexGrow: mailParts[part] }} />
                    : null))}
                </div>
              </div>
            ) : (
              <div key={key} className="flex flex-col items-stretch justify-end h-16" data-journey-mile-step={key}>
                <span className="text-center text-[11px] leading-none mb-0.5 text-zinc-500 dark:text-zinc-400">{passed(key)}</span>
                <div className={`rounded-sm ${i === MILE_KEYS.length - 1 ? 'bg-emerald-500' : 'bg-violet-300 dark:bg-violet-400/50'}`}
                  style={{ height: `${Math.max(4, Math.round((passed(key) / n) * 100))}%` }} />
              </div>
            )))}
            <div className="flex flex-col items-stretch justify-end h-16" data-journey-mile-step="onboard">
              <span className="text-center text-[11px] leading-none mb-0.5 text-zinc-500 dark:text-zinc-400">{onboarded}</span>
              <div className="rounded-sm bg-violet-300 dark:bg-violet-400/50"
                style={{ height: `${Math.max(4, Math.round((onboarded / n) * 100))}%` }} />
            </div>
            <span />
            <span className="hidden sm:block" />
            {MILE_KEYS.map((key) => labelFor(key, MILE_SHORT[key] || key))}
            {labelFor('onboard', 'onboard')}
            <span />
            {groups.map((m) => (
              <div key={m.cohort} className="contents">
                <span className={`col-span-full mt-2 ${JUI.label}`}>{label(m.cohort)} · {m.people.length}{cohortMail(m.people, nowMs)}</span>
                {m.people.map((p, i) => {
                  const done = p.steps.every((st) => st.state === 'done' || st.state === 'skipped' || st.state === 'unknown');
                  return (
                    <div key={`${p.userId ?? p.name}-${i}`} className="contents">
                      <span className="col-span-11 sm:col-span-1 min-w-0 mt-1 sm:mt-0"><PersonChip person={p} onOpen={onOpen} /></span>
                      {MILE_KEYS.map((key) => {
                        const st = cellOf(p, key);
                        return st
                          ? <span key={key} className={`h-2.5 rounded-sm ${key === 'mail_sent' ? mailFill(p, st.state) : STEP_FILL[st.state] || STEP_FILL.not_yet}`} />
                          : <span key={key} className="h-2.5 rounded-sm border border-dashed border-zinc-300 dark:border-zinc-600" />;
                      })}
                      <OnboardCell onboard={p.onboard} />
                      <span className={`text-end text-xs tabular-nums ${p.stuckAt ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                        {p.stuckAt ? `${p.daysSince} d` : done ? '✓' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <Legend items={[[STEP_FILL.done, 'done, mail opened'], [MAIL_FILL.unopened, 'mail sent, not opened'],
            [MAIL_FILL.untracked, 'mail not tracked'], [STEP_FILL.stuck, 'stuck, days since'], [STEP_FILL.not_yet, 'not yet']]} />
        </>
      ) : <Empty>Nobody here yet.</Empty>) : days ? <Loading failed={failed} what="the first mile" /> : null}
    </Card>
  );
}

// ── Stages ─────────────────────────────────────────────────────────────

function StagesCard({ scope, onNames }: { scope: Scope; onNames: (n: NamesList) => void }) {
  const { data, failed } = useJourney<Stages>(scoped('/api/admin/journey/stages', scope));
  if (!data) return <Card id="admin-journey-stages" title="Stages"><Loading failed={failed} what="the stages" /></Card>;
  const nums = STAGES.map(([k]) => data.counts[k]).filter((v): v is number => typeof v === 'number');
  const max = Math.max(1, ...nums);
  return (
    <Card id="admin-journey-stages" title="Stages"
      note={data.week === 'all' ? 'all time · furthest each person reached' : `week of ${weekLabel(data.week)} · one yes or no per person`}>
      <div className="space-y-1.5">
        {STAGES.map(([key, label, means]) => {
          const v = data.counts[key];
          // Reaching the last stage is the end of the journey, not a stop.
          const stopped = key === STAGES[STAGES.length - 1][0] ? [] : (data.stoppedAt[key] || []);
          const reached = data.people.filter((p) => (p as unknown as Record<string, unknown>)[key] === true);
          const open = () => onNames({ title: label, note: means, sections: [
            { label: 'Went no further', people: stopped },
            { label: 'Reached it', people: reached },
          ] });
          return (
            <button key={key} type="button" className="grid w-full grid-cols-[4.5rem_1fr_1.5rem] items-center gap-2 text-start text-sm rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              data-journey-stage={key} onClick={open}>
              <span>{label}</span>
              {typeof v === 'number' ? (
                <span className="flex h-3.5" style={{ width: `${Math.max(2, Math.round((v / max) * 100))}%` }}>
                  <span className="h-full flex-1 rounded-l-sm bg-violet-300 dark:bg-violet-400/50" />
                  {stopped.length ? <span className="h-full rounded-r-sm bg-amber-400" style={{ width: `${Math.round((Math.min(stopped.length, v) / Math.max(1, v)) * 100)}%` }} /> : null}
                </span>
              ) : <span className={`h-3.5 rounded-sm border border-dashed border-zinc-300 dark:border-zinc-600 ${JUI.fine} text-[11px] leading-3 px-1`}>not recorded yet</span>}
              <span className="text-end tabular-nums"><Num v={typeof v === 'number' ? v : null} /></span>
            </button>
          );
        })}
      </div>
      <Legend items={[['bg-violet-300 dark:bg-violet-400/50', 'reached'], ['bg-amber-400', 'went no further']]} />
    </Card>
  );
}

// ── Change loop ────────────────────────────────────────────────────────

// A loop drawn as a loop: its steps around a ring, clockwise, each with
// its count. The step that closes it is green; a step not built yet is a
// dashed node that says "coming".
function Ring({ label, steps, value, names, closes }: {
  label: string; steps: string[]; value: (key: string) => number | Coming | undefined;
  names: Record<string, string>; closes: string;
}) {
  const cx = 160; const cy = 112; const r = 68;
  const at = (i: number, rad: number) => {
    const a = ((-90 + (i * 360) / steps.length) * Math.PI) / 180;
    return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a), cos: Math.cos(a) };
  };
  // Wider than the ring: a side label as long as "Invited someone" has to fit.
  return (
    <svg viewBox="-75 0 470 228" className="w-full max-w-md mx-auto" role="img" aria-label={label}>
      <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-zinc-200 dark:stroke-zinc-700" strokeWidth={2} />
      {steps.map((key, i) => {
        const mid = ((-90 + ((i + 0.5) * 360) / steps.length) * Math.PI) / 180;
        const deg = (-90 + ((i + 0.5) * 360) / steps.length) + 90;
        return (
          <polygon key={`arrow-${key}`} points="-4,-4 3,0 -4,4" className="fill-zinc-300 dark:fill-zinc-600"
            transform={`translate(${cx + r * Math.cos(mid)} ${cy + r * Math.sin(mid)}) rotate(${deg})`} />
        );
      })}
      {steps.map((key, i) => {
        const p = at(i, r);
        const l = at(i, r + 32);
        const v = value(key);
        const coming = isComing(v);
        const closing = key === closes;
        const anchor = l.cos > 0.3 ? 'start' : l.cos < -0.3 ? 'end' : 'middle';
        return (
          <g key={key} data-journey-loop-step={key}>
            <circle cx={p.x} cy={p.y} r={20} strokeWidth={1.5} strokeDasharray={coming ? '3 3' : undefined}
              className={coming ? 'fill-white dark:fill-zinc-900 stroke-zinc-400 dark:stroke-zinc-500'
                : closing ? 'fill-emerald-100 dark:fill-emerald-500/25 stroke-emerald-500' : 'fill-violet-100 dark:fill-violet-500/25 stroke-violet-500'} />
            <text x={p.x} y={p.y + (coming ? 4 : 6)} textAnchor="middle" fontSize={coming ? 11 : 17} fontWeight={coming ? 400 : 600}
              className={coming ? 'fill-zinc-500 dark:fill-zinc-400' : 'fill-zinc-900 dark:fill-zinc-100'}>
              {coming ? 'coming' : String(v ?? 0)}
            </text>
            <text x={l.x} y={l.y + 5} textAnchor={anchor} fontSize={15} className="fill-zinc-500 dark:fill-zinc-400">
              {names[key] || key}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LoopCard({ data, failed, s, scope }: { data: Loops | null; failed: boolean; s: Summary; scope: Scope }) {
  if (!data) return <Card id="admin-journey-loop" title="Change loop"><Loading failed={failed} what="the change loop" /></Card>;
  const open = data.change.open;
  const maxDays = Math.max(1, ...open.map((t) => t.days || 0));
  const team = s.trust.teamShare;
  return (
    <Card id="admin-journey-loop" title="Change loop" note={data.change.week === 'all' ? 'all time · turns at each step' : `week of ${weekLabel(data.change.week)} · turns at each step`}>
      <Ring label="The change loop, turns at each step" steps={data.change.steps}
        value={(k) => data.change.atStep[k]} names={LOOP_STEPS} closes="go_live" />
      {/* Who made what went live this week: the loop is meant to be turned
          by people, so the team's share sits beside it. */}
      {scope.cohort ? null : <div className="mt-1 mb-4" id="admin-journey-team">
        <div className="flex justify-between text-sm mb-1">
          <span>Went live, week of {weekLabel(s.groups.week)}</span>
          <span className="tabular-nums">{team.of - team.team} by people · {team.team} by the team</span>
        </div>
        <UnitBar n={team.of - team.team} of={team.of} fill="bg-violet-500" rest="bg-zinc-300 dark:bg-zinc-600" />
      </div>}
      <div className={`${JUI.label} mt-2 mb-1.5`}>Open turns, days waiting</div>
      {open.length ? (
        <div className="space-y-2" id="admin-journey-turns">
          {open.map((t) => (
            <div key={`${t.slug}#${t.number}`} data-journey-turn={`${t.slug}#${t.number}`}>
              <div className="flex items-baseline gap-2 text-sm min-w-0">
                <span className="truncate">{t.project} #{t.number} {t.title}</span>
                <span className={`${JUI.fine} shrink-0`}>{LOOP_STEPS[t.step] || t.step}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="flex-1">
                  <div className={`h-2 rounded-sm ${t.holder ? 'bg-violet-300 dark:bg-violet-400/50' : 'bg-amber-400'}`}
                    style={{ width: `${Math.max(4, Math.round(((t.days || 0) / maxDays) * 100))}%` }} />
                </div>
                <span className="w-24 shrink-0 text-end text-xs text-zinc-500 dark:text-zinc-400 truncate">
                  {days(t.days)}{t.holder ? ` · ${t.holder}` : ''}
                </span>
              </div>
            </div>
          ))}
          <Legend items={[['bg-violet-300 dark:bg-violet-400/50', 'someone holds it'], ['bg-amber-400', 'nobody holds it']]} />
        </div>
      ) : <Empty>No open turns.</Empty>}
    </Card>
  );
}

// ── Invite loop ────────────────────────────────────────────────────────

const INVITE_DONE: Array<[keyof InvitePair, string]> = [['arrived', 'arrived'], ['didSomething', 'did something'], ['invitedSomeone', 'invited someone']];

function InviteCard({ data, failed, onOpen }: { data: Loops | null; failed: boolean; onOpen: OpenPerson }) {
  if (!data) return <Card id="admin-journey-invite" title="Invite loop"><Loading failed={failed} what="the invite loop" /></Card>;
  const inv = data.invite;
  return (
    <Card id="admin-journey-invite" title="Invite loop" note="people bringing people">
      <Ring label="The invite loop, people at each step" steps={inv.steps}
        value={(k) => inv.counts[k]} names={INVITE_STEPS} closes="invited_someone" />
      {inv.pairs.length ? (
        <div className="space-y-1.5 mt-1">
          {inv.pairs.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <PersonChip person={p.host} onOpen={onOpen} />
              <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-400">→</span>
              <PersonChip person={p.invitee} onOpen={onOpen} />
              <span className="flex gap-0.5 ms-1" aria-label={INVITE_DONE.filter(([k]) => p[k]).map(([, l]) => l).join(', ') || 'not arrived'}>
                {INVITE_DONE.map(([k]) => <span key={k} className={`h-2.5 w-5 rounded-sm ${p[k] ? 'bg-emerald-500' : JUI.empty}`} />)}
              </span>
            </div>
          ))}
          <p className={JUI.fine}>The three cells: arrived, did something, invited someone.</p>
        </div>
      ) : <Empty>Nobody came in through an invite link this week.</Empty>}
    </Card>
  );
}

// ── Creation path ──────────────────────────────────────────────────────
//
// What happens after somebody makes a project, each step timed from the
// moment they made it, against its target. People, not projects: a person
// counts once per step (src/services/journey.js creationPath). A step the
// platform only records from a later day reads "not recorded yet" for the
// weeks before, never 0.

type CreationStep = {
  key: string; reached: Count; of: number; medianSeconds: number | null;
  targetSeconds: number | null; withinTarget: number | null;
};
type Creation = {
  week: string; finished: boolean; steps: CreationStep[];
  targets: Record<string, number>;
  recordedFrom: Record<string, string | null>;
  weeks: Array<{ week: string; steps: Array<{ key: string; reached: Count; medianSeconds: number | null }> }>;
  timing?: CreationTimingSummary;
  firstVersion?: FirstVersionSummary | (NotRecorded & { from?: string | null });
  examples: Array<{
    userId: number; name: string; slug: string; project: string; createdAt: string;
    steps: Array<{ key: string; recorded: boolean; seconds: number | null }>;
    timing?: CreationTiming | null;
    asked?: string | null; template?: string | null; firstVersion?: FirstVersionBrief | null;
  }>;
};

// Where the time to running goes (#4895): each stage of making a project,
// its median over the projects made from a starter since creation was timed
// (src/services/journey.js creationTimingSummary). Each stage is its own
// clock: the database and the repository are made side by side, so the
// stages do not add up to the total.
type PodStart = { scheduleMs: number; startMs: number; readyMs: number };
type CreationTiming = {
  kind: string; totalMs: number | null; stages: Record<string, number>;
  build?: { engine: string; reused?: boolean; steps: Array<{ name: string; ms: number }> };
  pod?: PodStart;
};
type CreationTimingSummary = {
  from: string | null; of: number; totalMs: number | null;
  stages: Array<{ key: string; medianMs: number }>; pod: PodStart | null;
};

const TIMING_STAGES: Record<string, [string, string]> = {
  database: ['Database', 'its own Postgres database and role'],
  repository: ['Repository', 'its GitHub repository made and the starter committed'],
  card: ['Card', 'waiting for the first session\'s card, inside Repository'],
  checkout: ['Checkout', 'the starter written out for the image build'],
  lock: ['Build lock', 'waiting to share the build-retention lock'],
  manifest: ['Manifest', 'dapp.json read and reconciled, secrets checked'],
  build: ['Image build', 'its container image built'],
  deploy: ['Deploy', 'its Service, Deployment and Ingress applied'],
  rollout: ['Start', 'its Pod placed, its image pulled and started, until /health answered'],
};

/** Milliseconds as a short duration: "0.4 s", "4.3 s", "71 s", "1.5 min". */
function msDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 10000) return `${Math.round(ms / 100) / 10} s`;
  return dur(ms / 1000);
}

function CreationTimingRows({ timing }: { timing: CreationTimingSummary | undefined }) {
  if (!timing) return null;
  if (!timing.of) {
    return (
      <p className={JUI.fine}>
        {timing.from
          ? `No project made from a starter in this time was timed. Timed from ${weekLabel(timing.from.slice(0, 10))}.`
          : 'Not timed yet: each new project is timed from now on.'}
      </p>
    );
  }
  const most = Math.max(1, ...timing.stages.map((st) => st.medianMs));
  return (
    <div className="space-y-1">
      {timing.stages.map((st) => {
        const [label, means] = TIMING_STAGES[st.key] || [st.key, ''];
        return (
          <div key={st.key} data-journey-creation-stage={st.key} title={means}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
            <span className="truncate">{label}</span>
            <div className={`h-2 rounded-sm ${JUI.empty}`}>
              <div className="h-2 rounded-sm bg-violet-500" style={{ width: `${Math.max(2, Math.round((st.medianMs / most) * 100))}%` }} />
            </div>
            <span className="text-end tabular-nums">{msDur(st.medianMs)}</span>
          </div>
        );
      })}
      {timing.pod ? (
        <p className={JUI.fine} data-journey-creation-pod="">
          {`Start, from the Pod: placed ${msDur(timing.pod.scheduleMs)} · image pulled and started ${msDur(timing.pod.startMs)} · booted until healthy ${msDur(timing.pod.readyMs)}`}
        </p>
      ) : null}
      <p className={JUI.fine}>
        {`Median per stage over ${plural(timing.of, 'project', 'projects')} made from a starter, ${msDur(timing.totalMs)} in all. Each stage has its own clock: the database and the repository are made side by side, so the stages do not add up to the total.`}
      </p>
    </div>
  );
}

/** One project's slowest stages, and how its image was built. */
function exampleTiming(timing: CreationTiming): string {
  const top = Object.entries(timing.stages).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([key, ms]) => `${(TIMING_STAGES[key] || [key])[0]} ${msDur(ms)}`);
  const b = timing.build;
  const slowest = b && b.steps.length ? b.steps[0] : null;
  const built = b
    ? `built with ${b.engine}${b.reused ? ', reused' : ''}${slowest ? `, slowest ${slowest.name} ${msDur(slowest.ms)}` : ''}`
    : null;
  return [...top, ...(built ? [built] : [])].join(' · ');
}

// ── First versions ─────────────────────────────────────────────────────
//
// A first version the Homeroom bot builds, stage by stage as the pipeline
// records them (src/services/journey.js firstVersionSummary): how many
// projects reached each stage and how long each took, how each ended, where
// the ones not live are, and whether their maker was there when it went
// live. Projects, not people: a first version is one project's.

type FirstVersionSummary = {
  from: string | null; of: number;
  stages: Array<{ key: string; reached: number; medianFromStart: number | null; medianFromPrevious: number | null }>;
  outcomes: Record<string, number>;
  stoppedAt: Array<{ key: string; count: number }>;
  maker: { live: number; nearLive: number; cameBack: number; medianBackSeconds: number | null };
  stallMinutes: number; nearMinutes: number;
};
type FirstVersionBrief = { recorded: boolean; outcome: string | null; last: string | null };

// [stage, label, what it records], in pipeline order.
const FIRST_VERSION_STAGES: Array<[string, string, string]> = [
  ['plan_written', 'Plan written', 'its plan exists: written at Make it, or by the triage of its request'],
  ['go_ahead', 'Go-ahead', 'its maker tapped Build it, or Submit under the plan\u2019s questions'],
  ['picked_up', 'Build picked up', 'its build took its slot'],
  ['spec_started', 'Screens started', 'the screens it will have are being drawn'],
  ['first_look_saved', 'First look saved', 'its first look was drawn and kept'],
  ['build_started', 'Build started', 'the build turn began'],
  ['build_done', 'Build pushed', 'the build turn pushed its code'],
  ['review_round', 'Reviewed', 'a review round began'],
  ['testing_started', 'Checks started', 'it was proposed, so its checks began'],
  ['merged', 'Merged', 'its proposal merged'],
  ['live', 'Live', 'it answered on the build that was deployed'],
];
const FIRST_VERSION_LABEL: Record<string, string> = Object.fromEntries(FIRST_VERSION_STAGES.map(([key, label]) => [key, label]));

// [outcome, words, fill], from the best to the worst.
const FIRST_VERSION_OUTCOMES: Array<[string, string, string]> = [
  ['live', 'live', 'bg-emerald-500'],
  ['building', 'still building', 'bg-violet-500'],
  ['waiting', 'waiting on its maker', 'bg-violet-300 dark:bg-violet-400/50'],
  ['stalled', 'stalled', 'bg-amber-400'],
  ['failed', 'failed', 'bg-red-500'],
];
const OUTCOME_WORDS: Record<string, string> = Object.fromEntries(FIRST_VERSION_OUTCOMES.map(([key, words]) => [key, words]));

/** A project's first version in a few words: "first version live", "first version stalled at build picked up". */
function firstVersionWords(fv: FirstVersionBrief | null | undefined): string | null {
  if (!fv) return null;
  if (!fv.recorded || !fv.outcome) return 'first version not recorded';
  if (fv.outcome === 'live' || !fv.last) return `first version ${OUTCOME_WORDS[fv.outcome] || fv.outcome}`;
  return `first version ${OUTCOME_WORDS[fv.outcome] || fv.outcome}, at ${(FIRST_VERSION_LABEL[fv.last] || fv.last).toLowerCase()}`;
}

/** What a maker asked for, in their words, or the ready-made app it was made from. */
function Asked({ asked, template }: { asked?: string | null; template?: string | null }) {
  if (asked) return <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-300" data-journey-asked="">{`\u201c${asked}\u201d`}</p>;
  if (template) return <p className={`mt-0.5 ${JUI.fine}`} data-journey-asked="">{`Ready-made: ${template}`}</p>;
  return null;
}

function FirstVersionRows({ fv }: { fv: Creation['firstVersion'] }) {
  if (!fv) return null;
  if (isNotRecorded(fv)) return <Num v={fv} />;
  if (!fv.of) return <Empty>No first version was started in this time.</Empty>;
  const stalled = fv.stoppedAt.map((x) => `${x.count} at ${x.key === 'none' ? 'no stage yet' : (FIRST_VERSION_LABEL[x.key] || x.key).toLowerCase()}`);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-journey-first-version-outcomes="">
        <span className="text-zinc-600 dark:text-zinc-300">{plural(fv.of, 'project', 'projects')}</span>
        {FIRST_VERSION_OUTCOMES.map(([key, words, fill]) => (fv.outcomes[key] ? (
          <span key={key} className="inline-flex items-center gap-1.5"><Dot cls={fill} />{`${fv.outcomes[key]} ${words}`}</span>
        ) : null))}
      </div>
      {fv.stages.map((st, i) => (
        <div key={st.key} data-journey-first-version-stage={st.key} title={FIRST_VERSION_STAGES[i] ? FIRST_VERSION_STAGES[i][2] : undefined}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span>{FIRST_VERSION_LABEL[st.key] || st.key}</span>
            <span className="tabular-nums shrink-0">{`${st.reached} of ${fv.of}`}</span>
          </div>
          <UnitBar n={st.reached} of={fv.of} fill={st.key === 'live' ? 'bg-emerald-500' : 'bg-violet-500'} />
          <div className={`mt-0.5 ${JUI.fine}`}>
            {st.medianFromStart == null ? 'nobody yet'
              : i === 0 ? `median ${dur(st.medianFromStart)} from Make it`
                : `median ${dur(st.medianFromStart)} from Make it · ${dur(st.medianFromPrevious)} after the step before`}
          </div>
        </div>
      ))}
      {stalled.length ? <p className={JUI.fine} data-journey-first-version-stopped="">{`Not live yet, by the furthest stage: ${stalled.join(' · ')}`}</p> : null}
      <p className={JUI.fine} data-journey-first-version-maker="">
        {fv.maker.live
          ? `Of ${fv.maker.live} live: ${fv.maker.nearLive} had their maker active within ${fv.nearMinutes} min of it going live · `
            + `${fv.maker.cameBack} opened it afterwards${fv.maker.medianBackSeconds != null ? `, median ${dur(fv.maker.medianBackSeconds)} after` : ''}`
          : 'None live yet, so nothing to say about their makers.'}
      </p>
      <p className={JUI.fine}>
        {`Stalled: not live and nothing moved for ${fv.stallMinutes} min. Waiting on its maker: its plan is written and waits for Build it.`}
      </p>
    </div>
  );
}

const CREATION_STEPS: Array<[string, string, string]> = [
  ['created', 'Created', 'made a project'],
  ['running', 'Running', 'their project ran for the first time'],
  ['first_version', 'First version ready', 'the first version built from what they described is up to try'],
  ['preview', 'Preview opened', 'they opened a preview of their project'],
  ['change_live', 'Requested change live', 'a change they asked for went live'],
];

const CREATION_SHORT: Record<string, string> = {
  created: 'Made', running: 'Ran', first_version: 'First version', preview: 'Preview', change_live: 'Change live',
};

/** Seconds as a short duration: "45 s", "1.5 min", "12 min", "3 h", "2 days". */
function dur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 600) return `${Math.round(s / 6) / 10} min`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** Green when on target, amber when over; no colour where there is no target. */
function targetTone(seconds: number | null, target: number | null): string {
  if (seconds == null || target == null) return 'text-zinc-600 dark:text-zinc-300';
  return seconds <= target ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400';
}

function CreationCard({ scope, onOpen }: { scope: Scope; onOpen: OpenPerson }) {
  const { data, failed } = useJourney<Creation>(scoped('/api/admin/journey/creation', scope));
  if (!data) return <Card id="admin-journey-creation" title="Creation path"><Loading failed={failed} what="the creation path" /></Card>;
  const stepOf = (key: string) => data.steps.find((s) => s.key === key);
  const later = Object.entries(data.recordedFrom || {}).filter(([, at]) => at).map(([, at]) => (at as string).slice(0, 10));
  const since = later.length ? later.sort()[later.length - 1] : null;
  return (
    <Card id="admin-journey-creation" title="Creation path"
      note={`${data.week === 'all' ? 'all time' : `week of ${weekLabel(data.week)}`} · from making a project`}>
      <div className="space-y-2.5">
        {CREATION_STEPS.map(([key, label, means]) => {
          const st = stepOf(key);
          if (!st) return null;
          const shown = typeof st.reached === 'number' ? st.reached : null;
          return (
            <div key={key} data-journey-creation-step={key} title={means}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{label}</span>
                <span className="tabular-nums shrink-0">
                  {shown == null ? <Num v={st.reached} />
                    : key === 'created' || !st.of ? plural(shown, 'person', 'people') : `${shown} of ${st.of}`}
                </span>
              </div>
              {shown == null
                ? <div className="h-2 rounded-sm border border-dashed border-zinc-300 dark:border-zinc-600" />
                : <UnitBar n={shown} of={st.of} fill={key === 'change_live' ? 'bg-emerald-500' : 'bg-violet-500'} />}
              {key !== 'created' && shown != null ? (
                <div className={`mt-0.5 ${JUI.fine}`}>
                  {st.medianSeconds == null ? 'nobody yet' : (
                    <>
                      median <span className={targetTone(st.medianSeconds, st.targetSeconds)}>{dur(st.medianSeconds)}</span>
                      {st.targetSeconds != null ? ` · target ${dur(st.targetSeconds)} · ${st.withinTarget} on time` : ''}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {since ? <p className={`${JUI.fine} mt-2`}>Running, Preview opened and Requested change live are recorded from {weekLabel(since)}.</p> : null}

      <div className={`${JUI.label} mt-4 mb-1.5`}>Where the time to running goes</div>
      <div id="admin-journey-creation-timing">
        <CreationTimingRows timing={data.timing} />
      </div>

      <div className={`${JUI.label} mt-4 mb-1.5`}>First versions, stage by stage</div>
      <div id="admin-journey-first-version">
        <FirstVersionRows fv={data.firstVersion} />
      </div>

      <div className={`${JUI.label} mt-4 mb-1.5`}>By week</div>
      <div className={JUI.weekGrid} id="admin-journey-creation-weeks">
        <span className={JUI.fine}>Week</span>
        {CREATION_STEPS.map(([key]) => <span key={key} className={`${JUI.fine} text-end`}>{CREATION_SHORT[key]}</span>)}
        {data.weeks.map((w) => (
          <div key={w.week} className="contents" data-journey-creation-week={w.week}>
            <span className="text-xs tabular-nums">{weekLabel(w.week)}</span>
            {CREATION_STEPS.map(([key]) => {
              const cell = w.steps.find((s) => s.key === key);
              if (!cell || isNotRecorded(cell.reached)) {
                return <span key={key} className={`${JUI.fine} text-end`} title="not recorded yet">?</span>;
              }
              const target = data.targets ? data.targets[key] ?? null : null;
              return (
                <span key={key} className="text-end text-xs tabular-nums">
                  {cell.reached}
                  {cell.medianSeconds != null && key !== 'created'
                    ? <span className={`block text-[10px] ${targetTone(cell.medianSeconds, target)}`}>{dur(cell.medianSeconds)}</span> : null}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className={`${JUI.fine} mt-1`}>People who reached each step, with the median time. ? is not recorded yet.</p>

      <div className={`${JUI.label} mt-4 mb-1.5`}>Newest projects</div>
      {data.examples.length ? (
        <div className="space-y-2" id="admin-journey-creation-examples">
          {data.examples.map((e) => (
            <div key={e.slug} data-journey-creation-example={e.slug}>
              <div className="flex flex-wrap items-center gap-1.5">
                <PersonChip person={{ userId: e.userId, name: e.name }} onOpen={onOpen} />
                <span className="text-sm font-medium truncate min-w-0">{e.project}</span>
              </div>
              <Asked asked={e.asked} template={e.template} />
              {e.firstVersion ? <div className={`mt-0.5 ${JUI.fine}`} data-journey-creation-example-first-version="">{firstVersionWords(e.firstVersion)}</div> : null}
              <div className={`mt-0.5 flex flex-wrap gap-x-2 ${JUI.fine}`}>
                {e.steps.map((st) => (
                  <span key={st.key}>
                    {`${CREATION_SHORT[st.key]} `}
                    {!st.recorded ? 'not recorded'
                      : st.seconds == null ? 'not yet'
                        : <span className={targetTone(st.seconds, data.targets ? data.targets[st.key] ?? null : null)}>{dur(st.seconds)}</span>}
                  </span>
                ))}
              </div>
              {e.timing ? <div className={`mt-0.5 ${JUI.fine}`} data-journey-creation-example-timing="">{exampleTiming(e.timing)}</div> : null}
            </div>
          ))}
        </div>
      ) : <Empty>Nobody made a project in this time.</Empty>}
    </Card>
  );
}

// ── First session ──────────────────────────────────────────────────────
//
// The first-session plan's measures (src/services/journey.js firstSession):
// somebody who made a project from the first session's question, and
// somebody who joined one through an invite link, each timed from the start
// of that session. The aha in the first session: the maker sent an invite,
// or the person who joined wrote in its chat or filed a request, within the
// hour. The question's other answer, "Look around first", is counted as its
// own outcome beside Made a project (#4039), with whether they made one of
// their own later. Under them, the invite funnel: links opened, sign-ins through one
// (in their two ways: from the link, or already signed in), joins, and what
// dropped off between each.

type FirstSessionStep = {
  key: string; reached: number; inSession: number; medianSeconds: number | null;
  targetSeconds: number | null; withinTarget: number | null;
};
type InviteFunnel = {
  from: string; opened: number; signedIn: number; signedInByInvite: number; signedInAlready: number; joined: number;
};
type FirstSessionData = {
  week: string; finished: boolean; sessionMinutes: number;
  make: { people: number; notRecorded: NotRecorded | null; steps: FirstSessionStep[]; aha: number };
  join: { people: number; steps: FirstSessionStep[]; aha: number };
  look: { people: number; notRecorded: NotRecorded | null; steps: FirstSessionStep[] };
  opens: InviteFunnel | NotRecorded;
  made?: MadeScreen | NotRecorded;
  recordedFrom: { make: string | null; reward: string | null; opens: string | null; signedIn: string | null; look: string | null };
  examples: Array<{
    path: 'make' | 'join' | 'look'; userId: number; name: string; slug: string | null; project: string | null; startedAt: string | null;
    steps: Record<string, number | null>;
    asked?: string | null; template?: string | null;
  }>;
};

// The made screen and the maker's tour after it (src/services/journey.js
// madeScreenReading): people per step, in the order the screen offers them,
// then the tour card by card and where it was left.
type MadeScreen = {
  from: string; people: number;
  steps: Array<{ key: string; reached: number }>;
  tour: {
    started: number; cards: Array<{ step: number; reached: number }>; done: number;
    skipped: Array<{ step: number; count: number }>; left: Array<{ step: number; count: number }>;
  };
};

const MADE_STEPS: Record<string, [string, string]> = {
  made_shown: ['Saw the made screen', 'the screen after Make it opened'],
  questions_shown: ['Shown its questions', 'the plan\u2019s quick questions, for a plan that has some'],
  submit_tapped: ['Answered them', 'Submit under the questions'],
  invite_shown: ['Shown the invite', 'the invite line and its buttons'],
  share_invite_tapped: ['Tapped Share invite', 'the share sheet opened'],
  invite_sent: ['Shared or copied the link', 'the invite link went out from the share sheet, shared or copied'],
  invite_later_tapped: ['Chose Invite later', 'nothing went out'],
  continue_tapped: ['Went on', 'the way on from the made screen'],
  tour_started: ['Started the tour', 'the maker\u2019s tour after the made screen'],
};

/** "1 at card 2 · 2 at card 3". */
function atCards(list: Array<{ step: number; count: number }>): string {
  return list.map((x) => `${x.count} at card ${x.step}`).join(' · ');
}

function TourCards({ tour }: { tour: MadeScreen['tour'] }) {
  if (!tour.started) return <p className={JUI.fine}>Nobody started the tour.</p>;
  return (
    <div id="admin-journey-tour">
      <div className="flex items-end gap-1 h-16" data-journey-tour-cards="">
        {tour.cards.map((c) => (
          <div key={c.step} className="flex-1 flex flex-col items-stretch justify-end h-full" data-journey-tour-card={c.step}>
            <span className="text-center text-[11px] leading-none mb-0.5 text-zinc-500 dark:text-zinc-400">{c.reached}</span>
            <div className="rounded-sm bg-violet-500" style={{ height: `${Math.max(4, Math.round((c.reached / tour.started) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-0.5">
        {tour.cards.map((c) => <span key={c.step} className="flex-1 text-center text-[10px] text-zinc-500 dark:text-zinc-400">{c.step}</span>)}
      </div>
      <p className={`${JUI.fine} mt-1`} data-journey-tour-ends="">
        {`${tour.done} of ${tour.started} finished it`}
        {tour.skipped.length ? ` · skipped: ${atCards(tour.skipped)}` : ''}
        {tour.left.length ? ` · left with no end: ${atCards(tour.left)}` : ''}
      </p>
    </div>
  );
}

function MadeScreenRows({ made }: { made: MadeScreen }) {
  return (
    <div className="space-y-2.5">
      {made.steps.map((st) => (
        <div key={st.key} data-journey-made-step={st.key} title={MADE_STEPS[st.key]?.[1]}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span>{MADE_STEPS[st.key]?.[0] || st.key}</span>
            <span className="tabular-nums shrink-0">{conversion(st.reached, made.people)}</span>
          </div>
          <UnitBar n={st.reached} of={made.people} fill={st.key === 'invite_sent' ? 'bg-emerald-500' : 'bg-violet-500'} />
        </div>
      ))}
      <div className={`${JUI.label} pt-1`}>The tour, card by card</div>
      <TourCards tour={made.tour} />
    </div>
  );
}

const FIRST_SESSION_STEPS: Record<string, [string, string]> = {
  reward: ['Sketch shown', 'the sketch of what they described was in front of them'],
  invited: ['Invite sent', 'they made an invite link to their project'],
  running: ['Running', 'their project ran for the first time'],
  said: ['Wrote in its chat', 'their first message in the project\'s chat'],
  suggested: ['Filed a request', 'their first request on the project'],
  made: ['Made a project later', 'a project of their own, after looking around'],
};

const FIRST_SESSION_PATHS: Record<string, string> = { make: 'made it', join: 'joined', look: 'looked around' };

function FirstSessionRows({ steps, people, minutes }: { steps: FirstSessionStep[]; people: number; minutes: number }) {
  return (
    <div className="space-y-2.5">
      {steps.map((st) => (
        <div key={st.key} data-journey-first-session-step={st.key} title={FIRST_SESSION_STEPS[st.key]?.[1]}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span>{FIRST_SESSION_STEPS[st.key]?.[0] || st.key}</span>
            <span className="tabular-nums shrink-0">{`${st.reached} of ${people}`}</span>
          </div>
          <UnitBar n={st.reached} of={people} fill="bg-violet-500" />
          <div className={`mt-0.5 ${JUI.fine}`}>
            {st.medianSeconds == null ? 'nobody yet' : (
              <>
                median <span className={targetTone(st.medianSeconds, st.targetSeconds)}>{dur(st.medianSeconds)}</span>
                {` · ${st.inSession} within ${minutes} min`}
                {st.targetSeconds != null ? ` · target ${dur(st.targetSeconds)} · ${st.withinTarget} on time` : ''}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// The invite funnel (journey.js inviteFunnelReading): [key, label, what it
// counts]. Everyone's only: an open signed out names nobody, so it is in no
// cohort, and a cohort view leaves the funnel out.
const FUNNEL_STEPS: Array<['opened' | 'signedIn' | 'joined', string, string]> = [
  ['opened', 'Opened the link', 'opened an invite link, signed in or not: a person, or a browser, once per project'],
  ['signedIn', 'Signed in', 'reached Homeroom signed in through an invite link: from the link, or already signed in'],
  ['joined', 'Joined', 'joined a project through an invite link'],
];

// Signed in, in its two ways (#4272): [key, label, what it counts, fill].
// Signing up or in from the link is what the link brought about, so it is
// the step's conversion, out of everyone who opened a link. Somebody already
// signed in had nothing to convert: they are counted, never a share.
const SIGNED_IN_WAYS: Array<['signedInByInvite' | 'signedInAlready', string, string, string]> = [
  ['signedInByInvite', 'From the link', 'opened the link signed out, then signed up or in', 'bg-violet-500'],
  ['signedInAlready', 'Already signed in', 'were signed in when they opened the link', 'bg-violet-300 dark:bg-violet-400/50'],
];

// A step's share of the one before it is printed only from this many
// people: below it, "2 of 3" says all there is.
const FUNNEL_RATE_FROM = 10;

/** "5 of 11", with its share as a percentage once that can mean something. */
function conversion(n: number, of: number): string {
  if (of < FUNNEL_RATE_FROM) return `${n} of ${of}`;
  return `${n} of ${of} · ${Math.round((n / of) * 100)}%`;
}

function InviteFunnelRows({ funnel }: { funnel: InviteFunnel }) {
  const most = Math.max(funnel.opened, funnel.signedIn, funnel.joined);
  return (
    <div className="space-y-2.5">
      {FUNNEL_STEPS.map(([key, label, means], i) => {
        const n = funnel[key];
        const before = i ? funnel[FUNNEL_STEPS[i - 1][0]] : null;
        // Signed in is the total of its two ways, each on a line of its own,
        // and its conversion is the first of them.
        const ways = key === 'signedIn';
        return (
          <div key={key} data-journey-invite-funnel-step={key} title={means}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>{label}</span>
              <span className="tabular-nums shrink-0">{before == null || ways ? plural(n, 'person', 'people') : conversion(n, before)}</span>
            </div>
            {ways ? (
              <UnitBar n={funnel.signedInByInvite} also={funnel.signedInAlready} of={most}
                fill={SIGNED_IN_WAYS[0][3]} alsoFill={SIGNED_IN_WAYS[1][3]} />
            ) : <UnitBar n={n} of={most} fill={key === 'joined' ? 'bg-emerald-500' : 'bg-violet-500'} />}
            {ways ? (
              <div className="mt-1 space-y-0.5">
                {SIGNED_IN_WAYS.map(([way, wayLabel, wayMeans, fill]) => (
                  <div key={way} data-journey-invite-funnel-way={way} title={wayMeans}
                    className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300"><Dot cls={fill} />{wayLabel}</span>
                    <span className="tabular-nums shrink-0">
                      {way === 'signedInByInvite' ? conversion(funnel[way], funnel.opened) : plural(funnel[way], 'person', 'people')}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {before == null ? null : (
              <div className={`mt-0.5 ${JUI.fine}`}>{before > n ? `${before - n} dropped off` : 'nobody dropped off'}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FirstSessionCard({ scope, onOpen }: { scope: Scope; onOpen: OpenPerson }) {
  const { data, failed } = useJourney<FirstSessionData>(scoped('/api/admin/journey/first-session', scope));
  if (!data) return <Card id="admin-journey-first-session" title="First session"><Loading failed={failed} what="the first session" /></Card>;
  const minutes = data.sessionMinutes;
  const rewardTarget = data.make.steps.find((st) => st.key === 'reward')?.targetSeconds ?? null;
  // The funnel counts from its first sign-in through an invite: said when
  // that is later than the start of what is shown.
  const funnelDay = isNotRecorded(data.opens) ? null : data.opens.from.slice(0, 10);
  const funnelFrom = funnelDay && (data.week === 'all' || funnelDay > data.week) ? funnelDay : null;
  return (
    <Card id="admin-journey-first-session" title="First session"
      note={`${data.week === 'all' ? 'all time' : `week of ${weekLabel(data.week)}`} · timed from the start of it`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div id="admin-journey-first-session-make">
          <div className={`${JUI.label} mb-1.5`}>Made a project</div>
          {data.make.notRecorded ? <Num v={data.make.notRecorded} /> : (
            <>
              <div className="flex items-baseline gap-2">
                <span className={JUI.headline}>{data.make.aha}</span>
                <span className={JUI.fine}>{`of ${plural(data.make.people, 'maker', 'makers')} sent an invite within ${minutes} min`}</span>
              </div>
              <div className="mt-3"><FirstSessionRows steps={data.make.steps} people={data.make.people} minutes={minutes} /></div>
            </>
          )}
        </div>
        <div id="admin-journey-first-session-join">
          <div className={`${JUI.label} mb-1.5`}>Joined through an invite</div>
          <div className="flex items-baseline gap-2">
            <span className={JUI.headline}>{data.join.aha}</span>
            <span className={JUI.fine}>{`of ${plural(data.join.people, 'person', 'people')} wrote or asked for something within ${minutes} min`}</span>
          </div>
          <div className="mt-3"><FirstSessionRows steps={data.join.steps} people={data.join.people} minutes={minutes} /></div>
        </div>
        <div id="admin-journey-first-session-look">
          <div className={`${JUI.label} mb-1.5`}>Looked around first</div>
          {data.look.notRecorded ? <Num v={data.look.notRecorded} /> : (
            <>
              <div className="flex items-baseline gap-2">
                <span className={JUI.headline}>{data.look.people}</span>
                <span className={JUI.fine}>{`chose Look around first, beside ${plural(data.make.people, 'project', 'projects')} made`}</span>
              </div>
              <div className="mt-3"><FirstSessionRows steps={data.look.steps} people={data.look.people} minutes={minutes} /></div>
            </>
          )}
        </div>
      </div>
      <div id="admin-journey-first-session-made">
        <div className={`${JUI.label} mt-4 mb-1.5`}>After Make it</div>
        {!data.made ? null : isNotRecorded(data.made) ? <Num v={data.made} />
          : data.made.people ? <MadeScreenRows made={data.made} /> : <Empty>Nobody saw the made screen in this time.</Empty>}
      </div>
      {scope.cohort ? null : (
        <div id="admin-journey-first-session-opens">
          <div className={`${JUI.label} mt-4 mb-1.5`}>{funnelFrom ? `Invite links · from ${weekLabel(funnelFrom)}` : 'Invite links'}</div>
          {isNotRecorded(data.opens) ? <Num v={data.opens} /> : <InviteFunnelRows funnel={data.opens} />}
        </div>
      )}
      <div className={`${JUI.label} mt-4 mb-1.5`}>Newest first sessions</div>
      {data.examples.length ? (
        <div className="space-y-2" id="admin-journey-first-session-examples">
          {data.examples.map((e) => (
            <div key={`${e.path}-${e.userId}`} data-journey-first-session-example={e.path}>
              <div className="flex flex-wrap items-center gap-1.5">
                <PersonChip person={{ userId: e.userId, name: e.name }} onOpen={onOpen} />
                {e.project ? <span className="text-sm font-medium truncate min-w-0">{e.project}</span> : null}
                <span className={AdminUI.badge.outline}>{FIRST_SESSION_PATHS[e.path] || e.path}</span>
              </div>
              {e.path === 'make' ? <Asked asked={e.asked} template={e.template} /> : null}
              <div className={`mt-0.5 flex flex-wrap gap-x-2 ${JUI.fine}`}>
                {Object.entries(e.steps).map(([key, seconds]) => (
                  <span key={key}>
                    {`${FIRST_SESSION_STEPS[key]?.[0] || key} `}
                    {seconds == null ? 'not yet'
                      : <span className={targetTone(seconds, key === 'reward' ? rewardTarget : null)}>{dur(seconds)}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>Nobody started a first session in this time.</Empty>}
    </Card>
  );
}

// ── Pairs ──────────────────────────────────────────────────────────────
//
// The aha: a project where two real people were both active within 7 days
// of the second one joining, out of the projects that got a second member
// (src/services/journey.js pairs). The pair is the invite link's maker and
// the person who followed it, or else the first two members.

type PairsData = {
  week: string; finished: boolean; days: number; count: number; of: number; open: number;
  trend: Array<{ week: string; count: number; of: number }>;
  examples: Array<{
    slug: string; name: string; pair: Person[]; via: string; secondJoinedAt: string;
    bothActive: boolean; hoursToBoth: number | null; open: boolean;
  }>;
};

function PairsCard({ scope, onOpen }: { scope: Scope; onOpen: OpenPerson }) {
  const { data, failed } = useJourney<PairsData>(scoped('/api/admin/journey/pairs', scope));
  if (!data) return <Card id="admin-journey-pairs" title="Pairs"><Loading failed={failed} what="the pairs" /></Card>;
  const last = data.trend.length ? data.trend[data.trend.length - 1].week : data.week;
  return (
    <Card id="admin-journey-pairs" title="Pairs"
      note={`${data.week === 'all' ? 'all time' : `week of ${weekLabel(data.week)}`} · both active within ${data.days} days`}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div id="admin-journey-pairs-count" className={JUI.headline}>{data.count}</div>
          <div className={`${JUI.fine} mt-1`}>of {plural(data.of, 'project', 'projects')} that got a second member</div>
          {data.open ? <div className={JUI.fine}>{data.open} still inside their {data.days} days</div> : null}
        </div>
        <Trend trend={data.trend} shown={data.week === 'all' ? last : data.week} label="Pairs" />
      </div>
      <p className={`${JUI.fine} mt-2`}>
        Two real people both did something on the project (used it, wrote in its chat, voted, or asked an agent for a change)
        within {data.days} days of the second one joining.
      </p>
      <div className="mt-4 space-y-2" id="admin-journey-pair-rows">
        {data.examples.length ? data.examples.map((e) => (
          <div key={e.slug} className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0" data-journey-pair={e.slug}>
            <span className="text-sm font-medium truncate w-28 shrink-0">{e.name}</span>
            <PersonChip person={e.pair[0]} onOpen={onOpen} />
            <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-400">{e.via === 'invite' ? '→' : '+'}</span>
            <PersonChip person={e.pair[1]} onOpen={onOpen} />
            <span className={e.bothActive ? AdminUI.badge.success : e.open ? AdminUI.badge.outline : AdminUI.badge.warn}>
              {e.bothActive ? `both active, ${e.hoursToBoth != null && e.hoursToBoth < 48 ? `${e.hoursToBoth} h` : days(Math.round((e.hoursToBoth || 0) / 24))}`
                : e.open ? 'waiting' : 'only one active'}
            </span>
          </div>
        )) : <Empty>No project got a second member in this time.</Empty>}
        {data.examples.length ? <p className={JUI.fine}>→ joined through the first one&apos;s invite link · + the project&apos;s first two members</p> : null}
      </div>
    </Card>
  );
}

// ── Next steps ─────────────────────────────────────────────────────────

const NEXT_FILLS = ['bg-violet-500', 'bg-violet-300 dark:bg-violet-400/60', 'bg-violet-200 dark:bg-violet-400/30'];
const OTHER_FILL = 'bg-zinc-300 dark:bg-zinc-600';
const LEFT_FILL = 'bg-red-300 dark:bg-red-400/70';

function NextCard({ s, scope }: { s: Summary; scope: Scope }) {
  const { data, failed } = useJourney<NextSteps>(`/api/admin/journey/next-steps${scope.cohort ? `?admitted=${scope.cohort}` : ''}`);
  return (
    <Card id="admin-journey-next" title="Where newcomers go next"
      note={`${scope.cohort ? 'this cohort' : 'all newcomers'} · their first 28 days`}>
      {data ? (data.rows.length ? (
        <div className="space-y-3">
          {data.rows.slice(0, 6).map((r) => {
            const parts: Array<[string, number, string]> = [
              ...r.next.map((n, i) => [screenLabel(n.to), n.moves, NEXT_FILLS[i] || NEXT_FILLS[2]] as [string, number, string]),
              ...(r.other ? [['other', r.other, OTHER_FILL] as [string, number, string]] : []),
              ['left', r.left.moves, LEFT_FILL],
            ];
            const total = Math.max(1, parts.reduce((a, [, n]) => a + n, 0));
            return (
              <div key={r.screen} data-journey-next={r.screen} className={r.few ? 'opacity-60' : ''}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">{screenLabel(r.screen)}{r.deadEnd ? <span className="ms-1.5 text-amber-600 dark:text-amber-400" title="mostly left or went back">▲</span> : null}</span>
                  <span className={JUI.fine}>{r.moves} moves · {r.people} people{r.few ? ' · few' : ''}</span>
                </div>
                <div className="flex gap-0.5 mt-1">
                  {parts.filter(([, n]) => n > 0).map(([label, n, fill]) => (
                    <span key={label} className={`h-3 rounded-sm ${fill}`} style={{ width: `${Math.round((n / total) * 100)}%` }} />
                  ))}
                </div>
                <div className={`mt-0.5 ${JUI.fine}`}>
                  {parts.filter(([, n]) => n > 0).map(([label, n], i) => (
                    <span key={label}>{i ? ' · ' : ''}<span className={label === 'left' ? 'text-red-700 dark:text-red-400' : ''}>{label} {n}</span></span>
                  ))}
                </div>
              </div>
            );
          })}
          <p className={JUI.fine}>
            <span className="text-amber-600 dark:text-amber-400">▲</span> most moves left or went back.
            {data.leftOut.droppedEvents.length ? ` ${plural(data.leftOut.droppedEvents.length, 'person', 'people')} left out: telemetry lost.` : ''}
          </p>
        </div>
      ) : <Empty>No navigation recorded for these people yet.</Empty>) : <Loading failed={failed} what="the next steps" />}
      {/* How much of the week these paths can see: a gap is an old shell or a
          broken hook, not people who stopped exploring. */}
      <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800" id="admin-journey-coverage">
        <div className="flex justify-between text-sm mb-1">
          <span>Navigation recorded, week of {weekLabel(s.coverage.week || s.groups.week)}</span>
          <span className="tabular-nums">{s.coverage.withNavigation} / {s.coverage.activePeople} active people</span>
        </div>
        <UnitBar n={s.coverage.withNavigation} of={s.coverage.activePeople} fill="bg-emerald-500" />
      </div>
    </Card>
  );
}

// ── Names ──────────────────────────────────────────────────────────────

type NamesList = { title: string; note?: string; sections: Array<{ label: string; people: Person[] }> };

function NamesDialog({ list, onOpen, onClose }: { list: NamesList; onOpen: OpenPerson; onClose: () => void }) {
  return (
    <Dialog id="admin-journey-names-dialog" title={list.title} onClose={onClose}>
      {list.note ? <p className={`${AdminUI.muted} mb-3`}>{list.note}</p> : null}
      {list.sections.map((sec) => (
        <div key={sec.label} className="mb-3">
          <div className={`${JUI.label} mb-1.5`}>{sec.label} · {sec.people.length}</div>
          {sec.people.length ? <Chips people={sec.people} onOpen={onOpen} /> : <Empty>Nobody.</Empty>}
        </div>
      ))}
    </Dialog>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────

function ChecksDialog({ s, onOpen, onClose }: { s: Summary; onOpen: OpenPerson; onClose: () => void }) {
  const t = s.trust;
  const c = t.lockstep.cutoffs || {};
  return (
    <Dialog id="admin-journey-checks-dialog" title="Checks" onClose={onClose}>
      <div className={JUI.label}>Live without a group vote</div>
      <p className={`${AdminUI.muted} mb-1`}>
        {t.withoutGroupVote.count} of {t.withoutGroupVote.of} changes by people went live with no yes from another real person
        {t.withoutGroupVote.atLeastForced ? `; at least ${t.withoutGroupVote.atLeastForced} forced` : ''}.
      </p>
      {t.withoutGroupVote.changes.map((ch, i) => (
        <div key={`${ch.slug}-${i}`} className={JUI.row}>
          <span className="font-medium">{ch.project}</span>
          <span className="text-sm">by {ch.author}</span>
          {ch.forced ? <span className={AdminUI.badge.warn}>forced</span> : null}
        </div>
      ))}
      <div className={`${JUI.label} mt-4`}>Team&apos;s share</div>
      <p className={AdminUI.muted}>The team made {t.teamShare.team} of the week&apos;s {t.teamShare.of} live changes.</p>
      <div className={`${JUI.label} mt-4`}>Lockstep</div>
      <p className={`${AdminUI.muted} mb-1`}>
        A warning, never a filter: at least {c.minYesVotes} yes votes in the week, and at least {Math.round((c.minShare || 0) * 10)} in 10 of
        them within {c.withinSeconds} seconds of another account&apos;s yes on the same change.
      </p>
      {t.lockstep.possible.length ? t.lockstep.possible.map((p) => (
        <div key={p.userId} className={JUI.row}>
          <NameButton person={p} onOpen={onOpen} />
          <span className={JUI.fine}>{p.withinSeconds} of {p.yesVotes} yes votes close to another account&apos;s</span>
        </div>
      )) : <Empty>Nobody this week.</Empty>}
      <div className={`${JUI.label} mt-4`}>Coverage</div>
      <p className={`${AdminUI.muted} mb-1`}>
        {s.coverage.withNavigation} of {s.coverage.activePeople} people active on the server have navigation recorded.
        A gap means an old shell or a broken hook, not people who stopped exploring.
      </p>
      {s.coverage.byDay.map((d) => (
        <div key={`${d.day}-${d.build}`} className={JUI.row}>
          <span className="text-sm">{weekLabel(d.day)}</span>
          <span className="font-mono text-xs">{d.build || 'unknown build'}</span>
          <span className={JUI.fine}>{d.rows} rows</span>
        </div>
      ))}
    </Dialog>
  );
}


type LeftOutEntry = { userId: number; username: string | null; reason: string; note: string | null; addedBy: string | number | null; addedAt: string };
type Suggestion = { id: number; username: string; matched_on?: string };

function LeftOutDialog({ onOpen, onClose }: { onOpen: OpenPerson; onClose: () => void }) {
  const { data, failed, reload } = useJourney<{ people: LeftOutEntry[] }>('/api/admin/journey/left-out');
  // The demo list is invented, so editing it would write to the real one.
  const canWrite = !DEMO && !!consoleApi()?.canWrite?.();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const [pick, setPick] = useState<Suggestion | null>(null);
  const [reason, setReason] = useState('test');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim().replace(/^@/, '');
    if (!q) return;
    setError(null);
    const res = await consoleApi().fetchJson(`/api/admin/support/search?q=${encodeURIComponent(q)}`);
    if (!res.ok || !res.data) { setMatches([]); setError('Type at least 3 characters, or a user id.'); return; }
    setMatches((res.data.results || []).slice(0, 8));
  };

  // Confirmations stay inside this dialog: the shell's confirm sheet is
  // translucent and reads as noise over an open dialog. Choosing "Objected"
  // shows what it erases above a red button, and Remove asks once in its row.
  const [removing, setRemoving] = useState<number | null>(null);

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/journey/left-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pick.id, reason, note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not add this person.'); return; }
      setPick(null); setMatches(null); setQuery(''); setNote('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: LeftOutEntry) => {
    setRemoving(null);
    const res = await fetch(`/api/admin/journey/left-out/${entry.userId}`, { method: 'DELETE' });
    if (!res.ok) { setError('Could not remove this entry.'); return; }
    reload();
  };

  return (
    <Dialog id="admin-journey-leftout-dialog" title="Left out" onClose={onClose}>
      <p className={`${AdminUI.muted} mb-3`}>
        People kept out of every Journey number. A test account keeps its telemetry; someone who objected has theirs erased
        and no longer recorded.
      </p>
      {data ? (data.people.length ? data.people.map((e) => (
        <div key={e.userId} className={JUI.row} data-journey-leftout={e.userId}>
          <NameButton person={{ userId: e.userId, name: e.username || `#${e.userId}` }} onOpen={onOpen} />
          <span className={e.reason === 'objected' ? AdminUI.badge.destructive : AdminUI.badge.default}>
            {e.reason === 'objected' ? 'Objected' : 'Test account'}
          </span>
          {e.note ? <span className={JUI.fine}>{e.note}</span> : null}
          <span className={`${JUI.fine} sm:ms-auto`}>{weekLabel((e.addedAt || '').slice(0, 10))}</span>
          {canWrite && removing !== e.userId ? (
            <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => setRemoving(e.userId)}>Remove</button>
          ) : null}
          {canWrite && removing === e.userId ? (
            <span className="basis-full flex flex-wrap items-center gap-2 text-sm">
              {e.reason === 'objected'
                ? 'Count them again? Recording starts again; what was erased does not come back.'
                : 'Count them again in every Journey number?'}
              <button type="button" className={AdminUI.btn.outlineSm} onClick={() => remove(e)}>Remove from the list</button>
              <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => setRemoving(null)}>Keep</button>
            </span>
          ) : null}
        </div>
      )) : <Empty>Nobody is left out.</Empty>) : <Loading failed={failed} what="the list" />}
      {canWrite ? (
        <div className="mt-4 space-y-2">
          <div className={JUI.label}>Leave someone out</div>
          {pick ? (
            <div className="space-y-2">
              <p className="text-sm">{pick.username} <span className={JUI.fine}>#{pick.id}</span>
                <button type="button" className={`${AdminUI.btn.link} text-xs ms-2`} onClick={() => setPick(null)}>Change</button>
              </p>
              <select className={AdminUI.select} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
                <option value="test">Test account: leave out of the numbers</option>
                <option value="objected">Objected: erase their telemetry and stop recording</option>
              </select>
              <input className={AdminUI.input} value={note} maxLength={200} placeholder="Note (optional)"
                onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              {reason === 'objected' ? (
                <p className="text-sm text-red-700 dark:text-red-400">
                  This deletes the screens and failures recorded for {pick.username} now, and nothing more is recorded.
                  It cannot be undone.
                </p>
              ) : null}
              <button type="button" className={reason === 'objected' ? AdminUI.btn.destructive : AdminUI.btn.primary}
                disabled={busy} onClick={add}>{reason === 'objected' ? 'Erase and leave out' : 'Leave out'}</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input className={AdminUI.input} value={query} placeholder="Username or id"
                  onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
                  aria-label="Find a person" />
                <button type="button" className={AdminUI.btn.outline} onClick={search}>Find</button>
              </div>
              {matches ? (matches.length ? matches.map((m) => (
                <button key={m.id} type="button" className={`${JUI.row} w-full text-start`} onClick={() => setPick(m)}>
                  <span className="font-medium">{m.username}</span>
                  <span className={JUI.fine}>#{m.id}</span>
                </button>
              )) : <Empty>No match.</Empty>) : null}
            </>
          )}
          {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

type PersonData = {
  userId: number; name: string; cohort: string | null; firstMile: MilePerson;
  found: Array<{ slug: string; name: string; how: string | null; stayed: boolean | null; seconds: number | null }>;
  cameBackTo: Array<{ slug: string; name: string; days: number }>;
  usedOftenNotOnHome: Array<{ slug: string; name: string; days: number }>;
  waysIn: Record<string, number>;
  visits: number;
  possiblyLost: Array<{ at: string; path: string[]; steps: number; distinct: number; seconds: number; secondsPerStep: number; repeatShare: number; cutoffs: Record<string, number> }>;
  failedAttempts: number; repeatedTaps: number;
  challenges: { openedAt: string | null; credits: Array<{ challengeId: number; title: string; points: number; at: string; firstChallenge: boolean }> };
  navigation: { recorded: true } | NotRecorded;
  made?: Array<{
    slug: string; project: string; createdAt: string; asked: string | null; template: string | null;
    firstVersion: (FirstVersionBrief & { nearLive: boolean | null; backSeconds: number | null }) | null;
  }>;
  madeScreen?: Array<{ kind: string; at: string; how?: string; step?: number; steps?: number }>;
};

/** One moment of the made screen or the tour, in a word or two. */
function momentLabel(m: { kind: string; how?: string; step?: number; steps?: number }): string {
  switch (m.kind) {
    case 'made_shown': return 'Made screen';
    case 'planning_shown': return 'Planning';
    case 'questions_shown': return 'Questions';
    case 'submit_tapped': return 'Answered';
    case 'invite_shown': return 'Invite shown';
    case 'share_invite_tapped': return 'Share invite';
    case 'invite_sent': return m.how === 'copied' ? 'Link copied' : 'Invite shared';
    case 'invite_later_tapped': return 'Invite later';
    case 'continue_tapped': return 'Went on';
    case 'tour_started': return m.steps ? `Tour of ${m.steps}` : 'Tour';
    case 'tour_step_shown': return `Card ${m.step ?? '?'}`;
    case 'tour_ended': return m.how === 'done' ? 'Finished the tour' : `Skipped at card ${m.step ?? '?'}`;
    default: return m.kind;
  }
}

function PersonView({ userId, onBack, onName }: { userId: number; onBack: () => void; onName: (name: string) => void }) {
  const { data: p, failed } = useJourney<PersonData>(`/api/admin/journey/people/${userId}`);
  useEffect(() => { if (p) onName(p.name); }, [p, onName]);
  const section = (label: string, body: ReactNode) => (
    <div className="mt-4">
      <div className={JUI.label}>{label}</div>
      {body}
    </div>
  );
  let prevAt: string | null = null;
  return (
    <section id="admin-journey-person" className={JUI.card}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <button type="button" className={`${JUI.cohort} ${JUI.chipOff}`} onClick={onBack}>← Everyone</button>
        <h3 className={AdminUI.sectionTitle}>{p ? p.name : 'Person'}</h3>
      </div>
      {p ? (
        <>
          <p className={AdminUI.muted}>
            {p.cohort ? `Admitted ${weekLabel(p.cohort)}` : 'No admit date'} · {plural(p.visits, 'visit', 'visits')}
            {' · '}
            <button type="button" className={AdminUI.btn.link}
              onClick={() => { location.hash = `#admin/support/${p.userId}`; }}>Open in Support</button>
          </p>
          {isNotRecorded(p.navigation) ? <p className={`${JUI.fine} mt-1`}>Navigation not recorded yet: {p.navigation.reason}</p> : null}
          {section('First mile', p.firstMile.steps.map((st) => {
            const g = st.at ? gap(prevAt, st.at) : '';
            if (st.at) prevAt = st.at;
            return (
              <div key={st.key} className={JUI.row} data-journey-person-step={st.key}>
                <span className="text-sm w-44 shrink-0">{MILE_STEPS[st.key] || st.key}</span>
                <span className={st.state === 'stuck' ? AdminUI.badge.warn : st.state === 'done' ? AdminUI.badge.success : AdminUI.badge.outline}>
                  {st.state === 'not_yet' ? 'not yet' : st.state}
                </span>
                {st.at ? <span className={JUI.fine}>{when(st.at)} {g}</span> : null}
                {st.note ? <span className={JUI.fine}>{st.note}</span> : null}
              </div>
            );
          }))}
          {section('Made', p.made && p.made.length ? p.made.map((m) => (
            <div key={m.slug} className="py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0" data-journey-person-made={m.slug}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{m.project}</span>
                <span className={JUI.fine}>{when(m.createdAt)}</span>
                {m.firstVersion ? <span className={JUI.fine}>{firstVersionWords(m.firstVersion)}</span> : null}
                {m.firstVersion && m.firstVersion.nearLive != null ? (
                  <span className={JUI.fine}>
                    {`${m.firstVersion.nearLive ? 'there when it went live' : 'away when it went live'}${m.firstVersion.backSeconds != null ? `, opened it ${dur(m.firstVersion.backSeconds)} after` : ''}`}
                  </span>
                ) : null}
              </div>
              <Asked asked={m.asked} template={m.template} />
            </div>
          )) : <Empty>No project of their own.</Empty>)}
          {p.madeScreen && p.madeScreen.length ? section('After Make it', (
            <div className={`${JUI.path} mt-1`} id="admin-journey-person-made-screen">
              {p.madeScreen.map((m, i) => <span key={i} className={JUI.pathStep}>{momentLabel(m)}</span>)}
            </div>
          )) : null}
          {section('Tour', p.firstMile.tour
            ? <p className="text-sm">{p.firstMile.tour.ended === 'skip' ? 'Skipped' : p.firstMile.tour.ended === 'finish' ? 'Finished' : p.firstMile.tour.ended}
              {p.firstMile.tour.step != null ? ` at step ${p.firstMile.tour.step + 1}` : ''}
              {p.firstMile.tour.at ? `, ${when(p.firstMile.tour.at)}` : ''}</p>
            : <Empty>Not opened.</Empty>)}
          {section('Found', p.found.length ? p.found.map((f) => (
            <div key={f.slug} className={JUI.row}>
              <span className="font-medium">{f.name}</span>
              <span className={JUI.fine}>{f.how === 'handed' ? 'handed to them' : f.how === 'own' ? 'on their own' : 'way not recorded'}</span>
              {f.stayed == null ? null : <span className={f.stayed ? AdminUI.badge.success : AdminUI.badge.default}>{f.stayed ? 'stayed' : 'glanced'}</span>}
            </div>
          )) : <Empty>Nothing new yet.</Empty>)}
          {section('Came back to', p.cameBackTo.length ? (
            <p className="text-sm">{p.cameBackTo.map((c) => `${c.name} (${days(c.days)})`).join(', ')}</p>
          ) : <Empty>Nothing yet.</Empty>)}
          {p.usedOftenNotOnHome.length ? section('Used often, not on their Home', (
            <p className="text-sm">{p.usedOftenNotOnHome.map((c) => `${c.name} (${days(c.days)})`).join(', ')}</p>
          )) : null}
          {Object.keys(p.waysIn).length ? section('How visits started', (
            <p className="text-sm">{Object.entries(p.waysIn).map(([k, n]) => `${n} ${WAYS[k] || k}`).join(', ')}</p>
          )) : null}
          {section('Possibly lost', p.possiblyLost.length ? p.possiblyLost.map((v, i) => (
            <div key={i} className="py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0">
              <p className={`${JUI.fine} mb-1`}>
                {when(v.at)} · {v.steps} steps over {v.distinct} screens in {Math.round(v.seconds)} s, with no stay and no act
              </p>
              <div className={JUI.path}>{v.path.map((code, j) => <span key={j} className={JUI.pathStep}>{screenLabel(code)}</span>)}</div>
              <p className={`${JUI.fine} mt-1`}>
                {`Flagged because it had ${v.cutoffs.minSteps} or more steps, under ${v.cutoffs.maxSecondsPerStep} s a step, `
                  + `at least ${Math.round(v.cutoffs.minRepeatShare * 10)} in 10 steps back to a screen already seen, `
                  + `and no ${v.cutoffs.landingSeconds} s stay.`}
              </p>
            </div>
          )) : <Empty>No visit looks lost.</Empty>)}
          {section('Failed attempts', <p className="text-sm">{plural(p.failedAttempts, 'action failed', 'actions failed')}, {plural(p.repeatedTaps, 'tap repeated', 'taps repeated')}</p>)}
          {section('Challenges', (
            <>
              <p className="text-sm">{p.challenges.openedAt ? `Opened Challenges ${when(p.challenges.openedAt)}` : 'Never opened Challenges'}</p>
              {p.challenges.credits.map((c) => (
                <div key={`${c.challengeId}-${c.at}`} className={JUI.row}>
                  <span className="text-sm">{c.title}</span>
                  {c.firstChallenge ? <span className={AdminUI.badge.secondary}>First challenge</span> : null}
                  <span className={JUI.fine}>{when(c.at)}</span>
                </div>
              ))}
            </>
          ))}
        </>
      ) : <Loading failed={failed} what="this person" />}
    </section>
  );
}


// ── The section ────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Find one person by name or id (Support's search) and open their view.
function PersonSearch({ onPick }: { onPick: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const find = async () => {
    const term = q.trim().replace(/^@/, '');
    if (!term) { setMatches(null); return; }
    const res = await consoleApi().fetchJson(`/api/admin/support/search?q=${encodeURIComponent(term)}`);
    setMatches(res.ok && res.data ? (res.data.results || []).slice(0, 6) : []);
  };
  return (
    <div className="w-full sm:w-auto">
      <input className={JUI.search} value={q} placeholder="Find a person"
        aria-label="Find a person" onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') find(); }} onBlur={() => { if (q.trim()) find(); }} />
      {matches ? (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {matches.length ? matches.map((m) => (
            <PersonChip key={m.id} person={{ userId: m.id, name: m.username }} onOpen={(id) => { setMatches(null); setQ(''); onPick(id); }} />
          )) : <span className={JUI.fine}>No match.</span>}
        </div>
      ) : null}
    </div>
  );
}

function JourneySection() {
  // The default is all time, for everyone; a week or a cohort narrows it.
  const [scope, setScope] = useState<Scope>({ week: 'all', cohort: null });
  const { data: s, failed, reload } = useJourney<Summary>(scoped('/api/admin/journey/summary', scope));
  // Both loops come from one read, so the two cards share it.
  const { data: loops, failed: loopsFailed } = useJourney<Loops>(scoped('/api/admin/journey/loops', scope));
  const { data: cohorts } = useJourney<Cohorts>('/api/admin/journey/cohorts');
  const [dialog, setDialog] = useState<DialogKey | null>(null);
  const [names, setNames] = useState<NamesList | null>(null);
  const [person, setPerson] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string | null>(null);
  const openPerson = useCallback((id: number) => {
    setPersonName(null);
    setNames(null);
    setDialog(null);
    setPerson(id);
    document.getElementById('admin-journey')?.scrollIntoView({ block: 'start' });
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeNames = useCallback(() => setNames(null), []);

  // The week the arrows step from: the one shown, or in "all time" the
  // headline week.
  const allTime = scope.week === 'all';
  const shown = allTime ? (s?.groups.week || null) : scope.week;
  const current = s?.thisWeekSoFar.week || null;
  const canNext = !!(shown && current && shown < current);
  const toWeek = (w: string | null) => w && setScope({ ...scope, week: w });
  const chip = (on: boolean) => `${JUI.cohort} ${on ? JUI.chipOn : JUI.chipOff}`;
  const whoChips: Array<[string | null, string]> = [[null, 'Everyone'],
    ...(cohorts ? cohorts.cohorts.map((c) => [c.day, `${weekLabel(c.day)} · ${c.admitted}`] as [string, string]) : []),
    ...(cohorts ? [['other_way', `Another way · ${cohorts.otherWay.people}`] as [string, string]] : [])];

  return (
    <div id="admin-journey" className="space-y-4">
      <div className={JUI.card} id="admin-journey-filters">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className={AdminUI.cardTitle}>Journey</h2>
            {s?.demo ? <span className={AdminUI.badge.warn}>demo</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={`${AdminUI.btn.ghost} text-xs`} data-journey-open="leftout"
              onClick={() => setDialog('leftout')}>Left out</button>
            <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={reload}>Refresh</button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-journey-filter="when">
          <span className={`${JUI.label} w-12`}>When</span>
          <button type="button" aria-pressed={allTime} className={chip(allTime)}
            onClick={() => setScope({ ...scope, week: 'all' })}>All time</button>
          <span className="inline-flex items-center gap-1">
            <button type="button" className={JUI.stepper} aria-label="Week before"
              disabled={!shown} onClick={() => toWeek(shown && addDays(shown, -7))}>‹</button>
            <button type="button" id="admin-journey-week" aria-pressed={!allTime} className={chip(!allTime)}
              disabled={!shown} onClick={() => toWeek(shown)}>{shown ? `Week of ${weekLabel(shown)}` : 'Week'}</button>
            <button type="button" className={JUI.stepper} aria-label="Week after"
              disabled={allTime ? !shown : !canNext} onClick={() => toWeek(shown && (allTime ? shown : addDays(shown, 7)))}>›</button>
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-journey-filter="who">
          <span className={`${JUI.label} w-12`}>Who</span>
          {person != null ? (
            <button type="button" className={chip(true)} aria-label="Back to everyone" onClick={() => setPerson(null)}>{personName || 'One person'} ×</button>
          ) : whoChips.map(([v, label]) => (
            <button key={v ?? 'everyone'} type="button" aria-pressed={scope.cohort === v} className={chip(scope.cohort === v)}
              onClick={() => setScope({ ...scope, cohort: v })}>{label}</button>
          ))}
          <PersonSearch onPick={openPerson} />
        </div>
      </div>
      {person != null ? <PersonView userId={person} onBack={() => setPerson(null)} onName={setPersonName} /> : s ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <NorthStarCard s={s} scope={scope} onOpen={openPerson} onDetails={() => setDialog('checks')} />
          <StagesCard scope={scope} onNames={setNames} />
          <div className="xl:col-span-2"><FirstMileCard cohorts={cohorts} scope={scope} onOpen={openPerson} /></div>
          <CreationCard scope={scope} onOpen={openPerson} />
          <FirstSessionCard scope={scope} onOpen={openPerson} />
          <PairsCard scope={scope} onOpen={openPerson} />
          <LoopCard data={loops} failed={loopsFailed} s={s} scope={scope} />
          <InviteCard data={loops} failed={loopsFailed} onOpen={openPerson} />
          <div className="xl:col-span-2"><NextCard s={s} scope={scope} /></div>
        </div>
      ) : <div className={JUI.card}><Loading failed={failed} what="the journey" /></div>}
      {dialog === 'checks' && s ? <ChecksDialog s={s} onOpen={openPerson} onClose={closeDialog} /> : null}
      {dialog === 'leftout' ? <LeftOutDialog onOpen={openPerson} onClose={closeDialog} /> : null}
      {names ? <NamesDialog list={names} onOpen={openPerson} onClose={closeNames} /> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminJourney = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <JourneySection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminJourney = AdminJourney;

// InviteFunnelRows for its render test (tests/admin-journey-section.test.js).
export { AdminJourney, InviteFunnelRows, CreationTimingRows, exampleTiming };
