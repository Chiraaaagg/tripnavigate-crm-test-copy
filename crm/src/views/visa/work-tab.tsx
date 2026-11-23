'use client';

import { useCallback, useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import type { VisaWorkActions } from './actions';
import { AppointmentCard } from './appointment';
import { VisaStepBar } from './bits';
import { VisaCostsCard } from './costs';
import { ResultNotice, type VisaResult } from './kit';
import { nameOf } from './labels';
import { PassengersCard, type WorkCtx } from './passengers';
import { ApplyPopup } from './popup-apply';
import { ApprovePopup, DeliveredPopup, HandoverPopup, RejectPopup, ReapplyPopup, WithdrawPopup } from './popup-decide';
import { AddDocumentPopup, FeePopup, OtherCostPopup, RemoveDocumentPopup, UploadDocumentPopup } from './popup-docs';
import { VisaTripCancelledPanel } from './trip-cancelled';
import type { VisaWorkspace } from './types';
import { appointmentRows, canManageFees, passengerRows, type Popup, type PopupSeed } from './work-model';

/*
 * Work tab of a visa or passport task (contract 11.1): the five-step bar,
 * Passengers and documents, Appointment, and Visa costs per traveller, with
 * the popups they open. Passport tasks use the same flow without kind,
 * jurisdiction, custody tick or e-visa (V12). Not taken: the step bar and
 * "Applicants appear when the task is taken." Read-only for anyone but the
 * assignee (the database's can.* flags decide every control).
 */

export function VisaWorkTab({
  ws,
  actions,
  initialPopup = null,
  initialEditId = null,
  initialSelected = [],
  initialSeed,
}: {
  /** Preview gallery only: the first popup's typed values and answer. */
  initialSeed?: PopupSeed;
  ws: VisaWorkspace;
  actions: VisaWorkActions;
  /** Preview gallery only: a popup open, a row in edit, ticked passengers on first paint. */
  initialPopup?: Popup | null;
  initialEditId?: string | null;
  initialSelected?: string[];
}) {
  const [popup, setPopup] = useState<Popup | null>(initialPopup);
  const [returnTo, setReturnTo] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const open = useCallback((p: Popup, focusId?: string) => {
    setReturnTo(focusId);
    setPopup(p);
  }, []);
  const close = (o: boolean) => {
    // Cancel or Escape keeps the ticked passengers; only a confirmed save clears them (done()).
    if (!o) setPopup(null);
  };
  const [flash, setFlash] = useState<VisaResult | null>(null);
  const flashId = `visa-flash-${ws.taskId}`;
  const done = useCallback(
    (r: VisaResult) => {
      setFlash(r);
      // The pressed button often disappears after the save: focus goes to the result line instead.
      setReturnTo(flashId);
      setPopup(null);
      setSelected([]);
      window.setTimeout(() => document.getElementById(flashId)?.focus(), 60);
    },
    [flashId],
  );
  const working = ws.canWork && ws.status.code === 'in_progress';
  const ctx: WorkCtx = { ws, actions, working, managingFees: canManageFees(ws), open, done };
  const taken = ws.status.code !== 'not_taken';
  const byId = (id: string) => ws.applicants.find((a) => a.applicationId === id);
  const one = popup && 'id' in popup ? byId(popup.id) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div id={flashId} tabIndex={-1} className="outline-none empty:hidden">
        {flash ? <ResultNotice state={flash} /> : null}
      </div>
      {/* Accounts phase 2 (contract 7.4, LD12): banner while the cancellation is open; choices and refunds after approval. */}
      <VisaTripCancelledPanel ws={ws} actions={{ chooseCancellation: actions.chooseCancellation, setCancellationFee: actions.setCancellationFee }} />
      <VisaStepBar steps={ws.steps} taskId={ws.taskId} />
      {!taken ? (
        <Notice tone="info">Applicants appear when the task is taken.</Notice>
      ) : (
        <>
          <div id={`sec-${ws.taskId}-pax`} tabIndex={-1} className="scroll-mt-4 outline-none">
            <PassengersCard ctx={ctx} rows={passengerRows(ws)} initialEditId={initialEditId} />
          </div>
          <div id={`sec-${ws.taskId}-appt`} tabIndex={-1} className="scroll-mt-4 outline-none">
            <AppointmentCard ctx={ctx} rows={appointmentRows(ws)} selected={selected} setSelected={setSelected} />
          </div>
          {ws.previousApplications.length > 0 ? (
            <Card>
              <section aria-labelledby={`visa-prev-${ws.taskId}`}>
                <CardHeader>
                  <CardTitle id={`visa-prev-${ws.taskId}`}>Earlier applications</CardTitle>
                </CardHeader>
                <CardBody>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {ws.previousApplications.map((p) => {
                      const now = ws.applicants.find((a) => a.seq === p.seq);
                      return (
                        <li key={p.applicationId} className="m-0">
                          {now ? nameOf(now) : `Traveller ${p.seq}`} · {p.reference ? `Ref ${p.reference}` : 'No reference'} · {p.decision === 'rejected' ? 'Rejected' : p.decision === 'approved' ? 'Approved' : p.decision === 'withdrawn' ? 'Withdrawn' : 'Not decided'} · replaced by a new application
                        </li>
                      );
                    })}
                  </ul>
                </CardBody>
              </section>
            </Card>
          ) : null}
          {ws.applicants.length > 0 ? <VisaCostsCard ws={ws} /> : null}
        </>
      )}

      {popup?.kind === 'apply' ? (
        <ApplyPopup
          ctx={ctx}
          list={popup.ids.map(byId).filter((a): a is NonNullable<typeof a> => !!a)}
          open
          onOpenChange={close}
          returnFocusId={returnTo}
          seed={popup === initialPopup ? initialSeed : undefined}
        />
      ) : null}
      {one && popup?.kind === 'approve' ? <ApprovePopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} seed={popup === initialPopup ? initialSeed : undefined} /> : null}
      {one && popup?.kind === 'reject' ? <RejectPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'withdraw' ? <WithdrawPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'handover' ? <HandoverPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'delivered' ? <DeliveredPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'reapply' ? <ReapplyPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'addDoc' ? <AddDocumentPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'uploadDoc' ? <UploadDocumentPopup ctx={ctx} a={one} documentId={popup.documentId} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'removeDoc' ? <RemoveDocumentPopup ctx={ctx} a={one} documentId={popup.documentId} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {one && popup?.kind === 'otherCost' ? <OtherCostPopup ctx={ctx} a={one} open onOpenChange={close} returnFocusId={returnTo} /> : null}
      {popup?.kind === 'fee' ? <FeePopup ctx={ctx} entryId={popup.entryId} open onOpenChange={close} returnFocusId={returnTo} /> : null}
    </div>
  );
}
