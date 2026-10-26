import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyResult, ClaimedInboxItem } from '@/modules/integration/contracts';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';

/**
 * Phase 5 least-privilege receiver path (security review M3), migration
 * 20261006000100_intake_production.sql. The Edge Function calls
 * public.integration_receive_bitrix_event with the PUBLISHABLE key (role anon)
 * and the receiver credential; it never holds a secret key in its code path.
 *
 * Synthetic values only. Every scenario runs in a rolled-back transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const ANON: Actor = { userId: null };
const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
/** Invented real-format portal domain for operational-mode cases (rolled back, never contacted). */
const REAL_DOMAIN = 'acme-travel-portal.co';
const CREDENTIAL = 'synthetic-receiver-credential-0123456789abcdef';
const CREDENTIAL_2 = 'synthetic-receiver-credential-rotated-9876543210';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

/** Owner inserts the DIGEST of a credential (the value itself is never stored). */
async function addCredential(value: string, slot = 1) {
  await db.query(
    `insert into public.integration_receiver_credentials (slot, credential_sha256, note)
     values ($1, decode($2, 'hex'), 'synthetic test credential')`,
    [slot, digest(value)],
  );
}

interface ReceiveArgs {
  credential?: string | null;
  member?: string | null;
  domain?: string | null;
  event?: string;
  dealId?: number;
  ts?: number;
}
let tsCounter = 1_795_000_000;
async function receive(args: ReceiveArgs = {}, actor: Actor = ANON) {
  const rows = await run<{ r: { inboxId: string; duplicate: boolean } }>(
    actor,
    'select public.integration_receive_bitrix_event($1, $2, $3, $4, $5, $6) as r',
    [
      args.credential === undefined ? CREDENTIAL : args.credential,
      args.member === undefined ? MEMBER : args.member,
      args.domain === undefined ? DOMAIN : args.domain,
      args.event ?? 'ONCRMDEALADD',
      args.dealId ?? 9001,
      args.ts ?? (tsCounter += 1),
    ],
  );
  return rows[0]!.r;
}

const inboxCount = async () =>
  Number((await db.query<{ n: string }>('select count(*)::text as n from public.integration_inbox'))[0]!.n);

describe('receiver credential (checked before any intake read)', () => {
  it('anon with an active credential records one event; redelivery is a duplicate', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      const first = await receive({ dealId: 9001, ts: 1_795_100_000 });
      expect(first.duplicate).toBe(false);
      expect(typeof first.inboxId).toBe('string');
      expect(Object.keys(first).sort()).toEqual(['duplicate', 'inboxId']);
      expect(await receive({ dealId: 9001, ts: 1_795_100_000 })).toEqual({ inboxId: first.inboxId, duplicate: true });
      // A later event for the same unclaimed deal coalesces into the pending row (L6).
      expect(await receive({ dealId: 9001, event: 'ONCRMDEALUPDATE' })).toEqual({ inboxId: first.inboxId, duplicate: true });
      const rows = await db.query<{ portal_member_id: string; origin: string; status: string }>(
        `select portal_member_id, origin, status from public.integration_inbox where id = $1`,
        [first.inboxId],
      );
      expect(rows).toEqual([{ portal_member_id: MEMBER, origin: 'event', status: 'pending' }]);
    });
  });

  it.each([
    ['unknown credential', 'synthetic-receiver-credential-WRONG-000000000'],
    ['credential prefix', CREDENTIAL.slice(0, -1)],
    ['too short', 'short'],
    ['too long', 'x'.repeat(257)],
    ['missing', null],
  ])('%s -> 28000, nothing stored', async (_label, credential) => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      const before = await inboxCount();
      await expectDbError(db, () => receive({ credential }), { code: '28000', message: /receiver not authorized/ });
      expect(await inboxCount()).toBe(before);
    });
  });

  it('no credential row at all -> 28000 even with intake configured', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => receive(), { code: '28000' });
    });
  });

  it('a wrong credential is refused before the environment check (no configuration oracle)', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await db.exec(`update public.deployment_settings set environment = 'unset'`);
      const before = await inboxCount();
      await expectDbError(db, () => receive({ credential: 'synthetic-receiver-credential-WRONG-000000000' }), { code: '28000' });
      // L1: unset keeps its own refusal token, distinct from not_configured.
      await expectDbError(db, () => receive(), { code: '55000', message: /^environment_unset$/ });
      expect(await inboxCount()).toBe(before);
    });
  });

  it('rotation: two slots overlap; revoking one stops it immediately', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL, 1);
      await addCredential(CREDENTIAL_2, 2);
      await receive({ dealId: 9101 });
      await receive({ credential: CREDENTIAL_2, dealId: 9102 });
      await db.exec(`update public.integration_receiver_credentials set active = false, revoked_at = now() where slot = 1`);
      await expectDbError(db, () => receive({ dealId: 9103 }), { code: '28000' });
      await receive({ credential: CREDENTIAL_2, dealId: 9104 });
    });
  });

  it('one active credential per slot; digests must be 32 bytes; revoked rows need revoked_at', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL, 1);
      await expectDbError(db, () => addCredential(CREDENTIAL_2, 1), { code: '23505' });
      await expectDbError(db, () => addCredential(CREDENTIAL_2, 3), { code: '23514' });
      await expectDbError(
        db,
        () => db.query(`insert into public.integration_receiver_credentials (slot, credential_sha256) values (2, '\\x00')`),
        { code: '23514' },
      );
      await expectDbError(db, () => db.exec(`update public.integration_receiver_credentials set active = false`), {
        code: '23514',
      });
    });
  });
});

describe('portal identity: member_id AND domain must match the single enabled config', () => {
  it.each([
    ['wrong member_id', { member: 'OTHER_MEMBER_0001' }],
    ['wrong domain', { domain: 'other-portal.example.test' }],
    ['missing member_id', { member: null }],
    ['missing domain', { domain: null }],
  ] as Array<[string, ReceiveArgs]>)('%s -> 42501', async (_label, args) => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await expectDbError(db, () => receive(args), { code: '42501', message: /portal not recognised/ });
    });
  });

  it('domain case and a trailing dot are normalised', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      expect((await receive({ domain: `${DOMAIN.toUpperCase()}.`, dealId: 9201 })).duplicate).toBe(false);
    });
  });

  it('stop switches: disabled config, environment unset, two enabled portals -> 55000', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await db.exec(`savepoint s1`);
      const before = await inboxCount();
      await db.exec(`update public.integration_intake_config set enabled = false`);
      await expectDbError(db, () => receive(), { code: '55000', message: /^not_configured$/ });
      expect(await inboxCount()).toBe(before);
      await db.exec(`rollback to savepoint s1`);

      await db.exec(`update public.deployment_settings set environment = 'unset'`);
      await expectDbError(db, () => receive(), { code: '55000', message: /^environment_unset$/ });
      await expectDbError(db, () => receive({ event: 'ONCRMLEADADD' }), { code: '55000', message: /^environment_unset$/ });
      expect(await inboxCount()).toBe(before);
      await db.exec(`rollback to savepoint s1`);

      await db.exec(`insert into public.integration_intake_config
          (portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at, pilot_legal_entity_id, pilot_branch_id, enabled)
        select 'second-portal.example.test', 'SYNTHETIC_MEMBER_0002', 7, array['C7:NEW'], now(), pilot_legal_entity_id, pilot_branch_id, true
        from public.integration_intake_config where portal_member_id = '${MEMBER}'`);
      await expectDbError(db, () => receive(), { code: '55000', message: /^not_configured$/ });
      expect(await inboxCount()).toBe(before);
    });
  });

  it('staging refuses intake even with a valid credential and enabled matching portal', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await db.exec(`update public.deployment_settings set environment = 'staging'`);
      const before = await inboxCount();
      await expectDbError(db, () => receive(), { code: '55000', message: /^not_configured$/ });
      expect(await inboxCount()).toBe(before);
    });
  });

  it('test mode accepts reserved fixtures only; a real portal requires operational mode', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      const realDomain = 'acme-travel-portal.co'; // Invented real-format domain, no provider call.
      await db.query(`update public.integration_intake_config set portal_domain = $1 where portal_member_id = $2`, [realDomain, MEMBER]);
      const before = await inboxCount();
      await expectDbError(db, () => receive({ domain: realDomain }), { code: '55000', message: /^not_configured$/ });
      expect(await inboxCount()).toBe(before);
      await db.exec(`delete from public.deal_commercials; delete from public.deal_assignments; delete from public.deals where is_synthetic;`);
      await db.exec(`update public.deployment_settings set environment = 'operational'`);
      expect((await receive({ domain: realDomain })).duplicate).toBe(false);
      expect(await inboxCount()).toBe(before + 1);
    });
  });

  it('invalid event shape after authentication -> 22023', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await expectDbError(db, () => receive({ event: 'ONCRMDEALDELETE' }), { code: '22023' });
      await expectDbError(db, () => receive({ dealId: 0 }), { code: '22023' });
      await expectDbError(db, () => receive({ ts: -1 }), { code: '22023' });
    });
  });
});

describe('grants: the publishable key can do exactly one thing', () => {
  it('anon cannot call the service-role commands or read intake tables', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      await expectDbError(
        db,
        () => run(ANON, `select public.integration_record_bitrix_event($1, 'ONCRMDEALADD', 1, 1)`, [MEMBER]),
        { code: '42501' },
      );
      await expectDbError(db, () => run(ANON, `select public.integration_claim_inbox(10, 60)`), { code: '42501' });
      for (const table of [
        'integration_receiver_credentials',
        'integration_intake_config',
        'integration_inbox',
        'bitrix_user_mappings',
        'deployment_settings',
        'deals',
      ]) {
        await expectDbError(db, () => run(ANON, `select * from public.${table}`), { code: '42501' });
      }
    });
  });

  it('staff sessions and the secret key cannot call the receiver RPC or read credential digests', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      const admin: Actor = { userId: U.adminJodhpur };
      await expectDbError(
        db,
        () => run(admin, `select public.integration_receive_bitrix_event($1, $2, $3, 'ONCRMDEALADD', 1, 1)`, [CREDENTIAL, MEMBER, DOMAIN]),
        { code: '42501' },
      );
      await expectDbError(db, () => run(admin, `select * from public.integration_receiver_credentials`), { code: '42501' });
      await expectDbError(db, () => run(SVC, `select * from public.integration_receiver_credentials`), { code: '42501' });
      await expectDbError(
        db,
        () => run(SVC, `insert into public.integration_receiver_credentials (slot, credential_sha256) values (2, decode($1, 'hex'))`, [digest(CREDENTIAL_2)]),
        { code: '42501' },
      );
    });
  });

  it('helper functions are not callable by API roles', async () => {
    await asOwner(db, async () => {
      for (const actor of [ANON, SVC, { userId: U.adminJodhpur } as Actor]) {
        await expectDbError(db, () => run(actor, `select authz.intake_receiver_authorized($1)`, [CREDENTIAL]), { code: '42501' });
      }
    });
  });

  it('the receiver RPC is security definer with an empty search_path', async () => {
    const rows = await db.query<{ secdef: boolean; config: string[] | null }>(
      `select p.prosecdef as secdef, p.proconfig as config from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'integration_receive_bitrix_event'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secdef).toBe(true);
    expect(rows[0]!.config).toEqual(['search_path=""']);
  });
});

describe('production pilot path end to end (synthetic): receive -> claim -> apply', () => {
  it('operational environment, mapped owner -> created; unmapped owner -> needs_review/unmapped_owner', async () => {
    await asOwner(db, async () => {
      await addCredential(CREDENTIAL);
      // Production pilot runs as 'operational', which needs zero synthetic deals (L8).
      await db.exec(`delete from public.deal_commercials; delete from public.deal_assignments;
                     delete from public.deals where is_synthetic;`);
      await db.exec(`update public.deployment_settings set environment = 'operational'`);
      // L2: operational accepts only a real-format portal (invented here, no provider call).
      await db.query(`update public.integration_intake_config set portal_domain = $1 where portal_member_id = $2`, [REAL_DOMAIN, MEMBER]);

      const mapped = await receive({ dealId: 9301, domain: REAL_DOMAIN });
      const unmapped = await receive({ dealId: 9302, domain: REAL_DOMAIN });
      const claimed = (await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(10, 60) as r')).map((x) => x.r);
      const apply = async (inboxId: string, assignedById: string) => {
        const item = claimed.find((c) => c.inboxId === inboxId)!;
        const deal = {
          id: item.sourceDealId,
          sourceId: 'SYNTHETIC_SRC',
          title: 'Synthetic production-path deal',
          stageId: 'C7:NEW',
          categoryId: '7',
          assignedById,
          dateCreate: '2026-09-15T10:00:00+05:30',
          dateModify: '2026-09-15T10:00:00+05:30',
        };
        const rows = await run<{ r: ApplyResult }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
          item.inboxId,
          item.lockToken,
          JSON.stringify(deal),
        ]);
        return rows[0]!.r;
      };
      expect((await apply(mapped.inboxId, '101')).outcome).toBe('created');
      const review = await apply(unmapped.inboxId, '999');
      expect(review).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner', dealId: null });
      const deals = await db.query<{ is_synthetic: boolean; owner_user_id: string }>(
        `select is_synthetic, owner_user_id from public.deals where source_deal_id = 9301`,
      );
      expect(deals).toEqual([{ is_synthetic: false, owner_user_id: U.salesDelhiA }]);
    });
  });
});
