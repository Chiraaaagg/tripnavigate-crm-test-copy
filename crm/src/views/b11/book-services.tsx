'use client';

import { BedDouble, Car, ChevronDown, CircleAlert, CircleCheck, Compass, FileBadge, Plane, Plus, Stamp, Trash2, TrainFront, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChipCheck } from '@/components/ui/chip-check';
import { cn, focusRing } from '@/components/ui/cn';
import { Fieldset } from '@/components/ui/fieldset';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/badge';
import { BOOK_NOW_TEXT } from '@/modules/fulfilment/contracts';
import { B11_DEPARTMENT, B11_DEPARTMENT_LABEL, B11_SERVICE_LABEL, checklistForSection, HOTEL_SECTION_TYPES, itemsForSection, OTHER_SECTION_TYPES, paiseToRupeesText, serviceSection } from './book-fields';
import { BaseRowVersion, useDraftSync, useSectionForm } from './draft-sync';
import { AreaField, MoneyField, SelectField, TextField, problemFor } from './controls';
import { type FieldRef, newRequestId, PendingButton, refusedFields, ResultBox, type UiResult } from './form-kit';
import { factsOf, factsToFormValues, itemSummary, factsToSegments, FLEX_OPTIONS, hasBudget, MAX_SEGMENTS, SERVICE_FIELDS, type SegmentValues } from './service-fields';
import type { B11Action, BookItem, BookNowView, BookServiceType } from './shapes';

/*
 * The sold services, split by the B1.2 freeze note §2.1: hotels on step 2
 * ("Add a hotel"), every other type on step 3 ("Add a service"). One card per
 * service with its own forms (who takes part, the details, remove), each with
 * its own base row version (DraftSync). Service numbers stay global per
 * version. Every service becomes one task for its department after
 * submission; visa and passport wait for the desk launch while that switch is
 * off. Train is shown and refused on the spot (deferred, owner rule).
 */

export const SERVICE_ICON: Record<BookServiceType, LucideIcon> = {
  hotel: BedDouble,
  flight: Plane,
  transfer: Car,
  activity: Compass,
  visa: Stamp,
  passport: FileBadge,
};

export interface ServiceActions {
  add: B11Action;
  save: B11Action;
  remove: B11Action;
  participants: B11Action;
}

/** Step 2 · hotels ("Add a hotel") or step 3 · every other service ("Add a service"); global service numbers kept. */
export function ServicesSection({
  view,
  section,
  reloadHref,
  travellersHref,
  actions,
  addInitialState,
  addType: addTypeInitial = null,
}: {
  view: BookNowView;
  section: 'hotels' | 'services';
  reloadHref: string;
  /** Where travellers are added (step 1 · passengers). */
  travellersHref: string;
  actions: ServiceActions;
  /** Preview gallery: the add form's first answer and the open type. */
  addInitialState?: UiResult | null;
  addType?: BookServiceType | null;
}) {
  const editable = view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;
  const revision = Boolean(view.version?.revisesVersionId);
  const hotels = section === 'hotels';
  const [addType, setAddType] = useState<BookServiceType | null>(addTypeInitial);
  const [trainRefused, setTrainRefused] = useState(false);
  const all = view.items;
  const items = itemsForSection(all, section);
  const warnings = checklistForSection(view.checklist, section);
  const orderBase = hotels ? 40 : 50;
  const addTypes: readonly BookServiceType[] = hotels ? HOTEL_SECTION_TYPES : OTHER_SECTION_TYPES;
  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-quiet">
        {hotels
          ? 'Add each hotel that was sold. Each hotel becomes one task for Purchase after submission. Nothing here is booked: Purchase checks availability later.'
          : 'Transport, flights, activities, visas and passports that were sold. Each becomes one task for its department after submission. Nothing here is booked.'}
      </p>
      {warnings.length > 0 ? (
        <Notice tone={warnings.some((w) => w.blocking) ? 'warning' : 'info'} title={`${warnings.length} ${warnings.length === 1 ? 'thing' : 'things'} to check in this section`}>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {warnings.map((w) => (
              <li key={`${w.code}-${(w.itemNos ?? []).join('.')}`}>
                {w.itemNos && w.itemNos.length > 0 ? `Service ${w.itemNos.join(', ')}: ` : ''}
                {w.text}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {items.length === 0 ? (
        <p className="m-0 rounded-card border border-dashed border-line-strong bg-canvas px-4 py-6 text-center text-copy">
          {hotels ? BOOK_NOW_TEXT.noHotelYet : 'No other services yet. Add what was sold, or submit if this booking has only hotels.'}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label={hotels ? 'Hotels sold' : 'Other services sold'}>
          {items.map((item) => (
            <li key={item.itemId} className="m-0">
              <ServiceCard view={view} item={item} order={orderBase + item.itemNo / 100} editable={editable} revision={revision} actions={actions} reloadHref={reloadHref} travellersHref={travellersHref} />
            </li>
          ))}
        </ol>
      )}

      {editable && !revision ? (
        <section aria-labelledby={`${section}-add-heading`} className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-4 shadow-card">
          <h4 id={`${section}-add-heading`} className="m-0 text-base font-semibold text-ink">
            {hotels ? 'Add a hotel' : 'Add a service'}
          </h4>
          {all.length >= 20 ? (
            <Notice tone="warning">More than 20 services on one Deal isn’t supported (hotels and other services together).</Notice>
          ) : hotels ? (
            addType ? null : (
              <div>
                <Button variant="secondary" onClick={() => setAddType('hotel')}>
                  <Plus aria-hidden="true" />
                  <BedDouble aria-hidden="true" />
                  Add a hotel
                </Button>
              </div>
            )
          ) : (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Service type to add">
                {addTypes.map((t) => {
                  const Icon = SERVICE_ICON[t];
                  return (
                    <Button key={t} variant={addType === t ? 'primary' : 'secondary'} aria-pressed={addType === t} onClick={() => setAddType(t)}>
                      <Plus aria-hidden="true" />
                      <Icon aria-hidden="true" />
                      {B11_SERVICE_LABEL[t]}
                    </Button>
                  );
                })}
                <Button variant="secondary" aria-disabled="true" aria-describedby="services-train-note" onClick={() => setTrainRefused(true)}>
                  <TrainFront aria-hidden="true" /> Train (deferred)
                </Button>
              </div>
              <p id="services-train-note" className="m-0 text-sm text-quiet">
                Train bookings are deferred (owner rule) and can’t be added. Hotels are added in step 2.
              </p>
              {trainRefused ? (
                <Notice tone="danger" role="alert">
                  Train is deferred and not available. Nothing was added.
                </Notice>
              ) : null}
            </>
          )}
          {addType ? (
            <ServiceFactsForm
              key={addType}
              view={view}
              type={addType}
              formId={`${section}-add`}
              section={section}
              order={orderBase + 0.99}
              action={actions.add}
              initialState={addInitialState}
              reloadHref={reloadHref}
              onDone={() => setAddType(null)}
            />
          ) : null}
        </section>
      ) : revision ? (
        <Notice tone="locked">Services cannot be added or removed while fixing a returned booking. Change the details of the existing services only.</Notice>
      ) : null}
    </div>
  );
}

function ServiceCard({
  view,
  item,
  order,
  editable,
  revision,
  actions,
  reloadHref,
  travellersHref,
}: {
  view: BookNowView;
  item: BookItem;
  order: number;
  editable: boolean;
  revision: boolean;
  actions: ServiceActions;
  reloadHref: string;
  travellersHref: string;
}) {
  const Icon = SERVICE_ICON[item.serviceType];
  const section = serviceSection(item.serviceType);
  const headingId = `${section}-svc-${item.itemNo}-heading`;
  const isDesk = B11_DEPARTMENT[item.serviceType] === 'visa';
  if (section === 'hotels') return <HotelCard view={view} item={item} order={order} editable={editable} revision={revision} actions={actions} reloadHref={reloadHref} travellersHref={travellersHref} />;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-card border border-line bg-card px-4 py-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 id={headingId} className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
          <Icon aria-hidden="true" className="size-4.5 text-brand-strong" />
          <span>
            Service {item.itemNo}: {B11_SERVICE_LABEL[item.serviceType]}
          </span>
          <span className="font-normal wrap-anywhere text-copy">{itemSummary(item) || item.title}</span>
        </h4>
        <span className="text-sm text-quiet">Goes to: {B11_DEPARTMENT_LABEL[item.department]}</span>
      </div>
      {isDesk && !view.visaPassportTasksEnabled ? (
        <StatusBadge tone="warning" wrap>
          Recorded now · waits for the Visa &amp; Passport desk launch · still counts as outstanding
        </StatusBadge>
      ) : null}
      <ParticipationForm view={view} item={item} order={order} editable={editable} action={actions.participants} reloadHref={reloadHref} travellersHref={travellersHref} />
      <details className="rounded-control border border-line bg-canvas">
        <summary className={cn('flex min-h-11 cursor-pointer items-center px-3 font-medium text-brand-strong', focusRing)}>{editable ? 'Edit the details of this service' : 'Details of this service'}</summary>
        <div className="border-t border-line bg-card px-3 py-3">
          <ServiceFactsForm view={view} type={item.serviceType} item={item} formId={`${section}-svc-${item.itemNo}`} section={section} order={order + 0.001} action={actions.save} reloadHref={reloadHref} readOnly={!editable} />
        </div>
      </details>
      {editable && !revision ? <RemoveServiceForm view={view} item={item} order={order + 0.002} action={actions.remove} /> : null}
    </section>
  );
}

/**
 * Step 2 hotel card (BK-03, FP-032): a one-line summary with its state in
 * words, and "Edit hotel n" that opens the full production hotel form (every
 * field kept; the prototype's short form is not a target). A hotel that still
 * needs details starts open. The body stays mounted when closed, closes after
 * its details save, and never closes while it has unsaved changes.
 */
function HotelCard({
  view,
  item,
  order,
  editable,
  revision,
  actions,
  reloadHref,
  travellersHref,
}: {
  view: BookNowView;
  item: BookItem;
  order: number;
  editable: boolean;
  revision: boolean;
  actions: ServiceActions;
  reloadHref: string;
  travellersHref: string;
}) {
  const prefix = `hotels-svc-${item.itemNo}`;
  const formIds = [prefix, `${prefix}-who`];
  const headingId = `${prefix}-heading`;
  const bodyId = `${prefix}-body`;
  const checks = view.checklist.filter((c) => (c.itemNos ?? []).includes(item.itemNo));
  const needsDetails = checks.some((c) => c.blocking);
  const [open, setOpen] = useState(needsDetails);
  const [savedNote, setSavedNote] = useState(false);
  const sync = useDraftSync();
  const dirty = sync.dirtyEntries().some((e) => formIds.includes(e.id));
  const latest = useRef({ sync, formIds });
  useEffect(() => {
    latest.current = { sync, formIds };
  });
  const { subscribeSaved } = sync;
  useEffect(
    () =>
      subscribeSaved(({ id }) => {
        const { sync: s, formIds: ids } = latest.current;
        if (id !== ids[0]) return;
        // The saved form itself still counts as dirty until its next render.
        if (s.dirtyEntries().some((e) => ids.includes(e.id) && e.id !== id)) return;
        setOpen(false);
        setSavedNote(true);
        requestAnimationFrame(() => document.getElementById(`${ids[0]}-toggle`)?.focus());
      }),
    [subscribeSaved],
  );
  const toggle = () => {
    if (open && dirty) return;
    setSavedNote(false);
    setOpen((x) => !x);
  };
  const stateText = needsDetails ? 'Needs details' : checks.length > 0 ? 'Worth checking' : 'Saved';
  const StateIcon = needsDetails ? CircleAlert : checks.length > 0 ? TriangleAlert : CircleCheck;
  return (
    <section aria-labelledby={headingId} data-hotel-card={item.itemNo} className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h4 id={headingId} className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-2 text-base font-semibold text-ink">
          <BedDouble aria-hidden="true" className="size-4.5 text-brand-strong" />
          <span>
            Service {item.itemNo}: {B11_SERVICE_LABEL[item.serviceType]}
          </span>
          <span className="font-normal wrap-anywhere text-copy">{itemSummary(item) || item.title}</span>
        </h4>
        <span className="inline-flex items-center gap-1.5 text-sm text-copy">
          <StateIcon aria-hidden="true" className={cn('size-4', needsDetails ? 'text-status-danger' : checks.length > 0 ? 'text-status-warning' : 'text-status-success')} />
          {stateText}
        </span>
        <Button
          id={`${prefix}-toggle`}
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-disabled={(open && dirty) || undefined}
          aria-describedby={open && dirty ? `${prefix}-stays-open` : undefined}
          onClick={toggle}
          className="min-h-11"
        >
          <ChevronDown aria-hidden="true" className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
          {open ? `Close hotel ${item.itemNo}` : editable ? `Edit hotel ${item.itemNo}` : `Details of hotel ${item.itemNo}`}
        </Button>
      </div>
      <p role="status" className={savedNote && !open ? 'm-0 text-sm text-copy' : 'sr-only'}>
        {savedNote && !open ? `Hotel ${item.itemNo} saved.` : ''}
      </p>
      {open && dirty ? (
        <p id={`${prefix}-stays-open`} className="m-0 text-sm text-quiet">
          Unsaved changes: this hotel stays open until you save or undo them.
        </p>
      ) : null}
      <div id={bodyId} hidden={!open} className={open ? 'flex flex-col gap-4 border-t border-line pt-3' : 'hidden'}>
        <p className="m-0 text-sm text-quiet">Goes to: {B11_DEPARTMENT_LABEL[item.department]}</p>
        <ParticipationForm view={view} item={item} order={order} editable={editable} action={actions.participants} reloadHref={reloadHref} travellersHref={travellersHref} />
        <ServiceFactsForm view={view} type={item.serviceType} item={item} formId={prefix} section="hotels" order={order + 0.001} action={actions.save} reloadHref={reloadHref} readOnly={!editable} />
        {editable && !revision ? <RemoveServiceForm view={view} item={item} order={order + 0.002} action={actions.remove} /> : null}
      </div>
    </section>
  );
}

function ParticipationForm({ view, item, order, editable, action, reloadHref, travellersHref }: { view: BookNowView; item: BookItem; order: number; editable: boolean; action: B11Action; reloadHref: string; travellersHref: string }) {
  const section = serviceSection(item.serviceType);
  const f = useSectionForm({
    id: `${section}-svc-${item.itemNo}-who`,
    section,
    label: `Who takes part in service ${item.itemNo}`,
    order,
    action,
    initial: { seqs: item.participants },
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
  });
  const { bindForm, bindResult } = f;
  const seqs = f.values.seqs;
  const travellers = [...view.travellers].sort((a, b) => a.seq - b.seq);
  const passport = item.serviceType === 'passport';
  const toggle = (seq: number) => f.setValues((x) => ({ seqs: x.seqs.includes(seq) ? x.seqs.filter((s) => s !== seq) : passport ? [seq] : [...x.seqs, seq].sort((a, b) => a - b) }));
  const legendId = `${section}-svc-${item.itemNo}-who-legend`;
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-labelledby={legendId} className="flex flex-col gap-2">
      <div ref={bindResult}>
        <ResultBox result={f.state} reloadHref={reloadHref} successText="Saved who takes part." />
      </div>
      <input type="hidden" name="itemId" value={item.itemId} />
      <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name="dealId" value={view.dealId} />
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend id={legendId} className="mb-2 p-0 text-base font-semibold text-ink">
          Who takes part{passport ? ' (one applicant per passport service)' : ''}
        </legend>
        {travellers.length === 0 ? (
          <p className="m-0 text-quiet">
            Add travellers in{' '}
            <a href={travellersHref} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
              step 1 · Passengers
            </a>{' '}
            first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {travellers.map((t) => (
              <ChipCheck
                key={t.seq}
                id={`${section}-svc-${item.itemNo}-who-${t.seq}`}
                name="participantSeq"
                value={String(t.seq)}
                label={t.fullName || `Traveller ${t.seq}`}
                checked={seqs.includes(t.seq)}
                onChange={() => toggle(t.seq)}
                disabled={!editable}
              />
            ))}
          </div>
        )}
      </fieldset>
      {editable && travellers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <PendingButton pendingLabel="Saving…" disabled={!f.dirty}>
            Save who takes part
          </PendingButton>
          <span className="text-sm text-quiet" aria-live="polite">
            {seqs.length === 0 ? 'Nobody ticked yet.' : `${seqs.length} ticked.`}
            {f.dirty ? ' Unsaved.' : ''}
          </span>
        </div>
      ) : null}
    </form>
  );
}

function ServiceFactsForm({
  view,
  type,
  item,
  formId,
  section,
  order,
  action,
  initialState,
  reloadHref,
  onDone,
  readOnly = false,
}: {
  view: BookNowView;
  type: BookServiceType;
  item?: BookItem;
  /** Unique per page; also the id prefix of every field (section-prefixed). */
  formId: string;
  section: 'hotels' | 'services';
  order: number;
  action: B11Action;
  initialState?: UiResult | null;
  reloadHref: string;
  onDone?: () => void;
  readOnly?: boolean;
}) {
  const prefix = formId;
  const initial = {
    values: factsToFormValues(type, item ? factsOf(item) : null, paiseToRupeesText(item?.purchaseBudgetPaise ?? null)),
    segments: factsToSegments(item ? factsOf(item) : null) as SegmentValues[],
  };
  const [requestId, setRequestId] = useState(() => newRequestId());
  const f = useSectionForm({
    id: formId,
    section,
    label: item ? `Service ${item.itemNo} (${B11_SERVICE_LABEL[type]})` : `New ${B11_SERVICE_LABEL[type].toLowerCase()}`,
    order,
    action,
    initial,
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    // A new service is added with its own button; "Save and continue" never adds one silently.
    saveable: Boolean(item) && !readOnly,
    tracksDirty: !readOnly,
    initialState,
    onSuccess: () => {
      if (!item) {
        setRequestId(newRequestId());
        onDone?.();
      }
    },
  });
  const { bindForm, bindResult } = f;
  const values = f.values.values;
  const segments = f.values.segments;
  const fields = refusedFields(f.state);
  const defs = SERVICE_FIELDS[type].filter((d) => !d.when || d.when(values));
  const refs: FieldRef[] = [
    ...defs.map((d) => ({ field: d.name, id: `${prefix}-${d.name}`, label: `${d.label}${d.required ? '' : ' (check the value)'}` })),
    { field: 'purchaseBudgetRupees', id: `${prefix}-budget`, label: 'Budget: rupees with up to 2 decimals' },
    ...segments.flatMap((_, j) => [
      { field: `segmentFrom[${j}]`, id: `${prefix}-seg-${j + 1}-from`, label: `Leg ${j + 1}: from (airport code or city)` },
      { field: `segmentTo[${j}]`, id: `${prefix}-seg-${j + 1}-to`, label: `Leg ${j + 1}: to (airport code or city)` },
      { field: `segmentDate[${j}]`, id: `${prefix}-seg-${j + 1}-date`, label: `Leg ${j + 1}: date (in order)` },
    ]),
  ];
  const err = (name: string) => problemFor(fields, name, refs.find((r) => r.field === name)?.label ?? 'Check this field.');
  const set = (k: string, v: string) => f.setValues((x) => ({ ...x, values: { ...x.values, [k]: v } }));
  const setSegments = (fn: (x: SegmentValues[]) => SegmentValues[]) => f.setValues((x) => ({ ...x, segments: fn(x.segments) }));
  const setSeg = (j: number, patch: Partial<SegmentValues>) => setSegments((x) => x.map((s, i) => (i === j ? { ...s, ...patch } : s)));
  const label = item ? `Details of service ${item.itemNo}` : `New ${B11_SERVICE_LABEL[type].toLowerCase()} service`;
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-label={label} className="flex flex-col gap-4">
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={item ? 'Service saved.' : 'Service added. Add another or continue.'} />
      </div>
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name="requestId" value={requestId} />
      {item ? <input type="hidden" name="itemId" value={item.itemId} /> : <input type="hidden" name="serviceType" value={type} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {defs.map((d) => {
          const common = { id: `${prefix}-${d.name}`, name: d.name, label: d.label, value: values[d.name] ?? '', onChange: (v: string) => set(d.name, v), hint: d.hint, error: err(d.name), optional: !d.required, disabled: readOnly, className: d.wide ? 'sm:col-span-2' : undefined };
          if (d.control === 'select') return <SelectField key={d.name} {...common} options={d.options ?? []} />;
          if (d.control === 'textarea') return <AreaField key={d.name} {...common} maxLength={2000} />;
          return <TextField key={d.name} {...common} type={d.control === 'number' ? 'number' : d.control} min={d.min} max={d.max} />;
        })}
        {type === 'hotel' && values.checkIn && values.checkOut && values.checkOut > values.checkIn ? (
          <p className="m-0 self-end text-sm text-quiet">Nights: {Math.round((Date.parse(values.checkOut) - Date.parse(values.checkIn)) / 86_400_000)}</p>
        ) : null}
      </div>
      {type === 'flight' ? (
        <div className="flex flex-col gap-3">
          {segments.map((g, j) => (
            <Fieldset
              key={j}
              legend={`Leg ${j + 1}`}
              columns={2}
              actions={
                !readOnly && segments.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setSegments((x) => x.filter((_, i) => i !== j))}>
                    <Trash2 aria-hidden="true" /> Remove leg {j + 1}
                  </Button>
                ) : null
              }
            >
              <TextField id={`${prefix}-seg-${j + 1}-from`} name="segmentFrom" label="From" hint="Airport code or city." value={g.from} onChange={(v) => setSeg(j, { from: v })} error={err(`segmentFrom[${j}]`)} maxLength={60} disabled={readOnly} />
              <TextField id={`${prefix}-seg-${j + 1}-to`} name="segmentTo" label="To" value={g.to} onChange={(v) => setSeg(j, { to: v })} error={err(`segmentTo[${j}]`)} maxLength={60} disabled={readOnly} />
              <TextField id={`${prefix}-seg-${j + 1}-date`} name="segmentDate" label="Date" type="date" value={g.date} onChange={(v) => setSeg(j, { date: v })} error={err(`segmentDate[${j}]`)} disabled={readOnly} />
              <SelectField id={`${prefix}-seg-${j + 1}-flex`} name="segmentFlex" label="Flexibility" optional value={g.flex} onChange={(v) => setSeg(j, { flex: v })} options={FLEX_OPTIONS} disabled={readOnly} />
            </Fieldset>
          ))}
          {!readOnly && segments.length < MAX_SEGMENTS ? (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setSegments((x) => [...x, { from: '', to: '', date: '', flex: '' }])}>
                <Plus aria-hidden="true" /> Add leg
              </Button>
            </div>
          ) : null}
          <p className="m-0 text-sm text-quiet">PNR, ticket numbers and the fare are recorded later by the Flight team, not here.</p>
        </div>
      ) : null}
      {hasBudget(type) ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyField
            id={`${prefix}-budget`}
            name="purchaseBudgetRupees"
            label={type === 'flight' ? 'Flight budget ₹' : 'Purchase budget ₹'}
            hint="What the department may spend. Never shown as the selling price."
            optional
            value={values.purchaseBudgetRupees ?? ''}
            onChange={(v) => set('purchaseBudgetRupees', v)}
            error={err('purchaseBudgetRupees')}
            disabled={readOnly}
          />
        </div>
      ) : (
        <Notice tone="info">Documents are not uploaded here. The Visa &amp; Passport desk collects them on its task.</Notice>
      )}
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <PendingButton pendingLabel={item ? 'Saving…' : 'Adding…'} variant={item ? 'secondary' : 'primary'}>
            {item ? `Save service ${item.itemNo}` : `Add this ${B11_SERVICE_LABEL[type].toLowerCase()}`}
          </PendingButton>
          {!item && onDone ? (
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
          <span className="text-sm text-quiet">{f.dirty ? 'Unsaved changes.' : ''}</span>
        </div>
      ) : null}
    </form>
  );
}

function RemoveServiceForm({ view, item, order, action }: { view: BookNowView; item: BookItem; order: number; action: B11Action }) {
  const section = serviceSection(item.serviceType);
  const f = useSectionForm({ id: `${section}-svc-${item.itemNo}-remove`, section, label: `Remove service ${item.itemNo}`, order, action, initial: {}, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, saveable: false, tracksDirty: false });
  const { bindForm, bindResult } = f;
  const [confirming, setConfirming] = useState(false);
  return (
    <form ref={bindForm} action={f.formAction} noValidate className="flex flex-col gap-2 border-t border-line pt-3">
      <div ref={bindResult}>
        <ResultBox result={f.state} />
      </div>
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name="itemId" value={item.itemId} />
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-copy">Remove service {item.itemNo} from this draft?</span>
          <PendingButton pendingLabel="Removing…" variant="danger">
            Yes, remove service {item.itemNo}
          </PendingButton>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" /> Remove service {item.itemNo}
          </Button>
        </div>
      )}
    </form>
  );
}
