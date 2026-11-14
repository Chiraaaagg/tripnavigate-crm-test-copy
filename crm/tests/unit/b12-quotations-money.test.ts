import { describe, expect, it } from 'vitest';
import {
  QUOTATION_ERROR_STATES,
  QUOTATION_ERROR_TEXT,
  QUOTATION_ISSUE_CODES,
  QUOTATION_ISSUE_TEXT,
  QUOTATION_MONEY_BLOCKERS,
  QUOTATION_MONEY_WARNINGS,
  UNIT_KINDS,
} from '@/modules/quotations/contracts';
import {
  allowedUnits,
  compareTier,
  fixedCounts,
  formatInr,
  lineAmount,
  nearestExactTotals,
  optionKeysFor,
  paiseToRupeesText,
  parseRupeesWithPaise,
  parseWholeRupees,
  perPersonExact,
  planMatchesTotal,
  planTotal,
  requiredMainUnits,
  splitByPercentage,
  wholeRupees,
} from '@/modules/quotations/money';

/**
 * Quotation money rules in TypeScript (Mercury F1–F14, DEC-33/34): whole
 * paise as bigint, customer amounts whole rupees, nothing rounded, units per
 * service type, typed totals compared (never applied), exact per-person
 * prices only, plan equal to the typed total, no tax. Synthetic amounts.
 */

describe('rupee input parsing (never rounds)', () => {
  it('customer amounts are whole rupees; paise, letters, negatives and huge values are refused', () => {
    expect(parseWholeRupees('12,500')).toBe('1250000');
    expect(parseWholeRupees('₹ 1,20,000')).toBe('12000000');
    expect(parseWholeRupees('12500.00')).toBe('1250000');
    expect(parseWholeRupees('')).toBeNull();
    for (const bad of ['12500.50', '12500.5', '-1', '12a', '1.234', '99999999999999']) expect(parseWholeRupees(bad), bad).toBeUndefined();
  });

  it('cost estimates may carry paise but never a third decimal', () => {
    expect(parseRupeesWithPaise('12,500.5')).toBe('1250050');
    expect(parseRupeesWithPaise('0.05')).toBe('5');
    expect(parseRupeesWithPaise('')).toBeNull();
    expect(parseRupeesWithPaise('1.234')).toBeUndefined();
  });

  it('formats exactly with Indian grouping, including beyond Number precision', () => {
    expect(formatInr('1250000')).toBe('₹12,500');
    expect(formatInr('1250050')).toBe('₹12,500.50');
    expect(formatInr('-50000')).toBe('−₹500');
    expect(formatInr(900719925474099312n)).toBe('₹9,00,71,99,25,47,40,993.12');
    expect(formatInr(null)).toBeNull();
    expect(paiseToRupeesText('1250050')).toBe('12500.50');
    expect(paiseToRupeesText('1250000')).toBe('12500');
    expect(wholeRupees('1250000')).toBe(12500n);
    expect(wholeRupees('1250050')).toBeNull();
  });
});

describe('units (DEC-33)', () => {
  it('main lines: hotel per room per night, cab per trip, flight/visa/passport total, activity per person or total', () => {
    expect(requiredMainUnits('hotel')).toEqual(['room_night']);
    expect(requiredMainUnits('transfer')).toEqual(['trip']);
    expect(requiredMainUnits('flight')).toEqual(['line_total']);
    expect(requiredMainUnits('visa')).toEqual(['line_total']);
    expect(requiredMainUnits('passport')).toEqual(['line_total']);
    expect(requiredMainUnits('activity')).toEqual(['person', 'line_total']);
    expect(requiredMainUnits(null)).toEqual(['line_total']);
  });

  it('extra-bed, child-without-bed and other charges: staff choose night, person or total; never room_night or trip', () => {
    for (const kind of ['extra_bed', 'child_no_bed', 'other'] as const) {
      expect([...allowedUnits(kind, 'hotel')].sort()).toEqual(['line_total', 'night', 'person']);
    }
    expect(fixedCounts('line_total')).toEqual({ units: 1, periods: 1 });
    expect(fixedCounts('person')).toEqual({ units: null, periods: 1 });
    expect(fixedCounts('room_night')).toEqual({ units: null, periods: null });
    expect(UNIT_KINDS).toHaveLength(5);
  });

  it('line amount = unit × units × periods, exactly, beyond 2^53', () => {
    expect(lineAmount(450000n, 2, 3)).toBe(2700000n);
    expect(lineAmount(9999999999999n, 999, 366)).toBe(9999999999999n * 999n * 366n);
  });
});

describe('typed total vs components (DEC-34)', () => {
  const lines = [
    { optionKey: 'common' as const, lineSellPaise: '4000000', lineCostPaise: '3600000' },
    { optionKey: 'quoted' as const, lineSellPaise: '5000000', lineCostPaise: '4100000' },
    { optionKey: 'upgrade' as const, lineSellPaise: '8000000', lineCostPaise: null },
  ];

  it('component sum, difference, cost and margin per tier; nothing applied', () => {
    expect(compareTier(lines, 'quoted', '9500000')).toEqual({ componentSell: 9000000n, difference: 500000n, costTotal: 7700000n, margin: 1800000n });
    expect(compareTier(lines, 'upgrade', '12000000')).toEqual({ componentSell: 12000000n, difference: 0n, costTotal: null, margin: null });
    expect(compareTier(lines, 'quoted', null).difference).toBeNull();
  });

  it('per-person only when exact in whole rupees; nearest exact totals for Sales', () => {
    expect(perPersonExact('9600000', 4)).toBe(2400000n);
    expect(perPersonExact('9500000', 3)).toBeNull();
    expect(perPersonExact('9500050', 1)).toBeNull();
    expect(perPersonExact('9500000', 0)).toBeNull();
    expect(nearestExactTotals('9500000', 3)).toEqual({ below: 9499800n, above: 9500100n });
    expect(nearestExactTotals('9600000', 4)).toEqual({ below: 9600000n, above: 9600000n });
  });

  it('plan: optional per tier; when present it must equal the typed total exactly', () => {
    const plan = [
      { tierKey: 'quoted' as const, seq: 1, amountPaise: '3000000' },
      { tierKey: 'quoted' as const, seq: 2, amountPaise: '6500000' },
    ];
    expect(planTotal(plan, 'quoted')).toBe(9500000n);
    expect(planMatchesTotal(plan, 'quoted', '9500000')).toBe(true);
    expect(planMatchesTotal(plan, 'quoted', '9500100')).toBe(false);
    expect(planMatchesTotal(plan, 'upgrade', null)).toBe(true);
    expect(planMatchesTotal(plan, 'quoted', null)).toBe(false);
  });

  it('split by percentage: whole rupees, floor, last takes the remainder; bad input refused', () => {
    expect(splitByPercentage('9500100', [30, 70])).toEqual([2850000n, 6650100n]);
    expect(splitByPercentage(10000n, [33, 33, 34])).toEqual([3300n, 3300n, 3400n]);
    expect(splitByPercentage('9500100', [30, 60])).toBeNull();
    expect(splitByPercentage('9500150', [50, 50])).toBeNull();
    expect(splitByPercentage('9500100', [50.5, 49.5])).toBeNull();
  });

  it('option keys follow the offered tiers', () => {
    expect(optionKeysFor(['quoted'])).toEqual(['common', 'quoted']);
    expect(optionKeysFor(['quoted', 'upgrade'])).toEqual(['common', 'quoted', 'upgrade']);
  });
});

describe('wording and tokens', () => {
  it('every issue code has words, a section and a blocking flag; warnings never block', () => {
    for (const code of [...QUOTATION_ISSUE_CODES, ...QUOTATION_MONEY_BLOCKERS, ...QUOTATION_MONEY_WARNINGS]) {
      expect(QUOTATION_ISSUE_TEXT[code].text.length, code).toBeGreaterThan(10);
    }
    for (const code of QUOTATION_MONEY_WARNINGS) expect(QUOTATION_ISSUE_TEXT[code].blocking, code).toBe(false);
    for (const code of QUOTATION_MONEY_BLOCKERS) expect(QUOTATION_ISSUE_TEXT[code].blocking, code).toBe(true);
  });

  it('every refusal token has plain words and a SQLSTATE; no text mentions GST amounts', () => {
    for (const [code, state] of Object.entries(QUOTATION_ERROR_STATES)) {
      expect(state, code).toMatch(/^[0-9A-Z]{5}$/);
      expect(QUOTATION_ERROR_TEXT[code as keyof typeof QUOTATION_ERROR_TEXT].length).toBeGreaterThan(10);
    }
    expect(Object.values(QUOTATION_ERROR_TEXT).join(' ')).not.toMatch(/GST|tax/i);
  });
});
