import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * Supabase-side scheduler and Realtime publication: main's 20261009000100_bitrix_auto_sync
 * (renumbered from 20261006000100, PR #13), now section 1 of the Stage 0 transition
 * 20261107000100_integration_sync_transition. pg_cron / pg_net / Vault exist only on a real
 * stack (tests/supabase/auto-sync.real.test.ts checks the job and a real dispatch);
 * here: the file contents, the paused default and the grants. Stage 0: no migration
 * installs an extension or schedules a job; authz.provision_bitrix_sync_jobs() (an
 * approved operator step) creates the jobs paused.
 */

const file = join(
  import.meta.dirname, '..', '..', 'supabase', 'migrations', '20261107000100_integration_sync_transition.sql',
);
const sql = readFileSync(file, 'utf8');
const code = sql
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('auto-sync migration source', () => {
  it('contains no URL, host or secret value', () => {
    expect(code).not.toMatch(/https?:\/\/[a-z0-9]/i);
    expect(code).not.toMatch(/host\.docker\.internal|vercel\.app|localhost|127\.0\.0\.1/i);
    expect(code).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(code).not.toMatch(/vault\.create_secret|vault\.update_secret/);
  });

  it('reads the URL, bearer and bypass secret from Vault by name', () => {
    expect(code).toMatch(/from vault\.decrypted_secrets s where s\.name = p_url_secret/);
    expect(code).toMatch(/from vault\.decrypted_secrets s where s\.name = p_bearer_secret/);
    expect(code).toMatch(/from vault\.decrypted_secrets s where s\.name = p_bypass_secret/);
    expect(code).toMatch(/'Authorization', 'Bearer ' \|\| v_bearer/);
    expect(code).toMatch(/net\.http_post\(/);
  });

  it('defines the 30-second sync job for the paused-aware entry point, created only paused by the operator step', () => {
    expect(code).toMatch(/array\['bitrix-sync', '30 seconds', 'select authz\.run_scheduled_bitrix_sync\(\)'\]/);
    expect(code).toMatch(/execute 'select cron\.alter_job\(\$1, active := false\)' using v_id;/);
    // The only cron.schedule call is inside authz.provision_bitrix_sync_jobs(); no extension is installed.
    expect(code.match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(code).toMatch(/execute 'select cron\.schedule\(\$1, \$2, \$3\)'/);
    expect(code).not.toMatch(/create extension/i);
  });

  it('publishes deals only (never deal_commercials) to Realtime', () => {
    expect(code).toMatch(/alter publication supabase_realtime add table public\.deals;/);
    expect(code).not.toMatch(/deal_commercials/);
  });
});

describe('auto-sync migration in the database', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('the schedule exists and starts paused', async () => {
    const rows = await db.query<{ enabled: boolean }>('select enabled from public.integration_sync_schedule');
    expect(rows).toEqual([{ enabled: false }]);
  });

  it('only the database owner can dispatch or read the schedule', async () => {
    const rows = await db.query<{ role: string; dispatch: boolean; run: boolean; sel: boolean }>(`
      select r as role,
        has_function_privilege(r, 'authz.dispatch_bitrix_sync(text, text, text)', 'execute') as dispatch,
        has_function_privilege(r, 'authz.run_scheduled_bitrix_sync()', 'execute') as run,
        has_table_privilege(r, 'public.integration_sync_schedule', 'select') as sel
      from unnest(array['anon', 'authenticated', 'service_role']) r`);
    expect(rows).toEqual([
      { role: 'anon', dispatch: false, run: false, sel: false },
      { role: 'authenticated', dispatch: false, run: false, sel: false },
      { role: 'service_role', dispatch: false, run: false, sel: true },
    ]);
  });

  it('without pg_cron the migrations load and the provisioning step refuses (owner only)', async () => {
    if (db.mode !== 'pglite') return; // real stacks have pg_cron: see the supabase suite
    await expect(db.query('select authz.provision_bitrix_sync_jobs()')).rejects.toMatchObject({
      code: '55000',
      message: 'pg_cron is not installed',
    });
    const rows = await db.query<{ role: string; provision: boolean }>(`
      select r as role, has_function_privilege(r, 'authz.provision_bitrix_sync_jobs()', 'execute') as provision
      from unnest(array['anon', 'authenticated', 'service_role']) r`);
    expect(rows.every((r) => !r.provision)).toBe(true);
  });

  it('a paused schedule dispatches nothing (no Vault/pg_net access attempted)', async () => {
    if (db.mode !== 'pglite') return; // real stacks: see the supabase suite
    await expect(db.query('select authz.run_scheduled_bitrix_sync()')).resolves.toBeDefined();
  });
});
