# One frame, glass — foundation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the local stack on a copy of production data, add "glass" as a second value of the shell's existing skin switch, build the frame primitives of proposal B in the skin of direction C, and draw Home in them, so the redesign can be judged on real data before anything is proposed.

**Architecture:** The shell already has a device-kept skin switch (`window.Skin` in `frontend/src/head.html`, `data-skin="brand"` on `<html>`, Settings › Experimental, rules scoped in `public/css/app.css`). Glass becomes its second value, in light and dark. New React primitives (`frame.tsx`, `status.tsx`) read skin tokens through CSS variables; the standard look never renders them. Home is the first screen drawn in the frame, after hydration, when the skin is glass; every other screen keeps today's markup until its own plan.

**Tech Stack:** Node 22, React 18 (`frontend/`), Tailwind 3.4.17 compiled from `tailwind.config.js`, `node:test` suites under `tests/` (`tests/lib/render-tsx.js` renders components to strings), Docker Compose dev stack (`docker-compose.dev.yml`), PostgreSQL 17 (`psql`/`pg_restore` 17.2 on the host), Playwright-core with the system Chrome for captures.

**Spec:** `docs/superpowers/specs/2026-11-08-one-frame-glass-spec.md`

**Branch:** `redesign/one-frame-glass`, cut at `c014a80f306559fa84372c56e987ff3dcfbd7909` (canonical main on 2026-11-08). Local experiment; nothing is proposed from it yet.

## Global Constraints

- The shell loads no cross-origin assets: fonts are vendored under `public/fonts/<family>/` with `LICENSE` and `README.md` beside them, and `@font-face` uses the absolute path `/fonts/...` (AGENTS.md "Shell CSS", `tests/new-look.test.js` 'Geist loads from our own origin').
- Stylesheet order stays `native.css` → `app.css` → `tailwind.css`; no fourth link. Glass rules live in `public/css/app.css`, appended after the brand block, every rule scoped to `html[data-skin="glass"]`.
- `data-skin` is set on `<html>` by the head before first paint and never read during a React first render (hydration must match the prerender).
- Interface text is read from `frontend/locales/en/<namespace>.json` as `{ "text", "description" }` entries; no English literal in a component.
- Every Tailwind class in a component or a `cva` table is a complete literal.
- Keep every id, `data-*` and `hidden` semantics a declared check selects on (`dapp.json` `tests`, 729 today) when the skin is off; `npm run test:changed -- --base c014a80f306559fa84372c56e987ff3dcfbd7909` must pass after each task.
- New test files get a `tests/baselines/test-durations.json` entry: `node scripts/test-durations.js --add tests/<file>.test.js`.
- The stack that holds production data runs with `PROCESS_ROLE=web` and empty `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `TOPOCHAIN_PARTNER_API_KEY`. The dump never leaves this machine; its directory is the scratchpad, not the repo.
- Colours: blue (`--acc`) only for what waits for the viewer; `--lit` for where you are; `--ok`/`--wait`/`--bad` for done/waiting on others/problem; nothing else coloured (spec rule 5).
- Copy: sentence case, status in words, a zero says nothing (spec rule 8).

## Review Focus

1. **Blocked `backdrop-filter`** (Firefox with the flag off, some WebViews): a translucent `--surface` over the wallpaper leaves text on washes unreadable. Task 3 pins an `@supports not (backdrop-filter: blur(1px))` fallback to an opaque surface.
2. **Production dump on a dev schema two commits ahead**: boot runs `src/db/migrations/` against it. Task 1 verifies the migration log and that `/api/status` answers 200 before anyone judges a screen.
3. **A viewer with the skin on and a screen not yet rebuilt**: the token block retargets `--dc-sheet*`, `--accent`, `--lit-*`; screens drawn with literal `zinc`/`violet` utilities stay as today. Task 3's test pins that the block redeclares no wallpaper token, so the room stays the room everywhere.
4. **`useSkin()` on the server-rendered first pass**: it must return `'standard'` until mounted, or Home's first render disagrees with the prerender and `console.error`s (which fails checks). Task 4's test pins the initial value.
5. **RTL**: the 720/320 columns and the row's "picture, name, line, status" order must mirror. Task 5 uses logical properties (`ps-`/`pe-`, `ms-auto`, `grid` order) and its test asserts no `pl-`/`pr-`/`ml-`/`mr-` class in `frame.tsx` or `status.tsx`.

---

### Task 1: Production data, locally and inert

**Files:**
- Create: `/private/tmp/claude-501/-Users-salah-Dev-lingash-social-vibecoding/d149dd9c-4cde-4101-8c4f-34970b7ced9a/scratchpad/proddata/dump.sh` (outside the repo)
- Create: `docker-compose.proddata.yml` at the repo root, listed in `.git/info/exclude` (never committed)

**Interfaces:**
- Produces: a local database `usernode_prod` on `postgres://usernode:localdev@localhost:5440/usernode_prod`; the stack at `http://localhost:3000` reading it; the user's own account signed in with a local-only password.

- [ ] **Step 1: The user logs in to the cluster** (OIDC needs their browser; run ONE kubectl at a time):

```sh
! KUBECONFIG=~/.kube/bare-metal-org-github.yaml kubectl -n social-refresh get clusters.postgresql.cnpg.io
```
Expected: a row for `social-postgres-refresh-20260909` with its PRIMARY pod named (was `social-postgres-refresh-20260909-1`).

- [ ] **Step 2: Size the tables** (read-only) to choose what to leave out:

```sh
KUBECONFIG=~/.kube/bare-metal-org-github.yaml kubectl -n social-refresh exec <primary> -c postgres -- psql -U postgres -d app_usernode_2d5619 -Atc "select relname, pg_size_pretty(pg_total_relation_size(c.oid)), pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' order by 3 desc limit 25"
```
Decision rule: exclude the DATA of a table over 500 MB that no shell screen reads (telemetry, logs, raw event streams); keep every table a screen in the tour reads (`events` is read by `services/app-notices.js`, so it stays unless it alone exceeds 2 GB).

- [ ] **Step 3: Write `dump.sh`** — one `pg_dump -U postgres -d app_usernode_2d5619 -Fc --no-owner --no-privileges --exclude-table-data=<t> ...` through `kubectl exec -i`, streamed to `proddata/app_usernode_2d5619.dump`, then `pg_restore --list` to count entries. The user runs it with `!` (the sandbox classifies a production export as a PII read).

- [ ] **Step 4: Restore into its own database**:

```sh
psql postgres://usernode:localdev@localhost:5440/postgres -c 'create database usernode_prod'
pg_restore --no-owner --no-privileges -d postgres://usernode:localdev@localhost:5440/usernode_prod -j 4 proddata/app_usernode_2d5619.dump
psql postgres://usernode:localdev@localhost:5440/usernode_prod -Atc 'select count(*) from users; select count(*) from apps'
```
Expected: users in the hundreds, apps over 100 (the fixture database has 3 and 1).

- [ ] **Step 5: Write `docker-compose.proddata.yml`** overriding only the `app` service: `DATABASE_URL: postgres://usernode:localdev@db:5432/usernode_prod`, `PROCESS_ROLE: web`, and the five credentials from Global Constraints set to `""`. Add the file name to `.git/info/exclude`.

- [ ] **Step 6: Boot and verify**:

```sh
docker compose -f docker-compose.dev.yml -f docker-compose.proddata.yml up -d app
docker logs --since 2m vibecoding-dev 2>&1 | grep -i "migration\|listening\|error" | head
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/status
```
Expected: migrations applied without error, `200`. A failing migration is a finding to report, not something to patch around.

- [ ] **Step 7: A local password for the user's own account** (bcrypt cost 12, inside the container so the library matches):

```sh
docker exec vibecoding-dev node -e "require('bcrypt').hash(process.argv[1],12).then(h=>console.log(h))" '<local password the user types>'
psql postgres://usernode:localdev@localhost:5440/usernode_prod -c "update users set password='<hash>' where username='snait'"
```
Then sign in at `http://localhost:3000/#login`. Expected: Home shows the user's real pinned apps and communities. The password value is not written anywhere but the local database.

- [ ] **Step 8: Record** the exclusions chosen and the restore time in the plan's "Notes" section at the bottom. No commit (nothing in the repo changed).

---

### Task 2: "Glass" as the skin's second value

**Files:**
- Modify: `frontend/src/head.html` (the `window.Skin` IIFE, lines ~398–460)
- Modify: `frontend/src/features/settings/sections/experimental.tsx` (the `new-look-enabled` block, ~line 86)
- Modify: `frontend/src/features/settings/settings.js:790-800` and `:1911`
- Modify: `frontend/locales/en/settings.json` (after `experimental.newLook.description`)
- Modify: `tests/new-look.test.js`
- Test: `tests/glass-skin.test.js` (new)

**Interfaces:**
- Produces: `window.Skin.get(): 'standard' | 'brand' | 'glass'`; `window.Skin.set(skin)` stores `'brand'` or `'glass'` under `localStorage['homeroom:skin']` and removes the key for `'standard'`; `apply()` sets `data-skin` to the stored value or removes it; a URL `?skin=glass|brand|standard` pins the value for this load only (like `?theme=`), nothing stored; `window.Skin.onChange(fn)` unchanged. Settings › Experimental has a second switch `id="glass-look-enabled"` under the New look switch.

- [ ] **Step 1: Write the failing tests** in `tests/glass-skin.test.js`, reusing `runSkin()` from `tests/new-look.test.js` (export it from there, or copy its 20 lines): 

```js
test('glass is stored and applied like brand', () => {
  const { Skin, store, attrs } = runSkin();
  Skin.set('glass');
  assert.equal(store.get('homeroom:skin'), 'glass');
  assert.equal(attrs.get('data-skin'), 'glass');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false);
  assert.equal(attrs.has('data-skin'), false);
});
test('a stored glass is on <html> as soon as the module runs', () => {
  assert.equal(runSkin({ stored: 'glass' }).attrs.get('data-skin'), 'glass');
});
test('?skin= pins the look for this load and stores nothing', () => {
  const r = runSkin({ stored: 'brand', search: '?skin=glass' });
  assert.equal(r.attrs.get('data-skin'), 'glass');
  assert.equal(r.store.get('homeroom:skin'), 'brand');
});
test('Settings › Experimental carries the Glass look switch under New look', () => {
  const src = experimentalSrc();
  assert.ok(src.indexOf('id="new-look-enabled"') < src.indexOf('id="glass-look-enabled"'));
  assert.match(src, /settings:experimental\.glassLook\.label/);
});
test('settings.js saves the glass switch through window.Skin', () => {
  assert.match(settingsJs(), /glass-look-enabled/);
  assert.match(settingsJs(), /Skin\?\.set\?\.\(e\.target\.checked \? 'glass' : 'standard'\)/);
});
```
`runSkin` gains a `search` option that sets `window.location = { search }`.

- [ ] **Step 2: Run them** — `node --test tests/glass-skin.test.js` — Expected: FAIL (`set('glass')` stores nothing today; no `glass-look-enabled`).

- [ ] **Step 3: Extend the head module**: `const SKINS = ['brand', 'glass']`; `get()` returns the pinned URL value if valid, else the stored value if in `SKINS`, else `'standard'`; `set()` stores any value in `SKINS` and removes the key otherwise; `apply()` sets the attribute to `get()` or removes it. Update the comment block to name both looks.

- [ ] **Step 4: Settings**: add the `SwitchRow id="glass-look-enabled"` with `t('settings:experimental.glassLook.label')` and a `<p>` with `glassLook.description` (same markup as the New look block); in `settings.js` wire it beside `new-look-enabled` (change → `Skin.set(checked ? 'glass' : 'standard')`; `onChange` → `checked = Skin.get() === 'glass'`; the two switches are exclusive, so turning one on turns the other's `checked` off through the same listener). Catalog entries:
  - `experimental.glassLook.label`: text "Glass look", description "Label of a switch in Settings, Experimental. When on, Homeroom is drawn as frosted glass panels floating on its wallpaper, with the Albert Sans typeface."
  - `experimental.glassLook.description`: text "Try the glass look: translucent panels on Homeroom's wallpaper, the Albert Sans typeface, and one blue that only marks what waits for you. Light and dark. On for this browser.", description "Explanation under the Glass look switch in Settings, Experimental. Albert Sans is the name of a typeface; keep it as is."

- [ ] **Step 5: Fix `tests/new-look.test.js`** where it pins brand as the only value ('unknown values … read as the standard look' must now treat `'glass'` as known; 'carries the New look switch, last of the switches' becomes "before the Glass look switch").

- [ ] **Step 6: Run** `node --test tests/glass-skin.test.js tests/new-look.test.js tests/language-packs.test.js tests/language-extraction.test.js` — Expected: PASS. Then `node scripts/test-durations.js --add tests/glass-skin.test.js`.

- [ ] **Step 7: Commit**: `git add frontend/src/head.html frontend/src/features/settings frontend/locales/en/settings.json tests/glass-skin.test.js tests/new-look.test.js tests/baselines/test-durations.json && git commit -m "Skin: glass as a second look beside brand"` (with the attribution trailer).

---

### Task 3: Albert Sans and the glass token block

**Files:**
- Create: `public/fonts/albert-sans/AlbertSans-Variable.woff2`, `LICENSE.txt` (OFL 1.1), `README.md` (provenance table like `public/fonts/geist/README.md`: package, version, path, sha384, size)
- Modify: `public/css/app.css` (append after the brand block, which ends before the file's last rule)
- Test: `tests/glass-skin.test.js` (extend)

**Interfaces:**
- Produces: under `html[data-skin="glass"]` the tokens of the spec's table as `--surface --sunk --ink --mut --faint --line --acc --acc-ink --acc-t --lit --lit-t --ok --ok-t --wait --wait-t --bad --bad-t --ring --glow`, plus `--glass-blur: blur(22px) saturate(1.4)`; the product's own tokens retargeted: `--dc-sheet`, `--dc-sheet-solid`, `--dc-sheet-raise`, `--dc-sheet-fill` → `var(--surface)`; `--app-sheet-line` → `var(--ring)`; `--accent` → `var(--acc)`, `--accent-ink` → `var(--acc-ink)`, `--accent-tint` → `var(--acc-t)`; `--lit-ink` → `var(--lit)`, `--lit-tint` → `var(--lit-t)`; `--text-primary` → `var(--ink)`, `--text-secondary` → `var(--mut)`, `--text-muted` → `var(--faint)`; `--border` → `var(--line)`; `font-family: 'Albert Sans', system-ui, -apple-system, 'Segoe UI', sans-serif`. The `.dark` variant redefines the same tokens with the dark column. Defaults for the new tokens also exist on `:root` (so `frame.tsx` renders sanely without the skin): `--surface: var(--dc-sheet-solid)`, `--ink: var(--text-primary)`, `--acc: var(--accent)`, `--lit: var(--lit-ink)`, `--ok #0c8346`, `--wait #955000`, `--bad #bf3529` (and dark values under `.dark`).

- [ ] **Step 1: Failing tests** (append to `tests/glass-skin.test.js`):

```js
test('Albert Sans is served from our own origin with its licence and provenance beside it', () => {
  for (const f of ['AlbertSans-Variable.woff2', 'LICENSE.txt', 'README.md']) assert.ok(fs.existsSync(path.join(ROOT, 'public/fonts/albert-sans', f)), f);
  assert.match(appCss(), /url\('\/fonts\/albert-sans\/AlbertSans-Variable\.woff2'\) format\('woff2'\)/);
});
test('every rule of the glass block is scoped to html[data-skin="glass"]', () => {
  const block = glassBlock(); // from the marker comment "THE GLASS LOOK" to EOF
  for (const sel of selectorsOf(block)) assert.match(sel, /^html\[data-skin="glass"\]|^@/, sel);
});
test('the glass block redeclares none of the counted wallpaper tokens', () => {
  for (const t of ['--home-ground', '--home-wallpaper', '--home-washes', '--home-star', '--home-grain']) assert.doesNotMatch(glassBlock(), new RegExp(`${t}\\s*:`));
});
test('without backdrop-filter the surface is opaque', () => {
  assert.match(glassBlock(), /@supports not \(backdrop-filter: blur\(1px\)\)[\s\S]*--surface: #fbfbfd/);
  assert.match(glassBlock(), /@supports not \(backdrop-filter: blur\(1px\)\)[\s\S]*\.dark[\s\S]*--surface: #171a2b/);
});
test('the glass block comes after the brand block', () => {
  assert.ok(appCss().indexOf('THE NEW LOOK, AN EXPERIMENT') < appCss().indexOf('THE GLASS LOOK'));
});
```
`selectorsOf` reuses the helper `tests/new-look.test.js` uses for its 'every rule … scoped' test.

- [ ] **Step 2: Run** — Expected: FAIL (no font, no block).

- [ ] **Step 3: Vendor the font**: download `@fontsource-variable/albert-sans` (npm tarball, exact version) or Google Fonts' `AlbertSans[wght].ttf` converted to woff2; prefer the fontsource package's `files/albert-sans-latin-wght-normal.woff2` renamed `AlbertSans-Variable.woff2`; write `README.md` with the sha384 and `LICENSE.txt` (the package's OFL). No new dependency in `package.json`.

- [ ] **Step 4: Append the block** to `app.css` headed `/* ── THE GLASS LOOK (Settings › Experimental, off by default) ── */` with the `@font-face`, the `:root` defaults, `html[data-skin="glass"] { … }`, `html[data-skin="glass"].dark { … }`, the `@supports not` fallback, and `html[data-skin="glass"] body { font-family: … }`.

- [ ] **Step 5: Run** `node --test tests/glass-skin.test.js tests/new-look.test.js tests/tailwind-build.test.js` — Expected: PASS. Then `npm run build:css` and open `http://localhost:3000/?skin=glass` on the prod-data stack: the type is Albert Sans and sheets are translucent; nothing else moved.

- [ ] **Step 6: Commit** `public/fonts/albert-sans public/css/app.css tests/glass-skin.test.js` — "Glass look: Albert Sans and the token block".

---

### Task 4: `useSkin()`

**Files:**
- Create: `frontend/src/lib/skin.ts`
- Test: `tests/glass-skin.test.js` (extend)

**Interfaces:**
- Produces: `export type Skin = 'standard' | 'brand' | 'glass'`; `export function currentSkin(): Skin` (reads `window.Skin?.get?.()`, `'standard'` when absent); `export function useSkin(): Skin` — `useState<Skin>('standard')`, then in `useEffect` sets `currentSkin()` and subscribes through `window.Skin.onChange`. Global augmentation `interface Window { Skin?: { get(): Skin; set(s: Skin): void; onChange(fn: () => void): void } }`.

- [ ] **Step 1: Failing test**:

```js
test('useSkin reads standard on the first render and the live skin after mount', () => {
  const mod = loadTsx('frontend/src/lib/skin.ts');
  assert.equal(mod.currentSkin(), 'standard'); // no window.Skin in the test
  const html = renderToHtml(createElement(() => createElement('i', null, mod.useSkin())));
  assert.equal(html, '<i>standard</i>');
});
```
(`loadTsx`, `renderToHtml` and the frontend's `createElement` come from `tests/lib/render-tsx.js`; export `renderToHtml` there if it is not yet.)

- [ ] **Step 2: Run** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** as the Interfaces block says.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — "Skin: useSkin() for islands that draw a look after mount".

---

### Task 5: The frame primitives

**Files:**
- Create: `frontend/@/components/ui/frame.tsx`
- Create: `frontend/@/components/ui/status.tsx`
- Test: `tests/frame-primitives.test.js` (new)

**Interfaces:**
- `frame.tsx` exports:
  - `PageFrame({ title, purpose, primary, tabs, children, side, sideFirst }: { title: ReactNode; purpose?: ReactNode; primary?: ReactNode; tabs?: ReactNode; children: ReactNode; side?: ReactNode; sideFirst?: boolean })` → `<div class="frame …">` holding `<header>` (an `<h1>` title: `text-[28px] md:text-[36px] font-bold tracking-[-0.035em] leading-[1.08]`, a `<p>` purpose `text-[17px] text-[color:var(--mut)]`, the one primary action at the inline end), the tabs row, then `Columns`.
  - `Columns({ main, side, sideFirst })` → `grid md:grid-cols-[minmax(0,720px)_320px] gap-6`; on a phone one column with `side` after `main`, or before it when `sideFirst`.
  - `Group({ label, action, children, id }: { label: ReactNode; action?: ReactNode; children: ReactNode; id?: string })` → `SectionHeader` (from `grouped-list.tsx`) over a `GroupedList`, the group's one surface: `rounded-[24px] bg-[color:var(--surface)] [backdrop-filter:var(--glass-blur)] shadow-[inset_0_0_0_1px_var(--ring),var(--glow)]`.
  - `PrimaryButton(props: ButtonHTMLAttributes)` → `h-10 px-4 rounded-full bg-[color:var(--acc)] text-[color:var(--acc-ink)] font-semibold shadow-[0_12px_24px_-12px_var(--acc)]`; `QuietButton` the same geometry with `bg-[color:var(--surface)] text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--ring)]`.
- `status.tsx` exports:
  - `export type Tone = 'you' | 'here' | 'done' | 'waiting' | 'problem' | 'none'`.
  - `StatusPill({ tone, children })` → `<span data-tone={tone} class="inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-semibold …">`; colour per tone from the tokens: `you` → `bg-[color:var(--acc)] text-[color:var(--acc-ink)]`, `here` → `bg-[color:var(--lit-t)] text-[color:var(--lit)]`, `done` → `bg-[color:var(--ok-t)] text-[color:var(--ok)]`, `waiting` → `bg-[color:var(--wait-t)] text-[color:var(--wait)]`, `problem` → `bg-[color:var(--bad-t)] text-[color:var(--bad)]`, `none` → `text-[color:var(--mut)]` and no fill. Renders nothing when `children` is empty or the number 0.
  - `Track({ stage, waiting, problem, mini }: { stage: 0|1|2|3|4; waiting?: boolean; problem?: boolean; mini?: boolean })` → five `<i data-stage="plan|build|checks|vote|live">` cells with the words from `changes:track.plan|build|checks|vote|live` (catalog entries added in `frontend/locales/en/changes.json`); cells before `stage` are `data-state="done"`, the `stage` cell is `now` (or `wait` when `waiting`, `problem` when `problem`), later cells `todo`; `mini` hides the words (`sr-only`) and is 64px wide.
  - `StatusRow(props: ListRowProps & { status?: ReactNode; tone?: Tone })` → `ListRow` with `trailing={<StatusPill tone={tone}>{status}</StatusPill>}`, `title` 15/650, `subtitle` 13, row `min-h-[64px]` or `min-h-[50px]` when no subtitle.

- [ ] **Step 1: Failing tests** in `tests/frame-primitives.test.js` with `renderComponent(entry, name, props)`:

```js
test('PageFrame draws title, purpose and one primary action in that order', () => {
  const html = renderComponent('frontend/@/components/ui/frame.tsx', 'PageFrame', { title: 'Home', purpose: 'What needs you, and your places.', primary: 'Make a project', children: 'body' });
  assert.ok(html.indexOf('<h1') < html.indexOf('What needs you') && html.indexOf('What needs you') < html.indexOf('Make a project'));
});
test('Columns are 720 and 320 from md, one column before', () => {
  assert.match(renderComponent(FRAME, 'Columns', { main: 'm', side: 's' }), /md:grid-cols-\[minmax\(0,720px\)_320px\]/);
});
test('StatusPill colours by tone and says nothing for zero', () => {
  assert.match(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: 'Vote' }), /data-tone="you"[^>]*bg-\[color:var\(--acc\)\]/);
  assert.equal(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: 0 }), '');
});
test('Track marks done, now and todo around the stage', () => {
  const html = renderComponent(STATUS, 'Track', { stage: 3 });
  assert.equal((html.match(/data-state="done"/g) || []).length, 3);
  assert.match(html, /data-stage="vote"[^>]*data-state="now"/);
  assert.match(html, /data-stage="live"[^>]*data-state="todo"/);
});
test('the primitives use logical spacing only', () => {
  for (const f of ['frame.tsx', 'status.tsx']) assert.doesNotMatch(read('frontend/@/components/ui', f), /\b(pl|pr|ml|mr)-/, f);
});
```

- [ ] **Step 2: Run** `node --test tests/frame-primitives.test.js` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `status.tsx` then `frame.tsx` as the Interfaces block says; `cva` tables with literal classes; catalog entries `track.plan` "Plan", `track.build` "Build", `track.checks` "Checks", `track.vote` "Vote", `track.live` "Live" in `changes.json`, each with a description "One of the five stages of a change's progress line".
- [ ] **Step 4: Run** the file plus `tests/admin-ui-registry.test.js tests/language-extraction.test.js` — Expected: PASS. `node scripts/test-durations.js --add tests/frame-primitives.test.js`.
- [ ] **Step 5: Commit** — "Frame primitives: PageFrame, Columns, Group, StatusPill, Track, StatusRow".

---

### Task 6: Home in the frame

**Files:**
- Create: `frontend/src/features/home/glass/home-glass.tsx`
- Modify: `frontend/src/features/home/index.tsx:133-300` (`HomeScreen`)
- Modify: `frontend/locales/en/home.json`
- Test: `tests/home-glass.test.js` (new)

**Interfaces:**
- Consumes: `useSkin()` (Task 4); `PageFrame`, `Group`, `StatusRow`, `StatusPill`, `PrimaryButton` (Task 5); `homePinsStore` (`pins: HomePin[]`, `joined: JoinedCommunity[]`, `owed: Record<slug, number>`) and `loadHomePins()` from `home-pins-store.ts`; `workshopStore.feed` (rows of `GET /api/workshop/needs-feed`: `id, kind, title, app, number, waiting, yes, no, approve`) loaded the way `features/workshop/index.tsx` loads it; `GET /api/public/apps?include_wallets=0` as `communities-to-join.tsx` reads it; `<AppGrid/>` as today for the apps (spec rule 4's one exception).
- Produces: `export function HomeGlass()`; `HomeScreen` renders `<HomeGlass/>` inside `#home-body` when `useSkin() === 'glass'`, else today's children. The nodes `home.js` still writes into (`#home-communities-section`, `#home-featured-list`, `#home-join-section`) stay in the DOM in both branches, `hidden` in the glass one. `#home-screen`, `#home-body`, `#home-search-bar`, `#home-search-input`, `#home-search-clear`, `#home-apps-section` keep their ids and `hidden` semantics.

Home's shape in the frame (from the C mockup of `s01-home`): title "Home"; purpose "What needs you, then your places."; primary "Make a project" (opens what `create-tile.tsx` opens). Main column: Group "Needs you" (feed rows: lead = the app's tile, title = the request or change title, line = `app · kind #number`, status = "Vote" tone `you` when `approve` is owed, else the `waiting` word tone `waiting`; the group is omitted when the feed is empty), Group "Pinned apps" (`<AppGrid/>`), Group "Your communities" (one `StatusRow` per `pins` entry then `joined` not pinned; status = `owed[slug]` as "N to vote" tone `you`, nothing when 0), Group "Communities to join" (rows from the directory not in `joined`, status "Join" as a `QuietButton`). Side column: Group "This week" (two facts: "N decisions wait for you", "N communities" — zero hides the line). Phone: side column after main.

- [ ] **Step 1: Failing tests** in `tests/home-glass.test.js`:

```js
test('HomeScreen keeps the standard body on the first render', () => {
  const html = renderComponent('frontend/src/features/home/index.tsx', 'HomeScreen');
  assert.match(html, /id="home-apps-section"/);
  assert.doesNotMatch(html, /data-home-glass/);
});
test('HomeGlass keeps the nodes home.js writes to, hidden', () => {
  const html = renderComponent('frontend/src/features/home/glass/home-glass.tsx', 'HomeGlass', {}, { stubs: homeStubs() });
  for (const id of ['home-communities-section', 'home-featured-list', 'home-join-section']) assert.match(html, new RegExp(`id="${id}"[^>]*hidden`));
  assert.match(html, /data-home-glass/);
});
test('an empty Needs you group is not drawn and a zero says nothing', () => {
  const html = renderComponent(HOME_GLASS, 'HomeGlass', {}, { stubs: homeStubs({ feed: [], owed: { 'game-corner': 0 } }) });
  assert.doesNotMatch(html, />Needs you</);
  assert.doesNotMatch(html, /0 to vote/);
});
```
`homeStubs()` stubs `../home-pins-store`, `../../workshop/workshop-store` and `../app-grid` through `loadTsx`'s `stubs` option (the specifier spelled as `home-glass.tsx` imports it); `renderComponent` gains a fourth `options` argument passed to `loadTsx`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement `HomeGlass`** and the branch in `HomeScreen`; catalog entries in `home.json`: `glass.title` "Home", `glass.purpose` "What needs you, then your places.", `glass.make` "Make a project", `glass.needs` "Needs you", `glass.pinnedApps` "Pinned apps", `glass.yourCommunities` "Your communities", `glass.toJoin` "Communities to join", `glass.join` "Join", `glass.vote` "Vote", `glass.toVote_one` "{{count}} to vote", `glass.toVote_other` "{{count}} to vote", `glass.thisWeek` "This week", `glass.decisions_one` "{{count}} decision waits for you", `glass.decisions_other` "{{count}} decisions wait for you", `glass.communities_one` "{{count}} community", `glass.communities_other` "{{count}} communities".
- [ ] **Step 4: Run** `node --test tests/home-glass.test.js tests/frame-primitives.test.js` then `npm run test:changed -- --base c014a80f306559fa84372c56e987ff3dcfbd7909` — Expected: PASS, including every suite that names `features/home/index.tsx`. `node scripts/test-durations.js --add tests/home-glass.test.js`.
- [ ] **Step 5: See it**: `npm run ensure:shell` (writes `public/index.html`, the bundle and `tailwind.css`, all bind-mounted into the running container), then `http://localhost:3000/?skin=glass` signed in on the prod-data stack. Check both themes and a 390px window. Fix what reads wrong against the C mockup (`tsnap.mjs --theme c s01-home` in the tour's `prop2/`), then re-run Step 4.
- [ ] **Step 6: Commit** — "Home in the frame, under the glass look".

---

### Task 7: Today and glass, side by side

**Files:**
- Create: `/private/tmp/claude-501/-Users-salah-Dev-lingash-social-vibecoding/d149dd9c-4cde-4101-8c4f-34970b7ced9a/scratchpad/glass-local/capture.mjs` (adapted from `~/Dev/lingash/homeroom-screens-2026-11-06/runner/capture.mjs`)
- Create: `…/glass-local/steps.json`

**Interfaces:**
- Produces: `node capture.mjs <steps.json>` → for each step, eight images (`today`/`glass` × desktop/phone × light/dark) under `glass-local/png/<id>__<look>__<variant>.png`, and `sheet.html` placing today's four beside glass's four per step. Signed in through a `storageState` saved after the user signs in once in the headed window (the memory's pattern); `?skin=glass&theme=dark` pins the look and theme per context.

- [ ] **Step 1: Write `steps.json`** with the Home steps of the tour (`s01-home`, `s02-home-full`, `s03-home-all-apps`, `s04-home-all-communities`) against `http://localhost:3000`.
- [ ] **Step 2: Run it**; Expected: 32 PNGs, no console errors in the glass contexts (the runner records `console.error`; one is a finding).
- [ ] **Step 3: Review the sheet** against the C mockups and list the differences at the bottom of this plan under "Notes"; each becomes a step in the next plan or a fix here.
- [ ] **Step 4: Delete** the `storageState` file and the headed profile when done (live session cookies).

---

## What comes after this plan

Each later plan takes one group of screens into the frame under the glass skin, in this order, and each starts by extending `steps.json`: (2) the sidebar, bar and phone tab bar as one frame (spec rule 1); (3) the project page — Hub, Needs you, Workshop, All items, #general; (4) Messages and Homeroom bot; (5) You, profiles and Settings; (6) signed-out and waitlist screens as sheets (rule 7); (7) the request and change pages with the five-stop track everywhere a change appears (rule 6). When every screen in the tour is drawn, the skin stops being an experiment and the proposal is written.

## Notes

(filled in during execution: Task 1's exclusions and timings, Task 7's findings)
