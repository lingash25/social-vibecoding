// The screen shapes the audit lays the shell out in, in CSS pixels as the
// page sees them, with what each device hands the page and what it draws
// over it.
//
// `insets` are the safe-area insets the device reports (Chrome is told to
// report the same, so the shell's own detection runs: frontend/src/lib/
// side-strip.ts reads them to find the iPhone Duo's column and band).
// `system` is where the device draws its own controls over the page, where
// nothing the reader taps should sit: 'error' where a tap goes to the system
// (the clock and camera, a status bar), 'warn' where it competes with a
// gesture (the home indicator). `keyboard` is the height of the on-screen
// keys, for the keyboard-up pass; 0 skips it.
//
// The iPhone Duo's figures were measured on its simulator (iOS 27.1, the
// Homeroom app, 1 November 2026): sideways 951x669 with an 84px column on
// the right and keys 264px tall; upright a top band of 80px with the clock
// pill in its right 130px; folded 466x678 with the column. The keyboard
// heights other than the Duo's sideways one are typical, not measured.

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

export const PROFILES = [
  {
    id: 'phone',
    label: 'iPhone, upright',
    width: 393, height: 852, scale: 3, touch: true, userAgent: IOS_UA, native: true,
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
    system: [
      { name: 'status bar', x: 0, y: 0, w: 393, h: 54, severity: 'error' },
      { name: 'home indicator', x: 0, y: 831, w: 393, h: 21, severity: 'warn' },
    ],
    keyboard: 336,
  },
  {
    // Safari, not the app: the Homeroom app turns only where the short side
    // is 600pt or more (the Duo unfolded, an iPad), so a phone held sideways
    // is a browser.
    id: 'phone-sideways',
    label: 'iPhone Safari, sideways',
    width: 852, height: 393, scale: 3, touch: true, userAgent: IOS_UA, native: false,
    insets: { top: 0, right: 59, bottom: 21, left: 59 },
    system: [
      // The island is on whichever side the phone was turned towards, so a
      // layout has to clear both.
      { name: 'camera island', x: 0, y: 120, w: 40, h: 153, severity: 'error' },
      { name: 'camera island', x: 812, y: 120, w: 40, h: 153, severity: 'error' },
      { name: 'home indicator', x: 0, y: 372, w: 852, h: 21, severity: 'warn' },
    ],
    keyboard: 209,
  },
  {
    id: 'duo-folded',
    label: 'iPhone Duo, folded',
    width: 466, height: 678, scale: 3, touch: true, userAgent: IOS_UA, native: true,
    insets: { top: 0, right: 84, bottom: 0, left: 0 },
    system: [
      { name: 'clock and camera', x: 382, y: 0, w: 84, h: 110, severity: 'error' },
    ],
    keyboard: 290,
  },
  {
    id: 'duo-upright',
    label: 'iPhone Duo, unfolded upright',
    width: 669, height: 951, scale: 3, touch: true, userAgent: IOS_UA, native: true,
    insets: { top: 80, right: 0, bottom: 34, left: 0 },
    system: [
      { name: 'clock pill', x: 539, y: 0, w: 130, h: 80, severity: 'error' },
      { name: 'home indicator', x: 0, y: 930, w: 669, h: 21, severity: 'warn' },
    ],
    keyboard: 320,
  },
  {
    id: 'duo-sideways',
    label: 'iPhone Duo, unfolded sideways',
    width: 951, height: 669, scale: 3, touch: true, userAgent: IOS_UA, native: true,
    insets: { top: 0, right: 84, bottom: 34, left: 0 },
    system: [
      { name: 'clock, camera and Wi-Fi', x: 867, y: 0, w: 84, h: 100, severity: 'error' },
      { name: 'home indicator', x: 0, y: 648, w: 951, h: 21, severity: 'warn' },
    ],
    keyboard: 264,
  },
  {
    id: 'ipad',
    label: 'iPad, upright',
    width: 820, height: 1180, scale: 2, touch: true, userAgent: IPAD_UA, native: true,
    insets: { top: 24, right: 0, bottom: 20, left: 0 },
    system: [
      { name: 'status bar', x: 0, y: 0, w: 820, h: 24, severity: 'error' },
    ],
    keyboard: 320,
  },
  {
    id: 'ipad-sideways',
    label: 'iPad, sideways',
    width: 1180, height: 820, scale: 2, touch: true, userAgent: IPAD_UA, native: true,
    insets: { top: 24, right: 0, bottom: 20, left: 0 },
    system: [
      { name: 'status bar', x: 0, y: 0, w: 1180, h: 24, severity: 'error' },
    ],
    keyboard: 400,
  },
  {
    id: 'desktop',
    label: 'Desktop browser',
    width: 1280, height: 800, scale: 2, touch: false, userAgent: null, native: false,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    system: [],
    keyboard: 0,
  },
];

export function profileById(id) {
  return PROFILES.find((p) => p.id === id) || null;
}
