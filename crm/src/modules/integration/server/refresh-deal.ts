import 'server-only';
import { intakeRuntimeRefusal } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createBitrixClient, type BitrixClient } from '../bitrix/client';
import { getIntegrationEnv, resolveBitrixRestTarget, type BitrixRestTarget } from '../bitrix/config';
import { emptySummary, processInboxItem, releaseItem, type ItemCounters } from '../bitrix/worker';
import { asRpcClient, bitrixRefreshBegin, IntakeCommandError, type ClaimedSourceItem, type RpcClient } from '../commands';
import { parseIntakeConfigRow, selectIntakeConfig, type IntakeConfig } from '../intake-config';

/**
 * Book now v2: "Refresh from Bitrix now" for one Deal (build plan section 3).
 *
 *   1. booking_bitrix_refresh_begin under the staff member's OWN session:
 *      editor check, Bitrix Deal check, read switches, sync not paused,
 *      10 refreshes per staff member per minute, 20 s cooldown per Deal,
 *      one inbox row leased for 90 s, audit (ids only).
 *   2. Only then the privileged client: the same per-row code as the
 *      scheduled sync (processInboxItem) reads the Deal with crm.deal.get and,
 *      while the facts switch is on, its linked Contact / Company
 *      (crm.contact.get / crm.company.get), and applies them through the
 *      intake commands. READ ONLY: the read webhook and its allow-listed read
 *      methods; the Bitrix write credential is never used here.
 *
 * Bounded: each Bitrix request has REFRESH_REQUEST_TIMEOUT_MS and a rate
 * limit is not retried, so at most three requests take at most about 15 s.
 * A row whose lease is not finished is retried by the scheduled sync.
 * No provider text, Deal value or credential leaves this function.
 */

/** Per request; three requests (Deal, Contact, Company) stay within the 15 s budget. */
export const REFRESH_REQUEST_TIMEOUT_MS = 5_000;

export type RefreshDealOutcome =
  /** The Deal (or its trip facts, Contact or Company) changed in the CRM. */
  | { kind: 'updated'; readAt: string }
  /** Read from Bitrix; nothing new. readAt is null when the CRM could not take the Deal (outside the sync scope). */
  | { kind: 'unchanged'; readAt: string | null }
  /** scope 'deal': this Deal was refreshed in the last 20 s; 'staff': the caller made 10 refreshes in the last minute. */
  | { kind: 'too_soon'; retryAfterSeconds: number; scope: 'deal' | 'staff' }
  | { kind: 'switched_off' }
  /** The scheduled Bitrix sync is paused by an admin. */
  | { kind: 'sync_paused' }
  | { kind: 'not_bitrix_deal' }
  | { kind: 'deal_removed' }
  | { kind: 'bitrix_deal_not_found' }
  /**
   * Bitrix could not be read or applied now. detail:
   * provider = no usable answer; partial = the Deal was read but the
   * Contact / Company or the facts step failed; not_applied = the CRM kept
   * the Deal for review (owner or data issue); not_configured = the read
   * credential or runtime is not set up; unconfirmed = the result could not be confirmed.
   */
  | { kind: 'bitrix_unavailable'; detail: 'provider' | 'partial' | 'not_applied' | 'not_configured' | 'unconfirmed' }
  | { kind: 'not_authorized' }
  | { kind: 'environment_unset' }
  | { kind: 'invalid_input' };

export interface RefreshDealDeps {
  /** The staff member's own session (authorization by the database). */
  userRpc: RpcClient;
  /** The privileged client; called only after the database authorized the request. */
  adminRpc: () => RpcClient;
  /** The enabled intake config of the portal (privileged read), or null. */
  loadConfig: (portalMemberId: string) => Promise<IntakeConfig | null>;
  /** A read-only Bitrix client for the config's portal, or null when not configured. */
  bitrix: (config: IntakeConfig) => RefreshBitrix | null;
  /** The intake runtime gate (a Preview build never reads Bitrix). */
  runtimeAllowed: () => boolean;
  requestId?: () => string;
  now?: () => number;
}

export type RefreshBitrix = Pick<BitrixClient, 'getDeal' | 'getLead'> & Partial<Pick<BitrixClient, 'getContactBasics' | 'getCompanyBasics'>>;

/** The read-only client the refresh uses: short timeout, a rate limit is not retried. */
export function createRefreshBitrixClient(target: BitrixRestTarget, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
  return createBitrixClient({
    target,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? REFRESH_REQUEST_TIMEOUT_MS,
    maxRateLimitRetries: 0,
  });
}

function counters(): ItemCounters {
  return { summary: emptySummary(), released: 0, providerErrors: 0, internalErrors: 0 };
}

export async function refreshDealWith(deps: RefreshDealDeps, dealId: string): Promise<RefreshDealOutcome> {
  const now = deps.now ?? Date.now;
  let begin;
  try {
    begin = await bitrixRefreshBegin(deps.userRpc, dealId, (deps.requestId ?? (() => crypto.randomUUID()))());
  } catch (error) {
    if (error instanceof IntakeCommandError) {
      if (error.sqlState === '42501') return { kind: 'not_authorized' };
      if (error.sqlState === '22023') return { kind: 'invalid_input' };
      if (error.refusal === 'environment_unset') return { kind: 'environment_unset' };
      if (error.sqlState === '55000') return { kind: 'bitrix_unavailable', detail: 'not_configured' };
      if (error.sqlState === '23505') return { kind: 'bitrix_unavailable', detail: 'unconfirmed' };
    }
    throw error;
  }
  if (!begin.allowed) {
    if (begin.reason === 'too_soon') return { kind: 'too_soon', scope: 'deal', retryAfterSeconds: Math.max(1, begin.retryAfterSeconds ?? 20) };
    if (begin.reason === 'staff_limit') return { kind: 'too_soon', scope: 'staff', retryAfterSeconds: Math.max(1, begin.retryAfterSeconds ?? 60) };
    return { kind: begin.reason };
  }

  const item: ClaimedSourceItem = begin.item;
  const rpc = deps.adminRpc();
  const stats = counters();
  let config: IntakeConfig | null = null;
  let bitrix: RefreshBitrix | null = null;
  try {
    if (deps.runtimeAllowed()) {
      config = await deps.loadConfig(item.portalMemberId);
      bitrix = config ? deps.bitrix(config) : null;
    }
  } catch {
    config = null;
  }
  if (!config || !bitrix || config.portalMemberId !== item.portalMemberId) {
    // Hand the row back untouched; the scheduled sync reads it later.
    await releaseItem({ rpc }, item, stats);
    return { kind: 'bitrix_unavailable', detail: 'not_configured' };
  }

  const result = await processInboxItem(
    { rpc, bitrix, config },
    item,
    {
      tripFactsOn: config.tripFactsRead === true,
      tripDetailsOn: config.tripDetailsRead === true,
      rateLimited: false,
      rereadParties: true,
    },
    stats,
  );
  const readAt = new Date(now()).toISOString();
  switch (result.kind) {
    case 'refused':
      return { kind: 'bitrix_unavailable', detail: 'not_configured' };
    case 'read_failed':
      return { kind: 'bitrix_unavailable', detail: result.code === 'internal_error' ? 'unconfirmed' : 'provider' };
    case 'apply_failed':
      return { kind: 'bitrix_unavailable', detail: 'unconfirmed' };
    case 'applied':
      break;
  }
  if (result.outcome === 'needs_review') {
    return result.reasonCode === 'source_deal_not_found'
      ? { kind: 'bitrix_deal_not_found' }
      : { kind: 'bitrix_unavailable', detail: 'not_applied' };
  }
  if (result.outcome === 'ignored') return { kind: 'unchanged', readAt: null };
  if (result.facts && result.facts.step !== 'done') return { kind: 'bitrix_unavailable', detail: 'partial' };
  if (result.outcome === 'created' || result.outcome === 'updated' || result.facts?.changed) return { kind: 'updated', readAt };
  return { kind: 'unchanged', readAt };
}

let admin: ReturnType<typeof createSupabaseAdminClient> | undefined;
function adminClient() {
  admin ??= createSupabaseAdminClient();
  return admin;
}

async function loadEnabledConfig(portalMemberId: string): Promise<IntakeConfig | null> {
  const { data, error } = await selectIntakeConfig((columns) =>
    adminClient()
      .from('integration_intake_config')
      .select(columns)
      .eq('source_system', 'bitrix')
      .eq('portal_member_id', portalMemberId)
      .eq('enabled', true),
  );
  if (error) return null;
  const rows = (data ?? []).map(parseIntakeConfigRow).filter((c): c is IntakeConfig => c !== null && c.enabled);
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * "Refresh from Bitrix now" for one Deal, for a signed-in staff member
 * (the caller has already run requireStaff()). Never throws for a refusal;
 * an unexpected database answer is rethrown (the outcome is unknown).
 */
export function refreshDealNow(staff: { supabase: { rpc: (...args: never[]) => unknown } }, dealId: string): Promise<RefreshDealOutcome> {
  return refreshDealWith(
    {
      userRpc: asRpcClient(staff.supabase),
      adminRpc: () => asRpcClient(adminClient()),
      loadConfig: loadEnabledConfig,
      bitrix: (config) => {
        try {
          const target = resolveBitrixRestTarget(getIntegrationEnv().bitrixWebhookBaseUrl, config.portalDomain, process.env.APP_ENV);
          return createRefreshBitrixClient(target);
        } catch {
          return null;
        }
      },
      runtimeAllowed: () => intakeRuntimeRefusal(process.env.APP_ENV, process.env.VERCEL_ENV, getIntegrationEnv()) === null,
    },
    dealId,
  );
}
