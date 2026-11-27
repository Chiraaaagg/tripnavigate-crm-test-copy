import { describe, expect, it } from 'vitest';
import { latestStep, readFirstRetryStep, typedMatchesLatest } from '@/views/b11/result';
import { planRowsOf } from '@/views/booking-form/before-submit';
import { customerInitial, type CustomerValues } from '@/views/booking-form/customer-trip-card';

/*
 * Booking reliability re-review N3: "Try again" on the customer card (only its
 * first database step has a request id) and on the payment plan card (no
 * request id) reads the latest view first. When that view already holds what
 * is typed, the lost save was stored: the card reads Saved and nothing is
 * sent. Otherwise the values are sent as before. "Load the latest" says Saved
 * in the same case instead of "Someone changed this part".
 */

type Vm = Parameters<typeof customerInitial>[0];
type View = Parameters<typeof customerInitial>[1];

const vm = (trip: { destination: string; start: string; end: string }) =>
  ({ party: { total: 2, children: 0, infants: 0 }, partyAdults: 2, trip: { ...trip, scope: 'domestic' }, customerType: 'individual', market: 'b2c' }) as unknown as Vm;
const view = { contacts: { contactName: 'Synthetic Customer', mobile: '', email: 'synthetic@example.test', contactConfirmed: true } } as unknown as View;

describe('customer card: "Try again" after a lost answer', () => {
  const typed: CustomerValues = customerInitial(vm({ destination: 'Jodhpur and Udaipur', start: '2027-01-10', end: '2027-01-13' }), view);

  it('the lost save was stored: the latest view holds the typed values → Saved, nothing sent', () => {
    const latest = customerInitial(vm({ destination: 'Jodhpur and Udaipur', start: '2027-01-10', end: '2027-01-13' }), view);
    const same = typedMatchesLatest(typed, latest);
    expect(same).toBe(true);
    expect(readFirstRetryStep({ refreshing: false, typedEqualsLatest: same })).toBe('saved');
  });

  it('spacing typed differently still counts as stored', () => {
    const latest = customerInitial(vm({ destination: 'Jodhpur and Udaipur', start: '2027-01-10', end: '2027-01-13' }), view);
    expect(typedMatchesLatest({ ...typed, destination: '  Jodhpur  and Udaipur ' }, latest)).toBe(true);
  });

  it('the save did not go through (the view still has the old trip) → send as before', () => {
    const latest = customerInitial(vm({ destination: 'Jodhpur', start: '2027-01-10', end: '2027-01-13' }), view);
    const same = typedMatchesLatest(typed, latest);
    expect(same).toBe(false);
    expect(readFirstRetryStep({ refreshing: false, typedEqualsLatest: same })).toBe('send');
  });

  it('nothing is decided while the latest view is still on its way', () => {
    expect(readFirstRetryStep({ refreshing: true, typedEqualsLatest: true })).toBe('wait');
  });

  it('"Load the latest" after the refusal says Saved, not "someone changed this part"', () => {
    const latest = customerInitial(vm({ destination: 'Jodhpur and Udaipur', start: '2027-01-10', end: '2027-01-13' }), view);
    expect(latestStep({ waiting: true, refreshing: false, versionBound: true, viewRowVersion: 9, base: 7, sameAsOpened: false, typedEqualsLatest: typedMatchesLatest(typed, latest) })).toBe('saved');
    // A colleague's different trip is still "changed".
    const other = customerInitial(vm({ destination: 'Jaisalmer', start: '2027-01-10', end: '2027-01-13' }), view);
    expect(latestStep({ waiting: true, refreshing: false, versionBound: true, viewRowVersion: 9, base: 7, sameAsOpened: false, typedEqualsLatest: typedMatchesLatest(typed, other) })).toBe('changed');
  });
});

describe('payment plan card: "Try again" after a lost answer (no request id)', () => {
  const plan = (amountPaise: string) => ({
    plan: [
      { label: 'Advance', amountPaise: '1000000', dueDate: '2026-12-20' },
      { label: 'Balance', amountPaise, dueDate: '2027-01-05' },
    ],
  });
  const typed = { rows: [{ label: 'Advance', amount: '10000', due: '2026-12-20' }, { label: 'Balance', amount: '25000', due: '2027-01-05' }] };

  it('the lost save was stored → Saved, nothing sent', () => {
    const latest = { rows: planRowsOf(plan('2500000') as never) };
    const same = typedMatchesLatest(typed, latest);
    expect(same).toBe(true);
    expect(readFirstRetryStep({ refreshing: false, typedEqualsLatest: same })).toBe('saved');
  });

  it('the stored plan differs (not stored, or a colleague changed it) → send as before; the database refuses a stale version', () => {
    const latest = { rows: planRowsOf(plan('2400000') as never) };
    const same = typedMatchesLatest(typed, latest);
    expect(same).toBe(false);
    expect(readFirstRetryStep({ refreshing: false, typedEqualsLatest: same })).toBe('send');
  });

  it('a removed instalment counts as different', () => {
    expect(typedMatchesLatest(typed, { rows: planRowsOf({ plan: [{ label: 'Advance', amountPaise: '1000000', dueDate: '2026-12-20' }] } as never) })).toBe(false);
  });
});
