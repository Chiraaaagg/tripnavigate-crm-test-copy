import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { seedEnvironmentRefusal, seedTargetRefusal } from '../../scripts/lib/seed-guard.mjs';

// Synthetic fixtures add fixture Auth users (one a Super Admin with a shared
// password) and relabel the database 'test'. Only a fresh ('unset' or no
// setting yet) or already-synthetic ('test') database may be seeded.
describe('seed-local environment guard', () => {
  it.each([[[]], [['unset']], [['test']]])('allows %j', (envs) => {
    expect(seedEnvironmentRefusal(envs)).toBeNull();
  });

  it.each(['operational', 'staging'])('refuses a database labelled %s', (env) => {
    expect(seedEnvironmentRefusal([env])).toMatch(new RegExp(`refusing to seed: .*${env}`));
  });

  it('refuses an unknown label', () => {
    expect(seedEnvironmentRefusal(['something-new'])).toMatch(/refusing to seed/);
  });
});


const API = 'http://127.0.0.1:54321';
const DB = 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres';

describe('seed effective-target guard', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows plain loopback %s', (host) => {
    expect(seedTargetRefusal(`http://${host}:54321`, `postgres://postgres:synthetic@${host}:54322/postgres`)).toBeNull();
  });
  it('allows the local sslmode=disable option', () => {
    expect(seedTargetRefusal(API, `${DB}?sslmode=disable`)).toBeNull();
  });
  it.each([
    '?host=remote.example.test', '?host=127.0.0.1', '?host=', '?host=%2Ftmp',
    '?hostaddr=remote.example.test', '?%68ost=remote.example.test',
    '?host=remote.example.test&host=127.0.0.1', '?host=127.0.0.1&host=remote.example.test',
    '?port=6543', '?port=', '?connectionString=postgres://remote.example.test/db',
    '?service=remote', '?sslcert=/not-readable', '?sslkey=/not-readable', '?sslrootcert=/not-readable',
    '?sslmode=disable&sslmode=disable', '?sslmode=require', '?host=127.0.0.1,remote.example.test',
  ])('refuses overrides before connection: %s', (suffix) => {
    expect(seedTargetRefusal(API, DB + suffix)).toMatch(/refusing to seed/);
  });
  it.each([
    'postgres://postgres@remote.example.test/db', 'postgres://postgres@127.0.0.1,localhost/db',
    'postgres://postgres@%2Ftmp/db', 'socket:/tmp?db=postgres', '/tmp postgres',
    'postgres:///postgres', 'https://127.0.0.1/db', 'not-a-url',
  ])('refuses unsafe database URL %s', (value) => {
    expect(seedTargetRefusal(API, value)).toMatch(/refusing to seed/);
  });
  it.each(['ftp://127.0.0.1', 'http://remote.example.test', 'not-a-url', 'http://127.0.0.1?host=remote', 'http://user:secret@localhost'])('refuses unsafe API URL %s', (value) => {
    expect(seedTargetRefusal(value, DB)).toMatch(/refusing to seed/);
  });
  it('the seed entry point refuses an effective-host override before connecting or requiring credentials', () => {
    try {
      execFileSync(process.execPath, ['scripts/seed-local.mjs'], {
        cwd: new URL('../..', import.meta.url),
        env: { PATH: process.env.PATH, NODE_ENV: 'test', APP_ENV: 'local', SUPABASE_URL: API, DATABASE_URL: DB + '?host=remote.example.test' },
        stdio: 'pipe', timeout: 5000,
      });
      expect.fail('unsafe seed was accepted');
    } catch (error) {
      const result = error as { status?: number; stderr?: Buffer };
      expect(result.status).toBe(1);
      expect(result.stderr?.toString()).toContain('refusing to seed: use plain loopback');
      expect(result.stderr?.toString()).not.toContain('synthetic@');
    }
  });
});
