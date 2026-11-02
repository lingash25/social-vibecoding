/**
 * #6019 (stage 5): a private thread, one the viewer started in their chat
 * with Homeroom bot (the AI tab). Everything in it is theirs alone until
 * they take it public:
 *
 *   Only you can see this thread.                    ← its head (PrivateThreadNote)
 *   …the thread…
 *   [New project]                                    ← its foot (PrivateThreadDoors)
 *
 * File it files its words as a request on a project; Post it posts them in
 * an existing thread as their own message. Since 1 Nov 2026 both are the
 * bot's to offer (below). Once one has been done the head says where the
 * thread went.
 *
 * An idea for no project yet has a third door (#6019 follow-up, plan v3:
 * "an idea with no community yet: Who is it for? starts a new project"):
 * New project asks who it is for (Just me, A group, A community) and opens
 * Create with the thread's words as the idea and that audience
 * (App.showCreateModal, first-session's make screen).
 *
 * 31 Oct 2026 (Evan): the doors are not at the top of every thread. They
 * come at its foot once Homeroom bot has answered in it, and only the ones
 * that apply (`doorsFor`): a drafted request is filed, a drafted reply is
 * posted, an idea is filed, or starts a project while it is in none, and a
 * question has nothing to take public. A door opens already pointed at the
 * thread's project, and at the thread a reply answers.
 *
 * 1 Nov 2026 (Evan): File it is not at the foot of every thread either. It
 * is Homeroom bot's to offer once there is something ready to file: its
 * offer (homeroom-bot-mayor.js offer_request, a draft's own card) carries
 * File it and Not now, and Post it under a drafted reply. The foot keeps
 * New project alone, for an idea in no project yet: the bot offers a
 * project only from a design (design-bot.js offer_project), so a design
 * thread has no door either. The routes the old doors wrote to stay
 * (routes/conversations.js, services/private-threads.js fileIt, postIt).
 *
 * The first render is nothing: where the thread stands is read in an effect
 * (`usePrivateThread`, held by the thread's pane for its head and its foot).
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { Button } from '@/components/ui/button';

export interface PrivateThreadState {
  state: 'open' | 'filed' | 'posted' | 'dropped';
  /** What it is (open only): absent from an older server, which reads as an idea. */
  kind?: 'draft_request' | 'draft_reply' | 'idea' | 'ask' | 'design';
  /**
   * 1 Nov 2026: whether it is the viewer's private thread at all: a row of
   * theirs, or a root that is their own message (services/private-threads.js
   * stateOf). Absent from an older server (isOwnPrivateThread).
   */
  mine?: boolean;
  number?: number | null;
  app?: { slug: string; name: string } | null;
  /** A drafted reply: the number of the thread it answers. */
  target?: number | null;
  href?: string | null;
}

export type Door = 'new';

/**
 * Pure: the doors a private thread offers at its foot. None until Homeroom
 * bot has answered in it (there is nothing shaped to take public yet), and
 * none once it went somewhere. File it and Post it are never here: they are
 * the bot's to offer, under its own reply, once something is ready. An idea
 * in no project (a thread they started, a "+" thread for any project) can
 * start one.
 */
export function doorsFor(where: PrivateThreadState | null, botReplied: boolean): Door[] {
  if (!where || where.state !== 'open' || !botReplied || where.mine === false) return [];
  // A design thread's bot offers the project itself (design-bot.js offer_project).
  if (where.kind === 'draft_request' || where.kind === 'draft_reply' || where.kind === 'design' || where.app) return [];
  return ['new'];
}

interface ThreadMessage {
  content?: string | null;
  sender: { id: number; bot?: boolean };
  metadata?: {
    homeroomBot?: {
      kind?: string; designTitle?: string;
      aboutKind?: 'request' | 'change'; aboutNumber?: number; aboutTitle?: string;
    } | null;
  } | null;
}

/**
 * Pure: whether a thread is the viewer's private thread, by the server's
 * word (`mine`); an older server, which does not say, by the old rule: the
 * root is their own message.
 */
export function isOwnPrivateThread(where: PrivateThreadState | null, root: ThreadMessage | null | undefined, meId: number): boolean {
  if (typeof where?.mine === 'boolean') return where.mine;
  return !!root && !root.sender.bot && !!meId && root.sender.id === meId;
}

function firstLine(text: string | null | undefined, max = 90): string {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Pure: the viewer's first message in the thread, its root aside. */
function firstOwn(replies: readonly ThreadMessage[], meId: number): ThreadMessage | null {
  return replies.find((message) => !message.sender.bot && !!meId && message.sender.id === meId) || null;
}

/** Pure: "#18 Dark mode", "Change #19 Night theme": what a thread opened from a request's or a change's page is about. */
export function aboutThreadTitle(kind: 'request' | 'change', number: number, title: string | null | undefined): string {
  const named = firstLine(title);
  if (kind === 'change') {
    return named ? translate('messages:ai.thread.aboutChange', { number: String(number), title: named })
      : translate('messages:ai.thread.aboutChangeUntitled', { number: String(number) });
  }
  return named ? translate('messages:ai.thread.aboutRequest', { number: String(number), title: named })
    : translate('messages:ai.thread.aboutRequestUntitled', { number: String(number) });
}

/**
 * Pure: a private thread's name over it in Main Chat's column, as the
 * Homeroom bot tab's list names it (services/ai-work.js shapePrivate): a
 * design thread by its screen; a thread off the bot's "+" by the viewer's
 * first words in it (1 Nov 2026: one the bot opened to draw a screen, by
 * the screen); a thread about a request or a change by it ("#18 Dark
 * mode"); anything else by its root's first line. Null while none of them
 * says anything (a "+" thread nobody has written in yet).
 */
export function privateThreadTitle(root: ThreadMessage | null | undefined, replies: readonly ThreadMessage[], meId: number): string | null {
  if (!root) return null;
  const meta = root.sender.bot ? root.metadata?.homeroomBot || null : null;
  if (meta?.kind === 'opened_design' && meta.designTitle) return firstLine(meta.designTitle);
  if (meta?.kind === 'opened_about' && (meta.aboutKind === 'request' || meta.aboutKind === 'change') && meta.aboutNumber) {
    return aboutThreadTitle(meta.aboutKind, meta.aboutNumber, meta.aboutTitle);
  }
  if (meta?.kind === 'opened_thread') return firstLine(firstOwn(replies, meId)?.content) || firstLine(meta.designTitle) || null;
  return firstLine(root.content) || null;
}

/**
 * Pure: the words File it and Post it start from: the root's, when it is
 * the viewer's own message; else (1 Nov 2026: a thread off a line of the
 * bot's) their first message in it, as the server takes them.
 */
export function privateThreadWords(root: ThreadMessage | null | undefined, replies: readonly ThreadMessage[], meId: number): string {
  if (root && !root.sender.bot && root.sender.id === meId) return root.content || '';
  return firstOwn(replies, meId)?.content || '';
}

/** Where a private thread stands, read when it opens; null for no thread, or until it is read. */
export function usePrivateThread(rootId: number | null): [PrivateThreadState | null, (next: PrivateThreadState) => void] {
  const [where, setWhere] = useState<PrivateThreadState | null>(null);
  useEffect(() => {
    setWhere(null);
    if (!rootId) return undefined;
    let live = true;
    fetch(`/api/conversations/homeroom-bot/threads/${rootId}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data && typeof data.state === 'string') setWhere(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [rootId]);
  return [where, setWhere];
}
type Audience = 'solo' | 'invited' | 'open';

/** The projects to pick from: the communities the viewer is in, in the switcher's order. Pure. */
export function projectChoices(scope: { list: string[] | null; info: Record<string, { name?: string }> }): Array<{ slug: string; name: string }> {
  return (scope.list || []).map((slug) => ({ slug, name: scope.info[slug]?.name || slug }));
}

/** The thread's head: that only they can see it, or where it went. */
export function PrivateThreadNote({ where }: { where: PrivateThreadState | null }): ReactNode {
  const t = useMessages('messages');
  if (!where) return null;
  if (where.state === 'filed' || where.state === 'posted') {
    const id = where.state === 'filed' ? 'messages:privateThread.filed' : 'messages:privateThread.posted';
    return (
      <div className="messages-bot-note px-4 py-2" data-private-thread={where.state}>
        {t(id, { number: where.number ?? '', project: where.app?.name || '' })}
        {where.href ? <>{' · '}<a href={where.href}>{t('messages:privateThread.open')}</a></> : null}
      </div>
    );
  }
  return <div className="messages-bot-note px-4 py-2" data-private-thread="open">{t('messages:privateThread.label')}</div>;
}

/** The thread's foot: New project, for an idea in no project yet, and who it is for. */
export function PrivateThreadDoors({ rootId, text, where, botReplied }: {
  rootId: number;
  text: string;
  where: PrivateThreadState | null;
  /** Homeroom bot has answered in the thread. */
  botReplied: boolean;
}): ReactNode {
  const t = useMessages('messages');
  const [door, setDoor] = useState<Door | null>(null);

  useEffect(() => { setDoor(null); }, [rootId]);

  const doors = doorsFor(where, botReplied);
  if (!where || !doors.length) return null;

  const startProject = (audience: Audience) => {
    const app = typeof window !== 'undefined' ? (window as any).App : null;
    app?.showCreateModal?.({ idea: text, audience });
  };
  return (
    <div className="px-4 py-2" data-private-doors={doors.join(' ')}>
      <div className="flex flex-wrap items-center gap-2">
        {doors.map((d) => (
          <Button key={d} type="button" variant="pillNeutral" size="sm" ink="neutral" data-private-door={d} aria-pressed={door === d} onClick={() => setDoor(d)}>
            {t('messages:privateThread.newProject')}
          </Button>
        ))}
      </div>
      {door === 'new' ? (
        <div className="mt-2 flex flex-col gap-2" data-private-form="new">
          <p className="messages-bot-note">{t('messages:privateThread.whoFor')}</p>
          <div className="messages-bot-answers" role="group" aria-label={t('messages:privateThread.whoFor')}>
            <button type="button" className="messages-bot-primary" data-private-audience="solo" onClick={() => startProject('solo')}><span>{t('messages:privateThread.forMe')}</span></button>
            <button type="button" className="messages-bot-secondary" data-private-audience="invited" onClick={() => startProject('invited')}><span>{t('messages:privateThread.forGroup')}</span></button>
            <button type="button" className="messages-bot-secondary" data-private-audience="open" onClick={() => startProject('open')}><span>{t('messages:privateThread.forCommunity')}</span></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
