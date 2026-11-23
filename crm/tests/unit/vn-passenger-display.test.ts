import { describe, expect, it } from 'vitest';
import { displayRows, isRealPassenger, overCount } from '@/views/booking-form/passenger-display';
import type { PassengerRow } from '@/views/booking-form/passenger-drawer';

/*
 * Voice-note batch (owner item 2): passenger rows on the booking form come as
 * slots per type from the counts; empty slots are never passengers; lowering
 * a count never drops a named or saved passenger.
 */

const row = (seq: number | null, name: string, type: PassengerRow['type'], key?: string): PassengerRow => ({ seq, name, type, age: '', needs: '', requests: [], key });

describe('passenger slots on screen', () => {
  it('shows one slot per counted traveller, grouped adult, child, infant', () => {
    const shown = displayRows([], { adults: 2, children: 1, infants: 1 });
    expect(shown.map((d) => d.type)).toEqual(['adult', 'adult', 'child', 'infant']);
    expect(shown.every((d) => d.row === null)).toBe(true);
    expect(new Set(shown.map((d) => d.key)).size).toBe(4);
  });

  it('fills slots with saved passengers first and never duplicates them', () => {
    const rows = [row(1, 'A', 'adult'), row(2, 'C', 'child')];
    const shown = displayRows(rows, { adults: 2, children: 1, infants: 0 });
    expect(shown.map((d) => d.row?.name ?? null)).toEqual(['A', null, 'C']);
    expect(shown[0]!.key).toBe('seq-1');
  });

  it('keeps named passengers over the count and reports the type', () => {
    const rows = [row(1, 'A', 'adult'), row(2, 'B', 'adult'), row(null, 'New', 'adult', 'adult-slot-2')];
    const shown = displayRows(rows, { adults: 1, children: 0, infants: 0 });
    expect(shown.map((d) => d.row?.name)).toEqual(['A', 'B', 'New']);
    expect(overCount(rows, { adults: 1, children: 0, infants: 0 })).toEqual([{ type: 'adult', named: 3, booked: 1 }]);
  });

  it('drops blank unsaved rows beyond the count (they are not passengers)', () => {
    const rows = [row(1, 'A', 'adult'), row(null, '', 'adult', 'adult-slot-1'), row(null, '  ', 'adult', 'adult-slot-2')];
    const shown = displayRows(rows, { adults: 1, children: 0, infants: 0 });
    expect(shown).toHaveLength(1);
    expect(overCount(rows, { adults: 1, children: 0, infants: 0 })).toEqual([]);
  });

  it('a saved passenger with a cleared name still counts (never silently removed)', () => {
    expect(isRealPassenger(row(3, '', 'adult'))).toBe(true);
    expect(isRealPassenger(row(null, '', 'adult'))).toBe(false);
    expect(displayRows([row(3, '', 'adult')], { adults: 0, children: 0, infants: 0 })).toHaveLength(1);
  });

  it('unknown counts give no slots', () => {
    expect(displayRows([], { adults: null, children: null, infants: null })).toEqual([]);
  });
});
