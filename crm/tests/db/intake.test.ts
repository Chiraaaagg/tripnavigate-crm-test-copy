import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApplyResult,
  BitrixDealSnapshot,
  ClaimedInboxItem,
  RecordEventResult,
} from '@/modules/integration/contracts';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  amrAt,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 2 Bitrix intake: database contract (docs/implementation/history/phase-2/contract.md
 * sections 2-5, acceptance P2-03..P2-10, P2-14, P2-16).
 *
 * Every scenario runs inside one rolled-back transaction as the database owner
 * and switches to the impersonated role (service_role, a staff JWT, or anon)
 * only for the call under test, exactly as PostgREST would.
 *
 * Concurrency note (P2-05): PGlite is a single in-process connection, so two
 * workers cannot run at the same time here. These tests prove the SEQUENTIAL
 * properties (a leased row is not claimable again, a stale lock token is
 * refused, the unique source identity rejects a second deal row). True parallel
 * claims are exercised against real Postgres in tests/supabase/intake.real.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';

/** Runs one statement as `actor`, then returns to the owner. On error the caller's savepoint restores the role. */
async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => run<T>(SVC, sql, params);

async function record(dealId: number, ts: number, event = 'ONCRMDEALUPDATE', member = MEMBER): Promise<RecordEventResult> {
  const rows = await svc<{ r: RecordEventResult }>(
    'select public.integration_record_bitrix_event($1, $2, $3, $4) as r',
    [member, event, dealId, ts],
  );
  return rows[0]!.r;
}

async function claim(limit = 10, lease = 60): Promise<ClaimedInboxItem[]> {
  const rows = await svc<{ r: ClaimedInboxItem }>('select r from public.integration_claim_inbox($1, $2) as r', [
    limit,
    lease,
  ]);
  return rows.map((x) => x.r);
}

async function apply(item: { inboxId: string; lockToken: string }, deal: DealSnapshot | null): Promise<ApplyResult> {
  const rows = await svc<{ r: ApplyResult }>('select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    item.inboxId,
    item.lockToken,
    deal === null ? null : JSON.stringify(deal),
  ]);
  return rows[0]!.r;
}

async function fail(item: { inboxId: string; lockToken: string }, code: string, retryable: boolean) {
  const rows = await svc<{ r: { status: string; attempts: number; nextAttemptAt: string | null } }>(
    'select public.integration_fail_inbox($1, $2, $3, $4) as r',
    [item.inboxId, item.lockToken, code, retryable],
  );
  return rows[0]!.r;
}

/** Phase 6: deal snapshots carry Bitrix SOURCE_ID; the fixture manifest's code is SYNTHETIC_SRC. */
type DealSnapshot = BitrixDealSnapshot & { sourceId?: string | null };

function snapshot(overrides: Partial<DealSnapshot> = {}): DealSnapshot {
  return {
    id: '5001',
    sourceId: 'SYNTHETIC_SRC',
    title: 'Synthetic Bitrix deal (fixture)',
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
    ...overrides,
  };
}

let tsCounter = 1_790_000_000;
/** record -> claim -> pick the claimed row for this event. */
async function recordAndClaim(dealId: number, event = 'ONCRMDEALUPDATE'): Promise<ClaimedInboxItem> {
  const { inboxId } = await record(dealId, (tsCounter += 1), event);
  const item = (await claim(100)).find((c) => c.inboxId === inboxId);
  if (!item) throw new Error('recorded event was not claimed');
  return item;
}

async function processDeal(deal: DealSnapshot): Promise<ApplyResult & { inboxId: string }> {
  const item = await recordAndClaim(Number(deal.id));
  return { ...(await apply(item, deal)), inboxId: item.inboxId };
}

async function inboxRow(id: string) {
  const rows = await db.query<{
    status: string;
    reason_code: string | null;
    attempts: number;
    lock_token: string | null;
    next_attempt_at: string | null;
    last_error_code: string | null;
    origin: string;
    processed_deal_id: string | null;
  }>(
    `select status, reason_code, attempts, lock_token, next_attempt_at::text, last_error_code, origin, processed_deal_id
     from public.integration_inbox where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function sourcedDeals(sourceDealId: number) {
  return db.query<{
    id: string;
    title: string;
    owner_user_id: string;
    branch_code: string;
    reference: string;
    source_stage_id: string;
    source_modified_at: string;
    is_synthetic: boolean;
  }>(
    `select d.id, d.title, d.owner_user_id, b.code as branch_code, d.reference, d.source_stage_id,
            d.source_modified_at::text, d.is_synthetic
     from public.deals d join public.branches b on b.id = d.branch_id
     where d.source_system = 'bitrix' and d.source_portal = $1 and d.source_deal_id = $2`,
    [MEMBER, sourceDealId],
  );
}

const countDeals = async () =>
  Number((await db.query<{ n: string }>('select count(*)::text as n from public.deals'))[0]!.n);

describe('P2-03 duplicate delivery', () => {
  it('the same event twice yields one inbox row and one deal', async () => {
    await asOwner(db, async () => {
      const first = await record(6001, 1_790_100_000, 'ONCRMDEALADD');
      const second = await record(6001, 1_790_100_000, 'ONCRMDEALADD');
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ inboxId: first.inboxId, duplicate: true });
      expect(
        await db.query(`select id from public.integration_inbox where source_deal_id = 6001`),
      ).toHaveLength(1);

      const [item] = await claim();
      expect(item).toMatchObject({
        inboxId: first.inboxId,
        portalMemberId: MEMBER,
        sourceDealId: '6001',
        eventType: 'ONCRMDEALADD',
        origin: 'event',
        attempts: 1,
      });
      const result = await apply(item!, snapshot({ id: '6001' }));
      expect(result.outcome).toBe('created');
      expect(result.reasonCode).toBeNull();

      // Redelivery after processing: acknowledged, no new work.
      expect(await record(6001, 1_790_100_000, 'ONCRMDEALADD')).toEqual({ inboxId: first.inboxId, duplicate: true });
      expect(await claim()).toEqual([]);

      // A different notification for the same version is processed but changes nothing.
      const again = await processDeal(snapshot({ id: '6001' }));
      expect(again.outcome).toBe('stale_ignored');
      expect(again.dealId).toBe(result.dealId);
      const deals = await sourcedDeals(6001);
      expect(deals).toHaveLength(1);
      expect(deals[0]).toMatchObject({ reference: 'BX-6001', branch_code: 'DEL', owner_user_id: U.salesDelhiA, is_synthetic: false });
    });
  });

  it('the dedupe key is the sha256 of member|object|event|id|ts (Phase 6: includes the source object)', async () => {
    await asOwner(db, async () => {
      const { inboxId } = await record(6002, 1_790_100_001, 'ONCRMDEALADD');
      const [row] = await db.query<{ dedupe_key: string; expected: string }>(
        `select dedupe_key, encode(sha256(convert_to($2, 'UTF8')), 'hex') as expected
         from public.integration_inbox where id = $1`,
        [inboxId, `${MEMBER}|deal|ONCRMDEALADD|6002|1790100001`],
      );
      expect(row!.dedupe_key).toBe(row!.expected);
    });
  });

  it('refuses unsupported event types and invalid identifiers', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => record(6003, 1, 'ONCRMDEALDELETE'), { code: '22023' });
      await expectDbError(db, () => record(0, 1), { code: '22023' });
      await expectDbError(db, () => record(6003, -1), { code: '22023' });
    });
  });
});

describe('P2-04 out-of-order versions', () => {
  it('an older or equal DATE_MODIFY never overwrites a newer one', async () => {
    await asOwner(db, async () => {
      const created = await processDeal(
        snapshot({ id: '6101', title: 'Version 2', dateModify: '2026-09-20T12:00:00+05:30' }),
      );
      expect(created.outcome).toBe('created');

      const older = await processDeal(
        snapshot({ id: '6101', title: 'Version 1', dateModify: '2026-09-19T12:00:00+05:30' }),
      );
      expect(older).toMatchObject({ outcome: 'stale_ignored', dealId: created.dealId, reasonCode: 'stale_ignored' });
      expect((await inboxRow(older.inboxId)).status).toBe('ignored');

      const equal = await processDeal(
        snapshot({ id: '6101', title: 'Version 2', dateModify: '2026-09-20T06:30:00Z' }),
      );
      expect(equal.outcome).toBe('stale_ignored');
      expect((await sourcedDeals(6101))[0]!.title).toBe('Version 2');

      // M1: equal DATE_MODIFY with different Bitrix-owned content updates.
      const equalChanged = await processDeal(
        snapshot({ id: '6101', title: 'Version 2 renamed', dateModify: '2026-09-20T06:30:00Z' }),
      );
      expect(equalChanged.outcome).toBe('updated');
      expect((await sourcedDeals(6101))[0]!.title).toBe('Version 2 renamed');
      const equalOwner = await processDeal(
        snapshot({ id: '6101', title: 'Version 2 renamed', assignedById: '102', dateModify: '2026-09-20T06:30:00Z' }),
      );
      expect(equalOwner.outcome).toBe('updated');
      expect((await sourcedDeals(6101))[0]!.owner_user_id).toBe(U.salesDelhiB);

      const newer = await processDeal(
        snapshot({ id: '6101', title: 'Version 3', stageId: 'C7:WON', dateModify: '2026-09-21T12:00:00+05:30' }),
      );
      expect(newer).toMatchObject({ outcome: 'updated', dealId: created.dealId, reasonCode: null });
      const [deal] = await sourcedDeals(6101);
      // Stage eligibility decides entry only; an imported deal follows Bitrix stage changes.
      expect(deal).toMatchObject({ title: 'Version 3', source_stage_id: 'C7:WON' });
    });
  });

  it('an update keeps assignments, branch and reference, and the owner follows the mapping', async () => {
    await asOwner(db, async () => {
      const created = await processDeal(snapshot({ id: '6102' }));
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
         select id, legal_entity_id, $2, 'purchase', $3 from public.deals where id = $1`,
        [created.dealId, U.purchaseJodhpur, U.adminJodhpur],
      );
      const updated = await processDeal(
        snapshot({ id: '6102', assignedById: '102', dateModify: '2026-09-16T10:00:00+05:30' }),
      );
      expect(updated.outcome).toBe('updated');
      const [deal] = await sourcedDeals(6102);
      expect(deal).toMatchObject({ owner_user_id: U.salesDelhiB, branch_code: 'DEL', reference: 'BX-6102' });
      // Other assignments stay; the sales assignment follows the owner (20261007000100).
      expect(
        await db.query(
          `select user_id, assignment_kind from public.deal_assignments where deal_id = $1 and ended_at is null
           order by assignment_kind`,
          [created.dealId],
        ),
      ).toEqual([
        { user_id: U.purchaseJodhpur, assignment_kind: 'purchase' },
        { user_id: U.salesDelhiB, assignment_kind: 'sales' },
      ]);
      expect(
        await db.query(
          `select user_id from public.deal_assignments where deal_id = $1 and assignment_kind = 'sales' and ended_at is not null`,
          [created.dealId],
        ),
      ).toEqual([{ user_id: U.salesDelhiA }]);
      const audit = await db.query<{ action: string; details: Record<string, unknown> }>(
        `select action, details from public.audit_events where target_id = $1 order by id`,
        [created.dealId],
      );
      expect(audit.map((a) => a.action)).toEqual(['integration.deal_created', 'integration.deal_updated']);
      expect(audit[1]!.details).toMatchObject({ ownerChanged: true });
      // No customer content in audit details.
      expect(JSON.stringify(audit)).not.toMatch(/Synthetic Bitrix deal/);
    });
  });
});

describe('P2-05 one lease per row (sequential simulation; see file note)', () => {
  it('leased rows are not claimable again until the lease expires', async () => {
    await asOwner(db, async () => {
      for (const id of [6201, 6202, 6203]) await record(id, 1_790_200_000);
      const a = await claim(2);
      const b = await claim(2);
      const c = await claim(2);
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(1);
      expect(c).toEqual([]);
      const ids = [...a, ...b].map((x) => x.inboxId);
      expect(new Set(ids).size).toBe(3);
      expect(new Set([...a, ...b].map((x) => x.lockToken)).size).toBe(3);
    });
  });

  it('a wrong lock token is refused; two rows for one deal create one deal', async () => {
    await asOwner(db, async () => {
      // The second row is recorded after the first was claimed (a pending row would coalesce, L6).
      const add = await record(6204, 1_790_200_001, 'ONCRMDEALADD');
      const first = (await claim()).find((i) => i.inboxId === add.inboxId)!;
      const upd = await record(6204, 1_790_200_002, 'ONCRMDEALUPDATE');
      expect(upd.duplicate).toBe(false);
      const second = (await claim()).find((i) => i.inboxId === upd.inboxId)!;
      await expectDbError(db, () => apply({ inboxId: first.inboxId, lockToken: second.lockToken }, snapshot({ id: '6204' })), {
        code: '55P03',
      });
      expect((await apply(first, snapshot({ id: '6204' }))).outcome).toBe('created');
      expect((await apply(second, snapshot({ id: '6204' }))).outcome).toBe('stale_ignored');
      // A processed row cannot be applied again with its old token.
      await expectDbError(db, () => apply(first, snapshot({ id: '6204' })), { code: '55P03' });
      expect(await sourcedDeals(6204)).toHaveLength(1);
    });
  });

  it('the source identity is unique even behind the command layer', async () => {
    await asOwner(db, async () => {
      const created = await processDeal(snapshot({ id: '6205' }));
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
               source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
               source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
               source_assigned_by_id)
             select legal_entity_id, branch_id, 'BX-6205-COPY', title, owner_user_id, false, source_system,
               source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
               source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id
             from public.deals where id = $1`,
            [created.dealId],
          ),
        { code: '23505' },
      );
    });
  });
});

describe('P2-06 lease expiry', () => {
  it('a crashed worker’s row is reclaimed once with a new token; the old token is refused', async () => {
    await asOwner(db, async () => {
      const first = await recordAndClaim(6301);
      expect(first.attempts).toBe(1);
      expect(await claim()).toEqual([]);
      await db.query(`update public.integration_inbox set locked_until = now() - interval '1 second' where id = $1`, [
        first.inboxId,
      ]);
      // Token matches but the lease expired: refused.
      await expectDbError(db, () => apply(first, snapshot({ id: '6301' })), { code: '55P03' });
      const reclaimed = await claim();
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]).toMatchObject({ inboxId: first.inboxId, attempts: 2 });
      expect(reclaimed[0]!.lockToken).not.toBe(first.lockToken);
      expect(await claim()).toEqual([]);
      await expectDbError(db, () => apply(first, snapshot({ id: '6301' })), { code: '55P03' });
      expect((await apply(reclaimed[0]!, snapshot({ id: '6301' }))).outcome).toBe('created');
      expect(await sourcedDeals(6301)).toHaveLength(1);
    });
  });

  it('an expired lease at max attempts becomes dead_letter instead of being reclaimed', async () => {
    await asOwner(db, async () => {
      const item = await recordAndClaim(6302);
      await db.query(
        `update public.integration_inbox set attempts = max_attempts, locked_until = now() - interval '1 second' where id = $1`,
        [item.inboxId],
      );
      expect(await claim()).toEqual([]);
      expect(await inboxRow(item.inboxId)).toMatchObject({ status: 'dead_letter', lock_token: null, last_error_code: 'internal_error' });
    });
  });
});

describe('P2-07 failure, back-off and dead letter', () => {
  it('retryable failures back off exponentially (60 s base, 1 h cap) and dead-letter at max_attempts', async () => {
    await asOwner(db, async () => {
      const { inboxId } = await record(6401, 1_790_400_000);
      const delays: number[] = [];
      let status = '';
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const items = await claim();
        expect(items.map((i) => i.inboxId)).toEqual([inboxId]);
        expect(items[0]!.attempts).toBe(attempt);
        const result = await fail(items[0]!, 'provider_timeout', true);
        status = result.status;
        if (result.nextAttemptAt) {
          const [{ secs }] = (await db.query<{ secs: number }>(
            `select extract(epoch from ($1::timestamptz - now()))::int as secs`,
            [result.nextAttemptAt],
          )) as [{ secs: number }];
          delays.push(secs);
          // Not due yet.
          expect(await claim()).toEqual([]);
          await db.query(`update public.integration_inbox set next_attempt_at = now() where id = $1`, [inboxId]);
        }
      }
      expect(delays).toEqual([60, 120, 240, 480, 960, 1920, 3600]);
      expect(status).toBe('dead_letter');
      expect(await inboxRow(inboxId)).toMatchObject({
        status: 'dead_letter',
        attempts: 8,
        next_attempt_at: null,
        last_error_code: 'provider_timeout',
      });
      expect(await claim()).toEqual([]);
    });
  });

  it('a non-retryable failure dead-letters at once; unknown codes and stale tokens are refused', async () => {
    await asOwner(db, async () => {
      const item = await recordAndClaim(6402);
      await expectDbError(db, () => fail(item, 'https://secret.example/rest/1/abc', true), { code: '22023' });
      await expectDbError(db, () => fail({ ...item, lockToken: crypto.randomUUID() }, 'internal_error', true), {
        code: '55P03',
      });
      expect((await fail(item, 'provider_auth_failed', false)).status).toBe('dead_letter');
      await expectDbError(db, () => fail(item, 'internal_error', true), { code: '55P03' });
    });
  });
});

describe('P2-08 unknown owner, wrong branch, invalid data: needs_review and no deal', () => {
  const cases: Array<[string, DealSnapshot | null, string]> = [
    ['unmapped Bitrix user', snapshot({ id: '6501', assignedById: '555' }), 'unmapped_owner'],
    ['inactive mapping row', snapshot({ id: '6502', assignedById: '199' }), 'unmapped_owner'],
    ['inactive staff member', snapshot({ id: '6503', assignedById: '108' }), 'unmapped_owner'],
    ['owner in another branch', snapshot({ id: '6504', assignedById: '104' }), 'owner_not_in_pilot_branch'],
    ['owner without active membership', snapshot({ id: '6505', assignedById: '109' }), 'owner_not_in_pilot_branch'],
    ['title over 300 characters', snapshot({ id: '6506', title: 'x'.repeat(301) }), 'invalid_source_data'],
    ['blank title', snapshot({ id: '6507', title: '   ' }), 'invalid_source_data'],
    ['non-numeric owner id', snapshot({ id: '6508', assignedById: '10a' }), 'invalid_source_data'],
    ['deal id mismatch', snapshot({ id: '9999' }), 'invalid_source_data'],
    ['malformed date', snapshot({ id: '6510', dateCreate: '2026-13-45T99:00:00Z' }), 'invalid_source_data'],
    ['modified before created', snapshot({ id: '6511', dateModify: '2026-09-01T00:00:00Z' }), 'invalid_source_data'],
    ['source deal not found', null, 'source_deal_not_found'],
  ];

  it.each(cases)('%s', async (_name, deal, reason) => {
    await asOwner(db, async () => {
      const before = await countDeals();
      const item = await recordAndClaim(Number(deal?.id === '9999' ? 6509 : (deal?.id ?? 6512)));
      const result = await apply(item, deal);
      expect(result).toEqual({ outcome: 'needs_review', dealId: null, reasonCode: reason });
      expect(await inboxRow(item.inboxId)).toMatchObject({ status: 'needs_review', reason_code: reason, lock_token: null });
      expect(await countDeals()).toBe(before);
      const audit = await db.query<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where target_id = $1`,
        [item.inboxId],
      );
      expect(audit.map((a) => a.action)).toEqual(['integration.deal_needs_review']);
      expect(JSON.stringify(audit)).not.toMatch(/xxxx|Synthetic Bitrix deal/);
    });
  });

  it('a missing or non-string field is invalid source data', async () => {
    await asOwner(db, async () => {
      const item = await recordAndClaim(6513);
      const { title: _omit, ...rest } = snapshot({ id: '6513' });
      void _omit;
      expect((await apply(item, rest as BitrixDealSnapshot)).reasonCode).toBe('invalid_source_data');
      const item2 = await recordAndClaim(6514);
      expect(
        (await apply(item2, { ...snapshot({ id: '6514' }), categoryId: 7 } as unknown as BitrixDealSnapshot)).reasonCode,
      ).toBe('invalid_source_data');
    });
  });
});

describe('P2-09 not eligible: ignored, no deal', () => {
  it.each([
    ['other category', snapshot({ id: '6601', categoryId: '8' }), 'not_eligible_category'],
    ['ineligible stage', snapshot({ id: '6602', stageId: 'C7:WON' }), 'not_eligible_stage'],
    // Phase 6: creation must also fall inside the manifest day (2026-09-15 IST), so
    // the cutoff is moved after the creation time instead of the creation before it.
    ['created before cutoff', snapshot({ id: '6603', dateCreate: '2026-09-15T10:00:00+05:30' }), 'before_cutoff'],
  ] as const)('%s', async (_name, deal, reason) => {
    await asOwner(db, async () => {
      if (reason === 'before_cutoff') {
        await db.exec(`update public.integration_intake_config set cutoff_at = '2026-09-15T10:00:01+05:30'`);
      }
      const before = await countDeals();
      const item = await recordAndClaim(Number(deal.id));
      expect(await apply(item, deal)).toEqual({ outcome: 'ignored', dealId: null, reasonCode: reason });
      expect(await inboxRow(item.inboxId)).toMatchObject({ status: 'ignored', reason_code: reason });
      expect(await countDeals()).toBe(before);
    });
  });
});

describe('sync date = creation date (20261009000600, renumbered from 20261008000200)', () => {
  it('an older deal modified after the sync date is NOT stored (later edits do not count)', async () => {
    await asOwner(db, async () => {
      // Inside the approved manifest day (2026-09-15 IST), created before a sync date later that day.
      await db.exec(`update public.integration_intake_config set cutoff_at = '2026-09-15T12:00:00+05:30'`);
      const r = await processDeal(
        snapshot({ id: '6604', dateCreate: '2026-09-15T10:00:00+05:30', dateModify: '2026-09-15T14:00:00+05:30' }),
      );
      expect(r).toMatchObject({ outcome: 'ignored', reasonCode: 'before_cutoff' });
    });
  });
});

describe('P2-10 intake disabled, missing or environment unset', () => {
  it('a disabled config refuses events (55000) and claims skip its rows', async () => {
    await asOwner(db, async () => {
      const pending = await record(6701, 1_790_700_000);
      await db.exec(`update public.integration_intake_config set enabled = false`);
      await expectDbError(db, () => record(6701, 1_790_700_001), { code: '55000' });
      expect(await claim()).toEqual([]);
      expect((await inboxRow(pending.inboxId)).status).toBe('pending');
    });
  });

  it('a missing config refuses events (55000)', async () => {
    await asOwner(db, async () => {
      // Manifests are never deleted by commands; this owner-only cleanup bypasses the guard triggers.
      await db.exec(`set local session_replication_role = replica;
                     delete from public.intake_manifest_items; delete from public.intake_manifests;
                     set local session_replication_role = origin;
                     delete from public.bitrix_user_mappings; delete from public.integration_intake_config;`);
      await expectDbError(db, () => record(6702, 1_790_700_002), { code: '55000' });
      await expectDbError(
        db,
        () => svc('select public.integration_enqueue_reconcile($1, $2, $3)', [MEMBER, 6702, 1_790_700_002]),
        { code: '55000' },
      );
    });
  });

  it('a wrong portal member id is refused (42501) while intake is configured', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => record(6703, 1_790_700_003, 'ONCRMDEALADD', 'OTHER_PORTAL'), { code: '42501' });
      expect(await db.query(`select id from public.integration_inbox where source_deal_id = 6703`)).toEqual([]);
    });
  });

  it('environment unset refuses record, reconcile and claim (55000)', async () => {
    await asOwner(db, async () => {
      await db.exec(`update public.deployment_settings set environment = 'unset'`);
      const before = Number((await db.query<{ n: string }>('select count(*)::text as n from public.integration_inbox'))[0]!.n);
      const unset = { code: '55000', message: /^environment_unset$/ };
      await expectDbError(db, () => record(6704, 1_790_700_004), unset);
      await expectDbError(db, () => claim(), unset);
      await expectDbError(
        db,
        () => svc('select public.integration_enqueue_reconcile($1, $2, $3)', [MEMBER, 6704, 1_790_700_004]),
        unset,
      );
      // Rows: unset refusals write no inbox row.
      expect(Number((await db.query<{ n: string }>('select count(*)::text as n from public.integration_inbox'))[0]!.n)).toBe(before);
    });
  });

  it('config disabled or environment unset after a claim: needs_review, no deal', async () => {
    await asOwner(db, async () => {
      const before = await countDeals();
      const a = await recordAndClaim(6705);
      const b = await recordAndClaim(6706);
      await db.exec(`update public.integration_intake_config set enabled = false`);
      expect(await apply(a, snapshot({ id: '6705' }))).toEqual({
        outcome: 'needs_review',
        dealId: null,
        reasonCode: 'not_configured',
      });
      await db.exec(`update public.integration_intake_config set enabled = true;
                     update public.deployment_settings set environment = 'unset';`);
      expect((await apply(b, snapshot({ id: '6706' }))).reasonCode).toBe('environment_unset');
      expect(await countDeals()).toBe(before);
    });
  });
});

describe('P2-11 reconcile enqueue (database part)', () => {
  it('enqueues once, skips open rows and versions CRM already holds', async () => {
    await asOwner(db, async () => {
      const enqueue = async (dealId: number, modified: number) =>
        (
          await svc<{ r: { inboxId: string | null; duplicate: boolean; upToDate: boolean } }>(
            'select public.integration_enqueue_reconcile($1, $2, $3) as r',
            [MEMBER, dealId, modified],
          )
        )[0]!.r;
      const modified = Date.parse('2026-09-15T04:30:00Z') / 1000;
      const first = await enqueue(6801, modified);
      expect(first).toMatchObject({ duplicate: false, upToDate: false });
      expect(await enqueue(6801, modified)).toEqual({ inboxId: first.inboxId, duplicate: true, upToDate: false, ignored: false });
      const [item] = await claim();
      expect(item).toMatchObject({ inboxId: first.inboxId, origin: 'reconcile', eventType: 'RECONCILE' });
      expect((await apply(item!, snapshot({ id: '6801' }))).outcome).toBe('created');
      expect(await enqueue(6801, modified)).toEqual({ inboxId: null, duplicate: true, upToDate: true, ignored: false });
      expect((await enqueue(6801, modified + 60)).duplicate).toBe(false);
    });
  });
});

describe('P2-14 access to imported deals and intake data', () => {
  const refs = async (actor: Actor) =>
    (await run<{ reference: string }>(actor, 'select reference from public.deals order by reference')).map(
      (r) => r.reference,
    );

  it('an imported deal is visible to the mapped owner and explicit scopes only', async () => {
    await asOwner(db, async () => {
      await processDeal(snapshot({ id: '6901' }));
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BX-6901', 'SYN-DEL-001']);
      expect(await refs({ userId: U.salesDelhiB })).toEqual(['SYN-DEL-002']);
      expect(await refs({ userId: U.salesAhmedabad })).toEqual(['SYN-AMD-001']);
      expect(await refs({ userId: U.managerDelhi })).toContain('BX-6901'); // explicit Delhi grant
      expect(await refs({ userId: U.accountsJodhpur })).toContain('BX-6901'); // explicit entity grant
      expect(await refs({ userId: U.adminJodhpur })).toEqual([]); // Super Admin reads no deal (access matrix)
      expect(await refs({ userId: U.salesEntityB })).toEqual([]);
      expect(await refs({ userId: U.salesDelhiA, aal: 'aal1' })).toEqual([]);
      const [own] = await run<Record<string, unknown>>(
        { userId: U.salesDelhiA },
        `select source_system, source_deal_id::text, source_stage_id, last_synced_at is not null as synced
         from public.deals where reference = 'BX-6901'`,
      );
      expect(own).toEqual({ source_system: 'bitrix', source_deal_id: '6901', source_stage_id: 'C7:NEW', synced: true });
    });
  });

  it('Purchase assigned to an imported deal sees the header and no commercial row; none can exist', async () => {
    await asOwner(db, async () => {
      const created = await processDeal(snapshot({ id: '6902' }));
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
         select id, legal_entity_id, $2, 'purchase', $3 from public.deals where id = $1`,
        [created.dealId, U.purchaseJodhpur, U.adminJodhpur],
      );
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual(['BX-6902', 'SYN-DEL-001']);
      expect(
        await run({ userId: U.purchaseJodhpur }, 'select deal_id from public.deal_commercials where deal_id = $1', [
          created.dealId,
        ]),
      ).toEqual([]);
      for (const synthetic of [false, true]) {
        await expectDbError(
          db,
          () =>
            db.query(
              `insert into public.deal_commercials (deal_id, legal_entity_id, selling_total_paise, estimated_margin_paise, is_synthetic)
               select id, legal_entity_id, 100, 10, $2 from public.deals where id = $1`,
              [created.dealId, synthetic],
            ),
          { code: synthetic ? '23503' : '23514' },
        );
      }
    });
  });

  const intakeTables = ['integration_inbox', 'integration_intake_config', 'bitrix_user_mappings', 'deployment_settings'];

  it('only a valid aal2 integration.manage session reads intake tables', async () => {
    await asOwner(db, async () => {
      await processDeal(snapshot({ id: '6903', assignedById: '555' }));
      for (const table of intakeTables) {
        const admin = await run({ userId: U.adminJodhpur }, `select * from public.${table}`);
        expect(admin.length, `${table} admin`).toBeGreaterThan(0);
        for (const actor of [
          { userId: U.adminJodhpur, aal: 'aal1' as const },
          { userId: U.adminJodhpur, amr: amrAt(13 * 3600) }, // older than the session max age
          { userId: U.salesDelhiA },
          { userId: U.managerDelhi },
          { userId: U.accountsJodhpur },
          { userId: U.purchaseJodhpur },
        ]) {
          expect(await run(actor, `select * from public.${table}`), `${table} ${JSON.stringify(actor)}`).toEqual([]);
        }
        await expectDbError(db, () => run({ userId: null }, `select * from public.${table}`), { code: '42501' });
      }
      // The inbox row holds bounded fields only (no payload column).
      const cols = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'integration_inbox'`,
      );
      expect(cols.map((c) => c.column_name).sort()).toEqual(
        [
          'attempts', 'dedupe_key', 'event_type', 'id', 'last_error_at', 'last_error_code', 'lock_token',
          'locked_until', 'max_attempts', 'next_attempt_at', 'origin', 'portal_member_id', 'processed_at',
          'processed_deal_id', 'processed_lead_id', 'reason_code', 'received_at', 'source_deal_id', 'source_object',
          'source_system', 'source_ts', 'status', 'updated_at',
        ].sort(),
      );
    });
  });

  it('staff and anon have no direct writes on intake tables', async () => {
    await asOwner(db, async () => {
      for (const actor of [{ userId: U.adminJodhpur }, { userId: null }] as Actor[]) {
        await expectDbError(db, () => run(actor, `update public.integration_inbox set status = 'pending'`), { code: '42501' });
        await expectDbError(db, () => run(actor, `update public.integration_intake_config set enabled = true`), {
          code: '42501',
        });
        await expectDbError(db, () => run(actor, `update public.deployment_settings set environment = 'operational'`), {
          code: '42501',
        });
        await expectDbError(db, () => run(actor, `delete from public.bitrix_user_mappings`), { code: '42501' });
      }
      // The secret-key server role cannot change the environment either.
      await expectDbError(db, () => svc(`update public.deployment_settings set environment = 'operational'`), {
        code: '42501',
      });
      await expectDbError(db, () => svc(`delete from public.integration_inbox`), { code: '42501' });
    });
  });

  it('service-only commands are refused to staff (even administrators) and anon', async () => {
    await asOwner(db, async () => {
      const calls = [
        [`select public.integration_record_bitrix_event($1, 'ONCRMDEALADD', 1, 1)`, [MEMBER]],
        [`select public.integration_enqueue_reconcile($1, 1, 1)`, [MEMBER]],
        [`select * from public.integration_claim_inbox(1, 60)`, []],
        [`select public.integration_apply_bitrix_deal(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)`, []],
        [`select public.integration_fail_inbox(gen_random_uuid(), gen_random_uuid(), 'internal_error', true)`, []],
      ] as const;
      for (const actor of [{ userId: U.adminJodhpur }, { userId: U.salesDelhiA }, { userId: null }] as Actor[]) {
        for (const [sql, params] of calls) {
          await expectDbError(db, () => run(actor, sql, [...params]), { code: '42501' });
        }
      }
      await expectDbError(db, () => run({ userId: null }, 'select public.integration_retry_inbox(gen_random_uuid())'), {
        code: '42501',
      });
    });
  });

  it('retry requires a valid aal2 integration.manage session, moves the row to pending and is audited', async () => {
    await asOwner(db, async () => {
      const review = await processDeal(snapshot({ id: '6904', title: '   ' }));
      const retry = (actor: Actor) =>
        run<{ r: { inboxId: string; status: string; previousStatus: string } }>(
          actor,
          'select public.integration_retry_inbox($1) as r',
          [review.inboxId],
        );
      for (const actor of [
        { userId: U.salesDelhiA },
        { userId: U.managerDelhi },
        { userId: U.adminJodhpur, aal: 'aal1' as const },
        { userId: U.adminJodhpur, amr: amrAt(13 * 3600) },
      ]) {
        await expectDbError(db, () => retry(actor), { code: '42501' });
      }
      const r = (await retry({ userId: U.adminJodhpur }))[0]!.r;
      expect(r).toMatchObject({ status: 'pending', previousStatus: 'needs_review' });
      expect(await inboxRow(review.inboxId)).toMatchObject({
        status: 'pending',
        origin: 'manual_retry',
        attempts: 0,
        reason_code: null,
      });
      const audit = await db.query<{ action: string; actor_user_id: string }>(
        `select action, actor_user_id from public.audit_events where target_id = $1 order by id`,
        [review.inboxId],
      );
      expect(audit).toEqual([
        { action: 'integration.deal_needs_review', actor_user_id: null },
        { action: 'integration.inbox_retried', actor_user_id: U.adminJodhpur },
      ]);
      // Pending rows are not retryable; unknown ids look unauthorized.
      await expectDbError(db, () => retry({ userId: U.adminJodhpur }), { code: '22023' });
      await expectDbError(
        db,
        () => run({ userId: U.adminJodhpur }, 'select public.integration_retry_inbox(gen_random_uuid())'),
        { code: '42501' },
      );
    });
  });
});

describe('P2-16 provenance and operational environment', () => {
  const insertSynthetic = (ref: string) =>
    db.query(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
       select b.legal_entity_id, b.id, $1, 'Synthetic', $2 from public.branches b where b.code = 'DEL'`,
      [ref, U.salesDelhiA],
    );

  it('every existing fixture deal satisfies the provenance check', async () => {
    await asOwner(db, async () => {
      const rows = await db.query<{ n: string }>(
        `select count(*)::text as n from public.deals where is_synthetic and source_system is null`,
      );
      expect(Number(rows[0]!.n)).toBe(await countDeals());
    });
  });

  it('synthetic deal inserts are refused when operational; imports still work', async () => {
    await asOwner(db, async () => {
      await insertSynthetic('SYN-TEST-OK'); // environment 'test'
      // L8: operational is refused while synthetic deals exist.
      await expectDbError(db, () => db.exec(`update public.deployment_settings set environment = 'operational'`), {
        code: '23514',
        message: /synthetic deals exist/,
      });
      await db.exec(`delete from public.deal_commercials; delete from public.deal_assignments;
                     delete from public.deals where is_synthetic;`);
      await db.exec(`update public.deployment_settings set environment = 'operational'`);
      // L2: operational refuses a reserved .test portal; use an invented real-format domain (no provider call).
      await db.exec(`update public.integration_intake_config set portal_domain = 'acme-travel-portal.co'`);
      await expectDbError(db, () => insertSynthetic('SYN-TEST-REFUSED'), { code: '23514', message: /operational/ });
      expect((await processDeal(snapshot({ id: '7001' }))).outcome).toBe('created');
    });
  });

  it('a non-synthetic deal needs full provenance; a synthetic deal carries none', async () => {
    await asOwner(db, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
               source_system, source_portal, source_deal_id)
             select b.legal_entity_id, b.id, 'BX-PARTIAL', 'Partial', $1, false, 'bitrix', $2, 424242
             from public.branches b where b.code = 'DEL'`,
            [U.salesDelhiA, MEMBER],
          ),
        { code: '23514' },
      );
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, source_system,
               source_portal, source_deal_id)
             select b.legal_entity_id, b.id, 'SYN-SOURCED', 'Synthetic', $1, 'bitrix', $2, 424243
             from public.branches b where b.code = 'DEL'`,
            [U.salesDelhiA, MEMBER],
          ),
        { code: '23514' },
      );
    });
  });

  it('integration.manage is a proposed, entity-scoped Super Admin permission only', async () => {
    await asOwner(db, async () => {
      expect(
        await db.query(
          `select role_code, scope, policy_status from public.role_permissions where permission_code = 'integration.manage'`,
        ),
      ).toEqual([{ role_code: 'super_admin', scope: 'entity', policy_status: 'proposed' }]);
      expect(
        await db.query(`select is_grantable from public.permissions where code = 'integration.manage'`),
      ).toEqual([{ is_grantable: false }]);
    });
  });
});

describe('Review amendment (contract section 12)', () => {
  const verifiedAt = async (sourceDealId: number) =>
    (
      await db.query<{ v: string | null; synced: string }>(
        `select last_verified_at::text as v, last_synced_at::text as synced from public.deals
         where source_portal = $1 and source_deal_id = $2`,
        [MEMBER, sourceDealId],
      )
    )[0]!;

  it('M1: stale_ignored and reconcile up-to-date record last_verified_at without changing the deal', async () => {
    await asOwner(db, async () => {
      await processDeal(snapshot({ id: '7101' }));
      // Make the stored timestamps visibly older than this transaction's now().
      await db.exec(`update public.deals set last_verified_at = now() - interval '2 days',
                       last_synced_at = now() - interval '2 days' where source_deal_id = 7101`);
      const before = await verifiedAt(7101);
      expect((await processDeal(snapshot({ id: '7101' }))).outcome).toBe('stale_ignored');
      const afterStale = await verifiedAt(7101);
      expect(afterStale.v).not.toBe(before.v);
      expect(afterStale.synced).toBe(before.synced);

      await db.exec(`update public.deals set last_verified_at = now() - interval '2 days' where source_deal_id = 7101`);
      const modified = Date.parse('2026-09-15T04:30:00Z') / 1000;
      const [{ r }] = (await svc<{ r: { upToDate: boolean } }>(
        'select public.integration_enqueue_reconcile($1, $2, $3) as r',
        [MEMBER, 7101, modified],
      )) as [{ r: { upToDate: boolean } }];
      expect(r.upToDate).toBe(true);
      expect((await verifiedAt(7101)).v).toBe(afterStale.v);
    });
  });

  it('M1: the reconcile watermark advances only on success and never backwards', async () => {
    await asOwner(db, async () => {
      const call = (startedAt: string, ok: boolean) =>
        svc<{ r: { portalMemberId: string; lastReconciledAt: string | null; advanced: boolean } }>(
          'select public.integration_record_reconcile_run($1, $2::timestamptz, $3) as r',
          [MEMBER, startedAt, ok],
        ).then((rows) => rows[0]!.r);
      expect(await call('2026-09-30T10:00:00Z', false)).toMatchObject({ lastReconciledAt: null, advanced: false });
      const ok = await call('2026-09-30T10:00:00Z', true);
      expect(ok).toMatchObject({ portalMemberId: MEMBER, advanced: true });
      expect(Date.parse(ok.lastReconciledAt!)).toBe(Date.parse('2026-09-30T10:00:00Z'));
      expect((await call('2026-09-29T10:00:00Z', true)).advanced).toBe(false);
      await expectDbError(db, () => call('2999-01-01T00:00:00Z', true), { code: '22023' });
      await expectDbError(
        db,
        () => svc(`select public.integration_record_reconcile_run('OTHER_PORTAL', now(), true)`),
        { code: '42501' },
      );
    });
  });

  it('M2: worker runs are recorded by the service role and readable only with integration.manage', async () => {
    await asOwner(db, async () => {
      const recordRun = (run: Record<string, unknown>) =>
        svc<{ r: { runId: string } }>('select public.integration_record_worker_run($1::jsonb) as r', [
          JSON.stringify(run),
        ]);
      const okRun = {
        kind: 'worker',
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        finishedAt: new Date(Date.now() - 1_000).toISOString(),
        outcome: 'partial',
        claimed: 3,
        created: 1,
        needsReview: 1,
        failed: 1,
      };
      const [{ r }] = (await recordRun(okRun)) as [{ r: { runId: string } }];
      expect(
        await db.query(
          `select kind, outcome, claimed, created, updated, needs_review, failed, dead_lettered
           from public.integration_worker_runs where id = $1`,
          [r.runId],
        ),
      ).toEqual([
        { kind: 'worker', outcome: 'partial', claimed: 3, created: 1, updated: 0, needs_review: 1, failed: 1, dead_lettered: 0 },
      ]);
      for (const bad of [
        { ...okRun, note: 'free text' },
        { ...okRun, kind: 'other' },
        { ...okRun, outcome: 'fine' },
        { ...okRun, claimed: -1 },
        { ...okRun, claimed: '3' },
        { ...okRun, startedAt: okRun.finishedAt, finishedAt: okRun.startedAt },
        { ...okRun, startedAt: 'yesterday' },
      ]) {
        await expectDbError(db, () => recordRun(bad), { code: '22023' });
      }
      expect(await run({ userId: U.adminJodhpur }, 'select id from public.integration_worker_runs')).toHaveLength(1);
      for (const actor of [{ userId: U.salesDelhiA }, { userId: U.adminJodhpur, aal: 'aal1' as const }]) {
        expect(await run(actor, 'select id from public.integration_worker_runs')).toEqual([]);
      }
      await expectDbError(db, () => run({ userId: null }, 'select id from public.integration_worker_runs'), {
        code: '42501',
      });
      await expectDbError(
        db,
        () => run({ userId: U.adminJodhpur }, `select public.integration_record_worker_run('{}'::jsonb)`),
        { code: '42501' },
      );
      await expectDbError(db, () => svc(`delete from public.integration_worker_runs`), { code: '42501' });
    });
  });

  it('L1: release returns a leased row to pending without consuming an attempt', async () => {
    await asOwner(db, async () => {
      const item = await recordAndClaim(7201);
      expect(item.attempts).toBe(1);
      await expectDbError(
        db,
        () => svc('select public.integration_release_inbox($1, $2)', [item.inboxId, crypto.randomUUID()]),
        { code: '55P03' },
      );
      const [{ r }] = (await svc<{ r: { status: string; attempts: number } }>(
        'select public.integration_release_inbox($1, $2) as r',
        [item.inboxId, item.lockToken],
      )) as [{ r: { status: string; attempts: number } }];
      expect(r).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await inboxRow(item.inboxId)).toMatchObject({ status: 'pending', attempts: 0, lock_token: null });
      await expectDbError(db, () => apply(item, snapshot({ id: '7201' })), { code: '55P03' });
      const [again] = await claim();
      expect(again).toMatchObject({ inboxId: item.inboxId, attempts: 1 });
      await expectDbError(
        db,
        () => run({ userId: U.adminJodhpur }, 'select public.integration_release_inbox($1, $2)', [again!.inboxId, again!.lockToken]),
        { code: '42501' },
      );
    });
  });

  it('L2: a data_exception while parsing is invalid source data, not a worker failure', async () => {
    await asOwner(db, async () => {
      const item = await recordAndClaim(7301);
      expect(await apply(item, snapshot({ id: '7301', dateModify: '2026-09-15T10:00:00+99:99' }))).toEqual({
        outcome: 'needs_review',
        dealId: null,
        reasonCode: 'invalid_source_data',
      });
      const item2 = await recordAndClaim(7302);
      expect((await apply(item2, snapshot({ id: '7302', dateCreate: '2026-02-30T10:00:00Z' }))).reasonCode).toBe(
        'invalid_source_data',
      );
    });
  });

  it('L3: a reference collision is needs_review/reference_conflict; synthetic deals cannot use BX-', async () => {
    await asOwner(db, async () => {
      const holder = await record(7400, 1_790_740_000);
      // A non-synthetic deal from another portal already holds BX-7401 in this entity.
      await db.query(
        `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
           source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
         select b.legal_entity_id, b.id, 'BX-7401', 'Other portal', $1, false, 'bitrix', 'OTHER_PORTAL', 7401,
           'C7:NEW', 7, now(), now(), now(), now(), $2, 101
         from public.branches b where b.code = 'DEL'`,
        [U.salesDelhiA, holder.inboxId],
      );
      const before = await countDeals();
      const item = await recordAndClaim(7401);
      expect(await apply(item, snapshot({ id: '7401' }))).toEqual({
        outcome: 'needs_review',
        dealId: null,
        reasonCode: 'reference_conflict',
      });
      expect(await countDeals()).toBe(before);
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
             select b.legal_entity_id, b.id, 'BX-1', 'Synthetic', $1 from public.branches b where b.code = 'DEL'`,
            [U.salesDelhiA],
          ),
        { code: '23514', message: /deals_synthetic_reference_prefix/ },
      );
    });
  });

  it('L5: request_reconcile authorizes, audits every attempt and enforces the 300 s cooldown', async () => {
    await asOwner(db, async () => {
      type Req = { portalMemberId: string; allowed: boolean; retryAfterSeconds: number };
      const request = (actor: Actor) =>
        run<{ r: Req }>(actor, 'select public.integration_request_reconcile() as r').then((rows) => rows[0]!.r);
      for (const actor of [
        { userId: U.salesDelhiA },
        { userId: U.managerDelhi },
        { userId: U.adminJodhpur, aal: 'aal1' as const },
        { userId: null },
      ] as Actor[]) {
        await expectDbError(db, () => request(actor), { code: '42501' });
      }
      await expectDbError(db, () => request(SVC), { code: '42501' });
      expect(await request({ userId: U.adminJodhpur })).toEqual({
        portalMemberId: MEMBER,
        allowed: true,
        retryAfterSeconds: 0,
      });
      // Same transaction clock: the full cooldown remains.
      expect(await request({ userId: U.adminJodhpur })).toEqual({
        portalMemberId: MEMBER,
        allowed: false,
        retryAfterSeconds: 300,
      });
      const audit = await db.query<{ action: string; actor_user_id: string; details: Record<string, unknown> }>(
        `select action, actor_user_id, details from public.audit_events
         where action = 'integration.reconcile_requested' order by id`,
      );
      expect(audit.map((a) => [a.actor_user_id, a.details.allowed])).toEqual([
        [U.adminJodhpur, true],
        [U.adminJodhpur, false],
      ]);
      await db.exec(`update public.integration_intake_config
                     set last_reconcile_requested_at = now() - interval '301 seconds'`);
      expect((await request({ userId: U.adminJodhpur })).allowed).toBe(true);
      await db.exec(`update public.integration_intake_config set enabled = false`);
      await expectDbError(db, () => request({ userId: U.adminJodhpur }), { code: '55000' });
    });
  });

  it('L6: an event for a deal with an unclaimed pending row coalesces into it', async () => {
    await asOwner(db, async () => {
      const first = await record(7601, 1_790_760_001, 'ONCRMDEALADD');
      const second = await record(7601, 1_790_760_002, 'ONCRMDEALUPDATE');
      expect(second).toEqual({ inboxId: first.inboxId, duplicate: true });
      expect(await db.query(`select id from public.integration_inbox where source_deal_id = 7601`)).toHaveLength(1);
      await claim();
      // Once claimed, a new event is new work (the claimed read may predate it).
      const third = await record(7601, 1_790_760_003, 'ONCRMDEALUPDATE');
      expect(third.duplicate).toBe(false);
      expect(third.inboxId).not.toBe(first.inboxId);
    });
  });

  it('L8: the environment cannot become operational while synthetic deals exist', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => db.exec(`update public.deployment_settings set environment = 'operational'`), {
        code: '23514',
      });
      await db.exec(`update public.deployment_settings set environment = 'staging'`);
    });
  });
});
