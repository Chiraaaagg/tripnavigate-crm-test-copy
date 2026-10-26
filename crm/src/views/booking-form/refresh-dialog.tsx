'use client';

import { ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { BitrixRefreshRefusal } from '@/modules/fulfilment/booking-form-contract';
import { UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
import { useFormToast } from './form-toast';
import type { BookingFormActions } from './types';

/*
 * "Correct" and "Need another traveller?" (Book now v2, change 1; owner
 * answer 1 b). Dates, destination and the traveller counts belong to the
 * Bitrix Deal: staff change them there, then press "Refresh from Bitrix now",
 * which reads this one Deal at once. The CRM never changes the counts itself
 * and never writes to Bitrix.
 */

const REFUSAL_TEXT: Record<BitrixRefreshRefusal, string> = {
  refresh_too_soon: 'The Deal was read a moment ago. Try again in a few seconds.',
  refresh_switched_off: 'Reading trip details from Bitrix is switched off, so nothing was read. Ask the Super Admin.',
  refresh_not_bitrix_deal: 'This Deal did not come from Bitrix, so there is nothing to read.',
  bitrix_unavailable: 'Bitrix did not answer, so nothing changed here. Try again in a minute.',
  bitrix_deal_not_found: 'Bitrix could not find this Deal, so nothing changed here. Check the Deal in Bitrix.',
};

export function RefreshDialog({
  open,
  onOpenChange,
  dealId,
  dealHref,
  refresh,
  returnFocusTo = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  /** The Deal in Bitrix (null = no link known). */
  dealHref: string | null;
  refresh: BookingFormActions['refreshFromBitrix'];
  /** The button that opened the dialog ("Correct" or "Need another traveller?"); focus goes back to it. */
  returnFocusTo?: HTMLElement | null;
}) {
  const router = useRouter();
  const toast = useFormToast();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    if (!refresh || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await refresh(dealId);
      // The action words every outcome and refusal itself ("Updated from Bitrix. …", "… Try again in 12 seconds.").
      if (r.ok) {
        onOpenChange(false);
        router.refresh();
        toast(r.message || (r.data?.outcome === 'unchanged' ? 'Read from the Bitrix Deal. Nothing had changed.' : 'Updated from the Bitrix Deal.'));
        return;
      }
      const text = r.message || REFUSAL_TEXT[r.code as BitrixRefreshRefusal] || UNKNOWN_OUTCOME_TEXT;
      // Said once, in the dialog (not also as a toast).
      setProblem(text);
    } catch {
      setProblem(UNKNOWN_OUTCOME_TEXT);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblem(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        closeLabel="Close"
        onCloseAutoFocus={(e) => {
          // Opened by state (no trigger), so the dialog would not know where focus came from.
          if (returnFocusTo?.isConnected) {
            e.preventDefault();
            returnFocusTo.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg">Correct trip details in Bitrix</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3.5">
          <p className="m-0">Dates, destination and the number of travellers come from the Bitrix Deal. They change only there, so the booking and the Deal never disagree.</p>
          <ol className="m-0 flex flex-col gap-1.5 pl-5">
            <li>Open the Deal in Bitrix and change the wrong value (for example, travellers from 1 to 2).</li>
            <li>
              Come back here and press <b>Refresh from Bitrix now</b>. The new values show at once; no waiting for the next update.
            </li>
          </ol>
          <div className="flex gap-2.5 rounded-control border border-line bg-wash px-3.5 py-3 text-sm text-copy">
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />
            <p className="m-0">Names you already typed stay. A new passenger row appears for each extra traveller.</p>
          </div>
          {problem ? (
            <p role="alert" className="m-0 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-sm text-status-danger-strong">
              {problem}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {dealHref ? (
            <a href={dealHref} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'secondary' }))}>
              <ExternalLink aria-hidden="true" />
              Open the Deal in Bitrix
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {refresh ? (
            <Button variant="primary" loading={busy} onClick={() => void run()}>
              {busy ? null : <RefreshCw aria-hidden="true" />}
              {busy ? 'Refreshing…' : 'Refresh from Bitrix now'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
