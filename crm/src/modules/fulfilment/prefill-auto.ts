import { z } from 'zod';
import { BookingCommandError, callRpc, FUNCTION_MISSING_STATES, parseReply, type RpcClient } from './commands';
import {
  type OpenDraftResult,
  PREFILL_MARK_STATES,
  PREFILL_SKIP_REASONS,
  type PrefillFieldCode,
  type PrefillMarkState,
  type PrefillSkipReason,
  type PrefillTargetKind,
  QUOTATION_PREFILL_FIELDS,
} from './contracts';
import type {
  BookingStartDraftResult,
  PrefillAutoFillOutcome,
  PrefillAutoFillRead,
  PrefillDismissResult,
  PrefillFieldStateRead,
  PrefillFillEmptyResult,
  PrefillFilledBy,
  PrefillSkip,
  QuotationCreateAutoFill,
} from './prefill-contract';

/*
 * Batch 2 automatic fill (migration 20261122000100_prefill_auto_fill; shapes
 * in atlas-batch2-shapes.md, types in prefill-contract.ts). Schemas and RPC
 * wrappers only: no values ever come from the browser (the database copies
 * them from its stored Bitrix snapshot), every command authorizes the caller
 * itself, and every parse is tolerant of codes this build does not know
 * (dropped, never a reason to fail the page) while the shape fails closed.
 */

const FIELD_CODES = new Set<string>(QUOTATION_PREFILL_FIELDS);
const isFieldCode = (v: string): v is PrefillFieldCode => FIELD_CODES.has(v);
const MARK_STATES = new Set<string>(PREFILL_MARK_STATES);
const isMarkState = (v: string): v is PrefillMarkState => MARK_STATES.has(v);
const SKIP_REASONS = new Set<string>(PREFILL_SKIP_REASONS);
const isSkipReason = (v: string): v is PrefillSkipReason => SKIP_REASONS.has(v);

export const PREFILL_AUTO_FILL_OUTCOMES = ['filled', 'off', 'existing_draft', 'unavailable', 'accepted_quotation', 'not_package', 'failed'] as const satisfies readonly PrefillAutoFillOutcome[];
export const PREFILL_FILLED_BY = ['auto_fill', 'fill_empty', 'apply'] as const satisfies readonly PrefillFilledBy[];

const timestamp = z.string().min(1).max(40);
const rowVersion = z.number().int().nonnegative();

const codeList = z
  .array(z.string().min(1).max(60))
  .max(20)
  .transform((codes) => codes.filter(isFieldCode));
const skipList = z
  .array(z.object({ field: z.string().min(1).max(60), reason: z.string().min(1).max(60) }))
  .max(20)
  .transform((rows): PrefillSkip[] => rows.flatMap((r) => (isFieldCode(r.field) && isSkipReason(r.reason) ? [{ field: r.field, reason: r.reason }] : [])));
/** An outcome this build does not know reads as 'failed' (nothing filled), never as filled. */
const outcome = z
  .string()
  .min(1)
  .max(40)
  .transform((v): PrefillAutoFillOutcome => ((PREFILL_AUTO_FILL_OUTCOMES as readonly string[]).includes(v) ? (v as PrefillAutoFillOutcome) : 'failed'));

// ---------------------------------------------------------------------------
// Read keys (booking_form_get.prefill and quotation_get.prefill)
// ---------------------------------------------------------------------------

export const PrefillAutoFillReadSchema = z.object({
  enabled: z.boolean(),
  run: z
    .object({ mode: z.literal('create'), ranAt: timestamp, filled: codeList, skipped: skipList })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  canFillEmpty: z.boolean(),
}) satisfies z.ZodType<PrefillAutoFillRead, unknown>;

const FieldStateSchema = z.object({
  field: z.string().min(1).max(60),
  state: z.string().min(1).max(40).nullable(),
  filledBy: z.string().min(1).max(40).nullable(),
  staffTouched: z.boolean(),
  clearedByStaff: z.boolean(),
  notice: z
    .object({ bitrixValue: z.string().min(1).max(4000), sourceModifiedAt: timestamp, inline: z.boolean() })
    .nullable(),
});

/** Field states; an unknown field code is dropped, an unknown state or path reads as null. */
export const PrefillFieldStatesSchema = z
  .array(FieldStateSchema)
  .max(20)
  .transform((rows): PrefillFieldStateRead[] =>
    rows.flatMap((r) =>
      isFieldCode(r.field)
        ? [{
            field: r.field,
            state: r.state !== null && isMarkState(r.state) ? r.state : null,
            filledBy: r.filledBy !== null && (PREFILL_FILLED_BY as readonly string[]).includes(r.filledBy) ? (r.filledBy as PrefillFilledBy) : null,
            staffTouched: r.staffTouched,
            clearedByStaff: r.clearedByStaff,
            notice: r.notice,
          }]
        : [],
    ),
  );

/**
 * The Batch 2 keys of the prefill read, absent on a database without
 * migration A. Merge into the existing PrefillSchema (lead/Terra):
 * `PrefillSchema.extend(PrefillAutoKeysShape)`.
 */
export const PrefillAutoKeysShape = {
  autoFill: PrefillAutoFillReadSchema.optional(),
  fieldStates: PrefillFieldStatesSchema.optional(),
};
export const PrefillAutoKeysSchema = z.object(PrefillAutoKeysShape);
export type PrefillAutoKeysRecord = z.output<typeof PrefillAutoKeysSchema>;

/** Parses only the Batch 2 keys out of a raw prefill block (null when absent or malformed). */
export function parsePrefillAutoKeys(raw: unknown): PrefillAutoKeysRecord | null {
  const parsed = PrefillAutoKeysSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Command replies
// ---------------------------------------------------------------------------

const autoFillKeys = { autoFill: outcome, filled: codeList, skipped: skipList };

export const BookingStartDraftSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  rowVersion,
  created: z.boolean(),
  ...autoFillKeys,
}) satisfies z.ZodType<BookingStartDraftResult, unknown>;

/** The keys quotation_create adds; merge into the quotationCreate reply schema (lead/Terra). */
export const QuotationCreateAutoFillShape = autoFillKeys;
export const QuotationCreateAutoFillSchema = z.object(autoFillKeys) satisfies z.ZodType<QuotationCreateAutoFill, unknown>;

export const PrefillFillEmptySchema = z.object({ rowVersion, filled: codeList, skipped: skipList }) satisfies z.ZodType<PrefillFillEmptyResult, unknown>;

export const PrefillDismissSchema = z
  .object({ field: z.string().min(1).max(60), sourceModifiedAt: timestamp, dismissed: z.literal(true) })
  .refine((r) => isFieldCode(r.field))
  .transform((r): PrefillDismissResult => ({ field: r.field as PrefillFieldCode, sourceModifiedAt: r.sourceModifiedAt, dismissed: true }));

/** prefill_mark_checked: the Batch 2 notChecked list (requested fields not upgraded and their state). */
export const PrefillNotCheckedSchema = z
  .array(z.object({ field: z.string().min(1).max(60), state: z.string().min(1).max(40).nullable() }))
  .max(20)
  .optional()
  .transform((rows): Array<{ field: PrefillFieldCode; state: PrefillMarkState | null }> =>
    (rows ?? []).flatMap((r) => (isFieldCode(r.field) ? [{ field: r.field, state: r.state !== null && isMarkState(r.state) ? r.state : null }] : [])),
  );

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function isMissing(error: unknown): boolean {
  return error instanceof BookingCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

/**
 * "Start booking": booking_start_draft (creation fill when the switch is on).
 * On a database without migration A it falls back to booking_open_draft and
 * answers autoFill 'off' (the behaviour there is exactly today's).
 */
export async function bookingStartDraft(client: RpcClient, dealId: string): Promise<BookingStartDraftResult> {
  const fn = 'booking_start_draft';
  try {
    return parseReply(fn, BookingStartDraftSchema, await callRpc(client, fn, { p_deal_id: dealId }));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const open = parseReply(
    'booking_open_draft',
    z.object({ versionId: z.uuid(), versionNo: z.number().int().positive(), rowVersion, created: z.boolean() }),
    await callRpc(client, 'booking_open_draft', { p_deal_id: dealId }),
  ) satisfies OpenDraftResult;
  return { ...open, autoFill: 'off', filled: [], skipped: [] };
}

/** "Fill empty fields from Bitrix": only untouched empty fields; cleared and unprovable ones come back in skipped. */
export async function prefillFillEmpty(
  client: RpcClient,
  input: { targetKind: PrefillTargetKind; targetId: string; expectedRowVersion: number },
): Promise<PrefillFillEmptyResult> {
  const fn = 'prefill_fill_empty';
  const data = await callRpc(client, fn, {
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_expected_row_version: input.expectedRowVersion,
  });
  return parseReply(fn, PrefillFillEmptySchema, data);
}

/** "Keep mine": hides the Bitrix change notice of one field until Bitrix changes again. No row-version bump. */
export async function prefillNoticeDismiss(
  client: RpcClient,
  input: { targetKind: PrefillTargetKind; targetId: string; expectedRowVersion: number; field: PrefillFieldCode; sourceModifiedAt: string },
): Promise<PrefillDismissResult> {
  const fn = 'prefill_notice_dismiss';
  const data = await callRpc(client, fn, {
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_expected_row_version: input.expectedRowVersion,
    p_field: input.field,
    p_source_modified_at: input.sourceModifiedAt,
  });
  return parseReply(fn, PrefillDismissSchema, data);
}

export interface PrefillAutoFillSwitchResult {
  changed: boolean;
  before: boolean;
  after: boolean;
  updatedAt: string;
}

/** Refusal of the switch command while a settings batch holds the row (55P03, retry in a moment). */
export function isSettingsBusy(error: unknown): boolean {
  return error instanceof BookingCommandError && error.sqlState === '55P03';
}

/**
 * The prefill_auto_fill switch through the audited switch command (Super
 * Admin, reason 10-500 characters). Turning it on needs the owner's APPROVE.
 */
export async function setPrefillAutoFill(client: RpcClient, input: { value: boolean; reason: string }): Promise<PrefillAutoFillSwitchResult> {
  const fn = 'admin_set_workflow_setting';
  const data = await callRpc(client, fn, { p_key: 'prefill_auto_fill', p_value: input.value, p_reason: input.reason });
  return parseReply(
    fn,
    z.object({ key: z.literal('prefill_auto_fill'), changed: z.boolean(), before: z.boolean(), after: z.boolean(), updatedAt: timestamp }).transform(
      (r): PrefillAutoFillSwitchResult => ({ changed: r.changed, before: r.before, after: r.after, updatedAt: r.updatedAt }),
    ),
    data,
  );
}

/** workflow_settings_get().prefillAutoFill: undefined on a database without migration A (the switches page shows Unknown, never Off). */
export const PrefillAutoFillSettingSchema = z.object({ prefillAutoFill: z.boolean().optional() });
