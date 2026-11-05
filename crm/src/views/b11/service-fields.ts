import { HOTEL_EXTRA_LABEL, HOTEL_EXTRA_LIMITS } from '@/modules/fulfilment/contracts';
import { dateText } from './book-fields';
import type { BookItem, BookServiceType } from './shapes';

/*
 * Form fields per service type for the Book now "Services" step (plan §3d–3g,
 * freeze appendix A §1.2 keys). `name` is the form input name the action
 * parses (frozen with the lead, 11 October); `fact` is the stored facts key.
 * Pure data and small helpers; no database access.
 */

export type FactControl = 'text' | 'textarea' | 'date' | 'time' | 'number' | 'select';

export interface ServiceFieldDef {
  name: string;
  fact: string;
  label: string;
  control: FactControl;
  required?: boolean;
  hint?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  wide?: boolean;
  min?: number;
  max?: number;
  /** Shown only when this returns true for the current values. */
  when?: (values: Record<string, string>) => boolean;
}

export const SERVICE_FIELDS: Record<BookServiceType, ServiceFieldDef[]> = {
  hotel: [
    {
      name: 'mode',
      fact: 'mode',
      label: 'Customer asked for',
      control: 'select',
      required: true,
      options: [
        { value: 'specific', label: 'A specific hotel' },
        { value: 'preferences', label: 'Acceptable options or preferences' },
      ],
    },
    { name: 'hotelName', fact: 'hotelName', label: 'Requested hotel', control: 'text', required: true, hint: 'The hotel Purchase actually books is recorded later by Purchase.', when: (v) => v.mode !== 'preferences' },
    { name: 'preferences', fact: 'preferences', label: 'Acceptable options', control: 'textarea', required: true, hint: 'For example: 4-star near the lake, with a pool.', wide: true, when: (v) => v.mode === 'preferences' },
    { name: 'city', fact: 'city', label: 'City', control: 'text', required: true },
    { name: 'area', fact: 'area', label: 'Area or location', control: 'text' },
    { name: 'checkIn', fact: 'checkIn', label: 'Check-in', control: 'date', required: true },
    { name: 'checkOut', fact: 'checkOut', label: 'Check-out', control: 'date', required: true },
    { name: 'rooms', fact: 'rooms', label: 'Rooms', control: 'number', required: true, min: 1, max: 50 },
    { name: 'roomType', fact: 'roomType', label: 'Room type', control: 'text' },
    { name: 'adults', fact: 'adults', label: 'Adults', control: 'number', required: true, min: 1, max: 100 },
    { name: 'children', fact: 'children', label: 'Children', control: 'number', min: 0, max: 50 },
    { name: 'childAges', fact: 'childAges', label: 'Child ages', control: 'text', required: true, hint: 'Ages in years, separated by commas, for example: 5, 9.', when: (v) => Number(v.children || 0) > 0 },
    { name: 'mealPlan', fact: 'mealPlan', label: 'Meal plan', control: 'text' },
    { name: 'extraBeds', fact: 'extraBeds', label: HOTEL_EXTRA_LABEL.extraBeds.label, hint: HOTEL_EXTRA_LABEL.extraBeds.hint, control: 'number', min: HOTEL_EXTRA_LIMITS.extraBeds.min, max: HOTEL_EXTRA_LIMITS.extraBeds.max },
    { name: 'childrenWithoutBed', fact: 'childrenWithoutBed', label: HOTEL_EXTRA_LABEL.childrenWithoutBed.label, hint: HOTEL_EXTRA_LABEL.childrenWithoutBed.hint, control: 'number', min: HOTEL_EXTRA_LIMITS.childrenWithoutBed.min, max: HOTEL_EXTRA_LIMITS.childrenWithoutBed.max },
    { name: 'bedRemarks', fact: 'bedRemarks', label: HOTEL_EXTRA_LABEL.bedRemarks.label, hint: HOTEL_EXTRA_LABEL.bedRemarks.hint, control: 'textarea', wide: true },
    { name: 'inclusions', fact: 'inclusions', label: 'Inclusions', control: 'textarea', wide: true },
    { name: 'exclusions', fact: 'exclusions', label: 'Exclusions', control: 'textarea', wide: true },
    { name: 'specialRequests', fact: 'specialRequests', label: 'Special requests', control: 'textarea', wide: true },
  ],
  flight: [
    {
      name: 'tripType',
      fact: 'tripType',
      label: 'Trip type',
      control: 'select',
      required: true,
      options: [
        { value: 'one_way', label: 'One-way' },
        { value: 'return', label: 'Return' },
        { value: 'multi_city', label: 'Multi-city' },
      ],
    },
    {
      name: 'cabin',
      fact: 'cabin',
      label: 'Cabin',
      control: 'select',
      options: [
        { value: '', label: 'No preference' },
        { value: 'Economy', label: 'Economy' },
        { value: 'Premium economy', label: 'Premium economy' },
        { value: 'Business', label: 'Business' },
        { value: 'First', label: 'First' },
      ],
    },
    { name: 'passengers', fact: 'passengers', label: 'Passengers', control: 'number', required: true, min: 1, max: 100 },
    { name: 'preferredTime', fact: 'preferredTime', label: 'Preferred time', control: 'text', hint: 'For example: morning departure.' },
    { name: 'flightPreferences', fact: 'preferences', label: 'Baggage, seat or meal preferences', control: 'textarea', wide: true },
    { name: 'assistance', fact: 'assistance', label: 'Special assistance', control: 'textarea', wide: true, hint: 'Wheelchair, medical needs — only what the trip needs.' },
    { name: 'notes', fact: 'notes', label: 'Notes for the Flight team', control: 'textarea', wide: true },
  ],
  transfer: [
    { name: 'pickup', fact: 'pickup', label: 'Pickup', control: 'text', required: true },
    { name: 'drop', fact: 'drop', label: 'Drop', control: 'text', required: true },
    { name: 'date', fact: 'date', label: 'Date', control: 'date', required: true },
    { name: 'pickupTime', fact: 'pickupTime', label: 'Pickup time', control: 'time' },
    { name: 'vehicleType', fact: 'vehicleType', label: 'Vehicle type', control: 'text' },
    { name: 'passengers', fact: 'passengers', label: 'Seats needed', control: 'number', min: 1, max: 100 },
    { name: 'notes', fact: 'notes', label: 'Notes', control: 'textarea', wide: true },
  ],
  activity: [
    { name: 'name', fact: 'name', label: 'Activity', control: 'text', required: true },
    { name: 'city', fact: 'city', label: 'City', control: 'text', required: true },
    { name: 'date', fact: 'date', label: 'Date', control: 'date', required: true },
    { name: 'time', fact: 'time', label: 'Time', control: 'time' },
    { name: 'participants', fact: 'participants', label: 'People taking part', control: 'number', required: true, min: 1, max: 100 },
    { name: 'inclusions', fact: 'inclusions', label: 'Inclusions', control: 'textarea', wide: true },
    { name: 'notes', fact: 'notes', label: 'Notes', control: 'textarea', wide: true },
  ],
  visa: [
    { name: 'country', fact: 'country', label: 'Destination country', control: 'text', required: true },
    {
      name: 'purpose',
      fact: 'purpose',
      label: 'Purpose',
      control: 'select',
      required: true,
      options: [
        { value: 'Tourism', label: 'Tourism' },
        { value: 'Business', label: 'Business' },
        { value: 'Visiting family', label: 'Visiting family' },
        { value: 'Transit', label: 'Transit' },
      ],
    },
    { name: 'travelDate', fact: 'travelDate', label: 'Planned travel date', control: 'date', required: true },
    { name: 'applyBy', fact: 'applyBy', label: 'Apply by', control: 'date', hint: 'If known. Must be on or before the travel date.' },
    {
      name: 'feePaidBy',
      fact: 'feePaidBy',
      label: 'Government fee paid by',
      control: 'select',
      required: true,
      options: [
        { value: 'not_decided', label: 'Not decided yet' },
        { value: 'customer', label: 'Customer pays directly' },
        { value: 'company', label: 'Company pays (recorded for Accounts review)' },
      ],
    },
    { name: 'notes', fact: 'notes', label: 'Notes for the desk', control: 'textarea', wide: true },
  ],
  passport: [
    {
      name: 'applicationType',
      fact: 'applicationType',
      label: 'Application type',
      control: 'select',
      required: true,
      options: [
        { value: 'fresh', label: 'Fresh' },
        { value: 'renewal', label: 'Renewal' },
        { value: 'tatkaal', label: 'Tatkaal' },
        { value: 'minor', label: 'Minor' },
      ],
    },
    { name: 'officeCity', fact: 'officeCity', label: 'Passport office city', control: 'text', required: true },
    { name: 'neededBy', fact: 'neededBy', label: 'Needed by', control: 'date' },
    { name: 'notes', fact: 'notes', label: 'Notes for the desk', control: 'textarea', wide: true },
  ],
};

export interface SegmentValues {
  from: string;
  to: string;
  date: string;
  flex: string;
}

export const FLEX_OPTIONS = [
  { value: '', label: 'Exact date' },
  { value: '± 1 day', label: '± 1 day' },
  { value: '± 3 days', label: '± 3 days' },
] as const;

export const MAX_SEGMENTS = 8;

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** Stored facts → form values (every field of the type, '' when absent). */
export function factsToFormValues(type: BookServiceType, facts: Record<string, unknown> | null | undefined, budgetRupees = ''): Record<string, string> {
  const values: Record<string, string> = {};
  for (const def of SERVICE_FIELDS[type]) values[def.name] = text(facts?.[def.fact]);
  if (type === 'hotel' && !values.mode) values.mode = 'specific';
  if (type === 'flight' && !values.tripType) values.tripType = 'return';
  if (type === 'visa' && !values.feePaidBy) values.feePaidBy = 'not_decided';
  if (type === 'visa' && !values.purpose) values.purpose = 'Tourism';
  if (type === 'passport' && !values.applicationType) values.applicationType = 'renewal';
  values.purchaseBudgetRupees = budgetRupees;
  return values;
}

export function factsToSegments(facts: Record<string, unknown> | null | undefined): SegmentValues[] {
  const raw = Array.isArray(facts?.segments) ? (facts!.segments as Array<Record<string, unknown>>) : [];
  const out = raw.map((s) => ({ from: text(s.from), to: text(s.to), date: text(s.date), flex: text(s.flex) }));
  return out.length > 0 ? out : [{ from: '', to: '', date: '', flex: '' }];
}

/** Budgets exist only for Purchase and Flight services. */
export function hasBudget(type: BookServiceType): boolean {
  return type !== 'visa' && type !== 'passport';
}

/** The stored facts object of an item (the contract wraps it as { type, facts }). */
export function factsOf(item: { facts: unknown }): Record<string, unknown> {
  const f = item.facts as { facts?: unknown } | null | undefined;
  if (f && typeof f === 'object' && 'facts' in f && f.facts && typeof f.facts === 'object') return f.facts as Record<string, unknown>;
  return (f ?? {}) as Record<string, unknown>;
}

/** One-line summary for lists and the review step. */
export function itemSummary(item: Pick<BookItem, 'serviceType' | 'facts' | 'title'>): string {
  const f = factsOf(item);
  const s = (k: string) => text(f[k]);
  switch (item.serviceType) {
    case 'hotel':
      return [s('hotelName') || (s('preferences') ? `Preference: ${s('preferences')}` : ''), s('city'), s('checkIn') && `${dateText(s('checkIn'))} to ${dateText(s('checkOut'))}`].filter(Boolean).join(' · ');
    case 'flight':
      return factsToSegments(f)
        .map((g) => `${g.from} to ${g.to}`)
        .join(', ');
    case 'transfer':
      return [s('pickup') && s('drop') ? `${s('pickup')} to ${s('drop')}` : s('route'), dateText(s('date'))].filter(Boolean).join(' · ');
    case 'activity':
      return [s('name'), s('city'), dateText(s('date'))].filter(Boolean).join(' · ');
    case 'visa':
      return [s('country'), s('purpose')].filter(Boolean).join(' · ');
    case 'passport':
      return [s('applicationType'), s('officeCity')].filter(Boolean).join(' · ');
    default:
      return item.title;
  }
}
