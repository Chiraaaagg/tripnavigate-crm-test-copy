import { describe, expect, it } from 'vitest';
import { paiseToRupeesInput, parseSaveDraftForm, rupeesToPaise } from '@/modules/fulfilment/forms';

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('rupee amounts', () => {
  it.each([
    ['', null],
    ['0', '0'],
    ['15000', '1500000'],
    ['1,23,456.5', '12345650'],
    ['₹ 99.99', '9999'],
    ['999999999999999.99', '99999999999999999'],
  ])('%s → %s paise', (input, out) => {
    expect(rupeesToPaise(input)).toBe(out);
  });

  it.each(['-1', '1.234', '1e5', 'abc', '1000000000000000', '0x10'])('rejects %s', (input) => {
    expect(rupeesToPaise(input)).toBeUndefined();
  });

  it('round-trips for prefilled inputs', () => {
    expect(paiseToRupeesInput('12345650')).toBe('123456.50');
    expect(paiseToRupeesInput('5')).toBe('0.05');
    expect(paiseToRupeesInput(null)).toBe('');
    expect(rupeesToPaise(paiseToRupeesInput('12345650'))).toBe('12345650');
  });
});

describe('parseSaveDraftForm', () => {
  const base = { dealId: DEAL, versionId: VERSION, rowVersion: '3' };

  it('allows an incomplete draft (empty → null)', () => {
    const parsed = parseSaveDraftForm(form({ ...base, hotelName: '  Synthetic Palace ', rooms: '', sellingTotalRupees: '' }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        versionId: VERSION,
        expectedRowVersion: 3,
        sellingTotalPaise: null,
        sellingTotalProvided: true,
        facts: {
          hotelName: 'Synthetic Palace',
          city: null,
          checkIn: null,
          checkOut: null,
          rooms: null,
          roomType: null,
          mealPlan: null,
          adults: null,
          children: null,
          inclusions: null,
          specialRequests: null,
          purchaseBudgetPaise: null,
        },
      },
    });
  });

  it('converts amounts and numbers', () => {
    const parsed = parseSaveDraftForm(
      form({ ...base, purchaseBudgetRupees: '15,000', sellingTotalRupees: '20000.5', adults: '2', children: '0', checkIn: '2026-11-01' }),
    );
    expect(parsed.ok && parsed.value.facts.purchaseBudgetPaise).toBe('1500000');
    expect(parsed.ok && parsed.value.sellingTotalPaise).toBe('2000050');
    expect(parsed.ok && parsed.value.facts.adults).toBe(2);
    expect(parsed.ok && parsed.value.facts.children).toBe(0);
  });

  it('reports every invalid field by its form name', () => {
    const parsed = parseSaveDraftForm(
      form({
        dealId: 'nope',
        versionId: VERSION,
        rowVersion: '-1',
        rooms: '0',
        adults: '101',
        checkIn: '2026-02-30',
        hotelName: 'x'.repeat(201),
        purchaseBudgetRupees: '1.234',
        sellingTotalRupees: '',
      }),
    );
    expect(parsed).toEqual({
      ok: false,
      invalid: ['dealId', 'rowVersion', 'hotelName', 'checkIn', 'rooms', 'adults', 'purchaseBudgetRupees'],
    });
  });

  it('a form without the selling total field sends null (the database keeps the amount for non-commercial viewers)', () => {
    const parsed = parseSaveDraftForm(form({ ...base, hotelName: 'X' }));
    expect(parsed.ok && parsed.value.sellingTotalPaise).toBeNull();
    expect(parsed.ok && parsed.value.sellingTotalProvided).toBe(false);
  });
});
