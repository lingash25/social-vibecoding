/**
 * The look the device has chosen, for an island that draws differently
 * under one of them.
 *
 * `window.Skin` (frontend/src/head.html) keeps the choice on the device
 * and sets `data-skin` on <html> before first paint; app.css draws a look
 * from that attribute alone. An island that also CHANGES ITS MARKUP under
 * a look must not read it during its first render: the prerendered
 * document is skin-agnostic, so a first render that differed would be a
 * hydration mismatch — a console error, which fails proposal checks. So
 * `useSkin()` answers 'standard' until the island has mounted, then the
 * live value, and follows later changes (the Settings switch, another
 * tab) through `window.Skin.onChange`. One frame of the standard markup
 * before the look's is the price, and it is paid only on devices that
 * switched a look on.
 */
import { useEffect, useState } from 'react';

export type Skin = 'standard' | 'brand' | 'glass';

declare global {
  interface Window {
    Skin?: {
      get(): Skin;
      set(skin: Skin): void;
      apply(): void;
      onChange(fn: () => void): void;
    };
  }
}

const SKINS: readonly Skin[] = ['standard', 'brand', 'glass'];

/** The device's look right now; 'standard' when the head module is absent. */
export function currentSkin(): Skin {
  if (typeof window === 'undefined') return 'standard';
  try {
    const got = window.Skin?.get?.();
    return got !== undefined && SKINS.includes(got) ? got : 'standard';
  } catch {
    return 'standard';
  }
}

/** 'standard' on the first render, the live look after mount. */
export function useSkin(): Skin {
  const [skin, setSkin] = useState<Skin>('standard');
  useEffect(() => {
    setSkin(currentSkin());
    // The head module keeps its listeners for the page's life; there is
    // nothing to unsubscribe, and a stale setter on an unmounted island is
    // a no-op React tolerates.
    window.Skin?.onChange?.(() => setSkin(currentSkin()));
  }, []);
  return skin;
}
