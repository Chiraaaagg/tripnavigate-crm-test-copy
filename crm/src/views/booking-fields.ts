import type { BookingIssueCode } from '@/modules/fulfilment/contracts';

/*
 * Plain (server- and client-safe) constants for the booking form. They live
 * outside the 'use client' module because values exported from a client
 * module are client references when imported by a server component.
 */

/** Element id of each booking field, so the repair list can link straight to it. */
export const FIELD_ID = {
  hotelName: 'booking-hotelName',
  city: 'booking-city',
  checkIn: 'booking-checkIn',
  checkOut: 'booking-checkOut',
  rooms: 'booking-rooms',
  roomType: 'booking-roomType',
  mealPlan: 'booking-mealPlan',
  adults: 'booking-adults',
  children: 'booking-children',
  inclusions: 'booking-inclusions',
  specialRequests: 'booking-specialRequests',
  purchaseBudgetRupees: 'booking-purchaseBudget',
  sellingTotalRupees: 'booking-sellingTotal',
  proof: 'booking-proof',
} as const;

export type FieldKey = Exclude<keyof typeof FIELD_ID, 'proof'>;

/** Which field each readiness issue points at (gate and source issues have none). */
export const ISSUE_FIELD: Partial<Record<BookingIssueCode, keyof typeof FIELD_ID>> = {
  missing_hotel_name: 'hotelName',
  missing_city: 'city',
  missing_dates: 'checkIn',
  check_out_not_after_check_in: 'checkOut',
  missing_rooms: 'rooms',
  missing_travellers: 'adults',
  missing_purchase_budget: 'purchaseBudgetRupees',
  missing_selling_total: 'sellingTotalRupees',
  missing_acceptance_proof: 'proof',
  evidence_upload_incomplete: 'proof',
};

/*
 * Money wording. The booking's own customer-agreed total is a different
 * number from the deal selling price (deal record / Bitrix); the labels never
 * share a name, and each hint says which one it is.
 */
export const BOOKING_TOTAL_LABEL = 'Booking total agreed with the customer';
export const BOOKING_TOTAL_HINT =
  'In rupees. What the customer agreed to pay for this hotel booking — not the deal selling price. Sales and managers only; Purchase never sees it.';
export const PURCHASE_BUDGET_LABEL = 'Approved Purchase budget';
export const PURCHASE_BUDGET_HINT = 'In rupees. The most Purchase may spend on this hotel. Purchase sees this amount.';

/** Form sections of the booking draft (progressive disclosure on small screens). */
export type SectionKey = 'stay' | 'rooms' | 'money' | 'notes';

/** Fields each section needs before the booking can be confirmed (optional fields are left out). */
export const SECTION_REQUIRED: Record<SectionKey, FieldKey[]> = {
  stay: ['hotelName', 'city', 'checkIn', 'checkOut'],
  rooms: ['rooms', 'adults'],
  money: ['purchaseBudgetRupees', 'sellingTotalRupees'],
  notes: [],
};

export const SECTION_FIELDS: Record<SectionKey, FieldKey[]> = {
  stay: ['hotelName', 'city', 'checkIn', 'checkOut'],
  rooms: ['rooms', 'roomType', 'mealPlan', 'adults', 'children'],
  money: ['purchaseBudgetRupees', 'sellingTotalRupees'],
  notes: ['inclusions', 'specialRequests'],
};

export type SectionStatus = { kind: 'done' } | { kind: 'missing'; count: number } | { kind: 'attention' } | { kind: 'optional' };

/**
 * Section completion for the summary line. `fields` lists the fields that are
 * rendered (the booking total is absent for viewers who may not see it);
 * `withIssue` lists fields the server's readiness check flagged.
 */
export function sectionStatus(
  section: SectionKey,
  values: Partial<Record<FieldKey, string>>,
  rendered: FieldKey[],
  withIssue: FieldKey[],
): SectionStatus {
  const fields = SECTION_FIELDS[section].filter((f) => rendered.includes(f));
  if (fields.some((f) => withIssue.includes(f))) {
    const missing = SECTION_REQUIRED[section].filter((f) => fields.includes(f) && !(values[f] ?? '').trim()).length;
    return missing > 0 ? { kind: 'missing', count: missing } : { kind: 'attention' };
  }
  const required = SECTION_REQUIRED[section].filter((f) => fields.includes(f));
  if (required.length === 0) return { kind: 'optional' };
  const missing = required.filter((f) => !(values[f] ?? '').trim()).length;
  return missing === 0 ? { kind: 'done' } : { kind: 'missing', count: missing };
}

export function sectionStatusText(status: SectionStatus): string {
  switch (status.kind) {
    case 'done':
      return 'Done';
    case 'missing':
      return `${status.count} to add`;
    case 'attention':
      return 'Check this';
    default:
      return 'Optional';
  }
}
