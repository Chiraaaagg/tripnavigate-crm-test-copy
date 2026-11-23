'use client';

import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn, focusRing } from './cn';
import { overlayClass } from './dialog';

/**
 * Side drawer: a Radix Dialog anchored to the left or right edge (same focus
 * trap, Escape and focus return as Dialog). Used for the mobile navigation
 * and for detail panels.
 */
export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;
export const DrawerTitle = DialogPrimitive.Title;
export const DrawerDescription = DialogPrimitive.Description;

export function DrawerContent({
  side = 'right',
  className,
  children,
  closeLabel = 'Close',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'left' | 'right'; closeLabel?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-[min(24rem,calc(100vw-3rem))] flex-col overflow-y-auto bg-card font-sans text-base text-copy shadow-overlay outline-none',
          side === 'right'
            ? 'right-0 rounded-l-panel data-[state=open]:animate-ui-slide-in-right data-[state=closed]:animate-ui-slide-out-right'
            : 'left-0 rounded-r-panel data-[state=open]:animate-ui-slide-in-left data-[state=closed]:animate-ui-slide-out-left',
          'motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className={cn(
            'absolute top-3 right-3 grid size-9 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-quiet hover:bg-wash hover:text-ink',
            focusRing,
          )}
          aria-label={closeLabel}
        >
          <X aria-hidden="true" className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DrawerHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 border-b border-line px-5 py-4 pr-14', className)} {...props} />;
}

export function DrawerBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex-1 px-5 py-4', className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-2 border-t border-line px-5 py-4', className)} {...props} />;
}
