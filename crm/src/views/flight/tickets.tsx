'use client';

import { Ticket } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Submit } from '@/views/accounts/supplier-forms';
import { formatIst } from '../deal-labels';
import { FF, type FlightWorkActions } from './actions';
import { bySchedule, flightLabel, plural, routeText, shortDate } from './format';
import { ActionForm } from './kit';
import { CRS_LABEL, CRS_TYPES, PAX_LABEL } from './labels';
import { normalizePnr, normalizeTicketNumber, PNR_PATTERN, ticketRangeText, TICKET_PATTERN } from './parse';
import type { CrsType, FlightSector, FlightWorkspace, PnrGroup, SectorTicket } from './types';

/*
 * Confirmed tickets (contract 11.1; prototype ticketsCard FV:1433): grouped
 * by Airline PNR (with CRS type and CRS PNR), flights date-sorted with the
 * airline code once, one row per traveller with the full ticket range. The
 * Flight assignee or the branch Manager may "Correct ticket" with a reason;
 * the old value stays in the list of revisions. Tickets on removed or
 * replaced flights are listed under "No longer active". No fares here.
 */

interface Pair {
  sector: FlightSector;
  seq: number;
  ticket: SectorTicket;
}

export function ConfirmedTicketsCard({ ws, actions }: { ws: FlightWorkspace; actions: FlightWorkActions }) {
  const sectors = new Map(ws.flights.flatMap((f) => f.sectors).map((s) => [s.sectorId, s]));
  const totalPairs = ws.flights.reduce((n, f) => n + f.status.required, 0);
  const confirmed = ws.flights.reduce((n, f) => n + f.status.confirmed, 0);
  const active = ws.ticketsByPnr.filter((g) => g.active);
  const old = ws.ticketsByPnr.filter((g) => !g.active);
  const pairsOf = (g: PnrGroup, seq: number): Pair[] =>
    g.sectors
      .map((x) => sectors.get(x.sectorId))
      .filter((s): s is FlightSector => !!s)
      .flatMap((s) => s.travellers.filter((t) => t.seq === seq && t.ticket).map((t) => ({ sector: s, seq, ticket: t.ticket! })));
  return (
    <Card id="tickets">
      <section aria-labelledby="tickets-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="tickets-heading">Confirmed tickets</CardTitle>
            <CardDescription>
              {plural(active.length, 'PNR')} · {confirmed} of {totalPairs} passenger tickets. Grouped by PNR: the flights it covers, then one row per traveller.
            </CardDescription>
          </div>
          <Ticket aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {ws.ticketsByPnr.length === 0 ? <p className="m-0 text-copy">No tickets confirmed yet.</p> : null}
          {active.map((g) => (
            <PnrBlock key={`${g.airlinePnr}-${g.confirmedAt}`} g={g} pairsOf={pairsOf} actions={actions} />
          ))}
          {old.length ? (
            <section aria-labelledby="tickets-old" className="flex flex-col gap-3">
              <h3 id="tickets-old" className="m-0 text-base font-semibold text-ink">
                No longer active
              </h3>
              <p className="m-0 text-sm text-quiet">Tickets on flights removed by a booking change or replaced by an approved change. They stay in the records.</p>
              {old.map((g) => (
                <PnrBlock key={`old-${g.airlinePnr}-${g.confirmedAt}`} g={g} pairsOf={pairsOf} actions={actions} muted />
              ))}
            </section>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function PnrBlock({ g, pairsOf, actions, muted }: { g: PnrGroup; pairsOf: (g: PnrGroup, seq: number) => Pair[]; actions: FlightWorkActions; muted?: boolean }) {
  const flights = [...g.sectors].sort(bySchedule);
  return (
    <section aria-label={`PNR ${g.airlinePnr}`} className={muted ? 'rounded-control border border-dashed border-line p-3 text-quiet' : 'rounded-control border border-line p-3'}>
      <h3 className="m-0 flex flex-wrap items-baseline gap-x-3 text-base font-semibold text-ink">
        <span>PNR {g.airlinePnr}</span>
        <span className="text-sm font-normal text-quiet">
          {CRS_LABEL[g.crsType]}
          {g.crsPnr ? ` · CRS PNR ${g.crsPnr}` : ''} · confirmed {formatIst(g.confirmedAt)}
        </span>
      </h3>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 text-sm">
        {flights.map((s) => (
          <li key={s.sectorId}>
            {shortDate(s.departDate)} · {s.departTime ?? '—'} · {flightLabel(s.airline ?? null, s.flightNo)} · {routeText(s.from, s.to)}
          </li>
        ))}
      </ul>
      <ul className="m-0 mt-[0.5rem] flex list-none flex-col divide-y divide-line border-t border-line p-0">
        {g.travellers.map((t) => {
          const pairs = pairsOf(g, t.seq);
          const changed = pairs.some((p) => p.ticket.travellerChanged);
          const canCorrect = pairs.some((p) => p.ticket.canCorrect);
          const history = pairs.flatMap((p) => p.ticket.history.filter((h) => h.revisionNo > 1).map((h) => ({ ...h, sector: p.sector })));
          return (
            <li key={t.seq} className="m-0 flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium text-ink">{t.name}</span> <span className="text-sm text-quiet">({PAX_LABEL[t.type]})</span>
                  <span className="block text-sm tabular-nums wrap-anywhere">Ticket {ticketRangeText(t.ticketNumbers)}</span>
                </span>
                {canCorrect && !muted ? <CorrectTicketDialog name={t.name} pairs={pairs.filter((p) => p.ticket.canCorrect)} action={actions.correctTicket} /> : null}
              </div>
              {changed ? (
                <Notice tone="warning" role="none">
                  <p>
                    <strong>Check: </strong>this traveller changed in the booking after ticketing. Correct the ticket.
                  </p>
                </Notice>
              ) : null}
              {history.length ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-brand-strong">Corrections ({history.length})</summary>
                  <ul className="m-0 mt-[0.25rem] flex list-none flex-col gap-1 p-0">
                    {history.map((h) => (
                      <li key={`${h.sector.sectorId}-${h.revisionNo}`}>
                        {flightLabel(h.sector.airline, h.sector.flightNo)}: revision {h.revisionNo} · {CRS_LABEL[h.crsType]} · PNR {h.airlinePnr} · ticket {h.ticketNumber} · {formatIst(h.at)}
                        {h.byName ? ` by ${h.byName}` : ''}
                        {h.reason ? ` · Reason: ${h.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CorrectTicketDialog({ name, pairs, action }: { name: string; pairs: Pair[]; action: FlightWorkActions['correctTicket'] }) {
  const base = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState(pairs[0]?.sector.sectorId ?? '');
  const pair = pairs.find((p) => p.sector.sectorId === which) ?? pairs[0]!;
  const [crsType, setCrsType] = useState<CrsType>(pair.ticket.crsType);
  const [crsPnr, setCrsPnr] = useState(pair.ticket.crsPnr ?? '');
  const [airlinePnr, setAirlinePnr] = useState(pair.ticket.airlinePnr);
  const [ticketNumber, setTicketNumber] = useState(pair.ticket.ticketNumber);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const payload = JSON.stringify({ crsType, crsPnr: crsType === 'airline_direct' ? null : normalizePnr(crsPnr), airlinePnr: normalizePnr(airlinePnr), ticketNumber: normalizeTicketNumber(ticketNumber) });
  const choose = (id: string) => {
    setWhich(id);
    const p = pairs.find((x) => x.sector.sectorId === id);
    if (!p) return;
    setCrsType(p.ticket.crsType);
    setCrsPnr(p.ticket.crsPnr ?? '');
    setAirlinePnr(p.ticket.airlinePnr);
    setTicketNumber(p.ticket.ticketNumber);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) requestAnimationFrame(() => trigger.current?.focus());
      }}
    >
      <Button ref={trigger} size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Correct ticket<span className="sr-only"> of {name}</span>
      </Button>
      <DialogContent aria-describedby={`${base}-desc`}>
        <DialogHeader>
          <DialogTitle>Correct the ticket of {name}</DialogTitle>
          <DialogDescription id={`${base}-desc`}>The old details stay in the record. Fares cannot be corrected here.</DialogDescription>
        </DialogHeader>
        <ActionForm
          action={action}
          fields={{ [FF.sectorId]: pair.sector.sectorId, [FF.travellerSeq]: pair.seq, [FF.expectedRevisionNo]: pair.ticket.revisionNo, [FF.payload]: payload, [FF.reason]: reason.trim() }}
          label={`Correct the ticket of ${name}`}
          className="flex flex-col"
          onDone={() => {
            setOpen(false);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (crsType !== 'airline_direct' && !PNR_PATTERN.test(normalizePnr(crsPnr))) errs.crsPnr = 'CRS PNR: 5 to 8 letters or digits.';
            if (!PNR_PATTERN.test(normalizePnr(airlinePnr))) errs.airlinePnr = 'Airline PNR: 5 to 8 letters or digits.';
            if (!TICKET_PATTERN.test(normalizeTicketNumber(ticketNumber))) errs.ticket = 'Ticket number: digits and single dashes, 6 to 20 characters.';
            const len = reason.trim().length;
            if (len < 10 || len > 300) errs.reason = 'Write a reason of 10 to 300 characters.';
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          <DialogBody className="flex flex-col gap-3">
            {pairs.length > 1 ? (
              <F id={`${base}-which`} label="Flight">
                <Select id={`${base}-which`} value={which} onChange={(e) => choose(e.target.value)}>
                  {pairs.map((p) => (
                    <option key={p.sector.sectorId} value={p.sector.sectorId}>
                      {shortDate(p.sector.departDate)} · {flightLabel(p.sector.airline, p.sector.flightNo)} · {routeText(p.sector.from, p.sector.to)}
                    </option>
                  ))}
                </Select>
              </F>
            ) : null}
            <F id={`${base}-crs`} label="CRS type">
              <Select id={`${base}-crs`} value={crsType} onChange={(e) => setCrsType(e.target.value as CrsType)}>
                {CRS_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {CRS_LABEL[c]}
                  </option>
                ))}
              </Select>
            </F>
            {crsType !== 'airline_direct' ? (
              <F id={`${base}-crsPnr`} label="CRS PNR" error={errors.crsPnr}>
                <Input id={`${base}-crsPnr`} value={crsPnr} maxLength={8} className="uppercase" onChange={(e) => setCrsPnr(e.target.value)} invalid={!!errors.crsPnr} />
              </F>
            ) : null}
            <F id={`${base}-airlinePnr`} label="Airline PNR" error={errors.airlinePnr}>
              <Input id={`${base}-airlinePnr`} value={airlinePnr} maxLength={8} className="uppercase" onChange={(e) => setAirlinePnr(e.target.value)} invalid={!!errors.airlinePnr} />
            </F>
            <F id={`${base}-ticket`} label="Ticket number" error={errors.ticket}>
              <Input id={`${base}-ticket`} value={ticketNumber} maxLength={20} inputMode="numeric" onChange={(e) => setTicketNumber(e.target.value)} invalid={!!errors.ticket} />
            </F>
            <F id={`${base}-reason`} label="Reason" error={errors.reason}>
              <Textarea id={`${base}-reason`} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!errors.reason} />
            </F>
          </DialogBody>
          <DialogFooter>
            <Submit label="Save correction" pendingLabel="Saving…" />
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function F({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? <span className="text-sm font-medium text-status-danger">{error}</span> : null}
    </div>
  );
}
