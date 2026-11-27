#!/usr/bin/env node
// SYNTHETIC load and measurement for the Accounts phase 3 speed tests
// (contract accounts-phase3-2026-11-12, section 16.5 = plan §9), LOCAL stack only.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local> SUPABASE_SECRET_KEY=<local> \
//   LOCAL_FIXTURE_PASSWORD=<seed-local password> TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   node scripts/perf/accounts3-load.mjs [--seconds 600] [--measure] [--runs 30]
//
// Default (background load): 10 virtual users (fixture accounts, fixture
// password, enrolled TOTP, aal2) each perform about one Phase 3 read every
// 2 s: small balances (presets), Bills to check, Deal messages card, change
// requests and history, rate contracts list and lookup, Tally file preview,
// bell read. Read-only: it never writes business rows.
//
// --measure: Phase 1 §12.7 conditions — 9 users keep the background load
// running while the measuring user runs every database measure of the 16.5
// table: one warm-up, then --runs (30) timed runs; prints median and p95 next
// to the target. Reads go through the Data API as the signed-in user; the
// write measures (Tally file of 1,000 entries, matching upload of 1,000 rows,
// timer tick with empty queues, the change request steps) run through the
// database as that user's claims inside a ROLLED-BACK transaction, so nothing
// stays. Results: test-results/accounts3-load.json.
//
// Refuses any non-loopback URL and any database not labelled 'test' with the
// seed-local markers; never reads .env files. Do not run it next to
// accounts-load.mjs with --measure (both sign in some of the same people).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { seedEnvironmentRefusal, seedTargetRefusal } from '../lib/seed-guard.mjs';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const password = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const seconds = Number(arg('--seconds', 600));
const runs = Number(arg('--runs', 30));
const measureMode = process.argv.includes('--measure');

function fail(message) {
  console.error(`accounts3-load: ${message}`);
  process.exit(1);
}
if (process.env.APP_ENV === 'production') fail('refusing: APP_ENV=production');
const target = seedTargetRefusal(url, databaseUrl);
if (target) fail(target);
if (!publishable || !secret || !password) fail('SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY and LOCAL_FIXTURE_PASSWORD are required (local stack values)');

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
{
  const env = await db.query('select s.environment from public.deployment_settings s where s.id');
  const refusal = seedEnvironmentRefusal(env.rows.map((r) => r.environment));
  if (refusal) fail(refusal);
  const seeded = await db.query(`select count(*)::int as n from public.deals where reference like 'SYN-PERF-%'`);
  if (seeded.rows[0].n < 10000) fail('run scripts/perf/accounts-volume.sql first (SYN-PERF Deals missing)');
  const p3 = await db.query(`select (select count(*) from public.rate_contracts where note = 'SYN-PERF rate contract')::int as n`).catch(() => ({ rows: [{ n: 0 }] }));
  if (p3.rows[0].n < 2000) fail('run scripts/perf/accounts3-volume.sql first (Phase 3 volume missing)');
}

// 10 users: the lead's Phase 2 fixture people (inactive by default: activated for the run and put back) and five Phase 1
// fixture users. The first entry is the measuring user in --measure mode (Accounts).
const USERS = [
  ['accounts.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000014', 'accounts'],
  ['accounts.jodhpur.3@example.test', 'a0000000-0000-4000-8000-000000000015', 'accounts'],
  ['manager.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000016', 'manager'],
  ['manager.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000017', 'manager'],
  ['visa.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000020', 'visa'],
  ['accounts.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000006', 'accounts'],
  ['manager.delhi@example.test', 'a0000000-0000-4000-8000-000000000005', 'manager'],
  ['purchase.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000003', 'purchase'],
  ['sales.delhi.a@example.test', 'a0000000-0000-4000-8000-000000000001', 'sales'],
  ['admin.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000007', 'admin'],
];
const activated = (await db.query(`update public.memberships set status = 'active', deactivated_at = null
  where user_id = any($1::uuid[]) and status = 'inactive' returning id`, [USERS.map((u) => u[1])])).rows.map((r) => r.id);
const restoreMemberships = async () => {
  if (activated.length) await db.query(`update public.memberships set status = 'inactive', deactivated_at = now() where id = any($1::uuid[])`, [activated]);
};
process.on('SIGINT', async () => { await restoreMemberships(); process.exit(130); });
process.on('SIGTERM', async () => { await restoreMemberships(); process.exit(143); });
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(url, secret, { auth: noPersist });

async function signInAal2(email, userId) {
  const client = createClient(url, publishable, { auth: noPersist });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of factors?.factors ?? []) if (f.friendly_name?.startsWith('perf3-load-')) await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
  const { data, error: enrolError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `perf3-load-${Date.now()}` });
  if (enrolError) throw enrolError;
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(data.totp.secret), digits: 6, period: 30 }).generate();
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code });
  if (verified.error) throw verified.error;
  return client;
}

// Seeded references (16.5 seed). ASSUMPTION: column names of the Phase 3 tables as written in accounts3-volume.sql.
const refs = (await db.query(`select
    (select array_agg(deal_id::text) from (select deal_id from public.customer_messages order by random() limit 200) x) as msg_deals,
    (select array_agg(deal_id::text) from (select deal_id from public.booking_change_requests where ref_no like 'CR-2026-6%' order by random() limit 200) x) as cr_deals,
    (select array_agg(json_build_object('supplier', r.supplier_id, 'hotel', r.hotel_id, 'room', t.id)::text) from (select * from public.rate_contracts
       where note = 'SYN-PERF rate contract' and status = 'active' order by random() limit 200) r
       join lateral (select id from public.hotel_room_types t where t.hotel_id = r.hotel_id and t.status = 'active' limit 1) t on true) as contracts,
    (select array_agg(t.id::text) from (select t.id from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
       where d.reference like 'SYN-PERF-%' and t.department = 'purchase' order by random() limit 200) t) as hotel_tasks,
    (select id::text from public.legal_entities where code = 'HOLIDAY_CHACHA') as entity`)).rows[0];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const contract = () => JSON.parse(pick(refs.contracts));
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);

const mix = {};
let errors = 0;
const count = (name, ok) => {
  mix[name] = (mix[name] ?? 0) + 1;
  if (!ok) errors += 1;
};
async function rpc(client, name, fn, args) {
  const { error } = await client.rpc(fn, args);
  count(name, !error);
  return error;
}

// Read calls (Data API). ASSUMPTION: filter keys `preset` (small balances, documents list) as in the Phase 2 lists.
const READS = {
  smallBalances: (c) => rpc(c, 'small balances', 'small_balances_list', { p_filter: {}, p_after: null, p_limit: 50 }),
  smallBalancesToApprove: (c) => rpc(c, 'small balances · to approve', 'small_balances_list', { p_filter: { preset: 'to_approve' }, p_after: null, p_limit: 50 }),
  billsToCheck: (c) => rpc(c, 'Bills to check', 'customer_documents_list', { p_filter: { preset: 'toCheck' }, p_after: null, p_limit: 50 }),
  dealMessages: (c) => rpc(c, 'Deal messages card', 'deal_customer_messages', { p_deal_id: pick(refs.msg_deals) }),
  changeHistory: (c) => rpc(c, 'change history', 'deal_change_history', { p_deal_id: pick(refs.cr_deals) }),
  changeRequests: (c) => rpc(c, 'Deal change requests', 'deal_change_requests', { p_deal_id: pick(refs.cr_deals) }),
  changeList: (c) => rpc(c, 'change requests · to approve', 'change_requests_list', { p_filter: { preset: 'to_approve' }, p_after: null, p_limit: 50 }),
  rateContracts: (c) => rpc(c, 'rate contracts list', 'rate_contracts_list', { p_filter: {}, p_after: null, p_limit: 50 }),
  rateLookup: (c) => {
    const k = contract();
    return rpc(c, 'contract rate lookup', 'rate_contract_lookup', { p_task_id: pick(refs.hotel_tasks), p_supplier_id: k.supplier, p_hotel_id: k.hotel,
      p_room_type_id: k.room, p_meal_plan_code: 'CP' });
  },
  tallyPreview: (c) => rpc(c, 'Tally file preview', 'accounts_tally_file_preview', { p_entity: refs.entity, p_from: daysAgo(30), p_to: today(),
    p_kinds: ['journal_entry', 'supplier_payment', 'write_off'], p_branch_ids: null }),
  monthly: (c) => rpc(c, 'write-off monthly', 'write_off_monthly', { p_month: `${today().slice(0, 7)}-01` }),
  adminMessages: (c) => rpc(c, 'Settings › Customer messages', 'admin_customer_messages', { p_entity: refs.entity }),
  bell: (c) => rpc(c, 'bell read', 'notice_inbox', { p_after_seq: null, p_limit: 50 }),
};
const ACTIONS = {
  accounts: [READS.smallBalances, READS.billsToCheck, READS.dealMessages, READS.changeHistory, READS.tallyPreview, READS.rateContracts],
  manager: [READS.smallBalancesToApprove, READS.changeList, READS.changeHistory, READS.dealMessages, READS.monthly, READS.rateContracts],
  purchase: [READS.rateContracts, READS.rateLookup],
  sales: [READS.dealMessages, READS.changeRequests],
  visa: [],
  admin: [READS.adminMessages, READS.monthly],
};

console.log(`accounts3-load: signing in ${USERS.length} synthetic users on ${new URL(url).host} ...`);
const clients = [];
for (const [email, id, role] of USERS) clients.push({ role, id, client: await signInAal2(email, id) });
console.log(`accounts3-load: ${clients.length} users at aal2`);

function backgroundLoad(users, until) {
  return Promise.all(users.map(async ({ role, client }) => {
    while (Date.now() < until()) {
      const action = pick([...(ACTIONS[role] ?? []), READS.bell]);
      await action(client).catch(() => count('exception', false));
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
    }
  }));
}

const report = () => console.log(`accounts3-load: mix ${JSON.stringify(mix)} errors ${errors}`);

if (!measureMode) {
  const end = Date.now() + seconds * 1000;
  const timer = setInterval(report, 30_000);
  await backgroundLoad(clients, () => end);
  clearInterval(timer);
  report();
  await restoreMemberships();
  await db.end();
  process.exit(0);
}

// ----------------------------------------------------------------------------- --measure
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const results = [];
let stop = false;
const loadDone = backgroundLoad(clients.slice(1), () => (stop ? 0 : Number.MAX_SAFE_INTEGER));
const [measurer] = clients;
const byRole = (role) => clients.find((c) => c.role === role);

async function timed(measure, targetMs, once, n = runs) {
  await once();
  const xs = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const failed = await once();
    xs.push(performance.now() - t0);
    if (failed) errors += 1;
  }
  const row = { measure, medianMs: Math.round(pct(xs, 50)), p95Ms: Math.round(pct(xs, 95)), targetMs, pass: pct(xs, 95) <= targetMs };
  results.push(row);
  console.log(`${row.pass ? 'pass' : 'MISS'}  ${measure.padEnd(52)} median ${String(row.medianMs).padStart(6)} ms  p95 ${String(row.p95Ms).padStart(6)} ms  target p95 ≤ ${targetMs} ms`);
  return row;
}
/** One statement as `userId` (PostgREST claims) inside a rolled-back transaction; `setup` (owner) gives the parameters. */
async function rolledBack(userId, sql, setup) {
  await db.query('begin');
  try {
    const params = setup ? await setup() : [];
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: userId ? 'authenticated' : 'service_role',
      aal: 'aal2', aud: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 60 }, { method: 'totp', timestamp: Math.floor(Date.now() / 1000) - 60 }] })]);
    await db.query(userId ? 'set local role authenticated' : 'set local role service_role');
    const t0 = performance.now();
    await db.query(sql, params);
    return performance.now() - t0;
  } finally {
    await db.query('rollback');
  }
}
async function timedDb(measure, targetMs, userId, sql, setup, n = runs) {
  await rolledBack(userId, sql, setup);
  const xs = [];
  for (let i = 0; i < n; i += 1) xs.push(await rolledBack(userId, sql, setup).catch(() => { errors += 1; return Number.POSITIVE_INFINITY; }));
  const row = { measure, medianMs: Math.round(pct(xs, 50)), p95Ms: Math.round(pct(xs, 95)), targetMs, pass: pct(xs, 95) <= targetMs };
  results.push(row);
  console.log(`${row.pass ? 'pass' : 'MISS'}  ${measure.padEnd(52)} median ${String(row.medianMs).padStart(6)} ms  p95 ${String(row.p95Ms).padStart(6)} ms  target p95 ≤ ${targetMs} ms`);
}
const err = async (p) => Boolean(await p);
const ACC_ID = USERS[0][1];
const switchOn = (sql) => async () => { await db.query(sql); return []; };

console.log(`accounts3-load: measuring ${runs} runs after one warm-up with ${clients.length - 1} background users`);
// Reads (Data API, signed in, aal2).
await timed('Small balances list (A)', 300, () => err(READS.smallBalances(measurer.client)));
await timed('Small balances list (M, to_approve)', 300, () => err(READS.smallBalancesToApprove(byRole('manager').client)));
await timed('Bills to check list (preset toCheck)', 300, () => err(READS.billsToCheck(measurer.client)));
await timed('"Messages to customer" card (adds to Deal page)', 150, () => err(READS.dealMessages(measurer.client)));
await timed('Contract rate lookup', 300, () => err(READS.rateLookup(byRole('purchase').client)));
await timed('Change history view', 1500, () => err(READS.changeHistory(byRole('manager').client)));
await timed('Tally file preview (about 1,000 entries)', 10_000, () => err(READS.tallyPreview(measurer.client)), Math.min(runs, 10));

// Writes (rolled back).
const entity = refs.entity;
const accSwitches = `update public.accounts_settings set tally_xml_enabled = true, tally_company_name = 'Synthetic Perf Company', row_version = row_version + 1
  where legal_entity_id = '${entity}'`;
await timedDb('Tally file, 1,000 entries (create)', 10_000, ACC_ID,
  'select public.accounts_tally_file_create($1, $2::date, $3::date, $4::text[], $5::uuid[], true, $6, gen_random_uuid()) as r', async () => {
    await switchOn(accSwitches)();
    return [entity, daysAgo(365), today(), ['journal_entry'], null, 'Synthetic perf: speed run, include again']; // inside the 366-day cap (Addendum L5)
  }, Math.min(runs, 5));
const voucherRows = (await db.query(`select l."values"->>'narration' as narration, l.line_no from public.tally_export_lines l
  join public.tally_exports e on e.id = l.export_id where e.format = 'xml' order by e.created_at desc, l.line_no limit 1000`)).rows
  // Staged row keys of accounts_tally_match_stage (proved by tests/db/acc3-c-tally-file.test.ts): tnTag, voucherRef, voucherDate, voucherType,
  // amountPaise; the tag is the TN:<file>/<line> at the end of the frozen narration.
  .map((r, i) => ({ tnTag: /TN:\S+$/.exec(r.narration ?? '')?.[0] ?? null, voucherRef: `PERF-${i + 1}`, voucherDate: today(), voucherType: 'Receipt',
    amountPaise: '100000' }));
await timedDb('Tally matching upload preview, 1,000 vouchers (stage)', 15_000, ACC_ID,
  'select public.accounts_tally_match_stage($1, $2, $3, $4::jsonb, gen_random_uuid()) as r', async () => {
    await switchOn(accSwitches)();
    return [entity, 'perf-daybook.xml', Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64), JSON.stringify(voucherRows)];
  }, Math.min(runs, 5));
await timedDb('Timer tick with empty queues', 2000, null, 'select public.timer_tick() as r', async () => {
  // Empty queues inside the run (rolled back): nothing due.
  await db.query(`update public.customer_messages set next_attempt_at = now() + interval '1 day' where status in ('queued', 'sending')`);
  return [];
});
// Change request steps (16.5: each ≤ 800 ms), Addendum O2 order: create (draft) -> open the change version -> fill -> submit -> the Manager
// approves. The perf Deals are skeletal (no supplier-confirmed hotel, no facts row, no booking contact): each rolled-back run first confirms one
// quoted perf hotel task and gives its item a facts row (SYNTHETIC FIXTURE STEP, not timed); create and open are timed here, and submit,
// approval and reconfirm on fresh complete bookings in tests/e2e/accounts3-speed.real.e2e.ts.
const crDeal = (await db.query(`select d.id, d.owner_user_id as owner, t.id as task, t.service_item_id as item from public.deals d
  join public.fulfilment_tasks t on t.deal_id = d.id and t.department = 'purchase' and t.status = 'in_progress' and t.closed_state is null
  join public.accounts_booking_reviews a on a.deal_id = d.id and a.status = 'approved'
  where d.reference like 'SYN-PERF-%' and exists (select 1 from public.purchase_quotes q where q.task_id = t.id)
    and not exists (select 1 from public.booking_change_requests c where c.deal_id = d.id)
  order by d.reference desc limit 1`)).rows[0];
if (!crDeal) throw new Error('no perf Deal with an approved review, a quoted hotel task and no change request: run accounts3-volume.sql');
const crFields = JSON.stringify({ kind: 'change', itemIds: [crDeal.item], changeSummary: 'Synthetic perf: room type to a suite',
  reason: 'Synthetic perf: customer asked for a bigger room' });
async function committedHotel() {
  await db.query('update public.booking_change_settings set changes_enabled = true where true');
  await db.query(`update public.fulfilment_tasks t set status = 'supplier_confirmed', supplier_reference = 'SYN-PERF-CONF',
        supplier_confirmed_by = t.assignee_user_id, supplier_confirmed_at = now(),
        selected_quote_id = (select q.id from public.purchase_quotes q where q.task_id = t.id order by q.created_at limit 1) where t.id = $1`, [crDeal.task]);
  await db.query('set local session_replication_role = replica');
  await db.query(`insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash)
        select i.id, v.id, i.legal_entity_id, f.facts, 20000000, encode(sha256(convert_to(f.facts::text, 'UTF8')), 'hex')
        from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
        join public.booking_versions v on v.deal_id = t.deal_id and v.status = 'confirmed'
        cross join lateral (select jsonb_build_object('hotelName', 'Synthetic Perf Hotel', 'city', 'Synthetic City', 'checkIn', v.trip_start::text,
          'checkOut', (v.trip_start + 3)::text, 'rooms', 1, 'adults', 2, 'roomType', 'Synthetic Deluxe', 'mealPlan', 'Breakfast') as facts) f
        where t.id = $1 on conflict do nothing`, [crDeal.task]);
  await db.query('set local session_replication_role = origin');
}
/** One statement as `userId` inside the open run transaction; role back to the owner afterwards. */
async function asIn(userId, sql, params) {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal2',
    aud: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 60 }, { method: 'totp', timestamp: Math.floor(Date.now() / 1000) - 60 }] })]);
  await db.query('set local role authenticated');
  const r = (await db.query(sql, params)).rows[0].r;
  await db.query('reset role');
  return r;
}
const CR_CREATE = 'select public.booking_change_request_create($1, $2::jsonb, gen_random_uuid()) as r';
await timedDb('Change request create (G2, draft)', 800, crDeal.owner, CR_CREATE, async () => { await committedHotel(); return [crDeal.id, crFields]; });
await timedDb('Change version open (G5)', 800, crDeal.owner, 'select public.booking_change_open_version($1, gen_random_uuid()) as r', async () => {
  await committedHotel();
  const cr = await asIn(crDeal.owner, CR_CREATE, [crDeal.id, crFields]);
  return [cr.changeRequestId ?? cr.id];
});
// ASSUMPTION: reconfirm record and apply need a stored proof and a change version; they are measured in
// tests/supabase/speed-accounts-phase3.real.test.ts, which builds them inside each rolled-back run.

stop = true;
await loadDone;
report();
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/accounts3-load.json', JSON.stringify({ at: new Date().toISOString(), runs, users: clients.length, mix, errors, results }, null, 2));
await restoreMemberships();
await db.end();
process.exit(results.every((r) => r.pass) ? 0 : 2);
