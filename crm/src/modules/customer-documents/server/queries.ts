import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { PDF_RENDER_ONLINE_ENV } from '@/modules/documents/render/print-token';
import { readDealDocuments, readDocument, readDocumentList, readSettings } from '../commands';
import type { PdfState } from '../contracts';
import { screenPdfState, type DealDocuments, type DocumentDetail, type DocumentList, type DocumentListFilter } from '../dto';

/**
 * Customer document reads for pages (contract 6.9), under the staff member's
 * OWN session (the database fences every read: Accounts, branch Manager,
 * Sales owner; null for everyone else). The screen PDF state "off" is added
 * here (queued while the online PDF maker is switched off, contract 6.6).
 */

export const onlinePdfMakerOn = (): boolean => process.env[PDF_RENDER_ONLINE_ENV] === 'on';

type WithScreenPdf<T> = T & { screenPdf: PdfState };

export async function loadDealDocuments(staff: StaffContext, dealId: string): Promise<(Omit<DealDocuments, 'documents'> & {
  documents: Array<WithScreenPdf<DealDocuments['documents'][number]>>;
}) | null> {
  const view = await readDealDocuments(asRpcClient(staff.supabase), dealId);
  if (!view) return null;
  const on = onlinePdfMakerOn();
  return { ...view, documents: view.documents.map((d) => ({ ...d, screenPdf: screenPdfState(d.pdf.state, on) })) };
}

/** One document with its frozen content (draft preview for Accounts; print view for released documents). */
export async function loadDocument(staff: StaffContext, documentId: string): Promise<WithScreenPdf<DocumentDetail> | null> {
  const doc = await readDocument(asRpcClient(staff.supabase), documentId);
  return doc ? { ...doc, screenPdf: screenPdfState(doc.pdf.state, onlinePdfMakerOn()) } : null;
}

export async function loadDocumentList(staff: StaffContext, filter: DocumentListFilter, after: string | null, limit = 50): Promise<(Omit<DocumentList, 'items'> & {
  items: Array<WithScreenPdf<DocumentList['items'][number]>>;
}) | null> {
  const page = await readDocumentList(asRpcClient(staff.supabase), filter, after, limit);
  if (!page) return null;
  const on = onlinePdfMakerOn();
  return { ...page, items: page.items.map((d) => ({ ...d, screenPdf: screenPdfState(d.pdf.state, on) })) };
}

/** Both Phase 2 switches for the settings screen (policy managers only; null otherwise). */
export function loadDocumentSettings(staff: StaffContext, entityId: string) {
  return readSettings(asRpcClient(staff.supabase), entityId);
}
