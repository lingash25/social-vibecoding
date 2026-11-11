import { SectionHeading, StatusLine } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { GrantsList } from '../grants-list';

/**
 * App AI permissions (issue #34). Lists every app the user has granted access
 * to their daily AI budget: today's spend vs the per-app cap, a cap editor,
 * the BYOK spillover toggle, and Revoke — and, on a revoked row, Re-enable
 * (#1957), so the way back does not depend on the app asking again.
 *
 * `#llm-grants-list` is React-owned end to end now (../grants-list.tsx).
 * Settings._renderLlmGrants() still does the fetching, on section open, from
 * GET /api/me/llm-grants (?demo=1 passthrough in staging) — it publishes a
 * view model rather than building rows. The host stays an EMPTY div at first
 * render, which is what the prerender emits and what hydration has to match.
 */
export function AppAiSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="app-ai" className="hidden">
      <div id="llm-grants-section">
        <SectionHeading title={t('settings:grants.title')} blurbClassName="dark:text-zinc-400">
          {t('settings:grants.intro')}
        </SectionHeading>
        <div id="llm-grants-list" className="space-y-2">
          <GrantsList />
        </div>
        <StatusLine id="llm-grants-status" />
      </div>
    </div>
  );
}
