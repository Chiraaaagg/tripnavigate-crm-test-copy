import { describe, expect, it } from 'vitest';
import { DIFFERENCE_PATH, compareTripFacts, compareTripFactsDetailed, differenceKey } from '@/modules/documents/facts-diff';
import { factsSet } from './b12-documents-fixtures';

/**
 * B1.2 Phase F: factual differences in Atlas 0500's shape ({path, kind}, kind
 * missing | different | extra; missing uses the basis index, extra and
 * different the itinerary index). Synthetic values only.
 */

const diff = (o: Parameters<typeof factsSet>[0]) => compareTripFacts(factsSet(), factsSet(o));

describe('compareTripFacts', () => {
  it('identical facts have no difference; case, accents and punctuation do not count', () => {
    expect(compareTripFacts(factsSet(), factsSet())).toEqual([]);
    const b = factsSet();
    b.stays[0]!.hotelName = 'SYNTHETIC  marina-hotel';
    b.inclusions = ['daily breakfast.', 'Desert Safari with dinner'];
    expect(compareTripFacts(factsSet(), b)).toEqual([]);
  });

  it('dates, destination and travellers', () => {
    expect(diff({ startDate: '2026-11-21', endDate: null, destination: 'Oman' })).toEqual([
      { path: 'destination', kind: 'different' },
      { path: 'startDate', kind: 'different' },
      { path: 'endDate', kind: 'missing' },
    ]);
    expect(diff({ party: { adults: 3, children: 2, childAges: [6, 10], infants: 1 } })).toEqual([
      { path: 'party.adults', kind: 'different' },
      { path: 'party.infants', kind: 'different' },
      { path: 'party.childAges', kind: 'different' },
    ]);
    // Child ages compared only when both sides know them (no age bands).
    expect(diff({ party: { adults: 2, children: 2, childAges: null, infants: 0 } })).toEqual([]);
  });

  it('nights per city, hotels and room details', () => {
    const d = factsSet();
    d.stays[0]!.nights = 4;
    d.stays[1]!.nights = 1;
    d.stays[1]!.hotelName = 'Another synthetic hotel';
    d.stays[1]!.mealPlan = null;
    d.stays[0]!.rooms = 3;
    expect(compareTripFacts(factsSet(), d)).toEqual([
      { path: 'stays[0].nights', kind: 'different' },
      { path: 'stays[0].rooms', kind: 'different' },
      { path: 'stays[1].nights', kind: 'different' },
      { path: 'stays[1].hotelName', kind: 'different' },
      { path: 'stays[1].mealPlan', kind: 'missing' },
    ]);
  });

  it('a hotel the quotation left open but the itinerary names is extra', () => {
    const basis = factsSet();
    basis.stays[1]!.hotelName = null;
    expect(compareTripFacts(basis, factsSet())).toEqual([{ path: 'stays[1].hotelName', kind: 'extra' }]);
  });

  it('a different city order is one difference on stays', () => {
    const d = factsSet();
    d.stays.reverse();
    expect(compareTripFacts(factsSet(), d)).toEqual([{ path: 'stays', kind: 'different' }]);
  });

  it('transfers, activities and flights: missing uses the basis index, extra and different the itinerary index', () => {
    const d = factsSet({
      transfers: [{ date: '2026-11-24', from: 'DXB airport', to: 'Dubai hotel', mode: 'Private car' }],
      activities: [
        { date: '2026-11-22', city: 'Dubai', name: 'Dhow cruise', included: true },
        { date: '2026-11-21', city: 'Dubai', name: 'Desert safari', included: false },
      ],
      flights: [],
    });
    expect(compareTripFacts(factsSet(), d)).toEqual([
      { path: 'transfers[0].date', kind: 'different' },
      { path: 'transfers[1]', kind: 'missing' },
      { path: 'activities[1].included', kind: 'different' },
      { path: 'activities[0]', kind: 'extra' },
      { path: 'flights[0]', kind: 'missing' },
    ]);
  });

  it('inclusions and exclusions: missing, extra, and moved between the lists', () => {
    expect(diff({ inclusions: ['Daily breakfast', 'Visa fees', 'Travel insurance'], exclusions: ['Desert safari with dinner'] })).toEqual([
      { path: 'exclusions[0]', kind: 'different' },
      { path: 'inclusions[1]', kind: 'different' },
      { path: 'inclusions[2]', kind: 'extra' },
    ]);
    expect(diff({ inclusions: ['Daily breakfast'], exclusions: [] })).toEqual([
      { path: 'inclusions[1]', kind: 'missing' },
      { path: 'exclusions[0]', kind: 'missing' },
    ]);
  });

  it("every path fits Atlas's stored pattern; differences carry paths and kinds only, unique per pair", () => {
    const d = factsSet({
      startDate: null,
      transfers: [],
      activities: [{ date: null, city: null, name: 'Desert safari (sunset)', included: true }],
      inclusions: ['Free & easy evening'],
      exclusions: [],
    });
    d.stays[0]!.hotelName = 'Secret synthetic name';
    const out = compareTripFacts(factsSet(), d);
    expect(out.length).toBeGreaterThan(5);
    for (const x of out) {
      expect(x.path).toMatch(DIFFERENCE_PATH);
      expect(Object.keys(x).sort()).toEqual(['kind', 'path']);
    }
    expect(new Set(out.map((x) => `${x.path}|${x.kind}`)).size).toBe(out.length);
    expect(JSON.stringify(out)).not.toContain('Secret');
  });

  it('compareTripFactsDetailed carries the basis value behind each difference (in memory only)', () => {
    const basis = factsSet();
    const d = factsSet({
      party: { adults: 3, children: 2, childAges: [6, 9], infants: 0 },
      transfers: [{ date: '2026-11-24', from: 'DXB airport', to: 'Dubai hotel', mode: 'Private car' }],
      activities: [{ date: '2026-11-22', city: 'Dubai', name: 'Dhow cruise', included: true }, ...basis.activities],
      inclusions: ['Daily breakfast', 'Visa fees'],
      exclusions: ['Desert safari with dinner'],
    });
    d.stays[0]!.hotelName = 'Another synthetic hotel';
    const r = compareTripFactsDetailed(basis, d);
    expect(r.differences).toEqual(compareTripFacts(basis, d));
    const at = (path: string, kind: 'missing' | 'different' | 'extra') => r.basisValues.get(differenceKey({ path, kind }));
    expect(at('party.adults', 'different')).toBe(2);
    expect(at('stays[0].hotelName', 'different')).toBe('Synthetic Marina Hotel');
    expect(at('transfers[0].date', 'different')).toBe('2026-11-20');
    expect(at('transfers[1]', 'missing')).toEqual(basis.transfers[1]);
    expect(at('activities[0]', 'extra')).toBeNull();
    expect(at('exclusions[0]', 'different')).toBe('Desert safari with dinner');
    expect(at('inclusions[1]', 'different')).toBe('Visa fees');
    expect(r.basisValues.size).toBe(r.differences.length);

    const reordered = factsSet();
    reordered.stays.reverse();
    expect(compareTripFactsDetailed(basis, reordered).basisValues.get('different:stays')).toEqual(basis.stays);
  });
});
