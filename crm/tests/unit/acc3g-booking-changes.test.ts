import { describe, expect, it } from 'vitest';
import { CHANGE_ERROR_STATES, CHANGE_ERROR_TEXT } from '@/modules/booking-changes/contracts';
import { mapChangeError } from '@/modules/booking-changes/commands';
import { ChangeHistorySchema, TaskReconfirmationSchema } from '@/modules/booking-changes/dto';
import { changedItemSet, reconfirmOverBudget, safeFacts } from '@/modules/booking-changes/rules';

/** Track G's own unit checks (contract 10, 13). Synthetic values only. */
const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-13T06:00:00.000Z';

describe('booking changes module', () => {
  it('every token has a message; tokens map only with their SQLSTATE', () => {
    for (const k of Object.keys(CHANGE_ERROR_STATES)) expect(CHANGE_ERROR_TEXT[k as keyof typeof CHANGE_ERROR_TEXT]).toBeTruthy();
    expect(mapChangeError({ code: '22023', message: 'change_outside_request' })).toBe('change_outside_request');
    expect(mapChangeError({ code: '55000', message: 'change_outside_request' })).toBeNull();
    expect(mapChangeError({ code: '23505', message: 'change_open_exists' })).toBe('change_open_exists');
    expect(mapChangeError({ code: '42501', message: 'whatever' })).toBe('not_authorized');
  });
  it('over budget: rate + fee above budget, or no budget; no floats', () => {
    expect(reconfirmOverBudget('19800000', '500000', '20000000')).toBe(true);
    expect(reconfirmOverBudget('12000000', '500000', '20000000')).toBe(false);
    expect(reconfirmOverBudget('1', '0', null)).toBe(true);
  });
  it('changed item set is sorted, distinct and lower case', () => {
    expect(changedItemSet(['B0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000']))
      .toEqual(['a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000']);
  });
  it('R-G3 drops money keys from the facts even if the server sent them', () => {
    expect(safeFacts({ hotelName: 'X', sellingTotalPaise: '1', budgetPaise: '2' })).toEqual({ hotelName: 'X' });
    const parsed = TaskReconfirmationSchema.parse({
      taskId: ID, changeRequest: { refNo: 'CR-2026-000001', status: 'submitted' },
      old: { details: { roomType: 'A', priceTotal: '9' }, ratePaise: '100', reference: 'R', confirmedAt: AT },
      new: { details: { roomType: 'B' }, changedFields: ['items.1.roomType'] },
      reconfirmation: { id: ID, status: 'pending', newRatePaise: null, supplierFeePaise: null, newReference: null, evidenceId: null,
        overBudget: false, budgetPaise: '200', refusedReason: null, rowVersion: 1 },
      can: { record: true, refuse: true, approveOverBudget: false },
    });
    expect(parsed.old.details).toEqual({ roomType: 'A' });
  });
  it('R-G4: amounts are optional (absent for Sales and Purchase)', () => {
    const base = { dealId: ID, versions: [], confirmations: [{ taskId: ID, serviceTitle: 'Hotel', confirmationNo: 1, supplierName: null, reference: null,
      confirmedByName: null, confirmedAt: AT }] };
    expect(ChangeHistorySchema.safeParse(base).success).toBe(true);
    expect(ChangeHistorySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
