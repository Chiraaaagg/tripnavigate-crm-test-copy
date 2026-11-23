import type { ManagerCancellationRow as CancellationDetailRow } from '@/modules/procurement/contracts';
import type { ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import type { FlightBatchCancellation, FlightBatchCancellationKeys, ManagerCancellationKeys, VisaWorkspaceCancellation } from '@/views/cancellations/types';
import type { FlightMoney, MoneyBatch } from '@/views/flight/types';
import type { VisaApplicant, VisaWorkspace } from '@/views/visa/types';
import { BATCH, flight2, money, PNR_GROUPS, progress, S3, status, SUPPLIERS, T1, ticketedFlight1, workspace as flightWorkspace } from './flight-fixtures';
import { applicant, applied, ready, steps, workspace as visaWorkspace } from './visa-fixtures';

/*
 * Synthetic fixtures for the Accounts phase 2 trip-cancellation previews
 * (acc2-cancel-*): the Flight money read with per-batch cancellation blocks,
 * a Visa workspace with the cancellation and per-application choices, and
 * the Manager's cancellation review with Flight charges. No real people,
 * PNRs, ticket numbers or money.
 */

export const BATCH2 = 'b0000000-0000-4000-8000-000000000702';
export const CANCEL_ID = 'c7000000-0000-4000-8000-000000000001';
export const CANCEL_VISA_ONLY = 'c7000000-0000-4000-8000-000000000002';
export const CANCEL_OTHER = 'c7000000-0000-4000-8000-000000000003';

/* ---------- Flight ---------- */

export const flightWs = flightWorkspace({
  status: status('all_confirmed', 9, 9),
  progress: progress('done', { tickets: '9 of 9', payment: '2 of 2 batches' }),
  doneIssues: [],
  flights: [ticketedFlight1(), flight2({ sectors: [S3], status: status('all_confirmed', 3, 3), unnamedCount: 0 })],
  ticketsByPnr: PNR_GROUPS,
});

const none: FlightBatchCancellation = {
  state: 'open',
  revisionNo: 0,
  airlineChargePaise: null,
  refundExpectedPaise: null,
  refundReportedPaise: null,
  supplierRefundReceivedPaise: '0',
  canEnter: true,
};

type CancelBatch = MoneyBatch & FlightBatchCancellationKeys;

/** flight_money with both batches in a cancellation (synthetic amounts). */
export function cancelMoney(first: Partial<FlightBatchCancellation> = {}, second: Partial<FlightBatchCancellation> = {}, ticketsCancelled = false): FlightMoney {
  const base = money({}, { state: 'direct_accepted', route: 'direct' });
  const b1 = base.batches[0]!;
  const b2: MoneyBatch = { ...b1, batchId: BATCH2, batchNo: 2, supplierId: SUPPLIERS[1]!.supplierId, supplierName: SUPPLIERS[1]!.name, sectorIds: [S3.sectorId], fares: undefined, supplierCostPaise: '1440000', confirmedAt: '2026-11-04T09:10:00Z' };
  const batches: CancelBatch[] = [
    { ...b1, canPayDirect: false, canRequest: false, cancellation: { ...none, ...first }, ticketsCancelled },
    { ...b2, canPayDirect: false, canRequest: false, cancellation: { ...none, ...second }, ticketsCancelled },
  ];
  return { ...base, supplierCostPaise: '4800000', batches };
}

export const ENTERED: Partial<FlightBatchCancellation> = {
  revisionNo: 1,
  airlineChargePaise: '840000',
  refundExpectedPaise: '2520000',
  note: 'Airline keeps the fuel charge per its cancellation rule.',
};

export const APPROVED: Partial<FlightBatchCancellation> = { ...ENTERED, state: 'approved', revisionNo: 2, refundReportedPaise: '2400000', supplierRefundReceivedPaise: '1200000' };

export { BATCH, T1 };

/* ---------- Visa ---------- */

type CancelApplicant = VisaApplicant;

/** The company-paid fees of the applied travellers, as visa_workspace().cancellation.fees lists them. */
function feesOf(applicants: VisaApplicant[], refunds: Record<string, { paise: string; revisionNo: number }>, canSet: boolean): VisaWorkspaceCancellation['fees'] {
  return applicants.flatMap((a) =>
    a.fees
      .filter((f) => f.paidBy === 'company')
      .map((f) => ({ entryId: f.entryId, applicationId: a.applicationId, costKind: f.costKind, amountPaise: f.amountPaise, refundExpectedPaise: refunds[f.entryId]?.paise ?? null, revisionNo: refunds[f.entryId]?.revisionNo ?? 0, canSet })),
  );
}

export function visaCancelWs(status: Pick<VisaWorkspaceCancellation, 'status' | 'approved'>, applicants: CancelApplicant[], over: Partial<VisaWorkspace> = {}, canSet = true): VisaWorkspace {
  const first = applicants[0]?.fees ?? [];
  const refunds: Record<string, { paise: string; revisionNo: number }> = first[0] ? { [first[0].entryId]: { paise: '325000', revisionNo: 1 } } : {};
  const cancellation: VisaWorkspaceCancellation = { cancellationId: CANCEL_ID, ...status, fees: feesOf(applicants, refunds, canSet) };
  const ws = visaWorkspace({
    status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' },
    applicants,
    steps: steps({ ready: 4, applied: 3, decision: 0, handover: 0 }, 4),
    ...over,
  });
  return { ...ws, cancellation };
}

export const VISA_OPEN = { status: 'sent_to_manager', approved: false } as const;
export const VISA_APPROVED = { status: 'approved', approved: true } as const;

export const visaApplicantsToDecide: CancelApplicant[] = [
  { ...applied(1), cancellationChoice: null, canChooseCancellation: true },
  { ...applied(2, { state: 'submitted', stateText: 'Applied' }), cancellationChoice: null, canChooseCancellation: true },
  { ...applied(3), cancellationChoice: 'finish', canChooseCancellation: false },
  ready(4),
];

export const visaApplicantsDecided: CancelApplicant[] = [
  { ...applied(1, { state: 'withdrawn', stateText: 'Withdrawn' }), cancellationChoice: 'withdraw', cancellationChoiceReason: 'Trip cancelled before the embassy appointment; customer asked to stop.' },
  { ...applied(2), cancellationChoice: 'withdraw' },
  { ...applied(3), cancellationChoice: 'finish', cancellationChoiceReason: 'Decision is due in two days and the fee cannot be refunded.' },
  applicant(4),
];

/* ---------- Manager review ---------- */

export const EMPTY_APPROVALS: ManagerApprovalsView = { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] };

export const MANAGER_CANCELLATIONS: ManagerApprovalsView['cancellations'] = [
  {
    cancellationId: CANCEL_ID,
    dealId: 'd7000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-JOD-410',
    reason: 'Synthetic: the customer cancelled the whole trip after a family emergency.',
    status: 'sent_to_manager',
    sentAt: '2026-11-11T06:30:00Z',
    sentByName: 'Synthetic Purchase Jodhpur',
    chargeCount: 1,
    supplierKeepsPaise: '450000',
    supplierRefundPaise: '1350000',
    rowVersion: 3,
    canDecide: true,
  },
  {
    cancellationId: CANCEL_VISA_ONLY,
    dealId: 'd7000000-0000-4000-8000-000000000002',
    dealReference: 'SYN-JOD-411',
    reason: 'Synthetic: visa-only booking, the customer changed plans.',
    status: 'open',
    sentAt: null,
    sentByName: null,
    chargeCount: 0,
    supplierKeepsPaise: '0',
    supplierRefundPaise: '0',
    rowVersion: 1,
    canDecide: true,
  },
];

export const MANAGER_DETAILS: Array<CancellationDetailRow & ManagerCancellationKeys> = [
  {
    cancellationId: CANCEL_ID,
    dealId: 'd7000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-JOD-410',
    branchName: 'Jodhpur',
    status: 'sent_to_manager',
    reason: MANAGER_CANCELLATIONS[0]!.reason,
    openedAt: '2026-11-10T10:00:00Z',
    openedByName: 'Synthetic Manager Jodhpur',
    sentAt: '2026-11-11T06:30:00Z',
    sentByName: 'Synthetic Purchase Jodhpur',
    decidedAt: null,
    decidedByName: null,
    returnReason: null,
    rowVersion: 3,
    charges: [
      {
        taskId: 'a7000000-0000-4000-8000-000000000101',
        revisionNo: 1,
        supplierId: 'a7000000-0000-4000-8000-000000000201',
        supplierName: 'Sample Lake Palace Hotel',
        committedCostPaise: '1800000',
        supplierKeepsPaise: '450000',
        supplierRefundPaise: '1350000',
        note: null,
        creditNoteEvidenceId: null,
        itemTitle: 'Hotel · Sample Lake Palace Hotel',
      } as CancellationDetailRow['charges'][number],
    ],
    totalKeepsPaise: '450000',
    totalRefundPaise: '1350000',
    canDecide: true,
    flightCharges: [
      { batchId: BATCH, batchNo: 1, supplierName: SUPPLIERS[0]!.name, supplierCostPaise: '3360000', airlineChargePaise: '840000', refundExpectedPaise: '2520000', refundReportedPaise: null, revisionNo: 1, enteredByName: 'Synthetic Flight Jodhpur', note: 'Airline keeps the fuel charge per its cancellation rule.' },
      { batchId: BATCH2, batchNo: 2, supplierName: SUPPLIERS[1]!.name, supplierCostPaise: '1440000', airlineChargePaise: '1440000', refundExpectedPaise: '0', refundReportedPaise: null, revisionNo: 1, enteredByName: 'Synthetic Flight Jodhpur' },
    ],
    chargesKeptPaise: '2730000',
  },
  {
    cancellationId: CANCEL_VISA_ONLY,
    dealId: 'd7000000-0000-4000-8000-000000000002',
    dealReference: 'SYN-JOD-411',
    branchName: 'Jodhpur',
    status: 'open',
    reason: MANAGER_CANCELLATIONS[1]!.reason,
    openedAt: '2026-11-11T05:00:00Z',
    openedByName: 'Synthetic Manager Jodhpur',
    sentAt: null,
    sentByName: null,
    decidedAt: null,
    decidedByName: null,
    returnReason: null,
    rowVersion: 1,
    charges: [],
    totalKeepsPaise: '0',
    totalRefundPaise: '0',
    canDecide: true,
    flightCharges: [],
    chargesKeptPaise: '0',
  },
];
