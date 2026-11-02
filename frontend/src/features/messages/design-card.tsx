/**
 * A VERSION OF A DESIGN, SMALL, WHERE THE BOT SAYS IT (1 Nov 2026, threads,
 * one loop C1). Any private thread of the chat with Homeroom bot can hold a
 * design (src/services/design-threads.js): the bot draws a screen from words
 * there, and says each version in the thread ("Version 2: a green Save
 * button."). Under its words the version is drawn small, in a frame like the
 * design pane's (../design/frame.ts: its own origin, scripts and nothing
 * else, this site's stylesheets only), scaled to the card, and Open preview
 * opens the pane as the Homeroom bot tab's own column (../ai/preview.ts).
 *
 *   Version 2: a green Save button.
 *   ┌────────────┐
 *   │  (screen)  │
 *   └────────────┘
 *   Settings · version 2           [Open preview]
 *
 * The picture is not something to use: the frame takes no pointer or focus,
 * and pressing it opens the preview as the button does.
 *
 * The first render is a box of the card's size and nothing else: the design
 * and the version are read in effects, once per thread and version for every
 * card that shows them (`readDesign`, `readVersion`).
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { currentSheets, designFrameDoc, DESIGN_SANDBOX } from '../design/frame';
import { inlinePictures } from '../design/pictures';
import { openPreview } from '../ai/preview';
import * as api from './api';
import type { DesignThread } from './api';

// The card's picture: a phone screen 180px wide, a desktop one 320px, at
// most 260px tall (the top of the screen, where its point usually is).
const PHONE_W = 180;
const DESKTOP_W = 320;
const MAX_H = 260;

/** Pure: the box a version is drawn small in, and the scale that fits it. */
export function cardBox(design: { width: number; height: number } | null): { width: number; height: number; scale: number } {
  if (!design || !(design.width > 0) || !(design.height > 0)) return { width: PHONE_W, height: 160, scale: 1 };
  const width = design.width < 768 ? PHONE_W : DESKTOP_W;
  const scale = Math.min(1, width / design.width);
  return { width, height: Math.min(MAX_H, Math.round(design.height * scale)), scale };
}

// One read of a thread's design and of each version, shared by its cards:
// a design read again once a card names a version newer than it knew.
const designs = new Map<number, { latest: number; read: Promise<DesignThread> }>();
const versions = new Map<string, Promise<{ version: number; html: string }>>();

export function readDesign(rootId: number, version: number): Promise<DesignThread> {
  const had = designs.get(rootId);
  if (had && had.latest >= version) return had.read;
  const read = api.getDesign(rootId);
  const entry = { latest: version, read };
  designs.set(rootId, entry);
  read.then((d) => { entry.latest = Math.max(version, d.latest); }, () => { designs.delete(rootId); });
  return read;
}

export function readVersion(rootId: number, version: number): Promise<{ version: number; html: string }> {
  const at = `${rootId}:${version}`;
  let read = versions.get(at);
  if (!read) {
    read = api.getDesignVersion(rootId, version);
    versions.set(at, read);
    read.catch(() => { versions.delete(at); });
  }
  return read;
}

/** Pure: the version a bot message in a thread says, or null. */
export function designVersionOf(message: { sender?: { bot?: boolean }; metadata?: { homeroomBot?: { designVersion?: number } | null } | null }): number | null {
  const n = Number(message?.metadata?.homeroomBot?.designVersion);
  return message?.sender?.bot && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function DesignVersionCard({ conversationId, rootId, version, title = null }: {
  conversationId: number;
  rootId: number;
  version: number;
  /** The design's name, as the message carries it. */
  title?: string | null;
}): ReactNode {
  const t = useMessages('messages');
  const [design, setDesign] = useState<DesignThread | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    readDesign(rootId, version).then((found) => {
      if (!live) return;
      setDesign(found);
      // P8: the pictures it names, written in (../design/pictures.ts).
      return readVersion(rootId, version).then((v) => inlinePictures(v.html)).then((html) => {
        if (!live) return;
        const sheets = found.surface === 'platform' ? currentSheets() : [];
        setDoc(designFrameDoc(html, { origin: window.location.origin, sheets }));
      });
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [rootId, version]);

  const box = cardBox(design);
  const named = title || design?.title || '';
  const open = () => openPreview({ conversationId, rootId, version });
  return (
    <div className="messages-design-card mt-2 flex w-fit max-w-full flex-col gap-2" data-design-card={version}>
      <div
        className="relative overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_var(--app-sheet-line)]"
        style={{ width: box.width, height: box.height }}
      >
        {doc && design ? (
          <iframe
            title={t('messages:design.card.frameTitle', { version })}
            sandbox={DESIGN_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={doc}
            tabIndex={-1}
            aria-hidden="true"
            style={{
              width: design.width, height: design.height, transform: `scale(${box.scale})`, transformOrigin: '0 0',
              border: 0, background: '#fff', pointerEvents: 'none',
            }}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[12px] text-zinc-500">
            {failed ? t('messages:design.card.failed') : t('messages:design.pane.loading')}
          </span>
        )}
        <button
          type="button"
          className="absolute inset-0 h-full w-full cursor-pointer"
          onClick={open}
          aria-label={t('messages:design.card.openVersion', { version })}
          data-design-card-picture=""
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-500 dark:text-zinc-400">
          {named ? t('messages:design.card.label', { title: named, version }) : t('messages:design.pane.versionOption', { version })}
        </span>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={open} data-design-card-open="">
          {t('messages:design.card.open')}
        </Button>
      </div>
    </div>
  );
}
