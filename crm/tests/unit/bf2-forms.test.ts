import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKING_FORM_FIELD as B,
  faresHintField,
  parseBookingServiceForm,
  parseFlightFaresForm,
  parseReturnFlightsForm,
  serviceHintField,
} from '@/modules/fulfilment/booking-form-forms';
import { requestItemsOk, validateServiceFacts } from '@/modules/fulfilment/forms';

/*
 * Book now v2 (26 October 2026): the service form parser's new inputs, the
 * fares and return-flight forms, the facts mirror and the two new actions
 * with a fake RPC client (own session only, ids and row versions back,
 * hints mapped to form names). Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const actions = await import('@/modules/fulfilment/server/flight-fares-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const ITEM = '33333333-3333-4333-8333-333333333333';
const FLIGHT_ITEM = '55555555-5555-4555-8555-555555555555';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const HASH = 'c'.repeat(64);
const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5', requestId: REQUEST };

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const hotelV2 = {
  ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '3', rooms: '1',
  roomType: 'Deluxe', mealPlan: 'Breakfast', inclusions: '', participantSeq: ['1', '2'], roomRateRupees: '5000',
};

describe('service parser: Book now v2 inputs', () => {
  it('hotel: requests for whom replace the text; no adults/children/budget posted; hidden keys left out', () => {
    const p = parseBookingServiceForm(form({ ...hotelV2, requestItemText: ['Baby cot', ' Early   check-in ', ''], requestItemFor: ['2', '', ''] }));
    if (!p.ok) throw new Error(p.fields.join());
    const f = p.value.facts.facts as unknown as Record<string, unknown>;
    expect(f.requestItems).toEqual([{ text: 'Baby cot', forSeq: 2 }, { text: 'Early check-in', forSeq: null }]);
    for (const key of ['specialRequests', 'adults', 'children', 'area', 'exclusions', 'bedRemarks', 'childAges']) expect(f).not.toHaveProperty(key);
    // D2: no budget input at all = null (the database sets it from the estimate).
    expect(p.value.budgetPaise).toBeNull();
    expect(p.value.participantSeqs).toEqual([1, 2]);
  });
  it('hotel: the marker with no request clears them; a request posted twice or too long is refused', () => {
    const cleared = parseBookingServiceForm(form({ ...hotelV2, requestItemsPosted: '1' }));
    if (!cleared.ok) throw new Error(cleared.fields.join());
    expect((cleared.value.facts.facts as unknown as Record<string, unknown>).requestItems).toEqual([]);
    const dup = parseBookingServiceForm(form({ ...hotelV2, requestItemText: ['Twin beds', 'twin beds'], requestItemFor: ['', ''] }));
    expect(dup.ok ? [] : dup.fields).toContain(`${B.requestItemText}[1]`);
    const long = parseBookingServiceForm(form({ ...hotelV2, requestItemText: ['x'.repeat(81)], requestItemFor: ['abc'] }));
    expect(long.ok ? [] : long.fields).toEqual(expect.arrayContaining([`${B.requestItemText}[0]`, `${B.requestItemFor}[0]`]));
  });
  it('hotel: an older screen that posts the text and an emptied area keeps today\'s meaning', () => {
    const p = parseBookingServiceForm(form({ ...hotelV2, specialRequests: 'Sea view', area: '' }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.facts.facts).toMatchObject({ specialRequests: 'Sea view', area: null });
  });
  it('flight from a screenshot: no legs, note, fare per person, passengers from the chosen people, return flag', () => {
    const p = parseBookingServiceForm(form({
      ...draft, serviceType: 'flight', entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option', participantSeq: ['1', '3'],
      fareAdultRupees: '6000', fareChildRupees: '4500.50', isReturn: '1', requestItemText: ['Wheelchair help'], requestItemFor: ['3'],
    }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.facts.facts).toMatchObject({ segments: [], passengers: 2, entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option',
      isReturn: true, requestItems: [{ text: 'Wheelchair help', forSeq: 3 }] });
    expect(p.value.facts.facts).not.toHaveProperty('preferences');
    expect(p.value.estimate).toEqual({ kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600000', fareChildPaise: '450050', fareInfantPaise: null });
  });
  it('typed flight: still needs a leg; a note is ignored in typed mode; a bad mode is refused', () => {
    const none = parseBookingServiceForm(form({ ...draft, serviceType: 'flight', participantSeq: ['1'] }));
    expect(none.ok ? [] : none.fields).toContain('segmentFrom');
    const typed = parseBookingServiceForm(form({ ...draft, serviceType: 'flight', entryMode: 'typed', screenshotNote: 'ignored', participantSeq: ['1'],
      segmentFrom: ['DEL'], segmentTo: ['JDH'], segmentDate: ['2026-12-10'] }));
    if (!typed.ok) throw new Error(typed.fields.join());
    expect(typed.value.facts.facts).not.toHaveProperty('entryMode');
    expect(typed.value.facts.facts).not.toHaveProperty('screenshotNote');
    const bad = parseBookingServiceForm(form({ ...draft, serviceType: 'flight', entryMode: 'photo', participantSeq: ['1'] }));
    expect(bad.ok ? [] : bad.fields).toContain('entryMode');
  });
  it('car: type and the flight it meets; empty = cleared; a wrong value is refused', () => {
    const car = { ...draft, serviceType: 'transfer', date: '2026-12-10', pickup: 'Jodhpur airport (JDH), flight SA 101', drop: 'Test Resort, Jodhpur' };
    const p = parseBookingServiceForm(form({ ...car, carKind: 'airport_pickup', flightItemId: FLIGHT_ITEM.toUpperCase() }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.facts.facts).toMatchObject({ carKind: 'airport_pickup', flightItemId: FLIGHT_ITEM });
    expect(p.value.facts.facts).not.toHaveProperty('includedKms');
    const cleared = parseBookingServiceForm(form({ ...car, carKind: 'full_trip', flightItemId: '', route: 'Jodhpur sightseeing' }));
    expect(cleared.ok && cleared.value.facts.facts).toMatchObject({ carKind: 'full_trip', flightItemId: null });
    const bad = parseBookingServiceForm(form({ ...car, carKind: 'boat', flightItemId: 'x' }));
    expect(bad.ok ? [] : bad.fields).toEqual(expect.arrayContaining(['carKind', 'flightItemId']));
  });
  it('visa and passport: dates the v2 drawers hide are left out (kept by the database)', () => {
    const visa = parseBookingServiceForm(form({ ...draft, itemId: ITEM, serviceType: 'visa', country: 'United Arab Emirates', purpose: 'Tourism',
      travelDate: '2026-12-10', feePaidBy: 'customer' }));
    expect(visa.ok && visa.value.facts.facts).not.toHaveProperty('applyBy');
    const passport = parseBookingServiceForm(form({ ...draft, itemId: ITEM, serviceType: 'passport', applicationType: 'renewal', officeCity: 'Jodhpur' }));
    expect(passport.ok && passport.value.facts.facts).not.toHaveProperty('neededBy');
  });
  it('maps the new database hints to form names', () => {
    expect(serviceHintField('requestItems')).toBe(B.requestItemText);
    expect(serviceHintField('estimate.fareChildPaise')).toBe(B.fareChildRupees);
    expect(serviceHintField('carKind')).toBe('carKind');
    expect(serviceHintField('screenshotNote')).toBe('screenshotNote');
    expect(faresHintField('fares.infantPaise')).toBe(B.fareInfantTotalRupees);
  });
});

describe('facts mirror (forms.ts)', () => {
  it('screenshot flights, requests and car keys', () => {
    expect(validateServiceFacts('flight', { segments: [], passengers: 1, entryMode: 'screenshot', screenshotNote: 'Note' })).toEqual([]);
    expect(validateServiceFacts('flight', { segments: [], passengers: 1 })).toContain('segments');
    expect(validateServiceFacts('flight', { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10' }], passengers: 1, screenshotNote: 'x' }))
      .toContain('screenshotNote');
    expect(validateServiceFacts('transfer', { route: 'A to B', date: '2026-12-10', vehicleType: null, passengers: null, carKind: 'boat' })).toContain('carKind');
    expect(requestItemsOk([{ text: 'Baby cot', forSeq: 2 }])).toBe(true);
    expect(requestItemsOk([{ text: 'Baby cot', forSeq: 0 }])).toBe(false);
    expect(requestItemsOk([{ text: 'A', forSeq: null }, { text: 'a', forSeq: null }])).toBe(false);
  });
});

describe('fares and return-flight forms', () => {
  it('fares: rupees to paise, empty = not typed, bad amounts named', () => {
    const p = parseFlightFaresForm(form({ ...draft, fareAdultTotalRupees: '14,000', fareChildTotalRupees: '' }));
    expect(p.ok && p.value.fares).toEqual({ adultPaise: '1400000', childPaise: null, infantPaise: null });
    const bad = parseFlightFaresForm(form({ ...draft, fareAdultTotalRupees: '-5', requestId: 'x' }));
    expect(bad.ok ? [] : bad.fields).toEqual(expect.arrayContaining([B.fareAdultTotalRupees, 'requestId']));
    expect(parseReturnFlightsForm(form({ ...draft, rowVersion: 'abc' })).ok).toBe(false);
  });
});

describe('actions', () => {
  it('saveFlightFaresAction: own session, ids back, hints mapped, price access refusal worded', async () => {
    rpc.mockResolvedValueOnce({ data: { rowVersion: 6, contentHash: HASH }, error: null });
    const ok = await actions.saveFlightFaresAction(null, form({ ...draft, fareAdultTotalRupees: '14000' }));
    expect(ok).toMatchObject({ ok: true, data: { rowVersion: 6, contentHash: HASH } });
    expect(rpc).toHaveBeenCalledWith('booking_flight_fares_save', { p_version_id: VERSION, p_expected_row_version: 5,
      p_fares: { adultPaise: '1400000', childPaise: null, infantPaise: null }, p_request_id: REQUEST });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid_input', hint: 'fares.childPaise' } });
    expect(await actions.saveFlightFaresAction(null, form({ ...draft, fareChildTotalRupees: '1' }))).toMatchObject({ ok: false, code: 'invalid_input',
      fields: [B.fareChildTotalRupees] });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await actions.saveFlightFaresAction(null, form({ ...draft, fareAdultTotalRupees: '1' }))).toMatchObject({ ok: false, code: 'not_authorized' });
  });
  it('addReturnFlightsAction: outcomes and messages; trip end and revision refusals', async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: 'added', itemIds: [ITEM, FLIGHT_ITEM], itemNos: [5, 6], rowVersion: 9, contentHash: HASH }, error: null });
    const added = await actions.addReturnFlightsAction(null, form(draft));
    expect(added).toMatchObject({ ok: true, data: { outcome: 'added', itemNos: [5, 6] }, message: '2 return flights added. Add the flight number and times.' });
    expect(rpc).toHaveBeenCalledWith('booking_flight_returns_add', { p_version_id: VERSION, p_expected_row_version: 5, p_request_id: REQUEST });
    rpc.mockResolvedValueOnce({ data: { outcome: 'no_typed_flights', itemIds: [], itemNos: [], rowVersion: 5, contentHash: HASH }, error: null });
    expect(await actions.addReturnFlightsAction(null, form(draft))).toMatchObject({ ok: true, data: { outcome: 'no_typed_flights' } });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid_input', hint: 'tripEnd' } });
    expect(await actions.addReturnFlightsAction(null, form(draft))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['tripEnd'] });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '55000', message: 'revision_items_fixed' } });
    expect(await actions.addReturnFlightsAction(null, form(draft))).toMatchObject({ ok: false, code: 'revision_items_fixed' });
  });
});
