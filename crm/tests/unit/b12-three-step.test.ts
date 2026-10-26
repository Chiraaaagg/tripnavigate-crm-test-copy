import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_CODES } from '@/modules/fulfilment/commands';
import {
  BOOK_SECTION_STEP,
  BOOK_SECTIONS,
  BOOK_STEPS,
  type BookChecklistCode,
  type BookSection,
  type BookStepStatus,
  CHECKLIST_STEP,
  INTAKE_CHECKLIST_CODES,
  ITEM_SCOPED_CHECKLIST_CODES,
  LEGACY_BOOK_STEPS,
  LEGACY_STEP_TARGET,
  SERVICE_TYPES,
} from '@/modules/fulfilment/contracts';
import { bookSectionStatus, bookStepStatus, mergeBookChecklist, routeChecklistItems } from '@/modules/fulfilment/b11-dto';
import { parseBookTravellersForm, parseBookTripBlockForm, parseBookTripForm } from '@/modules/fulfilment/b11-forms';
import {
  HOTEL_SECTION_TYPES,
  OTHER_SECTION_TYPES,
  advanceBase,
  bookHref,
  firstOpenHref,
  firstOpenStep,
  firstOpenTarget,
  isBookSection,
  isBookStep,
  isLegacyBookStep,
  itemsForSection,
  legacyStepHref,
  sectionHref,
  sectionsOf,
  serviceSection,
  travellerSeqHighWater,
} from '@/views/b11/book-fields';

/**
 * B1.2 three-step Book now (freeze note §2.1, Terra contract §1–§4): step and
 * section keys, legacy six-step addresses, the checklist → step/section map
 * (every code), item-scoped routing by service type, markers, the first place
 * needing input, the per-section row-version chain, and the split travellers
 * / trip-block parsers and actions on the existing commands. Synthetic ids.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const book = await import('@/modules/fulfilment/server/book-now-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const HASH = 'c'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply>) {
  rpc.mockImplementation(async (fn: string) => {
    const reply = map[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const allSections = (status: BookStepStatus): Record<BookSection, BookStepStatus> =>
  Object.fromEntries(BOOK_SECTIONS.map((s) => [s, status])) as Record<BookSection, BookStepStatus>;

describe('steps, sections and legacy addresses', () => {
  it('three steps; nine sections, each on exactly one step, in page order', () => {
    expect(BOOK_STEPS).toEqual(['travellers', 'stay', 'finish']);
    expect(sectionsOf('travellers')).toEqual(['customer', 'passengers']);
    expect(sectionsOf('stay')).toEqual(['trip', 'hotels']);
    expect(sectionsOf('finish')).toEqual(['services', 'identity', 'price', 'payment', 'review']);
    expect(BOOK_SECTIONS.every((s) => BOOK_STEPS.includes(BOOK_SECTION_STEP[s]))).toBe(true);
  });

  it('new and legacy keys are disjoint; unknown keys are neither', () => {
    for (const k of BOOK_STEPS) {
      expect(isBookStep(k)).toBe(true);
      expect(isLegacyBookStep(k)).toBe(false);
    }
    for (const k of LEGACY_BOOK_STEPS) {
      expect(isLegacyBookStep(k)).toBe(true);
      expect(isBookStep(k)).toBe(false);
    }
    expect(isBookStep('intake')).toBe(false);
    expect(isLegacyBookStep('intake')).toBe(false);
    expect(isBookSection('passengers')).toBe(true);
    expect(isBookSection('passenger-list')).toBe(false);
    expect(isBookSection('customer-list')).toBe(false);
  });

  it('every legacy step redirects to a section on its target step (frozen table)', () => {
    for (const k of LEGACY_BOOK_STEPS) expect(BOOK_SECTION_STEP[LEGACY_STEP_TARGET[k].section]).toBe(LEGACY_STEP_TARGET[k].step);
    expect(LEGACY_BOOK_STEPS.map((k) => legacyStepHref('d1', k))).toEqual([
      '/app/deals/d1/book/travellers#customer',
      '/app/deals/d1/book/travellers#customer',
      '/app/deals/d1/book/stay#hotels',
      '/app/deals/d1/book/finish#price',
      '/app/deals/d1/book/finish#payment',
      '/app/deals/d1/book/finish#review',
    ]);
  });

  it('section links: same step → plain fragment (not guarded); other step → address with fragment; first section → no fragment', () => {
    expect(sectionHref('d1', 'finish', 'price')).toBe('#price');
    expect(sectionHref('d1', 'finish', 'passengers')).toBe('/app/deals/d1/book/travellers#passengers');
    expect(sectionHref('d1', null, 'review')).toBe('/app/deals/d1/book/finish#review');
    expect(bookHref('d1', 'travellers', 'customer')).toBe('/app/deals/d1/book/travellers');
    expect(bookHref('d1', 'stay', 'hotels')).toBe('/app/deals/d1/book/stay#hotels');
  });
});

describe('CHECKLIST_STEP (every code, Terra contract §1.4)', () => {
  const codes: BookChecklistCode[] = [...new Set<BookChecklistCode>([...INTAKE_CHECKLIST_CODES, ...ISSUE_CODES])];

  it('covers every checklist and readiness code with a section on its step', () => {
    expect(codes.length).toBe(67); // + quote_party_differs (E5-6), prefill_unchecked (0600), 14 booking form codes, flight_screenshot_missing (Book now v2)
    for (const code of codes) {
      const t = CHECKLIST_STEP[code];
      expect(t, code).toBeDefined();
      expect(BOOK_SECTION_STEP[t.section], code).toBe(t.step);
    }
  });

  it('matches the frozen table', () => {
    const bySection = (section: BookSection) => codes.filter((c) => CHECKLIST_STEP[c].section === section).sort();
    expect(bySection('customer')).toEqual([
      'billing_contact_missing',
      'billing_missing',
      'billing_reach_missing',
      'billing_unverified',
      'contact_missing',
      'contact_not_confirmed',
      'gst_reason_missing',
      'gst_status_missing',
      'gstin_missing',
      'hotel_same_day_trip',
      'pax_missing',
      'pax_types_exceeded',
      'prefill_unchecked',
    ]);
    expect(bySection('passengers')).toEqual([
      'child_age_missing',
      'id_proof_missing',
      'id_proof_missing_child',
      'missing_travellers',
      'quote_party_differs',
      'traveller_count_mismatch',
      'traveller_missing',
      'traveller_name_incomplete',
    ]);
    expect(bySection('trip')).toEqual(['trip_missing']);
    expect(bySection('hotels')).toEqual([
      'check_out_not_after_check_in',
      'hotel_nights_missing',
      'hotel_outside_trip',
      'missing_city',
      'missing_dates',
      'missing_hotel_name',
      'missing_rooms',
      'quote_details_changed',
    ]);
    expect(bySection('services')).toEqual([
      'budget_missing',
      'dates_outside_trip',
      'flight_screenshot_missing',
      'missing_purchase_budget',
      'no_services',
      'participation_count_mismatch',
      'participation_missing',
      'service_dates_outside_trip',
      'service_facts_invalid',
      'visa_mentioned',
      'visa_waiting_for_launch',
    ]);
    expect(bySection('identity')).toEqual(['identity_missing', 'passport_details_later', 'passport_expiry_before_trip_end']);
    expect(bySection('price')).toEqual([
      'missing_selling_total',
      'missing_selling_total_ask_owner',
      'price_below_purchase',
      'price_count_mismatch',
      'price_missing',
      'prices_ask_owner',
      'selling_total_ask_owner',
      'selling_total_missing',
    ]);
    expect(bySection('payment')).toEqual(['plan_ask_owner', 'plan_missing', 'plan_total_mismatch']);
    expect(bySection('review')).toEqual([
      'acceptance_missing',
      'base_no_longer_returned',
      'booking_disabled',
      'customer_acceptance_required',
      'environment_unset',
      'evidence_upload_incomplete',
      'missing_acceptance_proof',
      'no_changes',
      'quote_acceptance_stale',
      'revision_class_missing',
      'source_not_recently_verified',
      'stage_not_confirmed',
    ]);
  });

  it('item-scoped codes default to step 3 services (routed by item when items are named)', () => {
    for (const code of ITEM_SCOPED_CHECKLIST_CODES) expect(CHECKLIST_STEP[code]).toMatchObject({ step: 'finish', section: 'services' });
  });
});

describe('item-scoped routing by service type', () => {
  const items = [
    { itemNo: 1, serviceType: 'hotel' as const, state: 'planned' as const },
    { itemNo: 2, serviceType: 'flight' as const, state: 'planned' as const },
    { itemNo: 3, serviceType: 'hotel' as const, state: 'planned' as const },
    { itemNo: 4, serviceType: 'transfer' as const, state: 'cancelled' as const },
  ];

  it('a row naming a hotel and a flight is listed on both steps with its own numbers', () => {
    const merged = mergeBookChecklist({ items: [{ code: 'service_facts_invalid', blocking: true, owner: 'sales', itemNos: [2, 1, 3] }], canConfirm: false }, [], items);
    expect(merged.map((i) => [i.step, i.section, i.itemNos, i.field])).toEqual([
      ['stay', 'hotels', [1, 3], null],
      ['finish', 'services', [2], null],
    ]);
    expect(merged[0]!.text).toMatch(/\(service 1, 3\)$/);
    expect(merged[1]!.text).toMatch(/\(service 2\)$/);
  });

  it('keeps the field of the code; unknown item numbers keep the default target', () => {
    const groups = routeChecklistItems('participation_missing', [3, 9], items);
    expect(groups).toEqual([
      { target: { step: 'stay', section: 'hotels', field: 'participantSeq' }, itemNos: [3] },
      { target: { step: 'finish', section: 'services', field: 'participantSeq' }, itemNos: [9] },
    ]);
  });

  it('without item numbers: hotels only when every active item is a hotel; otherwise (or no items) the default', () => {
    // A flight may be the one missing its budget: never guess hotels from the lowest item number.
    expect(routeChecklistItems('missing_purchase_budget', [], items)[0]!.target.section).toBe('services');
    expect(routeChecklistItems('missing_purchase_budget', [], [items[0]!, items[2]!, items[3]!])[0]!.target).toEqual({ step: 'stay', section: 'hotels', field: 'purchaseBudgetRupees' });
    expect(routeChecklistItems('missing_purchase_budget', [], [items[1]!, items[3]!])[0]!.target.section).toBe('services');
    expect(routeChecklistItems('missing_purchase_budget', [], [items[3]!])[0]!.target.section).toBe('services');
    expect(routeChecklistItems('missing_purchase_budget', [], [])[0]!.target.section).toBe('services');
    // Codes that are not item-scoped never move.
    expect(routeChecklistItems('visa_waiting_for_launch', [1], items)).toEqual([{ target: CHECKLIST_STEP.visa_waiting_for_launch, itemNos: [1] }]);
    expect(routeChecklistItems('no_services', [], items)[0]!.target).toEqual({ step: 'finish', section: 'services', field: null });
  });

  it('readiness-only item codes route the same way and are not repeated when the checklist has them', () => {
    const merged = mergeBookChecklist(
      { items: [{ code: 'budget_missing', blocking: false, owner: 'sales', itemNos: [1] }], canConfirm: false },
      ['missing_purchase_budget', 'service_facts_invalid'],
      items,
    );
    expect(merged.map((i) => [i.code, i.section])).toEqual([
      ['budget_missing', 'hotels'],
      ['missing_purchase_budget', 'services'],
      ['service_facts_invalid', 'services'],
    ]);
  });
});

describe('markers and the first place that needs input', () => {
  const checklist = {
    items: [
      { code: 'trip_missing' as const, blocking: true, owner: 'sales' as const, itemNos: [] },
      { code: 'passport_details_later' as const, blocking: false, owner: 'sales' as const, itemNos: [], travellerSeqs: [1] },
    ],
    canConfirm: false,
  };

  it('a step is the worst of its sections; not started → everything needs input', () => {
    const merged = mergeBookChecklist(checklist, []);
    expect(bookStepStatus(merged, true)).toEqual({ travellers: 'complete', stay: 'needs_input', finish: 'warnings_only' });
    expect(bookSectionStatus(merged, true)).toEqual({ ...allSections('complete'), trip: 'needs_input', identity: 'warnings_only' });
    expect(Object.values(bookSectionStatus([], false))).toEqual(Array(9).fill('needs_input'));
  });

  it('firstOpenTarget walks the steps, then the sections; review last', () => {
    const steps = { travellers: 'complete', stay: 'complete', finish: 'complete' } as const;
    expect(firstOpenTarget({ stepStatus: steps, sectionStatus: allSections('needs_input') })).toEqual({ step: 'travellers', section: null });
    expect(firstOpenTarget({ stepStatus: steps, sectionStatus: { ...allSections('complete'), hotels: 'needs_input', price: 'needs_input' } })).toEqual({ step: 'stay', section: 'hotels' });
    expect(firstOpenTarget({ stepStatus: steps, sectionStatus: { ...allSections('complete'), price: 'needs_input' } })).toEqual({ step: 'finish', section: 'price' });
    expect(firstOpenTarget({ stepStatus: steps, sectionStatus: { ...allSections('complete'), review: 'needs_input' } })).toEqual({ step: 'finish', section: 'review' });
    expect(firstOpenTarget({ stepStatus: steps, sectionStatus: { ...allSections('warnings_only') } })).toEqual({ step: 'finish', section: 'review' });
    expect(firstOpenHref('d1', { stepStatus: steps, sectionStatus: { ...allSections('complete'), services: 'needs_input' } })).toBe('/app/deals/d1/book/finish');
    expect(firstOpenHref('d1', { stepStatus: steps, sectionStatus: { ...allSections('complete'), passengers: 'needs_input' } })).toBe('/app/deals/d1/book/travellers#passengers');
    expect(firstOpenStep({ stepStatus: steps, sectionStatus: { ...allSections('complete'), trip: 'needs_input' } })).toBe('stay');
  });
});

describe('per-section row version chain (advanceBase)', () => {
  it('follows only this browser’s own saves; a foreign save leaves a gap', () => {
    expect(advanceBase(5, [])).toBe(5);
    expect(advanceBase(5, [{ from: 5, to: 6 }])).toBe(6);
    expect(advanceBase(5, [{ from: 5, to: 6 }, { from: 6, to: 8 }])).toBe(8);
    // Someone else saved 6 → 7; our next own save was 7 → 8: a section still at 5 stops at 6 and is refused on save.
    expect(advanceBase(5, [{ from: 5, to: 6 }, { from: 7, to: 8 }])).toBe(6);
    expect(advanceBase(7, [{ from: 5, to: 6 }])).toBe(7);
    // Never loops or goes backwards on a malformed chain.
    expect(advanceBase(5, [{ from: 5, to: 5 }])).toBe(5);
    expect(advanceBase(5, [{ from: 5, to: 4 }])).toBe(5);
  });
});

describe('hotels vs other services', () => {
  it('hotel on step 2; transfer, flight, activity, visa, passport on step 3; every type in exactly one', () => {
    expect([...HOTEL_SECTION_TYPES, ...OTHER_SECTION_TYPES].sort()).toEqual([...SERVICE_TYPES].sort());
    expect(SERVICE_TYPES.map((t) => [t, serviceSection(t)])).toEqual([
      ['hotel', 'hotels'],
      ['transfer', 'services'],
      ['activity', 'services'],
      ['flight', 'services'],
      ['visa', 'services'],
      ['passport', 'services'],
    ]);
    const items = [
      { itemNo: 3, serviceType: 'hotel' as const },
      { itemNo: 1, serviceType: 'flight' as const },
      { itemNo: 2, serviceType: 'hotel' as const },
    ];
    expect(itemsForSection(items, 'hotels').map((i) => i.itemNo)).toEqual([2, 3]);
    expect(itemsForSection(items, 'services').map((i) => i.itemNo)).toEqual([1]);
  });
});

describe('split parsers (step 1 passengers, step 2 trip block)', () => {
  const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5' };
  const trip = { destination: 'Bangkok', tripScope: 'international', tripStart: '2026-12-10', tripEnd: '2026-12-15' };
  const people = { travellerName: ['Asha', 'Ravi'], travellerType: ['adult', 'child'], travellerAge: ['', '7'] };

  it('passengers only; the trip keys are ignored', () => {
    const parsed = parseBookTravellersForm(form({ ...draft, ...people, ...trip }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        versionId: VERSION,
        expectedRowVersion: 5,
        travellers: [
          { fullName: 'Asha', type: 'adult', seq: 1, ageYears: null, specialNeeds: null },
          { fullName: 'Ravi', type: 'child', seq: 2, ageYears: 7, specialNeeds: null },
        ],
      },
    });
    expect(parsed.ok && 'trip' in parsed.value).toBe(false);
  });

  it('trip block always carries all four keys (booking_trip_save replaces all four)', () => {
    expect(parseBookTripBlockForm(form({ ...draft, ...trip }))).toEqual({
      ok: true,
      value: { dealId: DEAL, versionId: VERSION, expectedRowVersion: 5, trip: { destination: 'Bangkok', scope: 'international', start: '2026-12-10', end: '2026-12-15' } },
    });
    expect(parseBookTripBlockForm(form({ ...draft }))).toMatchObject({ ok: true, value: { trip: { destination: null, scope: null, start: null, end: null } } });
    expect(parseBookTripBlockForm(form({ ...draft, tripStart: '2026-12-10', tripEnd: '2026-12-01' }))).toEqual({ ok: false, fields: ['tripEnd'] });
  });

  it('the B1.1 combined parser is the composition of the two (unchanged)', () => {
    const both = parseBookTripForm(form({ ...draft, ...trip, ...people }));
    const a = parseBookTravellersForm(form({ ...draft, ...people }));
    const b = parseBookTripBlockForm(form({ ...draft, ...trip }));
    expect(both.ok && a.ok && b.ok).toBe(true);
    if (both.ok && a.ok && b.ok) expect(both.value).toEqual({ ...b.value, travellers: a.value.travellers });
  });

  it('existing travellers keep their own seq; new rows take the next free seq; no seqs posted → by position (B1.1)', () => {
    // Traveller 2 of 3 removed, one added: 1 and 3 keep their seqs, the new row is 4.
    const kept = parseBookTravellersForm(form({ ...draft, travellerName: ['Asha', 'Meera', 'New'], travellerType: ['adult', 'adult', 'child'], travellerSeq: ['1', '3', ''], travellerAge: ['', '', '4'] }));
    expect(kept.ok && kept.value.travellers.map((t) => [t.fullName, t.seq])).toEqual([
      ['Asha', 1],
      ['Meera', 3],
      ['New', 4],
    ]);
    const none = parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B'], travellerType: ['adult', 'adult'] }));
    expect(none.ok && none.value.travellers.map((t) => t.seq)).toEqual([1, 2]);
    // A blank row keeps its posted seq slot aligned with the other arrays.
    const blank = parseBookTravellersForm(form({ ...draft, travellerName: ['', 'B'], travellerType: ['', 'adult'], travellerSeq: ['1', '2'] }));
    expect(blank.ok && blank.value.travellers.map((t) => t.seq)).toEqual([2]);
  });

  it('new rows go above the highest seq the form was LOADED with: removing the last traveller and adding one never reuses its seq', () => {
    // Loaded 1, 2, 3; traveller 3 removed and "New" added in the same save.
    const parsed = parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B', 'New'], travellerType: ['adult', 'adult', 'adult'], travellerSeq: ['1', '2', ''], travellerSeqMax: '3' }));
    expect(parsed.ok && parsed.value.travellers.map((t) => [t.fullName, t.seq])).toEqual([
      ['A', 1],
      ['B', 2],
      ['New', 4],
    ]);
    // Without the high-water input (B1.1 screens) the old rule applies.
    const old = parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B', 'New'], travellerType: ['adult', 'adult', 'adult'], travellerSeq: ['1', '2', ''] }));
    expect(old.ok && old.value.travellers.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['adult'], travellerSeqMax: 'x' }))).toEqual({ ok: false, fields: ['travellerSeqMax'] });
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['adult'], travellerSeqMax: '100' }))).toEqual({ ok: false, fields: ['travellerName'] });
    expect(travellerSeqHighWater({ travellers: [{ seq: 1 }, { seq: 7 }, { seq: 3 }] as never })).toBe(7);
    expect(travellerSeqHighWater({ travellers: [] })).toBe(0);
  });

  it('a duplicate, zero, non-numeric or out-of-range seq names that row', () => {
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B'], travellerType: ['adult', 'adult'], travellerSeq: ['2', '2'] }))).toEqual({ ok: false, fields: ['travellerSeq[1]'] });
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['adult'], travellerSeq: ['0'] }))).toEqual({ ok: false, fields: ['travellerSeq[0]'] });
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['adult'], travellerSeq: ['x'] }))).toEqual({ ok: false, fields: ['travellerSeq[0]'] });
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['adult'], travellerSeq: ['101'] }))).toEqual({ ok: false, fields: ['travellerSeq[0]'] });
    // A new row after seq 100 has no free seq left.
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B'], travellerType: ['adult', 'adult'], travellerSeq: ['100', ''] }))).toEqual({ ok: false, fields: ['travellerName'] });
  });

  it('DEC-33: no age bands — a child or infant of any age 0–17 is accepted; the B1.1 0–17 rule is unchanged', () => {
    const ages = parseBookTravellersForm(form({ ...draft, travellerName: ['A', 'B', 'C'], travellerType: ['infant', 'child', 'infant'], travellerAge: ['15', '0', '3'] }));
    expect(ages.ok && ages.value.travellers.map((t) => t.ageYears)).toEqual([15, 0, 3]);
    expect(parseBookTravellersForm(form({ ...draft, travellerName: ['A'], travellerType: ['child'], travellerAge: ['18'] }))).toEqual({ ok: false, fields: ['travellerAge[0]'] });
  });
});

describe('split actions on the existing commands', () => {
  const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5' };

  it('saveBookTravellersAction: session first, then deal_travellers_save only', async () => {
    requireStaff.mockRejectedValueOnce(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(book.saveBookTravellersAction(null, form({ ...draft, travellerName: ['Asha'], travellerType: ['adult'] }))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();

    rpcReplies({ deal_travellers_save: { data: { rowVersion: 6, contentHash: HASH } } });
    await expect(book.saveBookTravellersAction(null, form({ ...draft, travellerName: ['Asha'], travellerType: ['adult'] }))).resolves.toEqual({
      ok: true,
      data: { rowVersion: 6, contentHash: HASH },
      message: 'Saved.',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('deal_travellers_save', {
      p_deal_id: DEAL,
      p_expected_row_version: 5,
      p_travellers: [{ fullName: 'Asha', type: 'adult', seq: 1, ageYears: null, specialNeeds: null }],
    });
  });

  it('saveBookTravellersAction: version_changed carries who saved; refusal is whole (nothing else ran)', async () => {
    rpcReplies({
      deal_travellers_save: { error: { code: '40001', message: 'version_changed' } },
      booking_form_get: {
        data: {
          dealId: DEAL, canEdit: true, canConfirm: true, serviceItemsEnabled: true, version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 7, contentHash: HASH, updatedAt: '2026-10-12T08:31:00Z', updatedByName: 'Rahul (synthetic)' },
          billing: { status: 'none', prefillSource: null, rowVersion: 0 }, travellers: [], items: [], evidence: [],
        },
      },
    });
    await expect(book.saveBookTravellersAction(null, form({ ...draft, travellerName: ['Asha'], travellerType: ['adult'] }))).resolves.toMatchObject({
      ok: false,
      code: 'version_changed',
      conflict: { savedByName: 'Rahul (synthetic)', savedAt: '2026-10-12T08:31:00Z' },
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['deal_travellers_save', 'booking_form_get']);
  });

  it('saveBookTripBlockAction: booking_trip_save only, all four keys; hints map to the trip inputs', async () => {
    rpcReplies({ booking_trip_save: { data: { rowVersion: 6, contentHash: HASH } } });
    await expect(book.saveBookTripBlockAction(null, form({ ...draft, destination: 'Goa', tripScope: 'domestic', tripStart: '2026-12-10', tripEnd: '' }))).resolves.toMatchObject({
      ok: true,
      data: { rowVersion: 6 },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('booking_trip_save', {
      p_version_id: VERSION,
      p_expected_row_version: 5,
      p_fields: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: null },
    });
    rpcReplies({ booking_trip_save: { error: { code: '22023', message: 'invalid_input', hint: 'start,end' } } });
    await expect(book.saveBookTripBlockAction(null, form({ ...draft, destination: 'Goa' }))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['tripStart', 'tripEnd'] });
  });

  it('a malformed post is refused before any database call', async () => {
    await expect(book.saveBookTripBlockAction(null, form({ dealId: DEAL, versionId: VERSION }))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['rowVersion'] });
    await expect(book.saveBookTravellersAction(null, form({ ...draft, travellerName: [''], travellerType: ['adult'] }))).resolves.toMatchObject({ ok: false, fields: ['travellerName[0]'] });
    expect(rpc).not.toHaveBeenCalled();
  });
});
