/**
 * Home in the one frame, under the glass look.
 *
 * The first screen drawn with the frame primitives (frontend/@/components/
 * ui/frame.tsx, status.tsx), as proposal C of the 2026-11-06 screen tour
 * draws it: a title, the sentence "What needs you, then your places.", one
 * primary action (Make a project), then four groups in the 720px column —
 * what waits for the viewer (rows ending in the one word that says what to
 * do), the launcher grid of pinned apps (the one tile on the product: an app
 * is the one thing you launch), the viewer's communities, and the public
 * ones they are not in — with two facts in the 320px column beside it.
 *
 * HomeScreen (../index.tsx) mounts this instead of the standard body only
 * after mount, when lib/skin.ts says the device's look is glass, so the
 * prerendered document is never contradicted. The standard Home is not
 * touched. Three nodes the legacy home.js still writes into stay in the
 * DOM, hidden, so its writes land somewhere harmless.
 *
 * Data: the pins store the standard Home already keeps (../home-pins-store),
 * the same public directory read (../communities-to-join), and the Needs
 * you feed (GET /api/workshop/needs-feed, the Workshop's own read).
 */
import { useEffect, useState } from 'react';

import { Columns, Group, PageFrame, PrimaryButton, QuietButton } from '@/components/ui/frame';
import { StatusPill, StatusRow, type Tone } from '@/components/ui/status';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { AppGrid } from '../app-grid';
import { gridStore } from '../grid-store';
import { readDirectory } from '../communities-to-join';
import { homePinsStore, loadHomePins, type HomePin, type JoinedCommunity } from '../home-pins-store';

/** A row of GET /api/workshop/needs-feed, the fields this screen reads. */
export type FeedRow = {
  id: number;
  kind: string;
  title: string | null;
  number?: number | null;
  app?: { slug?: string; name?: string; icon_url?: string | null; icon_emoji?: string | null; icon_color?: string | null } | null;
  app_slug?: string;
  app_name?: string;
  /** The viewer's vote is what it waits for. */
  approve?: boolean;
  /** One word for what it waits on instead, when not the viewer. */
  waiting?: string | null;
  waiting_on?: unknown[] | null;
};

type DirectoryApp = NonNullable<Awaited<ReturnType<typeof readDirectory>>>[number] & {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  member_count?: number | null;
};

/** The 40px picture that leads every row (spec rule 2). */
function Lead({ name, iconUrl, iconEmoji, iconColor }: {
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  iconColor?: string | null;
}) {
  const style = iconColor ? { backgroundColor: iconColor } : undefined;
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-[color:var(--sunk)] text-[15px] font-bold text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--line)]"
      style={style}
      aria-hidden="true"
    >
      {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" /> : (iconEmoji || name.slice(0, 1).toUpperCase())}
    </span>
  );
}

function feedWaiting(row: FeedRow): string | null {
  if (typeof row.waiting === 'string' && row.waiting) return row.waiting;
  if (Array.isArray(row.waiting_on) && row.waiting_on.length) return String(row.waiting_on[0]);
  return null;
}

function joinedAsPin(c: JoinedCommunity): HomePin {
  return {
    slug: c.slug,
    name: c.name || c.slug,
    iconUrl: c.icon_url ?? null,
    iconEmoji: c.icon_emoji ?? null,
    iconColor: c.icon_color ?? null,
    member: true,
  };
}

const hubHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=status`;
const needsHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=needs`;

export function HomeGlass({ initialFeed = null }: { initialFeed?: FeedRow[] | null }) {
  const t = useMessages('home');
  const pins = useStoreState(homePinsStore);
  const grid = useStoreState(gridStore);
  // Today's Home hides the launcher when a settled grid holds nothing; so
  // does this one (a zero says nothing), keeping the section the declared
  // checks select on in the DOM.
  const noApps = grid.ready && grid.view === 'grid' && !grid.editing && grid.items.length === 0;
  const [feed, setFeed] = useState<FeedRow[] | null>(initialFeed);
  const [directory, setDirectory] = useState<DirectoryApp[] | null>(null);

  useEffect(() => {
    let on = true;
    loadHomePins().catch(() => {});
    fetch('/api/workshop/needs-feed', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (on) setFeed(Array.isArray(body?.items) ? body.items as FeedRow[] : []); })
      .catch(() => { if (on) setFeed([]); });
    readDirectory().then((apps) => { if (on) setDirectory((apps || []) as DirectoryApp[]); });
    return () => { on = false; };
  }, []);

  // Your communities: the pinned ones first, then the joined ones not pinned.
  const pinned = new Set(pins.pins.map((p) => p.slug));
  const mine: HomePin[] = [...pins.pins, ...pins.joined.filter((c) => !pinned.has(c.slug)).map(joinedAsPin)];
  const inMine = new Set(mine.map((p) => p.slug));
  const toJoin = (directory || []).filter((a) => a && a.slug && !inMine.has(a.slug));

  const decisions = feed ? feed.length : 0;
  const communities = mine.length;

  const side = (decisions > 0 || communities > 0) ? (
    <Group label={t('home:glass.thisWeek')}>
      {decisions > 0 ? (
        <div className="px-4 py-3 text-[15px] leading-5 text-[color:var(--ink)]">
          {t('home:glass.decisions', { count: decisions })}
        </div>
      ) : null}
      {communities > 0 ? (
        <div className="px-4 py-3 text-[15px] leading-5 text-[color:var(--ink)]">
          {t('home:glass.communities', { count: communities })}
        </div>
      ) : null}
    </Group>
  ) : null;

  return (
    <div data-home-glass="">
      {/* The nodes features/home/home.js still writes into (its communities
          section, the featured list, the join card). Kept so its writes have
          a target; hidden, and inside a hidden parent, so what it writes
          never shows beside the frame. */}
      <div hidden aria-hidden="true">
        <section id="home-communities-section" hidden />
        <div id="home-featured-list" hidden />
        <section id="home-join-section" hidden />
      </div>
      <PageFrame
        title={t('home:glass.title')}
        purpose={t('home:glass.purpose')}
        primary={(
          <PrimaryButton onClick={() => { (window as any).App?.showCreateModal?.(); }}>
            {t('home:glass.make')}
          </PrimaryButton>
        )}
        side={side}
      >
        <div className="flex flex-col gap-2">
          {feed && feed.length > 0 ? (
            <Group label={t('home:glass.needs')} id="home-glass-needs">
              {feed.map((row) => {
                const slug = row.app?.slug || row.app_slug || '';
                const name = row.app?.name || row.app_name || slug;
                const waiting = feedWaiting(row);
                const status = row.approve ? t('home:glass.vote') : waiting;
                const tone: Tone = row.approve ? 'you' : 'waiting';
                return (
                  <StatusRow
                    key={`${row.kind}:${row.id}`}
                    as="a"
                    href={slug ? needsHref(slug) : '#needs'}
                    leading={<Lead name={name} iconUrl={row.app?.icon_url} iconEmoji={row.app?.icon_emoji} iconColor={row.app?.icon_color} />}
                    title={row.title || name}
                    subtitle={row.number ? `${name} · #${row.number}` : name}
                    status={status}
                    tone={tone}
                  />
                );
              })}
            </Group>
          ) : null}

          {noApps ? (
            <section id="home-apps-section" hidden><AppGrid /></section>
          ) : (
            <Group label={t('home:glass.pinnedApps')} id="home-apps-section">
              <div className="px-2 py-3">
                <AppGrid />
              </div>
            </Group>
          )}

          {mine.length > 0 ? (
            <Group label={t('home:glass.yourCommunities')} id="home-glass-communities">
              {mine.map((c) => {
                const owed = pins.owed[c.slug] || 0;
                return (
                  <StatusRow
                    key={c.slug}
                    as="a"
                    href={hubHref(c.slug)}
                    leading={<Lead name={c.name} iconUrl={c.iconUrl} iconEmoji={c.iconEmoji} iconColor={c.iconColor} />}
                    title={c.name}
                    status={owed > 0 ? t('home:glass.toVote', { count: owed }) : null}
                    tone="you"
                  />
                );
              })}
            </Group>
          ) : null}

          {toJoin.length > 0 ? (
            <Group label={t('home:glass.toJoin')} id="home-glass-to-join">
              {toJoin.map((a) => (
                <StatusRow
                  key={a.slug}
                  as="a"
                  href={hubHref(a.slug)}
                  leading={<Lead name={a.name || a.slug} iconUrl={a.icon_url} iconEmoji={a.icon_emoji} iconColor={a.icon_color} />}
                  title={a.name || a.slug}
                  subtitle={a.member_count ? String(a.member_count) : undefined}
                  status={<QuietButton className="h-8 px-3 text-[13px]">{t('home:glass.join')}</QuietButton>}
                  tone="none"
                />
              ))}
            </Group>
          ) : null}
        </div>
      </PageFrame>
    </div>
  );
}

// Columns and StatusPill are part of the frame this screen is drawn with;
// named here so a reader of this file sees the whole kit it builds from.
export { Columns, StatusPill };
