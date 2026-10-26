'use client';

import { CalendarDays, Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { SuggestMultiSelect, type SuggestItem } from '@/components/ui/suggest-multiselect';
import { HOTEL_REQUEST_SUGGESTIONS, REQUEST_ITEMS_MAX, REQUEST_TEXT_MAX, type HotelEstimate } from '@/modules/fulfilment/booking-form-contract';
import { addDays, formatInr, hotelEstimatePaise, isIsoDate, parseCount, paiseToRupeesText, requestItemsFromStored, rupeesToPaise, stayNights } from '@/modules/fulfilment/booking-form-model';
import { AreaField, SelectField, TextField } from '../b11/controls';
import { dateText } from '../b11/book-fields';
import { refusalReason } from './autosave-queue';
import { useFormToast } from './form-toast';
import { appendParticipants, appendRequests, EditorShell, initialWho, useLiveProblem, WhoChips, type EditorEnv } from './service-editor';
import { plural, requestFormFields, str, toSuggestItems } from './service-model';
import type { HotelOption } from './vn-types';

/*
 * Hotel drawer (Book now v2, change 16, revised after the owner's review):
 * City and Hotel; Check-in, Nights and Check-out; Who stays here; Room and
 * meals (room category, meal plan, rooms and nightly rates with the
 * occupancy line and the cost estimate); Requests (special requests with
 * "for everyone / for <name>", then inclusions, exclusions or other notes).
 * Nothing under More details. Check-in starts at the last hotel's check-out
 * and nights fill the rest of the trip. Removed from the screen: "Customer
 * asked for", area, bed remarks, purchase budget (set by the server from
 * "Our cost", owner decision D2); stored values stay on older items.
 * Adults and children follow the people chosen (change 6).
 */

const MEAL_PLANS = ['Room only', 'Breakfast', 'Breakfast + dinner', 'All meals', 'Other'];
const OPTIONS = HOTEL_REQUEST_SUGGESTIONS.map((s) => ({ value: s, label: s }));
const RATE_ROWS = [
  { qty: 'rooms', rate: 'roomRate', label: 'Rooms', one: 'room', post: ['rooms', 'roomRateRupees'] },
  { qty: 'extra', rate: 'extraRate', label: 'Extra beds', one: 'extra bed', post: ['extraBeds', 'extraBedRateRupees'] },
  { qty: 'nobed', rate: 'nobedRate', label: 'No bed', one: 'no-bed guest', post: ['childrenWithoutBed', 'noBedRateRupees'] },
] as const;

export function HotelEditor({ env }: { env: EditorEnv }) {
  const toast = useFormToast();
  const src = env.item ?? env.copyOf;
  const f = src?.facts ?? null;
  const est = src?.estimate?.estimate?.kind === 'hotel' ? (src.estimate.estimate as HotelEstimate) : null;
  const hotels = env.items.filter((i) => i.serviceType === 'hotel').sort((a, b) => a.itemNo - b.itemNo);
  const prev = hotels.at(-1) ?? null;
  const isNew = !env.item;
  const isCopy = Boolean(env.copyOf);
  // Older free text that cannot become requests stays as it is (read-only, not posted).
  const storedReqs = requestItemsFromStored({ requestItems: f?.requestItems, text: f?.specialRequests });
  const startIn = prev ? str(prev.facts.checkOut) : env.trip.start;
  const left = env.trip.end && isIsoDate(startIn) ? stayNights(startIn, env.trip.end) : null;
  const [v, setV] = useState(() => ({
    city: str(f?.city),
    hotel: str(f?.hotelName),
    hotelId: str(f?.hotelId),
    checkin: src ? str(f?.checkIn) : startIn,
    nights: src ? String(stayNights(str(f?.checkIn), str(f?.checkOut)) ?? '') : left ? String(left) : '',
    room: str(f?.roomType),
    meal: str(f?.mealPlan),
    rooms: src ? str(f?.rooms) || '1' : '1',
    extra: str(f?.extraBeds) || '0',
    nobed: str(f?.childrenWithoutBed) || '0',
    roomRate: paiseToRupeesText(est?.roomRatePaise ?? null),
    extraRate: paiseToRupeesText(est?.extraBedRatePaise ?? null),
    nobedRate: paiseToRupeesText(est?.noBedRatePaise ?? null),
    notes: str(f?.inclusions),
    reqs: toSuggestItems(storedReqs ?? []) as SuggestItem[],
    who: initialWho(env, 'hotel'),
  }));
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [busy, setBusy] = useState(false);
  const nights = parseCount(v.nights);
  const checkOut = isIsoDate(v.checkin) && nights !== null && nights >= 1 && nights <= 365 ? addDays(v.checkin, nights) : '';
  const live = useLiveProblem(() =>
    !v.city.trim() ? 'Add the city.' : !v.hotel.trim() ? 'Add the hotel name.' : !isIsoDate(v.checkin) ? 'Add the check-in date.' : !(nights !== null && nights >= 1 && nights <= 365) ? 'Nights: 1 to 365.' : !(Number(v.rooms) >= 1) ? 'Add at least one room.' : RATE_ROWS.some((r) => v[r.rate].trim() !== '' && rupeesToPaise(v[r.rate]) === undefined) ? 'Enter a valid amount, with at most two decimal places.' : '',
  );
  const p = (k: 'roomRate' | 'extraRate' | 'nobedRate') => {
    const r = rupeesToPaise(v[k]);
    return typeof r === 'string' ? r : null;
  };
  const estimate = hotelEstimatePaise({ nights: v.nights, rooms: v.rooms, extraBeds: v.extra || '0', noBedGuests: v.nobed || '0', roomRatePaise: p('roomRate'), extraBedRatePaise: p('extraRate'), noBedRatePaise: p('nobedRate') });
  const parts = RATE_ROWS.filter((r) => Number(v[r.qty]) > 0);
  const chosen = v.who.map((s) => env.travellers.find((t) => String(t.seq) === s)).filter(Boolean);
  const people = chosen.length;
  const rooms = Number(v.rooms) || 0;
  const reqPeople = env.people.filter((x) => v.who.includes(x.value));

  const save = async () => {
    if (!live.gate()) return;
    setBusy(true);
    const r = await env.save((fd) => {
      fd.set('mode', 'specific');
      fd.set('city', v.city.trim());
      fd.set('hotelName', v.hotel.trim());
      fd.set('hotelId', v.hotelId);
      fd.set('checkIn', v.checkin);
      fd.set('nights', v.nights.trim());
      fd.set('checkOut', checkOut);
      fd.set('roomType', v.room.trim());
      fd.set('mealPlan', v.meal);
      fd.set('rooms', v.rooms.trim());
      fd.set('extraBeds', v.extra.trim() || '0');
      fd.set('childrenWithoutBed', v.nobed.trim() || '0');
      if (env.estimatesVisible) {
        fd.set('roomRateRupees', v.roomRate.trim());
        fd.set('extraBedRateRupees', v.extraRate.trim());
        fd.set('noBedRateRupees', v.nobedRate.trim());
      }
      fd.set('inclusions', v.notes);
      // Change 6: the server works out adults and children from the people chosen.
      appendParticipants(fd, v.who);
      if (storedReqs !== null) {
        fd.set('requestItemsPosted', '1');
        appendRequests(fd, requestFormFields(v.reqs, v.who));
      }
    }, v);
    setBusy(false);
    if (r.ok) {
      toast('Hotel saved.');
      env.onClose();
    } else live.setServer(refusalReason(r));
  };

  const preferencesOnly = str(f?.mode) === 'preferences' && !str(f?.hotelName);
  return (
    <EditorShell title={isNew ? 'Add hotel stay' : 'Edit hotel stay'} saveLabel="Save hotel" editable={env.editable} busy={busy} problem={live.problem} onSave={save} onClose={env.onClose}>
      {isCopy ? (
        <div className="flex gap-2.5 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-sm text-copy">
          <Copy aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
          <p className="m-0">Copy of a stay. Check the dates.</p>
        </div>
      ) : null}
      {preferencesOnly ? <p className="m-0 text-sm text-quiet">Saved as preferences: {str(f?.preferences)}. Add the hotel name to save this stay.</p> : null}
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        <TextField id="svc-city" name="city" label="City" value={v.city} onChange={(x) => set('city', x)} maxLength={120} disabled={!env.editable} />
        {env.searchHotels ? (
          <Field htmlFor="svc-hotelName" label="Hotel" hint="Not in the hotel list? Keep typing the name; Purchase checks it.">
            <SearchCombobox<HotelOption>
              id="svc-hotelName"
              name="hotelName"
              value={v.hotel}
              placeholder="Type 2 letters to search"
              onValueChange={(x) => setV((s) => ({ ...s, hotel: x, hotelId: '' }))}
              search={(q) => env.searchHotels!(q, { city: v.city })}
              keyOf={(h) => h.hotelId}
              textOf={(h) => [h.name, h.city, h.area, h.category].filter(Boolean).join(', ')}
              renderOption={(h) => (
                <>
                  <span className="font-semibold text-ink">{h.name}</span>
                  <span className="text-sm text-quiet">{[h.city, h.area, h.category].filter(Boolean).join(' · ')}</span>
                </>
              )}
              onPick={(h) => setV((s) => ({ ...s, hotel: h.name, hotelId: h.hotelId, city: s.city.trim().toLowerCase() === h.city.toLowerCase() ? s.city : h.city }))}
              noMatchText="Not in the hotel list. Keep typing the name; Purchase checks it."
              maxLength={200}
              aria-describedby={fieldDescribedBy('svc-hotelName', { hint: true })}
              disabled={!env.editable}
            />
          </Field>
        ) : (
          <Field htmlFor="svc-hotelName" label="Hotel" hint="Not in the hotel list? Keep typing the name; Purchase checks it.">
            <Input id="svc-hotelName" value={v.hotel} onChange={(e) => set('hotel', e.target.value)} maxLength={200} placeholder="Type 2 letters to search" aria-describedby={fieldDescribedBy('svc-hotelName', { hint: true })} disabled={!env.editable} />
          </Field>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2 sm:grid-cols-3">
        <TextField id="svc-checkIn" name="checkIn" label="Check-in" type="date" value={v.checkin} onChange={(x) => set('checkin', x)} disabled={!env.editable} />
        <TextField id="svc-nights" name="nights" label="Nights" inputMode="numeric" value={v.nights} onChange={(x) => set('nights', x)} maxLength={3} disabled={!env.editable} />
        <div className="flex flex-col gap-1.5">
          <span className="font-semibold text-ink">Check-out</span>
          <p className="m-0 flex min-h-10 items-center gap-1.5" aria-live="polite">
            <CalendarDays aria-hidden="true" className="size-4 text-quiet" />
            {checkOut ? dateText(checkOut) : 'Set check-in and nights'}
          </p>
        </div>
      </div>
      {prev && isNew && !isCopy ? <p className="m-0 -mt-1.5 text-sm text-quiet">Check-in starts at the last hotel’s check-out. Nights fill the rest of the trip.</p> : null}
      <WhoChips env={env} label="Who stays here" value={v.who} onChange={(x) => set('who', x)} />
      <section aria-labelledby="svc-rooms-heading" className="flex flex-col gap-3.5 border-t border-line pt-4">
        <h3 id="svc-rooms-heading" className="m-0 text-base font-semibold text-ink">
          Room and meals
        </h3>
        <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
          <Field htmlFor="svc-roomType" label="Room category" optional>
            <Input id="svc-roomType" value={v.room} onChange={(e) => set('room', e.target.value)} maxLength={120} placeholder="For example: Deluxe" disabled={!env.editable} />
          </Field>
          <SelectField id="svc-mealPlan" name="mealPlan" label="Meal plan" optional value={v.meal} onChange={(x) => set('meal', x)} options={[{ value: '', label: 'Choose' }, ...MEAL_PLANS.map((m) => ({ value: m, label: m })), ...(v.meal && !MEAL_PLANS.includes(v.meal) ? [{ value: v.meal, label: v.meal }] : [])]} disabled={!env.editable} />
        </div>
        <div className="flex justify-between">
          <span className="font-semibold text-ink">{env.estimatesVisible ? 'Rooms and nightly rates' : 'Rooms and beds'}</span>
          {env.estimatesVisible ? <span className="text-sm text-quiet">INR · per night</span> : null}
        </div>
        <div className={env.estimatesVisible ? 'grid grid-cols-[minmax(5.625rem,1fr)_4.375rem_minmax(6.875rem,1fr)] items-center gap-x-3 gap-y-2 max-sm:grid-cols-[minmax(4.375rem,0.9fr)_3.5rem_minmax(6rem,1fr)]' : 'grid grid-cols-[minmax(5.625rem,1fr)_4.375rem] items-center gap-x-3 gap-y-2'}>
          <span />
          <span className="text-xs font-medium text-quiet">Qty</span>
          {env.estimatesVisible ? <span className="text-xs font-medium text-quiet">Our cost</span> : null}
          {RATE_ROWS.map((r) => (
            <div key={r.qty} className="contents">
              <span className="text-sm font-medium text-copy">{r.label}</span>
              <Input id={`svc-${r.post[0]}`} inputMode="numeric" aria-label={`${r.label}: quantity`} value={v[r.qty]} onChange={(e) => set(r.qty, e.target.value)} maxLength={2} disabled={!env.editable} />
              {env.estimatesVisible ? <MoneyInput id={`svc-${r.post[1]}`} aria-label={`${r.label}: our cost per night`} value={v[r.rate]} onChange={(e) => set(r.rate, e.target.value)} disabled={!env.editable} /> : null}
            </div>
          ))}
        </div>
        <p className="m-0 text-sm text-quiet" aria-live="polite">
          {people > 0 ? (
            <>
              {plural(people, 'person', 'people')} · {plural(rooms, 'room')}
              {rooms > 0 && people / rooms > 3 ? (
                <span className="text-status-warning">
                  {' · '}
                  <TriangleAlert aria-hidden="true" className="inline size-3.5 align-[-2px]" /> more than 3 per room, check beds
                </span>
              ) : null}
            </>
          ) : null}
        </p>
        {env.estimatesVisible ? (
          <div className="rounded-control bg-wash px-3.5 py-3" aria-live="polite">
            <span className="text-sm text-quiet">Estimated supplier cost</span>
            <strong className="my-0.5 block text-xl font-semibold text-ink tabular-nums">{estimate ? formatInr(estimate) : 'Not priced'}</strong>
            {estimate ? <span className="text-sm text-quiet">{`${v.nights} nights × (${parts.map((r) => `${v[r.qty]} ${r.one}${Number(v[r.qty]) > 1 ? 's' : ''} × ${formatInr(rupeesToPaise(v[r.rate]) ?? null)}`).join(' + ')})`}</span> : null}
            <p className="m-0 text-sm text-quiet">An estimate only. It is not a price, a budget or a booking.</p>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="svc-requests-heading" className="flex flex-col gap-3.5 border-t border-line pt-4">
        <h3 id="svc-requests-heading" className="m-0 text-base font-semibold text-ink">
          Requests
        </h3>
        {storedReqs === null ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-ink">Special requests</span>
            <p className="m-0 rounded-control bg-wash px-3 py-2.5 text-sm text-copy">{str(f?.specialRequests)}</p>
            <p className="m-0 text-sm text-quiet">Saved before as free text, so it stays as it is.</p>
          </div>
        ) : (
        <SuggestMultiSelect
          id="svc-hotel-requests"
          label="Special requests"
          hint="Choose from the list or type your own and press Enter. Change “for everyone” to pick one person."
          options={OPTIONS}
          items={v.reqs}
          onChange={(x) => set('reqs', x)}
          people={reqPeople}
          maxItems={REQUEST_ITEMS_MAX}
          maxLength={REQUEST_TEXT_MAX}
          disabled={!env.editable}
        />
        )}
        <AreaField id="svc-inclusions" name="inclusions" label="Inclusions, exclusions or other notes" optional hint="Purchase reads this. Do not type the customer price." rows={2} maxLength={2000} value={v.notes} onChange={(x) => set('notes', x)} disabled={!env.editable} />
      </section>
    </EditorShell>
  );
}
