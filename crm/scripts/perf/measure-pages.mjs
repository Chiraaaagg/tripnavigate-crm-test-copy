#!/usr/bin/env node
// Local speed baseline for the main staff pages (docs/implementation/current/speed-plan-2026-10-09.md).
//
// Signs SYNTHETIC fixture users in against a disposable LOCAL Supabase stack
// (password + a fresh TOTP factor, removed again at the end), then requests
// each page from a local `next start` with that session cookie and reports:
//   - server time: time to first byte and to the last byte (median of N runs),
//   - Supabase round trips per page view (Auth + Data API calls seen by the
//     local API gateway in a quiet window, read from `docker logs`),
//   - JavaScript the page loads (sum of its /_next/static script files, raw and gzip).
// Every URL must be loopback; it never reads an .env file.
//
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=... TEST_DATABASE_URL=... \
//   LOCAL_FIXTURE_PASSWORD=... APP_BASE_URL=http://127.0.0.1:3200 KONG_CONTAINER=supabase_kong_<project_id> \
//   node scripts/perf/measure-pages.mjs [runs=10] [--json out.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { seedTargetRefusal } from '../lib/seed-guard.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const env = (name) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const supabaseUrl = env('SUPABASE_URL');
const publishableKey = env('SUPABASE_PUBLISHABLE_KEY');
const secretKey = env('SUPABASE_SECRET_KEY');
const databaseUrl = env('TEST_DATABASE_URL');
const password = env('LOCAL_FIXTURE_PASSWORD');
const appBaseUrl = env('APP_BASE_URL').replace(/\/$/, '');
const kong = process.env.KONG_CONTAINER?.trim() || null;
const mockBitrix = process.env.MOCK_BITRIX_URL?.trim() || null;
for (const u of [supabaseUrl, appBaseUrl, ...(mockBitrix ? [mockBitrix] : [])]) {
  if (!LOOPBACK.has(new URL(u).hostname)) throw new Error('measure-pages runs only against loopback targets');
}
// Same strict target check as the seed script (loopback, no connection overrides).
const targetRefusal = seedTargetRefusal(supabaseUrl, databaseUrl);
if (targetRefusal) throw new Error(`measure-pages: ${targetRefusal}`);
const runs = Number(process.argv[2] ?? 10) || 10;
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
// --timeline: also print when the gateway logged each call of the probe request,
// relative to the first one (the gateway logs when a call completes).
const timeline = process.argv.includes('--timeline');

const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(supabaseUrl, secretKey, { auth: noPersist });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signInAal2(email) {
  const client = createClient(supabaseUrl, publishableKey, { auth: noPersist });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const userId = data.user.id;
  // Fresh factor per run; earlier perf factors are removed first.
  const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
  const again = await client.auth.signInWithPassword({ email, password });
  if (again.error) throw again.error;
  const { data: enrol, error: enrolError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `perf-${Date.now()}` });
  if (enrolError) throw enrolError;
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrol.totp.secret), digits: 6, period: 30 });
  const verify = await client.auth.mfa.challengeAndVerify({ factorId: enrol.id, code: totp.generate() });
  if (verify.error) throw verify.error;
  const { data: s } = await client.auth.getSession();
  if (!s.session) throw new Error('no session');
  return { userId, session: s.session };
}

function cookieFor(session) {
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const chunks = value.length <= 3180 ? [value] : value.match(/.{1,3180}/g);
  return chunks.map((c, i) => `${chunks.length === 1 ? name : `${name}.${i}`}=${c}`).join('; ');
}

async function timed(path, cookie) {
  const t0 = performance.now();
  const res = await fetch(`${appBaseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
  const ttfb = performance.now() - t0;
  const body = await res.text();
  return { status: res.status, ttfb, total: performance.now() - t0, body, location: res.headers.get('location') };
}

function gatewayCalls(sinceIso, untilMs) {
  if (!kong) return null;
  const out = execFileSync('docker', ['logs', '-t', '--since', sinceIso, kong], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out
    .split('\n')
    .filter((l) => / "(GET|POST|PATCH|HEAD|PUT|DELETE) \/(rest|auth)\/v1\//.test(l))
    .filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) <= untilMs)
    .map((l) => {
      const m = l.match(/"(\w+) (\/(?:rest|auth)\/v1\/[^ ?]*)(\?[^ ]*)? HTTP/);
      return { at: Date.parse(l.slice(0, l.indexOf(' '))), call: m ? `${m[1]} ${m[2]}` : l };
    });
}

async function bitrixCalls() {
  if (!mockBitrix) return null;
  return (await (await fetch(`${mockBitrix}/__calls`)).json()).calls;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const p90 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
};

const jsCache = new Map();
async function jsSize(html) {
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
  let raw = 0;
  let gz = 0;
  for (const src of srcs) {
    if (!jsCache.has(src)) {
      const buf = Buffer.from(await (await fetch(`${appBaseUrl}${src}`)).arrayBuffer());
      jsCache.set(src, { raw: buf.length, gz: gzipSync(buf).length });
    }
    raw += jsCache.get(src).raw;
    gz += jsCache.get(src).gz;
  }
  return { files: srcs.length, rawKb: Math.round(raw / 1024), gzipKb: Math.round(gz / 1024) };
}

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const dealRow = await db.query(
  `select d.id from public.deals d where d.branch_id = (select pilot_branch_id from public.integration_intake_config limit 1)
   and d.removed_at is null order by d.source_deal_id desc nulls last limit 1`,
);
await db.end();
const dealId = dealRow.rows[0]?.id;

const pages = [
  { name: 'Home', path: '/app', as: 'manager.delhi@example.test' },
  { name: 'Deals', path: '/app/deals', as: 'manager.delhi@example.test' },
  { name: 'Deal', path: `/app/deals/${dealId}`, as: 'manager.delhi@example.test' },
  { name: 'Leads', path: '/app/leads', as: 'manager.delhi@example.test' },
  { name: 'Accounts', path: '/app/accounts', as: 'accounts.jodhpur@example.test' },
  { name: 'Purchase', path: '/app/purchase', as: 'purchase.jodhpur@example.test' },
  { name: 'Bitrix sync', path: '/app/admin/integration', as: 'admin.jodhpur@example.test' },
  { name: 'Sign-in (signed out)', path: '/sign-in', as: null },
];

const cookies = new Map();
const signedIn = [];
for (const email of new Set(pages.map((p) => p.as).filter(Boolean))) {
  const { userId, session } = await signInAal2(email);
  signedIn.push(userId);
  cookies.set(email, cookieFor(session));
}

const results = [];
for (const page of pages) {
  const cookie = page.as ? cookies.get(page.as) : '';
  // Warm the route (first compile of server chunks, connection pools).
  for (let i = 0; i < 2; i += 1) await timed(page.path, cookie);
  // Round trips: one request in a quiet window.
  // Quiet window: nothing else talks to the gateway 1.5 s before and after the
  // probe, so a little clock skew between this Mac and the container VM is harmless.
  await sleep(1_500);
  const since = new Date(Date.now() - 700).toISOString();
  const bitrixBefore = await bitrixCalls();
  const probe = await timed(page.path, cookie);
  await sleep(1_500);
  const calls = gatewayCalls(since, Date.now() + 1_000);
  const bitrixAfter = await bitrixCalls();
  const ttfb = [];
  const total = [];
  for (let i = 0; i < runs; i += 1) {
    const r = await timed(page.path, cookie);
    if (r.status !== 200) throw new Error(`${page.path} answered ${r.status} ${r.location ?? ''}`);
    ttfb.push(r.ttfb);
    total.push(r.total);
  }
  const js = await jsSize(probe.body);
  const row = {
    page: page.name,
    path: page.path.replace(dealId ?? '#', '[id]'),
    as: page.as ?? 'signed out',
    status: probe.status,
    ttfbMedianMs: Math.round(median(ttfb)),
    ttfbP90Ms: Math.round(p90(ttfb)),
    totalMedianMs: Math.round(median(total)),
    roundTrips: calls ? calls.length : null,
    bitrixCalls: bitrixBefore === null ? null : bitrixAfter - bitrixBefore,
    htmlKb: Math.round(Buffer.byteLength(probe.body) / 1024),
    js,
    calls: calls ? calls.map((c) => c.call) : null,
  };
  results.push(row);
  console.log(
    `${row.page.padEnd(22)} ${String(row.status).padEnd(4)} ttfb ${String(row.ttfbMedianMs).padStart(5)} ms (p90 ${row.ttfbP90Ms})  total ${String(row.totalMedianMs).padStart(5)} ms  round trips ${row.roundTrips ?? '-'}${row.bitrixCalls ? ` + Bitrix ${row.bitrixCalls}` : ''}  JS ${js.gzipKb} KB gz (${js.rawKb} KB raw, ${js.files} files)  HTML ${row.htmlKb} KB`,
  );
  if (timeline && calls?.length) {
    const first = Math.min(...calls.map((c) => c.at));
    for (const c of [...calls].sort((a, b) => a.at - b.at)) console.log(`    +${String(c.at - first).padStart(4)} ms  ${c.call}`);
  }
}

for (const userId of signedIn) {
  const { data } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of data?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
