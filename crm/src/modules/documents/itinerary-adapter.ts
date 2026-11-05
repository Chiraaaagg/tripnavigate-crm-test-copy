import 'server-only';
import type { AdapterRefusal, AdapterResult, ItineraryDocumentView, PackageDocumentInput } from './contracts';
import { documentIdentity } from './company-identity';
import { forbiddenKeyPaths } from './guard';
import { exactPerPersonRupees, paiseToRupees } from './money';
import { scanStrings } from './safety';
import { PlaceholderCollector, cleanList, daysBetween, neutraliseLeadingBracket, shortDate } from './text';

/**
 * Confirmed itinerary facts -> engine-shaped itinerary input (Nova Phase A
 * sections 5-6; freeze part 2 section 5). The facts are the ones Sales
 * confirmed after the factual differences were settled; day stories are
 * condensed from the source by a person, never invented here. Missing CORE
 * facts (dates, stays, hotels, day plan, pickup/drop) become visible
 * placeholders (issue blocked while any remains); the optional cover and
 * narrative copy is never a placeholder: when empty the template hides it.
 *
 * Refuses: a commercial/internal key in the view, stay nights that disagree
 * with the trip dates, a day plan of the wrong length, an amount with paise
 * (when prices are printed) and any unsafe customer text.
 */
export function itineraryToEngine(view: ItineraryDocumentView): AdapterResult<PackageDocumentInput> {
  const forbidden = forbiddenKeyPaths(view);
  if (forbidden.length) return { ok: false, refusals: forbidden.map((path) => ({ code: 'forbidden_field', path })) };

  const refusals: AdapterRefusal[] = [];
  const notes: string[] = [];
  const ph = new PlaceholderCollector();
  const f = view.facts;

  f.stays.forEach((s, i) => {
    if (!Number.isInteger(s.nights) || s.nights < 1) refusals.push({ code: 'nights_mismatch', path: `facts.stays[${i}].nights` });
    const byDates = daysBetween(s.checkIn, s.checkOut);
    if (byDates !== null && byDates !== s.nights) refusals.push({ code: 'nights_mismatch', path: `facts.stays[${i}]` });
  });
  const nights = f.stays.reduce((a, s) => a + s.nights, 0);
  const tripNights = daysBetween(f.startDate, f.endDate);
  if (tripNights !== null && tripNights !== nights) refusals.push({ code: 'nights_mismatch', path: 'facts.stays' });
  if (tripNights !== null && tripNights < 0) refusals.push({ code: 'dates_invalid', path: 'facts.endDate' });
  const days = nights + 1;
  if (f.days.length && f.days.length !== days) refusals.push({ code: 'days_mismatch', path: 'facts.days' });

  let tiers: PackageDocumentInput['tiers'] = null;
  if (view.prices === null) {
    notes.push('prices_not_shown');
  } else {
    tiers = [];
    for (const [i, t] of view.prices.entries()) {
      const total = paiseToRupees(t.quotedTotalPaise);
      if (!total.ok) {
        refusals.push({ code: total.code, path: `prices[${i}].quotedTotalPaise` });
        continue;
      }
      tiers.push({
        name: t.tierKey === 'quoted' ? 'As quoted' : 'Upgrade',
        total: total.rupees,
        perPerson: t.perPersonPaise === null ? null : exactPerPersonRupees(total.rupees, t.payingTravellers),
      });
    }
  }
  if (refusals.length) return { ok: false, refusals };

  const hotelFor = (city: string): string | null => f.stays.find((s) => s.city === city)?.hotelName ?? null;
  const daysList: PackageDocumentInput['daysList'] = f.days.length
    ? [...f.days]
        .sort((a, b) => a.n - b.n)
        .map((d, i) => ({
          n: i + 1,
          base: neutraliseLeadingBracket(d.base),
          title: ph.text(d.title, 'Day title'),
          story: ph.text(d.story, 'Day story'),
          highlights: cleanList(d.highlights),
          meal: d.meals ? neutraliseLeadingBracket(d.meals) : null,
          stay: ph.text(hotelFor(d.base), 'Hotel name'),
        }))
    : Array.from({ length: days }, (_, i) => ({
        n: i + 1,
        base: ph.mark('Base city'),
        title: ph.mark('Day title'),
        story: ph.mark('Day story'),
        highlights: [],
        meal: null,
        stay: ph.mark('Hotel name'),
      }));
  if (!f.days.length) notes.push('day_plan_missing');

  const moves = [
    ...f.transfers.map((t) => ({ date: t.date, title: `${neutraliseLeadingBracket(t.from)} to ${neutraliseLeadingBracket(t.to)}` })),
    ...f.flights.map((fl) => ({ date: fl.date, title: `Flight ${neutraliseLeadingBracket(fl.from)} to ${neutraliseLeadingBracket(fl.to)}` })),
  ]
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
    .map((m) => ({ day: shortDate(m.date) ?? ph.mark('Date'), title: m.title }));

  const firstTransfer = f.transfers[0];
  const lastTransfer = f.transfers[f.transfers.length - 1];
  const opt = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? neutraliseLeadingBracket(v) : null);

  const input: PackageDocumentInput = {
    code: view.reference,
    generated: view.generatedOn,
    destination: neutraliseLeadingBracket(view.destination),
    // Optional copy: never a placeholder (the template hides what is empty).
    destinationShort: opt(view.destinationShort),
    country: opt(view.country),
    days,
    nights,
    category: opt(view.category),
    pickup: ph.text(firstTransfer?.from ?? null, 'Pickup point'),
    drop: ph.text(lastTransfer?.to ?? null, 'Drop point'),
    paxBasis: opt(view.paxBasis),
    bases: f.stays.map((s) => ({ name: neutraliseLeadingBracket(s.city), nights: s.nights })),
    daysList,
    hotels: f.stays.map((s) => ({
      city: neutraliseLeadingBracket(s.city),
      nights: s.nights,
      hotel: ph.text(s.hotelName, 'Hotel name'),
      room: ph.text(s.roomType, 'Room type'),
    })),
    moves,
    intro: cleanList(view.narrative.intro),
    reasons: (view.narrative.reasons ?? [])
      .map((r) => ({ title: opt(r.title) ?? '', body: opt(r.body) ?? '' }))
      .filter((r) => r.title !== '' || r.body !== ''),
    weHandle: cleanList(view.narrative.weHandle),
    youBring: cleanList(view.narrative.youBring),
    inclusions: cleanList(f.inclusions),
    exclusions: cleanList(f.exclusions),
    tiers,
    // DEC-50: last, so its placeholder (if any) is last in document order, like the footer.
    identity: documentIdentity(view.branchCode, ph),
  };

  const unsafe = scanStrings(input);
  if (unsafe.length) {
    return { ok: false, refusals: unsafe.map((h) => ({ code: 'unsafe_text', path: h.path ?? '$', detail: `${h.kind}:${h.phrase}` })) };
  }
  return { ok: true, input, placeholders: ph.labels, internalNotes: notes };
}
