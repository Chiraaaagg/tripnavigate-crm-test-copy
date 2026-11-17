'use client';

import { Plus, Trash2 } from 'lucide-react';
import { BOOKING_FOR_PREFILL } from './prefill-panel';
import { PREFILL_INLINE_TEXT, usePrefillField, usePrefillInlineMode } from './prefill-inline';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Fieldset } from '@/components/ui/fieldset';
import { Notice } from '@/components/ui/notice';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { BOOK_NOW_TEXT, BOOK_SECTION_LABEL, ID_PROOF_TEXT, TRAVELLER_TYPES, type TravellerType } from '@/modules/fulfilment/contracts';
import { TRAVELLER_SEQ_FIELD, TRAVELLER_SEQ_MAX_FIELD } from '@/modules/fulfilment/b11-forms';
import { GST_STATES, dateText, inr, maskPassport, paiseToRupeesText, rupeesTextToPaise, travellerNeedsIdentity, travellerSeqHighWater, idProofsDetachedByRename } from './book-fields';
import { TravellerIdProofSlot } from './id-proof-slot';
import { CheckField, MoneyField, SelectField, TextField, problemFor } from './controls';
import { BaseRowVersion, useSectionForm } from './draft-sync';
import { type FieldRef, newRequestId, refusedFields, PendingButton, ResultBox, type UiResult } from './form-kit';
import type { B11Action, BookNowView } from './shapes';

/*
 * The sections of the three-step Book now form (B1.2 freeze note §2.1) that
 * are plain forms: step 1 customer and passengers, step 2 destinations and
 * dates, step 3 passport and ID details, selling price and payment plan.
 * Each section is its own form posting only its own fields to its existing
 * action, with its own Save button and its own base row version (DraftSync);
 * "Save and continue" on steps 1 and 2 saves the changed sections in order.
 * Element ids carry the section key as a prefix so two "City" fields on one
 * page never share an id.
 */

export interface SectionProps {
  view: BookNowView;
  reloadHref: string;
  initialState?: UiResult | null;
  /** Revision drafts: "Was: …" under changed fields. */
  previous?: Record<string, string>;
}

function Was({ previous, field }: { previous?: Record<string, string>; field: string }) {
  const old = previous?.[field];
  if (old === undefined) return null;
  return (
    <span className="mt-0.5 block text-sm text-quiet">
      Was: <span className="font-medium text-copy">{old === '' ? 'empty' : old}</span>
    </span>
  );
}

function Hidden({ view, extra, base }: { view: BookNowView; extra?: Record<string, string | number | null | undefined>; base: number }) {
  const [requestId] = useState(() => newRequestId());
  return (
    <>
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
      <BaseRowVersion base={base} />
      <input type="hidden" name="requestId" value={requestId} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v ?? ''} />
      ))}
    </>
  );
}

export const editableOf = (view: BookNowView) => view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;
/** Selling price and plan: commercial editors only (booking_form_get.canEditCommercials). */
const commercialEditable = (view: BookNowView) => editableOf(view) && view.canEditCommercials;

const fieldText = (refs: FieldRef[], name: string) => refs.find((r) => r.field === name)?.label ?? 'Check this field.';

/** The Save button and the section's unsaved line. */
function SectionSave({ label, dirty, editable, children }: { label: string; dirty: boolean; editable: boolean; children?: ReactNode }) {
  if (!editable) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PendingButton pendingLabel="Saving…" variant="secondary">
        {label}
      </PendingButton>
      {children}
      <span className="text-sm text-quiet" aria-live="polite">
        {dirty ? 'Not saved yet' : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 · customer and billing
// ---------------------------------------------------------------------------

const CUSTOMER_FIELDS: FieldRef[] = [
  { field: 'contactName', id: 'customer-contact-name', label: 'Booking contact name' },
  { field: 'mobile', id: 'customer-mobile', label: 'Mobile number: 10 digits starting with 6 to 9' },
  { field: 'email', id: 'customer-email', label: 'Email' },
  { field: 'contactConfirmed', id: 'customer-contact-confirmed', label: 'Confirm you reached the customer' },
  { field: 'bookingFor', id: 'customer-booking-for', label: 'Booking for' },
  { field: 'payerName', id: 'customer-payer-name', label: 'Payer name' },
  { field: 'billingName', id: 'customer-billing-name', label: 'Billing name' },
  { field: 'addressLine1', id: 'customer-address-1', label: 'Address line 1' },
  { field: 'addressLine2', id: 'customer-address-2', label: 'Address line 2' },
  { field: 'billingCity', id: 'customer-billing-city', label: 'City' },
  { field: 'stateCode', id: 'customer-state', label: 'State' },
  { field: 'postalCode', id: 'customer-pin', label: 'PIN code: 6 digits' },
  { field: 'gstin', id: 'customer-gstin', label: 'GSTIN (its first two digits are the state code)' },
];

export function CustomerSection({ view, reloadHref, initialState, previous, saveAction }: SectionProps & { saveAction: B11Action }) {
  const c = view.contacts;
  const b = view.billing;
  const billingLocked = b.status === 'verified';
  const initial = {
    contactName: c?.contactName ?? '',
    mobile: c?.mobile ?? '',
    email: c?.email ?? '',
    contactConfirmed: c?.contactConfirmed ?? false,
    bookingFor: c?.bookingFor ?? 'individual',
    payerDifferent: c?.payerDifferent ?? false,
    payerName: c?.payerName ?? '',
    billingName: b.billingName ?? '',
    addressLine1: b.addressLine1 ?? '',
    addressLine2: b.addressLine2 ?? '',
    billingCity: b.city ?? '',
    stateCode: b.stateCode ?? '',
    postalCode: b.postalCode ?? '',
    gstin: b.gstin ?? '',
  };
  const f = useSectionForm({ id: 'customer', section: 'customer', label: BOOK_SECTION_LABEL.customer, order: 10, action: saveAction, initial, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, initialState });
  const { bindForm, bindResult } = f;
  const v = f.values;
  const set = f.set;
  const fields = refusedFields(f.state);
  const err = (name: string) => problemFor(fields, name, fieldText(CUSTOMER_FIELDS, name));
  const editable = editableOf(view);
  const pfName = usePrefillField('customer-contact-name', 'contacts.contactName');
  const pfMobile = usePrefillField('customer-mobile', 'contacts.mobile', '10 digits. A mobile number or an email is needed.');
  const pfEmail = usePrefillField('customer-email', 'contacts.email');
  const pfFor = usePrefillField('customer-booking-for', BOOKING_FOR_PREFILL);
  const inline = usePrefillInlineMode();
  // DA-168 (BC-A8b): the tick also checks a Bitrix mobile or email; name and "Booking for" keep the section check.
  const contactNumberFromBitrix = inline && [pfMobile, pfEmail].some((x) => x.aside);
  const contactFromBitrix = inline && [pfName, pfMobile, pfEmail, pfFor].some((x) => x.aside);
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-labelledby="customer-heading" className="flex flex-col gap-5">
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={CUSTOMER_FIELDS} reloadHref={reloadHref} successText="Customer and billing saved. Nothing has been booked or paid." />
      </div>
      <Hidden view={view} base={f.base} extra={{ billingRowVersion: b.rowVersion ?? 0 }} />
      <p className="m-0 text-quiet">Enter what the customer gave you. Accounts later accepts the billing details unchanged, or edits them, and verifies them. There is one billing record, not a second copy.</p>
      <Fieldset legend="Booking contact" columns={2}>
        <TextField id="customer-contact-name" name="contactName" label="Booking contact name" {...pfName} value={v.contactName} onChange={(x) => set('contactName', x)} error={err('contactName')} maxLength={120} autoComplete="name" disabled={!editable} />
        <div />
        <TextField id="customer-mobile" name="mobile" label="Mobile number" type="tel" inputMode="tel" {...pfMobile} value={v.mobile} onChange={(x) => set('mobile', x)} error={err('mobile')} optional maxLength={10} autoComplete="tel-national" disabled={!editable} />
        <TextField id="customer-email" name="email" label="Email" type="email" inputMode="email" {...pfEmail} value={v.email} onChange={(x) => set('email', x)} error={err('email')} optional maxLength={254} autoComplete="email" disabled={!editable} />
        <CheckField
          id="customer-contact-confirmed"
          name="contactConfirmed"
          className="sm:col-span-2"
          label="I confirmed this mobile number or email with the customer (a call or a WhatsApp reply)"
          description={
            c?.contactConfirmed && c.confirmedByName
              ? `Confirmed by ${c.confirmedByName}${c.confirmedAt ? ` on ${dateText(c.confirmedAt)}` : ''}. Changing the number or email asks again.`
              : contactNumberFromBitrix && !v.contactConfirmed
                ? PREFILL_INLINE_TEXT.contactTickChecks
                : contactFromBitrix && !v.contactConfirmed
                  ? PREFILL_INLINE_TEXT.contactCheck
                  : undefined
          }
          checked={v.contactConfirmed}
          onChange={(x) => set('contactConfirmed', x)}
          error={err('contactConfirmed')}
          disabled={!editable}
        />
        <Was previous={previous} field="contacts.contactName" />
      </Fieldset>

      <Fieldset legend="Billing" columns={2}>
        <SelectField
          id="customer-booking-for"
          name="bookingFor"
          label="Booking for"
          {...pfFor}
          value={v.bookingFor}
          onChange={(x) => set('bookingFor', x as 'individual' | 'business')}
          options={[
            { value: 'individual', label: 'An individual' },
            { value: 'business', label: 'A business (GST)' },
          ]}
          error={err('bookingFor')}
          disabled={!editable}
        />
        <div className="sm:col-span-1" />
        {billingLocked ? (
          <div className="sm:col-span-2">
            <Notice tone="locked" title="Accounts verified these billing details">
              <p>They can’t be changed here. Ask Accounts to change them.</p>
            </Notice>
            <SummaryList className="mt-3">
              <SummaryRow label="Billing name">{b.billingName}</SummaryRow>
              <SummaryRow label="Address">{[b.addressLine1, b.addressLine2, b.city, b.postalCode].filter(Boolean).join(', ')}</SummaryRow>
              <SummaryRow label="State">{GST_STATES.find((s) => s.code === b.stateCode)?.name ?? b.stateCode}</SummaryRow>
              {b.gstin ? <SummaryRow label="GSTIN">{b.gstin}</SummaryRow> : null}
            </SummaryList>
          </div>
        ) : (
          <>
            <TextField id="customer-billing-name" name="billingName" label="Billing name" value={v.billingName} onChange={(x) => set('billingName', x)} error={err('billingName')} maxLength={200} disabled={!editable} />
            <TextField id="customer-address-1" name="addressLine1" label="Address line 1" value={v.addressLine1} onChange={(x) => set('addressLine1', x)} error={err('addressLine1')} maxLength={200} autoComplete="address-line1" disabled={!editable} />
            <TextField id="customer-address-2" name="addressLine2" label="Address line 2" value={v.addressLine2} onChange={(x) => set('addressLine2', x)} error={err('addressLine2')} optional maxLength={200} autoComplete="address-line2" disabled={!editable} />
            <TextField id="customer-billing-city" name="billingCity" label="City" value={v.billingCity} onChange={(x) => set('billingCity', x)} error={err('billingCity')} maxLength={120} disabled={!editable} />
            <SelectField
              id="customer-state"
              name="stateCode"
              label="State"
              value={v.stateCode}
              onChange={(x) => set('stateCode', x)}
              options={[{ value: '', label: 'Choose the state' }, ...GST_STATES.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))]}
              error={err('stateCode')}
              disabled={!editable}
            />
            <TextField id="customer-pin" name="postalCode" label="PIN code" inputMode="numeric" value={v.postalCode} onChange={(x) => set('postalCode', x)} error={err('postalCode')} maxLength={6} autoComplete="postal-code" disabled={!editable} />
            {v.bookingFor === 'business' ? (
              <TextField id="customer-gstin" name="gstin" label="GSTIN" hint="Accounts checks it. No tax is calculated here." value={v.gstin} onChange={(x) => set('gstin', x.toUpperCase())} error={err('gstin')} maxLength={15} disabled={!editable} />
            ) : null}
          </>
        )}
        <CheckField
          id="customer-payer-different"
          name="payerDifferent"
          className="sm:col-span-2"
          label="Someone else pays (a company or a relative)"
          checked={v.payerDifferent}
          onChange={(x) => set('payerDifferent', x)}
          disabled={!editable}
        />
        {v.payerDifferent ? (
          <TextField id="customer-payer-name" name="payerName" label="Payer name" value={v.payerName} onChange={(x) => set('payerName', x)} error={err('payerName')} maxLength={200} disabled={!editable} />
        ) : null}
      </Fieldset>
      <SummaryList>
        <SummaryRow label="Company and branch">Holiday Chacha Pvt LTD and the Deal’s branch (from the Deal; not editable)</SummaryRow>
      </SummaryList>
      <SectionSave label="Save customer details" dirty={f.dirty} editable={editable} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 1 · passengers (each traveller with its own identity-proof slot)
// ---------------------------------------------------------------------------

interface TravellerRow {
  /** Saved traveller number, or null for a row typed here and not saved yet. */
  seq: number | null;
  name: string;
  type: TravellerType;
  age: string;
  needs: string;
}

const TRAVELLER_TYPE_TEXT: Record<TravellerType, string> = {
  adult: 'Adult',
  child: 'Child',
  infant: 'Infant',
};

export function PassengersSection({
  view,
  reloadHref,
  initialState,
  previous,
  saveAction,
  idProofActions,
}: SectionProps & { saveAction: B11Action; idProofActions?: { upload: B11Action; remove: B11Action; retryCopy?: B11Action } }) {
  const initial = {
    travellers: (view.travellers.length > 0
      ? [...view.travellers].sort((a, b) => a.seq - b.seq).map((t) => ({ seq: t.seq, name: t.fullName, type: t.type, age: t.ageYears === null ? '' : String(t.ageYears), needs: t.specialNeeds ?? '' }))
      : [{ seq: null, name: '', type: 'adult' as TravellerType, age: '', needs: '' }]) as TravellerRow[],
  };
  // A saved rename detaches that traveller's ID proof (Echo D3-3): compare the travellers before and after the save.
  const [renameBase, setRenameBase] = useState<Pick<BookNowView, 'travellers'> | null>(null);
  const [detached, setDetached] = useState<Array<{ seq: number; fullName: string }>>([]);
  if (renameBase && renameBase.travellers !== view.travellers) {
    setDetached(idProofsDetachedByRename(renameBase, view));
    setRenameBase(null);
  }
  const f = useSectionForm({
    id: 'passengers',
    section: 'passengers',
    label: BOOK_SECTION_LABEL.passengers,
    order: 20,
    action: saveAction,
    initial,
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    initialState,
    onSuccess: () => {
      setDetached([]);
      setRenameBase({ travellers: view.travellers });
    },
  });
  const { bindForm, bindResult } = f;
  const v = f.values;
  const fields = refusedFields(f.state);
  const editable = editableOf(view);
  const refs: FieldRef[] = v.travellers.flatMap((_, i) => [
    { field: `travellerName[${i}]`, id: `passengers-${i + 1}-name`, label: `Traveller ${i + 1}: full name as on the ID` },
    { field: `travellerAge[${i}]`, id: `passengers-${i + 1}-age`, label: `Traveller ${i + 1}: age 0 to 17` },
    { field: `travellerNeeds[${i}]`, id: `passengers-${i + 1}-needs`, label: `Traveller ${i + 1}: special requirements (up to 500 characters)` },
  ]);
  const err = (name: string) => problemFor(fields, name, fieldText(refs, name));
  const setRow = (i: number, patch: Partial<TravellerRow>) => f.setValues((x) => ({ ...x, travellers: x.travellers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const anyIdentity = view.travellers.some((t) => travellerNeedsIdentity(view, t.seq));
  const saved = new Map(view.travellers.map((t) => [t.seq, t]));
  // The traveller fields live in each row together with that traveller's ID-proof form; they join
  // the passengers form through the form attribute so the two forms never nest.
  const FORM = 'passengers-form';
  return (
    <div className="flex flex-col gap-4">
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText="Passengers saved. Nothing has been booked or paid." />
      </div>
      {detached.length > 0 ? (
        <Notice tone="warning" role="status">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detached.map((d) => (
              <li key={d.seq}>{ID_PROOF_TEXT.detachedOnRename.replace('{name}', d.fullName || `traveller ${d.seq}`)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <p className="m-0 text-quiet">Names exactly as on the ID used for tickets.</p>
      {idProofActions && view.travellers.some((t) => t.idProofs !== undefined) ? <p className="m-0 text-sm text-copy">{ID_PROOF_TEXT.callout}</p> : null}
      {anyIdentity ? <p className="m-0 text-sm text-quiet">{BOOK_NOW_TEXT.identityAskedLater}</p> : null}
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Travellers">
        {v.travellers.map((t, i) => {
          const s = t.seq !== null ? saved.get(t.seq) : undefined;
          const proofs = s?.idProofs;
          const hasProofs = (proofs ?? []).some((p) => p.status === 'stored' || p.status === 'pending_upload');
          return (
            <li key={t.seq ?? `new-${i}`} className="m-0">
              <Fieldset
                legend={`Traveller ${i + 1}${t.name ? ` · ${t.name}` : ''}`}
                columns={2}
                actions={
                  editable && v.travellers.length > 1 ? (
                    <Button variant="ghost" size="sm" onClick={() => f.setValues((x) => ({ ...x, travellers: x.travellers.filter((_, j) => j !== i) }))}>
                      <Trash2 aria-hidden="true" /> Remove traveller {i + 1}
                    </Button>
                  ) : null
                }
              >
                <input type="hidden" name={TRAVELLER_SEQ_FIELD} value={t.seq ?? ''} form={FORM} />
                <TextField
                  id={`passengers-${i + 1}-name`}
                  name="travellerName"
                  label="Full name"
                  hint={hasProofs ? 'Changing the name removes this traveller’s attached ID proof; attach it again after saving.' : undefined}
                  value={t.name}
                  onChange={(x) => setRow(i, { name: x })}
                  error={err(`travellerName[${i}]`)}
                  maxLength={120}
                  disabled={!editable}
                  form={FORM}
                />
                <SelectField
                  id={`passengers-${i + 1}-type`}
                  name="travellerType"
                  label="Type"
                  value={t.type}
                  onChange={(x) => setRow(i, { type: x as TravellerType, age: x === 'adult' ? '' : t.age })}
                  options={TRAVELLER_TYPES.map((k) => ({ value: k, label: TRAVELLER_TYPE_TEXT[k] }))}
                  disabled={!editable}
                  form={FORM}
                />
                {t.type !== 'adult' ? (
                  <TextField id={`passengers-${i + 1}-age`} name="travellerAge" label="Age in years" type="number" min={0} max={17} value={t.age} onChange={(x) => setRow(i, { age: x })} error={err(`travellerAge[${i}]`)} disabled={!editable} form={FORM} />
                ) : (
                  <input type="hidden" name="travellerAge" value="" form={FORM} />
                )}
                <TextField
                  id={`passengers-${i + 1}-needs`}
                  name="travellerNeeds"
                  label="Special requirements"
                  hint="Wheelchair, diet, medical — only what the trip needs."
                  optional
                  value={t.needs}
                  onChange={(x) => setRow(i, { needs: x })}
                  error={err(`travellerNeeds[${i}]`)}
                  maxLength={500}
                  disabled={!editable}
                  form={FORM}
                />
                {idProofActions && (proofs !== undefined || !s) && view.idProofLimits ? (
                  <div className="sm:col-span-2">
                    <TravellerIdProofSlot
                      dealId={view.dealId}
                      seq={s ? s.seq : null}
                      rowNo={i + 1}
                      name={t.name}
                      savedName={s?.fullName ?? null}
                      type={t.type}
                      proofs={proofs ?? []}
                      limits={view.idProofLimits}
                      canEdit={view.idProofCanEdit}
                      canRemove={view.idProofCanRemove}
                      uploadAction={idProofActions.upload}
                      removeAction={idProofActions.remove}
                      retryCopyAction={idProofActions.retryCopy}
                    />
                  </div>
                ) : null}
              </Fieldset>
            </li>
          );
        })}
      </ol>
      {editable && v.travellers.length < 100 ? (
        <div>
          <Button variant="secondary" onClick={() => f.setValues((x) => ({ ...x, travellers: [...x.travellers, { seq: null, name: '', type: 'adult', age: '', needs: '' }] }))}>
            <Plus aria-hidden="true" /> Add traveller
          </Button>
        </div>
      ) : null}
      <Was previous={previous} field="travellers" />
      <form id={FORM} ref={bindForm} action={f.formAction} noValidate aria-labelledby="passengers-heading" className="flex flex-col gap-3">
        <Hidden view={view} base={f.base} extra={{ [TRAVELLER_SEQ_MAX_FIELD]: travellerSeqHighWater(view) }} />
        <SectionSave label="Save passengers" dirty={f.dirty} editable={editable} />
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 · destinations and dates (booking_trip_save: all four keys together)
// ---------------------------------------------------------------------------

export function TripSection({ view, reloadHref, initialState, previous, saveAction }: SectionProps & { saveAction: B11Action }) {
  const initial = {
    destination: view.trip.destination ?? '',
    scope: view.trip.scope ?? 'domestic',
    start: view.trip.start ?? '',
    end: view.trip.end ?? '',
  };
  const f = useSectionForm({ id: 'trip', section: 'trip', label: BOOK_SECTION_LABEL.trip, order: 30, action: saveAction, initial, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, initialState });
  const { bindForm, bindResult } = f;
  const v = f.values;
  const fields = refusedFields(f.state);
  const editable = editableOf(view);
  const refs: FieldRef[] = [
    { field: 'destination', id: 'trip-destination', label: 'Destination' },
    { field: 'tripScope', id: 'trip-scope', label: 'Domestic or international' },
    { field: 'tripStart', id: 'trip-start', label: 'Trip start date' },
    { field: 'tripEnd', id: 'trip-end', label: 'Trip end date: on or after the start' },
  ];
  const err = (name: string) => problemFor(fields, name, fieldText(refs, name));
  const pfStart = usePrefillField('trip-start', 'trip.start');
  const pfEnd = usePrefillField('trip-end', 'trip.end');
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-labelledby="trip-heading" className="flex flex-col gap-4">
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText="Destinations and dates saved. Nothing has been booked or paid." />
      </div>
      <Hidden view={view} base={f.base} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="trip-destination" name="destination" label="Destination(s)" value={v.destination} onChange={(x) => f.set('destination', x)} error={err('destination')} maxLength={200} disabled={!editable} />
        <SelectField
          id="trip-scope"
          name="tripScope"
          label="Domestic or international"
          value={v.scope}
          onChange={(x) => f.set('scope', x as 'domestic' | 'international')}
          options={[
            { value: 'domestic', label: 'Domestic (within India)' },
            { value: 'international', label: 'International' },
          ]}
          error={err('tripScope')}
          disabled={!editable}
        />
        <TextField id="trip-start" name="tripStart" label="Trip start" type="date" {...pfStart} value={v.start} onChange={(x) => f.set('start', x)} error={err('tripStart')} disabled={!editable} />
        <TextField id="trip-end" name="tripEnd" label="Trip end" type="date" {...pfEnd} value={v.end} onChange={(x) => f.set('end', x)} error={err('tripEnd')} disabled={!editable} />
        <Was previous={previous} field="trip.start" />
      </div>
      <SectionSave label="Save destinations and dates" dirty={f.dirty} editable={editable} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 · passport and ID details (restricted; own identity row version)
// ---------------------------------------------------------------------------

export function IdentitySection({ view, reloadHref, identityAction }: { view: BookNowView; reloadHref: string; identityAction: B11Action }) {
  const needing = view.travellers.filter((t) => travellerNeedsIdentity(view, t.seq)).sort((a, b) => a.seq - b.seq);
  if (needing.length === 0) {
    return <p className="m-0 text-quiet">No date of birth, passport or ID details are asked for this booking: no traveller is on an international flight, a visa or a passport service. (Save the services first if that changes.)</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="restricted" title="Private identity details">
        <p>
          Asked only for travellers on an international flight, a visa or a passport service. Only the Deal owner, the branch Manager and the assigned Flight or Visa &amp; Passport colleague see them. Passport numbers can be added later, before ticketing or filing. Purchase never sees these.
        </p>
      </Notice>
      {needing.map((t, index) => (
        <IdentityForm key={t.seq} view={view} seq={t.seq} order={60 + index / 100} reloadHref={reloadHref} action={identityAction} />
      ))}
    </div>
  );
}

function IdentityForm({ view, seq, order, reloadHref, action }: { view: BookNowView; seq: number; order: number; reloadHref: string; action: B11Action }) {
  const t = view.travellers.find((x) => x.seq === seq)!;
  const initial = {
    dateOfBirth: t.identity?.dateOfBirth ?? '',
    nationality: t.identity?.nationality ?? '',
    passportNumber: t.identity?.passportNumber ?? '',
    passportExpiry: t.identity?.passportExpiry ?? '',
  };
  const who = t.fullName || `Traveller ${seq}`;
  const f = useSectionForm({ id: `identity-${seq}`, section: 'identity', label: `ID details of ${who}`, order, action, initial, versionBound: false, rowVersion: 0 });
  const { bindForm, bindResult } = f;
  const v = f.values;
  const fields = refusedFields(f.state);
  const editable = view.canEdit && !view.dealNotActive;
  const id = (k: string) => `identity-${seq}-${k}`;
  const refs: FieldRef[] = [
    { field: 'dateOfBirth', id: id('dob'), label: 'Date of birth: a past date' },
    { field: 'nationality', id: id('nationality'), label: 'Nationality' },
    { field: 'passportNumber', id: id('passport'), label: 'Passport number: 6 to 15 letters and digits' },
    { field: 'passportExpiry', id: id('expiry'), label: 'Passport expiry date' },
  ];
  const err = (name: string) => problemFor(fields, name, fieldText(refs, name));
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-label={`Passport and ID details for ${who}`}>
      <Fieldset legend={`${who} · passport and ID details`} columns={2}>
        <div className="sm:col-span-2" ref={bindResult}>
          <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText="Passport and ID details saved." />
        </div>
        <input type="hidden" name="dealId" value={view.dealId} />
        <input type="hidden" name="seq" value={seq} />
        <input type="hidden" name="identityRowVersion" value={t.identity?.rowVersion ?? 0} />
        <TextField id={id('dob')} name="dateOfBirth" label="Date of birth" type="date" value={v.dateOfBirth} onChange={(x) => f.set('dateOfBirth', x)} error={err('dateOfBirth')} disabled={!editable} />
        <TextField id={id('nationality')} name="nationality" label="Nationality" value={v.nationality} onChange={(x) => f.set('nationality', x)} error={err('nationality')} maxLength={60} disabled={!editable} />
        <TextField
          id={id('passport')}
          name="passportNumber"
          label="Passport number"
          hint="Later is fine."
          optional
          value={v.passportNumber}
          onChange={(x) => f.set('passportNumber', x.toUpperCase())}
          error={err('passportNumber')}
          maxLength={15}
          disabled={!editable}
        />
        <TextField id={id('expiry')} name="passportExpiry" label="Passport expiry" type="date" optional value={v.passportExpiry} onChange={(x) => f.set('passportExpiry', x)} error={err('passportExpiry')} disabled={!editable} />
        {editable ? (
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <PendingButton pendingLabel="Saving…">Save ID details of {who}</PendingButton>
            <span className="text-sm text-quiet">{f.dirty ? 'Unsaved changes.' : t.identity?.passportNumber ? `Passport on file: ${maskPassport(t.identity.passportNumber)}` : ''}</span>
          </div>
        ) : null}
      </Fieldset>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 · selling price
// ---------------------------------------------------------------------------

export function PriceSection({ view, reloadHref, initialState, previous, saveAction }: SectionProps & { saveAction: B11Action }) {
  const c = view.commercials;
  const initial = { list: paiseToRupeesText(c?.listPricePaise), discount: paiseToRupeesText(c?.discountPaise), total: paiseToRupeesText(c?.sellingTotalPaise) };
  const f = useSectionForm({ id: 'price', section: 'price', label: BOOK_SECTION_LABEL.price, order: 70, action: saveAction, initial, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, initialState });
  const { bindForm, bindResult } = f;
  const v = f.values;
  const fields = refusedFields(f.state);
  const editable = commercialEditable(view);
  const listP = rupeesTextToPaise(v.list);
  const discP = rupeesTextToPaise(v.discount);
  const totalP = rupeesTextToPaise(v.total);
  const expected = v.list.trim() && listP !== null && discP !== null ? listP - discP : null;
  const mismatch = expected !== null && totalP !== null && v.total.trim() !== '' && expected !== totalP;
  const refs: FieldRef[] = [
    { field: 'listRupees', id: 'price-list', label: 'List price: rupees with up to 2 decimals' },
    { field: 'discountRupees', id: 'price-discount', label: 'Discount: needs a list price' },
    { field: 'sellingTotalRupees', id: 'price-total', label: 'Final selling total: more than ₹0, and list price minus discount when a list price is given' },
  ];
  const err = (name: string) => problemFor(fields, name, fieldText(refs, name));
  const budgets = view.items.reduce((sum, i) => sum + (i.purchaseBudgetPaise ? Number(i.purchaseBudgetPaise) : 0), 0);
  if (!c) {
    return (
      <Notice tone="locked" title="The selling price is not shown to you">
        <p>Only someone who can see this deal’s selling price (the deal owner or an assigned salesperson) can enter it. Ask them to fill this section.</p>
      </Notice>
    );
  }
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-labelledby="price-heading" className="flex flex-col gap-4">
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText="Selling price saved. Nothing has been booked or paid." />
      </div>
      <Hidden view={view} base={f.base} />
      {editableOf(view) && !view.canEditCommercials ? <Notice tone="locked">Only someone who can see this deal’s selling price (the deal owner or an assigned salesperson) can enter it. Ask them to fill this section.</Notice> : null}
      <Notice tone="info">
        <p>One selling total for the whole booking (one bill). Purchase, Flight and the Visa &amp; Passport desk never see it. Budgets per service are what departments may spend; they are not prices.</p>
      </Notice>
      <Fieldset legend="Price agreed with the customer" columns={3}>
        <MoneyField id="price-list" name="listRupees" label="List price ₹" optional value={v.list} onChange={(x) => f.set('list', x)} error={err('listRupees')} disabled={!editable} />
        <MoneyField id="price-discount" name="discountRupees" label="Discount ₹" optional value={v.discount} onChange={(x) => f.set('discount', x)} error={err('discountRupees')} disabled={!editable} />
        <MoneyField
          id="price-total"
          name="sellingTotalRupees"
          label="Final selling total ₹"
          hint="What the customer accepted."
          value={v.total}
          onChange={(x) => f.set('total', x)}
          error={err('sellingTotalRupees') ?? (mismatch ? `Final total must equal list price minus discount (${inr(expected)}).` : null)}
          disabled={!editable}
        />
      </Fieldset>
      <Was previous={previous} field="sellingTotal" />
      <SummaryList>
        <SummaryRow label="Purchase and Flight budgets (internal, not a price)" numeric>
          {budgets > 0 ? inr(budgets) : <NotEntered />}
        </SummaryRow>
        <SummaryRow label="Final selling total" numeric total>
          {totalP ? inr(totalP) : <NotEntered />}
        </SummaryRow>
      </SummaryList>
      <SectionSave label="Save selling price" dirty={f.dirty} editable={editable} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 · payment plan
// ---------------------------------------------------------------------------

interface PlanRow {
  label: string;
  amount: string;
  due: string;
}

export function PlanSection({ view, reloadHref, initialState, saveAction }: SectionProps & { saveAction: B11Action }) {
  const loaded: PlanRow[] = (view.plan ?? []).map((p) => ({ label: p.label, amount: paiseToRupeesText(p.amountPaise), due: p.dueDate }));
  const initial = { rows: loaded.length > 0 ? loaded : [{ label: 'Advance', amount: '', due: '' }] };
  const f = useSectionForm({ id: 'payment', section: 'payment', label: BOOK_SECTION_LABEL.payment, order: 80, action: saveAction, initial, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, initialState });
  const { bindForm, bindResult } = f;
  const rows = f.values.rows;
  const setRows = (fn: (x: PlanRow[]) => PlanRow[]) => f.setValues((x) => ({ rows: fn(x.rows) }));
  const fields = refusedFields(f.state);
  const editable = commercialEditable(view);
  const total = view.commercials?.sellingTotalPaise ? Number(view.commercials.sellingTotalPaise) : null;
  const sum = useMemo(() => rows.reduce((s, r) => s + (rupeesTextToPaise(r.amount) ?? 0), 0), [rows]);
  const matches = total !== null && sum === total;
  const refs: FieldRef[] = rows.flatMap((_, i) => [
    { field: `instalmentLabel[${i}]`, id: `payment-${i + 1}-label`, label: `Instalment ${i + 1}: label (up to 60 characters)` },
    { field: `instalmentAmountRupees[${i}]`, id: `payment-${i + 1}-amount`, label: `Instalment ${i + 1}: amount in rupees` },
    { field: `instalmentDueDate[${i}]`, id: `payment-${i + 1}-due`, label: `Instalment ${i + 1}: due date` },
  ]);
  const err = (name: string) => problemFor(fields, name, fieldText(refs, name));
  const setRow = (i: number, patch: Partial<PlanRow>) => setRows((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fill = () => {
    if (!total) return;
    setRows(() => [{ label: 'Full payment', amount: paiseToRupeesText(String(total)), due: view.trip.start ?? '' }]);
  };
  return (
    <form ref={bindForm} action={f.formAction} noValidate aria-label="Payment plan" className="flex flex-col gap-4">
      <p className="m-0 text-quiet">When the customer will pay. Instalments must add up to the final total. No advance is required.</p>
      <div ref={bindResult}>
        <ResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText="Payment plan saved." />
      </div>
      <Hidden view={view} base={f.base} />
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Instalments">
        {rows.map((r, i) => (
          <li key={i} className="m-0">
            <Fieldset
              legend={`Instalment ${i + 1}`}
              columns={3}
              actions={
                editable && rows.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden="true" /> Remove instalment {i + 1}
                  </Button>
                ) : null
              }
            >
              <TextField id={`payment-${i + 1}-label`} name="instalmentLabel" label="Label" value={r.label} onChange={(x) => setRow(i, { label: x })} error={err(`instalmentLabel[${i}]`)} maxLength={60} disabled={!editable} />
              <MoneyField id={`payment-${i + 1}-amount`} name="instalmentAmountRupees" label="Amount ₹" value={r.amount} onChange={(x) => setRow(i, { amount: x })} error={err(`instalmentAmountRupees[${i}]`)} disabled={!editable} />
              <TextField id={`payment-${i + 1}-due`} name="instalmentDueDate" label="Due date" type="date" value={r.due} onChange={(x) => setRow(i, { due: x })} error={err(`instalmentDueDate[${i}]`)} disabled={!editable} />
            </Fieldset>
          </li>
        ))}
      </ol>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {rows.length < 12 ? (
            <Button variant="secondary" onClick={() => setRows((x) => [...x, { label: x.length === 0 ? 'Advance' : 'Balance', amount: '', due: '' }])}>
              <Plus aria-hidden="true" /> Add instalment
            </Button>
          ) : null}
          <Button variant="secondary" onClick={fill} disabled={!total}>
            Use the full total as one instalment
          </Button>
        </div>
      ) : null}
      <SummaryList>
        <SummaryRow label="Plan total" numeric total>
          <span aria-live="polite">
            {inr(sum)} of {total !== null ? inr(total) : 'a total not entered yet'}
            {total !== null ? (matches ? ' · matches the total' : ` · ${sum > total ? 'more' : 'less'} than the total by ${inr(Math.abs(total - sum))}`) : ''}
          </span>
        </SummaryRow>
      </SummaryList>
      <SectionSave label="Save payment plan" dirty={f.dirty} editable={editable} />
    </form>
  );
}
