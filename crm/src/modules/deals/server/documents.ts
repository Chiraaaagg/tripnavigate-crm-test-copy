import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { toDealDocumentViews, type DealDocumentView } from '../documents';

/**
 * Direction A Batch 1 B1-2: the Deal Documents tab read, under the staff
 * member's own session; call it only when the tab is open (Deal page speed).
 *
 *   ok             the files the viewer may open (possibly none: "No files you
 *                  can open on this deal yet")
 *   error          "Documents could not be loaded. Nothing was changed." (never
 *                  "No documents")
 *   not_installed  a database without the function: hide the tab
 *
 * A Deal the viewer cannot read, an unknown id and a removed Deal all answer
 * ok with no files; the page's own Deal read decides "not available".
 */

export type DealDocumentsResult =
  | { state: 'ok'; files: DealDocumentView[] }
  | { state: 'error' }
  | { state: 'not_installed' };

const FUNCTION_MISSING = new Set(['PGRST202', '42883']);

type Staff = Pick<StaffContext, 'supabase'>;
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };

export async function loadDealDocuments(staff: Staff, dealId: string): Promise<DealDocumentsResult> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return { state: 'ok', files: [] };
  try {
    const client = staff.supabase as unknown as Rpc;
    const { data, error } = await client.rpc('deal_documents_list', { p_deal_id: id.data });
    if (error) return FUNCTION_MISSING.has(error.code ?? '') ? { state: 'not_installed' } : { state: 'error' };
    const files = toDealDocumentViews(data);
    return files ? { state: 'ok', files } : { state: 'error' };
  } catch {
    return { state: 'error' };
  }
}
