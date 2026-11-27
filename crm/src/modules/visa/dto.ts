import { z } from 'zod';
import { VisaApplicantCancellationSchema, VisaCancellationSchema } from '@/modules/cancellations/dto';

/**
 * Visa and Passport desk DTO schemas (Visa build contract, frozen 8 Nov 2026,
 * sections 6, 8 and 9; migrations 20261202000100..0199). Every key the
 * database returns is listed: zod strips unknown keys, so a key missing here
 * never reaches a page. Keys the contract marks "| null" also accept an
 * absent key (read as null); booleans, counts and lists are required.
 *
 * Fences (section 9): no schema in this file has a selling price, list
 * price, discount, margin, plan, customer receipt, customer money, billing
 * or Deal contact key. The passport object exists only on the workspace and
 * is filled only for the task assignee (the database decides); Deal reads
 * carry no paise, reference, e-mail or passport number.
 *
 * Pure module (no server imports): screens import the types through
 * contracts.ts.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const timestamp = z.string().min(1);
const count = z.number().int().nonnegative();
const rowVersion = z.number().int().positive();
const seq = z.number().int().positive();
const name = z.string().min(1).max(200);
const text = (max: number) => z.string().min(1).max(max);
/** bigint paise from jsonb (number or decimal string) -> decimal string; never a float. */
const paise = z
  .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,17})$/)])
  .transform(String);
/** A "| null" key: null or absent both read as null. */
const nul = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
/** A permission or state flag the SQL may answer null for: null never grants a right. */
const flag = z.boolean().nullable().optional().transform((v) => v ?? false);

// ---------------------------------------------------------------------------
// Code lists (frozen)
// ---------------------------------------------------------------------------

export const VISA_SERVICE_TYPES = ['visa', 'passport'] as const;
export const VISA_TASK_STATUS_CODES = ['not_taken', 'in_progress', 'completed'] as const;
export const VISA_TASK_STEPS = ['ready', 'applied', 'decision', 'handover'] as const;
export const VISA_STEP_KEYS = ['take', 'ready', 'applied', 'decision', 'handover'] as const;
export const VISA_APPLICATION_STATES = ['docs_pending', 'submitted', 'decision_pending', 'issued', 'refused', 'withdrawn'] as const;
/** Section 4 "Ready" tokens, in the database's order. */
export const VISA_NOT_READY_TOKENS = [
  'removed',
  'superseded',
  'wrong_state',
  'traveller_changed',
  'no_documents',
  'documents_missing',
  'appointment_missing',
  'kind_missing',
] as const;
export const VISA_KINDS = ['e_visa', 'sticker'] as const;
export const VISA_KIND_SOURCES = ['sales', 'desk', 'applied'] as const;
export const VISA_DOCUMENT_SOURCES = ['sales', 'desk', 'legacy', 'copied'] as const;
export const VISA_DOCUMENT_STATUSES = ['not_received', 'received'] as const;
export const VISA_OUTCOMES = ['approved', 'rejected', 'withdrawn'] as const;
export const VISA_HANDOVER_KINDS = ['evisa', 'method', 'customer_told', 'legacy_returned'] as const;
export const VISA_HANDOVER_METHODS = ['office', 'executive', 'courier', 'not_with_us'] as const;
export const VISA_CLOSED_REASONS = [
  'evisa_sent',
  'refusal_told',
  'not_with_us',
  'courier_dispatched',
  'delivered',
  'customer_informed',
  'reapplied',
  'legacy',
] as const;
/** Section 16 (VL18 changed): 'other' visa costs per passenger (courier etc.). */
export const VISA_COST_KINDS = ['government_fee', 'service_fee', 'other'] as const;
export const VISA_PAID_BY = ['company', 'customer_direct', 'not_yet'] as const;
export const VISA_PAYMENT_MODES = ['bank_transfer', 'upi', 'card', 'cash', 'other'] as const;
export const VISA_EXPENSE_STATUSES = ['draft', 'submitted', 'accepted', 'returned'] as const;
export const VISA_TRAVELLER_TYPES = ['adult', 'child', 'infant'] as const;
export const VISA_EVIDENCE_KINDS = ['applicant_document', 'fee_receipt', 'authority_outcome', 'other'] as const;
export const VISA_EVIDENCE_STATUSES = ['pending_upload', 'stored', 'failed', 'removed'] as const;
export const VISA_EVIDENCE_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const VISA_NOTICE_OUTCOMES = ['approved', 'rejected'] as const;
export const VISA_COMMAND_OUTCOMES = ['created', 'updated', 'existing'] as const;
export const VISA_DEAL_HISTORY_KINDS = [
  'taken',
  'applied',
  'approved',
  'rejected',
  'withdrawn',
  'evisa_sent',
  'handed_over',
  'delivered',
  'reapplied',
  'completed',
] as const;

const SERVICE_TYPE = z.enum(VISA_SERVICE_TYPES);
const PAX = z.enum(VISA_TRAVELLER_TYPES);
const COST_KIND = z.enum(VISA_COST_KINDS);
const PAID_BY = z.enum(VISA_PAID_BY);
const EXPENSE_STATUS = z.enum(VISA_EXPENSE_STATUSES);

export const VisaTaskStatusSchema = z.object({
  code: z.enum(VISA_TASK_STATUS_CODES),
  step: nul(z.enum(VISA_TASK_STEPS)),
  text: z.string().min(1).max(200),
});

const FileRefSchema = z.object({ evidenceId: z.uuid(), fileName: text(120) });

// ---------------------------------------------------------------------------
// 9.1 visa_queue
// ---------------------------------------------------------------------------

export const VisaQueueTaskSchema = z.object({
  taskId: z.uuid(),
  serviceType: SERVICE_TYPE,
  dealReference: z.string().min(1).max(120),
  branchName: z.string().max(200),
  title: z.string().max(300),
  factsLine: z.string().max(500),
  travelDate: nul(isoDate),
  status: VisaTaskStatusSchema,
  applicantCount: count,
  readyCount: count,
  appliedCount: count,
  decidedCount: count,
  closedCount: count,
  assigneeName: nul(name),
  assignedToYou: flag,
  createdAt: timestamp,
  /** 20261202000140: this task can be taken by the caller (not taken, active Visa role in its entity). */
  canTake: flag,
  /** 20261202000140: the caller reads this task as the branch Manager (no Visa role in its entity). */
  isManagerView: flag,
});

export const VisaQueueSchema = z.object({
  isManagerView: flag,
  canTake: flag,
  tasks: z.array(VisaQueueTaskSchema),
});

// ---------------------------------------------------------------------------
// 9.2 visa_workspace
// ---------------------------------------------------------------------------

/** Sales' typed facts as stored (dates are YYYY-MM-DD from the booking form; not re-checked here). */
const factText = (max: number) => nul(z.string().max(max));

export const VisaFactsSchema = z.object({
  country: nul(z.string().max(200)),
  purpose: nul(z.string().max(200)),
  travelDate: factText(40),
  applyBy: factText(40),
  feePaidBy: nul(z.string().max(60)),
  notes: nul(z.string().max(2000)),
  visaKind: nul(z.enum(VISA_KINDS)),
  jurisdiction: nul(z.enum(['yes', 'no'])),
  jurisdictionPlace: nul(z.string().max(120)),
  documentsNeeded: z.array(z.string().max(120)).max(30).nullable().optional().transform((v) => v ?? []),
});

export const PassportFactsSchema = z.object({
  applicationType: nul(z.string().max(120)),
  officeCity: nul(z.string().max(200)),
  neededBy: factText(40),
  notes: nul(z.string().max(2000)),
});

/** Exactly one of `visa` / `passport` (the service type decides which). */
export const VisaWorkspaceFactsSchema = z.union([
  z.object({ visa: VisaFactsSchema }),
  z.object({ passport: PassportFactsSchema }),
]);

export const VisaStepSchema = z.object({
  key: z.enum(VISA_STEP_KEYS),
  label: z.string().min(1).max(60),
  met: count,
  of: count,
  done: flag,
});

const SeqName = z.object({ seq, name: nul(name) });

export const VisaBookingChangeSchema = z.object({
  versionNo: z.number().int().positive(),
  at: timestamp,
  added: z.array(SeqName),
  removed: z.array(SeqName),
  /** Section 16: re-linking by name is withdrawn; kept for older audit rows (normally empty). */
  back: z.array(SeqName).optional().transform((v) => v ?? []),
  renamed: z.array(z.object({ seq, oldName: nul(name), newName: nul(name) })),
  documentsAdded: count,
  fields: z.array(z.string().max(200)),
});

export const VisaDocumentSchema = z.object({
  documentId: z.uuid(),
  catalogueCode: nul(z.string().regex(/^[a-z0-9_]{1,60}$/)),
  label: text(120),
  status: z.enum(VISA_DOCUMENT_STATUSES),
  source: z.enum(VISA_DOCUMENT_SOURCES),
  remark: nul(z.string().max(300)),
  receivedAt: nul(timestamp),
  files: z.array(FileRefSchema).optional().transform((v) => v ?? []),
});

export const VisaFeeSchema = z.object({
  entryId: z.uuid(),
  costKind: COST_KIND,
  amountPaise: paise,
  paidBy: PAID_BY,
  paymentMode: nul(z.enum(VISA_PAYMENT_MODES)),
  expenseStatus: nul(EXPENSE_STATUS),
  returnReason: nul(z.string().max(500)),
  rowVersion,
  receipt: nul(FileRefSchema),
});

export const VisaApplicantCanSchema = z.object({
  edit: flag,
  select: flag,
  decide: flag,
  handover: flag,
  deliver: flag,
  withdraw: flag,
  reapply: flag,
  confirmTraveller: flag,
});

export const VisaApplicantSchema = z.object({
  applicationId: z.uuid(),
  seq,
  fullName: nul(name),
  type: nul(PAX),
  ageYears: nul(z.number().int().nonnegative()),
  rowVersion,
  state: z.enum(VISA_APPLICATION_STATES),
  stateText: z.string().min(1).max(200),
  ready: flag,
  /** Unknown tokens a newer database adds are dropped (never shown as raw codes). */
  notReady: z
    .array(z.string())
    .transform((items) => items.filter((t): t is (typeof VISA_NOT_READY_TOKENS)[number] => (VISA_NOT_READY_TOKENS as readonly string[]).includes(t))),
  removed: flag,
  superseded: flag,
  secondApplication: flag,
  previousApplicationId: nul(z.uuid()),
  travellerChanged: nul(z.object({ was: nul(name), now: nul(name) })),
  /** Assignee only (database rule); null for everyone else, never a masked number. */
  passport: nul(z.object({ number: nul(z.string().max(30)), identityRowVersion: nul(z.number().int().nonnegative()) })),
  visaKind: z.object({ value: nul(z.enum(VISA_KINDS)), source: nul(z.enum(VISA_KIND_SOURCES)) }),
  jurisdiction: z.object({ required: nul(z.boolean()), place: nul(z.string().max(120)), source: nul(z.enum(VISA_KIND_SOURCES)) }),
  appointment: z.object({ date: nul(isoDate), time: nul(clock) }),
  remark: nul(z.string().max(300)),
  documents: z.array(VisaDocumentSchema).max(200),
  documentsReceived: count,
  documentsTotal: count,
  applied: nul(z.object({
    reference: nul(z.string().max(120)),
    appliedOn: nul(isoDate),
    clubId: nul(z.uuid()),
    clubWith: z.array(name).optional().transform((v) => v ?? []),
    remark: nul(z.string().max(300)),
    passportTaken: flag,
  })),
  decision: nul(z.object({
    outcome: z.enum(VISA_OUTCOMES),
    at: nul(timestamp),
    remark: nul(z.string().max(300)),
    reason: nul(z.string().max(300)),
    proof: nul(FileRefSchema),
  })),
  handover: nul(z.object({
    kind: nul(z.enum(VISA_HANDOVER_KINDS)),
    /** Visa desk readers and the branch Manager only (VL24); the database leaves it out elsewhere. */
    recipientEmail: nul(z.string().max(200)),
    sentAt: nul(timestamp),
    method: nul(z.enum(VISA_HANDOVER_METHODS)),
    courierNumber: nul(z.string().max(80)),
    deliveredOn: nul(isoDate),
    remark: nul(z.string().max(300)),
  })),
  closed: nul(z.object({ at: timestamp, reason: z.enum(VISA_CLOSED_REASONS) })),
  fees: z.array(VisaFeeSchema),
  can: VisaApplicantCanSchema,
}).extend(VisaApplicantCancellationSchema.shape);

export const VisaPreviousApplicationSchema = z.object({
  applicationId: z.uuid(),
  seq,
  reference: nul(z.string().max(120)),
  state: z.enum(VISA_APPLICATION_STATES),
  closed: flag,
  decision: nul(z.enum(VISA_OUTCOMES)),
});

export const VisaCostSummarySchema = z.object({
  travellers: z.array(z.object({
    seq,
    name: nul(name),
    governmentFeePaise: nul(paise),
    serviceFeePaise: nul(paise),
    /** Section 16 (VL18 changed, 20261202000140): sum of the traveller's "other" visa costs; null when none. */
    otherPaise: nul(paise),
    paidBy: nul(PAID_BY),
    expenseStatus: nul(EXPENSE_STATUS),
    state: nul(z.enum(VISA_APPLICATION_STATES)),
  })),
  taskLevel: z.array(z.object({
    entryId: z.uuid(),
    costKind: z.enum(['government_fee', 'service_fee', 'fare', 'other']),
    amountPaise: paise,
    paidBy: PAID_BY,
    expenseStatus: nul(EXPENSE_STATUS),
  })),
  companyTotalPaise: paise,
  customerDirectTotalPaise: paise,
});

export const VisaReturnedFeeSchema = z.object({
  entryId: z.uuid(),
  applicantName: nul(name),
  costKind: COST_KIND,
  amountPaise: paise,
  returnReason: nul(z.string().max(500)),
  rowVersion,
});

export const VisaFileSchema = z.object({
  evidenceId: z.uuid(),
  kind: z.enum(VISA_EVIDENCE_KINDS),
  applicationId: nul(z.uuid()),
  fileName: z.string().max(120),
  mime: nul(z.enum(VISA_EVIDENCE_MIMES)),
  sizeBytes: count,
  status: z.enum(VISA_EVIDENCE_STATUSES),
  uploadedByYou: flag,
  createdAt: timestamp,
  visaDocumentId: nul(z.uuid()),
  applicantSeq: nul(seq),
});

export const VisaWorkspaceSchema = z.object({
  taskId: z.uuid(),
  serviceType: SERVICE_TYPE,
  dealId: z.uuid(),
  dealReference: z.string().min(1).max(120),
  branchName: z.string().max(200),
  title: z.string().max(300),
  status: VisaTaskStatusSchema,
  assignee: z.object({ name: nul(name), isYou: flag, takenAt: nul(timestamp) }),
  canClaim: flag,
  canWork: flag,
  isManagerView: flag,
  versionNo: z.number().int().positive(),
  confirmedAt: nul(timestamp),
  facts: VisaWorkspaceFactsSchema,
  steps: z.array(VisaStepSchema),
  bookingChange: nul(VisaBookingChangeSchema),
  addedAfterCompletion: count,
  applicants: z.array(VisaApplicantSchema).max(200),
  previousApplications: z.array(VisaPreviousApplicationSchema).optional().transform((v) => v ?? []),
  readyCount: count,
  appliedCount: count,
  /** Visa desk readers and the branch Manager (section 11.1); null when the database leaves it out. */
  costSummary: nul(VisaCostSummarySchema),
  returnedFees: z.array(VisaReturnedFeeSchema).optional().transform((v) => v ?? []),
  /** Assignee only. */
  catalogue: z.array(z.object({ code: z.string().regex(/^[a-z0-9_]{1,60}$/), label: text(120) })).optional().transform((v) => v ?? []),
  files: z.array(VisaFileSchema).optional().transform((v) => v ?? []),
  canUpload: flag,
  /** 20261202000140: the caller may record, fix and send this task's visa fees and other costs. */
  canManageFees: flag,
  /** Accounts phase 2 (Track C, LD12): the Deal's trip cancellation; null when none. */
  cancellation: VisaCancellationSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// 9.3 Deal reads (no money, no identity, no reference, no e-mail)
// ---------------------------------------------------------------------------

export const DealVisaTaskSchema = z.object({
  taskId: z.uuid(),
  serviceType: SERVICE_TYPE,
  title: z.string().max(300),
  status: VisaTaskStatusSchema,
  applicantCount: count,
  approved: count,
  rejected: count,
  withdrawn: count,
  waiting: count,
  addedAfterCompletion: count,
});

export const DealVisaNoticeSchema = z.object({
  noticeId: z.uuid(),
  taskId: z.uuid(),
  title: z.string().max(300),
  travellerName: nul(name),
  outcome: z.enum(VISA_NOTICE_OUTCOMES),
  at: timestamp,
  reason: nul(z.string().max(300)),
  seen: flag,
  canAck: flag,
});

export const DealVisaSummarySchema = z.object({
  tasks: z.array(DealVisaTaskSchema),
  notices: z.array(DealVisaNoticeSchema).optional().transform((v) => v ?? []),
});

const CLUB_NOTE = /^Applied together: (\d{1,3}) travellers$/;

export const DealVisaHistoryEventSchema = z
  .object({
    at: timestamp,
    kind: z.enum(VISA_DEAL_HISTORY_KINDS),
    taskId: z.uuid(),
    title: z.string().max(300),
    travellerName: nul(name),
    byName: nul(name),
    byYou: flag,
    note: nul(z.string().max(500)),
    clubSize: nul(z.number().int().min(2).max(100)),
  })
  /**
   * Collapsed club (20261202000120 writes "Applied together: {n} travellers" as
   * the note of the one applied event left): read as clubSize, note cleared.
   */
  .transform((e) => {
    const m = e.kind === 'applied' && e.clubSize === null && e.note ? CLUB_NOTE.exec(e.note) : null;
    return m ? { ...e, clubSize: Number(m[1]), note: null } : e;
  });

export const DealVisaHistorySchema = z.object({
  /** Unknown kinds a newer database adds are dropped (never shown as raw codes). */
  events: z
    .array(z.unknown())
    .max(200)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = DealVisaHistoryEventSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  truncated: flag,
});

// ---------------------------------------------------------------------------
// Section 8 visa_home_counts (keys null when not applicable to the caller)
// ---------------------------------------------------------------------------

const homeCount = nul(count);
const homeLink = nul(z.uuid());

export const VisaHomeCountsSchema = z.object({
  visaApplicantsWaitingResult: homeCount,
  visaApplicantsWaitingResultTaskId: homeLink,
  visaHandoverPending: homeCount,
  visaHandoverPendingTaskId: homeLink,
  visaFeesReturned: homeCount,
  visaFeesReturnedTaskId: homeLink,
  visaFeesWithoutReceipt: homeCount,
  visaFeesWithoutReceiptTaskId: homeLink,
  visaTravellerChanged: homeCount,
  visaTravellerChangedTaskId: homeLink,
  salesVisaResultsToSee: homeCount,
  salesVisaResultsDealId: homeLink,
});

// ---------------------------------------------------------------------------
// Command results (section 6)
// ---------------------------------------------------------------------------

const outcome = z.enum(VISA_COMMAND_OUTCOMES).optional().transform((v) => v ?? 'updated');

/** C1 visa_task_claim. */
export const VisaClaimResultSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(['not_started', 'in_progress', 'completed']),
  assignedToYou: z.literal(true),
  alreadyYours: flag,
  applicationCount: count.optional().transform((v) => v ?? 0),
});

/** C2 visa_application_set_row. */
export const VisaRowSaveResultSchema = z.object({
  outcome,
  applicationId: z.uuid(),
  rowVersion,
  ready: flag,
  notReady: VisaApplicantSchema.shape.notReady,
  taskCompleted: flag,
});

/** C3 / C4 document add and remove. */
export const VisaDocumentResultSchema = z.object({
  outcome,
  applicationId: z.uuid(),
  rowVersion,
  documentId: nul(z.uuid()),
  taskCompleted: flag,
});

/** C5 visa_applications_apply. */
export const VisaApplyResultSchema = z.object({
  outcome,
  clubId: nul(z.uuid()),
  applications: z.array(z.object({ applicationId: z.uuid(), rowVersion, state: z.enum(VISA_APPLICATION_STATES) })).min(1).max(100),
  entryIds: z.array(z.uuid()),
  taskCompleted: flag,
});

/** C6 - C9, C13: one application changed. */
export const VisaApplicationResultSchema = z.object({
  outcome,
  applicationId: z.uuid(),
  rowVersion,
  state: nul(z.enum(VISA_APPLICATION_STATES)),
  closed: flag,
  taskCompleted: flag,
});

/** C10 visa_application_reapply. */
export const VisaReapplyResultSchema = z.object({
  outcome,
  applicationId: z.uuid(),
  rowVersion,
  previousApplicationId: z.uuid(),
  taskCompleted: flag,
});

/** C12 visa_fee_send. */
export const VisaFeeSendResultSchema = z.object({
  outcome,
  entryId: z.uuid(),
  rowVersion,
  expenseStatus: nul(EXPENSE_STATUS),
});

/** Section 16: department_cost_save for an "other" visa cost of one passenger. */
export const VisaOtherCostResultSchema = z.object({
  entryId: z.uuid(),
  rowVersion,
  expenseStatus: nul(EXPENSE_STATUS),
});

/** C14 visa_result_notice_ack. */
export const VisaNoticeAckResultSchema = z.object({
  outcome,
  noticeId: z.uuid(),
});

/** Server-generated <entity>/<task>/<evidence id>; no traversal, no leading slash. */
const objectPath = z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i);

/** C11 visa_document_file_begin and department_evidence_begin. */
export const VisaEvidenceBegunSchema = z.object({ evidenceId: z.uuid(), objectPath });
export const VisaEvidenceFinishedSchema = z.object({ evidenceId: z.uuid(), status: z.enum(VISA_EVIDENCE_STATUSES) });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisaTaskStatusDTO = z.output<typeof VisaTaskStatusSchema>;
export type VisaQueueTaskDTO = z.output<typeof VisaQueueTaskSchema>;
export type VisaQueueDTO = z.output<typeof VisaQueueSchema>;
export type VisaFactsDTO = z.output<typeof VisaFactsSchema>;
export type PassportFactsDTO = z.output<typeof PassportFactsSchema>;
export type VisaWorkspaceFactsDTO = z.output<typeof VisaWorkspaceFactsSchema>;
export type VisaStepDTO = z.output<typeof VisaStepSchema>;
export type VisaBookingChangeDTO = z.output<typeof VisaBookingChangeSchema>;
export type VisaDocumentDTO = z.output<typeof VisaDocumentSchema>;
export type VisaFeeDTO = z.output<typeof VisaFeeSchema>;
export type VisaApplicantCanDTO = z.output<typeof VisaApplicantCanSchema>;
export type VisaApplicantDTO = z.output<typeof VisaApplicantSchema>;
export type VisaPreviousApplicationDTO = z.output<typeof VisaPreviousApplicationSchema>;
export type VisaCostSummaryDTO = z.output<typeof VisaCostSummarySchema>;
export type VisaReturnedFeeDTO = z.output<typeof VisaReturnedFeeSchema>;
export type VisaFileDTO = z.output<typeof VisaFileSchema>;
export type VisaWorkspaceDTO = z.output<typeof VisaWorkspaceSchema>;
export type DealVisaTaskDTO = z.output<typeof DealVisaTaskSchema>;
export type DealVisaNoticeDTO = z.output<typeof DealVisaNoticeSchema>;
export type DealVisaSummaryDTO = z.output<typeof DealVisaSummarySchema>;
export type DealVisaHistoryEventDTO = z.output<typeof DealVisaHistoryEventSchema>;
export type DealVisaHistoryDTO = z.output<typeof DealVisaHistorySchema>;
export type VisaHomeCountsDTO = z.output<typeof VisaHomeCountsSchema>;
export type VisaClaimResult = z.output<typeof VisaClaimResultSchema>;
export type VisaRowSaveResult = z.output<typeof VisaRowSaveResultSchema>;
export type VisaDocumentResult = z.output<typeof VisaDocumentResultSchema>;
export type VisaApplyResult = z.output<typeof VisaApplyResultSchema>;
export type VisaApplicationResult = z.output<typeof VisaApplicationResultSchema>;
export type VisaReapplyResult = z.output<typeof VisaReapplyResultSchema>;
export type VisaFeeSendResult = z.output<typeof VisaFeeSendResultSchema>;
export type VisaNoticeAckResult = z.output<typeof VisaNoticeAckResultSchema>;
export type VisaOtherCostResult = z.output<typeof VisaOtherCostResultSchema>;

export type VisaServiceType = (typeof VISA_SERVICE_TYPES)[number];
export type VisaTaskStatusCode = (typeof VISA_TASK_STATUS_CODES)[number];
export type VisaTaskStep = (typeof VISA_TASK_STEPS)[number];
export type VisaStepKey = (typeof VISA_STEP_KEYS)[number];
export type VisaApplicationState = (typeof VISA_APPLICATION_STATES)[number];
export type VisaNotReadyToken = (typeof VISA_NOT_READY_TOKENS)[number];
export type VisaKind = (typeof VISA_KINDS)[number];
export type VisaKindSource = (typeof VISA_KIND_SOURCES)[number];
export type VisaDocumentSource = (typeof VISA_DOCUMENT_SOURCES)[number];
export type VisaDocumentStatus = (typeof VISA_DOCUMENT_STATUSES)[number];
export type VisaOutcome = (typeof VISA_OUTCOMES)[number];
export type VisaHandoverKind = (typeof VISA_HANDOVER_KINDS)[number];
export type VisaHandoverMethod = (typeof VISA_HANDOVER_METHODS)[number];
export type VisaClosedReason = (typeof VISA_CLOSED_REASONS)[number];
export type VisaCostKind = (typeof VISA_COST_KINDS)[number];
export type VisaPaidBy = (typeof VISA_PAID_BY)[number];
export type VisaPaymentMode = (typeof VISA_PAYMENT_MODES)[number];
export type VisaExpenseStatus = (typeof VISA_EXPENSE_STATUSES)[number];
export type VisaEvidenceKind = (typeof VISA_EVIDENCE_KINDS)[number];
export type VisaNoticeOutcome = (typeof VISA_NOTICE_OUTCOMES)[number];
export type VisaDealHistoryKind = (typeof VISA_DEAL_HISTORY_KINDS)[number];
