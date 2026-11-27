/**
 * Business refusals for "someone changed this / duplicate request" (booking
 * reliability build contract, item B1-1).
 *
 * The database used SQLSTATE 40001 for these refusals. PostgREST 14 treats
 * 40001 as a serialization failure and re-runs the whole request, which kept
 * stale saves looping on the server for hours. The refusals move to PT409
 * (PostgREST's custom-status prefix: answered once, as HTTP 409) in staged
 * migrations. The app accepts both codes from the first step, and keeps
 * accepting 40001 after the last one so a rollback stays safe.
 */
export const CONFLICT_SQLSTATE_OLD = '40001';
export const CONFLICT_SQLSTATE_NEW = 'PT409';

/** Every SQLSTATE a conflict refusal may arrive with. */
export const CONFLICT_SQLSTATES: ReadonlySet<string> = new Set([CONFLICT_SQLSTATE_OLD, CONFLICT_SQLSTATE_NEW]);

/** The token-table entry for a conflict refusal: either code, with its exact message token. */
export const CONFLICT_STATES = [CONFLICT_SQLSTATE_OLD, CONFLICT_SQLSTATE_NEW] as const;

export function isConflictSqlState(state: string | null | undefined): boolean {
  return typeof state === 'string' && CONFLICT_SQLSTATES.has(state);
}

/** True when `state` is one of the states a token-table entry allows (a single code or a list). */
export function stateMatches(allowed: string | readonly string[], state: string | null | undefined): boolean {
  if (typeof state !== 'string') return false;
  return typeof allowed === 'string' ? allowed === state : allowed.includes(state);
}
