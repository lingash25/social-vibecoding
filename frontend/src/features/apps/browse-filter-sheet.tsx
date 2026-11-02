/**
 * The Filters sheet — Discover's type chips, Show only switches and Sort
 * order, behind the Filters button.
 *
 * The seam is the one features/home/add-apps-sheet.tsx uses: the kit owns the
 * sheet (PlatformUI.sheet), React owns what is in it, a legacy portal is
 * mounted on open and dropped on dismiss. From 768px the same panel is the
 * kit's centred dialog (PlatformUI.modal) instead: a sheet rising from the
 * bottom of a wide screen reads as a phone screen stretched. Nothing goes on `window`, because no
 * legacy caller opens it: the Filters button calls openBrowseFilterSheet
 * directly.
 *
 * The draft is a SNAPSHOT taken when the sheet opens, so a press changes the
 * sheet without repainting the list behind it. "Show N apps" applies it
 * (Browse.applyFilters, one render) and closes the sheet; ✕ or dismissing it
 * closes without changing anything. Reset clears the draft only.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { SectionHeader } from '@/components/ui/grouped-list';
import { CheckIcon, XIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../lib/i18n/react';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { browseStore } from './browse-store.js';

function browse(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

// The five orders, as the sheet's radio list.
//
// A COPY of Browse.SORTS rather than a read of it, and deliberately so:
// ./browse.js publishes itself on `window.Browse`, which does not exist in the
// SSG prerender pass. The controller stays the authority on what a key MEANS
// (resolveSort, the comparators); this is only the labelling.
// tests/browse-screen.test.js asserts the two lists never drift apart.
const SORT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'recommended', label: 'discover:sort.recommended' },
  { key: 'users', label: 'discover:sort.users' },
  { key: 'active', label: 'discover:sort.active' },
  { key: 'merged', label: 'discover:sort.merged' },
  { key: 'new', label: 'discover:sort.newest' },
];

// The Show only switches — Browse.SHOW_ONLY, labelled. A COPY for the reason
// SORT_OPTIONS is one: the controller is not on `window` in the SSG pass.
const SHOW_ONLY: Array<{ key: string; label: string }> = [
  { key: 'featured', label: 'discover:filter.featured' },
  { key: 'new', label: 'discover:filter.new' },
  { key: 'notjoined', label: 'discover:filters.hideJoined' },
];

interface Draft {
  only: string[];
  category: string;
  sort: string;
}

interface SheetProps {
  /** The Types the directory holds, from Browse.categoryOptions. */
  types: Array<{ key: string; label: string }>;
  /** The view the sheet was opened from; Joined hides "Hide apps I've joined". */
  view: string;
  /** The live filter state, copied into the draft when the sheet opens. */
  initial: Draft;
  /** Shown as a centred dialog, whose card carries its own padding. */
  dialog: boolean;
  onClose: () => void;
}

function BrowseFilterSheet({ types, view, initial, dialog, onClose }: SheetProps) {
  const t = useMessages('discover');
  const [draft, setDraft] = useState<Draft>(initial);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const toggleOnly = (key: string) => set({
    only: draft.only.includes(key)
      ? draft.only.filter((k) => k !== key)
      : draft.only.concat([key]),
  });

  // "Hide apps I've joined" is left out while Joined is showing: the two
  // together would always match nothing.
  const showOnly = SHOW_ONLY
    .filter((row) => !(row.key === 'notjoined' && view === 'joined'));

  // The count follows the draft AND the live search, so the button says how
  // many apps pressing it would show. `Browse` is absent only outside the
  // browser, where this sheet never mounts.
  const count = browse()?.countFor?.({ ...draft, view }) ?? 0;

  return (
    <div data-browse-filter-sheet="" data-dialog={dialog ? '' : undefined} className={dialog ? undefined : 'px-4 pb-5'}>
      {/* Reset · title · ✕, as the sheet's header row. Reset clears the DRAFT
          only; the list behind stays as it was until Show is pressed. */}
      <div className="grid grid-cols-3 items-center gap-2 pt-1">
        <button
          type="button"
          className="justify-self-start text-[15px] font-semibold text-[color:var(--accent)] hover:underline"
          onClick={() => setDraft({ only: [], category: 'all', sort: 'recommended' })}
        >
          {t('discover:filters.reset')}
        </button>
        <h2 id="browse-filters-title" className="justify-self-center text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">
          {t('discover:filters.title')}
        </h2>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center justify-self-end rounded-full bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          aria-label={t('discover:filters.close')}
          onClick={onClose}
        >
          <XIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {types.length ? (
        <>
          <SectionHeader className="px-0">{t('discover:filters.type')}</SectionHeader>
          <div role="group" aria-label={t('discover:filters.type')} className="flex flex-wrap gap-2">
            {types.map((c) => {
              const picked = draft.category === c.key;
              return (
                <Chip
                  key={c.key}
                  size="bar"
                  className={/* On the dialog's white card an unpicked chip's
                    own white would vanish: it takes a control's grey there. */
                    dialog && !picked
                    ? 'browse-category-chip px-4 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700'
                    : 'browse-category-chip px-4'}
                  selected={picked}
                  data-category={c.key}
                  onClick={() => set({ category: picked ? 'all' : c.key })}
                >
                  {picked ? <CheckIcon className="me-1.5 h-4 w-4" aria-hidden="true" /> : null}
                  {t(c.label)}
                </Chip>
              );
            })}
          </div>
        </>
      ) : null}

      {showOnly.length ? (
        <>
          <SectionHeader className="px-0">{t('discover:filters.showOnly')}</SectionHeader>
          <div>
            {showOnly.map((row) => (
              <label key={row.key} className="flex cursor-pointer items-center justify-between gap-3 py-2">
                <span className="text-[15px] text-zinc-900 dark:text-zinc-100">
                  {t(row.label)}
                </span>
                <Switch
                  className="shrink-0"
                  checked={draft.only.includes(row.key)}
                  onChange={() => toggleOnly(row.key)}
                  data-only={row.key}
                />
              </label>
            ))}
          </div>
        </>
      ) : null}

      <SectionHeader className="px-0">{t('discover:filters.sortBy')}</SectionHeader>
      <div role="radiogroup" aria-label={t('discover:filters.sortBy')}>
        {SORT_OPTIONS.map((o) => {
          const picked = draft.sort === o.key;
          return (
            <label key={o.key} className="flex cursor-pointer items-center justify-between gap-3 py-2">
              <span className="text-[15px] text-zinc-900 dark:text-zinc-100">{t(o.label)}</span>
              <input
                type="radio"
                name="browse-sort"
                value={o.key}
                checked={picked}
                onChange={() => set({ sort: o.key })}
                data-sort-option={o.key}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={picked
                  ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-violet-600'
                  : 'h-5 w-5 shrink-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600'}
              >
                {picked ? <span className="h-2.5 w-2.5 rounded-full bg-violet-600" /> : null}
              </span>
            </label>
          );
        })}
      </div>

      <div className="pt-4">
        <Button
          type="button"
          variant="pillAccent"
          layout="full"
          size="pillLg"
          disabledStyle="dim"
          disabled={count === 0}
          onClick={() => {
            if (count === 0) return;
            browse()?.applyFilters?.(draft);
            onClose();
          }}
        >
          {count === 0
            ? t('discover:filters.none')
            : t('discover:filters.show', { count })}
        </Button>
      </div>
    </div>
  );
}

type KitHandle = { dismiss: () => void; el?: HTMLElement } | null;
type SheetKit = {
  sheet?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => KitHandle;
  modal?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => KitHandle;
};

// A dialog from 768px, the shell's phone/desktop line; a sheet below it.
function wide(): boolean {
  try { return !!window.matchMedia && window.matchMedia('(min-width: 768px)').matches; } catch { return false; }
}

let openOnce: (() => void) | null = null;

/** Open the sheet, one at a time — a second tap while one is up is a no-op. */
export function openBrowseFilterSheet(): void {
  if (openOnce) return;
  const kit: SheetKit | null = (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
  if (!kit || typeof kit.sheet !== 'function' || typeof document === 'undefined') return;
  const controller = browse();
  if (!controller) return;
  const panel = document.createElement('div');
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    openOnce = null;
    unmountLegacyPortal(panel);
  };
  openOnce = finish;
  const dialog = wide() && typeof kit.modal === 'function';
  const handle = dialog
    ? kit.modal!({ contentEl: panel, onDismiss: finish })
    : kit.sheet({ contentEl: panel, onDismiss: finish });
  if (!handle) { finish(); return; }
  if (dialog && handle.el) {
    // The float box (app.css THE USABLE BOX) less the kit's 16px a side.
    handle.el.style.width = 'min(440px, calc(var(--platform-float-w) - 32px))';
    handle.el.setAttribute('aria-labelledby', 'browse-filters-title');
  }
  const leave = () => { finish(); handle?.dismiss(); };
  const state = browseStore.get() as any;
  mountLegacyPortal(panel, (
    <BrowseFilterSheet
      types={controller.categoryOptions?.() || []}
      view={state.view || 'foryou'}
      dialog={dialog}
      initial={{
        only: [...(state.only || [])],
        category: state.category || 'all',
        sort: state.sort || 'recommended',
      }}
      onClose={leave}
    />
  ));
}
