import { z } from 'zod';

/**
 * public.integration_intake_config (agent B, contract §5) as read by the app.
 * One row per portal. Branch/entity come only from here, never from payloads.
 */
export interface IntakeConfig {
  portalDomain: string;
  portalMemberId: string;
  categoryId: string;
  /** Eligible pipelines (CATEGORY_ID). Falls back to [categoryId] for older rows. */
  categoryIds: string[];
  eligibleStageIds: string[];
  cutoffAt: string;
  pilotLegalEntityId: string | null;
  pilotBranchId: string | null;
  enabled: boolean;
  /** Reconcile update-pass watermark (M1); null = never reconciled. */
  lastReconciledAt: string | null;
  /**
   * Sync completion §2: 'manifest' (default) admits only an active manifest's
   * records; 'scope' admits every record inside the config's scope (the apply
   * decides) and reconcile lists the portal instead of a manifest.
   * Optional for older fixtures; absent = 'manifest'.
   */
  leadIntakeMode?: IntakeMode;
  dealIntakeMode?: IntakeMode;
  /**
   * B1.1d Won-only Deal intake (migration 20261119000400): the stages at which a
   * NEW Deal enters (and a removed Deal comes back). null = off (today's rule:
   * the ticked stages). This list is the switch; the contract's
   * `deal_intake_won_only` is `dealEntryStageIds !== null`. Optional for older
   * fixtures and for a database without the column; absent = null.
   */
  dealEntryStageIds?: string[] | null;
  /**
   * B1.2 (migration 20261120000400, DEC-36): the sync stores the owner-named
   * Bitrix values (trip facts, linked Contact/Company basics). Off by default;
   * absent (older database) = off.
   */
  tripFactsRead?: boolean;
  /** B1.2 (DEC-37): scope-mode Leads without an eligible owner are stored waiting for an owner. Absent = off. */
  leadIntakeUnowned?: boolean;
  /** B1.2 (DEC-43): copy stored ID proofs to the Bitrix Deal (switch bitrix_id_proof_copy). Absent = off. */
  idProofCopy?: boolean;
  /** Batch 1 B1-1 (20261121000100): read Bitrix stage, status and source names daily (switch bitrix_name_read). Absent = off. */
  bitrixNameRead?: boolean;
  /**
   * Voice-note batch (20261128000100): read the Bitrix Deal destination and the
   * adults / children / infants counts, and the destination option names
   * (switch bitrix_trip_details_read). Absent (older database) = off.
   */
  tripDetailsRead?: boolean;
}

export type IntakeMode = 'manifest' | 'scope';

/** Columns every supported database has (before B1.1d). */
export const LEGACY_INTAKE_CONFIG_COLUMNS =
  'portal_domain, portal_member_id, category_id, eligible_category_ids, eligible_stage_ids, cutoff_at, pilot_legal_entity_id, pilot_branch_id, enabled, last_reconciled_at, lead_intake_mode, deal_intake_mode';

/** Columns of a B1.1d database (before B1.2 0400). */
export const B11_INTAKE_CONFIG_COLUMNS = `${LEGACY_INTAKE_CONFIG_COLUMNS}, deal_entry_stage_ids`;

/** Columns of a B1.2 0400 database (before 0700). */
export const B12_INTAKE_CONFIG_COLUMNS = `${B11_INTAKE_CONFIG_COLUMNS}, bitrix_trip_facts_read, lead_intake_unowned`;

/** Columns of a B1.2 0700 database (before Batch 1 B1-1). */
export const B12_COPY_INTAKE_CONFIG_COLUMNS = `${B12_INTAKE_CONFIG_COLUMNS}, bitrix_id_proof_copy`;

/**
 * B1.2 0700: the ID-proof copy switch, and Batch 1 B1-1: the name-read switch,
 * are read with the config, so the worker needs no extra call.
 */
export const B13_NAME_INTAKE_CONFIG_COLUMNS = `${B12_COPY_INTAKE_CONFIG_COLUMNS}, bitrix_name_read`;

/** Voice-note batch (20261128000100): the trip details switch is read with the config too. */
export const INTAKE_CONFIG_COLUMNS = `${B13_NAME_INTAKE_CONFIG_COLUMNS}, bitrix_trip_details_read`;

/** PostgREST / Postgres answer for a column the database does not have. */
export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

/**
 * Reads the intake config rows with INTAKE_CONFIG_COLUMNS and, when the database
 * does not have the Batch 1, B1.2 or B1.1d columns yet, again with the next older column
 * list, so a new app on an older database never stops the sync (the missing
 * switches read as off). `select` runs the query for the given column list.
 */
export async function selectIntakeConfig<R extends { error: { code?: string } | null }>(
  select: (columns: string) => PromiseLike<R>,
): Promise<R> {
  let result = await select(INTAKE_CONFIG_COLUMNS);
  for (const older of [B13_NAME_INTAKE_CONFIG_COLUMNS, B12_COPY_INTAKE_CONFIG_COLUMNS, B12_INTAKE_CONFIG_COLUMNS, B11_INTAKE_CONFIG_COLUMNS, LEGACY_INTAKE_CONFIG_COLUMNS]) {
    if (!(result.error && isMissingColumnError(result.error))) return result;
    result = await select(older);
  }
  return result;
}

/**
 * The stage filter for NEW Deals: the entry list when Won-only intake is on,
 * otherwise the ticked stages. The full resync job snapshots the same list.
 */
export function dealListingStageIds(config: Pick<IntakeConfig, 'eligibleStageIds' | 'dealEntryStageIds'>): string[] {
  return config.dealEntryStageIds ?? config.eligibleStageIds;
}

const Mode = z
  .enum(['manifest', 'scope'])
  .nullable()
  .optional()
  .transform((v): IntakeMode => v ?? 'manifest');

const Row = z.object({
  portal_domain: z.string().min(1),
  portal_member_id: z.string().min(1),
  category_id: z.union([z.string(), z.number()]).transform(String),
  eligible_category_ids: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  eligible_stage_ids: z.array(z.string()).nullable().transform((v) => v ?? []),
  cutoff_at: z.string().min(1),
  pilot_legal_entity_id: z.string().nullable().optional().transform((v) => v ?? null),
  pilot_branch_id: z.string().nullable().optional().transform((v) => v ?? null),
  enabled: z.boolean(),
  last_reconciled_at: z.string().nullable().optional().transform((v) => v ?? null),
  lead_intake_mode: Mode,
  deal_intake_mode: Mode,
  deal_entry_stage_ids: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  bitrix_trip_facts_read: z.boolean().nullable().optional().transform((v) => v === true),
  lead_intake_unowned: z.boolean().nullable().optional().transform((v) => v === true),
  bitrix_id_proof_copy: z.boolean().nullable().optional().transform((v) => v === true),
  bitrix_name_read: z.boolean().nullable().optional().transform((v) => v === true),
  bitrix_trip_details_read: z.boolean().nullable().optional().transform((v) => v === true),
});

export function parseIntakeConfigRow(row: unknown): IntakeConfig | null {
  const parsed = Row.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    portalDomain: r.portal_domain,
    portalMemberId: r.portal_member_id,
    categoryId: r.category_id,
    categoryIds: r.eligible_category_ids ?? [r.category_id],
    eligibleStageIds: r.eligible_stage_ids,
    cutoffAt: r.cutoff_at,
    pilotLegalEntityId: r.pilot_legal_entity_id,
    pilotBranchId: r.pilot_branch_id,
    enabled: r.enabled,
    lastReconciledAt: r.last_reconciled_at,
    leadIntakeMode: r.lead_intake_mode,
    dealIntakeMode: r.deal_intake_mode,
    dealEntryStageIds: r.deal_entry_stage_ids,
    tripFactsRead: r.bitrix_trip_facts_read,
    leadIntakeUnowned: r.lead_intake_unowned,
    idProofCopy: r.bitrix_id_proof_copy,
    bitrixNameRead: r.bitrix_name_read,
    tripDetailsRead: r.bitrix_trip_details_read,
  };
}

/**
 * The single ENABLED Bitrix intake config, or a reason why there is none.
 * More than one enabled row is ambiguous (the env carries one REST credential)
 * and fails closed.
 */
export function countEnabled(rows: unknown[]): number {
  return rows.map(parseIntakeConfigRow).filter((c) => c?.enabled).length;
}

export function selectActiveConfig(rows: unknown[]): { config: IntakeConfig } | { config: null; reason: 'not_configured' | 'ambiguous' } {
  const enabled = rows.map(parseIntakeConfigRow).filter((c): c is IntakeConfig => c !== null && c.enabled);
  if (enabled.length === 0) return { config: null, reason: 'not_configured' };
  if (enabled.length > 1) return { config: null, reason: 'ambiguous' };
  return { config: enabled[0]! };
}

/** Mirrors the database portal/environment gate for truthful status reporting. */
export function isIntakeEnvironmentAllowed(environment: string, portalDomain: string | null): boolean {
  if (!portalDomain) return false;
  const synthetic = portalDomain.endsWith('.test');
  return (environment === 'operational' && !synthetic) || (environment === 'test' && synthetic);
}
