'use client';

import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { SalesClaimsPanel } from '../b11/book-claims';
import type { B11Action, SalesClaims } from '../b11/shapes';

/*
 * Money tab "Tell Accounts about a payment" (R2, design plan 2.4 "Deal ›
 * Money", SL-3). Opens the EXISTING reported-payments panel of Book now
 * (book-claims.tsx, an approved form: not changed) in a dialog: the same
 * fields, rules, refusals and server actions. The panel keeps typed input
 * after a refusal, and its result box moves focus to the error summary. The
 * Dialog content renders only while open (no server-rendered style).
 *
 * Shown by the route only to price readers on the Money tab, and only when
 * the claims read says this person may report (canReport); the server action
 * still decides.
 */
export function ReportPaymentDialog({
  dealId,
  claims,
  reportAction,
  withdrawAction,
  initialOpen = false,
}: {
  dealId: string;
  claims: SalesClaims;
  reportAction: B11Action;
  withdrawAction: B11Action;
  /** Preview gallery: start open. */
  initialOpen?: boolean;
}) {
  return (
    <Dialog defaultOpen={initialOpen}>
      <DialogTrigger asChild>
        {/* Secondary: the Deal header's "Next" action is the page's one primary (R2 review). */}
        <Button variant="secondary">
          <HandCoins aria-hidden="true" />
          Tell Accounts about a payment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tell Accounts about a payment</DialogTitle>
          <DialogDescription>What the customer says they paid. It is not money until Accounts checks it.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SalesClaimsPanel dealId={dealId} claims={claims} reportAction={reportAction} withdrawAction={withdrawAction} headingLevel={3} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
