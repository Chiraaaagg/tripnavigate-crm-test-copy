import 'server-only';
import { z } from 'zod';
import { type RpcClient, type RpcError, asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  SEARCH_LIMITS,
  type SearchErrorCode,
  type SearchHitRecord,
  type SearchKind,
  type SearchPageRecord,
  normaliseSearchQuery,
  searchQueryLength,
} from '../contracts';

/**
 * Direction A Batch 5 (contracts.md section E): one page of Leads or Deals
 * matching a search, from public.crm_search (Atlas migration 20261126000100).
 *
 * - The read runs as the caller: this module only ever uses the signed-in
 *   person's own Supabase client (staff.supabase), never the privileged
 *   client, so the existing list policies decide every row.
 * - supabase-js sends rpc as a POST, so the search words travel only in the
 *   request body. Nothing here logs, stores or reports the words.
 * - The database returns ids and references only; the caller maps them to
 *   list rows with the existing scoped list reads by id.
 * - `nextAfter` is an opaque string (base64url of the database cursor
 *   {n, id}); it is checked again here and by the database before use.
 *
 * Server code only. runCrmSearch never throws.
 */

export type CrmSearchOutcome =
  | { ok: true; query: string; page: SearchPageRecord; titlesSearched: boolean }
  | { ok: false; query: string; code: SearchErrorCode };

/** Database keyset cursor (the reply's `next`). n is the Bitrix number as a decimal string, or null (a Deal without one). */
export interface SearchCursor {
  n: string | null;
  id: string;
}

const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const MAX_CURSOR_LENGTH = 200;
const BITRIX_NUMBER = /^[1-9][0-9]{0,17}$/;

export class CrmSearchError extends Error {
  override name = 'CrmSearchError';
  constructor(
    readonly code: SearchErrorCode,
    readonly sqlState: string | null,
  ) {
    // Never includes the search words.
    super(`crm_search failed${sqlState ? ` (${sqlState})` : ''}: ${code}`);
  }
}

/** Maps a database refusal to a search state. Anything unexplained (including an ended sign-in) is 'unexpected'. */
export function mapCrmSearchError(error: RpcError): SearchErrorCode {
  const state = error.code ?? '';
  if (FUNCTION_MISSING_STATES.has(state)) return 'not_installed';
  if (state === '42501') return 'not_authorized';
  if (state === '22023' && (error.message ?? '').trim() === 'invalid_input' && (error.hint ?? '').trim() === 'query') return 'too_short';
  return 'unexpected';
}

const CursorSchema = z
  .object({
    n: z.string().regex(BITRIX_NUMBER).nullable(),
    id: z.uuid(),
  })
  .strict();

/** Opaque, URL-safe form of the database cursor. */
export function encodeSearchAfter(next: SearchCursor): string {
  return Buffer.from(JSON.stringify({ n: next.n, id: next.id }), 'utf8').toString('base64url');
}

/**
 * The database cursor from an opaque `after` value: null for the first page
 * (absent or empty), 'invalid' for anything that is not a cursor this module
 * issued for that kind (a Lead cursor always has a number).
 */
export function decodeSearchAfter(kind: SearchKind, raw: unknown): SearchCursor | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return 'invalid';
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return 'invalid';
  }
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success) return 'invalid';
  if (kind === 'lead' && parsed.data.n === null) return 'invalid';
  return parsed.data;
}

const ReplySchema = z.object({
  kind: z.enum(['lead', 'deal']),
  titlesSearched: z.boolean(),
  hits: z
    .array(
      z.object({
        kind: z.enum(['lead', 'deal']),
        id: z.uuid(),
        reference: z.string().min(1).max(40),
      }),
    )
    .max(50),
  hasMore: z.boolean(),
  next: CursorSchema.nullable(),
});

/**
 * Parses the database reply strictly (fail closed): the kind must be the one
 * asked for, every hit valid and of that kind, ids unique. Keys are copied one
 * by one. nextAfter is set only when there is more and the cursor is valid.
 */
export function parseCrmSearchReply(kind: SearchKind, data: unknown): { page: SearchPageRecord; titlesSearched: boolean } {
  const parsed = ReplySchema.safeParse(data);
  if (!parsed.success || parsed.data.kind !== kind) throw new CrmSearchError('unexpected', null);
  const reply = parsed.data;
  const hits: SearchHitRecord[] = [];
  const seen = new Set<string>();
  for (const hit of reply.hits) {
    if (hit.kind !== kind || seen.has(hit.id)) throw new CrmSearchError('unexpected', null);
    seen.add(hit.id);
    hits.push({ kind, id: hit.id, reference: hit.reference });
  }
  let nextAfter: string | null = null;
  if (reply.hasMore) {
    if (reply.next === null || (kind === 'lead' && reply.next.n === null)) throw new CrmSearchError('unexpected', null);
    nextAfter = encodeSearchAfter(reply.next);
  }
  return { page: { hits, nextAfter }, titlesSearched: reply.titlesSearched };
}

/** One call to the database read with the caller's client. Throws CrmSearchError. */
export async function crmSearch(
  client: RpcClient,
  kind: SearchKind,
  query: string,
  after: SearchCursor | null,
  limit: number = SEARCH_LIMITS.pageSize,
): Promise<{ page: SearchPageRecord; titlesSearched: boolean }> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc('crm_search', { p_query: query, p_kind: kind, p_after: after, p_limit: limit });
  } catch {
    throw new CrmSearchError('unexpected', null);
  }
  if (result.error) throw new CrmSearchError(mapCrmSearchError(result.error), result.error.code ?? null);
  return parseCrmSearchReply(kind, result.data);
}

/**
 * The search a list screen runs. Never throws.
 *   too_short      fewer than 2 characters after normalising (no database call)
 *   not_installed  the database has no crm_search yet
 *   not_authorized the database refused the person
 *   unexpected     anything else, including a cursor this module did not issue (no database call)
 * `query` is the normalised text in every outcome, so the box can keep it.
 * The caller refuses Purchase on Leads before calling (as loadLeads does).
 */
export async function runCrmSearch(
  staff: Pick<StaffContext, 'supabase'>,
  kind: SearchKind,
  rawQuery: unknown,
  rawAfter: unknown,
): Promise<CrmSearchOutcome> {
  const query = normaliseSearchQuery(rawQuery);
  if (searchQueryLength(query) < SEARCH_LIMITS.minLength) return { ok: false, query, code: 'too_short' };
  const after = decodeSearchAfter(kind, rawAfter);
  if (after === 'invalid') return { ok: false, query, code: 'unexpected' };
  try {
    const { page, titlesSearched } = await crmSearch(asRpcClient(staff.supabase), kind, query, after);
    return { ok: true, query, page, titlesSearched };
  } catch (error) {
    return { ok: false, query, code: error instanceof CrmSearchError ? error.code : 'unexpected' };
  }
}
