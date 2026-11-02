/**
 * The reading direction of the language on screen.
 *
 * Direction is a property of the language, never a separate setting: when
 * Arabic is on screen the whole shell lays out right to left, and switching
 * back to another language puts it back at once. Nothing else decides it.
 *
 * `frontend/src/head.html` carries a literal copy of RTL_LANGUAGES in its
 * first-paint script, because that script runs before this module and must
 * set `dir` before Arabic paints. tests/language-direction.test.js pins the
 * two lists to each other, so adding a language here means adding it there.
 */

export type Direction = 'ltr' | 'rtl';

/**
 * Languages written right to left, by primary subtag. Arabic is the only one
 * Homeroom offers today; the rest are here so a configured language, or a
 * device asking for one, is laid out correctly the day its pack exists.
 */
export const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'ckb', 'yi', 'sd', 'ug'] as const;

/** The primary subtag of a language tag: `ar-EG` and `ar_EG` are both `ar`. */
export function primarySubtag(tag: string | null | undefined): string {
  return String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * `rtl` when the language is written right to left, `ltr` otherwise.
 *
 * The literal list answers first, so a tag Homeroom knows stays right to left
 * even where `Intl.Locale` is missing or its locale data disagrees. Anything
 * it does not know asks `Intl.Locale`'s text info, which covers languages
 * added to the platform later.
 */
export function directionFor(tag: string | null | undefined): Direction {
  const value = String(tag || '').trim();
  if (!value) return 'ltr';
  if ((RTL_LANGUAGES as readonly string[]).includes(primarySubtag(value))) return 'rtl';
  try {
    const Locale = (Intl as unknown as { Locale?: new (tag: string) => {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    } }).Locale;
    if (typeof Locale === 'function') {
      const locale = new Locale(value.replace(/_/g, '-'));
      const info = typeof locale.getTextInfo === 'function' ? locale.getTextInfo() : locale.textInfo;
      if (info?.direction === 'rtl') return 'rtl';
    }
  } catch { /* an invalid tag falls back to left to right */ }
  return 'ltr';
}

/** The direction the document is laid out in now. */
export function currentDirection(): Direction {
  if (typeof document === 'undefined') return 'ltr';
  return document.documentElement?.dir === 'rtl' ? 'rtl' : 'ltr';
}

/**
 * `-1` while the shell reads right to left, `1` otherwise. Horizontal
 * geometry (a drawer's finger direction, a slide or a drag offset) multiplies
 * its measured distance by this, read when the gesture happens rather than at
 * module load, so a language switched live is followed at once.
 */
export function dirSign(): 1 | -1 {
  return currentDirection() === 'rtl' ? -1 : 1;
}

/**
 * Something a person wrote, for a line of a right-to-left screen that has no
 * element of its own to carry `dir="auto"` (a list row's preview, inside a
 * translated sentence). Unicode's isolates give it its own direction, so an
 * English "See you Saturday!" keeps its "!" at its end. Elsewhere the text
 * is returned as it was.
 */
export function ownDirection(text: string): string {
  return text && currentDirection() === 'rtl' ? `\u2068${text}\u2069` : text;
}
