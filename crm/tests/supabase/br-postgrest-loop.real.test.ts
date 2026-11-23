import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, sleep } from '../helpers/real-stack';

/**
 * Gate G0 of the booking reliability build contract (B1-1). Runs ONLY in
 * .github/workflows/postgrest-loop.yml, which starts a second PostgREST pinned
 * to the live version (default v14.18) next to the local Supabase stack and
 * sets G0_PINNED_REST_URL. Every other job (ci.yml, targeted.yml) skips it.
 *
 * Questions it answers, on synthetic data in a disposable local database:
 *   1. Which PostgREST version does the default CI stack run, and which the pinned one?
 *   2. Does a refusal raised with SQLSTATE 40001 make PostgREST re-run the call
 *      after the client has gone (the live loop)? Counted for 30 s.
 *   3. Is a refusal raised with PT409 executed exactly once, answered HTTP 409
 *      within 1 s, with `code`, `message` and `hint` intact? Same for the
 *      fallback TN409 (expected HTTP 400) and plain P0001.
 *   4. The same for the real save path: booking_trip_save with a stale row
 *      version (authz.require_row_version raises version_changed / 40001), and
 *      again after authz.require_row_version is changed in this disposable
 *      database only to raise PT409 (a preview of stage 1; no migration).
 *
 * Counting: the scratch functions call nextval() on their own sequence before
 * raising (a sequence is not rolled back), so every execution is counted
 * exactly. For the real function: pg_stat_statements calls of PostgREST's
 * set_config preamble (one per attempt), the database rollback counter and (in
 * the workflow) database log lines.
 *
 * The result JSON is written to G0_OUT. The test asserts only the PT409
 * expectations (expect.soft) and the harness itself; the 40001 numbers are
 * recorded, not judged.
 */

const env = resolveRealStackEnv();
const pinnedUrl = process.env.G0_PINNED_REST_URL?.trim() || null;
const dbUrl = process.env.TEST_DATABASE_URL?.trim() || null;
const outFile = process.env.G0_OUT?.trim() || 'test-results/g0/postgrest-loop.json';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const enabled = Boolean(env && pinnedUrl && dbUrl);
if (enabled) {
  for (const target of [pinnedUrl!, dbUrl!]) {
    if (!LOCAL.has(new URL(target).hostname)) throw new Error('G0 runs only against a local stack');
  }
}
const stack = enabled ? createRealStack(env!) : null;
const defaultRestUrl = env ? `${env.url.replace(/\/$/, '')}/rest/v1` : '';

const CLIENT_TIMEOUT_MS = 5_000;
const WATCH_MS = 30_000;
const CASES = [
  { name: 'pt409', code: 'PT409', expectStatus: 409 },
  { name: 'tn409', code: 'TN409', expectStatus: 400 },
  { name: 'p0001', code: 'P0001', expectStatus: 400 },
  // Last on each server: a looping call keeps one PostgREST connection busy.
  { name: 'c40001', code: '40001', expectStatus: null },
] as const;
const TRIP = { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-12', paxTotal: 2, children: 0, infants: 0 };

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), clientTimeoutMs: CLIENT_TIMEOUT_MS, watchMs: WATCH_MS };
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();

async function q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function attempts(caseName: string): Promise<number> {
  const [row] = await q<{ n: string }>(`select case when is_called then last_value else 0 end::text as n from public.br_g0_seq_${caseName}`);
  return Number(row!.n);
}

async function restSessions() {
  return q<{ pid: number; app: string; state: string | null; xact_age_s: number | null; query: string }>(
    `select pid, application_name as app, state, extract(epoch from now() - xact_start)::int as xact_age_s, left(query, 120) as query
       from pg_stat_activity where application_name ilike 'postgrest%' order by pid`,
  );
}

/** Ends every busy PostgREST session (a running loop). Disposable local database only. */
async function endBusyRestSessions(): Promise<number> {
  const rows = await q<{ ended: boolean }>(
    `select pg_terminate_backend(pid) as ended from pg_stat_activity
      where application_name ilike 'postgrest%' and state is distinct from 'idle' and pid <> pg_backend_pid()`,
  );
  await sleep(1_000);
  return rows.filter((r) => r.ended).length;
}

async function rollbacks(): Promise<number> {
  const [row] = await q<{ n: string }>('select xact_rollback::text as n from pg_stat_database where datname = current_database()');
  return Number(row!.n);
}

/**
 * Calls of PostgREST's per-request set_config(...) preamble (pg_stat_statements).
 * A refused statement is not recorded by pg_stat_statements, but the preamble
 * before it is, once per attempt: the live evidence counted loops this way.
 */
async function preambleCalls(): Promise<number | null> {
  try {
    const [row] = await q<{ n: string | null }>(
      `select coalesce(sum(calls), 0)::text as n from extensions.pg_stat_statements
        where query ilike '%set_config(%' and query ilike '%request.%' and query not ilike '%pg_stat_statements%'`,
    );
    return Number(row?.n ?? '0');
  } catch {
    return null;
  }
}

interface CallResult {
  status: number | null;
  ms: number;
  aborted: boolean;
  body: unknown;
  server: string | null;
  error: string | null;
}

async function call(base: string, fn: string, args: Record<string, unknown>, token: string | null): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  const started = Date.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (base === defaultRestUrl) headers.apikey = env!.publishableKey;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base}/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { status: res.status, ms: Date.now() - started, aborted: false, body, server: res.headers.get('server'), error: null };
  } catch (error) {
    return { status: null, ms: Date.now() - started, aborted: controller.signal.aborted, body: null, server: null, error: String(error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Samples a counter at 0, 5, 15 and 30 s after the client has gone. */
async function watch(counter: () => Promise<number | null>): Promise<Array<{ afterMs: number; value: number | null }>> {
  const samples: Array<{ afterMs: number; value: number | null }> = [];
  const t0 = Date.now();
  for (const at of [0, 5_000, 15_000, WATCH_MS]) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    samples.push({ afterMs: Date.now() - t0, value: await counter() });
  }
  return samples;
}

function bodyFields(body: unknown) {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return { code: b.code ?? null, message: b.message ?? null, hint: b.hint ?? null, details: b.details ?? null };
}

function save() {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);
}

let token = '';
let versionId = '';
let rowVersion = 0;
let dealId = '';
let switchWasOn = false;
let originalRequireRowVersion: string | null = null;

beforeAll(async () => {
  if (!enabled) return;
  await q('create extension if not exists pg_stat_statements with schema extensions').catch(() => undefined);
  for (const c of CASES) {
    await q(`create sequence if not exists public.br_g0_seq_${c.name}`);
    await q(`create or replace function public.br_g0_${c.name}() returns void
      language plpgsql volatile security definer set search_path = '' as $$
      begin
        perform nextval('public.br_g0_seq_${c.name}');
        raise exception 'version_changed' using errcode = '${c.code}', hint = 'g0Hint,secondKey';
      end $$`);
    await q(`revoke all on function public.br_g0_${c.name}() from public`);
    await q(`grant execute on function public.br_g0_${c.name}() to anon, authenticated`);
  }
  await q(`notify pgrst, 'reload schema'`);
  await sleep(3_000);

  // The real save path: a draft on a synthetic Deal, owned by a synthetic Sales user (aal2).
  const [s] = await q<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
  switchWasOn = s!.on;
  await q(`select set_config('tripnavigate.change_reason', 'br-postgrest-loop.real.test.ts: switch on for the run', false);
           update public.workflow_settings set service_items_enabled = true where id`);
  const [deal] = await q<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic G0 deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [`SYN-G0-${runTag}`, FIXTURE_USERS.salesDelhiA],
  );
  dealId = deal!.id;
  const owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  token = owner.session.access_token;
  const started = await owner.client.rpc('booking_form_start', { p_deal_id: dealId });
  if (started.error) throw new Error(`booking_form_start failed: ${started.error.code} ${started.error.message}`);
  versionId = (started.data as { versionId: string }).versionId;
  rowVersion = (started.data as { rowVersion: number }).rowVersion;
  results.realFunction = { fn: 'booking_trip_save', dealId, versionId, rowVersion, staleExpected: rowVersion + 1000 };
});

afterAll(async () => {
  if (!enabled) return;
  results.endedAt = new Date().toISOString();
  results.restSessionsAtEnd = await restSessions().catch((e: unknown) => String(e));
  save();
  if (originalRequireRowVersion) await q(originalRequireRowVersion).catch(() => undefined);
  await q(`select set_config('tripnavigate.change_reason', 'br-postgrest-loop.real.test.ts: restore switch', false);
           update public.workflow_settings set service_items_enabled = $1 where id`, [switchWasOn]).catch(() => undefined);
  await stack!.cleanup();
});

describe.skipIf(!enabled)('G0: PostgREST retry behaviour for 40001 and PT409 (postgrest-loop.yml only)', () => {
  it('1. records the PostgREST versions', async () => {
    // One harmless call on each server so both have open sessions to read.
    const pinnedRoot = await fetch(`${pinnedUrl}/`).then((r) => ({ status: r.status, server: r.headers.get('server') })).catch((e: unknown) => ({ status: null, server: String(e) }));
    const defaultRoot = await call(defaultRestUrl, 'br_g0_pt409', {}, null);
    await call(pinnedUrl!, 'br_g0_pt409', {}, null);
    await sleep(500);
    const sessions = await restSessions();
    results.versions = {
      applicationNames: [...new Set(sessions.map((s) => s.app))],
      pinnedRoot,
      defaultServerHeader: defaultRoot.server,
      pinnedImageTag: process.env.G0_PINNED_TAG ?? null,
      defaultImage: process.env.G0_DEFAULT_IMAGE ?? null,
    };
    save();
    expect(sessions.length).toBeGreaterThan(0);
  });

  for (const server of ['pinned', 'default'] as const) {
    for (const c of CASES) {
      it(`2/3. ${server}: scratch refusal with ${c.code}`, async () => {
        const base = server === 'pinned' ? pinnedUrl! : defaultRestUrl;
        const watchCounter = () => attempts(c.name);
        await endBusyRestSessions();
        const before = await attempts(c.name);
        const res = await call(base, `br_g0_${c.name}`, {}, null);
        const samples = await watch(watchCounter);
        const executions = samples.map((s) => ({ afterMs: s.afterMs, executions: (s.value ?? 0) - before }));
        const ended = await endBusyRestSessions();
        const entry = {
          server,
          code: c.code,
          http: { status: res.status, ms: res.ms, aborted: res.aborted, error: res.error },
          body: bodyFields(res.body),
          executionsAfterClientGone: executions,
          executionsTotal: executions.at(-1)?.executions ?? null,
          busySessionsEndedAfterWatch: ended,
        };
        (results.scratch ??= {} as Record<string, unknown>);
        (results.scratch as Record<string, unknown>)[`${server}-${c.name}`] = entry;
        save();
        expect(res.status !== null || res.aborted).toBe(true);
        if (server === 'pinned' && c.code === 'PT409') {
          expect.soft(entry.executionsTotal, 'PT409 executed exactly once').toBe(1);
          expect.soft(res.status, 'PT409 answered HTTP 409').toBe(409);
          expect.soft(res.ms, 'PT409 answered within 1 s').toBeLessThan(1_000);
          expect.soft(entry.body.code).toBe('PT409');
          expect.soft(entry.body.message).toBe('version_changed');
          expect.soft(entry.body.hint).toBe('g0Hint,secondKey');
        }
      }, 120_000);
    }
  }

  async function realCase(label: string, base: string) {
    await endBusyRestSessions();
    const pre0 = await preambleCalls();
    const rb0 = await rollbacks();
    const res = await call(base, 'booking_trip_save', { p_version_id: versionId, p_expected_row_version: rowVersion + 1000, p_fields: TRIP }, token);
    const samples = await watch(async () => (await rollbacks()) - rb0);
    const pre1 = await preambleCalls();
    const calls = pre0 === null || pre1 === null ? null : pre1 - pre0;
    const sessionsDuring = await restSessions();
    const ended = await endBusyRestSessions();
    const entry = {
      server: label,
      http: { status: res.status, ms: res.ms, aborted: res.aborted, error: res.error },
      body: bodyFields(res.body),
      rollbacksAfterClientGone: samples,
      preambleCallsDuringCase: calls,
      busyRestSessionsBeforeEnd: sessionsDuring.filter((s) => s.state && s.state !== 'idle').length,
      busySessionsEnded: ended,
    };
    (results.real ??= {} as Record<string, unknown>);
    (results.real as Record<string, unknown>)[label] = entry;
    save();
    return entry;
  }

  it('4a. pinned: real booking_trip_save with a stale row version (raises 40001 today)', async () => {
    const entry = await realCase('pinned-40001', pinnedUrl!);
    expect(entry.http.status !== null || entry.http.aborted).toBe(true);
  }, 120_000);

  it('4b. default stack: the same stale save', async () => {
    const entry = await realCase('default-40001', defaultRestUrl);
    expect(entry.http.status !== null || entry.http.aborted).toBe(true);
  }, 120_000);

  it('4c. pinned: the same stale save after require_row_version raises PT409 (disposable database only)', async () => {
    const [def] = await q<{ d: string }>(
      `select pg_get_functiondef('authz.require_row_version(integer,integer)'::regprocedure) as d`,
    );
    originalRequireRowVersion = def!.d;
    const changed = def!.d.replace(/'40001'/g, "'PT409'");
    results.stage1Preview = { replacedLiterals: (def!.d.match(/'40001'/g) ?? []).length };
    expect(changed).not.toBe(def!.d);
    await q(changed);
    const entry = await realCase('pinned-PT409-preview', pinnedUrl!);
    await q(originalRequireRowVersion);
    originalRequireRowVersion = null;
    expect.soft(entry.http.status, 'real save refused with HTTP 409').toBe(409);
    expect.soft(entry.http.ms, 'within 1 s').toBeLessThan(1_000);
    expect.soft(entry.body.code).toBe('PT409');
    expect.soft(entry.body.message).toBe('version_changed');
    expect.soft(entry.preambleCallsDuringCase, 'one execution (one PostgREST preamble)').toBe(1);
  }, 120_000);
});
