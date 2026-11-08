import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { isLoopbackDatabaseUrl } from './test-env.mjs';

/**
 * Database harness for the RLS/authorization tests.
 *
 * Default: an in-process PGlite (PostgreSQL compiled to WASM) loaded with a
 * small Supabase shim, the real migrations and the synthetic fixtures.
 *
 * When TEST_DATABASE_URL is set (CI job "supabase-integration"), the same tests
 * run against a real local Supabase Postgres that was reset and seeded with
 * `supabase db reset` + `scripts/seed-local.mjs`.
 */

const root = join(import.meta.dirname, '..', '..');
const migrationsDir = join(root, 'supabase', 'migrations');

export const FIXTURE_USERS = {
  salesDelhiA: 'a0000000-0000-4000-8000-000000000001',
  salesDelhiB: 'a0000000-0000-4000-8000-000000000002',
  purchaseJodhpur: 'a0000000-0000-4000-8000-000000000003',
  salesAhmedabad: 'a0000000-0000-4000-8000-000000000004',
  managerDelhi: 'a0000000-0000-4000-8000-000000000005',
  accountsJodhpur: 'a0000000-0000-4000-8000-000000000006',
  adminJodhpur: 'a0000000-0000-4000-8000-000000000007',
  formerStaff: 'a0000000-0000-4000-8000-000000000008',
  movedStaff: 'a0000000-0000-4000-8000-000000000009',
  salesEntityB: 'a0000000-0000-4000-8000-000000000010',
  visaJodhpur: 'a0000000-0000-4000-8000-000000000011',
  invitedStaff: 'a0000000-0000-4000-8000-000000000012',
  managerAhmedabad: 'a0000000-0000-4000-8000-000000000013',
} as const;

export const FIXTURE_DEALS = {
  del001: 'd0000000-0000-4000-8000-000000000001',
  del002: 'd0000000-0000-4000-8000-000000000002',
  amd001: 'd0000000-0000-4000-8000-000000000003',
  del003: 'd0000000-0000-4000-8000-000000000004',
  del004: 'd0000000-0000-4000-8000-000000000005',
  b001: 'd0000000-0000-4000-8000-000000000006',
} as const;

export const FIXTURE_EMAILS: Record<keyof typeof FIXTURE_USERS, string> = {
  salesDelhiA: 'sales.delhi.a@example.test',
  salesDelhiB: 'sales.delhi.b@example.test',
  purchaseJodhpur: 'purchase.jodhpur@example.test',
  salesAhmedabad: 'sales.ahmedabad@example.test',
  managerDelhi: 'manager.delhi@example.test',
  accountsJodhpur: 'accounts.jodhpur@example.test',
  adminJodhpur: 'admin.jodhpur@example.test',
  formerStaff: 'former.staff@example.test',
  movedStaff: 'moved.staff@example.test',
  salesEntityB: 'sales.entityb@example.test',
  visaJodhpur: 'visa.jodhpur@example.test',
  invitedStaff: 'invited.staff@example.test',
  managerAhmedabad: 'manager.ahmedabad@example.test',
};

export interface TestDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly mode: 'pglite' | 'postgres';
}

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(migrationsDir, f));
}

/**
 * Fixture files in the same order as scripts/seed-local.mjs:
 * synthetic_fixtures.sql first (base rows), then the rest by name.
 */
export function fixtureFiles(): string[] {
  const dir = join(root, 'supabase', 'fixtures');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => (a === 'synthetic_fixtures.sql' ? -1 : b === 'synthetic_fixtures.sql' ? 1 : a.localeCompare(b)))
    .map((f) => join(dir, f));
}

/**
 * Refuses any database that is not fresh or synthetic (contract Phase 6, 2.5;
 * AUDIT-014): tests write fixtures and relabel the database, so only
 * 'unset' (fresh reset), 'test' (synthetic fixtures) or a database without
 * the setting (before migrations) is allowed. 'operational' and 'staging'
 * (the label a local database holding real Bitrix data was given) are
 * refused, as is any label this guard does not know.
 */
export async function assertNotOperational(query: (sql: string) => Promise<Array<{ environment?: string }>>): Promise<void> {
  const rows = await query(
    'select s.environment from public.deployment_settings s where s.id',
  ).catch((error: { code?: string }) => {
    // 42P01: the table does not exist yet (fresh database before migrations).
    if (error?.code === '42P01') return [];
    throw error;
  });
  const refused = rows.find((r) => r.environment !== 'unset' && r.environment !== 'test');
  if (refused) {
    throw new Error(
      `refusing to run tests against a database whose deployment environment is ${String(refused.environment)}; only 'unset' or 'test' is allowed`,
    );
  }
}

/**
 * Refuses a database URL that is not a loopback address: tests write
 * fixtures, so they never connect to a hosted database (Milestone A section 6).
 */
export function assertLoopbackDatabaseUrl(url: string): void {
  if (!isLoopbackDatabaseUrl(url)) {
    throw new Error('refusing to run tests against a database that is not on a loopback address (local or CI stack only)');
  }
}

/**
 * Replaces the synthetic portal's active Deal manifest with one for `ids` on the
 * fixture business day (2026-09-15 IST, source SYNTHETIC_SRC), through the audited
 * operator commands under the service role. Call inside asOwner(): it is rolled
 * back with the test. Deals enter only through an approved manifest (PR #13 review fix 1).
 */
export async function useDealManifest(db: TestDb, ids: number[]): Promise<void> {
  const service = async (sql: string, params: unknown[]) => {
    await setActor(db, { userId: null, role: 'service_role' });
    await db.query(sql, params);
    await resetActor(db);
  };
  const [active] = await db.query<{ id: string }>(
    `select id from public.intake_manifests where config_id = $1 and source_object = 'deal' and status = 'active'`,
    [SYNTHETIC_INTAKE_CONFIG],
  );
  if (active) await service('select public.integration_manifest_close($1, $2)', [active.id, 'test-suite']);
  await service(
    'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8)',
    [SYNTHETIC_INTAKE_CONFIG, 'deal', 'SYNTHETIC_SRC', '2026-09-15', '2026-09-15T00:00:00+05:30', '2026-09-16T00:00:00+05:30', ids, 'test-suite'],
  );
}

/** Same refusal for real-stack suites that open their own owner connection. */
export async function assertDatabaseUrlNotOperational(url: string): Promise<void> {
  assertLoopbackDatabaseUrl(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assertNotOperational(async (sql) => (await client.query(sql)).rows);
  } finally {
    await client.end();
  }
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    assertLoopbackDatabaseUrl(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await assertNotOperational(async (sql) => (await client.query(sql)).rows);
    } catch (error) {
      await client.end();
      throw error;
    }
    return {
      mode: 'postgres',
      async query(sql, params) {
        return (await client.query(sql, params as unknown[])).rows;
      },
      async exec(sql) {
        await client.query(sql);
      },
      async close() {
        await client.end();
      },
    };
  }

  const db = new PGlite();
  await db.exec(readFileSync(join(root, 'tests', 'helpers', 'supabase-shim.sql'), 'utf8'));
  const users = Object.entries(FIXTURE_USERS)
    .map(([key, id]) => `('${id}', '${FIXTURE_EMAILS[key as keyof typeof FIXTURE_USERS]}')`)
    .join(',\n');
  await db.exec(`insert into auth.users (id, email) values ${users};`);
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(file, 'utf8'));
  }
  for (const file of fixtureFiles()) {
    await db.exec(readFileSync(file, 'utf8'));
  }
  return {
    mode: 'pglite',
    async query(sql, params) {
      return (await db.query(sql, params)).rows as never;
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

export type Aal = 'aal1' | 'aal2';

export interface AmrEntry {
  method: string;
  timestamp: number;
}

export interface Actor {
  /** Fixture user id, or null for an anonymous (publishable-key only) request. */
  userId: string | null;
  aal?: Aal;
  /**
   * Authentication methods reference. Default: password + totp, both 60 s ago.
   * `null` omits the claim; any other value (even malformed) is sent verbatim.
   */
  amr?: unknown;
  /** Issued-at (seconds). Default: now. */
  iat?: number;
  /** 'service_role' impersonates the secret-key server client (userId ignored). */
  role?: 'authenticated' | 'service_role';
  /** JWT session_id claim (auth.sessions.id). Omitted by default. */
  sessionId?: string;
}

/** Current time in whole seconds since epoch (the JWT clock). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** amr for a session that authenticated `secondsAgo` seconds ago (negative = in the future). */
export function amrAt(secondsAgo: number): AmrEntry[] {
  const t = nowSeconds() - secondsAgo;
  return [
    { method: 'password', timestamp: t },
    { method: 'totp', timestamp: t },
  ];
}

/** JWT claims as PostgREST would expose them for this actor. */
export function claimsFor(actor: Actor): Record<string, unknown> {
  if (actor.role === 'service_role') return { role: 'service_role' };
  if (!actor.userId) return { role: 'anon' };
  const claims: Record<string, unknown> = {
    sub: actor.userId,
    role: 'authenticated',
    aal: actor.aal ?? 'aal2',
    aud: 'authenticated',
    iat: actor.iat ?? nowSeconds(),
    exp: (actor.iat ?? nowSeconds()) + 900,
  };
  const amr = actor.amr === undefined ? amrAt(60) : actor.amr;
  if (amr !== null) claims.amr = amr;
  if (actor.sessionId) claims.session_id = actor.sessionId;
  return claims;
}

/**
 * Switches the impersonated request inside an open transaction (claims plus
 * `SET LOCAL ROLE`). Use within as()/asOwner() for multi-step scenarios.
 */
export async function setActor(db: TestDb, actor: Actor): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  const role = actor.role === 'service_role' ? 'service_role' : actor.userId ? 'authenticated' : 'anon';
  await db.exec(`set local role ${role}`);
}

/** Back to the database owner inside the current transaction. */
export async function resetActor(db: TestDb): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', true)`);
}

/**
 * Runs `fn` inside a transaction that impersonates a Data API request exactly as
 * PostgREST does: verified JWT claims in `request.jwt.claims` plus
 * `SET LOCAL ROLE authenticated|anon|service_role`. Everything is rolled back afterwards.
 */
export async function as<T>(db: TestDb, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    await setActor(db, actor);
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

/**
 * Inserts an MFA factor as the Auth server would (owner privileges). Works on
 * the PGlite shim and on a real Supabase auth.mfa_factors table. Default
 * created_at is one second after the current clock: a real enrolment happens
 * well after the recovery provider step, and PGlite's clock can repeat a value
 * within the same millisecond.
 */
export async function insertFactor(
  db: TestDb,
  factor: { userId: string; status?: 'verified' | 'unverified'; createdAt?: string; id?: string },
): Promise<string> {
  const id = factor.id ?? crypto.randomUUID();
  await db.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values ($1, $2, $3, 'totp', $4, coalesce($5::timestamptz, clock_timestamp() + interval '1 second'), now())`,
    [id, factor.userId, `test-${id}`, factor.status ?? 'verified', factor.createdAt ?? null],
  );
  return id;
}

/** Runs `fn` as the database owner inside a rolled-back transaction. */
export async function asOwner<T>(db: TestDb, fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

/**
 * Asserts that `run` fails with the given SQLSTATE/message. Uses a savepoint so
 * the surrounding impersonated transaction stays usable afterwards.
 */
export async function expectDbError(
  db: TestDb,
  run: () => Promise<unknown>,
  matcher: { code?: string; message?: RegExp },
): Promise<void> {
  await db.exec('savepoint expect_error');
  let failed = false;
  try {
    await run();
  } catch (error) {
    failed = true;
    await db.exec('rollback to savepoint expect_error');
    const e = error as { code?: string; message?: string };
    if (matcher.code && e.code !== matcher.code) {
      throw new Error(`expected SQLSTATE ${matcher.code}, got ${e.code}: ${e.message}`);
    }
    if (matcher.message && !matcher.message.test(e.message ?? '')) {
      throw new Error(`expected message ${matcher.message}, got: ${e.message}`);
    }
  }
  if (!failed) {
    throw new Error('expected a database error, but the statement succeeded');
  }
}

/**
 * Inserts an Auth session row as the Auth server would after an MFA verify
 * (factor_id set). Works on the shim; on real Supabase auth.sessions has the
 * same columns (aal is an enum there).
 */
export async function insertSession(
  db: TestDb,
  session: { userId: string; factorId: string | null; id?: string },
): Promise<string> {
  const id = session.id ?? crypto.randomUUID();
  await db.query(
    `insert into auth.sessions (id, user_id, factor_id, aal, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())`,
    [id, session.userId, session.factorId, session.factorId ? 'aal2' : 'aal1'],
  );
  return id;
}

/** Business date (YYYY-MM-DD) in Asia/Kolkata for an instant. */
export function istBusinessDate(at: Date = new Date()): string {
  return new Date(at.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** Synthetic intake config id (supabase/fixtures/intake_synthetic.sql). */
export const SYNTHETIC_INTAKE_CONFIG = 'c0000000-0000-4000-8000-000000000001';

/**
 * Real-stack suites (local database only): closes any active manifest for the
 * synthetic config and object, then opens a run manifest through the audited
 * operator command. Returns the new manifest id. Manifests are never deleted;
 * call closeRunManifests in afterAll.
 */
export async function openRunManifest(
  url: string,
  m: { object: 'deal' | 'lead'; ids: number[]; sourceCode: string; businessDate: string },
): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assertNotOperational(async (sql) => (await client.query(sql)).rows);
    await client.query(
      `select public.integration_manifest_close(m.id, 'real-stack-suite')
       from public.intake_manifests m where m.config_id = $1 and m.source_object = $2 and m.status = 'active'`,
      [SYNTHETIC_INTAKE_CONFIG, m.object],
    );
    const { rows } = await client.query<{ r: { manifestId: string } }>(
      // The interval is the business date in Asia/Kolkata, [00:00, +1 day).
      `select public.integration_manifest_create($1, $2, $3, $4::date,
         $4::date::timestamp at time zone 'Asia/Kolkata', ($4::date::timestamp at time zone 'Asia/Kolkata') + interval '1 day',
         $5::bigint[], 'real-stack-suite') as r`,
      [SYNTHETIC_INTAKE_CONFIG, m.object, m.sourceCode, m.businessDate, m.ids],
    );
    return rows[0]!.r.manifestId;
  } finally {
    await client.end();
  }
}

export async function closeRunManifests(url: string, manifestIds: string[]): Promise<void> {
  if (manifestIds.length === 0) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`select public.integration_manifest_close(id, 'real-stack-suite') from unnest($1::uuid[]) as id`, [manifestIds]);
  } finally {
    await client.end();
  }
}
