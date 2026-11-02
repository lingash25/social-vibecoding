/**
 * #4666: WHO CAN CHANGE IT, AS YOU MAKE A PROJECT.
 *
 * A new project starts on You or the group (src/services/create-options.js),
 * and while it is just its maker every preset behaves the same, so making a
 * project asks nothing: it says the rule in one line under the description
 * and the name (features/first-session/make.tsx), with Change,
 *
 *   "Who can change it: You or the group"   Change
 *
 * and Change opens the four presets alone, with how each plays out, and the
 * reminder that it can be changed later on the project's page. A pick is
 * only the screen's until Make it sends it as the new project's own
 * `governance` block, so nothing is proposed. The invite sheet that follows
 * says nothing about it (owner, 11 Oct 2026: said once, where the project is
 * made); afterwards it is the Who can see & change it sheet's.
 *
 * The presets sheet is drawn through a portal on <body>: the make screen's
 * form rises on a transform, which would trap a fixed overlay inside it.
 *
 * WHAT HAPPENS NEXT (#5266, 20 Oct 2026): a small ⓘ right after the words
 * opens a tip saying what Make it leads to — a ready-made idea ready in
 * about a minute, Homeroom bot's plan and 20 to 30 min build, inviting
 * people, and what the rule means once others join. It is a tip, not a side
 * panel (the navigation review of 16 Oct: keep the idea tiles large, keep
 * the explanation out of the way), and it covers nothing until asked for:
 * it opens on hovering the ⓘ itself where there is a mouse, and on a tap or
 * click anywhere, and closes on Escape, a press elsewhere, or Change. It is
 * absolutely
 * positioned inside the line's own wrapper, so the form's transform does not
 * trap it and it needs no portal.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { InfoCircleIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { presetName, type PresetKey } from './model';
import { PlaysOut, PresetTiles, type Viewer } from './parts';

/** The sheet's slide, each way (`duration-200` below). */
export const SHEET_SLIDE_MS = 200;

function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** A mouse, not a finger: only there does the ⓘ's tip open on hover (#5266). */
function hasHover(): boolean {
  try { return !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
}

/**
 * IT LEAVES THE WAY IT CAME (polish board #8, 19 Oct 2026). It slid up over
 * 200ms and every way out (✕, Done, Use, the scrim, Escape) unmounted it in
 * the same frame, so it vanished. Now a way out slides it down first and
 * `onGone` takes it off the page when the slide has run (its transitionend,
 * or SHEET_SLIDE_MS and a little after, whichever comes first). With
 * reduced motion it goes at once.
 */
function PresetsSheet({ now, viewer, onPick, onGone }: {
  now: PresetKey;
  viewer: Viewer;
  onPick: (key: PresetKey) => void;
  onGone: () => void;
}) {
  const t = useMessages('onboarding');
  const [picked, setPicked] = useState<PresetKey>(now);
  const [shown, setShown] = useState(false);
  const leaving = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    const panel = panelRef.current;
    if (reducedMotion() || !panel) { goneRef.current(); return; }
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      panel.removeEventListener('transitionend', onEnd);
      goneRef.current();
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === panel && e.propertyName === 'transform') gone(); };
    panel.addEventListener('transitionend', onEnd);
    window.setTimeout(gone, SHEET_SLIDE_MS + 60);
    setShown(false);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const changed = picked !== now;
  return (
    <div className="fixed inset-0 z-[9002]" data-make-rule-sheet="">
      <div aria-hidden="true" onClick={close}
        className={`absolute inset-0 bg-[color:var(--pane-scrim)] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-rule-sheet-title"
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[92%] max-w-lg overflow-y-auto rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 text-start transition-transform duration-200 ease-out ${shown ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="make-rule-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.make.rule.title')}</h2>
          <button type="button" onClick={close} aria-label={t('onboarding:firstSession.make.rule.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-[14px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.make.rule.intro')}</p>
        <div className="mt-4">
          <PresetTiles picked={picked} now={now} viewer={viewer} onPick={setPicked} labelId="make-rule-sheet-title" />
        </div>
        <SectionHeader className="px-1 pb-1.5 pt-4">{t('onboarding:firstSession.make.rule.plays')}</SectionHeader>
        <PlaysOut preset={picked} viewer={viewer} />
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-4 flex items-center justify-center"
          data-make-rule-done=""
          onClick={() => { if (changed) onPick(picked); close(); }}>
          {changed ? t('onboarding:firstSession.make.rule.use', { preset: presetName(picked, viewer) }) : t('onboarding:firstSession.make.rule.done')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The Make it step's line, under the description and the name: who can
 * change the project it is about to make, and Change. `preset` is the
 * screen's own pick (You or the group until another is chosen); `who` is the
 * maker, who is its creator once it is made.
 */
export function MakeRuleLine({ preset, onPick, who }: { preset: PresetKey; onPick: (key: PresetKey) => void; who: string }) {
  const t = useMessages('onboarding');
  const [open, setOpen] = useState(false);
  // The ⓘ's tip (#5266): closed on the first render, so hydration matches.
  const [tipOpen, setTipOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Whether the mouse is what opened it (#5266 review, 20 Oct 2026): only a
  // hover-opened tip closes when the pointer leaves the ⓘ, so one opened by a
  // click stays until Escape, a press elsewhere, or Change.
  const hoverOpened = useRef(false);
  useEffect(() => {
    if (!tipOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTipOpen(false); };
    const onDown = (e: PointerEvent) => {
      if (wrapperRef.current && e.target instanceof Node && wrapperRef.current.contains(e.target)) return;
      setTipOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [tipOpen]);
  const viewer: Viewer = { isCreator: true, creator: who || null };
  const bold = <b className="font-semibold text-zinc-900 dark:text-zinc-100" />;
  return (
    <>
      <div
        ref={wrapperRef}
        className="relative"
      >
        <p data-make-rule={preset} className="mt-3 flex items-center gap-2 px-1 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
          <ShieldCheckIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          <span className="min-w-0 truncate">
            <RichMessage
              id="onboarding:firstSession.make.rule.line"
              values={{ preset: presetName(preset, viewer) }}
              components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]}
            />
          </span>
          {/* 44px of tap target, pulled back to the line's own height by its
              margins, so nothing under the line moves. The hover is the ⓘ's
              own, not the whole line's: the words alone are not a question. */}
          <span
            className="inline-flex shrink-0"
            onMouseEnter={() => { if (hasHover()) { hoverOpened.current = true; setTipOpen(true); } }}
            onMouseLeave={() => { if (hasHover() && hoverOpened.current) { hoverOpened.current = false; setTipOpen(false); } }}
          >
            <button
              type="button"
              data-make-rule-info=""
              aria-expanded={tipOpen}
              aria-controls="make-rule-tip"
              aria-label={t('onboarding:firstSession.make.next.open')}
              onClick={() => { hoverOpened.current = false; setTipOpen((was) => !was); }}
              className="-mx-2.5 -my-3.5 flex h-11 w-11 shrink-0 items-center justify-center text-zinc-500 dark:text-zinc-400"
            >
              <InfoCircleIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
          <button type="button" onClick={() => { hoverOpened.current = false; setTipOpen(false); setOpen(true); }} data-make-rule-change=""
            className="ms-auto shrink-0 font-semibold text-violet-700 dark:text-violet-400">
            {t('onboarding:firstSession.make.rule.change')}
          </button>
        </p>
        {tipOpen ? (
          <div
            id="make-rule-tip"
            role="note"
            data-make-rule-tip=""
            className="absolute bottom-full end-0 z-10 mb-1.5 w-[min(20rem,calc(var(--platform-float-w)-2rem))] rounded-2xl bg-white px-3.5 py-3 text-start shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_8px_24px_rgba(0,0,0,0.14)] dark:bg-zinc-900"
          >
            <p className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{t('onboarding:firstSession.make.next.title')}</p>
            <ul className="mt-1.5 list-disc ps-4 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
              <li className="mt-1"><RichMessage id="onboarding:firstSession.make.next.readyMade" components={[bold]} /></li>
              <li className="mt-1"><RichMessage id="onboarding:firstSession.make.next.custom" components={[bold]} /></li>
              <li className="mt-1"><RichMessage id="onboarding:firstSession.make.next.invite" components={[bold]} /></li>
              <li className="mt-1"><RichMessage id="onboarding:firstSession.make.next.rule" components={[bold]} /></li>
            </ul>
          </div>
        ) : null}
      </div>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <PresetsSheet now={preset} viewer={viewer} onPick={onPick} onGone={() => setOpen(false)} />,
          document.body,
        )
        : null}
    </>
  );
}
