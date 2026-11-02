import type { ApplyResult, IntakeErrorCode, IntakeReasonCode, WorkerRunSummary } from '../contracts';
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
  const stats: ItemCounters & { deadlineReached: boolean } = {
    summary,
    released: 0,
    providerErrors: 0,
    internalErrors: 0,
    deadlineReached: false,
  };
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

  for (const item of items) {
    if (stats.deadlineReached || now() >= deadline) {
      stats.deadlineReached = true;
      await releaseItem(deps, item, stats);
      continue;
    }
    // After a rate limit, do not hammer the provider: hand the rest back untouched.
    if (rateLimited) {
      await releaseItem(deps, item, stats);
      continue;
    }
    const result = await processInboxItem(deps, item, { tripFactsOn, tripDetailsOn, rateLimited, prefetched }, stats);
    if (result.rateLimited) rateLimited = true;
  }
  return { ...stats, outcome: runOutcome(stats) };
}

/** The counters one item updates (the batch's summary and error counts). */
export interface ItemCounters {
  summary: WorkerRunSummary;
  released: number;
  providerErrors: number;
  internalErrors: number;
}

export interface ItemFlags {
  tripFactsOn: boolean;
  tripDetailsOn: boolean;
  /** A rate limit was met earlier in this run: the facts step makes no provider call. */
  rateLimited: boolean;
  /** Deals already read by one crm.deal.list for the batch (keyed by Bitrix ID). */
  prefetched?: ReadonlyMap<string, Record<string, unknown>>;
  /**
   * "Refresh from Bitrix now" only: also read the Deal's linked Contact and
   * Company when the database does not ask for them (a contact's phone can
   * change in Bitrix without the Deal changing). Never set by the batch.
   */
  rereadParties?: boolean;
}

/** How a recorded failure ended (see recordItemFailure). */
export type FailureRecord = 'recorded' | 'settled' | 'unconfirmed';

export type ItemResult =
  /** The row was refused before any provider call (other portal, inconsistent row). */
  | { kind: 'refused'; rateLimited: false; failure: FailureRecord }
  /** Reading Bitrix failed; the row was failed with this code. */
  | { kind: 'read_failed'; code: IntakeErrorCode; rateLimited: boolean; failure: FailureRecord }
  /** The apply command answered; `facts` is the facts step (null when it did not run). */
  | {
      kind: 'applied';
      outcome: ApplyResult['outcome'];
      reasonCode: IntakeReasonCode | null;
      facts: TripFactsOutcome | null;
      rateLimited: boolean;
    }
  /** The apply command failed or its answer was unreadable; the row was failed or found finished. */
  | { kind: 'apply_failed'; rateLimited: false; failure: FailureRecord };

/**
 * 'recorded' = the row is now failed / dead-lettered; 'settled' = the fail was
 * refused because the row was already finished (for example the apply had
 * committed but its answer could not be read), counted by its real status;
 * 'unconfirmed' = neither could be confirmed (lease lost, database unavailable):
 * counted as failed, and the lease expiry retries the row.
 */
async function recordItemFailure(
  deps: Pick<WorkerDeps, 'rpc'>,
  item: ClaimedSourceItem,
  code: IntakeErrorCode,
  retryable: boolean,
  stats: ItemCounters,
): Promise<FailureRecord> {
  const summary = stats.summary;
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
}

/** Returns a leased row to pending without consuming an attempt; a failed release lets the lease expire. */
export async function releaseItem(deps: Pick<WorkerDeps, 'rpc'>, item: ClaimedSourceItem, stats: ItemCounters): Promise<void> {
  try {
    await releaseInbox(deps.rpc, item);
    stats.released += 1;
  } catch {
    // Lease expires instead; nothing else to do.
    stats.internalErrors += 1;
  }
}

/**
 * One leased inbox row: read Bitrix (Deal or Lead), apply, then the facts
 * step. The scheduled batch and "Refresh from Bitrix now" share it. Updates
 * `stats` exactly as the batch always has and never throws for a provider or
 * database refusal (the row is failed instead).
 */
export async function processInboxItem(
  deps: Pick<WorkerDeps, 'rpc' | 'bitrix' | 'config'>,
  item: ClaimedSourceItem,
  flags: ItemFlags,
  stats: ItemCounters,
): Promise<ItemResult> {
  const { tripFactsOn, tripDetailsOn } = flags;
  // A row from another portal cannot be read with this portal's credential.
  if (item.portalMemberId !== deps.config.portalMemberId) {
    stats.internalErrors += 1;
    return { kind: 'refused', rateLimited: false, failure: await recordItemFailure(deps, item, 'internal_error', false, stats) };
  }

  // Source object must be known and consistent before any provider call.
  if (item.sourceObject === null) {
    stats.internalErrors += 1;
    return { kind: 'refused', rateLimited: false, failure: await recordItemFailure(deps, item, 'internal_error', false, stats) };
  }

  let apply: () => Promise<Pick<ApplyResult, 'outcome' | 'reasonCode'>>;
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
      const cached = flags.prefetched?.get(item.sourceDealId);
      const read = cached ? { kind: 'ok' as const, deal: cached } : await deps.bitrix.getDeal(item.sourceDealId);
      // Not found (deleted / no access): apply with null -> needs_review, source_deal_not_found.
      const deal = read.kind === 'not_found' ? null : toDealSnapshot(read.deal);
      if (deal && deal.id !== item.sourceDealId) throw new BitrixClientError('provider_bad_response', 200);
      if ((tripFactsOn || tripDetailsOn) && read.kind === 'ok') facts = toDealFactsPayload(read.deal, tripFactsOn, tripDetailsOn);
      apply = () => applyBitrixDeal(deps.rpc, item, deal);
    }
  } catch (error) {
    const code: IntakeErrorCode = error instanceof BitrixClientError ? error.code : 'internal_error';
    if (code === 'internal_error') stats.internalErrors += 1;
    else stats.providerErrors += 1;
    const failure = await recordItemFailure(deps, item, code, RETRYABLE[code], stats);
    return { kind: 'read_failed', code, rateLimited: code === 'provider_rate_limited', failure };
  }

  try {
    const applied = await apply();
    const summary = stats.summary;
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
    // 'stale_ignored' is also the answer for an unchanged Deal, so its facts
    // are stored too (a facts-only correction shows).
    let factsOutcome: TripFactsOutcome | null = null;
    let rateLimited = false;
    if (facts && (applied.outcome === 'created' || applied.outcome === 'updated' || applied.outcome === 'stale_ignored')) {
      factsOutcome = await storeTripFactsDetailed(deps, item.inboxId, facts, flags.rateLimited, {
        rereadParties: flags.rereadParties === true,
      });
      const step = factsOutcome.step;
      if (step === 'rate_limited') rateLimited = true;
      if (step === 'rate_limited' || step === 'provider_error') stats.providerErrors += 1;
      if (step === 'internal_error') stats.internalErrors += 1;
    }
    return { kind: 'applied', outcome: applied.outcome, reasonCode: applied.reasonCode ?? null, facts: factsOutcome, rateLimited };
  } catch {
    // A refused answer after a committed apply is counted by the row's real status, not as an error.
    const failure = await recordItemFailure(deps, item, 'internal_error', true, stats);
    if (failure === 'recorded') stats.internalErrors += 1;
    return { kind: 'apply_failed', rateLimited: false, failure };
  }
}

export type TripFactsStep = 'done' | 'rate_limited' | 'provider_error' | 'internal_error';

/** The facts step and whether it stored anything new (facts or a Contact / Company snapshot). */
export interface TripFactsOutcome {
  step: TripFactsStep;
  changed: boolean;
}

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
  return (await storeTripFactsDetailed(deps, inboxId, facts, rateLimited)).step;
}

/**
 * storeTripFacts with the "changed" flag. With `rereadParties` (refresh only)
 * the Deal's primary Contact and its Company are read even when the database
 * asks for neither; the database accepts only a party linked from the stored
 * facts, so nothing else can be stored.
 */
export async function storeTripFactsDetailed(
  deps: Pick<WorkerDeps, 'rpc' | 'bitrix'>,
  inboxId: string,
  facts: DealFactsPayload | LeadSourceFacts,
  rateLimited = false,
  options: { rereadParties?: boolean } = {},
): Promise<TripFactsOutcome> {
  let parties: Array<{ kind: 'contact' | 'company'; id: string }>;
  let changed = false;
  try {
    const stored = await applyBitrixTripFacts(deps.rpc, inboxId, facts);
    parties = stored.parties;
    changed = stored.outcome === 'stored';
  } catch {
    return { step: 'internal_error', changed };
  }
  if (options.rereadParties) parties = withLinkedParties(parties, facts);
  // After a rate limit no provider call is made; a missing snapshot is asked for again on the next read.
  if (rateLimited) return { step: 'done', changed };
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
      const result = await applyBitrixParty(deps.rpc, inboxId, snapshot);
      if (result.outcome === 'stored') changed = true;
    } catch (error) {
      if (error instanceof BitrixClientError) {
        const step = error.code === 'provider_rate_limited' ? 'rate_limited' : error.code === 'internal_error' ? 'internal_error' : 'provider_error';
        return { step, changed };
      }
      return { step: 'internal_error', changed };
    }
  }
  return { step: 'done', changed };
}

/**
 * The parties the database asked for plus the Deal's primary Contact (the
 * CONTACT_ID, else the lowest of CONTACT_IDS, as the database picks it) and
 * its Company, without duplicates. Lead facts and payloads without the
 * DEC-36 keys (that switch off) add nothing.
 */
export function withLinkedParties(
  asked: ReadonlyArray<{ kind: 'contact' | 'company'; id: string }>,
  facts: DealFactsPayload | LeadSourceFacts,
): Array<{ kind: 'contact' | 'company'; id: string }> {
  const out = [...asked];
  const add = (kind: 'contact' | 'company', id: string | null | undefined) => {
    if (id && !out.some((p) => p.kind === kind && p.id === id)) out.push({ kind, id });
  };
  if ('companyTitle' in facts) return out; // Lead facts
  const ids = Array.isArray(facts.contactIds) ? [...facts.contactIds].sort((a, b) => Number(a) - Number(b)) : [];
  add('contact', facts.contactId ?? ids[0] ?? null);
  add('company', facts.companyId ?? null);
  return out;
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
