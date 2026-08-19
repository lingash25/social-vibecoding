// Kudos: PR appreciation widget + header budget badge.
//
// Two surfaces live in this file:
//   - Kudos.renderButton(pr, opts) — returns the HTML for a give-kudos
//     button (count + 👏 + hover popover) suitable for inlining into a
//     PR card (vote panel + merged list). Buttons hook the DOM via
//     [data-kudos-session] so live updates and clicks can find them
//     after rerenders.
//   - Kudos.Budget — pollable + WS-driven badge in the header. Tracks
//     remaining quota for the current user, links through to the
//     leaderboard screen on click.
//
// The component is intentionally not stateful — every render produces
// a fresh fragment of HTML using the data the caller already has
// (kudos_count + my_kudos come from /promoted, /merged, /leaderboard
// responses; the giver list lazy-loads on hover the first time).
// AppView calls Kudos.applyLiveUpdate() when a `kudos_update` WS
// event arrives so any visible button gets its count + state bumped
// without a panel reload.

const Kudos = {
  // appSlug => Map<sessionId, { count, my_kudos, givers? }>. We cache
  // the giver list per session so re-hovering doesn't refetch.
  // Mutated by applyLiveUpdate when WS broadcasts arrive.
  _cache: new Map(),

  _ensureCache(sessionId) {
    if (!Kudos._cache.has(sessionId)) {
      Kudos._cache.set(sessionId, { count: 0, my_kudos: false, my_kudos_direct: false, givers: null });
    }
    return Kudos._cache.get(sessionId);
  },

  // Seed cache from a server response (a PR row from /promoted or
  // /merged, or a session-kudos object). Idempotent: known fields
  // overwrite, unknown ones leave existing cache untouched. Lets a
  // hover-popover render instantly the second time even if the
  // canonical fetch hasn't happened yet.
  primeFromPr(pr) {
    if (!pr || pr.id == null) return;
    const entry = Kudos._ensureCache(pr.id);
    if (typeof pr.kudos_count === 'number') entry.count = pr.kudos_count;
    if (typeof pr.my_kudos === 'boolean') entry.my_kudos = pr.my_kudos;
    if (typeof pr.my_kudos_direct === 'boolean') entry.my_kudos_direct = pr.my_kudos_direct;
  },

  // Returns a button HTML string. `pr` must carry `id`, `kudos_count`,
  // `my_kudos`, and `user_id` (PR author, for the self-kudos check).
  // `opts.disabled` overrides everything else (e.g. "PR not yet
  // promoted, hide button"). `opts.compact` switches to the small
  // variant used in tight lists; default is the regular button.
  //
  // The button is wrapped in a positioned container so the absolute
  // popover lines up against it. The popover is rendered empty and
  // hydrated on first hover via fetch.
  renderButton(pr, opts = {}) {
    Kudos.primeFromPr(pr);
    const entry = Kudos._ensureCache(pr.id);
    const count = entry.count || 0;
    const mine = !!entry.my_kudos;

    const viewerId = window.App?.user?.id || null;
    const isSelf = viewerId && pr.user_id && pr.user_id === viewerId;

    // Disabled reasons:
    //   - explicit opts.disabled
    //   - viewer is the author (self-kudos forbidden — match server)
    //   - viewer's credit came from an awarded issue bounty (no
    //     pr_kudos row to retract — the server would 404 the DELETE)
    // A direct kudos of the viewer's own (mine && direct) keeps the
    // button ENABLED as a retract toggle — clicking again undoes it.
    // We don't gate on quota here; the budget badge surfaces it and a
    // 429 from POST shows a toast.
    // #621: read-only viewers keep the count visible but can't give -
    // treated as a locked disable (nothing can lift it this mount).
    const readOnly = !!(window.AppView && AppView.readOnly);
    const direct = !!entry.my_kudos_direct;
    const disabledReason = readOnly
      ? 'Only collaborators can give kudos'
      : opts.disabled
        ? opts.disabledReason || ''
        : isSelf
          ? 'You can\u2019t give kudos to your own PR'
          : mine && !direct
            ? 'Credited via an issue bounty award \u2014 can\u2019t be retracted'
            : '';
    const disabled = !!disabledReason;
    const tip = disabledReason || (mine && direct
      ? 'You gave kudos to this PR \u2014 click again to retract'
      : '');

    // Locked = disabled for a reason no later state change can lift
    // (explicit opts.disabled / self-PR). _refreshButton skips the
    // enable/disable churn on locked buttons and only updates counts.
    const locked = !!(opts.disabled || isSelf || readOnly);

    const sizeCls = opts.compact
      ? 'gc-vote-btn'
      : 'gc-vote-btn';
    const activeCls = mine ? ' gc-vote-active' : '';
    const disabledCls = disabled ? ' opacity-60 cursor-not-allowed' : '';

    const tipAttr = tip ? ` title="${escapeAttr(tip)}"` : '';

    // Wrap in a relatively-positioned span so the popover can absolute-
    // position against it. Clicks and hover are bound by Kudos.attach()
    // (called by app-view after innerHTML render).
    return `
      <span class="kudos-wrap relative inline-block" data-kudos-session="${pr.id}">
        <button class="${sizeCls}${activeCls}${disabledCls}" ${disabled ? 'disabled' : ''}${tipAttr}
                data-kudos-action="give" data-kudos-session-id="${pr.id}"${locked ? ' data-kudos-locked="1"' : ''}>
          <span aria-hidden="true">\u{1F44F}</span>
          <span data-kudos-count>${count}</span>
        </button>
        <span class="kudos-popover hidden absolute z-30 right-0 top-full mt-1 min-w-[12rem] max-w-[18rem]
                     bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700
                     rounded-lg shadow-xl text-xs text-zinc-700 dark:text-zinc-200 p-2"
              data-kudos-popover></span>
      </span>`;
  },

  // Bind hover + click handlers for any kudos wrappers under `root`
  // (default: whole document). Idempotent — re-binding the same node
  // is a no-op via the data-kudos-bound marker.
  attach(root) {
    const scope = root || document;
    scope.querySelectorAll('.kudos-wrap[data-kudos-session]').forEach((wrap) => {
      if (wrap.dataset.kudosBound === '1') return;
      wrap.dataset.kudosBound = '1';
      const sid = parseInt(wrap.dataset.kudosSession, 10);
      const btn = wrap.querySelector('[data-kudos-action="give"]');
      const popover = wrap.querySelector('[data-kudos-popover]');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.disabled) return;
          // Route on the cache state at CLICK time (not bind time) —
          // the same bound button must toggle both ways as the viewer
          // gives and retracts.
          const entry = Kudos._ensureCache(sid);
          if (entry.my_kudos && entry.my_kudos_direct) Kudos.retract(sid);
          else Kudos.give(sid);
        });
      }
      if (popover) {
        // Lazy-load givers on first hover. Cached afterwards.
        let loadPromise = null;
        wrap.addEventListener('mouseenter', () => {
          popover.classList.remove('hidden');
          const entry = Kudos._ensureCache(sid);
          if (entry.count === 0) {
            popover.innerHTML = '<span class="text-zinc-500">No kudos yet — be the first.</span>';
            return;
          }
          if (!entry.givers && !loadPromise) {
            loadPromise = Kudos.fetchGivers(sid).then(() => {
              if (!popover.classList.contains('hidden')) Kudos._renderPopover(sid, popover);
            });
            popover.innerHTML = '<span class="text-zinc-500">Loading…</span>';
            return;
          }
          Kudos._renderPopover(sid, popover);
        });
        wrap.addEventListener('mouseleave', () => {
          popover.classList.add('hidden');
        });
      }
    });
  },

  _renderPopover(sid, popover) {
    const entry = Kudos._ensureCache(sid);
    if (!entry.givers || !entry.givers.length) {
      popover.innerHTML = '<span class="text-zinc-500">No kudos yet — be the first.</span>';
      return;
    }
    const items = entry.givers.map((g) => {
      const who = escapeHtml(g.username || 'someone');
      const when = relativeTime(g.createdAt);
      return `<div class="flex items-center justify-between gap-2 py-0.5">
        <span class="font-medium">@${who}</span>
        <span class="text-zinc-500">${when}</span>
      </div>`;
    }).join('');
    popover.innerHTML = `<div class="mb-1 text-zinc-500 dark:text-zinc-400">Kudos givers (${entry.givers.length})</div>${items}`;
  },

  async fetchGivers(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/kudos`);
      if (!res.ok) return;
      const data = await res.json();
      const entry = Kudos._ensureCache(sessionId);
      entry.count = data.count || 0;
      entry.my_kudos = !!data.my_kudos;
      entry.my_kudos_direct = !!data.my_kudos_direct;
      entry.givers = Array.isArray(data.givers) ? data.givers : [];
      // Bump the in-DOM counter in case the cache was stale.
      Kudos._refreshButton(sessionId);
    } catch (err) {
      console.warn('[kudos] fetchGivers failed', err);
    }
  },

  // POST /api/sessions/:id/kudos and react to all 5 outcomes
  // (ok / 403 self / 409 dup / 404 ineligible / 429 quota / 500).
  async give(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/kudos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const entry = Kudos._ensureCache(sessionId);
        // The server broadcasts the kudos_update WS event *before* it
        // sends this HTTP response, so applyLiveUpdate() may have
        // already counted this give by the time we get here. If so,
        // `my_kudos` is already true and `count` already reflects the
        // authoritative total — bumping again would show N+2 until the
        // next refresh. Only apply the optimistic delta when the WS
        // hasn't beaten us to it.
        const alreadyApplied = entry.my_kudos;
        entry.my_kudos = true;
        entry.my_kudos_direct = true;
        if (!alreadyApplied) {
          entry.count = (entry.count || 0) + 1;
          // Append the viewer to the cached giver list so the popover
          // reflects the change immediately (without waiting for the
          // WS bounce).
          if (entry.givers) {
            entry.givers.push({
              username: window.App?.user?.username || 'you',
              createdAt: new Date().toISOString(),
            });
          }
        }
        Kudos._refreshButton(sessionId);
        // The server already broadcast a kudos_update; we'd see it
        // back as another live update which is harmless (dedup via
        // sessionId-keyed state). Refresh the budget badge so the
        // header re-renders the new remaining count.
        Kudos.Budget.refresh();
        // The give now belongs in the viewer's "My history" tab — drop
        // its cached panes so the next visit re-fetches.
        if (window.Leaderboard?.invalidateHistory) Leaderboard.invalidateHistory();
      } else if (res.status === 429) {
        Kudos._toast(data.error || 'Weekly kudos quota exceeded.');
      } else if (res.status === 403) {
        Kudos._toast('You can\u2019t give kudos to your own PR.');
      } else if (res.status === 409) {
        Kudos._toast('You already gave kudos to this PR.');
      } else if (res.status === 404) {
        Kudos._toast(data.error || 'This PR isn\u2019t eligible for kudos.');
      } else {
        Kudos._toast('Failed to give kudos. Try again?');
      }
    } catch (err) {
      console.warn('[kudos] give failed', err);
      Kudos._toast('Network error giving kudos.');
    }
  },

  // DELETE /api/sessions/:id/kudos — retract a previously given kudos
  // (issue #197). Mirror of give() in reverse, including the WS-race
  // guard: the server broadcasts kudos_update *before* this HTTP
  // response arrives, so applyLiveUpdate() may have already cleared
  // my_kudos and set the authoritative count. Only apply the
  // optimistic decrement when the WS hasn't beaten us to it.
  async retract(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/kudos`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const entry = Kudos._ensureCache(sessionId);
        const alreadyApplied = !entry.my_kudos;
        entry.my_kudos = false;
        entry.my_kudos_direct = false;
        if (!alreadyApplied) {
          entry.count = Math.max(0, (entry.count || 0) - 1);
          // Drop the viewer from the cached giver list so the popover
          // reflects the change immediately.
          if (entry.givers) {
            const me = window.App?.user?.username;
            entry.givers = entry.givers.filter((g) => g.username !== me);
          }
        }
        Kudos._refreshButton(sessionId);
        // The freed slot only counts if the kudos was given this week;
        // the budget endpoint is authoritative either way.
        Kudos.Budget.refresh();
      } else if (res.status === 404) {
        Kudos._toast(data.error || 'No kudos to retract.');
        // Cache was stale (e.g. bounty-derived credit, or already
        // retracted in another tab) — reconcile from the server.
        Kudos.fetchGivers(sessionId);
      } else {
        Kudos._toast('Failed to retract kudos. Try again?');
      }
    } catch (err) {
      console.warn('[kudos] retract failed', err);
      Kudos._toast('Network error retracting kudos.');
    }
  },

  // Called by App's WS handler. Bumps the cache for `sessionId` and
  // updates any live button(s) in place. Also nudges Budget.refresh
  // when *we* are not the giver (when we are, give() already updated
  // the badge optimistically).
  applyLiveUpdate(data) {
    if (!data || !data.sessionId) return;
    const entry = Kudos._ensureCache(data.sessionId);
    if (typeof data.count === 'number') entry.count = data.count;
    if (data.retractedUsername) {
      const me = window.App?.user?.username;
      if (data.retractedUsername === me) {
        entry.my_kudos = false;
        entry.my_kudos_direct = false;
      }
      if (entry.givers) {
        entry.givers = entry.givers.filter((g) => g.username !== data.retractedUsername);
      }
    } else if (data.giverUsername) {
      const me = window.App?.user?.username;
      if (data.giverUsername === me) {
        entry.my_kudos = true;
        entry.my_kudos_direct = true;
      }
      // Lazy-append to the giver list cache if we have it. We can't
      // be sure of createdAt — use "now" which is close enough for
      // the popover display (the next hover re-fetch will reconcile).
      if (entry.givers) {
        const exists = entry.givers.some((g) => g.username === data.giverUsername);
        if (!exists) {
          entry.givers.push({
            username: data.giverUsername,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    Kudos._refreshButton(data.sessionId);
    // Leaderboard screen, if open, refresh inline.
    if (window.Leaderboard?.isOpen?.()) window.Leaderboard.refresh();
  },

  _refreshButton(sessionId) {
    const entry = Kudos._ensureCache(sessionId);
    document.querySelectorAll(`.kudos-wrap[data-kudos-session="${sessionId}"]`).forEach((wrap) => {
      const counter = wrap.querySelector('[data-kudos-count]');
      if (counter) counter.textContent = String(entry.count || 0);
      const btn = wrap.querySelector('[data-kudos-action="give"]');
      if (!btn) return;
      // Locked buttons (self-PR / explicit opts.disabled at render
      // time) only ever get count updates — never enable/disable.
      if (btn.dataset.kudosLocked === '1') return;
      if (entry.my_kudos && entry.my_kudos_direct) {
        // Viewer's own direct kudos: active, still clickable — the
        // second click retracts it.
        btn.classList.add('gc-vote-active');
        btn.classList.remove('opacity-60', 'cursor-not-allowed');
        btn.disabled = false;
        btn.setAttribute('title', 'You gave kudos to this PR — click again to retract');
      } else if (entry.my_kudos) {
        // Bounty-derived credit: shows as the viewer's but isn't a
        // pr_kudos row, so there's nothing to retract here.
        btn.classList.add('gc-vote-active', 'opacity-60', 'cursor-not-allowed');
        btn.disabled = true;
        btn.setAttribute('title', 'Credited via an issue bounty award — can’t be retracted');
      } else {
        // No kudos from the viewer (incl. just-retracted): back to the
        // plain give state.
        btn.classList.remove('gc-vote-active', 'opacity-60', 'cursor-not-allowed');
        btn.disabled = false;
        btn.removeAttribute('title');
      }
    });
  },

  _toast(msg) {
    // Delegates to the platform-wide toast system (the native kit's
    // capsule HUD / Material snackbar via PlatformUI). The old
    // hand-rolled #kudos-toast div is gone.
    if (window.PlatformUI) { window.PlatformUI.toast(msg); return; }
    console.log('[kudos]', msg);
  },

  // ----------------------------------------------------------------
  // Kudos budget badge — polls /api/me/kudos-budget on first load
  // and re-fetches after every successful give() or any kudos_update
  // that names us as the giver. Cheap enough to also poll once an
  // hour as a safety net against the Monday-UTC rollover happening
  // while a tab is open across the boundary.
  // ----------------------------------------------------------------
  Budget: {
    state: null,
    _refreshTimer: null,
    // Screenshot deep links may pin a display-only budget while an initial
    // refresh is already in flight. That request must not repaint the forced
    // state when it resolves (the server remains authoritative for writes).
    _displayOverride: false,

    init() {
      Kudos.Budget.refresh();
      // Long-tab safety net: re-fetch hourly so a tab left open
      // through Monday-00-UTC sees the bucket reset without a manual
      // page refresh.
      Kudos.Budget._refreshTimer = setInterval(Kudos.Budget.refresh, 60 * 60 * 1000);
    },

    async refresh() {
      try {
        const res = await fetch('/api/me/kudos-budget');
        if (!res.ok) return;
        const data = await res.json();
        if (Kudos.Budget._displayOverride) return;
        Kudos.Budget.state = data;
        Kudos.Budget._render();
      } catch (err) {
        console.warn('[kudos] budget refresh failed', err);
      }
    },

    _render() {
      const slot = document.getElementById('kudos-budget-slot');
      if (!slot) return;
      const s = Kudos.Budget.state;
      if (!s) {
        slot.innerHTML = '';
        return;
      }
      const remaining = s.remaining;
      const limit = s.limit;
      // Click navigates to the Leaderboard screen's KUDOS tab — named
      // explicitly (#leaderboard/prs, its Top PRs sub-view and the place
      // you actually give kudos), because the bare #leaderboard hash opens
      // the primary standings tab, which this meter is not about. Tooltip
      // explains the weekly cap + reset boundary.
      const tip = `${remaining} of ${limit} kudos left this week. Resets Monday 00:00 UTC.`;
      const tone = remaining === 0
        ? 'text-zinc-500 dark:text-zinc-400'
        : 'text-violet-600 dark:text-violet-400';
      // Plain inline text, NOT a pill: the row already labels itself
      // "Kudos", so the badge chrome was framing a number that needed no
      // frame — and it read as a tappable chip competing with the nav
      // rows around it. Mono digits (via .drawer-meter) so the figure
      // doesn't jitter as it's spent; still a real anchor to the
      // Leaderboard, which underlines on hover.
      //
      // No HeaderLayout.refresh() either: the header's centred title no
      // longer has to account for this slot's width.
      slot.innerHTML = `
        <a href="#leaderboard/prs" class="drawer-meter ${tone}" title="${escapeAttr(tip)}">
          <span class="drawer-meter-part"><span class="drawer-meter-strong">${remaining}</span><span class="drawer-meter-dim"> of ${limit} left</span></span>
        </a>`;
    },
  },
};

// These two used to be AMBIENT: as a classic script this file's top-level
// function declarations were window properties, so they joined the shell's
// last-writer-wins chain of identically-named escape helpers (group-chat.js,
// app-view.js and home.js each declare their own). Inside the bundle a
// module's identifiers are its own, which is strictly better — this file now
// provably calls THESE bodies. Nothing regressed by dropping out of the chain:
// the four scripts that read escapeHtml/escapeAttr ambiently (app-secrets.js,
// dev-chat.js, home-panels.js, streaming-markdown.js) were resolving to
// app-view.js's and home.js's copies, both of which load later and are still
// classic scripts.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but app.js (Budget.init on authed boot, applyLiveUpdate on
// kudos_update WS events), app-view.js (Kudos.attach / renderButton on every
// PR surface) and ./leaderboard.js
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.Kudos = Kudos;
