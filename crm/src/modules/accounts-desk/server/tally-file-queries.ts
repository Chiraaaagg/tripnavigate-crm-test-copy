import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { AccountsDeskCommandError } from '../commands';
import type { TallyFilePreview, TallyLeftOutPage, TallyMatchPage, TallyPartyName } from '../contracts';
import { partyTallyName, type TallyFileArgs, tallyFilePreview, tallyLeftOut, tallyMatchGet } from '../tally-file';

/**
 * Tally import file reads (Accounts phase 3, R-C2..R-C4) under the staff member's own session. Accounts only: every
 * read is null for anyone else (the page shows "not available"). A refused argument (invalid_input) comes back as
 * { ok: false, invalid: field } so the form keeps what was typed. Reading is not audited.
 */

type Staff = Pick<StaffContext, 'supabase'>;
export type TallyReadResult<T> = { ok: true; data: T | null } | { ok: false; invalid: string | null };

function refusal(error: unknown): TallyReadResult<never> | null {
  if (!(error instanceof AccountsDeskCommandError)) return null;
  if (error.code === 'invalid_input') return { ok: false, invalid: error.hint ?? null };
  if (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'not_configured' || error.code === 'environment_unset') {
    return { ok: true, data: null };
  }
  return null;
}

async function read<T>(run: () => Promise<T | null>): Promise<TallyReadResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    const r = refusal(error);
    if (r) return r;
    throw error;
  }
}

/** R-C2: what goes in and what is left out (first 200 of each; counts complete). */
export function loadTallyFilePreview(staff: Staff, args: TallyFileArgs): Promise<TallyReadResult<TallyFilePreview>> {
  return read(() => tallyFilePreview(asRpcClient(staff.supabase), args));
}

/** R-C3: the left-out list of one file. */
export function loadTallyLeftOut(staff: Staff, exportId: string, after: string | null, limit = 100): Promise<TallyReadResult<TallyLeftOutPage>> {
  return read(() => tallyLeftOut(asRpcClient(staff.supabase), exportId, after, limit));
}

/** R-C4: one matching upload with its rows (outcome filter, keyset on the row number). */
export function loadTallyMatch(staff: Staff, batchId: string, outcome: string | null, after: string | null,
  limit = 100): Promise<TallyReadResult<TallyMatchPage>> {
  return read(() => tallyMatchGet(asRpcClient(staff.supabase), batchId, outcome, after, limit));
}

/** The Tally party name of a customer party (customer page). */
export function loadPartyTallyName(staff: Staff, partyId: string): Promise<TallyReadResult<TallyPartyName>> {
  return read(() => partyTallyName(asRpcClient(staff.supabase), partyId));
}
