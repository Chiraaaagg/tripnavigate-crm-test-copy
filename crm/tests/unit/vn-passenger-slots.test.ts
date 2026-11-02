import { describe, expect, it } from 'vitest';
import { countIssues, derivedAdults, passengerSlots, planTravellerSave } from '@/modules/fulfilment/passenger-slots';
import type { TravellerDetails } from '@/modules/fulfilment/contracts';

/* Voice-note batch: the count rule, passenger slots and the no-duplicate / no-silent-delete save plan. Made-up names only. */

const t = (seq: number, fullName: string, type: TravellerDetails['type'] = 'adult'): TravellerDetails => ({ seq, fullName, type, ageYears: null, specialNeeds: null });

describe('countIssues', () => {
  it('accepts an exact split and an empty draft', () => {
    expect(countIssues({ total: 5, adults: 3, children: 2, infants: 0 })).toEqual([]);
    expect(countIssues({ total: null, adults: null, children: null, infants: null })).toEqual([]);
    // A contact-only save: no total and the steppers at 0 is "no counts yet", not a refusal.
    expect(countIssues({ total: null, adults: null, children: 0, infants: 0 })).toEqual([]);
    expect(countIssues({ total: null, adults: 0, children: 0, infants: 0 })).toEqual([]);
  });
  it('refuses a larger split (owner example: 5 = 3 adults + 2 children)', () => {
    const [issue] = countIssues({ total: 5, adults: 3, children: 3, infants: 0 });
    expect(issue).toMatchObject({ code: 'split_over_total', field: 'adults' });
    expect(issue!.text).toBe('Adults, children and infants add up to 6, but the trip has 5 passengers. Change the counts so they add up to 5.');
  });
  it('refuses a smaller split and names the Deal when the total comes from it', () => {
    const [issue] = countIssues({ total: 5, adults: 2, children: 2, infants: 0 }, { totalFromDeal: true });
    expect(issue).toMatchObject({ code: 'split_under_total' });
    expect(issue!.text).toContain('If the total on the Deal is wrong, use Correct.');
  });
  it('asks for adults, the total and whole numbers in range', () => {
    expect(countIssues({ total: 5, adults: null, children: 2, infants: 0 })[0]).toMatchObject({ code: 'split_incomplete', field: 'adults' });
    expect(countIssues({ total: null, adults: 2, children: null, infants: null })[0]).toMatchObject({ code: 'total_missing', field: 'paxTotal' });
    expect(countIssues({ total: 101, adults: 2, children: null, infants: null })[0]).toMatchObject({ code: 'total_range' });
    expect(countIssues({ total: 5, adults: -1, children: 0, infants: 0 })[0]).toMatchObject({ code: 'count_range', field: 'adults' });
  });
  it('derives adults only when it is 0 or more', () => {
    expect(derivedAdults({ total: 5, children: 2, infants: null })).toBe(3);
    expect(derivedAdults({ total: 2, children: 2, infants: 1 })).toBeNull();
    expect(derivedAdults({ total: null, children: 0, infants: 0 })).toBeNull();
  });
});

describe('passengerSlots', () => {
  it('shows named passengers then empty places per type, with stable keys', () => {
    const plan = passengerSlots({ adults: 3, children: 2, infants: 0 }, [
      { seq: 4, type: 'child', fullName: 'Kid One' },
      { seq: 1, type: 'adult', fullName: 'Asha Example' },
    ]);
    expect(plan.slots.map((s) => s.key)).toEqual(['p-1', 'adult-2', 'adult-3', 'p-4', 'child-2']);
    expect(plan.overCount).toEqual([]);
    expect(plan.overCountText).toBeNull();
    // Same input again: same keys (a re-render or reopen never adds rows).
    expect(passengerSlots({ adults: 3, children: 2, infants: 0 }, [{ seq: 1, type: 'adult', fullName: 'Asha Example' }, { seq: 4, type: 'child', fullName: 'Kid One' }]).slots.map((s) => s.key)).toEqual(['p-1', 'adult-2', 'adult-3', 'p-4', 'child-2']);
  });
  it('keeps named passengers when a count goes down and says so', () => {
    const plan = passengerSlots({ adults: 1, children: 0, infants: 0 }, [
      { seq: 1, type: 'adult', fullName: 'A One' },
      { seq: 2, type: 'adult', fullName: 'A Two' },
      { seq: 3, type: 'child', fullName: 'C One' },
    ]);
    expect(plan.slots.filter((s) => s.kind === 'named')).toHaveLength(3);
    expect(plan.overCount.map((p) => p.seq)).toEqual([2, 3]);
    expect(plan.overCountText).toBe('2 adults named but the count says 1; 1 child named but the count says 0. Nobody was removed. Remove a passenger or change the counts.');
  });
});

describe('planTravellerSave', () => {
  const stored = [
    { seq: 1, fullName: 'A One', type: 'adult' as const },
    { seq: 2, fullName: 'A Two', type: 'adult' as const },
  ];
  it('saves named rows and creates only the new ones', () => {
    const plan = planTravellerSave({ stored, posted: [t(1, 'A One'), t(2, 'A Two'), t(3, 'C One', 'child')], removeSeqs: [] });
    expect(plan).toMatchObject({ ok: true, created: [3], removed: [] });
  });
  it('refuses a save that would delete a stored passenger without Remove passenger', () => {
    const plan = planTravellerSave({ stored, posted: [t(1, 'A One')], removeSeqs: [] });
    expect(plan).toMatchObject({ ok: false, code: 'removal_unconfirmed', seqs: [2] });
  });
  it('removes only what was explicitly removed', () => {
    expect(planTravellerSave({ stored, posted: [t(1, 'A One')], removeSeqs: [2] })).toMatchObject({ ok: true, removed: [2] });
    expect(planTravellerSave({ stored, posted: [t(1, 'A One'), t(2, 'A Two')], removeSeqs: [2] })).toMatchObject({ ok: false, code: 'removal_conflict' });
  });
  it('refuses the same person twice (a double-posted slot never creates a duplicate)', () => {
    const plan = planTravellerSave({ stored, posted: [t(1, 'A One'), t(2, 'A Two'), t(3, '  a   one ')], removeSeqs: [] });
    expect(plan).toMatchObject({ ok: false, code: 'duplicate_passenger', seqs: [3] });
  });
});
