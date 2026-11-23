/**
 * Customer documents (Accounts phase 2, Track B): frozen kinds, statuses,
 * refusal tokens and staff messages, form field names (Addendum L3) and
 * command result shapes.
 *
 * Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
 * 6, 9 and Addenda L3, L5 (frozen 11 Nov 2026). Database:
 * crm/supabase/migrations/20261204000200..0230. Money is whole paise as
 * decimal strings; nothing here is a float.
 */

export type Paise = string;

export const DOCUMENT_KINDS = ['advance_invoice', 'invoice', 'credit_note'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = ['draft', 'released', 'replaced', 'cancelled', 'discarded'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** pdf.state as the database gives it ('none' = no job yet). */
export const DB_PDF_STATES = ['none', 'queued', 'ready', 'failed'] as const;
export type DbPdfState = (typeof DB_PDF_STATES)[number];
/** pdf.state on screens: 'off' = queued while the online PDF maker is switched off (contract 6.6). */
export const PDF_STATES = ['none', 'off', 'queued', 'ready', 'failed'] as const;
export type PdfState = (typeof PDF_STATES)[number];

export const DOCUMENT_VIEWERS = ['accounts', 'manager', 'sales'] as const;
export type DocumentViewer = (typeof DOCUMENT_VIEWERS)[number];

/** Printed titles (Q1). Never "not a tax invoice". */
export const DOCUMENT_TITLES: Readonly<Record<DocumentKind, string>> = Object.freeze({
  advance_invoice: 'Advance Invoice',
  invoice: 'Invoice',
  credit_note: 'Credit Note',
});

/** Number codes (6.3): <prefix>-ADV-n, -INV-n, -CN-n. */
export const DOCUMENT_CODES: Readonly<Record<DocumentKind, 'ADV' | 'INV' | 'CN'>> = Object.freeze({
  advance_invoice: 'ADV',
  invoice: 'INV',
  credit_note: 'CN',
});

/** Draft warnings the database can give (LD15). */
export const DOCUMENT_WARNINGS = ['flight_total_differs'] as const;
export type DocumentWarning = (typeof DOCUMENT_WARNINGS)[number];

export const DOCUMENT_WARNING_TEXT: Readonly<Record<DocumentWarning, string>> = Object.freeze({
  flight_total_differs: 'The ticket batch totals differ from the booking total. The Invoice uses the ticket batch totals.',
});

/** The audit actions (Addendum L5). */
export const DOCUMENT_AUDIT_ACTIONS = [
  'accounts.customer_document.drafted',
  'accounts.customer_document.refreshed',
  'accounts.customer_document.released',
  'accounts.customer_document.discarded',
  'accounts.customer_document.cancelled',
  'accounts.customer_document.replace_started',
  'accounts.customer_document.tally_linked',
  'accounts.customer_document.render_retried',
  'accounts.customer_document.downloaded',
  // Accounts phase 3 (system audit, by: 'crm')
  'accounts.customer_document.auto_drafted',
  'accounts.customer_document.auto_released',
  'accounts.customer_document.held',
] as const;

/** Accounts phase 3 (contract 6.2-6.4): automatic draft rules, release rule, states. */
export const AUTO_DRAFT_RULES = ['adv_on_receipt', 'inv_on_approval', 'inv_replace_on_change', 'cn_on_refund'] as const;
export type AutoDraftRule = (typeof AUTO_DRAFT_RULES)[number];
export const AUTO_RELEASE_RULE = 'auto_release';
export const AUTO_STATES = ['ready', 'held'] as const;
export type AutoState = (typeof AUTO_STATES)[number];

/** The ten automatic checks (6.3): a held bill carries one or more of these codes, in this order. */
export const HOLD_CODES = [
  'company_identity_missing',
  'billing_not_verified',
  'amount_mismatch',
  'amount_zero',
  'newer_version_waiting',
  'receipt_not_money',
  'cancellation_open',
  'change_open',
  'refund_open',
  'duplicate_cover',
  'number_conflict',
] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/** Frozen reason words of a held bill (6.3, "Held - reason"). */
export const HOLD_REASON_TEXT: Readonly<Record<HoldCode, string>> = Object.freeze({
  company_identity_missing: 'The company GSTIN cannot be printed for this branch. Tell the CRM team.',
  billing_not_verified: 'Billing details for this Deal are not verified yet.',
  amount_mismatch: 'The amount no longer matches the payment, the approved booking or the refund.',
  amount_zero: 'The amount is zero.',
  newer_version_waiting: 'A newer booking version is waiting for Accounts approval.',
  receipt_not_money: 'This payment is no longer verified money.',
  cancellation_open: 'A trip cancellation is in progress.',
  change_open: 'A booking change is in progress.',
  refund_open: 'A refund request is waiting for a decision.',
  duplicate_cover: 'Another bill already covers the same money.',
  number_conflict: 'Another Deal already uses this document number. Tell the CRM team.',
});

/** Deal history line of an automatic step (6.4): "by the CRM, rule: ...". */
export const AUTO_RULE_TEXT: Readonly<Record<AutoDraftRule | typeof AUTO_RELEASE_RULE, string>> = Object.freeze({
  adv_on_receipt: 'by the CRM, rule: Advance Invoice when a payment is verified',
  inv_on_approval: 'by the CRM, rule: Invoice when Accounts approves the booking',
  inv_replace_on_change: 'by the CRM, rule: replacement Invoice when the booking changed',
  cn_on_refund: 'by the CRM, rule: Credit Note when a refund is paid or settled',
  auto_release: 'by the CRM, rule: released automatically after every check passed',
});

/** Render template version the release command queues. */
export const CUSTOMER_TEMPLATE_VERSION = 'cdoc-1';

// ---------------------------------------------------------------------------
// Refusal tokens (section 9) and frozen messages
// ---------------------------------------------------------------------------

export type DocumentErrorCode =
  | 'documents_off'
  | 'billing_not_verified'
  | 'document_stale'
  | 'receipt_not_verified'
  | 'has_credit_notes'
  | 'company_identity_missing'
  | 'number_conflict'
  | 'not_ready'
  | 'already_recorded'
  | 'wrong_state'
  | 'version_changed'
  | 'request_conflict'
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'environment_unset'
  | 'not_configured';

/** Each token and the only SQLSTATE it may arrive with. */
export const DOCUMENT_ERROR_STATES: Readonly<Record<DocumentErrorCode, string>> = Object.freeze({
  documents_off: '55000',
  billing_not_verified: '55000',
  document_stale: '40001',
  receipt_not_verified: '55000',
  has_credit_notes: '55000',
  company_identity_missing: '55000',
  number_conflict: '23505',
  not_ready: '55000',
  already_recorded: '55000',
  wrong_state: '55000',
  version_changed: '40001',
  request_conflict: '40001',
  invalid_input: '22023',
  not_authorized: '42501',
  not_found: 'P0002',
  environment_unset: '55000',
  not_configured: '55000',
});

export const DOCUMENT_ERROR_TEXT: Readonly<Record<DocumentErrorCode | 'session', string>> = Object.freeze({
  documents_off: 'Customer documents are not switched on yet.',
  billing_not_verified: 'Billing details for this Deal are not verified yet. Verify them first.',
  document_stale: 'The booking or money changed since this draft was made. Refresh the draft first.',
  receipt_not_verified: 'This payment is no longer verified money, so no Advance Invoice can be released for it.',
  has_credit_notes: 'A released credit note refers to this document. It cannot be cancelled.',
  company_identity_missing: 'The company GSTIN cannot be printed for this branch, so this document cannot be released. Tell the CRM team.',
  number_conflict: 'Another Deal already uses this document number. Tell the CRM team; nothing was released.',
  not_ready: 'This step is not available yet.',
  already_recorded: 'This is already recorded. Refresh the page to see it.',
  wrong_state: 'This document has moved on. Refresh the page to see where it is now.',
  version_changed: 'Someone changed this document while you were looking at it. Refresh the page and try again.',
  request_conflict: 'This request was already used for something else. Refresh the page and try again.',
  invalid_input: 'Check the highlighted field.',
  not_authorized: 'You cannot do this.',
  not_found: 'This document could not be found.',
  environment_unset: 'The CRM is not set up for money work yet. Tell the CRM team.',
  not_configured: 'Money work is not switched on for this company yet. Tell the CRM team.',
  session: 'Your session ended. Sign in again.',
});

/** The reason line each not_ready hint adds (section 9: "each module adds its reason line"). */
export const NOT_READY_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  receiptId: 'The payment is not verified money yet.',
  basis: 'Accounts has not approved the booking yet, so there is no Invoice. An Advance Invoice is still possible.',
  refundRequestId: 'There is no approved refund or settlement for a credit note yet.',
  replacesDocumentId: 'The document being replaced is not released.',
  creditsDocumentId: 'The credit now belongs to another document. Discard this draft and make a new one.',
  dealId: 'This Deal could not be read.',
});

/** wrong_state hints with their own words. */
export const WRONG_STATE_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  replacement: 'A replacement draft is in progress. Release or discard it first.',
  replacesDocumentId: 'The document being replaced is no longer released.',
});

/** number_conflict: "Another Deal (SYN-DEL-002) already uses this document number. …" (hint otherDealReference=<ref>). */
export const NUMBER_CONFLICT_TEXT = 'Another Deal ({reference}) already uses this document number. Tell the CRM team; nothing was released.';

export const DOCUMENT_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm whether this was saved. Refresh the page before trying again.';

export const DOCUMENT_DONE_TEXT = Object.freeze({
  drafted: 'Draft made. Check it, then release it.',
  refreshed: 'Draft refreshed with the latest booking and money.',
  released: 'Released as {number}.',
  discarded: 'Draft discarded.',
  cancelled: 'Document cancelled.',
  replaceStarted: 'Replacement draft made. Release it to replace {number}.',
  tallyLinked: 'GST invoice number linked.',
  tallyCleared: 'GST invoice number removed from the draft.',
  renderRetried: 'The PDF will be made again.',
  switched: 'Saved.',
  existing: 'Already done. Nothing changed.',
});

// ---------------------------------------------------------------------------
// Form field names (Addendum L3)
// ---------------------------------------------------------------------------

export const DOCUMENT_FIELD = Object.freeze({
  dealId: 'dealId',
  documentId: 'documentId',
  kind: 'kind',
  receiptId: 'receiptId',
  refundRequestId: 'refundRequestId',
  replacesDocumentId: 'replacesDocumentId',
  tallyInvoiceId: 'tallyInvoiceId',
  entityId: 'entityId',
  enabled: 'enabled',
  reason: 'reason',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  expectedContentSha256: 'expectedContentSha256',
  /** Accounts phase 3 (B1): the two automatic bill switches ('true' | 'false'). */
  drafts: 'drafts',
  release: 'release',
} as const);

/** Pages revalidated after a document command. */
export const DOCUMENT_PATHS = ['/app/accounts/documents', '/app/accounts'] as const;

// ---------------------------------------------------------------------------
// Command results and action result
// ---------------------------------------------------------------------------

export interface DocumentCommandResult {
  outcome: 'created' | 'updated' | 'existing';
  documentId: string;
  dealId: string;
  kind: DocumentKind;
  status: DocumentStatus;
  number: string | null;
  rowVersion: number;
  contentSha256: string;
  warnings?: string[];
  seq?: number;
  issueDate?: string;
  renderJobId?: string;
  replacedDocumentId?: string | null;
  replacesDocumentId?: string;
}

export interface RenderRetryResult {
  outcome: 'created' | 'existing';
  documentId: string;
  renderJobId: string;
}

export interface DocumentsSwitchResult {
  changed: boolean;
  customerDocumentsEnabled: boolean;
  rowVersion: number;
  updatedAt: string | null;
}

/** B1 admin_set_auto_bills result (Accounts phase 3, 6.1). */
export interface AutoBillsSwitchResult {
  changed: boolean;
  autoBillsEnabled: boolean;
  autoBillReleaseEnabled: boolean;
  /** Addendum O3: first switch-on of automatic drafts (null = never on); earlier sources are never drafted automatically. */
  autoBillsSince: string | null;
  rowVersion: number;
  updatedAt: string | null;
}

export type DocumentActionResult<T> =
  | { ok: true; data: T; message: string }
  | { ok: false; code: DocumentErrorCode | 'session'; message: string; field?: string; values?: Record<string, string> };
