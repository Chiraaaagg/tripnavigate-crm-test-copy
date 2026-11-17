'use client';

import { Lock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Fieldset } from '@/components/ui/fieldset';
import { Notice } from '@/components/ui/notice';
import { TRIP_SCOPE_LABEL, TRIP_SCOPES, SERVICE_TYPES, type ServiceType } from '@/modules/fulfilment/contracts';
import {
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  CHARGE_KIND_LABEL,
  CHARGE_KINDS,
  DUE_RULE_LABEL,
  DUE_RULES,
  LINE_LIMITS,
  OPTION_KEY_LABEL,
  QUOTATION_CONTENT_LIMITS,
  QUOTATION_PLAN_LIMITS,
  QUOTATION_SECTION_LABEL,
  QUOTATION_TEXT,
  TIER_LABEL_MAX,
  UNIT_KIND_FIELDS,
  UNIT_KIND_LABEL,
  type CategoryKey,
  type ChargeKind,
  type OptionKey,
  type QuotationSection,
  type UnitKind,
} from '@/modules/quotations/contracts';
import { QFIELD } from '@/modules/quotations/forms';
import { allowedUnits, fixedCounts, formatInr, lineAmount, nearestExactTotals, optionKeysFor, paiseToRupeesText, parseWholeRupees } from '@/modules/quotations/money';
import { B11_SERVICE_LABEL } from '../b11/book-fields';
import { AreaField, CheckField, MoneyField, SelectField, TextField } from '../b11/controls';
import { BaseRowVersion, useSectionForm } from '../b11/draft-sync';
import { PendingButton } from '../b11/form-kit';
import { PrefillPanel } from '../b11/prefill-panel';
import { PrefillFillEmpty, PrefillReference, PrefillSectionCheck, usePrefillField, usePrefillInlineMode } from '../b11/prefill-inline';
import { QuoteCheckSummary, QuotePart, QuoteReadinessCard, SavePricesButton } from './quote-editor-shell';
import { InternalZone } from './internal-zone';
import { QUOTATION_PREFILL_FIELDS } from '@/modules/fulfilment/contracts';
import { factsOf, factsToFormValues, factsToSegments, FLEX_OPTIONS, itemSummary, MAX_SEGMENTS, SERVICE_FIELDS, type SegmentValues } from '../b11/service-fields';
import { inr0, lineFormula, mismatchText, QUOTE_TEXT, TIER_LABEL } from './quote-fields';
import { asSyncAction, INTERNAL_WORDING_FIELD_TEXT, QuoteResultBox, quoteProblem, type QuoteActions, type QuoteFieldRef } from './quote-kit';
import type { QuoteTierMoney, QuoteVersionView } from './quote-shapes';

/*
 * The quotation editor (B1.2 Phase E, draft and ready versions): one card per
 * section (anchors = QuotationSection, so the checklist links land on the
 * fix), each with its own save. All forms share the version's row version
 * through the booking DraftSync (own saves chain; someone else's save is a
 * conflict, never a silent overwrite). Prices only for commercial editors;
 * the estimated supplier cost and the remark are internal.
 */

const QUOTABLE_TYPES = SERVICE_TYPES as readonly ServiceType[];

interface EditorProps {
  version: QuoteVersionView;
  actions: QuoteActions;
  reloadHref: string;
  /** IST today (YYYY-MM-DD), for the validity date's minimum. */
  today: string;
}

export function QuoteEditor(p: EditorProps) {
  const v = p.version;
  const inline = usePrefillInlineMode();
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <QuoteCheckSummary />
        {inline ? <PrefillFillEmpty idPrefix="quote" /> : null}
        {v.prefill && !inline ? (
          <Card>
            <CardBody>
              <PrefillPanel
                prefill={v.prefill}
                target="quotation_version"
                versionId={v.versionId}
                rowVersion={v.rowVersion}
                editable={v.canEdit}
                useAction={p.actions.usePrefill}
                checkAction={p.actions.markPrefillChecked}
                codes={QUOTATION_PREFILL_FIELDS}
                showReference
                idPrefix="quote"
                reloadHref={p.reloadHref}
              />
            </CardBody>
          </Card>
        ) : null}
        {inline ? <PrefillReference /> : null}
        <DetailsSection {...p} />
        <ContactSection {...p} />
        <ServicesSection {...p} />
        <NarrativeSection {...p} />
        <MoneySection {...p} />
        <PlanSection {...p} />
      </div>
      <QuoteReadinessCard />
    </div>
  );
}

const PART_NO: Record<QuotationSection, number> = { details: 1, contact: 2, services: 3, narrative: 4, money: 5, plan: 6 };

function SectionCard({ section, description, children, footer }: { section: QuotationSection; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <QuotePart part={section} number={PART_NO[section]} description={description} footer={footer}>
      {children}
    </QuotePart>
  );
}

function SaveRow({ label, dirty, editable }: { label: string; dirty: boolean; editable: boolean }) {
  if (!editable) return <p className="m-0 text-sm text-quiet">You can view this but not change it. Sales on this deal or the branch Manager can change it.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PendingButton pendingLabel="Saving…" variant="secondary">
        {label}
      </PendingButton>
      <span className="text-sm text-quiet" aria-live="polite">
        {dirty ? 'Not saved yet' : 'All saved'}
      </span>
    </div>
  );
}

/**
 * Inside "Save prices" a price form has no button of its own; pressing Enter in
 * its only text field would still submit that one form alone (implicit
 * submission). Prices save together, so Enter does nothing there (Echo L6).
 */
const preventImplicitSave = (e: FormEvent<HTMLFormElement>) => e.preventDefault();

const err = (state: Parameters<typeof quoteProblem>[0], refs: QuoteFieldRef[], name: string) => quoteProblem(state, name, refs.find((r) => r.field === name)?.label ?? 'Check this field.');
const countText = (n: number) => (n > 0 ? String(n) : '');

// ---------------------------------------------------------------------------
// Trip, travellers and validity
// ---------------------------------------------------------------------------

function DetailsSection({ version: v, actions, reloadHref, today }: EditorProps) {
  const initial = {
    destination: v.trip.destination ?? '',
    tripScope: v.trip.scope ?? '',
    tripStart: v.trip.start ?? '',
    tripEnd: v.trip.end ?? '',
    adults: countText(v.pax.adults),
    childrenWithBed: countText(v.pax.childrenWithBed),
    childrenNoBed: countText(v.pax.childrenNoBed),
    infants: countText(v.pax.infants),
    paxRemarks: v.pax.paxRemarks ?? '',
    requirementsNote: v.requirementsNote ?? '',
    validUntil: v.validUntil ?? '',
  };
  const f = useSectionForm({ id: 'quote-details', section: 'details', label: QUOTATION_SECTION_LABEL.details, order: 1, action: asSyncAction(actions.saveDetails), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult, values: x, set } = f;
  const id = (n: string) => `q-details-${n}`;
  const refs: QuoteFieldRef[] = [
    { field: QFIELD.destination, id: id('destination'), label: 'Destination (up to 200 characters)' },
    { field: QFIELD.tripScope, id: id('tripScope'), label: 'Domestic or international' },
    { field: QFIELD.tripStart, id: id('tripStart'), label: 'Start date' },
    { field: QFIELD.tripEnd, id: id('tripEnd'), label: 'End date: on or after the start' },
    { field: QFIELD.adults, id: id('adults'), label: 'Adults: 0 to 100' },
    { field: QFIELD.childrenWithBed, id: id('childrenWithBed'), label: 'Children with a bed: 0 to 100' },
    { field: QFIELD.childrenNoBed, id: id('childrenNoBed'), label: 'Children without a bed: 0 to 100' },
    { field: QFIELD.infants, id: id('infants'), label: 'Infants: 0 to 100' },
    { field: QFIELD.paxRemarks, id: id('paxRemarks'), label: 'Remarks about the travellers (up to 500 characters)' },
    { field: QFIELD.requirementsNote, id: id('requirementsNote'), label: 'What the customer asked for (up to 4,000 characters)' },
    { field: QFIELD.validUntil, id: id('validUntil'), label: 'Valid until: today or later' },
  ];
  const e = (n: string) => err(f.state, refs, n);
  const editable = v.canEdit;
  const pfStart = usePrefillField(id('tripStart'), 'trip.start');
  const pfEnd = usePrefillField(id('tripEnd'), 'trip.end');
  const pfNote = usePrefillField(id('requirementsNote'), 'requirementsNote', 'Internal — not printed.');
  return (
    <SectionCard section="details" description="Numbers only. Names go on the booking later." footer={<PrefillSectionCheck section="details" idPrefix="quote-details" />}>
      <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={QUOTATION_SECTION_LABEL.details} className="flex flex-col gap-4">
        <div ref={bindResult}>
          <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
        </div>
        <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
        <BaseRowVersion base={f.base} />
        <Fieldset legend="Trip" columns={2}>
          <TextField id={id('destination')} name={QFIELD.destination} label="Destination" value={x.destination} onChange={(val) => set('destination', val)} error={e(QFIELD.destination)} maxLength={200} disabled={!editable} />
          <SelectField id={id('tripScope')} name={QFIELD.tripScope} label="Domestic or international" value={x.tripScope} onChange={(val) => set('tripScope', val)} error={e(QFIELD.tripScope)} disabled={!editable} options={[{ value: '', label: 'Choose' }, ...TRIP_SCOPES.map((s) => ({ value: s, label: TRIP_SCOPE_LABEL[s] }))]} />
          <TextField id={id('tripStart')} name={QFIELD.tripStart} label="Start date" type="date" {...pfStart} value={x.tripStart} onChange={(val) => set('tripStart', val)} error={e(QFIELD.tripStart)} disabled={!editable} />
          <TextField id={id('tripEnd')} name={QFIELD.tripEnd} label="End date" type="date" {...pfEnd} value={x.tripEnd} onChange={(val) => set('tripEnd', val)} error={e(QFIELD.tripEnd)} min={x.tripStart || undefined} disabled={!editable} />
        </Fieldset>
        <Fieldset legend="Travellers" description="Adults and children are counted for the per-person price; infants are not." columns={2}>
          <TextField id={id('adults')} name={QFIELD.adults} label="Adults" type="number" min={0} max={100} value={x.adults} onChange={(val) => set('adults', val)} error={e(QFIELD.adults)} disabled={!editable} />
          <TextField id={id('childrenWithBed')} name={QFIELD.childrenWithBed} label="Children with a bed" type="number" min={0} max={100} optional value={x.childrenWithBed} onChange={(val) => set('childrenWithBed', val)} error={e(QFIELD.childrenWithBed)} disabled={!editable} />
          <TextField id={id('childrenNoBed')} name={QFIELD.childrenNoBed} label="Children without a bed" type="number" min={0} max={100} optional value={x.childrenNoBed} onChange={(val) => set('childrenNoBed', val)} error={e(QFIELD.childrenNoBed)} disabled={!editable} />
          <TextField id={id('infants')} name={QFIELD.infants} label="Infants" type="number" min={0} max={100} optional value={x.infants} onChange={(val) => set('infants', val)} error={e(QFIELD.infants)} disabled={!editable} />
          <AreaField id={id('paxRemarks')} name={QFIELD.paxRemarks} label="Remarks about the travellers" optional rows={2} maxLength={500} value={x.paxRemarks} onChange={(val) => set('paxRemarks', val)} error={e(QFIELD.paxRemarks)} disabled={!editable} className="sm:col-span-2" />
        </Fieldset>
        <AreaField id={id('requirementsNote')} name={QFIELD.requirementsNote} label="What the customer asked for" {...pfNote} optional rows={3} maxLength={QUOTATION_CONTENT_LIMITS.requirementsNote} value={x.requirementsNote} onChange={(val) => set('requirementsNote', val)} error={e(QFIELD.requirementsNote)} disabled={!editable} />
        <div className="max-w-xs">
          <TextField id={id('validUntil')} name={QFIELD.validUntil} label="Valid until" type="date" optional min={today} hint="Set to 7 days after the quotation was made. Change it before you share it if needed." value={x.validUntil} onChange={(val) => set('validUntil', val)} error={e(QFIELD.validUntil)} disabled={!editable} />
        </div>
        <SaveRow label="Save trip and travellers" dirty={f.dirty} editable={editable} />
      </HandForm>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Customer contact
// ---------------------------------------------------------------------------

function ContactSection({ version: v, actions, reloadHref }: EditorProps) {
  const initial = { contactName: v.contact?.contactName ?? '', mobile: v.contact?.mobile ?? '', email: v.contact?.email ?? '', companyName: v.contact?.companyName ?? '', bookingFor: v.contact?.bookingFor ?? 'individual' };
  const f = useSectionForm({ id: 'quote-contact', section: 'contact', label: QUOTATION_SECTION_LABEL.contact, order: 2, action: asSyncAction(actions.saveContact), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult, values: x, set } = f;
  const id = (n: string) => `q-contact-${n}`;
  const refs: QuoteFieldRef[] = [
    { field: QFIELD.contactName, id: id('contactName'), label: 'Name (1 to 120 characters)' },
    { field: QFIELD.mobile, id: id('mobile'), label: 'Mobile: a 10-digit Indian number, or give an e-mail' },
    { field: QFIELD.email, id: id('email'), label: 'E-mail: a valid address, or give a mobile' },
    { field: QFIELD.companyName, id: id('companyName'), label: 'Company (up to 200 characters)' },
    { field: QFIELD.bookingFor, id: id('bookingFor'), label: 'Booking for: an individual or a business' },
  ];
  const e = (n: string) => err(f.state, refs, n);
  const pfName = usePrefillField(id('contactName'), 'contacts.contactName');
  const pfCompany = usePrefillField(id('companyName'), 'contacts.companyName');
  const pfMobile = usePrefillField(id('mobile'), 'contacts.mobile');
  const pfEmail = usePrefillField(id('email'), 'contacts.email');
  const pfFor = usePrefillField(id('bookingFor'), 'contacts.bookingFor', 'Carried into the booking when it starts from this quotation.');
  return (
    <SectionCard section="contact" description={v.contact?.contactName ? `Printed as “For ${v.contact.contactName}”. Mobile or email needed.` : 'Printed as “For” and the customer’s name. Mobile or email needed.'} footer={<PrefillSectionCheck section="contact" idPrefix="quote-contact" />}>
      <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={QUOTATION_SECTION_LABEL.contact} className="flex flex-col gap-4">
        <div ref={bindResult}>
          <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
        </div>
        <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
        <BaseRowVersion base={f.base} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id={id('contactName')} name={QFIELD.contactName} label="Customer name" autoComplete="off" {...pfName} maxLength={120} value={x.contactName} onChange={(val) => set('contactName', val)} error={e(QFIELD.contactName)} disabled={!v.canEdit} />
          <TextField id={id('companyName')} name={QFIELD.companyName} label="Company" optional {...pfCompany} maxLength={200} value={x.companyName} onChange={(val) => set('companyName', val)} error={e(QFIELD.companyName)} disabled={!v.canEdit} />
          <TextField id={id('mobile')} name={QFIELD.mobile} label="Mobile" type="tel" inputMode="tel" optional {...pfMobile} value={x.mobile} onChange={(val) => set('mobile', val)} error={e(QFIELD.mobile)} disabled={!v.canEdit} />
          <TextField id={id('email')} name={QFIELD.email} label="E-mail" type="email" inputMode="email" optional {...pfEmail} maxLength={254} value={x.email} onChange={(val) => set('email', val)} error={e(QFIELD.email)} disabled={!v.canEdit} />
          <SelectField
            id={id('bookingFor')}
            name={QFIELD.bookingFor}
            label="Booking for"
            {...pfFor}
            value={x.bookingFor}
            onChange={(val) => set('bookingFor', val as 'individual' | 'business')}
            error={e(QFIELD.bookingFor)}
            disabled={!v.canEdit}
            options={[
              { value: 'individual', label: 'An individual' },
              { value: 'business', label: 'A business (GST)' },
            ]}
          />
        </div>
        <SaveRow label="Save contact" dirty={f.dirty} editable={v.canEdit} />
      </HandForm>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Services (one form per service; the booking's fact fields)
// ---------------------------------------------------------------------------

function ServicesSection(p: EditorProps) {
  const v = p.version;
  const [adding, setAdding] = useState<ServiceType | ''>('');
  const [choice, setChoice] = useState<ServiceType | ''>('');
  const items = [...v.items].sort((a, b) => a.itemNo - b.itemNo);
  return (
    <SectionCard section="services" description="These details copy into the booking later.">
      {items.length === 0 ? <p className="m-0 text-copy">No service yet.</p> : null}
      {items.map((item, i) => (
        <Fieldset key={item.itemId} legend={`Service ${item.itemNo} · ${B11_SERVICE_LABEL[item.serviceType]}`} description={itemSummary({ serviceType: item.serviceType, facts: item.service, title: item.title }) || item.title} columns={1}>
          {!item.factsValid ? (
            <Notice tone="warning" role="note">
              Some details of this service are missing or no longer valid. Fill the highlighted fields and save.
            </Notice>
          ) : null}
          <details open={!item.factsValid} className="group">
            <summary className={cn('inline-flex min-h-11 cursor-pointer items-center rounded-control font-medium text-brand-strong underline underline-offset-4', focusRing)}>
              {v.canEdit ? `Edit the details of service ${item.itemNo}` : `Details of service ${item.itemNo}`}
            </summary>
            <div className="pt-3">
              <ItemForm {...p} type={item.serviceType} item={item} order={10 + i} />
            </div>
          </details>
          {v.canEdit ? <RemoveItemForm {...p} itemId={item.itemId} itemNo={item.itemNo} order={10 + i} /> : null}
        </Fieldset>
      ))}
      {v.canEdit ? (
        adding ? (
          <Fieldset legend={`New ${B11_SERVICE_LABEL[adding].toLowerCase()}`} columns={1}>
            <ItemForm {...p} key={adding} type={adding} order={90} onDone={() => setAdding('')} />
          </Fieldset>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 max-w-full">
              <SelectField
                id="q-services-add-type"
                name="addServiceType"
                label="Add a service"
                value={choice}
                onChange={(val) => setChoice(val as ServiceType | '')}
                options={[{ value: '', label: 'Choose the kind of service' }, ...QUOTABLE_TYPES.map((t) => ({ value: t, label: B11_SERVICE_LABEL[t] }))]}
              />
            </div>
            <Button variant="secondary" className="min-h-11" disabled={!choice} onClick={() => choice && setAdding(choice)}>
              <Plus aria-hidden="true" /> Add {choice ? B11_SERVICE_LABEL[choice].toLowerCase() : 'service'}
            </Button>
          </div>
        )
      ) : null}
      <p className="m-0 text-sm text-quiet">Train bookings are deferred and can’t be added.</p>
    </SectionCard>
  );
}

type QuoteItem = QuoteVersionView['items'][number];

function ItemForm({ version: v, actions, reloadHref, type, item, order, onDone }: EditorProps & { type: ServiceType; item?: QuoteItem; order: number; onDone?: () => void }) {
  const facts = item ? factsOf({ facts: item.service }) : null;
  const initial = {
    values: factsToFormValues(type, facts),
    segments: factsToSegments(facts) as SegmentValues[],
    tierKey: item?.tierKey ?? '',
  };
  const formId = item ? `q-item-${item.itemNo}` : `q-item-new-${type}`;
  const f = useSectionForm({
    id: formId,
    section: 'services',
    label: item ? `Service ${item.itemNo}` : `New ${B11_SERVICE_LABEL[type].toLowerCase()}`,
    order,
    action: asSyncAction(actions.saveItem),
    initial,
    versionBound: true,
    rowVersion: v.rowVersion,
    saveable: Boolean(item),
    tracksDirty: true,
    onSuccess: () => {
      if (!item) onDone?.();
    },
  });
  const { bindForm, bindResult } = f;
  const values = f.values.values;
  const segments = f.values.segments;
  const defs = SERVICE_FIELDS[type].filter((d) => !d.when || d.when(values));
  const refs: QuoteFieldRef[] = [
    ...defs.map((d) => ({ field: d.name, id: `${formId}-${d.name}`, label: d.label })),
    { field: QFIELD.itemTierKey, id: `${formId}-tier`, label: 'Offered in' },
    ...segments.flatMap((_, j) => [
      { field: `segmentFrom[${j}]`, id: `${formId}-seg-${j + 1}-from`, label: `Leg ${j + 1}: from` },
      { field: `segmentTo[${j}]`, id: `${formId}-seg-${j + 1}-to`, label: `Leg ${j + 1}: to` },
      { field: `segmentDate[${j}]`, id: `${formId}-seg-${j + 1}-date`, label: `Leg ${j + 1}: date (in order)` },
    ]),
  ];
  const e = (n: string) => err(f.state, refs, n);
  const set = (k: string, val: string) => f.setValues((x) => ({ ...x, values: { ...x.values, [k]: val } }));
  const setTop = (k: 'tierKey', val: string) => f.setValues((x) => ({ ...x, [k]: val }));
  const setSegments = (fn: (x: SegmentValues[]) => SegmentValues[]) => f.setValues((x) => ({ ...x, segments: fn(x.segments) }));
  const setSeg = (j: number, patch: Partial<SegmentValues>) => setSegments((x) => x.map((s, i) => (i === j ? { ...s, ...patch } : s)));
  const hasUpgrade = v.tiers.some((t) => t.tierKey === 'upgrade');
  const editable = v.canEdit;
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={item ? `Details of service ${item.itemNo}` : `New ${B11_SERVICE_LABEL[type].toLowerCase()} service`} className="flex flex-col gap-4">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={item ? QUOTATION_TEXT.saved : QUOTATION_TEXT.itemAdded} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name={QFIELD.itemId} value={item?.itemId ?? ''} />
      <input type="hidden" name={QFIELD.serviceType} value={type} />
      {hasUpgrade ? (
        <div className="max-w-sm">
          <SelectField
            id={`${formId}-tier`}
            name={QFIELD.itemTierKey}
            label="Offered in"
            value={f.values.tierKey}
            onChange={(val) => setTop('tierKey', val)}
            error={e(QFIELD.itemTierKey)}
            disabled={!editable}
            options={[
              { value: '', label: 'Both options' },
              { value: 'quoted', label: 'Quoted option only' },
              { value: 'upgrade', label: 'Upgrade option only' },
            ]}
          />
        </div>
      ) : (
        <input type="hidden" name={QFIELD.itemTierKey} value={f.values.tierKey} />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {defs.map((d) => {
          const common = { id: `${formId}-${d.name}`, name: d.name, label: d.label, value: values[d.name] ?? '', onChange: (val: string) => set(d.name, val), hint: d.hint, error: e(d.name), optional: !d.required, disabled: !editable, className: d.wide ? 'sm:col-span-2' : undefined };
          if (d.control === 'select') return <SelectField key={d.name} {...common} options={d.options ?? []} />;
          if (d.control === 'textarea') return <AreaField key={d.name} {...common} maxLength={2000} />;
          return <TextField key={d.name} {...common} type={d.control === 'number' ? 'number' : d.control} min={d.min} max={d.max} />;
        })}
      </div>
      {type === 'flight' ? (
        <div className="flex flex-col gap-3">
          {segments.map((g, j) => (
            <Fieldset
              key={j}
              legend={`Leg ${j + 1}`}
              columns={2}
              actions={
                editable && segments.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setSegments((x) => x.filter((_, i) => i !== j))}>
                    <Trash2 aria-hidden="true" /> Remove leg {j + 1}
                  </Button>
                ) : null
              }
            >
              <TextField id={`${formId}-seg-${j + 1}-from`} name="segmentFrom" label="From" hint="Airport code or city." value={g.from} onChange={(val) => setSeg(j, { from: val })} error={e(`segmentFrom[${j}]`)} maxLength={60} disabled={!editable} />
              <TextField id={`${formId}-seg-${j + 1}-to`} name="segmentTo" label="To" value={g.to} onChange={(val) => setSeg(j, { to: val })} error={e(`segmentTo[${j}]`)} maxLength={60} disabled={!editable} />
              <TextField id={`${formId}-seg-${j + 1}-date`} name="segmentDate" label="Date" type="date" value={g.date} onChange={(val) => setSeg(j, { date: val })} error={e(`segmentDate[${j}]`)} disabled={!editable} />
              <SelectField id={`${formId}-seg-${j + 1}-flex`} name="segmentFlex" label="Flexibility" optional value={g.flex} onChange={(val) => setSeg(j, { flex: val })} options={FLEX_OPTIONS} disabled={!editable} />
            </Fieldset>
          ))}
          {editable && segments.length < MAX_SEGMENTS ? (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setSegments((x) => [...x, { from: '', to: '', date: '', flex: '' }])}>
                <Plus aria-hidden="true" /> Add leg
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          <PendingButton pendingLabel={item ? 'Saving…' : 'Adding…'} variant={item ? 'secondary' : 'primary'}>
            {item ? `Save service ${item.itemNo}` : `Add this ${B11_SERVICE_LABEL[type].toLowerCase()}`}
          </PendingButton>
          {!item && onDone ? (
            <Button variant="ghost" className="min-h-11" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
          <span className="text-sm text-quiet">{f.dirty ? 'Unsaved changes.' : ''}</span>
        </div>
      ) : null}
    </HandForm>
  );
}

function RemoveItemForm({ version: v, actions, itemId, itemNo, order }: EditorProps & { itemId: string; itemNo: number; order: number }) {
  const f = useSectionForm({ id: `q-item-${itemNo}-remove`, section: 'services', label: `Remove service ${itemNo}`, order, action: asSyncAction(actions.removeItem), initial: {}, versionBound: true, rowVersion: v.rowVersion, saveable: false, tracksDirty: false });
  const { bindForm, bindResult } = f;
  const [confirming, setConfirming] = useState(false);
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate className="flex flex-col gap-2 border-t border-line pt-3">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state && !f.state.ok ? f.state : null} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name={QFIELD.itemId} value={itemId} />
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-copy">Remove service {itemNo}? Its price lines are removed too.</span>
          <PendingButton pendingLabel="Removing…" variant="danger">
            Yes, remove service {itemNo}
          </PendingButton>
          <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" /> Remove service {itemNo}
          </Button>
        </div>
      )}
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Day-by-day, included, not included, terms
// ---------------------------------------------------------------------------

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function NarrativeSection({ version: v, actions, reloadHref }: EditorProps) {
  const c = v.content;
  const initial = {
    days: c.days.length > 0 ? c.days.map((d) => ({ title: d.title, text: d.text ?? '' })) : [{ title: '', text: '' }],
    includes: c.includes.join('\n'),
    excludes: c.excludes.join('\n'),
    terms: c.terms.join('\n'),
    notes: c.notes ?? '',
  };
  const f = useSectionForm({ id: 'quote-narrative', section: 'narrative', label: QUOTATION_SECTION_LABEL.narrative, order: 30, action: asSyncAction(actions.saveContent), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult, values: x, set } = f;
  const editable = v.canEdit;
  const refs: QuoteFieldRef[] = [
    ...x.days.flatMap((_, i) => [
      { field: `${QFIELD.dayTitle}[${i}]`, id: `q-day-${i + 1}-title`, label: `Day ${i + 1}: title (1 to 120 characters)` },
      { field: `${QFIELD.dayText}[${i}]`, id: `q-day-${i + 1}-text`, label: `Day ${i + 1}: text (up to 2,000 characters)` },
    ]),
    { field: QFIELD.dayTitle, id: 'q-day-1-title', label: 'Days: at most 60' },
    ...['include', 'exclude', 'term'].flatMap((n) => [
      { field: n, id: `q-narrative-${n}`, label: `${n === 'include' ? 'Included' : n === 'exclude' ? 'Not included' : 'Terms'}: at most 40 lines` },
      ...Array.from({ length: 40 }, (_, i) => ({ field: `${n}[${i}]`, id: `q-narrative-${n}`, label: `${n === 'include' ? 'Included' : n === 'exclude' ? 'Not included' : 'Terms'}: line ${i + 1} is longer than 300 characters` })),
    ]),
    { field: QFIELD.notes, id: 'q-narrative-notes', label: 'Notes (up to 2,000 characters)' },
  ];
  const e = (n: string) => err(f.state, refs, n);
  const listError = (n: string) => (quoteFieldsOfAny(f.state, n) ? (f.state && !f.state.ok && (f.state as { code: string }).code === 'internal_wording' ? INTERNAL_WORDING_FIELD_TEXT : (refs.find((r) => r.field === n)?.label ?? 'Check this list.')) : null);
  const setDay = (i: number, patch: Partial<{ title: string; text: string }>) => set('days', x.days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <SectionCard section="narrative" description="Customer sees this. Do not write costs or supplier names.">
      <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={QUOTATION_SECTION_LABEL.narrative} className="flex flex-col gap-4">
        <div ref={bindResult}>
          <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
        </div>
        <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
        <BaseRowVersion base={f.base} />
        {x.days.map((d, i) => (
          <Fieldset
            key={i}
            legend={`Day ${i + 1}`}
            columns={1}
            actions={
              editable && x.days.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => set('days', x.days.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden="true" /> Remove day {i + 1}
                </Button>
              ) : null
            }
          >
            <TextField id={`q-day-${i + 1}-title`} name={QFIELD.dayTitle} label="Title" maxLength={QUOTATION_CONTENT_LIMITS.dayTitle} value={d.title} onChange={(val) => setDay(i, { title: val })} error={e(`${QFIELD.dayTitle}[${i}]`)} disabled={!editable} />
            <AreaField id={`q-day-${i + 1}-text`} name={QFIELD.dayText} label="What happens" optional rows={3} maxLength={QUOTATION_CONTENT_LIMITS.dayText} value={d.text} onChange={(val) => setDay(i, { text: val })} error={e(`${QFIELD.dayText}[${i}]`)} disabled={!editable} />
          </Fieldset>
        ))}
        {editable && x.days.length < QUOTATION_CONTENT_LIMITS.days ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => set('days', [...x.days, { title: '', text: '' }])}>
              <Plus aria-hidden="true" /> Add day {x.days.length + 1}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <AreaField id="q-narrative-include" name="includeText" label="Included" hint="One per line." optional rows={5} value={x.includes} onChange={(val) => set('includes', val)} error={listError('include')} disabled={!editable} />
          <AreaField id="q-narrative-exclude" name="excludeText" label="Not included" hint="One per line." optional rows={5} value={x.excludes} onChange={(val) => set('excludes', val)} error={listError('exclude')} disabled={!editable} />
        </div>
        <AreaField id="q-narrative-term" name="termText" label="Terms" hint="One per line, for example “Hotels are held only after confirmation.”" optional rows={4} value={x.terms} onChange={(val) => set('terms', val)} error={listError('term')} disabled={!editable} />
        <AreaField id="q-narrative-notes" name={QFIELD.notes} label="Notes for the customer" optional rows={3} maxLength={QUOTATION_CONTENT_LIMITS.notes} value={x.notes} onChange={(val) => set('notes', val)} error={e(QFIELD.notes)} disabled={!editable} />
        {linesOf(x.includes).map((l, i) => (
          <input key={`inc-${i}`} type="hidden" name={QFIELD.include} value={l} />
        ))}
        {linesOf(x.excludes).map((l, i) => (
          <input key={`exc-${i}`} type="hidden" name={QFIELD.exclude} value={l} />
        ))}
        {linesOf(x.terms).map((l, i) => (
          <input key={`term-${i}`} type="hidden" name={QFIELD.term} value={l} />
        ))}
        <SaveRow label="Save day-by-day and terms" dirty={f.dirty} editable={editable} />
      </HandForm>
    </SectionCard>
  );
}

/** True when the refusal names the list or any of its lines. */
function quoteFieldsOfAny(state: Parameters<typeof quoteProblem>[0], base: string): boolean {
  if (!state || state.ok || !('fields' in state) || !state.fields) return false;
  return state.fields.some((f) => f === base || f.startsWith(`${base}[`));
}

// ---------------------------------------------------------------------------
// Prices and totals (commercial editors only)
// ---------------------------------------------------------------------------

function MoneySection(p: EditorProps) {
  const v = p.version;
  const prices = Boolean(v.money && v.canEditMoney && v.canEdit);
  return (
    <SectionCard section="money" description="You type each price and the final total. The CRM never changes your total and never calculates GST." footer={prices ? <SavePricesButton /> : null}>
      <TiersForm {...p} ownSave={!prices} />
      {v.money && v.canEditMoney ? (
        <>
          <LinesForm {...p} ownSave={!prices} />
          {v.money.tiers.map((t, i) => (
            <TierTotalForm key={t.tierKey} {...p} tier={t} order={60 + i} ownSave={!prices} />
          ))}
        </>
      ) : v.money ? (
        <Notice tone="locked">Prices can be changed only by the Sales owner, an assigned salesperson or the branch Manager while the version is a draft.</Notice>
      ) : (
        <Notice tone="locked">{QUOTE_TEXT.pricesForEditors}</Notice>
      )}
    </SectionCard>
  );
}

function TiersForm({ version: v, actions, reloadHref, ownSave = true }: EditorProps & { ownSave?: boolean }) {
  const quoted = v.tiers.find((t) => t.tierKey === 'quoted');
  const upgrade = v.tiers.find((t) => t.tierKey === 'upgrade');
  const initial = { quoted: quoted?.label ?? '', upgradeOffered: Boolean(upgrade), upgrade: upgrade?.label ?? '' };
  const f = useSectionForm({ id: 'quote-tiers', section: 'money', label: 'Options offered', order: 40, action: asSyncAction(actions.saveTiers), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult, values: x, set } = f;
  const refs: QuoteFieldRef[] = [
    { field: QFIELD.quotedTierLabel, id: 'q-tier-quoted', label: 'Name of the quoted option (up to 80 characters)' },
    { field: QFIELD.upgradeTierLabel, id: 'q-tier-upgrade', label: 'Name of the upgrade option (up to 80 characters)' },
  ];
  const e = (n: string) => err(f.state, refs, n);
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label="Options offered" onSubmit={ownSave ? undefined : preventImplicitSave} className="flex flex-col gap-4">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <Fieldset legend="Options offered" description="Your main option, and an optional upgrade. The customer picks one." columns={2}>
        <TextField id="q-tier-quoted" name={QFIELD.quotedTierLabel} label="Quoted option" hint="For example: Deluxe rooms." maxLength={TIER_LABEL_MAX} value={x.quoted} onChange={(val) => set('quoted', val)} error={e(QFIELD.quotedTierLabel)} disabled={!v.canEdit} />
        <div className="flex flex-col gap-3">
          <CheckField id="q-tier-upgrade-offered" name={QFIELD.upgradeOffered} label="Also offer an upgrade option" checked={x.upgradeOffered} onChange={(val) => set('upgradeOffered', val)} disabled={!v.canEdit} />
          {x.upgradeOffered ? <TextField id="q-tier-upgrade" name={QFIELD.upgradeTierLabel} label="Upgrade option" hint="For example: Suites." maxLength={TIER_LABEL_MAX} value={x.upgrade} onChange={(val) => set('upgrade', val)} error={e(QFIELD.upgradeTierLabel)} disabled={!v.canEdit} /> : null}
        </div>
      </Fieldset>
      {ownSave ? <SaveRow label="Save options" dirty={f.dirty} editable={v.canEdit} /> : null}
    </HandForm>
  );
}

interface LineRow {
  optionKey: OptionKey;
  itemId: string;
  chargeKind: ChargeKind;
  categoryKey: CategoryKey;
  description: string;
  unitKind: UnitKind | '';
  units: string;
  periods: string;
  sell: string;
  cost: string;
  remark: string;
}

const CATEGORY_OF: Record<ServiceType, CategoryKey> = { hotel: 'hotels', flight: 'flights', transfer: 'transfers', activity: 'tours', visa: 'visas', passport: 'other' } as Record<ServiceType, CategoryKey>;
const EMPTY_LINE: LineRow = { optionKey: 'common', itemId: '', chargeKind: 'main', categoryKey: 'other', description: '', unitKind: '', units: '', periods: '', sell: '', cost: '', remark: '' };

function nightsBetween(a: unknown, b: unknown): number | null {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || b <= a) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function LinesForm({ version: v, actions, reloadHref, ownSave = true }: EditorProps & { ownSave?: boolean }) {
  const m = v.money!;
  const initial = {
    rows: m.lines.length
      ? m.lines.map<LineRow>((l) => ({
          optionKey: l.optionKey,
          itemId: l.itemId ?? '',
          chargeKind: l.chargeKind,
          categoryKey: l.categoryKey,
          description: l.description,
          unitKind: l.unitKind,
          units: String(l.units),
          periods: String(l.periods),
          sell: paiseToRupeesText(l.unitSellPaise),
          cost: l.unitCostPaise === null ? '' : paiseToRupeesText(l.unitCostPaise),
          remark: l.remark ?? '',
        }))
      : [EMPTY_LINE],
  };
  const f = useSectionForm({ id: 'quote-lines', section: 'money', label: 'Price lines', order: 50, action: asSyncAction(actions.saveLines), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult } = f;
  const rows = f.values.rows;
  const setRows = (fn: (x: LineRow[]) => LineRow[]) => f.setValues((x) => ({ ...x, rows: fn(x.rows) }));
  const itemOf = (id: string) => v.items.find((i) => i.itemId === id) ?? null;
  const options = optionKeysFor(v.tiers.map((t) => t.tierKey));
  const names = ['lineOptionKey', 'lineItemId', 'lineChargeKind', 'lineCategoryKey', 'lineDescription', 'lineUnitKind', 'lineUnits', 'linePeriods', 'lineUnitSellRupees', 'lineUnitCostRupees', 'lineRemark'] as const;
  const labels: Record<(typeof names)[number], string> = {
    lineOptionKey: 'option',
    lineItemId: 'service',
    lineChargeKind: 'kind of charge',
    lineCategoryKey: 'category',
    lineDescription: 'description (1 to 200 characters)',
    lineUnitKind: 'unit (must fit the service)',
    lineUnits: 'count (1 to 999)',
    linePeriods: 'nights or trips (1 to 366)',
    lineUnitSellRupees: 'price in whole rupees',
    lineUnitCostRupees: 'estimated cost in rupees (up to 2 decimals)',
    lineRemark: 'internal remark (up to 300 characters)',
  };
  const refs: QuoteFieldRef[] = rows.flatMap((_, i) => names.map((n) => ({ field: `${n}[${i}]`, id: `q-line-${i + 1}-${n}`, label: `Line ${i + 1}: ${labels[n]}` })));
  refs.push({ field: 'lineDescription', id: 'q-line-1-lineDescription', label: `At most ${LINE_LIMITS.lines} lines` });
  const e = (n: string) => err(f.state, refs, n);
  const update = (i: number, patch: Partial<LineRow>) =>
    setRows((x) =>
      x.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        const item = itemOf(next.itemId);
        const allowed = allowedUnits(next.chargeKind, item?.serviceType ?? null);
        if (next.unitKind && !allowed.includes(next.unitKind)) next.unitKind = '';
        if (!next.unitKind && allowed.length === 1) next.unitKind = allowed[0]!;
        if ('itemId' in patch && item) {
          next.categoryKey = CATEGORY_OF[item.serviceType] ?? 'other';
          if (item.tierKey) next.optionKey = item.tierKey;
          // Main hotel and cab lines may be prefilled (visible, staff confirm); extra beds never are.
          const facts = factsOf({ facts: item.service });
          if (next.chargeKind === 'main' && item.serviceType === 'hotel') {
            if (!next.units && typeof facts.rooms === 'number') next.units = String(facts.rooms);
            const n = nightsBetween(facts.checkIn, facts.checkOut);
            if (!next.periods && n) next.periods = String(n);
          }
          if (!next.description) next.description = item.title;
        }
        return next;
      }),
    );
  const amountOf = (r: LineRow): string | null => {
    const sell = parseWholeRupees(r.sell);
    if (!sell || !r.unitKind) return null;
    const fixed = fixedCounts(r.unitKind);
    const u = fixed.units ?? Number(r.units);
    const p = fixed.periods ?? Number(r.periods);
    if (!Number.isInteger(u) || !Number.isInteger(p) || u < 1 || p < 1) return null;
    return lineFormula({ unitKind: r.unitKind, units: u, periods: p, unitSellPaise: sell, lineSellPaise: String(lineAmount(BigInt(sell), u, p)) });
  };
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label="Price lines" onSubmit={ownSave ? undefined : preventImplicitSave} className="flex flex-col gap-4">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <h3 id="q-lines-heading" tabIndex={-1} className="m-0 text-base font-semibold text-ink outline-none">
        Price lines
      </h3>
      <p className="m-0 text-copy">
        What each part costs the customer. Counts are exactly what you type.
      </p>
      {rows.map((r, i) => {
        const item = itemOf(r.itemId);
        const units = allowedUnits(r.chargeKind, item?.serviceType ?? null);
        const fixed = r.unitKind ? fixedCounts(r.unitKind) : { units: null, periods: null };
        const fieldsFor = r.unitKind ? UNIT_KIND_FIELDS[r.unitKind] : { units: 'Count', periods: 'Nights or trips' };
        const amount = amountOf(r);
        const id = (n: string) => `q-line-${i + 1}-${n}`;
        return (
          <Fieldset
            key={i}
            legend={`Line ${i + 1}`}
            columns={3}
            actions={
              rows.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden="true" /> Remove line {i + 1}
                </Button>
              ) : null
            }
          >
            <p className="m-0 text-sm font-semibold text-ink sm:col-span-2 lg:col-span-3">Customer sees</p>
            <SelectField id={id('lineItemId')} name={QFIELD.lineItemId} label="Service" value={r.itemId} onChange={(val) => update(i, { itemId: val })} error={e(`lineItemId[${i}]`)} options={[{ value: '', label: 'No service (other charge)' }, ...v.items.map((it) => ({ value: it.itemId, label: `Service ${it.itemNo} · ${B11_SERVICE_LABEL[it.serviceType]}` }))]} />
            <SelectField id={id('lineChargeKind')} name={QFIELD.lineChargeKind} label="Kind of charge" value={r.chargeKind} onChange={(val) => update(i, { chargeKind: val as ChargeKind })} error={e(`lineChargeKind[${i}]`)} options={CHARGE_KINDS.filter((k) => (k === 'extra_bed' || k === 'child_no_bed' ? item?.serviceType === 'hotel' : true)).map((k) => ({ value: k, label: CHARGE_KIND_LABEL[k] }))} />
            <SelectField id={id('lineOptionKey')} name={QFIELD.lineOptionKey} label="Option" value={r.optionKey} onChange={(val) => update(i, { optionKey: val as OptionKey })} error={e(`lineOptionKey[${i}]`)} options={options.map((o) => ({ value: o, label: OPTION_KEY_LABEL[o] }))} />
            <TextField id={id('lineDescription')} name={QFIELD.lineDescription} label="Description (printed)" maxLength={LINE_LIMITS.description} value={r.description} onChange={(val) => update(i, { description: val })} error={e(`lineDescription[${i}]`)} className="sm:col-span-2" />
            <SelectField id={id('lineCategoryKey')} name={QFIELD.lineCategoryKey} label="Category" value={r.categoryKey} onChange={(val) => update(i, { categoryKey: val as CategoryKey })} error={e(`lineCategoryKey[${i}]`)} options={CATEGORY_KEYS.map((k) => ({ value: k, label: CATEGORY_LABEL[k] }))} />
            <SelectField id={id('lineUnitKind')} name={QFIELD.lineUnitKind} label="Unit" value={r.unitKind} onChange={(val) => update(i, { unitKind: val as UnitKind })} error={e(`lineUnitKind[${i}]`)} options={[{ value: '', label: 'Choose' }, ...units.map((u) => ({ value: u, label: UNIT_KIND_LABEL[u] }))]} />
            {fixed.units ? <input type="hidden" name={QFIELD.lineUnits} value="1" /> : <TextField id={id('lineUnits')} name={QFIELD.lineUnits} label={fieldsFor.units} type="number" min={1} max={999} value={r.units} onChange={(val) => update(i, { units: val })} error={e(`lineUnits[${i}]`)} />}
            {fixed.periods ? <input type="hidden" name={QFIELD.linePeriods} value="1" /> : <TextField id={id('linePeriods')} name={QFIELD.linePeriods} label={fieldsFor.periods ?? 'Periods'} type="number" min={1} max={366} value={r.periods} onChange={(val) => update(i, { periods: val })} error={e(`linePeriods[${i}]`)} />}
            <MoneyField id={id('lineUnitSellRupees')} name={QFIELD.lineUnitSellRupees} label={r.unitKind === 'line_total' ? 'Price for the line ₹' : `Price ${r.unitKind ? UNIT_KIND_LABEL[r.unitKind].toLowerCase() : 'per unit'} ₹`} hint="Whole rupees." value={r.sell} onChange={(val) => update(i, { sell: val })} error={e(`lineUnitSellRupees[${i}]`)} />
            <p className="m-0 self-end text-sm text-quiet sm:col-span-2 lg:col-span-3" aria-live="polite">
              {amount ? `Line: ${amount}` : 'Line amount shows when the unit, counts and price are filled.'}
            </p>
            {/* money-privacy C1: a separate internal zone with its own heading, lock icon and words (never tint alone). */}
            <div role="group" aria-labelledby={id('internal')} className="grid gap-4 rounded-control border border-dashed border-line-strong bg-canvas px-3 py-3 sm:col-span-2 sm:grid-cols-2 lg:col-span-3">
              <p id={id('internal')} className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ink sm:col-span-2">
                <Lock aria-hidden="true" className="size-3.5 text-quiet" />
                Internal — never printed, not on the customer copy
              </p>
              <MoneyField id={id('lineUnitCostRupees')} name={QFIELD.lineUnitCostRupees} label="Our cost ₹ (internal)" hint="Same unit as the price. Can be empty." optional value={r.cost} onChange={(val) => update(i, { cost: val })} error={e(`lineUnitCostRupees[${i}]`)} />
              <TextField id={id('lineRemark')} name={QFIELD.lineRemark} label="Remark (internal)" optional maxLength={LINE_LIMITS.remark} value={r.remark} onChange={(val) => update(i, { remark: val })} error={e(`lineRemark[${i}]`)} />
            </div>
          </Fieldset>
        );
      })}
      {rows.length < LINE_LIMITS.lines ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setRows((x) => [...x, EMPTY_LINE])}>
            <Plus aria-hidden="true" /> Add line {rows.length + 1}
          </Button>
        </div>
      ) : null}
      {ownSave ? <SaveRow label="Save price lines" dirty={f.dirty} editable /> : null}
    </HandForm>
  );
}

function TierTotalForm({ version: v, actions, reloadHref, tier, order, ownSave = true }: EditorProps & { tier: QuoteTierMoney; order: number; ownSave?: boolean }) {
  const initial = { total: tier.quotedTotalPaise ? paiseToRupeesText(tier.quotedTotalPaise) : '', showPerPerson: tier.showPerPerson };
  const f = useSectionForm({ id: `quote-total-${tier.tierKey}`, section: 'money', label: `${TIER_LABEL[tier.tierKey]} total`, order, action: asSyncAction(actions.saveTierTotal), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult, values: x, set } = f;
  const id = `q-total-${tier.tierKey}`;
  const refs: QuoteFieldRef[] = [{ field: QFIELD.quotedTotalRupees, id, label: `${TIER_LABEL[tier.tierKey]}: final total in whole rupees, more than zero` }];
  const warning = mismatchText(tier);
  const typed = parseWholeRupees(x.total);
  const near = tier.quotedTotalPaise && !tier.perPersonPaise && tier.payingTravellers > 0 ? nearestExactTotals(tier.quotedTotalPaise, tier.payingTravellers) : null;
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={`${TIER_LABEL[tier.tierKey]} total`} onSubmit={ownSave ? undefined : preventImplicitSave} className="flex flex-col gap-3 rounded-card border border-line bg-canvas px-4 py-4">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name={QFIELD.tierKey} value={tier.tierKey} />
      <h3 className="m-0 text-base font-semibold text-ink">
        {TIER_LABEL[tier.tierKey]}
        {tier.label ? <span className="font-normal text-quiet"> · {tier.label}</span> : null}
      </h3>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-quiet">Lines add up to (for comparison)</dt>
        <dd className="m-0 tabular-nums">{inr0(tier.componentSellPaise)}</dd>
      </dl>
      <InternalZone id={`${id}-internal`}>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-quiet">Our cost (internal)</dt>
          <dd className="m-0 tabular-nums">{tier.costComplete && tier.costTotalPaise ? inr0(tier.costTotalPaise) : 'Some costs not entered'}</dd>
          {tier.marginPaise ? (
            <>
              <dt className="text-quiet">Estimated margin (internal)</dt>
              <dd className="m-0 tabular-nums">
                {formatInr(tier.marginPaise.startsWith('-') ? tier.marginPaise.slice(1) : tier.marginPaise)}
                {tier.marginPaise.startsWith('-') ? ' below cost' : ''}
              </dd>
            </>
          ) : null}
        </dl>
      </InternalZone>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-end">
        <MoneyField id={id} name={QFIELD.quotedTotalRupees} label="Final quoted total ₹" hint="What the customer pays for this option." value={x.total} onChange={(val) => set('total', val)} error={err(f.state, refs, QFIELD.quotedTotalRupees)} />
        <CheckField id={`${id}-pp`} name={QFIELD.showPerPerson} label="Print the per-person price when it is exact" checked={x.showPerPerson} onChange={(val) => set('showPerPerson', val)} />
      </div>
      {typed && x.total !== initial.total ? <p className="m-0 text-sm text-quiet">Not saved yet: {inr0(typed)}.</p> : null}
      <p className="m-0 text-sm text-copy">Prints “GST as applicable”. No GST amount.</p>
      {warning ? (
        <p className="m-0 flex gap-2 text-sm text-copy" role="note">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <span>
            <span className="sr-only">Check: </span>
            {warning}
          </span>
        </p>
      ) : null}
      {tier.perPersonPaise && tier.showPerPerson ? <p className="m-0 text-sm text-quiet">Printed as: {inr0(tier.perPersonPaise)} per person ({tier.payingTravellers} paying travellers).</p> : null}
      {near && tier.quotedTotalPaise ? (
        <p className="m-0 text-sm text-quiet">
          {QUOTATION_TEXT.perPersonNotExact
            .replace('{total}', inr0(tier.quotedTotalPaise))
            .replace('{count}', String(tier.payingTravellers))
            .replace('{below}', inr0(near.below))
            .replace('{above}', inr0(near.above))}
        </p>
      ) : null}
      {ownSave ? <SaveRow label={`Save ${TIER_LABEL[tier.tierKey].toLowerCase()} total`} dirty={f.dirty} editable /> : null}
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Payment schedule (optional; per option; must equal the total)
// ---------------------------------------------------------------------------

function PlanSection(p: EditorProps) {
  const v = p.version;
  return (
    <SectionCard section="plan" description="Optional. Must add up to the option total.">
      {v.money && v.canEditMoney ? v.money.tiers.map((t, i) => <PlanForm key={t.tierKey} {...p} tier={t} order={70 + i} />) : <Notice tone="locked">{QUOTE_TEXT.pricesForEditors}</Notice>}
    </SectionCard>
  );
}

interface PlanRowValues {
  label: string;
  amount: string;
  dueRule: string;
  dueDays: string;
  dueDate: string;
}

function PlanForm({ version: v, actions, reloadHref, tier, order, today }: EditorProps & { tier: QuoteTierMoney; order: number }) {
  const plan = (v.money?.plan ?? []).filter((x) => x.tierKey === tier.tierKey).sort((a, b) => a.seq - b.seq);
  const initial = { rows: plan.map<PlanRowValues>((x) => ({ label: x.label, amount: paiseToRupeesText(x.amountPaise), dueRule: x.dueRule, dueDays: x.dueDays ? String(x.dueDays) : '', dueDate: x.dueDate ?? '' })) };
  const f = useSectionForm({ id: `quote-plan-${tier.tierKey}`, section: 'plan', label: `${TIER_LABEL[tier.tierKey]} payment schedule`, order, action: asSyncAction(actions.savePlan), initial, versionBound: true, rowVersion: v.rowVersion });
  const { bindForm, bindResult } = f;
  const rows = f.values.rows;
  const setRows = (fn: (x: PlanRowValues[]) => PlanRowValues[]) => f.setValues((x) => ({ ...x, rows: fn(x.rows) }));
  const update = (i: number, patch: Partial<PlanRowValues>) => setRows((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const names = ['instalmentLabel', 'instalmentAmountRupees', 'instalmentDueRule', 'instalmentDueDays', 'instalmentDueDate'] as const;
  const labels = { instalmentLabel: 'label (1 to 60 characters)', instalmentAmountRupees: 'amount in whole rupees', instalmentDueRule: 'when it is due', instalmentDueDays: 'days before departure (1 to 365)', instalmentDueDate: 'due date' };
  const refs: QuoteFieldRef[] = rows.flatMap((_, i) => names.map((n) => ({ field: `${n}[${i}]`, id: `q-plan-${tier.tierKey}-${i + 1}-${n}`, label: `Payment ${i + 1}: ${labels[n]}` })));
  const e = (n: string) => err(f.state, refs, n);
  const sum = rows.reduce((acc, r) => acc + BigInt(parseWholeRupees(r.amount) ?? '0'), 0n);
  const total = tier.quotedTotalPaise ? BigInt(tier.quotedTotalPaise) : null;
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label={`${TIER_LABEL[tier.tierKey]} payment schedule`} className="flex flex-col gap-3">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={QUOTATION_TEXT.saved} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name={QFIELD.tierKey} value={tier.tierKey} />
      <h3 className="m-0 text-base font-semibold text-ink">{TIER_LABEL[tier.tierKey]}</h3>
      {rows.length === 0 ? <p className="m-0 text-copy">No payment plan. Sales can add it on the booking.</p> : null}
      {rows.map((r, i) => {
        const id = (n: string) => `q-plan-${tier.tierKey}-${i + 1}-${n}`;
        return (
          <Fieldset
            key={i}
            legend={`Payment ${i + 1}`}
            columns={3}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden="true" /> Remove payment {i + 1}
              </Button>
            }
          >
            <TextField id={id('instalmentLabel')} name={QFIELD.instalmentLabel} label="Label" hint="For example: Advance." maxLength={QUOTATION_PLAN_LIMITS.label} value={r.label} onChange={(val) => update(i, { label: val })} error={e(`instalmentLabel[${i}]`)} />
            <MoneyField id={id('instalmentAmountRupees')} name={QFIELD.instalmentAmountRupees} label="Amount ₹" value={r.amount} onChange={(val) => update(i, { amount: val })} error={e(`instalmentAmountRupees[${i}]`)} />
            <SelectField id={id('instalmentDueRule')} name={QFIELD.instalmentDueRule} label="Due" value={r.dueRule} onChange={(val) => update(i, { dueRule: val })} error={e(`instalmentDueRule[${i}]`)} options={[{ value: '', label: 'Choose' }, ...DUE_RULES.map((d) => ({ value: d, label: DUE_RULE_LABEL[d] }))]} />
            {r.dueRule === 'days_before_start' ? <TextField id={id('instalmentDueDays')} name={QFIELD.instalmentDueDays} label="Days before departure" type="number" min={1} max={365} value={r.dueDays} onChange={(val) => update(i, { dueDays: val })} error={e(`instalmentDueDays[${i}]`)} /> : <input type="hidden" name={QFIELD.instalmentDueDays} value="" />}
            {r.dueRule === 'fixed_date' ? <TextField id={id('instalmentDueDate')} name={QFIELD.instalmentDueDate} label="Due date" type="date" min={today} value={r.dueDate} onChange={(val) => update(i, { dueDate: val })} error={e(`instalmentDueDate[${i}]`)} /> : <input type="hidden" name={QFIELD.instalmentDueDate} value="" />}
          </Fieldset>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        {rows.length < QUOTATION_PLAN_LIMITS.instalments ? (
          <Button variant="secondary" size="sm" onClick={() => setRows((x) => [...x, { label: '', amount: '', dueRule: x.length === 0 ? 'on_acceptance' : 'days_before_start', dueDays: '', dueDate: '' }])}>
            <Plus aria-hidden="true" /> Add payment {rows.length + 1}
          </Button>
        ) : null}
        {rows.length > 0 ? (
          <span className="text-sm text-quiet" aria-live="polite">
            Adds up to {inr0(sum)}
            {total !== null ? (sum === total ? ' · equals the quoted total' : ` · the quoted total is ${inr0(total)}`) : ' · type the quoted total first'}
          </span>
        ) : null}
      </div>
      <SaveRow label={`Save ${TIER_LABEL[tier.tierKey].toLowerCase()} payment schedule`} dirty={f.dirty} editable />
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Discard the draft (secondary action)
// ---------------------------------------------------------------------------

export function DiscardDraftForm({ version: v, action, backHref }: { version: QuoteVersionView; action: QuoteActions['discard']; backHref: string }) {
  const f = useSectionForm({ id: 'quote-discard', section: 'details', label: 'Discard', order: 99, action: asSyncAction(action), initial: {}, versionBound: true, rowVersion: v.rowVersion, saveable: false, tracksDirty: false, onSuccess: () => window.location.assign(backHref) });
  const { bindForm, bindResult } = f;
  const [confirming, setConfirming] = useState(false);
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate className="flex flex-col gap-2">
      <div ref={bindResult}>
        <QuoteResultBox result={f.state} successText={QUOTATION_TEXT.discarded} />
      </div>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <BaseRowVersion base={f.base} />
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-copy">Discard version {v.versionNo}? Earlier versions stay in history.</span>
          <PendingButton pendingLabel="Discarding…" variant="danger">
            Yes, discard this draft
          </PendingButton>
          <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(true)} disabled={!v.canDiscard}>
            <Trash2 aria-hidden="true" /> Discard this draft
          </Button>
        </div>
      )}
    </HandForm>
  );
}

/** Internal cost estimates after sending (Mercury: refresh allowed until converted; never printed). */
export function CostEstimatesForm({ version: v, action }: { version: QuoteVersionView; action: QuoteActions['saveCostEstimates'] }) {
  const lines = v.money?.lines ?? [];
  const [costs, setCosts] = useState(() => lines.map((l) => (l.unitCostPaise === null ? '' : paiseToRupeesText(l.unitCostPaise))));
  const f = useSectionForm({ id: 'quote-costs', section: 'money', label: 'Cost estimates', order: 80, action: asSyncAction(action), initial: {}, versionBound: false, rowVersion: 0, saveable: false, tracksDirty: false });
  const { bindForm, bindResult } = f;
  if (lines.length === 0) return null;
  const refs: QuoteFieldRef[] = lines.map((l, i) => ({ field: `lineUnitCostRupees[${i}]`, id: `q-cost-${l.lineNo}`, label: `Line ${l.lineNo}: rupees with up to 2 decimals` }));
  return (
    <Card>
      <section aria-labelledby="quote-costs-heading">
        <CardHeader>
          <CardTitle id="quote-costs-heading">Our cost estimates (internal)</CardTitle>
          <CardDescription className="basis-full">Update our costs (internal). The customer’s quotation does not change.</CardDescription>
        </CardHeader>
        <CardBody>
          <HandForm ref={bindForm} action={f.formAction} noValidate aria-label="Our cost estimates" className="flex flex-col gap-3">
            <div ref={bindResult}>
              <QuoteResultBox result={f.state} fields={refs} successText="Cost estimates saved. The quotation did not change." />
            </div>
            <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
            <div className="grid gap-3 sm:grid-cols-2">
              {lines.map((l, i) => (
                <MoneyField
                  key={l.lineNo}
                  id={`q-cost-${l.lineNo}`}
                  name={QFIELD.lineUnitCostRupees}
                  label={`Line ${l.lineNo}: ${l.description}`}
                  hint={`${UNIT_KIND_LABEL[l.unitKind]} · price ${inr0(l.unitSellPaise)}`}
                  optional
                  value={costs[i] ?? ''}
                  onChange={(val) => setCosts((x) => x.map((c, j) => (j === i ? val : c)))}
                  error={quoteProblem(f.state, `lineUnitCostRupees[${i}]`, 'Rupees with up to 2 decimals, or empty.')}
                />
              ))}
            </div>
            <div>
              <PendingButton pendingLabel="Saving…" variant="secondary">
                Save cost estimates
              </PendingButton>
            </div>
          </HandForm>
        </CardBody>
      </section>
    </Card>
  );
}
