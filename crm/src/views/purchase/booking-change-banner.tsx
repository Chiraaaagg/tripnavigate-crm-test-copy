'use client';

import { RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskResultLine, useDeskCommand, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { BOOKING_CHANGE_TEXT, type PurchaseBookingChangeDTO } from '@/modules/procurement/booking-change';

/*
 * Purchase "Booking changed" banner (contract 6.3.4, 7.6, 8.5, 11.7): shown at
 * the top of the Purchase task when Sales revised the booking since the
 * assignee last looked. Lists what changed (fields before → after, travellers
 * added / removed / renamed, trip dates), never prices, instalments or any
 * money (the diff excludes them). "OK, seen" (assignee only) moves the basis
 * to the current version; the branch Manager reads it only.
 */

/** Track C's purchase_booking_change DTO (contract 8.5). */
export type PurchaseBookingChangeView = PurchaseBookingChangeDTO;

const TYPE: Record<string, string> = { adult: 'adult', child: 'child', infant: 'infant' };
const shown = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? BOOKING_CHANGE_TEXT.emptyValue : v);

export const BOOKING_CHANGE_FIELD = { taskId: 'taskId', expectedBasisVersionId: 'expectedBasisVersionId', requestId: 'requestId' } as const;

export function BookingChangeBanner({ change, action, initialState = null }: { change: PurchaseBookingChangeView; action: DecisionAction | null; initialState?: DeskResult | null }) {
  const cmd = useDeskCommand(action ?? (async () => ({ ok: false as const, code: 'not_authorized', message: 'You cannot do this here.' })), initialState);
  const [seen, setSeen] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const t = change.travellers;
  const trip = change.tripChanged;
  if (seen) {
    return (
      <div ref={resultRef} tabIndex={-1} className="mb-5 outline-none">
        <DeskResultLine state={cmd.state} okTitle="Seen" />
      </div>
    );
  }
  return (
    <section aria-labelledby="booking-changed-heading" className="mb-5 rounded-card border-2 border-status-warning-line bg-status-warning-tint px-4.5 py-4 font-sans text-base text-copy">
      <div className="flex items-start gap-2.5">
        <RefreshCw aria-hidden="true" className="mt-[0.25rem] size-4.5 shrink-0 text-status-warning" />
        <div className="min-w-0 flex-1">
          {/* Not a heading: the banner sits above the page's h1 (it is a labelled region instead). */}
          <p id="booking-changed-heading" className="m-0 text-lg font-semibold text-ink">
            {BOOKING_CHANGE_TEXT.title(change.basisVersionNo, change.currentVersionNo)}
          </p>
          <p className="m-0 mt-0.5 text-sm text-copy">Sales sent a revised booking. Check these changes with the supplier before you continue.</p>
          <ul className="m-0 mt-3 flex list-disc flex-col gap-1 pl-5">
            {change.fields.map((f) => (
              <li key={f.key}>
                <strong className="text-ink">{f.label}:</strong> {shown(f.before)} → {shown(f.after)}
              </li>
            ))}
            {trip?.destination ? (
              <li>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.destination}:</strong> {shown(trip.destination.before)} → {shown(trip.destination.after)}
              </li>
            ) : null}
            {trip?.start ? (
              <li>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.start}:</strong> {shown(trip.start.before)} → {shown(trip.start.after)}
              </li>
            ) : null}
            {trip?.end ? (
              <li>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.end}:</strong> {shown(trip.end.before)} → {shown(trip.end.after)}
              </li>
            ) : null}
            {t.added.map((x) => (
              <li key={`a${x.seq}`}>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.travellerAdded}:</strong> {x.name} ({TYPE[x.type] ?? x.type})
              </li>
            ))}
            {t.removed.map((x) => (
              <li key={`r${x.seq}`}>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.travellerRemoved}:</strong> {x.name} ({TYPE[x.type] ?? x.type})
              </li>
            ))}
            {t.renamed.map((x) => (
              <li key={`n${x.seq}`}>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.travellerRenamed}:</strong> {x.before} → {x.after}
              </li>
            ))}
            {t.typeChanged.map((x) => (
              <li key={`t${x.seq}`}>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.travellerType}:</strong> {TYPE[x.before] ?? x.before} → {TYPE[x.after] ?? x.after}
              </li>
            ))}
            {change.budgetChanged ? (
              <li>
                <strong className="text-ink">{BOOKING_CHANGE_TEXT.budgetChanged}.</strong> Open the Work tab to see the budget.
              </li>
            ) : null}
          </ul>
          {change.canAck && action ? (
            <form
              className="mt-3 flex flex-col items-start gap-2"
              onSubmit={(e) =>
                cmd.submit(e, (r) => {
                  if (r.ok) {
                    setSeen(true);
                    requestAnimationFrame(() => resultRef.current?.focus());
                  }
                })
              }
            >
              <Hidden fields={{ [BOOKING_CHANGE_FIELD.taskId]: change.taskId, [BOOKING_CHANGE_FIELD.expectedBasisVersionId]: change.basisVersionId, [BOOKING_CHANGE_FIELD.requestId]: cmd.requestId }} />
              {cmd.state && !cmd.state.ok ? <DeskResultLine state={cmd.state} failTitle="Not saved" /> : null}
              <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(e) => cmd.pending && e.preventDefault()}>
                {cmd.pending ? 'Saving…' : BOOKING_CHANGE_TEXT.ack}
              </Button>
            </form>
          ) : (
            <p className="m-0 mt-3 text-sm text-quiet">{BOOKING_CHANGE_TEXT.readOnly}. The assigned Purchase colleague confirms they have seen it.</p>
          )}
        </div>
      </div>
    </section>
  );
}
