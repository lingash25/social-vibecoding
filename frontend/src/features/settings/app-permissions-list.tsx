/**
 * `#app-permissions-list` — the App device permissions rows (#2219).
 *
 * The sibling of ./grants-list.tsx, written the same way: the host is STATIC
 * in the React tree (sections/app-permissions.tsx), settings.js keeps every
 * fetch and every DELETE/POST, and the handlers are called BY NAME on
 * `window.Settings` because that module is a classic script this bundle
 * cannot import.
 *
 * Rows are grouped BY APP rather than listed flat. A grant is per capability,
 * so a flat list would repeat the same app name four times and bury the
 * question a person actually came here to answer, which is "what does this
 * app have?".
 */

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { appPermissionsStore } from './app-permissions-store.js';

type PermissionItem = { capability: string; label: string; revoked: boolean };
type PermissionAppView = {
  appId: number;
  appName: string;
  appSlug: string;
  items: PermissionItem[];
};
type AppPermissionsState = { phase: 'idle' | 'loading' | 'error' | 'ready'; apps: PermissionAppView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/** Matches ROW_CLASS in ./grants-list.tsx — one row language on this screen. */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

function CapabilityRow({ app, item }: { app: PermissionAppView; item: PermissionItem }) {
  const t = useMessages('settings');
  return (
    <div className="flex items-center gap-2 py-1">
      <span
        className={item.revoked
          ? 'min-w-0 flex-1 truncate text-zinc-400 line-through dark:text-zinc-500'
          : 'min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300'}
      >
        {item.label}
      </span>
      {item.revoked ? (
        // The way back, for the same reason grants-list.tsx grew one (#1957):
        // re-approving otherwise depends on the app asking again, and an app
        // that never asks again never opens the prompt. Same control as that
        // file's Re-enable, because the two sections sit next to each other.
        <Button
          type="button"
          data-role="re-enable"
          layout="shrink"
          variant="compact"
          size="xs"
          onClick={() => { void controller()?._onPermissionReenable?.(app.appId, app.appSlug, item.capability); }}
        >
          {t('settings:appPermissions.reEnable')}
        </Button>
      ) : (
        /*
            The red-tinted box from grants-list.tsx's Revoke, not an outlined
            Button: the language draws no outlined control (see the `neutral`
            variant in @/components/ui/button.tsx), and these rows render
            directly beside that section's.
        */
        <button
          type="button"
          data-role="revoke"
          className="rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
          onClick={() => { void controller()?._onPermissionRevoke?.(app.appId, item.capability); }}
        >
          {t('settings:appPermissions.revoke')}
        </button>
      )}
    </div>
  );
}

export function AppPermissionsList() {
  const t = useMessages('settings');
  const state = useStoreState<AppPermissionsState>(appPermissionsStore);
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('core:common.loading')}</p>;
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-red-700 dark:text-red-400">{t('settings:appPermissions.loadFailed')}</p>;
  }
  if (!state.apps.length) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {t('settings:appPermissions.empty')}
      </p>
    );
  }
  return (
    <>
      {state.apps.map((app) => (
        <div key={app.appId} className={ROW_CLASS}>
          <div className="font-medium text-zinc-900 mb-1 dark:text-zinc-100">{app.appName}</div>
          {app.items.map((item) => (
            <CapabilityRow key={item.capability} app={app} item={item} />
          ))}
        </div>
      ))}
    </>
  );
}
