import type { RefObject } from 'react';

import { JumpToLatestButton, TranscriptOverlay } from '@/components/ui/chat';
import { useMessages } from '../../lib/i18n/react';
import { jumpLabel, useUnreadAffordances, type UnreadRow } from './unread-anchor';

/*
 * Jump to latest on its own, for a transcript drawn by somebody else or with
 * no "New" line of its own: a reply thread beside a conversation, and the
 * group chat's (a project's channel, a proposal's or a request's
 * discussion), whose rows and scrolling public/js/group-chat.js owns.
 * Rendered AFTER the scroller, as its sibling; it reads where the scroller
 * is and, on a tap, glides it to the bottom, where the owner's own scroll
 * listener takes the reader as following again. It writes nothing inside the
 * scroller.
 *
 * It floats over the transcript's foot, centred, with nothing behind it
 * (@/components/ui/chat TranscriptOverlay), on a change's or a request's page
 * as in a chat (1 Nov 2026). Those pages docked it in a thin strip of its own
 * between the scroller and the composer (#4553, centred there by #5702), so
 * it never covered their cards' buttons; the strip cut the transcript off
 * above it and read as a solid box behind the disc. The disc is up only
 * while the reader is up the transcript.
 *
 * The conversation itself (./index.tsx) draws the same button from the same
 * hook beside its banner.
 */

const NO_LINE: RefObject<HTMLElement | null> = { current: null };
const NO_ROWS: readonly UnreadRow[] = [];

export function JumpToLatest({ scroller, slack, rows = NO_ROWS }: {
  scroller: RefObject<HTMLElement | null>;
  /** The allowance the transcript follows new messages within. */
  slack?: number;
  /** The transcript's messages, oldest first, when the caller has them: the dot counts what arrives. */
  rows?: readonly UnreadRow[];
}) {
  const t = useMessages('messages');
  const { view, toLatest } = useUnreadAffordances(scroller, NO_LINE, {
    conversation: null, markKey: '', lineAt: null, rows, slack, watchContent: true,
  });
  return (
    <TranscriptOverlay edge="foot">
      <JumpToLatestButton shown={view.jump} dot={view.arrived > 0} aria-label={jumpLabel(view.arrived)} title={t('messages:thread.jumpToLatest')} onClick={toLatest} />
    </TranscriptOverlay>
  );
}
