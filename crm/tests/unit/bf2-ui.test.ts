import { describe, expect, it } from 'vitest';
import rows from '@/lib/airports/airports.json';
import { airportsFromRows, findAirport, searchAirports, type AirportRow } from '@/lib/airports/search';
import { createSerialQueue } from '@/views/booking-form/autosave-queue';
import { carFillFromFlight, carKindOf, chipPeople, fareTotal, fareTypes, flyersOf, itemLabels, nextFlightFrom, requestFormFields, requestText, threeHoursBefore, travText, unnamedLine } from '@/views/booking-form/service-model';
import { readyBucket, readyItems } from '@/views/booking-form/ready-list';
import { planIssues } from '@/views/booking-form/before-submit';
import { priceBlock } from '@/views/booking-form/package-price-card';
import { billToIssues } from '@/views/booking-form/bill-to-card';
import { customerIssues, postedTotal, type CustomerValues } from '@/views/booking-form/customer-trip-card';
import type { BookingFormServiceItemView } from '@/modules/fulfilment/booking-form-contract';

/*
 * Book now v2 screens (Agent A): the pure rules behind the prototype's
 * behaviour. Synthetic data only.
 */

const airports = airportsFromRows(rows as unknown as AirportRow[]);

describe('airport list and search (change 3)', () => {
  it('holds scheduled-service airports with the prototype names first', () => {
    expect(airports.length).toBeGreaterThan(3500);
    expect(airports[0]).toMatchObject({ c: 'DEL', city: 'Delhi', name: 'Indira Gandhi International' });
    expect(findAirport(airports, 'dps')?.city).toBe('Bali (Denpasar)');
    expect(findAirport(airports, 'DHM')?.city).toBe('Dharamshala');
    expect(new Set(airports.map((a) => a.c)).size).toBe(airports.length);
  });
  it('finds by code, city, name and "City (CODE)"', () => {
    expect(searchAirports(airports, 'JDH')[0]?.c).toBe('JDH');
    expect(searchAirports(airports, 'jodhpur').map((a) => a.c)).toContain('JDH');
    expect(searchAirports(airports, 'Jodhpur (JDH)')).toEqual([findAirport(airports, 'JDH')]);
    expect(searchAirports(airports, 'Kempegowda')[0]?.c).toBe('BLR');
    expect(searchAirports(airports, 'del')[0]?.c).toBe('DEL');
    expect(searchAirports(airports, 'a').length).toBeLessThanOrEqual(8);
    expect(searchAirports(airports, '   ')).toEqual([]);
  });
  it('ranks prototype rows first, folds accents and covers Indian airports (review round 1)', () => {
    const goa = searchAirports(airports, 'goa').map((a) => a.c);
    expect(goa.slice(0, 2).sort()).toEqual(['GOI', 'GOX']);
    expect(goa.indexOf('GOA')).toBeGreaterThan(1);
    expect(searchAirports(airports, 'agra')[0]?.c).toBe('AGR');
    expect(searchAirports(airports, 'male')[0]?.c).toBe('MLE');
    expect(findAirport(airports, 'SLV')).not.toBeNull();
    expect(findAirport(airports, 'BKB')?.city).toBe('Bikaner');
    expect(searchAirports(airports, 'shimla')[0]?.c).toBe('SLV');
    expect(findAirport(airports, 'SLV')?.city).toBe('Shimla');
    expect(searchAirports(airports, 'shirdi')[0]?.c).toBe('SAG');
    expect(searchAirports(airports, 'kozhikode')[0]?.c).toBe('CCJ');
  });
});

describe('page save queue (change 2)', () => {
  it('runs one save at a time, in order, and keeps going after a failure', async () => {
    const run = createSerialQueue();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((resolve, reject) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          if (fail) reject(new Error(name));
          else resolve(name);
        }, ms);
      });
    const a = run(job('a', 20));
    const b = run(job('b', 1, true));
    const c = run(job('c', 1));
    await expect(a).resolves.toBe('a');
    await expect(b).rejects.toThrow('b');
    await expect(c).resolves.toBe('c');
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
});

const item = (no: number, serviceType: BookingFormServiceItemView['serviceType'], facts: Record<string, unknown> = {}, extra: Partial<BookingFormServiceItemView> = {}): BookingFormServiceItemView => ({ itemId: `id-${no}`, itemNo: no, serviceType, facts, summary: '', participants: [1, 2], locked: false, ...extra });
const travellers = [
  { seq: 1, fullName: 'Traveller A', type: 'adult' as const },
  { seq: 2, fullName: 'Traveller B', type: 'adult' as const },
  { seq: 3, fullName: 'Child C', type: 'child' as const },
];

describe('step 2 rules', () => {
  it('numbers rows per service type (change 11)', () => {
    const labels = itemLabels([item(1, 'hotel'), item(2, 'flight'), item(3, 'hotel'), item(4, 'transfer')]);
    expect([...labels.values()]).toEqual(['Hotel 1', 'Flight 1', 'Hotel 2', 'Car 1']);
  });
  it('chips list named passengers only, with the unnamed line (D4)', () => {
    expect(chipPeople([...travellers, { seq: 4, fullName: ' ', type: 'adult' as const }]).map((p) => p.label)).toEqual(['Traveller A', 'Traveller B', 'Child C']);
    expect(unnamedLine(5, 3)).toBe('2 travellers not named yet. Name them in step 1.');
    expect(unnamedLine(3, 3)).toBeNull();
    expect(travText([1, 2, 3], 3)).toBe('All 3 travellers');
    expect(travText([1], 3)).toBe('1 traveller');
  });
  it('requests read "for <name>" and fall back to the stored text', () => {
    expect(requestText({ requestItems: [{ text: 'Baby cot', forSeq: 3 }, { text: 'Early check-in', forSeq: null }] }, 'specialRequests', travellers)).toBe('Baby cot (Child C), Early check-in');
    expect(requestText({ specialRequests: 'Sea view' }, 'specialRequests', travellers)).toBe('Sea view');
    // A person no longer on the service, or the only person on it, posts "everyone".
    expect(requestFormFields([{ value: 'Baby cot', forKey: '3' }, { value: 'Late check-out', forKey: '9' }], ['1', '3'])).toEqual([
      { text: 'Baby cot', forSeq: '3' },
      { text: 'Late check-out', forSeq: '' },
    ]);
  });
  it('car kind of older cars and the fill rules (change 14)', () => {
    expect(carKindOf({ carKind: 'airport_drop' })).toBe('airport_drop');
    expect(carKindOf({ route: 'Jodhpur – Jaisalmer' })).toBe('full_trip');
    expect(carKindOf({ pickup: 'A', drop: 'B' })).toBe('point_to_point');
    expect(threeHoursBefore('01:30')).toBe('22:30');
    expect(threeHoursBefore('14:05')).toBe('11:05');
    const hotels = [{ hotelName: 'Sample Palace', city: 'Jodhpur', checkIn: '2026-11-03', checkOut: '2026-11-06' }];
    const leg = { from: 'DEL', to: 'JDH', date: '2026-11-03', arrivalDate: '', flightNo: '6E 123', departTime: '08:10', arriveTime: '10:40' };
    expect(carFillFromFlight('airport_pickup', leg, hotels, airports)).toEqual({ pickup: 'Jodhpur airport (JDH), flight 6E 123', date: '2026-11-03', time: '10:40', drop: 'Sample Palace, Jodhpur' });
    const back = { ...leg, from: 'JDH', to: 'DEL', date: '2026-11-06', departTime: '09:00' };
    expect(carFillFromFlight('airport_drop', back, hotels, airports)).toEqual({ drop: 'Jodhpur airport (JDH), flight 6E 123', date: '2026-11-06', time: '06:00', pickup: 'Sample Palace, Jodhpur' });
  });
  it('next flight starts where the last one lands (change 7)', () => {
    expect(nextFlightFrom({ from: 'DEL', to: 'JDH', date: '2026-11-03', arrivalDate: '2026-11-04', flightNo: '', departTime: '', arriveTime: '' })).toEqual({ from: 'JDH', date: '2026-11-04' });
  });
  it('fare totals add up, ask, or name the flights without a fare (change 18)', () => {
    const fare = (a: string | null, c: string | null) => ({ estimate: { kind: 'flight' as const, fareTotalPaise: null, fareAdultPaise: a, fareChildPaise: c, fareInfantPaise: null }, totalPaise: null });
    const f1 = item(1, 'flight', {}, { participants: [1, 2, 3], estimate: fare('600000', '450000') });
    const f2 = item(2, 'flight', {}, { participants: [1, 2, 3], estimate: fare('800000', null) });
    expect(fareTypes({ children: 1, infants: 0 })).toEqual(['adult', 'child']);
    expect(fareTotal([f1, f2], 'adult', travellers, null)).toEqual({ auto: true, paise: '1400000', missing: [] });
    expect(fareTotal([f1, f2], 'child', travellers, null)).toEqual({ auto: false, paise: null, missing: [2] });
    const none = item(3, 'flight', {}, { participants: [1, 2], estimate: fare(null, null) });
    expect(fareTotal([none], 'adult', travellers, { adultPaise: '1200000', childPaise: null, infantPaise: null })).toEqual({ auto: false, paise: '1200000', missing: [] });
    expect(flyersOf([f1, f2], 'adult', travellers)).toBe(2);
    expect(flyersOf([f1, f2], 'child', travellers)).toBe(1);
  });
});

const customer = (over: Partial<CustomerValues> = {}): CustomerValues => ({
  contactName: 'Sample Customer',
  mobile: '9876500012',
  email: '',
  contactConfirmed: true,
  destination: 'Himachal',
  scope: 'domestic',
  start: '2026-11-03',
  end: '2026-11-09',
  paxTotal: '',
  adults: '2',
  children: '1',
  infants: '0',
  customerType: '',
  market: '',
  ...over,
});

describe('cards that save themselves: their checks', () => {
  it('customer card saves only when every check passes (D1)', () => {
    expect(customerIssues(customer(), null)).toEqual([]);
    expect(customerIssues(customer({ contactConfirmed: false }), null)).toEqual(['Check the mobile or email with the customer, then tick the box.']);
    expect(customerIssues(customer({ adults: '' }), null)[0]).toBe('Enter the number of adults.');
    expect(customerIssues(customer({ mobile: '', email: '' }), null)[0]).toBe('Enter a mobile number or email.');
    expect(postedTotal(customer(), null)).toBe('3');
  });
  it('price card is blocked until step 1 is saved and children are split (change 8)', () => {
    const party = { total: 3, children: 1, infants: 0, adults: 2 };
    expect(priceBlock(party, false, [])).toBe('Save step 1 first. Prices follow the saved traveller counts.');
    expect(priceBlock(party, true, [{ category: 'child_bed', quantity: '0', purchase: '', markup: '', sale: '' }])).toBe('Split all 1 child into with bed or without bed.');
    expect(priceBlock(party, true, [{ category: 'child_bed', quantity: '1', purchase: '', markup: '', sale: '' }])).toBeNull();
  });
  it('plan and Bill To checks use the live wording', () => {
    expect(planIssues([{ label: 'Advance', amount: '5000', due: '2026-10-30' }])).toEqual([]);
    expect(planIssues([{ label: '', amount: '', due: '' }])).toEqual([]);
    expect(planIssues([{ label: 'Advance', amount: '', due: '' }])).toEqual(['Instalment 1: amount in rupees.', 'Instalment 1: due date.']);
    expect(billToIssues({ type: 'personal', name: 'A', contactPerson: '', phone: '9876500012', email: '', addressLine1: '1 Road', addressLine2: '', city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstStatus: '', gstin: '', gstReason: '' })).toEqual([]);
    expect(billToIssues({ type: 'business', name: 'A', contactPerson: '', phone: '', email: '', addressLine1: '', addressLine2: '', city: '', stateCode: '', postalCode: '012345', gstStatus: '', gstin: '', gstReason: '' })).toHaveLength(7);
  });
});

describe('Before you submit (change 9)', () => {
  it('routes server rows to the seven items and never hides a blocking row', () => {
    expect(readyBucket({ code: 'id_proof_missing', section: 'passengers' })).toBe('id');
    expect(readyBucket({ code: 'plan_total_mismatch' as never, section: 'submit' })).toBe('plan');
    expect(readyBucket({ code: 'quote_details_changed', section: 'submit' })).toBe('ok');
    const done = { done: true, why: null };
    const all = { s1: done, id: done, s2: done, price: done, bill: done, plan: done, ok: done };
    const items = readyItems([{ code: 'hotel_nights_missing', blocking: true, section: 'services', text: '1 trip night has no hotel.' } as never], all);
    expect(items.map((i) => i.done)).toEqual([true, true, false, true, true, true, true]);
    expect(items[2]!.why).toBe('1 trip night has no hotel.');
  });
});
