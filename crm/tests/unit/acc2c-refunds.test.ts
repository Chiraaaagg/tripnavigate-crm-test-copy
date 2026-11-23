import { describe, expect, it } from 'vitest';
import { mapRefundError } from '@/modules/refunds/commands';
import { REFUND_ERROR_STATES, REFUND_ERROR_TEXT } from '@/modules/refunds/contracts';
import { DealRefundsSchema, toDealRefunds } from '@/modules/refunds/dto';
import { checkRefundLimits, maxRefundPaise } from '@/modules/refunds/limits';
import { mapCancellationError } from '@/modules/cancellations/commands';
import { FlightBatchCancellationKeysSchema, VisaCancellationSchema } from '@/modules/cancellations/dto';

/**
 * Accounts phase 2, Track C unit tests: the pure refund limit mirror
 * (contract 7.2), refusal mapping (section 9) and the refund read DTO fence
 * (section 10: the Sales owner never gets supplier refunds, payout reference
 * or proof id).
 */

const base = { kind: 'cancellation' as const, outcome: 'payout' as const, heldPaise: 5_000_000n, chargePaise: 1_000_000n,
  amountPaise: 4_000_000n, basisTotalPaise: 9_000_000n, cancellationApproved: true };

describe('7.2 limits mirror', () => {
  it('cancellation payout / keep_credit: 1 <= amount <= held - charge', () => {
    expect(checkRefundLimits(base)).toBeNull();
    expect(checkRefundLimits({ ...base, amountPaise: 4_000_001n })).toEqual({ field: 'amountPaise', code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...base, outcome: 'keep_credit', amountPaise: 0n })).toEqual({ field: 'amountPaise', code: 'invalid_input' });
    expect(checkRefundLimits({ ...base, cancellationApproved: false })).toEqual({ field: 'cancellation', code: 'not_ready' });
    expect(maxRefundPaise(base)).toBe(4_000_000n);
    expect(maxRefundPaise({ ...base, chargePaise: 9_000_000n })).toBe(0n);
  });
  it('charge_only: amount 0 and any charge (even above money held)', () => {
    expect(checkRefundLimits({ ...base, outcome: 'charge_only', amountPaise: 0n, chargePaise: 99_000_000n })).toBeNull();
    expect(checkRefundLimits({ ...base, outcome: 'charge_only', amountPaise: 1n })).toEqual({ field: 'amountPaise', code: 'invalid_input' });
  });
  it('overpayment: charge 0, never charge_only, amount <= held - basis total', () => {
    const over = { ...base, kind: 'overpayment' as const, chargePaise: 0n, heldPaise: 9_200_000n, amountPaise: 200_000n, cancellationApproved: false };
    expect(checkRefundLimits(over)).toBeNull();
    expect(checkRefundLimits({ ...over, amountPaise: 200_001n })).toEqual({ field: 'amountPaise', code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...over, outcome: 'charge_only', amountPaise: 0n })).toEqual({ field: 'outcome', code: 'invalid_input' });
    expect(checkRefundLimits({ ...over, chargePaise: 1n })).toEqual({ field: 'customerChargePaise', code: 'invalid_input' });
    expect(checkRefundLimits({ ...over, basisTotalPaise: null })).toEqual({ field: 'booking', code: 'not_ready' });
  });
});

describe('Addendum L6 / L7 limits mirror', () => {
  it('held below zero, approved charge floor, kept credit reserved unless used', () => {
    expect(checkRefundLimits({ ...base, heldPaise: -1n })).toEqual({ field: 'heldPaise', code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...base, approvedChargePaise: 2_000_000n })).toEqual({ field: 'approvedChargePaise', code: 'charge_below_approved' });
    expect(checkRefundLimits({ ...base, keptCreditUnusedPaise: 1n })).toEqual({ field: 'amountPaise', code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...base, keptCreditUnusedPaise: 1n, useKeptCredit: true })).toBeNull();
    expect(maxRefundPaise({ ...base, keptCreditUnusedPaise: 1_000_000n })).toBe(3_000_000n);
  });
});

describe('section 9 refusals', () => {
  it('every token maps only with its SQLSTATE; every token has frozen text', () => {
    for (const [token, state] of Object.entries(REFUND_ERROR_STATES)) {
      expect(mapRefundError({ code: state, message: token })).toBe(token);
      expect(REFUND_ERROR_TEXT[token as keyof typeof REFUND_ERROR_TEXT]).toBeTruthy();
    }
    expect(REFUND_ERROR_TEXT.refund_exceeds_money).toBe('The refund is more than the verified money held minus the customer charge.');
    expect(REFUND_ERROR_TEXT.not_self_approval).toBe('You cannot approve or pay out something you asked for or approved.');
    expect(mapRefundError({ code: '55000', message: 'refund_open_exists' })).toBeNull();
    expect(mapRefundError({ code: '42501', message: 'something else' })).toBe('not_authorized');
    expect(mapCancellationError({ code: '55000', message: 'trip_cancelled' })).toBe('trip_cancelled');
    expect(mapCancellationError({ code: '55000', message: 'already_decided' })).toBe('already_decided');
  });
});

const request = {
  id: '11111111-1111-4111-8111-111111111111', refNo: 'RF-2026-000001', kind: 'cancellation', outcome: 'payout', status: 'paid',
  customerChargePaise: '1000000', amountPaise: '4000000', heldAtRequestPaise: '5000000', payeeKind: 'original_payer',
  payeeName: 'Synthetic Payer', payeeReason: null, payeeReceiptId: '22222222-2222-4222-8222-222222222222', reason: 'Synthetic reason text',
  requestedByName: 'Synthetic Sales', requestedAt: '2026-11-11T10:00:00Z', requestedAs: 'sales_owner', decidedByName: 'Synthetic Manager',
  decidedAt: '2026-11-11T11:00:00Z', returnReason: null, withdrawnByName: null, withdrawnAt: null, withdrawReason: null, rowVersion: 3,
  payout: { mode: 'bank_transfer', paidOn: '2026-11-11', reference: 'SYNRF0001', evidenceId: '33333333-3333-4333-8333-333333333333',
    recordedByName: 'Synthetic Accounts' },
  creditNote: null, can: { resubmit: false, withdraw: false, approve: false, return: false, payout: false }, sneaky: 'dropped',
};
const view = (viewer: 'accounts' | 'manager' | 'sales') => ({
  dealId: '44444444-4444-4444-8444-444444444444', dealReference: 'SYN-DEL-001', viewer, enabled: true, heldPaise: '1000000',
  cancellation: { id: '55555555-5555-4555-8555-555555555555', status: 'approved' }, chargesKeptPaise: '200000', basisTotalPaise: '1000000',
  maxRefundPaise: '1000000', canRequest: false, payers: [], requests: [request],
  supplierRefunds: [], marginPaise: '9999',
});

describe('section 10 DTO fence', () => {
  it('unknown keys are stripped; the Sales owner never gets supplier refunds, payout reference or proof id', () => {
    const a = toDealRefunds(DealRefundsSchema.parse(view('accounts')));
    expect(a).not.toHaveProperty('marginPaise');
    expect(a.requests[0]).not.toHaveProperty('sneaky');
    expect(a.requests[0]!.payout).toMatchObject({ reference: 'SYNRF0001' });
    expect(a.supplierRefunds).toEqual([]);
    const s = toDealRefunds(DealRefundsSchema.parse(view('sales')));
    expect(s).not.toHaveProperty('supplierRefunds');
    expect(s.requests[0]!.payout).toMatchObject({ reference: null, evidenceId: null });
  });
  it('a float or a malformed amount fails closed', () => {
    expect(DealRefundsSchema.safeParse({ ...view('accounts'), heldPaise: '10.5' }).success).toBe(false);
    expect(DealRefundsSchema.safeParse({ ...view('accounts'), maxRefundPaise: 100 }).success).toBe(false);
  });
  it('additive Flight / Visa cancellation keys parse with every key listed', () => {
    expect(FlightBatchCancellationKeysSchema.parse({ ticketsCancelled: true, cancellation: { state: 'approved', revisionNo: 2,
      airlineChargePaise: '100000', refundExpectedPaise: '500000', refundReportedPaise: null, supplierRefundReceivedPaise: '0',
      canEnter: true, extra: 1 } })).toEqual({ ticketsCancelled: true, cancellation: { state: 'approved', revisionNo: 2,
      airlineChargePaise: '100000', refundExpectedPaise: '500000', refundReportedPaise: null, supplierRefundReceivedPaise: '0', canEnter: true, note: null } });
    expect(VisaCancellationSchema.safeParse({ cancellationId: '55555555-5555-4555-8555-555555555555', status: 'open', approved: false,
      fees: [] }).success).toBe(true);
  });
});
