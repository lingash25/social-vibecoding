// BuildLog — the "View build log" panel for failed app deploys (#416).
//
// Shared by the home-card "…" menu and the app-tab error screen so the
// two entry points render the identical panel. Always fetches fresh
// detail from GET /api/apps/:slug on open: the `lastFailure` field only
// rides that payload for the app's creator / collaborators / admins
// (the server strips it for everyone else), so authorization lives
// server-side — this panel just renders what it's given, or an honest
// "no detail recorded" fallback.
//
// `lastFailure` shape: { stage, reason, log, at, sha } — see
// src/services/deploy-failure.js.
const BuildLog = {
  _el: null,
  _keyHandler: null,

  // Human labels for the pipeline step that failed.
  stageLabel(stage) {
    switch (stage) {
      case 'clone': return PlatformI18n.t('session:buildLog.stage.clone');
      case 'build': return PlatformI18n.t('session:buildLog.stage.build');
      case 'start': return PlatformI18n.t('session:buildLog.stage.start');
      case 'healthcheck': return PlatformI18n.t('session:buildLog.stage.healthcheck');
      case 'timeout': return PlatformI18n.t('session:buildLog.stage.timeout');
      default: return PlatformI18n.t('session:buildLog.stage.other');
    }
  },

  async open(slug) {
    BuildLog.close();
    let app = null;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
      if (res.ok) app = (await res.json()).app || null;
    } catch {
      // Render the panel anyway — the empty state explains itself.
    }
    BuildLog._render(slug, app);
  },

  _render(slug, app) {
    const failure = app && app.lastFailure && typeof app.lastFailure === 'object'
      ? app.lastFailure : null;
    const canRetry = !!(app && app.status === 'error'
      && (window.App?.user?.canAdminWrite || window.App?.user?.id === app.created_by));

    let bodyHtml;
    if (!failure) {
      bodyHtml = `
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          ${PlatformI18n.htmlText('session:buildLog.empty')}
        </p>`;
    } else {
      const when = failure.at ? new Date(failure.at) : null;
      const whenAbs = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null;
      const whenRel = whenAbs ? blRelTime(failure.at) : null;
      const metaBits = [];
      // Each line is one message: its label in <0>, its value a parameter.
      const metaLabel = (inner) => `<span class="font-medium text-zinc-700 dark:text-zinc-200">${inner}</span>`;
      metaBits.push(PlatformI18n.htmlRich('session:buildLog.meta.failedStep',
        { step: BuildLog.stageLabel(failure.stage) }, [metaLabel]));
      if (whenAbs) {
        metaBits.push(whenRel
          ? PlatformI18n.htmlRich('session:buildLog.meta.whenRelative', { relative: whenRel, date: whenAbs }, [metaLabel])
          : PlatformI18n.htmlRich('session:buildLog.meta.when', { date: whenAbs }, [metaLabel]));
      }
      if (failure.sha) {
        metaBits.push(PlatformI18n.htmlRich('session:buildLog.meta.commit',
          { sha: String(failure.sha).slice(0, 7) },
          [metaLabel, (inner) => `<span class="font-mono">${inner}</span>`]));
      }
      const logText = String(failure.log || '').trim();
      bodyHtml = `
        <div class="text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
          ${metaBits.map((m) => `<div>${m}</div>`).join('')}
        </div>
        <p class="mt-2 text-sm font-mono text-red-700 break-words dark:text-red-400">${blEscape(String(failure.reason || '').slice(0, 280))}</p>
        ${logText
          ? `<pre id="build-log-pre" class="mt-3 max-h-72 overflow-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3 text-[0.7rem] leading-relaxed font-mono whitespace-pre-wrap break-words select-text text-zinc-700 dark:text-zinc-300">${blEscape(logText)}</pre>`
          : `<p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">${PlatformI18n.htmlText('session:buildLog.noLog')}</p>`}
      `;
    }

    const overlay = document.createElement('div');
    overlay.id = 'build-log-overlay';
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4';
    overlay.innerHTML = `
      <div class="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col max-h-[85vh]">
        <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-zinc-800 dark:text-zinc-100 truncate">${PlatformI18n.htmlText('session:buildLog.title')}</h2>
            <p class="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate">${blEscape(slug)}</p>
          </div>
          <button id="build-log-close" class="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-500/10" aria-label="${PlatformI18n.htmlText('core:common.close')}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="px-4 py-3 overflow-y-auto">${bodyHtml}</div>
        <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          ${failure && String(failure.log || '').trim()
            ? `<button id="build-log-copy" class="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-500/10">${PlatformI18n.htmlText('session:buildLog.copy')}</button>`
            : ''}
          ${canRetry
            ? `<button id="build-log-retry" class="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">${PlatformI18n.htmlText('session:buildLog.retry')}</button>`
            : ''}
        </div>
      </div>`;

    const panel = overlay.firstElementChild;
    if (PlatformUI.hasKit()) {
      // Kit path: the card presents with the kit's modal motion —
      // fade + scale-settle, backdrop tap / Escape dismiss. The
      // hand-rolled overlay wrapper is never mounted. The kit shell
      // draws the card chrome, so the panel's own is neutralized
      // (platform-modal-card) and the shell hugs the panel's width.
      panel.classList.add('platform-modal-card');
      BuildLog._modal = PlatformUI.modal({
        contentEl: panel,
        onDismiss: () => {
          if (BuildLog._modal) {
            BuildLog._modal = null;
            BuildLog.close();
          }
        },
      });
      if (BuildLog._modal && BuildLog._modal.el) {
        // The float box (app.css THE USABLE BOX) less the kit's 16px a side.
        BuildLog._modal.el.style.width = 'min(672px, calc(var(--platform-float-w) - 32px))';
      }
    } else {
      overlay.addEventListener('pointerdown', (e) => {
        if (e.target === overlay) BuildLog.close();
      });
      document.body.appendChild(overlay);
      BuildLog._el = overlay;
      BuildLog._keyHandler = (e) => { if (e.key === 'Escape') BuildLog.close(); };
      document.addEventListener('keydown', BuildLog._keyHandler);
    }

    panel.querySelector('#build-log-close')?.addEventListener('click', () => BuildLog.close());

    const copyBtn = panel.querySelector('#build-log-copy');
    if (copyBtn && failure) {
      copyBtn.addEventListener('click', async () => {
        const text = [
          `Build failure for ${slug}`,
          `Stage: ${BuildLog.stageLabel(failure.stage)}`,
          failure.at ? `At: ${failure.at}` : null,
          failure.sha ? `Commit: ${failure.sha}` : null,
          `Reason: ${failure.reason || ''}`,
          '',
          String(failure.log || ''),
        ].filter((l) => l !== null).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = PlatformI18n.t('session:buildLog.copied');
        } catch {
          copyBtn.textContent = PlatformI18n.t('session:buildLog.copyFailed');
        }
        setTimeout(() => { copyBtn.textContent = PlatformI18n.t('session:buildLog.copy'); }, 1500);
      });
    }

    const retryBtn = panel.querySelector('#build-log-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = PlatformI18n.t('session:buildLog.retrying');
        try {
          const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            PlatformUI.toast(data.error || PlatformI18n.t('session:buildLog.retryFailed', { status: res.status }));
            retryBtn.disabled = false;
            retryBtn.textContent = PlatformI18n.t('session:buildLog.retry');
            return;
          }
        } catch {
          retryBtn.disabled = false;
          retryBtn.textContent = PlatformI18n.t('session:buildLog.retry');
          return;
        }
        BuildLog.close();
        // The retry flips the card back to 'creating'; the WS
        // app_status broadcast drives the rest of the UI update.
        if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
          Home.load();
        }
      });
    }
  },

  close() {
    if (BuildLog._modal) {
      const m = BuildLog._modal;
      BuildLog._modal = null;
      m.dismiss();
    }
    if (BuildLog._keyHandler) {
      document.removeEventListener('keydown', BuildLog._keyHandler);
      BuildLog._keyHandler = null;
    }
    if (BuildLog._el) {
      BuildLog._el.remove();
      BuildLog._el = null;
    }
  },
};

// Quote-safe escaper local to this file (matches the per-file helper
// convention used across public/js).
function blEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Compact relative-time formatter (same buckets as home.js's
// formatRelativeTime; kept local so load order doesn't matter).
function blRelTime(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return PlatformI18n.t('session:buildLog.ago.justNow');
  if (seconds < 3600) return PlatformI18n.t('session:buildLog.ago.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return PlatformI18n.t('session:buildLog.ago.hours', { count: Math.floor(seconds / 3600) });
  if (seconds < 86400 * 30) return PlatformI18n.t('session:buildLog.ago.days', { count: Math.floor(seconds / 86400) });
  return PlatformI18n.t('session:buildLog.ago.months', { count: Math.floor(seconds / (86400 * 30)) });
}

window.BuildLog = BuildLog;
