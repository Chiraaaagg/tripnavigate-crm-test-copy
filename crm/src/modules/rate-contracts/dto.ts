import { z } from 'zod';
import {
  CONTRACT_COMPARE_STATES,
  MEAL_PLAN_CODES,
  RATE_CONTRACT_FILE_STATUSES,
  RATE_CONTRACT_STATUSES,
  RATE_LOOKUP_STATES,
} from './contracts';

/**
 * zod DTOs of the rate contract reads and command replies (contract 9.5,
 * migrations 20261205000510 / 0540). Every key is listed; unknown keys are
 * dropped (zod object default), so a read can never pass on a key the
 * contract does not name. No selling price, margin, dues or customer data
 * exists in any of them.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const name = z.string().nullable();
const status = z.enum(RATE_CONTRACT_STATUSES);
const meal = z.enum(MEAL_PLAN_CODES);

/** R-E1 row. */
export const RateContractRowSchema = z.object({
  contractId: z.uuid(),
  contractNo: z.string().regex(/^RC-\d{4}-\d{6}$/),
  versionNo: z.number().int().positive(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  hotelId: z.uuid(),
  hotelName: z.string(),
  city: z.string().nullable(),
  validFrom: isoDate,
  validTo: isoDate,
  daysLeft: z.number().int(),
  status,
  source: z.enum(['manual', 'import']),
  lineCount: z.number().int().min(0),
  enteredByName: name,
  submittedAt: timestamp.nullable(),
  rowVersion: z.number().int().positive(),
  /** The viewer entered it (cannot approve it: not_self_approval). Absent on an older database. */
  isMine: z.boolean().optional().transform((v) => v ?? false),
});
export type RateContractRow = z.infer<typeof RateContractRowSchema>;

export const RateContractPageSchema = z.object({
  items: z.array(RateContractRowSchema.extend({
    /** Waiting, the viewer is an Approver of the entity and did not enter it, switch On. */
    canApprove: z.boolean().optional().transform((v) => v ?? false),
  })),
  nextAfter: z.string().nullable(),
  hasMore: z.boolean(),
});
export type RateContractPage = z.infer<typeof RateContractPageSchema>;

export const RateLineSchema = z.object({
  lineId: z.uuid(),
  lineNo: z.number().int().positive(),
  seasonFrom: isoDate,
  seasonTo: isoDate,
  roomTypeId: z.uuid(),
  roomTypeName: z.string(),
  mealPlan: meal,
  ratePaise: paise,
  weekendRatePaise: paise.nullable(),
  extraAdultPaise: paise.nullable(),
  childWithBedPaise: paise.nullable(),
  childWithoutBedPaise: paise.nullable(),
  note: z.string().nullable(),
});
export type RateLine = z.infer<typeof RateLineSchema>;

export const RoomTypeSchema = z.object({
  roomTypeId: z.uuid(),
  name: z.string(),
  rowVersion: z.number().int().positive(),
  inUse: z.boolean(),
});
export type RoomType = z.infer<typeof RoomTypeSchema>;

/** R-E2. */
export const RateContractDetailSchema = RateContractRowSchema.extend({
  importBatchId: z.uuid().nullable(),
  cancellationTerms: z.string().nullable(),
  note: z.string().nullable(),
  enteredAt: timestamp,
  decidedByName: name,
  decidedAt: timestamp.nullable(),
  returnReason: z.string().nullable(),
  endedByName: name,
  endedAt: timestamp.nullable(),
  endReason: z.string().nullable(),
  lines: z.array(RateLineSchema),
  blackouts: z.array(z.object({ fromDate: isoDate, toDate: isoDate })),
  files: z.array(z.object({
    fileId: z.uuid(),
    fileName: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().positive(),
    status: z.enum(RATE_CONTRACT_FILE_STATUSES),
    uploadedAt: timestamp,
    uploadedByName: name,
  })),
  history: z.array(z.object({
    contractId: z.uuid(),
    contractNo: z.string(),
    versionNo: z.number().int().positive(),
    validFrom: isoDate,
    validTo: isoDate,
    status,
    decidedByName: name,
    decidedAt: timestamp.nullable(),
    endReason: z.string().nullable(),
  })),
  roomTypes: z.array(RoomTypeSchema),
  enabled: z.boolean(),
  can: z.object({ edit: z.boolean(), submit: z.boolean(), approve: z.boolean(), return: z.boolean(), end: z.boolean(), upload: z.boolean() }),
});
export type RateContractDetail = z.infer<typeof RateContractDetailSchema>;

/** 9.2 price result. */
export const RatePriceSchema = z.object({
  state: z.enum(RATE_LOOKUP_STATES),
  contractIds: z.array(z.uuid()),
  nights: z.array(z.object({ date: isoDate, ratePaise: paise, lineId: z.uuid(), weekend: z.boolean() })),
  perRoomTotalPaise: paise.nullable(),
  totalPaise: paise.nullable(),
  endedOn: isoDate.nullable(),
});
export type RatePrice = z.infer<typeof RatePriceSchema>;

/** A room type of the lookup (the database answers roomTypeId; an `id` alias is read too). */
const LookupRoomTypeSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('roomTypeId' in v) && 'id' in v ? { ...(v as Record<string, unknown>), roomTypeId: (v as { id: unknown }).id } : v),
  z.object({ roomTypeId: z.uuid(), name: z.string() }),
);

/** R-E3: the 9.2 result plus the hotel's room types. Supplier cost only. */
export const RateContractLookupSchema = RatePriceSchema.extend({
  roomTypes: z.array(LookupRoomTypeSchema),
});
export type RateContractLookup = z.infer<typeof RateContractLookupSchema>;

/** Choices for a new contract: active hotel suppliers and their linked hotels. */
export const RateContractChoicesSchema = z.object({
  suppliers: z.array(z.object({
    supplierId: z.uuid(),
    supplierName: z.string(),
    hotels: z.array(z.object({ hotelId: z.uuid(), name: z.string(), city: z.string().nullable() })),
  })),
});
export type RateContractChoices = z.infer<typeof RateContractChoicesSchema>;

// ---------------------------------------------------------------------------
// Command replies
// ---------------------------------------------------------------------------

export const ContractWriteSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  contractId: z.uuid(),
  contractNo: z.string(),
  versionNo: z.number().int().positive(),
  status,
  rowVersion: z.number().int().positive(),
  lineCount: z.number().int().min(0).optional(),
  blackoutCount: z.number().int().min(0).optional(),
  endedOlder: z.number().int().min(0).optional(),
});
export type ContractWrite = z.infer<typeof ContractWriteSchema>;

export const RoomTypeWriteSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  roomTypeId: z.uuid(),
  hotelId: z.uuid().optional(),
  name: z.string().optional(),
  rowVersion: z.number().int().positive(),
});
export type RoomTypeWrite = z.infer<typeof RoomTypeWriteSchema>;

export const FileBeginSchema = z.object({ fileId: z.uuid(), objectPath: z.string().min(1) });
export const FileFinishSchema = z.object({ fileId: z.uuid(), status: z.enum(RATE_CONTRACT_FILE_STATUSES) });
export const FileDownloadSchema = z.object({ objectPath: z.string().min(1), fileName: z.string(), mime: z.string() });

/** Switch state for the screens (P, M, A readers and Super Admins; null otherwise). */
export const RateContractsStateSchema = z.object({ enabled: z.boolean(), canSwitch: z.boolean() });
export type RateContractsState = z.infer<typeof RateContractsStateSchema>;

export const SwitchSchema = z.object({ changed: z.boolean(), before: z.boolean(), after: z.boolean(), updatedAt: timestamp });

/** Offer comparison flags on the Manager's over-budget row and on the go-ahead object (additive keys). */
export const ContractFlagsSchema = z.object({
  contractState: z.enum(CONTRACT_COMPARE_STATES).optional().transform((v) => v ?? 'none'),
  contractTotalPaise: paise.nullable().optional().transform((v) => v ?? null),
  contractDeviationReason: z.string().nullable().optional().transform((v) => v ?? null),
});
export type ContractFlags = z.infer<typeof ContractFlagsSchema>;

// ---------------------------------------------------------------------------
// Rate-sheet import (9.4)
// ---------------------------------------------------------------------------

const count = z.number().int().min(0);
const cell = z.string().nullable().optional().transform((v) => v ?? null);

export const RateSheetSummarySchema = z.object({
  batchId: z.uuid(),
  kind: z.literal('rate_sheet'),
  status: z.enum(['staged', 'validated', 'applied', 'cancelled']),
  rowVersion: z.number().int(),
  fileName: z.string(),
  rows: count,
  valid: count.optional(),
  invalid: count.optional(),
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  invalidRows: z.array(z.object({ rowNo: z.number().int(), reasons: z.array(z.string()) })).optional(),
  rateSheet: z.object({
    contracts: count,
    lines: count,
    newRoomTypes: count,
    invalidRows: count,
    warnings: z.object({ newRoomType: count, overlapsActiveContract: count }),
  }).optional(),
  appliedAt: z.string().nullable(),
  applyResult: z.object({ created: count, lines: count.optional(), roomTypes: count.optional(), invalid: count }).nullable(),
});
export type RateSheetSummary = z.infer<typeof RateSheetSummarySchema>;

export const RateSheetRowSchema = z.object({
  rowNo: z.number().int(),
  outcome: z.enum(['create', 'invalid']).nullable(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  targetId: z.uuid().nullable(),
  values: z.object({
    supplierRef: cell, hotelRef: cell, city: cell, validFrom: cell, validTo: cell, seasonFrom: cell, seasonTo: cell, roomType: cell,
    mealPlan: cell, rate: cell, weekendRate: cell, extraAdult: cell, childWithBed: cell, childWithoutBed: cell, blackoutDates: cell,
  }),
});
export type RateSheetRow = z.infer<typeof RateSheetRowSchema>;

export const RateSheetGetSchema = z.object({
  batch: RateSheetSummarySchema,
  rows: z.array(RateSheetRowSchema),
  hasMore: z.boolean(),
}).nullable();

export const RateSheetApplySchema = z.object({
  batchId: z.uuid(),
  status: z.literal('applied'),
  created: count,
  invalid: count,
  lines: count.optional(),
  roomTypes: count.optional(),
  outcome: z.literal('existing').optional(),
});
export type RateSheetApply = z.infer<typeof RateSheetApplySchema>;
