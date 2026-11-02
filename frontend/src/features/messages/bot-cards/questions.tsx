// Homeroom bot parity, P2: the "questions" card (see ./index.tsx), put under
// a reply by the bot's ask_questions (services/homeroom-bot-thread-tools/
// cards.js): one to four questions answered together.
//
// Each question, numbered, with its suggested answers as chips (the one
// picked in the lit tint with a check; the bot's guess picked to begin with
// and marked "suggested", as the two-questions card marks its own,
// ../bot-plan.tsx BotTwoQuestions) and an Other field for an answer of
// one's own. Send answers is decided on the server first (services/
// homeroom-bot-cards/questions.js 'answer'), so every device shows the
// answers read-only, then says them as the person, one numbered line each.
// You decide does the same with 'skip', and says so. Answered, the card
// reads as the two-questions card does once answered (AnsweredChoices).
// The words are the model's, drawn as text.

import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { AnsweredChoices } from '../bot-plan-view';
import type { BotCardProps } from './index';
import { decideCard, sayAsMe } from './index';
import { CARD_BUTTON, CardLabel, CardShell, CardTitle, cardList, cardText } from './card-ui';

export interface QuestionRow {
  question: string;
  answers: string[];
  guess: number | null;
}

const MAX_QUESTIONS = 4;
const MAX_ANSWERS = 4;
const MAX_OWN_CHARS = 200;

const CHIP = 'inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-full bg-[color:var(--dc-raised)] px-[13px] py-1.5 text-start text-[0.8125rem] font-[650] leading-tight text-[color:var(--text-secondary)] hover:brightness-[.97] sm:min-h-[36px]';
const CHIP_ON = 'inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-full bg-[color:var(--lit-tint)] px-[13px] py-1.5 text-start text-[0.8125rem] font-[650] leading-tight text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--lit-line)] sm:min-h-[36px]';
const FIELD = 'mt-2 block min-h-[44px] w-full rounded-xl bg-[color:var(--dc-raised)] px-3 text-[0.9375rem] text-zinc-900 outline-none placeholder:text-zinc-500 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] dark:text-zinc-100 dark:placeholder:text-zinc-400 sm:min-h-[36px]';

/** Pure: a card's questions, read defensively: at most four, each with two to four answers. */
export function questionsOf(card: Record<string, unknown>): QuestionRow[] {
  const out: QuestionRow[] = [];
  for (const raw of cardList(card.questions)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const question = cardText(row.question, 240);
    const answers = cardList(row.answers).map((a) => cardText(a, 120)).filter(Boolean).slice(0, MAX_ANSWERS);
    if (!question || answers.length < 2) continue;
    const guess = Number(row.guess);
    out.push({ question, answers, guess: Number.isInteger(guess) && guess >= 0 && guess < answers.length ? guess : null });
    if (out.length === MAX_QUESTIONS) break;
  }
  return out;
}

/** Pure: the answers the card says were sent, one per question, or null. */
export function answeredOf(card: Record<string, unknown>, questions: readonly QuestionRow[]): string[] | null {
  const answered = cardList(card.answered).map((a) => cardText(a, MAX_OWN_CHARS));
  return answered.length === questions.length && answered.every(Boolean) ? answered : null;
}

/** A question's pick: one of its answers by index, or 'own' for the Other field. */
export type Pick = number | 'own' | null;

/** Pure: the answers to send, from the picks and the Other fields, or null while one is missing. */
export function chosenAnswers(questions: readonly QuestionRow[], picks: readonly Pick[], own: readonly string[]): string[] | null {
  const answers = questions.map((q, i) => {
    const pick = picks[i];
    if (pick === 'own') return String(own[i] || '').replace(/\s+/g, ' ').trim().slice(0, MAX_OWN_CHARS);
    return typeof pick === 'number' && q.answers[pick] ? q.answers[pick] : '';
  });
  return answers.every(Boolean) ? answers : null;
}

export function QuestionsCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const questions = questionsOf(card);
  const [picks, setPicks] = useState<Pick[]>(() => questions.map((q) => q.guess));
  const [own, setOwn] = useState<string[]>(() => questions.map(() => ''));
  const [sent, setSent] = useState<string[] | 'skipped' | null>(null);
  const [failed, setFailed] = useState(false);
  if (!questions.length) return null;
  const title = cardText(card.title, 120);
  const stored = answeredOf(card, questions);
  const skipped = card.skipped === true || sent === 'skipped';
  const answered = stored || (Array.isArray(sent) ? sent : null);
  const open = !answered && !skipped;
  const ready = chosenAnswers(questions, picks, own);

  async function send() {
    if (!ready || sent) return;
    setSent(ready);
    setFailed(false);
    try {
      const out = await decideCard(message, 'answer', ready);
      if (!out?.already) {
        await sayAsMe(message, ready.map((answer, i) => t('messages:botCards.questions.answerLine', { number: i + 1, answer })).join('\n'));
      }
    } catch {
      setSent(null);
      setFailed(true);
    }
  }

  async function leaveIt() {
    if (sent) return;
    setSent('skipped');
    setFailed(false);
    try {
      const out = await decideCard(message, 'skip');
      if (!out?.already) await sayAsMe(message, t('messages:botCards.questions.youDecideSay'));
    } catch {
      setSent(null);
      setFailed(true);
    }
  }

  return (
    <CardShell state={answered ? 'answered' : skipped ? 'skipped' : 'open'}>
      <CardLabel>{t('messages:botCards.questions.label')}</CardLabel>
      {title ? <CardTitle>{title}</CardTitle> : null}
      {open ? (
        <ol className="mt-2 flex list-decimal flex-col gap-3 ps-5 marker:text-[0.9375rem] marker:font-[650] marker:text-zinc-500">
          {questions.map((q, index) => (
            <li key={index} data-bot-question-row={index + 1}>
              <p className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">{q.question}</p>
              <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label={q.question}>
                {q.answers.map((answer, j) => {
                  const on = picks[index] === j;
                  return (
                    <button
                      key={j}
                      type="button"
                      className={on ? CHIP_ON : CHIP}
                      aria-pressed={on}
                      data-bot-question-answer={j === q.guess ? 'guess' : 'other'}
                      onClick={() => setPicks((now) => now.map((p, i) => (i === index ? j : p)))}
                    >
                      {on ? <CheckIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
                      <span className="[overflow-wrap:anywhere]">{answer}</span>
                      {j === q.guess ? <span className="text-[0.6875rem] font-semibold opacity-70">{t('messages:bot.questions.suggested')}</span> : null}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                className={FIELD}
                value={own[index] || ''}
                maxLength={MAX_OWN_CHARS}
                placeholder={t('messages:botCards.questions.other')}
                aria-label={t('messages:botCards.questions.otherNamed', { number: index + 1 })}
                data-bot-question-own={index + 1}
                onChange={(event) => {
                  const value = event.target.value;
                  setOwn((now) => now.map((v, i) => (i === index ? value : v)));
                  setPicks((now) => now.map((p, i) => (i === index ? (value.trim() ? 'own' : q.guess) : p)));
                }}
              />
            </li>
          ))}
        </ol>
      ) : answered ? (
        <AnsweredChoices items={questions.map((q, i) => ({ question: q.question, answer: answered[i] }))} className="mt-2" />
      ) : (
        <p className="mt-1.5 flex items-center gap-1 text-[0.8125rem] font-[650] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" role="status" data-bot-questions-skipped="">
          <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('messages:botCards.questions.skipped')}</span>
        </p>
      )}
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={CARD_BUTTON.primary} disabled={!ready || !!sent} onClick={() => void send()} data-bot-questions-send="">
            {t('messages:botCards.questions.send')}
          </button>
          <button type="button" className={CARD_BUTTON.neutral} disabled={!!sent} onClick={() => void leaveIt()} data-bot-questions-skip="">
            {t('messages:botCards.questions.youDecide')}
          </button>
        </div>
      ) : null}
      {failed ? <p className="mt-2 text-[0.8125rem] text-red-700 dark:text-red-400" role="alert">{t('messages:botCards.failed')}</p> : null}
    </CardShell>
  );
}
