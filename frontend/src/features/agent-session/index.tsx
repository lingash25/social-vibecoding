import { SpeakButton } from '../dictation/speak-button';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  DraftEditIcon,
  DraftSendIcon,
  DraftTrashIcon,
  EllipsisHorizontalIcon,
  PaperclipIcon,
  SaveDraftIcon,
  SparklesIcon,
  SpinnerArcIcon,
  XIcon,
  AppWindowIcon,
} from '@/components/ui/icons';

import { useInnerHtml } from '../../lib/html';
import { changeHref as changeLink } from '../../lib/change-href';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t } from '../../lib/i18n/runtime';
import { dirSign } from '../../lib/i18n/direction';
import { renderSpecHtml, useSpecFrames, type SpecHtmlDoc } from '../../lib/spec-html';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useReleaseNow } from '../../lib/use-release-now';
import type { AiBudgetState } from '../header/ai-budget';
import { aiBudgetStore } from '../header/ai-budget-store.js';
import { Attached } from '../dev-chat/transcript';
import { DropOverlay, useFileDrag } from '../attachments/file-drag';
import { PendingStrip } from '../attachments/pending-strip';
import { nowStore, type TranscriptRow } from '../dev-chat/transcript-store';
import type { AgentChange, AgentSession, SavedDraft } from './api';
import {
  choiceFromValue,
  choiceValue,
  effectiveChoice,
  effortLabel,
  effortOptions,
  effortValue,
  offersReasoning,
  pickerOptions,
} from './model-choice';
import { badgeFor, formatSize, pastedName } from './attachments';
import {
  CreditPill,
  BuildSheetBody,
  LowCreditConfirm,
  LowCreditNote,
  ModelPill,
  ModelSheet,
  ModelSheetBody,
  type BuildTab,
  SentAttachments,
  confirmLowCredit,
  creditView,
  isLowCredit,
  modelList,
  needsLowCreditCheck,
  showLowCreditNote,
  type CreditView,
} from './composer-parts';
import {
  buildTranscript,
  checksSummary,
  skippedChecksReason,
  cardView,
  changeReleaseLine,
  changeStatusLabel,
  durationLabel,
  latestReplies,
  runHeading,
  type CardView,
  type PreviewItem,
  type RunItem,
  type TranscriptItem,
} from './transcript';
import {
  addAttachments,
  chooseAgent,
  clearComposerFill,
  clearReturnedText,
  closeHandoff,
  closeSpec,
  composerId,
  archiveCurrentSession,
  decideCard,
  deleteSavedDraft,
  discardOutbox,
  editOutbox,
  editSavedDraft,
  loadModelCatalog,
  openAgentSession,
  openSpec,
  fillComposer,
  sendAgentMessage,
  setDrawerOpen,
  setSpecTab,
  setPaneTab,
  dockPreview,
  openPreview,
  openPreviewOver,
  recheckChange,
  removeAttachment,
  renameCurrentSession,
  retryOutbox,
  retryStaging,
  retryTurn,
  unarchiveCurrentSession,
  PREVIEW_SLOT_ID,
  saveComposerDraft,
  sendSavedDraft,
  stopAgentTurn,
  stopPreviewCapture,
  switchActiveChange,
  useAgentSessionPick,
  useAgentSessionSelector,
  type PaneTab,
  type PreviewPaneState,
  type SpecSheetState,
  type SpecTab,
} from './store';
import {
  PREVIEW_MIN_WIDTH,
  SPEC_DEFAULT_WIDTH,
  SPEC_MIN_WIDTH,
  SPEC_WIDTH_STEP,
  clampSpecWidth,
  readSpecWidth,
  splitSpec,
  useSidePaneBeside,
  useWideEnoughForSpec,
  writeSpecWidth,
  type SpecSplit,
} from './spec-layout';
import { openFocusedApp } from './open-app';
import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { ProposeButton } from './propose-confirm';
import { fixChecksHeading, fixChecksMessage, fixChecksOffer, type FixChecksOffer } from './fix-checks';
import { readUnsent, writeUnsent } from './unsent';
import { draftRequest, draftSeed, type DraftRequest } from './request-seed';
import { CreditsCard, HandoffPanel } from './handoff';
import { UserMessage } from './user-message';
import { JumpToLatest } from '../messages/jump-to-latest';
import { linkRefsInHtml } from '../messages/channels';

// Agent sessions (#2779, docs/agent-sessions.md "UI surfaces"): one
// conversation with the Mayor that works on any app. Drawn on two surfaces:
// its own screen (#agent/<id>, a phone's only surface) and
// the Messages pane beside the inbox on a desktop (#messages/agent/<id>).
// One panel, so the two cannot drift. New change opens it UNSENT at `new`
// (the store's `draft`): the same panel, with nothing created until the
// first message.
//
// React owns every node below the screen root; no legacy module writes into
// it. The first render is the hidden, empty root the prerendered shell
// ships, and everything loads in effects.
//
// ── What re-renders while the Mayor streams ───────────────────────────
//
// The store lands a streamed reply once per animation frame (store.ts,
// bufferToken). Of this screen, only the live turn and FollowOutput read the
// streamed text; everything else reads the fields it draws through
// useAgentSessionSelector / useAgentSessionPick, so a frame of new words
// re-renders neither the panel, the composer nor a past reply. Past replies
// are memo()'d rows whose markdown keeps its `{ __html }` object (see
// ../../lib/html.tsx), so an earlier message is never re-parsed into the DOM.

function markdown(text: string, breaks = true): string | null {
  const render = typeof window === 'undefined' ? null : window.DevChat?.renderMarkdown;
  if (typeof render !== 'function') return null;
  try { return render(text, { breaks }); } catch { return null; }
}

export const MayorText = memo(function MayorText({ text, appSlug }: { text: string; appSlug?: string | null }) {
  // #5728: `#N` and `PR#N` in a reply are the chips Messages and the project
  // chat already draw, opening the request's page and the proposal's.
  const html = useMemo(() => {
    const rendered = markdown(text);
    return rendered ? linkRefsInHtml(rendered, appSlug) : null;
  }, [text, appSlug]);
  const inner = useInnerHtml(html || '');
  if (html) {
    // renderMarkdown is the dev chat's sanitizer (marked + DOMPurify).
    return <div className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" dangerouslySetInnerHTML={inner} />;
  }
  return <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">{text}</p>;
});

function appInitial(name: string | null | undefined) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function AppMark({ name, slug, iconUrl, iconEmoji }: {
  name: string | null | undefined;
  /** When set, the mark opens that app (#3365). */
  slug?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}) {
  // The app's own artwork, the way the launcher and the inbox rows draw it,
  // when the payload carries one; the violet letter mark otherwise, which is
  // what this bar has always drawn and what the first render ships.
  if (iconUrl || iconEmoji) {
    const record = { name: name || '?', icon_url: iconUrl, icon_emoji: iconEmoji };
    return (
      <AppIconLink
        slug={slug}
        name={name}
        data-icon={appIconKind(record as never)}
        className="app-icon-tile h-5 w-5 shrink-0 overflow-hidden rounded-md text-[11px]"
      >
        <AppIconContent app={record as never} />
      </AppIconLink>
    );
  }
  return (
    <AppIconLink
      slug={slug}
      name={name}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-600 text-[11px] font-semibold text-white"
    >
      {appInitial(name)}
    </AppIconLink>
  );
}

/**
 * The app a conversation is about, as "Open app" opens it: the active
 * change's app first, then the session's (or the unsent draft's) focus.
 * Null when there is none to open, or when the target is Homeroom itself,
 * whose "app" surface is the platform the viewer is already in.
 */
export function openAppTarget(active: AgentChange | null, about: About): { slug: string; name: string | null } | null {
  const slug = active?.appSlug || about?.focusApp?.slug || null;
  if (!slug) return null;
  const name = active?.appName || about?.focusApp?.name || null;
  const selfHosted = !!active?.appSelfHosted || !!about?.focusApp?.selfHosted;
  return selfHosted ? null : { slug, name };
}

/**
 * "Open app" — the app this conversation is about, full-view, with the
 * conversation docked beside it in the side panel (./open-app.ts). Hidden
 * when there is no app to open, when the app is Homeroom itself, or below
 * the side panel's desktop breakpoint (lg = 1024px, the same width the
 * panel itself appears at; the class string is a whole literal so Tailwind
 * compiles it).
 */
export function OpenAppButton({ target }: { target: { slug: string; name: string | null } | null }) {
  const t = useMessages('agent');
  const open = useCallback(() => {
    if (!target) return;
    void openFocusedApp({ slug: target.slug, name: target.name });
  }, [target]);
  if (!target) return null;
  return (
    <button
      type="button"
      data-agent-session-open-app
      data-open-app={target.slug}
      className="hidden lg:inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 [@container(max-width:32rem)]:px-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
      title={t('agent:session.bar.openAppTitle', { app: target.name || target.slug })}
      aria-label={t('agent:session.bar.openApp')}
      onClick={open}
    >
      <AppWindowIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {/* #3577: in a pill row narrower than 32rem (the Messages pane on a
          1024px screen) the words go and the window mark stays, so the row
          still fits on one line without squeezing the pills that name things
          down to nothing. The row is the container (SessionBar). */}
      <span className="truncate [@container(max-width:32rem)]:hidden">{t('agent:session.bar.openApp')}</span>
    </button>
  );
}

function statusTone(status: string | null | undefined) {
  switch (status) {
    case 'promoted': return 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200';
    case 'merged': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
    // A paused change is an active one whose worker was released (#2779
    // follow-up); it looks the same.
    case 'active':
    case 'paused': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    default: return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

function changeRef(change: AgentChange) {
  return change.prNumber
    ? t('agent:session.changeRef.pr', { number: change.prNumber })
    : t('agent:session.changeRef.change', { number: change.id });
}

// ── Header ─────────────────────────────────────────────────────────────

/** What the conversation is about: the session's, or the unsent draft's. */
type About = Pick<AgentSession, 'focusApp' | 'focusContext'> | null;

export function SessionBar({ session, about, embedded, action }: {
  session: AgentSession | null;
  about: About;
  embedded: boolean;
  /** The pane's own control at the bar's end — Messages' full-width toggle. */
  action?: ReactNode;
}) {
  const t = useMessages('agent');
  const building = useAgentSessionSelector((s) => s.turn.running && s.turn.phase === 'cc');
  const active = session?.activeChange || null;
  // #5683: the pill says where the work stands, taken from the LATEST change
  // the conversation made — the one list is newest first — even once that
  // change is no longer the active one. "No change yet" only when there is
  // none at all; the active change still decides what "Open app" opens.
  const latest = active || session?.changes?.[0] || null;
  const count = session?.changes?.length || 0;
  const target = openAppTarget(active, about);
  // #3577: THE PILLS ARE ONE ROW, at every width and on both surfaces.
  //
  // #3016 let the bar wrap, because a bar that could not wrap made the whole
  // conversation as wide as its controls and pushed every message's right
  // edge and the Send button off a phone. Wrapping fixed that, but at 390px
  // it did so by dropping the ⋯ onto a second line of its own (the focus
  // pill, the change pill and Changes came to 376px of a 358px row), and in
  // the Messages pane it split the pills in two around the conversation's
  // title.
  //
  // So the pills sit in a row of their own that never wraps, and the
  // controls — Changes, Open app, the pane's toggle, the ⋯ — keep their
  // width, so each stays on screen and tappable. What gives way is the two
  // pills that NAME things, in an order rather than together:
  //
  //  - The focus pill first. Its basis is zero and it GROWS into what the
  //    row has left, up to its own content (`max-w-fit`, with the name capped
  //    at 7rem, the pill's old 10rem less its mark and padding), so its name
  //    truncates before anything else does, down to a floor of its mark.
  //  - The change pill only after that, also to a floor. Its status word is
  //    the fact the row is read for, so in a row under 24rem (every phone)
  //    it drops the " · PR #12" after it; the full text is its tooltip, and
  //    the PR is a tap away in Changes. A shared shrink would have clipped
  //    "In progress" to "In progr…" to save the app name a few pixels.
  //  - Open app keeps its window mark and drops its words in a row under
  //    32rem (the Messages pane on a 1024px screen).
  //
  // Truncating, not scrolling sideways: a row that scrolls hides the ⋯ past
  // its right edge, which is the failure being fixed.
  //
  // The row is `min-w-0`, so whatever it holds it cannot widen the panel
  // (#3016). The Messages pane's title is a line of its own above it rather
  // than a sibling the pills wrap around.
  const focusTitle = t('agent:session.bar.focusTitle');
  // A merge of Homeroom itself waiting for the platform's next release: the
  // pill keeps "Going live" and its title says when.
  const releaseNow = useReleaseNow(latest?.release);
  const releaseLine = building ? null : changeReleaseLine(latest, releaseNow);
  const changeText = releaseLine || (latest
    ? changeStatusLabel(latest.status, building)
    : t('agent:session.bar.noChangeYet'));
  return (
    <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-800" data-agent-session-bar>
      {embedded ? (
        <div className="mb-2 min-w-0">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{session?.title || t('agent:session.bar.newSession')}</h2>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {about?.focusApp?.name
              ? t('agent:session.bar.kindStartedFrom', { app: about.focusApp.name })
              : t('agent:session.bar.kind')}
          </p>
        </div>
      ) : null}
      {/* Siblings of one another in this row, not split into groups: a
          declared check reads it as focus ~ change pill ~ Changes, another
          as Changes ~ ⋯. Where the work is built is the composer's
          "Build with" now (#3078), not a pill here. */}
      <div className="flex min-w-0 flex-nowrap items-center gap-2 [container-type:inline-size]" data-agent-session-pills>
        <span
          data-agent-session-focus
          className="inline-flex min-w-[2.75rem] max-w-fit grow basis-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200"
          title={about?.focusApp?.name ? t('agent:session.bar.focusTitleNamed', { app: about.focusApp.name }) : focusTitle}
        >
          {about?.focusApp ? (
            <AppMark
              name={about.focusApp.name}
              slug={about.focusApp.selfHosted ? null : about.focusApp.slug}
              iconUrl={about.focusApp.iconUrl}
              iconEmoji={about.focusApp.iconEmoji}
            />
          ) : null}
          <span className="min-w-0 max-w-[7rem] truncate">{about?.focusApp?.name || t('agent:session.bar.anyApp')}</span>
        </span>
        <span
          data-agent-session-change-pill
          className={`inline-flex min-w-[3.5rem] items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(latest?.status)}`}
          title={changeText}
        >
          <span className="min-w-0 truncate">
            {latest ? changeStatusLabel(latest.status, building) : t('agent:session.bar.noChangeYet')}
          </span>
        </span>
        <button
          type="button"
          data-agent-session-changes-button
          className="ms-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => setDrawerOpen(true)}
          disabled={!session}
          aria-haspopup="dialog"
        >
          {t('agent:session.bar.changes', { count })}
        </button>
        <OpenAppButton target={target} />
        {action}
        <SessionMenu session={session} />
      </div>
    </div>
  );
}

/**
 * The session's own actions, the dev chat's ⋯: Rename, and Archive or
 * Unarchive. Nothing to act on while the conversation is unsent.
 */
function SessionMenu({ session }: { session: AgentSession | null }) {
  const t = useMessages('agent');
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      data-agent-session-menu
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      aria-label={t('agent:session.menu.label')}
      title={t('agent:session.menu.label')}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={!session}
      onClick={(event) => {
        const menu = window.PlatformUI?.menu;
        if (!session || open || typeof menu !== 'function') return;
        const archived = session.status === 'archived';
        setOpen(true);
        void menu.call(window.PlatformUI, {
          anchorEl: event.currentTarget,
          items: [
            { label: t('agent:session.menu.rename'), handler: () => { void renameCurrentSession(); } },
            archived
              ? { label: t('agent:session.menu.unarchive'), title: t('agent:session.menu.unarchiveTitle'), handler: () => { void unarchiveCurrentSession(); } }
              : {
                label: t('agent:session.menu.archive'),
                title: t('agent:session.menu.archiveTitle'),
                destructive: true,
                handler: () => { void archiveCurrentSession(); },
              },
          ],
        }).finally(() => setOpen(false));
      }}
    >
      <EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

// ── Transcript pieces ──────────────────────────────────────────────────

/**
 * A card the platform refused because the viewer is not a member of the
 * project (`join_required`): the refusal is a question, so the card asks it.
 * The button IS the answer — it joins (Home.setMembership, the one join
 * path) and then asks the Mayor to try again, which prepares a fresh card;
 * a refused card is never confirmed a second time.
 */
function JoinToRetry({ card, join }: { card: CardView; join: { slug: string; name: string } }) {
  const t = useMessages('agent');
  const [state, setState] = useState<'idle' | 'busy' | 'joined' | 'failed'>('idle');
  const onJoin = async () => {
    if (state === 'busy' || state === 'joined') return;
    setState('busy');
    const home = (window as any).Home;
    let ok = false;
    try {
      ok = typeof home?.setMembership === 'function'
        && !!(await home.setMembership(join.slug, true, undefined, { name: join.name }));
    } catch {
      ok = false;
    }
    if (!ok) { setState('failed'); return; }
    setState('joined');
    void sendAgentMessage(t('agent:session.join.joinedMessage', { community: join.name, action: card.title }));
  };
  return (
    <div className="mt-3 flex flex-col gap-2" data-agent-session-join={join.slug}>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {t('agent:session.join.membersOnly', { community: join.name })}
      </p>
      {state === 'joined' ? (
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-600 dark:text-zinc-300" data-agent-session-joined="">
          <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />{` ${t('agent:session.join.joined')}`}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-agent-session-join-btn=""
            layout="iconRow"
            variant="pillAccent"
            disabledStyle="dim"
            disabled={state === 'busy'}
            onClick={() => { void onJoin(); }}
          >
            {state === 'busy' ? <SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('agent:session.join.button', { community: join.name })}
          </Button>
          {state === 'failed' ? <span className="text-sm text-red-700 dark:text-red-300">{t('agent:session.join.failed')}</span> : null}
        </div>
      )}
    </div>
  );
}

function Card({ card, live = false }: { card: CardView; live?: boolean }) {
  const t = useMessages('agent');
  const decidingId = useAgentSessionSelector((s) => s.deciding);
  const deciding = decidingId === card.id;
  const pending = card.status === 'pending';
  return (
    <section
      className={`agent-session-card mt-3 rounded-2xl border bg-white p-4 dark:bg-zinc-900 ${pending ? 'border-violet-300 dark:border-violet-800' : 'border-zinc-200 dark:border-zinc-800'}`}
      aria-label={t('agent:session.card.label', { action: card.title })}
      data-agent-session-card={card.status}
    >
      {pending ? <p className="mb-1 text-xs font-semibold text-violet-700 dark:text-violet-300">{t('agent:session.card.needsOk')}</p> : null}
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{card.title}</h3>
      {card.rows.length ? (
        <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {card.rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {pending && !live ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            data-agent-session-confirm
            layout="iconRow"
            variant="pillAccent"
            disabledStyle="dim"
            disabled={!!decidingId}
            onClick={() => void decideCard(card.id, 'confirm')}
          >
            {deciding ? <SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('agent:session.card.confirm')}
          </Button>
          <Button
            type="button"
            data-agent-session-dismiss
            variant="pillNeutral"
            disabledStyle="dim"
            ink="neutral"
            disabled={!!decidingId}
            onClick={() => void decideCard(card.id, 'dismiss')}
          >
            {t('agent:session.card.notNow')}
          </Button>
        </div>
      ) : null}
      {live ? <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{t('agent:session.card.waiting')}</p> : null}
      {card.status === 'running' ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300"><SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" />{` ${t('agent:session.card.running')}`}</p>
      ) : null}
      {card.status === 'done' ? (
        <p className="mt-3 inline-flex items-start gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{` ${card.outcome ? t('agent:session.card.confirmedOutcome', { outcome: card.outcome }) : t('agent:session.card.confirmed')}`}
        </p>
      ) : null}
      {card.status === 'failed' && card.join ? (
        <JoinToRetry card={card} join={card.join} />
      ) : card.status === 'failed' ? (
        <p className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">{card.outcome ? t('agent:session.card.failedOutcome', { outcome: card.outcome }) : t('agent:session.card.failed')}</p>
      ) : null}
      {card.status === 'dismissed' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{t('agent:session.card.dismissed')}</p> : null}
      {card.status === 'expired' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{t('agent:session.card.expired')}</p> : null}
    </section>
  );
}

/**
 * One row of the transcript. memo(): `buildTranscript` hands back the same
 * item objects until the messages or actions change, so a row whose item is
 * unchanged skips its render (and its markdown) when the panel re-renders.
 */
const Item = memo(function Item({ item, sessionId = null, appSlug = null }: {
  item: TranscriptItem;
  sessionId?: number | null;
  /** #5728: the project the conversation is about, for its reply's refs. */
  appSlug?: string | null;
}) {
  const t = useMessages('agent');
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5" data-agent-session-user>
          <SentAttachments sessionId={sessionId} attachments={item.attachments} />
          {/* A long one folds behind "Show more" (#3558, ./user-message.tsx). */}
          {item.text ? <UserMessage text={item.text} /> : null}
        </div>
      );
    case 'mayor':
      return (
        <article data-agent-session-mayor>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            {item.cost ? (
              <RichMessage
                id="agent:session.reply.agentWithCost"
                values={{ cost: item.cost }}
                components={[<span className="font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-reply-cost />]}
              />
            ) : t('agent:session.reply.agent')}
          </p>
          {item.text ? <MayorText text={item.text} appSlug={appSlug} /> : null}
          {item.cards.map((card) => <Card key={card.id} card={card} />)}
        </article>
      );
    case 'divider':
      return (
        <div className="flex items-center gap-3 py-1 text-xs text-zinc-500 dark:text-zinc-400" data-agent-session-divider={item.event}>
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          <span className="max-w-[80%] text-center font-semibold">{item.text}</span>
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    case 'note': {
      const note = (
        <p
          className={`text-sm ${item.tone === 'error' ? 'text-red-700 dark:text-red-300' : item.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-500 dark:text-zinc-400'}`}
          data-agent-session-note={item.tone}
        >
          {item.text}
        </p>
      );
      if (!item.retry) return note;
      // The conversation's last word is a turn that did not finish: Retry
      // runs it again, on the conversation as it stands, with no new message.
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {note}
          <button
            type="button"
            className="text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300"
            data-agent-session-retry-turn
            onClick={() => { void retryTurn(); }}
          >
            {t('core:common.retry')}
          </button>
        </div>
      );
    }
    case 'run':
      return <RunCard run={item} />;
    case 'spec':
      return <SpecCard item={item} />;
    case 'preview':
      return <PreviewCard item={item} />;
    default:
      return null;
  }
});

/** What a finished run reads from the turn: nothing that changes. */
const NOT_LIVE = { startedAt: null, progress: '' };

/**
 * A coding-agent run, as the dev chat draws one: its `Attached` card, a
 * status line that opens in place onto the run's log, or onto a build's own
 * summary of what it did. The caption names the agent that ran. The running
 * run carries the turn's live progress line and clock.
 */
export function RunCard({ run }: { run: RunItem }) {
  const t = useMessages('agent');
  const running = run.status === 'running';
  // Only the running run follows the turn's clock and progress line; a
  // finished one reads nothing from the turn, so the turn never re-renders it.
  const turn = useAgentSessionPick((s) => (running
    ? { startedAt: s.turn.startedAt, progress: s.turn.progress }
    : NOT_LIVE));
  const html = useMemo(() => (run.output ? markdown(run.output) : null), [run.output]);
  const duration = durationLabel(run.durationMs);
  const logText = [...run.steps, ...run.log].join('\n');
  const row: Extract<TranscriptRow, { t: 'attached' }> = {
    t: 'attached',
    key: run.key,
    details: { persistId: `agent-run-${run.key}`, defaultOpen: false },
    icon: running ? 'spinner' : run.status === 'failed' || run.status === 'stopped' ? 'flag' : 'check',
    text: runHeading(run),
    caption: run.agent || undefined,
    elapsed: running
      ? (turn.startedAt ? { kind: 'since', since: turn.startedAt } : null)
      : duration ? { kind: 'fixed', label: t('agent:session.run.took', { duration }) } : null,
    stamp: '',
    progress: running && turn.progress
      ? { current: turn.progress, steps: run.log.length, phase: '', estimate: '', countdownTo: null, cohortSince: null }
      : undefined,
    body: html
      ? { kind: 'md', html }
      : { kind: 'log', persistId: `agent-run-log-${run.key}`, text: run.output || logText || (running ? t('agent:session.run.starting') : t('agent:session.run.noOutput')) },
  };
  return (
    <div data-agent-session-run={run.status} data-agent-session-run-mode={run.mode}>
      <Attached r={row} />
    </div>
  );
}

const CARD_BUTTON = 'inline-flex rounded-full border border-violet-300 px-3 py-1 text-sm font-semibold text-violet-700 '
  + 'hover:bg-violet-50 disabled:opacity-60 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40';
const CARD_PRIMARY = 'inline-flex rounded-full bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60';
const CHECK_TONE: Record<string, string> = {
  passing: 'text-green-700 dark:text-green-400',
  failing: 'text-red-700 dark:text-red-300',
  running: 'text-zinc-500 dark:text-zinc-400',
  error: 'text-amber-700 dark:text-amber-300',
  skipped: 'text-zinc-500 dark:text-zinc-400',
};
// Why checks were skipped, as text under the line rather than a tooltip: a
// touch screen cannot hover (#3180).
const CHECK_REASON = 'mt-1 text-xs text-zinc-600 dark:text-zinc-400';

/**
 * A change's preview: in the side pane where there is room beside the chat,
 * otherwise the platform's own preview over the chat (a phone, a narrow
 * window, the side panel beside a running app). Never a bare new tab: that
 * was signed out of the app and away from the conversation.
 */
function showPreview(preview: { changeId: number; url: string; prNumber: number | null }, beside: boolean) {
  if (beside) openPreview(preview);
  else openPreviewOver(preview);
}

function findChange(session: AgentSession | null, changeId: number | null): AgentChange | null {
  if (!session || changeId == null) return null;
  return [session.activeChange, ...(session.changes || [])].find((change) => change && change.id === changeId) || null;
}

/**
 * A change's staging build, as a card (#2779 follow-up). The newest one of a
 * change is live:
 *   - deployed: Open preview (in the side pane on a wide screen, over the
 *     chat otherwise, the side panel included), Open draft proposal (its
 *     page), and Propose to group while it has not been proposed; then "In
 *     vote" with the proposal.
 *   - failed: why, and Retry (a rebuild; its result writes the next card).
 * It says where the change's checks stand, because they gate merge. An older
 * card is "Superseded by a newer preview" and offers nothing: its build is
 * gone or stale.
 */
export function PreviewCard({ item }: { item: PreviewItem }) {
  const { changeAction, session } = useAgentSessionPick((s) => ({ changeAction: s.changeAction, session: s.session }));
  const wide = useWideEnoughForSpec();
  const action = changeAction && changeAction.changeId === item.changeId ? changeAction.kind : null;
  return (
    <PreviewCardView
      item={item}
      change={findChange(session, item.changeId)}
      wide={wide}
      action={action}
      busy={!!changeAction}
    />
  );
}

/** The card itself, from plain props (a test renders it without a store). */
export function PreviewCardView({ item, change, wide, action, busy }: {
  item: PreviewItem;
  change: AgentChange | null;
  wide: boolean;
  action: 'propose' | 'retry' | 'recheck' | null;
  busy: boolean;
}) {
  const t = useMessages('agent');
  const prNumber = item.prNumber || change?.prNumber || null;
  const heading = item.failed ? t('agent:session.preview.failed') : t('agent:session.preview.ready');
  if (item.superseded) {
    return (
      <section className="rounded-2xl border border-zinc-200 px-3 py-2 dark:border-zinc-800" data-agent-session-preview="superseded">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{item.failed ? t('agent:session.preview.failedSuperseded') : t('agent:session.preview.readySuperseded')}</p>
      </section>
    );
  }
  const checks = checksSummary(change?.checkState, change?.checkFailing, change?.checkSkipReason);
  const changeHref = change && change.appSlug && item.changeId != null
    ? changeLink(change.appSlug, item.changeId, prNumber)
    : null;
  const inVote = change && (change.status === 'promoted' || change.status === 'merging');
  const merged = change && change.status === 'merged';
  const proposable = change && (change.status === 'active' || change.status === 'paused');
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
      data-agent-session-preview={item.failed ? 'failed' : 'deployed'}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className={`text-sm font-medium ${item.failed ? 'text-red-700 dark:text-red-300' : 'text-zinc-800 dark:text-zinc-100'}`}>{heading}</p>
        {inVote || merged ? (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300" data-agent-session-preview-status>
            {merged ? t('agent:session.preview.status.live') : t('agent:session.preview.status.waiting')}
          </span>
        ) : null}
        {checks ? (
          <button
            type="button"
            className={`ms-auto inline-flex items-center gap-1 rounded text-xs hover:underline ${CHECK_TONE[checks.key]}`}
            data-agent-session-checks={checks.key}
            title={t('agent:session.preview.checksTitle')}
            onClick={() => { if (item.changeId != null) window.AppView?.openSessionChecks?.(item.changeId); }}
          >
            {checks.key === 'running'
              ? <SpinnerArcIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : checks.key === 'passing' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {checks.text}
          </button>
        ) : null}
      </div>
      {item.failed && item.error ? <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{item.error}</p> : null}
      {checks && checks.reason ? <p className={CHECK_REASON} data-agent-session-checks-reason>{checks.reason}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {item.failed ? (
          item.changeId != null ? (
            <button type="button" className={CARD_BUTTON} disabled={busy} onClick={() => void retryStaging(item.changeId as number)} data-agent-session-preview-retry>
              {action === 'retry' ? t('agent:session.preview.retrying') : t('agent:session.preview.retry')}
            </button>
          ) : null
        ) : item.url && item.changeId != null ? (
          <button
            type="button"
            className={CARD_BUTTON}
            onClick={() => showPreview({ changeId: item.changeId as number, url: item.url as string, prNumber }, wide)}
            data-agent-session-preview-open
          >
            {t('agent:session.preview.open')}
          </button>
        ) : item.url ? (
          // A build no change owns has nothing to open the platform's preview
          // with (it is opened by change): its address, as it always was.
          <a className={CARD_BUTTON} href={item.url} target="_blank" rel="noopener noreferrer" data-agent-session-preview-open>
            {t('agent:session.preview.open')}
          </a>
        ) : null}
        {changeHref ? (
          <a className={CARD_BUTTON} href={changeHref} data-agent-session-preview-change>
            {inVote || merged ? t('agent:session.preview.viewChange') : t('agent:session.preview.openDraft')}
          </a>
        ) : null}
        {proposable && item.changeId != null ? (
          <ProposeButton
            changeId={item.changeId}
            title={change?.title}
            prNumber={prNumber}
            className={CARD_PRIMARY}
            busy={busy}
            proposing={action === 'propose'}
          />
        ) : null}
        {checks && (checks.key === 'failing' || checks.key === 'error') && item.changeId != null && !merged ? (
          <button
            type="button"
            className={CARD_BUTTON}
            disabled={busy}
            title={t('agent:session.preview.recheckTitle')}
            onClick={() => void recheckChange(item.changeId as number)}
            data-agent-session-preview-recheck
          >
            {action === 'recheck' ? t('agent:session.preview.rechecking') : t('agent:session.preview.recheck')}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * #3755: the change's checks failed, said in the conversation (./fix-checks.ts
 * decides when): which ones, what each reported, and Fix it, which asks the
 * Mayor for the fix in the person's name. See checks opens the same panel as
 * the staging card's count.
 */
function FixChecksCard({ offer }: { offer: FixChecksOffer }) {
  const [asked, setAsked] = useState(false);
  return (
    <FixChecksCardView
      offer={offer}
      asking={asked}
      onFix={() => {
        if (asked) return;
        setAsked(true);
        void sendAgentMessage(fixChecksMessage(offer));
      }}
      onSee={() => { window.AppView?.openSessionChecks?.(offer.changeId); }}
    />
  );
}

/** The card itself, from plain props (a test renders it without a store). */
export function FixChecksCardView({ offer, asking = false, onFix, onSee }: {
  offer: FixChecksOffer;
  asking?: boolean;
  onFix?: () => void;
  onSee?: () => void;
}) {
  const t = useMessages('agent');
  const more = offer.total - offer.checks.length;
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      aria-label={t('agent:session.fixChecks.label')}
      data-agent-session-fix-checks={offer.changeId}
    >
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100" data-agent-session-fix-checks-heading>
        {fixChecksHeading(offer)}
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {offer.checks.map((check, index) => (
          <li key={`${index}:${check.name}`} className="min-w-0" data-agent-session-fix-check>
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{check.name}</p>
            {check.reason ? <p className="mt-0.5 line-clamp-2 text-[13px] text-zinc-600 dark:text-zinc-400">{check.reason}</p> : null}
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="mt-2 text-[13px] text-zinc-600 dark:text-zinc-400">{t('agent:session.fixChecks.more', { count: more })}</p> : null}
      <p className="mt-2 text-[13px] text-zinc-600 dark:text-zinc-400">
        {t('agent:session.fixChecks.explain')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          data-agent-session-fix-checks-go
          layout="iconRow"
          variant="pillAccent"
          disabledStyle="dim"
          disabled={asking}
          onClick={onFix}
        >
          {asking ? <SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {t('agent:session.fixChecks.fix')}
        </Button>
        <Button
          type="button"
          data-agent-session-fix-checks-see
          variant="pillNeutral"
          disabledStyle="dim"
          ink="neutral"
          onClick={onSee}
        >
          {t('agent:session.fixChecks.see')}
        </Button>
      </div>
    </section>
  );
}

/** A spec the scout drafted: the dev chat's spec card, opening the viewer over the conversation. */
export function SpecCard({ item }: { item: Extract<TranscriptItem, { kind: 'spec' }> }) {
  const snippet = useMemo(() => (item.preview ? markdown(item.preview, false) : null), [item.preview]);
  const snippetInner = useInnerHtml(snippet || '');
  const open = () => { if (item.changeId) void openSpec(item.changeId, item.version); };
  const t = useMessages('agent');
  const spec = { version: item.version || 0, count: item.lines || 0 };
  const title = item.version
    ? (item.lines ? t('agent:session.specCard.titleVersionLines', spec) : t('agent:session.specCard.titleVersion', spec))
    : (item.lines ? t('agent:session.specCard.titleLines', spec) : t('agent:session.specCard.title'));
  const openLabel = item.version
    ? (item.lines ? t('agent:session.specCard.openVersionLines', spec) : t('agent:session.specCard.openVersion', spec))
    : (item.lines ? t('agent:session.specCard.openLines', spec) : t('agent:session.specCard.open'));
  return (
    <div
      className="dc-spec-preview-card"
      data-agent-session-spec={item.version ?? 'latest'}
      role="button"
      tabIndex={0}
      aria-label={openLabel}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className="dc-spec-preview-header">
        <span className="dc-spec-preview-title">{title}</span>
        <span className="dc-spec-preview-cta">{t('agent:session.specCard.viewFull')}</span>
      </div>
      {snippet
        ? <div className="dc-spec-preview-snippet" dangerouslySetInnerHTML={snippetInner} />
        : item.preview ? <div className="dc-spec-preview-snippet">{item.preview}</div> : null}
    </div>
  );
}

/**
 * A change's spec, read-only, any saved version. The change page's own
 * viewer keeps sharing and mentions; this is for reading what the scout wrote
 * without leaving the conversation.
 *
 * ONE VIEW, TWO FRAMES (./spec-layout.ts): beside the conversation from
 * 1024px up, with a divider that drags; a sheet over it below that. Both show
 * the same header and body, so the frame is the only thing the window width
 * decides.
 */
function SpecMarkdown({ text, tagged = false }: { text: string; tagged?: boolean }) {
  const html = useMemo(() => markdown(text, false), [text]);
  const inner = useInnerHtml(html || '');
  const tag = tagged ? { 'data-agent-session-spec-text': '' } : {};
  return html
    ? <div className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" {...tag} dangerouslySetInnerHTML={inner} />
    : <pre className="whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100" {...tag}>{text}</pre>;
}

function SpecTabButton({ tab, active, label, onTab }: {
  tab: SpecTab;
  active: SpecTab;
  label: string;
  onTab: (tab: SpecTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === tab}
      className={active === tab ? 'dc-spec-viewer-tab dc-spec-viewer-tab-active' : 'dc-spec-viewer-tab'}
      data-spec-tab={tab}
      onClick={() => onTab(tab)}
    >
      {label}
    </button>
  );
}

/**
 * The spec's text: the dev chat viewer's two tabs when it has both halves —
 * the title and summary above them, the plain-language half first — and the
 * whole document otherwise. Same classes as that viewer, so the two read alike.
 */
export function SpecBody({ text, tab, split, onTab }: {
  text: string;
  tab: SpecTab;
  split: SpecSplit | null;
  onTab: (tab: SpecTab) => void;
}) {
  const t = useMessages('agent');
  if (!split) return <SpecMarkdown text={text} tagged />;
  const half = tab === 'tech' ? split.technical : split.userFacing;
  return (
    <>
      {split.preamble ? <div className="dc-spec-viewer-preamble"><SpecMarkdown text={split.preamble} /></div> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label={t('agent:session.spec.sectionsLabel')}>
        <SpecTabButton tab="user" active={tab} label={t('agent:session.spec.tab.userFacing')} onTab={onTab} />
        <SpecTabButton tab="tech" active={tab} label={t('agent:session.spec.tab.technical')} onTab={onTab} />
      </div>
      <div role="tabpanel" data-agent-session-spec-half={tab}>
        {half ? <SpecMarkdown text={half} tagged /> : <p className="dc-spec-tab-empty">{t('agent:session.spec.emptySection')}</p>}
      </div>
    </>
  );
}

/** A piece of an HTML spec (#3699), already made safe; its screens are frames scaled to fit. */
function SpecHtmlPart({ html, tagged = false }: { html: string; tagged?: boolean }) {
  const inner = useInnerHtml(html);
  const ref = useRef<HTMLDivElement>(null);
  useSpecFrames(ref, html);
  const tag = tagged ? { 'data-agent-session-spec-text': '' } : {};
  return <div ref={ref} className="dc-msg-content text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100" {...tag} dangerouslySetInnerHTML={inner} />;
}

/** An HTML spec, in the same frame as SpecBody: the title above two tabs, or the whole document. */
export function SpecHtmlBody({ doc, tab, onTab }: {
  doc: SpecHtmlDoc;
  tab: SpecTab;
  onTab: (tab: SpecTab) => void;
}) {
  const t = useMessages('agent');
  if (!doc.split) return <SpecHtmlPart html={doc.html} tagged />;
  const half = tab === 'tech' ? doc.techHtml : doc.userHtml;
  return (
    <>
      {doc.preambleHtml ? <div className="dc-spec-viewer-preamble"><SpecHtmlPart html={doc.preambleHtml} /></div> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label={t('agent:session.spec.sectionsLabel')}>
        <SpecTabButton tab="user" active={tab} label={t('agent:session.spec.tab.userFacing')} onTab={onTab} />
        <SpecTabButton tab="tech" active={tab} label={t('agent:session.spec.tab.technical')} onTab={onTab} />
      </div>
      <div role="tabpanel" data-agent-session-spec-half={tab}>
        {half ? <SpecHtmlPart html={half} tagged /> : <p className="dc-spec-tab-empty">{t('agent:session.spec.emptySection')}</p>}
      </div>
    </>
  );
}

function SpecContent({ sheet }: { sheet: SpecSheetState }) {
  const t = useMessages('agent');
  const session = useAgentSessionSelector((s) => s.session);
  const split = useMemo(() => (sheet.text ? splitSpec(sheet.text) : null), [sheet.text]);
  const htmlDoc = useMemo(
    () => (sheet.html ? renderSpecHtml(sheet.html, { key: `as-${sheet.changeId}-${sheet.version ?? 'latest'}` }) : null),
    [sheet.html, sheet.changeId, sheet.version],
  );
  const change = [session?.activeChange, ...(session?.changes || [])]
    .find((c) => c && c.id === sheet.changeId) || null;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('agent:session.spec.heading')}</h2>
          {change ? <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.appName ? t('agent:session.spec.subtitleWithApp', { change: change.title || changeRef(change), app: change.appName }) : change.title || changeRef(change)}</p> : null}
        </div>
        {sheet.versions.length > 1 ? (
          <span className="dc-venue-detail-inline">
            <select
              className="dc-model-select rounded text-[13px] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-zinc-100"
              aria-label={t('agent:session.spec.versionLabel')}
              value={sheet.version ?? ''}
              onChange={(event) => void openSpec(sheet.changeId, Number(event.currentTarget.value))}
            >
              {sheet.versions.map((v) => <option key={v} value={v}>{`v${v}`}</option>)}
            </select>
            <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
          </span>
        ) : sheet.version ? <span className="text-xs font-semibold text-zinc-500">{`v${sheet.version}`}</span> : null}
        <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={t('core:common.close')} onClick={closeSpec}>
          <XIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {sheet.phase === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" />{` ${t('core:common.loading')}`}</div>
        ) : null}
        {sheet.phase === 'error' ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{sheet.error}</p> : null}
        {sheet.phase === 'ready' && !sheet.text ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('agent:session.spec.none')}</p> : null}
        {sheet.phase === 'ready' && sheet.text && htmlDoc ? <SpecHtmlBody doc={htmlDoc} tab={sheet.tab} onTab={setSpecTab} /> : null}
        {sheet.phase === 'ready' && sheet.text && !htmlDoc ? <SpecBody text={sheet.text} tab={sheet.tab} split={split} onTab={setSpecTab} /> : null}
      </div>
    </>
  );
}

/**
 * Below 1024px: the spec over the conversation, as a sheet. In the side panel
 * it fills the panel, as the preview does there: a sheet with the chat
 * peeking above it left the spec a strip of a narrow column. The panel's
 * Expand opens both beside the chat, full width.
 */
function SpecSheet({ sheet }: { sheet: SpecSheetState }) {
  const t = useMessages('agent');
  const cover = isEmbeddedPanel();
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-zinc-950/30"
      data-agent-session-spec-sheet={sheet.changeId}
      data-agent-session-spec-cover={cover ? '' : undefined}
      onClick={(event) => { if (event.target === event.currentTarget) closeSpec(); }}
    >
      <section
        role="dialog"
        aria-label={t('agent:session.spec.dialogLabel')}
        className={cover
          ? 'platform-safe-bar flex h-full w-full flex-col bg-white dark:bg-zinc-900'
          : 'platform-safe-bar mt-auto flex max-h-[92%] w-full flex-col rounded-t-3xl bg-white shadow-xl dark:bg-zinc-900 sm:mt-0 sm:h-full sm:max-h-none sm:rounded-none'}
      >
        <SpecContent sheet={sheet} />
      </section>
    </div>
  );
}

/** Spec | Preview, when the side pane holds both. */
function PaneTabs({ tab }: { tab: PaneTab }) {
  const t = useMessages('agent');
  const button = (key: PaneTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      data-agent-session-pane-tab={key}
      className={tab === key
        ? 'border-b-2 border-violet-600 px-3 py-2 text-sm font-semibold text-zinc-900 dark:border-violet-400 dark:text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}
      onClick={() => setPaneTab(key)}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label={t('agent:session.sidePane.tabsLabel')} className="flex shrink-0 gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
      {button('spec', t('agent:session.sidePane.tab.spec'))}
      {button('preview', t('agent:session.sidePane.tab.preview'))}
    </div>
  );
}

/**
 * From 1024px up: the side pane beside the conversation, behind a divider
 * that drags (and moves with the arrow keys). It holds the spec, a change's
 * staging preview, or both as tabs.
 *
 * THE WIDTH is the dev chat viewer's remembered one, clamped so the chat keeps
 * 320px beside the 4px divider; `max-w` holds the same ceiling when the window
 * narrows after the drag. A preview renders a real app's screen, so while one
 * is open the floor is the dev chat staging panel's 320px, not the spec's 280.
 *
 * THE PREVIEW is the platform's own (AppView.ensureStaging): its fixed
 * overlay is pinned over this pane's slot, the way it is pinned beside the
 * dev chat, so sign-in, Full screen and the dev console are the same ones. The
 * slot stays mounted while the Spec tab shows (hidden, so the overlay shrinks
 * to nothing and the preview keeps its state).
 */
function SidePane({ sheet, preview, tab, containerRef }: {
  sheet: SpecSheetState | null;
  preview: PreviewPaneState | null;
  tab: PaneTab;
  containerRef: { current: HTMLDivElement | null };
}) {
  const t = useMessages('agent');
  const floor = preview ? PREVIEW_MIN_WIDTH : SPEC_MIN_WIDTH;
  const [width, setWidth] = useState(SPEC_DEFAULT_WIDTH);
  const paneRef = useRef<HTMLElement | null>(null);
  const containerWidth = () => containerRef.current?.getBoundingClientRect().width ?? null;
  useEffect(() => { setWidth(clampSpecWidth(readSpecWidth(), containerWidth(), floor)); }, [floor]);
  const showing: PaneTab = sheet && preview ? tab : (preview ? 'preview' : 'spec');

  // The platform's preview opens over the slot once the slot is on screen,
  // and again only for another preview.
  const previewKey = preview ? `${preview.changeId}:${preview.url}` : null;
  useEffect(() => {
    if (preview) dockPreview(preview);
  }, [previewKey]);
  // The overlay follows the slot's size on its own; a move without a resize
  // (the tab strip appearing, the list stepping aside) needs a nudge.
  useEffect(() => {
    if (preview) window.AppView?._syncStagingDockGeometry?.();
  }, [width, showing, !!sheet, previewKey]);

  const commit = (next: number) => {
    const clamped = clampSpecWidth(next, containerWidth(), floor);
    setWidth(clamped);
    return clamped;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? width;
    let latest = startWidth;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { /* moves still arrive on the handle */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // An iframe swallows pointer moves: the preview's, while the drag runs.
    const frame = document.getElementById('staging-iframe');
    if (frame) frame.style.pointerEvents = 'none';
    // Dragging toward inline-end narrows the pane: its inline-start edge is the divider.
    const onMove = (move: PointerEvent) => { latest = commit(startWidth - (move.clientX - startX) * dirSign()); };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (frame) frame.style.pointerEvents = '';
      writeSpecWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    writeSpecWidth(commit(width + (event.key === 'ArrowLeft' ? SPEC_WIDTH_STEP : -SPEC_WIDTH_STEP) * dirSign()));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={showing === 'preview' ? t('agent:session.sidePane.resizePreview') : t('agent:session.sidePane.resizeSpec')}
        aria-valuenow={width}
        aria-valuemin={floor}
        tabIndex={0}
        className="w-1 shrink-0 cursor-col-resize touch-none bg-zinc-200 transition-colors hover:bg-violet-500 focus-visible:bg-violet-500 focus-visible:outline-none dark:bg-zinc-800"
        data-agent-session-spec-resizer
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <aside
        ref={paneRef}
        aria-label={showing === 'preview' ? t('agent:session.sidePane.previewLabel') : t('agent:session.sidePane.specLabel')}
        className={`flex min-h-0 ${preview ? 'min-w-[320px]' : 'min-w-[280px]'} max-w-[calc(100%-324px)] shrink-0 flex-col bg-white dark:bg-zinc-900`}
        style={{ width }}
        data-agent-session-side-pane={showing}
      >
        {sheet && preview ? <PaneTabs tab={showing} /> : null}
        {sheet && showing === 'spec' ? (
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-agent-session-spec-sheet={sheet.changeId}
            data-agent-session-spec-beside=""
          >
            <SpecContent sheet={sheet} />
          </div>
        ) : null}
        {preview ? (
          <div
            id={PREVIEW_SLOT_ID}
            className={showing === 'preview' ? 'min-h-0 flex-1' : 'hidden'}
            data-agent-session-preview-slot={preview.changeId}
          />
        ) : null}
      </aside>
    </>
  );
}

/**
 * The Mayor at work, as a conversation shows someone typing (#2779
 * follow-up): its name and three dots where its reply will appear, and what
 * it is doing beside them when that is known ("Reading the app", "Wrapping
 * up", the coding agent's progress with its clock). Once it has said
 * something the dots follow the words. Not a box across the pane: the old
 * full-width bubble read as a message of its own.
 */
function TypingDots() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1" aria-hidden="true" data-agent-session-typing>
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
      <span className="agent-session-typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
    </span>
  );
}

/**
 * What this screen sent that the server has not shown back yet
 * (./outbox.ts), drawn as the message it will be: faded while it is on its
 * way, and replaced in place by the server's own row. One the server did not
 * take says so under it, with Retry (the same message, which the server
 * recognises if it got there after all), Edit (back to the box) and
 * Discard. It is never dropped or turned into a draft on its own.
 */
function OutboxRows() {
  const outbox = useAgentSessionSelector((s) => s.outbox);
  const busy = useAgentSessionSelector((s) => s.turn.running);
  const t = useMessages('agent');
  if (!outbox.length) return null;
  const action = 'font-semibold hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline';
  return (
    <>
      {outbox.map((item) => (
        <div key={item.clientId} className="flex flex-col items-end gap-1" data-agent-session-outbox={item.status}>
          {/* Folded as the message it will be (#3558), so the server's row
              replaces it without the bubble changing height. */}
          <UserMessage text={item.shown} className={item.status === 'sending' ? 'opacity-80' : ''} />
          {item.status === 'failed' ? (
            <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[13px]" role="alert">
              <span className="text-red-700 dark:text-red-300" data-agent-session-outbox-error>{item.error || t('agent:session.outbox.notSent')}</span>
              {item.message || item.attachmentKeys.length ? (
                <button
                  type="button"
                  className={`${action} text-violet-700 dark:text-violet-300`}
                  disabled={busy}
                  title={busy ? t('agent:session.outbox.retryBusyTitle') : t('agent:session.outbox.retryTitle')}
                  data-agent-session-outbox-retry
                  onClick={() => retryOutbox(item.clientId)}
                >
                  {t('core:common.retry')}
                </button>
              ) : null}
              {item.message ? (
                <button
                  type="button"
                  className={`${action} text-zinc-600 dark:text-zinc-300`}
                  data-agent-session-outbox-edit
                  onClick={() => {
                    const text = editOutbox(item.clientId);
                    if (text) fillComposer(text);
                  }}
                >
                  {t('agent:session.outbox.edit')}
                </button>
              ) : null}
              <button
                type="button"
                className={`${action} text-zinc-500 dark:text-zinc-400`}
                data-agent-session-outbox-discard
                onClick={() => discardOutbox(item.clientId)}
              >
                {t('agent:session.outbox.discard')}
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function LiveTurn({ runShown, appSlug }: { runShown: boolean; appSlug?: string | null }) {
  const t = useMessages('agent');
  // The one reader of the streamed text on this screen (with FollowOutput):
  // it re-renders once per frame of a reply, and nothing around it does.
  const turn = useAgentSessionSelector((s) => s.turn);
  const actionList = useAgentSessionSelector((s) => s.actions);
  const [clock, setClock] = useState(Date.now());
  // The clock is drawn only for a build (`phase === 'cc'`), so it ticks only
  // then; each tick re-renders this, and the memo()'d MayorText under it
  // skips, so the reply so far is not parsed again every second.
  const ticking = turn.running && turn.phase === 'cc';
  useEffect(() => {
    if (!ticking) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const cards = useMemo(() => {
    const actions = new Map(actionList.map((action) => [action.id, action]));
    return turn.cards.map((card) => cardView(card, actions));
  }, [turn.cards, actionList]);
  if (!turn.running) return null;
  const seconds = turn.startedAt ? Math.max(0, Math.round((clock - turn.startedAt) / 1000)) : 0;
  // A running build draws its own card with the progress and the clock.
  const working = turn.running && !(runShown && turn.phase === 'cc');
  const said = !!(turn.streamText || turn.cards.length);
  const status = turn.stopping
    ? t('agent:session.live.stopping')
    : turn.phase === 'cc'
      ? (turn.progress || turn.activity || t('agent:session.activity.codingAgentWorking'))
      : (turn.activity || (turn.phase === 'mayor2' ? t('agent:session.live.wrappingUp') : ''));
  return (
    <>
      {said || working ? (
        <article data-agent-session-live>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t('agent:session.reply.agent')}</p>
          {turn.streamText ? <MayorText text={turn.streamText} appSlug={appSlug} /> : null}
          {cards.map((card) => <Card key={card.id} card={card} live />)}
          {working ? (
            <div
              className={`flex min-w-0 items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400 ${said ? 'mt-2' : ''}`}
              data-agent-session-activity={turn.phase || 'mayor'}
              aria-live="polite"
            >
              <TypingDots />
              {status ? <span className="min-w-0 truncate">{status}</span> : <span className="sr-only">{t('agent:session.live.thinking')}</span>}
              {turn.phase === 'cc' ? <span className="shrink-0 tabular-nums text-xs">{t('agent:session.elapsed', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</span> : null}
            </div>
          ) : null}
        </article>
      ) : null}
    </>
  );
}

// Message ids: the whole line for each step, read as the row is drawn.
const CAPTURE_STEPS: Record<string, string> = {
  provisioning: 'agent:session.capture.provisioning',
  exploring: 'agent:session.capture.exploring',
  replaying: 'agent:session.capture.replaying',
  reviewing: 'agent:session.capture.reviewing',
};

/**
 * The active change's before/after shots while they are taken: after the
 * coding agent finished, Homeroom records before-and-after captures of the
 * proposal, and that is not the coding agent working. Stop ends it; the
 * proposal's Rerun starts it again.
 */
export function PreviewCapture({ change }: { change: AgentChange }) {
  const t = useMessages('agent');
  const capture = change.previewCapture;
  const [clock, setClock] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!capture) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [capture]);
  useEffect(() => { setStopping(false); }, [capture?.state]);
  if (!capture) return null;
  const started = capture.startedAt ? Date.parse(capture.startedAt) : NaN;
  const seconds = Number.isFinite(started) ? Math.max(0, Math.round((clock - started) / 1000)) : null;
  const stop = async () => {
    setStopping(true);
    await stopPreviewCapture();
    setStopping(false);
  };
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400"
      data-agent-session-capture={capture.state}
      aria-live="polite"
    >
      <SpinnerArcIcon className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <RichMessage
          id={CAPTURE_STEPS[capture.state] || 'agent:session.capture.heading'}
          components={[<span className="font-medium text-zinc-700 dark:text-zinc-200" />]}
        />
      </span>
      {seconds != null ? <span className="shrink-0 tabular-nums text-xs">{t('agent:session.elapsed', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</span> : null}
      <Button
        type="button"
        data-agent-session-capture-stop
        variant="pillNeutral"
        size="xs"
        disabledStyle="dim"
        ink="neutral"
        className="ms-auto shrink-0 text-xs"
        disabled={stopping}
        onClick={() => void stop()}
      >
        {stopping ? t('agent:session.capture.stopping') : t('agent:session.capture.stop')}
      </Button>
    </div>
  );
}

function EmptyState({ about, request }: { about: About; request: DraftRequest | null }) {
  const t = useMessages('agent');
  const app = about?.focusApp?.name || null;
  // Started from a request (Start work): say which, before anything is sent.
  // The number is known at once, from the card; the app once the draft's
  // preview answers.
  if (request) {
    return (
      <section
        className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center"
        data-agent-session-empty
        data-agent-session-request={request.number}
      >
        <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
          <SparklesIcon className="h-6 w-6" aria-hidden="true" />
        </span>
        <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('agent:session.empty.requestHeading', { number: request.number })}</h3>
        {request.title ? (
          <p className="mt-1 max-w-sm text-base font-medium text-zinc-800 dark:text-zinc-100" data-agent-session-request-title>{request.title}</p>
        ) : null}
        <p className="mt-2 max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
          {app
            ? <RichMessage id="agent:session.empty.requestBodyOnApp" values={{ app }} components={[<strong />]} />
            : t('agent:session.empty.requestBody')}
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center" data-agent-session-empty>
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
        <SparklesIcon className="h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('agent:session.empty.heading')}</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
        {app
          ? <RichMessage id="agent:session.empty.bodyFromApp" values={{ app }} components={[<strong />]} />
          : t('agent:session.empty.body')}
      </p>
    </section>
  );
}

// The first things to say, from where the conversation was opened: a
// proposal the user was looking at comes first. One opened from a request
// has none: its first message is already in the box (./request-seed.ts),
// and a tap would replace it.
function starters(about: About, request: DraftRequest | null) {
  if (request) return [];
  const app = about?.focusApp?.name || null;
  const context = (about?.focusContext || {}) as { proposalId?: number };
  const first = context.proposalId ? [t('agent:session.starter.aboutChange')] : [];
  return [
    ...first,
    app ? t('agent:session.starter.openOnApp', { app }) : t('agent:session.starter.whatToWorkOn'),
    t('agent:session.starter.addFeature'),
    t('agent:session.starter.fixBug'),
  ].slice(0, 3);
}

/**
 * The suggested replies over the box. A tap puts one IN the box, to be
 * edited or sent (#3033), as the dev chat's pills do; it no longer sends on
 * its own.
 */
function Replies({ replies }: { replies: string[] }) {
  const running = useAgentSessionSelector((s) => s.turn.running);
  if (!replies.length || running) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-4 pb-2" data-agent-session-replies>
      {replies.map((reply) => (
        <button
          key={reply}
          type="button"
          className="shrink-0 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950/40"
          data-agent-session-reply
          onClick={() => fillComposer(reply)}
        >
          {reply}
        </button>
      ))}
    </div>
  );
}

/**
 * The composer's model and credits (#2779 follow-up): one pill that names the
 * model and opens the sheet (./composer-parts.tsx), and what is left of the
 * week's credits in a pill beside Send, with a ring round Send that empties
 * as they go. Both read what the old picker and meter read: the conversation's
 * choice (./model-choice.ts) and the header's own budget figures, kept live by
 * `budget_updated` (../header/ai-credit.js).
 */
function useModelChoice() {
  const snapshot = useAgentSessionPick((s) => ({
    catalog: s.catalog, session: s.session, draft: s.draft, choosing: s.choosing, phase: s.phase,
  }));
  // The catalog is read once per page, but a part that did not answer is
  // asked again (./store.ts): when a conversation is opened or routed to,
  // when the page comes back to the foreground, and when the network
  // returns. Each is a no-op once everything has answered.
  useEffect(() => { void loadModelCatalog(); }, []);
  useEffect(() => {
    const retry = () => { if (document.visibilityState !== 'hidden') void loadModelCatalog(); };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, []);
  const catalog = snapshot.catalog;
  const explicit = snapshot.session ? (snapshot.session.agent || null) : (snapshot.draft?.agent || null);
  const current = effectiveChoice(explicit, catalog);
  const options = pickerOptions(catalog, current);
  const value = choiceValue(current);
  const selected = options.find((option) => option.value === value) || null;
  const effort = current && offersReasoning(current, catalog)
    ? {
      value: effortValue(current, catalog),
      options: effortOptions(catalog),
      onPick: (picked: string) => void chooseAgent({ ...current, reasoningEffort: picked || null }),
    }
    : null;
  return {
    ready: !!(options.length && current),
    label: selected ? selected.label : t('agent:session.model.fallbackLabel'),
    // #3079: the pill names the thinking level after the model, for a model
    // that takes one: its own level, or the default it follows. Nothing when
    // none is known, never a "Default" placeholder (model-choice.ts).
    effortLabel: effortLabel(current, catalog),
    options: modelList(options),
    value,
    effort,
    pick: (picked: string) => {
      const next = choiceFromValue(picked, catalog, current);
      if (next) void chooseAgent(next);
    },
    busy: snapshot.choosing || snapshot.phase === 'loading',
  };
}

function useCredit(): CreditView | null {
  const { figures } = useStoreState<AiBudgetState>(aiBudgetStore);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted ? creditView(figures) : null;
}

// Message ids, read when the composer is drawn.
const BUSY_PLACEHOLDER = 'agent:session.composer.busyPlaceholder';
const SAVE_TITLE = 'agent:session.composer.saveTitle';

/**
 * The saved drafts above the composer (the dev chat's #798 list, per account):
 * each can be sent once the Mayor is free, put back in the box to reword, or
 * deleted. Sending is always a tap here, never automatic.
 */
export function SavedDrafts({ drafts, busy, onSend, onEdit }: {
  drafts: SavedDraft[];
  busy: boolean;
  onSend: (draft: SavedDraft) => void;
  onEdit: (draft: SavedDraft) => void;
}) {
  const t = useMessages('agent');
  if (!drafts.length) return null;
  const button = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors '
    + 'hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent '
    + 'dark:text-zinc-400 dark:hover:bg-zinc-800';
  return (
    <section
      aria-label={t('agent:session.drafts.label')}
      className="mb-2 max-h-40 overflow-y-auto rounded-2xl bg-zinc-100 p-1.5 dark:bg-zinc-800/70"
      data-agent-session-drafts={drafts.length}
    >
      <p className="flex flex-wrap items-baseline gap-x-1.5 px-2 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <RichMessage
          id="agent:session.drafts.heading"
          values={{ count: drafts.length }}
          components={[<span className="font-semibold uppercase tracking-wide" />, <span />]}
        />
        {busy
          ? <span className="ms-auto">{t('agent:session.drafts.locked')}</span>
          : <span className="ms-auto font-semibold text-violet-700 dark:text-violet-300" data-agent-session-drafts-ready>{t('agent:session.drafts.ready')}</span>}
      </p>
      <ul className="flex flex-col gap-1">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            className="flex items-center gap-0.5 rounded-xl bg-white py-0.5 ps-3 pe-0.5 dark:bg-zinc-900"
            data-agent-session-draft={draft.id}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200" title={draft.text}>{draft.text}</span>
            <button
              type="button"
              className={`${button} hover:text-emerald-700 dark:hover:text-emerald-400`}
              aria-label={t('agent:session.drafts.send')}
              title={busy ? t('agent:session.drafts.sendBusyTitle') : t('agent:session.drafts.sendTitle')}
              disabled={busy}
              data-agent-session-draft-send
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSend(draft)}
            >
              <DraftSendIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-violet-700 dark:hover:text-violet-300`}
              aria-label={t('agent:session.drafts.edit')}
              title={t('agent:session.drafts.editTitle')}
              data-agent-session-draft-edit
              onClick={() => onEdit(draft)}
            >
              <DraftEditIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-red-700 dark:hover:text-red-300`}
              aria-label={t('agent:session.drafts.delete')}
              title={t('agent:session.drafts.delete')}
              data-agent-session-draft-delete
              onClick={() => deleteSavedDraft(draft.id)}
            >
              <DraftTrashIcon width={16} height={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The message box. Its ONE button follows the dev chat's (#798, #810):
 * Send while the Mayor is free; while it works, Stop with nothing typed and
 * a green Save with something typed, which parks the text as a saved draft
 * (Ctrl/Cmd+Enter does the same) so nothing typed mid-turn can leak into the running
 * turn. What is typed and not sent is kept for the conversation (./unsent.ts).
 *
 * THE OUTLINE IS THE CARD'S, as on Messages' composer (#1954, #2882, #2387):
 * `.agent-session-composer:focus-within` rings the whole card, and the field
 * inside draws no edge of its own in any engine (public/css/app.css).
 */
export function StopStatus({ turn, onStop }: {
  turn: { running: boolean; stopping: boolean; stopRequestedAt: number | null; stopPending: boolean; stopError: string | null };
  onStop: () => void;
}) {
  const t = useMessages('agent');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!turn.running || !turn.stopping) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.running, turn.stopping]);
  if (!turn.running || (!turn.stopping && !turn.stopError)) return null;
  const slow = !!turn.stopRequestedAt && now - turn.stopRequestedAt >= 3000;
  return (
    <div data-agent-session-stop-status className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] text-zinc-600 dark:text-zinc-300" role="status">
      <span className="min-w-0 flex-1">{turn.stopError || (slow ? t('agent:session.stop.slow') : t('agent:session.stop.stopping'))}</span>
      {turn.stopError || slow ? (
        <Button type="button" variant="pillNeutral" ink="neutral" size="sm" disabledStyle="dim" disabled={turn.stopPending} onClick={() => onStop()}>{t('agent:session.stop.retry')}</Button>
      ) : null}
    </div>
  );
}

function Composer({ id }: { id: string }) {
  const t = useMessages('agent');
  // The fields the box draws from, and not the streamed text: a reply
  // arriving does not re-render the box being typed in.
  const snapshot = useAgentSessionPick((s) => ({
    id: s.id,
    draft: s.draft,
    session: s.session,
    phase: s.phase,
    returnedText: s.returnedText,
    composerFill: s.composerFill,
    handoff: s.handoff,
    drafts: s.drafts,
    attachments: s.attachments,
    running: s.turn.running,
    stopping: s.turn.stopping,
    stopRequestedAt: s.turn.stopRequestedAt,
    stopPending: s.turn.stopPending,
    stopError: s.turn.stopError,
    turnPhase: s.turn.phase,
    // The low-credits note covers a conversation under way too (#4801); the
    // out-of-credits card is what replaces it, so a refusal set on the store
    // hides the note while the card is open.
    refused: !!s.credits,
  }));
  const [value, setValue] = useState('');
  const [dictating, setDictating] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const running = snapshot.running;
  const archived = snapshot.session?.status === 'archived';
  const returned = snapshot.returnedText;
  const target = snapshot.id ?? (snapshot.draft ? 'new' : null);
  // Save needs something typed, and a turn not already stopping: Stop hands
  // the message back to the box, and the button must stay Stop under the
  // same click rather than become a Save that the click then submits.
  const saving = running && !snapshot.stopping && !!value.trim();
  const model = useModelChoice();
  const credit = useCredit();
  // #4792: a send held for the low-credits check — the message that would
  // have gone out, waiting on Continue. Null when nothing is held. The text
  // itself is not copied here: the box keeps it, and Continue reads it.
  const [pendingSend, setPendingSend] = useState<null | { kind: 'text' } | { kind: 'draft'; draft: SavedDraft }>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [buildTab, setBuildTab] = useState<BuildTab>('homeroom');
  const pill = useRef<HTMLButtonElement | null>(null);
  const attach = useRef<HTMLButtonElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const files = snapshot.attachments;
  const uploading = files.some((item) => item.status === 'uploading');
  const sendable = !!value.trim() || files.length > 0;
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const openSheet = (tab: BuildTab) => { setBuildTab(tab); setSheetOpen(true); };

  // The credits card's hand-off rows open "Build with" on that agent's tab:
  // one hand-off, drawn in one place (#3078).
  useEffect(() => {
    if (!snapshot.handoff) return;
    openSheet(snapshot.handoff);
    closeHandoff();
  }, [snapshot.handoff]);

  const update = (next: string) => {
    setValue(next);
    if (target != null) writeUnsent(target, next);
  };

  // Put `text` in the box's view with the caret at its end. Focus only with a
  // fine pointer: on a phone it would raise the keyboard over what was just
  // put there (the dev chat's _isCoarsePointer rule).
  const focusAtEnd = (text: string) => {
    const field = input.current;
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch { /* no media queries: treat as fine */ }
    if (field && !coarse) {
      field.focus();
      try { field.setSelectionRange(text.length, text.length); } catch { /* not a text field yet */ }
    }
  };

  // The conversation's unsent text, back after a reload or a switch. An
  // unsent conversation started from a request (Start work), or handed a
  // message (Explore), offers that first message when nothing
  // was typed (./request-seed.ts), from the hint, so it is kept only once
  // edited and never turns up in a later New change. A new hint is a new
  // start, even on the same address.
  const seed = target === 'new' ? draftSeed(snapshot.draft?.hint) : '';
  const hint = snapshot.draft?.hint;
  useEffect(() => {
    if (target == null) return;
    const saved = readUnsent(target);
    setValue(saved || seed);
    if (!saved && seed) {
      // The screen is revealed after this first render: focus once it shows.
      const frame = window.requestAnimationFrame(() => focusAtEnd(seed));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [target, hint]);

  // A message the server refused, or a Stop, hands its text back, unless
  // something new has been typed since.
  useEffect(() => {
    if (returned == null) return;
    if (!value.trim()) update(returned);
    clearReturnedText();
  }, [returned]);

  // A tapped suggested reply (#3033) replaces what is in the box, as the dev
  // chat's pills do, with the caret at its end.
  const fill = snapshot.composerFill;
  useEffect(() => {
    if (!fill) return;
    update(fill.text);
    clearComposerFill();
    focusAtEnd(fill.text);
  }, [fill]);

  const placeholder = archived
    ? t('agent:session.composer.archivedPlaceholder')
    : running ? t(BUSY_PLACEHOLDER) : t('agent:session.composer.placeholder');

  // The field grows with what it holds, typed or put back. Empty, it is as
  // tall as its hint, which wraps on a phone and was cut off mid-line under
  // a one-line box (#3016): the hint is measured as the value for a moment
  // and taken straight back out, which fires no input event.
  const fitField = useCallback(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    let height = field.scrollHeight;
    if (!field.value && field.placeholder) {
      field.value = field.placeholder;
      height = field.scrollHeight;
      field.value = '';
    }
    field.style.height = `${Math.min(height, 144)}px`;
  }, []);
  useEffect(() => { fitField(); }, [value, placeholder, fitField]);
  // And again whenever its width changes. The composer mounts with its
  // screen, often while that screen is still hidden, where every measure is
  // 0: the box then kept a one-line height and clipped the hint's second
  // line until something was typed. Width only, so the height this sets
  // cannot call it again.
  useEffect(() => {
    const field = input.current;
    if (!field || typeof ResizeObserver === 'undefined') return undefined;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fitField();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [fitField]);

  // The sends themselves, lifted out of the form handlers so the low-credits
  // check's Continue can run the same body (#4792).
  const sendTyped = () => {
    const text = value.trim();
    update('');
    void sendAgentMessage(text);
  };
  const sendDraft = (draft: SavedDraft) => {
    const typed = value;
    update('');
    void sendSavedDraft(draft.id, typed);
  };

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (dictating) return;
    const text = value.trim();
    if (running) {
      if (saveComposerDraft(text)) update('');
      return;
    }
    if (!text && !files.length) return;
    // Files still uploading hold the send: the button says so, and Ctrl/Cmd+Enter waits too.
    if (uploading) return;
    // Almost no credits left (#4792): stop for one tap first. The box keeps
    // its text; Continue sends it, Cancel keeps it.
    if (needsLowCreditCheck(credit)) {
      setPendingSend({ kind: 'text' });
      return;
    }
    sendTyped();
  }

  // Pasted or dropped files join the tray (a pasted screenshot gets a name).
  const takeFiles = (list: FileList | File[] | null | undefined) => {
    const picked = Array.from(list || []);
    if (!picked.length) return false;
    addAttachments(picked.map((file, index) => (
      file.name && file.name !== 'image.png' ? file : new File([file], pastedName(file, index), { type: file.type })
    )));
    return true;
  };

  const onSendDraft = (draft: SavedDraft) => {
    if (running) return;
    if (needsLowCreditCheck(credit)) {
      setPendingSend({ kind: 'draft', draft });
      return;
    }
    sendDraft(draft);
  };

  // The check's two taps. Continue confirms for the rest of the visit and
  // runs the held send; Cancel only closes the check, so the next Send asks
  // again. The text send reads the box's current value, which it still holds.
  const onConfirmSend = () => {
    const held = pendingSend;
    confirmLowCredit();
    setPendingSend(null);
    if (!held) return;
    if (held.kind === 'draft') sendDraft(held.draft);
    else sendTyped();
  };
  const onCancelSend = () => setPendingSend(null);

  // The held send belongs to this conversation and this credit level: a
  // switch of conversation, a turn that starts, or figures that refresh
  // above the threshold (a top-up) close the check, and the next Send goes
  // straight through.
  useEffect(() => {
    setPendingSend(null);
  }, [target, running]);
  useEffect(() => {
    if (pendingSend && !isLowCredit(credit)) setPendingSend(null);
  }, [credit, pendingSend]);
  const onEditDraft = (draft: SavedDraft) => {
    const text = editSavedDraft(draft.id, value);
    if (text == null) return;
    update(text);
    input.current?.focus();
  };

  const drop = useFileDrag({ disabled: archived, onFiles: (dropped) => { takeFiles(dropped); } });

  const kind = saving ? 'save' : running ? 'stop' : 'send';
  return (
    // `platform-safe-bar` on the outer box: its padding clears the tab bar
    // (a phone keeps it up on this screen) and the home-indicator strip, so
    // the bordered field above it never sits under either.
    <div className="platform-safe-bar shrink-0 px-3 pt-1" {...drop.handlers}>
    {archived ? (
      <p className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" data-agent-session-archived>
        <span className="min-w-0 flex-1">{t('agent:session.composer.archivedNote')}</span>
        <button type="button" className={CARD_BUTTON} onClick={() => void unarchiveCurrentSession()}>{t('agent:session.composer.unarchive')}</button>
      </p>
    ) : null}
    <SavedDrafts drafts={snapshot.drafts} busy={running} onSend={onSendDraft} onEdit={onEditDraft} />
    <StopStatus turn={snapshot} onStop={() => { void stopAgentTurn(); }} />
    <form
      className="agent-session-composer flex flex-col gap-2 rounded-[1.75rem] border border-zinc-200 bg-white px-3 pb-2.5 pt-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
      onSubmit={submit}
    >
      {/* #4065: the drop zone, over the card while a file is held anywhere
          on the bar around it (the drop is the bar's, a little wider than
          the card, so a near miss still attaches). */}
      {drop.dragging ? <DropOverlay /> : null}
      {files.length ? (
        <PendingStrip
          id={`${id}-attachments`}
          items={files.map((item) => ({
            key: item.key,
            name: item.name,
            kind: item.kind,
            badge: badgeFor(item.kind, item.name),
            size: formatSize(item.size),
            thumbUrl: item.thumbUrl,
            uploading: item.status === 'uploading',
          }))}
          onRemove={removeAttachment}
        />
      ) : null}
      {saving ? (
        // Said in words, above what is typed, the moment it applies: while
        // the Mayor works, Ctrl/Cmd+Enter and the button keep this as a draft. It is
        // not sent, and nothing sends it on its own.
        <p className="px-2 text-[13px] text-zinc-600 dark:text-zinc-300" data-agent-session-save-note>
          <RichMessage id="agent:session.composer.saveNote" components={[<span className="font-semibold" />]} />
        </p>
      ) : null}
      <textarea
        ref={input}
        id={id}
        rows={1}
        maxLength={20_000}
        value={value}
        disabled={archived || snapshot.phase === 'loading'}
        placeholder={placeholder}
        aria-label={t('agent:session.composer.label')}
        className="agent-session-composer-input max-h-36 min-h-[2.5rem] w-full resize-none bg-transparent px-2 py-1.5 text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-400"
        onChange={(event) => update(event.target.value)}
        onPaste={(event) => {
          if (archived || !event.clipboardData?.files?.length) return;
          if (takeFiles(event.clipboardData.files)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Enter is a new line; Send (or Ctrl/Cmd+Enter, as in the dev chat) sends.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {/* The low-credits note (#4784, #4801): the credits pill is red — one
          line, before the send row, before the first message and once the
          conversation is under way. Hidden in an archived conversation, and
          while the out-of-credits card is open. While the low-credits check
          (#4792) is open it gives way to the check, which says the same
          words with Cancel and Continue beside them. */}
      {!archived && pendingSend && credit ? (
        <LowCreditConfirm
          credit={credit}
          buttonClass={CARD_BUTTON}
          primaryClass={CARD_PRIMARY}
          onContinue={onConfirmSend}
          onCancel={onCancelSend}
        />
      ) : null}
      {!archived && !pendingSend && showLowCreditNote(credit, snapshot.refused) ? <LowCreditNote credit={credit} /> : null}
      {/* #3574: the row is a size container so the model pill can tighten
          its padding on the narrowest phones (composer-parts.tsx ModelPill).
          Its width is the composer's, never its contents'. */}
      <div className="flex items-center gap-2 [container-type:inline-size]">
        {/* One picker, no menu of our own: a phone's own file picker already
            offers the photo library, the camera and files. */}
        <button
          ref={attach}
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-800 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
          aria-label={t('agent:session.composer.attach')}
          title={t('agent:session.composer.attach')}
          disabled={archived || snapshot.phase === 'loading'}
          data-agent-session-attach
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon className="h-5 w-5" aria-hidden="true" />
        </button>
        <SpeakButton scope={`agent:${target}`} getText={() => input.current?.value || ''} onText={update} maxLength={20000} disabled={archived || !!pendingSend || snapshot.phase === 'loading'} onBusyChange={setDictating} />
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            takeFiles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        {model.ready ? (
          <ModelPill
            label={model.label}
            effort={model.effortLabel}
            disabled={archived || model.busy}
            open={sheetOpen}
            onOpen={() => openSheet('homeroom')}
            pillRef={pill}
          />
        ) : null}
        {/* The credits pill doubles as the row's spacer: it takes the free
            space and decides from it how much to say.

            #3574: not while a draft is being saved. Stop and "Save draft"
            take Send's place then, about 130px more, and on a phone the
            row has no room left for the model's name AND the credits: the
            credits pill used to be drawn over the name, and now that it keeps
            its own width the name would be squeezed to an empty pill. It is
            back the moment the draft is saved or the field is cleared, and
            the model sheet says the same figures meanwhile. */}
        {credit && kind !== 'save' ? <CreditPill credit={credit} onOpen={() => openSheet('homeroom')} /> : <div className="min-w-0 flex-1" />}
        {/* Every button in Send's place keeps the field focused through the
            press. A blur drops the keyboard, the tab bar and the Resume strip
            come back (lib/keyboard-open.ts), the composer falls by the
            keyboard's height, and the click lands on nothing. */}
        {kind === 'save' ? (
          <>
          <Button type="button" variant="pillDanger" ink="dangerTint" size="icon" className="inline-flex h-10 w-10 shrink-0 items-center justify-center" aria-label={t('agent:session.composer.stop')} title={t('agent:session.composer.stop')}
            disabled={snapshot.turnPhase === 'mayor2'} onMouseDown={(event) => event.preventDefault()} onClick={() => { void stopAgentTurn(); }}>
            <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
          </Button>
          <Button
            key="save"
            type="submit"
            data-agent-session-send="save"
            disabled={dictating}
            onMouseDown={(event) => event.preventDefault()}
            variant="unstyled"
            ink="solid"
            // Words, not a round button in Send's place: a green circle read
            // as Send, and the message went to the drafts instead.
            className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3.5 text-sm font-semibold hover:bg-emerald-700"
            aria-label={t('agent:session.composer.saveAsDraft')}
            title={t(SAVE_TITLE)}
          >
            <SaveDraftIcon width={18} height={18} aria-hidden="true" />
            <span>{t('agent:session.composer.saveDraft')}</span>
          </Button>
          </>
        ) : (
          <Button
            key="send"
            type={running ? 'button' : 'submit'}
            data-agent-session-send={kind}
            onMouseDown={(event) => event.preventDefault()}
            variant={running ? 'pillDanger' : 'pillAccent'}
            disabledStyle="dim"
            size="icon"
            ink={running ? 'dangerTint' : 'solid'}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center"
            disabled={running ? (snapshot.stopping || snapshot.turnPhase === 'mayor2') : (dictating || !sendable || uploading)}
            aria-label={running ? t('agent:session.composer.stop') : uploading ? t('agent:session.composer.sendWaitingLabel') : t('agent:session.composer.send')}
            title={running
              ? (snapshot.turnPhase === 'mayor2' ? t('agent:session.composer.stopUnavailableTitle') : t('agent:session.composer.stop'))
              : uploading ? t('agent:session.composer.sendWaitingTitle') : t('agent:session.composer.send')}
            onClick={running ? () => void stopAgentTurn() : undefined}
          >
            {running ? <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" /> : <ArrowUpIcon className="h-5 w-5" aria-hidden="true" />}
          </Button>
        )}
      </div>
      {sheetOpen ? (
        <ModelSheet anchor={model.ready ? pill : attach} onClose={closeSheet}>
          <BuildSheetBody
            tab={buildTab}
            onTab={setBuildTab}
            onClose={closeSheet}
            homeroom={(
              <ModelSheetBody
                options={model.ready ? model.options : []}
                value={model.value}
                onPick={(picked) => { model.pick(picked); closeSheet(); }}
                effort={model.effort}
                credit={credit}
              />
            )}
            handoff={buildTab === 'homeroom' ? null : <HandoffPanel agent={buildTab} onClose={closeSheet} />}
          />
        </ModelSheet>
      ) : null}
    </form>
    </div>
  );
}

// ── The changes drawer ─────────────────────────────────────────────────

export function ChangesDrawer({ session }: { session: AgentSession }) {
  const t = useMessages('agent');
  const wide = useWideEnoughForSpec();
  const active = session.activeChange;
  const others = (session.changes || []).filter((change) => !active || change.id !== active.id);
  const closed = new Set(['merged', 'archived']);
  // A merge of Homeroom itself waits for the platform's next release, and
  // the drawer says when, counting down while it is open.
  const now = useReleaseNow(active?.release, ...others.map((change) => change.release));
  const activeRelease = changeReleaseLine(active, now);
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col justify-end bg-zinc-950/30 sm:items-end sm:justify-stretch"
      data-agent-session-drawer
      onClick={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}
    >
      <section
        role="dialog"
        aria-label={t('agent:session.drawer.heading')}
        className="platform-safe-bar max-h-[85%] w-full overflow-y-auto rounded-t-3xl bg-white p-4 shadow-xl dark:bg-zinc-900 sm:h-full sm:max-h-none sm:max-w-sm sm:rounded-none"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('agent:session.drawer.heading')}</h2>
          <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={t('core:common.close')} onClick={() => setDrawerOpen(false)}>
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('agent:session.drawer.active')}</h3>
        {active ? (
          <div className="rounded-2xl bg-zinc-50 p-3 dark:bg-zinc-800/60" data-agent-session-active-change>
            <div className="flex items-start gap-2">
              <AppMark name={active.appName} slug={active.appSlug} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-900 dark:text-zinc-100">{active.title || changeRef(active)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{active.prNumber
                  ? t('agent:session.drawer.activeLinePr', { app: active.appName || active.appSlug, number: active.prNumber, change: active.id })
                  : t('agent:session.drawer.lineChange', { app: active.appName || active.appSlug, number: active.id })}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(active.status)}`} title={activeRelease || undefined}>{changeStatusLabel(active.status)}</span>
            </div>
            {activeRelease ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300" data-agent-session-release>{activeRelease}</p> : null}
            {active.checkState ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{t('agent:session.drawer.checks', { state: active.checkState })}</p> : null}
            {active.checkState === 'skipped'
              ? <p className={CHECK_REASON} data-agent-session-checks-reason>{skippedChecksReason(active.checkSkipReason)}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {active.stagingUrl ? (
                <Button
                  type="button"
                  data-agent-session-drawer-preview
                  variant="pillAccent"
                  ink="solid"
                  onClick={() => showPreview({ changeId: active.id, url: active.stagingUrl as string, prNumber: active.prNumber ?? null }, wide)}
                >
                  {t('agent:session.drawer.openPreview')}
                </Button>
              ) : null}
              <button
                type="button"
                data-agent-session-open-spec
                className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                onClick={() => void openSpec(active.id)}
              >
                {t('agent:session.drawer.spec')}
              </button>
              {active.appSlug ? (
                <a
                  className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                  href={changeLink(active.appSlug, active.id, active.prNumber)}
                >
                  {t('agent:session.drawer.proposalPage')}
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('agent:session.drawer.none')}</p>
        )}
        {others.length ? (
          <>
            <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('agent:session.drawer.earlier')}</h3>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {others.map((change) => (
                <li key={change.id} className="flex items-center gap-2 py-2" data-agent-session-earlier-change={change.id}>
                  <AppMark name={change.appName} slug={change.appSlug} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{change.title || changeRef(change)}</p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.prNumber
                      ? t('agent:session.drawer.linePr', { app: change.appName || change.appSlug, number: change.prNumber })
                      : t('agent:session.drawer.lineChange', { app: change.appName || change.appSlug, number: change.id })}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(change.status)}`} title={changeReleaseLine(change, now) || undefined}>{changeStatusLabel(change.status)}</span>
                  {!closed.has(change.status || '') ? (
                    <button type="button" className="shrink-0 text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300" onClick={() => void switchActiveChange(change.id)}>
                      {t('agent:session.drawer.switchTo')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ── The panel and the screen ───────────────────────────────────────────

/**
 * Follow new output only while the reader is at the bottom (the dev chat's
 * rule): scrolling up to read is not undone by the next words. Opening a
 * conversation, or sending in it, goes back to the bottom.
 *
 * A component of its own, drawing nothing, because it reads the streamed
 * text: in the panel, that read made the whole panel re-render for every
 * token. Here it is one cheap render per frame of a reply. The three effects
 * keep their order (the two that re-arm `stick` run before the one that
 * scrolls), and they run after the frame's rows are in the DOM, so the
 * height they measure includes them.
 */
function FollowOutput({ scroll, stick, count }: {
  scroll: { current: HTMLDivElement | null };
  stick: { current: boolean };
  /** How many transcript rows are drawn: a new row is new output too. */
  count: number;
}) {
  const live = useAgentSessionPick((s) => ({
    id: s.id,
    streamText: s.turn.streamText,
    running: s.turn.running,
    cards: s.turn.cards.length,
    outbox: s.outbox.length,
  }));
  useEffect(() => { stick.current = true; }, [live.id]);
  // Sending a message takes the reader to it, wherever they were.
  const sent = useRef(live.outbox);
  useEffect(() => {
    if (live.outbox > sent.current) stick.current = true;
    sent.current = live.outbox;
  }, [live.outbox]);
  useEffect(() => {
    if (!scroll.current || !stick.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [live.id, count, live.streamText, live.running, live.cards, live.outbox]);
  return null;
}

/**
 * `headerAction` is a surface's addition to the session bar, drawn at its
 * end: the Messages pane passes its full-width toggle, which every
 * discussion pane carries in that place.
 */
export function AgentSessionPanel({ embedded = false, headerAction = null }: { embedded?: boolean; headerAction?: ReactNode }) {
  const t = useMessages('agent');
  // Everything the panel draws except the live turn, which LiveTurn and
  // FollowOutput read for themselves: a frame of streamed text does not
  // re-render the panel.
  const snapshot = useAgentSessionPick((s) => ({
    id: s.id,
    phase: s.phase,
    session: s.session,
    draft: s.draft,
    messages: s.messages,
    actions: s.actions,
    running: s.turn.running,
    turnPhase: s.turn.phase,
    outbox: s.outbox.length,
    credits: s.credits,
    error: s.error,
    drawerOpen: s.drawerOpen,
    specSheet: s.specSheet,
    preview: s.preview,
    paneTab: s.paneTab,
  }));
  const scroll = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  // The side pane beside the chat (the spec, a preview, or both), or the
  // spec over it (./spec-layout.ts). False until mounted, so the first
  // render is the one the prerender printed.
  const beside = useSidePaneBeside(embedded ? 'messages' : 'screen');
  const liveRun = snapshot.running && snapshot.turnPhase === 'cc';
  const items = useMemo(
    () => buildTranscript(snapshot.messages, snapshot.actions, Date.now(), { liveRun }),
    [snapshot.messages, snapshot.actions, liveRun],
  );
  const runShown = items.some((item) => item.kind === 'run' && item.status === 'running');
  // #3755: the active change's checks failed and nothing is working: the
  // conversation says so at its end, and offers the fix (./fix-checks.ts).
  const fixOffer = useMemo(() => (snapshot.phase === 'ready' ? fixChecksOffer({
    change: snapshot.session?.activeChange,
    busy: snapshot.running || !!snapshot.session?.busy,
    messages: snapshot.messages,
    unsent: snapshot.outbox,
  }) : null), [snapshot.phase, snapshot.session, snapshot.running, snapshot.messages, snapshot.outbox]);

  // The run card's clock is the dev chat's (`nowStore`), whose heartbeat only
  // beats inside the dev chat's own transcript; beat it here while a run is
  // on screen.
  useEffect(() => {
    if (!runShown) return undefined;
    const beat = () => nowStore.set({ now: Date.now() });
    beat();
    const timer = window.setInterval(beat, 1000);
    return () => window.clearInterval(timer);
  }, [runShown]);
  const replies = latestReplies(items);
  const empty = snapshot.phase === 'ready' && !items.length && !snapshot.running && !snapshot.outbox;
  const about: About = snapshot.session || snapshot.draft;
  // #5728: the project a reply's `#N` / `PR#N` chips open, the one "Open app"
  // opens (without its self-hosted exclusion: Homeroom's own board is a page
  // like any other).
  const refSlug = snapshot.session?.activeChange?.appSlug || about?.focusApp?.slug || null;
  const request = snapshot.draft ? draftRequest(snapshot.draft.hint) : null;

  // ── Nothing in the transcript is wider than the transcript (#3559) ──
  //
  // The transcript scrolls down, and a box that scrolls on one axis scrolls
  // on the other as well: `overflow-y: auto` makes `overflow-x` auto too. So
  // one unbroken run of text (a link pasted into a message, a path in a
  // note, a card whose title is an identifier) made the whole conversation
  // wider than a phone, and it slid sideways under a finger. Measured at
  // 390px: a pasted staging link in the reader's own bubble took this
  // scroller to 690px, 300px of sideways travel; a failed turn's note and a
  // card title carrying one did the same.
  //
  // `overflow-wrap: anywhere`, set on the scroller and inherited by every
  // row, breaks such a run inside its own box when nothing else lets it
  // fit. `anywhere` and not `break-words`, because it also lowers the run's
  // min-content width: the note beside Retry is a flex item, and a request's
  // title on the empty state is a centred block, and either would otherwise
  // be held at the width of its longest word. The Mayor's markdown already
  // broke this way (`.dc-msg-content`'s `word-break: break-word`), which is
  // why a reply never overflowed and the rows around it did. A code block
  // and a run's log are `white-space: pre`, which never wraps, so they keep
  // scrolling sideways inside their own boxes, as a table does inside its.
  //
  // Whether the reader is at the bottom, which FollowOutput keeps them at.
  const stick = useRef(true);
  const onScroll = () => {
    const el = scroll.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // The transcript shrinks when something grows under it (the saved drafts,
  // a taller message box): a reader at the bottom stays there.
  useEffect(() => {
    const el = scroll.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className={`relative flex min-h-0 min-w-0 flex-1 ${embedded ? '' : 'dc-lift dc-lift-strip'}`} data-agent-session-panel={embedded ? 'messages' : 'screen'}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-agent-session-chat>
        <SessionBar session={snapshot.session} about={about} embedded={embedded} action={headerAction} />
        <div ref={scroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 [overflow-wrap:anywhere]" aria-live="polite" onScroll={onScroll}>
          {snapshot.phase === 'loading' ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" />{` ${t('core:common.loading')}`}</div>
          ) : null}
          {empty ? <EmptyState about={about} request={request} /> : null}
          {items.map((item) => <Item key={item.key} item={item} sessionId={snapshot.id} appSlug={refSlug} />)}
          <OutboxRows />
          <LiveTurn runShown={runShown} appSlug={refSlug} />
          {fixOffer ? <FixChecksCard key={fixOffer.key} offer={fixOffer} /> : null}
          <FollowOutput scroll={scroll} stick={stick} count={items.length + (fixOffer ? 1 : 0)} />
          {snapshot.session?.activeChange?.previewCapture ? <PreviewCapture change={snapshot.session.activeChange} /> : null}
          {snapshot.credits ? <CreditsCard refusal={snapshot.credits} /> : null}
          {snapshot.error ? (
            <p role="alert" className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{snapshot.error}</p>
          ) : null}
        </div>
        {/* The way down when the reader is up the transcript, within the
            same 80px FollowOutput keeps them following at. */}
        <JumpToLatest scroller={scroll} slack={80} />
        <Replies replies={empty ? starters(about, request) : replies} />
        <Composer id={composerId(embedded ? 'messages' : 'screen')} />
        {snapshot.drawerOpen && snapshot.session ? <ChangesDrawer session={snapshot.session} /> : null}
      </div>
      {beside ? (
        <SidePane sheet={snapshot.specSheet} preview={snapshot.preview} tab={snapshot.paneTab} containerRef={root} />
      ) : snapshot.specSheet ? <SpecSheet sheet={snapshot.specSheet} /> : null}
    </div>
  );
}

export function AgentSessionScreen() {
  const t = useMessages('agent');
  const snapshot = useAgentSessionPick((s) => ({ open: s.open, host: s.host }));
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'agent-session-screen', false);

  // A cold deep link can reveal this island before app.js has routed it;
  // resolve the address once after hydration.
  useEffect(() => {
    if (snapshot.open || !window.location.hash.startsWith('#agent/')) return;
    const [segment, section] = window.location.hash.slice('#agent/'.length).split('/');
    if (segment === 'new') {
      void openAgentSession({ id: 'new', host: 'screen' });
      return;
    }
    const id = Number(segment);
    if (Number.isSafeInteger(id) && id > 0) void openAgentSession({ id, host: 'screen', drawer: section === 'changes' });
  }, [snapshot.open]);

  return (
    <main
      ref={screenRef}
      id="agent-session-screen"
      className="hidden flex flex-1 min-h-0 overflow-hidden"
      aria-label={t('agent:session.screenLabel')}
    >
      {snapshot.open && snapshot.host === 'screen' ? <AgentSessionPanel /> : null}
    </main>
  );
}

export { useAgentSessionState } from './store';
