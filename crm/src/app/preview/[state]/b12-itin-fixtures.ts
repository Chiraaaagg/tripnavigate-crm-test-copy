import type { ItineraryDocumentView } from '@/modules/documents/contracts';
import { PREFILL_FIELD_LABEL, PREFILL_MARK_STATE_TEXT, type PrefillFieldCode, type PrefillMarkState, type PrefillView } from '@/modules/fulfilment/contracts';
import { EMPTY_ITINERARY_FACTS, ITINERARY_TEXT, RENDER_JOB_STATUS_TEXT, type ItineraryEditorView, type ItineraryFacts, type ItineraryListView } from '@/modules/itineraries/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY: synthetic itinerary editor views, a
 * customer itinerary view and Bitrix prefill views (B1.2 Phase F). Invented
 * names and 555 numbers; nothing from a real customer.
 */

export const ITIN_DOC_ID = 'id000000-0000-4000-8000-000000000001';
export const QV_ID = 'qv000000-0000-4000-8000-000000000002';

const FACTS: ItineraryFacts = {
  ...EMPTY_ITINERARY_FACTS,
  destination: 'Ubud and Seminyak, Bali',
  startDate: '2026-11-14',
  endDate: '2026-11-20',
  party: { adults: 2, children: 1, childAges: [9], infants: 0 },
  stays: [
    { city: 'Ubud', nights: 3, checkIn: '2026-11-14', checkOut: '2026-11-17', hotelName: 'Sample Jungle Retreat', roomType: 'Deluxe pool villa', mealPlan: 'Breakfast', rooms: 1 },
    { city: 'Seminyak', nights: 3, checkIn: '2026-11-17', checkOut: '2026-11-20', hotelName: 'Sample Beach Cottage', roomType: 'Ocean room', mealPlan: 'Breakfast', rooms: 1 },
  ],
  days: [
    { n: 1, date: '2026-11-14', base: 'Ubud', title: 'Arrive in Bali', story: 'Private transfer to Ubud; evening at leisure.', highlights: ['Welcome drink'], meals: null },
    { n: 2, date: '2026-11-15', base: 'Ubud', title: 'Rice terraces and temples', story: 'A gentle day with the driver at your pace.', highlights: [], meals: 'Breakfast' },
  ],
  transfers: [{ date: '2026-11-14', from: 'Bali airport', to: 'Sample Jungle Retreat', mode: 'Private car' }],
  activities: [{ date: '2026-11-18', city: 'Seminyak', name: 'Snorkelling trip to Nusa Penida', included: true }],
  flights: [],
  inclusions: ['Daily breakfast', 'Private car with driver for sightseeing'],
  exclusions: ['Flights', 'Travel insurance'],
  coverWord: 'Bali',
  country: 'Indonesia',
  category: 'Family',
  roomBasis: '2 adults and 1 child sharing',
  introduction: 'A calm family week between the rice fields and the sea.',
  reasons: ['Short drives between stays', 'One free day in each place'],
  handledByUs: ['Every transfer'],
  youBring: ['Passports valid for six months'],
  provenance: { destination: 'quotation', startDate: 'quotation', endDate: 'quotation', 'stays[0].hotelName': 'quotation', 'stays[0].nights': 'quotation' },
};

export function itineraryEditor(over: Partial<ItineraryEditorView> = {}): ItineraryEditorView {
  return {
    documentId: ITIN_DOC_ID,
    title: 'Bali for the Shah family',
    subject: { kind: 'quotation', quotationId: 'q0000000-0000-4000-8000-000000000007', dealId: null },
    draftId: 'dr000000-0000-4000-8000-000000000001',
    status: 'draft',
    rowVersion: 7,
    facts: FACTS,
    factsHash: 'f'.repeat(64),
    sourceFileId: 'sf000000-0000-4000-8000-000000000001',
    updatedAt: '2026-10-12T09:00:00.000Z',
    basis: { kind: 'quotation_version', id: QV_ID, hash: 'b'.repeat(64), label: 'Compared with quotation TQ-7 version 2' },
    differences: { runId: null, current: false, openCount: 0, items: [] },
    sources: [{ fileId: 'sf000000-0000-4000-8000-000000000001', fileName: 'sample-old-itinerary.pdf', mime: 'application/pdf', sizeLabel: '180 KB', status: 'stored', uploadedAt: '2026-10-12T08:40:00.000Z', downloadHref: '/preview/b12-itin-not-checked' }],
    jobs: [],
    rendered: [],
    canEditFacts: true,
    canCheckDifferences: true,
    canMarkReady: false,
    canRequestPreview: true,
    canRequestFinal: false,
    canAddSource: true,
    nextStepText: ITINERARY_TEXT.nextCheck,
    ...over,
  };
}

export const ITIN_SCREENS = {
  notChecked: () => itineraryEditor(),
  open: () =>
    itineraryEditor({
      differences: {
        runId: 'run-1',
        current: true,
        openCount: 2,
        items: [
          { differenceId: 'df000000-0000-4000-8000-000000000001', path: 'stays[1].hotelName', kind: 'different', label: 'Stay 2 · hotel', acknowledged: false, acknowledgedByName: null, acknowledgedAt: null, note: null },
          { differenceId: 'df000000-0000-4000-8000-000000000002', path: 'activities[0]', kind: 'missing', label: 'Activity 1', acknowledged: false, acknowledgedByName: null, acknowledgedAt: null, note: null },
          { differenceId: 'df000000-0000-4000-8000-000000000003', path: 'transfers[0].mode', kind: 'different', label: 'Transfer 1 · how', acknowledged: true, acknowledgedByName: 'Synthetic Sales Jodhpur', acknowledgedAt: '2026-10-12T09:10:00.000Z', note: 'Customer asked for a van.' },
        ],
      },
      nextStepText: ITINERARY_TEXT.nextSettle,
    }),
  ready: () =>
    itineraryEditor({
      status: 'ready',
      differences: { runId: 'run-2', current: true, openCount: 0, items: [] },
      canMarkReady: false,
      canRequestFinal: true,
      pricesIncluded: true,
      jobs: [{ jobId: 'jb000000-0000-4000-8000-000000000001', kind: 'preview', status: 'queued', attempts: 0, statusText: RENDER_JOB_STATUS_TEXT.queued, errorText: null, createdAt: '2026-10-12T09:20:00.000Z', finishedAt: null }],
      nextStepText: ITINERARY_TEXT.nextFinal,
    }),
};

export function itineraryList(over: Partial<ItineraryListView> = {}): ItineraryListView {
  return {
    subjectKind: 'quotation',
    subjectId: 'q0000000-0000-4000-8000-000000000007',
    canCreate: true,
    documents: [{ documentId: ITIN_DOC_ID, title: 'Bali for the Shah family', subjectKind: 'quotation', draftStatus: 'draft', createdAt: '2026-10-12T08:30:00.000Z', latestFinal: null }],
    ...over,
  };
}

export function itineraryDocumentView(over: Partial<ItineraryDocumentView> = {}): ItineraryDocumentView {
  return {
    kind: 'itinerary',
    reference: 'IT-3',
    generatedOn: '2026-10-12',
    destination: 'Ubud and Seminyak, Bali',
    destinationShort: 'Bali',
    country: 'Indonesia',
    category: 'Family',
    paxBasis: '2 adults and 1 child',
    facts: {
      draftId: 'dr000000-0000-4000-8000-000000000001',
      sourceFileId: null,
      destination: 'Ubud and Seminyak, Bali',
      startDate: '2026-11-14',
      endDate: '2026-11-20',
      party: { adults: 2, children: 1, childAges: [9], infants: 0 },
      stays: [
        { city: 'Ubud', nights: 3, checkIn: '2026-11-14', checkOut: '2026-11-17', hotelName: 'Sample Jungle Retreat', roomType: 'Deluxe pool villa', mealPlan: 'Breakfast', rooms: 1 },
        { city: 'Seminyak', nights: 3, checkIn: '2026-11-17', checkOut: '2026-11-20', hotelName: 'Sample Beach House', roomType: 'Ocean room', mealPlan: 'Breakfast', rooms: 1 },
      ],
      days: [
        { n: 1, date: '2026-11-14', base: 'Ubud', title: 'Arrive in Bali', story: 'Private transfer to Ubud; evening at leisure.', highlights: ['Welcome drink'], meals: null },
        { n: 2, date: '2026-11-15', base: 'Ubud', title: 'Rice terraces and temples', story: 'A gentle day with the driver at your pace.', highlights: [], meals: 'Breakfast' },
        { n: 3, date: '2026-11-16', base: 'Ubud', title: 'Free day', story: 'Spa, cooking class or simply the pool.', highlights: [], meals: 'Breakfast' },
        { n: 4, date: '2026-11-17', base: 'Seminyak', title: 'To the coast', story: 'Drive to Seminyak; sunset on the beach.', highlights: [], meals: 'Breakfast' },
        { n: 5, date: '2026-11-18', base: 'Seminyak', title: 'Nusa Penida', story: 'Snorkelling trip with lunch on the boat.', highlights: ['Manta point'], meals: 'Breakfast, lunch' },
        { n: 6, date: '2026-11-19', base: 'Seminyak', title: 'Beach day', story: 'Time for shopping and the beach clubs.', highlights: [], meals: 'Breakfast' },
        { n: 7, date: '2026-11-20', base: 'Seminyak', title: 'Fly home', story: 'Transfer to the airport.', highlights: [], meals: 'Breakfast' },
      ],
      transfers: [{ date: '2026-11-14', from: 'Bali airport', to: 'Sample Jungle Retreat', mode: 'Private car' }],
      activities: [{ date: '2026-11-18', city: 'Seminyak', name: 'Snorkelling trip to Nusa Penida', included: true }],
      flights: [],
      inclusions: ['Daily breakfast', 'Private car with driver for sightseeing'],
      exclusions: ['Flights', 'Travel insurance'],
      provenance: {},
    } as ItineraryDocumentView['facts'],
    narrative: { intro: ['A calm family week between the rice fields and the sea.'], reasons: null, weHandle: ['Every transfer', 'Hotel check-ins'], youBring: null },
    // DEC-48: the selling prices of the accepted quotation (customer money only).
    prices: [
      { tierKey: 'quoted', label: 'Deluxe villas', quotedTotalPaise: '20430000', payingTravellers: 3, perPersonPaise: '6810000', breakdownHasAmounts: false, breakdown: [], hotels: null, plan: [] },
    ],
    // DEC-50: Jodhpur, the branch whose GSTIN is given (no identity placeholder).
    branchCode: 'JDH',
    ...over,
  };
}

/** Bitrix prefill as booking_form_get / quotation_get give it. */
export function prefillView(over: Partial<PrefillView> = {}, states: Partial<Record<PrefillFieldCode, PrefillMarkState>> = {}): PrefillView {
  const values: Record<PrefillFieldCode, string | null> = {
    'trip.start': '2026-11-14',
    'trip.end': '2026-11-20',
    requirementsNote: 'Quiet villa in Ubud, beach in Seminyak.',
    'contacts.contactName': 'Sample Customer Shah',
    'contacts.mobile': '9876500041',
    'contacts.email': null,
    'contacts.companyName': null,
    'contacts.bookingFor': 'business',
  };
  return {
    available: true,
    sourceModifiedAt: '2026-10-11T12:00:00.000Z',
    lastVerifiedAt: '2026-10-12T06:00:00.000Z',
    issues: [],
    bookingNotes: 'Quiet villa in Ubud, beach in Seminyak.',
    notesHidden: false,
    travellerTotal: 3,
    customerType: 'b2d',
    customerTypeLabel: 'B2D',
    fields: (Object.keys(values) as PrefillFieldCode[]).map((field) => {
      const state = states[field] ?? null;
      return {
        field,
        label: PREFILL_FIELD_LABEL[field],
        bitrixValue: values[field],
        state,
        stateText: state ? PREFILL_MARK_STATE_TEXT[state] : null,
        canUse: values[field] !== null && state === null,
        canMarkChecked: state === 'from_bitrix',
      };
    }),
    unchecked: (Object.entries(states) as Array<[PrefillFieldCode, PrefillMarkState]>).filter(([, s]) => s === 'from_bitrix').map(([f]) => f),
    ...over,
  };
}
