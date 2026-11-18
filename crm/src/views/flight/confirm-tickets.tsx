'use client';

import { CheckCheck, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Submit, type UiResult } from '@/views/accounts/supplier-forms';
import { FF, type FlightWorkActions } from './actions';
import { bySchedule, flightLabel, inr, routeText, shortDate } from './format';
import { ActionForm, messageOf } from './kit';
import { CRS_LABEL, CRS_TYPES, PAX_LABEL, PAX_ORDER } from './labels';
import { nextTicketNumber, normalizePnr, normalizeTicketNumber, PNR_PATTERN, rupeesToPaise, TICKET_PATTERN } from './parse';
import { useSelection } from './selection';
import { paiseToRupeesText } from './parse';
import type { CrsType, FareApproval, FareApprovalSet, FlightFarePreview, FlightSector, FlightSupplierOption, FlightWorkspace, PaxType } from './types';

/*
 * "Confirm tickets" popup (contract 11.1 and B8; prototype openClub FV:2036,
 * clubBody FV:1392, fv-club-confirm FV:2169), fixed: width min(76rem,
 * 100vw − 2rem) and every passenger line is a wrapping card, so nothing
 * scrolls sideways at 375 px; CRS type is a list of five; CRS PNR is hidden
 * for "Airline direct"; "+" copies a line with the next ticket number.
 * The fare breakup is per passenger type; Markup and Discount appear only on
 * flight-only Deals. The budget line comes from the server preview
 * (flight_fare_preview); above budget the Manager approves this exact fare
 * set first. The whole draft lives outside the dialog, so closing it,
 * a refusal or a Manager round trip keeps what was typed.
 */

type FareKey = 'basic' | 'k' | 'yq' | 'yr' | 'other' | 'markup' | 'discount';
const FARE_COLS: Array<{ key: FareKey; label: string }> = [
  { key: 'basic', label: 'Basic amount' },
  { key: 'k', label: 'K' },
  { key: 'yq', label: 'YQ' },
  { key: 'yr', label: 'YR' },
  { key: 'other', label: 'Other charges' },
  { key: 'markup', label: 'Markup' },
  { key: 'discount', label: 'Discount' },
];
const EMPTY_FARE: Record<FareKey, string> = { basic: '', k: '', yq: '', yr: '', other: '', markup: '', discount: '' };

interface Line {
  key: string;
  seq: number | null;
  crsType: CrsType | '';
  crsPnr: string;
  airlinePnr: string;
  ticketNumber: string;
  copied: boolean;
}

let lineCounter = 0;
const newLine = (over: Partial<Line> = {}): Line => ({ key: `l${++lineCounter}`, seq: null, crsType: '', crsPnr: '', airlinePnr: '', ticketNumber: '', copied: false, ...over });

function paise(v: string): bigint | null {
  const p = rupeesToPaise(v);
  return p === null ? null : BigInt(p);
}

export function ConfirmTicketsBar({
  ws,
  actions,
  suppliers: initialSuppliers,
  approvals,
  approvalSets = [],
  blockedReason,
}: {
  ws: FlightWorkspace;
  actions: FlightWorkActions;
  suppliers: FlightSupplierOption[];
  approvals: FareApproval[];
  /** The fare sets the Manager was asked about or approved (to reopen the popup with exactly those fares). */
  approvalSets?: FareApprovalSet[];
  /** Why Confirm tickets cannot open now (booking changed, not your flights). */
  blockedReason: string | null;
}) {
  const { selected, clear, replace } = useSelection();
  const reasonId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Draft (kept while the page is open).
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [fares, setFares] = useState<Record<PaxType, Record<FareKey, string>>>({ adult: { ...EMPTY_FARE }, child: { ...EMPTY_FARE }, infant: { ...EMPTY_FARE } });

  const allSectors = ws.flights.flatMap((f) => f.sectors);
  const ticked = allSectors.filter((s) => selected.includes(s.sectorId) && s.displayState === 'active').sort(bySchedule);
  const travellers = new Map(ws.flights.flatMap((f) => f.travellers).map((t) => [t.seq, t]));
  /** Travellers who still need a ticket on at least one ticked flight. */
  const eligible = [...new Set(ticked.flatMap((s) => s.travellers.filter((t) => !t.ticket && !t.held).map((t) => t.seq)))].filter((seq) => travellers.has(seq)).sort((a, b) => a - b);
  const coverOf = (seq: number) => ticked.filter((s) => s.travellers.some((t) => t.seq === seq && !t.ticket && !t.held)).length;
  const reason = blockedReason ?? (ticked.length === 0 ? 'Tick at least one flight in the itinerary first.' : eligible.length === 0 ? 'Everyone on the ticked flights already has a ticket.' : null);

  const openDialog = () => {
    setFlash(null);
    // Start with one line per traveller still to ticket, keeping lines already typed.
    setLines((cur) => {
      const kept = cur.filter((l) => l.seq !== null && eligible.includes(l.seq));
      const have = new Set(kept.map((l) => l.seq));
      const merged = [...kept, ...eligible.filter((s) => !have.has(s)).map((seq) => newLine({ seq }))];
      return merged.length ? merged : [newLine()];
    });
    setOpen(true);
  };

  // After the Manager approves, reopen the popup with exactly the approved fares (sectors, supplier, travellers, fares).
  const approvedSet = approvalSets.find((a) => a.status === 'approved');
  const applyApproved = (set: FareApprovalSet) => {
    replace(set.sectorIds);
    setSupplierId(set.supplierId);
    setLines((cur) => set.travellers.map((t) => cur.find((l) => l.seq === t.seq) ?? newLine({ seq: t.seq })));
    setFares((cur) => {
      const next = { ...cur };
      for (const f of set.fares) {
        next[f.paxType] = {
          basic: paiseToRupeesText(f.basicPaise) || '0',
          k: paiseToRupeesText(f.kPaise) || '0',
          yq: paiseToRupeesText(f.yqPaise) || '0',
          yr: paiseToRupeesText(f.yrPaise) || '0',
          other: paiseToRupeesText(f.otherPaise) || '0',
          markup: paiseToRupeesText(f.markupPaise) || '0',
          discount: paiseToRupeesText(f.discountPaise) || '0',
        };
      }
      return next;
    });
    setFlash(null);
    setOpen(true);
  };

  return (
    <section aria-labelledby="confirm-tickets-heading" className="flex flex-col gap-2 rounded-card border border-line bg-card px-4.5 py-4">
      <h2 id="confirm-tickets-heading" className="m-0 text-lg font-semibold text-ink">
        Confirm tickets
      </h2>
      <p className="m-0 text-copy">Tick the flights booked together on one ticket, then Confirm tickets. They get the same PNR and one ticket number per traveller.</p>
      <div role="status" aria-live="polite">
        {flash ? (
          <Notice tone="success">
            <p>{flash}</p>
          </Notice>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={triggerRef}
          variant="primary"
          size="lg"
          aria-disabled={reason ? 'true' : undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={(e) => {
            if (reason) {
              e.preventDefault();
              return;
            }
            openDialog();
          }}
        >
          <CheckCheck aria-hidden="true" />
          Confirm tickets{ticked.length ? ` · ${ticked.length} ${ticked.length === 1 ? 'flight' : 'flights'}` : ''}
        </Button>
        {reason ? (
          <p id={reasonId} className="m-0 text-sm text-quiet">
            {reason}
          </p>
        ) : null}
        {approvedSet && !blockedReason ? (
          <Button variant="secondary" onClick={() => applyApproved(approvedSet)}>
            Confirm with the approved fares (request {approvedSet.approvalNo})
          </Button>
        ) : null}
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      >
        {open ? (
          <ConfirmDialog
            ws={ws}
            actions={actions}
            ticked={ticked}
            eligible={eligible}
            coverOf={coverOf}
            travellers={travellers}
            suppliers={suppliers}
            onSupplierAdded={(s) => {
              setSuppliers((x) => [...x, s]);
              setSupplierId(s.supplierId);
            }}
            supplierId={supplierId}
            setSupplierId={setSupplierId}
            lines={lines}
            setLines={setLines}
            fares={fares}
            setFares={setFares}
            approvals={approvals}
            onConfirmed={(message) => {
              setOpen(false);
              setFlash(message);
              setLines([newLine()]);
              setFares({ adult: { ...EMPTY_FARE }, child: { ...EMPTY_FARE }, infant: { ...EMPTY_FARE } });
              clear();
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

function ConfirmDialog({
  ws,
  actions,
  ticked,
  eligible,
  coverOf,
  travellers,
  suppliers,
  onSupplierAdded,
  supplierId,
  setSupplierId,
  lines,
  setLines,
  fares,
  setFares,
  approvals,
  onConfirmed,
}: {
  ws: FlightWorkspace;
  actions: FlightWorkActions;
  ticked: FlightSector[];
  eligible: number[];
  coverOf: (seq: number) => number;
  travellers: Map<number, { seq: number; fullName: string; type: PaxType }>;
  suppliers: FlightSupplierOption[];
  onSupplierAdded: (s: FlightSupplierOption) => void;
  supplierId: string;
  setSupplierId: (v: string) => void;
  lines: Line[];
  setLines: React.Dispatch<React.SetStateAction<Line[]>>;
  fares: Record<PaxType, Record<FareKey, string>>;
  setFares: React.Dispatch<React.SetStateAction<Record<PaxType, Record<FareKey, string>>>>;
  approvals: FareApproval[];
  onConfirmed: (message: string) => void;
}) {
  const base = useId();
  const flightOnly = ws.dealKind === 'flight_only';
  const cols = FARE_COLS.filter((c) => flightOnly || (c.key !== 'markup' && c.key !== 'discount'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The preview answer is kept with the fare set it was asked for; a changed fare set shows nothing until the next answer.
  const [previewAnswer, setPreviewAnswer] = useState<{ key: string; data: FlightFarePreview | null; error: string | null } | null>(null);
  const [addingSupplier, setAddingSupplier] = useState(false);

  const typeOf = (seq: number | null) => (seq ? (travellers.get(seq)?.type ?? null) : null);
  const typesPresent = PAX_ORDER.filter((t) => lines.some((l) => typeOf(l.seq) === t));
  const counts = Object.fromEntries(PAX_ORDER.map((t) => [t, lines.filter((l) => typeOf(l.seq) === t).length])) as Record<PaxType, number>;

  const fareRows = typesPresent.map((t) => {
    const f = fares[t];
    const v = Object.fromEntries(FARE_COLS.map((c) => [c.key, paise(f[c.key])])) as Record<FareKey, bigint | null>;
    const supplier = (['basic', 'k', 'yq', 'yr', 'other'] as FareKey[]).reduce<bigint | null>((sum, k) => (sum === null || v[k] === null ? null : sum + v[k]!), 0n);
    const total = supplier === null ? null : flightOnly ? (v.markup === null || v.discount === null ? null : supplier + v.markup - v.discount) : supplier;
    return { type: t, supplier, total, count: counts[t], amount: total === null ? null : total * BigInt(counts[t]) };
  });
  const grand = fareRows.reduce<bigint | null>((s, r) => (s === null || r.amount === null ? null : s + r.amount), 0n);

  const faresPayload = typesPresent.map((t) => {
    const f = fares[t];
    const p = (k: FareKey) => rupeesToPaise(f[k]);
    return {
      paxType: t,
      basicPaise: p('basic'),
      kPaise: p('k'),
      yqPaise: p('yq'),
      yrPaise: p('yr'),
      otherPaise: p('other'),
      ...(flightOnly ? { markupPaise: p('markup'), discountPaise: p('discount') } : {}),
    };
  });
  const travellersPayload = lines.map((l) => ({
    seq: l.seq,
    crsType: l.crsType || null,
    crsPnr: l.crsType === 'airline_direct' ? null : normalizePnr(l.crsPnr) || null,
    airlinePnr: normalizePnr(l.airlinePnr),
    ticketNumber: normalizeTicketNumber(l.ticketNumber),
  }));
  const fareSetKey = JSON.stringify({ s: ticked.map((t) => t.sectorId), supplierId, faresPayload, t: lines.map((l) => l.seq) });
  const previewReady = !!supplierId && faresPayload.length > 0 && !faresPayload.some((f) => f.basicPaise === null || f.basicPaise === '0');
  const current = previewReady && previewAnswer?.key === fareSetKey ? previewAnswer : null;
  const preview = current?.data ?? null;
  const previewError = current?.error ?? null;
  const approvedMatching = preview?.approval && preview.approval.status === 'approved' ? preview.approval.approvalId : null;
  const pending = approvals.find((a) => a.status === 'pending');
  const lastApproved = approvals.find((a) => a.status === 'approved');

  // Live budget line: ask the server (no write) after typing pauses.
  useEffect(() => {
    if (!previewReady) return;
    let live = true;
    const key = fareSetKey;
    const timer = setTimeout(async () => {
      const fd = new FormData();
      fd.set(FF.dealId, ws.dealId);
      fd.set(FF.payload, JSON.stringify({ sectorIds: ticked.map((s) => s.sectorId), supplierId, fares: faresPayload, travellers: lines.filter((l) => l.seq).map((l) => ({ seq: l.seq })) }));
      try {
        const r = await actions.farePreview(null as never, fd);
        if (!live) return;
        setPreviewAnswer(r.ok ? { key, data: (r.data as FlightFarePreview) ?? null, error: null } : { key, data: null, error: messageOf(r) });
      } catch {
        if (live) setPreviewAnswer({ key, data: null, error: 'The budget check did not load. Confirming still checks it.' });
      }
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // fareSetKey covers every input of the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fareSetKey]);

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!supplierId) e.supplier = 'Choose who was paid (airline or consolidator).';
    const seen = new Map<string, number>();
    lines.forEach((l, i) => {
      const who = l.seq ? (travellers.get(l.seq)?.fullName ?? `Line ${i + 1}`) : `Line ${i + 1}`;
      const at = (k: string, m: string) => (e[`${i}-${k}`] = `${who}: ${m}`);
      if (!l.seq) at('seq', 'choose the traveller.');
      else if (lines.findIndex((x) => x.seq === l.seq) !== i) at('seq', 'this traveller is already on another line.');
      if (!l.crsType) at('crs', 'choose the CRS type.');
      if (l.crsType && l.crsType !== 'airline_direct' && !PNR_PATTERN.test(normalizePnr(l.crsPnr))) at('crsPnr', 'CRS PNR is 5 to 8 letters or digits.');
      if (!PNR_PATTERN.test(normalizePnr(l.airlinePnr))) at('airlinePnr', 'Airline PNR is 5 to 8 letters or digits.');
      const tn = normalizeTicketNumber(l.ticketNumber);
      if (!TICKET_PATTERN.test(tn)) at('ticket', 'ticket number is digits and single dashes, 6 to 20 characters.');
      else {
        const digits = tn.replace(/-/g, '');
        if (seen.has(digits)) at('ticket', 'this ticket number is on another line.');
        seen.set(digits, i);
      }
    });
    typesPresent.forEach((t) => {
      const f = fares[t];
      for (const c of cols) {
        if (f[c.key].trim() && rupeesToPaise(f[c.key]) === null) e[`fare-${t}-${c.key}`] = `${PAX_LABEL[t]} ${c.label}: a whole rupee amount (paise allowed), not negative.`;
      }
      if (!f.basic.trim()) e[`fare-${t}-basic`] = `${PAX_LABEL[t]}: enter the basic amount.`;
      const row = fareRows.find((r) => r.type === t);
      if (row && row.total !== null && row.total < 0n) e[`fare-${t}-discount`] = 'The discount is more than the fare.';
    });
    return e;
  };

  const overBudget = preview?.overBudget ?? false;
  // The budget check answers for exactly the fares on screen; until it has (or after any change), Confirm waits,
  // so the posted approval id is always the one the check found.
  const checking = previewReady && !current;
  const confirmBlocked = checking
    ? 'Checking the budget…'
    : overBudget && !approvedMatching
      ? pending
        ? 'The Manager has not decided these fares yet.'
        : 'Above the approved budget: ask the Manager to approve these fares first.'
      : null;
  const errorList = Object.entries(errors);

  return (
    <DialogContent className="max-w-[min(76rem,calc(100vw-2rem))]" aria-describedby={`${base}-desc`}>
      <DialogHeader>
        <DialogTitle>
          Confirm tickets · {ticked.length} {ticked.length === 1 ? 'flight' : 'flights'}
        </DialogTitle>
        <DialogDescription id={`${base}-desc`}>The same CRS type, PNRs and ticket number go on every ticked flight the traveller is on.</DialogDescription>
      </DialogHeader>
      <ActionForm
        action={actions.confirmTickets}
        fields={{
          [FF.dealId]: ws.dealId,
          [FF.payload]: JSON.stringify({ sectorIds: ticked.map((s) => s.sectorId), supplierId, fareApprovalId: approvedMatching, fares: faresPayload, travellers: travellersPayload }),
        }}
        label="Confirm tickets"
        failTitle="Nothing was confirmed"
        className="flex flex-col"
        onDone={(s: UiResult) => onConfirmed(s.ok ? s.message : '')}
        onSubmit={(e) => {
          const errs = validate();
          setErrors(errs);
          const first = Object.keys(errs)[0];
          if (first) {
            e.preventDefault();
            requestAnimationFrame(() => document.getElementById(`${base}-summary`)?.focus());
          } else if (confirmBlocked) {
            e.preventDefault();
          }
        }}
      >
        <DialogBody className="flex flex-col gap-5">
          {errorList.length ? (
            <div id={`${base}-summary`} tabIndex={-1} role="alert" className="rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 outline-none">
              <p className="m-0 font-semibold text-ink">Nothing was confirmed. Check these:</p>
              <ul className="m-0 mt-[0.25rem] list-disc pl-5 text-sm">
                {errorList.map(([k, v]) => (
                  <li key={k}>
                    <a href={`#${base}-${k}`} className="text-status-danger underline">
                      {v}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <section aria-labelledby={`${base}-flights`} className="flex flex-col gap-2">
            <h3 id={`${base}-flights`} className="m-0 text-sm font-semibold text-ink">
              Flights confirmed together
            </h3>
            <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-control border border-line p-0 text-sm">
              {ticked.map((s) => (
                <li key={s.sectorId} className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 px-3 py-2">
                  <span className="whitespace-nowrap">
                    {shortDate(s.departDate)} · {s.departTime ?? '—'} → {s.arriveTime ?? '—'}
                  </span>
                  <span className="font-semibold text-ink">{flightLabel(s.airline, s.flightNo)}</span>
                  <span>{routeText(s.from, s.to)}</span>
                  <span>{s.cabin ?? '—'}</span>
                  <span className="text-quiet">
                    To confirm:{' '}
                    {s.travellers
                      .filter((t) => !t.ticket && !t.held)
                      .map((t) => travellers.get(t.seq)?.fullName ?? `Traveller ${t.seq}`)
                      .join(', ') || 'nobody'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby={`${base}-supplier-h`} className="flex flex-col gap-2">
            <h3 id={`${base}-supplier-h`} className="m-0 text-sm font-semibold text-ink">
              Supplier
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${base}-supplier`} className="text-sm font-semibold text-ink">
                  Paid to (airline or consolidator)
                </label>
                <Select id={`${base}-supplier`} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} invalid={!!errors.supplier} className="w-full sm:w-auto sm:min-w-56">
                  <option value="">Choose a supplier</option>
                  {suppliers
                    .filter((s) => s.status === 'active')
                    .map((s) => (
                      <option key={s.supplierId} value={s.supplierId}>
                        {s.name}
                        {s.city ? ` · ${s.city}` : ''}
                      </option>
                    ))}
                </Select>
              </div>
              {!addingSupplier ? (
                <Button size="sm" variant="secondary" onClick={() => setAddingSupplier(true)}>
                  <Plus aria-hidden="true" />
                  Add supplier
                </Button>
              ) : null}
            </div>
            {addingSupplier ? <AddSupplierInline action={actions.createSupplier} onAdded={(s) => { onSupplierAdded(s); setAddingSupplier(false); }} onCancel={() => setAddingSupplier(false)} /> : null}
          </section>

          <section aria-labelledby={`${base}-pax`} className="flex flex-col gap-2">
            <h3 id={`${base}-pax`} className="m-0 text-sm font-semibold text-ink">
              Passengers
            </h3>
            {lines.length >= eligible.length ? (
              <p id={`${base}-all-lines`} className="m-0 text-xs text-quiet">
                Every traveller still to ticket already has a line, so “+” adds no more.
              </p>
            ) : null}
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {lines.map((l, i) => (
                <li key={l.key} className="m-0 rounded-control border border-line p-3">
                  <fieldset className="m-0 min-w-0 border-0 p-0">
                    <legend className="sr-only">Passenger line {i + 1}</legend>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(10rem,1.3fr)_auto]">
                      <LineField id={`${base}-${i}-seq`} label="Passenger" error={errors[`${i}-seq`]}>
                        <Select id={`${base}-${i}-seq`} value={l.seq ?? ''} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, seq: e.target.value ? Number(e.target.value) : null } : y)))} invalid={!!errors[`${i}-seq`]}>
                          <option value="">Choose</option>
                          {eligible.map((seq) => (
                            <option key={seq} value={seq}>
                              {travellers.get(seq)?.fullName} ({PAX_LABEL[travellers.get(seq)!.type]})
                            </option>
                          ))}
                        </Select>
                      </LineField>
                      <LineField id={`${base}-${i}-crs`} label="CRS type" error={errors[`${i}-crs`]}>
                        <Select id={`${base}-${i}-crs`} value={l.crsType} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, crsType: e.target.value as CrsType | '' } : y)))} invalid={!!errors[`${i}-crs`]}>
                          <option value="">Choose</option>
                          {CRS_TYPES.map((c) => (
                            <option key={c} value={c}>
                              {CRS_LABEL[c]}
                            </option>
                          ))}
                        </Select>
                      </LineField>
                      {l.crsType === 'airline_direct' ? (
                        <div className="flex flex-col gap-1 text-sm text-quiet">
                          <span className="font-semibold text-ink">CRS PNR</span>
                          <span className="py-2">Not needed for Airline direct</span>
                        </div>
                      ) : (
                        <LineField id={`${base}-${i}-crsPnr`} label="CRS PNR" error={errors[`${i}-crsPnr`]}>
                          <Input id={`${base}-${i}-crsPnr`} value={l.crsPnr} maxLength={8} className="uppercase" autoComplete="off" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, crsPnr: e.target.value } : y)))} invalid={!!errors[`${i}-crsPnr`]} />
                        </LineField>
                      )}
                      <LineField id={`${base}-${i}-airlinePnr`} label="Airline PNR" error={errors[`${i}-airlinePnr`]}>
                        <Input id={`${base}-${i}-airlinePnr`} value={l.airlinePnr} maxLength={8} className="uppercase" autoComplete="off" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, airlinePnr: e.target.value } : y)))} invalid={!!errors[`${i}-airlinePnr`]} />
                      </LineField>
                      <LineField id={`${base}-${i}-ticket`} label="Ticket number" error={errors[`${i}-ticket`]}>
                        <Input id={`${base}-${i}-ticket`} value={l.ticketNumber} maxLength={20} inputMode="numeric" autoComplete="off" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, ticketNumber: e.target.value } : y)))} invalid={!!errors[`${i}-ticket`]} />
                      </LineField>
                      <div className="flex flex-wrap items-end gap-2">
                        <span className="py-2 text-sm whitespace-nowrap text-quiet">{l.seq ? `${coverOf(l.seq)} of ${ticked.length} flights` : '—'}</span>
                        <Button
                          size="icon"
                          variant="secondary"
                          aria-label={`Copy line ${i + 1} for the next passenger`}
                          aria-disabled={lines.length >= eligible.length ? 'true' : undefined}
                          aria-describedby={lines.length >= eligible.length ? `${base}-all-lines` : undefined}
                          onClick={(e) => {
                            if (lines.length >= eligible.length) {
                              e.preventDefault();
                              return;
                            }
                            setLines((x) => {
                              const used = new Set(x.map((y) => y.seq));
                              const nextSeq = eligible.find((s) => !used.has(s)) ?? null;
                              const copy = newLine({ seq: nextSeq, crsType: l.crsType, crsPnr: l.crsPnr, airlinePnr: l.airlinePnr, ticketNumber: nextTicketNumber(l.ticketNumber) ?? '', copied: true });
                              return [...x.slice(0, i + 1), copy, ...x.slice(i + 1)];
                            });
                            // The new line's first field.
                            requestAnimationFrame(() => document.getElementById(`${base}-${i + 1}-seq`)?.focus());
                          }}
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                        {l.copied || lines.length > 1 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setLines((x) => x.filter((_, j) => j !== i));
                              // Focus the line that takes this place (or the one before when it was the last).
                              const next = i < lines.length - 1 ? i : i - 1;
                              requestAnimationFrame(() => document.getElementById(`${base}-${Math.max(0, next)}-seq`)?.focus());
                            }}
                          >
                            Remove<span className="sr-only"> line {i + 1}</span>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </fieldset>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby={`${base}-fare`} className="flex flex-col gap-2">
            <h3 id={`${base}-fare`} className="m-0 text-sm font-semibold text-ink">
              Fare per passenger
            </h3>
            <p className="m-0 text-sm text-quiet">Total = Basic + K + YQ + YR + Other charges{flightOnly ? ' + Markup − Discount' : ''}. It covers all the ticked flights.</p>
            {typesPresent.length === 0 ? <p className="m-0 text-sm text-quiet">Choose the passengers first.</p> : null}
            {typesPresent.map((t) => {
              const row = fareRows.find((r) => r.type === t)!;
              return (
                <fieldset key={t} className="m-0 min-w-0 rounded-control border border-line p-3">
                  <legend className="px-1 text-sm font-semibold text-ink">
                    {PAX_LABEL[t]} · {row.count} {row.count === 1 ? 'passenger' : 'passengers'}
                  </legend>
                  <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                    {cols.map((c) => (
                      <LineField key={c.key} id={`${base}-fare-${t}-${c.key}`} label={c.label} error={errors[`fare-${t}-${c.key}`]}>
                        <Input
                          id={`${base}-fare-${t}-${c.key}`}
                          inputMode="decimal"
                          placeholder="0"
                          value={fares[t][c.key]}
                          autoComplete="off"
                          onChange={(e) => setFares((x) => ({ ...x, [t]: { ...x[t], [c.key]: e.target.value } }))}
                          invalid={!!errors[`fare-${t}-${c.key}`]}
                          className="text-right tabular-nums"
                        />
                      </LineField>
                    ))}
                  </div>
                  <p className="m-0 mt-[0.5rem] text-right text-sm tabular-nums">
                    Total {row.total === null ? '—' : inr(row.total.toString())} × {row.count} = <strong className="text-ink">{row.amount === null ? '—' : inr(row.amount.toString())}</strong>
                  </p>
                </fieldset>
              );
            })}
            <p className="m-0 text-right font-semibold text-ink tabular-nums">Total for these tickets: {grand === null ? '—' : inr(grand.toString())}</p>
          </section>

          <section aria-label="Budget check" className="flex flex-col gap-2" aria-live="polite">
            {previewError ? (
              <Notice tone="warning" role="status">
                <p>{previewError}</p>
              </Notice>
            ) : preview ? (
              preview.overBudget ? (
                approvedMatching ? (
                  <Notice tone="success" role="status" title="The Manager approved these fares">
                    <p>Supplier cost after these tickets: {inr(preview.dealSupplierCostAfterPaise)} (budget {inr(preview.dealBudgetPaise, 'not set')}).</p>
                  </Notice>
                ) : (
                  <Notice tone="warning" icon={TriangleAlert} role="status" title={preview.dealBudgetPaise ? `Above the approved budget by ${inr((BigInt(preview.dealSupplierCostAfterPaise) - BigInt(preview.dealBudgetPaise)).toString())}` : 'No approved budget is set'}>
                    <p>The Manager must approve these fares before you confirm.</p>
                    {lastApproved && !approvedMatching ? <p>Changed after approval: the Manager approved different fares. Ask again.</p> : null}
                    {pending ? (
                      <p>Waiting for the Manager (request {pending.approvalNo}). Your typed details stay here.</p>
                    ) : (
                      <AskManager dealId={ws.dealId} action={actions.requestFareApproval} payload={JSON.stringify({ sectorIds: ticked.map((s) => s.sectorId), supplierId, fares: faresPayload, travellers: lines.filter((l) => l.seq).map((l) => ({ seq: l.seq })) })} />
                    )}
                  </Notice>
                )
              ) : (
                <Notice tone="info" role="status">
                  <p>
                    Within the approved budget: supplier cost after these tickets {inr(preview.dealSupplierCostAfterPaise)} of {inr(preview.dealBudgetPaise, 'no budget')}.
                  </p>
                </Notice>
              )
            ) : (
              <p className="m-0 text-sm text-quiet">The budget check appears after you choose the supplier and type the basic amounts.</p>
            )}
          </section>
        </DialogBody>
        <DialogFooter>
          {confirmBlocked ? (
            <p id={`${base}-blocked`} className="m-0 self-center text-sm text-quiet">
              {confirmBlocked}
            </p>
          ) : null}
          {confirmBlocked ? (
            <Button variant="primary" aria-disabled="true" aria-describedby={`${base}-blocked`} onClick={(e) => e.preventDefault()}>
              Confirm tickets
            </Button>
          ) : (
            <Submit label="Confirm tickets" pendingLabel="Confirming…" />
          )}
        </DialogFooter>
      </ActionForm>
    </DialogContent>
  );
}

function LineField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? <span className="text-sm font-medium text-status-danger">{error}</span> : null}
    </div>
  );
}

/** "Ask the Manager to approve" (B5): a separate small form inside the popup (never nested in the confirm form's fields). */
function AskManager({ dealId, action, payload }: { dealId: string; action: FlightWorkActions['requestFareApproval']; payload: string }) {
  const [state, setState] = useState<UiResult | null>(null);
  const [pending, setPending] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        aria-disabled={pending || undefined}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          const fd = new FormData();
          fd.set(FF.dealId, dealId);
          fd.set(FF.payload, payload);
          fd.set(FF.requestId, requestId);
          try {
            const r = await action(null as never, fd);
            setState(r);
            if (r.ok) setRequestId(crypto.randomUUID());
          } catch {
            setState({ ok: false, code: 'unexpected', message: 'We could not confirm the result. Reload the page to see what was saved.' });
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Asking…' : 'Ask the Manager to approve'}
      </Button>
      {state ? <p className={state.ok ? 'm-0 text-sm text-ink' : 'm-0 text-sm font-medium text-status-danger'} role={state.ok ? 'status' : 'alert'}>{messageOf(state)}</p> : null}
    </div>
  );
}

/** "+ Add supplier" (B2): name and city, inline in the popup. */
function AddSupplierInline({ action, onAdded, onCancel }: { action: FlightWorkActions['createSupplier']; onAdded: (s: FlightSupplierOption) => void; onCancel: () => void }) {
  const base = useId();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState<UiResult | null>(null);
  const [pending, setPending] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const send = async () => {
    if (pending) return;
    if (name.trim().length < 1) {
      setState({ ok: false, code: 'invalid_input', message: 'Type the supplier’s name.' });
      nameRef.current?.focus();
      return;
    }
    setPending(true);
    const fd = new FormData();
    fd.set(FF.payload, JSON.stringify({ name: name.trim(), city: city.trim() || null }));
    fd.set(FF.requestId, requestId);
    try {
      const r = await action(null as never, fd);
      setState(r);
      const data = r.ok ? (r.data as { supplierId?: string } | undefined) : undefined;
      if (r.ok && data?.supplierId) onAdded({ supplierId: data.supplierId, name: name.trim(), city: city.trim() || null, status: 'active', bankDetailsApproved: false });
    } catch {
      setState({ ok: false, code: 'unexpected', message: 'We could not confirm the result. Reload the page to see what was saved.' });
    } finally {
      setPending(false);
    }
  };
  // A div, not a form: it sits inside the Confirm tickets form.
  return (
    <div role="group" aria-labelledby={`${base}-h`} className="flex flex-col gap-2 rounded-control border border-line bg-wash p-3">
      <p id={`${base}-h`} className="m-0 text-sm font-semibold text-ink">
        New flight supplier
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <LineField id={`${base}-name`} label="Name">
          <Input id={`${base}-name`} ref={nameRef} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </LineField>
        <LineField id={`${base}-city`} label="City (optional)">
          <Input id={`${base}-city`} value={city} maxLength={80} onChange={(e) => setCity(e.target.value)} />
        </LineField>
      </div>
      <p className="m-0 text-xs text-quiet">Bank details are added later on the supplier and approved by a verifier.</p>
      {state && !state.ok ? (
        <p role="alert" className="m-0 text-sm font-medium text-status-danger">
          {messageOf(state)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={send} aria-disabled={pending || undefined}>
          {pending ? 'Adding…' : 'Add supplier'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
