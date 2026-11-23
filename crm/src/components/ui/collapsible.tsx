'use client';

import { ChevronRight } from 'lucide-react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn, focusRing } from './cn';

/*
 * C11: a foldable menu group (owner choice A: shadcn Collapsible 847, on the
 * Radix Collapsible inside the installed `radix-ui` package; nothing added).
 * The heading is a button with aria-expanded and aria-controls; the content
 * uses the hidden attribute while closed. No height animation (motion rule).
 *
 * Build plan 4.2 check: Radix Collapsible writes its size into a style value
 * (--radix-collapsible-content-height). It passed under the production style
 * policy: no style attribute in the server HTML (the values are empty until
 * script measures), and the browser sets them later through the CSSOM, which
 * the policy allows. tests/e2e/ui-gallery.e2e.ts proves this with one group
 * open and one closed on first load. For menu groups only; folds inside
 * pages use ui/fold.tsx (<details>).
 */
export function Collapsible({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  meta,
  children,
  className,
}: {
  /** Controlled: the group is open. */
  open?: boolean;
  /** Uncontrolled: open on first load. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The group heading words. */
  trigger: ReactNode;
  /** Small text beside the heading, e.g. the group's total count while folded. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <CollapsiblePrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} className={cn('group/collapsible font-sans', className)} data-slot="collapsible">
      <CollapsiblePrimitive.Trigger
        className={cn(
          'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-control border-0 bg-transparent px-2.5 text-left font-sans text-xs font-semibold text-quiet hover:bg-wash hover:text-ink',
          focusRing,
          'focus-visible:outline-offset-0',
        )}
      >
        <span className="min-w-0 flex-1">{trigger}</span>
        {meta ? <span className="shrink-0">{meta}</span> : null}
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 group-data-[state=open]/collapsible:rotate-90" />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="mt-0.5">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
