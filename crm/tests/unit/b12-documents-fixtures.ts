import type { ItineraryDocumentView, QuotationDocumentView, TripFactsSet } from '@/modules/documents/contracts';

/** Synthetic customer views for the documents unit tests (invented names, .test addresses, 555 numbers). */

export function quotationView(o: Partial<QuotationDocumentView> = {}): QuotationDocumentView {
  return {
    kind: 'quotation',
    reference: 'TQ-12',
    versionNo: 2,
    revisionNote: 'Hotel in Dubai changed',
    issueDate: '2026-10-12',
    validUntil: '2026-10-19',
    preparedBy: { name: 'Synthetic Consultant', role: 'Travel consultant', phone: null },
    customer: { name: 'Synthetic Traveller', phone: '+91 55555 01234' },
    trip: { title: 'Dubai and Abu Dhabi', destination: 'UAE', start: '2026-11-20', end: '2026-11-25' },
    pax: { adults: 2, childrenWithBed: 1, childrenNoBed: 1, infants: 0, basis: 'Double sharing' },
    serviceTypes: ['hotel', 'transfer', 'activity', 'flight'],
    stays: [
      { city: 'Dubai', checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2, note: '4 star, Marina' },
      { city: 'Abu Dhabi', checkIn: '2026-11-23', checkOut: '2026-11-25', hotelName: null, roomType: null, mealPlan: 'Breakfast', rooms: 2, note: null },
    ],
    flights: [
      {
        label: 'Outbound',
        date: '2026-11-20',
        legs: [{ carrier: 'Synthetic Air', number: 'SY 101', from: 'BOM', to: 'DXB', dep: null, arr: null }],
        baggage: null,
      },
    ],
    days: [],
    tiers: [
      {
        tierKey: 'quoted',
        label: 'Deluxe · double sharing',
        quotedTotalPaise: '24000000',
        payingTravellers: 4,
        perPersonPaise: '6000000',
        breakdownHasAmounts: true,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Hotels, 5 nights'], amountPaise: '15000000' },
          { categoryKey: 'flights', descriptions: ['Return flights'], amountPaise: '9000000' },
        ],
        hotels: null,
        plan: [
          { seq: 1, label: 'Deposit', amountPaise: '5000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null },
          { seq: 2, label: 'Balance', amountPaise: '19000000', dueRule: 'days_before_start', dueDays: 30, dueDate: null },
        ],
      },
    ],
    includes: ['Desert safari with dinner', 'Daily breakfast'],
    excludes: ['Visa fees'],
    terms: null,
    // DEC-50: Jodhpur, the branch whose GSTIN is given (no identity placeholder).
    branchCode: 'JDH',
    ...o,
  };
}

type FullFacts = TripFactsSet & { inclusions: string[]; exclusions: string[] };

export function factsSet(o: Partial<FullFacts> = {}): FullFacts {
  return {
    destination: 'UAE',
    startDate: '2026-11-20',
    endDate: '2026-11-25',
    party: { adults: 2, children: 2, childAges: [6, 9], infants: 0 },
    stays: [
      { city: 'Dubai', nights: 3, checkIn: '2026-11-20', checkOut: '2026-11-23', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 },
      { city: 'Abu Dhabi', nights: 2, checkIn: '2026-11-23', checkOut: '2026-11-25', hotelName: 'Synthetic Corniche Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 },
    ],
    transfers: [
      { date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' },
      { date: '2026-11-23', from: 'Dubai hotel', to: 'Abu Dhabi hotel', mode: 'Private car' },
    ],
    activities: [{ date: '2026-11-21', city: 'Dubai', name: 'Desert safari', included: true }],
    flights: [{ date: '2026-11-20', from: 'BOM', to: 'DXB', carrier: 'Synthetic Air', number: 'SY 101' }],
    inclusions: ['Daily breakfast', 'Desert safari with dinner'],
    exclusions: ['Visa fees'],
    ...o,
  };
}

export function itineraryView(o: Partial<ItineraryDocumentView> = {}): ItineraryDocumentView {
  return {
    kind: 'itinerary',
    reference: 'IT-7',
    generatedOn: '2026-10-12',
    destination: 'Dubai & Abu Dhabi',
    destinationShort: 'Dubai',
    country: 'UAE',
    category: 'Family',
    paxBasis: 'per person, based on 4 travellers',
    facts: {
      ...factsSet(),
      draftId: 'd1',
      sourceFileId: null,
      days: [],
      provenance: { 'stays[0].hotelName': 'quotation' },
    },
    narrative: { intro: ['A calm family week by the sea.'], reasons: null, weHandle: ['Every transfer'], youBring: null },
    prices: null,
    // DEC-50: Jodhpur, the branch whose GSTIN is given (no identity placeholder).
    branchCode: 'JDH',
    ...o,
  };
}
