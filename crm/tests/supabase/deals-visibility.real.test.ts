import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_EMAILS, FIXTURE_USERS, closeRunManifests, openRunManifest } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Branch visibility, true counts and the sync date through the REAL Data API
 * (PostgREST + RLS + aal2 sessions), migrations 20261009000500/0600 (renumbered
 * from 20261008000100/0200) under main's intake guards (20261009001000, PR #13
 * review fix 1). 1 200 synthetic imported deals (more than the 1 000-row Data API
 * cap) enter through an approved run manifest and the intake commands, and are
 * removed again afterwards. Super Admin reads no deal (access matrix), so the
 * Delhi manager (branch grant) is the wide reader.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
const N = 1_200;
const BASE = 990_000;
const PAGE = 50;
/** The run manifest's business day (Asia/Kolkata); every deal of this suite is created on it. */
const DAY = '2026-09-15';

describe.skipIf(!stack || !dbUrl)('deals: branch reader, counts and sync date (real stack)', () => {
  let db: pg.Client;
  let admin: SignedIn;
  let manager: SignedIn;
  let sales: SignedIn;
  let manifestId: string | null = null;
  let original: { cutoff_at: Date; eligible_stage_ids: string[]; eligible_category_ids: string[] | null; category_id: string };

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(dbUrl).hostname)) throw new Error('local database only');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    original = (await db.query('select cutoff_at, eligible_stage_ids, eligible_category_ids, category_id from public.integration_intake_config')).rows[0];
    manifestId = await openRunManifest(dbUrl, {
      object: 'deal',
      ids: Array.from({ length: N }, (_, i) => BASE + 1 + i),
      sourceCode: 'SYNTHETIC_SRC',
      businessDate: DAY,
    });
    // Created through the real commands (record -> claim -> apply): half owned by Sales Delhi A (101),
    // half by Sales Delhi B (102). An unmapped owner would be held for review, so none is used.
    await db.query(
      `do $$
       declare i int; c jsonb;
       begin
         for i in 1..${N} loop
           perform public.integration_record_bitrix_event('SYNTHETIC_MEMBER_0001', 'ONCRMDEALUPDATE', ${BASE} + i, 1797000000 + i);
           for c in select x from public.integration_claim_inbox(100, 60) x loop
             if (c ->> 'sourceDealId')::bigint = ${BASE} + i then
               perform public.integration_apply_bitrix_deal((c ->> 'inboxId')::uuid, (c ->> 'lockToken')::uuid,
                 jsonb_build_object('id', c ->> 'sourceDealId', 'sourceId', 'SYNTHETIC_SRC',
                   'title', 'Synthetic real-stack deal ' || i,
                   'stageId', 'C7:NEW', 'categoryId', '7', 'assignedById', case when i % 2 = 0 then '101' else '102' end,
                   'dateCreate', '${DAY}T10:00:00+05:30',
                   'dateModify', '${DAY}T12:00:00+05:30'));
             else
               perform public.integration_release_inbox((c ->> 'inboxId')::uuid, (c ->> 'lockToken')::uuid);
             end if;
           end loop;
         end loop;
       end $$`,
    );
    admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
    manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, FIXTURE_USERS.managerDelhi);
    sales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  }, 600_000);

  afterAll(async () => {
    // Remove the TOTP factors this file enrolled (other suites enrol their own).
    await stack?.cleanup();
    if (!db) return;
    await db.query(
      `update public.integration_intake_config set cutoff_at = $1, eligible_stage_ids = $2, eligible_category_ids = $3, category_id = $4`,
      [original.cutoff_at, original.eligible_stage_ids, original.eligible_category_ids, original.category_id],
    );
    await db.query(`delete from public.integration_resync_jobs`);
    await db.query(`delete from public.deal_list_changes`);
    // Synthetic rows of this suite only (throwaway test stack).
    await db.query(`delete from public.deal_assignments a using public.deals d
                    where d.id = a.deal_id and d.source_deal_id between ${BASE + 1} and ${BASE + N}`);
    // integration_inbox and deals reference each other: unhook first.
    await db.query(`update public.integration_inbox set processed_deal_id = null
                    where source_deal_id between ${BASE + 1} and ${BASE + N}`);
    // The sync-date test records removal participants (append-only). Local test
    // database only: suspend that guard within this cleanup transaction.
    await db.query('begin');
    await db.query('set local session_replication_role = replica');
    await db.query(`delete from public.deal_removal_participants p using public.deals d
                    where d.id = p.deal_id and d.source_deal_id between ${BASE + 1} and ${BASE + N}`);
    await db.query('commit');
    await db.query(`delete from public.deals where source_deal_id between ${BASE + 1} and ${BASE + N}`);
    await db.query(`delete from public.integration_inbox where source_deal_id between ${BASE + 1} and ${BASE + N}`);
    await db.end();
    if (manifestId) await closeRunManifests(dbUrl, [manifestId]);
  });

  const count = async (s: SignedIn) => {
    const { count: n, error } = await s.client.from('deals').select('id', { count: 'exact', head: true });
    expect(error).toBeNull();
    return n!;
  };

  it('Branch reader: exact count beyond the 1 000-row cap equals the service count for the branch; pages of 50 cover it exactly once', async () => {
    const { branch_id: branch } = (await db.query(`select branch_id from public.deals where source_deal_id = ${BASE + 1}`)).rows[0];
    const service = Number((await db.query('select count(*) from public.deals where branch_id = $1 and removed_at is null', [branch])).rows[0].count);
    const total = await count(manager);
    expect(total).toBe(service);
    expect(total).toBeGreaterThan(1_000);
    const seen = new Set<string>();
    for (let offset = 0; offset < total; offset += PAGE) {
      const { data, error } = await manager.client
        .from('deals')
        .select('id')
        .order('source_deal_id', { ascending: false, nullsFirst: false })
        .order('id')
        .range(offset, offset + PAGE - 1);
      expect(error).toBeNull();
      for (const r of data!) seen.add(r.id as string);
    }
    expect(seen.size).toBe(total);
    // Nothing was stored without an owner.
    const { count: ownerless } = await manager.client.from('deals').select('id', { count: 'exact', head: true }).is('owner_user_id', null);
    expect(ownerless).toBe(0);
  });

  it('Super Admin reads no deal; Salesperson reads only own deals', async () => {
    expect(await count(admin)).toBe(0);
    const own = await count(sales);
    const { count: notMine } = await sales.client
      .from('deals')
      .select('id', { count: 'exact', head: true })
      .or(`owner_user_id.is.null,owner_user_id.neq.${FIXTURE_USERS.salesDelhiA}`);
    expect(own).toBeGreaterThanOrEqual(N / 2);
    // Anything not owned is visible only through an assignment (fixture deals).
    expect(notMine).toBeLessThan(5);
  });

  it('sync date later removes the day’s deals for everyone (counts follow); earlier restores them', async () => {
    const before = await count(manager);
    const salesBefore = await count(sales);
    const old = (await db.query(`select id from public.deals where source_deal_id = ${BASE + 2}`)).rows[0].id as string;
    const salesOld = Number(
      (
        await db.query(
          `select count(*) from public.deals where owner_user_id = $1 and source_system = 'bitrix'
             and removed_at is null and source_created_at < '2026-09-15T18:30:00Z'`,
          [FIXTURE_USERS.salesDelhiA],
        )
      ).rows[0].count,
    );
    expect(salesOld).toBeGreaterThanOrEqual(N / 2);

    // Batch 4: a save is a preview, then an apply with a reason (the old one-step command refuses).
    const saveSyncSettings = async (cutoff: string) => {
      const preview = await admin.client.rpc('integration_preview_sync_settings' as never, {
        p_category_ids: [7],
        p_stage_ids: original.eligible_stage_ids,
        p_cutoff_at: cutoff,
        p_sync_enabled: false,
      } as never);
      expect(preview.error).toBeNull();
      return admin.client.rpc('integration_apply_sync_settings' as never, {
        p_preview_id: (preview.data as unknown as { previewId: string }).previewId,
        p_reason: 'Test: sync settings saved through preview and apply',
      } as never);
    };
    // The sync date is an IST midnight: 2026-09-16 is after the manifest day.
    const later = await saveSyncSettings('2026-09-16T00:00:00+05:30');
    expect(later.error).toBeNull();
    const removed = (later.data as { removed: number }).removed;
    expect(removed).toBeGreaterThanOrEqual(N);
    expect(await count(manager)).toBe(before - removed);
    expect(await count(sales)).toBe(salesBefore - salesOld);
    for (const s of [manager, sales]) {
      const { data } = await s.client.from('deals').select('id').eq('id', old);
      expect(data).toEqual([]);
      const { data: assignments } = await s.client.from('deal_assignments').select('id').eq('deal_id', old);
      expect(assignments).toEqual([]);
    }
    // The admin sees progress of the queued full resync; staff do not.
    expect((await admin.client.from('integration_resync_jobs').select('status')).data).toEqual([{ status: 'queued' }]);
    expect((await sales.client.from('integration_resync_jobs').select('status')).data).toEqual([]);

    const earlier = await saveSyncSettings('2026-09-01T00:00:00+05:30');
    expect(earlier.error).toBeNull();
    expect((earlier.data as { restored: number }).restored).toBe(removed);
    expect(await count(manager)).toBe(before);
    expect(await count(sales)).toBe(salesBefore);
    const { data: back } = await sales.client.from('deals').select('id, owner_user_id').eq('id', old);
    expect(back).toEqual([{ id: old, owner_user_id: FIXTURE_USERS.salesDelhiA }]);
  });
});
