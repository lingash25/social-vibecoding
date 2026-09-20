const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('Kubernetes platform image contains PostgreSQL tools but no Docker CLI', () => {
  const dockerfile = read('Dockerfile.kubernetes');
  assert.match(dockerfile, /postgresql-client/);
  assert.doesNotMatch(dockerfile, /docker-cli|docker\.sock/);
  // Numeric, not `node`: the pod runs with runAsNonRoot and no runAsUser, and
  // Kubernetes can verify a numeric image user only.
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.doesNotMatch(dockerfile, /^USER node$/m,
    'runAsNonRoot cannot verify a symbolic image user before startup');
});

test('Kubernetes platform image builds and contains the generated shell assets', () => {
  const dockerfile = read('Dockerfile.kubernetes');
  assert.match(dockerfile, /FROM node:22-alpine AS shell/);
  assert.match(dockerfile, /RUN node frontend\/scripts\/build-shell\.mjs/);
  assert.match(dockerfile, /FROM node:22-alpine AS css/);
  assert.match(dockerfile, /RUN npm run build:css/);

  const sourceCopy = dockerfile.lastIndexOf('COPY --chown=node:node . .');
  for (const asset of [
    '/build/public/index.html ./public/index.html',
    // The directory: every lazy chunk the React build emits, not the entry alone.
    '/build/public/shell/assets/ ./public/shell/assets/',
    '/build/public/css/tailwind.css ./public/css/tailwind.css',
  ]) {
    const assetCopy = dockerfile.lastIndexOf(asset);
    assert.ok(assetCopy > sourceCopy,
      `${asset} must be copied into the runtime after the source tree`);
  }
});

test('Docker keeps boot migrations while Kubernetes can delegate them to a Job', () => {
  const source = read('server.js');
  assert.match(source, /RUN_MIGRATIONS_ON_STARTUP !== 'false'/);
  assert.match(source, /await withMigrationLock\(getPool\(config\), \(\) => migrate\(config\)\)/);
});

test('Kubernetes platform rollout preserves availability and singleton ownership', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(platform, /type: RollingUpdate/);
  assert.match(platform, /maxSurge: 1/);
  assert.match(platform, /maxUnavailable: 0/);
  assert.match(platform, /minReadySeconds: 10/);
  assert.match(platform, /successThreshold: 2/);
  assert.match(platform, /name: PLATFORM_LEADER_LOCK, value: "1"/);
  assert.doesNotMatch(platform, /type: Recreate/);
});

test('Kubernetes enables visual evidence by default with one explicit kill switch', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /visualEvidenceV2Enabled: true/);
  assert.match(platform,
    /name: VISUAL_EVIDENCE_V2_ENABLED, value: \{\{ \.Values\.platform\.visualEvidenceV2Enabled \| quote \}\}/);
  assert.doesNotMatch(platform, /visualEvidenceV2Enabled \| default true/,
    'Helm default treats boolean false as empty and would defeat the kill switch');
});

test('Kubernetes workflow resolves all three images before publishing a release', () => {
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const workerDockerfile = read('worker/Dockerfile');
  for (const component of ['platform', 'worker', 'capture']) {
    assert.match(workflow, new RegExp(`"component":"${component}"`));
  }
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/);
  assert.match(workflow, /ghcr\.io\/\$\{\{ steps\.registry\.outputs\.owner \}\}\/social-vibecoding-\$\{\{ matrix\.component \}\}/);
  assert.doesNotMatch(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}/);
  assert.match(workflow, /sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /steps\.build\.outputs\.digest/);
  assert.match(workflow, /if: steps\.reuse\.outputs\.digest == ''/);
  assert.match(workflow, /IMAGE_DIGEST: \$\{\{ steps\.reuse\.outputs\.digest \|\| steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /no-cache: \$\{\{ steps\.reuse\.outputs\.refresh == 'true' \}\}/);
  assert.match(workflow, /pull: true/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /schedule:[\s\S]*cron: '23 5 \* \* \*'/);
  assert.match(workflow, /npm view @anthropic-ai\/claude-code@latest version/);
  assert.equal((workflow.match(/npm view @anthropic-ai\/claude-code@latest version/g) || []).length, 1,
    'the dependency version is resolved once in the plan, not once per image job');
  assert.match(workflow, /if: needs\.plan\.outputs\.should_release == 'true'/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
  assert.match(workflow,
    /if \[ -n "\$SCHEDULED_WORKER_DIGEST" \]; then[\s\S]*echo 'should_release=false'/,
    'an unchanged scheduled dependency must skip every build and release job');
  assert.match(workflow,
    /matrix=\{\"include\":\[\{\"component\":\"worker\",\"context\":\"worker\",\"dockerfile\":\"worker\/Dockerfile\"\}\]\}/,
    'a changed scheduled dependency builds only the worker image');
  assert.match(workflow, /REUSE_CURRENT_PLATFORM: 'true'/);
  assert.match(workflow, /name: image-digest-scheduled-bases/);
  assert.match(workflow, /CLAUDE_CODE_VERSION: \$\{\{ steps\.claude\.outputs\.version \}\}/);
  assert.match(workflow, /build-args: \$\{\{ steps\.claude\.outputs\.build_arg \}\}/);
  assert.match(workerDockerfile, /ARG CLAUDE_CODE_VERSION=latest/);
  assert.match(workerDockerfile, /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
});

test('Kubernetes workflow asks Argo CD to refresh on publish, and can never fail the release doing so', () => {
  // The step exists to remove Argo's up-to-three-minute reconcile wait from
  // the merge-to-running gap (#2545). Its safety properties matter more than
  // its effect: services/release-watch.js reads this run's conclusion, so a
  // refresh that could fail the run would report a healthy release as
  // stalled. Every guard below is one of those properties.
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const release = workflow.slice(workflow.indexOf('\n  release:\n'));
  const step = release.slice(release.indexOf('- name: Ask Argo CD to pick up the release now'));
  assert.ok(step.length > 0, 'the release job asks Argo CD to refresh');
  assert.ok(release.indexOf('- name: Publish OCI Helm release') < release.indexOf('- name: Ask Argo CD to pick up the release now'),
    'the refresh follows the push: a refresh before the tag exists re-reads the old registry');

  const body = step.slice(0, step.indexOf('- name: Record atomic release'));
  assert.match(body, /continue-on-error: true/,
    'a failed refresh must not turn a published release red — release-watch would call it a stall');
  assert.match(body, /if: steps\.chart\.outputs\.release_channel == 'stable' && env\.ARGOCD_REFRESH_TOKEN != ''/,
    'inert until the infra side provisions the token, and only for the releases Argo tracks');
  assert.match(release, /^    env:\n(?:      #.*\n)*      ARGOCD_REFRESH_TOKEN: \$\{\{ secrets\.ARGOCD_REFRESH_TOKEN \}\}/m,
    'the secret is mapped through job env because a step `if:` cannot read `secrets`');
  assert.match(body, /\?refresh=hard/, 'a normal refresh can be served the cached tag list for the 0.1.* range');
  assert.match(body, /--max-time \d+/, 'bounded: the request blocks until Argo has compared');
  assert.match(body, /\/api\/v1\/applications\/\$\{ARGOCD_APPLICATION\}/);
  assert.match(body, /ARGOCD_APPLICATION: social-vibecoding-platform/);
  assert.match(body, /::warning title=Argo CD refresh not confirmed::/,
    'a token that expired or was revoked is visible on the run, not silent');
  assert.doesNotMatch(body, /\/sync\b/, 'the workflow only refreshes; automated sync owns the rollout');
});

test('migration command validates the target database identifier', () => {
  const { databaseName } = require('../scripts/migrate-kubernetes');
  assert.equal(databaseName('postgres://user:pass@db:5432/app_usernode_2d5619'), 'app_usernode_2d5619');
  assert.throws(() => databaseName('postgres://user:pass@db:5432/bad-name'), /Unsafe database name/);
});

test('Kubernetes workloads receive the canonical repository and release revision', () => {
  const migrationJob = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(migrationJob, /name: USERNODE_DOMAIN, value: \{\{ \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: CLI_CANONICAL_ORIGIN, value: \{\{ printf "https:\/\/%s" \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(migrationJob, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(migrationJob, /name: NODE_RPC_URL, value: \{\{ \.Values\.config\.nodeRpcUrl \| quote \}\}/);
  assert.match(migrationJob, /name: NATIVE_SESSION_V2_TESTNET_CHAIN_ID, value: \{\{ \.Values\.config\.nativeSessionV2TestnetChainId \| quote \}\}/);
  assert.match(platform, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(platform, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(platform, /name: NODE_RPC_URL, value: \{\{ \.Values\.config\.nodeRpcUrl \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM, value: \{\{ \.Values\.config\.explorerUpstream \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM_BASE, value: \{\{ \.Values\.config\.explorerUpstreamBase \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_USE_HTTP, value: \{\{ \.Values\.config\.explorerUseHttp \| quote \}\}/);
});

test('Kubernetes chart supplies the canonical native testnet ChainId', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /nativeSessionV2TestnetChainId: "utc1rq8tql3wr5w8u6nvkwepu7dazq89kv2838xwf02xmg2w5vzgly3s6xf63v"/);
});

test('Kubernetes chart preserves both social account-linking credential pairs', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  const readme = read('deploy/helm/social-vibecoding-platform/README.md');
  for (const provider of [
    { value: 'githubLink', env: 'GITHUB_LINK', callback: 'github' },
    { value: 'xLink', env: 'X_LINK', callback: 'x' },
  ]) {
    assert.match(values, new RegExp(`${provider.value}ClientId: ""`));
    assert.match(values, new RegExp(`${provider.value}ClientSecret: ""`));
    assert.match(secret, new RegExp(`${provider.env}_CLIENT_ID: \\{\\{ \\.Values\\.secrets\\.${provider.value}ClientId \\| quote \\}\\}`));
    assert.match(secret, new RegExp(`${provider.env}_CLIENT_SECRET: \\{\\{ \\.Values\\.secrets\\.${provider.value}ClientSecret \\| quote \\}\\}`));
    assert.match(readme, new RegExp(`/api/me/${provider.callback}/callback`));
  }
});

test('platform node RPC egress is restricted to the configured namespace and Pod labels', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.enabled/);
  assert.match(platformPolicy, /kubernetes\.io\/metadata\.name/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.port/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.enabled/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.port/);
});

test('all explorer consumers honor the explicit internal HTTP transport', () => {
  for (const sourcePath of [
    'server.js',
    'src/services/node-status.js',
    'src/services/chain-poller.js',
    'src/services/genesis-accounts.js',
  ]) {
    assert.match(read(sourcePath), /process\.env\.EXPLORER_USE_HTTP === 'true'/, sourcePath);
  }
});

test('/api/version uses the canonical configured platform repository', () => {
  const server = read('server.js');
  assert.match(server, /repoUrl: config\.platformRepoUrl/);
  assert.doesNotMatch(server, /repoUrl: process\.env\.USERNODE_REPO_URL/);
});

test('PostgreSQL claim template uses only release-stable labels', () => {
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const claimTemplate = postgresql.split('volumeClaimTemplates:')[1];
  assert.ok(claimTemplate, 'volumeClaimTemplates exists');
  assert.match(claimTemplate, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(claimTemplate, /social-vibecoding-platform\.labels/);
});

test('database URLs use the configured embedded or external PostgreSQL endpoint', () => {
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  const helpers = read('deploy/helm/social-vibecoding-platform/templates/_helpers.tpl');
  assert.match(secret, /social-vibecoding-platform\.postgresqlHost/);
  assert.match(secret, /\.Values\.postgresql\.port/);
  assert.match(helpers, /postgresql\.host is required when postgresql\.enabled=false/);
  assert.match(helpers, /-postgresql\.%s\.svc\.%s/);
});

test('platform, migration, and embedded PostgreSQL have independent activation gates', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const migration = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const ingress = read('deploy/helm/social-vibecoding-platform/templates/ingress.yaml');
  assert.match(platform, /and \.Values\.enabled \.Values\.platform\.enabled/);
  assert.match(migration, /and \.Values\.enabled \.Values\.migration\.enabled/);
  assert.match(postgresql, /and \.Values\.enabled \.Values\.postgresql\.enabled/);
  assert.match(ingress, /\.Values\.platform\.enabled \.Values\.ingress\.enabled/);
});

test('chart default deny selects only chart-owned workloads', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const defaultDeny = policy.split('kind: NetworkPolicy')[1].split('---')[0];
  assert.match(defaultDeny, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(defaultDeny, /podSelector: \{\}/);
  assert.match(policy, /social-vibecoding-platform\.postgresqlPodSelector/);
});

test('PostgreSQL ingress permits only runtime-managed generated app pods', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const postgresqlPolicy = policy.split('kind: NetworkPolicy')[4].split('---')[0];
  assert.match(postgresqlPolicy, /databaseCallerNamespaces/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/managed-by: social-vibecoding-runtime/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/part-of: social-vibecoding/);
  assert.match(postgresqlPolicy, /port: \{\{ \.Values\.postgresql\.port \}\}/);
});

test('public platform ingress is restricted to the Cilium ingress identity', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /internalCallerNamespaces/);
  assert.doesNotMatch(platformPolicy, /ingress:\s*\n\s*- ports:/);
  assert.match(policy, /fromEntities: \[ingress\]/);
  assert.match(policy, /\{port: "3000", protocol: TCP\}/);
});

test('Kubernetes status inventory does not invoke Docker helpers', async () => {
  const status = require('../src/services/status');
  assert.deepEqual(await status.listContainers({ appRuntime: 'kubernetes' }), []);
  assert.deepEqual(await status.getStats({ appRuntime: 'kubernetes' }), {});
});
