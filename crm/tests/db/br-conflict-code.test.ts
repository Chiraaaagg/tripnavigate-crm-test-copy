import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_EMAILS, FIXTURE_USERS, type TestDb, asOwner, createTestDb, migrationFiles } from '../helpers/db';
import { CONFLICT_STATE, CONFLICT_STATE_BEFORE, ROW_VERSION_STATE } from '../helpers/sqlstates';
import { acc3Helpers } from './acc3-support';

/**
 * Booking reliability B1-1 (build contract section 6): business refusals move
 * from SQLSTATE 40001 to PT409 in two stages.
 *
 *   stage 1  20261206000100 (seven handlers accept both codes)
 *            20261206000110 (authz.require_row_version raises PT409)
 *   stage 2  20261206000200 (every remaining function raises PT409)
 *            20261206000210 (the handlers catch and raise PT409 only)
 *
 * Part 1 (PGlite only: it needs a database built without these migrations)
 * builds the schema up to the last migration before them, then applies each
 * stage, and compares every function in the database before and after:
 * definition (pg_get_functiondef, with the code literal put back), body,
 * security definer, configuration (search_path), volatility, strictness,
 * leakproof, parallel safety, language, return type, grants, owner and
 * comment. Only the listed functions may change, and only by the literal.
 * It also proves supabase/conflict-code/functions.tsv (the list and the md5
 * values of the live pre-check) against the database.
 *
 * Part 2 (any database) checks the behaviour after both stages.
 */

const url = process.env.TEST_DATABASE_URL;
const root = join(import.meta.dirname, '..', '..');
const FIRST_S1 = '20261206000100';
const version = (f: string) => basename(f).slice(0, 14);
const stage1Files = () => migrationFiles().filter((f) => ['20261206000100', '20261206000110'].includes(version(f)));
const stage2Files = () => migrationFiles().filter((f) => ['20261206000200', '20261206000210'].includes(version(f)));

type Row = {
  sig: string; nspname: string; proname: string; def: string; src: string; secdef: boolean; config: string[] | null;
  volatile: string; strict: boolean; leakproof: boolean; parallel: string; lang: string; rettype: string; acl: string | null;
  owner: string; comment: string | null;
};
type Snapshot = Map<string, Row>;

const SNAPSHOT_SQL = `
  select p.oid::regprocedure::text as sig, n.nspname, p.proname, pg_get_functiondef(p.oid) as def, p.prosrc as src,
         p.prosecdef as secdef, p.proconfig as config, p.provolatile::text as volatile, p.proisstrict as strict,
         p.proleakproof as leakproof, p.proparallel::text as parallel, l.lanname as lang, p.prorettype::regtype::text as rettype,
         p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner, obj_description(p.oid, 'pg_proc') as comment
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and p.prokind in ('f', 'p')`;

/** Every attribute except the definition text and body. */
const attrs = (r: Row) => ({
  secdef: r.secdef, config: r.config, volatile: r.volatile, strict: r.strict, leakproof: r.leakproof, parallel: r.parallel,
  lang: r.lang, rettype: r.rettype, acl: r.acl, owner: r.owner, comment: r.comment,
});

/** Stage 1 back to before: handlers caught 40001 only; require_row_version raised 40001. */
const undoStage1 = (t: string) => t.replaceAll("sqlstate '40001' or sqlstate 'PT409'", "sqlstate '40001'").replaceAll("errcode = 'PT409'", "errcode = '40001'");
/** Stage 2 back to stage 1: handlers caught both codes; every raise used 40001. */
const undoStage2 = (t: string) => t.replaceAll("sqlstate 'PT409'", "sqlstate '40001' or sqlstate 'PT409'").replaceAll("errcode = 'PT409'", "errcode = '40001'");

const CLASS_40 = /'40[0-9A-Z]{3}'/;
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

type Listed = { schema: string; name: string; stage: 'handler' | '1' | '2'; md5: string };
function listed(): Listed[] {
  const lines = readFileSync(join(root, 'supabase', 'conflict-code', 'functions.tsv'), 'utf8').trim().split('\n').slice(1);
  return lines.map((l) => {
    const [schema, name, , stage, , md5] = l.split('\t');
    return { schema: schema!, name: name!, stage: stage as Listed['stage'], md5: md5! };
  });
}
const key = (l: { schema: string; name: string }) => `${l.schema}.${l.name}`;

describe.skipIf(!!url)('B1-1 definition diff, stage by stage (PGlite)', () => {
  let pg: PGlite;
  let before: Snapshot;
  let afterStage1: Snapshot;
  let afterStage2: Snapshot;
  let md5Before: Map<string, string>;
  let rrvBefore: { code?: string; message?: string };
  let rrvStage1: { code?: string; message?: string };

  const snapshot = async (): Promise<Snapshot> => {
    const rows = (await pg.query<Row>(SNAPSHOT_SQL)).rows;
    return new Map(rows.map((r) => [r.sig, r]));
  };
  const rrvError = async () => {
    try {
      await pg.query('select authz.require_row_version(1, 2)');
    } catch (error) {
      return error as { code?: string; message?: string };
    }
    return {};
  };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync(join(root, 'tests', 'helpers', 'supabase-shim.sql'), 'utf8'));
    const users = Object.entries(FIXTURE_USERS).map(([k, id]) => `('${id}', '${FIXTURE_EMAILS[k as keyof typeof FIXTURE_USERS]}')`).join(',\n');
    await pg.exec(`insert into auth.users (id, email) values ${users};`);
    for (const f of migrationFiles().filter((f) => version(f) < FIRST_S1)) await pg.exec(readFileSync(f, 'utf8'));
    before = await snapshot();
    md5Before = new Map((await pg.query<{ k: string; m: string }>(
      `select n.nspname || '.' || p.proname as k, md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz')`)).rows.map((r) => [r.k, r.m]));
    rrvBefore = await rrvError();
    for (const f of stage1Files()) await pg.exec(readFileSync(f, 'utf8'));
    afterStage1 = await snapshot();
    rrvStage1 = await rrvError();
    for (const f of stage2Files()) await pg.exec(readFileSync(f, 'utf8'));
    afterStage2 = await snapshot();
  }, 300_000);
  afterAll(async () => {
    await pg?.close();
  });

  it('the four migration files exist in the reserved range', () => {
    expect(stage1Files().map((f) => basename(f))).toEqual(['20261206000100_conflict_code_handlers.sql', '20261206000110_conflict_code_row_version.sql']);
    expect(stage2Files().map((f) => basename(f))).toEqual(['20261206000200_conflict_code_all.sql', '20261206000210_conflict_code_handlers_final.sql']);
  });

  it('the attached list is exactly the functions that contained 40001, with the md5 values of the live pre-check', () => {
    const query = [...before.values()]
      .filter((r) => ['public', 'authz'].includes(r.nspname) && r.src.includes("'40001'"))
      .map((r) => `${r.nspname}.${r.proname}`).sort();
    const list = listed();
    expect(list.length).toBe(108);
    expect(list.map(key).sort()).toEqual(query);
    expect(new Set(query).size, 'no overloads among the listed functions').toBe(query.length);
    for (const l of list) expect(md5Before.get(key(l)), key(l)).toBe(l.md5);
    expect(list.filter((l) => l.stage === '1').map(key)).toEqual(['authz.require_row_version']);
    expect(list.filter((l) => l.stage === 'handler').length).toBe(7);
    // Nothing used PT409 before; only 40001-raising and 40001-catching sites are listed.
    for (const r of before.values()) expect(r.src.includes("'PT409'"), r.sig).toBe(false);
    for (const r of before.values()) {
      if (!['public', 'authz'].includes(r.nspname) || !r.src.includes("'40001'")) continue;
      expect(count(r.src, /'40001'/g), r.sig).toBe(count(r.src, /errcode = '40001'/g) + count(r.src, /sqlstate '40001'/g));
    }
  });

  it('no function was added or removed by either stage', () => {
    expect([...afterStage1.keys()].sort()).toEqual([...before.keys()].sort());
    expect([...afterStage2.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('stage 1 changes only the seven handlers and authz.require_row_version, and only the code literal', () => {
    const changed = [...before.values()].filter((r) => JSON.stringify(r) !== JSON.stringify(afterStage1.get(r.sig))).map((r) => `${r.nspname}.${r.proname}`).sort();
    const expected = listed().filter((l) => l.stage !== '2').map(key).sort();
    expect(changed).toEqual(expected);
    for (const [sig, b] of before) {
      const a = afterStage1.get(sig)!;
      expect(attrs(a), sig).toEqual(attrs(b));
      expect(undoStage1(a.def), sig).toBe(b.def);
      expect(undoStage1(a.src), sig).toBe(b.src);
    }
  });

  it('stage 2 changes only the remaining listed functions and the handlers, and only the code literal', () => {
    const changed = [...afterStage1.values()].filter((r) => JSON.stringify(r) !== JSON.stringify(afterStage2.get(r.sig))).map((r) => `${r.nspname}.${r.proname}`).sort();
    const expected = listed().filter((l) => l.stage !== '1').map(key).sort();
    expect(changed.length).toBe(107);
    expect(changed).toEqual(expected);
    for (const [sig, b] of afterStage1) {
      const a = afterStage2.get(sig)!;
      expect(attrs(a), sig).toEqual(attrs(b));
      expect(undoStage2(a.def), sig).toBe(b.def);
      expect(undoStage2(a.src), sig).toBe(b.src);
    }
  });

  it('every 40001 became PT409 one for one (132 literals), and attributes match the original migrations', () => {
    let literals = 0;
    for (const [sig, b] of before) {
      const a = afterStage2.get(sig)!;
      const n = count(b.src, /'40001'/g);
      literals += n;
      expect(count(a.src, /'PT409'/g), sig).toBe(n);
      expect(attrs(a), sig).toEqual(attrs(b));
    }
    expect(literals).toBe(132);
  });

  it('allow-list: after stage 1 only the stage-2 functions still hold a class-40 code; after stage 2 none', () => {
    const class40 = (s: Snapshot) => [...s.values()].filter((r) => ['public', 'authz'].includes(r.nspname) && CLASS_40.test(r.src)).map((r) => `${r.nspname}.${r.proname}`).sort();
    expect(class40(afterStage1)).toEqual(listed().filter((l) => l.stage !== '1').map(key).sort());
    expect(class40(afterStage2)).toEqual([]);
  });

  it('authz.require_row_version raised 40001 before and raises PT409 from stage 1, same token', () => {
    expect(rrvBefore).toMatchObject({ code: CONFLICT_STATE_BEFORE, message: 'version_changed' });
    expect(rrvStage1).toMatchObject({ code: ROW_VERSION_STATE, message: 'version_changed' });
  });
});

describe('B1-1 behaviour after both stages', () => {
  let db: TestDb;
  const h = acc3Helpers(() => db);
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  const failure = async (sql: string, params: unknown[] = []) => {
    await db.exec('savepoint b1_1');
    try {
      await db.query(sql, params);
    } catch (error) {
      await db.exec('rollback to savepoint b1_1');
      return error as { code?: string; message?: string; hint?: string };
    }
    await db.exec('release savepoint b1_1');
    return null;
  };

  it('authz.require_row_version raises exactly PT409 version_changed; an equal version passes', async () => {
    await asOwner(db, async () => {
      expect(await failure('select authz.require_row_version(1, 2)')).toMatchObject({ code: ROW_VERSION_STATE, message: 'version_changed' });
      expect(await failure('select authz.require_row_version(null, 2)')).toMatchObject({ code: ROW_VERSION_STATE, message: 'version_changed' });
      expect(await failure('select authz.require_row_version(3, 3)')).toBeNull();
    });
  });

  it.each(['sm', 'flight', 'visa'] as const)('%s replay wrapper: the same request returns the remembered answer; other details are duplicate_request PT409', async (prefix) => {
    await asOwner(db, async () => {
      const [entity] = await db.query<{ id: string }>('select id from public.legal_entities order by id limit 1');
      const request = (await db.query<{ id: string }>('select gen_random_uuid() as id'))[0]!.id;
      const payload = { synthetic: 'B1-1', n: 1 };
      expect((await db.query<{ r: unknown }>(`select authz.${prefix}_replay($1, $2, 'b1_1_test', $3::jsonb) as r`, [entity!.id, request, payload]))[0]!.r).toBeNull();
      await db.query(`select authz.${prefix}_remember($1, $2, 'b1_1_test', $3::jsonb, $4::jsonb)`, [entity!.id, request, payload, { ok: true }]);
      const replayed = (await db.query<{ r: Record<string, unknown> }>(`select authz.${prefix}_replay($1, $2, 'b1_1_test', $3::jsonb) as r`, [entity!.id, request, payload]))[0]!.r;
      expect(replayed).toMatchObject({ ok: true, outcome: 'existing' });
      expect(await failure(`select authz.${prefix}_replay($1, $2, 'b1_1_test', $3::jsonb)`, [entity!.id, request, { ...payload, n: 2 }]))
        .toMatchObject({ code: CONFLICT_STATE, message: 'duplicate_request' });
      expect(await failure(`select authz.${prefix}_remember($1, $2, 'b1_1_test', $3::jsonb, $4::jsonb)`, [entity!.id, request, payload, { ok: true }]))
        .toMatchObject({ code: CONFLICT_STATE, message: 'duplicate_request' });
    });
  });

  it('automatic bill release: a PT409 refusal from the release holds that bill and the approval still completes', async () => {
    await asOwner(db, async () => {
      const [core] = await db.query<{ args: string; result: string }>(
        `select pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'authz' and p.proname = 'cdoc_release_core'`);
      expect(core, 'authz.cdoc_release_core exists').toBeDefined();
      // Inside this rolled-back transaction only: the release refuses with a conflict.
      await db.exec(`create or replace function authz.cdoc_release_core(${core!.args}) returns ${core!.result}
        language plpgsql volatile security definer set search_path = '' as $$
        begin raise exception 'number_conflict' using errcode = 'PT409'; end; $$;`);
      await h.people();
      await h.docsOn();
      await h.autoBills(true, true);
      await h.approvedBooking();
      const docs = await h.documents();
      const inv = docs.find((d) => d.kind === 'invoice');
      expect(inv, 'invoice drafted at approval').toBeDefined();
      expect(inv).toMatchObject({ status: 'draft', auto_state: 'held', hold_reasons: ['number_conflict'], number: null });
      expect((await h.audits('accounts.customer_document.held')).length).toBeGreaterThan(0);
    });
  });
});
