import { DB_PDF_STATES, DOCUMENT_KINDS, DOCUMENT_STATUSES } from '@/modules/customer-documents/contracts';
import { AUTO_STATES, type AutoState, type DocsFilter } from './types';

/*
 * Accounts › Customer documents address (contract 6.9 R-B3, screen 11.2):
 * an allowlist parse of the query string into the read's filter, and the
 * reverse, so every filter lives in the address (back button, shareable,
 * no script). Pure.
 */

type Query = Record<string, string | string[] | undefined>;

const one = (q: Query, k: string): string | undefined => {
  const v = q[k];
  return typeof v === 'string' && v.length <= 80 ? v : undefined;
};
const yes = (q: Query, k: string): boolean | undefined => (one(q, k) === '1' ? true : one(q, k) === '0' ? false : undefined);
const date = (q: Query, k: string): string | undefined => {
  const v = one(q, k);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
};
const uuid = (v: string | undefined) => (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);

export function parseDocFilter(q: Query): { filter: DocsFilter; after: string | null } {
  const status = one(q, 'status');
  const kind = one(q, 'kind');
  const pdf = one(q, 'pdf');
  const ref = one(q, 'deal')?.trim();
  const filter: DocsFilter = {};
  if (status && (DOCUMENT_STATUSES as readonly string[]).includes(status)) filter.status = [status as (typeof DOCUMENT_STATUSES)[number]];
  if (kind && (DOCUMENT_KINDS as readonly string[]).includes(kind)) filter.kind = [kind as (typeof DOCUMENT_KINDS)[number]];
  if (pdf && (DB_PDF_STATES as readonly string[]).includes(pdf)) filter.pdfState = pdf as (typeof DB_PDF_STATES)[number];
  if (ref && /^[A-Za-z0-9._/-]{1,40}$/.test(ref)) filter.dealReference = ref;
  const stale = yes(q, 'stale');
  if (stale !== undefined) filter.stale = stale;
  const changed = yes(q, 'changed');
  if (changed) filter.bookingChanged = true;
  const reversed = yes(q, 'reversed');
  if (reversed) filter.paymentReversed = true;
  const tally = yes(q, 'tally');
  if (tally !== undefined) filter.tallyLinked = tally;
  if (yes(q, 'toRelease')) filter.toRelease = true;
  if (yes(q, 'toCheck') || one(q, 'preset') === 'toCheck') filter.preset = 'toCheck';
  const auto = one(q, 'auto');
  if (auto && (AUTO_STATES as readonly string[]).includes(auto)) filter.autoState = auto as AutoState;
  const from = date(q, 'from');
  if (from) filter.from = from;
  const to = date(q, 'to');
  if (to) filter.to = to;
  const branch = uuid(one(q, 'branch'));
  if (branch) filter.branchId = branch;
  const after = one(q, 'after');
  return { filter, after: after && /^[0-9T:.+Z -]{10,40}\|[0-9a-f-]{36}$/i.test(after) ? after : null };
}

export function docFilterQuery(f: DocsFilter, after?: string | null): string {
  const p = new URLSearchParams();
  if (f.preset === 'toCheck') p.set('preset', 'toCheck');
  if (f.toRelease) p.set('toRelease', '1');
  if (f.autoState) p.set('auto', f.autoState);
  if (f.status?.[0]) p.set('status', f.status[0]);
  if (f.kind?.[0]) p.set('kind', f.kind[0]);
  if (f.pdfState) p.set('pdf', f.pdfState);
  if (f.stale !== undefined) p.set('stale', f.stale ? '1' : '0');
  if (f.bookingChanged) p.set('changed', '1');
  if (f.paymentReversed) p.set('reversed', '1');
  if (f.tallyLinked !== undefined) p.set('tally', f.tallyLinked ? '1' : '0');
  if (f.dealReference) p.set('deal', f.dealReference);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.branchId) p.set('branch', f.branchId);
  if (after) p.set('after', after);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const DOCS_PATH = '/app/accounts/documents';
/** Accounts › Bills to check (held automatic drafts). */
export const BILLS_TO_CHECK_PATH = `${DOCS_PATH}?preset=toCheck`;

export function isEmptyFilter(f: DocsFilter): boolean {
  return docFilterQuery(f) === '';
}
