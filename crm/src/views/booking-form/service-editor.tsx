'use client';

import { CalendarDays, FileText, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Notice } from '@/components/ui/notice';
import { NumberStepper } from '@/components/ui/number-stepper';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Select } from '@/components/ui/select';
import {
  SERVICE_ITEM_FILE_MAX_BYTES,
  SERVICE_ITEM_FILE_TYPES,
  SERVICE_ITEM_FILES_PER_ITEM,
  type BookingFormServiceItemView,
  type HotelEstimate,
  type CarEstimate,
  type FlightEstimate,
} from '@/modules/fulfilment/booking-form-contract';
import { addDays, carEstimatePaise, flightEstimatePaise, formatInr, hotelEstimatePaise, isIsoDate, paiseToRupeesText, parseCount, rupeesToPaise, stayNights } from '@/modules/fulfilment/booking-form-model';
import type { BookTravellerView, ServiceType } from '@/modules/fulfilment/contracts';
import { AreaField, MoneyField, SelectField, TextField } from '../b11/controls';
import { B11_DEPARTMENT, B11_DEPARTMENT_LABEL } from '../b11/book-fields';
import { factsToFormValues, hasBudget, SERVICE_FIELDS, type ServiceFieldDef } from '../b11/service-fields';
import { useSectionForm } from '../b11/draft-sync';
import { ResultBox, useB11Action, PendingButton, type FieldRef } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { errFor, useRequestId, useShownRefusal } from './form-helpers';
import { SERVICE_KIND_LABEL } from './service-labels';
import type { HotelOption, SearchAction } from './vn-types';

/*
 * Service editor drawer of step 2 (approved preview HotelEditor, CarEditor,
 * FlightEditor, OtherEditor). Voice-note batch (24 October 2026): the hotel
 * shows every stored fact in one place (no "More details", no adults input:
 * an existing stay keeps its stored adults, a new one takes the booking's
 * adults), the hotel name searches the stored hotel list when it is wired,
 * the car has a vehicle list with "Other" and a − / + quantity, and the
 * flight chooses its passengers in a searchable list with "Attach ticket
 * screenshot" beside it. The other services keep their remaining stored
 * facts (further flight legs, pickup and drop, budget) in a closed "More
 * details" group so nothing is dropped (contract §2.3). One form, one save
 * (booking_service_save: facts, estimate, budget and participation in one
 * transaction). Supplier estimates are cost only, never a price; unknown
 * stays "Not priced". Car is the existing transfer service.
 */

export interface EditorDefaults {
  tripStart: string;
  tripEnd: string;
  /** Typed party (adults default the hotel adults; total defaults flight and activity people). */
  adults: number | null;
  total: number | null;
  /** Check-out of the last hotel (the next stay starts there). */
  lastCheckOut: string | null;
}

interface Seg {
  from: string;
  to: string;
  date: string;
  flex: string;
  arrivalDate: string;
  airline: string;
  flightNo: string;
  departTime: string;
  arriveTime: string;
}

interface EditorValues {
  values: Record<string, string>;
  segments: Seg[];
  seqs: number[];
}

const MEAL_PLANS = ['Room only', 'Breakfast', 'Breakfast + dinner', 'All meals', 'Other'];
const VEHICLES = ['Innova', 'Innova Crysta', 'Sedan', 'Tempo Traveller'];
/** Server limit of the vehicle type (contracts L.vehicleType). */
const VEHICLE_TYPE_MAX = 60;
const vehicleChoiceOf = (v: string) => (v === '' ? '' : VEHICLES.includes(v) ? v : 'other');
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function initialValues(type: ServiceType, item: BookingFormServiceItemView | null, copyOf: BookingFormServiceItemView | null, d: EditorDefaults, budgetVisible: boolean): EditorValues {
  const src = item ?? copyOf;
  const facts = src?.facts ?? null;
  const values = factsToFormValues(type, facts, budgetVisible ? paiseToRupeesText(src?.purchaseBudgetPaise ?? null) : '');
  const est = src?.estimate?.estimate ?? null;
  if (type === 'hotel') {
    const h = est?.kind === 'hotel' ? (est as HotelEstimate) : null;
    values.roomRateRupees = paiseToRupeesText(h?.roomRatePaise ?? null);
    values.extraBedRateRupees = paiseToRupeesText(h?.extraBedRatePaise ?? null);
    values.noBedRateRupees = paiseToRupeesText(h?.noBedRatePaise ?? null);
    const nights = stayNights(values.checkIn, values.checkOut);
    values.nights = nights === null ? '' : String(nights);
    values.hotelId = s(facts?.hotelId);
    if (!src) {
      values.checkIn = d.lastCheckOut ?? d.tripStart;
      values.rooms = '1';
    }
    // Adults are not asked here (owner item 4): a saved stay keeps its stored number; a new stay takes the booking's adults (the server defaults it too).
    if (!values.adults) values.adults = d.adults !== null && d.adults > 0 ? String(d.adults) : '';
    values.extraBeds ||= '0';
    values.childrenWithoutBed ||= '0';
  } else if (type === 'transfer') {
    const c = est?.kind === 'transfer' ? (est as CarEstimate) : null;
    values.vehicleRateRupees = paiseToRupeesText(c?.vehicleRatePaise ?? null);
    values.endDate = s(facts?.endDate);
    values.quantity = facts?.quantity === undefined || facts?.quantity === null ? '1' : s(facts.quantity);
    values.includedKms = s(facts?.includedKms);
    values.vendor = s(facts?.vendor);
    values.route = s(facts?.route);
    values.vehicleChoice = vehicleChoiceOf(values.vehicleType ?? '');
    if (!src) {
      values.date = d.tripStart;
      values.endDate = d.tripEnd;
    }
  } else if (type === 'flight') {
    const f = est?.kind === 'flight' ? (est as FlightEstimate) : null;
    values.fareTotalRupees = paiseToRupeesText(f?.fareTotalPaise ?? null);
    if (!src) {
      values.tripType = 'one_way';
      values.passengers = d.total ? String(d.total) : '';
    }
  } else if (type === 'activity' && !src) {
    values.participants = d.total ? String(d.total) : '';
  }
  const raw = Array.isArray(facts?.segments) ? (facts!.segments as Array<Record<string, unknown>>) : [];
  const segments: Seg[] =
    type === 'flight'
      ? (raw.length > 0 ? raw : [{}]).map((g, i) => ({
          from: s(g.from),
          to: s(g.to),
          date: s(g.date) || (!src && i === 0 ? d.tripStart : ''),
          flex: s(g.flex),
          arrivalDate: s(g.arrivalDate),
          airline: s(g.airline),
          flightNo: s(g.flightNo),
          departTime: s(g.departTime),
          arriveTime: s(g.arriveTime),
        }))
      : [];
  return { values, segments, seqs: item ? (item.participants ?? []) : [] };
}

/**
 * Free-text fields the department reads (copy P-04, privacy P8 / T-B4-21): the
 * hint asks Sales not to type the customer price where Purchase, Flight or the
 * Visa desk will read it.
 */
export const DEPARTMENT_READS_HINT: Record<ServiceType, string> = {
  hotel: 'Purchase reads this. Do not type the customer price.',
  transfer: 'Purchase reads this. Do not type the customer price.',
  activity: 'Purchase reads this. Do not type the customer price.',
  flight: 'Flight reads this. Do not type the customer price.',
  visa: 'The Visa desk reads this. Do not type the customer price.',
  passport: 'The Visa desk reads this. Do not type the customer price.',
};

/** Main (preview) field names per type; the rest of SERVICE_FIELDS goes under More details. */
const MAIN: Record<ServiceType, readonly string[]> = {
  hotel: ['city', 'hotelName', 'preferences', 'checkIn', 'checkOut', 'rooms', 'roomType', 'mealPlan', 'extraBeds', 'childrenWithoutBed', 'specialRequests'],
  transfer: ['date', 'vehicleType', 'notes'],
  flight: ['cabin', 'passengers', 'notes', 'tripType'],
  activity: ['name', 'date', 'city', 'participants', 'notes'],
  visa: ['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes'],
  passport: ['applicationType', 'neededBy', 'officeCity', 'notes'],
};

const EDITOR_TITLE: Record<ServiceType, [string, string]> = {
  hotel: ['Add hotel stay', 'Edit hotel stay'],
  transfer: ['Add car', 'Edit car'],
  flight: ['Add flight', 'Edit flight'],
  activity: ['Add activity', 'Edit activity'],
  visa: ['Visa requirements', 'Visa requirements'],
  passport: ['Passport requirements', 'Passport requirements'],
};

const SAVE_LABEL: Record<ServiceType, string> = {
  hotel: 'Save hotel',
  transfer: 'Save car',
  flight: 'Save flight',
  activity: 'Save activity',
  visa: 'Save requirements',
  passport: 'Save requirements',
};

/** Local checks before anything is sent (preview editor errors); the server checks again. */
function localProblem(type: ServiceType, v: EditorValues, choosePassengers: boolean): { text: string; fieldId: string } | null {
  const x = v.values;
  const money = (k: string) => x[k] !== undefined && x[k].trim() !== '' && rupeesToPaise(x[k]) === undefined;
  if (type === 'hotel') {
    const n = parseCount(x.nights);
    const named = x.mode === 'preferences' ? x.preferences?.trim() : x.hotelName?.trim();
    if (!x.city?.trim() || !named || !isIsoDate(x.checkIn) || n === null || n < 1 || n > 365 || !parseCount(x.rooms)) {
      return { text: 'Add city, hotel, check-in, nights and at least one room.', fieldId: !x.city?.trim() ? 'svc-city' : !named ? 'svc-hotelName' : !isIsoDate(x.checkIn) ? 'svc-checkIn' : n === null || n < 1 || n > 365 ? 'svc-nights' : 'svc-rooms' };
    }
    const kids = parseCount(x.children || '0');
    if (kids !== null && kids > 0 && !x.childAges?.trim()) return { text: 'Enter the age of each child in this stay.', fieldId: 'svc-childAges' };
    for (const k of ['roomRateRupees', 'extraBedRateRupees', 'noBedRateRupees']) if (money(k)) return { text: 'Enter a valid amount, with at most two decimal places.', fieldId: `svc-${k}` };
  }
  if (type === 'transfer') {
    const q = parseCount(x.quantity);
    if (x.vehicleChoice === 'other' && !x.vehicleType?.trim()) return { text: 'Type the vehicle, or choose one from the list.', fieldId: 'svc-vehicleOther' };
    if (!x.vehicleType?.trim() || q === null || q < 1 || q > 100 || !isIsoDate(x.date) || (x.endDate && x.endDate < x.date)) {
      return { text: 'Add a vehicle, the number of vehicles and valid dates.', fieldId: !x.vehicleType?.trim() ? 'svc-vehicleType' : q === null || q < 1 || q > 100 ? 'svc-quantity' : 'svc-date' };
    }
    if (!x.route?.trim() && !(x.pickup?.trim() && x.drop?.trim())) return { text: 'Add the route, or both pickup and drop under More details.', fieldId: 'svc-route' };
    if (money('vehicleRateRupees')) return { text: 'Enter a valid supplier rate.', fieldId: 'svc-vehicleRateRupees' };
  }
  if (type === 'flight') {
    const g = v.segments[0];
    if (!g || !g.from.trim() || !g.to.trim() || !isIsoDate(g.date)) return { text: 'Add travel date, departure and arrival city.', fieldId: !g?.from.trim() ? 'svc-seg-1-from' : !g.to.trim() ? 'svc-seg-1-to' : 'svc-seg-1-date' };
    for (const [i, seg] of v.segments.entries()) if (seg.arrivalDate && seg.date && seg.arrivalDate < seg.date) return { text: 'Arrival date cannot be before departure.', fieldId: `svc-seg-${i + 1}-arrivalDate` };
    if (choosePassengers && v.seqs.length === 0) return { text: 'Choose the passengers who fly.', fieldId: 'svc-who' };
    if (!choosePassengers && !parseCount(x.passengers)) return { text: 'Enter how many passengers fly.', fieldId: 'svc-passengers' };
    if (money('fareTotalRupees')) return { text: 'Enter valid flight amounts.', fieldId: 'svc-fareTotalRupees' };
  }
  if (type === 'activity' && (!x.name?.trim() || !x.city?.trim() || !isIsoDate(x.date) || !parseCount(x.participants))) {
    return { text: 'Add the activity, city, date and how many people take part.', fieldId: !x.name?.trim() ? 'svc-name' : !x.city?.trim() ? 'svc-city' : !isIsoDate(x.date) ? 'svc-date' : 'svc-participants' };
  }
  if (type === 'visa' && (!x.country?.trim() || !isIsoDate(x.travelDate))) return { text: 'Add the country and the planned travel date.', fieldId: !x.country?.trim() ? 'svc-country' : 'svc-travelDate' };
  if (type === 'passport' && !x.officeCity?.trim()) return { text: 'Add the passport office city.', fieldId: 'svc-officeCity' };
  return null;
}

function GenericFact({ def, value, onChange, error, disabled }: { def: ServiceFieldDef; value: string; onChange: (v: string) => void; error: string | null; disabled: boolean }) {
  const common = { id: `svc-${def.name}`, name: def.name, label: def.label, value, onChange, hint: def.hint, error, optional: !def.required, disabled, className: def.wide ? 'min-[381px]:col-span-2' : undefined };
  if (def.control === 'select') return <SelectField {...common} options={def.options ?? []} />;
  if (def.control === 'textarea') return <AreaField {...common} rows={2} maxLength={2000} />;
  return <TextField {...common} type={def.control === 'number' ? 'number' : def.control} min={def.min} max={def.max} />;
}

export function ServiceEditorDrawer({
  view,
  type,
  item,
  copyOf = null,
  defaults,
  budgetVisible,
  estimatesVisible,
  travellers,
  action,
  fileActions,
  filesEditable,
  reloadHref,
  onClose,
  searchHotels = null,
  onSavedAttach,
  focusAttach = false,
}: {
  view: BookNowView;
  type: ServiceType;
  item: BookingFormServiceItemView | null;
  /** "Duplicate": a new stay starting from these facts. */
  copyOf?: BookingFormServiceItemView | null;
  defaults: EditorDefaults;
  budgetVisible: boolean;
  estimatesVisible: boolean;
  travellers: BookTravellerView[];
  action: B11Action;
  fileActions: { upload: B11Action; remove: B11Action };
  /** May attach and remove flight screenshots (itemFilesCanEdit). */
  filesEditable: boolean;
  reloadHref: string;
  onClose: () => void;
  /** Stored hotel list search; null = the hotel name is typed only. */
  searchHotels?: SearchAction<HotelOption> | null;
  /** "Save and attach screenshot" on a new flight: the saved item's id, so the drawer reopens on it. */
  onSavedAttach?: (itemId: string) => void;
  /** Reopened after "Save and attach screenshot": focus the attach button. */
  focusAttach?: boolean;
}) {
  const thenAttach = useRef(false);
  const editable = view.canEdit && view.version?.status === 'draft' && !view.dealNotActive && !(item?.locked ?? false);
  const f = useSectionForm({
    id: item ? `svc-${item.itemId}` : `svc-new-${type}`,
    section: 'services',
    label: item ? `${SERVICE_KIND_LABEL[type]} ${item.itemNo}` : `New ${SERVICE_KIND_LABEL[type].toLowerCase()}`,
    order: 40,
    action,
    initial: initialValues(type, item, copyOf, defaults, budgetVisible),
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: true,
    onSuccess: (r) => {
      const savedId = r.ok ? (r as { data?: { itemId?: unknown } }).data?.itemId : undefined;
      if (thenAttach.current && typeof savedId === 'string' && onSavedAttach) {
        thenAttach.current = false;
        onSavedAttach(savedId);
        return;
      }
      onClose();
    },
  });
  const { bindForm, bindResult } = f;
  const v = f.values.values;
  const segs = f.values.segments;
  const seqs = f.values.seqs;
  const [local, setLocal] = useState<{ text: string; fieldId: string } | null>(null);
  const set = (k: string, x: string) => f.setValues((st) => ({ ...st, values: { ...st.values, [k]: x } }));
  const setSeg = (i: number, patch: Partial<Seg>) => f.setValues((st) => ({ ...st, segments: st.segments.map((g, j) => (j === i ? { ...g, ...patch } : g)) }));
  const requestId = useRequestId(f.state);
  const refusal = useShownRefusal(f, (name) => {
    const m = /^segment(\w+)\[(\d+)\]$/.exec(name);
    if (m) {
      const key = (m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1)) as keyof Seg;
      const i = Number(m[2]);
      return (v: EditorValues) => v.segments[i]?.[key];
    }
    if (name === 'participantSeq') return (v: EditorValues) => v.seqs;
    return (v: EditorValues) => v.values[name];
  });
  const fields = refusal.fields;
  const defs = SERVICE_FIELDS[type].filter((d) => !d.when || d.when(v));
  const refs: FieldRef[] = [
    ...defs.map((d) => ({ field: d.name, id: `svc-${d.name}`, label: `${d.label}: check the value.` })),
    { field: 'nights', id: 'svc-nights', label: 'Nights: 1 to 365.' },
    { field: 'roomRateRupees', id: 'svc-roomRateRupees', label: 'Room / night: rupees, 0 or more, up to 2 decimals.' },
    { field: 'extraBedRateRupees', id: 'svc-extraBedRateRupees', label: 'Extra bed / night: rupees, 0 or more, up to 2 decimals.' },
    { field: 'noBedRateRupees', id: 'svc-noBedRateRupees', label: 'No-bed guest / night: rupees, 0 or more, up to 2 decimals.' },
    { field: 'vehicleRateRupees', id: 'svc-vehicleRateRupees', label: 'Rate per vehicle: rupees, 0 or more, up to 2 decimals.' },
    { field: 'fareTotalRupees', id: 'svc-fareTotalRupees', label: 'Estimated fare: rupees, 0 or more, up to 2 decimals.' },
    { field: 'endDate', id: 'svc-endDate', label: 'Tour end: on or after the start, within the trip.' },
    { field: 'quantity', id: 'svc-quantity', label: 'Number of vehicles: 1 to 100.' },
    { field: 'includedKms', id: 'svc-includedKms', label: 'Included kilometres: a whole number from 0 to 100,000.' },
    { field: 'vendor', id: 'svc-vendor', label: 'Preferred vendor: up to 150 characters.' },
    { field: 'route', id: 'svc-route', label: 'Route: add the route, or both pickup and drop.' },
    { field: 'purchaseBudgetRupees', id: 'svc-budget', label: 'Budget: rupees with up to 2 decimals.' },
    { field: 'participantSeq', id: 'svc-who', label: type === 'flight' ? 'Choose the passengers who fly.' : 'Who takes part: choose the passengers.' },
    { field: 'adults', id: 'svc-adults', label: 'Adults: set the passenger counts in step 1.' },
    { field: 'hotelId', id: 'svc-hotelName', label: 'Choose the hotel again from the list, or type its name.' },
    { field: 'passengers', id: travellers.length > 0 ? 'svc-who' : 'svc-passengers', label: 'Passengers: choose who flies.' },
    ...segs.flatMap((_, j) => [
      { field: `segmentFrom[${j}]`, id: `svc-seg-${j + 1}-from`, label: `Leg ${j + 1}: from.` },
      { field: `segmentTo[${j}]`, id: `svc-seg-${j + 1}-to`, label: `Leg ${j + 1}: to (different from "from").` },
      { field: `segmentDate[${j}]`, id: `svc-seg-${j + 1}-date`, label: `Leg ${j + 1}: departure date within the trip.` },
      { field: `segmentArrivalDate[${j}]`, id: `svc-seg-${j + 1}-arrivalDate`, label: `Leg ${j + 1}: arrival date on or after departure.` },
      { field: `segmentAirline[${j}]`, id: `svc-seg-${j + 1}-airline`, label: `Leg ${j + 1}: airline up to 60 characters.` },
      { field: `segmentFlightNo[${j}]`, id: `svc-seg-${j + 1}-flightNo`, label: `Leg ${j + 1}: flight number up to 12 characters.` },
    ]),
  ];
  const err = errFor(refs, fields);
  const localErr = (id: string) => (local?.fieldId === id ? local.text : null);
  const e2 = (name: string, id = `svc-${name}`) => err(name) ?? localErr(id);

  const nights = parseCount(v.nights);
  const checkOut = type === 'hotel' && isIsoDate(v.checkIn) && nights !== null && nights >= 1 && nights <= 365 ? addDays(v.checkIn, nights) : '';
  const estimate = (() => {
    const p = (k: string) => {
      const r = rupeesToPaise(v[k] ?? '');
      return typeof r === 'string' ? r : null;
    };
    if (type === 'hotel') return hotelEstimatePaise({ nights: v.nights ?? null, rooms: v.rooms ?? null, extraBeds: v.extraBeds || '0', noBedGuests: v.childrenWithoutBed || '0', roomRatePaise: p('roomRateRupees'), extraBedRatePaise: p('extraBedRateRupees'), noBedRatePaise: p('noBedRateRupees') });
    if (type === 'transfer') return carEstimatePaise(v.quantity ?? null, p('vehicleRateRupees'));
    if (type === 'flight') return flightEstimatePaise(p('fareTotalRupees'));
    return null;
  })();
  const main = new Set(MAIN[type]);
  const extraDefs = defs
    .filter((d) => !main.has(d.name) && !(type === 'flight' && d.name === 'tripType'))
    // Car: either the route or both pickup and drop (server rule), so neither is required on its own.
    .map((d) => (type === 'transfer' && (d.name === 'pickup' || d.name === 'drop') ? { ...d, required: false } : d));
  const showWho = travellers.length > 0;
  const whoInMain = type !== 'transfer';
  const passport = type === 'passport';
  const desk = B11_DEPARTMENT[type] === 'visa';
  const choosePassengers = type === 'flight' && showWho;
  const [attachNote, setAttachNote] = useState(focusAttach);
  useEffect(() => {
    if (focusAttach) requestAnimationFrame(() => document.getElementById('svc-attach')?.focus());
  }, [focusAttach]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    thenAttach.current = submitter?.getAttribute('name') === 'thenAttach';
    const problem = localProblem(type, f.values, choosePassengers);
    if (problem) {
      e.preventDefault();
      setLocal(problem);
      requestAnimationFrame(() => document.getElementById(problem.fieldId)?.focus());
      return;
    }
    setLocal(null);
    // Submitted by hand, not through the form action (React's form reset would blank the selects on a refusal).
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (thenAttach.current) fd.set('thenAttach', '1');
    void f.post(fd);
  };

  const field = (name: string) => defs.find((d) => d.name === name);
  const fact = (name: string, override?: Partial<ServiceFieldDef> & { className?: string }) => {
    const d = field(name);
    if (!d) return null;
    const def = { ...d, ...override } as ServiceFieldDef;
    return <GenericFact key={name} def={def} value={v[name] ?? ''} onChange={(x) => set(name, x)} error={e2(name)} disabled={!editable} />;
  };
  const money = (name: string, label: string, hint?: string) => (
    <MoneyField id={`svc-${name}`} name={name} label={label} hint={hint} optional value={v[name] ?? ''} onChange={(x) => set(name, x)} error={e2(name)} disabled={!editable} />
  );

  const whoOptions = [...travellers]
    .sort((a, b) => a.seq - b.seq)
    .map((t) => ({ value: String(t.seq), label: t.fullName || `Passenger ${t.seq}`, hint: t.type === 'adult' ? 'Adult' : t.type === 'child' ? 'Child' : 'Infant' }));
  const whoLabel = passport ? 'Applicant' : type === 'flight' ? 'Passengers flying' : type === 'hotel' ? 'Passengers in this stay' : 'Passengers';
  const whoErr = err('participantSeq') ?? err('passengers') ?? localErr('svc-who');
  const who = showWho ? (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id="svc-who-label" className="font-semibold text-ink">
        {whoLabel}
        {type === 'flight' ? null : <span className="font-normal text-quiet"> (optional)</span>}
      </span>
      <MultiSelect
        id="svc-who"
        labelId="svc-who-label"
        options={whoOptions}
        selected={seqs.map(String)}
        onChange={(next) => f.setValues((st) => ({ ...st, seqs: next.map(Number).sort((a, b) => a - b) }))}
        placeholder={passport ? 'Choose the applicant' : 'Choose passengers'}
        noun="passengers"
        single={passport}
        invalid={Boolean(whoErr)}
        disabled={!editable}
        aria-describedby={fieldDescribedBy('svc-who', { hint: type === 'flight', error: whoErr })}
      />
      {type === 'flight' ? (
        <p id="svc-who-hint" className="m-0 text-sm text-quiet" aria-live="polite">
          {seqs.length === 0 ? 'Nobody chosen yet.' : `${seqs.length} of ${travellers.length} ${travellers.length === 1 ? 'passenger flies' : 'passengers fly'}.`}
        </p>
      ) : null}
      {whoErr ? (
        <p id="svc-who-error" className="m-0 text-sm font-medium text-status-danger">
          {whoErr}
        </p>
      ) : null}
      {seqs.map((q) => (
        <input key={q} type="hidden" name="participantSeq" value={q} />
      ))}
    </div>
  ) : null;

  const attach =
    type !== 'flight' || !editable ? null : item ? (
      filesEditable ? (
        <Button id="svc-attach" variant="secondary" className="min-h-11" onClick={() => document.getElementById('svc-screenshot')?.click()}>
          <Paperclip aria-hidden="true" />
          Attach ticket screenshot
        </Button>
      ) : null
    ) : (
      <Button id="svc-attach" type="submit" name="thenAttach" value="1" variant="secondary" className="h-auto min-h-11 py-2 whitespace-normal">
        <Paperclip aria-hidden="true" />
        Save and attach screenshot
      </Button>
    );

  const budgetField = hasBudget(type) ? (
    <MoneyField
      id="svc-budget"
      name="purchaseBudgetRupees"
      label={type === 'flight' ? 'Flight budget ₹' : 'Purchase budget ₹'}
      hint="What the department may spend. Not copied from the estimate."
      optional
      value={v.purchaseBudgetRupees ?? ''}
      onChange={(x) => set('purchaseBudgetRupees', x)}
      error={e2('purchaseBudgetRupees', 'svc-budget')}
      disabled={!editable}
    />
  ) : null;

  const FORM = 'svc-editor-form';
  const title = EDITOR_TITLE[type][item ? 1 : 0];
  return (
    <Drawer
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DrawerContent className="w-[min(42.5rem,100vw)] max-sm:rounded-none" closeLabel="Close without saving">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          <DrawerDescription className={type === 'flight' ? 'm-0 text-sm text-quiet' : 'sr-only'}>
            {type === 'flight' ? 'Requested flight, not an issued ticket.' : `Details for ${B11_DEPARTMENT_LABEL[B11_DEPARTMENT[type]]}. Nothing is booked here.`}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-5">
          <form id={FORM} ref={bindForm} onSubmit={submit} noValidate aria-label={title} className="flex flex-col gap-5">
            <div ref={bindResult} className="[&:has(>[role=status]:empty)]:hidden">
              {local ? (
                <p role="alert" className="m-0 rounded-control border border-status-danger-line bg-status-danger-tint px-3 py-2.5 text-sm text-status-danger-strong">
                  {local.text}
                </p>
              ) : (
                <ResultBox result={refusal.shown} fields={refs} reloadHref={reloadHref} />
              )}
            </div>
            <input type="hidden" name="dealId" value={view.dealId} />
            <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
            <input type="hidden" name="rowVersion" value={f.base} readOnly />
            <input type="hidden" name="requestId" value={requestId} />
            {/* The service parser reads the type on every save (add and edit). */}
            <input type="hidden" name="serviceType" value={type} />
            {item ? <input type="hidden" name="itemId" value={item.itemId} /> : null}
            {desk && !view.visaPassportTasksEnabled ? <Notice tone="info">Recorded now. The Visa &amp; Passport desk gets this task when the desk is launched.</Notice> : null}

            {type === 'hotel' ? (
              <HotelMain
                v={v}
                set={set}
                e2={e2}
                editable={editable}
                fact={fact}
                checkOut={checkOut}
                estimatesVisible={estimatesVisible}
                estimate={estimate}
                searchHotels={searchHotels}
                savedAdults={Boolean(item)}
                who={who}
                budget={budgetVisible ? budgetField : null}
              />
            ) : null}
            {type === 'transfer' ? (
              <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
                <TextField id="svc-date" name="date" label="Tour start" type="date" value={v.date ?? ''} onChange={(x) => set('date', x)} error={e2('date')} disabled={!editable} />
                <TextField id="svc-endDate" name="endDate" label="Tour end" type="date" min={v.date || undefined} value={v.endDate ?? ''} onChange={(x) => set('endDate', x)} error={e2('endDate')} disabled={!editable} />
                <VehicleField v={v} setValues={(patch) => f.setValues((st) => ({ ...st, values: { ...st.values, ...patch } }))} e2={e2} editable={editable} />
                <Field htmlFor="svc-quantity" label="Number of vehicles" error={e2('quantity') ?? undefined}>
                  <NumberStepper
                    id="svc-quantity"
                    name="quantity"
                    min={1}
                    max={100}
                    value={v.quantity ?? ''}
                    onChange={(x) => set('quantity', x)}
                    unitLabel={{ decrease: 'One vehicle fewer', increase: 'One vehicle more' }}
                    statusLabel="Number of vehicles: "
                    invalid={Boolean(e2('quantity'))}
                    aria-describedby={fieldDescribedBy('svc-quantity', { error: e2('quantity') })}
                    disabled={!editable}
                  />
                </Field>
                {estimatesVisible ? money('vehicleRateRupees', 'Rate per vehicle (whole trip) ₹') : null}
                <TextField id="svc-includedKms" name="includedKms" label="Included kilometres" type="number" min={0} max={100000} optional value={v.includedKms ?? ''} onChange={(x) => set('includedKms', x)} error={e2('includedKms')} disabled={!editable} />
                <TextField id="svc-vendor" name="vendor" label="Preferred vendor" optional maxLength={150} value={v.vendor ?? ''} onChange={(x) => set('vendor', x)} error={e2('vendor')} disabled={!editable} />
                <TextField id="svc-route" name="route" label="Route" hint="Or add pickup and drop under More details." maxLength={250} value={v.route ?? ''} onChange={(x) => set('route', x)} error={e2('route')} className="min-[381px]:col-span-2" disabled={!editable} />
                {estimatesVisible ? (
                  <EstimateBox className="min-[381px]:col-span-2" total={estimate} line={estimate ? `${v.quantity} vehicles × ${formatInr(rupeesToPaise(v.vehicleRateRupees ?? '') ?? null)} = ${formatInr(estimate)}` : null} />
                ) : null}
                {fact('notes', { label: 'Remarks', wide: true, hint: DEPARTMENT_READS_HINT.transfer })}
              </div>
            ) : null}
            {type === 'flight' ? (
              <FlightMain segs={segs} setSeg={setSeg} v={v} set={set} e2={e2} editable={editable} fact={fact} estimatesVisible={estimatesVisible} money={money} who={who} attach={attach} attachNote={attachNote ? 'Flight saved. Now attach the ticket screenshot.' : null} choosePassengers={choosePassengers} seqCount={seqs.length} />
            ) : null}
            {type === 'activity' || type === 'visa' || type === 'passport' ? (
              <div className="flex flex-col gap-5">
                <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
                  {type === 'activity' ? (
                    <>
                      {fact('name', { label: 'Activity', wide: true })}
                      {fact('date', { label: 'Required date' })}
                      {fact('city', { label: 'City / location' })}
                      {fact('participants')}
                    </>
                  ) : type === 'visa' ? (
                    <>
                      {fact('purpose', { label: 'Visa type' })}
                      {fact('country', { label: 'Country' })}
                      {fact('applyBy', { label: 'Required date', hint: 'Apply by, if known. May be before the trip.' })}
                      {fact('travelDate')}
                      {fact('feePaidBy', { wide: true })}
                    </>
                  ) : (
                    <>
                      {fact('applicationType')}
                      {fact('neededBy', { label: 'Required date', hint: 'May be before the trip.' })}
                      {fact('officeCity', { label: 'City / location', hint: 'The passport office city.' })}
                    </>
                  )}
                </div>
                {who}
                {fact('notes', { label: 'Requirements', wide: true, hint: DEPARTMENT_READS_HINT[type] })}
              </div>
            ) : null}

            {type !== 'hotel' ? (
              <details className="group/more border-t border-line pt-4">
                <summary className={cn('w-fit cursor-pointer rounded-chip text-sm font-medium text-brand-strong group-open/more:mb-4', focusRing)}>More details</summary>
                <div className="flex flex-col gap-5">
                  <p className="m-0 text-sm text-quiet">Goes to: {B11_DEPARTMENT_LABEL[B11_DEPARTMENT[type]]}</p>
                  {extraDefs.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
                      {extraDefs.map((d) => (
                        <GenericFact key={d.name} def={d} value={v[d.name] ?? ''} onChange={(x) => set(d.name, x)} error={e2(d.name)} disabled={!editable} />
                      ))}
                    </div>
                  ) : null}
                  {type === 'flight' ? <FlightMore segs={segs} setSegs={(fn) => f.setValues((st) => ({ ...st, segments: fn(st.segments) }))} setSeg={setSeg} v={v} set={set} e2={e2} editable={editable} /> : null}
                  {!whoInMain ? who : null}
                  {hasBudget(type) && budgetVisible ? <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">{budgetField}</div> : null}
                </div>
              </details>
            ) : null}
            {type === 'hotel' ? <input type="hidden" name="checkOut" value={checkOut} /> : null}
          </form>
          {type === 'flight' && item ? <FlightFiles view={view} item={item} editable={filesEditable} actions={fileActions} onAttached={() => setAttachNote(false)} /> : null}
        </DrawerBody>
        <DrawerFooter className="sticky bottom-0 bg-card">
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
            {editable ? (
              <SubmitFor form={FORM} label={SAVE_LABEL[type]} />
            ) : null}
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** The drawer footer button submits the editor form (outside it, so useFormStatus cannot see it; the label stays). */
function SubmitFor({ form, label }: { form: string; label: string }) {
  return (
    <Button type="submit" form={form} variant="primary">
      {label}
    </Button>
  );
}

function EstimateBox({ total, line, className }: { total: string | null; line: string | null; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-control bg-wash p-3.5 text-sm', className)} aria-live="polite">
      <span className="text-quiet">Estimated supplier cost</span>
      <strong className="text-xl font-semibold text-ink tabular-nums">{formatInr(total)}</strong>
      {line ? <span className="text-quiet tabular-nums">{line}</span> : null}
      <span className="text-quiet">An estimate only. It is not a price, a budget or a booking.</span>
    </div>
  );
}

type FactFn = (name: string, override?: Partial<ServiceFieldDef>) => ReactNode;
type ErrFn = (name: string, id?: string) => string | null;

function HotelMain({
  v,
  set,
  e2,
  editable,
  fact,
  checkOut,
  estimatesVisible,
  estimate,
  searchHotels,
  savedAdults,
  who,
  budget,
}: {
  v: Record<string, string>;
  set: (k: string, x: string) => void;
  e2: ErrFn;
  editable: boolean;
  fact: FactFn;
  checkOut: string;
  estimatesVisible: boolean;
  estimate: string | null;
  searchHotels: SearchAction<HotelOption> | null;
  /** True for a saved stay (its stored adults), false for a new one (the booking's adults). */
  savedAdults: boolean;
  who: ReactNode;
  budget: ReactNode;
}) {
  const named = v.mode === 'preferences';
  const mealOptions = [{ value: '', label: 'Choose' }, ...MEAL_PLANS.map((m) => ({ value: m, label: m })), ...(v.mealPlan && !MEAL_PLANS.includes(v.mealPlan) ? [{ value: v.mealPlan, label: v.mealPlan }] : [])];
  const rate = (k: string) => formatInr((rupeesToPaise(v[k] ?? '') as string | null | undefined) ?? null);
  const line = estimate
    ? `${v.nights} nights × (${v.rooms} rooms × ${rate('roomRateRupees')} + ${v.extraBeds || 0} extra beds × ${rate('extraBedRateRupees')} + ${v.childrenWithoutBed || 0} no-bed guests × ${rate('noBedRateRupees')}) = ${formatInr(estimate)}`
    : null;
  const rows = [
    { qty: 'rooms', rate: 'roomRateRupees', label: 'Rooms', rateLabel: 'Room / night', min: 1, max: 50 },
    { qty: 'extraBeds', rate: 'extraBedRateRupees', label: 'Extra beds', rateLabel: 'Extra bed / night', min: 0, max: 20 },
    { qty: 'childrenWithoutBed', rate: 'noBedRateRupees', label: 'No bed', rateLabel: 'No-bed guest / night', min: 0, max: 20 },
  ];
  const hotelErr = e2('hotelName') ?? e2('hotelId', 'svc-hotelName');
  const adultsErr = e2('adults');
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        {fact('mode')}
        {fact('city')}
        {named ? (
          fact('preferences', { label: 'Hotel (acceptable options)', wide: true })
        ) : searchHotels ? (
          <Field htmlFor="svc-hotelName" label="Hotel" hint="Type 2 letters to search the hotel list." error={hotelErr ?? undefined}>
            <SearchCombobox<HotelOption>
              id="svc-hotelName"
              name="hotelName"
              value={v.hotelName ?? ''}
              onValueChange={(x) => {
                set('hotelName', x);
                if (v.hotelId) set('hotelId', '');
              }}
              search={(q) => searchHotels(q, { city: v.city ?? '' })}
              keyOf={(h) => h.hotelId}
              textOf={(h) => [h.name, h.city, h.area, h.category].filter(Boolean).join(', ')}
              renderOption={(h) => (
                <>
                  <span className="font-semibold text-ink">{h.name}</span>
                  <span className="text-sm text-quiet">{[h.city, h.area, h.category].filter(Boolean).join(' · ')}</span>
                </>
              )}
              onPick={(h) => {
                set('hotelName', h.name);
                set('hotelId', h.hotelId);
                if (!v.city?.trim() || v.city.trim().toLowerCase() !== h.city.toLowerCase()) set('city', h.city);
                if (h.area && !v.area?.trim()) set('area', h.area);
              }}
              noMatchText="Not in the hotel list. Keep typing the name; Purchase checks it."
              maxLength={200}
              invalid={Boolean(hotelErr)}
              aria-describedby={fieldDescribedBy('svc-hotelName', { hint: true, error: hotelErr })}
              disabled={!editable}
            />
          </Field>
        ) : (
          fact('hotelName', { label: 'Hotel', hint: undefined })
        )}
        {fact('area')}
        <TextField id="svc-checkIn" name="checkIn" label="Check-in" type="date" value={v.checkIn ?? ''} onChange={(x) => set('checkIn', x)} error={e2('checkIn')} disabled={!editable} />
        <TextField id="svc-nights" name="nights" label="Nights" type="number" min={1} max={365} value={v.nights ?? ''} onChange={(x) => set('nights', x)} error={e2('nights')} disabled={!editable} />
      </div>
      <input type="hidden" name="hotelId" value={named ? '' : (v.hotelId ?? '')} />
      <p className="m-0 flex items-center gap-1.5 text-sm text-quiet" aria-live="polite">
        <CalendarDays aria-hidden="true" className="size-3.5" />
        Check-out: {checkOut ? new Date(`${checkOut}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Set check-in and nights'}
      </p>
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        {fact('roomType', { label: 'Room category' })}
        <SelectField id="svc-mealPlan" name="mealPlan" label="Meal plan" optional value={v.mealPlan ?? ''} onChange={(x) => set('mealPlan', x)} options={mealOptions} error={e2('mealPlan')} disabled={!editable} />
      </div>
      <div className="border-t border-line pt-5">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <h3 className="m-0 text-base font-semibold text-ink">{estimatesVisible ? 'Rooms and nightly rates' : 'Rooms and beds'}</h3>
          {estimatesVisible ? <span className="text-sm text-quiet">INR · per night</span> : null}
        </div>
        <div className={cn('grid items-center gap-x-3 gap-y-2', estimatesVisible ? 'grid-cols-[minmax(6rem,1.1fr)_4.125rem_minmax(6.25rem,1fr)] max-sm:grid-cols-[minmax(4.5rem,0.9fr)_2.875rem_minmax(5.5rem,1fr)] max-sm:gap-2' : 'grid-cols-[minmax(6rem,1fr)_5rem]')}>
          <span />
          <span className="text-sm font-medium text-quiet">Qty</span>
          {estimatesVisible ? <span className="text-sm font-medium text-quiet">Our cost</span> : null}
          {rows.map((r) => (
            <div key={r.qty} className="contents">
              <label htmlFor={`svc-${r.qty}`} className="text-sm font-medium text-copy">
                {r.label}
              </label>
              <Input
                id={`svc-${r.qty}`}
                name={r.qty}
                type="number"
                inputMode="numeric"
                min={r.min}
                max={r.max}
                aria-label={`${r.label} quantity`}
                value={v[r.qty] ?? ''}
                onChange={(e) => set(r.qty, e.target.value)}
                invalid={Boolean(e2(r.qty))}
                aria-describedby={e2(r.qty) ? `svc-${r.qty}-error` : undefined}
                disabled={!editable}
              />
              {estimatesVisible ? (
                <MoneyInput
                  id={`svc-${r.rate}`}
                  name={r.rate}
                  aria-label={`${r.rateLabel}, rupees`}
                  value={v[r.rate] ?? ''}
                  onChange={(e) => set(r.rate, e.target.value)}
                  invalid={Boolean(e2(r.rate))}
                  aria-describedby={e2(r.rate) ? `svc-${r.rate}-error` : undefined}
                  disabled={!editable}
                />
              ) : null}
            </div>
          ))}
        </div>
        {(['rooms', 'extraBeds', 'childrenWithoutBed', 'roomRateRupees', 'extraBedRateRupees', 'noBedRateRupees'] as const).map((k) =>
          e2(k) ? (
            <p key={k} id={`svc-${k}-error`} className="m-0 mt-[0.5rem] text-sm font-medium text-status-danger">
              {e2(k)}
            </p>
          ) : null,
        )}
        {estimatesVisible ? <EstimateBox className="mt-4" total={estimate} line={line} /> : null}
        <div className="mt-4">{fact('bedRemarks', { wide: true })}</div>
      </div>
      <div className="grid grid-cols-1 gap-4 border-t border-line pt-5 min-[381px]:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="font-semibold text-ink">Adults</span>
          <p id="svc-adults" tabIndex={-1} className="m-0 flex min-h-10 items-center text-base text-ink outline-none" aria-describedby={adultsErr ? 'svc-adults-error' : undefined}>
            {v.adults ? (
              <>
                <span className="font-semibold tabular-nums">{v.adults}</span>
                <span className="ml-1.5 text-sm text-quiet">{savedAdults ? '(saved with this stay)' : '(from the booking)'}</span>
              </>
            ) : (
              <span className="text-quiet">Set the passenger counts in step 1</span>
            )}
          </p>
          {adultsErr ? (
            <p id="svc-adults-error" className="m-0 text-sm font-medium text-status-danger">
              {adultsErr}
            </p>
          ) : null}
          <input type="hidden" name="adults" value={v.adults ?? ''} />
        </div>
        {fact('children', { label: 'Children in this stay' })}
        {fact('childAges', { wide: true })}
      </div>
      {who}
      <div className="grid grid-cols-1 gap-4 border-t border-line pt-5 min-[381px]:grid-cols-2">
        {fact('inclusions', { wide: false })}
        {fact('exclusions', { wide: false })}
        {fact('specialRequests', { label: 'Special request', wide: true, hint: DEPARTMENT_READS_HINT.hotel })}
      </div>
      {budget ? <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">{budget}</div> : null}
    </div>
  );
}

/** Vehicle type: a list with a visible arrow, plus "Other" with a typed name (owner item 6). */
function VehicleField({ v, setValues, e2, editable }: { v: Record<string, string>; setValues: (patch: Record<string, string>) => void; e2: ErrFn; editable: boolean }) {
  const choice = v.vehicleChoice ?? vehicleChoiceOf(v.vehicleType ?? '');
  const err = e2('vehicleType');
  const otherErr = e2('vehicleOther', 'svc-vehicleOther');
  return (
    <div className="flex flex-col gap-3">
      <Field htmlFor="svc-vehicleType" label="Vehicle" error={err ?? undefined}>
        <Select
          id="svc-vehicleType"
          value={choice}
          invalid={Boolean(err)}
          aria-describedby={fieldDescribedBy('svc-vehicleType', { error: err })}
          disabled={!editable}
          onChange={(e) => {
            const next = e.target.value;
            setValues({ vehicleChoice: next, vehicleType: next === 'other' ? (VEHICLES.includes(v.vehicleType ?? '') ? '' : (v.vehicleType ?? '')) : next });
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
      {choice === 'other' ? (
        <TextField id="svc-vehicleOther" name="vehicleType" label="Other vehicle" maxLength={VEHICLE_TYPE_MAX} value={v.vehicleType ?? ''} onChange={(x) => setValues({ vehicleType: x })} error={otherErr} disabled={!editable} />
      ) : (
        <input type="hidden" name="vehicleType" value={v.vehicleType ?? ''} />
      )}
    </div>
  );
}

function FlightMain({
  segs,
  setSeg,
  v,
  e2,
  editable,
  fact,
  estimatesVisible,
  money,
  who,
  attach,
  attachNote,
  choosePassengers,
  seqCount,
}: {
  segs: Seg[];
  setSeg: (i: number, patch: Partial<Seg>) => void;
  v: Record<string, string>;
  set: (k: string, x: string) => void;
  e2: ErrFn;
  editable: boolean;
  fact: FactFn;
  estimatesVisible: boolean;
  money: (name: string, label: string, hint?: string) => ReactNode;
  who: ReactNode;
  attach: ReactNode;
  attachNote: string | null;
  /** Passengers are named: the number flying follows the chosen passengers. */
  choosePassengers: boolean;
  seqCount: number;
}) {
  const g: Seg = segs[0] ?? { from: '', to: '', date: '', flex: '', arrivalDate: '', airline: '', flightNo: '', departTime: '', arriveTime: '' };
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        <SegFields g={g} i={0} setSeg={setSeg} e2={e2} editable={editable} />
        <TextField id="svc-seg-1-departTime" name="segmentDepartTime" label="Departure time (local)" type="time" optional value={g.departTime} onChange={(x) => setSeg(0, { departTime: x })} disabled={!editable} />
        <TextField id="svc-seg-1-arriveTime" name="segmentArriveTime" label="Arrival time (local)" type="time" optional value={g.arriveTime} onChange={(x) => setSeg(0, { arriveTime: x })} disabled={!editable} />
        {fact('cabin')}
        {estimatesVisible ? money('fareTotalRupees', 'Estimated fare (total) ₹', 'An estimate only. It is not a price, a budget or a booking.') : null}
      </div>
      <div className="flex flex-col gap-3 rounded-control border border-line p-4 max-sm:p-3">
        {choosePassengers ? who : fact('passengers', { label: 'Passengers flying', hint: 'Name the passengers in step 1 to choose them here.' })}
        {choosePassengers ? <input type="hidden" name="passengers" value={seqCount > 0 ? String(seqCount) : ''} /> : null}
        {attach ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {attach}
            <span className="text-sm text-quiet">A screenshot is not an issued ticket.</span>
          </div>
        ) : null}
        {attachNote ? (
          <p role="status" className="m-0 text-sm font-medium text-copy">
            {attachNote}
          </p>
        ) : null}
      </div>
      {fact('notes', { label: 'Remarks', wide: true, hint: DEPARTMENT_READS_HINT.flight })}
      <input type="hidden" name="tripType" value={v.tripType ?? 'one_way'} />
    </div>
  );
}

function SegFields({ g, i, setSeg, e2, editable }: { g: Seg; i: number; setSeg: (i: number, patch: Partial<Seg>) => void; e2: ErrFn; editable: boolean }) {
  const id = (k: string) => `svc-seg-${i + 1}-${k}`;
  const refusal = (k: string, name: string) => e2(`${name}[${i}]`, id(k));
  return (
    <>
      <TextField id={id('from')} name="segmentFrom" label="From" maxLength={60} value={g.from} onChange={(x) => setSeg(i, { from: x })} error={refusal('from', 'segmentFrom')} disabled={!editable} />
      <TextField id={id('to')} name="segmentTo" label="To" maxLength={60} value={g.to} onChange={(x) => setSeg(i, { to: x })} error={refusal('to', 'segmentTo')} disabled={!editable} />
      <TextField id={id('date')} name="segmentDate" label="Departure date" type="date" value={g.date} onChange={(x) => setSeg(i, { date: x })} error={refusal('date', 'segmentDate')} disabled={!editable} />
      <TextField id={id('arrivalDate')} name="segmentArrivalDate" label="Arrival date" type="date" optional min={g.date || undefined} value={g.arrivalDate} onChange={(x) => setSeg(i, { arrivalDate: x })} error={refusal('arrivalDate', 'segmentArrivalDate')} disabled={!editable} />
      <TextField id={id('airline')} name="segmentAirline" label="Airline" optional maxLength={60} value={g.airline} onChange={(x) => setSeg(i, { airline: x })} error={refusal('airline', 'segmentAirline')} disabled={!editable} />
      <TextField id={id('flightNo')} name="segmentFlightNo" label="Flight number" optional maxLength={12} value={g.flightNo} onChange={(x) => setSeg(i, { flightNo: x })} error={refusal('flightNo', 'segmentFlightNo')} disabled={!editable} />
      <input type="hidden" name="segmentFlex" value={g.flex} />
    </>
  );
}

/** Further legs of a multi-leg flight (existing flights keep their legs; the editor can add legs). */
function FlightMore({
  segs,
  setSegs,
  setSeg,
  v,
  set,
  e2,
  editable,
}: {
  segs: Seg[];
  setSegs: (fn: (x: Seg[]) => Seg[]) => void;
  setSeg: (i: number, patch: Partial<Seg>) => void;
  v: Record<string, string>;
  set: (k: string, x: string) => void;
  e2: ErrFn;
  editable: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <SelectField
        id="svc-tripType-more"
        name="tripTypeShown"
        label="Trip type"
        value={v.tripType ?? 'one_way'}
        onChange={(x) => set('tripType', x)}
        options={[
          { value: 'one_way', label: 'One-way' },
          { value: 'return', label: 'Return' },
          { value: 'multi_city', label: 'Multi-city' },
        ]}
        disabled={!editable}
      />
      {segs.slice(1).map((g, k) => {
        const i = k + 1;
        return (
          <fieldset key={i} className="m-0 min-w-0 rounded-card border border-line px-4 pt-1 pb-4">
            <legend className="px-1 text-base font-semibold text-ink">Leg {i + 1}</legend>
            <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
              <SegFields g={g} i={i} setSeg={setSeg} e2={e2} editable={editable} />
              <TextField id={`svc-seg-${i + 1}-departTime`} name="segmentDepartTime" label="Departure time (local)" type="time" optional value={g.departTime} onChange={(x) => setSeg(i, { departTime: x })} disabled={!editable} />
              <TextField id={`svc-seg-${i + 1}-arriveTime`} name="segmentArriveTime" label="Arrival time (local)" type="time" optional value={g.arriveTime} onChange={(x) => setSeg(i, { arriveTime: x })} disabled={!editable} />
            </div>
            {editable ? (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setSegs((x) => x.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden="true" /> Remove leg {i + 1}
              </Button>
            ) : null}
          </fieldset>
        );
      })}
      {editable && segs.length < 8 ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSegs((x) => [...x, { from: x.at(-1)?.to ?? '', to: '', date: '', flex: '', arrivalDate: '', airline: '', flightNo: '', departTime: '', arriveTime: '' }])}
          >
            <Plus aria-hidden="true" /> Add leg
          </Button>
        </div>
      ) : null}
      <p className="m-0 text-sm text-quiet">Departure and arrival times are local; they are not compared across time zones. PNR, tickets and the fare are recorded later by the Flight team.</p>
    </div>
  );
}

/** Flight screenshots: private item files (contract §2.14). Its own small forms, outside the editor form. */
function FlightFiles({ view, item, editable, actions, onAttached }: { view: BookNowView; item: BookingFormServiceItemView; editable: boolean; actions: { upload: B11Action; remove: B11Action }; onAttached?: () => void }) {
  const files = item.files ?? [];
  const [key, setKey] = useState(0);
  const [local, setLocal] = useState<string | null>(null);
  const [state, formAction] = useB11Action(actions.upload, {
    onSuccess: () => {
      setKey((k) => k + 1);
      onAttached?.();
    },
  });
  const requestId = useRequestId(state);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
    const problem = !file
      ? 'Choose the screenshot file first. Nothing was uploaded.'
      : file.size > SERVICE_ITEM_FILE_MAX_BYTES
        ? 'This file is over 4 MB. Nothing was uploaded.'
        : !(SERVICE_ITEM_FILE_TYPES as readonly string[]).includes(file.type)
          ? 'Use a PDF, JPG, PNG or WebP file. Nothing was uploaded.'
          : files.length >= SERVICE_ITEM_FILES_PER_ITEM
            ? 'A flight can have at most 5 screenshots. Remove one first.'
            : null;
    if (problem) {
      e.preventDefault();
      setLocal(problem);
      requestAnimationFrame(() => document.getElementById('svc-attach')?.focus());
      return;
    }
    setLocal(null);
  };
  // Shown once something is attached or an attach was tried; the button sits beside the passengers.
  if (files.length === 0 && !state && !local && !editable) return null;
  return (
    <section aria-labelledby="svc-files-heading" className="flex flex-col gap-3 border-t border-line pt-5">
      <h3 id="svc-files-heading" className="m-0 text-base font-semibold text-ink">
        Ticket screenshots <span className="font-normal text-quiet">(optional)</span>
      </h3>
      {files.length === 0 ? <p className="m-0 text-sm text-quiet">None attached yet.</p> : null}
      {files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Flight screenshots">
          {files.map((file) => (
            <li key={file.fileId} className="flex flex-wrap items-center justify-between gap-2.5 rounded-chip border border-line px-2.75 py-2.25 text-sm wrap-anywhere">
              <a href={file.downloadHref} className={cn('inline-flex items-center gap-1.5 font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                <FileText aria-hidden="true" className="size-3.5" />
                {file.fileName}
              </a>
              <span className="text-quiet">{file.sizeLabel}</span>
              {editable && file.canRemove ? <RemoveFile view={view} fileId={file.fileId} fileName={file.fileName} fileRowVersion={file.rowVersion ?? null} action={actions.remove} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <form action={formAction} onSubmit={onSubmit} noValidate aria-label="Attach a flight screenshot" className="flex flex-col gap-2">
          <ResultBox result={local ? { ok: false, code: 'evidence_rejected', message: local } : state} successText="Screenshot attached." />
          <input type="hidden" name="dealId" value={view.dealId} />
          <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
          <input type="hidden" name="itemId" value={item.itemId} />
          <input type="hidden" name="kind" value="flight_screenshot" />
          <input type="hidden" name="requestId" value={requestId} />
          <label htmlFor="svc-screenshot" className="sr-only">
            Ticket screenshot file
          </label>
          <p id="svc-screenshot-hint" className="m-0 text-sm text-quiet">
            PDF, JPG, PNG or WebP, up to 4 MB. Opened only by Sales on this deal, the branch Manager and the Flight colleague on this task.
          </p>
          {/* Opened by "Attach ticket screenshot" beside the passengers; choosing a file attaches it at once. */}
          <input
            key={key}
            id="svc-screenshot"
            name="file"
            type="file"
            tabIndex={-1}
            accept={SERVICE_ITEM_FILE_TYPES.join(',')}
            aria-describedby="svc-screenshot-hint"
            onChange={(e) => {
              if (e.currentTarget.files?.length) e.currentTarget.form?.requestSubmit();
            }}
            className="sr-only"
          />
          <AttachingLine />
        </form>
      ) : null}
    </section>
  );
}

/** "Attaching…" while the chosen screenshot uploads (a file name is never shown as attached before the upload succeeds). */
function AttachingLine() {
  const { pending } = useFormStatus();
  return (
    <p role="status" className={pending ? 'm-0 text-sm font-medium text-copy' : 'sr-only'}>
      {pending ? 'Attaching the screenshot…' : ''}
    </p>
  );
}

/** Echo L4: posts the file's row version the screen showed, so a stale screen is refused. */
function RemoveFile({ view, fileId, fileName, fileRowVersion, action }: { view: BookNowView; fileId: string; fileName: string; fileRowVersion: number | null; action: B11Action }) {
  const [state, formAction] = useB11Action(action);
  return (
    <form action={formAction} noValidate className="flex items-center gap-2">
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="fileId" value={fileId} />
      {fileRowVersion !== null ? <input type="hidden" name="fileRowVersion" value={fileRowVersion} /> : null}
      <PendingButton pendingLabel="Removing…" variant="ghost" className="min-h-9 text-sm">
        Remove<span className="sr-only"> {fileName}</span>
      </PendingButton>
      {state && !state.ok ? <span role="alert" className="text-sm text-status-danger">{state.message}</span> : null}
    </form>
  );
}
