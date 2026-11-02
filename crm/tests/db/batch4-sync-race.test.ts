import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, SYNTHETIC_INTAKE_CONFIG, assertLoopbackDatabaseUrl, claimsFor } from '../helpers/db';

/**
 * Batch 4 (20261125000100) two-session proofs on REAL Postgres only
 * (TEST_DATABASE_URL = a disposable local stack; skipped on PGlite):
 *   - the same sync settings preview applied from two sessions at once: one
 *     saves, the other waits for the configuration row and then answers
 *     preview_used (a preview is used once);
 *   - while another session holds the configuration row, apply answers
 *     settings_busy (55P03) within its 5 s lock timeout instead of hanging.
 * Setup is committed (two sessions must see it); afterAll restores the
 * configuration and the schedule and removes every row this file created as
 * the local table owner (triggers suspended in that transaction only).
 */

const url = process.env.TEST_DATABASE_URL?.trim();
const enabled = Boolean(url);
const SUPER_ACTOR: Actor = { userId: U.adminJodhpur };
const REASON = 'Owner approval APPROVE in chat (synthetic race test)';
const CUTOFF = '2026-09-01T00:00:00+05:30';

let admin: pg.Client;
let auditStart = '0';
let saved: { cutoff: string; sync: boolean } | null = null;

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url! });
  await c.connect();
  return c;
}
async function q<T extends pg.QueryResultRow>(c: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query<T>(sql, params)).rows;
}
async function beginAs(c: pg.Client, actor: Actor): Promise<void> {
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await c.query('set local role authenticated');
}
async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
}
/** A committed preview of the current scope (nothing hidden), by the Super Admin. */
async function committedPreview(): Promise<string> {
  const c = await connect();
  try {
    await beginAs(c, SUPER_ACTOR);
    const [row] = await q<{ id: string }>(c,
      `select public.integration_preview_sync_settings(array[7]::bigint[], array['C7:NEW','C7:PREPARATION'], $1::timestamptz, $2) ->> 'previewId' as id`,
      [CUTOFF, saved!.sync]);
    await c.query('commit');
    return row!.id;
  } finally {
    await c.end();
  }
}

describe.skipIf(!enabled)('Batch 4 sync settings: two sessions (real Postgres)', () => {
  beforeAll(async () => {
    assertLoopbackDatabaseUrl(url!);
    admin = await connect();
    auditStart = (await q<{ m: string }>(admin, 'select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
    const [c] = await q<{ cutoff: string }>(admin, 'select cutoff_at::text as cutoff from public.integration_intake_config where id = $1',
      [SYNTHETIC_INTAKE_CONFIG]);
    const [s] = await q<{ sync: boolean }>(admin, 'select enabled as sync from public.integration_sync_schedule where id');
    saved = { cutoff: c!.cutoff, sync: s!.sync };
    // An IST-midnight sync date, so the previews below change nothing in scope.
    await q(admin, 'update public.integration_intake_config set cutoff_at = $2::timestamptz where id = $1', [SYNTHETIC_INTAKE_CONFIG, CUTOFF]);
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query('begin');
      await admin.query(`set local session_replication_role = replica`);
      await admin.query('delete from public.integration_sync_previews where actor_user_id = $1', [U.adminJodhpur]);
      if (saved) {
        await admin.query('update public.integration_intake_config set cutoff_at = $2::timestamptz where id = $1', [SYNTHETIC_INTAKE_CONFIG, saved.cutoff]);
        await admin.query('update public.integration_sync_schedule set enabled = $1 where id', [saved.sync]);
      }
      await admin.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  });

  it('the same preview applied from two sessions: one saves, the other answers preview_used', async () => {
    const previewId = await committedPreview();
    const a = await connect();
    const b = await connect();
    try {
      await beginAs(a, SUPER_ACTOR);
      await beginAs(b, SUPER_ACTOR);
      const first = await q<{ r: { previewId: string } }>(a, 'select public.integration_apply_sync_settings($1, $2) as r', [previewId, REASON]);
      expect(first[0]!.r.previewId).toBe(previewId);
      // b waits for the configuration row held by a.
      const second = errorOf(q(b, 'select public.integration_apply_sync_settings($1, $2) as r', [previewId, REASON]));
      await new Promise((r) => setTimeout(r, 300));
      await a.query('commit');
      expect(await second).toMatchObject({ code: '55000', message: 'preview_used' });
      await b.query('rollback');
      const [used] = await q<{ n: number }>(admin, 'select count(*)::int as n from public.integration_sync_previews where id = $1 and used_at is not null',
        [previewId]);
      expect(used!.n).toBe(1);
      const [saves] = await q<{ n: number }>(admin,
        `select count(*)::int as n from public.audit_events where action = 'integration.settings_updated' and details ->> 'previewId' = $1`, [previewId]);
      expect(saves!.n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('a held configuration row makes apply answer settings_busy within its timeout', async () => {
    const previewId = await committedPreview();
    const holder = await connect();
    const caller = await connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.integration_intake_config where id = $1 for update', [SYNTHETIC_INTAKE_CONFIG]);
      await beginAs(caller, SUPER_ACTOR);
      const started = Date.now();
      const err = await errorOf(q(caller, 'select public.integration_apply_sync_settings($1, $2) as r', [previewId, REASON]));
      const waited = Date.now() - started;
      await caller.query('rollback');
      expect(err).toMatchObject({ code: '55P03', message: 'settings_busy' });
      expect(waited).toBeGreaterThanOrEqual(4000);
      expect(waited).toBeLessThan(15000);
    } finally {
      await holder.query('rollback');
      await holder.end();
      await caller.end();
    }
  });
});
