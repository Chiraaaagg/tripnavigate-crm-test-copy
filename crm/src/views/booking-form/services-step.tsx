'use client';

import { ArrowLeftRight, BedDouble, CarFront, Check, CircleCheck, Compass, Copy, CornerDownRight, FileText, Image as ImageIcon, Pencil, Plane, Plus, ShieldCheck, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { CAR_KIND_LABEL, type BookingFormServiceItemView } from '@/modules/fulfilment/booking-form-contract';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import { BOOKING_FORM_FIELD_ID, formatInr, isIsoDate, stayNights } from '@/modules/fulfilment/booking-form-model';
import type { BookTravellerView, ServiceType } from '@/modules/fulfilment/contracts';
import { loadAirports, type Airport } from '@/lib/airports/search';
import { dateText } from '../b11/book-fields';
import { newRequestId, refusedFields, type UiResult } from '../b11/form-kit';
import { useSectionForm } from '../b11/draft-sync';
import type { BookNowView } from '../b11/shapes';
import { refusalReason, useSaveQueue } from './autosave-queue';
import { ConfirmDialog } from './confirm-dialog';
import { FareBox } from './fare-box';
import type { FlightEditorStart } from './flight-editor';
import { editableOf } from './form-helpers';
import { useFormToast } from './form-toast';
import { CountPill, SectionCard } from './parts';
import { ServiceEditorDrawer } from './service-editor';
import { SERVICE_CHIPS, SERVICE_KIND_LABEL } from './service-labels';
import { carKindOf, chipPeople, fareTypes, FARE_LABEL, flightFare, isScreenshotFlight, itemLabels, legsOf, nextFlightFrom, plural, requestText, str, travText, unnamedLine } from './service-model';
import type { BookingFormActions } from './types';
import type { HotelOption, SearchAction } from './vn-types';

/*
 * Step 2 · Trip & services (Book now v2, owner-approved prototype step2):
 * service chips, the hotel night coverage line, one card per chosen service
 * with numbered rows ("Hotel 1", "Flight 2"; change 11) and the card's one
 * add button (change 13). Flights get "Add next flight" and "Add return
 * flights" (change 7) and the total fare per person (change 18). Hotel,
 * flight and car rows can be copied. Removing a service asks first. Chips
 * are a view choice only: a chosen service with no rows is flagged before
 * submit, and a service with saved rows cannot be hidden.
 */

export const SERVICE_ICON: Record<ServiceType, LucideIcon> = {
  hotel: BedDouble,
  transfer: CarFront,
  flight: Plane,
  activity: Compass,
  visa: FileText,
  passport: ShieldCheck,
};

const COUNT_NOUN: Record<ServiceType, readonly [string, string]> = {
  hotel: ['hotel', 'hotels'],
  transfer: ['car', 'cars'],
  flight: ['flight', 'flights'],
  activity: ['activity', 'activities'],
  visa: ['visa item', 'visa items'],
  passport: ['passport item', 'passport items'],
};

type EditorState = {
  type: ServiceType;
  item: BookingFormServiceItemView | null;
  copyOf?: BookingFormServiceItemView | null;
  start?: FlightEditorStart | null;
  /** A new item saved from this drawer (it stays open, for example after a screenshot failed to upload). */
  boundId?: string;
} | null;

const APPLICATION_TYPE: Record<string, string> = { fresh: 'Fresh', renewal: 'Renewal', tatkaal: 'Tatkaal', minor: 'Minor' };
const range = (a: string, b: string) => [dateText(a), b && b !== a ? dateText(b) : null].filter(Boolean).join(' – ') || 'Date not set';

/** One row's title, meta line and flag, as the prototype's rowHtml. */
export function rowParts(item: BookingFormServiceItemView, ctx: { travellers: readonly BookTravellerView[]; estimatesVisible: boolean; airports: readonly Airport[] | null; fareKeys: ReturnType<typeof fareTypes> }) {
  const f = item.facts;
  const all = ctx.travellers.length;
  const who = travText(item.participants, all);
  let title = '';
  let meta: string[] = [];
  let flag: string | null = null;
  let shot = false;
  const cost = (p: string | null | undefined) => (ctx.estimatesVisible && p ? `Our cost ${formatInr(p)}` : '');
  switch (item.serviceType) {
    case 'hotel': {
      const n = stayNights(str(f.checkIn), str(f.checkOut));
      title = `${str(f.hotelName) || 'Hotel not named'}${str(f.city) ? ` · ${str(f.city)}` : ''}`;
      const rooms = [plural(Number(f.rooms) || 0, 'room'), Number(f.extraBeds) ? plural(Number(f.extraBeds), 'extra bed') : '', Number(f.childrenWithoutBed) ? `${Number(f.childrenWithoutBed)} no bed` : ''].filter(Boolean).join(' · ');
      meta = [range(str(f.checkIn), str(f.checkOut)), n !== null ? plural(n, 'night') : '', [str(f.roomType), str(f.mealPlan)].filter(Boolean).join(' · ') || 'Room details not set', rooms, who, requestText(f, 'specialRequests', ctx.travellers), cost(item.estimate?.totalPaise)];
      break;
    }
    case 'transfer': {
      const kind = carKindOf(f);
      title = `${str(f.quantity) || 1} × ${str(f.vehicleType) || 'Vehicle not set'} · ${CAR_KIND_LABEL[kind]}`;
      const where = kind === 'full_trip' ? str(f.route) : str(f.pickup) && str(f.drop) ? `${str(f.pickup)} to ${str(f.drop)}` : str(f.route);
      meta = [where, kind === 'full_trip' ? range(str(f.date), str(f.endDate)) : `${dateText(str(f.date)) ?? 'Date not set'}${str(f.pickupTime) ? ` · ${str(f.pickupTime)}` : ''}`, who, cost(item.estimate?.totalPaise)];
      break;
    }
    case 'flight': {
      if (isScreenshotFlight(f)) {
        shot = true;
        title = `From screenshot${str(f.screenshotNote) ? ` · ${str(f.screenshotNote)}` : ''}`;
        meta = [plural((item.files ?? []).length, 'screenshot'), who, requestText(f, 'preferences', ctx.travellers)];
      } else {
        const legs = legsOf(f);
        const g = legs[0];
        const city = (c: string) => ctx.airports?.find((a) => a.c === c)?.city ?? '';
        title = legs.length > 0 ? legs.map((x) => `${x.from} – ${x.to}`).join(', ') : 'Flight not set';
        const seg0 = Array.isArray(f.segments) ? ((f.segments as Array<Record<string, unknown>>)[0] ?? {}) : {};
        meta = [
          g && (city(g.from) || city(g.to)) ? `${city(g.from) || g.from} to ${city(g.to) || g.to}` : '',
          g ? (dateText(g.date) ?? '') : '',
          [str(seg0.airline), g?.flightNo ?? '', str(f.cabin)].filter(Boolean).join(' · '),
          g?.departTime ? `${g.departTime} – ${g.arriveTime || '?'} (local)` : '',
          who,
          requestText(f, 'preferences', ctx.travellers),
        ];
        if (!g?.flightNo || !g?.departTime) flag = 'Add flight number and times';
      }
      if (ctx.estimatesVisible) {
        const fp = ctx.fareKeys.map((k) => [k, flightFare(item, k)] as const).filter(([, p]) => p !== null);
        if (fp.length) meta.push(`Fare per person: ${fp.map(([k, p]) => `${FARE_LABEL[k]} ${formatInr(p)}`).join(' · ')}`);
        else if (item.estimate?.estimate?.kind === 'flight' && item.estimate.estimate.fareTotalPaise) meta.push(`Estimated fare (total) ${formatInr(item.estimate.estimate.fareTotalPaise)}`);
      }
      break;
    }
    case 'activity':
      title = str(f.name) || 'Activity';
      meta = [str(f.city), dateText(str(f.date)) ?? '', who];
      break;
    case 'visa':
      title = [str(f.country), str(f.purpose)].filter(Boolean).join(' · ') || 'Visa';
      meta = [isIsoDate(str(f.travelDate)) ? `Planned travel ${dateText(str(f.travelDate))}` : '', who];
      break;
    case 'passport':
      title = [APPLICATION_TYPE[str(f.applicationType)] ?? str(f.applicationType), str(f.officeCity)].filter(Boolean).join(' · ') || 'Passport';
      meta = [who];
      break;
  }
  return { title, meta: meta.filter(Boolean), flag, shot };
}

/** A service row (used on step 2 and in "Review trip and services"). */
export function ServiceRow({ item, label, ctx, actions }: { item: BookingFormServiceItemView; label: string; ctx: Parameters<typeof rowParts>[1]; actions?: React.ReactNode }) {
  const r = rowParts(item, ctx);
  return (
    <div id={`bf-item-${item.itemId}`} tabIndex={-1} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line px-5 py-3.5 outline-none last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-strong max-sm:px-4">
      <div className="min-w-0">
        <div className="font-semibold wrap-anywhere text-ink">
          <span className="mr-1 font-medium text-quiet">{label}</span>
          {r.shot ? <ImageIcon aria-hidden="true" className="mr-1 inline size-4 align-[-3px]" /> : null}
          {r.title}
        </div>
        <div className="mt-0.75 flex flex-wrap gap-x-3.5 gap-y-1 text-sm text-quiet">
          {r.meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
        {r.flag ? (
          <div className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-status-warning">
            <TriangleAlert aria-hidden="true" className="size-3.25" />
            {r.flag}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex items-start gap-0.5">{actions}</div> : null}
    </div>
  );
}

export function useAirportsWhen(needed: boolean) {
  const [airports, setAirports] = useState<Airport[] | null>(null);
  useEffect(() => {
    if (!needed || airports) return;
    let live = true;
    void loadAirports().then((a) => {
      if (live) setAirports(a);
    });
    return () => {
      live = false;
    };
  }, [needed, airports]);
  return airports;
}

export function ServicesStep({
  vm,
  view,
  actions,
  party,
  tripStart,
  tripEnd,
  searchHotels = null,
  selected,
  setSelected,
}: {
  /** Services chosen with the chips (a view choice; the screen checks chosen services with no rows). */
  selected: ServiceType[];
  setSelected: (fn: (x: ServiceType[]) => ServiceType[]) => void;
  vm: BookingFormVM;
  view: BookNowView;
  actions: Pick<BookingFormActions, 'saveService' | 'removeServiceItem' | 'uploadServiceFile' | 'removeServiceFile' | 'saveFlightFares' | 'addReturnFlights'>;
  reloadHref?: string;
  /** Typed party of step 1. */
  party: { total: number | null; children: number; infants: number };
  tripStart: string;
  tripEnd: string;
  searchHotels?: SearchAction<HotelOption> | null;
}) {
  const router = useRouter();
  const toast = useFormToast();
  const queue = useSaveQueue();
  const editable = editableOf(view);
  const revision = Boolean(view.version?.revisesVersionId);
  const items = [...vm.items].sort((a, b) => a.itemNo - b.itemNo);
  const labels = itemLabels(items);
  const countFor = (t: ServiceType) => items.filter((i) => i.serviceType === t).length;
  const [editor, setEditorState] = useState<EditorState>(null);
  // Each opening is its own drawer (binding a new item to it keeps the typed state).
  const [session, setSession] = useState(0);
  // Focus goes back to the button that opened the drawer.
  const opener = useRef<HTMLElement | null>(null);
  const setEditor = (e: EditorState) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSession((n) => n + 1);
    setEditorState(e);
  };
  const [removeTarget, setRemoveTarget] = useState<BookingFormServiceItemView | null>(null);
  const estimatesVisible = view.commercials !== undefined || items.some((i) => i.estimate !== undefined);
  const shown = SERVICE_CHIPS.filter((c) => selected.includes(c.type) || countFor(c.type) > 0);
  const flights = items.filter((i) => i.serviceType === 'flight');
  const airports = useAirportsWhen(flights.length > 0);
  const people = chipPeople(view.travellers);
  const unnamed = unnamedLine(party.total, people.length);
  const fareKeys = fareTypes(party);
  const ctx = { travellers: view.travellers, estimatesVisible, airports, fareKeys };
  const cov = vm.coverage;
  const canChange = editable && !revision;

  const remover = useSectionForm({
    id: 'services-remove',
    section: 'services',
    label: 'Remove service',
    order: 49,
    action: actions.removeServiceItem,
    initial: {},
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: false,
  });
  const [removing, setRemoving] = useState(false);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);
  const confirmRemove = async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    const fd = new FormData();
    fd.set('dealId', view.dealId);
    fd.set('versionId', view.version?.versionId ?? '');
    fd.set('itemId', removeTarget.itemId);
    const r = await queue.run(() => remover.post(fd));
    setRemoving(false);
    if (r.ok) {
      setRemoveTarget(null);
      toast('Service removed.');
    } else setRemoveProblem(refusalReason(r));
  };

  const returns = useSectionForm({
    id: 'flight-returns',
    section: 'services',
    label: 'Add return flights',
    order: 48,
    action: actions.addReturnFlights ?? (async () => ({ ok: false, code: 'unexpected', message: '' }) as never),
    initial: {},
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: false,
  });
  const [addingReturns, setAddingReturns] = useState(false);
  const typedOut = flights.filter((f) => f.facts.isReturn !== true && !isScreenshotFlight(f.facts));
  const returnDrawer = (): EditorState => ({ type: 'flight', item: null, start: { mode: 'screenshot', isReturn: true, date: tripEnd, banner: 'Return journey. Attach the return flight screenshot, or type the details.' } });
  const addReturnFlights = async () => {
    if (addingReturns) return;
    if (typedOut.length === 0 || !actions.addReturnFlights) {
      setEditor(returnDrawer());
      return;
    }
    setAddingReturns(true);
    const fd = new FormData();
    fd.set('dealId', view.dealId);
    fd.set('versionId', view.version?.versionId ?? '');
    fd.set('requestId', newRequestId());
    const r: UiResult = await queue.run(() => returns.post(fd));
    setAddingReturns(false);
    if (!r.ok) {
      toast(refusedFields(r)?.includes('tripEnd') ? 'Add the return date in step 1 first.' : refusalReason(r));
      return;
    }
    const data = (r as { data?: { outcome?: string; itemIds?: string[] } }).data;
    if (data?.outcome === 'no_typed_flights') {
      setEditor(returnDrawer());
      return;
    }
    const n = data?.itemIds?.length ?? typedOut.length;
    toast(data?.outcome === 'already_added' ? 'Return flights are already added.' : `${plural(n, 'return flight')} added for ${tripEnd ? dateText(tripEnd) : 'the return date'}. Add flight numbers and times.`);
    router.refresh();
  };
  const addNextFlight = () => {
    const last = flights.at(-1);
    if (!last) return;
    const who = (last.participants ?? []).map(String);
    const isReturn = last.facts.isReturn === true;
    if (isScreenshotFlight(last.facts)) {
      setEditor({ type: 'flight', item: null, start: { who, isReturn, mode: 'typed' } });
      return;
    }
    const legs = legsOf(last.facts);
    const g = legs.at(-1) ?? null;
    const next = nextFlightFrom(g);
    const seg0 = Array.isArray(last.facts.segments) ? ((last.facts.segments as Array<Record<string, unknown>>)[0] ?? {}) : {};
    setEditor({ type: 'flight', item: null, start: { from: next.from, date: next.date, airline: str(seg0.airline), cabin: str(last.facts.cabin), who, isReturn, banner: `Next flight: starts where ${labels.get(last.itemId)?.toLowerCase() ?? 'the last flight'} lands. Check the date.` } });
  };

  const toggle = (t: ServiceType) => {
    if (selected.includes(t) && countFor(t) > 0) {
      toast('Remove saved rows before hiding this service.');
      return;
    }
    setSelected((x) => (x.includes(t) ? x.filter((k) => k !== t) : [...x, t]));
  };

  return (
    <div className="flex flex-col gap-4.5 outline-none" id={BOOKING_FORM_FIELD_ID.services} tabIndex={-1}>
      <span id="hotels" />
      <Card className="p-5 max-sm:p-4">
        <div id="bf-services-label" className="mb-2.5 font-semibold text-ink">
          Choose services
        </div>
        <div role="group" aria-labelledby="bf-services-label" className="flex flex-wrap gap-2">
          {SERVICE_CHIPS.map(({ type, label }) => {
            const Icon = SERVICE_ICON[type];
            const on = selected.includes(type) || countFor(type) > 0;
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(type)}
                disabled={!canChange && !on}
                className={cn(
                  'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-card px-3 font-medium text-copy',
                  'hover:border-quiet disabled:cursor-not-allowed disabled:opacity-60',
                  on && 'border-brand-line bg-brand-tint text-brand-deep',
                  focusRing,
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
                {on ? <Check aria-hidden="true" className="size-4" /> : null}
              </button>
            );
          })}
        </div>
        {(selected.includes('hotel') || countFor('hotel') > 0) && cov && cov.nights !== null ? (
          <p role="status" className="m-0 mt-3 flex flex-wrap items-center gap-2 text-sm text-quiet">
            <BedDouble aria-hidden="true" className="size-4" />
            {cov.covered} / {cov.nights} trip nights have a hotel
            {cov.missing.length > 0 ? (
              <>
                {' · '}
                <b className="text-status-warning">{cov.missing.length} missing</b>
              </>
            ) : (
              <>
                {' · '}
                <CircleCheck aria-hidden="true" className="size-4 text-status-success" />
                all covered
              </>
            )}
          </p>
        ) : null}
      </Card>
      {shown.length === 0 ? (
        <Card>
          <div className="flex min-h-35 flex-col items-center justify-center gap-2 text-quiet">
            <Compass aria-hidden="true" className="size-4" />
            Choose the services this booking needs.
          </div>
        </Card>
      ) : null}
      {revision ? <p className="m-0 text-sm text-quiet">While fixing a returned booking you can change services but not add or remove them.</p> : null}
      {shown.map(({ type, label, add }) => {
        const rows = items.filter((i) => i.serviceType === type);
        const Icon = SERVICE_ICON[type];
        return (
          <SectionCard
            key={type}
            id={`services-${type}`}
            title={
              <>
                {label} <CountPill n={rows.length} noun={COUNT_NOUN[type]} />
              </>
            }
            icon={Icon}
            action={
              canChange ? (
                <Button size="sm" onClick={() => setEditor({ type, item: null })}>
                  <Plus aria-hidden="true" />
                  {add}
                </Button>
              ) : null
            }
          >
            {rows.length === 0 ? (
              <p className="m-0 px-5 py-4.5 text-quiet max-sm:px-4">No {label.toLowerCase()} added yet.</p>
            ) : (
              rows.map((item) => {
                const name = labels.get(item.itemId) ?? SERVICE_KIND_LABEL[type];
                return (
                  <ServiceRow
                    key={item.itemId}
                    item={item}
                    label={name}
                    ctx={ctx}
                    actions={
                      <>
                        <Button id={`svc-row-${item.itemId}-edit`} variant="ghost" size="icon" className="size-9" aria-label={`${editable ? 'Edit' : 'Details of'} ${name.toLowerCase()}`} onClick={() => setEditor({ type, item })}>
                          <Pencil aria-hidden="true" />
                        </Button>
                        {(type === 'hotel' || type === 'flight' || type === 'transfer') && canChange ? (
                          <Button variant="ghost" size="icon" className="size-9" aria-label={`Copy ${name.toLowerCase()}`} onClick={() => setEditor({ type, item: null, copyOf: item })}>
                            <Copy aria-hidden="true" />
                          </Button>
                        ) : null}
                        {canChange && !item.locked ? (
                          <Button variant="ghost" size="icon" className="size-9" aria-label={`Remove ${name.toLowerCase()}`} onClick={() => setRemoveTarget(item)}>
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                );
              })
            )}
            {type === 'flight' && rows.length > 0 ? (
              <>
                {canChange ? (
                  <div className="flex flex-wrap gap-2 rounded-b-card border-t border-line bg-[#fcfcfc] px-5 py-3 max-sm:px-4">
                    <Button size="sm" onClick={addNextFlight}>
                      <CornerDownRight aria-hidden="true" />
                      Add next flight
                    </Button>
                    {rows.some((r) => r.facts.isReturn === true) ? null : (
                      <Button size="sm" loading={addingReturns} onClick={() => void addReturnFlights()}>
                        {addingReturns ? null : <ArrowLeftRight aria-hidden="true" />}
                        Add return flights
                      </Button>
                    )}
                    <span className="self-center text-sm text-quiet">Next flight starts where the last one lands. Return flights reverse the outward ones.</span>
                  </div>
                ) : null}
                {estimatesVisible ? (
                  <div className="pt-3 pb-3">
                    <FareBox view={view} flights={rows} travellers={view.travellers} totals={vm.flightFareTotals ?? null} party={party} action={actions.saveFlightFares} editable={editable} />
                  </div>
                ) : null}
              </>
            ) : null}
          </SectionCard>
        );
      })}
      {editor ? (
        <ServiceEditorDrawer
          key={session}
          view={view}
          type={editor.type}
          item={items.find((i) => i.itemId === (editor.item?.itemId ?? editor.boundId)) ?? editor.item ?? null}
          onBound={(itemId) => setEditorState((e) => (e ? { ...e, boundId: itemId } : e))}
          copyOf={editor.copyOf ?? null}
          flightStart={editor.start ?? null}
          estimatesVisible={estimatesVisible}
          people={people}
          unnamed={unnamed}
          party={party}
          trip={{ start: tripStart, end: tripEnd }}
          items={items}
          searchHotels={searchHotels}
          action={actions.saveService}
          fileActions={{ upload: actions.uploadServiceFile, remove: actions.removeServiceFile }}
          filesEditable={vm.itemFilesCanEdit}
          onClose={() => {
            const id = editor.item?.itemId ?? editor.boundId;
            const back = opener.current;
            setEditorState(null);
            requestAnimationFrame(() => {
              const fallback = document.getElementById(id ? `svc-row-${id}-edit` : `services-${editor.type}-heading`);
              (back && back.isConnected ? back : fallback)?.focus();
            });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRemoveTarget(null);
            setRemoveProblem(null);
          }
        }}
        title={`Remove this ${removeTarget ? SERVICE_KIND_LABEL[removeTarget.serviceType].toLowerCase() : 'service'}?`}
        description="It is removed from this booking draft now. Nothing is booked or cancelled with a supplier."
        confirmLabel="Remove"
        cancelLabel="Keep it"
        busy={removing}
        onConfirm={() => void confirmRemove()}
      >
        {removeProblem ? (
          <p role="alert" className="m-0 px-5 text-sm font-medium text-status-danger">
            {removeProblem}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
