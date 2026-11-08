import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { InvoiceActions } from './invoices';
import type { SupplierActions } from './suppliers';

/*
 * The server actions the Flight screens call, passed in as props (the route
 * passes the real 'use server' actions from src/modules/flight/server/*, the
 * preview gallery passes stubs), so the views never import server code. Every
 * action has the `(prev, FormData) => { ok, message, code?, data? }` shape.
 *
 * Form field names (FF) follow the contract's command arguments in
 * camelCase. Structured arguments (sectors, travellers, fares, payment
 * fields) travel as one JSON text field `payload`.
 */

export const FF = {
  dealId: 'dealId',
  taskId: 'taskId',
  sectorId: 'sectorId',
  changeId: 'changeId',
  batchId: 'batchId',
  approvalId: 'approvalId',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  expectedBasisVersionId: 'expectedBasisVersionId',
  targetVersionId: 'targetVersionId',
  expectedAssignee: 'expectedAssignee',
  expectedTaskIds: 'expectedTaskIds',
  expectedRevisionNo: 'expectedRevisionNo',
  travellerSeq: 'travellerSeq',
  toUserId: 'toUserId',
  decision: 'decision',
  reason: 'reason',
  payload: 'payload',
  kind: 'kind',
  file: 'file',
} as const;

export interface FlightWorkActions {
  /** A1 flight_group_claim (dealId, requestId). */
  claim: DecisionAction;
  /** A2 flight_group_reassign (dealId, expectedAssignee, toUserId, reason, requestId). */
  reassign?: DecisionAction;
  /** A3 flight_booking_change_apply (taskId, expectedBasisVersionId, targetVersionId, requestId). */
  applyBookingChange: DecisionAction;
  /** A4 flight_screenshot_sectors_save (taskId, expectedRowVersion, payload = sectors[], requestId). */
  saveScreenshotSectors: DecisionAction;
  /** A5 flight_sector_fill_blanks (sectorId, expectedRowVersion, payload = fields, requestId). */
  fillBlanks: DecisionAction;
  /** A6 flight_change_submit (taskId, payload = {kind, fromSectorIds, travellerSeqs, remark, sectors}, requestId). */
  submitChange: DecisionAction;
  /** A8 flight_change_withdraw (changeId, expectedRowVersion, requestId). */
  withdrawChange: DecisionAction;
  /** A9 flight_change_acknowledge (changeId). */
  acknowledgeChange: DecisionAction;
  /** A10 flight_ticket_correct (sectorId, travellerSeq, expectedRevisionNo, payload = fields, reason, requestId). */
  correctTicket: DecisionAction;
  /** A11 e-ticket upload (taskId, kind 'e_ticket', file). */
  uploadFile: DecisionAction;
  /** A12 flight_group_complete (dealId, expectedTaskIds = comma list, requestId). */
  complete: DecisionAction;
  /** B4 flight_fare_preview (dealId, payload) — a read; returns data = FlightFarePreview. */
  farePreview: DecisionAction;
  /** B5 flight_fare_approval_request (dealId, payload, requestId). */
  requestFareApproval: DecisionAction;
  /** B7 flight_fare_approval_withdraw (approvalId, expectedRowVersion, requestId). */
  withdrawFareApproval: DecisionAction;
  /** B8 flight_tickets_confirm (dealId, payload, requestId). */
  confirmTickets: DecisionAction;
  /** B2 flight_supplier_create (payload = {name, city, ...}, requestId). */
  createSupplier: DecisionAction;
  /** B9 flight_direct_payment_save (batchId, expectedRowVersion, payload, requestId). */
  saveDirectPayment: DecisionAction;
  /** B10 flight_payment_request_create (batchId, payload, requestId). */
  createPaymentRequest: DecisionAction;
  /** Supplier invoices of the flights (B: supplier-money file upload + supplier_document_upload). */
  invoices?: InvoiceActions;
  /** Flight suppliers and their bank details (B2, B3). */
  suppliers?: SupplierActions;
}

/** Deal page approval card: A7 flight_change_decide (changeId, decision approve|reject, reason, expectedRowVersion, requestId). */
export interface DealFlightActions {
  decideChange: DecisionAction;
  /** R3: fill in a missing traveller name (dealId, versionId, seq, fullName, travellerType, requestId). */
  fillName?: DecisionAction;
}

/** Manager Approvals: B6 flight_fare_approval_decide (approvalId, decision approve|return, reason, expectedRowVersion, requestId). */
export interface ManagerFlightActions {
  decideFares: DecisionAction;
}
