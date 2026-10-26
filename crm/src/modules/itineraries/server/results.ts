import 'server-only';
import { ITINERARY_ERROR_TEXT, type ItineraryActionResult, type ItineraryErrorCode } from '../contracts';
import { ItineraryCommandError, readinessFromHint } from '../commands';
import { IFIELD } from '../forms';

// G-05
export const UNKNOWN_ITINERARY_OUTCOME = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

export function ifail(code: ItineraryErrorCode | 'session' | 'upload_failed', fields?: string[], message?: string): ItineraryActionResult<never> {
  return { ok: false, code, message: message ?? ITINERARY_ERROR_TEXT[code], ...(fields && fields.length > 0 ? { fields: [...new Set(fields)] } : {}) };
}

/** Fact path hint ("stays[2].nights") → form input ("stayNights[1]"); database lists are 1-based or keyed, forms 0-based. */
const LIST_FIELD: Record<string, Record<string, string>> = {
  stays: { city: IFIELD.stayCity, nights: IFIELD.stayNights, checkIn: IFIELD.stayCheckIn, checkOut: IFIELD.stayCheckOut, hotelName: IFIELD.stayHotelName, roomType: IFIELD.stayRoomType, mealPlan: IFIELD.stayMealPlan, rooms: IFIELD.stayRooms, '': IFIELD.stayCity },
  days: { date: IFIELD.dayDate, base: IFIELD.dayBase, title: IFIELD.dayTitle, story: IFIELD.dayStory, highlights: IFIELD.dayHighlights, meals: IFIELD.dayMeals, n: IFIELD.dayTitle, '': IFIELD.dayTitle },
  transfers: { date: IFIELD.transferDate, from: IFIELD.transferFrom, to: IFIELD.transferTo, mode: IFIELD.transferMode, '': IFIELD.transferFrom },
  activities: { date: IFIELD.activityDate, city: IFIELD.activityCity, name: IFIELD.activityName, included: IFIELD.activityIncluded, '': IFIELD.activityName },
  flights: { date: IFIELD.flightDate, from: IFIELD.flightFrom, to: IFIELD.flightTo, carrier: IFIELD.flightCarrier, number: IFIELD.flightNumber, '': IFIELD.flightFrom },
  inclusions: { '': IFIELD.inclusion },
  exclusions: { '': IFIELD.exclusion },
  reasons: { '': IFIELD.reason },
  handledByUs: { '': IFIELD.handledByUs },
  youBring: { '': IFIELD.youBring },
};
const SINGLE_FIELD: Record<string, string> = {
  destination: IFIELD.destination,
  startDate: IFIELD.startDate,
  endDate: IFIELD.endDate,
  'party.adults': IFIELD.adults,
  'party.children': IFIELD.children,
  'party.childAges': IFIELD.childAges,
  'party.infants': IFIELD.infants,
  party: IFIELD.adults,
  coverWord: IFIELD.coverWord,
  country: IFIELD.country,
  category: IFIELD.category,
  roomBasis: IFIELD.roomBasis,
  introduction: IFIELD.introduction,
  provenance: IFIELD.provenance,
  sourceFileId: IFIELD.sourceFileId,
  title: IFIELD.title,
  requestId: IFIELD.requestId,
  subjectKind: IFIELD.subjectKind,
};

export function factFields(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const m = /^([A-Za-z]+)\[(\d+)\](?:\.([A-Za-z]+))?/.exec(key);
    if (m && LIST_FIELD[m[1]!]) {
      const field = LIST_FIELD[m[1]!]![m[3] ?? ''] ?? LIST_FIELD[m[1]!]!['']!;
      out.push(`${field}[${Math.max(0, Number(m[2]) - 1)}]`);
      continue;
    }
    const base = key.replace(/\[.*$/, '');
    out.push(SINGLE_FIELD[key] ?? SINGLE_FIELD[base] ?? LIST_FIELD[base]?.[''] ?? base);
  }
  return [...new Set(out)];
}

export function ifailFrom(error: unknown): ItineraryActionResult<never> {
  if (error instanceof ItineraryCommandError && error.code) {
    if (error.code === 'not_ready') {
      const issues = readinessFromHint(error.hintKeys);
      return { ok: false, code: 'not_ready', message: ITINERARY_ERROR_TEXT.not_ready, ...(issues.length > 0 ? { issues } : {}) };
    }
    return ifail(error.code, error.code === 'invalid_input' ? factFields(error.hintKeys) : undefined);
  }
  throw new Error(UNKNOWN_ITINERARY_OUTCOME);
}
