'use client';

import { Menu } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from './drawer';
import { Wordmark } from './sidebar-nav';

/**
 * Phone navigation (Direction A, lead decision L2, DA-09): a visible "Menu"
 * text button in the top bar opens a slide-in sheet from the left holding the
 * same groups as the desktop sidebar (pass them as children). Shown under
 * 1024px. No bottom bar. Following a link closes the sheet; Radix returns
 * focus to the Menu button whenever the sheet closes (Escape, the close
 * button, a click outside). Container: the shadcn Sheet that ships with the
 * shadcn Sidebar (21st.dev id 1627, MIT), on the CRM's nonce-safe Drawer.
 */
export function MobileNav({ children, triggerLabel = 'Menu' }: { children: ReactNode; triggerLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="ghost" size="md" className="px-2.5 lg:hidden">
          <Menu aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DrawerTrigger>
      <DrawerContent
        side="left"
        closeLabel="Close menu"
        className="w-[min(20rem,calc(100vw-3rem))] border-r border-line px-3 py-4.5"
        onOpenAutoFocus={(event) => {
          // Start on the first section link (not the close button) so Tab walks the menu in order.
          const first = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('nav a[href]');
          if (first) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <DrawerTitle className="m-0 px-2.5 pt-1 pb-1">
          <Wordmark />
        </DrawerTitle>
        <DrawerDescription className="sr-only">Main menu</DrawerDescription>
        <div
          className="mt-3 flex flex-col gap-4"
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
