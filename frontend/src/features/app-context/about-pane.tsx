/**
 * About — the second pane of the app-context sheet (#2718), drawn the way the
 * navigation prototype draws it (nav-prototype.html, `sheetHtml` case
 * 'about'): the app's page, as a pop-up.
 *
 * ── What it says, in the design's order ────────────────────────────────
 *
 *   1. WHO IT IS. A large tile, the name, the tagline, the builders' avatars
 *      and how many members its community has ("12 members", #4218).
 *   2. WHAT YOU CAN DO WITH IT (an app): Open — Resume for the app you
 *      parked, and nothing at all for the app already running — Add to
 *      your apps, and, for a member, Invite. HOW BIG IT IS (the platform):
 *      apps, members, merged.
 *   3. WHO BUILDS IT. Contributors, each with what they have merged, each
 *      opening that person's page.
 *   4. MORE. Add to home screen, Remix (a fork, to the code; "Remix" to
 *      people), Code (on GitHub, or on Homeroom's git host), and the
 *      version as a plain row,
 *      "App version: a1b2c3d" (#4218). A remix also says what it was
 *      remixed from, under its description.
 *
 * The line that said how it is built ("Notes’s community builds it
 * together. How changes work") and the Share row are gone from both panes:
 * the line said the same thing everywhere, and an app's Invite is how
 * people are brought in now.
 *
 * ── It is still a PANE, not a sheet ────────────────────────────────────
 *
 * The design presents About as a sheet of its own. Here it is the menu's
 * second pane, which #2740 settled: the kit cannot present a sheet while it
 * is still dismissing another, and "about" is where the menu goes rather than
 * something that opens over it. What matches the design is the CONTENT and
 * its order; the sheet's header row stays, as the way back.
 *
 * ── Every fact is the one the platform already has ─────────────────────
 *
 * Discover's app page (../apps/browse-detail.tsx) is the same page at full
 * size, so this reads its sources and nothing else: the app row, its ranked
 * contributors, and Home.menuItemsFor's action list — see ./about-data.ts.
 * Homeroom's pane adds GET /api/platform/about for its figures.
 *
 * ── The product's own truths, kept ─────────────────────────────────────
 *
 *   - `#improve-row-github` is the design's "Source code": a row reading
 *     Code, only where there is a repository, opening away from the shell.
 *     Where the code is decides the rest (lib/repo-link.js). On GitHub (the
 *     platform's own repository) it wears GitHub's mark and "Public on
 *     GitHub" muted at its end, because every repository there is public
 *     (an import must be public already). On Homeroom's own git host, where
 *     app code lives since the move off GitHub, it wears the neutral code
 *     mark and claims nothing: a repository there can be private.
 *   - `#app-about-invite` is the hub's Invite (../dev-board/workshop/
 *     community-card.tsx openInviteLinks), for a member as there: it turns
 *     this sheet to its invite pane (AppContext.openInvite, which waits for
 *     the link so the pane comes in at its own height), and Back there
 *     returns here. Every member sees it, a newcomer still offered "Go to
 *     Homeroom" too: #4216 hid Share from them, which handed out the app's
 *     address, but an invite link is what the hub offers every member and
 *     what the server lets any member make, so hiding it here alone kept
 *     nobody from inviting.
 *   - Add to home screen is a ROW now, as the design draws it, but it is the
 *     row the product already had: for an app, the per-app install page its
 *     card menu and its Discover page offer (#1508, #2320) — Home.menuItemsFor's
 *     `install`, found by key, not rebuilt; for Homeroom, which IS this
 *     page's PWA, the OS's own steps, because iOS exposes no install API and
 *     Android's prompt fires only when Chrome decides it should
 *     (../mobile-install/detect.ts). Not the native app's widget pin
 *     (`add-to-homescreen`), which Discover leaves out too: it shows its
 *     result in Home's widget strip, which is not on screen from here, so
 *     the tap looked like nothing. Where there is no home screen (a laptop)
 *     there is no row, and none for Homeroom once it is launched from one.
 *
 * ── A viewer who is not served the platform's row ──────────────────────
 *
 * About Homeroom still opens for them (./platform-target.js): who it is, the
 * three figures and its Code row. The contributor
 * list is the platform row's, which the API does not serve them, so it is not
 * drawn rather than drawn as an error.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CodeIcon,
  Glyph,
  GitHubIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { linkKind } from '../../lib/repo-link.js';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { improveStore } from '../improve/improve-store.js';
import { A2HS_STEPS, detectMobileOs } from '../mobile-install/detect';
import { isNativeApp, isStandalone } from '../mobile-install/environment';
import { parkedStore } from '../nav/parked-store.js';
import { AppContext } from './app-context-controller.js';
import {
  contributorNote,
  contributorView,
  membersPillText,
  openLabel,
  shortVersionOf,
  statCards,
  taglineOf,
  versionRowText,
  type AppRow,
} from './about-model';
import {
  listRowFor,
  useAboutApp,
  useContributors,
  usePlatformAbout,
} from './about-data';

/**
 * The mark on a link that leaves Homeroom (#5927), where a row inside the
 * platform has its chevron: the glyph, and the words for a screen reader.
 * Here for the Code row below, and exported for the menu pane's links out
 * (./app-context-sheet.tsx: Privacy, and Add Homeroom when it opens the browser).
 */
export function ExternalMark({ className = 'w-4 h-4 text-zinc-400 dark:text-zinc-500' }: { className?: string }): ReactNode {
  const t = useMessages('agent');
  return (
    <>
      <ArrowTopRightOnSquareIcon data-external-mark="" className={'shrink-0 ' + className} aria-hidden="true" />
      <span className="sr-only">{t('agent:appContext.opensOutside')}</span>
    </>
  );
}

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

/** The menu's own section label (./app-context-sheet.tsx SECTION). */
const SECTION = 'px-5 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';

const NOTE = 'px-5 py-2 text-sm text-zinc-500 dark:text-zinc-400';

/**
 * The two glyphs the icon set has no name for, drawn on its grid through its
 * escape hatch: the design's fork, and its "add to home screen" plus-in-a-
 * phone. A table because that is what `Glyph` is for.
 */
const GLYPHS = {
  fork: 'M6 7a2 2 0 100-4 2 2 0 000 4zm12 0a2 2 0 100-4 2 2 0 000 4zm-6 14a2 2 0 100-4 2 2 0 000 4zM6 7v1a4 4 0 004 4h4a4 4 0 004-4V7m-6 5v5',
  homeScreen: 'M7 3h10a3 3 0 013 3v12a3 3 0 01-3 3H7a3 3 0 01-3-3V6a3 3 0 013-3zm5 5v8m-4-4h8',
} as const;

/** How many contributors show before "Show all" — Discover's own fold. */
const CONTRIB_FOLD = 5;

type HomeApi = {
  isYours?: (app: AppRow) => boolean;
  toggleAdded?: (slug: string, desired: boolean, onChange?: () => void) => unknown;
  menuItemsFor?: (app: AppRow) => Array<{ key: string; label: string; run: (el?: unknown) => void }>;
};

function home(): HomeApi | null {
  return (typeof window === 'undefined' ? null : (window as unknown as { Home?: HomeApi }).Home) || null;
}

function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
      {children}
    </span>
  );
}

/** A MORE row that does something (a button), dismissing the menu first when asked. */
function ActionRow({ id, icon, label, sub = null, onClick }: {
  id: string;
  icon: ReactNode;
  label: string;
  /** A second, quieter line under the label (Remix's "Make your own copy"). */
  sub?: string | null;
  onClick: () => void;
}): ReactNode {
  return (
    <button id={id} type="button" className={sub ? `${ROW} py-2` : ROW} onClick={onClick}>
      <Icon>{icon}</Icon>
      {sub ? (
        <span className="flex-1 min-w-0">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{sub}</span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      )}
    </button>
  );
}

/**
 * Where a remix came from: the resolved `forked_from` the app row carries
 * (attachForkLineage in src/routes/apps.js: `{ slug, name, linkable }`, or
 * null for an app that is not a copy and for one in demo mode). A deleted
 * original resolves to "<deleted>" and is text, not a link. Pure; the line
 * it feeds is pinned by tests/app-about-pane.test.js.
 */
function lineageOf(row: AppRow | null | undefined): { name: string; deleted: boolean; href: string | null } | null {
  const ref = row ? row.forked_from : null;
  if (!ref || typeof ref !== 'object') return null;
  const name = typeof ref.name === 'string' && ref.name ? ref.name : '<deleted>';
  const href = ref.linkable && typeof ref.slug === 'string' && ref.slug
    ? `#app/${encodeURIComponent(ref.slug)}`
    : null;
  // `deleted`: the original is gone and `name` is only a placeholder; the line says so in its own words.
  return { name, deleted: !(typeof ref.name === 'string' && ref.name), href };
}

/**
 * The menu dismisses before anything that presents a surface of its own —
 * the fork dialog, the install page — because the kit
 * cannot present one while it is still tearing the other down (the ordering
 * the menu's terminal row already keeps).
 */
function afterDismiss(then: () => void): void {
  void AppContext.dismissForNav().then(then);
}

/** A person's initial in the roster's circle — Discover's contributor disc. */
function Avatar({ who, size }: { who: string; size: 'sm' | 'xs' }): ReactNode {
  const box = size === 'xs'
    ? 'w-6 h-6 text-[0.625rem] ring-2 ring-white dark:ring-zinc-900'
    : 'w-7 h-7 text-xs';
  return (
    <span
      aria-hidden="true"
      className={`${box} shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/40 `
        + 'text-violet-700 dark:text-violet-300 font-semibold flex items-center justify-center'}
    >
      {(who[0] || '?').toUpperCase()}
    </span>
  );
}

/**
 * The roster's rows and its fold. The rows sit in their own wrapper so the
 * toggle can name what it opens (aria-controls) and say whether it is open
 * (aria-expanded), as Discover's list's "Show more" does (#2991). The wrapper
 * adds no box of its own: each row is already a full-width flex line.
 */
export function ContributorsFold({ people, total, showAll, onToggle }: {
  people: ReturnType<typeof contributorView>[];
  total: number;
  showAll: boolean;
  onToggle: () => void;
}): ReactNode {
  const t = useMessages('agent');
  const shown = showAll ? people : people.slice(0, CONTRIB_FOLD);
  return (
    <>
      {shown.length ? (
        <div id="app-about-contributors-list">
          {shown.map((c) => [c, contributorNote(c)] as const).map(([c, note]) => (
            <a
              key={c.who}
              data-contributor={c.who}
              href={`#leaderboard/users/${encodeURIComponent(c.who)}`}
              className={ROW}
              onClick={() => { void AppContext.dismissForNav(); }}
            >
              <Avatar who={c.who} size="sm" />
              <span className="flex-1 min-w-0 truncate font-medium">{`@${c.who}`}</span>
              {/* "Creator", "3 live", both, or nothing: a zero says nothing. */}
              {note ? <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{note}</span> : null}
            </a>
          ))}
        </div>
      ) : null}
      {people.length > CONTRIB_FOLD ? (
        <button
          id="app-about-contributors-toggle"
          type="button"
          aria-expanded={showAll}
          aria-controls="app-about-contributors-list"
          className="w-full px-5 min-h-[40px] text-left text-sm font-medium text-violet-700 dark:text-violet-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          onClick={onToggle}
        >
          {showAll ? t('agent:appContext.about.contributors.showFewer') : t('agent:appContext.about.contributors.showAll', { count: total })}
        </button>
      ) : null}
    </>
  );
}

/**
 * `label` is the app's name. `unnamed` (no name has loaded, and `label` is a
 * stand-in) is the sheet's to pass and nothing here reads it now: the app's
 * note, which had wording of its own for it, is gone.
 */
export function AboutPane({ label }: { label: string; unnamed?: boolean }): ReactNode {
  const t = useMessages('agent');
  const {
    slug, target, restricted, repoUrl, canShare, version, iconUrl, iconEmoji, tab, deploying,
  } = useStoreState(improveStore);
  const { app: parked } = useStoreState(parkedStore);
  const platform = target === 'platform';
  const isApp = target === 'app';

  const row = useAboutApp(slug, !!slug && !restricted);
  const contributors = useContributors(slug, !!slug && !restricted);
  const about = usePlatformAbout(platform);

  const [added, setAdded] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [a2hsOpen, setA2hsOpen] = useState(false);

  // Read once per mount rather than per render: neither the user agent nor
  // the touch-point count changes while a sheet is open, and this pane is
  // mounted and unmounted by the view switch above it.
  const os = useMemo(() => (typeof navigator === 'undefined'
    ? null
    : detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0)), []);

  // The card menu's items for this app — the list Discover's page draws its
  // action rows from. Two of them are About's MORE rows.
  const items = useMemo(() => {
    const menuItemsFor = home()?.menuItemsFor;
    if (!isApp || !row || typeof menuItemsFor !== 'function') return [];
    try { return menuItemsFor(row) || []; } catch { return []; }
  }, [isApp, row]);
  const homeScreenItem = items.find((i) => i && i.key === 'install');
  const forkItem = items.find((i) => i && i.key === 'fork');

  // ── Identity ──────────────────────────────────────────────────────
  const tagline = platform ? (about?.tagline || taglineOf(row)) : taglineOf(row);
  const shortSha = platform
    ? (about?.version || version || shortVersionOf(row))
    : (shortVersionOf(row) || version);
  const updatedAt = platform
    ? (about?.updatedAt || row?.last_deploy_at || null)
    : (row?.last_deploy_at || row?.created_at || null);
  const updated = updatedAt ? agoStamp(updatedAt) : null;
  const versionText = versionRowText(shortSha || null, !!deploying && !platform, platform);
  // The platform shows its members as a figure card below, so the pill is
  // an app's.
  const pill = isApp ? membersPillText(row?.member_count) : null;
  const ready = contributors.state === 'ready' ? contributors.items : [];
  const stack = ready.slice(0, 4).map(contributorView);
  const record = {
    icon_url: row?.icon_url || iconUrl || (row?.icon_image_id ? `/app-icons/${row.icon_image_id}` : null),
    icon_emoji: row?.icon_emoji || iconEmoji || null,
    name: label,
  };

  // ── Actions (an app) ──────────────────────────────────────────────
  const running = isApp && tab === 'app';
  const isParked = !!parked && parked.slug === slug;
  const open = openLabel(row?.status || (canShare ? 'running' : null), isParked);
  const listRow = listRowFor(slug);
  const yours = added ?? !!(
    (listRow && home()?.isYours?.(listRow))
    || (!listRow && row && ((row.is_collaborator && !row.your_apps_hidden) || row.is_favorited))
  );
  // The hub's rule for its Invite: a member's. GET /api/apps's row says so.
  const canInvite = !!row?.is_member;

  // ── More ──────────────────────────────────────────────────────────
  const repoAddress = platform ? (about?.repoUrl || repoUrl) : (repoUrl || row?.repo_url || null);
  const repoKind = repoAddress ? linkKind(repoAddress) : null;
  // Only an address that leaves for code is a Code row: GitHub's or the git
  // host's. Anything else (a Homeroom page, a non-web address) is none.
  const repo = repoKind === 'github' || repoKind === 'code' ? repoAddress : null;
  const platformA2hs = platform && !!os
    && typeof window !== 'undefined' && !isStandalone() && !isNativeApp();
  const showHomeScreen = platform ? platformA2hs : !!homeScreenItem;
  const showFork = isApp && !!forkItem;
  const lineage = isApp ? lineageOf(row) : null;

  const people = ready.map(contributorView);

  return (
    <div id="app-about-pane" className="pb-1">
      {/*
          WHO IT IS. The name is always here, so the pane never opens empty
          whatever else is missing. An app with no manifest description has
          no line under it: its address stood there once, and read as noise
          to a newcomer (#4218).
      */}
      <div id="app-about-identity" className="flex items-start gap-3.5 px-5 pt-2 pb-3">
        {platform ? (
          <img
            src="/brand/homeroom-mark.png"
            alt=""
            aria-hidden="true"
            draggable="false"
            width={64}
            height={64}
            className="platform-mark-tile w-16 h-16 rounded-2xl shrink-0"
          />
        ) : (
          <AppIconLink
            // The Open button's destination and exit: the sheet closes first.
            slug={isApp && open.canOpen && !running ? slug : null}
            name={label}
            onOpen={(s) => afterDismiss(() => window.App?.openAppTab?.(s, 'app'))}
            className="app-icon-tile w-16 h-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-2xl"
            data-icon={appIconKind(record)}
          >
            <AppIconContent app={record} />
          </AppIconLink>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[1.0625rem] leading-snug font-semibold text-zinc-900 dark:text-zinc-100 break-words">
            {label}
          </div>
          {/* #3572: three lines at most. A description made on the create
              screen fits two lines of the hub hero (services/create-options.js
              DESCRIPTION_MAX); this column, beside the icon and a size
              smaller, needs a third for the same line. A longer one from a
              repository's own dapp.json stops there with an ellipsis. */}
          {tagline ? (
            <p id="app-about-tagline" className="mt-0.5 line-clamp-3 text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400">
              {tagline}
            </p>
          ) : null}
          {/* A remix says what it was remixed from, under its description:
              the line Discover's page draws under its version, in the same
              amber, opening the original the way a contributor row opens a
              person (the sheet closes first). */}
          {isApp && lineage ? (
            <p id="app-about-lineage" className="mt-0.5 text-xs text-amber-600 dark:text-amber-400 truncate">
              {lineage.href ? (
                <a
                  href={lineage.href}
                  className="hover:underline"
                  title={lineage.deleted ? t('agent:appContext.about.lineage.linkTitleDeleted', { open: '<', close: '>' }) : t('agent:appContext.about.lineage.linkTitle', { app: lineage.name })}
                  onClick={() => { void AppContext.dismissForNav(); }}
                >
                  {lineage.deleted ? t('agent:appContext.about.lineage.remixedFromDeleted', { open: '<', close: '>' }) : t('agent:appContext.about.lineage.remixedFrom', { app: lineage.name })}
                </a>
              ) : (
                <span title={t('agent:appContext.about.lineage.goneTitle')}>{lineage.deleted ? t('agent:appContext.about.lineage.remixedFromDeleted', { open: '<', close: '>' }) : t('agent:appContext.about.lineage.remixedFrom', { app: lineage.name })}</span>
              )}
            </p>
          ) : null}
          {stack.length || pill ? (
            <div id="app-about-pills" className="mt-2 flex flex-wrap items-center gap-2">
              {stack.length ? (
                <span className="flex -space-x-1.5" aria-hidden="true">
                  {stack.map((c) => <Avatar key={c.who} who={c.who} size="xs" />)}
                </span>
              ) : null}
              {pill ? (
                <span
                  id="app-about-members"
                  className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap"
                >
                  {pill}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {isApp ? (
        <div id="app-about-actions" className="flex items-stretch gap-2 px-5 pb-2">
          {running ? null : (open.canOpen ? (
            <a
              id="app-about-open"
              href={slug ? `/app/${encodeURIComponent(slug)}` : '#'}
              className="inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-4 rounded-full text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
              onClick={(event) => {
                const nav = (window as unknown as {
                  NavLink?: { isNativeClick?: (e: unknown) => boolean };
                }).NavLink;
                if (nav?.isNativeClick?.(event)) return;
                event.preventDefault();
                if (!slug) return;
                // The router's own "this app, this tab": it switches tabs for
                // the open app and navigates for any other — the parked
                // strip's Resume, for the same reason.
                afterDismiss(() => window.App?.openAppTab?.(slug, 'app'));
              }}
            >
              {open.label}
            </a>
          ) : (
            <span
              id="app-about-open"
              aria-disabled="true"
              className="inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-4 rounded-full text-sm font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
            >
              {open.label}
            </span>
          ))}
          <button
            id="app-about-add"
            type="button"
            data-added={String(yours)}
            disabled={yours}
            // The design's proportions: "✓ Added" is a compact state; "Add to
            // My apps" is sized to its words beside Open — a phone's sheet
            // has not room for both at half width without truncating it —
            // and takes the whole row when Open is gone.
            className={`inline-flex ${!yours && running ? 'flex-1 basis-0' : 'shrink-0'} min-w-0 items-center justify-center gap-1.5 h-10 px-4 rounded-full text-sm font-semibold whitespace-nowrap `
              + 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 '
              + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:hover:bg-white dark:disabled:hover:bg-zinc-900 '
              + 'text-zinc-900 dark:text-zinc-100 disabled:text-zinc-500 dark:disabled:text-zinc-400 transition-colors'}
            onClick={() => {
              const api = home();
              if (!slug || !api?.toggleAdded) return;
              setAdded(true);
              // Home keeps both copies of the list honest and says what
              // happened (a toast either way). The pane reads the answer back
              // from the list, so a refused add un-ticks itself.
              api.toggleAdded(slug, true, () => {
                const now = listRowFor(slug);
                if (now && api.isYours) setAdded(!!api.isYours(now));
              });
            }}
          >
            {yours ? (
              <>
                <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{t('agent:appContext.about.added')}</span>
              </>
            ) : <span className="truncate">{t('agent:appContext.about.addToMyApps')}</span>}
          </button>
          {/*
              INVITE, for a member, as the hub's is (../dev-board/workshop/
              community-card.tsx openInviteLinks). Beside Open it is Add's
              pill, sized to its word: Open is the row's one filled button.
              With Open gone it takes Open's place, the filled pill taking
              what Add leaves, so the row inside the app is "✓ Added" and
              the one thing to do there.
          */}
          {canInvite && running ? (
            <Button
              id="app-about-invite"
              type="button"
              variant="pillAccent"
              size="none"
              className="inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-4 text-sm font-semibold whitespace-nowrap"
              onClick={() => { void AppContext.openInvite({ back: 'about' }); }}
            >
              <span className="truncate">{t('agent:appContext.about.invite')}</span>
            </Button>
          ) : canInvite ? (
            <button
              id="app-about-invite"
              type="button"
              className={'inline-flex shrink-0 min-w-0 items-center justify-center h-10 px-4 rounded-full text-sm font-semibold whitespace-nowrap '
                + 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 '
                + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100 transition-colors'}
              onClick={() => { void AppContext.openInvite({ back: 'about' }); }}
            >
              <span className="truncate">{t('agent:appContext.about.invite')}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {platform ? (
        // `data-loaded` once GET /api/platform/about has answered: the cards
        // hold their place with a dash until then, and a check can tell a
        // figure from a placeholder.
        <div
          id="app-about-stats"
          data-loaded={about ? '' : undefined}
          className="grid grid-cols-3 gap-2 px-5 pb-2"
        >
          {statCards(about?.stats || null).map((card) => (
            <div
              key={card.key}
              data-stat={card.key}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700/70 bg-white/70 dark:bg-zinc-800/50 px-1.5 py-2.5 text-center"
            >
              <b className="block text-lg leading-tight font-semibold text-zinc-900 dark:text-zinc-100">
                {about ? card.value : '–'}
              </b>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{card.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/*
          WHO BUILDS IT — GET /api/apps/:slug/contributors, the list Discover's
          page ranks, in the order it arrives. Each row opens that person's
          page: the leaderboard's drill-in, where Discover's rows go too
          (Browse.openContributor).
      */}
      {(isApp || platform) && !restricted ? (
        <section id="app-about-contributors" aria-label={t('agent:appContext.about.contributors.heading')}>
          <h4 className={SECTION}>{t('agent:appContext.about.contributors.heading')}</h4>
          {contributors.state === 'loading' ? <p className={NOTE}>{t('agent:appContext.about.contributors.loading')}</p> : null}
          {contributors.state === 'error' ? <p className={NOTE}>{t('agent:appContext.about.contributors.failed')}</p> : null}
          {contributors.state === 'ready' && !people.length ? <p className={NOTE}>{t('agent:appContext.about.contributors.none')}</p> : null}
          <ContributorsFold
            people={people}
            total={contributors.total || people.length}
            showAll={showAll}
            onToggle={() => setShowAll((v) => !v)}
          />
        </section>
      ) : null}

      {showHomeScreen || repo || showFork || versionText ? (
        <section id="app-about-more" aria-label={t('agent:appContext.about.more')}>
          <h4 className={SECTION}>{t('agent:appContext.about.more')}</h4>
          {showHomeScreen ? (
            <ActionRow
              id="app-about-a2hs"
              icon={<Glyph d={GLYPHS.homeScreen} />}
              label={t('agent:appContext.about.addToHomeScreen')}
              onClick={() => {
                if (platform) {
                  setA2hsOpen((v) => !v);
                  return;
                }
                if (homeScreenItem) afterDismiss(() => homeScreenItem.run());
              }}
            />
          ) : null}
          {platform && a2hsOpen && os ? (
            <p id="app-about-a2hs-steps" className={NOTE}>{t(A2HS_STEPS[os])}</p>
          ) : null}
          {showFork && forkItem ? (
            <ActionRow
              id="app-about-fork"
              icon={<Glyph d={GLYPHS.fork} />}
              label={t('agent:appContext.about.remix')}
              sub={t('agent:appContext.about.remixSub')}
              onClick={() => afterDismiss(() => forkItem.run())}
            />
          ) : null}
          {/* Code is last of the rows: the one that leaves Homeroom. */}
          {repo ? (
            <a
              id="improve-row-github"
              href={repo}
              target="_blank"
              rel="noreferrer"
              className={ROW}
              onClick={() => { void AppContext.dismissForNav(); }}
            >
              <Icon>{repoKind === 'github' ? <GitHubIcon /> : <CodeIcon />}</Icon>
              <span className="flex-1 min-w-0 truncate font-medium">{t('agent:appContext.about.code')}</span>
              {repoKind === 'github' ? (
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{t('agent:appContext.about.codePublic')}</span>
              ) : null}
              <ExternalMark />
            </a>
          ) : null}
          {/* THE VERSION, last and plain (#4218): a fact for whoever needs
              it, not an action, so a line with no glyph and no hover. It
              kept the id the pill had. */}
          {versionText ? (
            <p
              id="app-about-version"
              title={updated?.title ? t('agent:appContext.about.liveSince', { when: updated.title }) : undefined}
              className="px-5 min-h-[44px] flex items-center text-sm text-zinc-500 dark:text-zinc-400"
            >
              {versionText}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
