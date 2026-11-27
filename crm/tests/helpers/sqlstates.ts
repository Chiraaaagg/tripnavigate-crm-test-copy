import { expect } from 'vitest';
import { CONFLICT_SQLSTATE_NEW, CONFLICT_SQLSTATE_OLD } from '@/lib/sqlstate';

/**
 * What a database test may see for a conflict token (booking reliability build
 * contract, item B1-1). Stage 1 allowed either code (functions not yet migrated
 * still raised 40001). Stage 2 (20261206000200 and 000210) is in the migration
 * history, so every conflict refusal now arrives as PT409 only. The app keeps
 * accepting 40001 (src/lib/sqlstate.ts); the database tests do not.
 */
export const CONFLICT_STATES_ALLOWED: readonly string[] = [CONFLICT_SQLSTATE_NEW];

/** The one SQLSTATE of every conflict refusal after stage 2 (existing tests pass it where they passed 40001). */
export const CONFLICT_STATE = CONFLICT_SQLSTATE_NEW;

/** The code the database used before B1-1; only tests about the change itself name it. */
export const CONFLICT_STATE_BEFORE = CONFLICT_SQLSTATE_OLD;

/** Exact code of authz.require_row_version after stage 1. */
export const ROW_VERSION_STATE = CONFLICT_SQLSTATE_NEW;

/**
 * Asserts a conflict refusal: the error carries one of the allowed codes and
 * exactly the message token. Works for node-postgres errors and Supabase
 * client errors (both expose `code` and `message`).
 */
export function expectConflict(error: unknown, token: string): void {
  expect(error, `expected a "${token}" refusal`).toBeTruthy();
  const e = error as { code?: unknown; message?: unknown };
  expect(CONFLICT_STATES_ALLOWED, `SQLSTATE of the "${token}" refusal`).toContain(e.code);
  expect(typeof e.message === 'string' ? e.message.trim() : e.message).toBe(token);
}
