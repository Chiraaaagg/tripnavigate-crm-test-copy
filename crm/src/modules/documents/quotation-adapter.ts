import 'server-only';
import {
  GST_TEXT,
  NOT_TAX_INVOICE_TEXT,
  type AdapterRefusal,
  type AdapterResult,
  type QuotationDocumentView,
  type QuotationTierView,
  type QuoteCategoryKey,
  type QuoteDocumentInput,
} from './contracts';
import { documentIdentity } from './company-identity';
import { forbiddenKeyPaths } from './guard';
import { exactPerPersonRupees, paiseToRupees, rupeesInWords } from './money';
import { scanStrings } from './safety';
import { PlaceholderCollector, cleanList, daysBetween, neutraliseLeadingBracket, shortDate } from './text';

/**
 * Customer quotation view -> engine-shaped quotation input (Nova Phase A
 * section 5; freeze part 2 sections 3 and 5; DEC-34).
 *
 * Refuses (never guesses): a commercial/internal key in the view, an amount
 * with paise, a missing quoted tier, stay dates that do not give whole nights,
 * stay nights that disagree with the trip dates, and any customer text with internal-rate, sales-pressure, old
 * template, raw GDS or CRM words. Unknown values become visible placeholders;
 * the caller blocks sending while any placeholder remains.
 */

const CATEGORY_LABEL: Record<QuoteCategoryKey, string> = {
  flights: 'Flights',
  hotels: 'Hotels',
  transfers: 'Transfers',
  tours: 'Tours & tickets',
  visas: 'Visas',
  insurance: 'Insurance',
  other: 'Other services',
};

const TIER_NAME = { quoted: 'As quoted', upgrade: 'Upgrade' } as const;

/** Distinct day numbers of the plan that fall inside the trip (1..tripDays). */
function coveredDays(plan: QuotationDocumentView['days'], tripDays: number): number {
  return new Set(plan.map((d) => d.day).filter((n) => n >= 1 && n <= tripDays)).size;
}

/** Fixed staff-facing wording for the quotation preview status (Luna shows it; never printed on the document). */
export const QUOTATION_PREVIEW_TEXT = {
  // QP-08
  dayPlanNone: 'No day plan yet (optional; the itinerary has the full plan).',
  dayPlanPartial: 'Day plan covers {covered} of {days} days. Fine for a summary; the itinerary carries the full plan.',
} as const;

/**
 * The preview status line about the day plan, or null when it covers every
 * day. Uses the adapted input (trip days) and the view (the plan as typed).
 */
export function quotationDayPlanNotice(view: QuotationDocumentView, input: QuoteDocumentInput): string | null {
  if (!view.days.length) return QUOTATION_PREVIEW_TEXT.dayPlanNone;
  const covered = coveredDays(view.days, input.trip.days);
  if (covered >= input.trip.days) return null;
  return QUOTATION_PREVIEW_TEXT.dayPlanPartial.replace('{covered}', String(covered)).replace('{days}', String(input.trip.days));
}

export function quotationToEngineQuote(view: QuotationDocumentView): AdapterResult<QuoteDocumentInput> {
  const forbidden = forbiddenKeyPaths(view);
  if (forbidden.length) return { ok: false, refusals: forbidden.map((path) => ({ code: 'forbidden_field', path })) };

  const refusals: AdapterRefusal[] = [];
  const notes: string[] = [];
  const ph = new PlaceholderCollector();

  const rupees = (paise: string, path: string): number | null => {
    const r = paiseToRupees(paise);
    if (r.ok) return r.rupees;
    refusals.push({ code: r.code, path });
    return null;
  };

  // --- tiers (quoted first) ------------------------------------------------
  const quoted = view.tiers.find((t) => t.tierKey === 'quoted');
  if (!quoted) refusals.push({ code: 'tier_missing', path: 'tiers' });
  const ordered: QuotationTierView[] = [
    ...view.tiers.filter((t) => t.tierKey === 'quoted'),
    ...view.tiers.filter((t) => t.tierKey === 'upgrade'),
  ];
  if (ordered.length === 1) notes.push('single_tier');

  // --- stays and nights ----------------------------------------------------
  const stayNights = view.stays.map((s, i) => {
    const n = daysBetween(s.checkIn, s.checkOut);
    if (n === null || n < 1) {
      refusals.push({ code: 'dates_invalid', path: `stays[${i}]` });
      return 0;
    }
    return n;
  });
  const tripNights = daysBetween(view.trip.start, view.trip.end);
  const sumNights = stayNights.reduce((a, b) => a + b, 0);
  if (view.stays.length && tripNights !== null && sumNights !== tripNights) {
    refusals.push({ code: 'nights_mismatch', path: 'stays' });
  }
  const nights = view.stays.length ? sumNights : (tripNights ?? 0);
  const days = nights + 1;
  // A quotation's day-by-day plan is optional and may be a summary: a different
  // length is a note (see quotationDayPlanNotice), never a refusal.

  if (refusals.length) return { ok: false, refusals };

  const stay = view.stays.map((s, i) => ({
    city: neutraliseLeadingBracket(s.city),
    in: shortDate(s.checkIn) ?? ph.mark('Check-in date'),
    out: shortDate(s.checkOut) ?? ph.mark('Check-out date'),
    nights: stayNights[i]!,
    hotel: ph.text(s.hotelName, 'Hotel name'),
    room: ph.text(s.roomType, 'Room type'),
    plan: ph.text(s.mealPlan, 'Meal plan'),
    rooms: ph.number(s.rooms, 'Number of rooms'),
    note: ph.text(s.note, 'Hotel rating and area'),
  }));
  const cities = [...new Set(stay.map((s) => s.city))];

  // The plan as typed (day numbers kept); an empty title or text is a placeholder, a missing city is simply not printed.
  const dayRows: QuoteDocumentInput['days'] = [...view.days]
    .sort((a, b) => a.day - b.day)
    .map((d) => ({
      n: d.day,
      city: d.city && d.city.trim() !== '' ? neutraliseLeadingBracket(d.city) : null,
      t: ph.text(d.title, 'Day title'),
      d: ph.text(d.text, 'Day plan'),
    }));
  if (!view.days.length) notes.push('day_plan_missing');
  else if (coveredDays(view.days, days) < days) notes.push('day_plan_partial');

  const flights = view.flights.map((g) => ({
    label: neutraliseLeadingBracket(g.label),
    date: shortDate(g.date) ?? g.date,
    legs: g.legs.map((l) => ({
      carrier: ph.text(l.carrier, 'Airline'),
      no: ph.text(l.number, 'Flight number'),
      from: neutraliseLeadingBracket(l.from),
      to: neutraliseLeadingBracket(l.to),
      dep: ph.text(l.dep, 'Departure time'),
      arr: ph.text(l.arr, 'Arrival time'),
    })),
    baggage: ph.text(g.baggage, 'Baggage allowance'),
  }));

  // --- money ---------------------------------------------------------------
  const tierRows: QuoteDocumentInput['tiers'] = [];
  const tierTotals = new Map<string, { total: number; perPerson: number | null }>();
  ordered.forEach((t, i) => {
    const total = rupees(t.quotedTotalPaise, `tiers[${i}].quotedTotalPaise`);
    if (total === null) return;
    let perPerson: number | null = null;
    if (t.perPersonPaise !== null) {
      const given = rupees(t.perPersonPaise, `tiers[${i}].perPersonPaise`);
      // Mercury prints a per-person price only when exact; refuse anything else.
      if (given !== null && given !== exactPerPersonRupees(total, t.payingTravellers)) {
        refusals.push({ code: 'amount_invalid', path: `tiers[${i}].perPersonPaise` });
      }
      perPerson = given;
    }
    tierTotals.set(t.tierKey, { total, perPerson });
    const hotels = (t.hotels ?? view.stays.map((s) => s.hotelName)).map((h) => ph.text(h, 'Hotel name'));
    tierRows.push({ name: TIER_NAME[t.tierKey], label: ph.text(t.label, 'Option description'), quoted: t.tierKey === 'quoted', hotels, perPerson, total });
  });

  const q = quoted!;
  const categories = q.breakdown.map((b, i) => {
    let amt: number | null = null;
    if (q.breakdownHasAmounts && b.amountPaise !== null) amt = rupees(b.amountPaise, `tiers.quoted.breakdown[${i}].amountPaise`);
    return { k: CATEGORY_LABEL[b.categoryKey], note: cleanList(b.descriptions).join(', '), amt };
  });
  const payment = q.plan.map((p, i) => {
    const amt = rupees(p.amountPaise, `tiers.quoted.plan[${i}].amountPaise`) ?? 0;
    const when =
      p.dueRule === 'on_acceptance'
        ? 'On acceptance'
        : p.dueRule === 'days_before_start'
          ? p.dueDays !== null
            ? `${p.dueDays} days before departure`
            : ph.mark('Due date')
          : (shortDate(p.dueDate) ?? ph.mark('Due date'));
    return { k: neutraliseLeadingBracket(p.label), amt, when };
  });
  if (refusals.length) return { ok: false, refusals };

  const main = tierTotals.get('quoted')!;
  if (main.perPerson === null) notes.push('per_person_not_printed');
  const paxCount = view.pax.adults + view.pax.childrenWithBed + view.pax.childrenNoBed;
  if (paxCount !== q.payingTravellers) notes.push('pax_count_differs');

  const has = (k: QuotationDocumentView['serviceTypes'][number]) => view.serviceTypes.includes(k);
  const input: QuoteDocumentInput = {
    quoteNo: view.reference,
    revision: view.versionNo,
    revisionNote: view.versionNo > 1 && view.revisionNote ? neutraliseLeadingBracket(view.revisionNote) : null,
    date: view.issueDate,
    validUntil: view.validUntil ?? ph.mark('Valid until'),
    preparedBy: { name: view.preparedBy.name, role: view.preparedBy.role, phone: ph.text(view.preparedBy.phone, 'Consultant phone') },
    customer: { name: ph.text(view.customer.name, 'Customer name'), phone: ph.text(view.customer.phone, 'Customer phone') },
    trip: {
      title: ph.text(view.trip.title ?? view.trip.destination, 'Trip title'),
      nights,
      days,
      cities,
      start: shortDate(view.trip.start) ?? ph.mark('Start date'),
      end: shortDate(view.trip.end) ?? ph.mark('End date'),
    },
    pax: {
      adults: view.pax.adults,
      childWithBed: view.pax.childrenWithBed,
      childNoBed: view.pax.childrenNoBed,
      infants: view.pax.infants,
      basis: ph.text(view.pax.basis, 'Room sharing basis'),
    },
    covers: [
      { k: 'Flights', in: has('flight') },
      { k: 'Hotels', in: has('hotel') },
      { k: 'Transfers', in: has('transfer') },
      { k: 'Tours & tickets', in: has('activity') },
      { k: 'Visas', in: has('visa') },
      { k: 'Insurance', in: false },
    ],
    days: dayRows,
    stay,
    flights,
    price: {
      perPerson: main.perPerson,
      paxCount: q.payingTravellers,
      total: main.total,
      totalWords: rupeesInWords(main.total),
      gstText: GST_TEXT,
      notTaxInvoice: NOT_TAX_INVOICE_TEXT,
      categories,
    },
    tiers: tierRows,
    payment,
    includes: cleanList(view.includes),
    excludes: cleanList(view.excludes),
    terms: view.terms ? cleanList(view.terms) : null,
    // DEC-50: last, so its placeholder (if any) is last in document order, like the footer.
    identity: documentIdentity(view.branchCode, ph),
  };

  const unsafe = scanStrings(input);
  if (unsafe.length) {
    return { ok: false, refusals: unsafe.map((h) => ({ code: 'unsafe_text', path: h.path ?? '$', detail: `${h.kind}:${h.phrase}` })) };
  }
  return { ok: true, input, placeholders: ph.labels, internalNotes: notes };
}
