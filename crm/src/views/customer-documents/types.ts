/*
 * Customer documents screens type against track B's DTOs
 * (`@/modules/customer-documents/{contracts,dto,content}`, contract 6.4, 6.6,
 * 6.9) one to one. Type-only imports: the zod schemas never reach a client
 * bundle (CSP blocks eval). This file only adds the view-side shapes.
 */
import type { DealDocuments, DocumentDetail, DocumentListFilter, DocumentListRow, DocumentRow } from '@/modules/customer-documents/dto';
import type { PdfState } from '@/modules/customer-documents/contracts';

export type { CustomerDocumentContent } from '@/modules/customer-documents/content';
export type { DocumentKind, DocumentStatus, DocumentViewer, PdfState, Paise } from '@/modules/customer-documents/contracts';
export type { DocumentListFilter };

export { AUTO_STATES, HOLD_CODES } from '@/modules/customer-documents/contracts';
export type { AutoState, HoldCode } from '@/modules/customer-documents/contracts';

type AutoKeys = 'autoRule' | 'autoState' | 'holdReasons' | 'releasedByCrm';

/**
 * Accounts phase 3 (contract 6.5): the automatic-bill keys of track B's rows
 * (DocumentAutoFieldsSchema). Optional on the screen side so Phase 2 rows and
 * fixtures (without them) still type and render exactly as before; B's rows
 * always carry them. Codes stay strings: a code this screen does not know yet
 * is shown in plain words, never dropped.
 */
export type AutoBillFields = Partial<Pick<DocumentRow, AutoKeys>>;

/** A document row as the page loaders hand it (B's row plus the screen PDF state, "off" while the maker is off). */
export type DocRow = Omit<DocumentRow, AutoKeys> & { screenPdf: PdfState } & AutoBillFields;
export type DocListRow = Omit<DocumentListRow, AutoKeys> & { screenPdf: PdfState } & AutoBillFields;
export type DocDetail = Omit<DocumentDetail, AutoKeys> & { screenPdf: PdfState } & AutoBillFields;

/** Accounts phase 3: the automatic-bill switches as R-B1 reports them (release = in effect). */
export type AutoBillSwitches = NonNullable<DealDocuments['autoBills']>;

/** R-B1 as the Deal page hands it. `autoBills` absent = Phase 2 behaviour (no automatic bills line). */
export type DealDocs = Omit<DealDocuments, 'documents' | 'autoBills'> & { documents: DocRow[]; autoBills?: AutoBillSwitches | null };

/** R-B3 filter (track B's, with Accounts phase 3 `autoState` and `preset: 'toCheck'`). */
export type DocsFilter = DocumentListFilter;

/** R-B3 page as the list page hands it. */
export interface DocListPage {
  items: DocListRow[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** Active Tally GST invoice references of the Deal (from deal_dues.tallyInvoices) for "Link GST invoice number". */
export interface TallyInvoiceOption {
  id: string;
  invoiceRef: string;
  invoiceDate: string;
}

/** Who reads Accounts › Customer documents. */
export type DocsListViewer = { kind: 'accounts'; entityName: string } | { kind: 'manager'; branchNames: string[] };
