import type { ViewerAccess } from '@/modules/access/policy';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { type Actor, type TestDb, resetActor, setActor } from '../helpers/db';

const argTypes = new WeakMap<TestDb, Map<string, Map<string, string>>>();

/** Argument name → SQL type of public.<fn> (cached per database). */
async function argTypesOf(d: TestDb, fn: string): Promise<Map<string, string>> {
  let byFn = argTypes.get(d);
  if (!byFn) argTypes.set(d, (byFn = new Map()));
  const known = byFn.get(fn);
  if (known) return known;
  const rows = await d.query<{ name: string; type: string }>(
    `select x.name, format_type(x.t, null) as type
       from pg_proc p, unnest(p.proargnames, p.proargtypes::oid[]) as x(name, t)
      where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
    [fn],
  );
  const map = new Map(rows.map((r) => [r.name, r.type]));
  byFn.set(fn, map);
  return map;
}

/**
 * Runs `public.<fn>(p_x => $n, …)` as the actor, the way PostgREST would, so
 * the real TS wrappers and actions run against PGlite or a real Postgres.
 * Like PostgREST, a value goes to a json/jsonb argument as JSON (an empty
 * list stays the JSON array `[]`); only SQL array arguments (text[], uuid[])
 * get driver arrays. Errors come back as { code, message, hint }. Each call
 * sits in its own savepoint inside the test's rolled-back transaction.
 */
export function rpcAs(db: () => TestDb, actor: Actor): RpcClient {
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (!/^[a-z_]+$/.test(fn)) throw new Error('bad function name');
      const d = db();
      const types = await argTypesOf(d, fn);
      const names = Object.keys(args);
      const params = names.map((k) => {
        const v = args[k];
        if (v === null || v === undefined) return null;
        const type = types.get(k) ?? '';
        if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
        if (Array.isArray(v) && type.endsWith('[]')) return v;
        return typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      await d.exec('savepoint ts_rpc');
      try {
        await setActor(d, actor);
        const rows = await d.query<{ r: unknown }>(sql, params);
        await resetActor(d);
        await d.exec('release savepoint ts_rpc');
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        await d.exec('rollback to savepoint ts_rpc');
        await resetActor(d);
        const err = e as { code?: string; message?: string; hint?: string };
        return { data: null, error: { code: err.code, message: err.message, hint: err.hint ?? null } };
      }
    },
  };
}

/**
 * The narrow Data API read the loaders use: `from(table).select(columns).eq(column, value)`
 * as the actor, under RLS. Identifiers only (checked); one equality filter.
 */
function fromAs(db: () => TestDb, actor: Actor) {
  return (table: string) => ({
    select: (columns: string) => ({
      async eq(column: string, value: unknown) {
        const cols = columns.split(',').map((c) => c.trim());
        if (![table, column, ...cols].every((x) => /^[a-z_]+$/.test(x))) throw new Error('bad identifier');
        const d = db();
        await d.exec('savepoint ts_from');
        try {
          await setActor(d, actor);
          const rows = await d.query<Record<string, unknown>>(`select ${cols.join(', ')} from public.${table} where ${column} = $1`, [value]);
          await resetActor(d);
          await d.exec('release savepoint ts_from');
          return { data: rows, error: null };
        } catch (e) {
          await d.exec('rollback to savepoint ts_from');
          await resetActor(d);
          const err = e as { code?: string; message?: string };
          return { data: null, error: { code: err.code, message: err.message } };
        }
      },
    }),
  });
}

/** A staff context like requireStaff() returns (memberships as given; none by default, so never Purchase). */
export function staffAs(db: () => TestDb, actor: Actor, memberships: ViewerAccess['memberships'] = []) {
  const access: ViewerAccess = { userId: actor.userId ?? '', memberships, rolePermissions: [], grants: [] };
  return { supabase: { ...rpcAs(db, actor), from: fromAs(db, actor) }, access };
}
