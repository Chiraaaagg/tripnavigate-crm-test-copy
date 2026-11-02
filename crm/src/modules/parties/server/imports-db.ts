import 'server-only';
import { z } from 'zod';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { callVn } from './parties-db';

/**
 * Typed wrappers for the protected hotel and customer imports (migration
 * 20261128000140; shapes: Atlas notes atlas-vn-shapes.md section h and v2).
 * Hotels: Super Admin; customers: Accounts. Under the caller's own session;
 * refusals throw VnDbError (parties-db). Rows are what the app's CSV parser
 * produced: objects of camelCase keys with string or null values.
 */

export const IMPORT_KINDS = ['hotel', 'customer'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_STATUSES = ['staged', 'validated', 'applied', 'cancelled'] as const;
export const IMPORT_OUTCOMES = ['create', 'update', 'unchanged', 'skipped_checked', 'invalid', 'duplicate_in_file'] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
export type ImportRow = Record<string, string | null>;

const Count = z.number().int().min(0);
const ProposedSchema = z.object({ create: Count, update: Count, unchanged: Count, skippedChecked: Count });

const ApplyResultSchema = z.object({
  batchId: z.uuid(),
  status: z.literal('applied'),
  created: Count,
  updated: Count,
  unchanged: Count,
  skippedChecked: Count,
  invalid: Count,
});
export type ImportApplyResult = z.infer<typeof ApplyResultSchema> & { outcome?: 'existing' };

/** The batch with its dry-run summary (summary keys absent before the first validation). */
export const ImportBatchSchema = z.object({
  batchId: z.uuid(),
  kind: z.enum(IMPORT_KINDS),
  status: z.enum(IMPORT_STATUSES),
  rowVersion: z.number().int(),
  fileName: z.string(),
  branchId: z.uuid().nullable(),
  /** Echo-A M1: a customer import for the whole company (chosen explicitly); false with a branch. */
  entityWide: z.boolean().default(false),
  branchName: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  createdAt: z.string(),
  validatedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
  appliedByName: z.string().nullable(),
  applyResult: ApplyResultSchema.nullable(),
  rows: Count,
  valid: Count.optional(),
  invalid: Count.optional(),
  duplicatesInFile: Count.optional(),
  possibleDuplicates: Count.optional(),
  /** Rows where a value was assumed (GST status registered from a GSTIN, a padded state code). */
  assumedRows: Count.optional(),
  /** Echo-A L6: rows whose update clears a stored value (note will_clear:<key>). */
  clearRows: Count.optional(),
  rowNotes: z.array(z.object({ rowNo: z.number().int(), notes: z.array(z.string().regex(/^(gst_status_assumed_registered|state_code_padded|will_clear:[A-Za-z0-9]{1,40})$/)) })).optional(),
  /** Echo-A L3: post it back to applyImport (proposalHash) so the database applies exactly what was shown. */
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposed: ProposedSchema.optional(),
  columns: z.array(z.object({ key: z.string(), filled: Count })).optional(),
  invalidRows: z.array(z.object({ rowNo: z.number().int(), reasons: z.array(z.string()) })).optional(),
  duplicateRows: z.array(z.object({ rowNo: z.number().int(), sourceRef: z.string().nullable(), kind: z.enum(['in_file', 'same_name']) })).optional(),
});
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

/** A validated batch: the summary keys are always present. */
export const ValidatedBatchSchema = ImportBatchSchema.extend({
  valid: Count,
  invalid: Count,
  duplicatesInFile: Count,
  possibleDuplicates: Count,
  // Lead ruling Q8 (added after v3): defaults keep an older reply readable.
  assumedRows: Count.default(0),
  clearRows: Count.default(0),
  rowNotes: z.array(z.object({ rowNo: z.number().int(), notes: z.array(z.string().regex(/^(gst_status_assumed_registered|state_code_padded|will_clear:[A-Za-z0-9]{1,40})$/)) })).default([]),
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  proposed: ProposedSchema,
  columns: z.array(z.object({ key: z.string(), filled: Count })),
  invalidRows: z.array(z.object({ rowNo: z.number().int(), reasons: z.array(z.string()) })),
  duplicateRows: z.array(z.object({ rowNo: z.number().int(), sourceRef: z.string().nullable(), kind: z.enum(['in_file', 'same_name']) })),
});
export type ValidatedImportBatch = z.infer<typeof ValidatedBatchSchema>;

const RowResultSchema = z.object({
  rowNo: z.number().int(),
  sourceRef: z.string().nullable(),
  name: z.string().nullable(),
  /** 'pending' = not validated yet (the database answers null). */
  outcome: z.enum(IMPORT_OUTCOMES).nullable().transform((v): ImportOutcome | 'pending' => v ?? 'pending'),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  targetId: z.uuid().nullable(),
});
export type ImportRowResult = z.infer<typeof RowResultSchema>;
const GetSchema = z.object({ batch: ImportBatchSchema, rows: z.array(RowResultSchema), hasMore: z.boolean() }).nullable();

const StagedSchema = z.object({ batchId: z.uuid(), rowCount: z.number().int(), outcome: z.enum(['created', 'existing']) });
const ListSchema = z.object({
  items: z.array(z.object({
    batchId: z.uuid(),
    kind: z.enum(IMPORT_KINDS),
    fileName: z.string(),
    status: z.enum(IMPORT_STATUSES),
    rows: Count,
    createdAt: z.string(),
    uploadedByName: z.string().nullable(),
    appliedAt: z.string().nullable(),
    created: Count.nullable(),
    updated: Count.nullable(),
    invalid: Count.nullable(),
  })),
});
export type ImportListItem = z.infer<typeof ListSchema>['items'][number];
const CancelSchema = z.object({ batchId: z.uuid(), status: z.literal('cancelled'), rowVersion: z.number().int() });

/** Stages the parsed rows (1-5000). Idempotent by (entity, request id) for the same uploader, kind and file hash. */
export function stageImport(
  client: RpcClient,
  args: {
    legalEntityId: string; kind: ImportKind; branchId: string | null; fileName: string; sha256: string; rows: ImportRow[]; requestId: string;
    /** Echo-A M1: customers need branchId, or entityWide true (never both); hotels: neither. */
    entityWide?: boolean;
  },
): Promise<z.infer<typeof StagedSchema>> {
  return callVn(client, 'import_batch_stage', {
    p_legal_entity_id: args.legalEntityId, p_kind: args.kind, p_branch_id: args.branchId, p_file_name: args.fileName,
    p_sha256: args.sha256, p_rows: args.rows, p_request_id: args.requestId, p_entity_wide: args.entityWide ?? false,
  }, StagedSchema);
}

/** Dry run: validates every row and answers the summary (writes only the import tables). */
export function validateImport(client: RpcClient, batchId: string): Promise<ValidatedImportBatch> {
  return callVn(client, 'import_batch_validate', { p_batch_id: batchId }, ValidatedBatchSchema);
}

/** Applies a validated batch (reason 10-500). Idempotent; refuses import_stale when the dry run no longer holds. */
export function applyImport(
  client: RpcClient,
  args: { batchId: string; expectedRowVersion: number; reason: string; proposalHash?: string | null },
): Promise<ImportApplyResult> {
  // Echo-A L3: expectedRowVersion and proposalHash are the ones of the summary the screen showed.
  return callVn(client, 'import_batch_apply', {
    p_batch_id: args.batchId, p_expected_row_version: args.expectedRowVersion, p_reason: args.reason,
    p_proposal_hash: args.proposalHash ?? null,
  }, ApplyResultSchema.extend({ outcome: z.literal('existing').optional() }));
}

/** A batch with one page of row results; null when the caller lacks the kind's role. */
export function getImport(
  client: RpcClient,
  args: { batchId: string; limit?: number; offset?: number },
): Promise<z.infer<typeof GetSchema>> {
  return callVn(client, 'import_batch_get', { p_batch_id: args.batchId, p_limit: args.limit ?? 100, p_offset: args.offset ?? 0 }, GetSchema);
}

export function listImports(client: RpcClient, args: { kind: ImportKind; limit?: number }): Promise<z.infer<typeof ListSchema>> {
  return callVn(client, 'import_batch_list', { p_kind: args.kind, p_limit: args.limit ?? 20 }, ListSchema);
}

export function cancelImport(client: RpcClient, args: { batchId: string; expectedRowVersion: number }): Promise<z.infer<typeof CancelSchema>> {
  return callVn(client, 'import_batch_cancel', { p_batch_id: args.batchId, p_expected_row_version: args.expectedRowVersion }, CancelSchema);
}
