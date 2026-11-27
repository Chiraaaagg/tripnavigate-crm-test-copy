import { describe, expect, it } from 'vitest';
import {
  compareToContract,
  dateText,
  daysLeftText,
  differenceText,
  endingSoon,
  groupNights,
  inr,
  lineCellFor,
  lineProblems,
  paiseToRupees,
  rangeText,
  rupeesToPaise,
  type LineDraft,
} from '@/views/rate-contracts/format';
import { MEAL_PLAN_LABEL, RATE_REFUSAL_TEXT } from '@/views/rate-contracts/labels';

/**
 * Accounts phase 3 contract §9 (rate contracts) and §15 item 9, track U: the
 * pure helpers behind the rate contract screens. The database decides every
 * rule; these mirror it only for the live hints on screen.
 */

describe('money and dates', () => {
  it('formats paise in Indian grouping with BigInt only', () => {
    expect(inr('12345650')).toBe('₹1,23,456.50');
    expect(inr('450000')).toBe('₹4,500.00');
    expect(inr('5')).toBe('₹0.05');
    expect(inr('-120000')).toBe('-₹1,200.00');
    expect(inr('12.5')).toBe('');
    expect(inr(null)).toBe('');
  });
  it('reads rupee text as whole paise', () => {
    expect(rupeesToPaise('4500')).toBe('450000');
    expect(rupeesToPaise(' 4,500.5 ')).toBe('450050');
    // One money rule (D4): a typed rupee sign is refused.
    expect(rupeesToPaise('₹ 4,500.5')).toBeUndefined();
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('4500.555')).toBeUndefined();
    expect(rupeesToPaise('-1')).toBeUndefined();
    expect(paiseToRupees('450050')).toBe('4500.50');
    expect(paiseToRupees(null)).toBe('');
  });
  it('shows dates without a time zone shift', () => {
    expect(dateText('2026-12-01')).toBe('1 Dec 2026');
    expect(dateText('2026-11-10T23:30:00Z')).toBe('10 Nov 2026');
    expect(dateText(null)).toBe('Not set');
    expect(rangeText('2026-12-01', '2027-03-31')).toBe('1 Dec 2026 to 31 Mar 2027');
    expect(rangeText('2026-12-01', '2026-12-01')).toBe('1 Dec 2026');
  });
});

describe('days left', () => {
  it('speaks only for active contracts', () => {
    expect(daysLeftText(27, 'active')).toBe('27 days left');
    expect(daysLeftText(1, 'active')).toBe('Ends tomorrow');
    expect(daysLeftText(0, 'active')).toBe('Ends today');
    expect(daysLeftText(-2, 'active')).toBe('Past its end date');
    expect(daysLeftText(27, 'draft')).toBeNull();
  });
  it('ending soon = active within 30 days', () => {
    expect(endingSoon(30, 'active')).toBe(true);
    expect(endingSoon(31, 'active')).toBe(false);
    expect(endingSoon(7, 'ended')).toBe(false);
  });
});

describe('night-by-night runs', () => {
  it('groups consecutive nights of one line and rate, and breaks on weekend, line or gap', () => {
    const runs = groupNights([
      { date: '2027-03-29', ratePaise: '450000', lineId: 'a', weekend: false },
      { date: '2027-03-30', ratePaise: '450000', lineId: 'a', weekend: false },
      { date: '2027-03-31', ratePaise: '450000', lineId: 'a', weekend: false },
      { date: '2027-04-01', ratePaise: '380000', lineId: 'b', weekend: false },
      { date: '2027-04-02', ratePaise: '420000', lineId: 'b', weekend: true },
      { date: '2027-04-05', ratePaise: '420000', lineId: 'b', weekend: true },
    ]);
    expect(runs.map((r) => [r.from, r.to, r.nights, r.ratePaise])).toEqual([
      ['2027-03-29', '2027-03-31', 3, '450000'],
      ['2027-04-01', '2027-04-01', 1, '380000'],
      ['2027-04-02', '2027-04-02', 1, '420000'],
      ['2027-04-05', '2027-04-05', 1, '420000'],
    ]);
  });
  it('crosses a month end', () => {
    expect(groupNights([
      { date: '2027-01-31', ratePaise: '1', lineId: 'a', weekend: false },
      { date: '2027-02-01', ratePaise: '1', lineId: 'a', weekend: false },
    ])).toHaveLength(1);
  });
});

describe('offer compared with the contract (mirror of E9 contract_state)', () => {
  const ok = { state: 'ok' as const, totalPaise: '4300000' };
  it('matches, differs, needs a total, none and ended', () => {
    expect(compareToContract('4300000', ok)).toBe('matches');
    expect(compareToContract('4500000', ok)).toBe('differs');
    expect(compareToContract(null, ok)).toBe('not_priced');
    expect(compareToContract('4500000', { state: 'no_contract', totalPaise: null })).toBe('none');
    expect(compareToContract('4500000', { state: 'partial', totalPaise: null })).toBe('none');
    expect(compareToContract('4500000', { state: 'ended', totalPaise: null })).toBe('ended');
    expect(compareToContract('4500000', null)).toBe('none');
  });
  it('says how far apart in words', () => {
    expect(differenceText('4500000', '4300000')).toBe('₹2,000.00 above the contract');
    expect(differenceText('4200000', '4300000')).toBe('₹1,000.00 below the contract');
    expect(differenceText('4300000', '4300000')).toBe('Same as the contract');
  });
});

describe('rate line refusal hints', () => {
  it('maps lines[n].field to the rupee input', () => {
    expect(lineCellFor('lines[2].ratePaise')).toEqual({ group: 'lines', index: 2, field: 'rateRupees' });
    expect(lineCellFor('lines[0].seasonFrom')).toEqual({ group: 'lines', index: 0, field: 'seasonFrom' });
    expect(lineCellFor('blackouts[1].toDate')).toEqual({ group: 'blackouts', index: 1, field: 'toDate' });
    expect(lineCellFor('contractDeviationReason')).toBeNull();
    expect(lineCellFor(null)).toBeNull();
  });
});

describe('rate line checks (the database repeats them)', () => {
  const line = (over: Partial<LineDraft> = {}): LineDraft => ({
    seasonFrom: '2026-12-01',
    seasonTo: '2027-03-31',
    roomTypeId: 'deluxe',
    mealPlan: 'CP',
    rateRupees: '4500',
    weekendRateRupees: '',
    extraAdultRupees: '',
    childWithBedRupees: '',
    childWithoutBedRupees: '',
    note: '',
    ...over,
  });
  const validity = { from: '2026-12-01', to: '2027-09-30' };
  it('accepts a complete line and two seasons that touch but do not overlap', () => {
    expect(lineProblems([line(), line({ seasonFrom: '2027-04-01', seasonTo: '2027-09-30' })], validity)).toEqual({});
  });
  it('names the field of each problem', () => {
    const p = lineProblems([line({ rateRupees: '', roomTypeId: '', weekendRateRupees: 'abc' }), line({ seasonFrom: '2026-11-01' }), line({ rateRupees: '0', seasonFrom: '2027-04-10', seasonTo: '2027-04-01' })], validity);
    expect(Object.keys(p)).toEqual(['lines[0].roomTypeId', 'lines[0].rateRupees', 'lines[0].weekendRateRupees', 'lines[1].seasonFrom', 'lines[2].seasonTo', 'lines[2].rateRupees']);
  });
  it('finds two lines for the same room and meal plan that overlap (lines_overlap)', () => {
    const p = lineProblems([line(), line({ seasonFrom: '2027-03-31', seasonTo: '2027-05-01' })], validity);
    expect(p['lines[1].seasonFrom']).toBe('Overlaps line 1 for the same room type and meal plan.');
    expect(lineProblems([line(), line({ mealPlan: 'MAP' })], validity)).toEqual({});
  });
});

describe('frozen words', () => {
  it('meal plan labels (LD21) and the §13 refusal texts', () => {
    expect(MEAL_PLAN_LABEL).toEqual({ EP: 'Room only', CP: 'Breakfast', MAP: 'Breakfast and dinner', AP: 'All meals', AI: 'All inclusive' });
    expect(RATE_REFUSAL_TEXT.rate_contracts_off).toBe('Rate contracts are not switched on yet.');
    expect(RATE_REFUSAL_TEXT.lines_overlap).toBe('Two rate lines for the same room and meal plan overlap in dates.');
    expect(RATE_REFUSAL_TEXT.in_use).toBe('This is used by an active contract.');
  });
});

describe('rate contract list address', () => {
  it('reads the filter back and drops unknown values', async () => {
    const { parseRateContractQuery } = await import('@/views/rate-contracts/format');
    const id = 'a0003501-0000-4000-8000-000000003501';
    expect(parseRateContractQuery({ supplierId: id, hotelId: 'nope', status: 'active,ended,bogus', endingWithinDays: '30', q: ' lake ', preset: 'to_approve', after: 'x|y' })).toEqual({
      filter: { supplierId: id, status: ['active', 'ended'], endingWithinDays: 30, q: 'lake', preset: 'to_approve' },
      after: 'x|y',
    });
    expect(parseRateContractQuery({ preset: 'all', endingWithinDays: '99999' })).toEqual({ filter: {}, after: null });
  });
});
