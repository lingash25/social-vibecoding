/**
 * The Notifications SHEET (#notifications-sheet) — Streamlined Concept.
 *
 * Unread | All tabs. Unread groups its rows under one heading per project and
 * folds repeats inside a project into one row, and shows its older rows as
 * one card per change in TODAY / YESTERDAY / LAST 7 DAYS / OLDER sections;
 * All is the archive, in TODAY / EARLIER sections. One row per notification
 * has an avatar-initial chip, the
 * source app + relative time as the subtitle, an unread dot and a trailing
 * chevron.
 *
 * ── UNREAD LEADS, and it is where the sheet opens ──────────────────────
 *
 * All led for one round. Opening an inbox on everything you have already read
 * is opening it on the answer to a question nobody asked: you tapped the bell
 * BECAUSE it had a count, and the count is the unread. So Unread is first in
 * the strip and is the initial tab, and All is the archive you step sideways
 * into. Unread shows its older rows in place instead (#4700).
 *
 * "Mark all read" went with it. It sat at the far right of the same row as
 * the tabs, in the same ink, and read as a fourth tab you could not select —
 * a destructive-ish action a tap away from three navigation controls. It is
 * an action ON the unread list, so it lives under the Unread tab with the
 * list it acts on, and exists nowhere else.
 *
 * ── #5289: one count, no Messages filter, repeats folded ──────────────
 *
 * The Unread tab's count is the bell's own number (`badgeTotal` in the
 * store, Notifications._badgeTotal), printed through the bell's cap, so the
 * bell, this tab and the browser tab's title can no longer say three
 * different things. It used to sum the rows paged in so far.
 *
 * The Messages filter is gone. It repeated the Messages tab in the bar
 * (which lists the same conversations and the agents beside them), and the
 * strip is now the count you came for and the archive. A message is still a
 * row here; consecutive lines from one conversation still collapse into one
 * counted row (collapseConversationRuns in ./notifications.js).
 *
 * On Unread, inside one project's group, notifications of the same kind
 * that printed the same label fold into one row: "3 changes you voted on are
 * live" rather than three rows saying it. The row is drawn as its newest
 * member; tapping it opens that one and reads the whole group
 * (Notifications.openGroupRow), and clearing it clears them all.
 *
 * ── #3206: All narrows by kind ─────────────────────────────────────────
 *
 * On All, a row of three chips under the tabs (Votes, Mentions & replies,
 * Invites) narrows the archive to one kind of thing that waits on you, across
 * every project; tapping the lit chip again shows everything. One at a time,
 * forgotten when the sheet closes. The kinds and why there are three live in
 * ./notifications-kinds.js. It is not a Messages filter: that one stays gone.
 *
 * ── It was a screen, and a screen needed a back button ─────────────────
 *
 * The bell is in the header on every route, so a full-screen Notifications
 * view had to answer "back to where?" — and it answered "home", which was
 * wrong every time you opened it from somewhere that was not home. As a
 * sheet the question does not arise: it presents over the current screen and
 * dismisses back to it. See ./notifications-sheet-controller.js.
 *
 * ── The type is the Improve rail's, not a scale of its own ────────────
 *
 * This sheet shipped with a bespoke iOS-ish ramp — 13/14/15/17/20/22px — while
 * the Improve rail beside it, the surface a viewer most often sees this one
 * next to, runs Tailwind's `text-xs` / `text-sm`. Opened together the bell
 * read a size larger throughout, which is what "the font is way too big" was.
 *
 * Every size here now maps to the role the Improve panel gives it, so the two
 * rails read as one product:
 *
 *     sheet title   22px bold   → text-sm font-semibold   (its h2)
 *     row subject   17px bold   → text-sm font-semibold   (session-row's title)
 *     row meta      15px        → text-xs                 (its metadata)
 *     section label 15px        → text-xs font-medium     (SECTION_LABEL_CLASS)
 *     tab / action  15px semi   → text-sm font-semibold   (its quick actions)
 *     small pill    14px semi   → text-xs font-semibold
 *     count badge   13px bold   → text-[11px] font-semibold (session-row's pill)
 *
 * What did NOT change is the row's leading tile, still `h-11 w-11` where the
 * Improve rail's is `h-8 w-8`. That is a dimension rather than a type size,
 * and the avatar chip is load-bearing here in a way it is not there — a
 * conversation row is a PERSON speaking and the swatch is how you tell whose.
 * If the rows still read heavier than Improve's, that tile is the next lever,
 * and it is a deliberate separate decision.
 *
 * ── Ownership ──────────────────────────────────────────────────────────
 *
 * Fully React-owned. The root is an overlay, not a screen root, so it is not
 * in App.SCREEN_IDS and its visibility is `data-open` off
 * ./notifications-sheet-store.js rather than a `hidden` class off the
 * visibility store. No public/js/** module writes a node inside this subtree.
 *
 * ── Data ───────────────────────────────────────────────────────────────
 *
 * Everything renders from ./notifications-store.js — `screenList` is every
 * fetched row (read and unread) as descriptors built by the controller's
 * `rowView`, so this file stays purely presentational like
 * ./notifications-list.tsx. Actions reach the controller through
 * `window.Notifications` (the module must stay import-free — see the store's
 * header). The initial store value renders an empty, hidden screen, which is
 * exactly what the SSG prerender ships.
 */

import { OverlayScrim } from '../../lib/overlay-scrim-view';
import {
  Fragment, useCallback, useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { Chip, ChipRail } from '@/components/ui/chip';
import { SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import {
  BookmarkIcon, BookmarkSolidIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon,
} from '@/components/ui/icons';

import { UserAvatar, swatchFor } from '../messages/format';
import type { ConversationUser } from '../messages/types';
import { AppIconContent, appIconKind } from '../apps/app-card-view';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from './notifications-store.js';
import { matchesNotificationQuery, normalizeNotificationQuery } from './notifications-search.js';
import { NOTIFICATION_KIND_FILTER_KEYS, matchesKindFilter } from './notifications-kinds.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';
import { NotificationsSheet } from './notifications-sheet-controller.js';
import { NotificationsPinnedSections } from './notifications-list';
import type { NotificationRowView } from './notifications-list';
import { CardHistory, ProjectStack, foldStories, type CardPlace } from './notification-stacks';

type ScreenRowView = NotificationRowView & {
  /** The unelided instant for the `<time>`'s title (#1808, stampFields). */
  timeTitle?: string;
  createdAtMs: number;
  who: string;
  appLine: string;
  /**
   * #5406: the app the row came from, for the Unread tab's per-app groups.
   * Conversation kinds carry no app — they group under "Other".
   */
  appId?: number | null;
  /**
   * The meta line's attribution — a username, or null. Set only where the
   * source user is the one who DID this; see the note on `rowView` in
   * ./notifications.js for the two kinds that name a person who is the
   * subject rather than the actor.
   */
  by?: string | null;
  /** Set on a conversation row: a person speaking, never folded by kind. */
  conversation?: boolean;
  /** A plain message (#18): on the Messages tab, never on Unread, as the bell leaves it out. */
  plainMessage?: boolean;
  /** Set on a row from the Homeroom bot: it wears the bot's own face. */
  bot?: boolean;
  /** Set on one of the bot's moments (rowView): its meta line names its project and the bot. */
  botMoment?: boolean;
  conversationId?: number | null;
  /** #5289: the notification's kind, what a project's repeats fold on. */
  kind?: string;
  /**
   * #5289: set on a row that stands for several notifications of one kind in
   * one project: every member's id, the row's own (the newest) first.
   */
  groupIds?: number[];
  /** #5289: the group's label says the count, so the count pill steps aside. */
  groupLabelled?: boolean;
  /**
   * #4769: the user has bookmarked this row for later. Independent of the
   * read state — saving never reads, reading never saves.
   */
  saved?: boolean;
  /**
   * How many notifications this row stands for. Present only on a genuine
   * collapse (a run of consecutive same-conversation rows, see
   * collapseConversationRuns in ./notifications.js); absent means one.
   */
  count?: number;
  /** #5580: the project's own name, for its stack's heading. */
  appName?: string | null;
  /** #5877: that project's icon, so its bot row wears the project's tile. */
  appIconUrl?: string | null;
  appIconEmoji?: string | null;
  /** #5580: the request or proposal the row is about (rowView), what its project's stack folds a story on. */
  storyKey?: string | null;
  /** #5580: that request or proposal's number and title, when known. */
  storyRef?: { number: number; title: string | null } | null;
  /** #5580: set on a card standing for one story's notifications (foldStories), newest first. */
  story?: { members: ScreenRowView[] } | null;
};

type Tab = 'all' | 'unread';

/** #3206: the All tab's kind chips (./notifications-kinds.js). */
type KindFilter = 'votes' | 'mentions' | 'invites';

const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  votes: 'notifications:sheet.kind.votes',
  mentions: 'notifications:sheet.kind.mentions',
  invites: 'notifications:sheet.kind.invites',
};

/** One row of the list, with its time (ms) for the Today/Earlier split. */
type Entry = { type: 'notif'; key: string; at: number; view: ScreenRowView };

/** The bot as the avatar reads it: a platform account, drawn as its mark. */
const BOT_SENDER: ConversationUser = { id: 0, username: 'homeroom_bot', avatarUrl: null, bot: true };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

function kit(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/** Local-midnight boundary — rows at or after it are "Today". */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The row's leading mark, in the language's two shapes: a conversation is
 * a PERSON speaking, so it gets the square swatch avatar Messages uses
 * (the same colour for the same handle); everything else is an EVENT, so
 * it gets the neutral glyph tile with the kind's icon.
 *
 * Run six (14 Oct 2026): the Homeroom bot is drawn as Messages draws it,
 * the Homeroom mark (../messages/format.tsx UserAvatar), not an orange
 * tile of the "H" of its handle.
 *
 * #5877: except when its news is about a project. That row wears the
 * project's own tile — the same picture, emoji or letter every app surface
 * draws — so a list of "Ready to try" rows names its projects at a glance.
 * A bot row with no project (a reply, a question the platform cannot place)
 * keeps the Homeroom mark.
 */
export function AvatarChip({ view }: { view: ScreenRowView }): ReactNode {
  const who = (view.who || '?').replace(/^@/, '');
  const initial = who.charAt(0).toUpperCase() || '?';
  if (view.conversation && view.bot) {
    if (view.appId != null) {
      const app = { name: view.appName || '', icon_url: view.appIconUrl || null, icon_emoji: view.appIconEmoji || null };
      // Its image has no text (alt=""): the row's words say who it is from.
      return (
        <span
          aria-hidden="true"
          data-icon={appIconKind(app)}
          className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
        >
          <AppIconContent app={app} />
        </span>
      );
    }
    // Its image has no text (alt=""): the row's words say who it is from.
    return <UserAvatar user={BOT_SENDER} size="lg" shape="square" />;
  }
  if (view.conversation) {
    return (
      <span
        aria-hidden="true"
        className="w-11 h-11 shrink-0 rounded-xl text-white flex items-center justify-center text-sm font-semibold"
        style={{ backgroundColor: swatchFor(who) }}
      >
        {initial}
      </span>
    );
  }
  return (
    <IconTile size="sm" aria-hidden="true" className="text-base">
      {view.icon || initial}
    </IconTile>
  );
}

function SectionHead({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-4 pt-4 pb-1 text-xs font-medium text-zinc-500 dark:text-zinc-500">
      {children}
    </div>
  );
}

/**
 * #5406: the heading of one app's group of unread notifications on the Unread
 * tab, with that app's "Mark read" beside it. The heading is the app's name
 * (the same words each row's meta line already carries); the pill is the
 * sheet's own "Mark all read" pill in miniature, and clears that app's every
 * unread notification — including ones the sheet has not paged in — through
 * the controller's markAppRead. The "Other" group (notifications that belong
 * to no app) renders no button: nothing but Mark all read owns those.
 *
 * #5580: the heading of a project's stack. While the stack is open it also
 * offers "Show less", which folds the stack back under its newest card.
 */
function AppGroupHead({ groupKey, label, appId, onRead, onShowLess }: {
  groupKey: string;
  label: string;
  appId: number | null;
  /** Before the clear: let the group's rows go, so they leave Unread (useHeldUnread). */
  onRead?: () => void;
  /** An open stack's way back to closed; absent while there is nothing to fold. */
  onShowLess?: (() => void) | null;
}): ReactNode {
  const t = useMessages('notifications');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-1.5" data-notif-app-group={groupKey}>
      <span className="flex-1 min-w-0 truncate text-xs font-medium text-zinc-500 dark:text-zinc-500">
        {label}
      </span>
      {onShowLess ? (
        <button
          type="button"
          data-notif-stack-less={groupKey}
          className={'inline-flex items-center gap-1 h-8 px-3 rounded-full text-xs font-semibold '
            + 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 '
            + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 un-touch-target'}
          aria-label={t('notifications:stack.showLessLabel', { app: label })}
          onClick={(event) => {
            event.stopPropagation();
            onShowLess();
            // From the keyboard, focus goes to the card the stack folds under.
            if (event.detail === 0) {
              const stack = event.currentTarget.closest('[data-notif-stack]');
              requestAnimationFrame(() => (stack?.querySelector('[data-notif-id]') as HTMLElement | null)?.focus());
            }
          }}
        >
          <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth="2.5" />
          {t('notifications:stack.showLess')}
        </button>
      ) : null}
      {appId != null ? (
        <button
          type="button"
          data-notif-app-read={appId}
          className={'inline-flex items-center h-8 px-3 rounded-full text-xs font-semibold '
            + 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 '
            + 'disabled:opacity-40 disabled:hover:bg-zinc-100 dark:disabled:hover:bg-zinc-800 un-touch-target'}
          disabled={busy}
          aria-busy={busy ? 'true' : undefined}
          aria-label={t('notifications:sheet.markAppReadLabel', { app: label })}
          onClick={(event) => {
            // Stopped for the reason every handler in this sheet stops its
            // click: a click that re-renders the list would otherwise bubble
            // to an outside-click listener that dismisses the sheet.
            event.stopPropagation();
            if (busy) return;
            setBusy(true);
            onRead?.();
            Promise.resolve(controller()?.markAppRead(appId))
              .catch(() => false)
              .then(() => setBusy(false));
          }}
        >
          {t('notifications:sheet.markAppRead')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The Unread tab's groups (#5406): rows bucketed by app, in feed order.
 * The first time an app is seen is its newest notification, so the groups
 * are ordered by their newest row and the rows keep their order inside a
 * group. Rows that belong to no app (messages, friends, account) share one
 * "Other" group, under the key `'other'`; `appId` 0 counts as an app, so the
 * staging demo mocks group and show the button.
 */
type AppGroup = {
  key: string;
  appId: number | null;
  /** The first row's appLine, before the "Other" fallback the renderer applies. */
  appLine: string;
  /** #5580: the project's own name, from the first row that carries it. */
  appName?: string | null;
  entries: Entry[];
};

/**
 * #5580: the heading's words: the project's name. A row's appLine is what
 * its meta line says, and the Homeroom bot's says more than the name, so a
 * group led by the bot still reads as its project.
 */
function groupName(group: AppGroup): string {
  return group.appName || group.appLine;
}

export function groupUnreadByApp(rows: ScreenRowView[], t: Translate): AppGroup[] {
  const groups: AppGroup[] = [];
  const byKey = new Map<string, AppGroup>();
  for (const view of rows) {
    const key = view.appId != null ? 'a:' + view.appId : 'other';
    let group = byKey.get(key);
    if (!group) {
      group = { key, appId: view.appId ?? null, appLine: view.appLine || '', entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.appName && view.appName) group.appName = view.appName;
    group.entries.push({ type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view });
  }
  // #5580: one story's notifications become one card first (foldStories in
  // ./notification-stacks.tsx); the rows about nothing in particular still
  // fold by kind.
  for (const group of groups) {
    if (group.appId != null) group.entries = foldRepeats(foldStories(group.entries), t);
  }
  return groups;
}

/** The older rows' sections on Unread, newest first. */
type OlderSectionKey = 'today' | 'yesterday' | 'week' | 'longAgo';

type OlderSection = { key: OlderSectionKey; entries: Entry[] };

const OLDER_SECTION_LABELS: Record<OlderSectionKey, string> = {
  today: 'notifications:sheet.today',
  yesterday: 'notifications:sheet.yesterday',
  week: 'notifications:sheet.lastWeek',
  longAgo: 'notifications:sheet.longAgo',
};

/** Local midnight `days` days before today's. */
function startOfDayBefore(days: number, now: Date): number {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/**
 * `fold` run over each project's entries on its own, the rows of no project
 * left as they are (as groupUnreadByApp leaves its Other group), and every
 * entry kept in its place in the list. Both folds keep the key of the entry
 * a fold stands where, so the list's order comes back from the keys.
 */
function foldEachProject(entries: Entry[], fold: (list: Entry[]) => Entry[]): Entry[] {
  const place = new Map(entries.map((entry, i) => [entry.key, i]));
  const byApp = new Map<number, Entry[]>();
  const out: Entry[] = [];
  for (const entry of entries) {
    const app = entry.view.appId;
    if (app == null) { out.push(entry); continue; }
    const list = byApp.get(app);
    if (list) list.push(entry);
    else byApp.set(app, [entry]);
  }
  for (const list of byApp.values()) out.push(...fold(list));
  return out.sort((a, b) => (place.get(a.key) ?? 0) - (place.get(b.key) ?? 0));
}

/**
 * The older rows on Unread, once they are shown (#5747's follow-up): one
 * card per change, in Today / Yesterday / Last 7 days / Older sections.
 *
 * A request or a proposal is one card with all its notifications
 * (foldStories), wherever in time they fell, and the card goes in the
 * section of its newest one, where foldStories leaves it. The rows about
 * no change keep the Unread tab's rules: a person speaking is a card of
 * its own, and a project's repeats of one kind fold into one card, here
 * inside one section so a fold never spans a week. "Last 7 days" is the
 * five days before yesterday, so the three newest sections are a week.
 */
export function groupOlderByTime(rows: ScreenRowView[], t: Translate, now: Date = new Date()): OlderSection[] {
  const entries: Entry[] = rows.map((view) => ({ type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view }));
  const cards = foldEachProject(entries, (list) => foldStories(list));
  const today = startOfDayBefore(0, now);
  const yesterday = startOfDayBefore(1, now);
  const week = startOfDayBefore(6, now);
  const sections: OlderSection[] = [
    { key: 'today', entries: [] },
    { key: 'yesterday', entries: [] },
    { key: 'week', entries: [] },
    { key: 'longAgo', entries: [] },
  ];
  for (const card of cards) {
    const at = card.at;
    sections[at >= today ? 0 : at >= yesterday ? 1 : at >= week ? 2 : 3].entries.push(card);
  }
  for (const section of sections) section.entries = foldEachProject(section.entries, (list) => foldRepeats(list, t));
  return sections.filter((section) => section.entries.length > 0);
}

type Translate = (id: string, values?: Record<string, unknown>) => string;

/**
 * #5289: the kinds whose repeats have words of their own: the kind's one
 * label, and the counted sentence a group of them reads as. A group of any
 * other kind keeps its label and shows the count pill instead.
 */
const GROUP_LABELS: Record<string, { one: string; many: string }> = {
  voted_change_merged: { one: 'notifications:row.votedMerged.label', many: 'notifications:row.group.votedMerged' },
  pr_proposed: { one: 'notifications:row.proposed.label', many: 'notifications:row.group.proposed' },
  stale_pr: { one: 'notifications:row.stale.label', many: 'notifications:row.group.stale' },
  check_failed: { one: 'notifications:row.checkFailed.label', many: 'notifications:row.group.checkFailed' },
  issue_opened: { one: 'notifications:row.issueOpened.label', many: 'notifications:row.group.issueOpened' },
  issue_mention: { one: 'notifications:row.issueMention.label', many: 'notifications:row.group.issueMention' },
  reaction: { one: 'notifications:row.reaction.label', many: 'notifications:row.group.reaction' },
  session_done: { one: 'notifications:row.session.finished', many: 'notifications:row.group.sessionDone' },
};

/**
 * #5289: inside one project's group, the notifications of one kind that
 * printed one label fold into a single row where the newest of them stood.
 * A person speaking (a conversation row) and a row with buttons of its own
 * never fold: each of those is its own thing to answer. The folded row is
 * the newest member's view carrying every member's id (`groupIds`, its own
 * first) and how many it stands for (`count`).
 */
export function foldRepeats(entries: Entry[], t: Translate): Entry[] {
  const out: Entry[] = [];
  const firstAt = new Map<string, number>();
  for (const entry of entries) {
    const view = entry.view;
    // #5580: a story card is already several notifications; it folds no further.
    const foldable = !!view.kind && !view.conversation && !(view.actions && view.actions.length) && !view.story;
    const key = foldable ? `${view.kind}\n${view.label}` : null;
    const at = key != null ? firstAt.get(key) : undefined;
    if (at == null) {
      if (key != null) firstAt.set(key, out.length);
      out.push(entry);
      continue;
    }
    const lead = out[at].view;
    out[at] = { ...out[at], view: { ...lead, groupIds: [...(lead.groupIds || [lead.id]), view.id] } };
  }
  return out.map((entry) => {
    const ids = entry.view.groupIds;
    if (!ids || ids.length < 2 || entry.view.story) return entry;
    const count = ids.length;
    const words = entry.view.kind ? GROUP_LABELS[entry.view.kind] : undefined;
    const labelled = !!words && t(words.one) === entry.view.label;
    return {
      ...entry,
      view: {
        ...entry.view,
        count,
        label: labelled && words ? t(words.many, { count }) : entry.view.label,
        groupLabelled: labelled,
      },
    };
  });
}

/**
 * A row's own buttons, beside the tap that opens the thing (#1688).
 *
 * #2386: a row with TWO actions (a friend request's Accept and Decline) puts
 * them on their own line under the text, lined up with it past the tile.
 * Beside the text, two pills leave a phone's row a few letters wide. One
 * action ("Still yes") keeps its place at the row's end.
 */
function RowActions({ view, actions }: {
  view: { id: number };
  actions: { key: string; label: string; primary?: boolean }[];
}): ReactNode {
  // #3984: "Still yes" on its way. It is a vote, and on a slow network
  // nothing showed until the server answered, so a second press looked like
  // the thing to do. It reads "Sending…" and takes no press until then; the
  // other row actions are not votes and keep their own behaviour.
  const [busy, setBusy] = useState(false);
  const t = useMessages('notifications');
  const buttons = actions.map((a) => (
    // The widget language's filled pill, through the shell's <Button>:
    // the accent one for the row's primary act, the neutral one beside it.
    <Button
      key={a.key}
      type="button"
      data-notif-action={a.key}
      variant={a.primary ? 'pillAccent' : 'pillNeutral'}
      size="default"
      ink={a.primary ? 'solid' : 'neutral'}
      className="shrink-0"
      disabled={a.key === 'still_yes' && busy}
      aria-busy={a.key === 'still_yes' && busy ? 'true' : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (a.key !== 'still_yes') { controller()?._onRowAction(view.id, a.key); return; }
        if (busy) return;
        setBusy(true);
        Promise.resolve(controller()?._onRowAction(view.id, a.key))
          .catch(() => false)
          .then(() => setBusy(false));
      }}
    >
      {a.key === 'still_yes' && busy ? t('notifications:row.sending') : a.label}
    </Button>
  ));
  if (actions.length > 1) return <div className="flex items-center gap-2 pl-[3.75rem]">{buttons}</div>;
  return <>{buttons}</>;
}

/**
 * The row after `id` in the sheet (or before it, at the end of the list),
 * read off the document before a clear changes the list under it (#3538).
 */
function neighbourRowId(sheet: Element, id: number): string | null {
  const rows = Array.from(sheet.querySelectorAll('[data-notif-id]'));
  const at = rows.findIndex((row) => row.getAttribute('data-notif-id') === String(id));
  if (at < 0) return null;
  const next = rows[at + 1] || rows[at - 1] || null;
  return next ? next.getAttribute('data-notif-id') : null;
}

/**
 * Where focus goes after the × clears a row from the keyboard (#3538). The ×
 * goes with what it cleared (on Unread the whole row leaves; elsewhere the
 * row stays and stops being clearable), and a focused node that leaves the
 * document drops focus on <body>, outside the dialog. So focus moves to the
 * row itself while it is still there, else to its neighbour, else to the
 * sheet's close disc.
 */
function refocusAfterClear(sheet: Element, id: number, neighbourId: string | null): void {
  const focusable = (row: Element | null): HTMLElement | null => {
    if (!row) return null;
    return (row.matches('button') ? row : row.querySelector('button')) as HTMLElement | null;
  };
  const target = focusable(sheet.querySelector(`[data-notif-id="${id}"]`))
    || (neighbourId ? focusable(sheet.querySelector(`[data-notif-id="${neighbourId}"]`)) : null)
    || (sheet.querySelector('#notifications-sheet-close') as HTMLElement | null);
  target?.focus();
}

/**
 * WHAT UNREAD LISTED STAYS LISTED WHILE THE SHEET IS OPEN (polish board #7,
 * 19 Oct 2026). Unread is a live filter over the feed, and the feed is
 * replaced whole by the read the sheet makes as it opens (and by any later
 * one). On an iPhone the sheet opened on "Unread (1)" from the boot copy,
 * and about three seconds later, with no touch, the row had gone and the
 * tab said "You're all caught up": it had been read elsewhere. A list that
 * empties under the eye reads as the app losing it.
 *
 * So every row seen unread while the sheet is open is HELD on Unread until
 * it closes. One that turns read on its own stays where it was, drawn dim
 * and without its dot; the tab's count and Mark all read follow what is
 * still unread. A row the viewer clears (the swipe, the ×, an app's Mark
 * read, Mark all read) is RELEASED first, so it leaves as it always did:
 * that is the viewer's own doing, not the list's.
 */
type HeldUnread = {
  /** Listed on Unread: unread now, or held. */
  listed: (view: ScreenRowView) => boolean;
  /** Let these rows go, so clearing them takes them off Unread. */
  release: (ids: Iterable<ScreenRowView['id']>) => void;
};

type HoldSets = { held: Set<ScreenRowView['id']>; released: Set<ScreenRowView['id']> };

/**
 * One render of useHeldUnread: closed, nothing is held; open, every row
 * unread now is held, unless the viewer has let it go. Changes only the two
 * sets it is handed.
 */
export function holdUnread(sets: HoldSets, open: boolean, all: readonly ScreenRowView[]): void {
  if (!open) {
    sets.held.clear();
    sets.released.clear();
    return;
  }
  for (const view of all) if (view.unread && !sets.released.has(view.id)) sets.held.add(view.id);
}

/** Let rows go (useHeldUnread's `release`). */
export function releaseHeld(sets: HoldSets, ids: Iterable<ScreenRowView['id']>): void {
  for (const id of ids) {
    sets.released.add(id);
    sets.held.delete(id);
  }
}

export function useHeldUnread(open: boolean, all: ScreenRowView[]): HeldUnread {
  const sets = useRef<HoldSets>({ held: new Set(), released: new Set() });
  // Kept in step with the render, not in an effect: an effect runs after the
  // frame that drew the list, and that frame would already be missing the row.
  holdUnread(sets.current, open, all);
  const release = useCallback((ids: Iterable<ScreenRowView['id']>) => releaseHeld(sets.current, ids), []);
  return {
    listed: (view) => view.unread || sets.current.held.has(view.id),
    release,
  };
}

type ScreenRowProps = {
  view: ScreenRowView;
  /** PlatformUI.isTouch() at render time: the swipe on touch, else the ×. */
  touch: boolean;
  /** True on Unread, the one tab a cleared row leaves. */
  removes: boolean;
  /** Read while the sheet was open, and still listed on Unread (useHeldUnread): drawn dim. */
  held?: boolean;
  /** Let the row go before clearing it, so it leaves Unread (useHeldUnread). */
  onRelease?: (ids: Iterable<ScreenRowView['id']>) => void;
  /** #5580: drawn as a card in its project's stack on Unread, in this place. */
  card?: CardPlace | null;
};

/**
 * One notification row, in a SLOT of its own (#3538).
 *
 * CLEARING. An unread row can be cleared without opening it. Clearing is
 * marking read (clearNotification in ./notifications.js), so the row leaves
 * Unread and stays in All without its dot; a read row has nothing to clear
 * and offers nothing. There are two ways to do it, one per kind of hand,
 * each the way the system the request pointed at does it:
 *
 *   - ON A PHONE, the swipe. iOS clears a notification with a swipe to the
 *     left, and a long swipe clears it outright. The swipe is the kit's
 *     (PlatformUI.swipeActions), wired the way the Saved and Invite rows in
 *     ./notifications-list.tsx wire theirs: on touch only, from an effect,
 *     after mount. The kit gives the row `touch-action: pan-y` and puts its
 *     drag through the gesture arbiter, so an up-and-down drag on a row
 *     still scrolls the list, and the kit sheet still pulls down from its
 *     grabber as it did; the row takes only a drag that reads as sideways.
 *     The sheet has no sideways gesture of its own (its tabs are tapped), so
 *     nothing else wants that one.
 *
 *     On Unread the long swipe COMMITS, because there the row leaves: it
 *     slides out and collapses, as on the lock screen. On All
 *     the row stays, so the swipe reveals Clear and a tap on it clears. A
 *     row that slid away and then came straight back without its dot would
 *     say two different things in half a second. The button is the kit's
 *     neutral grey on every tab, not the red of its destructive action,
 *     because clearing deletes nothing.
 *
 *   - AT A DESK, the ×. macOS Notification Center puts a small round × on a
 *     notification's corner while the pointer is over it, and this is that:
 *     the sheet's own white close disc in miniature, on the corner of the
 *     row's tile, drawn on hover. It is a real button BESIDE the row, never
 *     inside it (the row is a button), so it is its own tab stop right after
 *     the row, drawn while either of them has keyboard focus, and named
 *     "Clear notification". It is not rendered on touch at all: there is no
 *     hover there, and an invisible target on a tile's corner is an
 *     accidental clear waiting to happen.
 *
 * WHY THE SLOT. The kit wraps the element it is handed: it moves it into a
 * `.un-swipe` container it inserts in its place, beside the action tray, and
 * a full swipe takes that container out of the document before its handler
 * runs. So the row cannot be a node React places among its siblings, or
 * React would go on removing it from a parent it is no longer in. That is
 * why app-context-sheet.tsx's session rows sit in a <div> of their own
 * (#3515), and it is the same answer here; the × needs a positioned box to
 * sit in anyway. The slot is KEYED on what decides the kit's hold on the
 * row, its read state and its shape, so a row that changes either is a new
 * slot and React drops the old one whole instead of swapping out an element
 * the kit may still be holding (a folded group, #5289, is a shape of its
 * own: it has no bookmark). The hairline between rows follows the
 * slot's place in the list rather than the row's (app.css).
 *
 * #5580: THE CARD. On Unread a row is a card in its project's stack
 * (./notification-stacks.tsx): the shell's card (white, 20px, one hairline),
 * the time at its top right where iOS keeps it, and no project name on its
 * meta line, since the heading over the stack says it. Its × sits on the
 * card's corner. Its bookmark takes the time's place while the pointer is
 * over the card; on a phone, where nothing hovers, Save is the swipe's first
 * button beside Clear. A card about a request or a proposal has a chevron at
 * its foot (a 44px target) that opens its history under its words, and on a
 * phone pressing and holding the card does the same, the way iOS opens a
 * notification you hold; the press that opened it does not also open the
 * notification. The top card of a closed stack opens the stack instead of
 * the notification, and says how many the whole stack is; the cards under it
 * are `inert` until it opens. The slot is the card on a desk; on a phone the
 * swipe host is (it is what slides), and the slot only rounds the kit's wrap.
 */
function ScreenRow({ view, touch, removes, held = false, onRelease, card = null }: ScreenRowProps): ReactNode {
  const t = useMessages('notifications');
  const clearable = view.unread;
  const shape = view.actions && view.actions.length ? 'actions' : 'plain';
  // #5289: a row standing for several notifications of one kind clears,
  // opens and reads as all of them (see foldRepeats).
  const groupIds = view.groupIds && view.groupIds.length > 1 ? view.groupIds : null;
  // #5580: where the card sits in its stack, and whether it has a history to
  // open: a card about a request or proposal, unless it is a fold by kind
  // (several things, not one story) or tucked into a closed stack.
  const top = card && card.top ? card.top : null;
  const closedTop = top && top.closed ? top : null;
  const behind = card && card.behind ? card.behind : 0;
  const story = view.story && view.story.members.length > 1 ? view.story : null;
  const hasHistory = !!card && !closedTop && !behind && !!view.storyKey && (!groupIds || !!story);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    if (!hasHistory) setHistoryOpen(false);
  }, [hasHistory]);
  // A press and hold that opened the history: the lift that follows is not a tap.
  const heldAt = useRef(0);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const letGo = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => letGo, [letGo]);
  // A story card (several notifications about one request or proposal)
  // opens its history on the first tap or click, on a phone and a computer
  // alike (Evan, 20 Oct 2026: on a computer only its chevron did, and a click
  // went straight to the newest). With the history open, the card opens the
  // newest, as before; the chevron folds it away.
  const expands = !!story && hasHistory;
  const open = () => {
    if (Date.now() - heldAt.current < 700) return;
    if (closedTop) { closedTop.open(); return; }
    if (expands && !historyOpen) { setHistoryOpen(true); return; }
    if (groupIds) controller()?.openGroupRow(view.id, groupIds);
    else controller()?._onItemClick(view.id);
  };
  const rowRef = useRef<HTMLElement | null>(null);
  const setRow = useCallback((el: HTMLElement | null) => { rowRef.current = el; }, []);
  // #5580: a card's swipe saves as well as clears.
  // #5775: an older card (in no stack, `removes=false`) saves its newest
  // notification even when it is folded — the same one the card opens. A
  // folded stack card on Unread still has none: a save there is one
  // notification's, and its stack card stands for several.
  const cardSave = !!card && (!groupIds || !removes);
  useEffect(() => {
    const el = rowRef.current;
    const ui = kit();
    // A read card still saves: on a phone the swipe is its only Save (the
    // older rows' stacks are read cards), with nothing to clear beside it.
    if (!(clearable || cardSave) || !touch || !el || !ui?.swipeActions) return undefined;
    const clear = {
      label: t('notifications:row.clear'),
      // The kit's full swipe belongs to its destructive action, and it
      // takes the row out of the document; only Unread wants that.
      destructive: removes,
      color: 'var(--un-action-neutral)',
      handler: () => {
        onRelease?.(groupIds || [view.id]);
        void controller()?.clearNotification(view.id, groupIds || undefined);
      },
    };
    const save = {
      label: t(view.saved ? 'notifications:row.swipeUnsave' : 'notifications:row.swipeSave'),
      color: 'var(--un-action-neutral)',
      handler: () => { void controller()?.toggleSave(view.id); },
    };
    const swipe = ui.swipeActions(el, { actions: !clearable ? [save] : cardSave ? [save, clear] : [clear] });
    return () => swipe.detach();
  }, [clearable, touch, removes, shape, view.id, groupIds?.join(','), t, onRelease, cardSave, view.saved]);

  // The row's tile, its three lines and the count.
  //
  // N6 (polish board, 19 Oct 2026): THE TITLE GETS THE ROW'S WIDTH. A row's
  // end held an unread dot, a chevron and the bookmark, and on a phone that
  // left the title about 30 characters. The chevron went (the whole row is
  // the tap, as a notification is on the lock screen), and the dot moved
  // into the row's left margin beside the tile, where Mail keeps it.
  const body = card ? null : (
    <>
      <span className="relative flex shrink-0">
        {view.unread ? (
          <span
            className="absolute -left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-zinc-900 dark:bg-zinc-100"
            aria-label={t('notifications:row.unreadDot')}
          >
          </span>
        ) : null}
        <AvatarChip view={view} />
      </span>
      <span className="flex-1 min-w-0">
        {/* WHAT KIND. Its own line since the subject stopped sharing one with
            it: the label is the same words on every row of a kind, so it
            scans as a column down the left edge, and the subject below it
            gets the row's whole width to truncate in. Semibold-small keeps
            it legible while ranking it under the subject — and tells it
            apart from the meta line, which is the same size in regular
            weight. A kind with no subject to name (a collaborator invite is
            entirely its own label) renders on the SUBJECT's line instead: a
            heading over nothing is worse than either line alone. */}
        {view.segments.length ? (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {view.label}
          </span>
        ) : null}
        {/* WHICH ONE — the PR's title, the conversation, the message. The
            row's own content, and the only line whose text differs between
            two notifications of the same kind, so it carries the strong ink.
            #5289: two lines before it is cut, not one: a title cut to one
            line on a phone was rarely enough to tell two changes apart. */}
        <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100 line-clamp-2 break-words">
          {view.segments.length ? view.segments.map((segment, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <span
              key={index}
              className={segment.t === 'who'
                ? 'font-bold'
                : segment.t === 'strong'
                  ? 'font-semibold'
                  : 'font-normal text-zinc-700 dark:text-zinc-300'}
            >
              {(index > 0 ? ' ' : '') + (segment.t === 'who' ? `@${segment.v}` : segment.v)}
            </span>
          )) : view.label}
        </span>
        {/* #3227: what this kind of row means, for the one kind that needs
            saying (kudos). It wraps: a truncated explanation explains nothing. */}
        {view.note ? (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {view.note}
          </span>
        ) : null}
        {/* WHERE · WHO · WHEN. Everything the copy used to repeat inside a
            sentence lives on this line instead, which is what let the row
            spend its other two lines on the kind and the subject — see
            rowView in ./notifications.js. `by` is absent on a system row
            (nobody did it) and on the two key rows (the name there is the
            subject). */}
        <span className="block text-xs text-zinc-500 truncate">
          {/* The when is its own element so it can carry the unelided instant
              in `title` (#1808) — the rest of the line is plain text, and the
              separator rides inside it rather than as a whitespace-only
              child, same rule as everywhere else on this row. */}
          {view.time ? (
            /* One message per shape of the line: where from, who, when. The
               time keeps its own element, separator included, as a tag. */
            view.appLine && view.by ? (
              <RichMessage
                id="notifications:row.meta.sourceByWhen"
                values={{ source: view.appLine, username: view.by, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : view.appLine ? (
              <RichMessage
                id="notifications:row.meta.sourceWhen"
                values={{ source: view.appLine, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : view.by ? (
              <RichMessage
                id="notifications:row.meta.byWhen"
                values={{ username: view.by, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : <time title={view.timeTitle}>{view.time}</time>
          ) : view.appLine && view.by
            ? t('notifications:row.meta.sourceBy', { source: view.appLine, username: view.by })
            : view.by ? t('notifications:row.meta.by', { username: view.by }) : view.appLine}
        </span>
      </span>
      <RunCount view={view} />
    </>
  );

  // On a phone, pressing and holding a card with a history opens it; a drag
  // (a scroll, the swipe) lets go first.
  const hold = hasHistory && touch ? {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'touch') return;
      letGo();
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          heldAt.current = Date.now();
          setHistoryOpen((was) => !was);
        }, 450),
      };
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const at = press.current;
      if (at && Math.abs(event.clientX - at.x) + Math.abs(event.clientY - at.y) > 10) letGo();
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
    onPointerLeave: letGo,
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
  } : {};
  // #1688: a row with an action of its own ("Still yes" on a re-confirm ask)
  // keeps the row as the tap that opens the thing, and puts the action
  // beside it as a real button — never a button inside a button.
  const actions = view.actions || [];
  const row = actions.length ? (
    <div
      ref={touch ? undefined : setRow}
      data-notif-id={view.id}
      // #2386: two actions (a friend request's Accept and Decline) stack
      // under the text; see RowActions.
      // #4769: the row's right padding is pr-16, not the px-4 it was, so the
      // bookmark button (16px in from the slot's edge, N6) never sits over
      // the text.
      className={card
        ? 'notifications-row col-start-1 row-start-1 w-full pl-5 pr-4 py-3 flex flex-col gap-2'
        : actions.length > 1
          ? 'notifications-row w-full pl-4 pr-16 py-3.5 flex flex-col gap-2'
          : 'notifications-row w-full pl-4 pr-16 py-3.5 flex items-center gap-3'}
    >
      <button
        className={card ? 'min-w-0 flex-1 w-full text-left flex items-start gap-3' : 'min-w-0 flex-1 text-left flex items-center gap-4'}
        aria-expanded={closedTop ? 'false' : expands ? (historyOpen ? 'true' : 'false') : undefined}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        {...hold}
      >
        {card ? <CardWords view={view} card={card} hasHistory={hasHistory} saveOnHover={cardSave && !touch} /> : body}
      </button>
      {/* #5580: on a card one action sits under the words too, as two do. */}
      {card && actions.length === 1 ? (
        <div className="flex items-center gap-2 pl-[3.75rem]"><RowActions view={view} actions={actions} /></div>
      ) : <RowActions view={view} actions={actions} />}
    </div>
  ) : (
    <button
      ref={touch ? undefined : setRow}
      data-notif-id={view.id}
      data-notif-group-size={groupIds ? groupIds.length : undefined}
      className={card
        ? 'notifications-row col-start-1 row-start-1 w-full text-left pl-5 pr-4 py-3 rounded-[20px] '
          + 'hover:bg-black/[.02] dark:hover:bg-white/[.03] transition-colors flex items-start gap-3'
        : 'notifications-row w-full text-left pl-4 pr-16 py-3.5 '
          + 'hover:bg-black/[.03] dark:hover:bg-white/[.04] transition-colors flex items-center gap-4'}
      aria-expanded={closedTop ? 'false' : expands ? (historyOpen ? 'true' : 'false') : undefined}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      {...hold}
    >
      {card ? <CardWords view={view} card={card} hasHistory={hasHistory} saveOnHover={cardSave && !touch} /> : body}
    </button>
  );
  // #4769: the row's own save. Outline until saved, filled violet (the
  // accent) once it is. Absolutely placed 16px in from the slot's right
  // edge, in line with the sheet's close disc above it (N6: it sat 2px from
  // the edge), vertically centred, with a 36px target — a second action on a
  // phone-width row needs a real one. `stopPropagation` first, for the
  // reason every handler in this sheet stops its click: this is not a tap
  // that opens the row.
  // #5289: a folded group has no bookmark: a save is one notification's,
  // and the row stands for several. Each one is on All, with its own.
  // #5775: an older folded card is the exception (cardSave): it saves its
  // newest notification, the one it opens, and says so with the filled
  // bookmark beside its time once it is saved.
  // #5580: on a card it takes the time's place while the pointer is over
  // it, and on a phone the swipe's Save stands in for it.
  const bookmark = (groupIds && !cardSave) || (card && touch) ? null : (
    <button
      type="button"
      data-notification-save={view.id}
      aria-pressed={view.saved ? 'true' : 'false'}
      aria-label={t(view.saved ? 'notifications:row.unsave' : 'notifications:row.save')}
      className={card
        ? 'absolute right-2 top-1.5 flex h-8 w-8 items-center justify-center rounded-full '
          + 'transition-opacity hover:bg-black/[.04] dark:hover:bg-white/[.06] '
          + 'pointer-events-none opacity-0 '
          + 'group-hover/notif:pointer-events-auto group-hover/notif:opacity-100 '
          + 'group-has-[:focus-visible]/notif:pointer-events-auto group-has-[:focus-visible]/notif:opacity-100 '
          + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500'
        : 'absolute right-4 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center '
          + 'rounded-full transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06] '
          + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500'}
      onClick={(event) => {
        event.stopPropagation();
        controller()?.toggleSave(view.id);
      }}
    >
      {view.saved
        ? <BookmarkSolidIcon aria-hidden="true" className={card ? 'h-[18px] w-[18px] text-violet-700 dark:text-violet-400' : 'h-5 w-5 text-violet-700 dark:text-violet-400'} />
        : <BookmarkIcon aria-hidden="true" className={card ? 'h-[18px] w-[18px] text-zinc-500 dark:text-zinc-400' : 'h-5 w-5 text-zinc-500 dark:text-zinc-400'} />}
    </button>
  );
  // #5580: the history's chevron, at the foot of the card in the row's own
  // grid cell (the slot, or the swipe host, is a one-column grid in card
  // form), and the history itself under the words.
  const history = hasHistory ? (
    <>
      <button
        type="button"
        data-notif-history={view.id}
        aria-expanded={historyOpen ? 'true' : 'false'}
        aria-label={t(historyOpen ? 'notifications:history.hide' : 'notifications:history.show')}
        className={'relative z-[1] col-start-1 row-start-1 self-end justify-self-end mr-2.5 mb-2.5 '
          + 'flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 dark:text-zinc-400 '
          + 'hover:bg-black/[.04] hover:text-zinc-900 dark:hover:bg-white/[.06] dark:hover:text-zinc-100 '
          + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 un-touch-target'}
        onClick={(event) => {
          event.stopPropagation();
          setHistoryOpen((was) => !was);
        }}
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={historyOpen ? 'h-4 w-4 rotate-180 transition-transform duration-300' : 'h-4 w-4 transition-transform duration-300'}
          strokeWidth="2.5"
        />
      </button>
      <CardHistory view={view} open={historyOpen} />
    </>
  ) : null;
  // On touch the bookmark is INSIDE the swipe host, so a swipe translates
  // row and bookmark together; on desktop the slot keeps its flat structure,
  // which is what dapp.json's selectors read. The row hands `setRow` to the
  // wrapper on touch and keeps it itself on desktop, because swipeActions
  // must hold whichever node translates.
  const swipeHost = touch ? (
    <div ref={setRow} data-notif-swipe className={card ? CARD_SURFACE + ' relative grid grid-cols-1' : 'relative'}>
      {row}
      {bookmark}
      {history}
    </div>
  ) : row;
  const slotCls = 'notifications-row-slot group/notif relative'
    + (card ? (touch ? ' notifications-card rounded-[20px]' : ' notifications-card grid grid-cols-1 ' + CARD_SURFACE) : '')
    + (held ? ' opacity-60' : '');
  return (
    <div
      key={`${clearable ? 'unread' : 'read'}:${shape}${groupIds ? ':group' : ''}`}
      className={slotCls}
      data-notif-held={held ? '' : undefined}
      data-stack-top={top ? '' : undefined}
      data-stack-behind={behind || undefined}
      inert={behind ? true : undefined}
      aria-hidden={behind ? 'true' : undefined}
    >
      {swipeHost}
      {clearable && !touch ? (
        <button
          type="button"
          data-notification-clear={view.id}
          aria-label={groupIds
            ? t('notifications:row.clearGroupLabel', { count: groupIds.length })
            : t('notifications:row.clearLabel')}
          // Hidden until the pointer is over the slot or something in it has
          // keyboard focus, and untouchable while hidden, so a click on the
          // corner of the tile opens the row as it always did.
          className={(card ? 'absolute -left-1.5 -top-1.5 z-[2] flex h-5 w-5 items-center justify-center rounded-full ' : 'absolute left-1.5 top-2 flex h-5 w-5 items-center justify-center rounded-full ')
            + 'bg-white text-zinc-900 shadow-sm ring-1 ring-black/10 hover:bg-zinc-50 '
            + 'dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/15 dark:hover:bg-zinc-800 '
            + 'pointer-events-none opacity-0 transition-opacity '
            + 'group-hover/notif:pointer-events-auto group-hover/notif:opacity-100 '
            + 'group-has-[:focus-visible]/notif:pointer-events-auto group-has-[:focus-visible]/notif:opacity-100 '
            + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500'}
          onClick={(event) => {
            // Stopped for the reason every handler in this sheet stops its
            // click: the re-render takes this node out of the document before
            // the event finishes bubbling, and an outside-click listener
            // would then dismiss the sheet under the viewer. The row's own
            // click is not in the way at all; the × is beside it, not in it.
            event.stopPropagation();
            const sheet = event.currentTarget.closest('#notifications-sheet');
            // `detail` is 0 for a click the keyboard made (Enter or Space).
            const fromKeyboard = event.detail === 0;
            const neighbourId = sheet ? neighbourRowId(sheet, view.id) : null;
            onRelease?.(groupIds || [view.id]);
            void controller()?.clearNotification(view.id, groupIds || undefined);
            if (fromKeyboard && sheet) {
              requestAnimationFrame(() => refocusAfterClear(sheet, view.id, neighbourId));
            }
          }}
        >
          <XIcon aria-hidden="true" className="h-3 w-3" strokeWidth="2.5" />
        </button>
      ) : null}
      {/* #4769: AFTER the clear button in DOM order — the declared checks
          read the slot's direct children as row + clear pair, and the
          bookmark joins at the end. Touch renders it inside the swipe host
          instead, so it is not here at all. */}
      {!touch ? bookmark : null}
      {!touch ? history : null}
    </div>
  );
}

/** #5580: the card's surface: the shell's card (GroupedList's), with a soft lift. */
const CARD_SURFACE = 'rounded-[20px] bg-white dark:bg-zinc-900 '
  + 'shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_1px_2px_rgba(0,0,0,0.05)]';

/** A card's project name leading its meta line: the line's size, a step darker, so a list of them scans by project. */
const PROJECT_INK = 'font-medium text-zinc-600 dark:text-zinc-300';

/**
 * #5580: a card's words. The same three lines in the same order as a row's
 * (what kind, which one, the meta line), so what reads a row reads a card;
 * the time moves up beside the kind, at the card's top right, and the meta
 * line names only what the heading over the stack does not: who did it, a
 * source other than the project, or for the bot's news just the bot. A
 * story card names its request or proposal and how many notifications it
 * is. The top card of a stack says how many the whole stack is; the line
 * stays while the stack is open, folded to nothing, so the card shrinks and
 * grows with the stack instead of jumping. A card in no stack (the older
 * rows, one per change) has no heading over it, so its meta line names the
 * project first: "Book club · #5748 · 2 notifications".
 */
function CardWords({ view, card, hasHistory, saveOnHover }: {
  view: ScreenRowView;
  card: CardPlace;
  hasHistory: boolean;
  /** The bookmark takes the time's place while the pointer is over the card. */
  saveOnHover: boolean;
}): ReactNode {
  const t = useMessages('notifications');
  const story = view.story && view.story.members.length > 1 ? view.story : null;
  const top = card.top || null;
  const source = view.botMoment && view.appId != null ? t('notifications:row.bot.name')
    : view.appLine && view.appLine !== card.groupName ? view.appLine : null;
  const by = view.botMoment ? null : view.by;
  // #5929: the top card of a closed stack says one number, the stack's
  // total, on its last line; its own story count waits until the stack opens.
  const closedTop = !!(top && top.closed);
  const meta = story && !(closedTop && !view.storyRef) ? (view.storyRef
    ? (closedTop
      ? t('notifications:story.ref', { number: view.storyRef.number })
      : t('notifications:story.meta', { number: view.storyRef.number, count: story.members.length }))
    : t('notifications:story.metaUnnumbered', { count: story.members.length }))
    : source && by ? t('notifications:row.meta.sourceBy', { source, username: by })
      : by ? t('notifications:row.meta.by', { username: by }) : source;
  // A card in no stack says its project first, where the heading would have.
  const project = card.leadsWithProject && card.groupName ? card.groupName : null;
  return (
    <>
      <span className="relative flex shrink-0 self-start mt-0.5">
        {view.unread ? (
          <span
            className="absolute -left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-zinc-900 dark:bg-zinc-100"
            aria-label={t('notifications:row.unreadDot')}
          >
          </span>
        ) : null}
        <AvatarChip view={view} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="flex-1 min-w-0 truncate">{view.segments.length ? view.label : null}</span>
          {view.saved ? (
            <BookmarkSolidIcon aria-hidden="true" className="h-3 w-3 shrink-0 self-center text-violet-700 dark:text-violet-400" />
          ) : null}
          {view.time ? (
            <time
              title={view.timeTitle}
              className={saveOnHover
                ? 'shrink-0 group-hover/notif:invisible group-has-[:focus-visible]/notif:invisible'
                : 'shrink-0'}
            >
              {view.time}
            </time>
          ) : null}
        </span>
        <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100 line-clamp-2 break-words">
          {story && view.storyRef && view.storyRef.title ? view.storyRef.title : subjectOf(view)}
        </span>
        {view.note ? (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {view.note}
          </span>
        ) : null}
        <span className={hasHistory ? 'block text-xs text-zinc-500 truncate pr-8' : 'block text-xs text-zinc-500 truncate'}>
          {project && meta ? (
            <RichMessage id="notifications:story.projectMeta" values={{ project, meta }} components={[<span className={PROJECT_INK} />]} />
          ) : project ? <span className={PROJECT_INK}>{project}</span> : meta}
        </span>
        {top ? (
          <span
            className={'grid transition-[grid-template-rows,opacity] duration-300 '
              + (top.closed ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] opacity-0')}
            aria-hidden={top.closed ? undefined : 'true'}
          >
            <span className="min-h-0 overflow-hidden">
              <span className="block pt-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {t('notifications:stack.showAll', { count: top.total })}
              </span>
            </span>
          </span>
        ) : null}
      </span>
      {closedTop ? null : <RunCount view={view} />}
    </>
  );
}

/** The subject line's words: the row's segments, else its label (a kind with no subject). */
function subjectOf(view: ScreenRowView): ReactNode {
  return view.segments.length ? view.segments.map((segment, index) => (
    // eslint-disable-next-line react/no-array-index-key
    <span
      key={index}
      className={segment.t === 'who'
        ? 'font-bold'
        : segment.t === 'strong'
          ? 'font-semibold'
          : 'font-normal text-zinc-700 dark:text-zinc-300'}
    >
      {(index > 0 ? ' ' : '') + (segment.t === 'who' ? `@${segment.v}` : segment.v)}
    </span>
  )) : view.label;
}

/*
 * A collapsed conversation run says how many it stands for. Only ever
 * rendered above 1, so an ordinary row is unchanged — and it is a COUNT, not
 * an alerting badge: it sits in the row's own ink when the run is read,
 * violet only while it is still waiting on you. A folded group whose label
 * already says the number (#5289) does not say it twice.
 */
function RunCount({ view }: { view: ScreenRowView }): ReactNode {
  const t = useMessages('notifications');
  if (!view.count || view.count < 2 || view.groupLabelled) return null;
  return (
    <span
      className={'shrink-0 min-w-[1.5rem] px-2 h-6 rounded-full text-[11px] font-semibold '
        + 'flex items-center justify-center '
        + (view.unread
          ? 'bg-violet-600 text-white'
          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400')}
      aria-label={t('notifications:row.runCount', { count: view.count })}
    >
      {view.count > 99 ? '99+' : view.count}
    </span>
  );
}

export function NotificationsSheetView() {
  const { open, adopted } = useStoreState(notificationsSheetStore) as {
    open: boolean; adopted: boolean;
  };

  // Pull-to-refresh went with the screen root. A kit sheet owns the vertical
  // drag for its own dismiss gesture, so a pull-down inside one cannot also
  // mean "reload" — the controller refreshes on open instead.
  const snap = useStoreState(notificationsStore) as {
    screenList: ScreenRowView[] | null;
    screenCanLoadMore?: boolean;
    loadingMore: boolean;
    /** #5289: the bell's number, which the Unread tab prints too. */
    badgeTotal?: number;
    /** #5527: the Unread tab's own pager — see loadMoreUnread(). */
    unreadCanLoadMore?: boolean;
    loadingUnread?: boolean;
    /** #5527: bumped when a refresh lands — the auto-fill's trigger. */
    refreshTick?: number;
    /** #3538: the rows' clear is a swipe on touch and a × everywhere else. */
    touch?: boolean;
  };
  // Unread, not All: the bell is tapped because it has a count.
  const [tab, setTab] = useState<Tab>('unread');
  // The Unread tab's own reveal (#4700): "See older notifications" shows the
  // older, mostly read rows IN PLACE instead of jumping to All, and turns
  // into "Hide older notifications" while they are showing. It is a per-visit
  // state, not a preference — an effect below collapses it when the sheet
  // closes or the tab changes, so coming back to Unread starts collapsed
  // again. It starts false, so the prerendered markup is unchanged.
  const [olderShown, setOlderShown] = useState(false);
  // #3206: the All tab's kind chip, or null for every kind. Per visit, like
  // the reveal above: it starts null (the prerender has no chips anyway, as
  // the sheet opens on Unread) and is forgotten when the sheet closes.
  const [kindFilter, setKindFilter] = useState<KindFilter | null>(null);
  // #5405: what the search field holds. It narrows the tab that is open —
  // both tabs, and a tab change keeps it. It starts '' so the
  // prerendered markup is an empty field; the restore effect below reads
  // the remembered value back after mount (#5460), so the field still holds
  // what you typed when you come back — opening a row closes the sheet, and
  // a query wiped on close was lost on every round trip to a proposal.
  const [query, setQuery] = useState('');
  // #5460: every write to the query goes through this one helper. A
  // non-empty query is remembered for the browser tab's session — the scope
  // AppView.KANBAN_FILTERS_KEY uses for the board's filters: it survives
  // leaving the screen and a reload, and goes away when the tab closes —
  // and an empty one forgets it, so a cleared field stays cleared. Storage
  // that is unavailable (private mode, blocked) changes nothing: the search
  // then just behaves as it did before, within the page.
  const rememberQuery = useCallback((next: string) => {
    setQuery(next);
    try {
      if (next) window.sessionStorage.setItem('usernode:notifications-search', next);
      else window.sessionStorage.removeItem('usernode:notifications-search');
    } catch { /* storage unavailable */ }
  }, []);
  const t = useMessages('notifications');

  // `?shot=notifications-all` lands on All, so the capture pipeline and the
  // declared checks can reach the archive, which is otherwise one click away
  // and so invisible to both. It is where a plain message's notification is
  // listed (#18: Unread leaves those to the Messages screen), since #5289
  // took out the Messages filter that used to be this address's.
  //
  // In an effect and not in the initial state, for the reason every deep link
  // in this bundle is: the SSG pass renders this island in Node, where there
  // is no `location`, and the prerendered markup has to match the client's
  // first pass byte for byte. A console error on any route fails proposal
  // checks.
  useIsomorphicLayoutEffect(() => {
    let shot: string | null = null;
    try { shot = new URLSearchParams(window.location.search).get('shot'); }
    catch { shot = null; }
    if (shot === 'notifications-all') setTab('all');
  }, []);

  // #5460: the remembered search comes back after mount, not in the initial
  // state — the SSG pass renders this island in Node with no sessionStorage,
  // and the prerendered field has to stay empty so hydration matches (the
  // reason every deep link in this bundle reads its address in an effect: a
  // console error on any route fails proposal checks). An empty or missing value
  // restores nothing, so a search you cleared stays cleared.
  useEffect(() => {
    try {
      const remembered = window.sessionStorage.getItem('usernode:notifications-search');
      if (remembered) setQuery(remembered.slice(0, 100));
    } catch { /* storage unavailable */ }
  }, []);

  // The expanded Unread view is forgotten when the sheet closes or you leave
  // the tab, so each visit to Unread starts collapsed again (see the state
  // above). The query is NOT: it is remembered for the tab session (#5460),
  // because opening a row closes the sheet, and clearing it here made every
  // round trip to a proposal re-widen the list. An effect, not the initial
  // state, for the same hydration reason.
  useEffect(() => {
    if (!open) setOlderShown(false);
    else if (tab !== 'unread') setOlderShown(false);
    if (!open) setKindFilter(null);
  }, [open, tab]);

  // #5527: the Unread tab fills itself up to the bell's number. The badge
  // counts every unread row on the account; the sheet opens with only the
  // unread among the newest 100 fetched, so a backlog reads as "Unread (46)"
  // over a list of 1. While the pager says there are more unread to bring
  // up, opening the sheet walks it automatically — up to the controller's
  // five batches — so a big catch-up list is already complete when the
  // viewer arrives, and anything still deeper waits behind the foot button
  // rather than hanging the opening.
  //
  // The trigger is a refresh LANDING while the sheet is open (refreshTick),
  // not the open itself: opening the sheet always refreshes first
  // (notifications-sheet-controller's onOpen), and a fill that starts before
  // that refresh lands is thrown away by it — refresh replaces the whole
  // feed. Arming on open and firing when the tick changes is the one order
  // that cannot race. It re-fires on every later refresh too, which is what
  // keeps the tab topped up while it sits open: loadMoreUnread no-ops
  // without a fetch once the list has caught up with the badge, so a
  // refresh on a caught-up tab costs nothing. A reset when the sheet closes
  // makes each opening re-arm.
  const unreadFillTickRef = useRef(null);
  useEffect(() => {
    if (!open) { unreadFillTickRef.current = null; return; }
    if (tab !== 'unread') return;
    if (unreadFillTickRef.current == null) {
      // Armed: remember the tick this opening starts from and fill nothing
      // yet — the refresh that opening triggers has not landed.
      unreadFillTickRef.current = snap.refreshTick;
      return;
    }
    if (unreadFillTickRef.current === snap.refreshTick) return;
    unreadFillTickRef.current = snap.refreshTick;
    if (!snap.unreadCanLoadMore) return;
    controller()?.loadMoreUnread();
  }, [open, tab, snap.refreshTick, snap.unreadCanLoadMore]);

  const all = snap.screenList || [];
  // Unread LISTS what was unread while the sheet has been open (polish #7,
  // useHeldUnread); its count and Mark all read follow what still is.
  const held = useHeldUnread(open, all);
  // #18 (19 Oct 2026 polish board): plain messages are the Messages
  // screen's, as the bell's count (_badgeTotal, less messageUnread) leaves
  // them out, so Unread lists what the number it prints counts. All still
  // has them.
  const unread = all.filter((view) => held.listed(view) && !view.plainMessage);
  const unreadNow = all.filter((view) => view.unread && !view.plainMessage);
  // #3206: a kind chip narrows All only; Unread is grouped by project instead.
  const kindOn = tab === 'all' ? kindFilter : null;
  const rows = tab === 'unread' ? unread
    : kindOn ? all.filter((view) => matchesKindFilter(view.kind, kindOn)) : all;
  // What the tab DRAWS. On Unread expanded (#4700) the older rows — the read
  // ones already in hand, plus any further page the server still has — show
  // UNDER the unread ones, on the same tab. `rows` stays the tab's own filter:
  // the footer's conditions read it, and the list is `shown`.
  const shown = tab === 'unread' && olderShown ? all : rows;
  // #5289: the tab prints the BELL'S number, through the bell's own cap, so
  // the bell, this tab and the browser tab's title say one thing. It used to
  // sum the unread rows paged in so far, which on a backlog was a count of
  // the list ("Unread (81)") under a bell saying 99+ and a title saying 300.
  const unreadCount = snap.badgeTotal || 0;
  const boundary = startOfToday();
  const entries: Entry[] = shown.map((view) => (
    { type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view }));
  const today = entries.filter((entry) => entry.at >= boundary);
  const earlier = entries.filter((entry) => entry.at < boundary);
  // #5405: the query narrows what the open tab already drew — the same
  // `entries`. Whitespace-only is no query
  // at all. While it is active the headings, the pinned sections and the
  // pager footers step aside, and the empty state is the search one.
  const needle = normalizeNotificationQuery(query);
  const searching = !!needle;
  const matches = searching
    ? entries.filter((entry) => matchesNotificationQuery(entry, needle))
    : entries;
  // #5406: on Unread in its collapsed state — the one the sheet opens in, and
  // the list you are trying to empty — the rows group under one heading per
  // app, with that app's "Mark read" beside it, instead of under Today and
  // Earlier, and a project's repeats fold into one row (#5289, foldRepeats).
  // Unread only: All keeps the time-grouped flat list,
  // and once the older rows are revealed on Unread the tab is the archive
  // again, so it draws Today/Earlier as it always did. `unread` is feed
  // order (newest first), so groupUnreadByApp's insertion order keeps the
  // groups newest-first too.
  const groupedUnread = tab === 'unread' && !olderShown;
  // Evan, 21 Oct 2026: the older rows were a flat list, so revealing them
  // undid the stacks the tab opened on. Revealed, Unread keeps its stacks.
  // The rows it does not list followed under Earlier as one closed stack per
  // project, which hid every change but the newest behind "N more
  // notifications" and read as one pile per project. They are one card per
  // change instead, in Today / Yesterday / Last 7 days / Older
  // (groupOlderByTime), each naming its project on its meta line. Nothing
  // there is to be cleared, so nothing there needs piling up.
  const olderGrouped = tab === 'unread' && olderShown;
  const appGroups = groupedUnread || olderGrouped ? groupUnreadByApp(unread, t) : [];
  const listedIds = new Set(unread.map((view) => view.id));
  const olderSections = olderGrouped ? groupOlderByTime(all.filter((view) => !listedIds.has(view.id)), t) : [];
  // #5580: each project is a stack of cards (./notification-stacks.tsx),
  // under the same heading and its Mark read.
  const renderAppGroup = (group: AppGroup): ReactNode => {
    const label = group.key === 'other' || !group.appLine ? t('notifications:sheet.group.other') : groupName(group);
    return (
      <ProjectStack
        key={group.key}
        groupKey={group.key}
        name={label}
        entries={group.entries}
        sheetOpen={open}
        head={(showLess) => (
          <AppGroupHead
            groupKey={group.key}
            label={label}
            // N6 (polish board): with one group on the tab its Mark read is Mark
            // all read again, a pill's width apart, so the title row's is the one.
            appId={appGroups.length > 1 ? group.appId : null}
            onRead={() => held.release(group.entries.flatMap((entry) => (entry.type === 'notif'
              ? entry.view.groupIds || [entry.view.id] : [])))}
            onShowLess={showLess}
          />
        )}
        renderCard={renderCard}
      />
    );
  };
  // An older section: its heading, then one card per change. The cards are
  // read, so no Mark read, and a cleared card (an unread plain message)
  // stays where it is. They sit in no stack, so each names its project on
  // its meta line; the list borrows the stacks' card spacing (app.css
  // `.notifications-stack`) and is never closed.
  const renderOlderSection = (section: OlderSection): ReactNode => (
    <Fragment key={section.key}>
      <SectionHeader data-notif-older-head={section.key}>
        {t(OLDER_SECTION_LABELS[section.key])}
      </SectionHeader>
      <div className="notifications-stack" data-notif-older={section.key}>
        {section.entries.map((entry) => (
          <ScreenRow
            key={entry.key}
            view={entry.view}
            touch={!!snap.touch}
            removes={false}
            onRelease={held.release}
            card={{
              groupName: entry.view.appId != null ? entry.view.appName || entry.view.appLine : '',
              leadsWithProject: true,
            }}
          />
        ))}
      </div>
    </Fragment>
  );
  const renderEntry = (entry: Entry): ReactNode => (
    <ScreenRow
      key={entry.key}
      view={entry.view}
      touch={!!snap.touch}
      removes={tab === 'unread'}
      held={tab === 'unread' && !entry.view.unread && !olderShown}
      onRelease={held.release}
    />
  );
  // #5580: a card in a project's stack, which only collapsed Unread draws:
  // the same row, handed its place.
  const renderCard = (entry: Entry, place: CardPlace): ReactNode => (
    <ScreenRow
      key={entry.key}
      view={entry.view}
      touch={!!snap.touch}
      removes
      held={!entry.view.unread}
      onRelease={held.release}
      card={place}
    />
  );

  // `whitespace-nowrap`: "Unread (12)" is two words and the strip is a flex
  // row inside a phone-width sheet, so the count wrapped onto a second line
  // and the tab grew a line taller than its neighbours. The label is a label —
  // it does not wrap, it just takes the width it needs.
  // The chip rail (see @/components/ui/chip.tsx for the idiom): selection
  // is the language's solid inversion, not an underline or the accent.
  const tabCls = (active: boolean) =>
    'shrink-0 whitespace-nowrap h-9 px-4 rounded-full text-sm font-semibold transition-colors '
    + (active
      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      : 'bg-white text-zinc-900 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800');

  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop owns it — see lib/sheet-controller.js. */}
      <div
        id="notifications-sheet-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40"
        onClick={() => NotificationsSheet.close()}
      >
      </div>
      <div
        id="notifications-sheet"
        role="dialog"
        aria-label={t('notifications:sheet.title')}
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className={'fixed z-50 flex flex-col dc-lift dc-lift-panel nav-sheet-transition'}
      >
      {/*
          THE SHEET RISES ON THE LIFT a dev session does — the same radius,
          hairline and two-layer shadow — on `.dc-lift-panel`, which is that
          glass plus a third shadow layer: the modal dim, cast OUTWARD by this
          element instead of painted behind it.

          That inversion is the whole of why the sheet stopped looking dull.
          The dim used to live on #notifications-sheet-overlay at `z-40`, under
          the sheet at `z-50` — and `backdrop-filter` samples whatever is
          painted behind, so the glass was frosting an already-dimmed page and
          composited to #cac7c3. An OUTER box-shadow is clipped to outside the
          border box, so it never enters this element's own backdrop: the sheet
          frosts the undimmed page while the same declaration darkens
          everything around it. The overlay is still there and still dismisses
          on click; it just paints nothing now.

          On top of that surface: a title row of its own — the name, Mark all
          read as a small pill (only on Unread, the tab whose list it empties),
          and the close disc. The tabs under it are the chip rail.
      */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-1 shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {t('notifications:sheet.title')}
        </h2>
        {tab === 'unread' ? (
          <button
            id="notifications-screen-mark-all"
            type="button"
            className={'inline-flex items-center h-8 px-3 rounded-full text-xs font-semibold '
              + 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 '
              + 'disabled:opacity-40 disabled:hover:bg-zinc-100 dark:disabled:hover:bg-zinc-800 un-touch-target'}
            disabled={!unreadNow.length}
            onClick={() => {
              held.release(unread.map((view) => view.id));
              void controller()?.markAllRead();
            }}
          >
            {t('notifications:sheet.markAllRead')}
          </button>
        ) : null}
        <button
          id="notifications-sheet-close"
          type="button"
          className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm '
            + 'hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 un-touch-target'}
          aria-label={t('core:common.close')}
          onClick={() => NotificationsSheet.close()}
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>
      {/*
          #5405: the search field, between the title and the tab strip — the
          Discover field's shape (browse-screen.tsx): a white rounded field,
          a magnifying glass on its left, grey hint text, filtering as you
          type with no button to press. Escape with text in it empties the
          field instead of reaching whatever else would hear it; an empty
          field's Escape is not intercepted.
      */}
      <div id="notifications-search" className="px-4 pt-1 pb-2 shrink-0">
        <div className="relative">
          <SearchIcon
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
            aria-hidden="true"
          />
          <input
            id="notifications-search-input"
            type="search"
            value={query}
            onChange={(event) => rememberQuery(event.currentTarget.value.slice(0, 100))}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.currentTarget.value) {
                event.preventDefault();
                event.stopPropagation();
                rememberQuery('');
              }
            }}
            placeholder={t('notifications:sheet.search.placeholder')}
            aria-label={t('notifications:sheet.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
          />
        </div>
      </div>
      <div
        id="notifications-screen-tabs"
        className={'flex gap-2 px-4 pt-1 pb-2 shrink-0 overflow-x-auto '
          + '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}
        role="tablist"
        aria-label={t('notifications:sheet.filters')}
      >
        <button
          id="notifications-tab-unread"
          role="tab"
          aria-selected={tab === 'unread'}
          className={tabCls(tab === 'unread')}
          onClick={() => setTab('unread')}
        >
          {unreadCount > 99 ? t('notifications:sheet.tab.unreadCountCapped')
            : unreadCount ? t('notifications:sheet.tab.unreadCount', { count: unreadCount })
              : t('notifications:sheet.tab.unread')}
        </button>
        <button
          id="notifications-tab-all"
          role="tab"
          aria-selected={tab === 'all'}
          className={tabCls(tab === 'all')}
          onClick={() => setTab('all')}
        >
          {t('notifications:sheet.tab.all')}
        </button>
      </div>
      {/* #3206: All's kind chips, the Discover filter rail's chips at the
          bar's size. A toggle each (aria-pressed), one lit at a time. */}
      {tab === 'all' ? (
        <ChipRail
          id="notifications-kind-filters"
          role="group"
          aria-label={t('notifications:sheet.kinds')}
          className="gap-2 pt-0 pb-2 shrink-0"
        >
          {(NOTIFICATION_KIND_FILTER_KEYS as readonly KindFilter[]).map((key) => (
            <Chip
              key={key}
              id={`notifications-kind-${key}`}
              size="bar"
              className="px-4"
              selected={kindFilter === key}
              onClick={(event) => {
                event.stopPropagation();
                setKindFilter(kindFilter === key ? null : key);
              }}
            >
              {t(KIND_FILTER_LABELS[key])}
            </Chip>
          ))}
        </ChipRail>
      ) : null}
      {/* The sheet's own scroller. The screen root used to be the scroller;
          a sheet's head has to stay put while its rows move, so the rows get
          a box of their own. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll">
      {/*
          Saved messages + collaborator invites, pinned above the rows — they
          moved here with the list from the drawer's notifications block.
          Above the tab sections deliberately: an invite is actionable on
          either tab, and a save has no read state to filter by.
      */}
      {/*
          "Mark all read" lives in the title row above (see the comment on
          the sheet root), as a small pill between the name and the close
          disc.

          It once sat at the far right of the tab row, in tab-sized ink on
          the same baseline as the tabs, which made a control
          that CHANGES data look like a fourth place to go; then under the
          rail as a text button. The title-row pill keeps the point of both
          moves — it shares no baseline and no shape with the chips, so it
          cannot be read as a tab — and it still exists only on Unread,
          because "mark all read" while looking at All is an offer to act on
          rows you are not being shown. It is rendered even
          with nothing unread (disabled), so the row does not reflow the
          first time you clear the list.
      */}
      {/* A kind chip shows only that kind, so the pinned sections step aside too. */}
      {searching || kindOn ? null : <NotificationsPinnedSections />}
      {/* #5405: while searching the list is ONLY the matches — no headings,
          no pager — and a query with no matches gets one line saying so. */}
      {searching ? (
        matches.length ? matches.map(renderEntry) : (
          <p id="notifications-search-empty" className="px-4 py-8 text-sm text-zinc-500 dark:text-zinc-500 text-center">
            {t('notifications:sheet.search.noMatches', { query: query.trim() })}
          </p>
        )
      ) : null}
      {!searching && (groupedUnread ? appGroups.map(renderAppGroup) : olderGrouped ? (
        <>
          {appGroups.map(renderAppGroup)}
          {olderSections.map(renderOlderSection)}
        </>
      ) : (
        <>
          {today.length ? (
            <>
              <SectionHead>
                {t('notifications:sheet.today')}
              </SectionHead>
              {today.map(renderEntry)}
            </>
          ) : null}
          {earlier.length ? (
            <>
              <SectionHead>
                {t('notifications:sheet.earlier')}
              </SectionHead>
              {earlier.map(renderEntry)}
            </>
          ) : null}
        </>
      ))}
      {!searching && !entries.length ? (
        <p className="px-4 py-8 text-sm text-zinc-500 text-center">
          {tab === 'unread' ? t('notifications:sheet.empty.unread')
            : kindOn ? t('notifications:sheet.empty.kind') : t('notifications:sheet.empty.other')}
        </p>
      ) : null}
      {/*
          THE WAY ON, and it depends on which tab you are standing on.

          On UNREAD it shows the older rows IN PLACE (#4700), where it used to
          be the All tab. Paging Unread still cannot mean "more of the thing
          you are trying to get to zero" — the older rows are mostly read, and
          that is exactly why they now show UNDER the unread ones instead of
          somewhere else. The collapsed footer reveals them, walking the same
          loadOlder cursor the All tab's pager uses (a no-op on its own when
          every loaded row is already in hand); once they are showing the
          button reads "Hide older notifications" and collapses the list back
          to just the unread ones, and a further page offers the ordinary
          pager above it.

          On ALL it is the loader it always was.

          Either way it renders only when there IS something more: rows this
          filter is hiding, or another page on the server. An empty Unread tab
          on a quiet account would otherwise offer a link to an equally empty
          All, which is a dead end dressed as a way forward.
      */}
      {searching ? null : (tab === 'unread' && !olderShown ? (
        <>
          {/* #5527: the bell's number, completed. The badge counts every
              unread row on the account; the sheet's first page holds only the
              unread among the newest 100 fetched, so a backlog read as
              "Unread (46)" over a list of 1. Opening auto-fills up to five
              batches (the effect above); this is what anything still deeper
              waits behind — it pages `?unread=1`, the exact set the badge
              counts, until the tab is as long as the bell. */}
          {snap.unreadCanLoadMore ? (
            <div className="px-4 py-3">
              <button
                id="notifications-load-unread"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingUnread}
                onClick={() => controller()?.loadMoreUnread()}
              >
                {snap.loadingUnread ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.unread')}
              </button>
            </div>
          ) : null}
          {(all.length > unread.length || snap.screenCanLoadMore) ? (
            <div className="px-4 py-3">
              <button
                id="notifications-see-older"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingMore}
                onClick={() => {
                  setOlderShown(true);
                  controller()?.loadOlder();
                }}
              >
                {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.reveal')}
              </button>
            </div>
          ) : null}
        </>
      ) : tab === 'unread' && olderShown && (all.length > unread.length || snap.screenCanLoadMore) ? (
        <>
          {snap.screenCanLoadMore ? (
            <div className="px-4 py-3">
              <button
                id="notifications-load-older"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingMore}
                onClick={() => controller()?.loadOlder()}
              >
                {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.load')}
              </button>
            </div>
          ) : null}
          <div className="px-4 py-3">
            <button
              id="notifications-hide-older"
              type="button"
              className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline"
              onClick={() => setOlderShown(false)}
            >
              {t('notifications:sheet.older.hide')}
            </button>
          </div>
        </>
      ) : tab === 'all' && snap.screenCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            id="notifications-load-older"
            type="button"
            className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
            disabled={snap.loadingMore}
            onClick={() => controller()?.loadOlder()}
          >
            {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.load')}
          </button>
        </div>
      ) : null)}
      </div>
      </div>
      <OverlayScrim panelId="notifications-sheet" backdropId="notifications-sheet-overlay" />
    </>
  );
}
