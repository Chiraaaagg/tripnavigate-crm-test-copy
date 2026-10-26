import { describe, expect, it } from 'vitest';
import { FIELD, parseServiceItemForm, parseTravellersForm, parseWorkflowSettingForm, readRequestId } from '@/modules/fulfilment/forms';

/** B1 form parsers: typed values are kept, and the invalid field list names the inputs to highlight. */

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const ITEM = '33333333-3333-4333-8333-333333333333';
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

describe('parseServiceItemForm', () => {
  it('parses a hotel item with rupees → paise and trimmed text', () => {
    const parsed = parseServiceItemForm(
      form({ ...base, serviceType: 'hotel', hotelName: '  Synthetic Palace ', city: 'Jaipur', checkIn: '2026-11-01', checkOut: '2026-11-04', rooms: '1', adults: '2', children: '', purchaseBudgetRupees: '45,000.50' }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        versionId: VERSION,
        expectedRowVersion: 3,
        itemId: null,
        serviceType: 'hotel',
        facts: {
          type: 'hotel',
          facts: { hotelName: 'Synthetic Palace', city: 'Jaipur', checkIn: '2026-11-01', checkOut: '2026-11-04', rooms: 1, adults: 2, roomType: null, mealPlan: null, children: null, inclusions: null, specialRequests: null },
        },
        purchaseBudgetPaise: '4500050',
        requestId: REQUEST,
        // B1.1: no participantSeq inputs → participation unchanged.
        participantSeqs: null,
      },
    });
  });

  it('parses transfer and activity items; an empty budget is 0; a saved item carries itemId', () => {
    const transfer = parseServiceItemForm(form({ ...base, itemId: ITEM, serviceType: 'transfer', route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: '2', pickupTime: '09:30' }));
    expect(transfer).toMatchObject({
      ok: true,
      value: { itemId: ITEM, purchaseBudgetPaise: '0', facts: { type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2, pickupTime: '09:30', notes: null } } },
    });
    const activity = parseServiceItemForm(form({ ...base, serviceType: 'activity', name: 'City walk', city: 'Jaipur', date: '2026-11-02', participants: '4', time: '', notes: 'bring hats' }));
    expect(activity).toMatchObject({ ok: true, value: { facts: { type: 'activity', facts: { name: 'City walk', city: 'Jaipur', date: '2026-11-02', participants: 4, time: null, notes: 'bring hats' } } } });
  });

  it('parses flight segments from parallel arrays, upper-casing codes and skipping blank rows', () => {
    const parsed = parseServiceItemForm(
      form({
        ...base,
        serviceType: 'flight',
        segmentFrom: ['del', 'JAI', ''],
        segmentTo: ['jai', 'DEL', ''],
        segmentDate: ['2026-11-01', '2026-11-04', ''],
        passengers: '3',
        cabin: 'Economy',
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        facts: {
          type: 'flight',
          facts: {
            segments: [
              { from: 'DEL', to: 'JAI', date: '2026-11-01' },
              { from: 'JAI', to: 'DEL', date: '2026-11-04' },
            ],
            passengers: 3,
            cabin: 'Economy',
            preferredTime: null,
            notes: null,
          },
        },
      },
    });
  });

  it('names every invalid field, including flight rows and cross-field rules', () => {
    const hotel = parseServiceItemForm(form({ ...base, serviceType: 'hotel', hotelName: '', city: 'Jaipur', checkIn: '2026-11-04', checkOut: '2026-11-04', rooms: '0', adults: '2', purchaseBudgetRupees: 'abc' }));
    expect(hotel).toEqual({ ok: false, fields: [FIELD.purchaseBudgetRupees, FIELD.hotelName, FIELD.rooms] });
    // Cross-field rules run once every field converts.
    const dates = parseServiceItemForm(form({ ...base, serviceType: 'hotel', hotelName: 'H', city: 'Jaipur', checkIn: '2026-11-04', checkOut: '2026-11-04', rooms: '1', adults: '2' }));
    expect(dates).toEqual({ ok: false, fields: [FIELD.checkOut] });

    const flight = parseServiceItemForm(
      form({ ...base, serviceType: 'flight', segmentFrom: ['DEL', 'J1'], segmentTo: ['JAI', 'DEL'], segmentDate: ['2026-11-04', '2026-11-01'], passengers: '3' }),
    );
    expect(flight).toEqual({ ok: false, fields: ['segmentFrom[1]'] });
    const order = parseServiceItemForm(form({ ...base, serviceType: 'flight', segmentFrom: ['DEL', 'JAI'], segmentTo: ['JAI', 'DEL'], segmentDate: ['2026-11-04', '2026-11-01'], passengers: '3' }));
    expect(order).toEqual({ ok: false, fields: ['segmentDate[1]'] });
    const none = parseServiceItemForm(form({ ...base, serviceType: 'flight', passengers: '3' }));
    expect(none).toEqual({ ok: false, fields: [FIELD.segmentFrom] });
  });

  it('refuses on-hold and unknown service types with the serviceType field, and bad ids', () => {
    expect(parseServiceItemForm(form({ ...base, serviceType: 'train' }))).toEqual({ ok: false, fields: [FIELD.serviceType] });
    expect(parseServiceItemForm(form({ ...base, serviceType: 'train' }))).toEqual({ ok: false, fields: [FIELD.serviceType] });
    expect(parseServiceItemForm(form({ ...base, rowVersion: 'x', itemId: 'nope', requestId: 'bad', serviceType: 'spa' }))).toEqual({
      ok: false,
      fields: [FIELD.rowVersion, FIELD.itemId, FIELD.requestId, FIELD.serviceType],
    });
  });

  it('never reads identity from the form and ignores extra fields', () => {
    const parsed = parseServiceItemForm(
      form({ ...base, serviceType: 'transfer', route: 'A to B', date: '2026-11-01', vehicleType: 'Sedan', passengers: '2', userId: 'x', legalEntityId: 'y', sellingTotalRupees: '100' }),
    );
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/userId|legalEntityId|selling/);
  });
});

describe('parseTravellersForm', () => {
  it('builds travellers from parallel arrays, skipping blank rows and numbering seq 1..n', () => {
    const parsed = parseTravellersForm(form({ dealId: DEAL, rowVersion: '2', travellerName: [' Synthetic  Adult ', '', 'Synthetic Child'], travellerType: ['adult', '', 'child'] }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        expectedRowVersion: 2,
        travellers: [
          { fullName: 'Synthetic Adult', type: 'adult', seq: 1 },
          { fullName: 'Synthetic Child', type: 'child', seq: 2 },
        ],
      },
    });
  });

  it('allows an empty list (clears travellers) and names invalid rows', () => {
    expect(parseTravellersForm(form({ dealId: DEAL, rowVersion: '0' }))).toEqual({ ok: true, value: { dealId: DEAL, expectedRowVersion: 0, travellers: [] } });
    const bad = parseTravellersForm(form({ dealId: DEAL, rowVersion: '1', travellerName: ['Only name', '', 'x'.repeat(121)], travellerType: ['', 'infant', 'adult'] }));
    expect(bad).toEqual({ ok: false, fields: ['travellerType[0]', 'travellerName[1]', 'travellerName[2]'] });
    expect(parseTravellersForm(form({ dealId: DEAL, rowVersion: '1', travellerName: ['A'], travellerType: ['pet'] }))).toEqual({ ok: false, fields: ['travellerType[0]'] });
  });

  it('refuses more than 100 travellers', () => {
    const names = Array.from({ length: 101 }, (_, i) => `Traveller ${i}`);
    const parsed = parseTravellersForm(form({ dealId: DEAL, rowVersion: '1', travellerName: names, travellerType: names.map(() => 'adult') }));
    expect(parsed).toEqual({ ok: false, fields: [FIELD.travellerName] });
  });
});

describe('parseWorkflowSettingForm and readRequestId', () => {
  it('parses a switch with its reason', () => {
    expect(parseWorkflowSettingForm(form({ settingKey: 'service_items_enabled', settingValue: 'on', reason: '  Pilot for Jodhpur,   one salesperson only ' }))).toEqual({
      ok: true,
      value: { key: 'service_items_enabled', value: true, reason: 'Pilot for Jodhpur, one salesperson only' },
    });
    expect(parseWorkflowSettingForm(form({ settingKey: 'intake_prompt_enabled', settingValue: 'off', reason: 'Switching off after the pilot.' }))).toMatchObject({ ok: true, value: { value: false } });
  });

  it('names the invalid fields: unknown key, bad value, short or long reason', () => {
    expect(parseWorkflowSettingForm(form({ settingKey: 'real_booking_enabled', settingValue: 'yes', reason: 'short' }))).toEqual({
      ok: false,
      fields: [FIELD.settingKey, FIELD.settingValue, FIELD.reason],
    });
    expect(parseWorkflowSettingForm(form({ settingKey: 'service_items_enabled', settingValue: 'on', reason: 'r'.repeat(501) }))).toEqual({ ok: false, fields: [FIELD.reason] });
  });

  it('readRequestId accepts only a UUID', () => {
    expect(readRequestId(form({ requestId: REQUEST }))).toBe(REQUEST);
    expect(readRequestId(form({ requestId: 'x' }))).toBeNull();
    expect(readRequestId(form({}))).toBeNull();
  });
});
