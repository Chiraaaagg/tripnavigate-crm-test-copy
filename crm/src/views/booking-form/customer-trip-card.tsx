'use client';

import { CalendarDays, CircleAlert, Download, Lock, MapPin, Pencil, UserRound, Users } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Field } from '@/components/ui/field';
import { NumberStepper } from '@/components/ui/number-stepper';
import { SaveStatus } from '@/components/ui/save-status';
import { BOOKING_FORM_FIELD_ID as F, EMAIL_SHAPE, normalisePhone, parseCount, partyCounts, tripNights } from '@/modules/fulfilment/booking-form-model';
import { CUSTOMER_MARKETS, CUSTOMER_TYPES, PAX_TOTAL_MAX, type BookingFormCore, type CustomerMarket, type CustomerType } from '@/modules/fulfilment/booking-form-contract';
import { TRIP_SCOPE_LABEL, type TripScope } from '@/modules/fulfilment/contracts';
import { SelectField, TextField } from '../b11/controls';
import { dateText } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import type { FieldRef, UiResult } from '../b11/form-kit';
import { usePrefillField } from '../b11/prefill-inline';
import type { B11Action, BookNowView } from '../b11/shapes';
import { useAutosave } from './autosave-queue';
import { HiddenDraftInputs, editableOf, errFor, useShownRefusal } from './form-helpers';
import { SectionCard } from './parts';
import type { DealTripFactsView } from './vn-types';
import { countsProblem, effectiveAdults } from './count-rules';

export { countsProblem, effectiveAdults };

/*
 * Step 1 · "Customer & trip" (Book now v2, owner-approved prototype step1).
 * Trip facts the Bitrix Deal sends sit in a locked bar at the top ("Trip
 * facts from the Bitrix Deal", with Correct); inputs are shown only for what
 * the Deal does not send. Travellers are three steppers (Adults, Children,
 * Infants); the total is their sum. The card saves itself (owner answer 2):
 * a moment after typing stops it runs the checks below and saves only when
 * all pass (lead ruling D1); otherwise the pill says "Not saved · needs a fix"
 * with the reason under the card. The leave-page warning stays. "Customer type
 * & market" stays as a closed group after the prototype's fields (owner
 * decision D3, 26 October 2026). Element ids are BOOKING_FORM_FIELD_ID.
 */

export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = { individual: 'Individual', b2d: 'B2D', corporate: 'Corporate', travel_agent: 'Travel agent' };
export const MARKET_LABEL: Record<CustomerMarket, string> = { india: 'India', uae: 'UAE', other: 'Other' };

export const CUSTOMER_REFS: FieldRef[] = [
  { field: 'contactName', id: F.contactName, label: 'Enter the customer name.' },
  { field: 'mobile', id: F.mobile, label: 'Mobile number: 10 digits starting with 6 to 9.' },
  { field: 'email', id: F.email, label: 'Check the email address.' },
  { field: 'contactConfirmed', id: F.contactConfirmed, label: 'Check the mobile or email with the customer, then tick the box.' },
  { field: 'destination', id: F.destination, label: 'Enter the destination.' },
  { field: 'tripScope', id: F.tripScope, label: 'Choose domestic or international.' },
  { field: 'tripStart', id: F.tripStart, label: 'Choose a valid travel date.' },
  { field: 'tripEnd', id: F.tripEnd, label: 'Return date must be on or after the travel date.' },
  { field: 'paxTotal', id: F.adults, label: `Travellers: 1 to ${PAX_TOTAL_MAX} in all.` },
  { field: 'adults', id: F.adults, label: 'Enter the number of adults.' },
  { field: 'children', id: F.children, label: 'Children: a whole number.' },
  { field: 'infants', id: F.infants, label: 'Infants: a whole number.' },
  { field: 'customerType', id: F.customerType, label: 'Choose the customer type.' },
  { field: 'market', id: F.market, label: 'Choose the market.' },
];

const num = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Party counts of the typed values (empty child/infant counts read as 0, as on screen). */
export function typedParty(v: Pick<CustomerValues, 'paxTotal' | 'children' | 'infants'>) {
  return partyCounts({ total: v.paxTotal, children: v.children.trim() === '' ? '0' : v.children, infants: v.infants.trim() === '' ? '0' : v.infants });
}

/** Which typed value a refused field name is about (a corrected field loses its error). */
const PICK: Record<string, (v: CustomerValues) => unknown> = {
  contactName: (v) => v.contactName,
  mobile: (v) => v.mobile,
  email: (v) => v.email,
  contactConfirmed: (v) => v.contactConfirmed,
  destination: (v) => v.destination,
  tripScope: (v) => v.scope,
  tripStart: (v) => v.start,
  tripEnd: (v) => v.end,
  paxTotal: (v) => [v.adults, v.children, v.infants],
  adults: (v) => [v.adults, v.children, v.infants],
  children: (v) => v.children,
  infants: (v) => v.infants,
  customerType: (v) => v.customerType,
  market: (v) => v.market,
};

export interface CustomerValues {
  contactName: string;
  mobile: string;
  email: string;
  contactConfirmed: boolean;
  destination: string;
  /** '' until somebody chooses (never a silent Domestic, Echo B-M3). */
  scope: TripScope | '';
  start: string;
  end: string;
  /** The Deal's total when it sends one without a split, else adults + children + infants. */
  paxTotal: string;
  adults: string;
  children: string;
  infants: string;
  customerType: string;
  market: string;
}

/** Which trip values the Bitrix Deal supplies (shown locked; inputs only for the rest). */
export function dealBacked(d: DealTripFactsView | null | undefined) {
  return {
    destination: Boolean(d?.destination),
    start: Boolean(d?.start),
    end: Boolean(d?.end),
    total: d?.total !== null && d?.total !== undefined,
    adults: d?.adults !== null && d?.adults !== undefined,
    children: d?.children !== null && d?.children !== undefined,
    infants: d?.infants !== null && d?.infants !== undefined,
    scope: Boolean(d?.scope),
  };
}

export function customerInitial(vm: BookingFormCore, view: BookNowView, deal?: DealTripFactsView | null): CustomerValues {
  const c = view.contacts;
  const d = deal ?? null;
  const children = d?.children ?? vm.party.children ?? 0;
  const infants = d?.infants ?? vm.party.infants ?? 0;
  // Saved adults (voice-note batch); on older versions worked out from the total.
  const savedAdults = (vm as { partyAdults?: number | null }).partyAdults ?? null;
  const total = d?.total ?? vm.party.total;
  // A total with no adult count (the Deal's or the stored party's): adults = total − children − infants (the live rule).
  const adults = d?.adults ?? savedAdults ?? (total !== null && total !== undefined ? Math.max(0, total - (children ?? 0) - (infants ?? 0)) : null);
  return {
    contactName: c?.contactName ?? '',
    mobile: c?.mobile ?? '',
    email: c?.email ?? '',
    contactConfirmed: c?.contactConfirmed ?? false,
    destination: d?.destination ?? vm.trip.destination ?? '',
    scope: d?.scope ?? vm.trip.scope ?? '',
    start: d?.start ?? vm.trip.start ?? '',
    end: d?.end ?? vm.trip.end ?? '',
    paxTotal: num(total),
    adults: num(adults),
    children: String(children),
    infants: String(infants),
    customerType: vm.customerType ?? '',
    market: vm.market ?? '',
  };
}

/** Adults, children and infants as numbers (empty child and infant boxes read as 0). */
export function countsOf(v: Pick<CustomerValues, 'adults' | 'children' | 'infants'>) {
  const a = v.adults.trim() === '' ? null : parseCount(v.adults);
  const c = parseCount(v.children.trim() || '0') ?? 0;
  const i = parseCount(v.infants.trim() || '0') ?? 0;
  return { a, c, i, total: a === null ? null : a + c + i };
}

/** The total the form posts: the Deal's total when it sends one without a split, else the sum. */
export function postedTotal(v: CustomerValues, deal: DealTripFactsView | null): string {
  const from = dealBacked(deal);
  if (from.total && !from.adults) return v.paxTotal;
  const n = countsOf(v);
  return n.total === null ? '' : String(n.total);
}

/** The card's checks before it saves, in the live CRM wording (prototype custIssues). The server checks again. */
export function customerIssues(v: CustomerValues, deal: DealTripFactsView | null): string[] {
  const out: string[] = [];
  const n = countsOf(v);
  if (!v.contactName.trim()) out.push('Enter the customer name.');
  if (v.mobile.trim() && normalisePhone(v.mobile) === undefined) out.push('Mobile number: 10 digits starting with 6 to 9.');
  if (v.email.trim() && !EMAIL_SHAPE.test(v.email.trim())) out.push('Check the email address.');
  if (!v.mobile.trim() && !v.email.trim()) out.push('Enter a mobile number or email.');
  if (!v.destination.trim()) out.push('Enter the destination.');
  if (!v.start) out.push('Choose a valid travel date.');
  if (v.start && v.end && v.end < v.start) out.push('Return date must be on or after the travel date.');
  if (!v.scope) out.push('Choose domestic or international.');
  if (n.a === null) out.push('Enter the number of adults.');
  else if (n.a < 1) out.push('At least one adult travels.');
  else if (n.total !== null && n.total > PAX_TOTAL_MAX) out.push(`Travellers: 1 to ${PAX_TOTAL_MAX} in all.`);
  const from = dealBacked(deal);
  if (n.a !== null && from.total && !from.adults) {
    const split = countsProblem(v, true);
    if (split) out.push(split);
  }
  if (!v.contactConfirmed) out.push('Check the mobile or email with the customer, then tick the box.');
  return out;
}

/** "3 travellers (2 adults, 1 child)" */
export function travellersText(a: number, c: number, i: number) {
  return `${plural(a + c + i, 'traveller', 'travellers')} (${plural(a, 'adult', 'adults')}${c ? `, ${plural(c, 'child', 'children')}` : ''}${i ? `, ${plural(i, 'infant', 'infants')}` : ''})`;
}

/** Small "From Bitrix" tag inside a label (change 15). */
export function FromBitrix() {
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 rounded-[0.25rem] bg-brand-tint px-1.5 text-xs font-medium text-brand-deep">
      <Download aria-hidden="true" className="size-3" />
      From Bitrix
    </span>
  );
}

const factChip = 'inline-flex items-center gap-1.25 rounded-full border border-line bg-card px-2.25 py-0.5 text-xs font-medium text-copy';

export function CustomerTripCard({
  vm,
  view,
  action,
  onValues,
  dealFacts = null,
  onCorrect,
}: {
  vm: BookingFormCore;
  view: BookNowView;
  action: B11Action;
  /** Live typed values (the summary, the passenger rows and the price table follow them). */
  onValues?: (v: CustomerValues) => void;
  /** Trip facts read from the Bitrix Deal (null = none: every value is asked here). */
  dealFacts?: DealTripFactsView | null;
  /** Opens "Correct trip details in Bitrix". */
  onCorrect: () => void;
}) {
  const from = dealBacked(dealFacts);
  const initial = customerInitial(vm, view, dealFacts);
  const editable = editableOf(view);
  const f = useSectionForm({
    id: 'customer',
    section: 'customer',
    label: 'Customer & trip',
    order: 10,
    action,
    initial,
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    // Saved by the card itself (auto-save), never by a footer button.
    saveable: false,
    tracksDirty: true,
  });
  const v = f.values;
  useEffect(() => {
    onValues?.(v);
  }, [v, onValues]);
  const refusal = useShownRefusal(f, (name) => PICK[name]);
  const err = errFor(CUSTOMER_REFS, refusal.fields);
  const set = <K extends keyof CustomerValues>(k: K, x: CustomerValues[K]) => {
    f.setValues((s) => {
      const next = { ...s, [k]: x };
      // Changing the mobile or email asks for the confirmation again.
      if ((k === 'mobile' || k === 'email') && x !== s[k]) next.contactConfirmed = false;
      return next;
    });
  };
  const pfName = usePrefillField(F.contactName, 'contacts.contactName');
  const pfMobile = usePrefillField(F.mobile, 'contacts.mobile');
  const pfEmail = usePrefillField(F.email, 'contacts.email');
  const fromBitrix = { name: Boolean(pfName.aside), mobile: Boolean(pfMobile.aside), email: Boolean(pfEmail.aside) };

  // After "Refresh from Bitrix now" the Deal's values differ from the stored ones: store them once.
  const stored = customerInitial(vm, view, null);
  const dealNewer = Boolean(dealFacts) && (['destination', 'start', 'end', 'scope', 'adults', 'children', 'infants'] as const).some((k) => from[k] && String(initial[k]) !== String(stored[k]));

  const formRef = useRef<HTMLFormElement | null>(null);
  const bindForm = f.bindForm;
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      bindForm(el);
    },
    [bindForm],
  );
  const save = useAutosave({
    key: 'customer',
    values: v,
    dirty: f.dirty || dealNewer,
    enabled: editable,
    hasStored: Boolean(view.contacts?.contactName),
    check: () => customerIssues(f.values, dealFacts),
    send: () => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve<UiResult>({ ok: false, code: 'unexpected', message: '' } as UiResult)),
    refs: CUSTOMER_REFS,
  });

  const n = countsOf(v);
  const locked = from.adults;
  const nights = tripNights(v.start || null, v.end || null);
  const lockedTrip = Boolean(dealFacts) && (from.destination || from.start || from.adults);
  const need = (k: 'destination' | 'start' | 'end' | 'scope') => !from[k];
  const stepper = (key: 'adults' | 'children' | 'infants', label: string, id: string) =>
    from[key] ? (
      <div key={key} className="flex flex-col gap-1.5">
        <span className="font-semibold text-ink">{label}</span>
        <p id={id} tabIndex={-1} className="m-0 flex min-h-11 items-center gap-1.5 outline-none">
          <b className="text-lg text-ink tabular-nums">{v[key]}</b>
          <span className="text-sm text-quiet">from the Deal</span>
        </p>
        <input type="hidden" name={key} value={v[key]} />
      </div>
    ) : (
      <Field key={key} htmlFor={id} label={label}>
        <NumberStepper
          id={id}
          name={key}
          min={0}
          max={PAX_TOTAL_MAX}
          value={v[key]}
          onChange={(x) => set(key, x)}
          unitLabel={{ decrease: 'One fewer', increase: 'One more' }}
          statusLabel={`${label}: `}
          invalid={Boolean(err(key))}
          disabled={!editable}
        />
      </Field>
    );
  const totalHint =
    from.total && !from.adults
      ? `Total: ${v.paxTotal} (from the Deal). A passenger row appears for each one below.`
      : n.total !== null
        ? `Total: ${n.total}. A passenger row appears for each one below.`
        : 'Set how many travel. A passenger row appears for each one below.';
  const reason = save.state === 'fix' ? save.reason : null;
  const scopeLabel = v.scope ? TRIP_SCOPE_LABEL[v.scope] : null;
  return (
    <SectionCard id="customer" title="Customer & trip" icon={UserRound} action={<SaveStatus id="pill-customer" state={save.state} reason={save.reason} label="Customer & trip" />}>
      <form ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="customer-heading">
        <div className="p-5 max-sm:p-4">
          {/* Old links to #trip land here. */}
          <span id="trip" data-focus-target="customer-heading" />
          <HiddenDraftInputs view={view} base={f.base} result={f.state} />
          <input type="hidden" name="paxTotal" value={postedTotal(v, dealFacts)} />
          {lockedTrip ? (
            <div className="mb-4.5 flex items-start gap-3 rounded-control bg-wash px-3.5 py-3" data-slot="deal-facts">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />
              <div className="min-w-0 flex-1">
                <p className="m-0 font-semibold text-ink">Trip facts from the Bitrix Deal</p>
                <ul className="m-0 mt-[0.5rem] flex list-none flex-wrap gap-1.5 p-0" aria-label="Trip facts">
                  {from.destination ? (
                    <li className={factChip}>
                      <MapPin aria-hidden="true" className="size-3" />
                      {v.destination}
                    </li>
                  ) : null}
                  {from.start ? (
                    <li className={factChip}>
                      <CalendarDays aria-hidden="true" className="size-3" />
                      {dateText(v.start)}
                      {from.end && v.end ? ` – ${dateText(v.end)}` : ''}
                      {nights !== null ? ` · ${plural(nights, 'night', 'nights')}` : ''}
                    </li>
                  ) : null}
                  {from.adults && n.a !== null ? (
                    <li className={factChip}>
                      <Users aria-hidden="true" className="size-3" />
                      {travellersText(n.a, n.c, n.i)}
                    </li>
                  ) : null}
                  {from.scope && scopeLabel ? <li className={factChip}>{scopeLabel}</li> : null}
                </ul>
                <p className="m-0 mt-1.5 text-sm text-quiet">Read from Bitrix {dateText(dealFacts?.readAt ?? null) ?? ''}. These are locked here so the booking always matches the Deal.</p>
              </div>
              {editable ? (
                <Button variant="link" className="min-h-10 shrink-0" onClick={onCorrect}>
                  <Pencil aria-hidden="true" />
                  Correct
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2 sm:grid-cols-3">
            <TextField id={F.contactName} name="contactName" label={<>Name{fromBitrix.name ? <FromBitrix /> : null}</>} value={v.contactName} onChange={(x) => set('contactName', x)} error={err('contactName')} maxLength={120} autoComplete="name" disabled={!editable} />
            <TextField id={F.mobile} name="mobile" label={<>Phone{fromBitrix.mobile ? <FromBitrix /> : null}</>} type="tel" inputMode="tel" value={v.mobile} onChange={(x) => set('mobile', x)} error={err('mobile')} maxLength={16} autoComplete="tel-national" disabled={!editable} />
            <TextField id={F.email} name="email" label={<>Email{fromBitrix.email ? <FromBitrix /> : null}</>} type="email" inputMode="email" value={v.email} onChange={(x) => set('email', x)} error={err('email')} maxLength={254} autoComplete="email" disabled={!editable} />
          </div>
          {/* Deal-backed values still post, so the booking keeps its copy; the server takes the Deal's value. */}
          {from.destination ? <input type="hidden" name="destination" value={v.destination} /> : null}
          {from.start ? <input type="hidden" name="tripStart" value={v.start} /> : null}
          {from.end ? <input type="hidden" name="tripEnd" value={v.end} /> : null}
          {from.scope ? <input type="hidden" name="tripScope" value={v.scope} /> : null}
          {need('destination') || need('start') || need('end') || need('scope') ? (
            <div className="mt-4 grid grid-cols-1 gap-4 min-[381px]:grid-cols-2 sm:grid-cols-4">
              {need('destination') ? <TextField id={F.destination} name="destination" label="Destination" value={v.destination} onChange={(x) => set('destination', x)} error={err('destination')} maxLength={200} disabled={!editable} /> : null}
              {need('start') ? <TextField id={F.tripStart} name="tripStart" label="Travel date" type="date" value={v.start} onChange={(x) => set('start', x)} error={err('tripStart')} disabled={!editable} /> : null}
              {need('end') ? <TextField id={F.tripEnd} name="tripEnd" label="Return date" type="date" min={v.start || undefined} value={v.end} onChange={(x) => set('end', x)} error={err('tripEnd')} disabled={!editable} /> : null}
              {need('scope') ? (
                <SelectField
                  id={F.tripScope}
                  name="tripScope"
                  label="Trip"
                  value={v.scope}
                  onChange={(x) => set('scope', x as TripScope | '')}
                  options={[{ value: '', label: 'Choose' }, ...(['domestic', 'international'] as const).map((s) => ({ value: s, label: TRIP_SCOPE_LABEL[s] }))]}
                  error={err('tripScope')}
                  disabled={!editable}
                />
              ) : null}
            </div>
          ) : null}
          {locked ? (
            <>
              <input type="hidden" name="adults" value={v.adults} />
              <input type="hidden" name="children" value={v.children} />
              <input type="hidden" name="infants" value={v.infants} />
            </>
          ) : (
            <div role="group" aria-labelledby="bf-travellers-label" className="mt-4.5 border-t border-line pt-4">
              <div id="bf-travellers-label" className="mb-2.5 font-semibold text-ink">
                Travellers
              </div>
              <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2 sm:grid-cols-3">
                {stepper('adults', 'Adults', F.adults)}
                {stepper('children', 'Children', F.children)}
                {stepper('infants', 'Infants', F.infants)}
              </div>
              <p id={F.paxTotal} tabIndex={-1} className="m-0 mt-[0.5rem] text-sm text-quiet outline-none" aria-live="polite">
                {totalHint}
              </p>
            </div>
          )}
          <label htmlFor={F.contactConfirmed} className="mt-4.5 flex cursor-pointer items-start gap-2.5">
            <input
              id={F.contactConfirmed}
              name="contactConfirmed"
              type="checkbox"
              checked={v.contactConfirmed}
              onChange={(e) => set('contactConfirmed', e.target.checked)}
              disabled={!editable}
              aria-describedby={`${F.contactConfirmed}-hint`}
              aria-invalid={err('contactConfirmed') ? true : undefined}
              className={cn('m-0 mt-0.5 size-4 shrink-0 cursor-pointer accent-brand-strong', focusRing)}
            />
            <span>
              <b className="text-ink">I confirmed the contact details with the customer</b>
              <span id={`${F.contactConfirmed}-hint`} className="block text-sm text-quiet">
                {dealFacts && (fromBitrix.mobile || fromBitrix.email || fromBitrix.name) ? 'Ticking this also marks the mobile number and email from Bitrix as checked.' : 'Changing the phone or email asks again.'}
              </span>
            </span>
          </label>
          <details className="group/ct mt-4.5 border-t border-line pt-3.5">
            <summary className={cn('w-fit cursor-pointer rounded-chip font-semibold text-brand-strong group-open/ct:mb-3.5', focusRing)}>Customer type &amp; market</summary>
            <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
              <SelectField
                id={F.customerType}
                name="customerType"
                label="Customer type"
                optional
                value={v.customerType}
                onChange={(x) => set('customerType', x)}
                options={[{ value: '', label: 'Choose' }, ...CUSTOMER_TYPES.map((t) => ({ value: t, label: CUSTOMER_TYPE_LABEL[t] }))]}
                error={err('customerType')}
                disabled={!editable}
              />
              <SelectField
                id={F.market}
                name="market"
                label="Market"
                optional
                value={v.market}
                onChange={(x) => set('market', x)}
                options={[{ value: '', label: 'Choose' }, ...CUSTOMER_MARKETS.map((m) => ({ value: m, label: MARKET_LABEL[m] }))]}
                error={err('market')}
                disabled={!editable}
              />
            </div>
          </details>
          {reason ? (
            <p id="why-customer" className="m-0 mt-3 flex items-start gap-1.5 text-sm font-medium text-status-danger">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{reason}</span>
            </p>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}
