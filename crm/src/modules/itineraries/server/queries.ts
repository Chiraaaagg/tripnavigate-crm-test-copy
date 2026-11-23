import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { isItineraryFunctionMissing, ItineraryCommandError, itineraryDocumentGet, itineraryDocumentList } from '../commands';
import type { ItineraryEditorView, ItineraryListView, ItinerarySubjectKind } from '../contracts';
import { toItineraryEditorView, toItineraryListView } from '../dto';

/**
 * Itinerary reads for the editor screens, under the viewer's own session.
 * null = not visible / not an editor (the same answer for everyone else);
 * 'not_installed' without the 0500 functions; anything unexplained throws a
 * retry message. The customer-document view for rendering is Nova's
 * loadItineraryDocumentView (documents module); this is the editor's read.
 */

type Staff = Pick<StaffContext, 'supabase'>;
export const ITINERARIES_NOT_INSTALLED = 'not_installed' as const;
type Load<T> = Promise<T | null | typeof ITINERARIES_NOT_INSTALLED>;
const RETRY = 'Could not load the itinerary. Please retry.';

function refused(error: unknown): boolean {
  return error instanceof ItineraryCommandError && (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'deal_removed');
}

async function list(staff: Staff, kind: ItinerarySubjectKind, subjectId: string): Load<ItineraryListView> {
  const id = z.uuid().safeParse(subjectId);
  if (!id.success) return null;
  try {
    const rows = await itineraryDocumentList(asRpcClient(staff.supabase), kind, id.data);
    return rows ? toItineraryListView(kind, id.data, rows) : null;
  } catch (error) {
    if (isItineraryFunctionMissing(error)) return ITINERARIES_NOT_INSTALLED;
    if (refused(error)) return null;
    throw new Error(RETRY);
  }
}

export function loadItinerariesForQuotation(staff: Staff, quotationId: string): Load<ItineraryListView> {
  return list(staff, 'quotation', quotationId);
}

export function loadItinerariesForDeal(staff: Staff, dealId: string): Load<ItineraryListView> {
  return list(staff, 'deal', dealId);
}

export async function loadItineraryEditor(staff: Staff, documentId: string): Load<ItineraryEditorView> {
  const id = z.uuid().safeParse(documentId);
  if (!id.success) return null;
  try {
    const record = await itineraryDocumentGet(asRpcClient(staff.supabase), id.data);
    return record ? toItineraryEditorView(record) : null;
  } catch (error) {
    if (isItineraryFunctionMissing(error)) return ITINERARIES_NOT_INSTALLED;
    if (refused(error)) return null;
    throw new Error(RETRY);
  }
}
