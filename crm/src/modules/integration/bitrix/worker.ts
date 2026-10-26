import type { ApplyResult, IntakeErrorCode, WorkerRunSummary } from '../contracts';
import {
  applyBitrixDeal,
  applyBitrixLead,
  applyBitrixParty,
  applyBitrixTripFacts,
  claimInbox,
  failInbox,
  inboxRowStatus,
  releaseInbox,
  type ClaimedSourceItem,
  type RpcClient,
  type RunOutcome,
} from '../commands';
import type { IntakeConfig } from '../intake-config';
import { BitrixClientError, type BitrixClient } from './client';
import { toDealSnapshot } from './deal';
import { toLeadSnapshot } from './lead';
import {
  DEAL_TRIP_FACT_FIELDS,
  toCompanySnapshot,
  toContactSnapshot,
  toDealTripFacts,
  toLeadSourceFacts,
  type DealTripFacts,
  type LeadSourceFacts,
} from './trip-facts';
import { DEAL_TRIP_DETAIL_FIELDS, toDealTripDetails, type DealTripDetails } from './trip-details';

/**
 * Voice-note batch (20261128000100): the Deal values sent to
 * integration_apply_bitrix_trip_facts. Each group only while its own switch is
 * on: the DEC-36 facts (bitrix_trip_facts_read) and the trip details
 * (bitrix_trip_details_read: destination, adults, children, infants). The
 * database ignores a group whose switch is off; the app does not even send it.
 */
export type DealFactsPayload = Partial<DealTripFacts> & Partial<DealTripDetails> & { dateModify: string | null };

export function toDealFactsPayload(raw: Record<string, unknown>, factsOn: boolean, detailsOn: boolean): DealFactsPayload {
  const facts = toDealTripFacts(raw);
  const base: DealFactsPayload = factsOn ? { ...facts } : { dateModify: facts.dateModify };
  return detailsOn ? { ...base, ...toDealTripDetails(raw) } : base;
}

/**
 * One bounded, synchronous intake batch (contract §6, §12 L1):
 *   claim (lease) -> crm.deal.get -> BitrixDealSnapshot -> integration_apply_bitrix_deal | fail | release
 *                 -> crm.lead.get -> BitrixLeadSnapshot -> integration_apply_bitrix_lead (Phase 6).
 *
 * The claimed row's source object alone chooses the path: a Lead ID is never
 * sent to crm.deal.get or integration_apply_bitrix_deal, and a Deal ID never to
 * the Lead path. A row whose object is inconsistent with its event type is
 * dead-lettered (internal_error, not retryable) without any provider call.
 *
 * Everything is awaited before returning; no promise outlives the request.
 * Items are processed sequentially (Bitrix allows ~2 req/s on non-Enterprise
 * plans). Leased items not processed because the deadline passed, or deferred
 * after a rate limit, are RELEASED back to pending without consuming an attempt.
 * If a release itself fails, the lease simply expires (P2-06).
 */

export const WORKER_MAX_LIMIT = 25;
export const WORKER_DEFAULT_LIMIT = 10;
/** Exceeds the batch deadline plus one slow item, so a live run never loses its lease. */
export const WORKER_LEASE_SECONDS = 120;
export const WORKER_DEADLINE_MS = 60_000;

/** Provider failures worth retrying with back-off; auth failures need an operator. */
const RETRYABLE: Record<IntakeErrorCode, boolean> = {
  provider_timeout: true,
  provider_unavailable: true,
  provider_rate_limited: true,
  provider_bad_response: true,
  provider_auth_failed: false,
  internal_error: true,
};

export interface WorkerDeps {
  rpc: RpcClient;
  bitrix: Pick<BitrixClient, 'getDeal' | 'getLead'> &
    Partial<Pick<BitrixClient, 'listDeals' | 'getContactBasics' | 'getCompanyBasics'>>;
  config: IntakeConfig;
  /**
   * Read the whole claimed batch with ONE crm.deal.list (@ID filter) instead
   * of one crm.deal.get per row; rows it does not return (deleted, no access)
   * still go through crm.deal.get. A failed prefetch falls back silently.
   */
  prefetch?: boolean;
  limit?: number;
  leaseSeconds?: number;
  deadlineMs?: number;
  now?: () => number;
}

export interface WorkerRunStats {
  summary: WorkerRunSummary;
  released: number;
  providerErrors: number;
  internalErrors: number;
  deadlineReached: boolean;
  outcome: RunOutcome;
}

export function emptySummary(): WorkerRunSummary {
  return { claimed: 0, created: 0, updated: 0, ignored: 0, needsReview: 0, failed: 0, deadLettered: 0 };
}

export function clampLimit(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(n) || n < 1) return WORKER_DEFAULT_LIMIT;
  return Math.min(n, WORKER_MAX_LIMIT);
}

/** Heartbeat outcome: ok (nothing went wrong), partial (some work done, some not), provider/internal error. */
export function runOutcome(stats: Omit<WorkerRunStats, 'outcome'>): RunOutcome {
  const s = stats.summary;
  const done = s.created + s.updated + s.ignored + s.needsReview;
  const problems = s.failed + s.deadLettered + stats.released + stats.providerErrors + stats.internalErrors;
  if (problems === 0 && !stats.deadlineReached) return 'ok';
  if (done > 0) return 'partial';
  if (stats.providerErrors > 0) return 'provider_error';
  if (stats.internalErrors > 0) return 'internal_error';
  return 'partial';
}

export async function runInboxBatch(deps: WorkerDeps): Promise<WorkerRunStats> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.deadlineMs ?? WORKER_DEADLINE_MS);
  const summary = emptySummary();
  const stats = { summary, released: 0, providerErrors: 0, internalErrors: 0, deadlineReached: false };
  const items = await claimInbox(deps.rpc, clampLimit(deps.limit), deps.leaseSeconds ?? WORKER_LEASE_SECONDS);
  summary.claimed = items.length;
  let rateLimited = false;
  // B1.2 (DEC-36): read and store the owner-named Bitrix values only while the switch is on.
  const tripFactsOn = deps.config.tripFactsRead === true;
  // Voice-note batch: destination and counts, behind their own switch.
  const tripDetailsOn = deps.config.tripDetailsRead === true;
  // Only Deal rows are prefetched: a Lead ID never reaches crm.deal.list.
  const prefetched =
    deps.prefetch && deps.bitrix.listDeals
      ? await prefetchDeals(
          deps.bitrix.listDeals,
          items.filter((i) => i.sourceObject === 'deal'),
          tripFactsOn,
          tripDetailsOn,
        )
      : new Map();

  /**
   * 'recorded' = the row is now failed / dead-lettered; 'settled' = the fail was
   * refused because the row was already finished (for example the apply had
   * committed but its answer could not be read), counted by its real status;
   * 'unconfirmed' = neither could be confirmed (lease lost, database unavailable):
   * counted as failed, and the lease expiry retries the row.
   */
  const recordFailure = async (
    item: ClaimedSourceItem,
    code: IntakeErrorCode,
    retryable: boolean,
  ): Promise<'recorded' | 'settled' | 'unconfirmed'> => {
    try {
      const result = await failInbox(deps.rpc, item, code, retryable);
      if (result.status === 'dead_letter') summary.deadLettered += 1;
      else summary.failed += 1;
      return 'recorded';
    } catch {
      switch (await inboxRowStatus(deps.rpc, item.inboxId)) {
        case 'processed':
          // Saved (created or updated; the answer that said which was lost).
          summary.updated += 1;
          return 'settled';
        case 'ignored':
          summary.ignored += 1;
          return 'settled';
        case 'needs_review':
          summary.needsReview += 1;
          return 'settled';
        case 'dead_letter':
          summary.deadLettered += 1;
          return 'settled';
        default:
          summary.failed += 1;
          stats.internalErrors += 1;
          return 'unconfirmed';
      }
    }
  };

  const release = async (item: ClaimedSourceItem) => {
    try {
      await releaseInbox(deps.rpc, item);
      stats.released += 1;
    } catch {
      // Lease expires instead; nothing else to do.
      stats.internalErrors += 1;
    }
  };

  for (const item of items) {
    if (stats.deadlineReached || now() >= deadline) {
      stats.deadlineReached = true;
      await release(item);
      continue;
    }
    // After a rate limit, do not hammer the provider: hand the rest back untouched.
    if (rateLimited) {
      await release(item);
      continue;
    }
    // A row from another portal cannot be read with this portal's credential.
    if (item.portalMemberId !== deps.config.portalMemberId) {
      stats.internalErrors += 1;
      await recordFailure(item, 'internal_error', false);
      continue;
    }

    // Source object must be known and consistent before any provider call.
    if (item.sourceObject === null) {
      stats.internalErrors += 1;
      await recordFailure(item, 'internal_error', false);
      continue;
    }

    let apply: () => Promise<Pick<ApplyResult, 'outcome'>>;
    let facts: DealFactsPayload | LeadSourceFacts | null = null;
    try {
      if (item.sourceObject === 'lead') {
        const read = tripFactsOn
          ? await deps.bitrix.getLead(item.sourceDealId, { facts: true })
          : await deps.bitrix.getLead(item.sourceDealId);
        // Not found (deleted / no access): apply with null -> needs_review.
        const lead = read.kind === 'not_found' ? null : toLeadSnapshot(read.lead);
        if (lead && lead.id !== item.sourceDealId) throw new BitrixClientError('provider_bad_response', 200);
        if (tripFactsOn && read.kind === 'ok' && read.facts) facts = toLeadSourceFacts(read.facts);
        apply = () => applyBitrixLead(deps.rpc, item, lead);
      } else {
        // Deals listed in one prefetch call (sync) are not fetched again.
        const cached = prefetched.get(item.sourceDealId);
        const read = cached ? { kind: 'ok' as const, deal: cached } : await deps.bitrix.getDeal(item.sourceDealId);
        // Not found (deleted / no access): apply with null -> needs_review, source_deal_not_found.
        const deal = read.kind === 'not_found' ? null : toDealSnapshot(read.deal);
        if (deal && deal.id !== item.sourceDealId) throw new BitrixClientError('provider_bad_response', 200);
        if ((tripFactsOn || tripDetailsOn) && read.kind === 'ok') facts = toDealFactsPayload(read.deal, tripFactsOn, tripDetailsOn);
        apply = () => applyBitrixDeal(deps.rpc, item, deal);
      }
    } catch (error) {
      const code: IntakeErrorCode = error instanceof BitrixClientError ? error.code : 'internal_error';
      if (code === 'provider_rate_limited') rateLimited = true;
      if (code === 'internal_error') stats.internalErrors += 1;
      else stats.providerErrors += 1;
      await recordFailure(item, code, RETRYABLE[code]);
      continue;
    }

    try {
      const applied = await apply();
      switch (applied.outcome) {
        case 'created':
          summary.created += 1;
          break;
        case 'updated':
          summary.updated += 1;
          break;
        case 'needs_review':
          summary.needsReview += 1;
          break;
        case 'ignored':
        case 'stale_ignored':
          summary.ignored += 1;
          break;
      }
      // B1.2: the row is finished; the facts are a separate, retry-safe step
      // (a failure here never fails the inbox row; the next read repeats it).
      if (facts && (applied.outcome === 'created' || applied.outcome === 'updated' || applied.outcome === 'stale_ignored')) {
        const step = await storeTripFacts(deps, item.inboxId, facts, rateLimited);
        if (step === 'rate_limited') rateLimited = true;
        if (step === 'rate_limited' || step === 'provider_error') stats.providerErrors += 1;
        if (step === 'internal_error') stats.internalErrors += 1;
      }
    } catch {
      // A refused answer after a committed apply is counted by the row's real status, not as an error.
      if ((await recordFailure(item, 'internal_error', true)) === 'recorded') stats.internalErrors += 1;
    }
  }
  return { ...stats, outcome: runOutcome(stats) };
}

export type TripFactsStep = 'done' | 'rate_limited' | 'provider_error' | 'internal_error';

/**
 * B1.2 (DEC-36): stores the facts of a finished inbox row, then reads and stores
 * the linked Contact / Company the database asks for (at most two calls, only
 * when the link changed or no snapshot exists). Values never leave this
 * function except to the two database commands; failures are codes only.
 */
export async function storeTripFacts(
  deps: Pick<WorkerDeps, 'rpc' | 'bitrix'>,
  inboxId: string,
  facts: DealFactsPayload | LeadSourceFacts,
  rateLimited = false,
): Promise<TripFactsStep> {
  let parties: Array<{ kind: 'contact' | 'company'; id: string }>;
  try {
    parties = (await applyBitrixTripFacts(deps.rpc, inboxId, facts)).parties;
  } catch {
    return 'internal_error';
  }
  // After a rate limit no provider call is made; a missing snapshot is asked for again on the next read.
  if (rateLimited) return 'done';
  for (const party of parties) {
    try {
      let snapshot = null;
      if (party.kind === 'contact' && deps.bitrix.getContactBasics) {
        const read = await deps.bitrix.getContactBasics(party.id);
        snapshot = read.kind === 'ok' ? toContactSnapshot(read.contact) : null;
      } else if (party.kind === 'company' && deps.bitrix.getCompanyBasics) {
        const read = await deps.bitrix.getCompanyBasics(party.id);
        snapshot = read.kind === 'ok' ? toCompanySnapshot(read.company) : null;
      }
      // Not found, no reader, or an answer for another id: nothing is stored.
      if (!snapshot || snapshot.id !== party.id) continue;
      await applyBitrixParty(deps.rpc, inboxId, snapshot);
    } catch (error) {
      if (error instanceof BitrixClientError) {
        return error.code === 'provider_rate_limited' ? 'rate_limited' : error.code === 'internal_error' ? 'internal_error' : 'provider_error';
      }
      return 'internal_error';
    }
  }
  return 'done';
}

/**
 * Fields the snapshot needs (toDealSnapshot); the same names crm.deal.get returns.
 * SOURCE_ID and LEAD_ID are listed so a prefetched Deal carries the same
 * snapshot as crm.deal.get (manifest source check, Lead link).
 */
const SNAPSHOT_FIELDS = [
  'ID',
  'TITLE',
  'STAGE_ID',
  'CATEGORY_ID',
  'ASSIGNED_BY_ID',
  'DATE_CREATE',
  'DATE_MODIFY',
  'SOURCE_ID',
  'LEAD_ID',
];

async function prefetchDeals(
  listDeals: BitrixClient['listDeals'],
  items: Array<{ sourceDealId: string; portalMemberId: string }>,
  tripFacts = false,
  tripDetails = false,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (items.length < 2) return out;
  // B1.2: with the switch on, a prefetched row must carry the fact fields too.
  // Voice-note batch: and the trip detail fields while that switch is on.
  const select = [
    ...SNAPSHOT_FIELDS,
    ...(tripFacts ? DEAL_TRIP_FACT_FIELDS : []),
    ...(tripDetails ? DEAL_TRIP_DETAIL_FIELDS : []),
  ];
  try {
    const page = await listDeals({ filter: { '@ID': items.map((i) => i.sourceDealId) }, select, start: 0 });
    for (const deal of page.items) {
      const id = typeof deal.ID === 'string' || typeof deal.ID === 'number' ? String(deal.ID) : '';
      if (id) out.set(id, deal);
    }
  } catch {
    // Per-item crm.deal.get handles errors with the normal retry rules.
  }
  return out;
}

export async function processInboxBatch(deps: WorkerDeps): Promise<WorkerRunSummary> {
  return (await runInboxBatch(deps)).summary;
}
