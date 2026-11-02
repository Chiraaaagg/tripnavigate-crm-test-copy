import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDestination } from './finance-support';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  istBusinessDate,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 5A access verification (docs/implementation/history/contracts/phase-5a-contract.md
 * sections 4, 5, 11 and 17): direct table and RPC denials per role, deal
 * conflicts and self-action refusals for every transition, mixed roles,
 * other and finance-disabled entities, AAL1 and inactive staff, and the reads
 * Accounts must never gain (Leads, supplier bank details, other entities).
 *
 * Every scenario runs in ONE rolled-back transaction as the database owner
 * and switches to the impersonated request only for the statement under test.
 * Synthetic fixtures only (SYN-* deals, @example.test users).
 */

/**
 * On real Postgres (CI job "supabase-integration", TEST_DATABASE_URL) test
 * files run in parallel against one database. Finance scenarios lock the same
 * fixture deal heads, policy head and receipt counter inside long rolled-back
 * transactions, so finance verification files take one session advisory lock
 * and run one after another instead of deadlocking each other.
 */
const FINANCE_DB_TEST_LOCK = 5_000_000_001n;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [FINANCE_DB_TEST_LOCK.toString()]);
});
afterAll(async () => {
  await db?.close();
});

const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur }; // gets an accounts membership per test
const OWNER: Actor = { userId: U.salesDelhiA }; // owns SYN-DEL-001
const SALES_B: Actor = { userId: U.salesDelhiB };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const ADMIN: Actor = { userId: U.adminJodhpur };
const ANON: Actor = { userId: null };
const ENTITY_B_USER: Actor = { userId: U.salesEntityB };

const FINANCE_TABLES = [
  'finance_live_settings',
  'finance_legal_limits',
  'finance_policy_heads',
  'finance_policy_versions',
  'finance_deal_heads',
  'finance_receipt_counters',
  'finance_command_results',
  'customer_billing_profiles',
  'accounts_booking_reviews',
  'customer_receipts',
  'cash_deposits',
  'cash_deposit_items',
  'cash_reconciliations',
  'finance_evidence',
  'finance_journal_entries',
  'finance_journal_lines',
  // B1.1b (20261119000200): advance claims follow the finance-table convention.
  'customer_payment_claims',
  // B1.1c (20261119000500): expense records follow the finance-table convention (review E5).
  'department_cost_entries',
];

const PUBLIC_RPCS = [
  'accounts_queue(text,text,integer)',
  'accounts_deal_lookup(text)',
  'accounts_deal_detail(uuid)',
  'accounts_cash_overview(uuid)',
  'finance_policy_get(uuid)',
  'finance_enabled_entities()',
  'accounts_billing_save(uuid,integer,jsonb,uuid)',
  'accounts_billing_verify(uuid,integer,uuid)',
  'accounts_review_return(uuid,text,uuid)',
  'accounts_review_approve(uuid,integer,uuid)',
  'receipt_record(uuid,jsonb,uuid)',
  'receipt_verify(uuid,uuid)',
  'receipt_reject(uuid,text,text,uuid)',
  'cheque_clear(uuid,date,uuid)',
  'cheque_mark(uuid,text,date,text,uuid)',
  'cheque_represent(uuid,uuid)',
  'receipt_reverse(uuid,text,text,uuid)',
  'cash_deposit_record(uuid,uuid[],date,text,uuid,uuid)',
  'cash_deposit_verify(uuid,uuid)',
  'cash_deposit_reject(uuid,text,uuid)',
  'cash_reconciliation_record(uuid,date,bigint,text,uuid)',
  'cash_reconciliation_verify(uuid,uuid)',
  'finance_policy_update(uuid,jsonb,timestamptz,text,uuid)',
  'finance_evidence_begin(text,uuid,text,text,text,integer,text,uuid)',
  'finance_evidence_finish(uuid,boolean)',
  'finance_evidence_authorize_download(uuid)',
  'finance_evidence_remove(uuid)',
  // B1.1b (20261119000200): advance claims.
  'payment_claim_report(uuid,jsonb,uuid)',
  'payment_claim_withdraw(uuid,integer,text,uuid)',
  'receipt_record_from_claim(uuid,jsonb,uuid)',
  'payment_claim_link_receipt(uuid,uuid,text,uuid)',
  'payment_claim_mark_not_received(uuid,text,uuid)',
  'deal_payment_claims(uuid)',
  'accounts_payment_claims(text,text,integer)',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  // On error the caller's savepoint rollback also reverts SET LOCAL ROLE.
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
/** Exact SQLSTATE and, when given, the exact error token. */
async function refused(actor: Actor, sql: string, params: unknown[], code: string, token?: string): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), {
    code,
    ...(token ? { message: new RegExp(`^${token}$`) } : {}),
  });
}

const today = () => istBusinessDate();
const rid = () => crypto.randomUUID();

async function idOf(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.query<{ id: string }>(sql, params))[0]!.id;
}
const hcEntity = () => idOf(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
const entityB = () => idOf(`select id from public.legal_entities where code = 'SYNTHETIC_B'`);
const branch = (code: string) => idOf(`select id from public.branches where code = $1`, [code]);

async function addMembership(userId: string, branchCode: string, role: string): Promise<void> {
  await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2`,
    [userId, branchCode, role],
  );
}
const addSecondAccounts = () => addMembership(U.visaJodhpur, 'JDH', 'accounts');

let refSeq = 0;
function bankFields(branchId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  refSeq += 1;
  return {
    mode: 'bank_transfer',
    amountPaise: '250000',
    receivedOn: today(),
    branchId,
    payerName: 'Synthetic Payer',
    payerMobile: '9876500001',
    reference: `SYNUTR${String(refSeq).padStart(6, '0')}`,
    ...extra,
  };
}
function cashFields(branchId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'cash',
    amountPaise: '100000',
    receivedOn: today(),
    branchId,
    collectorUserId: U.salesDelhiA,
    payerName: 'Synthetic Cash Payer',
    payerPan: 'ABCDE1234F',
    ...extra,
  };
}
let chequeSeq = 0;
function chequeFields(branchId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  chequeSeq += 1;
  return {
    mode: 'cheque',
    amountPaise: '300000',
    receivedOn: today(),
    branchId,
    payerName: 'Synthetic Cheque Payer',
    payerMobile: '9876500002',
    micrCode: '110002001',
    chequeNumber: String(100000 + chequeSeq),
    chequeDate: today(),
    accountPayee: true,
    ...extra,
  };
}

const RECORD_SQL = 'select public.receipt_record($1, $2::jsonb, $3) as r';
const record = async (actor: Actor, dealId: string, fields: Record<string, unknown>, requestId = rid()) =>
  one<{ outcome: string; id: string; receiptNo: string; status: string }>(
    actor, RECORD_SQL, [dealId, JSON.stringify(await withDestination(db, dealId, fields)), requestId]);

let shaSeq = 0;
/** Stored evidence through the RPCs (begin, Storage object, finish). */
async function storeEvidence(actor: Actor, targetType: 'receipt' | 'branch', targetId: string, kind: string): Promise<string> {
  shaSeq += 1;
  const sha = shaSeq.toString(16).padStart(64, 'a');
  const ev = await one<{ id: string; objectPath: string }>(
    actor,
    'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
    [targetType, targetId, kind, 'proof.pdf', 'application/pdf', 2048, sha, rid()],
  );
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`,
    [ev.objectPath],
  );
  const done = await one<{ status: string }>(actor, 'select public.finance_evidence_finish($1, true) as r', [ev.id]);
  expect(done.status).toBe('stored');
  return ev.id;
}

const verify = (actor: Actor, receiptId: string) =>
  one<{ status: string }>(actor, 'select public.receipt_verify($1, $2) as r', [receiptId, rid()]);

/** Confirmed synthetic booking on a deal owned by OWNER (Phase 3 path). Returns the booking version id. */
async function confirmedBooking(dealId: string = D.del001, owner: Actor = OWNER): Promise<string> {
  const opened = await one<{ versionId: string; rowVersion: number }>(owner, 'select public.booking_open_draft($1) as r', [dealId]);
  await one(owner, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [
    opened.versionId,
    opened.rowVersion,
    JSON.stringify({
      hotelName: 'Synthetic Hotel (fixture)',
      city: 'Synthetic City',
      checkIn: '2026-12-10',
      checkOut: '2026-12-13',
      rooms: 1,
      roomType: null,
      mealPlan: null,
      adults: 2,
      children: 0,
      inclusions: null,
      specialRequests: null,
      purchaseBudgetPaise: '4500000',
    }),
    '9876543',
  ]);
  const ev = await one<{ evidenceId: string; objectPath: string }>(
    owner,
    'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'f'.repeat(64)],
  );
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', 2048))`,
    [ev.objectPath],
  );
  await one(owner, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  const { contentHash } = await one<{ contentHash: string }>(owner, 'select public.booking_readiness($1) as r', [opened.versionId]);
  await one(owner, 'select public.booking_confirm($1, $2) as r', [opened.versionId, contentHash]);
  return opened.versionId;
}

const BILLING = {
  billingName: 'Synthetic Billing Name',
  addressLine1: '1 Synthetic Road',
  addressLine2: null,
  city: 'Synthetic City',
  stateCode: '07',
  postalCode: '110001',
  gstin: null,
};

// ---------------------------------------------------------------------------
// Schema, grants and direct table access
// ---------------------------------------------------------------------------

describe('schema: RLS, privileges and function grants', () => {
  it('every finance table has RLS, no permissive policy and no privilege for anon or authenticated', async () => {
    for (const table of FINANCE_TABLES) {
      const [row] = await db.query<{ rls: boolean; permissive: number; anon: boolean; auth: boolean }>(
        `select c.relrowsecurity as rls,
                (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                   and p.permissive = 'PERMISSIVE') as permissive,
                has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
                has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      expect(row, table).toEqual({ rls: true, permissive: 0, anon: false, auth: false });
    }
  });

  it('public RPCs are SECURITY DEFINER with an empty search_path; only authenticated may execute', async () => {
    for (const signature of PUBLIC_RPCS) {
      const [row] = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; pub: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p where p.oid = $1::regprocedure`,
        [`public.${signature}`],
      );
      expect(row, signature).toBeDefined();
      expect(row!.definer, signature).toBe(true);
      expect(row!.config ?? [], signature).toContain('search_path=""');
      expect({ anon: row!.anon, auth: row!.auth, pub: row!.pub }, signature).toEqual({ anon: false, auth: true, pub: false });
    }
  });

  it('no authz finance helper is executable by anon or authenticated', async () => {
    const rows = await db.query<{ name: string }>(
      `select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and (p.proname like 'finance%' or p.proname in ('can_accounts', 'can_manage_finance_policy'))
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
    );
    expect(rows).toEqual([]);
  });

  it('direct reads and writes on finance tables are refused for anon, Sales and Accounts', async () => {
    await asOwner(db, async () => {
      for (const actor of [ANON, OWNER, ACC, ADMIN]) {
        for (const table of FINANCE_TABLES) {
          await refused(actor, `select * from public.${table} limit 1`, [], '42501');
        }
        await refused(actor, `delete from public.customer_receipts`, [], '42501');
        await refused(actor, `update public.finance_live_settings set cash_live = true`, [], '42501');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// RPC denials per role
// ---------------------------------------------------------------------------

describe('RPC denials per role (contract section 4)', () => {
  const denied = async (actor: Actor, code: string, token?: string) => {
    const hc = await hcEntity();
    const jdh = await branch('JDH');
    await refused(actor, `select public.accounts_queue('all')`, [], code, token);
    await refused(actor, `select public.accounts_deal_lookup('SYN-DEL-001')`, [], code, token);
    await refused(actor, `select public.accounts_cash_overview($1)`, [hc], code, token);
    await refused(actor, RECORD_SQL, [D.del001, JSON.stringify(bankFields(jdh)), rid()], code, token);
    await refused(actor, 'select public.accounts_billing_save($1, 0, $2::jsonb, $3)', [D.del001, JSON.stringify(BILLING), rid()], code, token);
    await refused(actor, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8)',
      ['branch', jdh, 'deposit_slip', 'slip.pdf', 'application/pdf', 100, 'c'.repeat(64), rid()], code, token);
    await refused(actor, 'select public.cash_reconciliation_record($1, $2::date, 0, null, $3)', [jdh, today(), rid()], code, token);
  };

  it('anon has no execute privilege at all', async () => {
    await asOwner(db, async () => {
      await denied(ANON, '42501');
      await refused(ANON, 'select public.accounts_deal_detail($1)', [D.del001], '42501');
      await refused(ANON, 'select public.finance_enabled_entities()', [], '42501');
    });
  });

  it('Sales, Purchase, Manager and Super Admin alone are not_authorized; deal detail is invisible', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, PURCHASE, MANAGER, ADMIN]) {
        await denied(actor, '42501', 'not_authorized');
        expect(await one(actor, 'select public.accounts_deal_detail($1) as r', [D.del001]), actor.userId!).toBeNull();
      }
    });
  });

  it('mixed Accounts + Purchase in the same entity is not_authorized (Purchase never sees selling totals)', async () => {
    await asOwner(db, async () => {
      await addMembership(U.accountsJodhpur, 'DEL', 'purchase');
      await denied(ACC, '42501', 'not_authorized');
      expect(await one(ACC, 'select public.accounts_deal_detail($1) as r', [D.del001])).toBeNull();
      await refused(ACC, 'select public.finance_policy_get($1)', [await hcEntity()], '42501', 'not_authorized');
    });
  });

  it('AAL1 and inactive Accounts staff are not_authorized', async () => {
    await asOwner(db, async () => {
      const aal1: Actor = { userId: U.accountsJodhpur, aal: 'aal1' };
      await denied(aal1, '42501', 'not_authorized');
      await refused(aal1, 'select public.accounts_deal_detail($1)', [D.del001], '42501', 'not_authorized');
      await db.query(
        `update public.staff_profiles set status = 'inactive', deactivated_at = now(), deactivation_reason = 'SYNTHETIC test'
         where user_id = $1`,
        [U.accountsJodhpur],
      );
      await denied(ACC, '42501', 'not_authorized');
      await refused(ACC, 'select public.accounts_deal_detail($1)', [D.del001], '42501', 'not_authorized');
    });
  });

  it('an inactive accounts membership grants nothing', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'accounts'`, [
        U.accountsJodhpur,
      ]);
      await denied(ACC, '42501', 'not_authorized');
    });
  });

  it('Accounts in another finance-enabled entity cannot touch this entity, and the reverse', async () => {
    await asOwner(db, async () => {
      const b = await entityB();
      await db.query(`update public.legal_entities set status = 'enabled' where id = $1`, [b]);
      await db.query('select authz.finance_enable_entity($1)', [b]);
      await addMembership(U.salesEntityB, 'SB1', 'accounts');
      const sb1 = await branch('SB1');
      const jdh = await branch('JDH');
      // Entity B Accounts on a Holiday Chacha deal.
      await refused(ENTITY_B_USER, RECORD_SQL, [D.del001, JSON.stringify(bankFields(jdh)), rid()], '42501', 'not_authorized');
      expect(await one(ENTITY_B_USER, 'select public.accounts_deal_detail($1) as r', [D.del001])).toBeNull();
      expect(await one(ENTITY_B_USER, `select public.accounts_deal_lookup('SYN-DEL-001') as r`)).toBeNull();
      await refused(ENTITY_B_USER, 'select public.accounts_cash_overview($1)', [await hcEntity()], '42501', 'not_authorized');
      // Holiday Chacha Accounts on an entity B deal and branch.
      await refused(ACC, RECORD_SQL, [D.b001, JSON.stringify(bankFields(sb1)), rid()], '42501', 'not_authorized');
      expect(await one(ACC, 'select public.accounts_deal_detail($1) as r', [D.b001])).toBeNull();
      expect(await one(ACC, `select public.accounts_deal_lookup('SYN-B-001') as r`)).toBeNull();
      // A collecting branch of another entity is invalid input, never a cross-entity write.
      await refused(ACC, RECORD_SQL, [D.del001, JSON.stringify(bankFields(sb1)), rid()], '22023', 'invalid_input');
      // Queue of each viewer holds only its own entity.
      await record(ACC, D.del001, bankFields(jdh));
      await record(ENTITY_B_USER, D.b001, bankFields(sb1));
      // Real Postgres (CI db job) may hold other synthetic rows, so assert membership, not the whole list.
      const accQueue = (await one<{ items: Array<{ dealId: string }> }>(ACC, `select public.accounts_queue('all', null, 100) as r`)).items.map((q) => q.dealId);
      expect(accQueue).toContain(D.del001);
      expect(accQueue).not.toContain(D.b001);
      const bQueue = (await one<{ items: Array<{ dealId: string }> }>(ENTITY_B_USER, `select public.accounts_queue('all') as r`)).items.map((q) => q.dealId);
      expect(bQueue).toEqual([D.b001]);
    });
  });

  it('Accounts in a finance-disabled entity gets not_configured', async () => {
    await asOwner(db, async () => {
      const b = await entityB();
      await db.query(`update public.legal_entities set status = 'enabled' where id = $1`, [b]);
      await addMembership(U.salesEntityB, 'SB1', 'accounts');
      const sb1 = await branch('SB1');
      await refused(ENTITY_B_USER, RECORD_SQL, [D.b001, JSON.stringify(bankFields(sb1)), rid()], '55000', 'not_configured');
      await refused(ENTITY_B_USER, 'select public.accounts_cash_overview($1)', [b], '55000', 'not_configured');
      await refused(ENTITY_B_USER, `select public.accounts_queue('all')`, [], '55000', 'not_configured');
      expect(await one(ENTITY_B_USER, 'select public.finance_enabled_entities() as r')).toEqual([]);
    });
  });

  it('a disabled legal entity with a finance row is still not finance-enabled', async () => {
    await asOwner(db, async () => {
      const b = await entityB(); // status 'disabled' in the fixtures
      await db.query('select authz.finance_enable_entity($1)', [b]);
      await addMembership(U.salesEntityB, 'SB1', 'accounts');
      // A membership in a disabled entity is not active (authz.holds_active_role), so this is a permission refusal.
      await refused(ENTITY_B_USER, 'select public.accounts_cash_overview($1)', [b], '42501', 'not_authorized');
      expect(await one(ENTITY_B_USER, 'select public.finance_enabled_entities() as r')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Finance policy roles
// ---------------------------------------------------------------------------

describe('finance policy roles', () => {
  const update = (actor: Actor, entity: string, fields: Record<string, unknown> = { cashDepositDays: 2 }) =>
    run(actor, 'select public.finance_policy_update($1, $2::jsonb, null, $3, $4) as r', [
      entity,
      JSON.stringify(fields),
      'Synthetic policy change for tests',
      rid(),
    ]);

  it('Super Admin (no accounts role) may update; Super Admin + Accounts may not', async () => {
    await asOwner(db, async () => {
      const hc = await hcEntity();
      const [row] = await update(ADMIN, hc);
      expect((row as { r: { outcome: string } }).r.outcome).toBe('created');
      await addMembership(U.adminJodhpur, 'DEL', 'accounts');
      await expectDbError(db, () => update(ADMIN, hc), { code: '42501', message: /^not_authorized$/ });
    });
  });

  it('Accounts, Sales, Purchase, Manager, AAL1 Super Admin and anon cannot update the policy', async () => {
    await asOwner(db, async () => {
      const hc = await hcEntity();
      for (const actor of [ACC, OWNER, PURCHASE, MANAGER, { userId: U.adminJodhpur, aal: 'aal1' as const }]) {
        await expectDbError(db, () => update(actor, hc), { code: '42501', message: /^not_authorized$/ });
      }
      await expectDbError(db, () => update(ANON, hc), { code: '42501' });
    });
  });

  it('Super Admin alone gets no Accounts data; Super Admin + Accounts gets no policy edit but does get Accounts', async () => {
    await asOwner(db, async () => {
      const hc = await hcEntity();
      const page = await one<{ canEdit: boolean }>(ADMIN, 'select public.finance_policy_get($1) as r', [hc]);
      expect(page.canEdit).toBe(true);
      await refused(ADMIN, `select public.accounts_queue('all')`, [], '42501', 'not_authorized');
      await addMembership(U.adminJodhpur, 'DEL', 'accounts');
      const again = await one<{ canEdit: boolean }>(ADMIN, 'select public.finance_policy_get($1) as r', [hc]);
      expect(again.canEdit).toBe(false);
      expect(Array.isArray((await one<{ items: unknown }>(ADMIN, `select public.accounts_queue('all') as r`)).items)).toBe(true);
    });
  });

  it('nobody can change legal ceilings or live switches through the API', async () => {
    await asOwner(db, async () => {
      for (const actor of [ADMIN, ACC]) {
        await refused(actor, 'update public.finance_legal_limits set cash_cap_ceiling_paise = 99999999999', [], '42501');
        await refused(actor, 'update public.finance_live_settings set cash_live = true', [], '42501');
      }
      // A policy above the legal ceiling is refused even for the policy manager.
      await expectDbError(
        db,
        async () => update(ADMIN, await hcEntity(), { cashTripCapPaise: '20000000' }),
        { code: '22023', message: /^invalid_input$/ },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Deal conflicts and self-action
// ---------------------------------------------------------------------------

describe('deal conflict: owner or Sales assignee holding Accounts', () => {
  it('the deal owner with Accounts may record but not verify, reject or reverse', async () => {
    await asOwner(db, async () => {
      await addMembership(U.salesDelhiA, 'DEL', 'accounts');
      const jdh = await branch('JDH');
      const cash = await record(ACC, D.del001, cashFields(jdh));
      await refused(OWNER, 'select public.receipt_verify($1, $2)', [cash.id, rid()], '42501', 'not_self_approval');
      await refused(OWNER, 'select public.receipt_reject($1, $2, $3, $4)', [cash.id, 'data_error', 'Synthetic wrong amount', rid()], '42501', 'not_self_approval');
      // Recording on the own deal is allowed.
      const own = await record(OWNER, D.del001, cashFields(jdh, { payerPan: 'ZZZZZ9999Z', amountPaise: '1000' }));
      expect(own.status).toBe('recorded');
      await addSecondAccounts();
      await verify(ACC2, cash.id);
      await refused(OWNER, 'select public.receipt_reverse($1, $2, $3, $4)', [cash.id, 'data_error', 'Synthetic wrong amount', rid()], '42501', 'not_self_approval');
      const detail = await one<{ receipts: Array<{ receiptId: string; actions: Record<string, string | null> }> }>(
        OWNER,
        'select public.accounts_deal_detail($1) as r',
        [D.del001],
      );
      const actions = detail.receipts.find((r) => r.receiptId === cash.id)!.actions;
      expect(actions.reverse).toBe('deal_conflict');
    });
  });

  it('an active Sales assignee with Accounts is refused on verify; an ended assignment is not a conflict', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const cash = await record(ACC, D.del001, cashFields(jdh));
      const [a] = await db.query<{ id: string }>(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
         select d.id, d.legal_entity_id, $2, 'sales', $3 from public.deals d where d.id = $1 returning id`,
        [D.del001, U.visaJodhpur, U.adminJodhpur],
      );
      await refused(ACC2, 'select public.receipt_verify($1, $2)', [cash.id, rid()], '42501', 'not_self_approval');
      await db.query('update public.deal_assignments set ended_at = now() where id = $1', [a!.id]);
      expect((await verify(ACC2, cash.id)).status).toBe('verified');
    });
  });

  it('the booking confirmer and the deal owner cannot approve the Accounts review', async () => {
    await asOwner(db, async () => {
      const versionId = await confirmedBooking();
      await addMembership(U.salesDelhiA, 'DEL', 'accounts');
      const saved = await one<{ rowVersion: number }>(ACC, 'select public.accounts_billing_save($1, 0, $2::jsonb, $3) as r', [
        D.del001,
        JSON.stringify(BILLING),
        rid(),
      ]);
      // The editor may verify their own billing entry (owner decision, data-quality step).
      await one(ACC, 'select public.accounts_billing_verify($1, $2, $3) as r', [D.del001, saved.rowVersion, rid()]);
      await refused(OWNER, 'select public.accounts_review_approve($1, 0, $2)', [versionId, rid()], '42501', 'not_self_approval');
      const approved = await one<{ outcome: string }>(ACC, 'select public.accounts_review_approve($1, 0, $2) as r', [versionId, rid()]);
      expect(approved.outcome).toBe('updated');
    });
  });
});

describe('self-action is refused for every transition', () => {
  it('verify and reject: the recorder cannot', async () => {
    await asOwner(db, async () => {
      const jdh = await branch('JDH');
      const bank = await record(ACC, D.del001, bankFields(jdh));
      await storeEvidence(ACC, 'receipt', bank.id, 'bank_proof');
      await refused(ACC, 'select public.receipt_verify($1, $2)', [bank.id, rid()], '42501', 'not_self_approval');
      await refused(ACC, 'select public.receipt_reject($1, $2, $3, $4)', [bank.id, 'not_received', 'Synthetic not in bank', rid()], '42501', 'not_self_approval');
    });
  });

  it('reverse: the verifier cannot; the recorder may when another person verified', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const a = await record(ACC, D.del001, bankFields(jdh));
      await storeEvidence(ACC, 'receipt', a.id, 'bank_proof');
      await verify(ACC2, a.id);
      await refused(ACC2, 'select public.receipt_reverse($1, $2, $3, $4)', [a.id, 'bank_return', 'Synthetic bank return', rid()], '42501', 'not_self_approval');
      const reversed = await one<{ status: string }>(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [
        a.id,
        'bank_return',
        'Synthetic bank return',
        rid(),
      ]);
      expect(reversed.status).toBe('reversed');
    });
  });

  it('cheque clear, mark and re-present: the recorder cannot; reverse: neither verifier nor clearer can', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const chq = await record(ACC, D.del001, chequeFields(jdh));
      await storeEvidence(ACC, 'receipt', chq.id, 'cheque_image');
      expect((await verify(ACC2, chq.id)).status).toBe('pending_clearance');
      await storeEvidence(ACC2, 'receipt', chq.id, 'bank_proof');
      await refused(ACC, 'select public.cheque_clear($1, $2::date, $3)', [chq.id, today(), rid()], '42501', 'not_self_approval');
      await refused(ACC, 'select public.cheque_mark($1, $2, $3::date, null, $4)', [chq.id, 'bounced', today(), rid()], '42501', 'not_self_approval');
      await one(ACC2, 'select public.cheque_mark($1, $2, $3::date, null, $4) as r', [chq.id, 'bounced', today(), rid()]);
      await storeEvidence(ACC2, 'receipt', chq.id, 'cheque_image');
      await refused(ACC, 'select public.cheque_represent($1, $2)', [chq.id, rid()], '42501', 'not_self_approval');
      await one(ACC2, 'select public.cheque_represent($1, $2) as r', [chq.id, rid()]);
      await storeEvidence(ACC2, 'receipt', chq.id, 'bank_proof');
      await one(ACC2, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()]);
      // ACC2 verified and cleared; ACC recorded. Only a third Accounts person may reverse.
      await refused(ACC2, 'select public.receipt_reverse($1, $2, $3, $4)', [chq.id, 'bank_return', 'Synthetic cheque returned', rid()], '42501', 'not_self_approval');
      await addMembership(U.salesAhmedabad, 'AMD', 'accounts');
      const third: Actor = { userId: U.salesAhmedabad };
      expect((await one<{ status: string }>(third, 'select public.receipt_reverse($1, $2, $3, $4) as r', [chq.id, 'bank_return', 'Synthetic cheque returned', rid()])).status).toBe('reversed');
    });
  });

  it('cheque reverse: the clearer cannot even when someone else verified', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      await addMembership(U.salesAhmedabad, 'AMD', 'accounts');
      const third: Actor = { userId: U.salesAhmedabad };
      const jdh = await branch('JDH');
      const chq = await record(ACC, D.del001, chequeFields(jdh));
      await storeEvidence(ACC, 'receipt', chq.id, 'cheque_image');
      await verify(ACC2, chq.id);
      await storeEvidence(third, 'receipt', chq.id, 'bank_proof');
      await one(third, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()]);
      await refused(third, 'select public.receipt_reverse($1, $2, $3, $4)', [chq.id, 'bank_return', 'Synthetic cheque returned', rid()], '42501', 'not_self_approval');
      // The recorder did not verify or clear, so the recorder may reverse.
      expect((await one<{ status: string }>(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [chq.id, 'bank_return', 'Synthetic cheque returned', rid()])).status).toBe('reversed');
    });
  });

  it('deposit verify and reject, and reconciliation verify: the recorder cannot', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const cash = await record(ACC, D.del001, cashFields(jdh));
      await verify(ACC2, cash.id);
      const slip = await storeEvidence(ACC, 'branch', jdh, 'deposit_slip');
      const dep = await one<{ id: string }>(ACC, 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r', [
        jdh,
        [cash.id],
        today(),
        'SYN-DEP-0001',
        slip,
        rid(),
      ]);
      await refused(ACC, 'select public.cash_deposit_verify($1, $2)', [dep.id, rid()], '42501', 'not_self_approval');
      await refused(ACC, 'select public.cash_deposit_reject($1, $2, $3)', [dep.id, 'Synthetic slip unreadable', rid()], '42501', 'not_self_approval');
      await one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()]);

      const rec = await one<{ id: string }>(ACC, 'select public.cash_reconciliation_record($1, $2::date, $3::bigint, null, $4) as r', [
        jdh,
        today(),
        '0',
        rid(),
      ]);
      await refused(ACC, 'select public.cash_reconciliation_verify($1, $2)', [rec.id, rid()], '42501', 'not_self_approval');
      expect((await one<{ status: string }>(ACC2, 'select public.cash_reconciliation_verify($1, $2) as r', [rec.id, rid()])).status).toBe('verified');
    });
  });
});

// ---------------------------------------------------------------------------
// What Accounts must never read
// ---------------------------------------------------------------------------

describe('Accounts never gains Leads, supplier bank details, audit or Purchase reads', () => {
  it('no Lead rows, no supplier bank table, no audit rows, no Purchase workspace', async () => {
    await asOwner(db, async () => {
      const leads = await run<{ id: string }>(ACC, 'select id from public.crm_leads').catch((e: { code?: string }) => {
        expect(e.code).toBe('42501');
        return [];
      });
      expect(leads).toEqual([]);
      await refused(ACC, 'select * from public.supplier_beneficiary_revisions', [], '42501');
      const audit = await run<{ id: string }>(ACC, `select id from public.audit_events where action like 'finance.%'`).catch(
        (e: { code?: string }) => {
          expect(e.code).toBe('42501');
          return [];
        },
      );
      expect(audit).toEqual([]);
    });
  });

  it('deal detail of another entity and lookup across entities return nothing', async () => {
    await asOwner(db, async () => {
      expect(await one(ACC, 'select public.accounts_deal_detail($1) as r', [D.b001])).toBeNull();
      expect(await one(ACC, `select public.accounts_deal_lookup('SYN-B-001') as r`)).toBeNull();
      const found = await one<{ dealId: string } | null>(ACC, `select public.accounts_deal_lookup('SYN-DEL-002') as r`);
      expect(found?.dealId).toBe(D.del002);
    });
  });

  it('Sales never sees Accounts results through any finance read', async () => {
    await asOwner(db, async () => {
      const jdh = await branch('JDH');
      await record(ACC, D.del001, bankFields(jdh));
      expect(await one(OWNER, 'select public.accounts_deal_detail($1) as r', [D.del001])).toBeNull();
      await refused(SALES_B, `select public.accounts_queue('all')`, [], '42501', 'not_authorized');
    });
  });
});
