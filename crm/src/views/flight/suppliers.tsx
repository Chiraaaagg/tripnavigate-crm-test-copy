'use client';

import { Building2, CircleCheck, Hourglass, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Submit, type DecisionAction } from '@/views/accounts/supplier-forms';
import { ActionForm } from './kit';
import type { FlightSupplierOption } from './types';

/*
 * Flight suppliers (L15): Flight adds the airlines and consolidators it pays
 * (flight-type suppliers only) and their bank details. Approval of bank
 * details is unchanged: a supplier verifier approves them, never the person
 * who recorded them. Bank values are never shown back; only whether approved
 * details exist. Laid out like the Purchase supplier register (one row per
 * supplier, details in a side drawer), with the CRM's Lagoon kit.
 */

export interface SupplierActions {
  /** B2 flight_supplier_create: fields name, city, contactName, contactPhone, contactEmail, requestId. */
  createSupplier: DecisionAction;
  /** B3 flight_supplier_add_beneficiary: fields supplierId, accountHolder, bankName, ifsc, accountNumber, requestId. */
  addBeneficiary: DecisionAction;
  /** Edit or archive (supplierId, expectedRowVersion, name, city, contactName, contactPhone, contactEmail, status, requestId). */
  updateSupplier?: DecisionAction;
}

function Text({ id, label, value, onChange, error, hint, ...rest }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} aria-describedby={describedBy} autoComplete="off" {...rest} />
      {hint ? (
        <span id={`${id}-hint`} className="text-xs text-quiet">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="text-sm font-medium text-status-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function FlightSuppliersCard({ suppliers, actions }: { suppliers: FlightSupplierOption[]; actions: SupplierActions }) {
  return (
    <Card id="flight-suppliers">
      <section aria-labelledby="flight-suppliers-heading">
        <CardHeader className="max-sm:flex-col max-sm:items-start">
          <div className="min-w-0">
            <CardTitle id="flight-suppliers-heading">Flight suppliers</CardTitle>
            <CardDescription>Airlines and consolidators you pay. Bank details are approved by a supplier verifier before any payment to them.</CardDescription>
          </div>
          <AddSupplierDrawer action={actions.createSupplier} />
        </CardHeader>
        <CardBody>
          {suppliers.length === 0 ? (
            <p className="m-0 text-quiet">No flight supplier yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Flight suppliers">
              {suppliers.map((s) => (
                <li key={s.supplierId} className="m-0 flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Building2 aria-hidden="true" className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 wrap-anywhere">
                      <span className="font-medium text-ink">{s.name}</span>
                      {s.city ? <span className="text-sm text-quiet"> · {s.city}</span> : null}
                      {s.status === 'archived' ? <span className="text-sm text-quiet"> · archived</span> : null}
                      {s.verification === 'unverified' ? <span className="block text-xs text-quiet">Not verified yet</span> : null}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {s.bankDetailsApproved ? (
                      <StatusBadge tone="success" icon={CircleCheck} wrap>
                        Bank details approved
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral" icon={Hourglass} wrap>
                        No approved bank details
                      </StatusBadge>
                    )}
                    <BankDetailsDrawer supplier={s} action={actions.addBeneficiary} />
                    {actions.updateSupplier && typeof s.rowVersion === 'number' ? <EditSupplierDrawer supplier={s} action={actions.updateSupplier} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

function contactErrors(v: { contactPhone: string; contactEmail: string }): Record<string, string> {
  const errs: Record<string, string> = {};
  if (v.contactPhone.trim() && !/^[0-9+() -]{6,40}$/.test(v.contactPhone.trim())) errs.contactPhone = 'Digits, spaces, +, ( ) or -; at least 6.';
  if (v.contactEmail.trim() && !/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(v.contactEmail.trim())) errs.contactEmail = 'Enter an e-mail address like name@example.com.';
  return errs;
}

function EditSupplierDrawer({ supplier, action }: { supplier: FlightSupplierOption; action: DecisionAction }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    name: supplier.name,
    city: supplier.city ?? '',
    contactName: supplier.contactName ?? '',
    contactPhone: supplier.contactPhone ?? '',
    contactEmail: supplier.contactEmail ?? '',
  });
  const [archived, setArchived] = useState(supplier.status === 'archived');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof v) => (x: string) => setV((o) => ({ ...o, [k]: x }));
  const statusChange = archived !== (supplier.status === 'archived') ? (archived ? 'archived' : 'active') : '';
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit<span className="sr-only"> {supplier.name}</span>
        </Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Edit {supplier.name}</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            Changing the details makes the supplier unverified again until a supplier verifier checks it.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={action}
          fields={{
            supplierId: supplier.supplierId,
            expectedRowVersion: supplier.rowVersion ?? 1,
            name: v.name.trim(),
            city: v.city.trim(),
            contactName: v.contactName.trim(),
            contactPhone: v.contactPhone.trim(),
            contactEmail: v.contactEmail.trim(),
            status: statusChange,
          }}
          label={`Edit ${supplier.name}`}
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            const errs: Record<string, string> = { ...(v.name.trim() ? {} : { name: 'Enter the supplier’s name.' }), ...contactErrors(v) };
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          {(state) =>
            state?.ok ? (
              <DrawerBody>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DrawerBody>
            ) : (
              <>
                <DrawerBody className="flex flex-col gap-4">
                  <Text id={`${base}-name`} label="Name" value={v.name} onChange={set('name')} error={errors.name} maxLength={200} />
                  <Text id={`${base}-city`} label="City (optional)" value={v.city} onChange={set('city')} maxLength={120} />
                  <Text id={`${base}-contactName`} label="Contact person (optional)" value={v.contactName} onChange={set('contactName')} maxLength={120} />
                  <Text id={`${base}-contactPhone`} label="Phone (optional)" value={v.contactPhone} onChange={set('contactPhone')} error={errors.contactPhone} maxLength={40} inputMode="tel" />
                  <Text id={`${base}-contactEmail`} label="E-mail (optional)" value={v.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} maxLength={254} type="email" />
                  <label className="flex items-start gap-2 font-medium text-ink">
                    <input type="checkbox" className="mt-1.5 size-4 accent-brand-strong" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
                    <span>
                      Archived
                      <span className="block text-sm font-normal text-quiet">An archived supplier cannot be chosen for new tickets.</span>
                    </span>
                  </label>
                </DrawerBody>
                <DrawerFooter>
                  <Submit label="Save changes" pendingLabel="Saving…" />
                </DrawerFooter>
              </>
            )
          }
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}

function AddSupplierDrawer({ action }: { action: DecisionAction }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: '', city: '', contactName: '', contactPhone: '', contactEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof v) => (x: string) => setV((o) => ({ ...o, [k]: x }));
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="secondary" size="sm">
          <Plus aria-hidden="true" />
          Add supplier
        </Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Add a flight supplier</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            For flights only. Add the bank details afterwards.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={action}
          fields={{ name: v.name.trim(), city: v.city.trim(), contactName: v.contactName.trim(), contactPhone: v.contactPhone.trim(), contactEmail: v.contactEmail.trim() }}
          label="Add a flight supplier"
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (!v.name.trim()) errs.name = 'Enter the supplier’s name.';
            Object.assign(errs, contactErrors(v));
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          {(state) =>
            state?.ok ? (
              <DrawerBody>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DrawerBody>
            ) : (
              <>
                <DrawerBody className="flex flex-col gap-4">
                  <Text id={`${base}-name`} label="Name" value={v.name} onChange={set('name')} error={errors.name} maxLength={200} />
                  <Text id={`${base}-city`} label="City (optional)" value={v.city} onChange={set('city')} maxLength={120} />
                  <Text id={`${base}-contactName`} label="Contact person (optional)" value={v.contactName} onChange={set('contactName')} maxLength={120} />
                  <Text id={`${base}-contactPhone`} label="Phone (optional)" value={v.contactPhone} onChange={set('contactPhone')} error={errors.contactPhone} maxLength={40} inputMode="tel" />
                  <Text id={`${base}-contactEmail`} label="E-mail (optional)" value={v.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} maxLength={254} type="email" />
                </DrawerBody>
                <DrawerFooter>
                  <Submit label="Add supplier" pendingLabel="Adding…" />
                </DrawerFooter>
              </>
            )
          }
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}

function BankDetailsDrawer({ supplier, action }: { supplier: FlightSupplierOption; action: DecisionAction }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ accountHolder: '', bankName: '', ifsc: '', accountNumber: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof v) => (x: string) => setV((o) => ({ ...o, [k]: x }));
  const ifsc = v.ifsc.trim().toUpperCase();
  const account = v.accountNumber.replace(/\s/g, '');
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="ghost" size="sm">
          {supplier.bankDetailsApproved ? 'Change bank details' : 'Add bank details'}
          <span className="sr-only"> of {supplier.name}</span>
        </Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Bank details · {supplier.name}</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            A supplier verifier approves them; you cannot approve details you recorded. Only the last 4 digits are shown afterwards.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={action}
          fields={{ supplierId: supplier.supplierId, accountHolder: v.accountHolder.trim(), bankName: v.bankName.trim(), ifsc, accountNumber: account }}
          label={`Record bank details of ${supplier.name}`}
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (!v.accountHolder.trim()) errs.accountHolder = 'Enter the account holder.';
            if (!v.bankName.trim()) errs.bankName = 'Enter the bank.';
            if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) errs.ifsc = 'IFSC is 11 characters, for example ABCD0123456.';
            if (!/^[0-9]{6,18}$/.test(account)) errs.accountNumber = 'Account number: 6 to 18 digits.';
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          {(state) =>
            state?.ok ? (
              <DrawerBody>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DrawerBody>
            ) : (
              <>
                <DrawerBody className="flex flex-col gap-4">
                  <Text id={`${base}-accountHolder`} label="Account holder" value={v.accountHolder} onChange={set('accountHolder')} error={errors.accountHolder} maxLength={120} />
                  <Text id={`${base}-bankName`} label="Bank" value={v.bankName} onChange={set('bankName')} error={errors.bankName} maxLength={120} />
                  <Text id={`${base}-ifsc`} label="IFSC" value={v.ifsc} onChange={set('ifsc')} error={errors.ifsc} maxLength={11} autoCapitalize="characters" spellCheck={false} className="uppercase" />
                  <Text id={`${base}-accountNumber`} label="Account number" value={v.accountNumber} onChange={set('accountNumber')} error={errors.accountNumber} maxLength={18} inputMode="numeric" spellCheck={false} />
                </DrawerBody>
                <DrawerFooter>
                  <Submit label="Record bank details" pendingLabel="Recording…" />
                </DrawerFooter>
              </>
            )
          }
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}
