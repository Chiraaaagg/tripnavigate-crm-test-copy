import { describe, expect, it } from 'vitest';
// ASSUMPTION: export names — rate pricing mirror of authz.rate_contract_price (contract 9.2, LD21).
import { MEAL_PLANS, priceStay } from '@/modules/rate-contracts/pricing';
// ASSUMPTION: export names — write-off limits mirror (contract 6.6, LD15/16).
import { WRITE_OFF_MAX_LIMIT_PAISE, writeOffProblem } from '@/modules/write-offs/limits';
// ASSUMPTION: export names — change-request rules mirror (contract 4, 10.2, 10.3, 11.3).
import { LIVE_CHANGE_STATUSES, itemIdsProblem, itemsOutsideRequest, removalRoute } from '@/modules/booking-changes/rules';

/**
 * Accounts phase 3, Track T (contract 16.2): the pure mirrors of the rate
 * pricing, the write-off limits and the change-request rules. Written from
 * the contract; synthetic values only. 2026-11-13 is a Friday.
 */

const RT = 'room-deluxe';
type Line = { id: string; seasonFrom: string; seasonTo: string; roomTypeId: string; mealPlan: string; ratePaise: string; weekendRatePaise: string | null };
type Contract = { id: string; status: string; validFrom: string; validTo: string; lines: Line[]; blackouts: Array<{ from: string; to: string }> };
const line = (id: string, seasonFrom: string, seasonTo: string, rate: string, weekend: string | null = null): Line =>
  ({ id, seasonFrom, seasonTo, roomTypeId: RT, mealPlan: 'CP', ratePaise: rate, weekendRatePaise: weekend });
const contract = (id: string, validFrom: string, validTo: string, lines: Line[], extra: Partial<Contract> = {}): Contract =>
  ({ id, status: 'active', validFrom, validTo, lines, blackouts: [], ...extra });

/**
 * ASSUMPTION: priceStay({ contracts, roomTypeId, mealPlan, checkIn, checkOut, rooms })
 * returns the 9.2 shape { state, contractIds, nights [{date, ratePaise, lineId, weekend}],
 * perRoomTotalPaise, totalPaise, endedOn } with money as decimal strings (or bigint).
 */
type Price = { state: string; contractIds: string[]; nights: Array<{ date: string; ratePaise: string; lineId: string; weekend: boolean }>;
  perRoomTotalPaise: string | null; totalPaise: string | null; endedOn: string | null };
const price = (contracts: Contract[], checkIn: string, checkOut: string, rooms = 1, mealPlan = 'CP') =>
  priceStay({ contracts, roomTypeId: RT, mealPlan, checkIn, checkOut, rooms } as never) as unknown as Price;
const s = (v: unknown) => (v == null ? null : String(v));

describe('9.2 rate pricing mirror', () => {
  it('meal plans are the five frozen codes', () => {
    const codes = Array.isArray(MEAL_PLANS) ? (MEAL_PLANS as Array<string | { code: string }>).map((m) => (typeof m === 'string' ? m : m.code))
      : Object.keys(MEAL_PLANS as object);
    expect([...codes].sort()).toEqual(['AI', 'AP', 'CP', 'EP', 'MAP']);
  });

  it('night by night; weekend rate on Friday and Saturday nights; rooms multiply', () => {
    const c = contract('c1', '2026-11-01', '2027-03-31', [line('l1', '2026-11-01', '2026-12-31', '500000', '650000')]);
    const r = price([c], '2026-11-12', '2026-11-16', 2);
    expect(r.state).toBe('ok');
    expect(r.nights.map((n) => [n.date, s(n.ratePaise), n.weekend])).toEqual([
      ['2026-11-12', '500000', false], ['2026-11-13', '650000', true], ['2026-11-14', '650000', true], ['2026-11-15', '500000', false],
    ]);
    expect(s(r.perRoomTotalPaise)).toBe('2300000');
    expect(s(r.totalPaise)).toBe('4600000');
    expect(r.contractIds).toEqual(['c1']);
    expect(r.endedOn ?? null).toBeNull();
  });

  it('no weekend rate = the normal rate on every night; check-out night not charged', () => {
    const r = price([contract('c1', '2026-11-01', '2027-03-31', [line('l1', '2026-11-01', '2026-12-31', '400000')])], '2026-11-13', '2026-11-15');
    expect(r.nights.map((n) => s(n.ratePaise))).toEqual(['400000', '400000']);
    expect(s(r.totalPaise)).toBe('800000');
  });

  it('a stay across two seasons uses each night\'s own line', () => {
    const c = contract('c1', '2026-11-01', '2027-03-31', [line('low', '2026-11-01', '2026-12-19', '400000'), line('peak', '2026-12-20', '2027-01-05', '900000')]);
    const r = price([c], '2026-12-18', '2026-12-22');
    expect(r.state).toBe('ok');
    expect(r.nights.map((n) => [n.date, n.lineId])).toEqual([['2026-12-18', 'low'], ['2026-12-19', 'low'], ['2026-12-20', 'peak'], ['2026-12-21', 'peak']]);
    expect(s(r.perRoomTotalPaise)).toBe(String(400000 * 2 + 900000 * 2));
  });

  it('a stay across two contracts uses each night\'s contract; both ids listed', () => {
    const a = contract('cA', '2026-11-01', '2026-11-30', [line('la', '2026-11-01', '2026-11-30', '400000')]);
    const b = contract('cB', '2026-12-01', '2027-03-31', [line('lb', '2026-12-01', '2027-03-31', '450000')]);
    const r = price([a, b], '2026-11-29', '2026-12-02');
    expect(r.state).toBe('ok');
    expect(r.nights.map((n) => n.lineId)).toEqual(['la', 'la', 'lb']);
    expect([...r.contractIds].sort()).toEqual(['cA', 'cB']);
    expect(s(r.perRoomTotalPaise)).toBe('1250000');
  });

  it('partial, no_contract, blackout, ended', () => {
    const c = contract('c1', '2026-11-01', '2026-11-30', [line('l1', '2026-11-01', '2026-11-30', '400000')]);
    expect(price([c], '2026-11-29', '2026-12-02').state).toBe('partial');
    expect(price([], '2026-11-12', '2026-11-14').state).toBe('no_contract');
    expect(price([c], '2026-11-12', '2026-11-14', 1, 'MAP').state).toBe('no_contract');
    const blackout = contract('c2', '2026-11-01', '2026-12-31', [line('l2', '2026-11-01', '2026-12-31', '400000')], {
      blackouts: [{ from: '2026-12-24', to: '2026-12-26' }] });
    expect(price([blackout], '2026-12-23', '2026-12-25').state).toBe('blackout');
    expect(price([blackout], '2026-12-20', '2026-12-24').state).toBe('ok');
    // ASSUMPTION: "ended" = no contract covers the stay and one for this supplier and hotel ended (validity or status) before it.
    const ended = contract('c3', '2026-06-01', '2026-10-31', [line('l3', '2026-06-01', '2026-10-31', '400000')], { status: 'ended' });
    const r = price([ended], '2026-11-12', '2026-11-14');
    expect(r.state).toBe('ended');
    expect(r.endedOn).toBe('2026-10-31');
  });
});

describe('6.6 write-off limits mirror', () => {
  it('the limit ceiling is 500000 paise (Rs 5,000)', () => {
    expect(String(WRITE_OFF_MAX_LIMIT_PAISE)).toBe('500000');
  });
  /**
   * ASSUMPTION: writeOffProblem({ direction, amountPaise, balancePaise, creditPaise, limitPaise })
   * → null | 'write_off_over_limit' | 'write_off_not_balance' (money as decimal strings).
   */
  it('whole balance only (due = balance, excess = credit), not above the limit', () => {
    const due = { direction: 'due', balancePaise: '300', creditPaise: '0', limitPaise: '500000' };
    expect(writeOffProblem({ ...due, amountPaise: '300' } as never)).toBeNull();
    expect(writeOffProblem({ ...due, amountPaise: '299' } as never)).toBe('write_off_not_balance');
    expect(writeOffProblem({ ...due, amountPaise: '301' } as never)).toBe('write_off_not_balance');
    const excess = { direction: 'excess', balancePaise: '0', creditPaise: '450000', limitPaise: '500000' };
    expect(writeOffProblem({ ...excess, amountPaise: '450000' } as never)).toBeNull();
    expect(writeOffProblem({ ...excess, direction: 'due', amountPaise: '450000' } as never)).toBe('write_off_not_balance');
    expect(writeOffProblem({ direction: 'due', balancePaise: '500000', creditPaise: '0', limitPaise: '500000', amountPaise: '500000' } as never)).toBeNull();
    expect(writeOffProblem({ direction: 'due', balancePaise: '500001', creditPaise: '0', limitPaise: '500000', amountPaise: '500001' } as never))
      .toBe('write_off_over_limit');
    expect(writeOffProblem({ direction: 'due', balancePaise: '20000', creditPaise: '0', limitPaise: '10000', amountPaise: '20000' } as never))
      .toBe('write_off_over_limit');
    expect(writeOffProblem({ direction: 'due', balancePaise: '0', creditPaise: '0', limitPaise: '500000', amountPaise: '0' } as never)).not.toBeNull();
  });
});

describe('10 / 11 change-request rules mirror', () => {
  it('live statuses (section 4)', () => {
    // Addendum O2: a request is drafted first ('draft' is live).
    expect([...LIVE_CHANGE_STATUSES].sort()).toEqual(['approved', 'draft', 'requested', 'returned', 'submitted']);
  });
  /** ASSUMPTION: itemIdsProblem(kind, itemIds) → null | 'invalid_input'. */
  it('item counts: change 1..20, add_service none, remove_service exactly one', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(itemIdsProblem('change', ids(1))).toBeNull();
    expect(itemIdsProblem('change', ids(20))).toBeNull();
    expect(itemIdsProblem('change', ids(0))).not.toBeNull();
    expect(itemIdsProblem('change', ids(21))).not.toBeNull();
    expect(itemIdsProblem('add_service', ids(0))).toBeNull();
    expect(itemIdsProblem('add_service', ids(1))).not.toBeNull();
    expect(itemIdsProblem('remove_service', ids(1))).toBeNull();
    expect(itemIdsProblem('remove_service', ids(0))).not.toBeNull();
    expect(itemIdsProblem('remove_service', ids(2))).not.toBeNull();
  });
  it('LD28: every changed service must be named in the request', () => {
    expect(itemsOutsideRequest(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
    expect(itemsOutsideRequest(['a', 'd'], ['a', 'b'])).toEqual(['d']);
    expect(itemsOutsideRequest([], ['a'])).toEqual([]);
  });
  /** ASSUMPTION: removalRoute({ supplierConfirmed, ticketBatch, visaSubmitted, supplierPayment, companyPaidFee }) → 'simple' | 'cancellation'. */
  it('11.3 removal route: simple only when nothing is booked or paid', () => {
    const none = { supplierConfirmed: false, ticketBatch: false, visaSubmitted: false, supplierPayment: false, companyPaidFee: false };
    expect(removalRoute(none as never)).toBe('simple');
    for (const k of Object.keys(none)) expect(removalRoute({ ...none, [k]: true } as never), k).toBe('cancellation');
  });
});
