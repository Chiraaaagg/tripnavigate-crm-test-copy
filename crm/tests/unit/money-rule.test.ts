import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PAISE, maxPaiseForDigits, rupeesToPaise as lib } from '@/lib/money';
import { PRICE_AMOUNT_MAX_PAISE } from '@/modules/fulfilment/booking-form-contract';
import { rupeesToPaise as bookNow } from '@/modules/fulfilment/booking-form-model';
import { rupeesToPaise as fulfilmentForms } from '@/modules/fulfilment/forms';
import { rupeesToPaise as financeForms } from '@/modules/finance/forms';
import { rupeesToPaise as accountsFilter } from '@/modules/accounts-desk/filters';
import { rupeesToPaise as visaForms } from '@/modules/visa/forms';
import { rupeesToPaise as flightBox } from '@/views/flight/parse';
import { rupeesToPaise as visaBox } from '@/views/visa/format';
import { rupeesToPaise as rateContracts } from '@/views/rate-contracts/format';
import { rupeesToPaise as purchaseBox, wholeStayFromPerNight } from '@/views/purchase/purchase-vm';
import { rupeesToPaise as refundBox } from '@/views/refunds/labels';
import { rupeeTextToPaise as changeHint } from '@/views/booking-changes/rules';
import { fareNum } from '@/modules/flight/money-forms';
import { parseRupeesWithPaise, parseWholeRupees } from '@/modules/quotations/money';
import { rupeesTextToPaise as bookMirror } from '@/views/b11/book-fields';

/*
 * One money-typing rule (owner decision D4). Every entry point reads typed
 * text by src/lib/money.ts; each keeps its own return shape, its own largest
 * amount and its own meaning of an empty box. One table of odd inputs runs
 * against all of them. A row says what the rule makes of the text:
 *   a paise string  -> accepted as that amount
 *   'refused'       -> not an amount
 *   'empty'         -> nothing typed
 */

type Reading = string | 'refused' | 'empty';

const TABLE: Array<[input: string, reading: Reading]> = [
  ['₹100', 'refused'],
  ['₹ 100', 'refused'],
  ['1,2,3', 'refused'],
  ['1e3', 'refused'],
  ['1.001', 'refused'],
  ['-5', 'refused'],
  ['abc', 'refused'],
  ['12.', 'refused'],
  ['.5', 'refused'],
  [',100', 'refused'],
  ['100,', 'refused'],
  ['1,,000', 'refused'],
  ['12 500', 'refused'],
  ['0x10', 'refused'],
  ['+5', 'refused'],
  ['1,2345', 'refused'],
  [' 12,500.50 ', '1250050'],
  ['12,500.50', '1250050'],
  ['12,50,000', '125000000'],
  ['1,250,000', '125000000'],
  ['1,00,000', '10000000'],
  ['12500', '1250000'],
  ['6500.5', '650050'],
  ['0.01', '1'],
  ['007', '700'],
  ['0', '0'],
  ['', 'empty'],
  ['   ', 'empty'],
];

/** Each entry point, with how it reports the three readings. */
const ENTRY_POINTS: Array<{
  name: string;
  read: (text: string) => unknown;
  /** What it returns for an accepted amount (`paise` as a decimal string). */
  accepted: (paise: string) => unknown;
  refused: unknown;
  empty: unknown;
}> = [
  { name: 'lib/money', read: (t) => lib(t), accepted: (p) => p, refused: undefined, empty: null },
  { name: 'Book now (booking-form-model)', read: (t) => bookNow(t), accepted: (p) => p, refused: undefined, empty: null },
  { name: 'fulfilment/forms', read: (t) => fulfilmentForms(t), accepted: (p) => p, refused: undefined, empty: null },
  { name: 'finance/forms', read: (t) => financeForms(t), accepted: (p) => p, refused: undefined, empty: null },
  { name: 'accounts-desk/filters', read: (t) => accountsFilter(t), accepted: (p) => p, refused: undefined, empty: undefined },
  // Visa: zero is not an amount on these boxes (kept as before).
  { name: 'visa/forms', read: (t) => visaForms(t), accepted: (p) => (p === '0' ? null : p), refused: null, empty: null },
  // Flight: an empty fare box means ₹0 (kept as before).
  { name: 'flight/parse', read: (t) => flightBox(t), accepted: (p) => p, refused: null, empty: '0' },
  { name: 'visa/format', read: (t) => visaBox(t), accepted: (p) => (p === '0' ? null : p), refused: null, empty: null },
  { name: 'rate-contracts/format', read: (t) => rateContracts(t), accepted: (p) => p, refused: undefined, empty: null },
  // Purchase: zero is not an amount on these boxes (kept as before).
  { name: 'purchase-vm', read: (t) => purchaseBox(t), accepted: (p) => (p === '0' ? null : BigInt(p)), refused: null, empty: null },
  {
    name: 'purchase-vm wholeStayFromPerNight (1 room, 1 night)',
    read: (t) => wholeStayFromPerNight(t, 1, 1),
    accepted: (p) => (p === '0' ? null : `${BigInt(p) / 100n}.${(BigInt(p) % 100n).toString().padStart(2, '0')}`),
    refused: null,
    empty: null,
  },
  { name: 'refunds/labels', read: (t) => refundBox(t), accepted: (p) => BigInt(p), refused: null, empty: null },
  // Booking changes: the live over-budget hint (display aid only).
  { name: 'booking-changes/rules', read: (t) => changeHint(t), accepted: (p) => BigInt(p), refused: null, empty: null },
  { name: 'flight/money-forms fareNum', read: (t) => fareNum(t), accepted: (p) => p, refused: undefined, empty: null },
  // Quotations: customer amounts are whole rupees only (paise refused, kept as before).
  { name: 'quotations parseWholeRupees', read: (t) => parseWholeRupees(t), accepted: (p) => (BigInt(p) % 100n === 0n ? p : undefined), refused: undefined, empty: null },
  { name: 'quotations parseRupeesWithPaise', read: (t) => parseRupeesWithPaise(t), accepted: (p) => p, refused: undefined, empty: null },
  // Book now B11 running-total mirror: an empty box adds 0 (kept as before).
  { name: 'b11/book-fields rupeesTextToPaise', read: (t) => bookMirror(t), accepted: (p) => Number(p), refused: null, empty: 0 },
];

describe('one money rule (D4): the same odd inputs on every entry point', () => {
  for (const entry of ENTRY_POINTS) {
    describe(entry.name, () => {
      it.each(TABLE)('%j', (input, reading) => {
        const expected = reading === 'refused' ? entry.refused : reading === 'empty' ? entry.empty : entry.accepted(reading);
        expect(entry.read(input)).toEqual(expected);
      });
    });
  }
});

describe('each entry point keeps its own largest amount', () => {
  const caps: Array<[name: string, read: (t: string) => unknown, largestOk: string, firstOver: string]> = [
    ['Book now', (t) => bookNow(t), '999999999.99', '1000000000'],
    ['fulfilment/forms', (t) => fulfilmentForms(t), '999999999999999.99', '1000000000000000'],
    ['finance/forms', (t) => financeForms(t), '9999999999999999.99', '10000000000000000'],
    ['accounts-desk/filters', (t) => accountsFilter(t), '999999999999999.99', '1000000000000000'],
    ['visa/forms', (t) => visaForms(t), '9999999999999.99', '10000000000000'],
    ['flight/parse', (t) => flightBox(t), '999999999.99', '1000000000'],
    ['visa/format', (t) => visaBox(t), '9999999999999.99', '10000000000000'],
    ['rate-contracts/format', (t) => rateContracts(t), '999999999999.99', '1000000000000'],
    ['purchase-vm', (t) => purchaseBox(t), '9999999999.99', '10000000000'],
    ['purchase-vm per night', (t) => wholeStayFromPerNight(t, 1, 1), '999999999.99', '1000000000'],
    ['refunds/labels', (t) => refundBox(t), '999999999999999.99', '1000000000000000'],
    // No cap before (display aid); 30 rupee digits now, far above the server's 15.
    ['booking-changes/rules', (t) => changeHint(t), '999999999999999999999999999999.99', '1000000000000000000000000000000'],
    ['flight/money-forms fareNum', (t) => fareNum(t), '999999999.99', '1000000000'],
    ['quotations parseWholeRupees', (t) => parseWholeRupees(t), '9999999999999.00', '10000000000000'],
    ['quotations parseRupeesWithPaise', (t) => parseRupeesWithPaise(t), '9999999999999.99', '10000000000000'],
    ['b11/book-fields rupeesTextToPaise', (t) => bookMirror(t), '9999999999999.99', '10000000000000'],
  ];
  it.each(caps)('%s', (_name, read, largestOk, firstOver) => {
    expect(read(largestOk)).not.toBeNull();
    expect(read(largestOk)).not.toBeUndefined();
    expect(read(firstOver) ?? null).toBeNull();
    // Grouped the Indian way, the largest amount is still read.
    const [whole, fraction] = largestOk.split('.') as [string, string | undefined];
    const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}${fraction === undefined ? '' : `.${fraction}`}` : largestOk;
    expect(read(grouped)).toEqual(read(largestOk));
  });
});

describe('src/lib/money.ts (moved from Book now, same tests)', () => {
  it('keeps the Book now cap', () => {
    expect(DEFAULT_MAX_PAISE).toBe(PRICE_AMOUNT_MAX_PAISE);
    expect(maxPaiseForDigits(9)).toBe(PRICE_AMOUNT_MAX_PAISE);
  });
  it('reads rupees to whole paise and keeps missing apart from zero', () => {
    expect(lib('0.01')).toBe('1');
    expect(lib('0')).toBe('0');
    expect(lib('')).toBeNull();
    expect(lib('   ')).toBeNull();
    expect(lib(null)).toBeNull();
    expect(lib(undefined)).toBeNull();
    expect(lib('1,234.56')).toBe('123456');
    expect(lib('1,00,000')).toBe('10000000');
  });
  it('refuses decimals, signs, exponents and symbols', () => {
    for (const bad of ['1.001', '-1', '1e3', '₹100', '1,2', ',100', '12.']) expect(lib(bad), bad).toBeUndefined();
  });
  it('allows a leading minus only for a derived markup', () => {
    expect(lib('-1000.50', { signed: true })).toBe('-100050');
    expect(lib('-0', { signed: true })).toBe('0');
    expect(lib('-1,000', { signed: true })).toBe('-100000');
  });
  it('caps one amount at 99,99,99,999.99 rupees unless a screen gives its own maximum', () => {
    expect(lib('999999999.99')).toBe('99999999999');
    expect(lib('1000000000')).toBeUndefined();
    expect(lib('1000000000', { max: maxPaiseForDigits(10) })).toBe('100000000000');
  });
});
