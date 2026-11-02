'use client';

import { cn, focusRing } from '@/components/ui/cn';
import type { BillToType, GstStatus } from '@/modules/fulfilment/booking-form-contract';
import { EMAIL_SHAPE, GST_REASON_LIMITS, POSTAL_CODE, gstinMatchesState, gstinShape, normalisePhone } from '@/modules/fulfilment/booking-form-model';
import { GST_STATES } from '../b11/book-fields';
import { SelectField, TextField } from '../b11/controls';
import type { PartyOption } from './vn-types';

/*
 * The fields of one stored customer (Bill To party): Personal or Business,
 * India only. Shared by the "Add customer" dialog on the booking form and by
 * the Accounts customer check. Posts the names the party commands read
 * (luna-vn-props.md): partyType, name, contactPerson, phone, email,
 * addressLine1, addressLine2, city, stateCode, postalCode, gstStatus, gstin,
 * gstReason. Local checks only catch typing slips; the server checks again.
 * GSTIN: format and state only; it is not a registration check.
 */

export interface PartyValues {
  type: BillToType;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateCode: string;
  postalCode: string;
  gstStatus: GstStatus | '';
  gstin: string;
  gstReason: string;
}

export const emptyParty = (type: BillToType = 'personal', name = ''): PartyValues => ({
  type,
  name,
  contactPerson: '',
  phone: '',
  email: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  stateCode: '',
  postalCode: '',
  gstStatus: '',
  gstin: '',
  gstReason: '',
});

export function partyValuesOf(p: PartyOption): PartyValues {
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
    gstStatus: p.gstStatus ?? '',
    gstin: p.gstin ?? '',
    gstReason: p.gstReason ?? '',
  };
}

/** Field names posted for each value (also the refusal field names). */
export const PARTY_FIELD: Record<Exclude<keyof PartyValues, 'type'>, string> = {
  name: 'name',
  contactPerson: 'contactPerson',
  phone: 'phone',
  email: 'email',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  stateCode: 'stateCode',
  postalCode: 'postalCode',
  gstStatus: 'gstStatus',
  gstin: 'gstin',
  gstReason: 'gstReason',
};

export const PARTY_ERROR_TEXT: Record<string, string> = {
  name: 'Enter the name.',
  contactPerson: 'Add the contact name at the business.',
  phone: 'Phone: 10 digits starting with 6 to 9, or + and the country code.',
  email: 'Check the email address.',
  reach: 'Add a phone number or an email.',
  addressLine1: 'Add the address.',
  addressLine2: 'Address line 2: up to 200 characters.',
  city: 'Add the city.',
  stateCode: 'Choose the state.',
  postalCode: 'Enter a six-digit PIN code that does not start with 0.',
  gstStatus: 'Choose whether the business is GST registered.',
  gstin: 'Check the GSTIN. Its first two digits must match the state.',
  gstReason: `Record why the business has no GSTIN (${GST_REASON_LIMITS.min} to ${GST_REASON_LIMITS.max} characters).`,
};

/** Typing slips caught before sending: field name to message, in page order. */
export function partyProblems(v: PartyValues): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const add = (field: string, key = field) => out.push({ field, text: PARTY_ERROR_TEXT[key]! });
  if (!v.name.trim()) add('name');
  if (v.type === 'business' && !v.contactPerson.trim()) add('contactPerson');
  const phone = normalisePhone(v.phone);
  if (phone === undefined) add('phone');
  if (v.email.trim() && !EMAIL_SHAPE.test(v.email.trim())) add('email');
  if (phone === null && !v.email.trim()) add('phone', 'reach');
  if (!v.addressLine1.trim()) add('addressLine1');
  if (!v.city.trim()) add('city');
  if (!v.stateCode) add('stateCode');
  if (!POSTAL_CODE.test(v.postalCode.trim())) add('postalCode');
  if (v.type === 'business') {
    if (!v.gstStatus) add('gstStatus');
    if (v.gstStatus === 'registered' && !(gstinShape(v.gstin.trim()) && (!v.stateCode || gstinMatchesState(v.gstin.trim(), v.stateCode)))) add('gstin');
    const r = v.gstReason.trim().length;
    if (v.gstStatus === 'unregistered' && (r < GST_REASON_LIMITS.min || r > GST_REASON_LIMITS.max)) add('gstReason');
  }
  return out;
}

/** Personal / Business switch (pressed buttons, as on Bill To). */
export function PartyTypeSwitch({ value, onChange, disabled, id }: { value: BillToType; onChange: (t: BillToType) => void; disabled?: boolean; id: string }) {
  return (
    <div role="group" aria-label="Customer type" id={id} tabIndex={-1} className="inline-flex gap-0.75 rounded-control bg-wash p-0.75 outline-none">
      {(['personal', 'business'] as const).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={value === t}
          disabled={disabled}
          onClick={() => onChange(t)}
          className={cn('min-h-10 min-w-25 cursor-pointer rounded-chip border-0 bg-transparent px-3 font-medium text-quiet disabled:cursor-not-allowed', value === t && 'bg-card text-brand-deep shadow-card', focusRing)}
        >
          {t === 'personal' ? 'Personal' : 'Business'}
        </button>
      ))}
    </div>
  );
}

export function PartyFields({ v, set, err, idPrefix, disabled = false }: { v: PartyValues; set: <K extends keyof PartyValues>(k: K, x: PartyValues[K]) => void; err: (field: string) => string | null; idPrefix: string; disabled?: boolean }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const business = v.type === 'business';
  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="partyType" value={v.type} />
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        <TextField id={id('name')} name="name" label={business ? 'Company name' : 'Full name'} value={v.name} onChange={(x) => set('name', x)} error={err('name')} maxLength={200} disabled={disabled} />
        {business ? <TextField id={id('contactPerson')} name="contactPerson" label="Contact name" value={v.contactPerson} onChange={(x) => set('contactPerson', x)} error={err('contactPerson')} maxLength={120} disabled={disabled} /> : null}
        <TextField id={id('phone')} name="phone" label="Phone" type="tel" inputMode="tel" value={v.phone} onChange={(x) => set('phone', x)} error={err('phone')} maxLength={16} disabled={disabled} />
        <TextField id={id('email')} name="email" label="Email" type="email" inputMode="email" optional value={v.email} onChange={(x) => set('email', x)} error={err('email')} maxLength={254} disabled={disabled} />
        <TextField id={id('addressLine1')} name="addressLine1" label="Address" value={v.addressLine1} onChange={(x) => set('addressLine1', x)} error={err('addressLine1')} maxLength={200} autoComplete="address-line1" className="min-[381px]:col-span-2" disabled={disabled} />
        <TextField id={id('addressLine2')} name="addressLine2" label="Address line 2" optional value={v.addressLine2} onChange={(x) => set('addressLine2', x)} error={err('addressLine2')} maxLength={200} autoComplete="address-line2" className="min-[381px]:col-span-2" disabled={disabled} />
        <TextField id={id('city')} name="city" label="City" value={v.city} onChange={(x) => set('city', x)} error={err('city')} maxLength={120} disabled={disabled} />
        <SelectField
          id={id('stateCode')}
          name="stateCode"
          label="State"
          value={v.stateCode}
          onChange={(x) => set('stateCode', x)}
          options={[{ value: '', label: 'Choose the state' }, ...GST_STATES.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))]}
          error={err('stateCode')}
          disabled={disabled}
        />
        <TextField id={id('postalCode')} name="postalCode" label="PIN code" inputMode="numeric" value={v.postalCode} onChange={(x) => set('postalCode', x)} error={err('postalCode')} maxLength={6} autoComplete="postal-code" disabled={disabled} />
        <p className="m-0 self-end pb-2.25 text-quiet">Country: India</p>
      </div>
      {business ? (
        <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
          <SelectField
            id={id('gstStatus')}
            name="gstStatus"
            label="GST registration"
            value={v.gstStatus}
            onChange={(x) => {
              set('gstStatus', x as GstStatus | '');
              if (x !== 'registered') set('gstin', '');
              if (x !== 'unregistered') set('gstReason', '');
            }}
            options={[
              { value: '', label: 'Choose' },
              { value: 'registered', label: 'GST registered' },
              { value: 'unregistered', label: 'Not GST registered' },
            ]}
            error={err('gstStatus')}
            disabled={disabled}
          />
          {v.gstStatus === 'registered' ? (
            <TextField id={id('gstin')} name="gstin" label="GSTIN" hint="Format check only. Accounts checks it." value={v.gstin} onChange={(x) => set('gstin', x.toUpperCase())} error={err('gstin')} maxLength={15} disabled={disabled} />
          ) : null}
          {v.gstStatus === 'unregistered' ? (
            <TextField id={id('gstReason')} name="gstReason" label="Reason for no GSTIN" value={v.gstReason} onChange={(x) => set('gstReason', x)} error={err('gstReason')} maxLength={GST_REASON_LIMITS.max} className="min-[381px]:col-span-2" disabled={disabled} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
