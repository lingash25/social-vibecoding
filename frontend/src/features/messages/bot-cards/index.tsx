// Homeroom bot parity (P1-P9): the cards the bot puts under a reply beyond
// its request, change and project cards (types.ts HomeroomBotCard). One
// component per card type (./registry.ts); this picks it. A type this build
// does not know draws nothing, so an older tab never breaks on a newer card.
//
// A tap either says words as the person (sayAsMe: picking an option,
// answering a question set, which the bot then reads like anything they
// type) or is decided on the server (decideCard: a batch's Build them all, a
// confirm card, a gallery's Propose, an investigation's Stop), which updates
// the card on every device.

import type { ConversationMessage, HomeroomBotCard } from '../types';
import { cardAction } from '../api';
import { tapBotAction } from '../store';
import { CARD_COMPONENTS } from './registry';

export type BotCardProps<T extends HomeroomBotCard = HomeroomBotCard> = {
  message: ConversationMessage;
  conversationId: number;
  card: T;
};

/** The card under a bot message, or null when it has none of ours. */
export function botCardOf(message: ConversationMessage): HomeroomBotCard | null {
  if (!message.sender.bot || message.deleted) return null;
  const card = message.metadata?.homeroomBot?.card;
  return card && typeof card.type === 'string' && Object.prototype.hasOwnProperty.call(CARD_COMPONENTS, card.type) ? card : null;
}

/** Words said as the person, as if typed: in the thread the card is in. */
export function sayAsMe(message: ConversationMessage, words: string): Promise<void> {
  const label = String(words || '').trim();
  if (!label) return Promise.resolve();
  return tapBotAction(message, { id: 'card', label, style: 'secondary', type: 'prompt' });
}

/** A tap decided on the server, as the person; rejects with its words when refused. */
export function decideCard(message: ConversationMessage, action: string, value?: unknown): Promise<Record<string, unknown>> {
  return cardAction(message.id, action, value);
}

export function BotRichCard({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const card = botCardOf(message);
  if (!card) return null;
  const Component = CARD_COMPONENTS[card.type];
  return (
    <div className="messages-bot-card" data-bot-card={card.type}>
      <Component message={message} conversationId={conversationId} card={card} />
    </div>
  );
}
