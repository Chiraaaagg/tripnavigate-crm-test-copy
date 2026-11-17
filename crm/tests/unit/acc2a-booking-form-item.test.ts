import { describe, expect, it } from 'vitest';
import { FormItemSchema } from '@/modules/fulfilment/b11-commands';

/**
 * Accounts phase 2, Track A (Addendum A1 follow-up): booking_form_get hotel
 * items carry an item-level catalogueHotelId (20261204000130, LD22); the
 * booking form read keeps it instead of stripping it.
 */

const HOTEL = '44444444-4444-4444-8444-444444444444';
const item = (over: Record<string, unknown> = {}) => ({
  itemId: '33333333-3333-4333-8333-333333333333',
  itemNo: 1,
  serviceType: 'hotel',
  department: 'purchase',
  state: 'active',
  facts: { type: 'hotel', facts: { hotelName: 'Synthetic Palace', city: 'Jaipur', checkIn: '2026-11-01', checkOut: '2026-11-04', rooms: 1, adults: 2 } },
  factsHash: 'b'.repeat(64),
  task: null,
  ...over,
});

describe('booking form item: catalogueHotelId', () => {
  it('survives the read; null and absent stay as sent; anything but a uuid is refused', () => {
    expect(FormItemSchema.parse(item({ catalogueHotelId: HOTEL })).catalogueHotelId).toBe(HOTEL);
    expect(FormItemSchema.parse(item({ catalogueHotelId: null })).catalogueHotelId).toBeNull();
    expect('catalogueHotelId' in FormItemSchema.parse(item())).toBe(false);
    expect(FormItemSchema.safeParse(item({ catalogueHotelId: 'not-a-uuid' })).success).toBe(false);
  });
});
