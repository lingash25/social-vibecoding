/**
 * The conversation under a change's card: ONE sheet, the Discussion.
 *
 * ── The build surface is not on this page ─────────────────────────────
 *
 * The sheet used to be three tabs, Discussion / Build / Activity, then a
 * Discussion sheet with a Build sheet folded under it. Both are gone (#2605).
 * Build is a place the AUTHOR works and a reader rarely looks, and squeezing
 * a whole dev session under a card's discussion gave it neither the room nor
 * the address it needs. The card's pill — "Continue building" / "Open build"
 * / "Read the build" (`_topicCard`) — now NAVIGATES, to the change's own dev
 * session page, which is where the workspace and the published chat both
 * live. `AppView.openChangeWorkspace` routes there unconditionally, so there
 * is no `change-workspace-open` event and nothing on this page listens for
 * one.
 *
 * ── The Discussion speaks the general chat's language ─────────────────
 *
 * `mountChangeDiscussion` mounts the thread with `language: 'chat'`
 * (public/js/group-chat.js): a person's message sits in a bubble, the
 * viewer's own on the right, and every notice the platform posted about the
 * change — proposed, voted, merged, a check verdict — is a message from
 * whoever did it, with one box under the header. The quiet card ends the
 * list while nobody has commented. Only a change's Discussion: an issue's
 * thread keeps its flat rows and centred lines.
 *
 * ── People, not the agent (#2842) ─────────────────────────────────────
 *
 * The box looks like a chat, and readers took it for the AI agent's: they
 * typed instructions into it and waited for code. It is the GROUP's thread,
 * so the sheet says so under its heading, and — when this viewer has a way
 * to keep building — names that door beside it: the author's own dev
 * session ("Continue building", or the agent session it came from), or for
 * anybody else a dev chat seeded with this proposal ("Explore in dev chat").
 * Both are the action band's own specs, found by key; nothing new is called.
 */

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { unmountLegacyPortal } from '../../../lib/legacy-portals';
import type { ActionSpec, DevCardModel } from '../card/model';
import type { TopicBody } from './model';

export function mountChangeDiscussion(host: HTMLElement, id: number, readOnly: boolean) {
  (window as any).GroupChat?.mountThread({ type: 'session', ref: id, container: host,
    fullHeight: true, withHeader: false, readOnly, language: 'chat',
    notice: readOnly ? "You're viewing this app's dev space read-only. Only collaborators can post." : undefined });
}

function Discussion({ id, readOnly }: { id: number; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = host.current!;
    const gc = (window as any).GroupChat;
    // The bridge flushes synchronously. Invoke it after React's commit,
    // never from inside an effect's commit stack. The host is an empty leaf.
    const timer = setTimeout(() => {
      if (!slot.isConnected) return;
      mountChangeDiscussion(slot, id, readOnly);
    }, 0);
    return () => {
      clearTimeout(timer);
      const list = slot.querySelector('#gc-thread-messages');
      setTimeout(() => {
        // A route may already have opened another thread by now. Its
        // controller state must survive this detached host's cleanup.
        if (!document.getElementById('gc-thread-messages') && gc?.activeThread?.type === 'session'
          && Number(gc.activeThread.ref) === id) gc.unmountThread();
        if (list) gc?._react()?.unmountTranscript(list);
        unmountLegacyPortal(slot);
      }, 0);
    };
  }, [id, readOnly]);
  return <div ref={host} className="dev-conversation-chat" data-change-discussion={id} />;
}

/**
 * The band action that continues the work with the AI agent, if this viewer
 * has one: the author's Build door (never the read-only "Read the build"),
 * else the Explore pill. Null for a read-only viewer — the band drew neither.
 */
export function agentDoor(card: Pick<DevCardModel, 'actions'> | null | undefined, body: Pick<TopicBody, 'build'>): ActionSpec | null {
  const actions = (card && card.actions) || [];
  if (body.build && body.build.kind === 'owner') {
    const build = actions.find((a) => a.key === 'build' && a.act);
    if (build) return build;
  }
  return actions.find((a) => a.explore != null && a.act) || null;
}

/** The Discussion sheet, and nothing under it. */
export function ChangeConversation({ body, card }: { item: any; body: TopicBody; card?: DevCardModel | null }) {
  const id = Number(body.changeId);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  // A read-only viewer has nowhere to build — not even the change's own
  // author, whose Build door the band still draws (it opens read-only).
  const door = av?.readOnly ? null : agentDoor(card, body);
  return (
    <section className="dev-topic-sheet dev-conversation" data-change-conversation={id} aria-label="Discussion">
      <h4 className="dev-topic-h">Discussion with the group</h4>
      {body.discussion
        ? <p className="dev-topic-note">{body.discussion}</p>
        : (
          <>
            <p className="dev-topic-note dev-conversation-audience">
              Visible to the group
              <span className="dev-conversation-people">{' · Messages here go to people, not to the AI agent.'}</span>
            </p>
            {door ? (
              <p className="dev-topic-note dev-conversation-agent" data-agent-door={door.key}>
                <span>To change the code, work with the AI agent:</span>
                <Button
                  type="button"
                  variant="pillAccent"
                  size="xsText"
                  title={door.title}
                  onClick={() => {
                    const fn = door.act!.fn;
                    if (av && typeof av[fn] === 'function') av[fn](...(door.act!.args || []));
                  }}
                >{door.label}</Button>
              </p>
            ) : null}
            <Discussion id={id} readOnly={!!av?.readOnly} />
          </>
        )}
    </section>
  );
}
