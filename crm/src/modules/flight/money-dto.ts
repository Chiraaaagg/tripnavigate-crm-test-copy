import type { FareApprovalSetRecord, FarePreviewRecord, FlightMoneyRecord, FlightSupplierRecord, PaymentContextRecord } from './money-commands';
import type {
  FlightFareApprovalSetView,
  FlightFarePreviewView,
  FlightMoneyBatchView,
  FlightMoneyView,
  FlightPaymentContextView,
  FlightSupplierView,
} from './money-contracts';

/**
 * Explicit whitelists from the validated records to the page DTOs. The
 * database already builds each read per role (money fence, contract 9.3);
 * these mappers copy named fields only, so nothing new reaches a page by
 * accident. Package Deals never carry markup, discount or customer amounts:
 * those fields are forced to null here too.
 */

export function toFlightSupplierView(r: FlightSupplierRecord): FlightSupplierView {
  return {
    supplierId: r.supplierId,
    name: r.name,
    city: r.city,
    status: r.status,
    bankDetailsApproved: r.bankDetailsApproved,
    verification: r.verification,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactEmail: r.contactEmail,
    rowVersion: r.rowVersion,
  };
}

export function toFlightFarePreviewView(r: FarePreviewRecord): FlightFarePreviewView {
  return {
    fareHash: r.fareHash,
    batchSupplierCostPaise: r.batchSupplierCostPaise,
    batchCustomerTotalPaise: r.batchCustomerTotalPaise,
    dealSupplierCostAfterPaise: r.dealSupplierCostAfterPaise,
    dealBudgetPaise: r.dealBudgetPaise,
    overBudget: r.overBudget,
    approval: r.approval ? { approvalId: r.approval.approvalId, status: r.approval.status } : null,
    costTaskId: r.costTaskId,
  };
}

function toBatch(b: FlightMoneyRecord['batches'][number], flightOnly: boolean): FlightMoneyBatchView {
  return {
    batchId: b.batchId,
    batchNo: b.batchNo,
    costTaskId: b.costTaskId,
    supplierId: b.supplierId,
    supplierName: b.supplierName,
    sectorIds: [...b.sectorIds],
    confirmedAt: b.confirmedAt,
    confirmedByName: b.confirmedByName,
    fares: b.fares.map((f) => ({
      paxType: f.paxType,
      basicPaise: f.basicPaise,
      kPaise: f.kPaise,
      yqPaise: f.yqPaise,
      yrPaise: f.yrPaise,
      otherPaise: f.otherPaise,
      supplierPerPersonPaise: f.supplierPerPersonPaise,
      paxCount: f.paxCount,
      supplierAmountPaise: f.supplierAmountPaise,
      markupPaise: flightOnly ? f.markupPaise : null,
      discountPaise: flightOnly ? f.discountPaise : null,
      totalPerPersonPaise: flightOnly ? f.totalPerPersonPaise : null,
      customerAmountPaise: flightOnly ? f.customerAmountPaise : null,
    })),
    supplierCostPaise: b.supplierCostPaise,
    legacyPaidPaise: b.legacyPaidPaise,
    duePaise: b.duePaise,
    customerTotalPaise: flightOnly ? b.customerTotalPaise : null,
    payment: {
      state: b.payment.state,
      route: b.payment.route,
      refNo: b.payment.refNo,
      returnReason: b.payment.returnReason,
      entryId: b.payment.entryId,
      entryRowVersion: b.payment.entryRowVersion,
      paymentId: b.payment.paymentId,
      paymentRowVersion: b.payment.paymentRowVersion,
      onHold: b.payment.onHold,
      holdReason: b.payment.holdReason,
    },
    canPayDirect: b.canPayDirect,
    canRequest: b.canRequest,
    routePreview: b.routePreview,
  };
}

export function toFlightMoneyView(r: FlightMoneyRecord): FlightMoneyView {
  const flightOnly = r.dealKind === 'flight_only';
  return {
    dealKind: r.dealKind,
    marginsAllowed: flightOnly && r.marginsAllowed,
    budget: {
      dealPaise: r.budget.dealPaise,
      tasks: r.budget.tasks.map((t) => ({ taskId: t.taskId, budgetPaise: t.budgetPaise, source: t.source })),
    },
    supplierCostPaise: r.supplierCostPaise,
    overBudget: r.overBudget,
    customerTotalPaise: flightOnly ? r.customerTotalPaise : null,
    batches: r.batches.map((b) => toBatch(b, flightOnly)),
    supplierTotals: r.supplierTotals.map((s) => ({ supplierId: s.supplierId, supplierName: s.supplierName, runningTotalPaise: s.runningTotalPaise })),
    approvals: r.approvals.map((a) => ({
      approvalId: a.approvalId,
      approvalNo: a.approvalNo,
      status: a.status,
      batchSupplierCostPaise: a.batchSupplierCostPaise,
      projectedSupplierCostPaise: a.projectedSupplierCostPaise,
      budgetPaise: a.budgetPaise,
      requestedAt: a.requestedAt,
      requestedByName: a.requestedByName,
      decidedAt: a.decidedAt,
      decidedByName: a.decidedByName,
      returnReason: a.returnReason,
      rowVersion: a.rowVersion,
      canDecide: a.canDecide,
      canWithdraw: a.canWithdraw,
    })),
    invoices: r.invoices.map((i) => ({
      documentId: i.documentId,
      supplierId: i.supplierId,
      number: i.number,
      docDate: i.docDate,
      totalPaise: i.totalPaise,
      status: i.status,
    })),
    invoiceMissing: r.invoiceMissing,
  };
}

export function toFlightFareApprovalSetView(r: FareApprovalSetRecord): FlightFareApprovalSetView {
  return {
    approvalId: r.approvalId,
    approvalNo: r.approvalNo,
    status: r.status,
    rowVersion: r.rowVersion,
    fareHash: r.fareHash,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    sectorIds: [...r.sectorIds],
    travellers: r.travellers.map((t) => ({ seq: t.seq, type: t.type })),
    fares: r.fares.map((f) => ({
      paxType: f.paxType,
      basicPaise: f.basicPaise,
      kPaise: f.kPaise,
      yqPaise: f.yqPaise,
      yrPaise: f.yrPaise,
      otherPaise: f.otherPaise,
      markupPaise: f.markupPaise,
      discountPaise: f.discountPaise,
      paxCount: f.paxCount,
    })),
  };
}

export function toFlightPaymentContextView(r: PaymentContextRecord): FlightPaymentContextView {
  return {
    batchId: r.batchId,
    batchNo: r.batchNo,
    costTaskId: r.costTaskId,
    amountPaise: r.amountPaise,
    supplierCostPaise: r.supplierCostPaise,
    legacyPaidPaise: r.legacyPaidPaise,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    runningTotalPaise: r.runningTotalPaise,
    routePreview: r.routePreview,
    directAllowed: r.directAllowed,
    directLimitPaise: r.directLimitPaise,
    proofs: r.proofs.map((p) => ({ evidenceId: p.evidenceId, fileName: p.fileName })),
  };
}
