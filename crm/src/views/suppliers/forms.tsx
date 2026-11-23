'use client';

import { Link2, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, refusalMessage, useDeskCommand, useRefusedControl, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { duplicateText, KIND_LABEL, SERVICE_LABEL } from './labels';
import type { CatalogueHotelOption, CatalogueHotelSearch, SupplierContactView, SupplierDuplicate, SupplierHotelLinkView, SupplierKind, SupplierMaster, SupplierServiceType } from './types';

/*
 * Supplier client forms (Accounts phase 2 contract 5.5 A1–A7, 11.9).
 * Every action arrives as a prop (the route passes track A's server action,
 * the preview gallery a stub); form field names follow Addendum L3. One
 * request id per form, renewed only after a confirmed success. A refusal
 * keeps every typed value, marks the field it names and focuses it.
 * Near-duplicate warnings never block: they come back with the save.
 */

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PHONE_RE = /^[0-9+() -]{6,40}$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

export interface SupplierFormActions {
  /** A1 supplier_create / A3 flight_supplier_create. */
  create?: DecisionAction;
  /** A2 supplier_update / A3 flight_supplier_update. */
  update?: DecisionAction;
  /** A4 supplier_contact_save. */
  saveContact?: DecisionAction;
  /** A5 supplier_contact_remove. */
  removeContact?: DecisionAction;
  /** A6 supplier_hotel_link. */
  linkHotel?: DecisionAction;
  /** A7 supplier_hotel_unlink. */
  unlinkHotel?: DecisionAction;
}

type States = ReadonlyArray<{ code: string; name: string }>;

interface DetailValues {
  entityId: string;
  name: string;
  supplierKind: SupplierKind;
  serviceTypes: SupplierServiceType[];
  city: string;
  stateCode: string;
  gstin: string;
  pan: string;
  address: string;
  paymentTerms: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  archived: boolean;
}

/** Field checks the database repeats (it decides); returns field → message. */
export function supplierDetailProblems(v: Pick<DetailValues, 'name' | 'serviceTypes' | 'gstin' | 'pan' | 'stateCode' | 'contactPhone' | 'contactEmail'>, needServices: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  const gstin = v.gstin.trim().toUpperCase();
  const pan = v.pan.trim().toUpperCase();
  if (!v.name.trim()) p.name = 'Enter the supplier’s name.';
  if (needServices && v.serviceTypes.length === 0) p.serviceTypes = 'Choose at least one service.';
  if (gstin && !GSTIN_RE.test(gstin)) p.gstin = 'A GSTIN has 15 characters, like 08ABCDE1234F1Z5.';
  if (pan && !PAN_RE.test(pan)) p.pan = 'A PAN has 10 characters, like ABCDE1234F.';
  if (!p.gstin && !p.pan && gstin && pan && gstin.slice(2, 12) !== pan) p.pan = 'This PAN does not match the GSTIN (characters 3 to 12 of the GSTIN).';
  if (!p.gstin && gstin && v.stateCode && gstin.slice(0, 2) !== v.stateCode) p.stateCode = `The GSTIN starts with ${gstin.slice(0, 2)}: choose that state.`;
  if (v.contactPhone.trim() && !PHONE_RE.test(v.contactPhone.trim())) p.contactPhone = 'Digits, spaces, +, ( ) or -; at least 6.';
  if (v.contactEmail.trim() && !EMAIL_RE.test(v.contactEmail.trim())) p.contactEmail = 'Enter an e-mail address like name@example.com.';
  return p;
}

/** The warnings a save returned (contract 5.7): `data.warnings`. */
function warningsOf(r: DeskResult | null): SupplierDuplicate[] {
  if (!r?.ok) return [];
  const w = (r.data as { warnings?: unknown } | undefined)?.warnings;
  return Array.isArray(w) ? (w as SupplierDuplicate[]) : [];
}

export function DuplicateWarnings({ items, tail, title }: { items: SupplierDuplicate[]; tail?: string; title?: string }) {
  if (items.length === 0) return null;
  return (
    <Notice tone="warning" title={title ?? 'Possible duplicate supplier'}>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        {items.map((d) => (
          <li key={d.supplierId}>
            <a href={`/app/purchase/suppliers/${d.supplierId}`} className="font-medium text-brand-strong underline underline-offset-4">
              {duplicateText(d, tail)}
            </a>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1.5 text-sm">This is a warning only. Nothing was merged.</p>
    </Notice>
  );
}

/**
 * Add or edit a supplier's details: kind, services, city, state, GSTIN, PAN,
 * address, payment terms (create also takes the first contact). A change of
 * name, kind, GSTIN, PAN or state makes the supplier "Not verified" again.
 */
export function SupplierDetailsForm({
  mode,
  action,
  supplier,
  entities = [],
  states,
  serviceChoices,
  initialState,
}: {
  mode: 'create' | 'edit';
  action: DecisionAction;
  supplier?: SupplierMaster;
  entities?: Array<{ id: string; name: string }>;
  states: States;
  /** Purchase: hotel, transfer, activity. Flight: flight only (fixed). */
  serviceChoices: SupplierServiceType[];
  /** Preview gallery: start with this result on screen. */
  initialState?: DeskResult | null;
}) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const summaryId = `${base}-summary`;
  const refused = cmd.state && !cmd.state.ok ? cmd.state : null;
  const target = useRefusedControl(form, refused, summaryId);
  const fixedService = serviceChoices.length === 1;
  const blank: DetailValues = {
    entityId: entities[0]?.id ?? '',
    name: '',
    supplierKind: 'direct',
    serviceTypes: fixedService ? [...serviceChoices] : [],
    city: '',
    stateCode: '',
    gstin: '',
    pan: '',
    address: '',
    paymentTerms: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    archived: false,
  };
  const [v, setV] = useState<DetailValues>(() =>
    supplier
      ? {
          ...blank,
          name: supplier.name,
          supplierKind: supplier.kind,
          serviceTypes: [...supplier.serviceTypes],
          city: supplier.city ?? '',
          stateCode: supplier.stateCode ?? '',
          gstin: supplier.gstin ?? '',
          // A masked PAN is never sent back: the field starts empty and "empty" keeps the stored PAN.
          pan: supplier.pan && !supplier.pan.includes('X') ? supplier.pan : '',
          address: supplier.address ?? '',
          paymentTerms: supplier.paymentTerms ?? '',
          archived: supplier.status === 'archived',
        }
      : blank,
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const set = <K extends keyof DetailValues>(k: K) => (x: DetailValues[K]) => setV((o) => ({ ...o, [k]: x }));
  const panMasked = supplier?.pan?.includes('X') ? supplier.pan : null;
  const warnings = warningsOf(cmd.state);
  const [seen, setSeen] = useState(cmd.state);
  if (cmd.state !== seen) {
    setSeen(cmd.state);
    // A new supplier: clear the form for the next one (the warnings stay above it).
    if (cmd.state?.ok && mode === 'create') setV(blank);
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const p = supplierDetailProblems(v, !fixedService);
    setProblems(p);
    const first = Object.keys(p)[0];
    if (first) {
      e.preventDefault();
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    cmd.submit(e);
  };
  const err = (k: string) => problems[k] ?? null;
  const textField = (k: 'name' | 'city' | 'gstin' | 'pan' | 'contactName' | 'contactPhone' | 'contactEmail', label: string, opts: { hint?: string; optional?: boolean; maxLength: number; inputMode?: 'tel' | 'email'; upper?: boolean } ) => (
    <Field htmlFor={`${base}-${k}`} label={label} hint={opts.hint} error={err(k)} optional={opts.optional}>
      <Input
        id={`${base}-${k}`}
        name={k}
        value={v[k]}
        onChange={(e) => set(k)(opts.upper ? e.target.value.toUpperCase() : e.target.value)}
        maxLength={opts.maxLength}
        inputMode={opts.inputMode}
        autoComplete="off"
        spellCheck={false}
        invalid={!!err(k)}
        aria-describedby={fieldDescribedBy(`${base}-${k}`, { hint: opts.hint, error: err(k) })}
      />
    </Field>
  );

  return (
    <form ref={setForm} noValidate onSubmit={onSubmit} aria-label={mode === 'create' ? 'Add a supplier' : `Edit ${supplier?.name ?? 'supplier'}`} className="flex flex-col gap-4">
      {refused ? (
        <div id={summaryId}>
          <ErrorSummary title="Nothing was saved" description={refusalMessage(refused)} focusOnMount={!target} items={target ? [{ fieldId: target.id, text: `Check: ${target.label}` }] : []}>
            <p className="m-0 mt-[0.25rem] text-sm">What you typed is still here.</p>
          </ErrorSummary>
        </div>
      ) : cmd.state?.ok ? (
        <DeskResultLine state={cmd.state} okTitle={mode === 'create' ? 'Supplier added' : 'Saved'} />
      ) : (
        <div role="status" aria-live="polite" className="contents" />
      )}
      <DuplicateWarnings items={warnings} tail={mode === 'create' ? 'check it is not the same supplier' : 'check it is not the same supplier'} title="Saved, but it looks like a supplier you already have" />
      <input type="hidden" name="requestId" value={cmd.requestId} />
      {supplier ? (
        <>
          <input type="hidden" name="supplierId" value={supplier.supplierId} />
          <input type="hidden" name="expectedRowVersion" value={supplier.rowVersion} />
        </>
      ) : null}
      {mode === 'create' && entities.length > 1 ? (
        <Field htmlFor={`${base}-entityId`} label="Company">
          <Select id={`${base}-entityId`} name="entityId" value={v.entityId} onChange={(e) => set('entityId')(e.target.value)}>
            {entities.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : mode === 'create' ? (
        <input type="hidden" name="entityId" value={v.entityId} />
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {textField('name', 'Name', { maxLength: 200 })}
        {textField('city', 'City', { maxLength: 120, optional: true })}
      </div>
      <ChoiceGroup id={`${base}-kind`} legend="Kind" hint="Agents and booking channels are checked like any other supplier.">
        {(['direct', 'channel'] as const).map((k) => (
          <Radio key={k} id={`${base}-kind-${k}`} name="supplierKind" value={k} label={KIND_LABEL[k]} checked={v.supplierKind === k} onChange={() => set('supplierKind')(k)} />
        ))}
      </ChoiceGroup>
      {fixedService ? (
        <input type="hidden" name="serviceTypes" value={serviceChoices[0]} />
      ) : (
        <ChoiceGroup id={`${base}-serviceTypes`} legend="Services" error={err('serviceTypes')}>
          {serviceChoices.map((s, i) => (
            <Checkbox
              key={s}
              id={i === 0 ? `${base}-serviceTypes` : `${base}-serviceTypes-${s}`}
              name="serviceTypes"
              value={s}
              label={SERVICE_LABEL[s]}
              checked={v.serviceTypes.includes(s)}
              invalid={!!err('serviceTypes')}
              onChange={(e) => set('serviceTypes')(e.target.checked ? [...v.serviceTypes, s] : v.serviceTypes.filter((x) => x !== s))}
            />
          ))}
        </ChoiceGroup>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {textField('gstin', 'GSTIN', { maxLength: 15, optional: true, upper: true, hint: '15 characters. Leave empty if the supplier has none.' })}
        {textField('pan', 'PAN', {
          maxLength: 10,
          optional: true,
          upper: true,
          hint: panMasked ? `On file: ${panMasked}. Leave empty to keep it.` : '10 characters. Must match the GSTIN when both are given.',
        })}
        <Field htmlFor={`${base}-stateCode`} label="State" optional error={err('stateCode')}>
          <Select id={`${base}-stateCode`} name="stateCode" value={v.stateCode} onChange={(e) => set('stateCode')(e.target.value)} invalid={!!err('stateCode')} aria-describedby={fieldDescribedBy(`${base}-stateCode`, { error: err('stateCode') })}>
            <option value="">Not set</option>
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field htmlFor={`${base}-address`} label="Address" optional>
        <Textarea id={`${base}-address`} name="address" value={v.address} onChange={(e) => set('address')(e.target.value)} maxLength={300} rows={2} />
      </Field>
      <Field htmlFor={`${base}-paymentTerms`} label="Payment terms" optional>
        <Textarea id={`${base}-paymentTerms`} name="paymentTerms" value={v.paymentTerms} onChange={(e) => set('paymentTerms')(e.target.value)} maxLength={1000} rows={2} />
      </Field>
      {mode === 'create' ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 text-base font-semibold text-ink">First contact (optional)</legend>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {textField('contactName', 'Contact person', { maxLength: 120, optional: true })}
            {textField('contactPhone', 'Phone', { maxLength: 40, optional: true, inputMode: 'tel' })}
            {textField('contactEmail', 'E-mail', { maxLength: 254, optional: true, inputMode: 'email' })}
          </div>
        </fieldset>
      ) : (
        <>
          <input type="hidden" name="status" value={v.archived ? 'archived' : 'active'} />
          <Checkbox id={`${base}-archived`} label="Archived" description="An archived supplier cannot be chosen for new rates." checked={v.archived} onChange={(e) => set('archived')(e.target.checked)} />
        </>
      )}
      {mode === 'edit' ? <p className="m-0 text-sm text-quiet">Changing the name, kind, GSTIN, PAN or state makes the supplier “Not verified” until a Manager checks it again.</p> : null}
      <div>
        <Button
          type="submit"
          variant={mode === 'create' ? 'secondary' : 'primary'}
          aria-disabled={cmd.pending || undefined}
          onClick={(e) => {
            if (cmd.pending) e.preventDefault();
          }}
        >
          {cmd.pending ? 'Saving…' : mode === 'create' ? 'Add supplier' : 'Save details'}
        </Button>
      </div>
    </form>
  );
}

/** A button that opens one DeskDialog; the result line shows under it after a success. */
function DialogButton({
  label,
  srLabel,
  icon,
  variant = 'secondary',
  initialOpen,
  children,
}: {
  label: string;
  srLabel?: string;
  icon?: ReactNode;
  variant?: 'secondary' | 'ghost';
  initialOpen?: boolean;
  children: (ctx: { open: boolean; setOpen: (o: boolean) => void; done: (r: DeskResult) => void; opener: RefObject<HTMLButtonElement | null> }) => ReactNode;
}) {
  const [open, setOpen] = useState(!!initialOpen);
  const [result, setResult] = useState<DeskResult | null>(null);
  // A callback ref kept in state (not a ref object read during render); the dialog returns focus here.
  const [openerEl, setOpenerEl] = useState<HTMLButtonElement | null>(null);
  const opener = { current: openerEl };
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <Button ref={setOpenerEl} type="button" variant={variant} size="sm" onClick={() => setOpen(true)}>
        {icon}
        {label}
        {srLabel ? <span className="sr-only"> {srLabel}</span> : null}
      </Button>
      {result ? <DeskResultLine state={result} /> : null}
      {open ? children({ open, setOpen, done: (r) => { setResult(r); setOpen(false); }, opener }) : null}
    </span>
  );
}

export function ContactDialog({
  supplierId,
  contact,
  action,
  hasPrimary,
  initialOpen,
  initialState,
}: {
  supplierId: string;
  contact?: SupplierContactView;
  action: DecisionAction;
  hasPrimary: boolean;
  initialOpen?: boolean;
  initialState?: DeskResult | null;
}) {
  const base = useId();
  const editing = !!contact;
  return (
    <DialogButton label={editing ? 'Edit' : 'Add a contact'} srLabel={editing ? contact.name : undefined} icon={editing ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />} variant={editing ? 'ghost' : 'secondary'} initialOpen={initialOpen}>
      {({ open, setOpen, done, opener }) => (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title={editing ? `Edit contact ${contact.name}` : 'Add a contact'}
          description="A phone number or an e-mail address is needed. The primary contact is the one rates and booking e-mails go to."
          primaryLabel={editing ? 'Save contact' : 'Add contact'}
          pendingLabel="Saving…"
          action={action}
          initialState={initialState}
          onDone={done}
          returnFocus={opener}
        >
          {({ requestId }) => (
            <>
              <input type="hidden" name="supplierId" value={supplierId} />
              <input type="hidden" name="requestId" value={requestId} />
              {contact ? <input type="hidden" name="contactId" value={contact.contactId} /> : null}
              <input type="hidden" name="expectedRowVersion" value={contact?.rowVersion ?? 0} />
              <Field htmlFor={`${base}-name`} label="Name">
                <Input id={`${base}-name`} name="name" defaultValue={contact?.name ?? ''} maxLength={120} autoComplete="off" required />
              </Field>
              <Field htmlFor={`${base}-roleLabel`} label="Role" optional hint="For example “Reservations” or “Accounts”.">
                <Input id={`${base}-roleLabel`} name="roleLabel" defaultValue={contact?.roleLabel ?? ''} maxLength={60} autoComplete="off" aria-describedby={`${base}-roleLabel-hint`} />
              </Field>
              <Field htmlFor={`${base}-phone`} label="Phone" optional>
                <Input id={`${base}-phone`} name="phone" defaultValue={contact?.phone ?? ''} maxLength={40} inputMode="tel" autoComplete="off" />
              </Field>
              <Field htmlFor={`${base}-email`} label="E-mail" optional>
                <Input id={`${base}-email`} name="email" defaultValue={contact?.email ?? ''} maxLength={254} type="email" autoComplete="off" />
              </Field>
              <PrimaryChoice id={`${base}-isPrimary`} initial={contact?.isPrimary ?? !hasPrimary} lockedOn={!!contact?.isPrimary} />
            </>
          )}
        </DeskDialog>
      )}
    </DialogButton>
  );
}

function PrimaryChoice({ id, initial, lockedOn }: { id: string; initial: boolean; lockedOn: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <>
      <input type="hidden" name="isPrimary" value={on ? 'true' : 'false'} />
      <Checkbox
        id={id}
        label="Primary contact"
        description={lockedOn ? 'This is the primary contact. Make another contact primary to change it.' : 'The current primary contact stops being primary.'}
        checked={on}
        aria-disabled={lockedOn || undefined}
        onChange={(e) => {
          if (!lockedOn) setOn(e.target.checked);
        }}
      />
    </>
  );
}

function ReasonField({ id, label = 'Reason', min = 10, max = 300 }: { id: string; label?: string; min?: number; max?: number }) {
  return (
    <Field htmlFor={id} label={label} hint={`${min} to ${max} characters, kept in the history.`}>
      <Textarea id={id} name="reason" minLength={min} maxLength={max} rows={3} required aria-describedby={`${id}-hint`} />
    </Field>
  );
}

export function RemoveContactDialog({ contact, action, isOnlyContact, initialOpen, initialState }: { contact: SupplierContactView; action: DecisionAction; isOnlyContact: boolean; initialOpen?: boolean; initialState?: DeskResult | null }) {
  const base = useId();
  return (
    <DialogButton label="Remove" srLabel={contact.name} icon={<Trash2 aria-hidden="true" />} variant="ghost" initialOpen={initialOpen}>
      {({ open, setOpen, done, opener }) => (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title={`Remove contact ${contact.name}?`}
          description={
            contact.isPrimary
              ? isOnlyContact
                ? 'This is the only contact. The supplier will have no contact person until you add one.'
                : 'This is the primary contact. Make another contact primary first, or the supplier will have no primary contact.'
              : 'The contact stays in the history. Removing cannot be undone; add the person again if needed.'
          }
          primaryLabel="Remove contact"
          pendingLabel="Removing…"
          cancelLabel="Keep the contact"
          danger
          action={action}
          initialState={initialState}
          onDone={done}
          returnFocus={opener}
        >
          {({ requestId }) => (
            <>
              <input type="hidden" name="contactId" value={contact.contactId} />
              <input type="hidden" name="expectedRowVersion" value={contact.rowVersion} />
              <input type="hidden" name="requestId" value={requestId} />
              <ReasonField id={`${base}-reason`} />
            </>
          )}
        </DeskDialog>
      )}
    </DialogButton>
  );
}

export function LinkHotelDialog({ supplierId, action, searchHotels, initialOpen, initialState }: { supplierId: string; action: DecisionAction; searchHotels: CatalogueHotelSearch; initialOpen?: boolean; initialState?: DeskResult | null }) {
  const base = useId();
  return (
    <DialogButton label="Link a hotel" icon={<Link2 aria-hidden="true" />} initialOpen={initialOpen}>
      {({ open, setOpen, done, opener }) => (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title="Link a hotel this supplier sells"
          description="Choose the hotel from the hotel list. One hotel can be sold by several suppliers."
          primaryLabel="Link hotel"
          pendingLabel="Linking…"
          action={action}
          initialState={initialState}
          onDone={done}
          returnFocus={opener}
        >
          {({ requestId }) => <HotelPick id={`${base}-hotel`} supplierId={supplierId} requestId={requestId} search={searchHotels} />}
        </DeskDialog>
      )}
    </DialogButton>
  );
}

function HotelPick({ id, supplierId, requestId, search }: { id: string; supplierId: string; requestId: string; search: CatalogueHotelSearch }) {
  const [text, setText] = useState('');
  const [hotelId, setHotelId] = useState('');
  return (
    <>
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field htmlFor={id} label="Hotel" hint={hotelId ? 'Chosen from the hotel list.' : 'Type 2 letters, then choose from the list.'}>
        <SearchCombobox<CatalogueHotelOption>
          id={id}
          value={text}
          placeholder="Type 2 letters to search"
          onValueChange={(x) => {
            setText(x);
            setHotelId('');
          }}
          search={search}
          keyOf={(h) => h.hotelId}
          textOf={(h) => [h.name, h.city, h.area, h.category].filter(Boolean).join(', ')}
          renderOption={(h) => (
            <>
              <span className="font-semibold text-ink">{h.name}</span>
              <span className="text-sm text-quiet">{[h.city, h.area, h.category].filter(Boolean).join(' · ')}</span>
            </>
          )}
          onPick={(h) => {
            setText(h.name);
            setHotelId(h.hotelId);
          }}
          noMatchText="Not in the hotel list. A Super Admin adds hotels through Settings › Imports."
          maxLength={200}
          aria-describedby={`${id}-hint`}
        />
      </Field>
      {/* The command needs a catalogue hotel; an unpicked name sends an empty id and is refused with the hint "hotelId". */}
      <input type="hidden" id={`${id}-id`} name="hotelId" value={hotelId} />
    </>
  );
}

export function UnlinkHotelDialog({ link, action, initialOpen, initialState }: { link: SupplierHotelLinkView; action: DecisionAction; initialOpen?: boolean; initialState?: DeskResult | null }) {
  const base = useId();
  return (
    <DialogButton label="Remove link" srLabel={link.name} icon={<Trash2 aria-hidden="true" />} variant="ghost" initialOpen={initialOpen}>
      {({ open, setOpen, done, opener }) => (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title={`Stop listing ${link.name} for this supplier?`}
          description="Existing rates and bookings stay as they are. The link stays in the history."
          primaryLabel="Remove link"
          pendingLabel="Removing…"
          cancelLabel="Keep the link"
          danger
          action={action}
          initialState={initialState}
          onDone={done}
          returnFocus={opener}
        >
          {({ requestId }) => (
            <>
              <input type="hidden" name="linkId" value={link.linkId} />
              <input type="hidden" name="requestId" value={requestId} />
              <ReasonField id={`${base}-reason`} />
            </>
          )}
        </DeskDialog>
      )}
    </DialogButton>
  );
}

/** Contact row icon (server views import it from here to keep one look). */
export function ContactIcon() {
  return <UserRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />;
}
