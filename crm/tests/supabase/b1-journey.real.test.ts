import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfirmBookingResult, MyWorkCounts, OpenDraftResult, ServiceItemAddResult } from '@/modules/fulfilment/contracts';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * B1 journey against the REAL local Supabase stack (PostgREST + GoTrue +
 * Postgres + Storage), through the Data API RPCs the app wrappers call:
 *   package intake (hotel, transfer, activity, flight) -> 4 tasks, exactly
 *   once even when 8 confirmations race; hotel-only package -> 1 task; a
 *   second confirm -> 'existing', nothing new; Purchase JSON carries no price;
 *   Flight sees its task and takes it; my_work_counts equals the queue lengths.
 *   B1.2 (20261120000100, DEC-38): every adult traveller gets a real identity
 *   proof (begin under the Sales session with the consent tick, a tiny
 *   synthetic file uploaded to the private traveller-id-proofs bucket with the
 *   service client, finish), as the Book now screen does.
 *
 * Setup (local owner connection only): switches service_items_enabled on for
 * the run and back off afterwards (audited by trigger as direct_sql); gives
 * Synthetic Entity B Sales a 'flight' membership in HOLIDAY_CHACHA for the run (the Visa
 * Jodhpur user is left with an open recovery case by session-recovery.real.test.ts, so a later
 * aal2 session for it is denied); creates synthetic
 * Deals (SYN-B1-*) owned by Synthetic Sales Delhi A and removes them with
 * their rows afterwards (guard triggers disabled inside the cleanup
 * transaction, as booking.real.test.ts does). audit_events stay.
 *
 * Runs only when the real-stack configuration and TEST_DATABASE_URL are
 * present; FAILS (never skips) when REQUIRE_REAL_STACK=1 and anything is
 * missing.
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
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('B1 real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const SELLING = '7654321';
const BUDGETS = { hotel: '3000000', transfer: '250000', activity: '90000', flight: '2200000' } as const;
const HOTEL = { hotelName: 'Synthetic Hotel (CI fixture)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-12', rooms: 1, adults: 2, roomType: null, mealPlan: null, children: null, inclusions: null, specialRequests: null };
const TRANSFER = { route: 'Synthetic airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 2, pickupTime: null, notes: null };
const ACTIVITY = { name: 'Synthetic city walk', city: 'Synthetic City', date: '2026-12-11', participants: 2, time: null, notes: null };
const FLIGHT = { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10' }, { from: 'JDH', to: 'DEL', date: '2026-12-12' }], passengers: 2, preferredTime: null, cabin: null, notes: null };
const TRAVELLERS = [{ fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 }];
const FORBIDDEN = /sell|margin|commercial|evidence|traveller(?!Count)|fullName|review|receipt|payer/i;

const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const dealIds: string[] = [];
const objectPaths: string[] = [];
const idProofPaths: string[] = [];
let switchWasOn = false;
let flightMembershipAdded = false;

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function createDeal(suffix: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic B1 CI deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
     returning id`,
    [`SYN-B1-${runTag}-${suffix}`, FIXTURE_USERS.salesDelhiA],
  );
  dealIds.push(row!.id);
  return row!.id;
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

/** One owner transaction on a fresh connection (committed, or rolled back on error). */
async function ownerTransaction(fn: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    await client.query('begin');
    await fn(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

let owner: SignedIn;
let purchase: SignedIn;
let flight: SignedIn;

/** Synthetic JPEG-looking bytes (magic FF D8 FF), 1 KiB; no real image or person. */
const ID_PROOF_BYTES = (() => {
  const bytes = new Uint8Array(1024).fill(42);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
})();

/** One traveller identity proof the real way: begin (Sales session, consent), Storage upload (service client), finish. */
async function storeIdProof(dealId: string, seq: number): Promise<void> {
  const begun = await rpc<{ fileId: string; objectPath: string | null; status: string }>(owner.client, 'traveller_id_proof_begin', {
    p_deal_id: dealId, p_seq: seq, p_request_id: crypto.randomUUID(), p_consent: true,
    p_file_name: `synthetic-id-proof-${seq}.jpg`, p_mime: 'image/jpeg', p_size_bytes: ID_PROOF_BYTES.length, p_sha256: 'd'.repeat(64),
  });
  expect(begun.status).toBe('pending_upload');
  const upload = await stack!.admin().storage.from('traveller-id-proofs')
    .upload(begun.objectPath!, new Blob([ID_PROOF_BYTES], { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: false });
  if (upload.error) throw upload.error;
  idProofPaths.push(begun.objectPath!);
  expect((await rpc<{ status: string }>(owner.client, 'traveller_id_proof_finish', { p_file_id: begun.fileId, p_ok: true })).status).toBe('stored');
}

/** Package draft with the given services, travellers, selling total and one acceptance proof really stored. */
async function readyPackage(dealId: string, types: Array<keyof typeof BUDGETS>): Promise<{ versionId: string; hash: string; items: ServiceItemAddResult[] }> {
  const opened = await rpc<OpenDraftResult>(owner.client, 'booking_open_draft', { p_deal_id: dealId });
  expect(opened.created).toBe(true);
  let rowVersion = opened.rowVersion;
  const facts: Record<string, unknown> = { hotel: HOTEL, transfer: TRANSFER, activity: ACTIVITY, flight: FLIGHT };
  const items: ServiceItemAddResult[] = [];
  for (const type of types) {
    const added = await rpc<ServiceItemAddResult>(owner.client, 'service_item_add', {
      p_version_id: opened.versionId, p_expected_row_version: rowVersion, p_service_type: type, p_facts: facts[type],
      p_purchase_budget_paise: BUDGETS[type], p_request_id: crypto.randomUUID(),
    });
    rowVersion = added.rowVersion;
    items.push(added);
  }
  rowVersion = (await rpc<{ rowVersion: number }>(owner.client, 'deal_travellers_save', { p_deal_id: dealId, p_expected_row_version: rowVersion, p_travellers: TRAVELLERS })).rowVersion;
  // B1.2 (DEC-38): a stored identity proof per adult (does not change the version's row version or hash).
  for (const t of TRAVELLERS.filter((x) => x.type === 'adult')) await storeIdProof(dealId, t.seq);
  await rpc(owner.client, 'booking_save_draft', {
    p_version_id: opened.versionId, p_expected_row_version: rowVersion,
    p_facts: { hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null, inclusions: null, specialRequests: null, purchaseBudgetPaise: null },
    p_selling_total_paise: SELLING, p_selling_total_provided: true,
  });
  // B1.1 (20261119000100): trip, confirmed contact + billing proposal, participation, payment plan.
  rowVersion += 1;
  rowVersion = (await rpc<{ rowVersion: number }>(owner.client, 'booking_trip_save', {
    p_version_id: opened.versionId, p_expected_row_version: rowVersion,
    p_fields: { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' },
  })).rowVersion;
  rowVersion = (await rpc<{ rowVersion: number }>(owner.client, 'booking_customer_save', {
    p_version_id: opened.versionId, p_expected_row_version: rowVersion,
    p_contact: { contactName: 'Synthetic Contact', mobile: '9876500011', email: null, contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null },
    p_billing: { billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null },
    p_billing_expected_row_version: 0, p_request_id: crypto.randomUUID(),
  })).rowVersion;
  for (const item of items) {
    rowVersion = (await rpc<{ rowVersion: number }>(owner.client, 'service_item_travellers_save', {
      p_item_id: item.itemId, p_version_id: opened.versionId, p_expected_row_version: rowVersion, p_seqs: TRAVELLERS.map((t) => t.seq),
    })).rowVersion;
  }
  await rpc(owner.client, 'booking_instalments_save', {
    p_version_id: opened.versionId, p_expected_row_version: rowVersion,
    p_instalments: [{ seq: 1, label: 'Full payment', amountPaise: String(SELLING), dueDate: '2026-11-01' }],
  });
  const ev = await rpc<{ evidenceId: string; objectPath: string }>(owner.client, 'booking_begin_evidence', {
    p_version_id: opened.versionId, p_kind: 'acceptance_message', p_file_name: 'acceptance.pdf', p_mime: 'application/pdf', p_size_bytes: 1024, p_sha256: 'e'.repeat(64),
  });
  const upload = await stack!.admin().storage.from('booking-evidence')
    .upload(ev.objectPath, new Blob([new Uint8Array(1024).fill(41)], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
  if (upload.error) throw upload.error;
  objectPaths.push(ev.objectPath);
  expect((await rpc<{ status: string }>(owner.client, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true })).status).toBe('stored');
  const ready = await rpc<{ ready: boolean; issues: string[]; contentHash: string }>(owner.client, 'booking_readiness', { p_version_id: opened.versionId });
  expect(ready.issues).toEqual([]);
  return { versionId: opened.versionId, hash: ready.contentHash, items };
}

beforeAll(async () => {
  if (!enabled) return;
  const [s] = await ownerQuery<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
  switchWasOn = s!.on;
  // Reason and update on one connection, so the settings audit row carries the reason (review E10).
  await ownerQuery(
    `select set_config('tripnavigate.change_reason', 'b1-journey.real.test.ts: switch on for the run', false);
     update public.workflow_settings set service_items_enabled = true where id`,
  );
  const flightRows = await ownerQuery(
    `select 1 from public.memberships m join public.legal_entities e on e.id = m.legal_entity_id
     where m.user_id = $1 and e.code = 'HOLIDAY_CHACHA' and m.role_code = 'flight'`, [FIXTURE_USERS.salesEntityB],
  );
  if (flightRows.length === 0) {
    await ownerQuery(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, 'flight', 'active'
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'JDH'`, [FIXTURE_USERS.salesEntityB],
    );
    flightMembershipAdded = true;
  }
  owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  purchase = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, FIXTURE_USERS.purchaseJodhpur);
  flight = await stack!.signInAal2(FIXTURE_EMAILS.salesEntityB, FIXTURE_USERS.salesEntityB);
});

afterAll(async () => {
  // Every step runs even when an earlier one fails, and the stack cleanup
  // (MFA factors of this run) always runs last: a failed row cleanup must not
  // leave factors behind for the next suites. The first error is re-thrown.
  let firstError: unknown = null;
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      firstError ??= error;
    }
  };
  try {
    if (enabled && objectPaths.length > 0) {
      await step(() => stack!.admin().storage.from('booking-evidence').remove(objectPaths));
    }
    if (enabled && idProofPaths.length > 0) {
      await step(() => stack!.admin().storage.from('traveller-id-proofs').remove(idProofPaths));
    }
    if (enabled && dealIds.length > 0) {
      // Rows of this run's Deals, children first. Local disposable database only:
      // session_replication_role = replica suspends the guard, append-only and
      // foreign-key triggers for this one transaction (as the finance real suites do).
      await step(() => ownerTransaction(async (client) => {
        await client.query('set local session_replication_role = replica');
        const versions = 'select id from public.booking_versions where deal_id = any($1::uuid[])';
        const tasks = 'select id from public.fulfilment_tasks where deal_id = any($1::uuid[])';
        const items = 'select id from public.service_items where deal_id = any($1::uuid[])';
        const statements = [
          `delete from public.outbox_events where aggregate_id in (${versions} union ${tasks})`,
          // B1.1 rows that hang off tasks, versions, items or travellers.
          `delete from public.department_cost_entries where task_id in (${tasks})`,
          `delete from public.visa_applications where task_id in (${tasks})`,
          `delete from public.department_evidence where task_id in (${tasks})`,
          'delete from public.customer_payment_claims where deal_id = any($1::uuid[])',
          `delete from public.accounts_booking_reviews where booking_version_id in (${versions})`,
          'delete from public.fulfilment_tasks where deal_id = any($1::uuid[])',
          `delete from public.service_item_travellers where service_item_id in (${items})`,
          'delete from public.booking_version_contacts where deal_id = any($1::uuid[])',
          'delete from public.booking_version_instalments where deal_id = any($1::uuid[])',
          `delete from public.booking_version_traveller_identities where booking_version_id in (${versions})`,
          'delete from public.traveller_identities where deal_id = any($1::uuid[])',
          // B1.2: identity proofs (guard suspended by replica mode) before travellers and versions.
          'delete from public.traveller_id_proofs where deal_id = any($1::uuid[])',
          'delete from public.customer_billing_profiles where deal_id = any($1::uuid[])',
          'delete from public.finance_deal_heads where deal_id = any($1::uuid[])',
          `delete from public.service_item_facts where service_item_id in (${items})`,
          'delete from public.service_items where deal_id = any($1::uuid[])',
          `delete from public.booking_version_travellers where booking_version_id in (${versions})`,
          'delete from public.deal_travellers where deal_id = any($1::uuid[])',
          'delete from public.booking_evidence where deal_id = any($1::uuid[])',
          `delete from public.booking_version_commercials where version_id in (${versions})`,
          'delete from public.booking_versions where deal_id = any($1::uuid[])',
          'delete from public.deal_assignments where deal_id = any($1::uuid[])',
          'delete from public.deals where id = any($1::uuid[])',
        ];
        for (const sql of statements) await client.query(sql, [dealIds]);
      }));
    }
    if (enabled) {
      // Settings and the extra membership in their own transaction, so they are
      // restored even when the row cleanup failed.
      await step(() => ownerTransaction(async (client) => {
        if (flightMembershipAdded) {
          await client.query(
            `delete from public.memberships m using public.legal_entities e
             where e.id = m.legal_entity_id and m.user_id = $1 and e.code = 'HOLIDAY_CHACHA' and m.role_code = 'flight'`, [FIXTURE_USERS.salesEntityB],
          );
        }
        await client.query(`select set_config('tripnavigate.change_reason', 'b1-journey.real.test.ts: restore the switch after the run', true)`);
        await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
      }));
    }
  } finally {
    await step(async () => stack?.cleanup());
  }
  if (firstError) throw firstError;
});

describe.skipIf(!enabled)('B1 journey against the real stack', () => {
  let packageDeal = '';
  let taskIds: string[] = [];
  let flightTaskId = '';

  it('package intake -> 4 tasks, exactly once across 8 racing confirmations', async () => {
    packageDeal = await createDeal('PKG');
    const ready = await readyPackage(packageDeal, ['hotel', 'transfer', 'activity', 'flight']);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc<ConfirmBookingResult>(owner.client, 'booking_confirm', { p_version_id: ready.versionId, p_expected_content_hash: ready.hash })),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(7);
    taskIds = results[0]!.taskIds!;
    expect(taskIds).toHaveLength(4);
    for (const r of results) expect(r.taskIds).toEqual(taskIds);
    const tasks = await ownerQuery<{ service_purpose: string; task_key: string; service_item_id: string }>(
      'select t.service_purpose, t.task_key, t.service_item_id from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id where t.deal_id = $1 order by i.item_no', [packageDeal],
    );
    expect(tasks.map((t) => t.service_purpose)).toEqual(['hotel', 'transfer', 'activity', 'flight']);
    for (const t of tasks) expect(t.task_key).toBe(`item:${t.service_item_id}:${t.service_purpose}`);
    flightTaskId = taskIds[3]!;
    const outbox = await ownerQuery<{ event_type: string }>('select event_type from public.outbox_events where aggregate_id = any($1::uuid[])', [taskIds]);
    expect(outbox).toHaveLength(4);
  });

  it('a second press is existing and creates nothing', async () => {
    const [version] = await ownerQuery<{ versionId: string }>('select id as "versionId" from public.booking_versions where deal_id = $1', [packageDeal]);
    const again = await rpc<ConfirmBookingResult>(owner.client, 'booking_confirm', { p_version_id: version!.versionId, p_expected_content_hash: 'f'.repeat(64) });
    expect(again).toMatchObject({ outcome: 'existing', taskIds });
    const [count] = await ownerQuery<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where deal_id = $1', [packageDeal]);
    expect(Number(count!.n)).toBe(4);
  });

  it('hotel-only package -> 1 task', async () => {
    const dealId = await createDeal('HOT');
    const ready = await readyPackage(dealId, ['hotel']);
    const result = await rpc<ConfirmBookingResult>(owner.client, 'booking_confirm', { p_version_id: ready.versionId, p_expected_content_hash: ready.hash });
    expect(result.outcome).toBe('created');
    expect(result.taskIds).toEqual([result.taskId]);
    const [count] = await ownerQuery<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where deal_id = $1', [dealId]);
    expect(Number(count!.n)).toBe(1);
  });

  it('Purchase sees no price and no flight budget; Flight sees its task and takes it', async () => {
    const list = await rpc<Array<Record<string, unknown>>>(purchase.client, 'purchase_task_list');
    const mine = list.filter((t) => taskIds.includes(t.taskId as string));
    expect(mine.map((t) => t.serviceType).sort()).toEqual(['activity', 'hotel', 'transfer']);
    expect([...allKeys(mine)].filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(JSON.stringify(mine)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.flight}|Synthetic Traveller`));
    const detail = await rpc<Record<string, unknown>>(purchase.client, 'purchase_task_get', { p_task_id: taskIds[0] });
    expect(detail).toMatchObject({ serviceType: 'hotel', purchaseBudgetPaise: BUDGETS.hotel, canClaim: true });
    expect(await rpc(purchase.client, 'purchase_task_get', { p_task_id: flightTaskId })).toBeNull();
    const direct = await purchase.client.from('service_items').select('id');
    expect(direct.error).toBeNull();
    expect(direct.data ?? []).toEqual([]);

    const queue = await rpc<Array<Record<string, unknown>>>(flight.client, 'flight_task_list');
    const task = queue.find((t) => t.taskId === flightTaskId)!;
    expect(task).toMatchObject({ itemTitle: 'DEL to JDH, JDH to DEL', purchaseBudgetPaise: BUDGETS.flight, status: 'not_started' });
    expect([...allKeys(queue)].filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(JSON.stringify(queue)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|Synthetic Traveller`));
    const flightDetail = await rpc<Record<string, unknown>>(flight.client, 'flight_task_get', { p_task_id: flightTaskId });
    expect(flightDetail).toMatchObject({ travellerCount: 2, canClaim: true });
    const claim = await flight.client.rpc('flight_task_claim', { p_task_id: flightTaskId });
    expect(claim.error).toBeNull();
    expect(claim.data).toMatchObject({ status: 'in_progress', assignedToYou: true, alreadyYours: false });
    // Review E1/E2: after the claim the Flight person is a Deal assignee and still sees no Purchase task.
    expect(await rpc<unknown[]>(flight.client, 'purchase_task_list')).toEqual([]);
    const wrong = await purchase.client.rpc('flight_task_claim', { p_task_id: flightTaskId });
    expect(wrong.error).toMatchObject({ code: '42501', message: 'not_authorized' });
  });

  it('Home counts equal the queue lengths', async () => {
    const purchaseQueue = await rpc<Array<{ status: string; assignedToYou: boolean }>>(purchase.client, 'purchase_task_list');
    const purchaseCounts = await rpc<MyWorkCounts>(purchase.client, 'my_work_counts');
    expect(purchaseCounts.waitingForMe).toBe(purchaseQueue.filter((t) => t.status === 'not_started' || (t.status === 'in_progress' && t.assignedToYou)).length);
    expect(purchaseCounts.receiptsToVerify).toBeNull();
    const flightQueue = await rpc<Array<{ status: string; assignedToYou: boolean }>>(flight.client, 'flight_task_list');
    const flightCounts = await rpc<MyWorkCounts>(flight.client, 'my_work_counts');
    expect(flightCounts.waitingForMe).toBe(flightQueue.filter((t) => t.status === 'not_started' || (t.status === 'in_progress' && t.assignedToYou)).length);
    const ownerCounts = await rpc<MyWorkCounts>(owner.client, 'my_work_counts');
    const [draftRow] = await ownerQuery<{ drafts: string }>(
      `select count(*)::text as drafts from public.booking_versions v join public.deals d on d.id = v.deal_id
       where v.status = 'draft' and d.owner_user_id = $1 and d.removed_at is null`, [FIXTURE_USERS.salesDelhiA],
    );
    expect(ownerCounts.waitingForMe).toBeGreaterThanOrEqual(Number(draftRow!.drafts));
    expect(ownerCounts).toMatchObject({ receiptsToVerify: null, requestsToApprove: null });
    const summary = await rpc<Array<Record<string, unknown>>>(owner.client, 'deal_service_summary', { p_deal_ids: [packageDeal] });
    expect(summary[0]).toMatchObject({ dealId: packageDeal, total: 4, byState: { planned: 0, notStarted: 3, inProgress: 1, supplierConfirmed: 0 }, fulfilled: false });
  });
});
