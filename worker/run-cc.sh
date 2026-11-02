#!/bin/sh
# Per-exec Claude Code runner for the long-lived worker container.
#
# The worker container is bootstrapped once per session by `worker-run.sh`
# (clone + checkout + restore .claude.json + sleep infinity). Each turn
# the host invokes this script via `docker exec -e PROMPT_FILE=...
# -e MODE=build|scout <container> /usr/local/bin/run-cc.sh`. We do NOT
# re-clone — the workspace is reused across turns. Pre-exec hygiene
# (git fetch + reset --hard) gets us back to a known-good tree even
# if a prior turn left things dirty.
#
# Output contract is identical to the legacy single-shot worker-run.sh
# so the host's stream-json + USERNODE_* parser doesn't change:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N mode=… [sync_result=…]
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Required env (passed via -e on `docker exec`):
#   PROMPT_FILE, BRANCH, SESSION_ID, PLATFORM_URL
#   SYSTEM_PROMPT_FILE         required for build; authoritative platform
#                              handbook appended to Claude's system prompt
#   RESUME_FALLBACK_PROMPT_FILE optional for a resumed build; complete task
#                              prompt used only if --resume fails and this
#                              runner retries Claude without history
#
#   PROMPT_FILE points at the dispatch prompt the host materialized into
#   the CC volume before this exec (see worker.js writeTurnPrompt). The
#   prompt deliberately does NOT travel as an env value: Linux caps a
#   single argv/env string at 128 KiB, and build prompts (conventions +
#   spec doc) legitimately exceed it — passing them inline killed the
#   dispatch with E2BIG. It is piped to `claude` on stdin below for the
#   same reason.
# Optional env:
#   MODE                       build (default) | scout | sync
#   WORKER_JWT                 required for build/sync; absent for scout
#   MODEL                      default: claude-sonnet-5-5
#   COMMIT_MSG                 default: "Changes via Homeroom"
#   CLAUDE_RESUME_SESSION_ID   if set, passes `--resume <id>` to claude
#   AGENT_PROVIDER             anthropic (default) | openrouter (#3296). With
#                              openrouter, Claude Code runs a scout or build
#                              against OpenRouter through the worker-local
#                              claude-openrouter-request.js adapter, and needs
#                              OPENROUTER_API_KEY + AGENT_MODEL (MODEL is the
#                              same slug); OPENROUTER_API_BASE,
#                              AGENT_MODEL_MAX_OUTPUT_TOKENS,
#                              AGENT_MODEL_CONTEXT_WINDOW (sets the window
#                              Claude Code compacts at) and
#                              AGENT_REASONING_EFFORT are optional.
#   DISCARD_FAILED_TURN        1: a build whose claude failed commits and
#                              pushes nothing (the Homeroom bot's turns);
#                              needs TURN_JOURNAL to read the final result
#   STOP_GUARD                 1: a build installs build-stop-hook.js as a
#                              Claude Code Stop hook, which sends the agent
#                              back to work (twice at most) when it tries to
#                              end a turn that has changed nothing (the
#                              Homeroom bot's build and review-fix turns).
#                              The result line then carries stop_hook_blocks
#   STOP_GUARD_CHECKS          with STOP_GUARD: the platform's check command
#                              (worker.js writeAppCheck), which the hook runs
#                              when a turn that changed something tries to
#                              end, sending it back (twice at most) while a
#                              check dapp.json declares fails (L2). The result
#                              line then carries stop_hook_check_blocks.
#                              The hook also stops any server the agent left
#                              running in its workspace before the checks and
#                              the turn's end: stop_hook_servers_stopped,
#                              on the result line when it stopped any
#   STOP_GUARD_DEADLINE        when the platform stops the turn (epoch ms):
#                              the checks are not started with too little left
#   STOP_GUARD_REQUIRE_TESTS   1, with STOP_GUARD_CHECKS (a first version's
#                              build and review fixes): a dapp.json with a
#                              `checks` key or no routed `tests` sends the
#                              turn back too (build-stop-hook.js)
#   BUILD_PROFILE              first_version: a build of a project's first
#                              version (the Homeroom bot's build and review
#                              fixes) loads only the tools one uses: the
#                              browser without visible_changes, the Homeroom
#                              read tools narrowed to get_platform_conventions,
#                              and no WebSearch, WebFetch or NotebookEdit
#   LEAN_TURNS                 1: such a build under its configuration's
#                              lean_turns tweak also leaves out the delegation,
#                              planning and to-do tools and the browser tools
#                              a build never uses, and the request adapter
#                              cuts stale browser and shell output from what
#                              each model call re-sends
#
# MODE=sync (#8): merge origin/main and return the commit for publication.
#   1. git fetch origin
#   2. git reset --hard origin/$BRANCH (same hygiene as build)
#   3. git merge origin/main --no-edit
#      - clean → commit (already done by merge), push, sync_result=clean,
#        no CC invocation, no LLM spend
#      - conflict → leave conflict markers in working tree, invoke CC
#        with a resolution-only prompt, then sanity-check no markers
#        remain; commit + push if clean, abort if not
#         - resolved   = CC fixed it, push succeeded
#         - conflict   = CC failed; merge aborted, branch unchanged
#   Sync turns intentionally don't refresh CC's --resume session id —
#   they're a side-effect operation and shouldn't blow CC's main
#   conversation context.

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

# A container can restart after the platform's readiness read. Refuse to
# inspect or reset its Git checkout until this incarnation finishes bootstrap.
if [ "${USERNODE_WORKER_REQUIRE_READY:-0}" = "1" ] && [ ! -f /tmp/usernode-worker-ready ]; then
  die "worker bootstrap is not ready; retry after the worker finishes starting"
fi

: "${PROMPT_FILE:?PROMPT_FILE required}"
[ -s "$PROMPT_FILE" ] || die "prompt file missing or empty: $PROMPT_FILE"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${MODE:=build}"
: "${BRANCH:=}"
: "${WORKER_JWT:=}"
: "${MODEL:=claude-sonnet-5-5}"
: "${COMMIT_MSG:=Changes via Homeroom}"
: "${PAT:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"
: "${SYSTEM_PROMPT_FILE:=}"
: "${RESUME_FALLBACK_PROMPT_FILE:=}"
: "${BROWSER_MCP_CONFIG:=/home/node/.usernode-mcp.json}"
: "${BROWSER_ONLY_MCP_CONFIG:=/home/node/.usernode-mcp-browser.json}"
: "${BUILD_PROFILE:=}"
: "${SHOTS_JWT:=}"
: "${SHOTS_RUN_ID:=}"
: "${SHOTS_BASE_ORIGIN:=}"
: "${SHOTS_HEAD_ORIGIN:=}"
: "${SHOTS_MEMBER_TOKEN:=}"
: "${SHOTS_ADMIN_TOKEN:=}"
: "${SHOTS_FULL_ADMIN_TOKEN:=}"
# Optional: the guest browser is signed out, and carries a guest token only
# for a view-public child app (shots-origin-proxy.js).
: "${SHOTS_GUEST_TOKEN:=}"
# Optional: the invited fixtures' tokens (#4437), present only for a run
# whose declared changes name their personas, on the platform's own copies.
: "${SHOTS_INVITED_MEMBER_TOKEN:=}"
: "${SHOTS_INVITED_MEMBER_LISTED_TOKEN:=}"
: "${AGENT_PROVIDER:=anthropic}"

SYSTEM_PROMPT_FLAGS=""

# #3296: an OpenRouter turn run by Claude Code. Only the request adapter may
# hold the user's key, so take it out of this script's exported environment
# before anything else runs: git, the in-loop database, the commit and the
# push (and any hook the agent left behind) never see it. run_claude below
# hands it to the adapter alone.
OPENROUTER_TURN_KEY=""
if [ "$AGENT_PROVIDER" = "openrouter" ]; then
  if [ "$MODE" != "build" ] && [ "$MODE" != "scout" ]; then
    die "Claude over OpenRouter supports build and scout turns, not $MODE"
  fi
  [ -n "${OPENROUTER_API_KEY:-}" ] || die "OPENROUTER_API_KEY required for an OpenRouter turn"
  [ -n "${AGENT_MODEL:-}" ] || die "AGENT_MODEL required for an OpenRouter turn"
  OPENROUTER_TURN_KEY="$OPENROUTER_API_KEY"
  unset OPENROUTER_API_KEY
elif [ "$AGENT_PROVIDER" != "anthropic" ]; then
  die "unknown AGENT_PROVIDER: $AGENT_PROVIDER"
fi

run_claude() {
  if [ "$AGENT_PROVIDER" = "openrouter" ]; then
    OPENROUTER_API_KEY="$OPENROUTER_TURN_KEY" node "$(dirname "$0")/claude-openrouter-request.js" "$@"
  else
    claude "$@"
  fi
}

# Scout is deliberately read-only and receives no general worker token.
# Build/sync still require the token for their platform push callbacks.
if { [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; } && [ -z "$WORKER_JWT" ]; then
  die "WORKER_JWT required for $MODE mode"
fi
if [ "$MODE" = "scout" ] || [ "$MODE" = "shots" ]; then
  WORKER_JWT=""
fi
export WORKER_JWT
if [ "$MODE" = "shots" ]; then
  [ -n "$SHOTS_JWT" ] || die "SHOTS_JWT required for shots mode"
  [ -n "$SHOTS_RUN_ID" ] || die "SHOTS_RUN_ID required for shots mode"
fi

# Every hosted Anthropic build has a shortened task prompt and therefore
# requires the separate authoritative system context. Fail before invoking
# Claude if the host omitted it or failed to materialize it; there is no
# reduced-context fallback that could silently drop platform rules. An
# OpenRouter build may have none: the dev chat sends the handbook here for an
# OpenRouter model too (sessions.js openRouterBuildPrompts), but the Homeroom
# bot's builds work from the repository's own instructions alone.
if { [ "$MODE" = "build" ] || [ "$MODE" = "shots" ]; } && [ -z "$SYSTEM_PROMPT_FILE" ] \
    && [ "$AGENT_PROVIDER" != "openrouter" ]; then
  die "SYSTEM_PROMPT_FILE required for $MODE mode"
fi
if [ -n "$SYSTEM_PROMPT_FILE" ]; then
  [ -s "$SYSTEM_PROMPT_FILE" ] \
    || die "system prompt file missing or empty: $SYSTEM_PROMPT_FILE"
  SYSTEM_PROMPT_FLAGS="--append-system-prompt-file $SYSTEM_PROMPT_FILE"
fi
if [ -n "$RESUME_FALLBACK_PROMPT_FILE" ]; then
  [ "$MODE" = "build" ] \
    || die "RESUME_FALLBACK_PROMPT_FILE is only valid for build mode"
  [ -n "$CLAUDE_RESUME_SESSION_ID" ] \
    || die "RESUME_FALLBACK_PROMPT_FILE requires CLAUDE_RESUME_SESSION_ID"
  [ -s "$RESUME_FALLBACK_PROMPT_FILE" ] \
    || die "resume fallback prompt file missing or empty: $RESUME_FALLBACK_PROMPT_FILE"
fi

if [ "$MODE" = "shots" ]; then
  WORKSPACE_DIR=$(mktemp -d "/tmp/usernode-shots-agent-${SHOTS_RUN_ID}.XXXXXX") \
    || die "could not create shots workspace"
else
  WORKSPACE_DIR="${WORKSPACE_DIR:-/home/node/workspace}"
fi
cd "$WORKSPACE_DIR" || die "no workspace: $WORKSPACE_DIR"

# Re-assert the credential helper. The warm wrapper sets it up at
# bootstrap; this is defensive in case the .git/config was perturbed.
if [ -n "$PAT" ] && ! git config --get credential.helper >/dev/null 2>&1; then
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

# Session-branch integrity helpers (fetch scope, turn start, settling the
# session branch, the post-turn commit). See the file for why each exists.
# Sourced here, after the readiness and argument guards above, so a turn
# that must stop early never depends on it.
. "$(dirname "$0")/session-branch.sh"
# The container's memory, for the result line (mem_peak_mib and the rest).
. "$(dirname "$0")/memory-fields.sh"

# Pre-exec hygiene: every turn starts from a known-good tree. Pulls in
# anything pushed by a parallel turn / merge bot since we last ran, and
# discards any uncommitted state from a prior turn that didn't get
# committed (rare, but worth defending against). The fetch brings main and
# this session's branch only, and the turn starts ON the session branch
# whatever an earlier turn left checked out. A build or sync also drops the
# untracked files an earlier (for example stopped) turn left behind, so the
# commit step below only ever sees this turn's files; a read-only scout
# leaves them alone.
echo "__USERNODE_PHASE__ refresh"
if [ "$MODE" != "shots" ]; then
  if ! usernode_fetch_session_refs; then
    echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
  fi
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    if [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; then
      usernode_start_turn_on_session_branch clean_untracked || \
        echo "__USERNODE_WARN__ git reset failed"
    else
      usernode_start_turn_on_session_branch || \
        echo "__USERNODE_WARN__ git reset failed"
    fi
  elif [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; then
    # Branch missing upstream after PR merge → unrecoverable for build/sync.
    # Scout mode can still run against the local checkout, so we don't bail.
    die "branch missing upstream: origin/$BRANCH"
  fi
fi

# ── MODE=sync ─────────────────────────────────────────────────────────
# Merge origin/main into the current branch. Try clean merge first; if
# it conflicts, hand the conflicted tree to CC with a tight prompt.
# We deliberately do NOT pass --resume here — sync is bookkeeping, not
# part of the conversation history.
if [ "$MODE" = "sync" ]; then
  echo "__USERNODE_PHASE__ sync_fetch_main"
  git fetch origin main --quiet 2>&1 || \
    echo "__USERNODE_WARN__ fetch origin main failed"

  # Quick precheck — if we're already up to date, there's nothing to do
  # and we want to skip CC entirely. push_ok=0 because NOTHING was pushed
  # here — a hard-coded 1 masked "did an earlier push actually reach
  # GitHub?" during incident debugging (the local branch containing
  # origin/main says nothing about the remote's state).
  BEHIND_NOW=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  if [ "$BEHIND_NOW" = "0" ]; then
    AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
    SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
    echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=0 sha=$SHA push_ok=0 mode=sync sync_result=already_synced"
    exit 0
  fi

  # #361: comma-delimited list of files that conflicted on this sync.
  # Captured at conflict-detection time (below) and surfaced on every
  # __USERNODE_RESULT__ line so the platform can persist which files
  # conflicted — even on the resolved path, where the index is clean by
  # the time we emit. Empty for a clean merge.
  CONFLICT_FILES_CSV=""

  echo "__USERNODE_PHASE__ sync_merge"
  # `git merge origin/main` produces a merge commit on clean success
  # and leaves the tree dirty on conflict. We let it fail-non-zero
  # without `set -e` here on purpose.
  if git merge origin/main --no-edit -m "Merge origin/main via Homeroom sync" 2>&1; then
    # Clean merge → already committed by `git merge`.
    SYNC_RESULT="clean"
  else
    # Conflict path. Hand off to CC.
    echo "__USERNODE_PHASE__ sync_conflict_cc"
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    # Comma-delimited (no spaces) so it rides cleanly on the
    # space-delimited __USERNODE_RESULT__ key/value line.
    CONFLICT_FILES_CSV=$(git diff --name-only --diff-filter=U 2>/dev/null | paste -sd, - | sed 's/,$//')
    SYNC_PROMPT="A merge of origin/main into branch '$BRANCH' produced conflicts. The conflict markers (<<<<<<<, =======, >>>>>>>) are in the working tree.

Conflicted files: $CONFLICT_FILES

Resolve every conflict marker. Preserve the intent of both sides — keep the changes from main AND keep the work-in-progress on this branch. Do NOT add features or change behavior beyond what's needed to integrate cleanly. When done, every conflict marker must be gone from every file.

Do not run git commands. I will commit and push for you after you finish editing files."

    claude --print --dangerously-skip-permissions --verbose \
      --model "$MODEL" --output-format stream-json -p "$SYNC_PROMPT"
    CC_EXIT=$?

    # Sanity check: any conflict markers left? If yes, the merge is
    # not resolvable — abort cleanly so the next attempt starts from
    # a sane state. We deliberately only check for `<<<<<<<` and
    # `>>>>>>>` (not `=======`); `=======` on its own line is a
    # legitimate markdown setext h2 underline and would false-positive
    # any spec/README that uses that style.
    if grep -rlE --exclude-dir='.git' '^(<<<<<<<|>>>>>>>)( |$)' . 2>/dev/null | grep -q .; then
      echo "__USERNODE_WARN__ CC left conflict markers; aborting merge"
      git merge --abort 2>&1 || echo "__USERNODE_WARN__ merge --abort failed"
      AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
      SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi

    # CC resolved cleanly — stage everything (CC may have edited files
    # outside the conflict set as a side effect; we want them all in
    # the merge commit) and commit.
    git add -A
    if ! git commit -m "Merge origin/main via Homeroom sync (Claude-resolved)" 2>&1; then
      echo "__USERNODE_WARN__ commit failed after conflict resolution"
      git merge --abort 2>&1 || true
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=$BEHIND_NOW sha= push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi
    SYNC_RESULT="resolved"
  fi

  # Publication belongs to the conductor after this result is journalled.
  # Re-fetch so origin/main is fresh for the behind count below.
  git fetch origin main --quiet 2>/dev/null || true
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=0 mode=sync sync_result=$SYNC_RESULT conflict_files=$CONFLICT_FILES_CSV"
  exit 0
fi
# ── end MODE=sync ─────────────────────────────────────────────────────

# Scout permissions: previously `--permission-mode plan`, but plan mode
# blocks all write-flavoured Bash with a generic "Bash: error" — so the
# agent kept grinding through `git submodule update`, `gh api`, etc.,
# burning tokens on tools it didn't realise were denied. We now run
# scout with the same `--dangerously-skip-permissions` as build, but
# strip Edit/Write/NotebookEdit at the tool layer so file mutations are
# impossible regardless of what CC tries. The remaining safety nets:
#   - `git reset --hard origin/$BRANCH` at the top of every turn (above)
#     wipes any uncommitted/local commits the next turn would otherwise
#     inherit
#   - this script's MODE=scout branch (below) skips the commit/push
#     block entirely
#   - the conductor never publishes a scout result
#   - every scout callback credential is purpose-bound: ISSUES_JWT can only
#     read issues/attachments, ANTHROPIC_API_KEY can only reach the model
#     proxy, and PROD_DEBUG_JWT can only reach read-only diagnostics;
#     no worker:session token is minted under any alias
# Net effect: scout has full read-only Bash + WebFetch (so it can run
# `git submodule update --init`, `gh api`, etc.) but cannot escape the
# worker container even if CC misbehaves.
# A first version's build (BUILD_PROFILE=first_version, run four, 13 Oct
# 2026): every tool loaded is sent with every one of its model requests (52
# definitions on that build's 156), so the ones a brand-new app's build never
# uses are left out. Bash, Read, Edit, Write, Glob, Grep, Skill and the
# browser's tools stay: the in-loop browser guidance and the design skill use
# them.
FIRST_VERSION_BUILD=""
if [ "$MODE" = "build" ] && [ "$BUILD_PROFILE" = "first_version" ]; then
  FIRST_VERSION_BUILD=1
fi
if [ "$MODE" = "scout" ]; then
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools Edit Write NotebookEdit"
elif [ -n "$FIRST_VERSION_BUILD" ]; then
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools WebSearch WebFetch NotebookEdit"
  # Build speed (L7, lean_turns): every model call re-sends every tool's
  # definition. A first version's build has no use for a subagent, a plan
  # mode or a to-do list (each a model call of its own), nor for installing
  # a browser, uploading files, tabs or raw Playwright code.
  if [ "${LEAN_TURNS:-}" = "1" ]; then
    PERMISSION_FLAGS="$PERMISSION_FLAGS Task Agent TodoWrite ExitPlanMode mcp__playwright__browser_install mcp__playwright__browser_file_upload mcp__playwright__browser_tabs mcp__playwright__browser_run_code"
  fi
elif [ "$MODE" = "shots" ]; then
  # Shots turns operate only through platform-seeded MCP servers. Removing
  # every filesystem, shell, web and delegation tool prevents the model from
  # reading browser storage state or inherited process credentials. Each
  # persona's phone browser (browser_<persona>_phone, present only when a
  # declared screen is a phone's) is denied the same browser tools.
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools Bash Edit Write NotebookEdit Read Glob Grep WebFetch WebSearch Task Agent Skill TodoWrite mcp__browser_member__browser_evaluate mcp__browser_member__browser_run_code mcp__browser_member__browser_file_upload mcp__browser_member__browser_install mcp__browser_admin__browser_evaluate mcp__browser_admin__browser_run_code mcp__browser_admin__browser_file_upload mcp__browser_admin__browser_install mcp__browser_full_admin__browser_evaluate mcp__browser_full_admin__browser_run_code mcp__browser_full_admin__browser_file_upload mcp__browser_full_admin__browser_install mcp__browser_guest__browser_evaluate mcp__browser_guest__browser_run_code mcp__browser_guest__browser_file_upload mcp__browser_guest__browser_install mcp__browser_member_phone__browser_evaluate mcp__browser_member_phone__browser_run_code mcp__browser_member_phone__browser_file_upload mcp__browser_member_phone__browser_install mcp__browser_admin_phone__browser_evaluate mcp__browser_admin_phone__browser_run_code mcp__browser_admin_phone__browser_file_upload mcp__browser_admin_phone__browser_install mcp__browser_full_admin_phone__browser_evaluate mcp__browser_full_admin_phone__browser_run_code mcp__browser_full_admin_phone__browser_file_upload mcp__browser_full_admin_phone__browser_install mcp__browser_guest_phone__browser_evaluate mcp__browser_guest_phone__browser_run_code mcp__browser_guest_phone__browser_file_upload mcp__browser_guest_phone__browser_install mcp__browser_invited_member__browser_evaluate mcp__browser_invited_member__browser_run_code mcp__browser_invited_member__browser_file_upload mcp__browser_invited_member__browser_install mcp__browser_invited_member_phone__browser_evaluate mcp__browser_invited_member_phone__browser_run_code mcp__browser_invited_member_phone__browser_file_upload mcp__browser_invited_member_phone__browser_install mcp__browser_invited_member_listed__browser_evaluate mcp__browser_invited_member_listed__browser_run_code mcp__browser_invited_member_listed__browser_file_upload mcp__browser_invited_member_listed__browser_install mcp__browser_invited_member_listed_phone__browser_evaluate mcp__browser_invited_member_listed_phone__browser_run_code mcp__browser_invited_member_listed_phone__browser_file_upload mcp__browser_invited_member_listed_phone__browser_install"
else
  PERMISSION_FLAGS="--dangerously-skip-permissions"
fi

# Optional in-loop browser: expose the pinned Playwright MCP server so a
# BUILD turn CAN open the app it just edited in a headless browser to catch
# render/JS errors before committing (see app-conventions.md, worker-run.sh).
# `--strict-mcp-config` makes claude load ONLY this config — never a
# `.mcp.json` an untrusted repo might carry, which under
# --dangerously-skip-permissions would otherwise auto-start arbitrary
# servers. Scout (read-only) and sync (bookkeeping) get NO browser tooling:
# the flags stay empty, so their `claude` invocations are byte-for-byte as
# before. The MCP server only spawns on claude startup; Chromium launches
# lazily on the first browser tool call, so a build turn that never reaches
# for it pays nothing.
# A first version declares no visible changes (homeroom-bot-live.js
# buildPrompt): its build loads the browser alone, when the bootstrap wrote
# that config (worker-run.sh).
if [ -n "$FIRST_VERSION_BUILD" ] && [ -f "$BROWSER_ONLY_MCP_CONFIG" ]; then
  BROWSER_MCP_CONFIG="$BROWSER_ONLY_MCP_CONFIG"
fi
BROWSER_MCP_FLAGS=""
if [ "$MODE" = "build" ] && [ -f "$BROWSER_MCP_CONFIG" ]; then
  BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG --strict-mcp-config"
fi

# #2779: the coding agent's read-only Homeroom tools, for a build or scout
# turn the platform issued a grant to (HOMEROOM_MCP_TOKEN). The config names
# only the stdio bridge; the grant reaches it through this process's
# environment and is never written to a file. A build loads it beside the
# browser config; a scout loads it alone, so it stays browser-free. Still
# --strict-mcp-config either way.
HOMEROOM_MCP_CONFIG="${HOMEROOM_MCP_CONFIG:-/usr/local/share/usernode/homeroom-mcp.json}"
# A brand-new app has no requests, proposals or changes to read: a first
# version's bridge offers the platform conventions alone
# (homeroom-read-mcp.js HOMEROOM_READ_TOOLS), which its prompt and CLAUDE.md
# send it to instead of fetching the whole hosted copy.
if [ -n "$FIRST_VERSION_BUILD" ]; then
  HOMEROOM_READ_TOOLS=get_platform_conventions
  export HOMEROOM_READ_TOOLS
fi
if [ -n "${HOMEROOM_MCP_TOKEN:-}" ] && [ -f "$HOMEROOM_MCP_CONFIG" ]; then
  if [ "$MODE" = "build" ] && [ -n "$BROWSER_MCP_FLAGS" ]; then
    BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG $HOMEROOM_MCP_CONFIG --strict-mcp-config"
  elif [ "$MODE" = "build" ] || [ "$MODE" = "scout" ]; then
    BROWSER_MCP_FLAGS="--mcp-config $HOMEROOM_MCP_CONFIG --strict-mcp-config"
  fi
fi

# App bench run 193 (14 Oct 2026): a first version's build called
# browser_evaluate on a promise nothing settled (the kit's confirm dialog,
# waiting for a click) and the call held the turn for 1,800 s, Claude Code's
# own limit on one MCP tool call, before it failed. Every MCP call a build
# makes (the browser, Homeroom's read tools, visible changes) answers in
# seconds: none of the run's other browser calls took 20. Two minutes is past
# every limit Playwright sets itself (5 s an action, 60 s a navigation), so
# only a call that would never return reaches it, and it fails while the
# build still has time to go on. A Codex build's browser gets 60 s
# (run-codex-agent.sh). The shots agent records clips, and keeps Claude
# Code's own limit. A value already in the environment is kept.
if [ "$MODE" = "build" ]; then
  MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-120000}"
  export MCP_TOOL_TIMEOUT
fi

SHOTS_PROXY_PID=""
SHOTS_DIAGNOSTIC_TAIL_PID=""
SHOTS_TMP=""
cleanup_shots() {
  if [ -n "$SHOTS_PROXY_PID" ]; then kill "$SHOTS_PROXY_PID" 2>/dev/null || true; fi
  if [ -n "$SHOTS_DIAGNOSTIC_TAIL_PID" ]; then
    sleep 0.3
    kill "$SHOTS_DIAGNOSTIC_TAIL_PID" 2>/dev/null || true
  fi
  if [ -n "$SHOTS_TMP" ]; then rm -rf "$SHOTS_TMP" 2>/dev/null || true; fi
}
if [ "$MODE" = "shots" ]; then
  command -v mcp-server-playwright >/dev/null 2>&1 \
    || die "the shots browser MCP executable is missing"
  echo "__USERNODE_PHASE__ shots_proxy"
  SHOTS_TMP=$(mktemp -d "/tmp/usernode-shots-browser-${SHOTS_RUN_ID}.XXXXXX") \
    || die "could not create shots browser state"
  chmod 700 "$SHOTS_TMP"
  export SHOTS_BROWSER_STATE_DIR="$SHOTS_TMP/state"
  export SHOTS_HOSTED_ORIGINS_FILE="$SHOTS_BROWSER_STATE_DIR/hosted-origins.json"
  export SHOTS_BROWSER_DIAGNOSTIC_FILE="$SHOTS_TMP/browser-diagnostics.log"
  : > "$SHOTS_BROWSER_DIAGNOSTIC_FILE"
  # Each persona's browser saves the shots agent's named screenshots (and
  # clips, when a motion change is declared) here; the shots bridge reads
  # them back by name to publish them. A phone browser saves beside its
  # persona's, in <persona>_phone, which the config writer creates.
  export SHOTS_DIR="$SHOTS_TMP/shots"
  mkdir -p "$SHOTS_DIR/member" "$SHOTS_DIR/admin" "$SHOTS_DIR/full_admin" "$SHOTS_DIR/guest" \
    || die "could not create the shots directories"
  # The invited fixtures' browsers (#4437) save beside these, in their own
  # directory, when this run starts one.
  [ -z "$SHOTS_INVITED_MEMBER_TOKEN" ] || mkdir -p "$SHOTS_DIR/invited_member" \
    || die "could not create the shots directories"
  [ -z "$SHOTS_INVITED_MEMBER_LISTED_TOKEN" ] || mkdir -p "$SHOTS_DIR/invited_member_listed" \
    || die "could not create the shots directories"
  tail -n +1 -s 0.2 -f "$SHOTS_BROWSER_DIAGNOSTIC_FILE" &
  SHOTS_DIAGNOSTIC_TAIL_PID=$!
  export SHOTS_PROXY_PORT=17891
  export SHOTS_PROXY_SERVER="http://127.0.0.1:$SHOTS_PROXY_PORT"
  # One proxy listener per fixture persona, so a hosted app's pages carry
  # that persona's identity on every load (shots-origin-proxy.js). The
  # guest's listener adds the guest token when there is one, and nothing
  # otherwise. The bootstrap and the control plane keep the shared port above.
  export SHOTS_PROXY_PERSONA_PORTS='{"member":17892,"read_only_admin":17893,"full_admin":17894,"guest":17895}'
  export SHOTS_PROXY_CONTROL_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  # The shots bridge's upload_file asks a browser's observer to choose a
  # sample file (shots-samples.js) over a socket here, with its own token:
  # the agent's browser_file_upload stays denied below.
  export SHOTS_BROWSER_CONTROL_DIR="$SHOTS_TMP/ctl"
  export SHOTS_BROWSER_CONTROL_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  mkdir -m 700 "$SHOTS_BROWSER_CONTROL_DIR" || die "could not create the shots browser control directory"
  export SHOTS_PROXY_READY="$SHOTS_TMP/proxy.ready"
  export SHOTS_ALLOWED_ORIGINS="[\"$SHOTS_BASE_ORIGIN\",\"$SHOTS_HEAD_ORIGIN\"]"
  # The proxy also samples the worker's memory every 5 seconds into the
  # shots trace (shots-memory.js), so a turn that dies says whether memory
  # ran out.
  export SHOTS_MEMORY_SAMPLE_MS=5000
  node /usr/local/bin/shots-origin-proxy.js &
  SHOTS_PROXY_PID=$!
  trap cleanup_shots EXIT INT TERM
  i=0
  while [ ! -f "$SHOTS_PROXY_READY" ] && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.05; done
  [ -f "$SHOTS_PROXY_READY" ] || die "shots origin proxy failed to start"
  echo "__USERNODE_PHASE__ shots_browser_bootstrap"
  # On failure the bootstrap writes one credential-free line naming the
  # persona, side, stage and cause; it becomes the run's failure reason.
  export SHOTS_BOOTSTRAP_FAILURE_FILE="$SHOTS_TMP/browser-bootstrap.failure"
  node /usr/local/bin/shots-browser-bootstrap.js \
    || die "$(head -c 300 "$SHOTS_BOOTSTRAP_FAILURE_FILE" 2>/dev/null | tr -d '\r\n' | grep . || echo 'shots browser authentication failed')"
  unset SHOTS_MEMBER_TOKEN SHOTS_ADMIN_TOKEN SHOTS_FULL_ADMIN_TOKEN SHOTS_GUEST_TOKEN \
    SHOTS_INVITED_MEMBER_TOKEN SHOTS_INVITED_MEMBER_LISTED_TOKEN
  BROWSER_MCP_CONFIG="$SHOTS_TMP/mcp.json"
  node /usr/local/bin/write-shots-mcp-config.js "$BROWSER_MCP_CONFIG" \
    || die "could not create shots MCP config"
  echo "__USERNODE_PHASE__ shots_mcp_ready"
  BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG --strict-mcp-config"
fi

# ── In-loop local Postgres (build turns only) ────────────────────────
# Keep this identical to Codex/OpenRouter build turns. The helper emits
# warnings and lets the turn continue if the optional local DB is unavailable.
if [ "$MODE" = "build" ]; then
  sh "$(dirname "$0")/start-inloop-db.sh" \
    || echo "__USERNODE_WARN__ in-loop postgres setup failed"
fi

# What HEAD was when the agent started, so the commit step can tell whether
# the agent committed its own work this turn.
TURN_START_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

# The stop guard (STOP_GUARD=1, build turns only): a Claude Code Stop hook,
# build-stop-hook.js, installed through --settings for this invocation alone.
# When the agent tries to end its turn while HEAD is still TURN_START_SHA and
# the working tree is clean, it sends the agent back to work, at most twice.
# It counts its blocks in a file of this turn's own, which the result line
# below reports. Anything that goes wrong here leaves the turn without the
# hook, exactly as it ran before, rather than failing it.
STOP_GUARD_FLAGS=""
STOP_GUARD_DIR=""
# The checks gate (STOP_GUARD_CHECKS, L2): the same hook, with a timeout long
# enough to boot the app and run its declared checks, when the platform wrote
# its check command for this turn.
STOP_GUARD_CHECKS_ON=""
if [ -n "${STOP_GUARD_CHECKS:-}" ] && [ -f "$STOP_GUARD_CHECKS" ]; then STOP_GUARD_CHECKS_ON=1; fi
if [ "$MODE" = "build" ] && [ "${STOP_GUARD:-}" = "1" ]; then
  if [ -n "$TURN_START_SHA" ] \
      && STOP_GUARD_DIR=$(mktemp -d /tmp/usernode-stop-guard.XXXXXX 2>/dev/null) \
      && node "$(dirname "$0")/build-stop-hook.js" --settings ${STOP_GUARD_CHECKS_ON:+--checks} > "$STOP_GUARD_DIR/settings.json" 2>/dev/null \
      && [ -s "$STOP_GUARD_DIR/settings.json" ]; then
    USERNODE_STOP_GUARD_START="$TURN_START_SHA"
    USERNODE_STOP_GUARD_COUNT="$STOP_GUARD_DIR/blocks"
    USERNODE_STOP_GUARD_REPO=$(pwd)
    # The servers it stopped because the agent left them running (the hook's
    # header, LEFTOVER SERVERS), counted for the result line.
    USERNODE_STOP_GUARD_SERVERS="$STOP_GUARD_DIR/servers"
    export USERNODE_STOP_GUARD_START USERNODE_STOP_GUARD_COUNT USERNODE_STOP_GUARD_REPO USERNODE_STOP_GUARD_SERVERS
    # The notes a person sends this build while it runs (the hook's header,
    # NOTES FROM THE PERSON), asked for at each stop with this turn's token.
    if [ -n "$WORKER_JWT" ]; then
      USERNODE_STOP_GUARD_NOTES="${PLATFORM_URL%/}/api/internal/sessions/${SESSION_ID}/build-notes/take"
      USERNODE_STOP_GUARD_NOTES_COUNT="$STOP_GUARD_DIR/notes"
      export USERNODE_STOP_GUARD_NOTES USERNODE_STOP_GUARD_NOTES_COUNT
    fi
    if [ -n "$STOP_GUARD_CHECKS_ON" ]; then
      USERNODE_STOP_GUARD_CHECKS="$STOP_GUARD_CHECKS"
      USERNODE_STOP_GUARD_CHECKS_COUNT="$STOP_GUARD_DIR/checks"
      USERNODE_STOP_GUARD_CHECKS_PASSED="$STOP_GUARD_DIR/checks-passed"
      USERNODE_STOP_GUARD_DEADLINE="${STOP_GUARD_DEADLINE:-}"
      USERNODE_STOP_GUARD_REQUIRE_TESTS="${STOP_GUARD_REQUIRE_TESTS:-}"
      export USERNODE_STOP_GUARD_CHECKS USERNODE_STOP_GUARD_CHECKS_COUNT USERNODE_STOP_GUARD_CHECKS_PASSED USERNODE_STOP_GUARD_DEADLINE
      export USERNODE_STOP_GUARD_REQUIRE_TESTS
    fi
    STOP_GUARD_FLAGS="--settings $STOP_GUARD_DIR/settings.json"
  else
    echo "__USERNODE_WARN__ the stop guard could not be set up; this build runs without it"
  fi
fi

# stream-json emits one JSON object per line. The host parses this via
# the docker-exec child's stdout (long-lived path) or `docker logs -f`
# (legacy single-shot path) — same pipeline, different transport.
# The prompt is piped on stdin (`--print` reads it there) instead of an
# inline `-p` argument: a single argv string is capped at 128 KiB in this
# container too, so passing the file's contents as an argument would just
# move the host-side E2BIG failure here.
if [ -n "$CLAUDE_RESUME_SESSION_ID" ]; then
  echo "__USERNODE_PHASE__ claude (resume $CLAUDE_RESUME_SESSION_ID, mode $MODE)"
  run_claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose $STOP_GUARD_FLAGS \
    --resume "$CLAUDE_RESUME_SESSION_ID" \
    --model "$MODEL" --include-partial-messages --output-format stream-json < "$PROMPT_FILE"
  CC_EXIT=$?
  if [ "$CC_EXIT" -ne 0 ]; then
    echo "__USERNODE_WARN__ resume failed (exit $CC_EXIT); retrying fresh"
    RETRY_PROMPT_FILE="$PROMPT_FILE"
    if [ -n "$RESUME_FALLBACK_PROMPT_FILE" ]; then
      RETRY_PROMPT_FILE="$RESUME_FALLBACK_PROMPT_FILE"
    fi
    run_claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose $STOP_GUARD_FLAGS \
      --model "$MODEL" --include-partial-messages --output-format stream-json < "$RETRY_PROMPT_FILE"
    CC_EXIT=$?
  fi
else
  echo "__USERNODE_PHASE__ claude (mode $MODE)"
  run_claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose $STOP_GUARD_FLAGS \
    --model "$MODEL" --include-partial-messages --output-format stream-json < "$PROMPT_FILE"
  CC_EXIT=$?
fi

# How many times the stop guard sent the agent back, for the turn's telemetry
# (worker.js parseLine → telemetry_metrics.stop_hook_blocks) and, when it did,
# the progress log. Only a turn that had the guard reports the field.
STOP_HOOK_BLOCKS_FIELD=""
if [ -n "$STOP_GUARD_FLAGS" ]; then
  STOP_HOOK_BLOCKS=$(cat "$USERNODE_STOP_GUARD_COUNT" 2>/dev/null || echo 0)
  case "$STOP_HOOK_BLOCKS" in ''|*[!0-9]*) STOP_HOOK_BLOCKS=0 ;; esac
  STOP_HOOK_BLOCKS_FIELD=" stop_hook_blocks=$STOP_HOOK_BLOCKS"
  if [ "$STOP_HOOK_BLOCKS" -gt 0 ]; then
    echo "__USERNODE_WARN__ The agent tried to end its turn having changed nothing; the stop guard sent it back to work (stop_hook_blocks=$STOP_HOOK_BLOCKS)"
  fi
  if [ -n "$STOP_GUARD_CHECKS_ON" ]; then
    STOP_HOOK_CHECK_BLOCKS=$(cat "$USERNODE_STOP_GUARD_CHECKS_COUNT" 2>/dev/null || echo 0)
    case "$STOP_HOOK_CHECK_BLOCKS" in ''|*[!0-9]*) STOP_HOOK_CHECK_BLOCKS=0 ;; esac
    STOP_HOOK_BLOCKS_FIELD="$STOP_HOOK_BLOCKS_FIELD stop_hook_check_blocks=$STOP_HOOK_CHECK_BLOCKS"
    if [ "$STOP_HOOK_CHECK_BLOCKS" -gt 0 ]; then
      echo "__USERNODE_WARN__ The app's declared checks failed when the agent tried to end its turn; the checks gate sent it back to fix them (stop_hook_check_blocks=$STOP_HOOK_CHECK_BLOCKS)"
    fi
  fi
  # Servers the agent left running that the hook stopped (only when there
  # were some, so a turn's line reads as before otherwise).
  STOP_HOOK_SERVERS=$(cat "$USERNODE_STOP_GUARD_SERVERS" 2>/dev/null || echo 0)
  case "$STOP_HOOK_SERVERS" in ''|*[!0-9]*) STOP_HOOK_SERVERS=0 ;; esac
  if [ "$STOP_HOOK_SERVERS" -gt 0 ]; then
    STOP_HOOK_BLOCKS_FIELD="$STOP_HOOK_BLOCKS_FIELD stop_hook_servers_stopped=$STOP_HOOK_SERVERS"
    echo "__USERNODE_WARN__ The agent left servers running in its workspace; the stop guard stopped them as the turn ended (stop_hook_servers_stopped=$STOP_HOOK_SERVERS)"
  fi
fi
if [ -n "$STOP_GUARD_DIR" ]; then rm -rf "$STOP_GUARD_DIR" 2>/dev/null || true; fi

# Read once the agent is done: the most the container used by then.
MEMORY_FIELDS=$(usernode_memory_fields)

if [ "$MODE" = "scout" ] || [ "$MODE" = "shots" ]; then
  # Read-only run: no commit, no push. The host pulls scout output out
  # of stream-json's `result` event and writes it into spec_md.
  # behind=0 because scout never modifies the tree; the real number
  # gets refreshed by the next build/sync turn.
  # Terminal phase marker so the progress card ends on "Finished"
  # instead of freezing on the last action line.
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE$MEMORY_FIELDS"
  exit "$CC_EXIT"
fi

# A failed turn's work is neither committed nor pushed when the platform asks
# (DISCARD_FAILED_TURN=1: the Homeroom bot's OpenRouter builds, whose push is
# what the bot proposes, or a revision of a proposal already up for a vote),
# exactly as run-codex-agent.sh treats every failed turn. Failed is claude
# exiting non-zero, or, read from this turn's journal, its final result
# reporting an error or ending on the runtime's own "API Error" notice, which
# Claude Code can exit 0 after (agent-api-failure.js: the definition the
# platform judges the turn by). Otherwise a failed turn's work is kept, which
# a person's dev chat wants. The next turn starts from the session branch as
# GitHub has it, so nothing discarded here survives it.
if [ "${DISCARD_FAILED_TURN:-}" = "1" ]; then
  TURN_FAILED=""
  if [ "$CC_EXIT" -ne 0 ]; then
    TURN_FAILED="claude exited non-zero ($CC_EXIT)"
  elif [ -n "${TURN_JOURNAL:-}" ] && [ -f "$TURN_JOURNAL" ]; then
    TURN_FAILED=$(node "$(dirname "$0")/agent-api-failure.js" "$TURN_JOURNAL" 2>/dev/null || true)
  fi
  if [ -n "$TURN_FAILED" ]; then
    echo "__USERNODE_WARN__ $TURN_FAILED; skipping commit/push"
    echo "__USERNODE_PHASE__ done"
    echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=0 sha= push_ok=0 mode=build$STOP_HOOK_BLOCKS_FIELD$MEMORY_FIELDS"
    if [ "$CC_EXIT" -ne 0 ]; then exit "$CC_EXIT"; fi
    exit 1
  fi
fi

# The platform-side push proxy pushes the session's own branch, never the
# worker's HEAD. So work the agent committed on a branch of its own is
# brought onto the session branch first; work on a line that does not build
# on it (another member's branch) is neither committed nor pushed, and the
# turn reports no changes with branch_mismatch=1 rather than a commit that
# can never reach GitHub.
echo "__USERNODE_PHASE__ commit"
if usernode_settle_session_branch; then
  usernode_commit_leftovers "$TURN_START_SHA" "$COMMIT_MSG"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
# #8: how many commits this branch is behind origin/main. Drives the
# dev-chat "Sync with main" banner and the merge-time block.
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
BRANCH_MISMATCH_FIELD=""
if [ -n "$USERNODE_BRANCH_MISMATCH" ]; then
  AHEAD=0
  SHA=""
  BRANCH_MISMATCH_FIELD=" branch_mismatch=1"
fi

# The conductor appends the terminal progress phase after publication.
echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=0 mode=build$BRANCH_MISMATCH_FIELD$STOP_HOOK_BLOCKS_FIELD$MEMORY_FIELDS"
exit "$CC_EXIT"
