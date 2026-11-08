import type { PurchaseTaskDetailRecord } from '@/modules/fulfilment/commands';
import { toPurchaseTaskView } from '@/modules/fulfilment/dto';
import {
  type AccountsGoAheadRecord,
  type ChargeRecord,
  type DealCancellationRecord,
  type GoAheadRecord,
  type ManagerCancellationRecord,
  ProcurementCommandError,
  type SupplierDetailRecord,
  type SupplierRecord,
  WorkspaceHotelTaskSchema,
  type WorkspaceRecord,
} from './commands';
import type {
  AccountsGoAheadRow,
  CancellationChargeView,
  DealCancellationSummary,
  GoAheadView,
  ManagerCancellationRow,
  PurchaseQueueFlags,
  PurchaseWorkspaceView,
  SupplierDetailView,
  SupplierSummary,
  GoAheadState,
} from './contracts';

/**
 * Explicit whitelists. The workspace record already excludes selling price,
 * margin and acceptance proof in SQL; these mappers copy named fields only,
 * so nothing new can pass through by accident.
 */

export function toSupplierSummary(record: SupplierRecord): SupplierSummary {
  return {
    supplierId: record.supplierId,
    name: record.name,
    serviceTypes: record.serviceTypes,
    city: record.city,
    verificationStatus: record.verificationStatus,
    status: record.status,
  };
}

export function toSupplierDetail(record: SupplierDetailRecord): SupplierDetailView {
  return {
    ...toSupplierSummary(record),
    contactName: record.contactName,
    contactPhone: record.contactPhone,
    contactEmail: record.contactEmail,
    paymentTerms: record.paymentTerms,
    rowVersion: record.rowVersion,
    updatedAt: record.updatedAt,
    verifiedAt: record.verifiedAt,
    verifiedByName: record.verifiedByName,
    canEdit: record.canEdit,
    canVerify: record.canVerify,
    beneficiaries: record.beneficiaries.map((b) => ({
      revisionNo: b.revisionNo,
      accountHolder: b.accountHolder,
      bankName: b.bankName,
      ifsc: b.ifsc,
      accountLast4: b.accountLast4,
      status: b.status,
      createdAt: b.createdAt,
      createdByName: b.createdByName,
      approvedAt: b.approvedAt,
      approvedByName: b.approvedByName,
      canApprove: b.canApprove,
    })),
  };
}

const NO_GO_AHEAD: GoAheadView = {
  state: 'not_needed',
  requestId: null,
  costVersionNo: null,
  requestedAt: null,
  requestedByName: null,
  decidedAt: null,
  decidedByName: null,
  returnReason: null,
};

function toGoAheadView(record: GoAheadRecord | null): GoAheadView {
  if (!record) return NO_GO_AHEAD;
  return {
    state: record.state,
    requestId: record.requestId,
    costVersionNo: record.costVersionNo,
    requestedAt: record.requestedAt,
    requestedByName: record.requestedByName,
    decidedAt: record.decidedAt,
    decidedByName: record.decidedByName,
    returnReason: record.returnReason,
  };
}

function toChargeView(c: ChargeRecord): CancellationChargeView {
  return {
    taskId: c.taskId,
    revisionNo: c.revisionNo,
    supplierId: c.supplierId,
    supplierName: c.supplierName,
    committedCostPaise: c.committedCostPaise,
    supplierKeepsPaise: c.supplierKeepsPaise,
    supplierRefundPaise: c.supplierRefundPaise,
    note: c.note,
    creditNoteEvidenceId: c.creditNoteEvidenceId,
    enteredAt: c.enteredAt,
    enteredByName: c.enteredByName,
  };
}

/**
 * The view's task comes from purchase_task_get (every service type) when
 * given; otherwise from the workspace's own Phase 4 hotel task shape.
 */
export function toWorkspaceView(record: WorkspaceRecord, suppliers: SupplierRecord[], taskRecord?: PurchaseTaskDetailRecord): PurchaseWorkspaceView {
  let taskView;
  if (taskRecord) {
    taskView = toPurchaseTaskView(taskRecord);
  } else {
    const parsed = WorkspaceHotelTaskSchema.safeParse(record.task);
    if (!parsed.success) throw new ProcurementCommandError('purchase_workspace', null, null);
    taskView = toPurchaseTaskView(parsed.data);
  }
  const serviceType = taskView.serviceType;
  return {
    task: taskView,
    canWork: record.canWork,
    canRelease: record.canRelease,
    canReassign: record.canReassign,
    canApproveOverBudget: record.canApproveOverBudget,
    assigneeUserId: record.assigneeUserId,
    reassignCandidates: record.reassignCandidates.map((c) => ({ userId: c.userId, name: c.name })),
    gateIssue: record.gateIssue,
    issues: record.issues,
    supplierReference: record.supplierReference,
    selectedQuoteId: record.selectedQuoteId,
    supplierConfirmedByName: record.supplierConfirmedByName,
    quotes: record.quotes.map((q) => ({
      quoteId: q.quoteId,
      supplierId: q.supplierId,
      supplierName: q.supplierName,
      supplierVerification: q.supplierVerification,
      hotelName: q.hotelName,
      roomType: q.roomType,
      mealPlan: q.mealPlan,
      quotedCostPaise: q.quotedCostPaise,
      holdUntil: q.holdUntil,
      cancellationTerms: q.cancellationTerms,
      status: q.status,
      createdAt: q.createdAt,
      createdByName: q.createdByName,
      perRoomNightPaise: q.perRoomNightPaise,
      note: q.note,
    })),
    costVersions: record.costVersions.map((c) => ({
      versionNo: c.versionNo,
      quoteId: c.quoteId,
      stage: c.stage,
      amountPaise: c.amountPaise,
      dueDate: c.dueDate,
      note: c.note,
      payableStatus: c.payableStatus,
      createdAt: c.createdAt,
      createdByName: c.createdByName,
      overBudgetApprovedAt: c.overBudgetApprovedAt,
      overBudgetApprovedByName: c.overBudgetApprovedByName,
    })),
    evidence: record.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      fileName: e.fileName,
      mime: e.mime,
      sizeBytes: e.sizeBytes,
      status: e.status,
      createdAt: e.createdAt,
      uploadedByName: e.uploadedByName,
    })),
    supplierChoices: record.canWork
      ? suppliers
          .filter((s) => s.status === 'active' && (s.serviceTypes as string[]).includes(serviceType))
          .map((s) => ({ supplierId: s.supplierId, name: s.name, verificationStatus: s.verificationStatus, email: s.contactEmail }))
      : [],
    goAhead: toGoAheadView(record.goAhead),
    emails: record.emails.map((e) => ({
      emailId: e.emailId,
      kind: e.kind,
      supplierId: e.supplierId,
      supplierName: e.supplierName,
      toEmail: e.toEmail,
      ccEmails: [...e.ccEmails],
      subject: e.subject,
      body: e.body,
      status: e.status,
      costVersionNo: e.costVersionNo,
      sentAt: e.sentAt,
      sentByName: e.sentByName,
      failed: e.failed,
    })),
    cancellation: record.cancellation
      ? {
          cancellationId: record.cancellation.cancellationId,
          status: record.cancellation.status,
          reason: record.cancellation.reason,
          openedAt: record.cancellation.openedAt,
          openedByName: record.cancellation.openedByName,
          rowVersion: record.cancellation.rowVersion,
          returnReason: record.cancellation.returnReason,
          myCharge: record.cancellation.myCharge ? toChargeView(record.cancellation.myCharge) : null,
          canEnter: record.cancellation.canEnter,
          canSend: record.cancellation.canSend,
          chargesMissing: record.cancellation.chargesMissing,
        }
      : null,
    emailSendingEnabled: record.emailSendingEnabled,
  };
}

export function toAccountsGoAheadRow(r: AccountsGoAheadRecord): AccountsGoAheadRow {
  return {
    requestId: r.requestId,
    status: r.status,
    current: r.current,
    dealId: r.dealId,
    dealReference: r.dealReference,
    branchName: r.branchName,
    taskId: r.taskId,
    itemTitle: r.itemTitle,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    supplierName: r.supplierName,
    amountPaise: r.amountPaise,
    costVersionNo: r.costVersionNo,
    requestedAt: r.requestedAt,
    requestedByName: r.requestedByName,
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName,
    returnReason: r.returnReason,
    rowVersion: r.rowVersion,
    bookingReviewStatus: r.bookingReviewStatus,
    canDecide: r.canDecide,
  };
}

export function toManagerCancellationRow(r: ManagerCancellationRecord): ManagerCancellationRow {
  return {
    cancellationId: r.cancellationId,
    dealId: r.dealId,
    dealReference: r.dealReference,
    branchName: r.branchName,
    status: r.status,
    reason: r.reason,
    openedAt: r.openedAt,
    openedByName: r.openedByName,
    sentAt: r.sentAt,
    sentByName: r.sentByName,
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName,
    returnReason: r.returnReason,
    rowVersion: r.rowVersion,
    charges: r.charges.map((c) => ({ ...toChargeView(c), itemTitle: c.itemTitle })),
    totalKeepsPaise: r.totalKeepsPaise,
    totalRefundPaise: r.totalRefundPaise,
    canDecide: r.canDecide,
  };
}

export function toDealCancellationSummary(r: DealCancellationRecord): DealCancellationSummary {
  return {
    canOpen: r.canOpen,
    cancellation: r.cancellation
      ? {
          cancellationId: r.cancellation.cancellationId,
          status: r.cancellation.status,
          reason: r.cancellation.reason,
          openedAt: r.cancellation.openedAt,
          openedByName: r.cancellation.openedByName,
          decidedAt: r.cancellation.decidedAt,
        }
      : null,
  };
}

export function toQueueFlags(rows: Array<{ taskId: string; goAheadState: GoAheadState; tripCancelled: boolean }>): Record<string, PurchaseQueueFlags> {
  const out: Record<string, PurchaseQueueFlags> = {};
  for (const r of rows) out[r.taskId] = { goAheadState: r.goAheadState, tripCancelled: r.tripCancelled };
  return out;
}

/** Agreed final rate for "Send booking request": the latest cost version when it is still proposed (null otherwise). */
export function bookingRequestVersionNo(view: Pick<PurchaseWorkspaceView, 'costVersions'>): number | null {
  const latest = view.costVersions.reduce<PurchaseWorkspaceView['costVersions'][number] | null>(
    (best, c) => (!best || c.versionNo > best.versionNo ? c : best),
    null,
  );
  return latest && latest.stage === 'proposed' ? latest.versionNo : null;
}

/** Latest cost version number (0 when none): the optimistic-lock value the forms post back. */
export function latestCostVersionNo(view: Pick<PurchaseWorkspaceView, 'costVersions'>): number {
  return view.costVersions.reduce((max, c) => Math.max(max, c.versionNo), 0);
}
