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
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import type { AiBudgetState } from '../header/ai-budget';
import { aiBudgetStore } from '../header/ai-budget-store.js';
import { Attached } from '../dev-chat/transcript';
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
  ModelPill,
  ModelSheet,
  ModelSheetBody,
  type BuildTab,
  SentAttachments,
  creditView,
  modelList,
  type CreditView,
} from './composer-parts';
import {
  buildTranscript,
  checksSummary,
  skippedChecksReason,
  cardView,
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
import { readUnsent, writeUnsent } from './unsent';
import { draftRequest, draftSeed, type DraftRequest } from './request-seed';
import { CreditsCard, HandoffPanel } from './handoff';

// Agent sessions (#2779, docs/agent-sessions.md "UI surfaces"): one
// conversation with the Mayor that works on any app. Drawn on two surfaces,
// like Global Chat: its own screen (#agent/<id>, a phone's only surface) and
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

const MayorText = memo(function MayorText({ text }: { text: string }) {
  const html = useMemo(() => markdown(text), [text]);
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
      className="hidden lg:inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
      title={`Open ${target.name || target.slug} with this chat docked beside it`}
      onClick={open}
    >
      <AppWindowIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="truncate">Open app</span>
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
  return change.prNumber ? `PR #${change.prNumber}` : `Change ${change.id}`;
}

// ── Header ─────────────────────────────────────────────────────────────

/** What the conversation is about: the session's, or the unsent draft's. */
type About = Pick<AgentSession, 'focusApp' | 'focusContext'> | null;

function SessionBar({ session, about, embedded, action }: {
  session: AgentSession | null;
  about: About;
  embedded: boolean;
  /** The pane's own control at the bar's end — Messages' full-width toggle. */
  action?: ReactNode;
}) {
  const building = useAgentSessionSelector((s) => s.turn.running && s.turn.phase === 'cc');
  const active = session?.activeChange || null;
  const count = session?.changes?.length || 0;
  const target = openAppTarget(active, about);
  // It wraps on both surfaces (#3016). On a phone its five controls are wider
  // than the screen, and a bar that cannot wrap made the whole conversation
  // that wide: the right edge of every message and the Send button were off
  // screen. Changes and the ⋯ sit at the end of whichever row they land on;
  // from `sm` up everything fits on one, as before. (The Build picker that
  // started the second row is the composer's "Build with" now, #3078.)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800" data-agent-session-bar>
      {embedded ? (
        <div className="mr-auto min-w-0 basis-full sm:basis-auto">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{session?.title || 'New session'}</h2>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            Agent session{about?.focusApp?.name ? ` · started from ${about.focusApp.name}` : ''}
          </p>
        </div>
      ) : null}
      <span
        data-agent-session-focus
        className="inline-flex min-w-0 max-w-[10rem] items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200"
        title="The app this conversation is about when a request does not name one. The Mayor moves it when you ask."
      >
        {about?.focusApp ? (
          <AppMark
            name={about.focusApp.name}
            slug={about.focusApp.selfHosted ? null : about.focusApp.slug}
            iconUrl={about.focusApp.iconUrl}
            iconEmoji={about.focusApp.iconEmoji}
          />
        ) : null}
        <span className="truncate">{about?.focusApp?.name || 'Any app'}</span>
      </span>
      <span
        data-agent-session-change-pill
        className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(active?.status)}`}
      >
        {active ? `${changeStatusLabel(active.status, building)}${active.prNumber ? ` · PR #${active.prNumber}` : ''}` : 'No change yet'}
      </span>
      {/* Siblings of the pills, not a group of their own: a declared check
          reads the bar as focus ~ change pill ~ Changes. Where the work is
          built is the composer's "Build with" now (#3078), not a pill here. */}
      <button
        type="button"
        data-agent-session-changes-button
        className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        onClick={() => setDrawerOpen(true)}
        disabled={!session}
        aria-haspopup="dialog"
      >
        Changes · {count}
      </button>
      <OpenAppButton target={target} />
      {action}
      <SessionMenu session={session} />
    </div>
  );
}

/**
 * The session's own actions, the dev chat's ⋯: Rename, and Archive or
 * Unarchive. Nothing to act on while the conversation is unsent.
 */
function SessionMenu({ session }: { session: AgentSession | null }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      data-agent-session-menu
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      aria-label="Session actions"
      title="Session actions"
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
            { label: 'Rename…', handler: () => { void renameCurrentSession(); } },
            archived
              ? { label: 'Unarchive', title: 'Bring this session back to your lists', handler: () => { void unarchiveCurrentSession(); } }
              : {
                label: 'Archive',
                title: 'Hide this session from your lists and pause its change',
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
    void sendAgentMessage(`I joined ${join.name}. Please try "${card.title}" again.`);
  };
  return (
    <div className="mt-3 flex flex-col gap-2" data-agent-session-join={join.slug}>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Only members of {join.name} can do this. Join it, and the Mayor will try again.
      </p>
      {state === 'joined' ? (
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-600 dark:text-zinc-300" data-agent-session-joined="">
          <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> Joined. Asked the Mayor to try again.
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
            Join {join.name}
          </Button>
          {state === 'failed' ? <span className="text-sm text-red-700 dark:text-red-300">That did not work. Try again.</span> : null}
        </div>
      )}
    </div>
  );
}

function Card({ card, live = false }: { card: CardView; live?: boolean }) {
  const decidingId = useAgentSessionSelector((s) => s.deciding);
  const deciding = decidingId === card.id;
  const pending = card.status === 'pending';
  return (
    <section
      className={`agent-session-card mt-3 rounded-2xl border bg-white p-4 dark:bg-zinc-900 ${pending ? 'border-violet-300 dark:border-violet-800' : 'border-zinc-200 dark:border-zinc-800'}`}
      aria-label={`Confirm: ${card.title}`}
      data-agent-session-card={card.status}
    >
      {pending ? <p className="mb-1 text-xs font-semibold text-violet-700 dark:text-violet-300">Needs your OK</p> : null}
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
            Confirm
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
            Not now
          </Button>
        </div>
      ) : null}
      {live ? <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Waiting for the Mayor to finish…</p> : null}
      {card.status === 'running' ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300"><SpinnerArcIcon className="h-4 w-4 animate-spin" aria-hidden="true" /> Running…</p>
      ) : null}
      {card.status === 'done' ? (
        <p className="mt-3 inline-flex items-start gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Confirmed{card.outcome ? ` · ${card.outcome}` : ''}
        </p>
      ) : null}
      {card.status === 'failed' && card.join ? (
        <JoinToRetry card={card} join={card.join} />
      ) : card.status === 'failed' ? (
        <p className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">Did not go through{card.outcome ? `: ${card.outcome}` : '.'}</p>
      ) : null}
      {card.status === 'dismissed' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Dismissed. Nothing was changed.</p> : null}
      {card.status === 'expired' ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">This confirmation expired. Ask again for a fresh one.</p> : null}
    </section>
  );
}

/**
 * One row of the transcript. memo(): `buildTranscript` hands back the same
 * item objects until the messages or actions change, so a row whose item is
 * unchanged skips its render (and its markdown) when the panel re-renders.
 */
const Item = memo(function Item({ item, sessionId = null }: { item: TranscriptItem; sessionId?: number | null }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5" data-agent-session-user>
          <SentAttachments sessionId={sessionId} attachments={item.attachments} />
          {item.text ? (
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{item.text}</p>
          ) : null}
        </div>
      );
    case 'mayor':
      return (
        <article data-agent-session-mayor>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            Mayor
            {item.cost ? (
              <span className="font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-reply-cost>{` · ${item.cost}`}</span>
            ) : null}
          </p>
          {item.text ? <MayorText text={item.text} /> : null}
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
            Retry
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
      : duration ? { kind: 'fixed', label: `(took ${duration})` } : null,
    stamp: '',
    progress: running && turn.progress
      ? { current: turn.progress, steps: run.log.length, phase: '', estimate: '', countdownTo: null, cohortSince: null }
      : undefined,
    body: html
      ? { kind: 'md', html }
      : { kind: 'log', persistId: `agent-run-log-${run.key}`, text: run.output || logText || (running ? 'Starting…' : 'No output.') },
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
  const prNumber = item.prNumber || change?.prNumber || null;
  const heading = `${item.failed ? 'Staging build failed' : 'Staging deployed'}${prNumber ? ` · PR #${prNumber}` : ''}`;
  if (item.superseded) {
    return (
      <section className="rounded-2xl border border-zinc-200 px-3 py-2 dark:border-zinc-800" data-agent-session-preview="superseded">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{heading} · Superseded by a newer preview</p>
      </section>
    );
  }
  const checks = checksSummary(change?.checkState, change?.checkFailing, change?.checkSkipReason);
  const changeHref = change && change.appSlug && item.changeId != null
    ? `#app/${encodeURIComponent(change.appSlug)}/dev/proposals/${item.changeId}`
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
            {merged ? 'Merged' : 'In vote'}
          </span>
        ) : null}
        {checks ? (
          <button
            type="button"
            className={`ml-auto inline-flex items-center gap-1 rounded text-xs hover:underline ${CHECK_TONE[checks.key]}`}
            data-agent-session-checks={checks.key}
            title="See each check and its result"
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
              {action === 'retry' ? 'Retrying…' : 'Retry'}
            </button>
          ) : null
        ) : item.url && item.changeId != null ? (
          <button
            type="button"
            className={CARD_BUTTON}
            onClick={() => showPreview({ changeId: item.changeId as number, url: item.url as string, prNumber }, wide)}
            data-agent-session-preview-open
          >
            Open preview
          </button>
        ) : item.url ? (
          // A build no change owns has nothing to open the platform's preview
          // with (it is opened by change): its address, as it always was.
          <a className={CARD_BUTTON} href={item.url} target="_blank" rel="noopener noreferrer" data-agent-session-preview-open>
            Open preview
          </a>
        ) : null}
        {changeHref ? (
          <a className={CARD_BUTTON} href={changeHref} data-agent-session-preview-change>
            {inVote || merged ? 'View proposal' : 'Open draft proposal'}
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
            title="Rebuild the preview if needed and run the automated checks again, on the same commit"
            onClick={() => void recheckChange(item.changeId as number)}
            data-agent-session-preview-recheck
          >
            {action === 'recheck' ? 'Re-running…' : 'Re-run checks'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** A spec the scout drafted: the dev chat's spec card, opening the viewer over the conversation. */
export function SpecCard({ item }: { item: Extract<TranscriptItem, { kind: 'spec' }> }) {
  const snippet = useMemo(() => (item.preview ? markdown(item.preview, false) : null), [item.preview]);
  const snippetInner = useInnerHtml(snippet || '');
  const open = () => { if (item.changeId) void openSpec(item.changeId, item.version); };
  const title = `Spec${item.version ? ` v${item.version}` : ''}${item.lines ? ` · ${item.lines} lines` : ''}`;
  return (
    <div
      className="dc-spec-preview-card"
      data-agent-session-spec={item.version ?? 'latest'}
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
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
        <span className="dc-spec-preview-cta">View full spec →</span>
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
  if (!split) return <SpecMarkdown text={text} tagged />;
  const half = tab === 'tech' ? split.technical : split.userFacing;
  return (
    <>
      {split.preamble ? <div className="dc-spec-viewer-preamble"><SpecMarkdown text={split.preamble} /></div> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections">
        <SpecTabButton tab="user" active={tab} label="User-facing" onTab={onTab} />
        <SpecTabButton tab="tech" active={tab} label="Technical" onTab={onTab} />
      </div>
      <div role="tabpanel" data-agent-session-spec-half={tab}>
        {half ? <SpecMarkdown text={half} tagged /> : <p className="dc-spec-tab-empty">Nothing in this section.</p>}
      </div>
    </>
  );
}

function SpecContent({ sheet }: { sheet: SpecSheetState }) {
  const session = useAgentSessionSelector((s) => s.session);
  const split = useMemo(() => (sheet.text ? splitSpec(sheet.text) : null), [sheet.text]);
  const change = [session?.activeChange, ...(session?.changes || [])]
    .find((c) => c && c.id === sheet.changeId) || null;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">Spec</h2>
          {change ? <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.title || changeRef(change)}{change.appName ? ` · ${change.appName}` : ''}</p> : null}
        </div>
        {sheet.versions.length > 1 ? (
          <span className="dc-venue-detail-inline">
            <select
              className="dc-model-select rounded text-[13px] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-zinc-100"
              aria-label="Spec version"
              value={sheet.version ?? ''}
              onChange={(event) => void openSpec(sheet.changeId, Number(event.currentTarget.value))}
            >
              {sheet.versions.map((v) => <option key={v} value={v}>{`v${v}`}</option>)}
            </select>
            <ChevronDownIcon className="dc-model-caret" width={14} height={14} aria-hidden="true" />
          </span>
        ) : sheet.version ? <span className="text-xs font-semibold text-zinc-500">{`v${sheet.version}`}</span> : null}
        <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close" onClick={closeSpec}>
          <XIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {sheet.phase === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading…</div>
        ) : null}
        {sheet.phase === 'error' ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{sheet.error}</p> : null}
        {sheet.phase === 'ready' && !sheet.text ? <p className="text-sm text-zinc-500 dark:text-zinc-400">This change has no spec yet.</p> : null}
        {sheet.phase === 'ready' && sheet.text ? <SpecBody text={sheet.text} tab={sheet.tab} split={split} onTab={setSpecTab} /> : null}
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
        aria-label="Spec"
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
    <div role="tablist" aria-label="Side pane" className="flex shrink-0 gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
      {button('spec', 'Spec')}
      {button('preview', 'Preview')}
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
    // Dragging right narrows the pane: its left edge is the divider.
    const onMove = (move: PointerEvent) => { latest = commit(startWidth - (move.clientX - startX)); };
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
    writeSpecWidth(commit(width + (event.key === 'ArrowLeft' ? SPEC_WIDTH_STEP : -SPEC_WIDTH_STEP)));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={showing === 'preview' ? 'Resize the preview' : 'Resize the spec'}
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
        aria-label={showing === 'preview' ? 'Preview' : 'Spec'}
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
  if (!outbox.length) return null;
  const action = 'font-semibold hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline';
  return (
    <>
      {outbox.map((item) => (
        <div key={item.clientId} className="flex flex-col items-end gap-1" data-agent-session-outbox={item.status}>
          <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 ${item.status === 'sending' ? 'opacity-80' : ''}`}>{item.shown}</p>
          {item.status === 'failed' ? (
            <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[13px]" role="alert">
              <span className="text-red-700 dark:text-red-300" data-agent-session-outbox-error>{item.error || 'This was not sent.'}</span>
              {item.message || item.attachmentKeys.length ? (
                <button
                  type="button"
                  className={`${action} text-violet-700 dark:text-violet-300`}
                  disabled={busy}
                  title={busy ? 'The Mayor is still working. You can send this when it finishes' : 'Send this again'}
                  data-agent-session-outbox-retry
                  onClick={() => retryOutbox(item.clientId)}
                >
                  Retry
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
                  Edit
                </button>
              ) : null}
              <button
                type="button"
                className={`${action} text-zinc-500 dark:text-zinc-400`}
                data-agent-session-outbox-discard
                onClick={() => discardOutbox(item.clientId)}
              >
                Discard
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function LiveTurn({ runShown }: { runShown: boolean }) {
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
    ? 'Stopping…'
    : turn.phase === 'cc'
      ? (turn.progress || turn.activity || 'The coding agent is working')
      : (turn.activity || (turn.phase === 'mayor2' ? 'Wrapping up' : ''));
  return (
    <>
      {said || working ? (
        <article data-agent-session-live>
          <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Mayor</p>
          {turn.streamText ? <MayorText text={turn.streamText} /> : null}
          {cards.map((card) => <Card key={card.id} card={card} live />)}
          {working ? (
            <div
              className={`flex min-w-0 items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400 ${said ? 'mt-2' : ''}`}
              data-agent-session-activity={turn.phase || 'mayor'}
              aria-live="polite"
            >
              <TypingDots />
              {status ? <span className="min-w-0 truncate">{status}</span> : <span className="sr-only">The Mayor is thinking</span>}
              {turn.phase === 'cc' ? <span className="shrink-0 tabular-nums text-xs">{Math.floor(seconds / 60)}m {seconds % 60}s</span> : null}
            </div>
          ) : null}
        </article>
      ) : null}
    </>
  );
}

const CAPTURE_STEPS: Record<string, string> = {
  provisioning: 'Preparing the before and after builds',
  exploring: 'Finding the screens to capture',
  replaying: 'Replaying the flow on both builds',
  reviewing: 'Saving the captures',
};

/**
 * The active change's before/after shots while they are taken: after the
 * coding agent finished, Homeroom records before-and-after captures of the
 * proposal, and that is not the coding agent working. Stop ends it; the
 * proposal's Rerun starts it again.
 */
export function PreviewCapture({ change }: { change: AgentChange }) {
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
        <span className="font-medium text-zinc-700 dark:text-zinc-200">Capturing previews</span>
        {CAPTURE_STEPS[capture.state] ? ` · ${CAPTURE_STEPS[capture.state]}` : ''}
      </span>
      {seconds != null ? <span className="shrink-0 tabular-nums text-xs">{Math.floor(seconds / 60)}m {seconds % 60}s</span> : null}
      <Button
        type="button"
        data-agent-session-capture-stop
        variant="pillNeutral"
        size="xs"
        disabledStyle="dim"
        ink="neutral"
        className="ml-auto shrink-0 text-xs"
        disabled={stopping}
        onClick={() => void stop()}
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </Button>
    </div>
  );
}

function EmptyState({ about, request }: { about: About; request: DraftRequest | null }) {
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
        <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{`Request #${request.number}`}</h3>
        {request.title ? (
          <p className="mt-1 max-w-sm text-base font-medium text-zinc-800 dark:text-zinc-100" data-agent-session-request-title>{request.title}</p>
        ) : null}
        <p className="mt-2 max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
          {app ? <>On <strong>{app}</strong>. </> : null}
          Send the message below to start. The Mayor reads the request, plans the change with you, and puts it up for a vote when you say so.
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center" data-agent-session-empty>
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
        <SparklesIcon className="h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">New agent session</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
        {app ? <>Started from <strong>{app}</strong>. </> : null}
        Start a change on any app. The Mayor plans it, builds it, and puts it up for a vote when you say so.
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
  const first = context.proposalId ? ['Tell me about this proposal'] : [];
  return [
    ...first,
    app ? `What's open on ${app}?` : 'What could I work on?',
    'Add a feature',
    'Fix a bug',
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
    label: selected ? selected.label : 'Model',
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

const BUSY_PLACEHOLDER = 'The Mayor is working. Type your next message and save it for later.';
const SAVE_TITLE = 'Save this as a draft (Enter). It stays here until you send it';

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
  if (!drafts.length) return null;
  const button = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors '
    + 'hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent '
    + 'dark:text-zinc-400 dark:hover:bg-zinc-800';
  return (
    <section
      aria-label="Saved drafts"
      className="mb-2 max-h-40 overflow-y-auto rounded-2xl bg-zinc-100 p-1.5 dark:bg-zinc-800/70"
      data-agent-session-drafts={drafts.length}
    >
      <p className="flex flex-wrap items-baseline gap-x-1.5 px-2 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold uppercase tracking-wide">{`Saved drafts (${drafts.length})`}</span>
        <span>· on all your devices</span>
        {busy
          ? <span className="ml-auto">sending unlocks when the Mayor finishes</span>
          : <span className="ml-auto font-semibold text-violet-700 dark:text-violet-300" data-agent-session-drafts-ready>Ready to send</span>}
      </p>
      <ul className="flex flex-col gap-1">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            className="flex items-center gap-0.5 rounded-xl bg-white py-0.5 pl-3 pr-0.5 dark:bg-zinc-900"
            data-agent-session-draft={draft.id}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200" title={draft.text}>{draft.text}</span>
            <button
              type="button"
              className={`${button} hover:text-emerald-700 dark:hover:text-emerald-400`}
              aria-label="Send this draft"
              title={busy ? 'The Mayor is still working. You can send this when it finishes' : 'Send this draft now'}
              disabled={busy}
              data-agent-session-draft-send
              onClick={() => onSend(draft)}
            >
              <DraftSendIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-violet-700 dark:hover:text-violet-300`}
              aria-label="Edit this draft"
              title="Put this draft back in the box to edit"
              data-agent-session-draft-edit
              onClick={() => onEdit(draft)}
            >
              <DraftEditIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-red-700 dark:hover:text-red-300`}
              aria-label="Delete this draft"
              title="Delete this draft"
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
 * (Enter does the same) so nothing typed mid-turn can leak into the running
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
      <span className="min-w-0 flex-1">{turn.stopError || (slow ? 'Stopping is taking longer than expected.' : 'Stopping the agent…')}</span>
      {turn.stopError || slow ? (
        <Button type="button" variant="pillNeutral" ink="neutral" size="sm" disabledStyle="dim" disabled={turn.stopPending} onClick={() => onStop()}>Retry stop</Button>
      ) : null}
    </div>
  );
}

function Composer({ id }: { id: string }) {
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
  }));
  const [value, setValue] = useState('');
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
  // message (Global Chat, Explore), offers that first message when nothing
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
    ? 'This session is archived.'
    : running ? BUSY_PLACEHOLDER : 'Describe a change to any app in plain English. No coding needed.';

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

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = value.trim();
    if (running) {
      if (saveComposerDraft(text)) update('');
      return;
    }
    if (!text && !files.length) return;
    // Files still uploading hold the send: the button says so, and Enter waits too.
    if (uploading) return;
    update('');
    void sendAgentMessage(text);
  }

  // Pasted or dropped files join the tray (a pasted screenshot gets a name).
  const takeFiles = (list: FileList | null | undefined) => {
    const picked = Array.from(list || []);
    if (!picked.length) return false;
    addAttachments(picked.map((file, index) => (
      file.name && file.name !== 'image.png' ? file : new File([file], pastedName(file, index), { type: file.type })
    )));
    return true;
  };

  const onSendDraft = (draft: SavedDraft) => {
    if (running) return;
    const typed = value;
    update('');
    void sendSavedDraft(draft.id, typed);
  };
  const onEditDraft = (draft: SavedDraft) => {
    const text = editSavedDraft(draft.id, value);
    if (text == null) return;
    update(text);
    input.current?.focus();
  };

  const kind = saving ? 'save' : running ? 'stop' : 'send';
  return (
    // `platform-safe-bar` on the outer box: its padding clears the tab bar
    // (a phone keeps it up on this screen) and the home-indicator strip, so
    // the bordered field above it never sits under either.
    <div className="platform-safe-bar shrink-0 px-3 pt-1">
    {archived ? (
      <p className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" data-agent-session-archived>
        <span className="min-w-0 flex-1">This session is archived. Unarchive it to keep going.</span>
        <button type="button" className={CARD_BUTTON} onClick={() => void unarchiveCurrentSession()}>Unarchive</button>
      </p>
    ) : null}
    <SavedDrafts drafts={snapshot.drafts} busy={running} onSend={onSendDraft} onEdit={onEditDraft} />
    <StopStatus turn={snapshot} onStop={() => { void stopAgentTurn(); }} />
    <form
      className="agent-session-composer flex flex-col gap-2 rounded-[1.75rem] border border-zinc-200 bg-white px-3 pb-2.5 pt-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
      onSubmit={submit}
      onDragOver={(event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => {
        if (archived || !event.dataTransfer?.files?.length) return;
        event.preventDefault();
        takeFiles(event.dataTransfer.files);
      }}
    >
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
        // the Mayor works, Enter and the button keep this as a draft. It is
        // not sent, and nothing sends it on its own.
        <p className="px-2 text-[13px] text-zinc-600 dark:text-zinc-300" data-agent-session-save-note>
          The Mayor is still working, so this will be <span className="font-semibold">saved as a draft, not sent</span>. Send it from your drafts when it finishes.
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
        aria-label="Message the Mayor"
        className="agent-session-composer-input max-h-36 min-h-[2.5rem] w-full resize-none bg-transparent px-2 py-1.5 text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-400"
        onChange={(event) => update(event.target.value)}
        onPaste={(event) => {
          if (archived || !event.clipboardData?.files?.length) return;
          if (takeFiles(event.clipboardData.files)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {/* One picker, no menu of our own: a phone's own file picker already
            offers the photo library, the camera and files. */}
        <button
          ref={attach}
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-800 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
          aria-label="Attach photos or files"
          title="Attach photos or files"
          disabled={archived || snapshot.phase === 'loading'}
          data-agent-session-attach
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon className="h-5 w-5" aria-hidden="true" />
        </button>
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
            space and decides from it how much to say. */}
        {credit ? <CreditPill credit={credit} onOpen={() => openSheet('homeroom')} /> : <div className="min-w-0 flex-1" />}
        {kind === 'save' ? (
          <>
          <Button type="button" variant="pillDanger" ink="dangerTint" size="icon" className="inline-flex h-10 w-10 shrink-0 items-center justify-center" aria-label="Stop" title="Stop"
            disabled={snapshot.turnPhase === 'mayor2'} onClick={() => { void stopAgentTurn(); }}>
            <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
          </Button>
          <Button
            key="save"
            type="submit"
            data-agent-session-send="save"
            variant="unstyled"
            ink="solid"
            // Words, not a round button in Send's place: a green circle read
            // as Send, and the message went to the drafts instead.
            className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3.5 text-sm font-semibold hover:bg-emerald-700"
            aria-label="Save as draft"
            title={SAVE_TITLE}
          >
            <SaveDraftIcon width={18} height={18} aria-hidden="true" />
            <span>Save draft</span>
          </Button>
          </>
        ) : (
          <Button
            key="send"
            type={running ? 'button' : 'submit'}
            data-agent-session-send={kind}
            variant={running ? 'pillDanger' : 'pillAccent'}
            disabledStyle="dim"
            size="icon"
            ink={running ? 'dangerTint' : 'solid'}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center"
            disabled={running ? (snapshot.stopping || snapshot.turnPhase === 'mayor2') : (!sendable || uploading)}
            aria-label={running ? 'Stop' : uploading ? 'Send (waiting for files to upload)' : 'Send'}
            title={running
              ? (snapshot.turnPhase === 'mayor2' ? 'The wrap-up cannot be stopped' : 'Stop')
              : uploading ? 'Waiting for your files to upload' : 'Send'}
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
  const wide = useWideEnoughForSpec();
  const active = session.activeChange;
  const others = (session.changes || []).filter((change) => !active || change.id !== active.id);
  const closed = new Set(['merged', 'archived']);
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col justify-end bg-zinc-950/30 sm:items-end sm:justify-stretch"
      data-agent-session-drawer
      onClick={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}
    >
      <section
        role="dialog"
        aria-label="Changes in this session"
        className="platform-safe-bar max-h-[85%] w-full overflow-y-auto rounded-t-3xl bg-white p-4 shadow-xl dark:bg-zinc-900 sm:h-full sm:max-h-none sm:max-w-sm sm:rounded-none"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Changes in this session</h2>
          <button type="button" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close" onClick={() => setDrawerOpen(false)}>
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Active</h3>
        {active ? (
          <div className="rounded-2xl bg-zinc-50 p-3 dark:bg-zinc-800/60" data-agent-session-active-change>
            <div className="flex items-start gap-2">
              <AppMark name={active.appName} slug={active.appSlug} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-900 dark:text-zinc-100">{active.title || changeRef(active)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{active.appName || active.appSlug} · {changeRef(active)}{active.prNumber ? ` (change ${active.id})` : ''}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(active.status)}`}>{changeStatusLabel(active.status)}</span>
            </div>
            {active.checkState ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">Checks: {active.checkState}</p> : null}
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
                  Open preview
                </Button>
              ) : null}
              <button
                type="button"
                data-agent-session-open-spec
                className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                onClick={() => void openSpec(active.id)}
              >
                Spec
              </button>
              {active.appSlug ? (
                <a
                  className="rounded-full bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100"
                  href={`#app/${encodeURIComponent(active.appSlug)}/dev/proposals/${active.id}`}
                >
                  Proposal page
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No active change. Ask the Mayor to start one.</p>
        )}
        {others.length ? (
          <>
            <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Earlier in this session</h3>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {others.map((change) => (
                <li key={change.id} className="flex items-center gap-2 py-2" data-agent-session-earlier-change={change.id}>
                  <AppMark name={change.appName} slug={change.appSlug} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{change.title || changeRef(change)}</p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{change.appName || change.appSlug} · {changeRef(change)}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(change.status)}`}>{changeStatusLabel(change.status)}</span>
                  {!closed.has(change.status || '') ? (
                    <button type="button" className="shrink-0 text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300" onClick={() => void switchActiveChange(change.id)}>
                      Switch to
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
  const request = snapshot.draft ? draftRequest(snapshot.draft.hint) : null;

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
        <div ref={scroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite" onScroll={onScroll}>
          {snapshot.phase === 'loading' ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500"><SpinnerArcIcon className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading…</div>
          ) : null}
          {empty ? <EmptyState about={about} request={request} /> : null}
          {items.map((item) => <Item key={item.key} item={item} sessionId={snapshot.id} />)}
          <OutboxRows />
          <LiveTurn runShown={runShown} />
          <FollowOutput scroll={scroll} stick={stick} count={items.length} />
          {snapshot.session?.activeChange?.previewCapture ? <PreviewCapture change={snapshot.session.activeChange} /> : null}
          {snapshot.credits ? <CreditsCard refusal={snapshot.credits} /> : null}
          {snapshot.error ? (
            <p role="alert" className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{snapshot.error}</p>
          ) : null}
        </div>
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
  const snapshot = useAgentSessionPick((s) => ({ open: s.open, host: s.host }));
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'agent-session-screen', false);

  // A cold deep link can reveal this island before app.js has routed it;
  // resolve the address once after hydration, the way Global Chat does.
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
      aria-label="Agent session"
    >
      {snapshot.open && snapshot.host === 'screen' ? <AgentSessionPanel /> : null}
    </main>
  );
}

export { useAgentSessionState } from './store';
