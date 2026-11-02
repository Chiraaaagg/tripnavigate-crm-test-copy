import { z } from 'zod';
import type { FactOrigin, ItineraryDocumentView, ItineraryFactsDraft, ItineraryNarrative, QuotationTierView, QuoteCategoryKey, TierKey, TripFactsSet } from './contracts';
import { exactPerPersonRupees, paiseToRupees } from './money';
import type { BookNowView } from '@/modules/fulfilment/contracts';
import type { QuotationGet } from './quotation-view';
import { ItineraryMoneySchema } from '@/modules/itineraries/commands';
import type { ItineraryMoney } from '@/modules/itineraries/contracts';

/*
 * DEC-48: the customer prices printed on an itinerary come from Atlas 0500
 * `itinerary_document_get.money` / `itinerary_render_input.money` (null for
 * anyone who may not read prices). Selling side only, never cost or margin.
 * The wire shape is Terra's ItineraryMoneySchema (one source of truth).
 */

/**
 * Atlas itinerary reads (migration 20261120000500, shapes frozen
 * 12 October 2026) -> facts draft, customer itinerary view and comparison
 * basis. Pure. Only allowlisted keys are read; Atlas's facts JSON has no
 * money keys by construction.
 */

const Text = z.string().nullable().optional().transform((v) => (typeof v === 'string' && v.trim() !== '' ? v : null));
const Int = z.number().int().nullable().optional().transform((v) => (typeof v === 'number' ? v : null));
const Strings = z.array(z.string()).nullable().optional().transform((v) => v ?? []);

const FactsJson = z
  .object({
    destination: Text,
    startDate: Text,
    endDate: Text,
    party: z
      .object({ adults: Int, children: Int, childAges: z.array(z.number().int()).nullable().optional(), infants: Int })
      .nullable()
      .optional(),
    stays: z
      .array(
        z.object({
          city: Text, nights: Int, checkIn: Text, checkOut: Text, hotelName: Text, roomType: Text, mealPlan: Text, rooms: Int,
        }),
      )
      .nullable()
      .optional(),
    days: z
      .array(z.object({ n: Int, date: Text, base: Text, title: Text, story: Text, highlights: Strings, meals: Text }))
      .nullable()
      .optional(),
    transfers: z.array(z.object({ date: Text, from: Text, to: Text, mode: Text })).nullable().optional(),
    activities: z.array(z.object({ date: Text, city: Text, name: Text, included: z.boolean().nullable().optional() })).nullable().optional(),
    flights: z.array(z.object({ date: Text, from: Text, to: Text, carrier: Text, number: Text })).nullable().optional(),
    inclusions: Strings,
    exclusions: Strings,
    provenance: z.record(z.string(), z.enum(['manual', 'quotation', 'booking'])).nullable().optional(),
    // Optional cover and narrative copy (Atlas 0500 narrative keys, text only).
    coverWord: Text,
    country: Text,
    category: Text,
    roomBasis: Text,
    introduction: Text,
    reasons: Strings,
    handledByUs: Strings,
    youBring: Strings,
  })
  .nullable()
  .optional();

export const ItineraryDocumentGetSchema = z.object({
  money: ItineraryMoneySchema.nullable().optional(),
  documentId: z.string(),
  title: z.string(),
  // DEC-50 (Atlas 0800): branchCode = branches.code of the document (also on itinerary_render_input).
  subject: z.object({ kind: z.enum(['quotation', 'deal', 'referral']), quotationId: Text, dealId: Text, branchCode: Text }),
  draft: z.object({
    draftId: z.string(),
    status: z.string(),
    rowVersion: z.number().int(),
    facts: FactsJson,
    factsHash: Text,
    sourceFileId: Text,
  }),
  basis: z.object({ kind: z.enum(['quotation_version', 'booking_version', 'none']), id: Text, hash: z.string() }),
  differences: z
    .object({
      runId: Text,
      current: z.boolean(),
      items: z.array(z.object({ differenceId: z.string(), path: z.string(), kind: z.enum(['missing', 'different', 'extra']), acknowledged: z.boolean() })),
    })
    .nullable()
    .optional(),
});
export type ItineraryDocumentGet = z.infer<typeof ItineraryDocumentGetSchema>;

const t = (v: string | null): string => v ?? '';

export function toItineraryFactsDraft(draft: ItineraryDocumentGet['draft']): ItineraryFactsDraft {
  // Missing facts read as empty (every key is optional in Atlas's JSON).
  const f = (draft.facts ?? {}) as Partial<NonNullable<ItineraryDocumentGet['draft']['facts']>>;
  return {
    draftId: draft.draftId,
    sourceFileId: draft.sourceFileId,
    destination: f.destination ?? null,
    startDate: f.startDate ?? null,
    endDate: f.endDate ?? null,
    party: {
      adults: f.party?.adults ?? 0,
      children: f.party?.children ?? 0,
      childAges: f.party?.childAges ?? null,
      infants: f.party?.infants ?? 0,
    },
    stays: (f.stays ?? []).map((s) => ({
      city: t(s.city), nights: s.nights ?? 0, checkIn: s.checkIn, checkOut: s.checkOut,
      hotelName: s.hotelName, roomType: s.roomType, mealPlan: s.mealPlan, rooms: s.rooms,
    })),
    days: (f.days ?? []).map((d, i) => ({
      n: d.n ?? i + 1, date: d.date, base: t(d.base), title: t(d.title), story: t(d.story), highlights: d.highlights, meals: d.meals,
    })),
    transfers: (f.transfers ?? []).map((x) => ({ date: x.date, from: t(x.from), to: t(x.to), mode: x.mode })),
    activities: (f.activities ?? []).map((a) => ({ date: a.date, city: a.city, name: t(a.name), included: a.included ?? true })),
    flights: (f.flights ?? []).map((x) => ({ date: x.date, from: t(x.from), to: t(x.to), carrier: x.carrier, number: x.number })),
    inclusions: f.inclusions ?? [],
    exclusions: f.exclusions ?? [],
    provenance: (f.provenance ?? {}) as Record<string, FactOrigin>,
    ...narrativeOf(f),
  };
}

function narrativeOf(f: Partial<NonNullable<ItineraryDocumentGet['draft']['facts']>>): { narrative?: ItineraryNarrative } {
  const introduction = (f.introduction ?? '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const reasons = (f.reasons ?? []).map((x) => x.trim()).filter(Boolean);
  const n: ItineraryNarrative = {
    coverWord: f.coverWord ?? null,
    country: f.country ?? null,
    category: f.category ?? null,
    roomBasis: f.roomBasis ?? null,
    introduction,
    reasons,
    handledByUs: (f.handledByUs ?? []).map((x) => x.trim()).filter(Boolean),
    youBring: (f.youBring ?? []).map((x) => x.trim()).filter(Boolean),
  };
  const any = n.coverWord || n.country || n.category || n.roomBasis || n.introduction.length || n.reasons.length || n.handledByUs.length || n.youBring.length;
  return any ? { narrative: n } : {};
}

/**
 * Customer itinerary view from the confirmed facts, with the optional cover
 * and narrative copy stored beside them (absent = not printed). Prices stay
 * off (PENDING owner; recommended without prices).
 */
export function toItineraryDocumentView(get: ItineraryDocumentGet, ctx: { today: string }): ItineraryDocumentView {
  const facts = toItineraryFactsDraft(get.draft);
  return {
    kind: 'itinerary',
    reference: get.title,
    generatedOn: ctx.today,
    destination: facts.destination ?? get.title,
    destinationShort: facts.narrative?.coverWord ?? null,
    country: facts.narrative?.country ?? null,
    category: facts.narrative?.category ?? null,
    paxBasis: facts.narrative?.roomBasis ?? null,
    facts,
    narrative: {
      intro: facts.narrative?.introduction ?? null,
      reasons: facts.narrative ? facts.narrative.reasons.map((title) => ({ title, body: '' })) : null,
      weHandle: facts.narrative?.handledByUs ?? null,
      youBring: facts.narrative?.youBring ?? null,
    },
    prices: itineraryPrices(get.money ?? null, facts),
    branchCode: get.subject.branchCode,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function nightsBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const d = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Comparison basis from a quotation version (Atlas quotation_get): common items
 * plus the accepted tier (accepted version) or the quoted tier (otherwise).
 * Quotations hold no child ages (null: not compared).
 */
export function basisFactsFromQuotation(get: QuotationGet): TripFactsSet {
  const tier: TierKey = get.version.acceptedTier === 'upgrade' ? 'upgrade' : 'quoted';
  const items = get.items.filter((i) => i.tierKey === null || i.tierKey === tier);
  const of = (type: string) => items.filter((i) => i.serviceType === type).map((i) => i.facts);
  const stays = of('hotel')
    .map((f) => ({
      city: str(f.city) ?? '', nights: nightsBetween(str(f.checkIn), str(f.checkOut)), checkIn: str(f.checkIn), checkOut: str(f.checkOut),
      hotelName: str(f.hotelName), roomType: str(f.roomType), mealPlan: str(f.mealPlan), rooms: int(f.rooms),
    }))
    .sort((a, b) => (a.checkIn ?? '9999').localeCompare(b.checkIn ?? '9999'));
  const transfers = of('transfer').map((f) => {
    const [routeFrom, routeTo] = (str(f.route) ?? '').split(/\s+to\s+/i);
    return { date: str(f.date), from: str(f.pickup) ?? routeFrom ?? '', to: str(f.drop) ?? routeTo ?? '', mode: str(f.vehicleType) };
  });
  const activities = of('activity').map((f) => ({ date: str(f.date), city: str(f.city), name: str(f.name) ?? '', included: true }));
  const flights = of('flight').flatMap((f) =>
    (Array.isArray(f.segments) ? (f.segments as Array<Record<string, unknown>>) : []).map((s) => ({
      date: str(s.date), from: str(s.from) ?? '', to: str(s.to) ?? '', carrier: null, number: null,
    })),
  );
  const content = get.content ?? {};
  return {
    destination: get.trip.destination,
    startDate: get.trip.start,
    endDate: get.trip.end,
    party: {
      adults: get.pax.adults,
      children: get.pax.childrenWithBed + get.pax.childrenNoBed,
      childAges: null,
      infants: get.pax.infants,
    },
    stays,
    transfers,
    activities,
    flights,
    inclusions: content.includes ?? [],
    exclusions: content.excludes ?? [],
  };
}

/**
 * Comparison basis from the Deal's working booking version (Terra's
 * BookNowView, read-only; no new database read). Cancelled items are left
 * out. A booking records no package-level inclusions/exclusions, so those
 * lists are null (not compared). Child ages only when every child has one.
 */
export function basisFactsFromBooking(view: Pick<BookNowView, 'trip' | 'travellers' | 'items'>): TripFactsSet {
  const live = view.items.filter((i) => i.state !== 'cancelled');
  const children = view.travellers.filter((t) => t.type === 'child');
  const ages = children.map((c) => c.ageYears);
  const stays: TripFactsSet['stays'] = [];
  const transfers: TripFactsSet['transfers'] = [];
  const activities: TripFactsSet['activities'] = [];
  const flights: TripFactsSet['flights'] = [];
  for (const item of live) {
    const sf = item.facts;
    if (sf.type === 'hotel') {
      const f = sf.facts;
      stays.push({
        city: f.city, nights: nightsBetween(f.checkIn, f.checkOut), checkIn: f.checkIn, checkOut: f.checkOut,
        hotelName: f.hotelName ?? null, roomType: f.roomType ?? null, mealPlan: f.mealPlan ?? null, rooms: f.rooms,
      });
    } else if (sf.type === 'transfer') {
      const f = sf.facts;
      const [routeFrom, routeTo] = f.route.split(/\s+to\s+/i);
      transfers.push({ date: f.date, from: f.pickup ?? routeFrom ?? '', to: f.drop ?? routeTo ?? '', mode: f.vehicleType });
    } else if (sf.type === 'activity') {
      const f = sf.facts;
      activities.push({ date: f.date, city: f.city, name: f.name, included: true });
    } else if (sf.type === 'flight') {
      for (const seg of sf.facts.segments) flights.push({ date: seg.date, from: seg.from, to: seg.to, carrier: null, number: null });
    }
  }
  stays.sort((a, b) => (a.checkIn ?? '9999').localeCompare(b.checkIn ?? '9999'));
  return {
    destination: view.trip.destination,
    startDate: view.trip.start,
    endDate: view.trip.end,
    party: {
      adults: view.travellers.filter((t) => t.type === 'adult').length,
      children: children.length,
      childAges: children.length && ages.every((a): a is number => a !== null) ? (ages as number[]) : null,
      infants: view.travellers.filter((t) => t.type === 'infant').length,
    },
    stays,
    transfers,
    activities,
    flights,
    inclusions: null,
    exclusions: null,
  };
}

/**
 * The facts draft as Atlas `itinerary_facts_save` takes it (p_facts): every
 * allowlisted key, nothing else (no draft id, no source file id, no money).
 * Text is trimmed; empty optional text is sent as null.
 */
export function toAtlasFactsJson(draft: ItineraryFactsDraft): Record<string, unknown> {
  const s = (v: string | null) => (v && v.trim() !== '' ? v.trim() : null);
  return {
    destination: s(draft.destination),
    startDate: draft.startDate,
    endDate: draft.endDate,
    party: { adults: draft.party.adults, children: draft.party.children, childAges: draft.party.childAges, infants: draft.party.infants },
    stays: draft.stays.map((x) => ({
      city: x.city.trim(), nights: x.nights, checkIn: x.checkIn, checkOut: x.checkOut,
      hotelName: s(x.hotelName), roomType: s(x.roomType), mealPlan: s(x.mealPlan), rooms: x.rooms,
    })),
    days: draft.days.map((d) => ({
      n: d.n, date: d.date, base: d.base.trim(), title: d.title.trim(), story: d.story.trim(), highlights: d.highlights, meals: s(d.meals),
    })),
    transfers: draft.transfers.map((x) => ({ date: x.date, from: x.from.trim(), to: x.to.trim(), mode: s(x.mode) })),
    activities: draft.activities.map((a) => ({ date: a.date, city: s(a.city), name: a.name.trim(), included: a.included })),
    flights: draft.flights.map((f) => ({ date: f.date, from: f.from.trim(), to: f.to.trim(), carrier: s(f.carrier), number: s(f.number) })),
    inclusions: draft.inclusions,
    exclusions: draft.exclusions,
    provenance: draft.provenance,
    // Optional copy only when present (a database before the narrative keys refuses unknown keys).
    ...(draft.narrative
      ? {
          coverWord: s(draft.narrative.coverWord),
          country: s(draft.narrative.country),
          category: s(draft.narrative.category),
          roomBasis: s(draft.narrative.roomBasis),
          introduction: draft.narrative.introduction.join('\n\n') || null,
          reasons: draft.narrative.reasons,
          handledByUs: draft.narrative.handledByUs,
          youBring: draft.narrative.youBring,
        }
      : {}),
  };
}

const CATEGORY_KEYS: readonly QuoteCategoryKey[] = ['flights', 'hotels', 'transfers', 'tours', 'visas', 'insurance', 'other'];
const DUE_RULES = ['on_acceptance', 'days_before_start', 'fixed_date'] as const;
type DueRule = (typeof DUE_RULES)[number];

/**
 * DEC-48: the price section of an itinerary. Quotation basis: the accepted
 * tier when the quotation was accepted, otherwise every priced tier (quoted
 * first). Booking basis: the booking's selling total as one line and its plan;
 * per person only when it divides exactly by the travellers who pay (adults
 * and children; infants do not count). Null = no price section.
 */
export function itineraryPrices(money: ItineraryMoney | null, facts: Pick<TripFactsSet, 'party'>): QuotationTierView[] | null {
  if (!money) return null;
  if (money.source === 'booking_version') {
    if (!money.sellingTotalPaise) return null;
    const paying = facts.party.adults + facts.party.children;
    const total = paiseToRupees(money.sellingTotalPaise);
    const each = total.ok ? exactPerPersonRupees(total.rupees, paying) : null;
    return [
      {
        tierKey: 'quoted',
        label: null,
        quotedTotalPaise: money.sellingTotalPaise,
        payingTravellers: paying,
        perPersonPaise: each === null ? null : String(each * 100),
        breakdownHasAmounts: false,
        breakdown: [],
        hotels: null,
        plan: [...money.plan].sort((a, b) => a.seq - b.seq).map((p) => ({ seq: p.seq, label: p.label, amountPaise: p.amountPaise, dueRule: 'fixed_date' as const, dueDays: null, dueDate: p.dueDate })),
      },
    ];
  }
  const tiers = money.tiers
    .filter((t): t is typeof t & { quotedTotalPaise: string } => t.quotedTotalPaise !== null)
    .filter((t) => !money.acceptedTier || t.tierKey === money.acceptedTier)
    .sort((a, b) => (a.tierKey === b.tierKey ? 0 : a.tierKey === 'quoted' ? -1 : 1))
    .map(
      (t): QuotationTierView => ({
        tierKey: t.tierKey,
        label: t.label,
        quotedTotalPaise: t.quotedTotalPaise,
        payingTravellers: t.payingTravellers ?? facts.party.adults + facts.party.children,
        perPersonPaise: t.perPersonPaise,
        breakdownHasAmounts: t.breakdownHasAmounts,
        breakdown: t.breakdown.map((b) => ({
          categoryKey: (CATEGORY_KEYS as readonly string[]).includes(b.categoryKey) ? (b.categoryKey as QuoteCategoryKey) : 'other',
          descriptions: b.descriptions,
          amountPaise: t.breakdownHasAmounts ? b.amountPaise : null,
        })),
        hotels: null,
        plan: [...t.plan]
          .sort((a, b) => a.seq - b.seq)
          .map((p) => ({
            seq: p.seq,
            label: p.label,
            amountPaise: p.amountPaise,
            // Mercury only writes these three rules; anything else prints as its date.
            dueRule: (DUE_RULES as readonly string[]).includes(p.dueRule ?? '') ? (p.dueRule as DueRule) : 'fixed_date',
            dueDays: p.dueDays,
            dueDate: p.dueDate,
          })),
      }),
    );
  return tiers.length ? tiers : null;
}
