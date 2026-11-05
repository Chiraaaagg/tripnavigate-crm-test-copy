import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BootstrapGuardError,
  decideBootstrap,
  parseBootstrapArgs,
  projectRefFromUrl,
  redact,
  validateBootstrap,
} from '../../scripts/lib/bootstrap-guards.mjs';

const root = join(import.meta.dirname, '..', '..');

const localEnv = {
  APP_ENV: 'local',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'sb_secret_local_placeholder_value',
  BOOTSTRAP_OPERATOR: 'ci-operator',
  SITE_URL: 'http://127.0.0.1:3000',
};
const localArgs = {
  email: 'First.Admin@example.test',
  displayName: 'Synthetic First Admin',
  branchCode: 'jdh',
  confirmProjectRef: 'local',
};
const prodRef = 'abcdefghijklmnopqrst';
const prodEnv = {
  APP_ENV: 'production',
  SUPABASE_URL: `https://${prodRef}.supabase.co`,
  SUPABASE_SECRET_KEY: 'sb_secret_prod_placeholder_value',
  BOOTSTRAP_OPERATOR: 'owner ticket OPS-1',
  SITE_URL: 'https://crm.company.example.com',
};
const prodArgs = { ...localArgs, email: 'admin@company.example.com', confirmProjectRef: prodRef };

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapGuardError);
    return (error as BootstrapGuardError).errors;
  }
  throw new Error('expected a BootstrapGuardError');
}

describe('bootstrap-first-admin guards (T13)', () => {
  it('parses both --flag value and --flag=value, rejecting unknown flags', () => {
    expect(
      parseBootstrapArgs(['--email', 'a@example.test', '--display-name=Ada Admin', '--branch-code', 'JDH', '--confirm-project-ref=local']),
    ).toEqual({ email: 'a@example.test', displayName: 'Ada Admin', branchCode: 'JDH', confirmProjectRef: 'local' });
    expect(errorsOf(() => parseBootstrapArgs(['--password', 'x']))[0]).toMatch(/unknown argument/);
    expect(errorsOf(() => parseBootstrapArgs(['--email']))[0]).toMatch(/needs a value/);
    expect(errorsOf(() => parseBootstrapArgs(['--email', '--branch-code', 'JDH']))[0]).toMatch(/needs a value/);
  });

  it('accepts a valid local plan and normalises inputs', () => {
    const plan = validateBootstrap(localArgs, localEnv);
    expect(plan).toMatchObject({
      appEnv: 'local',
      projectRef: 'local',
      email: 'first.admin@example.test',
      branchCode: 'JDH',
      operator: 'ci-operator',
      redirectTo: 'http://127.0.0.1:3000/auth/confirm',
    });
  });

  it('accepts a valid production plan with the matching project ref', () => {
    expect(validateBootstrap(prodArgs, prodEnv).projectRef).toBe(prodRef);
  });

  it('refuses when APP_ENV is missing or unknown', () => {
    expect(errorsOf(() => validateBootstrap(localArgs, { ...localEnv, APP_ENV: undefined }))).toContainEqual(
      expect.stringMatching(/APP_ENV is required/),
    );
    expect(errorsOf(() => validateBootstrap(localArgs, { ...localEnv, APP_ENV: 'prod' }))).toContainEqual(
      expect.stringMatching(/APP_ENV must be/),
    );
  });

  it('refuses a missing or mismatched project ref confirmation', () => {
    expect(errorsOf(() => validateBootstrap({ ...prodArgs, confirmProjectRef: undefined }, prodEnv))).toContainEqual(
      expect.stringMatching(/--confirm-project-ref is required/),
    );
    expect(errorsOf(() => validateBootstrap({ ...prodArgs, confirmProjectRef: 'zzzzzzzzzzzzzzzzzzzz' }, prodEnv))).toContainEqual(
      expect.stringMatching(/does not match/),
    );
    expect(errorsOf(() => validateBootstrap({ ...prodArgs, confirmProjectRef: 'local' }, prodEnv))).toContainEqual(
      expect.stringMatching(/does not match/),
    );
  });

  it('refuses reserved .test domains outside a local stack or CI', () => {
    const stagingEnv = { ...prodEnv, APP_ENV: 'staging' };
    const testEmail = { ...prodArgs, email: 'admin@example.test' };
    expect(errorsOf(() => validateBootstrap(testEmail, stagingEnv))).toContainEqual(
      expect.stringMatching(/reserved test email/),
    );
    expect(validateBootstrap(testEmail, { ...stagingEnv, CI: 'true' }).email).toBe('admin@example.test');
    // Never in production, CI or not.
    expect(errorsOf(() => validateBootstrap(testEmail, { ...prodEnv, CI: 'true' }))).toContainEqual(
      expect.stringMatching(/reserved test email/),
    );
  });

  it('requires the operator, the secret key and a site URL; https in production', () => {
    const errors = errorsOf(() =>
      validateBootstrap(prodArgs, { ...prodEnv, BOOTSTRAP_OPERATOR: ' ', SUPABASE_SECRET_KEY: '', SITE_URL: 'http://crm.company.example.com' }),
    );
    expect(errors).toContainEqual(expect.stringMatching(/BOOTSTRAP_OPERATOR is required/));
    expect(errors).toContainEqual(expect.stringMatching(/SUPABASE_SECRET_KEY is required/));
    expect(errors).toContainEqual(expect.stringMatching(/https SITE_URL/));
  });

  it('keeps APP_ENV and the target stack consistent', () => {
    expect(errorsOf(() => validateBootstrap(prodArgs, { ...localEnv, SUPABASE_URL: prodEnv.SUPABASE_URL }))).toContainEqual(
      expect.stringMatching(/APP_ENV=local must target the local stack/),
    );
    expect(errorsOf(() => validateBootstrap(localArgs, { ...localEnv, APP_ENV: 'production', SITE_URL: 'https://x.example.com' }))).toContainEqual(
      expect.stringMatching(/cannot target a local stack/),
    );
    expect(
      errorsOf(() =>
        validateBootstrap(prodArgs, { ...prodEnv, APP_ENV: 'staging', PRODUCTION_SUPABASE_PROJECT_REF: prodRef }),
      ),
    ).toContainEqual(expect.stringMatching(/production project/));
  });

  it('validates email, display name and branch code', () => {
    const errors = errorsOf(() =>
      validateBootstrap({ ...localArgs, email: 'nope', displayName: 'x', branchCode: 'J-1' }, localEnv),
    );
    expect(errors).toHaveLength(3);
  });

  it('never echoes the secret key in errors', () => {
    const errors = errorsOf(() => validateBootstrap({}, { ...localEnv, APP_ENV: undefined }));
    expect(errors.join('\n')).not.toContain(localEnv.SUPABASE_SECRET_KEY);
    expect(redact(`bad key ${localEnv.SUPABASE_SECRET_KEY}!`, [localEnv.SUPABASE_SECRET_KEY])).toBe('bad key [redacted]!');
  });

  it('derives the project ref only from local or supabase.co URLs', () => {
    expect(projectRefFromUrl('http://localhost:54321')).toBe('local');
    expect(projectRefFromUrl(`https://${prodRef}.supabase.co`)).toBe(prodRef);
    expect(projectRefFromUrl(`http://${prodRef}.supabase.co`)).toBeNull();
    expect(projectRefFromUrl('https://evil.example.com')).toBeNull();
    expect(projectRefFromUrl('not a url')).toBeNull();
  });

  it('is repeat-safe and refuses a second administrator', () => {
    expect(decideBootstrap([], 'a@example.test')).toBe('create');
    expect(decideBootstrap(['A@Example.test'], 'a@example.test')).toBe('already_admin');
    expect(decideBootstrap(['other@example.test'], 'a@example.test')).toBe('refuse');
  });

  it('the script calls bootstrap_first_admin with the operator and never prints the key', () => {
    const script = readFileSync(join(root, 'scripts', 'bootstrap-first-admin.mjs'), 'utf8');
    expect(script).toContain("rpc('bootstrap_first_admin'");
    expect(script).toContain('p_operator: plan.operator');
    expect(script).toContain('inviteUserByEmail(plan.email, { redirectTo: plan.redirectTo })');
    expect(script).not.toMatch(/console\.(log|error)\([^)]*SUPABASE_SECRET_KEY/);
  });
});

describe('local seed script guards', () => {
  const seed = readFileSync(join(root, 'scripts', 'seed-local.mjs'), 'utf8');
  it('refuses production and non-local targets', () => {
    expect(seed).toMatch(/APP_ENV === 'production'/);
    expect(seed).toContain('seedTargetRefusal(url, databaseUrl)');
    expect(seed.indexOf('if (targetRefusal) fail(targetRefusal)')).toBeLessThan(seed.indexOf('new pg.Client'));
  });
});
