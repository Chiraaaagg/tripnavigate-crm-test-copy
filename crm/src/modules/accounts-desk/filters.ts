import { maxPaiseForDigits, rupeesToPaise as readRupees } from '@/lib/money';
import {
  DEPARTMENTS,
  DUES_STATUSES,
  type DuesFilter,
  type DuesStatus,
  RECORD_KINDS,
  OVERDUE_CHECKS,
  RECORD_STAGES,
  type RecordKind,
  type RecordsFilter,
  REVIEW_STATUSES,
  TALLY_STATUSES,
} from './contracts';

/**
 * Address bar <-> filter objects (pure). Only allowlisted keys and values
 * survive; anything else is dropped (the database refuses unknown keys, so
 * a hand-edited address never reaches it). Filters stay in the address so a
 * reload or a shared link shows the same list.
 */

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function readList(params: Params, key: string): string[] {
  const raw = params instanceof URLSearchParams ? params.getAll(key) : ([] as string[]).concat(params[key] ?? []);
  return raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(list: readonly T[], value: string | undefined): T | undefined {
  return value !== undefined && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

const FILTER_MAX_PAISE = maxPaiseForDigits(15);

/** Rupees typed in a filter ("1,250.50") -> whole paise string, or undefined (empty or not an amount, by src/lib/money.ts). */
export function rupeesToPaise(value: string | undefined): string | undefined {
  const paise = readRupees(value, { max: FILTER_MAX_PAISE });
  return typeof paise === 'string' ? paise : undefined;
}

export function recordsFilterFromParams(params: Params): RecordsFilter {
  const f: RecordsFilter = {};
  const q = read(params, 'q')?.trim();
  if (q) f.q = q.slice(0, 60);
  const from = read(params, 'from');
  if (from && DATE.test(from)) f.from = from;
  const to = read(params, 'to');
  if (to && DATE.test(to)) f.to = to;
  const kinds = readList(params, 'kinds').filter((k): k is RecordKind => (RECORD_KINDS as readonly string[]).includes(k));
  if (kinds.length) f.kinds = [...new Set(kinds)];
  const department = oneOf(DEPARTMENTS, read(params, 'department'));
  if (department) f.department = department;
  const deal = read(params, 'deal')?.trim();
  if (deal) f.dealReference = deal.slice(0, 60);
  const supplier = read(params, 'supplier');
  if (supplier && UUID.test(supplier)) f.supplierId = supplier.toLowerCase();
  const stage = oneOf(RECORD_STAGES, read(params, 'stage'));
  if (stage) f.stage = stage;
  const review = oneOf(REVIEW_STATUSES, read(params, 'review'));
  if (review) f.reviewStatus = review;
  const tally = oneOf(TALLY_STATUSES, read(params, 'tally'));
  if (tally) f.tallyStatus = tally;
  const changed = read(params, 'changed');
  if (changed === 'yes') f.changedSinceExport = true;
  if (changed === 'no') f.changedSinceExport = false;
  const originals = oneOf(['missing', 'expected', 'any'] as const, read(params, 'originals'));
  if (originals) f.originals = originals;
  const min = rupeesToPaise(read(params, 'min'));
  if (min) f.amountMin = min;
  const max = rupeesToPaise(read(params, 'max'));
  if (max) f.amountMax = max;
  if (f.amountMin && f.amountMax && BigInt(f.amountMin) > BigInt(f.amountMax)) delete f.amountMax;
  const branch = read(params, 'branch');
  if (branch && UUID.test(branch)) f.branchId = branch.toLowerCase();
  const check = oneOf(OVERDUE_CHECKS, read(params, 'check'));
  if (check) f.overdueCheck = check;
  return f;
}

function paiseToRupeesText(paise: string): string {
  const p = paise.padStart(3, '0');
  const rupees = p.slice(0, -2).replace(/^0+(?=\d)/, '');
  const fraction = p.slice(-2);
  return fraction === '00' ? rupees : `${rupees}.${fraction}`;
}

export function recordsFilterToParams(f: RecordsFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.kinds?.length) p.set('kinds', f.kinds.join(','));
  if (f.department) p.set('department', f.department);
  if (f.dealReference) p.set('deal', f.dealReference);
  if (f.supplierId) p.set('supplier', f.supplierId);
  if (f.stage) p.set('stage', f.stage);
  if (f.reviewStatus) p.set('review', f.reviewStatus);
  if (f.tallyStatus) p.set('tally', f.tallyStatus);
  if (f.changedSinceExport !== undefined) p.set('changed', f.changedSinceExport ? 'yes' : 'no');
  if (f.originals) p.set('originals', f.originals);
  if (f.amountMin) p.set('min', paiseToRupeesText(f.amountMin));
  if (f.amountMax) p.set('max', paiseToRupeesText(f.amountMax));
  if (f.branchId) p.set('branch', f.branchId);
  if (f.overdueCheck) p.set('check', f.overdueCheck);
  return p;
}

export function duesFilterFromParams(params: Params): DuesFilter {
  const f: DuesFilter = {};
  const status = readList(params, 'status').filter((s): s is DuesStatus => (DUES_STATUSES as readonly string[]).includes(s));
  if (status.length) f.status = [...new Set(status)];
  const reported = read(params, 'reported');
  if (reported === 'yes') f.reported = true;
  if (reported === 'no') f.reported = false;
  const branch = read(params, 'branch');
  if (branch && UUID.test(branch)) f.branchId = branch.toLowerCase();
  const owner = read(params, 'owner');
  if (owner && UUID.test(owner)) f.ownerUserId = owner.toLowerCase();
  const deal = read(params, 'deal')?.trim();
  if (deal) f.dealReference = deal.slice(0, 60);
  const from = read(params, 'nextFrom');
  if (from && DATE.test(from)) f.nextDueFrom = from;
  const to = read(params, 'nextTo');
  if (to && DATE.test(to)) f.nextDueTo = to;
  return f;
}

export function duesFilterToParams(f: DuesFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status?.length) p.set('status', f.status.join(','));
  if (f.reported !== undefined) p.set('reported', f.reported ? 'yes' : 'no');
  if (f.branchId) p.set('branch', f.branchId);
  if (f.ownerUserId) p.set('owner', f.ownerUserId);
  if (f.dealReference) p.set('deal', f.dealReference);
  if (f.nextDueFrom) p.set('nextFrom', f.nextDueFrom);
  if (f.nextDueTo) p.set('nextTo', f.nextDueTo);
  return p;
}

export type ReferenceType =
  | 'receipt'
  | 'supplier_payment'
  | 'deal'
  | 'ticket_number'
  | 'pnr'
  | 'document_or_reference'
  | 'empty';

/**
 * Mirror of the database's exact-search rules (8.1), for the hint under the
 * search box only; the database decides. PNR is never unique: every Deal
 * carrying it is listed.
 */
export function detectReferenceType(raw: string): ReferenceType {
  const q = raw.trim().toUpperCase();
  if (!q) return 'empty';
  if (q.startsWith('R-')) return 'receipt';
  if (q.startsWith('SP-')) return 'supplier_payment';
  if (/^(BX|SYN)-/.test(q)) return 'deal';
  const digits = q.replace(/-/g, '');
  if (/^[0-9][0-9-]{4,22}[0-9]$/.test(q) && /^\d{6,20}$/.test(digits)) return 'ticket_number';
  if (/^[A-Z0-9]{5,8}$/.test(q)) return 'pnr';
  return 'document_or_reference';
}

export const REFERENCE_TYPE_HINT: Record<ReferenceType, string> = {
  receipt: 'Looking for receipt number',
  supplier_payment: 'Looking for supplier payment number',
  deal: 'Looking for every record of this Deal',
  ticket_number: 'Looking for ticket number',
  pnr: 'Looking for PNR (every Deal with it is listed), bill number or visa reference',
  document_or_reference: 'Looking for supplier bill number, visa reference or GST invoice reference',
  empty: 'Exact match only. Type a full reference.',
};
