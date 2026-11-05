'use client';

import { Pencil, Search, Upload, UserRound, X } from 'lucide-react';
import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { SaveStatus } from '@/components/ui/save-status';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { CUSTOMER_LIST_MAX_BYTES, CUSTOMER_LIST_MIN_QUERY, type BillToType, type BillToView, type GstStatus } from '@/modules/fulfilment/booking-form-contract';
import {
  BOOKING_FORM_FIELD_ID as F,
  billToFromCustomer,
  CUSTOMER_LIST_TEXT,
  CustomerListError,
  emptyBillTo,
  readCustomerListText,
  searchCustomerList,
  switchBillToType,
  type BillToInput,
  type CustomerListEntry,
} from '@/modules/fulfilment/booking-form-model';
import { GST_STATES, dateText } from '../b11/book-fields';
import { SelectField, TextField } from '../b11/controls';
import { useSectionForm, type SyncSection } from '../b11/draft-sync';
import { type FieldRef, type UiResult } from '../b11/form-kit';
import { useAutosave } from './autosave-queue';
import type { B11Action, BookNowView } from '../b11/shapes';
import { AddCustomerDialog, PartyPicker, PartyStatus } from './bill-to-parties';
import type { PartyActions, PartyCheckStatus, PartyOption } from './vn-types';
import { HiddenDraftInputs, editableOf, errFor, useShownRefusal } from './form-helpers';
import { InlineNote, SectionBody, SectionCard } from './parts';

/*
 * Step 3 · Bill To (approved preview BillTo; contract §2.10–2.11). Personal or
 * business, India only. "Find an existing client" searches a customer list
 * the staff member opens from their computer: it is read in this browser tab
 * only (never uploaded, never stored, gone on reload); choosing a row fills
 * the form, which stays editable; only the saved Bill To fields reach the
 * CRM, never the list or its id. Sales never verifies: Accounts checks the
 * details before use.
 */

const REFS: FieldRef[] = [
  { field: 'billToType', id: F.billToType, label: 'Choose Personal or Business.' },
  { field: 'billingName', id: F.billingName, label: 'Enter the Bill To name.' },
  { field: 'contactPerson', id: F.contactPerson, label: 'Add the contact name at the business.' },
  { field: 'billingPhone', id: F.billingPhone, label: 'Check the billing phone number.' },
  { field: 'billingEmail', id: F.billingEmail, label: 'Check the billing email.' },
  { field: 'addressLine1', id: F.addressLine1, label: 'Add the billing address.' },
  { field: 'addressLine2', id: F.addressLine2, label: 'Address line 2: up to 200 characters.' },
  { field: 'billingCity', id: F.billingCity, label: 'Add the city.' },
  { field: 'stateCode', id: F.stateCode, label: 'Choose the state.' },
  { field: 'postalCode', id: F.postalCode, label: 'Enter a six-digit PIN code that does not start with 0.' },
  { field: 'gstStatus', id: F.gstStatus, label: 'Choose whether the business is GST registered.' },
  { field: 'gstin', id: F.gstin, label: 'Check the GSTIN. Its first two digits must match the state.' },
  { field: 'gstReason', id: F.gstReason, label: 'Record why the business has no GSTIN (10 to 500 characters).' },
];

/** Which typed value a refused field name is about. */
const PICK: Record<string, (b: BillToInput) => unknown> = {
  billToType: (b) => b.type,
  billingName: (b) => b.name,
  contactPerson: (b) => b.contactPerson,
  billingPhone: (b) => b.phone,
  billingEmail: (b) => b.email,
  addressLine1: (b) => b.addressLine1,
  addressLine2: (b) => b.addressLine2,
  billingCity: (b) => b.city,
  stateCode: (b) => b.stateCode,
  postalCode: (b) => b.postalCode,
  gstStatus: (b) => b.gstStatus,
  gstin: (b) => b.gstin,
  gstReason: (b) => b.gstReason,
};

function fromView(b: BillToView | null): BillToInput {
  if (!b || b.status === 'none') return emptyBillTo(b?.type ?? 'personal');
  return {
    type: b.type,
    name: b.name,
    contactPerson: b.contactPerson ?? '',
    phone: b.phone ?? '',
    email: b.email ?? '',
    addressLine1: b.addressLine1,
    addressLine2: b.addressLine2 ?? '',
    city: b.city,
    stateCode: b.stateCode,
    postalCode: b.postalCode,
    gstStatus: b.gstStatus ?? '',
    gstin: b.gstin ?? '',
    gstReason: b.gstReason ?? '',
  };
}

export function BillToCard({
  billTo,
  view,
  action,
  contact,
  parties = null,
}: {
  billTo: BillToView | null;
  view: BookNowView;
  action: B11Action;
  reloadHref?: string;
  /** The typed booking contact ("Use booking contact"). */
  contact: { name: string; phone: string; email: string };
  /** Stored customers (search first, "Add customer"); null = today's card with the local list. */
  parties?: PartyActions | null;
}) {
  const editable = editableOf(view);
  const verified = billTo?.status === 'verified';
  // The billing profile's row version: our own saves move it at once; a newer one from the server wins.
  const [billingRv, setBillingRv] = useState(billTo?.rowVersion ?? 0);
  const [seenRv, setSeenRv] = useState(billTo?.rowVersion ?? 0);
  if ((billTo?.rowVersion ?? 0) !== seenRv) {
    setSeenRv(billTo?.rowVersion ?? 0);
    if ((billTo?.rowVersion ?? 0) > billingRv) setBillingRv(billTo?.rowVersion ?? 0);
  }
  const f = useSectionForm({
    id: 'billTo',
    // Echo B-L2: reports and markers name Bill To, not the customer section.
    section: 'billTo' as SyncSection,
    label: 'Bill To',
    order: 75,
    action,
    initial: fromView(billTo),
    // Bill To has its own row version (the billing profile), not the booking version's.
    versionBound: false,
    rowVersion: 0,
    saveable: false,
    tracksDirty: !verified,
    onSuccess: (r) => {
      const next = r.ok ? (r as { data?: { rowVersion?: unknown } }).data?.rowVersion : undefined;
      if (typeof next === 'number') setBillingRv(next);
    },
  });
  const b = f.values;
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
    key: 'billTo',
    values: b,
    dirty: f.dirty,
    enabled: editable && !verified,
    hasStored: billTo?.status === 'draft',
    check: () => billToIssues(f.values),
    send: () => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve({ ok: false, code: 'unexpected', message: '' } as UiResult)),
    refs: REFS,
  });
  const refusal = useShownRefusal(f, (name) => PICK[name]);
  const err = errFor(REFS, refusal.fields);
  const [selection, setSelection] = useState<{ id: string; edited: boolean } | null>(null);
  // Stored customer behind this Bill To ('' = typed by hand); the booking keeps its own copy of the details.
  const [party, setParty] = useState<{ id: string; status: PartyCheckStatus | null; name: string } | null>(() => (billTo?.partyId ? { id: billTo.partyId, status: billTo.partyCheckStatus ?? null, name: billTo.name } : null));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<{ name: string; type: BillToType } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const set = <K extends keyof BillToInput>(k: K, x: BillToInput[K]) => {
    f.setValues((s) => ({ ...s, [k]: x }));
    setSelection((sel) => (sel ? { ...sel, edited: true } : sel));
  };
  const business = b.type === 'business';
  const showFields = !parties || editing || Boolean(refusal.fields?.length) || save.state === 'fix';
  const stateName = (code: string) => GST_STATES.find((s) => s.code === code)?.name ?? code;

  if (verified && billTo) {
    return (
      <SectionCard id="billTo" title="Bill To" icon={UserRound}>
        <SectionBody className="flex flex-col gap-4">
          <Notice tone="locked" title="Billing checked by Accounts. Ask Accounts to change it.">
            {billTo.verifiedByName ? (
              <p>
                Checked by {billTo.verifiedByName}
                {billTo.verifiedAt ? ` on ${dateText(billTo.verifiedAt)}` : ''}.
              </p>
            ) : null}
          </Notice>
          <SummaryList>
            <SummaryRow label={billTo.type === 'business' ? 'Company name' : 'Full name'}>{billTo.name}</SummaryRow>
            {billTo.type === 'business' ? <SummaryRow label="Contact name">{billTo.contactPerson ?? <NotEntered />}</SummaryRow> : null}
            <SummaryRow label="Phone · Email">{[billTo.phone, billTo.email].filter(Boolean).join(' · ') || <NotEntered />}</SummaryRow>
            <SummaryRow label="Address">{[billTo.addressLine1, billTo.addressLine2, billTo.city, stateName(billTo.stateCode), billTo.postalCode, 'India'].filter(Boolean).join(', ')}</SummaryRow>
            {billTo.type === 'business' ? (
              <SummaryRow label="GST registration">{billTo.gstStatus === 'registered' ? `GST registered · ${billTo.gstin}` : billTo.gstStatus === 'unregistered' ? `Not GST registered · ${billTo.gstReason}` : <NotEntered />}</SummaryRow>
            ) : null}
          </SummaryList>
        </SectionBody>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="billTo"
      title="Bill To"
      icon={UserRound}
      status={<span className="text-sm font-normal text-quiet">· Waits for Accounts check</span>}
      action={editable ? <SaveStatus id="pill-billTo" state={save.state} reason={save.reason} label="Bill To" /> : null}
    >
      <SectionBody className="flex flex-col gap-5">
        {editable && parties ? (
          <>
            <PartyPicker
              parties={parties}
              label={b.name.trim() ? 'Change customer' : 'Find customer'}
              onPick={(hit) => {
                const fill = (p: PartyOption) => {
                  f.setValues(billToFromParty(p));
                  setParty({ id: p.partyId, status: p.checkStatus, name: p.name });
                  setEditing(false);
                  setPickError(null);
                  setPicked(p.checkStatus === 'returned' ? `${p.name} filled in. Accounts returned this customer: check the details with Edit details.` : `${p.name} filled in.`);
                };
                if (!parties.pick) {
                  fill(hit);
                  return;
                }
                // Search hits carry only the name and place: read the full details first; on failure nothing changes.
                setPicked(`Loading ${hit.name}…`);
                setPickError(null);
                parties
                  .pick(hit.partyId)
                  .then((r) => {
                    if (r.ok) fill(r.party);
                    else {
                      setPicked(null);
                      setPickError(`${r.message} The Bill To details were not changed.`);
                    }
                  })
                  .catch(() => {
                    setPicked(null);
                    setPickError('The customer details could not be read. The Bill To details were not changed. Try again.');
                  });
              }}
              onAdd={(typed) => setAdding({ name: typed.trim(), type: b.type })}
            />
            <p role="status" className={picked ? 'm-0 -mt-2 text-sm text-copy' : 'sr-only'}>
              {picked ?? ''}
            </p>
            {pickError ? (
              <p role="alert" className="m-0 -mt-2 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                {pickError}
              </p>
            ) : null}
            <AddCustomerDialog
              open={adding !== null}
              onOpenChange={(o) => {
                if (!o) setAdding(null);
              }}
              create={parties.create}
              dealId={view.dealId}
              initial={adding ?? { name: '', type: b.type }}
              onCreated={(p) => {
                f.setValues(billToFromParty(p));
                setParty({ id: p.partyId, status: p.checkStatus, name: p.name });
                setAdding(null);
                setEditing(false);
                setPicked(`${p.name} added to the customer list (Not checked) and filled in.`);
              }}
            />
          </>
        ) : editable ? (
          <ClientLookup
            onPick={(entry) => {
              const { billTo: next, outsideIndia } = billToFromCustomer(entry, GST_STATES);
              f.setValues(next);
              setSelection({ id: entry.id, edited: false });
              return outsideIndia;
            }}
            selection={selection}
            onClear={() => {
              f.setValues(emptyBillTo(b.type));
              setSelection(null);
            }}
          />
        ) : null}
        <form ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="billTo-heading" className="flex flex-col gap-4">
          <HiddenDraftInputs view={view} base={f.base} result={f.state} extra={{ billingRowVersion: billingRv, billToType: b.type, ...(parties ? { partyId: party?.id ?? '' } : {}) }} />
          {parties && !showFields ? (
            b.name.trim() ? (
              <BillToSummary b={b} party={party} stateName={stateName} onEdit={editable ? () => setEditing(true) : null} />
            ) : (
              <p className="m-0 text-quiet">
                No customer chosen yet.{' '}
                {editable ? (
                  <Button variant="link" size="sm" onClick={() => setEditing(true)}>
                    Type the details instead
                  </Button>
                ) : null}
              </p>
            )
          ) : null}
          <div hidden={!showFields} className={cn('flex flex-col gap-5', !showFields && 'hidden')}>
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl<BillToType>
              id={F.billToType}
              label="Customer type"
              options={[
                { value: 'personal', label: 'Personal' },
                { value: 'business', label: 'Business' },
              ]}
              value={b.type}
              disabled={!editable}
              onChange={(t) => {
                f.setValues((s) => switchBillToType(s, t));
                setSelection(null);
              }}
            />
            {b.type === 'personal' && editable ? (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  f.setValues((s) => ({ ...s, name: contact.name, phone: contact.phone, email: contact.email }));
                  setSelection(null);
                }}
              >
                Use booking contact
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
            <TextField id={F.billingName} name="billingName" label={business ? 'Company name' : 'Full name'} value={b.name} onChange={(x) => set('name', x)} error={err('billingName')} maxLength={200} disabled={!editable} />
            {business ? <TextField id={F.contactPerson} name="contactPerson" label="Contact name" value={b.contactPerson} onChange={(x) => set('contactPerson', x)} error={err('contactPerson')} maxLength={120} disabled={!editable} /> : null}
            <TextField id={F.billingPhone} name="billingPhone" label="Phone" type="tel" inputMode="tel" value={b.phone} onChange={(x) => set('phone', x)} error={err('billingPhone')} maxLength={16} disabled={!editable} />
            <TextField id={F.billingEmail} name="billingEmail" label="Email" optional type="email" inputMode="email" value={b.email} onChange={(x) => set('email', x)} error={err('billingEmail')} maxLength={254} disabled={!editable} />
          </div>
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
            <TextField id={F.addressLine1} name="addressLine1" label="Address" value={b.addressLine1} onChange={(x) => set('addressLine1', x)} error={err('addressLine1')} maxLength={200} autoComplete="address-line1" disabled={!editable} className="min-[381px]:col-span-2" />
            <TextField id={F.billingCity} name="billingCity" label="City" value={b.city} onChange={(x) => set('city', x)} error={err('billingCity')} maxLength={120} disabled={!editable} />
            <SelectField
              id={F.stateCode}
              name="stateCode"
              label="State"
              value={b.stateCode}
              onChange={(x) => set('stateCode', x)}
              options={[{ value: '', label: 'Choose the state' }, ...GST_STATES.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))]}
              error={err('stateCode')}
              disabled={!editable}
            />
            <TextField id={F.postalCode} name="postalCode" label="PIN code" inputMode="numeric" value={b.postalCode} onChange={(x) => set('postalCode', x)} error={err('postalCode')} maxLength={6} autoComplete="postal-code" disabled={!editable} />
            {b.addressLine2 ? <input type="hidden" name="addressLine2" value={b.addressLine2} /> : null}
          </div>
          {business ? (
            <div className="flex flex-col gap-4">
              <SelectField
                id={F.gstStatus}
                name="gstStatus"
                label="GST registration"
                value={b.gstStatus}
                onChange={(x) => f.setValues((s) => ({ ...s, gstStatus: x as GstStatus | '', gstin: x === 'registered' ? s.gstin : '', gstReason: x === 'unregistered' ? s.gstReason : '' }))}
                options={[
                  { value: '', label: 'Choose' },
                  { value: 'registered', label: 'GST registered' },
                  { value: 'unregistered', label: 'Not GST registered' },
                ]}
                error={err('gstStatus')}
                disabled={!editable}
              />
              {b.gstStatus === 'registered' ? (
                <TextField id={F.gstin} name="gstin" label="GSTIN" hint="Accounts checks it. The CRM checks the format only." value={b.gstin} onChange={(x) => set('gstin', x.toUpperCase())} error={err('gstin')} maxLength={15} disabled={!editable} />
              ) : null}
              {b.gstStatus === 'unregistered' ? (
                <TextField id={F.gstReason} name="gstReason" label="Reason for no GSTIN" value={b.gstReason} onChange={(x) => set('gstReason', x)} error={err('gstReason')} maxLength={500} disabled={!editable} />
              ) : null}
            </div>
          ) : null}
          </div>
          <InlineNote>Accounts checks billing details before use.</InlineNote>
          {save.state === 'fix' && save.reason ? (
            <p id="why-billTo" className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
              <span>{save.reason}</span>
            </p>
          ) : null}
        </form>
      </SectionBody>
    </SectionCard>
  );
}

/** "Find an existing client" over a list opened in this tab only (contract §2.11). */
function ClientLookup({ onPick, selection, onClear }: { onPick: (entry: CustomerListEntry) => boolean; selection: { id: string; edited: boolean } | null; onClear: () => void }) {
  const [list, setList] = useState<CustomerListEntry[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'status' | 'alert' } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const result = searchCustomerList(list, query);
  const showResults = open && query.trim().length >= CUSTOMER_LIST_MIN_QUERY && list.length > 0;
  const load = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > CUSTOMER_LIST_MAX_BYTES) {
      setMessage({ text: `${CUSTOMER_LIST_TEXT.tooLarge} ${list.length ? CUSTOMER_LIST_TEXT.unchanged : ''}`.trim(), tone: 'alert' });
      return;
    }
    try {
      const rows = readCustomerListText(await file.text(), file.size);
      setList(rows);
      setMessage({ text: CUSTOMER_LIST_TEXT.opened(rows.length), tone: 'status' });
    } catch (error) {
      const text = error instanceof CustomerListError ? error.message : CUSTOMER_LIST_TEXT.notJson;
      setMessage({ text: `${text} ${list.length ? CUSTOMER_LIST_TEXT.unchanged : ''}`.trim(), tone: 'alert' });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-3 max-sm:flex-col max-sm:items-stretch">
        <Field htmlFor="bf-client-search" label="Find an existing client" className="min-w-0 flex-1">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.75 size-4 -translate-y-1/2 text-quiet" />
            <Input
              id="bf-client-search"
              type="search"
              role="searchbox"
              placeholder="Name, company, phone or GSTIN"
              autoComplete="off"
              aria-controls={showResults ? "bf-client-results" : undefined}
              value={query}
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              className="pl-8.5"
            />
          </div>
        </Field>
        <Button size="sm" className="h-10 max-sm:self-start" onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden="true" />
          Open customer list
        </Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={load} />
      </div>
      <p role={message?.tone === 'alert' ? 'alert' : 'status'} className={cn('m-0 text-sm', message?.tone === 'alert' ? 'font-medium text-status-danger' : 'text-quiet')}>
        {message ? message.text : list.length === 0 ? 'No customer list open. Open one, or enter the details below.' : ''}
      </p>
      {showResults ? (
        <div id="bf-client-results" aria-label="Matching clients" role="group" className="max-h-65 overflow-auto rounded-control border border-line-strong">
          {result.total === 0 ? (
            <p className="m-0 p-3 text-quiet">{CUSTOMER_LIST_TEXT.noMatch}</p>
          ) : (
            <>
              {result.matches.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    const outside = onPick(row);
                    setOpen(false);
                    setQuery('');
                    setMessage(outside ? { text: CUSTOMER_LIST_TEXT.outsideIndia, tone: 'alert' } : null);
                    requestAnimationFrame(() => document.getElementById(F.billingName)?.focus());
                  }}
                  className={cn('flex w-full cursor-pointer flex-col gap-1 border-0 border-b border-line bg-card p-3 text-left wrap-anywhere last:border-b-0 hover:bg-brand-tint', focusRing, '-outline-offset-2')}
                >
                  <strong className="font-semibold text-ink">{row.name}</strong>
                  <span className="text-sm text-quiet">{[row.id, row.type === 'business' ? 'Business' : 'Personal', row.phone || row.email, row.gstin].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
              {result.total > result.matches.length ? <p className="m-0 p-3 text-quiet">{CUSTOMER_LIST_TEXT.tooMany(result.total)}</p> : null}
            </>
          )}
        </div>
      ) : null}
      {selection ? (
        <div className="mt-[0.25rem] flex items-center justify-between gap-3 rounded-chip bg-brand-tint px-3 py-2 text-sm wrap-anywhere" role="status">
          <span>{selection.edited ? `Client details edited for this booking · ${selection.id}` : `Client selected · ${selection.id}`}</span>
          <Button variant="ghost" size="sm" aria-label="Clear selected client" onClick={onClear}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The card's checks before it saves (prototype billIssues, live CRM wording). */
export function billToIssues(b: BillToInput): string[] {
  const o: string[] = [];
  if (!b.name.trim()) o.push('Enter the Bill To name.');
  if (b.type === 'business' && !b.contactPerson.trim()) o.push('Add the contact name at the business.');
  if (!b.phone.trim()) o.push('Check the billing phone number.');
  if (!b.addressLine1.trim()) o.push('Add the billing address.');
  if (!b.city.trim()) o.push('Add the city.');
  if (!b.stateCode.trim()) o.push('Choose the state.');
  if (!/^[1-9]\d{5}$/.test(b.postalCode.replace(/\s/g, ''))) o.push('Enter a six-digit PIN code that does not start with 0.');
  if (b.type === 'business' && !b.gstStatus) o.push('Choose whether the business is GST registered.');
  return o;
}

/** A stored customer's details as billing values (the booking keeps this copy; the reference goes with it). */
export function billToFromParty(p: PartyOption): BillToInput {
  return {
    type: p.type,
    name: p.name,
    contactPerson: p.contactPerson ?? '',
    phone: p.phone ?? '',
    email: p.email ?? '',
    addressLine1: p.addressLine1,
    addressLine2: p.addressLine2 ?? '',
    city: p.city,
    stateCode: p.stateCode,
    postalCode: p.postalCode,
    gstStatus: p.type === 'business' ? (p.gstStatus ?? '') : '',
    gstin: p.type === 'business' ? (p.gstin ?? '') : '',
    gstReason: p.type === 'business' ? (p.gstReason ?? '') : '',
  };
}

/** The chosen billing in a few lines, with "Edit details" (the full form stays out of the way). */
function BillToSummary({ b, party, stateName, onEdit }: { b: BillToInput; party: { id: string; status: PartyCheckStatus | null; name: string } | null; stateName: (code: string) => string; onEdit: (() => void) | null }) {
  const business = b.type === 'business';
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-4 max-sm:p-3" data-slot="bill-to-summary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 font-semibold wrap-anywhere text-ink">{b.name}</p>
          <p className="m-0 text-sm text-quiet">
            {business ? 'Business' : 'Personal'}
            {party ? ' · from the customer list' : ' · typed for this booking'}
          </p>
          {party?.status ? <PartyStatus status={party.status} /> : null}
        </div>
        {onEdit ? (
          <Button variant="secondary" size="sm" className="min-h-10" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            Edit details
          </Button>
        ) : null}
      </div>
      <SummaryList>
        {business ? <SummaryRow label="Contact name">{b.contactPerson || <NotEntered />}</SummaryRow> : null}
        <SummaryRow label="Phone · Email">{[b.phone, b.email].filter(Boolean).join(' · ') || <NotEntered />}</SummaryRow>
        <SummaryRow label="Address">{[b.addressLine1, b.addressLine2, b.city, b.stateCode ? stateName(b.stateCode) : '', b.postalCode, 'India'].filter(Boolean).join(', ') || <NotEntered />}</SummaryRow>
        {business ? (
          <SummaryRow label="GST registration">{b.gstStatus === 'registered' ? `GST registered · ${b.gstin}` : b.gstStatus === 'unregistered' ? `Not GST registered · ${b.gstReason}` : <NotEntered />}</SummaryRow>
        ) : null}
      </SummaryList>
    </div>
  );
}
