/* Running a session on your own computer — the local-CLI card (#1055).
 *
 * The local CLI lease (#907) CONTINUES THIS SESSION, conversation and all.
 * The transcript, the branch and the proposal stay exactly where they are;
 * the turns just execute on the user's machine and their own Claude plan.
 * That is the one thing this module explains, and the card it draws is the
 * last step of picking the CLI venue in the session's venue sheet.
 *
 * WHAT LEFT. This was the "Session and billing options" menu behind the "⋯"
 * beside the credit meter, and #1353 retired that button: every row on it
 * had become a second door to somewhere else. "Change how this is built"
 * is the venue dropdown in the session header (#1348), which is also what
 * opens this card now; the API-key rows are Settings links the credits
 * banner offers at the moment they matter; and "Stop running on <machine>"
 * is the runner select's own "Run on: Homeroom". What survives is the copy
 * that had no other home — the commands, and the paragraph explaining what
 * a lease does and does not move.
 *
 * The pure functions (commands / instructionsHtml) take a plain state
 * object and return data or markup, so tests/session-options.test.js can
 * pin the copy without a DOM — exactly like public/js/credit-options.js
 * owns the out-of-credits copy.
 */
(function () {
  'use strict';

  // See public/js/credit-options.js for why this is resolved lazily.
  function venues() {
    if (typeof window !== 'undefined' && window.BuildVenues) return window.BuildVenues;
    if (typeof require === 'function') {
      try { return require('./build-venues.js'); } catch (err) { /* browser */ }
    }
    return null;
  }

  var SETTINGS_HASHES = {
    localTool: '#settings/cli',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ui() {
    return (typeof window !== 'undefined' && window.PlatformUI) || null;
  }

  // #1071's three-way derivation now lives in build-venues.js, next to the
  // venues it describes. Re-exported so existing callers keep working.
  function webTargetKind(state) {
    var BV = venues();
    if (BV) return BV.webTargetKind(state);
    // No venue list loaded (a surface that somehow ran before the shell
    // finished): the safe answer is the one that starts nothing.
    return 'new';
  }

  // ── The "run it on your computer" card ────────────────────────────
  //
  // Three commands, in the order they are run. The repo URL is the app's
  // own; with none known the clone line names the checkout generically
  // rather than emitting a broken command.
  function commands(state) {
    var s = state || {};
    var sessionId = s.sessionId == null ? '<session-id>' : String(s.sessionId);
    var repoUrl = s.repoUrl ? String(s.repoUrl) : null;
    return [
      repoUrl ? 'git clone ' + repoUrl : PlatformI18n.t('session:localRun.cloneComment'),
      'node ./tools/social-vibecoding login',
      'node ./tools/social-vibecoding agent run --session ' + sessionId,
    ];
  }

  // The lead paragraph, in two shapes (#1350).
  //
  // "same transcript, same branch, same proposal" was written when a
  // session had a branch from the moment it was created. It does not now:
  // the branch is minted on the session's first turn, so a session handed
  // to the local CLI before anyone has said anything to it has none yet.
  //
  // That is not an error and the card still works. `agent run` attaches,
  // the first turn runs on the user's machine, and the push that follows
  // is what creates the branch. But promising a branch that does not exist
  // is the kind of sentence someone checks against GitHub and does not
  // find, so this says which of the two it is instead.
  function leadHtml(state) {
    var s = state || {};
    if (s.hasBranch === false) {
      return PlatformI18n.t('session:localRun.leadNoBranch');
    }
    return PlatformI18n.t('session:localRun.lead');
  }

  function instructionsHtml(state) {
    var s = state || {};
    var cmdText = commands(s).join('\n');
    return ''
      + '<div class="dc-options-card w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col max-h-[85vh]">'
      + '  <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">'
      + '    <h2 class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">' + PlatformI18n.htmlText('session:localRun.title') + '</h2>'
      + '    <button type="button" id="dc-options-close" class="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-500/10" aria-label="' + PlatformI18n.htmlText('core:common.close') + '">'
      + '      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
      + '    </button>'
      + '  </div>'
      + '  <div class="px-4 py-3 overflow-y-auto">'
      + '    <p id="dc-options-lead" class="text-xs text-zinc-600 dark:text-zinc-300">'
      + escapeHtml(leadHtml(s))
      + '</p>'
      + '    <pre id="dc-options-commands" class="mt-3 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3 text-[0.7rem] leading-relaxed font-mono whitespace-pre-wrap break-words select-text text-zinc-700 dark:text-zinc-300">'
      + escapeHtml(cmdText)
      + '</pre>'
      + '    <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">' + PlatformI18n.htmlText('session:localRun.footnote') + '</p>'
      + '  </div>'
      + '  <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">'
      + '    <button type="button" id="dc-options-copy" class="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-500/10">' + PlatformI18n.htmlText('session:localRun.copy') + '</button>'
      + '  </div>'
      + '</div>';
  }

  // Present the card. Kit path draws the modal chrome (fade + scale,
  // backdrop tap / Escape dismiss); without a kit we mount our own
  // overlay, the same two-path shape public/js/build-log.js uses.
  function openInstructions(opts) {
    var o = opts || {};
    if (typeof document === 'undefined') return null;
    var state = o.state || {};
    var overlay = document.createElement('div');
    overlay.id = 'dc-options-overlay';
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4';
    overlay.innerHTML = instructionsHtml(state);
    var panel = overlay.firstElementChild;
    var kit = ui();
    var handle = null;
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      if (handle && typeof handle.dismiss === 'function') handle.dismiss();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      if (typeof o.onClose === 'function') o.onClose();
    }

    var keyHandler = null;
    if (kit && kit.hasKit()) {
      panel.classList.add('platform-modal-card');
      handle = kit.modal({
        contentEl: panel,
        onDismiss: function () {
          handle = null;
          close();
        },
      });
      // The float box (app.css THE USABLE BOX) less the kit's 16px a side.
      if (handle && handle.el) handle.el.style.width = 'min(576px, calc(var(--platform-float-w) - 32px))';
    }
    if (!handle) {
      overlay.addEventListener('pointerdown', function (event) {
        if (event.target === overlay) close();
      });
      document.body.appendChild(overlay);
      keyHandler = function (event) { if (event.key === 'Escape') close(); };
      document.addEventListener('keydown', keyHandler);
    }

    var closeBtn = panel.querySelector('#dc-options-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var copyBtn = panel.querySelector('#dc-options-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = commands(state).join('\n');
        var done = function (ok) {
          copyBtn.textContent = ok
            ? PlatformI18n.t('session:localRun.copied')
            : PlatformI18n.t('session:localRun.copyFailed');
          setTimeout(function () { copyBtn.textContent = PlatformI18n.t('session:localRun.copy'); }, 1500);
        };
        if (kit && typeof kit.copyText === 'function') {
          kit.copyText(text).then(done);
          return;
        }
        done(false);
      });
    }

    return { dismiss: close, el: panel };
  }

  var SessionOptions = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    webTargetKind: webTargetKind,
    commands: commands,
    instructionsHtml: instructionsHtml,
    leadHtml: leadHtml,
    openInstructions: openInstructions,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionOptions;
  }
  if (typeof window !== 'undefined') {
    window.SessionOptions = SessionOptions;
  }
}());
