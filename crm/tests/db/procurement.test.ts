import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 4 Purchase hotel procurement: database contract
 * (docs/implementation/history/phase-4/contract.md, acceptance P4-01..P4-10).
 *
 * Every scenario runs in ONE rolled-back transaction as the database owner and
 * switches to the impersonated request only for the statement under test.
 * PGlite is a single connection, so true parallel claims and cost proposals
 * run against real Postgres in tests/supabase/procurement.real.test.ts; here
 * the sequential half is proven (stale expected versions, repeated request
 * ids, the loser of the row lock seeing the committed state).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const OWNER: Actor = { userId: U.salesDelhiA };
const MANAGER: Actor = { userId: U.managerDelhi }; // manager of the deal's branch (DEL)
const MANAGER_OTHER_BRANCH: Actor = { userId: U.managerAhmedabad }; // manager in the entity, other branch
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const PURCHASE_2: Actor = { userId: U.visaJodhpur }; // given a purchase membership per test
const ADMIN: Actor = { userId: U.adminJodhpur };
const ANON: Actor = { userId: null };
const OTHER_ENTITY: Actor = { userId: U.salesEntityB };

const SELLING = '9876543';
const BUDGET = '4500000';
const SHA = 'b'.repeat(64);
const FACTS = {
  hotelName: 'Synthetic Hotel (fixture)',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 2,
  roomType: 'Synthetic Deluxe',
  mealPlan: 'Breakfast',
  adults: 3,
  children: 1,
  inclusions: 'Synthetic airport pickup',
  specialRequests: null,
  purchaseBudgetPaise: BUDGET,
};
const SUPPLIER = {
  name: 'Synthetic Stays Ltd',
  serviceTypes: ['hotel'],
  city: 'Synthetic City',
  contactName: 'Synthetic Desk',
  contactPhone: '+91 00000 00000',
  contactEmail: 'desk@example.test',
  paymentTerms: 'Synthetic: 50% at confirmation',
};

const PROCUREMENT_TABLES = [
  'procurement_settings',
  'suppliers',
  'supplier_beneficiary_revisions',
  'purchase_quotes',
  'purchase_cost_versions',
  'purchase_evidence',
  'purchase_cost_approvals',
];

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
async function refused(actor: Actor, sql: string, params: unknown[], code: string, token?: string): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), {
    code,
    ...(token ? { message: new RegExp(`^${token}$`) } : {}),
  });
}

const entityId = async () =>
  (await db.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;

/** Confirmed synthetic hotel booking -> one task (Phase 3 path). */
async function confirmedTask(owner: Actor = OWNER, dealId: string = D.del001): Promise<string> {
  const opened = await one<{ versionId: string; rowVersion: number }>(owner, 'select public.booking_open_draft($1) as r', [dealId]);
  await one(owner, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [
    opened.versionId,
    opened.rowVersion,
    JSON.stringify(FACTS),
    SELLING,
  ]);
  const ev = await one<{ evidenceId: string; objectPath: string }>(
    owner,
    'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'a'.repeat(64)],
  );
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', 2048))`,
    [ev.objectPath],
  );
  await one(owner, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  const { contentHash } = await one<{ contentHash: string }>(owner, 'select public.booking_readiness($1) as r', [opened.versionId]);
  const { taskId } = await one<{ taskId: string }>(owner, 'select public.booking_confirm($1, $2) as r', [opened.versionId, contentHash]);
  return taskId;
}

async function claimedTask(actor: Actor = PURCHASE, owner: Actor = OWNER, dealId: string = D.del001): Promise<string> {
  const taskId = await confirmedTask(owner, dealId);
  await one(actor, 'select public.purchase_task_claim($1) as r', [taskId]);
  return taskId;
}

async function addSecondPurchase(): Promise<void> {
  await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`,
    [U.visaJodhpur],
  );
}

const createSupplier = async (actor: Actor = PURCHASE, fields: Record<string, unknown> = SUPPLIER) =>
  one<{ supplierId: string; rowVersion: number }>(actor, 'select public.supplier_create($1, $2::jsonb) as r', [
    await entityId(),
    JSON.stringify(fields),
  ]);

const QUOTE_SQL = 'select public.purchase_quote_add($1, $2, $3::jsonb) as r';
const addQuote = (actor: Actor, taskId: string, supplierId: string, requestId: string = crypto.randomUUID(), cost = '4000000') =>
  one<{ quoteId: string; created: boolean }>(actor, QUOTE_SQL, [
    taskId,
    requestId,
    JSON.stringify({
      supplierId,
      hotelName: 'Synthetic Hotel (fixture)',
      roomType: 'Synthetic Deluxe',
      mealPlan: 'Breakfast',
      quotedCostPaise: cost,
      holdUntil: '2026-11-30',
      cancellationTerms: 'Synthetic: free until 7 days before arrival',
    }),
  ]);

const COST_SQL = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
const propose = (actor: Actor, taskId: string, quoteId: string, expected: number, amount = '4000000', requestId: string = crypto.randomUUID()) =>
  one<{ versionNo: number; created: boolean }>(actor, COST_SQL, [taskId, quoteId, expected, amount, '2026-11-25', null, requestId]);

const BEGIN_SQL = 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r';
const begin = (actor: Actor, taskId: string, kind = 'supplier_confirmation', size = 2048) =>
  one<{ evidenceId: string; objectPath: string }>(actor, BEGIN_SQL, [taskId, kind, 'supplier.pdf', 'application/pdf', size, SHA]);
const finish = (actor: Actor, evidenceId: string, ok: boolean) =>
  one<{ evidenceId: string; status: string }>(actor, 'select public.purchase_evidence_finish($1, $2) as r', [evidenceId, ok]);
async function putObject(objectPath: string, size = 2048): Promise<void> {
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', $2::bigint))`,
    [objectPath, size],
  );
}
async function storeProof(actor: Actor, taskId: string, kind = 'supplier_confirmation') {
  const ev = await begin(actor, taskId, kind);
  await putObject(ev.objectPath);
  expect(await finish(actor, ev.evidenceId, true)).toEqual({ evidenceId: ev.evidenceId, status: 'stored' });
  return ev;
}

const CONFIRM_SQL = 'select public.purchase_supplier_confirm($1, $2, $3) as r';
const confirmSupplier = (actor: Actor, taskId: string, expected: number, reference = 'SYN-CONF-0001') =>
  one<{ outcome: string; taskId: string }>(actor, CONFIRM_SQL, [taskId, expected, reference]);
const workspace = (actor: Actor, taskId: string) =>
  one<Record<string, unknown> | null>(actor, 'select public.purchase_workspace($1) as r', [taskId]);

/** Claimed task with supplier, quote, one proposed cost and stored confirmation proof. */
async function readyTask() {
  const taskId = await claimedTask();
  const { supplierId } = await createSupplier();
  const { quoteId } = await addQuote(PURCHASE, taskId, supplierId);
  await propose(PURCHASE, taskId, quoteId, 0);
  const proof = await storeProof(PURCHASE, taskId);
  return { taskId, supplierId, quoteId, proof };
}

// ---------------------------------------------------------------------------

describe('schema, grants and gate defaults', () => {
  it('creates the procurement tables with RLS, the session policy and no write grants', async () => {
    await asOwner(db, async () => {
      const rows = await db.query<{ relname: string; rls: boolean; policies: string[] }>(
        `select c.relname, c.relrowsecurity as rls,
                coalesce(array_agg(p.policyname::text order by p.policyname) filter (where p.policyname is not null), '{}') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
         where n.nspname = 'public' and c.relname = any($1::text[])
         group by c.relname, c.relrowsecurity order by c.relname`,
        [PROCUREMENT_TABLES],
      );
      expect(rows).toHaveLength(PROCUREMENT_TABLES.length);
      for (const r of rows) {
        expect(r.rls, r.relname).toBe(true);
        expect(r.policies, r.relname).toContain('require_valid_session');
      }
      expect(rows.find((r) => r.relname === 'supplier_beneficiary_revisions')!.policies).toEqual(['require_valid_session']);
      const privs = await db.query<{ t: string; anon: boolean; auth_select: boolean; auth_write: boolean; svc_write: boolean }>(
        `select t,
           has_table_privilege('anon', 'public.' || t, 'select') as anon,
           has_table_privilege('authenticated', 'public.' || t, 'select') as auth_select,
           has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete') as auth_write,
           has_table_privilege('service_role', 'public.' || t, 'insert,update,delete') as svc_write
         from unnest($1::text[]) t`,
        [PROCUREMENT_TABLES],
      );
      for (const p of privs) {
        expect(p.anon, p.t).toBe(false);
        expect(p.auth_write, p.t).toBe(false);
        expect(p.svc_write, p.t).toBe(false);
        expect(p.auth_select, p.t).toBe(p.t !== 'supplier_beneficiary_revisions');
      }
      const [gate] = await db.query<{ live: boolean }>('select live_supplier_confirmation_enabled as live from public.procurement_settings');
      expect(gate!.live).toBe(false);
    });
  });

  it('anon cannot execute any Phase 4 command', async () => {
    await asOwner(db, async () => {
      await refused(ANON, 'select public.supplier_list() as r', [], '42501');
      await refused(ANON, 'select public.purchase_workspace($1) as r', [crypto.randomUUID()], '42501');
      await refused(ANON, CONFIRM_SQL, [crypto.randomUUID(), 1, 'X'], '42501');
    });
  });
});

describe('P4-01 / P4-02 visibility', () => {
  it('Sales, admin, another branch manager and another entity read no Purchase rows; Purchase reads no bank table', async () => {
    await asOwner(db, async () => {
      const { taskId, supplierId } = await readyTask();
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
        supplierId,
        crypto.randomUUID(),
        JSON.stringify({ accountHolder: 'Synthetic Stays Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' }),
      ]);
      const tables = ['suppliers', 'purchase_quotes', 'purchase_cost_versions', 'purchase_evidence', 'purchase_cost_approvals'];
      for (const actor of [OWNER, ADMIN, OTHER_ENTITY, MANAGER_OTHER_BRANCH]) {
        for (const t of tables) {
          expect(await run(actor, `select 1 as x from public.${t}`), `${t} ${actor.userId}`).toEqual([]);
        }
        expect(await workspace(actor, taskId)).toBeNull();
      }
      for (const actor of [OWNER, ADMIN, OTHER_ENTITY]) {
        expect(await one(actor, 'select public.supplier_list() as r')).toEqual([]);
        expect(await one(actor, 'select public.supplier_get($1) as r', [supplierId])).toBeNull();
      }
      // A1: managers in the entity review suppliers (read-only, last 4 digits only).
      const reviewed = await one<{ canEdit: boolean; beneficiaries: Array<{ accountLast4: string }> }>(
        MANAGER_OTHER_BRANCH, 'select public.supplier_get($1) as r', [supplierId]);
      expect(reviewed.canEdit).toBe(false);
      expect(reviewed.beneficiaries[0]!.accountLast4).toBe('2222');
      expect(JSON.stringify(reviewed)).not.toContain('000011112222');
      // A1: the manager of the deal's branch reads the workspace and its rows, read-only.
      const managed = await workspace(MANAGER, taskId);
      expect(managed!.canWork).toBe(false);
      expect(managed!.canRelease).toBe(false);
      expect(managed!.canReassign).toBe(true);
      expect(JSON.stringify(managed)).not.toMatch(new RegExp(`${SELLING}|selling|margin|acceptance`, 'i'));
      expect(await run(MANAGER, 'select 1 as x from public.purchase_quotes')).toHaveLength(1);
      expect(await run(MANAGER, 'select 1 as x from public.suppliers')).toEqual([]);
      for (const actor of [MANAGER, MANAGER_OTHER_BRANCH]) {
        await refused(actor, 'select * from public.supplier_beneficiary_revisions', [], '42501');
      }
      await refused(PURCHASE, 'select * from public.supplier_beneficiary_revisions', [], '42501');
      // Purchase still reads no booking commercials or acceptance proof.
      for (const t of ['booking_version_commercials', 'booking_evidence', 'deal_commercials', 'booking_versions']) {
        expect(await run(PURCHASE, `select 1 as x from public.${t}`), t).toEqual([]);
      }
    });
  });

  it('the Purchase workspace carries the budget but never the selling total, margin or acceptance proof', async () => {
    await asOwner(db, async () => {
      const { taskId } = await readyTask();
      const ws = await workspace(PURCHASE, taskId);
      const text = JSON.stringify(ws);
      expect(text).not.toContain(SELLING);
      expect(text).not.toMatch(/selling|margin|commercial|acceptance/i);
      expect((ws!.task as Record<string, unknown>).purchaseBudgetPaise).toBe(BUDGET);
      expect(ws!.canWork).toBe(true);
      expect(ws!.issues).toEqual([]);
    });
  });

  it('supplier_get returns only the last 4 account digits and audit rows hold no bank values', async () => {
    await asOwner(db, async () => {
      const { supplierId } = await createSupplier();
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
        supplierId,
        crypto.randomUUID(),
        JSON.stringify({ accountHolder: 'Synthetic Stays Ltd', bankName: 'Synthetic Bank', ifsc: 'synb0000001', accountNumber: '000011112222' }),
      ]);
      const got = await one<{ beneficiaries: Array<Record<string, unknown>> }>(PURCHASE, 'select public.supplier_get($1) as r', [supplierId]);
      expect(got.beneficiaries).toHaveLength(1);
      expect(got.beneficiaries[0]).toMatchObject({ revisionNo: 1, accountLast4: '2222', ifsc: 'SYNB0000001', status: 'unverified' });
      expect(JSON.stringify(got)).not.toContain('000011112222');
      const audit = await db.query<{ details: unknown }>(`select details from public.audit_events where action like 'supplier.%'`);
      expect(JSON.stringify(audit)).not.toContain('000011112222');
      expect(JSON.stringify(audit)).not.toContain('desk@example.test');
    });
  });
});

describe('P4-03 authority', () => {
  it('only the assignee writes; another Purchase person reads the workspace but is refused', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const { taskId, quoteId } = await readyTask();
      expect((await workspace(PURCHASE_2, taskId))!.canWork).toBe(false);
      await refused(PURCHASE_2, QUOTE_SQL, [taskId, crypto.randomUUID(), '{}'], '42501', 'not_authorized');
      await refused(PURCHASE_2, COST_SQL, [taskId, quoteId, 1, '1000', null, null, crypto.randomUUID()], '42501', 'not_authorized');
      await refused(PURCHASE_2, BEGIN_SQL, [taskId, 'quote', 'q.pdf', 'application/pdf', 10, SHA], '42501', 'not_authorized');
      await refused(PURCHASE_2, CONFIRM_SQL, [taskId, 1, 'SYN'], '42501', 'not_authorized');
      await refused(PURCHASE_2, 'select public.purchase_task_claim($1) as r', [taskId], '40001', 'task_conflict');
    });
  });

  it('an unclaimed task cannot be worked, and Sales/manager are refused everywhere', async () => {
    await asOwner(db, async () => {
      const taskId = await confirmedTask();
      const { supplierId } = await createSupplier();
      await refused(PURCHASE, QUOTE_SQL, [taskId, crypto.randomUUID(), JSON.stringify({ supplierId })], '42501', 'not_authorized');
      for (const actor of [OWNER, MANAGER, ADMIN]) {
        await refused(actor, 'select public.supplier_create($1, $2::jsonb) as r', [await entityId(), JSON.stringify(SUPPLIER)], '42501', 'not_authorized');
        await refused(actor, CONFIRM_SQL, [taskId, 1, 'SYN'], '42501', 'not_authorized');
      }
    });
  });
});

describe('P4-04 / P4-05 idempotency and concurrency (sequential half)', () => {
  it('repeated request ids return the same quote, cost version and beneficiary revision', async () => {
    await asOwner(db, async () => {
      const taskId = await claimedTask();
      const { supplierId } = await createSupplier();
      const rq = crypto.randomUUID();
      const first = await addQuote(PURCHASE, taskId, supplierId, rq);
      expect(await addQuote(PURCHASE, taskId, supplierId, rq)).toEqual({ quoteId: first.quoteId, created: false });

      const rc = crypto.randomUUID();
      expect(await propose(PURCHASE, taskId, first.quoteId, 0, '4000000', rc)).toEqual({ versionNo: 1, created: true });
      // Same request again: same version, even though the expected version is now stale.
      expect(await propose(PURCHASE, taskId, first.quoteId, 0, '4000000', rc)).toEqual({ versionNo: 1, created: false });

      const rb = crypto.randomUUID();
      const fields = JSON.stringify({ accountHolder: 'Synthetic', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '123456' });
      const b1 = await one<{ revisionNo: number; created: boolean }>(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, rb, fields]);
      const b2 = await one<{ revisionNo: number; created: boolean }>(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, rb, fields]);
      expect(b1).toMatchObject({ revisionNo: 1, created: true });
      expect(b2).toMatchObject({ revisionNo: 1, created: false });

      const counts = await db.query<{ q: string; c: string }>(
        `select (select count(*) from public.purchase_quotes where task_id = $1)::text as q,
                (select count(*) from public.purchase_cost_versions where task_id = $1)::text as c`,
        [taskId],
      );
      expect(counts[0]).toEqual({ q: '1', c: '1' });
    });
  });

  it('a stale expected cost version is version_changed; history is kept in order', async () => {
    await asOwner(db, async () => {
      const taskId = await claimedTask();
      const { supplierId } = await createSupplier();
      const { quoteId } = await addQuote(PURCHASE, taskId, supplierId);
      await propose(PURCHASE, taskId, quoteId, 0, '4200000');
      await refused(PURCHASE, COST_SQL, [taskId, quoteId, 0, '4100000', null, null, crypto.randomUUID()], '40001', 'version_changed');
      await propose(PURCHASE, taskId, quoteId, 1, '4100000');
      const ws = await workspace(PURCHASE, taskId);
      expect((ws!.costVersions as Array<{ versionNo: number; amountPaise: string; stage: string }>).map((c) => [c.versionNo, c.amountPaise, c.stage])).toEqual([
        [2, '4100000', 'proposed'],
        [1, '4200000', 'proposed'],
      ]);
    });
  });

  it('a duplicate supplier name in the entity is supplier_exists; stale supplier edits are version_changed', async () => {
    await asOwner(db, async () => {
      const { supplierId } = await createSupplier();
      await refused(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r',
        [await entityId(), JSON.stringify({ ...SUPPLIER, name: 'synthetic stays ltd' })], '23505', 'supplier_exists');
      const upd = 'select public.supplier_update($1, $2, $3::jsonb) as r';
      expect(await one(PURCHASE, upd, [supplierId, 1, JSON.stringify({ ...SUPPLIER, city: 'Other Synthetic City' })]))
        .toEqual({ supplierId, rowVersion: 2 });
      await refused(PURCHASE, upd, [supplierId, 1, JSON.stringify(SUPPLIER)], '40001', 'version_changed');
      await refused(PURCHASE, upd, [supplierId, 2, JSON.stringify({ ...SUPPLIER, unknownKey: 1 })], '22023', 'invalid_input');
      // No command sets verified (P4-D1 open).
      await refused(PURCHASE, upd, [supplierId, 2, JSON.stringify({ ...SUPPLIER, verificationStatus: 'verified' })], '22023', 'invalid_input');
    });
  });
});

describe('P4-06 / P4-07 supplier confirmation', () => {
  it('without stored confirmation proof it is not_ready, and the workspace lists why', async () => {
    await asOwner(db, async () => {
      const taskId = await claimedTask();
      const { supplierId } = await createSupplier();
      const { quoteId } = await addQuote(PURCHASE, taskId, supplierId);
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual(['missing_cost', 'missing_supplier_confirmation_proof']);
      await propose(PURCHASE, taskId, quoteId, 0);
      await storeProof(PURCHASE, taskId, 'quote'); // a quote file is not confirmation proof
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN-1'], '55000', 'not_ready');
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual(['missing_supplier_confirmation_proof']);
    });
  });

  it('over the approved Purchase budget is over_budget (P4-D2 open)', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId } = await readyTask();
      await propose(PURCHASE, taskId, quoteId, 1, String(Number(BUDGET) + 1));
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 2, 'SYN-1'], '55000', 'over_budget');
    });
  });

  it('creates one committed cost, selects the quote, freezes the task; repeat is existing, a different reference conflicts', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId } = await readyTask();
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 0, 'SYN-1'], '40001', 'version_changed');
      expect(await confirmSupplier(PURCHASE, taskId, 1, 'SYN-1')).toEqual({ outcome: 'created', taskId });
      expect(await confirmSupplier(PURCHASE, taskId, 1, 'SYN-1')).toEqual({ outcome: 'existing', taskId });
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN-2'], '40001', 'task_conflict');

      const ws = await workspace(PURCHASE, taskId);
      expect((ws!.task as { status: string }).status).toBe('supplier_confirmed');
      expect(ws!.canWork).toBe(false);
      expect(ws!.selectedQuoteId).toBe(quoteId);
      expect(ws!.supplierReference).toBe('SYN-1');
      const costs = ws!.costVersions as Array<{ versionNo: number; stage: string; payableStatus: string }>;
      expect(costs.map((c) => [c.versionNo, c.stage])).toEqual([[2, 'committed'], [1, 'proposed']]);
      expect(costs.every((c) => c.payableStatus === 'not_requested')).toBe(true);
      const outbox = await db.query<{ payload: Record<string, unknown> }>(
        `select payload from public.outbox_events where event_type = 'fulfilment.supplier_confirmed' and aggregate_id = $1`,
        [taskId],
      );
      expect(outbox).toHaveLength(1);
      expect(Object.keys(outbox[0]!.payload).sort()).toEqual(['deal_id', 'service_purpose', 'task_id']);

      // Frozen: no more quotes, costs, files.
      await refused(PURCHASE, QUOTE_SQL, [taskId, crypto.randomUUID(), '{}'], '55000', 'already_confirmed');
      await refused(PURCHASE, COST_SQL, [taskId, quoteId, 2, '1000', null, null, crypto.randomUUID()], '55000', 'already_confirmed');
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'other', 'x.pdf', 'application/pdf', 10, SHA], '55000', 'already_confirmed');
    });
  });

  it('confirmation retries bind to the original proposal and its offer, not just the reference', async () => {
    await asOwner(db, async () => {
      const { taskId, supplierId, quoteId } = await readyTask();
      const alternate = await addQuote(PURCHASE, taskId, supplierId);
      await propose(PURCHASE, taskId, alternate.quoteId, 1, '3900000');
      expect(await confirmSupplier(PURCHASE, taskId, 2, 'SYN-IDENTITY')).toEqual({ outcome: 'created', taskId });
      // Proposal 1 names a different offer. Version 3 is the new committed cost.
      for (const version of [0, 1, 3, 99, null]) {
        await refused(PURCHASE, CONFIRM_SQL, [taskId, version, 'SYN-IDENTITY'], '40001', 'task_conflict');
      }
      // Exact retry still answers existing after the live switch is off.
      await db.exec(`update public.procurement_settings set live_supplier_confirmation_enabled = false`);
      expect(await confirmSupplier(PURCHASE, taskId, 2, '  SYN-IDENTITY  ')).toEqual({ outcome: 'existing', taskId });
      const costs = await db.query<{ version_no: number; quote_id: string; stage: string }>(
        `select version_no, quote_id, stage from public.purchase_cost_versions where task_id = $1 order by version_no`, [taskId],
      );
      expect(costs).toEqual([
        { version_no: 1, quote_id: quoteId, stage: 'proposed' },
        { version_no: 2, quote_id: alternate.quoteId, stage: 'proposed' },
        { version_no: 3, quote_id: alternate.quoteId, stage: 'committed' },
      ]);
      expect(await db.query(`select id from public.outbox_events where event_type = 'fulfilment.supplier_confirmed' and aggregate_id = $1`, [taskId])).toHaveLength(1);
    });
  });

  it('Sales sees supplier_confirmed status and time only (P4-10)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await readyTask();
      await confirmSupplier(PURCHASE, taskId, 1);
      const seen = await one<Record<string, unknown>>(OWNER, 'select public.purchase_task_get($1) as r', [taskId]);
      expect(seen.status).toBe('supplier_confirmed');
      expect(seen.supplierConfirmedAt).toEqual(expect.any(String));
      expect(JSON.stringify(seen)).not.toMatch(/SYN-CONF|Synthetic Stays|4000000|quote|supplierReference/);
      const panel = await one<{ task: { status: string } }>(OWNER, 'select public.booking_panel($1) as r', [D.del001]);
      expect(panel.task.status).toBe('supplier_confirmed');

      // Direct Data API reads of the task row: status and time only, never the
      // supplier's reference, the selected quote or who confirmed it.
      expect(
        await run(OWNER, 'select id, status, supplier_confirmed_at is not null as confirmed from public.fulfilment_tasks where id = $1', [taskId]),
      ).toEqual([{ id: taskId, status: 'supplier_confirmed', confirmed: true }]);
      for (const column of ['supplier_reference', 'selected_quote_id', 'supplier_confirmed_by']) {
        for (const actor of [OWNER, MANAGER, PURCHASE]) {
          await refused(actor, `select ${column} from public.fulfilment_tasks where id = $1`, [taskId], '42501');
        }
      }
      await refused(OWNER, 'select * from public.fulfilment_tasks where id = $1', [taskId], '42501');
      // Purchase still reads the reference through its workspace.
      expect((await workspace(PURCHASE, taskId))!.supplierReference).toBe('SYN-CONF-0001');
    });
  });
});

describe('P4-07 gate (P4-D7)', () => {
  it('environment unset refuses every task command; a synthetic task outside test is procurement_disabled', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId } = await readyTask();
      await db.query(`update public.deployment_settings set environment = 'staging'`);
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN'], '55000', 'procurement_disabled');
      await refused(PURCHASE, COST_SQL, [taskId, quoteId, 1, '1000', null, null, crypto.randomUUID()], '55000', 'procurement_disabled');
      await db.query(`update public.deployment_settings set environment = 'unset'`);
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN'], '55000', 'environment_unset');
      await refused(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r',
        [await entityId(), JSON.stringify({ ...SUPPLIER, name: 'Synthetic Two' })], '55000', 'environment_unset');
    });
  });
});

describe('P4-08 immutability outside commands', () => {
  it('cost versions, beneficiary revisions, quote facts and supplier-confirmed tasks refuse direct changes', async () => {
    await asOwner(db, async () => {
      const { taskId, supplierId, quoteId } = await readyTask();
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
        supplierId,
        crypto.randomUUID(),
        JSON.stringify({ accountHolder: 'Synthetic', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '123456' }),
      ]);
      const asOwnerFails = (sql: string, params: unknown[]) => expectDbError(db, () => db.query(sql, params), { code: '42501' });
      await asOwnerFails('update public.purchase_cost_versions set amount_paise = 1 where task_id = $1', [taskId]);
      await asOwnerFails('delete from public.purchase_cost_versions where task_id = $1', [taskId]);
      await asOwnerFails('update public.supplier_beneficiary_revisions set account_number = $2 where supplier_id = $1', [supplierId, '999999']);
      await asOwnerFails('update public.purchase_quotes set quoted_cost_paise = 1 where id = $1', [quoteId]);
      await confirmSupplier(PURCHASE, taskId, 1);
      await asOwnerFails(`update public.fulfilment_tasks set supplier_reference = 'changed' where id = $1`, [taskId]);
      await asOwnerFails(`update public.purchase_evidence set status = 'removed' where task_id = $1`, [taskId]);
    });
  });
});

describe('P4-09 private files (database half)', () => {
  it('finish without a Storage object is failed and does not count; the failed file can be removed and re-uploaded', async () => {
    await asOwner(db, async () => {
      const taskId = await claimedTask();
      const ev = await begin(PURCHASE, taskId);
      expect(await finish(PURCHASE, ev.evidenceId, true)).toEqual({ evidenceId: ev.evidenceId, status: 'failed' });
      // Wrong size in Storage also fails.
      const ev2 = await begin(PURCHASE, taskId);
      await putObject(ev2.objectPath, 999);
      expect(await finish(PURCHASE, ev2.evidenceId, true)).toMatchObject({ status: 'failed' });
      expect(await one(PURCHASE, 'select public.purchase_evidence_remove($1) as r', [ev.evidenceId])).toEqual({ evidenceId: ev.evidenceId, status: 'removed' });
      await storeProof(PURCHASE, taskId);
      const issues = (await workspace(PURCHASE, taskId))!.issues as string[];
      expect(issues).not.toContain('missing_supplier_confirmation_proof');
      expect(issues).not.toContain('evidence_upload_incomplete');
    });
  });

  it('an unfinished upload blocks confirmation; finish retries are idempotent; a retried confirmation is existing', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const { taskId } = await readyTask();
      // Unknown upload outcome: the row stays pending_upload and blocks confirmation.
      const pending = await begin(PURCHASE, taskId, 'quote');
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual(['evidence_upload_incomplete']);
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN-1'], '55000', 'not_ready');
      // Only the uploader finishes it.
      await refused(PURCHASE_2, 'select public.purchase_evidence_finish($1, $2) as r', [pending.evidenceId, true], '42501', 'not_authorized');
      await putObject(pending.objectPath);
      expect(await finish(PURCHASE, pending.evidenceId, true)).toEqual({ evidenceId: pending.evidenceId, status: 'stored' });
      // A retried finish (lost response) returns the stored row; a late failure report cannot demote it.
      expect(await finish(PURCHASE, pending.evidenceId, true)).toEqual({ evidenceId: pending.evidenceId, status: 'stored' });
      await refused(PURCHASE, 'select public.purchase_evidence_finish($1, $2) as r', [pending.evidenceId, false], '22023', 'invalid_input');
      // A failed row stays failed on a retried ok (the user removes it and uploads again).
      const failed = await begin(PURCHASE, taskId, 'other');
      expect(await finish(PURCHASE, failed.evidenceId, false)).toMatchObject({ status: 'failed' });
      await putObject(failed.objectPath);
      expect(await finish(PURCHASE, failed.evidenceId, true)).toMatchObject({ status: 'failed' });
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual([]);

      expect(await confirmSupplier(PURCHASE, taskId, 1, 'SYN-1')).toEqual({ outcome: 'created', taskId });
      // Retry after a lost response: stale expected version and surrounding spaces still answer existing.
      expect(await confirmSupplier(PURCHASE, taskId, 1, '  SYN-1 ')).toEqual({ outcome: 'existing', taskId });
      // Another Purchase person never gets existing; files are frozen.
      await refused(PURCHASE_2, CONFIRM_SQL, [taskId, 2, 'SYN-1'], '42501', 'not_authorized');
      await refused(PURCHASE, 'select public.purchase_evidence_remove($1) as r', [failed.evidenceId], '55000', 'already_confirmed');
      const committed = await db.query<{ n: string }>(
        `select count(*)::text as n from public.purchase_cost_versions where task_id = $1 and stage = 'committed'`,
        [taskId],
      );
      expect(committed[0]!.n).toBe('1');
    });
  });

  it('rejects bad metadata and an 11th file; downloads need a stored file and the Purchase role', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const taskId = await claimedTask();
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'quote', 'q.exe', 'application/x-msdownload', 10, SHA], '22023', 'evidence_rejected');
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'quote', '../q.pdf', 'application/pdf', 10, SHA], '22023', 'evidence_rejected');
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'quote', 'q.pdf', 'application/pdf', 4194305, SHA], '22023', 'evidence_rejected');
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'acceptance_message', 'q.pdf', 'application/pdf', 10, SHA], '22023', 'evidence_rejected');
      const pending = await begin(PURCHASE, taskId, 'quote');
      await refused(PURCHASE, 'select public.purchase_evidence_authorize_download($1) as r', [pending.evidenceId], 'P0002', 'not_found');
      const stored = await storeProof(PURCHASE, taskId, 'quote');
      // Another Purchase person may download (P3-D4 read); Sales may not.
      expect(await one(PURCHASE_2, 'select public.purchase_evidence_authorize_download($1) as r', [stored.evidenceId]))
        .toMatchObject({ objectPath: stored.objectPath, fileName: 'supplier.pdf' });
      await refused(OWNER, 'select public.purchase_evidence_authorize_download($1) as r', [stored.evidenceId], '42501', 'not_authorized');
      for (let i = 0; i < 8; i += 1) await begin(PURCHASE, taskId, 'other');
      await refused(PURCHASE, BEGIN_SQL, [taskId, 'other', 'x.pdf', 'application/pdf', 10, SHA], '22023', 'evidence_rejected');
    });
  });
});

// ---------------------------------------------------------------------------
// Amendment A1 (contract §9 owner answers): manager decisions, release, reassign
// ---------------------------------------------------------------------------

const VERIFY_SQL = 'select public.supplier_verify($1, $2) as r';
const APPROVE_BEN_SQL = 'select public.supplier_approve_beneficiary($1, $2) as r';
const APPROVE_COST_SQL = 'select public.purchase_cost_approve_over_budget($1, $2) as r';
const RELEASE_SQL = 'select public.purchase_task_release($1) as r';
const REASSIGN_SQL = 'select public.purchase_task_reassign($1, $2, $3) as r';
const UPDATE_SUPPLIER_SQL = 'select public.supplier_update($1, $2, $3::jsonb) as r';

/** Gives the Delhi manager a Purchase membership too (one person holding both roles). */
async function managerAlsoPurchase(): Promise<void> {
  await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`,
    [U.managerDelhi],
  );
}
const recordBank = (actor: Actor, supplierId: string, accountNumber = '000011112222') =>
  one<{ revisionNo: number }>(actor, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
    supplierId,
    crypto.randomUUID(),
    JSON.stringify({ accountHolder: 'Synthetic Stays Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber }),
  ]);
const supplierView = (actor: Actor, supplierId: string) =>
  one<Record<string, unknown> & { beneficiaries: Array<Record<string, unknown>> }>(actor, 'select public.supplier_get($1) as r', [supplierId]);
const activeAssignments = async (taskId: string) =>
  (
    await db.query<{ user_id: string }>(
      `select a.user_id from public.deal_assignments a join public.fulfilment_tasks t on t.deal_id = a.deal_id
       where t.id = $1 and a.assignment_kind = 'purchase' and a.ended_at is null order by a.user_id`,
      [taskId],
    )
  ).map((r) => r.user_id);

describe('A1 P4-D1 supplier verification', () => {
  it('only an entity manager verifies; repeat is existing; a stale version is version_changed; archived is refused', async () => {
    await asOwner(db, async () => {
      const { supplierId } = await createSupplier();
      for (const actor of [PURCHASE, OWNER, ADMIN, OTHER_ENTITY]) await refused(actor, VERIFY_SQL, [supplierId, 1], '42501', 'not_authorized');
      await refused(MANAGER_OTHER_BRANCH, VERIFY_SQL, [supplierId, 0], '40001', 'version_changed');
      expect(await one(MANAGER_OTHER_BRANCH, VERIFY_SQL, [supplierId, 1])).toEqual({ supplierId, rowVersion: 2, outcome: 'created' });
      expect(await one(MANAGER, VERIFY_SQL, [supplierId, 1])).toEqual({ supplierId, rowVersion: 2, outcome: 'existing' });
      const seen = await supplierView(PURCHASE, supplierId);
      expect(seen).toMatchObject({ verificationStatus: 'verified', verifiedByName: expect.any(String), verifiedAt: expect.any(String) });
      expect(seen.canVerify).toBe(false);
      const audit = await db.query<{ n: string }>(`select count(*)::text as n from public.audit_events where action = 'supplier.verified' and target_id = $1`, [supplierId]);
      expect(audit[0]!.n).toBe('1');

      const second = await createSupplier(PURCHASE, { ...SUPPLIER, name: 'Synthetic Archived Stays' });
      await one(PURCHASE, UPDATE_SUPPLIER_SQL, [second.supplierId, 1, JSON.stringify({ ...SUPPLIER, name: 'Synthetic Archived Stays', status: 'archived' })]);
      await refused(MANAGER, VERIFY_SQL, [second.supplierId, 2], '22023', 'invalid_input');
    });
  });

  it('a change of supplier details by Purchase resets verification; a status-only change keeps it', async () => {
    await asOwner(db, async () => {
      const { supplierId } = await createSupplier();
      await one(MANAGER, VERIFY_SQL, [supplierId, 1]);
      // Status only (archive, same details): still verified.
      await one(PURCHASE, UPDATE_SUPPLIER_SQL, [supplierId, 2, JSON.stringify({ ...SUPPLIER, status: 'archived' })]);
      expect(await supplierView(PURCHASE, supplierId)).toMatchObject({ verificationStatus: 'verified', status: 'archived' });
      await one(PURCHASE, UPDATE_SUPPLIER_SQL, [supplierId, 3, JSON.stringify({ ...SUPPLIER, status: 'active' })]);
      // A detail change: back to not verified, verifier cleared.
      await one(PURCHASE, UPDATE_SUPPLIER_SQL, [supplierId, 4, JSON.stringify({ ...SUPPLIER, contactPhone: '+91 11111 11111' })]);
      expect(await supplierView(PURCHASE, supplierId)).toMatchObject({ verificationStatus: 'unverified', verifiedByName: null, verifiedAt: null });
      const [audit] = await db.query<{ details: Record<string, unknown> }>(
        `select details from public.audit_events
         where action = 'supplier.updated' and target_id = $1 and details ->> 'detailsChanged' = 'true'`,
        [supplierId],
      );
      expect(audit!.details).toMatchObject({ detailsChanged: true, verificationReset: true });
      expect(JSON.stringify(audit!.details)).not.toContain('11111');
      // The verification flag cannot be forged by a direct write.
      await refused(PURCHASE, `update public.suppliers set verification_status = 'verified' where id = $1`, [supplierId], '42501');
    });
  });

  it('the person who last entered the details cannot verify them, even holding the manager role', async () => {
    await asOwner(db, async () => {
      await managerAlsoPurchase();
      const { supplierId } = await createSupplier(MANAGER);
      expect((await supplierView(MANAGER, supplierId)).canVerify).toBe(false);
      await refused(MANAGER, VERIFY_SQL, [supplierId, 1], '42501', 'not_authorized');
      expect(await one(MANAGER_OTHER_BRANCH, VERIFY_SQL, [supplierId, 1])).toMatchObject({ outcome: 'created' });
    });
  });
});

describe('A1 P4-D4 bank detail approval', () => {
  it('a manager approves the latest revision recorded by someone else; repeat is existing; never the recorder', async () => {
    await asOwner(db, async () => {
      await managerAlsoPurchase();
      const { supplierId } = await createSupplier();
      await recordBank(PURCHASE, supplierId);
      expect((await supplierView(MANAGER_OTHER_BRANCH, supplierId)).beneficiaries[0]!.canApprove).toBe(true);
      for (const actor of [PURCHASE, OWNER, ADMIN]) await refused(actor, APPROVE_BEN_SQL, [supplierId, 1], '42501', 'not_authorized');
      expect(await one(MANAGER_OTHER_BRANCH, APPROVE_BEN_SQL, [supplierId, 1])).toEqual({ revisionNo: 1, status: 'approved', outcome: 'created' });
      expect(await one(MANAGER, APPROVE_BEN_SQL, [supplierId, 1])).toMatchObject({ outcome: 'existing' });
      expect((await supplierView(PURCHASE, supplierId)).beneficiaries[0]).toMatchObject({
        status: 'approved',
        approvedByName: expect.any(String),
        canApprove: false,
      });
      await refused(MANAGER, APPROVE_BEN_SQL, [supplierId, 9], 'P0002', 'not_found');

      // The manager recorded revision 2 (also holds Purchase): only someone else may approve it.
      await recordBank(MANAGER, supplierId, '999988887777');
      expect((await supplierView(MANAGER, supplierId)).beneficiaries[0]!.canApprove).toBe(false);
      await refused(MANAGER, APPROVE_BEN_SQL, [supplierId, 2], '42501', 'not_authorized');
      // A newer revision supersedes an unapproved older one.
      await recordBank(PURCHASE, supplierId, '555544443333');
      await refused(MANAGER_OTHER_BRANCH, APPROVE_BEN_SQL, [supplierId, 2], '40001', 'version_changed');
      expect(await one(MANAGER_OTHER_BRANCH, APPROVE_BEN_SQL, [supplierId, 3])).toMatchObject({ outcome: 'created' });

      // Bank values stay immutable and an approval cannot be undone directly.
      const fails = (sql: string, params: unknown[]) => expectDbError(db, () => db.query(sql, params), { code: '42501' });
      await fails(`update public.supplier_beneficiary_revisions set account_number = '123456' where supplier_id = $1 and revision_no = 1`, [supplierId]);
      await fails(`update public.supplier_beneficiary_revisions set status = 'unverified', approved_by = null, approved_at = null where supplier_id = $1 and revision_no = 1`, [supplierId]);
      await fails('delete from public.supplier_beneficiary_revisions where supplier_id = $1', [supplierId]);
      const audit = await db.query<{ details: unknown }>(`select details from public.audit_events where action = 'supplier.beneficiary_approved'`);
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toMatch(/000011112222|555544443333|SYNB/);
    });
  });
});

describe('A1 P4-D2 over-budget approval', () => {
  const OVER = String(Number(BUDGET) + 50000);

  it('the deal-branch manager approves one specific version; confirmation then accepts it', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId } = await readyTask();
      await propose(PURCHASE, taskId, quoteId, 1, OVER);
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual(['over_budget']);
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 2, 'SYN-1'], '55000', 'over_budget');
      expect((await workspace(MANAGER, taskId))!.canApproveOverBudget).toBe(true);
      for (const actor of [PURCHASE, OWNER, MANAGER_OTHER_BRANCH, ADMIN]) {
        await refused(actor, APPROVE_COST_SQL, [taskId, 2], '42501', 'not_authorized');
      }
      await refused(MANAGER, APPROVE_COST_SQL, [taskId, 1], '40001', 'version_changed');
      expect(await one(MANAGER, APPROVE_COST_SQL, [taskId, 2])).toEqual({ taskId, versionNo: 2, outcome: 'created' });
      expect(await one(MANAGER, APPROVE_COST_SQL, [taskId, 2])).toEqual({ taskId, versionNo: 2, outcome: 'existing' });
      const ws = await workspace(PURCHASE, taskId);
      expect(ws!.issues).toEqual([]);
      const v2 = (ws!.costVersions as Array<Record<string, unknown>>).find((c) => c.versionNo === 2)!;
      expect(v2).toMatchObject({ overBudgetApprovedByName: expect.any(String), overBudgetApprovedAt: expect.any(String) });
      expect(await confirmSupplier(PURCHASE, taskId, 2, 'SYN-1')).toMatchObject({ outcome: 'created' });
      const [committed] = await db.query<{ amount: string }>(
        `select amount_paise::text as amount from public.purchase_cost_versions where task_id = $1 and stage = 'committed'`,
        [taskId],
      );
      expect(committed!.amount).toBe(OVER);
      const audit = await db.query<{ details: unknown }>(`select details from public.audit_events where action = 'purchase.cost_over_budget_approved'`);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(OVER);
      await refused(MANAGER, APPROVE_COST_SQL, [taskId, 2], '55000', 'already_confirmed');
      await expectDbError(db, () => db.query('delete from public.purchase_cost_approvals where task_id = $1', [taskId]), { code: '42501' });
    });
  });

  it('a newer version needs a new approval; a version within budget cannot be approved', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId } = await readyTask();
      await refused(MANAGER, APPROVE_COST_SQL, [taskId, 1], '22023', 'invalid_input');
      await propose(PURCHASE, taskId, quoteId, 1, OVER);
      await one(MANAGER, APPROVE_COST_SQL, [taskId, 2]);
      await propose(PURCHASE, taskId, quoteId, 2, String(Number(OVER) + 1));
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual(['over_budget']);
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 3, 'SYN-1'], '55000', 'over_budget');
      await one(MANAGER, APPROVE_COST_SQL, [taskId, 3]);
      expect((await workspace(PURCHASE, taskId))!.issues).toEqual([]);
    });
  });

  it('a manager who proposed the cost (also holding Purchase) cannot approve it', async () => {
    await asOwner(db, async () => {
      await managerAlsoPurchase();
      const taskId = await claimedTask(MANAGER);
      const { supplierId } = await createSupplier(MANAGER);
      const { quoteId } = await addQuote(MANAGER, taskId, supplierId);
      await propose(MANAGER, taskId, quoteId, 0, OVER);
      expect((await workspace(MANAGER, taskId))!.canApproveOverBudget).toBe(false);
      await refused(MANAGER, APPROVE_COST_SQL, [taskId, 1], '42501', 'not_authorized');
    });
  });
});

describe('A1 P4-D5 release and reassignment', () => {
  it('the assignee releases: not_started, work kept, Purchase deal assignment ended; repeat is existing', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const { taskId } = await readyTask();
      expect(await activeAssignments(taskId)).toEqual([U.purchaseJodhpur]);
      expect((await workspace(PURCHASE, taskId))!.canRelease).toBe(true);
      for (const actor of [OWNER, MANAGER, ADMIN]) await refused(actor, RELEASE_SQL, [taskId], '42501', 'not_authorized');
      await refused(PURCHASE_2, RELEASE_SQL, [taskId], '40001', 'task_conflict');
      expect(await one(PURCHASE, RELEASE_SQL, [taskId])).toEqual({ taskId, status: 'not_started', outcome: 'created' });
      expect(await one(PURCHASE, RELEASE_SQL, [taskId])).toEqual({ taskId, status: 'not_started', outcome: 'existing' });
      const ws = await workspace(PURCHASE, taskId);
      expect((ws!.task as { status: string; assigneeName: string | null }).status).toBe('not_started');
      expect(ws!.canWork).toBe(false);
      expect((ws!.quotes as unknown[]).length).toBe(1);
      expect((ws!.costVersions as unknown[]).length).toBe(1);
      expect((ws!.evidence as unknown[]).length).toBe(1);
      expect(await activeAssignments(taskId)).toEqual([]);
      await refused(PURCHASE, QUOTE_SQL, [taskId, crypto.randomUUID(), '{}'], '42501', 'not_authorized');

      // A colleague takes it and inherits the kept work.
      await one(PURCHASE_2, 'select public.purchase_task_claim($1) as r', [taskId]);
      expect(await activeAssignments(taskId)).toEqual([U.visaJodhpur]);
      expect((await workspace(PURCHASE_2, taskId))!.issues).toEqual([]);
      await refused(PURCHASE, RELEASE_SQL, [taskId], '40001', 'task_conflict');
      await confirmSupplier(PURCHASE_2, taskId, 1);
      await refused(PURCHASE_2, RELEASE_SQL, [taskId], '55000', 'already_confirmed');
      const audit = await db.query<{ n: string }>(`select count(*)::text as n from public.audit_events where action = 'fulfilment.task_released' and target_id = $1`, [taskId]);
      expect(audit[0]!.n).toBe('1');
    });
  });

  it('the deal-branch manager reassigns to another active Purchase person; stale expectations conflict; repeat is existing', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const { taskId, quoteId } = await readyTask();
      const candidates = (await workspace(MANAGER, taskId))!.reassignCandidates as Array<{ userId: string }>;
      expect(candidates.map((c) => c.userId)).toEqual([U.visaJodhpur]);
      for (const actor of [PURCHASE, PURCHASE_2, OWNER, MANAGER_OTHER_BRANCH, ADMIN]) {
        await refused(actor, REASSIGN_SQL, [taskId, U.purchaseJodhpur, U.visaJodhpur], '42501', 'not_authorized');
      }
      // The manager saw a different assignee (someone released or reassigned meanwhile).
      await refused(MANAGER, REASSIGN_SQL, [taskId, U.salesDelhiB, U.visaJodhpur], '40001', 'task_conflict');
      for (const target of [U.salesDelhiA, U.formerStaff, U.salesEntityB, U.accountsJodhpur]) {
        await refused(MANAGER, REASSIGN_SQL, [taskId, U.purchaseJodhpur, target], '22023', 'invalid_input');
      }
      expect(await one(MANAGER, REASSIGN_SQL, [taskId, U.purchaseJodhpur, U.visaJodhpur])).toEqual({ taskId, outcome: 'created' });
      expect(await one(MANAGER, REASSIGN_SQL, [taskId, U.purchaseJodhpur, U.visaJodhpur])).toEqual({ taskId, outcome: 'existing' });
      expect(await activeAssignments(taskId)).toEqual([U.visaJodhpur]);
      expect((await workspace(PURCHASE_2, taskId))!.canWork).toBe(true);
      expect((await workspace(PURCHASE, taskId))!.canWork).toBe(false);
      await refused(PURCHASE, COST_SQL, [taskId, quoteId, 1, '1000', null, null, crypto.randomUUID()], '42501', 'not_authorized');
      const [audit] = await db.query<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'fulfilment.task_reassigned' and target_id = $1`,
        [taskId],
      );
      expect(audit!.details).toMatchObject({ fromUserId: U.purchaseJodhpur, toUserId: U.visaJodhpur });
    });
  });

  it('release and reassignment happen only inside their commands; unclaimed and confirmed tasks are refused', async () => {
    await asOwner(db, async () => {
      await addSecondPurchase();
      const unclaimed = await confirmedTask();
      await refused(MANAGER, REASSIGN_SQL, [unclaimed, U.purchaseJodhpur, U.visaJodhpur], '40001', 'task_conflict');
      expect(await one(PURCHASE, RELEASE_SQL, [unclaimed])).toMatchObject({ outcome: 'existing' });
      await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [unclaimed]);
      const fails = (sql: string) => expectDbError(db, () => db.query(sql, [unclaimed]), { code: '42501' });
      await fails(`update public.fulfilment_tasks set status = 'not_started', assignee_user_id = null where id = $1`);
      await fails(`update public.fulfilment_tasks set assignee_user_id = '${U.visaJodhpur}' where id = $1`);
      await db.query(`update public.deployment_settings set environment = 'unset'`);
      await refused(PURCHASE, RELEASE_SQL, [unclaimed], '55000', 'environment_unset');
      await refused(MANAGER, REASSIGN_SQL, [unclaimed, U.purchaseJodhpur, U.visaJodhpur], '55000', 'environment_unset');
    });
  });
});

describe('Phase 6 F1 / F2: confirmation retries while the gate is closed; one record of each kind', () => {
  /** Everything a confirmation can write for one task, to prove "no writes". */
  const footprint = async (taskId: string) =>
    (
      await db.query<Record<string, string>>(
        `select
           (select count(*)::text from public.purchase_cost_versions where task_id = $1) as costs,
           (select count(*)::text from public.audit_events where target_id = $1) as audits,
           (select count(*)::text from public.outbox_events where aggregate_id = $1) as outbox,
           (select updated_at::text || '|' || coalesce(supplier_reference, '') from public.fulfilment_tasks where id = $1) as task,
           (select string_agg(status || ':' || updated_at::text, ',' order by id) from public.purchase_quotes where task_id = $1) as quotes`,
        [taskId],
      )
    )[0]!;

  it.each(['unset', 'staging'])(
    'environment %s: the exact authorized retry is existing with no writes; a changed one conflicts; a fresh one is refused',
    async (environment) => {
      await asOwner(db, async () => {
        await addSecondPurchase();
        const done = await readyTask();
        expect(await confirmSupplier(PURCHASE, done.taskId, 1, 'SYN-F1')).toEqual({ outcome: 'created', taskId: done.taskId });
        // A second ready task that is not yet confirmed.
        const fresh = await claimedTask(PURCHASE, { userId: U.salesDelhiB }, D.del002);
        const { quoteId } = await addQuote(PURCHASE, fresh, done.supplierId);
        await propose(PURCHASE, fresh, quoteId, 0);
        await storeProof(PURCHASE, fresh);

        await db.query(`update public.deployment_settings set environment = $1`, [environment]);
        const before = await footprint(done.taskId);
        expect(await confirmSupplier(PURCHASE, done.taskId, 1, 'SYN-F1')).toEqual({ outcome: 'existing', taskId: done.taskId });
        expect(await confirmSupplier(PURCHASE, done.taskId, 1, '  SYN-F1 ')).toEqual({ outcome: 'existing', taskId: done.taskId });
        await refused(PURCHASE, CONFIRM_SQL, [done.taskId, 1, 'SYN-OTHER'], '40001', 'task_conflict');
        await refused(PURCHASE, CONFIRM_SQL, [done.taskId, 2, 'SYN-F1'], '40001', 'task_conflict');
        // Authorization stays before the retry answer: nobody else learns "existing".
        for (const actor of [PURCHASE_2, OWNER, MANAGER, ADMIN]) {
          await refused(actor, CONFIRM_SQL, [done.taskId, 1, 'SYN-F1'], '42501', 'not_authorized');
        }
        expect(await footprint(done.taskId)).toEqual(before);

        // A fresh confirmation is refused while the gate is closed, and writes nothing.
        const freshBefore = await footprint(fresh);
        await refused(PURCHASE, CONFIRM_SQL, [fresh, 1, 'SYN-F1-FRESH'], '55000', environment === 'unset' ? 'environment_unset' : 'procurement_disabled');
        expect(await footprint(fresh)).toEqual(freshBefore);
      });
    },
  );

  it('live switch off: the exact retry is still existing with no writes', async () => {
    await asOwner(db, async () => {
      const done = await readyTask();
      await confirmSupplier(PURCHASE, done.taskId, 1, 'SYN-LIVE');
      await db.exec(`update public.procurement_settings set live_supplier_confirmation_enabled = false`);
      const before = await footprint(done.taskId);
      expect(await confirmSupplier(PURCHASE, done.taskId, 1, 'SYN-LIVE')).toEqual({ outcome: 'existing', taskId: done.taskId });
      expect(await footprint(done.taskId)).toEqual(before);
    });
  });

  it('F2: one supplier_confirmed audit row, one committed cost and one outbox row per confirmed task', async () => {
    await asOwner(db, async () => {
      const { taskId } = await readyTask();
      expect((await confirmSupplier(PURCHASE, taskId, 1, 'SYN-F2')).outcome).toBe('created');
      for (let i = 0; i < 3; i += 1) {
        expect((await confirmSupplier(PURCHASE, taskId, 1, 'SYN-F2')).outcome).toBe('existing');
      }
      await refused(PURCHASE, CONFIRM_SQL, [taskId, 1, 'SYN-F2-OTHER'], '40001', 'task_conflict');
      const [row] = await db.query<{ audits: number; committed: number; outbox: number }>(
        `select
           (select count(*)::int from public.audit_events where action = 'purchase.supplier_confirmed' and target_id = $1) as audits,
           (select count(*)::int from public.purchase_cost_versions where task_id = $1 and stage = 'committed') as committed,
           (select count(*)::int from public.outbox_events where event_type = 'fulfilment.supplier_confirmed' and aggregate_id = $1) as outbox`,
        [taskId],
      );
      expect(row).toEqual({ audits: 1, committed: 1, outbox: 1 });
    });
  });
});
