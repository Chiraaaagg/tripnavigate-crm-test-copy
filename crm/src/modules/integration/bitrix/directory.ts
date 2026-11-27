import type { BitrixClient } from './client';

/**
 * Read-only Bitrix directory data for the admin pages: deal pipelines with
 * their stages (sync settings) and portal users (Add staff from Bitrix / Link
 * Bitrix user). Allow-listed read methods only (crm.category.list,
 * crm.status.list, user.get). Values are bounded and validated; nothing is
 * stored.
 */

export interface BitrixStage {
  id: string;
  name: string;
  /** 'won' / 'lost' close a deal; 'open' otherwise (Bitrix SEMANTICS S / F / null). */
  kind: 'open' | 'won' | 'lost';
}

export interface BitrixPipeline {
  id: string;
  name: string;
  stages: BitrixStage[];
}

export interface BitrixUser {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
}

const MAX_PAGES = 40;
const text = (v: unknown, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const ID = /^[0-9]{1,18}$/;

type Caller = Pick<BitrixClient, 'call'>;

export async function listPipelines(bitrix: Caller): Promise<BitrixPipeline[]> {
  const { result } = await bitrix.call<{ categories?: unknown[] }>('crm.category.list', { entityTypeId: 2 });
  const categories = (Array.isArray(result?.categories) ? result.categories : [])
    .map((c) => c as Record<string, unknown>)
    .map((c) => ({ id: text(c.id, 18), name: text(c.name) || `Pipeline ${text(c.id, 18)}` }))
    .filter((c) => ID.test(c.id));
  // The default pipeline (0) is always present in Bitrix even if not listed.
  if (!categories.some((c) => c.id === '0')) categories.unshift({ id: '0', name: 'General' });

  // Each pipeline's stages are read at the same time (speed plan F1), at most
  // DIRECTORY_CONCURRENCY stage reads in flight; a rate-limit answer is retried
  // by the client with back-off. Pages within one pipeline stay sequential, the
  // result order is unchanged, and no new pipeline is started after a failure.
  // On the Bitrix sync page the users listing (two states) and the eligible-deal
  // count run beside it: at most 4 + 2 + 1 = 7 Bitrix reads in flight, well
  // inside Bitrix's burst allowance.
  return mapLimit(categories, DIRECTORY_CONCURRENCY, async (c) => {
    const entityId = c.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${c.id}`;
    const stages: BitrixStage[] = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await bitrix.call<unknown[]>('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' }, start });
      for (const raw of Array.isArray(res.result) ? res.result : []) {
        const s = raw as Record<string, unknown>;
        const id = text(s.STATUS_ID, 50);
        if (!/^[A-Za-z0-9_:.-]{1,50}$/.test(id)) continue;
        stages.push({ id, name: text(s.NAME) || id, kind: s.SEMANTICS === 'S' ? 'won' : s.SEMANTICS === 'F' ? 'lost' : 'open' });
      }
      if (res.next === null || res.next <= start) break;
      start = res.next;
    }
    return { ...c, stages };
  });
}

/** Bitrix read requests one directory listing may have in flight at once. */
export const DIRECTORY_CONCURRENCY = 4;

/**
 * Maps with at most `limit` calls in flight; results keep the input order.
 * After the first rejection no further item is started (calls already in
 * flight finish), and the whole map rejects with that first error.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** Every portal user (active and inactive), sorted by name. Needs the webhook "Users (read)" scope. */
export async function listBitrixUsers(bitrix: Caller, options: { stopped?: () => boolean } = {}): Promise<BitrixUser[]> {
  // user.get returns active users by default; ask for both states explicitly.
  // The two states are read at the same time (speed plan F1); pages within one
  // state stay sequential. Merged in the same order as before (active first).
  // `stopped` (checked before every page) lets a caller whose result can no
  // longer be shown stop starting new reads; the listing then rejects.
  let failed = false;
  const stopped = () => failed || (options.stopped?.() ?? false);
  const byState = await Promise.all(
    [true, false].map((active) =>
      listUsersByState(bitrix, active, stopped).catch((error: unknown) => {
        failed = true;
        throw error;
      }),
    ),
  );
  const users = new Map<string, BitrixUser>();
  for (const list of byState) for (const user of list) users.set(user.id, user);
  return [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Thrown when a users listing stops early because its result can no longer be shown. */
export class DirectoryStoppedError extends Error {
  override name = 'DirectoryStoppedError';
}

async function listUsersByState(bitrix: Caller, active: boolean, stopped: () => boolean): Promise<BitrixUser[]> {
  const users: BitrixUser[] = [];
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (stopped()) throw new DirectoryStoppedError('stopped');
    const res = await bitrix.call<unknown[]>('user.get', { FILTER: { ACTIVE: active }, start });
    for (const raw of Array.isArray(res.result) ? res.result : []) {
      const u = raw as Record<string, unknown>;
      const id = text(u.ID, 18);
      if (!ID.test(id) || id === '0') continue;
      const name = [text(u.NAME, 100), text(u.LAST_NAME, 100)].filter(Boolean).join(' ') || text(u.EMAIL) || `Bitrix user ${id}`;
      const email = text(u.EMAIL, 254).toLowerCase();
      users.push({
        id,
        name,
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
        active: u.ACTIVE === true || u.ACTIVE === 'Y' || u.ACTIVE === '1',
      });
    }
    if (res.next === null || res.next <= start) break;
    start = res.next;
  }
  return users;
}

/** Open stages only (not won / lost), across the given pipelines: the default eligible set. */
export function openStageIds(pipelines: BitrixPipeline[]): string[] {
  return pipelines.flatMap((p) => p.stages.filter((s) => s.kind === 'open').map((s) => s.id));
}
