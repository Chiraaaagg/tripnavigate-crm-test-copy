import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  INTEGRATION_ENV_NAMES,
  intakeRuntimeRefusal,
  isInviteRecipientAllowed,
  isRealStackRequired,
  isUiPreviewEnabled,
  parseAppConfig,
  parseIntegrationEnv,
} from '@/lib/config';

const base = {
  APP_ENV: 'staging',
  NEXT_PUBLIC_SUPABASE_URL: 'https://stagingrefabcdefghij.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
  NEXT_PUBLIC_SITE_URL: 'https://crm-staging.example.test',
  PRODUCTION_SUPABASE_PROJECT_REF: 'prodrefabcdefghijklm',
};

describe('environment isolation', () => {
  it('accepts isolated local configuration and defaults invites to example.test', () => {
    const config = parseAppConfig({ ...base, APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(config.appEnv).toBe('local');
    expect(config.inviteAllowedDomains).toEqual(['example.test']);
    // The session lifetime is database policy (security_policy), not app config.
    expect(config).not.toHaveProperty('sessionMaxAgeHours');
  });

  it('rejects a preview deployment that is not APP_ENV=staging', () => {
    expect(() => parseAppConfig({ ...base, APP_ENV: 'production', VERCEL_ENV: 'preview' })).toThrow(ConfigError);
  });

  it('rejects a non-production deployment pointing at the production Supabase project', () => {
    expect(() =>
      parseAppConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co', VERCEL_ENV: 'preview' }),
    ).toThrow(/production Supabase project/);
  });

  it('rejects APP_ENV=production outside the Vercel production environment', () => {
    expect(() =>
      parseAppConfig({
        ...base,
        APP_ENV: 'production',
        VERCEL_ENV: 'development',
        STAFF_INVITE_ALLOWED_DOMAINS: 'company.example',
      }),
    ).toThrow(ConfigError);
  });

  it('requires local configuration to use the local Supabase stack, and vice versa', () => {
    expect(() => parseAppConfig({ ...base, APP_ENV: 'local' })).toThrow(/local Supabase/);
    expect(() => parseAppConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).toThrow(ConfigError);
    expect(
      parseAppConfig({ ...base, APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }).appEnv,
    ).toBe('local');
  });

  it('production must name a real staff domain and cannot use reserved test domains', () => {
    const prod = { ...base, APP_ENV: 'production', VERCEL_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co' };
    expect(() => parseAppConfig(prod)).toThrow(/STAFF_INVITE_ALLOWED_DOMAINS/);
    expect(() => parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'example.test' })).toThrow(/test domains/);
    // Owner decision: production invites exactly holidaychacha.com, nothing else.
    expect(() => parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'company.example' })).toThrow(/exactly holidaychacha\.com/);
    expect(() => parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com,company.example' })).toThrow(/exactly holidaychacha\.com/);
    expect(parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com' }).inviteAllowedDomains).toEqual(['holidaychacha.com']);
  });

  it('APP_ENV=production is refused outside Vercel Production (no VERCEL_ENV on a local machine or CI)', () => {
    const prod = { ...base, APP_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co', STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com' };
    expect(() => parseAppConfig(prod)).toThrow(/only allowed on the Vercel production environment/);
    expect(parseAppConfig({ ...prod, VERCEL_ENV: 'production' }).appEnv).toBe('production');
  });

  it('reports missing variables by name without echoing values', () => {
    try {
      parseAppConfig({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined });
      throw new Error('should have failed');
    } catch (error) {
      expect((error as Error).message).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
      expect((error as Error).message).not.toContain('sb_publishable');
    }
  });

  it('non-production invitations can only reach allow-listed test domains', () => {
    const config = parseAppConfig({ ...base, APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(isInviteRecipientAllowed(config, 'someone@example.test')).toBe(true);
    expect(isInviteRecipientAllowed(config, 'Someone@EXAMPLE.TEST')).toBe(true);
    expect(isInviteRecipientAllowed(config, 'real.customer@gmail.com')).toBe(false);
    expect(isInviteRecipientAllowed(config, 'not-an-email')).toBe(false);
  });

  it.each(['local', 'staging'] as const)('refuses real staff email outside production even when allowlisted in %s', (appEnv) => {
    const config = {
      appEnv,
      supabaseUrl: 'https://synthetic.example',
      supabasePublishableKey: 'synthetic-public-key',
      siteUrl: 'http://localhost:3000',
      inviteAllowedDomains: ['holidaychacha.com', 'example.test'],
      localProductionDatabase: false,
    };
    expect(isInviteRecipientAllowed(config, 'agent@holidaychacha.com')).toBe(false);
    expect(isInviteRecipientAllowed(config, 'agent@example.test')).toBe(true);
  });

  it('production accepts the approved staff domain holidaychacha.com, matched exactly after the @', () => {
    const prod = {
      ...base,
      APP_ENV: 'production',
      VERCEL_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co',
      STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com',
    };
    const config = parseAppConfig(prod);
    expect(config.inviteAllowedDomains).toEqual(['holidaychacha.com']);
    expect(isInviteRecipientAllowed(config, 'agent@holidaychacha.com')).toBe(true);
    expect(isInviteRecipientAllowed(config, '  Agent.Name@HolidayChacha.COM ')).toBe(true);
    for (const email of [
      'agent@mail.holidaychacha.com',
      'agent@holidaychacha.co',
      'agent@holiday-chacha.com',
      'agent@holidaychacha.com.evil.example',
      'agent@xholidaychacha.com',
      'agent@holidaychacha.com.',
      'agent@holidaychacha.com@evil.example',
      'agent@evil.example@holidaychacha.com',
      '@holidaychacha.com',
      'agent@',
      'agent@example.test',
      'agent@gmail.com',
    ]) {
      expect(isInviteRecipientAllowed(config, email), email).toBe(false);
    }
    // Uppercase config input is normalised; a subdomain entry is refused in production.
    expect(parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'HolidayChacha.com' }).inviteAllowedDomains).toEqual([
      'holidaychacha.com',
    ]);
    expect(() => parseAppConfig({ ...prod, STAFF_INVITE_ALLOWED_DOMAINS: 'mail.holidaychacha.com' })).toThrow(/exactly holidaychacha\.com/);
  });
});

describe('UI preview gallery guard', () => {
  const on = { ENABLE_UI_PREVIEW: 'true', APP_ENV: 'local', NODE_ENV: 'development' };
  it('is enabled only for local development with the explicit flag', () => {
    expect(isUiPreviewEnabled(on)).toBe(true);
  });
  it.each([
    { ...on, ENABLE_UI_PREVIEW: undefined },
    { ...on, APP_ENV: 'staging' },
    { ...on, APP_ENV: 'production' },
    { ...on, NODE_ENV: 'production' },
    { ...on, VERCEL_ENV: 'preview' },
  ])('is disabled for %o', (env) => {
    expect(isUiPreviewEnabled(env)).toBe(false);
  });
});

describe('real-stack requirement flag (T16)', () => {
  it.each(['1', 'true', 'TRUE', ' 1 '])('is required for REQUIRE_REAL_STACK=%j', (value) => {
    expect(isRealStackRequired({ REQUIRE_REAL_STACK: value })).toBe(true);
  });
  it.each([undefined, '', '0', 'false', 'yes'])('is optional for REQUIRE_REAL_STACK=%j', (value) => {
    expect(isRealStackRequired({ REQUIRE_REAL_STACK: value })).toBe(false);
  });
});

describe('production project guard (Phase 5: positive match, not only exclusion)', () => {
  const prod = {
    ...base,
    APP_ENV: 'production',
    VERCEL_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co',
    STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com',
  };
  it('accepts production pointing exactly at PRODUCTION_SUPABASE_PROJECT_REF', () => {
    expect(parseAppConfig(prod).appEnv).toBe('production');
  });
  it('requires PRODUCTION_SUPABASE_PROJECT_REF in production', () => {
    expect(() => parseAppConfig({ ...prod, PRODUCTION_SUPABASE_PROJECT_REF: undefined })).toThrow(/PRODUCTION_SUPABASE_PROJECT_REF/);
    expect(() => parseAppConfig({ ...prod, PRODUCTION_SUPABASE_PROJECT_REF: '' })).toThrow(/PRODUCTION_SUPABASE_PROJECT_REF/);
  });
  it('refuses production pointing at another hosted project or a look-alike host', () => {
    for (const url of [
      'https://stagingrefabcdefghij.supabase.co',
      'https://prodrefabcdefghijklm.supabase.co.attacker.example',
      'https://prodrefabcdefghijklm.example.com',
    ]) {
      expect(() => parseAppConfig({ ...prod, NEXT_PUBLIC_SUPABASE_URL: url })).toThrow(/production Supabase project/);
    }
  });
  it('still refuses any non-production build pointing at the production project', () => {
    expect(() =>
      parseAppConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co' }),
    ).toThrow(/production Supabase project/);
  });
  it('a Preview is a PR build labelled staging and can never claim production', () => {
    expect(() => parseAppConfig({ ...prod, VERCEL_ENV: 'preview' })).toThrow(ConfigError);
    expect(() => parseAppConfig({ ...base, VERCEL_ENV: 'preview' })).toThrow(/Preview builds cannot connect/);
  });
});

describe('intake runtime placement (Phase 5)', () => {
  const secrets = { intakeWorkerSecret: 'w'.repeat(40), cronSecret: 'c'.repeat(40) };
  it('runs only locally or on Vercel Production', () => {
    expect(intakeRuntimeRefusal('local', undefined, secrets)).toBeNull();
    expect(intakeRuntimeRefusal('production', 'production', secrets)).toBeNull();
  });
  it.each([
    ['staging', 'preview', 'preview_build'],
    ['production', 'preview', 'preview_build'],
    ['staging', undefined, 'wrong_environment'],
    ['staging', 'production', 'wrong_environment'],
    ['production', undefined, 'wrong_environment'],
    ['production', 'development', 'wrong_environment'],
    ['local', 'production', 'wrong_environment'],
    [undefined, undefined, 'wrong_environment'],
  ])('APP_ENV=%s VERCEL_ENV=%s -> %s', (appEnv, vercelEnv, code) => {
    expect(intakeRuntimeRefusal(appEnv, vercelEnv, secrets)).toBe(code);
  });
  it('the cron and manual triggers must use different secrets', () => {
    expect(intakeRuntimeRefusal('production', 'production', { intakeWorkerSecret: 'x'.repeat(40), cronSecret: 'x'.repeat(40) })).toBe(
      'shared_trigger_secret',
    );
    expect(intakeRuntimeRefusal('production', 'production', { intakeWorkerSecret: null, cronSecret: 'x'.repeat(40) })).toBeNull();
  });
  it('parseIntegrationEnv reads CRON_SECRET and reports presence only', () => {
    expect(INTEGRATION_ENV_NAMES).toContain('CRON_SECRET');
    expect(parseIntegrationEnv({ CRON_SECRET: '  synthetic-cron  ' })).toEqual({
      bitrixWebhookBaseUrl: null,
      bitrixEventApplicationToken: null,
      intakeWorkerSecret: null,
      cronSecret: 'synthetic-cron',
    });
  });
});

describe('Vercel Production cannot use a non-production app mode', () => {
  it.each(['staging', 'local'])('refuses APP_ENV=%s before serving staff', (appEnv) => {
    expect(() => parseAppConfig({ ...base, APP_ENV: appEnv, VERCEL_ENV: 'production' })).toThrow(
      'Vercel Production requires APP_ENV=production.',
    );
  });
});


describe('owner-approved local production build', () => {
  const localLive = { ...base, APP_ENV: 'local', NODE_ENV: 'production', LOCAL_USE_PRODUCTION_DATABASE: 'true', NEXT_PUBLIC_SITE_URL: 'http://localhost:3000', NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co', STAFF_INVITE_ALLOWED_DOMAINS: 'holidaychacha.com' };
  it('accepts the exact approved database only through an explicit local production opt-in', () => {
    expect(parseAppConfig(localLive).appEnv).toBe('local');
    expect(parseAppConfig(localLive).localProductionDatabase).toBe(true);
    expect(() => parseAppConfig({ ...localLive, LOCAL_USE_PRODUCTION_DATABASE: undefined })).toThrow(ConfigError);
  });
  it.each([
    { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { VERCEL_ENV: 'preview' },
    { APP_ENV: 'staging' }, { NEXT_PUBLIC_SITE_URL: 'https://remote.example.test' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://anotherproject.supabase.co' },
    { PRODUCTION_SUPABASE_PROJECT_REF: undefined }, { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
    { NEXT_PUBLIC_SUPABASE_URL: 'http://prodrefabcdefghijklm.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co:8443' },
  ])('rejects unsafe local live configuration %j', (change) => {
    expect(() => parseAppConfig({ ...localLive, ...change })).toThrow(ConfigError);
  });
  it('keeps real email invitations disabled on the local production build', () => {
    expect(isInviteRecipientAllowed(parseAppConfig(localLive), 'staff@holidaychacha.com')).toBe(false);
    expect(isUiPreviewEnabled({ ...localLive, NODE_ENV: 'development', ENABLE_UI_PREVIEW: 'true' })).toBe(false);
  });
});


it('forwards the local production opt-in through the real configuration wrapper', async () => {
  const env = { ...base, APP_ENV: 'local', NODE_ENV: 'production', LOCAL_USE_PRODUCTION_DATABASE: 'true', NEXT_PUBLIC_SITE_URL: 'http://localhost:3000', NEXT_PUBLIC_SUPABASE_URL: 'https://prodrefabcdefghijklm.supabase.co', CI: undefined, GITHUB_ACTIONS: undefined, VERCEL_ENV: undefined };
  try {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    const { getAppConfig } = await import('@/lib/config');
    expect(getAppConfig().appEnv).toBe('local');
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});

it('refuses hosted Preview access even without a production reference', () => {
  expect(() => parseAppConfig({ ...base, VERCEL_ENV: 'preview', PRODUCTION_SUPABASE_PROJECT_REF: undefined })).toThrow(/Preview builds cannot connect/);
});

it.each([
  {}, { VERCEL_ENV: 'development' }, { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
])('refuses hosted staging access even without a production reference: %j', (change) => {
  expect(() => parseAppConfig({ ...base, PRODUCTION_SUPABASE_PROJECT_REF: undefined, ...change })).toThrow(/Hosted Supabase requires/);
});
