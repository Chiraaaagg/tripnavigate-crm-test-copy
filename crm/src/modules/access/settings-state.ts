import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';

/**
 * Direction A Batch 4 (plan M5, money-privacy-settings R2/R4): typed wrappers
 * for the Settings reads of Atlas migration 20261125000100 (shapes in the
 * Atlas notes atlas-batch4-shapes.md):
 *
 *   settings_switch_states()     state and "last changed by / when / why" of
 *                                every workflow, Bitrix and live switch
 *   workflow_visa_task_preview() Visa desk tasks switching on would create
 *
 * Every call runs under the caller's own session; the database decides who
 * reads what. Parsing is tolerant where a safe reading exists and never turns
 * an unreadable value into Off: an unknown state value reads as 'unknown', an
 * unreadable "last change" as null, and a section that does not parse as
 * { readable: false } (every switch Unknown). Pure; no I/O. Server code only
 * (never import into a client component).
 */

export const SWITCH_STATES = ['on', 'off', 'unknown'] as const;
export type SwitchState = (typeof SWITCH_STATES)[number];

export const WORKFLOW_SWITCH_KEYS = [
  'service_items_enabled',
  'intake_prompt_enabled',
  'visa_passport_tasks_enabled',
  'prefill_auto_fill',
  'referral_drafts',
] as const;
export type WorkflowSwitchKey = (typeof WORKFLOW_SWITCH_KEYS)[number];

export const BITRIX_SWITCH_KEYS = [
  'bitrix_trip_facts_read',
  'lead_intake_unowned',
  'bitrix_id_proof_copy',
  'bitrix_name_read',
  'won_only_intake',
] as const;
export type BitrixSwitchKey = (typeof BITRIX_SWITCH_KEYS)[number];

export const FINANCE_MODE_KEYS = ['bank_transfer', 'upi', 'cash', 'cheque'] as const;
export type FinanceModeKey = (typeof FINANCE_MODE_KEYS)[number];

const StateSchema = z.enum(SWITCH_STATES).catch('unknown');
const NameSchema = z.string().min(1).max(200).nullable().catch(null);

const LastChangeSchema = z
  .object({
    at: z.string().min(1),
    byName: NameSchema,
    byYou: z.boolean().catch(false),
    via: z.enum(['command', 'api', 'direct_sql']).nullable().catch(null),
    command: z.string().max(100).nullable().catch(null),
    from: z.boolean().nullable().catch(null),
    to: z.boolean().nullable().catch(null),
    fields: z.array(z.string().max(60)).max(20).catch([]),
    reason: z.string().max(500).nullable().catch(null),
  })
  .nullable()
  .catch(null);
export type LastChange = z.output<typeof LastChangeSchema>;

const SwitchSchema = <K extends readonly [string, ...string[]]>(keys: K) =>
  z.object({ key: z.enum(keys), state: StateSchema, lastChange: LastChangeSchema });

/**
 * A switch list keeps the known keys it can read and drops anything else (a
 * key a newer database adds). A known key missing from the list is shown as
 * Unknown by the screen (it lists WORKFLOW_SWITCH_KEYS / BITRIX_SWITCH_KEYS).
 */
const SwitchListSchema = <K extends readonly [string, ...string[]]>(keys: K) =>
  z
    .array(z.unknown())
    .max(50)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = SwitchSchema(keys).safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    );

const WorkflowSectionSchema = z.object({
  readable: z.boolean(),
  canSwitch: z.boolean(),
  switches: SwitchListSchema(WORKFLOW_SWITCH_KEYS),
});

const LastSavedSchema = z
  .object({
    at: z.string().min(1),
    byName: NameSchema,
    byYou: z.boolean().catch(false),
    reason: z.string().max(500).nullable().catch(null),
    autoSync: z.boolean().nullable().catch(null),
    hidden: z.number().int().nonnegative().nullable().catch(null),
    broughtBack: z.number().int().nonnegative().nullable().catch(null),
  })
  .nullable()
  .catch(null);

const BitrixSectionSchema = z.object({
  readable: z.boolean(),
  canSwitch: z.boolean(),
  canManageSync: z.boolean(),
  connectionEnabled: z.boolean().nullable(),
  pilotLegalEntityId: z.uuid().nullable(),
  pilotBranchId: z.uuid().nullable(),
  pilotBranchName: z.string().min(1).max(200).nullable().catch(null),
  switches: SwitchListSchema(BITRIX_SWITCH_KEYS),
  syncSettings: z.object({
    categoryIds: z.array(z.number().int().nonnegative()).max(50).nullable(),
    stageIds: z.array(z.string().min(1).max(50)).max(50).nullable(),
    cutoffAt: z.string().min(1).nullable(),
    leadIntakeMode: z.enum(['manifest', 'scope']).nullable().catch(null),
    dealIntakeMode: z.enum(['manifest', 'scope']).nullable().catch(null),
    autoSync: StateSchema,
    lastScopeChange: LastChangeSchema,
    lastSaved: LastSavedSchema,
  }),
});

const LiveSwitchSchema = z.object({ state: StateSchema, lastChange: LastChangeSchema });
const LiveSectionSchema = z.object({
  realBooking: LiveSwitchSchema,
  supplierConfirmation: LiveSwitchSchema,
  financeModes: z
    .array(
      z.object({
        legalEntityId: z.uuid(),
        legalName: z.string().min(1).max(300),
        modes: z.array(z.object({ key: z.enum(FINANCE_MODE_KEYS), state: StateSchema, lastChange: LastChangeSchema })).max(10),
      }),
    )
    .max(50),
});

export type WorkflowSection = z.output<typeof WorkflowSectionSchema>;
export type BitrixSection = z.output<typeof BitrixSectionSchema>;
export type LiveSection = z.output<typeof LiveSectionSchema>;

/**
 * Each section: the record; null = this person may not read it (the
 * database said so: no tab, no card); 'unreadable' = the database answered
 * but the section could not be read (show Unknown, never Off).
 */
export interface SettingsSwitchStates {
  workflow: WorkflowSection | null | 'unreadable';
  bitrix: BitrixSection | null | 'unreadable';
  live: LiveSection | null | 'unreadable';
}

function section<T>(schema: z.ZodType<T>, value: unknown): T | null | 'unreadable' {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : 'unreadable';
}

/** Tolerant: never throws; a reply that is not an object reads as every section unreadable. */
export function toSettingsSwitchStates(data: unknown): SettingsSwitchStates {
  if (typeof data !== 'object' || data === null) {
    return { workflow: 'unreadable', bitrix: 'unreadable', live: 'unreadable' };
  }
  const raw = data as Record<string, unknown>;
  return {
    workflow: section(WorkflowSectionSchema, raw.workflow ?? null),
    bitrix: section(BitrixSectionSchema, raw.bitrix ?? null),
    live: section(LiveSectionSchema, raw.live ?? null),
  };
}

const VisaTaskPreviewSchema = z.object({
  switchState: StateSchema,
  wouldCreate: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deals: z.number().int().nonnegative(),
});
export type VisaTaskPreview = z.output<typeof VisaTaskPreviewSchema>;

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);

export type SettingsReadErrorCode = 'not_authorized' | 'not_installed' | 'session' | null;

export class SettingsReadError extends Error {
  override name = 'SettingsReadError';
  constructor(
    readonly read: string,
    /** null = anything unexpected (show "could not be read", never Off). */
    readonly code: SettingsReadErrorCode,
    readonly sqlState: string | null,
  ) {
    super(`${read} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

function mapError(error: RpcError): SettingsReadErrorCode {
  const state = error.code ?? '';
  if (state === '42501') return 'not_authorized';
  if (FUNCTION_MISSING_STATES.has(state)) return 'not_installed';
  if (SESSION_STATES.has(state)) return 'session';
  return null;
}

async function invoke(client: RpcClient, fn: string): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, {});
  } catch {
    throw new SettingsReadError(fn, null, null);
  }
  if (result.error) throw new SettingsReadError(fn, mapError(result.error), result.error.code ?? null);
  return result.data;
}

/** settings_switch_states(); throws SettingsReadError on a refusal or failure. */
export async function settingsSwitchStates(client: RpcClient): Promise<SettingsSwitchStates> {
  return toSettingsSwitchStates(await invoke(client, 'settings_switch_states'));
}

/** workflow_visa_task_preview(); throws SettingsReadError (code null for a reply that does not parse). */
export async function workflowVisaTaskPreview(client: RpcClient): Promise<VisaTaskPreview> {
  const fn = 'workflow_visa_task_preview';
  const parsed = VisaTaskPreviewSchema.safeParse(await invoke(client, fn));
  if (!parsed.success) throw new SettingsReadError(fn, null, null);
  return parsed.data;
}
