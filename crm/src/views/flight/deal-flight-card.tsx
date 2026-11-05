import { FileCheck, Plane, UserX } from 'lucide-react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { formatIst } from '../deal-labels';
import type { DealFlightActions } from './actions';
import { FlightStatusBadge } from './bits';
import { ApproveRejectForm } from './decide-forms';
import { plural, sectorLine } from './format';
import { CHANGE_KIND_LABEL } from './labels';
import type { DealFlightSummary, SectorSummary } from './types';
import { FF } from './actions';
import { NameFillSection } from './name-fill';

/*
 * Deal page · Services tab flight card (contract 11.2, from
 * deal_flight_summary): per flight its status words, the current flight
 * (approved changes included), travellers, "N travellers not named yet",
 * e-ticket links for the Sales owner, Manager and Accounts; and the approval
 * card for the decider (prototype salesReview FV:717 + salesItins FV:739):
 * old → new flights, travellers, remark, Approve / Reject with a reason.
 * Transfers show "Meets flight". No fares (money fence).
 */

function Lines({ rows, empty = 'No flights' }: { rows: SectorSummary[]; empty?: string }) {
  if (!rows.length) return <p className="m-0 text-sm text-quiet">{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
      {rows.map((r, i) => (
        <li key={i} className="m-0 wrap-anywhere">
          {sectorLine(r)}
          {r.travellers?.length ? <span className="text-quiet"> · {r.travellers.join(', ')}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function DealFlightCard({
  summary,
  actions,
  eTicketBase,
  viewerIsSalesOwner,
  dealId = '',
  nameFillInitialState,
}: {
  /** Preview gallery only. */
  nameFillInitialState?: import('@/views/accounts/supplier-forms').UiResult | null;
  /** Needed for the name-fill form (R3). */
  dealId?: string;
  summary: DealFlightSummary;
  actions?: DealFlightActions;
  /** E-ticket download route prefix (the server track's route handler): `${eTicketBase}/${evidenceId}`. */
  eTicketBase?: string;
  /** The Sales owner sees the "name them in the booking" line. */
  viewerIsSalesOwner?: boolean;
}) {
  if (summary.flights.length === 0) return null;
  const pending = summary.flights.flatMap((f) => f.pending.map((p) => ({ f, p })));
  return (
    <>
      {pending.length ? (
        <Card className="border-status-warning-line" id="flight-approvals">
          <section aria-labelledby="flight-approvals-heading">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="flight-approvals-heading">Flight changes · {plural(pending.length, 'change')} waiting for approval</CardTitle>
                <CardDescription>Flight wants to change these flights for the travellers shown. Everyone else keeps their flight. Approving does not issue a ticket.</CardDescription>
              </div>
            </CardHeader>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Flight changes waiting">
              {pending.map(({ f, p }) => (
                <li key={p.changeId} className="m-0 flex flex-col gap-3 px-4.5 py-4">
                  <h3 className="m-0 text-base font-semibold text-ink">
                    Change {p.changeNo} · {CHANGE_KIND_LABEL[p.kind]} · {f.title}
                  </h3>
                  <p className="m-0 text-sm">
                    {p.kind === 'passenger_itinerary'
                      ? `New itinerary for ${p.travellers.join(', ')} only. The other travellers keep their flights.`
                      : p.kind === 'added_extra'
                        ? `Travellers on this extra flight: ${p.travellers.join(', ')}`
                        : `Travellers who move: ${p.travellers.join(', ')}`}
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="m-0 mb-1 text-sm font-semibold text-quiet">{p.kind === 'added_extra' ? 'Current flights' : 'Previous'}</p>
                      <Lines rows={p.from} empty={p.kind === 'added_extra' ? 'Extra journey: nothing is replaced' : 'No flights'} />
                    </div>
                    <div>
                      <p className="m-0 mb-1 text-sm font-semibold text-quiet">Proposed</p>
                      <Lines rows={p.to} />
                    </div>
                  </div>
                  <p className="m-0 text-sm text-quiet">
                    Remark: {p.remark} · sent {formatIst(p.requestedAt)}
                    {p.requestedByName ? ` by ${p.requestedByName}` : ''}
                  </p>
                  {p.canDecide && actions ? (
                    <ApproveRejectForm
                      action={actions.decideChange}
                      fields={{ [FF.changeId]: p.changeId, [FF.expectedRowVersion]: p.rowVersion }}
                      label={`Decide flight change ${p.changeNo}`}
                      approveLabel="Approve"
                      rejectLabel="Reject"
                      rejectValue="reject"
                      reasonLabel="Reason for rejecting"
                      reasonHint="10 to 500 characters. Flight reads it. The travellers go back to their previous flight."
                    />
                  ) : (
                    <p className="m-0 text-sm text-quiet">Only the Deal’s Sales owner decides this change.</p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </Card>
      ) : null}
      <Card id="deal-flights" tabIndex={-1}>
        <section aria-labelledby="deal-flights-heading">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle id="deal-flights-heading">Flights</CardTitle>
              <CardDescription>The current flights, with every approved change.</CardDescription>
            </div>
            <Plane aria-hidden="true" className="size-4 text-faint" />
          </CardHeader>
          {summary.nameFill && summary.nameFill.slots.length > 0 && actions?.fillName ? (
            <CardBody className="border-b border-line">
              <NameFillSection dealId={dealId} versionId={summary.nameFill.versionId} slots={summary.nameFill.slots} action={actions.fillName} initialState={nameFillInitialState} />
            </CardBody>
          ) : null}
          <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Flights on this Deal">
            {summary.flights.map((f) => (
              <li key={f.taskId} className="m-0 flex flex-col gap-2 px-4.5 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-semibold text-ink">{f.title}</span>
                  <FlightStatusBadge status={f.status} />
                </div>
                <p className="m-0 text-sm text-quiet">Flight team: {f.assigneeName ?? 'not taken yet'}{f.bookingChanged ? ' · reviewing your new booking' : ''}</p>
                <Lines rows={f.current} empty="No flight confirmed yet" />
                {f.unnamedCount > 0 ? (
                  <Notice tone="warning" icon={UserX}>
                    <p>
                      {plural(f.unnamedCount, 'traveller')} not named yet{summary.nameFill?.slots.length && actions?.fillName ? ' — fill in the names above' : viewerIsSalesOwner ? ' — name them in the booking' : ''}. They cannot get a ticket until named.
                    </p>
                  </Notice>
                ) : null}
                {f.eTickets?.length ? (
                  <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm" aria-label={`E-tickets of ${f.title}`}>
                    {f.eTickets.map((e) => (
                      <li key={e.evidenceId} className="m-0 flex items-center gap-1.5">
                        <FileCheck aria-hidden="true" className="size-4 text-faint" />
                        {eTicketBase ? (
                          <a href={`${eTicketBase}/${e.evidenceId}`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                            {e.fileName}
                          </a>
                        ) : (
                          e.fileName
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
          {summary.transfers.length ? (
            <CardBody className="border-t border-line">
              <h3 className="m-0 mb-1.5 text-sm font-semibold text-ink">Transfers</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {summary.transfers.map((t) => (
                  <li key={t.transferItemId} className="m-0 wrap-anywhere">
                    {t.transferTitle} · Meets flight: {t.flightCurrent.length ? sectorLine(t.flightCurrent[0]!) : 'not set yet'}
                  </li>
                ))}
              </ul>
            </CardBody>
          ) : null}
        </section>
      </Card>
    </>
  );
}

/** The flight read failed: say so (never a missing card that looks like "no flights"). */
export function DealFlightUnavailable() {
  return (
    <Card id="deal-flights" className="border-status-danger-line">
      <section aria-labelledby="deal-flights-heading">
        <CardHeader>
          <CardTitle id="deal-flights-heading">Flights</CardTitle>
        </CardHeader>
        <CardBody>
          <Notice tone="warning" role="status">
            <p>The flight details could not be loaded. Nothing was changed. Reload the page to try again.</p>
          </Notice>
        </CardBody>
      </section>
    </Card>
  );
}
