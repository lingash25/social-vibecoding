/**
 * The one frame (docs/superpowers/specs/2026-11-08-one-frame-glass-spec.md,
 * rules 1, 3 and 4): every page is a title, one sentence saying what it is
 * for, at most one primary action, then a stack of labelled groups in a
 * 720px column with context in a 320px column beside it, which moves above
 * or below on a phone.
 *
 *   PageFrame   the header and the columns.
 *   Columns     720 / 320 from md; one column before, the side after the
 *               main (or before it with `sideFirst`).
 *   Group       a label over one surface: under glass a frosted pane with a
 *               ring and a glow, under the standard look the plane colour
 *               with its hairline (the tokens decide, see app.css "SKIN
 *               TOKEN DEFAULTS").
 *   PrimaryButton / QuietButton  the two buttons a page may carry.
 *
 * Spacing is logical (ps-/pe-/ms-/me-, start/end), so the frame mirrors in
 * a right-to-left language without a second set of rules. Every class is a
 * complete literal (Tailwind's extractor).
 */
import * as React from 'react';

import { cn } from '@/lib/utils';
import { SectionHeader } from './grouped-list';

const BUTTON = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap px-4 text-[14px] font-semibold leading-none transition-[transform,opacity] active:scale-[0.98] disabled:opacity-50';

export function PrimaryButton({ className, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(BUTTON, 'rounded-full bg-[color:var(--fr-acc)] text-[color:var(--fr-acc-ink)] [box-shadow:0_12px_24px_-12px_var(--fr-acc)]', className)}
      {...props}
    />
  );
}

export function QuietButton({ className, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(BUTTON, 'rounded-full bg-[color:var(--fr-surface)] text-[color:var(--fr-ink)] [box-shadow:inset_0_0_0_1px_var(--fr-ring)]', className)}
      {...props}
    />
  );
}

export function Columns({ main, side, sideFirst = false, className }: {
  main: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  className?: string;
}) {
  if (!side) {
    return <div className={cn('w-full min-w-0 max-w-[720px]', className)}>{main}</div>;
  }
  return (
    <div className={cn('grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,720px)_320px]', className)}>
      <div className="min-w-0">{main}</div>
      <aside className={cn('min-w-0', sideFirst && 'order-first md:order-none')}>{side}</aside>
    </div>
  );
}

export function Group({ label, action, children, id, className }: {
  label: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn('flex flex-col', className)}>
      <div className="flex items-baseline justify-between gap-4 pe-4">
        {/* The group's label: 13px at 650 in the muted ink, sentence case
            (spec rule 8), over the card-group label's own gutter. */}
        <SectionHeader className="normal-case tracking-normal text-[13px] font-[650] text-[color:var(--fr-mut)]">
          {label}
        </SectionHeader>
        {action ? <div className="shrink-0 pt-6 text-[13px] font-semibold text-[color:var(--fr-acc)]">{action}</div> : null}
      </div>
      <div className="overflow-hidden rounded-[24px] bg-[color:var(--fr-surface)] [backdrop-filter:var(--fr-blur)] [box-shadow:inset_0_0_0_1px_var(--fr-ring),var(--fr-glow)]">
        {children}
      </div>
    </section>
  );
}

export function PageFrame({ title, purpose, primary, tabs, children, side, sideFirst, className }: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  /** A string becomes the page's one PrimaryButton; an element is used as given. */
  primary?: React.ReactNode;
  tabs?: React.ReactNode;
  children: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-6 px-3 pb-12 pt-5 md:px-8', className)}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] md:text-[36px] font-bold tracking-[-0.035em] leading-[1.08] text-[color:var(--fr-ink)] [text-wrap:balance]">{title}</h1>
          {purpose ? <p className="mt-2 max-w-[60ch] text-[17px] leading-snug text-[color:var(--fr-mut)]">{purpose}</p> : null}
        </div>
        {primary ? (
          <div className="shrink-0">
            {typeof primary === 'string' ? <PrimaryButton>{primary}</PrimaryButton> : primary}
          </div>
        ) : null}
      </header>
      {tabs}
      <Columns main={children} side={side} sideFirst={sideFirst} />
    </div>
  );
}
