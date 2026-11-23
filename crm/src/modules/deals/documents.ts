import { z } from 'zod';

/**
 * Direction A Batch 1 B1-2: the Deal Documents tab (FP-025), from
 * public.deal_documents_list(p_deal_id) (migration 20261121000110). The
 * database lists a file only when the viewer passes that file kind's existing
 * download authorizer, so every row links to a route that will open it.
 * Pure shapes: allowlisted keys only; links are built from kind and id to the
 * existing download routes (never a storage URL).
 */

export const DEAL_DOCUMENT_KINDS = [
  'id_proof',
  'booking_file',
  'quotation_acceptance',
  'itinerary_source',
  'itinerary_pdf',
  'purchase_file',
  'department_file',
] as const;
export type DealDocumentKind = (typeof DEAL_DOCUMENT_KINDS)[number];

/** Existing audited download routes (unchanged). */
const ROUTE: Record<DealDocumentKind, string> = {
  id_proof: '/app/id-proofs/',
  booking_file: '/app/bookings/evidence/',
  quotation_acceptance: '/app/quotations/evidence/',
  itinerary_source: '/app/itineraries/sources/',
  itinerary_pdf: '/app/itineraries/rendered/',
  purchase_file: '/app/purchase/files/',
  department_file: '/app/department/evidence/',
};

export function dealDocumentHref(kind: DealDocumentKind, id: string): string {
  return `${ROUTE[kind]}${encodeURIComponent(id)}`;
}

const Text = z.string().min(1).max(200);
const ContextSchemas = {
  id_proof: z.object({ travellerSeq: z.number().int().min(1).max(100) }),
  booking_file: z.object({
    versionNo: z.number().int().min(1).nullable(),
    evidenceKind: z.enum(['acceptance_message', 'ticket', 'bill', 'payment_proof', 'other']),
  }),
  quotation_acceptance: z.object({
    quotationReference: Text,
    versionNo: z.number().int().min(1).nullable(),
    evidenceKind: z.enum(['acceptance_message', 'other']),
  }),
  itinerary_source: z.object({ documentId: z.uuid() }),
  itinerary_pdf: z.object({ pdfKind: z.enum(['preview', 'final']), documentId: z.uuid() }),
  purchase_file: z.object({ department: z.literal('purchase'), fileKind: z.enum(['quote', 'supplier_confirmation', 'other']) }),
  department_file: z.object({
    department: Text,
    fileKind: z.enum(['applicant_document', 'fee_receipt', 'authority_outcome', 'direct_payment_proof', 'other']),
  }),
} as const;

const RowSchema = z.object({
  kind: z.enum(DEAL_DOCUMENT_KINDS),
  id: z.uuid(),
  fileName: z.string().min(1).max(200),
  mime: z.string().min(1).max(120),
  uploadedAt: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
});

export type DealDocumentContext = { [K in DealDocumentKind]: z.infer<(typeof ContextSchemas)[K]> };

export type DealDocumentView = {
  [K in DealDocumentKind]: {
    kind: K;
    id: string;
    fileName: string;
    mime: string;
    uploadedAt: string;
    context: DealDocumentContext[K];
    href: string;
  };
}[DealDocumentKind];

/**
 * Parses the read's reply. Any malformed row makes the whole reply invalid
 * (null), so a tab never looks complete when it is not. Keys are copied
 * explicitly (DTO allowlist).
 */
export function toDealDocumentViews(data: unknown): DealDocumentView[] | null {
  const top = z.object({ files: z.array(RowSchema) }).safeParse(data);
  if (!top.success) return null;
  const out: DealDocumentView[] = [];
  for (const row of top.data.files) {
    const context = ContextSchemas[row.kind].safeParse(row.context);
    if (!context.success) return null;
    out.push({
      kind: row.kind,
      id: row.id,
      fileName: row.fileName,
      mime: row.mime,
      uploadedAt: row.uploadedAt,
      context: context.data,
      href: dealDocumentHref(row.kind, row.id),
    } as DealDocumentView);
  }
  return out;
}
