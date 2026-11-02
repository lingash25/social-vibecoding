import type { ReactNode } from 'react';

/*
 * Homeroom bot parity, P2: what the options, question-set and table cards
 * share (./options.tsx, ./questions.tsx, ./table.tsx). The bot's other cards
 * are drawn the same way: the bubble's surface with one hairline, 20px
 * corners (./../bot-working.tsx), a small-caps label over it as a section
 * is labelled, a title inside it as a sentence, rows 15 over 13.
 *
 * Buttons are their own classes rather than `.messages-bot-answers button`:
 * app.css's rule there is more specific than any utility, and these are
 * 44px tall on a phone (36px from 640px, as the bot's other pills are).
 * One accent: the act is filled, a choice in the accent's tint, the rest
 * neutral. Every class is a whole literal.
 */

export const CARD_BUTTON = {
  primary: 'inline-flex min-h-[44px] max-w-full items-center justify-center gap-1.5 rounded-full bg-[color:var(--accent)] px-4 py-1.5 text-[0.8125rem] font-[650] leading-tight text-[color:var(--accent-ink)] hover:bg-[color:var(--accent-light)] disabled:cursor-default disabled:opacity-60 sm:min-h-[36px]',
  tint: 'inline-flex min-h-[44px] max-w-full items-center justify-center gap-1.5 rounded-full bg-[color:var(--accent-tint)] px-4 py-1.5 text-[0.8125rem] font-[650] leading-tight text-[color:var(--accent-tint-ink)] hover:brightness-[.97] disabled:cursor-default disabled:opacity-60 sm:min-h-[36px]',
  neutral: 'inline-flex min-h-[44px] max-w-full items-center justify-center gap-1.5 rounded-full bg-[color:var(--dc-raised)] px-4 py-1.5 text-[0.8125rem] font-[650] leading-tight text-[color:var(--text-secondary)] hover:brightness-[.97] disabled:cursor-default disabled:opacity-60 sm:min-h-[36px]',
} as const;

/**
 * The card's surface: the bubble's colour, one hairline, 20px corners. 520px
 * wide, or the row's width when that is less, so a card never pushes the
 * transcript sideways (its row is a column that shrinks to what it holds).
 */
export function CardShell({ children, state }: { children: ReactNode; state: string }) {
  return (
    <section
      className="mt-1 w-[520px] max-w-full rounded-[20px] bg-[color:var(--messages-surface)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]"
      data-bot-card-state={state}
    >
      {children}
    </section>
  );
}

/** The small-caps label over the card's content: 12px bold, tracked, muted. */
export function CardLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-[0.75rem] font-bold uppercase leading-4 tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{children}</h3>;
}

/** A title inside the card, in sentence case: the model's words, as text. */
export function CardTitle({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{children}</p>;
}

/** Pure: a card's field as a string the card shows, or '' (a card is read defensively: normalizeBotCard passes it as stored). */
export function cardText(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Pure: a card's field as a list, or []. */
export function cardList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
