import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import type { FinanceCommandResult } from '@/modules/finance/contracts';
import { FIXTURE_EMAILS, FIXTURE_USERS as U, assertDatabaseUrlNotOperational, istBusinessDate } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 5A permission and concurrency proof against the REAL local Supabase
 * stack (PostgREST + GoTrue + Postgres), contract
 * docs/implementation/history/contracts/phase-5a-contract.md sections 4, 6, 9.1, 9.2, 11
 * and 17:
 *   - direct table and RPC denials through the Data API for anon, Sales, AAL1
 *     and Accounts (tables), and Accounts never reading Leads or supplier
 *     bank details;
 *   - truly concurrent cash receipts (separate PostgREST requests, separate
 *     database sessions) for the same payer key and for the same trip, from
 *     two collecting branches and two Accounts people, never exceed the cap;
 *   - the same request id sent in parallel creates one receipt;
 *   - a duplicate bank/UPI reference sent in parallel is created once;
 *   - a policy update racing receipt records: every receipt uses exactly one
 *     version, the one effective at its transaction time; an exact retry
 *     after the change returns the original result.
 *
 * Synthetic data only: run-tagged SYN-FIN-* deals, random payer keys and
 * three Auth users created for this run (two Accounts, one Sales,
 * @example.test). The fixture Super Admin edits the policy with unchanged
 * values (a new version with the same caps) so other suites see the same
 * limits. afterAll removes this run's finance rows, deals and users as the
 * LOCAL table owner (append-only guards suspended in that transaction only);
 * policy versions and audit_events stay.
 *
 * Runs only in CI against the disposable stack; skips locally without the
 * stack and fails (never skips) when REQUIRE_REAL_STACK=1 and anything is
 * missing. Never targets a hosted project (local hosts only).
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('finance real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
interface RunUser { id: string; email: string }
const runUsers: RunUser[] = [];
const dealIds: string[] = [];
const destinationIds: string[] = [];
/** runTag without digits: labels may not carry six or more digits in a row. */
const runLetters = runTag.replace(/[0-9]/g, (d) => 'ABCDEFGHIJ'[Number(d)]!);

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function createRunUser(label: string, branchCode: string, role: string): Promise<RunUser> {
  const email = `finance.${label}.${runTag.toLowerCase()}@example.test`;
  const created = await stack!.admin().auth.admin.createUser({ email, password: env!.fixturePassword, email_confirm: true });
  if (created.error) throw created.error;
  const user = { id: created.data.user!.id, email };
  runUsers.push(user);
  await ownerQuery(
    `insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
     values ($1, $2, $3, 'active', now())`,
    [user.id, `Synthetic finance ${label}`, email],
  );
  await ownerQuery(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $2`,
    [user.id, branchCode, role],
  );
  return user;
}

let dealSeq = 0;
async function newDeal(): Promise<string> {
  dealSeq += 1;
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic finance CI deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [`SYN-FIN-${runTag}-${String(dealSeq).padStart(3, '0')}`, U.salesDelhiA],
  );
  dealIds.push(row!.id);
  return row!.id;
}

/**
 * SYNTHETIC FIXTURE (Stage 2): an approved company destination for the deal's
 * entity with the deal's synthetic flag, inserted as the owner. The maker and
 * approver paths are exercised through the commands in the Stage 2 tests below.
 */
async function approvedDestination(dealId: string, kind: 'bank' | 'upi'): Promise<string> {
  const [dest] = await ownerQuery<{ id: string; legal_entity_id: string }>(
    `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
     select d.legal_entity_id, $2, 'Synthetic CI destination', d.is_synthetic, $3 from public.deals d where d.id = $1
     returning id, legal_entity_id`,
    [dealId, kind, U.accountsJodhpur],
  );
  destinationIds.push(dest!.id);
  const [version] = await ownerQuery<{ id: string }>(
    `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
       account_number, ifsc, payee_name, upi_id, status, maker, request_id, decided_by, decided_at)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'approved', $9, gen_random_uuid(), $10, now()) returning id`,
    kind === 'bank'
      ? [dest!.legal_entity_id, dest!.id, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', null, null, U.accountsJodhpur, U.adminJodhpur]
      : [dest!.legal_entity_id, dest!.id, null, null, null, null, 'Synthetic Payee', 'synthetic.payee@synbank', U.accountsJodhpur, U.adminJodhpur],
  );
  await ownerQuery('update public.company_destinations set current_version_id = $1 where id = $2', [version!.id, dest!.id]);
  return version!.id;
}

interface Settled<T> { data: T | null; error: PostgrestError | null }
async function settle<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Settled<T>> {
  const { data, error } = await client.rpc(fn, args);
  return { data: data as T | null, error };
}
async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await settle<T>(client, fn, args);
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, details: r.error.details });
  return r.data as T;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pick = (s: string) => s[Math.floor(Math.random() * s.length)]!;
/** Random synthetic PAN-shaped key (never a real person). */
const randomPan = () =>
  `${Array.from({ length: 5 }, () => pick(LETTERS)).join('')}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}${pick(LETTERS)}`;

interface Policy { id: string; payerCap: bigint; tripCap: bigint; receiptMax: bigint }

let entityId = '';
const branches: Record<'DEL' | 'JDH' | 'AMD', string> = { DEL: '', JDH: '', AMD: '' };
let accA: SignedIn;
let accB: SignedIn;
let accAal1: SignedIn;
let sales: SignedIn;
let admin: SignedIn;
let accAUser: RunUser;

async function currentPolicy(): Promise<Policy> {
  const [row] = await ownerQuery<{ id: string; p: string; t: string; m: string }>(
    `select v.id, v.cash_payer_day_cap_paise::text as p, v.cash_trip_cap_paise::text as t, v.receipt_max_paise::text as m
     from public.finance_policy_versions v
     where v.legal_entity_id = $1 and v.effective_at <= now()
     order by v.effective_at desc, v.version_no desc limit 1`,
    [entityId],
  );
  return { id: row!.id, payerCap: BigInt(row!.p), tripCap: BigInt(row!.t), receiptMax: BigInt(row!.m) };
}

const cashFields = (branchId: string, amount: bigint, payerPan: string) => ({
  mode: 'cash',
  amountPaise: amount.toString(),
  receivedOn: istBusinessDate(),
  branchId,
  collectorUserId: accAUser.id,
  payerName: 'Synthetic CI Cash Payer',
  payerPan,
});

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  const [settings] = await ownerQuery<{ environment: string }>('select environment from public.deployment_settings where id');
  if (settings?.environment !== 'test') {
    throw new Error(`finance real-stack suite needs deployment environment 'test' (synthetic deals), found ${settings?.environment}`);
  }
  entityId = (await ownerQuery<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  for (const row of await ownerQuery<{ id: string; code: 'DEL' | 'JDH' | 'AMD' }>(
    `select b.id, b.code from public.branches b where b.legal_entity_id = $1 and b.code in ('DEL', 'JDH', 'AMD')`,
    [entityId],
  )) {
    branches[row.code] = row.id;
  }
  accAUser = await createRunUser('accounts-a', 'JDH', 'accounts');
  const accBUser = await createRunUser('accounts-b', 'DEL', 'accounts');
  const salesUser = await createRunUser('sales', 'DEL', 'sales');
  accA = await stack!.signInAal2(accAUser.email, accAUser.id);
  accB = await stack!.signInAal2(accBUser.email, accBUser.id);
  sales = await stack!.signInAal2(salesUser.email, salesUser.id);
  admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, U.adminJodhpur);
  accAal1 = await stack!.signIn(accBUser.email);
  expect(await stack!.aal(accAal1.client)).toBe('aal1');
});

afterAll(async () => {
  if (!enabled) return;
  try {
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    try {
      await client.query('begin');
      // Local disposable database only (checked above): suspend the append-only
      // and state guards for this transaction so this run's rows can be removed.
      await client.query('set local session_replication_role = replica');
      const userIds = runUsers.map((u) => u.id);
      const receipts = 'select id from public.customer_receipts where deal_id = any($1::uuid[])';
      await client.query(
        `delete from public.finance_journal_lines where entry_id in (select id from public.finance_journal_entries where deal_id = any($1::uuid[]))`,
        [dealIds],
      );
      await client.query('delete from public.finance_journal_entries where deal_id = any($1::uuid[])', [dealIds]);
      // B1.1b: claims reference receipts and booking versions.
      await client.query('delete from public.customer_payment_claims where deal_id = any($1::uuid[])', [dealIds]);
      await client.query(`delete from public.finance_evidence where receipt_id in (${receipts})`, [dealIds]);
      await client.query('delete from public.customer_receipts where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.company_destination_versions where destination_id = any($1::uuid[])', [destinationIds]);
      await client.query('delete from public.company_destinations where id = any($1::uuid[])', [destinationIds]);
      await client.query('delete from public.finance_command_results where actor = any($1::uuid[])', [userIds]);
      await client.query('delete from public.finance_deal_heads where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.booking_versions where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  } finally {
    try {
      await stack!.cleanup();
    } finally {
      // Profile rows first (auth.users is ON DELETE RESTRICT), then Auth.
      for (const user of runUsers) {
        await ownerQuery('delete from public.memberships where user_id = $1', [user.id]);
        await ownerQuery('delete from public.staff_security_state where user_id = $1', [user.id]);
        await ownerQuery('delete from public.staff_profiles where user_id = $1', [user.id]);
        const removed = await stack!.admin().auth.admin.deleteUser(user.id);
        if (removed.error) throw removed.error;
      }
    }
  }
});

describe.skipIf(!enabled)('Phase 5A finance through PostgREST: denials and concurrency', () => {
  it('anon, Sales and AAL1 are refused; finance tables are closed to every Data API role', async () => {
    const anon = stack!.anon();
    const queueAnon = await anon.rpc('accounts_queue', { p_filter: 'all' });
    expect(queueAnon.error?.code).toBe('42501');
    const queueSales = await sales.client.rpc('accounts_queue', { p_filter: 'all' });
    expect(queueSales.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    const queueAal1 = await accAal1.client.rpc('accounts_queue', { p_filter: 'all' });
    expect(queueAal1.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    const deal = await newDeal();
    const recordSales = await sales.client.rpc('receipt_record', {
      p_deal_id: deal,
      p_fields: cashFields(branches.DEL, 100n, randomPan()),
      p_request_id: crypto.randomUUID(),
    });
    expect(recordSales.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    const policySales = await accA.client.rpc('finance_policy_update', {
      p_entity_id: entityId,
      p_fields: {},
      p_effective_at: null,
      p_reason: 'Synthetic refused policy change',
      p_request_id: crypto.randomUUID(),
    });
    expect(policySales.error).toMatchObject({ code: '42501', message: 'not_authorized' });

    for (const table of ['customer_receipts', 'finance_policy_versions', 'finance_journal_lines', 'finance_live_settings', 'finance_command_results']) {
      for (const client of [anon, sales.client, accA.client]) {
        const r = await client.from(table).select('*').limit(1);
        expect(r.error?.code, table).toBe('42501');
      }
      const write = await accA.client.from(table).insert({});
      expect(write.error, table).not.toBeNull();
    }
    expect(await accA.client.rpc('accounts_queue', { p_filter: 'all' })).toMatchObject({ error: null });
  });

  it('Accounts never reads Leads or supplier bank details', async () => {
    const leads = await accA.client.from('crm_leads').select('id').limit(5);
    expect(leads.error ? leads.error.code : leads.data).toEqual(leads.error ? '42501' : []);
    const bank = await accA.client.from('supplier_beneficiary_revisions').select('id').limit(1);
    expect(bank.error?.code).toBe('42501');
  });

  it('parallel cash receipts for one payer key from two branches and two Accounts people never exceed the payer-day cap', async () => {
    const policy = await currentPolicy();
    expect(policy.payerCap > 0n, 'cash must be on by policy for this proof').toBe(true);
    const amount = policy.payerCap / 3n > 0n ? policy.payerCap / 3n : 1n;
    expect(amount <= policy.tripCap && amount <= policy.receiptMax, 'amount must fit the trip cap and receipt max').toBe(true);
    const pan = randomPan();
    const n = 8;
    const deals = await Promise.all(Array.from({ length: n }, () => newDeal()));
    const results = await Promise.all(
      deals.map((dealId, i) =>
        settle<FinanceCommandResult>(i % 2 ? accB.client : accA.client, 'receipt_record', {
          p_deal_id: dealId,
          p_fields: cashFields(i % 2 ? branches.DEL : branches.AMD, amount, pan),
          p_request_id: crypto.randomUUID(),
        }),
      ),
    );
    const ok = results.filter((r) => r.data);
    const refusedRows = results.filter((r) => r.error);
    const expected = Number(policy.payerCap / amount < BigInt(n) ? policy.payerCap / amount : BigInt(n));
    for (const r of refusedRows) expect(r.error).toMatchObject({ code: '55000', message: 'cash_cap_exceeded', details: 'payer_day' });
    expect(ok).toHaveLength(expected);
    const [sum] = await ownerQuery<{ s: string }>(
      `select coalesce(sum(amount_paise), 0)::text as s from public.customer_receipts
       where legal_entity_id = $1 and mode = 'cash' and payer_pan = $2 and received_on = $3::date`,
      [entityId, pan, istBusinessDate()],
    );
    expect(BigInt(sum!.s) <= policy.payerCap).toBe(true);
    expect(BigInt(sum!.s)).toBe(amount * BigInt(expected));
  });

  it('parallel cash receipts for one trip from two branches never exceed the trip cap', async () => {
    const policy = await currentPolicy();
    expect(policy.tripCap > 0n, 'cash must be on by policy for this proof').toBe(true);
    const amount = policy.tripCap / 3n > 0n ? policy.tripCap / 3n : 1n;
    expect(amount <= policy.payerCap && amount <= policy.receiptMax).toBe(true);
    const deal = await newDeal();
    const n = 8;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        settle<FinanceCommandResult>(i % 2 ? accB.client : accA.client, 'receipt_record', {
          p_deal_id: deal,
          p_fields: cashFields(i % 2 ? branches.JDH : branches.DEL, amount, randomPan()),
          p_request_id: crypto.randomUUID(),
        }),
      ),
    );
    const expected = Number(policy.tripCap / amount < BigInt(n) ? policy.tripCap / amount : BigInt(n));
    for (const r of results.filter((x) => x.error)) {
      expect(r.error).toMatchObject({ code: '55000', message: 'cash_cap_exceeded', details: 'trip' });
    }
    expect(results.filter((r) => r.data)).toHaveLength(expected);
    const [sum] = await ownerQuery<{ s: string }>(
      `select coalesce(sum(amount_paise), 0)::text as s from public.customer_receipts where deal_id = $1 and mode = 'cash'`,
      [deal],
    );
    expect(BigInt(sum!.s) <= policy.tripCap).toBe(true);
  });

  it('the same request id sent in parallel creates one receipt; every caller gets its identity', async () => {
    const deal = await newDeal();
    const requestId = crypto.randomUUID();
    const fields = cashFields(branches.JDH, 1000n, randomPan());
    const results = await Promise.all(
      Array.from({ length: 6 }, () => settle<FinanceCommandResult>(accA.client, 'receipt_record', { p_deal_id: deal, p_fields: fields, p_request_id: requestId })),
    );
    for (const r of results) expect(r.error).toBeNull();
    const ids = new Set(results.map((r) => r.data!.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.data!.outcome === 'created')).toHaveLength(1);
    const rows = await ownerQuery('select id from public.customer_receipts where request_id = $1', [requestId]);
    expect(rows).toHaveLength(1);
  });

  it('a duplicate bank/UPI reference sent in parallel on different deals is created once', async () => {
    const reference = `SYNCI${runTag}`.slice(0, 40);
    const deals = await Promise.all(Array.from({ length: 6 }, () => newDeal()));
    const destinations = { bank: await approvedDestination(deals[0]!, 'bank'), upi: await approvedDestination(deals[0]!, 'upi') };
    const results = await Promise.all(
      deals.map((dealId, i) =>
        settle<FinanceCommandResult>(i % 2 ? accB.client : accA.client, 'receipt_record', {
          p_deal_id: dealId,
          p_fields: {
            mode: i % 2 ? 'upi' : 'bank_transfer',
            amountPaise: '1000',
            receivedOn: istBusinessDate(),
            branchId: branches.DEL,
            payerName: 'Synthetic CI Payer',
            payerMobile: '9876500009',
            reference: i % 3 ? reference : reference.toLowerCase(),
            destinationVersionId: i % 2 ? destinations.upi : destinations.bank,
          },
          p_request_id: crypto.randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.data)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error).toMatchObject({ code: '23505', message: 'duplicate_reference' });
  });

  it('a policy update racing receipt records: each receipt uses exactly the version effective at its own time', async () => {
    const before = await currentPolicy();
    const deals = await Promise.all(Array.from({ length: 6 }, () => newDeal()));
    const receiptCalls = deals.map((dealId, i) =>
      settle<FinanceCommandResult>(i % 2 ? accB.client : accA.client, 'receipt_record', {
        p_deal_id: dealId,
        p_fields: cashFields(branches.JDH, 1000n, randomPan()),
        p_request_id: crypto.randomUUID(),
      }),
    );
    // Unchanged values: a new version with the same caps, so other suites see the same limits.
    const policyCall = settle<FinanceCommandResult>(admin.client, 'finance_policy_update', {
      p_entity_id: entityId,
      p_fields: {},
      p_effective_at: null,
      p_reason: `Synthetic CI concurrency check ${runTag}`,
      p_request_id: crypto.randomUUID(),
    });
    const [policy, ...receipts] = await Promise.all([policyCall, ...receiptCalls]);
    expect(policy!.error).toBeNull();
    for (const r of receipts) expect(r.error).toBeNull();
    const ids = receipts.map((r) => r.data!.id);
    const rows = await ownerQuery<{ id: string; ok: boolean; version_id: string }>(
      `select r.id, r.policy_version_id as version_id,
              (v.legal_entity_id = r.legal_entity_id and v.effective_at <= r.recorded_at
               and not exists (
                 select 1 from public.finance_policy_versions w
                 where w.legal_entity_id = r.legal_entity_id and w.effective_at <= r.recorded_at
                   and (w.effective_at, w.version_no) > (v.effective_at, v.version_no))) as ok
       from public.customer_receipts r join public.finance_policy_versions v on v.id = r.policy_version_id
       where r.id = any($1::uuid[])`,
      [ids],
    );
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) expect(row.ok, row.id).toBe(true);
    const newVersion = policy!.data!.id;
    for (const row of rows) expect([before.id, newVersion]).toContain(row.version_id);
  });

  it('an exact retry after a policy change returns the original; a changed payload is request_conflict', async () => {
    const deal = await newDeal();
    const requestId = crypto.randomUUID();
    const fields = cashFields(branches.DEL, 1000n, randomPan());
    const first = await rpc<FinanceCommandResult>(accA.client, 'receipt_record', { p_deal_id: deal, p_fields: fields, p_request_id: requestId });
    await rpc(admin.client, 'finance_policy_update', {
      p_entity_id: entityId,
      p_fields: {},
      p_effective_at: null,
      p_reason: `Synthetic CI retry check ${runTag}`,
      p_request_id: crypto.randomUUID(),
    });
    const again = await rpc<FinanceCommandResult>(accA.client, 'receipt_record', { p_deal_id: deal, p_fields: fields, p_request_id: requestId });
    expect(again).toEqual({ ...first, outcome: 'existing' });
    const changed = await accA.client.rpc('receipt_record', {
      p_deal_id: deal,
      p_fields: { ...fields, amountPaise: '1001' },
      p_request_id: requestId,
    });
    expect(changed.error).toMatchObject({ code: '40001', message: 'request_conflict' });
    const otherActor = await accB.client.rpc('receipt_record', { p_deal_id: deal, p_fields: fields, p_request_id: requestId });
    expect(otherActor.error).toMatchObject({ code: '40001', message: 'request_conflict' });
  });

  it('self-verification and deal-owner verification are refused through the Data API', async () => {
    const deal = await newDeal();
    const rec = await rpc<FinanceCommandResult>(accA.client, 'receipt_record', {
      p_deal_id: deal,
      p_fields: cashFields(branches.JDH, 1000n, randomPan()),
      p_request_id: crypto.randomUUID(),
    });
    const self = await accA.client.rpc('receipt_verify', { p_receipt_id: rec.id, p_request_id: crypto.randomUUID() });
    expect(self.error).toMatchObject({ code: '42501', message: 'not_self_approval' });
    await ownerQuery('update public.deals set owner_user_id = $2 where id = $1', [deal, runUsers[1]!.id]);
    const owner = await accB.client.rpc('receipt_verify', { p_receipt_id: rec.id, p_request_id: crypto.randomUUID() });
    expect(owner.error).toMatchObject({ code: '42501', message: 'not_self_approval' });
  });

  // -------------------------------------------------------------------------
  // Stage 2: company destination races (real PostgreSQL row locks)
  // -------------------------------------------------------------------------

  async function submittedBank(maker: SignedIn): Promise<{ destinationId: string; versionId: string; rowVersion: number }> {
    const r = await rpc<{ destinationId: string; versionId: string; rowVersion: number }>(maker.client, 'company_destination_submit', {
      p_entity_id: entityId,
      p_destination_id: null,
      p_fields: { kind: 'bank', label: `Synthetic CI account ${runLetters}`, holderName: 'Synthetic Holder', bankName: 'Synthetic Bank', accountNumber: '000123456789', ifsc: 'SYNB0000001' },
      p_expected_row_version: null,
      p_request_id: crypto.randomUUID(),
    });
    destinationIds.push(r.destinationId);
    return r;
  }

  it('two approvals of the same version at the same moment: exactly one approves', async () => {
    const s = await submittedBank(accA);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        settle<{ status: string }>(accB.client, 'company_destination_approve', {
          p_version_id: s.versionId, p_expected_row_version: s.rowVersion, p_request_id: crypto.randomUUID(),
        })),
    );
    expect(results.filter((r) => r.data?.status === 'approved')).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(['version_changed', 'wrong_state']).toContain(r.error!.message);
    const [row] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from public.company_destination_versions where destination_id = $1 and status = 'approved'`, [s.destinationId]);
    expect(row!.n).toBe(1);
  });

  it('an approval racing a new submit on the same destination: the approval wins, the submit is refused', async () => {
    const s = await submittedBank(accA);
    const first = await rpc<{ rowVersion: number }>(accB.client, 'company_destination_approve', {
      p_version_id: s.versionId, p_expected_row_version: s.rowVersion, p_request_id: crypto.randomUUID(),
    });
    const replacement = await rpc<{ versionId: string; rowVersion: number }>(accA.client, 'company_destination_submit', {
      p_entity_id: entityId, p_destination_id: s.destinationId,
      p_fields: { holderName: 'Synthetic Holder', bankName: 'Synthetic Bank', accountNumber: '000555666777', ifsc: 'SYNB0000001' },
      p_expected_row_version: first.rowVersion, p_request_id: crypto.randomUUID(),
    });
    const [approved, submitted] = await Promise.all([
      settle<{ status: string }>(accB.client, 'company_destination_approve', {
        p_version_id: replacement.versionId, p_expected_row_version: replacement.rowVersion, p_request_id: crypto.randomUUID(),
      }),
      settle(accA.client, 'company_destination_submit', {
        p_entity_id: entityId, p_destination_id: s.destinationId,
        p_fields: { holderName: 'Synthetic Holder', bankName: 'Synthetic Bank', accountNumber: '000777888999', ifsc: 'SYNB0000001' },
        p_expected_row_version: replacement.rowVersion, p_request_id: crypto.randomUUID(),
      }),
    ]);
    expect(approved.error).toBeNull();
    expect(approved.data!.status).toBe('approved');
    expect(['wrong_state', 'version_changed']).toContain(submitted.error?.message);
    const versions = await ownerQuery<{ version_no: number; status: string }>(
      'select version_no, status from public.company_destination_versions where destination_id = $1 order by version_no', [s.destinationId]);
    expect(versions).toEqual([{ version_no: 1, status: 'superseded' }, { version_no: 2, status: 'approved' }]);
  });

  it('an approval racing a retirement ends in one consistent state', async () => {
    const s = await submittedBank(accA);
    const [approved, retired] = await Promise.all([
      settle<{ status: string }>(accB.client, 'company_destination_approve', {
        p_version_id: s.versionId, p_expected_row_version: s.rowVersion, p_request_id: crypto.randomUUID(),
      }),
      settle<{ status: string }>(accA.client, 'company_destination_retire', {
        p_destination_id: s.destinationId, p_expected_row_version: s.rowVersion, p_reason: 'Synthetic CI retirement race', p_request_id: crypto.randomUUID(),
      }),
    ]);
    expect([approved.error, retired.error].filter(Boolean)).toHaveLength(1);
    const [d] = await ownerQuery<{ retired: boolean; current: string | null }>(
      'select retired_at is not null as retired, current_version_id as current from public.company_destinations where id = $1', [s.destinationId]);
    if (approved.data) expect(d).toEqual({ retired: false, current: s.versionId });
    else expect(d).toEqual({ retired: true, current: null });
  });

  it('a retirement racing receipt recording: a receipt is either recorded before the retirement or refused', async () => {
    const s = await submittedBank(accA);
    const approved = await rpc<{ rowVersion: number }>(accB.client, 'company_destination_approve', {
      p_version_id: s.versionId, p_expected_row_version: s.rowVersion, p_request_id: crypto.randomUUID(),
    });
    const deals = await Promise.all(Array.from({ length: 4 }, () => newDeal()));
    const receipts = deals.map((dealId, i) =>
      settle<FinanceCommandResult>(accA.client, 'receipt_record', {
        p_deal_id: dealId,
        p_fields: {
          mode: 'bank_transfer', amountPaise: '1000', receivedOn: istBusinessDate(), branchId: branches.DEL,
          payerName: 'Synthetic CI Payer', payerMobile: '9876500009', reference: `SYNRT${runTag}${i}`.slice(0, 40),
          destinationVersionId: s.versionId,
        },
        p_request_id: crypto.randomUUID(),
      }));
    const retire = settle(accB.client, 'company_destination_retire', {
      p_destination_id: s.destinationId, p_expected_row_version: approved.rowVersion, p_reason: 'Synthetic CI retirement race', p_request_id: crypto.randomUUID(),
    });
    const [settled, retired] = await Promise.all([Promise.all(receipts), retire]);
    expect(retired.error).toBeNull();
    for (const r of settled.filter((x) => x.error)) expect(r.error).toMatchObject({ code: '55000', message: 'destination_changed' });
    // Row locks serialize the two: every recorded receipt carries the snapshot,
    // and once the retirement has committed nothing more can select it.
    const rows = await ownerQuery<{ snapshot: boolean }>(
      `select r.destination_snapshot is not null as snapshot from public.customer_receipts r
       join public.company_destination_versions v on v.id = r.destination_version_id where v.destination_id = $1`, [s.destinationId]);
    expect(rows).toHaveLength(settled.filter((x) => x.data).length);
    expect(rows.every((r) => r.snapshot)).toBe(true);
    const after = await accA.client.rpc('receipt_record', {
      p_deal_id: deals[0],
      p_fields: {
        mode: 'bank_transfer', amountPaise: '1000', receivedOn: istBusinessDate(), branchId: branches.DEL,
        payerName: 'Synthetic CI Payer', payerMobile: '9876500009', reference: `SYNRTX${runTag}`.slice(0, 40),
        destinationVersionId: s.versionId,
      },
      p_request_id: crypto.randomUUID(),
    });
    expect(after.error).toMatchObject({ code: '55000', message: 'destination_changed' });
  });
  it('B1.1b: recording from a claim racing a link on the same claim: exactly one links, the other is refused', async () => {
    const deal = await newDeal();
    // SYNTHETIC FIXTURE: a draft booking version and a Sales-reported cash claim,
    // inserted as the owner (the Sales command path is covered by the PGlite suites).
    const [version] = await ownerQuery<{ id: string }>(
      `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, content_hash, created_by)
       select d.id, d.legal_entity_id, d.branch_id, 1, repeat('0', 64), $2 from public.deals d where d.id = $1 returning id`,
      [deal, U.salesDelhiA],
    );
    const [claim] = await ownerQuery<{ id: string }>(
      `insert into public.customer_payment_claims (legal_entity_id, deal_id, booking_version_id, mode, amount_paise, paid_on,
         payer_name, reported_by, request_id)
       select d.legal_entity_id, d.id, $2, 'cash', 1000, $3::date, 'Synthetic CI Cash Payer', $4, gen_random_uuid()
       from public.deals d where d.id = $1 returning id`,
      [deal, version!.id, istBusinessDate(), U.salesDelhiA],
    );
    const pan = randomPan();
    const existing = await rpc<FinanceCommandResult>(accB.client, 'receipt_record', {
      p_deal_id: deal, p_fields: cashFields(branches.DEL, 1000n, pan), p_request_id: crypto.randomUUID(),
    });
    const [fromClaim, linked] = await Promise.all([
      settle<FinanceCommandResult & { receiptId?: string }>(accA.client, 'receipt_record_from_claim', {
        p_claim_id: claim!.id, p_fields: cashFields(branches.JDH, 1000n, pan), p_request_id: crypto.randomUUID(),
      }),
      settle<FinanceCommandResult>(accB.client, 'payment_claim_link_receipt', {
        p_claim_id: claim!.id, p_receipt_id: existing.id, p_reason: null, p_request_id: crypto.randomUUID(),
      }),
    ]);
    const wins = [fromClaim, linked].filter((r) => r.data);
    expect(wins).toHaveLength(1);
    for (const r of [fromClaim, linked].filter((x) => x.error)) expect(r.error).toMatchObject({ code: '55000', message: 'wrong_state' });
    const [row] = await ownerQuery<{ status: string; linked: string }>(
      'select status, linked_receipt_id as linked from public.customer_payment_claims where id = $1', [claim!.id]);
    expect(row!.status).toBe('linked');
    // A refused record-from-claim leaves no receipt behind.
    const receipts = await ownerQuery('select id from public.customer_receipts where deal_id = $1', [deal]);
    expect(receipts).toHaveLength(fromClaim.data ? 2 : 1);
    expect(row!.linked).toBe(fromClaim.data ? fromClaim.data.receiptId : existing.id);
    // Claims are closed to the Data API.
    const direct = await accA.client.from('customer_payment_claims').select('*').limit(1);
    expect(direct.error?.code).toBe('42501');
  });
});
