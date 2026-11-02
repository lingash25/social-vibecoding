import { memo, useRef, useState } from 'react';

import {
  BookmarkIcon, BookmarkSolidIcon, CopyIcon, DownloadIcon, DraftTrashIcon, EnvelopeIcon, FlagIcon, LinkIcon, NoSymbolIcon,
  PencilSquareIcon, ReplyArrowIcon, ThreadIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { openReport } from '../dialogs/report';
import {
  deleteMessage, discardFailed, edit, markUnread, messageAddress, openThread, react, retrySend, scopeKey, setReply,
  setUserBlocked, toggleSaved,
} from './store';
import type { ConversationKind, ConversationMessage, DiscussionMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar, senderName } from './format';
import { issueRefHref } from './channels';
import { isActivityMessage } from './bot-activity';
import { BotCardOrTrack } from './bot-track';
import { BotQuestion, botMeta } from './bot-question';
import { BotPlanCard, BotTwoQuestions, isPlanMessage, isTwoQuestions } from './bot-plan';
import { BotThanksCard, isThanksMessage } from './bot-thanks-card';
import { BotReadyCard, isReadyMessage } from './bot-ready';
import { alsoInChat, botRequestNames, botThreadLabel, threadsAllowed, type ChangeBlock } from './bot-shared';
import { openRequestPage, requestPageOf } from './request-page';
import { BotHeadWords, botHead, isHeadCard } from './bot-head-card';
import { DesignVersionCard, designVersionOf } from './design-card';
import { BotRichCard, botCardOf } from './bot-cards';
import { BotLookedLine } from './bot-looked';
import { LinkEmbeds } from './link-cards';
import { plainText } from './plain-text';
import { confirmAction } from '../../lib/confirm';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { messageStamp, timeOfDay } from '../../lib/timestamp';
import { MessageActionBar, MessageMenu, placementFor, type MenuItem } from '../message-actions/action-bar';
import { MessageActionSheet, useLongPress } from '../message-actions/action-sheet';
import { absoluteLink, copyToClipboard, toast } from '../message-actions/clipboard';
import { EmojiPicker } from '../message-actions/emoji-picker';
import { ImageViewer, openInViewer } from '../image-viewer/image-viewer';
import { downloadLabel, downloadableImages, saveImages, useCanSaveImage } from '../image-viewer/save-image';
import { rememberReaction, useRecentReactions } from '../message-actions/recents';
import { ThreadSummaryChip } from '../message-actions/thread-summary';
import { useDismiss } from '../message-actions/use-dismiss';

/*
 * A CONVERSATION HAS SIDES (#5680). A direct message and a group chat — the
 * two-or-more-people conversations, the bot's chat among them — draw each
 * message on its sender's side: yours on the right in the accent tint and
 * without your face, everyone else's on the left in the plain surface with
 * their avatar, name and time, each in a bubble. The side says who is
 * speaking, so the transcript is read rather than decoded.
 *
 * A CHANNEL KEEPS ITS NAMED ROWS (#2783). #general and every project and
 * topic channel is not a conversation between a few people but a room, so a
 * row there stays the flat named row — square avatar, bold name, muted time —
 * whoever said it. So do the bot's cards, plans, questions, step lines and
 * change blocks wherever they land: they are not something a person said, and
 * a bubble would clip them.
 *
 * CONSECUTIVE MESSAGES GROUP. A message from the same person, close behind
 * their previous one (`groupsWithPrevious`, @/components/ui/chat.tsx — the app
 * chat uses the same rule), drops its avatar and name and becomes a
 * continuation line, with its time in the gutter where the avatar would be.
 *
 * THE CONTROLS ARE ONE BAR (#2387): ../message-actions/action-bar.tsx — the
 * three recent reactions, the picker, Reply, Save and ⋯ — on hover with a
 * pointer, and the same acts in a sheet on a long press on a phone. ⋯ holds
 * the rarer ones: the thread, edit, copy, the link, mark unread, delete,
 * report and block. Report message opens the shared reporting dialog
 * (../dialogs/report.tsx), which feeds the platform's one moderation queue
 * rather than an inline form of its own (issue #2721).
 */

function Attachment({ attachment }: { attachment: ConversationMessage['attachments'][number] }) {
  const t = useMessages('messages');
  const image = attachment.contentType.startsWith('image/');
  const html = attachment.contentType === 'text/html' || /\.html?$/i.test(attachment.name);
  // #3286: a plain tap opens the picture in the app's own viewer, which has
  // a way out (../image-viewer/image-viewer.tsx).
  const [viewing, setViewing] = useState(false);
  return (
    <div className="messages-attachment">
      {image ? <a href={attachment.url} target="_blank" rel="noopener noreferrer" data-image-open="" onClick={(event) => openInViewer(event, () => setViewing(true))}><img src={attachment.url} alt={attachment.name} loading="lazy" /></a> : <span className="messages-file-icon" aria-hidden="true">{html ? '</>' : '↓'}</span>}
      {viewing ? <ImageViewer src={attachment.url} alt={attachment.name} onClose={() => setViewing(false)} /> : null}
      <div className="min-w-0 flex-1"><a className="font-medium truncate block" href={attachment.url} download>{attachment.name}</a><span>{fileSize(attachment.size)}</span></div>
      {html && attachment.viewUrl ? <a className="messages-attachment-view" href={attachment.viewUrl} target="_blank" rel="noopener noreferrer">{t('messages:row.attachmentPreview')}</a> : null}
    </div>
  );
}

/*
 * MEMOIZED. The Messages store publishes one snapshot for everything, so any
 * publish — the inbox reloading, someone else's typing ping — re-rendered the
 * open transcript and every row in it. A row's inputs are its props: the
 * message objects keep their identity across publishes that do not touch the
 * transcript, and the channel set is shared (store.ts `handleSetFor`), so a
 * row whose message did not change skips the render.
 */
export const MessageRow = memo(function MessageRow({
  message,
  conversationId,
  grouped = false,
  channels,
  kind = 'group',
  inThread = false,
  threadOpen = false,
  focused = false,
  planCardId = null,
  hidePrompts = false,
  block = null,
  botChat = false,
}: {
  message: ConversationMessage;
  conversationId: number;
  /** A continuation of the same person's previous message. */
  grouped?: boolean;
  /** The viewer's channel handles, so `#name` in the body links (#2783). */
  channels?: ReadonlySet<string>;
  /** The conversation's kind: a DM has no threads (#2387), but for the chat with Homeroom bot (`botChat`). */
  kind?: ConversationKind;
  /** Drawn inside a reply thread — no thread of its own, no "mark unread". */
  inThread?: boolean;
  /** The thread that hangs off this message is the one open beside it. */
  threadOpen?: boolean;
  /** The message a link pointed at — flashed once (#2387). */
  focused?: boolean;
  /** #4046: a plan's request's activity card, whose step the plan carries (./bot-plan.tsx planLayout). */
  planCardId?: number | null;
  /** #4046: a plan or a question offers its own answers, so questions to tap give way. */
  hidePrompts?: boolean;
  /**
   * #4564: this row's part of its change's outlined block, in the chat with
   * Homeroom bot (./bot-shared.ts changeBlocks, ./index.tsx). Null anywhere
   * else, and for a bot message about no request: those draw as before.
   */
  block?: ChangeBlock | null;
  /**
   * One request, one story: the row is in the viewer's chat with Homeroom
   * bot, the one direct chat with threads (./bot-shared.ts threadsAllowed):
   * each request's card is the root of its thread.
   */
  botChat?: boolean;
}) {
  const t = useMessages('messages');
  const mine = Number(typeof window !== 'undefined' ? window.App?.user?.id : 0) === message.sender.id;
  // #4655: in a direct message people are named bare ("ada", not "@ada"),
  // everywhere this row names someone — its author line, a quote, the sheet
  // and the Block and Report labels. Group chats and channels keep the @.
  const bare = kind === 'direct';
  const [picker, setPicker] = useState<'above' | 'below' | null>(null);
  const [menu, setMenu] = useState<'above' | 'below' | null>(null);
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const recents = useRecentReactions();
  // #1408: the edit box grows with the message being edited, same as the
  // composer it visually replaces.
  const editRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editRef, editValue);

  const live = !message.deleted && !message.pending && !message.failed && message.id > 0;
  // Threads where the chat keeps them (./bot-shared.ts threadsAllowed). In
  // the chat with Homeroom bot a thread is a request's: it hangs off the
  // request's card (or a message that already has one), and a moment the
  // main chat also shows (`alsoInChat`) opens the thread it was posted in.
  const threads = threadsAllowed({ kind, homeroomBot: botChat });
  // 31 Oct 2026: in the chat with Homeroom bot a request's story is the
  // request's own page (./request-page.ts), so its news opens that and has
  // no thread here: no Reply in thread, no "N updates in its thread".
  const story = botChat && kind === 'direct' && !inThread ? requestPageOf(message) : null;
  const threadRoot = !live || inThread || !threads || story ? null
    : message.threadRootId ? message.threadRootId
      : kind !== 'direct' || isActivityMessage(message) || message.thread ? message.id : null;
  const canThread = threadRoot !== null;
  // The label over such a moment: "↳ in Dark mode · Plant Pal".
  const inChatLabel = !inThread && threads && alsoInChat(message) && message.sender.bot
    ? botThreadLabel(botRequestNames(botMeta(message))) : null;
  // A quiet step line in a request's thread ("Reading it.", "Built. Testing it…").
  const step = !!message.sender.bot && message.metadata?.homeroomBot?.kind === 'step';
  const scope = scopeKey(conversationId, inThread ? message.threadRootId : null);
  useDismiss(!!(picker || menu), [bar], () => { setPicker(null); setMenu(null); });
  // #4055: the message's pictures. In the app, whether its build can save
  // one is known only once asked; asking re-renders the row so the menu's
  // Download line can appear.
  const images = (message.attachments || []).filter((att) => att.contentType.startsWith('image/'));
  useCanSaveImage(images[0]?.url || '');
  const longPress = useLongPress(() => setSheet(true), { disabled: !live || editing });

  async function saveEdit() {
    const content = editValue.trim();
    if (!content || content === message.content) { setEditing(false); return; }
    setBusy(true); setNotice('');
    try { await edit(message.id, content); setEditing(false); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.edit')); }
    finally { setBusy(false); }
  }

  const reacted = (emoji: string) => message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted);

  async function toggle(emoji: string) {
    setPicker(null); setNotice('');
    try { await react(message.id, emoji); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.reaction')); }
  }

  // A pick from the full picker ADDS the reaction (and makes it recent); it
  // never takes one away, which is what the pill under the message is for.
  function pick(emoji: string) {
    rememberReaction(emoji);
    setPicker(null);
    if (!reacted(emoji)) void toggle(emoji);
  }

  async function save() {
    setNotice('');
    try { await toggleSaved(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.saved')); }
  }

  async function blockSender() {
    if (mine || !message.sender.id) return;
    // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
    const ok = await confirmAction({
      title: message.sender.unnamed ? (message.sender.id ? t('messages:row.block.titleUnknownHandle') : t('messages:row.block.titleUnknown')) : t('messages:row.block.title', { name: senderName(message.sender, { bare }) }),
      message: t('messages:row.block.message'),
      confirmLabel: t('messages:row.block.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setNotice('');
    try { await setUserBlocked(message.sender.id, true); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.block')); }
    finally { setBusy(false); }
  }

  async function remove() {
    const ok = await confirmAction({
      title: t('messages:row.delete.title'),
      message: t('messages:row.delete.message'),
      confirmLabel: t('messages:row.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    setNotice('');
    try { await deleteMessage(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.delete')); }
  }

  async function unread() {
    setNotice('');
    try { await markUnread(message.id); toast(t('messages:row.markedUnread')); }
    catch (err) { setNotice(err instanceof Error ? err.message : t('messages:row.error.unread')); }
  }

  function startEdit() { setEditValue(message.content); setEditing(true); }

  // The ⋯ menu, by whose message it is and what kind of chat it sits in.
  const items: MenuItem[] = [];
  if (threadRoot !== null) {
    items.push({ key: 'thread', label: message.thread || threadRoot !== message.id ? t('messages:row.menu.viewThread') : t('messages:row.menu.replyInThread'), icon: ThreadIcon, onSelect: () => openThread(threadRoot) });
  }
  if (mine && message.content && live) items.push({ key: 'edit', label: t('messages:row.menu.edit'), icon: PencilSquareIcon, onSelect: startEdit });
  if (message.content) {
    items.push({ key: 'copy', label: t('messages:row.menu.copyText'), icon: CopyIcon, onSelect: () => { void copyToClipboard(message.content, t('messages:row.textCopied')); } });
  }
  // #4055: its pictures onto the device, whoever sent them.
  const pictures = downloadableImages(images.map((att) => ({ src: att.url, name: att.name })));
  if (pictures.length) items.push({ key: 'download', label: downloadLabel(pictures.length), icon: DownloadIcon, onSelect: () => { void saveImages(pictures); } });
  items.push({
    key: 'link', label: t('messages:row.menu.copyLink'), icon: LinkIcon,
    onSelect: () => { void copyToClipboard(absoluteLink(messageAddress(conversationId, message.id)), t('messages:row.linkCopied')); },
  });
  if (!mine && !inThread) items.push({ key: 'unread', label: t('messages:row.menu.markUnread'), icon: EnvelopeIcon, onSelect: () => { void unread(); } });
  if (mine) {
    items.push({ key: 'delete', label: t('messages:row.menu.delete'), icon: DraftTrashIcon, danger: true, separated: true, onSelect: () => { void remove(); } });
  } else {
    items.push({
      key: 'report', label: t('messages:row.menu.report'), icon: FlagIcon, separated: true,
      onSelect: () => openReport({ targetType: 'conversation_message', target: message.id, label: message.sender.unnamed ? (message.sender.id ? t('messages:row.reportLabelUnknownHandle') : t('messages:row.reportLabelUnknown')) : t('messages:row.reportLabel', { name: senderName(message.sender, { bare }) }), userId: message.sender.id }),
    });
    if (message.sender.id) {
      items.push({ key: 'block', label: message.sender.unnamed ? (message.sender.id ? t('messages:row.menu.blockUnknownHandle') : t('messages:row.menu.blockUnknown')) : t('messages:row.menu.block', { name: senderName(message.sender, { bare }) }), icon: NoSymbolIcon, danger: true, disabled: busy, onSelect: () => { void blockSender(); } });
    }
  }

  // The phone's sheet: the bar's Reply and Save first, then the same menu.
  const sheetItems: MenuItem[] = [
    { key: 'reply', label: t('messages:row.sheet.reply'), icon: ReplyArrowIcon, onSelect: () => setReply(scope, message) },
    { key: 'save', label: message.saved ? t('messages:row.sheet.unsave') : t('messages:row.sheet.save'), icon: message.saved ? BookmarkSolidIcon : BookmarkIcon, onSelect: () => { void save(); } },
    ...items,
  ];

  // The time of day for today's messages, prefixed with the date once it is
  // not today's (#1808). `fullTime` on the title never elides.
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  // The gutter's clock on a continuation line: the time of day alone, since
  // the header above it already said which day.
  const shortTime = timeOfDay(message.createdAt);

  // The words, as markdown. A Homeroom bot message about a request names its
  // project, so its `#N` chips open that project's requests (#3770), and the
  // line naming what it is about is that thing's card (#4097,
  // ./bot-head-card.tsx), which is then not drawn again under the words.
  const head = botHead(message.content, botMeta(message));
  const objects = head ? message.objects.filter((object) => !isHeadCard(head, object)) : message.objects;
  // #4564: a row whose change block repeats the request drops its request
  // card — the top of the block already shows that request — and its words
  // carry the card's own label, spoken, in its place. Only on the plain
  // words path: a card standing in place of the words (thanks, activity,
  // plan, two questions, ready) keeps everything it draws, and the change's
  // own card in `objects` is never a repeat.
  const dropHead = !!block?.repeat && head?.kind === 'request' && !isThanksMessage(message)
    && !isActivityMessage(message) && !isPlanMessage(message) && !isTwoQuestions(message) && !isReadyMessage(message);
  // #4564: a repeated request's line goes without its card, and without the
  // line either — the top of its block already shows that card. `head` is
  // botHead's own fresh reading of this render's content, so the flag set
  // here is this row's alone; after `objects`, which must still filter the
  // card the message carries by it (a hidden head filters nothing).
  if (dropHead && head) head.hidden = true;
  const spokenLabel = dropHead && head
    ? (head.title
      ? t('messages:row.botBlock.requestLabel', { number: String(head.issueNumber), title: head.title })
      : t('messages:row.botBlock.requestLabelUntitled', { number: String(head.issueNumber) }))
    : null;
  const words = !message.content ? null : head
    ? <BotHeadWords head={head} objects={message.objects} channels={channels} />
    : <MessageMarkdown content={message.content} channels={channels} appSlug={botMeta(message)?.appSlug} requestColors={!!botMeta(message)} />;

  // #5680: which rows have a side. A DM and a group do; a channel does not
  // (#2783), and neither does a row that is not something a person said: the
  // bot's cards and plans, its step lines, a platform notice, and a change
  // block, whose outline runs edge to edge. `head` is the bot's line naming a
  // request or a change, drawn as that thing's card (./bot-head-card.tsx);
  // `question`/`actions` is its card with taps on it (./bot-question.tsx).
  const isCardMessage = isThanksMessage(message) || isActivityMessage(message) || isPlanMessage(message)
    || isTwoQuestions(message) || isReadyMessage(message) || !!head
    || (!!message.sender.bot && (message.metadata?.homeroomBot?.question || message.metadata?.homeroomBot?.actions?.length)
      && !isTwoQuestions(message) && !isReadyMessage(message));
  const sided = kind !== 'channel' && !block && !step && !message.system && !isCardMessage;

  // The quoted reply, the body and the inline editor: the part of the
  // message that stands as the row's text. A deleted message says so in its
  // place and nothing else (#2387).
  const body = message.deleted ? (
    <p className="messages-deleted">{t('messages:row.deleted')}</p>
  ) : (
    <>
      {message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>{senderName(message.reply.sender, { bare })}</span><p>{message.reply.deleted ? t('messages:row.quote.deleted') : plainText(message.reply.content) || t('messages:row.quote.attachment')}</p></button> : null}
      {/* Homeroom bot parity, P1: what the reply looked at, above its words (./bot-looked.tsx). */}
      {!editing ? <BotLookedLine message={message} /> : null}
      {editing ? (
        <div className="messages-edit"><textarea ref={editRef} dir="auto" aria-label={t('messages:row.editLabel')} value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>{t('core:common.save')}</button><button type="button" onClick={() => setEditing(false)}>{t('core:common.cancel')}</button></div></div>
      ) : isThanksMessage(message) ? (
        // #4392: the activity card Build it moved under a plan is the bot's
        // thanks: its words over the app's card and build line.
        <BotThanksCard message={message} words={words} />
      ) : isActivityMessage(message) ? (
        // #3736: the bot's activity card stands in place of its words, which
        // say the same for the inbox preview and the bell (./bot-activity.tsx).
        // #3770: a card with nothing on record keeps its words.
        // 16 Oct 2026: its request's track, where the viewer's bot work has
        // one (./bot-track.tsx).
        <>
          {/* B5: the bot's hello leads the first card it sends somebody. */}
          {message.metadata?.homeroomBot?.hello ? <p className="messages-bot-hello">{message.metadata.homeroomBot.hello}</p> : null}
          <BotCardOrTrack message={message} words={words} />
        </>
      ) : isPlanMessage(message) ? (
        // B6: a first version's plan, and two questions at once, stand in
        // place of their words too (./bot-plan.tsx).
        <BotPlanCard message={message} conversationId={conversationId} cardId={planCardId} />
      ) : isTwoQuestions(message) ? (
        <BotTwoQuestions message={message} conversationId={conversationId} />
      ) : isReadyMessage(message) ? (
        // B7: a change ready to try, with Try it, Approve and Change something.
        <BotReadyCard message={message} conversationId={conversationId} />
      ) : step && words ? (
        // One request, one story: a step line in its thread reads quietly.
        <div className="messages-bot-step text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-step="">{words}</div>
      ) : words}
    </>
  );

  // Everything a message carries besides its text: files, shared items,
  // reactions, the thread under it and the status line.
  // 1 Nov 2026: a version of the thread's design, said by the bot, drawn
  // small under its words with Open preview (./design-card.tsx).
  const designVersion = inThread && message.threadRootId && !message.deleted ? designVersionOf(message) : null;
  const extras = (
    <>
      {designVersion && message.threadRootId ? (
        <DesignVersionCard conversationId={conversationId} rootId={message.threadRootId} version={designVersion} title={message.metadata?.homeroomBot?.designTitle || null} />
      ) : null}
      {message.sender.bot && (message.metadata?.homeroomBot?.question || message.metadata?.homeroomBot?.actions?.length)
        && !isTwoQuestions(message) && !isReadyMessage(message)
        ? <BotQuestion message={message} conversationId={conversationId} hidePrompts={hidePrompts} /> : null}
      {/* Homeroom bot parity (P1-P9): a card the bot put under its reply (./bot-cards/). */}
      {botCardOf(message) ? <BotRichCard message={message} conversationId={conversationId} /> : null}
      {message.attachments.length ? <div className="messages-attachments">{message.attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}</div> : null}
      {objects.length ? <div className="messages-object-list">{objects.map((object, index) => <ObjectCard key={`${object.type}-${index}`} object={object} />)}</div> : null}
      {/* #3660: a link in the words to one of Homeroom's own pages, as the
          card it names — for this reader, and never one already above. */}
      {message.content && !message.moderated ? <LinkEmbeds text={message.content} exclude={message.objects} /> : null}
      {message.reactions.length ? <div className="messages-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-pressed={reaction.reacted} title={reaction.users ? listText(reaction.users) : undefined} onClick={() => void toggle(reaction.emoji)} className={reaction.reacted ? 'messages-reaction-mine' : ''}><span>{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div> : null}
      {message.thread && !inThread && kind === 'direct' && threads && !story ? (
        // One request, one story: in the chat with Homeroom bot the thread
        // under a request's card is its updates, said in words.
        <button
          type="button"
          className="mt-1.5 inline-flex items-center rounded-md text-[0.8125rem] font-semibold text-violet-700 hover:underline dark:text-violet-300"
          aria-pressed={threadOpen}
          data-bot-thread-link={message.id}
          onClick={() => openThread(message.id)}
        >{t('messages:row.botThread.updates', { count: message.thread.replyCount })}</button>
      ) : message.thread && !inThread && !story ? (
        <ThreadSummaryChip
          replyCount={message.thread.replyCount}
          lastReplyAt={message.thread.lastReplyAt}
          active={threadOpen}
          avatars={message.thread.participants.map((person) => <UserAvatar key={person.id} user={person} size="sm" shape="square" />)}
          lastReply={message.thread.lastReply ? {
            face: <span className="msgx-thread-face"><UserAvatar user={message.thread.lastReply.sender} size="sm" shape="square" /></span>,
            name: message.thread.lastReply.sender.username,
            ...(message.thread.lastReply.sender.unnamed ? { unnamed: 'unknown' as const } : {}),
            text: message.thread.lastReply.content,
          } : null}
          onOpen={() => openThread(message.id)}
        />
      ) : null}
      {notice ? <p role="status" className="mt-1 text-sm text-red-700 dark:text-red-400">{notice}</p> : null}
    </>
  );

  // The bar. WHILE A SEND IS IN FLIGHT it is still laid out, but invisible
  // and inert (#2907). A failed row has no bar — its Retry is its control —
  // and neither has a deleted one.
  const actions = !message.failed && !message.deleted ? (
    <MessageActionBar
      className={`messages-message-actions ${message.pending ? 'messages-message-actions-reserved' : ''}`}
      hidden={!!message.pending}
      // What useDismiss measures "outside" against: without it every press —
      // on a menu item or an emoji too — closed the popover before its click.
      barRef={bar}
      recents={recents}
      reacted={reacted}
      onReact={(emoji) => { void toggle(emoji); }}
      pickerOpen={!!picker}
      pickerButtonRef={pickerButton}
      onTogglePicker={() => { setMenu(null); setPicker((open) => (open ? null : placementFor(pickerButton.current, 430))); }}
      onReply={() => setReply(scope, message)}
      saved={!!message.saved}
      onToggleSave={() => { void save(); }}
      moreOpen={!!menu}
      moreButtonRef={moreButton}
      onToggleMore={() => { setPicker(null); setMenu((open) => (open ? null : placementFor(moreButton.current, items.length * 38 + 24))); }}
    >
      {picker ? <EmojiPicker placement={picker} onPick={pick} onClose={() => setPicker(null)} /> : null}
      {menu ? <MessageMenu items={items} placement={menu} onClose={() => { setMenu(null); moreButton.current?.focus({ preventScroll: true }); }} /> : null}
    </MessageActionBar>
  ) : null;

  const stateClasses = `${mine ? 'messages-message-self' : ''} ${message.saved ? 'messages-message-saved' : ''} ${message.pending ? 'messages-message-pending' : ''} ${message.failed ? 'messages-message-failed' : ''} ${message.deleted ? 'messages-message-deleted' : ''} ${focused ? 'messages-message-focus' : ''} ${message.system ? 'messages-message-system' : ''}`;

  // The state word a header carries — edited. A continuation line has no
  // header, so it carries it on a meta line of its own, beside nothing: the
  // time is already in the gutter.
  //
  // NO "sending…" (#2907). A message in flight says so by being faded
  // (app.css), which changes no line's height; the word came and went in a
  // line of its own on a continuation row and moved the transcript twice.
  const status = message.editedAt && !message.deleted ? <span title={fullTime(message.editedAt)}>{t('messages:row.edited')}</span> : null;

  // A send that failed says so under its text, with the two things to do
  // about it: send it again (the same idempotency key, so never twice) or
  // drop it. Its own line, not the header's: three more words beside the
  // name and time wrapped the header on a phone.
  const failedNote = message.failed ? <div className="messages-message-meta messages-message-failed-note" role="status">
    <span className="text-red-700 dark:text-red-400">{t('messages:row.notSent')}</span>
    {message.clientKey ? <button type="button" className="messages-retry" onClick={() => void retrySend(message.clientKey as string)}>{t('core:common.retry')}</button> : null}
    {message.clientKey ? <button type="button" className="messages-discard" onClick={() => discardFailed(message.clientKey as string)}>{t('messages:row.discard')}</button> : null}
  </div> : null;

  // #4564: the change block this row belongs to, as classes and data its
  // stylesheet draws its outline from. The article's own id, its
  // data-message-id and its existing classes are unchanged.
  const blockClass = block ? ` messages-bot-block messages-bot-block-${block.part}` : '';
  const blockAttrs = block ? { 'data-bot-block': block.key, 'data-bot-block-part': block.part } : {};

  return (
    <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message group ${sided ? 'messages-message-bubble ' : ''}${grouped ? 'messages-message-grouped' : ''}${blockClass} ${stateClasses}`} {...blockAttrs} {...longPress}>
      {/* #5680: your own message is already on its side — the tint and the
          right edge say whose it is — so it needs no face, as ChatMessageRow
          draws a turn (`from="me"`) in the general chat. A channel row keeps
          it: there the side says nothing. */}
      {grouped
        ? <time className="messages-message-gutter" dateTime={message.createdAt} title={fullTime(message.createdAt)}>{shortTime}</time>
        : sided && mine ? null : <UserAvatar user={message.sender} size="md" shape="square" />}
      <div className={block ? 'min-w-0 flex-1 messages-bot-block-body' : sided ? 'min-w-0 flex-1 messages-bubble-wrap' : 'min-w-0 flex-1'}>
        {grouped ? null : <div className="messages-message-head"><span dir="auto" className={`messages-message-author ${mine ? 'text-violet-700 dark:text-violet-300' : ''}`}>{senderName(message.sender, { bare })}</span>{message.sender.bot ? <span className="messages-bot-badge">{t('messages:row.aiBadge')}</span> : null}<time dateTime={message.createdAt} title={fullTime(message.createdAt)}>{time}</time>{status}</div>}
        {/* #4564: the dropped card's own label, spoken: a screen reader still
            hears which request these words are about, as the block's top
            shows. */}
        {dropHead ? <span className="sr-only">{spokenLabel}</span> : null}
        {inChatLabel && message.threadRootId ? (
          <button
            type="button"
            className="block max-w-full truncate text-start text-[0.8125rem] font-medium text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
            data-bot-thread-label={message.threadRootId}
            onClick={() => (story ? openRequestPage(story, conversationId) : openThread(message.threadRootId as number))}
          >{inChatLabel}</button>
        ) : null}
        {/* #5680: in a conversation the words sit in a bubble on their
            sender's side; the head above them, and everything under them
            (pictures, shared items, reactions, a thread) stays outside it. */}
        {sided ? <div className="messages-bubble" dir="auto">{body}</div> : body}
        {extras}
        {grouped && message.editedAt && !message.deleted ? <div className="messages-message-meta">{status}</div> : null}
        {failedNote}
      </div>
      {actions}
      <MessageActionSheet
        open={sheet}
        onClose={() => setSheet(false)}
        recents={recents}
        reacted={reacted}
        onReact={(emoji) => { void toggle(emoji); }}
        onPick={pick}
        items={sheetItems}
        preview={{ who: senderName(message.sender, { bare }), text: message.content }}
      />
    </article>
  );
});

/*
 * #5219: A message from the request's public discussion, shown inside a
 * request's thread in the chat with Homeroom bot. The same row a reply draws
 * (avatar, name, time, text), with no reaction, reply or menu: taking part
 * happens on the request page, and the line under the name is the way there.
 */
export const DiscussionRow = memo(function DiscussionRow({
  message,
  appSlug,
  issueNumber,
}: {
  message: DiscussionMessage;
  appSlug: string;
  issueNumber: number;
}) {
  const t = useMessages('messages');
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  return (
    <article id={`messages-discussion-${message.id}`} data-discussion-message-id={message.id} className="messages-message">
      <UserAvatar user={message.sender} size="md" shape="square" />
      <div className="min-w-0 flex-1">
        <div className="messages-message-head">
          <span dir="auto" className="messages-message-author">{senderName(message.sender, { bare: true })}</span>
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)}>{time}</time>
        </div>
        <a
          className="block max-w-full truncate text-start text-[0.8125rem] font-medium text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
          href={issueRefHref(appSlug, String(issueNumber))}
        >{t('messages:replies.discussion.from')}</a>
        {message.content ? <MessageMarkdown content={message.content} appSlug={appSlug} /> : null}
      </div>
    </article>
  );
});
