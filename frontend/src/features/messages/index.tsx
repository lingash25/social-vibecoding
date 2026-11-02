import { openReport } from '../dialogs/report';
import {
  Fragment, memo, useDeferredValue, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  ChatStatusLine, JumpToLatestButton, NewMessagesBanner, NewMessagesDivider, TranscriptOverlay, groupsWithPrevious,
} from '@/components/ui/chat';
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, ChatIcon, ChevronDownIcon, ChevronLeftIcon, EllipsisHorizontalIcon, LockIcon, PencilSparklesIcon,
  PlusIcon, SearchIcon, SparklesIcon, UserGroupIcon, XIcon,
} from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { cardRunLabel, cardRunStarts } from '../../lib/card-runs';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { useCommunityColor } from '../../lib/community-color';
import { dirSign, ownDirection } from '../../lib/i18n/direction';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { unmountLegacyPortal } from '../../lib/legacy-portals';
import { confirmAction } from '../../lib/confirm';
import { useMenuKeyboard } from '../../lib/menu-keys';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { agoStamp, timeOfDay } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { BotActivitySync, isActivityMessage, isMovedActivity } from './bot-activity';
import { botHead } from './bot-head-card';
import { NO_PLAN_LAYOUT, isPlanMessage, planLayout } from './bot-plan';
import { botMeta } from './bot-question';
import { isReadyMessage } from './bot-ready';
import {
  alsoInChat, botRequestNames, botThreadTitle, changeBlocks, dotText, threadsAllowed, type ChangeBlock,
} from './bot-shared';
import { POLL_MS } from './bot-activity-store';
import { BotWorkSync, loadBotWork, newestBotMessageId, useBotWork, WORK_CHANGED_EVENT } from './bot-work';
import {
  PrivateThreadDoors, PrivateThreadNote, isOwnPrivateThread, privateThreadTitle, privateThreadWords, usePrivateThread,
} from './private-thread-bar';
import { requestPageOf } from './request-page';
import { BotStrip, RequestTag, stripGroups, summaryParts } from './bot-strip';
import { useTrackOf } from './bot-track';
import { asksInChat, BotNewsLine, foldBotNews, isBotNews, newsStatusOf, SettledRun, type SettledRunItem } from './bot-news-line';
import { requestKey } from './bot-request';
import { MessageComposer } from './composer';
import { useMessagesDrawer, type Peek } from './phone-drawer';
import { messagesDrawerStore } from '../nav-drawer/messages-drawer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { fullTime, UserAvatar, senderName } from './format';
import { DiscussionRow, MessageRow } from './message-row';
import { OPEN_HOLD_MS, openHoldDone } from './open-hold';
import { plainText } from './plain-text';
import { useDismiss } from '../message-actions/use-dismiss';
import { ShareItemDialog } from './share-dialog';
import { ShareToDialog } from './share-to-dialog';
import { JumpToLatest } from './jump-to-latest';
import { centreInScroller, isNearTop, needsMoreHistory, useStickToBottom } from './stick-to-bottom';
import {
  firstUnreadId, jumpLabel, lineTopIn, messageRow, newMessagesLabel, openingScrollTop, useLineHold, useUnreadAffordances,
} from './unread-anchor';
import {
  agentThreadAddress,
  clearThreadFocus,
  closeThread,
  embed,
  fullScreenAddress,
  initializeMessagesStore,
  finishDirectBlock,
  jumpToPresent,
  loadConversations,
  loadNewer,
  loadOlder,
  loadOlderReplies,
  loadReplyThread,
  messagesController,
  open as openConversation,
  openAgentThread,
  renameConversation,
  openThread,
  release,
  respond,
  setUserBlocked,
  selectConversation,
  setListCollapsed,
  setSectionFolded,
  FOLDABLE,
  syncChrome,
  followPlatformSlug,
  typingUsers,
  useChannelHandles,
  useMessagesSnapshot,
} from './store';
import { typingLine } from './typing-line';
import { BotWorkingCard, typingBesides, workingBot } from './bot-working';
import { DesignPane, DesignViewSwitch, isDesignRoot, isDesignThread, setDesignView, useDesignView } from './design-pane';
import { openPreview, usePreview } from '../ai/preview';
import { NewThreadButton, NewThreadPanel, startedThreadTitle, useNewThread } from './new-thread';
import { issueRefHref } from './channels';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { PageBackButton } from '../dev-board/workshop/page-back';
import { generalHubBack, openChannelHub, usePlatformSlug } from './channel-hub';
import { ThreadActivityCard } from '../message-actions/thread-activity';
import { AgentSessionPanel } from '../agent-session';
import { useSidePaneBeside } from '../agent-session/spec-layout';
import { agentActivity } from '../agent-session/activity';
import { AgentActivityIcon } from '../agent-session/activity-mark';
import {
  deactivateAgentSession,
  getAgentSessionState,
  loadAgentSessions,
  openAgentSession,
  startAgentSession,
  useAgentChatsShown,
  useAgentSessionSelector,
  useAgentSessions,
} from '../agent-session/store';
import { listArchivedSessions } from '../agent-session/api';
import type { AgentSession as MayorSession } from '../agent-session/api';
import { changeRowWords } from '../agent-session/transcript';
import { Improve } from '../improve/improve-controller.js';
import { improveStore } from '../improve/improve-store.js';
import { SessionRow, type SessionRowView } from '../improve/session-row';
import { INBOX_QUERY_MAX, INBOX_SECTIONS, agentAsksForYou, buildInbox, savedInboxQuery, shownInSection, type AppDiscussion, type InboxSection } from './inbox';
import { publishRailInbox, railCandidates, railConversations, type RailConversation } from './rail-inbox';
import { useSidebarRows } from '../nav/sidebar-rows';
import type { ConversationDetail, ConversationMessage, ConversationSummary, DiscussionMessage, MessagesAgentThread } from './types';

/*
 * ── The screen, in the widget language ─────────────────────────────────
 *
 * Messages is drawn on the dev session's LIFT LADDER (`.dc-lift` and its two
 * plane classes in app.css). The wallpaper is the ground. `.messages-layout`
 * is the frosted STRIP: it carries the screen's title, the New disc and the
 * conversation rows, drawn straight on it. The open conversation is the
 * frosted SHEET rising on the strip — `.messages-thread-pane` — and it
 * carries everything about that conversation: its title row with the
 * actions, the transcript, the typing line and the composer.
 *
 * The same construction at both widths. On a phone the list screen IS the
 * strip, and a thread is the strip's shoulder showing above the sheet; from
 * 768px up both panes render on one strip with the sheet beside the list.
 * That is what makes the two read as one screen at two widths rather than a
 * phone layout and a desktop layout.
 *
 * The transcript has ONE shape now, Discord's (#2783): every conversation —
 * a DM, a group, #general — is a named-row transcript, with consecutive
 * messages from one person grouped under a single name. DMs lost their
 * bubbles so that a chat reads the same whichever section it sits in.
 * ./message-row.tsx draws it.
 *
 * The LIST is Discord's too: the chats (people and agents) on top, newest
 * first, then the channels — #general and one per app you are a member of.
 */

function openDialog(name: 'messagesCreate' | 'messagesMembers' | 'messagesShare', payload?: unknown) {
  window.UsernodeReact?.dialogs?.[name]?.open(payload);
}

function conversationPeer(conversation: ConversationSummary) {
  const currentUserId = typeof window !== 'undefined' ? Number(window.App?.user?.id) : 0;
  return conversation.peer || (conversation.kind === 'direct'
    ? conversation.members.find((member) => Number(member.id) !== currentUserId) || null
    : null);
}

/**
 * QA 2026-09-24 Q33a: who a direct conversation is WITH, for its name and
 * face. An accepted one is its peer. A request the viewer has not answered
 * yet carries no peer — the roster stays hidden until acceptance — but it
 * does carry its requester, deliberately, "so the recipient can decide"
 * (services/conversations.js serializeConversation). That requester IS the
 * other person of a direct request, so the row and the header name them
 * rather than reading "Direct message" over an anonymous "DM" tile.
 */
function directPerson(conversation: ConversationSummary) {
  if (conversation.kind !== 'direct') return null;
  return conversationPeer(conversation)
    || (conversation.membershipStatus === 'invited' ? conversation.requester || null : null);
}

/**
 * How many people a group row holds: the people glyph and the figure, the
 * same UserGroupIcon at the same size the join screen draws before a
 * community's member count (AGENTS.md, "Say it in words or a very obvious
 * glyph"). The glyph and the figure are hidden from a screen reader, which
 * hears the words instead ("5 members"); the hover title says the same. A
 * zero says nothing, so a group with no count yet shows no tag.
 */
function GroupMemberCount({ count }: { count: number }) {
  const t = useMessages('messages');
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) return null;
  const words = t('messages:inbox.memberCount', { count: n });
  return (
    <span className="messages-group-tag" title={words}>
      <UserGroupIcon className="w-3.5 h-3.5" aria-hidden="true" />
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}

/**
 * #5393: what a group row's tile is — the faces of the people in it, not the
 * title's first letters. Up to two of the other members, stacked in the same
 * 44px box the `lg` square takes, so the row's own geometry (the 74px
 * separator inset) holds. The viewer is never one of the faces. One other
 * member is their face at full size; nobody known keeps the title's
 * initials, as today. A member with no photo falls back to their initials
 * tile, the way avatars look everywhere else.
 */
function GroupFaces({ conversation }: { conversation: ConversationSummary }) {
  const viewerId = typeof window !== 'undefined' ? Number(window.App?.user?.id) : 0;
  const others = conversation.members
    .filter((member) => member.status === 'member' && Number(member.id) !== viewerId)
    .slice(0, 2);
  if (others.length === 2) {
    return (
      <span className="messages-group-faces" aria-hidden="true">
        <UserAvatar user={others[0]} size="sm" shape="square" />
        <UserAvatar user={others[1]} size="sm" shape="square" />
      </span>
    );
  }
  if (others.length === 1) return <UserAvatar user={others[0]} size="lg" shape="square" />;
  return <UserAvatar user={null} title={conversation.title} size="lg" shape="square" />;
}

const ConversationRow = memo(function ConversationRow({ conversation, active, preview = null }: {
  conversation: ConversationSummary;
  active: boolean;
  /** 16 Oct 2026: the Homeroom bot's row says what waits on you, not its last message. */
  preview?: string | null;
}) {
  const t = useMessages('messages');
  const peer = directPerson(conversation);
  const invited = conversation.membershipStatus === 'invited';
  const unread = conversation.unreadCount > 0;
  // #1808: the shared ago ladder, which stops being relative at a week — a
  // conversation last spoken in during March read "412d", which is a duration
  // and not information. `title` carries the unelided instant either way.
  const activity = agoStamp(conversation.lastActivityAt);
  // #5393: in a group the preview names its last sender, the way #general's
  // row already does — "@name: …", or "You: …" when the viewer wrote it. A
  // message with no person behind it (a platform line) keeps the bare
  // summary. A direct message and an invitation keep their previews as they
  // are, and the bot's own line (`preview`) still wins where it is given.
  const groupSender = conversation.kind === 'group' && !invited
    ? conversation.latestMessage?.sender || null
    : null;
  const groupPreview = groupSender?.id && conversation.latestSummary
    ? (Number(groupSender.id) === Number(window.App?.user?.id)
      ? t('messages:inbox.previewYou', { message: ownDirection(conversation.latestSummary) })
      : t('messages:inbox.previewBy', { username: groupSender.username, message: ownDirection(conversation.latestSummary) }))
    : null;
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      className={`messages-conversation-row ${conversation.homeroomBot ? 'messages-bot-row' : ''} ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      {conversation.kind === 'group' && !invited
        ? <GroupFaces conversation={conversation} />
        : <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={peer?.username || conversation.title} size="lg" shape="square" />}
      <div className="min-w-0 flex-1">
        {/* Two lines, the row's own geometry: the name with the time on its
            trailing edge, then the preview with the unread count on its. The
            time and the count read as one column, which is what lets an
            unread row state itself three ways — bold name, the time in ink,
            "2 new" in grey (#18: grey is new to read, the accent is waiting
            on you) — without adding a third line. */}
        <div className="messages-row-line">
          <span className="messages-row-name">{conversation.kind === 'direct' && peer ? senderName(peer, { bare: true }) : conversation.title}{conversation.kind === 'direct' && peer?.bot ? <span className="messages-bot-badge">{t('messages:inbox.aiBadge')}</span> : null}{conversation.kind === 'group' && !invited ? <GroupMemberCount count={conversation.memberCount} /> : null}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
        </div>
        <div className="messages-row-line">
          <span className={`messages-row-preview ${invited ? 'messages-row-preview-invited' : ''}`}>{invited ? (conversation.kind === 'direct' ? t('messages:inbox.requestReview') : t('messages:inbox.invitationReview')) : groupPreview ?? (ownDirection(preview || conversation.latestSummary || '') || t('messages:inbox.noMessages'))}</span>
          {conversation.unreadCount > 0 ? <span className="messages-unread">{t('messages:inbox.newCount', { count: conversation.unreadCount })}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * #general, the room every user is in (#2783).
 *
 * A `channel` conversation, so unlike an app's channel it DOES carry an
 * unread count: it lives in the conversations domain, which keeps a read
 * cursor per member. The tile is the `#` a channel is named with, where a
 * person's row has their face.
 */
const GeneralChannelRow = memo(function GeneralChannelRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const t = useMessages('messages');
  const unread = conversation.unreadCount > 0;
  const activity = agoStamp(conversation.lastActivityAt);
  const by = conversation.latestMessage?.sender?.username;
  const handle = conversation.channelKey || conversation.title;
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="messages-inbox-tile messages-channel-tile" aria-hidden="true">#</span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{handle}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {conversation.latestSummary
              ? (by ? t('messages:inbox.previewBy', { username: by, message: ownDirection(conversation.latestSummary) }) : ownDirection(conversation.latestSummary))
              : t('messages:inbox.everyone')}
          </span>
          {unread ? <span className="messages-unread">{t('messages:inbox.newCount', { count: conversation.unreadCount })}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * An app's channel — the general thread on its board, one per app the
 * viewer is a member of, including one nobody has spoken in yet (#2783).
 *
 * It carries NO unread count, and its absence is honest rather than an
 * omission: `chat_messages` has no per-viewer read cursor, so a number here
 * would be invented. What the row says instead is when the last thing was
 * said and who said it, which is what makes it worth a tap.
 *
 * An anchor at the channel's address in this inbox, so a modified click
 * opens it in a tab the way every other row on this screen does.
 */
const AppChannelRow = memo(function AppChannelRow({ discussion, active }: { discussion: AppDiscussion; active: boolean }) {
  const t = useMessages('messages');
  const activity = discussion.lastAt ? agoStamp(discussion.lastAt) : null;
  // #2387: app channels keep a read cursor now, so they carry a count like
  // #general's — only while the viewer is not reading it.
  const unread = !active && (discussion.unreadCount || 0) > 0 ? discussion.unreadCount || 0 : 0;
  const record = {
    icon_url: discussion.iconUrl,
    icon_emoji: discussion.iconEmoji,
    name: discussion.name,
  };
  const handle = discussion.channel || discussion.slug;
  return (
    <a
      href={`#messages/app/${encodeURIComponent(discussion.slug)}`}
      data-inbox-app={discussion.slug}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <AppIconLink
        nested
        slug={discussion.slug}
        name={discussion.name}
        data-icon={appIconKind(record as never)}
        className="app-icon-tile messages-inbox-tile"
      >
        <AppIconContent app={record as never} />
      </AppIconLink>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{discussion.name}<span className="messages-channel-handle">#{handle}</span></span>
          {activity
            ? <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={discussion.lastAt || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {discussion.lastMessage
              ? (discussion.lastBy ? t('messages:inbox.previewBy', { username: discussion.lastBy, message: ownDirection(plainText(discussion.lastMessage)) }) : ownDirection(plainText(discussion.lastMessage)))
              : t('messages:inbox.noMessages')}
          </span>
          {unread ? <span className="messages-unread">{t('messages:inbox.newCount', { count: unread })}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * A change in flight, as a row of this inbox (#2770, #2772).
 *
 * ── A change IS an agent conversation ─────────────────────────────────
 *
 * A dev session is the viewer talking to the agent that builds, which is
 * what an agent session is too — so it is listed under Agents beside them,
 * and New change lands on one. A change somebody had just started was once
 * findable from the Workshop and the bell's Agents tab but not from here.
 *
 * ── The same row, from the same list ──────────────────────────────────
 *
 * The bell's Agents tab already draws these, with ../improve/session-row.tsx
 * from the Improve store's own list (`sessions` + `otherSessions`, one
 * fetch of /api/me/active-sessions). So this reads that store and draws that
 * row: a second copy of the list would drift, and a second row would let a
 * change's Working / Ready state say two things in two places.
 *
 * ── Where the row goes ────────────────────────────────────────────────
 *
 * The session itself, the conversation, rather than the change's card page
 * the bell links. Since #2813 that is `#messages/session/<slug>/<id>`: on a
 * desktop the session opens in the pane beside this list. On a phone the
 * router swaps that address for `#app/<slug>/dev/sessions/<id>`, the
 * full-screen session, which lights the Messages tab and hangs its chevron
 * off this inbox. The router records that (`Improve.enterSessionFrom`) as
 * it swaps, because the route being left is not an app route and the
 * Improve store cannot tell. A work order has no conversation here, so it
 * keeps its own destination.
 */
function inboxSessionView(session: SessionRowView): SessionRowView {
  if (session.kind !== 'session' || !session.appSlug) return session;
  return {
    ...session,
    // #2813: the inbox's own address for the session, so on a desktop it
    // opens in the pane beside this list. On a phone the router swaps it for
    // `#app/<slug>/dev/sessions/<id>` — and records `Improve.enterSessionFrom`
    // there, which this row's click used to — so the session is still the
    // full-screen conversation it was, with its chevron back to this inbox.
    href: agentThreadAddress({ kind: 'session', slug: session.appSlug, id: session.id }),
  };
}

const AgentSessionRow = memo(function AgentSessionRow({ session, active }: { session: SessionRowView; active: boolean }) {
  return (
    <div
      className={`messages-inbox-session ${active ? 'messages-inbox-session-active' : ''}`}
      data-inbox-session={session.key}
      aria-current={active ? 'page' : undefined}
    >
      <SessionRow session={session} showApp onNavigate={() => {}} tile={<ChangeTile session={session} />} />
    </div>
  );
});

/**
 * A change in flight's tile in Agents (16 Oct 2026): an agent's pencil in
 * its project's colour, not the project's own icon. Homeroom's icon is the
 * bot's face, so a change to Homeroom drawn with it read as a second bot
 * beside the bot's own row. The row still names the project on a phone.
 */
function ChangeTile({ session }: { session: SessionRowView }) {
  const { icon } = session;
  const color = useCommunityColor({
    key: session.appSlug || session.appName,
    iconUrl: icon.kind === 'image' ? icon.src : null,
    iconEmoji: icon.kind === 'emoji' ? icon.emoji : null,
  });
  return (
    <span className="messages-inbox-change-tile" style={{ '--change-ink': color } as CSSProperties} aria-hidden="true">
      <PencilSparklesIcon />
    </span>
  );
}

/**
 * What the "+" can start, in the order the popover lists them: the agent,
 * then people. #5380 renamed the agent row to "Agent chat" and took Homeroom
 * bot out: the menu starts new conversations, and the bot's one conversation
 * is reached from the top of Agents.
 */
const NEW_CHOICES = [
  // #2779: a conversation with the Mayor that works on any app, so there is
  // no app to pick first. It replaced "Agent chat", which asked which app and
  // opened a classic dev session there; those are no longer created.
  { key: 'agent', label: 'messages:inbox.new.agent.label', hint: 'messages:inbox.new.agent.hint' },
  { key: 'direct', label: 'messages:inbox.new.direct.label', hint: 'messages:inbox.new.direct.hint' },
  { key: 'group', label: 'messages:inbox.new.group.label', hint: 'messages:inbox.new.group.hint' },
] as const;
type NewChoice = typeof NEW_CHOICES[number]['key'];

function startNew(choice: NewChoice) {
  // DM and group are the create dialog, opened on the matching tab.
  if (choice === 'agent') void startAgentSession({ entry: 'messages' });
  else openDialog('messagesCreate', choice);
}

/**
 * The "+" and its popover (#2778), beside the search since the filter strip
 * went (16 Oct 2026).
 *
 * The popover is placed and dismissed exactly as the vote picker's desktop
 * home is — lib/anchor-popover.ts and lib/popover-dismiss.ts are that code,
 * shared — and portalled to
 * the body so the list's own scroller cannot clip it. On touch it is the
 * kit's action sheet instead, which is what a three-row menu is on a phone.
 *
 * Nothing is rendered until the button is pressed, so the prerendered
 * document holds the button alone and hydration has nothing to disagree
 * about.
 *
 * KEYBOARD (QA 2026-09-24 Q18): opening moves focus to the first row, the
 * arrows move between rows, Escape and Tab close it back onto the "+"
 * (lib/menu-keys.ts). Before, Enter opened a menu that focus never reached:
 * it is portalled to the end of <body>, so Tab walked the whole page first.
 */
function NewMessageButton() {
  const t = useMessages('messages');
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const open = !!rect;
  const shut = () => setRect(null);
  useAnchoredDismiss(open, [btnRef, popRef], shut);
  const menuKeys = useMenuKeyboard(open, popRef, btnRef, shut);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) { shut(); return; }
    const pu = (window as any).PlatformUI;
    if (pu && typeof pu.isTouch === 'function' && pu.isTouch() && typeof pu.actionSheet === 'function') {
      pu.actionSheet({
        actions: NEW_CHOICES.map((item) => ({ label: t(item.label), handler: () => startNew(item.key) })),
      });
      return;
    }
    setRect(anchorRectOf(event.currentTarget));
  };
  // Focus goes back to the "+" BEFORE the dialog opens, so the dialog's own
  // focus restore (the kit records what was focused when it presents) lands
  // on the button rather than on a row this close is about to unmount.
  const choose = (choice: NewChoice) => { btnRef.current?.focus({ preventScroll: true }); shut(); startNew(choice); };
  const pos = rect
    ? placeUnderAnchor(rect, { width: 260, height: 54 * NEW_CHOICES.length + 2 }, { width: window.innerWidth, height: window.innerHeight })
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id="messages-new"
        className="messages-new-btn"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={t('messages:inbox.new.button')}
        title={t('messages:inbox.new.button')}
        onClick={toggle}
      >
        <PlusIcon aria-hidden="true" />
      </button>
      {open && pos ? createPortal(
        <div
          ref={popRef}
          id="messages-new-menu"
          className="messages-new-pop"
          role="menu"
          aria-label={t('messages:inbox.new.menuName')}
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={menuKeys.onKeyDown}
        >
          {NEW_CHOICES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              data-new-choice={item.key}
              className="messages-new-option"
              onClick={() => choose(item.key)}
            >
              {item.key === 'direct' ? <ChatIcon aria-hidden="true" /> : null}
              {item.key === 'group' ? <UserGroupIcon aria-hidden="true" /> : null}
              {item.key === 'agent' ? <SparklesIcon aria-hidden="true" /> : null}
              <span className="min-w-0">
                <span className="messages-new-option-label">{t(item.label)}</span>
                <span className="messages-new-option-hint">{t(item.hint)}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** The heading over each section of the list (16 Oct 2026). */
const SECTION_LABELS: Record<InboxSection, string> = {
  agents: 'messages:inbox.section.agents',
  people: 'messages:inbox.section.people',
};

/**
 * A section's heading (16 Oct 2026): its name in small caps, and what in it
 * asks for you ("1 working", "3 unread"), which stays when it is folded.
 * Agents folds from the heading itself, a button the width of the list, and
 * keeps the Homeroom bot's row folded. People does not fold: it is the
 * list's last section, so folding it saved no scrolling.
 */
function SectionHead({ section, folded, aside, ask = false }: {
  section: InboxSection;
  folded: boolean;
  aside: string | null;
  ask?: boolean;
}) {
  const t = useMessages('messages');
  const words = (
    <>
      <span className="messages-section-name">{t(SECTION_LABELS[section])}</span>
      {aside ? <span className={`messages-section-aside ${ask ? 'messages-section-aside-ask' : ''}`}>{aside}</span> : null}
    </>
  );
  if (!FOLDABLE.includes(section)) {
    return <h3 className="messages-section-head" data-inbox-section={section}>{words}</h3>;
  }
  return (
    <h3 className="messages-section-head" data-inbox-section={section}>
      <button
        type="button"
        className="messages-section-toggle"
        data-inbox-fold={section}
        aria-expanded={!folded}
        onClick={() => setSectionFolded(section, !folded)}
      >
        {words}
        <ChevronDownIcon className={`messages-section-chevron ${folded ? '-rotate-90' : ''}`} aria-hidden="true" />
      </button>
    </h3>
  );
}

/**
 * Narrow the inbox by what a row SAYS, not by what it is.
 *
 * A CLIENT-SIDE MATCH over the three lists already in memory, so it answers
 * on every keystroke and adds no endpoint. What it matches is the text each
 * row draws — a person's name or a group's title, an app's name, a chat's
 * title — because a search that found rows by a field the reader cannot see
 * would return results they cannot explain.
 *
 * It composes with the filter rather than replacing it: the strip says which
 * kinds, this says which of them, and an empty query is every row.
 */
function inboxMatches(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query);
}

/**
 * The conversation list's loading state, at the ROW's own geometry.
 *
 * It was a spinner beside the words "Loading conversations…" — a fixed mark
 * that says "busy, somewhere" over an empty pane. These say where the
 * conversations are going and roughly how many, so the arriving rows land on
 * their own outlines instead of replacing a centred line of grey text.
 *
 * The wrapper IS `.messages-conversation-row`, not an imitation of it: that
 * class owns the 66px minimum height, the padding, the gap and the inset
 * separator, all in app.css. Borrowing it means the placeholder cannot
 * drift from the row the first time any of those move — and the separator
 * between placeholders is drawn for free, which is most of what makes a list
 * read as a list.
 *
 * Six, because the pane is taller than that on every phone and a list that
 * stops halfway reads as a short list rather than a loading one.
 */
function ConversationRowSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:inbox.loading')}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="messages-conversation-row">
          {/* The `lg` square UserAvatar's 44px box. */}
          <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            {/* The name line, with the timestamp's short bar pushed right —
                the real row's trailing <time>. */}
            <div className="flex items-center gap-2">
              <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
              <Skeleton shape="muted" className="ms-auto w-8" />
            </div>
            {/* The preview line under it. */}
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-3/5' : 'w-2/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

function ConversationList({ drawer = false, litId = null }: {
  /** The phone's drawer holds the screen (./phone-drawer.tsx): the list stays drawn beside a conversation. */
  drawer?: boolean;
  /** The conversation peeking beside the list, lit as the one you were in. */
  litId?: number | null;
} = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  // The search: REMEMBERED PER DEVICE SINCE #5459, AND STILL NOT IN THE STORE. A daily
  // voter narrows the list to the changes waiting on them, leaves to vote,
  // and comes back: the query now survives that, kept in localStorage
  // (`usernode:messages-query`, ./inbox.ts) the way the folded sections are,
  // so the visit starts narrowed the way the last one ended. It is kept out
  // of the store because nothing else reads what was typed here — and the
  // field itself is where the reason rows are missing shows, so a restored
  // query never hides rows with nothing on screen saying why. The value is
  // read after mount, so the first render and the prerendered shell both
  // show an empty field and hydration matches. (The filter the old comment
  // was written for IS in the store, because the thread pane and the
  // deep-link router both read it.)
  const [query, setQuery] = useState('');
  // Restore the last search one commit after mount. An unusable or absent
  // saved value leaves the field empty, and storage that throws (private
  // mode, blocked) is the same as never having typed.
  useEffect(() => {
    try {
      const saved = savedInboxQuery(localStorage.getItem('usernode:messages-query'));
      if (saved) setQuery(saved);
    } catch { /* storage unavailable */ }
  }, []);
  // Save the search on each keystroke, before the field updates. A write
  // that throws is skipped and the list still narrows exactly as it did
  // before the remembering; clearing the field removes the key, so the next
  // visit starts empty; a search past the cap is not kept at all, rather
  // than stored cut.
  const changeQuery = useCallback((value: string) => {
    try {
      if (value && value.length <= INBOX_QUERY_MAX) localStorage.setItem('usernode:messages-query', value);
      else localStorage.removeItem('usernode:messages-query');
    } catch { /* storage unavailable */ }
    setQuery(value);
  }, []);
  // The list filters on the DEFERRED query: the field takes the keystroke at
  // once, and the rows follow in a render React can interrupt with the next
  // one, so typing a word into a long inbox does not wait on it per letter.
  const deferredQuery = useDeferredValue(query);
  // The viewer's changes in flight (#2770) — see AgentSessionRow. AFTER
  // MOUNT ONLY: app.js can have filled the Improve store before this island
  // hydrates, and rows the prerendered document did not have are a hydration
  // mismatch on every route. The first client render therefore matches the
  // prerender, and the rows arrive one commit later.
  const improve = useStoreState(improveStore) as {
    sessions?: SessionRowView[];
    otherSessions?: SessionRowView[];
  };
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // A change started from an agent session (#2779) is that conversation's:
  // its row below says where it stands, so it is not listed twice.
  // Memoised on the store's own arrays: inboxSessionView builds a new row
  // object, and a new object per render is a memo()'d row drawn again.
  const sessions = useMemo<SessionRowView[]>(() => (mounted
    ? [...(improve.sessions || []), ...(improve.otherSessions || [])]
      .filter((row) => !row.agentSessionId)
      .map(inboxSessionView)
    : []), [mounted, improve.sessions, improve.otherSessions]);
  // Agent sessions (#2779), from their own store and, like the sessions
  // above, only after mount. Listed whatever the flag says: turning it off
  // never hides a conversation that already exists. The list alone: a reply
  // streaming into the open conversation does not redraw the inbox.
  const mayorSessions = useAgentSessions();
  useEffect(() => { void loadAgentSessions(); }, []);
  const mayors = useMemo<MayorSession[]>(() => (mounted ? mayorSessions : []), [mounted, mayorSessions]);
  // #4729: the mark menu's agent rows left for this list, and with them the
  // only route to an archived agent chat closed — an archived session was in
  // no list at all. "Show archived" at the foot of the Agents list opens the
  // group of them, read from the same route the open list reads with
  // ?status=archived and re-read on each open, so a session archived or
  // unarchived meanwhile is current. After mount (like the rows above) and
  // only for somebody who has had an agent session, so a newcomer's list
  // carries no quiet tail that would always be empty; a query hides it,
  // because search covers the open chats only.
  const agentChatsShown = useAgentChatsShown();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<MayorSession[] | null>(null);
  const [archivedError, setArchivedError] = useState('');
  const readArchived = useCallback(() => {
    setArchivedError('');
    listArchivedSessions()
      .then((sessions) => setArchived(sessions))
      .catch((err) => setArchivedError(
        err instanceof Error && err.message ? err.message : translate('agent:session.error.listFailed'),
      ));
  }, []);
  useEffect(() => {
    if (archivedOpen) readArchived();
  }, [archivedOpen, readArchived]);
  // The side pane open BESIDE an agent session's chat (#2779 follow-up), a
  // spec or a preview, takes this column's width while it is open: at 1280
  // the thread pane alone is too narrow for two readable columns. Closing it
  // brings the list back. False until mounted, like everything above
  // (../agent-session/spec-layout).
  const specBeside = useSidePaneBeside('messages');
  // Built once per change to what it is built from, not once per keystroke
  // in the search box or per publish of a store this list does not draw.
  const inbox = useMemo(() => buildInbox({
    conversations: snap.conversations,
    sessions,
    mayors,
  }), [snap.conversations, sessions, mayors]);
  const byMayor = useMemo(() => new Map(mayors.map((item) => [String(item.id), item])), [mayors]);
  const byConversation = useMemo(() => new Map(snap.conversations.map((item) => [String(item.id), item])), [snap.conversations]);
  const bySession = useMemo(() => new Map(sessions.map((item) => [item.key, item])), [sessions]);

  const q = deferredQuery.trim().toLowerCase();
  const matches = (entry: { kind: string; key: string }) => {
    if (!q) return true;
    if (entry.kind === 'person') {
      const c = byConversation.get(entry.key.slice('person:'.length));
      if (!c) return false;
      const peer = directPerson(c) || conversationPeer(c);
      return inboxMatches(c.title, q)
        || inboxMatches(peer?.username, q)
        || inboxMatches(peer?.displayName, q);
    }
    if (entry.kind === 'session') {
      const c = bySession.get(entry.key.slice('session:'.length));
      return !!c && (inboxMatches(c.title, q) || inboxMatches(c.appName, q));
    }
    if (entry.kind === 'mayor') {
      const m = byMayor.get(entry.key.slice('mayor:'.length));
      return !!m && (inboxMatches(m.title, q) || inboxMatches(m.focusApp?.name, q)
        || inboxMatches(m.activeChange?.title, q));
    }
    return false;
  };
  const searching = !!q;
  const found = inbox.filter(matches);
  // The row that is open, so a section showing its newest few keeps it.
  const open = snap.route.agent;
  const isOpen = (entry: { kind: string; key: string }) => {
    if (entry.kind === 'person') return snap.route.conversationId === Number(entry.key.slice('person:'.length));
    if (entry.kind === 'session') {
      const session = bySession.get(entry.key.slice('session:'.length));
      return !!session && open?.kind === 'session' && open.id === session.id;
    }
    if (entry.kind === 'mayor') return open?.kind === 'agent' && String(open.id) === entry.key.slice('mayor:'.length);
    return false;
  };
  const openKey = found.find(isOpen)?.key || null;
  // v3 (18 Oct 2026): what the desktop's sidebar nests under Messages
  // (./rail-inbox.ts), from the whole inbox, whatever the search box holds.
  const railOpenKey = inbox.find(isOpen)?.key || null;
  useEffect(() => {
    // #5693: an agent chat is seated only while it asks for you.
    const rows = railConversations(railCandidates(inbox, asksForYou))
      .map(railRow)
      .filter((row): row is RailConversation => !!row);
    publishRailInbox({ rows, openKey: railOpenKey, page: !(snap.route.conversationId || snap.route.appSlug || snap.route.agent) });
  });
  // An agent row that asks for you is never behind "Show N more": a change
  // waiting on you ("Needs you") or an agent at work.
  // (./inbox.ts asksForYou, shared with the sidebar's seats, #5693).
  const asksForYou = (entry: { kind: string; key: string }) => agentAsksForYou(entry, bySession, byMayor);

  // 16 Oct 2026: what the Homeroom bot's row says. What waits on you and
  // what it is doing, in the words of its chat's own activity bar
  // (./bot-strip.tsx summaryParts: "1 needs you · 2 in progress"), read
  // from the same store once this list is up; its last message until then.
  // #5392: the row stays current, the same live reads the DM's strip runs
  // (./bot-work.tsx): again whenever the list opens and the bot's work
  // moves (its news lands, the work-changed event), and every POLL_MS while
  // it has work in hand and the page is in view.
  const botWork = useBotWork();
  const botConversation = snap.conversations.find((item) => item.homeroomBot && item.kind !== 'channel') || null;
  useEffect(() => {
    if (mounted && botConversation) loadBotWork();
  }, [mounted, botConversation?.id, botConversation?.lastActivityAt]);
  useEffect(() => {
    if (!botConversation) return undefined;
    const changed = () => loadBotWork();
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, [botConversation]);
  useEffect(() => {
    if (!botConversation || !botWork.work?.now.length || document.visibilityState === 'hidden') return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') loadBotWork();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [botConversation, botWork.work?.now.length]);
  const botLine = useMemo(() => {
    if (!botWork.work) return null;
    const parts = summaryParts(stripGroups(botWork.work));
    return parts.length ? parts.slice(0, 2).map((part) => part.text).join(' · ') : null;
  }, [botWork.work]);

  // What each section's heading says: agents at work, and the messages from
  // people you have not read. A zero says nothing. Unread is new to read,
  // grey like every unread count since #18 (19 Oct 2026 polish board); the
  // accent is for what waits on you.
  const working = mayors.filter((item) => item.busy).length
    + sessions.filter((item) => item.busy).length;
  const unreadFromPeople = snap.conversations
    .filter((item) => !item.homeroomBot && item.kind !== 'channel')
    .reduce((sum, item) => sum + Math.max(0, Number(item.unreadCount) || 0), 0);
  const asides: Record<InboxSection, { text: string | null; ask: boolean }> = {
    agents: { text: working ? t('messages:inbox.section.working', { count: working }) : null, ask: false },
    people: { text: unreadFromPeople ? t('messages:inbox.section.unread', { count: unreadFromPeople }) : null, ask: false },
  };
  // Agents shows its week until "N older chats" (./inbox.ts
  // shownInSection). Not remembered: the next visit starts on the week.
  const [agentsExpanded, setAgentsExpanded] = useState(false);

  // #4729: the archived agent chats fold behind a link at the Agents
  // section's foot, in the "N older chats" shape. Opening it re-reads the
  // archived list each time, so a session archived or unarchived since the
  // last look shows where it now belongs; a query hides the toggle, because
  // search covers the open chats only.
  const showArchivedToggle = mounted && !!agentChatsShown && !snap.folded.includes('agents') && !searching;
  const archivedToggle = showArchivedToggle ? (
    <button
      key="show-archived"
      type="button"
      id="messages-show-archived"
      className="messages-inbox-older"
      aria-expanded={archivedOpen}
      onClick={() => setArchivedOpen(!archivedOpen)}
    >
      {archivedOpen ? t('messages:inbox.archived.hide') : t('messages:inbox.archived.show')}
    </button>
  ) : null;

  return (
    <section className={`messages-list-pane ${specBeside ? 'hidden' : drawer ? 'flex' : snap.route.conversationId || snap.route.appSlug || snap.route.agent ? 'hidden md:flex' : 'flex'}`} aria-label={t('messages:inbox.listName')}>
      {/* THE SCREEN NAMES ITSELF ONCE (#2718 review). An <h2> reading
          "Messages" sat here, under a bar already reading Messages — two
          titles, one word, an inch apart. The bar is the title now, which is
          what it is for on every other screen in the shell.

          A SEARCH TAKES ITS PLACE, because a list that can run to hundreds of
          rows and holds three kinds of thing needs a way to name one. The
          "+" that starts something is beside it, since the filter strip it
          ended went (16 Oct 2026): the sections' headings say which is
          which. */}
      <div className="messages-toolbar">
        <div className="messages-search">
          <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
          <input
            id="messages-search"
            type="search"
            className="messages-search-input"
            placeholder={t('messages:inbox.searchPlaceholder')}
            aria-label={t('messages:inbox.searchLabel')}
            value={query}
            onChange={(e) => changeQuery(e.currentTarget.value)}
          />
        </div>
        <NewMessageButton />
      </div>
      {!snap.online ? <div className="messages-network-banner">{t('messages:inbox.offline')}</div> : null}
      {/* #1953: a click on the list's own blank space — below the last row,
          not on a row or a button — closes the open conversation, as it
          would in a desktop mail client. Only the list itself counts
          (`target === currentTarget`), so no row, empty state or retry
          button is affected. On a phone the list is hidden while a thread is
          open, so this is a two-pane (md+) gesture. */}
      <div
        className="messages-list-scroll platform-safe-scroll"
        data-page-bounce=""
        onClick={(e) => {
          if (e.target === e.currentTarget && snap.route.conversationId) openConversation(null);
        }}
      >
        {snap.loadingList && !snap.listLoaded ? <ConversationRowSkeleton /> : null}
        {snap.error ? <div className="messages-state messages-state-error"><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>{t('core:common.tryAgain')}</button></div> : null}
        {/* Nothing in the list: what the list draws, not what was read.
            #general is always read (every account is in it) and is drawn on
            Homeroom's hub, never here (./inbox.ts), so a new account's
            Messages was a search box over nothing (sign-up test, 19 Oct
            2026). */}
        {!snap.loadingList && !snap.error && snap.listLoaded && !inbox.length
          ? <div className="messages-empty"><h3>{t('messages:inbox.empty.title')}</h3><p>{t('messages:inbox.empty.body')}</p><button type="button" onClick={() => openDialog('messagesCreate')}>{t('messages:inbox.empty.action')}</button></div>
          : null}
        {/* A QUERY THAT MATCHED NOTHING is not an empty inbox, and must not
            borrow the empty inbox's offer to start a conversation: the rows
            are there, this one word is what hid them. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && inbox.length && !found.length
          ? <div id="messages-search-empty" className="messages-state"><p>{t('messages:inbox.searchEmpty', { query: deferredQuery.trim() })}</p></div>
          : null}
        {/* TWO SECTIONS, EACH HEADED (16 Oct 2026): Agents, the Homeroom
            bot's chat first, then People (./inbox.ts). Each section's rows
            sit in a card under its heading, the grouped list's label-over-
            card shape; on a desktop the column draws them as the Communities
            column draws its places (app.css). Agents folds from its heading,
            which keeps its count folded, and keeps the bot's row; a search
            opens it. Agents shows at most five from its week, and the rest
            behind "N older chats": a quiet link in the titles' column,
            not a chevron, so it never reads as a third heading. Pressed, it
            stays where it is and the older chats open below it. */}
        {INBOX_SECTIONS.map((section) => {
          const entries = found.filter((entry) => entry.section === section);
          const folded = !searching && FOLDABLE.includes(section) && snap.folded.includes(section);
          const { shown, older, olderShown } = shownInSection(section, entries, {
            expanded: agentsExpanded, searching, folded, openKey, keep: asksForYou,
          });
          // The archived chats are reached past the open ones: under all of
          // them, once "N older chats" has shown the rest below it.
          const archive = section === 'agents' && showArchivedToggle && (!older || agentsExpanded);
          if (!entries.length && !archive) return null;
          const more = older > 0 ? (
            <button
              key="agents-older"
              type="button"
              className="messages-inbox-older"
              data-inbox-more="agents"
              aria-expanded={agentsExpanded}
              onClick={() => setAgentsExpanded(!agentsExpanded)}
            >
              {agentsExpanded ? t('messages:inbox.older.hide') : t('messages:inbox.older.show', { count: older })}
            </button>
          ) : null;
          return (
            <Fragment key={section}>
              <SectionHead section={section} folded={folded} aside={asides[section].text} ask={asides[section].ask} />
              {shown.length || more || archive ? (
                <div className="messages-section-card" data-inbox-card={section}>
                  {shown.map(inboxRow)}
                  {more}
                  {olderShown.map(inboxRow)}
                  {archive ? archivedToggle : null}
                </div>
              ) : null}
              {archive && archivedOpen ? (
                <>
                  <h3 className="messages-section-head" data-inbox-section="archived">{t('messages:inbox.archived.heading')}</h3>
                  {archivedError ? (
                    <div className="messages-state messages-state-error">
                      <p>{archivedError}</p>
                      <button type="button" onClick={readArchived}>{t('core:common.tryAgain')}</button>
                    </div>
                  ) : !archived ? (
                    <div className="messages-state"><span className="messages-spinner" aria-hidden="true" /></div>
                  ) : !archived.length ? (
                    <div className="messages-state"><p>{t('messages:inbox.archived.empty')}</p></div>
                  ) : (
                    <div className="messages-section-card" data-inbox-card="archived">
                      {archived.map((session) => (
                        <MayorSessionRow
                          key={session.id}
                          session={session}
                          active={open?.kind === 'agent' && open.id === session.id}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </section>
  );

  /** A row of the sidebar's nested conversations: the list row's address, name, count and face, small. */
  function railRow(entry: { kind: string; key: string; section: InboxSection }): RailConversation | null {
    const base = { key: entry.key, section: entry.section, unread: 0 };
    if (entry.kind === 'person') {
      const conversation = byConversation.get(entry.key.slice('person:'.length));
      if (!conversation) return null;
      const peer = directPerson(conversation);
      const viewerId = Number(window.App?.user?.id);
      const face = conversation.kind === 'group' && conversation.membershipStatus !== 'invited'
        ? conversation.members.find((member) => member.status === 'member' && Number(member.id) !== viewerId) || null
        : null;
      return {
        ...base,
        href: `#messages/${conversation.id}`,
        name: conversation.kind === 'direct' && peer ? senderName(peer, { bare: true }) : conversation.title,
        unread: Math.max(0, Number(conversation.unreadCount) || 0),
        lead: face
          ? <UserAvatar user={face} size="sm" shape="square" />
          : <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={peer?.username || conversation.title} size="sm" shape="square" />,
        reselect: () => selectConversation(conversation.id),
      };
    }
    if (entry.kind === 'session') {
      const session = bySession.get(entry.key.slice('session:'.length));
      return session
        ? { ...base, href: session.href, name: session.title || session.appName || '', lead: <ChangeTile session={session} /> }
        : null;
    }
    const agentTile = (
      <span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">
        <SparklesIcon className="w-5 h-5" />
      </span>
    );
    if (entry.kind === 'mayor') {
      const session = byMayor.get(entry.key.slice('mayor:'.length));
      if (!session) return null;
      const thread: MessagesAgentThread = { kind: 'agent', id: session.id };
      return {
        ...base,
        href: agentThreadAddress(thread),
        name: session.title || t('messages:agent.row.newSession'),
        lead: agentTile,
        reselect: () => openAgentThread(thread),
      };
    }
    return null;
  }

  function inboxRow(entry: { kind: string; key: string }) {
    if (entry.kind === 'person') {
      const conversation = byConversation.get(entry.key.slice('person:'.length));
      return conversation
        ? (
          <ConversationRow
            key={entry.key}
            conversation={conversation}
            active={snap.route.conversationId === conversation.id || (!!litId && litId === conversation.id)}
            preview={conversation.homeroomBot ? botLine : null}
          />
        )
        : null;
    }
    if (entry.kind === 'session') {
      const session = bySession.get(entry.key.slice('session:'.length));
      return session
        ? <AgentSessionRow key={entry.key} session={session} active={open?.kind === 'session' && open.id === session.id} />
        : null;
    }
    if (entry.kind === 'mayor') {
      const session = byMayor.get(entry.key.slice('mayor:'.length));
      return session
        ? <MayorSessionRow key={entry.key} session={session} active={open?.kind === 'agent' && open.id === session.id} />
        : null;
    }
    return null;
  }
}

function InvitationBanner() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!active || active.membershipStatus !== 'invited') return null;
  const conversationId = active.id;
  const requesterUser = active.requester;
  async function answer(action: 'accept' | 'decline') {
    setBusy(true); setError('');
    try { await respond(action); }
    catch (err) { setError(err instanceof Error ? err.message : t('messages:invitation.error.respond')); }
    finally { setBusy(false); }
  }
  async function declineAndBlock() {
    const requesterId = requesterUser?.id;
    if (!requesterId) return;
    setBusy(true); setError('');
    try {
      // Blocking is also the server-side decline for every still-pending
      // direct/group invitation from this requester. Purge this invitation
      // locally as soon as that consent decision commits.
      await api.setBlock(requesterId, true);
      await finishDirectBlock(conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('messages:invitation.error.declineBlock'));
    } finally { setBusy(false); }
  }
  return (
    <div className="messages-invitation">
      <div className="min-w-0 flex-1"><strong>{active.kind === 'direct' ? t('messages:invitation.messageRequest') : t('messages:invitation.groupInvitation')}</strong>{active.kind === 'group' ? <p className="messages-invitation-group">{t('messages:invitation.groupSummary', { title: active.title, count: active.memberCount || 0 })}</p> : null}{active.inviteNote ? (<><p>{requesterUser?.unnamed ? t('messages:invitation.addedYouWithNoteUnknown', { note: active.inviteNote }) : requesterUser?.username ? t('messages:invitation.addedYouWithNote', { username: requesterUser.username, note: active.inviteNote }) : t('messages:invitation.addedYouWithNoteSomeone', { note: active.inviteNote })}</p><p>{t('messages:invitation.historyNotice')}</p></>) : (<p>{requesterUser?.unnamed ? t('messages:invitation.invitedByUnknown') : requesterUser?.username ? t('messages:invitation.invitedBy', { username: requesterUser.username }) : t('messages:invitation.invitedBySomeone')}</p>)}{error ? <span role="alert">{error}</span> : null}</div>
      <div className="messages-invite-actions">
        <button type="button" disabled={busy} onClick={() => void answer('decline')} className="messages-invite-decline">{t('messages:invitation.decline')}</button>
        {requesterUser?.id ? <button type="button" disabled={busy} onClick={() => void declineAndBlock()} className="messages-invite-block">{requesterUser.unnamed ? t('messages:invitation.declineAndBlockUnknown') : t('messages:invitation.declineAndBlock', { username: requesterUser.username })}</button> : null}
        <button type="button" disabled={busy} onClick={() => void answer('accept')} className="messages-invite-accept">{t('messages:invitation.accept')}</button>
      </div>
    </div>
  );
}

/**
 * #2387: FULL WIDTH. On a desktop the list and the open discussion sit side
 * by side; this folds the list away so the discussion (and a thread beside
 * it) has the whole width, and brings it back. Only the list: the platform's
 * own sidebar is navigation and stays. It is remembered on this device.
 *
 * ONE CONTROL, ONE PLACE, EVERY PANE. It sits at the right of the header,
 * just before ⋯ where a pane has one — where a video player or a document
 * editor puts its full-screen control — on a conversation, #general, an
 * app's channel, an agent chat and both kinds of session alike. The agent
 * panels are drawn by their own features, so they take it as `headerAction`
 * rather than importing this store.
 *
 * The glyph is the verb a press performs: arrows out while the list is
 * shown, arrows in once it is hidden. A phone shows one pane at a time
 * already, so there it is not drawn (app.css).
 *
 * It only widens the pane. (`data-bot-work-keep` is kept from when the
 * bot's activity panel stayed open through it, #3770.)
 */
function FullWidthToggle() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  // A Mayor session's side pane (its spec or a preview) open beside its chat
  // has already moved the list aside (ConversationList), so here the control
  // would do nothing. It is not drawn, as app.css does for an open reply
  // thread below 1600px.
  const specBeside = useSidePaneBeside('messages');
  const collapsed = snap.listCollapsed;
  if (specBeside) return null;
  // A channel is always full width (see the layout's note), so a toggle for
  // a list it never shows would do nothing.
  if (snap.route.appSlug || (snap.active?.kind === 'channel' && snap.active.id === snap.route.conversationId)) return null;
  const label = collapsed ? t('messages:header.showList') : t('messages:header.fullWidth');
  return (
    <button
      type="button"
      className="messages-thread-action messages-list-toggle"
      aria-pressed={collapsed}
      aria-label={label}
      title={label}
      data-bot-work-keep=""
      onClick={() => setListCollapsed(!collapsed)}
    >
      {collapsed ? <ArrowsPointingInIcon aria-hidden="true" /> : <ArrowsPointingOutIcon aria-hidden="true" />}
    </button>
  );
}

/**
 * The sheet's title row: who this conversation is with, and its actions as
 * floating discs. No back control of its own — on a phone the platform
 * header's back arrow already points at the list (see syncChrome in
 * ./store.ts), and a second one here was the same affordance twice.
 * #general is the exception: a channel goes back up to its hub, not to this
 * list, and like the hub's own pages it says so in the page (#3407).
 */
/**
 * What a conversation is called and who it is with, as the sheet's title row
 * (ThreadHeader) says them, for the phone's header to say instead
 * (./phone-drawer.tsx), where the sheet leaves its own name out. The same
 * words, built the same way; tests/nav-drawer.test.js holds the two to each
 * other. Read in the language on show by whoever renders it.
 */
export function threadWords(active: ConversationDetail): { title: string; sub: string } {
  const channel = active.kind === 'channel';
  const invited = active.membershipStatus === 'invited';
  // #3692: the Homeroom bot's DM says what the bot is doing where a DM says
  // "Direct message", and its Activity disc, before the full-width toggle,
  // opens the activity panel (./bot-work.tsx), working or not. #3770: the
  // disc, not the name block, which nobody read as a control.
  const botDm = active.kind === 'direct' && !!active.homeroomBot && active.membershipStatus === 'member';
  // QA 2026-09-24 Q33a: an unanswered request names its requester.
  const person = directPerson(active);
  // QA 2026-09-24 Q14: "1 member", not "1 members". An invitee is not shown
  // the roster until they accept, so the count the server gives them is 0 —
  // they read the invitation's state instead of "0 members".
  const said = channel
    ? translate('messages:header.subtitle.channel', { count: active.memberCount })
    : invited
      ? translate('messages:header.subtitle.invited')
      : active.kind === 'group'
        ? (active.myRole === 'owner'
          ? translate('messages:header.subtitle.groupOwner', { count: active.memberCount })
          : translate('messages:header.subtitle.group', { count: active.memberCount }))
        : active.awaitingAcceptance ? translate('messages:header.subtitle.requestPending') : translate('messages:header.subtitle.direct');
  // N14 (19 Oct polish board): the people asked who have not joined yet are
  // said beside the members, since a group's name can already list them.
  const asked = active.kind === 'group' && !invited ? active.members.filter((m) => m.status === 'invited').length : 0;
  const subtitle = asked ? dotText([said, translate('messages:header.subtitle.invitedCount', { count: asked })]) : said;
  return {
    title: active.kind === 'direct' && person ? senderName(person, { bare: true }) : channel ? `#${active.channelKey || active.title}` : active.title,
    sub: botDm ? translate('messages:header.subtitle.homeroomBot') : subtitle,
  };
}

/**
 * What an open agent session is called and what it is, for the phone's
 * header to say (./phone-drawer.tsx; Evan, 18 Oct 2026), in the words its own
 * pane uses: its title and kind line, as its bar names it in the pane
 * (agent-session/index.tsx SessionBar, whose copy app.css leaves out on the
 * drawer). Read in the language on show by whoever renders it.
 */
export function agentThreadWords(agent: MessagesAgentThread, seen: { title: string; app: string }): { title: string; sub: string } {
  return {
    title: seen.title || translate('agent:session.bar.newSession'),
    sub: seen.app ? translate('agent:session.bar.kindStartedFrom', { app: seen.app }) : translate('agent:session.bar.kind'),
  };
}

/** `agentThreadWords` for the open agent session, from the store its pane draws from; null for anything else. */
function useAgentThreadWords(agent: MessagesAgentThread | null): { title: string; sub: string } | null {
  // Subscribed, so the words re-read in the language on show.
  useMessages('messages');
  useMessages('agent');
  const sessionId = agent?.kind === 'agent' ? agent.id : null;
  const mine = (current: { id: number | null }) => sessionId != null && (sessionId === 'new' ? current.id === null : current.id === sessionId);
  const sessionTitle = useAgentSessionSelector((current) => (mine(current) ? current.session?.title || '' : ''));
  const sessionApp = useAgentSessionSelector((current) => (mine(current) ? (current.session || current.draft)?.focusApp?.name || '' : ''));
  if (!agent || agent.kind === 'session') return null;
  return agentThreadWords(agent, { title: sessionTitle, app: sessionApp });
}

function ThreadHeader() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const { on: inDrawer } = useStoreState(messagesDrawerStore);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // QA 2026-09-24 Q18: the ⋯ menu is a real menu now. It closes on a press
  // outside it and on Escape (it used to stay open until its own button was
  // pressed again), takes focus to its first row when it opens, moves
  // between rows on the arrow keys, and hands focus back to the ⋯ on
  // Escape. Hooks before the early return below, so their order is stable.
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // #3407: #general's hub is the platform project's, whose slug may land
  // after this header first draws (channel-hub.ts), so it is subscribed to;
  // the disc's label and its press come from that one value.
  const hubBack = generalHubBack(usePlatformSlug(active?.kind === 'channel'));
  const closeMenu = () => setMenu(false);
  useDismiss(menu, [menuWrapRef], closeMenu);
  const menuKeys = useMenuKeyboard(menu, menuRef, menuBtnRef, closeMenu);
  // Another conversation is another header: a menu left open does not follow.
  useEffect(() => { setMenu(false); }, [active?.id]);
  const peer = active ? conversationPeer(active) : null;
  if (!active) return null;
  async function blockPeer() {
    if (!peer) return;
    // The menu goes first and focus returns to the ⋯, so the confirm below
    // hands focus back there whichever way it is answered.
    menuBtnRef.current?.focus({ preventScroll: true });
    setMenu(false);
    // QA 2026-09-24 Q15: the app's own confirm (lib/confirm.ts), not the
    // browser's, which some webview hosts suppress.
    const ok = await confirmAction({
      title: peer.unnamed ? (peer.id ? t('messages:header.block.titleUnknownHandle') : t('messages:header.block.titleUnknown')) : t('messages:header.block.title', { name: senderName(peer, { bare: active.kind === 'direct' }) }),
      message: t('messages:header.block.message'),
      confirmLabel: t('messages:header.block.confirm'),
      danger: true,
    });
    if (!ok) return;
    const conversationId = active?.id;
    if (!conversationId) return;
    setBusy(true);
    try { await setUserBlocked(peer.id, true); }
    catch (err) { window.PlatformUI?.toast?.(err instanceof Error ? err.message : t('messages:header.block.failed')); }
    finally { setBusy(false); setMenu(false); }
  }
  // QA 2026-09-24 Q14: rename, for whoever the server lets rename — the
  // group's owner (`canManage`, the same gate PATCH /api/conversations/:id
  // applies). The kit's own one-field dialog, pre-filled with the name.
  async function renameGroup() {
    setMenu(false);
    const current = active?.title || '';
    // PlatformUI.prompt (public/js/platform-ui.js) is the kit alert's inset
    // text field, resolving the string or null on Cancel.
    const ui = window.PlatformUI as undefined | {
      prompt?: (opts: { title: string; value?: string; placeholder?: string; confirmLabel?: string; maxLength?: number }) => Promise<string | null>;
      toast?: (message: string) => void;
    };
    if (!ui?.prompt) return;
    const next = await ui.prompt({ title: t('messages:header.rename.title'), value: current, placeholder: t('messages:header.rename.placeholder'), confirmLabel: t('core:common.save'), maxLength: 80 });
    if (next == null) return;
    try { await renameConversation(next); }
    catch (err) { ui.toast?.(err instanceof Error ? err.message : t('messages:header.rename.failed')); }
  }
  const channel = active.kind === 'channel';
  const invited = active.membershipStatus === 'invited';
  // #3692: the Homeroom bot's DM says what the bot is doing where a DM says
  // "Direct message", and its Activity disc, before the full-width toggle,
  // opens the activity panel (./bot-work.tsx), working or not. #3770: the
  // disc, not the name block, which nobody read as a control.
  const botDm = active.kind === 'direct' && !!active.homeroomBot && active.membershipStatus === 'member';
  // Polish N15: the Homeroom bot is the platform, not a person, so its ⋯
  // offers no "Block Homeroom bot" or "Report user". What there is to say
  // about a bot goes to Homeroom as feedback, which its menu offers instead.
  const withBot = active.kind === 'direct' && !!active.homeroomBot;
  // QA 2026-09-24 Q33a: an unanswered request names its requester.
  const person = directPerson(active);
  // QA 2026-09-24 Q14: "1 member", not "1 members". An invitee is not shown
  // the roster until they accept, so the count the server gives them is 0 —
  // they read the invitation's state instead of "0 members".
  // (threadWords above says the same to the phone's header.)
  const said = channel
    ? t('messages:header.subtitle.channel', { count: active.memberCount })
    : invited
      ? t('messages:header.subtitle.invited')
      : active.kind === 'group'
        ? (active.myRole === 'owner'
          ? t('messages:header.subtitle.groupOwner', { count: active.memberCount })
          : t('messages:header.subtitle.group', { count: active.memberCount }))
        : active.awaitingAcceptance ? t('messages:header.subtitle.requestPending') : t('messages:header.subtitle.direct');
  // N14: the people asked who have not joined yet, as threadWords says them.
  const asked = active.kind === 'group' && !invited ? active.members.filter((m) => m.status === 'invited').length : 0;
  const subtitle = asked ? dotText([said, t('messages:header.subtitle.invitedCount', { count: asked })]) : said;
  // N14: a group leads with a member's face, as its row in the list does,
  // not the initials of its name ("E+" for "Evan + Lukas").
  const viewerId = Number(window.App?.user?.id);
  const face = active.kind === 'group' && !invited
    ? active.members.find((member) => member.status === 'member' && Number(member.id) !== viewerId) || null
    : null;
  return (
    <header className="messages-thread-header">
      {channel ? <PageBackButton label={hubBack.label} onBack={hubBack.onBack} data-channel-back="" /> : null}
      {/* THE PHONE'S DRAWER NAMES THE CONVERSATION IN THE HEADER (Evan's
          design, ./phone-drawer.tsx): its name over who it is with, so the
          page leaves its own name out and keeps only its discs. */}
      {inDrawer ? null : channel
        ? <span className="messages-inbox-tile messages-channel-tile messages-thread-channel-tile" aria-hidden="true">#</span>
        : face ? <UserAvatar user={face} shape="square" />
          : <UserAvatar user={active.kind === 'direct' ? person : null} title={person?.username || active.title} shape="square" />}
      {inDrawer ? <span className="flex-1" aria-hidden="true" /> : (
      <button
        type="button"
        className="min-w-0 text-start flex-1"
        onClick={() => { if (active.kind === 'group') openDialog('messagesMembers'); }}
      >
        <div className="messages-thread-name">{active.kind === 'direct' && person ? senderName(person, { bare: true }) : channel ? `#${active.channelKey || active.title}` : active.title}{active.kind === 'direct' && person?.bot ? <span className="messages-bot-badge">{t('messages:header.aiBadge')}</span> : null}</div>
        {/* One request, one story: what the bot is doing is the strip under
            this header (./bot-strip.tsx); the line under its name says what
            it is for. */}
        <div className="messages-thread-sub">{botDm ? t('messages:header.subtitle.homeroomBot') : subtitle}</div>
      </button>
      )}
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label={t('messages:header.groupMembers')} title={t('messages:header.groupMembers')}><UserGroupIcon aria-hidden="true" /></button> : null}
      {/* #6071 follow-up: a new thread with Homeroom bot (./new-thread.tsx). */}
      {botDm ? <NewThreadButton conversationId={active.id} className="messages-thread-action" /> : null}
      <FullWidthToggle />
      <div className="relative" ref={menuWrapRef}>
        <button ref={menuBtnRef} type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label={t('messages:header.actions')} aria-haspopup="menu" aria-expanded={menu}><EllipsisHorizontalIcon aria-hidden="true" /></button>
        {menu ? (
          <div ref={menuRef} className="messages-thread-menu" role="menu" aria-label={t('messages:header.actions')} onKeyDown={menuKeys.onKeyDown}>
            {active.kind === 'group' && active.canManage
              ? <button type="button" role="menuitem" data-rename-group="" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); void renameGroup(); }}>{t('messages:header.menu.rename')}</button>
              : null}
            {active.kind === 'group'
              ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openDialog('messagesMembers'); }}>{t('messages:header.menu.members')}</button>
              : withBot
                ? <button type="button" role="menuitem" data-bot-feedback="" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); (window as unknown as { App?: { openFeedbackModal?: () => void } }).App?.openFeedbackModal?.(); }}>{t('messages:header.menu.botFeedback')}</button>
                : active.kind === 'direct'
                  ? <button type="button" role="menuitem" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">{!peer ? t('messages:header.menu.blockUnknown')
                    : peer.unnamed ? (peer.id ? t('messages:header.menu.blockUnnamedHandle') : t('messages:header.menu.blockUnnamed'))
                      : t('messages:header.menu.block', { name: senderName(peer, { bare: active.kind === 'direct' }) })}</button>
                  : null}
            {peer && !withBot ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openReport({ targetType: 'user', target: peer.username, label: senderName(peer, { bare: active.kind === 'direct' }), userId: peer.id }); }}>{t('messages:header.menu.report')}</button> : null}
            <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); void loadConversations(true); }}>{t('messages:header.menu.refresh')}</button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** The day a message was sent, in the viewer's zone, for the separators. */
/**
 * A message that is only a card (#2884): one or more shared items and nothing
 * a person wrote — no words, no file, no reply. A sending or unsent one is
 * never folded: it carries a status the sender is watching.
 */
function isCardMessage(message: ConversationMessage): boolean {
  return message.objects.length > 0 && !message.content && !message.attachments.length
    && !message.reply && !message.pending && !message.failed;
}

function dayKey(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? '' : date.toDateString();
}

/**
 * #4564: whether a ready card names its request — "Request #N: …", what
 * ./bot-ready.tsx `changeLine` leads with — so a later row of its change
 * block may drop the request card it would otherwise repeat.
 */
function readyNamesRequest(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  const n = Number(meta?.issueNumber);
  return isReadyMessage(message) && !!meta?.appSlug && Number.isInteger(n) && n > 0 && !meta?.firstVersion;
}

function dayLabel(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return translate('messages:thread.day.today');
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return translate('messages:thread.day.yesterday');
  return date.toLocaleDateString(undefined, date.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * An app's general discussion, as a thread of this inbox (#2718 review).
 *
 * ── Why it is mounted rather than rendered ────────────────────────────
 *
 * The transcript, its composer, the @mention and #ref autocompletes, the
 * spec side panel, the drafts and the attachment wiring are all
 * public/js/group-chat.js and features/group-chat/. That is one surface
 * with one owner, and re-implementing it here would be a second copy of a
 * thing that is loaded, merged and invalidated elsewhere — the same reason
 * the agent chats are read from their own store rather than copied into
 * this one. So this renders a HOST and asks the owner to fill it.
 *
 * ── The app travels with the mount ────────────────────────────────────
 *
 * `AppView.renderGroupChatTab` used to read the app out of AppView.appData,
 * which is the app view's state. This screen is not the app view and does
 * not open one, so it passes the app in instead — see that function's note
 * and GroupChat._app. Nothing here writes AppView's state.
 *
 * ── It waits for `readOnly` ───────────────────────────────────────────
 *
 * The row carries the app's name but not whether this viewer may write; the
 * store fetches that (`discussionContext`). Mounting before it lands would
 * draw a composer and then take it away, or the reverse — so the pane holds
 * on a skeleton until the answer is here.
 */
function AppDiscussionThread({ slug }: { slug: string }) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const host = useRef<HTMLDivElement | null>(null);
  const context = snap.discussionContext;
  const ready = !!context && context.slug === slug;
  const name = ready ? context.name : slug;
  const readOnly = ready ? context.readOnly : false;
  const archived = ready ? !!context.archived : false;
  // The channel's list row, when the viewer is a member: its `#handle`, and
  // the app's artwork for the header tile below.
  const row = snap.discussions.find((item) => item.slug === slug) || null;
  const handle = row?.channel || null;
  // THE HEADER DRAWS THE TILE THE ROW DRAWS. It was built from `{ name }`
  // alone, so `iconViewFor` could only ever fall through to the name's first
  // letter — a "W" over the Whiteboard channel whose row, one column to the
  // left, wears the palette emoji. The row's own two fields first, so the two
  // tiles cannot disagree; the app record the pane fetched (`context`) when
  // there is no row, as for a discussion opened from a link by a non-member.
  // Both arrive after the first paint, so the tile starts as the letter it
  // always was.
  const iconRecord = {
    name,
    icon_url: row ? row.iconUrl : (ready ? context.iconUrl : null),
    icon_emoji: row ? row.iconEmoji : (ready ? context.iconEmoji : null),
  };

  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    // OUT OF REACT'S COMMIT (#2783). renderGroupChatTab mounts the chat as a
    // portal and then, on its next line, looks up `#gc-input` to wire the
    // composer — send on Enter, drafts, the @ and # menus. The portal is
    // published inside flushSync, which cannot flush while React is still
    // committing this effect, so the input did not exist yet and the
    // composer of a channel opened here was never wired: nothing typed in it
    // sent. A macrotask later the commit is over and the portal lands at once.
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) view?.renderGroupChatTab?.({ host: el, slug, name, readOnly, archived });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      // BOTH PORTALS, and the transcript's first: it points INTO #gc-messages
      // inside the pane, and a portal left pointing at a detached node keeps
      // its subtree and its store subscription alive (rule 1 in
      // lib/legacy-portals.tsx, and the same order renderGroupChatTab
      // observes when it re-renders).
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
      // #2387: a "Mark unread" lasts while the channel is open, not after.
      (window as any).GroupChat?.releaseUnreadHold?.(slug);
    };
  }, [slug, ready, name, readOnly, archived]);

  if (snap.discussionError) {
    return (
      <section className="flex messages-thread-pane messages-no-selection" aria-label={name}>
        <h2>{t('messages:discussion.error.title')}</h2>
        <p>{t('messages:discussion.error.body')}</p>
      </section>
    );
  }
  return (
    <section
      className="flex messages-thread-pane messages-thread-discussion"
      aria-label={name}
      data-discussion-app={slug}
    >
      {/* THE PANE SAYS WHOSE DISCUSSION IT IS. On the app view this screen
          did not need one — the bar above it named the app — but here the
          bar says "Messages", and the group chat's own intro banner shows
          once per browser and then never again. The conversation pane beside
          it carries the same row (ThreadHeader). */}
      <header className="messages-thread-header">
        <PageBackButton label={name} onBack={() => openChannelHub(slug)} data-channel-back="" />
        <AppIconLink
          slug={slug}
          name={name}
          data-icon={appIconKind(iconRecord as never)}
          className="app-icon-tile messages-inbox-tile"
        >
          <AppIconContent app={iconRecord as never} />
        </AppIconLink>
        <span className="min-w-0 flex-1">
          <span className="messages-thread-name block">{name}</span>
          <span className="messages-thread-sub block">
            {archived
              ? t('messages:discussion.subtitle.archived')
              : handle ? t('messages:discussion.subtitle.channel', { channel: handle }) : t('messages:discussion.subtitle.everyone')}
          </span>
        </span>
        <FullWidthToggle />
      </header>
      {/* NO `dc-lift dc-lift-session` HERE, unlike the conversation pane
          beside it: features/group-chat/general-chat.tsx opens with exactly
          that pair, so the sheet is drawn once, inside. What this section
          contributes is the BOX — `.messages-thread-pane`'s margins put the
          sheet on the strip with the shoulder showing, the same geometry a
          conversation gets. `platform-kb-column` is inside too, on the chat
          pane, for the same reason.

          The host's class string is constant and its subtree is entirely
          group-chat's: the one-owner rule satisfied at this boundary rather
          than at a node within it. */}
      <div ref={host} className="messages-discussion-host flex-1 min-h-0" />
    </section>
  );
}

/**
 * An agent session (#2779), as a thread of this inbox (#2813).
 *
 * ── Rendered, not mounted ─────────────────────────────────────────────
 *
 * Unlike an app's discussion and a dev session, an agent session is React
 * already: features/agent-session is a store and a component tree, so the
 * pane draws the SAME panel its own screen draws, reading the same store,
 * told it is drawn here (`host: 'messages'`).
 *
 * Leaving the pane deactivates it exactly as leaving its screen does, but
 * only if the pane still owns it (following a `#agent/<id>` link from here
 * reopens the store for the screen before this unmounts, and that open is
 * not this pane's to undo), and only if it is still THIS conversation: an
 * unsent one (`new`) becomes its session on the first message, and the
 * thread for that address takes over a store that is already showing it.
 */
function MayorSessionThread({ id }: { id: number | 'new' }) {
  const t = useMessages('messages');
  useEffect(() => {
    void openAgentSession({ id, host: 'messages' });
    return () => {
      const current = getAgentSessionState();
      const same = id === 'new' ? current.id === null : current.id === id;
      if (current.open && current.host === 'messages' && same) deactivateAgentSession();
    };
  }, [id]);
  // A screen swap can close the conversation under this pane after the pane
  // took it (a desktop's transition out of #agent/<id> into Messages closes
  // the conversation's own screen last): the pane would draw a conversation
  // nobody holds open, which nothing updates. While Messages is on screen
  // and nothing holds it, the pane takes it back.
  const shown = useVisibility('messages-screen', false);
  const held = useAgentSessionSelector((s) => s.open);
  useEffect(() => {
    if (shown && !held) void openAgentSession({ id, host: 'messages' });
  }, [shown, held, id]);
  return (
    <section
      className="flex messages-thread-pane dc-lift dc-lift-session messages-thread-agent"
      aria-label={t('messages:agent.sessionName')}
      data-agent-session-thread={id}
    >
      <AgentSessionPanel embedded headerAction={<FullWidthToggle />} />
    </section>
  );
}

/**
 * One agent session's row (#2779): its title, the app it is about, and
 * where its active change stands. A link to the inbox's own address for it,
 * which a phone's router swaps for the conversation's screen.
 */
/** What a session is doing, as its row says it to a screen reader after the title. */
const ACTIVITY_SAID: Record<'working' | 'done', string> = {
  working: 'messages:agent.row.activity.working',
  done: 'messages:agent.row.activity.done',
};

const MayorSessionRow = memo(function MayorSessionRow({ session, active }: { session: MayorSession; active: boolean }) {
  const t = useMessages('messages');
  // Subscribed: changeRowWords reads where the change stands from the agent catalog.
  useMessages('agent');
  const at = session.lastActivityAt || session.createdAt || null;
  const activity = at ? agoStamp(at) : null;
  const thread: MessagesAgentThread = { kind: 'agent', id: session.id };
  const href = agentThreadAddress(thread);
  const change = session.activeChange;
  const mark = agentActivity(session);
  // A merge of Homeroom itself says when the platform's next release
  // carries it ("Goes live in about 8 minutes"), where any other change
  // going live says "Going live" (changeRowWords).
  const status = change
    ? dotText([
      change.title || (change.prNumber ? t('messages:agent.row.prNumber', { number: change.prNumber }) : t('messages:agent.row.changeId', { id: change.id })),
      changeRowWords(change),
    ])
    : t('messages:agent.row.noChange');
  return (
    <a
      href={href}
      data-inbox-agent-session={session.id}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === href) { event.preventDefault(); openAgentThread(thread); }
      }}
    >
      {/* #3076: working, the spinner takes the sparkle's place in the tile;
          finished unseen, the green dot does. The tile is aria-hidden, so
          the state is said in words beside the name. */}
      <span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">
        {mark
          ? <AgentActivityIcon activity={mark} className="w-5 h-5" />
          : <SparklesIcon className="w-5 h-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{session.title || t('messages:agent.row.newSession')}</span>
          {mark ? <span className="sr-only">{t(ACTIVITY_SAID[mark])}</span> : null}
          {activity
            ? <time className="messages-row-time" dateTime={at || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {session.busy ? t('messages:agent.row.working') : dotText([session.focusApp?.name, status])}
          </span>
        </div>
      </div>
    </a>
  );
});

/**
 * An app's dev session, as a thread of this inbox (#2813).
 *
 * ── Mounted, like a discussion ────────────────────────────────────────
 *
 * The session view — transcript, composer, header, venue, drafts, the spec
 * and staging panes — is DevChat's (features/dev-chat/dev-chat.js), one
 * surface with fixed ids and one owner. So the pane renders a HOST and asks
 * AppView to fill it (`AppView.mountSessionInHost`), the same arrangement
 * `AppDiscussionThread` makes with the group chat. The host's class string is
 * constant and React renders nothing inside it: its whole subtree is
 * DevChat's, which is the one-owner rule satisfied at this boundary.
 *
 * ── The side panes stay inside ────────────────────────────────────────
 *
 * The spec viewer and the staging preview are slots INSIDE the session view,
 * so they open inside this pane, docked beside the transcript, exactly as
 * they do in the app view. A viewer who wants the whole window for them has
 * the "Open full view" link in the pane's head, which is the session's own
 * address in the app.
 *
 * ── It says when it cannot open ───────────────────────────────────────
 *
 * The app view's fallback is its Board, which is not on this screen. A
 * session this viewer cannot open — and that has no published chat to read
 * instead — says so here, with the full-view link to try the app itself.
 */
function AgentSessionThread({ slug, id }: { slug: string; id: number }) {
  const t = useMessages('messages');
  const host = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const full = fullScreenAddress({ kind: 'session', slug, id });

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const view = (window as any).AppView;
    let live = true;
    setPhase('loading');
    // A macrotask later, for the reason AppDiscussionThread gives: the
    // session view is published into portals inside flushSync, which cannot
    // flush while React is still committing this effect.
    const timer = window.setTimeout(() => {
      if (!live || !view?.mountSessionInHost) return;
      Promise.resolve(view.mountSessionInHost(el, { slug, sessionId: id }))
        .then((result: string) => {
          if (!live || result === 'stale') return;
          setPhase(result === 'ready' ? 'ready' : 'unavailable');
        })
        .catch(() => { if (live) setPhase('unavailable'); });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      view?.unmountSessionHost?.(el);
    };
  }, [slug, id]);

  return (
    <section
      className="flex messages-thread-pane messages-thread-session"
      aria-label={t('messages:agent.sessionName')}
      data-agent-session={`${slug}/${id}`}
    >
      <div className="messages-session-bar">
        <a className="messages-session-full" href={full}>{t('messages:agent.session.openFull')}</a>
        <FullWidthToggle />
      </div>
      {phase === 'unavailable' ? (
        <div className="messages-state messages-state-error">
          <p>{t('messages:agent.session.unavailable')}</p>
          <a href={full}>{t('messages:agent.session.openInApp')}</a>
        </div>
      ) : null}
      {phase === 'loading' ? (
        <div className="messages-state"><span className="messages-spinner" />{t('messages:agent.session.loading')}</div>
      ) : null}
      <div ref={host} className="messages-session-host flex-1 min-h-0" hidden={phase === 'unavailable'} />
    </section>
  );
}


/**
 * The open conversation. `embedded` is the copy a community's page mounts
 * (#3494, EmbeddedConversation below): the same thread, drawn without this
 * screen's header because the page's own header and tabs already name it.
 * Exactly one copy draws the thread at a time — the store's route says
 * which — so the ids its rows carry are never on the page twice.
 */
/**
 * THE LAST CONVERSATION, PEEKING BESIDE THE LIST on a phone (Evan's design,
 * ./phone-drawer.tsx): what it showed when you left it, its newest at the
 * foot, and nothing in it can be pressed but the whole of it, which opens
 * it. Only a picture: it marks nothing read, sends nothing and follows no
 * live news, so leaving a conversation never keeps it open behind the list.
 */
function ConversationPeek({ peek }: { peek: Peek }) {
  const t = useMessages('messages');
  const channels = useChannelHandles();
  const scroller = useRef<HTMLDivElement>(null);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [peek]);
  const { conversation, messages } = peek;
  const kind = conversation.kind || 'direct';
  const person = directPerson(conversation);
  const rows: ReactNode[] = [];
  let previous: ConversationMessage | null = null;
  let previousDay: string | null = null;
  for (const message of messages) {
    if (message.deleted || message.threadRootId) continue;
    const day = dayKey(message);
    if (day && day !== previousDay) {
      rows.push(<div key={`day-${day}`} className="messages-day" aria-hidden="true">{dayLabel(message)}</div>);
      previousDay = day;
      previous = null;
    }
    const grouped = !!previous && !previous.system && !message.system
      && groupsWithPrevious(
        { author: previous.sender.id, at: previous.createdAt },
        { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
      );
    rows.push(<MessageRow key={message.clientKey || message.id} message={message} conversationId={conversation.id} grouped={grouped} channels={channels} kind={kind} />);
    previous = message;
  }
  return (
    <section className={`flex messages-thread-pane messages-thread-peek dc-lift dc-lift-session messages-thread-${kind}`} data-messages-peek={conversation.id}>
      <div className="messages-peek-body" inert aria-hidden="true">
        {/* Polish N8: what shows of it is its left edge, so it leads with
            its own face, where a conversation's header has it, and its rows
            draw no faces (app.css): a sender's face only starts a run of
            their lines, so one sat alone mid-screen like a stray badge. */}
        <div className="messages-peek-head">
          <UserAvatar user={person} title={person?.username || conversation.title} shape="square" />
        </div>
        <div ref={scroller} className="messages-thread-scroll">{rows}</div>
      </div>
      <button
        type="button"
        className="messages-peek-open"
        aria-label={t('messages:drawer.peek.open', { name: threadWords(conversation).title })}
        onClick={() => openConversation(conversation.id)}
      />
    </section>
  );
}

function ConversationThread({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the kit's keyboard avoidance on this column's scroller, as the
  // channel, its threads and a dev session get theirs from attachScreenFx.
  // Its settled pin puts back the pan iOS makes on the tap, which otherwise
  // left the composer (lifted by `platform-kb-column`) above the screen.
  useComposerKeyboard(scroller);
  // #3757: whether the reader is at the newest line, from where they last
  // scrolled, so a tall reply or a card that grows after it is drawn keeps
  // them there (./stick-to-bottom.ts).
  const pinned = useStickToBottom(scroller, !snap.nextAfter);
  const previousLast = useRef<number | null>(null);
  const initialScroll = useRef<number | null>(null);
  // Whether this conversation was last drawn as a linked window (#2387).
  const wasWindow = useRef(false);
  const conversationId = snap.route.conversationId;
  // 1 Nov 2026: the bot's typing is its working card, where its answer will
  // appear (./bot-working.tsx); the status line keeps people's names, and
  // the bot's too while the transcript is a window part-way back.
  const typists = conversationId ? typingUsers(conversationId) : [];
  const working = snap.nextAfter ? null : workingBot(typists);
  const typing = typingBesides(typists, working);
  // #2884: the runs of cards the viewer has opened, by their first message.
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set());
  // One request, one story: where each request stands, for folding the settled ones.
  const { work: botWork, failed: botWorkFailed } = useBotWork();
  // #2387: the message a link pointed at, flashed once it is drawn.
  const focusId = snap.route.focusMessageId;
  const [flashId, setFlashId] = useState<number | null>(null);
  const shownFocus = useRef<number | null>(null);
  // #5019: loading earlier messages on scroll. A failed load restores the
  // button at the top as the manual way back, until it succeeds or the
  // conversation (or its next-older cursor) changes.
  const [olderFailed, setOlderFailed] = useState(false);
  // THE "NEW" LINE (./unread-anchor.ts): above the first message after where
  // reading had stopped when this conversation was opened (the store's
  // `unreadMark`). The transcript opens with it near the top.
  const unreadLine = useRef<HTMLDivElement>(null);
  const mark = snap.unreadMark && snap.unreadMark.conversationId === conversationId ? snap.unreadMark : null;
  const viewerId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || 0 : 0;
  const unreadRows = useMemo(() => snap.messages.map((message) => messageRow(message, viewerId)), [snap.messages, viewerId]);
  const lineAt = mark ? firstUnreadId(unreadRows, mark.lastReadId) : null;
  const holdLine = useLineHold(conversationId);
  // #3692: a conversation with the Homeroom bot carries its activity tray,
  // and #4564 its rows draw as change blocks (see the memo below).
  const botDm = !!snap.active && snap.active.id === conversationId && snap.active.kind === 'direct'
    && snap.active.membershipStatus === 'member' && snap.active.homeroomBot === true;
  // THE BOT'S CHAT OPENS AT ITS FINAL SHAPE (./open-hold.ts): its rows are
  // laid out but hidden, under the spinner, until its tray has answered and
  // the screen is full or nothing older is left. `shownFor` is the
  // conversation shown since it was opened, and `holdOverFor` the one whose
  // OPEN_HOLD_MS ran out; closing it (a phone's Back) or opening another
  // starts the next open over.
  const [shownFor, setShownFor] = useState<number | null>(null);
  const [holdOverFor, setHoldOverFor] = useState<number | null>(null);
  const holding = botDm && !!conversationId && shownFor !== conversationId && snap.messages.length > 0;
  useIsomorphicLayoutEffect(() => {
    if (conversationId) return;
    setShownFor(null);
    setHoldOverFor(null);
  }, [conversationId]);
  useEffect(() => {
    if (!holding || !conversationId) return undefined;
    const id = conversationId;
    const timer = window.setTimeout(() => setHoldOverFor(id), OPEN_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding, conversationId]);
  // #4046 and #4564, decided once per drawn transcript so a row's layout and
  // its block stay the same object between publishes and its memo() holds:
  // the plans (a first version's plan carries its request's step,
  // ./bot-plan.tsx) and, in the bot's DM, the change blocks — one outlined
  // block per change, the change's card first (./bot-shared.ts
  // changeBlocks, ./message-row.tsx). Other kinds of chat get neither.
  const layout = useMemo(() => {
    if (!botDm) return { plans: NO_PLAN_LAYOUT, blocks: null as ReadonlyMap<number, ChangeBlock> | null };
    const plans = planLayout(snap.messages);
    const blocks = changeBlocks(snap.messages, {
      // The rows the loop skips: passed over without breaking a run.
      hidden: (message) => isMovedActivity(message) || plans.hidden.has(message.id),
      // The same stretch of transcript: same day, and no unread line between.
      together: (previous, next) => dayKey(previous) === dayKey(next)
        && !(lineAt !== null && previous.id < lineAt && next.id >= lineAt),
      // Who shows the request, so a later row of the block may drop its card.
      showsRequest: (message) => isActivityMessage(message)
        || botHead(message.content, botMeta(message))?.kind === 'request'
        || readyNamesRequest(message),
    });
    return { plans, blocks };
  }, [botDm, snap.messages, lineAt]);

  useIsomorphicLayoutEffect(() => {
    if (!conversationId) return;
    previousLast.current = null; initialScroll.current = null; pinned.current = true; wasWindow.current = false;
  }, [conversationId]);

  // A layout effect, so the scroll lands before the new rows are painted and
  // `pinned` is read before any scroll event can report the grown content.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const lastMessage = snap.messages.at(-1);
    const last = lastMessage?.id || null;
    if (!el || !last) return;
    const fromWindow = wasWindow.current || !!snap.nextAfter;
    wasWindow.current = !!snap.nextAfter;
    // #2387: a message link lands on its message, centred and flashed, once
    // — not at the bottom, and not again on every refresh after.
    if (focusId && shownFocus.current !== focusId) {
      // This transcript's own row: a reply drawn in the thread pane beside it
      // carries the same id, and is that pane's to show.
      const row = el.querySelector<HTMLElement>(`[id="messages-message-${focusId}"]`);
      if (row) {
        shownFocus.current = focusId;
        previousLast.current = last;
        pinned.current = false;
        requestAnimationFrame(() => centreInScroller(el, row));
        setFlashId(focusId);
        window.setTimeout(() => setFlashId((id) => (id === focusId ? null : id)), 2400);
        return;
      }
    }
    if (focusId && shownFocus.current === focusId && snap.nextAfter) { previousLast.current = last; return; }
    // Unread messages: the conversation opens at the first of them, its
    // "New" line a row or two below the top, instead of at the newest. When
    // everything new fits at the bottom it opens there, following what
    // arrives as it always did (openingScrollTop says which).
    const line = unreadLine.current;
    if (previousLast.current === null && line && !snap.nextAfter) {
      const at = openingScrollTop({ lineTop: lineTopIn(el, line), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      el.scrollTop = at.top;
      pinned.current = at.pinned;
      // And keeps it there while images and link cards above it fill in.
      if (!at.pinned) holdLine(el, line);
      previousLast.current = last;
      return;
    }
    // A new line, the viewer's own send included (#4511), follows only a
    // reader who was at the bottom BEFORE it arrived (#3757): measured now,
    // after the draw, a reply taller than the allowance read as the reader
    // having scrolled up. A reader up in the history stays where they are
    // reading. The one send that still moves is one from a linked window
    // (#2387): store.send takes it to the present, which is a different
    // stretch of the conversation, so it opens at its newest line.
    const sentNow = !!lastMessage?.pending && last !== previousLast.current && fromWindow;
    if (previousLast.current === null || sentNow || pinned.current) {
      // The foot of a linked window (#2387) is not the present: nothing
      // follows it there. A send from one goes to the present (store.send).
      pinned.current = sentNow || !snap.nextAfter;
      el.scrollTop = el.scrollHeight;
    }
    previousLast.current = last;
  }, [snap.messages, focusId, snap.nextAfter]);

  // The banner over the transcript's top and the jump to the latest over its
  // foot. After the effect above, so they measure where the opening put it.
  const { view: unread, toLine, toLatest } = useUnreadAffordances(scroller, unreadLine, {
    conversation: conversationId,
    markKey: mark ? `${mark.conversationId}:${mark.lastReadId}` : '',
    lineAt,
    rows: unreadRows,
    atPresent: !snap.nextAfter,
    offerBanner: !focusId,
  });
  // At the foot of a linked window (#2387) the latest is not drawn yet.
  const jumpToLatest = () => {
    if (snap.nextAfter) { pinned.current = true; jumpToPresent(); return; }
    toLatest();
  };

  async function older() {
    const el = scroller.current;
    if (el) initialScroll.current = el.scrollHeight;
    const ok = await loadOlder();
    requestAnimationFrame(() => {
      if (el && initialScroll.current !== null) el.scrollTop += el.scrollHeight - initialScroll.current;
      initialScroll.current = null;
    });
    return ok;
  }

  // #5019: scrolling up near the top reads the previous page in, one at a
  // time, in place of the button that used to sit there. The latest values
  // the guard reads go through a ref, so the scroll listener below attaches
  // once per scroller instead of on every publish.
  const olderGate = useRef({ conversationId, nextBefore: snap.nextBefore, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, olderFailed });
  olderGate.current = { conversationId, nextBefore: snap.nextBefore, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, olderFailed };
  function maybeLoadOlder() {
    const el = scroller.current;
    if (!el) return;
    const gate = olderGate.current;
    if (!gate.nextBefore || gate.loadingOlder || gate.loadingThread || gate.olderFailed) return;
    if (!isNearTop(el)) return;
    void older().then((ok) => { if (!ok) setOlderFailed(true); });
  }
  useIsomorphicLayoutEffect(() => { setOlderFailed(false); }, [conversationId, snap.nextBefore]);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => maybeLoadOlder();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  // A short thread keeps reading pages in until the screen fills or the
  // conversation's older end is reached. In the bot's chat the tray landing
  // folds its settled rows into "N finished", which can leave it short too.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (needsMoreHistory(el)) maybeLoadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.messages, snap.nextBefore, snap.loadingOlder, botWork]);
  // ./open-hold.ts: the bot's chat is shown once it can draw what it will
  // stay as. After the effect above, so it measures what that one read, and
  // a layout effect, so the rows appear in the frame they settle in.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!holding || !el) return;
    if (openHoldDone({
      trayRead: !!botWork || botWorkFailed,
      hasOlder: !!snap.nextBefore,
      loadingOlder: snap.loadingOlder,
      olderFailed,
      short: needsMoreHistory(el),
      expired: holdOverFor === conversationId,
    })) setShownFor(conversationId);
  });

  // #3494: the room is up in its community's page, so this screen (hidden)
  // draws no second copy of it; and the page's copy draws nothing once
  // Messages has taken the store back.
  if (!!snap.route.embedded !== embedded) {
    return embedded ? null : <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>{t('messages:thread.empty.title')}</h2></section>;
  }
  if (snap.route.appSlug) return <AppDiscussionThread slug={snap.route.appSlug} />;
  if (snap.route.agent?.kind === 'agent') return <MayorSessionThread key={`agent/${snap.route.agent.id}`} id={snap.route.agent.id} />;
  if (snap.route.agent?.kind === 'session') {
    const { slug, id } = snap.route.agent;
    return <AgentSessionThread key={`${slug}/${id}`} slug={slug} id={id} />;
  }
  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>{t('messages:thread.empty.title')}</h2><p>{t('messages:thread.empty.body')}</p></section>;
  // The kind is on the SECTION — `messages-thread-direct`, `-group` or
  // `-channel` — so the scroller's class string below stays the one the
  // safe-area test pins. It decides the rows' shape: a DM and a group draw
  // their own message on its sender's side (#5680), a channel keeps the
  // named-row transcript (#2783) — ./message-row.tsx.
  const kind = snap.active?.kind || 'direct';
  const rows: ReactNode[] = [];
  let previousDay = '';
  let previous: ConversationMessage | null = null;
  // The "New" line, drawn once: above the first unread message, or above
  // the first row drawn after it when that message is not drawn itself.
  let lineDrawn = false;
  const drawLine = () => {
    if (lineDrawn) return;
    lineDrawn = true;
    rows.push(<NewMessagesDivider key="unread-line" ref={unreadLine} />);
  };
  // #2884: three or more cards in a row — messages that are only a shared
  // item — draw as the first and a "… N more" row (../../lib/card-runs.ts).
  // A day divider breaks a run, so folding never hides one.
  const runs = cardRunStarts(snap.messages, isCardMessage, (a, b) => dayKey(a) === dayKey(b));
  const { plans, blocks } = layout;
  // One request, one row: the bot's news about a request is drawn once, at
  // its newest piece; the earlier ones fold into that row (./bot-news-line.tsx).
  // What still asks something here is drawn whole where it was said, and
  // answered there (31 Oct 2026: the thread that drew it whole is gone).
  const asking = (message: ConversationMessage) => botDm && asksInChat(message) && !newsStatusOf(message, botWork)?.settled;
  const newsFold = botDm ? foldBotNews(snap.messages, (message) => isMovedActivity(message) || plans.hidden.has(message.id) || asking(message)) : null;
  const byId = newsFold ? new Map(snap.messages.map((message) => [message.id, message])) : null;
  // Settled rows in a row, waiting to be drawn as one folded line
  // (./bot-news-line.tsx SettledRun); anything else drawn, a day or the
  // "New" line ends the run.
  let settledRun: SettledRunItem[] = [];
  // A folded run opened or closed keeps its count where it was on screen:
  // the reader is no longer following the newest line for that press.
  const holdPlace = (el: HTMLElement) => {
    pinned.current = false;
    const top = el.getBoundingClientRect().top;
    return () => {
      const box = scroller.current;
      const moved = el.getBoundingClientRect().top - top;
      if (box && moved) box.scrollTop += moved;
    };
  };
  const flushRun = () => {
    if (settledRun.length === 1) {
      const [item] = settledRun;
      rows.push(<BotNewsLine key={item.message.clientKey || item.message.id} message={item.message} earlier={item.earlier} updates={item.updates} focused={item.focused} />);
    } else if (settledRun.length) {
      rows.push(<SettledRun key={`settled-${settledRun[0].message.id}`} items={settledRun} holdPlace={holdPlace} />);
    }
    settledRun = [];
  };
  for (let index = 0; index < snap.messages.length; index += 1) {
    const message = snap.messages[index];
    // B6: a card Build it moved under its plan is drawn there, not here.
    if (isMovedActivity(message)) continue;
    // #4046: and a card whose step its plan carries is not drawn at all.
    if (plans.hidden.has(message.id)) continue;
    // One request, one row: news drawn inside a newer row about its request.
    if (newsFold?.hidden.has(message.id)) continue;
    const day = dayKey(message);
    const asks = asking(message);
    const settled = botDm && isBotNews(message) && !asks && !!newsStatusOf(message, botWork)?.settled;
    if (!settled || (day && day !== previousDay) || (lineAt !== null && message.id >= lineAt && !lineDrawn)) flushRun();
    if (day && day !== previousDay) {
      rows.push(<div key={`day-${day}`} className="messages-day" aria-hidden="true">{dayLabel(message)}</div>);
      previousDay = day;
    }
    if (lineAt !== null && message.id >= lineAt) drawLine();
    // One request, one story: in the chat with Homeroom bot, the bot's news
    // about a request is ONE short line (./bot-news-line.tsx) whose tap opens
    // the request's own page, unless it still asks something here.
    if (botDm && isBotNews(message) && !asks) {
      const earlier = newsFold?.earlier.get(message.id) || [];
      // The story's size: its thread's replies, else the news folded in here.
      const root = message.threadRootId ? byId?.get(message.threadRootId) : message;
      const updates = root?.thread?.replyCount || (earlier.length ? earlier.length + 1 : 0);
      const focused = flashId === message.id || earlier.some((item) => item.id === flashId);
      previous = null;
      if (settled) { settledRun.push({ message, earlier, updates, focused }); continue; }
      rows.push(<BotNewsLine
        key={message.clientKey || message.id}
        message={message}
        earlier={earlier}
        updates={updates}
        focused={focused}
      />);
      continue;
    }
    // #2387 follow-up: a thread's reply, drawn where it landed — one card for
    // the run of replies to that thread with nothing else said between them
    // on the same day. A deleted reply is gone from the run; the next message
    // after the card carries its own name.
    //
    // One request, one story: in the chat with Homeroom bot the replies the
    // main stream lists are the moments that ring (`alsoInChat`), each drawn
    // whole, buttons and all, under its "↳ in …" label (./message-row.tsx),
    // not as a line about the thread.
    const moment = botDm && alsoInChat(message);
    if (message.threadRootId && !moment) {
      const run = [message];
      while (index + 1 < snap.messages.length) {
        const next = snap.messages[index + 1];
        if (next.threadRootId !== message.threadRootId || dayKey(next) !== day || (botDm && alsoInChat(next))) break;
        run.push(next);
        index += 1;
      }
      const live = run.filter((item) => !item.deleted);
      if (live.length) {
        rows.push(<ThreadActivityRow key={`thread-activity-${live[0].clientKey || live[0].id}`} replies={live} />);
      }
      previous = null;
      continue;
    }
    // A failed or unsent row is its own line: it carries a status of its own.
    // So is a platform line (a Homeroom line kept as the root of a thread),
    // which has no author to share a name with the row above.
    // A moment carries its own label and name: never a continuation line.
    const grouped = !moment && !!previous && !previous.failed && !message.failed
      && !previous.system && !message.system
      && groupsWithPrevious(
        { author: previous.sender.id, at: previous.createdAt },
        { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
      );
    rows.push(<MessageRow
      key={message.clientKey || message.id}
      message={message}
      conversationId={conversationId}
      grouped={grouped}
      channels={channels}
      kind={kind}
      threadOpen={snap.route.threadRootId === message.id}
      focused={flashId === message.id}
      planCardId={plans.cardOf.get(message.id) ?? null}
      hidePrompts={plans.answersOpen && !!message.sender.bot}
      // #4564: this row's part of its change's block, in the bot's DM alone.
      block={blocks?.get(message.id) ?? null}
      botChat={botDm}
    />);
    previous = moment ? null : message;
    const length = runs.get(index);
    const runKey = String(message.clientKey || message.id);
    if (length && !expandedRuns.has(runKey)) {
      const hidden = length - 1;
      // The first unread folded away in the run: the line goes above the
      // fold that holds it.
      if (lineAt !== null && snap.messages[index + hidden].id >= lineAt) drawLine();
      rows.push(
        <div key={`more-${runKey}`} className="messages-card-run">
          <button
            type="button"
            className="messages-card-run-more"
            data-card-run-more={hidden}
            aria-expanded="false"
            aria-label={t('messages:thread.showMoreCards', { count: hidden })}
            onClick={() => setExpandedRuns((open) => new Set(open).add(runKey))}
          >{cardRunLabel(hidden)}</button>
        </div>,
      );
      // The row after the fold always carries its own name: drawn as a
      // continuation under "… N more", it would read as part of the fold.
      previous = null;
      index += hidden;
    }
  }
  flushRun();
  return (
    <section className={`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-${kind}${embedded ? ' messages-thread-embedded' : ''}`} aria-label={snap.active?.title || t('messages:thread.paneName')} data-opening={holding ? '' : undefined}>
      {embedded ? null : <ThreadHeader />}
      {/* One request, one story: "Your requests", pinned under the bot's header. */}
      {botDm && !embedded ? <BotStrip /> : null}
      <InvitationBanner />
      {botDm ? <BotWorkSync conversationId={conversationId} newsKey={newestBotMessageId(snap.messages)} /> : null}
      {/* #3736: and keeps the activity cards in its transcript current. */}
      {botDm ? <BotActivitySync conversationId={conversationId} newsKey={newestBotMessageId(snap.messages)} /> : null}
      {/* What is new, counted over the transcript's top; a tap goes to the
          "New" line (./unread-anchor.ts). Hung beside the scroller, not in
          it, so the scroller keeps its size and its class string. */}
      {mark ? (
        <TranscriptOverlay edge="top">
          <NewMessagesBanner shown={unread.banner} onClick={toLine}>{newMessagesLabel(mark.count)}</NewMessagesBanner>
        </TranscriptOverlay>
      ) : null}
      {/* No `un-kb-avoid` WRITTEN here: the column reserves the keyboard
          inset (`platform-kb-column` above). The kit adds the class itself
          once useComposerKeyboard attaches (#3571), as it does to
          `#gc-messages`, and app.css's `.platform-kb-column .un-kb-avoid`
          keeps it from padding this scroller with the inset a second time.
          So this className stays constant: React never strips the kit's.
          `chat-transcript` is what ends the transcript 12px inside this
          scroller, at the composer card's edge, as every chat's does
          (@/components/ui/chat, "A chat's foot", 1 November 2026). */}
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll chat-transcript" aria-live="polite">
        {/* Only a thread with nothing to show yet says it is loading (#2907).
            A refresh of the visible thread — the realtime echo of every send
            is one — re-reads it silently: this row drawn above the messages
            pushed the whole transcript down on each message sent. */}
        {snap.loadingThread && !snap.messages.length ? <div className="messages-state"><span className="messages-spinner" />{t('messages:thread.loading')}</div> : null}
        {/* The bot's chat keeps saying it while it opens (./open-hold.ts),
            over its rows, which app.css hides until then. */}
        {holding ? <div className="messages-state" data-opening-state=""><span className="messages-spinner" />{t('messages:thread.loading')}</div> : null}
        {/* QA 2026-09-24 Q16: a conversation that cannot come back offers the
            way out, not a Try again that reads the same answer. Leaving it
            here is said plainly, in the ordinary state colour: it is what
            the viewer asked for, not an error. */}
        {snap.threadGone === 'left' ? <div className="messages-state" data-thread-gone="left"><p>{t('messages:thread.left')}</p><button type="button" onClick={() => messagesController.open(null)}>{t('messages:thread.backToMessages')}</button></div> : null}
        {snap.threadError && !snap.messages.length ? <div className="messages-state messages-state-error"><p>{snap.threadError}</p>{snap.threadGone === 'missing'
          ? <button type="button" onClick={() => messagesController.open(null)}>{t('messages:thread.backToMessages')}</button>
          : <button type="button" onClick={() => messagesController.route(conversationId)}>{t('core:common.tryAgain')}</button>}</div> : null}
        {!snap.loadingThread && !snap.threadError && snap.active && snap.active.membershipStatus === 'member' && !snap.messages.length ? <div className="messages-thread-empty"><span aria-hidden="true">👋</span><p>{t('messages:thread.emptyConversation')}</p></div> : null}
        {/* #5019: the old button row holds its height and, while loading, the
            "Loading…" line where the button was. The button itself returns
            only to retry a failed load; scrolling up does the rest. */}
        {snap.nextBefore ? (
          <div className="flex h-12 items-center justify-center" data-load-older="">
            {snap.loadingOlder
              ? <span role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:thread.loadingOlder')}</span>
              : olderFailed
                ? <button type="button" onClick={() => { setOlderFailed(false); void older().then((ok) => { if (!ok) setOlderFailed(true); }); }} className="messages-load-older">{t('messages:thread.loadEarlier')}</button>
                : null}
          </div>
        ) : null}
        {rows}
        {working ? <BotWorkingCard typist={working} /> : null}
        {/* #2387: a message link opened the transcript part-way back. */}
        {snap.nextAfter ? (
          <div className="messages-newer">
            <button type="button" className="messages-load-older" disabled={snap.loadingOlder} onClick={() => void loadNewer()}>{snap.loadingOlder ? t('messages:thread.loadingNewer') : t('messages:thread.loadNewer')}</button>
            <button type="button" className="messages-load-older" onClick={() => { pinned.current = true; jumpToPresent(); }}>{t('messages:thread.jumpToPresent')}</button>
          </div>
        ) : null}
      </div>
      {/* Jump to latest whenever the reader is not at the bottom, with a dot
          for what arrived while they were up: centred, hung from the
          transcript's foot, just above the composer (@/components/ui/chat
          TranscriptOverlay). Above the typing line since 1 November 2026,
          as in every chat: it rises with the transcript when a name
          appears rather than covering it. */}
      <TranscriptOverlay edge="foot">
        <JumpToLatestButton shown={unread.jump} dot={unread.arrived > 0} aria-label={jumpLabel(unread.arrived)} title={t('messages:thread.jumpToLatest')} onClick={jumpToLatest} />
      </TranscriptOverlay>
      <ChatStatusLine className="messages-typing">{typingLine(t, typing)}</ChatStatusLine>
      <MessageComposer />
    </section>
  );
}

/**
 * A run of one thread's replies in the main transcript (#2387 follow-up):
 * the shared card, told who replied and what, and to open that thread.
 */
function ThreadActivityRow({ replies }: { replies: ConversationMessage[] }) {
  // Subscribed: the time range is read from the catalog as this renders.
  useMessages('messages');
  const first = replies[0];
  const last = replies[replies.length - 1];
  const rootId = first.threadRootId as number;
  const root = first.threadRoot;
  const start = timeOfDay(first.createdAt);
  const end = timeOfDay(last.createdAt);
  return (
    <ThreadActivityCard
      rootText={root?.content || ''}
      rootDeleted={!!root?.deleted}
      time={start === end ? start : translate('messages:thread.activityTimeRange', { start, end })}
      timeTitle={fullTime(last.createdAt)}
      replies={replies.map((reply) => ({
        key: reply.clientKey || reply.id,
        face: <span className="msgx-thread-face"><UserAvatar user={reply.sender} size="sm" shape="square" /></span>,
        // N14: a bot by its name ("Homeroom bot"), a person by @username.
        name: reply.sender.bot ? senderName(reply.sender, { bare: true }) : reply.sender.username,
        bot: !!reply.sender.bot,
        text: reply.content,
      }))}
      onOpen={() => openThread(rootId)}
    />
  );
}

/**
 * A REPLY THREAD beside its conversation (#2387): the message it hangs off,
 * its replies, and a composer of its own. Slack's arrangement — the
 * conversation stays readable on the left while the side conversation runs
 * on the right — drawn as a second sheet on the same strip. On a phone it
 * covers the conversation instead (app.css), and Back returns to it.
 *
 * DMs have no threads: a thread is how a room keeps a side conversation out
 * of everyone's way, and a DM has no one else in it. The chat with Homeroom
 * bot is the one that does (./bot-shared.ts threadsAllowed): there each
 * request's card is the root of its thread, which this pane names by the
 * request ("Dark mode", "Plant Pal first version") over its project.
 */
/**
 * The thread pane's loading state, at the message row's own geometry
 * (#5219 review). While the replies and, on a request's thread, the request's
 * public discussion are still loading, the pane shows the rows they will
 * arrive as — avatar, head line, words — rather than a blank pane under a
 * line of grey text. The wrapper IS `.messages-message`, not an imitation of
 * it: that class owns the flex, the gap and the row padding in app.css, so
 * the placeholder cannot drift from the row the first time any of those move.
 *
 * Four, because the pane is taller than that on every phone and a thread
 * that stops halfway reads as a short thread rather than a loading one.
 */
function ReplyRowSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:replies.loading')}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="messages-message" aria-hidden="true">
          {/* The md square UserAvatar's 36px box. */}
          <Skeleton shape="block" className="h-9 w-9 rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Skeleton className="w-24" />
              <Skeleton shape="muted" className="ms-auto w-12" />
            </div>
            <Skeleton shape="muted" className={`mt-2 ${i % 2 ? 'w-2/5' : 'w-3/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

// #5691: the divider between a chat and its open thread. The width is this
// device's own — a key of its own, not a change session's side pane's — kept
// between the thread's floor and the room the chat has to keep.
const REPLY_WIDTH_KEY = 'messages-reply-width-v1';
const REPLY_MIN_WIDTH = 320;
const REPLY_CHAT_MIN_WIDTH = 360;
/** The strip's margins beside the chat and right of the thread. */
const REPLY_MARGINS = 24;
/** How far one arrow key moves the divider. */
const REPLY_WIDTH_STEP = 24;

function clampReplyWidth(width: number, containerWidth: number | null | undefined): number {
  const wanted = Number.isFinite(width) ? width : REPLY_MIN_WIDTH;
  const ceiling = typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.max(REPLY_MIN_WIDTH, containerWidth - REPLY_CHAT_MIN_WIDTH - REPLY_MARGINS)
    : Infinity;
  return Math.round(Math.min(ceiling, Math.max(REPLY_MIN_WIDTH, wanted)));
}

function readReplyWidth(): number | null {
  try {
    const value = parseInt(window.localStorage.getItem(REPLY_WIDTH_KEY) || '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeReplyWidth(px: number): void {
  try { window.localStorage.setItem(REPLY_WIDTH_KEY, String(Math.round(px))); } catch { /* the default next time */ }
}

function ReplyThreadPanel({ inMain = false, onBack = null }: {
  /**
   * 31 Oct 2026: open in Main Chat's column on the Homeroom bot tab, the
   * only place the chat with the bot is drawn. The thread covers the chat
   * there (app.css `[data-main-chat]`). 1 Nov 2026: alone, under its own
   * head: its title and "Only you can see this thread", with no ✕ and no way
   * back to Main Chat, which is a row of the tab's list now.
   */
  inMain?: boolean;
  /** A phone's drawer: the back arrow that leads the head, to the list. */
  onBack?: (() => void) | null;
} = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  const conversationId = snap.route.conversationId;
  const rootId = snap.route.threadRootId;
  const thread = snap.thread && snap.thread.rootId === rootId ? snap.thread : null;
  // 1 Nov 2026: the bot answering here is its working card (./bot-working.tsx).
  const threadTypists = conversationId && rootId ? typingUsers(conversationId, rootId) : [];
  const threadWorking = workingBot(threadTypists);
  const threadTyping = typingBesides(threadTypists, threadWorking);
  // 16 Oct 2026: a request's thread marks where each of its tries began
  // (./bot-track.tsx), when the bot built it more than once.
  const trackRoot = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  const trackMeta = trackRoot?.sender.bot ? trackRoot.metadata?.homeroomBot || null : null;
  const track = useTrackOf(trackMeta ? {
    appSlug: trackMeta.appSlug, appName: trackMeta.appName, issueNumber: trackMeta.issueNumber, firstVersion: trackMeta.firstVersion === true,
  } : null);
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the same keyboard avoidance as the conversation beside it. On a
  // phone this pane covers the conversation, so its composer is the one the
  // keyboard comes up under when a thread is replied to.
  useComposerKeyboard(scroller);
  // #4511/#4513: the conversation's rule (./stick-to-bottom.ts). A reader at
  // the newest reply stays there as replies arrive, their own included, and
  // as the composer grows with a second line; one reading further up is
  // left there. A thread opens at its newest reply.
  const pinned = useStickToBottom(scroller, true);
  const count = useRef(0);
  useIsomorphicLayoutEffect(() => { pinned.current = true; }, [conversationId, rootId]);
  useEffect(() => {
    if (conversationId && rootId && !snap.loadingThread && snap.active?.id === conversationId) {
      void loadReplyThread(conversationId, rootId);
    }
  }, [conversationId, rootId, snap.active?.id, snap.loadingThread]);
  // New replies land in view for a reader who was at the bottom before they
  // arrived. A layout effect, so it is read before a scroll event can report
  // the grown content.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const n = thread?.messages.length || 0;
    if (el && n !== count.current && pinned.current) el.scrollTop = el.scrollHeight;
    count.current = n;
  }, [thread?.messages.length]);
  // One request, one story: a thread opened at one of its messages (the
  // strip's Needs you button, store.openThreadAt; or a link to a reply)
  // shows it once it is drawn, centred and flashed, and stops following the
  // newest reply. Looked for in this pane only.
  const wanted = snap.threadFocusId || snap.route.focusMessageId || null;
  const [flashId, setFlashId] = useState<number | null>(null);
  const shownFocus = useRef<number | null>(null);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !wanted || shownFocus.current === wanted || !thread || thread.loading) return;
    const row = el.querySelector<HTMLElement>(`[id="messages-message-${wanted}"]`);
    if (!row) return;
    shownFocus.current = wanted;
    pinned.current = false;
    requestAnimationFrame(() => centreInScroller(el, row));
    setFlashId(wanted);
    window.setTimeout(() => {
      setFlashId((id) => (id === wanted ? null : id));
      clearThreadFocus();
    }, 2400);
  }, [wanted, thread?.messages.length, thread?.loading]);
  // #5691: how wide this thread is, against the chat beside it. Read in an
  // effect, never during the first render, so the first paint draws the CSS
  // default (and is the same markup on every render).
  const paneRef = useRef<HTMLElement>(null);
  const [replyWidth, setReplyWidth] = useState<number | null>(null);
  const stripWidth = () => paneRef.current?.parentElement?.getBoundingClientRect().width ?? null;
  useEffect(() => {
    const stored = readReplyWidth();
    if (stored != null) setReplyWidth(clampReplyWidth(stored, stripWidth()));
  }, []);
  const hasReplyWidth = replyWidth != null;
  // A window made narrower than a remembered width allows is re-clamped.
  useEffect(() => {
    if (!hasReplyWidth) return undefined;
    const onResize = () => setReplyWidth((width) => (width == null ? width : clampReplyWidth(width, stripWidth())));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hasReplyWidth]);
  const commitReplyWidth = (next: number) => {
    const clamped = clampReplyWidth(next, stripWidth());
    setReplyWidth(clamped);
    return clamped;
  };
  const onReplyResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? replyWidth ?? REPLY_MIN_WIDTH;
    let latest = startWidth;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { /* moves still arrive on the handle */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // An iframe swallows pointer moves: the spec's screen frames, while the
    // drag runs.
    const frames = Array.from(paneRef.current?.querySelectorAll<HTMLIFrameElement>('iframe') || []);
    frames.forEach((frame) => { frame.style.pointerEvents = 'none'; });
    // Dragging toward the thread's own edge widens it: the divider is its
    // inline-start edge, the left in English and the right in Arabic.
    const onMove = (move: PointerEvent) => { latest = commitReplyWidth(startWidth - dirSign() * (move.clientX - startX)); };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      frames.forEach((frame) => { frame.style.pointerEvents = ''; });
      writeReplyWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };
  const onReplyResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const base = replyWidth ?? Math.round(paneRef.current?.getBoundingClientRect().width || REPLY_MIN_WIDTH);
    // An arrow toward the divider widens the thread, as the drag does.
    const toward = event.key === 'ArrowLeft' ? 1 : -1;
    writeReplyWidth(commitReplyWidth(base + toward * dirSign() * REPLY_WIDTH_STEP));
  };
  // #6019: a private thread in their chat with the bot is theirs alone
  // until they File it or Post it under the bot's offer: its head says so,
  // its foot has the door that applies (./private-thread-bar.tsx). 1 Nov 2026: every one, not only
  // those off a message of theirs: a "+" thread, a draft the bot opened and
  // a design thread hang off a line of the bot's, and the server says
  // whether it is theirs (`mine`). Read before the early return, so the hook
  // holding where it stands always runs.
  const meId = Number(typeof window !== 'undefined' ? (window as any).App?.user?.id : 0) || 0;
  const privateRootMessage = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  const privateRoot = rootId && snap.active?.kind === 'direct' && threadsAllowed(snap.active) && snap.active.homeroomBot
    && privateRootMessage && !requestPageOf(privateRootMessage)
    ? rootId : null;
  const [privateWhere] = usePrivateThread(privateRoot);
  // 1 Nov 2026 (C1): whether this thread's design is open beside it.
  const preview = usePreview();
  const privateMine = !!privateRoot && isOwnPrivateThread(privateWhere, privateRootMessage, meId);
  if (!conversationId || !rootId) return null;
  const active = snap.active;
  const kind = active?.kind || 'group';
  const root = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  // One request, one story: the bot's chat names the thread by its request.
  const botChat = kind === 'direct' && threadsAllowed(active);
  // 31 Oct 2026: a request's story is the request's page (./request-page.ts),
  // which the store opens instead (store.openThread, loadReplyThread): no
  // thread of this chat's is drawn for it, even for the moment that takes.
  if (botChat && kind === 'direct' && requestPageOf(root)) return null;
  const rootMeta = botChat && root?.sender.bot ? root.metadata?.homeroomBot || null : null;
  // #6071 follow-up: a thread from the bot's "+" is named by what it is for
  // and its project, never as a request it is not.
  const started = rootMeta?.kind === 'opened_thread' ? rootMeta : null;
  const request = rootMeta && !started ? botRequestNames(rootMeta) : null;
  const where = started ? (started.appName || started.appSlug || t('messages:newThread.anyProject'))
    : request ? request.project : active ? (kind === 'channel' ? `#${active.channelKey || active.title}` : active.title) : '';
  const replies = thread?.messages || [];
  // 1 Nov 2026: in Main Chat's column a thread is named as the tab's list
  // names it (./private-thread-bar.tsx privateThreadTitle).
  const mainTitle = inMain
    ? privateThreadTitle(root, replies, meId) || (started ? startedThreadTitle(t, started.changeKind) : t('messages:replies.title'))
    : null;
  // #5219: on a request's thread the request's public discussion rides
  // along, and the two read in one transcript, in the order they were said.
  // Ties keep the DM replies first (the sort is stable); a reply still in
  // flight (an optimistic local echo) stays last, whatever its time.
  const discussion = thread?.discussion || null;
  type MergedRow =
    | { kind: 'reply'; message: ConversationMessage }
    | { kind: 'discussion'; message: DiscussionMessage };
  const merged: MergedRow[] = [
    ...replies.map((message) => ({ kind: 'reply' as const, message })),
    ...(discussion?.messages || []).map((message) => ({ kind: 'discussion' as const, message })),
  ];
  if (merged.length > 1) {
    merged.sort((a, b) => (a.message.createdAt < b.message.createdAt ? -1 : a.message.createdAt > b.message.createdAt ? 1 : 0));
    const inFlight = merged.filter((row) => row.kind === 'reply' && row.message.id < 0);
    if (inFlight.length) {
      merged.splice(0, merged.length,
        ...merged.filter((row) => !(row.kind === 'reply' && row.message.id < 0)),
        ...inFlight);
    }
  }
  // A plan in a request's thread carries the step of the card it hangs off (./bot-plan.tsx).
  const cardId = root && isActivityMessage(root) ? root.id : null;
  // One request, one story: a story from before threads opens on its oldest
  // piece (./bot-request.ts storyRootIn), and the pieces after it, still in
  // the main stream, are drawn under it, whole.
  const storyKey = botChat && root && !cardId && isBotNews(root) ? requestKey(root.metadata?.homeroomBot || {}) : null;
  const pieces = storyKey && root
    ? snap.messages.filter((item) => item.id > root.id && !item.threadRootId && !item.thread && isBotNews(item) && requestKey(item.metadata?.homeroomBot || {}) === storyKey)
    : [];
  let previous: MergedRow | null = null;
  // Which try each entry belongs to: one divider where a try begins.
  const tryStarts = track && track.tryStarts.length > 1 ? track.tryStarts.map((at) => Date.parse(at)).filter(Number.isFinite) : [];
  let lastTry = 0;
  const tryDivider = (createdAt: string) => {
    if (!tryStarts.length) return null;
    const at = Date.parse(createdAt);
    const which = Math.max(1, tryStarts.filter((start) => start <= at).length);
    if (which === lastTry) return null;
    lastTry = which;
    const date = new Date(tryStarts[which - 1]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return (
      <div className="messages-reply-count" data-bot-try={which}>
        <span>{t('messages:bot.track.tryDivider', { number: String(which), date })}</span>
      </div>
    );
  };
  return (
    <aside
      ref={paneRef}
      className="messages-reply-pane platform-kb-column dc-lift dc-lift-session"
      style={replyWidth != null ? { '--messages-reply-width': `${replyWidth}px` } as CSSProperties : undefined}
      aria-label={t('messages:replies.paneName')}
      data-reply-thread={rootId}
    >
      {/* #5691: the divider between the chat and this thread, dragged to
          trade room between them (and stepped by the arrow keys). It is
          drawn from 768px up only, where the two panes sit side by side. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('messages:replies.resize')}
        aria-valuenow={replyWidth != null ? Math.round(replyWidth) : undefined}
        aria-valuemin={REPLY_MIN_WIDTH}
        tabIndex={0}
        className="messages-reply-resizer"
        data-reply-resizer=""
        onPointerDown={onReplyResizeStart}
        onKeyDown={onReplyResizeKey}
      />
      <header className="messages-thread-header" data-reply-head={inMain ? 'main' : undefined}>
        {inMain && onBack ? (
          <button type="button" className="messages-thread-action messages-thread-back" data-reply-back=""
            aria-label={t('messages:ai.drawer.back')} title={t('messages:ai.drawer.back')} onClick={onBack}>
            <ChevronLeftIcon aria-hidden="true" />
          </button>
        ) : null}
        {inMain ? (
          // 1 Nov 2026: the thread alone in Main Chat's place, under its own
          // name and the line that says it is theirs alone.
          <div className="min-w-0 flex-1">
            <div className="messages-thread-name min-w-0 truncate" data-reply-title="">{mainTitle}</div>
            <div className="messages-thread-sub flex min-w-0 items-center gap-1" data-private-thread-sub="">
              <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('messages:ai.thread.sub')}</span>
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="messages-thread-name flex min-w-0 items-center gap-2">
              {request && !request.firstVersion ? <RequestTag number={request.number} size="head" /> : null}
              <span className="min-w-0 truncate">{started ? startedThreadTitle(t, started.changeKind) : request ? botThreadTitle(request) : t('messages:replies.title')}</span>
            </div>
            {where ? <div className="messages-thread-sub">{where}</div> : null}
          </div>
        )}
        {/* #6071: in a design thread, the way to its preview: on a phone the
            switch back to it. 1 Nov 2026 (C1): in Main Chat's column, any
            thread holding a design (a version said anywhere in it) has
            Preview, which opens the design as the tab's own column
            (../ai/preview.ts), while it is not open already. */}
        {isDesignRoot(root) && !snap.route.embedded ? <DesignViewSwitch onView={setDesignView} /> : null}
        {inMain && preview?.rootId !== rootId && isDesignThread(root, replies) ? (
          <button type="button" className="messages-thread-action messages-thread-preview" data-reply-preview=""
            onClick={() => openPreview({ conversationId, rootId, version: null })}>
            <span className="text-[13px] font-semibold">{t('messages:design.pane.showPreview')}</span>
          </button>
        ) : null}
        {/* On a phone the Messages screen's header bar has the way back
            (app.css hides this one there, polish N16). In Main Chat's column
            the thread is the column's: Main Chat is a row of the list. */}
        {inMain ? null : (
          <button type="button" className="messages-thread-action" data-reply-close="" aria-label={t('messages:replies.close')} title={t('messages:replies.close')} onClick={() => closeThread()}>
            <XIcon aria-hidden="true" />
          </button>
        )}
      </header>
      {/* Its head says it is theirs alone in Main Chat's column; under it,
          where it went once it was filed or posted. */}
      {privateMine && !(inMain && privateWhere?.state === 'open') ? <PrivateThreadNote where={privateWhere} /> : null}
      <div ref={scroller} className="messages-thread-scroll messages-reply-scroll platform-safe-scroll chat-transcript" aria-live="polite">
        {/* The root's Reply quotes it into THIS thread's composer (#2387): its
            own threadRootId is null, being the main stream's message. */}
        {root ? <MessageRow message={{ ...root, thread: null, threadRootId: rootId }} conversationId={conversationId} channels={channels} kind={kind} inThread botChat={botChat} /> : null}
        {pieces.map((item) => <MessageRow key={item.clientKey || item.id} message={{ ...item, thread: null, threadRootId: rootId }} conversationId={conversationId} channels={channels} kind={kind} inThread botChat={botChat} focused={flashId === item.id} />)}
        {/* An error stands in place of the thread (#5219 review): with one,
            the count line would say "No replies yet", which is a different
            answer to the same question, so it waits. */}
        {thread?.error ? null : (
          <div className="messages-reply-count" aria-hidden={!merged.length}>
            <span>{merged.length ? t('messages:replies.count', { count: merged.length }) : thread?.loading ? t('messages:replies.loading') : t('messages:replies.none')}</span>
          </div>
        )}
        {thread?.loading && !merged.length && !thread.error ? <ReplyRowSkeleton /> : null}
        {(thread?.nextBefore || discussion?.more) ? (
          <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 py-2">
            {thread?.nextBefore ? <button type="button" disabled={thread.loading} onClick={() => void loadOlderReplies()} className="messages-load-older">{thread.loading ? t('messages:replies.loadingEarlier') : t('messages:replies.loadEarlier')}</button> : null}
            {discussion?.more ? <a className="messages-load-older" href={issueRefHref(discussion.appSlug, String(discussion.issueNumber))}>{t('messages:replies.discussion.more')}</a> : null}
          </div>
        ) : null}
        {thread?.error ? <div className="messages-state messages-state-error"><p>{thread.error}</p><button type="button" onClick={() => void loadReplyThread(conversationId, rootId, true)}>{t('core:common.tryAgain')}</button></div> : null}
        {merged.map((entry) => {
          const divider = tryDivider(entry.message.createdAt);
          if (entry.kind === 'discussion') {
            const row = <DiscussionRow key={`discussion-${entry.message.id}`} message={entry.message} appSlug={discussion.appSlug} issueNumber={discussion.issueNumber} />;
            return divider ? <Fragment key={`discussion-${entry.message.id}`}>{divider}{row}</Fragment> : row;
          }
          const { message } = entry;
          const grouped = !!previous && previous.kind === 'reply' && !previous.message.failed && !message.failed
            && groupsWithPrevious(
              { author: previous.message.sender.id, at: previous.message.createdAt },
              { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
            );
          previous = entry;
          const row = <MessageRow key={message.clientKey || message.id} message={{ ...message, threadRootId: message.threadRootId || rootId }} conversationId={conversationId} grouped={grouped && !divider} channels={channels} kind={kind} inThread botChat={botChat} focused={flashId === message.id} planCardId={cardId && isPlanMessage(message) ? cardId : null} />;
          return divider ? <Fragment key={message.clientKey || message.id}>{divider}{row}</Fragment> : row;
        })}
        {threadWorking ? <BotWorkingCard typist={threadWorking} /> : null}
        {privateRoot && privateMine && root ? (
          <PrivateThreadDoors
            rootId={privateRoot}
            text={privateThreadWords(root, replies, meId)}
            where={privateWhere}
            botReplied={replies.some((message) => message.sender.bot)}
          />
        ) : null}
      </div>
      <JumpToLatest scroller={scroller} />
      {/* 31 Oct 2026: who is typing in this thread (the bot answering a
          message written here among them), as the conversation's own line
          says it. It was drawn beside the conversation alone, which a phone
          hides while a thread is open. Under Jump to latest, as in every
          chat (1 Nov 2026). */}
      <ChatStatusLine className="messages-typing">{typingLine(t, threadTyping)}</ChatStatusLine>
      <MessageComposer threadRootId={rootId} />
    </aside>
  );
}

/**
 * A reply thread beside an app's channel (#2387) — the same side sheet as a
 * conversation's, filled the way the channel itself is: by the group chat
 * (public/js/group-chat.js), which owns the app chat's transcript, composer,
 * drafts, @ and # menus and its socket. `GroupChat.mountThread` puts a
 * thread's shell and transcript into this host, exactly as it does for an
 * issue's or a proposal's own discussion; this pane is the frame around it.
 *
 * It waits for the channel: the module can only mount a thread for the app
 * it is connected to, and that is the channel pane's to establish.
 */
function AppReplyThreadPanel({ slug, rootId }: { slug: string; rootId: number }) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const context = snap.discussionContext;
  const ready = !!context && context.slug === slug;
  const handle = snap.discussions.find((item) => item.slug === slug)?.channel || null;
  const back = `#messages/app/${encodeURIComponent(slug)}`;
  return (
    <AppReplyThreadPane
      slug={slug}
      rootId={rootId}
      ready={ready}
      readOnly={ready ? context.readOnly : true}
      where={handle ? `#${handle}` : (ready ? context.name : slug)}
      close={(
        <a className="messages-thread-action" href={back} aria-label={t('messages:replies.close')} title={t('messages:replies.close')}>
          <XIcon aria-hidden="true" />
        </a>
      )}
    />
  );
}

/**
 * The pane itself, for the two places an app channel's reply thread opens:
 * beside the channel here, and beside it in its project page's Discussion
 * tab (#3653, ../dev-board/workshop/project-discussion.tsx), which closes it
 * in place rather than by an address. `ready` holds the mount until the
 * caller knows whether the viewer may write.
 */
export function AppReplyThreadPane({ slug, rootId, ready, readOnly, where, close }: {
  slug: string;
  rootId: number;
  ready: boolean;
  readOnly: boolean;
  where: string;
  close: ReactNode;
}) {
  const t = useMessages('messages');
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return undefined;
    const chat = (window as any).GroupChat;
    let live = true;
    let tries = 0;
    let timer = 0;
    const mount = () => {
      if (!live) return;
      // The channel pane connects the module a macrotask after it mounts;
      // wait for it rather than connecting a second time from here.
      if (chat?.appSlug !== slug && tries < 40) { tries += 1; timer = window.setTimeout(mount, 50); return; }
      chat?.mountThread?.({
        type: 'message',
        ref: rootId,
        container: el,
        fullHeight: true,
        readOnly,
        placeholder: translate('messages:replies.app.placeholder'),
        notice: translate('messages:replies.app.membersOnly'),
      });
    };
    timer = window.setTimeout(mount, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      const list = el.querySelector('#gc-thread-messages');
      if (list) (window as any).UsernodeReact?.groupChat?.unmountTranscript?.(list);
      unmountLegacyPortal(el);
      if (chat?.activeThread?.type === 'message' && Number(chat.activeThread.ref) === rootId) chat.unmountThread?.();
    };
  }, [slug, rootId, ready, readOnly]);
  return (
    <aside className="messages-reply-pane messages-reply-pane-app" aria-label={t('messages:replies.paneName')} data-reply-thread={rootId}>
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">{t('messages:replies.title')}</div>
          <div className="messages-thread-sub">{where}</div>
        </div>
        {close}
      </header>
      {/* The host's class string is constant and its subtree is the group
          chat's — the one-owner rule, satisfied at this boundary. */}
      <div ref={host} className="messages-reply-host flex-1 min-h-0" />
    </aside>
  );
}

/**
 * A conversation drawn IN ITS COMMUNITY'S PAGE (#3494): #general, on
 * Homeroom's Discussion tab (features/dev-board/workshop/project-discussion.tsx).
 *
 * Every other project's Discussion tab mounts its own chat in place, under
 * the page's header and tabs. #general is a conversation of this store
 * rather than an app chat, so it went to the Messages screen instead, which
 * swapped the header, the tabs and the tint for Messages' own (#3491). This
 * is the same thread, composer and reply threads, mounted in the page:
 * while `active` it holds the store's one route (`embed`), and it gives it
 * back when it leaves the screen or unmounts (`release`). The Messages
 * screen takes the store back whenever it opens — its route() replaces an
 * embedded one — and the effect below re-embeds once it has closed again.
 *
 * `messages-layout` carries the thread's surface tokens; it is not this
 * screen's strip, so none of the strip's own classes come with it.
 */
/**
 * A room on its way, as the room says it itself (ConversationThread's own
 * loading row, in its scroller). A project's channel shows it from its first
 * frame until its messages are in, so the channel loads in one state rather
 * than a card skeleton, then "#general" over "Loading messages…", then its
 * messages (polish board #19).
 */
export function ChannelLoading(): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="messages-thread-scroll" data-channel-loading="">
      <div className="messages-state"><span className="messages-spinner" />{t('messages:thread.loading')}</div>
    </div>
  );
}

export function EmbeddedConversation({ conversationId, active, at = null, mainChat = false, onBack = null }: {
  conversationId: number;
  active: boolean;
  /**
   * 31 Oct 2026: this copy is Main Chat on the AI tab, a column of 400 to
   * 720px (or a phone's drawer): a thread opened in it covers the chat
   * rather than squeezing in beside it. 1 Nov 2026: alone, under its own
   * head (ReplyThreadPanel `inMain`).
   */
  mainChat?: boolean;
  /** A phone's drawer: the thread's back arrow, to the tab's list. */
  onBack?: (() => void) | null;
  /**
   * #3653: where a door into the room asked to land — a reply thread, or a
   * message. Each one is taken ONCE, when the room is put in place or at
   * once if it already is: a room put back later (the page shown again)
   * opens as the reader left it, not at a door they followed before.
   */
  at?: { threadRootId: number | null; focusMessageId: number | null } | null;
}) {
  const snap = useMessagesSnapshot();
  const here = !!snap.route.embedded && snap.route.conversationId === conversationId;
  const messagesOpen = snap.route.open;
  const atRef = useRef(at);
  atRef.current = at;
  const taken = useRef<typeof at>(null);
  const take = () => {
    const next = atRef.current && atRef.current !== taken.current ? atRef.current : null;
    if (next) taken.current = next;
    return next;
  };
  useEffect(() => {
    if (!active || messagesOpen) return undefined;
    embed(conversationId, take());
    return () => release(conversationId);
  }, [active, messagesOpen, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active || messagesOpen) return;
    const next = take();
    if (next) embed(conversationId, next);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  // #6071 follow-up: a blank thread from Homeroom bot's "+", in the thread's place.
  const blank = useNewThread(conversationId) && here && !snap.route.threadRootId;
  return (
    <div className={`messages-layout messages-layout-embedded${here && (snap.route.threadRootId || blank) ? ' messages-has-reply-thread' : ''}${blank ? ' messages-has-blank-thread' : ''}`} data-main-chat={mainChat ? '' : undefined}>
      {here ? <ConversationThread embedded /> : <ChannelLoading />}
      {here && snap.route.threadRootId ? <ReplyThreadPanel inMain={mainChat} onBack={onBack} /> : null}
      {blank ? <NewThreadPanel conversationId={conversationId} /> : null}
    </div>
  );
}

export function MessagesScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const snap = useMessagesSnapshot();
  const designView = useDesignView();
  useVisibilityHiddenClass(screenRef, 'messages-screen', false);
  useEffect(() => initializeMessagesStore(), []);
  // THE CHANGES HALF OF THIS INBOX ASKS FOR ITSELF (#2770). The Improve store's list
  // is prefetched once per page when an app target is published, which a
  // viewer who lands on Messages first may not have had — and a list read
  // once at boot is stale by the time the inbox is opened. So opening
  // Messages reads it again; while it stays open, Improve's own
  // onSessionStateChanged keeps it fresh (it asks whether Messages is on
  // screen). Signed-in only: the endpoint is per-user, and a 401 in the
  // network log is a console error on the route.
  useEffect(() => {
    if (!snap.route.open || !window.App?.user) return;
    void Promise.resolve(Improve.loadSessions()).catch(() => {});
  }, [snap.route.open]);
  // #3407: and again when #general's hub becomes known (store.ts).
  useEffect(() => followPlatformSlug(), []);
  useEffect(() => { if (snap.route.open) syncChrome(); },
    // The DISCUSSION's two facts belong here for the same reason the
    // conversation's title does: on a phone this is what names the thread in
    // the bar and puts the chevron back to the list. Without them, opening a
    // discussion kept the previous thread's name.
    [snap.active?.title, snap.route.open, snap.route.conversationId,
      snap.route.appSlug, snap.route.agent, snap.discussionContext?.name, snap.route.threadRootId]);
  // #2387: full width applies to any open discussion — a conversation, an
  // app channel, or an agent thread (every one carries the toggle). With
  // nothing open the list is there: it is the only thing to show. Reply
  // threads hang off conversations and channels alone.
  const chatOpen = !!(snap.route.conversationId || snap.route.appSlug);
  const discussionOpen = chatOpen || !!snap.route.agent;
  // A CHANNEL OPENS FULL WIDTH. It is its community's room, reached from the
  // community's hub, and the list beside it is people and agents — a column
  // of other things beside a room that is not in it. So there is no list
  // for it to sit beside, whatever the full-width preference says.
  const channelOpen = !!snap.route.appSlug
    || (!!snap.route.conversationId && snap.active?.id === snap.route.conversationId && snap.active?.kind === 'channel');
  // THE PHONE'S DRAWER (./phone-drawer.tsx): the list and a conversation
  // with people side by side, panned between, the last conversation peeking;
  // an agent chat or an agent session takes the conversation's place.
  const agentWords = useAgentThreadWords(snap.route.agent);
  const drawer = useMessagesDrawer(layoutRef, snap.route, snap.active, snap.messages, threadWords, agentWords);
  const drawerClass = drawer.on ? ` messages-drawer${drawer.level === 0 && !drawer.peek ? ' messages-drawer-alone' : ''}` : '';
  // v3 (18 Oct 2026): ON A DESKTOP THE LIST IS IN THE SIDEBAR, nested under
  // Messages (./rail-inbox.ts), so one pane is drawn at a time: the open
  // conversation alone, or with nothing open the whole list as the page
  // (All messages), with its search and previews. No back arrow between
  // them: the sidebar's rows are the way.
  const sidebarRows = useSidebarRows();
  const railClass = sidebarRows && !drawer.on ? (discussionOpen ? ' messages-list-in-rail' : ' messages-list-page') : '';
  // #6071: a design thread draws its preview in the conversation's place
  // (./design-pane.tsx); on a phone the preview and the thread take turns.
  const designRootId = snap.route.conversationId && snap.route.threadRootId && !snap.route.embedded ? snap.route.threadRootId : null;
  const designRoot = designRootId
    ? (snap.thread?.rootId === designRootId ? snap.thread.root : null) || snap.messages.find((item) => item.id === designRootId) || null
    : null;
  const designOpen = !!designRootId && isDesignRoot(designRoot);
  const designClass = designOpen ? ` messages-has-design messages-design-view-${designView}` : '';
  // #6071 follow-up: a blank thread from Homeroom bot's "+", in the thread's place.
  const blankThread = useNewThread(snap.route.conversationId) && !snap.route.threadRootId && !snap.route.embedded;
  const layout = `messages-layout dc-lift dc-lift-strip${(snap.listCollapsed && discussionOpen) || channelOpen ? ' messages-list-collapsed' : ''}${chatOpen && (snap.route.threadRootId || blankThread) ? ' messages-has-reply-thread' : ''}${railClass}${drawerClass}${designClass}`;
  // No background of its own: the route paints the wallpaper (the
  // body:has(#messages-screen) rules in app.css), and the two frosted planes
  // need a transparent ancestor chain to have anything to blur.
  return (
    <>
      <main ref={screenRef} id="messages-screen" className="hidden flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
        <div ref={layoutRef} className={layout} data-messages-drawer={drawer.on ? drawer.level : undefined} {...(drawer.handlers || {})}>
          <ConversationList drawer={drawer.on} litId={drawer.peek ? drawer.peek.conversation.id : null} />
          {drawer.peek ? <ConversationPeek peek={drawer.peek} /> : <ConversationThread />}
          {designOpen && snap.route.conversationId && designRootId ? (
            <DesignPane conversationId={snap.route.conversationId} rootId={designRootId} view={designView} onView={setDesignView} />
          ) : null}
          {snap.route.conversationId && snap.route.threadRootId && !snap.route.embedded ? <ReplyThreadPanel /> : null}
          {blankThread && snap.route.conversationId ? <NewThreadPanel conversationId={snap.route.conversationId} /> : null}
          {snap.route.appSlug && snap.route.threadRootId ? <AppReplyThreadPanel slug={snap.route.appSlug} rootId={snap.route.threadRootId} /> : null}
        </div>
      </main>
      <CreateConversationDialog />
      <ConversationMembersDialog />
      <ShareItemDialog />
      <ShareToDialog />
    </>
  );
}

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.messages = messagesController;
}

export { messagesController };
