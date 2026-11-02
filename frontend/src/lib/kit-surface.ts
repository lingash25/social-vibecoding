/**
 * One adopt / lift / restore, for all three native-kit surfaces.
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * The kit's `modal()`, `sheet()` and `panel()` all work the same way: you
 * hand them a `contentEl` and they PHYSICALLY REPARENT it into their own
 * shell. Everything around that call is bookkeeping the caller has to get
 * right — stamp `platform-<kind>-adopted` so `app.css` stops drawing the
 * legacy chrome, put the node back where it came from when the surface goes
 * away, and undo both if the kit refuses the presentation.
 *
 * Four places had written that bookkeeping out by hand:
 *
 *   * lib/static-modal.ts — the nine dialogs' card lift (`modal`);
 *   * features/dev-console/store.ts — the dev console panel (`sheet`);
 *   * features/header/header-menu-controller.js — the hamburger drawer
 *     (`panel`);
 *   * features/work-drawer/work-drawer.js — the cog drawer (`sheet`),
 *     retired by THE UI OVERHAUL along with the drawer itself. The Improve
 *     panel (features/improve/improve-controller.js) is the third caller
 *     now, and it presents as a `sheet` for the same reason.
 *
 * They agreed on the shape and disagreed on the details, which is the failure
 * mode this module exists to end: only one of the four rolled the class back
 * when the kit returned null, only one guarded against a newer presentation
 * stealing the node mid-teardown, and each spelled the class name itself.
 *
 * ── What stayed with the callers ──────────────────────────────────────
 *
 * Deliberately NOT absorbed here, because they differ for real reasons:
 *
 *   * the `hidden` class. The dialogs' roots, the dev console's panel and the
 *     work drawer's panel each mean something different by it, and the
 *     dialogs' is owned by React state through `useStaticModal`.
 *   * the gate. The dialogs adopt whenever the kit is present (`hasKit()`) —
 *     desktop included, which is what the retired `adoptStaticModal` did and
 *     what this must keep doing. The other three adopt only on touch.
 *   * everything each caller does with its own state on the way out; that is
 *     what `onDismiss` is for.
 */

export type KitSurfaceKind = 'modal' | 'sheet' | 'panel';

export interface KitSurfaceHandle {
  el?: HTMLElement | null;
  dismiss(): void;
}

type KitPresent = (opts: {
  contentEl: HTMLElement;
  onDismiss?: () => void;
  [key: string]: unknown;
}) => KitSurfaceHandle | null;

interface KitLike {
  hasKit?(): boolean;
  isTouch(): boolean;
  modal?: KitPresent;
  sheet?: KitPresent;
  panel?: KitPresent;
}

function kit(): KitLike | null {
  const host = globalThis as unknown as { PlatformUI?: KitLike };
  const ui = host.PlatformUI;
  return ui && typeof ui.isTouch === 'function' ? ui : null;
}

export interface AdoptKitSurfaceOptions {
  kind: KitSurfaceKind;
  /** The node handed to the kit, which the kit then reparents. */
  contentEl: HTMLElement;
  /**
   * The node that carries `platform-<kind>-adopted`. Defaults to `contentEl`.
   *
   * The dialogs are the exception: the kit takes the CARD, but the class goes
   * on the modal ROOT, because that is the node `app.css` keys the legacy
   * scrim off.
   */
  adoptedOn?: HTMLElement;
  /**
   * Where `contentEl` goes when the surface is torn down.
   *
   * `'body'` re-appends it to `<body>`, off-screen, which is where the three
   * drawer/sheet panels live between presentations. `'placeholder'` swaps a
   * comment node into its original position and restores it there — the
   * dialogs need that, because their card has to end up back inside its own
   * backdrop for the prerendered tree (and React's picture of it) to hold.
   */
  home: 'body' | 'placeholder';
  /**
   * `'touch'` presents only on touch platforms; `'kit'` presents whenever the
   * kit is loaded, desktop included. See the note above about why the dialogs
   * differ.
   */
  gate: 'touch' | 'kit';
  /** Extra options forwarded to the kit call — `side: 'right'` for panels. */
  present?: Record<string, unknown>;
  /**
   * Size the kit shell to the content's own `max-width` rather than letting
   * it default to 480px. Only the dialogs ask for this; their cards are
   * `max-w-sm` / `max-w-md` / `max-w-lg` and a fixed shell width made the
   * small ones look padded and the large one cramped.
   */
  hugDesignWidth?: boolean;
  /** Ran the moment the kit reports a dismissal, before anything is undone. */
  onDismissStart?: () => void;
  /**
   * Checked after `onDismissStart`. Return false when a NEWER adoption owns
   * `contentEl` — this teardown then leaves the DOM completely alone.
   *
   * One caller: the hamburger drawer, whose teardown is deferred behind an
   * exit spring long enough for a second tap to re-adopt the same node
   * (#977). Restoring it here would yank it straight back out of the panel
   * the user just opened.
   */
  stillOwns?: () => boolean;
  /** Ran after the node is home and the adopted class is off. */
  onDismiss?: () => void;
}

export interface KitAdoption {
  readonly kind: KitSurfaceKind;
  readonly handle: KitSurfaceHandle;
  readonly contentEl: HTMLElement;
  /**
   * Put the node back and drop the adopted class, without telling the kit.
   *
   * Idempotent, and separate from `dismiss()` on purpose. Calling it before
   * `dismiss()` makes the kit run its exit over an EMPTY shell — the card
   * vanishes on the spot and a blank rounded box fades out where it was —
   * so a component that is unmounting uses `release()` instead, and one that
   * stays mounted calls `dismiss()` alone and lets `onDismiss` restore.
   */
  restore(): void;
  /** Ask the kit to tear the surface down. */
  dismiss(): void;
  /**
   * Close from a component that is unmounting: the node must be home before
   * React removes the tree around it, so it comes back NOW, and an inert
   * snapshot of it takes its place in the kit's shell to play the exit.
   */
  release(): void;
}

/**
 * A node's original position, held open by a comment while the node is
 * somewhere else.
 *
 * Extracted from `adoptKitSurface`'s `home: 'placeholder'` branch (#1191 slice
 * 6, conversion 8) because a second caller needs exactly this and nothing else
 * around it: `#settings-footer` is re-parented between the two settings
 * columns by `Settings._syncFooter()`, which is a real DOM move with no kit
 * involved at all. The rule it has to satisfy is the same one the dialogs'
 * cards satisfy — a node React rendered may leave its parent, but the slot it
 * came from must stay open, so React's picture of that parent's children still
 * describes the document.
 *
 * `lift()` and `restore()` are both idempotent, and `restore()` puts the node
 * back where the comment SITS rather than where it was: the comment is a real
 * child, so anything inserted around it in the meantime is respected.
 */
export interface PlaceholderHome {
  lift(): void;
  restore(): void;
  readonly lifted: boolean;
}

export function createPlaceholderHome(el: HTMLElement, label: string): PlaceholderHome {
  let placeholder: Comment | null = null;
  return {
    lift() {
      if (placeholder) return;
      placeholder = document.createComment(label);
      el.parentNode?.replaceChild(placeholder, el);
    },
    restore() {
      if (!placeholder) return;
      if (placeholder.parentNode) placeholder.parentNode.replaceChild(el, placeholder);
      placeholder = null;
    },
    get lifted() {
      return placeholder !== null;
    },
  };
}

function designWidthOf(el: HTMLElement): string | null {
  try {
    const mw = getComputedStyle(el).maxWidth;
    return mw && mw.endsWith('px') ? mw : null;
  } catch {
    /* jsdom and very old engines: fall back to the kit default width */
    return null;
  }
}

/*
 * HANDED BACK, OUT OF SIGHT (onboarding run three, 12 Oct 2026, iPhone 17
 * Safari). A surface homed on <body> goes back there when the kit's exit
 * ends, without the adopted class, as its owner's own web presentation: the
 * Homeroom menu's bottom sheet, which the kit's exit had just taken away,
 * stood again at its open place for 190ms before anything closed it. It
 * takes REHOMED_CLASS on the way back, which app.css keeps out of sight, and
 * lets it go at the start of its next adoption, so a presentation the kit
 * refuses still shows the web one.
 */
export const REHOMED_CLASS = 'platform-surface-rehomed';

/**
 * Present `contentEl` in a native-kit surface, or return null when the kit
 * is absent, gated out, or refuses — in which case nothing has been touched
 * and the caller falls through to its own web presentation.
 */
export function adoptKitSurface(options: AdoptKitSurfaceOptions): KitAdoption | null {
  // A node the kit handed back is shown again only through a presentation:
  // this one, or its web fallback when this one is refused (REHOMED_CLASS).
  options.contentEl.classList.remove(REHOMED_CLASS);
  const ui = kit();
  if (!ui) return null;
  if (options.gate === 'kit') {
    if (typeof ui.hasKit !== 'function' || !ui.hasKit()) return null;
  } else if (!ui.isTouch()) {
    return null;
  }
  const presentFn = ui[options.kind];
  if (typeof presentFn !== 'function') return null;

  const { contentEl } = options;
  const flagEl = options.adoptedOn || contentEl;
  const adoptedClass = `platform-${options.kind}-adopted`;

  // Measured BEFORE the card is neutralized — `platform-modal-card` is what
  // strips its own max-width, so reading afterwards reads the kit's.
  const designWidth = options.hugDesignWidth ? designWidthOf(contentEl) : null;

  // The kit shell already draws surface, radius, shadow and padding; stacking
  // the card's own on top gave double borders and doubled whitespace.
  if (options.kind === 'modal') contentEl.classList.add('platform-modal-card');

  let home: PlaceholderHome | null = null;
  if (options.home === 'placeholder') {
    home = createPlaceholderHome(contentEl, `platform-${options.kind}-home`);
    home.lift();
  }
  flagEl.classList.add(adoptedClass);

  // Whether the kit ever took the node. Until it has, a rollback must not
  // re-home `contentEl` — it never left.
  let presented = false;
  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    if (options.kind === 'modal') contentEl.classList.remove('platform-modal-card');
    if (home) {
      home.restore();
    } else if (presented) {
      contentEl.classList.add(REHOMED_CLASS);
      document.body.appendChild(contentEl);
    }
    flagEl.classList.remove(adoptedClass);
  };

  const handle = presentFn.call(ui, {
    ...options.present,
    contentEl,
    onDismiss: () => {
      options.onDismissStart?.();
      if (options.stillOwns && !options.stillOwns()) return;
      undo();
      options.onDismiss?.();
    },
  });

  if (!handle) {
    undo();
    return null;
  }
  presented = true;
  if (handle.el && designWidth) {
    // At most the float box (app.css THE USABLE BOX: the window less the
    // Duo's column) less 16px a side, the kit's own margin.
    handle.el.style.width = `var(--un-modal-width, min(${designWidth}, calc(var(--platform-float-w) - 32px)))`;
  }

  return {
    kind: options.kind,
    handle,
    contentEl,
    restore: undo,
    dismiss: () => {
      releaseFocus(contentEl, handle.el);
      handle.dismiss();
    },
    release: () => {
      releaseFocus(contentEl, handle.el);
      if (!undone) leaveSnapshot(contentEl);
      undo();
      handle.dismiss();
    },
  };
}

/**
 * Leave an inert copy of `el` in its place, for the kit's exit to animate.
 *
 * The copy is what the viewer last saw: form values, scroll offsets and
 * canvas pixels are carried over, since a clone starts without them. It must
 * not act like the original either: ids and names come off (a cloned radio
 * would join the real group and uncheck it; a duplicate id would answer
 * `getElementById` for the next 260ms), a frame keeps its box but loads
 * nothing, and the copy is `inert` and hidden from assistive tech. The kit
 * removes its shell, copy and all, when the exit ends.
 *
 * Purely cosmetic, so it never throws: without a copy the shell exits empty.
 */
function leaveSnapshot(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  try {
    const copy = el.cloneNode(true) as HTMLElement;
    const from = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))];
    const to = [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))];
    to.forEach((node, i) => {
      const src = from[i];
      node.removeAttribute('id');
      node.removeAttribute('name');
      node.removeAttribute('autofocus');
      if (node instanceof HTMLIFrameElement) {
        node.removeAttribute('src');
        node.removeAttribute('srcdoc');
      } else if (
        (node instanceof HTMLTextAreaElement && src instanceof HTMLTextAreaElement)
        || (node instanceof HTMLSelectElement && src instanceof HTMLSelectElement)
      ) {
        node.value = src.value;
      } else if (node instanceof HTMLCanvasElement && src instanceof HTMLCanvasElement) {
        node.width = src.width;
        node.height = src.height;
        try { node.getContext('2d')?.drawImage(src, 0, 0); } catch { /* tainted: left blank */ }
      }
    });
    copy.setAttribute('inert', '');
    copy.setAttribute('aria-hidden', 'true');
    parent.insertBefore(copy, el);
    // Offsets exist only once the copy is laid out.
    to.forEach((node, i) => {
      const src = from[i];
      if (src.scrollTop) node.scrollTop = src.scrollTop;
      if (src.scrollLeft) node.scrollLeft = src.scrollLeft;
    });
  } catch {
    /* a detached node or an engine without these APIs — exit without a copy */
  }
}

/**
 * Let go of the on-screen keyboard at the START of a surface's exit.
 *
 * ── The bug this is the whole of ──────────────────────────────────────
 *
 * A dialog that focuses a field on open — create-app, rename, fork, share,
 * close-issue — raises the keyboard, and that field KEEPS FOCUS for the whole
 * exit: the kit removes its shell only after the animation finishes, so the
 * blur that finally retracts the keyboard happens when the node is destroyed,
 * i.e. AFTER the surface has visually gone. The viewer therefore watches the
 * dialog animate away and THEN watches the page behind it resize as ~300px of
 * keyboard retracts: `--un-kb-inset` unwinds `.un-modal`'s own `top` (a 250ms
 * transition) and `html.un-kb` releases `.un-kb-avoid`'s padding (150ms) while
 * the browser re-clamps the scroller. That second act is the reported "closing
 * it makes the screen flicker for a second", and it is why the dialog that
 * does NOT autofocus — Give feedback — has never had it.
 *
 * Blurring here moves the retraction UNDER the exit animation instead of after
 * it: the two motions overlap, the backdrop is still dimming the page while it
 * reflows, and the surface is gone by the time anything settles. It costs
 * nothing on desktop and on a surface with nothing focused.
 *
 * Deliberately in `dismiss()` rather than in the dialogs' hook: sheets and
 * panels adopt through the same seam and carry composers of their own.
 */
function releaseFocus(contentEl: HTMLElement, shellEl?: HTMLElement | null): void {
  try {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    // The shell as well as the card: the kit focuses its own container on
    // present (`(auto || card).focus()` in presentModal), so on a surface the
    // viewer never typed into the focused node is the SHELL, and blurring only
    // the card's descendants would leave the kit's own element focused with a
    // node that is about to be removed.
    const inSurface = contentEl.contains(active) || !!shellEl?.contains(active);
    if (inSurface) active.blur?.();
  } catch {
    /* a detached or cross-origin activeElement — nothing to release */
  }
}
