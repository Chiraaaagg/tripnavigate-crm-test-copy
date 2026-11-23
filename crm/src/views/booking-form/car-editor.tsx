'use client';

import { useEffect, useState } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Select } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { CAR_KIND_LABEL, CAR_KINDS, type CarEstimate, type CarKind } from '@/modules/fulfilment/booking-form-contract';
import { isIsoDate, paiseToRupeesText, rupeesToPaise } from '@/modules/fulfilment/booking-form-model';
import { loadAirports, type Airport } from '@/lib/airports/search';
import { MoneyField, TextField } from '../b11/controls';
import { dateText } from '../b11/book-fields';
import { refusalReason } from './autosave-queue';
import { useFormToast } from './form-toast';
import { appendParticipants, EditorShell, initialWho, useLiveProblem, WhoChips, type EditorEnv } from './service-editor';
import { carFillFromFlight, carKindOf, isScreenshotFlight, itemLabels, legsOf, str, type HotelStay } from './service-model';

/*
 * Car drawer (Book now v2, change 14). Car type is a switch: Airport pickup ·
 * Airport drop · Full trip · Point to point. Pickup, drop, date and time are
 * visible. Airport pickup: choose the flight it meets; pickup = the arrival
 * airport and flight number, date and time = landing, drop = the hotel for
 * that night. Airport drop: the reverse, with the pickup time 3 hours before
 * departure. A screenshot flight fills nothing. Every field stays editable.
 * Included kilometres and preferred vendor are no longer asked (kept on
 * older cars by the server); "Other" keeps its typed vehicle (lead ruling).
 */

const VEHICLES = ['Innova', 'Innova Crysta', 'Sedan', 'Tempo Traveller'];
const KIND_OPTIONS = CAR_KINDS.map((k) => ({ value: k, label: CAR_KIND_LABEL[k] }));

export function CarEditor({ env }: { env: EditorEnv }) {
  const toast = useFormToast();
  const src = env.item ?? env.copyOf;
  const f = src?.facts ?? null;
  const est = src?.estimate?.estimate?.kind === 'transfer' ? (src.estimate.estimate as CarEstimate) : null;
  const vehicle = str(f?.vehicleType);
  const [v, setV] = useState(() => ({
    kind: carKindOf(f),
    flight: str(f?.flightItemId),
    vehicleChoice: vehicle === '' ? '' : VEHICLES.includes(vehicle) ? vehicle : 'other',
    vehicle,
    qty: str(f?.quantity) || '1',
    pickup: str(f?.pickup),
    drop: str(f?.drop),
    date: str(f?.date) || env.trip.start,
    time: str(f?.pickupTime),
    route: str(f?.route),
    start: str(f?.date) || env.trip.start,
    end: str(f?.endDate) || (src ? '' : env.trip.end),
    rate: paiseToRupeesText(est?.vehicleRatePaise ?? null),
    notes: str(f?.notes),
    who: initialWho(env, 'transfer'),
  }));
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [busy, setBusy] = useState(false);
  const [airports, setAirports] = useState<Airport[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadAirports().then((a) => {
      if (live) setAirports(a);
    });
    return () => {
      live = false;
    };
  }, []);
  const full = v.kind === 'full_trip';
  const live = useLiveProblem(() =>
    !v.vehicle.trim()
      ? 'Choose the vehicle.'
      : full && !v.route.trim()
        ? 'Add the route.'
        : !full && (!v.pickup.trim() || !v.drop.trim())
          ? 'Add pickup and drop.'
          : !isIsoDate(full ? v.start : v.date)
            ? 'Add the date.'
            : full && v.end && v.end < v.start
              ? 'Tour end: on or after the start.'
              : v.rate.trim() !== '' && rupeesToPaise(v.rate) === undefined
                ? 'Enter a valid supplier rate.'
                : '',
  );
  const flights = env.items.filter((i) => i.serviceType === 'flight').sort((a, b) => a.itemNo - b.itemNo);
  const labels = itemLabels(env.items);
  const hotels: HotelStay[] = env.items.filter((i) => i.serviceType === 'hotel').map((h) => ({ hotelName: str(h.facts.hotelName), city: str(h.facts.city), checkIn: str(h.facts.checkIn), checkOut: str(h.facts.checkOut) }));
  const pickFlight = (id: string) => {
    set('flight', id);
    const fl = flights.find((x) => x.itemId === id);
    if (!fl || (v.kind !== 'airport_pickup' && v.kind !== 'airport_drop')) return;
    if (isScreenshotFlight(fl.facts)) {
      toast('This flight is a screenshot. Type the pickup, drop, date and time.');
      return;
    }
    const leg = legsOf(fl.facts)[0];
    if (!leg) return;
    const fill = carFillFromFlight(v.kind, leg, hotels, airports);
    setV((s) => ({ ...s, flight: id, ...(fill.pickup !== undefined ? { pickup: fill.pickup } : {}), ...(fill.drop !== undefined ? { drop: fill.drop } : {}), ...(fill.date ? { date: fill.date } : {}), ...(fill.time !== undefined ? { time: fill.time } : {}) }));
    toast('Filled from the flight and hotel. Check and change if needed.');
  };
  const flightOption = (fl: (typeof flights)[number]) => {
    const leg = legsOf(fl.facts)[0];
    const label = labels.get(fl.itemId) ?? 'Flight';
    if (isScreenshotFlight(fl.facts) || !leg) return `${label} · from screenshot`;
    const when = v.kind === 'airport_pickup' && leg.arriveTime ? ` · lands ${leg.arriveTime}` : v.kind === 'airport_drop' && leg.departTime ? ` · leaves ${leg.departTime}` : '';
    return `${label} · ${leg.from} – ${leg.to} · ${dateText(leg.date) ?? ''}${when}`;
  };

  const save = async () => {
    if (!live.gate()) return;
    setBusy(true);
    const r = await env.save((fd) => {
      fd.set('carKind', v.kind);
      fd.set('flightItemId', v.kind === 'airport_pickup' || v.kind === 'airport_drop' ? v.flight : '');
      fd.set('vehicleType', v.vehicle.trim());
      fd.set('quantity', v.qty.trim());
      if (full) {
        fd.set('route', v.route.trim());
        fd.set('date', v.start);
        fd.set('endDate', v.end);
      } else {
        fd.set('pickup', v.pickup.trim());
        fd.set('drop', v.drop.trim());
        fd.set('date', v.date);
        fd.set('pickupTime', v.time);
      }
      if (env.estimatesVisible) fd.set('vehicleRateRupees', v.rate.trim());
      fd.set('notes', v.notes);
      appendParticipants(fd, v.who);
    }, v);
    setBusy(false);
    if (r.ok) {
      toast('Car saved.');
      env.onClose();
    } else live.setServer(refusalReason(r));
  };

  const picker = v.kind === 'airport_pickup' || v.kind === 'airport_drop';
  return (
    <EditorShell title={env.item ? 'Edit car' : 'Add car'} saveLabel="Save car" editable={env.editable} busy={busy} problem={live.problem} onSave={save} onClose={env.onClose}>
      <div className="flex flex-col gap-1.5">
        <span id="svc-carKind-label" className="font-semibold text-ink">
          Type of car booking
        </span>
        <SegmentedControl<CarKind> id="svc-carKind" labelledBy="svc-carKind-label" options={KIND_OPTIONS} value={v.kind} onChange={(k) => set('kind', k)} disabled={!env.editable} className="self-start" />
      </div>
      {full ? (
        <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
          <TextField id="svc-date" name="date" label="Tour start" type="date" value={v.start} onChange={(x) => set('start', x)} disabled={!env.editable} />
          <TextField id="svc-endDate" name="endDate" label="Tour end" type="date" min={v.start || undefined} value={v.end} onChange={(x) => set('end', x)} disabled={!env.editable} />
          <Field htmlFor="svc-route" label="Route" className="min-[381px]:col-span-2">
            <Input id="svc-route" value={v.route} onChange={(e) => set('route', e.target.value)} maxLength={250} placeholder="For example: Jodhpur – Jaisalmer – Jodhpur" disabled={!env.editable} />
          </Field>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
          {picker ? (
            <Field htmlFor="svc-flightItemId" label={<>{v.kind === 'airport_pickup' ? 'Meets which flight' : 'For which flight'} <span className="font-normal text-quiet">(fills the rest)</span></>} className="min-[381px]:col-span-2">
              {flights.length > 0 ? (
                <Select id="svc-flightItemId" value={v.flight} onChange={(e) => pickFlight(e.target.value)} disabled={!env.editable}>
                  <option value="">Choose a flight</option>
                  {flights.map((fl) => (
                    <option key={fl.itemId} value={fl.itemId}>
                      {flightOption(fl)}
                    </option>
                  ))}
                </Select>
              ) : (
                <p id="svc-flightItemId" className="m-0 text-sm text-quiet">
                  Add the flights first and this fills itself. Or type below.
                </p>
              )}
            </Field>
          ) : null}
          <TextField id="svc-pickup" name="pickup" label="Pickup" value={v.pickup} onChange={(x) => set('pickup', x)} maxLength={200} disabled={!env.editable} />
          <TextField id="svc-drop" name="drop" label="Drop" value={v.drop} onChange={(x) => set('drop', x)} maxLength={200} disabled={!env.editable} />
          <TextField id="svc-date" name="date" label="Date" type="date" value={v.date} onChange={(x) => set('date', x)} disabled={!env.editable} />
          <TextField id="svc-pickupTime" name="pickupTime" label="Pickup time" type="time" value={v.time} onChange={(x) => set('time', x)} disabled={!env.editable} />
          {v.kind === 'airport_drop' ? <p className="m-0 text-sm text-quiet min-[381px]:col-span-2">Pickup time is set 3 hours before the flight. Change it if needed.</p> : null}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Field htmlFor="svc-vehicleType" label="Vehicle">
            <Select
              id="svc-vehicleType"
              value={v.vehicleChoice}
              disabled={!env.editable}
              onChange={(e) => {
                const next = e.target.value;
                setV((s) => ({ ...s, vehicleChoice: next, vehicle: next === 'other' ? (VEHICLES.includes(s.vehicle) ? '' : s.vehicle) : next }));
                if (next === 'other') requestAnimationFrame(() => document.getElementById('svc-vehicleOther')?.focus());
              }}
            >
              <option value="">Choose</option>
              {VEHICLES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
              <option value="other">Other (type it)</option>
            </Select>
          </Field>
          {v.vehicleChoice === 'other' ? <TextField id="svc-vehicleOther" name="vehicleType" label="Other vehicle" maxLength={60} value={v.vehicle} onChange={(x) => set('vehicle', x)} disabled={!env.editable} /> : null}
        </div>
        <Field htmlFor="svc-quantity" label="Number of vehicles">
          <NumberStepper id="svc-quantity" name="quantity" min={1} max={100} value={v.qty} onChange={(x) => set('qty', x)} unitLabel={{ decrease: 'One vehicle fewer', increase: 'One vehicle more' }} statusLabel="Number of vehicles: " disabled={!env.editable} />
        </Field>
        {env.estimatesVisible ? <MoneyField id="svc-vehicleRateRupees" name="vehicleRateRupees" label={full ? 'Rate per vehicle (whole trip) ₹' : 'Rate per vehicle ₹'} optional value={v.rate} onChange={(x) => set('rate', x)} disabled={!env.editable} /> : null}
      </div>
      <WhoChips env={env} label="Who rides" value={v.who} onChange={(x) => set('who', x)} />
      <TextField id="svc-notes" name="notes" label="Remarks" optional hint="Purchase reads this. Do not type the customer price." value={v.notes} onChange={(x) => set('notes', x)} maxLength={2000} disabled={!env.editable} />
    </EditorShell>
  );
}
