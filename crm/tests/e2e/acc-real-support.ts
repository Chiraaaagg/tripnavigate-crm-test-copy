import { randomBytes, randomUUID } from 'node:crypto';
import { type Page, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { challengeViaUi, signInViaUi, totpCode, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Accounts phase (contract 2026-11-10), Track E: shared steps of the real
 * browser suites tests/e2e/accounts-phase.real.e2e.ts and
 * tests/e2e/accounts-speed.real.e2e.ts (disposable local stack, production
 * build). Synthetic users are created through the local Auth admin API with
 * a random password per run; booking and money set-up are SYNTHETIC FIXTURE
 * STEPS through the same database commands the screens call, as the visa and
 * flight journeys do. Nothing here runs unless every URL is a loopback address.
 */

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
export const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
export const secretKey = process.env.SUPABASE_SECRET_KEY;
export const configured = Boolean(databaseUrl && supabaseUrl && publishableKey && secretKey);
if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL, the Supabase URL, publishable key or secret key is missing: the Accounts journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Accounts-phase journeys run only against a loopback Supabase stack and database.');
}

const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
export const PASSWORD = `E2e-${randomUUID()}-Pw1`;

export const USERS = {
  sales: { id: 'a0000000-0000-4000-8000-0000000008a1', email: 'e2e.acc.sales@example.test', name: 'E2E Acc Sales', role: 'sales', branch: 'DEL' },
  accA: { id: 'a0000000-0000-4000-8000-0000000008a2', email: 'e2e.acc.accounts.a@example.test', name: 'E2E Acc Accounts A', role: 'accounts', branch: 'JDH' },
  accB: { id: 'a0000000-0000-4000-8000-0000000008a3', email: 'e2e.acc.accounts.b@example.test', name: 'E2E Acc Accounts B', role: 'accounts', branch: 'DEL' },
  accOwner: { id: 'a0000000-0000-4000-8000-0000000008a4', email: 'e2e.acc.accounts.owner@example.test', name: 'E2E Acc Exception Owner', role: 'accounts', branch: 'JDH' },
  manager: { id: 'a0000000-0000-4000-8000-0000000008a5', email: 'e2e.acc.manager@example.test', name: 'E2E Acc Manager', role: 'manager', branch: 'DEL' },
  purchase: { id: 'a0000000-0000-4000-8000-0000000008a6', email: 'e2e.acc.purchase@example.test', name: 'E2E Acc Purchase', role: 'purchase', branch: 'JDH' },
  flight: { id: 'a0000000-0000-4000-8000-0000000008a7', email: 'e2e.acc.flight@example.test', name: 'E2E Acc Flight', role: 'flight', branch: 'JDH' },
  flight2: { id: 'a0000000-0000-4000-8000-0000000008a8', email: 'e2e.acc.flight2@example.test', name: 'E2E Acc Flight Two', role: 'flight', branch: 'JDH' },
  visa: { id: 'a0000000-0000-4000-8000-0000000008a9', email: 'e2e.acc.visa@example.test', name: 'E2E Acc Visa', role: 'visa', branch: 'JDH' },
} as const;
export type UserKey = keyof typeof USERS;

export const db = <T>(fn: (client: pg.Client) => Promise<T>) => withDb(databaseUrl!, fn);
export const admin = () => createClient(supabaseUrl!, secretKey!, { auth: noPersist });
export const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db(async (c) => (await c.query(sql, params)).rows as T[]);
export const sha = () => randomBytes(32).toString('hex');

/** One committed statement as `userId` (PostgREST claims, aal2). */
export async function asUser<T = unknown>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return db(async (client) => {
    await client.query('begin');
    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = { sub: userId, role: 'authenticated', aal: 'aal2', aud: 'authenticated', iat: now, exp: now + 900,
        amr: [{ method: 'password', timestamp: now - 30 }, { method: 'totp', timestamp: now - 30 }] };
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ r: T }>(sql, params);
      await client.query('commit');
      return rows[0]?.r as T;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

export async function putObject(bucket: string, path: string, mime = 'application/pdf') {
  const bytes = new Uint8Array(2048).fill(32);
  bytes.set(Buffer.from('%PDF-1.4\n% synthetic test file\n'), 0);
  const { error } = await admin().storage.from(bucket).upload(path, new Blob([bytes], { type: mime }), { contentType: mime, upsert: false });
  if (error) throw new Error(`upload to ${bucket} failed: ${error.message}`);
}

/** Creates the synthetic users, profiles, memberships and a TOTP factor each; returns the TOTP secrets. */
export async function prepareUsers(): Promise<Record<UserKey, string>> {
  const env = await q<{ environment: string }>('select environment from public.deployment_settings where id');
  expect(env[0]?.environment, "the Accounts journey needs the 'test' deployment environment").toBe('test');
  const a = admin();
  for (const u of Object.values(USERS)) {
    const created = await a.auth.admin.createUser({ id: u.id, email: u.email, password: PASSWORD, email_confirm: true });
    if (created.error) {
      if (!/already/i.test(created.error.message)) throw new Error(`could not create ${u.email}: ${created.error.message}`);
      const updated = await a.auth.admin.updateUserById(u.id, { password: PASSWORD });
      if (updated.error) throw new Error(`could not reset ${u.email}: ${updated.error.message}`);
    }
  }
  await db(async (client) => {
    for (const u of Object.values(USERS)) {
      await client.query(`insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
        values ($1, $2, $3, 'active', now()) on conflict (user_id) do nothing`, [u.id, u.name, u.email]);
      await client.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = $3
           and not exists (select 1 from public.memberships m where m.user_id = $1 and m.branch_id = b.id and m.role_code = $2)`,
        [u.id, u.role, u.branch]);
    }
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
  });
  const secrets = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as Array<[UserKey, (typeof USERS)[UserKey]]>) {
    const c = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
    const signed = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (signed.error) throw new Error(`${key} sign-in failed`);
    const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `acc-${key}-${Date.now()}` });
    if (enrolled.error) throw new Error(`${key} TOTP enrolment failed`);
    const verified = await c.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
    if (verified.error) throw new Error(`${key} TOTP verification failed`);
    secrets[key] = enrolled.data.totp.secret;
    await c.auth.signOut({ scope: 'local' });
  }
  return secrets;
}

/** Signs `key` in through the real screens (password + TOTP). */
export async function signIn(page: Page, key: UserKey, secrets: Record<UserKey, string>) {
  await signInViaUi(page, USERS[key].email, PASSWORD);
  await challengeViaUi(page, secrets[key]);
  await expect(page).toHaveURL(/\/app/);
}

/** SYNTHETIC FIXTURE STEP: a new synthetic Deal in Delhi owned by the E2E Sales user. */
export async function freshDeal(ref: string): Promise<string> {
  return (await q<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
     select b.legal_entity_id, b.id, $1, 'E2E Accounts phase deal (synthetic)', $2, true
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [ref, USERS.sales.id]))[0]!.id;
}

/** Seconds since `t0` (ms) rounded to ms, for the speed log. */
export const since = (t0: number) => Math.round(performance.now() - t0);
export const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
