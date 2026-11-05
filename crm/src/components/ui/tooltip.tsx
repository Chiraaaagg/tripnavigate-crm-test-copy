'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from './cn';

/**
 * Short hint on hover and keyboard focus (Radix Tooltip). Never put essential
 * information only in a tooltip; icon-only buttons still need aria-label.
 * Wrap the app (or the gallery) once in <TooltipProvider>.
 */
export function TooltipProvider({ children, delayDuration = 300 }: { children: ReactNode; delayDuration?: number }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  /** One focusable element (e.g. a Button). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 max-w-64 rounded-control bg-ink px-2.5 py-1.5 font-sans text-sm text-white shadow-raised',
            'data-[state=delayed-open]:animate-ui-fade-in data-[state=instant-open]:animate-ui-fade-in data-[state=closed]:animate-ui-fade-out motion-reduce:animate-none',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-ink" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
