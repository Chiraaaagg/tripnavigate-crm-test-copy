'use client';

import { CircleAlert, MapPin, Pencil, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { NumberStepper } from '@/components/ui/number-stepper';
import { BOOKING_FORM_FIELD_ID as F, parseCount, partyCounts, tripNights } from '@/modules/fulfilment/booking-form-model';
import { CUSTOMER_MARKETS, CUSTOMER_TYPES, PAX_TOTAL_MAX, type BookingFormCore, type CustomerMarket, type CustomerType } from '@/modules/fulfilment/booking-form-contract';
import { TRIP_SCOPE_LABEL, type TripScope } from '@/modules/fulfilment/contracts';
import { CheckField, SelectField, TextField } from '../b11/controls';
import { dateText } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import { ResultBox, type FieldRef } from '../b11/form-kit';
import { PREFILL_INLINE_TEXT, usePrefillField, usePrefillInlineMode } from '../b11/prefill-inline';
import type { B11Action, BookNowView } from '../b11/shapes';
import { HiddenDraftInputs, SectionSaveRow, editableOf, errFor, useShownRefusal, useSectionSubmit } from './form-helpers';
import { Disclosure, InlineNote, SectionBody, SectionCard } from './parts';
import type { DealTripFactsView } from './vn-types';
import { countsProblem, effectiveAdults } from './count-rules';

export { countsProblem, effectiveAdults };

/*
 * Step 1 · "Customer & trip" card of the approved preview: contact, trip and
 * party counts in one grid, customer type and market in a closed group, and
 * the contact confirmation tick. One form posting to saveCustomer (the loader
 * action runs the contact save with no billing, then the trip save with the
 * party counts; a partial save is reported honestly by that action).
 * Element ids are BOOKING_FORM_FIELD_ID (shared with refusals, readiness
 * links and the Bitrix markers).
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
  { field: 'paxTotal', id: F.paxTotal, label: `Enter the total number of passengers (1 to ${PAX_TOTAL_MAX}); adults, children and infants must add up to it.` },
  { field: 'adults', id: F.adults, label: 'Adults, children and infants must add up to the total.' },
  { field: 'children', id: F.children, label: 'Adults, children and infants must add up to the total.' },
  { field: 'infants', id: F.infants, label: 'Adults, children and infants must add up to the total.' },
  { field: 'customerType', id: F.customerType, label: 'Choose the customer type.' },
  { field: 'market', id: F.market, label: 'Choose the market.' },
];

const num = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

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
  paxTotal: (v) => [v.paxTotal, v.adults, v.children, v.infants],
  adults: (v) => [v.paxTotal, v.adults, v.children, v.infants],
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
  /** The Deal's total when it has one, else adults + children + infants (kept in step as counts change). */
  paxTotal: string;
  adults: string;
  children: string;
  infants: string;
  customerType: string;
  market: string;
}

/** Which trip values the Bitrix Deal supplies (shown read-only; inputs only for the rest). */
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
  // Saved adults (voice-note batch); empty on older versions, then worked out from the total on screen.
  const adults = d?.adults ?? (vm as { partyAdults?: number | null }).partyAdults ?? null;
  const total = d?.total ?? vm.party.total;
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

/** Adults + children + infants against the total (owner item 2: a larger or different split is refused). */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function CustomerTripCard({
  vm,
  view,
  reloadHref,
  action,
  onValues,
  dealFacts = null,
}: {
  vm: BookingFormCore;
  view: BookNowView;
  reloadHref: string;
  action: B11Action;
  /** Live typed values (the summary and the price table follow unsaved counts). */
  onValues?: (v: CustomerValues) => void;
  /** Trip facts read from the Bitrix Deal (null = none: every value is asked here). */
  dealFacts?: DealTripFactsView | null;
}) {
  const from = dealBacked(dealFacts);
  const [countsChecked, setCountsChecked] = useState(false);
  const initial = customerInitial(vm, view, dealFacts);
  // Follows the typed split (one render behind is fine: the step's save reads it when pressed).
  const [splitWrong, setSplitWrong] = useState(() => countsProblem(initial, from.total) !== null);
  const f = useSectionForm({
    id: 'customer',
    section: 'customer',
    label: 'Customer & trip',
    order: 10,
    action,
    initial,
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    // A split that does not add up is never sent (the step's save reports it as blocked).
    saveable: !splitWrong,
  });
  const { bindForm, bindResult } = f;
  const submitter = useSectionSubmit(f.post);
  const v = f.values;
  const countsErr = countsProblem(v, from.total);
  if ((countsErr !== null) !== splitWrong) setSplitWrong(countsErr !== null);
  useEffect(() => {
    onValues?.(v);
  }, [v, onValues]);
  const editable = editableOf(view);
  const refusal = useShownRefusal(f, (name) => PICK[name]);
  const err = errFor(CUSTOMER_REFS, refusal.fields);
  // Echo-B L5: on a sum error, mark only the counts the person changed (the adults box when none was changed).
  const [touchedCounts, setTouchedCounts] = useState<ReadonlySet<string>>(() => new Set());
  const set = <K extends keyof CustomerValues>(k: K, x: CustomerValues[K]) => {
    if ((k === 'adults' || k === 'children' || k === 'infants' || k === 'paxTotal') && !touchedCounts.has(k)) setTouchedCounts((t) => new Set([...t, k]));
    f.setValues((s) => {
      const next = { ...s, [k]: x };
      // Changing the mobile or email asks for the confirmation again (preview C28).
      if ((k === 'mobile' || k === 'email') && x !== s[k]) next.contactConfirmed = false;
      return next;
    });
  };
  const pfName = usePrefillField(F.contactName, 'contacts.contactName');
  const pfMobile = usePrefillField(F.mobile, 'contacts.mobile');
  const pfEmail = usePrefillField(F.email, 'contacts.email');
  const pfStart = usePrefillField(F.tripStart, 'trip.start');
  const pfEnd = usePrefillField(F.tripEnd, 'trip.end');
  const inline = usePrefillInlineMode();
  const contactFromBitrix = inline && [pfMobile, pfEmail].some((x) => x.aside);
  const c = view.contacts;
  const showCountsError = countsErr !== null && (countsChecked || f.dirty) && editable;
  const countsError = showCountsError ? countsErr : (err('adults') ?? err('paxTotal') ?? err('children') ?? err('infants'));
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (countsErr) {
      e.preventDefault();
      setCountsChecked(true);
      requestAnimationFrame(() => document.getElementById(from.adults ? (from.children ? F.infants : F.children) : F.adults)?.focus());
      return;
    }
    submitter.onSubmit(e);
  };

  // The read-only line of Deal facts (only what the Deal supplies).
  const nights = from.start && from.end ? tripNights(v.start, v.end) : null;
  const facts: string[] = [];
  if (from.destination) facts.push(v.destination);
  if (from.start) facts.push(from.end ? `${dateText(v.start)} – ${dateText(v.end)}${nights !== null ? ` · ${plural(nights, 'night', 'nights')}` : ''}` : `From ${dateText(v.start)}`);
  else if (from.end) facts.push(`Until ${dateText(v.end)}`);
  if (from.total) {
    const split = [from.adults ? plural(Number(v.adults), 'adult', 'adults') : null, from.children ? plural(Number(v.children), 'child', 'children') : null, from.infants ? plural(Number(v.infants), 'infant', 'infants') : null].filter(Boolean);
    facts.push(`${plural(Number(v.paxTotal), 'traveller', 'travellers')}${split.length ? ` (${split.join(', ')})` : ''}`);
  }
  if (from.scope && v.scope) facts.push(TRIP_SCOPE_LABEL[v.scope]);
  const anyMissingTrip = !from.destination || !from.start || !from.end || !from.scope;
  const allCountsFromDeal = from.adults && from.children && from.infants;
  const derived = v.adults.trim() === '' ? effectiveAdults(v) : null;
  // The total line carries the total's id when the total is the Deal's (no input then).
  const totalLineId = from.total ? F.paxTotal : 'bf-counts-total';
  const countInput = (key: 'adults' | 'children' | 'infants', label: string, id: string) =>
    from[key] ? (
      <div key={key} className="flex flex-col gap-1.5">
        <span className="font-semibold text-ink">{label}</span>
        <p id={id} tabIndex={-1} className="m-0 flex min-h-11 items-center gap-1.5 outline-none">
          <span className="font-semibold text-ink tabular-nums">{v[key]}</span>
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
          placeholder={key === 'adults' && derived !== null ? String(derived) : undefined}
          emptyBase={key === 'adults' ? derived : undefined}
          unitLabel={{ decrease: `One ${key === 'children' ? 'child' : key === 'infants' ? 'infant' : 'adult'} fewer`, increase: `One ${key === 'children' ? 'child' : key === 'infants' ? 'infant' : 'adult'} more` }}
          invalid={Boolean(countsError) && (touchedCounts.size === 0 ? key === 'adults' : touchedCounts.has(key))}
          aria-describedby={countsError ? `bf-counts-error ${totalLineId}` : totalLineId}
          statusLabel={`${label}: `}
          disabled={!editable}
        />
      </Field>
    );
  return (
    <SectionCard id="customer" title="Customer & trip" icon={UserRound}>
      <form ref={bindForm} onSubmit={onSubmit} noValidate aria-labelledby="customer-heading">
        <SectionBody className="flex flex-col gap-0">
          {/* Old links to #trip land here. */}
          <span id="trip" />
          <div ref={bindResult} className="mb-4 [&:has(>[role=status]:empty)]:hidden">
            {/* The action words its own success, including an honest partial ("… save after the database update."). */}
            <ResultBox result={refusal.shown} fields={CUSTOMER_REFS} reloadHref={reloadHref} />
          </div>
          <HiddenDraftInputs view={view} base={f.base} result={f.state} />
          <div className="grid grid-cols-1 gap-3.5 min-[381px]:grid-cols-2 sm:grid-cols-3 sm:gap-4">
            <TextField id={F.contactName} name="contactName" label="Name" {...pfName} value={v.contactName} onChange={(x) => set('contactName', x)} error={err('contactName')} maxLength={120} autoComplete="name" disabled={!editable} />
            <TextField id={F.mobile} name="mobile" label="Phone" type="tel" inputMode="tel" {...pfMobile} value={v.mobile} onChange={(x) => set('mobile', x)} error={err('mobile')} maxLength={16} autoComplete="tel-national" disabled={!editable} />
            <TextField id={F.email} name="email" label="Email" type="email" inputMode="email" {...pfEmail} value={v.email} onChange={(x) => set('email', x)} error={err('email')} maxLength={254} autoComplete="email" disabled={!editable} />
          </div>

          {facts.length > 0 ? (
            <div id={allCountsFromDeal ? F.paxTotal : undefined} tabIndex={allCountsFromDeal ? -1 : undefined} className="mt-4.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-control bg-wash px-3.5 py-2.75 outline-none" data-slot="deal-facts">
              <p className="m-0 flex min-w-0 items-start gap-2 text-base text-ink">
                <MapPin aria-hidden="true" className="mt-[0.25rem] size-4 shrink-0 text-quiet" />
                <span className="min-w-0 wrap-anywhere">
                  <span className="sr-only">Trip from the Bitrix Deal: </span>
                  {facts.join(' · ')}
                  <span className="mt-0.5 block text-sm text-quiet">From the Bitrix Deal{dealFacts?.readAt ? ` · read ${dateText(dealFacts.readAt)}` : ''}</span>
                </span>
              </p>
              <CorrectDealFacts href={dealFacts?.bitrixDealHref ?? null} />
            </div>
          ) : null}
          {/* Deal-backed values still post, so the booking keeps its copy; the server takes the Deal's value. */}
          {from.destination ? <input type="hidden" name="destination" value={v.destination} /> : null}
          {from.start ? <input type="hidden" name="tripStart" value={v.start} /> : null}
          {from.end ? <input type="hidden" name="tripEnd" value={v.end} /> : null}
          {from.scope ? <input type="hidden" name="tripScope" value={v.scope} /> : null}
          {from.total ? <input type="hidden" name="paxTotal" value={v.paxTotal} /> : null}

          {anyMissingTrip ? (
            <div className="mt-4.5 grid grid-cols-1 gap-3.5 min-[381px]:grid-cols-2 sm:grid-cols-3 sm:gap-4">
              {!from.destination ? <TextField id={F.destination} name="destination" label="Destination" value={v.destination} onChange={(x) => set('destination', x)} error={err('destination')} maxLength={200} disabled={!editable} /> : null}
              {!from.start ? <TextField id={F.tripStart} name="tripStart" label="Travel date" type="date" {...pfStart} value={v.start} onChange={(x) => set('start', x)} error={err('tripStart')} disabled={!editable} /> : null}
              {!from.end ? <TextField id={F.tripEnd} name="tripEnd" label="Return date" type="date" min={v.start || undefined} {...pfEnd} value={v.end} onChange={(x) => set('end', x)} error={err('tripEnd')} disabled={!editable} /> : null}
              {!from.scope ? (
                <SelectField
                  id={F.tripScope}
                  name="tripScope"
                  label="Trip"
                  hint={dealFacts?.destination ? 'This Bitrix destination is not classified yet.' : undefined}
                  value={v.scope}
                  onChange={(x) => set('scope', x as TripScope | '')}
                  options={[{ value: '', label: 'Choose' }, ...(['domestic', 'international'] as const).map((s) => ({ value: s, label: TRIP_SCOPE_LABEL[s] }))]}
                  error={err('tripScope')}
                  disabled={!editable}
                />
              ) : null}
            </div>
          ) : null}

          {allCountsFromDeal ? (
            <>
              <input type="hidden" name="adults" value={v.adults} />
              <input type="hidden" name="children" value={v.children} />
              <input type="hidden" name="infants" value={v.infants} />
              {countsError ? (
                <p id="bf-counts-error" role="alert" className="m-0 mt-3 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>{countsError}</span>
                </p>
              ) : null}
            </>
          ) : (
            <fieldset className="m-0 mt-4.5 min-w-0 border-0 border-t border-line p-0 pt-4.5">
              <legend className="float-left mb-3 w-full p-0 text-base font-semibold text-ink">Travellers</legend>
              <div className={from.total ? 'clear-both grid grid-cols-1 gap-3.5 sm:grid-cols-3 sm:gap-4' : 'clear-both grid grid-cols-1 gap-3.5 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4'}>
                {from.total ? null : (
                  <TextField id={F.paxTotal} name="paxTotal" label="Total passengers" type="number" min={1} max={PAX_TOTAL_MAX} value={v.paxTotal} onChange={(x) => set('paxTotal', x)} error={err('paxTotal')} disabled={!editable} />
                )}
                {countInput('adults', 'Adults', F.adults)}
                {countInput('children', 'Children', F.children)}
                {countInput('infants', 'Infants', F.infants)}
              </div>
              <p id={totalLineId} tabIndex={-1} className="m-0 mt-2.5 text-sm text-quiet outline-none" aria-live="polite">
                {from.total ? (
                  <>
                    Total: <span className="font-semibold text-ink tabular-nums">{v.paxTotal || '—'}</span> (from the Deal)
                  </>
                ) : null}
                {derived !== null ? `${from.total ? ' · ' : ''}Adults worked out as ${derived} (total minus children and infants).` : null}
              </p>
              {countsError ? (
                <p id="bf-counts-error" role="alert" className="m-0 mt-1.5 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>{countsError}</span>
                </p>
              ) : null}
            </fieldset>
          )}

          <Disclosure summary="Customer type & market">
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
          </Disclosure>
          <CheckField
            id={F.contactConfirmed}
            name="contactConfirmed"
            className="mt-5"
            label="I confirmed the contact details with the customer"
            description={
              c?.contactConfirmed && v.contactConfirmed && c.confirmedByName
                ? `Confirmed by ${c.confirmedByName}${c.confirmedAt ? ` on ${dateText(c.confirmedAt)}` : ''}. Changing the phone or email asks again.`
                : contactFromBitrix && !v.contactConfirmed
                  ? PREFILL_INLINE_TEXT.contactTickChecks
                  : undefined
            }
            checked={v.contactConfirmed}
            onChange={(x) => set('contactConfirmed', x)}
            error={err('contactConfirmed')}
            disabled={!editable}
          />
          {vm.prefillMode === 'off' ? <InlineNote className="mt-4">Details are entered by hand.</InlineNote> : null}
          <div className="mt-4 empty:hidden">
            <SectionSaveRow label="Save customer details" dirty={f.dirty} editable={editable} pending={submitter.pending} />
          </div>
        </SectionBody>
      </form>
    </SectionCard>
  );
}

/** "Correct": the values belong to the Bitrix Deal, so they are changed there (owner answer 3). */
function CorrectDealFacts({ href }: { href: string | null }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="min-h-10">
          <Pencil aria-hidden="true" />
          Correct
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel="Close">
        <DialogHeader>
          <DialogTitle>Correct trip details in Bitrix</DialogTitle>
          <DialogDescription>These come from the Bitrix Deal. Change them on the Deal in Bitrix; this booking shows the new values after the next Bitrix update.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="m-0 text-sm text-quiet">Details the Deal does not have are asked for here once.</p>
        </DialogBody>
        <DialogFooter>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'secondary' }))}>
              Open the Deal in Bitrix
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          <DialogClose asChild>
            <Button variant="primary">OK</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
