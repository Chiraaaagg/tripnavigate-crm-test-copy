import { describe, expect, it } from 'vitest';
import {
  farePerPersonText,
  flightFareEstimatePaise,
  flightFareGapText,
  flightFareSummary,
  requestItemsFromStored,
  requestItemsText,
  type FlightFareRow,
} from '@/modules/fulfilment/booking-form-model';
import { estimateView, itemLabelsByNo } from '@/modules/fulfilment/booking-form-vm';

/*
 * Book now v2 (26 October 2026) model rules: fare per person on each flight,
 * "Total fare per person, all flights", request text "for whom" and item
 * labels per service type. Amounts are paise strings (whole paise, no floats).
 */

const fares = (adult: string | null, child: string | null = null, infant: string | null = null) =>
  ({ fareAdultPaise: adult, fareChildPaise: child, fareInfantPaise: infant });

describe('one flight', () => {
  it('Σ fare × travellers of each type; a type with travellers needs its fare; no fare per person = the older total', () => {
    expect(flightFareEstimatePaise({ ...fares('600000', '450000'), counts: { adult: 2, child: 1, infant: 0 } })).toBe('1650000');
    expect(flightFareEstimatePaise({ ...fares('600000'), counts: { adult: 2, child: 1, infant: 0 } })).toBeNull();
    expect(flightFareEstimatePaise({ ...fares(null), fareTotalPaise: '2000000', counts: { adult: 2, child: 0, infant: 0 } })).toBe('2000000');
    expect(flightFareEstimatePaise({ ...fares('600000'), counts: { adult: 0, child: 0, infant: 0 } })).toBeNull();
    expect(farePerPersonText(fares('600000', '450000'))).toBe('Fare per person: Adult ₹6,000 · Child ₹4,500');
    expect(farePerPersonText(fares(null))).toBeNull();
  });
  it('estimateView totals a flight by its travellers (counts), else shows the older total', () => {
    const est = { kind: 'flight' as const, fareTotalPaise: null, ...fares('600000', '450000') };
    expect(estimateView('flight', {}, est, { adult: 2, child: 1, infant: 0 }).totalPaise).toBe('1650000');
    expect(estimateView('flight', {}, { ...est, fareTotalPaise: '900000' }).totalPaise).toBe('900000');
  });
});

describe('Total fare per person, all flights', () => {
  const a = (seq: number) => ({ seq, type: 'adult' as const });
  const c = (seq: number) => ({ seq, type: 'child' as const });
  const rows: FlightFareRow[] = [
    { label: 'Flight 1', fares: fares('600000', '450000'), travellers: [a(1), a(2), c(3)] },
    { label: 'Flight 2', fares: fares('800000', '600000'), travellers: [a(1), a(2), c(3)] },
  ];
  it('adds itself up when every flight carrying a type has a fare (the preview example)', () => {
    const s = flightFareSummary(rows, null);
    expect(s.types.find((t) => t.type === 'adult')).toMatchObject({ mode: 'sum', travellers: 2, perPersonPaise: '1400000', totalPaise: '2800000' });
    expect(s.types.find((t) => t.type === 'child')).toMatchObject({ mode: 'sum', travellers: 1, perPersonPaise: '1050000', totalPaise: '1050000' });
    expect(s.types.find((t) => t.type === 'infant')!.mode).toBe('none');
    expect(s.allFlightsPaise).toBe('3850000');
  });
  it('typed when no flight has a fare (one ticket with a layover); missing until typed', () => {
    const noFare = rows.map((r) => ({ ...r, fares: fares(null) }));
    expect(flightFareSummary(noFare, null).types[0]).toMatchObject({ mode: 'missing', perPersonPaise: null });
    const typed = flightFareSummary(noFare, { adultPaise: '1400000', childPaise: '1050000', infantPaise: null });
    expect(typed.types[0]).toMatchObject({ mode: 'typed', totalPaise: '2800000' });
    expect(typed.allFlightsPaise).toBe('3850000');
  });
  it('partial: names the flights still missing a fare; the all-flights total waits', () => {
    const partial = [rows[0]!, { ...rows[1]!, fares: fares(null, '600000') }];
    const s = flightFareSummary(partial, { adultPaise: '999', childPaise: null, infantPaise: null });
    const adult = s.types[0]!;
    expect(adult).toMatchObject({ mode: 'partial', missingFlights: ['Flight 2'], totalPaise: null });
    expect(flightFareGapText(adult)).toBe('Adult: flight 2 has no fare yet');
    expect(s.allFlightsPaise).toBeNull();
  });
  it('counts each traveller once even when they fly several legs; only types that fly are shown', () => {
    const s = flightFareSummary([{ label: 'Flight 1', fares: fares('100'), travellers: [a(1)] }, { label: 'Flight 2', fares: fares('200'), travellers: [a(1)] }], null);
    expect(s.types[0]).toMatchObject({ travellers: 1, perPersonPaise: '300', totalPaise: '300' });
    expect(s.allFlightsPaise).toBe('300');
  });
});

describe('requests "for whom"', () => {
  it('render as the database does', () => {
    const names = new Map([[3, 'Child C']]);
    expect(requestItemsText([{ text: 'Wheelchair help', forSeq: 3 }, { text: 'Vegetarian meal', forSeq: null }], (s) => names.get(s)))
      .toBe('Wheelchair help (Child C), Vegetarian meal');
  });
  it('stored items are used as they are; older text becomes requests for everyone when it fits, else null', () => {
    expect(requestItemsFromStored({ requestItems: [{ text: 'Baby cot', forSeq: 2 }], text: 'ignored' })).toEqual([{ text: 'Baby cot', forSeq: 2 }]);
    expect(requestItemsFromStored({ text: 'Sea view, Late check-out' })).toEqual([{ text: 'Sea view', forSeq: null }, { text: 'Late check-out', forSeq: null }]);
    expect(requestItemsFromStored({ text: '' })).toEqual([]);
    expect(requestItemsFromStored({ text: 'x'.repeat(81) })).toBeNull();
    expect(requestItemsFromStored({ text: 'A, a' })).toBeNull();
  });
});

describe('item labels (change 11)', () => {
  it('number items within each service type by item number', () => {
    const labels = itemLabelsByNo([
      { itemNo: 4, serviceType: 'hotel' }, { itemNo: 1, serviceType: 'hotel' }, { itemNo: 2, serviceType: 'flight' }, { itemNo: 3, serviceType: 'transfer' },
    ]);
    expect([...labels.entries()]).toEqual([[1, 'Hotel 1'], [2, 'Flight 1'], [3, 'Car 1'], [4, 'Hotel 2']]);
  });
});
