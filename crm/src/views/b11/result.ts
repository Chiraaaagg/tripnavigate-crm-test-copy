import type { BookingActionResult } from '@/modules/fulfilment/contracts';
import type { FinanceLikeState } from './shapes';

/*
 * Pure: one result shape for every B1.1 form. Booking actions answer
 * BookingActionResult; finance actions answer FinanceActionState, shown the
 * same way (the keys of fieldErrors become the named fields).
 */

export type NormalisedResult = BookingActionResult<unknown> | { ok: false; code: 'unexpected'; message: string; issues?: undefined };

/** Finance actions answer FinanceActionState; show them like booking results (fields = keys of fieldErrors). */
export function normaliseResult(raw: unknown): NormalisedResult {
  if (raw && typeof raw === 'object' && 'status' in raw && !('ok' in raw)) {
    const f = raw as FinanceLikeState;
    if (f.status === 'ok') return { ok: true, data: undefined, message: f.message ?? 'Done.' };
    return {
      ok: false,
      code: (f.code ?? 'invalid_input') as 'invalid_input',
      message: f.message ?? '',
      fields: f.fieldErrors ? Object.keys(f.fieldErrors).filter((k) => k !== '_form') : undefined,
    };
  }
  return raw as NormalisedResult;
}
