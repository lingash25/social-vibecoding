# One frame, glass — design spec

The Homeroom shell redrawn as proposal **B "One frame"** in the skin of
direction **C "Aurora glass"**, as shown beside today's 112 screens in the
screen tour (https://claude.ai/artifact/7Szxx2JDWG8ij7Jxo5apZq, picker
"C · Glass"). This document is what the plans under `../plans/` argue from.
Mockup sources: `~/Dev/lingash/homeroom-screens-2026-11-06/proposal-b/source/`
(`kit.css`, `kit.mjs`, `screens/*.mjs`, `themes/c.css`, `themes/wall.css`).

## Goal

Test the redesign locally, on a copy of production data, before anything is
proposed. The work lands as a **skin** (`<html data-skin="glass">`) that is
off by default, so the current product, its 729 declared checks and its
screenshot baselines keep working while screens are rebuilt one by one.

## The eight rules (proposal B)

1. **One frame.** Every page has the same bar, then a title, one sentence
   saying what the page is for, and at most one primary button.
2. **One row.** Anything listed is the same row: picture, name, one line,
   one status, in that order. Rows are 60px, or 48px for a single line.
3. **Work in the middle, context beside it.** Content sits in one 720px
   column; status, people and rules sit in a 320px column beside it, and
   move above or below it on a phone.
4. **Sections, not widgets.** A page is a stack of labelled groups. No
   bespoke tiles, charts or card grids; the same ten components build every
   screen. (Apps are the one exception: an app is a tile, because it is the
   one thing you launch.)
5. **Blue only means "this waits for you".** Where you are is navy, done is
   green, waiting on others is amber, a problem is red. Nothing else is
   coloured.
6. **One line for progress.** Plan, Build, Checks, Vote, Live is drawn the
   same way wherever a request or a change appears.
7. **Short tasks are sheets.** Signing in, a new message, notifications: one
   sheet, with the same title, sentence and button order as a page.
8. **Words first.** Sentence case, status in words, a zero says nothing, one
   status per row, no emoji as icons.

## The skin (direction C)

The wallpaper is the room; everything else is frosted glass floating in it.
The wallpaper is today's (`--home-wallpaper` in `public/css/app.css`:
`--home-ground` #f4f2e4 / #0b0d1b with the lavender, pink and peach washes),
already painted behind every screen by the fixed pseudo-element.

Tokens, light then dark:

| token | light | dark |
|---|---|---|
| `--surface` | rgba(255,255,255,.58) | rgba(255,255,255,.065) |
| `--sunk` | rgba(55,71,123,.09) | rgba(255,255,255,.08) |
| `--ink` | #1a1e3c | #f1f0fa |
| `--mut` | #565c82 | #aeb0cf |
| `--faint` | #8b90b0 | #7a7d9e |
| `--line` | rgba(55,71,123,.13) | rgba(255,255,255,.12) |
| `--acc` / `--acc-ink` | #3b55e6 / #fff | #8ea2ff / #0a0f2c |
| `--acc-t` | rgba(59,85,230,.12) | rgba(142,162,255,.16) |
| `--lit` / `--lit-t` | #2b3769 / rgba(55,71,123,.11) | #dfe3ff / rgba(199,208,245,.14) |
| `--ok` / `--ok-t` | #0c8346 / #ddf2e6 | #4fd08a / #11311f |
| `--wait` / `--wait-t` | #955000 / #faecd3 | #f2b45c / #35270f |
| `--bad` / `--bad-t` | #bf3529 / #fbe5e2 | #ff8c80 / #3a1815 |
| `--ring` | rgba(255,255,255,.8) | rgba(255,255,255,.12) |
| `--glow` | 0 22px 44px -30px rgba(55,71,123,.55) | 0 22px 44px -30px rgba(0,0,0,.9) |

Glass: `background: var(--surface); backdrop-filter: blur(22px)
saturate(1.4); box-shadow: inset 0 0 0 1px var(--ring), var(--glow)`.
Where `backdrop-filter` is unsupported the surface is opaque
(`--surface` falls back to #fbfbfd light / #171a2b dark).

Type: **Albert Sans** (variable, OFL; vendored, never fetched cross-origin),
system-ui fallback. Scale 36/28 (title desktop/phone, weight 700,
letter-spacing -.035em), 17 (purpose and sheet lead), 15/650 (row title),
13 (row line, crumb, labels), 12/600 (track stage). Row 64px (sm 50px),
side rows 40px. Radii: sidebar 28, card 24, input 16, nav row 14, tabs and
pills full. Sidebar 260px, bar 64px, page inset 32px desktop / 12px phone.
Where you are: ink fill with ground text (sidebar row, tab). Primary
button: `--acc` fill, `--acc-ink` text, shadow `0 12px 24px -12px var(--acc)`.

## Data

The local stack runs on a **full production dump** (the user's choice,
2026-11-08) restored into its own local database, never the fixture one.
That dump holds real people's data, so the stack that reads it must be
unable to act outwardly: `PROCESS_ROLE=web` (no workflow, no clocks, no
digests), and no GitHub, Anthropic or Topochain credentials in its
environment. It stays on this machine.

## Out of scope for the foundation plan

Rebuilding every screen. The foundation delivers the data, the skin, the
frame primitives, Home in the new frame, and a capture harness that shows
today and glass side by side. Later plans take the screens group by group:
sidebar and bar; the project page (Hub, Needs you, Workshop, #general);
Messages and Homeroom bot; You and Settings; signed-out and waitlist
sheets; the request and change pages with the five-stop track.
