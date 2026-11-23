'use client';

import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';

/*
 * "Add a supplier" / "Add a contract" in the existing side drawer (UX
 * redesign R3, design plan 1.3 "add forms open from a button", DM-20,
 * DM-23). The form inside is the same component with the same field names
 * and server action as before; only where it opens changed. The drawer is a
 * Radix Dialog (focus trap, Escape, focus back on the button). The form
 * mounts when the drawer opens; a success or a refusal stays inside it.
 */

export function AddDrawer({
  buttonLabel,
  title,
  description,
  initialOpen,
  children,
}: {
  buttonLabel: string;
  title: string;
  description?: ReactNode;
  /** Preview gallery: start open (a refusal or warning already on screen). */
  initialOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Drawer defaultOpen={initialOpen}>
      <DrawerTrigger asChild>
        <Button variant="primary">
          <Plus aria-hidden="true" />
          {buttonLabel}
        </Button>
      </DrawerTrigger>
      <DrawerContent className="w-[min(40rem,calc(100vw-1rem))]" closeLabel={`Close: ${title}`}>
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          {description ? <DrawerDescription className="m-0 text-sm text-quiet">{description}</DrawerDescription> : null}
        </DrawerHeader>
        <DrawerBody>{children}</DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
