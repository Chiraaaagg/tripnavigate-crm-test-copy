import { toPurchaseTaskView } from '@/modules/fulfilment/dto';
import type { SupplierDetailRecord, SupplierRecord, WorkspaceRecord } from './commands';
import type { PurchaseWorkspaceView, SupplierDetailView, SupplierSummary } from './contracts';

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

export function toWorkspaceView(record: WorkspaceRecord, suppliers: SupplierRecord[]): PurchaseWorkspaceView {
  return {
    task: toPurchaseTaskView(record.task),
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
          .filter((s) => s.status === 'active' && s.serviceTypes.includes('hotel'))
          .map((s) => ({ supplierId: s.supplierId, name: s.name, verificationStatus: s.verificationStatus }))
      : [],
  };
}

/** Latest cost version number (0 when none): the optimistic-lock value the forms post back. */
export function latestCostVersionNo(view: Pick<PurchaseWorkspaceView, 'costVersions'>): number {
  return view.costVersions.reduce((max, c) => Math.max(max, c.versionNo), 0);
}
