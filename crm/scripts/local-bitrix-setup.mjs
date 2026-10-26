#!/usr/bin/env node
// One-time LOCAL Bitrix intake setup (npm run bitrix:setup). Idempotent.
//
//   1. deployment_settings.environment: 'unset' -> 'staging' (real data, not live).
//   2. integration_intake_config (only if none exists), defaults:
//        pipelines: all Bitrix deal pipelines
//        stages:    every OPEN stage (not won / lost)
//        cutoff:    deals created or modified in the last 90 days (midnight IST)
//        pilot:     legal entity HOLIDAY_CHACHA, its head-office branch (reference data)
//      Everything is editable later on /app/admin/integration.
//   3. Supabase Vault: bitrix_sync_url (host.docker.internal:3000) and
//      bitrix_sync_bearer (= INTAKE_WORKER_SECRET from .env.local).
//   4. Turns the pg_cron schedule on.
//
// Reads Bitrix METADATA only (crm.category.list, crm.status.list). Grants no
// access to anyone. Never prints the webhook URL or the worker secret.
// Usage: node scripts/local-bitrix-setup.mjs [--member-id <Bitrix portal member_id>] [--days 90]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { inspectMetadata, MetadataError, redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const secrets = [env.BITRIX_WEBHOOK_BASE_URL, env.INTAKE_WORKER_SECRET];
const log = (m) => console.log(`bitrix:setup  ${redact(m, secrets)}`);
const fail = (m) => {
  console.error(`bitrix:setup  ${redact(m, secrets)}`);
  process.exit(1);
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (env.APP_ENV !== 'local') fail('runs only with APP_ENV=local in .env.local');
if (!env.BITRIX_WEBHOOK_BASE_URL) fail('BITRIX_WEBHOOK_BASE_URL is missing in .env.local');
if ((env.INTAKE_WORKER_SECRET ?? '').length < 32) fail('INTAKE_WORKER_SECRET (32+ characters) is missing in .env.local');

let portal;
try {
  portal = new URL(env.BITRIX_WEBHOOK_BASE_URL).hostname.toLowerCase();
} catch {
  fail('BITRIX_WEBHOOK_BASE_URL is not a URL');
}
let baseUrl;
let metadata;
try {
  baseUrl = resolveBaseUrl(env.BITRIX_WEBHOOK_BASE_URL, portal, 'production');
  metadata = await inspectMetadata(baseUrl);
} catch (error) {
  fail(error instanceof MetadataError ? error.message : 'could not read Bitrix metadata');
}

const categories = metadata.categories.map((c) => Number(c.id));
const openStages = metadata.categories.flatMap((c) =>
  (metadata.stagesByCategory[c.id] ?? []).filter((s) => !s.semantics).map((s) => s.statusId),
);
const days = Number(arg('--days') ?? 90);
const cutoffDay = new Date(Date.now() + 330 * 60_000 - days * 86_400_000).toISOString().slice(0, 10);
const cutoff = `${cutoffDay}T00:00:00+05:30`;
// The portal member_id identifies the portal in outbound events (Vercel later).
// Locally (pull only) any stable id works; pass the real one with --member-id.
const memberId = arg('--member-id') ?? `local-${createHash('sha256').update(portal).digest('hex').slice(0, 16)}`;

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
try {
  await db.query('begin');
  const envRow = await db.query(`update public.deployment_settings set environment = 'staging', updated_at = now()
                                 where id and environment = 'unset' returning environment`);
  log(envRow.rowCount ? "environment set to 'staging'" : 'environment already set (unchanged)');

  const existing = await db.query('select portal_domain from public.integration_intake_config');
  if (existing.rowCount === 0) {
    const pilot = await db.query(`select b.legal_entity_id, b.id, b.name from public.branches b
                                  join public.legal_entities e on e.id = b.legal_entity_id
                                  where e.code = 'HOLIDAY_CHACHA' and b.is_head_office`);
    if (pilot.rowCount !== 1) throw new Error('head-office branch of HOLIDAY_CHACHA not found');
    await db.query(
      `insert into public.integration_intake_config
         (portal_domain, portal_member_id, category_id, eligible_category_ids, eligible_stage_ids, cutoff_at,
          pilot_legal_entity_id, pilot_branch_id, enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [portal, memberId, categories[0], categories, openStages, cutoff, pilot.rows[0].legal_entity_id, pilot.rows[0].id],
    );
    log(
      `intake config created: portal ${portal}; pipelines ${categories.join(', ')}; ${openStages.length} open stages; ` +
        `cutoff ${cutoff} (${days} days); pilot branch ${pilot.rows[0].name}`,
    );
  } else {
    log(`intake config already exists for ${existing.rows[0].portal_domain} (unchanged; edit it on the Bitrix sync page)`);
  }

  for (const [name, value] of [
    ['bitrix_sync_url', 'http://host.docker.internal:3000/api/integrations/bitrix/worker'],
    ['bitrix_sync_bearer', env.INTAKE_WORKER_SECRET],
  ]) {
    const id = (await db.query('select id from vault.secrets where name = $1', [name])).rows[0]?.id;
    if (id) await db.query('select vault.update_secret($1, $2)', [id, value]);
    else await db.query(`select vault.create_secret($1, $2, 'TripNavigate Bitrix auto-sync')`, [value, name]);
  }
  log('Vault: bitrix_sync_url and bitrix_sync_bearer set');
  // Stage 0: migrations no longer install pg_cron/pg_net or schedule jobs (operator
  // step; see authz.provision_bitrix_sync_jobs in 20261107000100). Local only here.
  await db.query('create extension if not exists pg_cron');
  await db.query('create extension if not exists pg_net with schema extensions');
  await db.query('select authz.provision_bitrix_sync_jobs()');
  await db.query("select cron.alter_job(j.jobid, active := true) from cron.job j where j.jobname like 'bitrix-sync%'");
  await db.query('update public.integration_sync_schedule set enabled = true, updated_at = now() where id');
  await db.query('commit');
  log('automatic sync switched on (pg_cron job bitrix-sync, every 30 s)');
} catch (error) {
  await db.query('rollback').catch(() => undefined);
  fail(`setup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
} finally {
  await db.end();
}
