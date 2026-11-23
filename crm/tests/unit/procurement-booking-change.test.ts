import { describe, expect, it } from 'vitest';
import { bookingChangeLabel, formatChangeDate, formatFactValue, toBookingChangeDTO } from '@/modules/procurement/booking-change';
import { PurchaseBookingChangeRawSchema } from '@/modules/procurement/server/booking-change-rpc';

/**
 * Purchase "Booking changed" banner DTO (Accounts phase 8.5, track C): labels,
 * value text, dates as "25 Nov 2026", internal ids and money keys never shown.
 */

const T = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222222';
const V2 = '33333333-3333-4333-8333-333333333333';

function raw(over: Record<string, unknown> = {}) {
  return PurchaseBookingChangeRawSchema.parse({
    taskId: T, basisVersionId: V1, basisVersionNo: 1, currentVersionId: V2, currentVersionNo: 2,
    changedAt: '2026-11-10T09:00:00Z', canAck: true, budgetChanged: false, fields: [],
    travellers: { added: [], removed: [], renamed: [], typeChanged: [] }, tripChanged: null, ...over,
  });
}

describe('booking change banner DTO', () => {
  it('formats calendar dates as "25 Nov 2026" and leaves other text alone', () => {
    expect(formatChangeDate('2026-11-25')).toBe('25 Nov 2026');
    expect(formatChangeDate('2027-01-02')).toBe('2 Jan 2027');
    expect(formatChangeDate('Synthetic Deluxe')).toBe('Synthetic Deluxe');
    expect(formatChangeDate(null)).toBeNull();
    expect(formatFactValue('2026-12-13')).toBe('13 Dec 2026');
    expect(formatFactValue(['2026-12-10', 'Late arrival'])).toBe('10 Dec 2026, Late arrival');
    expect(formatFactValue({ date: '2026-12-11', name: 'Synthetic safari' })).toBe('Date: 11 Dec 2026; Activity: Synthetic safari');
    expect(formatFactValue(true)).toBe('Yes');
    expect(formatFactValue('  ')).toBeNull();
  });

  it('drops catalogueHotelId and money keys, labels the rest, formats trip dates', () => {
    const dto = toBookingChangeDTO(raw({
      fields: [
        { key: 'catalogueHotelId', before: '44444444-4444-4444-8444-444444444444', after: '55555555-5555-4555-8555-555555555555' },
        { key: 'hotelName', before: 'Synthetic Hotel A', after: 'Synthetic Hotel B' },
        { key: 'checkOut', before: '2026-12-13', after: '2026-11-25' },
        { key: 'estimatePaise', before: '100', after: '200' },
        { key: 'participants', before: [1], after: [1, 2] },
        { key: 'bedRemarks', before: null, after: 'Twin' },
      ],
      tripChanged: { start: { before: '2026-12-10', after: '2026-12-11' }, destination: { before: 'Synthetic City', after: 'Other City' } },
    }));
    expect(dto.fields).toEqual([
      { key: 'hotelName', label: 'Hotel', before: 'Synthetic Hotel A', after: 'Synthetic Hotel B' },
      { key: 'checkOut', label: 'Check-out', before: '13 Dec 2026', after: '25 Nov 2026' },
      { key: 'bedRemarks', label: 'Bed remarks', before: null, after: 'Twin' },
    ]);
    expect(dto.tripChanged).toEqual({
      destination: { before: 'Synthetic City', after: 'Other City' },
      start: { before: '10 Dec 2026', after: '11 Dec 2026' },
    });
    expect(JSON.stringify(dto)).not.toMatch(/catalogueHotelId|44444444|estimate|2026-12-13/);
    expect(bookingChangeLabel('someNewKey')).toBe('Some new key');
  });
});
