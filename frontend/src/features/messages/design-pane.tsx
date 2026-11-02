/**
 * #6071: a design thread's pane (src/services/design-threads.js). Beside the
 * thread, from 768px in the conversation's place; on a phone it and the
 * thread take turns (`view`, the Preview and Chat switch).
 *
 * It draws the version shown in a sandboxed frame of the size it was
 * captured at, scaled to fit (../design/frame.ts says what the frame may
 * do), with a version picker; comments pinned on it; and Propose it, which
 * files the design as a request with its plan once the person has read what
 * becomes public.
 *
 * ── Pinned comments ───────────────────────────────────────────────────
 *
 * The Comment mode's pin (../comment-pin/), on the design: Comment turns the
 * frame's helper on, a click in the design drops a numbered pin there and
 * opens a box for the words, and Send posts them in the thread as the
 * person's message, carrying the pin (metadata.designPin), which the bot
 * reads with the element under it and answers with the next version. The
 * pins of the version shown are drawn on it, numbered in the order sent.
 *
 * Nothing loads in the first render: the design is read in an effect, so
 * the server's markup and the first client render agree.
 *
 * 1 Nov 2026 (threads, one loop C1): the chat with Homeroom bot is its tab's
 * alone, and so is this pane: any private thread there can hold a design, a
 * version said in it shows small with Open preview (./design-card.tsx), and
 * the pane opens as the tab's own column beside the thread
 * (../ai/preview.ts), at that version, with a way to close it (`onClose`):
 * × beside the thread, a back arrow where it is the whole screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { ChevronLeftIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { designFrameDoc, currentSheets, DESIGN_SANDBOX, type FramePin } from '../design/frame';
import { inlinePictures } from '../design/pictures';
import * as api from './api';
import type { DesignThread } from './api';
import { loadReplyThread, useMessagesSnapshot } from './store';
import type { DesignPin } from './types';

type View = 'preview' | 'chat';

interface Draft { x: number; y: number; element?: DesignPin['element'] }

const BUTTON = 'inline-flex items-center justify-center h-8 px-3 rounded-full text-[13px] font-semibold transition-colors disabled:opacity-50';
const QUIET = `${BUTTON} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800`;
const FILLED = `${BUTTON} bg-violet-600 text-white hover:bg-violet-500`;
// 1 Nov 2026: the column's × and back arrow, a disc of their own.
const ICON = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800';

// On a phone the preview and the thread take turns: which one is up, shared
// by the Messages screen (its layout's class) and the thread's header (the
// switch back), which are siblings.
let viewNow: View = 'preview';
const viewers = new Set<() => void>();
export function setDesignView(view: View): void {
  if (view === viewNow) return;
  viewNow = view;
  viewers.forEach((notify) => notify());
}
export function useDesignView(): View {
  return useSyncExternalStore(
    (notify) => { viewers.add(notify); return () => { viewers.delete(notify); }; },
    () => viewNow,
    () => 'preview',
  );
}

function key(): string {
  return `design-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type DesignMessage = { sender?: { bot?: boolean }; metadata?: { homeroomBot?: { kind?: string; designVersion?: number } | null } | null };

/** Whether a thread's first message is the bot's line that opened a design thread. */
export function isDesignRoot(root: DesignMessage | null | undefined): boolean {
  return !!root?.sender?.bot && root.metadata?.homeroomBot?.kind === 'opened_design';
}

/**
 * Pure (1 Nov 2026): whether a thread holds a design: its root opened one
 * from a capture, or the bot said a version anywhere in it (a "+" thread,
 * an idea, a thread about a request: any private thread can hold one).
 */
export function isDesignThread(root: DesignMessage | null | undefined, replies: readonly DesignMessage[] = []): boolean {
  return isDesignRoot(root) || replies.some((m) => !!m?.sender?.bot && Number(m.metadata?.homeroomBot?.designVersion) > 0);
}

export function DesignPane({ conversationId, rootId, view, onView, version = null, seq = 0, onClose, closeAs = 'close' }: {
  conversationId: number;
  rootId: number;
  view: View;
  onView: (view: View) => void;
  /** The version to show first (a card's Open preview); the newest when none. */
  version?: number | null;
  /** Each open's count, so the same version asked for again is shown again. */
  seq?: number;
  /** On the Homeroom bot tab: the pane is its own column, and this closes it. */
  onClose?: () => void;
  /** × beside the thread; a back arrow to it where the pane is the whole screen. */
  closeAs?: 'close' | 'back';
}): ReactNode {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const [design, setDesign] = useState<DesignThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<number | null>(version || null);
  const [html, setHtml] = useState<{ version: number; doc: string } | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [drawn, setDrawn] = useState(0);
  const [redraw, setRedraw] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const loads = useRef(0);
  const [fit, setFit] = useState(0);

  // The thread's messages, for the newest version said and the pins.
  const replies = snap.thread && snap.thread.rootId === rootId ? snap.thread.messages : [];
  const newestSaid = replies.reduce((n, m) => Math.max(n, Number(m.metadata?.homeroomBot?.designVersion) || 0), 0);

  const reload = useCallback(() => {
    api.getDesign(rootId).then((next) => { setDesign(next); setFailed(false); }, () => setFailed(true));
  }, [rootId]);
  useEffect(() => { reload(); }, [reload]);
  // A version the bot said that the pane has not read yet: read the thread again.
  useEffect(() => {
    if (design && newestSaid > design.latest) reload();
  }, [design, newestSaid, reload]);

  const shown = chosen && design && chosen <= design.latest ? chosen : design?.latest || 0;
  // A new version follows the newest, unless the person picked an older one.
  // 1 Nov 2026: a newer one than the pane last knew, not the first read, so
  // the version it was opened at stays shown.
  const knownLatest = useRef(0);
  useEffect(() => {
    const latest = design?.latest || 0;
    if (knownLatest.current && latest > knownLatest.current) setChosen(null);
    knownLatest.current = latest;
  }, [design?.latest]);
  // Opened again at a version (a card's Open preview): that one.
  useEffect(() => { if (version) setChosen(version); }, [version, seq]);

  useEffect(() => {
    if (!design || !shown) return;
    let live = true;
    // P8: the pictures it names, written in (../design/pictures.ts).
    api.getDesignVersion(rootId, shown).then(async (v) => ({ version: v.version, html: await inlinePictures(v.html) })).then((v) => {
      if (!live) return;
      const origin = window.location.origin;
      setHtml({ version: v.version, doc: designFrameDoc(v.html, { origin, sheets: design.surface === 'platform' ? currentSheets() : [] }) });
      loads.current = 0;
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [design, rootId, shown]);

  // The frame drawn at the captured size and scaled to the pane's width.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    // Its content box: the stage's own padding is no room for the frame.
    const measure = () => {
      const style = window.getComputedStyle(stage);
      setFit(Math.max(0, stage.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, [design?.rootId]);
  const scale = design && fit ? Math.min(1, fit / design.width) : 1;

  const pins = useMemo(() => {
    const out: Array<FramePin & { messageId: number }> = [];
    for (const m of replies) {
      const pin = m.metadata?.designPin;
      if (pin && pin.version === shown) out.push({ n: out.length + 1, x: pin.x, y: pin.y, messageId: m.id });
    }
    return out;
  }, [replies, shown]);

  const post = useCallback((message: Record<string, unknown>) => {
    try { frameRef.current?.contentWindow?.postMessage(message, '*'); } catch { /* the frame is gone */ }
  }, []);
  useEffect(() => {
    post({ __design: 'pins', pins: [...pins, ...(draft ? [{ n: pins.length + 1, x: draft.x, y: draft.y, open: true }] : [])] });
  }, [pins, draft, drawn, post]);
  useEffect(() => { post({ __design: 'mode', on: commenting && !draft }); }, [commenting, draft, drawn, post]);

  // A pin the frame placed: only the frame this pane drew is believed.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { __design?: string; x?: number; y?: number; element?: DesignPin['element'] } | null;
      if (!data || data.__design !== 'pin' || !commenting) return;
      const x = Number(data.x);
      const y = Number(data.y);
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return;
      setDraft({ x, y, ...(data.element && typeof data.element === 'object' ? { element: data.element } : {}) });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commenting]);

  // A design that navigated its own frame is drawn again: the frame shows
  // the version, never wherever a script sent it.
  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      loads.current = 0;
      setRedraw((n) => n + 1);
      return;
    }
    setDrawn((n) => n + 1);
  };

  const send = async () => {
    if (!draft || !note.trim() || sending || !shown) return;
    setSending(true);
    try {
      await api.sendMessage(conversationId, {
        content: note.trim(), threadRootId: rootId, idempotencyKey: key(),
        designPin: { version: shown, x: draft.x, y: draft.y, ...(draft.element ? { element: draft.element } : {}) },
      });
      setDraft(null);
      setNote('');
      setCommenting(false);
      void loadReplyThread(conversationId, rootId, true);
    } finally {
      setSending(false);
    }
  };

  if (failed && !design) {
    return (
      <section className="messages-design-pane" data-design-pane={rootId} aria-label={t('messages:design.pane.label')}>
        <p className="p-4 text-[13px] text-zinc-500">{t('messages:design.pane.failed')}</p>
        {onClose ? (
          <div className="px-4">
            <button type="button" className={QUIET} onClick={onClose} data-design-close={closeAs}>
              {closeAs === 'back' ? t('messages:design.pane.back') : t('messages:design.pane.close')}
            </button>
          </div>
        ) : null}
      </section>
    );
  }
  const open = design?.state === 'open';
  // 1 Nov 2026 (C2.2): a design posted as a plan may post again: the plan's next version.
  // A design for a project not made yet has nowhere to post: the bot's
  // Make the project card is its way out (bot-make.tsx).
  const postable = !!design?.app && (open || design?.state === 'posted' || design?.state === 'filed');
  const latest = design?.latest || 0;
  const what = draft?.element?.text || draft?.element?.tag || '';
  return (
    <section className="messages-design-pane" data-design-pane={rootId} data-design-view={view} aria-label={t('messages:design.pane.label')}>
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        {onClose && closeAs === 'back' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:design.pane.back')} title={t('messages:design.pane.back')} data-design-close="back">
            <ChevronLeftIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
        {/* At least 12rem wide, so on a phone the buttons wrap under it
            rather than squeezing it until the picker runs into them. */}
        <div className="min-w-[12rem] flex-1">
          <div className="truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{design?.title || t('messages:design.pane.loading')}</div>
          {design ? (
            <label className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px] text-zinc-500">
              <span className="sr-only">{t('messages:design.pane.pickVersion')}</span>
              <select
                className="min-w-0 max-w-[16rem] truncate bg-transparent text-[13px] text-zinc-600 dark:text-zinc-300"
                value={shown}
                onChange={(event) => { setChosen(Number(event.target.value)); setDraft(null); }}
                data-design-version=""
              >
                {design.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.note ? t('messages:design.pane.versionNote', { version: v.version, note: v.note }) : t('messages:design.pane.versionOption', { version: v.version })}
                  </option>
                ))}
              </select>
              <span className="shrink-0" aria-hidden="true">{t('messages:design.pane.ofTotal', { total: latest })}</span>
            </label>
          ) : null}
        </div>
        {onClose ? null : <button type="button" className={`${QUIET} messages-design-view-switch`} onClick={() => onView('chat')}>{t('messages:design.pane.showChat')}</button>}
        {open ? (
          <button type="button" className={commenting ? FILLED : QUIET} aria-pressed={commenting} onClick={() => { setCommenting((on) => !on); setDraft(null); }} data-design-comment="">
            {commenting ? t('messages:design.pane.commentDone') : t('messages:design.pane.comment')}
          </button>
        ) : null}
        {postable ? <button type="button" className={FILLED} onClick={() => setProposing(true)} disabled={!latest} data-design-propose="">{t('messages:design.pane.propose')}</button> : null}
        {onClose && closeAs === 'close' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:design.pane.close')} title={t('messages:design.pane.close')} data-design-close="close">
            <XIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {design && !open && design.number && design.app ? (
        <p className="px-4 pb-2 text-[13px] text-zinc-600 dark:text-zinc-300">
          <a className="font-semibold text-violet-700 dark:text-violet-300" href={`#app/${encodeURIComponent(design.app.slug)}/dev/issues/${design.number}`}>
            {design.state === 'posted' ? t('messages:design.pane.postedOn', { number: design.number }) : t('messages:design.pane.proposed', { number: design.number })}
          </a>
        </p>
      ) : null}
      {commenting && !draft ? <p className="px-4 pb-2 text-[13px] text-zinc-500">{t('messages:design.pane.commentHint')}</p> : null}
      {draft ? (
        <form className="mx-4 mb-2 flex flex-col gap-2 rounded-[20px] p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {what ? <div className="text-[13px] text-zinc-500">{t('messages:design.pane.pinOn', { what })}</div> : null}
          <textarea
            className="min-h-[64px] w-full resize-y rounded-xl bg-white p-2 text-[15px] text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
            value={note}
            maxLength={2000}
            placeholder={t('messages:design.pane.pinPlaceholder')}
            onChange={(event) => setNote(event.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={QUIET} onClick={() => { setDraft(null); setNote(''); }}>{t('messages:design.pane.pinCancel')}</button>
            <button type="submit" className={FILLED} disabled={!note.trim() || sending}>{t('messages:design.pane.pinSend')}</button>
          </div>
        </form>
      ) : null}
      {proposing && design ? (
        <ProposeCard design={design} version={shown} onClose={() => setProposing(false)} onDone={reload} />
      ) : null}
      <div ref={stageRef} className="messages-design-stage">
        {design && html ? (
          <div style={{ width: Math.round(design.width * scale), height: Math.round(design.height * scale) }} className="relative overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--app-sheet-line)]">
            <iframe
              ref={frameRef}
              key={`${html.version}-${redraw}`}
              title={t('messages:design.pane.frameTitle', { version: html.version })}
              sandbox={DESIGN_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={html.doc}
              onLoad={onLoad}
              style={{ width: design.width, height: design.height, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0, background: '#fff' }}
            />
          </div>
        ) : (
          <p className="p-4 text-[13px] text-zinc-500">{failed ? t('messages:design.pane.failed') : t('messages:design.pane.loading')}</p>
        )}
      </div>
    </section>
  );
}

/**
 * Propose it: what becomes public, said before it is; then the request it
 * filed. Also a compare card's Propose (./bot-cards/compare.tsx).
 */
export function ProposeCard({ design, version, onClose, onDone }: {
  design: DesignThread;
  version: number;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const t = useMessages('messages');
  const [title, setTitle] = useState(() => t('messages:design.propose.defaultTitle', { title: design.title }));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = design.app?.name || design.app?.slug || '';
  // C2.2: on the request the thread is about, it posts there as a plan.
  const on = design.planOn || null;
  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.proposeDesign(design.rootId, { version, title: title.trim(), notes: notes.trim() });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:design.propose.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mx-4 mb-3 flex flex-col gap-2 rounded-[20px] p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      data-design-propose-card=""
    >
      <div className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{on ? t('messages:design.propose.headingOn') : t('messages:design.propose.heading')}</div>
      <p className="text-[13px] text-zinc-600 dark:text-zinc-300" role="note">
        {on ? t('messages:design.propose.warningOn', { version, number: on, project }) : t('messages:design.propose.warning', { version, project })}
      </p>
      <label className="flex flex-col gap-1 text-[13px] text-zinc-500">
        {t('messages:design.propose.titleLabel')}
        <input className="h-9 rounded-xl bg-white px-2 text-[15px] text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-zinc-500">
        {t('messages:design.propose.notesLabel')}
        <textarea className="min-h-[64px] rounded-xl bg-white p-2 text-[15px] text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100" value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={QUIET} onClick={onClose}>{t('messages:design.propose.cancel')}</button>
        <button type="submit" className={FILLED} disabled={busy || !title.trim()}>{on ? t('messages:design.propose.sendOn') : t('messages:design.propose.send')}</button>
      </div>
    </form>
  );
}

/** The phone's way back to the preview from the thread beside it. */
export function DesignViewSwitch({ onView }: { onView: (view: View) => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <button type="button" className={`${QUIET} messages-design-view-switch`} onClick={() => onView('preview')}>
      {t('messages:design.pane.showPreview')}
    </button>
  );
}
