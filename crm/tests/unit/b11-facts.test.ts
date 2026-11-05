import { describe, expect, it } from 'vitest';
import { ServiceFactsSchema } from '@/modules/fulfilment/commands';
import {
  ON_HOLD_SERVICE_TYPES,
  SERVICE_DEPARTMENT,
  SERVICE_FACT_KEYS,
  SERVICE_TYPES,
  type ServiceFacts,
} from '@/modules/fulfilment/contracts';
import { copyFacts, itemTitle, nextStepFor, computeProgress } from '@/modules/fulfilment/dto';
import { FIELD, parseServiceItemForm, validateServiceFacts } from '@/modules/fulfilment/forms';

/**
 * B1.1 service facts (appendix A §1.2): additive keys, visa and passport,
 * relaxed flight places and optional transfer vehicle/passengers. Old B1
 * facts stay valid and byte-identical. Synthetic values only.
 */

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const REQUEST = '77777777-7777-4777-8777-777777777777';

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}
const base = { dealId: DEAL, versionId: VERSION, rowVersion: '3', requestId: REQUEST };

const hotelB1 = { hotelName: 'Synthetic Palace', city: 'Jaipur', checkIn: '2026-11-01', checkOut: '2026-11-04', rooms: 1, adults: 2 };
const visa = { country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', applyBy: '2026-11-20', feePaidBy: 'customer', notes: null };
const passport = { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-12-01', notes: null };

describe('service types and departments', () => {
  it('visa and passport are service types for the Visa & Passport desk; train stays on hold', () => {
    expect(SERVICE_TYPES).toEqual(['hotel', 'transfer', 'activity', 'flight', 'visa', 'passport']);
    expect(ON_HOLD_SERVICE_TYPES).toEqual(['train']);
    expect(SERVICE_DEPARTMENT.visa).toBe('visa');
    expect(SERVICE_DEPARTMENT.passport).toBe('visa');
    expect(SERVICE_FACT_KEYS.visa).toEqual(['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes']);
  });
});

describe('validateServiceFacts (B1.1 keys)', () => {
  it('keeps B1 facts valid', () => {
    expect(validateServiceFacts('hotel', hotelB1)).toEqual([]);
    expect(validateServiceFacts('transfer', { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2 })).toEqual([]);
  });

  it('hotel: preferences mode needs preferences instead of a hotel name; child ages match children', () => {
    expect(validateServiceFacts('hotel', { ...hotelB1, hotelName: undefined, mode: 'preferences', preferences: 'Any 4-star near the fort' })).toEqual([]);
    expect(validateServiceFacts('hotel', { ...hotelB1, hotelName: undefined, mode: 'preferences' })).toEqual(['preferences']);
    expect(validateServiceFacts('hotel', { ...hotelB1, hotelName: undefined })).toEqual(['hotelName']);
    expect(validateServiceFacts('hotel', { ...hotelB1, mode: 'luxury' })).toEqual(['mode']);
    expect(validateServiceFacts('hotel', { ...hotelB1, children: 2, childAges: [4, 9] })).toEqual([]);
    expect(validateServiceFacts('hotel', { ...hotelB1, children: 2, childAges: [4] })).toEqual(['childAges']);
    expect(validateServiceFacts('hotel', { ...hotelB1, children: 1, childAges: [18] })).toEqual(['childAges']);
    expect(validateServiceFacts('hotel', { ...hotelB1, area: 'x'.repeat(121) })).toEqual(['area']);
  });

  it('transfer: route may come from pickup and drop; vehicle and passengers are optional', () => {
    expect(validateServiceFacts('transfer', { date: '2026-11-01', pickup: 'Airport', drop: 'Hotel' })).toEqual([]);
    expect(validateServiceFacts('transfer', { date: '2026-11-01', pickup: 'Airport' })).toEqual(['route']);
    expect(validateServiceFacts('transfer', { route: 'Airport to hotel', date: '2026-11-01', passengers: 0 })).toEqual(['passengers']);
  });

  it('flight: IATA or place names, leg flexibility, trip type and preferences', () => {
    const flight = {
      segments: [
        { from: 'DEL', to: 'Jodhpur', date: '2026-11-01', flex: '± 1 day' },
        { from: 'Jodhpur', to: 'DEL', date: '2026-11-05' },
      ],
      passengers: 2,
      tripType: 'return',
      preferences: 'Aisle seats',
      assistance: 'Wheelchair at arrival',
    };
    expect(validateServiceFacts('flight', flight)).toEqual([]);
    expect(validateServiceFacts('flight', { ...flight, tripType: 'circle' })).toEqual(['tripType']);
    expect(validateServiceFacts('flight', { ...flight, segments: [{ from: 'DEL', to: 'JAI', date: '2026-11-01', gate: 'A1' }] })).toEqual(['segments[0]']);
    expect(validateServiceFacts('flight', { ...flight, segments: [{ from: 'DEL', to: 'JAI', date: '2026-11-01', flex: 'x'.repeat(61) }] })).toEqual([
      'segments[0].flex',
    ]);
  });

  it('visa and passport: required keys, enums and apply-by on or before travel', () => {
    expect(validateServiceFacts('visa', visa)).toEqual([]);
    expect(validateServiceFacts('visa', { ...visa, applyBy: '2026-12-11' })).toEqual(['applyBy']);
    expect(validateServiceFacts('visa', { ...visa, feePaidBy: 'agent' })).toEqual(['feePaidBy']);
    expect(validateServiceFacts('visa', { ...visa, country: '' }).sort()).toEqual(['country']);
    expect(validateServiceFacts('passport', passport)).toEqual([]);
    expect(validateServiceFacts('passport', { ...passport, applicationType: 'express' })).toEqual(['applicationType']);
    expect(validateServiceFacts('passport', { ...passport, colour: 'blue' })).toEqual(['colour']);
  });
});

describe('ServiceFactsSchema (wire)', () => {
  it('parses visa, passport, hotel preferences, relaxed transfer and flight facts; refuses unknown keys', () => {
    expect(ServiceFactsSchema.parse({ type: 'visa', facts: visa })).toEqual({ type: 'visa', facts: visa });
    expect(ServiceFactsSchema.parse({ type: 'passport', facts: passport }).type).toBe('passport');
    expect(
      ServiceFactsSchema.parse({ type: 'hotel', facts: { ...hotelB1, hotelName: undefined, mode: 'preferences', preferences: 'Any 4-star' } }).type,
    ).toBe('hotel');
    expect(ServiceFactsSchema.safeParse({ type: 'hotel', facts: { ...hotelB1, hotelName: undefined } }).success).toBe(false);
    expect(ServiceFactsSchema.parse({ type: 'transfer', facts: { route: 'Airport to Hotel', date: '2026-11-01' } }).facts).toMatchObject({
      vehicleType: null,
      passengers: null,
    });
    expect(ServiceFactsSchema.safeParse({ type: 'visa', facts: { ...visa, passportNumber: 'K1234567' } }).success).toBe(false);
    expect(
      ServiceFactsSchema.parse({ type: 'flight', facts: { segments: [{ from: 'DEL', to: 'Goa North', date: '2026-11-01' }], passengers: 1 } }).type,
    ).toBe('flight');
  });

  it('copyFacts keeps B1 facts byte-identical (no B1.1 keys added) and copies B1.1 keys when present', () => {
    const b1 = ServiceFactsSchema.parse({ type: 'hotel', facts: hotelB1 });
    expect(Object.keys(copyFacts(b1).facts).sort()).toEqual(
      ['adults', 'checkIn', 'checkOut', 'children', 'city', 'hotelName', 'inclusions', 'mealPlan', 'roomType', 'rooms', 'specialRequests'].sort(),
    );
    const withAges = copyFacts(ServiceFactsSchema.parse({ type: 'hotel', facts: { ...hotelB1, children: 1, childAges: [5], area: 'Old city' } }));
    expect(withAges.facts).toMatchObject({ childAges: [5], area: 'Old city' });
  });

  it('titles: visa, passport, preferences hotel', () => {
    expect(itemTitle({ type: 'visa', facts: visa } as ServiceFacts)).toBe('Thailand · Tourism');
    expect(itemTitle({ type: 'passport', facts: passport } as ServiceFacts)).toBe('Passport (renewal) · Jodhpur');
    expect(itemTitle({ type: 'hotel', facts: { ...hotelB1, hotelName: null, mode: 'preferences', preferences: 'Any 4-star\nnear the fort' } } as ServiceFacts)).toBe(
      'Any 4-star, Jaipur',
    );
  });
});

describe('progress with the desk launch', () => {
  it('an accepted visa item without a task waits for the desk launch and stays outstanding', () => {
    expect(nextStepFor({ state: 'active', task: null, serviceType: 'visa' })).toBe('waiting_for_desk_launch');
    expect(nextStepFor({ state: 'active', task: null, serviceType: 'hotel' })).toBe('confirm_version');
    expect(nextStepFor({ state: 'active', task: { status: 'completed' }, serviceType: 'visa' })).toBe('done');
    const p = computeProgress([
      { state: 'active', task: null, serviceType: 'visa' },
      { state: 'active', task: { status: 'supplier_confirmed' }, serviceType: 'hotel' },
    ]);
    expect(p).toEqual({
      total: 2,
      byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 1, waitingForLaunch: 1 },
      fulfilled: false,
      staleCount: 0,
      needs: ['waiting_for_desk_launch'],
    });
    const done = computeProgress([
      { state: 'active', task: { status: 'completed' }, serviceType: 'passport' },
      { state: 'active', task: { status: 'supplier_confirmed' }, serviceType: 'hotel' },
    ]);
    expect(done.fulfilled).toBe(true);
    expect(done.byState).toEqual({ planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 1, completed: 1 });
  });
});

describe('parseServiceItemForm (B1.1)', () => {
  it('parses a visa item and repeated participant seqs', () => {
    const parsed = parseServiceItemForm(
      form({ ...base, serviceType: 'visa', country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', feePaidBy: 'company', participantSeq: ['2', '1'] }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        serviceType: 'visa',
        facts: { type: 'visa', facts: { country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', applyBy: null, feePaidBy: 'company', notes: null } },
        participantSeqs: [1, 2],
      },
    });
  });

  it('a passport needs a known application type; duplicate participant seqs are refused', () => {
    expect(parseServiceItemForm(form({ ...base, serviceType: 'passport', applicationType: 'express', officeCity: 'Jodhpur' }))).toEqual({
      ok: false,
      fields: [FIELD.applicationType],
    });
    expect(parseServiceItemForm(form({ ...base, serviceType: 'passport', applicationType: 'fresh', officeCity: 'Jodhpur', participantSeq: ['1', '1'] }))).toEqual({
      ok: false,
      fields: [FIELD.participantSeq],
    });
  });

  it('hotel preferences mode, child ages and flight legs with flexibility', () => {
    const hotel = parseServiceItemForm(
      form({
        ...base,
        serviceType: 'hotel',
        mode: 'preferences',
        preferences: 'Any 4-star near the fort',
        city: 'Jaipur',
        checkIn: '2026-11-01',
        checkOut: '2026-11-04',
        rooms: '1',
        adults: '2',
        children: '2',
        childAges: '4, 9',
      }),
    );
    expect(hotel).toMatchObject({ ok: true, value: { facts: { facts: { hotelName: null, mode: 'preferences', childAges: [4, 9] } } } });
    const flight = parseServiceItemForm(
      form({
        ...base,
        serviceType: 'flight',
        segmentFrom: ['del', 'Jodhpur'],
        segmentTo: ['Jodhpur', 'DEL'],
        segmentDate: ['2026-11-01', '2026-11-05'],
        segmentFlex: ['± 1 day', ''],
        passengers: '2',
        tripType: 'return',
        flightPreferences: 'Aisle',
      }),
    );
    expect(flight).toMatchObject({
      ok: true,
      value: {
        facts: {
          facts: {
            segments: [
              { from: 'DEL', to: 'Jodhpur', date: '2026-11-01', flex: '± 1 day' },
              { from: 'Jodhpur', to: 'DEL', date: '2026-11-05' },
            ],
            tripType: 'return',
            preferences: 'Aisle',
          },
        },
      },
    });
  });

  it('transfer with pickup and drop leaves the route to the database', () => {
    const parsed = parseServiceItemForm(form({ ...base, serviceType: 'transfer', pickup: 'Airport', drop: 'Hotel', date: '2026-11-01' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.facts.facts).not.toHaveProperty('route');
      expect(parsed.value.facts.facts).toMatchObject({ pickup: 'Airport', drop: 'Hotel', vehicleType: null, passengers: null });
    }
  });
});

describe('0500 desk processing step', () => {
  it('an in-progress visa task is with the desk, not waiting for a supplier', () => {
    expect(nextStepFor({ state: 'active', task: { status: 'in_progress' }, serviceType: 'passport' })).toBe('visa_processing');
    expect(nextStepFor({ state: 'active', task: { status: 'in_progress' }, serviceType: 'hotel' })).toBe('supplier_confirmation');
    const p = computeProgress([{ state: 'active', task: { status: 'in_progress' }, serviceType: 'visa' }]);
    expect(p.byState.inProgress).toBe(1);
    expect(p.needs).toEqual(['visa_processing']);
  });
});
