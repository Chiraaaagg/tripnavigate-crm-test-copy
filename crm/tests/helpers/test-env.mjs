/**
 * Test-runner isolation (Phase 5B Milestone A section 6, audit finding 10).
 *
 * Test runners must never use hosted values. Two leaks are closed here:
 *   1. `crm/.env.local` (hosted URL, keys, database password) is loaded by
 *      Next.js into any `next dev` / `next start` process that does not
 *      already have the variable. Playwright web servers therefore get every
 *      Supabase/site value explicitly, plus __NEXT_PROCESSED_ENV=true, which
 *      makes @next/env skip reading .env files. Vitest sets envDir: false.
 *   2. A shell that exports a hosted URL. Every URL a test runner can reach is
 *      validated: anything that is not a loopback address is refused before a
 *      single test runs.
 *
 * Plain JavaScript (with test-env.d.mts) so vitest.config.ts, the Playwright
 * configs and scripts can import it with an explicit file extension.
 */

import { parse as parseConnectionString } from 'pg-connection-string';

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True only for a parseable URL whose host is a loopback address. */
export function isLoopbackUrl(value) {
  if (!value) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * True only for a Postgres connection URL whose EFFECTIVE target is loopback.
 * node-pg (via pg-connection-string) lets ?host= and ?hostaddr= override the
 * authority, and accepts unix-socket paths; the URL hostname alone is not
 * enough. The parsed host (and hostaddr, when given) must be loopback, any
 * host/hostaddr query parameter must not point elsewhere, and socket paths
 * are refused.
 */
export function isLoopbackDatabaseUrl(value) {
  if (!value) return false;
  let url;
  let parsed;
  try {
    url = new URL(value);
    parsed = parseConnectionString(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const host = parsed.host ?? '';
  if (!host || host.startsWith('/') || host.includes(',') || !LOOPBACK_HOSTS.has(host)) return false;
  if (parsed.hostaddr !== undefined && parsed.hostaddr !== null && !LOOPBACK_HOSTS.has(String(parsed.hostaddr))) return false;
  for (const key of ['host', 'hostaddr']) {
    for (const v of url.searchParams.getAll(key)) {
      if (!LOOPBACK_HOSTS.has(v)) return false;
    }
  }
  return true;
}

const DATABASE_URL_VARIABLES = new Set(['TEST_DATABASE_URL', 'DATABASE_URL']);

/** Every variable a test runner or the app under test uses to reach a service. */
export const TEST_URL_VARIABLES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SITE_URL',
  'APP_BASE_URL',
  'MAILPIT_URL',
  'TEST_DATABASE_URL',
  'DATABASE_URL',
];

/** Placeholder values: nothing with real data listens there, and none is a secret. */
export const LOOPBACK_DEFAULTS = Object.freeze({
  APP_ENV: 'local',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_runner_placeholder_not_a_key',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3000',
  LOCAL_USE_PRODUCTION_DATABASE: 'false',
  PRODUCTION_SUPABASE_PROJECT_REF: '',
});

export class TestIsolationError extends Error {
  name = 'TestIsolationError';
}

/**
 * Throws when the environment points a test runner at anything but loopback:
 * a non-loopback URL in any TEST_URL_VARIABLES entry, APP_ENV other than
 * local, or LOCAL_USE_PRODUCTION_DATABASE=true. Unset values are fine.
 */
export function assertLoopbackTestEnv(env) {
  for (const name of TEST_URL_VARIABLES) {
    const value = env[name]?.trim();
    const ok = DATABASE_URL_VARIABLES.has(name) ? isLoopbackDatabaseUrl(value) : isLoopbackUrl(value);
    if (value && !ok) {
      throw new TestIsolationError(
        `refusing to run tests: ${name} does not point at a loopback address. Tests only use the local or CI stack, never a hosted project.`,
      );
    }
  }
  const appEnv = env.APP_ENV?.trim();
  if (appEnv && appEnv !== 'local') {
    throw new TestIsolationError(`refusing to run tests: APP_ENV=${appEnv}. Test runners only use APP_ENV=local.`);
  }
  if (env.LOCAL_USE_PRODUCTION_DATABASE?.trim() === 'true') {
    throw new TestIsolationError('refusing to run tests: LOCAL_USE_PRODUCTION_DATABASE=true would use the production database.');
  }
}

/**
 * The explicit environment for a test runner: loopback defaults, overridden
 * only by validated loopback values from the calling shell (CI exports the
 * disposable stack's URL and keys). Throws on any hosted value.
 */
export function loopbackTestEnv(env = process.env) {
  assertLoopbackTestEnv(env);
  const out = { ...LOOPBACK_DEFAULTS };
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SITE_URL']) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Environment for a Next.js server started by Playwright. `overrides` are the
 * config's own fixed values (they win over the shell). The service-role key
 * comes only from the shell (the CI stack), never from .env.local. Every value
 * is checked again after merging, and .env file loading is switched off.
 */
export function nextServerTestEnv(overrides, env = process.env) {
  const merged = { ...loopbackTestEnv(env), ...overrides };
  merged.SUPABASE_SECRET_KEY = overrides.SUPABASE_SECRET_KEY ?? env.SUPABASE_SECRET_KEY?.trim() ?? '';
  merged.__NEXT_PROCESSED_ENV = 'true';
  assertLoopbackTestEnv(merged);
  return merged;
}
