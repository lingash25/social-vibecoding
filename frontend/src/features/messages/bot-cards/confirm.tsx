// Homeroom bot parity, P7: the "confirm" card (see ./index.tsx).
//
// An admin asked Homeroom bot to change something with one of the admin
// tools (services/homeroom-bot-thread-tools/admin.js). Nothing ran: the
// exact input was sealed, and this card shows it plainly, row by row, with
// Confirm and Cancel. Only Confirm runs it, once, as the admin
// (services/homeroom-bot-cards/confirm.js), within 15 minutes; typing "yes"
// in the chat confirms nothing. Its outcome replaces the buttons on every
// device:
//
//   { tool, title, rows: [{ label, value }], state: 'pending' | 'done' |
//     'failed' | 'cancelled' | 'expired', expiresAt, result? }
//
// A secret an action returns (a test account's one-time password) comes back
// to the device that confirmed it alone, is shown here once, and is kept
// nowhere: the card's stored result says only that it was shown.

import { useEffect, useState } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { decideCard } from './index';
import type { BotCardProps } from './index';

export type ConfirmState = 'pending' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface ConfirmRow { label: string; value: string }

const STATES: readonly ConfirmState[] = ['pending', 'done', 'failed', 'cancelled', 'expired'];
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Pure: the card's rows, read defensively. */
export function confirmRows(card: Record<string, unknown>): ConfirmRow[] {
  const list = Array.isArray(card.rows) ? card.rows : [];
  return list.slice(0, 16)
    .map((raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null))
    .filter((row): row is Record<string, unknown> => !!row && !!str(row.label))
    .map((row) => ({ label: str(row.label), value: str(row.value) || String(row.value ?? '') }));
}

/** Pure: where the card stands at `now`: a pending card past its time has expired. */
export function confirmState(card: Record<string, unknown>, now = Date.now()): ConfirmState {
  const state = STATES.includes(card.state as ConfirmState) ? card.state as ConfirmState : 'pending';
  if (state !== 'pending') return state;
  const until = Date.parse(str(card.expiresAt));
  return Number.isFinite(until) && until <= now ? 'expired' : 'pending';
}

/** Re-render once when a pending card's time runs out. */
function useExpiry(expiresAt: string, pending: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending) return undefined;
    const until = Date.parse(expiresAt);
    if (!Number.isFinite(until)) return undefined;
    const wait = Math.max(0, Math.min(until - Date.now() + 250, 15 * 60 * 1000 + 1000));
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [expiresAt, pending]);
  return now;
}

interface Shown { state?: ConfirmState; result?: string; secret?: { label: string; value: string } | null }

export function ConfirmCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const fields = card as Record<string, unknown>;
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const expiresAt = str(fields.expiresAt);
  const now = useExpiry(expiresAt, fields.state === 'pending' && !shown?.state);
  const state = shown?.state || confirmState(fields, now);
  const rows = confirmRows(fields);
  const title = str(fields.title) || t('messages:botCards.confirm.untitled');
  const result = shown?.result || str(fields.result);

  async function tap(action: 'confirm' | 'cancel') {
    if (busy) return;
    setBusy(action);
    setError('');
    try {
      const out = await decideCard(message, action);
      const next = STATES.includes(out.state as ConfirmState) ? out.state as ConfirmState : undefined;
      const secret = out.secret && typeof out.secret === 'object' ? out.secret as Record<string, unknown> : null;
      setShown({
        state: next, result: str(out.result),
        secret: secret && str(secret.value) ? { label: str(secret.label), value: str(secret.value) } : null,
      });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.confirm.failedTap'));
    } finally {
      setBusy(null);
    }
  }

  const eyebrow = {
    pending: t('messages:botCards.confirm.eyebrowPending'),
    done: t('messages:botCards.confirm.eyebrowDone'),
    failed: t('messages:botCards.confirm.eyebrowFailed'),
    cancelled: t('messages:botCards.confirm.eyebrowCancelled'),
    expired: t('messages:botCards.confirm.eyebrowExpired'),
  }[state];

  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={t('messages:botCards.confirm.label', { title })}
      data-confirm-card={state}
    >
      <div className="min-w-0">
        <div className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400" data-confirm-eyebrow="">{eyebrow}</div>
        <div className="text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">{title}</div>
      </div>
      {rows.length ? (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem] leading-[1.125rem]">
          {rows.map((row, i) => (
            <div key={`${i}-${row.label}`} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-400">{row.label}</dt>
              <dd className="m-0 break-words text-zinc-800 dark:text-zinc-200">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {state === 'pending' ? (
        <>
          <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{t('messages:botCards.confirm.hint')}</p>
          <div className="messages-bot-answers" role="group" aria-label={title}>
            <button type="button" className="messages-bot-primary" disabled={!!busy} onClick={() => tap('confirm')} data-confirm-action="confirm">
              {busy === 'confirm' ? t('messages:botCards.confirm.running') : t('messages:botCards.confirm.confirm')}
            </button>
            <button type="button" className="messages-bot-secondary" disabled={!!busy} onClick={() => tap('cancel')} data-confirm-action="cancel">
              {t('messages:botCards.confirm.cancel')}
            </button>
          </div>
        </>
      ) : null}
      {state === 'expired' ? (
        <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{t('messages:botCards.confirm.expiredLine')}</p>
      ) : null}
      {state !== 'pending' && state !== 'expired' && result ? (
        <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-zinc-800 dark:text-zinc-200" role="status" data-confirm-result="">{result}</p>
      ) : null}
      {shown?.secret ? (
        <div className="flex flex-col gap-1 rounded-xl bg-[color:var(--dc-raised)] px-3 py-2" data-confirm-secret="">
          <span className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{shown.secret.label || t('messages:botCards.confirm.secretLabel')}</span>
          <code className="select-all break-all font-mono text-[0.9375rem] text-zinc-900 dark:text-zinc-100">{shown.secret.value}</code>
          <span className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{t('messages:botCards.confirm.secretNote')}</span>
        </div>
      ) : null}
      {error ? <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-[color:var(--state-blocked)]" role="alert">{error}</p> : null}
    </div>
  );
}
