import 'server-only';
import { z } from 'zod';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { callVn } from '@/modules/parties/server/parties-db';

/**
 * Typed wrappers for the hotel catalogue (migration 20261128000120; shapes:
 * Atlas notes atlas-vn-shapes.md section f and v2). Under the caller's own
 * session; refusals throw VnDbError (parties-db).
 */

export const HOTEL_STATUSES = ['active', 'inactive'] as const;
export const HOTEL_VERIFICATION = ['not_checked', 'checked'] as const;

const HitSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  city: z.string(),
  area: z.string().nullable(),
  address: z.string().nullable(),
  starCategory: z.string().regex(/^[1-7]$/).nullable(),
  verification: z.enum(HOTEL_VERIFICATION),
});
export type HotelSearchHit = z.infer<typeof HitSchema>;
const SearchSchema = z.object({ items: z.array(HitSchema), hasMore: z.boolean() });
export type HotelSearchResult = z.infer<typeof SearchSchema>;

const SavedSchema = z.object({ id: z.uuid(), rowVersion: z.number().int(), outcome: z.enum(['created', 'updated', 'unchanged']) });
export type HotelSaved = z.infer<typeof SavedSchema>;

export interface HotelFields {
  name?: string;
  city?: string;
  area?: string | null;
  address?: string | null;
  /** '1'..'7' (also "4 star", "4*"). */
  starCategory?: string | null;
  sourceRef?: string | null;
  status?: (typeof HOTEL_STATUSES)[number];
  verification?: (typeof HOTEL_VERIFICATION)[number];
}

/** Type-ahead for staff of the hotel's entity: 2+ characters (fewer = no items), active hotels, at most 50 per page. */
export function searchHotels(
  client: RpcClient,
  args: { query: string; city?: string | null; limit?: number; offset?: number },
): Promise<HotelSearchResult> {
  return callVn(client, 'hotel_catalogue_search', {
    p_query: args.query, p_city: args.city ?? null, p_limit: args.limit ?? 20, p_offset: args.offset ?? 0,
  }, SearchSchema);
}

/** Super Admin create (id null, row version 0) or edit, with a reason of 10-500 characters (audited). */
export function saveHotel(
  client: RpcClient,
  args: { legalEntityId: string; id: string | null; expectedRowVersion: number; fields: HotelFields; reason: string },
): Promise<HotelSaved> {
  return callVn(client, 'hotel_catalogue_save', {
    p_legal_entity_id: args.legalEntityId, p_id: args.id, p_expected_row_version: args.expectedRowVersion,
    p_fields: args.fields, p_reason: args.reason,
  }, SavedSchema);
}
