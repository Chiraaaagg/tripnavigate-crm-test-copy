import type { RefundKind, RefundOutcome } from './contracts';

/**
 * Pure mirror of the refund money rules (contract 7.2). The database decides;
 * the screen uses this to show the maximum and refuse early with the same
 * field the database would name. Whole paise as bigint; no floats.
 *
 * - cancellation, payout or keep_credit: 1 <= amount <= held - charge
 * - cancellation, charge_only: amount 0, any charge (the customer may owe the difference)
 * - overpayment (payout or keep_credit, charge 0): 1 <= amount <= held - basis total
 */

export type LimitIssue =
  | { field: 'outcome' | 'customerChargePaise' | 'amountPaise'; code: 'invalid_input' }
  | { field: 'amountPaise' | 'heldPaise'; code: 'refund_exceeds_money' }
  | { field: 'approvedChargePaise'; code: 'charge_below_approved' }
  | { field: 'cancellation' | 'booking'; code: 'not_ready' };

export interface LimitInput {
  kind: RefundKind;
  outcome: RefundOutcome;
  heldPaise: bigint;
  chargePaise: bigint;
  amountPaise: bigint;
  /** Dues total (approved settlement charge, else the basis selling total); null without a confirmed booking. */
  basisTotalPaise: bigint | null;
  cancellationApproved: boolean;
  /** Addendum L7: highest charge of an approved settlement; null when none. */
  approvedChargePaise?: bigint | null;
  /** Addendum L7: unused kept credit (reserved unless useKeptCredit). */
  keptCreditUnusedPaise?: bigint;
  useKeptCredit?: boolean;
}

/** The largest refund the rules allow (0 when none). */
export function maxRefundPaise(input: Pick<LimitInput, 'kind' | 'heldPaise' | 'chargePaise' | 'basisTotalPaise' | 'keptCreditUnusedPaise'
  | 'useKeptCredit'>): bigint {
  const kept = input.useKeptCredit ? 0n : (input.keptCreditUnusedPaise ?? 0n);
  const max = input.kind === 'cancellation'
    ? input.heldPaise - input.chargePaise - kept
    : input.basisTotalPaise === null ? 0n : input.heldPaise - input.basisTotalPaise - kept;
  return max > 0n ? max : 0n;
}

/** First refusal in the database's order, or null when the request is within the rules. */
export function checkRefundLimits(input: LimitInput): LimitIssue | null {
  if (input.kind === 'overpayment' && input.outcome === 'charge_only') return { field: 'outcome', code: 'invalid_input' };
  if (input.chargePaise < 0n || (input.kind === 'overpayment' && input.chargePaise !== 0n)) {
    return { field: 'customerChargePaise', code: 'invalid_input' };
  }
  if (input.outcome === 'charge_only' ? input.amountPaise !== 0n : input.amountPaise < 1n) {
    return { field: 'amountPaise', code: 'invalid_input' };
  }
  if (input.useKeptCredit && input.outcome !== 'payout') return { field: 'amountPaise', code: 'invalid_input' };
  if (input.kind === 'cancellation' && !input.cancellationApproved) return { field: 'cancellation', code: 'not_ready' };
  // Addendum L6 / L7 (database order): money held below zero, then the approved charge floor.
  if (input.heldPaise < 0n) return { field: 'heldPaise', code: 'refund_exceeds_money' };
  if (input.kind === 'cancellation' && input.approvedChargePaise != null && input.chargePaise < input.approvedChargePaise) {
    return { field: 'approvedChargePaise', code: 'charge_below_approved' };
  }
  if (input.kind === 'overpayment' && input.basisTotalPaise === null) return { field: 'booking', code: 'not_ready' };
  if (input.outcome !== 'charge_only' && input.amountPaise > maxRefundPaise(input)) {
    return { field: 'amountPaise', code: 'refund_exceeds_money' };
  }
  return null;
}
