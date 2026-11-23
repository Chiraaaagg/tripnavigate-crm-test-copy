import { describe, expect, it } from 'vitest';
import { validateServiceFacts } from '@/modules/fulfilment/forms';

/**
 * Client-side mirror of authz.validate_service_facts (contract §8, freeze
 * note §3.3): required keys, limits, unknown keys, date range, check-out
 * after check-in, ordered flight segments, IATA codes and HH:MM times.
 */

const hotel = {
  hotelName: 'Synthetic Palace',
  city: 'Jaipur',
  checkIn: '2026-11-01',
  checkOut: '2026-11-04',
  rooms: 1,
  adults: 2,
};
const transfer = { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2 };
const activity = { name: 'City walk', city: 'Jaipur', date: '2026-11-02', participants: 2 };
const flight = {
  segments: [
    { from: 'DEL', to: 'JAI', date: '2026-11-01' },
    { from: 'JAI', to: 'DEL', date: '2026-11-04' },
  ],
  passengers: 2,
};

describe('validateServiceFacts', () => {
  it('accepts complete facts of every type', () => {
    expect(validateServiceFacts('hotel', hotel)).toEqual([]);
    expect(validateServiceFacts('transfer', { ...transfer, pickupTime: '09:30', notes: 'two bags' })).toEqual([]);
    expect(validateServiceFacts('activity', { ...activity, time: '23:59', notes: null })).toEqual([]);
    expect(validateServiceFacts('flight', { ...flight, cabin: 'Economy', preferredTime: 'morning' })).toEqual([]);
  });

  it('refuses a non-object and unknown keys (never a selling value inside facts)', () => {
    expect(validateServiceFacts('hotel', null)).toEqual(['facts']);
    expect(validateServiceFacts('hotel', [])).toEqual(['facts']);
    expect(validateServiceFacts('transfer', { ...transfer, sellingTotalPaise: '100' })).toEqual(['sellingTotalPaise']);
    expect(validateServiceFacts('hotel', { ...hotel, route: 'x' })).toEqual(['route']);
  });

  it('reports missing and out-of-range required fields by key', () => {
    expect(validateServiceFacts('hotel', { ...hotel, hotelName: '', rooms: 0, adults: 101 }).sort()).toEqual(['adults', 'hotelName', 'rooms']);
    expect(validateServiceFacts('transfer', { route: 'a'.repeat(201), date: '2026-11-01', vehicleType: 'Sedan', passengers: 0 }).sort()).toEqual([
      'passengers',
      'route',
    ]);
    expect(validateServiceFacts('activity', { ...activity, name: undefined })).toEqual(['name']);
    expect(validateServiceFacts('flight', { ...flight, passengers: 2.5 })).toEqual(['passengers']);
  });

  it('checks dates: ISO, 2000-01-01..2100-12-31, check-out after check-in', () => {
    expect(validateServiceFacts('hotel', { ...hotel, checkIn: '2026-02-30' })).toEqual(['checkIn']);
    expect(validateServiceFacts('hotel', { ...hotel, checkIn: '1999-12-31' })).toEqual(['checkIn']);
    expect(validateServiceFacts('transfer', { ...transfer, date: '2101-01-01' })).toEqual(['date']);
    expect(validateServiceFacts('hotel', { ...hotel, checkIn: '2026-11-04', checkOut: '2026-11-04' })).toEqual(['checkOut']);
    expect(validateServiceFacts('hotel', { ...hotel, checkIn: '2026-11-05', checkOut: '2026-11-04' })).toEqual(['checkOut']);
  });

  it('checks optional text limits, times and children', () => {
    expect(validateServiceFacts('hotel', { ...hotel, roomType: 'r'.repeat(121), children: -1 }).sort()).toEqual(['children', 'roomType']);
    expect(validateServiceFacts('transfer', { ...transfer, pickupTime: '24:00' })).toEqual(['pickupTime']);
    expect(validateServiceFacts('transfer', { ...transfer, pickupTime: '9:30' })).toEqual(['pickupTime']);
    expect(validateServiceFacts('activity', { ...activity, time: '12:60', notes: 'n'.repeat(2001) }).sort()).toEqual(['notes', 'time']);
    expect(validateServiceFacts('flight', { ...flight, cabin: 'c'.repeat(41), preferredTime: 'p'.repeat(61) }).sort()).toEqual(['cabin', 'preferredTime']);
    expect(validateServiceFacts('hotel', { ...hotel, inclusions: 'a\u0000b' })).toEqual(['inclusions']);
  });

  it('checks flight segments: count, IATA codes, non-decreasing dates, unknown keys', () => {
    expect(validateServiceFacts('flight', { ...flight, segments: [] })).toEqual(['segments']);
    expect(validateServiceFacts('flight', { ...flight, segments: Array(9).fill(flight.segments[0]) })).toEqual(['segments']);
    // B1.1: IATA code or a place name; digits and one-letter values stay invalid.
    expect(validateServiceFacts('flight', { ...flight, segments: [{ from: 'd1', to: 'J', date: '2026-11-01' }] }).sort()).toEqual([
      'segments[0].from',
      'segments[0].to',
    ]);
    expect(
      validateServiceFacts('flight', {
        ...flight,
        segments: [
          { from: 'DEL', to: 'JAI', date: '2026-11-04' },
          { from: 'JAI', to: 'DEL', date: '2026-11-01' },
        ],
      }),
    ).toEqual(['segments[1].date']);
    // Same-day connections are allowed (non-decreasing).
    expect(
      validateServiceFacts('flight', {
        ...flight,
        segments: [
          { from: 'DEL', to: 'BOM', date: '2026-11-01' },
          { from: 'BOM', to: 'GOI', date: '2026-11-01' },
        ],
      }),
    ).toEqual([]);
    expect(validateServiceFacts('flight', { ...flight, segments: [{ ...flight.segments[0], fare: 1 }] })).toEqual(['segments[0]']);
  });
});
