/**
 * Status, said once and the same way everywhere (the one-frame redesign,
 * docs/superpowers/specs/2026-11-08-one-frame-glass-spec.md, rules 2, 5, 6
 * and 8). Three pieces:
 *
 *   StatusPill  one word of status on a row, coloured by what it MEANS:
 *               `you` (blue: this waits for the viewer), `here` (navy: where
 *               you are), `done` (green), `waiting` (amber: on others),
 *               `problem` (red), `none` (grey text, no fill: a settled thing
 *               is not the loudest thing on screen). Zero or empty says
 *               nothing: the pill renders nothing at all.
 *   Track       the one line for progress — Plan, Build, Checks, Vote, Live —
 *               drawn the same wherever a request or a change appears.
 *   StatusRow   the one row: picture, name, one line, one status, in that
 *               order; 64px, or 50px for a single line.
 *
 * Colours come from the skin tokens (public/css/app.css "SKIN TOKEN
 * DEFAULTS"), so the same markup reads right under the standard look and
 * under glass. Every class is a complete literal (Tailwind's extractor).
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { useMessages } from '../../../src/lib/i18n/react';
import { ListRow, type ListRowProps } from './grouped-list';

export type Tone = 'you' | 'here' | 'done' | 'waiting' | 'problem' | 'none';

const pill = cva(
  'inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full text-[12px] font-semibold leading-none',
  {
    variants: {
      tone: {
        you: 'px-2.5 bg-[color:var(--fr-acc)] text-[color:var(--fr-acc-ink)]',
        here: 'px-2.5 bg-[color:var(--fr-lit-t)] text-[color:var(--fr-lit)]',
        done: 'px-2.5 bg-[color:var(--fr-ok-t)] text-[color:var(--fr-ok)]',
        waiting: 'px-2.5 bg-[color:var(--fr-wait-t)] text-[color:var(--fr-wait)]',
        problem: 'px-2.5 bg-[color:var(--fr-bad-t)] text-[color:var(--fr-bad)]',
        none: 'text-[color:var(--fr-mut)]',
      },
    },
    defaultVariants: { tone: 'none' },
  },
);

function saysNothing(children: React.ReactNode): boolean {
  return children === null || children === undefined || children === false
    || children === 0 || children === '' || (typeof children === 'string' && children.trim() === '');
}

export function StatusPill({ tone = 'none', className, children, ...props }: {
  tone?: Tone;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  if (saysNothing(children)) return null;
  return (
    <span data-tone={tone} className={cn(pill({ tone }), className)} {...props}>
      {children}
    </span>
  );
}

export const TRACK_STAGES = ['plan', 'build', 'checks', 'vote', 'live'] as const;
export type TrackStage = 0 | 1 | 2 | 3 | 4;
type StageState = 'done' | 'now' | 'wait' | 'problem' | 'live' | 'todo';

function stageState(index: number, stage: TrackStage, waiting: boolean, problem: boolean): StageState {
  if (index < stage) return 'done';
  if (index > stage) return 'todo';
  if (problem) return 'problem';
  if (waiting) return 'wait';
  // The last stop reached is the good news: green, like a finished bar.
  return index === 4 ? 'live' : 'now';
}

const STAGE_CLASS =
  'flex min-w-0 flex-col gap-2 text-[12px] font-semibold text-[color:var(--fr-faint)] '
  + "before:h-1 before:rounded-sm before:bg-[color:var(--fr-sunk)] before:content-[''] "
  + 'data-[state=done]:text-[color:var(--fr-mut)] data-[state=done]:before:bg-[color:var(--fr-mut)] '
  + 'data-[state=now]:text-[color:var(--fr-acc)] data-[state=now]:before:bg-[color:var(--fr-acc)] '
  + 'data-[state=wait]:text-[color:var(--fr-wait)] data-[state=wait]:before:bg-[color:var(--fr-wait)] '
  + 'data-[state=problem]:text-[color:var(--fr-bad)] data-[state=problem]:before:bg-[color:var(--fr-bad)] '
  + 'data-[state=live]:text-[color:var(--fr-ok)] data-[state=live]:before:bg-[color:var(--fr-ok)]';

export function Track({ stage, waiting = false, problem = false, mini = false, className }: {
  stage: TrackStage;
  waiting?: boolean;
  problem?: boolean;
  mini?: boolean;
  className?: string;
}) {
  const t = useMessages('changes');
  return (
    <ol
      data-track=""
      className={cn('grid min-w-0 grid-cols-5', mini ? 'w-16 shrink-0 gap-0.5' : 'gap-1', className)}
    >
      {TRACK_STAGES.map((key, i) => (
        <li key={key} data-stage={key} data-state={stageState(i, stage, waiting, problem)} className={cn(STAGE_CLASS, mini && 'gap-0')}>
          <span className={mini ? 'sr-only' : 'truncate'}>{t(`changes:track.${key}`)}</span>
        </li>
      ))}
    </ol>
  );
}

export interface StatusRowProps extends Omit<ListRowProps, 'trailing' | 'chevron'> {
  /** The one word of status, drawn as the row's one pill; nothing for zero. */
  status?: React.ReactNode;
  tone?: Tone;
  chevron?: boolean;
}

export const StatusRow = React.forwardRef<HTMLElement, StatusRowProps>(function StatusRow({
  status, tone = 'none', chevron = false, className, subtitle, ...props
}, ref) {
  return (
    <ListRow
      ref={ref}
      className={cn(subtitle ? 'min-h-[64px]' : 'min-h-[50px]', className)}
      subtitle={subtitle}
      chevron={chevron}
      trailing={<StatusPill tone={tone}>{status}</StatusPill>}
      {...props}
    />
  );
});
