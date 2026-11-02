// Homeroom bot parity, P2: the "table" card (see ./index.tsx), put under a
// reply by the bot's show_table (services/homeroom-bot-thread-tools/
// cards.js): two to four columns, up to twelve rows.
//
// The model's title as the card's title, the column headings small and
// muted, then a row each: its first cell is the row's name (15 at 650), the
// rest 13 and muted, and a row's one tag a small tinted label at its end
// (the blue accent for ready, amber for a question, grey for done and for
// stopped). A row about a request (the server linked it: a project this
// person can see, and its number) opens the request's page, as the bot's
// other cards do (../request-page.ts). "And 4 more" under it when the model
// left rows out, and up to three buttons that say their words as the person.
// On a phone the table scrolls sideways inside the card, never the page.
// The words are the model's, drawn as text.

import { useState, type MouseEvent } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { openRequestPage, requestPage } from '../request-page';
import type { BotCardProps } from './index';
import { sayAsMe } from './index';
import { CARD_BUTTON, CardShell, CardTitle, cardList, cardText } from './card-ui';

export type TableTag = 'ready' | 'question' | 'done' | 'stopped';

export interface TableRow {
  cells: string[];
  tag: TableTag | null;
  appSlug: string | null;
  appName: string | null;
  number: number | null;
}

export interface TableAction {
  label: string;
  say: string;
}

const TAGS: readonly TableTag[] = ['ready', 'question', 'done', 'stopped'];
const MAX_COLUMNS = 4;
const MAX_ROWS = 12;
const MAX_ACTIONS = 3;

/**
 * A tag's shape, and each tag's tint: the project cards' pill spelling
 * (features/apps/app-card.js), shape and tone apart. Whole literals
 * (Tailwind reads them from here).
 */
export const TAG_BASE = 'inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4';
export const TAG_TONES: Record<TableTag, string> = {
  ready: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
  question: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
  done: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  stopped: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
};

const TAG_WORDS: Record<TableTag, string> = {
  ready: 'messages:botCards.table.tag.ready',
  question: 'messages:botCards.table.tag.question',
  done: 'messages:botCards.table.tag.done',
  stopped: 'messages:botCards.table.tag.stopped',
};

/** Pure: a table card's columns, rows, how many more and its buttons, read defensively. */
export function tableOf(card: Record<string, unknown>): { columns: string[]; rows: TableRow[]; more: number; actions: TableAction[] } {
  const columns = cardList(card.columns).map((c) => cardText(c, 60)).filter(Boolean).slice(0, MAX_COLUMNS);
  const rows: TableRow[] = [];
  for (const raw of cardList(card.rows)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const cells = columns.map((_, i) => cardText(cardList(row.cells)[i], 200));
    if (!cells.some(Boolean)) continue;
    const tag = TAGS.includes(row.tag as TableTag) ? row.tag as TableTag : null;
    const slug = cardText(row.appSlug, 120);
    const number = Number(row.number);
    const linked = !!slug && Number.isSafeInteger(number) && number > 0;
    rows.push({
      cells, tag,
      appSlug: linked ? slug : null,
      appName: linked ? (cardText(row.appName, 120) || slug) : null,
      number: linked ? number : null,
    });
    if (rows.length === MAX_ROWS) break;
  }
  const moreRaw = Number(card.more);
  const more = Number.isSafeInteger(moreRaw) && moreRaw > 0 ? moreRaw : 0;
  const actions: TableAction[] = [];
  for (const raw of cardList(card.actions)) {
    if (!raw || typeof raw !== 'object') continue;
    const label = cardText((raw as Record<string, unknown>).label, 60);
    const say = cardText((raw as Record<string, unknown>).say, 400) || label;
    if (label) actions.push({ label, say });
    if (actions.length === MAX_ACTIONS) break;
  }
  return { columns, rows, more, actions };
}

/** A row's name, as a link to its request's page when it is about one. */
function RowName({ row, conversationId }: { row: TableRow; conversationId: number }) {
  const t = useMessages('messages');
  const name = row.cells[0];
  const page = row.appSlug && row.number
    ? requestPage({ appSlug: row.appSlug, appName: row.appName, issueNumber: row.number, title: name || null })
    : null;
  if (!page) return <>{name}</>;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    openRequestPage(page, conversationId);
  };
  return (
    <a
      href={`#${page.route}`}
      className="text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 dark:text-zinc-100 dark:decoration-zinc-600"
      title={t('messages:botCards.table.openRequest', { project: row.appName || row.appSlug || '', number: row.number || 0 })}
      data-bot-table-request={`${row.appSlug}#${row.number}`}
      onClick={open}
    >{name || t('messages:botCards.table.openRequest', { project: row.appName || row.appSlug || '', number: row.number || 0 })}</a>
  );
}

export function TableCard({ message, conversationId, card }: BotCardProps) {
  const t = useMessages('messages');
  const [saying, setSaying] = useState<string | null>(null);
  const { columns, rows, more, actions } = tableOf(card);
  if (columns.length < 2 || !rows.length) return null;
  const title = cardText(card.title, 120);
  const tagged = rows.some((row) => row.tag);

  function say(action: TableAction) {
    if (saying) return;
    setSaying(action.label);
    void sayAsMe(message, action.say).finally(() => setSaying(null));
  }

  return (
    <CardShell state="shown">
      {title ? <CardTitle>{title}</CardTitle> : null}
      <div className="-mx-4 mt-1 overflow-x-auto px-4">
        <table className="w-full min-w-[280px] border-collapse text-start">
          <thead>
            <tr>
              {columns.map((column, i) => (
                <th key={i} scope="col" className="whitespace-nowrap py-1.5 pe-3 text-[0.75rem] font-semibold leading-4 text-zinc-500 last:pe-0 dark:text-zinc-400">{column}</th>
              ))}
              {tagged ? <th scope="col" className="py-1.5"><span className="sr-only">{t('messages:botCards.table.tagHeading')}</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-t border-[color:var(--app-sheet-line)] align-top" data-bot-table-row={r + 1}>
                {row.cells.map((cell, i) => (
                  i === 0 ? (
                    <th key={i} scope="row" className="py-2 pe-3 text-[0.9375rem] font-[650] leading-5 text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">
                      <RowName row={row} conversationId={conversationId} />
                    </th>
                  ) : (
                    <td key={i} className="py-2 pe-3 text-[0.8125rem] leading-5 text-zinc-500 [overflow-wrap:anywhere] last:pe-0 dark:text-zinc-400">{cell}</td>
                  )
                ))}
                {tagged ? (
                  <td className="whitespace-nowrap py-2 text-end">
                    {row.tag ? <span className={`${TAG_BASE} ${TAG_TONES[row.tag]}`} data-bot-table-tag={row.tag}>{t(TAG_WORDS[row.tag])}</span> : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? <p className="mt-1.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-table-more="">{t('messages:botCards.table.more', { count: more })}</p> : null}
      {actions.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action, i) => (
            <button
              key={action.label}
              type="button"
              className={i === 0 ? CARD_BUTTON.tint : CARD_BUTTON.neutral}
              disabled={!!saying}
              onClick={() => say(action)}
              data-bot-table-action={i + 1}
            >{action.label}</button>
          ))}
        </div>
      ) : null}
    </CardShell>
  );
}
