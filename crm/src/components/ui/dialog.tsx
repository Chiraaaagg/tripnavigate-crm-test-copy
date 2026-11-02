'use client';

import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn, focusRing } from './cn';

/**
 * Modal dialog (Radix Dialog: focus trap, Escape, focus return, inert
 * background, scroll lock). The scroll lock inserts a <style> tag that carries
 * the CSP nonce through NonceBridge (root layout).
 *
 * Content renders only while open, on the client, so no server-rendered style
 * attributes reach the production Content Security Policy.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const overlayClass = cn(
  'fixed inset-0 z-50 bg-[rgb(15_23_42/0.42)]',
  'data-[state=open]:animate-ui-fade-in data-[state=closed]:animate-ui-fade-out motion-reduce:animate-none',
);

export function DialogContent({
  className,
  children,
  hideClose = false,
  closeLabel = 'Close',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { hideClose?: boolean; closeLabel?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col',
          'overflow-y-auto rounded-card border border-line bg-card font-sans text-base text-copy shadow-overlay',
          'data-[state=open]:animate-ui-pop-in data-[state=closed]:animate-ui-pop-out motion-reduce:animate-none',
          'outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className={cn(
              'absolute top-3 right-3 grid size-9 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-quiet hover:bg-wash hover:text-ink',
              focusRing,
            )}
            aria-label={closeLabel}
          >
            <X aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5 pr-14 pb-3', className)} {...props} />;
}

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-2', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-2.5 flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('m-0 text-xl leading-7 font-semibold tracking-heading text-ink', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('m-0 text-base text-quiet', className)} {...props} />;
}
