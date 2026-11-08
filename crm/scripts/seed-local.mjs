#!/usr/bin/env node
// Seeds SYNTHETIC fixture users and data into a LOCAL Supabase stack only.
//
// Usage (after `supabase start` and `supabase db reset`):
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret from `supabase status`> \
//   LOCAL_FIXTURE_PASSWORD=<choose one, 12+ chars> node scripts/seed-local.mjs
//
// Refuses to run against anything that is not localhost, and refuses outright
// when APP_ENV=production. Never use real people. This script and the test
// harness are the ONLY consumers of supabase/fixtures (tests/unit/scope-exclusions.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { seedEnvironmentRefusal, seedTargetRefusal } from './lib/seed-guard.mjs';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const secret = process.env.SUPABASE_SECRET_KEY;
const password = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function fail(message) {
  console.error(`seed-local: ${message}`);
  process.exit(1);
}

if (process.env.APP_ENV === 'production') {
  fail('refusing to seed: APP_ENV=production. Synthetic fixtures never touch production.');
}

const targetRefusal = seedTargetRefusal(url, databaseUrl);
if (targetRefusal) fail(targetRefusal);
if (!secret) fail('SUPABASE_SECRET_KEY is required (see `supabase status`).');
if (!password || password.length < 12) fail('LOCAL_FIXTURE_PASSWORD (12+ characters) is required.');

const users = {
  'a0000000-0000-4000-8000-000000000001': 'sales.delhi.a@example.test',
  'a0000000-0000-4000-8000-000000000002': 'sales.delhi.b@example.test',
  'a0000000-0000-4000-8000-000000000003': 'purchase.jodhpur@example.test',
  'a0000000-0000-4000-8000-000000000004': 'sales.ahmedabad@example.test',
  'a0000000-0000-4000-8000-000000000005': 'manager.delhi@example.test',
  'a0000000-0000-4000-8000-000000000006': 'accounts.jodhpur@example.test',
  'a0000000-0000-4000-8000-000000000007': 'admin.jodhpur@example.test',
  'a0000000-0000-4000-8000-000000000008': 'former.staff@example.test',
  'a0000000-0000-4000-8000-000000000009': 'moved.staff@example.test',
  'a0000000-0000-4000-8000-000000000010': 'sales.entityb@example.test',
  'a0000000-0000-4000-8000-000000000011': 'visa.jodhpur@example.test',
  'a0000000-0000-4000-8000-000000000012': 'invited.staff@example.test',
  'a0000000-0000-4000-8000-000000000013': 'manager.ahmedabad@example.test',
};

// Never seed a database labelled operational (Phase 6 contract 2.5) or one
// holding real data (local-bitrix-setup labels it 'staging'): synthetic
// fixtures would relabel it 'test'. Checked before any Auth user or row is created.
{
  const guard = new pg.Client({ connectionString: databaseUrl });
  await guard.connect();
  try {
    const env = await guard
      .query('select s.environment from public.deployment_settings s where s.id')
      .catch((error) => (error.code === '42P01' ? { rows: [] } : Promise.reject(error)));
    const refusal = seedEnvironmentRefusal(env.rows.map((r) => r.environment));
    if (refusal) fail(refusal);
  } finally {
    await guard.end();
  }
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

for (const [id, email] of Object.entries(users)) {
  const { error } = await admin.auth.admin.createUser({ id, email, password, email_confirm: true });
  if (error && !/already/i.test(error.message)) fail(`could not create ${email}: ${error.message}`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const { rows } = await client.query(`select 1 from public.legal_entities where code = 'SYNTHETIC_B'`);
  if (rows.length === 0) {
    // synthetic_fixtures.sql first (it creates the base rows), then any other
    // fixture files in name order.
    const dir = join(import.meta.dirname, '..', 'supabase', 'fixtures');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => (a === 'synthetic_fixtures.sql' ? -1 : b === 'synthetic_fixtures.sql' ? 1 : a.localeCompare(b)));
    await client.query('begin');
    for (const file of files) await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('commit');
    console.log(`seed-local: synthetic fixtures loaded (${files.join(', ')}).`);
  } else {
    console.log('seed-local: fixtures already present; skipped.');
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  fail(error.message);
} finally {
  await client.end();
}

// Deactivated fixture staff are also blocked at the Auth layer, as in production.
const ban = await admin.auth.admin.updateUserById('a0000000-0000-4000-8000-000000000008', { ban_duration: '876000h' });
if (ban.error) fail(`could not ban former staff fixture: ${ban.error.message}`);
console.log(`seed-local: ${Object.keys(users).length} synthetic users ready (password from LOCAL_FIXTURE_PASSWORD).`);
