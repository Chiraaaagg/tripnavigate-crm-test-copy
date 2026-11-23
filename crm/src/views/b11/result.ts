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
export function latestStep(s: {
  waiting: boolean;
  refreshing: boolean;
  versionBound: boolean;
  viewRowVersion: number;
  base: number;
  sameAsOpened: boolean;
  /** The latest view already holds exactly what is typed (re-review N3: the lost save was stored). Default false. */
  typedEqualsLatest?: boolean;
}): 'idle' | 'wait' | 'saved' | 'rebase' | 'changed' | 'stop' {
  if (!s.waiting) return 'idle';
  if (s.versionBound && s.viewRowVersion > s.base) return s.typedEqualsLatest ? 'saved' : s.sameAsOpened ? 'rebase' : 'changed';
  return s.refreshing ? 'wait' : 'stop';
}

/** One value as the comparison sees it: text trimmed with single spaces, keys sorted. */
function normalised(v: unknown): unknown {
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
  if (Array.isArray(v)) return v.map(normalised);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, normalised(o[k])]),
    );
  }
  return v ?? null;
}

/**
 * Booking reliability re-review N3 (pure, unit-tested): the latest view
 * already holds what the card has typed, so a save whose answer was lost was
 * in fact stored and nothing needs sending. `same` is the card's own
 * comparison when it has one; otherwise text is compared trimmed, with single
 * spaces. Anything else that differs means "not stored" (send as before).
 */
export function typedMatchesLatest<T>(typed: T, latest: T, same?: (a: T, b: T) => boolean): boolean {
  if (same) return same(typed, latest);
  return JSON.stringify(normalised(typed)) === JSON.stringify(normalised(latest));
}

/**
 * Re-review N3 (pure, unit-tested): "Try again" on a card whose save the
 * database cannot replay (customer & trip: its second step; payment plan: no
 * request id) reads the latest view first. Same as typed → the card is saved
 * and nothing is sent; otherwise the values are sent as before (a stale
 * version is refused by the database, never written twice).
 */
export function readFirstRetryStep(s: { refreshing: boolean; typedEqualsLatest: boolean }): 'wait' | 'saved' | 'send' {
  if (s.refreshing) return 'wait';
  return s.typedEqualsLatest ? 'saved' : 'send';
}
