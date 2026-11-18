#!/usr/bin/env node
// SYNTHETIC background load for the Accounts-phase speed tests (contract
// accounts-phase-2026-11-10, section 12.7 = plan 17.3), LOCAL stack only.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local> SUPABASE_SECRET_KEY=<local> \
//   LOCAL_FIXTURE_PASSWORD=<seed-local password> TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   node scripts/perf/accounts-load.mjs [--seconds 600]
//
// 9 background virtual users (fixture accounts, signed in with the fixture
// password and an enrolled TOTP factor, aal2 like real staff) each perform
// about one action every 2 s, mixing: workspace page, exact search, dues
// page, bell read, mark read, receipt record, claim report, Tally match.
// Writes go only to SYN-PERF Deals of the speed seed. Prints its action mix
// and error count every 30 s and at the end. Refuses any non-loopback URL and
// any database not labelled 'test' with the seed-local markers; never reads
// .env files.
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { seedEnvironmentRefusal, seedTargetRefusal } from '../lib/seed-guard.mjs';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const password = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1] || 600);

function fail(message) {
  console.error(`accounts-load: ${message}`);
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
}

// Fixture users: 3 Accounts-capable, 2 Sales, 2 Managers, Purchase, Visa (the measured user is separate).
const USERS = [
  ['accounts.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000006', 'accounts'],
  ['sales.delhi.a@example.test', 'a0000000-0000-4000-8000-000000000001', 'sales'],
  ['sales.delhi.b@example.test', 'a0000000-0000-4000-8000-000000000002', 'sales'],
  ['manager.delhi@example.test', 'a0000000-0000-4000-8000-000000000005', 'manager'],
  ['manager.ahmedabad@example.test', 'a0000000-0000-4000-8000-000000000013', 'manager'],
  ['purchase.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000003', 'purchase'],
  ['visa.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000011', 'visa'],
  ['sales.ahmedabad@example.test', 'a0000000-0000-4000-8000-000000000004', 'sales'],
  ['moved.staff@example.test', 'a0000000-0000-4000-8000-000000000009', 'sales'],
];
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(url, secret, { auth: noPersist });

async function signInAal2(email, userId) {
  const client = createClient(url, publishable, { auth: noPersist });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  // Remove earlier load-test factors of this synthetic user, then enrol a fresh one.
  const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of factors?.factors ?? []) if (f.friendly_name?.startsWith('perf-load-')) await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
  const { data, error: enrolError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `perf-load-${Date.now()}` });
  if (enrolError) throw enrolError;
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(data.totp.secret), digits: 6, period: 30 }).generate();
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code });
  if (verified.error) throw verified.error;
  return client;
}

const refs = (await db.query(`select
    (select array_agg(reference) from (select reference from public.deals where reference like 'SYN-PERF-%' order by random() limit 200) x) as deals,
    (select array_agg(receipt_no) from (select receipt_no from public.customer_receipts order by random() limit 200) x) as receipts,
    (select array_agg(id::text) from (select id from public.deals where reference like 'SYN-PERF-%' order by random() limit 200) x) as deal_ids,
    (select array_agg(id::text) from (select e.id from public.finance_journal_entries e where not exists
       (select 1 from public.tally_records t where t.record_id = e.id) order by random() limit 500) x) as entries,
    (select id::text from public.branches where code = 'DEL' limit 1) as del`)).rows[0];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const owned = {};
for (const [, id, role] of USERS) {
  if (role !== 'sales') continue;
  const rows = await db.query(`select id::text from public.deals where owner_user_id = $1 and reference like 'SYN-PERF-%' order by random() limit 200`, [id]);
  owned[id] = rows.rows.map((r) => r.id);
}
if (!Object.values(owned).some((xs) => xs.length)) fail('no SYN-PERF Deal is owned by a fixture Sales user: re-run scripts/perf/accounts-volume.sql (current version)');
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const mix = {};
let errors = 0;
const count = (name, ok) => {
  mix[name] = (mix[name] ?? 0) + 1;
  if (!ok) errors += 1;
};
async function rpc(client, name, fn, args) {
  const { error } = await client.rpc(fn, args);
  count(name, !error);
}

const ACTIONS = {
  accounts: [
    (c) => rpc(c, 'workspace page', 'accounts_records', { p_filter: {}, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'search', 'accounts_records', { p_filter: { q: pick(refs.receipts) }, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'dues page', 'accounts_dues', { p_filter: { branchId: refs.del }, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'Tally match', 'accounts_tally_match', { p_kind: 'journal_entry', p_record_id: refs.entries.pop() ?? pick(refs.entries),
      p_expected_row_version: 0, p_fields: { voucherRef: `SYN-LOAD-${Date.now() % 100000}`, voucherDate: today() }, p_request_id: crypto.randomUUID() }),
  ],
  sales: [
    (c) => rpc(c, 'dues page', 'accounts_dues', { p_filter: {}, p_after: null, p_limit: 50 }),
    // Claims only on Deals this Sales user owns (the seed gives fixture Sales users every tenth Deal).
    (c, id) => (owned[id]?.length ? rpc(c, 'claim report', 'payment_claim_report', { p_deal_id: pick(owned[id]), p_fields: { mode: 'cash', amountPaise: '50000',
      paidOn: today(), payerName: 'Synthetic Load Payer' }, p_request_id: crypto.randomUUID() }) : rpc(c, 'dues page', 'accounts_dues',
      { p_filter: {}, p_after: null, p_limit: 50 })),
  ],
  manager: [
    (c) => rpc(c, 'workspace page', 'accounts_records', { p_filter: {}, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'dues page', 'accounts_dues', { p_filter: {}, p_after: null, p_limit: 50 }),
  ],
  purchase: [(c) => rpc(c, 'Purchase home', 'purchase_home_counts', {})],
  visa: [(c) => rpc(c, 'bell read', 'notice_inbox', { p_after_seq: null, p_limit: 50 })],
};
const COMMON = [
  (c) => rpc(c, 'bell read', 'notice_inbox', { p_after_seq: null, p_limit: 50 }),
  (c) => rpc(c, 'mark read', 'notice_mark_all_read', {}),
];

console.log(`accounts-load: signing in ${USERS.length} synthetic users on ${new URL(url).host} ...`);
const clients = [];
for (const [email, id, role] of USERS) clients.push({ role, id, client: await signInAal2(email, id) });
console.log(`accounts-load: ${clients.length} users at aal2; running ${seconds} s, about one action per user every 2 s`);

const end = Date.now() + seconds * 1000;
const report = () => console.log(`accounts-load: mix ${JSON.stringify(mix)} errors ${errors}`);
const timer = setInterval(report, 30_000);
await Promise.all(clients.map(async ({ role, id, client }) => {
  while (Date.now() < end) {
    const action = pick([...(ACTIONS[role] ?? []), ...COMMON]);
    await action(client, id).catch(() => count('exception', false));
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
  }
}));
clearInterval(timer);
report();
await db.end();
