'use client';

import { Lock, Plus, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { SuggestMultiSelect } from '@/components/ui/suggest-multiselect';
import {
  BOOK_BATCH2_TEXT,
  SPECIAL_REQUEST_CODES,
  SPECIAL_REQUEST_LABEL,
  isSpecialRequestCode,
  type BookTravellerView,
  type SpecialRequestCode,
  type TravellerIdentity,
  type TravellerIdentitySaveResult,
  type TravellerType,
} from '@/modules/fulfilment/contracts';
import { EXTRA_PHONES_MAX } from './vn-types';
import { AreaField, TextField } from '../b11/controls';
import { maskPassport } from '../b11/book-fields';
import { useDraftSync, useSectionForm } from '../b11/draft-sync';
import { refusedFields, ResultBox, type FieldRef, type UiResult } from '../b11/form-kit';
import type { BookNowView } from '../b11/shapes';
import { useSaveQueue } from './autosave-queue';
import { escapeClosesListFirst } from './service-editor';
import { errFor } from './form-helpers';
import { useFormToast } from './form-toast';
import type { PassengerActions } from './passengers-card';

/*
 * Passenger details drawer (Book now v2, owner-approved prototype
 * openPaxDrawer): full name, the type set by the traveller counts, age for a
 * child or infant, special requests (the same dropdown as hotel requests;
 * fixed request codes only, lead ruling D6) and other requirements go back
 * into the passenger rows and save with them. Date of birth, marriage date,
 * contact and passport details are the restricted identity record
 * (saveIdentity, its own row version, only for a saved passenger). Extra
 * phones and the passport block stay for the passengers who need them
 * (privacy and ID rules unchanged). ID proof is attached from the row.
 *
 * Booking reliability B2-1: for a child or infant with a saved date of birth
 * the database keeps the age at travel (whole years on the trip start), so
 * "Age at travel" becomes read-only text (W10a, or W10b before the trip dates
 * are saved) and the drawer never changes the age then. A date of birth that
 * does not fit the passenger type is warned and allowed (owner Q4: W10e; W10d
 * for 18 or older). Only the number is shown; the date stays in the private
 * details below.
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
  extraPhones: string[];
}

const TYPE_TEXT: Record<TravellerType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };
const REQUEST_OPTIONS = SPECIAL_REQUEST_CODES.map((c) => ({ value: c, label: SPECIAL_REQUEST_LABEL[c] }));

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

// ---------------------------------------------------------------------------
// B2-1: age at travel from the date of birth (pure; unit-tested)
// ---------------------------------------------------------------------------

function isoParts(value: string | null | undefined): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

/**
 * Whole years on `on` for a date of birth (the database's authz.age_on): -1
 * when the date of birth is after `on`; null when either date is missing or
 * not a real date. A 29 February birthday counts from 1 March in other years.
 */
export function ageOn(dateOfBirth: string | null | undefined, on: string | null | undefined): number | null {
  const b = isoParts(dateOfBirth);
  const o = isoParts(on);
  if (!b || !o) return null;
  if (b[0] > o[0] || (b[0] === o[0] && (b[1] > o[1] || (b[1] === o[1] && b[2] > o[2])))) return -1;
  const beforeBirthday = o[1] < b[1] || (o[1] === b[1] && o[2] < b[2]);
  return o[0] - b[0] - (beforeBirthday ? 1 : 0);
}

/** What "Age at travel" shows for a child or infant. */
export type AgeAtTravel = { kind: 'typed' } | { kind: 'derived'; years: number } | { kind: 'after_trip_dates' };

/**
 * B2-1 drawer states: no saved date of birth = the number field as today;
 * a saved date of birth and no trip start = W10b; a saved date of birth and
 * a stored age equal to the age on the trip start = W10a (read-only). Any
 * other case (an older database that does not derive yet, or a number outside
 * 0 to 17) keeps the number field, so an age can always be entered.
 */
export function ageAtTravel(
  type: TravellerType,
  savedDateOfBirth: string | null | undefined,
  tripStart: string | null | undefined,
  storedAge: number | null | undefined,
): AgeAtTravel {
  if (type === 'adult' || !isoParts(savedDateOfBirth)) return { kind: 'typed' };
  if (!isoParts(tripStart)) return { kind: 'after_trip_dates' };
  const years = ageOn(savedDateOfBirth, tripStart);
  if (years !== null && years >= 0 && years <= 17 && storedAge === years) return { kind: 'derived', years };
  return { kind: 'typed' };
}

/** Age bands used only for the warning (owner Q4: warn and allow): infant under 2, child 2 to 17, adult 12 or older. */
export type AgeWarning = 'age_too_high' | 'type_mismatch';

/** B2-1 warning for the date of birth in the drawer (never blocks a save). */
export function ageWarning(type: TravellerType, dateOfBirth: string | null | undefined, tripStart: string | null | undefined): AgeWarning | null {
  const years = ageOn(dateOfBirth, tripStart);
  if (years === null || years < 0) return null;
  if (type !== 'adult' && years >= 18) return 'age_too_high';
  if (type === 'infant' && years >= 2) return 'type_mismatch';
  if (type === 'child' && years < 2) return 'type_mismatch';
  if (type === 'adult' && years < 12) return 'type_mismatch';
  return null;
}

/** The age a drawer save posts: the stored number while the date of birth decides it (never a typed one). */
export function ageForSave(state: AgeAtTravel, typed: string, stored: string): string {
  return state.kind === 'typed' ? typed : stored;
}

/** draftRowVersion of an identity save answer (B2-1), when the save moved the draft's version. */
export function draftVersionMove(result: unknown): { from: number; to: number } | null {
  const data = (result as { ok?: unknown; data?: Partial<TravellerIdentitySaveResult> } | null)?.data;
  const move = data?.draftRowVersion;
  if (!(result as { ok?: unknown } | null)?.ok || !move) return null;
  return Number.isInteger(move.from) && Number.isInteger(move.to) && move.to > move.from ? { from: move.from, to: move.to } : null;
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
  passengersResult,
  passengerRefs,
  onSave,
  onClose,
}: {
  view: BookNowView;
  rowNo: number;
  row: PassengerRow;
  /** The saved passenger (null for a row typed here and not saved yet). */
  traveller: BookTravellerView | null;
  editable: boolean;
  actions: PassengerActions;
  passengersResult: UiResult | null;
  passengerRefs: FieldRef[];
  onSave: (row: PassengerRow) => Promise<boolean>;
  onClose: () => void;
}) {
  const queue = useSaveQueue();
  const toast = useFormToast();
  const sync = useDraftSync();
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
  // B2-1: the saved date of birth decides the age at travel (W10a, W10b); the warning follows the date typed here.
  const tripStart = view.trip?.start ?? null;
  const age = ageAtTravel(p.type, traveller?.identity?.dateOfBirth ?? null, tripStart, traveller?.ageYears ?? null);
  const warning = identityLocked ? null : ageWarning(p.type, iv.dateOfBirth, tripStart);

  // Change 4: a synchronous in-flight flag as well as the state.
  const inflight = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editable || busy || inflight.current) return;
    inflight.current = true;
    try {
      await submitOnce();
    } finally {
      inflight.current = false;
    }
  }
  async function submitOnce() {
    if (!p.name.trim()) {
      setNameError('Enter the passenger’s name.');
      requestAnimationFrame(() => document.getElementById('pax-name')?.focus());
      return;
    }
    setNameError(null);
    setBusy(true);
    try {
      if (rowDirty) {
        const saved = await onSave({ ...p, age: ageForSave(age, p.age, row.age) });
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
        const r = await queue.run(() => idf.post(fd));
        if (!r.ok) return;
        // B2-1: a save that changed the stored age moved the draft's version; it is this browser's own save.
        const moved = draftVersionMove(r);
        if (moved) sync.recordSave(moved.from, moved.to);
        // A partial save ("… save after the database update.") stays on screen so it is read.
        if ('message' in r && typeof r.message === 'string' && /database update/i.test(r.message)) return;
      }
      toast('Passenger details saved. They are visible only to the people who need them.');
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
        if (!o && !busy) onClose();
      }}
    >
      <DrawerContent className="w-[min(42.5rem,100vw)] max-sm:rounded-none" closeLabel="Close without saving" onEscapeKeyDown={escapeClosesListFirst}>
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Passenger details</DrawerTitle>
          <DrawerDescription className="sr-only">Edit passenger {rowNo}. Private details are shown only to the people who need them.</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-4">
          <form
            id={FORM}
            onSubmit={submit}
            onKeyDown={(e) => {
              // Enter inside a field never saves the drawer (change 4).
              if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
              <TextField id="pax-name" name="name" label="Full name" value={p.name} onChange={(x) => setP((s) => ({ ...s, name: x }))} error={nameError} maxLength={120} disabled={!editable} />
              <Field htmlFor="pax-type" label="Passenger type" hint="Set by the traveller counts.">
                <Input id="pax-type" readOnly value={TYPE_TEXT[p.type]} aria-describedby={fieldDescribedBy('pax-type', { hint: true })} className="bg-wash text-quiet" />
              </Field>
            </div>
            {p.type !== 'adult' ? (
              age.kind === 'typed' ? (
                <TextField id="pax-age" name="age" label="Age at travel" type="number" min={0} max={17} value={p.age} onChange={(x) => setP((s) => ({ ...s, age: x }))} disabled={!editable} className="max-w-30" />
              ) : (
                <p id="pax-age" className="m-0 text-base text-copy">
                  {age.kind === 'derived' ? BOOK_BATCH2_TEXT.ageAtTravel(age.years) : BOOK_BATCH2_TEXT.ageAfterTripDates}
                </p>
              )
            ) : null}
            <SuggestMultiSelect
              id="pax-requests"
              label="Special requests"
              options={REQUEST_OPTIONS}
              items={p.requests.map((value) => ({ value, forKey: null }))}
              onChange={(next) => setP((s) => ({ ...s, requests: next.map((x) => x.value).filter(isSpecialRequestCode) }))}
              allowCustom={false}
              disabled={!editable}
            />
            <AreaField id="pax-needs" name="needs" label="Other requirements" optional rows={2} maxLength={500} value={p.needs} onChange={(x) => setP((s) => ({ ...s, needs: x }))} disabled={!editable} />

            <fieldset className="m-0 flex min-w-0 flex-col gap-3.5 border-0 border-t border-line p-0 pt-4" disabled={!editable || identityLocked}>
              <legend className="float-left w-full p-0 text-base font-semibold text-ink">Private details</legend>
              <div className="clear-both flex gap-2.5 rounded-control border border-line bg-wash px-3.5 py-3 text-sm text-copy">
                <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />
                <p className="m-0">
                  {identityLocked
                    ? 'Save the passenger first to add these details.'
                    : 'Only the deal owner, the branch Manager and the Flight or Visa & Passport colleague who needs them see these. Purchase never does.'}
                </p>
              </div>
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
              {warning ? (
                <Notice tone="warning" role="status">
                  <p>{warning === 'age_too_high' ? BOOK_BATCH2_TEXT.ageTooHigh : BOOK_BATCH2_TEXT.ageTypeMismatch}</p>
                </Notice>
              ) : null}
            </fieldset>
          </form>
          {rowRefused ? <ResultBox result={passengersResult} fields={passengerRefs} /> : null}
          <ResultBox result={idf.state && !idf.state.ok ? idf.state : null} fields={IDENTITY_REFS} className="[&:empty]:hidden" />
        </DrawerBody>
        <DrawerFooter className="sticky bottom-0 bg-card" data-drawer-footer="">
          <div className="flex justify-end gap-2.5">
            <Button onClick={onClose} disabled={busy}>
              {editable ? 'Cancel' : 'Close'}
            </Button>
            {editable ? (
              <Button type="submit" form={FORM} variant="primary" loading={busy}>
                {busy ? 'Saving…' : 'Save passenger'}
              </Button>
            ) : null}
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** Other phone numbers of a passenger (optional; voice-note batch owner item 3). */
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
