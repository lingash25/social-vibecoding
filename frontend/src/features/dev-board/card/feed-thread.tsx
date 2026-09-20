/**
 * The Activity feed's inline discussion: recent replies under a row, and a box
 * to add one without opening the row.
 *
 * ── What this replaces, and what it does not ───────────────────────────
 *
 * The feed already previewed comments, but only on ISSUE rows and only from
 * GitHub — `AppView._fillFeedComments` fetched the issue's GitHub thread and
 * wrote the last two into `.dev-feed-comments` by innerHTML. That preview is
 * untouched and still renders above this: it is the conversation happening on
 * the repository, and it is read-only here because it is read-only to us.
 *
 * This is the other conversation — the app's own thread for that item, the one
 * the topic page mounts under the card (`GroupChat.mountThread`). It is the
 * one a reply from the feed can actually land in, which is why the composer
 * belongs to it and not to the GitHub preview above. Both being visible is the
 * point: you see what has been said, and the box you type into is directly
 * under the messages it will join.
 *
 * ── Keyed by thread, loaded on sight ───────────────────────────────────
 *
 * State lives in ./feed-thread-store.ts, keyed `${type}:${ref}` rather than by
 * row — see that file for why. Loading waits for the row to come into view,
 * the same rule (and roughly the same 200px margin) the GitHub preview's
 * IntersectionObserver uses: a 20-row feed would otherwise open 20 requests on
 * paint to fill three lines each.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ArrowUpIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';

import { agoStamp } from '../../../lib/timestamp';
import { useAutoGrow } from '../../../lib/use-auto-grow';
import { useStoreState } from '../../../lib/use-store-state';
import { PostedViaChip, postedViaOf } from '../../group-chat/posted-via-chip';
import { swatchFor } from '../../messages/format';
import { ClampedComment } from '../comment-clamp';
import {
  feedThreadStore,
  patchThread,
  readThread,
  threadKey,
  type FeedThreadMessage,
} from './feed-thread-store';
import { FeedMentionMenu, useMentionTypeahead } from './mention-typeahead';
import { FeedRefMenu, useRefTypeahead } from './ref-typeahead';

/** Two, matching the GitHub preview's FEED_COMMENT_PREVIEW above it. */
const PREVIEW = 2;

/** Fetch a few more than are shown, so "N earlier" is right without a count query. */
const FETCH_LIMIT = 20;

function demoQS(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '&demo=1' : '';
  } catch {
    return '';
  }
}

// `relTime` lived here — the fifth copy of the ago ladder, and one that never
// degraded at all: a reply from March read "180d ago". It is `agoStamp` from
// lib/timestamp.ts now (#1808).

/**
 * Turn the chat endpoint's oldest-first rows into the compact human preview.
 *
 * The websocket command that creates a reply is named `chat`, but persisted
 * human rows use `msg_type: "message"`. Keep untyped legacy rows too; every
 * other kind is a system/event entry that the card itself already represents.
 */
export function feedThreadPreview(rows: any[]): {
  messages: FeedThreadMessage[];
  total: number;
} {
  const human = rows.filter((r: any) => !r.msg_type || r.msg_type === 'message');
  return {
    messages: human.slice(-PREVIEW).map((r: any) => ({
      id: r.id,
      author: r.username || 'someone',
      userId: r.user_id != null ? Number(r.user_id) : null,
      content: String(r.content || ''),
      createdAt: r.created_at,
      postedVia: postedViaOf(r.posted_via),
    })),
    total: human.length,
  };
}

/** Whether the signed-in viewer wrote this reply (App.user is app.js's). */
function isMine(m: FeedThreadMessage): boolean {
  const u = typeof window !== 'undefined' ? (window as any).App?.user : null;
  if (!u) return false;
  if (m.userId != null && u.id != null) return Number(u.id) === Number(m.userId);
  return !!u.username && u.username === m.author;
}

/**
 * One reply, as a BUBBLE — the Messages screen's row, at the feed's scale: a
 * 22px swatch avatar outside, a white r16 bubble with the name and the age
 * on its first line and the text under them, and the viewer's own replies in
 * the accent tint. They used to be three runs of 12px text lying directly on
 * the entry, which is where a reply and the card above it blurred together.
 */
export function MessageLine({ m }: { m: FeedThreadMessage }): ReactNode {
  const mine = isMine(m);
  const when = agoStamp(m.createdAt);
  return (
    <div
      className={mine ? 'dev-feed-msg dev-feed-msg-mine' : 'dev-feed-msg'}
      {...(m.postedVia ? { 'data-posted-via': m.postedVia } : {})}
    >
      <span className="dev-feed-msg-avatar" aria-hidden="true" style={{ backgroundColor: swatchFor(m.author) }}>
        {(m.author || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="dev-feed-msg-bubble">
        <div className="dev-feed-msg-head">
          <span className="dev-feed-msg-author">{m.author}</span>
          <PostedViaChip via={m.postedVia} />
          <time className="dev-feed-msg-time" dateTime={m.createdAt} title={when.title}>{when.text}</time>
        </div>
        {/* Plain text, never markdown and never innerHTML. This is the one
            surface in the feed that renders something a person typed, and it
            renders it as a text child so React escapes it — the topic page is
            where the full, formatted thread lives. `whitespace-pre-wrap` keeps
            the line breaks the multiline composer deliberately accepts.

            #2556: and four lines of them at a time. A reply pasted from
            somewhere else pushed the card below it off the screen, which is
            the opposite of what a preview is for. */}
        <ClampedComment
          className="dev-feed-msg-text whitespace-pre-wrap break-words"
          contentKey={m.content}
        >
          {m.content}
        </ClampedComment>
      </div>
    </div>
  );
}

/**
 * The compact composer each Activity row owns.
 *
 * It stays separate from FeedThread's loading/posting state so the two pieces
 * that make #1584 visible are executable in isolation: the controlled value
 * grows a textarea, and an always-present arrow sends it. Plain Enter is not
 * intercepted — it adds a line; submission belongs to the adjacent arrow and,
 * since #2145, to ⌘/Ctrl+Enter, the chord the dev chat, Close issue and Send
 * feedback already answer to.
 *
 * Typing `@` opens the people list (./mention-typeahead.tsx), and `PR#` or a
 * bare `#` the pull-request and issue list (./ref-typeahead.tsx): the group
 * chat's candidates and rows in both cases, as a sibling of the field inside
 * this form. A token under the caret is `@`-shaped or `#`-shaped and never
 * both, so both lists are asked on every event and at most one opens. While
 * one is open the arrows, Enter, Tab and Escape are its; otherwise every key
 * is the textarea's.
 */
export function FeedReplyComposer({
  slug, draft, posting, onDraftChange, onSubmit,
}: {
  slug: string;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
}): ReactNode {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);
  const mention = useMentionTypeahead({ slug, inputRef, value: draft, onChange: onDraftChange });
  const refs = useRefTypeahead({ slug, inputRef, value: draft, onChange: onDraftChange });
  // Fanned out rather than chosen between: which list a keystroke concerns is
  // the token's business, and each closes itself when the token is not its.
  const syncMenus = () => { mention.sync(); refs.sync(); };

  return (
    <form
      // `relative`: the suggestion list is positioned against this form.
      className="relative flex items-end gap-2 pt-0.5"
      onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
      // The row is inside #dev-body's delegated click handler, which opens
      // the topic for a click anywhere on a card. Every part of this composer
      // must stay in place while somebody writes a reply.
      onClick={(e) => e.stopPropagation()}
    >
      <Textarea
        ref={inputRef}
        rows={1}
        box="activityReply"
        width="flex"
        hint="muted"
        ring={false}
        className="focus:outline-none focus:ring-1 focus:ring-violet-500"
        placeholder="Reply…"
        aria-label="Reply to this item"
        value={draft}
        disabled={posting}
        onChange={(e) => { onDraftChange(e.target.value); syncMenus(); }}
        // The caret moving without the text changing (a click, an arrow) can
        // land on or leave a token just the same.
        onSelect={syncMenus}
        onFocus={() => { mention.warm(); refs.warm(); }}
        onBlur={() => { mention.close(); refs.close(); }}
        onCompositionStart={() => { mention.onCompositionStart(); refs.onCompositionStart(); }}
        onCompositionEnd={() => { mention.onCompositionEnd(); refs.onCompositionEnd(); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // An open suggestion list owns the arrows, Enter, Tab and Escape.
          if (mention.onKeyDown(e)) return;
          if (refs.onKeyDown(e)) return;
          if (!isSendChord(e)) return;
          // preventDefault is unconditional for the chord, including the
          // nothing-to-do case (#920): the keystroke must never leave a stray
          // newline in the box as its only visible effect.
          e.preventDefault();
          if (!posting && draft.trim()) void onSubmit();
        }}
      />
      {/* The dev session's send disc: a 36px filled accent circle with the
          up-arrow (app.css `.dev-feed-send`), so every "send" on the platform
          is the same object. */}
      <Button
        type="submit"
        variant="unstyled"
        disabledStyle="block"
        size="icon"
        ink="none"
        className="dev-feed-send shrink-0 un-touch-target inline-flex items-center justify-center"
        disabled={posting || !draft.trim()}
        title="Send reply"
        aria-label="Send reply"
      >
        {posting ? '…' : <ArrowUpIcon aria-hidden="true" />}
      </Button>
      <FeedMentionMenu
        items={mention.items}
        active={mention.active}
        below={mention.below}
        menuRef={mention.menuRef}
        onPick={mention.accept}
      />
      <FeedRefMenu
        items={refs.items}
        active={refs.active}
        below={refs.below}
        menuRef={refs.menuRef}
        onPick={refs.accept}
      />
    </form>
  );
}

/** ⌘/Ctrl+Enter sends; any other Enter is the textarea's (it adds a line). */
export function isSendChord(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey);
}

export function FeedThread({
  slug, type, refId, canPost,
}: {
  slug: string;
  type: string;
  refId: number;
  canPost: boolean;
}): ReactNode {
  const key = threadKey(type, refId);
  const all = useStoreState(feedThreadStore);
  const state = all[key] || readThread(key);
  const hostRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    if (readThread(key).loading) return;
    patchThread(key, { loading: true, error: null });
    try {
      const qs = `thread_type=${encodeURIComponent(type)}&thread_ref=${encodeURIComponent(String(refId))}`
        + `&limit=${FETCH_LIMIT}${demoQS()}`;
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.messages) ? data.messages : [];
      // `msg_type` carries system and agent entries into this stream too. The
      // preview is for what PEOPLE said — a build notice under a feed row is
      // noise, and the row's own card already says where the work has got to.
      const preview = feedThreadPreview(rows);
      patchThread(key, {
        messages: preview.messages,
        total: preview.total,
        loading: false,
        loaded: true,
      });
    } catch {
      // A thread that will not load is a quiet row, not an error banner: the
      // card above it is the thing the viewer came for.
      patchThread(key, { loading: false, loaded: true, error: 'load' });
    }
  }, [key, slug, type, refId]);

  // Load when the row is near the viewport, once. `rootMargin` matches the
  // GitHub preview's, so both halves of a row's comment area arrive together
  // rather than one scrolling in behind the other.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    if (readThread(key).loaded || readThread(key).loading) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      void load();
      return undefined;
    }
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        void load();
      }
    }, { rootMargin: '200px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [key, load]);

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (!content || readThread(key).posting) return;
    patchThread(key, { posting: true, error: null });
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, thread_type: type, thread_ref: refId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft('');
      patchThread(key, { posting: false });
      // Re-read rather than append what we sent: the server assigns the id and
      // the timestamp, and this is also what picks up anything else posted to
      // the thread while the box was open.
      await load();
    } catch {
      patchThread(key, { posting: false, error: 'post' });
    }
  }, [draft, key, slug, type, refId, load]);

  const hidden = state.total - state.messages.length;

  return (
    <div ref={hostRef} className="dev-feed-thread">
      {/* "N earlier replies" leads the thread — directly under the card,
          where the replies it stands for would be — then the bubbles, then
          the box. It used to sit under the bubbles, reading as a footer. */}
      {hidden > 0 ? (
        <div className="dev-feed-earlier text-xs text-zinc-400 dark:text-zinc-500">
          {`${hidden} earlier ${hidden === 1 ? 'reply' : 'replies'}`}
        </div>
      ) : null}
      {state.messages.map((m) => <MessageLine key={m.id} m={m} />)}
      {state.error === 'post' ? (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          That didn’t send. Try again, or open the item to reply there.
        </div>
      ) : null}
      {canPost ? (
        <FeedReplyComposer
          slug={slug}
          draft={draft}
          posting={state.posting}
          onDraftChange={setDraft}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}
