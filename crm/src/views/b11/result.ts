import type { BookingActionResult } from '@/modules/fulfilment/contracts';
import type { FinanceLikeState } from './shapes';

/*
 * Pure: one result shape for every B1.1 form. Booking actions answer
 * BookingActionResult; finance actions answer FinanceActionState, shown the
 * same way (the keys of fieldErrors become the named fields).
 */

export type NormalisedResult = BookingActionResult<unknown> | { ok: false; code: 'unexpected'; message: string; issues?: undefined; offline?: true };

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

/**
 * One request id per submission (Echo B-H1): the database replays an id only
 * for the same payload. An exact retry after an unknown outcome (same key:
 * same values, same version) keeps the id, so the database answers it from
 * the replay; anything else gets a fresh id (booking reliability B1-4 e).
 */
export function requestIdFor(last: { id: string; key: string; unknown: boolean } | null, key: string, fresh: () => string): string {
  return last && last.unknown && last.key === key ? last.id : fresh();
}

/**
 * B1-5 (pure, unit-tested): what "Load the latest and keep my entries" does on
 * this render. All inputs are this render's values: the view's row version and
 * whether that view still holds what the form was opened on. Until a newer
 * view is in, nothing is decided ('wait'), so an older view can never let a
 * re-base through; 'stop' ends the wait when the refresh brought nothing newer.
 */
export function latestStep(s: { waiting: boolean; refreshing: boolean; versionBound: boolean; viewRowVersion: number; base: number; sameAsOpened: boolean }): 'idle' | 'wait' | 'rebase' | 'changed' | 'stop' {
  if (!s.waiting) return 'idle';
  if (s.versionBound && s.viewRowVersion > s.base) return s.sameAsOpened ? 'rebase' : 'changed';
  return s.refreshing ? 'wait' : 'stop';
}
