import { z } from 'zod';
import { CustomerDocumentContentSchema } from './content';
import { AUTO_STATES, DB_PDF_STATES, DOCUMENT_KINDS, DOCUMENT_STATUSES, DOCUMENT_VIEWERS, type PdfState } from './contracts';

/**
 * Read DTOs of the customer document reads (contract 6.9: R-B1
 * deal_customer_documents, R-B2 customer_document_get, R-B3
 * customer_documents_list). Every key listed (strict objects); a reply with
 * any other key fails closed. Pure.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));

export const DocumentCanSchema = z
  .object({
    refresh: z.boolean(),
    release: z.boolean(),
    discard: z.boolean(),
    cancel: z.boolean(),
    replace: z.boolean(),
    linkTally: z.boolean(),
    retryPdf: z.boolean(),
    download: z.boolean(),
    printView: z.boolean(),
  })
  .strict();

/** Phase 2 row keys (customer_document_get still returns exactly these, plus its own). */
export const DocumentRowBaseSchema = z
  .object({
    documentId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS),
    title: z.string(),
    number: z.string().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    totalPaise: paise,
    issueDate: isoDate.nullable(),
    createdAt: timestamp,
    releasedAt: timestamp.nullable(),
    /** Accounts and Managers only (null otherwise). */
    releasedByName: z.string().nullable(),
    rowVersion: z.number().int().positive(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    stale: z.boolean(),
    bookingChangedSinceRelease: z.boolean(),
    paymentReversed: z.boolean(),
    pdf: z.object({ state: z.enum(DB_PDF_STATES), fileId: z.uuid().nullable() }).strict(),
    tallyLinked: z.boolean(),
    gstInvoiceNumber: z.string().nullable(),
    replacesNumber: z.string().nullable(),
    replacedByNumber: z.string().nullable(),
    /** Accounts and Managers only (null otherwise). */
    endReason: z.string().nullable(),
    warnings: z.array(z.string()),
    can: DocumentCanSchema,
  })
  .strict();

/**
 * Accounts phase 3 (6.5): automatic fields on rows of R-B1 and R-B3. The
 * database always sends all four; they are optional here only so Phase 2
 * preview fixtures stay valid (absent = made and released by a person).
 */
export const DocumentAutoFieldsSchema = z
  .object({
    /** The rule that drafted it (null = made by a person). */
    autoRule: z.string().regex(/^[a-z][a-z0-9_.]{2,59}$/).nullable().optional(),
    /** Drafts only: ready | held (null = not checked yet, or not automatic). */
    autoState: z.enum(AUTO_STATES).nullable().optional(),
    /** HOLD_CODES (an unknown code from a newer server is kept). */
    holdReasons: z.array(z.string().regex(/^[a-z_]{1,40}$/)).optional(),
    releasedByCrm: z.boolean().optional(),
  })
  .strict();

export const DocumentRowSchema = DocumentRowBaseSchema.extend(DocumentAutoFieldsSchema.shape).strict();
export type DocumentRow = z.infer<typeof DocumentRowSchema>;

export const DealDocumentsSchema = z
  .object({
    dealId: z.uuid(),
    viewer: z.enum(DOCUMENT_VIEWERS),
    enabled: z.boolean(),
    /** Accounts phase 3: automatic drafts on, and automatic release in effect. */
    autoBills: z.object({ drafts: z.boolean(), release: z.boolean() }).strict(),
    billing: z.object({ verified: z.boolean(), missing: z.boolean() }).strict(),
    /** Accounts only; null for Managers and Sales owners. */
    candidates: z
      .object({
        advances: z.array(z.object({ receiptId: z.uuid(), receiptNo: z.string(), amountPaise: paise, receivedOn: isoDate }).strict()),
        invoice: z
          .object({
            basisVersionNo: z.number().int().positive().nullable(),
            totalPaise: paise,
            lines: z.array(z.object({ label: z.string(), amountPaise: paise }).strict()),
            warnings: z.array(z.string()),
          })
          .strict()
          .nullable(),
        creditNotes: z.array(z.object({ refundRequestId: z.uuid(), refNo: z.string().nullable(), amountPaise: paise }).strict()),
      })
      .strict()
      .nullable(),
    documents: z.array(DocumentRowSchema),
  })
  .strict();
export type DealDocuments = z.infer<typeof DealDocumentsSchema>;

export const DocumentDetailSchema = DocumentRowBaseSchema.extend({
  dealId: z.uuid(),
  viewer: z.enum(DOCUMENT_VIEWERS),
  content: CustomerDocumentContentSchema,
}).strict();
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

export const DocumentListRowSchema = DocumentRowSchema.extend({
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: z.string(),
}).strict();
export type DocumentListRow = z.infer<typeof DocumentListRowSchema>;

export const DocumentListSchema = z
  .object({
    items: z.array(DocumentListRowSchema),
    hasMore: z.boolean(),
    nextAfter: z.string().nullable(),
    /** Accounts phase 3 (20261205000240): automatic bill switches of the caller's Accounts entities. */
    autoBills: z.object({ drafts: z.boolean(), release: z.boolean() }).strict().optional(),
  })
  .strict();
export type DocumentList = z.infer<typeof DocumentListSchema>;

/** Filter of R-B3 (every key optional). */
export interface DocumentListFilter {
  status?: Array<(typeof DOCUMENT_STATUSES)[number]>;
  kind?: Array<(typeof DOCUMENT_KINDS)[number]>;
  stale?: boolean;
  bookingChanged?: boolean;
  paymentReversed?: boolean;
  pdfState?: (typeof DB_PDF_STATES)[number];
  tallyLinked?: boolean;
  dealReference?: string;
  from?: string;
  to?: string;
  branchId?: string;
  toRelease?: boolean;
  /** Accounts phase 3: drafts in this automatic state. */
  autoState?: 'ready' | 'held';
  /** Accounts phase 3: 'toCheck' = held automatic drafts, oldest first ("Bills to check"). */
  preset?: 'toCheck';
}

/** Screen pdf state: queued while the online PDF maker is off reads "off" (contract 6.6). */
export function screenPdfState(state: (typeof DB_PDF_STATES)[number], onlineMakerOn: boolean): PdfState {
  return state === 'queued' && !onlineMakerOn ? 'off' : state;
}
