/*
 * Typed adapter for the Accounts phase 3 change screens (contract 10.5,
 * 11.3, screen 15.10). Mirrors the frozen read DTOs of tracks G and H until
 * `S/modules/booking-changes/dto.ts` exists; the route then maps the module
 * DTO onto these types (one-to-one) or re-exports it. Keys marked "UI
 * assumption" are not named in the contract and must be confirmed by the
 * lead with track G / H before wiring. Money is whole paise as decimal
 * strings. Costs, rates and selling figures appear only where the contract
 * fences allow (section 14); the database returns null otherwise.
 */

export type ChangeKind = 'change' | 'add_service' | 'remove_service';
/** Addendum O2: draft (Sales fills the change version) → requested (sent; the Manager approves that exact version) → approved (suppliers reconfirm) → applied. 'submitted' only on older rows. */
export type ChangeStatus = 'draft' | 'requested' | 'returned' | 'approved' | 'submitted' | 'applied' | 'not_possible' | 'withdrawn';
export type ReconfirmStatus = 'pending' | 'recorded' | 'refused' | 'applied' | 'void';
export type RemovalRoute = 'simple' | 'cancellation';
export type ChangeDepartment = 'purchase' | 'flight' | 'visa' | 'sales' | 'accounts';

/** Who is reading the Deal page (set by the route from the viewer, not from the DTO). */
export type ChangeViewer = 'sales' | 'manager' | 'accounts';

/** R-G1 confirmed[] row: a service whose supplier has confirmed it. */
export interface ConfirmedServiceView {
  itemId: string;
  itemNo: number;
  serviceTitle: string;
  department: ChangeDepartment;
  taskStatus: string;
  /** Manager and Accounts only; null for the Sales owner. */
  supplierName: string | null;
  /** Manager and Accounts only. */
  reference: string | null;
}

/** R-G1 requests[].reconfirmations[]. */
export interface ReconfirmationLineView {
  taskId: string;
  serviceTitle: string;
  status: ReconfirmStatus;
  overBudget: boolean;
  refusedReason: string | null;
}

/** H additive charges[] row (no amounts: department and completeness only). */
export interface RemovalChargeStateView {
  department: ChangeDepartment;
  enteredByName: string | null;
  complete: boolean;
}

/** R-G1 requests[] (+ H additive keys). */
export interface ChangeRequestView {
  id: string;
  refNo: string;
  kind: ChangeKind;
  status: ChangeStatus;
  itemNos: number[];
  changeSummary: string;
  reason: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  returnReason: string | null;
  changeVersionId: string | null;
  reconfirmations: ReconfirmationLineView[];
  closeReason: string | null;
  rowVersion: number;
  /** H: only for remove_service. */
  removalRoute?: RemovalRoute | null;
  /** H: the customer charge typed on a booked removal (shown to the Sales owner and the Manager). */
  customerChargePaise?: string | null;
  /** H: per-department charge state for a booked removal. */
  charges?: RemovalChargeStateView[];
  can: { resubmit: boolean; withdraw: boolean; openVersion: boolean; submit: boolean };
}

/** R-G1 `deal_change_requests(p_deal_id)`; null from the database for P / F / V. */
export interface DealChangeRequestsView {
  dealId: string;
  enabled: boolean;
  /** H: `booking_change_settings.service_changes_enabled`. Absent = same as `enabled`. */
  serviceChangesEnabled?: boolean;
  /** H: why a service cannot be added or removed now (SERVICE_BLOCK_CODES; unknown codes kept). Absent = use blockedBy. */
  serviceBlockedBy?: string[];
  canRequest: boolean;
  /** Codes: not_committed, trip_cancelled, refund_open, change_open, changes_off, change_not_supported, no_confirmed_version. */
  blockedBy: string[];
  confirmed: ConfirmedServiceView[];
  requests: ChangeRequestView[];
  /** H additive: service types that may be added (e.g. hotel, transfer, activity). */
  addableTypes?: string[];
  /**
   * UI assumption (H): every service of the confirmed version that could be
   * removed, with whether it is booked (route `cancellation`). Absent: the
   * screen offers `confirmed` only, all treated as booked.
   */
  removable?: RemovableServiceView[];
}

export interface RemovableServiceView {
  itemId: string;
  itemNo: number;
  serviceTitle: string;
  department: ChangeDepartment;
  booked: boolean;
}

/** R-G2 `change_requests_list` row. UI assumption: the request fields plus the Deal and the decide rights. */
export interface ChangeRequestListRow {
  id: string;
  refNo: string;
  dealId: string;
  dealReference: string;
  dealTitle: string | null;
  branchName: string;
  kind: ChangeKind;
  status: ChangeStatus;
  itemNos: number[];
  changeSummary: string;
  reason: string;
  requestedByName: string;
  requestedAt: string;
  rowVersion: number;
  removalRoute?: RemovalRoute | null;
  customerChargePaise?: string | null;
  /** H: every department charge of a booked removal is entered. */
  chargesComplete?: boolean;
  /** UI assumption: the Approver rights for this viewer (false for the requester, Accounts and Sales). */
  can: { approve: boolean; return: boolean };
}

export interface ChangeRequestsPage {
  items: ChangeRequestListRow[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** R-H1 `service_removal_charges(p_change_request_id)` — Manager only. UI assumption on the row keys. */
export interface RemovalChargesView {
  changeRequestId: string;
  refNo: string;
  customerChargePaise: string | null;
  services: Array<{
    itemNo: number;
    serviceTitle: string;
    department: ChangeDepartment;
    supplierName: string | null;
    /** What the supplier keeps (cancellation charge). */
    supplierKeepsPaise: string | null;
    /** What the supplier owes back (paid minus kept). */
    refundExpectedPaise: string | null;
    enteredByName: string | null;
    complete: boolean;
  }>;
}

/** Department-safe fact line (R-G3 old/new details). UI assumption: key + label + value. */
export interface FactLine {
  key: string;
  label: string;
  value: string | null;
}

/** R-G3 `task_reconfirmation_get(p_task_id)` — the task's Purchase reader and the Manager; never a selling price. */
export interface TaskReconfirmationView {
  taskId: string;
  changeRequest: { refNo: string; status: ChangeStatus };
  old: { details: FactLine[]; ratePaise: string | null; reference: string | null; confirmedAt: string | null };
  new: { details: FactLine[]; changedFields: string[] };
  reconfirmation: {
    id: string;
    status: ReconfirmStatus;
    newRatePaise: string | null;
    supplierFeePaise: string | null;
    newReference: string | null;
    evidenceId: string | null;
    overBudget: boolean;
    budgetPaise: string | null;
    rowVersion: number;
  };
  /** uploadProof (migration 0690): the reconfirmation proof can be uploaded on this confirmed task now. */
  can: { record: boolean; refuse: boolean; approveOverBudget: boolean; uploadProof?: boolean };
}

/** Stored supplier-confirmation files the assignee may pick as proof (from the task's evidence list; UI assumption). */
export interface ProofOption {
  evidenceId: string;
  fileName: string;
  uploadedAt: string;
}

/** R-G4 `deal_change_history(p_deal_id)`. */
export interface ChangeHistoryView {
  versions: Array<{
    versionNo: number;
    status: string;
    confirmedAt: string | null;
    changedFields: string[];
    changeRequest: { refNo: string; kind: ChangeKind; requestedByName: string; decidedByName: string | null } | null;
  }>;
  confirmations: Array<{
    serviceTitle: string;
    confirmationNo: number;
    supplierName: string | null;
    reference: string | null;
    confirmedByName: string | null;
    confirmedAt: string;
    /** Manager and Accounts only (null otherwise). */
    amountPaise: string | null;
    changeFeePaise: string | null;
  }>;
}

/** The change-mode booking form (G6 submit inputs the screen shows). */
export interface ChangeModeView {
  changeRequestId: string;
  refNo: string;
  kind: ChangeKind;
  changeSummary: string;
  /** Services named in the approved request. */
  requestItemIds: string[];
  /** Services whose facts differ from the confirmed version now. */
  changedItemIds: string[];
  /** Item numbers, for the words on screen. */
  itemNos: Record<string, number>;
  contentHash: string;
  canSubmit: boolean;
}

/** One side of the Manager's review (Addendum O2, R-H2 `booking_change_review`): the accepted booking or the change version. */
export interface ReviewSideView {
  versionNo: number;
  tripStart: string | null;
  tripEnd: string | null;
  sellingTotalPaise: string | null;
  plan: Array<{ seq: number; label: string | null; amountPaise: string; dueDate: string | null }>;
  services: Array<{ itemId: string; itemNo: number; serviceType: string; serviceTitle: string; facts: FactLine[]; budgetPaise: string | null }>;
}

/** Addendum O2: what the branch Manager approves — the accepted booking and the filled change version side by side. */
export interface ChangeReviewView {
  changeRequestId: string;
  refNo: string;
  kind: ChangeKind;
  status: ChangeStatus;
  rowVersion: number;
  removalRoute: RemovalRoute | null;
  customerChargePaise: string | null;
  base: ReviewSideView;
  /** Null until the Sales owner opened the change version. */
  proposed: ReviewSideView | null;
  changedItemIds: string[];
  changedFields: string[];
  /** False: the version was edited after it was sent; approving is refused until it is sent again. */
  sentVersionCurrent: boolean;
  canDecide: boolean;
}
