# Kubernetes runtime operations

Use this runbook when `APP_RUNTIME=kubernetes`. The standalone Compose and
host-deployer instructions in `README.md` and `SELF-HOSTING.md` describe the
Docker installation. Kubernetes platform, worker, and capture images have no
Docker daemon or socket. Talos workloads are observed through Kubernetes APIs.

## Ownership and releases

The `Build Kubernetes images` workflow resolves the current Claude Code
version once, builds the platform Dockerfile in CI, builds or reuses
worker/capture images by their tracked build inputs, and publishes one OCI
Helm chart containing all three image digests. `main` produces the stable
`0.1.*` releases tracked by Argo CD. The platform's own release uses this
workflow; generated child apps use kpack and Paketo from exact Git revisions.
Child-app Dockerfiles are not executed by kpack.

The daily dependency check is intentionally cheaper than a source release. It
looks up the exact worker input key for the current npm version and exits after
the planning job when that artifact already exists: no image jobs run and no
new chart is published. When the version changes, it reuses the platform image
for the exact current `main` revision and the capture image for its tracked
inputs, builds only the worker, and packages those three immutable digests into
a new atomic release. Missing platform or capture artifacts fail closed and
require the normal `main` workflow; the scheduled path never rebuilds them as
an incidental side effect.

Argo owns the platform Deployment, database, namespaces, service accounts and
runtime permissions. The platform owns generated apps, previews, workers and
check Jobs. Keep each change with its owner; source commits do not themselves
change the cluster. Review the normal release/GitOps diff before deployment.

Argo notices a published chart by re-reading the registry's tag list on its
reconcile interval, up to three minutes after the push. When the repository
secret `ARGOCD_REFRESH_TOKEN` is set, the release job's "Ask Argo CD to pick up
the release now" step follows a stable `helm push` with
`GET /api/v1/applications/social-vibecoding-platform?refresh=hard`, so the
comparison — and the automated sync behind it — starts at once. The token is
an Argo CD project-role token that can only `get` that one Application; the
role, the mint procedure and rotation live in the infra repository's
`docs/22-social-vibecoding-runtime-operations.md`. The step is best effort:
unset, it skips; a rejected or timed-out call posts a warning on the run and
the release lands on the periodic reconcile as before. It cannot fail the run,
because `release-watch` reads the run's conclusion and would otherwise report
a healthy release as stalled.

A merged platform PR is therefore "merged" on its card before it is running,
and nothing in that chain reports back to the platform when a link fails. The
platform watches the gap itself: `services/release-watch.js` compares the
self-hosted app row's `main_sha` (the running build) with GitHub's `main` on the
drift poller's cadence, reads the `Build Kubernetes images` run for the merged
commit, and once (per commit and verdict) records the stall on
`apps.release_stall`, posts to the app's group chat, and notifies the app's
admins. The Dev board shows an amber banner with the workflow run linked until
the running build catches up. A red run is reported at once; a run still going,
a run that succeeded without a rollout, or no run at all is reported after
`RELEASE_GRACE_MS` (default ten minutes). Re-running the failed workflow jobs,
or the next merge, releases the commit; the poller clears the record on the new
build's first tick. A token without `actions:read` degrades to the time-based
verdict rather than failing.

Nothing in that chain tells open browser tabs about the new build either; the
Pod being replaced does. The rolling update terminates the old Pod only after
the new one has been Ready for `minReadySeconds`, and the `preStop` sleep has
taken it out of the Service before `SIGTERM` arrives. On `SIGTERM`, `server.js`
`cleanup()` closes the listener, then reads the Deployment's target revision
through `services/deploy-status.js` and, if it is another build, pushes
`platform_version` to every open `/ws/events` socket
(`ws.pushPlatformVersion`). Every events handshake carries the same message
with the build the socket landed on. A tab prefetches the announced build into
its service-worker cache and turns the Settings version row into the reload
button (`handlePlatformVersion` in `public/js/app.js`); it never reloads
itself — the user does, from that button or a pull-to-refresh. The 10s
`/api/version` poll paints the rollout in progress and remains the fallback. A
`SIGTERM` for any other reason finds the target equal to the running build and
announces nothing.

When a stable release changes `KUBERNETES_WORKER_IMAGE`, an existing warm
worker is compared with that immutable digest before its next dispatch. An
idle worker on the old digest is recreated while its per-session PVC is kept,
so Claude's on-disk session state survives. An in-flight turn is never
interrupted for an image refresh; replacement is deferred until a later safe
dispatch. This makes the new worker image effective without a manual fleet
restart, while avoiding a rollout that kills paid work already in progress.

See the [platform chart](../deploy/helm/social-vibecoding-platform/README.md)
for configuration and the `infra/prototype/bare-metal-platform` runbooks for
cluster foundation and database operations. Read the installed image and Argo
revision when comparing source behavior with a live failure.

## Shared app and preview TLS

Generated apps and previews share the installation-owned TLS Secret named by
`APP_TLS_SECRET_NAME` (default `social-apps-wildcard-tls`) in `APP_NAMESPACE`.
Provision a trusted wildcard covering `*.USERNODE_APPS_DOMAIN` before deploying
this runtime version. The foundation chart owns its Certificate and DNS-01
renewal. App Ingresses have no certificate issuer annotation; ordinary preview
rebuilds, failed-start cleanup and idle teardown neither request certificates
nor delete TLS Secrets. An installation can also supply an existing wildcard
Secret with the same ownership and coverage contract.

This is a rollout prerequisite, not an optional per-host fallback. Deploying
the runtime before the Secret is ready can leave new/rebuilt previews without
working HTTPS even when their Pods are Ready. Existing Ingresses keep their old
TLS references until reconciled or migrated. The infra runbook
`docs/23-social-vibecoding-shared-tls.md` includes a read-only migration planner,
issuance-limit recovery and explicit retirement of legacy Certificates.

## HTTP keep-alive ordering

The platform server (including self-previews) and newly scaffolded Node apps
set `server.keepAliveTimeout` to 75 seconds. This gives the ingress's 60-second
upstream idle timeout a 15-second margin to retire unused connections before
Node closes them. Preserve this ordering if the ingress timeout changes.
Node's default keep-alive buffer remains in effect; request and header timeouts
are separate and unchanged.

The platform setting takes effect when the updated server is deployed. Existing
child-app repositories and previews built from older commits retain their own
server code; changing the scaffold does not retrofit them.

## Coordinated preview lifecycle

`platform.previewLifecycleEnabled` (default `false`) sets
`PREVIEW_LIFECYCLE_ENABLED`. With it enabled, builds, captures and teardown share
one PostgreSQL advisory lock per session, across platform Pods. A durable
`preview_operations` row records the desired revision, run UUID, phase and
outcome. Advancing the session's checks/imported head cancels the old owner;
the successor waits for its capture and unit-suite consumers to stop before
changing the preview. Cancellation is not an app test failure.

Capture and unit-suite Jobs carry `social.usernode.io/preview-run-id`. The owner
requests foreground deletion and confirms Job/Pod termination. API errors keep
replacement blocked; a DELETE acknowledgement alone does not establish that
the browser stopped. After a platform restart, a successor for a NEWER revision
stops orphaned check Jobs before using the preview; a run for the revision the
session is still waiting on is harvested instead (below).

## Harvesting check runs across platform rollouts

Every merge to the self-app rolls the platform Deployment, and every checks
run in flight at that moment loses the process that was streaming its capture
and unit-suite Jobs. The Jobs themselves belong to the cluster and finish
regardless. `services/check-harvest.js` reads them rather than starting over.

Each run writes a manifest row to `check_runs` (session, commit, owner
`hostname:pid`, launch context) before its Jobs are created and heartbeats it
every `CHECK_RUN_HEARTBEAT_MS` (15s). A row with no heartbeat for
`CHECK_RUN_ORPHAN_MS` (60s) is an orphan. The leader sweeps once at boot —
before the stuck-checks reconcile, so a harvestable run is never re-driven as
stuck — and every `CHECK_HARVEST_SWEEP_MS` (30s) after, at most
`CHECK_HARVEST_CONCURRENCY` (3) adoptions at a time. An orphan is:

- **settled** when its Jobs are found by the `preview-run-id` label: a finished
  Job's log is read, a running one is waited on with progress re-published to
  the proposal card, and the output goes through the same settlement a live
  run ends with (same parse, verdict, stores, commit guards, broadcasts);
- **re-driven immediately** when there is nothing to read — the process died
  before creating the Jobs, or the Jobs are gone (TTL, or cancelled);
- **moot** when the session no longer wants the run — decided meanwhile, head
  moved, session closed, or (under the preview lifecycle) a newer run owns it.

Under `PREVIEW_LIFECYCLE_ENABLED` the harvester adopts the run's
`preview_operations` row first and writes through the same ownership check a
live run does; a request for a newer revision aborts the harvest. Outside the
Kubernetes capture runtime the harvester is a no-op. The stale sweep
(`CHECKS_STALE_MS`) remains the backstop for rows with no manifest at all.

Every capture rechecks the exact deployed revision, image, environment
fingerprint, completed rollout, application health and public edge before
starting. Check results and screenshot transactions verify the current run and
revision under a session row lock. Newer revisions cannot publish older output;
same-commit recovery after a rebuild can replace an infrastructure-error verdict.
Manual reruns, unit checks, browser checks, screenshots, PR visuals, progress and
automatic merging remain supported. Docker retains its existing lifecycle.

Kubernetes rebuilds reconcile the existing Ingress and Service instead of
deleting them first. This removes the missing-host TLS routing window, but does
not promise uninterrupted interactive previews during application/database
replacement. Already-started image builds and database preparation settle before
ownership passes; obsolete captures are cancelled explicitly. Build artifacts
remain subject to normal retention. This change does not add Envoy retries.

### Activation and rollback

Apply the additive schema migration with the release. **Do not use an ordinary
rolling flag change:** a flag-off Pod can bypass the coordinator even if it runs
the new binary. The chart defaults off to make this transition explicit.

1. Schedule a brief platform maintenance window and pause proposal mutations.
   Through the installation's GitOps owner, scale the platform to zero and
   confirm all platform Pods have terminated. Keep app previews and PostgreSQL
   running; do not delete the preview Ingresses.
2. With platform replicas still zero, set `platform.previewLifecycleEnabled: true`
   and select the coordinator-capable release. Confirm the schema hook succeeded.
3. Restore the normal replica count and resume mutations. Verify a new revision
   supersedes an active capture, both old check Jobs stop, and the new run
   produces checks/screenshots for its own revision. Further releases may roll
   normally while every participating Pod keeps coordination enabled.

Rollback across this boundary uses the same stop-all-platform-Pods procedure.
Before starting a flag-off/older release, terminate outstanding capture and
unit-suite Jobs and confirm their Pods have stopped. Retain the additive table.
The mixed-mode restriction also applies to manually started platform processes.

For local validation, `tests/preview-lifecycle.test.js` uses independent real
PostgreSQL connections and an isolated temporary schema. Set
`PREVIEW_LIFECYCLE_TEST_DATABASE_URL` to a disposable test database, or use the
existing `SQL_CHECK_CONNECTION_URL` supplied by the unit runner. It never falls
back to the application's `DATABASE_URL`. Kubernetes termination and cancellation
are covered by `tests/kubernetes-preview-cancellation.test.js` with API doubles.

## Read-only inventory and logs

These examples use the organization namespace and Deployment names. Substitute
the configured names for another installation. Resource names come from API
inventory; a Docker container ID or old single-server name is not a Pod name.

```sh
kubectl -n social-platform get deployment social-vibecoding
kubectl -n social-platform logs deployment/social-vibecoding -c platform --tail=200
kubectl -n social-apps get deployments,pods,services,ingresses
kubectl -n social-workers get deployments,pods,jobs,pvc
kubectl -n social-builds get builds.kpack.io,pods
kubectl -n social-builds get resourcequota
```

For one preview or worker, select `social.usernode.io/session-id=<session id>`.
For one application, select `social.usernode.io/app-id=<app id>`. For example:

```sh
kubectl -n social-workers get pods -l social.usernode.io/session-id=42
kubectl -n social-apps get pods -l social.usernode.io/session-id=42
```

Once the inventory gives the actual Pod name:

```sh
kubectl -n social-apps logs POD_NAME -c app --tail=200
kubectl -n social-apps logs POD_NAME -c app --previous --tail=200
kubectl -n social-workers logs WORKER_POD_NAME -c worker --tail=200
kubectl -n social-workers describe pod WORKER_POD_NAME
```

`--previous` reads the preceding container incarnation in that Pod; it cannot
recover an already deleted Pod. Inspect current and previous termination
reasons, restart counts, scheduling conditions and readiness together. An old
ready replica can still serve while the desired image is failing to start.
ResourceQuota reports reservations and object counts, not measured CPU or
memory consumption. Do not substitute Docker host statistics for cluster usage.

Capture Jobs default to an 8-CPU / 6Gi limit for sixteen concurrent browser
groups, with 1 CPU / 3Gi requested. The foundation worker LimitRange must allow
at least 8 CPUs and 6Gi per container. `CAPTURE_CPUS`, `CAPTURE_MEMORY` and
`TEST_CONCURRENCY` override these settings on the platform. Memory is the bound
on the pool — budget roughly 150 MiB per concurrent page plus 1 GiB for the
browser — since the capture browser composites in software (Skia, not a
SwiftShader GPU process) and a page load costs well under a CPU-second. CPU
requests are scheduling reservations, so the larger limit allows bursts but
does not guarantee eight idle cores. Check historical CPU throttling as well as
completion: a successful Job can still produce timing-sensitive assertion
failures under CPU contention. Unit-suite Jobs default to 8 CPUs / 4Gi (the CPU
quota sets `node --test`'s process-pool size); coding-worker resource settings
are independent.

Self-app previews (`USERNODE_ENV=staging`) do not build worker images, inspect
Docker or Kubernetes workloads, or read the parent's deployment status. Their
status API reports `runtimeKind: preview` and `runtimeAvailable: false`; fleet
counters are null and the UI labels runtime status unavailable. Cloned app and
session rows do not establish live workload readiness. Preview isolation does
not require forwarding runtime credentials or a Kubernetes service-account token.

The authorized `usernode-debug containers` and `usernode-debug logs <name>`
interfaces accept managed runtime names such as `sv-worker-s42` and
`sv-preview-7-s42`. Their inventory includes readiness but leaves CPU/memory
usage null when measured usage is unavailable.

## Build and startup failures

Find the kpack lifecycle Pod through the Build's `status.podName`, then inspect
the init-container names and logs for the failing phase:

```sh
kubectl -n social-builds get build BUILD_NAME -o jsonpath='{.status.podName}{"\n"}'
kubectl -n social-builds get pod BUILD_POD_NAME -o jsonpath='{.spec.initContainers[*].name}{"\n"}'
kubectl -n social-builds logs BUILD_POD_NAME -c build --tail=200
```

The runtime captures bounded, redacted build and preview failure logs before
cleanup. Once the Pod is deleted, use the persisted build/check failure and
platform diagnostic log. Retention and its read-only preview are documented in
[kpack Build retention](kpack-build-retention.md). Build diagnostics need `get`
on `pods` and `pods/log` in `social-builds`; the foundation owns those grants.

Worker setup reports clone/checkout phases before readiness. A fatal setup
marker, scheduling problem or admission failure is a bootstrap failure, before
agent dispatch. Worker readiness requires the container-local bootstrap marker;
Deployment availability by itself is not enough. Turn OOM attribution uses Pod
termination evidence from the current turn, including a container restart.

Database connection exhaustion is an infrastructure error, not a failing app
diff. Check the configured database Service and namespace. The cluster runtime
uses networked PostgreSQL clients; do not run `docker exec usernode-db` on a
cluster node or assume the historical standby is the active writer.

## Platform deployment reporting

`/api/version` and admin status observe the platform Deployment. The chart
grants only `get` on that Deployment. Rollout, failed, paused and unavailable
states are distinct; API failure is not reported as an idle, healthy rollout.
The response's `scope: rollout` excludes image build and chart publication.
Use the source repository's `Build Kubernetes images` workflow for those stages
and Argo CD for chart sync/migration-hook failures before a Deployment update.

Self-app merges trigger the normal GitHub workflow. The cluster does not use
the host's `deploy-status.json`, deploy-nudge file, systemd poller, Caddy reload
or Compose blue/green scripts. Rollback is a reviewed GitOps/image revision
change; the single-server `rollback.sh` is not a cluster rollback mechanism.
