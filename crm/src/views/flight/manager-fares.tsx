import { Plane } from 'lucide-react';
import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { formatIst } from '../deal-labels';
import { FF, type ManagerFlightActions } from './actions';
import { ApproveRejectForm } from './decide-forms';
import { inr } from './format';
import type { ManagerFlightFareRow } from './types';

/*
 * Manager · Approvals: "Flight fares above budget" (contract 11.1, B6),
 * rows from manager_approvals().flightFares. One row per request: Deal,
 * flights, supplier, this batch's supplier cost, the Deal's flight cost
 * after it and the approved budget; Approve or Return with a reason. The
 * database refuses the requester and the Deal's Flight colleague.
 */

export function FlightFaresApprovals({ rows, actions }: { rows: ManagerFlightFareRow[]; actions: ManagerFlightActions }) {
  return (
    <Card>
      <section aria-labelledby="flight-fares-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="flight-fares-heading">Flight fares above budget</CardTitle>
            <CardDescription>Flight asks you to approve these exact fares before confirming the tickets.</CardDescription>
          </div>
          <Plane aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        {rows.length === 0 ? (
          <EmptyState icon={Plane} headingLevel={3} title="No flight fares waiting" description="Fares above a Deal’s flight budget appear here." />
        ) : (
          <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Flight fares waiting for approval">
            {rows.map((r) => {
              const titles = Array.isArray(r.flightTitles) ? r.flightTitles.join(' · ') : r.flightTitles;
              return (
                <li key={r.approvalId} className="m-0 flex flex-col gap-2 px-4.5 py-4">
                  <h3 className="m-0 text-base font-semibold text-ink">
                    <Link href={`/app/flight/deals/${r.dealId}?tab=work`} className={cn('rounded-chip text-brand-strong underline underline-offset-4', focusRing)}>
                      {r.dealReference} · {titles}
                    </Link>
                  </h3>
                  <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,14rem)_1fr]">
                    <dt className="font-medium text-quiet">Supplier</dt>
                    <dd className="m-0">{r.supplierName ?? 'Not recorded'}</dd>
                    <dt className="font-medium text-quiet">These tickets</dt>
                    <dd className="m-0 tabular-nums">{inr(r.batchSupplierCostPaise)}</dd>
                    <dt className="font-medium text-quiet">Flight cost after them</dt>
                    <dd className="m-0 tabular-nums">{inr(r.projectedSupplierCostPaise)}</dd>
                    <dt className="font-medium text-quiet">Approved budget</dt>
                    <dd className="m-0 tabular-nums">{r.budgetPaise ? inr(r.budgetPaise) : 'Not set'}</dd>
                    <dt className="font-medium text-quiet">Asked</dt>
                    <dd className="m-0">
                      {formatIst(r.requestedAt)}
                      {r.requestedByName ? ` by ${r.requestedByName}` : ''}
                    </dd>
                  </dl>
                  {r.canApprove ? (
                    <ApproveRejectForm
                      action={actions.decideFares}
                      fields={{ [FF.approvalId]: r.approvalId, [FF.expectedRowVersion]: r.rowVersion }}
                      label={`Decide flight fares for ${r.dealReference}`}
                      approveLabel="Approve these fares"
                      rejectLabel="Return"
                      rejectValue="return"
                      reasonLabel="Reason for returning"
                      reasonHint="10 to 500 characters. The Flight colleague reads it."
                    />
                  ) : (
                    <p className="m-0 text-sm text-quiet">You asked for these fares or work on this Deal’s flights, so another Manager decides.</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </Card>
  );
}
