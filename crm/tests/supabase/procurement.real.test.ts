import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingFacts, BookingReadiness, ConfirmBookingResult, OpenDraftResult } from '@/modules/fulfilment/contracts';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS, assertDatabaseUrlNotOperational } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 4 procurement against the REAL local Supabase stack (PostgREST +
 * GoTrue + Postgres + Storage): true parallel claims by two Purchase people,
 * parallel cost proposals (one wins, the rest version_changed), duplicate
 * request ids under concurrency, parallel supplier confirmations, private
 * Storage refusals and RLS with real aal2 sessions (contract P4-01..P4-09).
 *
 * Synthetic data only: one SYN-PRC-* deal per run, a run-tagged synthetic
 * supplier, and a temporary purchase membership for the synthetic Accounts
 * user (the second Purchase person). Not the Visa user: session-recovery.real
 * deliberately leaves that user in an open MFA recovery case, which blocks
 * every query, so the outcome would depend on file order. afterAll removes them as the local table
 * owner, disabling the append-only/guard triggers inside its own transaction
 * (test-only, local). audit_events stay. Fails (never skips) when
 * REQUIRE_REAL_STACK=1 and the stack or TEST_DATABASE_URL is missing.
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
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('procurement real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const BUCKET = 'purchase-evidence';
const FACTS: BookingFacts = {
  hotelName: 'Synthetic Hotel (CI fixture)',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-12',
  rooms: 1,
  roomType: null,
  mealPlan: null,
  adults: 2,
  children: 0,
  inclusions: null,
  specialRequests: null,
  purchaseBudgetPaise: '3000000',
};
const SELLING = '7654321';
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const dealIds: string[] = [];
const supplierIds: string[] = [];
const bookingObjects: string[] = [];
const purchaseObjects: string[] = [];
let tempMembership = false;

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}
async function settle<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(fn, args);
  return { data: data as T | null, error };
}

let owner: SignedIn;
let purchaseA: SignedIn;
let purchaseB: SignedIn;

async function confirmedTask(suffix = ''): Promise<string> {
  const [deal] = await ownerQuery<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic procurement CI deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [`SYN-PRC-${runTag}${suffix}`, FIXTURE_USERS.salesDelhiA],
  );
  dealIds.push(deal!.id);
  const opened = await rpc<OpenDraftResult>(owner.client, 'booking_open_draft', { p_deal_id: deal!.id });
  await rpc(owner.client, 'booking_save_draft', {
    p_version_id: opened.versionId,
    p_expected_row_version: opened.rowVersion,
    p_facts: FACTS,
    p_selling_total_paise: SELLING,
    p_selling_total_provided: true,
  });
  const ev = await rpc<{ evidenceId: string; objectPath: string }>(owner.client, 'booking_begin_evidence', {
    p_version_id: opened.versionId,
    p_kind: 'acceptance_message',
    p_file_name: 'acceptance.pdf',
    p_mime: 'application/pdf',
    p_size_bytes: 1024,
    p_sha256: 'c'.repeat(64),
  });
  const up = await stack!.admin().storage.from('booking-evidence').upload(ev.objectPath, new Blob([new Uint8Array(1024).fill(37)], { type: 'application/pdf' }), {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (up.error) throw up.error;
  bookingObjects.push(ev.objectPath);
  await rpc(owner.client, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
  const ready = await rpc<BookingReadiness>(owner.client, 'booking_readiness', { p_version_id: opened.versionId });
  const confirmed = await rpc<ConfirmBookingResult>(owner.client, 'booking_confirm', {
    p_version_id: opened.versionId,
    p_expected_content_hash: ready.contentHash,
  });
  // Hotel confirmation always creates the task (B1.1 widened taskId to nullable).
  return confirmed.taskId!;
}

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  await ownerQuery(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'
     on conflict (user_id, branch_id, role_code) do nothing`,
    [FIXTURE_USERS.accountsJodhpur],
  );
  tempMembership = true;
  owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  purchaseA = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, FIXTURE_USERS.purchaseJodhpur);
  purchaseB = await stack!.signInAal2(FIXTURE_EMAILS.accountsJodhpur, FIXTURE_USERS.accountsJodhpur);
});

afterAll(async () => {
  try {
    if (enabled && bookingObjects.length > 0) await stack!.admin().storage.from('booking-evidence').remove(bookingObjects);
    if (enabled && purchaseObjects.length > 0) await stack!.admin().storage.from(BUCKET).remove(purchaseObjects);
    if (enabled) {
      const client = new pg.Client({ connectionString: dbUrl! });
      await client.connect();
      try {
        await client.query('begin');
        // Local test database only (checked above): suspend triggers, including the
        // append-only/state guards and FK checks, for this transaction so the
        // circular task <-> quote references can be deleted without an update
        // that the confirmation check constraint would refuse.
        await client.query('set local session_replication_role = replica');
        const tasks = `select id from public.fulfilment_tasks where deal_id = any($1::uuid[])`;
        await client.query(`delete from public.purchase_cost_approvals where task_id in (${tasks})`, [dealIds]);
        await client.query(`delete from public.purchase_cost_versions where task_id in (${tasks})`, [dealIds]);
        await client.query(`delete from public.purchase_evidence where task_id in (${tasks})`, [dealIds]);
        await client.query(`delete from public.purchase_quotes where task_id in (${tasks})`, [dealIds]);
        await client.query(
          `delete from public.outbox_events where aggregate_id in (
             select id from public.booking_versions where deal_id = any($1::uuid[])
             union select id from public.fulfilment_tasks where deal_id = any($1::uuid[]))`,
          [dealIds],
        );
        await client.query('delete from public.fulfilment_tasks where deal_id = any($1::uuid[])', [dealIds]);
        // B1 (20261118000100): the hotel confirmation also created the Deal's service item, its facts and the traveller snapshot.
        await client.query('delete from public.service_item_facts where service_item_id in (select id from public.service_items where deal_id = any($1::uuid[]))', [dealIds]);
        await client.query('delete from public.service_items where deal_id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.booking_version_travellers where booking_version_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))', [dealIds]);
        await client.query('delete from public.deal_travellers where deal_id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.booking_evidence where deal_id = any($1::uuid[])', [dealIds]);
        await client.query(
          'delete from public.booking_version_commercials where version_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))',
          [dealIds],
        );
        await client.query('delete from public.booking_versions where deal_id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.deal_assignments where deal_id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.supplier_beneficiary_revisions where supplier_id = any($1::uuid[])', [supplierIds]);
        await client.query('delete from public.suppliers where id = any($1::uuid[])', [supplierIds]);
        if (tempMembership) {
          await client.query(
            `delete from public.memberships m using public.branches b
             where m.branch_id = b.id and b.code = 'JDH' and m.user_id = $1 and m.role_code = 'purchase'`,
            [FIXTURE_USERS.accountsJodhpur],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    }
  } finally {
    // Always remove this run's MFA factors, even if data cleanup failed:
    // later suites refuse users with a verified factor they do not know.
    await stack?.cleanup();
  }
});


describe.skipIf(!enabled)('Phase 4 procurement against the real stack', () => {
  let taskId = '';
  let worker: SignedIn;
  let other: SignedIn;
  let quoteId = '';

  it('P4-05: two Purchase people claim at the same time; exactly one gets the task', async () => {
    taskId = await confirmedTask();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => settle<{ alreadyYours: boolean }>(i % 2 ? purchaseB.client : purchaseA.client, 'purchase_task_claim', { p_task_id: taskId })),
    );
    const [row] = await ownerQuery<{ assignee_user_id: string; status: string }>('select assignee_user_id, status from public.fulfilment_tasks where id = $1', [taskId]);
    expect(row!.status).toBe('in_progress');
    worker = row!.assignee_user_id === FIXTURE_USERS.purchaseJodhpur ? purchaseA : purchaseB;
    other = worker === purchaseA ? purchaseB : purchaseA;
    const freshClaims = attempts.filter((a) => a.data && a.data.alreadyYours === false);
    expect(freshClaims).toHaveLength(1);
    for (const a of attempts.filter((x) => x.error)) expect(a.error).toMatchObject({ code: '40001', message: 'task_conflict' });
  });

  it('P4-01: Sales and anon read no Purchase rows; Purchase reads no bank table', async () => {
    const supplier = await rpc<{ supplierId: string }>(worker.client, 'supplier_create', {
      p_entity_id: (await ownerQuery<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id,
      p_fields: { name: `Synthetic Stays ${runTag}`, serviceTypes: ['hotel'] },
    });
    supplierIds.push(supplier.supplierId);
    await rpc(worker.client, 'supplier_add_beneficiary', {
      p_supplier_id: supplier.supplierId,
      p_request_id: crypto.randomUUID(),
      p_fields: { accountHolder: 'Synthetic', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' },
    });
    const quote = await rpc<{ quoteId: string }>(worker.client, 'purchase_quote_add', {
      p_task_id: taskId,
      p_request_id: crypto.randomUUID(),
      p_fields: { supplierId: supplier.supplierId, hotelName: 'Synthetic Hotel (CI fixture)', quotedCostPaise: '2900000' },
    });
    quoteId = quote.quoteId;
    for (const table of ['suppliers', 'purchase_quotes', 'purchase_cost_versions', 'purchase_evidence']) {
      const r = await owner.client.from(table).select('id');
      expect(r.error, table).toBeNull();
      expect(r.data ?? [], table).toEqual([]);
      const a = await stack!.anon().from(table).select('id');
      expect(a.data ?? [], table).toEqual([]);
    }
    const bank = await worker.client.from('supplier_beneficiary_revisions').select('id');
    expect(bank.error?.code).toBe('42501');
    expect(await rpc(owner.client, 'purchase_workspace', { p_task_id: taskId })).toBeNull();
    const ws = await rpc<Record<string, unknown>>(other.client, 'purchase_workspace', { p_task_id: taskId });
    expect(ws.canWork).toBe(false);
    expect(JSON.stringify(ws)).not.toMatch(new RegExp(`${SELLING}|selling|margin|acceptance`, 'i'));
    const got = await rpc<{ beneficiaries: Array<{ accountLast4: string }> }>(worker.client, 'supplier_get', { p_supplier_id: supplier.supplierId });
    expect(got.beneficiaries[0]!.accountLast4).toBe('2222');
    expect(JSON.stringify(got)).not.toContain('000011112222');
  });

  it('P4-05: parallel cost proposals on the same version: one wins, the rest are version_changed', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        settle<{ versionNo: number; created: boolean }>(worker.client, 'purchase_cost_propose', {
          p_task_id: taskId,
          p_quote_id: quoteId,
          p_expected_version_no: 0,
          p_amount_paise: String(2900000 - i),
          p_due_date: null,
          p_note: null,
          p_request_id: crypto.randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.data?.created)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error).toMatchObject({ code: '40001', message: 'version_changed' });
    expect(results.filter((r) => r.error)).toHaveLength(5);
  });

  it('P4-04: the same request id sent in parallel creates one version', async () => {
    const requestId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc<{ versionNo: number; created: boolean }>(worker.client, 'purchase_cost_propose', {
          p_task_id: taskId,
          p_quote_id: quoteId,
          p_expected_version_no: 1,
          p_amount_paise: '2800000',
          p_due_date: '2026-11-25',
          p_note: null,
          p_request_id: requestId,
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.versionNo))).toEqual(new Set([2]));
    const rows = await ownerQuery<{ n: string }>('select count(*)::text as n from public.purchase_cost_versions where task_id = $1', [taskId]);
    expect(rows[0]!.n).toBe('2');
  });

  it('P4-09: private Storage refuses oversize, wrong type and anonymous reads; a missing object is recorded failed', async () => {
    const big = await rpc<{ evidenceId: string; objectPath: string }>(worker.client, 'purchase_evidence_begin', {
      p_task_id: taskId,
      p_kind: 'quote',
      p_file_name: 'quote.pdf',
      p_mime: 'application/pdf',
      p_size_bytes: 4194304,
      p_sha256: 'd'.repeat(64),
    });
    const tooBig = await stack!.admin().storage.from(BUCKET).upload(big.objectPath, new Blob([new Uint8Array(4194305)], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
    expect(tooBig.error).not.toBeNull();
    const wrongType = await stack!.admin().storage.from(BUCKET).upload(`${big.objectPath}-txt`, new Blob(['synthetic'], { type: 'text/plain' }), {
      contentType: 'text/plain',
      upsert: false,
    });
    expect(wrongType.error).not.toBeNull();
    expect(await rpc<{ status: string }>(worker.client, 'purchase_evidence_finish', { p_evidence_id: big.evidenceId, p_ok: true })).toMatchObject({ status: 'failed' });

    const ok = await rpc<{ evidenceId: string; objectPath: string }>(worker.client, 'purchase_evidence_begin', {
      p_task_id: taskId,
      p_kind: 'supplier_confirmation',
      p_file_name: 'supplier.pdf',
      p_mime: 'application/pdf',
      p_size_bytes: 2048,
      p_sha256: 'e'.repeat(64),
    });
    const up = await stack!.admin().storage.from(BUCKET).upload(ok.objectPath, new Blob([new Uint8Array(2048).fill(37)], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
    expect(up.error).toBeNull();
    purchaseObjects.push(ok.objectPath);
    expect(await rpc<{ status: string }>(worker.client, 'purchase_evidence_finish', { p_evidence_id: ok.evidenceId, p_ok: true })).toMatchObject({ status: 'stored' });

    const anonDl = await stack!.anon().storage.from(BUCKET).download(ok.objectPath);
    expect(anonDl.data).toBeNull();
    const salesDl = await owner.client.storage.from(BUCKET).download(ok.objectPath);
    expect(salesDl.data).toBeNull();
    const workerDirect = await worker.client.storage.from(BUCKET).download(ok.objectPath);
    expect(workerDirect.data).toBeNull();
    const publicUrl = stack!.anon().storage.from(BUCKET).getPublicUrl(ok.objectPath).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);
    const salesAuth = await owner.client.rpc('purchase_evidence_authorize_download', { p_evidence_id: ok.evidenceId });
    expect(salesAuth.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    expect(await rpc(other.client, 'purchase_evidence_authorize_download', { p_evidence_id: ok.evidenceId })).toMatchObject({ objectPath: ok.objectPath });
  });

  it('P4-06 / P4-07: parallel supplier confirmations with the same reference: one created, the rest existing', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc<{ outcome: string }>(worker.client, 'purchase_supplier_confirm', { p_task_id: taskId, p_expected_version_no: 2, p_reference: `SYN-${runTag}` }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(4);
    for (const version of [1, 3, 99]) {
      const conflict = await settle(worker.client, 'purchase_supplier_confirm', {
        p_task_id: taskId, p_expected_version_no: version, p_reference: `SYN-${runTag}`,
      });
      expect(conflict.error).toMatchObject({ code: '40001', message: 'task_conflict' });
    }
    const costs = await ownerQuery<{ stage: string; amount_paise: string }>(
      'select stage, amount_paise::text from public.purchase_cost_versions where task_id = $1 order by version_no',
      [taskId],
    );
    expect(costs.map((c) => c.stage)).toEqual(['proposed', 'proposed', 'committed']);
    expect(costs[2]!.amount_paise).toBe('2800000');
    const sales = await rpc<{ status: string }>(owner.client, 'purchase_task_get', { p_task_id: taskId });
    expect(sales.status).toBe('supplier_confirmed');
    expect(JSON.stringify(sales)).not.toMatch(/2800000|Synthetic Stays|SYN-[A-Z0-9]{6}$/);
    // P4-10 through the Data API: status and time only, never the reference or selected quote.
    const row = await owner.client.from('fulfilment_tasks').select('id, status, supplier_confirmed_at').eq('id', taskId);
    expect(row.error).toBeNull();
    expect(row.data).toEqual([{ id: taskId, status: 'supplier_confirmed', supplier_confirmed_at: expect.any(String) }]);
    for (const column of ['supplier_reference', 'selected_quote_id', 'supplier_confirmed_by', '*']) {
      const hidden = await owner.client.from('fulfilment_tasks').select(column).eq('id', taskId);
      expect(hidden.error?.code, column).toBe('42501');
    }
    const direct = await worker.client.from('fulfilment_tasks').update({ supplier_reference: 'x' }).eq('id', taskId).select();
    expect(direct.error?.code).toBe('42501');
  });

  it('A1: the branch manager approves an over-budget cost (parallel repeats are existing) and reassigns; the new assignee releases', async () => {
    const manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, FIXTURE_USERS.managerDelhi);
    const workerId = worker === purchaseA ? FIXTURE_USERS.purchaseJodhpur : FIXTURE_USERS.accountsJodhpur;
    const otherId = worker === purchaseA ? FIXTURE_USERS.accountsJodhpur : FIXTURE_USERS.purchaseJodhpur;
    const task2 = await confirmedTask('-A1');
    await rpc(worker.client, 'purchase_task_claim', { p_task_id: task2 });
    const quote = await rpc<{ quoteId: string }>(worker.client, 'purchase_quote_add', {
      p_task_id: task2,
      p_request_id: crypto.randomUUID(),
      p_fields: { supplierId: supplierIds[0], hotelName: 'Synthetic Hotel (CI fixture)', quotedCostPaise: '3500000' },
    });
    await rpc(worker.client, 'purchase_cost_propose', {
      p_task_id: task2,
      p_quote_id: quote.quoteId,
      p_expected_version_no: 0,
      p_amount_paise: '3500000',
      p_due_date: null,
      p_note: null,
      p_request_id: crypto.randomUUID(),
    });
    const before = await rpc<{ issues: string[]; canApproveOverBudget: boolean; canWork: boolean }>(manager.client, 'purchase_workspace', { p_task_id: task2 });
    expect(before).toMatchObject({ canApproveOverBudget: true, canWork: false });
    expect(before.issues).toContain('over_budget');

    const salesTry = await owner.client.rpc('purchase_cost_approve_over_budget', { p_task_id: task2, p_version_no: 1 });
    expect(salesTry.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    const approvals = await Promise.all(
      Array.from({ length: 4 }, () => settle<{ outcome: string }>(manager.client, 'purchase_cost_approve_over_budget', { p_task_id: task2, p_version_no: 1 })),
    );
    expect(approvals.map((a) => a.error)).toEqual([null, null, null, null]);
    expect(approvals.filter((a) => a.data?.outcome === 'created')).toHaveLength(1);
    expect((await rpc<{ issues: string[] }>(worker.client, 'purchase_workspace', { p_task_id: task2 })).issues).not.toContain('over_budget');
    const salesRows = await owner.client.from('purchase_cost_approvals').select('task_id');
    expect(salesRows.data ?? []).toEqual([]);
    const managerRows = await manager.client.from('purchase_cost_approvals').select('version_no').eq('task_id', task2);
    expect(managerRows.data).toEqual([{ version_no: 1 }]);
    const forged = await manager.client.from('purchase_cost_approvals').insert({ task_id: task2, legal_entity_id: crypto.randomUUID(), version_no: 1, approved_by: FIXTURE_USERS.managerDelhi });
    expect(forged.error?.code).toBe('42501');

    expect(await rpc(manager.client, 'purchase_task_reassign', { p_task_id: task2, p_expected_assignee: workerId, p_to_user_id: otherId })).toMatchObject({ outcome: 'created' });
    const refusedOld = await worker.client.rpc('purchase_task_release', { p_task_id: task2 });
    expect(refusedOld.error).toMatchObject({ code: '40001', message: 'task_conflict' });
    expect(await rpc(other.client, 'purchase_task_release', { p_task_id: task2 })).toMatchObject({ status: 'not_started', outcome: 'created' });
    const [row] = await ownerQuery<{ status: string; assignee_user_id: string | null }>('select status, assignee_user_id from public.fulfilment_tasks where id = $1', [task2]);
    expect(row).toEqual({ status: 'not_started', assignee_user_id: null });
    const active = await ownerQuery(
      `select 1 from public.deal_assignments a join public.fulfilment_tasks t on t.deal_id = a.deal_id
       where t.id = $1 and a.assignment_kind = 'purchase' and a.ended_at is null`,
      [task2],
    );
    expect(active).toEqual([]);
    const kept = await rpc<{ quotes: unknown[]; costVersions: unknown[] }>(worker.client, 'purchase_workspace', { p_task_id: task2 });
    expect([kept.quotes.length, kept.costVersions.length]).toEqual([1, 1]);
  });

  /** Claimed by `worker`, one quote, proposed cost version 1, stored supplier proof: ready to confirm. */
  async function readyTaskReal(suffix: string): Promise<string> {
    const id = await confirmedTask(suffix);
    await rpc(worker.client, 'purchase_task_claim', { p_task_id: id });
    const quote = await rpc<{ quoteId: string }>(worker.client, 'purchase_quote_add', {
      p_task_id: id,
      p_request_id: crypto.randomUUID(),
      p_fields: { supplierId: supplierIds[0], hotelName: 'Synthetic Hotel (CI fixture)', quotedCostPaise: '2500000' },
    });
    await rpc(worker.client, 'purchase_cost_propose', {
      p_task_id: id, p_quote_id: quote.quoteId, p_expected_version_no: 0, p_amount_paise: '2500000',
      p_due_date: null, p_note: null, p_request_id: crypto.randomUUID(),
    });
    const ev = await rpc<{ evidenceId: string; objectPath: string }>(worker.client, 'purchase_evidence_begin', {
      p_task_id: id, p_kind: 'supplier_confirmation', p_file_name: 'supplier.pdf', p_mime: 'application/pdf',
      p_size_bytes: 1024, p_sha256: 'f'.repeat(64),
    });
    const up = await stack!.admin().storage.from(BUCKET).upload(ev.objectPath, new Blob([new Uint8Array(1024).fill(41)], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (up.error) throw up.error;
    purchaseObjects.push(ev.objectPath);
    await rpc(worker.client, 'purchase_evidence_finish', { p_evidence_id: ev.evidenceId, p_ok: true });
    return id;
  }

  /** F2: exactly one audit row, one committed cost and one outbox row for the task. */
  async function confirmationRecords(id: string) {
    const [row] = await ownerQuery<{ audits: number; committed: number; outbox: number; reference: string | null }>(
      `select
         (select count(*)::int from public.audit_events where action = 'purchase.supplier_confirmed' and target_id = $1) as audits,
         (select count(*)::int from public.purchase_cost_versions where task_id = $1 and stage = 'committed') as committed,
         (select count(*)::int from public.outbox_events where event_type = 'fulfilment.supplier_confirmed' and aggregate_id = $1) as outbox,
         (select supplier_reference from public.fulfilment_tasks where id = $1) as reference`,
      [id],
    );
    return row!;
  }

  it('Phase 6 F3: identical, stale and wrong-version confirmations together; settled results only', async () => {
    const id = await readyTaskReal('-F3A');
    const ref = `SYN-F3A-${runTag}`;
    const requests = [
      { kind: 'exact', version: 1 }, { kind: 'stale', version: 0 }, { kind: 'exact', version: 1 },
      { kind: 'wrong', version: 99 }, { kind: 'exact', version: 1 }, { kind: 'stale', version: 0 }, { kind: 'wrong', version: 7 },
    ] as const;
    const settled = await Promise.allSettled(
      requests.map((r) => rpc<{ outcome: string }>(worker.client, 'purchase_supplier_confirm', { p_task_id: id, p_expected_version_no: r.version, p_reference: ref })),
    );
    const exact = settled.filter((_, i) => requests[i]!.kind === 'exact');
    // Never assume the first-listed request wins: exactly one exact request creates, the others are existing.
    expect(exact.every((r) => r.status === 'fulfilled')).toBe(true);
    const outcomes = exact.map((r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome).sort();
    expect(outcomes).toEqual(['created', 'existing', 'existing']);
    for (const [i, r] of settled.entries()) {
      if (requests[i]!.kind === 'exact') continue;
      expect(r.status).toBe('rejected');
      const reason = (r as PromiseRejectedResult).reason as { code: string; message: string };
      expect(reason.code).toBe('40001');
      // Before the winner commits it is version_changed; after, task_conflict. Both are 40001.
      expect(['version_changed', 'task_conflict']).toContain(reason.message);
    }
    expect(await confirmationRecords(id)).toEqual({ audits: 1, committed: 1, outbox: 1, reference: ref });
  });

  it('Phase 6 F3: two different valid references together: one created, stored identity consistent, the other conflicts', async () => {
    const id = await readyTaskReal('-F3B');
    const refs = [`SYN-F3B-A-${runTag}`, `SYN-F3B-B-${runTag}`];
    const order = [refs[0]!, refs[1]!, refs[1]!, refs[0]!];
    const settled = await Promise.allSettled(
      order.map((ref) => rpc<{ outcome: string }>(worker.client, 'purchase_supplier_confirm', { p_task_id: id, p_expected_version_no: 1, p_reference: ref })),
    );
    const created = settled.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'created');
    expect(created).toHaveLength(1);
    const records = await confirmationRecords(id);
    expect(records).toMatchObject({ audits: 1, committed: 1, outbox: 1 });
    const stored = records.reference!;
    expect(refs).toContain(stored);
    for (const [i, r] of settled.entries()) {
      if (order[i] === stored) {
        // Same identity as the winner: created once, otherwise existing.
        expect(r.status).toBe('fulfilled');
      } else {
        expect(r.status).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: '40001', message: 'task_conflict' });
      }
    }
    // Retries after the race: the stored identity is existing, the other identity conflicts.
    expect(await rpc(worker.client, 'purchase_supplier_confirm', { p_task_id: id, p_expected_version_no: 1, p_reference: stored })).toMatchObject({ outcome: 'existing' });
    const other = refs.find((r) => r !== stored)!;
    const conflict = await settle(worker.client, 'purchase_supplier_confirm', { p_task_id: id, p_expected_version_no: 1, p_reference: other });
    expect(conflict.error).toMatchObject({ code: '40001', message: 'task_conflict' });
    expect(await confirmationRecords(id)).toMatchObject({ audits: 1, committed: 1, outbox: 1, reference: stored });
  });
});
