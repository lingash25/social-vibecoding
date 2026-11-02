/**
 * An attached picture or clip, full size, before the request is posted
 * (#5687).
 *
 * The "Suggest an improvement" form shows each attachment as a 56px
 * thumbnail, which is enough to see that something was attached and not
 * enough to check what it shows. A tap on the thumbnail opens it here.
 *
 * It is the chat's picture viewer (features/image-viewer/image-viewer.tsx) in
 * frame only: the same dark backdrop, the same ✕ in the corner clear of the
 * notch, closed by a tap around the picture, Escape and Back. It is a
 * separate component because two of that viewer's jobs are wrong here: there
 * is no Download (the file is already on the device, and the URL is a blob),
 * and its Escape listener runs in the bubble phase on `document`, where the
 * kit modal the form is lifted into would close the whole dialog too. Escape
 * is caught here in the CAPTURE phase and stopped, and the root is marked
 * `data-owns-escape` so the kit's own listener stands aside, so the form
 * behind stays exactly as it was typed.
 *
 * A screenshot handed over from comment mode keeps its pins (#4482), drawn
 * over the enlarged picture exactly where the thumbnail draws them.
 *
 * Portalled to <body>: the kit modal's card is transformed and clipped, and
 * a fixed layer inside it would be sized to the card rather than to the
 * screen. It exists only after a tap, so the prerendered document never has
 * it.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { XIcon } from '@/components/ui/icons';
import { pushDismissible } from '../../lib/back-stack';
import { useMessages } from '../../lib/i18n/react';

/** What the controller's thumbnails hand over: the bytes' object URL. */
export interface FeedbackPreviewItem {
  kind: 'image' | 'video';
  src: string;
  /** An image's text alternative, which is also the preview's spoken name. */
  alt?: string;
  /** Comment-mode pins, as fractions of the picture's width and height. */
  pins?: Array<{ x: number; y: number; n?: number | null; note: string }> | null;
}

export function FeedbackPreview({ item, onClose }: { item: FeedbackPreviewItem; onClose: () => void }) {
  const t = useMessages('dialogs');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Back closes the preview, not the page under it.
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      onCloseRef.current();
      return true;
    });
    // Escape closes the preview, and only the preview. It is taken in the
    // capture phase and stopped so nothing else in the page treats the same
    // press as its own.
    //
    // The kit's own Escape listener is registered on `window` in the capture
    // phase by usernode-native/v1/native.js, which the head loads BEFORE the
    // shell bundle, so it runs first: stopping the press here cannot reach
    // it. It stands aside instead while an element marked `data-owns-escape`
    // is open, which the root below is, so the lifted feedback card stays
    // open with its draft as typed, as it does for ✕, a tap outside and Back.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (!backed) release();
      // Back to the thumbnail it was opened from.
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') return null;
  const name = item.kind === 'video'
    ? t('dialogs:feedback.video.previewLabel')
    : item.alt || t('dialogs:feedback.screenshot.previewAlt', { number: 1 });
  return createPortal(
    // z-[9993], not the chat viewer's z-[2200]: the kit LIFTS the feedback
    // card it sits in, and the lifted modal card is z-index 9992 (native.css:
    // backdrop 9990, sheet 9991, popover 9992). Host's own cut-out uses the
    // same number for the same reason (features/home/tour/index.tsx).
    // The black runs to the screen's edges; what it shows is centred in the
    // float box (app.css THE USABLE BOX), padded off the Duo's column, and
    // the image is at most that box wide.
    <div
      className="fixed inset-0 z-[9993] flex items-center justify-center bg-black/90"
      // Sides of the hardware (THE USABLE BOX), so they do not mirror in Arabic.
      style={{ paddingLeft: 'var(--platform-float-left)', paddingRight: 'var(--platform-float-right)' }}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-feedback-preview=""
      data-owns-escape=""
      onClick={(event) => {
        // Never let the tap travel on through React's tree as a click outside
        // the kit modal's card.
        event.stopPropagation();
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      {item.kind === 'video' ? (
        <video
          src={item.src}
          controls
          playsInline
          className="max-w-full max-h-full"
          data-feedback-preview-video=""
        />
      ) : (
        <span className="relative inline-block">
          <img
            src={item.src}
            alt={name}
            className="block max-w-[var(--platform-float-w)] max-h-[100dvh] object-contain select-none"
            draggable={false}
            data-feedback-preview-image=""
          />
          {(item.pins || []).map((pin, i) => (
            <span
              key={i}
              className="absolute h-4 w-4 -translate-y-full rounded-[50%_50%_50%_0] bg-violet-600 shadow-[0_0_0_2px_#fff]"
              style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
              aria-hidden="true"
            />
          ))}
        </span>
      )}
      <div className="absolute inset-x-0 top-0 flex items-center justify-end gap-3 px-3 pt-[calc(env(safe-area-inset-top)+12px)]">
        <button
          ref={closeRef}
          type="button"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/15 text-white"
          aria-label={t('core:common.close')}
          data-feedback-preview-close=""
          onClick={() => onCloseRef.current()}
        >
          <XIcon className="w-6 h-6" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
