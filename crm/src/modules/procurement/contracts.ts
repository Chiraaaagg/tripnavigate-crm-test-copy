import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';

/**
 * Phase 4 procurement contract (docs/implementation/phase-4/contract.md).
 * Lead-owned. Words shown to staff are frozen here.
 *
 * A claimed task is NOT a booked hotel. Only a supplier confirmation with
 * stored proof moves a task to 'supplier_confirmed'. Nothing here creates a
 * payable, payment or invoice. Purchase types carry no selling price, margin
 * or acceptance proof; Sales never receives these types at all.
 */

export const PURCHASE_EVIDENCE_BUCKET = 'purchase-evidence';
export const PURCHASE_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const PURCHASE_EVIDENCE_SIGNED_URL_SECONDS = 60;

export type SupplierServiceType = 'hotel' | 'transfer' | 'activity';
export type SupplierStatus = 'active' | 'archived';
export type SupplierVerification = 'unverified' | 'verified';
export type QuoteStatus = 'open' | 'withdrawn' | 'selected';
export type CostStage = 'proposed' | 'committed';
export type PurchaseEvidenceKind = 'quote' | 'supplier_confirmation' | 'other';
export type PurchaseEvidenceStatus = 'pending_upload' | 'stored' | 'failed' | 'removed';

export type ProcurementErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'task_conflict'
  | 'not_ready'
  | 'over_budget'
  | 'procurement_disabled'
  | 'environment_unset'
  | 'already_confirmed'
  | 'invalid_input'
  | 'evidence_rejected'
  | 'supplier_exists'
  | 'deal_removed';

export type ProcurementIssueCode =
  | 'environment_unset'
  | 'procurement_disabled'
  | 'missing_quote'
  | 'missing_cost'
  | 'cost_not_for_quote'
  | 'over_budget'
  | 'missing_supplier_confirmation_proof'
  | 'evidence_upload_incomplete'
  | 'deal_removed';

export interface SupplierFields {
  name: string;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTerms: string | null;
  status?: SupplierStatus;
}

export interface SupplierSummary {
  supplierId: string;
  name: string;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  verificationStatus: SupplierVerification;
  status: SupplierStatus;
}

export type BeneficiaryStatus = 'unverified' | 'approved';

export interface BeneficiaryRevisionView {
  revisionNo: number;
  accountHolder: string;
  bankName: string;
  ifsc: string;
  /** Only the last 4 digits ever leave the database. */
  accountLast4: string;
  /** P4-D4: a manager (never the recorder) approves the latest revision. Never used for payment. */
  status: BeneficiaryStatus;
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  /** The viewer is a manager who may approve this revision now. */
  canApprove: boolean;
}

export interface SupplierDetailView extends SupplierSummary {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTerms: string | null;
  rowVersion: number;
  updatedAt: string;
  verifiedAt: string | null;
  verifiedByName: string | null;
  /** Purchase in the entity: may edit details and record bank details. */
  canEdit: boolean;
  /** Manager in the entity (not the person who last entered the details): may verify now. */
  canVerify: boolean;
  beneficiaries: BeneficiaryRevisionView[];
}

export interface QuoteView {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  supplierVerification: SupplierVerification;
  hotelName: string;
  roomType: string | null;
  mealPlan: string | null;
  quotedCostPaise: string;
  holdUntil: string | null;
  cancellationTerms: string | null;
  status: QuoteStatus;
  createdAt: string;
  createdByName: string | null;
}

export interface CostVersionView {
  versionNo: number;
  quoteId: string;
  stage: CostStage;
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
  /** Always 'not_requested' in Phase 4: no payable is created. */
  payableStatus: 'not_requested';
  createdAt: string;
  createdByName: string | null;
  /** P4-D2: the branch manager approved this version above the budget. */
  overBudgetApprovedAt: string | null;
  overBudgetApprovedByName: string | null;
}

export interface PurchaseEvidenceView {
  id: string;
  kind: PurchaseEvidenceKind;
  fileName: string;
  mime: string;
  sizeBytes: number;
  status: Exclude<PurchaseEvidenceStatus, 'removed'>;
  createdAt: string;
  uploadedByName: string | null;
}

export interface PurchaseWorkspaceView {
  task: PurchaseTaskView;
  canWork: boolean;
  /** The assignee may hand the task back (P4-D5). */
  canRelease: boolean;
  /** Manager of the deal's branch: may reassign the in-progress task (P4-D5). */
  canReassign: boolean;
  /** Manager of the deal's branch: may approve the latest proposed cost above the budget (P4-D2). */
  canApproveOverBudget: boolean;
  assigneeUserId: string | null;
  /** Other active Purchase people in the entity (only when canReassign). */
  reassignCandidates: Array<{ userId: string; name: string }>;
  gateIssue: 'environment_unset' | 'procurement_disabled' | 'deal_removed' | null;
  issues: ProcurementIssueCode[];
  supplierReference: string | null;
  selectedQuoteId: string | null;
  supplierConfirmedByName: string | null;
  quotes: QuoteView[];
  costVersions: CostVersionView[];
  evidence: PurchaseEvidenceView[];
  /** Active hotel suppliers for the quote form (empty when the viewer cannot work the task). */
  supplierChoices: Array<{ supplierId: string; name: string; verificationStatus: SupplierVerification }>;
}

export type ProcurementActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: ProcurementErrorCode | 'upload_failed' | 'session';
      message: string;
      /** What the person typed, returned so a refused form can show it again (never commercial values). */
      values?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Frozen wording
// ---------------------------------------------------------------------------

export const SERVICE_TYPE_LABEL: Record<SupplierServiceType, string> = {
  hotel: 'Hotel',
  transfer: 'Transfer',
  activity: 'Activity',
};

export const VERIFICATION_LABEL: Record<SupplierVerification, string> = {
  unverified: 'Details not verified',
  verified: 'Verified',
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  open: 'Open offer',
  withdrawn: 'Withdrawn',
  selected: 'Chosen · supplier confirmed',
};

export const COST_STAGE_LABEL: Record<CostStage, string> = {
  proposed: 'Proposed cost',
  committed: 'Committed cost',
};

export const PURCHASE_EVIDENCE_KIND_LABEL: Record<PurchaseEvidenceKind, string> = {
  quote: 'Supplier quote',
  supplier_confirmation: 'Supplier confirmation email',
  other: 'Other Purchase file',
};

export const PROCUREMENT_ISSUE_TEXT: Record<ProcurementIssueCode, string> = {
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  procurement_disabled:
    'Supplier confirmation is turned off for real bookings until the owner approves the Purchase rules. Your work is saved.',
  missing_quote: 'Add at least one open supplier offer.',
  missing_cost: 'Propose the cost you agreed with the supplier.',
  cost_not_for_quote: 'The latest cost belongs to an offer that is no longer open. Propose the cost again for an open offer.',
  over_budget:
    'The cost is above the approved Purchase budget. The manager of the deal’s branch must approve this cost version before the supplier confirmation can be recorded.',
  missing_supplier_confirmation_proof:
    'Upload the supplier’s confirmation email, saved as a PDF or a screenshot (JPG, PNG or WebP).',
  evidence_upload_incomplete: 'A file did not finish uploading. Remove it or upload it again.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync because it no longer matches the import settings (start date, pipeline or stage). New work is paused; recorded money and history stay.',
};

export const PROCUREMENT_ERROR_TEXT: Record<ProcurementErrorCode | 'upload_failed' | 'session', string> = {
  not_authorized:
    'You can’t do this. Only the Purchase colleague who took this task works on it, managers approve, and nobody approves their own entry.',
  not_found: 'We couldn’t find this. It may have been removed, or you may not have access.',
  version_changed: 'Someone changed this after you opened it. Nothing was saved. Review the latest details and try again.',
  task_conflict: 'This task was already handled differently by someone else. Reload to see the latest state.',
  not_ready: 'Some things are missing. Nothing was confirmed. Fix the items listed and try again.',
  over_budget: PROCUREMENT_ISSUE_TEXT.over_budget,
  procurement_disabled: PROCUREMENT_ISSUE_TEXT.procurement_disabled,
  environment_unset: PROCUREMENT_ISSUE_TEXT.environment_unset,
  already_confirmed: 'The supplier already confirmed this hotel. Changes after confirmation aren’t supported yet.',
  invalid_input: 'Some details aren’t valid. Check the fields and try again.',
  evidence_rejected:
    'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB (at most 10 files). Save emails as PDF or a screenshot; .eml files aren’t accepted.',
  supplier_exists: 'A supplier with this name already exists in this company.',
  deal_removed: PROCUREMENT_ISSUE_TEXT.deal_removed,
  upload_failed: 'The file was not accepted and does not count. Remove it if it is listed, then upload it again.',
  // G-06
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

// G-05
export const PROCUREMENT_UNKNOWN_OUTCOME_TEXT = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

/** What the supplier-confirmation dialog must say before the irreversible action. */
export const SUPPLIER_CONFIRM_DIALOG_TEXT = {
  title: 'Record that the supplier confirmed this hotel?',
  body: [
    'This records the supplier’s confirmation reference and commits the latest proposed cost.',
    'The task is then locked: offers, costs and files can’t be changed afterwards.',
    'It does not pay the supplier, create a bill or invoice, or message the customer.',
  ],
  confirmLabel: 'Record supplier confirmation',
  cancelLabel: 'Go back',
} as const;

export const SUPPLIER_CONFIRM_SUCCESS_TEXT =
  'Supplier confirmation recorded. The cost is committed; no payment or invoice was created.';

/** Shown where a beneficiary is listed (P4-D4). */
export const BENEFICIARY_NOTICE =
  'Bank details are recorded for reference only. A manager approves the latest revision; approved or not, nothing is paid from them in this CRM.';

export const BENEFICIARY_STATUS_LABEL: Record<BeneficiaryStatus, string> = {
  unverified: 'not approved',
  approved: 'approved by a manager',
};

/** Upload hint for Purchase files (P4-D3: supplier confirmations mostly arrive by email). */
export const PURCHASE_FILE_HINT =
  'PDF, JPG, PNG or WebP, up to 4 MB. Up to 10 files. Save a supplier’s email as PDF or take a screenshot; .eml files aren’t accepted.';

/** Manager and assignee actions added by amendment A1 (contract §9). */
export const A1_TEXT = {
  verifyLabel: 'Mark supplier verified',
  verifyHelp: 'You checked these supplier details. Any later change by Purchase marks them not verified again.',
  verifyDone: 'Supplier marked verified.',
  verifyExisting: 'This supplier was already verified. Nothing changed.',
  approveBankLabel: 'Approve these bank details',
  approveBankDone: 'Bank details approved. Nothing is paid from them in this CRM.',
  approveBankExisting: 'These bank details were already approved. Nothing changed.',
  approveCostLabel: 'Approve this cost above budget',
  approveCostHelp: 'Approves only this cost version. If Purchase proposes a newer cost, it needs a new approval. Nothing is paid.',
  approveCostDone: 'Cost approved above budget for this version only.',
  approveCostExisting: 'This cost version was already approved. Nothing changed.',
  releaseLabel: 'Hand the task back',
  releaseHelp: 'The task goes back to the queue. Offers, costs and files stay for the next person.',
  releaseDone: 'Task handed back. A Purchase colleague can take it now.',
  releaseExisting: 'This task was already handed back. Nothing changed.',
  reassignLabel: 'Reassign task',
  reassignHelp: 'Moves the task to another Purchase colleague. Offers, costs and files stay.',
  reassignDone: 'Task reassigned.',
  reassignExisting: 'The task is already with this person. Nothing changed.',
  reassignNobody: 'No other active Purchase colleague can take this task.',
} as const;
