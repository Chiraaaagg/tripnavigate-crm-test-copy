#!/usr/bin/env node
// SYNTHETIC background load for the Accounts phase 2 speed tests (contract
// accounts-phase2-2026-11-11, section 12.5 = plan C13), LOCAL stack only.
// Runs next to scripts/perf/accounts-load.mjs (Phase 1 actions); together they
// give the 10 background users of the Phase 1 conditions.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local> SUPABASE_SECRET_KEY=<local> \
//   LOCAL_FIXTURE_PASSWORD=<seed-local password> TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   node scripts/perf/accounts2-load.mjs [--seconds 600]
//
// Virtual users (fixture accounts, fixture password, enrolled TOTP, aal2)
// each perform about one read every 2 s, mixing the Phase 2 reads: documents
// list (filters, next page), Deal Documents card, refund lists (presets),
// Deal refund card, supplier register search, hotel suppliers, Tally mapping,
// bell read. Read-only: it never writes business rows. Prints its action mix
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
  console.error(`accounts2-load: ${message}`);
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
  const docs = await db.query(`select count(*)::int as n from public.customer_documents where number like 'SYN-PERF-%'`);
  if (docs.rows[0].n < 8000) fail('run scripts/perf/accounts2-volume.sql first (Phase 2 volume missing)');
}

// Fixture users: 3 Accounts-capable, 2 Sales, 2 Managers, Purchase, Visa (the measured user is separate).
// The lead's Phase 2 fixture people (supabase/fixtures/accounts_phase2_people.sql), so this load can run next to
// accounts-load.mjs (which signs in the 9 Phase 1 fixture users) without the two enrolling factors for the same people.
// Their memberships start inactive: switched on for the run and put back at the end.
const USERS = [
  ['accounts.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000014', 'accounts'],
  ['accounts.jodhpur.3@example.test', 'a0000000-0000-4000-8000-000000000015', 'accounts'],
  ['manager.jodhpur@example.test', 'a0000000-0000-4000-8000-000000000016', 'manager'],
  ['manager.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000017', 'manager'],
  ['visa.jodhpur.2@example.test', 'a0000000-0000-4000-8000-000000000020', 'visa'],
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
  // Remove earlier load-test factors of this synthetic user, then enrol a fresh one.
  const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of factors?.factors ?? []) if (f.friendly_name?.startsWith('perf2-load-')) await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
  const { data, error: enrolError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `perf2-load-${Date.now()}` });
  if (enrolError) throw enrolError;
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(data.totp.secret), digits: 6, period: 30 }).generate();
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code });
  if (verified.error) throw verified.error;
  return client;
}

const refs = (await db.query(`select
    (select array_agg(deal_id::text) from (select deal_id from public.customer_documents where number like 'SYN-PERF-%' order by random() limit 200) x) as doc_deals,
    (select array_agg(deal_id::text) from (select deal_id from public.customer_refund_requests where ref_no like 'RF-2026-8%' order by random() limit 200) x) as refund_deals,
    (select array_agg(hotel_id::text) from (select hotel_id from public.supplier_hotels order by random() limit 200) x) as hotels,
    (select array_agg(reference) from (select reference from public.deals where reference like 'SYN-PERF-%' order by random() limit 200) x) as refs,
    (select id::text from public.legal_entities where code = 'HOLIDAY_CHACHA') as entity`)).rows[0];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

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
const list = (c, name, filter) => rpc(c, name, 'customer_documents_list', { p_filter: filter, p_after: null, p_limit: 50 });

const ACTIONS = {
  accounts: [
    (c) => list(c, 'documents list', {}),
    (c) => list(c, 'documents list · to release', { toRelease: true }),
    (c) => list(c, 'documents list · deal', { dealReference: pick(refs.refs) }),
    (c) => rpc(c, 'Deal documents card', 'deal_customer_documents', { p_deal_id: pick(refs.doc_deals) }),
    (c) => rpc(c, 'refund list · payout due', 'refund_requests_list', { p_filter: { preset: 'payout_due' }, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'supplier refunds due', 'supplier_refunds_due', { p_filter: {}, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'Deal refund card', 'deal_refunds', { p_deal_id: pick(refs.refund_deals) }),
    (c) => rpc(c, 'Tally mapping', 'tally_mapping_list', { p_entity: refs.entity }),
  ],
  manager: [
    (c) => rpc(c, 'refund list · to approve', 'refund_requests_list', { p_filter: { preset: 'to_approve' }, p_after: null, p_limit: 50 }),
    (c) => list(c, 'documents list · Manager', {}),
    (c) => rpc(c, 'supplier register', 'supplier_register', { p_filter: {}, p_after: null, p_limit: 50 }),
  ],
  sales: [
    (c) => rpc(c, 'refund list · own', 'refund_requests_list', { p_filter: {}, p_after: null, p_limit: 50 }),
  ],
  purchase: [
    (c) => rpc(c, 'supplier register · search', 'supplier_register', { p_filter: { q: 'synthetic perf stays 0' }, p_after: null, p_limit: 50 }),
    (c) => rpc(c, 'hotel suppliers', 'hotel_suppliers', { p_hotel_id: pick(refs.hotels) }),
  ],
  visa: [(c) => rpc(c, 'bell read', 'notice_inbox', { p_after_seq: null, p_limit: 50 })],
};
const COMMON = [(c) => rpc(c, 'bell read', 'notice_inbox', { p_after_seq: null, p_limit: 50 })];

console.log(`accounts2-load: signing in ${USERS.length} synthetic users on ${new URL(url).host} ...`);
const clients = [];
for (const [email, id, role] of USERS) clients.push({ role, id, client: await signInAal2(email, id) });
console.log(`accounts2-load: ${clients.length} users at aal2; running ${seconds} s, about one read per user every 2 s`);

const end = Date.now() + seconds * 1000;
const report = () => console.log(`accounts2-load: mix ${JSON.stringify(mix)} errors ${errors}`);
const timer = setInterval(report, 30_000);
await Promise.all(clients.map(async ({ role, client }) => {
  while (Date.now() < end) {
    const action = pick([...(ACTIONS[role] ?? []), ...COMMON]);
    await action(client).catch(() => count('exception', false));
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
  }
}));
clearInterval(timer);
report();
await restoreMemberships();
await db.end();
