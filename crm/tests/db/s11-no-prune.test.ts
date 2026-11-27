import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, migrationFiles } from '../helpers/db';
import { bodyOf, s11Files, stripComments } from './s11-support';

/**
 * S11 "files to Bitrix" (contract file 14 section 1.5 C5 and 2.6, file 11
 * section 4.2 "s11-no-prune"): S4's nightly prune removes machine logs only.
 * The S11 tables are business-linked (where a file is, who viewed it, every
 * stop) and are never pruned: authz.prune_machine_logs names none of them, no
 * function deletes from them, and the alert and view tables refuse deletes.
 * Runs on PGlite and on the real local stack.
 */

const S11_TABLES = ['file_bitrix_moves', 'file_move_settings', 'file_move_kick_state', 'file_move_stops', 'file_bitrix_views', 'file_move_box_state'];
const MENTIONS = new RegExp(`${S11_TABLES.join('|')}|file_move|file_bitrix`, 'i');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

describe('S11 tables are never pruned', () => {
  it('authz.prune_machine_logs (every overload, as stored in the database) names no S11 table', async () => {
    const rows = await db.query<{ sig: string; src: string }>(
      `select p.oid::regprocedure::text as sig, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and p.proname = 'prune_machine_logs'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.src, r.sig).not.toMatch(MENTIONS);
  });

  it('the prune migration text names no S11 table either', () => {
    const file = migrationFiles().find((f) => basename(f) === '20261208000130_s4_machine_log_prune.sql');
    expect(file).toBeDefined();
    expect(bodyOf(stripComments(readFileSync(file!, 'utf8')), 'authz.prune_machine_logs')).not.toMatch(MENTIONS);
  });

  it('no function in public or authz deletes or truncates rows of an S11 table', async () => {
    const rows = await db.query<{ f: string }>(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz')
         and p.prosrc ~* ('(delete\\s+from|truncate(\\s+table)?)\\s+(public\\.)?(' || $1 || ')\\M')`,
      [S11_TABLES.join('|')],
    );
    expect(rows.map((r) => r.f)).toEqual([]);
  });

  it('no S11 migration schedules a prune or deletes rows', () => {
    const code = s11Files().map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/prune_machine_logs/);
  });

  it('the alert, view, move, settings and box tables refuse TRUNCATE; stops and views refuse DELETE', async () => {
    await asOwner(db, async () => {
      const triggers = await db.query<{ t: string }>(
        `select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and g.tgname = c.relname || '_no_truncate' and c.relname = any ($1::text[])
         order by 1`,
        [S11_TABLES],
      );
      expect(triggers.map((r) => r.t)).toEqual(['file_bitrix_moves', 'file_bitrix_views', 'file_move_box_state', 'file_move_settings', 'file_move_stops']);
      const guards = await db.query<{ t: string; f: string }>(
        `select c.relname as t, p.proname as f from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc p on p.oid = g.tgfoid
         where c.relname in ('file_move_stops', 'file_bitrix_views') and not g.tgisinternal and (g.tgtype & 8) = 8
         order by 1`,
      );
      expect(guards).toEqual([{ t: 'file_bitrix_views', f: 'file_view_guard' }, { t: 'file_move_stops', f: 'file_move_stop_guard' }]);
    });
  });

  it('on a stack with pg_cron, no scheduled job command touches an S11 table', async () => {
    const [cron] = await db.query<{ c: string | null }>(`select to_regclass('cron.job')::text as c`);
    if (cron!.c === null) return; // PGlite: no pg_cron
    const jobs = await db.query<{ jobname: string; command: string }>('select jobname, command from cron.job');
    for (const j of jobs.filter((x) => x.jobname !== 'file-move-sweep')) expect(j.command, j.jobname).not.toMatch(MENTIONS);
  });
});
