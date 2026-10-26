'use client';

import { Lock, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { MultiSelect } from '@/components/ui/multi-select';
import { Input } from '@/components/ui/input';
import { fieldDescribedBy } from '@/components/ui/field';
import { SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_LABEL, TRAVELLER_TYPES, isSpecialRequestCode, type BookTravellerView, type SpecialRequestCode, type TravellerIdentity, type TravellerType } from '@/modules/fulfilment/contracts';
import { EXTRA_PHONES_MAX } from './vn-types';
import { AreaField, SelectField, TextField } from '../b11/controls';
import { maskPassport } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import { refusedFields, ResultBox, type FieldRef, type UiResult } from '../b11/form-kit';
import { TravellerIdProofSlot } from '../b11/id-proof-slot';
import type { BookNowView } from '../b11/shapes';
import { errFor } from './form-helpers';
import type { PassengerActions } from './passengers-card';

/*
 * Passenger Details drawer (approved preview PassengerEditor; contract §2.3):
 * name, type, age, standard requests (owner list, 24 October 2026) and other
 * requirements go back into the passenger rows and save with them; date of birth, marriage date, contact and passport details are the
 * restricted identity record (saveIdentity, own row version, only for a saved
 * passenger); ID proofs use the existing private upload slot with its own
 * consent tick. The proof slot is a sibling of this drawer's form, so forms
 * never nest.
 */

export interface PassengerRow {
  seq: number | null;
  name: string;
  type: TravellerType;
  age: string;
  needs: string;
  /** Standard requests (contracts SPECIAL_REQUEST_CODES); free text stays in `needs`. */
  requests: SpecialRequestCode[];
  /** Stable screen key of a row typed into an empty slot (not posted). */
  key?: string;
}

/** Identity record plus the extras added by the booking form (contract IdentityExtraKeys). */
type IdentityView = TravellerIdentity & { dateOfMarriage?: string | null; phone?: string | null; email?: string | null };

interface IdentityValues {
  dateOfBirth: string;
  dateOfMarriage: string;
  phone: string;
  email: string;
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  /** Other phone numbers (optional, up to EXTRA_PHONES_MAX). */
  extraPhones: string[];
}

const TYPE_TEXT: Record<TravellerType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };

function identityValues(t: BookTravellerView | null): IdentityValues {
  const id = (t?.identity ?? null) as IdentityView | null;
  return {
    dateOfBirth: id?.dateOfBirth ?? '',
    dateOfMarriage: id?.dateOfMarriage ?? '',
    phone: id?.phone ?? '',
    email: id?.email ?? '',
    nationality: id?.nationality ?? '',
    passportNumber: id?.passportNumber ?? '',
    passportExpiry: id?.passportExpiry ?? '',
    extraPhones: [...(id?.extraPhones ?? [])],
  };
}

const IDENTITY_REFS: FieldRef[] = [
  { field: 'dateOfBirth', id: 'pax-dob', label: 'Date of birth: a real date on or before travel.' },
  { field: 'dateOfMarriage', id: 'pax-dom', label: 'Date of marriage: a real date, not before the date of birth.' },
  { field: 'passengerPhone', id: 'pax-phone', label: 'Phone: 10 digits starting with 6 to 9, or + and the country code.' },
  { field: 'passengerEmail', id: 'pax-email', label: 'Check the email address.' },
  { field: 'nationality', id: 'pax-nationality', label: 'Nationality' },
  { field: 'passportNumber', id: 'pax-passport', label: 'Passport number: 6 to 15 letters and digits.' },
  { field: 'passportExpiry', id: 'pax-expiry', label: 'Passport expiry date' },
  { field: 'passengerPhoneExtra', id: 'pax-phone-extra-1', label: 'Other phones: 10 digits starting with 6 to 9, or + and the country code.' },
];

export function PassengerDrawer({
  view,
  rowNo,
  row,
  traveller,
  editable,
  actions,
  reloadHref,
  passengersResult,
  passengerRefs,
  onSave,
  onClose,
  onRemove,
}: {
  view: BookNowView;
  rowNo: number;
  row: PassengerRow;
  /** The saved passenger (null for a row typed here and not saved yet). */
  traveller: BookTravellerView | null;
  editable: boolean;
  actions: PassengerActions;
  reloadHref: string;
  passengersResult: UiResult | null;
  passengerRefs: FieldRef[];
  onSave: (row: PassengerRow) => Promise<boolean>;
  onClose: () => void;
  /** Absent for an empty slot (nothing to remove). */
  onRemove?: () => void;
}) {
  const [p, setP] = useState<PassengerRow>(row);
  const [nameError, setNameError] = useState<string | null>(null);
  const [rowRefused, setRowRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = traveller?.seq ?? null;
  const idf = useSectionForm({
    id: `identity-${seq ?? 'new'}`,
    section: 'identity',
    label: `Private details of ${p.name || `passenger ${rowNo}`}`,
    order: 25,
    action: actions.saveIdentity,
    initial: identityValues(traveller),
    versionBound: false,
    rowVersion: 0,
    saveable: false,
    tracksDirty: false,
  });
  const iv = idf.values;
  const setI = (k: Exclude<keyof IdentityValues, 'extraPhones'>, x: string) => idf.setValues((s) => ({ ...s, [k]: x }));
  const setExtra = (fn: (x: string[]) => string[]) => idf.setValues((s) => ({ ...s, extraPhones: fn(s.extraPhones) }));
  const extraErr = refusedFields(idf.state)?.some((x) => x.startsWith('passengerPhoneExtra')) ? IDENTITY_REFS.find((r) => r.field === 'passengerPhoneExtra')!.label : null;
  const ierr = errFor(IDENTITY_REFS, refusedFields(idf.state));
  const rowDirty = JSON.stringify(p) !== JSON.stringify(row);
  const showPassport = Boolean(traveller?.identityRequired || traveller?.identity?.passportNumber || traveller?.identity?.nationality);
  const identityLocked = seq === null;
  const ok = (r: UiResult | null) => Boolean(r && r.ok);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editable || busy) return;
    if (!p.name.trim()) {
      setNameError('Enter the passenger’s name.');
      requestAnimationFrame(() => document.getElementById('pax-name')?.focus());
      return;
    }
    setNameError(null);
    setBusy(true);
    try {
      if (rowDirty) {
        const saved = await onSave(p);
        if (!saved) {
          setRowRefused(true);
          return;
        }
        setRowRefused(false);
      }
      if (!identityLocked && idf.dirty) {
        const fd = new FormData();
        fd.set('dealId', view.dealId);
        fd.set('seq', String(seq));
        fd.set('identityRowVersion', String(traveller?.identity?.rowVersion ?? 0));
        fd.set('dateOfBirth', iv.dateOfBirth);
        fd.set('dateOfMarriage', iv.dateOfMarriage);
        fd.set('passengerPhone', iv.phone.trim());
        fd.set('passengerEmail', iv.email.trim());
        fd.set('nationality', iv.nationality.trim());
        fd.set('passportNumber', iv.passportNumber.trim().toUpperCase());
        fd.set('passportExpiry', iv.passportExpiry);
        for (const extra of iv.extraPhones.map((x) => x.trim()).filter(Boolean)) fd.append('passengerPhoneExtra', extra);
        const r = await idf.post(fd);
        if (!ok(r)) return;
        // A partial save ("… save after the database update.") stays on screen so it is read, not lost with the drawer.
        if (r.ok && 'message' in r && typeof r.message === 'string' && /database update/i.test(r.message)) return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const FORM = 'pax-drawer-form';
  return (
    <Drawer
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DrawerContent className="w-[min(42.5rem,100vw)] max-sm:rounded-none" closeLabel="Close without saving">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Passenger details</DrawerTitle>
          <DrawerDescription className="sr-only">Edit passenger {rowNo}. Private details are shown only to the people who need them.</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-5">
          {rowRefused ? <ResultBox result={passengersResult} fields={passengerRefs} reloadHref={reloadHref} /> : null}
          <ResultBox result={idf.state} fields={IDENTITY_REFS} reloadHref={reloadHref} className="[&:empty]:hidden" />
          <form id={FORM} onSubmit={submit} noValidate className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
              <TextField id="pax-name" name="name" label="Full name" value={p.name} onChange={(x) => setP((s) => ({ ...s, name: x }))} error={nameError} maxLength={120} disabled={!editable} />
              <SelectField
                id="pax-type"
                name="type"
                label="Passenger type"
                value={p.type}
                onChange={(x) => setP((s) => ({ ...s, type: x as TravellerType, age: x === 'adult' ? '' : s.age }))}
                options={TRAVELLER_TYPES.map((t) => ({ value: t, label: TYPE_TEXT[t] }))}
                disabled={!editable}
              />
              {p.type !== 'adult' ? (
                <TextField id="pax-age" name="age" label="Age at travel" type="number" min={0} max={17} value={p.age} onChange={(x) => setP((s) => ({ ...s, age: x }))} disabled={!editable} />
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <span id="pax-requests-label" className="font-semibold text-ink">
                Special requests <span className="font-normal text-quiet">(optional)</span>
              </span>
              <MultiSelect
                id="pax-requests"
                labelId="pax-requests-label"
                options={SPECIAL_REQUEST_CODES.map((c) => ({ value: c, label: SPECIAL_REQUEST_LABEL[c] }))}
                selected={p.requests}
                onChange={(next) => setP((s) => ({ ...s, requests: next.filter(isSpecialRequestCode) }))}
                placeholder="Choose requests"
                noun="requests"
                searchFrom={12}
                disabled={!editable}
              />
            </div>
            <AreaField id="pax-needs" name="needs" label="Other requirements" optional rows={2} maxLength={500} value={p.needs} onChange={(x) => setP((s) => ({ ...s, needs: x }))} disabled={!editable} />

            <fieldset className="m-0 min-w-0 border-0 border-t border-line p-0 pt-5" disabled={!editable || identityLocked}>
              <legend className="float-left mb-3.5 w-full p-0 text-base font-semibold text-ink">Private details</legend>
              <p className="clear-both m-0 mb-3.5 flex gap-2 text-sm text-quiet">
                <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
                <span>
                  {identityLocked
                    ? 'Save the passenger first to add these details and the ID proof.'
                    : 'Only the deal owner, the branch Manager and the Flight or Visa & Passport colleague who needs them see these. Purchase never does.'}
                </span>
              </p>
              <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
                <TextField id="pax-dob" name="dateOfBirth" label="Date of birth" type="date" optional={!showPassport} value={iv.dateOfBirth} onChange={(x) => setI('dateOfBirth', x)} error={ierr('dateOfBirth')} />
                <TextField id="pax-dom" name="dateOfMarriage" label="Date of marriage" type="date" optional value={iv.dateOfMarriage} onChange={(x) => setI('dateOfMarriage', x)} error={ierr('dateOfMarriage')} />
                <TextField id="pax-phone" name="passengerPhone" label="Phone" type="tel" inputMode="tel" optional maxLength={16} value={iv.phone} onChange={(x) => setI('phone', x)} error={ierr('passengerPhone')} />
                <TextField id="pax-email" name="passengerEmail" label="Email" type="email" inputMode="email" optional maxLength={254} value={iv.email} onChange={(x) => setI('email', x)} error={ierr('passengerEmail')} />
                <ExtraPhones values={iv.extraPhones} set={setExtra} error={extraErr} />
                {showPassport ? (
                  <>
                    <TextField id="pax-nationality" name="nationality" label="Nationality" maxLength={60} value={iv.nationality} onChange={(x) => setI('nationality', x)} error={ierr('nationality')} />
                    <TextField
                      id="pax-passport"
                      name="passportNumber"
                      label="Passport number"
                      hint={traveller?.identity?.passportNumber ? `On file: ${maskPassport(traveller.identity.passportNumber)}. Later is fine.` : 'Later is fine.'}
                      optional
                      maxLength={15}
                      value={iv.passportNumber}
                      onChange={(x) => setI('passportNumber', x.toUpperCase())}
                      error={ierr('passportNumber')}
                    />
                    <TextField id="pax-expiry" name="passportExpiry" label="Passport expiry" type="date" optional value={iv.passportExpiry} onChange={(x) => setI('passportExpiry', x)} error={ierr('passportExpiry')} />
                  </>
                ) : null}
              </div>
            </fieldset>
          </form>

          <section aria-labelledby="pax-docs-heading" className="flex flex-col gap-3 border-t border-line pt-5">
            <h3 id="pax-docs-heading" className="m-0 text-base font-semibold text-ink">
              Documents
            </h3>
            {seq !== null && traveller && traveller.idProofs !== undefined && view.idProofLimits ? (
              <TravellerIdProofSlot
                dealId={view.dealId}
                seq={seq}
                rowNo={rowNo}
                name={p.name}
                savedName={traveller.fullName}
                type={p.type}
                proofs={traveller.idProofs ?? []}
                limits={view.idProofLimits}
                canEdit={view.idProofCanEdit}
                canRemove={view.idProofCanRemove}
                uploadAction={actions.uploadIdProof}
                removeAction={actions.removeIdProof}
                retryCopyAction={actions.retryIdProofCopy}
              />
            ) : (
              <p className="m-0 text-sm text-quiet">{seq === null ? 'Save the passenger first to attach an ID proof.' : 'ID proofs are not shown to you.'}</p>
            )}
          </section>

          {editable && onRemove ? (
            <div className="border-t border-line pt-4">
              <Button variant="ghost" onClick={onRemove}>
                <Trash2 aria-hidden="true" />
                Remove passenger
              </Button>
            </div>
          ) : null}
        </DrawerBody>
        <DrawerFooter className="sticky bottom-0 bg-card">
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
            {editable ? (
              <Button type="submit" form={FORM} variant="primary" loading={busy}>
                Save passenger
              </Button>
            ) : null}
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** Other phone numbers of a passenger (optional; owner item 3). */
function ExtraPhones({ values, set, error }: { values: string[]; set: (fn: (x: string[]) => string[]) => void; error: string | null }) {
  return (
    <div className="flex flex-col gap-2 min-[381px]:col-span-2">
      {values.map((v, i) => {
        const id = `pax-phone-extra-${i + 1}`;
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="font-semibold text-ink">
              Other phone {values.length > 1 ? i + 1 : ''} <span className="font-normal text-quiet">(optional)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <Input id={id} type="tel" inputMode="tel" maxLength={16} value={v} invalid={Boolean(error)} aria-describedby={fieldDescribedBy(id, { error: i === 0 ? error : null })} onChange={(e) => set((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
              <Button variant="ghost" size="icon" className="size-11" aria-label={`Remove other phone ${i + 1}`} onClick={() => set((x) => x.filter((_, j) => j !== i))}>
                <X aria-hidden="true" />
              </Button>
            </div>
            {i === 0 && error ? (
              <p id={`${id}-error`} className="m-0 text-sm font-medium text-status-danger">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      {values.length < EXTRA_PHONES_MAX ? (
        <div>
          <Button variant="link" size="sm" className="min-h-10" onClick={() => set((x) => [...x, ''])}>
            <Plus aria-hidden="true" />
            Add another phone
          </Button>
        </div>
      ) : null}
    </div>
  );
}
