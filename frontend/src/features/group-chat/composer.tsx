/**
 * The group chat composer — the staged-reply chip, the attachment error, the
 * pending-upload strip, the form, and the status line above it — as the only
 * React writer below all four, for BOTH composers.
 *
 * ── One renderer, because there was always one renderer ───────────────
 *
 * `_renderQuotePreview`, `_setAttachError`, `_renderAttachStrip` and the two
 * typing writers each began with `thread ? 'gc-thread-…' : 'gc-…'` and then
 * built one piece of markup. Splitting that into a thread component and a
 * general component would have been the first time these two controls could
 * disagree. They take a `scope` instead, which is the same ternary in the same
 * one place — see ./composer-store.ts for why the store has two slots.
 *
 * ── What each side still owns ─────────────────────────────────────────
 *
 * The BAR around this is the caller's: ./thread-shell.tsx pins its own to the
 * bottom of the thread panel, ./general-chat.tsx to the bottom of the chat
 * pane, and the two read-only notices are worded and placed differently
 * enough that sharing them would be a change rather than a de-duplication.
 * What is shared is everything between the bar's edges. The bar itself is
 * the chat foot's (@/components/ui/chat ChatComposerBar), the one Messages'
 * composer sits in, so its padding is decided in one place for both.
 *
 * The LISTENERS are still attached by the module, on the line after the mount:
 * submit, input, keydown, the paperclip, the paste and drag-and-drop wiring,
 * and both autocompletes. They are listeners on nodes — they write no markup —
 * which keeps one owner for the draft, the typing ping, the multi-line submit
 * semantics and the Escape-clears-reply rule.
 *
 * One of them writes an ATTRIBUTE and is fine: `_autoGrowTextarea` sets
 * `style.height` on the field after every keystroke, to grow it to its content
 * and cap it. Nothing here renders a `style` prop, so React never diffs that
 * attribute — the same tolerated overlap the inline message editor's
 * `display:none` runs under, and for the same reason.
 */

import { Button } from '@/components/ui/button';
import { ChatStatusLine } from '@/components/ui/chat';
import { ArrowUpIcon, PaperClipIcon, PlusIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';

import { DropOverlay } from '../attachments/file-drag';
import {
  PendingStrip,
  type PendingAttachmentView,
} from '../attachments/pending-strip';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import {
  composerStore,
  type ComposerScope,
  type ComposerSlot,
  type QuoteChipView,
} from './composer-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * The ids each scope's controls answer to.
 *
 * Every one of them is read back by public/js/group-chat.js or
 * public/js/app-view.js — `setupAttachments` finds the paperclip and the file
 * input, `mountThread` and `renderGroupChatTab` bind the form and the
 * textarea, and `dapp.json` selects on several. They are the contract, so they
 * are written out per scope rather than built by interpolation, which also
 * keeps them greppable.
 */
const IDS = {
  general: {
    preview: 'gc-reply-preview',
    error: 'gc-attach-error',
    strip: 'gc-attachments',
    form: 'gc-form',
    attach: 'gc-attach-btn',
    file: 'gc-file-input',
    input: 'gc-input',
    typing: 'gc-typing',
  },
  thread: {
    preview: 'gc-thread-reply-preview',
    error: 'gc-thread-attach-error',
    strip: 'gc-thread-attachments',
    form: 'gc-thread-form',
    attach: 'gc-thread-attach-btn',
    file: 'gc-thread-file-input',
    input: 'gc-thread-input',
    typing: 'gc-thread-typing',
  },
} as const;

export function useComposerSlot(scope: ComposerScope): ComposerSlot {
  return useStoreState(composerStore)[scope];
}

/**
 * "↩ Replying to @alice" over the quoted line (#15).
 *
 * `.gc-reply-preview-inner` is styled in app.css as the Messages screen's
 * reply draft (#2391): full width on the composer, accent tint, the same
 * accent border `.gc-quoted` — the block a sent reply carries — opens with,
 * so staging a reply still reads as what it is about to produce.
 */
function ReplyPreview({ scope, quote }: { scope: ComposerScope; quote: QuoteChipView | null }) {
  const t = useMessages('chat');
  return (
    <div id={IDS[scope].preview} className={quote ? '' : 'hidden'}>
      {quote ? (
        <div className="gc-reply-preview-inner">
          <div className="gc-reply-preview-body">
            <span className="gc-reply-preview-label">
              {quote.unnamed === 'event' ? t('chat:group.composer.replyingToPlatform')
                : quote.unnamed === 'message' ? t('chat:group.composer.replyingToMessage')
                  : quote.unnamed === 'system' ? t('chat:group.composer.replyingToSystem')
                    : quote.unnamed === 'someone' ? t('chat:group.composer.replyingToSomeone')
                  : quote.pr != null ? (quote.pr ? t('chat:group.composer.replyingToPr', { number: quote.pr }) : t('chat:group.composer.replyingToPrUnnumbered'))
                    : t('chat:group.composer.replyingTo', { name: quote.label })}
            </span>
            <span className="gc-reply-preview-snippet">{quote.snippet}</span>
          </div>
          <button
            type="button"
            id={scope === 'general' ? 'gc-reply-cancel' : undefined}
            className="gc-reply-preview-x"
            aria-label={t('chat:group.composer.cancelReply')}
            onClick={() => controller()?.clearQuote?.()}
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AttachError({ scope, text }: { scope: ComposerScope; text: string | null }) {
  return (
    <div id={IDS[scope].error} className={text ? 'dc-attach-error' : 'dc-attach-error hidden'}>
      {text}
    </div>
  );
}

/**
 * The pending-upload strip is ../attachments/pending-strip.tsx's — the dev
 * chat draws the same one, and always did (the comment on `#gc-attachments`
 * has said "reuses the dev-chat dc-attach-* styles" since #694). What stays
 * here is which host it goes in and how a row is removed: the live entry holds
 * a File and an object URL, so it never leaves group-chat.js and the row
 * reports its position instead.
 */
function AttachStrip({ scope, items }: { scope: ComposerScope; items: PendingAttachmentView[] }) {
  return (
    <PendingStrip
      id={IDS[scope].strip}
      items={items}
      onRemove={(index) => controller()?._removeAttachmentAt?.(index, scope)}
    />
  );
}

/**
 * The one-line slot under the messages — who is typing, or the reconnect
 * notice. `*View` is the pure half, which is what the tests render.
 *
 * It is the chat foot's status line (@/components/ui/chat ChatStatusLine),
 * so its size, colour and inset are the ones Messages' typing line has, and
 * it takes no room while it is empty (1 November 2026). The callers passed
 * their own Tailwind (`h-5` in the chat pane and the topic thread, `h-4` in
 * the boxed one, three different insets), which held the line open while it
 * said nothing and made each copy a little different.
 */
export function StatusLineView({ scope, status }: { scope: ComposerScope; status: string }) {
  return <ChatStatusLine id={IDS[scope].typing}>{status}</ChatStatusLine>;
}

export function StatusLine({ scope }: { scope: ComposerScope }) {
  return <StatusLineView scope={scope} status={useComposerSlot(scope).status} />;
}

/** The three module-fed rows above the form, in their shipped order. */
export function ComposerSlotsView({ scope, slot }: { scope: ComposerScope; slot: ComposerSlot }) {
  return (
    <>
      <ReplyPreview scope={scope} quote={slot.quote} />
      <AttachError scope={scope} text={slot.attachError} />
      <AttachStrip scope={scope} items={slot.attachments} />
    </>
  );
}

export function ComposerSlots({ scope }: { scope: ComposerScope }) {
  return <ComposerSlotsView scope={scope} slot={useComposerSlot(scope)} />;
}

export interface ComposerFormProps {
  scope: ComposerScope;
  /** The taller sizing: the general composer and the topic thread's. */
  fill: boolean;
  placeholder: string;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
  /**
   * #4453: a request's page is a Messages reply thread, so its composer is
   * Messages' own card: the + disc, the field, the round send. Same ids, so
   * the module's listeners and the attachment wiring find it unchanged.
   */
  messages?: boolean;
}

export function ComposerForm({ scope, fill, placeholder, maxLength, messages = false }: ComposerFormProps) {
  const t = useMessages('chat');
  const ids = IDS[scope];
  // #4065: the drop zone, while a file is held over this composer or its
  // messages. The module's tracker publishes the flag; it lies over the card,
  // and takes no pointer events, so the drop still lands on the form.
  const dragging = !!useComposerSlot(scope).dragging;
  const dropZone = dragging ? <DropOverlay /> : null;
  if (messages) {
    return (
      <form id={ids.form} className="messages-composer-card">
        <div className="flex items-end gap-1.5">
          <div className="messages-composer-add">
            <button type="button" id={ids.attach} className="messages-composer-action" aria-label={t('chat:group.composer.page.attachFiles')} title={t('chat:group.composer.page.attachFiles')}>
              <PlusIcon aria-hidden="true" />
            </button>
          </div>
          <input type="file" id={ids.file} className="hidden" multiple />
          <textarea
            id={ids.input}
            rows={1}
            maxLength={maxLength}
            autoComplete="off"
            placeholder={placeholder}
            aria-label={t('chat:group.composer.page.reply')}
            className="messages-composer-input"
          />
          {/* Keeps the field focused through the press, as Messages' Send does. */}
          <button type="submit" className="messages-send" aria-label={t('chat:group.composer.page.send')} title={t('chat:group.composer.page.send')} onMouseDown={(event) => event.preventDefault()}>
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </div>
        {dropZone}
      </form>
    );
  }
  // THE CARD. The two full-height composers — the Discussion's and a topic
  // thread's — are the same card Messages draws at the foot of its sheet: a
  // white surface with bare glyphs, a borderless field at reading size and
  // the round accent send disc. The boxed thread (`fill` false, inside a
  // board card) keeps its compact bordered row: it sits inside a card
  // already, and a card in a card is the thing the language avoids.
  if (fill) {
    return (
      <form id={ids.form} className="gc-composer-card flex items-end gap-1.5">
        <button
          type="button"
          id={ids.attach}
          title={t('chat:group.composer.attachFiles')}
          aria-label={t('chat:group.composer.attachFiles')}
          className="gc-composer-glyph shrink-0"
        >
          <PaperClipIcon aria-hidden="true" />
        </button>
        <input type="file" id={ids.file} className="hidden" multiple />
        <Textarea
          id={ids.input}
          maxLength={maxLength}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          lead="composer"
          width="flex"
          box="composerCard"
          hint="muted"
          ring="bare"
        />
        {/* A press on Send must not take focus from the field. The blur would
            drop the keyboard, the tab bar and the Resume strip would come back
            (lib/keyboard-open.ts), the composer would fall by the keyboard's
            height, and the click would land on nothing: the message stayed
            in the box (5 Oct 2026, the iOS app). Messages' Send does the same. */}
        <button
          type="submit"
          className="gc-send shrink-0"
          aria-label={t('chat:group.composer.send')}
          title={t('chat:group.composer.send')}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
        {dropZone}
      </form>
    );
  }
  return (
    <form id={ids.form} className="flex gap-2 items-end">
      <button
        type="button"
        id={ids.attach}
        title={t('chat:group.composer.attachFiles')}
        aria-label={t('chat:group.composer.attachFiles')}
        className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-500 hover:border-violet-500 transition-colors"
      >
        📎
      </button>
      <input type="file" id={ids.file} className="hidden" multiple />
      <Textarea
        id={ids.input}
        maxLength={maxLength}
        rows={1}
        autoComplete="off"
        placeholder={placeholder}
        lead="composer"
        width="flex"
        box="composerTight"
        hint="muted"
        ring="seamless"
      />
      {/* Keeps the field focused through the press, as the card's Send above. */}
      <Button type="submit" size="sm" className="shrink-0" onMouseDown={(event) => event.preventDefault()}>
        {t('chat:group.composer.send')}
      </Button>
      {dropZone}
    </form>
  );
}
