import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';

/**
 * Direction A Batch 4 (plan M1): sync settings are saved in two steps, both
 * enforced by the database (Atlas migration 20261125000100):
 *
 *   1. integration_preview_sync_settings(...)  exact counts of the Deals the
 *      save would hide (by reason, and how many carry CRM work) and bring
 *      back; returns a previewId valid 10 minutes, one use, this person only.
 *   2. integration_apply_sync_settings(previewId, reason)  saves exactly the
 *      previewed values with a reason of 10-500 characters.
 *
 * The old one-step integration_update_sync_settings now refuses
 * preview_required. A database without the Batch 4 functions answers
 * 'not_installed' (isSyncPreviewMissing): the screen then says sync settings
 * cannot be changed until the update finishes, and NEVER falls back to the
 * old one-step save.
 *
 * Replies are zod-validated and copied key by key; anything unexpected throws
 * SyncSettingsError with code null (fail closed). Server code only.
 */

export const SYNC_REASON = { min: 10, max: 500 } as const;
export const SYNC_PREVIEW_MINUTES = 10;

export const SYNC_SETTINGS_ERROR_STATES = {
  not_authorized: '42501',
  not_configured: '55000',
  preview_required: '55000',
  preview_used: '55000',
  preview_stale: '40001',
  settings_busy: '55P03',
  invalid_reason: '22023',
  invalid_input: '22023',
} as const;
export type SyncSettingsErrorCode = keyof typeof SYNC_SETTINGS_ERROR_STATES;

/** preview_stale hint: why the preview no longer matches. */
export type SyncPreviewStaleReason = 'expired' | 'settings_changed' | 'counts_changed';

/** Database messages that are validation refusals (22023), mapped to one field each. */
const VALIDATION_MESSAGES: Record<string, string> = {
  'choose at least one pipeline': 'categoryIds',
  'choose at least one stage': 'stageIds',
  'the start date must be in the past': 'cutoff',
  'invalid sync switch': 'syncEnabled',
  'invalid Lead intake mode': 'leadIntakeMode',
  'invalid Deal intake mode': 'dealIntakeMode',
  entry_stage_pipeline_required: 'categoryIds',
};

const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);

export class SyncSettingsError extends Error {
  override name = 'SyncSettingsError';
  constructor(
    readonly command: string,
    /** The mapped refusal, 'session' for an ended sign-in, or null for anything unexpected. */
    readonly code: SyncSettingsErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** preview_stale: why; invalid_input: the refused field; else null. Never database text. */
    readonly detail: SyncPreviewStaleReason | string | null = null,
    /** invalid_input: entry_stage_pipeline_required (a Won-only entry stage's pipeline must stay ticked). */
    readonly entryStagePipeline = false,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapSyncSettingsError(fn: string, error: RpcError): SyncSettingsError {
  const state = error.code ?? '';
  const message = (error.message ?? '').trim();
  const hint = (error.hint ?? '').trim();
  if (state === '42501') return new SyncSettingsError(fn, 'not_authorized', state);
  if (state === '55000' && message === 'intake is not configured') return new SyncSettingsError(fn, 'not_configured', state);
  if (state === '55000' && (message === 'preview_required' || message === 'preview_used')) {
    return new SyncSettingsError(fn, message, state);
  }
  if (state === '40001' && message === 'preview_stale') {
    const why = (['expired', 'settings_changed', 'counts_changed'] as const).find((h) => h === hint) ?? null;
    return new SyncSettingsError(fn, 'preview_stale', state, why);
  }
  if (state === '55P03' && message === 'settings_busy') return new SyncSettingsError(fn, 'settings_busy', state);
  if (state === '22023' && message === 'a reason of 10 to 500 characters is required') {
    return new SyncSettingsError(fn, 'invalid_reason', state);
  }
  if (state === '22023' && Object.hasOwn(VALIDATION_MESSAGES, message)) {
    return new SyncSettingsError(fn, 'invalid_input', state, VALIDATION_MESSAGES[message]!, message === 'entry_stage_pipeline_required');
  }
  if (SESSION_STATES.has(state)) return new SyncSettingsError(fn, 'session', state);
  return new SyncSettingsError(fn, null, state || null);
}

/** The database has no Batch 4 sync functions yet: say so; never use the old one-step save. */
export function isSyncPreviewMissing(error: unknown): boolean {
  return error instanceof SyncSettingsError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new SyncSettingsError(fn, null, null);
  }
  if (result.error) throw mapSyncSettingsError(fn, result.error);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SyncSettingsError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const IntakeMode = z.enum(['manifest', 'scope']);
const Count = z.number().int().nonnegative();

const SettingsValues = z.object({
  categoryIds: z.array(z.number().int().nonnegative()).max(50),
  stageIds: z.array(z.string().min(1).max(50)).max(50).nullable(),
  cutoffAt: z.string().min(1),
  autoSync: z.boolean().nullable(),
  leadIntakeMode: IntakeMode.nullable(),
  dealIntakeMode: IntakeMode.nullable(),
});

const HideCounts = z.object({
  total: Count,
  beforeSyncDate: Count,
  pipelineNotEligible: Count,
  stageNotEligible: Count,
  withCrmWork: Count,
});

const PreviewSchema = z
  .object({
    previewId: z.uuid(),
    expiresAt: z.string().min(1),
    changed: z.boolean(),
    current: SettingsValues,
    proposed: SettingsValues,
    hide: HideCounts,
    bringBack: Count,
    recheck: Count,
    autoSyncChange: z.enum(['none', 'on', 'off']),
  })
  .transform((r) => ({
    previewId: r.previewId,
    expiresAt: r.expiresAt,
    changed: r.changed,
    current: r.current,
    proposed: r.proposed,
    hide: r.hide,
    bringBack: r.bringBack,
    recheck: r.recheck,
    autoSyncChange: r.autoSyncChange,
  }));
export type SyncSettingsPreview = z.output<typeof PreviewSchema>;

const ApplySchema = z
  .object({
    previewId: z.uuid(),
    removed: Count,
    restored: Count,
    requeued: Count,
    resyncQueued: z.boolean(),
    cutoffAt: z.string().min(1),
    leadIntakeMode: IntakeMode,
    dealIntakeMode: IntakeMode,
    scopeRequeuedLeads: Count,
    scopeRequeuedDeals: Count,
    hidden: HideCounts,
    broughtBack: Count,
  })
  .transform((r) => ({
    previewId: r.previewId,
    removed: r.removed,
    restored: r.restored,
    requeued: r.requeued,
    resyncQueued: r.resyncQueued,
    cutoffAt: r.cutoffAt,
    leadIntakeMode: r.leadIntakeMode,
    dealIntakeMode: r.dealIntakeMode,
    scopeRequeuedLeads: r.scopeRequeuedLeads,
    scopeRequeuedDeals: r.scopeRequeuedDeals,
    hidden: r.hidden,
    broughtBack: r.broughtBack,
  }));
export type SyncSettingsApplyResult = z.output<typeof ApplySchema>;

export interface SyncSettingsInput {
  categoryIds: number[];
  stageIds: string[];
  /** ISO timestamp; the database uses 00:00 India time of that day. */
  cutoffAt: string;
  syncEnabled: boolean;
  /** null / undefined keeps the current mode. */
  leadIntakeMode?: 'manifest' | 'scope' | null;
  dealIntakeMode?: 'manifest' | 'scope' | null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function previewSyncSettings(client: RpcClient, input: SyncSettingsInput): Promise<SyncSettingsPreview> {
  const fn = 'integration_preview_sync_settings';
  const data = await invoke(client, fn, {
    p_category_ids: input.categoryIds,
    p_stage_ids: input.stageIds,
    p_cutoff_at: input.cutoffAt,
    p_sync_enabled: input.syncEnabled,
    p_lead_intake_mode: input.leadIntakeMode ?? null,
    p_deal_intake_mode: input.dealIntakeMode ?? null,
  });
  return parse(fn, PreviewSchema, data);
}

export async function applySyncSettings(
  client: RpcClient,
  input: { previewId: string; reason: string },
): Promise<SyncSettingsApplyResult> {
  const fn = 'integration_apply_sync_settings';
  const data = await invoke(client, fn, { p_preview_id: input.previewId, p_reason: input.reason });
  return parse(fn, ApplySchema, data);
}
