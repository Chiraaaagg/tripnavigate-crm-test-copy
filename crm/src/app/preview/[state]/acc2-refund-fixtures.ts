import type { DealRefundsView, RefundListRow, RefundRequestView, SupplierRefundDueRow } from '@/views/refunds/types';

/*
 * Synthetic fixtures for the refund preview states (acc2-refund-): one
 * cancelled Deal holding ₹75,000 of verified money, charges kept ₹18,000,
 * a customer charge of ₹20,000 and a refund of ₹55,000 to the original payer;
 * supplier, airline and visa-fee refunds expected. Invented names and numbers.
 */

export const DEAL_ID = 'a0003101-0000-4000-8000-000000003101';
export const CANCELLATION_ID = 'a0003102-0000-4000-8000-000000003102';
const NO = { resubmit: false, withdraw: false, approve: false, return: false, payout: false };

export function req(id: number, over: Partial<RefundRequestView> = {}): RefundRequestView {
  return {
    id: `a0003${String(200 + id)}-0000-4000-8000-000000003${String(200 + id)}`,
    refNo: `RF-2026-0000${String(10 + id)}`,
    kind: 'cancellation',
    outcome: 'payout',
    status: 'requested',
    customerChargePaise: '2000000',
    amountPaise: '5500000',
    heldAtRequestPaise: '7500000',
    payeeKind: 'original_payer',
    payeeName: 'Sample Payer One',
    payeeReason: null,
    payeeReceiptId: 'a0003301-0000-4000-8000-000000003301',
    reason: 'Customer cancelled the whole trip because of a family emergency.',
    requestedByName: 'Synthetic Sales Jodhpur',
    requestedAt: '2026-11-12T06:00:00Z',
    requestedAs: 'sales_owner',
    decidedByName: null,
    decidedAt: null,
    returnReason: null,
    withdrawnByName: null,
    withdrawnAt: null,
    withdrawReason: null,
    rowVersion: 1,
    payout: null,
    creditNote: null,
    can: NO,
    ...over,
  };
}

export const REQ_REQUESTED = req(1);
export const REQ_RETURNED = req(2, { status: 'returned', decidedByName: 'Synthetic Manager Jodhpur', decidedAt: '2026-11-12T09:00:00Z', returnReason: 'The charge should include the hotel cancellation fee; check it with Purchase.', rowVersion: 2 });
export const REQ_APPROVED = req(3, { status: 'approved', decidedByName: 'Synthetic Manager Jodhpur', decidedAt: '2026-11-12T09:30:00Z', rowVersion: 2 });
export const REQ_PAID = req(4, {
  status: 'paid',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-12T09:30:00Z',
  rowVersion: 3,
  payout: { mode: 'bank_transfer', paidOn: '2026-11-13', reference: 'UTR2026111300042', evidenceId: 'a0003401-0000-4000-8000-000000003401', recordedByName: 'Synthetic Accounts 2' },
  creditNote: { documentId: 'a0003501-0000-4000-8000-000000003501', number: null, status: 'draft' },
});
export const REQ_WITHDRAWN = req(5, { kind: 'overpayment', outcome: 'keep_credit', customerChargePaise: '0', amountPaise: '300000', status: 'withdrawn', withdrawnByName: 'Synthetic Sales Jodhpur', withdrawnAt: '2026-11-08T10:00:00Z', withdrawReason: 'Customer prefers to adjust it against the next booking.', payeeKind: null, payeeName: null, payeeReceiptId: null, requestedAt: '2026-11-07T10:00:00Z' });

export const PAYERS = [
  { receiptId: 'a0003301-0000-4000-8000-000000003301', receiptNo: 'R-2026-27-000201', payerName: 'Sample Payer One', amountPaise: '5000000' },
  { receiptId: 'a0003302-0000-4000-8000-000000003302', receiptNo: 'R-2026-27-000215', payerName: 'Sample Payer Two', amountPaise: '2500000' },
];

export const SUPPLIER_SOURCES: NonNullable<DealRefundsView['supplierRefunds']> = [
  {
    sourceKind: 'purchase_charge',
    sourceId: 'a0003601-0000-4000-8000-000000003601',
    cancellationId: CANCELLATION_ID,
    supplierId: 'a0003701-0000-4000-8000-000000003701',
    supplierName: 'Sample Lake Palace Hotel',
    taskId: 'a0003801-0000-4000-8000-000000003801',
    expectedPaise: '3000000',
    receivedPaise: '1000000',
    canRecord: true,
    receipts: [{ id: 'a0003901-0000-4000-8000-000000003901', amountPaise: '1000000', receivedOn: '2026-11-13', mode: 'bank_transfer', reference: 'NEFT-SYN-0042', evidenceId: 'a0003951-0000-4000-8000-000000003951', status: 'verified', rowVersion: 1, recordedByName: 'Synthetic Accounts 1', rejectReason: null, canCancel: true }],
  },
  {
    sourceKind: 'flight_charge',
    sourceId: 'a0003602-0000-4000-8000-000000003602',
    cancellationId: CANCELLATION_ID,
    supplierId: 'a0003702-0000-4000-8000-000000003702',
    supplierName: 'Sample Air Consolidator',
    taskId: 'a0003802-0000-4000-8000-000000003802',
    expectedPaise: '1240000',
    receivedPaise: '0',
    canRecord: true,
    receipts: [],
  },
  {
    sourceKind: 'visa_fee',
    sourceId: 'a0003603-0000-4000-8000-000000003603',
    cancellationId: CANCELLATION_ID,
    supplierId: null,
    supplierName: null,
    taskId: 'a0003803-0000-4000-8000-000000003803',
    expectedPaise: '450000',
    receivedPaise: '450000',
    canRecord: false,
    receipts: [{ id: 'a0003902-0000-4000-8000-000000003902', amountPaise: '450000', receivedOn: '2026-11-12', mode: 'card_reversal', reference: 'CARD-REV-0007', evidenceId: 'a0003952-0000-4000-8000-000000003952', status: 'verified', rowVersion: 1, recordedByName: 'Synthetic Accounts 2', rejectReason: null, canCancel: true }],
  },
];

export const DEAL_REFUNDS: DealRefundsView = {
  dealId: DEAL_ID,
  dealReference: 'SYN-JOD-205',
  viewer: 'sales',
  enabled: true,
  heldPaise: '7500000',
  cancellation: { id: CANCELLATION_ID, status: 'approved' },
  chargesKeptPaise: '1800000',
  basisTotalPaise: '21500000',
  maxRefundPaise: '7500000',
  canRequest: true,
  payers: PAYERS,
  requests: [],
};

export const LIST_ROW = (r: RefundRequestView, ref = 'SYN-JOD-205', branch = 'Jodhpur', age = 1): RefundListRow => ({
  id: r.id,
  refNo: r.refNo,
  dealId: DEAL_ID,
  dealReference: ref,
  branchName: branch,
  kind: r.kind,
  outcome: r.outcome,
  status: r.status,
  amountPaise: r.amountPaise,
  customerChargePaise: r.customerChargePaise,
  requestedByName: r.requestedByName,
  requestedAt: r.requestedAt,
  ageWorkingDays: age,
});

export const SUPPLIER_DUE: SupplierRefundDueRow[] = SUPPLIER_SOURCES.slice(0, 2).map((s, i) => ({
  cancellationId: s.cancellationId,
  changeRequestId: null,
  changeRefNo: null,
  dealId: DEAL_ID,
  dealReference: i === 0 ? 'SYN-JOD-205' : 'SYN-DEL-061',
  branchName: i === 0 ? 'Jodhpur' : 'Delhi',
  approvedAt: '2026-11-11T12:00:00Z',
  sourceKind: s.sourceKind,
  sourceId: s.sourceId,
  taskId: s.taskId,
  supplierId: s.supplierId,
  supplierName: s.supplierName,
  expectedPaise: s.expectedPaise,
  receivedPaise: s.receivedPaise,
  outstandingPaise: (BigInt(s.expectedPaise) - BigInt(s.receivedPaise)).toString(),
  receipts: s.receipts.map((r) => ({ id: r.id, amountPaise: r.amountPaise, receivedOn: r.receivedOn, mode: r.mode, reference: r.reference, status: r.status, rowVersion: r.rowVersion, recordedByName: r.recordedByName })),
}));
