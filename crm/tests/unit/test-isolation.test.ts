import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedEnvironmentRefusal } from '../../scripts/lib/seed-guard.mjs';
import { assertDatabaseUrlNotOperational, assertLoopbackDatabaseUrl, assertNotOperational } from '../helpers/db';
import { RealStackConfigError, resolveRealStackEnv } from '../helpers/real-stack';
import { TestIsolationError, assertLoopbackTestEnv, isLoopbackDatabaseUrl, isLoopbackUrl, loopbackTestEnv, nextServerTestEnv } from '../helpers/test-env.mjs';

/**
 * Phase 5B Milestone A section 6 (audit finding 10): test runners and the
 * seed loader never use hosted values.
 *   - Database label guards accept only 'unset' or 'test'.
 *   - Every URL guard refuses anything that is not a loopback address.
 *   - vitest and the Playwright configs set loopback configuration explicitly
 *     and never read crm/.env.local.
 */

const HOSTED_SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';
const HOSTED_DB = 'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
const LOOK_ALIKES = ['http://127.0.0.1.example.com:54321', 'http://localhost.example.test', 'http://10.0.0.5:54321', 'not a url'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('database label guards (seed loader and test harness)', () => {
  const rows = (environment: string) => async () => [{ environment }];

  it.each(['staging', 'operational', 'something-new', 'production', ''])('refuse a database labelled %j', async (label) => {
    expect(seedEnvironmentRefusal([label])).toMatch(/refusing to seed/);
    await expect(assertNotOperational(rows(label))).rejects.toThrow(/refusing to run tests/);
  });

  it.each(['unset', 'test'])('allow %s', async (label) => {
    expect(seedEnvironmentRefusal([label])).toBeNull();
    await expect(assertNotOperational(rows(label))).resolves.toBeUndefined();
  });
});

describe('URL guards refuse anything that is not loopback', () => {
  it('recognises loopback hosts only', () => {
    for (const ok of ['http://127.0.0.1:54321', 'http://localhost:3000', 'http://[::1]:54321', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres']) {
      expect(isLoopbackUrl(ok), ok).toBe(true);
    }
    for (const bad of [HOSTED_SUPABASE, HOSTED_DB, ...LOOK_ALIKES, '', undefined]) {
      expect(isLoopbackUrl(bad), String(bad)).toBe(false);
    }
  });

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SITE_URL', 'APP_BASE_URL', 'MAILPIT_URL'])(
    'the test-runner environment refuses a hosted %s',
    (name) => {
      expect(() => loopbackTestEnv({ [name]: HOSTED_SUPABASE })).toThrow(TestIsolationError);
      for (const bad of LOOK_ALIKES) expect(() => assertLoopbackTestEnv({ [name]: bad }), bad).toThrow(/loopback/);
    },
  );

  it.each(['TEST_DATABASE_URL', 'DATABASE_URL'])('the test-runner environment refuses a hosted %s', (name) => {
    expect(() => loopbackTestEnv({ [name]: HOSTED_DB })).toThrow(/does not point at a loopback address/);
  });

  it('refuses APP_ENV other than local and the production-database switch', () => {
    for (const appEnv of ['staging', 'production']) expect(() => loopbackTestEnv({ APP_ENV: appEnv })).toThrow(/APP_ENV/);
    expect(() => loopbackTestEnv({ LOCAL_USE_PRODUCTION_DATABASE: 'true' })).toThrow(/production database/);
  });

  // node-pg lets query parameters override the URL authority and accepts
  // unix sockets: the effective target, not URL.hostname, must be loopback.
  const DB_BYPASSES = [
    'postgresql://u:p@127.0.0.1:5432/postgres?host=db.abcdefghijklmnopqrst.supabase.co',
    'postgresql://u:p@localhost/postgres?host=10.0.0.5',
    'postgresql://u:p@127.0.0.1/postgres?hostaddr=203.0.113.7',
    'postgresql://u:p@127.0.0.1/postgres?host=127.0.0.1&host=db.example.com',
    'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/postgres',
    'postgresql:///postgres?host=/tmp',
    'socket:/var/run/postgresql?db=postgres',
    'http://127.0.0.1:54322/postgres',
  ];

  it('database URLs: the parsed host and hostaddr must be loopback; host overrides and sockets are refused', () => {
    for (const ok of [
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'postgres://postgres:postgres@localhost:54322/postgres',
      'postgresql://u:p@127.0.0.1:54322/postgres?host=127.0.0.1&hostaddr=127.0.0.1',
    ]) {
      expect(isLoopbackDatabaseUrl(ok), ok).toBe(true);
    }
    for (const bad of [...DB_BYPASSES, HOSTED_DB, '', undefined]) {
      expect(isLoopbackDatabaseUrl(bad), String(bad)).toBe(false);
    }
  });

  it.each(DB_BYPASSES)('every database guard refuses %s', async (url) => {
    expect(() => assertLoopbackTestEnv({ TEST_DATABASE_URL: url })).toThrow(TestIsolationError);
    expect(() => assertLoopbackTestEnv({ DATABASE_URL: url })).toThrow(TestIsolationError);
    expect(() => assertLoopbackDatabaseUrl(url)).toThrow(/loopback/);
    await expect(assertDatabaseUrlNotOperational(url)).rejects.toThrow(/loopback/);
  });

  it('the journey-only fixture refuses any database not labelled test before inserting', () => {
    const sql = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql'), 'utf8');
    const guard = sql.indexOf("<> 'test' then");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(sql.indexOf('insert into'));
  });

  it('the test database harness refuses a non-loopback database before connecting', async () => {
    expect(() => assertLoopbackDatabaseUrl(HOSTED_DB)).toThrow(/loopback/);
    await expect(assertDatabaseUrlNotOperational(HOSTED_DB)).rejects.toThrow(/loopback/);
    expect(() => assertLoopbackDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).not.toThrow();
  });

  it('the real-stack harness refuses a hosted Supabase URL even when everything else is set', () => {
    const env = {
      SUPABASE_URL: HOSTED_SUPABASE,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
      SUPABASE_SECRET_KEY: 'sb_secret_example_not_a_secret',
      LOCAL_FIXTURE_PASSWORD: 'synthetic-only-password',
      APP_BASE_URL: 'http://127.0.0.1:3000',
    };
    expect(() => resolveRealStackEnv(env)).toThrow(RealStackConfigError);
    expect(() => resolveRealStackEnv({ ...env, SUPABASE_URL: 'http://127.0.0.1:54321' })).not.toThrow();
  });
});

describe('test runners set loopback configuration explicitly', () => {
  it('fills loopback defaults and keeps validated loopback values from the shell', () => {
    expect(loopbackTestEnv({})).toMatchObject({
      APP_ENV: 'local',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3000',
      LOCAL_USE_PRODUCTION_DATABASE: 'false',
    });
    expect(loopbackTestEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }).NEXT_PUBLIC_SUPABASE_URL).toBe('http://localhost:54321');
  });

  it('Next servers started by Playwright never read .env files and get no key that the shell did not give', () => {
    const env = nextServerTestEnv({ NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3100' }, {});
    expect(env.__NEXT_PROCESSED_ENV).toBe('true');
    expect(env.SUPABASE_SECRET_KEY).toBe('');
    expect(isLoopbackUrl(env.NEXT_PUBLIC_SUPABASE_URL)).toBe(true);
    expect(() => nextServerTestEnv({ NEXT_PUBLIC_SUPABASE_URL: HOSTED_SUPABASE }, {})).toThrow(TestIsolationError);
  });

  it('every vitest project gets the loopback environment and reads no .env file', async () => {
    const config = (await import('../../vitest.config')).default as {
      envDir?: unknown;
      test?: { env?: Record<string, string>; projects?: Array<{ envDir?: unknown; test?: { name?: string; env?: Record<string, string> } }> };
    };
    expect(config.envDir).toBe(false);
    const projects = config.test?.projects ?? [];
    expect(projects.map((p) => p.test?.name).sort()).toEqual(['db', 'supabase', 'unit']);
    for (const project of projects) {
      expect(project.envDir, project.test?.name).toBe(false);
      expect(project.test?.env?.APP_ENV, project.test?.name).toBe('local');
      expect(isLoopbackUrl(project.test?.env?.NEXT_PUBLIC_SUPABASE_URL), project.test?.name).toBe(true);
    }
  });

  it('vitest refuses to start when the shell exports a hosted Supabase URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', HOSTED_SUPABASE);
    await expect(import('../../vitest.config')).rejects.toThrow(/loopback/);
  });

  type WebServer = { env?: Record<string, string> };
  const webServerEnv = async (path: string) => {
    const config = (await import(/* @vite-ignore */ path)).default as { webServer?: WebServer | WebServer[] };
    const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    return server?.env ?? {};
  };

  it.each(['../../playwright.config', '../../playwright.prod.config'])('%s: explicit loopback values, no .env files, no service-role key', async (path) => {
    const env = await webServerEnv(path);
    expect(env.__NEXT_PROCESSED_ENV).toBe('true');
    expect(env.SUPABASE_SECRET_KEY).toBe('');
    expect(env.APP_ENV).toBe('local');
    expect(isLoopbackUrl(env.NEXT_PUBLIC_SUPABASE_URL)).toBe(true);
    expect(isLoopbackUrl(env.NEXT_PUBLIC_SITE_URL)).toBe(true);
  });

  const realStackShell = {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
    SUPABASE_SECRET_KEY: 'sb_secret_example_not_a_secret',
    LOCAL_FIXTURE_PASSWORD: 'synthetic-only-password',
    TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  };

  it('playwright.real.config: the stack values come from the shell, validated, and .env files are not read', async () => {
    for (const [name, value] of Object.entries(realStackShell)) vi.stubEnv(name, value);
    const env = await webServerEnv('../../playwright.real.config');
    expect(env.__NEXT_PROCESSED_ENV).toBe('true');
    expect(env.SUPABASE_SECRET_KEY).toBe(realStackShell.SUPABASE_SECRET_KEY);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(env.NEXT_PUBLIC_SITE_URL).toBe('http://127.0.0.1:3100');
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', HOSTED_SUPABASE],
    ['TEST_DATABASE_URL', HOSTED_DB],
  ])('playwright.real.config refuses a hosted %s before any test runs', async (name, value) => {
    for (const [key, v] of Object.entries(realStackShell)) vi.stubEnv(key, v);
    vi.stubEnv(name, value);
    await expect(webServerEnv('../../playwright.real.config')).rejects.toThrow(/loopback/);
  });
});

describe('Next.js does not load .env.local when __NEXT_PROCESSED_ENV is set', () => {
  // Proves the switch used by every Playwright web server against the
  // installed @next/env, in child processes so this process env stays clean.
  const probe = (dir: string, flag: boolean) =>
    execFileSync(
      process.execPath,
      ['-e', `require('@next/env').loadEnvConfig(${JSON.stringify(dir)}, false, { info() {}, error() {} }); process.stdout.write(String(process.env.PROBE_HOSTED_URL ?? 'unset'));`],
      { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...(flag ? { __NEXT_PROCESSED_ENV: 'true' } : {}) }, cwd: process.cwd(), encoding: 'utf8' },
    );

  it('reads it without the switch (control) and ignores it with the switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn-env-'));
    try {
      writeFileSync(join(dir, '.env.local'), `PROBE_HOSTED_URL=${HOSTED_SUPABASE}\n`);
      expect(probe(dir, false)).toBe(HOSTED_SUPABASE);
      expect(probe(dir, true)).toBe('unset');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
