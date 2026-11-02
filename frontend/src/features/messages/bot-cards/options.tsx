// Homeroom bot parity, P2: the "options" card (see ./index.tsx), put under a
// reply by the bot's offer_options (services/homeroom-bot-thread-tools/
// cards.js): 2 to 4 ways to do something, lettered A to D.
//
// One row per option: its letter's tile, its title (15 at 650) over its
// detail (13, muted), and under them Show and Pick. Show says "Show me
// option B: <title>" as the person, which leads the bot to show or draw it.
// Pick is decided on the server first (services/homeroom-bot-cards/
// options.js), so every device then says which was picked, and says
// "B: <title>" as the person. Once picked, the buttons go: the picked row
// says so in grey with a check (a settled thing gets no fill), the others
// step back. The words are the model's, drawn as text.

import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import type { BotCardProps } from './index';
import { decideCard, sayAsMe } from './index';
import { CARD_BUTTON, CardLabel, CardShell, CardTitle, cardList, cardText } from './card-ui';

export interface OptionRow {
  key: string;
  title: string;
  detail: string;
}

const KEYS = ['A', 'B', 'C', 'D'];

/** Pure: the options a card offers, read defensively: at most four, lettered as stored, each with a title. */
export function optionsOf(card: Record<string, unknown>): OptionRow[] {
  const out: OptionRow[] = [];
  for (const raw of cardList(card.options)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const key = cardText(row.key, 1).toUpperCase();
    const title = cardText(row.title, 120);
    if (!KEYS.includes(key) || !title || out.some((o) => o.key === key)) continue;
    out.push({ key, title, detail: cardText(row.detail, 400) });
    if (out.length === KEYS.length) break;
  }
  return out;
}

/** Pure: the option the card says was picked, or null. */
export function pickedOf(card: Record<string, unknown>, options: readonly OptionRow[]): string | null {
  const key = cardText(card.picked, 1).toUpperCase();
  return options.some((o) => o.key === key) ? key : null;
}

export function OptionsCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const [picking, setPicking] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const options = optionsOf(card);
  if (options.length < 2) return null;
  const title = cardText(card.title, 120);
  // A pick made here shows at once; the card's own update follows.
  const picked = pickedOf(card, options) || picking;

  async function pick(option: OptionRow) {
    if (picked) return;
    setPicking(option.key);
    setFailed(false);
    try {
      const out = await decideCard(message, 'pick', option.key);
      if (!out?.already) await sayAsMe(message, t('messages:botCards.options.pickSay', { key: option.key, title: option.title }));
    } catch {
      setPicking(null);
      setFailed(true);
    }
  }

  function show(option: OptionRow) {
    setFailed(false);
    void sayAsMe(message, t('messages:botCards.options.showSay', { key: option.key, title: option.title })).catch(() => setFailed(true));
  }

  return (
    <CardShell state={picked ? 'picked' : 'open'}>
      <CardLabel>{t('messages:botCards.options.label')}</CardLabel>
      {title ? <CardTitle>{title}</CardTitle> : null}
      <ul className="mt-1 divide-y divide-[color:var(--app-sheet-line)]">
        {options.map((option) => {
          const chosen = picked === option.key;
          return (
            <li
              key={option.key}
              className={picked && !chosen ? 'flex items-start gap-3 py-2.5 opacity-60' : 'flex items-start gap-3 py-2.5'}
              data-bot-option={option.key}
              data-bot-option-picked={chosen ? '' : undefined}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--dc-raised)] text-[0.8125rem] font-bold text-zinc-700 dark:text-zinc-200">
                {option.key}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">{option.title}</p>
                {option.detail ? <p className="mt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 [overflow-wrap:anywhere] dark:text-zinc-400">{option.detail}</p> : null}
                {!picked ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={CARD_BUTTON.neutral}
                      aria-label={t('messages:botCards.options.showNamed', { key: option.key, title: option.title })}
                      onClick={() => show(option)}
                    >{t('messages:botCards.options.show')}</button>
                    <button
                      type="button"
                      className={CARD_BUTTON.tint}
                      aria-label={t('messages:botCards.options.pickNamed', { key: option.key, title: option.title })}
                      onClick={() => void pick(option)}
                    >{t('messages:botCards.options.pick')}</button>
                  </div>
                ) : chosen ? (
                  <p className="mt-1 flex items-center gap-1 text-[0.8125rem] font-[650] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" role="status" data-bot-option-chosen="">
                    <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{t('messages:botCards.options.picked')}</span>
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {failed ? <p className="mt-2 text-[0.8125rem] text-red-700 dark:text-red-400" role="alert">{t('messages:botCards.failed')}</p> : null}
    </CardShell>
  );
}
