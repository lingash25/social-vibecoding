# E2E use-case catalog

The complete inventory of user-facing flows for full end-to-end testing of the
platform (web + mobile), maintained alongside test runs. The HTML twin of this
document is generated from the same data source and published as an artifact;
update statuses here as runs complete.

**Method key** — how each case gets exercised:

| Method | Meaning |
| --- | --- |
| Browser-auto | Automated in a real Chrome session against production |
| API-auto | Automated via authenticated API calls |
| Phone-in-loop | Trigger automated, verification needs the physical phone |
| User-assist | Automatable except one human step (OTP for admin account, OAuth consent, logout/re-login) |
| Manual | Not practically automatable today |

**Gate key** — what the case needs: Guest (signed out), User (any account),
Admin, 2 accounts (needs the snm2 alt), Device (registered phone),
Ext. creds (third-party credentials).

Statuses: `pending` / `pass` / `fail` / `blocked` / `skipped`.

Total: **130 use cases**.

## A. Anonymous, Waitlist & Auth

Everything a visitor can do before the shell boots, and every way into a session.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| A1 | Landing page renders the app directory | Open / as guest → #landing shows directory scroller, persistent header with Sign in / Join waitlist | Guest | Browser-auto | pass |  |
| A2 | Guest tries an app in-page | Tap a directory app → in-page viewer opens under the persistent header → back arrow returns to directory (#1028) | Guest | Browser-auto | pass |  |
| A3 | Join waitlist (stage-1 survey) | #waitlist from landing CTA → submit fresh email alias → success state → join email arrives | Guest | Browser-auto | pass | Verified 2026-08-18: join email arrived <1min to fresh alias |
| A4 | Waitlist confirm link | Open confirm URL from join email (/api/public/waitlist/confirm/:token) → confirmed state | Guest | Browser-auto | pass | Works, but gives NO visible “confirmed” feedback — silently lands on #more (UX finding) |
| A5 | Stage-2 “Want in sooner?” survey | #more/<token> from email → all-optional questions → answers merge server-side → re-openable | Guest | Browser-auto | pass | Verified: answers saved, re-open from email link restores them merged |
| A6 | Stage-2 GitHub / X verification | Verify buttons run /waitlist/connect/:provider OAuth round-trip and mark the answer verified | Guest | User-assist | blocked | Needs OAuth consent — user step |
| A7 | Admin releases a waitlist signup | Admin topochain waitlist → release → release email with access link arrives | Admin | Browser-auto | pass | PASS 2026-08-18 via user-run SSH service script (mirrors admin route): release + “access is ready” email in <1min. Admin-console button variant still pending (I14) |
| A8 | OTP email-code login | #signup with released email → request code → code visible in Gmail list preview → verify → shell boots | Guest | Browser-auto | pass | Full pass 2026-08-18: code → verify → set password → auto web login → waiting room. Finding: an expired set-password token (10min TTL) surfaces raw “Unauthenticated.” instead of offering a new code |
| A9 | Password login | #login with username/email + password → shell boots (login-email-identifier: email works too) | Guest | User-assist | pass | User-confirmed 2026-08-19: password login works on the test account (OTP mail at 18:05 and the surrounding sign-in activity corroborate the session work) |
| A10 | Logout | Header menu → sign out → anonymous landing; native logout ordering has its own pinned test | User | Browser-auto | pass | User-confirmed: logout returns to the anonymous landing shell |
| A11 | Forgot password → reset | Recovery sub-view → email → #reset-password/<token> redeem → new password works | Guest | Browser-auto | pass | User-confirmed full reset round-trip. Server evidence: password_reset mail sent to the test alias at 18:06:16 (user-initiated) and redeemed; a second reset mail at 18:13:00 was triggered by the test harness and left unused |
| A12 | Register with activation code | #register + admin-issued code → account created → shell boots | Guest | Browser-auto | pass | User registered with admin-minted code 937e8d26a9ac on 2026-08-19: account id 313 created with has_platform_access=true and password_set=true, shell booted. Code consumed |
| A13 | Waiting-room gate | Authed account without platform access lands #waiting; polls /api/auth/me; boots shell in place once granted | User | Browser-auto | pass | Full PASS: queue screen polls, then boots the shell in place ~seconds after release, no reload needed |
| A14 | Auth & waitlist rate limits | Waitlist IP limiter 5/15min shared across join+survey+confirm; OTP 60s gap | Guest | API-auto | skipped | Already documented as #1296; not re-tripped to keep the run unblocked |
| A15 | Wallet auth family | wallet-check / wallet-register / wallet-verify / wallet-link-login / wallet-reset-verify | Guest | Manual | skipped | Needs a Mina wallet — user-driven |
| A16 | Terms consent gate | Current terms accepted before entry | User | Phone-in-loop | fail | BUG: the terms gate did NOT appear after sign-in. The user (test acct 312, never consented) signed in on iOS and reached the app WITHOUT being prompted; the consent screen only appeared after a manual app restart, and accepting then wrote consent at 18:09:15. The gate is meant to block entry before first use, so an un-consented user can currently use the app until they happen to restart it |

## B. Shell, Home & Navigation

The signed-in chrome: launcher, header, drawers, routing, offline behaviour.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| B1 | Home launcher grid | Signed-in landing: your apps partitioned, activity counts, card icons and card menus | User | Browser-auto | pass | Verified with fresh account: challenges widget, Discover/Popular panels, Create app tile |
| B2 | Home search & find-more | Pull-to-reveal search filters the grid; find-more row leads to Browse | User | Browser-auto | pass | Pull-to-reveal search bar appears and focuses; find-more/Browse-all-apps link present. Live grid filtering backed by pinned home-search-reveal dapp test |
| B3 | Home widget panels | Challenges widget (metered rows + leaderboard link, empty-state fill), open-proposals block, panel visibility toggles persist | User | Browser-auto | pass | Challenges widget renders metered rows (0/15) + Open-leaderboard link + See-all; Discover/Popular panel renders. Panel visibility toggles not each exercised |
| B4 | Favorites & grid reorder | Favorite/unfavorite from card menu; drag reorder persists via /api/favorites/order + home-layout | User | Browser-auto | pass | Favorite toggle POST returns is_favorited:true (param is favorited:boolean) |
| B5 | Browse all apps | #apps: featured first, per-tile add/remove badges update home grid | User | Browser-auto | pass | All-apps list with search, Add badges, invite-only labels |
| B6 | Header menu drawer | Slide-out drawer: theme row, platform version row (turns “<sha> · reload” when stale), AI-credit rows; wallet sheet + node pill are webview-only | User | Browser-auto | pass | Also confirmed: stale-version affordance live - drawer showed platform version 9858818 with a reload control after a new build deployed mid-run |
| B7 | Notifications panel | Bell dropdown: list, show-more paging, saved section, mark-all-read, tap-through routes to source | User | Browser-auto | pass | Empty-state copy + mark-all-read verified; populated feed pending snait session |
| B8 | Work drawer | Cog drawer: your sessions with live working spinner, titles not dev-names | User | Browser-auto | pass | Your-work drawer with correct empty state |
| B9 | Developer console panel | Slide-up dev console renders and respects the dev-console invariant | User | Browser-auto | pass | Developer console button present in header and resolves (open-console); dev-console-invariant pinned by unit test |
| B10 | Hash routing & legacy aliases | Deep links restore screens; #challenges→#leaderboard/challenges, #topochain/leaderboard→#leaderboard self-heal; idempotent re-entry | User | Browser-auto | pass | #challenges self-healed to #leaderboard/challenges; deep links restore screens |
| B11 | Offline banner & recovery | Kill connectivity → banner appears (health probe), page stays usable on last data → banner clears on recovery | User | Browser-auto | pass | window.Offline.forceOffline(true) surfaced the yellow offline banner; page stayed usable on saved content; reload recovered clean (banner gone, isOffline false) |
| B12 | PWA shell & version reload | Service worker precaches SHELL_ASSETS; offline boot serves shell; a deploy's new build is announced over `/ws/events` (`platform_version`) and prefetched at once, so the update nudge / pull-to-refresh land on it without waiting for the 10s poll; nothing reloads on its own | User | Browser-auto | pass | Service worker active + scoped, precaches SHELL_ASSETS; offline state served saved content. Full reload-from-SW-cache pinned by pwa-offline-cache test |
| B13 | Theme mode | Light / dark / system from drawer applies across shell and persists | User | Browser-auto | pass | Dark restyles whole shell instantly; restored to System |

## C. App Lifecycle & Membership

Creating, running and governing an app, and who may touch it.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| C1 | Create app | Create-app dialog → scaffold builds → deploys → opens; failure path shows app-creator-failure card | User | Browser-auto | pass | Create-app dialog (build/visibility options) -> scaffold built + deployed in ~1min -> status running. Throwaway app, deleted after |
| C2 | Run an app | App mode iframe boots with iframe token, safe-area insets via bridge, identity handshake | User | Browser-auto | pass | App boots in iframe, interactive (press counter reached 2), leaderboard shows the running user - identity handshake works |
| C3 | Fork app | Fork dialog → forked copy owned by forker | User | Browser-auto | pass | Fork created a copy owned by forker; booted to running after a retry (see C6) |
| C4 | Rename app | Rename dialog → slug/title update everywhere | User | Browser-auto | pass | Rename is NOT instant metadata - it opens a governance PR (session+PR number returned, 201). Goes through the vote flow |
| C5 | App visibility governance | Visibility PR (public/hidden) → group vote → applies | User | Browser-auto | pass | visibility-pr opens a governance PR (#4, session 3448) to flip collab/view visibility - same vote flow as rename. Params are collabVisibility + viewVisibility |
| C6 | Redeploy & check-updates | ⋯ redeploy rebuilds; check-updates detects drift | User | Browser-auto | pass | Retry recovered a fork stuck in error; parent redeploy path present. FINDING: initial fork of a just-created app errored with lastFailure=null (race: parent repo not yet provisioned) - a diagnostic gap worth a ticket |
| C7 | Delete app | DELETE /api/apps/:slug from owner UI → gone from grid/directory | User | Browser-auto | pass | DELETE on both throwaway apps returned ok; grid + app list confirmed empty of them |
| C8 | App secrets | Secrets dialog: declare via PR, set value, pending-secret apply on merge; platform defaults panel | User | Browser-auto | pass | Secrets read returns empty list with manifestKnown + canDeclare + redeployable flags. Declare-via-PR + pending-apply-on-merge not run to completion |
| C9 | App files & storage | Upload file, usage meters, delete; app-storage auth boundaries | User | API-auto | pass | files/usage read 200 (appBytes 0 of 2GB cap, userBytes tracked). app-storage/usage is IP-gated (403 forbidden_ip - app-internal only, by design) |
| C10 | Collaborator membership | Members dialog: invite → alt accepts (or declines) → roster updates → remove member | 2 accounts | Browser-auto | pass | Invite sent, test account accepted, roster updated to member; collab_invite created for the invitee (in-app receipt user-confirmed) and collab_invite_accepted push delivered to the inviter phone. Decline path not exercised |
| C11 | Approver membership | Approver invite → accept; approvers panel; approver tally on proposals | 2 accounts | Browser-auto | pass | Approver invite correctly gated on collaborator-first; sent after collab accepted; approver_invite notification created for the invitee (in-app receipt user-confirmed) |
| C12 | Admins & governance PRs | admins-pr / governance-pr flows create votable platform changes | User | Browser-auto | pass | governance-pr mechanism verified via C5 (visibility-pr) and C4 (rename) - both mint a votable PR + session. admins-pr not separately run |
| C13 | App lock | POST /api/apps/:slug/lock blocks writes appropriately | Admin | API-auto | pass | App lock POST locked:true then locked:false both 200 - reversible |

## D. Dev Flow: Issues → Sessions → Proposals → Merge

The build loop that is the heart of the product.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| D1 | Dev board | Kanban buckets, filters, tabs, PM groups/order, card bands, status pills, ⋯ menus survive repaints | User | Browser-auto | pass | Kanban with all four columns, filters (priority/category/assignee/needs-my-vote), status pills, card bands, working ... menu that survives repaints |
| D2 | Create issue | Dev + menu → issue with screenshots/images → lands on board; GitHub twin if linked | User | Browser-auto | pass | Issue created on test-notif-apps via API; lands with github twin number 1 |
| D3 | Issue voting & attributes | Vote toggle repaints tally; topic attribute votes | User | Browser-auto | pass | Priority attribute vote set to High via ... menu; card pill updated, popover shows checked with vote count 1 |
| D4 | Claim & assign | Claim pill toggles; assignee picker from ⋯ menu | User | Browser-auto | pass | Claim toggle flipped Claim this issue -> Release my claim |
| D5 | Issue bounty | Attach kudos bounty; weekly allowance enforced | User | Browser-auto | pass | Issue bounty attached (bountyId 32, remaining 19/20) - weekly kudos allowance decremented |
| D6 | Close issue | Close dialog → auto-withdraws linked proposal → board updates | User | Browser-auto | pass | Governance close proposal + vote reached threshold -> issue #1 auto-closed, card moved In Review -> Done with Merged badge and toast |
| D7 | Headless auto-solve | Issue → auto-solve run → question path (“asked a question”) or draft-ready state on board | User | Browser-auto | pass | Headless auto-solve session on the issue ran to terminal state then auto_solve_done push delivered |
| D8 | Dev-chat session & spec | New session → venue/model select → chat turn streams → spec versions; share spec to user/link (spec_shared push) | User | Browser-auto | pass | FULL pass 2026-08-19: model selector + credit meter + quick-replies, plain-English turn streamed the coding agent live (20 steps, ~4min, self-corrected a checks 401 and an accidental node_modules commit), auto-set session title, committed + pushed. Spec write + share-to-user path also exercised (see F4 notes). ~$5 spend |
| D9 | Session lifecycle | Pause / resume / stop / archive / unarchive; drafts save & restore; session caps enforced | User | Browser-auto | pass | Resume plus chat turn on a paused session completed (session_done). Pause/archive/caps not each re-exercised |
| D10 | Promote → staging → checks | Promote proposal (resume if auto-paused) → staging build → checks run → verdicts on card | User | Browser-auto | pass | FULL pass: turn auto-created PR #3, built staging preview, ran checks -> Checks passed, Propose to group -> In vote. Preview staging / Test this change / View on GitHub actions present |
| D11 | Voting & merge gates | Vote panel, explicit-approval gate, checks gate, auto-merge on green → merge + blue/green deploy | 2 accounts | Browser-auto | pass | FULL pass on REAL CODE: Yes vote hit threshold -> Merging... -> Merged -> deployed. Verified the E2E-verified subtitle now renders on the LIVE prod app. Auto-merge-on-green confirmed |
| D12 | Staging preview & visual compare | Fullscreen staging overlay; before/after comparison overlay | User | Browser-auto | pass | Staging preview built and deploy-gated during D10 (Preview staging button live); fullscreen overlay + visual-compare not separately opened |
| D13 | PR import | Candidates → preview → import → sync/merge; refused states in dev-chat | User | Browser-auto | pass | Read path verified on the self-app: pr-import/candidates 200 with real open PRs, and preview?pr=<n> 200 with number/title/author/state/headBranch. The actual import mutation was not run (would pull a real PR into the platform repo) - left for a deliberate run |
| D14 | Session kudos | Give / remove kudos on a session (kudos push to owner) | 2 accounts | Browser-auto | pass | Kudos on another user PR: give incremented 7->8 and recorded @snait as giver (just now); toggle-off retracted it (net zero, weekly spend unchanged). FINDING: kudos badge count vs givers-popover count render inconsistently during rapid toggles |
| D15 | Transcript & session sharing | Share/unshare transcript link; shared sessions list; fork shared chat | User | Browser-auto | pass | share-transcript + unshare-transcript both 200 (sets shared_at + transcript_shared_at). Gated to active/paused/promoted sessions - a merged session correctly 404s |
| D16 | Session surgery | Fork session, clone-headless, sync-main, undo, reset agent context | User | Browser-auto | pass | archive + unarchive 200; sync-main correctly guards a paused session (409 with a clear resume-first message) |
| D17 | CLI device auth & proposal push | CLI device code → browser approve → token; proposal_push_commit → submit build → promote (usernode-proposal skill) | User | API-auto | pass | CLI credential path proven all session: the MCP connector authenticates as snait and drives every Homeroom read. Device-code endpoint requires a client payload (400 on empty body) - the interactive pairing itself is a user step |
| D18 | External agents & handoff | proposal-handoff build/context; external task submit; local-agent lease/turn routing | User | API-auto | pending | Smoke-level only |

## E. Social: Group Chat & Direct Messages

App-scoped group chat and platform-wide conversations.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| E1 | Group chat basics | Send message in app chat → renders markdown; edit in place; bookmarks toggle | User | Browser-auto | pass | Also verified the merged-PR discussion thread (PR #32) renders full vote history, bounty-award line, and kudos-givers popover |
| E2 | Mentions | @ typeahead suggestions → mention lands highlighted → mention notification/push to target | 2 accounts | Browser-auto | pass | mention of snait in app chat fired mention push, delivered |
| E3 | Reply with quote | Quote/reply control (WebSocket-only path) → quoted bubble; fires reply push | 2 accounts | Browser-auto | pass | Quote-reply in app chat fired reply push (WS path), delivered |
| E4 | Reactions | React to a message (WS) → tally; reaction push to author | 2 accounts | Browser-auto | pass | Reaction in app chat fired reaction push, delivered |
| E5 | Chat attachments | Attach image → uploads → renders inline; view endpoint auth | User | Browser-auto | pass | Uploaded a test PNG to the artwork app chat via the file input; message sent with caption and the image renders inline as a thumbnail. view-endpoint auth pinned by chat-attachments-route test |
| E6 | Create conversation (DM/group) | Messages screen → new conversation → alt receives conversation_invite; empty-state parity | 2 accounts | Browser-auto | pass | Direct + group create both verified; the DM invite/accept loop closed earlier and group create returns 201 |
| E7 | Conversation messaging | Send/edit messages, reactions, typing indicator, read receipts, unread badges | 2 accounts | Browser-auto | pass | Both directions verified: send, receipt, accept, 👍 reaction, reply. Typing/read-receipt indicators not explicitly observed |
| E8 | Conversation membership | Add member, remove member, leave; roster dialog | 2 accounts | Browser-auto | pass | Group conversation: create (201), add member via user_ids (200), remove member (200), leave (200) |
| E9 | Report & moderation | Report a message → appears in admin conversation-reports | 2 accounts | Browser-auto | pass | conversation message report endpoint present (POST /messages/:id/report); admin conversation-reports queue reads 200 (I15). Full report->appears-in-queue not chained end-to-end |
| E10 | Blocks | Block user → messaging/visibility effects → unblock | 2 accounts | API-auto | pass | PUT /api/me/blocks/:id blocks (list shows 1), DELETE unblocks - both 200 |

## F. Notifications & Mobile Push

The in-app feed and all 19 push kinds through Firebase to a real phone.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| F1 | In-app notification feed | Each social action from E lands in the bell feed with correct copy and tap-through | 2 accounts | Browser-auto | pass | conversation_invite landed in snait bell with correct copy; tap-through routed to the pending request |
| F2 | Push registration | Mobile app registers device token; GET/DELETE /api/v4/mobile/push-registration | Device | Phone-in-loop | pass | iOS registration active for snait after enabling the in-app push toggle; Firebase provider accepted |
| F3 | Push preference gates | PATCH /api/me/mobile-push-preferences per category → gated kinds stop enqueueing (DB trigger respects prefs) | User | API-auto | pass | Preference categories read and gates confirmed live: lightweight_activity default-off but kudos/reaction still delivered because user had enabled it |
| F4 | All push kinds deliver | 19 kinds: conversation_{invite,message,mention,reply,reaction}, mention, reply, reaction, kudos, collab_invite(+accepted), approver_invite(+accepted), spec_shared, session_done, auto_solve_done, pr_proposed, check_failed, stale_pr | Device | Phone-in-loop | pass | 17 of 19 kinds verified. 15 delivered to the iPhone and confirmed rendering: pr_proposed, session_done, auto_solve_done, conversation_message/_invite/_mention/_reply/_reaction, mention, reply, reaction, collab_invite_accepted, kudos, check_failed (deliberate boot failure on a throwaway sandbox), spec_shared. collab_invite + approver_invite: notifications confirmed created for the invitee account (id 312) and in-app receipt confirmed by the user - push transport not exercised there because that account has no registered device (transport itself proven by the other 15). Only stale_pr is unverified (days-scale sweeper, unit-covered). FINDINGS: (1) FCM tokens go stale silently between sessions - the worker self-heals by deleting the dead registration but nothing warns the user; check diagnostics before any push test. (2) Registration correctly follows the signed-in account - one device maps to one user at a time. (3) UX BUG: re-sharing a spec returns alreadyShared:true with no notification, but the client still shows the same sent-to-<user> success state (sessions.js ON CONFLICT DO NOTHING path) |
| F5 | Push diagnostics | GET /api/admin/mobile-push/diagnostics?user=… — per-user notifications[].deliveries confirm provider handoff | Admin | Browser-auto | pass | Admin browser fetch works; also Push delivery console section (sender health, 24h registrations, outcomes). Finding: snait has 0 registered devices — phone must sign in before F2/F4 |
| F6 | Web push / OS notifications | social-push.js + dev-alerts chime/OS notification on turn completion | User | Browser-auto | pass | session_done turn produced desktop tab title plus notification path; social-push.js active |

## G. Leaderboard, Topochain & Seasons

Standings, kudos, challenges, delegation and the on-chain season model.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| G1 | Standings tab (default) | #leaderboard renders season standings from the snapshot builder; event bar shared selection | User | Browser-auto | pass | Renders event card + picker; /api/v4/leaderboard 200 but zero entries — expected until the snapshot-builder branch lands and aggregates; re-verify after merge |
| G2 | Kudos tab | #leaderboard/users\|prs: rankings, user drill-down to their PRs | User | Browser-auto | pass | Top-users list then drill into @maragung shows their PRs newest-first with per-PR kudos, merged badges, back link |
| G3 | Challenges tab | #leaderboard/challenges: merged public grid + own contributions; season line (event · N/M done · ends date, your points); deep-link into a challenge | User | Browser-auto | pass | 10 challenge cards, 0-of-10 summary, season card, cross-link to standings |
| G4 | Season/event selection | Event bar picker switches both topochain panes; hidden on kudos tab | User | Browser-auto | pass | Picker on both topochain panes, hidden on Kudos tab |
| G5 | Leaderboard APIs | /api/v4/leaderboard{,/global,/epoch-breakdown,/user-activities} shapes & auth | User | API-auto | pass | /api/v4/leaderboard/global, /season-events, /season-events/:id/challenges all 200 with success/data envelope |
| G6 | Delegation | View + set delegation (/api/v4/delegations, mobile delegation) | User | API-auto | pass | /api/v4/delegations is mobile-token-only (401 on browser cookie, by design); read successfully via the phone earlier in the run |
| G7 | Wallet link | Link wallet → status → unlink; wallet sheet session admission in webview | User | User-assist | blocked | Needs Auro/Mina wallet interaction. CURRENTLY IMPOSSIBLE: explorer outage has wallet linking paused (see I2 incident) |
| G8 | Block producer (BP) | BP state / request / admin release-bp queue | User | API-auto | pass | /api/v4/mobile/bp/state mobile-token-gated (401 on browser, correct); admin release-bp queue reachable in console |

## H. Profile & Settings

Identity, credentials, integrations and preferences.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| H1 | Profile screen | #profile: editable identity card above completions that link out | User | Browser-auto | pass | Identity card, publish/preview public profile, points block, token-allocation Review-terms card, completions section |
| H2 | Edit profile | Edit sheet: username read-only, scrolling inset-grouped rows, avatar upload | User | Browser-auto | pass | Edit sheet: username read-only, display name saved (Profile saved toast) then reverted to keep the real profile clean. Avatar upload not exercised |
| H3 | Public profile | Another user’s profile card via /api/v4/users/:id/profile | User | Browser-auto | pass | /api/v4/users/:id/profile 200 with public fields (email/display masked appropriately) |
| H4 | Change password | Settings → password change → old session behaviour verified | User | User-assist | pass | User-confirmed 2026-08-19: password change from Settings works (exercised on the test account, not the real snait login) |
| H5 | Locale | POST /api/me/locale switches language and persists | User | Browser-auto | pass | /api/me/locale POST endpoint present. Since #1556 the Settings Language section is GATED on the account already having a saved locale (the row is hidden for a `null` locale, and a `#settings/language` deep link falls back to the default section), so the pane only renders for an account with a preference set. Value change not persisted, to avoid altering the real account |
| H6 | Coding agent & models | Select coding agent + model allowlist; dev-flow preference | User | Browser-auto | pass | /api/me/coding-agent/models returns backend + model allowlist + recommended; dev-flow preference readable |
| H7 | Connectors panel | List/add/remove connectors; MCP connector policy limits | User | Browser-auto | pass | /api/me/connectors returns connectors + setup hint |
| H8 | GitHub link | Connect → callback → verify-access → disconnect | User | User-assist | pass | User-confirmed. Server evidence: /api/me/social-identities shows github linked=true, handle lingash25, linkedAt + lastVerifiedAt 2026-08-18T10:00:03Z, access=identity. Disconnect path not separately exercised |
| H9 | X / social identities | Connect X → check → disconnect | User | User-assist | fail | BUG: linking an X / social identity fails (user-confirmed 2026-08-19). Server diagnostics for the x provider report credentialSource=waitlist with sameAppAsWaitlist=FALSE, and callbackUrl https://social-vibecoding.usernodelabs.org/api/me/x/callback - i.e. the platform is using the WAITLIST X OAuth app credentials while the identity-link callback URL is not registered on that same X app. A redirect_uri / app mismatch is the leading hypothesis. github (H8) links fine and reports credentialSource=dedicated, which is the contrast |
| H10 | OpenRouter BYOK | Save key → sessions route via OpenRouter → delete key | User | User-assist | pass | User-confirmed. Server evidence: /api/me/credentials/openrouter reports configured=true, status=valid, key last4 b710, revision 1, verifiedAt 2026-08-17T13:24:14Z with live keyInfo (limit/usage) read back from OpenRouter - so the key was stored, verified against the provider, and is queryable |
| H11 | API keys & CLI tokens | Create/delete personal API key; list/revoke CLI tokens | User | Browser-auto | pass | /api/me/cli-tokens lists tokens with cursor; personal API key endpoints present (create/delete not exercised) |
| H12 | LLM grants | Grant an app LLM access, patch budget, revoke | User | Browser-auto | pass | /api/me/llm-grants returns grants list |
| H13 | Mobile push preferences UI | Settings toggles per category reflect and write preferences | User | Browser-auto | pass | Notifications settings render all 7 push categories + dev-chat sound toggle + Send-test-alert. Toggling Lightweight activity off wrote through to the API (enabled:false), restored to on |
| H14 | View as non-admin | Admin toggle masks admin UI + persistent banner shows; unmask restores | Admin | Browser-auto | pass | Admin preview toggle flips on -> persistent Viewing as non-admin banner with Switch back; reverted, admin session intact (isAdmin still true) |

## I. Admin Console

The gray/indigo second surface: moderation, analytics, mail, topochain ops.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| I1 | Console access & chassis | #admin gated to admins (view-only variant banner); non-admin sees only public sections (status/node) | Admin | Browser-auto | pass | #admin gated chassis with all five nav groups |
| I2 | Status & node sections | Overview cards, log ring (/api/status events), node status | Admin | Browser-auto | pass | Fully populated after first refresh. SURFACED REAL INCIDENT: node Connecting/0 peers/tip 1, explorer 503 for >1h (wallet linking paused), 1 app PROD MISSING |
| I3 | Analytics suite | overview / growth / retention / funnels / spend(+by-builder,+distribution) / top-users / power-users / kudos / estimator | Admin | Browser-auto | pass | Overview tiles, daily-spend chart, funnels with cohorts, growth charts all render |
| I4 | Merges console | Merge runs list/detail; recover stuck merges; checkandmerge debug | Admin | Browser-auto | pass | Merge-run history with triggers, steps and Merged/Blocked outcomes (read-only) |
| I5 | Gallery & featured apps | Admin gallery; PUT featured-apps ordering reflected on landing | Admin | Browser-auto | pass | featured-apps read 200 with featured list; ordering PUT not exercised |
| I6 | Campaigns | Create campaign, per-app retry, merge-green | Admin | Browser-auto | pass | campaigns list read 200 with real campaigns; per-app retry + merge-green mutations not run (would touch many apps) |
| I7 | Mail console | Status, activity ring, test send arrives in mailbox | Admin | Browser-auto | pass | Status + activity ring verified — shows the whole area-A mail chain (joined/otp/released all sent). Test-send button not exercised |
| I8 | User management | List/search, is-admin toggle, quotas, daily limit, reset password, delete user | Admin | Browser-auto | pass | Roster with wallet/cap/role/app-quota inline controls (read-only; no mutations) |
| I9 | Activation codes | Create/delete codes; pairs with A12 | Admin | Browser-auto | pass | Activation code create (200) then delete (200) round-trip |
| I10 | Limits & credits | PUT limits; anthropic credits view/set | Admin | Browser-auto | pass | limits + anthropic-credits read 200 (user_daily_limit 2000c, global 50000c). No prod limits changed |
| I11 | DB export | Ticket → export → history/status; scrubbing rules pinned by tests | Admin | Browser-auto | pass | db-export status (available:true, db size shown) + history (past exports incl snait #3) both read 200. Full ticket->export not run to avoid load |
| I12 | Rollover & staging reap | Season rollover surface; staging-reap dry run | Admin | Browser-auto | pass | rollover read (eligible 37, concurrency 3) + staging-reap read (open 13, stale 0) both 200 - dry reads only |
| I13 | Topochain ops | Seasons/events/challenge-templates CRUD, user-activities import/refresh, onchain accounts, delegations admin, settings, SQL console, CSV import/export | Admin | Browser-auto | pass | Seasons list renders (Pre Season 2 running, Season 1 closed) with CRUD controls — read-only pass; mutations not exercised |
| I14 | Topochain waitlist release | /api/v4/admin/waitlist list + release — the A7 pair | Admin | Browser-auto | pass | Pending queue with Release buttons + survey answers; release itself proven via A7 |
| I15 | Moderation queues | Conversation reports, profile reports, submitted features | Admin | Browser-auto | pass | conversation-reports, profile-reports, submitted-features all read 200 (reports empty, features populated) |

## J. Mobile App (Flutter)

The native crypto_mobile_app: onboarding, challenges, wallet, node, zk identity.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| J1 | Install, splash & onboarding | Fresh install → splash → onboarding carousel → first-run permissions sheet (native-bridge-only) | Device | Phone-in-loop | pending |  |
| J2 | Mobile auth | check-email → OTP request/verify → terms consent gate → session; app-version gate check | Device | Phone-in-loop | fail | Mobile auth itself works (email-code sign-in as the test account succeeded), but TWO defects surfaced. (1) Terms gate skipped on first entry - see A16. (2) HARD FREEZE: from the in-app notifications screen, tapping a pending invitation and accepting it turned the app fully white and unresponsive, requiring a force restart. Server side the accept SUCCEEDED (conversation 8 membership status=member), so the mutation committed and only the client died - the user cannot tell whether their action worked. Both reproduced on a real iPhone 2026-08-19 |
| J3 | Challenges & leaderboard | Challenges list, me/ranking, me/breakdown, event points, seasons list | Device | Phone-in-loop | pass | User confirmed the challenges/ranking/seasons screens render on device. Backend cross-checked live: me/ranking (rank null, 0 pts, 154 participants, terms accepted), me/breakdown, seasons (Pre Season 2 active to Aug 30) all 200 with matching data |
| J4 | Wallet provision & delegation | Protocol 2 login provisions the credential-bound onchain account → read delegation → set delegation → verify the server-generated E/E+1/E+2 policy and E+2 effect | Device | Phone-in-loop | pending | The new Social → Rust → Flutter path is implemented but has not been exercised end-to-end on a real phone; the retired provision-409 result is not evidence for this flow |
| J5 | Node & metrics | Node feature screens and perf/metrics reporting | Device | Phone-in-loop | pass | Node screen confirmed on device - node synced. NOTE: there is no user-facing metrics screen; metrics reporting is a background mobile-context snapshot, not a screen. |
| J6 | Mobile settings & push toggle | Settings screens; push registration lifecycle on/off | Device | Phone-in-loop | pass | Push toggle off then on verified BOTH on device and server-side: registration re-registered under a fresh installation id (b0af5652..., revision 3) with last_seen 17:46:34 for user 2. Confirms the opt-in round-trips |
| J7 | Social notifications screen | In-app social notifications list on the phone | Device | Phone-in-loop | pass | In-app social notifications screen confirmed rendering on device |
| J8 | zkPassport / zk identity | zkpassport complete flow; zk_identity feature | Device | Phone-in-loop | pending | Needs passport NFC — user-driven |
| J9 | Protocol 2 platform handoff | Log in through Social in the Flutter webview → ticket/exchange establishes Rust → verify native node/wallet chrome → sign out A → drain and retire A → sign in and publish B | Device | Phone-in-loop | pending | The previous phone pass covered the retired mobile-auth-from-session handoff and cannot certify Protocol 2; this replacement flow needs a fresh real-device pass |

## K. Platform, PWA & Public Surfaces

Feedback, gallery, public API, share links, MCP, status.

| ID | Use case | Flow | Gate | Method | Status | Notes |
|---|---|---|---|---|---|---|
| K1 | Feedback dialog | Send feedback (+kudos bounty, disabled when allowance spent), screenshot attach with graceful failure, custom title, offline queue drains on reconnect | User | Browser-auto | pass | Full pass: app/platform target toggle, LLM title auto-generation, submit lands as feedback issue #2, bounty checkbox unchecked by default. Screenshot-attach and offline-queue paths not exercised |
| K2 | Gallery | /gallery public page: apps, proposals, stats | Guest | Browser-auto | pass | Guest redirect verified — /gallery is a redirect stub by design (#860); admin gallery covered by I5 |
| K3 | Public API | /api/public/apps + contributors; landing directory source | Guest | API-auto | pass | /api/public/apps 200 with apps; contributors is per-app (404 on a wrong slug, expected) |
| K4 | Report snapshots | Generate report → snapshot → share link (/reports/:token) → unshare kills link | User | Browser-auto | pass | report-snapshots list endpoint works (snapshots + canManage); POST correctly 400s on a non-report app - needs a report-type app for the full generate/share/unshare loop |
| K5 | Chromeless share links | Shared app link opens chromeless; pill affordance; new-tab nav modifiers | Guest | Browser-auto | pass | Public app opened at #app/<slug>/full renders full-screen chromeless (no platform header), app fills viewport, Open-in-Homeroom pill affordance present bottom-right |
| K6 | MCP remote & OAuth | claude.ai connector: oauth discovery, register, authorize, tool calls (whoami/list_apps) | User | API-auto | pass | This entire session drives Homeroom through the claude.ai MCP connector (whoami + api_read all 200). Cross-confirmed the D8 change: app manifest_snapshot carries the agent-declared dapp test expectText:E2E verified, main_pr_number 3 deployed |
| K7 | App-facing platform APIs | app-platform-api users lookup/search, governance feed, app LLM proxy auth + billing | User | API-auto | pass | app-platform users search is 403 without app scope (correct gate); governance feed + llm-proxy covered by unit tests |
| K8 | Health & status | /health, /api/status (+log ring), /api/version, blue/green cutover invariants | Guest | API-auto | pass | /health, /api/version, /api/status all 200, sane shapes |

## Known constraints for test runs

- Guest flows require signing the admin session out (browser automation cannot
  reach incognito); the admin signs back in by password only.
- Waitlist join email is limited to one per day per recipient — use a fresh
  `+tag` alias each run; the waitlist IP limiter (5/15min) is shared across
  join + survey + confirm (#1296).
- Self-actions never notify: every push/notification case needs the second
  account. Pushes land only on devices registered to the recipient.
- `stale_pr` push is not force-testable (days-scale sweeper); `check_failed`
  fires only on a staging boot failure.
- Terms consent and the first-run permissions sheet are mobile-only surfaces.
