import { z } from 'zod';
import {
  ACCOUNTS_QUEUE_PAGE_MAX,
  type AccountsDealDetail,
  type AccountsDealLookup,
  type AccountsQueueItem,
  type AccountsQueuePage,
  type ActionBlock,
  type CashOverview,
  type CompanyDestinationsPage,
  DESTINATION_KINDS,
  DESTINATION_STATES,
  DESTINATION_VERSION_STATUSES,
  type DestinationOption,
  type DestinationVersionDetail,
  type FinanceCommandResult,
  type FinancePolicyPage,
  type FinancePolicyView,
  type ReceiptAction,
  UNRESOLVED_CASH_KINDS,
  UNRESOLVED_DISPLAY_LIMIT_PER_KIND,
  type UnresolvedCashKind,
  type AccountsClaimsPage,
  type AccountsClaimView,
  type AccountsExpenseRecordsPage,
  PAYMENT_CLAIM_DISPLAY_STATUSES,
  PAYMENT_CLAIM_STATUSES,
  type SalesPaymentClaims,
} from './contracts';

/**
 * zod mirrors of the Phase 5A read shapes (contracts.ts). Every RPC response
 * is validated before a page sees it; anything unexpected fails closed (the
 * caller throws, never renders a guessed value). Amounts stay digit strings.
 */

const paise = z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/);
const nonNegativePaise = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const text = z.string();
const nullableText = z.string().nullable();
const uuid = z.uuid();

const RECEIPT_MODES = ['bank_transfer', 'upi', 'cash', 'cheque'] as const;
const RECEIPT_STATUSES = [
  'recorded',
  'verified',
  'pending_clearance',
  'cleared',
  'bounced',
  'stopped',
  'cancelled',
  'rejected',
  'reversed',
] as const;
const ACTION_BLOCKS = [
  'own_record',
  'own_verification',
  'own_clearance',
  'deal_conflict',
  'wrong_state',
  'evidence_required',
  'mode_not_live',
  'in_unverified_deposit',
] as const;

const actionBlock: z.ZodType<ActionBlock> = z.enum(ACTION_BLOCKS).nullable();
const billingStatus = z.enum(['draft', 'verified']);
const reviewStatus = z.enum(['pending', 'returned', 'approved']);

const MoneySchema = z.object({
  availablePaise: paise,
  awaitingVerificationPaise: nonNegativePaise,
  chequesAwaitingClearancePaise: nonNegativePaise,
});

const LiveModesSchema = z.object({ bank_transfer: z.boolean(), upi: z.boolean(), cash: z.boolean(), cheque: z.boolean() });

export const AccountsQueueItemSchema = z.object({
  dealId: uuid,
  dealReference: z.string().min(1),
  dealTitle: text,
  branchName: text,
  hasConfirmedBooking: z.boolean(),
  billingStatus: billingStatus.nullable(),
  reviewStatus: reviewStatus.nullable(),
  money: MoneySchema,
  updatedAt: timestamp,
}) satisfies z.ZodType<AccountsQueueItem>;

/**
 * accounts_queue cursor: "<dealId>:<dealReference>" of the last item of the
 * previous page. Opaque to pages; validated here and again by the database.
 */
export const ACCOUNTS_QUEUE_CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[^\u0000-\u001f\u007f]{1,500}$/;

export function isAccountsQueueCursor(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNTS_QUEUE_CURSOR.test(value);
}

export const AccountsQueuePageSchema = z
  .object({
    items: z.array(AccountsQueueItemSchema).max(ACCOUNTS_QUEUE_PAGE_MAX),
    hasMore: z.boolean(),
    nextAfter: z.string().regex(ACCOUNTS_QUEUE_CURSOR).nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  // A page never claims to be the whole queue when it is not.
  .refine((p) => (p.nextAfter !== null) === p.hasMore)
  .refine((p) => p.items.length <= p.totalCount) satisfies z.ZodType<AccountsQueuePage>;

export const AccountsDealLookupSchema = z.object({
  dealId: uuid,
  dealReference: z.string().min(1),
  dealTitle: text,
  branchName: text,
  hasConfirmedBooking: z.boolean(),
}) satisfies z.ZodType<AccountsDealLookup>;

export const FinancePolicyViewSchema = z.object({
  versionNo: z.number().int().positive(),
  effectiveAt: timestamp,
  receiptMaxPaise: nonNegativePaise,
  cashPayerDayCapPaise: nonNegativePaise,
  cashTripCapPaise: nonNegativePaise,
  cashDepositDays: z.number().int().min(1).max(7),
  reconciliationRequired: z.boolean(),
  reason: text,
  createdByName: nullableText,
  createdAt: timestamp,
}) satisfies z.ZodType<FinancePolicyView>;

const EvidenceSchema = z.object({
  id: uuid,
  kind: z.enum(['bank_proof', 'cheque_image', 'deposit_slip']),
  fileName: text,
  status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
  createdAt: timestamp,
});

const RECEIPT_ACTIONS = [
  'verify',
  'reject',
  'cheque_clear',
  'cheque_mark',
  'cheque_represent',
  'reverse',
  'correct',
] as const satisfies readonly ReceiptAction[];

const ReceiptActionsSchema = z.object(
  Object.fromEntries(RECEIPT_ACTIONS.map((a) => [a, actionBlock])) as Record<ReceiptAction, typeof actionBlock>,
);

const ReceiptDestinationSchema = z.discriminatedUnion('unmapped', [
  z.object({ unmapped: z.literal(true) }),
  z.object({
    unmapped: z.literal(false),
    label: text,
    kind: z.enum(DESTINATION_KINDS),
    versionNo: z.number().int().positive(),
    bankName: nullableText,
    accountMasked: z.string().regex(/^XXXX[0-9]{4}$/).nullable(),
    upiMasked: z.string().regex(/^.\*\*\*@[a-z]+$/).nullable(),
  }),
]);

const ReceiptSchema = z.object({
  receiptId: uuid,
  receiptNo: z.string().regex(/^R-\d{4}-\d{2}-\d{6,}$/),
  mode: z.enum(RECEIPT_MODES),
  status: z.enum(RECEIPT_STATUSES),
  amountPaise: nonNegativePaise,
  receivedOn: isoDate,
  branchName: text,
  collectorName: nullableText,
  payerName: text,
  payerPanMasked: nullableText,
  payerMobileMasked: nullableText,
  reference: nullableText,
  chequeNumber: nullableText,
  micrCode: nullableText,
  chequeDate: isoDate.nullable(),
  rejectionKind: z.enum(['not_received', 'data_error']).nullable(),
  reversalKind: z.enum(['bank_return', 'not_received', 'data_error']).nullable(),
  reason: nullableText,
  correctsReceiptNo: nullableText,
  correctedByReceiptNo: nullableText,
  recordedByName: nullableText,
  recordedAt: timestamp,
  verifiedByName: nullableText,
  verifiedAt: timestamp.nullable(),
  outcomeDate: isoDate.nullable(),
  policyVersionNo: z.number().int().positive(),
  evidence: z.array(EvidenceSchema),
  actions: ReceiptActionsSchema,
  destination: ReceiptDestinationSchema.nullable(),
});

const BookingSchema = z.object({
  bookingVersionId: uuid,
  versionNo: z.number().int().positive(),
  hotelName: nullableText,
  city: nullableText,
  checkIn: isoDate.nullable(),
  checkOut: isoDate.nullable(),
  rooms: z.number().int().nullable(),
  adults: z.number().int().nullable(),
  children: z.number().int().nullable(),
  sellingTotalPaise: nonNegativePaise.nullable(),
  confirmedAt: timestamp,
  confirmedByName: nullableText,
  reviewStatus,
  reviewRowVersion: z.number().int().nonnegative(),
  returnReason: nullableText,
  reviewedByName: nullableText,
  reviewedAt: timestamp.nullable(),
  canApprove: z.boolean(),
  approveBlock: z.union([actionBlock, z.literal('billing_not_verified')]),
  // B1.1 additive keys (0200 / 0300): optional so a database without B1.1 still parses.
  serviceType: z.enum(['hotel', 'package']).optional(),
  listPricePaise: nonNegativePaise.nullable().optional(),
  discountPaise: nonNegativePaise.nullable().optional(),
  paymentPlan: z
    .object({
      instalments: z.array(z.object({ seq: z.number().int().min(1).max(12), label: text, amountPaise: nonNegativePaise, dueDate: isoDate })).max(12),
      totalPaise: nonNegativePaise,
      matchesSellingTotal: z.boolean(),
    })
    .nullable()
    .optional(),
  services: z.array(z.object({ itemNo: z.number().int().min(1).max(20), serviceType: text })).max(20).optional(),
  contact: z
    .object({ name: text, mobile: nullableText, email: nullableText, bookingFor: z.enum(['individual', 'business']), payerName: nullableText })
    .nullable()
    .optional(),
  revision: z
    .object({
      revisesVersionNo: z.number().int().positive(),
      changeClass: z.enum(['format_only', 'internal_only', 'customer_material']),
      changedFields: z.array(text),
      sellingDeltaPaise: paise.nullable(),
    })
    .nullable()
    .optional(),
  earlierVersions: z
    .array(z.object({ versionNo: z.number().int().positive(), reviewStatus, returnReason: nullableText }))
    .optional(),
  // Booking form (Echo review A M1): the selling side only. A purchase or markup key is never read (stripped).
  prices: z
    .object({
      lines: z.array(
        z.object({ category: z.enum(['adult', 'child_bed', 'child_no_bed', 'infant']), quantity: z.number().int().min(0).max(100), salePaise: nonNegativePaise.nullable() }),
      ).max(4),
      source: z.enum(['per_person', 'quotation_total', 'legacy_total']).nullable().optional().transform((v) => v ?? null),
      sellingTotalPaise: nonNegativePaise.nullable().optional().transform((v) => v ?? null),
    })
    .nullable()
    .optional(),
});

const BillingSchema = z.object({
  billingName: text,
  addressLine1: text,
  addressLine2: nullableText,
  city: text,
  stateCode: text,
  postalCode: text,
  gstin: nullableText,
  status: billingStatus,
  rowVersion: z.number().int().positive(),
  updatedByName: nullableText,
  updatedAt: timestamp,
  verifiedByName: nullableText,
  verifiedAt: timestamp.nullable(),
  /** B1.1: 'sales' when Sales proposed the details. */
  prefillSource: z.enum(['none', 'sales']).optional(),
  // Booking form Bill To (20261124000120 accounts_deal_detail). Absent on an older database; null on a legacy profile.
  billToType: z.enum(['personal', 'business']).nullable().optional(),
  contactPerson: nullableText.optional(),
  phone: nullableText.optional(),
  email: nullableText.optional(),
  gstStatus: z.enum(['registered', 'unregistered']).nullable().optional(),
  gstReason: nullableText.optional(),
});

// ---------------------------------------------------------------------------
// B1.1 advance claims (appendix B §3) and expense records (freeze note §3.2)
//
// Array lengths are NOT capped here unless the database caps them (12
// instalments, item numbers 1..20, pages of at most ACCOUNTS_QUEUE_PAGE_MAX):
// a Deal with many claims, destinations or receipts must still render, so a
// size cap would fail closed on valid data (Mercury review F3).
// ---------------------------------------------------------------------------

const claimStatus = z.enum(PAYMENT_CLAIM_STATUSES);
const claimDisplayStatus = z.enum(PAYMENT_CLAIM_DISPLAY_STATUSES);
const claimActionBlock = z.enum(['own_record', 'deal_conflict', 'wrong_state', 'mode_not_live', 'deal_removed']).nullable();
const maskedAccountOrNull = z.string().regex(/^XXXX[0-9]{4}$/).nullable();
const maskedUpiOrNull = z.string().regex(/^.\*\*\*@[a-z]+$/).nullable();

export const AccountsClaimViewSchema = z.object({
  claimId: uuid,
  status: claimStatus,
  displayStatus: claimDisplayStatus,
  amountPaise: nonNegativePaise,
  mode: z.enum(RECEIPT_MODES),
  reference: nullableText,
  chequeNumber: nullableText,
  chequeDate: isoDate.nullable(),
  paidOn: isoDate,
  payerName: text,
  note: nullableText,
  destination: z
    .object({
      label: text,
      kind: z.enum(DESTINATION_KINDS),
      versionNo: z.number().int().positive(),
      bankName: nullableText,
      accountMasked: maskedAccountOrNull,
      upiMasked: maskedUpiOrNull,
      isCurrent: z.boolean(),
    })
    .nullable(),
  bookingVersionNo: z.number().int().positive(),
  reportedByName: nullableText,
  reportedAt: timestamp,
  linkedReceiptId: uuid.nullable(),
  linkedReceiptNo: nullableText,
  linkKind: z.enum(['recorded_from_claim', 'linked_existing']).nullable(),
  linkReason: nullableText,
  linkedByName: nullableText,
  linkedAt: timestamp.nullable(),
  closedReason: nullableText,
  closedByName: nullableText,
  closedAt: timestamp.nullable(),
  rowVersion: z.number().int().positive(),
  possibleReceiptIds: z.array(uuid),
  actions: z.object({ recordReceipt: claimActionBlock, linkReceipt: claimActionBlock, markNotReceived: claimActionBlock }),
}) satisfies z.ZodType<AccountsClaimView>;

export const SalesPaymentClaimsSchema = z.object({
  dealId: uuid,
  sellingTotalPaise: nonNegativePaise.nullable(),
  reportedPaise: nonNegativePaise,
  confirmedPaise: paise,
  balancePaise: paise.nullable(),
  canReport: z.boolean(),
  reportBlock: z.enum(['service_items_disabled', 'deal_not_active', 'finance_not_ready', 'no_booking']).nullable(),
  destinations: z
    .array(
      z.object({
        versionId: uuid,
        kind: z.enum(DESTINATION_KINDS),
        label: text,
        bankName: nullableText,
        accountMasked: maskedAccountOrNull,
        upiMasked: maskedUpiOrNull,
      }),
    ),
  claims: z
    .array(
      z.object({
        claimId: uuid,
        status: claimStatus,
        displayStatus: claimDisplayStatus,
        amountPaise: nonNegativePaise,
        mode: z.enum(RECEIPT_MODES),
        reference: nullableText,
        chequeNumber: nullableText,
        chequeDate: isoDate.nullable(),
        paidOn: isoDate,
        payerName: text,
        note: nullableText,
        destinationLabel: nullableText,
        receiptAmountPaise: nonNegativePaise.nullable(),
        notReceivedReason: nullableText,
        reportedByName: nullableText,
        reportedAt: timestamp,
        rowVersion: z.number().int().positive(),
        canWithdraw: z.boolean(),
      }),
    ),
}) satisfies z.ZodType<SalesPaymentClaims>;

/**
 * Cursor of the claims list (accounts_payment_claims, 20261119000200):
 * "<claimId>:<reportedAt UTC with microseconds>Z". Opaque to pages.
 */
export const CLAIMS_CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Cursor of the expense records list (accounts_expense_records, 0500): same format as the claims cursor (submittedAt). */
export const B11_LIST_CURSOR = CLAIMS_CURSOR;

export function isClaimsCursor(value: unknown): value is string {
  return typeof value === 'string' && CLAIMS_CURSOR.test(value);
}

export function isB11ListCursor(value: unknown): value is string {
  return typeof value === 'string' && B11_LIST_CURSOR.test(value);
}

export const AccountsClaimsPageSchema = z
  .object({
    items: z.array(
      z.object({
        claimId: uuid,
        dealId: uuid,
        dealReference: z.string().min(1),
        dealTitle: text,
        branchName: text,
        amountPaise: nonNegativePaise,
        mode: z.enum(RECEIPT_MODES),
        paidOn: isoDate,
        payerName: text,
        reference: nullableText,
        chequeNumber: nullableText,
        status: claimStatus,
        displayStatus: claimDisplayStatus,
        reportedByName: nullableText,
        reportedAt: timestamp,
        linkedReceiptNo: nullableText,
      }),
    ).max(ACCOUNTS_QUEUE_PAGE_MAX),
    hasMore: z.boolean(),
    nextAfter: z.string().regex(CLAIMS_CURSOR).nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  .refine((p) => p.hasMore === (p.nextAfter !== null) && p.totalCount >= p.items.length) satisfies z.ZodType<AccountsClaimsPage>;

const expenseBlock = z.enum(['own_submission', 'deal_conflict', 'wrong_state', 'receipt_required']).nullable();

export const AccountsExpenseRecordsPageSchema = z
  .object({
    items: z.array(
      z.object({
        entryId: uuid,
        dealId: uuid.nullable().optional().transform((v) => v ?? null),
        dealReference: z.string().min(1),
        department: z.enum(['purchase', 'flight', 'visa']),
        serviceType: nullableText.optional().transform((v) => v ?? null),
        kind: z.enum(['government_fee', 'service_fee', 'fare', 'other']),
        amountPaise: nonNegativePaise,
        paidBy: z.enum(['company', 'customer_direct', 'not_yet']),
        paymentMode: nullableText,
        paidOn: isoDate.nullable(),
        reference: nullableText.optional().transform((v) => v ?? null),
        status: z.enum(['draft', 'submitted', 'accepted', 'returned']),
        submittedByName: nullableText,
        submittedAt: timestamp.nullable(),
        reviewedByName: nullableText,
        reviewedAt: timestamp.nullable(),
        returnReason: nullableText,
        rowVersion: z.number().int().positive(),
        evidence: z
          .array(
            z.object({
              id: uuid,
              kind: z.enum(['fee_receipt', 'direct_payment_proof', 'authority_outcome']),
              fileName: text,
              status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
              createdAt: timestamp,
            }),
          )
          .optional()
          .transform((v) => v ?? []),
        actions: z.object({ accept: expenseBlock, return: expenseBlock }),
      }),
    ).max(ACCOUNTS_QUEUE_PAGE_MAX),
    hasMore: z.boolean(),
    nextAfter: z.string().regex(B11_LIST_CURSOR).nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  .refine((p) => p.hasMore === (p.nextAfter !== null) && p.totalCount >= p.items.length) satisfies z.ZodType<AccountsExpenseRecordsPage>;

export const AccountsDealDetailSchema = z.object({
  dealId: uuid,
  dealReference: z.string().min(1),
  dealTitle: text,
  legalEntityId: uuid,
  branchId: uuid,
  branchName: text,
  isSynthetic: z.boolean(),
  booking: BookingSchema.nullable(),
  billing: BillingSchema.nullable(),
  money: MoneySchema,
  receipts: z.array(ReceiptSchema),
  liveModes: LiveModesSchema,
  modesAllowed: LiveModesSchema,
  branches: z.array(z.object({ id: uuid, name: text })),
  collectors: z.array(z.object({ userId: uuid, name: text })),
  policy: FinancePolicyViewSchema,
  // B1.1 (0200): absent on older databases → no claims listed.
  claims: z.array(AccountsClaimViewSchema).optional().default([]),
  claimsReportedPaise: nonNegativePaise.optional(),
}) satisfies z.ZodType<AccountsDealDetail>;

export const FinancePolicyPageSchema = z.object({
  legalEntityId: uuid,
  legalEntityName: text,
  current: FinancePolicyViewSchema,
  scheduled: z.array(FinancePolicyViewSchema),
  history: z.array(FinancePolicyViewSchema),
  ceilings: z.object({ cashCapCeilingPaise: nonNegativePaise, receiptMaxCeilingPaise: nonNegativePaise }),
  canEdit: z.boolean(),
}) satisfies z.ZodType<FinancePolicyPage>;

const DepositSchema = z.object({
  depositId: uuid,
  depositedOn: isoDate,
  bankReference: text,
  totalPaise: nonNegativePaise,
  status: z.enum(['recorded', 'verified', 'rejected']),
  receiptNos: z.array(text),
  recordedByName: nullableText,
  verifiedByName: nullableText,
  rejectReason: nullableText,
  evidence: z.array(EvidenceSchema),
  actions: z.object({ verify: actionBlock, reject: actionBlock }),
});

const ReconciliationSchema = z.object({
  reconciliationId: uuid,
  businessDate: isoDate,
  countedPaise: nonNegativePaise,
  expectedPaise: paise,
  differencePaise: paise,
  unverifiedCashPaise: nonNegativePaise,
  note: nullableText,
  status: z.enum(['recorded', 'verified']),
  stale: z.boolean(),
  recordedByName: nullableText,
  verifiedByName: nullableText,
  actions: z.object({ verify: actionBlock }),
});

const unresolvedKind = z.enum(UNRESOLVED_CASH_KINDS as [UnresolvedCashKind, ...UnresolvedCashKind[]]);
const UnresolvedTotalsSchema = z.object(
  Object.fromEntries(UNRESOLVED_CASH_KINDS.map((k) => [k, z.number().int().nonnegative()])) as Record<
    UnresolvedCashKind,
    z.ZodNumber
  >,
);
const OldestUnresolvedSchema = z
  .object(Object.fromEntries(UNRESOLVED_CASH_KINDS.map((k) => [k, isoDate])) as Record<UnresolvedCashKind, typeof isoDate>)
  .partial()
  .strict();

const BranchSchema = z.object({
  branchId: uuid,
  branchName: text,
  cashInHandPaise: paise,
  recordedUnverifiedCashPaise: nonNegativePaise,
  undepositedVerified: z.array(
    z.object({ receiptId: uuid, receiptNo: text, amountPaise: nonNegativePaise, receivedOn: isoDate, dealReference: text }),
  ),
  unresolved: z.array(
    z.object({
      kind: unresolvedKind,
      receiptId: uuid.nullable(),
      receiptNo: nullableText,
      businessDate: isoDate.nullable(),
      amountPaise: nonNegativePaise.nullable(),
    }),
  ),
  unresolvedTotals: UnresolvedTotalsSchema,
  oldestUnresolvedDate: OldestUnresolvedSchema,
  unresolvedTruncated: z.boolean(),
  deposits: z.array(DepositSchema),
  reconciliations: z.array(ReconciliationSchema),
})
  // Truncation never hides how much work exists: every kind lists
  // min(total, limit) items, an oldest date exists exactly for kinds with work,
  // and the truncated flag is true exactly when some kind is cut short.
  .refine((b) =>
    UNRESOLVED_CASH_KINDS.every((k) => {
      const listed = b.unresolved.filter((u) => u.kind === k).length;
      const total = b.unresolvedTotals[k];
      return listed === Math.min(total, UNRESOLVED_DISPLAY_LIMIT_PER_KIND) && (total > 0) === (b.oldestUnresolvedDate[k] !== undefined);
    }),
  )
  .refine((b) => b.unresolvedTruncated === UNRESOLVED_CASH_KINDS.some((k) => b.unresolvedTotals[k] > UNRESOLVED_DISPLAY_LIMIT_PER_KIND));

export const CashOverviewSchema = z.object({
  legalEntityId: uuid,
  policy: FinancePolicyViewSchema,
  branches: z.array(BranchSchema),
}) satisfies z.ZodType<CashOverview>;

export const FinanceCommandResultSchema = z.object({
  outcome: z.enum(['created', 'existing', 'updated']),
  id: uuid,
  receiptNo: z.string().optional(),
  status: z.string().optional(),
  rowVersion: z.number().int().optional(),
  receiptId: uuid.optional(),
}) satisfies z.ZodType<FinanceCommandResult>;

export const EvidenceBeginResultSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  id: uuid,
  objectPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/),
});

export const EvidenceFinishResultSchema = z.object({
  outcome: z.enum(['existing', 'updated']),
  id: uuid,
  status: z.enum(['stored', 'failed', 'removed']),
});

export const EvidenceDownloadSchema = z.object({
  objectPath: z.string().min(1),
  fileName: z.string().min(1),
  mime: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Stage 2: company destinations
// ---------------------------------------------------------------------------

/** Masked forms only; anything else (for example a full number) fails closed. */
const maskedAccount = z.string().regex(/^XXXX[0-9]{4}$/).nullable();
const maskedUpi = z.string().regex(/^.\*\*\*@[a-z]+$/).nullable();

const DestinationVersionSchema = z.object({
  versionId: uuid,
  versionNo: z.number().int().positive(),
  status: z.enum(DESTINATION_VERSION_STATUSES),
  predecessorVersionNo: z.number().int().positive().nullable(),
  holderName: nullableText,
  bankName: nullableText,
  accountMasked: maskedAccount,
  ifsc: nullableText,
  payeeName: nullableText,
  upiMasked: maskedUpi,
  makerId: uuid,
  makerName: nullableText,
  createdAt: timestamp,
  decidedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decisionReason: nullableText,
});

const destinationBlock = z.enum(['wrong_state', 'own_record']).nullable();

const CompanyDestinationSchema = z.object({
  destinationId: uuid,
  kind: z.enum(DESTINATION_KINDS),
  label: text,
  rowVersion: z.number().int().positive(),
  state: z.enum(DESTINATION_STATES),
  createdByName: nullableText,
  createdAt: timestamp,
  retiredAt: timestamp.nullable(),
  retiredByName: nullableText,
  retireReason: nullableText,
  current: DestinationVersionSchema.nullable(),
  pending: DestinationVersionSchema.nullable(),
  latestVersionNo: z.number().int().positive(),
  versions: z.array(DestinationVersionSchema),
  actions: z.object({ submit: destinationBlock, decide: destinationBlock, retire: destinationBlock }),
});

export const CompanyDestinationsPageSchema = z.object({
  entityId: uuid,
  destinations: z.array(CompanyDestinationSchema),
}) satisfies z.ZodType<CompanyDestinationsPage>;

export const DestinationOptionsSchema = z.array(
  z.object({
    versionId: uuid,
    destinationId: uuid,
    kind: z.enum(DESTINATION_KINDS),
    label: text,
    versionNo: z.number().int().positive(),
    bankName: nullableText,
    accountMasked: maskedAccount,
    payeeName: nullableText,
    upiMasked: maskedUpi,
  }),
) satisfies z.ZodType<DestinationOption[]>;

export const DestinationVersionDetailSchema = z.object({
  versionId: uuid,
  versionNo: z.number().int().positive(),
  holderName: nullableText,
  bankName: nullableText,
  accountNumber: nullableText,
  ifsc: nullableText,
  payeeName: nullableText,
  upiId: nullableText,
}) satisfies z.ZodType<DestinationVersionDetail>;

/** Parses or returns null (fail closed). */
export function parseOrNull<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
