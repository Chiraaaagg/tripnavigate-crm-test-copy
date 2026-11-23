import { describe, expect, it } from 'vitest';
import type { BookingFormServiceItemView } from '@/modules/fulfilment/booking-form-contract';
import { latestStep } from '@/views/b11/result';
import { passengersContent } from '@/views/booking-form/passenger-display';
import type { PassengerRow } from '@/views/booking-form/passenger-drawer';
import { sameServiceItem } from '@/views/booking-form/service-model';

/*
 * Booking reliability B1-5 (BR-20, BR-34): "Load the latest and keep my
 * entries" re-bases a drawer or card only when the latest view still holds
 * what it was opened on. The comparison never changes what is typed.
 */

const hotel = (over: Partial<BookingFormServiceItemView> = {}): BookingFormServiceItemView => ({
  itemId: 'item-1',
  itemNo: 1,
  serviceType: 'hotel',
  facts: { hotelName: 'Sample Inn', city: 'Jaipur', checkIn: '2027-01-10', checkOut: '2027-01-12', rooms: 1 },
  summary: '10 Jan to 12 Jan · 1 room',
  participants: [1, 2],
  locked: false,
  ...over,
});

describe('drawer re-base check', () => {
  it('re-bases when the item is unchanged (another part of the booking changed)', () => {
    expect(sameServiceItem(hotel(), hotel({ summary: 'shown differently' }))).toBe(true);
  });

  it('ignores the order of keys and of travellers', () => {
    const a = hotel({ facts: { city: 'Jaipur', hotelName: 'Sample Inn', checkIn: '2027-01-10', checkOut: '2027-01-12', rooms: 1 }, participants: [2, 1] });
    expect(sameServiceItem(hotel(), a)).toBe(true);
  });

  it('refuses when a colleague changed the same item', () => {
    expect(sameServiceItem(hotel(), hotel({ facts: { ...hotel().facts, rooms: 2 } }))).toBe(false);
    expect(sameServiceItem(hotel(), hotel({ participants: [1] }))).toBe(false);
    expect(sameServiceItem(hotel(), hotel({ locked: true }))).toBe(false);
  });

  it('refuses when the item is gone', () => {
    expect(sameServiceItem(hotel(), null)).toBe(false);
    expect(sameServiceItem(hotel(), hotel({ itemId: 'item-2' }))).toBe(false);
  });

  it('a drawer adding a new item has nothing to overwrite', () => {
    expect(sameServiceItem(null, null)).toBe(true);
    expect(sameServiceItem(null, hotel())).toBe(true);
  });

  it('leaves the compared values untouched', () => {
    const opened = hotel();
    const before = JSON.stringify(opened);
    sameServiceItem(opened, hotel({ facts: { ...opened.facts, city: 'Udaipur' } }));
    expect(JSON.stringify(opened)).toBe(before);
  });
});

describe('card re-base check (passengers)', () => {
  const row = (seq: number | null, name: string, key?: string): PassengerRow => ({ seq, name, type: 'adult', age: '', needs: '', requests: [], ...(key ? { key } : {}) });

  it('equal when the saved passengers are the same, wherever they sit on screen', () => {
    const opened = { travellers: [row(null, '', 'adult-slot-0'), row(2, 'Ravi Rao', 'adult-slot-1'), row(1, 'Asha Rao')], removed: [] };
    const latest = { travellers: [row(1, 'Asha Rao'), row(2, 'Ravi Rao')], removed: [] };
    expect(passengersContent(opened)).toBe(passengersContent(latest));
  });

  it('different when a colleague renamed or added a passenger', () => {
    const opened = { travellers: [row(1, 'Asha Rao')], removed: [] };
    expect(passengersContent(opened)).not.toBe(passengersContent({ travellers: [row(1, 'Asha Sharma')], removed: [] }));
    expect(passengersContent(opened)).not.toBe(passengersContent({ travellers: [row(1, 'Asha Rao'), row(2, 'New')], removed: [] }));
  });
});

describe('"Load the latest" decides only on the view that arrived (review P1-2)', () => {
  const opened = hotel();
  const base = 5;

  it('view arrives after the press and the same item changed: "changed", no re-base', () => {
    // Render of the press: the old view (row version 5), the old item. Nothing is decided yet.
    expect(latestStep({ waiting: true, refreshing: true, versionBound: true, viewRowVersion: 5, base, sameAsOpened: sameServiceItem(opened, hotel()) })).toBe('wait');
    // Render that brings the refreshed view: row version 6 and the colleague's item, in the same render.
    const colleague = hotel({ facts: { ...opened.facts, rooms: 3 } });
    expect(latestStep({ waiting: true, refreshing: false, versionBound: true, viewRowVersion: 6, base, sameAsOpened: sameServiceItem(opened, colleague) })).toBe('changed');
  });

  it('view arrives after the press and only another part changed: re-base', () => {
    expect(latestStep({ waiting: true, refreshing: true, versionBound: true, viewRowVersion: 5, base, sameAsOpened: true })).toBe('wait');
    expect(latestStep({ waiting: true, refreshing: false, versionBound: true, viewRowVersion: 6, base, sameAsOpened: sameServiceItem(opened, hotel()) })).toBe('rebase');
  });

  it('a view that is not newer never lets a re-base through; the wait ends when the refresh does', () => {
    expect(latestStep({ waiting: true, refreshing: true, versionBound: true, viewRowVersion: 5, base, sameAsOpened: true })).toBe('wait');
    expect(latestStep({ waiting: true, refreshing: false, versionBound: true, viewRowVersion: 5, base, sameAsOpened: true })).toBe('stop');
  });

  it('nothing happens unless the button was pressed, and never for a form without a row version', () => {
    expect(latestStep({ waiting: false, refreshing: false, versionBound: true, viewRowVersion: 9, base, sameAsOpened: true })).toBe('idle');
    expect(latestStep({ waiting: true, refreshing: false, versionBound: false, viewRowVersion: 9, base, sameAsOpened: true })).toBe('stop');
  });
});
