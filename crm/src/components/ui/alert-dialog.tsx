'use client';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn } from './cn';
import { overlayClass } from './dialog';

/*
 * C7: Alert Dialog (owner choice B: shadcn Alert Dialog 705, MIT, on the
 * Radix Alert Dialog already inside the installed `radix-ui` package; nothing
 * added). Same frame as ui/dialog.tsx. Radix gives role="alertdialog", a
 * focus trap, focus on Cancel first, Escape to cancel, focus back to the
 * opener, an inert background and the scroll lock (whose <style> tag carries
 * the CSP nonce through NonceBridge). It does NOT close on a click outside:
 * a confirmation is never dismissed by accident.
 *
 * Content renders only while open, on the client, so no server-rendered
 * style attribute reaches the production Content Security Policy.
 *
 * The approved forms (Book now, Purchase, Flight, Visa) keep their own
 * dialog (components/ConfirmDialog.tsx); this file is for new screens only.
 */
export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;

export function AlertDialogContent({ className, children, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={overlayClass} />
      <AlertDialogPrimitive.Content
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
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-3', className)} {...props} />;
}

export function AlertDialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-3 px-5 py-2', className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-2.5 flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title className={cn('m-0 text-xl leading-7 font-semibold tracking-heading text-ink', className)} {...props} />;
}

export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description className={cn('m-0 text-base text-copy', className)} {...props} />;
}
