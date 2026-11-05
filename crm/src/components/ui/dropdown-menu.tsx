'use client';

import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/**
 * Action menu (Radix DropdownMenu: arrow keys, typeahead, Escape, focus
 * return). The menu renders only while open, on the client.
 * Trigger with <DropdownMenuTrigger asChild><Button …/></DropdownMenuTrigger>.
 */
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-card border border-line bg-card p-1 font-sans text-base text-copy shadow-raised',
          'data-[state=open]:animate-ui-pop-in data-[state=closed]:animate-ui-pop-out motion-reduce:animate-none',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  tone = 'default',
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { tone?: 'default' | 'danger' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-2.5 py-1.5 outline-none select-none [&_svg]:size-4 [&_svg]:shrink-0',
        tone === 'danger' ? 'text-status-danger data-highlighted:bg-status-danger-tint' : 'text-ink data-highlighted:bg-wash',
        'data-disabled:cursor-not-allowed data-disabled:text-faint',
        'data-highlighted:outline-2 data-highlighted:outline-offset-[-2px] data-highlighted:outline-solid data-highlighted:outline-brand-strong',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2.5 pt-2 pb-1 text-xs font-semibold tracking-label text-quiet uppercase', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}
