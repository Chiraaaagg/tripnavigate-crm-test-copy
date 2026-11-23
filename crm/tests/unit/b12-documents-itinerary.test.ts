import { describe, expect, it, vi } from 'vitest';

const loadBookNow = vi.fn();
vi.mock('@/modules/fulfilment/server/book-now', () => ({ BOOK_NOW_NOT_INSTALLED: 'not_installed', loadBookNow: (...a: unknown[]) => loadBookNow(...a) }));

import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import {
  ItineraryDocumentGetSchema,
  toAtlasFactsJson,
  basisFactsFromBooking,
  basisFactsFromQuotation,
  toItineraryDocumentView,
  toItineraryFactsDraft,
} from '@/modules/documents/itinerary-view';
import { QuotationGetSchema } from '@/modules/documents/quotation-view';
import { basisValueAt, computeItineraryDifferences, loadItineraryDocumentView } from '@/modules/documents/server/itinerary';
import { canonicalJson, valueHash } from '@/modules/documents/value-hash';

/**
 * B1.2 Phase F: itinerary reads against Atlas 0500 shapes (fake session
 * client), facts normalisation, the quotation basis and the differences
 * ready for itinerary_differences_save. Synthetic values only.
 */

const DOC = '22222222-2222-4222-8222-222222222222';
const QV = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function documentGet(o: { basisKind?: 'quotation_version' | 'booking_version' | 'none'; facts?: unknown } = {}) {
  return {
    documentId: DOC,
    title: 'Dubai family week',
    subject: { kind: 'quotation', quotationId: 'q1', dealId: null, branchCode: 'JDH' },
    draft: {
      draftId: 'd1', status: 'draft', rowVersion: 4, factsHash: 'b'.repeat(64), sourceFileId: 'f1', updatedAt: '2026-10-12T10:00:00+05:30',
      facts: 'facts' in o ? o.facts : {
        destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-23',
        party: { adults: 2, children: 1, childAges: [7], infants: 0 },
        stays: [{ city: 'Dubai', nights: 3, checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 }],
        days: [
          { n: 1, date: '2026-11-20', base: 'Dubai', title: 'Arrive', story: 'Check in and rest.', highlights: [], meals: null },
          { n: 2, base: 'Dubai', title: 'Desert', story: 'Afternoon desert safari.', highlights: ['Dunes'] },
          { n: 3, base: 'Dubai', title: 'Marina', story: 'Free day by the water.' },
          { n: 4, base: 'Dubai', title: 'Depart', story: 'Airport drop.' },
        ],
        transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
        activities: [{ date: '2026-11-21', city: 'Dubai', name: 'Desert safari', included: true }],
        inclusions: ['Daily breakfast'],
        provenance: { 'stays[0].hotelName': 'quotation' },
      },
    },
    basis: { kind: o.basisKind ?? 'quotation_version', id: (o.basisKind ?? 'quotation_version') === 'none' ? null : QV, hash: HASH },
    differences: { runId: null, current: false, items: [{ differenceId: 'x', path: 'startDate', kind: 'different', acknowledged: false, acknowledgedByName: null, acknowledgedAt: null, note: null }] },
    sources: [{ fileId: 'f1', fileName: 'synthetic-old-itinerary.pdf' }],
    jobs: [],
    rendered: [],
  };
}

function quotationGet() {
  return {
    reference: 'TQ-12', title: 'Dubai',
    version: { versionNo: 1, status: 'accepted', validUntil: '2026-10-19', sentAt: '2026-10-12T10:00:00+05:30', acceptedTier: 'quoted' },
    trip: { destination: 'UAE', start: '2026-11-20', end: '2026-11-23' },
    pax: { adults: 2, childrenWithBed: 1, childrenNoBed: 0, infants: 0 },
    content: { includes: ['Daily breakfast', 'Airport transfers'], excludes: ['Visa fees'] },
    tiers: [{ tierKey: 'quoted', label: null }],
    items: [
      { itemNo: 1, serviceType: 'hotel', tierKey: null, facts: { city: 'Dubai', checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2, adults: 2 } },
      { itemNo: 2, serviceType: 'hotel', tierKey: 'upgrade', facts: { city: 'Dubai', checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Palace', rooms: 2, adults: 2 } },
      { itemNo: 3, serviceType: 'transfer', tierKey: null, facts: { route: 'DXB Airport to Dubai hotel', date: '2026-11-20', vehicleType: 'Private car', passengers: 3 } },
      { itemNo: 4, serviceType: 'activity', tierKey: null, facts: { name: 'Desert safari', city: 'Dubai', date: '2026-11-22', participants: 3 } },
      { itemNo: 5, serviceType: 'flight', tierKey: null, facts: { segments: [{ from: 'BOM', to: 'DXB', date: '2026-11-20' }], passengers: 3 } },
    ],
    contacts: null,
    money: null,
  };
}

function fakeStaff(answers: Record<string, { data: unknown; error: { code?: string } | null }>, purchase = false) {
  const rpc = vi.fn(async (fn: string) => answers[fn] ?? { data: null, error: null });
  return {
    rpc,
    staff: {
      access: { userId: 'u1', memberships: purchase ? [{ legalEntityId: 'e', branchId: 'b', roleCode: 'purchase' }] : [], rolePermissions: [], grants: [] },
      supabase: { rpc },
    } as never,
  };
}

const BV = '44444444-4444-4444-8444-444444444444';
const quotationMoney = (acceptedTier: 'quoted' | 'upgrade' | null) => ({
  source: 'quotation_version', versionId: QV, acceptedTier,
  tiers: [
    {
      tierKey: 'upgrade', label: 'Palace', quotedTotalPaise: '30000000', payingTravellers: 3, perPersonPaise: '10000000', breakdownHasAmounts: false,
      breakdown: [{ categoryKey: 'hotels', descriptions: ['Synthetic Palace'], amountPaise: '1' }],
      plan: [{ seq: 1, label: 'Advance', amountPaise: '30000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null }],
    },
    {
      tierKey: 'quoted', label: null, quotedTotalPaise: '24000000', payingTravellers: 3, perPersonPaise: '8000000', breakdownHasAmounts: true,
      breakdown: [{ categoryKey: 'hotels', descriptions: ['Synthetic Marina Hotel'], amountPaise: '24000000' }],
      plan: [
        { seq: 2, label: 'Balance', amountPaise: '14000000', dueRule: 'days_before_start', dueDays: 15, dueDate: null },
        { seq: 1, label: 'Advance', amountPaise: '10000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null },
      ],
    },
  ],
});

describe('DEC-48 itinerary prices (selling side only)', () => {
  it('quotation basis: only the accepted tier, plan in order; every priced tier when none was accepted', () => {
    const accepted = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: quotationMoney('quoted') }), { today: '2026-10-12' });
    expect(accepted.prices).toHaveLength(1);
    expect(accepted.prices![0]).toMatchObject({ tierKey: 'quoted', quotedTotalPaise: '24000000', perPersonPaise: '8000000', breakdownHasAmounts: true });
    expect(accepted.prices![0]!.plan.map((p) => p.label)).toEqual(['Advance', 'Balance']);
    const open = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: quotationMoney(null) }), { today: '2026-10-12' });
    expect(open.prices!.map((t) => t.tierKey)).toEqual(['quoted', 'upgrade']);
    // Breakdown amounts only when they add up to the total.
    expect(open.prices![1]!.breakdown[0]!.amountPaise).toBeNull();
    // A tier without a total yet is left out.
    const m = quotationMoney(null);
    m.tiers[0] = { ...m.tiers[0]!, quotedTotalPaise: null as never, breakdownHasAmounts: null as never };
    const unpriced = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: m }), { today: '2026-10-12' });
    expect(unpriced.prices!.map((t) => t.tierKey)).toEqual(['quoted']);
    const r = itineraryToEngine(accepted);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.tiers).toHaveLength(1);
      expect(r.internalNotes).not.toContain('prices_not_shown');
    }
    expect(forbiddenKeyPaths(accepted)).toEqual([]);
  });

  it('booking basis: one line with the selling total and the plan; per person only when exact', () => {
    const money = { source: 'booking_version', versionId: BV, sellingTotalPaise: '24000000', plan: [{ seq: 1, label: 'Advance', amountPaise: '10000000', dueDate: '2026-10-20' }] };
    const view = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet({ basisKind: 'booking_version' }), money }), { today: '2026-10-12' });
    expect(view.prices).toEqual([
      {
        tierKey: 'quoted', label: null, quotedTotalPaise: '24000000', payingTravellers: 3, perPersonPaise: '8000000', breakdownHasAmounts: false,
        breakdown: [], hotels: null, plan: [{ seq: 1, label: 'Advance', amountPaise: '10000000', dueRule: 'fixed_date', dueDays: null, dueDate: '2026-10-20' }],
      },
    ]);
    const odd = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: { ...money, sellingTotalPaise: '10000000' } }), { today: '2026-10-12' });
    expect(odd.prices![0]!.perPersonPaise).toBeNull();
    const none = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: { ...money, sellingTotalPaise: null } }), { today: '2026-10-12' });
    expect(none.prices).toBeNull();
  });

  it('no money block (no price access, or a database before DEC-48): no price section', () => {
    expect(toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: null }), { today: '2026-10-12' }).prices).toBeNull();
    expect(toItineraryDocumentView(ItineraryDocumentGetSchema.parse(documentGet()), { today: '2026-10-12' }).prices).toBeNull();
  });

  it('refuses a money block carrying cost or margin keys', () => {
    const leaky = { source: 'booking_version', versionId: BV, sellingTotalPaise: '24000000', plan: [], costPaise: '1' };
    const view = toItineraryDocumentView(ItineraryDocumentGetSchema.parse({ ...documentGet(), money: leaky }), { today: '2026-10-12' });
    // Unknown keys are dropped by the schema, never carried into the view.
    expect(JSON.stringify(view)).not.toContain('costPaise');
  });
});

describe('itinerary facts and view', () => {
  it('normalises Atlas facts (missing keys as empty) and builds a leak-free view without prices', () => {
    const get = ItineraryDocumentGetSchema.parse(documentGet());
    const facts = toItineraryFactsDraft(get.draft);
    expect(facts).toMatchObject({ draftId: 'd1', sourceFileId: 'f1', flights: [], exclusions: [], provenance: { 'stays[0].hotelName': 'quotation' } });
    expect(facts.days[1]).toEqual({ n: 2, date: null, base: 'Dubai', title: 'Desert', story: 'Afternoon desert safari.', highlights: ['Dunes'], meals: null });
    const view = toItineraryDocumentView(get, { today: '2026-10-12' });
    expect(view).toMatchObject({ kind: 'itinerary', reference: 'Dubai family week', destination: 'UAE', prices: null });
    expect(forbiddenKeyPaths(view)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('synthetic-old-itinerary.pdf');
    const r = itineraryToEngine(view);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).toMatchObject({ days: 4, nights: 3, tiers: null });

    const empty = ItineraryDocumentGetSchema.parse(documentGet({ facts: null }));
    expect(toItineraryFactsDraft(empty.draft)).toMatchObject({ destination: null, stays: [], days: [], party: { adults: 0, children: 0, childAges: null, infants: 0 } });
  });

  it('the quotation basis takes common items plus the accepted tier; no child ages', () => {
    const basis = basisFactsFromQuotation(QuotationGetSchema.parse(quotationGet()));
    expect(basis).toEqual({
      destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-23',
      party: { adults: 2, children: 1, childAges: null, infants: 0 },
      stays: [{ city: 'Dubai', nights: 3, checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 }],
      transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
      activities: [{ date: '2026-11-22', city: 'Dubai', name: 'Desert safari', included: true }],
      flights: [{ date: '2026-11-20', from: 'BOM', to: 'DXB', carrier: null, number: null }],
      inclusions: ['Daily breakfast', 'Airport transfers'],
      exclusions: ['Visa fees'],
    });
  });
});

function bookNow() {
  return {
    trip: { destination: 'UAE', scope: 'international', start: '2026-11-20', end: '2026-11-23' },
    travellers: [
      { seq: 1, type: 'adult', ageYears: null }, { seq: 2, type: 'adult', ageYears: null },
      { seq: 3, type: 'child', ageYears: 7 },
    ],
    items: [
      { itemNo: 1, state: 'planned', facts: { type: 'hotel', facts: { city: 'Dubai', checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2, adults: 2 } } },
      { itemNo: 2, state: 'cancelled', facts: { type: 'hotel', facts: { city: 'Sharjah', checkIn: '2026-11-22', checkOut: '2026-11-23', hotelName: 'Gone', rooms: 1, adults: 2 } } },
      { itemNo: 3, state: 'planned', facts: { type: 'transfer', facts: { route: 'DXB Airport to Dubai hotel', date: '2026-11-20', vehicleType: 'Private car', passengers: 3 } } },
      { itemNo: 4, state: 'active', facts: { type: 'activity', facts: { name: 'Desert safari', city: 'Dubai', date: '2026-11-21', participants: 3 } } },
      { itemNo: 5, state: 'planned', facts: { type: 'flight', facts: { segments: [{ from: 'BOM', to: 'DXB', date: '2026-11-20' }], passengers: 3 } } },
      { itemNo: 6, state: 'planned', facts: { type: 'visa', facts: { country: 'UAE', purpose: 'tourism', travelDate: '2026-11-20', feePaidBy: 'customer' } } },
    ],
  } as never;
}

describe('booking basis', () => {
  it('builds facts from the working booking version: live items only, traveller counts and ages, no package lists', () => {
    expect(basisFactsFromBooking(bookNow())).toEqual({
      destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-23',
      party: { adults: 2, children: 1, childAges: [7], infants: 0 },
      stays: [{ city: 'Dubai', nights: 3, checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 }],
      transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
      activities: [{ date: '2026-11-21', city: 'Dubai', name: 'Desert safari', included: true }],
      flights: [{ date: '2026-11-20', from: 'BOM', to: 'DXB', carrier: null, number: null }],
      inclusions: null,
      exclusions: null,
    });
  });
});

describe('server reads (fake session client)', () => {
  it('loadItineraryDocumentView reads itinerary_document_get and counts open differences', async () => {
    const { staff, rpc } = fakeStaff({ itinerary_document_get: { data: documentGet(), error: null } });
    const r = await loadItineraryDocumentView(staff, DOC, new Date('2026-10-12T08:00:00Z'));
    expect(rpc).toHaveBeenCalledWith('itinerary_document_get', { p_document_id: DOC });
    expect(r).toMatchObject({ status: 'ok', draftStatus: 'draft', differencesOpen: 1, differencesCurrent: false, view: { generatedOn: '2026-10-12' } });
  });

  it('Purchase, bad ids and non-editors get not_found; unexpected answers are error', async () => {
    const p = fakeStaff({}, true);
    expect(await loadItineraryDocumentView(p.staff, DOC)).toEqual({ status: 'not_found' });
    expect(p.rpc).not.toHaveBeenCalled();
    expect(await loadItineraryDocumentView(fakeStaff({}).staff, 'x')).toEqual({ status: 'not_found' });
    expect(await loadItineraryDocumentView(fakeStaff({ itinerary_document_get: { data: null, error: null } }).staff, DOC)).toEqual({ status: 'not_found' });
    expect(await loadItineraryDocumentView(fakeStaff({ itinerary_document_get: { data: null, error: { code: 'XX000' } } }).staff, DOC)).toEqual({ status: 'error' });
    expect(await loadItineraryDocumentView(fakeStaff({ itinerary_document_get: { data: { documentId: 1 }, error: null } }).staff, DOC)).toEqual({ status: 'error' });
  });

  it('computeItineraryDifferences returns the save-ready basis and differences', async () => {
    const { staff, rpc } = fakeStaff({
      itinerary_document_get: { data: documentGet(), error: null },
      quotation_get: { data: quotationGet(), error: null },
    });
    const r = await computeItineraryDifferences(staff, DOC);
    expect(rpc).toHaveBeenCalledWith('quotation_get', { p_version_id: QV });
    expect(r).toMatchObject({
      status: 'ok', draftId: 'd1', rowVersion: 4, basisKind: 'quotation_version', basisId: QV, basisHash: HASH,
      differences: [
        { path: 'activities[0].date', kind: 'different' },
        { path: 'flights[0]', kind: 'missing' },
        { path: 'inclusions[1]', kind: 'missing' },
        { path: 'exclusions[0]', kind: 'missing' },
      ],
    });
    if (r.status !== 'ok') throw new Error('not ok');
    // "Use quotation value": the quotation side of each difference, in memory only.
    expect(basisValueAt(r, { path: 'activities[0].date', kind: 'different' })).toBe('2026-11-22');
    expect(basisValueAt(r, { path: 'flights[0]', kind: 'missing' })).toEqual({ date: '2026-11-20', from: 'BOM', to: 'DXB', carrier: null, number: null });
    expect(basisValueAt(r, { path: 'inclusions[1]', kind: 'missing' })).toBe('Airport transfers');
    expect(basisValueAt(r, { path: 'exclusions[0]', kind: 'missing' })).toBe('Visa fees');
    expect(basisValueAt(r, { path: 'startDate', kind: 'different' })).toBeUndefined();
    // What goes to itinerary_differences_save: path, kind and two value hashes (never a value).
    for (const d of r.differences) {
      expect(Object.keys(d).sort()).toEqual(['basisValueHash', 'factsValueHash', 'kind', 'path']);
      expect(d.factsValueHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.basisValueHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const dateDiff = r.differences.find((d) => d.path === 'activities[0].date')!;
    expect(dateDiff.basisValueHash).toBe(valueHash('2026-11-22'));
    expect(dateDiff.factsValueHash).toBe(valueHash('2026-11-21'));
    // A missing item has no itinerary value: its facts hash is the hash of null.
    expect(r.differences.find((d) => d.path === 'flights[0]')!.factsValueHash).toBe(valueHash(null));
    expect(JSON.stringify(r.differences)).not.toMatch(/BOM|Airport transfers|Visa fees|2026-11-22/);
  });

  it('a basis of none has no differences', async () => {
    expect(await computeItineraryDifferences(fakeStaff({ itinerary_document_get: { data: documentGet({ basisKind: 'none' }), error: null } }).staff, DOC)).toMatchObject({
      status: 'ok', basisKind: 'none', basisId: null, differences: [],
    });
  });

  it('a booking basis is read with loadBookNow and must be the version Atlas named', async () => {
    const deal = { ...documentGet({ basisKind: 'booking_version' }), subject: { kind: 'deal', quotationId: null, dealId: 'deal-1' } };
    const s = () => fakeStaff({ itinerary_document_get: { data: deal, error: null } }).staff;
    loadBookNow.mockResolvedValueOnce(Object.assign(bookNow(), { version: { versionId: QV } }));
    const r = await computeItineraryDifferences(s(), DOC);
    expect(loadBookNow).toHaveBeenLastCalledWith(expect.anything(), 'deal-1');
    expect(r).toMatchObject({ status: 'ok', basisKind: 'booking_version', basisId: QV });
    if (r.status === 'ok') expect(basisValueAt(r, { path: 'flights[0]', kind: 'missing' })).toEqual({ date: '2026-11-20', from: 'BOM', to: 'DXB', carrier: null, number: null });
    // Inclusions are not compared against a booking (it records none).
    if (r.status === 'ok') expect(r.differences.filter((d) => d.path.startsWith('inclusions') || d.path.startsWith('exclusions'))).toEqual([]);
    loadBookNow.mockResolvedValueOnce(Object.assign(bookNow(), { version: { versionId: "another-version" } }));
    expect(await computeItineraryDifferences(s(), DOC)).toEqual({ status: 'basis_changed' });
    loadBookNow.mockResolvedValueOnce(null);
    expect(await computeItineraryDifferences(s(), DOC)).toEqual({ status: 'not_found' });
    loadBookNow.mockRejectedValueOnce(new Error('synthetic'));
    expect(await computeItineraryDifferences(s(), DOC)).toEqual({ status: 'error' });
  });
});

describe('value hashes', () => {
  it('canonical JSON sorts keys at every depth and reads undefined as null', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(valueHash({ from: 'BOM', to: 'DXB' })).toBe(valueHash({ to: 'DXB', from: 'BOM' }));
    expect(valueHash('Dubai')).not.toBe(valueHash('dubai'));
    expect(valueHash(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('optional cover and narrative copy', () => {
  const narrativeFacts = {
    destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-22',
    stays: [{ city: 'Dubai', nights: 2, checkIn: '2026-11-20', checkOut: '2026-11-22', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', rooms: 1 }],
    coverWord: 'Dubai', country: 'UAE', category: 'Family', roomBasis: 'Double sharing',
    introduction: 'A calm synthetic week.\n\nSecond paragraph.', reasons: ['One base, no hotel moves', 'Short drives'],
    handledByUs: ['Every transfer'], youBring: ['Passports'],
  };

  it('reads the keys into the draft and the view, and writes them back only when present', () => {
    const get = ItineraryDocumentGetSchema.parse(documentGet({ facts: narrativeFacts }));
    const draft = toItineraryFactsDraft(get.draft);
    expect(draft.narrative).toEqual({
      coverWord: 'Dubai', country: 'UAE', category: 'Family', roomBasis: 'Double sharing',
      introduction: ['A calm synthetic week.', 'Second paragraph.'], reasons: ['One base, no hotel moves', 'Short drives'],
      handledByUs: ['Every transfer'], youBring: ['Passports'],
    });
    const view = toItineraryDocumentView(get, { today: '2026-10-12' });
    expect(view).toMatchObject({ destinationShort: 'Dubai', country: 'UAE', category: 'Family', paxBasis: 'Double sharing' });
    const r = itineraryToEngine(view);
    if (!r.ok) throw new Error('refused');
    expect(r.input).toMatchObject({
      destinationShort: 'Dubai', intro: ['A calm synthetic week.', 'Second paragraph.'], weHandle: ['Every transfer'], youBring: ['Passports'],
      reasons: [{ title: 'One base, no hotel moves', body: '' }, { title: 'Short drives', body: '' }],
    });
    // Written back in Atlas 0500's shape: introduction one text, reasons a list of texts.
    expect(toAtlasFactsJson(draft)).toMatchObject({
      coverWord: 'Dubai', introduction: 'A calm synthetic week.\n\nSecond paragraph.', reasons: ['One base, no hotel moves', 'Short drives'], handledByUs: ['Every transfer'],
    });

    const plain = toItineraryFactsDraft(ItineraryDocumentGetSchema.parse(documentGet()).draft);
    expect(plain.narrative).toBeUndefined();
    expect(Object.keys(toAtlasFactsJson(plain))).not.toContain('coverWord');
  });

  it('empty optional copy is never a placeholder', () => {
    const view = toItineraryDocumentView(ItineraryDocumentGetSchema.parse(documentGet()), { today: '2026-10-12' });
    const r = itineraryToEngine(view);
    if (!r.ok) throw new Error('refused');
    expect(r.input).toMatchObject({ destinationShort: null, country: null, category: null, paxBasis: null, intro: [], reasons: [], weHandle: [], youBring: [] });
    expect(r.placeholders).toEqual([]);
  });
});

describe('null-tolerant itinerary reader (same pattern as the quotation day text fix)', () => {
  it('null or missing optional values in the stored facts parse; empty core text becomes a placeholder, never a crash', () => {
    const facts = {
      destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-22',
      party: { adults: 2, children: null, childAges: null, infants: null },
      stays: [{ city: 'Dubai', nights: 2, checkIn: '2026-11-20', checkOut: '2026-11-22', hotelName: null, roomType: null, mealPlan: null, rooms: null }],
      days: [
        { n: 1, date: null, base: 'Dubai', title: 'Arrive', story: null, highlights: null, meals: null },
        { n: 2, base: 'Dubai', title: null },
        { n: 3, date: null, base: null, title: 'Depart', story: 'Airport drop.', highlights: [], meals: null },
      ],
      transfers: [{ date: null, from: 'DXB Airport', to: null, mode: null }],
      activities: [{ date: null, city: null, name: 'Desert safari', included: null }],
      flights: null,
      inclusions: null,
      exclusions: null,
      provenance: null,
      introduction: null,
      reasons: null,
    };
    const get = ItineraryDocumentGetSchema.parse(documentGet({ facts }));
    const draft = toItineraryFactsDraft(get.draft);
    expect(draft.party).toEqual({ adults: 2, children: 0, childAges: null, infants: 0 });
    expect(draft.days[0]).toEqual({ n: 1, date: null, base: 'Dubai', title: 'Arrive', story: '', highlights: [], meals: null });
    expect(draft.days[1]).toEqual({ n: 2, date: null, base: 'Dubai', title: '', story: '', highlights: [], meals: null });
    expect(draft).toMatchObject({ flights: [], inclusions: [], exclusions: [], provenance: {}, activities: [{ included: true }] });
    expect(draft.narrative).toBeUndefined();

    const r = itineraryToEngine(toItineraryDocumentView(get, { today: '2026-10-12' }));
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.placeholders).toEqual(expect.arrayContaining(['Day story', 'Day title', 'Hotel name', 'Room type', 'Drop point']));
    expect(r.input.daysList[0]).toMatchObject({ title: 'Arrive', story: '[Day story]' });
  });
});
