import { SectionHeading, StatusLine } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';

import { RichMessage, useMessages } from '../../../lib/i18n/react';

import { InterfaceModeControl } from '../interface-mode-control';

import { LocalAgentsList } from '../local-agents-list';

/**
 * Experimental: AI progress estimate (default OFF). When enabled, a small
 * Haiku call skims the in-flight Claude Code progress log about once a minute
 * and shows a vague "AI guess" plus a live countdown next to the timer on the
 * running line in dev-chat. #892: the model is now given the MEASURED
 * run-length distribution as prompt input (llm.js RUN_LENGTH_PRIORS) rather
 * than the old "bias toward 2-10 minutes" instruction that flattened its
 * output; nothing scales its answer afterwards. Server-gated per user;
 * settings.js wires the change handler to POST /api/me/ai-progress-estimate.
 *
 * #1281 Session bridge (default OFF) gates the `local` build venue. The spec
 * marks that venue settings-gated and "most users: no" — it is the only one
 * that wants software installed before it can do anything — so it is absent
 * from every venue list until this is on. Deployment support (cliAuthEnabled)
 * is still required on top; see VENUES in public/js/build-venues.js.
 *
 * #2779 Agent sessions used to have a switch here too. They are no longer
 * experimental: new work starts in one for everyone, so the switch is gone.
 *
 * #3624 Homeroom bot used to have a switch here too, while it was tried out
 * one person at a time. It works for everyone now, so the switch is gone.
 *
 * #4289 Comment on the page used to be a switch here too ("Press C to
 * comment on the page" until 13 Oct 2026, a name with no meaning on a
 * phone). Comment mode is no longer experimental: Suggest an improvement
 * opens it for everyone, with its form one switch away, so the switch is
 * gone. The setting itself stays on the DEVICE
 * (../../improve/suggest-settings.ts, localStorage), off only where a device
 * stored that.
 *
 * New Needs you used to be a switch here too. The review flow is what every
 * Needs you draws now, so there is nothing to turn on.
 *
 * New look (default OFF) is kept on the DEVICE as well. The head's
 * window.Skin (src/head.html) stores it and sets data-skin="brand" on <html>
 * before first paint; app.css draws the look from that attribute, in light
 * mode only. settings.js paints and saves the switch through window.Skin.
 * The look is "Baseplate" (request #6278): white cards on a light warm grey
 * plate, sun yellow for what needs you, ink for where you are.
 *
 * #907 Local coding agent lives in the same pane (not the CLI section) because
 * it is a preview of the same feature the dev chat's "Run on" selector
 * exposes, and because a lease is NOT a credential: revoking a CLI token is a
 * security action, detaching a machine is a routing one. Painted by
 * settings.js _renderLocalAgentsSection() from GET /api/me/local-agents; the
 * whole block hides itself when no machine has ever attached, so it costs
 * nothing for the overwhelming majority who never run the CLI.
 */
export function ExperimentalSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="experimental" className="hidden">
      <div id="settings-experimental-section">
        <SectionHeading title={t('settings:experimental.title')}>
          {t('settings:experimental.intro')}
        </SectionHeading>
        <InterfaceModeControl />
        <SwitchRow id="ai-progress-estimate">
          {t('settings:experimental.progressEstimate.label')}
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          {t('settings:experimental.progressEstimate.description')}
        </p>
        <StatusLine id="ai-progress-estimate-status" size="xs" />
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="session-bridge-enabled">
            {t('settings:experimental.sessionBridge.label')}
          </SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            <RichMessage
              id="settings:experimental.sessionBridge.description"
              components={[<span className="font-mono" />]}
            />
          </p>
          <StatusLine id="session-bridge-status" size="xs" />
        </div>
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="new-look-enabled">
            {t('settings:experimental.newLook.label')}
          </SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            {t('settings:experimental.newLook.description')}
          </p>
        </div>
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="glass-look-enabled">
            {t('settings:experimental.glassLook.label')}
          </SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            {t('settings:experimental.glassLook.description')}
          </p>
        </div>
      </div>
      <div id="settings-local-agents-section" className="hidden mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title={t('settings:experimental.localAgents.title')}>
          <RichMessage
            id="settings:experimental.localAgents.intro"
            values={{ command: 'social-vibecoding agent run' }}
            components={[<span className="font-mono" />]}
          />
        </SectionHeading>
        <div id="settings-local-agents-list" className="space-y-2">
          <LocalAgentsList />
        </div>
        <StatusLine id="settings-local-agents-status" size="xs" />
      </div>
    </div>
  );
}
