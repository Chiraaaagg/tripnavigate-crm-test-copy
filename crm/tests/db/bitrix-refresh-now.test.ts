import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG as CONFIG,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Book now v2, migration 20261129000200_bf2_bitrix_refresh: "Refresh from
 * Bitrix now". booking_bitrix_refresh_begin authorizes a booking editor,
 * checks the Deal came from Bitrix, the read switches and the 20-second
 * cooldown per Deal, then leases one inbox row (taken over or new, origin
 * 'staff_refresh') and audits ids only. The leased row is applied by the
 * normal intake commands (service role), so an unchanged Deal still stores
 * its trip facts.
 *
 * Synthetic values only. Every case runs in a rolled-back transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const OWNER: Actor = { userId: U.salesDelhiA };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const BEGIN_SQL = 'select public.booking_bitrix_refresh_begin($1, $2) as r';
const MODIFIED = '2026-10-03T10:00:00+05:30';

interface Begin {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  inboxId?: string;
  lockToken?: string;
  portalMemberId?: string;
  sourceDealId?: string;
  sourceObject?: string;
  eventType?: string;
  origin?: string;
  attempts?: number;
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
async function refused(actor: Actor, sql: string, params: unknown[], code: string, message?: RegExp): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), { code, message });
  await resetActor(db);
}
const begin = (actor: Actor, dealId: string, requestId: string = crypto.randomUUID()) => one<Begin>(actor, BEGIN_SQL, [dealId, requestId]);

let ts = 1_832_000_000;
const deal = (id: number, o: Record<string, unknown> = {}) => ({
  id: String(id),
  title: `Synthetic refresh deal ${id}`,
  stageId: 'C7:NEW',
  categoryId: '7',
  assignedById: '101', // Delhi Sales A
  dateCreate: '2026-10-02T09:00:00+05:30',
  dateModify: MODIFIED,
  leadId: '',
  ...o,
});

async function recordEvent(sourceId: number): Promise<string> {
  const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, 'ONCRMDEALUPDATE', sourceId, (ts += 1),
  ]);
  return rec.inboxId;
}
async function importDeal(d: Record<string, unknown>): Promise<string> {
  const inboxId = await recordEvent(Number(d.id));
  const rows = await run<{ r: { inboxId: string; lockToken: string } }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === inboxId)!;
  const r = await one<{ outcome: string; dealId: string }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(d),
  ]);
  expect(r.outcome).toBe('created');
  return r.dealId;
}

async function setup(switches: { facts?: boolean; details?: boolean } = { facts: true }): Promise<void> {
  await db.query(
    `update public.integration_intake_config
     set deal_intake_mode = 'scope', cutoff_at = '2026-10-01T00:00:00+05:30',
         bitrix_trip_facts_read = $2, bitrix_trip_details_read = $3
     where id = $1`,
    [CONFIG, switches.facts ?? false, switches.details ?? false],
  );
  // The scheduled sync runs (the fixture default is paused).
  await db.query('update public.integration_sync_schedule set enabled = true where id');
}
const inboxRows = (sourceId: number) =>
  db.query<{ id: string; status: string; origin: string; attempts: number; lock_token: string | null; event_type: string; source_object: string }>(
    `select id, status, origin, attempts, lock_token, event_type, source_object from public.integration_inbox
     where portal_member_id = $1 and source_deal_id = $2 order by received_at, id`,
    [MEMBER, sourceId],
  );
const audits = () =>
  db.query<{ actor_user_id: string; target_type: string; target_id: string; details: Record<string, unknown> }>(
    `select actor_user_id, target_type, target_id, details from public.audit_events
     where action = 'booking.bitrix_refresh_requested' order by occurred_at, id`,
  );

describe('authorization', () => {
  it('only a booking editor of the Deal may refresh it (owner and branch Sales Manager)', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91001));
      for (const user of [U.salesDelhiB, U.purchaseJodhpur, U.accountsJodhpur, U.salesAhmedabad, U.adminJodhpur]) {
        await refused({ userId: user }, BEGIN_SQL, [dealId, crypto.randomUUID()], '42501');
      }
      // Password-only session.
      await refused({ userId: U.salesDelhiA, aal: 'aal1' }, BEGIN_SQL, [dealId, crypto.randomUUID()], '42501');
      // Not granted to anon or the service role.
      await refused({ userId: null }, BEGIN_SQL, [dealId, crypto.randomUUID()], '42501');
      await refused(SVC, BEGIN_SQL, [dealId, crypto.randomUUID()], '42501');
      expect(await audits()).toEqual([]);
      expect(await db.query('select * from public.deal_bitrix_refresh_state')).toEqual([]);
      expect(await db.query('select * from public.staff_bitrix_refresh_rate')).toEqual([]);

      expect((await begin(OWNER, dealId)).allowed).toBe(true);
      await db.query('delete from public.deal_bitrix_refresh_state');
      expect((await begin({ userId: U.managerDelhi }, dealId)).allowed).toBe(true);
    });
  });

  it('refuses missing arguments', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91002));
      await refused(OWNER, BEGIN_SQL, [dealId, null], '22023');
      await refused(OWNER, BEGIN_SQL, [null, crypto.randomUUID()], '22023');
    });
  });
});

describe('switches and Deal checks', () => {
  it('both read switches off: switched_off, nothing leased, no cooldown used', async () => {
    await asOwner(db, async () => {
      await setup({});
      const dealId = await importDeal(deal(91101));
      const before = await inboxRows(91101);
      expect(await begin(OWNER, dealId)).toEqual({ allowed: false, reason: 'switched_off' });
      expect(await inboxRows(91101)).toEqual(before);
      expect(await db.query('select * from public.deal_bitrix_refresh_state')).toEqual([]);
      expect(await audits()).toEqual([]);
    });
  });

  it('either switch alone is enough', async () => {
    await asOwner(db, async () => {
      await setup({ details: true });
      const a = await importDeal(deal(91102));
      expect((await begin(OWNER, a)).allowed).toBe(true);
      await setup({ facts: true });
      const b = await importDeal(deal(91103));
      expect((await begin(OWNER, b)).allowed).toBe(true);
    });
  });

  it('intake disabled for the portal reads as switched_off', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91104));
      await db.query('update public.integration_intake_config set enabled = false where id = $1', [CONFIG]);
      expect(await begin(OWNER, dealId)).toEqual({ allowed: false, reason: 'switched_off' });
    });
  });

  it('scheduled sync paused: sync_paused, nothing leased, no limit used', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91106));
      const before = await inboxRows(91106);
      await db.query('update public.integration_sync_schedule set enabled = false where id');
      expect(await begin(OWNER, dealId)).toEqual({ allowed: false, reason: 'sync_paused' });
      expect(await inboxRows(91106)).toEqual(before);
      expect(await db.query('select * from public.deal_bitrix_refresh_state')).toEqual([]);
      expect(await db.query('select * from public.staff_bitrix_refresh_rate')).toEqual([]);
      expect(await audits()).toEqual([]);
      await db.query('update public.integration_sync_schedule set enabled = true where id');
      expect((await begin(OWNER, dealId)).allowed).toBe(true);
    });
  });

  it('a Deal not from Bitrix, or removed by the sync, is refused', async () => {
    await asOwner(db, async () => {
      await setup();
      expect(await begin(OWNER, D.del001)).toEqual({ allowed: false, reason: 'not_bitrix_deal' });
      const dealId = await importDeal(deal(91105));
      await db.query(`update public.deals set removed_at = now(), removed_reason = 'pipeline_not_eligible' where id = $1`, [dealId]);
      // The sync removed it: a removed Deal is not readable, so nothing is leased.
      await refused(OWNER, BEGIN_SQL, [dealId, crypto.randomUUID()], '42501');
      expect((await inboxRows(91105)).every((r) => r.status !== 'processing')).toBe(true);
    });
  });
});

describe('lease, origin and audit', () => {
  it('inserts a staff_refresh row leased to the caller and audits ids only', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91201));
      const requestId = crypto.randomUUID();
      const r = await begin(OWNER, dealId, requestId);
      expect(r).toMatchObject({
        allowed: true, portalMemberId: MEMBER, sourceDealId: '91201', sourceObject: 'deal',
        eventType: 'RECONCILE', origin: 'staff_refresh', attempts: 1,
      });
      const row = (await inboxRows(91201)).find((x) => x.id === r.inboxId)!;
      expect(row).toMatchObject({ status: 'processing', origin: 'staff_refresh', lock_token: r.lockToken, event_type: 'RECONCILE' });
      const [lease] = await db.query<{ secs: number }>(
        'select extract(epoch from locked_until - now())::int as secs from public.integration_inbox where id = $1', [r.inboxId],
      );
      expect(lease!.secs).toBe(90);

      const [a] = await audits();
      expect(a).toMatchObject({ actor_user_id: U.salesDelhiA, target_type: 'deal', target_id: dealId });
      expect(a!.details).toEqual({ inboxId: r.inboxId, requestId, takenOver: false });
    });
  });

  it('takes over a waiting row of the Deal instead of adding one; its origin is kept', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91202));
      const waiting = await recordEvent(91202);
      const r = await begin(OWNER, dealId);
      expect(r).toMatchObject({ allowed: true, inboxId: waiting, origin: 'event', eventType: 'ONCRMDEALUPDATE', attempts: 1 });
      expect((await inboxRows(91202)).filter((x) => x.status === 'processing').map((x) => x.id)).toEqual([waiting]);
      expect((await audits())[0]!.details).toMatchObject({ inboxId: waiting, takenOver: true });
    });
  });

  it('the origin check accepts staff_refresh and nothing new beyond it', async () => {
    await asOwner(db, async () => {
      const [c] = await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'integration_inbox_origin_check'`,
      );
      for (const o of ['event', 'reconcile', 'manual_retry', 'staff_refresh']) expect(c!.def).toContain(`'${o}'`);
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.integration_inbox (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin)
             values ($1, 'deal', 'RECONCILE', 1, 1, repeat('a', 64), 'staff')`,
            [MEMBER],
          ),
        { code: '23514' },
      );
    });
  });

  it('an unfinished lease expires and the scheduled sync claims the row with origin staff_refresh', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91203));
      const r = await begin(OWNER, dealId);
      await db.query(`update public.integration_inbox set locked_until = now() - interval '1 second' where id = $1`, [r.inboxId]);
      const claimed = (await run<{ r: { inboxId: string; origin: string } }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r'))
        .map((x) => x.r)
        .find((x) => x.inboxId === r.inboxId);
      expect(claimed).toMatchObject({ origin: 'staff_refresh' });
    });
  });

  it('a replayed request id leases nothing', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91204));
      const requestId = crypto.randomUUID();
      expect((await begin(OWNER, dealId, requestId)).allowed).toBe(true);
      // Finish the first lease so no waiting row can be taken over, then let the cooldown pass.
      await db.query(`update public.integration_inbox set status = 'processed', lock_token = null, locked_until = null, next_attempt_at = null
                      where origin = 'staff_refresh'`);
      await db.query(`update public.deal_bitrix_refresh_state set last_requested_at = now() - interval '21 seconds'`);
      await refused(OWNER, BEGIN_SQL, [dealId, requestId], '23505', /request_conflict/);
    });
  });
});

describe('cooldown (20 seconds per Deal)', () => {
  it('a second refresh within 20 seconds is too_soon for anyone; after it, allowed again', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91301));
      expect((await begin(OWNER, dealId)).allowed).toBe(true);
      const again = await begin(OWNER, dealId);
      expect(again).toMatchObject({ allowed: false, reason: 'too_soon' });
      expect(again.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(again.retryAfterSeconds).toBeLessThanOrEqual(20);
      expect(await begin({ userId: U.managerDelhi }, dealId)).toMatchObject({ allowed: false, reason: 'too_soon' });
      expect(await audits()).toHaveLength(1);

      // Another Deal is not affected.
      const other = await importDeal(deal(91302));
      expect((await begin(OWNER, other)).allowed).toBe(true);

      await db.query(`update public.deal_bitrix_refresh_state set last_requested_at = now() - interval '21 seconds' where deal_id = $1`, [dealId]);
      expect((await begin(OWNER, dealId)).allowed).toBe(true);
    });
  });
});

describe('per staff member: 10 refreshes per rolling minute', () => {
  it('the 11th refresh within a minute is refused for that person only, across Deals', async () => {
    await asOwner(db, async () => {
      await setup();
      const ids: string[] = [];
      for (let i = 0; i < 11; i += 1) ids.push(await importDeal(deal(91501 + i)));
      for (let i = 0; i < 10; i += 1) expect((await begin(OWNER, ids[i]!)).allowed).toBe(true);
      const eleventh = await begin(OWNER, ids[10]!);
      expect(eleventh).toMatchObject({ allowed: false, reason: 'staff_limit' });
      expect(eleventh.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(eleventh.retryAfterSeconds).toBeLessThanOrEqual(60);
      // The refused request leased nothing and used no Deal cooldown.
      expect((await inboxRows(91511)).some((r) => r.status === 'processing')).toBe(false);
      expect(await db.query('select 1 from public.deal_bitrix_refresh_state where deal_id = $1', [ids[10]])).toEqual([]);
      expect(await audits()).toHaveLength(10);
      // Another editor of the same branch is not limited by it.
      expect((await begin({ userId: U.managerDelhi }, ids[10]!)).allowed).toBe(true);
      // Refusals by the Deal cooldown do not count.
      expect(await db.query<{ n: number }>('select cardinality(recent_at) as n from public.staff_bitrix_refresh_rate where user_id = $1', [U.managerDelhi]))
        .toEqual([{ n: 1 }]);
      // A minute later the person may refresh again.
      await db.query(
        `update public.staff_bitrix_refresh_rate
         set recent_at = array(select t - interval '61 seconds' from unnest(recent_at) t) where user_id = $1`,
        [U.salesDelhiA],
      );
      await db.query(`update public.deal_bitrix_refresh_state set last_requested_at = now() - interval '21 seconds'`);
      expect((await begin(OWNER, ids[0]!)).allowed).toBe(true);
    });
  });

  it('a refusal by the Deal cooldown is not counted', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91601));
      expect((await begin(OWNER, dealId)).allowed).toBe(true);
      for (let i = 0; i < 12; i += 1) expect((await begin(OWNER, dealId)).reason).toBe('too_soon');
      expect(await db.query<{ n: number }>('select cardinality(recent_at) as n from public.staff_bitrix_refresh_rate where user_id = $1', [U.salesDelhiA]))
        .toEqual([{ n: 1 }]);
    });
  });
});

describe('the leased row is applied by the normal intake commands', () => {
  it('an unchanged Deal still stores its trip facts', async () => {
    await asOwner(db, async () => {
      await setup();
      const dealId = await importDeal(deal(91401));
      expect(await db.query('select deal_id from public.deal_source_trip_facts where deal_id = $1', [dealId])).toEqual([]);
      const r = await begin(OWNER, dealId);
      const applied = await one<{ outcome: string }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
        r.inboxId, r.lockToken, JSON.stringify(deal(91401)),
      ]);
      expect(applied.outcome).toBe('stale_ignored');
      const facts = await one<{ outcome: string }>(SVC, 'select public.integration_apply_bitrix_trip_facts($1, $2::jsonb) as r', [
        r.inboxId,
        JSON.stringify({
          dateModify: MODIFIED, bookingNotes: 'Synthetic note', travellerTotal: 2, tourStart: null, tourEnd: null,
          customerTypeId: null, contactId: null, contactIds: [], companyId: null, issues: [],
        }),
      ]);
      expect(facts.outcome).toBe('stored');
      expect(await db.query('select traveller_total from public.deal_source_trip_facts where deal_id = $1', [dealId])).toEqual([
        { traveller_total: 2 },
      ]);
    });
  });
});
