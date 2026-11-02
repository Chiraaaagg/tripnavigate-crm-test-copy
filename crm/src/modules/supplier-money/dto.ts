import type {
  AccountsDocumentsRecord,
  AccountsPaymentRecord,
  ContextRecord,
  DocumentRecord,
  FundingRecord,
  HomeCountsRecord,
  ManagerApprovalsRecord,
  PurchasePaymentRecord,
} from './commands';
import type {
  AccountsSupplierDocumentsView,
  AccountsSupplierPaymentRow,
  CompanyFundingRow,
  ManagerApprovalsView,
  PaymentContextView,
  PurchasePaymentRequestView,
  SupplierDocumentView,
  SupplierMoneyHomeCounts,
} from './contracts';

/**
 * Explicit whitelists. Purchase records already exclude customer money,
 * funding amount/reason and payment proofs in SQL; these mappers copy named
 * fields only, so nothing new can pass through to a Purchase page by accident.
 */

export function toPurchasePaymentView(r: PurchasePaymentRecord): PurchasePaymentRequestView {
  return {
    id: r.id,
    refNo: r.refNo,
    dealId: r.dealId,
    dealReference: r.dealReference,
    taskId: r.taskId,
    serviceTitle: r.serviceTitle,
    serviceType: r.serviceType,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    part: r.part,
    amountPaise: r.amountPaise,
    dueDate: r.dueDate,
    note: r.note,
    route: r.route,
    status: r.status,
    costVersionNo: r.costVersionNo,
    proformaEvidenceId: r.proformaEvidenceId,
    returnReason: r.returnReason,
    requestedAt: r.requestedAt,
    requestedByName: r.requestedByName,
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName,
    paidOn: r.paidOn,
    paymentMode: r.paymentMode,
    bankReference: r.bankReference,
    verifiedAt: r.verifiedAt,
    // Review F1: never sent by the database; kept for type compatibility.
    companyFundingAsked: false,
    onHold: r.onHold,
    holdReason: r.holdReason,
    resubmittedAs: r.resubmittedAs,
    resubmitsRefNo: r.resubmitsRefNo,
    canCancel: r.canCancel,
    canResubmit: r.canResubmit,
    rowVersion: r.rowVersion,
  };
}

export function toDocumentView(r: DocumentRecord): SupplierDocumentView {
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.taskId,
    dealReference: r.dealReference,
    serviceTitle: r.serviceTitle,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    number: r.number,
    docDate: r.docDate,
    totalPaise: r.totalPaise,
    gstIncluded: r.gstIncluded,
    evidenceId: r.evidenceId,
    status: r.status,
    returnReason: r.returnReason,
    uploadedAt: r.uploadedAt,
    uploadedByName: r.uploadedByName,
    reviewedAt: r.reviewedAt,
    reviewedByName: r.reviewedByName,
    rowVersion: r.rowVersion,
  };
}

export function toPaymentContextView(r: ContextRecord): PaymentContextView {
  return {
    taskId: r.taskId,
    dealId: r.dealId,
    dealReference: r.dealReference,
    serviceType: r.serviceType,
    serviceTitle: r.serviceTitle,
    taskStatus: r.taskStatus,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    costVersionNo: r.costVersionNo,
    agreedCostPaise: r.agreedCostPaise,
    requestedPaise: r.requestedPaise,
    remainingPaise: r.remainingPaise,
    goAheadState: r.goAheadState,
    goAheadNeeded: r.goAheadNeeded,
    goAheadValid: r.goAheadValid,
    allowedParts: [...r.allowedParts],
    blockers: [...r.blockers],
    canRequest: r.canRequest,
    canUploadDocuments: r.canUploadDocuments,
    // Review F1: never sent by the database; kept for type compatibility.
    customerMoneyShort: false,
    routeRunningTotalPaise: r.routeRunningTotalPaise,
    approvalLimitPaise: r.approvalLimitPaise,
    bankDetailsApproved: r.bankDetailsApproved,
    invoiceMissing: r.invoiceMissing,
    requests: r.requests.map(toPurchasePaymentView),
    documents: r.documents.map(toDocumentView),
    files: r.files.map((f) => ({
      id: f.id,
      kind: f.kind,
      fileName: f.fileName,
      mime: f.mime,
      sizeBytes: f.sizeBytes,
      status: f.status,
      createdAt: f.createdAt,
      uploadedByName: f.uploadedByName,
    })),
  };
}

export function toAccountsPaymentRow(r: AccountsPaymentRecord): AccountsSupplierPaymentRow {
  return {
    id: r.id,
    refNo: r.refNo,
    dealId: r.dealId,
    dealReference: r.dealReference,
    branchName: r.branchName,
    taskId: r.taskId,
    serviceTitle: r.serviceTitle,
    serviceType: r.serviceType,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    part: r.part,
    amountPaise: r.amountPaise,
    customerMoneyPaise: r.customerMoneyPaise,
    dueDate: r.dueDate,
    note: r.note,
    route: r.route,
    status: r.status,
    costVersionNo: r.costVersionNo,
    agreedCostPaise: r.agreedCostPaise,
    proformaEvidenceId: r.proformaEvidenceId,
    returnReason: r.returnReason,
    requestedAt: r.requestedAt,
    requestedByName: r.requestedByName,
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName,
    paidOn: r.paidOn,
    paymentMode: r.paymentMode,
    bankReference: r.bankReference,
    paymentProofEvidenceId: r.paymentProofEvidenceId,
    bankRevisionNo: r.bankRevisionNo,
    recordedAt: r.recordedAt,
    recordedByName: r.recordedByName,
    verifiedAt: r.verifiedAt,
    verifiedByName: r.verifiedByName,
    bankDetails: r.bankDetails
      ? {
          revisionNo: r.bankDetails.revisionNo,
          accountHolder: r.bankDetails.accountHolder,
          bankName: r.bankDetails.bankName,
          ifsc: r.bankDetails.ifsc,
          accountLast4: r.bankDetails.accountLast4,
          status: r.bankDetails.status,
        }
      : null,
    funding: r.funding
      ? { id: r.funding.id, amountPaise: r.funding.amountPaise, reason: r.funding.reason, route: r.funding.route, status: r.funding.status }
      : null,
    onHold: r.onHold,
    holdReason: r.holdReason,
    rowVersion: r.rowVersion,
    canDecide: r.canDecide,
    canRecord: r.canRecord,
    canVerify: r.canVerify,
  };
}

export function toFundingRow(r: FundingRecord): CompanyFundingRow {
  return {
    id: r.id,
    paymentRequestId: r.paymentRequestId,
    paymentRefNo: r.paymentRefNo,
    paymentStatus: r.paymentStatus,
    dealId: r.dealId,
    dealReference: r.dealReference,
    branchName: r.branchName,
    supplierName: r.supplierName,
    serviceTitle: r.serviceTitle,
    amountPaise: r.amountPaise,
    reason: r.reason,
    route: r.route,
    status: r.status,
    returnReason: r.returnReason,
    requestedAt: r.requestedAt,
    requestedByName: r.requestedByName,
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName,
    recoveredAt: r.recoveredAt,
    recoveredByName: r.recoveredByName,
    recoveryNote: r.recoveryNote,
    rowVersion: r.rowVersion,
    canDecide: r.canDecide,
    canMarkRecovered: r.canMarkRecovered,
  };
}

export function toAccountsDocumentsView(r: AccountsDocumentsRecord): AccountsSupplierDocumentsView {
  return {
    documents: r.documents.map((d) => ({ ...toDocumentView(d), branchName: d.branchName, canReview: d.canReview })),
    missingInvoices: r.missingInvoices.map((m) => ({
      taskId: m.taskId,
      dealReference: m.dealReference,
      serviceTitle: m.serviceTitle,
      supplierId: m.supplierId,
      supplierName: m.supplierName,
      tripEnd: m.tripEnd,
      assigneeName: m.assigneeName,
    })),
  };
}

export function toManagerApprovalsView(r: ManagerApprovalsRecord): ManagerApprovalsView {
  return {
    costsAboveBudget: r.costsAboveBudget.map((c) => ({
      taskId: c.taskId,
      dealReference: c.dealReference,
      serviceTitle: c.serviceTitle,
      supplierName: c.supplierName,
      versionNo: c.versionNo,
      amountPaise: c.amountPaise,
      budgetPaise: c.budgetPaise,
      proposedAt: c.proposedAt,
      proposedByName: c.proposedByName,
      canApprove: c.canApprove,
    })),
    payments: r.payments.map(toAccountsPaymentRow),
    funding: r.funding.map(toFundingRow),
    bankDetails: r.bankDetails.map((b) => ({
      supplierId: b.supplierId,
      supplierName: b.supplierName,
      revisionNo: b.revisionNo,
      accountHolder: b.accountHolder,
      bankName: b.bankName,
      ifsc: b.ifsc,
      accountLast4: b.accountLast4,
      createdAt: b.createdAt,
      createdByName: b.createdByName,
      canApprove: b.canApprove,
    })),
    suppliersToVerify: r.suppliersToVerify.map((s) => ({
      supplierId: s.supplierId,
      name: s.name,
      city: s.city,
      serviceTypes: [...s.serviceTypes],
      rowVersion: s.rowVersion,
      updatedAt: s.updatedAt,
      canVerify: s.canVerify,
    })),
    cancellations: r.cancellations.map((c) => ({
      cancellationId: c.cancellationId,
      dealId: c.dealId,
      dealReference: c.dealReference,
      reason: c.reason,
      status: c.status,
      sentAt: c.sentAt,
      sentByName: c.sentByName,
      chargeCount: c.chargeCount,
      supplierKeepsPaise: c.supplierKeepsPaise,
      supplierRefundPaise: c.supplierRefundPaise,
      rowVersion: c.rowVersion,
      canDecide: c.canDecide,
    })),
  };
}

export function toHomeCounts(r: HomeCountsRecord): SupplierMoneyHomeCounts {
  return {
    requestsToApprove: r.requestsToApprove,
    purchaseTasksNotTaken: r.purchaseTasksNotTaken,
    purchaseWaitingForGoAhead: r.purchaseWaitingForGoAhead,
    purchaseCostsWaitingForManager: r.purchaseCostsWaitingForManager,
    paymentRequestsReturned: r.paymentRequestsReturned,
    supplierInvoicesMissing: r.supplierInvoicesMissing,
    goAheadToApprove: r.goAheadToApprove,
    supplierPaymentsToApprove: r.supplierPaymentsToApprove,
    supplierPaymentsToRecord: r.supplierPaymentsToRecord,
    supplierPaymentsToVerify: r.supplierPaymentsToVerify,
    supplierDocumentsToReview: r.supplierDocumentsToReview,
    fundingToApprove: r.fundingToApprove,
    fundingToRecover: r.fundingToRecover,
    managerApprovals: r.managerApprovals,
  };
}
