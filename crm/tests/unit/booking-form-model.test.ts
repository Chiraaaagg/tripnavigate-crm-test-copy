import { describe, expect, it } from 'vitest';
import {
  addDays,
  billToForSave,
  billToFromCustomer,
  billToIssues,
  bookingPriceLines,
  carEstimatePaise,
  customerIssues,
  CUSTOMER_LIST_TEXT,
  CustomerListError,
  editPrice,
  emptyBillTo,
  emptyPriceLines,
  flightEstimatePaise,
  formatInr,
  gstinMatchesState,
  hotelCoverage,
  hotelEstimatePaise,
  isBelowPurchase,
  paiseToRupeesText,
  parseCustomerList,
  partyCounts,
  priceIssues,
  priceLinesForSave,
  priceLinesFromSaved,
  priceTotals,
  readCustomerListText,
  rupeesToPaise,
  searchCustomerList,
  serviceIssues,
  stayNights,
  switchBillToType,
  tripNights,
  visiblePriceCategories,
  type BillToInput,
  type CustomerInput,
  type PriceLineInput,
  type ServiceItemFacts,
} from '@/modules/fulfilment/booking-form-model';

/*
 * Booking form model: the approved preview's focused checks (checks/model-check.mjs)
 * ported to production shapes, plus Mercury's money-privacy-copy.md part C cases
 * (P, H, C, V, B). Synthetic values only.
 */

const STATES = [
  { code: '08', name: 'Rajasthan' },
  { code: '27', name: 'Maharashtra' },
];

const adult = (over: Partial<PriceLineInput> = {}): PriceLineInput => ({ category: 'adult', quantity: '2', purchase: '10000', markup: '2000', sale: '12000', ...over });
const code = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('money parsing (P9, P10, P16)', () => {
  it('reads rupees to whole paise and keeps missing apart from zero', () => {
    expect(rupeesToPaise('0.01')).toBe('1');
    expect(rupeesToPaise('0')).toBe('0');
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('   ')).toBeNull();
    expect(rupeesToPaise('1,234.56')).toBe('123456');
    expect(rupeesToPaise('1,00,000')).toBe('10000000');
  });
  it('refuses decimals, signs, exponents and symbols', () => {
    for (const bad of ['1.001', '-1', '1e3', '₹100', '1,2', ',100', '12.']) expect(rupeesToPaise(bad), bad).toBeUndefined();
  });
  it('allows a leading minus only for a derived markup', () => {
    expect(rupeesToPaise('-1000.50', { signed: true })).toBe('-100050');
  });
  it('caps one amount at 99,99,99,999.99 rupees', () => {
    expect(rupeesToPaise('999999999.99')).toBe('99999999999');
    expect(rupeesToPaise('1000000000')).toBeUndefined();
  });
  it('turns paise back into the same text (P10)', () => {
    expect(paiseToRupeesText('123456')).toBe('1234.56');
    expect(paiseToRupeesText('1300000')).toBe('13000');
    expect(paiseToRupeesText(null)).toBe('');
    expect(formatInr('2400000')).toBe('₹24,000');
    expect(formatInr(null)).toBe('Not priced');
  });
});

describe('dates', () => {
  it('adds days on real dates only', () => {
    expect(addDays('2026-10-25', 2)).toBe('2026-10-27');
    expect(addDays('2026-02-30', 1)).toBe('');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-22', 9_999_999_999)).toBe('');
  });
  it('counts tour and stay nights', () => {
    expect(tripNights('2026-10-25', '2026-10-31')).toBe(6);
    expect(tripNights('2026-10-31', '2026-10-25')).toBeNull();
    expect(stayNights('2026-10-25', '2026-10-25')).toBeNull();
    expect(stayNights('2026-10-25', '2026-10-27')).toBe(2);
  });
});

describe('per-person prices (P1–P8, P11–P12, P15–P18, P20)', () => {
  it('P1: purchase plus markup gives the sale and the total', () => {
    const t = priceTotals([adult()]);
    expect(t.salePaise).toBe('2400000');
    expect(t.purchasePaise).toBe('2000000');
    expect(t.markupPaise).toBe('400000');
  });
  it('P2–P4: the three approved edit directions', () => {
    expect(editPrice(adult(), 'purchase', '11000')).toEqual(adult({ purchase: '11000', sale: '13000.00' }));
    expect(editPrice(adult(), 'markup', '3000')).toEqual(adult({ markup: '3000', sale: '13000.00' }));
    expect(editPrice(adult(), 'sale', '15000')).toEqual(adult({ sale: '15000', markup: '5000.00' }));
  });
  it('P5: a sale below purchase keeps a negative markup, never clamped', () => {
    const line = editPrice(adult(), 'sale', '9000');
    expect(line.markup).toBe('-1000.00');
    expect(isBelowPurchase(line)).toBe(true);
    expect(code(priceIssues(partyCounts({ total: 2, children: 0, infants: 0 }), [line]))).toContain('price_below_purchase');
  });
  it('P6: clearing purchase leaves the sale missing, not zero', () => {
    const line = editPrice(adult(), 'purchase', '');
    expect(line.sale).toBe('');
    expect(priceTotals([line]).salePaise).toBeNull();
    expect(code(priceIssues(partyCounts({ total: 2, children: 0, infants: 0 }), [line]))).toContain('price_missing');
  });
  it('P7: markup starts empty; a typed 0 is valid', () => {
    expect(emptyPriceLines().every((l) => l.markup === '' && l.sale === '')).toBe(true);
    const typed = editPrice({ category: 'adult', quantity: '1', purchase: '', markup: '', sale: '' }, 'purchase', '5000');
    expect(typed.sale).toBe('');
    expect(editPrice(typed, 'markup', '0').sale).toBe('5000.00');
  });
  it('P8: an infant at zero is valid and adds nothing', () => {
    const lines = [adult(), { category: 'infant' as const, quantity: '1', purchase: '0', markup: '0', sale: '0' }];
    expect(priceTotals(lines).salePaise).toBe('2400000');
    expect(priceIssues(partyCounts({ total: 3, children: 0, infants: 1 }), bookingPriceLines(partyCounts({ total: 3, children: 0, infants: 1 }), lines))).toEqual([]);
  });
  it('P11: adult and infant counts follow the party; children must be split', () => {
    const party = partyCounts({ total: '4', children: '1', infants: '1' });
    expect(party).toEqual({ total: 4, children: 1, infants: 1, adults: 2 });
    const typed = emptyPriceLines().map((p) => ({ ...p, quantity: p.category === 'child_bed' ? '1' : '0', purchase: '10000', markup: '2000', sale: '12000' }));
    const lines = bookingPriceLines(party, typed);
    expect(lines.map((p) => p.quantity)).toEqual(['2', '1', '0', '1']);
    expect(priceIssues(party, lines)).toEqual([]);
    expect(visiblePriceCategories(party)).toEqual(['adult', 'child_bed', 'child_no_bed', 'infant']);
  });
  it('P12 / P15: a missing child split or a wrong sum is a count mismatch', () => {
    const party = partyCounts({ total: '4', children: '1', infants: '1' });
    const typed = emptyPriceLines().map((p) => ({ ...p, purchase: '1', markup: '0', sale: '1' }));
    expect(code(priceIssues(party, bookingPriceLines(party, typed)))).toContain('price_count_mismatch');
    const tooMany = bookingPriceLines(party, typed.map((p) => (p.category === 'child_bed' || p.category === 'child_no_bed' ? { ...p, quantity: '1' } : p)));
    expect(code(priceIssues(party, tooMany))).toContain('price_count_mismatch');
  });
  it('P17: 100 adults at the cap stays exact', () => {
    expect(priceTotals([adult({ quantity: '100', purchase: '999999999.99', markup: '0', sale: '999999999.99' })]).salePaise).toBe('9999999999900');
  });
  it('P18: all sales zero → total zero (the server reports not priced)', () => {
    expect(priceTotals([adult({ purchase: '0', markup: '0', sale: '0' })]).salePaise).toBe('0');
  });
  it('P20: no children → child rows cleared; hidden categories never add money', () => {
    const party = partyCounts({ total: '2', children: '0', infants: '0' });
    const lines = bookingPriceLines(party, emptyPriceLines().map((p) => ({ ...p, quantity: '1', purchase: '1', markup: '1', sale: '2' })));
    expect(lines.filter((p) => p.category !== 'adult').map((p) => [p.quantity, p.sale])).toEqual([['0', ''], ['0', ''], ['0', '']]);
    expect(visiblePriceCategories(party)).toEqual(['adult']);
  });
  it('a line with people but no amount makes the total unknown', () => {
    expect(priceTotals([adult({ sale: '' })]).salePaise).toBeNull();
    expect(priceTotals([adult({ quantity: '0', sale: '' })]).salePaise).toBe('0');
  });
  it('save shape and reload round trip', () => {
    const saved = priceLinesForSave(bookingPriceLines(partyCounts({ total: 2, children: 0, infants: 0 }), [adult({ purchase: '1,234.56', markup: '0', sale: '1234.56' })]));
    expect(saved?.[0]).toEqual({ category: 'adult', quantity: 2, purchasePaise: '123456', markupPaise: '0', salePaise: '123456' });
    expect(saved?.map((l) => l.category)).toEqual(['adult', 'child_bed', 'child_no_bed', 'infant']);
    expect(priceLinesFromSaved(saved)[0]).toEqual({ category: 'adult', quantity: '2', purchase: '1234.56', markup: '0', sale: '1234.56' });
    expect(priceLinesForSave([adult({ purchase: '1.001' })])).toBeUndefined();
  });
});

describe('supplier estimates (H1–H4, C1)', () => {
  const stay = { nights: 2, rooms: 2, extraBeds: 2, noBedGuests: 1, roomRatePaise: '1000000', extraBedRatePaise: '200000', noBedRatePaise: '100000' };
  it('H1: the owner example is ₹50,000', () => expect(hotelEstimatePaise(stay)).toBe('5000000'));
  it('H2: an unknown needed rate is not priced', () => expect(hotelEstimatePaise({ ...stay, extraBedRatePaise: null })).toBeNull());
  it('H3: a rate is not needed for a zero count', () => expect(hotelEstimatePaise({ ...stay, extraBeds: 0, noBedGuests: 0, extraBedRatePaise: null, noBedRatePaise: null })).toBe('4000000'));
  it('H4: nights out of range', () => {
    for (const nights of [0, 366, '9999999999']) expect(hotelEstimatePaise({ ...stay, nights })).toBeNull();
  });
  it('C1: car = vehicles × rate', () => {
    expect(carEstimatePaise(2, '2500000')).toBe('5000000');
    expect(carEstimatePaise(0, '2500000')).toBeNull();
    expect(carEstimatePaise(2, null)).toBeNull();
    expect(flightEstimatePaise(null)).toBeNull();
    expect(flightEstimatePaise('0')).toBe('0');
  });
});

describe('hotel coverage and service dates (V1–V8, C2)', () => {
  const start = '2026-10-25';
  const end = '2026-10-31';
  const hotel = (id: string, checkIn: string, nights: number): ServiceItemFacts => ({ id, serviceType: 'hotel', facts: { checkIn, checkOut: addDays(checkIn, nights), hotelName: 'Test hotel', city: 'Test city' } });
  it('V1: six covered nights', () => expect(hotelCoverage(start, end, [{ id: 'a', checkIn: start, nights: 6 }])).toEqual({ nights: 6, covered: 6, missing: [], outside: [] }));
  it('V2: parallel rows count once', () => expect(hotelCoverage(start, end, [{ id: 'a', checkIn: start, nights: 6 }, { id: 'b', checkIn: start, nights: 6 }]).covered).toBe(6));
  it('V3: equal summed nights cannot hide a gap', () => {
    expect(hotelCoverage(start, end, [{ id: 'a', checkIn: start, nights: 3 }, { id: 'b', checkIn: '2026-10-29', nights: 3 }]).missing).toEqual(['2026-10-28']);
    expect(code(serviceIssues({ start, end }, [hotel('a', start, 3), hotel('b', '2026-10-29', 3)]))).toContain('hotel_nights_missing');
  });
  it('V4: stays outside the trip', () => {
    expect(hotelCoverage(start, end, [{ id: 'a', checkIn: start, nights: 7 }]).outside).toEqual(['a']);
    expect(hotelCoverage(start, end, [{ id: 'a', checkIn: '2026-10-24', nights: 6 }]).outside).toEqual(['a']);
    expect(code(serviceIssues({ start, end }, [hotel('a', start, 7)]))).toContain('hotel_outside_trip');
  });
  it('V5: a same-day trip cannot have a hotel', () => expect(code(serviceIssues({ start, end: start }, [hotel('a', start, 1)]))).toContain('hotel_same_day_trip'));
  it('V6 / V7: flight-only and visa-only need no hotel; visa dates may be outside', () => {
    expect(serviceIssues({ start, end }, [{ id: 'f', serviceType: 'flight', facts: { segments: [{ from: 'DEL', to: 'GOI', date: start }] } }])).toEqual([]);
    expect(serviceIssues({ start, end }, [{ id: 'v', serviceType: 'visa', facts: { country: 'Test', travelDate: start, applyBy: '2026-09-01' } }])).toEqual([]);
  });
  it('V8 / flight checks: local times never compared; dates and places are', () => {
    const seg = { from: 'DEL', to: 'DXB', date: start, departTime: '23:00', arriveTime: '01:00' };
    expect(serviceIssues({ start, end }, [{ id: 'f', serviceType: 'flight', facts: { segments: [seg] } }])).toEqual([]);
    expect(code(serviceIssues({ start, end }, [{ id: 'f', serviceType: 'flight', facts: { segments: [{ ...seg, to: 'del' }] } }]))).toContain('flight_same_place');
    expect(code(serviceIssues({ start, end }, [{ id: 'f', serviceType: 'flight', facts: { segments: [{ ...seg, arrivalDate: '2026-10-24' }] } }]))).toContain('service_dates_outside_trip');
  });
  it('C2: car dates reversed or outside the trip', () => {
    const car = (date: string, endDate: string): ServiceItemFacts => ({ id: 'c', serviceType: 'transfer', facts: { date, endDate, quantity: 1, route: 'A to B' } });
    expect(serviceIssues({ start, end }, [car(start, end)])).toEqual([]);
    expect(code(serviceIssues({ start, end }, [car(start, '2026-11-01')]))).toContain('service_dates_outside_trip');
    expect(code(serviceIssues({ start, end }, [car(end, start)]))).toContain('service_dates_outside_trip');
  });
  it('no services at all', () => expect(code(serviceIssues({ start, end }, []))).toEqual(['no_services']));
});

describe('customer and passengers (preview conditions 1–7)', () => {
  const c: CustomerInput = { contactName: 'Riya Mehta', mobile: '98765 43210', email: '', destination: 'Test city', tripStart: '2026-10-25', tripEnd: '2026-10-31', paxTotal: '4', children: '1', infants: '1' };
  it('a complete customer has no issues', () => expect(customerIssues(c, [])).toEqual([]));
  it('children and infants cannot exceed the total', () => expect(code(customerIssues({ ...c, children: '5' }, []))).toContain('pax_split_invalid'));
  it('more named infants than declared', () => {
    expect(code(customerIssues(c, [{ name: 'Infant one', type: 'infant' }, { name: 'Infant two', type: 'infant' }]))).toContain('pax_types_exceeded');
  });
  it('total 1 to 100', () => {
    expect(code(customerIssues({ ...c, paxTotal: '101' }, []))).toContain('pax_missing');
    expect(code(customerIssues({ ...c, paxTotal: '' }, []))).toContain('pax_missing');
  });
  it('mobile or email, with formats', () => {
    expect(code(customerIssues({ ...c, mobile: '', email: '' }, []))).toContain('contact_reach_missing');
    expect(code(customerIssues({ ...c, mobile: '12345' }, []))).toContain('mobile_format');
    expect(code(customerIssues({ ...c, email: 'nope' }, []))).toContain('email_format');
  });
  it('birth and marriage dates', () => {
    expect(code(customerIssues(c, [{ name: 'A', type: 'adult', dateOfBirth: '2027-01-01' }]))).toContain('dob_invalid');
    expect(code(customerIssues(c, [{ name: 'A', type: 'adult', dateOfBirth: '1990-01-01', dateOfMarriage: '1980-01-01' }]))).toContain('dom_invalid');
    expect(code(customerIssues(c, [{ name: '', type: 'adult' }]))).toContain('traveller_name_incomplete');
  });
});

describe('Bill To (B7–B10, B17)', () => {
  const personal: BillToInput = { ...emptyBillTo(), name: 'Riya Mehta', phone: '9876543210', addressLine1: 'Test street 1', city: 'Jodhpur', stateCode: '08', postalCode: '342001' };
  const business: BillToInput = { ...personal, type: 'business', name: 'Test Travels Pvt Ltd', contactPerson: 'Riya Mehta', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5' };
  it('personal and registered business pass', () => {
    expect(billToIssues(personal)).toEqual([]);
    expect(billToIssues(business)).toEqual([]);
  });
  it('B7: GSTIN must match the state', () => {
    expect(gstinMatchesState('08ABCDE1234F1Z5', '08')).toBe(true);
    expect(code(billToIssues({ ...business, stateCode: '27' }))).toContain('gstin_invalid');
    expect(code(billToIssues({ ...business, gstin: 'bad' }))).toContain('gstin_invalid');
    expect(code(billToIssues({ ...business, gstin: '' }))).toContain('gstin_missing');
  });
  it('B8: unregistered needs a 10–500 character reason and no GSTIN is saved', () => {
    const un = { ...business, gstStatus: 'unregistered' as const, gstReason: 'Not registered' };
    expect(billToIssues(un)).toEqual([]);
    expect(billToForSave(un).gstin).toBe('');
    expect(code(billToIssues({ ...un, gstReason: '123456789' }))).toContain('gst_reason_missing');
  });
  it('B9 / B10: GST choice, contact name and reach', () => {
    expect(code(billToIssues({ ...business, gstStatus: '' }))).toContain('gst_status_missing');
    expect(code(billToIssues({ ...business, contactPerson: '' }))).toContain('billing_contact_missing');
    expect(code(billToIssues({ ...personal, phone: '', email: '' }))).toContain('billing_reach_missing');
    expect(code(billToIssues({ ...personal, postalCode: '000000' }))).toContain('billing_pin_invalid');
    expect(code(billToIssues({ ...personal, stateCode: '' }))).toContain('billing_state_missing');
  });
  it('B17: clicking the chosen type erases nothing; switching keeps address and reach', () => {
    expect(switchBillToType(business, 'business')).toBe(business);
    const switched = switchBillToType(business, 'personal');
    expect(switched).toMatchObject({ type: 'personal', name: '', gstStatus: '', phone: business.phone, city: business.city, stateCode: '08' });
    expect(billToForSave({ ...personal, gstStatus: 'registered', gstin: '08ABCDE1234F1Z5' })).toMatchObject({ gstStatus: '', gstin: '' });
  });
});

describe('customer list (B1–B6)', () => {
  const rows = [
    { id: 'C-1', type: 'personal', name: 'Riya Mehta', phone: '9876543210', city: 'Jodhpur', state: 'Rajasthan', pin: '342001', address: 'Test street 1' },
    { id: 'C-2', type: 'personal', name: 'Riya Mehta', email: 'riya@example.com' },
    { id: 'B-1', type: 'business', name: 'Test Travels', gstRegistered: true, gstin: '08abcde1234f1z5', password: 'ignored' },
  ];
  it('B1: similar names stay separate and searchable by id', () => {
    const list = parseCustomerList(rows);
    const found = searchCustomerList(list, 'riya');
    expect(found.matches.map((r) => r.id)).toEqual(['C-1', 'C-2']);
    expect(searchCustomerList(list, 'c-2').matches.map((r) => r.id)).toEqual(['C-2']);
    expect(searchCustomerList(list, 'r').total).toBe(0);
    const { billTo, outsideIndia } = billToFromCustomer(list[0]!, STATES);
    expect(outsideIndia).toBe(false);
    expect(billTo).toMatchObject({ name: 'Riya Mehta', stateCode: '08', postalCode: '342001' });
    expect(Object.keys(billTo)).not.toContain('id');
  });
  it('B2: a file over 1 MB is refused before reading', () => {
    expect(() => readCustomerListText('[]', 1024 * 1024 + 1)).toThrow(CUSTOMER_LIST_TEXT.tooLarge);
    expect(() => readCustomerListText('{oops', 10)).toThrow(CUSTOMER_LIST_TEXT.notJson);
  });
  it('B3: more than 1,000 rows', () => {
    expect(() => parseCustomerList(Array.from({ length: 1001 }, (_, i) => ({ id: `x${i}`, type: 'personal', name: 'N' })))).toThrow(CustomerListError);
  });
  it('B4: duplicate ids', () => expect(() => parseCustomerList([rows[0]!, rows[0]!])).toThrow(CUSTOMER_LIST_TEXT.duplicateId));
  it('B5: extra keys are ignored; GSTIN upper-cased', () => {
    const b = parseCustomerList(rows)[2]!;
    expect(Object.keys(b)).not.toContain('password');
    expect(b).toMatchObject({ gstStatus: 'registered', gstin: '08ABCDE1234F1Z5' });
  });
  it('B6: a 501-character field and a bad type are refused', () => {
    expect(() => parseCustomerList([{ ...rows[0], city: 'x'.repeat(501) }])).toThrow(CUSTOMER_LIST_TEXT.badField);
    expect(() => parseCustomerList([{ id: 'one', name: 'x', type: 'invalid' }])).toThrow(CUSTOMER_LIST_TEXT.badRow);
  });
  it('at most 20 results, with the full count', () => {
    const list = parseCustomerList(Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, type: 'personal', name: `Test person ${i}` })));
    const r = searchCustomerList(list, 'test');
    expect(r.matches).toHaveLength(20);
    expect(r.total).toBe(30);
  });
  it('a client outside India is not copied as a billing address', () => {
    const [entry] = parseCustomerList([{ id: 'U-1', type: 'personal', name: 'Test', country: 'UAE', city: 'Dubai' }]);
    const r = billToFromCustomer(entry!, STATES);
    expect(r.outsideIndia).toBe(true);
    expect(r.billTo.city).toBe('');
  });
});
