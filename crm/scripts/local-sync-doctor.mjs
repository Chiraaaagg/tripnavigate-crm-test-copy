#!/usr/bin/env node
// LOCAL auto-sync doctor (called by `npm run local:up`; safe to run any time).
//
//   1. pg_cron job `bitrix-sync` exists, runs every 30 seconds and is active
//      (re-created / re-activated if not; cron.schedule is an upsert).
//   2. Vault `bitrix_sync_url` / `bitrix_sync_bearer` match .env.local
//      (compared by hash; updated if they differ). Nothing secret is printed.
//   3. Waits (up to --wait seconds, default 75) for a successful scheduled call
//      and prints the last 5 calls (time, HTTP status, plain reason).
//
// Usage: node scripts/local-sync-doctor.mjs [--wait 75]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SYNC_URL = 'http://host.docker.internal:3000/api/integrations/bitrix/worker';
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const log = (m) => console.log(`local:up  ${m}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (env.APP_ENV !== 'local') {
  log('sync doctor: skipped (APP_ENV is not local)');
  process.exit(0);
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
let exitCode = 0;
try {
  // 1. Cron job.
  const cron = (await db.query(`select exists (select 1 from pg_extension where extname = 'pg_cron') as ok`)).rows[0].ok;
  if (!cron) {
    log('⚠ pg_cron is not installed in this database; automatic sync cannot run.');
    exitCode = 1;
  } else {
    const job = (await db.query(`select jobid, schedule, command, active from cron.job where jobname = 'bitrix-sync'`)).rows[0];
    const command = 'select authz.run_scheduled_bitrix_sync()';
    if (!job || job.schedule !== '30 seconds' || job.command !== command) {
      await db.query(`select cron.schedule('bitrix-sync', '30 seconds', $1)`, [command]);
      log(job ? 'Cron job bitrix-sync was changed; restored to every 30 seconds.' : 'Cron job bitrix-sync was missing; re-created (every 30 seconds).');
    }
    const after = (await db.query(`select jobid, active from cron.job where jobname = 'bitrix-sync'`)).rows[0];
    if (!after.active) {
      await db.query('select cron.alter_job($1, active := true)', [after.jobid]);
      log('Cron job bitrix-sync was inactive; re-activated.');
    }
  }

  // 2. Vault values (by hash only).
  const want = { bitrix_sync_url: SYNC_URL, bitrix_sync_bearer: env.INTAKE_WORKER_SECRET ?? '' };
  if (want.bitrix_sync_bearer.length < 32) {
    log('⚠ INTAKE_WORKER_SECRET in .env.local is missing or shorter than 32 characters.');
    exitCode = 1;
  } else {
    for (const [name, value] of Object.entries(want)) {
      const row = (
        await db.query(
          `select s.id, encode(sha256(convert_to(d.decrypted_secret, 'UTF8')), 'hex') as h
           from vault.secrets s join vault.decrypted_secrets d on d.id = s.id where s.name = $1`,
          [name],
        )
      ).rows[0];
      if (row?.h === sha(value)) continue;
      if (row) await db.query('select vault.update_secret($1, $2)', [row.id, value]);
      else await db.query(`select vault.create_secret($1, $2, 'TripNavigate Bitrix auto-sync')`, [value, name]);
      log(`Vault ${name} did not match .env.local; updated.`);
    }
  }

  // 3. A successful scheduled call.
  const switchOn = (await db.query('select enabled from public.integration_sync_schedule where id')).rows[0]?.enabled;
  if (!switchOn) {
    log('Automatic sync is PAUSED (Bitrix sync page -> Sync settings).');
  } else {
    const since = new Date();
    const waitMs = arg('--wait', 75) * 1000;
    let ok = null;
    for (let t = 0; t <= waitMs; t += 5000) {
      ok = (
        await db.query(`select dispatched_at from public.integration_sync_dispatches where ok and dispatched_at >= $1 limit 1`, [since])
      ).rows[0];
      if (ok) break;
      await sleep(5000);
    }
    const calls = (
      await db.query(
        `select to_char(dispatched_at at time zone 'Asia/Kolkata', 'HH24:MI:SS') as t, status_code, ok, reason
         from public.integration_sync_dispatches order by dispatched_at desc limit 5`,
      )
    ).rows;
    for (const c of calls) log(`  ${c.t} IST  ${c.ok === null ? 'waiting' : c.ok ? `ok (HTTP ${c.status_code})` : `FAILED: ${c.reason}`}`);
    if (ok) log('Auto sync is running: the scheduler reached the CRM successfully.');
    else {
      log('⚠ No successful scheduled sync yet. See the reasons above and the Bitrix sync page.');
      exitCode = 1;
    }
  }
} finally {
  await db.end();
}
process.exit(exitCode);
