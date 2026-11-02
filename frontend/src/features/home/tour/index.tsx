/**
 * `#home-tour` — the five-step welcome tour, which replaced the
 * `#home-welcome` banner (#1561).
 *
 * The banner said the two things the launcher never says, in three lines, and
 * then went away for good. What it could not do is point: "send feedback from
 * the Improve button" names a control, and a new account has no way to tell
 * which of the things in front of it that sentence is about. The tour dims
 * the page, cuts a hole around the thing it is talking about, and puts the
 * sentence next to it.
 *
 * ── Real controls, every step ─────────────────────────────────────────
 *
 * Nothing here is a drawing of the product. The Improve arc works because the
 * Improve row is reachable on Home: the app's own menu, behind the Homeroom
 * mark, targeting the platform's own self-hosted row for as long as Home is up
 * (`Home.publishImproveTarget`, #1367). So steps 3 to 5 are one interaction
 * rather than three descriptions (step 1, what a community is, and step 2,
 * My apps, only describe what they point at):
 *
 *   * step 3 spotlights the MARK that opens that menu, asking the viewer to
 *     press it. The click is NOT intercepted: the tour subscribes to
 *     `appContextStore` and advances when `open` goes true, so what opens the
 *     panel is the product's own handler and the tour is only watching. Its
 *     Next opens the menu through `AppContext.open()` — the same path — and
 *     the same watcher advances it, so Next never lands on step 4 with the
 *     menu shut;
 *   * step 4 spotlights `#improve-quick-actions`, the well holding Give
 *     feedback and New change INSIDE the menu the viewer just opened. It is
 *     DESCRIBED, not driven: the cut-out blocks the press the way the dim
 *     around it does, because each of them leaves the tour (a dialog, a new
 *     session) and a spotlight is not an instruction to press.
 *     ./tour-steps.ts carries the whole argument;
 *   * the steps after it shut the menu through `Improve.close()`, the
 *     controller's own close path and never a write into its DOM, then point
 *     at the Messages tab, where Homeroom bot is, and the Me tab, whose
 *     screen holds Settings, where the tour can be replayed.
 *
 * ── The island rules, and how each is kept ────────────────────────────
 *
 * This is a fixed overlay that ships in the shell and starts `hidden`, the
 * same arrangement as `#mobile-install-banner` and the banner it replaces:
 *
 *   * THE FIRST RENDER IS THE PRERENDERED MARKUP. Nothing viewer-dependent
 *     is read during render. `open` is false, `index` is 0 and `confirming`
 *     is false on both sides of hydration, so the built document and the
 *     first client pass emit the same tree: step 1's copy, hidden.
 *   * VISIBILITY RIDES REFS. The root, the cut-out, Next and the
 *     confirmation all carry CONSTANT class strings with `hidden` exactly
 *     where the prerender has it, and the toggles go through `useHiddenClass`
 *     / `useClassToggle` or, for the nodes the geometry pass owns, a
 *     `classList` write inside that pass. See ../../../lib/legacy-dom.ts.
 *   * GEOMETRY IS WRITTEN, NOT RENDERED. The shades, the cut-out and the
 *     card's position are `style` writes through refs, for the reason
 *     features/settings/sections/theme.tsx writes its caret index that way:
 *     the shipped markup carries no `style` attribute, and a measured pixel
 *     is not something to reconcile. It also means a resize, a scroll or the
 *     panel's slide re-measures without a React render.
 *
 * Nothing in `public/js/**` writes into this subtree, so the region is
 * React-owned end to end and may hold state (AGENTS.md).
 *
 * ── Following the target, and jumping to the next one ─────────────────
 *
 * The hole is measured once per animation frame for as long as the overlay
 * is up, and written only when the numbers move. It used to be measured on a
 * 50ms ticker for 600ms after each step change, which covered the kit
 * sheet's entrance spring and nothing after it -- and on a phone the panel
 * keeps moving after it: `Improve.open()` refreshes the sessions list over
 * the network once the sheet is up, a session state tick reloads it while
 * the panel is open, the Chats group appears when its bootstrap answers, and
 * the deploy note comes and goes. Every one of those changes the height of a
 * bottom-anchored, content-sized sheet, and the kit answers by holding the
 * top edge and springing the sheet to its new rest (native.js's watchSize),
 * so every row moves by exactly that much. None of those motions announces
 * itself -- a spring on a transform fires no event and no ResizeObserver --
 * so the only signal that is always right is the next frame.
 *
 * Between steps it JUMPS (#3240). The shades, the ring and the card used to
 * carry a 200ms CSS transition, and the per-frame measure rewrote them every
 * frame the target moved (the page's smooth scroll, the sheet's spring), so
 * each write restarted the ease from wherever it had got to: the box chased
 * the menu for over half a second, the four shades and the ring each ran
 * their own curve and came apart (bright bands, a ring squashed to a pill),
 * and the card said step 3 while the ring was still on step 2. Now nothing
 * here animates. On a step change the card goes transparent and the previous
 * hole stays where it was; the new target is measured every frame until it
 * has held still for SETTLE_FRAMES frames, with no CSS transition still
 * running on it or on anything it sits in (or SETTLE_CAP_MS has passed), and
 * then the hole, the ring and the card are painted in one frame. After that
 * the hole is glued to the target, frame by frame, with nothing to lag. A
 * hole under MIN_HOLE (./spotlight.ts) is a target still arriving, not a
 * target, so it is waited out rather than painted as a blue line.
 *
 * ── Where the card goes while the panel is open ────────────────────────
 *
 * Beside the panel, never on it. On desktop, where the panel is a right-side
 * sheet, the card's right edge sits one gap from the panel's left edge and
 * lines up vertically with the middle of the highlighted row, so the eye
 * travels straight across from the sentence to the control. On a narrow
 * viewport the panel takes the whole width and there is no "beside" left, so
 * the rule relaxes to the weaker one: clear of the ROW, above or below it,
 * rather than clear of the panel. ./spotlight.ts's `placeCardForPanel` is
 * both halves, and the fallback is a call to the ordinary `placeCard`.
 *
 * ── One shape dims; four shades block ─────────────────────────────────
 *
 * A `box-shadow` spread paints a dim but receives no pointer events, so it
 * cannot block a click, and the menu step needs exactly that split: the
 * cut-out must pass clicks through to the real mark while the dimmed area
 * keeps swallowing them. The four panels around the hole are the blockers,
 * and the hole is then genuinely a hole. They used to be the dim as well,
 * which gave a rounded ring square corners of undimmed page (#3240), so the
 * dim is now the spotlight's own shadow, which follows its `rounded-xl`, and
 * the four panels are transparent. With no hole to cut (a target that is not
 * on screen) the top panel, which then covers the screen, takes the dim.
 *
 * ── z-index ────────────────────────────────────────────────────────────
 *
 * `z-[9993]`, which is deliberate rather than a round number. The Improve
 * panel is `z-50` on desktop, but on touch the kit ADOPTS it into `.un-sheet`
 * (native.css: backdrop 9990, sheet 9991, popover 9992), and the cut-out has
 * to land on the panel's rows on a phone too. 9993 clears all three and stays
 * under the kit's own feedback pill (9995) and debug affordance (99999).
 *
 * ── When it opens, and when it gets out of the way ─────────────────────
 *
 * Only when somebody asks (#3240). It used to open by itself on the first
 * sign-in that reached Home, straight after "What communities do you want to
 * join?", and the two screens said the same things back to back. Settings'
 * "Replay the tour" is the way in (Home's Getting started card offered it
 * too, until #4635 retired the card), and it asks through ./tour-request.ts.
 * That path ignores whether the
 * tour was finished before and waits only for Home to be on screen, which is
 * where every step points. Nothing opens it on the `?shot=`, `?demo=` and
 * `?token=` routes except a press, so the platform's declared checks never
 * meet the overlay, with ONE exception that is asked for by name:
 * `?shot=welcome-tour` (#3567) opens it at step 1 once Home is up, the way
 * `?shot=join-communities` draws the join screen, so a declared check can
 * see the tour's first card. That route writes nothing: no kept step, no
 * "done" here or on the account (`isTourShot`).
 *
 * Once it is up it PAUSES rather than fights. Whenever Home leaves the screen,
 * or any kit surface that is not the Improve panel is presented (a dialog, a
 * sheet, an alert), the overlay hides and the step is kept; it comes back at
 * the same step when the viewer does. A panel step whose panel is no longer
 * open resumes at the Improve step instead, which is the one place in the arc
 * that stands on its own.
 *
 * Finish and Skip record "done" in this browser and on the account
 * (./tour-done.ts). A browser that finished the tour before the account
 * kept the answer copies it there once.
 *
 * ── A reload is not a restart ──────────────────────────────────────────
 *
 * Nothing here moves a tour backwards except Back, so a viewer who pressed
 * Next and saw step 1 again had their document replaced under them: the
 * shell reloads itself once its replacement build is cached after a cold
 * boot from the worker cache (App._reloadPrefetchedShellIfSafe), and the
 * boot-time session reconcile reloads when the server disagrees about the
 * session. Both land during the first seconds on Home, which is exactly when
 * the tour is up, and a tour that only remembered "finished" started over at
 * step 1 every time -- the "looping between the first and second step" that
 * was reported. The step now rides sessionStorage (./tour-storage.ts), a
 * reloaded document resumes there (`resumeIndex`, ./tour-steps.ts), and the shell's
 * automatic reload treats a live `#home-tour` the way it treats a draft in a
 * textarea: not now (App._hasUnsavedShellInput).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../../lib/i18n/react';
import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { isEmbeddedPanel } from '../../../lib/side-panel-mode';
import { readVisibility, useVisibility } from '../../../lib/visibility-store';
import { AppContext } from '../../app-context/app-context-controller.js';
import { appContextStore } from '../../app-context/app-context-store.js';
import { Improve } from '../../improve/improve-controller.js';
import { improveStore } from '../../improve/improve-store.js';
import {
  BAR_PAD, bottomBarInset, CARD_GAP, cardWidth, findTarget, fitHole, fitHoleIn, padRect,
  placeCardForPanel, panelBox, roundBox, shadeBoxes, SPOTLIGHT_PAD, usableHole, type Box,
} from './spotlight';
import { markDoneOnServer, needsBackfill, serverDone, sessionVerified } from './tour-done';
import { useTourRequest } from './tour-request';
import {
  clampIndex, IMPROVE_STEP_INDEX, isLastStep, nextOpensMenu, resumeIndex, stepAt, stepCounter,
  stepFrom, TOUR_LENGTH,
} from './tour-steps';
import {
  clearDone, clearStep, currentUserId, readDone, readStep, writeDone, writeStep,
} from './tour-storage';

/** How long to keep waiting for Home before giving up on this page load. */
const HOME_WAIT_TRIES = 60;
const HOME_WAIT_MS = 300;
/**
 * A step's target is painted once its box has measured the same for this
 * many frames in a row, or once SETTLE_CAP_MS has passed, whichever is first
 * (#3240). The cap is the kit sheet's entrance spring with room to spare.
 */
const SETTLE_FRAMES = 2;
const SETTLE_CAP_MS = 700;

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Kit surfaces. Anything presented in one of these that is not one of the
 * tour's OWN two means the viewer is in a flow the tour must get out of the
 * way of. app.css already keys off this vocabulary
 * (`.un-sheet:has(#apps-switcher-sheet)`), so it is the kit's published seam rather
 * than a guess.
 */
const KIT_SURFACES = '.un-modal, .un-sheet, .un-alert';

/**
 * The two surfaces the tour drives, and therefore does not pause for.
 *
 * The Improve panel has always been one. #2718 added the app's own menu,
 * and it is not a refinement — it is required: on TOUCH that sheet is adopted
 * into a `.un-sheet`, so a tour that paused for it would open the menu on the
 * menu step and hide itself in the same frame, leaving the
 * viewer a presented sheet and no card. The web presentation is not a kit
 * surface at all, which is why this is only ever wrong on a phone — the
 * surface the tour is most often run on.
 */
const TOUR_OWNED_SURFACES = ['#apps-switcher-sheet'];

// ── Class strings ──────────────────────────────────────────────────────
//
// Complete literals, every one of them: Tailwind's extractor is a regex over
// source text, so a class name assembled at runtime is a class name that
// never gets compiled. `violet-*` is the shell's accent (tailwind.config.js);
// the admin console's `indigo` vocabulary is a different system and does not
// cross over (AGENTS.md).

// `pointer-events-none` on the root, re-enabled per child: that is what lets
// the cut-out be a real hole while the shades around it still block.
//
// NO TRANSITIONS anywhere below (#3240): see "Following the target, and
// jumping to the next one" in the header.
const ROOT = 'hidden fixed inset-0 z-[9993] overflow-hidden pointer-events-none';
// Transparent: the shades only BLOCK. The dim is the spotlight's shadow.
const SHADE = 'absolute pointer-events-auto';
// The dim the top shade takes when there is no hole to cut, and so covers
// the whole screen by itself. Toggled a class at a time in the geometry
// pass; each is a complete literal so Tailwind compiles it.
const NO_HOLE_DIM = ['bg-zinc-950/60', 'dark:bg-zinc-950/75'] as const;
// The cut-out: its outline (`ring-2`) and the dim around it (a shadow spread
// far past every edge of the screen, clipped by the root's overflow), both
// following the same `rounded-xl`, so the dim's corners are the ring's. The
// shadow colour rides `shadow-zinc-950/60`; Tailwind swaps the arbitrary
// shadow's own colour for it. No pointer-events utility in the rendered
// string: it inherits `none` from the root, and a step that only DESCRIBES
// its target adds `pointer-events-auto` through useClassToggle so the
// highlighted control cannot be pressed there.
const SPOT = 'hidden absolute rounded-xl ring-2 ring-violet-500 dark:ring-violet-400 '
  + 'shadow-[0_0_0_200vmax_black] shadow-zinc-950/60 dark:shadow-zinc-950/75';
// At most the float box (app.css THE USABLE BOX: the window less the Duo's
// column) less the 12px a side the placement keeps.
const CARD = 'absolute w-[340px] max-w-[calc(var(--platform-float-w)-1.5rem)] rounded-2xl border border-zinc-200 '
  + 'dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xl focus:outline-none '
  + 'pointer-events-auto';
// The card while its step's target settles: laid out and measurable, and
// still focusable, which `invisible` would not be.
const CARD_SETTLING = 'opacity-0';

/**
 * True on the routes that must render the same way every single time — and in
 * the side panel's document (`?panel=1`, beside a running app), which never
 * shows Home and whose top window runs the tour.
 */
function isDeterministicRoute(): boolean {
  if (isEmbeddedPanel()) return true;
  try {
    const params = new URLSearchParams(location.search);
    return !!(params.get('shot') || params.get('demo') || params.get('token'));
  } catch {
    return false;
  }
}

/**
 * The tour's own screenshot state (#3567): `?shot=welcome-tour` opens the
 * tour at step 1 and lets it be walked, Next, Back and Skip included, while
 * writing nothing. Not in the side panel's document, which never shows Home.
 */
const TOUR_SHOT = 'welcome-tour';
function isTourShot(): boolean {
  if (isEmbeddedPanel()) return false;
  try {
    return new URLSearchParams(location.search).get('shot') === TOUR_SHOT;
  } catch {
    return false;
  }
}

function homeVisibleNow(): boolean {
  // The router publishes Home's visibility (../../../lib/visibility-store.ts);
  // the DOM is the fallback for the window before it has said anything, which
  // is exactly the fallback App._isScreenVisible makes for the same reason.
  const published = readVisibility('home-screen');
  if (published !== undefined) return published;
  const el = document.getElementById('home-screen');
  return !!el && !el.classList.contains('hidden');
}

/** Resolves true once Home is on screen, false if it never arrives. */
function whenHomeVisible(): Promise<boolean> {
  if (homeVisibleNow()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (homeVisibleNow()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (tries >= HOME_WAIT_TRIES) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, HOME_WAIT_MS);
  });
}

/** The join screen's gate (../../auth/communities-first-run.js). */
type FirstRunGate = { applies?: () => boolean; shownHere?: () => boolean };
function communitiesGate(): FirstRunGate | undefined {
  return (window as unknown as { CommunitiesFirstRun?: FirstRunGate }).CommunitiesFirstRun;
}

/** Is a join screen still to come in this document? */
function firstRunPending(): boolean {
  try { return communitiesGate()?.applies?.() === true; } catch { return false; }
}

/** Did this document show the join screen? */
function firstRunShownHere(): boolean {
  try { return communitiesGate()?.shownHere?.() === true; } catch { return false; }
}

/**
 * The status bar's height, in px; 0 in a browser tab. Measured, because in
 * the app the value is `env(safe-area-inset-top)` behind the shell's
 * `--platform-safe-top` token, which no script can read as a number.
 */
let safeTopCache: number | null = null;
function safeTopInset(): number {
  if (safeTopCache != null) return safeTopCache;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;' +
    'pointer-events:none;height:var(--platform-safe-top, env(safe-area-inset-top, 0px))';
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  safeTopCache = Number.isFinite(px) ? px : 0;
  return safeTopCache;
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { safeTopCache = null; });
}

/**
 * How much of the bottom of the screen the tab bar covers, for a target that
 * is NOT one of its tabs (QA 2026-09-24 Q30d); 0 with no bar on screen, when
 * the step points at a tab, which is in the bar, or when the bar is not
 * along the bottom at all: from 768px up it is the sidebar rail, and taking
 * that for a bottom bar is what drew three steps as a blue line on a laptop
 * (#3240, ./spotlight.ts `bottomBarInset`).
 */
function tabBarInset(target: HTMLElement | null): number {
  const bar = document.getElementById('platform-tabs');
  if (!bar || (target && bar.contains(target))) return 0;
  return bottomBarInset(bar.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
}

/**
 * The bar a target lives in, the header or the tab bar (or rail), if any
 * (#3240). A target inside one keeps its hole inside that bar, is not
 * clamped against it, and is never scrolled to: the bars do not scroll.
 */
function barOf(target: HTMLElement | null): HTMLElement | null {
  if (!target) return null;
  for (const id of ['platform-header', 'platform-tabs']) {
    const bar = document.getElementById(id);
    if (bar && bar.contains(target)) return bar;
  }
  return null;
}

/** Where the header ends, so a scroll can land a target just below it. */
function headerBottom(): number {
  const header = document.getElementById('platform-header');
  if (!header) return 0;
  const rect = header.getBoundingClientRect();
  return rect.height > 0 ? Math.max(0, rect.bottom) : 0;
}

/** The element that scrolls `el`: its nearest scrolling ancestor, else the page. */
function scrollerOf(el: HTMLElement): Element {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Bring a step's target into view (QA 2026-09-24 Q30d). Centred when it fits
 * between the header and the tab bar, as before. A target TALLER than that
 * band (Challenges, on a phone) is lined up by its START instead, just below
 * the header: centring it pushed its heading off the top, leaving the card
 * nothing to sit under but the section's middle.
 *
 * At once, never smoothly (#3240): a smooth scroll moved the target under a
 * box that was still easing towards it, and the step now paints only once
 * its target has stopped moving, so a scroll that takes 400ms is 400ms of
 * waiting. A target in the header or the tab bar is on screen already and
 * is not scrolled at all: centring the mark used to move Home by 160px.
 */
function bringIntoView(target: HTMLElement): void {
  if (barOf(target)) return;
  const rect = target.getBoundingClientRect();
  const top = headerBottom();
  const band = window.innerHeight - tabBarInset(target) - top;
  const behavior: ScrollBehavior = 'auto';
  try {
    if (rect.height + SPOTLIGHT_PAD * 2 > band) {
      scrollerOf(target).scrollBy({ top: rect.top - (top + SPOTLIGHT_PAD + CARD_GAP), behavior });
    } else {
      target.scrollIntoView({ block: 'center', behavior });
    }
  } catch {
    target.scrollIntoView();
  }
}

/** Scroll Home back to its top, where the tour found it. */
function backToTopOfHome(): void {
  const home = document.getElementById('home-screen');
  if (!home || home.classList.contains('hidden')) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  home.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}

/**
 * #5528: Finish ends the tour ON the Communities page, the one its first card
 * pointed at. The same address the Communities tab opens (`tab-bar.tsx`, and
 * `outer-level.tsx` navigates the same way): a plain hash assignment, which
 * pushes a history entry, so Back returns to Home. Not the community-scope
 * setter (`goToCommunity` with null), which would reset the tab's chosen
 * community scope and forget the resumable Workshop view; the tour changes
 * neither.
 */
function goToCommunities(): void {
  if (window.location.hash !== '#communities') window.location.hash = '#communities';
}

/**
 * Is a CSS transition or animation still moving the target, or a box it sits
 * in (#3240)? The desktop menu scales in over 140ms with an ease-out, whose
 * last frames move less than a pixel each, so two frames that measure the
 * same are not proof it has stopped. Finite ones only: an endless spinner
 * somewhere above the target would otherwise hold every step to the cap.
 */
function targetAnimating(target: HTMLElement | null): boolean {
  if (!target || typeof document.getAnimations !== 'function') return false;
  try {
    return document.getAnimations().some((anim) => {
      if (anim.playState !== 'running') return false;
      const effect = anim.effect as KeyframeEffect | null;
      const el = effect?.target;
      if (!(el instanceof Element) || !el.contains(target)) return false;
      return effect?.getComputedTiming().endTime !== Infinity;
    });
  } catch {
    return false;
  }
}

/** Is a kit surface other than the tour's own two presented right now? */
function otherSurfacePresented(): boolean {
  for (const el of document.querySelectorAll(KIT_SURFACES)) {
    if (!TOUR_OWNED_SURFACES.some((sel) => el.querySelector(sel))) return true;
  }
  return false;
}

/**
 * THE SURFACE THESE STEPS ARE ON (#2718 review). It was the Improve panel and
 * it is the mark's menu: the panel retired, and its two actions are rows of
 * the menu now. Everything below that says "panel" means this one surface,
 * and `Improve.open()` / `Improve.close()` still name it — the controller
 * forwards both to AppContext.
 */
function panelOpenNow(): boolean {
  return !!appContextStore.get().open;
}

export function OnboardingTour() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const spotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [otherSurface, setOtherSurface] = useState(false);

  // The card's words (the step's are message ids; the counter reads the
  // runtime), in the language on screen.
  const t = useMessages('onboarding');
  const step = stepAt(index);
  const last = isLastStep(index);

  // Home's visibility, as a subscription. `true` is the shipped value, which
  // is also what the DOM fallback answers before the router has published.
  const homeVisible = useVisibility('home-screen', true);
  // Paused: still running, just not on screen. Derived, so there is no second
  // piece of state to keep in step with the two it is made of.
  const paused = !homeVisible || otherSurface;
  const live = open && !paused;

  // Read inside listeners that are registered once, so they never close over
  // a stale step.
  const indexRef = useRef(index);
  indexRef.current = index;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  useHiddenClass(rootRef, !live);
  useHiddenClass(bodyRef, confirming);
  useHiddenClass(confirmRef, !confirming);
  useClassToggle(spotRef, 'pointer-events-auto', !step.interactive);

  // ── The viewer ───────────────────────────────────────────────────────
  //
  // Resolved in an effect, never during render: `App.user` is a classic-script
  // global populated only once the session has been read, which is after
  // hydration.
  useEffect(() => {
    const resolve = () => {
      const id = currentUserId();
      if (id != null) setUserId(id);
    };
    resolve();
    document.addEventListener('sv:authed', resolve);
    return () => document.removeEventListener('sv:authed', resolve);
  }, []);

  const start = useCallback((at = 0) => {
    setIndex(clampIndex(at));
    setConfirming(false);
    setOpen(true);
    // A step of the person's path (#3369); never the screenshot state.
    if (!isTourShot()) (window as any).UITelemetry?.navigate?.('tour');
  }, []);

  // ── A reload under a tour comes back to it ───────────────────────────
  //
  // `started` is per document and one-way: the resume below never fires a
  // second tour over one a press has opened. The tour opens only when asked
  // (#3240), so the one thing that opens it without a press is a document
  // reloaded under a tour in progress: the step it had reached rides this
  // page session (./tour-storage.ts), and the tour comes back there rather
  // than vanishing. A tab that never had a tour has no step, and nothing
  // opens.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || userId == null) return;
    if (isDeterministicRoute()) return;
    const saved = readStep(userId);
    if (saved == null) return;
    let cancelled = false;
    void (async () => {
      const home = await whenHomeVisible();
      if (cancelled || started.current || !home) return;
      started.current = true;
      start(resumeIndex(saved));
    })();
    return () => { cancelled = true; };
  }, [userId, start]);

  // ── A join screen shown here forgets this browser's "done" ───────────
  //
  // It shows for a new account, or for one an admin reset (Admin → Users →
  // ⋯ → Reset first run), and the reset cleared the account's "done" so the
  // card offers the tour again. This browser's copy goes with it, or the
  // backfill below would write it straight back on the next load. Looked at
  // again when the screen is answered, which on a snapshot boot is after the
  // first look (app.js _reconcileSession).
  useEffect(() => {
    if (userId == null) return;
    const forget = () => {
      if (!firstRunShownHere()) return;
      clearDone(userId);
      clearStep(userId);
    };
    forget();
    document.addEventListener('sv:communities-joined', forget);
    return () => document.removeEventListener('sv:communities-joined', forget);
  }, [userId]);

  // ── The account keeps the answer ─────────────────────────────────────
  //
  // A browser that finished the tour before the account kept "done" copies
  // its flag there, once, so the next device does not offer it again. Only
  // against a VERIFIED user (./tour-done.ts says why), so a boot from the
  // session snapshot looks again on `sv:session`, which app.js dispatches
  // with the server's user once it has confirmed the session.
  const backfilledFor = useRef<number | null>(null);
  useEffect(() => {
    if (userId == null || isDeterministicRoute()) return;
    const check = () => {
      if (backfilledFor.current === userId || !sessionVerified(userId)) return;
      if (!needsBackfill({
        serverDone: serverDone(userId),
        localDone: readDone(userId),
        joinShownHere: firstRunShownHere(),
        joinPending: firstRunPending(),
      })) return;
      backfilledFor.current = userId;
      void markDoneOnServer(userId, { ended: 'backfill' });
    };
    check();
    document.addEventListener('sv:session', check);
    return () => document.removeEventListener('sv:session', check);
  }, [userId]);

  // ── Where the viewer is, kept across a reload ────────────────────────
  //
  // Written on every step while the tour is up, so a reload -- whichever of
  // the shell's own reasons caused it -- comes back here rather than at step
  // 1. Cleared by finish(), because a finished tour has nowhere to resume.
  useEffect(() => {
    if (!open || userId == null || isTourShot()) return;
    writeStep(userId, index);
  }, [open, index, userId]);

  // ── `?shot=welcome-tour`: the declared check's way in (#3567) ────────
  //
  // Opens at step 1 once Home is on screen, and claims the document so the
  // resume above cannot also fire. Everything after is the ordinary tour.
  useEffect(() => {
    if (!isTourShot()) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const home = await whenHomeVisible();
      if (cancelled || !home) return;
      start();
    })();
    return () => { cancelled = true; };
  }, [start]);

  // ── Asked for: Settings' Replay ──────────────────────────────────────
  const request = useTourRequest();
  const seenRequest = useRef(0);
  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    // Claim the document so the resume cannot also fire.
    started.current = true;
    let cancelled = false;
    void (async () => {
      const home = await whenHomeVisible();
      if (cancelled || !home) return;
      start();
    })();
    return () => { cancelled = true; };
  }, [request, start]);

  // ── The mark's menu ──────────────────────────────────────────────────
  //
  // Watched, never driven. The advance fires on the EDGE into open, so the
  // viewer's own press on the real control is what moves the tour on and a
  // step cannot skip itself just because the menu happens to be up.
  useEffect(() => {
    if (!open) return;
    let was = panelOpenNow();
    setPanelOpen(was);
    return appContextStore.subscribe(() => {
      const now = panelOpenNow();
      if (now === was) return;
      was = now;
      setPanelOpen(now);
      if (now && stepAt(indexRef.current).advanceOn === 'menu-open') {
        setIndex((i) => clampIndex(i + 1));
      }
    });
  }, [open]);

  // ── Anything else the kit has presented ──────────────────────────────
  //
  // The kit mounts its surfaces on `body`, so a childList observer on body is
  // the whole detector. It runs only while the tour is up.
  useEffect(() => {
    if (!open) return;
    const read = () => setOtherSurface(otherSurfacePresented());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [open]);

  // ── The Improve step arrives with a clean slate ──────────────────────
  //
  // Two things have to be true when it presents, and they are ORDERED, which
  // is the whole reason they are one effect rather than two.
  //
  // THE PANEL MUST BE SHUT. The step's instruction is "press Improve" and it
  // ends on the panel OPENING, so arriving with it already up is a dead end:
  // there is no edge left to wait for. Whichever way the viewer got here —
  // Back from step 4, or a panel opened through an earlier cut-out — it is
  // shut again through the controller's own close path. That is also the
  // answer to what Back does with a still-open panel: it closes it, so the
  // step always presents the same way.
  //
  // THEN THE APP'S MENU OPENS, because #2718 made the step's target a row of
  // it and a row inside a closed sheet has no box for ./spotlight.ts to find.
  // It WAITS for the panel's teardown rather than racing it: on touch the kit
  // cannot present a surface while it is still dismissing another, which is
  // the ordering lib/sheet-controller.js's dismissForNav exists for and the
  // reason `Improve.close()` is awaited here rather than fired and forgotten.
  // (AppContext.open's own `_closeSiblings` dismisses the panel too, but it
  // does not await it — that is the race, not the fix for it.)
  //
  // THE MENU STEP ARRIVES WITH THE MENU SHUT (#2718 review).
  //
  // `opensSheet` retired with the Improve panel. It existed because the step's
  // target was a ROW INSIDE the menu, which has no box for ./spotlight.ts to
  // find while the menu is closed — so the tour had to present the surface
  // first. The target is the MARK now, which is on screen on every route, so
  // there is nothing to present and the viewer's own press is the whole step.
  //
  // What is left is the other half: arriving here with the menu already up
  // would mean the edge into `open` never fires and the step could not
  // advance. So it shuts it, once, on arrival — which is what the deps say.
  useEffect(() => {
    if (!live) return;
    if (stepAt(index).advanceOn !== 'menu-open') return;
    if (panelOpenNow()) void Improve.close();
  }, [live, index]);

  // The steps after the menu's end the arc by shutting the panel itself — and
  // the app's menu with it, because a step that carries `closesPanel`
  // spotlights a tab, and on a phone the menu's sheet is drawn over the tab bar, hiding the thing the
  // cut-out is drawn around.
  useEffect(() => {
    if (!live) return;
    if (!stepAt(index).closesPanel) return;
    if (panelOpenNow()) void Improve.close();
    if (appContextStore.get().open) void AppContext.close();
  }, [live, index]);

  // A panel step with no panel cannot be shown. Falling back to the Improve
  // step is the resume rule: a viewer who closed the panel, or who came back
  // from a feedback draft or a new change, is asked to press Improve again
  // rather than being shown a card pointing at nothing. Gated on `live`, so a
  // flow in progress finishes first.
  useEffect(() => {
    if (!live) return;
    if (!stepAt(index).needsPanel) return;
    if (panelOpen) return;
    setIndex(IMPROVE_STEP_INDEX);
  }, [live, index, panelOpen]);

  // ── Geometry ─────────────────────────────────────────────────────────
  //
  // One pass: find the step's target, lay the four shades around it, outline
  // it, and put the card beside it. Called from the layout effect below on
  // every state change and then once per frame while the overlay is up,
  // which is why it writes the DOM rather than setting state -- and why it
  // writes only when the numbers have moved: the last geometry painted is
  // kept as one string, and a frame that measures the same thing touches
  // nothing.
  //
  // While a step SETTLES (#3240) it measures and does not write, except to
  // dim the whole screen when nothing has been painted yet; see "Following
  // the target, and jumping to the next one" in the header.
  const paintedRef = useRef('');
  const settleRef = useRef<{ since: number; last: string; stable: number } | null>(null);
  const apply = useCallback(() => {
    const card = cardRef.current;
    const spot = spotRef.current;
    const shades = [topRef.current, rightRef.current, bottomRef.current, leftRef.current];
    if (!card || !spot || shades.some((el) => !el)) return;
    const target = findTarget(stepAt(indexRef.current).targets);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // QA 2026-09-24 Q30d: the hole is fitted to where its ring can be seen,
    // inside the screen's edges and above the tab bar unless the target is
    // a tab, and the card keeps above the bar by the same inset. #3240: and
    // below the header unless the target is in it; a target that IS in a
    // bar keeps its hole inside that bar, with a tab's padding kept small.
    const bottomInset = tabBarInset(target);
    const bar = barOf(target);
    let hole: Box | null = null;
    if (target) {
      const rect = roundBox(target.getBoundingClientRect());
      if (bar) {
        const inTabs = bar.id === 'platform-tabs';
        hole = fitHoleIn(padRect(rect, inTabs ? BAR_PAD : SPOTLIGHT_PAD), roundBox(bar.getBoundingClientRect()));
      } else {
        hole = fitHole(padRect(rect), viewport, bottomInset, headerBottom());
      }
    }
    const ready = usableHole(hole);

    // The card's width goes first because its height, measured next, depends
    // on it. Written only when it changes, so a steady frame touches nothing.
    const width = cardWidth(viewport.width);
    if (card.style.width !== `${width}px`) card.style.width = `${width}px`;
    // The card must not sit ON the Improve panel while it is open: a tooltip
    // over the row it describes hides the thing it is pointing at. Only the
    // three panel steps consult it, so a closed panel's off-screen rect never
    // reaches the arithmetic.
    const panel = stepAt(indexRef.current).needsPanel && panelOpenNow() ? panelBox() : null;
    const place = (at: Box | null) => placeCardForPanel(
      viewport, { width, height: card.offsetHeight }, at, panel, safeTopInset(), bottomInset,
    );

    const paint = (at: Box | null, around: Box[], cardAt: { top: number; left: number } | null) => {
      // The class strings above are constants React writes once, so these
      // toggles are the `useHiddenClass` contract spelled imperatively: the
      // pass that measures is the pass that reveals.
      spot.classList.toggle('hidden', !at);
      if (at) {
        spot.style.top = `${at.top}px`;
        spot.style.left = `${at.left}px`;
        spot.style.width = `${at.width}px`;
        spot.style.height = `${at.height}px`;
      }
      around.forEach((box: Box, i: number) => {
        const el = shades[i] as HTMLDivElement;
        el.style.top = `${box.top}px`;
        el.style.left = `${box.left}px`;
        el.style.width = `${box.width}px`;
        el.style.height = `${box.height}px`;
      });
      const top = shades[0] as HTMLDivElement;
      for (const cls of NO_HOLE_DIM) top.classList.toggle(cls, !at);
      if (cardAt) {
        card.style.top = `${cardAt.top}px`;
        card.style.left = `${cardAt.left}px`;
      }
      card.classList.toggle(CARD_SETTLING, !cardAt);
    };

    const settle = settleRef.current;
    if (settle) {
      const measured = JSON.stringify([hole, viewport]);
      if (ready && measured === settle.last && !targetAnimating(target)) settle.stable += 1;
      else {
        settle.stable = 0;
        settle.last = measured;
      }
      const timedOut = performance.now() - settle.since >= SETTLE_CAP_MS;
      if (settle.stable < SETTLE_FRAMES && !timedOut) {
        // Still arriving. The previous step's hole stays where it was; a tour
        // that has painted nothing yet dims the whole screen meanwhile.
        if (!paintedRef.current) paint(null, shadeBoxes(viewport, null), null);
        return;
      }
      settleRef.current = null;
      // The settled paint always writes, even where it matches the last one:
      // it is also what brings the card back.
      paintedRef.current = '';
    }

    const shown = ready ? hole : null;
    const boxes = shadeBoxes(viewport, shown);
    const placed = place(shown);
    const painted = JSON.stringify([shown, boxes, placed]);
    if (painted === paintedRef.current) return;
    paintedRef.current = painted;
    paint(shown, boxes, placed);
  }, []);

  // The step the last settle was started for, so a re-render that is not a
  // step change (the Skip question, the panel's open state) re-measures
  // without hiding the card again.
  const settledForRef = useRef<number | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (!live) {
      // Paused or closed: whatever comes back next settles from scratch.
      settledForRef.current = null;
      settleRef.current = null;
      paintedRef.current = '';
      return;
    }
    if (settledForRef.current !== index) {
      settledForRef.current = index;
      settleRef.current = { since: performance.now(), last: '', stable: 0 };
      cardRef.current?.classList.add(CARD_SETTLING);
    }
    // Forget what was painted last: the first pass after a state change, or
    // after a pause, always writes, even when the numbers happen to match.
    // Not while a step settles, whose first write is the settled one.
    if (!settleRef.current) paintedRef.current = '';
    apply();
    // Then follow the target for as long as the overlay is up. A resize, a
    // scroll in #home-screen or in the panel's own body, the panel's CSS
    // slide, the kit sheet's spring and the sheet re-sizing under a list that
    // loads later all move the target; only the last two report nothing, and
    // the next frame is the one signal that is right for all of them. See
    // "Following the target, and jumping to the next one" in the header.
    let frame = window.requestAnimationFrame(function follow() {
      apply();
      frame = window.requestAnimationFrame(follow);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [live, index, confirming, panelOpen, apply]);

  // Bring the step's target into view before pointing at it. Skipped for a
  // target inside the Improve panel: the panel is `position: fixed` and
  // already on screen, and scrolling the page under it would move Home for no
  // reason. bringIntoView skips the header and the tab bar for the same
  // reason.
  useEffect(() => {
    if (!live || confirming) return;
    const target = findTarget(stepAt(index).targets);
    if (!target) return;
    if (document.getElementById('apps-switcher-sheet')?.contains(target)) return;
    bringIntoView(target);
  }, [live, index, confirming]);

  // ── Focus ────────────────────────────────────────────────────────────
  //
  // Moved into whichever surface is up, and held there: the tour covers the
  // page, so a tab that walked out of it would be a keyboard user driving a
  // screen they cannot see. The one exception is the step the viewer has to
  // ACT on, where focus goes to the highlighted control instead, because that
  // is the next thing to press.
  useEffect(() => {
    if (!live) return;
    if (!confirming && stepAt(index).advanceOn) {
      const target = findTarget(stepAt(index).targets);
      if (target) {
        target.focus?.();
        return;
      }
    }
    const surface = confirming ? confirmRef.current : bodyRef.current;
    const first = surface?.querySelector<HTMLElement>(FOCUSABLE);
    // The card itself is `tabIndex={-1}`, so it is the landing place when a
    // surface somehow has no control of its own.
    (first ?? cardRef.current)?.focus?.();
  }, [live, index, confirming]);

  // `ended` says how (#3369): Next on the last step, or Skip. The account
  // keeps it with the furthest step reached, the first time only.
  // #5528: Finish ends the tour ON the Communities page, the one its first
  // card pointed at; Skip stays where the tour found you, Home.
  const finish = useCallback((ended: 'finish' | 'skip' = 'finish') => {
    // The screenshot route writes nothing, here or on the account.
    if (isTourShot()) {
      setConfirming(false);
      setOpen(false);
      if (ended === 'finish') goToCommunities();
      else backToTopOfHome();
      return;
    }
    writeDone(userId);
    // And on the account, so no other browser or device offers it again.
    // Fire-and-forget: a write that fails costs a repeat tour elsewhere,
    // never this one.
    void markDoneOnServer(userId, { ended, step: indexRef.current });
    clearStep(userId);
    setConfirming(false);
    setOpen(false);
    // #5528: Finish's landing is the Communities page, and the hash change
    // reports that screen itself; reporting Home first would log a
    // navigation that did not happen.
    if (ended === 'finish') {
      goToCommunities();
      return;
    }
    // The steps may have scrolled Home; hand the viewer back the top of the
    // page they started on.
    backToTopOfHome();
    // Back on the screen under the tour: the next step of the path (#3369).
    (window as any).App?._renotifyNavigation?.();
  }, [userId]);

  const goBack = useCallback(() => setIndex(stepFrom(indexRef.current, -1)), []);
  const goNext = useCallback(() => {
    const at = indexRef.current;
    // The menu step's Next does what the mark does rather than moving the
    // counter itself: the store subscription above sees `open` go true and
    // advances from there, so step 4 always arrives with the menu it points
    // into.
    if (nextOpensMenu(at)) void AppContext.open();
    else if (isLastStep(at)) finish('finish');
    else setIndex(stepFrom(at, 1));
  }, [finish]);

  useEffect(() => {
    if (!live) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape behaves like Skip, and a second Escape backs out of the
        // question rather than answering it.
        setConfirming((was) => !was);
        return;
      }
      if (event.key !== 'Tab') return;
      // The step the viewer has to act on leaves the highlighted control in
      // the tab order: trapping focus in the card would make that step
      // impossible to complete from a keyboard.
      if (!confirmingRef.current && stepAt(indexRef.current).advanceOn) return;
      const surface = confirmingRef.current ? confirmRef.current : bodyRef.current;
      if (!surface) return;
      const stops = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => !el.classList.contains('hidden'));
      if (!stops.length) return;
      const first = stops[0];
      const final = stops[stops.length - 1];
      const active = document.activeElement;
      if (!surface.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && active === final) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        final.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [live]);

  return (
    <div
      ref={rootRef}
      id="home-tour"
      className={ROOT}
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-tour-title"
    >
      {/*
          Four transparent panels around the cut-out. They are what BLOCKS,
          so the hole they leave is a real hole and the mark inside it can be
          pressed on the step that asks for it. The dim is the spotlight's
          own shadow; with no target the panels collapse to a single
          full-screen shade, which takes the dim instead.
      */}
      <div ref={topRef} id="home-tour-shade-top" className={SHADE}></div>
      <div ref={rightRef} id="home-tour-shade-right" className={SHADE}></div>
      <div ref={bottomRef} id="home-tour-shade-bottom" className={SHADE}></div>
      <div ref={leftRef} id="home-tour-shade-left" className={SHADE}></div>
      <div ref={spotRef} id="home-tour-spotlight" className={SPOT}></div>
      <div
        ref={cardRef}
        id="home-tour-card"
        tabIndex={-1}
        className={CARD}
      >
        <div ref={bodyRef} id="home-tour-body">
          <div
            id="home-tour-counter"
            className="text-[0.6875rem] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400"
          >
            {stepCounter(index)}
          </div>
          <h2
            id="home-tour-title"
            className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {t(step.title)}
          </h2>
          <p id="home-tour-text" className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {t(step.body)}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <Button
              id="home-tour-skip"
              type="button"
              variant="unstyled"
              size="inline"
              ink="muted"
              className="rounded px-1 py-1"
              onClick={() => setConfirming(true)}
            >
              {t('onboarding:tour.skip')}
            </Button>
            <div className="ms-auto flex items-center gap-2">
              <Button
                id="home-tour-back"
                type="button"
                variant="outline"
                size="sm"
                ink="muted"
                disabledStyle="dim"
                disabled={index === 0}
                onClick={goBack}
              >
                {t('core:common.back')}
              </Button>
              {/*
                  On every step. On the menu step it opens the menu rather
                  than skipping it (goNext), so it cannot carry the viewer
                  past the step that asks them to press something.
              */}
              <Button
                id="home-tour-next"
                type="button"
                size="sm"
                onClick={goNext}
              >
                {last ? t('onboarding:tour.finish') : t('onboarding:tour.next')}
              </Button>
            </div>
          </div>
        </div>
        {/*
            The Skip question. A sibling of the body rather than a second
            surface, so the card keeps its position and only its contents
            change; the geometry pass re-measures on `confirming`, because the
            question is shorter than most steps.
        */}
        <div ref={confirmRef} id="home-tour-confirm" className="hidden">
          <p
            id="home-tour-confirm-text"
            className="text-sm text-zinc-700 dark:text-zinc-200"
          >
            {t('onboarding:tour.confirm.text')}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              id="home-tour-confirm-cancel"
              type="button"
              variant="outline"
              size="sm"
              ink="muted"
              onClick={() => setConfirming(false)}
            >
              {t('onboarding:tour.confirm.keepGoing')}
            </Button>
            <Button
              id="home-tour-confirm-skip"
              type="button"
              size="sm"
              onClick={() => finish('skip')}
            >
              {t('onboarding:tour.confirm.skip')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { TOUR_LENGTH };
