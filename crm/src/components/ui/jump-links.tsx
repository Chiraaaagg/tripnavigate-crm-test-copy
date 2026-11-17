'use client';

import { ArrowDown } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { buttonVariants } from './button';
import { cn, focusRing } from './cn';

/*
 * In-page jumps (C11, design plan O6/O7/O9). jumpTo(id) opens any closed
 * <details> fold around the target, scrolls it into view and moves keyboard
 * focus to it (a target that cannot take focus gets tabindex="-1"). The
 * scroll is instant under reduced motion. Without script the links are plain
 * "#id" anchors, so the browser still jumps.
 */

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
const JUMP_TARGET_CLASSES = ['scroll-mt-18', 'focus:outline-2', 'focus:outline-offset-4', 'focus:outline-solid', 'focus:outline-brand-strong'];

/** Moves to an element on the page and focuses it. Returns false when there is no such element. */
export function jumpTo(id: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(id.replace(/^#/, ''));
  if (!el) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
  }
  if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  if (!el.matches(FOCUSABLE)) {
    el.setAttribute('tabindex', '-1');
    // A visible ring where focus landed (the classes are generated from this file).
    el.classList.add(...JUMP_TARGET_CLASSES);
  }
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
  return true;
}

function onJump(event: MouseEvent<HTMLElement>, targetId: string) {
  // Modified clicks keep the browser's own behaviour (open in a new tab, and so on).
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (jumpTo(targetId)) event.preventDefault();
}

export interface JumpLink {
  /** id of the element to move to (without "#"). */
  targetId: string;
  label: ReactNode;
}

/** "Jump to: Rates · Payments · History" links under a page header. */
export function JumpLinks({ links, label = 'On this page', className }: { links: JumpLink[]; label?: string; className?: string }) {
  if (links.length === 0) return null;
  return (
    <nav aria-label={label} className={cn('mb-4 flex flex-wrap items-center gap-x-1 gap-y-1 font-sans text-sm', className)} data-slot="jump-links">
      <span className="mr-1 text-quiet">Jump to:</span>
      {links.map((link, i) => (
        <span key={link.targetId} className="inline-flex items-center gap-x-1">
          {i > 0 ? (
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          ) : null}
          <a
            href={`#${link.targetId}`}
            onClick={(e) => onJump(e, link.targetId)}
            className={cn(
              'rounded-chip px-1 py-0.5 font-medium text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep',
              focusRing,
            )}
          >
            {link.label}
          </a>
        </span>
      ))}
    </nav>
  );
}

/**
 * The page's one primary button when the next step is a control lower on the
 * same page (record header "Next:"). A link to "#id" styled as the primary
 * button: without script the browser jumps; with script focus moves too.
 */
export function JumpButton({ targetId, children, className }: { targetId: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(e) => onJump(e, targetId)}
      className={cn(buttonVariants({ variant: 'primary' }), 'h-auto min-h-10 py-2 whitespace-normal', className)}
      data-slot="jump-button"
    >
      {children}
      <ArrowDown aria-hidden="true" />
    </a>
  );
}
