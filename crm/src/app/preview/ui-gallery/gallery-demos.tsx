'use client';

import { Bell, Copy, MoreHorizontal, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DrawerClose,
} from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';

/** Client providers the gallery needs (tooltips, toasts). */
export function GalleryProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  );
}

export function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send quote to Sample Customer A?</DialogTitle>
          <DialogDescription>The customer gets the day-by-day plan and the price. You can still change it afterwards.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field htmlFor="demo-dialog-note" label="Note for the customer" optional hint="Shown above the plan.">
            <Input id="demo-dialog-note" aria-describedby={fieldDescribedBy('demo-dialog-note', { hint: true })} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="primary">Send quote</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DrawerDemo() {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="secondary">Open side panel</Button>
      </DrawerTrigger>
      <DrawerContent side="right">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-xl font-semibold text-ink">SAMPLE — Goa family trip</DrawerTitle>
          <DrawerDescription className="m-0 text-base text-quiet">Sample Customer A · 4 nights · 2 adults, 2 children</DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <p className="m-0 text-base text-copy">Next step: share the day-by-day plan. Owner: Asha R. (sample).</p>
        </DrawerBody>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="secondary">Close panel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

export function MenuDemo() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <MoreHorizontal aria-hidden="true" />
          More actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Deal</DropdownMenuLabel>
        <DropdownMenuItem>
          <Pencil aria-hidden="true" /> Edit travel dates
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Copy aria-hidden="true" /> Copy reference
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <UserRound aria-hidden="true" /> Change owner (Manager only)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger">
          <Trash2 aria-hidden="true" /> Remove draft quote
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TooltipDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tooltip content="Notifications: 3 unread">
        <Button variant="ghost" size="icon" aria-label="Notifications, 3 unread">
          <Bell aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip content="Creates a Deal for a Lead you already own" side="bottom">
        <Button variant="secondary">
          <Plus aria-hidden="true" /> New Deal
        </Button>
      </Tooltip>
    </div>
  );
}

export function ToastDemo() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => toast({ tone: 'success', title: 'Saved.', description: 'Quote sent to Sample Customer A.' })}>
        Show success
      </Button>
      <Button variant="secondary" onClick={() => toast({ tone: 'info', title: 'Sync is catching up', description: 'New Leads may take a minute.' })}>
        Show info
      </Button>
      <Button
        variant="secondary"
        onClick={() => toast({ tone: 'warning', title: 'Waiting for Accounts', description: 'The hotel booking needs approval first.' })}
      >
        Show warning
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ tone: 'danger', title: 'Not saved.', description: 'Travel date is in the past. Your typing is kept.' })
        }
      >
        Show error
      </Button>
    </div>
  );
}

/**
 * Re-renders the page's server components (router.refresh()), as a
 * revalidating action would. The layout then renders for a NEW request with a
 * new nonce; dialogs opened afterwards must still use this document's nonce.
 */
export function RefreshDemo() {
  const router = useRouter();
  return (
    <Button variant="secondary" onClick={() => router.refresh()}>
      Refresh page data
    </Button>
  );
}
