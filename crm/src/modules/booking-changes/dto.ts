import { z } from 'zod';
import {
  ADDABLE_SERVICE_TYPES,
  CHANGE_KINDS,
  CHANGE_STATUSES,
  CHARGE_DEPARTMENTS,
  RECONFIRM_STATUSES,
  REMOVAL_ROUTES,
  type ChangeRequestResult,
  type ChangeSwitchResult,
  type ChangeVersionResult,
  type ReconfirmationResult,
} from './contracts';
import { safeFacts } from './rules';

/**
 * Read DTOs of the change reads (contract 10.5: R-G1 deal_change_requests,
 * R-G2 change_requests_list, R-G3 task_reconfirmation_get, R-G4
 * deal_change_history; plus booking_change_preview for the change-mode form).
 * Every key listed (strict objects): a reply with any other key fails closed.
 * R-G1 never carries a cost or rate; R-G3 never a selling price (its facts
 * are filtered again here); R-G4 carries amountPaise / changeFeePaise only for
 * Managers and Accounts (absent otherwise). Money is whole paise as decimal
 * strings. Pure.
 *
 * Track H (contract 11.1-11.3) adds to R-G1: per request removalRoute,
 * customerChargePaise (Sales owner, Manager, Accounts - never Purchase,
 * Flight or Visa, who never read R-G1) and charges (per department, no
 * amounts); per Deal serviceChangesEnabled, serviceBlockedBy, addableTypes
 * and removable. The database always sends them; they are optional here so
 * readers built on track G's shape keep parsing. R-H1
 * service_removal_charges is the Manager's (and Accounts') charges table.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const code = z.string().regex(/^[a-z_]{1,40}$/);
const refNo = z.string().regex(/^CR-[0-9]{4}-[0-9]{6}$/);
const name = z.string().nullable();

// ---------------------------------------------------------------------------
// R-G1
// ---------------------------------------------------------------------------

export const ConfirmedServiceSchema = z
  .object({
    itemId: z.uuid(),
    itemNo: z.number().int().positive(),
    serviceTitle: z.string(),
    department: z.string(),
    taskStatus: z.string(),
    /** Managers and Accounts only (null for the Sales owner). */
    supplierName: name,
    reference: name,
  })
  .strict();
export type ConfirmedService = z.infer<typeof ConfirmedServiceSchema>;

export const ReconfirmationLineSchema = z
  .object({
    taskId: z.uuid(),
    serviceTitle: z.string(),
    status: z.enum(RECONFIRM_STATUSES),
    overBudget: z.boolean(),
    refusedReason: z.string().nullable(),
  })
  .strict();
export type ReconfirmationLine = z.infer<typeof ReconfirmationLineSchema>;

export const RemovalChargeStateSchema = z
  .object({ department: z.enum(CHARGE_DEPARTMENTS), enteredByName: name, complete: z.boolean() })
  .strict();
export type RemovalChargeState = z.infer<typeof RemovalChargeStateSchema>;

/** Track H: a service of the accepted version that may be removed, and how (11.3). */
export const RemovableServiceSchema = z
  .object({
    itemId: z.uuid(),
    itemNo: z.number().int().positive(),
    serviceTitle: z.string(),
    department: z.string(),
    route: z.enum(REMOVAL_ROUTES),
  })
  .strict();
export type RemovableService = z.infer<typeof RemovableServiceSchema>;

export const ChangeRequestSchema = z
  .object({
    id: z.uuid(),
    refNo,
    kind: z.enum(CHANGE_KINDS),
    status: z.enum(CHANGE_STATUSES),
    itemNos: z.array(z.number().int().positive()),
    changeSummary: z.string(),
    reason: z.string(),
    requestedByName: name,
    requestedAt: timestamp,
    decidedByName: name,
    decidedAt: timestamp.nullable(),
    returnReason: z.string().nullable(),
    changeVersionId: z.uuid().nullable(),
    reconfirmations: z.array(ReconfirmationLineSchema),
    closeReason: z.string().nullable(),
    rowVersion: z.number().int().positive(),
    /** Track H: remove_service only (null otherwise). */
    removalRoute: z.enum(REMOVAL_ROUTES).nullable().optional(),
    /** Track H: what the customer is charged for dropping a booked service (route cancellation only). */
    customerChargePaise: paise.nullable().optional(),
    /** Track H: per department of a booked removal, whether the supplier charges are entered ([] otherwise). */
    charges: z.array(RemovalChargeStateSchema).optional(),
    can: z.object({ resubmit: z.boolean(), withdraw: z.boolean(), openVersion: z.boolean(), submit: z.boolean() }).strict(),
  })
  .strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

export const DealChangeRequestsSchema = z
  .object({
    dealId: z.uuid(),
    enabled: z.boolean(),
    canRequest: z.boolean(),
    /** CHANGE_BLOCK_CODES; an unknown code from a newer server is kept (generic words). */
    blockedBy: z.array(code),
    /** Track H: booking_change_settings.service_changes_enabled. */
    serviceChangesEnabled: z.boolean().optional(),
    /** Track H: SERVICE_BLOCK_CODES - why a service cannot be added or removed now (unknown codes kept). */
    serviceBlockedBy: z.array(code).optional(),
    /** Track H: the service types the caller may add now ([] = adding is not possible for this caller now). */
    addableTypes: z.array(z.enum(ADDABLE_SERVICE_TYPES)).optional(),
    /** Track H: the services the caller may ask to remove now, with the route ([] = removing is not possible now). */
    removable: z.array(RemovableServiceSchema).optional(),
    confirmed: z.array(ConfirmedServiceSchema),
    requests: z.array(ChangeRequestSchema),
  })
  .strict();
export type DealChangeRequests = z.infer<typeof DealChangeRequestsSchema>;

// ---------------------------------------------------------------------------
// R-H2 (Addendum O2): the accepted booking and the change version side by side
// (selling total, payment plan, services) - branch Manager / Approver,
// Accounts and the Sales owner; null for Purchase, Flight and Visa.
// ---------------------------------------------------------------------------

export const ReviewVersionSchema = z
  .object({
    versionId: z.uuid(),
    versionNo: z.number().int().positive(),
    status: z.string(),
    tripStart: z.string().nullable(),
    tripEnd: z.string().nullable(),
    sellingTotalPaise: paise.nullable(),
    plan: z.array(z.object({ seq: z.number().int().positive(), label: z.string().nullable(), amountPaise: paise, dueDate: z.string().nullable() })
      .strict()),
    services: z.array(z.object({
      itemId: z.uuid(),
      itemNo: z.number().int().positive(),
      serviceType: z.string(),
      serviceTitle: z.string(),
      facts: z.record(z.string(), z.unknown()),
      budgetPaise: paise.nullable(),
    }).strict()),
  })
  .strict();
export type ReviewVersion = z.infer<typeof ReviewVersionSchema>;

export const ChangeReviewSchema = z
  .object({
    changeRequestId: z.uuid(),
    refNo,
    kind: z.enum(CHANGE_KINDS),
    status: z.enum(CHANGE_STATUSES),
    rowVersion: z.number().int().positive(),
    removalRoute: z.enum(REMOVAL_ROUTES).nullable(),
    customerChargePaise: paise.nullable(),
    base: ReviewVersionSchema,
    /** Null until the change version is opened. */
    proposed: ReviewVersionSchema.nullable(),
    changedItemIds: z.array(z.uuid()),
    changedFields: z.array(z.string()),
    /** The version sent to the Manager is unchanged since it was sent. */
    sentVersionCurrent: z.boolean(),
    /** The caller may approve or return it now (an Approver, not the requester, status requested). */
    canDecide: z.boolean(),
  })
  .strict();
export type ChangeReview = z.infer<typeof ChangeReviewSchema>;

// ---------------------------------------------------------------------------
// R-H1 (track H): the supplier charges of a booked removal - branch Manager
// (and the LD37 Approver) and Accounts only; null for everyone else.
// ---------------------------------------------------------------------------

export const RemovalChargeLineSchema = z
  .object({
    department: z.enum(CHARGE_DEPARTMENTS),
    /** The task (Purchase), ticket batch (Flight) or company-paid fee entry (Visa) charged. */
    subjectId: z.uuid(),
    /** Service title, "Ticket batch N" or the Visa fee kind. */
    label: z.string(),
    supplierName: name,
    /** Purchase: the task's latest cost; Flight: the batch's supplier cost; Visa: the fee paid. */
    costPaise: paise.nullable(),
    /** What the supplier keeps (Flight: the airline charge; Visa: fee minus refund). Null until entered. */
    supplierKeepsPaise: paise.nullable(),
    /** What the supplier owes back. Null until entered. */
    refundExpectedPaise: paise.nullable(),
    revisionNo: z.number().int().nonnegative(),
    enteredByName: name,
    enteredAt: timestamp.nullable(),
    complete: z.boolean(),
  })
  .strict();
export type RemovalChargeLine = z.infer<typeof RemovalChargeLineSchema>;

export const ServiceRemovalChargesSchema = z
  .object({
    changeRequestId: z.uuid(),
    refNo,
    dealId: z.uuid(),
    status: z.enum(CHANGE_STATUSES),
    removalRoute: z.enum(REMOVAL_ROUTES).nullable(),
    customerChargePaise: paise.nullable(),
    itemNo: z.number().int().positive().nullable(),
    serviceTitle: z.string().nullable(),
    /** Every charge is entered (the Manager may approve). */
    complete: z.boolean(),
    charges: z.array(RemovalChargeLineSchema),
    totals: z.object({ supplierKeepsPaise: paise, refundExpectedPaise: paise }).strict(),
  })
  .strict();
export type ServiceRemovalCharges = z.infer<typeof ServiceRemovalChargesSchema>;

// ---------------------------------------------------------------------------
// R-G2
// ---------------------------------------------------------------------------

export const ChangeRequestRowSchema = z
  .object({
    id: z.uuid(),
    refNo,
    dealId: z.uuid(),
    dealReference: z.string(),
    dealTitle: z.string().nullable(),
    branchName: z.string(),
    kind: z.enum(CHANGE_KINDS),
    status: z.enum(CHANGE_STATUSES),
    itemNos: z.array(z.number().int().positive()),
    changeSummary: z.string(),
    reason: z.string(),
    requestedByName: name,
    requestedAt: timestamp,
    rowVersion: z.number().int().positive(),
    /** The caller is an Approver of this request (never the requester, Accounts or Sales). */
    can: z.object({ approve: z.boolean(), return: z.boolean() }).strict(),
  })
  .strict();
export type ChangeRequestRow = z.infer<typeof ChangeRequestRowSchema>;

export const ChangeRequestsPageSchema = z
  .object({
    items: z.array(ChangeRequestRowSchema),
    /** Keyset cursor "<requestedAt ISO>|<id>"; null = that is all. */
    nextAfter: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type ChangeRequestsPage = z.infer<typeof ChangeRequestsPageSchema>;

export interface ChangeRequestsFilter {
  preset?: 'all' | 'open' | 'to_approve';
  branchId?: string;
  dealReference?: string;
}

// ---------------------------------------------------------------------------
// R-G3 (Purchase and the branch Manager; never a selling price)
// ---------------------------------------------------------------------------

const safeDetails = z.record(z.string(), z.unknown()).transform((d) => safeFacts(d));

export const TaskReconfirmationSchema = z
  .object({
    taskId: z.uuid(),
    changeRequest: z.object({ refNo, status: z.enum(CHANGE_STATUSES) }).strict(),
    old: z
      .object({ details: safeDetails, ratePaise: paise.nullable(), reference: z.string().nullable(), confirmedAt: timestamp.nullable() })
      .strict(),
    new: z.object({ details: safeDetails, changedFields: z.array(z.string()) }).strict(),
    reconfirmation: z
      .object({
        id: z.uuid(),
        status: z.enum(RECONFIRM_STATUSES),
        newRatePaise: paise.nullable(),
        supplierFeePaise: paise.nullable(),
        newReference: z.string().nullable(),
        evidenceId: z.uuid().nullable(),
        overBudget: z.boolean(),
        budgetPaise: paise.nullable(),
        refusedReason: z.string().nullable().optional(),
        rowVersion: z.number().int().positive(),
      })
      .strict(),
    /** uploadProof: purchase_evidence_begin accepts the reconfirmation proof now (absent on an older database). */
    can: z
      .object({ record: z.boolean(), refuse: z.boolean(), approveOverBudget: z.boolean(), uploadProof: z.boolean().optional().transform((v) => v ?? false) })
      .strict(),
  })
  .strict();
export type TaskReconfirmation = z.infer<typeof TaskReconfirmationSchema>;

// ---------------------------------------------------------------------------
// R-G4
// ---------------------------------------------------------------------------

export const ChangeHistorySchema = z
  .object({
    dealId: z.uuid(),
    versions: z.array(
      z
        .object({
          versionNo: z.number().int().positive(),
          status: z.string(),
          confirmedAt: timestamp.nullable(),
          changedFields: z.array(z.string()),
          changeRequest: z
            .object({ refNo, kind: z.enum(CHANGE_KINDS), requestedByName: name, decidedByName: name })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    confirmations: z.array(
      z
        .object({
          taskId: z.uuid(),
          serviceTitle: z.string(),
          confirmationNo: z.number().int().positive(),
          /** Managers, Accounts and the task's Purchase person; null for the Sales owner. */
          supplierName: name,
          reference: name,
          confirmedByName: name,
          confirmedAt: timestamp,
          /** Managers and Accounts only: absent for everyone else. */
          amountPaise: paise.optional(),
          changeFeePaise: paise.nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChangeHistory = z.infer<typeof ChangeHistorySchema>;

// ---------------------------------------------------------------------------
// Change-mode preview (booking_change_preview; reported to the lead as an addition)
// ---------------------------------------------------------------------------

export const ChangePreviewSchema = z
  .object({
    changeRequestId: z.uuid(),
    refNo,
    kind: z.enum(CHANGE_KINDS),
    status: z.enum(CHANGE_STATUSES),
    changeSummary: z.string(),
    versionId: z.uuid().nullable(),
    rowVersion: z.number().int().positive().nullable(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    requestItemIds: z.array(z.uuid()),
    changedItemIds: z.array(z.uuid()),
    itemNos: z.record(z.string(), z.number().int().positive()),
    outsideItemNos: z.array(z.number().int().positive()),
    changedFields: z.array(z.string()),
    issues: z.array(code),
    canSubmit: z.boolean(),
  })
  .strict();
export type ChangePreview = z.infer<typeof ChangePreviewSchema>;

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export const ChangeRequestResultSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'existing']),
    changeRequestId: z.uuid(),
    dealId: z.uuid(),
    refNo,
    kind: z.enum(CHANGE_KINDS),
    status: z.enum(CHANGE_STATUSES),
    changeVersionId: z.uuid().nullable(),
    rowVersion: z.number().int().positive(),
    reconfirmations: z.number().int().nonnegative().optional(),
    applied: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<ChangeRequestResult>;

export const ChangeVersionResultSchema = z
  .object({
    outcome: z.enum(['created', 'existing']),
    changeRequestId: z.uuid(),
    versionId: z.uuid(),
    versionNo: z.number().int().positive(),
    rowVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict() satisfies z.ZodType<ChangeVersionResult>;

export const ReconfirmationResultSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'existing']),
    reconfirmationId: z.uuid(),
    taskId: z.uuid(),
    changeRequestId: z.uuid(),
    status: z.enum(RECONFIRM_STATUSES),
    overBudget: z.boolean(),
    rowVersion: z.number().int().positive(),
    changeRequestStatus: z.enum(CHANGE_STATUSES),
  })
  .strict() satisfies z.ZodType<ReconfirmationResult>;

export const ChangeSwitchResultSchema = z
  .object({
    changed: z.boolean(),
    changesEnabled: z.boolean(),
    serviceChangesEnabled: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<ChangeSwitchResult>;
