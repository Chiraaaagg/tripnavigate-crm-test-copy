import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Booking form against the REAL local Supabase stack (PostgREST + GoTrue +
 * Postgres + Storage), migrations 20261124000100/0110/0120, through the Data
 * API RPCs the app calls:
 *   * the new tables (per-person prices, supplier estimates, item files) are
 *     refused through the Data API for every role;
 *   * two concurrent price saves on one draft: exactly one wins, the other is
 *     version_changed;
 *   * a flight screenshot really uploaded to the private service-item-files
 *     bucket: stored only when Storage holds it, downloadable only through the
 *     authorized command (Sales, the Flight assignee), never directly from
 *     Storage with a staff session, never for Purchase;
 *   * 8 racing confirmations of a new-form draft create one task per service,
 *     exactly once; Purchase and Flight task JSON carry no price or total.
 *
 * Setup (local owner connection only), as b1-journey.real.test.ts: the
 * service_items_enabled switch on for the run and restored afterwards; a
 * 'flight' membership for Synthetic Entity B Sales for the run; synthetic
 * Deals (SYN-BF-*) owned by Synthetic Sales Delhi A, removed with their rows
 * and storage objects afterwards. audit_events stay.
 *
 * Runs only when the real-stack configuration and TEST_DATABASE_URL are
 * present; FAILS (never skips) when REQUIRE_REAL_STACK=1 and anything is missing.
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
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('booking form real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

/** Synthetic odd amounts (Mercury part B): ₹12,345.67 per adult, total ₹24,691.34. */
const ADULT_SALE = '1234567';
const TOTAL = '2469134';
const SEARCH = /1234567|12,345\.67|12345\.67|234567|2469134|24,691\.34|salePaise|markupPaise|purchasePaise|sellingTotal|"prices"/;
const LINES = [
  { category: 'adult', quantity: 2, purchasePaise: '1000000', markupPaise: '234567', salePaise: ADULT_SALE },
  { category: 'child_bed', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null },
  { category: 'child_no_bed', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null },
  { category: 'infant', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null },
];
const TRIP = { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-12', paxTotal: 2, children: 0, infants: 0 };
const HOTEL = { hotelName: 'Synthetic Hotel (CI fixture)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-12', rooms: 1, adults: 2 };
const FLIGHT = { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', arrivalDate: '2026-12-10', airline: 'Synthetic Air', flightNo: 'SA 101' }], passengers: 2 };
const TRAVELLERS = [{ fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 }];
const NEW_TABLES = ['booking_version_price_lines', 'service_item_cost_estimates', 'service_item_files'];

const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const dealIds: string[] = [];
const storage: Record<string, string[]> = { 'booking-evidence': [], 'traveller-id-proofs': [], 'service-item-files': [] };
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

async function createDeal(suffix: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic booking form CI deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
     returning id`,
    [`SYN-BF-${runTag}-${suffix}`, FIXTURE_USERS.salesDelhiA],
  );
  dealIds.push(row!.id);
  return row!.id;
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

let owner: SignedIn;
let purchase: SignedIn;
let flight: SignedIn;

const bytes = (n: number, magic: number[]) => {
  const b = new Uint8Array(n).fill(42);
  b.set(magic);
  return b;
};

/** Begin (Sales session), upload with the service client, finish. */
async function upload(bucket: string, objectPath: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
  const result = await stack!.admin().storage.from(bucket).upload(objectPath, new Blob([body], { type: contentType }), { contentType, upsert: false });
  if (result.error) throw result.error;
  storage[bucket]!.push(objectPath);
}

/** A new-form draft with travellers, party, the given services (hotel with an estimate) and contact/Bill To. */
async function formDraft(dealId: string, types: Array<'hotel' | 'flight'>) {
  const s = await rpc<{ versionId: string; rowVersion: number; formRules: number }>(owner.client, 'booking_form_start', { p_deal_id: dealId });
  expect(s.formRules).toBe(2);
  let rv = (await rpc<{ rowVersion: number }>(owner.client, 'deal_travellers_save',
    { p_deal_id: dealId, p_expected_row_version: s.rowVersion, p_travellers: TRAVELLERS })).rowVersion;
  const items: string[] = [];
  for (const type of types) {
    const saved = await rpc<{ itemId: string; rowVersion: number }>(owner.client, 'booking_service_save', {
      p_version_id: s.versionId, p_expected_row_version: rv, p_item_id: null, p_service_type: type,
      p_facts: type === 'hotel' ? HOTEL : FLIGHT, p_purchase_budget_paise: null,
      p_estimate: type === 'hotel' ? { kind: 'hotel', roomRatePaise: '450000', extraBedRatePaise: null, noBedRatePaise: null } : { kind: 'flight', fareTotalPaise: '900000' },
      p_participants: [1, 2], p_request_id: crypto.randomUUID(),
    });
    rv = saved.rowVersion;
    items.push(saved.itemId);
  }
  rv = (await rpc<{ rowVersion: number }>(owner.client, 'booking_trip_save', { p_version_id: s.versionId, p_expected_row_version: rv, p_fields: TRIP })).rowVersion;
  rv = (await rpc<{ rowVersion: number }>(owner.client, 'booking_customer_save', {
    p_version_id: s.versionId, p_expected_row_version: rv,
    p_contact: { contactName: 'Synthetic Contact', mobile: '9876500011', email: null, contactConfirmed: true, bookingFor: 'individual',
      payerDifferent: false, payerName: null, customerType: 'individual', market: 'india' },
    p_billing: { billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
      postalCode: '342001', gstin: null, billToType: 'personal', phone: '9876500011', email: null },
    p_billing_expected_row_version: 0, p_request_id: crypto.randomUUID(),
  })).rowVersion;
  return { versionId: s.versionId, rowVersion: rv, items };
}

/** Prices, plan, identity proofs and the acceptance message; returns the readiness hash. */
async function finish(dealId: string, versionId: string, rowVersion: number): Promise<string> {
  let rv = (await rpc<{ rowVersion: number; sellingTotalPaise: string }>(owner.client, 'booking_prices_save',
    { p_version_id: versionId, p_expected_row_version: rowVersion, p_lines: LINES, p_request_id: crypto.randomUUID() })).rowVersion;
  rv = (await rpc<{ rowVersion: number }>(owner.client, 'booking_instalments_save', { p_version_id: versionId, p_expected_row_version: rv,
    p_instalments: [{ seq: 1, label: 'Full payment', amountPaise: TOTAL, dueDate: '2026-11-01' }] })).rowVersion;
  void rv;
  for (const t of TRAVELLERS) {
    const proof = await rpc<{ fileId: string; objectPath: string }>(owner.client, 'traveller_id_proof_begin', {
      p_deal_id: dealId, p_seq: t.seq, p_request_id: crypto.randomUUID(), p_consent: true, p_file_name: `synthetic-id-${t.seq}.jpg`,
      p_mime: 'image/jpeg', p_size_bytes: 1024, p_sha256: 'd'.repeat(64) });
    await upload('traveller-id-proofs', proof.objectPath, bytes(1024, [0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    await rpc(owner.client, 'traveller_id_proof_finish', { p_file_id: proof.fileId, p_ok: true });
  }
  const ev = await rpc<{ evidenceId: string; objectPath: string }>(owner.client, 'booking_begin_evidence', {
    p_version_id: versionId, p_kind: 'acceptance_message', p_file_name: 'acceptance.pdf', p_mime: 'application/pdf', p_size_bytes: 1024,
    p_sha256: 'e'.repeat(64) });
  await upload('booking-evidence', ev.objectPath, bytes(1024, [0x25, 0x50, 0x44, 0x46]), 'application/pdf');
  await rpc(owner.client, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
  const ready = await rpc<{ issues: string[]; contentHash: string }>(owner.client, 'booking_readiness', { p_version_id: versionId });
  expect(ready.issues).toEqual([]);
  return ready.contentHash;
}

beforeAll(async () => {
  if (!enabled) return;
  const [s] = await ownerQuery<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
  switchWasOn = s!.on;
  await ownerQuery(
    `select set_config('tripnavigate.change_reason', 'booking-form.real.test.ts: switch on for the run', false);
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
  let firstError: unknown = null;
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      firstError ??= error;
    }
  };
  try {
    if (enabled) {
      for (const [bucket, paths] of Object.entries(storage)) {
        if (paths.length > 0) await step(() => stack!.admin().storage.from(bucket).remove(paths));
      }
    }
    if (enabled && dealIds.length > 0) {
      // Local disposable database only: replica mode suspends guard and foreign-key triggers for this transaction.
      await step(() => ownerTransaction(async (client) => {
        await client.query('set local session_replication_role = replica');
        const versions = 'select id from public.booking_versions where deal_id = any($1::uuid[])';
        const tasks = 'select id from public.fulfilment_tasks where deal_id = any($1::uuid[])';
        const items = 'select id from public.service_items where deal_id = any($1::uuid[])';
        const statements = [
          `delete from public.outbox_events where aggregate_id in (${versions} union ${tasks})`,
          `delete from public.accounts_booking_reviews where booking_version_id in (${versions})`,
          'delete from public.fulfilment_tasks where deal_id = any($1::uuid[])',
          // Booking form rows.
          'delete from public.service_item_files where deal_id = any($1::uuid[])',
          `delete from public.service_item_cost_estimates where service_item_id in (${items})`,
          'delete from public.booking_version_price_lines where deal_id = any($1::uuid[])',
          `delete from public.service_item_travellers where service_item_id in (${items})`,
          'delete from public.booking_version_contacts where deal_id = any($1::uuid[])',
          'delete from public.booking_version_instalments where deal_id = any($1::uuid[])',
          `delete from public.booking_version_traveller_identities where booking_version_id in (${versions})`,
          'delete from public.traveller_identities where deal_id = any($1::uuid[])',
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
      await step(() => ownerTransaction(async (client) => {
        if (flightMembershipAdded) {
          await client.query(
            `delete from public.memberships m using public.legal_entities e
             where e.id = m.legal_entity_id and m.user_id = $1 and e.code = 'HOLIDAY_CHACHA' and m.role_code = 'flight'`, [FIXTURE_USERS.salesEntityB],
          );
        }
        await client.query(`select set_config('tripnavigate.change_reason', 'booking-form.real.test.ts: restore the switch after the run', true)`);
        await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
      }));
    }
  } finally {
    await step(async () => stack?.cleanup());
  }
  if (firstError) throw firstError;
});

describe.skipIf(!enabled)('booking form against the real stack', () => {
  let dealId = '';
  let versionId = '';
  let rowVersion = 0;
  let items: string[] = [];
  let screenshotId = '';
  let screenshotPath = '';

  it('the new tables are refused through the Data API for every role', async () => {
    for (const signed of [owner, purchase, flight]) {
      for (const table of NEW_TABLES) {
        const { error } = await signed.client.from(table).select('*').limit(1);
        expect(error, table).toMatchObject({ code: '42501' });
      }
    }
  });

  it('two concurrent price saves on one draft: one wins, the other is version_changed', async () => {
    dealId = await createDeal('FORM');
    const d = await formDraft(dealId, ['hotel', 'flight']);
    versionId = d.versionId;
    items = d.items;
    const attempts = await Promise.all([0, 1].map(() => owner.client.rpc('booking_prices_save', {
      p_version_id: versionId, p_expected_row_version: d.rowVersion, p_lines: LINES, p_request_id: crypto.randomUUID() })));
    expect(attempts.filter((a) => a.error === null)).toHaveLength(1);
    expect(attempts.filter((a) => a.error !== null).map((a) => a.error)).toEqual([expect.objectContaining({ code: '40001', message: 'version_changed' })]);
    const winner = attempts.find((a) => a.error === null)!.data as { rowVersion: number; sellingTotalPaise: string };
    expect(winner.sellingTotalPaise).toBe(TOTAL);
    rowVersion = winner.rowVersion;
  });

  it('a flight screenshot is stored only when Storage holds it and is downloaded only through the authorized command', async () => {
    const file = { fileName: 'flight option.png', mime: 'image/png', sizeBytes: 2048, sha256: 'a'.repeat(64) };
    const begun = await rpc<{ fileId: string; objectPath: string; status: string }>(owner.client, 'service_item_file_begin',
      { p_item_id: items[1], p_version_id: versionId, p_kind: 'flight_screenshot', p_file: file, p_request_id: crypto.randomUUID() });
    expect(begun.status).toBe('pending_upload');
    // Staff sessions cannot write or read the private bucket directly.
    const direct = await owner.client.storage.from('service-item-files')
      .upload(begun.objectPath, new Blob([bytes(2048, [0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), { contentType: 'image/png' });
    expect(direct.error).not.toBeNull();
    await upload('service-item-files', begun.objectPath, bytes(2048, [0x89, 0x50, 0x4e, 0x47]), 'image/png');
    expect((await rpc<{ status: string }>(owner.client, 'service_item_file_finish', { p_file_id: begun.fileId, p_ok: true })).status).toBe('stored');
    screenshotId = begun.fileId;
    screenshotPath = begun.objectPath;
    const authorized = await rpc<{ objectPath: string; mime: string }>(owner.client, 'service_item_file_authorize_download', { p_file_id: screenshotId });
    expect(authorized).toMatchObject({ objectPath: screenshotPath, mime: 'image/png' });
    // The server signs with the secret key only after the command authorized the caller.
    const signed = await stack!.admin().storage.from('service-item-files').createSignedUrl(authorized.objectPath, 60);
    expect(signed.error).toBeNull();
    expect((await fetch(signed.data!.signedUrl)).status).toBe(200);
    for (const signedIn of [owner, purchase]) {
      const fromStorage = await signedIn.client.storage.from('service-item-files').download(screenshotPath);
      expect(fromStorage.error).not.toBeNull();
      const signedByStaff = await signedIn.client.storage.from('service-item-files').createSignedUrl(screenshotPath, 60);
      expect(signedByStaff.error).not.toBeNull();
    }
    const refused = await purchase.client.rpc('service_item_file_authorize_download', { p_file_id: screenshotId });
    expect(refused.error).toMatchObject({ code: '42501', message: 'not_authorized' });
  });

  it('8 racing confirmations create one task per service exactly once; department JSON carries no price', async () => {
    const hash = await finish(dealId, versionId, rowVersion);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      rpc<{ outcome: string; taskIds: string[] }>(owner.client, 'booking_confirm', { p_version_id: versionId, p_expected_content_hash: hash })));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    const taskIds = results[0]!.taskIds;
    expect(taskIds).toHaveLength(2);
    for (const r of results) expect(r.taskIds).toEqual(taskIds);
    const [count] = await ownerQuery<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where deal_id = $1', [dealId]);
    expect(Number(count!.n)).toBe(2);

    const purchaseList = await rpc<unknown[]>(purchase.client, 'purchase_task_list');
    expect(JSON.stringify(purchaseList)).not.toMatch(SEARCH);
    await rpc(purchase.client, 'purchase_task_claim', { p_task_id: taskIds[0] });
    const hotelTask = await rpc<Record<string, unknown>>(purchase.client, 'purchase_task_get', { p_task_id: taskIds[0] });
    expect(hotelTask.estimate).toEqual({ kind: 'hotel', roomRatePaise: '450000', extraBedRatePaise: null, noBedRatePaise: null });
    expect(JSON.stringify(hotelTask)).not.toMatch(SEARCH);
    expect(await rpc(purchase.client, 'booking_form_get', { p_deal_id: dealId })).toBeNull();

    await rpc(flight.client, 'flight_task_claim', { p_task_id: taskIds[1] });
    const flightTask = await rpc<Record<string, unknown>>(flight.client, 'flight_task_get', { p_task_id: taskIds[1] });
    expect(flightTask.estimate).toEqual({ kind: 'flight', fareTotalPaise: '900000' });
    expect((flightTask.files as Array<{ fileId: string }>).map((f) => f.fileId)).toEqual([screenshotId]);
    expect(JSON.stringify(flightTask)).not.toMatch(SEARCH);
    const flightDownload = await rpc<{ objectPath: string }>(flight.client, 'service_item_file_authorize_download', { p_file_id: screenshotId });
    expect(flightDownload.objectPath).toBe(screenshotPath);
  });
});
