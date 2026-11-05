'use client';

import { CheckCheck, FileCheck } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressChecklist } from '@/components/ui/progress-checklist';
import { StatItem, StatList } from '@/components/ui/stat-card';
import { Submit, type UiResult } from '@/views/accounts/supplier-forms';
import { formatIst } from '../deal-labels';
import { FF, type FlightWorkActions } from './actions';
import { bySchedule, flightLabel, plural, routeText, shortDate, sizeText } from './format';
import { ActionForm, messageOf } from './kit';
import { DONE_CHECKLIST, FLIGHT_TEXT } from './labels';
import type { FlightMoney, FlightWorkspace } from './types';

/*
 * Finish this flight (contract 7 and 11.1; prototype finishCard FV:1588,
 * flightChecklist FV:771, fv-done FV:2471): stats, the server's checklist
 * (each open item says why, in words), e-ticket upload, and "Mark flight
 * done" (enabled only when the server reports no open item) with a
 * confirmation dialog listing flights (date-sorted, airline code once, no
 * sector numbers), PNRs and the ticket count. The text never claims costs
 * are locked (fixes FV:2480).
 */

const E_TICKET_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

function whyTexts(ws: FlightWorkspace, money: FlightMoney | null): Record<string, string> {
  const flights = ws.flights;
  const name = (seq: number) => flights.flatMap((f) => f.travellers).find((t) => t.seq === seq)?.fullName ?? `Traveller ${seq}`;
  const pendingPairs = flights.flatMap((f) =>
    f.sectors
      .filter((s) => s.displayState === 'active')
      .flatMap((s) => s.travellers.filter((t) => !t.ticket && !t.held).map((t) => `${name(t.seq)} on ${flightLabel(s.airline, s.flightNo)} ${routeText(s.from, s.to)}`)),
  );
  const without = flights.flatMap((f) => f.travellers.filter((t) => !f.sectors.some((s) => (s.displayState === 'active' || s.displayState === 'pending') && s.travellers.some((x) => x.seq === t.seq))).map((t) => `${t.fullName} (${f.title})`));
  const pending = flights.flatMap((f) => f.changes.filter((c) => c.status === 'pending'));
  const changedNames = flights.flatMap((f) => f.sectors.flatMap((s) => s.travellers.filter((t) => t.ticket?.travellerChanged).map((t) => name(t.seq))));
  const unpaid = (money?.batches ?? []).filter((b) => b.payment.state === 'unpaid' || b.payment.state === 'request_cancelled' || b.payment.state === 'request_pending' || b.payment.state === 'direct_returned' || b.payment.state === 'request_returned');
  const returned = (money?.batches ?? []).filter((b) => b.payment.state === 'direct_returned' || b.payment.state === 'request_returned');
  return {
    booking_changed: `Sales sent a new booking for ${flights.filter((f) => f.bookingChanged).map((f) => f.title).join(', ') || 'a flight'}. Review it.`,
    travellers_unnamed: `${plural(flights.reduce((n, f) => n + f.unnamedCount, 0), 'traveller')} not named yet. Sales has been told.`,
    traveller_without_flight: `Not on a flight yet: ${without.join(', ') || 'a traveller'}.`,
    change_pending: pending.length ? pending.map((c) => `${c.deciderKind === 'flight_owner' ? 'You' : (c.deciderName ?? (c.deciderKind === 'sales_owner' ? 'Sales' : 'The Manager'))} still has to decide change ${c.changeNo}`).join('; ') + '.' : 'A change is waiting for a decision.',
    tickets_pending: pendingPairs.length ? `Still pending: ${pendingPairs.slice(0, 6).join(', ')}${pendingPairs.length > 6 ? ` and ${pendingPairs.length - 6} more` : ''}.` : 'Every flight needs its travellers ticketed.',
    traveller_changed: `${[...new Set(changedNames)].join(', ') || 'A traveller'} changed in the booking after ticketing. Correct the ticket.`,
    fare_approval_pending: 'The Manager still has to approve the fares.',
    payment_missing: unpaid.length ? `Record the payment for batch ${unpaid.map((b) => b.batchNo).join(', ')}.` : 'Record the payment for each ticket batch.',
    payment_returned: returned.length ? `Accounts returned the payment for batch ${returned.map((b) => b.batchNo).join(', ')}.` : 'Accounts returned a payment.',
    eticket_missing: 'Attach the issued e-tickets.',
  };
}

const TARGET: Record<string, string> = {
  booking_changed: 'itinerary',
  travellers_unnamed: 'itinerary',
  traveller_without_flight: 'itinerary',
  change_pending: 'itinerary',
  tickets_pending: 'confirm-tickets-heading',
  traveller_changed: 'tickets',
  fare_approval_pending: 'confirm-tickets-heading',
  payment_missing: 'cost-payment',
  payment_returned: 'cost-payment',
  eticket_missing: 'eticket',
};

export function FinishCard({ ws, money, actions, eTicketBase }: { ws: FlightWorkspace; money: FlightMoney | null; actions: FlightWorkActions; eTicketBase?: string }) {
  const done = ws.status.code === 'done';
  const confirmed = ws.flights.reduce((n, f) => n + f.status.confirmed, 0);
  const required = ws.flights.reduce((n, f) => n + f.status.required, 0);
  const why = whyTexts(ws, money);
  const items = DONE_CHECKLIST.filter((i) => i.token !== 'travellers_unnamed' || ws.flights.some((f) => f.unnamedCount > 0) || ws.doneIssues.includes(i.token)).map((i) => ({
    key: i.token,
    label: i.label,
    done: !ws.doneIssues.includes(i.token),
    why: why[i.token],
    onSelect: () => {
      const el = document.getElementById(TARGET[i.token] ?? 'itinerary');
      el?.scrollIntoView({ block: 'start' });
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    },
  }));
  const open = items.filter((i) => !i.done).length;
  return (
    <Card id="finish" tabIndex={-1}>
      <section aria-labelledby="finish-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="finish-heading">Finish this flight</CardTitle>
            <CardDescription>{done ? 'Done · ticket issued.' : 'Attach the e-tickets, then mark the flight done.'}</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          <StatList>
            <StatItem label="Tickets confirmed" value={String(confirmed)} />
            <StatItem label="Tickets pending" value={String(Math.max(0, required - confirmed))} />
            <StatItem label="E-tickets attached" value={String(ws.eTickets.length)} />
          </StatList>
          <ETicketSection ws={ws} actions={actions} eTicketBase={eTicketBase} />
          {done ? (
            <Notice tone="success" title="Done · ticket issued">
              <p>
                {ws.completedAt ? `Marked done ${formatIst(ws.completedAt)}` : 'Marked done'}
                {ws.completedByName ? ` by ${ws.completedByName}` : ''}. Ticket details stay correctable with a reason.
              </p>
            </Notice>
          ) : ws.canWork ? (
            <>
              <ProgressChecklist id="finish-checklist" title={open ? 'Before you can mark the flight done' : 'Ready to mark the flight done'} items={items} />
              <MarkDone ws={ws} action={actions.complete} openCount={open} />
            </>
          ) : (
            <p className="m-0 text-sm text-quiet">The Flight colleague on these flights marks them done.</p>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

function ETicketSection({ ws, actions, eTicketBase }: { ws: FlightWorkspace; actions: FlightWorkActions; eTicketBase?: string }) {
  const base = useId();
  const file = useRef<HTMLInputElement | null>(null);
  const [results, setResults] = useState<Array<{ name: string; state: UiResult }>>([]);
  const [pending, setPending] = useState(false);
  const target = ws.flights.find((f) => f.status.code !== 'done')?.taskId ?? ws.flights[0]?.taskId;
  const send = async () => {
    const files = Array.from(file.current?.files ?? []);
    if (!files.length || pending || !target) {
      if (!files.length) setResults([{ name: '', state: { ok: false, code: 'invalid_input', message: 'Choose one or more files first.' } }]);
      return;
    }
    setPending(true);
    const out: Array<{ name: string; state: UiResult }> = [];
    for (const f of files) {
      if (f.size > 4 * 1024 * 1024) {
        out.push({ name: f.name, state: { ok: false, code: 'invalid_input', message: 'Larger than 4 MB.' } });
        continue;
      }
      const fd = new FormData();
      fd.set(FF.taskId, target);
      fd.set(FF.kind, 'e_ticket');
      fd.set(FF.file, f);
      fd.set(FF.requestId, crypto.randomUUID());
      try {
        out.push({ name: f.name, state: await actions.uploadFile(null as never, fd) });
      } catch {
        out.push({ name: f.name, state: { ok: false, code: 'unexpected', message: FLIGHT_TEXT.unknownOutcome } });
      }
    }
    setResults(out);
    if (out.every((r) => r.state.ok) && file.current) file.current.value = '';
    setPending(false);
  };
  return (
    <section id="eticket" tabIndex={-1} aria-labelledby={`${base}-h`} className="flex flex-col gap-2 outline-none">
      <h3 id={`${base}-h`} className="m-0 text-base font-semibold text-ink">
        E-ticket documents
      </h3>
      {ws.eTickets.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {ws.eTickets.map((e) => (
            <li key={e.evidenceId} className="m-0 flex flex-wrap items-center gap-x-2 wrap-anywhere">
              <FileCheck aria-hidden="true" className="size-4 shrink-0 text-faint" />
              {eTicketBase ? (
                <a href={`${eTicketBase}/${e.evidenceId}`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                  {e.fileName}
                </a>
              ) : (
                <span className="font-medium">{e.fileName}</span>
              )}
              <span className="text-quiet">
                {sizeText(e.sizeBytes)} · {formatIst(e.storedAt)}
                {e.uploadedByName ? ` · ${e.uploadedByName}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-quiet">No e-ticket attached yet.</p>
      )}
      {ws.canUploadETicket ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${base}-file`} className="text-sm font-semibold text-ink">
            Attach e-tickets
          </label>
          <input id={`${base}-file`} ref={file} type="file" multiple accept={E_TICKET_ACCEPT} aria-describedby={`${base}-hint`} className="text-sm" />
          <p id={`${base}-hint`} className="m-0 text-sm text-quiet">
            One or more PDF, JPG, PNG or WebP files. Maximum 4 MB per file.
          </p>
          <div>
            <Button variant="secondary" size="sm" onClick={send} aria-disabled={pending || undefined}>
              {pending ? 'Attaching…' : 'Attach selected files'}
            </Button>
          </div>
          <div role="status" aria-live="polite">
            {results.length ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {results.map((r, i) => (
                  <li key={i} className={r.state.ok ? 'text-ink' : 'font-medium text-status-danger'}>
                    {r.name ? `${r.name}: ` : ''}
                    {r.state.ok ? 'attached. Reload to see it in the list.' : messageOf(r.state)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MarkDone({ ws, action, openCount }: { ws: FlightWorkspace; action: FlightWorkActions['complete']; openCount: number }) {
  const base = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const blocked = openCount > 0 || !ws.canComplete;
  const sectors = ws.flights.flatMap((f) => f.sectors.filter((s) => s.displayState === 'active')).sort(bySchedule);
  const pnrs = ws.ticketsByPnr.filter((g) => g.active).map((g) => g.airlinePnr);
  const tickets = ws.flights.reduce((n, f) => n + f.status.confirmed, 0);
  const expected = ws.flights.filter((f) => f.status.code !== 'done').map((f) => f.taskId);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        ref={trigger}
        variant="primary"
        size="lg"
        aria-disabled={blocked ? 'true' : undefined}
        aria-describedby={`${base}-why`}
        onClick={(e) => {
          if (blocked) {
            e.preventDefault();
            return;
          }
          setOpen(true);
        }}
      >
        <CheckCheck aria-hidden="true" />
        Mark flight done
      </Button>
      <p id={`${base}-why`} className="m-0 text-sm text-quiet">
        {blocked ? `${plural(openCount || 1, 'step')} still open (see the list above). ` : ''}
        {FLIGHT_TEXT.doneDialog}
      </p>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) requestAnimationFrame(() => trigger.current?.focus());
        }}
      >
        <DialogContent
          aria-describedby={`${base}-desc`}
          onOpenAutoFocus={(e) => {
            // Never start on the irreversible button: start on Cancel.
            e.preventDefault();
            document.getElementById(`${base}-cancel`)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark the flight done?</DialogTitle>
            <DialogDescription id={`${base}-desc`}>{FLIGHT_TEXT.doneDialog}</DialogDescription>
          </DialogHeader>
          <ActionForm action={action} fields={{ [FF.dealId]: ws.dealId, [FF.expectedTaskIds]: expected.join(',') }} label="Mark flight done" className="flex flex-col" onDone={() => setOpen(false)}>
            <DialogBody className="flex flex-col gap-3 text-sm">
              <p className="m-0">Deal {ws.dealReference}</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {sectors.map((s) => (
                  <li key={s.sectorId}>
                    {shortDate(s.departDate)} · {flightLabel(s.airline, s.flightNo)} · {routeText(s.from, s.to)}
                  </li>
                ))}
              </ul>
              <p className="m-0">
                {pnrs.length ? `PNR ${pnrs.join(', ')}` : 'No PNR'} · {plural(tickets, 'ticket')}
              </p>
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button id={`${base}-cancel`} variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Submit label="Mark flight done" pendingLabel="Saving…" />
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </div>
  );
}
