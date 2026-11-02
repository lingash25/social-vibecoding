import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { StakingIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useStoreState } from '../../lib/use-store-state';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { walletSheetStore, WALLET_EMPTY, type WalletSheetState } from '../header/wallet-sheet-store';
import { createStakingHistory } from './staking-history.js';
import { requireAdult } from '../auth/adult-gate';
import { dirSign } from '../../lib/i18n/direction';

const controller = () => (window as any).WalletSheet;

export function StakingRow() {
  const t = useMessages('profile');
  const liveWallet = useStoreState(walletSheetStore);
  const [preview, setPreview] = useState<WalletSheetState | null>(null);
  useEffect(() => {
    const demo = new URLSearchParams(location.search).get('demo');
    if (demo !== 'staking-active' && demo !== 'staking-delegated') return;
    const abort = new AbortController();
    fetch(`/api/me/staking/demo?state=${demo === 'staking-delegated' ? 'delegated' : 'active'}`, {
      credentials: 'same-origin', signal: abort.signal,
    }).then(async (r) => {
      if (!r.ok) return;
      const data = await r.json();
      if (abort.signal.aborted) return;
      setPreview({ ...WALLET_EMPTY, visible: true, walletSupported: true, ...data });
      setOpen(true);
    }).catch(() => {});
    return () => abort.abort();
  }, []);
  const wallet = preview || liveWallet;
  const [open, setOpen] = useState(false);
  const visible = wallet.visible && wallet.staking.kind !== 'absent';
  const delegated = wallet.staking.kind === 'delegated';
  const ready = wallet.staking.kind === 'local' || delegated;
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  if (!visible) return null;
  return <>
    <button type="button" data-staking-row
      className="flex items-center gap-3 px-4 min-h-[44px] w-full text-start text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
      onClick={() => {
        // Staking is for adults (#5095): asked once before it opens. The
        // `?demo=staking-*` preview opens from its effect, without asking.
        if (preview) { setOpen(true); return; }
        void requireAdult().then((ok) => { if (ok) setOpen(true); });
      }}>
      <StakingIcon aria-hidden="true" className="w-5 h-5 shrink-0" />
      <span className="text-sm font-medium">{t('profile:staking.title')}</span>
      <span className={delegated ? 'ms-auto text-xs font-semibold text-violet-700 dark:text-violet-400'
        : ready ? 'ms-auto text-xs font-semibold text-emerald-700 dark:text-emerald-400'
          : 'ms-auto text-xs text-zinc-500 dark:text-zinc-400'}>{ready ? (delegated ? t('profile:staking.status.delegated') : t('profile:staking.status.active')) : t('profile:staking.status.checking')}</span>
      <span aria-hidden="true">›</span>
    </button>
    {open ? <StakingSheet preview={preview} onClose={() => setOpen(false)} /> : null}
  </>;
}

function StakingSheet({ onClose, preview }: { onClose: () => void; preview: WalletSheetState | null }) {
  const t = useMessages('profile');
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onClose); dismiss.current = onClose;
  const [adopted, setAdopted] = useState(false);
  const wallet = useStoreState(walletSheetStore);
  useIsomorphicLayoutEffect(() => {
    if (!panel.current) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'sheet', contentEl: panel.current, home: 'placeholder', gate: 'kit',
      onDismiss: () => { adoption = null; dismiss.current(); },
    });
    setAdopted(!!adoption);
    panel.current.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (adoption) adoption.release();
      previousFocus?.focus?.();
    };
  }, []);
  return <div className={adopted ? 'contents' : 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-3'}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} data-staking-sheet role="dialog" aria-modal="true" aria-label={t('profile:staking.title')}
      className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl p-4 flex-col max-h-[85dvh] overflow-y-auto"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) return;
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">{t('profile:staking.title')}</h2>
        <Button variant="neutral" size="sm" aria-label={t('profile:staking.close')} onClick={onClose}>×</Button>
      </div>
      <StakingContent wallet={preview || wallet} demo={!!preview} />
    </div>
  </div>;
}

// Delegated is an early return: no status card, explanatory copy, epoch hook
// or network request is mounted in that state.
export function StakingContent({ wallet, demo = false }: { wallet: WalletSheetState; demo?: boolean }) {
  const t = useMessages('profile');
  const manage = async () => {
    if (demo) { (window as any).PlatformUI?.toast?.(t('profile:staking.manageInApp')); return; }
    await controller()?._manageStaking?.();
    const error = walletSheetStore.get().stateError;
    if (error) (window as any).PlatformUI?.toast?.(error, { error: true });
  };
  if (wallet.staking.kind === 'delegated') return <Button layout="full" size="narrowBold"
    disabled={wallet.stakingPending} onClick={() => { void manage(); }}>
    {wallet.stakingPending ? t('profile:staking.opening') : t('profile:staking.undelegate')}
  </Button>;
  if (wallet.staking.kind !== 'local' || !wallet.address) return <div>
    <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('profile:staking.unavailable')}</p>
    <Button layout="full" size="narrowBold" className="mt-3" disabled={wallet.refreshPending}
      onClick={() => controller()?.retryState?.()}>{wallet.refreshPending ? t('profile:staking.rechecking') : t('core:common.retry')}</Button>
  </div>;
  return <>
    <div className="mb-4 text-sm font-semibold text-emerald-700 dark:text-emerald-400">{t('profile:staking.activeDot')}</div>
    <Button layout="full" size="narrowBold" disabled={wallet.stakingPending}
      onClick={() => { void manage(); }}>{wallet.stakingPending ? t('profile:staking.opening') : t('profile:staking.delegate')}</Button>
    <ActiveEpochs key={wallet.address} wallet={wallet.address} demo={demo} />
  </>;
}

async function readPreview(path: string, signal: AbortSignal) {
  const response = await fetch(path + (path.includes('?') ? '&' : '?') + 'demo=staking', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(translate('profile:staking.error.preview'));
  return response.json();
}

function ActiveEpochs({ wallet, demo }: { wallet: string; demo: boolean }) {
  const t = useMessages('profile');
  const [history] = useState(() => createStakingHistory(wallet, demo ? {
    read: readPreview,
    readEpoch: ({ epoch }: { epoch: string }, signal: AbortSignal) =>
      readPreview('/api/me/staking/epochs?epoch=' + encodeURIComponent(epoch), signal),
  } : {}));
  const state = useStoreState(history.store);
  useEffect(() => {
    void history.refresh();
    const refresh = () => { if (document.visibilityState !== 'hidden') void history.refresh(); };
    const timer = setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); history.dispose(); };
  }, [history]);
  if (state.selectedEpoch === null) return <div className="mt-5" role="status">
    <p className="text-sm text-zinc-500 dark:text-zinc-400">{state.error || t('profile:staking.epoch.loading')}</p>
    {state.error ? <Button className="mt-3" size="sm" onClick={() => { void history.refresh(); }}>{t('core:common.retry')}</Button> : null}
  </div>;
  return <div className="mt-5">
    <EpochCarousel state={state} select={(epoch: number) => { void history.select(epoch); }} retry={() => { void history.retry(); }} />
    {state.error ? <p role="status" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{state.error}</p> : null}
  </div>;
}

export function EpochCard({ epoch, record, current, error, retry }: any) {
  const t = useMessages('profile');
  return <section data-staking-epoch={epoch} className="rounded-2xl border border-zinc-200 dark:border-zinc-700 p-5 h-full">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-lg font-bold">{t('profile:staking.epoch.title', { epoch })}</h3>
      {current || record?.complete ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{current ? t('profile:staking.epoch.current') : t('profile:staking.epoch.completed')}</span> : null}
    </div>
    {record?.counts ? <>
      <div className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">{t('profile:staking.epoch.wonSlots')}</div>
      <div className="mt-1 text-4xl font-bold tabular-nums">{record.counts.won}</div>
      <div className="mt-5 pt-4 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-3 gap-2 text-center">
        {[
          ['profile:staking.epoch.upcoming', record.counts.upcoming, 'text-amber-700 dark:text-amber-300'],
          ['profile:staking.epoch.produced', record.counts.produced, 'text-emerald-700 dark:text-emerald-400'],
          ['profile:staking.epoch.missed', record.counts.missed, 'text-red-700 dark:text-red-400'],
        ].map(([label, count, color]) => <div key={label} className={color}>
          <div className="text-2xl font-bold tabular-nums">{count}</div><div className="mt-1 text-xs">{t(label)}</div>
        </div>)}
      </div>
      {record.counts.unobserved > 0 ? <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{t('profile:staking.epoch.unobserved')}</p> : null}
    </> : <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400" role="status">{error || (record ? t('profile:staking.epoch.collecting') : t('profile:staking.epoch.loading'))}</p>}
    {error ? <Button size="sm" className="mt-3" onClick={retry}>{t('core:common.retry')}</Button> : null}
  </section>;
}

export function EpochCarousel({ state, select, retry }: any) {
  const t = useMessages('profile');
  const rail = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const centering = useRef(false);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const epoch = state.selectedEpoch;
  const epochs = [epoch - 1, epoch, epoch + 1].filter((e) => e >= 0 && e <= state.currentEpoch);
  useIsomorphicLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    centering.current = true;
    // Negative from the start in a right-to-left scroller.
    el.scrollLeft = epochs.indexOf(epoch) * (el.clientWidth - 12) * dirSign();
    const frame = requestAnimationFrame(() => { centering.current = false; });
    return () => { cancelAnimationFrame(frame); clearTimeout(settle.current); };
  }, [epoch, state.currentEpoch]);
  function finishScroll() {
    const el = rail.current;
    if (!el || centering.current || drag.current) return;
    const index = Math.max(0, Math.min(epochs.length - 1, Math.round(Math.abs(el.scrollLeft) / (el.clientWidth - 12))));
    if (epochs[index] !== epoch) select(epochs[index]);
  }
  return <>
    <div ref={rail} data-staking-epochs aria-label={t('profile:staking.epoch.history')}
      className="flex gap-3 overflow-x-auto overscroll-x-contain snap-x snap-mandatory pb-2 select-none"
      style={{ scrollbarWidth: 'none', touchAction: 'pan-x' }}
      onScroll={() => { clearTimeout(settle.current); settle.current = setTimeout(finishScroll, 140); }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.style.scrollSnapType = 'none';
      }}
      onPointerMove={(event) => { if (drag.current) event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finishScroll(); event.currentTarget.style.scrollSnapType = '';
      }}
      onPointerCancel={(event) => { drag.current = null; event.currentTarget.style.scrollSnapType = ''; }}>
      {epochs.map((e) => <div key={e} className="shrink-0 snap-start" style={{ width: 'calc(100% - 24px)' }}>
        <EpochCard epoch={e} record={state.records[e]} current={e === state.currentEpoch} error={state.errors[e]} retry={retry} />
      </div>)}
    </div>
    <div className="flex items-center justify-between gap-2 mt-3">
      <Button variant="neutral" size="sm" aria-label={t('profile:staking.epoch.previous')} disabled={epoch === 0} onClick={() => select(epoch - 1)}>‹</Button>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('profile:staking.epoch.swipe')}</span>
      <Button variant="neutral" size="sm" aria-label={t('profile:staking.epoch.next')} disabled={epoch === state.currentEpoch} onClick={() => select(epoch + 1)}>›</Button>
    </div>
  </>;
}
