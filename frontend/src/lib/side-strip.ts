/**
 * THE SIDE STRIP: iPhone Duo's column of system chrome (24 Oct 2026).
 *
 * Folded, the Duo's cover is 466x678 and iOS moves the status bar, the
 * camera and every app's bars into an 84pt column down its right edge.
 * Native apps put their tab bar at the foot of that column and their back
 * button under the clock, and leave the content to its left. The inner
 * display does the same in landscape (951x669), and Split View puts the
 * column on whichever edge the app is against.
 *
 * The Homeroom app's web view fills the screen, so the page is handed the
 * column as a safe-area inset: measured on the Duo simulator (iOS 27.1, the
 * app built with the 27.1 SDK), `env(safe-area-inset-right)` is 84px and
 * the top inset is 0. Nothing in the shell read a side inset, so the header's
 * right end sat under the camera and every screen ran under the clock.
 *
 * This module turns that inset into one fact on <html>:
 *
 *   data-side-strip="right" | "left"   the side the column is on
 *   --platform-strip-w                  its width, in px
 *
 * and app.css keeps the content out of the column and moves the tab bar and
 * the back button into it, the way the system's own apps do.
 *
 * ── THE TOP BAND: unfolded, held upright ──────────────────────────────
 *
 * Unfolded and upright the Duo is 669px wide, and iOS moves the clock, the
 * camera and the Wi-Fi ring into a band across the top instead of a column
 * down the edge. The page is handed that band as `env(safe-area-inset-top)`
 * — 80px on the simulator — which the #2305 rule spends as the header's
 * padding-top, so the bar read as an 80px strip of empty ground with its
 * row under it. A top inset of STRIP_MIN_PX or more, with NO side column,
 * is that band, and this module publishes it as a second fact:
 *
 *   data-top-band          the band is there
 *   --platform-band-h      its height, in px
 *
 * app.css then lays the header's row into the band (THE TOP BAND block), as
 * the header already runs into the folded Duo's column. A band and a column
 * never arrive together: whichever pose the phones are in reports one or the
 * other, and a side strip wins if both were ever seen.
 *
 * ── Why the inset and not the device ──────────────────────────────────
 *
 * Apple's advice for the Duo is to follow the space, not the model, and the
 * inset IS the space: it comes and goes as the phone folds, rotates and
 * enters Split View, and every pose that has a column reports it. One side
 * only, and wide: a phone in landscape reports the notch's inset on BOTH
 * sides, and an Android cutout in landscape is one side but under 64px.
 * Neither is a column of chrome, and neither moves anything here. Mobile Safari keeps the Duo's column for its own buttons,
 * so a page in it sees a 382px viewport with no inset, and stays a phone.
 *
 * ── THE SIDE CORNER: folded, the island in one corner ─────────────────
 *
 * In the 466x678 folded pose the report shows, iOS keeps its clock, camera
 * and signal in a narrow pill at the top-right corner instead of the wider
 * column above: about 52px, under STRIP_MIN_PX, so neither fact above was
 * set and the header's bell and app chip sat under it. A one-sided inset
 * that is wider than nothing and narrower than a strip, with no column and
 * no top band, on a phone held upright, is that corner:
 *
 *   data-side-corner     the side the system's corner is on
 *   --platform-corner-w  its width, in px
 *
 * app.css keeps the header's controls, the content and the five cells of
 * the bar out of it (THE SIDE CORNER block). A sideways Android phone has a
 * one-sided cutout too, which is why the pose must be upright; a strip or a
 * top band always wins, and the three facts are never set together.
 *
 * ── `?side-strip=right` ───────────────────────────────────────────────
 *
 * The checks run in a desktop Chromium that has no insets, so a plain URL
 * could never show this layout. `?side-strip=right` (or `left`) paints the
 * Duo's column the way `?safe-bottom=1` paints a home indicator
 * (App._applySafeAreaShot): it sets the kit's own override,
 * `--un-safe-inset-right: 84px`, which every inset reader in app.css and
 * native.css takes before env(), and the probe below reads the same way.
 * A pure presentation flag with no writes, ungated for the same reason.
 * `?side-strip=up` is the same for the top band: it paints an 84px top
 * inset, and the probe reads it as the band the Duo reports.
 * `?side-strip=corner` paints a 52px right inset, the folded Duo's corner.
 */

export const STRIP_ATTR = 'data-side-strip';
export const STRIP_W_PROP = '--platform-strip-w';
/** The unfolded Duo's band across the top (see THE TOP BAND above). */
export const BAND_ATTR = 'data-top-band';
export const BAND_H_PROP = '--platform-band-h';
/** Narrower than this is a cutout's inset, not a column of chrome. */
export const STRIP_MIN_PX = 64;
/** What `?side-strip=` paints: the Duo's column (or band), measured. */
export const STRIP_SHOT_PX = 84;
/** The folded Duo's corner, as the report's screenshot measures it. */
export const CORNER_ATTR = 'data-side-corner';
export const CORNER_W_PROP = '--platform-corner-w';
/** What `?side-strip=corner` paints: the pill in the folded Duo's corner. */
export const CORNER_SHOT_PX = 52;

export type StripSide = 'left' | 'right';
export type SideInsets = { top?: number; left: number; right: number };

/** Which side the column is on, or null when there is none. */
export function stripSide(insets: SideInsets | null | undefined): StripSide | null {
  if (!insets) return null;
  const left = Number(insets.left) || 0;
  const right = Number(insets.right) || 0;
  if (right >= STRIP_MIN_PX && left < 1) return 'right';
  if (left >= STRIP_MIN_PX && right < 1) return 'left';
  return null;
}

/** `?side-strip=right|left`, or null. `1` is the Duo's own side, right. */
export function stripShotSide(search: string): StripSide | null {
  let value: string | null = null;
  try { value = new URLSearchParams(search).get('side-strip'); } catch { return null; }
  if (value === 'left') return 'left';
  if (value === 'right' || value === '1') return 'right';
  return null;
}

/**
 * The band's height now, in px, or 0 with no band: the unfolded Duo held
 * upright, where a tall top inset arrives with no side column. A side
 * column wins if both are ever reported, so the two layouts never stack.
 */
export function topBand(insets: SideInsets | null | undefined): number {
  if (!insets) return 0;
  const top = Number(insets.top) || 0;
  if (top < STRIP_MIN_PX) return 0;
  if (stripSide(insets)) return 0;
  return top;
}

/** `?side-strip=up` paints the band, so a desktop browser can review it. */
export function topBandShot(search: string): boolean {
  try { return new URLSearchParams(search).get('side-strip') === 'up'; } catch { return false; }
}

/**
 * Which side the Duo's narrow corner is on, or null. Only a one-sided inset
 * wider than nothing and narrower than a strip, with no column or band, on a
 * phone held upright: a sideways phone's cutout and an iPhone's two-sided
 * landscape notch are not this pose.
 */
export function sideCorner(
  insets: SideInsets | null | undefined,
  { portrait }: { portrait: boolean },
): StripSide | null {
  if (!insets || !portrait) return null;
  if (stripSide(insets) || topBand(insets)) return null;
  const left = Number(insets.left) || 0;
  const right = Number(insets.right) || 0;
  if (right > 0 && right < STRIP_MIN_PX && left < 1) return 'right';
  if (left > 0 && left < STRIP_MIN_PX && right < 1) return 'left';
  return null;
}

/** `?side-strip=corner` paints the folded Duo's corner, to review it. */
export function cornerShot(search: string): boolean {
  try { return new URLSearchParams(search).get('side-strip') === 'corner'; } catch { return false; }
}

type RootLike = {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  classList?: { contains(name: string): boolean };
};

/** Publish the strip on <html>, or take it away. Writes only on a change. */
export function applyStrip(root: RootLike, side: StripSide | null, width: number): void {
  if (side) {
    const px = `${Math.round(width)}px`;
    if (root.getAttribute(STRIP_ATTR) !== side) root.setAttribute(STRIP_ATTR, side);
    root.style.setProperty(STRIP_W_PROP, px);
  } else if (root.getAttribute(STRIP_ATTR) !== null) {
    root.removeAttribute(STRIP_ATTR);
    root.style.removeProperty(STRIP_W_PROP);
  }
}

/** Publish the corner on <html>, or take it away. Writes only on a change. */
export function applyCorner(root: RootLike, side: StripSide | null, width: number): void {
  if (side) {
    const px = `${Math.round(width)}px`;
    if (root.getAttribute(CORNER_ATTR) !== side) root.setAttribute(CORNER_ATTR, side);
    root.style.setProperty(CORNER_W_PROP, px);
  } else if (root.getAttribute(CORNER_ATTR) !== null) {
    root.removeAttribute(CORNER_ATTR);
    root.style.removeProperty(CORNER_W_PROP);
  }
}

/** Publish the top band on <html>, or take it away. Writes only on a change. */
export function applyTopBand(root: RootLike, px: number): void {
  if (px > 0) {
    if (root.getAttribute(BAND_ATTR) === null) root.setAttribute(BAND_ATTR, '');
    root.style.setProperty(BAND_H_PROP, `${Math.round(px)}px`);
  } else if (root.getAttribute(BAND_ATTR) !== null) {
    root.removeAttribute(BAND_ATTR);
    root.style.removeProperty(BAND_H_PROP);
  }
}

/**
 * The strip's width now, in px, or 0 with no strip: what a drawer that pans
 * by a width takes off it, so its levels stay beside the strip while their
 * box runs under it (features/nav-drawer/nav-drawer.tsx,
 * features/messages/phone-drawer.tsx).
 */
export function stripWidth(doc: Pick<Document, 'documentElement'> | null = typeof document === 'undefined' ? null : document): number {
  const root = doc?.documentElement;
  if (!root || !root.hasAttribute(STRIP_ATTR)) return 0;
  return parseFloat(root.style.getPropertyValue(STRIP_W_PROP)) || 0;
}

let probe: HTMLElement | null = null;

/**
 * A hidden probe on <html> (the body is React's to hydrate) that carries the
 * left, right and top insets, through the kit's override first, exactly as
 * app.css reads them. JS cannot read env(), so they ride as padding: the LEFT
 * inset as its left padding, the RIGHT inset as its TOP padding and the TOP
 * inset as its BOTTOM padding. With no width or height of its own, its border
 * box is then (left inset x (right + top) insets), so a change to any one of
 * them resizes it, and a ResizeObserver hears it.
 */
function sideInsetProbe(doc: Document): HTMLElement {
  if (!probe || !probe.isConnected) {
    probe = doc.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;'
      + 'visibility:hidden;pointer-events:none;'
      + 'padding-left:var(--un-safe-inset-left,env(safe-area-inset-left,0px));'
      + 'padding-top:var(--un-safe-inset-right,env(safe-area-inset-right,0px));'
      + 'padding-bottom:var(--un-safe-inset-top,env(safe-area-inset-top,0px))';
    doc.documentElement.appendChild(probe);
  }
  return probe;
}

const NO_INSETS: SideInsets = { left: 0, right: 0, top: 0 };

/** The insets as the page resolves them. */
function readSideInsets(doc: Document, win: Window): SideInsets {
  try {
    const cs = win.getComputedStyle(sideInsetProbe(doc));
    return {
      left: parseFloat(cs.paddingLeft) || 0,
      right: parseFloat(cs.paddingTop) || 0,
      top: parseFloat(cs.paddingBottom) || 0,
    };
  } catch {
    return { left: 0, right: 0, top: 0 };
  }
}

type ResizeObserverWindow = Window & { ResizeObserver?: typeof ResizeObserver };

/**
 * Follow the inset. Read once now, so the attribute is on <html> before the
 * app's launch cover lifts (it waits for DOMContentLoaded, which a deferred
 * module runs before), and again whenever the inset itself changes.
 *
 * WHY NOT ONLY ON RESIZE (30 Oct 2026). Folding, unfolding, rotating and
 * Split View all resize the viewport, and this used to read the inset then
 * and nowhere else. On a real Duo the tabs were sometimes left at the foot
 * of the folded cover: WebKit can hand the page its new safe area in a
 * layout pass after the resize that announced the new size, or with no
 * resize at all, and the read at the resize saw the old inset. The probe's
 * own box follows the inset (sideInsetProbe), so a ResizeObserver on it
 * reads every change whenever it lands. The window's events stay, for an
 * engine with no ResizeObserver.
 */
export function watchSideStrip(doc: Document = document, win: Window = window): () => void {
  const root = doc.documentElement;
  const search = win.location?.search || '';
  const shot = stripShotSide(search);
  if (shot) root.style.setProperty(`--un-safe-inset-${shot}`, `${STRIP_SHOT_PX}px`);
  if (topBandShot(search)) root.style.setProperty('--un-safe-inset-top', `${STRIP_SHOT_PX}px`);
  const shotCorner = cornerShot(search);
  if (shotCorner) root.style.setProperty('--un-safe-inset-right', `${CORNER_SHOT_PX}px`);
  const RO = (win as ResizeObserverWindow).ResizeObserver;
  let observer: ResizeObserver | null = null;
  let observed: HTMLElement | null = null;
  const update = () => {
    // THE SIDE PANEL'S OWN DOCUMENT OWNS NO EDGE (1 Nov 2026). It is a column
    // inside the page (features/side-panel/), which keeps it beside the Duo's
    // column already, but WebKit hands the frame the screen's insets, and it
    // padded itself an 84px column it does not touch.
    const insets = root.classList?.contains('in-side-panel') ? NO_INSETS : readSideInsets(doc, win);
    const side = stripSide(insets);
    applyStrip(root, side, side ? insets[side] : 0);
    // A browser tab never owns the top of the screen (#2509), whatever the
    // engine reports there: the browser's own chrome is above it. The shot
    // flag is the exception — it PAINTS a device the reviewer asked for, as
    // `?side-strip=right` does, so the layout stays reviewable in a tab.
    const band = root.classList?.contains('web-browser-chrome') && !topBandShot(search)
      ? 0
      : topBand(insets);
    applyTopBand(root, band);
    // The corner belongs to the app's own window, held upright: a browser
    // tab's chrome is its own (#2509), and a sideways phone's one-sided
    // inset is a camera cutout, not the Duo's corner. The shot flag paints
    // the device it names, as `?side-strip=right` does.
    const portrait = win.innerHeight > win.innerWidth;
    const cornerAllowed = !!root.classList?.contains('in-native-webview') || shotCorner;
    const corner = cornerAllowed ? sideCorner(insets, { portrait }) : null;
    applyCorner(root, corner, corner ? insets[corner] : 0);
    // A probe made anew (its old one was taken out of the document) is
    // observed in its place.
    if (observer && probe && probe !== observed) {
      if (observed) observer.unobserve(observed);
      observer.observe(probe, { box: 'border-box' });
      observed = probe;
    }
  };
  if (RO) {
    try { observer = new RO(update); } catch { observer = null; }
  }
  update();
  win.addEventListener('resize', update);
  win.addEventListener('orientationchange', update);
  win.visualViewport?.addEventListener('resize', update);
  return () => {
    observer?.disconnect();
    win.removeEventListener('resize', update);
    win.removeEventListener('orientationchange', update);
    win.visualViewport?.removeEventListener('resize', update);
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  watchSideStrip();
}
