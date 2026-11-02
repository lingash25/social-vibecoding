import { useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import type { ConversationMessage, HomeroomBotLooked } from './types';

/*
 * Homeroom bot parity, P1: WHAT IT LOOKED AT. Above the words of a reply the
 * bot put together from lookups, one quiet line: "Looked at 5 things · 40 s"
 * (how many things it read, and how long the answer took), which opens to
 * the list ("Read Gym Tracker request #12", "Read 3 files in Gym Tracker").
 * The list is the reply's metadata `looked` (services/homeroom-bot-mayor.js
 * lookedMeta: { items: [{ what }], ms }), words the server wrote, drawn as
 * text. A reply that looked at nothing has no line: zero says nothing.
 *
 * 13px and muted, with a chevron: a detail to open, never the reply's lead.
 * It starts closed on every render, so a first render is the closed line.
 */

type Translate = (id: string, values?: Record<string, unknown>) => string;

/** The reply's `looked`, when it is a bot message that has one. */
export function lookedOf(message: ConversationMessage): HomeroomBotLooked | null {
  if (!message.sender.bot || message.deleted) return null;
  const looked = message.metadata?.homeroomBot?.looked;
  return looked && looked.items.length ? looked : null;
}

/** Pure: how long the answer took, as the line says it: "40 s", "2 min", or '' for no time. */
export function lookedTime(t: Translate, ms: number | null | undefined): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 1000) return '';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return t('messages:botCards.looked.seconds', { count: seconds });
  return t('messages:botCards.looked.minutes', { count: Math.round(seconds / 60) });
}

/** Pure: the line's words: "Looked at 5 things · 40 s". */
export function lookedSummary(t: Translate, looked: HomeroomBotLooked): string {
  const time = lookedTime(t, looked.ms);
  const count = looked.items.length;
  return time ? t('messages:botCards.looked.summary', { count, time }) : t('messages:botCards.looked.summaryNoTime', { count });
}

export function BotLookedLine({ message }: { message: ConversationMessage }) {
  const t = useMessages('messages');
  const [open, setOpen] = useState(false);
  const looked = lookedOf(message);
  if (!looked) return null;
  const listId = `messages-looked-${message.id}`;
  return (
    <div className="mb-1" data-bot-looked={looked.items.length}>
      <button
        type="button"
        className="-mx-1 -my-1.5 inline-flex min-h-[44px] items-center gap-1 rounded-md px-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 hover:text-zinc-700 sm:my-0 sm:min-h-[28px] dark:text-zinc-400 dark:hover:text-zinc-200"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        <span>{lookedSummary(t, looked)}</span>
        <ChevronDownIcon className={open ? 'h-3.5 w-3.5 shrink-0 rotate-180' : 'h-3.5 w-3.5 shrink-0'} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={listId} className="mb-1 mt-0.5 flex flex-col gap-0.5 ps-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" aria-label={t('messages:botCards.looked.list')}>
          {looked.items.map((item, i) => (
            <li key={i} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
              <span aria-hidden="true">·</span>
              <span>{item.what}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
