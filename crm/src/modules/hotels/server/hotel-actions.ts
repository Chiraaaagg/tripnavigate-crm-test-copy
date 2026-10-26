'use server';

import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { HotelOption, SearchResult } from '@/views/booking-form/vn-types';
import { searchQuery } from '@/modules/parties/party-forms';
import { searchHotels } from './hotels-db';

/**
 * Hotel name type-ahead in the hotel editor (voice-note batch, owner item 5).
 * requireStaff() first; the search runs under the staff member's own session
 * (hotel_catalogue_search decides the entities). The search words travel in
 * the action body only: never in a URL, never logged. At most 20 results;
 * fewer than 2 characters searches nothing (no full list is ever sent).
 */
const SEARCH_LIMIT = 20;
const UNAVAILABLE = 'The hotel list cannot be searched right now. Type the hotel name instead.';

function categoryText(star: string | null | undefined): string | null {
  return star && /^[1-7]$/.test(star) ? `${star} star` : null;
}

export async function searchHotelsAction(query: string, scope?: { city?: string }): Promise<SearchResult<HotelOption>> {
  const staff = await requireStaff();
  const q = searchQuery(query);
  if (!q) return { ok: true, items: [], more: false };
  const city = typeof scope?.city === 'string' ? scope.city.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  try {
    const result = await searchHotels(asRpcClient(staff.supabase), { query: q, city: city || null, limit: SEARCH_LIMIT, offset: 0 });
    return {
      ok: true,
      items: result.items.map((h) => ({ hotelId: h.id, name: h.name, city: h.city, area: h.area ?? null, category: categoryText(h.starCategory) })),
      more: result.hasMore,
    };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
}
