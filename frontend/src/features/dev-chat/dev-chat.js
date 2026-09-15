// The dev session chat. MOVED here from public/js/dev-chat.js by #1084 chunk G
// (React migration step 2, #1040) — a MOVE, not a rewrite, per AGENTS.md.
//
// Nothing below this header changed except the tail, so the diff stays
// reviewable: the same 8,800 lines, the same `DevChat` object, the same
// behaviour. What changed is HOW it loads and what it publishes:
//
//   * it is bundled into /shell/assets/shell.js instead of being the 26th
//     classic <script> at the end of <body>. Its tag is gone from
//     frontend/src/Shell.tsx, its entry is gone from SHELL_ASSETS in
//     public/sw.js, and tests/shell-script-order.test.js records the
//     retirement in RETIRED_SCRIPTS with the body count dropped to 25;
//   * `const DevChat = {…}` no longer creates a global by itself, so the tail
//     publishes `window.DevChat` explicitly. Every legacy caller (app.js,
//     app-view.js, group-chat.js, settings.js, dev-flow-select.js,
//     credit-options.js, session-options.js, …) is untouched and keeps
//     reading the bare global;
//   * the publication and the three document/window listeners it used to
//     install at classic-script time are guarded by
//     `typeof window !== 'undefined'`, because the SSG prerender pass
//     evaluates this module's graph in Node.
//
// The load ORDER is preserved: the bundle is a deferred `type="module"` in
// <head>, so it runs after the last body script and before DOMContentLoaded —
// the same window the tag occupied. That is only safe because no other module
// reads `DevChat` at its own top level; every consumer reads it from inside a
// handler or a DOMContentLoaded bootstrap, which run strictly later. A grep
// for module-scope `DevChat` across public/js/** finds comments only.
//
// Being an ES module also means STRICT MODE, where the classic script was
// sloppy. Nothing here depended on sloppy semantics (no implicit globals, no
// `with`, no octal literals, no `arguments.callee`).
//
// renderChatView() is still a template that writes `#dc-view.innerHTML`, so
// the chat screen is not React-owned yet: that commit made the conversion
// POSSIBLE by putting the module in the bundle, and did not attempt it. That
// conversion has to take the frame and the composer's streaming state
// together — see the note at renderChatView().
//
// #1191 took the FIRST piece of it: the pending-upload strip is a component
// now, shared with the group chat's composers
// (features/attachments/pending-strip.tsx).
//
// IT REACHES REACT BY NAME, through `window.UsernodeReact.devChat`, even
// though this file is in the same bundle and could import directly. That is
// not an oversight. A dozen test files load this source into a `vm` context as
// a SCRIPT — `vm.runInContext(SRC)` — to drive `DevChat` against a DOM stub,
// and a top-level `import` is a syntax error there. Adding two of them turned
// 194 tests red at once. The bridge is in ./mount.ts, published at
// module-evaluation time like every other one.
//
// localStorage key for the user's last-chosen model. Single global
// key (not per-app/per-session) so the preference is sticky wherever
// the user goes — nobody wants "I set Opus here, but the next app
// reset me back to Sonnet".
const MODEL_STORAGE_KEY = 'usernode:dc:model';
const OPENROUTER_MODEL_PREFIX = 'openrouter:';
const ANTHROPIC_MODEL_PREFIX = 'anthropic:';
const OPENROUTER_MORE_VALUE = `${OPENROUTER_MODEL_PREFIX}__add_more__`;

// A `?shot=` screenshot-state deep link names a SURFACE, not a moment, so
// the open is held up for a window rather than attempted once — see
// _holdShotSurface. The window covers the capture harness's whole judging
// window (capture/capture.js: a settle of up to 1.5s, then presence
// assertions polled for up to 5s, and a cohort that fails is reloaded and
// judged again), with room for a slow preview on top. Only ever reached
// from a `?shot=` URL.
const SHOT_HOLD_MS = 10000;
const SHOT_HOLD_RETRY_MS = 100;

function loadStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

const DevChat = {
  sessions: [],
  currentSession: null,
  messages: [],
  isStreaming: false,
  selectedModel: loadStoredModel() || 'claude-opus-5',
  _staleTimer: null,
  _abortController: null,
  // Most recent event _seq we've processed across any channel (POST SSE,
  // resumable EventSource, global WS). Used as the replay cursor when we
  // (re)open the resumable GET /events stream so the server's ring
  // buffer can backfill anything we missed during a disconnect.
  _lastSeenSeq: null,
  // Handle to the resumable EventSource, if open.
  _eventSource: null,

  // ----- Browser-title status indicator (#108, #142, #161) -----
  // While the user is on the dev-chat tab, the document title carries a
  // status marker for the current session's turn: "thinking" while the
  // Mayor / Claude Code is working. The old streaming-driven "✅ Done"
  // marker is gone (#161): every "finished while away" case now arms
  // notify_on_done server-side, so a session_done / auto_solve_done
  // notification always exists, and its ARRIVAL drives the completion
  // marker instead (see Notifications.handleIncoming →
  // setCompletionTitle). The completion marker lives in a separate slot
  // (_titleCompletion) that outranks the streaming status, is exempt
  // from the dev-chat-tab scoping, and STAYS until the user actually
  // comes back (visibilitychange / window focus — listeners at the
  // bottom of this file) or the triggering notification is read.
  // ----- Composer copy (#798) -----
  // The idle placeholder lives here (not only in the template) because
  // _setStreamingUI swaps it for the busy variant while a turn runs and
  // has to put the original back afterwards.
  COMPOSER_PLACEHOLDER:
    'Describe a change in plain English, e.g. "add a dark mode toggle". No coding needed.',
  // #810: the save icon exists ONLY while a turn runs (that's the state
  // where sending is impossible), so the busy copy points at it again.
  COMPOSER_PLACEHOLDER_BUSY:
    'Claude is working. Type your next note and tap 💾 to save it for later.',
  SAVE_DRAFT_TITLE:
    'Save this text as a draft (Ctrl+Enter). It stays here until you send it',
  SEND_TITLE: 'Send (Ctrl+Enter)',
  // #920's hint used to be a LINE under the box, because the keystroke does
  // two different things and nothing else said which. It is the one circle's
  // title now: the button and the shortcut perform the same action in every
  // state, so naming it on the control names it for both. The mid-turn half
  // is also carried by the busy placeholder, which already says "save it for
  // later" — which is what made the separate line affordable to lose.
  // Floppy-disk glyph, same inline-SVG style as the attach button.
  _SAVE_ICON_SVG:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',

  _titleStatus: null, // null | 'thinking'
  // null | 'sessionDone' | 'autoSolveDone' | 'autoSolveFailed' (#161).
  // Single slot, last-write-wins — the badge count carries multiplicity.
  _titleCompletion: null,

  budget: null,
  // #2118: an OpenRouter session's counterpart — what the viewer's
  // OpenRouter key reports left of its limit (GET /allowance), read live.
  openrouterAllowance: null,

  // ----- Cross-app active sessions panel state -----
  // Every non-archived session the user owns across all apps, with a `busy`
  // flag for the ones where Claude is running a turn right now.
  //
  // This fed an "Active Sessions (x/y)" panel at the top of the dev-chat
  // tab, on a 5s poll. That panel's hosts are gone and its renderer and poll
  // went with them (#1367); what the payload is FOR now is seeding
  // `SessionState` — see loadActiveSessions — so only `.sessions` is read.
  // The totals and caps are kept in the shape because the endpoint sends
  // them and the seed reads the array off this object.
  activeSessions: {
    sessions: [],
    totals: { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 },
    caps: { activeSessions: 3, promotedSessions: 5 },
  },

  // ----- Spec viewer state -----
  // Read-only viewer for the current session's spec doc + frozen
  // version history. Opened from inline preview cards rendered in the
  // chat timeline (see renderMessages). On wide viewports the viewer
  // mounts beside the chat as a side panel; on narrow viewports it
  // takes over the screen as a full-screen modal — handled by CSS, not
  // JS. State here only tracks open/closed + which version the user is
  // looking at.
  specViewer: {
    open: false,
    sessionId: null,           // session this state belongs to (guards stale loads)
    draftContent: '',          // latest spec_md from GET /api/sessions/:id/spec (always == latest version's content)
    versions: [],              // [{ version, built_at, commit_sha, pr_number, shared_to_group_at, ... }]
    viewVersion: 'latest',     // 'latest' (follow the highest version) or a specific version number
    viewVersionContent: null,  // cached content for a non-latest selection
    isLoading: false,
    activeTab: 'user',         // #196: 'user' | 'tech' — selected half of a two-section spec
  },

  // ----- Staging preview side panel state (#771) -----
  // On wide viewports, Preview staging / Test this change open the
  // preview docked beside the chat like the spec viewer. `open` only
  // tracks whether the #dc-staging-panel placeholder slot is mounted —
  // the preview itself (iframe, loader, testing panel) lives in the
  // fixed #staging-overlay, which AppView geometry-syncs onto the slot
  // (see AppView.rebindStagingDock; mounting the iframe here would
  // reload it on every renderChatView innerHTML rewrite). Deliberately
  // NOT persisted across reloads: a preview needs the ensure-staging
  // round-trip anyway, so auto-reopening an empty panel has no payoff.
  stagingPanel: { open: false },

  // Initial MODELS map. Populated authoritatively from GET /api/models
  // at startup so the UI dropdown can never offer something the server
  // wouldn't accept (server-side allowlist lives in src/services/models.js).
  // Kept seeded with the current set so the dropdown renders correctly
  // before the fetch resolves on a slow connection. Each value carries
  // the display label plus `changeSize` (#800) — the picker's editorial
  // "what kind of work is this for" copy; loadModels() refreshes it from
  // the server. NOTE: no $/MTok and no measured figures anywhere — the
  // composer's budget badge is where spend lives.
  //
  // This map DUPLICATES the `changeSize` copy in src/services/models.js
  // (it exists only for first paint before /api/models resolves), so the
  // two must be edited together. tests/model-selector-ui.test.js has a
  // copy-drift guard that fails if they diverge.
  MODELS: {
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      changeSize: {
        short: 'simple, small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      changeSize: {
        short: 'general coding work',
        long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
      },
    },
    'claude-fable-5-1': {
      label: 'Fable 5.1',
      changeSize: {
        short: 'design, taste, and difficult coding',
        long: 'Design and taste (how a screen looks, reads, and feels) plus the most difficult coding work.',
      },
    },
  },

  // Default model id used when sanitization rejects a stale storage
  // value. Overwritten by GET /api/models with the server's authoritative
  // default so the two stay aligned.
  _defaultModel: 'claude-opus-5',

  // The lightweight data behind the composer's unified picker. It is loaded
  // once per page rather than every time the composer republishes (which can
  // be every keystroke). The full catalog remains in the existing dialog;
  // this cache is used only to build its saved/favorite shortlist.
  _modelPickerData: null,
  _modelPickerDataPromise: null,
  _modelPickerChanging: false,

  // Fetch the authoritative model allowlist from the server. Replaces
  // the inline MODELS map so adding/removing a model on the server
  // (src/services/models.js) automatically flows to the dropdown
  // without a client redeploy. Resilient to network failures: on error
  // we keep whatever MODELS was previously populated with.
  async loadModels() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.models) && data.models.length) {
        const next = {};
        for (const m of data.models) {
          if (m && typeof m.id === 'string') {
            const label = (typeof m.label === 'string' && m.label) ? m.label : m.id;
            // #800: carry changeSize through. Optional — a server that
            // omits it leaves the selector rendering plain labels.
            const changeSize = (m.changeSize && typeof m.changeSize === 'object')
              ? m.changeSize
              : null;
            next[m.id] = { label, changeSize };
          }
        }
        DevChat.MODELS = next;
      }
      if (data && typeof data.default === 'string' && data.default) {
        DevChat._defaultModel = data.default;
      }
      DevChat._sanitizeStoredModel();
      // #800: if a session view is already mounted, patch the dropdown in
      // place so a server-side allowlist change (a model added or
      // removed) reaches an open composer instead of waiting for the next
      // renderChatView.
      DevChat._refreshModelSelect();
    } catch {}
  },

  // #800: a server-side allowlist change (a model added or removed) has to
  // reach an OPEN composer rather than wait for the next renderChatView. It
  // rewrote the dropdown's `<option>`s in place and re-set its value; the
  // options and the selection are two fields of the composer model now, so
  // the same update is one publish and the selection cannot be lost.
  _refreshModelSelect() {
    DevChat._publishComposer();
  },

  /** Load the saved OpenRouter choice and its key-visible model shortlist. */
  async _ensureModelPickerData({ forceRefresh = false } = {}) {
    if (!DevChat.currentSession) return null;
    const venue = DevChat._currentVenueId();
    if (venue !== 'usernode-claude' && venue !== 'usernode-openrouter') return null;
    if (DevChat._modelPickerData && !forceRefresh) return DevChat._modelPickerData;
    if (DevChat._modelPickerDataPromise && !forceRefresh) {
      return DevChat._modelPickerDataPromise;
    }

    const request = DevChat._loadCodingAgentChoiceData({ forceRefresh });
    DevChat._modelPickerDataPromise = request;
    try {
      const data = await request;
      DevChat._modelPickerData = data;
      DevChat._publishComposer();
      return data;
    } finally {
      if (DevChat._modelPickerDataPromise === request) {
        DevChat._modelPickerDataPromise = null;
      }
    }
  },

  /**
   * The one in-composer model picker, as grouped data. Null off-platform.
   *
   * OpenRouter comes first. Its shortlist is the user's saved model (or the
   * server's recommended GLM when there is no saved choice), the model pinned
   * to this session, and favorites added through the full catalog dialog.
   * Anthropic's direct models come second. Every option repeats its key source
   * because native optgroup headings disappear when a select is closed — this
   * keeps an Anthropic-authored model reached through OpenRouter from looking
   * like it will use the Anthropic key.
   */
  _modelPickerView() {
    const venue = DevChat._currentVenueId();
    if (venue !== 'usernode-claude' && venue !== 'usernode-openrouter') return null;

    const data = DevChat._modelPickerData;
    const catalog = Array.isArray(data?.models) ? data.models : [];
    const byId = new Map(catalog.map((model) => [model.id, model]));
    const savedId = String(data?.backends?.codex_openrouter?.model || '').trim();
    const recommendedId = byId.has(data?.recommendedModelId)
      ? data.recommendedModelId
      : (catalog.find((model) => model?.isRecommended)?.id
        || catalog.find((model) => model?.compatibility === 'verified')?.id
        || catalog[0]?.id
        || '');
    // A stale saved id is not an option. The server recommendation is GLM by
    // default, so this is also the first-use fallback the user asked for.
    const preferredId = byId.has(savedId) ? savedId : recommendedId;
    const openRouterSession = DevChat._isOpenRouterSession();
    const currentOpenRouterId = openRouterSession
      ? String(DevChat.currentSession?.agent_model || '').trim()
      : '';

    const shortlistIds = [];
    const addShortlistId = (id) => {
      if (id && !shortlistIds.includes(id)) shortlistIds.push(id);
    };
    // Keep the active session truthful first, then the saved/GLM default,
    // then any extra models the user starred in the dialog.
    addShortlistId(currentOpenRouterId);
    addShortlistId(preferredId);
    addShortlistId(recommendedId);
    for (const model of DevChat._openRouterModelsForPicker(catalog, { favoritesOnly: true })) {
      addShortlistId(model.id);
    }

    const openRouterOptions = shortlistIds.map((id) => {
      const model = byId.get(id);
      return {
        value: `${OPENROUTER_MODEL_PREFIX}${id}`,
        label: `OpenRouter key · ${model?.name || id}`,
      };
    });
    let selectedOpenRouterId = currentOpenRouterId || preferredId;
    if (openRouterSession && !selectedOpenRouterId) {
      // Old/incomplete rows should say that they are still loading rather
      // than make the select visually fall into Anthropic's first option.
      selectedOpenRouterId = '__loading__';
      openRouterOptions.unshift({
        value: `${OPENROUTER_MODEL_PREFIX}${selectedOpenRouterId}`,
        label: 'OpenRouter key · Loading model',
        disabled: true,
      });
    }

    const groups = [];
    // Before the async read lands, keep the catalog door available. Once the
    // capability response says OpenRouter is unavailable, omit a dead group
    // unless this is an existing OpenRouter session that must remain visible.
    if (!data || data.codexAvailable || data.loadError || openRouterSession) {
      groups.push({
        id: 'openrouter',
        label: 'OpenRouter key',
        options: [
          ...openRouterOptions,
          { value: OPENROUTER_MORE_VALUE, label: 'Add more OpenRouter models…' },
        ],
      });
    }
    const directOptions = Object.entries(DevChat.MODELS).map(([id, meta]) => ({
      value: `${ANTHROPIC_MODEL_PREFIX}${id}`,
      label: `Anthropic key · ${(meta && meta.label) || id}`,
    }));
    groups.push({ id: 'anthropic', label: 'Anthropic key', options: directOptions });

    const directId = Object.prototype.hasOwnProperty.call(DevChat.MODELS, DevChat.selectedModel)
      ? DevChat.selectedModel
      : (Object.prototype.hasOwnProperty.call(DevChat.MODELS, DevChat._defaultModel)
        ? DevChat._defaultModel
        : (Object.keys(DevChat.MODELS)[0] || ''));
    return {
      groups,
      selected: openRouterSession
        ? `${OPENROUTER_MODEL_PREFIX}${selectedOpenRouterId}`
        : `${ANTHROPIC_MODEL_PREFIX}${directId}`,
      changeDisabled: !!DevChat._composerBusy || DevChat._modelPickerChanging,
    };
  },

  /** Dispatch a grouped native-select value to its provider. */
  async _onModelPicked(value) {
    if (DevChat._modelPickerChanging) return;
    if (value === OPENROUTER_MORE_VALUE) {
      await DevChat._onOpenRouterModelChange();
      return;
    }
    if (String(value).startsWith(ANTHROPIC_MODEL_PREFIX)) {
      const model = String(value).slice(ANTHROPIC_MODEL_PREFIX.length);
      if (!Object.prototype.hasOwnProperty.call(DevChat.MODELS, model)) return;
      DevChat.selectedModel = model;
      // Direct Anthropic selection is a global per-browser preference, as it
      // was before this control learned about OpenRouter.
      try { localStorage.setItem(MODEL_STORAGE_KEY, model); } catch {}
      if (DevChat._isOpenRouterSession()) {
        DevChat._modelPickerChanging = true;
        DevChat._publishComposer();
        try {
          await DevChat._switchCurrentCodingAgent({
            backend: 'claude_code', model: null, reasoningEffort: null,
          });
        } finally {
          DevChat._modelPickerChanging = false;
          DevChat._publishComposer();
        }
      } else {
        DevChat._publishComposer();
      }
      return;
    }
    if (!String(value).startsWith(OPENROUTER_MODEL_PREFIX)) return;
    const model = String(value).slice(OPENROUTER_MODEL_PREFIX.length);
    if (!model || model === '__loading__') return;
    const data = DevChat._modelPickerData;
    const meta = Array.isArray(data?.models)
      ? data.models.find((item) => item?.id === model)
      : null;
    const saved = data?.backends?.codex_openrouter || {};
    const currentEffort = DevChat._isOpenRouterSession()
      && DevChat.currentSession?.agent_model === model
      ? DevChat.currentSession?.agent_reasoning_effort
      : null;
    const reasoningEffort = meta && meta.supportsReasoning !== true
      ? null
      : (currentEffort || saved.reasoningEffort || null);
    DevChat._modelPickerChanging = true;
    DevChat._publishComposer();
    try {
      await DevChat._switchCurrentCodingAgent({
        backend: 'codex_openrouter', model, reasoningEffort,
      });
    } finally {
      DevChat._modelPickerChanging = false;
      DevChat._publishComposer();
    }
  },

  /** The unified select's final row opens the existing full catalog. */
  async _onOpenRouterModelChange() {
    if (DevChat._modelPickerChanging) return;
    DevChat._modelPickerChanging = true;
    DevChat._publishComposer();
    try {
      await DevChat._switchCurrentCodingAgent(null, { fixedBackend: 'codex_openrouter' });
      // Favorite stars can change even when the dialog is cancelled. Re-read
      // the decorated catalog so additions/removals reach the shortlist.
      DevChat._modelPickerData = null;
      await DevChat._ensureModelPickerData();
    } finally {
      DevChat._modelPickerChanging = false;
      DevChat._publishComposer();
    }
  },

  // ── Session-pinned coding-agent choice ────────────────────────────
  // The deployment flag only controls whether Codex is available; it does
  // not choose a provider for the user. Every ordinary new session asks the
  // user which backend to pin, preselecting (but never silently applying)
  // their saved default. The same dialog switches an idle existing session
  // through reset-agent-context, which intentionally starts fresh agent
  // context while preserving the branch and conversation.
  _agentBackend(session) {
    return session?.agent_backend === 'codex_openrouter'
      ? 'codex_openrouter'
      : 'claude_code';
  },

  _isOpenRouterSession(session = DevChat.currentSession) {
    return DevChat._agentBackend(session) === 'codex_openrouter';
  },

  // Venue-first names. "Claude Code" used to mean BOTH the platform backend
  // and the web hand-off, in menus that sat inches apart; the venue names
  // say where the work happens and collide with nothing.
  _agentName(backend) {
    return backend === 'codex_openrouter' ? 'Homeroom · OpenRouter' : 'Homeroom · Claude';
  },

  // Runtime rows use camelCase metadata, session rows use snake_case, and
  // legacy rows have neither. Resolve all three in one place so progress,
  // logs, active-session tooltips, and reloads cannot disagree about which
  // provider actually ran the turn.
  _activityAgentBackend(source) {
    const backend = source?.agentBackend
      || source?.metadata?.agentBackend
      || source?.agent_backend;
    if (backend === 'codex_openrouter') return 'codex_openrouter';
    if (/^(?:Codex|OpenRouter)\b/i.test(String(source?.content || ''))) return 'codex_openrouter';
    return 'claude_code';
  },

  _activityAgentName(source) {
    return DevChat._activityAgentBackend(source) === 'codex_openrouter'
      ? 'OpenRouter'
      : 'Claude Code';
  },

  _copyActivityAgentMetadata(target, source) {
    if (!target || !source) return target;
    const backend = source.agentBackend
      || source.metadata?.agentBackend
      || source.agent_backend;
    const model = source.agentModel
      ?? source.metadata?.agentModel
      ?? source.agent_model;
    // Only copy an explicit identity. Older coding events deliberately have
    // neither field and continue to render as Claude through the legacy
    // fallback; sync-with-main also reuses cc_progress but is not a Codex
    // model run, so it must not inherit the current session's backend.
    if (backend === 'claude_code' || backend === 'codex_openrouter') {
      target.agentBackend = backend;
    }
    if (model != null) target.agentModel = model;
    return target;
  },

  // The venue THIS session is building in, in the shared vocabulary — and
  // the ONE answer every surface of the session reads (#1353). The header
  // dropdown states it, the sheet ticks it, and _launchpadVenue() decides
  // from it alone whether this session gets a composer or a launchpad.
  //
  // Everything the derivation needs already lives on the session row or in
  // the status poll; build-venues.js owns the precedence (imported first,
  // then a live lease, then the stored choice, then the hand-off, then the
  // backend) so this module and the session cards can't disagree about the
  // same session. The one thing that list cannot know about is a hand-off
  // picked in THIS tab and not yet recorded on any column, which is what
  // _pickedHandoffVenue() adds below.
  _currentVenueId() {
    if (!window.BuildVenues) return 'usernode-claude';
    const s = DevChat.currentSession || {};
    const shot = DevChat._shotVenue();
    if (shot) return shot;
    const derived = BuildVenues.currentVenue({
      source: s.source,
      localAgent: DevChat._localAgent || null,
      // #1281: the owner's stored choice, which is the only thing that can
      // say "handed over, not submitted yet" — and therefore the only thing
      // that keeps a launchpad on screen across a reload.
      buildVenue: s.build_venue,
      externalAgent: s.external_agent,
      agentBackend: DevChat._agentBackend(s),
    });
    // A recorded hand-off outranks an in-memory one for the same reason it
    // outranks everything else: it is the half that survives the tab.
    if (window.Launchpad && Launchpad.isLaunchpad(derived)) return derived;
    return DevChat._pickedHandoffVenue() || derived;
  },

  // The hand-off this TAB has picked for this session, before anything has
  // been stored about it — the out-of-credits card's "Use Claude Code", the
  // "+" menu's flow door, a shared `?flow=` link. All three set the
  // in-memory wizard and nothing else, so the column cannot answer for them.
  //
  // A SAVED DEFAULT is deliberately NOT one of them (#1353). It used to put
  // the walkthrough on screen for any untouched session, while the venue
  // derivation above — which never read it — went on saying Homeroom ·
  // Claude: the header and the sheet said "On-Platform" over a WebUI
  // launchpad, and the only way out was to pick another venue and come back,
  // once per tab, because a preference is not a choice about THIS session
  // and nothing recorded that you had left it. The default still names the
  // vendor a hand-off starts with, and the venue dropdown in the header is
  // where a session is handed over — deliberately, once, and recorded.
  _pickedHandoffVenue() {
    const flow = DevChat._devFlow;
    if (!flow || flow.dismissed) return null;
    if (flow.mode !== 'wizard' || !flow.agent) return null;
    return flow.agent === 'codex' ? 'web-codex' : 'web-claude-code';
  },

  // Screenshot-state deep link `?shot=launchpad&venue=<id>` (#1281).
  //
  // Same shape and the same rationale as ?shot=venue-fallback above. The
  // launchpad is a property of a session's stored venue, and a staging
  // clone's sessions have none — the column is empty on every seeded row,
  // and a reviewer has no way to pick a venue for a session they do not
  // own. So the URL names it.
  //
  // Ungated by environment, for the same reason its neighbour is: it paints
  // a panel derived from the session already on screen, reads nothing and
  // writes nothing. Nothing is persisted — only picking a venue calls
  // _persistBuildVenue — so a shot URL cannot change what anyone's session
  // is. A value that is not a launchpad venue renders nothing rather than
  // hiding the composer for a venue that keeps it.
  _shotVenue() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { return null; }
    if (shot !== 'launchpad') return null;
    let venue = null;
    try { venue = new URLSearchParams(location.search).get('venue'); } catch { return null; }
    return (window.Launchpad && Launchpad.isLaunchpad(venue)) ? venue : null;
  },

  // ── The launchpad (#1281) ────────────────────────────────────────────
  //
  // Three venues build somewhere else, and for all three a composer is the
  // wrong primary control: no turn will ever run here, so a text box that
  // looks like it starts one is a lie the wireframes deliberately remove.
  // The own-tools guide is a React child; launchpad.js supplies its context.
  // The two web hand-offs reuse the walkthrough
  // that has existed since #1049, re-sited from the transcript into the
  // composer's place.
  //
  // Returns the venue id when this session is in one, else null — which is
  // also the "should the composer be hidden?" question, asked once.
  //
  // It is asked of the VENUE and of nothing else (#1353). This used to
  // carry a second source — a wizard target derived from the user's saved
  // default — which _currentVenueId() knew nothing about, so the screen and
  // the session type it states could answer differently about the same
  // session: "On-Platform" in the header, the WebUI walkthrough underneath
  // it. One question, one answer, and _currentVenueId() is where every
  // input to it now meets.
  _launchpadVenue() {
    if (!window.Launchpad) return null;
    const venue = DevChat._currentVenueId();
    return Launchpad.isLaunchpad(venue) ? venue : null;
  },

  // The brief a hand-off starts from when the user has typed nothing: the
  // session's own title, which for a session opened from a request is that
  // request's title. Empty for a blank session, which is honest — there is
  // nothing to say yet.
  _defaultFlowBrief() {
    const s = DevChat.currentSession || {};
    return String(s.session_title || s.pr_title || '').trim();
  },

  // What the launchpad copy has to say about work already done here
  // (#1350). Three fields, read off the same derivation the venue sheet's
  // row labels use, so "Continue this session with Claude Code" in the
  // menu and the instructions the launchpad prints cannot disagree about
  // whether there is anything to continue.
  //
  // Before #1350 every session had a branch from the moment it was
  // created, so `targetKind` was only ever 'new' for a promoted one and
  // the launchpad could ignore the question. Now a session that has never
  // run a turn genuinely has none, and the two cases need different
  // instructions: continuing means `proposalId` and the session's head
  // commit, starting means neither.
  _launchpadResumeState() {
    const session = DevChat.currentSession || {};
    const state = window.BuildVenues ? DevChat._venueSheetState() : null;
    return {
      targetKind: state ? BuildVenues.webTargetKind(state) : 'new',
      targetId: session.id || null,
      branchName: session.branch_name || null,
    };
  },

  _launchpadHtml() {
    const venue = DevChat._launchpadVenue();
    if (!venue) return '';
    const resume = DevChat._launchpadResumeState();
    if (venue === 'own-tools-pr') return '';
    // web-claude-code / web-codex: the five-step walkthrough, which already
    // resolves every step from the server and resumes where the user left
    // off.
    //
    // The agent comes from the VENUE, not from _devFlowTarget(). The venue
    // is what put this launchpad on screen, so it is the thing that knows
    // which vendor it is for — and the target answers null in cases the
    // launchpad is legitimately up: a `?shot=launchpad` URL sets no stored
    // venue, and the target's saved-preference path additionally wants an
    // untouched session, a linked deployment and no PR. Going through it
    // rendered an EMPTY panel for those, which is what the web-codex check
    // caught.
    const flow = DevChat._devFlow;
    // The walkthrough paints "checking where you are" while the first read
    // is in flight, so it has to be kicked here as well as by the picker.
    if (!flow.status) DevChat._devFlowEnsureStatus();
    // The same banner the own-tools launchpad carries, prepended to the
    // vendor walkthrough. The walkthrough is dev-flow-select.js's and
    // predates #1350 by a long way: it knows how to hand a task to a web
    // agent but nothing about whether this session already has commits.
    // Rather than teach it, the one sentence that differs is rendered
    // here, from launchpad.js, so both hand-off venues say it the same
    // way and there is one copy to change.
    return Launchpad.resumeBannerHtml(resume) + DevFlowSelect.wizardHtml({
      agent: venue === 'web-codex' ? 'codex' : 'claude-code',
      status: flow.status,
      busy: flow.busy,
      error: flow.error,
      notice: flow.notice,
      brief: flow.brief != null ? flow.brief : DevChat._defaultFlowBrief(),
    });
  },

  _ownToolsGuideView() {
    if (DevChat._launchpadVenue() !== 'own-tools-pr') return null;
    const session = DevChat.currentSession || {};
    const resume = DevChat._launchpadResumeState();
    return {
      prompt: Launchpad.prefillText({
        ...resume,
        slug: App.currentApp || '',
        issueNumber: session.created_from_issue_number || null,
        sessionTitle: session.session_title || session.pr_title || '',
      }),
      resumeHtml: Launchpad.resumeBannerHtml(resume),
      canImport: !(typeof AppView !== 'undefined' && AppView.readOnly),
    };
  },

  _importOwnToolsPr() {
    if (typeof AppView !== 'undefined' && AppView.readOnly) return;
    if (typeof AppView !== 'undefined' && AppView.openImportPrModal) {
      AppView.openImportPrModal();
    } else {
      window.location.hash = '#settings/cli';
    }
  },

  // Repaint whichever surface the walkthrough is currently living on.
  //
  // Every dev-flow action used to end in renderMessages(), because the card
  // was the last row of the transcript. In a hand-off venue it is the
  // launchpad instead (#1281) and renderMessages deliberately omits it, so
  // repainting that way would leave the card frozen on the state it had
  // before the click — the "Check again" button would do nothing visible,
  // which is exactly the #1304 class of bug.
  _repaintDevFlow() {
    // Carry the half-typed brief across the rebuild.
    const typed = document.querySelector('[data-flow-brief]');
    if (typed) DevChat._devFlow.brief = String(typed.value || '');

    // BOTH halves of #1281's swap are published now — the launchpad slot's
    // markup and the composer's `hidden` — so a change in which of them is on
    // screen no longer needs a whole `renderChatView` to land. That branch
    // existed because the two were baked into one innerHTML string.
    DevChat._publishDevView();
    DevChat._publishComposer();
    DevChat._wireLaunchpad();
  },

  _wireLaunchpad() {
    const host = document.getElementById('dc-launchpad-slot');
    if (!host) return;
    // The walkthrough renders here now rather than in the transcript, so it
    // needs wiring here too — _wireDevFlowCard only ever scans #dc-messages,
    // and a card wired by nobody is the #1304 failure again.
    if (window.DevFlowSelect) {
      host.querySelectorAll('[data-flow-wizard]').forEach((el) => {
        DevFlowSelect.wire(el, {
          onAction: (action) => DevChat._devFlowAction(action),
        });
      });
    }
  },

  // Persist the venue this session is being built in (#1281).
  //
  // Fire-and-forget on purpose: the caller has already repainted from the
  // picked venue, and a failed write must not undo a switch the user can
  // see. The next reload derives from the columns, which is the same place
  // it started — a lost choice degrades to today's behaviour rather than to
  // a wrong one.
  async _persistBuildVenue(venueId) {
    const session = DevChat.currentSession;
    if (!session || !session.id) return;
    try {
      const res = await fetch(`/api/sessions/${session.id}/build-venue`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venue: venueId }),
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (!data.session) return;
      // Only the venue column is folded back in. The response is the whole
      // row, but a session the user has been typing into must not have its
      // live fields replaced by a snapshot taken before the last keystroke.
      if (DevChat.currentSession && Number(DevChat.currentSession.id) === Number(session.id)) {
        DevChat.currentSession.build_venue = data.session.build_venue;
      }
      const cached = DevChat.sessions.find((s) => Number(s.id) === Number(session.id));
      if (cached) cached.build_venue = data.session.build_venue;
    } catch { /* see above: a lost choice degrades to the derivation */ }
  },

  _busyComposerPlaceholder() {
    const name = DevChat._agentBackend(DevChat.currentSession) === 'codex_openrouter'
      ? 'OpenRouter'
      : 'Claude';
    return `${name} is working. Type your next note and tap 💾 to save it for later.`;
  },

  _formatOpenRouterPrice(value) {
    if (value == null || value === '') return null;
    const price = Number(value);
    if (!Number.isFinite(price) || price < 0) return null;
    if (price === 0) return '$0';
    const decimals = price < 0.01 ? 4 : price < 10 ? 2 : price < 100 ? 1 : 0;
    const fixed = price.toFixed(decimals);
    const compact = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
    return `$${compact}`;
  },

  _openRouterModelCostSummary(model) {
    const tier = {
      free: 'Free',
      low: 'Low cost',
      medium: 'Medium cost',
      high: 'High cost',
      unknown: 'Price unavailable',
    }[model?.costTier] || 'Price unavailable';
    const input = this._formatOpenRouterPrice(model?.inputPricePerMillion);
    const output = this._formatOpenRouterPrice(model?.outputPricePerMillion);
    if (!input && !output) return tier;
    return `${tier} · ${input || '?'} /M input · ${output || '?'} /M output`;
  },

  _openRouterModelOptionLabel(model) {
    const badges = [];
    if (model?.isFavorite) badges.push('★');
    if (model?.isRecommended) badges.push('Recommended');
    if (model?.createdAt) {
      const age = Date.now() - Date.parse(model.createdAt);
      if (Number.isFinite(age) && age >= 0 && age <= 30 * 24 * 60 * 60 * 1000) badges.push('New');
    }
    const compatibility = model?.compatibility === 'verified'
      ? ' · verified'
      : (model?.compatibility === 'blocked' ? ' · limited' : ' · unverified');
    const badgeText = badges.length ? ` · ${badges.join(' · ')}` : '';
    return `${model?.name || model?.id || 'Unknown model'}${badgeText}: ${this._openRouterModelCostSummary(model)}${compatibility}`;
  },

  _openRouterModelsForPicker(models, { query = '', favoritesOnly = false } = {}) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    return (Array.isArray(models) ? models : [])
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => {
        if (favoritesOnly && model?.isFavorite !== true) return false;
        if (!needle) return true;
        return [model?.name, model?.id, model?.provider, model?.canonicalSlug]
          .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
      })
      .sort((a, b) => {
        if (!!a.model?.isFavorite !== !!b.model?.isFavorite) return a.model?.isFavorite ? -1 : 1;
        if (!!a.model?.isRecommended !== !!b.model?.isRecommended) return a.model?.isRecommended ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ model }) => model);
  },

  // A task picker should start with the useful shortlist, while preserving a
  // current non-favorite selection. The latter matters when somebody picked
  // an uncommon model deliberately: merely opening the dialog must not move
  // them to the first recommended model.
  _openRouterFavoritesOnlyByDefault(models, selectedModel) {
    const selected = (Array.isArray(models) ? models : [])
      .find((model) => model?.id === selectedModel);
    return selected?.isFavorite === true;
  },

  _openRouterCatalogAgeText(refreshedAt) {
    const refreshed = Date.parse(refreshedAt || '');
    if (!Number.isFinite(refreshed)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - refreshed) / 1000));
    if (seconds < 60) return 'Updated just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Updated ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `Updated ${hours}h ago`;
  },

  async _setOpenRouterModelFavorite(modelId, favorite) {
    const response = await fetch('/api/me/coding-agent/models/favorite', {
      method: 'PATCH',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, favorite }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not update that favorite.');
    return body;
  },

  _openRouterModelCompatibilitySummary(model) {
    if (!model) return '';
    if (model.compatibility === 'verified') return 'Verified for repository coding.';
    if (model.meetsCodexMinimums) {
      return 'OpenRouter advertises coding-tool support and enough context, but this model is not yet verified for repository coding.';
    }
    return model.compatibilityNote
      || 'OpenRouter exposes this model, but it may lack repository tools or enough context; the turn may fail.';
  },

  // Prepare the saved provider for a REAL build action (currently Generate
  // proposal). This is deliberately not called by a page-load/status read:
  // creating a company-funded credential is a write and should happen only
  // after the user asks Usernode to do work. An explicit Claude default is
  // preserved. Everyone else who is eligible for OpenRouter gets the
  // included managed key on first use, and provisioning errors are returned
  // to the caller verbatim rather than being hidden behind a Claude fallback.
  async _prepareDefaultCodingAgentForBuild() {
    const readPreferences = async () => {
      const response = await fetch('/api/me/coding-agent', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not load your coding-agent settings.');
      }
      return body;
    };

    let prefs = await readPreferences();
    const explicitClaude = prefs.backends?.claude_code?.isDefault === true;
    if (explicitClaude) return prefs;
    if (!prefs.codexAvailable) {
      // This mirrors the server's deliberate flag/beta policy fallback.
      return { ...prefs, defaultBackend: 'claude_code' };
    }

    const readCredentialStatus = async () => {
      const response = await fetch('/api/me/credentials/openrouter', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not check your OpenRouter credential.');
      }
      return body;
    };
    let status = await readCredentialStatus();
    if (status.configured === true && status.status === 'valid') {
      if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = true;
      // The key may have appeared in another tab after the preference read.
      // Re-read only in that mismatched state so the modal and the server do
      // not choose different providers for the same request.
      if (prefs.defaultBackend !== 'codex_openrouter') prefs = await readPreferences();
      return { ...prefs, openrouterCredentialSource: status.source || null };
    }

    let openrouterCredentialSource = null;
    const provisionResponse = await fetch('/api/me/credentials/openrouter/managed', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const provisioned = await provisionResponse.json().catch(() => ({}));
    if (!provisionResponse.ok) {
      // Two build clicks can race. The loser sees the reservation's
      // byok_configured/already_issued conflict after the winner has saved a
      // valid key; re-read once and accept that completed state. A conflict
      // without a usable credential is a real problem and remains visible.
      if (['byok_configured', 'already_issued'].includes(provisioned.code)) {
        status = await readCredentialStatus();
        openrouterCredentialSource = status.source || null;
      }
      if (status.configured !== true || status.status !== 'valid') {
        const err = new Error(
          provisioned.error
            || `OpenRouter could not be set up automatically (HTTP ${provisionResponse.status}).`,
        );
        err.code = provisioned.code || 'provision_failed';
        throw err;
      }
    } else {
      // This request created the company-funded key, even on older servers
      // whose successful response predates the explicit `source` field.
      openrouterCredentialSource = provisioned.source || 'usernode_managed';
    }

    if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = true;
    prefs = await readPreferences();
    if (prefs.defaultBackend !== 'codex_openrouter') {
      throw new Error('OpenRouter was created, but it was not saved as your default. Contact an administrator.');
    }
    return { ...prefs, openrouterCredentialSource };
  },

  async _loadCodingAgentChoiceData({ forceRefresh = false } = {}) {
    const data = {
      defaultBackend: 'claude_code',
      backends: {},
      codexAvailable: false,
      credentialConfigured: false,
      models: [],
      recommendedModelId: null,
      refreshedAt: null,
      totalModels: 0,
      catalogLoaded: false,
      loadError: null,
      catalogError: null,
    };

    try {
      const prefsRes = await fetch('/api/me/coding-agent', { credentials: 'same-origin' });
      if (!prefsRes.ok) throw new Error('Could not load your coding-agent settings.');
      const prefs = await prefsRes.json();
      data.defaultBackend = prefs.defaultBackend === 'codex_openrouter'
        ? 'codex_openrouter'
        : 'claude_code';
      data.backends = prefs.backends || {};
      data.codexAvailable = !!prefs.codexAvailable;
    } catch (err) {
      data.loadError = err.message || 'Could not load coding-agent settings.';
      return data;
    }

    try {
      const credentialRes = await fetch('/api/me/credentials/openrouter', {
        credentials: 'same-origin',
      });
      if (!credentialRes.ok) throw new Error('Could not check your OpenRouter key.');
      const credential = await credentialRes.json();
      data.credentialConfigured = credential.configured === true && credential.status === 'valid';
    } catch (err) {
      data.catalogError = err.message || 'Could not check your OpenRouter key.';
      return data;
    }

    if (!data.codexAvailable || !data.credentialConfigured) return data;

    try {
      const refresh = forceRefresh ? '&refresh=1' : '';
      const modelsRes = await fetch(`/api/me/coding-agent/models?backend=codex_openrouter${refresh}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const catalog = await modelsRes.json().catch(() => ({}));
      if (!modelsRes.ok) throw new Error(catalog.error || 'Could not load OpenRouter models.');
      data.catalogLoaded = true;
      data.models = Array.isArray(catalog.models) ? catalog.models : [];
      data.recommendedModelId = catalog.recommendedModelId || null;
      data.refreshedAt = catalog.refreshedAt || null;
      data.totalModels = Number.isInteger(catalog.totalModels) ? catalog.totalModels : data.models.length;
      if (!data.models.length) data.catalogError = 'No OpenRouter models are available under this key.';
    } catch (err) {
      data.catalogError = err.message || 'Could not load OpenRouter models.';
    }
    return data;
  },

  async _chooseCodingAgent({ mode = 'create', current = null, fixedBackend = null } = {}) {
    const data = await DevChat._loadCodingAgentChoiceData();
    if (typeof document === 'undefined' || !document.body) return null;

    document.getElementById('dc-agent-choice-modal')?.remove();

    const savedCodex = data.backends?.codex_openrouter || {};
    let selectedBackend = fixedBackend || current?.backend || data.defaultBackend || 'claude_code';
    if (!['claude_code', 'codex_openrouter'].includes(selectedBackend)) {
      selectedBackend = 'claude_code';
    }
    const openRouterModelOnly = fixedBackend === 'codex_openrouter';
    let availableIds = new Set(data.models.map((m) => m.id));
    const recommendedModel = availableIds.has(data.recommendedModelId)
      ? data.recommendedModelId
      : (data.models.find((m) => m.compatibility === 'verified')?.id || data.models[0]?.id || '');
    let selectedModel = current?.model || savedCodex.model || recommendedModel;
    if (!availableIds.has(selectedModel)) selectedModel = recommendedModel;
    let selectedEffort = current?.reasoningEffort || savedCodex.reasoningEffort || '';

    const overlay = document.createElement('div');
    overlay.id = 'dc-agent-choice-modal';
    overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4';
    overlay.innerHTML = `
      <div class="w-full max-w-lg rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="dc-agent-choice-title">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 id="dc-agent-choice-title" class="text-lg font-bold text-zinc-900 dark:text-zinc-100">${openRouterModelOnly ? 'Choose an OpenRouter model' : (mode === 'switch' ? 'Where should this session build?' : 'Where should this build?')}</h2>
            <p class="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">${openRouterModelOnly ? 'Changing the model keeps this branch and conversation, but starts fresh OpenRouter context on the next turn.' : (mode === 'switch' ? 'Switching keeps this branch and conversation, but starts a fresh coding-agent context on the next turn.' : 'Both agents stay available. Your saved default is preselected; this choice is pinned to the new session.')}</p>
          </div>
          <button type="button" id="dc-agent-choice-close" class="shrink-0 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label="Close">✕</button>
        </div>
        <div class="mt-4 grid gap-2 sm:grid-cols-2 ${openRouterModelOnly ? 'hidden' : ''}" role="radiogroup" aria-label="Session AI">
          <button type="button" id="dc-agent-choice-codex" role="radio" class="rounded-lg border p-3 text-left transition-colors">
            <span class="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Homeroom · OpenRouter</span>
            <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">Preferred. Use your included credits or personal key, with any available model.</span>
            ${data.defaultBackend === 'codex_openrouter' ? '<span class="mt-2 inline-block rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">Saved default</span>' : ''}
          </button>
          <button type="button" id="dc-agent-choice-claude" role="radio" class="rounded-lg border p-3 text-left transition-colors">
            <span class="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Homeroom · Claude</span>
            <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">Use the platform Claude allowance instead.</span>
            ${data.defaultBackend === 'claude_code' ? '<span class="mt-2 inline-block rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">Saved default</span>' : ''}
          </button>
        </div>
        <div id="dc-agent-choice-codex-options" class="mt-4 hidden rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <label for="dc-agent-choice-model" class="block text-xs font-medium text-zinc-700 dark:text-zinc-300">OpenRouter model</label>
          <div class="mt-1 flex flex-wrap gap-2">
            <input id="dc-agent-choice-model-search" type="search" autocomplete="off" placeholder="Filter by model or provider…" class="min-w-0 flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500">
            <button type="button" id="dc-agent-choice-favorites-only" aria-pressed="false" class="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">☆ Favorites</button>
            <button type="button" id="dc-agent-choice-refresh-models" class="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50">Refresh</button>
          </div>
          <div class="mt-2 flex items-stretch gap-2">
            <select id="dc-agent-choice-model" class="min-w-0 flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"></select>
            <button type="button" id="dc-agent-choice-star-model" aria-pressed="false" class="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-lg leading-none text-zinc-700 dark:text-zinc-300 disabled:opacity-50" aria-label="Add selected model to favorites" title="Add selected model to favorites">☆</button>
          </div>
          <p id="dc-agent-choice-catalog-meta" class="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400"></p>
          <p class="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">Platform recommendations start in Favorites. Clear the Favorites filter to browse the complete key-visible catalog. Rates are per 1M tokens; actual spend depends on usage.</p>
          <label for="dc-agent-choice-effort" class="mt-3 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Reasoning effort</label>
          <select id="dc-agent-choice-effort" class="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500">
            <option value="">Default</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </div>
        <p id="dc-agent-choice-status" class="mt-3 min-h-[1.25rem] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"></p>
        <div class="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" id="dc-agent-choice-settings" class="hidden rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">Open OpenRouter settings</button>
          <button type="button" id="dc-agent-choice-cancel" class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
          <button type="button" id="dc-agent-choice-apply" class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const claudeButton = overlay.querySelector('#dc-agent-choice-claude');
    const codexButton = overlay.querySelector('#dc-agent-choice-codex');
    const codexOptions = overlay.querySelector('#dc-agent-choice-codex-options');
    const modelSelect = overlay.querySelector('#dc-agent-choice-model');
    const modelSearch = overlay.querySelector('#dc-agent-choice-model-search');
    const favoritesOnlyButton = overlay.querySelector('#dc-agent-choice-favorites-only');
    const refreshModelsButton = overlay.querySelector('#dc-agent-choice-refresh-models');
    const starModelButton = overlay.querySelector('#dc-agent-choice-star-model');
    const catalogMeta = overlay.querySelector('#dc-agent-choice-catalog-meta');
    const effortSelect = overlay.querySelector('#dc-agent-choice-effort');
    const status = overlay.querySelector('#dc-agent-choice-status');
    const settingsButton = overlay.querySelector('#dc-agent-choice-settings');
    const applyButton = overlay.querySelector('#dc-agent-choice-apply');

    // New/default OpenRouter tasks land on the curated recommended favorites
    // instead of making the user scan the whole provider catalog. If the
    // session is already on a non-favorite, keep All models visible so merely
    // opening this dialog never changes the pinned selection.
    let favoritesOnly = this._openRouterFavoritesOnlyByDefault(data.models, selectedModel);
    effortSelect.value = selectedEffort;

    const cardClass = (selected) => `rounded-lg border p-3 text-left transition-colors ${selected
      ? 'border-violet-500 bg-violet-500/5 ring-1 ring-violet-500'
      : 'border-zinc-300 dark:border-zinc-700 hover:border-violet-400'}`;

    const renderModelOptions = () => {
      const visibleModels = this._openRouterModelsForPicker(data.models, {
        query: modelSearch.value,
        favoritesOnly,
      });
      modelSelect.innerHTML = '';
      for (const model of visibleModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = this._openRouterModelOptionLabel(model);
        modelSelect.appendChild(option);
      }
      if (visibleModels.some((model) => model.id === selectedModel)) {
        modelSelect.value = selectedModel;
      } else {
        selectedModel = visibleModels[0]?.id || '';
        modelSelect.value = selectedModel;
      }
      modelSelect.disabled = visibleModels.length === 0;
      favoritesOnlyButton.setAttribute('aria-pressed', String(favoritesOnly));
      favoritesOnlyButton.textContent = favoritesOnly ? '★ Favorites' : '☆ Favorites';
      const age = this._openRouterCatalogAgeText(data.refreshedAt);
      catalogMeta.textContent = visibleModels.length
        ? `${visibleModels.length} of ${data.totalModels || data.models.length} models${age ? ` · ${age}` : ''}`
        : `No key-visible models match. Refresh, then check this key's OpenRouter account policies${age ? ` · ${age}` : ''}`;
      if (!visibleModels.length) {
        starModelButton.disabled = true;
        starModelButton.textContent = '☆';
        starModelButton.setAttribute('aria-pressed', 'false');
        effortSelect.disabled = true;
        effortSelect.value = '';
      }
    };

    const render = () => {
      const codex = selectedBackend === 'codex_openrouter';
      claudeButton.className = cardClass(!codex);
      codexButton.className = cardClass(codex);
      claudeButton.setAttribute('aria-checked', String(!codex));
      codexButton.setAttribute('aria-checked', String(codex));
      codexOptions.classList.toggle('hidden', !codex);
      settingsButton.classList.toggle('hidden', !codex);

      applyButton.disabled = false;
      const venueName = codex ? 'Homeroom · OpenRouter' : 'Homeroom · Claude';
      applyButton.textContent = openRouterModelOnly
        ? 'Use this OpenRouter model'
        : (mode === 'switch' ? `Switch to ${venueName}` : `Build on ${venueName}`);

      if (!codex) {
        status.textContent = data.loadError
          ? `${data.loadError} Homeroom · Claude is still available.`
          : 'Homeroom · Claude builds in this chat on your daily Homeroom credits.';
        return;
      }
      if (data.loadError) {
        status.textContent = data.loadError;
        applyButton.disabled = true;
        return;
      }
      if (!data.codexAvailable) {
        status.textContent = 'Homeroom · OpenRouter is not enabled for this account or deployment.';
        applyButton.disabled = true;
        return;
      }
      if (!data.credentialConfigured) {
        status.textContent = data.catalogError || 'Add your OpenRouter API key before choosing OpenRouter.';
        applyButton.textContent = 'Set up OpenRouter';
        return;
      }
      if (!data.models.length) {
        status.textContent = data.catalogError || 'No OpenRouter models are available under this key.';
        applyButton.disabled = true;
        return;
      }
      const model = data.models.find((item) => item.id === selectedModel) || null;
      if (!model) {
        status.textContent = "No key-visible models match. Refresh, then check this key's OpenRouter account policies.";
        applyButton.disabled = true;
        starModelButton.disabled = true;
        starModelButton.textContent = '☆';
        starModelButton.setAttribute('aria-pressed', 'false');
        return;
      }
      starModelButton.disabled = false;
      starModelButton.textContent = model.isFavorite ? '★' : '☆';
      starModelButton.setAttribute('aria-pressed', String(model.isFavorite === true));
      starModelButton.setAttribute('aria-label', model.isFavorite
        ? 'Remove selected model from favorites'
        : 'Add selected model to favorites');
      starModelButton.title = starModelButton.getAttribute('aria-label');
      const supportsReasoning = model?.supportsReasoning === true;
      effortSelect.disabled = !supportsReasoning;
      if (supportsReasoning) {
        effortSelect.value = selectedEffort;
      } else {
        effortSelect.value = '';
      }
      const reasoningNote = supportsReasoning
        ? ''
        : ' This model does not expose reasoning-effort controls.';
      status.textContent = `${this._openRouterModelCostSummary(model)}. ${this._openRouterModelCompatibilitySummary(model)}${reasoningNote} This session bills directly to your OpenRouter key.`;
    };

    claudeButton.addEventListener('click', () => { selectedBackend = 'claude_code'; render(); });
    codexButton.addEventListener('click', () => { selectedBackend = 'codex_openrouter'; render(); });
    modelSelect.addEventListener('change', () => { selectedModel = modelSelect.value; render(); });
    modelSearch.addEventListener('input', () => { renderModelOptions(); render(); });
    favoritesOnlyButton.addEventListener('click', () => {
      favoritesOnly = !favoritesOnly;
      renderModelOptions();
      render();
    });
    starModelButton.addEventListener('click', async () => {
      const model = data.models.find((item) => item.id === selectedModel);
      if (!model || starModelButton.disabled) return;
      const favorite = model.isFavorite !== true;
      starModelButton.disabled = true;
      try {
        await this._setOpenRouterModelFavorite(model.id, favorite);
        model.isFavorite = favorite;
        renderModelOptions();
        render();
      } catch (err) {
        status.textContent = err.message || 'Could not update that favorite.';
        starModelButton.disabled = false;
      }
    });
    refreshModelsButton.addEventListener('click', async () => {
      refreshModelsButton.disabled = true;
      refreshModelsButton.textContent = 'Refreshing…';
      try {
        const fresh = await this._loadCodingAgentChoiceData({ forceRefresh: true });
        if (fresh.loadError || (!fresh.catalogLoaded && fresh.catalogError)) {
          throw new Error(fresh.loadError || fresh.catalogError);
        }
        data.codexAvailable = fresh.codexAvailable;
        data.credentialConfigured = fresh.credentialConfigured;
        data.catalogError = fresh.catalogError;
        data.models = fresh.models;
        data.recommendedModelId = fresh.recommendedModelId;
        data.refreshedAt = fresh.refreshedAt;
        data.totalModels = fresh.totalModels;
        availableIds = new Set(data.models.map((model) => model.id));
        const nextRecommended = availableIds.has(data.recommendedModelId)
          ? data.recommendedModelId
          : (data.models.find((model) => model.isRecommended)?.id
            || data.models.find((model) => model.compatibility === 'verified')?.id
            || data.models[0]?.id
            || '');
        if (!availableIds.has(selectedModel)) selectedModel = nextRecommended;
        renderModelOptions();
        render();
      } catch (err) {
        status.textContent = err.message || 'Could not refresh OpenRouter models.';
      } finally {
        refreshModelsButton.disabled = false;
        refreshModelsButton.textContent = 'Refresh';
      }
    });
    effortSelect.addEventListener('change', () => { selectedEffort = effortSelect.value; });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
        resolve(value);
      };
      const openSettings = () => {
        finish(null);
        window.location.hash = '#settings/openrouter';
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') finish(null);
      };
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('#dc-agent-choice-close').addEventListener('click', () => finish(null));
      overlay.querySelector('#dc-agent-choice-cancel').addEventListener('click', () => finish(null));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
      settingsButton.addEventListener('click', openSettings);
      applyButton.addEventListener('click', () => {
        if (applyButton.disabled) return;
        if (selectedBackend === 'codex_openrouter' && !data.credentialConfigured) {
          openSettings();
          return;
        }
        finish({
          backend: selectedBackend,
          model: selectedBackend === 'codex_openrouter' ? selectedModel : null,
          reasoningEffort: selectedBackend === 'codex_openrouter'
            ? (effortSelect.value || null)
            : null,
        });
      });
      renderModelOptions();
      render();
      (openRouterModelOnly
        ? modelSearch
        : (selectedBackend === 'codex_openrouter' ? codexButton : claudeButton)).focus();
    });
  },

  // `explicit` is a {backend, model, reasoningEffort} the caller already
  // has — the venue sheet picked it, so re-asking through the old modal
  // would be asking the same question twice. Omitted, this still opens the
  // detail chooser, which is what the unified select's "Add more" action
  // needs (a backend is not a complete answer: it wants a model and effort).
  async _switchCurrentCodingAgent(explicit, { fixedBackend = null } = {}) {
    const session = DevChat.currentSession;
    if (!session || DevChat.isStreaming) return;
    const current = {
      backend: DevChat._agentBackend(session),
      model: session.agent_model || null,
      reasoningEffort: session.agent_reasoning_effort || null,
    };
    const choice = explicit || await DevChat._chooseCodingAgent({
      mode: 'switch',
      current,
      fixedBackend,
    });
    if (!choice || !DevChat.currentSession || DevChat.currentSession.id !== session.id) return;

    const same = choice.backend === current.backend
      && (choice.model || null) === (current.model || null)
      && (choice.reasoningEffort || null) === (current.reasoningEffort || null);
    if (same) {
      PlatformUI.toast(`${DevChat._agentName(choice.backend)} is already selected for this session.`);
      return;
    }

    try {
      const response = await fetch(`/api/sessions/${session.id}/reset-agent-context`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(choice),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        PlatformUI.toast(data.error || 'Could not switch coding agents.');
        return;
      }
      Object.assign(DevChat.currentSession, data.session || {});
      const cached = DevChat.sessions.find((s) => Number(s.id) === Number(session.id));
      if (cached) Object.assign(cached, data.session || {});
      if (data.message) DevChat.messages.push(data.message);
      DevChat.renderChatView();
      PlatformUI.toast(`This session now uses ${DevChat._agentName(choice.backend)}.`);
    } catch {
      PlatformUI.toast('Network error while switching coding agents.');
    }
  },

  // Switch this session to whichever on-platform agent the user ran last
  // (#1348).
  //
  // The same endpoint as _switchCurrentCodingAgent, with NO backend key —
  // which POST reset-agent-context reads as "resolve my stored preference",
  // the way POST /sessions already does at creation. It is a separate method
  // rather than a flag on that one because the two differ in what they can
  // answer: an explicit switch knows its backend up front and can say "that
  // one is already selected"; this one only learns the answer from the
  // response, and the answer may be a FALLBACK — a stored OpenRouter
  // preference whose flag, beta access, model or key no longer stands. That
  // reason goes to the same sentence above the composer a new session uses,
  // which is the only place it is ever explained.
  async _switchToLastUsedPlatformAgent() {
    const session = DevChat.currentSession;
    if (!session || DevChat.isStreaming) return;
    try {
      const response = await fetch(`/api/sessions/${session.id}/reset-agent-context`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // Deliberately empty: a `backend: null` would be a VALUE, and the
        // route reads a named backend as an explicit choice.
        body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        PlatformUI.toast(data.error || 'Could not switch to the platform agent.');
        return;
      }
      if (!DevChat.currentSession || DevChat.currentSession.id !== session.id) return;
      // EVERY column except build_venue. This response is a whole session
      // row read on the server, and the caller is clearing the venue
      // through a DIFFERENT route at the same time — so the row can carry
      // the venue this switch is leaving, and assigning it wholesale puts
      // the launchpad back on screen a moment after the pick removed it.
      // reset-agent-context owns the agent columns; build_venue is
      // /build-venue's, and the local clear above is the newer answer.
      const { build_venue: leavingVenue, ...agentFields } = data.session || {};
      void leavingVenue;
      Object.assign(DevChat.currentSession, agentFields);
      const cached = DevChat.sessions.find((s) => Number(s.id) === Number(session.id));
      if (cached) Object.assign(cached, agentFields);
      if (data.message) DevChat.messages.push(data.message);
      if (data.agentFallbackReason) {
        DevChat._venueFallbackReason = data.agentFallbackReason;
      }
      // No toast on the way out (#1348 follow-up). A successful pick used to
      // pop "This session now uses Homeroom · Claude." here — and only here:
      // the sheet's other three rows change the session in silence, so the
      // same act announced itself in one state out of four. The screen is
      // already the announcement. The repaint above swaps a launchpad back
      // for the composer, the header dropdown names the venue that resolved
      // (which is how somebody with both in-chat agents sees WHICH one this
      // was), reset-agent-context's own message lands in the transcript, and
      // a preference that no longer validates says so in the sentence above
      // the composer. A failed switch still speaks, in both branches around
      // this one: nothing on screen changes when the round trip fails.
      DevChat.renderChatView();
    } catch {
      PlatformUI.toast('Network error while switching coding agents.');
    }
  },

  // Which session a web hand-off pushes back onto — null when it starts
  // separate work. Read off the shared derivation rather than carried on a
  // row, now that the sheet's rows are coarse (#1348).
  _webHandoffTargetId() {
    if (!window.BuildVenues) return null;
    const state = DevChat._venueSheetState();
    return BuildVenues.webTargetKind(state) !== 'new' && state.sessionId != null
      ? state.sessionId
      : null;
  },

  // ── #907: where the next coding turn runs ────────────────────────────
  //
  // The platform, not this page, decides: if a machine holds a lease on the
  // session, runClaudeCodeTool hands the turn to it. So these controls are a
  // readout plus one action, never a preference. `_runner` is where the LAST
  // turn ran; `_localAgent` is the machine attached right now (null when
  // none is). Both come from GET /api/sessions/:id/status.
  _runner: null,
  _localAgent: null,
  _runnerLabel: null,

  // #907: the page's ?demo=1 rides along on the /status read so a staging
  // preview can show the Run-on selector and the "Running on your machine"
  // chip. Server-side the injection is gated on IS_STAGING && ?demo=1 — same
  // pass-through as home.js/settings.js. Wrapped because a status read must
  // never be skipped over a query-string parse; `busy` restoration rides on
  // the same request and losing it would leave a live turn showing Send.
  _demoQS() {
    try {
      const demo = new URLSearchParams(location.search).get('demo');
      // `demo=session` (#1071) is the second staging demo shape for the
      // dev-flow walkthrough: the same five steps continuing a session
      // nobody has voted on rather than a promoted proposal. Forwarding the
      // discriminator is all the client has to do — every route that reads
      // it still tests for '1', so the other demo branches stay off.
      return demo === '1' || demo === 'session' ? `?demo=${demo}` : '';
    } catch { return ''; }
  },

  // The dev-flow status route takes a SECOND fixture discriminator,
  // `?order=plain`, which narrows whichever payload `demo` selected to an
  // ordinary work order that continues nothing.
  //
  // It is appended here rather than inside _demoQS, and that is deliberate.
  // _demoQS feeds /api/sessions/:id/status and /spec as well, and those — like
  // most fixture routes — test `demo` for exactly '1'. Widening its allowlist
  // to carry this would send them a value they do not recognise and blank the
  // very session the walkthrough is rendered inside; leaving the allowlist
  // alone and inventing a new `demo` value instead fails the allowlist and
  // sends no fixture at all. Both were real: the second one shipped, and the
  // declared checks on the plain fixture caught it.
  // Every `order` value the status route understands. This list is the whole
  // mechanism and it has been wrong twice: `?order=plain` shipped read by the
  // server and forwarded by nobody, and then `?order=none` did the same thing
  // again, because the check here was a hardcoded === against one value. A
  // fixture shape added on one side and not the other renders NOTHING, and
  // renders it silently. tests/dev-flow-routes.test.js scrapes the route's own
  // `req.query.order === '…'` literals and fails when this list does not cover
  // them, so the next one cannot repeat it.
  DEV_FLOW_ORDERS: ['connect', 'continue'],

  _devFlowDemoQS() {
    const base = DevChat._demoQS();
    if (!base) return '';
    try {
      const order = new URLSearchParams(location.search).get('order');
      return DevChat.DEV_FLOW_ORDERS.includes(order) ? `${base}&order=${order}` : base;
    } catch { return base; }
  },

  // Fold a status payload into the runner state and repaint if it changed.
  // Called from every place that reads /status — opening a session, the
  // during-turn poll, and the idle poll — so all three agree.
  _applyRunnerState(data) {
    if (!data) return;
    const nextRunner = data.runner || null;
    const next = data.localAgent || null;
    // runnerLabel outlives the lease: it is the name of the machine the last
    // turn ran on, which is what the past-tense chip needs after that machine
    // has detached and `localAgent` has gone null.
    const nextLabel = data.runnerLabel || null;
    const sameAgent = (next?.leaseId || null) === (DevChat._localAgent?.leaseId || null)
      && (next?.label || null) === (DevChat._localAgent?.label || null);
    if (sameAgent && nextRunner === DevChat._runner && nextLabel === DevChat._runnerLabel) return;
    DevChat._runner = nextRunner;
    DevChat._runnerLabel = nextLabel;
    DevChat._localAgent = next;
    DevChat._renderRunnerControls();
  },

  // Paint the "Run on" selector and, when a turn is going to (or did) run
  // elsewhere, the chip that says so. Deliberately silent — renders nothing
  // at all — for the overwhelmingly common case of a session with no machine
  // attached that has never run one, so the composer row is unchanged for
  // everyone not using this.
  _renderRunnerControls() {
    const host = document.getElementById('dc-runner');
    if (!host) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react) return;
    // The host is the COMPOSER's now — `RunnerControlsBar` renders the span
    // as well as its contents, because the whole bar converted. What is left
    // here is the state, and the DOM probe above, which is how this decides
    // there is a composer on screen at all.
    react.publishRunner(DevChat._runnerView());
  },

  // Which of the three states the "Run on" strip is in. An OpenRouter session
  // has no platform runner to talk about, and neither does a session with no
  // machine attached that has never run one — both draw nothing, which is
  // what keeps the composer row unchanged for everyone not using this.
  //
  // `_runnerLabel` outlives the lease on purpose: it is the name of the
  // machine the LAST turn ran on, which is exactly what the past-tense chip
  // needs once that machine has detached and `_localAgent` has gone null.
  _runnerView() {
    if (DevChat._isOpenRouterSession()) return { kind: 'none', label: '' };
    const agent = DevChat._localAgent;
    if (!agent && DevChat._runner !== 'local') return { kind: 'none', label: '' };
    const label = agent?.label || DevChat._runnerLabel || 'your machine';
    return { kind: agent ? 'live' : 'past', label };
  },

  // Release the lease from the browser. This is the escape hatch for the
  // machine that was closed without detaching: it must not need that machine
  // to cooperate, which is why it goes through the account route rather than
  // asking the agent to stand down.
  async _handBackToUsernode() {
    const agent = DevChat._localAgent;
    if (!agent || agent.demo) return;
    const label = agent.label || 'your machine';
    if (!confirm(`Hand coding turns back to Homeroom?\n\n${label} stops receiving turns for this session. Anything it already committed stays on the branch.`)) return;
    try {
      const res = await fetch(`/api/me/local-agents/${encodeURIComponent(agent.leaseId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.status !== 204 && res.status !== 404) throw new Error('detach failed');
      DevChat._localAgent = null;
      DevChat._renderRunnerControls();
    } catch {
      alert('Could not hand the session back. Try again in a moment.');
    }
  },

  // Guard against a persisted model id that's no longer in MODELS
  // (e.g. we removed an old model). Without this the dropdown would
  // fall back to the first option visually while `selectedModel` held
  // the stale id — so the user would see "Haiku" on screen but send
  // some ancient slug on submit. Called right after module load and
  // again after loadModels() refreshes the allowlist.
  _sanitizeStoredModel() {
    if (!DevChat.MODELS[DevChat.selectedModel]) {
      DevChat.selectedModel = DevChat._defaultModel;
    }
  },

  // ── Model selector copy (#800) ────────────────────────────────
  // Replaced the old "$X/MTok" option text. One fact per model: editorial
  // guidance on the KIND of work it suits (not a size ladder — Opus is
  // the general coding pick at any size, #809; Fable is for design and
  // taste judgment plus the most difficult coding work). Both helpers
  // take a
  // `{ label, changeSize }` meta object. Generate proposal now consumes the
  // short guidance directly, but these helpers remain safe for an older
  // cached shell during a rolling update. Nothing measured feeds either one.

  MODEL_GUIDANCE_TOOLTIP: 'A suggestion, not a rule. Any model can attempt any change. Opus is the general coding pick; reach for Fable when design judgment matters or the coding is genuinely difficult. Both cost more per change than Sonnet.',

  // Plain text for one <option>. Degrades to the bare label when the
  // server sent no guidance (e.g. an older payload).
  modelOptionText(meta) {
    if (!meta || typeof meta !== 'object') return String(meta || '');
    const label = meta.label || '';
    const hint = meta.changeSize && meta.changeSize.short;
    if (!hint) return label;
    return `${label}: ${hint}`;
  },

  // Full-sentence caption retained for an older cached shell during a rolling
  // update. Neither the composer nor the simplified Generate-proposal dialog
  // renders it now. Returns '' when there's no guidance to show.
  modelNoteText(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const label = meta.label || '';
    const long = meta.changeSize && meta.changeSize.long;
    if (!long) return '';
    // "One small thing at a time: …" reads as "best for one small thing
    // at a time: …" once it follows the label.
    const guidance = long.charAt(0).toLowerCase() + long.slice(1);
    return `${label}: best for ${guidance}`;
  },

  // Clears all per-app state. Called when the user leaves an app (via
  // `AppView.close()`), so that opening another app and switching to the
  // dev chat tab shows a fresh session list instead of re-rendering the
  // previous app's session.
  reset() {
    DevChat._stopSpendPolling();
    // #161: leaving the app (home / different app) while a turn is
    // running counts as leaving the session — arm its completion
    // notification before the state below is dropped.
    if (DevChat.isStreaming && DevChat.currentSession) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    }
    DevChat.sessions = [];
    DevChat.currentSession = null;
    DevChat._publishPreview();
    DevChat.messages = [];
    DevChat.isStreaming = false;
    DevChat.setTitleStatus(null);
    DevChat._staleTimer = null;
    DevChat._lastSeenSeq = null;
    DevChat._resetSpecViewer();
    DevChat._resetStagingPanel();
    if (DevChat._abortController) {
      try { DevChat._abortController.abort(); } catch {}
      DevChat._abortController = null;
    }
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  /**
   * Publish whether the OPEN session has a staging preview (Streamlined
   * Concept).
   *
   * The header's eye is the preview affordance on a session screen — the
   * same eye glyph the cards draw through AppView.cardPreviewHtml, gated on
   * the same `staging_url` — so it must only render when there is something
   * to preview. Called wherever `currentSession` or its `staging_url`
   * changes; `window.Improve` is the bundle's own controller, optional-called
   * because the vm harnesses that evaluate this file have no bundle.
   */
  _publishPreview() {
    const s = DevChat.currentSession;
    if (!s) { window.Improve?.setSessionPreview?.(null); return; }
    // #2069: a session with no live preview is not necessarily a session with
    // nothing to preview. ensure-staging rebuilds from the branch's latest
    // commit, and `can_preview` is the server's answer to "is there one" — so
    // the eye is published as BUILDABLE rather than withheld, and the click
    // does what it has been authorized to do all along.
    const buildable = !s.staging_url && !!s.can_preview;
    window.Improve?.setSessionPreview?.(
      (s.staging_url || buildable)
        ? { sessionId: s.id, url: s.staging_url || null, buildable }
        : null,
    );
  },

  // #771: drop the staging side-panel slot and, if the preview overlay is
  // currently docked onto it, close the preview too (a docked overlay
  // must never outlive its slot). open=false is set BEFORE the close call
  // so closeStagingOverlay's own slot-collapse branch sees nothing to do
  // — no re-render loop.
  _resetStagingPanel() {
    DevChat.stagingPanel = { open: false };
    if (typeof AppView !== 'undefined' && AppView._stagingMode === 'docked'
        && AppView.closeStagingOverlay) {
      AppView.closeStagingOverlay();
    }
  },

  _resetSpecViewer() {
    DevChat.specViewer = {
      open: false,
      sessionId: null,
      draftContent: '',
      versions: [],
      viewVersion: 'latest',
      viewVersionContent: null,
      isLoading: false,
      activeTab: 'user',
    };
  },

  // The page's ?demo= value, when it is one the budget route answers:
  // '1' (the daily allowance spent) or, since #1788, 'weekly-out' (the
  // weekly one spent). The server only honours either in staging (see the
  // demo branches on GET /api/budget in routes/sessions.js), so this is
  // safe to send always — same pattern as Settings._cliTokensDemo.
  _budgetDemoValue() {
    try {
      const v = new URLSearchParams(window.location.search).get('demo');
      return (v === '1' || v === 'weekly-out') ? v : null;
    } catch { return null; }
  },

  // True when the page carries a demo budget flag of either spelling.
  _budgetDemo() {
    return !!DevChat._budgetDemoValue();
  },

  async refreshBudget() {
    // OpenRouter sessions never use the platform's Anthropic allowance.
    // Keep its meter, exhausted banner, and demo refusal card out of this
    // session instead of showing billing state that cannot affect a turn.
    // What the meter shows here instead (#2118) is the OpenRouter key's
    // own remaining limit, read live rather than from the snapshot taken
    // when the key was saved: a managed key's figure moves every turn.
    // `?shot=openrouter-spend` answers the read from a fixture, as
    // `?shot=credits-low` does for the Claude meter below.
    if (DevChat._isOpenRouterSession()) {
      const shot = DevChat._shotOpenRouterSpend();
      if (shot) {
        DevChat.openrouterAllowance = shot.allowance;
      } else {
        try {
          const res = await fetch('/api/me/credentials/openrouter/allowance', {
            credentials: 'same-origin',
            cache: 'no-store',
          });
          if (res.ok) DevChat.openrouterAllowance = await res.json();
        } catch {}
      }
      DevChat.renderBudget();
      return;
    }
    // ?shot=credits-low answers this read from a fixture instead of the
    // network (see _shotCreditsLowBudget) — the low-balance warning is a
    // property of how much the viewer has spent, which no seeded row can
    // stand in for.
    const shotBudget = DevChat._shotCreditsLowBudget();
    if (shotBudget) {
      DevChat.budget = shotBudget;
      DevChat.renderBudget();
      return;
    }
    try {
      // ?demo=1 passthrough so a staging reviewer can see the exhausted
      // state (red meter + three-route banner) without burning a real
      // daily allowance. Strictly a no-op in production.
      const res = await fetch(`/api/budget${DevChat._budgetDemo() ? `?demo=${DevChat._budgetDemoValue()}` : ''}`);
      if (res.ok) DevChat.budget = await res.json();
    } catch {}
    DevChat.renderBudget();
    DevChat._maybeInjectDemoCreditsCard();
  },

  // Staging review aid: with ?demo=1 on a staging page whose demo budget
  // reports exhausted, drop ONE non-persisted credits card into the
  // transcript so the in-chat card (not just the banner) is reviewable.
  // Client-side only and idempotent; a production /api/budget never
  // reports the demo flag, so this can't fire there.
  _maybeInjectDemoCreditsCard() {
    if (!DevChat._budgetDemo()) return;
    if (!DevChat.budget || !DevChat.budget.demo) return;
    if (!DevChat.currentSession) return;
    if (!DevChat._creditsExhausted()) return;
    if (DevChat.messages.some((m) => m && m.creditsCard)) return;
    DevChat.messages.push({
      role: 'assistant',
      content: '',
      creditsCard: {
        error: DevChat._creditWindow().weekly
          ? 'Weekly limit reached ($175.00). Resets Monday 00:00 UTC.'
          : 'Daily limit reached ($20.00). Resets at midnight UTC.',
        hasApiKey: !!(window.Settings && Settings.state && Settings.state.hasApiKey),
        globalOut: DevChat._globalBudgetOut(),
        verificationRequired: false,
        externalFlowsAvailable: DevChat._externalFlowsAvailable(),
        sessionBridgeEnabled: DevChat._sessionBridgeEnabled(),
      },
      created_at: new Date().toISOString(),
    });
    DevChat.renderMessages();
  },

  // Whether the PLATFORM's shared daily budget (not this user's own
  // allowance) is what ran out — swaps the card/banner lead sentence.
  _globalBudgetOut() {
    const b = DevChat.budget;
    if (!b) return false;
    return typeof b.globalSpentCents === 'number'
      && typeof b.globalLimitCents === 'number'
      && b.globalSpentCents >= b.globalLimitCents;
  },

  // #593: the state behind the meter, normalised by CreditOptions so the
  // composer, the header drawer and the warning banner cannot disagree
  // about what "low" means or how the figures are formatted. Returns null
  // when that module isn't loaded (a bare unit sandbox), and every caller
  // treats null as "say nothing".
  _creditState() {
    const CO = typeof window !== 'undefined' && window.CreditOptions;
    if (!CO) return null;
    return CO.creditState(DevChat.budget);
  },

  // The one sentence that answers "when do I get them back?", shared with
  // every other credits surface. '' when the state is unknown.
  _creditResetSentence() {
    const CO = typeof window !== 'undefined' && window.CreditOptions;
    const state = DevChat._creditState();
    if (!CO || !state) return '';
    return CO.resetSentence(state);
  },

  // #1788: the allowance runs over two windows now (daily and weekly) and
  // the server reports whichever one is BINDING in the legacy
  // limit/spent/remaining fields. Every sentence that used to hardcode
  // "today" / "daily" asks here instead, so the meter, its tooltip and the
  // banner all name the window the numbers actually describe.
  _creditWindow() {
    const b = DevChat.budget || {};
    const weekly = b.capWindow === 'weekly';
    return {
      weekly,
      // "Today: …" / "This week: …"
      label: b.windowLabel || (weekly ? 'This week' : 'Today'),
      // "…left today" / "…left this week"
      when: weekly ? 'this week' : 'today',
      // "your $20.00 platform daily limit"
      limitNoun: weekly ? 'weekly limit' : 'daily limit',
      // "your free daily AI credits"
      creditsNoun: weekly ? 'free weekly AI credits' : 'free daily AI credits',
      // Fallback for the reset sentence when CreditOptions is absent.
      resetFallback: weekly
        ? 'Resets Monday 00:00 UTC.'
        : 'Resets at midnight UTC.',
    };
  },

  renderBudget() {
    // #463: budget data just changed (usage event, chat open, key
    // save/remove) — sync the credits-exhausted banner alongside the
    // meter. Runs before the meter's own element guard so the banner
    // clears/appears even when the meter isn't mounted.
    DevChat._applyCreditsBanner();
    // #593: and the proactive low-balance warning, which is the same
    // mechanism one step earlier. Mutually exclusive with the red one —
    // see _creditsLow().
    DevChat._applyCreditsLowBanner();
    const el = document.getElementById('dc-budget');
    if (!el) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react) return;
    // The host is the COMPOSER's now — `BudgetPillBar` renders the span too.
    // A dapp.json check selects it as `#dc-venue-detail ~ #dc-budget`, so
    // where it sits in that status line is part of the contract.
    react.publishBudgetPill(DevChat._budgetPillView());
  },

  // The meter's nine states, as fragments. Every decision is here — the
  // thresholds, the wording, the dollar formatting, the reset sentence, and
  // the limit-first billing rule — and the component only draws them.
  _budgetPillView() {
    const view = DevChat._settledBudgetPillView();
    const spend = DevChat._liveSpend || DevChat._shotTurnSpend();
    if (!spend || Number(spend.sessionId) !== Number(DevChat.currentSession?.id)) return view;
    // #2118: an OpenRouter turn's figure is the ledger's list-price estimate
    // (agent_turns.estimated_cost_usd), so its tooltip says what it is
    // rather than borrowing Claude Code's wording.
    const openRouter = DevChat._isOpenRouterSession();
    return {
      title: view.title,
      parts: [...view.parts,
        ...(view.parts.length ? [{ text: ' · ', className: 'text-zinc-500 dark:text-zinc-400' }] : []),
        {
          text: `this turn ${spend.estimated ? '~' : ''}$${(spend.costCents / 100).toFixed(2)}`,
          className: 'text-zinc-500 dark:text-zinc-400',
          title: openRouter
            ? 'Estimated from the model\u2019s OpenRouter list price and the tokens this turn used. OpenRouter\u2019s own usage records determine billing.'
            : spend.estimated
              ? 'Estimated token spend so far. Updates while Claude Code works; final usage determines billing.'
              : 'Token spend reported by Claude Code for this turn.',
        },
      ],
    };
  },

  // #2118: the figure `?shot=openrouter-spend` paints as the turn that just
  // ran, keyed to the session on screen like a real observation.
  _shotTurnSpend() {
    const shot = DevChat._shotOpenRouterSpend();
    if (!shot || !DevChat.currentSession) return null;
    return { sessionId: DevChat.currentSession.id, ...shot.turn };
  },

  _settledBudgetPillView() {
    const NONE = { title: null, parts: [] };
    const muted = 'text-zinc-500 dark:text-zinc-400';
    // An OpenRouter session bills the user's own provider key, so the
    // platform meter has nothing to say about it; what it shows instead is
    // what is left on that key (#2118).
    if (DevChat._isOpenRouterSession()) return DevChat._openRouterAllowanceView();

    // #593: the reset time, rendered rather than hidden in a tooltip — it
    // is what someone deciding whether to start another turn is looking
    // for, and a title attribute is invisible on touch and absent from
    // every screenshot. (The remainder was rendered here too until #1353;
    // see below.)
    const state = DevChat._creditState();
    const hasApiKey = !!window.Settings?.state?.hasApiKey;
    if (state && state.level === 'locked') {
      if (hasApiKey) {
        const last4 = window.Settings.state.keyLast4 || '••••';
        return {
          title: 'Platform credits are locked until you connect GitHub or X. Your own Anthropic key remains available.',
          parts: [
            { text: 'platform credits locked', className: 'text-amber-800 dark:text-amber-400 hover:underline', href: '#settings/connectors' },
            { text: ' · ', className: muted },
            { text: `your key · ${last4}`, className: 'text-emerald-700 dark:text-emerald-400' },
          ],
        };
      }
      return {
        title: null,
        parts: [{
          text: 'verify account · unlock $10/day',
          className: 'text-amber-800 dark:text-amber-400 font-medium hover:underline',
          href: '#settings/connectors',
          title: 'Connect GitHub or X to unlock $10/day',
        }],
      };
    }
    if (state && state.level === 'unavailable') {
      return hasApiKey
        ? { title: null, parts: [{ text: 'your key available', className: 'text-emerald-700 dark:text-emerald-400', title: 'Platform credit eligibility is temporarily unavailable; your own key remains available.' }] }
        : { title: null, parts: [{ text: 'credits temporarily unavailable', className: 'text-amber-800 dark:text-amber-400', title: 'Platform credit eligibility could not be verified. Try again shortly.' }] };
    }

    // #1353: no "· $X left" alongside the pair. The remainder is $limit
    // minus $spent — both of which are right there, two characters apart —
    // so the meter was stating the same fact twice on the narrowest strip
    // in the app, and the second statement was the one that wrapped. The
    // header drawer's credits row still spells the remainder out (it has
    // the room, and it is read away from a session), and the low-balance
    // and exhausted banners still say it in words when it starts to matter.
    const resetTip = DevChat._creditResetSentence();
    // BYOK (#30/#119/#212): billing is limit-first — the daily platform
    // allowance is consumed before any spend hits the user's own key —
    // so key-holders see the limit progress first (same red/yellow
    // thresholds as everyone else) and a "your key $X" figure only once
    // spillover billing to their key has actually started today. The
    // BYOK figure never gets threshold coloring — no cap applies to it.
    if (hasApiKey) {
      const last4 = window.Settings.state.keyLast4 || '••••';
      if (!DevChat.budget) {
        // Budget fetch hasn't landed yet — static badge until it does.
        return {
          title: null,
          parts: [{ text: `your key · ${last4}`, className: 'text-emerald-700 dark:text-emerald-400', title: 'Using your Anthropic API key' }],
        };
      }
      const byokCents = DevChat.budget.byokSpentCents || 0;
      const byok = (byokCents / 100).toFixed(2);
      const spent = (DevChat.budget.spentCents / 100).toFixed(2);
      const limit = (DevChat.budget.limitCents / 100).toFixed(2);
      const pct = Math.min(100, (DevChat.budget.spentCents / DevChat.budget.limitCents) * 100);
      const color = pct > 80 ? 'text-red-700 dark:text-red-400' : pct > 50 ? 'text-yellow-700 dark:text-yellow-400' : 'text-emerald-700 dark:text-emerald-400';
      const parts = [
        { text: 'limit ', className: muted },
        { text: `$${spent}`, className: color },
        { text: `/$${limit}`, className: muted },
      ];
      if (byokCents > 0) {
        parts.push({ text: ' · ', className: muted });
        parts.push({ text: `your key $${byok}`, className: 'text-emerald-700 dark:text-emerald-400' });
      }
      const win = DevChat._creditWindow();
      return {
        title: `${win.label}: $${spent} of your $${limit} platform ${win.limitNoun}`
          + (byokCents > 0 ? ` + $${byok} billed to your Anthropic key (…${last4})` : '')
          + `. The ${win.limitNoun} is used first; your key (…${last4}) takes over once it runs out. `
          + (resetTip || win.resetFallback),
        parts,
      };
    }

    if (!DevChat.budget) return NONE;
    const spent = (DevChat.budget.spentCents / 100).toFixed(2);
    const limit = (DevChat.budget.limitCents / 100).toFixed(2);
    // #463: exhausted (no key saved) keeps the familiar $spent/$limit
    // pair — just unmistakably red, with the tooltip pointing at the
    // BYOK escape hatch. The banner carries the wordy explanation.
    if (DevChat._creditsExhausted()) {
      const winOut = DevChat._creditWindow();
      return {
        title: `Your ${winOut.creditsNoun} are used up. ${
          resetTip || winOut.resetFallback} Or add your own Anthropic API key in Settings to keep working now.`,
        parts: [
          { text: `$${spent}`, className: 'text-red-700 font-semibold dark:text-red-400' },
          { text: `/$${limit}`, className: 'text-red-700 dark:text-red-400' },
        ],
      };
    }
    const pct = Math.min(100, (DevChat.budget.spentCents / DevChat.budget.limitCents) * 100);
    const color = pct > 80 ? 'text-red-700 dark:text-red-400' : pct > 50 ? 'text-yellow-700 dark:text-yellow-400' : 'text-emerald-700 dark:text-emerald-400';
    const winOk = DevChat._creditWindow();
    return {
      title: `${winOk.label}: $${spent} of your $${limit} ${winOk.creditsNoun}. ${
        resetTip || winOk.resetFallback}`,
      parts: [
        { text: `$${spent}`, className: color },
        { text: `/$${limit}`, className: muted },
      ],
    };
  },

  // #2118: the OpenRouter session's half of the meter. A session on an
  // OpenRouter key never touches the platform's Anthropic allowance, so
  // the daily meter has nothing to say about it; what the viewer wants to
  // know instead is how much of the KEY's limit is left. OpenRouter
  // reports that itself (GET /key: limit, limit_remaining, limit_reset),
  // so the figure is shown as reported rather than derived, in the window
  // the key's reset cadence names. A key with no limit draws nothing
  // rather than a guess, and the Claude meter's red/yellow thresholds
  // colour what is left.
  _openRouterAllowanceView() {
    const NONE = { title: null, parts: [] };
    const a = DevChat.openrouterAllowance;
    if (!a || a.configured === false) return NONE;
    // Null is "OpenRouter reports no limit", not zero: only a number draws.
    const left = typeof a.limitRemaining === 'number' ? a.limitRemaining : NaN;
    if (!Number.isFinite(left)) return NONE;
    const limit = typeof a.limit === 'number' ? a.limit : NaN;
    const hasLimit = Number.isFinite(limit) && limit > 0;
    const remaining = Math.max(0, left);
    const cadence = a.limitReset === 'daily' ? 'daily'
      : a.limitReset === 'weekly' ? 'weekly'
        : a.limitReset === 'monthly' ? 'monthly' : null;
    const when = cadence === 'daily' ? ' today'
      : cadence === 'weekly' ? ' this week'
        : cadence === 'monthly' ? ' this month' : '';
    const pct = hasLimit ? Math.min(100, ((limit - remaining) / limit) * 100) : 0;
    const color = hasLimit && remaining <= 0 ? 'text-red-700 font-semibold dark:text-red-400'
      : pct > 80 ? 'text-red-700 dark:text-red-400'
        : pct > 50 ? 'text-yellow-700 dark:text-yellow-400'
          : 'text-emerald-700 dark:text-emerald-400';
    const owner = a.source === 'usernode_managed'
      ? 'Your included OpenRouter key'
      : `Your OpenRouter key${a.last4 ? ` (\u2026${a.last4})` : ''}`;
    const allowance = hasLimit
      ? `$${remaining.toFixed(2)} of its $${limit.toFixed(2)}${cadence ? ` ${cadence}` : ''} allowance left`
      : `$${remaining.toFixed(2)} left`;
    const reset = cadence ? ` OpenRouter resets it ${cadence}.` : '';
    return {
      title: null,
      parts: [{
        text: `$${remaining.toFixed(2)} left${when}`,
        className: color,
        title: `${owner} has ${allowance}.${reset}`,
      }],
    };
  },

  // Screenshot-state deep link `?shot=openrouter-spend` (#2118).
  //
  // What an OpenRouter session's meter says is a property of the viewer's
  // key and of a turn that ran: how much of the key's allowance OpenRouter
  // reports left, and what the ledger estimated the last turn cost. Neither
  // is a session column a fixture row can carry: the allowance is read
  // live from OpenRouter, which a staging clone has no key to ask, and a
  // turn would have to be paid for. So, as ?shot=credits-low does for the
  // Claude meter, the URL names the state and the client answers both
  // reads from a fixed snapshot: a managed key with $0.86 of $1.00 left
  // today, and a turn that cost about twelve cents.
  //
  // Ungated by environment for the same reason: it paints figures on the
  // session already on screen, reads nothing and writes nothing, and it
  // only answers in an OpenRouter session, so on a Claude session the real
  // budget read runs untouched.
  _shotOpenRouterSpend() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { return null; }
    if (shot !== 'openrouter-spend' || !DevChat._isOpenRouterSession()) return null;
    return {
      allowance: {
        configured: true,
        source: 'usernode_managed',
        last4: '7f2c',
        limit: 1,
        limitRemaining: 0.86,
        limitReset: 'daily',
        shot: true,
      },
      turn: { costCents: 12, estimated: true },
    };
  },

  // #463: true when the signed-in user is out of free credits AND has no
  // BYOK key to spill over to — the only state where AI work is actually
  // blocked. Key-holders never match (billing continues on their key),
  // and a missing budget fetch stays quiet rather than guessing.
  _creditsExhausted() {
    if (DevChat._isOpenRouterSession()) return false;
    const b = DevChat.budget;
    if (!b) return false;
    // A key on file bypasses the allowance entirely, so exhaustion stops
    // nothing and there is nothing to offer. Except the staging DEMO key
    // (#1055): `?demo=1` reports a fake `…7f2c` on file so a reviewer can
    // see the key-on-file branch of the meter, and that key cannot be used
    // for anything — reading it as a real one suppressed the very
    // out-of-credits card the demo state exists to show.
    const settings = window.Settings?.state;
    if (settings?.hasApiKey && !settings.demoKey) return false;
    const userOut = typeof b.spentCents === 'number' && typeof b.limitCents === 'number'
      && b.spentCents >= b.limitCents;
    const globalOut = typeof b.globalSpentCents === 'number' && typeof b.globalLimitCents === 'number'
      && b.globalSpentCents >= b.globalLimitCents;
    return userOut || globalOut;
  },

  // #463: the credits-exhausted banner. Null when the show-condition does
  // not hold; otherwise a `CreditsBannerView` (features/dev-chat/
  // banners-store.ts) in one of its three reasons.
  //
  // The copy is RAW text, not entities: React escapes what it renders, and a
  // `&rsquo;` in the model would arrive on screen as those seven characters.
  _creditsBannerView() {
    if (!DevChat._creditsExhausted()) return null;
    const b = DevChat.budget;
    const state = DevChat._creditState();
    const actions = (over) => (window.CreditOptions
      ? CreditOptions.bannerActionsHtml({
        hasApiKey: false,
        globalOut: false,
        externalFlowsAvailable: DevChat._externalFlowsAvailable(),
        sessionBridgeEnabled: DevChat._sessionBridgeEnabled(),
        ...over,
      })
      : '');
    const base = {
      id: 'dc-credits-banner',
      leadTagged: false,
      reset: null,
      // #1348: blocked, so the sheet marks the venue that just refused the
      // turn instead of offering it as a way out of its own refusal.
      blockedVenue: true,
    };
    if (state && state.level === 'locked') {
      return {
        ...base,
        tone: 'amber',
        icon: 'person',
        lead: 'Connect GitHub or X to unlock $10/day of Homeroom credits.',
        tail: ' Either account unlocks the same tier; connecting both does not stack credits.',
        actionsHtml: actions({ verificationRequired: true }),
      };
    }
    if (state && state.level === 'unavailable') {
      return {
        ...base,
        tone: 'amber',
        icon: null,
        lead: 'Credit eligibility could not be verified.',
        tail: ' Try again shortly, or use your own API key or another build venue.',
        actionsHtml: actions({ verificationRequired: false }),
      };
    }
    const userOut = b.spentCents >= b.limitCents;
    return {
      ...base,
      tone: 'red',
      icon: 'warn',
      lead: userOut
        ? `You\u2019ve used up ${DevChat._creditWindow().when === 'this week'
          ? 'this week\u2019s' : 'today\u2019s'} free AI credits.`
        : 'The platform\u2019s shared daily AI budget is used up.',
      reset: DevChat._creditResetSentence()
        || `Free credits reset ${DevChat._creditWindow().weekly ? 'Monday 00:00 UTC' : 'at midnight UTC'}.`,
      tail: ' Or keep working right now ' + (DevChat._externalFlowsAvailable()
        ? 'on your own Claude or ChatGPT plan, with your own API key, or with a coding tool on your computer.'
        : 'with your own API key, a coding tool on your computer, or your Claude.ai / ChatGPT subscription.'),
      actionsHtml: actions({
        hasApiKey: !!(window.Settings && Settings.state && Settings.state.hasApiKey),
        globalOut: !userOut,
      }),
    };
  },

  // The banner's own repaint. It read the live element, swapped its
  // `outerHTML`, `remove()`d it or `insertAdjacentHTML`'d it back before
  // `.dc-session-body` — three code paths for "say something different here"
  // — precisely so a banner could change mid-session without re-rendering the
  // transcript under an in-flight stream. A publish does that by
  // construction, and the message list is not in the subtree.
  _applyCreditsBanner() {
    DevChat._publishBanners();
  },

  // ── The proactive low-balance warning (#593) ───────────────────────
  //
  // The whole complaint behind the issue is that the allowance runs out
  // mid-flow: the first signal a builder got was a refused turn, three
  // quarters of the way through a change. This is that signal, one step
  // earlier — at CreditOptions' lowPct of the cap (the server sends the
  // threshold on the budget payload, see limits.LOW_BALANCE_PCT).
  //
  // Deliberately NOT shown to a key-holder: their allowance running out
  // spills over to their own key and changes nothing about the turn they
  // are about to send, so warning them would be noise. Same reason
  // _creditsExhausted() ignores them.
  _creditsLow() {
    if (DevChat._isOpenRouterSession()) return false;
    if (!DevChat.budget) return false;
    if (window.Settings?.state?.hasApiKey) return false;
    // Mutually exclusive with the red banner: once the allowance is
    // actually gone, "running low" is the wrong tense and two stacked
    // banners is the wrong amount of chrome.
    if (DevChat._creditsExhausted()) return false;
    const state = DevChat._creditState();
    return !!state && state.level === 'low';
  },

  // Amber sibling of the red banner, same slot and the same route buttons
  // — nothing has been refused yet, so the copy states the headroom and
  // the boundary instead of announcing a failure. ONE shape with it
  // (features/dev-chat/banners-store.ts): they are one banner in two tenses,
  // and writing them as two templates is what let their copy drift.
  _creditsLowBannerView() {
    if (!DevChat._creditsLow()) return null;
    const CO = window.CreditOptions;
    if (!CO) return null;
    const state = DevChat._creditState();
    return {
      id: 'dc-credits-low-banner',
      tone: 'amber',
      icon: 'clock',
      lead: CO.lowLead(state),
      leadTagged: true,
      reset: CO.resetSentence(state),
      tail: ' Set up another way to keep building before it runs out mid-change.',
      actionsHtml: CO.bannerActionsHtml({
        hasApiKey: false,
        globalOut: false,
        externalFlowsAvailable: DevChat._externalFlowsAvailable(),
        sessionBridgeEnabled: DevChat._sessionBridgeEnabled(),
      }),
      // NOT blocked: credits are low, not gone — the in-chat venue still
      // works, and marking it unavailable would be a lie told early.
      blockedVenue: false,
    };
  },

  _applyCreditsLowBanner() {
    DevChat._publishBanners();
  },

  // Screenshot-state deep link `?shot=credits-low` (#593).
  //
  // The warning is a function of how much of today's allowance this
  // viewer has spent, and no fixture row can express that: llm_usage is
  // real accounting, and seeding a staging row would mean writing spend
  // the reviewer's account did not incur. So the URL names the state and
  // the client answers the budget read from a fixed snapshot instead of
  // the network — 80% of a $25 cap, which is exactly the threshold.
  //
  // Ungated by environment, like ?shot=menu and ?shot=venue-fallback: it
  // paints a client-side sentence about the session already on screen,
  // reads nothing and writes nothing, and any other ?shot= value leaves
  // the real budget read alone. That is what keeps a production "before"
  // shot of this banner obtainable.
  // Two shots, one fixture shape: `credits-low` is the 80% warning and
  // `credits-exhausted` is the refusal (#1348). Both are properties of how
  // much THIS viewer has spent, which no seeded row can stand in for —
  // llm_usage is real accounting, and writing spend a reviewer did not
  // incur is exactly what the staging-seed rule forbids. So the URL names
  // the state and the client answers the budget read from a fixture.
  //
  // The exhausted one exists because the bar it paints is now the whole of
  // that state's UI — two doors and a sentence — and a route the checks
  // and the before/after screenshots can reach is the only way anybody
  // reviews it without burning a day's allowance.
  _shotCreditsLowBudget() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { return null; }
    if (shot !== 'credits-low' && shot !== 'credits-exhausted') return null;
    const reset = new Date();
    reset.setUTCHours(24, 0, 0, 0);
    const exhausted = shot === 'credits-exhausted';
    return {
      spentCents: exhausted ? 2500 : 2000,
      limitCents: 2500,
      remainingCents: exhausted ? 0 : 500,
      globalSpentCents: 4000,
      globalLimitCents: 100000,
      byokSpentCents: 0,
      aiEnabled: true,
      resetsAt: reset.toISOString(),
      lowBalancePct: 80,
      shot: true,
    };
  },

  // #1049: whether the out-of-credits routes may lead with the Claude Code /
  // Codex hand-offs. Deployment-level, reported by /api/auth/me — the client
  // renders what the server says is possible and never sniffs for it.
  _externalFlowsAvailable() {
    return !!(typeof App !== 'undefined' && App.user && App.user.externalFlowsAvailable);
  },

  // #1281: whether this user opted in to the session-CLI bridge. Per-user
  // rather than per-deployment, and default false — so unlike the flag
  // above, a page that has not loaded /api/auth/me yet correctly reports
  // "no" rather than briefly offering a venue the user never enabled.
  _sessionBridgeEnabled() {
    return !!(typeof App !== 'undefined' && App.user && App.user.sessionBridgeEnabled);
  },

  // Best-effort: a failed save must not block the venue the user just chose.
  // Settings → Claude & ChatGPT connectors is the other door to this value.
  async _saveDevFlowPreference(flow) {
    try {
      const res = await fetch('/api/me/dev-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ flow }),
      });
      if (res.ok && typeof App !== 'undefined' && App.user) App.user.devFlowPreference = flow;
    } catch { /* ignore */ }
  },

  // "Use Claude Code" / "Use Codex" from an out-of-credits card or banner.
  // Same walkthrough the picker opens, in the session the user was refused
  // in — the work they were describing is right there in the transcript.
  //
  // `targetId` (#1071) is the session whose branch the agent should push back
  // onto, and only the options menu passes one — a credits card is always a
  // fresh piece of work, so it keeps calling this with one argument and the
  // target stays null.
  _devFlowFromCredits(agent, targetId) {
    if (!window.DevFlowSelect) {
      window.location.hash = '#settings/connectors';
      return;
    }
    const flow = DevChat._devFlow;
    flow.mode = 'wizard';
    flow.agent = agent;
    flow.targetId = targetId == null ? null : targetId;
    flow.dismissed = false;
    flow.error = null;
    flow.notice = null;
    DevChat._repaintDevFlow();
    DevChat._devFlowEnsureStatus(true);
  },

  // The inverse of _devFlowFromCredits: the user has chosen to build HERE,
  // so the walkthrough this tab is holding stops applying (#1348 follow-up).
  //
  // Clearing the session's build_venue column is NOT enough, and that is
  // the bug this exists for. _devFlowTarget() answers from this in-memory
  // object BEFORE it reads the column, so a tab that has ever opened the
  // web launchpad keeps answering "wizard" — the venue row ticked
  // On-Platform, the backend switched underneath, and the screen went on
  // rendering the Claude/Codex launchpad.
  //
  // `dismissed` is the lever rather than a cleared `mode`, because
  // _devFlowTarget checks it FIRST and so short-circuits all three ways a
  // launchpad comes back: this in-memory wizard, the session's stored
  // venue, and a saved dev_flow_preference on an untouched session. Only
  // the first is being cleared here — the other two are still true, and
  // without `dismissed` the very next paint would answer "wizard" from one
  // of them and put the launchpad straight back.
  //
  // It is per-tab and per-session by construction: _resetDevFlow() rebuilds
  // this object when the session changes, and picking a web venue again
  // sets dismissed back to false.
  _devFlowReturnToChat() {
    const flow = DevChat._devFlow;
    flow.mode = null;
    flow.agent = null;
    flow.targetId = null;
    flow.error = null;
    flow.notice = null;
    flow.dismissed = true;
  },

  // Same wiring for every credits CARD currently in the transcript.
  // Called after each renderMessages; CreditOptions.wire is idempotent
  // per node, so re-running it never stacks handlers.
  // Scoped to the transcript on purpose: app-view's Generate-proposal modal
  // renders the SAME card and wires its own handlers (its "Use Claude Code"
  // starts a fresh session), and a document-wide selector would attach this
  // one to that card as well — one click, two different actions (#1049).
  _wireCreditsCards() {
    if (!window.CreditOptions) return;
    const container = document.getElementById('dc-messages');
    if (!container) return;
    container.querySelectorAll('[data-credits-card]').forEach((el) => {
      CreditOptions.wire(el, { onFlow: (flow) => DevChat._devFlowFromCredits(flow) });
    });
  },

  // ── The local-CLI card, and the state every venue surface reads (#1055) ─
  //
  // All copy, gating and markup live in public/js/session-options.js; this
  // is the state assembly and the plumbing back into the session.
  //
  // There was a "⋯" beside the meter that opened a "Session and billing
  // options" menu over this state, and #1353 removed it. Every row on it
  // had a better door by then: "Change how this is built" is the venue
  // dropdown in the session header (#1348), the two key rows are Settings
  // links the credits banner already offers at the moment they matter, the
  // local-CLI card is what picking the CLI venue opens, and handing turns
  // back to Homeroom is the runner select's own "Run on: Homeroom". A menu
  // whose every row is a second way to somewhere else is a menu of
  // duplicates — on the strip with the least room in the app.

  _optionsCard: null,
  // #1146: the two `?shot=` latches below are keyed on the fragment they
  // were applied at, NOT on the document. Both used to be booleans, which
  // read as "once per page load" — right for the thing they guard (a status
  // poll's re-render must not pop the menu back open under the user) and
  // wrong for the address, because one `?shot=` document addresses several
  // sessions by fragment (dapp.json points five checks at
  // /?demo=1&shot=venue-sheet, one per session). Cold-loading each fragment
  // hid it; the grouped capture runner reaches the siblings by writing
  // location.hash, and every cohort after the first got a plain composer.
  // Same guard, per active fragment.
  _shotOptionsHash: null,
  _shotVenueSheetHash: null,
  // The one live surface hold (see _holdShotSurface). At most one: the two
  // deep links below are different `?shot=` values, so no URL asks for both.
  _shotHold: null,

  // Read defensively, like the `?shot=` reads themselves: the composer's
  // unit tests evaluate this module in a bare sandbox that has a document
  // but no `location`. Falling back to '' rather than null keeps the
  // latches' original once-per-document meaning there — '' is still a key,
  // it just never changes.
  _addressKey() {
    try { return location.hash; } catch { return ''; }
  },

  // Everything the menu needs, read from the places that already own each
  // fact: Settings mirrors /api/auth/me's BYOK state, App.user carries the
  // two deployment capabilities, and _localAgent is the #907 lease as of
  // the last status poll.
  _sessionOptionsState() {
    const user = (typeof App !== 'undefined' && App.user) || {};
    const settings = (window.Settings && window.Settings.state) || {};
    const session = DevChat.currentSession || {};
    return {
      hasApiKey: !!settings.hasApiKey,
      keyLast4: settings.keyLast4 || null,
      // The whole /api/cli/* family is 404'd in a staging clone, so
      // cliAuthEnabled is false there and the local-CLI row would be missing
      // from the very menu a reviewer opened to look at it. ?demo=1 paints
      // it — the row opens a pure copy card that fetches nothing, so there
      // is no request to 404 behind it. Production is unaffected: the flag
      // is only honoured where the page already carries it.
      cliAuthEnabled: user.cliAuthEnabled !== false || !!DevChat._demoQS(),
      // #1281: the user's own opt-in, which `local` needs on top of the
      // deployment flag. ?demo=1 paints it for the same reason it paints
      // cliAuthEnabled — a staging reviewer has no way to flip a preference
      // on a clone, and the row opens a copy card that fetches nothing.
      sessionBridgeEnabled: !!user.sessionBridgeEnabled || !!DevChat._demoQS(),
      externalFlowsAvailable: DevChat._externalFlowsAvailable(),
      localAgent: DevChat._localAgent || null,
      sessionId: session.id || null,
      // #1071. The two facts that decide whether the web hand-off can
      // continue THIS session's code or has to start something separate.
      // Read straight off the session row the chat is already rendering, so
      // the menu can never disagree with the header above it.
      sessionStatus: session.status || null,
      hasBranch: !!session.branch_name,
      repoUrl: (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.repo_url) || null,
    };
  },

  _closeSessionOptions() {
    const card = DevChat._optionsCard;
    DevChat._optionsCard = null;
    if (card && typeof card.dismiss === 'function') card.dismiss();
  },

  // ── The one venue question (#1086, recut #1348) ────────────────────
  //
  // Every surface that used to ask its own version of "which agent?" opens
  // THIS: the venue dropdown in the session header, the "…" menu's one
  // row, and the out-of-credits card. FOUR coarse rows now, gated by
  // omission — the list and the copy are build-venues.js's; the four
  // things a pick can actually DO are this module's, because each one
  // already existed and already worked. Nothing here is new mechanism.
  //
  //   on-platform → reset-agent-context with no backend: the server picks
  //                 whichever in-chat agent this user ran last (#1348),
  //                 keeping branch + transcript (#906)
  //   cli-bridge  → the CLI instructions card (#907)
  //   web-agent   → the web-agent walkthrough, in place (#1049/#1071),
  //                 which carries its own Claude/Codex toggle (#1281)
  //   own-tools   → the own-tools launchpad, ending in the PR-import
  //                 picker (#687/#1281)
  //
  // The six VENUES underneath are untouched: the header chip still names
  // the specific one, the out-of-credits card still lists them all with
  // their own CTAs, and preselect() still maps a venue to its mechanism.
  // Only the SHEET got coarser.
  _venueSheetState() {
    const base = DevChat._sessionOptionsState();
    const user = (typeof App !== 'undefined' && App.user) || {};
    return {
      mode: 'switch',
      current: DevChat._currentVenueId(),
      // Same three deployment capabilities the "…" menu reads, plus the two
      // this list needs on top: whether the OpenRouter backend is offerable
      // to this user at all, and whether they may push branches to this app
      // (importing writes to them).
      cliAuthEnabled: base.cliAuthEnabled,
      sessionBridgeEnabled: base.sessionBridgeEnabled,
      externalFlowsAvailable: base.externalFlowsAvailable,
      openrouterAvailable: !!user.openrouterAvailable,
      canCollaborate: !(typeof AppView !== 'undefined' && AppView.readOnly),
      sessionId: base.sessionId,
      sessionStatus: base.sessionStatus,
      hasBranch: base.hasBranch,
      localAgent: base.localAgent,
      repoUrl: base.repoUrl,
    };
  },

  // `blocked` opens the sheet in the mode build-venues.js already has for
  // a refused turn: the On-Platform row comes back marked unavailable and
  // carrying the reason, so the sheet states the refusal rather than
  // offering the venue that caused it. Everything else is pickable.
  // The sentence the blocked sheet puts under the On-Platform row. Built
  // from the same credit state the banner reads, so the row and the bar
  // that opened it cannot disagree about why.
  _creditRefusalReason() {
    const CO = window.CreditOptions;
    const state = CO ? DevChat._creditState() : null;
    if (state && state.level === 'locked') {
      return 'Connect GitHub or X to unlock $10/day of Homeroom credits.';
    }
    const reset = DevChat._creditResetSentence();
    const lead = DevChat._globalBudgetOut()
      ? 'The platform\u2019s shared daily AI budget is used up.'
      : `You\u2019ve used up ${DevChat._creditWindow().weekly
        ? 'this week\u2019s' : 'today\u2019s'} free AI credits.`;
    return reset ? `${lead} ${reset}` : lead;
  },

  openVenueSheet(anchorEl, { blocked = false } = {}) {
    if (!window.BuildVenues) return;
    DevChat._closeSessionOptions();
    const state = DevChat._venueSheetState();
    if (blocked) {
      state.mode = 'blocked';
      state.blockedReason = DevChat._creditRefusalReason();
    }
    BuildVenues.open({
      anchorEl: anchorEl || document.getElementById('dc-venue-select') || undefined,
      state,
      onPick: (row) => {
        if (!row || row.current) return;
        // #1348: the sheet answers coarsely now. `row.venue` is the venue a
        // choice resolves to, or null for the one the SERVER resolves.
        if (row.venue === null) {
          // On-Platform. Coming back in-chat CLEARS the stored venue rather
          // than storing an in-chat one (#1281). agent_backend already says
          // which of the two it is, and currentVenue() derives it — so a
          // stored 'usernode-claude' would be a second, staler answer to a
          // question the column already answers, and would mask a later
          // switch to OpenRouter made from anywhere else.
          // Locally FIRST, then persist — the same order the other three
          // branches use. _persistBuildVenue only folds the column back in
          // when its response lands, and the repaint below does not wait
          // for it: leaving the stale venue in place is what kept a
          // launchpad on screen after picking On-Platform.
          if (DevChat.currentSession) DevChat.currentSession.build_venue = null;
          DevChat._persistBuildVenue(null);
          // …and the in-memory walkthrough, which outranks the column.
          DevChat._devFlowReturnToChat();
          // Repaint NOW rather than leaving it to the switch below: that
          // one repaints only after its round trip, and only if the round
          // trip succeeds. The choice has already been made locally, so the
          // composer should come back on the click — a network failure can
          // cost the backend switch, but it must not strand the user on a
          // launchpad they have left.
          DevChat.renderChatView();
          // No backend named: the server applies whichever in-chat agent
          // this user ran last, and says so if that preference no longer
          // validates. The coarse row asks "on the platform"; which of the
          // two that means is not a question worth putting to someone who
          // has only ever had one of them.
          DevChat._switchToLastUsedPlatformAgent();
          return;
        }
        const pick = BuildVenues.preselect(row.venue);
        if (!pick) return;
        if (pick.kind === 'lease') {
          if (!window.SessionOptions) return;
          DevChat._optionsCard = SessionOptions.openInstructions({
            state: DevChat._sessionOptionsState(),
            onClose: () => { DevChat._optionsCard = null; },
          });
          return;
        }
        if (pick.kind === 'flow') {
          // Answering the venue question ALSO answers it for next time —
          // that is what "asked once" means. The picker card used to make
          // this a second decision ("remember this choice"); the sheet is
          // the deliberate act, so the save rides along with it.
          DevChat._saveDevFlowPreference(pick.flow);
          // #1281: and it answers it for THIS session, which is what turns
          // the chat into a launchpad and keeps it one across a reload.
          if (DevChat.currentSession) DevChat.currentSession.build_venue = pick.venue;
          DevChat._persistBuildVenue(pick.venue);
          DevChat._devFlowFromCredits(pick.flow, DevChat._webHandoffTargetId());
          DevChat.renderChatView();
          return;
        }
        if (pick.kind === 'import') {
          // #1281: this venue used to jump straight to the import modal,
          // which asked for a pull request the user had not built yet. It
          // switches the session to its launchpad instead — connect your
          // agent to the MCP, tell it what to build, and import when it is
          // done — and the import modal is that launchpad's last step.
          if (DevChat.currentSession) DevChat.currentSession.build_venue = pick.venue;
          DevChat._persistBuildVenue(pick.venue);
          DevChat.renderChatView();
        }
      },
      onUnavailable: (row) => PlatformUI.toast(row.reason),
    });
  },

  // Screenshot-state deep link `?shot=venue-fallback` (#1086).
  //
  // The fallback note is the one venue state a fixture row cannot express.
  // Every other state is a property of the session — its backend, its
  // lease, its external agent — and seeding those columns paints the line.
  // But "you asked for OpenRouter and got Claude" is a property of the
  // MOMENT the session was created: the reason arrives once, on the 201,
  // and is deliberately not stored (the session's columns already say
  // where it ended up, and re-explaining a settled fact on every later
  // paint is exactly what the `= null` below prevents). So the only way to
  // review the copy is to name the reason in the URL.
  //
  // Ungated by environment for the same reason ?shot=menu is: it paints a
  // sentence about the session already on screen, reads nothing and writes
  // nothing. A reason build-venues.js does not know about still renders
  // silence, so a guessed value cannot invent copy.
  _shotVenueFallbackReason() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { return null; }
    if (shot !== 'venue-fallback') return null;
    let reason = null;
    try { reason = new URLSearchParams(location.search).get('reason'); } catch { /* ignore */ }
    return reason || 'flag_off';
  },

  // ── A `?shot=` surface is HELD up, not opened once (#1055, #1086) ──
  //
  // A screenshot-state deep link asks for a surface to be ON SCREEN WHEN THE
  // PAGE IS JUDGED, and both ends of that are late. The anchor is written by
  // renderChatView but LAID OUT a frame or more later (offsetParent stays
  // null while the dev screen is still being revealed) and its module
  // publishes whenever the shell's script queue reaches it — so opening on
  // the first render can be too early. And anything that lands afterwards
  // can take the surface back down: a budget response injecting the
  // out-of-credits card, a websocket push, a stream frame each re-render the
  // transcript, the transcript auto-scrolls to follow (initScrollTracking's
  // observer), and the kit dismisses an open popover on ANY scroll outside
  // it (native.js's presentPopover onScroll). One open is therefore not
  // enough in either direction: opening on the first render alone lost the
  // race in #1055, and stopping at the first success lost all nine venue /
  // options checks to the `?demo=1` credits card, which lands ~1.5s later —
  // inside every one of their poll windows.
  //
  // So the open is re-asserted every SHOT_HOLD_RETRY_MS for SHOT_HOLD_MS:
  // opened when the anchor is ready and the surface is down, left alone when
  // it is up. It stops at the window, on a fragment change (the grouped
  // capture runner moves between sessions by writing location.hash — a hold
  // must not follow it), and on a TRUSTED click or keypress, which is a
  // human driving the page rather than a capture judging it. Every entry
  // point is gated on a `?shot=` URL, so no real session reaches any of it.
  _holdShotSurface(key, addr, spec) {
    const live = DevChat._shotHold;
    if (live && live.key === key && live.addr === addr) return;
    DevChat._releaseShotHold();
    const hold = {
      key,
      addr,
      spec,
      timer: null,
      until: Date.now() + SHOT_HOLD_MS,
      onUserInput: (e) => { if (!e || e.isTrusted) DevChat._releaseShotHold(); },
    };
    DevChat._shotHold = hold;
    try {
      document.addEventListener('pointerdown', hold.onUserInput, true);
      document.addEventListener('keydown', hold.onUserInput, true);
    } catch { /* no document (unit sandbox): the tick still bounds itself */ }
    DevChat._tickShotHold();
  },

  _releaseShotHold() {
    const hold = DevChat._shotHold;
    DevChat._shotHold = null;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    try {
      document.removeEventListener('pointerdown', hold.onUserInput, true);
      document.removeEventListener('keydown', hold.onUserInput, true);
    } catch { /* ignore */ }
  },

  _tickShotHold() {
    const hold = DevChat._shotHold;
    if (!hold) return;
    if (DevChat._addressKey() !== hold.addr || Date.now() >= hold.until) {
      DevChat._releaseShotHold();
      return;
    }
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(DevChat._tickShotHold, SHOT_HOLD_RETRY_MS);
    if (hold.spec.showing() || !hold.spec.ready()) return;
    // Deferred a frame: on the render that armed this hold the anchor was
    // written synchronously just above, and the kit's flip/clamp placement
    // needs its settled rect.
    requestAnimationFrame(() => {
      if (DevChat._shotHold !== hold) return;
      if (DevChat._addressKey() !== hold.addr) return;
      if (hold.spec.showing() || !hold.spec.ready()) return;
      hold.spec.open();
    });
  },

  // Ask the DOCUMENT whether the surface is up, never a handle: the kit
  // owns the teardown (outside click, Escape, scroll) and a dismissed
  // popover leaves its Promise handle set until the microtask that clears
  // it runs. `.un-action-sheet` is the same surface on touch, where the
  // kit's adaptive menu draws a sheet instead.
  _shotSurfaceShowing() {
    return !!document.querySelector('.un-popover, .un-action-sheet');
  },

  // Screenshot-state deep link `?shot=venue-sheet` (#1086): the sheet the
  // change control opens, with all six venues on it. Armed once per
  // addressed session (see _shotVenueSheetHash) — after its window closes a
  // re-render must not pop it open under the user — and held up for that
  // window by the machinery above.
  _maybeOpenShotVenueSheet() {
    const addr = DevChat._addressKey();
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { return; }
    if (shot !== 'venue-sheet') return;
    const anchor = () => document.getElementById('dc-venue-select');
    // Already armed for this session: the hold owns the reopen, but a
    // re-render is the one moment worth asking for it NOW rather than at
    // the next tick.
    if (DevChat._shotVenueSheetHash === addr) { DevChat._tickShotHold(); return; }
    DevChat._shotVenueSheetHash = addr;
    DevChat._holdShotSurface('venue-sheet', addr, {
      ready: () => {
        const btn = anchor();
        return !!(btn && btn.offsetParent !== null && window.BuildVenues);
      },
      showing: () => DevChat._shotSurfaceShowing(),
      open: () => {
        DevChat.openVenueSheet(anchor());
        requestAnimationFrame(() => DevChat._assertMenuSurfaceOpaque());
      },
    });
  },

  // Screenshot-state deep link `?shot=session-options-instructions` (#1055):
  // the local-CLI card, open. Armed once per addressed session (see
  // _shotOptionsHash) and held up the same way. `restore` is renderChatView
  // telling us it just dismissed a card that was open a moment ago:
  // reopening what was already open is not popping anything open, so the
  // hold is ticked immediately instead of leaving the composer bare until
  // the next one.
  //
  // The readiness anchor is the venue dropdown, not the composer: the card
  // is reached by picking the CLI venue now (#1353 retired the "⋯" this
  // used to wait for), and the dropdown is the one control that survives
  // every venue's swap.
  _maybeOpenShotOptions(restore) {
    const addr = DevChat._addressKey();
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== 'session-options-instructions') return;
    if (DevChat._shotOptionsHash === addr) {
      if (restore) DevChat._tickShotHold();
      return;
    }
    DevChat._shotOptionsHash = addr;
    DevChat._holdShotSurface(`options:${shot}`, addr, {
      ready: () => {
        const btn = document.getElementById('dc-venue-select');
        return !!(btn && btn.offsetParent !== null && window.SessionOptions);
      },
      showing: () => DevChat._shotOptionsShowing(),
      open: () => {
        DevChat._optionsCard = SessionOptions.openInstructions({
          state: DevChat._sessionOptionsState(),
          onClose: () => { DevChat._optionsCard = null; },
        });
      },
    });
  },

  // With a kit present openInstructions hands its panel to the kit's modal
  // shell and never attaches the overlay it built, so a truthy handle is
  // not evidence the card is on screen; the card's own `<pre>` is. (A modal
  // is not scroll-dismissed either, so its hold only ever waits for the
  // open — it never has to repair one.)
  _shotOptionsShowing() {
    const pre = document.getElementById('dc-options-commands');
    return !!(pre && pre.isConnected);
  },

  // Same regression lock as home.js's card menu (#847): a translucent
  // surface is invisible to a selector/text check — every row is present
  // and correct, you just read the session through them. Stamp the verdict
  // for the dapp.json check and console.error on a violation so the
  // baseline no-console-errors check trips on the same route.
  //
  // It guarded the "⋯" menu's popover until #1353 retired that button. The
  // property it was guarding is `--un-popover-bg`, which every kit popover
  // in the session shares, so it moved to the venue sheet — the popover
  // this screen still opens.
  _assertMenuSurfaceOpaque() {
    const pop = document.querySelector('.un-popover');
    if (!pop) return; // touch idiom: an action sheet over the kit's backdrop
    const bg = getComputedStyle(pop).backgroundColor || '';
    const m = bg.match(/^rgba?\(([^)]+)\)$/);
    const parts = m ? m[1].split(',').map((s) => parseFloat(s.trim())) : [];
    const alpha = parts.length >= 4 ? parts[3] : (parts.length === 3 ? 1 : 0);
    const opaque = alpha >= 0.99;
    pop.dataset.surface = opaque ? 'opaque' : 'translucent';
    if (!opaque) {
      console.error(
        `[dev-chat] the session's menu surface is translucent (${bg}) — the`
        + ' composer reads through it. --un-popover-bg must resolve to an opaque color.'
      );
    }
  },

  // ── Development-flow picker + walkthrough (#1049) ──────────────────
  //
  // A fresh session used to open with nothing but a text box, and the ONLY
  // way to discover that Homeroom can hand the work to your own Claude Code
  // or Codex was to install the MCP connector. So the choice is offered
  // here instead: a card at the top of an empty session naming all three
  // routes, and — if you pick an external one — a five-step walkthrough
  // that watches your progress (GitHub linked → fork → work order → pushed
  // branch → submitted).
  //
  // All markup lives in public/js/dev-flow-select.js; this is the state and
  // the fetching. State is per-session and deliberately thin: every step is
  // re-derived from GET /api/apps/:slug/dev-flow/status, so closing the tab
  // mid-flow and coming back resumes at the same step.
  _devFlow: {
    sessionId: null,
    status: null,
    loading: false,
    // 'wizard' once a flow is picked, null while the picker is showing.
    mode: null,
    agent: null,
    // #1071. The session whose branch the agent pushes back onto, when the
    // hand-off was started from a session that can be continued. null means
    // "this is new work" and the task is prepared app-scoped, exactly as
    // #1049 shipped it.
    targetId: null,
    busy: false,
    error: null,
    notice: null,
    // "Build on Homeroom instead" / "Build here" — hide the card for the
    // rest of this session without writing a preference.
    dismissed: false,
    brief: null,
  },

  // Deep link: ?flow=claude-code|codex opens straight into that
  // walkthrough instead of the picker. The in-app doors (the picker itself,
  // the "+" menu, the out-of-credits card) hand the agent over in memory —
  // this is for a link somebody shares, and for the staging fixtures.
  _devFlowFromQuery() {
    try {
      const q = new URLSearchParams(location.search).get('flow');
      return (q === 'claude-code' || q === 'codex') ? q : null;
    } catch { return null; }
  },

  _resetDevFlow(sessionId) {
    const deepLink = DevChat._devFlowFromQuery();
    DevChat._devFlow = {
      sessionId: sessionId == null ? null : Number(sessionId),
      status: null,
      loading: false,
      mode: deepLink ? 'wizard' : null,
      agent: deepLink,
      targetId: null,
      busy: false,
      error: null,
      notice: null,
      dismissed: false,
      // #1281: what to build, typed into the walkthrough's own field.
      // null means "not typed yet", which is what lets the session title
      // seed it once without overwriting an edit.
      brief: null,
    };
  },

  // Which card (if any) belongs at the top of THIS session's transcript.
  //
  // The PICKER used to live here: a card at the top of every untouched
  // session asking "build here, or hand this to Claude Code / Codex?"
  // before a word had been typed. It was one of three prompts asking the
  // venue question at creation time, and it is gone — the venue dropdown in
  // the session header states the answer instead, and the sheet behind it
  // asks the question whenever the user actually wants to change it. What
  // survives is the WALKTHROUGH: once a hand-off is chosen, the five steps
  // run in place, in this transcript, and that is a card.
  //
  // So the only gate left is the VENUE (#1353): a walkthrough belongs to a
  // session that is being handed to a web agent, and _currentVenueId() is
  // the one place that decides whether this one is — the stored column, a
  // pick made in this tab, an imported row, all of it. Reading any of those
  // inputs a second time here is how the screen and the session type it
  // states came to answer differently about the same session.
  //
  // It is normally the LAUNCHPAD that renders this (#1281), which is why
  // renderMessages() drops the card whenever _launchpadVenue() answers. The
  // transcript keeps it for the one case that has no launchpad to put it
  // in: features/dev-chat/launchpad.js failing to load.
  _devFlowTarget() {
    const session = DevChat.currentSession;
    if (!session || !window.DevFlowSelect) return null;
    const venue = DevChat._currentVenueId();
    if (venue === 'web-codex') return { mode: 'wizard', agent: 'codex' };
    if (venue === 'web-claude-code') return { mode: 'wizard', agent: 'claude-code' };
    return null;
  },

  // Only the walkthrough renders in the transcript now — see _devFlowTarget
  // for what left and why.
  _devFlowHtml() {
    const target = DevChat._devFlowTarget();
    if (!target) return '';
    const flow = DevChat._devFlow;
    // The walkthrough paints its "checking where you are" state while the
    // first read is in flight — but it has to be KICKED here, not only by
    // the venue sheet: a saved 'claude-code' / 'codex' preference and a
    // ?flow= deep link both arrive in wizard mode without ever passing
    // through _devFlowFromCredits, and would otherwise check forever.
    if (!flow.status) DevChat._devFlowEnsureStatus();
    return DevFlowSelect.wizardHtml({
      agent: target.agent,
      status: flow.status,
      busy: flow.busy,
      error: flow.error,
      notice: flow.notice,
      // Seeded from the session's own title the first time, so a session
      // opened from a request arrives with its brief already written.
      brief: flow.brief != null ? flow.brief : DevChat._defaultFlowBrief(),
    });
  },

  // The selector must be the marker wizardHtml actually renders. It used to
  // be the PICKER's data-flow-card marker, which #1093 retired with the
  // picker itself — so the walkthrough card was rendered but never wired,
  // and every button on it ("Fork on GitHub", "Copy work order", …) did
  // nothing (#1304). tests/dev-flow-select.test.js pins the two together.
  _wireDevFlowCard() {
    if (!window.DevFlowSelect) return;
    const container = document.getElementById('dc-messages');
    if (!container) return;
    container.querySelectorAll('[data-flow-wizard]').forEach((el) => {
      DevFlowSelect.wire(el, {
        onAction: (action) => DevChat._devFlowAction(action),
      });
    });
  },

  // One status read per session, kicked off lazily by the render. Re-entrant
  // calls collapse onto the in-flight one; `force` is the "Check again"
  // button and the tab-focus re-check.
  async _devFlowEnsureStatus(force) {
    const session = DevChat.currentSession;
    const slug = App.currentApp;
    if (!session || !slug || !window.DevFlowSelect) return;
    const started = DevChat._devFlow;
    if (started.loading) return;
    if (started.status && !force) return;
    started.loading = true;
    let status = null;
    try {
      // `sessionId` is what scopes the walkthrough to THIS launchpad. Appended
      // to whatever the fixture query string already is, which is '' in
      // production and `?demo=…` in a staging preview — hence the separator
      // rather than a bare '?'.
      const fixtureQS = DevChat._devFlowDemoQS();
      // `proposalId`/`targetKind` are the continuation this launchpad is
      // offering (#1054/#1071). They reach the server only so the instructions
      // can name the proposal the agent should update rather than open a
      // second one beside it.
      const target = DevChat._devFlow.targetId
        ? `&proposalId=${encodeURIComponent(DevChat._devFlow.targetId)}`
          + `&targetKind=${encodeURIComponent(DevChat._devFlow.targetKind || 'proposal')}`
        : '';
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/dev-flow/status`
          + `${fixtureQS}${fixtureQS ? '&' : '?'}sessionId=${encodeURIComponent(session.id)}${target}`,
        { credentials: 'same-origin' }
      );
      // A failed read is not an error the user needs — the card simply
      // doesn't render (or the walkthrough keeps its last known steps).
      status = res.ok ? await res.json() : { available: false, reason: 'unavailable' };
    } catch {
      status = { available: false, reason: 'unavailable' };
    } finally {
      // _resetDevFlow REPLACES the state object (opening a session does it),
      // so the answer has to land on whatever object is live now rather than
      // on the one this call started from — writing to a discarded object
      // leaves the walkthrough saying "checking where you are" forever.
      const live = DevChat._devFlow;
      started.loading = false;
      live.loading = false;
      if (Number(live.sessionId) === Number(session.id)) live.status = status;
      // Only repaint if we're still looking at the session we asked about.
      if (DevChat.currentSession && Number(DevChat.currentSession.id) === Number(session.id)) {
        DevChat._repaintDevFlow();
      }
    }
  },

  async _devFlowAction(action) {
    const flow = DevChat._devFlow;
    flow.error = null;
    flow.notice = null;
    if (action === 'cancel') {
      // "Build here instead" / "Build on Homeroom instead" — the same act as
      // picking On-Platform in the venue sheet, so it does the same two
      // things (#1353). Dismissing the in-memory wizard alone left a session
      // whose venue column had already been stored answering "handed to
      // Claude Code" on the very next paint: the button said Homeroom, the
      // header said the web, and the launchpad never left.
      if (DevChat.currentSession && DevChat.currentSession.build_venue) {
        DevChat.currentSession.build_venue = null;
        DevChat._persistBuildVenue(null);
      }
      DevChat._devFlowReturnToChat();
      DevChat.renderChatView();
      return;
    }
    if (action === 'link-github' || action === 'link-connector') {
      window.location.hash = '#settings/connectors';
      return;
    }
    // #1281: the vendor toggle at the top of the launchpad. Switching is
    // cheap and loses nothing — an external task is minted per vendor when
    // the work order is prepared, and the status read re-derives every step
    // for whichever one is now selected. The saved default moves with it,
    // for the same reason picking a venue in the sheet moves it: the toggle
    // IS the deliberate act.
    if (action === 'vendor-claude-code' || action === 'vendor-codex') {
      const next = action === 'vendor-codex' ? 'codex' : 'claude-code';
      if (flow.agent === next) return;
      flow.agent = next;
      flow.mode = 'wizard';
      flow.status = null;
      DevChat._saveDevFlowPreference(next);
      const venue = next === 'codex' ? 'web-codex' : 'web-claude-code';
      if (DevChat.currentSession) DevChat.currentSession.build_venue = venue;
      DevChat._persistBuildVenue(venue);
      DevChat.renderChatView();
      DevChat._devFlowEnsureStatus(true);
      return;
    }
    if (action === 'refresh' || action === 'open-fork' || action === 'open-agent') {
      // The two "open …" actions are real anchors — the browser owns the
      // trip out (#1312); re-reading the status is what makes coming back
      // feel watched.
      await DevChat._devFlowEnsureStatus(true);
      return;
    }
    if (action === 'copy') {
      // The instructions, not a work order. Homeroom no longer writes the work
      // order — the agent asks what to build and mints its own through the
      // connector, which is also what stopped a stale one being able to sit in
      // this tab at all.
      const text = (flow.status && flow.status.instructions) || '';
      if (!text) {
        flow.error = 'No instructions to copy yet.';
        DevChat._repaintDevFlow();
        return;
      }
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch { copied = false; }
      if (copied) flow.notice = 'Instructions copied. Paste them into your agent, which will ask what you want to build.';
      else flow.error = 'Could not reach the clipboard. Open the instructions below and copy them by hand.';
      DevChat._repaintDevFlow();
      return;
    }
    if (action === 'prepare') return DevChat._devFlowPrepare();
    if (action === 'discard') return DevChat._devFlowDiscard();
    if (action === 'submit') return DevChat._devFlowSubmit();
    // #1071. A separate action, not a flag on 'submit': the two hit different
    // routes with different bodies and different failure modes, and a single
    // action that silently changed meaning depending on state is exactly the
    // kind of thing that opens the wrong pull request.
    if (action === 'submit-update') return DevChat._devFlowSubmitUpdate();
    return undefined;
  },

  // Step 3. The brief is whatever the user typed in the message box — the
  // same text they would have sent to the platform agent, so the choice of
  // flow costs them no re-typing.
  async _devFlowPrepare() {
    const flow = DevChat._devFlow;
    const slug = App.currentApp;
    // #1281: the walkthrough carries its own brief field, because in a
    // launchpad venue the composer is hidden and #dc-input is not something
    // the user can reach. The composer stays the fallback for the one place
    // the walkthrough still renders in the transcript.
    const box = document.querySelector('[data-flow-brief]');
    const input = box || document.getElementById('dc-input');
    const brief = input ? String(input.value || '').trim() : '';
    if (!brief) {
      flow.error = box
        ? 'Say what to build first. The work order needs something to hand your agent.'
        : 'Describe the change in the message box below first. The work order needs something to hand your agent.';
      DevChat._repaintDevFlow();
      // Repainting replaced the node, so focus what is on screen NOW rather
      // than the detached element captured above.
      const live = document.querySelector('[data-flow-brief]') || document.getElementById('dc-input');
      if (live) live.focus();
      return;
    }
    // Survive the repaints below: every _repaintDevFlow rebuilds the card,
    // and a brief the user typed must not vanish under them.
    flow.brief = brief;
    flow.busy = true;
    DevChat._repaintDevFlow();
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/external-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // `sessionId` is what makes this work order THIS launchpad's: the
        // status route reads it back and no other session sees the order.
        body: JSON.stringify(Object.assign(
          { agent: flow.agent, brief },
          DevChat.currentSession ? { sessionId: Number(DevChat.currentSession.id) } : null,
          flow.targetId ? { proposalId: Number(flow.targetId) } : null
        )),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flow.error = data.error || 'Could not prepare the work order.';
        return;
      }
      // Clear the box: the brief now lives on the work order, and leaving
      // it behind invites sending the same text to the platform agent too.
      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      flow.notice = data.reused
        ? 'You already had a work order for this app, so this reuses it.'
        : 'Work order ready.';
    } catch (err) {
      flow.error = `Network error: ${err.message}`;
    } finally {
      flow.busy = false;
      await DevChat._devFlowEnsureStatus(true);
      DevChat._repaintDevFlow();
    }
  },

  // The hand-off step's "Start over". Puts the open work order away and drops
  // back to step 3's brief field, which is the whole point: the walkthrough shows
  // whatever open task the account holds for this app, so a stale one is
  // otherwise permanent.
  //
  // `flow.brief` is cleared rather than left alone. It is seeded from the
  // session title, and re-rendering the old text under a fresh work order is
  // how you get a second work order describing the same finished change — an
  // empty box asking "What should it build?" is the question actually being
  // put to the user here.
  //
  // A 404 is not surfaced as an error: it means the task was already closed,
  // so the re-read below leaves the walkthrough in exactly the state the user
  // was reaching for.
  async _devFlowDiscard() {
    const flow = DevChat._devFlow;
    const slug = App.currentApp;
    const task = flow.status && flow.status.task;
    if (!task) {
      flow.error = 'No work order to put away.';
      DevChat._repaintDevFlow();
      return;
    }
    flow.busy = true;
    DevChat._repaintDevFlow();
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/external-tasks/${encodeURIComponent(task.id)}/discard`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }
      );
      if (res.ok || res.status === 404) {
        flow.brief = '';
        flow.notice = 'Work order put away. Say what you want to build instead.';
      } else {
        const data = await res.json().catch(() => ({}));
        flow.error = data.error || 'Could not put that work order away.';
      }
    } catch (err) {
      flow.error = `Network error: ${err.message}`;
    } finally {
      flow.busy = false;
      await DevChat._devFlowEnsureStatus(true);
      DevChat._repaintDevFlow();
    }
  },

  // Step 5. Homeroom opens the cross-fork pull request with its own
  // credentials and imports it as an ordinary proposal, then we jump to it.
  async _devFlowSubmit() {
    const flow = DevChat._devFlow;
    const slug = App.currentApp;
    const task = flow.status && flow.status.task;
    if (!task) {
      flow.error = 'No work order to submit yet.';
      DevChat._repaintDevFlow();
      return;
    }
    flow.busy = true;
    DevChat._repaintDevFlow();
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/external-tasks/${encodeURIComponent(task.id)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({}),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flow.error = data.error || 'Could not submit the branch.';
        return;
      }
      PlatformUI.toast(`Proposal opened from PR #${data.prNumber || ''}`.trim());
      flow.dismissed = true;
      if (data.sessionId) {
        await DevChat.openSession(data.sessionId, { userOpened: true });
        DevChat.renderChatView();
        return;
      }
      await DevChat._devFlowEnsureStatus(true);
    } catch (err) {
      flow.error = `Network error: ${err.message}`;
    } finally {
      flow.busy = false;
      DevChat._repaintDevFlow();
    }
  },

  // Step 5, the continue variant (#1071). The branch already exists — this
  // moves the session's (or proposal's) head onto what the web agent pushed,
  // through the same update-from-fork gate the MCP connector uses.
  //
  // No expectedHeadSha: the server-side gate compares against the head it
  // tracks itself, and pinning the task's base commit here would turn an
  // idempotent re-press into a false "somebody else advanced it".
  async _devFlowSubmitUpdate() {
    const flow = DevChat._devFlow;
    const slug = App.currentApp;
    const task = flow.status && flow.status.task;
    const target = task && task.targetProposal;
    if (!task || !target || !target.id) {
      flow.error = 'No proposal to update yet.';
      DevChat._repaintDevFlow();
      return;
    }
    flow.busy = true;
    DevChat._repaintDevFlow();
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/external-tasks/${encodeURIComponent(task.id)}/submit-update`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ proposalId: Number(target.id), branch: task.branch || undefined }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // base_mismatch and branch_moved carry the commit to act on, and the
        // server's own sentence is the one that names it. Surfaced verbatim
        // rather than flattened into "could not submit", which would leave
        // the user with nothing to do next.
        flow.error = data.message || data.error || 'Could not submit the update.';
        return;
      }
      if (data.unchanged) {
        // Nothing landed, so the card stays: the branch is still the thing
        // the user is waiting on, and dismissing the walkthrough here would
        // take away the only place to press again.
        flow.notice = 'Nothing new to submit. This session is already on that commit.';
        DevChat._repaintDevFlow();
        return;
      }
      if (data.resumeRequired) {
        // The paused tail: the commit landed, the preview and checks did not
        // start. Saying so is the whole point — silence here looks broken.
        PlatformUI.toast('Update landed. Reopen this session to rebuild its preview and re-run its checks.');
      } else if (data.votesCleared) {
        PlatformUI.toast(`Update submitted: ${data.votesCleared} vote${data.votesCleared === 1 ? '' : 's'} cleared`);
      } else {
        PlatformUI.toast('Update submitted');
      }
      flow.dismissed = true;
      // Re-open the target — the same session in the continue case, the
      // proposal in the promoted one — so the header, the branch line and
      // the check state reflect the commit that just landed.
      const sessionId = data.proposalId || target.id;
      if (sessionId) {
        await DevChat.openSession(sessionId, { userOpened: true });
        DevChat.renderChatView();
      }
      return;
    } catch (err) {
      flow.error = `Network error: ${err.message}`;
    } finally {
      flow.busy = false;
      DevChat._repaintDevFlow();
    }
  },

  // Re-check when the tab regains focus. The whole external flow happens in
  // ANOTHER tab (GitHub, claude.ai/code, chatgpt.com/codex), so coming back
  // here is the single most reliable moment to notice that the fork now
  // exists or the branch has been pushed. Bound once per document.
  _bindDevFlowVisibility() {
    if (DevChat._devFlowVisibilityBound) return;
    DevChat._devFlowVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (DevChat._devFlow.mode !== 'wizard') return;
      if (DevChat._devFlow.busy) return;
      DevChat._devFlowEnsureStatus(true);
    });
  },

  async loadSessions(appSlug) {
    try {
      const res = await fetch(`/api/apps/${appSlug}/sessions`);
      if (!res.ok) return;
      const { sessions } = await res.json();
      DevChat.sessions = sessions;
    } catch {}
  },

  // ── Cross-app active sessions ─────────────────────────────
  //
  // Pulls the user's full set of non-archived sessions across every
  // app they own and re-renders the "Active Sessions (x/y)" panel
  // on the dev-chat tab. Tolerates network blips (the panel just
  // shows the previous snapshot until the next poll lands).

  async loadActiveSessions() {
    // #1038: stamped BEFORE the request goes out — see SessionState.seed.
    const issuedAt = Date.now();
    try {
      const res = await fetch('/api/me/active-sessions');
      if (!res.ok) return;
      const data = await res.json();
      DevChat.activeSessions = {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        totals: data.totals || { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 },
        // Per-viewer cap denominators from the server (full platform
        // admins get raised caps). Falls back to the historical
        // regular-user numbers so a cached response from an older server
        // renders "(N/3)" instead of "(N/undefined)".
        caps: data.caps || { activeSessions: 3, promotedSessions: 5 },
      };
      // This payload carries per-row busy flags; fold them into the live
      // store rather than letting them stop here.
      if (typeof window !== 'undefined' && window.SessionState) {
        SessionState.seed(DevChat.activeSessions.sessions, issuedAt);
      }
    } catch {}
  },

  // `startActiveSessionsPoll` / `stopActiveSessionsPoll` /
  // `renderActiveSessions` are retired (#1367). They drove an
  // "Active Sessions (x/y)" panel whose hosts — `#dc-active-list` and
  // `#dc-active-counter` — no longer exist in any markup, so the renderer
  // resolved nothing and returned on its first line, and the 5s poll had no
  // caller left at all. `loadActiveSessions` STAYS: five callers depend on
  // it, and its real job now is seeding `SessionState` with the per-row busy
  // flags that payload carries. The `.dc-active-*` rules in app.css go with
  // them.

  // Shared post-mutation refresh for pause/resume/archive: pull the
  // cross-app panel data, and if we're currently viewing the same
  // app the session belongs to, refresh the per-app list too so
  // both surfaces stay in sync in a single tick.
  async _refreshSessionListsAfterMutation() {
    await DevChat.loadActiveSessions();
    if (
      typeof AppView !== 'undefined' &&
      AppView.appData &&
      AppView.appData.slug
    ) {
      await DevChat.loadSessions(AppView.appData.slug);
      DevChat.renderSessionList();
    }
  },

  // #287: an optional issueNumber links the new session back to the issue
  // row's start-work button (created_from_issue_number) so the row can
  // swap "Create proposal" → "Create new proposal". Omitted on the generic
  // "+ New chat" path, which sends no body and stores NULL.
  // The venue question is NOT asked here.
  //
  // Creating a session used to open a blocking modal — "Where should this
  // build?" — before a single word had been typed, and two more prompts
  // stood behind it on other entry points. Asking then is asking at the
  // worst possible moment: the user has an intention, not yet a preference,
  // and the only honest answer to "which agent" before you know what the
  // work is, is "whichever one you already told me". So the saved default
  // is applied silently by the server (resolveDefaultAgentPreference) and
  // the answer is STATED afterwards, on first paint, by the venue dropdown
  // in the session header (#1348) — which is also what opens the sheet that
  // changes it. One question, asked once, changeable any time.
  //
  // `agentChoice` survives for the callers that DID make an explicit pick
  // (the venue sheet itself, and the out-of-credits card). No key is sent
  // without one, which is what lets the server resolve the default.
  async createSession(appSlug, issueNumber, agentChoice = null) {
    try {
      const hasIssue = Number.isInteger(issueNumber) && issueNumber > 0;
      const choice = agentChoice || {};
      const res = await fetch(`/api/apps/${appSlug}/sessions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(hasIssue ? { issueNumber } : {}),
          // Omitted, not nulled: POST /sessions reads "no backend key" as
          // "resolve my default", and a literal null would be a value.
          ...(choice.backend ? {
            backend: choice.backend,
            model: choice.model || null,
            reasoningEffort: choice.reasoningEffort || null,
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        PlatformUI.toast(data.error || 'Failed to create session');
        return null;
      }
      // /api/auth/me was loaded before a first-use managed key existed.
      // Keep venue gating in sync with the authoritative session response
      // without waiting for a full page reload.
      if (data.session?.agent_backend === 'codex_openrouter'
          && typeof App !== 'undefined' && App.user) {
        App.user.openrouterAvailable = true;
      }
      // The one thing the venue dropdown cannot work out on its own: WHY
      // this session isn't in the venue the user's default named.
      if (data.agentFallbackReason && window.BuildVenues) {
        DevChat._venueFallbackReason = data.agentFallbackReason;
      }
      DevChat.sessions.unshift(data.session);
      // Improve renders its own cross-app cache, not DevChat.sessions. Publish
      // the successful server row now so the first open after creation cannot
      // briefly claim that no changes are in progress (#1596).
      try { window.Improve?.onSessionCreated?.(data.session, appSlug); } catch {}
      return data.session;
    } catch {
      PlatformUI.toast('Network error');
      return null;
    }
  },

  // Re-sync the open session's server-side status and, if it was auto-
  // paused while we held it open, resume it. This closes the stale-client
  // gap behind "Active session not found": the sweeper flips an idle
  // 'active' session to 'paused' after ~5 min, and a backgrounded tab
  // stops heartbeating — but /activity can't revive a 'paused' row, and
  // the local currentSession.status is still 'active', so the next chat
  // send 404s. Calling this on refocus (and as a chat-send retry) heals
  // it the same way openSession's auto-resume does.
  //
  // Returns true when the session is now active/promoted (resumable),
  // false otherwise. `silent` suppresses the user-facing alert so a
  // transient failure on every refocus doesn't nag.
  // True only when the signed-in viewer OWNS this session row. Auto-resume
  // is gated on it: `GET /api/sessions/:id` answers for an admin looking at
  // someone else's session (and for any collaborator on a shared app), but
  // resume is owner-scoped on the server — its UPDATE carries
  // `AND user_id = $2`. Firing it as a non-owner can only fail, and it fails
  // loudly: a 429 off the platform-wide capacity check (which runs BEFORE
  // the ownership match, and whose slot reclamation would pause a third
  // party's session) or a 404 after it. Both put a console error on the
  // route and pop a toast at someone who did nothing but open a session to
  // read it. Same rule as the server-side activity bump on that GET:
  // viewing someone's session must not keep it — or make it — awake.
  _ownsSession(session) {
    return !!(session && typeof App !== 'undefined' && App.user
      && session.user_id === App.user.id);
  },

  async _resumeCurrentSessionIfPaused({ silent = false } = {}) {
    const s = DevChat.currentSession;
    if (!s || !s.id) return false;
    const sessionId = s.id;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return false;
      const { session } = await res.json();
      if (!session) return false;

      // Already active/promoted — just keep the local copy in sync.
      if (session.status !== 'paused') {
        if (DevChat.currentSession && DevChat.currentSession.id === sessionId) {
          DevChat.currentSession.status = session.status;
        }
        return ['active', 'promoted'].includes(session.status);
      }
      if (!DevChat._ownsSession(session)) return false;

      const rr = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
      if (rr.ok) {
        if (DevChat.currentSession && DevChat.currentSession.id === sessionId) {
          DevChat.currentSession.status = 'active';
        }
        DevChat._refreshSessionListsAfterMutation().catch(() => {});
        return true;
      }
      if (!silent) {
        const data = await rr.json().catch(() => ({}));
        PlatformUI.toast(data.error || 'Could not resume this session right now. Try again in a moment.');
      }
      return false;
    } catch {
      // Network blip — leave local state as-is; the caller decides what to
      // surface (the chat-send path still shows its own error on retry).
      return false;
    }
  },

  // Activity heartbeat. While a session is open and the browser tab is
  // visible, ping the server (~every 60s) so last_activity_at stays
  // fresh. That's what lets the server's auto-pause timer run on a short
  // (~5 min) window aligned with worker eviction without pausing a
  // session the user is actively reading. A single persistent interval
  // is created once and no-ops whenever no session is open or the tab is
  // hidden/backgrounded — so a session pauses ~5 min after the user
  // actually leaves (closes/backgrounds the tab, or navigates out of the
  // app, which clears currentSession via reset()).
  _startHeartbeat() {
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      const s = DevChat.currentSession;
      if (!s || !s.id) return;
      fetch(`/api/sessions/${s.id}/activity`, { method: 'POST' }).catch(() => {});
    };
    if (!DevChat._heartbeatVisHandler) {
      // Bump immediately on regaining visibility so a just-refocused
      // session isn't caught by the next sweep tick. If the session was
      // already auto-paused while the tab was hidden (>5 min), the bump
      // alone can't revive it — /activity only touches active/promoted
      // rows — so also re-sync and resume so the next send doesn't 404.
      //
      // Skip the resume when the LOCAL status already says 'paused':
      // that means the user deliberately paused this session (the pause
      // click-handlers sync the local copy), and silently re-activating
      // it would re-occupy the slot they just freed (#193). The heal is
      // only for the stale-client case where local status still says
      // 'active'. Sending a chat message or reopening the session still
      // resumes explicitly via their own paths.
      DevChat._heartbeatVisHandler = () => {
        if (document.visibilityState !== 'visible') return;
        beat();
        // #940: catch up on drafts saved elsewhere while this tab was
        // backgrounded, and flush anything this device failed to upload.
        if (DevChat.currentSession) DevChat._reconcileDrafts(DevChat.currentSession.id, null);
        if (DevChat.currentSession && DevChat.currentSession.status === 'paused') return;
        DevChat._resumeCurrentSessionIfPaused({ silent: true });
      };
      document.addEventListener('visibilitychange', DevChat._heartbeatVisHandler);
    }
    if (DevChat._heartbeatTimer) return;
    DevChat._heartbeatTimer = setInterval(beat, 60000);
  },

  // `userOpened` says a PERSON asked for this session (a click on a row /
  // active chip, a hash restore, the reopen at the end of a dev flow) as
  // opposed to the several machine refetches that also route through here to
  // re-read the session record: the fallback-done reconcile, the progress
  // poll's !busy branch, the sync-terminal refresh. Only the former is the
  // "user saw it" signal that disarms notify_on_done and dismisses the
  // session's unread completion server-side, so only the former forwards
  // ?opened=1 — otherwise the turn's own reconcile fetch clears the
  // completion it just produced and the cog's green badge never shows.
  async openSession(sessionId, { userOpened = false, signal } = {}) {
    if (signal?.aborted) return false;
    // #161: opening a DIFFERENT session while the current one is
    // mid-turn counts as leaving it — arm its completion notification.
    // (Returning to the SAME session needs no client call: the server's
    // GET /api/sessions/:id below disarms it when the user opened it.)
    if (DevChat.isStreaming && DevChat.currentSession
        && Number(DevChat.currentSession.id) !== Number(sessionId)) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    }

    // Session-open is authoritative for the streaming UI. When opening a
    // DIFFERENT session than the one currently tracked, tear down the
    // per-turn client streaming state to idle FIRST, so a
    // previously-streaming session can't leak its red Stop button or
    // "⏳ Thinking…" title into a freshly-opened idle session (e.g. a
    // proposal clone, which is always idle on open). The `if (busy)`
    // block further down is then the SOLE place that re-arms streaming,
    // so a session that is genuinely mid-turn still re-enters the live
    // UI. We only tear down THIS tab's UI + subscriptions here — the
    // previous session's server-side turn keeps running untouched (its
    // completion notification was just armed above). Gated on a
    // session-id change so reopening a genuinely busy session doesn't
    // flicker the Stop button off and immediately back on (or needlessly
    // drop and reopen its resumable stream). _setStreamingUI(false)
    // clears the live 'thinking' marker but leaves the sticky #161
    // completion marker (_titleCompletion) alone.
    const switchingSession = !DevChat.currentSession
      || Number(DevChat.currentSession.id) !== Number(sessionId);
    if (switchingSession) {
      DevChat._stopSpendPolling();
      // #771: a docked staging preview belongs to the session we're
      // leaving — close it so session A's preview can't render beside
      // session B's chat.
      if (DevChat.stagingPanel.open) DevChat._resetStagingPanel();
      DevChat.isStreaming = false;
      DevChat._streamingPhase = null;
      DevChat._streamingStoppable = true;
      // #990: never inherit the previous session's trailing dots.
      DevChat._activity = null;
      DevChat._stopProgressPolling();
      DevChat._closeResumableStream();
      // Abort the previous session's in-flight POST SSE the same way
      // reset() does. Without this, the old session's chat reader loop
      // keeps running after the switch and leaks its tokens / cc_progress
      // lines into the freshly-opened session's view (#329). isStreaming
      // was just set false, so the post-loop recovery branch won't reopen
      // a resumable stream for the abandoned turn.
      if (DevChat._abortController) {
        try { DevChat._abortController.abort(); } catch {}
        DevChat._abortController = null;
      }
      DevChat._setStreamingUI(false);
    }
    try {
      // …and never on a screenshot deep link, for the same reason the
      // auto-resume below skips one: `?shot=` names a state to RENDER, and
      // silently resolving the session's notification is a mutation.
      const asUser = userOpened && !DevChat._isShotDeepLink();
      const res = await fetch(`/api/sessions/${sessionId}${asUser ? '?opened=1' : ''}`, { signal });
      if (!res.ok) return false;
      const { session, messages, drafts } = await res.json();
      if (signal?.aborted) return false;

      // Auto-resume on open: opening a paused session transparently
      // resumes it (the backend applies the per-user LRU + global cap
      // logic, auto-pausing the user's least-recently-active session if
      // needed). We flip the local status optimistically so the rest of
      // renderChatView treats it as active; other tabs sync via the
      // server's 'resumed' WS event. If resume is refused (e.g. the
      // global cap is hit), leave it paused and tell the user. Owner only —
      // see _ownsSession; a non-owner reading the session leaves it paused.
      // …and never on a screenshot deep link (#1071): `?shot=` names a state
      // to RENDER, and a shot of a paused session that silently un-pauses it
      // is a shot of something else. It also made the capture's outcome depend
      // on the platform's session cap — the refusal toasts a 429, which reads
      // as a console error on the route and fails the check for a reason that
      // has nothing to do with what it asserts.
      if (session.status === 'paused' && DevChat._ownsSession(session) && !DevChat._isShotDeepLink()) {
        try {
          const rr = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST', signal });
          if (rr.ok) {
            session.status = 'active';
          } else {
            const data = await rr.json().catch(() => ({}));
            PlatformUI.toast(data.error || 'Could not resume this session right now. Try again in a moment.');
          }
        } catch { /* network blip — fall through; session stays paused */ }
      }

      if (signal?.aborted) return false;
      DevChat.currentSession = session;
      DevChat._publishPreview();
      // #940: reconcile this session's saved drafts against the server copy
      // — the cross-device sync AND the migration of drafts that only ever
      // existed in this browser. Deliberately NOT awaited: the list paints
      // from the local mirror in renderChatView below, and the reconcile
      // repaints when it lands, so opening a session never waits on it.
      // `drafts` is null when the session payload's best-effort field
      // failed, which makes _reconcileDrafts fetch the list itself.
      DevChat._reconcileDrafts(session.id, drafts);
      // #1960: `?shot=draft-delete` stages the reported failure on top of
      // that list. No-op on every other URL and every other session.
      DevChat._applyDraftDeleteShot(session.id);
      DevChat._startHeartbeat();
      // Drop any streaming title marker carried over from the previous
      // session. If THIS session is mid-run, the busy check below
      // re-applies "thinking" via _setStreamingUI. The #161 completion
      // marker lives in its own slot (_titleCompletion) and is
      // deliberately untouched here — it stays sticky while the user is
      // away and clears on return / notification read.
      DevChat.setTitleStatus(null);
      // #233: the spec viewer is a single global state slot, not keyed
      // per session — switching sessions must drop the previous
      // session's content (and open flag) or it leaks into the new
      // session's panel. Number-compare because openSession receives
      // the id from DOM datasets (string) while openSpecViewer stores
      // currentSession.id (number). Re-opening the SAME session keeps
      // the cached content so returning repaints instantly.
      if (DevChat.specViewer.sessionId != null
          && Number(DevChat.specViewer.sessionId) !== Number(sessionId)) {
        DevChat._resetSpecViewer();
      }
      // Restore the spec viewer's open/closed state from localStorage
      // before the caller's renderChatView fires, so a refresh on a
      // session that had the viewer open paints with the panel
      // already mounted. The data fetch is kicked off in the
      // background by _loadSpecViewer; the empty side-panel renders
      // immediately and fills in once the spec_md round-trip lands.
      //
      // `?shot=spec-viewer` is the screenshot-state deep link for the
      // panel: its open state otherwise lives only in localStorage, so no
      // URL could reach it for checks/screenshots (which only navigate).
      // Pure UI state — it reads nothing and writes nothing — so like
      // ?shot=menu it is deliberately ungated by environment.
      let shotSpecViewer = false;
      try {
        shotSpecViewer = new URLSearchParams(location.search).get('shot') === 'spec-viewer';
      } catch { /* ignore */ }
      if (shotSpecViewer || DevChat._readSpecViewerOpen(sessionId)) {
        DevChat.specViewer.open = true;
        DevChat.specViewer.sessionId = sessionId;
        DevChat.specViewer.viewVersion = 'latest';
        DevChat.specViewer.viewVersionContent = null;
        DevChat.specViewer.activeTab = 'user';
        // Don't await — caller's renderChatView shouldn't block on
        // the fetch. _loadSpecViewer publishes when it resolves, which
        // repaints the body in place.
        DevChat._loadSpecViewer({ force: true });
      }
      // Q/A answer state is per-question-turn — never carry one across
      // a session switch / reload. Three stores, one per way of answering:
      // a tapped chip, a typed reply, a stepped number.
      DevChat._qaSelection = {};
      DevChat._qaTyped = {};
      DevChat._qaTypedOpen = {};
      DevChat._qaNumber = {};
      // #891: the AI-guess state is per-run. Carrying it across a session
      // switch would let another session's stale guess drain onto this
      // timeline, and a stale `_lastEstimateAt` would suppress this
      // session's first real estimate as "not newer".
      DevChat._pendingEstimate = null;
      DevChat._lastEstimateAt = null;
      DevChat.messages = messages.map((m) => {
        if (m.metadata) {
          if (m.metadata.stagingUrl) m.stagingUrl = m.metadata.stagingUrl;
          // #361: the "Changes ready" card is driven by an explicit marker
          // (set on both the staging-success and staging-failed branches of
          // runClaudeCodeTool) rather than incidentally by stagingUrl, so it
          // rehydrates the same whether or not a preview built. When staging
          // failed the disabled-Preview note reads stagingErrorName /
          // stagingMissingKeys; prNumber/prUrl back the header + GitHub link.
          if (m.metadata.changesReady) m.changesReady = true;
          if (m.metadata.stagingFailed) m.stagingFailed = true;
          if (m.metadata.stagingErrorName) m.stagingErrorName = m.metadata.stagingErrorName;
          if (m.metadata.stagingMissingKeys) m.stagingMissingKeys = m.metadata.stagingMissingKeys;
          if (m.metadata.prNumber != null) m.prNumber = m.metadata.prNumber;
          if (m.metadata.prUrl) m.prUrl = m.metadata.prUrl;
          // #664: the worker proxy's one-time "switched to your API key"
          // notice — rehydrate the marker so the row keeps its subtle
          // inline-notice styling on reload.
          // #894's `turnError`, which nothing read until now: five paths in
          // routes/sessions.js persist it and the row came back as an
          // ordinary system status, wearing the pipeline's green ✓.
          if (m.metadata.turnError) m.turnError = true;
          // A stop that landed. The prose sentence is in `content`; this
          // is the same landing as data, so the row can draw chips.
          if (m.metadata.stopLanding) m.stopLanding = m.metadata.stopLanding;
          if (m.metadata.billingSwitch) m.billingSwitch = true;
          if (m.metadata.ccLog) m.ccLog = m.metadata.ccLog;
          if (m.metadata.ccOutput) m.ccOutput = m.metadata.ccOutput;
          if (m.metadata.ccSummary) m.ccSummary = m.metadata.ccSummary;
          if (m.metadata.progressLog) m.progressLog = m.metadata.progressLog;
          if (m.metadata.agentBackend) m.agentBackend = m.metadata.agentBackend;
          if (m.metadata.agentModel) m.agentModel = m.metadata.agentModel;
          // #50: terminal statuses persist how long the run took so the
          // "(took 4m 12s)" suffix survives a reload.
          if (m.metadata.durationMs != null) m.durationMs = m.metadata.durationMs;
          // #286: a persisted AI progress estimate ({ text, remainingSeconds })
          // hydrates the running line's guess on load — mirrors the live
          // cc_estimate path (_applyEstimate) so a seeded/recovered active
          // run shows the same '✦ AI guess' span. Absent on real runs that
          // never persist it, so this is a no-op there.
          if (m.metadata.estimate && m.metadata.estimate.text) {
            m._estimate = String(m.metadata.estimate.text).trim();
            m._estimateRemaining = m.metadata.estimate.remainingSeconds == null
              ? null
              : m.metadata.estimate.remainingSeconds;
            // #359/#891: anchor from the persisted `estimatedAt` when the
            // snapshot carries one; otherwise fall back to load time (reads
            // slightly high, and the next live cc_estimate corrects it).
            // #892: prefer the persisted post-guard value when present.
            m._countdownTo = DevChat._countdownTarget(
              m.metadata.estimate.displayedRemainingSeconds != null
                ? m.metadata.estimate.displayedRemainingSeconds
                : m._estimateRemaining,
              m.metadata.estimate.estimatedAt
            );
          }
          // Spec preview cards: scout dispatches persist these on the
          // status row so a refresh re-renders the same inline card the
          // user saw mid-stream. See runScoutTool. Older recovered scout
          // turns persisted scoutOutput without specPreview — derive the
          // preview so their cards still render.
          if (m.metadata.specPreview) m.specPreview = m.metadata.specPreview;
          else if (m.metadata.scoutOutput && m.metadata.specVersion != null) {
            const t = String(m.metadata.scoutOutput);
            m.specPreview = t.length <= 400 ? t : `${t.slice(0, 400)}…`;
          }
          if (m.metadata.specLines) m.specLines = m.metadata.specLines;
          if (m.metadata.specVersion != null) m.specVersion = m.metadata.specVersion;
          // Q/A mode (#32): suggested-answer chips for the Mayor's
          // clarifying questions survive refresh via metadata.
          if (m.metadata.suggestions) m.suggestions = m.metadata.suggestions;
          // Quick-reply pills (#285): next-step suggestions survive refresh
          // via metadata.quickReplies on the assistant row.
          if (m.metadata.quickReplies) m.quickReplies = m.metadata.quickReplies;
          // File attachments (#450): user rows carry a metadata summary
          // [{ id, kind, filename, contentType, sizeBytes }]; bytes are
          // served by GET /api/sessions/:id/attachments/:attId.
          if (Array.isArray(m.metadata.attachments) && m.metadata.attachments.length) {
            m.attachments = m.metadata.attachments;
          }
          // Platform-issue drafts: the agent suggested escalating a
          // platform-level blocker; the card's confirm/dismiss buttons
          // post to /api/sessions/:id/platform-issue/:msgId/*. The DB row
          // id doubles as the draft's msgId on rehydrate.
          if (m.metadata.platformIssueDraft) {
            m.platformIssueDraft = { ...m.metadata.platformIssueDraft, msgId: m.id };
          }
          // A background preview rebuild marks its in-progress row
          // `stagingBuild: 'running'`. Carried onto the message so the
          // spinner pass below can find it after a reload — the /status
          // check can't help here, because a heal-sweep or preview-click
          // rebuild has no turn in flight to report.
          if (m.metadata.stagingBuild) m.stagingBuild = m.metadata.stagingBuild;
        }
        return m;
      });
      // A staging/check result belongs to the session, not to the browser
      // tab that happened to receive its SSE event. Most web-authored turns
      // also persist a matching system row, but CLI handoff builds run after
      // the request has returned and historically only updated chat_sessions
      // before broadcasting `staging_ready`. A closed/reloading Dev page
      // therefore missed the event and showed no Changes ready card even
      // though the authoritative session row had a live preview and verdict.
      // Derive the missing presentation row on read. This also repairs old
      // CLI sessions without a data migration; a real persisted card always
      // wins, so normal histories and cloned cards are not duplicated.
      DevChat.messages = DevChat._hydrateChangesReadyFromSession(session, DevChat.messages);
      // #647: flag the rows this session inherited from an auto session so
      // their Claude Code disclosures render collapsed by default.
      // Spin a still-running background rebuild's row on load. Rebuilds take
      // minutes (the self-app's DB clone alone is ~4:45), so a reload lands
      // mid-build often enough to matter, and a static gear next to
      // "Building staging preview..." reads as "stuck" — which is exactly
      // the misread that cost session 2954 a duplicate build turn. Every
      // outcome (rebuilt / failed) appends a row after it, so the flag can
      // only stick while the build genuinely is the last word.
      DevChat._activateTrailingStagingBuild();

      // #252: sync state is keyed per session — drop a stale indicator
      // (in-flight or terminal feedback) when switching to a different
      // session. Re-opening the SAME session keeps it; the status
      // check below refreshes the in-flight phase from the server.
      if (DevChat._syncState
          && Number(DevChat._syncState.sessionId) !== Number(sessionId)) {
        DevChat._syncState = null;
        DevChat._stopSyncPolling();
      }

      // #907: runner state is per-session too. Clear it before the status
      // read below re-establishes it, so a session with no machine attached
      // can never inherit the previous session's chip.
      DevChat._runner = null;
      DevChat._runnerLabel = null;
      DevChat._localAgent = null;

      // #1049: the flow picker / walkthrough is per-session state too — a
      // wizard opened on session A must not paint over session B, and the
      // status payload it renders from belongs to the app+session it was
      // read for. Re-opening the SAME session keeps it, so a status poll
      // that arrives during a refresh isn't thrown away.
      if (switchingSession
          || DevChat._devFlow.sessionId == null
          || Number(DevChat._devFlow.sessionId) !== Number(sessionId)) {
        DevChat._resetDevFlow(sessionId);
      }

      // Check if Claude Code is running for this session
      try {
        const statusRes = await fetch(`/api/sessions/${sessionId}/status${DevChat._demoQS()}`, { signal });
        if (statusRes.ok) {
          const statusPayload = await statusRes.json();
          if (signal?.aborted || Number(DevChat.currentSession?.id) !== Number(sessionId)) return false;
          const { busy, progress, phase, sync, stopping, stopRequestedAt, stoppable } = statusPayload;
          // #907: restore the Run-on selector / chip from the server, so a
          // reload of a session with a machine attached does not silently
          // claim the next turn runs on Homeroom.
          DevChat._applyRunnerState(statusPayload);
          // #252: reload recovery for the sync banner. A MODE=sync turn
          // also flips `busy` (it holds the worker), so check it first
          // and don't arm the chat-turn streaming UI for a sync.
          if (sync && sync.phase) {
            DevChat._syncState = {
              sessionId: Number(sessionId), phase: sync.phase, since: Date.now(),
            };
            DevChat._startSyncPolling(Number(sessionId));
          } else if (DevChat._syncState && !DevChat._syncState.terminal) {
            // Stale in-flight state with nothing running server-side
            // (e.g. the platform restarted mid-sync) — clear it.
            // Terminal feedback is left alone so refresh-triggered
            // openSession calls don't wipe the success/failure notice.
            DevChat._syncState = null;
            DevChat._stopSyncPolling();
          }
          if (busy && !(sync && sync.phase)) {
            DevChat.isStreaming = true;
            // #889: a stop is already in flight for this turn — repaint the
            // "Stopping…" button rather than a live red Stop for a turn
            // that's being killed. The transient transcript row is NOT
            // resurrected (it's client-only by design); the persisted
            // "…stopped by @user." row lands normally when the stop does.
            DevChat._stopping = !!stopping;
            DevChat._setStreamingUI(true, phase || null, { stoppable: stoppable !== false });
            // Reuse the most recent persisted progress message as the live
            // append target so the polling fallback updates IT instead of
            // creating a second "Claude Code output (N lines)" collapsible.
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role === 'system' && m.progressLog) { m._progress = true; break; }
            }
            // `_active` is a client-only flag that swaps the static gear
            // glyph for the arc spinner, so on refresh mid-run the latest
            // status line ("Claude Code is running…") needs it
            // re-applied. Pick the newest system message that isn't a
            // finalized artefact (ccOutput / progressLog / stagingUrl /
            // ccLog) — those are terminal, not in-flight.
            //
            // Note: progressLog is technically not "terminal" — it grows
            // as live output streams in. But we treat it as terminal here
            // so `_active` lands on the *parent* "Claude Code is running"
            // status line instead, which then renders as the disclosure
            // summary above the inline log (see renderMessages).
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role !== 'system') continue;
              if (m.ccOutput || m.progressLog || m.stagingUrl || m.ccLog) continue;
              m._active = true;
              break;
            }
            // #990: and re-arm the trailing dots for the same reason — a tab
            // that loads mid-fetch must not render a transcript that looks
            // finished. `_activitySpec` re-checks the live-CC-run gate, so a
            // reload during a coding run still suppresses them.
            DevChat._activity = { label: null };
            // #937: rebuild the stopping row and its escalation ladder from
            // the server's `stopRequestedAt`. Before this, a reload during a
            // stuck stop painted a calm "Stopping…" button with no history —
            // so the escalation and the Force stop button, the user's only
            // way out, could never appear in the reloaded tab. Seeding the
            // clock from the server means a tab that joins 90s in lands
            // straight on the stuck rung instead of restarting at zero.
            //
            // Resurrecting the transient row is safe: it stays flagged
            // `_stopping`, so _clearStoppingState filters it out when the
            // stop lands and the persisted "…stopped by @user." row is
            // still the only thing that survives.
            if (stopping) {
              DevChat._enterStoppingState({ stopRequestedAt: stopRequestedAt || null });
            }
            // Hook into the resumable event stream so we get *live*
            // updates from this tab (tokens, status transitions, PR
            // created, etc.) instead of only what the 3s polling can
            // reconstruct from the DB. Polling stays on as a safety net.
            DevChat._openResumableStream(sessionId);
            DevChat._startProgressPolling(sessionId, progress, statusPayload);
          }
        }
      } catch {}
      return !signal?.aborted;
    } catch { return false; }
  },

  // ── Streaming + send ─────────────────────────────────────

  async sendMessage(message, attachments = []) {
    if (!DevChat.currentSession || DevChat.isStreaming) return;
    // #450: attachments-only sends are allowed; the server stores a
    // "(attached files)" stub caption, mirrored here for the optimistic
    // bubble. `attachments` entries come from pendingAttachments (already
    // uploaded — each carries a server id + objectUrl for image thumbs).
    const sentAttachments = (attachments || []).filter((a) => a && a.id);
    if (!message && !sentAttachments.length) return;
    // #138: a send is a user gesture — unlock the AudioContext and lazily
    // request OS-notification permission now, so the completion chime /
    // notification can fire when this turn finishes (browsers only allow
    // audio + permission prompts from inside a gesture).
    if (window.DevAlerts) {
      DevAlerts._unlockAudio();
      DevAlerts.requestNotifyPermission();
    }
    const model = DevChat.selectedModel;
    const openRouterSession = DevChat._isOpenRouterSession();
    DevChat.isStreaming = true;
    // #889: defensive — a fresh turn must never paint the previous turn's
    // "Stopping…" button. Every teardown path already clears this, but the
    // reload-recovery path sets the flag without a transcript row to hang
    // it on, so reset before arming the new turn's UI.
    DevChat._clearStoppingState();
    DevChat._setStreamingUI(true);
    DevChat._seenSeqs = new Set();
    // Any Q/A answer belonged to the question turn we're now answering — the
    // chips vanish on re-render (the question row is no longer last), so
    // nothing about it may leak into a later turn. All three stores, or the
    // typed reply to one question would arrive as the answer to the next.
    DevChat._qaSelection = {};
    DevChat._qaTyped = {};
    DevChat._qaTypedOpen = {};
    DevChat._qaNumber = {};

    // A previous turn's progress message may still be flagged as the live
    // append target. Clear it so this turn's cc_progress events create a
    // fresh collapsible instead of appending to the prior turn's log.
    for (const m of DevChat.messages) {
      if (m._progress) m._progress = false;
    }

    DevChat.messages.push({
      role: 'user',
      content: message || '(attached files)',
      created_at: new Date().toISOString(),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    });
    // Clear the composer strip — restored on the failure paths below.
    if (sentAttachments.length) {
      DevChat.pendingAttachments = [];
      DevChat._renderAttachStrip();
    }
    // `let`, not `const`: the `assistant_message_end` handler reassigns this
    // to a fresh object when the Mayor seals phase-1 so the phase-2 wrap-up
    // lands in its own bubble. A `const` here used to throw silently inside
    // the per-event try/catch, leaving the phase-2 tokens appended onto the
    // phase-1 object and causing the second bubble to show phase-1 text.
    let assistantMsg = { role: 'assistant', content: '', created_at: null };
    let assistantPushed = false;
    DevChat.renderMessages();
    DevChat._showSpinner();
    DevChat.scrollToBottom();

    DevChat._abortController = new AbortController();

    try {
      const sessionId = DevChat.currentSession.id;
      const postChat = () => fetch(`/api/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          ...(!openRouterSession ? { model } : {}),
          ...(sentAttachments.length ? { attachmentIds: sentAttachments.map((a) => a.id) } : {}),
        }),
        signal: DevChat._abortController.signal,
      });

      let res = await postChat();

      // The session may have been auto-paused while we held it open (the
      // sweeper flips idle 'active' → 'paused' after ~5 min; a backgrounded
      // tab stops heartbeating). The chat route 404s with "Active session
      // not found" in that case. Transparently resume and retry once so the
      // user never sees it — same heal as the refocus path above.
      if (res.status === 404) {
        const peek = await res.clone().json().catch(() => ({}));
        if (/active session not found/i.test(peek?.error || '')) {
          const resumed = await DevChat._resumeCurrentSessionIfPaused({ silent: true });
          if (resumed && DevChat.currentSession && DevChat.currentSession.id === sessionId) {
            res = await postChat();
          }
        }
      }

      if (res.status === 429) {
        const data = await res.json();
        DevChat._removeSpinner();
        // #463: budget exhaustion is not rate limiting — tell the user
        // what actually happened and point at the BYOK escape hatch.
        // Only the server's billing path sets code: 'budget_exceeded';
        // chatLimiter throttles keep the old wording.
        if (data.code === 'budget_exceeded') {
          // This response belongs to the Anthropic-backed path. An
          // OpenRouter session must never turn it into a Claude/Codex
          // recovery card; surface a plain provider error defensively if
          // an older server returns the stale billing gate.
          if (openRouterSession) {
            DevChat.messages.push({
              role: 'assistant',
              content: `**OpenRouter turn could not start.** ${data.error || 'Please try again.'}`,
              created_at: new Date().toISOString(),
            });
            DevChat._finishStreaming();
            DevChat._restoreComposer(message, { dropOptimisticUser: true });
            if (sentAttachments.length) {
              DevChat.pendingAttachments = sentAttachments;
              DevChat._renderAttachStrip();
            }
            DevChat.renderMessages();
            return;
          }
          // The refusal renders as a CARD (public/js/credit-options.js) with
          // all three ways to keep building — own API key, a coding tool on
          // your machine, or a connected Claude.ai / ChatGPT subscription —
          // instead of the old BYOK-only prose. Client-only flag: a refused
          // turn writes no assistant row server-side, and a refusal isn't
          // transcript content. The durable surface for the same state is
          // the banner, recomputed from /api/budget on every load.
          DevChat.messages.push({
            role: 'assistant',
            content: '',
            creditsCard: {
              error: data.error || 'They reset at midnight UTC.',
              hasApiKey: !!(window.Settings && Settings.state && Settings.state.hasApiKey),
              globalOut: DevChat._globalBudgetOut(),
              verificationRequired: !!data.verificationRequired,
              externalFlowsAvailable: DevChat._externalFlowsAvailable(),
              sessionBridgeEnabled: DevChat._sessionBridgeEnabled(),
            },
            created_at: new Date().toISOString(),
          });
          // Refresh the meter + banner right away so the "out of
          // credits" state is visible without waiting for a usage event.
          DevChat.refreshBudget();
        } else {
          DevChat.messages.push({ role: 'assistant', content: `**Rate limit reached.** ${data.error || 'Try again later.'}`, created_at: new Date().toISOString() });
        }
        DevChat._finishStreaming();
        // #370: the cap rejected the send before any turn ran. Put the
        // text back in the composer (editable, draft re-saved) and drop
        // the optimistic user bubble so the message lives only in the
        // editor — the user never has to retype it. Restore AFTER
        // _finishStreaming so the input is re-enabled before we focus it.
        DevChat._restoreComposer(message, { dropOptimisticUser: true });
        if (sentAttachments.length) {
          DevChat.pendingAttachments = sentAttachments;
          DevChat._renderAttachStrip();
        }
        DevChat.renderMessages();
        return;
      }

      // Any other non-2xx response (404 missing/archived session, 400 bad
      // input, 500 server error, …) returns JSON, not SSE. Surface it as
      // an assistant error message and tear down the streaming UI so we
      // don't sit on the spinner forever or kick off resumable-SSE +
      // status polling against a session that was never going to stream.
      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errText = data.error;
        } catch {}
        DevChat._removeSpinner();
        DevChat.messages.push({
          role: 'assistant',
          content: `**Couldn't send message:** ${errText}`,
          created_at: new Date().toISOString(),
        });
        DevChat._finishStreaming();
        // #370: restore the typed text into the composer and drop the
        // optimistic (never-persisted) user bubble so the message isn't
        // lost — same recovery as the 429 cap path above. Leaving the
        // bubble in the list while the spinner disappears is what the
        // user perceived as "my message disappears".
        DevChat._restoreComposer(message, { dropOptimisticUser: true });
        if (sentAttachments.length) {
          DevChat.pendingAttachments = sentAttachments;
          DevChat._renderAttachStrip();
        }
        DevChat.renderMessages();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotFirstToken = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          // Defensive scope guard (#329): if the user has since switched to
          // a different session, this POST SSE belongs to the one we left.
          // The abort in openSession's teardown normally stops us, but it's
          // async relative to already-buffered events — drop the rest of
          // this batch rather than apply it to the now-current session.
          if (Number(sessionId) !== Number(DevChat.currentSession?.id)) break;
          try {
            const data = JSON.parse(line.slice(6));
            if (data._seq && DevChat._seenSeqs?.has(data._seq)) continue;
            if (data._seq) { DevChat._seenSeqs?.add(data._seq); DevChat._lastSeenSeq = data._seq; }
            switch (data.type) {
              case 'token':
                gotFirstToken = true;
                // #990: the reply is arriving — the dots have done their job.
                // Unconditional (not gated on gotFirstToken like the old
                // spinner teardown was) because a mid-turn `status` re-arms
                // them: an explore turn goes token → status → status → token,
                // and a first-token-only hide would leave the dots pinned
                // beside the second bubble. _hideActivity self-guards, so the
                // repeat calls cost nothing.
                DevChat._hideActivity();
                if (!assistantPushed) DevChat._deactivateStatusForFreshBubble();
                assistantMsg.content += data.text;
                if (!assistantPushed) {
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                  DevChat.renderMessages();
                } else {
                  // Update in place — don't re-render entire list on each token.
                  // The stabilized updater holds back the trailing incomplete
                  // line and throttles to one paint/frame so checkbox rows
                  // don't blink as partial markdown re-parses.
                  const displayContent = assistantMsg.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
                  DevChat._renderStreamingMarkdown(assistantMsg, displayContent);
                }
                DevChat.scrollToBottom();
                break;
              case 'done':
                DevChat._flushStreamingFinal();
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'phase':
                DevChat._setStreamingUI(true, data.phase);
                break;
              case 'stopping':
                // #889: a stop was requested for this session — by this tab
                // (echoed back) or by another viewer. Idempotent.
                DevChat._enterStoppingState({ by: data.by, stopRequestedAt: data.stopRequestedAt || null });
                break;
              case 'stopped':
                DevChat._flushStreamingFinal();
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'assistant_message_end':
                // Mayor's first turn just finished (typically followed by
                // a tool dispatch → CC progress → Mayor wrap-up). Seal
                // the current bubble so the wrap-up tokens land in a
                // fresh one below the status/progress system messages.
                // Flush the held-back trailing line first so the sealed
                // bubble shows its complete final content.
                DevChat._flushStreamingFinal();
                if (assistantMsg) assistantMsg._finalized = true;
                assistantPushed = false;
                assistantMsg = { role: 'assistant', content: '', created_at: new Date().toISOString() };
                break;
              case 'status':
                DevChat._flushStreamingFinal();
                // #990: no teardown here any more. A status event means the
                // previous step finished and a NEW one started, so this arm
                // re-arms the indicator below instead of removing it — the
                // old _removeSpinner() here is what left the whole data-tool
                // phase with no live cue at all.
                DevChat._deactivateLastStatus();
                // A status line always closes the current streaming bubble
                // (#99): tokens that arrive after it must render BELOW it,
                // never append to the bubble above. Same sealing as
                // assistant_message_end; a no-op when nothing is streaming.
                if (assistantMsg) assistantMsg._finalized = true;
                assistantPushed = false;
                assistantMsg = { role: 'assistant', content: '', created_at: new Date().toISOString() };
                // #786: quickReplies ride the status event so a
                // restart-recovery breadcrumb repaints the pill bar live
                // (the server persists them on the same system row).
                DevChat.messages.push({ role: 'system', content: data.text, turnError: data.turnError, stopLanding: data.stopLanding, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, stagingBuild: data.stagingBuild, quickReplies: data.quickReplies, agentBackend: data.agentBackend, agentModel: data.agentModel, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
                // #990: a step line means work is under way with nothing else
                // painting yet — put the dots where the next message will
                // land, and keep them there until it does. Set before the
                // render so the indicator rides the same innerHTML write.
                DevChat._showActivity();
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'platform_issue_draft':
                // Agent-suggested platform report (human gate). Deliberately
                // NOT a status event: it lands mid-turn and must not seal
                // bubbles or deactivate the running spinner line.
                DevChat._hideActivity();
                DevChat._pushPlatformIssueDraft(data);
                break;
              case 'staging_ready':
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                if (data.url) {
                  DevChat.currentSession.staging_url = data.url;
                  DevChat._publishPreview();
                  // #127: testing guidance rides along so the PR card's
                  // "Test this change" button works without a refetch.
                  if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
                  if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
                }
                break;
              case 'staging_failed':
                // Staging build failed in a recoverable way (most often a
                // dapp.json staging_default missing, or a required secret
                // unset). The server has already pushed a remediation-rich
                // tool_result back to the Mayor — this UI message is the
                // user-facing companion. Phase-2 wrap-up will follow up
                // with the Mayor's natural-language explanation.
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({
                  role: 'system',
                  content: `Staging build failed: ${data.error || 'unknown error'}`,
                  // #361: a staging_failed event always implies a pushed,
                  // proposable commit, so render the "Changes ready" card
                  // (disabled Preview + working Propose) — not a card-less line.
                  changesReady: true,
                  stagingFailed: true,
                  stagingErrorName: data.errorName || 'Error',
                  stagingMissingKeys: data.missingKeys || [],
                  prNumber: data.prNumber != null ? data.prNumber : (DevChat.currentSession?.pr_number ?? null),
                  prUrl: data.prUrl || DevChat.currentSession?.pr_url || null,
                  created_at: new Date().toISOString(),
                  _slug: Math.random().toString(36).slice(2, 8),
                });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'pr_created':
              case 'pr_updated':
                if (DevChat.currentSession) {
                  if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
                  if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
                  if (data.prTitle) {
                    DevChat.currentSession.pr_title = data.prTitle;
                    // #249: the server mirrors pr_title into
                    // session_title; mirror client-side too so the
                    // display name flips without a refetch.
                    DevChat.currentSession.session_title = data.prTitle;
                  }
                  // Re-render so the new title shows up in the PR card / header
                  // immediately (these only re-render on renderChatView / message
                  // pushes, not on raw event arrival).
                  DevChat.renderChatView();
                }
                break;
              case 'session_titled':
                // #249: a pre-PR display name landed (first message or
                // turn-end refresh) — update the header + session lists.
                if (DevChat.currentSession && data.sessionTitle) {
                  DevChat.currentSession.session_title = data.sessionTitle;
                  DevChat.renderChatView();
                }
                break;
              case 'visuals_ready':
                // #195: the capture finished after staging_ready — stash
                // the artifact ids on the session and re-render so the
                // staging card upgrades in place with the media tiles.
                if (DevChat.currentSession && data.visuals) {
                  DevChat.currentSession.visuals = data.visuals;
                  DevChat.renderMessages();
                }
                break;

              case 'mayor_reasoning': {
                // Server sends the full raw Mayor output after the token
                // stream completes. This is authoritative: even if individual
                // token events were lost in transit (e.g. an older WS-dedup
                // race), we recover the full text here. The raw content —
                // including any [CHAT_ONLY] prefix — is stored on the live
                // assistant message so renderMessages() can show a "Mayor
                // reasoning" collapsible both during streaming and after
                // refresh.
                if (!data.text) break;
                // #990: authoritative text for the bubble — same teardown as
                // the first token, for the path where token events were lost.
                DevChat._hideActivity();
                if (!assistantPushed) {
                  DevChat._deactivateStatusForFreshBubble();
                  assistantMsg.content = data.text;
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                } else if (assistantMsg.content.length < data.text.length) {
                  assistantMsg.content = data.text;
                }
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              }
              case 'suggestions': {
                // Q/A mode (#32): structured suggested answers for the
                // clarifying questions in the current bubble. Sent right
                // after mayor_reasoning, so the assistant message exists;
                // renderMessages draws the tappable chips under it.
                if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
                if (assistantPushed) {
                  assistantMsg.suggestions = data.suggestions;
                  DevChat.renderMessages();
                  DevChat.scrollToBottom();
                }
                break;
              }
              case 'quick_replies': {
                // Quick-reply pills (#285): flat next-step suggestions for
                // the current bubble, rendered as tappable pills ABOVE the
                // composer (prefill-on-tap, never auto-send). The pill bar
                // reads from the latest assistant message's quickReplies, so
                // attaching it here is enough — _renderQuickReplies redraws.
                if (!Array.isArray(data.replies) || !data.replies.length) break;
                if (assistantPushed) {
                  assistantMsg.quickReplies = data.replies;
                  DevChat._renderQuickReplies();
                }
                break;
              }
              case 'cc_progress': {
                // #990: the coding agent's own live log is now the progress
                // cue; dots underneath it would be redundant.
                DevChat._hideActivity();
                DevChat._appendProgressLine(data.text, data);
                DevChat.scrollToBottom();
                // Start /status polling as a fallback in case the SSE stream
                // or the global WS drops before we receive the 'done' event.
                // The first cc_progress tells us a worker is actually running
                // (vs. a CHAT_ONLY reply that never dispatches one), so we
                // only arm the fallback here to avoid prematurely concluding
                // a chat-only turn is "finished".
                if (!DevChat._progressPollTimer && DevChat.currentSession) {
                  DevChat._startProgressPolling(DevChat.currentSession.id, []);
                }
                break;
              }
              case 'cc_estimate':
                // Experimental AI progress estimate (opt-in, server-gated).
                // `cleared: true` (#891) is the server's terminal-marker
                // teardown telling us to blank the guess right now.
                DevChat._applyEstimate(data.text, data.remainingSeconds, {
                  estimatedAt: data.estimatedAt, cleared: data.cleared,
                  displayedRemainingSeconds: data.displayedRemainingSeconds,
                  slipReason: data.slipReason,
                });
                break;
              case 'cc_log':
                DevChat._hideActivity();
                DevChat.messages.push(DevChat._copyActivityAgentMetadata({
                  role: 'system',
                  ccLog: data.log,
                  content: `${DevChat._activityAgentName(data)} log`,
                  created_at: new Date().toISOString(),
                }, data));
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'error':
                DevChat._removeSpinner();
                assistantMsg.content += `\n\n> **Error:** ${data.error}`;
                DevChat.renderMessages();
                break;
              case 'usage':
                assistantMsg.model = data.model;
                assistantMsg.costCents = data.costCents;
                if (data.estimated) assistantMsg.costEstimated = true;
                DevChat._noteTurnUsage(data);
                DevChat.refreshBudget();
                break;
              case 'spec_updated':
                // A scout dispatch drafted (or revised) the live
                // spec_md. The accompanying status event already
                // pushed an inline preview card into the timeline — we
                // just keep the open viewer in sync if the user
                // happens to have it open on the live draft.
                DevChat._handleSpecUpdated(data);
                break;
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        DevChat._removeSpinner();
      }
    }

    // The primary POST SSE either drained to 'done' (which already called
    // _finishStreaming and set isStreaming = false) or it died early.
    // In the latter case, recover via two parallel fallbacks:
    //
    //   1. The resumable GET /events SSE — same server, replays from our
    //      last seen _seq via EventSource's built-in Last-Event-Id retry.
    //      This is the *live* recovery path; it keeps the UI feeling
    //      real-time across network blips, proxy idle-kills, and WS
    //      reconnect churn.
    //
    //   2. /status polling — covers the worst case where the Node
    //      process restarted and the in-memory ring buffer is gone. The
    //      on-disk progressLog is still authoritative, and the poll
    //      flips busy=false to finalize the UI when the run completes.
    if (DevChat.isStreaming && DevChat.currentSession) {
      DevChat._openResumableStream(DevChat.currentSession.id);
      // Single progress source while streaming: when the resumable SSE is
      // live it APPENDS progress lines (deduped by _seenSeqs, replayed from
      // our last seen _seq). Running the 3s /status poll too would REPLACE
      // the same log, and a lagging snapshot can momentarily shrink it then
      // regrow — the log visibly flickers. So only arm the poll when the
      // EventSource couldn't open; if the stream later dies for good, its
      // onerror brings the poll up as the Node-restart fallback.
      if (!DevChat._eventSource && !DevChat._progressPollTimer) {
        DevChat._startProgressPolling(DevChat.currentSession.id, []);
      }
    }
  },

  _finishStreaming() {
    // Flush any throttled streaming render to the bubble's exact final
    // content before the full renderMessages() below rebuilds the list.
    DevChat._flushStreamingFinal();
    // #891: the turn is over — an undrained AI guess must not survive to be
    // applied to the first status row of the NEXT turn.
    DevChat._pendingEstimate = null;
    DevChat._lastEstimateAt = null;
    // #990: same discipline as the estimate above — the turn is over, so the
    // trailing dots must not survive into the next one. Cleared BEFORE the
    // renderMessages() below so that render drops the node.
    DevChat._activity = null;
    DevChat.isStreaming = false;
    DevChat._abortController = null;
    DevChat._stopProgressPolling();
    DevChat._closeResumableStream();
    DevChat._lastSeenSeq = null;
    DevChat._setStreamingUI(false);
    DevChat.renderMessages();
    DevChat.refreshBudget();
    // #138: the chime/notification is no longer fired from here. Every
    // interactive turn completion now creates a session_done notification
    // server-side (see notifySessionDone), so the WS `notification_new`
    // arrival in Notifications.handleIncoming → DevAlerts.onCompletion is
    // the single source of the chime (foreground) / OS notification
    // (backgrounded), even when the user is watching this same dev chat.
  },

  // Self-healing sync for degraded turns (#446): called from the WS and
  // resumable 'done' handlers — the two paths that only run when the
  // primary POST SSE did NOT finish the turn (a healthy primary stream
  // delivers its own 'done' first and seq-dedup swallows the copies).
  // Anything that rode only the dead stream (suggestion chips, quick-reply
  // pills, a late mayor_reasoning) is persisted but missing from the
  // in-memory timeline, so reload the session — the automated equivalent
  // of the manual refresh users do today. Mirrors what the /status poll
  // fallback already does when it sees busy=false.
  async _reconcileAfterFallbackDone(sessionId) {
    const sid = sessionId != null ? sessionId : DevChat.currentSession?.id;
    if (sid == null) return;
    if (Number(sid) !== Number(DevChat.currentSession?.id)) return;
    // A newer turn already started — its own stream owns the timeline now.
    if (DevChat.isStreaming) return;
    try {
      await DevChat.openSession(sid);
      DevChat.renderMessages();
      DevChat.scrollToBottom();
    } catch { /* the next poll or manual refresh still recovers */ }
  },

  // Open (or reopen) the resumable GET /events SSE for the active session.
  // EventSource handles reconnect automatically and sends Last-Event-Id on
  // each retry, which the server uses to replay missed events from its
  // per-session ring buffer. On the first connect we also pass `?since=`
  // explicitly so we can replay events that were already delivered over
  // the primary POST SSE but lost mid-stream.
  _openResumableStream(sessionId) {
    if (typeof EventSource === 'undefined') return;
    if (DevChat._eventSource) return;
    const since = DevChat._lastSeenSeq;
    const url = since
      ? `/api/sessions/${sessionId}/events?since=${encodeURIComponent(since)}`
      : `/api/sessions/${sessionId}/events`;
    let es;
    try { es = new EventSource(url); } catch { return; }
    DevChat._eventSource = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        DevChat._handleResumedEvent(data, sessionId);
      } catch {}
    };
    es.onerror = () => {
      // EventSource silently auto-retries. If the browser closes it for
      // good (readyState === CLOSED), drop our reference so a later
      // cc_progress or drop-detection can open a fresh one. Progress
      // polling is the last-resort fallback in that window.
      if (es.readyState === 2 /* CLOSED */ && DevChat._eventSource === es) {
        DevChat._eventSource = null;
        // The resumable SSE gave up for good. It was the single live
        // progress source (we suppress the poll while it's open), so now
        // bring the 3s /status poll up as the worst-case fallback — this
        // is what finalizes the UI if a Node restart lost the ring buffer.
        if (DevChat.isStreaming && DevChat.currentSession && !DevChat._progressPollTimer) {
          DevChat._startProgressPolling(DevChat.currentSession.id, []);
        }
      }
    };
  },

  _closeResumableStream() {
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  // Handle an event arriving on the *resumable* channel (either the
  // GET /events EventSource opened after a POST SSE drop, or a later
  // retry of same). The closure-local state from sendMessage's POST SSE
  // loop (assistantMsg / assistantPushed / gotFirstToken) is no longer
  // reachable here — instead we locate the live assistant message by
  // scanning DevChat.messages, and create one if the run ended up with
  // no tokens before the drop.
  _handleResumedEvent(data, sessionId) {
    // Defensive scope guard (#329): drop a late resumable-SSE event that
    // arrives for a session the user has already navigated away from, so
    // it can't paint into the now-current session. `sessionId` is the id
    // the EventSource was opened for; absent (legacy callers) skips the
    // check.
    if (sessionId != null && Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
    if (data._seq) {
      if (DevChat._seenSeqs?.has(data._seq)) return;
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      DevChat._lastSeenSeq = data._seq;
    }
    const lastAssistantMsg = () => {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        if (DevChat.messages[i].role === 'assistant') return DevChat.messages[i];
      }
      return null;
    };
    switch (data.type) {
      case 'token': {
        // #990: the reply is arriving — same teardown as the POST-SSE path.
        DevChat._hideActivity();
        let am = lastAssistantMsg();
        // No assistant message yet for this turn → push a fresh one.
        // The user message is already in DevChat.messages so insertion
        // order is correct.
        let freshBubble = false;
        if (!am || am._finalized) {
          DevChat._deactivateStatusForFreshBubble();
          am = { role: 'assistant', content: '', created_at: new Date().toISOString() };
          DevChat.messages.push(am);
          freshBubble = true;
        }
        am.content += data.text;
        const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
        // The first token of a fresh bubble arrives through a full render, not
        // through the streaming writer — the same order the POST-SSE path
        // above uses, and for a reason that only became visible once the
        // writer stopped guessing its target: the model SKIPS an assistant row
        // with no content, so rendering the placeholder before the append put
        // no bubble on screen for this turn. The old writer then resolved
        // `querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content')
        // [length - 1]` — the PREVIOUS turn's bubble — and wrote into it.
        if (freshBubble) DevChat.renderMessages();
        else DevChat._renderStreamingMarkdown(am, displayContent);
        DevChat.scrollToBottom();
        break;
      }
      case 'mayor_reasoning': {
        if (!data.text) break;
        DevChat._hideActivity();
        let am = lastAssistantMsg();
        // Once an assistant bubble is sealed (_finalized, via
        // assistant_message_end), a fresh mayor_reasoning belongs to
        // the *next* bubble — otherwise we'd overwrite phase-1's text
        // with phase-2's wrap-up when replaying on reconnect.
        if (!am || am._finalized) {
          DevChat._deactivateStatusForFreshBubble();
          DevChat.messages.push({ role: 'assistant', content: data.text, created_at: new Date().toISOString() });
          DevChat.renderMessages();
        } else if (am.content !== data.text) {
          // Reconcile an EXISTING live bubble to the server's authoritative
          // text whenever it DIFFERS — not only when it's longer (#358). The
          // server may have SHORTENED the text by scrubbing a hallucinated
          // "[CODING AGENT COMPLETED]" marker the user already saw stream in;
          // a grow-only patch would leave that fake marker on screen until
          // reload. Patch the content node in place via the stabilized
          // streaming updater rather than tearing down and rebuilding the
          // whole list (which would re-parse and re-mount every
          // checkbox-bearing message mid-stream). The full renderMessages()
          // still runs when a new bubble is pushed above.
          am.content = data.text;
          const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
          DevChat._renderStreamingMarkdown(am, displayContent);
        }
        DevChat.scrollToBottom();
        break;
      }
      case 'suggestions': {
        // Q/A mode (#32): attach the suggested answers to the live
        // assistant bubble (replayed right after mayor_reasoning). A
        // sealed bubble means a dispatch turn, where suggestions were
        // already dropped server-side — skip rather than mis-attach.
        if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
        const am = lastAssistantMsg();
        if (am && !am._finalized) {
          am.suggestions = data.suggestions;
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
        break;
      }
      case 'quick_replies': {
        // Quick-reply pills (#285), replayed right after the wrap-up
        // mayor_reasoning. This case was missing, so a "Build it" pill
        // delivered over the resumable channel was silently dropped until
        // refresh. Mirrors the primary POST-SSE handler: attach to the
        // latest assistant bubble; the pill bar reads from it (hidden
        // while streaming, surfaces when _finishStreaming re-renders).
        if (!Array.isArray(data.replies) || !data.replies.length) break;
        const am = lastAssistantMsg();
        if (am) {
          am.quickReplies = data.replies;
          DevChat._renderQuickReplies();
        }
        break;
      }
      case 'done':
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        // A 'done' on the resumable channel means the primary POST SSE never
        // finished this turn — reconcile from the DB so anything that rode
        // only the dead stream shows without a manual refresh (#446).
        DevChat._reconcileAfterFallbackDone(sessionId);
        break;
      case 'phase':
        // Server announces which phase of the turn we're in so the UI
        // can toggle between stop-button (interruptible) and spinner
        // (wrap-up). The `_setStreamingUI(true, …)` call is cheap and
        // idempotent — it just swaps the button glyph.
        DevChat._setStreamingUI(true, data.phase);
        break;
      case 'stopping':
        // #889: mirrors the primary POST-SSE handler. Replayed off the
        // resumable channel this is how a tab that reconnected mid-stop
        // learns the turn is being killed.
        DevChat._enterStoppingState({ by: data.by, stopRequestedAt: data.stopRequestedAt || null });
        break;
      case 'stopped': {
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // The status system-message ("Stopped by @user.") was already
        // persisted and emitted server-side via sendStatus, so no need
        // to add another row here — just tear down the streaming UI.
        DevChat._finishStreaming();
        break;
      }
      case 'assistant_message_end': {
        // Seal the current assistant bubble so a subsequent `token`
        // event starts a fresh one (matches the primary POST-SSE path).
        // Flush the held-back trailing line so the sealed bubble is exact.
        DevChat._flushStreamingFinal();
        const am = lastAssistantMsg();
        if (am) am._finalized = true;
        break;
      }
      case 'status': {
        DevChat._flushStreamingFinal();
        // #990: no teardown here — see the POST-SSE status handler.
        DevChat._deactivateLastStatus();
        // A status line always closes the current streaming bubble (#99):
        // tokens replayed after it must start a fresh bubble below it,
        // matching the primary POST-SSE path's seal-on-status.
        const sealMsg = lastAssistantMsg();
        if (sealMsg) sealMsg._finalized = true;
        // #786: carry quickReplies (see the POST-SSE status handler).
        DevChat.messages.push({ role: 'system', content: data.text, turnError: data.turnError, stopLanding: data.stopLanding, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, stagingBuild: data.stagingBuild, quickReplies: data.quickReplies, agentBackend: data.agentBackend, agentModel: data.agentModel, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8), _active: true });
        // #990: keep a live cue where the next message will land — see the
        // POST-SSE status handler. Set before the render so both channels
        // emit the indicator inside the same innerHTML write.
        DevChat._showActivity();
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      }
      case 'platform_issue_draft':
        DevChat._hideActivity();
        DevChat._pushPlatformIssueDraft(data);
        break;
      case 'billing_switched':
        // #664: mid-turn switch onto the user's own API key — mirror the
        // WS handler (app.js) so the notice also lands when only the
        // resumable channel is live. The system row is already persisted
        // server-side; this is the live render + meter refresh.
        DevChat.messages.push({ role: 'system', content: data.text, billingSwitch: true, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        DevChat.refreshBudget();
        break;
      case 'staging_ready':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // #439: a replayed staging_ready may be resolving an on-demand
        // Preview-click rebuild — open the new URL if its loader is pending.
        AppView.onStagingRebuildResult(sessionId, { url: data.url });
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url && DevChat.currentSession) {
          DevChat.currentSession.staging_url = data.url;
          DevChat._publishPreview();
          // #127: keep the replayed session's testing guidance in sync too.
          if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
          if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
        }
        break;
      case 'staging_failed':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // #439: surface a failed on-demand rebuild in the preview loader.
        AppView.onStagingRebuildResult(sessionId, { failed: true, error: data.error });
        DevChat.messages.push({
          role: 'system',
          content: `Staging build failed: ${data.error || 'unknown error'}`,
          // #361: same as the primary SSE path — a failed staging build still
          // means there's a reviewable commit, so render the card.
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: data.errorName || 'Error',
          stagingMissingKeys: data.missingKeys || [],
          prNumber: data.prNumber != null ? data.prNumber : (DevChat.currentSession?.pr_number ?? null),
          prUrl: data.prUrl || DevChat.currentSession?.pr_url || null,
          created_at: new Date().toISOString(),
          _slug: Math.random().toString(36).slice(2, 8),
        });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'pr_created':
      case 'pr_updated':
        if (DevChat.currentSession) {
          if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) {
            DevChat.currentSession.pr_title = data.prTitle;
            // #249: server mirrors pr_title into session_title.
            DevChat.currentSession.session_title = data.prTitle;
          }
          DevChat.renderChatView();
        }
        break;
      case 'session_titled':
        // #249: pre-PR display name landed — refresh header/session UI.
        if (DevChat.currentSession && data.sessionTitle) {
          DevChat.currentSession.session_title = data.sessionTitle;
          DevChat.renderChatView();
        }
        break;
      case 'visuals_ready':
        // #195: same upgrade-in-place as the primary POST-SSE path.
        if (DevChat.currentSession && data.visuals) {
          DevChat.currentSession.visuals = data.visuals;
          DevChat.renderMessages();
        }
        break;
      case 'cc_progress':
        DevChat._hideActivity();
        DevChat._appendProgressLine(data.text, data);
        DevChat.scrollToBottom();
        break;
      case 'cc_estimate':
        // Experimental AI progress estimate (opt-in, server-gated).
        // `cleared: true` (#891) blanks the guess at the coding run's end.
        DevChat._applyEstimate(data.text, data.remainingSeconds, {
          estimatedAt: data.estimatedAt, cleared: data.cleared,
          displayedRemainingSeconds: data.displayedRemainingSeconds,
          slipReason: data.slipReason,
        });
        break;
      case 'cc_log':
        DevChat._hideActivity();
        DevChat.messages.push(DevChat._copyActivityAgentMetadata({
          role: 'system',
          ccLog: data.log,
          content: `${DevChat._activityAgentName(data)} log`,
          created_at: new Date().toISOString(),
        }, data));
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'error': {
        DevChat._removeSpinner();
        const am = lastAssistantMsg();
        if (am) am.content += `\n\n> **Error:** ${data.error}`;
        else DevChat.messages.push({ role: 'assistant', content: `> **Error:** ${data.error}`, created_at: new Date().toISOString() });
        DevChat.renderMessages();
        break;
      }
      case 'usage': {
        const am = lastAssistantMsg();
        if (am) {
          am.model = data.model;
          am.costCents = data.costCents;
          if (data.estimated) am.costEstimated = true;
        }
        DevChat._noteTurnUsage(data);
        DevChat.refreshBudget();
        break;
      }
      case 'spec_updated':
        DevChat._handleSpecUpdated(data);
        break;
    }
  },

  _handleSpecUpdated(data) {
    // The status event for this same write already pushed an inline
    // preview card into the timeline (see the case 'status' arms),
    // which is the user-facing surface. The only thing left to do
    // here is keep the side viewer in sync if the user is following
    // the latest version — a write creates a new highest version, and
    // the 'latest' sentinel should advance to it on reload.
    if (DevChat.specViewer.open && DevChat.specViewer.viewVersion === 'latest') {
      DevChat._loadSpecViewer({ force: true });
    }
  },

  // Phase-aware button state (#28):
  //   - idle: "Send"
  //   - mayor1 / cc: red "Stop" button (clickable, aborts the turn)
  //   - mayor2: spinner (the wrap-up cannot be stopped because CC
  //             already pushed a commit + opened the PR)
  // A `null` phase while streaming means the client hasn't received a
  // `phase` event yet (older turn before this feature, or reconnect
  // before the first phase emit). Default to the stop affordance so the
  // user always has a way out; the server rejects the /stop request if
  // it's already in phase-2 anyway.
  _streamingPhase: null,

  // #1378: whether POST /stop can actually do anything for this turn, as
  // reported by /status. A turn adopted after a platform restart runs with
  // no in-process stop handle, so the red Stop square would be a lie — the
  // click reaches the server, finds nothing to stop, and the turn keeps
  // going. Defaults to true: an older server omits the field, and the
  // pre-#1378 behaviour (always offer Stop) is the right thing to fall back
  // to when we genuinely don't know.
  _streamingStoppable: true,

  // Title markers for the dev-chat status indicator (#108). Kept as a
  // map so applyTitleStatus can strip whichever one is currently
  // applied before re-prefixing.
  // Status text leads the title so it survives browser-tab truncation —
  // a glance at a narrow tab shows "⏳ Thinking…" even when the app
  // name doesn't fit.
  TITLE_STATUS_MARKERS: {
    thinking: '⏳ Thinking… · ',
    // #161 completion tier — set by notification arrival (see
    // setCompletionTitle), not by stream end.
    sessionDone: '✅ Session done · ',
    autoSolveDone: '🤖 Proposal ready · ',
    autoSolveFailed: '⚠️ Proposal failed · ',
  },

  // "Away" = the user can't currently see this page: the browser tab is
  // hidden, or the window has lost focus (another window on top). Used
  // to decide whether a finished run should leave a sticky "done"
  // marker in the title (#142).
  _userIsAway() {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  },

  // #161: arm/disarm the server-side "notify me when this turn
  // finishes" flag for a session. Fire-and-forget — arming is
  // best-effort and the endpoint is idempotent, so duplicate or lost
  // calls are harmless (the pagehide beacon is the backstop for tab
  // close / hard navigations, where a normal fetch may be killed).
  _setNotifyOnDone(sessionId, armed) {
    if (!sessionId) return;
    try {
      fetch(`/api/sessions/${sessionId}/notify-on-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: !!armed }),
      }).catch(() => {});
    } catch { /* non-fatal */ }
  },

  // Set (or clear, with null) the dev-chat status reflected in
  // document.title. Non-null statuses only stick while the dev-chat tab
  // is the mounted tab — a turn finishing while the user is on the App
  // or Group Chat tab must not decorate those views' titles.
  setTitleStatus(status) {
    if (status && (typeof App === 'undefined' || !(App.currentTab === 'dev' && App.currentSubTab === 'sessions'))) {
      status = null;
    }
    if (DevChat._titleStatus === status) return;
    DevChat._titleStatus = status;
    DevChat.applyTitleStatus();
  },

  // #161: set (or clear, with null) the completion marker. Unlike
  // setTitleStatus this is NOT scoped to the dev-chat tab — the whole
  // point is the user is elsewhere (another tab, another view) when the
  // completion notification arrives. Cleared by the visibility/focus
  // return handler at the bottom of this file and by
  // Notifications._reconcileCompletionTitle when the triggering
  // notification is read.
  setCompletionTitle(status) {
    if (DevChat._titleCompletion === status) return;
    DevChat._titleCompletion = status;
    DevChat.applyTitleStatus();
  },

  // Re-derive document.title from the current base title + status
  // marker. Composes with Notifications._updateTitle's "(N) " unread
  // prefix: the count stays outermost — `(2) ⏳ MyApp` — because the
  // notifications module treats everything after the count as the base,
  // and we treat the count as a passthrough prefix here. Also safe to
  // call when no marker applies (it just strips a stale one). Exposed
  // (not underscored) because App.setHeaderTitle calls it after every
  // navigation re-set of the title.
  applyTitleStatus() {
    const full = document.title;
    const countMatch = full.match(/^\(\d+\)\s*/);
    const count = countMatch ? countMatch[0] : '';
    let base = full.slice(count.length);
    for (const m of Object.values(DevChat.TITLE_STATUS_MARKERS)) {
      if (base.startsWith(m)) { base = base.slice(m.length); break; }
    }
    // Precedence (#161): completion marker outranks the streaming
    // status; clearing the completion falls back to the live status, so
    // a still-streaming watched session reverts to "⏳ Thinking…".
    const active = DevChat._titleCompletion || DevChat._titleStatus;
    const marker = active ? DevChat.TITLE_STATUS_MARKERS[active] : '';
    const next = count + marker + base;
    if (next === full) return;
    document.title = next;
    // Mirror setHeaderTitle's fast-path sync to the native shell so the
    // Flutter AppBar tracks the marker too (unknown methods are dropped
    // by older app builds — see setHeaderTitle for the full story).
    try {
      if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
        window.Usernode.postMessage(JSON.stringify({
          method: 'titleChanged',
          value: document.title,
        }));
      }
    } catch (_) {}
  },

  // The composer's PAINT state, latched here rather than read from
  // `isStreaming`. They are not the same question: the `?shot=busy` capture
  // paints a mid-turn composer with no turn running at all (#801), and the
  // finish path calls this with `false` on the line before the flag drops.
  // `renderChatView` resets it, which is what the idle template used to do.
  _composerBusy: false,

  _setStreamingUI(streaming, phase = null, { stoppable = true } = {}) {
    DevChat._composerBusy = !!streaming;
    if (streaming) DevChat._startSpendPolling();
    // #2118: an OpenRouter session keeps the turn's figure up after the
    // turn. There is no daily meter for it to be absorbed into, and the
    // cost only became known as the run ended, so clearing it at `done`
    // would show it for a few hundred milliseconds at best.
    else DevChat._stopSpendPolling({ keepSpend: DevChat._isOpenRouterSession() });
    if (streaming) DevChat._streamingPhase = phase;
    else DevChat._streamingPhase = null;
    // #1378: kept alongside the phase so every repaint that only knows the
    // phase (_enterStoppingState, _stopRequestFailed) doesn't silently
    // re-offer a Stop button the server can't honour.
    DevChat._streamingStoppable = streaming ? stoppable !== false : true;

    // #889: the turn is over (stopped, finished, or torn down by a failed
    // send / session switch), so any pending "stopping…" state is stale.
    // Clearing here rather than in _finishStreaming covers every exit —
    // _finishStreaming calls this BEFORE its renderMessages(), and the
    // /status poll fallback calls it directly without going through
    // _finishStreaming at all.
    if (!streaming) DevChat._clearStoppingState();

    // Every streaming state transition funnels through here (send,
    // reconnect, phase change, finish, stop), so this is the one hook
    // needed for the live-status indicator: streaming → "thinking";
    // streaming→idle just clears it. The legacy stream-end "done"
    // marker is gone (#161): finishing while away always produces a
    // session_done notification now, and its arrival sets the
    // completion marker via setCompletionTitle instead.
    if (streaming) DevChat.setTitleStatus('thinking');
    else if (DevChat._titleStatus === 'thinking') DevChat.setTitleStatus(null);

    // Guarded rather than an early `return` (#798): everything below —
    // the composer placeholder, the saved-drafts list, the sync banner —
    // must still resync on a streaming transition even in the rare case
    // where the send button isn't mounted.
    // The send button's four states and the field's placeholder are the
    // composer model's now — see `_sendButtonView`. This wrote `disabled`,
    // three state classes, `aria-label`, `title` and `innerHTML` on the
    // button by hand, and the placeholder on the field.
    //
    // #798: the box stays TYPABLE while the agent works — the user can write
    // the next instruction and park it as a draft (the save icon) instead of
    // holding it in their head. Sending is still impossible mid-turn: the
    // submit handler routes to Stop while streaming and `_submitFromInput`
    // bails on `isStreaming`, so nothing typed here can leak into the
    // running turn. Nothing renders `disabled` on the field for the same
    // reason nothing writes it any more.
    DevChat._publishComposer();
    // #1086: the venue control replaced the coding-agent button that used
    // to sit here, and inherits its guard — a turn in flight holds the
    // worker, so the venue cannot move until it lands. #1348 moved the
    // control to the header, and the header is a component: the guard is
    // `_headerVenue`'s `disabled` now, so this republishes the strip rather
    // than writing the attribute React would overwrite on its next paint.
    DevChat._repaintSessionHeader();
    // The grouped model selector is guarded by the same rule and rides in on
    // the publish above — its old OpenRouter-only control received a
    // `disabled` write here that React would clobber on its next paint.
    DevChat._syncSaveDraftBtn();
    // Re-render the saved-drafts list so each row's Send button picks up
    // the new busy state (disabled while thinking, live once idle).
    DevChat._renderSavedDrafts();

    // #252: the sync banner's button disables (with a hint) while a
    // chat turn holds the worker — keep it in step with every
    // streaming transition. The `#dc-sync-banner` guard is gone with the
    // element lookup it protected: a publish with no banner to draw costs one
    // shallow render of an empty fragment, and asking the DOM whether there is
    // a banner is now asking the wrong owner.
    DevChat._publishBanners();

    // #285: hide the quick-reply pills while a turn is streaming (they're
    // stale until the new reply lands), restore them when it settles.
    DevChat._renderQuickReplies();
  },

  // #889: a stop takes a moment to land (the worker has to be killed and
  // the turn unwound server-side). Until this change nothing in the UI
  // acknowledged the click at all — the red Stop button stayed red, the
  // running status line kept spinning. These two helpers own the interim
  // state: a `_stopping` flag the button paints from, plus one client-only
  // transcript row so the chat says what is happening.
  //
  // The row is deliberately NOT persisted: it lives for a second or two and
  // the server writes the authoritative "…stopped by @user." row when the
  // stop actually lands. Persisting both would double up on refresh.
  _stopping: false,
  _stoppingSlowTimer: null,
  // #937: the escalation ladder's state. `_stoppingSince` is the epoch ms
  // of the stop REQUEST (server-supplied where possible, so a reload or a
  // second tab rebuilds the ladder at the right rung instead of restarting
  // a calm "Stopping…" that never escalates). `_stopRetried` makes the 15s
  // re-POST fire at most once per stop, however many `stopping` events
  // arrive (POST SSE + WS + a bus replay all deliver one).
  _stoppingSince: null,
  _stoppingStuckTimer: null,
  _stopRetried: false,

  // How long a stop may take before the transcript row admits something is
  // wrong. With the server-side fix a stop lands in ~1-2s, so crossing this
  // means a genuinely stuck worker, not a slow one. #937 lowered this from
  // 30s (where the wording was the ONLY thing that ever changed, and it
  // changed too late to be useful) and paired it with a silent re-POST.
  STOPPING_SLOW_MS: 15000,

  // #937: past this the stop is not coming on its own. The row says so
  // plainly and offers Force stop.
  STOPPING_STUCK_MS: 40000,

  _stoppingRow() {
    return DevChat.messages.find((m) => m && m._stopping) || null;
  },

  // #937: (re-)arm the escalation ladder from `_stoppingSince`. Split out
  // of _enterStoppingState so a tab that learns the stop's true age from
  // the server — a reload's status poll, or a `stopping` event from
  // another tab — can jump straight to the rung it should already be on
  // rather than starting the clock over.
  _armStoppingLadder() {
    if (DevChat._stoppingSlowTimer) clearTimeout(DevChat._stoppingSlowTimer);
    if (DevChat._stoppingStuckTimer) clearTimeout(DevChat._stoppingStuckTimer);
    DevChat._stoppingSlowTimer = null;
    DevChat._stoppingStuckTimer = null;

    const since = DevChat._stoppingSince || Date.now();
    const elapsed = Math.max(0, Date.now() - since);

    // Rung 1 — the stop is taking longer than it should. Say so, and
    // quietly ask again: the server treats a repeat stop as idempotent
    // (it re-issues the kill), so this is a free self-heal for the case
    // where the first request's kill found nothing to kill.
    const slow = () => {
      const row = DevChat._stoppingRow();
      if (!row) return;
      row.content = `${row.content.replace(/ \(taking longer than usual\)$/, '')} (taking longer than usual)`;
      DevChat._retryStopRequest();
      DevChat.renderMessages();
    };
    // Rung 2 — it isn't coming. Offer the way out.
    const stuck = () => {
      const row = DevChat._stoppingRow();
      if (!row) return;
      row.content = 'Still stopping. The agent isn’t responding.';
      row._forceOffered = true;
      DevChat.renderMessages();
    };

    if (elapsed >= DevChat.STOPPING_SLOW_MS) slow();
    else DevChat._stoppingSlowTimer = setTimeout(slow, DevChat.STOPPING_SLOW_MS - elapsed);

    if (elapsed >= DevChat.STOPPING_STUCK_MS) stuck();
    else DevChat._stoppingStuckTimer = setTimeout(stuck, DevChat.STOPPING_STUCK_MS - elapsed);
  },

  // #937: the one-shot re-POST behind rung 1. Deliberately silent — if it
  // works the turn just unwinds, and if it doesn't rung 2 is seconds away.
  _retryStopRequest() {
    if (DevChat._stopRetried) return;
    DevChat._stopRetried = true;
    const sessionId = DevChat.currentSession?.id;
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
      .catch((err) => console.warn('[dc] stop retry failed', err));
  },

  // #937: Force stop. Only reachable from rung 2, i.e. after an ordinary
  // stop has been pending ~40s — the server enforces the same ordering and
  // 409s a force with no stop pending.
  async _forceStopTurn(btn) {
    const sessionId = DevChat.currentSession?.id;
    if (!sessionId) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Forcing…';
    }
    let res;
    try {
      res = await fetch(`/api/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
    } catch (err) {
      console.warn('[dc] force stop failed', err);
      return DevChat._stopRequestFailed();
    }
    if (Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
    if (!res.ok) {
      console.warn('[dc] force stop rejected', res.status);
      return DevChat._stopRequestFailed();
    }
    // The server emits `stopped` + `done` itself on the force path, so the
    // ordinary teardown handles the UI from here.
  },

  // Enter (or re-enter) the stopping state. Idempotent by design: the tab
  // that clicked Stop calls this directly AND receives the server's echoed
  // `stopping` event, possibly twice over (POST SSE + WS + a bus replay).
  // All of those must collapse into one row.
  _enterStoppingState({ by = null, stopRequestedAt = null } = {}) {
    if (!DevChat.isStreaming) return;
    if (DevChat._stoppingRow()) {
      // Already showing. Repaint the button in case this arrived before
      // the flag was set (a `stopping` event from another tab).
      DevChat._stopping = true;
      // #937: a server-supplied timestamp is authoritative over the
      // optimistic local one — it's how a tab that clicked Stop and a tab
      // that only heard about it converge on the same rung. Re-arm only
      // when it actually moves the clock.
      if (stopRequestedAt && stopRequestedAt !== DevChat._stoppingSince) {
        DevChat._stoppingSince = stopRequestedAt;
        DevChat._armStoppingLadder();
      }
      DevChat._setStreamingUI(true, DevChat._streamingPhase, { stoppable: DevChat._streamingStoppable });
      return;
    }

    // Freeze whatever was spinning ("Claude Code is running…") so exactly
    // one line in the transcript reads as live.
    DevChat._deactivateLastStatus();
    // #990: "Stopping the agent…" is its own live row — the trailing dots
    // underneath it would claim a reply is still on its way.
    DevChat._activity = null;

    // `_active` earns the arc spinner and the live elapsed ticker that
    // every other in-progress status line uses — see renderMessages.
    const mine = !by || by === window.App?.user?.username;
    DevChat.messages.push({
      role: 'system',
      content: mine ? 'Stopping the agent…' : `@${by} is stopping the agent…`,
      created_at: new Date().toISOString(),
      _slug: Math.random().toString(36).slice(2, 8),
      _active: true,
      _stopping: true,
    });
    DevChat._stopping = true;
    // #937: prefer the server's stamp so every tab (and this one after a
    // reload) escalates off the same clock; fall back to now for the tab
    // that just clicked, whose POST hasn't answered yet.
    DevChat._stoppingSince = stopRequestedAt || Date.now();
    DevChat._stopRetried = false;
    DevChat._armStoppingLadder();

    DevChat._setStreamingUI(true, DevChat._streamingPhase, { stoppable: DevChat._streamingStoppable });
    DevChat.renderMessages();
    DevChat.scrollToBottom();
  },

  // Leave the stopping state, dropping the transient row. Called from
  // _setStreamingUI's not-streaming branch (so every turn-teardown path
  // gets it) and from _stopCurrentTurn's can't-stop branches.
  //
  // Does NOT re-render: callers either re-render right after (the
  // not-streaming branch is followed by _finishStreaming's renderMessages)
  // or paint something else in its place.
  _clearStoppingState() {
    DevChat._stopping = false;
    // #937: the whole ladder is torn down together — both rungs' timers
    // plus the clock and the retry latch they read. Leaving any of them
    // armed would escalate a stop that has already landed.
    if (DevChat._stoppingSlowTimer) {
      clearTimeout(DevChat._stoppingSlowTimer);
      DevChat._stoppingSlowTimer = null;
    }
    if (DevChat._stoppingStuckTimer) {
      clearTimeout(DevChat._stoppingStuckTimer);
      DevChat._stoppingStuckTimer = null;
    }
    DevChat._stoppingSince = null;
    DevChat._stopRetried = false;
    const before = DevChat.messages.length;
    DevChat.messages = DevChat.messages.filter((m) => !(m && m._stopping));
    return DevChat.messages.length !== before;
  },

  async _stopCurrentTurn() {
    if (!DevChat.isStreaming || !DevChat.currentSession) return;
    if (DevChat._streamingPhase === 'mayor2') return;
    const sessionId = DevChat.currentSession.id;

    // Restore the message the user was stopping into the input so they
    // can edit + resend without retyping. We pull from the in-memory
    // messages array (most recent user row is the one they just sent)
    // rather than plumbing it through from sendMessage so this also
    // works when stop is pressed after a cross-tab reconnect. onlyIfEmpty
    // keeps a half-typed follow-up from being clobbered; the sent bubble
    // stays in the timeline (the turn really ran), so no splice here.
    try {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          DevChat._restoreComposer(m.content, { onlyIfEmpty: true });
          break;
        }
      }
    } catch {}

    // Optimistic feedback (#889). This also disables the button, so
    // double-clicks can't fire two POSTs. isStreaming stays true until the
    // server emits `stopped` — we want the authoritative status row to show
    // up before the UI unwinds.
    DevChat._enterStoppingState();

    let res;
    try {
      res = await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    } catch (err) {
      console.warn('[dc] stop request failed', err);
      return DevChat._stopRequestFailed();
    }
    // A session switch mid-request: this answer belongs to the chat we left.
    if (Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
    if (!res.ok) {
      console.warn('[dc] stop request rejected', res.status);
      return DevChat._stopRequestFailed();
    }

    let body = {};
    try { body = await res.json(); } catch {}
    if (Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
    // The happy path: the server accepted the stop and will emit `stopped`
    // (plus the persisted status row) when the turn actually unwinds.
    if (body.stopped) return;

    // #1378: 'no active turn' has two very different meanings. Usually the
    // turn really did end a moment before the click, and the teardown below
    // is right. But it is ALSO what the server answers when the turn is very
    // much alive and simply has no in-process stop handle — a turn adopted
    // after a platform restart. Tearing the UI down there was the reported
    // bug: it dropped the escalation ladder, so Force stop — the one path
    // that actually ends such a turn — became unreachable, and the agent ran
    // on with a Send button in front of it.
    if (body.reason === 'no active turn') {
      let stillBusy = false;
      try {
        const st = await fetch(`/api/sessions/${sessionId}/status`);
        if (st.ok) stillBusy = !!(await st.json()).busy;
      } catch {}
      if (Number(sessionId) !== Number(DevChat.currentSession?.id)) return;
      if (stillBusy || body.hasDurableTurn) {
        console.warn('[dc] stop found no handle but the session is still busy');
        // Leave _stopping set and the ladder armed: at STOPPING_STUCK_MS it
        // offers Force, which takes the handle-less force-orphan path.
        return;
      }
    }

    // The server declined. Both reasons mean "no stop is coming", so the
    // stopping row must not be left spinning forever.
    DevChat._clearStoppingState();
    if (body.reason === 'wrap-up cannot be stopped') {
      // The turn crossed into phase-2 between the render and the click. The
      // work is already committed; only the summary is still being written.
      DevChat.messages.push({
        role: 'system',
        content: 'Almost done. The wrap-up can’t be interrupted.',
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      });
      DevChat._setStreamingUI(true, 'mayor2');
      DevChat.renderMessages();
      DevChat.scrollToBottom();
      return;
    }
    // 'no active turn' (or anything unexpected): the turn already ended and
    // no `stopped`/`done` will ever arrive for it. Tear the streaming UI
    // down ourselves, then reload from the DB so anything that rode the
    // dead stream still shows. _finishStreaming FIRST is required, not just
    // tidy: _reconcileAfterFallbackDone bails while isStreaming is true
    // (it reads that as "a newer turn owns the timeline"). Same order as
    // the resumable channel's 'done' handler.
    DevChat._finishStreaming();
    DevChat._reconcileAfterFallbackDone(sessionId);
  },

  // Shared failure tail for _stopCurrentTurn: swap the stopping row for an
  // explicit failure line and hand the live Stop button back so the user can
  // retry. The turn itself is untouched — it's still running.
  _stopRequestFailed() {
    DevChat._clearStoppingState();
    DevChat.messages.push({
      role: 'system',
      content: 'Couldn’t stop the agent. Please try again.',
      created_at: new Date().toISOString(),
      _slug: Math.random().toString(36).slice(2, 8),
    });
    DevChat._setStreamingUI(true, DevChat._streamingPhase, { stoppable: DevChat._streamingStoppable });
    DevChat.renderMessages();
    DevChat.scrollToBottom();
  },

  // ── Trailing activity indicator (#990) ───────────────────────
  //
  // The bouncing-dots "thinking" indicator used to be appended imperatively
  // once per turn and torn down by the first `status` event, with nothing
  // ever restoring it — so the whole window between "Fetching github.com…"
  // and the reply arriving had no live cue at all, and the answer read as
  // popping in from nowhere. It is now a piece of STATE
  // (`DevChat._activity`) that renderMessages() emits itself: the old
  // append could not survive a re-render anyway, because renderMessages
  // assigns container.innerHTML wholesale.
  //
  // `null` = hidden. `{ label }` = visible, with an optional muted caption.
  _activity: null,

  _escActivity(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // The indicator's markup, or '' when it must not be shown. Called from
  // renderMessages (as part of the single innerHTML write) and from
  // _syncActivityNode (for the imperative show/hide path) so both produce
  // byte-identical DOM.

  // #990: a fresh assistant bubble opening means the step the ladder still
  // shows as live ("Thinking about what came back…") has in fact finished —
  // freeze it with its real duration so exactly one row reads as live, the
  // same invariant _enterStoppingState maintains. Guarded on _isLiveCcRun
  // because _deactivateLastStatus ALSO clears _estimate / _countdownTo, and
  // a coding agent that is still running needs its progress guess.
  _deactivateStatusForFreshBubble() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (!m || m.role !== 'system') continue;
      if (!m._active) continue;
      if (DevChat._isLiveCcRun(m)) return;
      break;
    }
    DevChat._deactivateLastStatus();
  },

  _showActivity(label) {
    DevChat._activity = { label: label == null ? null : String(label) };
    DevChat._syncActivityNode();
  },

  _hideActivity() {
    // Self-guarded: `token` calls this on every token, and the DOM probe in
    // _syncActivityNode is not worth repeating once the dots are already down.
    if (DevChat._activity === null) return;
    DevChat._activity = null;
    DevChat._syncActivityNode();
  },

  // Bring the DOM in line with the flag without a full re-render. Idempotent
  // in both directions, so callers may show/hide freely and may (or may not)
  // follow up with renderMessages().
  _syncActivityNode() {
    // It appended `#dc-spinner` to `#dc-messages` (or removed it) so a
    // show/hide need not re-render the list. The dots are a field of the
    // transcript model now, so both directions are one publish.
    DevChat._publishTranscript();
  },

  // Retained as the single legacy entry point: every existing call site
  // (the pre-POST show, and the `token` / `status` / `staging_*` / `stopped`
  // / `error` teardowns) now drives the one piece of state above, so there
  // is exactly one source of truth for whether the dots are up.
  _showSpinner() {
    DevChat._showActivity();
  },

  _removeSpinner() {
    DevChat._hideActivity();
  },

  // Read the same authorized status snapshot used for reconnects. No credit
  // writes or per-token network requests; one bounded request every 3s.
  _liveSpend: null,
  _spendPollTimer: null,
  _spendPollSession: null,
  _spendPollGeneration: 0,

  _applyLiveSpend(payload, sessionId) {
    if (Number(DevChat.currentSession?.id) !== Number(sessionId)) return;
    // #2118: an OpenRouter turn's cost is known only once Codex reports its
    // usage, at the end of the coding run, after which the session reads
    // idle while the reply is still being written. A "not busy" snapshot
    // therefore has nothing newer to say and keeps the figure; the next
    // turn's start (_startSpendPolling) or leaving the session drops it.
    if (!payload?.busy && DevChat._isOpenRouterSession()) return;
    const spend = payload?.busy ? payload.spend : null;
    DevChat._liveSpend = spend && Number.isFinite(spend.costCents) && spend.costCents > 0
      ? { sessionId, costCents: spend.costCents, estimated: spend.estimated !== false } : null;
    DevChat.renderBudget();
  },

  _startSpendPolling() {
    const sessionId = DevChat.currentSession?.id;
    if (!sessionId) return;
    if (DevChat._spendPollTimer && DevChat._spendPollSession === sessionId) return;
    DevChat._stopSpendPolling();
    DevChat._spendPollSession = sessionId;
    const generation = DevChat._spendPollGeneration;
    let pending = false;
    const poll = async () => {
      // The reconnect poll already fetches the exact same snapshot.
      if (pending || DevChat._progressPollTimer) return;
      pending = true;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const payload = await res.json();
        if (generation !== DevChat._spendPollGeneration) return;
        DevChat._applyLiveSpend(payload, sessionId);
      } catch { /* preserve the last observation through transient failures */ }
      finally { pending = false; }
    };
    DevChat._spendPollTimer = setInterval(poll, 3000);
  },

  // `keepSpend` leaves the last figure on screen once polling stops — an
  // OpenRouter session's settled "this turn" (#2118). Every other caller
  // drops it: a new turn starts clean, and a session switch or reset must
  // not carry one session's figure into another.
  _stopSpendPolling({ keepSpend = false } = {}) {
    if (DevChat._spendPollTimer) clearInterval(DevChat._spendPollTimer);
    DevChat._spendPollTimer = null;
    DevChat._spendPollSession = null;
    DevChat._spendPollGeneration += 1;
    if (keepSpend) return;
    const hadSpend = !!DevChat._liveSpend;
    DevChat._liveSpend = null;
    if (hadSpend) DevChat.renderBudget();
  },

  // #2118: an OpenRouter turn's cost arrives on its usage event — the
  // ledger's list-price estimate, sent once the reply is on screen —
  // rather than through the Claude live tracker, so the event feeds the
  // same "this turn" figure the /status poll does. A Claude session's
  // usage events are the platform/BYOK settlement split and stay out.
  _noteTurnUsage(data) {
    if (!DevChat._isOpenRouterSession()) return;
    const costCents = Number(data?.costCents);
    if (!Number.isFinite(costCents) || costCents <= 0) return;
    DevChat._applyLiveSpend(
      { busy: true, spend: { costCents, estimated: data.estimated !== false } },
      DevChat.currentSession?.id,
    );
  },

  _progressPollTimer: null,

  _startProgressPolling(sessionId, initialProgress, initialMetadata = null) {
    DevChat._stopProgressPolling();

    // Show initial progress if any. Use replace (not append per-line) because
    // the persisted message loaded by openSession already contains these
    // lines — appending would double them up.
    if (initialProgress?.length) {
      DevChat._replaceProgressLog(initialProgress, initialMetadata);
    }

    DevChat._progressPollTimer = setInterval(async () => {
      const spendGeneration = DevChat._spendPollGeneration;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const payload = await res.json();
        if (Number(DevChat.currentSession?.id) !== Number(sessionId) || !DevChat.isStreaming
            || spendGeneration !== DevChat._spendPollGeneration) return;
        DevChat._applyLiveSpend(payload, sessionId);
        const { busy, progress, estimate, stopping, stoppable } = payload;
        // #907: a machine can attach or detach mid-turn; keep the chip honest.
        DevChat._applyRunnerState(payload);

        if (progress?.length) {
          DevChat._replaceProgressLog(progress, payload);
        }

        // #1378: /status is the ONLY channel that carries `stoppable`, and
        // for a turn adopted across a restart it can flip mid-turn (the
        // recovery path registers a handle a beat after the turn is adopted).
        // Repaint on change so the button converges within one 3s tick.
        if (busy && DevChat.isStreaming && stoppable !== undefined
            && DevChat._streamingStoppable !== (stoppable !== false)) {
          DevChat._setStreamingUI(true, DevChat._streamingPhase, { stoppable });
        }

        // #889: missed-event safety net. If the `stopping` broadcast never
        // reached this tab (WS down, SSE dropped), the 3s poll still flips
        // the button within one tick.
        if (busy && stopping && !DevChat._stopping) {
          DevChat._enterStoppingState();
        }

        // Experimental AI progress estimate: the /status fallback carries
        // the latest in-memory guess so an SSE/WS drop doesn't lose it.
        // `estimate` is now { text, remainingSeconds, estimatedAt };
        // tolerate a legacy bare-string shape from an older server.
        //
        // #891: a NULL estimate is forwarded too, not skipped — the server
        // drops its in-memory guess the moment the coding run hits its
        // terminal marker, and that null is how the poll learns to blank
        // the span instead of re-painting a stale "nearly done" for the
        // rest of the turn.
        if (typeof estimate === 'string') {
          DevChat._applyEstimate(estimate);
        } else {
          DevChat._applyEstimate(
            estimate ? estimate.text : null,
            estimate ? estimate.remainingSeconds : null,
            {
              estimatedAt: estimate ? estimate.estimatedAt : null,
              displayedRemainingSeconds: estimate ? estimate.displayedRemainingSeconds : null,
              slipReason: estimate ? estimate.slipReason : null,
            }
          );
        }

        if (!busy) {
          DevChat._stopProgressPolling();
          DevChat.isStreaming = false;
          DevChat._setStreamingUI(false);
          // Reload messages to get final state
          await DevChat.openSession(sessionId);
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
      } catch {}
    }, 3000);
  },

  _stopProgressPolling() {
    if (DevChat._progressPollTimer) {
      clearInterval(DevChat._progressPollTimer);
      DevChat._progressPollTimer = null;
    }
  },

  // Live progress updates. We keep a single progress message per run, stored
  // in DevChat.messages with `_progress: true`, whose progressLog array drives
  // the "Claude Code output (N lines)" collapsible in renderMessages(). We
  // used to also inject a DOM-only "Claude Code live output" <details> via
  // _appendProgressLine, but that caused TWO collapsibles for the same turn
  // whenever SSE dropped and we fell back to polling (or the user refreshed
  // mid-run), because by then the persisted log had already been rendered
  // from the server.
  // Returns the message we should append live progress lines to. Only
  // matches messages flagged `_progress: true` so that prior turns'
  // persisted "Claude Code output (N lines)" collapsibles don't get
  // accidentally re-used as the target for a new run.
  _currentProgressMsg() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (m.role === 'system' && m._progress) return m;
    }
    return null;
  },

  _appendProgressLine(text, metadata = null) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    DevChat._copyActivityAgentMetadata(msg, metadata);
    msg.progressLog.push(text);
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  _replaceProgressLog(lines, metadata = null) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    DevChat._copyActivityAgentMetadata(msg, metadata);
    msg.progressLog = lines.slice();
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  // Targeted DOM update so we don't rebuild the whole message list on every
  // streamed line (which would flicker and reset scroll). Falls back to a
  // full renderMessages() if the collapsible hasn't been rendered yet.
  // A progress line just arrived. This found the `<pre>` by persist-id and
  // wrote `textContent` into it, then patched three sibling spans — because a
  // full `renderMessages` used to mean rebuilding `#dc-messages`' innerHTML
  // mid-run, re-parsing every message in it.
  //
  // That cost is gone: a republish is a reconcile, and React touches the one
  // `<pre>` whose text changed. So both patches are one publish, and the four
  // summary spans re-derive from `summarizeCcProgress` in the model exactly
  // as they did in `_patchProgressSummary`.
  //
  // The auto-scroll the old code did on the `<pre>` goes with it: the
  // container's own MutationObserver (`initScrollTracking`) already follows
  // the transcript to the bottom while the reader is locked there.
  _patchProgressDom(msg) {
    DevChat._publishTranscript();
  },

  // Experimental AI progress estimate (opt-in, server-gated). Stores the
  // latest Haiku guess on the active status message (so full re-renders
  // keep it) and patches the running summary's estimate span in place.
  // The server only emits cc_estimate when the user's toggle is ON, so
  // with the toggle off this never runs and the line is pixel-identical
  // to before.
  // #359: turn the latest remaining-seconds guess into an absolute target
  // end-timestamp the shared 1s ticker can count down from. Returns null
  // when the model declined a number (remainingSeconds == null/invalid) so
  // the phrase renders alone, exactly as before #50's "phrase only" path.
  //
  // #891: anchored on the server's `estimatedAt` (when the guess was
  // actually made) rather than "now". The same guess is delivered twice —
  // once over SSE/WS and again on every 3s /status poll — and anchoring on
  // arrival re-based the target each time, so the count-down sat frozen at
  // a constant "~X left" and never ran down at all. `estimatedAt` falls
  // back to now for callers that have no stamp (legacy servers, the
  // persisted-metadata hydrate path).
  //
  // #892: prefers the server's POST-GUARD `displayedRemainingSeconds` when
  // present (monotonic, floored at 30s so it can never render as zero) and
  // falls back to the raw model value for a legacy server that doesn't send
  // one. formatCountdown floors again on the client, so even a stale target
  // renders a time rather than the retired at-zero freeze.
  _countdownTarget(remainingSeconds, estimatedAt) {
    if (remainingSeconds == null) return null;
    const n = Number(remainingSeconds);
    if (!Number.isFinite(n) || n < 0) return null;
    const at = Number(estimatedAt);
    const base = Number.isFinite(at) && at > 0 ? at : Date.now();
    return base + n * 1000;
  },

  // Wipe every trace of an AI guess from the timeline (#891). Called on an
  // explicit cleared cc_estimate, when /status stops carrying one (the coding
  // run reached its terminal marker), and when no live coding run exists to
  // own the guess.
  //
  // It used to walk `#dc-messages` for `.dc-cc-estimate` and blank each span's
  // innerHTML, because the wrap-up can run for minutes without a re-render and
  // waiting for one would leave a dead guess on screen. That is the same
  // trade `_patchProgressDom` was making, and it has the same answer: a
  // republish is a reconcile, so clearing the flags and publishing touches the
  // one span whose text changed.
  _clearEstimate() {
    DevChat._pendingEstimate = null;
    DevChat._lastEstimateAt = null;
    for (let i = 0; i < DevChat.messages.length; i++) {
      const m = DevChat.messages[i];
      delete m._estimate;
      delete m._estimateRemaining;
      delete m._countdownTo;
    }
    DevChat._publishTranscript();
  },

  // Is this message the row of a coding run that is CURRENTLY running?
  // The estimate span only exists on a CC run row (renderMessages pairs a
  // status line with its attached progress log), so this is the only kind
  // of row a guess may ever attach to (#891). A plain wrap-up status
  // ("Building staging preview…", "PR #12 created") is not one.
  _isLiveCcRun(m) {
    if (!m || m.role !== 'system' || !m._active) return false;
    if (m.progressLog) return true;
    return /^(Claude Code is (running|making changes)|(?:Codex|OpenRouter) is running|Scout reading the codebase|Syncing with main)/i
      .test(String(m.content || ''));
  },

  _applyEstimate(text, remainingSeconds, opts) {
    const o = opts || {};
    const clean = (text || '').toString().trim();
    // Explicit clear: the server tore the estimator down (terminal marker,
    // turn end, stop), or the /status poll no longer carries a guess.
    if (!clean || o.cleared) { DevChat._clearEstimate(); return; }
    const remaining = remainingSeconds == null ? null : remainingSeconds;
    const at = Number(o.estimatedAt);
    const estimatedAt = Number.isFinite(at) && at > 0 ? at : null;
    // Ignore a re-delivery of a guess we've already applied — the SAME
    // estimate arrives over SSE/WS and again on every 3s /status poll, and
    // re-applying it used to re-anchor the count-down so it never moved.
    if (estimatedAt != null && DevChat._lastEstimateAt != null
        && estimatedAt <= DevChat._lastEstimateAt) {
      return;
    }
    let target = null;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat._isLiveCcRun(DevChat.messages[i])) { target = DevChat.messages[i]; break; }
    }
    if (!target) {
      // Is a status row active at all? If one is but it isn't a coding run,
      // the run is over (we're in the PR / staging / wrap-up tail) and the
      // guess must be dropped, NOT stashed — stashing is what let a stale
      // "nearly done, just wrapping up" reappear later, even on the next
      // turn. Only stash when nothing is active yet: the estimate legitimately
      // beat the first status render, or we just reconnected (#323).
      const anyActive = DevChat.messages.some((m) => m.role === 'system' && m._active);
      if (anyActive) { DevChat._clearEstimate(); return; }
      DevChat._pendingEstimate = { text: clean, remainingSeconds: remaining, estimatedAt };
      return;
    }
    DevChat._pendingEstimate = null;
    DevChat._lastEstimateAt = estimatedAt;
    target._estimate = clean;
    target._estimateRemaining = remaining;
    // #359/#891: anchor the count-down on when the guess was MADE, so the
    // shared 1s ticker walks it down instead of restarting on every
    // re-delivery.
    let nextTarget = DevChat._countdownTarget(
      o.displayedRemainingSeconds != null ? o.displayedRemainingSeconds : remaining,
      estimatedAt
    );
    // #892 belt-and-braces mirror of the server-side monotonicity guard: a
    // target LATER than the one currently rendered is ignored unless the
    // server said why it moved (slipReason). Without this a reordered
    // SSE/poll delivery could visibly push the finish out — the exact
    // treadmill the guard exists to stop. Moving earlier is always accepted.
    if (nextTarget != null && target._countdownTo != null
        && nextTarget > target._countdownTo && !o.slipReason) {
      nextTarget = target._countdownTo;
    }
    target._countdownTo = nextTarget;
    // The guess belongs to THIS run's row and no other. It used to be written
    // into that row's `.dc-cc-estimate` by persist-id — deliberately not "the
    // last estimate span on the page" (#323/#891), because that fallback is
    // what painted a guess onto an already-finished Claude Code card. The
    // model carries it on the row it belongs to now, which makes the same
    // guarantee structural: a publish can only paint the run whose message
    // object holds `_estimate`.
    DevChat._publishTranscript();
  },

  // ── #50: elapsed-time ticker ────────────────────────────────
  //
  // Active status lines render a `[data-elapsed-since]` span; one shared
  // 1s interval recomputes each from its start timestamp (drift-proof
  // under background-tab throttling — browsers may fire the interval
  // late, but the displayed value is always now - startedAt) and patches
  // textContent only, never re-rendering the message list.
  _elapsedTimer: null,

  // Experimental AI progress estimate state (#323/#891).
  //   _pendingEstimate — a guess that arrived before its coding-run row
  //     existed, drained by the next renderMessages.
  //   _lastEstimateAt  — server `estimatedAt` of the guess currently shown,
  //     so the same guess re-delivered by the 3s /status poll is ignored
  //     instead of re-anchoring (and freezing) the count-down.
  _pendingEstimate: null,
  _lastEstimateAt: null,

  _syncElapsedTicker() {
    // #359: the same 1s heartbeat now also drives the AI-estimate
    // count-down span, so the predicate matches either kind of ticking span.
    const any = document.querySelector('#dc-messages [data-elapsed-since], #dc-messages [data-countdown-to], #dc-messages [data-cohort-since]');
    if (any && !DevChat._elapsedTimer) {
      DevChat._elapsedTimer = setInterval(() => DevChat._tickElapsed(), 1000);
    } else if (!any && DevChat._elapsedTimer) {
      clearInterval(DevChat._elapsedTimer);
      DevChat._elapsedTimer = null;
    }
    // Fill immediately so the spans aren't blank until the first tick.
    if (any) DevChat._tickElapsed();
  },

  // The 1s heartbeat. It used to walk `#dc-messages` three times — for
  // `[data-elapsed-since]`, `[data-countdown-to]` and `[data-cohort-since]` —
  // and write `textContent` into each match. All three spans are the
  // transcript component's now and re-derive their own text, so what is left
  // is publishing the clock they derive from. Three writers, one store.
  //
  // The DOM query stays, for the one thing it was ALSO deciding: whether
  // anything on screen still ticks, and therefore whether the timer should
  // keep running. The component renders the same `data-*` anchors precisely
  // so this answer does not need a second source.
  _tickElapsed() {
    const any = document.querySelector(
      '#dc-messages [data-elapsed-since], #dc-messages [data-countdown-to], #dc-messages [data-cohort-since]'
    );
    if (!any) {
      if (DevChat._elapsedTimer) {
        clearInterval(DevChat._elapsedTimer);
        DevChat._elapsedTimer = null;
      }
      return;
    }
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (react && react.publishNow) react.publishNow(Date.now());
  },

  // Re-apply the arc spinner to a trailing `stagingBuild: 'running'` row
  // after a history load. Only when it IS trailing: a rebuild that has
  // since finished (or failed) has a row after it, and re-spinning a
  // superseded row would claim work that is over.
  //
  // Separate from the /status-driven `_active` pass because the two answer
  // different questions — that one asks "is a TURN running?", this one asks
  // "is a background rebuild still going?", and a heal-sweep rebuild has no
  // turn at all.
  _activateTrailingStagingBuild() {
    const msgs = DevChat.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user' || m.role === 'assistant') return;
      if (m.role !== 'system') continue;
      // A terminal artefact below the build row means it's done.
      if (m.ccOutput || m.stagingUrl || m.changesReady || m.stagingFailed) return;
      if (m.stagingBuild === 'running') { m._active = true; return; }
    }
  },

  // Reconstruct a missing Changes ready card from durable chat_sessions
  // state. `staging_url` is sufficient for every session type. A CLI handoff
  // can also finish with no preview (for example, a staging/check failure),
  // so its submitted head plus a terminal verdict is authoritative evidence
  // that reviewable work exists and should still get the card.
  //
  // Return a new array rather than mutating the API response. The synthetic
  // row deliberately has no DB id and is never uploaded as conversation
  // history; it is a view of the session row, exactly like the lifecycle
  // badge rendered inside the card.
  _hydrateChangesReadyFromSession(session, messages) {
    if (!session || !Array.isArray(messages)) return messages || [];
    if (messages.some((m) => m && (m.stagingUrl || m.changesReady))) return messages;
    // Archived sessions are deliberately non-reviewable. A staging URL can
    // survive only when teardown failed; turning that leak-recovery state into
    // a fresh interactive card would incorrectly advertise a usable preview.
    if (session.status === 'archived') return messages;

    const checkState = String(session.check_state || '').toLowerCase();
    const terminalCheck = ['passing', 'skipped', 'failing', 'error'].includes(checkState);
    // #907: a turn run on the user's own machine reaches the same place — a
    // head the platform accepted, a terminal verdict, and possibly no preview
    // if staging failed. It is a native session, so `source` stays
    // 'anthropic'; `last_turn_runner` is what distinguishes it.
    const submittedCliHead = (session.source === 'cli_handoff' || session.last_turn_runner === 'local')
      && !!(session.handoff_head_sha || session.checks_commit_sha);
    if (!session.staging_url && !(submittedCliHead && terminalCheck)) return messages;

    const checksNeedAttention = checkState === 'failing' || checkState === 'error';
    const content = session.staging_url
      ? 'Staging deployed!'
      : (checksNeedAttention ? 'Changes ready. Checks need attention.' : 'Changes ready.');
    return [...messages, {
      role: 'system',
      content,
      stagingUrl: session.staging_url || null,
      changesReady: true,
      prNumber: session.pr_number ?? null,
      prUrl: session.pr_url || null,
      created_at: session.checks_checked_at || session.last_activity_at
        || session.updated_at || session.created_at || null,
      _slug: `session-state-${session.id}`,
      _derivedFromSession: true,
    }];
  },

  _deactivateLastStatus() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i]._active) {
        const m = DevChat.messages[i];
        m._active = false;
        // #50: freeze the elapsed display at the step's total so later
        // renders in this live session show "(took Xm Ys)" instead of a
        // ticker. Client-only; reload persistence for terminal lines
        // comes from the server's durationMs metadata.
        if (m._elapsedFinalMs == null && m.created_at) {
          const started = new Date(m.created_at).getTime();
          if (Number.isFinite(started)) {
            m._elapsedFinalMs = Math.max(0, Date.now() - started);
          }
        }
        // Experimental AI estimate: a finished/stopped step never shows a
        // guess — the real duration replaces it. Clear the count-down anchor
        // too (#359) so a stale target can't be re-rendered, and the
        // remaining-seconds + pending stash (#891) so nothing can drain a
        // dead guess back onto a later row (even one in the NEXT turn).
        delete m._estimate;
        delete m._estimateRemaining;
        delete m._countdownTo;
        DevChat._pendingEstimate = null;
        DevChat._lastEstimateAt = null;
        break;
      }
    }
  },

  

  // #127: open the staging preview with the session's testing guidance
  // attached. `jump` opens the iframe directly at the deep-link path (the
  // "Test this change" button); plain Preview starts at the app root but
  // still carries the guidance so the overlay can offer its own "Test this
  // change" button + "How to test" panel. The markdown is looked up here at
  // click time so it never transits an HTML attribute.
  previewStaging(url, jump) {
    const s = DevChat.currentSession || {};
    const testing = (s.testing_md || s.testing_path)
      ? { md: s.testing_md || null, path: s.testing_path || null }
      : null;
    // #771: on wide viewports the preview docks beside the chat like the
    // spec viewer (a Full screen button in its header expands it). Narrow
    // viewports keep today's fullscreen overlay — a side panel doesn't
    // fit there. Mount the slot BEFORE ensureStaging so the docked
    // geometry has something to pin to.
    const dock = !!(s.id && !document.querySelector?.('.dev-change-workspace[hidden]')
      && typeof AppView !== 'undefined'
      && AppView._stagingDockViewport && AppView._stagingDockViewport());
    if (dock) DevChat.openStagingPanel();
    // #439: route through ensure-then-open so a preview torn down while the
    // user was away (idle GC, lost container) rebuilds on click. Prefer the
    // session's live staging_url over the (possibly stale) message URL as
    // the fallback for the already-live case. With no session id we can't
    // ensure — fall back to the legacy direct open.
    if (s.id) {
      AppView.ensureStaging(s.id, s.staging_url || url, testing, { jump: !!jump, dock });
    } else {
      AppView.swapToStaging(url, testing, { jump: !!jump, dock: false });
    }
  },

  // Both surfaces submit through the card's controller and per-session lock.
  async promotePR() {
    const session = DevChat.currentSession;
    if (!session || AppView.changeSubmissionState(session).kind !== 'ready') return;
    return AppView.runChangeAction(session.id, 'promote', session);
  },

  // Append a live agent-suggested platform-report card to the timeline.
  // Called from every live channel (POST SSE, resumable SSE, WS), so
  // dedupe by the draft's DB msgId — the channels overlap by design.
  _pushPlatformIssueDraft(data) {
    const draft = data && data.platformIssueDraft;
    if (!draft || !draft.msgId) return;
    if (DevChat.messages.some(
      (m) => m.platformIssueDraft && m.platformIssueDraft.msgId === draft.msgId
    )) return;
    DevChat.messages.push({
      role: 'system',
      content: data.text || 'The AI suggests reporting this to the platform',
      platformIssueDraft: draft,
      created_at: new Date().toISOString(),
      _slug: Math.random().toString(36).slice(2, 8),
    });
    DevChat.renderMessages();
    DevChat.scrollToBottom();
  },

  // Human gate for agent-drafted platform issue reports: confirm files
  // the GitHub issue (server-side, bot PAT), dismiss kills the draft.
  // Either way the card's state flips in place — no refetch needed.
  async resolvePlatformIssueDraft(msgId, action, btn) {
    if (!DevChat.currentSession?.id || !msgId) return;
    // Disable both buttons on the card so a double-tap can't double-file
    // (the server also claims the draft atomically, this is just UX).
    const card = btn?.closest ? btn.closest('.dc-pr-card') : null;
    if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(
        `/api/sessions/${DevChat.currentSession.id}/platform-issue/${msgId}/${action}`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        PlatformUI.toast(data.error || 'Failed. Try again');
        if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        return;
      }
      // 409 means another member resolved it first — fold in whatever
      // final state the server reports, same as a success.
      const msg = DevChat.messages.find(
        (m) => m.platformIssueDraft && m.platformIssueDraft.msgId === msgId
      );
      if (msg) {
        msg.platformIssueDraft.status = data.status
          || (action === 'dismiss' ? 'dismissed' : 'filed');
        if (data.url) msg.platformIssueDraft.issueUrl = data.url;
        if (data.number) msg.platformIssueDraft.issueNumber = data.number;
        DevChat.renderMessages();
      }
    } catch {
      PlatformUI.toast('Network error');
      if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  },

  // ── Rendering ─────────────────────────────────────────────

  // Message rows carry fractional CENTS from both sources, but under two
  // field names: live usage events write camel-case `costCents`, while the
  // session-history query returns PostgreSQL's snake-case `cost_cents` as a
  // numeric string. Normalize at the rendering seam so a refresh neither
  // drops the label nor changes its units. The lower-right meter is today's
  // cumulative spend; this label deliberately says "reply" because it covers
  // only this assistant row.
  _messageCostLabel(msg) {
    const raw = msg?.costCents ?? msg?.cost_cents;
    if (raw === null || raw === undefined || raw === '') return '';
    const cents = Number(raw);
    if (!Number.isFinite(cents) || cents <= 0) return '';
    // #2118: an OpenRouter reply's figure is the ledger's list-price
    // estimate, never a provider-reported amount, and the label says so.
    // A live row carries the flag from its usage event, a reloaded row
    // from the persisted metadata.
    const approx = (msg.costEstimated || msg.metadata?.costEstimated) ? '~' : '';
    return ` · reply ${approx}$${(cents / 100).toFixed(3)}`;
  },

  // ── The transcript, as a MODEL ────────────────────────────────────
  //
  // `renderMessages` built one `innerHTML` string for `#dc-messages` and then
  // five other things wrote into what it had just painted: the streaming
  // bubble at 60fps, a 1s ticker over three kinds of span, the AI-estimate
  // spans, the `<details>` open-state restore, and two delegated-listener
  // scans. Each is gone or scoped — see features/dev-chat/transcript-store.ts.
  //
  // What did NOT move: every rule about WHICH row is which, and every string
  // another module owns (`renderMarkdown`, `AppView.visualsTilesHtml`,
  // `CreditOptions.cardHtml`, `DevFlowSelect`). This carries their answers.
  _rowKey(msg, msgIdx) {
    return String(msg.id || msg._slug || `i${msgIdx}`);
  },

  /** The stamp every row carries: "<id> <epoch ms>". */
  _rowStamp(msg) {
    const ts = msg.created_at ? new Date(msg.created_at).getTime() : '';
    return `${msg.id || msg._slug || ''} ${ts}`;
  },

  _detailsSpec(msg, kind, defaultOpen) {
    return { persistId: DevChat._detailsId(msg, kind), defaultOpen: !!defaultOpen };
  },

  /**
   * The elapsed/duration suffix for a status row, in its three shapes:
   *   - a server-persisted `durationMs` wins even while the row is still
   *     `_active` ("Claude Code finished" arriving mid-turn describes a
   *     COMPLETED step, so a fresh ticker would be misleading);
   *   - an `_active` row hands over its start epoch and the row re-derives
   *     its own label from `nowStore` on the 1s heartbeat;
   *   - a finished row shows the client-side freeze `_deactivateLastStatus`
   *     stamped (live sessions only — a reload has the server's duration).
   */
  _elapsedSpec(msg) {
    const fmtEl = typeof formatElapsed === 'function' ? formatElapsed : null;
    if (msg.durationMs != null && fmtEl) {
      return { kind: 'fixed', label: `(took ${fmtEl(Math.max(0, msg.durationMs))})` };
    }
    if (msg._active && msg.created_at) {
      const since = new Date(msg.created_at).getTime();
      if (!Number.isFinite(since)) return null;
      return { kind: 'since', since: Math.min(since, Date.now()) };
    }
    if (msg._elapsedFinalMs != null && fmtEl) {
      return { kind: 'fixed', label: `(took ${fmtEl(Math.max(0, msg._elapsedFinalMs))})` };
    }
    return null;
  },

  /**
   * A status row. `html` rather than `text` where the old template
   * interpolated `msg.content` UNESCAPED — those rows carry platform-authored
   * copy with markup in it, and escaping them now would be a visible change.
   */
  _statusRow(msg, msgIdx, over) {
    return {
      t: 'status',
      key: DevChat._rowKey(msg, msgIdx),
      icon: msg._active ? 'spinner' : 'check',
      text: msg.content || '',
      html: msg.content || '',
      elapsed: DevChat._elapsedSpec(msg),
      stamp: DevChat._rowStamp(msg),
      ...over,
    };
  },

  // The attachment strip inside a user bubble. It is a SIBLING of the
  // rendered markdown, never part of it: the DOMPurify allowlist strips
  // `<img>` and must keep doing so for untrusted markdown, so an image
  // attachment can only reach the page from outside that pass. Optimistic
  // sends carry `objectUrl` until the reload swaps in the server URL.
  _attachmentRows(msg) {
    const atts = msg.attachments;
    if (!Array.isArray(atts) || !atts.length) return undefined;
    const sid = DevChat.currentSession?.id;
    const out = [];
    for (const a of atts) {
      const idOk = typeof a.id === 'string' && /^[a-f0-9]{32}$/.test(a.id);
      const url = a.objectUrl || (idOk && sid ? `/api/sessions/${sid}/attachments/${a.id}` : null);
      if (!url) continue;
      const name = String(a.filename || 'file');
      if (a.kind === 'image') out.push({ kind: 'image', href: url, name });
      else {
        out.push({
          kind: 'file', href: url, name, download: true,
          badgeHtml: DevChat._attachKindBadgeHtml(a),
          size: DevChat._humanSize(a.sizeBytes),
        });
      }
    }
    return out.length ? out : undefined;
  },

  // ── When the missing value is a NUMBER ─────────────────────
  //
  // A group whose answers are all bare numbers is a question about a
  // quantity, and a row of chips is the wrong form for one: the model has to
  // guess which five values you might want, and the one you actually want is
  // the sixth. It becomes a stepper instead — the same question, asked as
  // the thing it is.
  //
  // The test is deliberately strict: EVERY answer must be a bare number,
  // optionally with a unit, and every unit present must be the same one.
  // "0.2 m — ankle deep" is not a bare number, and it should not be — the
  // prose is the point of that answer, and #1 in the design deck keeps those
  // as chips. A group is numeric only when the model offered nothing but
  // magnitudes.
  //
  // The STEP is the smallest gap between the values offered. That is the
  // model's own sense of what a meaningful increment is here, which is a
  // better answer than any constant this file could pick: 5-minute rounding
  // steps by 5, a depth in tenths of a metre steps by a tenth.
  _qaNumericGroup(answers) {
    if (!Array.isArray(answers) || answers.length < 2) return null;
    const parsed = [];
    for (const a of answers) {
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*([^\s\d]{0,8})\s*$/.exec(String(a || ''));
      if (!m) return null;
      parsed.push({ value: parseFloat(m[1]), unit: (m[2] || '').trim() });
    }
    const units = [...new Set(parsed.map((p) => p.unit).filter(Boolean))];
    if (units.length > 1) return null;
    const values = parsed.map((p) => p.value);
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    let step = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > 0 && (step === 0 || gap < step)) step = gap;
    }
    if (!(step > 0)) return null;
    // Decimal places of the step, so stepping never produces 0.30000000000004.
    const dp = (String(step).split('.')[1] || '').length;
    return {
      unit: units[0] || '',
      step,
      dp,
      suggested: values[0],
      min: Math.min(...values, 0),
    };
  },

  /** Render one numeric group's value the way its own answers were written. */
  _qaNumberText(num, value) {
    const n = value.toFixed(num.dp);
    return num.unit ? `${n} ${num.unit}` : n;
  },

  _qaSpec(msg) {
    const groups = msg.suggestions;
    const multi = groups.length > 1;
    const specs = groups.map((g, gi) => {
      const answers = g.answers || [];
      const num = DevChat._qaNumericGroup(answers);
      // The escape hatch's own wording follows the question. When the answers
      // look like magnitudes the thing you want to do is type a number, and
      // saying so is the difference between an affordance and a mystery.
      const numeric = !!num || answers.some((a) => /^\s*-?\d/.test(String(a || '')));
      return {
        label: multi && g.question ? g.question : '',
        kind: num ? 'number' : 'chips',
        number: num
          ? {
            value: DevChat._qaNumberText(
              num, DevChat._qaNumber[gi] != null ? DevChat._qaNumber[gi] : num.suggested
            ),
            suggested: DevChat._qaNumberText(num, num.suggested),
          }
          : null,
        answers: num ? [] : answers.map((a, ai) => ({
          text: a,
          suggested: ai === 0,
          selected: multi && DevChat._qaSelection[gi] === ai,
        })),
        // The last chip in the row, and the only one that does not answer:
        // it opens a one-line input scoped to THIS group rather than sending
        // the reader off to the composer to do a form's job.
        escape: num ? null : {
          label: numeric ? 'Let me type a number' : 'Something else',
          open: !!DevChat._qaTypedOpen[gi],
          value: DevChat._qaTyped[gi] || '',
        },
      };
    });
    return {
      // The shared send row appears past one question — and also whenever a
      // group answers by typing or stepping rather than by tapping, because
      // those have no send-on-tap moment of their own.
      multi: multi
        || specs.some((g) => g.kind === 'number' || (g.escape && g.escape.open)),
      groups: specs,
    };
  },

  _transcriptView() {
    const session = DevChat.currentSession;

    // Drain a pending AI progress estimate (#323): an estimate can arrive
    // before the active running line exists in DevChat.messages (estimate
    // beat the first status render, or a reconnect). Apply it now so the
    // guess survives onto the line instead of being silently dropped.
    // #891: drains onto a LIVE coding run only. A pending guess must never
    // land on a wrap-up status row ("Building staging preview…") — that row
    // renders no estimate span, and the old fallback then painted the guess
    // onto the already-finished Claude Code card above it.
    if (DevChat._pendingEstimate) {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (DevChat._isLiveCcRun(m)) {
          m._estimate = DevChat._pendingEstimate.text;
          m._estimateRemaining = DevChat._pendingEstimate.remainingSeconds;
          // #359: anchor the count-down for the drained pending estimate too,
          // from when the guess was made rather than from this render.
          m._countdownTo = DevChat._countdownTarget(
            m._estimateRemaining, DevChat._pendingEstimate.estimatedAt
          );
          DevChat._lastEstimateAt = DevChat._pendingEstimate.estimatedAt || null;
          DevChat._pendingEstimate = null;
          break;
        }
      }
    }

    // Pre-pass: pair each `progressLog` system message with the
    // nearest preceding active-CC status line ("Claude Code is
    // running" for build, legacy "Claude Code is making changes",
    // and "Scout reading the codebase" for scout) so we can render
    // the live log inline under it as a click-to-collapse <details>
    // instead of as a separate gray-boxed "Claude Code output (N
    // lines)" entry that disappears on reload. Two indices keep the
    // main render loop cheap:
    //   progressByStatus  — statusMsgRef → progressMsg (used to render)
    //   mergedProgress    — progressMsgRef → true       (skip standalone)
    const progressByStatus = new Map();
    const mergedProgress = new Set();
    // Matches all status lines that wrap a worker exec: build mode
    // emits "Claude Code is running" (and the older "...is making
    // changes" wording for legacy DB rows); scout emits "Scout
    // reading the codebase"; sync-with-main emits "Syncing with main".
    // Each is paired with a 'Claude Code progress' system row whose
    // live log we want to attach.
    const ACTIVE_CC_STATUS_RE
      = /^(Claude Code is (running|making changes)|(?:Codex|OpenRouter) is running|Scout reading the codebase|Syncing with main)/i;
    // Helper: is this a viable status candidate for pairing? Stop on
    // any non-system row (status/progress pairs always live inside a
    // single dispatch turn) and skip rows that already carry their
    // own attached artefact (ccOutput / progressLog / stagingUrl /
    // ccLog / specPreview) so we don't accidentally re-use a row
    // belonging to a previous CC run.
    const isPairableStatus = (s) => {
      if (s.role !== 'system') return null; // null → caller breaks
      if (s.progressLog) return false;
      if (s.ccLog || s.ccOutput || s.stagingUrl || s.specPreview) return false;
      return ACTIVE_CC_STATUS_RE.test(String(s.content || ''));
    };
    for (let i = 0; i < DevChat.messages.length; i++) {
      const m = DevChat.messages[i];
      if (m.role !== 'system' || !m.progressLog) continue;

      // Walk backward first — this is the post-reload case where
      // sendStatus's INSERT lands BEFORE the progress INSERT in the
      // DB, so the timeline order is "status → progress".
      let paired = null;
      for (let j = i - 1; j >= 0; j--) {
        const s = DevChat.messages[j];
        if (s.role !== 'system') break;
        const ok = isPairableStatus(s);
        if (ok === null) break;
        if (ok === true) { paired = s; break; }
      }

      // Walk forward if backward found nothing. This is the LIVE case:
      // the first `cc_progress` SSE event (typically from the
      // `ensureWorker` bootstrap clone/checkout phase) creates the
      // in-memory progress message BEFORE the upcoming
      // "Claude Code is running…" / "Scout reading the codebase…"
      // sendStatus event arrives, so the active-CC status sits at a
      // later index than the progress row until the next reload.
      if (!paired) {
        for (let j = i + 1; j < DevChat.messages.length; j++) {
          const s = DevChat.messages[j];
          if (s.role !== 'system') break;
          const ok = isPairableStatus(s);
          if (ok === null) break;
          if (ok === true) { paired = s; break; }
        }
      }

      if (paired) {
        progressByStatus.set(paired, m);
        mergedProgress.add(m);
      }
    }


    // Q/A mode (#32): suggested-answer chips render only under the LAST
    // non-system message — and only when the session is one the viewer
    // can still act in. Once the user replies (chip or typed), the
    // question row stops being last and the chips vanish on re-render,
    // so no explicit teardown is needed.
    let qaLastConvoIdx = -1;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i].role !== 'system') { qaLastConvoIdx = i; break; }
    }
    const qaInteractive = !!session && (session.status === 'active' || session.status === 'promoted');

    // The one row a live turn is writing into: the last assistant row while a
    // turn is in flight. Only it subscribes to `streamStore`, which is what
    // keeps a 60fps publish from re-rendering the list.
    let liveIdx = -1;
    if (DevChat.isStreaming || DevChat._streamKey) {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'system') continue;
        if (m.role === 'assistant' && !m.creditsCard) liveIdx = i;
        break;
      }
    }

    const rows = [];
    DevChat.messages.forEach((msg, msgIdx) => {
      const key = DevChat._rowKey(msg, msgIdx);
      const stamp = DevChat._rowStamp(msg);

      if (msg.role === 'system') {
        // Inline spec preview card. The Mayor's scout dispatch emits this
        // metadata alongside the status line; clicking the card opens the
        // read-only spec viewer.
        if (msg.specPreview) {
          const lineCount = msg.specLines || msg.specPreview.split('\n').length;
          // Clip to WHOLE LINES, so a partial task item is never half-included:
          // as a scout redraft shifts the text, a `- [ ]` line near the
          // boundary would otherwise pop in and out between drafts.
          const snippet = typeof clipSpecSnippet === 'function'
            ? clipSpecSnippet(msg.specPreview, 200) : msg.specPreview;
          rows.push({
            t: 'spec', key,
            status: DevChat._statusRow(msg, msgIdx, { icon: 'check', elapsed: DevChat._elapsedSpec(msg) }),
            version: msg.specVersion != null ? String(msg.specVersion) : 'latest',
            header: msg.specVersion != null
              ? `Spec v${msg.specVersion} · ${lineCount} lines`
              : `Spec drafted · ${lineCount} lines`,
            snippetHtml: DevChat.renderMarkdown(snippet, { breaks: false }),
          });
          return;
        }
        // Issue-report draft card (human gate). Nothing is filed until a user
        // taps confirm; Dismiss kills the draft.
        if (msg.platformIssueDraft) {
          const d = msg.platformIssueDraft;
          // #1037: a draft carries `target`. Rows written before that (and the
          // staging fixture's legacy ones) have none and are platform-destined.
          const isAppTarget = d.target === 'app';
          const fullBody = String(d.body || '');
          let body = { kind: 'none' };
          if (fullBody.length > 300) {
            // #699: back the clip up to the last whitespace before 300 (when
            // one exists past 200) so the collapsed cut — and the seam when
            // open — falls between words.
            let clip = 300;
            const ws = Math.max(fullBody.lastIndexOf(' ', 300), fullBody.lastIndexOf('\n', 300));
            if (ws > 200) clip = ws;
            body = {
              kind: 'details',
              details: DevChat._detailsSpec(msg, 'pireport', false),
              summary: fullBody.slice(0, clip),
              rest: fullBody.slice(clip),
            };
          } else if (fullBody) {
            body = { kind: 'plain', text: fullBody };
          }
          let action = { kind: 'none' };
          if (d.status === 'filed' && d.issueUrl) {
            action = { kind: 'link', href: d.issueUrl, label: `Reported: issue #${d.issueNumber}` };
          } else if (d.status === 'filed') {
            action = { kind: 'note', text: isAppTarget ? "Filed on this app's repo" : 'Reported to the platform' };
          } else if (d.status === 'dismissed') {
            action = { kind: 'note', text: 'Dismissed' };
          } else if (d.msgId) {
            action = { kind: 'buttons', confirmLabel: isAppTarget ? 'File issue' : 'Report to platform' };
          }
          rows.push({
            t: 'issueDraft', key,
            status: {
              t: 'status', key: `${key}:s`, icon: 'flag',
              text: msg.content || 'The AI suggests reporting this to the platform',
              elapsed: null, stamp,
            },
            msgId: d.msgId || null,
            destLabel: isAppTarget ? `Issue draft: ${d.appName || 'this app'}` : 'Suggested platform report',
            title: d.title || '',
            body, action,
          });
          return;
        }
        if (msg.ccLog) {
          rows.push({
            t: 'ccLog', key,
            details: DevChat._detailsSpec(msg, 'cclog', false),
            label: DevChat._activityAgentName(msg),
            log: msg.ccLog,
          });
          return;
        }
        if (msg.progressLog?.length) {
          // Already merged into a parent "Claude Code is running" status line
          // by the pre-pass — nothing to render here.
          if (mergedProgress.has(msg)) return;
          // Orphan progress message — old DB rows with no matching
          // predecessor status line. Rendered in the SAME attached style with
          // a synthetic status line, so the timeline stays consistent.
          rows.push({
            t: 'attached', key,
            details: DevChat._detailsSpec(msg, 'ccrunorphan', DevChat._ccDefaultOpen(msg)),
            icon: 'check',
            text: `${DevChat._activityAgentName(msg)} output`,
            elapsed: null, stamp,
            body: {
              kind: 'log',
              persistId: DevChat._detailsId(msg, 'progress'),
              text: msg.progressLog.join('\n'),
            },
          });
          return;
        }
        // #361: the "Changes ready" card renders whenever the turn produced a
        // reviewable commit — a preview built (stagingUrl) OR the
        // staging-independent marker. Staging is an ENRICHMENT of the card,
        // not its on/off switch.
        if (msg.stagingUrl || msg.changesReady) {
          // Once the PR merges the merge path tears down the staging
          // container, so the historical preview link is dead.
          const previewGone = !!session
            && (session.status === 'merged' || session.status === 'merging' || !!session.merged_at);
          const canPreview = !previewGone;
          // Prefer the session row over the (possibly stale) message URL.
          const liveUrl = (session && session.staging_url) || msg.stagingUrl || '';
          // #127: bot-emitted testing guidance lives on the session row. The
          // markdown is looked up at click time, never inlined.
          const hasTesting = !!(session?.testing_md || session?.testing_path);
          // #195: before/after tiles. Visuals are latest-set-per-session, so
          // only the NEWEST staging card carries them.
          let visualsHtml = '';
          if (window.AppView && session?.visuals) {
            let latest = null;
            for (let vi = DevChat.messages.length - 1; vi >= 0; vi--) {
              if (DevChat.messages[vi].stagingUrl || DevChat.messages[vi].changesReady) {
                latest = DevChat.messages[vi]; break;
              }
            }
            if (latest === msg && msg.stagingUrl) visualsHtml = AppView.visualsTilesHtml(session.visuals);
          }
          // #405: driven by the shared lifecycle helper so the card tracks
          // In vote → Passed → Merging… → ✓ Merged rather than freezing on
          // "Proposed!".
          let status2 = { kind: 'none' };
          if (session && session.status !== 'active' && window.MergeStatus && MergeStatus.lifecycle) {
            const life = MergeStatus.lifecycle(session);
            if (life && life.key === 'merged') status2 = { kind: 'merged' };
            else if (life && life.label) status2 = { kind: 'badge', html: MergeStatus.badgeHtml(life) };
          }
          // #1602: proposal availability is a lifecycle, not a visibility
          // boolean. A successful request used to make the action disappear,
          // which left no durable acknowledgement that this exact change had
          // already crossed into group voting. Keep the completed control on
          // every post-proposal state, disabled and handler-free; unrelated
          // terminal states still render no proposal action.
          const propose = session && ['active', 'promoted', 'merging', 'merged'].includes(session.status)
            ? AppView.changeSubmissionState(session) : null;
          rows.push({
            t: 'changes', key,
            status: { t: 'status', key: `${key}:s`, icon: 'check', html: msg.content || '', text: msg.content || '', elapsed: null, stamp },
            prUrl: session?.pr_url || msg.prUrl || null,
            prNumber: session?.pr_number || msg.prNumber || null,
            title: session?.session_title || session?.pr_title || '',
            closesHtml: window.AppView ? AppView.closesPillHtml(session) : '',
            stamp,
            visualsHtml,
            preview: { enabled: canPreview, url: liveUrl, title: '' },
            test: hasTesting ? { enabled: canPreview, url: liveUrl } : null,
            propose,
            status2,
          });
          return;
        }

        const elapsed = DevChat._elapsedSpec(msg);
        // Attached live progress log? The status line becomes the <summary> of
        // an open-by-default <details>, with the streaming log inline below.
        const attachedProgress = progressByStatus.get(msg);
        if (attachedProgress) {
          const summ = typeof summarizeCcProgress === 'function'
            ? summarizeCcProgress(attachedProgress.progressLog || [])
            : { currentLabel: '', steps: 0, phaseLabel: '' };
          const cohortSince = msg._active && msg.created_at
            ? Math.min(new Date(msg.created_at).getTime(), Date.now()) : NaN;
          rows.push({
            t: 'attached', key,
            // #647: the open default follows the STATUS row, not the attached
            // progress row — keying off `msg` keeps it aligned with the
            // persisted state's key.
            details: DevChat._detailsSpec(msg, 'ccrun', DevChat._ccDefaultOpen(msg)),
            icon: msg._active ? 'spinner' : 'check',
            html: msg.content || '', text: msg.content || '',
            elapsed, stamp,
            progress: {
              current: summ.currentLabel || '',
              steps: summ.steps || 0,
              phase: summ.phaseLabel || '',
              estimate: msg._estimate || '',
              countdownTo: msg._countdownTo != null ? msg._countdownTo : null,
              cohortSince: Number.isFinite(cohortSince) ? cohortSince : null,
            },
            body: {
              kind: 'log',
              // The inner pre keeps the legacy progress pid so a streaming
              // append can still target it.
              persistId: DevChat._detailsId(attachedProgress, 'progress'),
              text: (attachedProgress.progressLog || []).join('\n'),
            },
          });
          return;
        }
        // Post-turn ccOutput — the markdown summary the worker emits when the
        // run finishes. Same merged shape, a markdown body rather than a log.
        if (msg.ccOutput) {
          rows.push({
            t: 'attached', key,
            details: DevChat._detailsSpec(msg, 'ccout', DevChat._ccDefaultOpen(msg)),
            icon: msg._active ? 'spinner' : 'check',
            html: msg.content || '', text: msg.content || '',
            elapsed, stamp,
            body: { kind: 'md', html: DevChat.renderMarkdown(msg.ccOutput) },
          });
          return;
        }
        // A FAILED TURN, which until now fell through to the generic row
        // below and came back wearing that row's green ✓ (see the `failure`
        // row in ./transcript-store.ts).
        //
        // `turnError` only — NOT `stagingFailed`. A staging-build failure
        // carries `changesReady: true` and renders the Changes-ready card
        // with its Preview disabled, which is the honest reading: the commit
        // exists and is proposable, only the preview did not build. Routing
        // it here would take that card away and lose the Propose action with
        // it.
        if (msg.turnError) {
          rows.push({
            t: 'failure', key, tone: 'blocked',
            html: msg.content || '', text: msg.content || '', stamp,
          });
          return;
        }
        // A STOP THAT LANDED. Same card, deliberately not red: the user asked
        // for this, and the green ✓ it used to wear was the mirror-image
        // mistake — a pipeline tick over a pipeline that did not finish. The
        // landing goes in chips rather than in the sentence's trailing
        // clause, so "2 changes committed · a1b2c3d4 · pushed" is legible at
        // a glance instead of buried mid-sentence. `headline` is the same
        // sentence WITHOUT that clause; `content` is the fallback for rows
        // persisted before the server sent the data.
        if (msg.stopLanding) {
          rows.push({
            t: 'failure', key, tone: 'stopped',
            text: msg.stopLanding.headline || msg.content || '',
            chips: DevChat._stopLandingChips(msg.stopLanding),
            stamp,
          });
          return;
        }
        // #664: mid-turn payer switch onto the user's own API key. A key glyph
        // instead of the pipeline check, so it reads as an FYI.
        if (msg.billingSwitch) {
          rows.push({ t: 'status', key, icon: 'key', text: msg.content || '', elapsed: null, stamp, dim: true });
          return;
        }
        // #937: once a stop is clearly not landing, the row grows a Force stop
        // button — the user's only way out of a permanent "Stopping…". It was
        // a status row, which meant the escalation SETTLED TO A GREEN ✓ the
        // moment the turn went inactive: the one state where the user is
        // genuinely stuck, wearing the tick that means "done". It is the
        // failure card now, and it keeps the button.
        if (msg._stopping && msg._forceOffered) {
          rows.push({
            t: 'failure', key, tone: 'stopping',
            text: msg.content || '', elapsed, stamp, forceStop: true,
          });
          return;
        }
        rows.push({
          t: 'status', key, icon: msg._active ? 'spinner' : 'check',
          html: msg.content || '', text: msg.content || '', elapsed, stamp,
        });
        return;
      }

      // Out-of-credits card: the dev chat's reply to a 429. MUST come before
      // the empty-assistant skip — this row carries no `content` by design.
      if (msg.creditsCard) {
        if (window.CreditOptions) rows.push({ t: 'credits', key, html: CreditOptions.cardHtml(msg.creditsCard) });
        return;
      }
      // Skip truly empty assistant placeholders that exist only as the
      // streaming target before any tokens arrived.
      if (msg.role === 'assistant' && !msg.content) return;

      const isUser = msg.role === 'user';
      const isCCOutput = (msg.model || '').startsWith('claude-code/');
      const rawContent = msg.content || '';
      const hadChatOnly = /^\[CHAT_ONLY\]/i.test(rawContent);
      const content = rawContent.replace(/^\[CHAT_ONLY\]\s*/i, '');
      const idLabel = msg.id ? `#${msg.id}` : '';
      const ts = msg.created_at ? new Date(msg.created_at).getTime() : '';
      const msgStamp = `${idLabel} ${ts}`;

      if (isCCOutput) {
        const lines = content.replace(/^\*\*Claude Code output:\*\*\n?/i, '').trim();
        const firstPara = lines.split('\n\n')[0] || lines.split('\n')[0];
        rows.push({
          t: 'msg', key, who: 'cc', model: '', stamp: msgStamp,
          contentHtml: DevChat.renderMarkdown(firstPara),
          ...(lines.length > firstPara.length + 10
            ? { more: { details: DevChat._detailsSpec(msg, 'ccfull', false), html: DevChat.renderMarkdown(lines) } }
            : null),
        });
        return;
      }

      // Q/A chips (#32): only on the latest non-system row of an interactive
      // session. Rendered even mid-stream — the 'done' event re-renders before
      // isStreaming flips, so gating on it here would hide them forever; taps
      // are guarded by isStreaming in the click handlers instead.
      const wantsQa = !isUser && msgIdx === qaLastConvoIdx && qaInteractive
        && Array.isArray(msg.suggestions) && msg.suggestions.length;

      rows.push({
        t: 'msg', key, who: isUser ? 'user' : 'ai',
        model: msg.model ? `${msg.model.split('-').slice(0, 2).join('-')}${DevChat._messageCostLabel(msg)}` : '',
        stamp: msgStamp,
        contentHtml: content.trim()
          ? DevChat.renderMarkdown(content)
          : '<span style="color:var(--text-muted);font-style:italic">(no visible reply, see reasoning below)</span>',
        ...(msgIdx === liveIdx ? { live: true } : null),
        ...(isUser ? { attachments: DevChat._attachmentRows(msg) } : null),
        // For any assistant message that carried a [CHAT_ONLY] tag, surface
        // the raw output so nothing is ever invisibly swallowed.
        ...(!isUser && hadChatOnly
          ? { reasoning: { details: DevChat._detailsSpec(msg, 'mayorraw', false), raw: rawContent } }
          : null),
        ...(wantsQa ? { qa: DevChat._qaSpec(msg) } : null),
      });
    });

    const devFlowHtml = DevChat._launchpadVenue() ? '' : DevChat._devFlowHtml();
    return {
      rows,
      // #1281: in a hand-off venue the walkthrough IS the launchpad and
      // renders in the composer's place instead — rendering it here as well
      // would show it twice.
      devFlowHtml,
      // #1942: an open session with nothing in it yet. The pane used to be
      // blank above the composer, so a new session looked like a page that
      // had not loaded. Only for a session that is actually open (its
      // messages have arrived), idle, and not already showing a walkthrough
      // or a hand-off launchpad, which answer "what now?" themselves. It
      // stays until the first message lands, so it is persistent rather than
      // a toast.
      empty: !!session && !rows.length && !DevChat.isStreaming && !devFlowHtml && !DevChat._launchpadVenue(),
      activity: DevChat._activitySpec(),
      // #1889: whether a turn is in flight. The transcript keeps the latest
      // Changes card in its turn's slot while the run's tail is painting and
      // draws it after the last row once the chat is idle — see
      // `DevChatTranscript` in ./transcript.tsx.
      busy: !!DevChat.isStreaming,
    };
  },

  /**
   * #990's trailing dots, as data.
   *
   * ONE INDICATOR AT A TIME (#1590). A live step already draws a spinning
   * arc, names itself and counts its own seconds; dots underneath it are a
   * second answer to the same question, and on a bounce they climb into the
   * row above. So the dots are for the window where NOTHING is live — the
   * ladder frozen on a ✓ while the turn is still running, which is the
   * silent gap #990 was actually about.
   *
   * This started as the same rule for live CODING runs only ("that row
   * already carries a scrolling log and an ETA"), which was the reasoning
   * generalised: every live row carries its own cue, the coding run's is
   * merely the loudest.
   */
  _activitySpec() {
    if (!DevChat.isStreaming || !DevChat._activity) return null;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (!m || m.role !== 'system') continue;
      // Frozen rows say nothing about what is happening NOW, so keep
      // walking past them — the same search the live-CC-run check made.
      if (!m._active) continue;
      return null;
    }
    return { label: DevChat._activity.label || '' };
  },

  renderMessages() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishTranscript) return;
    react.publishTranscript(DevChat._transcriptView());

    // The two FOREIGN cards in the transcript — `DevFlowSelect`'s walkthrough
    // and `CreditOptions`' out-of-credits card — are handed to their own
    // module's `wire()`, which only adds a delegated listener and is
    // idempotent per element. Unconditional, and after every render rather
    // than once per mount: a card that appears in a later publish would
    // otherwise go unwired, which is the #1304 failure. Safe on the line
    // after the publish because `transcriptStore` flushes synchronously — the
    // cards are in the document by now, exactly as they were when the line
    // above was an `innerHTML` assignment. `_bindDevFlowVisibility` in
    // particular must NOT be gated on the walkthrough rendering here: in a
    // hand-off venue it renders in the composer's place instead, and that
    // path wires the card but not the visibility re-check.
    DevChat._wireDevFlowCard();
    DevChat._bindDevFlowVisibility();
    DevChat._wireCreditsCards();

    // #50: start/stop the shared heartbeat based on whether this render left
    // any ticking span. The spans are the component's now and re-derive their
    // own text from `nowStore`; what is left here is the timer that publishes
    // the clock.
    DevChat._syncElapsedTicker();
    // #285: keep the quick-reply pill bar in sync with the latest message.
    DevChat._renderQuickReplies();
  },

  /** Republish the transcript without re-mounting — every patch path's end. */
  _publishTranscript() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishTranscript) return;
    react.publishTranscript(DevChat._transcriptView());
  },

  _onQaChipClick(chip) {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    const gi = parseInt(chip.dataset.qaGroup, 10);
    const ai = parseInt(chip.dataset.qaAnswer, 10);
    const answer = groups[gi]?.answers?.[ai];
    if (answer == null) return;
    // A typed answer and a tapped one fill the SAME slot, so tapping a chip
    // after typing must not leave the typed text quietly winning at send.
    delete DevChat._qaTyped[gi];
    delete DevChat._qaTypedOpen[gi];
    if (groups.length === 1) {
      DevChat.sendMessage(answer);
      return;
    }
    // Multi-question: toggle this group's selection; sending happens via
    // the "Send answers" / defaults buttons.
    if (DevChat._qaSelection[gi] === ai) delete DevChat._qaSelection[gi];
    else DevChat._qaSelection[gi] = ai;
    DevChat.renderMessages();
  },

  /**
   * The escape hatch: the last chip in a row, and the only one that does not
   * answer. It opens a one-line input scoped to its own group.
   *
   * A question offering four answers and no way to give a fifth is a form
   * that only accepts the answers it thought of; the way out used to be the
   * composer, which is a text box for the conversation being asked to do a
   * form's job. The input belongs beside the question it answers.
   */
  _onQaEscapeClick(chip) {
    if (DevChat.isStreaming) return;
    const gi = parseInt(chip.dataset.qaEscape, 10);
    if (!Number.isFinite(gi)) return;
    DevChat._qaTypedOpen[gi] = !DevChat._qaTypedOpen[gi];
    if (!DevChat._qaTypedOpen[gi]) delete DevChat._qaTyped[gi];
    // Typing IS this group's answer, so a chip choice cannot also stand.
    else delete DevChat._qaSelection[gi];
    DevChat.renderMessages();
  },

  /**
   * The typed answer, committed on blur or Enter — never per keystroke.
   *
   * The same rule the admin console's paged search boxes follow: the field
   * is uncontrolled with a `defaultValue`, because a controlled one would
   * republish the whole transcript on every character and take the caret
   * with it.
   */
  _onQaTypedCommit(input) {
    const gi = parseInt(input.dataset.qaTyped, 10);
    if (!Number.isFinite(gi)) return;
    const value = String(input.value || '').trim();
    if (value) DevChat._qaTyped[gi] = value;
    else delete DevChat._qaTyped[gi];
  },

  /** − / + on a numeric group. */
  _onQaStep(btn) {
    if (DevChat.isStreaming) return;
    const gi = parseInt(btn.dataset.qaGroup, 10);
    const dir = parseInt(btn.dataset.qaStep, 10);
    const groups = DevChat._qaCurrentGroups();
    const num = groups && DevChat._qaNumericGroup(groups[gi] && groups[gi].answers);
    if (!num || !Number.isFinite(dir)) return;
    const at = DevChat._qaNumber[gi] != null ? DevChat._qaNumber[gi] : num.suggested;
    const next = Math.max(num.min, parseFloat((at + dir * num.step).toFixed(num.dp)));
    DevChat._qaNumber[gi] = next;
    DevChat.renderMessages();
  },

  /** …and typing into that same field, on the same commit rule. */
  _onQaNumberCommit(input) {
    const gi = parseInt(input.dataset.qaNumber, 10);
    const groups = DevChat._qaCurrentGroups();
    const num = groups && DevChat._qaNumericGroup(groups[gi] && groups[gi].answers);
    if (!num) return;
    const parsed = parseFloat(String(input.value || '').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) DevChat._qaNumber[gi] = Math.max(num.min, parsed);
    DevChat.renderMessages();
  },

  /**
   * The question groups the chips on screen are drawn from, or null (#1601).
   *
   * Every Q/A interaction goes through this: the chip tap, the escape hatch,
   * the number stepper and its typed commit, "Send answers" and "Use the
   * suggested defaults". It was CALLED in five places and DEFINED in none, so
   * each of them threw `DevChat._qaCurrentGroups is not a function` at the
   * first line and the whole quick-check step was a dead end — which is what
   * "selecting use the suggested defaults does nothing, send answers does
   * nothing, not able to continue" was.
   *
   * The rule is `_buildChatView`'s `wantsQa`, restated so the two cannot
   * disagree about WHICH message is being answered: the chips render on the
   * last non-system message when that message is the assistant's, carries a
   * non-empty `suggestions` array, and the session is one the viewer can still
   * act in. Anything else renders no chips, and this answers null so the
   * handlers return instead of acting on a question nobody can see.
   *
   * It returns the RAW `msg.suggestions`, not `_qaSpec`'s view of them: the
   * handlers index `groups[gi].answers[ai]` expecting plain answer strings,
   * while the spec maps each answer to a `{ text, suggested, selected }`
   * object for rendering.
   */
  _qaCurrentGroups() {
    const session = DevChat.currentSession;
    if (!session || (session.status !== 'active' && session.status !== 'promoted')) return null;
    const messages = DevChat.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role === 'system') continue;
      // The last non-system row. If the viewer has already replied it is
      // theirs, the chips are gone, and there is nothing to answer.
      if (msg.role === 'user') return null;
      return Array.isArray(msg.suggestions) && msg.suggestions.length
        ? msg.suggestions
        : null;
    }
    return null;
  },

  /**
   * One group's answer, whichever way it was given. Typing wins over a
   * tapped chip because the two are mutually exclusive above, and a stepper
   * group has no chips to compete with.
   */
  _qaAnswerFor(groups, gi) {
    const typed = DevChat._qaTypedOpen[gi] ? DevChat._qaTyped[gi] : null;
    if (typed) return typed;
    const num = DevChat._qaNumericGroup(groups[gi] && groups[gi].answers);
    if (num) {
      const v = DevChat._qaNumber[gi] != null ? DevChat._qaNumber[gi] : num.suggested;
      return DevChat._qaNumberText(num, v);
    }
    const ai = DevChat._qaSelection[gi];
    return ai != null ? ((groups[gi] && groups[gi].answers[ai]) ?? null) : null;
  },

  _qaSendSelected() {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    const parts = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const answer = DevChat._qaAnswerFor(groups, gi);
      if (answer != null) parts.push(`${gi + 1}. ${answer}`);
    }
    if (!parts.length) return;
    DevChat.sendMessage(parts.join('\n'));
  },

  _qaSendDefaults() {
    if (DevChat.isStreaming) return;
    const groups = DevChat._qaCurrentGroups();
    if (!groups) return;
    DevChat.sendMessage(groups.map((g, gi) => `${gi + 1}. ${g.answers[0]}`).join('\n'));
  },

  // ── Quick-reply pills (#285) ───────────────────────────────
  //
  // A row of tappable pills ABOVE the composer suggesting the user's likely
  // next message. The Mayor attaches 2-3 per turn (suggest_replies → SSE
  // 'quick_replies' → metadata.quickReplies). Unlike the #32 answer chips
  // (inline, send-on-tap), tapping a pill PREFILLS the text box — editable,
  // never auto-send. The bar renders from the LATEST assistant message's
  // quickReplies, so it clears the moment the user sends (a new user row
  // becomes last) and refreshes when the next turn's pills arrive.

  // Generic starter pills for a brand-new session that has no Mayor reply
  // yet — keeps the affordance present from the first screen.
  //
  // #785: the open-issues question leads, because "what does this app's
  // issue tracker already say people want?" is the most useful thing to
  // ask BEFORE describing a change of your own — and the Mayor answers it
  // directly with its list_github_issues data tool (no session work, no
  // scout dispatch). The rest stay as they were.
  STARTER_QUICK_REPLIES: [
    'What issues are open right now?',
    'Change the colors',
    'Add a new feature',
    'Fix something that\'s broken',
  ],

  // #1001: the starters above are the ONE pill set that is legitimately
  // generic — there is no conversation yet to be specific about. But a
  // session started from an issue row's "start work" button already knows
  // what it is for, so lead with that issue instead of the open-issues
  // question. Everything after it stays as-is.
  //
  // created_from_issue_number comes from the session list (see the SELECT in
  // routes/sessions.js); absent on the generic "+ New chat" path and on
  // every session that predates its serialization, both of which fall
  // through to the plain starters.
  _starterQuickReplies() {
    var s = DevChat.currentSession;
    var n = s && s.created_from_issue_number;
    if (!Number.isInteger(n)) return DevChat.STARTER_QUICK_REPLIES;
    return ['What does issue #' + n + ' ask for?'].concat(
      DevChat.STARTER_QUICK_REPLIES.slice(1)
    );
  },

  // #894: last-resort defaults for a session whose newest reply carries no
  // pills. The server now guarantees pills on every turn-end path, so this
  // only fires for rows that PREDATE that guarantee (an old chat reopened)
  // or any path it somehow misses — but it's what makes "there is always
  // something to tap" true rather than nearly true.
  //
  // The strings mirror RECOVERY_PILLS in src/services/recovery-pills.js
  // (code_done / spec_done / chat_generic). The client can't require that
  // module, so tests/quick-reply-fallback.test.js asserts the two copies
  // stay identical.
  FALLBACK_QUICK_REPLIES: {
    code_done: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
    spec_done: ['Build the spec', 'Revise the spec', 'What will this change?'],
    chat_generic: ['Make a change', 'What issues are open right now?', "What's the current state?"],
  },

  // Same state-derived choice the server's fallbackKindForTurn makes for a
  // 'chat' outcome: a PR means a build landed, else a spec means scout work
  // landed, else nothing has happened yet.
  //
  // hasSpec reads session.has_spec — a boolean the session list computes
  // from the same spec_md column the server's turnPills reads, so it's
  // right on first paint. draftContent only exists once the spec viewer
  // has been opened, and specVersion only appears on a scout turn's own
  // status row, so both are fallbacks behind it rather than the primary
  // signal (a session whose spec was written in an earlier turn, or one
  // reopened from the list, has neither).
  _fallbackQuickReplies() {
    const session = DevChat.currentSession;
    if (session && session.pr_number != null) return DevChat.FALLBACK_QUICK_REPLIES.code_done;
    const hasSpec = !!(session && (session.has_spec || (session.spec_md || '').trim()))
      || !!(DevChat.draftContent || '').trim()
      || DevChat.messages.some((m) => m && m.specVersion != null);
    if (hasSpec) return DevChat.FALLBACK_QUICK_REPLIES.spec_done;
    return DevChat.FALLBACK_QUICK_REPLIES.chat_generic;
  },

  // Resolve the pills to show: the newest message carrying quickReplies,
  // the starter set on a fresh session, or null (hide the bar) otherwise.
  // Hidden entirely while a turn is streaming so the user never taps a
  // stale suggestion.
  //
  // #786: the scan walks backwards and stops at the first user/assistant
  // row, but SKIPS pill-less system rows on the way. That keeps every
  // pre-existing behaviour (pills clear the moment a sent user row lands
  // last; an assistant reply without pills means an empty bar; pills from
  // an earlier turn are never resurrected, because the scan stops at the
  // first user/assistant row) while letting a restart-recovery breadcrumb
  // — which is a `system` row, since no Mayor wrap-up runs after a
  // recovery — be the pill source.
  //
  // #894: an ASSISTANT reply that carries no pills no longer means an empty
  // bar — it falls back to a state-derived default set, so a reply that
  // predates the server-side guarantee (or slips past it) still leaves the
  // user something to tap. Two cases deliberately keep returning null:
  //
  //   - the newest row is the user's own message: pills clear the moment
  //     you send, exactly as before (#786). A turn that then dies without
  //     replying is healed server-side by the recovery breadcrumb, which
  //     carries its own pills.
  //   - the newest reply carries #32 answer chips: those are that turn's
  //     affordance and the above-box row stays empty on purpose (the same
  //     precedence resolveQuickReplies and classifyMissingPills enforce
  //     server-side).
  _currentQuickReplies() {
    const session = DevChat.currentSession;
    if (!session) return null;
    if (DevChat.isStreaming) return null;
    const interactive = session.status === 'active' || session.status === 'promoted';
    if (!interactive) return null;
    let sawNonSystem = false;
    let lastConvoRow = null;
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (Array.isArray(m.quickReplies) && m.quickReplies.length) return m.quickReplies;
      if (m.role === 'user' || m.role === 'assistant') { sawNonSystem = true; lastConvoRow = m; break; }
    }
    // A brand-new session (nothing but status rows, if anything) keeps the
    // generic starters so the affordance is present from the first screen.
    if (!sawNonSystem) return DevChat._starterQuickReplies();
    if (!lastConvoRow || lastConvoRow.role !== 'assistant') return null;
    if (Array.isArray(lastConvoRow.suggestions) && lastConvoRow.suggestions.length) return null;
    // #1001: reaching here means the newest reply carried no pills at all,
    // which the server now prevents on every live turn-end path. So this is
    // a genuinely exceptional row (one predating the guarantee, or a path it
    // somehow missed) and worth a breadcrumb for whoever investigates.
    try {
      console.debug('[dev-chat] pill row fell through to the client default', {
        sessionId: DevChat.currentSession && DevChat.currentSession.id,
      });
    } catch (e) {}
    return DevChat._fallbackQuickReplies();
  },

  _renderQuickReplies() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react) return;
    // The bar element AND its `dc-quick-replies-active` are the composer's
    // now — `QuickRepliesBar` derives the class from the same list it draws,
    // so there is one answer to "are there pills" instead of two. The
    // delegated click `_wireQuickReplies` binds on that element still reads
    // each pill's `data-quick-reply-idx`.
    react.publishQuickReplies({ replies: DevChat._currentQuickReplies() || [] });
  },

  // Bind the pill-bar click delegation once per renderChatView (the bar
  // element is recreated on every session re-render, like #dc-messages).
  _wireQuickReplies() {
    const bar = document.getElementById('dc-quick-replies');
    if (!bar || bar._qrWired) return;
    bar._qrWired = true;
    bar.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-quick-reply-idx]');
      if (!pill) return;
      DevChat._onQuickReplyClick(pill);
    });
  },

  // Fill `#dc-session-header`. The element is `renderChatView`'s and is
  // rebuilt on every render, so this mounts per render and the previous
  // host's portal entry is swept as detached (lib/legacy-portals.tsx).
  //
  // The rows ride in WITH the mount rather than in a publish after it: an
  // empty strip for one frame is a visible flicker on the one row that is
  // supposed to be the constant on this screen.
  // Fill `#dc-banners`, the display:contents host `renderChatView` writes.
  // Mounted per render like the other strips, with the state riding in so a
  // banner that has something to say never blinks in a frame late.
  _renderBanners() {
    const host = document.getElementById('dc-banners');
    if (!host) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishBanners) return;
    react.publishBanners(DevChat._bannersView());
  },

  _renderSessionHeader() {
    const host = document.getElementById('dc-session-header');
    if (!host) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishSessionHeader) return;
    react.publishSessionHeader(DevChat._sessionHeaderView());
  },

  // True when the device's PRIMARY pointer is coarse (finger) — i.e. a
  // phone/tablet, where focusing a text input pops the on-screen keyboard.
  // A desktop with a touchscreen still reports a fine primary pointer, so
  // it keeps desktop behavior. maxTouchPoints is the fallback for engines
  // without matchMedia.
  _isCoarsePointer() {
    try {
      if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
    } catch {}
    return (navigator.maxTouchPoints || 0) > 0;
  },

  // Tap = PREFILL the composer (never send). Overwrites the box since pills
  // are complete messages, re-runs the auto-resize, and persists the draft
  // so a tab switch keeps it. On desktop it also focuses with the cursor
  // parked at the end; on touch devices it deliberately does NOT focus —
  // focusing would pop the on-screen keyboard over the chat (#568), and the
  // pill already filled the box.
  _onQuickReplyClick(pill) {
    const idx = parseInt(pill.dataset.quickReplyIdx, 10);
    const replies = DevChat._currentQuickReplies();
    const text = replies && replies[idx];
    if (text == null) return;
    const input = document.getElementById('dc-input');
    if (!input) return;
    input.value = text;
    if (!DevChat._isCoarsePointer()) {
      input.focus();
      try { input.setSelectionRange(text.length, text.length); } catch {}
    }
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, text);
    DevChat._syncSaveDraftBtn();
  },

  // #647's inherited-history pass lived here and is retired. It existed to
  // give ONE class of Claude Code disclosure a collapsed default; every
  // disclosure has that default now (see _ccDefaultOpen below), so the flag
  // it computed had no reader left, and `metadata.inheritedFrom` — which the
  // clone route still stamps, and clone-headless-suggestions.test.js still
  // pins — had no reader on the client at all. A flag nothing consults is a
  // trap for whoever next believes it means something.

  // Should a Claude Code disclosure (dc-cc-attached) start expanded?
  //
  // NO — none of them, which is now the whole rule. It used to be "everything
  // open except rows inherited from a cloned auto session" (#647), on the
  // argument that the live-run log is meant to be watched.
  //
  // That argument belonged to a summary that could not carry the run. It is a
  // card now, and its header holds exactly what the log was watched FOR: the
  // file being edited, the step count, the elapsed timer, the phase, and the
  // AI guess with its countdown. The log underneath is the detail behind
  // those facts, and at 60-215 lines it is the largest thing in the
  // transcript by an order of magnitude.
  //
  // #647 had already found this and fixed it for one case. Its note is worth
  // reading in full: two inherited logs plus a summary "burying the spec
  // card, the Changes ready card and the follow-up message under a wall of
  // log output on first entry". Nothing about that is specific to a clone —
  // a twelve-turn session of the human's own is twelve open logs, and no
  // reader wants eleven of them. This is #647's finding applied where it
  // always applied.
  //
  // Anyone who opens one keeps it open: _applyDetailsPersistence round-trips
  // the flag per message through localStorage, so being wrong here costs one
  // click, once, on the run you actually care about.
  //
  // It takes the message and ignores it. This is the seam every disclosure
  // asks, and a caller that keeps passing its row is what makes a future
  // exception — a live run, say — a change to this function rather than to
  // four call sites.
  _ccDefaultOpen(_msg) {
    return false;
  },

  // The landing of a stop, as chips. Reads only the server's data — the
  // sentence beside it says the same thing in prose, and parsing that prose
  // back out is the thing this field exists to avoid.
  //
  // `commits: null` is "a commit landed, quantity unknown" — the recovered
  // path reaches this from durable tail milestones, which carry a sha and a
  // push flag but no count. It draws a countless chip rather than a made-up
  // number. `sha: null` is the ordinary case and gets one honest chip.
  _stopLandingChips(landing) {
    const s = landing || {};
    if (!s.sha) return ['nothing committed'];
    const chips = [s.commits == null
      ? 'changes committed'
      : `${s.commits} change${s.commits === 1 ? '' : 's'} committed`];
    chips.push(s.sha);
    chips.push(s.pushOk ? 'pushed' : 'not pushed');
    return chips;
  },

  // ── <details> open/closed persistence ─────────────────────
  //
  // renderMessages() blows away the DOM on every re-render, so native <details>
  // elements forget their open state. We tag each one with a stable
  // data-persist-id (scoped per-session) and round-trip its open flag through
  // localStorage so refreshing / tab-switching preserves what the user had
  // expanded (e.g. "Full Claude Code output").

  _DETAILS_KEY_PREFIX: 'dc-details-v1:',

  _detailsId(msg, kind) {
    const base = msg.id || msg._slug || (msg.created_at ? new Date(msg.created_at).getTime() : '');
    return `${base}:${kind}`;
  },

  _readDetailsState(sessionId) {
    try { return JSON.parse(localStorage.getItem(DevChat._DETAILS_KEY_PREFIX + sessionId) || '{}'); }
    catch { return {}; }
  },

  _writeDetailsState(sessionId, state) {
    try { localStorage.setItem(DevChat._DETAILS_KEY_PREFIX + sessionId, JSON.stringify(state)); }
    catch {}
  },

  // ── The <details> open state, which survives a repaint ────────────
  //
  // `_applyDetailsPersistence` walked `#dc-messages` after EVERY render, set
  // `.open` from the stored map and bound a `toggle` listener to write it
  // back. Both halves are the component's now, and these are what it asks:
  // `_detailsOpen` for the initial state, `_detailsToggled` when the reader
  // changes it. The storage convention is unchanged —
  //
  //   state[key] === 1 → the reader opened a default-closed widget
  //   state[key] === 0 → the reader closed a default-open widget
  //   missing          → the widget's own default
  //
  // — which is what keeps a session's disclosures where the reader left them
  // across a reload, not just across a repaint.
  _detailsOpen(persistId, defaultOpen) {
    const sid = DevChat.currentSession?.id;
    if (!sid || !persistId) return !!defaultOpen;
    const state = DevChat._readDetailsState(sid);
    if (state[persistId] === 1) return true;
    if (state[persistId] === 0) return false;
    return !!defaultOpen;
  },

  _detailsToggled(persistId, defaultOpen, open) {
    const sid = DevChat.currentSession?.id;
    if (!sid || !persistId) return;
    const s = DevChat._readDetailsState(sid);
    if (!!open === !!defaultOpen) delete s[persistId]; // back to default
    else s[persistId] = open ? 1 : 0;
    DevChat._writeDetailsState(sid, s);
  },

  // Render markdown to sanitized HTML.
  //   opts.breaks — when true (default) soft single newlines become <br>
  //     (desirable for chat). Spec surfaces pass { breaks: false } so a
  //     prose spec keeps standard markdown paragraph semantics instead of
  //     getting a <br> on every wrapped line (F5).
  renderMarkdown(text, opts = {}) {
    if (!text) return '';

    const breaks = opts.breaks !== undefined ? opts.breaks : true;

    // F7: if the markdown libs failed to load (CDN blocked, SRI mismatch,
    // offline native shell), don't flatten the doc into <br>-joined text —
    // that hides fences and headings and reads exactly like "markdown is
    // broken". Show the raw source in a <pre> (whitespace + fences intact)
    // behind a small notice so the degradation is obvious and diagnosable.
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="dc-md-fallback-notice">Rich text formatting is unavailable right now, so this is the raw markdown.</div>`
        + `<pre class="dc-md-fallback">${escaped}</pre>`;
    }

    if (!DevChat._markdownReady) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

      marked.use({
        breaks: true,
        gfm: true,
        renderer: {
          code({ text, lang, escaped }) {
            let language = lang || '';
            let filepath = '';
            if (language.includes(':')) {
              const i = language.indexOf(':');
              filepath = language.slice(i + 1);
              language = language.slice(0, i);
            }
            const safe = escaped ? text : esc(text);
            const header = filepath
              ? `<div class="dc-code-header">${esc(filepath)}</div>`
              : (language ? `<div class="dc-code-header">${esc(language)}</div>` : '');
            return `${header}<pre class="dc-code-block"><code>${safe}</code></pre>`;
          },
          codespan({ text }) {
            return `<code class="dc-inline-code">${esc(text)}</code>`;
          },
          html({ text }) {
            // GitHub emits a dragged/resized issue-comment screenshot as a
            // raw <img ...> tag rather than Markdown image syntax. Raw HTML
            // stays escaped everywhere by default. On an image-enabled
            // surface, accept only one standalone image tag, extract only its
            // quoted src/alt values, re-check the same URL policy as the
            // Markdown image renderer, and rebuild controlled markup. Width,
            // event handlers, styles and every other supplied attribute are
            // deliberately discarded before DOMPurify sees the result.
            const tag = String(text || '').trim();
            if (DevChat._renderImagesInline && /^<img\b[^>]*\/?>$/i.test(tag)) {
              const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
              const altMatch = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
              const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? '') : '';
              const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : '';
              if (/^https:\/\//i.test(src) || /^\/[^/]/.test(src)) {
                return `<img class="dc-inline-img" src="${escAttr(src)}" alt="${escAttr(alt)}" loading="lazy">`;
              }
            }
            return esc(text);
          },
          // F3: real heading hierarchy. # → h3 (largest), ## → h4,
          // ### and deeper → h5, so a spec's title, sections and
          // subsections are visually distinct instead of all collapsing
          // into one or two levels.
          heading({ tokens, depth }) {
            const inner = this.parser.parseInline(tokens);
            const tag = depth === 1 ? 'h3' : depth === 2 ? 'h4' : 'h5';
            const cls = depth === 1 ? 'dc-h3' : depth === 2 ? 'dc-h4' : 'dc-h5';
            return `<${tag} class="${cls}">${inner}</${tag}>`;
          },
          blockquote({ tokens }) {
            const body = this.parser.parse(tokens);
            return `<div class="dc-blockquote">${body}</div>`;
          },
          list(token) {
            const { ordered, start, items } = token;
            const tag = ordered ? 'ol' : 'ul';
            const cls = ordered ? 'dc-ol' : 'dc-ul';
            const startAttr = ordered && start !== 1 && start !== '' ? ` start="${start}"` : '';
            let body = '';
            for (const item of items) {
              body += this.listitem(item);
            }
            return `<${tag} class="${cls}"${startAttr}>${body}</${tag}>`;
          },
          // F4: GFM task items. marked's default emits an <input
          // type=checkbox>, which DOMPurify strips (input isn't allowed),
          // leaving a bare bullet. Render a non-interactive span marker
          // instead so checklists in specs keep their ☐ / ✓ state.
          listitem(item) {
            const body = this.parser.parse(item.tokens, !!item.loose);
            if (item.task) {
              const mark = item.checked
                ? '<span class="dc-task-check dc-task-checked" aria-hidden="true">&#10003;</span> '
                : '<span class="dc-task-check" aria-hidden="true">&#9744;</span> ';
              return `<li class="dc-task-item">${mark}${body}</li>`;
            }
            return `<li>${body}</li>`;
          },
          // F1: tag the table with dc-table so it can be styled globally
          // (the old .dc-msg-content table rules never reached the spec
          // viewer or preview snippet). Alignment attributes are
          // intentionally dropped — DOMPurify strips them anyway — so cells
          // left-align by default.
          table(token) {
            let header = '';
            for (const cell of token.header) header += this.tablecell(cell);
            let body = '';
            for (const row of token.rows) {
              let rowHtml = '';
              for (const cell of row) rowHtml += this.tablecell(cell);
              body += this.tablerow({ text: rowHtml });
            }
            return `<table class="dc-table"><thead>${this.tablerow({ text: header })}</thead>`
              + `${body ? `<tbody>${body}</tbody>` : ''}</table>`;
          },
          paragraph({ tokens }) {
            return `<p class="dc-p">${this.parser.parseInline(tokens)}</p>`;
          },
          link({ href, title, tokens }) {
            const inner = this.parser.parseInline(tokens);
            if (!/^https?:\/\//i.test(href)) return inner;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          },
          image({ href, title, text }) {
            const safeText = esc(text || '');
            // #683: opt-in inline images (renderMarkdown's images option,
            // consulted via the per-parse flag below — the registered
            // renderers are global). Used for issue bodies so attached
            // screenshots render in the topic view. Only https URLs and
            // same-origin absolute paths qualify; everything else keeps
            // the legacy link/text degradation.
            const inlineOk = DevChat._renderImagesInline
              && (/^https:\/\//i.test(href) || (/^\/[^/]/.test(href)));
            if (inlineOk) {
              return `<img class="dc-inline-img" src="${escAttr(href)}" alt="${escAttr(text || '')}" loading="lazy">`;
            }
            if (!/^https?:\/\//i.test(href)) return safeText;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${safeText || esc(href)}</a>`;
          },
        },
      });

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          const href = node.getAttribute('href') || '';
          if (href && !/^https?:\/\//i.test(href)) {
            node.removeAttribute('href');
          }
        }
      });

      DevChat._markdownReady = true;
    }

    // breaks is overridden per-call (the global default set above is true);
    // the registered renderers persist regardless of the per-parse options.
    // #683: `images: true` (issue bodies) lets markdown images render
    // inline — the flag is read by the global image renderer above during
    // this synchronous parse, and 'img' joins the sanitizer allowlist.
    const allowImages = !!opts.images;
    DevChat._renderImagesInline = allowImages;
    let html;
    try {
      html = marked.parse(text, { breaks });
    } finally {
      DevChat._renderImagesInline = false;
    }

    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['a', 'b', 'strong', 'i', 'em', 'code', 'pre', 'h3', 'h4', 'h5',
        'p', 'br', 'ol', 'ul', 'li', 'div', 'span', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'hr', 'del', ...(allowImages ? ['img'] : [])],
      // 'start' keeps non-1 ordered lists numbering correctly (F2).
      ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'start',
        ...(allowImages ? ['src', 'alt', 'loading'] : [])],
      ALLOW_DATA_ATTR: false,
    });
  },

  // ── The live bubble (#dc-messages' one 60fps writer) ──────────────
  //
  // The stabilized updater for a streaming assistant bubble, with three
  // anti-flicker behaviours (see the proposal/dev-session spec):
  //   • Holds back the trailing incomplete line — only the completed portion
  //     is parsed as markdown, the in-progress final line is appended as
  //     escaped plaintext. A `- [ ]` fragment never momentarily renders as a
  //     checkbox; the row appears once, when its line is finished.
  //   • Throttles to one paint per animation frame, so rows above the cursor
  //     don't redraw on every token.
  //   • Publishes idempotently — the rendered HTML is cached in `_streamHtml`
  //     and an unchanged frame is dropped.
  //
  // It used to throw `el.innerHTML` at the last `.dc-msg-assistant
  // .dc-msg-content` in the transcript, found by `querySelectorAll(…)[length
  // - 1]`. The transcript is a component now, so it publishes into
  // `streamStore` instead — a store exactly ONE row subscribes to, which is
  // what keeps a per-frame publish from re-rendering the whole list (see
  // features/dev-chat/transcript-store.ts).
  //
  // `_streamKey` is the row it belongs to. Non-null means "a turn is writing
  // right now", which is also how `_transcriptView` decides which row is live.
  // `fullText` is the display content so far; `opts.breaks` honours the
  // caller's chat-vs-spec line-break mode.
  _streamKey: null,
  _streamPending: null,
  _streamRaf: null,
  _streamRafKind: null,
  _streamHtml: null,

  _renderStreamingMarkdown(msg, fullText, opts = {}) {
    const key = DevChat._liveRowKey(msg);
    if (!key) return;
    DevChat._streamPending = { key, fullText, breaks: opts.breaks !== false };
    DevChat._streamKey = key;
    if (DevChat._streamRaf != null) return; // a flush is already scheduled
    const flush = () => {
      DevChat._streamRaf = null;
      const pend = DevChat._streamPending;
      if (!pend) return;
      DevChat._streamPending = null;
      DevChat._writeStreamingHtml(pend.key, pend.fullText, pend.breaks, false);
    };
    if (typeof requestAnimationFrame === 'function') {
      DevChat._streamRaf = requestAnimationFrame(flush);
      DevChat._streamRafKind = 'raf';
    } else {
      DevChat._streamRaf = setTimeout(flush, 16);
      DevChat._streamRafKind = 'timeout';
    }
  },

  /** The transcript row a message occupies, by the same rule the model uses. */
  _liveRowKey(msg) {
    if (!msg) return null;
    const idx = DevChat.messages.indexOf(msg);
    return DevChat._rowKey(msg, idx < 0 ? DevChat.messages.length - 1 : idx);
  },

  // Compute the bubble HTML (held-back tail unless `final`) and publish it
  // only when it differs from the last write, eliminating redundant renders.
  // `final` renders the FULL content with no held-back line so a finished
  // bubble is byte-exact.
  _writeStreamingHtml(key, fullText, breaks, final) {
    let html;
    if (final) {
      html = fullText ? DevChat.renderMarkdown(fullText, { breaks }) : '';
    } else if (typeof renderStreamingHtml === 'function') {
      html = renderStreamingHtml(
        fullText,
        (md) => DevChat.renderMarkdown(md, { breaks }),
        escapeHtml
      );
    } else {
      // Helper script failed to load — degrade to the plain full render.
      html = DevChat.renderMarkdown(fullText, { breaks });
    }
    if (DevChat._streamHtml === html) return;
    DevChat._streamHtml = html;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (react && react.publishStream) react.publishStream({ key, html });
  },

  // Flush any pending throttled render and re-render the active streaming
  // bubble with its FULL final content (no held-back line). Called on
  // done / stopped / assistant_message_end / _finishStreaming so the sealed
  // bubble is exact even if a frame was still queued.
  _flushStreamingFinal() {
    const key = DevChat._streamKey;
    if (!key) return;
    // Cleared FIRST, and that is the whole seam: `renderMessages` runs on the
    // very next line of the `done` handler, and `_transcriptView` reads this
    // to decide which row is live. A row that is no longer being written must
    // render its content from the model — `msg.content` is authoritative by
    // then — or the sealed text would vanish on the render that follows.
    DevChat._streamKey = null;
    if (DevChat._streamRaf != null) {
      if (DevChat._streamRafKind === 'raf' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(DevChat._streamRaf);
      } else {
        clearTimeout(DevChat._streamRaf);
      }
      DevChat._streamRaf = null;
    }
    const pend = DevChat._streamPending;
    DevChat._streamPending = null;
    if (pend) DevChat._writeStreamingHtml(pend.key, pend.fullText, pend.breaks, true);
    DevChat._streamHtml = null;
  },

  _lockedToBottom: true,
  // Per-session scroll memory so that leaving the dev-chat tab and coming
  // back lands the user where they left off. Keyed by session id; each
  // entry is `{ scrollTop, lockedToBottom }`. `lockedToBottom === true`
  // means "keep following the conversation" (restore to bottom on return
  // regardless of saved scrollTop).
  _savedScrollBySession: {},

  initScrollTracking() {
    const container = document.getElementById('dc-messages');
    if (!container) return;

    // Click delegation for inline spec preview cards. We rebind on
    // every renderChatView re-render (since #dc-messages itself is
    // recreated when the user navigates between sessions), so a single
    // listener here is enough — innerHTML rewrites inside renderMessages
    // don't break it.
    container.addEventListener('click', (e) => {
      // Q/A chips (#32) — delegated like the spec cards, so innerHTML
      // rewrites inside renderMessages don't drop the handlers.
      const chip = e.target.closest('[data-qa-group]');
      if (chip) { DevChat._onQaChipClick(chip); return; }
      const qaEsc = e.target.closest('[data-qa-escape]');
      if (qaEsc) { DevChat._onQaEscapeClick(qaEsc); return; }
      const qaStep = e.target.closest('[data-qa-step]');
      if (qaStep) { DevChat._onQaStep(qaStep); return; }
      if (e.target.closest('[data-qa-send]')) { DevChat._qaSendSelected(); return; }
      if (e.target.closest('[data-qa-defaults]')) { DevChat._qaSendDefaults(); return; }
      const card = e.target.closest('.dc-spec-preview-card');
      if (!card) return;
      const version = card.dataset.specVersion;
      DevChat.openSpecViewer(version);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.dc-spec-preview-card');
      if (!card) return;
      e.preventDefault();
      DevChat.openSpecViewer(card.dataset.specVersion);
    });

    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      DevChat._lockedToBottom = atBottom;
      if (DevChat.currentSession) {
        DevChat._savedScrollBySession[DevChat.currentSession.id] = {
          scrollTop: container.scrollTop,
          lockedToBottom: atBottom,
        };
      }
    });
    // Watch for DOM changes (collapsibles expanding, new content) and auto-scroll
    const observer = new MutationObserver(() => {
      if (DevChat._lockedToBottom) {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
  },

  // Apply a previously saved scroll position for the current session, if
  // any. Falls back to scrolling to the bottom (which is the desired
  // behavior on first entry into a session).
  //
  // We use scrollTo({ behavior: 'instant' }) rather than assigning
  // .scrollTop directly because .dc-messages-container has CSS
  // `scroll-behavior: smooth` set (so streaming messages glide nicely).
  // That CSS rule applies to .scrollTop assignments too, which would
  // otherwise turn the tab-switch restore into a multi-second animated
  // scroll from 0 → scrollHeight. 'instant' overrides the CSS just for
  // this one programmatic jump.
  restoreSessionScroll() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const saved = DevChat.currentSession
      ? DevChat._savedScrollBySession[DevChat.currentSession.id]
      : null;
    if (saved && !saved.lockedToBottom) {
      container.scrollTo({ top: saved.scrollTop, behavior: 'instant' });
      DevChat._lockedToBottom = false;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
      DevChat._lockedToBottom = true;
    }
  },

  scrollToBottom(force) {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    if (force || DevChat._lockedToBottom) {
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
  },

  // ── Session list ──────────────────────────────────────────
  //
  // Builds the row models; features/dev-chat/session-list.tsx draws them.
  // The HOST stays ours (renderChatView's template writes `#dc-session-list`
  // with the pane's scroll geometry) and its CHILDREN are React's.
  //
  // Which buttons a row gets is the substance here, and none of it follows
  // from the status alone — see ./session-list-store.ts's header for the
  // three rules, and why Archive is gated independently of the rest.
  _sessionRow(s) {
    const title = s.session_title || s.pr_title || s.branch_name || 'Session';
    // #1038: this list is the one session surface that never had a working
    // indicator — GET /api/apps/:slug/sessions returns `warm` (a container
    // exists) but no `busy`. The live store supplies it client-side, so the
    // row matches the board and the cog drawer without widening that payload.
    const busy = (typeof window !== 'undefined' && window.SessionState)
      ? SessionState.isBusy(s.id, false) : false;
    // Promoted sessions can't be demoted to 'paused' (their PR must stay
    // votable), but a warm worker can still be freed — same endpoint, server
    // keeps status 'promoted' (keptPromoted). Once the worker is gone
    // (`warm` false) there's nothing left to free, so no button.
    const actions = [];
    if (s.status === 'active') {
      actions.push({
        key: 'pause', label: 'Pause', busy: 'Pausing…', tone: 'quiet',
        fn: '_sessionListPause', args: [s.id, 'pause'],
      });
    }
    if (s.status === 'promoted' && s.warm) {
      actions.push({
        key: 'free', label: 'Free worker', busy: 'Freeing…', tone: 'quiet',
        title: 'Frees the AI worker. The PR stays up for voting.',
        fn: '_sessionListPause', args: [s.id, 'pause'],
      });
    }
    if (s.status === 'paused') {
      actions.push({
        key: 'resume', label: 'Resume', busy: 'Resuming…', tone: 'go',
        fn: '_sessionListPause', args: [s.id, 'resume'],
      });
    }
    if (s.status === 'archived') {
      actions.push({
        key: 'unarchive', label: 'Unarchive', busy: '...', tone: 'go',
        title: 'Restore this session (reopens the PR)',
        fn: '_sessionListUnarchive', args: [s.id],
      });
    }
    // Archive is gated INDEPENDENTLY of the three above: the backend
    // archives any open session (active/promoted/paused) regardless of warm
    // state, so a cold promoted proposal keeps its Archive button even
    // though it has nothing left to Free. (Re-coupling this to the others is
    // the regression this restores.)
    if (s.status === 'active' || s.status === 'promoted' || s.status === 'paused') {
      actions.push({
        key: 'archive', label: 'Archive', busy: '...', tone: 'danger',
        title: 'Archive (frees the slot; restorable for a while)',
        fn: '_sessionListArchive', args: [s.id, title],
      });
    }
    return {
      id: s.id,
      status: s.status,
      statusTone: (s.status === 'active' || s.status === 'promoted' || s.status === 'paused')
        ? s.status : 'other',
      title,
      branch: s.branch_name || '',
      busy,
      pr: s.pr_url ? { url: s.pr_url, number: s.pr_number } : null,
      // #1808: the raw instant, not `toLocaleDateString()`. The row said
      // "9/9/2026" — a day with no time, in a list where several sessions a
      // day is normal — and ./session-list.tsx stamps it with the shared
      // helper now, which this module cannot import (./mount.ts evaluates
      // its real source in a `vm` as a classic script).
      createdAt: s.created_at || '',
      actions,
    };
  },

  renderSessionList() {
    const container = document.getElementById('dc-session-list');
    if (!container) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react) return;
    react.publishSessionList({
      rows: DevChat.sessions.map((s) => DevChat._sessionRow(s)),
    });
  },

  // ── What the rows' buttons do ─────────────────────────────
  //
  // The list used to bind these per render, by class, over markup it had
  // just written. They are named calls now (the component dispatches by
  // name — dev-chat.js cannot be imported, see ./mount.ts), and each
  // returns the label to FLASH on the button or null to restore it. That is
  // the whole of what the DOM writes in here used to do.

  async openSessionFromList(id) {
    await DevChat.openSession(parseInt(id), { userOpened: true });
    DevChat.renderChatView();
    App.updateHash();
    return null;
  },

  // Reload this app's sessions and repaint the list. Every action ends here.
  async _reloadSessionList() {
    if (AppView.appData) {
      await DevChat.loadSessions(AppView.appData.slug);
      DevChat.renderSessionList();
    }
    await DevChat.loadActiveSessions();
    // #1904: the strip's ⋯ ends here too, and it acts on the OPEN session.
    DevChat._syncCurrentSessionFromList();
  },

  // #1904: fold the reloaded row's status back into the open session and
  // repaint the strip. The list's own buttons never needed this — their row
  // is replaced by the publish above — but the strip's ⋯ calls the same
  // methods on `currentSession`, whose `status` would otherwise still
  // describe the session from before the click, leaving Archive on offer for
  // a session that was just archived. (`_sessionListPause` already sets the
  // paused status ahead of its round trip and keeps doing so; this is the
  // answer for the other two.)
  _syncCurrentSessionFromList() {
    const current = DevChat.currentSession;
    if (!current || !Array.isArray(DevChat.sessions)) return;
    const row = DevChat.sessions.find((s) => Number(s.id) === Number(current.id));
    if (!row) return;
    current.status = row.status;
    DevChat._repaintSessionHeader();
  },

  // Pause / Free-worker / Resume. One method, dispatched on `action`, so we
  // don't have near-identical handlers ("Free worker" is the pause endpoint
  // hitting a promoted session — the server frees the worker and answers
  // keptPromoted). On 4xx (e.g. cap reached on resume), surface the server's
  // error message rather than silently failing.
  async _sessionListPause(id, action) {
    let body = {};
    try {
      const resp = await fetch(`/api/sessions/${id}/${action}`, { method: 'POST' });
      body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(body.error || `Failed to ${action} session`);
        return null;
      }
    } catch {
      return null;
    }
    // Same deliberate-pause sync as the cross-app panel (#193): keep the
    // local currentSession copy honest so the refocus auto-resume doesn't
    // silently re-activate a session the user just paused. keptPromoted =
    // server left the status 'promoted'; don't mislabel.
    if (action === 'pause' && !body.keptPromoted
        && DevChat.currentSession && Number(DevChat.currentSession.id) === Number(id)) {
      DevChat.currentSession.status = 'paused';
    }
    await DevChat._reloadSessionList();
    // The row re-renders without the button (warm flips false), so flash the
    // outcome here, where the user just clicked.
    return body.keptPromoted ? 'Worker freed' : null;
  },

  // Archive. Reversible: it frees the active-session slot, tears down
  // staging + worker, and closes the PR, but keeps Claude's memory and the
  // branch so Unarchive can restore it (until the retention GC eventually
  // purges memory). Wording reflects that it's recoverable.
  async _sessionListArchive(id, name) {
    const ok = await ConfirmModal.show({
      title: `Archive "${name || 'this session'}"?`,
      message: "This closes the PR and frees the slot. You can Unarchive it later to restore it (chat memory is kept for 30 days).",
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return null;
    await fetch(`/api/sessions/${id}/archive`, { method: 'POST' });
    await DevChat._reloadSessionList();
    return null;
  },

  // Unarchive. Restores an archived session to 'paused' (opening it then
  // auto-resumes) and best-effort reopens its PR. If the retention GC
  // already purged the CC volume, we warn that Claude starts fresh.
  async _sessionListUnarchive(id) {
    try {
      const resp = await fetch(`/api/sessions/${id}/unarchive`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(data.error || 'Failed to unarchive session');
        return null;
      }
      if (data.ccPurged) {
        PlatformUI.alert({ title: 'Session restored', message: "Claude's memory had already been cleared, so this picks up as a fresh chat on the same branch." });
      }
    } catch {
      return null;
    }
    await DevChat._reloadSessionList();
    return null;
  },

  // ── Sync-with-main banner (#8, progress #252) ─────────────
  //
  // Shows up below the session header whenever the branch is behind
  // origin/main OR a sync is in flight. Click triggers
  // POST /api/sessions/:id/sync-main, which dispatches a worker turn
  // in MODE=sync. The worker short-circuits when the merge is clean
  // (no LLM spend); only dispatches CC when there are real conflicts
  // to resolve.
  //
  // The behind count is refreshed live via the WS session_update
  // event (action='behind_main'), and the in-flight phase / terminal
  // outcome via action='sync_status'; see App.handleSessionUpdate.
  //
  // _syncState is the server-derived sync indicator (NOT a per-tab
  // flag): null when idle, { sessionId, phase, since } while a sync
  // runs anywhere (this tab, another tab, the resume auto-trigger or
  // the conflict-resolver), and { sessionId, terminal, ok, message }
  // once it finishes. Fed by WS sync_status events, openSession's
  // status check, the poll fallback, and optimistically by the click.
  _syncState: null,
  _syncPollTimer: null,

  _syncPhaseLabel(phase) {
    switch (phase) {
      case 'resolving': return 'Resolving merge conflicts with Claude…';
      case 'pushing': return 'Pushing the merged branch…';
      default: return 'Syncing with main…'; // starting / merging
    }
  },

  // The current _syncState if (and only if) it belongs to the given
  // session — a terminal notice from session A must not render on
  // session B's banner.
  _syncStateFor(session) {
    const st = DevChat._syncState;
    if (!st || !session) return null;
    return Number(st.sessionId) === Number(session.id) ? st : null;
  },

  // #405: the session header's merge-lifecycle pill. Mirrors the canonical
  // state shown on the proposal feed card / home strip so the user no longer
  // has to leave the session to learn where it is — Draft → Checks running /
  // passed → In vote → Behind → Resolving → Passed → Merging… → ✓ Merged. The
  // session payload (GET /api/sessions/:id) carries status / check_state /
  // merge_conflict_state / behind_main, plus yes_count + majority (added for
  // this feature) so the in-vote tally and the "Passed — merging shortly"
  // state resolve exactly as on the feed.
  // The lifecycle descriptor the header pill draws, or null when this
  // session has none worth drawing (paused, archived, …). `MergeStatus`
  // owns every rule that decides it; this only carries the answer, which is
  // already a plain object and so crosses the store unchanged.
  _headerLife(session) {
    if (!session || !(window.MergeStatus && MergeStatus.lifecycle)) return null;
    const life = MergeStatus.lifecycle(session);
    return (life && life.label) ? life : null;
  },

  // #1348's dropdown, as the spec the component draws. `BuildVenues.venue()`
  // is the same lookup `selectorHtml` did before this chunk retired it; the
  // title sentence is that builder's, moved here whole.
  _headerVenue(session) {
    if (!window.BuildVenues || !BuildVenues.venue) return null;
    const v = BuildVenues.sessionVenue({
      current: DevChat._currentVenueId(),
      source: session?.source,
      externalAgent: session?.external_agent,
      buildVenue: session?.build_venue,
      localAgent: DevChat._localAgent,
    });
    if (!v) return null;
    return {
      id: v.id,
      label: v.label,
      title: 'Building in ' + v.label + '. ' + v.blurb
        + ' Pick a different venue: on Homeroom, on your computer, or handed to'
        + ' Claude Code or Codex on the web.',
      // Mid-turn the venue is not changeable: a running turn holds the
      // worker, and moving it under itself is the failure the old
      // `agentSelect.disabled` guarded against. `_chatBusyForPaint` keeps
      // the deterministic busy screenshot honest without changing any of
      // the real streaming guards. Same rule, new control.
      disabled: DevChat._chatBusyForPaint(),
    };
  },

  // `currentSession`, not an argument: `_headerVenue` resolves the venue
  // through `_currentVenueId()`, which is deliberately the ONE place every
  // input to "which venue is this?" meets. A session passed in here would be a
  // second answer to that question, and both callers pass the same row anyway.
  _sessionHeaderView() {
    const session = DevChat.currentSession;
    const s = session || {};
    return {
      sessionId: s.id || null,
      // Streamlined Concept: the strip's Building chip. `_composerBusy` is
      // set synchronously by _setStreamingUI — which also repaints this
      // strip — so the chip tracks every turn transition without a new hook.
      busy: !!DevChat._composerBusy,
      title: s.session_title || s.pr_title || s.branch_name || 'Session',
      branch: s.branch_name || '',
      pr: s.pr_number || null,
      prTitle: s.pr_number
        ? `This session's pull request. Every change in this chat goes to PR #${s.pr_number}. `
          + 'Use “Start a new change” for separate work.'
        : '',
      newChangeTitle: 'This chat is one change → one pull request. A PR opens after the first build.',
      life: DevChat._headerLife(session),
      venue: DevChat._headerVenue(session),
      // #1904: the strip's ⋯ menu — see _headerActions.
      actions: DevChat._headerActions(session),
    };
  },

  // The rows behind the strip's ⋯ (#1904).
  //
  // THE LIST'S rows, not a second set: `_sessionRow` is the one place that
  // decides which of Pause / Free worker / Resume / Unarchive / Archive a
  // session gets, and why Archive is gated apart from the rest, so the menu
  // cannot offer what the list would not.
  //
  // Owner-only, like auto-resume (see `_ownsSession`): pause, archive and
  // unarchive are all owner-scoped on the server, so for anyone else reading
  // the session there is no button at all rather than a menu of calls that
  // can only fail.
  //
  // `warm` comes from the LIST'S row rather than from `currentSession`.
  // Whether a promoted session still has a worker to FREE is computed by
  // GET /api/apps/:slug/sessions and by nothing else — the single-session
  // payload `currentSession` is built from has no such column — so deriving
  // it here would drop "Free worker" from the menu while the list two panes
  // away still offered it. Everything else stays `currentSession`'s, whose
  // status is the fresher of the two: `openSession` flips paused → active on
  // auto-resume before any list reload.
  _headerActions(session) {
    if (!DevChat._ownsSession(session)) return [];
    const rows = Array.isArray(DevChat.sessions) ? DevChat.sessions : [];
    const row = rows.find((r) => Number(r.id) === Number(session.id));
    return DevChat._sessionRow(row ? { ...session, warm: row.warm } : session).actions;
  },

  // Repaint the header strip WITHOUT re-rendering the view.
  //
  // This was `_patchHeaderStatusPill`, and it existed because #405's
  // lifecycle pill had to advance mid-turn (In vote → Passed → Merging…)
  // while a live message stream was on screen, and a full `renderChatView`
  // would have thrown that stream away. It wrote `#dc-status-pill.innerHTML`
  // in place; the strip is its own portal now, so republishing it re-renders
  // the header ALONE and touches nothing below it — which is what let the
  // second in-place write on this strip go too (`_setStreamingUI` used to set
  // `#dc-venue-select.disabled` by hand, and a rendered `disabled` would have
  // clobbered it on the next paint anyway).
  _repaintSessionHeader() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishSessionHeader) return;
    react.publishSessionHeader(DevChat._sessionHeaderView());
  },

  // The two header controls that used to be wired by id after the paint.
  // Named, because the component dispatches by name into `window.DevChat`
  // rather than holding a closure over a render that is already gone.

  /** "PR #123" — jump to the change card below and flash it. */
  revealPrCard() {
    const card = document.getElementById('dc-pr-card');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('dc-pr-card-highlight');
    setTimeout(() => card.classList.remove('dc-pr-card-highlight'), 1500);
  },

  /**
   * The platform header's ← on a session screen (Streamlined Concept) — the
   * in-content #dc-back retired in its favour. Same decline contract as
   * Settings/Admin/Browse's handleBack: true means "handled, stay put",
   * false means the caller keeps walking its chain.
   */
  handleBack() {
    if (!DevChat.currentSession) return false;
    DevChat.leaveSession();
    return true;
  },

  /** The back control's plain-click path — the modified-click guard is the
   *  header's own listener in app.js, which owns the event. */
  leaveSession() {
    // #771: leaving the session unmounts the staging panel slot — close
    // a docked preview with it (fullscreen previews float independently
    // and are unaffected).
    DevChat._resetStagingPanel();
    DevChat.currentSession = null;
    // The header's eye gates on the open session's preview — leaving the
    // session clears it (Streamlined Concept).
    DevChat._publishPreview();
    DevChat.messages = [];
    // The title marker describes the session we just left — drop it
    // so the forum doesn't claim to be thinking / done.
    DevChat.setTitleStatus(null);
    // BACK GOES WHERE YOU CAME FROM, not to a fixed screen.
    //
    // This unconditionally ran `App.switchTab('dev')` — the Board — which was
    // right for a session opened from a card there and wrong for one opened
    // from the app itself or from another app's board. The header's arrow
    // already points at the captured origin
    // (features/improve/improve-store.js, `sessionOrigin`), and this is the
    // click path for that same arrow, so the two have to agree: a control
    // whose href says one thing and whose handler does another is the bug
    // that made the href "decorative" on this bar once before.
    //
    // `window.Improve` rather than an import: a dozen test files run this
    // source as a SCRIPT in a `vm` context, where a top-level import is a
    // syntax error — see the note at the top of this file.
    const origin = window.Improve?.sessionOrigin?.();
    if (origin && typeof location !== 'undefined') {
      location.hash = origin;
    } else if (typeof App !== 'undefined' && App.switchTab) {
      // No origin: a cold deep link straight into the session. The Board is
      // where its own card lives, which is the honest fallback.
      App.switchTab('dev');
    } else {
      DevChat.renderChatView();
    }
  },

  // #405: re-read the open session's lifecycle fields after a vote_update /
  // app_version_changed WS event so the header pill + change card advance
  // live (In vote → Passed → Merging… → ✓ Merged) without a manual reload.
  // No-op unless the event pertains to the session currently open. A full
  // re-render repaints the change card too; while a chat turn is streaming
  // we only patch the header pill to avoid disturbing the live stream.
  async refreshCurrentSessionStatus(sessionId) {
    const cur = DevChat.currentSession;
    if (!cur) return;
    if (sessionId != null && Number(sessionId) !== Number(cur.id)) return;
    if (!document.getElementById('dc-view')) return;
    try {
      const res = await fetch(`/api/sessions/${cur.id}`);
      if (!res.ok) return;
      const { session } = await res.json();
      if (!session || !DevChat.currentSession
          || Number(DevChat.currentSession.id) !== Number(session.id)) return;
      // Lifecycle-relevant scalars decide whether anything visible changed;
      // copy them onto the live row either way.
      const watch = ['status', 'check_state', 'proposal_state',
                     'merge_conflict_state', 'behind_main',
                     'yes_count', 'no_count', 'majority', 'merged_at',
                     // #1442: the freshness measurement. `behind_main` above
                     // is written through from the same pass, but these are
                     // what the conflict / superseded-base notes read, so a
                     // re-measurement has to count as a visible change.
                     'mergeability', 'mergeability_files_complete',
                     'checks_base_sha', 'checks_base_verdict', 'checks_base_behind_by',
                     'freshness_behind_by', 'freshness_checked_at', 'freshness_error',
                     // #695: governance-aware gate fields (approver-only
                     // tallies + per-row requirement) the header pill reads.
                     'votes_required', 'approval_policy', 'approvals_required',
                     'qualified_yes_count', 'qualified_no_count', 'merge_window_ends_at'];
      let changed = false;
      for (const k of watch) {
        if (session[k] !== undefined && DevChat.currentSession[k] !== session[k]) changed = true;
        if (session[k] !== undefined) DevChat.currentSession[k] = session[k];
      }
      // Arrays/objects the card reads are refreshed unconditionally.
      if (session.test_results !== undefined) DevChat.currentSession.test_results = session.test_results;
      if (session.conflict_files !== undefined) DevChat.currentSession.conflict_files = session.conflict_files;
      // #1442: arrays/objects, so the same unconditional copy as above.
      if (session.mergeability_files !== undefined) DevChat.currentSession.mergeability_files = session.mergeability_files;
      if (session.freshness !== undefined) DevChat.currentSession.freshness = session.freshness;
      if (!changed) return;
      if (DevChat.isStreaming) DevChat._repaintSessionHeader();
      else DevChat.renderChatView();
    } catch { /* network blip — ignore, next event/reload reconciles */ }
  },

  // The sync-with-main banner, as a view (features/dev-chat/banners-store.ts)
  // in its four states. Which state is entirely `_syncStateFor`'s and
  // `behind_main`'s; this carries the answer.
  _syncBannerView(session) {
    const behind = (session && Number(session.behind_main)) || 0;
    const sync = DevChat._syncStateFor(session);
    if (behind <= 0 && !sync) return null;
    // Mid-turn a sync is refused by the route anyway (409, "a chat turn holds
    // the worker"), so the button says so before the click rather than after.
    const busy = !!DevChat.isStreaming;
    if (sync && !sync.terminal) {
      return { kind: 'inflight', message: DevChat._syncPhaseLabel(sync.phase) };
    }
    if (sync && sync.terminal && sync.ok) {
      return { kind: 'ok', message: sync.message || 'Synced with main.' };
    }
    if (sync && sync.terminal && !sync.ok) {
      return { kind: 'failed', message: sync.message || 'Sync with main failed.', busy };
    }
    return { kind: 'behind', behind, busy };
  },

  // A session maps to exactly one branch + one PR. Once that PR exists
  // and especially once it's been proposed to the group, continuing to
  // chat here adds MORE changes to the same PR — which bundles unrelated
  // work into one votable unit. Surface a nudge to "Start a new change"
  // (a fresh session) so each PR stays focused. Shown when the session
  // already has a PR and it's past the active-editing stage
  // (promoted / merging / merged). Active sessions with a PR don't get
  // the banner — the user is presumably still refining that change.
  _newChangeBannerView(session) {
    if (!session || !session.pr_number) return null;
    const status = session.status;
    if (status !== 'promoted' && status !== 'merging' && status !== 'merged') return null;
    const proposed = status === 'promoted' || status === 'merging';
    return {
      stateLabel: proposed
        ? `proposed to the group (PR #${session.pr_number})`
        : `merged (PR #${session.pr_number})`,
      pending: !!DevChat._newChangePending,
    };
  },

  // Spin up a fresh session (new branch → new PR) for the same app and
  // open it. Reuses createSession's per-user active-session cap (whatever
  // the server resolves for this viewer — see `caps`) + error alerting. Intentionally does NOT carry over Claude's memory or
  // the spec — a new change starts clean on its own branch.
  // The button's own busy state. It was `btn.disabled` + `btn.textContent`
  // written onto the element by id — a second author on a node the banners
  // component renders now, so it is a published flag instead.
  _newChangePending: false,

  async startNewChange() {
    const slug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug)
      || (DevChat.currentSession && DevChat.currentSession.app_slug);
    if (!slug) return;
    DevChat._newChangePending = true;
    DevChat._publishBanners();
    const session = await DevChat.createSession(slug);
    if (!session) {
      DevChat._newChangePending = false;
      DevChat._publishBanners();
      return;
    }
    DevChat._newChangePending = false;
    await DevChat.openSession(session.id, { userOpened: true });
    DevChat.renderChatView();
    if (typeof App !== 'undefined' && App.updateHash) App.updateHash();
    if (typeof DevChat.loadActiveSessions === 'function') DevChat.loadActiveSessions();
  },

  // Every path that changes banner-relevant state — a behind_main update, a
  // sync_status event, the click handler — ends here.
  //
  // It used to read the live `#dc-sync-banner`, swap its `outerHTML`,
  // `remove()` it, or fall through to a whole `renderChatView` when the
  // element was not there to swap. That last branch was the expensive one: it
  // rebuilt the transcript to make a strip appear. All four banners publish
  // into one store now, so appearing, changing and vanishing are the same act
  // and none of them touches the message list.
  _applySyncBanner() {
    DevChat._publishBanners();
  },

  // The one publish, from the four models.
  _publishBanners() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishBanners) return;
    react.publishBanners(DevChat._bannersView());
  },

  _bannersView() {
    const session = DevChat.currentSession;
    return {
      sync: session ? DevChat._syncBannerView(session) : null,
      newChange: session ? DevChat._newChangeBannerView(session) : null,
      credits: session ? DevChat._creditsBannerView() : null,
      creditsLow: session ? DevChat._creditsLowBannerView() : null,
    };
  },

  // Start a sync, from the banner's button. Named, because the component
  // dispatches by name rather than holding a closure over a render.
  async startSyncWithMain() {
    const st = DevChat._syncState;
    if (st && !st.terminal) return; // already in flight
    const sessionId = DevChat.currentSession?.id;
    if (!sessionId) return;
    // Optimistic in-flight state; the WS sync_status events and the
    // poll fallback take over from here. If a sync is already
    // running server-side this POST coalesces onto it and returns
    // the same final result.
    DevChat._setSyncInFlight(sessionId, 'starting');
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/sync-main`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // 409 = a chat turn holds the worker (friendly message from
        // the route); anything else is a real failure. Either way:
        // inline banner text, never alert().
        DevChat._setSyncTerminal(sessionId, {
          ok: false,
          message: data.error || `Sync failed (HTTP ${resp.status}).`,
        });
      } else {
        // The POST response is the authoritative final result —
        // applied idempotently with the WS terminal event. Refresh
        // the session record so behind_main + the system note pick
        // up the new state even if the tab missed the WS events.
        DevChat._setSyncTerminal(sessionId, {
          ok: data.ok !== false,
          message: data.message,
        });
        await DevChat.openSession(sessionId);
        DevChat.renderChatView();
      }
    } catch (err) {
      DevChat._setSyncTerminal(sessionId, { ok: false, message: `Sync failed: ${err.message}` });
    }
  },

  _setSyncInFlight(sessionId, phase) {
    DevChat._syncState = { sessionId: Number(sessionId), phase, since: Date.now() };
    DevChat._applySyncBanner();
    DevChat._startSyncPolling(Number(sessionId));
  },

  _setSyncTerminal(sessionId, { ok, message }) {
    DevChat._stopSyncPolling();
    const t = {
      sessionId: Number(sessionId),
      terminal: true,
      ok: !!ok,
      message: message || (ok ? 'Synced with main.' : 'Sync with main failed.'),
      since: Date.now(),
    };
    DevChat._syncState = t;
    DevChat._applySyncBanner();
    if (ok) {
      // Success feedback is transient — dismiss after ~5s. Failure
      // sticks around with its Try again button. Identity check so a
      // newer state (e.g. a retry already in flight) is never clobbered.
      setTimeout(() => {
        if (DevChat._syncState === t) {
          DevChat._syncState = null;
          DevChat._applySyncBanner();
        }
      }, 5000);
    }
  },

  // Called by App.handleSessionUpdate when an action='sync_status'
  // event arrives (from this tab's click, another tab, the resume
  // auto-trigger or the conflict-resolver). No-op when the event is
  // for a session that isn't open — list rows are out of scope (#252).
  applySyncStatusUpdate(data) {
    const sessionId = Number(data.sessionId);
    if (!DevChat.currentSession || Number(DevChat.currentSession.id) !== sessionId) return;
    if (data.state === 'done' || data.state === 'failed') {
      DevChat._setSyncTerminal(sessionId, {
        ok: data.state === 'done',
        message: data.message,
      });
      // Refresh so the persisted system note + new behind_main land.
      // Idempotent with the click handler's own refresh.
      DevChat.openSession(sessionId)
        .then(() => DevChat.renderChatView())
        .catch(() => {});
    } else {
      DevChat._setSyncInFlight(sessionId, data.state);
    }
  },

  // Poll fallback while a sync is in flight: catches a missed terminal
  // WS event (tab offline, server restart mid-sync) and keeps the
  // phase text honest if a phase broadcast was dropped. Cleared on any
  // terminal transition and when the open session changes.
  _startSyncPolling(sessionId) {
    if (DevChat._syncPollTimer) return;
    DevChat._syncPollTimer = setInterval(async () => {
      const st = DevChat._syncState;
      if (!st || st.terminal || Number(st.sessionId) !== Number(sessionId)
          || !DevChat.currentSession
          || Number(DevChat.currentSession.id) !== Number(sessionId)) {
        DevChat._stopSyncPolling();
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const { sync } = await res.json();
        if (sync && sync.phase) {
          if (DevChat._syncState && !DevChat._syncState.terminal
              && DevChat._syncState.phase !== sync.phase) {
            DevChat._syncState = { ...DevChat._syncState, phase: sync.phase };
            DevChat._applySyncBanner();
          }
        } else if (Date.now() - st.since > 5000) {
          // No sync in flight server-side — we missed the terminal
          // event. The grace window keeps the optimistic click-state
          // from being cleared before the server registers the run.
          DevChat._stopSyncPolling();
          DevChat._syncState = null;
          await DevChat.openSession(sessionId);
          DevChat.renderChatView();
        }
      } catch {}
    }, 4000);
  },

  _stopSyncPolling() {
    if (DevChat._syncPollTimer) {
      clearInterval(DevChat._syncPollTimer);
      DevChat._syncPollTimer = null;
    }
  },

  // Called by App.handleSessionUpdate when an action='behind_main'
  // event arrives. Patches currentSession + re-renders the banner
  // without tearing down the rest of the chat view. No-op if the
  // event is for a different session.
  applyBehindMainUpdate(sessionId, behindMain) {
    if (!DevChat.currentSession || DevChat.currentSession.id !== sessionId) {
      // Update the in-memory sessions cache so a back-to-list click
      // shows the right state without a refetch.
      if (Array.isArray(DevChat.sessions)) {
        const row = DevChat.sessions.find((s) => s.id === sessionId);
        if (row) row.behind_main = behindMain;
      }
      return;
    }
    DevChat.currentSession.behind_main = behindMain;
    DevChat._applySyncBanner();
  },

  // #1442 — the freshness pass re-measured this proposal against main.
  // Shaped like applyBehindMainUpdate because it supersedes it: the same
  // `behind_main` the sync banner reads rides along, so a stale banner is
  // corrected by the same event that corrects the conflict note. The nested
  // `freshness` block AND the flat columns are both patched, because
  // AppView._freshnessOf accepts either shape and the change card may be
  // rendering from a row loaded before this event.
  applyFreshnessUpdate(data) {
    const sessionId = data && data.sessionId;
    if (sessionId == null) return;
    const f = (data && data.freshness && typeof data.freshness === 'object') ? data.freshness : {};
    const behindMain = typeof data.behindMain === 'number' ? data.behindMain : null;
    const patch = (row) => {
      if (!row) return;
      row.freshness = f;
      if (behindMain !== null) row.behind_main = behindMain;
      row.mergeability = f.mergeability === undefined ? row.mergeability : f.mergeability;
      row.mergeability_files = f.mergeabilityFiles === undefined ? row.mergeability_files : f.mergeabilityFiles;
      row.mergeability_files_complete = f.mergeabilityFilesComplete === undefined
        ? row.mergeability_files_complete : f.mergeabilityFilesComplete;
      row.checks_base_sha = f.checksRanOnBase === undefined ? row.checks_base_sha : f.checksRanOnBase;
      row.checks_base_verdict = f.checksBaseVerdict === undefined ? row.checks_base_verdict : f.checksBaseVerdict;
      row.checks_base_behind_by = f.checksBaseBehindBy === undefined
        ? row.checks_base_behind_by : f.checksBaseBehindBy;
      row.freshness_behind_by = f.behindBy === undefined ? row.freshness_behind_by : f.behindBy;
      row.freshness_checked_at = f.checkedAt === undefined ? row.freshness_checked_at : f.checkedAt;
      row.freshness_error = f.error === undefined ? row.freshness_error : f.error;
    };
    if (Array.isArray(DevChat.sessions)) {
      patch(DevChat.sessions.find((s) => Number(s.id) === Number(sessionId)));
    }
    if (!DevChat.currentSession || Number(DevChat.currentSession.id) !== Number(sessionId)) return;
    patch(DevChat.currentSession);
    DevChat._applySyncBanner();
    // The change card carries the conflict / checks-base notes, so it has to
    // repaint. Mid-stream the header-only repaint keeps the live turn intact,
    // exactly as refreshCurrentSessionStatus decides it.
    if (DevChat.isStreaming) DevChat._repaintSessionHeader();
    else if (document.getElementById('dc-view')) DevChat.renderChatView();
  },

  // ── Chat view ─────────────────────────────────────────────

  /**
   * `#dc-composer-bar`'s children, as one view model.
   *
   * Six writers used to reach into this bar and every one of them was asking
   * the same two questions — is a turn running, and where is this session
   * built. See features/dev-chat/composer-store.ts for the list.
   */
  _composerView() {
    return {
      // Latched by the render that shows it, not read per publish: the note
      // explains a venue you did NOT get, and it must survive every keystroke
      // in the box while still not re-explaining a settled fact on the next
      // full render. See `renderChatView`.
      venueNoteHtml: DevChat._venueNoteForRender || '',
      hidden: !!DevChat._launchpadVenue(),
      models: DevChat._modelPickerView(),
      drafts: DevChat._savedDraftsView(),
      attachError: DevChat._attachError,
      placeholder: DevChat._composerBusy
        ? DevChat._busyComposerPlaceholder()
        : DevChat.COMPOSER_PLACEHOLDER,
      send: DevChat._sendButtonView(),
    };
  },

  /**
   * The send button, as data — the four shapes `_setStreamingUI` painted by
   * hand. Every input is module state, so any caller can repaint it without
   * knowing which transition it is in the middle of.
   */
  _sendButtonView() {
    // TEXT IN THE BOX OUTRANKS EVERY BUSY SHAPE BELOW. This is #810's rule,
    // moved from a separate icon onto the button itself: while a turn runs
    // sending is impossible, so the only thing to do with typed text is park
    // it. Reading the LIVE field is the one input here that cannot come from
    // module state — the textarea is uncontrolled, so its value lives in the
    // DOM and nowhere else. `_syncSaveDraftBtn` is the republish that every
    // keystroke already goes through, which is what keeps this current.
    //
    // It takes Stop's place rather than sitting beside it, which means Stop
    // is not reachable while the field has text. That is deliberate: saving
    // BLANKS the field, so one press of the green button both parks the note
    // and hands Stop back — as does clearing the box.
    //
    // Gated on the PAINT predicate, not on `_composerBusy`, because that is
    // the predicate the save icon this replaces was gated on — `isStreaming`
    // plus the `?shot=` capture state. Keeping it means the affordance is
    // available at exactly the same moments it always was, including before
    // `_setStreamingUI` has run for a turn that has already started.
    if (DevChat._chatBusyForPaint() && DevChat._sendButtonHasText()) return { kind: 'save' };
    if (!DevChat._composerBusy) return { kind: 'send' };
    // #889: a requested-but-not-yet-landed stop outranks both states below —
    // the turn is still streaming (so Send is wrong), but the red Stop square
    // is a lie: pressing it again does nothing.
    if (DevChat._stopping) return { kind: 'stopping' };
    const isWrapUp = DevChat._streamingPhase === 'mayor2';
    // #1378: same spinner, different reason. A turn the server can't stop (no
    // in-process handle — typically one adopted across a restart) must not
    // paint a live red Stop: the click would reach the server, match nothing,
    // and leave the user believing the turn was ending.
    const notStoppable = DevChat._streamingStoppable === false;
    if (!isWrapUp && !notStoppable) return { kind: 'stop' };
    const unstoppable = notStoppable && !isWrapUp;
    return {
      kind: 'busy',
      label: unstoppable ? 'Working' : 'Finishing up',
      title: unstoppable
        ? 'This turn is still running but can’t be stopped from here'
        : 'Finishing up…',
    };
  },

  /** Mount `#dc-composer-bar`'s children. The BAR stays the template's. */
  _renderComposer() {
    const bar = document.getElementById('dc-composer-bar');
    if (!bar) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishComposer) return;
    react.publishComposer(DevChat._composerView());
  },

  /** Republish without re-mounting — every one of the six writers' end. */
  _publishComposer() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishComposer) return;
    react.publishComposer(DevChat._composerView());
  },

  /** The venue sentence this render is showing. See `_composerView`. */
  _venueNoteForRender: '',

  /**
   * `#dc-view`'s children, as one view model.
   *
   * The skeleton was the last string in this file: an `innerHTML` assignment
   * that wrote five hosts and then mounted a portal into each. They are
   * ordinary children of one component now — see
   * features/dev-chat/view-store.ts.
   */
  _devViewState() {
    if (!DevChat.currentSession) return { kind: 'none' };
    const viewerOpen = !!DevChat.specViewer.open;
    const stagingOpen = !!DevChat.stagingPanel.open;
    return {
      kind: 'session',
      embedded: !!document.getElementById('dc-view')?.dataset?.changeWorkspace,
      change: window.AppView?._topicViewFor ? {
        item: DevChat.currentSession,
        ...AppView._topicViewFor(['active', 'paused'].includes(DevChat.currentSession.status) ? 'session' : 'proposal', DevChat.currentSession),

      } : null,
      // #1281: a hand-off venue swaps the composer for the launchpad. The
      // venue dropdown lives in the header, outside the swap, which is what
      // makes it reversible — it is the way back to a chat.
      launchpadHtml: DevChat._launchpadHtml(),
      ownToolsGuide: DevChat._ownToolsGuideView(),
      // Is there anything left in the bottom bar to draw a border around?
      // The composer is hidden in a launchpad and the venue note is usually
      // absent, and an empty bordered strip reads as a broken composer.
      barEmpty: !!DevChat._launchpadVenue() && !DevChat._venueNoteForRender,
      // Saved widths from a previous drag. CSS clamps to a min/max, so a
      // stale value can't make the chat unusably narrow.
      spec: { open: viewerOpen, width: DevChat._readSpecViewerWidth() || null },
      // #771: same width-persistence pattern, separate key (previews want
      // to be wider).
      staging: { open: stagingOpen, width: DevChat._readStagingPanelWidth() || null },
      proposalHint: !!DevChat._proposalHint,
      returnHint: DevChat._showReturnHint(),
    };
  },

  // #1595: keep the first-use explainer until it is acknowledged. Scope the
  // dismissal to the viewer, across apps/sessions, with an in-memory fallback
  // when browser storage is unavailable. Merely reading someone else's chat
  // must not consume your first-use hint.
  _dismissedReturnHints: new Set(),

  _returnHintKey() {
    // A deterministic capture can show the tip even after dismissal, without
    // writing the viewer's preference or changing other screenshot states.
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      if (shot) return shot === 'dev-chat-first-use' ? 'preview' : null;
    } catch { /* no browser location */ }
    if (!DevChat._ownsSession(DevChat.currentSession) || !App.user.id) return null;
    return `usernode:dev-chat-return-hint:v1:${App.user.id}`;
  },

  _showReturnHint() {
    const key = DevChat._returnHintKey();
    if (!key || DevChat._dismissedReturnHints.has(key)) return false;
    if (key === 'preview') return true;
    try { return localStorage.getItem(key) !== '1'; } catch { return true; }
  },

  dismissReturnHint() {
    const key = DevChat._returnHintKey();
    if (!key) return;
    DevChat._dismissedReturnHints.add(key);
    if (key !== 'preview') {
      try { localStorage.setItem(key, '1'); } catch { /* keep the in-memory dismissal */ }
    }
    DevChat._publishDevView();
  },

  /**
   * #194's one-shot hint, set by the "+" menu's "Propose a change".
   *
   * public/js/app-view.js used to `insertAdjacentHTML('afterbegin')` it in
   * front of this subtree, which is a second author on nodes React
   * reconciles. It is a field, latched for the life of the render that shows
   * it — `renderChatView` clears it — so a republish keeps it and the next
   * full render drops it, exactly as the one-shot flag meant.
   */
  _proposalHint: false,

  showProposalHint() {
    DevChat._proposalHint = true;
    DevChat._publishDevView();
  },

  _publishDevView() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishDevView) return;
    react.publishDevView(DevChat._devViewState());
  },

  renderChatView() {
    const content = document.getElementById('dc-view');
    if (!content) return;
    // A lazy workspace host can exist while its session is still loading.
    // Never let an earlier session's background poll fill that empty host.
    if (content.dataset?.changeWorkspace
      && Number(content.dataset.changeWorkspace) !== Number(DevChat.currentSession?.id)) return;
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.mountDevView) return;

    // The dev-chat tab's meta strip (Edit shortcuts + sessions header)
    // takes up vertical space we want to reclaim once the user is
    // inside a chat. Hide it on session open; show it again on back.
    // Lookup is best-effort because some test harnesses mount
    // renderChatView without the surrounding tab shell.
    const meta = document.getElementById('dc-meta');

    if (!DevChat.currentSession) {
      if (meta) meta.classList.remove('hidden');
      // #771: the staging panel slot only exists inside a session view —
      // leaving the session closes a docked preview with it.
      if (DevChat.stagingPanel.open) DevChat._resetStagingPanel();
      // No session, no pane — and no reason to keep a spec's markdown alive
      // in the store until one opens again.
      DevChat._publishSpecViewer();
      react.mountDevView(content, DevChat._devViewState());
      DevChat.renderSessionList();
      return;
    }

    if (meta) meta.classList.add('hidden');

    // #1348: the venue control is the header dropdown, top right. What is
    // left down by the composer is the fallback sentence alone — reported
    // once, on the paint after creation, when the server resolved a venue
    // other than the one the user's default named. Latched for the life of
    // THIS render rather than read per publish: the composer republishes on
    // every keystroke, and re-reading a reason that clears itself would make
    // the sentence vanish on the first one.
    const venueFallbackReason =
      DevChat._venueFallbackReason || DevChat._shotVenueFallbackReason();
    DevChat._venueNoteForRender = window.BuildVenues
      ? BuildVenues.noteHtml({ fallbackReason: venueFallbackReason })
      : '';
    DevChat._venueFallbackReason = null;
    // #194's hint is one-shot: `app-view.js` sets it on the line AFTER this
    // render, so clearing it here is what makes the next render drop it —
    // which is exactly what the innerHTML write it replaces did to the node.
    DevChat._proposalHint = false;
    // The composer's paint state starts idle, which is what the template's
    // own markup used to assert; the two calls at the bottom re-arm it.
    DevChat._composerBusy = false;

    // ONE mount, with the whole screen's state riding in. Everything below
    // resolves controls inside it by id, and the store flushes synchronously
    // — the same contract they had when this line was an innerHTML write.
    react.mountDevView(content, DevChat._devViewState());

    // The five regions inside it publish their own state. Order still
    // matters for the LISTENERS below, not for the markup: `renderMessages`
    // is what starts the elapsed heartbeat and wires the quick-reply bar.
    DevChat._renderSessionHeader();
    DevChat._renderComposer();
    // The first paint can already name the current model. This background
    // read adds the saved/GLM OpenRouter default and favorite shortlist,
    // then republishes only the composer when it lands.
    DevChat._ensureModelPickerData();
    DevChat.renderMessages();
    DevChat._renderQuickReplies();
    DevChat._wireQuickReplies();
    // #463: the banners may have something to say from the CACHED budget, so
    // they mount with it; refreshBudget() re-syncs banner + meter once fresh
    // figures land. Their buttons are the component's, and CreditOptions'
    // delegated click is bound from its own ref.
    DevChat._renderBanners();
    DevChat._wireLaunchpad();
    DevChat.refreshBudget();
    // Attach tracker first so the scroll set below is observed, then
    // restore the session's last known position (or fall through to
    // scroll-to-bottom for a brand-new session / follow-along view).
    DevChat.initScrollTracking();
    DevChat.restoreSessionScroll();
    DevChat._setupTextareaResize();
    DevChat._setupKeyboardShortcuts();
    // Kit polish: hairline/blur on the session header once the chat
    // scrolls, and fixed-shell keyboard avoidance on the message
    // scroller (single-motion focus reveals on phones). Re-keyed on
    // every re-render; detached in AppView.close().
    PlatformUI.attachScreenFx(
      'dev-chat',
      document.getElementById('dc-messages'),
      // The header ELEMENT, by name. It used to be reached as
      // `#dc-back`'s parent, which was true and is now indirect: the back
      // control is rendered by the header's component, so a lookup through it
      // would depend on the portal having mounted. This does not.
      document.getElementById('dc-session-header'),
    );
    DevChat._setupAttachments();
    DevChat._restoreDraft();
    // #798: saved drafts render above the composer and survive re-renders.
    // #940: painted from the localStorage MIRROR so there is no wait; the
    // reconcile kicked off in openSession repaints when the server copy
    // lands.
    DevChat._renderSavedDrafts();
    DevChat._wireSavedDrafts();
    DevChat._syncSaveDraftBtn();
    if (DevChat.isStreaming) DevChat._setStreamingUI(true);
    // #801 screenshot state: paint the mid-turn composer (the circle as Stop,
    // busy placeholder, drafts listed) without any turn actually running.
    // Pure UI — isStreaming stays false, so nothing can be sent or stopped.
    else if (DevChat._wantsBusyShot()) DevChat._setStreamingUI(true, 'claude');
    // …and `?shot=busy-typed` fills the box on top of that, which is what
    // turns the circle green. After the paint above, so the republish it
    // triggers is the last word on the button's shape.
    DevChat._applyTypedShot();
    // …and `?shot=draft-sent` seeds the box and then runs the real clear, so
    // the capture shows the composer as it looks once a draft has been sent.
    DevChat._applyDraftSentShot();

    // #907: repaint from whatever the last status poll told us. The poll
    // itself runs a beat later; painting here means a re-render of an already
    // open session doesn't drop the chip for a second.
    DevChat._renderRunnerControls();

    // Any surface left open by a previous render is anchored to markup that
    // no longer exists, so it is dismissed here rather than left floating
    // over the new composer. Whether one WAS open is remembered, because on
    // a `?shot=` deep link the open card is the thing being rendered:
    // without this, a second render (any status poll) closed it for good and
    // the capture came back showing a plain composer (#1071).
    const optionsWereOpen = !!DevChat._optionsCard;
    DevChat._closeSessionOptions();
    DevChat._maybeOpenShotOptions(optionsWereOpen);

    // The venue dropdown's `disabled` and its click are the component's now
    // (`_headerVenue` resolves the one, `VenueSelect` holds the other). What
    // stays here is the screenshot deep link, which resolves the button by id
    // exactly as it always did.
    DevChat._maybeOpenShotVenueSheet();

    // The grouped model select owns its `change` now and dispatches into
    // `_onModelPicked` by name. Its "Add more OpenRouter models" option
    // reaches the existing catalog through `_onOpenRouterModelChange`.

    // `#dc-pr-header-link` and `#dc-back` are the header component's too —
    // `revealPrCard()` and `leaveSession()` above are what they call.

    // `#dc-sync-btn` and `#dc-new-change-btn` are the banners component's —
    // `startSyncWithMain()` and `startNewChange()` are what they call.

    document.getElementById('dc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      // The one circle, routed. This is now the SAME three-way decision
      // `_onComposerShortcut` makes, which is what let #920's hint line go:
      // the button and Ctrl/Cmd+Enter do the same thing in every state, so
      // the control's own title names it for both.
      if (DevChat.isStreaming) {
        // Text in the box means the button is green Save, not red Stop.
        // `_saveComposerDraft` re-checks `isStreaming` and a non-blank
        // field itself, so a turn that ended between the paint and the
        // click refuses quietly rather than stopping something the user
        // did not aim at.
        if (DevChat._sendButtonHasText()) {
          DevChat._saveComposerDraft();
          return;
        }
        DevChat._stopCurrentTurn();
        return;
      }
      DevChat._submitFromInput();
    });

    // The spec reader publishes unconditionally: a CLOSE has to reach it
    // too. The pane used to be rebuilt empty by the innerHTML above, so a
    // closed panel needed no statement at all; the pane reconciles now, and
    // silence would leave the last session's spec standing inside it.
    DevChat._publishSpecViewer();

    // Wire up the draggable divider between chat pane and viewer. Idempotent —
    // we re-bind on every renderChatView since the resizer element gets
    // recreated whenever the session view re-renders.
    DevChat._initSpecResizer();

    // #771: same re-bind for the staging panel's divider, and re-glue the
    // docked overlay to the freshly-created slot node (innerHTML above
    // destroyed the one AppView was observing).
    DevChat._initStagingResizer();
    if (typeof AppView !== 'undefined' && AppView.rebindStagingDock) {
      AppView.rebindStagingDock();
    }
  },

  // #920: Ctrl/Cmd+Enter routes to whichever composer action is actually
  // offered. While a turn runs the send button is a Stop square and the
  // only thing to do with typed text is park it as a draft (the save
  // icon), so the keystroke does that instead of nothing at all.
  //
  // Gated on the REAL isStreaming — not _chatBusyForPaint — so the
  // shortcut agrees with the guards inside the two actions it delegates
  // to. Every "is save available?" sub-condition (streaming, non-empty
  // text, the MAX_SAVED_DRAFTS cap) already lives inside
  // _saveComposerDraft; this router deliberately re-implements none of
  // them, which is also why a lost race (the turn ending between the
  // keypress and here) refuses silently and leaves the text in the box
  // rather than falling through to a send the user never asked for.
  //
  // It never presses Stop: stopping discards in-flight work and stays a
  // deliberate click.
  _onComposerShortcut() {
    if (DevChat.isStreaming) {
      DevChat._saveComposerDraft();
      return;
    }
    DevChat._submitFromInput();
  },

  // #1962: emptying the composer is TWO writes, not one — the field the user
  // is looking at, and the per-session key `_restoreDraft` reads back on the
  // next render. Anything that clears one and forgets the other looks clear
  // until the view repaints and the stored text walks back in, which is
  // exactly the bug reported against the drafts list's Send.
  //
  // Both writes are synchronous and happen here together, so there is no
  // window for a pending restore or a queued `input` listener to refill the
  // box from the old value: the key is already gone by the time either runs.
  // Callers must invoke this BEFORE `sendMessage` — #370's failure paths put
  // the text back deliberately (`_restoreComposer`), and clearing after them
  // would throw away a message that never actually sent.
  _clearComposerField() {
    const input = document.getElementById('dc-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, '');
    DevChat._syncSaveDraftBtn();
  },

  _submitFromInput() {
    const input = document.getElementById('dc-input');
    const msg = input.value.trim();
    const atts = DevChat.pendingAttachments.filter((a) => !a.uploading);
    // Attachments alone are a valid send (#450) — the server stores a
    // "(attached files)" stub caption.
    if ((!msg && !atts.length) || DevChat.isStreaming) return;
    if (DevChat.pendingAttachments.some((a) => a.uploading)) {
      DevChat._setAttachError('Still uploading, one moment…');
      return;
    }
    DevChat._clearComposerField();
    DevChat.sendMessage(msg, atts);
  },

  // ── File attachments (#450) ─────────────────────────────────
  //
  // Upload-before-send: each picked/pasted/dropped file is validated
  // client-side (mirroring src/services/attachments.js), POSTed as raw
  // octet-stream to /api/sessions/:id/attachments, and parked in
  // `pendingAttachments` (rendered as a strip above the composer) until
  // the message sends with the attachment ids. Orphans left by removed
  // or abandoned uploads are GC'd server-side after 24h.
  pendingAttachments: [],

  // Any file type is accepted: images and .zip classify by extension,
  // everything else is sniffed — readable UTF-8 under the text cap
  // becomes 'text' (inlined into prompts), the rest rides the 'binary'
  // pass-through (delivered to the coding agent as a workspace file).
  ATTACH_LIMITS: {
    maxPerMessage: 4,
    maxImageBytes: 4 * 1024 * 1024,
    maxTextBytes: 200 * 1024,
    maxZipBytes: 20 * 1024 * 1024,
    maxBinaryBytes: 10 * 1024 * 1024,
    imageExts: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  },

  _setupAttachments() {
    const btn = document.getElementById('dc-attach-btn');
    const fileInput = document.getElementById('dc-file-input');
    const textarea = document.getElementById('dc-input');
    const messagesEl = document.getElementById('dc-messages');
    if (!btn || !fileInput) return;

    // Pending uploads belong to the session they were uploaded to.
    const sid = DevChat.currentSession?.id;
    DevChat.pendingAttachments = DevChat.pendingAttachments.filter((a) => a.sessionId === sid);
    DevChat._renderAttachStrip();

    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) DevChat._addFiles(fileInput.files);
      fileInput.value = '';
    });

    // Paste an image straight from the clipboard (screenshots).
    if (textarea) {
      textarea.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) {
              // Clipboard images often arrive nameless — synthesize one.
              if (!f.name || f.name === 'image.png' || !/\./.test(f.name)) {
                const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const named = new File([f], `pasted-image-${Date.now() % 100000}.${ext}`, { type: f.type });
                files.push(named);
              } else {
                files.push(f);
              }
            }
          }
        }
        if (files.length) {
          e.preventDefault();
          DevChat._addFiles(files);
        }
      });
    }

    // Drag-and-drop onto the message area or the composer.
    for (const el of [messagesEl, document.getElementById('dc-form')]) {
      if (!el) continue;
      el.addEventListener('dragover', (e) => { e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          DevChat._addFiles(e.dataTransfer.files);
        }
      });
    }
  },

  // Mirror the server's four-way classifier (src/services/attachments.js
  // validateUpload) closely enough to give instant feedback on obvious
  // size problems; the server remains authoritative (zip safety
  // validation is server-side only). Reads the file's bytes for the
  // UTF-8 sniff — files are capped at 20 MB so this stays cheap.
  async _classifyFile(file) {
    const L = DevChat.ATTACH_LIMITS;
    const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (L.imageExts.includes(ext)) {
      if (file.size > L.maxImageBytes) {
        return { error: `"${file.name}" is too big. Images max ${Math.round(L.maxImageBytes / 1024 / 1024)} MB.` };
      }
      return { kind: 'image' };
    }
    if (ext === 'zip') {
      if (file.size > L.maxZipBytes) {
        return { error: `"${file.name}" is too big. Zip archives max ${Math.round(L.maxZipBytes / 1024 / 1024)} MB.` };
      }
      return { kind: 'zip' };
    }
    if (file.size > L.maxBinaryBytes) {
      return { error: `"${file.name}" is too big. Files max ${Math.round(L.maxBinaryBytes / 1024 / 1024)} MB.` };
    }
    if (file.size <= L.maxTextBytes) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!bytes.includes(0)) {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return { kind: 'text' };
        }
      } catch {}
    }
    return { kind: 'binary' };
  },

  async _addFiles(fileList) {
    if (!DevChat.currentSession || DevChat.isStreaming) return;
    DevChat._setAttachError(null);
    const sid = DevChat.currentSession.id;
    const L = DevChat.ATTACH_LIMITS;
    for (const file of Array.from(fileList)) {
      if (DevChat.pendingAttachments.length >= L.maxPerMessage) {
        DevChat._setAttachError(`Up to ${L.maxPerMessage} files per message.`);
        break;
      }
      const classified = await DevChat._classifyFile(file);
      if (classified.error) {
        DevChat._setAttachError(classified.error);
        continue;
      }
      const entry = {
        sessionId: sid,
        uploading: true,
        id: null,
        kind: classified.kind,
        filename: file.name,
        sizeBytes: file.size,
        meta: null,
        objectUrl: classified.kind === 'image' ? URL.createObjectURL(file) : null,
      };
      DevChat.pendingAttachments.push(entry);
      DevChat._renderAttachStrip();
      try {
        const res = await fetch(`/api/sessions/${sid}/attachments?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
        entry.id = data.id;
        entry.kind = data.kind;
        entry.meta = data.meta || null;
        entry.uploading = false;
      } catch (err) {
        DevChat.pendingAttachments = DevChat.pendingAttachments.filter((a) => a !== entry);
        if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch {} }
        DevChat._setAttachError(err.message || 'Upload failed');
      }
      DevChat._renderAttachStrip();
    }
  },

  _removeAttachment(idx) {
    const entry = DevChat.pendingAttachments[idx];
    if (!entry || entry.uploading) return;
    DevChat.pendingAttachments.splice(idx, 1);
    if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch {} }
    // Server row stays until the 24h orphan sweep — harmless.
    DevChat._setAttachError(null);
    DevChat._renderAttachStrip();
  },

  // The line under the pending strip. It wrote `textContent` and toggled
  // `hidden` on the element; both are one field of the composer model, which
  // is also what makes the message survive a repaint — the old one did not.
  _attachError: null,

  _setAttachError(msg) {
    DevChat._attachError = msg || null;
    DevChat._publishComposer();
  },

  _humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  },

  // Small kind badge for zip/binary chips ("ZIP · 214 files", "BIN").
  // Null for image/text, which carry no tag.
  _attachKindBadge(a) {
    if (a.kind === 'zip') {
      const count = a.meta && Number.isFinite(Number(a.meta.entryCount))
        ? ` · ${a.meta.entryCount} files` : '';
      return `ZIP${count}`;
    }
    if (a.kind === 'binary') return 'BIN';
    return null;
  },

  // …and its HTML spelling, for the message-bubble row, which is still a
  // string renderer. One source of truth for the label either way.
  _attachKindBadgeHtml(a) {
    const label = DevChat._attachKindBadge(a);
    return label ? `<span class="dc-attach-kind">${label}</span>` : '';
  },

  // The strip is features/attachments/pending-strip.tsx's, shared with the
  // group chat's two composers. `renderChatView` rebuilds `#dc-attachments`
  // on every chat-view render, so this mounts per publish; the previous host's
  // portal entry is swept as detached (lib/legacy-portals.tsx).
  //
  // The ELEMENT stays ours — the template writes it and this toggles its
  // `dc-attach-strip-active` (the class that gives the strip its height and
  // border) — and only its ROWS are React's.
  _renderAttachStrip() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react) return;
    // The strip ELEMENT and its `dc-attach-strip-active` are the composer's
    // now: it renders `<PendingStrip>`, the shared file's export that owns
    // the element, rather than portalling rows into a host this wrote.
    react.publishAttachStrip({
      items: DevChat.pendingAttachments.map((a, i) => ({
        key: a.id || `p${i}:${a.filename}`,
        name: a.filename || 'file',
        kind: a.kind,
        badge: DevChat._attachKindBadge(a),
        size: DevChat._humanSize(a.sizeBytes),
        thumbUrl: a.objectUrl || null,
        uploading: !!a.uploading,
      })),
    });
  },

  _setupTextareaResize() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      // Persist the draft per-session so it survives both tab switches
      // (which rebuild the textarea DOM) and full page refreshes.
      if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, textarea.value);
      // #798: the save icon only lights up when there is text to save.
      DevChat._syncSaveDraftBtn();
    });
  },

  // ── Saved draft messages (#798, #810) ──────────────────────
  //
  // The problem: a turn can run for many minutes, and everything the user
  // thinks of meanwhile ("also make the header sticky") either gets lost
  // or gets fired off the moment the turn ends, un-reviewed. So the box
  // stays typable while the agent works (see _setStreamingUI), and the
  // save icon parks the text as a DRAFT.
  //
  // #810 scoped the ICON to the RUNNING chat — the inverse of the #801
  // rule it replaces: it shows for exactly as long as the send button
  // shows Stop, and is hidden (and saving refused) while the chat is
  // stopped, because then the user can simply SEND what they typed and a
  // second "keep this for later" control is just noise. Existing drafts
  // stay listed in both states; only the save affordance moves.
  //
  // Drafts render as a list ABOVE the composer, newest LAST (reading
  // order = the order you thought of them = the order you'll likely send
  // them), each with send / edit / trash. They are NEVER auto-sent —
  // sending is always a deliberate tap, and the tap is refused while a
  // turn is streaming (the row's Send button renders disabled).
  //
  // #940: storage is now the ACCOUNT's, not the browser's. Drafts live in
  // `chat_session_drafts` (owner-scoped; see routes/chat-drafts.js) so a
  // thought parked on a laptop is there on the phone, and clearing site
  // data no longer loses it.
  //
  // localStorage stays in the loop deliberately, as a MIRROR — not a second
  // source of truth:
  //   - instant paint. The list renders from the mirror on open, before the
  //     server round trip lands, so there is no spinner and no blank flash.
  //   - offline buffer. A save whose POST fails still shows in the list and
  //     is flushed by the next reconcile, so text is never lost to a flaky
  //     network.
  // Mirror value shape (v2): { v: 2, drafts: [{ id, text, savedAt, synced }],
  // tombstones: [{ id, at }] }. `synced: false` = "the server hasn't
  // confirmed this yet, upload it on reconcile"; a tombstone = "deleted
  // here, delete it there too". A LEGACY BARE ARRAY (everything written
  // before this change) is still read, with every entry treated as unsynced
  // — that is the whole migration for drafts already in users' browsers.
  MAX_SAVED_DRAFTS: 20,

  // Bounded so an offline device can't grow the mirror without limit. A
  // device offline long enough to overflow this can resurrect a draft it
  // deleted; the user can simply trash it again.
  MAX_DRAFT_TOMBSTONES: 50,

  _savedDraftsKey(sessionId) {
    return `usernode:dc-saved-drafts:${sessionId}`;
  },

  // Screenshot-state deep link (`?shot=drafts`): with no stored list yet,
  // hand back a fixed demo pair so the before/after captures and the
  // dapp.json test see a populated list. Pure UI state — nothing is
  // written to localStorage or the DB, and any real save/trash in the
  // session writes a real list which then takes over (the key EXISTING
  // is what suppresses the demo, so trashing them all sticks).
  _DEMO_SAVED_DRAFTS: [
    { id: 'demo-draft-1', text: 'Staging demo draft: also make the header sticky when scrolling.', savedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'demo-draft-2', text: 'Staging demo draft: rename the "Submit" button to "Publish".', savedAt: '2026-01-01T00:01:00.000Z' },
  ],
  _wantsDemoDrafts() {
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      return shot === 'drafts' || shot === 'busy-drafts' || shot === 'draft-sent';
    } catch { return false; }
  },

  // Screenshot-state deep link `?shot=draft-delete` (#1960).
  //
  // "Deleting drafts is broken" turned out to be a RACE, and a race has no
  // resting state a URL can be pointed at: the draft only came back when
  // the trash landed while a reconcile's list was already in the air. So
  // this link does not paint a state, it PERFORMS the report — it starts a
  // reconcile, trashes a draft while that list is still in flight, then
  // lets a settled resync run on top of it. What the check reads
  // afterwards is the only thing that ever mattered to the user: is the
  // draft still gone.
  //
  // Unlike every other `?shot=` link this one WRITES: a real DELETE,
  // through the real route, against the real table. That is the point — a
  // delete that only pretends to happen cannot catch a delete that comes
  // back. It is fenced instead of env-gated, to one seeded staging session
  // and one seeded draft id (seedStagingDraftDelete in src/db/migrate.js);
  // neither exists in production, so the link is simply inert there. And
  // because it names the id it removes rather than "the first row", a
  // re-run finds it already gone and lands on exactly the same screen.
  SHOT_DRAFT_DELETE_SESSION: 990414,
  SHOT_DRAFT_DELETE_ID: 'dropthisdraft',

  async _applyDraftDeleteShot(sessionId) {
    try {
      if (new URLSearchParams(location.search).get('shot') !== 'draft-delete') return;
    } catch { return; }
    if (Number(sessionId) !== DevChat.SHOT_DRAFT_DELETE_SESSION) return;
    const victim = DevChat.SHOT_DRAFT_DELETE_ID;
    const onThisSession = () => DevChat.currentSession
      && Number(DevChat.currentSession.id) === Number(sessionId);

    // The session payload's drafts field is best-effort, so the list may
    // not be here yet. Settle it before staging anything.
    if (!DevChat._getSavedDrafts(sessionId).some((d) => d.id === victim)) {
      await DevChat._reconcileDrafts(sessionId, null);
    }
    if (!onThisSession()) return;

    // A list fetched BEFORE the trash: the snapshot that used to undo it.
    const inFlight = DevChat._reconcileDrafts(sessionId, null);
    DevChat._deleteSavedDraft(victim);
    await inFlight;
    if (!onThisSession()) return;
    // …and a resync after it, which is what retires the tombstone.
    await DevChat.applyDraftsUpdate(sessionId);
  },

  // Any `?shot=` deep link, whichever one. Read by openSession to keep a
  // capture read-only — see the auto-resume above.
  _isShotDeepLink() {
    try { return !!new URLSearchParams(location.search).get('shot'); } catch { return false; }
  },

  // Screenshot-state deep link (`?shot=busy-drafts`, #801/#810): paints the
  // composer as it looks mid-turn — Stop button, save icon SHOWN beside it,
  // drafts listed with their Send disabled — so the "save while working"
  // half of the feature has a URL the captures and the dapp.json check can
  // reach (the stopped default route covers the hidden half).
  // Deliberately NEVER touches DevChat.isStreaming: the real guards
  // (sendMessage / _submitFromInput / _sendSavedDraft / _stopCurrentTurn)
  // keep reading the honest flag, and nothing here starts or stops a turn.
  _wantsBusyShot() {
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      return shot === 'busy-drafts' || shot === 'busy-typed';
    } catch { return false; }
  },

  // `?shot=busy-typed`: the same mid-turn paint, plus TEXT IN THE BOX — which
  // is the state where the one circle is green Save rather than red Stop.
  //
  // It needs its own route because that state is unreachable from a URL
  // otherwise: the shape is read off the live field (`_sendButtonHasText`),
  // so no amount of module state produces it and a capture of `busy-drafts`
  // only ever shows the empty-field half. Platform rule 5's deep link, for
  // exactly the reason it exists — the changed UI is only reachable by
  // interacting.
  _wantsTypedShot() {
    try { return new URLSearchParams(location.search).get('shot') === 'busy-typed'; }
    catch { return false; }
  },

  // Seed the field for the shot above, once the composer exists. Writes the
  // uncontrolled textarea directly, exactly as `_restoreDraft` does, then
  // republishes so the circle repaints from it.
  _applyTypedShot() {
    if (!DevChat._wantsTypedShot()) return;
    const input = document.getElementById('dc-input');
    if (!input || input.value) return;
    input.value = 'Also widen the meter a little';
    DevChat._syncSaveDraftBtn();
  },

  // `?shot=draft-sent` (#1962): the state right AFTER a saved draft is sent —
  // text was in the box, a row's Send was tapped, and the composer is empty.
  // Like `busy-typed` it is unreachable from a URL otherwise, because the
  // emptiness only means something once something was there to clear.
  //
  // Seeds the field, then runs the module's real `_sendSavedDraft` in `dry`
  // mode: the check is asserting the shipped clear, not a blank field some
  // capture-only branch painted. Nothing is written to the drafts list, no
  // request is made and no turn starts.
  //
  // Latched so a second render cannot re-seed the box and change what the
  // capture shows (#1071).
  _draftSentShotApplied: false,
  _wantsDraftSentShot() {
    try { return new URLSearchParams(location.search).get('shot') === 'draft-sent'; }
    catch { return false; }
  },
  _applyDraftSentShot() {
    if (!DevChat._wantsDraftSentShot() || DevChat._draftSentShotApplied) return;
    const input = document.getElementById('dc-input');
    if (!input) return;
    DevChat._draftSentShotApplied = true;
    input.value = 'Also widen the meter a little';
    DevChat._syncSaveDraftBtn();
    const [first] = DevChat._getSavedDrafts(DevChat.currentSession ? DevChat.currentSession.id : 0);
    if (first) DevChat._sendSavedDraft(first.id, { dry: true });
    else DevChat._clearComposerField();
    // Marks the field as "this route seeded me and then sent". The check
    // asserts emptiness THROUGH it, so a shot that silently did nothing
    // fails instead of passing on a box that was never filled. Nothing
    // renders a `data-shot-sent` prop, so React has no attribute to diff
    // here — the same tolerated overlap as `style.height`.
    input.dataset.shotSent = '1';
  },

  // Paint-only "is a turn running" predicate. Real behaviour must keep
  // reading DevChat.isStreaming directly — this exists so the shot state
  // above renders the busy composer.
  _chatBusyForPaint() {
    return !!DevChat.isStreaming || DevChat._wantsBusyShot();
  },

  // Normalize one stored/wire draft. Anything without an id or with blank
  // text is dropped — a malformed row must never reach the renderer.
  _normalizeDraft(d) {
    if (!d || typeof d.text !== 'string' || !d.text.trim()) return null;
    const id = String(d.id || '');
    if (!id) return null;
    return { id, text: d.text, savedAt: d.savedAt || null, synced: !!d.synced };
  },

  // Read the RAW mirror: drafts plus their sync bookkeeping. Accepts both
  // the v2 object and the LEGACY BARE ARRAY (pre-#940), which is reported
  // with every entry `synced: false` so the first reconcile uploads it.
  // `present` distinguishes "no key at all" (demo seed may apply) from "an
  // explicitly emptied list" (it must stay empty).
  _readDraftMirror(sessionId) {
    const empty = { drafts: [], tombstones: [], present: false };
    if (!sessionId) return empty;
    let raw = null;
    try { raw = localStorage.getItem(DevChat._savedDraftsKey(sessionId)); }
    catch { return empty; }
    if (raw == null) return empty;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { ...empty, present: true }; }

    // Legacy: a bare array of {id, text, savedAt} with no sync state.
    if (Array.isArray(parsed)) {
      return {
        drafts: parsed.map((d) => DevChat._normalizeDraft({ ...d, synced: false })).filter(Boolean),
        tombstones: [],
        present: true,
      };
    }
    if (!parsed || typeof parsed !== 'object') return { ...empty, present: true };
    const drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.map(DevChat._normalizeDraft).filter(Boolean)
      : [];
    const tombstones = Array.isArray(parsed.tombstones)
      ? parsed.tombstones
        .map((t) => ({ id: String(t && t.id || ''), at: (t && t.at) || null }))
        .filter((t) => t.id)
      : [];
    return { drafts, tombstones, present: true };
  },

  _writeDraftMirror(sessionId, { drafts, tombstones }) {
    if (!sessionId) return;
    // Always WRITE the key, even for an empty list — its presence is how
    // an emptied list stays empty (see _getSavedDrafts / demo seed).
    try {
      localStorage.setItem(
        DevChat._savedDraftsKey(sessionId),
        JSON.stringify({
          v: 2,
          drafts: (drafts || []).slice(0, DevChat.MAX_SAVED_DRAFTS),
          tombstones: (tombstones || []).slice(-DevChat.MAX_DRAFT_TOMBSTONES),
        }),
      );
    } catch {}
  },

  // The list the renderer and every mutator read. Synchronous by design —
  // the server round trip is a background reconcile, never something the
  // paint waits on.
  _getSavedDrafts(sessionId) {
    if (!sessionId) return [];
    const mirror = DevChat._readDraftMirror(sessionId);
    if (!mirror.present && !mirror.drafts.length) {
      return DevChat._wantsDemoDrafts()
        ? DevChat._DEMO_SAVED_DRAFTS.map((d) => ({ ...d }))
        : [];
    }
    return mirror.drafts;
  },

  // Replace the visible list, preserving the tombstones the mirror carries
  // (they belong to the sync layer, not to the list the user sees).
  //
  // Called only by the four local mutators (save / send / edit / trash), so
  // it is the right place to advance the #1960 mutation clock: any list a
  // reconcile fetched before this moment is now out of date.
  _setSavedDrafts(sessionId, list) {
    if (!sessionId) return;
    DevChat._bumpDraftSeq(sessionId);
    const { tombstones } = DevChat._readDraftMirror(sessionId);
    DevChat._writeDraftMirror(sessionId, {
      drafts: (list || []).map(DevChat._normalizeDraft).filter(Boolean),
      tombstones,
    });
  },

  // Mark one draft's sync state in the mirror without disturbing the rest.
  _markDraftSynced(sessionId, id, synced) {
    const mirror = DevChat._readDraftMirror(sessionId);
    let touched = false;
    const drafts = mirror.drafts.map((d) => {
      if (d.id !== id || d.synced === synced) return d;
      touched = true;
      return { ...d, synced };
    });
    if (!touched) return;
    DevChat._writeDraftMirror(sessionId, { drafts, tombstones: mirror.tombstones });
  },

  _addDraftTombstone(sessionId, id) {
    const mirror = DevChat._readDraftMirror(sessionId);
    if (mirror.tombstones.some((t) => t.id === id)) return;
    DevChat._bumpDraftSeq(sessionId);
    mirror.tombstones.push({ id, at: new Date().toISOString() });
    DevChat._writeDraftMirror(sessionId, mirror);
  },

  _dropDraftTombstone(sessionId, id) {
    const mirror = DevChat._readDraftMirror(sessionId);
    const tombstones = mirror.tombstones.filter((t) => t.id !== id);
    if (tombstones.length === mirror.tombstones.length) return;
    DevChat._writeDraftMirror(sessionId, { drafts: mirror.drafts, tombstones });
  },

  _isDraftTombstoned(sessionId, id) {
    return DevChat._readDraftMirror(sessionId).tombstones.some((t) => t.id === id);
  },

  // ── #1960: how old is the list I'm holding? ─────────────────────────
  //
  // A reconcile fetches the server's drafts and then decides what to keep.
  // Between those two moments the user can trash a draft, and the list in
  // hand — fetched BEFORE the delete — still contains it. Nothing in the
  // snapshot says so, because a REST list carries no clock.
  //
  // This counter is that clock. Every local mutation bumps it; a reconcile
  // reads it before fetching and again after, and a snapshot taken across
  // a bump is STALE: it may be missing a save and, far worse, may still be
  // showing a delete. Stale snapshots are still merged (the tombstone set
  // subtracts what the user removed), they just aren't allowed to retire a
  // tombstone — that is the one decision that needs a list which postdates
  // the delete it is being asked to forget.
  //
  // In-memory on purpose: it orders events inside one page's lifetime,
  // which is the only place the two sides of the race can both exist.
  _draftMutationSeq: Object.create(null),

  _bumpDraftSeq(sessionId) {
    if (!sessionId) return 0;
    const key = String(sessionId);
    DevChat._draftMutationSeq[key] = (DevChat._draftMutationSeq[key] || 0) + 1;
    return DevChat._draftMutationSeq[key];
  },

  _draftSeq(sessionId) {
    if (!sessionId) return 0;
    return DevChat._draftMutationSeq[String(sessionId)] || 0;
  },

  _newDraftId() {
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  },

  // ── #940 sync layer ────────────────────────────────────────────────
  //
  // Every mutator writes the mirror and renders FIRST (optimistic), then
  // calls one of these. Failures are deliberately SILENT: the text is
  // already safe locally and the next reconcile retries, so a transient
  // blip must not spend a toast on something the user needn't act on.

  // Upload one draft. `POST` is idempotent on (session, draft id), so a
  // reconcile flush can re-send freely.
  async _pushDraftAdd(sessionId, draft) {
    if (!sessionId || !draft) return false;
    // #1960: the user may have trashed this draft before its upload ever
    // ran (a reconcile flush queues uploads, and the flush is async).
    // Uploading it now would put back exactly what the delete removed.
    if (DevChat._isDraftTombstoned(sessionId, draft.id)) return false;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: draft.id, text: draft.text, savedAt: draft.savedAt }),
      });
      if (!res.ok) {
        // The cap is the one failure worth naming — the server refused, so
        // the user's mirror and the server have genuinely diverged.
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}));
          if (data && data.error) DevChat._toast(data.error);
        }
        return false;
      }
      // …and it may have been trashed WHILE the POST was in flight, in
      // which case the delete raced ahead of a row that didn't exist yet
      // and the server is now holding a draft nobody asked for. Undo it.
      if (DevChat._isDraftTombstoned(sessionId, draft.id)) {
        DevChat._pushDraftDelete(sessionId, draft.id);
        return false;
      }
      DevChat._markDraftSynced(sessionId, draft.id, true);
      return true;
    } catch { return false; }
  },

  // Delete one draft. A tombstone is recorded first by the caller so an
  // offline delete still replays.
  //
  // #1960: a 200 here does NOT retire the tombstone. This function knows
  // the server has honoured the delete; it does not know whether some
  // reconcile is still holding a list fetched before it, and retiring the
  // tombstone hands that reconcile a draft with nothing left to suppress
  // it — which is how a trashed draft came back, in the list AND in
  // storage, and got re-uploaded on the reconcile after that. Retiring is
  // now the reconcile's job, from a snapshot it can prove postdates the
  // delete (see _reconcileDrafts). The cost is one tombstone living until
  // the next reconcile; they are capped, and the id is never reused.
  async _pushDraftDelete(sessionId, id) {
    if (!sessionId || !id) return false;
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/drafts/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      return !!res.ok;
    } catch { return false; }
  },

  // Reconcile the local mirror against the server's list. This is BOTH the
  // cross-device sync and the one-time migration of drafts that existed
  // only in this browser before #940.
  //
  //   1. union server + local by id — except a local row already marked
  //      synced that the server no longer has: it was deleted on another
  //      device (or sent there), so it is dropped, never re-uploaded
  //   2. anything tombstoned locally is dropped and DELETEd server-side
  //   3. anything local-and-unsynced is POSTed (the migration/offline flush)
  //   4. tombstones the server no longer knows about are discarded
  //   5. sort oldest-first; keep the OLDEST MAX_SAVED_DRAFTS, matching the
  //      existing cap rule (a full list refuses new saves, it never evicts)
  //
  // `serverList` may be null ("unknown" — e.g. the session payload's
  // best-effort field failed), in which case we fetch it ourselves. A null
  // after that means the network is down: keep the mirror exactly as-is.
  async _reconcileDrafts(sessionId, serverList) {
    if (!sessionId) return;
    // #1960: how old is this list? Only a snapshot we fetched ourselves,
    // with no local change across the wait, is recent enough to retire a
    // tombstone. A caller-supplied array came from some earlier payload
    // (openSession's session fetch) whose age we cannot see, so it is
    // treated as unprovable — it is still merged, it just never gets to
    // decide that a delete has been honoured. The next self-fetching
    // reconcile (the WS echo, or returning to the tab) does that.
    const seqAtFetch = DevChat._draftSeq(sessionId);
    let server = serverList;
    let ownFetch = false;
    if (!Array.isArray(server)) {
      ownFetch = true;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/drafts`);
        if (!res.ok) return;
        const data = await res.json();
        server = Array.isArray(data.drafts) ? data.drafts : [];
      } catch { return; }
    }
    // Did the user change anything while we were waiting? If so this list
    // predates that change: it cannot be trusted to retire tombstones, nor
    // to say that a synced row it lacks was deleted elsewhere.
    const noLocalChange = DevChat._draftSeq(sessionId) === seqAtFetch;
    const snapshotIsCurrent = ownFetch && noLocalChange;

    const mirror = DevChat._readDraftMirror(sessionId);
    const tombstoned = new Set(mirror.tombstones.map((t) => t.id));
    const serverById = new Map();
    for (const raw of server) {
      const d = DevChat._normalizeDraft({ ...raw, synced: true });
      if (d) serverById.set(d.id, d);
    }

    // (2) replay deletes the server still doesn't know about, and forget
    // tombstones it has already honoured.
    const deletes = [];
    for (const t of mirror.tombstones) {
      // Still listed: re-issue the DELETE. It is idempotent, so doing this
      // to a draft the server already dropped costs one request.
      if (serverById.has(t.id)) deletes.push(DevChat._pushDraftDelete(sessionId, t.id));
      // Absent from a snapshot that postdates every local change: the
      // server has honoured it and no in-flight list can resurrect it.
      else if (snapshotIsCurrent) DevChat._dropDraftTombstone(sessionId, t.id);
      // Absent from a STALE snapshot proves nothing — this list may simply
      // have been taken before the draft existed. Keep the tombstone; the
      // reconcile that follows the delete's own round trip retires it.
    }

    // (1) union, minus tombstones. A server row wins on text (it is the
    // authoritative copy); a local-only row survives to be uploaded. A row
    // this device has already seen on the server (`synced`) and the server
    // no longer lists was deleted elsewhere (#1960/#1961): every DELETE
    // pushes a drafts-changed event to the account's other devices, so
    // re-uploading it here would resurrect the draft on all of them.
    // Only a list with no local change across its wait may say so, though:
    // a draft saved mid-reconcile can upload and mark itself synced before
    // the older list arrives, and that list lacks it merely for being older.
    const union = new Map();
    for (const d of mirror.drafts) {
      if (tombstoned.has(d.id)) continue;
      if (d.synced && !serverById.has(d.id) && noLocalChange) continue;
      union.set(d.id, d);
    }
    for (const [id, d] of serverById) {
      if (!tombstoned.has(id)) union.set(id, d);
    }

    // (5) oldest-first, capped. Dropping is loud — the user typed these.
    let merged = Array.from(union.values()).sort(DevChat._compareDrafts);
    const dropped = Math.max(0, merged.length - DevChat.MAX_SAVED_DRAFTS);
    if (dropped) merged = merged.slice(0, DevChat.MAX_SAVED_DRAFTS);

    // The session may have changed under us while the fetch was in flight
    // (the same guard openSession applies to the spec viewer) — writing
    // then would leak this session's drafts into another's mirror.
    if (!DevChat.currentSession || Number(DevChat.currentSession.id) !== Number(sessionId)) return;

    // Never CREATE the key just to record "still empty". Key presence is
    // what suppresses the ?shot demo seed (see _getSavedDrafts), so a
    // reconcile that finds nothing anywhere must leave the key absent —
    // otherwise merely opening a session would kill the screenshot deep
    // link, in production as well as staging. A real save/trash writes the
    // key itself, and that is what makes an emptied list stay empty.
    const nothingToRecord = !merged.length && !mirror.present && !mirror.tombstones.length;
    if (!nothingToRecord) {
      DevChat._writeDraftMirror(sessionId, {
        drafts: merged,
        tombstones: DevChat._readDraftMirror(sessionId).tombstones,
      });
    }
    DevChat._renderSavedDrafts();

    // (3) flush anything the server hasn't got. After the paint, so an
    // offline device still shows the right list immediately.
    const uploads = merged
      .filter((d) => !d.synced && !serverById.has(d.id))
      .map((d) => DevChat._pushDraftAdd(sessionId, d));

    if (dropped) {
      DevChat._toast(
        `That's ${DevChat.MAX_SAVED_DRAFTS} saved drafts. ${dropped} newer `
        + `${dropped === 1 ? 'draft was' : 'drafts were'} dropped. Send or delete one first.`
      );
    }
    await Promise.all([...deletes, ...uploads]);
  },

  // Oldest first ("newest last" in the list), id as the tiebreak because
  // two devices can stamp the same second. Mirrors the server's
  // `ORDER BY saved_at ASC, draft_id ASC`.
  _compareDrafts(a, b) {
    const ta = Date.parse(a.savedAt || '') || 0;
    const tb = Date.parse(b.savedAt || '') || 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  },

  // WS `session_drafts_changed` from another device of the SAME user.
  // No-op unless that session is the one on screen; the next open or
  // visibility-return reconciles anyway, so a dropped socket costs nothing.
  // Returns the reconcile's promise so a caller (and the tests) can wait
  // for it; nothing in the app does, the WS dispatch is fire-and-forget.
  applyDraftsUpdate(sessionId) {
    if (!DevChat.currentSession) return Promise.resolve();
    if (Number(DevChat.currentSession.id) !== Number(sessionId)) return Promise.resolve();
    return DevChat._reconcileDrafts(DevChat.currentSession.id, null);
  },

  _toast(msg) {
    if (window.PlatformUI && typeof PlatformUI.toast === 'function') PlatformUI.toast(msg);
  },

  // Republish the composer because the FIELD changed.
  //
  // It was named for a separate save icon whose `hidden`/`disabled`/`title`
  // it drove (#810). That icon folded into the one circle, but the reason to
  // republish on a keystroke did not: the circle is green Save while a turn
  // runs and the box has text, red Stop while it is empty, so every edit can
  // change its shape. `_sendButtonHasText` is where the rule lives now.
  //
  // Every streaming transition also funnels through `_setStreamingUI`, which
  // calls this — so no extra listeners are needed for the other half.
  _syncSaveDraftBtn() {
    DevChat._publishComposer();
  },

  /**
   * Is there anything in the box to park? — #810's rule, as one boolean.
   *
   * This was `_saveDraftView`, which answered the same question for a
   * separate save icon. The icon is gone; the rule decides the one circle's
   * shape instead (see `_sendButtonView`), and it is the same rule: while
   * the chat is stopped the user can just SEND what they typed, so a "save
   * it for later" control is noise; the moment the button flips to Stop,
   * sending is impossible and parking the text is the only thing to do
   * with it.
   *
   * Read off the LIVE field, which is the one input here that cannot come
   * from a model: the textarea is uncontrolled (the draft restore and the
   * auto-grow both write it directly), so its value lives in the DOM and
   * nowhere else. The caller has already established that a turn is running.
   */
  _sendButtonHasText() {
    const input = document.getElementById('dc-input');
    return !!(input && input.value.trim());
  },

  _renderSavedDrafts() {
    // The rows, the head and the `dc-drafts-active` class were one innerHTML
    // assignment; they are three fields of the composer model now. The
    // delegated click below is unchanged — it reads `data-draft-action` off
    // whichever button was hit and the row's `data-draft-id`.
    DevChat._publishComposer();
  },

  /** The saved-drafts list, as data. `busy` disables each row's Send. */
  _savedDraftsView() {
    const session = DevChat.currentSession;
    const drafts = session ? DevChat._getSavedDrafts(session.id) : [];
    return {
      rows: drafts.map((d) => ({ id: String(d.id), text: d.text })),
      // Paint-only predicate so `?shot=busy-drafts` renders the mid-turn
      // rows; `_sendSavedDraft` still refuses on the real isStreaming flag.
      busy: DevChat._chatBusyForPaint(),
    };
  },

  // Click delegation, bound once per renderChatView (the container node is
  // recreated on every session re-render, like #dc-quick-replies).
  //
  // The composer's own save button used to be bound here too. It is the one
  // circle now, which is inside `#dc-form` and therefore already routed by
  // that form's submit listener — see the three-way branch there.
  _wireSavedDrafts() {
    const box = document.getElementById('dc-drafts');
    if (!box || box._sdWired) return;
    box._sdWired = true;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-draft-action]');
      if (!btn || btn.disabled) return;
      const row = btn.closest('[data-draft-id]');
      if (!row) return;
      const id = row.dataset.draftId;
      const action = btn.dataset.draftAction;
      if (action === 'send') DevChat._sendSavedDraft(id);
      else if (action === 'edit') DevChat._editSavedDraft(id);
      else if (action === 'trash') DevChat._deleteSavedDraft(id);
    });
  },

  // The green circle: move the composer's text into the drafts list and clear
  // the box, so the user can immediately type the next thought. Attachments
  // are NOT captured — a draft is plain text; any pending files stay parked
  // in the composer strip for the real send.
  //
  // CLEARING THE BOX IS load-BEARING, not just a courtesy: an empty field is
  // what turns the circle back into red Stop, so this one press both parks
  // the note and hands the interrupt back.
  //
  // #810: refused while the chat is STOPPED, so the rule holds in BEHAVIOUR
  // and not only in paint — a click landing exactly as a turn ends, or any
  // programmatic call, can't park a draft the user could simply send. Silent
  // no-op (the button is Send by then, so there's no affordance to explain
  // away) and the text is left in the box, where it's already persisted per
  // session. Inverse of the #801 guard it replaces.
  _saveComposerDraft() {
    const session = DevChat.currentSession;
    const input = document.getElementById('dc-input');
    if (!session || !input) return;
    if (!DevChat.isStreaming) return;
    const text = input.value.trim();
    if (!text) return;
    const drafts = DevChat._getSavedDrafts(session.id);
    if (drafts.length >= DevChat.MAX_SAVED_DRAFTS) {
      DevChat._toast(`That's ${DevChat.MAX_SAVED_DRAFTS} saved drafts. Send or delete one first`);
      return;
    }
    const saved = { id: DevChat._newDraftId(), text, savedAt: new Date().toISOString(), synced: false };
    drafts.push(saved);
    DevChat._setSavedDrafts(session.id, drafts);
    // #940: optimistic — the list is already written and painted below; the
    // upload marks it synced when it lands, and reconcile retries if not.
    DevChat._pushDraftAdd(session.id, saved);
    DevChat._clearComposerField();
    DevChat._renderSavedDrafts();
    DevChat._toast('Draft saved. Send it whenever you\'re ready');
    if (!DevChat._isCoarsePointer()) { try { input.focus(); } catch {} }
  },

  // Send: always an explicit tap, never automatic. Refused mid-turn (the
  // button also renders disabled) so a draft can't join a running turn.
  // The draft leaves the list only once the send is actually issued.
  //
  // #1962: the composer is emptied as part of the send. It used to be left
  // alone, which read as "sending a draft repopulates the box with another
  // draft": Edit puts a draft's text in the field and stores it under the
  // session's draft key, so a Send straight afterwards left that older text
  // sitting there — and `_restoreDraft` put it back on every later render,
  // tab switch and reopen. Whatever was typed is parked as a draft of its
  // own first (the same rule Edit follows), so clearing the box still never
  // throws away something the user wrote.
  //
  // `dry` runs everything up to and including the clear and then stops: no
  // list write, no sync request, no turn. It exists for the `?shot=draft-sent`
  // capture route, which has to exercise the real clear without starting a
  // run on a screenshot.
  _sendSavedDraft(id, { dry = false } = {}) {
    const session = DevChat.currentSession;
    if (!session) return;
    if (DevChat.isStreaming) {
      DevChat._toast('Claude is still working. This will send once the turn finishes');
      return;
    }
    const drafts = DevChat._getSavedDrafts(session.id);
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return;
    if (DevChat.pendingAttachments.some((a) => a.uploading)) {
      DevChat._toast('Still uploading a file, one moment…');
      return;
    }
    const input = document.getElementById('dc-input');
    const parked = input ? input.value.trim() : '';
    const next = drafts.filter((d) => d.id !== id);
    let parkedDraft = null;
    if (parked && parked !== draft.text && next.length < DevChat.MAX_SAVED_DRAFTS) {
      parkedDraft = { id: DevChat._newDraftId(), text: parked, savedAt: new Date().toISOString(), synced: false };
      next.push(parkedDraft);
    }
    // Before sendMessage, never after: its 429 and error paths call
    // `_restoreComposer`, which is meant to put the sent text BACK.
    DevChat._clearComposerField();
    if (dry) { DevChat._renderSavedDrafts(); return; }
    DevChat._setSavedDrafts(session.id, next);
    // #940: a send removes the draft everywhere, not just here. Tombstone
    // first so an offline send still replays the delete on reconcile.
    DevChat._addDraftTombstone(session.id, id);
    DevChat._pushDraftDelete(session.id, id);
    if (parkedDraft) DevChat._pushDraftAdd(session.id, parkedDraft);
    DevChat._renderSavedDrafts();
    if (parked && parked !== draft.text) DevChat._toast('Kept what you had typed as another draft');
    DevChat.sendMessage(draft.text);
  },

  // Edit: put the draft back in the composer (where it can be reworded and
  // re-saved, or sent once the turn ends) and drop it from the list. If the
  // box already held text, that text is parked as a draft first so nothing
  // the user typed is ever thrown away.
  _editSavedDraft(id) {
    const session = DevChat.currentSession;
    const input = document.getElementById('dc-input');
    if (!session || !input) return;
    const drafts = DevChat._getSavedDrafts(session.id);
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return;
    let next = drafts.filter((d) => d.id !== id);
    const parked = input.value.trim();
    let parkedDraft = null;
    if (parked && next.length < DevChat.MAX_SAVED_DRAFTS) {
      parkedDraft = { id: DevChat._newDraftId(), text: parked, savedAt: new Date().toISOString(), synced: false };
      next.push(parkedDraft);
    }
    DevChat._setSavedDrafts(session.id, next);
    // #940: taking the draft back into the box removes it everywhere; the
    // text it displaced (if any) is uploaded as a new draft in its place.
    DevChat._addDraftTombstone(session.id, id);
    DevChat._pushDraftDelete(session.id, id);
    if (parkedDraft) DevChat._pushDraftAdd(session.id, parkedDraft);
    input.value = draft.text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    DevChat._setDraft(session.id, draft.text);
    if (!DevChat._isCoarsePointer()) {
      try {
        input.focus();
        input.setSelectionRange(draft.text.length, draft.text.length);
      } catch {}
    }
    DevChat._syncSaveDraftBtn();
    DevChat._renderSavedDrafts();
    if (parked) DevChat._toast('Kept what you had typed as another draft');
  },

  _deleteSavedDraft(id) {
    const session = DevChat.currentSession;
    if (!session) return;
    const drafts = DevChat._getSavedDrafts(session.id);
    if (!drafts.some((d) => d.id === id)) return;
    DevChat._setSavedDrafts(session.id, drafts.filter((d) => d.id !== id));
    // #940: trashing here trashes it on every device. Tombstone first so an
    // offline delete still replays rather than being undone by reconcile.
    DevChat._addDraftTombstone(session.id, id);
    DevChat._pushDraftDelete(session.id, id);
    DevChat._renderSavedDrafts();
    DevChat._toast('Draft deleted');
  },

  // Which session's text the composer field is currently showing, as a
  // string id. Read by `_restoreDraft` to tell a re-render of the same
  // session (don't touch the field) from a switch to another one (the
  // stored draft wins).
  _composerFieldSession: null,

  // Per-session draft helpers, backed by localStorage.
  _draftKey(sessionId) {
    return `usernode:dc-draft:${sessionId}`;
  },
  _getDraft(sessionId) {
    if (!sessionId) return '';
    try { return localStorage.getItem(DevChat._draftKey(sessionId)) || ''; }
    catch { return ''; }
  },
  _setDraft(sessionId, value) {
    if (!sessionId) return;
    try {
      if (value) localStorage.setItem(DevChat._draftKey(sessionId), value);
      else localStorage.removeItem(DevChat._draftKey(sessionId));
    } catch {}
  },

  // #370: put a message the user was about to send (or just sent, on a
  // turn that bounced) back into the composer so they never have to
  // retype it. Shared by _stopCurrentTurn and sendMessage's failure
  // paths (429 token/spend cap, generic non-ok response).
  //
  // - `dropOptimisticUser` (cap/error paths): the optimistic user row
  //   pushed in sendMessage was never persisted (no id) and the turn
  //   never ran — splice it so the text lives only in the editor, not
  //   as a duplicate sent-looking bubble. Scans backwards for the most
  //   recent un-persisted user row so it still finds it even after an
  //   assistant error message has been pushed on top.
  // - `onlyIfEmpty` (Stop path): never clobber a half-typed follow-up,
  //   and — matching the original inline behaviour — do nothing at all
  //   when the textarea isn't mounted.
  //
  // Every DOM / storage touch is guarded (the textarea may be gone if
  // the user navigated away) and an empty message is a no-op.
  _restoreComposer(message, { dropOptimisticUser = false, onlyIfEmpty = false } = {}) {
    if (!message || typeof message !== 'string') return;
    const input = document.getElementById('dc-input');
    if (onlyIfEmpty && (!input || input.value.trim())) return;
    if (dropOptimisticUser) {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        const m = DevChat.messages[i];
        if (m.role === 'user' && !m.id) { DevChat.messages.splice(i, 1); break; }
      }
    }
    if (input) {
      input.value = message;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (dropOptimisticUser) { try { input.focus(); } catch {} }
    }
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, message);
    DevChat._syncSaveDraftBtn();
  },

  // Runs on every renderChatView, and what it does depends on whether the
  // field in front of it belongs to the session being rendered.
  //
  //  - SAME session, something typed: leave it alone (#1962). The stored key
  //    is cleared synchronously by `_clearComposerField`, so after a send
  //    there is nothing here to put back — and a re-render landing between a
  //    keystroke and the `input` listener's write must not replace what is
  //    being typed with the previous value. Same stance as the two
  //    `if (!input.value)` fallbacks in public/js/app-view.js.
  //  - DIFFERENT session: the field is authoritative-by-storage again, so an
  //    A→B switch that reuses the textarea (openSession from a link, without
  //    passing through the list) shows B's draft, or nothing, rather than
  //    leaving A's text sitting in B's composer.
  _restoreDraft() {
    const session = DevChat.currentSession;
    if (!session) return;
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    const sameSession = DevChat._composerFieldSession === String(session.id);
    DevChat._composerFieldSession = String(session.id);
    if (sameSession && textarea.value) return;
    const draft = DevChat._getDraft(session.id);
    if (!draft && !textarea.value) return;
    textarea.value = draft;
    // Re-run the height calculation so the textarea opens at the right
    // size instead of collapsed.
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    DevChat._syncSaveDraftBtn();
  },

  _setupKeyboardShortcuts() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // preventDefault is unconditional for the combination, including
        // the nothing-to-do case (#920) — the keystroke must never leave
        // a stray newline in the box as its only visible effect.
        e.preventDefault();
        DevChat._onComposerShortcut();
      }
    });
  },

  // ===== Spec viewer resizer (draggable divider) =====
  //
  // The chat pane / spec viewer split is fixed at 480px by default but
  // users want to widen the viewer when reading a long spec or shrink
  // it back. CSS handles the side-panel-vs-modal layout switch (CSS
  // wins above 1024px); this just lets the user drag the boundary on
  // wide viewports.
  //
  // Width is persisted to localStorage so it sticks across reloads.
  // The CSS rule `min-width: 280px; max-width: calc(100vw - 320px)`
  // clamps stale or hostile values so the chat pane is always usable.

  _SPEC_VIEWER_WIDTH_KEY: 'dc-spec-viewer-width-v1',
  // The viewer's open/closed state is persisted per-session, not
  // global — a new session that has no spec yet shouldn't auto-open
  // an empty viewer just because the user had it open in a prior
  // session. Width is global (one consistent layout preference);
  // open/closed is per-session.
  _SPEC_VIEWER_OPEN_KEY_PREFIX: 'dc-spec-viewer-open-v1:',

  _readSpecViewerWidth() {
    try {
      const v = parseInt(localStorage.getItem(DevChat._SPEC_VIEWER_WIDTH_KEY) || '', 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  },

  _writeSpecViewerWidth(px) {
    try { localStorage.setItem(DevChat._SPEC_VIEWER_WIDTH_KEY, String(Math.round(px))); }
    catch {}
  },

  _readSpecViewerOpen(sessionId) {
    if (!sessionId) return false;
    try { return localStorage.getItem(DevChat._SPEC_VIEWER_OPEN_KEY_PREFIX + sessionId) === '1'; }
    catch { return false; }
  },

  _writeSpecViewerOpen(sessionId, isOpen) {
    if (!sessionId) return;
    try { localStorage.setItem(DevChat._SPEC_VIEWER_OPEN_KEY_PREFIX + sessionId, isOpen ? '1' : '0'); }
    catch {}
  },

  _initSpecResizer() {
    const handle = document.getElementById('dc-spec-resizer');
    const viewer = document.getElementById('dc-spec-viewer');
    if (!handle || !viewer) return;

    handle.addEventListener('pointerdown', (e) => {
      // Only start dragging when the resizer is actually visible (the
      // viewer is open AND we're in side-panel layout — CSS handles
      // the latter via the dc-spec-resizer-open visibility rule). On
      // narrow viewports the modal layout takes over and this handler
      // is harmless because the resizer itself is `display: none`.
      if (!DevChat.specViewer.open) return;
      e.preventDefault();

      const sessionBody = handle.parentElement;
      const startX = e.clientX;
      const startWidth = viewer.getBoundingClientRect().width;
      const bodyRect = sessionBody.getBoundingClientRect();
      const minWidth = 280;
      const maxWidth = Math.max(minWidth + 1, bodyRect.width - 320);

      // Capture pointer so we keep getting move events even if the
      // cursor strays out of the 4px-wide handle.
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dc-spec-resizer-active');
      // Disable text selection during the drag — selecting random
      // chat / spec text while resizing is just visual noise.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        // Dragging right shrinks the viewer (its left edge moves right).
        const delta = ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth - delta));
        viewer.style.width = `${next}px`;
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('dc-spec-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const finalWidth = viewer.getBoundingClientRect().width;
        DevChat._writeSpecViewerWidth(finalWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // ===== Staging preview side panel (#771) =====
  //
  // The slot + resizer mirror the spec viewer's layout mechanics; the
  // preview content itself stays in AppView's fixed #staging-overlay
  // (docked mode) — see the stagingPanel state comment for why.

  _STAGING_PANEL_WIDTH_KEY: 'dc-staging-panel-width-v1',

  _readStagingPanelWidth() {
    try {
      const v = parseInt(localStorage.getItem(DevChat._STAGING_PANEL_WIDTH_KEY) || '', 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  },

  _writeStagingPanelWidth(px) {
    try { localStorage.setItem(DevChat._STAGING_PANEL_WIDTH_KEY, String(Math.round(px))); }
    catch {}
  },

  // Mount the staging panel slot beside the chat. One right-hand panel
  // at a time: the spec viewer yields (and vice versa in openSpecViewer)
  // so the chat is never squeezed between two panels.
  openStagingPanel() {
    if (!DevChat.currentSession) return;
    DevChat.stagingPanel.open = true;
    if (DevChat.specViewer.open) {
      DevChat.specViewer.open = false;
      DevChat._writeSpecViewerOpen(DevChat.currentSession.id, false);
    }
    DevChat.renderChatView();
  },

  // Drag logic cloned from _initSpecResizer (panel on the right, drag
  // left grows it), with two staging-specific twists: a 320px floor
  // (previews render real app UIs) and pointer-events disabled on the
  // preview iframe during the drag — unlike the spec viewer's markdown,
  // an iframe swallows pointermove events and would kill the drag the
  // moment the cursor crossed into it.
  _initStagingResizer() {
    const handle = document.getElementById('dc-staging-resizer');
    const panel = document.getElementById('dc-staging-panel');
    if (!handle || !panel) return;

    handle.addEventListener('pointerdown', (e) => {
      if (!DevChat.stagingPanel.open) return;
      e.preventDefault();

      const sessionBody = handle.parentElement;
      const iframe = document.getElementById('staging-iframe');
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const bodyRect = sessionBody.getBoundingClientRect();
      const minWidth = 320;
      const maxWidth = Math.max(minWidth + 1, bodyRect.width - 320);

      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dc-staging-resizer-active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      if (iframe) iframe.style.pointerEvents = 'none';

      const onMove = (ev) => {
        // Dragging right shrinks the panel (its left edge moves right).
        const delta = ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth - delta));
        panel.style.width = `${next}px`;
        // Keep the docked overlay glued during the drag — the slot's
        // ResizeObserver fires too, but syncing here keeps it crisp.
        if (typeof AppView !== 'undefined' && AppView._syncStagingDockGeometry) {
          AppView._syncStagingDockGeometry();
        }
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('dc-staging-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        if (iframe) iframe.style.pointerEvents = '';
        const finalWidth = panel.getBoundingClientRect().width;
        DevChat._writeStagingPanelWidth(finalWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // ===== Spec viewer helpers =====
  //
  // Read-only viewer that opens when the user clicks an inline spec
  // preview card in the chat timeline. Mounts as a side panel beside
  // the chat on wide viewports and as a fullscreen modal on narrow
  // ones — the layout switch is pure CSS (see app.css), the JS just
  // toggles state + re-renders.

  // Open the viewer for a specific version ('latest' to follow the
  // highest version, or a numeric version string/number for an older
  // frozen snapshot). Legacy inline cards from before per-change
  // versioning carry 'draft' — treat that as 'latest' for back-compat.
  // Triggers a network fetch for the latest content + version metadata,
  // and a second fetch for the selected frozen version's content if
  // needed. Safe to call when already open (just reloads).
  openSpecViewer(version) {
    if (!DevChat.currentSession) return;
    const sid = DevChat.currentSession.id;
    // #771: one right-hand panel at a time — a docked staging preview
    // yields to the spec viewer (mirrors openStagingPanel). open=false is
    // set first so closeStagingOverlay skips its own re-render; the
    // renderChatView below repaints the layout once.
    if (DevChat.stagingPanel.open) {
      DevChat.stagingPanel.open = false;
      if (typeof AppView !== 'undefined' && AppView._stagingMode === 'docked'
          && AppView.closeStagingOverlay) {
        AppView.closeStagingOverlay();
      }
    }
    DevChat.specViewer.open = true;
    DevChat.specViewer.sessionId = sid;
    DevChat.specViewer.viewVersion = (version === 'draft' || version === 'latest' || version == null) ? 'latest' : version;
    DevChat.specViewer.viewVersionContent = null;
    DevChat._writeSpecViewerOpen(sid, true);
    DevChat.renderChatView();
    DevChat._loadSpecViewer({ force: true });
  },

  closeSpecViewer() {
    const sid = DevChat.currentSession ? DevChat.currentSession.id : null;
    DevChat.specViewer.open = false;
    DevChat._writeSpecViewerOpen(sid, false);
    DevChat.renderChatView();
  },

  // Fetch the latest spec content + frozen-version metadata. Called
  // when the viewer opens and whenever a spec_updated SSE event lands
  // while the viewer is following the latest version.
  async _loadSpecViewer(opts = {}) {
    const session = DevChat.currentSession;
    if (!session) return;
    const sid = session.id;
    if (DevChat.specViewer.isLoading && !opts.force) return;

    DevChat.specViewer.isLoading = true;
    DevChat._publishSpecViewer();

    try {
      // ?demo=1 rides along (same pass-through as /status) so a staging
      // preview's non-owner spec panel can serve the #1012 mock list.
      const resp = await fetch(`/api/sessions/${sid}/spec${DevChat._demoQS()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!DevChat.currentSession || DevChat.currentSession.id !== sid) return;

      DevChat.specViewer.sessionId = sid;
      DevChat.specViewer.draftContent = data.spec || '';
      DevChat.specViewer.versions = data.versions || [];
    } catch (err) {
      console.warn('loadSpecViewer failed:', err);
    } finally {
      DevChat.specViewer.isLoading = false;
      DevChat._publishSpecViewer();
    }
  },

  /**
   * The version the panel is showing.
   *
   * `'latest'` is a SENTINEL, not a number: it follows the highest version as
   * Mayor edits create new ones. An unknown selection falls back to the
   * latest rather than to nothing, which is also what makes the lazy fetch
   * below terminate — a version that cannot be resolved is never fetched.
   */
  _selectedSpecVersion() {
    const versions = DevChat.specViewer.versions; // DESC sorted
    if (!versions.length) return null;
    const latest = versions[0];
    if (DevChat.specViewer.viewVersion === 'latest') return latest;
    return versions.find((v) => String(v.version) === String(DevChat.specViewer.viewVersion))
      || latest;
  },

  /**
   * `#dc-spec-viewer`'s children, as one view model.
   *
   * This was `_renderSpecViewer`: an `innerHTML` assignment followed by six
   * `addEventListener` calls onto the nodes it had just written. The markup
   * is features/dev-chat/spec-viewer.tsx now and so is every listener; what
   * is left here is the reading of `DevChat.specViewer`, which stays one
   * global slot because five other places read and write it.
   */
  _specViewerView() {
    if (!DevChat.currentSession) return { kind: 'closed' };
    if (!DevChat.specViewer.open) return { kind: 'closed' };
    // #233 fail-closed guard: never render another session's spec. Any
    // path that forgets to reset the global specViewer slot on a
    // session switch gets a blank panel, not stale content. It has to SAY
    // closed rather than decline to speak: the pane reconciles now, so a
    // bare `return` would leave the previous session's panel standing.
    if (DevChat.specViewer.sessionId != null
        && Number(DevChat.specViewer.sessionId) !== Number(DevChat.currentSession.id)) {
      return { kind: 'closed' };
    }

    // Sharing back out (to the group, to a user) and dispatching a build
    // are the OWNER's affordances; a non-owner viewer reaches this panel
    // legitimately (admins can open any session view) but only ever
    // reads the versions the server's shared-visibility gate returned.
    const isOwner = DevChat._ownsSession(DevChat.currentSession);

    // Numbered versions are the single spec surface now (#69). The
    // dropdown lists v1…vN; the highest is the live latest and its
    // content is byte-identical to chat_sessions.spec_md, which we
    // already have cached in `draftContent` (no extra fetch needed).
    // For a non-owner the server substitutes the newest SHARED version's
    // content as `spec` and filters the list, so "latest" reads as
    // "latest visible to you" (version numbers may be non-contiguous).
    const versions = DevChat.specViewer.versions; // DESC sorted
    const hasVersions = versions.length > 0;
    const latest = hasVersions ? versions[0] : null;
    const selectedVersion = DevChat._selectedSpecVersion();
    const isLatest = !!(selectedVersion && latest && selectedVersion.version === latest.version);

    // Latest content lives in draftContent (== spec_md); older versions
    // are lazily fetched into viewVersionContent.
    const displayContent = (isLatest || !hasVersions)
      ? DevChat.specViewer.draftContent
      : (DevChat.specViewer.viewVersionContent || '');

    const options = versions.map((v) => {
      // #1808: the year, once the version was not built this year. An
      // option label cannot carry a `title` and cannot elide to a bare time,
      // so it follows the shared rule's other half directly: the year is
      // dropped inside the current one and printed outside it. Spelled here
      // rather than imported for the reason above.
      const builtAt = v.built_at ? new Date(v.built_at) : null;
      const built = builtAt && !Number.isNaN(builtAt.getTime())
        ? builtAt.toLocaleString([], builtAt.getFullYear() === new Date().getFullYear()
          ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
          : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const isThisLatest = latest && v.version === latest.version;
      // The latest option carries the 'latest' value so re-selecting it
      // resumes following new versions; older options carry their number.
      return {
        value: isThisLatest ? 'latest' : String(v.version),
        label: `v${v.version}${isThisLatest ? ' (latest)' : ''}${built ? ` · ${built}` : ''}${v.pr_number ? ` · PR #${v.pr_number}` : ''}`,
      };
    });

    // The three header actions share one gate. `blank` is the disabled,
    // id-less placeholder: no version, or nothing in the one selected.
    // Both share routes are owner-scoped server-side, so for a non-owner
    // the buttons could only ever fail — they are absent instead.
    const isEmpty = !displayContent || !displayContent.trim();
    const blank = !selectedVersion || isEmpty;
    const groupShare = !isOwner
      ? { kind: 'absent' }
      : blank
        ? { kind: 'blank' }
        // Any version is shareable (#69 removed the draft/Save-version
        // step); once posted the button reads "Shared" and stops.
        : { kind: 'live', shared: !!selectedVersion.shared_to_group_at };
    // (#86) Private share: repeatable, and independent of the group-share
    // state — the owner can send it to several people one at a time.
    const userShare = !isOwner ? { kind: 'absent' } : blank ? { kind: 'blank' } : { kind: 'live' };
    // (#1012) Copy is not owner-gated: anyone who can read the panel can
    // copy what it shows.
    const copy = isEmpty ? { kind: 'blank' } : { kind: 'live' };

    // #196: a conforming spec (BOTH marker headings present — see
    // public/js/spec-sections.js) renders as two tabs so non-technical
    // readers land on the plain-language half. The preamble (title +
    // summary before the first marker) stays visible above the tabs.
    // A null split — legacy or non-conforming doc — renders the single
    // untabbed body exactly as before.
    const split = displayContent ? splitSpecSections(displayContent) : null;
    let body;
    if (DevChat.specViewer.isLoading && !displayContent) {
      body = { kind: 'loading' };
    } else if (!displayContent) {
      // Non-owners can't ask the AI in someone else's session, so their
      // empty state says what actually gates them: nothing shared yet.
      body = {
        kind: 'empty',
        copy: isOwner
          ? 'No spec yet. Ask the AI to draft one.'
          : 'No spec has been shared for this session yet.',
      };
    } else if (split) {
      const tab = DevChat.specViewer.activeTab === 'tech' ? 'tech' : 'user';
      const half = tab === 'tech' ? split.technical : split.userFacing;
      body = {
        kind: 'split',
        preambleHtml: split.preamble
          ? DevChat.renderMarkdown(split.preamble, { breaks: false })
          : '',
        tab,
        halfHtml: half ? DevChat.renderMarkdown(half, { breaks: false }) : '',
      };
    } else {
      body = { kind: 'plain', html: DevChat.renderMarkdown(displayContent, { breaks: false }) };
    }

    return {
      kind: 'open',
      versions: options,
      selected: selectedVersion ? (isLatest ? 'latest' : String(selectedVersion.version)) : '',
      version: selectedVersion ? selectedVersion.version : null,
      // #1012: the WHOLE selected version, raw — both halves and the marker
      // headings — so "Copy markdown" can never become the rendered half or
      // the active tab's slice.
      raw: displayContent,
      body,
      copy,
      userShare,
      groupShare,
      // Spec planning and building are two separate steps: drafting a spec
      // does NOT build anything. Make the handoff explicit so a finished
      // spec doesn't read as a finished change (there is no in-UI build
      // button — the user asks the Mayor in chat).
      buildHint: isOwner && isLatest && !isEmpty,
    };
  },

  /**
   * Six writers used to rebuild the pane; they all land here.
   *
   * The lazy frozen-version fetch sits AFTER the publish rather than inside
   * `_specViewerView`, which is the rule the transcript's conversion wrote
   * down: a loader a renderer calls per paint must not re-enter that
   * renderer. It terminates on the cache check — `_loadSpecVersion` fills
   * `viewVersionContent` and publishes once.
   */
  _publishSpecViewer() {
    const react = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.devChat : null;
    if (!react || !react.publishSpecViewer) return;
    react.publishSpecViewer(DevChat._specViewerView());

    if (!DevChat.specViewer.open || DevChat.specViewer.viewVersionContent) return;
    const versions = DevChat.specViewer.versions;
    if (!versions.length) return;
    const selected = DevChat._selectedSpecVersion();
    if (!selected || selected.version === versions[0].version) return;
    DevChat._loadSpecVersion(selected.version).catch(() => {});
  },

  // #196: tab switches are pure re-renders of cached content — no
  // refetch. The selection lives in specViewer.activeTab so it
  // survives version switches and spec_updated refreshes within the
  // panel's lifetime.
  _setSpecTab(tab) {
    const next = tab === 'tech' ? 'tech' : 'user';
    if (DevChat.specViewer.activeTab === next) return;
    DevChat.specViewer.activeTab = next;
    DevChat._publishSpecViewer();
  },

  // (#86) Mention candidates for the private-share popover — the same
  // endpoint the group chat's @mention autocomplete uses. Best-effort by
  // construction: an exact username still works without it, so every
  // failure resolves to an empty list rather than surfacing an error.
  async _loadSpecMentionSuggestions() {
    if (typeof AppView === 'undefined' || !AppView.appData || !AppView.appData.slug) return [];
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/mention-suggestions`);
      if (!res.ok) return [];
      const { users } = await res.json();
      return Array.isArray(users)
        ? users.map((u) => (u && u.username) || '').filter(Boolean)
        : [];
    } catch {
      return [];
    }
  },

  _switchSpecViewerVersion(value) {
    DevChat.specViewer.viewVersion = value === 'latest' ? 'latest' : value;
    DevChat.specViewer.viewVersionContent = null;
    DevChat._publishSpecViewer();
  },

  async _loadSpecVersion(version) {
    if (!DevChat.currentSession) return;
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!DevChat.currentSession || DevChat.currentSession.id !== sid) return;
      // Bail if the user picked another version while we were fetching.
      if (String(DevChat.specViewer.viewVersion) !== String(version)) return;
      DevChat.specViewer.viewVersionContent = data.spec.content || '';
      DevChat._publishSpecViewer();
    } catch (err) {
      console.warn('loadSpecVersion failed:', err);
    }
  },

  async _shareSpecVersion(version) {
    if (!DevChat.currentSession || version === 'draft' || version === 'latest' || version == null) return;
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}/share`, {
        method: 'POST',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Mark the version as shared locally so the button flips without
      // a full reload — the server's broadcast already handled the
      // group chat side.
      const v = DevChat.specViewer.versions.find((x) => x.version === Number(version));
      if (v) v.shared_to_group_at = new Date().toISOString();
      DevChat._publishSpecViewer();
    } catch (err) {
      console.warn('shareSpecVersion failed:', err);
    }
  },

  // POST the private share; returns the parsed response (or an {ok:false,
  // error} shape) so the popover can surface server-side 4xx messages
  // ("User not found", "That user doesn't have access…") inline.
  async _shareSpecToUser(version, username) {
    if (!DevChat.currentSession || version == null) return { ok: false, error: 'No session' };
    const sid = DevChat.currentSession.id;
    try {
      const resp = await fetch(`/api/sessions/${sid}/specs/${version}/share-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      let data = {};
      try { data = await resp.json(); } catch {}
      if (!resp.ok) return { ok: false, error: data.error || `HTTP ${resp.status}` };
      return data;
    } catch {
      return { ok: false, error: 'Network error' };
    }
  },
};

// #1038: repaint the per-app session list when live working state moves.
// Guarded on the list actually being mounted AND on no session being open
// (renderSessionList targets #dc-session-list, which only exists on the
// list view), so this costs nothing everywhere else.
if (typeof window !== 'undefined' && window.SessionState) {
  SessionState.subscribe(() => {
    if (DevChat.currentSession) return;
    if (!document.getElementById('dc-session-list')) return;
    DevChat.renderSessionList();
  });
}

// ── module bootstrap ────────────────────────────────────────────────
//
// #1084 chunk G: everything from here down used to run unconditionally, as
// the last thing the classic <script> did. It is now inside a `window` guard
// because the SSG prerender pass (frontend/scripts/build-shell.mjs) evaluates
// this module's graph in Node, where `localStorage`, `fetch` and
// `document.addEventListener` do not exist. The vm-based tests all provide
// both `window` and `document` — `window.addEventListener` below was already
// unguarded — so the guard changes nothing for them.
if (typeof window !== 'undefined') {
  // `const DevChat` no longer becomes a global on its own now that this is a
  // module, and roughly a dozen legacy modules read the bare `DevChat`. Kept
  // first in the block so the API exists before anything below can fail.
  window.DevChat = DevChat;

  DevChat._sanitizeStoredModel();
  // Fire-and-forget: refreshes MODELS from the server's allowlist. If
  // the page rendered the dropdown before this resolves, the next
  // renderChatView() pass will pick up the new entries.
  DevChat.loadModels();
}

// Combined away/return handler (#142, #161). On leaving (tab hidden or
// window blurred) while a turn is streaming, arm the server-side
// completion notification for the open session. On returning, clear any
// sticky completion title marker and — if the user is back on the
// dev-chat tab with the same turn still streaming — disarm the flag
// (they're watching again, so no notification needed). All three events
// matter: visibilitychange fires on browser-tab switches, window
// blur/focus on window-to-window switches where the tab stays
// "visible" the whole time.
DevChat._awayReturnHandler = () => {
  const away = DevChat._userIsAway();
  if (!away && DevChat._titleCompletion) DevChat.setCompletionTitle(null);
  if (DevChat.isStreaming && DevChat.currentSession) {
    if (away) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
    } else if (typeof App !== 'undefined' && (App.currentTab === 'dev' && App.currentSubTab === 'sessions')) {
      DevChat._setNotifyOnDone(DevChat.currentSession.id, false);
    }
  }
};
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', DevChat._awayReturnHandler);
  window.addEventListener('focus', DevChat._awayReturnHandler);
  window.addEventListener('blur', DevChat._awayReturnHandler);

  // Tab close / hard navigation while a turn is streaming: a normal fetch
  // may be killed mid-flight, so arm via sendBeacon (cookies ride along;
  // the endpoint parses the JSON blob body like any other request).
  window.addEventListener('pagehide', () => {
    if (!DevChat.isStreaming || !DevChat.currentSession) return;
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({ armed: true })], { type: 'application/json' });
        navigator.sendBeacon(`/api/sessions/${DevChat.currentSession.id}/notify-on-done`, blob);
      }
    } catch { /* best-effort */ }
  });
}
