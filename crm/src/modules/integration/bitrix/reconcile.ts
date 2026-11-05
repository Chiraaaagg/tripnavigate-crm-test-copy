import type { IntakeErrorCode, SourceObject } from '../contracts';
import { enqueueReconcile, recordReconcileRun, type RpcClient } from '../commands';
import { dealListingStageIds, type IntakeConfig } from '../intake-config';
import { BitrixClientError, type BitrixClient } from './client';
import { toUnixSeconds } from './deal';

/**
 * Missed-event reconciliation (P2-11, contract §12 M1).
 *
 * Sync completion §2: an object whose intake mode is 'scope' ignores any
 * manifest. Deals in scope mode take the portal-wide update pass below; Leads
 * in scope mode take a Lead scope pass (DATE_CREATE on/after the sync date,
 * DATE_MODIFY after the separate Lead watermark, enqueued through
 * integration_enqueue_reconcile_lead; the Lead apply decides the owner rule).
 *
 * Phase 6 (contract section 2.4): when an ACTIVE manifest exists for a source
 * object, reconciliation enumerates ONLY that manifest's items, in pages of
 * at most 50 IDs ('@ID' filter, select ID and DATE_MODIFY), and never lists
 * the portal for that object. Leads are reconciled only through an active
 * manifest; with no active Lead manifest nothing is listed or enqueued for
 * Leads. An active Deal manifest replaces the Deal update pass below and
 * leaves the watermark unchanged.
 *
 * Without a Deal manifest, the UPDATE pass: crm.deal.list with >DATE_MODIFY
 * since the watermark (last_reconciled_at minus an overlap, else the sync
 * date), ordered by DATE_MODIFY, ALL pipelines (so a held deal moved to an
 * unticked pipeline is seen and removed). A listed deal is enqueued when it
 * passes the entry rule locally (ticked pipeline, ticked stage - or the entry
 * stage with Won-only intake on - DATE_CREATE on/after the sync date) or CRM
 * already holds it (removed Deals included: the apply decides). The database manifest gate
 * still refuses anything outside a manifest (counted as notInManifest, never
 * as progress).
 *
 * No truncation: when maxPages is reached the watermark moves to the last
 * DATE_MODIFY listed, so the next run continues from there instead of starting
 * over. A complete run moves it to the run's start. A failed run leaves it.
 *
 * Entry of deals that did not change since the watermark is the full resync
 * job's work (resync.ts), which pages by ID cursor until done.
 * integration_enqueue_reconcile dedupes against the stored version and open
 * rows. Only ID, DATE_MODIFY, DATE_CREATE, STAGE_ID and CATEGORY_ID are read:
 * no deal content.
 */

export const RECONCILE_MAX_PAGES = 20;
/**
 * The update pass lists from (watermark - overlap): the watermark is this
 * server's clock (or Bitrix's after a continued run), so a small overlap
 * absorbs clock skew. Re-listed deals cost one dedupe RPC each (up_to_date).
 */
export const WATERMARK_OVERLAP_SECONDS = 120;
/** Bitrix list pages hold at most 50 rows; manifest IDs are requested 50 at a time. */
export const MANIFEST_PAGE_SIZE = 50;
/** Wall-clock budget for one reconcile run (all passes together). */
export const RECONCILE_DEADLINE_MS = 60_000;
/** Rotation step for never-verified manifest IDs when a run cannot cover them all. */
export const MANIFEST_ROTATION_MS = 5 * 60_000;

/**
 * Deterministic cursor for a bounded manifest pass (no stored state needed).
 *
 * IDs CRM does not hold yet (no last_verified_at) come first, rotated by the
 * run's time bucket so that, when more of them exist than one run may read,
 * successive buckets start one window further on and every ID is eventually
 * requested. IDs CRM holds follow, oldest last_verified_at first: each run
 * re-verifies the stalest records, and a verified record moves to the back.
 * Ties keep ascending ID order.
 */
export function orderManifestIds(
  ids: string[],
  verifiedAt: ReadonlyMap<string, number>,
  options: { nowMs: number; windowSize: number; rotationMs?: number },
): string[] {
  const byId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const fresh = ids.filter((id) => !verifiedAt.has(id)).sort(byId);
  const held = ids
    .filter((id) => verifiedAt.has(id))
    .sort((a, b) => verifiedAt.get(a)! - verifiedAt.get(b)! || byId(a, b));
  let rotated = fresh;
  if (fresh.length > options.windowSize && options.windowSize > 0) {
    const windows = Math.ceil(fresh.length / options.windowSize);
    const bucket = Math.floor(options.nowMs / (options.rotationMs ?? MANIFEST_ROTATION_MS));
    const offset = (bucket % windows) * options.windowSize;
    rotated = [...fresh.slice(offset), ...fresh.slice(0, offset)];
  }
  return [...rotated, ...held];
}

export interface ManifestReconcileCounts {
  /** True when an active manifest scoped this object's pass. */
  scoped: boolean;
  /** Manifest items requested from Bitrix. */
  items: number;
  /** Manifest items Bitrix returned. */
  found: number;
  /** Manifest items Bitrix did not return (deleted or not visible); not enqueued. */
  missing: number;
  enqueued: number;
  /** Manifest IDs requested from Bitrix in this run (bounded by maxPages x 50 and the deadline). */
  requested: number;
  /** True when this run stopped before requesting every manifest ID (page cap or deadline). */
  truncated: boolean;
}

export interface ReconcileSummary {
  scanned: number;
  enqueued: number;
  alreadyQueued: number;
  alreadyCurrent: number;
  /** Deals neither eligible for entry nor held by CRM (not enqueued). */
  notTracked: number;
  invalid: number;
  /** Enqueue refused by the database manifest gate (not_in_manifest / outside_manifest_scope). */
  notInManifest: number;
  /** maxPages or the deadline reached: the next run continues (update pass) or covers the tail (manifest). */
  truncated: boolean;
  /** Phase 6: per-object manifest passes. */
  manifest: Record<SourceObject, ManifestReconcileCounts>;
  /** Sync completion §2: the Lead scope pass (lead_intake_mode = 'scope'). */
  leadScope: LeadScopeCounts;
}

export interface LeadScopeCounts {
  /** True when the config is in Lead scope mode (the pass was due). */
  scoped: boolean;
  /** The Lead watermark could not be read (or no store): the pass was skipped. */
  unavailable: boolean;
  scanned: number;
  enqueued: number;
  truncated: boolean;
  /**
   * The pass failed (Bitrix or database); contained so a Lead problem never
   * stops the Deal sync. The Lead watermark stays; the next run retries.
   */
  error: IntakeErrorCode | null;
}

/**
 * Lead watermark for the scope pass, kept apart from the Deal watermark so the
 * first scope run backfills from the sync date. `read` returns null when no
 * scope pass has completed yet; `record` mirrors integration_record_reconcile_run
 * (advance only when ok, never backwards).
 */
export interface LeadWatermarkStore {
  read: () => Promise<string | null>;
  record: (startedAt: string, ok: boolean) => Promise<void>;
}

export interface ReconcileDeps {
  rpc: RpcClient;
  bitrix: Pick<BitrixClient, 'listDeals' | 'listLeads'>;
  /**
   * Phase 6: IDs of the ACTIVE manifest for this config and object (service
   * role), or null when there is none. Omitted = no manifest support (Deals
   * keep the update pass; Leads are not reconciled).
   */
  activeManifestIds?: (sourceObject: SourceObject) => Promise<string[] | null>;
  /**
   * Phase 6: last_verified_at (ms) of the manifest IDs CRM already holds, used
   * to order a bounded pass stalest-first (orderManifestIds). Omitted = no CRM
   * lookup (every ID counts as never verified; rotation still covers the tail).
   */
  verifiedAt?: (sourceObject: SourceObject, ids: string[]) => Promise<Map<string, number>>;
  /** Sync completion §2: Lead watermark (scope mode). Omitted = the Lead scope pass is skipped. */
  leadWatermark?: LeadWatermarkStore;
  /** Run deadline; defaults to RECONCILE_DEADLINE_MS. */
  deadlineMs?: number;
  config: IntakeConfig;
  /** Which of these source deal IDs CRM already holds for this portal (service role). */
  heldDealIds?: (ids: number[]) => Promise<Set<number>>;
  maxPages?: number;
  now?: () => number;
}

const ID = /^[1-9][0-9]{0,15}$/;

/**
 * Sync-date entry rule (same as integration_apply_bitrix_deal). B1.1d: with
 * Won-only intake on, the entry list replaces the ticked stages.
 */
export function isEntryEligible(
  config: Pick<IntakeConfig, 'categoryIds' | 'eligibleStageIds' | 'cutoffAt' | 'dealEntryStageIds'>,
  deal: { categoryId: string; stageId: string; created: number | null },
): boolean {
  return (
    config.categoryIds.includes(deal.categoryId) &&
    dealListingStageIds(config).includes(deal.stageId) &&
    deal.created !== null &&
    deal.created * 1000 >= Date.parse(config.cutoffAt)
  );
}

export async function reconcileEligibleDeals(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const summary: ReconcileSummary = {
    scanned: 0,
    enqueued: 0,
    alreadyQueued: 0,
    alreadyCurrent: 0,
    notTracked: 0,
    invalid: 0,
    notInManifest: 0,
    truncated: false,
    manifest: {
      deal: { scoped: false, items: 0, found: 0, missing: 0, enqueued: 0, requested: 0, truncated: false },
      lead: { scoped: false, items: 0, found: 0, missing: 0, enqueued: 0, requested: 0, truncated: false },
    },
    leadScope: { scoped: false, unavailable: false, scanned: 0, enqueued: 0, truncated: false, error: null },
  };
  const maxPages = deps.maxPages ?? RECONCILE_MAX_PAGES;
  const deadline = now() + (deps.deadlineMs ?? RECONCILE_DEADLINE_MS);
  const pastDeadline = () => now() >= deadline;

  const enqueue = async (sourceId: number, modified: number, sourceObject: SourceObject = 'deal') => {
    const outcome = await enqueueReconcile(deps.rpc, {
      memberId: config.portalMemberId,
      sourceObject,
      sourceId,
      sourceModified: modified,
    });
    if (outcome === 'enqueued') {
      summary.enqueued += 1;
      if (summary.manifest[sourceObject].scoped) summary.manifest[sourceObject].enqueued += 1;
    } else if (outcome === 'already_queued') summary.alreadyQueued += 1;
    else if (outcome === 'not_in_manifest') summary.notInManifest += 1;
    else summary.alreadyCurrent += 1;
  };

  /** Manifest-only pass: pages of <= 50 manifest IDs, never a portal-wide list. Returns false when incomplete. */
  const manifestPass = async (sourceObject: SourceObject, ids: string[]): Promise<boolean> => {
    const counts = summary.manifest[sourceObject];
    counts.scoped = true;
    const valid = [...new Set(ids)].filter((id) => ID.test(id) && Number(id) <= Number.MAX_SAFE_INTEGER);
    counts.items = valid.length;
    let complete = valid.length === ids.length;
    const windowSize = maxPages * MANIFEST_PAGE_SIZE;
    // Bounded: at most maxPages pages and the run deadline. A deterministic,
    // stalest-first order makes later runs cover the tail.
    let ordered = valid;
    if (valid.length > windowSize) {
      const verified = deps.verifiedAt ? await deps.verifiedAt(sourceObject, valid) : new Map<string, number>();
      ordered = orderManifestIds(valid, verified, { nowMs: now(), windowSize });
    }
    for (let i = 0, pages = 0; i < ordered.length; i += MANIFEST_PAGE_SIZE, pages += 1) {
      if (pages >= maxPages || pastDeadline()) {
        counts.truncated = true;
        complete = false;
        break;
      }
      const page = ordered.slice(i, i + MANIFEST_PAGE_SIZE);
      counts.requested += page.length;
      const filter = { '@ID': page };
      const result =
        sourceObject === 'lead'
          ? await deps.bitrix.listLeads({ filter, select: ['ID', 'DATE_MODIFY'], start: 0 })
          : await deps.bitrix.listDeals({ filter, select: ['ID', 'DATE_MODIFY'], start: 0 });
      if (result.next !== null) complete = false;
      const requested = new Set(page);
      const found = new Set<string>();
      for (const item of result.items) {
        summary.scanned += 1;
        const id = typeof item.ID === 'string' || typeof item.ID === 'number' ? String(item.ID) : '';
        const modified = toUnixSeconds(item.DATE_MODIFY);
        // Never enqueue anything the manifest did not name.
        if (!requested.has(id) || found.has(id) || modified === null) {
          summary.invalid += 1;
          continue;
        }
        found.add(id);
        counts.found += 1;
        await enqueue(Number(id), modified, sourceObject);
      }
      counts.missing += page.length - found.size;
    }
    return complete;
  };

  // Manifest passes. An active Deal manifest replaces the Deal update pass and
  // the watermark stays where it is (it covers the update pass only). Sync
  // completion §2: an object in scope mode ignores its manifest; Deals then take
  // the portal-wide update pass and Leads the scope pass below.
  const dealScope = config.dealIntakeMode === 'scope';
  const leadScope = config.leadIntakeMode === 'scope';
  const dealManifest = !dealScope && deps.activeManifestIds ? await deps.activeManifestIds('deal') : null;
  const leadManifest = !leadScope && deps.activeManifestIds ? await deps.activeManifestIds('lead') : null;
  if (leadManifest !== null && !(await manifestPass('lead', leadManifest))) summary.truncated = true;

  if (dealManifest !== null) {
    if (!(await manifestPass('deal', dealManifest))) summary.truncated = true;
  } else {
    await dealUpdatePass();
  }
  if (leadScope) await leadScopePass();
  return summary;

  /**
   * Deal UPDATE pass: every pipeline, changed since the Deal watermark; a deal
   * is enqueued when it passes the entry rule locally or CRM already holds it.
   */
  async function dealUpdatePass(): Promise<void> {
    const watermark = watermarkFrom(config.lastReconciledAt);
    let complete = false;
    let pass: KeysetResult = { done: false, lastModified: null };
    try {
      pass = await keysetPass({
        list: (filter, start) =>
          deps.bitrix.listDeals({
            filter,
            select: ['ID', 'DATE_MODIFY', 'DATE_CREATE', 'STAGE_ID', 'CATEGORY_ID'],
            order: { DATE_MODIFY: 'ASC', ID: 'ASC' },
            start,
          }),
        baseFilter: {},
        watermark,
        onRows: async (listed) => {
          const rows = listed.map(({ id, modified, item }) => ({
            id,
            modified,
            created: toUnixSeconds(item.DATE_CREATE),
            stageId: typeof item.STAGE_ID === 'string' ? item.STAGE_ID : '',
            categoryId: item.CATEGORY_ID == null ? '' : String(item.CATEGORY_ID),
          }));
          const others = rows.filter((r) => !isEntryEligible(config, r));
          const held = others.length > 0 && deps.heldDealIds ? await deps.heldDealIds(others.map((r) => r.id)) : new Set<number>();
          for (const r of rows) {
            if (!isEntryEligible(config, r) && !held.has(r.id)) {
              summary.notTracked += 1;
              continue;
            }
            await enqueue(r.id, r.modified);
          }
        },
      });
      summary.truncated = summary.truncated || !pass.done;
      complete = true;
    } finally {
      // Complete: watermark = this run's start. Stopped at maxPages or the deadline:
      // continue next run from the last change listed (Bitrix clock; the overlap
      // re-lists it). Failed: unchanged. Never let this mask the original error.
      const { mark, advance } = watermarkAfter(complete, pass);
      await recordReconcileRun(deps.rpc, config.portalMemberId, mark, advance).catch(() => undefined);
    }
  }

  /**
   * Sync completion §2 (scope mode): Leads created on or after the sync date and
   * changed since the Lead watermark, header fields only. The first run (no
   * watermark) lists from the sync date, so it backfills every Lead in scope.
   * The Lead apply decides owner eligibility; nothing is filtered by owner here.
   * Without a Lead watermark store the pass is skipped (never a full re-list on
   * every run).
   */
  async function leadScopePass(): Promise<void> {
    const counts = summary.leadScope;
    counts.scoped = true;
    const store = deps.leadWatermark;
    let since: string | null;
    try {
      if (!store) throw new Error('no lead watermark store');
      since = await store.read();
    } catch {
      counts.unavailable = true;
      return;
    }
    const cutoffMs = Date.parse(config.cutoffAt);
    let complete = false;
    let pass: KeysetResult = { done: false, lastModified: null };
    try {
      pass = await keysetPass({
        list: (filter, start) =>
          deps.bitrix.listLeads({
            filter,
            select: ['ID', 'DATE_MODIFY', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
            order: { DATE_MODIFY: 'ASC', ID: 'ASC' },
            start,
          }),
        baseFilter: { '>=DATE_CREATE': config.cutoffAt },
        watermark: watermarkFrom(since),
        onRows: async (listed) => {
          for (const { id, modified, item } of listed) {
            counts.scanned += 1;
            const created = toUnixSeconds(item.DATE_CREATE);
            // Bitrix filtered on DATE_CREATE already; check again locally.
            if (created === null || created * 1000 < cutoffMs) {
              summary.notTracked += 1;
              continue;
            }
            const before = summary.enqueued;
            await enqueue(id, modified, 'lead');
            counts.enqueued += summary.enqueued - before;
          }
        },
      });
      counts.truncated = !pass.done;
      summary.truncated = summary.truncated || !pass.done;
      complete = true;
    } catch (error) {
      counts.error = error instanceof BitrixClientError ? error.code : 'internal_error';
      // Reported as a partial run (the heartbeat outcome), never as success.
      summary.truncated = true;
    } finally {
      const { mark, advance } = watermarkAfter(complete, pass);
      await store.record(mark, advance).catch(() => undefined);
    }
  }

  /** Watermark minus the overlap, never before the sync date; the sync date when none. */
  function watermarkFrom(last: string | null): string {
    const cutoffMs = Date.parse(config.cutoffAt);
    return last
      ? new Date(Math.max(Date.parse(last) - WATERMARK_OVERLAP_SECONDS * 1000, cutoffMs)).toISOString()
      : config.cutoffAt;
  }

  function watermarkAfter(complete: boolean, pass: KeysetResult): { mark: string; advance: boolean } {
    const truncated = !pass.done;
    const mark = truncated && pass.lastModified !== null ? new Date(pass.lastModified * 1000).toISOString() : startedAt;
    return { mark, advance: complete && (!truncated || pass.lastModified !== null) };
  }

  /**
   * Keyset paging on DATE_MODIFY: each page starts at the last change listed
   * (">=", skipping the records already listed at exactly that second), so a
   * record modified while we list moves forward and is listed again rather than
   * shifting an offset and hiding its neighbour.
   */
  async function keysetPass(opts: {
    list: (filter: Record<string, unknown>, start: number) => Promise<{ items: Array<Record<string, unknown>>; next: number | null }>;
    baseFilter: Record<string, unknown>;
    watermark: string;
    onRows: (rows: Array<{ id: number; modified: number; item: Record<string, unknown> }>) => Promise<void>;
  }): Promise<KeysetResult> {
    let lastModified: number | null = null;
    const seen = new Set<number>();
    let filter: Record<string, unknown> = { ...opts.baseFilter, '>DATE_MODIFY': opts.watermark };
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      if (pastDeadline()) break;
      const result = await opts.list(filter, start);
      const rows = [];
      // Last DATE_MODIFY on this page and how many listed records carry it.
      const pageLast = { raw: '', sec: -1 };
      let atLast = 0;
      for (const item of result.items) {
        const modified = toUnixSeconds(item.DATE_MODIFY);
        if (modified !== null) {
          if (pageLast.sec === modified) atLast += 1;
          else {
            pageLast.raw = String(item.DATE_MODIFY);
            pageLast.sec = modified;
            atLast = 1;
          }
        }
        const id = typeof item.ID === 'string' || typeof item.ID === 'number' ? String(item.ID) : '';
        if (ID.test(id) && seen.has(Number(id))) continue;
        summary.scanned += 1;
        if (!ID.test(id) || Number(id) > Number.MAX_SAFE_INTEGER || modified === null) {
          summary.invalid += 1;
          continue;
        }
        seen.add(Number(id));
        lastModified = Math.max(lastModified ?? 0, modified);
        rows.push({ id: Number(id), modified, item });
      }
      await opts.onRows(rows);
      if (result.next === null || result.items.length === 0 || pageLast.sec < 0) return { done: true, lastModified };
      const sameSecond = filter['>=DATE_MODIFY'] !== undefined && toUnixSeconds(filter['>=DATE_MODIFY']) === pageLast.sec;
      if (sameSecond) {
        // A whole page within one second (bulk edit): step through it by offset.
        start += result.items.length;
      } else {
        filter = { ...opts.baseFilter, '>=DATE_MODIFY': pageLast.raw };
        start = atLast;
      }
    }
    return { done: false, lastModified };
  }
}

interface KeysetResult {
  /** True when the listing reached its end in this run. */
  done: boolean;
  /** Newest DATE_MODIFY listed (unix seconds), for a continued run. */
  lastModified: number | null;
}
