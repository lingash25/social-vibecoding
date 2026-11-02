// Homeroom bot parity (P1-P9): which component draws each card type
// (services/homeroom-bot-cards/index.js HANDLERS has the same types).

import type { ComponentType } from 'react';
import type { BotCardProps } from './index';
import { OptionsCard } from './options';
import { QuestionsCard } from './questions';
import { TableCard } from './table';
import { CompareCard } from './compare';
import { BatchCard } from './batch';
import { BuildNoteCard } from './build-note';
import { ChecksGreenCard } from './checks-green';
import { ConfirmCard } from './confirm';
import { GalleryCard } from './gallery';
import { InvestigationCard } from './investigation';

export const CARD_COMPONENTS: Readonly<Record<string, ComponentType<BotCardProps>>> = Object.freeze({
  options: OptionsCard, // P2
  questions: QuestionsCard, // P2
  table: TableCard, // P2
  compare: CompareCard, // P2, design threads
  batch: BatchCard, // P4
  build_note: BuildNoteCard, // P5
  checks_green: ChecksGreenCard, // P6
  confirm: ConfirmCard, // P7
  gallery: GalleryCard, // P8
  investigation: InvestigationCard, // P9
});
