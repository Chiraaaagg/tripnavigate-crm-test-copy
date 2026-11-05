import { z } from 'zod';
import type { RpcClient, RpcError } from './commands';
import type { BitrixPipeline } from './bitrix/directory';
import type { IntakeConfig } from './intake-config';

/**
 * B1.1d Won-only Deal intake (contract section 3, DEC-27; freeze note 3.3;
 * migration 20261119000400_b11_won_only_intake). Pure layer: types, strict
 * answer schemas, typed wrappers for the two Super Admin commands, refusal
 * mapping and the entry-rule view. Server actions live in
 * server/won-only-actions.ts; nothing here touches the privileged client.
 *
 * The switch is integration_intake_config.deal_entry_stage_ids (null = off);
 * the contract's `deal_intake_won_only` is `dealIntakeWonOnly` below.
 */

/** Kinds of CRM work that keep a Deal from being pruned (authz.deal_crm_work). */
export const CRM_WORK_KINDS = [
  'booking_version',
  'task',
  'receipt',
  'claim',
  'billing_profile',
  'evidence',
  'contact',
  'cost_entry',
  'visa_application',
  'traveller_identity',
  'service_item',
  'traveller',
  'finance_record',
  'assignment',
] as const;
export type CrmWorkKind = (typeof CRM_WORK_KINDS)[number];

/** Plain words for each kind (admin screen lists). */
export const CRM_WORK_LABELS: Record<CrmWorkKind, string> = {
  booking_version: 'booking started',
  task: 'department task',
  receipt: 'customer receipt',
  claim: 'reported payment',
  billing_profile: 'billing details',
  evidence: 'uploaded document',
  contact: 'customer contact',
  cost_entry: 'department cost',
  visa_application: 'visa or passport work',
  traveller_identity: 'traveller identity details',
  service_item: 'service added',
  traveller: 'traveller added',
  finance_record: 'Accounts record',
  assignment: 'person assigned',
};

/**
 * What a dry run writes (review W8): no Deal changes, only a record of the check.
 * On the live database it still needs the owner's APPROVE like the real run.
 */
export const PRUNE_DRY_RUN_NOTE = 'A dry run changes no Deal. It writes only a record of the check (who ran it, when and why).';

/** How the prune is undone (review W1). */
export const PRUNE_UNDO_NOTE =
  'Reversible: a removed Deal comes back when it reaches Won, and switching Won-only intake off brings back every removed Deal (in a ticked pipeline, created on or after the sync date).';

/** Typed confirmation the real prune needs (server-checked, case-sensitive). */
export const PRUNE_CONFIRM_PHRASE = 'REMOVE';

/** Same rule as authz.settings_change_reason (10 to 500 characters after trimming). */
export const WON_ONLY_REASON_MIN = 10;
export const WON_ONLY_REASON_MAX = 500;

const StageIds = z.array(z.string()).nullable();

const DealEntryStagesSchema = z
  .object({
    changed: z.boolean(),
    before: StageIds,
    after: StageIds,
    restored: z.number().int().nonnegative(),
    /** Deal events skipped before (not_eligible_*) queued again. */
    requeued: z.number().int().nonnegative(),
    resyncQueued: z.boolean(),
  })
  .strict();
export type DealEntryStagesResult = z.infer<typeof DealEntryStagesSchema>;

const PruneDealSchema = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    stageId: z.string().nullable(),
    work: z.array(z.enum(CRM_WORK_KINDS)).optional(),
  })
  .strict();
export type PruneDealRow = z.infer<typeof PruneDealSchema>;

const count = z.number().int().nonnegative();
const PruneSchema = z
  .object({
    dryRun: z.boolean(),
    entryStageIds: z.array(z.string()),
    storedActive: count,
    atEntryStage: count,
    pruned: z.object({ count, deals: z.array(PruneDealSchema) }).strict(),
    keptWithWork: z
      .object({ count, byKind: z.partialRecord(z.enum(CRM_WORK_KINDS), z.array(z.uuid())), deals: z.array(PruneDealSchema) })
      .strict(),
    keptSyncPending: z.object({ count, deals: z.array(PruneDealSchema) }).strict(),
    truncated: z.boolean(),
  })
  .strict();
export type PruneResult = z.infer<typeof PruneSchema>;

/**
 * Refusals of the two commands. `not_installed` = the database has no B1.1d
 * migration yet (function missing); `reason_required` = the reason rule.
 */
export type WonOnlyRefusal =
  | 'not_authorized'
  | 'invalid_input'
  | 'entry_stage_outside_pipelines'
  | 'entry_stages_not_set'
  | 'reason_required'
  | 'not_configured'
  | 'not_installed'
  | 'unexpected';

export class WonOnlyCommandError extends Error {
  override name = 'WonOnlyCommandError';
  constructor(
    readonly command: string,
    readonly refusal: WonOnlyRefusal,
    readonly sqlState: string | null,
  ) {
    // Never the database message verbatim.
    super(`${command} refused: ${refusal}`);
  }
}

export function wonOnlyRefusalOf(error: RpcError): WonOnlyRefusal {
  const msg = error.message ?? '';
  switch (error.code) {
    case '42501':
      return 'not_authorized';
    case '22023':
      if (msg === 'invalid_input') return 'invalid_input';
      if (msg === 'entry_stage_outside_pipelines') return 'entry_stage_outside_pipelines';
      return 'reason_required';
    case '55000':
      return msg === 'entry_stages_not_set' ? 'entry_stages_not_set' : 'not_configured';
    case 'PGRST202':
    case '42883':
      return 'not_installed';
    default:
      return 'unexpected';
  }
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new WonOnlyCommandError(fn, wonOnlyRefusalOf(error), error.code ?? null);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new WonOnlyCommandError(fn, 'unexpected', null);
  return parsed.data;
}

/** Sets (stageIds) or clears (null) the entry list. Caller: the Super Admin's own session client. */
export function setDealEntryStages(client: RpcClient, input: { stageIds: string[] | null; reason: string }): Promise<DealEntryStagesResult> {
  return call(client, 'integration_set_deal_entry_stages', { p_stage_ids: input.stageIds, p_reason: input.reason }, DealEntryStagesSchema);
}

/** Dry run (changes nothing but one audit row) or real prune. Caller: the Super Admin's own session client. */
export function pruneDealsOutsideEntryStages(client: RpcClient, input: { reason: string; dryRun: boolean }): Promise<PruneResult> {
  return call(client, 'integration_prune_deals_outside_entry_stages', { p_reason: input.reason, p_dry_run: input.dryRun }, PruneSchema);
}

/** Entry rule for the admin screen (freeze note 3.3; Luna's `loadIntakeEntryRule`). */
export interface IntakeEntryRuleView {
  /** The contract's `deal_intake_won_only`. */
  wonOnly: boolean;
  /** Entry stages while on; empty when off. */
  entryStageIds: string[];
  /** Same stages with their Bitrix names when the directory was readable (label = id otherwise). */
  entryStages: Array<{ id: string; label: string; pipelineName: string | null }>;
  /** The ticked stages that decide entry while Won-only intake is off. */
  tickedStageIds: string[];
}

export function entryRuleView(
  config: Pick<IntakeConfig, 'eligibleStageIds' | 'dealEntryStageIds'>,
  pipelines: BitrixPipeline[] | null | undefined,
): IntakeEntryRuleView {
  const ids = config.dealEntryStageIds ?? [];
  return {
    wonOnly: config.dealEntryStageIds != null,
    entryStageIds: ids,
    entryStages: ids.map((id) => {
      for (const p of pipelines ?? []) {
        const stage = p.stages.find((s) => s.id === id);
        if (stage) return { id, label: stage.name, pipelineName: p.name };
      }
      return { id, label: id, pipelineName: null };
    }),
    tickedStageIds: config.eligibleStageIds,
  };
}

/** Plain-English refusal text for the admin screen. */
export function wonOnlyRefusalText(refusal: WonOnlyRefusal): string {
  switch (refusal) {
    case 'not_authorized':
      return 'Only a Super Admin with a fresh two-step sign-in can change this. Nothing was changed.';
    case 'invalid_input':
      return 'Choose between 1 and 20 different Bitrix stages. Nothing was changed.';
    case 'entry_stage_outside_pipelines':
      return 'A chosen stage belongs to a pipeline the sync does not take. Tick that pipeline first, or choose another stage. Nothing was changed.';
    case 'entry_stages_not_set':
      return `Won-only intake is off, so there is nothing to check or remove. Switch it on first (after the owner approves). ${PRUNE_DRY_RUN_NOTE}`;
    case 'reason_required':
      return `Write a reason of ${WON_ONLY_REASON_MIN} to ${WON_ONLY_REASON_MAX} characters, including the owner's approval. Nothing was changed.`;
    case 'not_configured':
      return 'Bitrix intake is not configured. Nothing was changed.';
    case 'not_installed':
      return 'This database does not have Won-only intake yet. Nothing was changed.';
    default:
      return 'The request could not be completed. Nothing was changed. Please retry.';
  }
}
