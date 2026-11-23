import 'server-only';
import { z } from 'zod';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { CustomerDocumentContent } from '@/modules/customer-documents/content';
import { customerJobContent, customerRenderInput, type CustomerRenderRpc } from '../render/customer-job-input';
import { PDF_RENDER_ONLINE_ENV, PRINT_DOCUMENT_ELEMENT_ID, PRINT_TOKEN_HEADER, verifyPrintToken } from '../render/print-token';

/**
 * Accounts phase 2 (contract 6.8): data of the in-app print page
 * /print/customer-document/<job> that the online PDF maker opens (page file
 * owned by Track E: S/app/print/customer-document/[jobId]/page.tsx renders
 * <CustomerDocumentTemplate content={…} id={CUSTOMER_PRINT_ELEMENT_ID} />
 * inside <main id="main" className="tn-print">, nothing else visible).
 *
 * Same rule as the itinerary print page: only while PDF_RENDER_ONLINE is
 * "on", only with a genuine unexpired token for this job in the
 * x-tn-print-token request header, and only while the worker named in the
 * token still holds the job's lease (checked by customer_document_render_input).
 * Every refusal is null (the page answers 404 without a reason). The content
 * is the frozen released content, checked (shape, forbidden keys, safety
 * scan). Nothing is logged.
 */

export const CUSTOMER_PRINT_ELEMENT_ID = PRINT_DOCUMENT_ELEMENT_ID;
export const CUSTOMER_PRINT_TOKEN_HEADER = PRINT_TOKEN_HEADER;

export async function loadCustomerPrintContent(jobId: string, token: string | null, nowMs: number = Date.now()): Promise<CustomerDocumentContent | null> {
  if (process.env[PDF_RENDER_ONLINE_ENV] !== 'on') return null;
  if (!z.uuid().safeParse(jobId).success) return null;
  const link = verifyPrintToken(token, jobId, process.env.RENDER_PRINT_TOKEN_SECRET, nowMs);
  if (!link) return null;
  try {
    const input = await customerRenderInput(createSupabaseAdminClient() as unknown as CustomerRenderRpc, jobId, link.w);
    if (input.status !== 'running') return null;
    const checked = customerJobContent(input);
    return checked.ok ? checked.content : null;
  } catch {
    return null;
  }
}
