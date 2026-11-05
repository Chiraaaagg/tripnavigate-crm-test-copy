import type { RpcClient } from '../commands';
import type { IntakeConfig } from '../intake-config';
import {
  NAME_LIST_MAX_ITEMS,
  NamesApplySchema,
  NamesDueSchema,
  parseStatusList,
  stageEntityForPipeline,
  type NameList,
  type NameListItem,
} from '../name-map';
import type { BitrixClient } from './client';
import { DESTINATION_LISTS, parseDestinationOptions } from './trip-details';

/**
 * Direction A Batch 1 B1-1: the daily read of Bitrix stage, status and source
 * NAMES (owner answer, 15 October round 2: read-only list calls, names only,
 * no writes; live use needs the owner's APPROVE through the switch
 * bitrix_name_read).
 *
 * Runs inside the Bitrix worker after the sync (worker-endpoint.ts), only
 * while the config's switch is on:
 *   1. integration_bitrix_names_due (service role) says whether today's read is
 *      due (at most once a day; a failed day is retried at most hourly) and
 *      which pipelines to read. Not due: no Bitrix call.
 *   2. crm.status.list (an already allowed READ method) for DEAL_STAGE /
 *      DEAL_STAGE_<n> of each pipeline, STATUS and SOURCE. Only STATUS_ID,
 *      NAME, SORT and SEMANTICS are kept (parseStatusList); everything else is
 *      dropped before it reaches the database.
 *   3. integration_apply_bitrix_names (service role) with the lists read in
 *      full. A list that failed, answered no list or an empty list, or ran
 *      out of time is not sent, so its stored names stay as they were; the
 *      day's success is recorded only when every list was read
 *      (p_complete), so a partial day is retried within the hour.
 * No Bitrix write, no new Bitrix method, no sync-scope change, and nothing
 * here decides a gate. Never throws: the answer is codes and counts only.
 *
 * Voice-note batch (20261128000100): while bitrix_trip_details_read is on the
 * due answer also says destinations: true, and one crm.deal.fields call (an
 * already allowed READ method) gives the two destination option lists
 * (DEAL_DESTINATION, DEAL_DESTINATION_MULTI; option id and label only). With
 * statusLists: false (name switch off) no stage, status or source list is read.
 */

export type NameRefreshResult =
  | { status: 'not_due'; reason: 'switched_off' | 'fresh' | 'recently_attempted' }
  | { status: 'ran'; listsRead: number; listsFailed: number; added: number; renamed: number; missing: number; restored: number }
  | { status: 'switched_off' }
  | { status: 'error'; code: 'due_failed' | 'apply_failed' | 'nothing_read' };

export interface NameRefreshDeps {
  rpc: RpcClient;
  bitrix: Pick<BitrixClient, 'call'>;
  config: Pick<IntakeConfig, 'portalMemberId'>;
  now?: () => number;
  /** Epoch ms after which no further Bitrix read is started. */
  deadline?: number;
}

/** Pages read per list at most (Bitrix answers 50 per page). */
export const NAME_LIST_MAX_PAGES = 10;
/** Pipelines read at most per run (the database answers at most 50). */
export const NAME_REFRESH_MAX_PIPELINES = 50;

async function readList(deps: NameRefreshDeps, entityId: string, now: () => number): Promise<NameList | null> {
  const items: NameListItem[] = [];
  let start = 0;
  for (let page = 0; page < NAME_LIST_MAX_PAGES; page += 1) {
    if (deps.deadline !== undefined && now() >= deps.deadline) return null;
    const res = await deps.bitrix.call<unknown>('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' }, start });
    // Echo L2: an answer that is not a list, or an empty first page, is a failed
    // read for this list (never "every code is gone").
    if (!Array.isArray(res.result) || (page === 0 && res.result.length === 0)) return null;
    for (const item of parseStatusList(entityId, res.result)) {
      if (!items.some((i) => i.code === item.code)) items.push(item);
    }
    if (res.next === null || res.next <= start) {
      return items.length > 0 ? { entityId, items: items.slice(0, NAME_LIST_MAX_ITEMS) } : null;
    }
    start = res.next;
  }
  // More pages than allowed: an incomplete list is never sent (it would mark real codes missing).
  return null;
}

export async function runBitrixNameRefresh(deps: NameRefreshDeps): Promise<NameRefreshResult> {
  const now = deps.now ?? Date.now;
  let pipelines: number[];
  let statusLists = true;
  let destinations = false;
  try {
    const { data, error } = await deps.rpc.rpc('integration_bitrix_names_due', { p_portal: deps.config.portalMemberId });
    if (error) return { status: 'error', code: 'due_failed' };
    const due = NamesDueSchema.safeParse(data);
    if (!due.success) return { status: 'error', code: 'due_failed' };
    if (!due.data.due) return { status: 'not_due', reason: due.data.reason };
    pipelines = [...new Set(due.data.pipelineIds)].sort((a, b) => a - b).slice(0, NAME_REFRESH_MAX_PIPELINES);
    statusLists = due.data.statusLists !== false;
    destinations = due.data.destinations === true;
  } catch {
    return { status: 'error', code: 'due_failed' };
  }

  const entityIds = statusLists ? [...pipelines.map(stageEntityForPipeline), 'STATUS', 'SOURCE'] : [];
  const lists: NameList[] = [];
  let failed = 0;
  for (const entityId of entityIds) {
    try {
      const list = await readList(deps, entityId, now);
      if (list) lists.push(list);
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  if (destinations) {
    // Each destination list missing from the answer counts as failed (its stored names stay).
    const expected = Object.values(DESTINATION_LISTS).length;
    try {
      if (deps.deadline !== undefined && now() >= deps.deadline) {
        failed += expected;
      } else {
        const res = await deps.bitrix.call<unknown>('crm.deal.fields', {});
        const read = parseDestinationOptions(res.result);
        for (const list of read) lists.push({ entityId: list.entityId, items: list.items.map((i) => ({ ...i, kind: null })) });
        failed += expected - read.length;
      }
    } catch {
      failed += expected;
    }
  }
  if (lists.length === 0) return { status: 'error', code: 'nothing_read' };

  try {
    // The day's success is recorded only when every list was read (Echo L2).
    const { data, error } = await deps.rpc.rpc('integration_apply_bitrix_names', {
      p_portal: deps.config.portalMemberId,
      p_lists: lists,
      p_complete: failed === 0,
    });
    if (error) return { status: 'error', code: 'apply_failed' };
    const applied = NamesApplySchema.safeParse(data);
    if (!applied.success) return { status: 'error', code: 'apply_failed' };
    if (!applied.data.applied) return { status: 'switched_off' };
    const { added, renamed, missing, restored } = applied.data;
    return { status: 'ran', listsRead: lists.length, listsFailed: failed, added, renamed, missing, restored };
  } catch {
    return { status: 'error', code: 'apply_failed' };
  }
}
