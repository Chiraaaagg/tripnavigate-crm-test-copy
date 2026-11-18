import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_USERS, assertDatabaseUrlNotOperational } from '../helpers/db';
import { resolveRealStackEnv } from '../helpers/real-stack';

/**
 * Actual PostgreSQL transaction races for the Phase 6 scope guards. These use
 * separate service-role connections and pg_blocking_pids as a deterministic
 * barrier: a contender must actually wait on the first transaction, rather
 * than relying on sleeps or Promise.all scheduling.
 *
 * Only the CI/local Supabase stack is permitted. Each test creates its own
 * reserved .test portal, config, manifest, inbox and source record. Cleanup
 * removes only those IDs; append-only audit rows remain. No Auth accounts,
 * stored files, shared portal configuration or deployment settings change.
 * Missing required real-stack configuration fails collection, never skips CI.
 */
const env = resolveRealStackEnv();
const rawDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (isRealStackRequired(process.env) && !rawDatabaseUrl) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
}
if (rawDatabaseUrl && !new Set(['localhost', '127.0.0.1', '[::1]']).has(new URL(rawDatabaseUrl).hostname)) {
  throw new Error('Lead scope races run only against a local database');
}
const dbUrl = env && rawDatabaseUrl ? rawDatabaseUrl : null;
const enabled = dbUrl !== null;
type SourceObject = 'lead' | 'deal';
type ApplyResult = { outcome: string; reasonCode: string | null; leadId?: string | null; dealId?: string | null };
type ReconcileResult = { ignored: boolean; upToDate: boolean; reasonCode?: string };
interface Scenario {
  owner: pg.Client;
  worker: pg.Client;
  contender: pg.Client;
  workerPid: number;
  contenderPid: number;
  configId: string;
  manifestId: string;
  memberId: string;
  sourceId: number;
  recordId: string;
  object: SourceObject;
  title: string;
  apply: (client: pg.Client) => Promise<ApplyResult>;
  reconcile: (client: pg.Client) => Promise<ReconcileResult>;
  close: (client: pg.Client) => Promise<unknown>;
  row: () => Promise<{ title: string; owner_user_id: string; branch_code: string; verified: string }>;
}

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  const client = await connect();
  try {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    if (rows.length !== 1 || rows[0]!.environment !== 'test') {
      throw new Error('Lead scope races require a database explicitly labelled test');
    }
  } finally {
    await client.end();
  }
});

async function connect(service = false): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: dbUrl!, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query("set statement_timeout = '8s'; set lock_timeout = '5s'");
  if (service) await client.query('set role service_role');
  return client;
}
async function result<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  return (await client.query<{ value: T }>(sql, params)).rows[0]!.value;
}

/** Wait for an observed PostgreSQL lock, not an assumed scheduling order. */
async function blockedBy(owner: pg.Client, waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const { rows } = await owner.query<{ blocked: boolean }>(
      'select $2::integer = any(pg_blocking_pids($1::integer)) as blocked', [waiter, blocker],
    );
    if (rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Contender did not block on the expected PostgreSQL transaction');
}

async function scenario(object: SourceObject, run: (s: Scenario) => Promise<void>): Promise<void> {
  const configId = randomUUID();
  const memberId = `SCOPE_${configId.replaceAll('-', '')}`;
  const sourceId = 300_000_000 + Math.floor(Math.random() * 100_000_000);
  const title = `Synthetic scope record ${configId}`;
  const clients: pg.Client[] = [];
  let owner: pg.Client | undefined;
  try {
    owner = await connect(); clients.push(owner);
    const worker = await connect(true); clients.push(worker);
    const contender = await connect(true); clients.push(contender);
    const workerPid = (await worker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    const contenderPid = (await contender.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await owner.query(
      `insert into public.integration_intake_config
       (id, portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at,
        pilot_legal_entity_id, pilot_branch_id, enabled)
       select $1, $2, $3, 7, array['C7:NEW'], timestamptz '2026-09-01', b.legal_entity_id, b.id, true
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where b.code = 'DEL' and e.code = 'HOLIDAY_CHACHA'`,
      [configId, `${configId}.scope.example.test`, memberId],
    );
    await owner.query(
      `insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id)
       values ($1, 101, $2), ($1, 104, $3)`,
      [memberId, FIXTURE_USERS.salesDelhiA, FIXTURE_USERS.salesAhmedabad],
    );
    const manifest = await result<{ manifestId: string }>(worker,
      `select public.integration_manifest_create($1, $2, 'WEBFORM', date '2026-10-04',
         timestamptz '2026-10-04T00:00:00+05:30', timestamptz '2026-10-05T00:00:00+05:30',
         array[$3::bigint], 'scope-race-ci') as value`, [configId, object, sourceId]);
    const snapshot = (changed = false) => ({
      id: String(sourceId), title: changed ? `${title} updated` : title,
      ...(object === 'lead' ? { statusId: 'NEW' } : { stageId: 'C7:NEW', categoryId: '7' }),
      sourceId: 'WEBFORM', assignedById: '101', dateCreate: '2026-10-04T11:00:00+05:30',
      dateModify: changed ? '2026-10-04T12:00:00+05:30' : '2026-10-04T11:00:00+05:30',
    });
    const lease = async (event: string) => {
      const r = await result<{ inboxId: string }>(worker,
        'select public.integration_record_bitrix_event($1, $2, $3, $4) as value',
        [memberId, event, sourceId, Math.floor(Date.now() / 1000)]);
      // Lease only this test's notification. Claim concurrency is covered by
      // intake.real.test.ts; unrelated inbox rows must remain untouched here.
      const { rows } = await owner!.query<{ lock_token: string }>(
        `update public.integration_inbox set status = 'processing', lock_token = gen_random_uuid(),
         locked_until = now() + interval '120 seconds', attempts = attempts + 1
         where id = $1 returning lock_token`, [r.inboxId]);
      return { inboxId: r.inboxId, lockToken: rows[0]!.lock_token };
    };
    const initial = await lease(object === 'lead' ? 'ONCRMLEADADD' : 'ONCRMDEALADD');
    const applySql = `select public.integration_apply_bitrix_${object}($1, $2, $3::jsonb) as value`;
    const created = await result<ApplyResult>(worker, applySql, [initial.inboxId, initial.lockToken, JSON.stringify(snapshot())]);
    expect(created.outcome).toBe('created');
    const recordId = (object === 'lead' ? created.leadId : created.dealId)!;
    const pending = await lease(object === 'lead' ? 'ONCRMLEADUPDATE' : 'ONCRMDEALUPDATE');
    const table = object === 'lead' ? 'crm_leads' : 'deals';
    await owner.query(`update public.${table} set last_verified_at = timestamptz '2026-01-01' where id = $1`, [recordId]);
    await run({
      owner, worker, contender, workerPid, contenderPid, configId, manifestId: manifest.manifestId,
      memberId, sourceId, recordId, object, title,
      apply: (client) => result<ApplyResult>(client, applySql, [pending.inboxId, pending.lockToken, JSON.stringify(snapshot(true))]),
      reconcile: (client) => result<ReconcileResult>(client,
        `select public.integration_enqueue_reconcile${object === 'lead' ? '_lead' : ''}($1, $2, $3) as value`,
        [memberId, sourceId, Date.parse('2026-10-04T05:30:00Z') / 1000]),
      close: (client) => result(client, 'select public.integration_manifest_close($1, $2) as value', [manifest.manifestId, 'scope-race-ci']),
      row: async () => (await owner!.query<{ title: string; owner_user_id: string; branch_code: string; verified: string }>(
        `select r.title, r.owner_user_id, b.code as branch_code, r.last_verified_at::text as verified
         from public.${table} r join public.branches b on b.id = r.branch_id where r.id = $1`, [recordId],
      )).rows[0]!,
    });
  } finally {
    // Release either side first, including an assertion failure while a query
    // waits. The short lock timeout bounds cleanup even if a client has failed.
    await Promise.allSettled(clients.map((client) => client.query('rollback')));
    if (owner) {
      try {
        await owner.query('begin');
        // Local test database only. Suspend immutable/FK guards only within
        // this cleanup transaction, and only remove this run's private IDs.
        await owner.query('set local session_replication_role = replica');
        await owner.query('delete from public.crm_leads where source_portal = $1', [memberId]);
        await owner.query('delete from public.deals where source_portal = $1', [memberId]);
        await owner.query('delete from public.integration_inbox where portal_member_id = $1', [memberId]);
        await owner.query('delete from public.intake_manifest_items where manifest_id in (select id from public.intake_manifests where config_id = $1)', [configId]);
        await owner.query('delete from public.intake_manifests where config_id = $1', [configId]);
        await owner.query('delete from public.bitrix_user_mappings where portal_member_id = $1', [memberId]);
        await owner.query('delete from public.integration_intake_config where id = $1', [configId]);
        await owner.query('commit');
      } catch (error) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await Promise.allSettled(clients.map((client) => client.end()));
      }
    } else {
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  }
}

// A pilot branch move is an operator change: since 20261114000100 service_role
// can no longer write integration_intake_config, so the move runs as the owner
// role for this transaction only (the contender's session stays service_role).
const moveConfig = async (s: Scenario, client: pg.Client) => {
  await client.query('set local role postgres');
  return client.query(
    `update public.integration_intake_config c set pilot_branch_id = b.id
     from public.branches b where c.id = $1 and b.code = 'AMD' and b.legal_entity_id = c.pilot_legal_entity_id`,
    [s.configId],
  );
};
const waiting = <T>(promise: Promise<T>): Promise<T> => {
  // Attach rejection handling immediately while the barrier inspects locks.
  // The caller still awaits and asserts this original promise.
  void promise.catch(() => undefined);
  return promise;
};

describe.skipIf(!enabled)('Phase 6 scope guards under real PostgreSQL races', () => {
  it.each(['lead', 'deal'] as const)('a committed config move wins before %s apply; the old branch record stays unchanged', async (object) => {
    await scenario(object, async (s) => {
      const before = await s.row();
      await s.contender.query('begin');
      await moveConfig(s, s.contender);
      await s.worker.query('begin');
      const apply = waiting(s.apply(s.worker));
      await blockedBy(s.owner, s.workerPid, s.contenderPid);
      await s.contender.query('commit');
      expect(await apply).toMatchObject({ outcome: 'needs_review', reasonCode: 'scope_changed' });
      await s.worker.query('commit');
      expect(await s.row()).toEqual(before);
    });
  });

  it.each(['lead', 'deal'] as const)('%s apply locks config until commit; a concurrent branch move cannot change its decision', async (object) => {
    await scenario(object, async (s) => {
      await s.worker.query('begin');
      expect(await s.apply(s.worker)).toMatchObject({ outcome: 'updated' });
      await s.contender.query('begin');
      const move = waiting(moveConfig(s, s.contender));
      await blockedBy(s.owner, s.contenderPid, s.workerPid);
      await s.worker.query('commit');
      await move;
      await s.contender.query('commit');
      expect(await s.row()).toMatchObject({ title: `${s.title} updated`, owner_user_id: FIXTURE_USERS.salesDelhiA, branch_code: 'DEL' });
    });
  });

  it.each(['lead', 'deal'] as const)('closing the manifest wins before %s apply and prevents any record write', async (object) => {
    await scenario(object, async (s) => {
      const before = await s.row();
      await s.contender.query('begin');
      await s.close(s.contender);
      await s.worker.query('begin');
      const apply = waiting(s.apply(s.worker));
      await blockedBy(s.owner, s.workerPid, s.contenderPid);
      await s.contender.query('commit');
      expect(await apply).toMatchObject({ outcome: 'ignored', reasonCode: 'not_in_manifest' });
      await s.worker.query('commit');
      expect(await s.row()).toEqual(before);
    });
  });

  it.each(['lead', 'deal'] as const)('%s apply commits before manifest closure; subsequent reconciliation stops', async (object) => {
    await scenario(object, async (s) => {
      await s.worker.query('begin');
      expect(await s.apply(s.worker)).toMatchObject({ outcome: 'updated' });
      await s.contender.query('begin');
      const close = waiting(s.close(s.contender));
      await blockedBy(s.owner, s.contenderPid, s.workerPid);
      await s.worker.query('commit');
      await close;
      await s.contender.query('commit');
      const before = await s.row();
      expect(await s.reconcile(s.worker)).toMatchObject({ ignored: true, upToDate: false, reasonCode: 'not_in_manifest' });
      expect(await s.row()).toEqual(before);
    });
  });

  it.each(['lead', 'deal'] as const)('closing the manifest wins before %s reconciliation and prevents freshness writes', async (object) => {
    await scenario(object, async (s) => {
      const before = await s.row();
      await s.contender.query('begin');
      await s.close(s.contender);
      await s.worker.query('begin');
      const reconcile = waiting(s.reconcile(s.worker));
      await blockedBy(s.owner, s.workerPid, s.contenderPid);
      await s.contender.query('commit');
      expect(await reconcile).toMatchObject({ ignored: true, upToDate: false, reasonCode: 'not_in_manifest' });
      await s.worker.query('commit');
      expect(await s.row()).toEqual(before);
    });
  });

  it.each(['lead', 'deal'] as const)('%s reconciliation holds its manifest lock until its freshness write commits', async (object) => {
    await scenario(object, async (s) => {
      const before = await s.row();
      await s.worker.query('begin');
      expect(await s.reconcile(s.worker)).toMatchObject({ ignored: false, upToDate: true });
      await s.contender.query('begin');
      const close = waiting(s.close(s.contender));
      await blockedBy(s.owner, s.contenderPid, s.workerPid);
      await s.worker.query('commit');
      await close;
      await s.contender.query('commit');
      const after = await s.row();
      expect(after.verified).not.toBe(before.verified);
      expect(await s.reconcile(s.worker)).toMatchObject({ ignored: true, upToDate: false });
      expect(await s.row()).toEqual(after);
    });
  });
});
