import 'server-only';
import { z } from 'zod';
import { holdsPurchaseAnywhere } from '@/modules/access/policy';
import type { StaffContext } from '@/modules/identity/server/session';
import type { FactDifference, ItineraryDocumentView } from '../contracts';
export type { SaveableDifference } from '../value-hash';
import { toSaveableDifferences, type SaveableDifference } from '../value-hash';
import { compareTripFactsDetailed, differenceKey, type DetailedComparison } from '../facts-diff';
import { BOOK_NOW_NOT_INSTALLED, loadBookNow } from '@/modules/fulfilment/server/book-now';
import {
  ItineraryDocumentGetSchema,
  basisFactsFromBooking,
  basisFactsFromQuotation,
  toItineraryDocumentView,
  toItineraryFactsDraft,
  type ItineraryDocumentGet,
} from '../itinerary-view';
import { QuotationGetSchema } from '../quotation-view';
import { istDate } from './load-quotation-view';

/**
 * Itinerary reads under the staff member's own session (Atlas 0500:
 * itinerary_document_get returns null to anyone but an editor of the
 * quotation or Deal; Purchase is refused before any query). No privileged
 * client here: the render worker commands are the only service-role calls and
 * live in the worker.
 */

type DocStaff = Pick<StaffContext, 'access' | 'supabase'>;
async function readDocument(staff: DocStaff, documentId: string): Promise<{ status: 'ok'; doc: ItineraryDocumentGet } | { status: 'not_found' | 'error' }> {
  if (!z.uuid().safeParse(documentId).success || holdsPurchaseAnywhere(staff.access)) return { status: 'not_found' };
  const { data, error } = await staff.supabase.rpc('itinerary_document_get', { p_document_id: documentId });
  if (error) return error.code === '42501' ? { status: 'not_found' } : { status: 'error' };
  if (data === null || data === undefined) return { status: 'not_found' };
  const parsed = ItineraryDocumentGetSchema.safeParse(data);
  return parsed.success ? { status: 'ok', doc: parsed.data } : { status: 'error' };
}

export type ItineraryViewLoad =
  | { status: 'ok'; view: ItineraryDocumentView; draftStatus: string; differencesOpen: number; differencesCurrent: boolean }
  | { status: 'not_found' }
  | { status: 'error' };

export async function loadItineraryDocumentView(staff: DocStaff, documentId: string, now: Date = new Date()): Promise<ItineraryViewLoad> {
  const read = await readDocument(staff, documentId);
  if (read.status !== 'ok') return read;
  const items = read.doc.differences?.items ?? [];
  return {
    status: 'ok',
    view: toItineraryDocumentView(read.doc, { today: istDate(now) }),
    draftStatus: read.doc.draft.status,
    differencesOpen: items.filter((d) => !d.acknowledged).length,
    differencesCurrent: read.doc.differences?.current ?? false,
  };
}

function withHashes(c: DetailedComparison): { differences: SaveableDifference[]; basisValues: Record<string, unknown> } {
  return { differences: toSaveableDifferences(c), basisValues: Object.fromEntries(c.basisValues) };
}

export type ItineraryDifferencesResult =
  | {
      status: 'ok';
      draftId: string;
      rowVersion: number;
      basisKind: 'quotation_version' | 'booking_version' | 'none';
      basisId: string | null;
      basisHash: string;
      /**
       * Exactly what `itinerary_differences_save` takes: path, kind and the two
       * value hashes (Atlas E3-9: an acknowledgement carries over to a new run
       * only when both hashes are unchanged). Never a value.
       */
      differences: SaveableDifference[];
      /**
       * Server-side only, never stored or sent to the database: the basis
       * (quotation or booking) value behind each difference, for "Use
       * quotation value". Keyed by `differenceKey` (`${kind}:${path}`, since
       * one path can carry two kinds): read it with `basisValueAt`, not by
       * path. null for `extra`.
       */
      basisValues: Record<string, unknown>;
    }
  | { status: 'basis_changed' }
  | { status: 'not_found' }
  | { status: 'error' };

/**
 * Computes the factual differences of the document's draft against its
 * current basis, ready for Atlas `itinerary_differences_save` (the caller's
 * action sends exactly basisKind / basisId / basisHash / differences). A
 * quotation basis is read with `quotation_get`; a booking basis with Terra's
 * `loadBookNow` (read-only), and must be the same working version Atlas named
 * (else `basis_changed`: re-read and compare again). A basis of `none` has no
 * differences.
 */
export async function computeItineraryDifferences(staff: DocStaff, documentId: string): Promise<ItineraryDifferencesResult> {
  const read = await readDocument(staff, documentId);
  if (read.status !== 'ok') return read;
  const { draft, basis } = read.doc;
  const base = { status: 'ok' as const, draftId: draft.draftId, rowVersion: draft.rowVersion, basisKind: basis.kind, basisId: basis.id, basisHash: basis.hash };
  if (basis.kind === 'none') return { ...base, differences: [], basisValues: {} };
  if (!basis.id) return { status: 'basis_changed' };
  if (basis.kind === 'booking_version') {
    const dealId = read.doc.subject.dealId;
    if (!dealId) return { status: 'basis_changed' };
    let book: Awaited<ReturnType<typeof loadBookNow>>;
    try {
      book = await loadBookNow(staff, dealId);
    } catch {
      return { status: 'error' };
    }
    if (book === null || book === BOOK_NOW_NOT_INSTALLED) return { status: 'not_found' };
    if (book.version?.versionId !== basis.id) return { status: 'basis_changed' };
    return { ...base, ...withHashes(compareTripFactsDetailed(basisFactsFromBooking(book), toItineraryFactsDraft(draft))) };
  }
  const { data, error } = await staff.supabase.rpc('quotation_get', { p_version_id: basis.id });
  if (error) return error.code === '42501' ? { status: 'not_found' } : { status: 'error' };
  if (data === null || data === undefined) return { status: 'not_found' };
  const q = QuotationGetSchema.safeParse(data);
  if (!q.success) return { status: 'error' };
  return { ...base, ...withHashes(compareTripFactsDetailed(basisFactsFromQuotation(q.data), toItineraryFactsDraft(draft))) };
}

/**
 * The quotation/booking value behind one difference of a computed result
 * (undefined when the difference is not part of that result; null for
 * `extra`, where using the basis value means removing the item). Server-side
 * only: callers copy it into the facts and save them with
 * `itinerary_facts_save`; it is never logged or sent elsewhere.
 */
export function basisValueAt(result: Extract<ItineraryDifferencesResult, { status: 'ok' }>, difference: FactDifference): unknown {
  const key = differenceKey(difference);
  return Object.prototype.hasOwnProperty.call(result.basisValues, key) ? result.basisValues[key] : undefined;
}
