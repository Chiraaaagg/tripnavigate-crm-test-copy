'use client';

import type { BookTravellerView } from '@/modules/fulfilment/contracts';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TravellerIdProofSlot } from '../b11/id-proof-slot';
import type { BookNowView } from '../b11/shapes';
import type { PassengerActions } from './passengers-card';

/*
 * "Attach ID proof" from a passenger row (voice-note batch, owner item 3: the
 * attach action must be visible). The dialog holds the existing private
 * upload slot unchanged: the consent tick, the file checks, and a file shown
 * as attached only after the upload finished.
 */
export function IdProofDialog({ view, traveller, rowNo, actions, onClose }: { view: BookNowView; traveller: BookTravellerView; rowNo: number; actions: PassengerActions; onClose: () => void }) {
  const name = traveller.fullName || `Passenger ${rowNo}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-xl" closeLabel="Close">
        <DialogHeader>
          <DialogTitle>ID proof · {name}</DialogTitle>
          <DialogDescription className="sr-only">Private upload. The customer must agree first.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {traveller.idProofs !== undefined && view.idProofLimits ? (
            <TravellerIdProofSlot
              dealId={view.dealId}
              seq={traveller.seq}
              rowNo={rowNo}
              name={traveller.fullName}
              savedName={traveller.fullName}
              type={traveller.type}
              proofs={traveller.idProofs ?? []}
              limits={view.idProofLimits}
              canEdit={view.idProofCanEdit}
              canRemove={view.idProofCanRemove}
              uploadAction={actions.uploadIdProof}
              removeAction={actions.removeIdProof}
              retryCopyAction={actions.retryIdProofCopy}
            />
          ) : (
            <p className="m-0 text-quiet">ID proofs are not shown to you.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
