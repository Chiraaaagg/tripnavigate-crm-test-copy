import type { WriteOffDirection } from './contracts';

/**
 * Pure mirror of the write-off amount rules (contract 6.6, LD16). The
 * database decides; the screen uses this to refuse early with the same token.
 * Whole paise as decimal strings (or bigint); no floats.
 *
 * - the amount is the WHOLE current balance (due) or credit (excess), and > 0;
 * - then at most the limit (setting, 1..500000 paise = Rs 5,000).
 */

/** The ceiling of the per-Deal limit setting: Rs 5,000 (owner Q9). */
export const WRITE_OFF_MAX_LIMIT_PAISE = 500000n;
/** Default limit of a new entity. */
export const WRITE_OFF_DEFAULT_LIMIT_PAISE = 500000n;

export interface WriteOffAmountInput {
  direction: WriteOffDirection;
  amountPaise: string | bigint;
  /** Dues balance (what the customer still owes). */
  balancePaise: string | bigint;
  /** Dues credit (what the customer overpaid). */
  creditPaise: string | bigint;
  limitPaise: string | bigint;
}

function toPaise(value: string | bigint): bigint | null {
  if (typeof value === 'bigint') return value;
  return /^-?(0|[1-9][0-9]{0,17})$/.test(value) ? BigInt(value) : null;
}

/** null when allowed; otherwise the refusal token the database would give. */
export function writeOffProblem(input: WriteOffAmountInput): 'write_off_not_balance' | 'write_off_over_limit' | null {
  const amount = toPaise(input.amountPaise);
  const whole = toPaise(input.direction === 'due' ? input.balancePaise : input.creditPaise);
  const limit = toPaise(input.limitPaise);
  if (amount === null || whole === null || amount < 1n || amount !== whole) return 'write_off_not_balance';
  if (limit === null || amount > limit) return 'write_off_over_limit';
  return null;
}

/** A limit setting is whole paise between 1 and the ceiling. */
export function limitAllowed(limitPaise: string | bigint): boolean {
  const v = toPaise(limitPaise);
  return v !== null && v >= 1n && v <= WRITE_OFF_MAX_LIMIT_PAISE;
}
