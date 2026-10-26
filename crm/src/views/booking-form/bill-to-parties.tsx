'use client';

import { CircleAlert, CircleCheck, Clock, Lock, UserPlus } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { EVIDENCE_MIME_TYPES } from '@/modules/fulfilment/contracts';
import type { BillToType } from '@/modules/fulfilment/booking-form-contract';
import { guard } from '../booking-forms';
import { newRequestId, ResultBox, type FieldRef, type UiResult } from '../b11/form-kit';
import { normaliseResult } from '../b11/result';
import type { B11Action } from '../b11/shapes';
import { emptyParty, PARTY_ERROR_TEXT, PartyFields, partyProblems, PartyTypeSwitch, type PartyValues } from './party-fields';
import { PARTY_STATUS_LABEL, type PartyActions, type PartyCheckStatus, type PartyOption } from './vn-types';

/*
 * Bill To, voice-note batch (owner item 9): search the stored customers
 * first; picking one fills the billing details (the booking keeps its own
 * copy, plus the customer's reference). When nobody matches, "Add customer"
 * opens a dialog with Personal and Business. A new customer starts "Not
 * checked"; Accounts checks it in the CRM. Files (personal ID, business
 * documents) are private; a chosen file is not shown as attached until the
 * save succeeded.
 * 21st.dev: "Combobox" (shugar 4032) for the search-then-pick list and
 * "File Upload" (ephraimduncan 4354) for the compact file list; nothing copied.
 */

const FILE_MAX_BYTES = 4 * 1024 * 1024;
const DOCUMENTS_MAX = 3;

const STATUS_ICON: Record<PartyCheckStatus, typeof CircleCheck> = { not_checked: Clock, checked: CircleCheck, returned: CircleAlert };

/** "Not checked" / "Checked by Accounts" / "Returned" in words with an icon (never colour alone). */
export function PartyStatus({ status }: { status: PartyCheckStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="inline-flex items-center gap-1 text-sm text-quiet">
      <Icon aria-hidden="true" className={status === 'checked' ? 'size-3.5 text-status-success' : status === 'returned' ? 'size-3.5 text-status-warning' : 'size-3.5 text-faint'} />
      {PARTY_STATUS_LABEL[status]}
    </span>
  );
}

/** Search box over stored customers, with "Add customer" beside it. */
export function PartyPicker({ parties, onPick, onAdd, label = 'Find customer' }: { parties: PartyActions; onPick: (p: PartyOption) => void; onAdd: (typed: string) => void; label?: string }) {
  const [query, setQuery] = useState('');
  return (
    <div className="flex flex-col gap-1.5">
    <div className="flex items-end gap-3 max-sm:flex-col max-sm:items-stretch">
      <Field htmlFor="bf-party-search" label={label} className="min-w-0 flex-1">
        <SearchCombobox<PartyOption>
          id="bf-party-search"
          value={query}
          onValueChange={setQuery}
          search={(q) => parties.search(q)}
          keyOf={(p) => p.partyId}
          textOf={(p) => [p.name, p.type === 'business' ? 'Business' : 'Personal', p.city, p.phone ?? p.email, p.gstin, PARTY_STATUS_LABEL[p.checkStatus]].filter(Boolean).join(', ')}
          renderOption={(p) => (
            <>
              <span className="font-semibold text-ink">{p.name}</span>
              <span className="text-sm text-quiet">{[p.type === 'business' ? 'Business' : 'Personal', p.city, p.phone ?? p.email, p.gstin].filter(Boolean).join(' · ')}</span>
              <PartyStatus status={p.checkStatus} />
            </>
          )}
          onPick={(p) => {
            setQuery('');
            onPick(p);
          }}
          noMatchText={parties.canCreate ? 'No customer found. Use "Add customer".' : 'No customer found.'}
          searchIcon
          aria-describedby="bf-party-search-hint"
          footer={
            parties.canCreate ? (
              <Button variant="ghost" className="w-full justify-start" onClick={() => onAdd(query)}>
                <UserPlus aria-hidden="true" />
                Add customer{query.trim() ? ` “${query.trim()}”` : ''}
              </Button>
            ) : null
          }
        />
      </Field>
      {parties.canCreate ? (
        <Button className="min-h-10 max-sm:self-start" onClick={() => onAdd(query)}>
          <UserPlus aria-hidden="true" />
          Add customer
        </Button>
      ) : null}
    </div>
    <p id="bf-party-search-hint" className="m-0 text-sm text-quiet">
      Name, company, phone or GSTIN. Type 2 letters.
    </p>
    </div>
  );
}

/** "Add customer": Personal or Business, saved as a stored customer (Not checked). */
export function AddCustomerDialog({
  open,
  onOpenChange,
  create,
  dealId,
  initial,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: B11Action;
  dealId: string;
  initial: { name: string; type: BillToType };
  onCreated: (party: PartyOption) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" closeLabel="Close without saving">
        {/* Remounted on every opening, so a closed dialog never keeps half-typed details. */}
        {open ? <AddCustomerForm create={create} dealId={dealId} initial={initial} onCreated={onCreated} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddCustomerForm({ create, dealId, initial, onCreated, onCancel }: { create: B11Action; dealId: string; initial: { name: string; type: BillToType }; onCreated: (party: PartyOption) => void; onCancel: () => void }) {
  const [v, setV] = useState<PartyValues>(() => emptyParty(initial.type, initial.name));
  const [problems, setProblems] = useState<Array<{ field: string; text: string }>>([]);
  const [result, setResult] = useState<UiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const requestId = useRef(newRequestId());
  const set = <K extends keyof PartyValues>(k: K, x: PartyValues[K]) => setV((s) => ({ ...s, [k]: x }));
  const refused = result && !result.ok ? ((result as { fields?: string[] }).fields ?? []) : [];
  const err = (field: string) => problems.find((p) => p.field === field)?.text ?? (refused.includes(field) ? (PARTY_ERROR_TEXT[field] ?? 'Check this field.') : null);
  const business = v.type === 'business';
  const refs: FieldRef[] = [...Object.keys(PARTY_ERROR_TEXT).map((k) => ({ field: k, id: `pc-${k}`, label: PARTY_ERROR_TEXT[k]! })), { field: 'idFile', id: 'pc-idFile', label: 'ID file: PDF, JPG, PNG or WebP up to 4 MB.' }, { field: 'idConsent', id: 'pc-idConsent', label: 'Tick that the customer agreed to share this ID.' }, { field: 'documents', id: 'pc-documents', label: 'Documents: up to 3 PDF, JPG, PNG or WebP files, 4 MB each.' }];

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const found = partyProblems(v);
    const idFile = (form.elements.namedItem('idFile') as HTMLInputElement | null)?.files?.[0];
    const docs = Array.from((form.elements.namedItem('documents') as HTMLInputElement | null)?.files ?? []);
    const badFile = (f: File) => f.size > FILE_MAX_BYTES || !(EVIDENCE_MIME_TYPES as readonly string[]).includes(f.type);
    if (!business && idFile && badFile(idFile)) found.push({ field: 'idFile', text: 'Use a PDF, JPG, PNG or WebP file up to 4 MB. Nothing was uploaded.' });
    if (!business && idFile && !consent) found.push({ field: 'idConsent', text: 'Tick that the customer agreed to share this ID, or remove the file.' });
    if (business && (docs.length > DOCUMENTS_MAX || docs.some(badFile))) found.push({ field: 'documents', text: `Up to ${DOCUMENTS_MAX} PDF, JPG, PNG or WebP files, 4 MB each. Nothing was uploaded.` });
    setProblems(found);
    if (found.length > 0) {
      requestAnimationFrame(() => document.getElementById(`pc-${found[0]!.field}`)?.focus());
      return;
    }
    const fd = new FormData(form);
    if (business) fd.delete('idFile');
    else fd.delete('documents');
    fd.set('requestId', requestId.current);
    setBusy(true);
    try {
      const r = normaliseResult(await guard(create as Parameters<typeof guard>[0])(null, fd)) as UiResult;
      if (!(r.ok === false && r.code === 'unexpected')) requestId.current = newRequestId();
      setResult(r);
      const party = r.ok ? (r as { data?: { party?: PartyOption } }).data?.party : undefined;
      if (r.ok && party) onCreated(party);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Add customer" className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Add customer</DialogTitle>
        <DialogDescription>Saved to the customer list as Not checked. Accounts checks it before billing.</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <ResultBox result={result && !result.ok ? result : null} fields={refs} />
        <input type="hidden" name="dealId" value={dealId} />
        <PartyTypeSwitch
          id="pc-type"
          value={v.type}
          onChange={(t) => {
            setV((s) => ({ ...s, type: t, contactPerson: t === 'business' ? s.contactPerson : '', gstStatus: t === 'business' ? s.gstStatus : '', gstin: t === 'business' ? s.gstin : '', gstReason: t === 'business' ? s.gstReason : '' }));
            setProblems([]);
          }}
        />
        <PartyFields v={v} set={set} err={err} idPrefix="pc" />
        {business ? (
          <FileField id="pc-documents" name="documents" multiple label="Documents" hint={`GST certificate or other papers. Up to ${DOCUMENTS_MAX} files: PDF, JPG, PNG or WebP, 4 MB each.`} error={err('documents')} />
        ) : (
          <div className="flex flex-col gap-2">
            <FileField id="pc-idFile" name="idFile" label="ID proof" hint="Aadhaar card or another ID, PDF or photo up to 4 MB. Never type the ID number." error={err('idFile')} />
            <div className="flex min-h-11 items-center gap-2.5">
              <input
                id="pc-idConsent"
                name="idConsent"
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                aria-invalid={err('idConsent') ? true : undefined}
                aria-describedby={err('idConsent') ? 'pc-idConsent-error' : undefined}
                className="m-0 size-5 min-h-0 shrink-0 cursor-pointer accent-brand-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong"
              />
              <label htmlFor="pc-idConsent" className="cursor-pointer text-base text-ink">
                Customer agreed to share this ID
              </label>
            </div>
            {err('idConsent') ? (
              <p id="pc-idConsent-error" className="m-0 text-sm font-medium text-status-danger">
                {err('idConsent')}
              </p>
            ) : null}
          </div>
        )}
        <p className="m-0 flex gap-2 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          Files are private: opened only by staff on this booking and Accounts.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          {busy ? 'Saving…' : 'Save customer'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FileField({ id, name, label, hint, error, multiple = false }: { id: string; name: string; label: string; hint: string; error: string | null; multiple?: boolean }) {
  return (
    <Field htmlFor={id} label={label} hint={hint} error={error ?? undefined} optional>
      <input
        id={id}
        name={name}
        type="file"
        multiple={multiple}
        accept={EVIDENCE_MIME_TYPES.join(',')}
        aria-describedby={[`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        className="block w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
      />
    </Field>
  );
}
