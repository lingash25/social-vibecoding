import { SectionHeading, StatusLine } from '@/components/ui/field';

import { AppPermissionsList } from '../app-permissions-list';
import { useMessages } from '../../../lib/i18n/react';

/**
 * App device permissions (#2219). Lists every app the user has let reach a
 * gated browser capability — location, microphone, camera, screen sharing, or
 * a USB / serial / input / Bluetooth / MIDI device — with Revoke, and
 * Re-enable on a revoked row.
 *
 * The one thing this copy must be honest about is WHEN a revoke bites. A
 * frame's Permissions Policy is computed from its `allow` attribute at
 * navigation and cannot be narrowed afterwards, so a running app keeps what
 * it already holds until it is reopened. Saying "takes effect immediately"
 * here, as the AI section truthfully can, would be wrong.
 *
 * `#app-permissions-list` is React-owned end to end (../app-permissions-list.tsx);
 * Settings._renderAppPermissions() does the fetching on section open and
 * publishes a view model. The host stays an EMPTY div at first render, which
 * is what the prerender emits and what hydration has to match.
 */
export function AppPermissionsSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="app-permissions" className="hidden">
      <div id="app-permissions-section">
        <SectionHeading title={t('settings:appPermissions.title')} blurbClassName="dark:text-zinc-400">
          {t('settings:appPermissions.intro')}
        </SectionHeading>
        <div id="app-permissions-list" className="space-y-2">
          <AppPermissionsList />
        </div>
        <StatusLine id="app-permissions-status" />
      </div>
    </div>
  );
}
