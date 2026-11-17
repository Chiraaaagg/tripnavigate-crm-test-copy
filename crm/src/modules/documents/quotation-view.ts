import { z } from 'zod';
import type {
  DocumentFlightGroup,
  DocumentStay,
  QuotationDocumentView,
  QuotationTierView,
  ServiceKind,
  TierKey,
} from './contracts';

/**
 * Atlas `quotation_get` answer (migration 20261120000200) -> customer quotation
 * view. Pure. Reads ONLY the allowlisted keys below; everything else in the
 * answer (evidence, issues, pax remarks, requirements note, subject ids,
 * conversion, and the cost / margin / remark side of Mercury's staff `money`)
 * is never copied.
 *
 * Customer money comes only from Mercury's public `quotation_customer_money`
 * (migration 20261120000300; selling side only, null for anyone who may not
 * read prices). It is parsed here, never computed: one source of truth.
 * Without it the view has no tiers (the adapter then refuses `tier_missing`).
 */

const PaiseText = z.union([z.string().regex(/^-?\d{1,18}$/), z.number().int()]).transform(String);
const NullableText = z.string().nullable().optional().transform((v) => v ?? null);

const Item = z.object({
  itemNo: z.number().int(),
  serviceType: z.enum(['hotel', 'transfer', 'activity', 'flight', 'visa', 'passport']),
  tierKey: z.enum(['quoted', 'upgrade']).nullable(),
  facts: z.record(z.string(), z.unknown()),
});

/** `quotation_customer_money` answer (Mercury 0300). */
export const CustomerMoneySchema = z.object({
  tiers: z
    .array(
      z.object({
        tierKey: z.enum(['quoted', 'upgrade']),
        label: NullableText,
        quotedTotalPaise: PaiseText.nullable(),
        payingTravellers: z.number().int(),
        perPersonPaise: PaiseText.nullable().optional().transform((v) => v ?? null),
        breakdownHasAmounts: z.boolean(),
        breakdown: z.array(
          z.object({
            categoryKey: z.enum(['flights', 'hotels', 'transfers', 'tours', 'visas', 'insurance', 'other']),
            descriptions: z.array(z.string()),
            amountPaise: PaiseText.nullable().optional().transform((v) => v ?? null),
          }),
        ),
        plan: z.array(
          z.object({
            seq: z.number().int(),
            label: z.string(),
            amountPaise: PaiseText,
            dueRule: z.enum(['on_acceptance', 'days_before_start', 'fixed_date']),
            dueDays: z.number().int().nullable().optional().transform((v) => v ?? null),
            dueDate: NullableText,
          }),
        ),
      }),
    )
    .nullable()
    .transform((v) => v ?? []),
});
export type CustomerMoney = z.infer<typeof CustomerMoneySchema>;

// A day may have a title only (the editor stores null text); an empty text prints as a placeholder.
const ContentDay = z.object({ day: z.number().int(), title: z.string(), text: z.string().nullable().optional().transform((v) => v ?? '') });
const Content = z
  .object({
    days: z.array(ContentDay).optional(),
    includes: z.array(z.string()).optional(),
    excludes: z.array(z.string()).optional(),
    terms: z.array(z.string()).optional(),
  })
  .passthrough()
  .nullable()
  .optional();

export const QuotationGetSchema = z.object({
  reference: z.string(),
  title: z.string(),
  // DEC-50 (Atlas 0800): the quotation's branch code; only this key of `subject` is read.
  subject: z.object({ branchCode: NullableText }).nullable().optional(),
  version: z.object({
    versionNo: z.number().int(),
    status: z.string(),
    validUntil: NullableText,
    sentAt: NullableText,
    acceptedTier: NullableText,
  }),
  trip: z.object({ destination: NullableText, start: NullableText, end: NullableText }),
  pax: z.object({
    adults: z.number().int(),
    childrenWithBed: z.number().int(),
    childrenNoBed: z.number().int(),
    infants: z.number().int(),
  }),
  content: Content,
  tiers: z.array(z.object({ tierKey: z.enum(['quoted', 'upgrade']), label: NullableText })).default([]),
  items: z.array(Item).default([]),
  contacts: z.object({ contactName: z.string(), mobile: NullableText, email: NullableText }).nullable().optional(),
});
export type QuotationGet = z.infer<typeof QuotationGetSchema>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function inTier(item: { tierKey: TierKey | null }, tier: TierKey): boolean {
  return item.tierKey === null || item.tierKey === tier;
}

function stayOf(facts: Record<string, unknown>): DocumentStay {
  return {
    city: str(facts.city) ?? '',
    checkIn: str(facts.checkIn),
    checkOut: str(facts.checkOut),
    hotelName: str(facts.hotelName),
    roomType: str(facts.roomType),
    mealPlan: str(facts.mealPlan),
    rooms: int(facts.rooms),
    note: str(facts.area),
  };
}

const byCheckIn = (a: DocumentStay, b: DocumentStay) => (a.checkIn ?? '9999').localeCompare(b.checkIn ?? '9999');

function flightGroups(items: QuotationGet['items']): DocumentFlightGroup[] {
  return items
    .filter((i) => i.serviceType === 'flight')
    .flatMap((i) => (Array.isArray(i.facts.segments) ? (i.facts.segments as Array<Record<string, unknown>>) : []))
    .map((s) => ({ from: str(s.from) ?? '', to: str(s.to) ?? '', date: str(s.date) ?? '' }))
    .filter((s) => s.from && s.to && s.date)
    .map((s, n) => ({
      label: n === 0 ? 'Outbound' : 'Onward',
      date: s.date,
      // Carrier, flight number, times and baggage come from the Flight desk later.
      legs: [{ carrier: null, number: null, from: s.from, to: s.to, dep: null, arr: null }],
      baggage: null,
    }));
}

/** Customer tiers from `quotation_customer_money` (a tier without a typed total is not printable and is left out). */
export function toCustomerTiers(money: CustomerMoney | null | undefined, labels: QuotationGet['tiers']): QuotationTierView[] {
  if (!money) return [];
  return money.tiers
    .filter((t): t is typeof t & { quotedTotalPaise: string } => t.quotedTotalPaise !== null)
    .map((t) => ({
      tierKey: t.tierKey,
      label: t.label ?? labels.find((x) => x.tierKey === t.tierKey)?.label ?? null,
      quotedTotalPaise: t.quotedTotalPaise,
      payingTravellers: t.payingTravellers,
      perPersonPaise: t.perPersonPaise,
      breakdownHasAmounts: t.breakdownHasAmounts,
      breakdown: t.breakdown.map((b) => ({ categoryKey: b.categoryKey, descriptions: b.descriptions, amountPaise: t.breakdownHasAmounts ? b.amountPaise : null })),
      hotels: null,
      plan: [...t.plan].sort((a, b) => a.seq - b.seq),
    }))
    .sort((a, b) => (a.tierKey === 'quoted' ? -1 : b.tierKey === 'quoted' ? 1 : 0));
}

export interface QuotationViewContext {
  preparedBy: { name: string; role: string; phone: string | null };
  /** IST calendar date, YYYY-MM-DD; used when the version was not sent yet. */
  today: string;
}

export function toQuotationDocumentView(get: QuotationGet, money: CustomerMoney | null, ctx: QuotationViewContext): QuotationDocumentView {
  const quotedItems = get.items.filter((i) => inTier(i, 'quoted'));
  const stays = quotedItems.filter((i) => i.serviceType === 'hotel').map((i) => stayOf(i.facts)).sort(byCheckIn);
  const tiers = toCustomerTiers(money, get.tiers);
  const upgradeHotels = get.items
    .filter((i) => i.serviceType === 'hotel' && inTier(i, 'upgrade'))
    .map((i) => stayOf(i.facts))
    .sort(byCheckIn)
    .map((s) => s.hotelName);
  for (const t of tiers) if (t.tierKey === 'upgrade') t.hotels = upgradeHotels;

  const content = get.content ?? {};
  const serviceTypes = [...new Set(quotedItems.map((i) => i.serviceType))] as ServiceKind[];
  return {
    kind: 'quotation',
    reference: get.reference,
    versionNo: get.version.versionNo,
    revisionNote: null,
    issueDate: get.version.sentAt?.slice(0, 10) ?? ctx.today,
    validUntil: get.version.validUntil,
    preparedBy: ctx.preparedBy,
    customer: { name: get.contacts?.contactName ?? null, phone: get.contacts?.mobile ?? null },
    trip: { title: get.title, destination: get.trip.destination, start: get.trip.start, end: get.trip.end },
    pax: {
      adults: get.pax.adults,
      childrenWithBed: get.pax.childrenWithBed,
      childrenNoBed: get.pax.childrenNoBed,
      infants: get.pax.infants,
      basis: null,
    },
    serviceTypes,
    stays,
    flights: flightGroups(quotedItems),
    days: (content.days ?? []).map((d) => ({ day: d.day, city: null, title: d.title, text: d.text })),
    tiers,
    includes: content.includes ?? [],
    excludes: content.excludes ?? [],
    terms: content.terms?.length ? content.terms : null,
    branchCode: get.subject?.branchCode ?? null,
  };
}
