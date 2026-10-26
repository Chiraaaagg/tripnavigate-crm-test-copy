import {
  BOOKING_FACT_LIMITS,
  CHECKLIST_TEXT,
  INTAKE_CONFIRM_DIALOG_TEXT,
  INTAKE_CONFIRM_SUCCESS_TEXT,
  type IntakeChecklist,
  type IntakeChecklistItem,
  MAX_FLIGHT_SEGMENTS,
  ON_HOLD_SERVICE_TYPES,
  SERVICE_FACT_LIMITS,
  type ServiceFacts,
  type ServiceItemView,
  type ServiceType,
  type Traveller,
  type TravellerType,
} from '@/modules/fulfilment/contracts';

/*
 * Plain (server- and client-safe) constants and pure helpers for the intake
 * screen. They live outside the 'use client' module because values exported
 * from a client module are client references when imported by a server
 * component, and so unit tests can import them without React.
 *
 * Field names come from the frozen FIELD map in modules/fulfilment/forms.ts
 * (freeze note §5): parallel arrays (segments, travellers) use one plain name
 * per input and the parser reads them with formData.getAll().
 */

/** Frozen form field names (freeze note §5), owned by modules/fulfilment/forms.ts; re-exported for the views. */
export { FIELD } from '@/modules/fulfilment/forms';

export const TRAVELLER_TYPE_LABEL: Record<TravellerType, string> = {
  adult: 'Adult',
  child: 'Child',
  infant: 'Infant',
};

export const ON_HOLD_LABEL: Record<(typeof ON_HOLD_SERVICE_TYPES)[number], string> = {
  train: 'Train',
};
export const ON_HOLD_OPTION_TEXT = 'on hold · not handled in the CRM yet';

export type FactControl = 'text' | 'date' | 'number' | 'time' | 'textarea';

export interface FactFieldDef {
  key: string;
  label: string;
  control: FactControl;
  required: boolean;
  /** Max characters (text) or max value (number). */
  max?: number;
  min?: number;
  hint?: string;
  /** Spans both columns of the form grid. */
  wide?: boolean;
  /** HTML autocapitalize hint. */
  autoCapitalize?: 'words' | 'sentences' | 'off';
}

const L = SERVICE_FACT_LIMITS;
const H = BOOKING_FACT_LIMITS;

/** The facts form per service type. Flight segments are a separate repeating group (not listed here). */
export const FACT_FIELDS: Record<ServiceType, FactFieldDef[]> = {
  hotel: [
    { key: 'hotelName', label: 'Hotel name', control: 'text', required: true, max: H.hotelName, autoCapitalize: 'words' },
    { key: 'city', label: 'City', control: 'text', required: true, max: H.city, autoCapitalize: 'words' },
    { key: 'checkIn', label: 'Check-in date', control: 'date', required: true },
    { key: 'checkOut', label: 'Check-out date', control: 'date', required: true },
    { key: 'rooms', label: 'Rooms', control: 'number', required: true, min: H.rooms.min, max: H.rooms.max },
    { key: 'adults', label: 'Adults', control: 'number', required: true, min: H.adults.min, max: H.adults.max },
    { key: 'children', label: 'Children', control: 'number', required: false, min: H.children.min, max: H.children.max },
    { key: 'roomType', label: 'Room type', control: 'text', required: false, max: H.roomType, autoCapitalize: 'sentences' },
    { key: 'mealPlan', label: 'Meal plan', control: 'text', required: false, max: H.mealPlan, hint: 'For example breakfast only.', autoCapitalize: 'sentences' },
    { key: 'inclusions', label: 'Inclusions', control: 'textarea', required: false, max: H.inclusions, wide: true, autoCapitalize: 'sentences' },
    { key: 'specialRequests', label: 'Special requests', control: 'textarea', required: false, max: H.specialRequests, wide: true, autoCapitalize: 'sentences' },
  ],
  transfer: [
    { key: 'route', label: 'Route', control: 'text', required: true, max: L.route, hint: 'For example airport to hotel, both ways.', wide: true, autoCapitalize: 'sentences' },
    { key: 'date', label: 'Date', control: 'date', required: true },
    { key: 'pickupTime', label: 'Pick-up time', control: 'time', required: false, hint: '24-hour clock, for example 14:30.' },
    { key: 'vehicleType', label: 'Vehicle type', control: 'text', required: true, max: L.vehicleType, hint: 'For example sedan or tempo traveller.', autoCapitalize: 'sentences' },
    { key: 'passengers', label: 'Passengers', control: 'number', required: true, min: L.passengers.min, max: L.passengers.max },
    { key: 'notes', label: 'Notes for Purchase', control: 'textarea', required: false, max: L.notes, wide: true, autoCapitalize: 'sentences' },
  ],
  activity: [
    { key: 'name', label: 'Activity name', control: 'text', required: true, max: L.activityName, autoCapitalize: 'sentences' },
    { key: 'city', label: 'City', control: 'text', required: true, max: L.city, autoCapitalize: 'words' },
    { key: 'date', label: 'Date', control: 'date', required: true },
    { key: 'time', label: 'Time', control: 'time', required: false, hint: '24-hour clock, for example 09:00.' },
    { key: 'participants', label: 'Participants', control: 'number', required: true, min: L.passengers.min, max: L.passengers.max },
    { key: 'notes', label: 'Notes for Purchase', control: 'textarea', required: false, max: L.notes, wide: true, autoCapitalize: 'sentences' },
  ],
  flight: [
    { key: 'passengers', label: 'Passengers', control: 'number', required: true, min: L.passengers.min, max: L.passengers.max },
    { key: 'preferredTime', label: 'Preferred time', control: 'text', required: false, max: L.preferredTime, hint: 'For example morning departure.', autoCapitalize: 'sentences' },
    { key: 'cabin', label: 'Cabin', control: 'text', required: false, max: L.cabin, hint: 'For example economy.', autoCapitalize: 'sentences' },
    { key: 'notes', label: 'Notes for the Flight team', control: 'textarea', required: false, max: L.notes, wide: true, autoCapitalize: 'sentences' },
  ],
  // B1.1: minimal fallback fields (the Book now form owns the full visa and passport editors).
  visa: [
    { key: 'country', label: 'Destination country', control: 'text', required: true, max: 60, autoCapitalize: 'words' },
    { key: 'purpose', label: 'Purpose', control: 'text', required: true, max: 60, autoCapitalize: 'sentences' },
    { key: 'travelDate', label: 'Planned travel date', control: 'date', required: true },
    { key: 'applyBy', label: 'Apply by', control: 'date', required: false },
    { key: 'feePaidBy', label: 'Government fee paid by', control: 'text', required: true, hint: 'customer, company or not_decided.', autoCapitalize: 'off' },
    { key: 'notes', label: 'Notes for the Visa & Passport desk', control: 'textarea', required: false, max: L.notes, wide: true, autoCapitalize: 'sentences' },
  ],
  passport: [
    { key: 'applicationType', label: 'Application type', control: 'text', required: true, hint: 'fresh, renewal, tatkaal or minor.', autoCapitalize: 'off' },
    { key: 'officeCity', label: 'Passport office city', control: 'text', required: true, max: 120, autoCapitalize: 'words' },
    { key: 'neededBy', label: 'Needed by', control: 'date', required: false },
    { key: 'notes', label: 'Notes for the Visa & Passport desk', control: 'textarea', required: false, max: L.notes, wide: true, autoCapitalize: 'sentences' },
  ],
};

export const SEGMENT_LABELS = { from: 'From (airport code)', to: 'To (airport code)', date: 'Date' } as const;
export const SEGMENT_CODE_HINT = 'Three capital letters, for example DEL.';
export { MAX_FLIGHT_SEGMENTS };

/** Form values of one service item: every fact key as a string, plus the budget in rupees. */
export type FactValues = Record<string, string>;
export interface SegmentValues {
  from: string;
  to: string;
  date: string;
}

const s = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/** Facts → form values (strings), so controlled inputs can keep what was typed. */
export function factsToValues(facts: ServiceFacts | null, type: ServiceType): FactValues {
  const values: FactValues = {};
  for (const def of FACT_FIELDS[type]) values[def.key] = '';
  if (facts && facts.type === type && facts.type !== 'flight') {
    const raw = facts.facts as unknown as Record<string, string | number | null | undefined>;
    for (const def of FACT_FIELDS[type]) values[def.key] = s(raw[def.key]);
  } else if (facts && facts.type === 'flight' && type === 'flight') {
    values.passengers = s(facts.facts.passengers);
    values.preferredTime = s(facts.facts.preferredTime);
    values.cabin = s(facts.facts.cabin);
    values.notes = s(facts.facts.notes);
  }
  return values;
}

export function factsToSegments(facts: ServiceFacts | null): SegmentValues[] {
  if (facts?.type === 'flight' && facts.facts.segments.length > 0) {
    return facts.facts.segments.map((seg) => ({ from: seg.from, to: seg.to, date: seg.date }));
  }
  return [{ from: '', to: '', date: '' }];
}

/** Paise string → rupees input ("4500000" → "45000.00"); mirrors forms.ts paiseToRupeesInput without importing it. */
export function paiseToRupees(paise: string | null | undefined): string {
  if (paise == null || !/^\d+$/.test(paise)) return '';
  const value = BigInt(paise);
  return `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, '0')}`;
}

export interface FieldProblem {
  key: string;
  label: string;
  text: string;
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IATA_RE = /^[A-Z]{3}$/;

/**
 * Light client-side check of one service's typed values, run only to NAME
 * the fields after the server refused with invalid_input (the database is
 * the validator; this only points at what it most likely rejected).
 */
export function factProblems(type: ServiceType, values: FactValues, segments: SegmentValues[] = []): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const def of FACT_FIELDS[type]) {
    const value = (values[def.key] ?? '').trim();
    if (value === '') {
      if (def.required) problems.push({ key: def.key, label: def.label, text: `Add ${def.label.toLowerCase()}.` });
      continue;
    }
    if (def.control === 'number') {
      const n = Number(value);
      if (!/^\d{1,4}$/.test(value) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        problems.push({ key: def.key, label: def.label, text: `${def.label} must be a whole number${def.min !== undefined && def.max !== undefined ? ` from ${def.min} to ${def.max}` : ''}.` });
      }
    } else if (def.control === 'date') {
      if (!DATE_RE.test(value)) problems.push({ key: def.key, label: def.label, text: `${def.label} must be a valid date.` });
    } else if (def.control === 'time') {
      if (!TIME_RE.test(value)) problems.push({ key: def.key, label: def.label, text: `${def.label} must be a 24-hour time such as 14:30.` });
    } else if (def.max !== undefined && value.length > def.max) {
      problems.push({ key: def.key, label: def.label, text: `${def.label} is longer than ${def.max} characters.` });
    }
  }
  if (type === 'hotel' && values.checkIn && values.checkOut && DATE_RE.test(values.checkIn) && DATE_RE.test(values.checkOut) && values.checkOut <= values.checkIn) {
    problems.push({ key: 'checkOut', label: 'Check-out date', text: 'Check-out must be after check-in.' });
  }
  if (type === 'flight') {
    if (segments.length === 0) problems.push({ key: 'segment-0-from', label: 'Segments', text: 'Add at least one flight segment.' });
    segments.forEach((seg, i) => {
      const n = i + 1;
      if (!IATA_RE.test(seg.from.trim().toUpperCase())) problems.push({ key: `segment-${i}-from`, label: `Segment ${n} from`, text: `Segment ${n}: ${SEGMENT_CODE_HINT}` });
      if (!IATA_RE.test(seg.to.trim().toUpperCase())) problems.push({ key: `segment-${i}-to`, label: `Segment ${n} to`, text: `Segment ${n}: ${SEGMENT_CODE_HINT}` });
      if (!DATE_RE.test(seg.date)) problems.push({ key: `segment-${i}-date`, label: `Segment ${n} date`, text: `Segment ${n}: add the date.` });
      else if (i > 0 && DATE_RE.test(segments[i - 1]!.date) && seg.date < segments[i - 1]!.date) {
        problems.push({ key: `segment-${i}-date`, label: `Segment ${n} date`, text: `Segment ${n} cannot be before segment ${i}.` });
      }
    });
  }
  const budget = (values.purchaseBudgetRupees ?? '').replace(/[,\s]/g, '').replace(/^₹/, '');
  if (budget !== '' && !/^\d{1,15}(?:\.\d{1,2})?$/.test(budget)) {
    problems.push({ key: 'purchaseBudgetRupees', label: 'Approved Purchase budget', text: 'The budget must be rupees with at most two decimals.' });
  }
  return problems;
}

/**
 * Maps the field names an action refused (`fields` in BookingActionResult,
 * freeze note §5; flight rows as `segmentFrom[1]`) to the form's own keys and
 * labels, so the exact inputs are marked and linked.
 */
export function problemsFromFields(type: ServiceType, fields: string[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const seen = new Set<string>();
  const push = (p: FieldProblem) => {
    if (!seen.has(p.key)) {
      seen.add(p.key);
      problems.push(p);
    }
  };
  for (const field of fields) {
    const segment = /^segment(From|To|Date)(?:\[(\d+)\])?$/.exec(field);
    if (segment) {
      const part = segment[1] === 'From' ? 'from' : segment[1] === 'To' ? 'to' : 'date';
      const index = segment[2] === undefined ? 0 : Number(segment[2]);
      const n = index + 1;
      push({ key: `segment-${index}-${part}`, label: `Segment ${n} ${part}`, text: part === 'date' ? `Segment ${n}: add a valid date, not before the segment above.` : `Segment ${n}: ${SEGMENT_CODE_HINT}` });
      continue;
    }
    if (field === 'purchaseBudgetRupees') {
      push({ key: field, label: 'Approved Purchase budget', text: 'The budget must be rupees with at most two decimals.' });
      continue;
    }
    if (field === 'serviceType') {
      push({ key: field, label: 'Service type', text: 'Choose a service type that is handled in the CRM.' });
      continue;
    }
    const def = FACT_FIELDS[type].find((d) => d.key === field);
    if (def) push({ key: def.key, label: def.label, text: `Check ${def.label.toLowerCase()}.` });
    // Identifiers (dealId, versionId, rowVersion, itemId, requestId) have no input to mark: the message covers them.
  }
  return problems;
}

export function travellerProblemsFromFields(fields: string[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const field of fields) {
    const m = /^traveller(Name|Type)(?:\[(\d+)\])?$/.exec(field);
    if (!m) continue;
    const i = m[2] === undefined ? 0 : Number(m[2]);
    const key = `traveller-${i}-${m[1] === 'Name' ? 'name' : 'type'}`;
    if (problems.some((p) => p.key === key)) continue;
    problems.push({ key, label: `Traveller ${i + 1}`, text: m[1] === 'Name' ? `Traveller ${i + 1}: add the full name (up to 120 characters).` : `Traveller ${i + 1}: choose adult, child or infant.` });
  }
  return problems;
}

export interface TravellerRow {
  fullName: string;
  type: TravellerType;
}

export function travellersToRows(travellers: Traveller[]): TravellerRow[] {
  return [...travellers].sort((a, b) => a.seq - b.seq).map((t) => ({ fullName: t.fullName, type: t.type }));
}

export function travellerProblems(rows: TravellerRow[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  rows.forEach((row, i) => {
    const name = row.fullName.trim();
    if (name === '') problems.push({ key: `traveller-${i}-name`, label: `Traveller ${i + 1}`, text: `Traveller ${i + 1}: add the full name.` });
    else if (name.length > 120) problems.push({ key: `traveller-${i}-name`, label: `Traveller ${i + 1}`, text: `Traveller ${i + 1}: the name is longer than 120 characters.` });
  });
  return problems;
}

/** The largest head-count any service needs (contract §9: adults + children, passengers, participants). */
export function travellersNeeded(items: Array<Pick<ServiceItemView, 'facts'>>): number {
  let needed = 0;
  for (const item of items) {
    const f = item.facts;
    const n =
      f.type === 'hotel'
        ? (f.facts.adults ?? 0) + (f.facts.children ?? 0)
        : f.type === 'transfer' || f.type === 'flight'
          ? (f.facts.passengers ?? 0)
          : f.type === 'activity'
            ? f.facts.participants
            : 0;
    if (n > needed) needed = n;
  }
  return needed;
}

/** Items that will get a task when the accepted version is saved (planned, no task yet, not on hold). */
export function plannedTaskCount(items: Array<Pick<ServiceItemView, 'state' | 'task'>>): number {
  return items.filter((i) => i.state === 'planned' && !i.task).length;
}

export function taskNoun(count: number): string {
  return count === 1 ? 'task' : 'tasks';
}

/** The confirm dialog lines with the counts filled in. */
export function confirmDialogLines(versionNo: number, taskCount: number): string[] {
  return INTAKE_CONFIRM_DIALOG_TEXT.body.map((line) =>
    line.replace('{versionNo}', String(versionNo)).replace('{taskCount}', String(taskCount)).replace('{taskNoun}', taskNoun(taskCount)),
  );
}

export function confirmSuccessText(taskCount: number): string {
  return INTAKE_CONFIRM_SUCCESS_TEXT.replace('{taskCount}', String(taskCount)).replace('{taskNoun}', taskNoun(taskCount));
}

export interface ChecklistGroups {
  blocking: IntakeChecklistItem[];
  warnings: IntakeChecklistItem[];
}

export function splitChecklist(checklist: IntakeChecklist): ChecklistGroups {
  return {
    blocking: checklist.items.filter((i) => i.blocking),
    warnings: checklist.items.filter((i) => !i.blocking),
  };
}

export function checklistItemText(item: IntakeChecklistItem): string {
  const base = CHECKLIST_TEXT[item.code];
  if (item.itemNos.length === 0) return base;
  return `${base} (${item.itemNos.length === 1 ? 'service' : 'services'} ${item.itemNos.join(', ')})`;
}

export const CHECKLIST_OWNER_LABEL = {
  sales: 'Sales fixes this',
  bitrix: 'Bitrix (stage)',
  accounts: 'Accounts checks this',
  admin: 'An admin switches this on',
} as const;

/** Overall state word of the intake screen (status pill in the header). */
export type IntakeStage = 'not_started' | 'needs_details' | 'ready' | 'created';

export function intakeStage(input: {
  version: { status: 'draft' | 'confirmed' } | null;
  itemCount: number;
  blockingCount: number;
  canConfirm: boolean;
}): IntakeStage {
  if (input.version?.status === 'confirmed') return 'created';
  if (!input.version || input.itemCount === 0) return 'not_started';
  if (input.blockingCount > 0 || !input.canConfirm) return 'needs_details';
  return 'ready';
}

export const INTAKE_STAGE_LABEL: Record<IntakeStage, string> = {
  not_started: 'Not started · no services yet',
  needs_details: 'Draft · needs details',
  ready: 'Draft · ready to save',
  created: 'Accepted version saved · tasks created',
};
