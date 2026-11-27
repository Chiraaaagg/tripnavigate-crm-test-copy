import { z } from 'zod';
import {
  type DealRefundsView,
  PAYEE_KINDS,
  PAYOUT_MODES,
  REFUND_KINDS,
  REFUND_OUTCOMES,
  REFUND_STATUSES,
  REFUND_VIEWERS,
  type RefundListPage,
  SUPPLIER_REFUND_MODES,
  SUPPLIER_REFUND_SOURCES,
  SUPPLIER_REFUND_STATUSES,
  type SupplierRefundsDuePage,
} from './contracts';

/**
 * zod schemas of the refund reads (R-C1..R-C3) with every key listed:
 * unknown keys are stripped, a missing or mistyped key fails closed. Money
 * stays a decimal string of whole paise.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const signedPaise = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const text = z.string().nullable();

const RequestSchema = z.object({
  id: z.uuid(),
  refNo: z.string().regex(/^RF-\d{4}-\d{6}$/),
  kind: z.enum(REFUND_KINDS),
  outcome: z.enum(REFUND_OUTCOMES),
  status: z.enum(REFUND_STATUSES),
  customerChargePaise: paise,
  amountPaise: paise,
  heldAtRequestPaise: paise,
  payeeKind: z.enum(PAYEE_KINDS).nullable(),
  payeeName: text,
  payeeReason: text,
  payeeReceiptId: z.uuid().nullable(),
  reason: z.string(),
  requestedByName: text,
  requestedAt: timestamp,
  requestedAs: z.enum(['sales_owner', 'manager']),
  decidedByName: text,
  decidedAt: timestamp.nullable(),
  returnReason: text,
  withdrawnByName: text,
  withdrawnAt: timestamp.nullable(),
  withdrawReason: text,
  rowVersion: z.number().int().positive(),
  useKeptCredit: z.boolean().optional().transform((v) => v ?? false),
  warnings: z.array(z.string()).optional().transform((v) => v ?? []),
  payout: z.object({
    mode: z.enum(PAYOUT_MODES),
    paidOn: isoDate,
    reference: text,
    evidenceId: z.uuid().nullable(),
    recordedByName: text,
  }).nullable(),
  creditNote: z.object({ documentId: z.uuid(), number: text, status: z.string() }).nullable(),
  can: z.object({ resubmit: z.boolean(), withdraw: z.boolean(), approve: z.boolean(), return: z.boolean(), payout: z.boolean() }),
});

const SourceSchema = z.object({
  sourceKind: z.enum(SUPPLIER_REFUND_SOURCES),
  sourceId: z.uuid(),
  cancellationId: z.uuid().nullable(),  // Accounts phase 3: null for a reconfirmation source
  supplierId: z.uuid().nullable(),
  supplierName: text,
  taskId: z.uuid(),
  expectedPaise: paise,
  receivedPaise: paise,
  canRecord: z.boolean(),
  receipts: z.array(z.object({
    id: z.uuid(),
    amountPaise: paise,
    receivedOn: isoDate,
    mode: z.enum(SUPPLIER_REFUND_MODES),
    reference: z.string(),
    evidenceId: z.uuid(),
    status: z.enum(SUPPLIER_REFUND_STATUSES),
    rowVersion: z.number().int().positive(),
    recordedByName: text,
    rejectReason: text,
    canCancel: z.boolean(),
  })),
});

export const DealRefundsSchema = z.object({
  dealId: z.uuid(),
  dealReference: z.string(),
  viewer: z.enum(REFUND_VIEWERS),
  enabled: z.boolean(),
  heldPaise: signedPaise,
  cancellation: z.object({ id: z.uuid(), status: z.string() }).nullable(),
  chargesKeptPaise: paise.nullable(),
  basisTotalPaise: paise.nullable(),
  approvedChargePaise: paise.nullable().optional().transform((v) => v ?? null),
  keptCreditUnusedPaise: paise.optional().transform((v) => v ?? '0'),
  maxRefundPaise: paise,
  canRequest: z.boolean(),
  payers: z.array(z.object({ receiptId: z.uuid(), receiptNo: z.string(), payerName: z.string(), amountPaise: paise })),
  requests: z.array(RequestSchema),
  supplierRefunds: z.array(SourceSchema).optional(),
});

export const RefundListSchema = z.object({
  items: z.array(z.object({
    id: z.uuid(),
    refNo: z.string(),
    dealId: z.uuid(),
    dealReference: z.string(),
    branchName: z.string(),
    kind: z.enum(REFUND_KINDS),
    outcome: z.enum(REFUND_OUTCOMES),
    status: z.enum(REFUND_STATUSES),
    amountPaise: paise,
    customerChargePaise: paise,
    requestedByName: text,
    requestedAt: timestamp,
    ageWorkingDays: z.number().int().nonnegative(),
    rowVersion: z.number().int().positive(),
    can: z.object({ approve: z.boolean(), return: z.boolean(), payout: z.boolean() }),
    expectedAmountPaise: paise.nullable(),
    expectedChargePaise: paise.nullable(),
    useKeptCredit: z.boolean().optional().transform((v) => v ?? false),
    warnings: z.array(z.string()).optional().transform((v) => v ?? []),
    reason: text.optional().transform((v) => v ?? null),
    payeeKind: z.enum(PAYEE_KINDS).nullable().optional().transform((v) => v ?? null),
    payeeName: text.optional().transform((v) => v ?? null),
    payeeReason: text.optional().transform((v) => v ?? null),
    payeeReceiptNo: text.optional().transform((v) => v ?? null),
  })),
  nextAfter: z.string().nullable(),
});

export const SupplierRefundsDueSchema = z.object({
  items: z.array(z.object({
    cancellationId: z.uuid().nullable(),  // Accounts phase 3: null for a reconfirmation source
    changeRequestId: z.uuid().nullable().optional().transform((v) => v ?? null),
    changeRefNo: z.string().nullable().optional().transform((v) => v ?? null),
    dealId: z.uuid(),
    dealReference: z.string(),
    branchName: z.string(),
    approvedAt: timestamp,
    sourceKind: z.enum(SUPPLIER_REFUND_SOURCES),
    sourceId: z.uuid(),
    taskId: z.uuid(),
    supplierId: z.uuid().nullable(),
    supplierName: text,
    expectedPaise: paise,
    receivedPaise: paise,
    outstandingPaise: paise,
    receipts: z.array(z.object({
      id: z.uuid(),
      amountPaise: paise,
      receivedOn: isoDate,
      mode: z.enum(SUPPLIER_REFUND_MODES),
      reference: z.string(),
      status: z.enum(SUPPLIER_REFUND_STATUSES),
      rowVersion: z.number().int().positive(),
      recordedByName: text,
    })),
  })),
  nextAfter: z.string().nullable(),
});

/** The Sales owner never gets supplier refunds, payout references or proof ids (fence 10). */
export function toDealRefunds(raw: z.infer<typeof DealRefundsSchema>): DealRefundsView {
  const view: DealRefundsView = { ...raw };
  if (raw.viewer === 'sales') {
    delete view.supplierRefunds;
    view.requests = raw.requests.map((r) => ({
      ...r,
      payout: r.payout ? { ...r.payout, reference: null, evidenceId: null } : null,
    }));
  }
  return view;
}

export const toRefundList = (raw: z.infer<typeof RefundListSchema>): RefundListPage => raw;
export const toSupplierRefundsDue = (raw: z.infer<typeof SupplierRefundsDueSchema>): SupplierRefundsDuePage => raw;
