import type { QuotationDocumentView } from '@/modules/documents/contracts';
import { EMPTY_QUOTATION_CONTENT, type QuotationItemView, type QuotationLineView, type QuotationTierMoneyView } from '@/modules/quotations/contracts';
import type { QuoteListView, QuoteScreenData, QuoteVersionSummary, QuoteVersionView } from '@/views/b12/quote-shapes';

/*
 * Synthetic fixtures for the B1.2 quotation gallery states (same trip as the
 * clickable prototype, b1.2/prototype). Every name, hotel, reference and
 * amount is made up. Nothing here reaches a database.
 */

const LEAD_ID = 'l0000000-0000-4000-8000-000000000041';
const QUOTE_ID = 'q0000000-0000-4000-8000-000000000007';
export const V1_ID = 'qv000000-0000-4000-8000-000000000001';
export const V2_ID = 'qv000000-0000-4000-8000-000000000002';

const line = (lineNo: number, over: Partial<QuotationLineView> & Pick<QuotationLineView, 'description' | 'unitKind' | 'units' | 'periods' | 'unitSellPaise'>): QuotationLineView => {
  const quantity = over.units * over.periods;
  const unitCost = over.unitCostPaise ?? null;
  return {
    lineNo,
    optionKey: 'common',
    itemId: over.itemNo ? `qi000000-0000-4000-8000-${String(over.itemNo).padStart(12, '0')}` : null,
    itemNo: null,
    chargeKind: 'main',
    categoryKey: 'other',
    quantity,
    unitCostPaise: unitCost,
    lineSellPaise: String(Number(over.unitSellPaise) * quantity),
    lineCostPaise: unitCost === null ? null : String(Number(unitCost) * quantity),
    remark: null,
    ...over,
  };
};

export const LINES: QuotationLineView[] = [
  line(1, { optionKey: 'quoted', itemNo: 1, categoryKey: 'hotels', description: 'Sample Jungle Retreat · Deluxe pool villa', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '2200000', unitCostPaise: '1800000' }),
  line(2, { optionKey: 'quoted', itemNo: 2, categoryKey: 'hotels', description: 'Sample Beach House · Ocean room', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '2450000', unitCostPaise: '2000000' }),
  line(3, { optionKey: 'upgrade', itemNo: 3, categoryKey: 'hotels', description: 'Sample Ridge Sanctuary · Pool suite', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '3450000', unitCostPaise: '2900000' }),
  line(4, { optionKey: 'upgrade', itemNo: 4, categoryKey: 'hotels', description: 'Sample Cliff Palace · Ocean suite', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '3850000', unitCostPaise: '3200000' }),
  line(5, { itemNo: 5, categoryKey: 'transfers', description: 'Private car with driver, one trip per sightseeing day', unitKind: 'trip', units: 1, periods: 5, unitSellPaise: '570000', unitCostPaise: '420000' }),
  line(6, { itemNo: 6, categoryKey: 'tours', description: 'Snorkelling trip to Nusa Penida', unitKind: 'line_total', units: 1, periods: 1, unitSellPaise: '1980000', unitCostPaise: '1420000' }),
  line(7, { itemNo: 7, categoryKey: 'visas', description: 'Indonesia visa on arrival assistance', unitKind: 'line_total', units: 1, periods: 1, unitSellPaise: '1350000', unitCostPaise: '1050000' }),
  line(8, { optionKey: 'quoted', itemNo: 2, chargeKind: 'child_no_bed', categoryKey: 'hotels', description: 'Child without a bed · breakfast', unitKind: 'night', units: 1, periods: 3, unitSellPaise: '100000', unitCostPaise: '80000', remark: 'Hotel charges child breakfast per night' }),
];

const sum = (k: 'lineSellPaise' | 'lineCostPaise', t: 'quoted' | 'upgrade') => {
  const ls = LINES.filter((l) => l.optionKey === 'common' || l.optionKey === t);
  if (k === 'lineCostPaise' && ls.some((l) => l.lineCostPaise === null)) return null;
  return ls.reduce((s, l) => s + Number(l[k] ?? 0), 0);
};

/** As quoted adds up exactly (₹2,04,300); the upgrade total is typed as a rounded offer, so the mismatch warning shows. */
export function tierMoney(quotedTotal: string | null = '20430000', upgradeTotal: string | null = '29900000'): QuotationTierMoneyView[] {
  return (['quoted', 'upgrade'] as const).map((t) => {
    const total = t === 'quoted' ? quotedTotal : upgradeTotal;
    const component = sum('lineSellPaise', t)!;
    const cost = sum('lineCostPaise', t);
    const per = total && Number(total) % 300 === 0 && (Number(total) / 3) % 100 === 0 ? String(Number(total) / 3) : null;
    const plan = t === 'quoted' ? '20430000' : null;
    return {
      tierKey: t,
      label: t === 'quoted' ? 'Deluxe villas' : 'Suites',
      quotedTotalPaise: total,
      payingTravellers: 3,
      showPerPerson: true,
      lineCount: LINES.filter((l) => l.optionKey === 'common' || l.optionKey === t).length,
      componentSellPaise: String(component),
      componentDifferencePaise: total === null ? null : String(Number(total) - component),
      costTotalPaise: cost === null ? null : String(cost),
      costComplete: cost !== null,
      marginPaise: total === null || cost === null ? null : String(Number(total) - cost),
      perPersonPaise: per,
      planTotalPaise: plan,
      planCount: plan ? 2 : 0,
    };
  });
}

const itemId = (n: number) => `qi000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hotel = (itemNo: number, tierKey: 'quoted' | 'upgrade', hotelName: string, city: string, checkIn: string, checkOut: string, roomType: string): QuotationItemView => ({
  itemId: itemId(itemNo),
  itemNo,
  factsValid: true,
  serviceType: 'hotel',
  tierKey,
  title: `Hotel · ${city}`,
  service: { type: 'hotel', facts: { mode: 'specific', hotelName, city, checkIn, checkOut, rooms: 1, roomType, adults: 2, children: 1, childAges: [8], mealPlan: 'Breakfast' } },
});

export function quoteVersion(over: Partial<QuoteVersionView> = {}): QuoteVersionView {
  return {
    quotationId: QUOTE_ID,
    reference: 'TQ-7',
    title: 'Bali for the Shah family',
    subject: { kind: 'lead', leadId: LEAD_ID, dealId: null, reference: 'Lead 4041', title: 'Shah · Bali family trip', branchCode: 'JDH' },
    linkedDealId: null,
    quotationRowVersion: 3,
    versionId: V2_ID,
    versionNo: 2,
    status: 'sent',
    rowVersion: 4,
    contentHash: 'hash-qv2',
    basedOnVersionId: V1_ID,
    trip: { destination: 'Ubud and Seminyak, Bali', scope: 'international', start: '2026-11-14', end: '2026-11-20' },
    pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 1, infants: 0, paxRemarks: null },
    travellerCount: 3,
    requirementsNote: 'Quiet villa in Ubud, beach in Seminyak, one snorkelling day.',
    contact: { contactName: 'Sample Customer Shah', mobile: '9876500041', email: null, companyName: null },
    content: { ...EMPTY_QUOTATION_CONTENT, terms: ['Hotels are held only after confirmation.', 'Visa grant and timing are decided by the consulate.'], includes: ['Daily breakfast', 'Private car with driver for sightseeing', 'Snorkelling trip to Nusa Penida', 'Indonesia visa on arrival assistance'], excludes: ['Flights', 'Travel insurance', 'Lunches and dinners'] },
    tiers: [
      { tierKey: 'quoted', label: 'Deluxe villas' },
      { tierKey: 'upgrade', label: 'Suites' },
    ],
    items: [
      hotel(1, 'quoted', 'Sample Jungle Retreat', 'Ubud', '2026-11-14', '2026-11-17', 'Deluxe pool villa'),
      hotel(2, 'quoted', 'Sample Beach House', 'Seminyak', '2026-11-17', '2026-11-20', 'Ocean room'),
      hotel(3, 'upgrade', 'Sample Ridge Sanctuary', 'Ubud', '2026-11-14', '2026-11-17', 'Pool suite'),
      hotel(4, 'upgrade', 'Sample Cliff Palace', 'Seminyak', '2026-11-17', '2026-11-20', 'Ocean suite'),
      { itemId: itemId(5), factsValid: true, itemNo: 5, serviceType: 'transfer', tierKey: null, title: 'Private car with driver', service: { type: 'transfer', facts: { route: 'Bali airport to Sample Jungle Retreat', pickup: 'Bali airport', drop: 'Sample Jungle Retreat', date: '2026-11-14', vehicleType: '7-seater', passengers: 3 } } },
      { itemId: itemId(6), factsValid: true, itemNo: 6, serviceType: 'activity', tierKey: null, title: 'Snorkelling trip', service: { type: 'activity', facts: { name: 'Snorkelling trip to Nusa Penida', city: 'Seminyak', date: '2026-11-18', participants: 3 } } },
      { itemId: itemId(7), factsValid: true, itemNo: 7, serviceType: 'visa', tierKey: null, title: 'Indonesia visa', service: { type: 'visa', facts: { country: 'Indonesia', purpose: 'Tourism', travelDate: '2026-11-14', feePaidBy: 'customer' } } },
    ],
    validUntil: '2026-10-19',
    sent: { at: '2026-10-12T06:30:00.000Z', channel: 'whatsapp' },
    accepted: null,
    declined: null,
    issues: [],
    evidence: [],
    money: {
      lines: LINES,
      tiers: tierMoney(),
      plan: [
        { tierKey: 'quoted', seq: 1, label: 'Advance', amountPaise: '7000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null },
        { tierKey: 'quoted', seq: 2, label: 'Balance', amountPaise: '13430000', dueRule: 'days_before_start', dueDays: 15, dueDate: null },
      ],
      issues: ['component_mismatch'],
      costRefreshAllowed: true,
    },
    conversion: null,
    canEdit: true,
    canEditMoney: false,
    canMarkReady: false,
    canSend: false,
    canUploadEvidence: true,
    canAccept: true,
    canDecline: true,
    canNewVersion: true,
    canDiscard: false,
    canLinkDeal: false,
    canConvert: false,
    nextStepText: null,
    ...over,
  };
}

function versions(current: QuoteVersionView): QuoteVersionSummary[] {
  return [
    { versionId: current.versionId, versionNo: current.versionNo, status: current.status, validUntil: current.validUntil, sentAt: current.sent?.at ?? null, acceptedTierKey: current.accepted?.tierKey ?? null },
    { versionId: V1_ID, versionNo: 1, status: 'superseded', validUntil: '2026-10-18', sentAt: '2026-10-11T06:35:00.000Z', acceptedTierKey: null },
  ];
}

export function screenData(over: Partial<QuoteVersionView> = {}, candidates: QuoteScreenData['candidates'] = null): QuoteScreenData {
  const version = quoteVersion(over);
  return { version, versions: versions(version), candidates, ownerName: 'Synthetic Sales Jodhpur', linkedDeal: version.linkedDealId ? { reference: ARRIVED_DEAL.reference, title: ARRIVED_DEAL.title } : null };
}

const ACCEPTED: Partial<QuoteVersionView> = {
  status: 'accepted',
  accepted: { at: '2026-10-13T09:10:00.000Z', tierKey: 'quoted' },
  evidence: [{ evidenceId: 'qe000000-0000-4000-8000-000000000001', kind: 'acceptance_message', fileName: 'sample-written-acceptance-v2.png', mime: 'image/png', sizeLabel: '210 KB', status: 'stored', uploadedByYou: true, uploadedAt: '2026-10-13T09:08:00.000Z', storedAt: '2026-10-13T09:08:02.000Z', downloadHref: '/preview/b12-quote-accepted-waiting' }],
  canUploadEvidence: false,
  canAccept: false,
  canDecline: false,
  canNewVersion: false,
};

export const ARRIVED_DEAL = { dealId: 'd0000000-0000-4000-8000-000000000047', reference: 'SYN-JOD-047', title: 'Shah · Bali family trip', branchName: 'Jodhpur', sameBranch: true, active: true, linkable: true };
const LINKED = ARRIVED_DEAL.dealId;

/** Batch 2: a new draft nobody has typed into yet (QU-02 "Not started"); money present for a price reader. */
function untouched(over: Partial<QuoteVersionView> = {}): QuoteScreenData {
  const d = screenData({
    status: 'draft',
    versionId: 'qv000000-0000-4000-8000-000000000009',
    versionNo: 1,
    basedOnVersionId: null,
    contentHash: null,
    sent: null,
    validUntil: null,
    trip: { destination: null, scope: null, start: null, end: null },
    pax: { adults: 0, childrenWithBed: 0, childrenNoBed: 0, infants: 0, paxRemarks: null },
    travellerCount: 0,
    requirementsNote: null,
    contact: null,
    content: { ...EMPTY_QUOTATION_CONTENT },
    tiers: [],
    items: [],
    issues: ['trip_missing', 'pax_missing', 'no_items', 'contact_missing', 'tier_missing'],
    money: { lines: [], tiers: [], plan: [], issues: ['lines_missing', 'quoted_total_missing', 'traveller_count_missing'], costRefreshAllowed: false },
    canEditMoney: true,
    canMarkReady: true,
    canUploadEvidence: false,
    canAccept: false,
    canDecline: false,
    canNewVersion: false,
    canDiscard: true,
    ...over,
  });
  d.versions = [{ versionId: d.version.versionId, versionNo: 1, status: 'draft', validUntil: null, sentAt: null, acceptedTierKey: null }];
  return d;
}

export const QUOTE_SCREENS = {
  untouched,
  sent: () => screenData(),
  expired: () => screenData({ status: 'expired', validUntil: '2026-10-08', canAccept: false }),
  declined: () => screenData({ status: 'declined', declined: { at: '2026-10-14T10:00:00.000Z', reason: 'price' }, canAccept: false, canDecline: false }),
  mismatch: () => screenData({ money: { ...quoteVersion().money!, tiers: tierMoney('20500000', '29900000') } }),
  noMoney: () => {
    const d = screenData();
    delete d.version.money;
    return d;
  },
  draft: () =>
    screenData({
      status: 'draft',
      versionId: 'qv000000-0000-4000-8000-000000000003',
      versionNo: 3,
      basedOnVersionId: V2_ID,
      contentHash: null,
      sent: null,
      validUntil: null,
      contact: null,
      issues: ['contact_missing'],
      money: { ...quoteVersion().money!, tiers: tierMoney('20430000', null), issues: ['upgrade_total_missing', 'component_mismatch'], plan: [] },
      canEditMoney: true,
      canMarkReady: true,
      canUploadEvidence: false,
      canAccept: false,
      canDecline: false,
      canNewVersion: false,
      canDiscard: true,
    }),
  ready: () =>
    screenData({
      status: 'ready',
      versionId: 'qv000000-0000-4000-8000-000000000003',
      versionNo: 3,
      basedOnVersionId: V2_ID,
      contentHash: 'b'.repeat(64),
      sent: null,
      validUntil: '2026-10-20',
      canEditMoney: true,
      canSend: true,
      canUploadEvidence: false,
      canAccept: false,
      canDecline: false,
      canNewVersion: false,
      canDiscard: true,
    }),
  acceptedWaiting: () => screenData(ACCEPTED, []),
  acceptedCandidate: () => screenData({ ...ACCEPTED, canLinkDeal: true }, [ARRIVED_DEAL]),
  acceptedReady: () => screenData({ ...ACCEPTED, linkedDealId: LINKED, canConvert: true }, []),
  converted: () => screenData({ ...ACCEPTED, linkedDealId: LINKED, canConvert: true, conversion: { dealId: ARRIVED_DEAL.dealId, bookingVersionId: 'bv1', convertedAt: '2026-10-14T05:00:00.000Z' } }, []),
};

export function quoteList(over: Partial<QuoteListView> = {}): QuoteListView {
  const v = quoteVersion();
  return {
    subjectKind: 'lead',
    subjectId: LEAD_ID,
    canCreate: true,
    quotations: [{ quotationId: QUOTE_ID, rowVersion: 3, reference: 'TQ-7', title: v.title, subjectKind: 'lead', leadId: LEAD_ID, dealId: null, linkedDealId: null, acceptedVersionId: null, converted: false, bookingVersionId: null, createdAt: '2026-10-11T05:50:00.000Z', versions: versions(v), currentVersionId: V2_ID }],
    ...over,
  };
}

/** The customer view of version 2 (what quotation_get + quotation_customer_money give the preview and the PDF). */
export function quoteDocumentView(over: Partial<QuotationDocumentView> = {}): QuotationDocumentView {
  return {
    kind: 'quotation',
    reference: 'TQ-7',
    versionNo: 2,
    revisionNote: 'Suites added as an upgrade option',
    issueDate: '2026-10-12',
    validUntil: '2026-10-19',
    preparedBy: { name: 'Synthetic Sales Jodhpur', role: 'Travel consultant', phone: '+91 55555 00010' },
    customer: { name: 'Sample Customer Shah', phone: '+91 55555 00041' },
    trip: { title: 'Bali for the Shah family', destination: 'Ubud and Seminyak, Bali', start: '2026-11-14', end: '2026-11-20' },
    pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 1, infants: 0, basis: 'Family room sharing' },
    serviceTypes: ['hotel', 'transfer', 'activity', 'visa'],
    stays: [
      { city: 'Ubud', checkIn: '2026-11-14', checkOut: '2026-11-17', hotelName: 'Sample Jungle Retreat', roomType: 'Deluxe pool villa', mealPlan: 'Breakfast', rooms: 1, note: '4 star, rice-field view' },
      { city: 'Seminyak', checkIn: '2026-11-17', checkOut: '2026-11-20', hotelName: 'Sample Beach House', roomType: null, mealPlan: 'Breakfast', rooms: 1, note: '4 star, near the beach' },
    ],
    flights: [],
    days: [
      { day: 1, city: 'Ubud', title: 'Arrive in Bali', text: 'Private transfer to Ubud; evening at leisure.' },
      { day: 2, city: 'Ubud', title: 'Rice terraces and temples', text: 'A gentle day with the driver at your pace.' },
      { day: 3, city: 'Ubud', title: 'Free day', text: 'Spa, cooking class or simply the pool.' },
      { day: 4, city: 'Seminyak', title: 'To the coast', text: 'Drive to Seminyak; sunset on the beach.' },
      { day: 5, city: 'Seminyak', title: 'Nusa Penida', text: 'Snorkelling trip with lunch on the boat.' },
      { day: 6, city: 'Seminyak', title: 'Beach day', text: 'Time for shopping and the beach clubs.' },
      { day: 7, city: 'Seminyak', title: 'Fly home', text: 'Transfer to the airport.' },
    ],
    tiers: [
      {
        tierKey: 'quoted',
        label: 'Deluxe villas',
        quotedTotalPaise: '20430000',
        payingTravellers: 3,
        perPersonPaise: '6810000',
        breakdownHasAmounts: false,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Hotels, 6 nights'], amountPaise: null },
          { categoryKey: 'transfers', descriptions: ['Private car with driver'], amountPaise: null },
          { categoryKey: 'tours', descriptions: ['Snorkelling trip to Nusa Penida'], amountPaise: null },
        ],
        hotels: null,
        plan: [
          { seq: 1, label: 'Advance', amountPaise: '7000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null },
          { seq: 2, label: 'Balance', amountPaise: '13430000', dueRule: 'days_before_start', dueDays: 15, dueDate: null },
        ],
      },
      {
        tierKey: 'upgrade',
        label: 'Suites',
        quotedTotalPaise: '29900000',
        payingTravellers: 3,
        perPersonPaise: null,
        breakdownHasAmounts: false,
        breakdown: [{ categoryKey: 'hotels', descriptions: ['Suites, 6 nights'], amountPaise: null }],
        hotels: ['Sample Ridge Sanctuary, Ubud', 'Sample Cliff Palace, Seminyak'],
        plan: [],
      },
    ],
    includes: ['Daily breakfast', 'Private car with driver for sightseeing', 'Snorkelling trip to Nusa Penida'],
    excludes: ['Flights', 'Travel insurance'],
    terms: ['Hotels are held only after confirmation.', 'Visa grant and timing are decided by the consulate.'],
    // DEC-50: Jodhpur, the branch whose GSTIN is given (no identity placeholder).
    branchCode: 'JDH',
    ...over,
  };
}
