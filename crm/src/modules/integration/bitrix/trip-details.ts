/**
 * Voice-note batch (24 October 2026), migration 20261128000100: the read-only
 * Bitrix Deal trip details the sync stores while
 * integration_intake_config.bitrix_trip_details_read is on.
 *
 * Owner answer 3 (24 October 2026): destination = the single choice
 * UF_CRM_6876462911034, else the FIRST value of the multiple choice
 * UF_CRM_6A9BD81EA7CCF; adults / children / infants = UF_CRM_68A83F913F4EF /
 * UF_CRM_68A83F91465CD / UF_CRM_68A83F914D169 (Bitrix doubles). Field map:
 * docs/implementation/frontend-first-plan-2026-10-10/b1.2/
 * phase-a-bitrix-and-engines.md sections 2.2 and 2.5.
 *
 * Pure functions: they turn a provider answer into the keys the database
 * command accepts (integration_apply_bitrix_trip_facts) and record an issue
 * CODE (never the value) for a value they cannot read. The database re-checks
 * every key. The destination option NAMES come from crm.deal.fields (already
 * an allowed read method) through the daily name refresh.
 */

export const DEAL_TRIP_DETAIL_CODES = {
  destinationSingle: 'UF_CRM_6876462911034',
  destinationMulti: 'UF_CRM_6A9BD81EA7CCF',
  adults: 'UF_CRM_68A83F913F4EF',
  children: 'UF_CRM_68A83F91465CD',
  infants: 'UF_CRM_68A83F914D169',
} as const;

/** Extra Deal fields selected from crm.deal.list when the switch is on (crm.deal.get returns them anyway). */
export const DEAL_TRIP_DETAIL_FIELDS: readonly string[] = Object.values(DEAL_TRIP_DETAIL_CODES);

/** Name lists of the destination options (bitrix_name_lists.entity_id). */
export const DESTINATION_LISTS = {
  single: 'DEAL_DESTINATION',
  multi: 'DEAL_DESTINATION_MULTI',
} as const;
export type DestinationListId = (typeof DESTINATION_LISTS)[keyof typeof DESTINATION_LISTS];

/** Same list as authz.trip_detail_issue_codes() in the migration. */
export const TRIP_DETAIL_ISSUES = ['adults_unreadable', 'children_unreadable', 'infants_unreadable', 'destination_unreadable'] as const;
export type TripDetailIssue = (typeof TRIP_DETAIL_ISSUES)[number];

export interface DealTripDetails {
  destinationField: 'single' | 'multi' | null;
  destinationOptionId: string | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  detailsIssues: TripDetailIssue[];
}

const ENUM_ID = /^[1-9][0-9]{0,9}$/;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** A Bitrix count (double, e.g. "2.00"): a whole number 0-100, else null with unreadable = true; blank = null. */
export function toCount(value: unknown): { count: number | null; unreadable: boolean } {
  const t = text(value)?.trim() ?? '';
  if (t === '') return { count: null, unreadable: false };
  if (!/^\d{1,6}(\.\d+)?$/.test(t)) return { count: null, unreadable: true };
  const n = Number(t);
  if (!Number.isInteger(n) || n > 100) return { count: null, unreadable: true };
  return { count: n, unreadable: false };
}

/** An enumeration option id ('' / false / 0 = none). */
function toOption(value: unknown): { id: string | null; unreadable: boolean } {
  if (value === null || value === undefined || value === false) return { id: null, unreadable: false };
  const t = text(value)?.trim() ?? '';
  if (t === '' || t === '0') return { id: null, unreadable: false };
  return ENUM_ID.test(t) ? { id: t, unreadable: false } : { id: null, unreadable: true };
}

/**
 * The destination: the single choice first, else the first readable value of
 * the multiple choice (Bitrix answers an array, or false / '' when empty).
 */
export function toDestination(raw: Record<string, unknown>): { field: 'single' | 'multi' | null; optionId: string | null; unreadable: boolean } {
  const single = toOption(raw[DEAL_TRIP_DETAIL_CODES.destinationSingle]);
  if (single.id) return { field: 'single', optionId: single.id, unreadable: false };
  const multiRaw = raw[DEAL_TRIP_DETAIL_CODES.destinationMulti];
  const values = Array.isArray(multiRaw) ? multiRaw : multiRaw === undefined ? [] : [multiRaw];
  let unreadable = single.unreadable;
  for (const v of values) {
    const o = toOption(v);
    if (o.id) return { field: 'multi', optionId: o.id, unreadable: false };
    unreadable = unreadable || o.unreadable;
  }
  return { field: null, optionId: null, unreadable };
}

/** From a crm.deal.get record (or a crm.deal.list row selected with DEAL_TRIP_DETAIL_FIELDS). */
export function toDealTripDetails(raw: Record<string, unknown>): DealTripDetails {
  const issues: TripDetailIssue[] = [];
  const dest = toDestination(raw);
  if (dest.unreadable) issues.push('destination_unreadable');
  const adults = toCount(raw[DEAL_TRIP_DETAIL_CODES.adults]);
  if (adults.unreadable) issues.push('adults_unreadable');
  const children = toCount(raw[DEAL_TRIP_DETAIL_CODES.children]);
  if (children.unreadable) issues.push('children_unreadable');
  const infants = toCount(raw[DEAL_TRIP_DETAIL_CODES.infants]);
  if (infants.unreadable) issues.push('infants_unreadable');
  return {
    destinationField: dest.field,
    destinationOptionId: dest.optionId,
    adults: adults.count,
    children: children.count,
    infants: infants.count,
    detailsIssues: [...new Set(issues)].sort(),
  };
}

export interface DestinationNameItem {
  code: string;
  name: string;
  sort: number;
}
export interface DestinationNameList {
  entityId: DestinationListId;
  items: DestinationNameItem[];
}

/** At most this many options per list (the database accepts 1-500). */
export const DESTINATION_LIST_MAX_ITEMS = 500;

/**
 * crm.deal.fields answer -> the two destination name lists. Each enumeration
 * field carries items [{ID, VALUE, SORT?}]; only ID, VALUE and SORT are kept.
 * A field that is missing or has no readable item gives no list (never "every
 * option is gone").
 */
export function parseDestinationOptions(fields: unknown): DestinationNameList[] {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const out: DestinationNameList[] = [];
  const pairs: Array<[string, DestinationListId]> = [
    [DEAL_TRIP_DETAIL_CODES.destinationSingle, DESTINATION_LISTS.single],
    [DEAL_TRIP_DETAIL_CODES.destinationMulti, DESTINATION_LISTS.multi],
  ];
  for (const [code, entityId] of pairs) {
    const field = (fields as Record<string, unknown>)[code];
    const items = field && typeof field === 'object' ? (field as Record<string, unknown>).items : undefined;
    if (!Array.isArray(items)) continue;
    const seen = new Set<string>();
    const list: DestinationNameItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = toOption((item as Record<string, unknown>).ID).id;
      const name = (text((item as Record<string, unknown>).VALUE) ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 120).trim();
      if (!id || name === '' || seen.has(id)) continue;
      seen.add(id);
      const sortRaw = Number(text((item as Record<string, unknown>).SORT) ?? '0');
      list.push({ code: id, name, sort: Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 0 });
      if (list.length >= DESTINATION_LIST_MAX_ITEMS) break;
    }
    if (list.length > 0) out.push({ entityId, items: list });
  }
  return out;
}
