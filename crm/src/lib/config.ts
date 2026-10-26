import { z } from 'zod';

/**
 * Environment configuration and isolation rules.
 *
 * Pure (no `server-only`) so it can run in the proxy and in unit tests. The
 * privileged secret key is NOT part of this config; it is read only by
 * src/lib/supabase/admin.ts.
 *
 * The absolute session lifetime is NOT configured here: the single value lives
 * in public.security_policy and the database enforces it (contract S5).
 */

/**
 * Environment model (Phase 5, docs/implementation/phase-5/README.md): two
 * operating surfaces only: the local production build and Vercel Production,
 * using the same approved hosted database. Local development and isolated
 * tests use a disposable loopback stack instead. The legacy `staging` label
 * never permits access to a hosted database or intake secrets.
 */
export const APP_ENVS = ['local', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const domainList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'invalid domain')));

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  NEXT_PUBLIC_SITE_URL: z.url(),
  PRODUCTION_SUPABASE_PROJECT_REF: z
    .string()
    .regex(/^[a-z0-9]{20}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  STAFF_INVITE_ALLOWED_DOMAINS: domainList,
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  LOCAL_USE_PRODUCTION_DATABASE: z.enum(['true', 'false']).optional(),
  NODE_ENV: z.string().optional(),
  CI: z.string().optional(),
  GITHUB_ACTIONS: z.string().optional(),
});

export interface AppConfig {
  appEnv: AppEnv;
  supabaseUrl: string;
  supabasePublishableKey: string;
  siteUrl: string;
  inviteAllowedDomains: string[];
  /** True only for a validated local production build aimed at the exact approved hosted project. */
  localProductionDatabase: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The only staff email domain production may invite (owner decision, 4 October 2026). */
export const PRODUCTION_STAFF_DOMAIN = 'holidaychacha.com';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

export function parseAppConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid or missing environment variables: ${fields}`);
  }
  const e = parsed.data;
  const supabaseUrl = new URL(e.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseHost = supabaseUrl.hostname;
  const supabaseIsLocal = LOCAL_HOSTS.has(supabaseHost);
  if (!supabaseIsLocal && (supabaseUrl.protocol !== 'https:' ||
    supabaseUrl.port !== '' || supabaseUrl.username || supabaseUrl.password ||
    supabaseUrl.search || supabaseUrl.hash || supabaseUrl.pathname !== '/')) {
    throw new ConfigError('Hosted Supabase requires a clean HTTPS URL with the default port.');
  }
  // The owner operates one hosted database from Vercel and a local production
  // build. This explicit opt-in never applies to development, CI or previews.
  const localProductionDatabase = e.LOCAL_USE_PRODUCTION_DATABASE === 'true';
  if (localProductionDatabase && (
    e.APP_ENV !== 'local' || e.VERCEL_ENV !== undefined || e.NODE_ENV !== 'production' ||
    Boolean(e.CI && e.CI !== 'false' && e.CI !== '0') || e.GITHUB_ACTIONS === 'true' ||
    !e.PRODUCTION_SUPABASE_PROJECT_REF ||
    supabaseHost !== `${e.PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co` ||
    !LOCAL_HOSTS.has(new URL(e.NEXT_PUBLIC_SITE_URL).hostname)
  )) {
    throw new ConfigError('Local production database access requires a local production build, localhost site and exact approved project.');
  }

  // A Vercel Preview is a PR build: it is labelled staging and is never production.
  if (e.VERCEL_ENV === 'preview' && e.APP_ENV !== 'staging') {
    throw new ConfigError('Preview builds must set APP_ENV=staging (a Preview is never production).');
  }
  if (e.VERCEL_ENV === 'production' && e.APP_ENV !== 'production') {
    throw new ConfigError('Vercel Production requires APP_ENV=production.');
  }
  // Production configuration runs only on Vercel Production: a local machine or
  // CI with APP_ENV=production could otherwise invite real staff (review L2).
  if (e.APP_ENV === 'production' && e.VERCEL_ENV !== 'production') {
    throw new ConfigError('APP_ENV=production is only allowed on the Vercel production environment.');
  }
  // A non-production build must never point at the production database.
  if (
    e.APP_ENV !== 'production' && !localProductionDatabase &&
    e.PRODUCTION_SUPABASE_PROJECT_REF &&
    supabaseHost.startsWith(`${e.PRODUCTION_SUPABASE_PROJECT_REF}.`)
  ) {
    throw new ConfigError('Non-production configuration points at the production Supabase project.');
  }
  // Production must name its project and point exactly at it (positive match),
  // so a production build cannot silently run against another hosted project.
  if (e.APP_ENV === 'production') {
    if (!e.PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new ConfigError('Production requires PRODUCTION_SUPABASE_PROJECT_REF.');
    }
    if (supabaseHost !== `${e.PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`) {
      throw new ConfigError('Production configuration does not point at the production Supabase project.');
    }
  }
  if (e.APP_ENV === 'local' && !supabaseIsLocal && !localProductionDatabase) {
    throw new ConfigError('APP_ENV=local must use the local Supabase stack.');
  }
  if (e.VERCEL_ENV === 'preview' && !supabaseIsLocal) {
    throw new ConfigError('Preview builds cannot connect to a hosted Supabase database.');
  }
  if (!supabaseIsLocal && !localProductionDatabase && !(e.APP_ENV === 'production' && e.VERCEL_ENV === 'production')) {
    throw new ConfigError('Hosted Supabase requires Vercel Production or the approved local production opt-in.');
  }
  if (e.APP_ENV !== 'local' && supabaseIsLocal) {
    throw new ConfigError(`APP_ENV=${e.APP_ENV} cannot use a local Supabase URL.`);
  }

  const domains = e.STAFF_INVITE_ALLOWED_DOMAINS;
  if (e.APP_ENV === 'production') {
    if (domains.length === 0) {
      throw new ConfigError('Production requires STAFF_INVITE_ALLOWED_DOMAINS (the company staff domain).');
    }
    if (domains.some((d) => d === 'example.test' || d.endsWith('.test'))) {
      throw new ConfigError('Production cannot invite reserved test domains.');
    }
    // Owner decision (4 October 2026): production invites exactly the company domain (review L3).
    if (domains.length !== 1 || domains[0] !== PRODUCTION_STAFF_DOMAIN) {
      throw new ConfigError(`Production STAFF_INVITE_ALLOWED_DOMAINS must be exactly ${PRODUCTION_STAFF_DOMAIN}.`);
    }
  }

  return {
    appEnv: e.APP_ENV,
    supabaseUrl: e.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    siteUrl: e.NEXT_PUBLIC_SITE_URL.replace(/\/$/, ''),
    // Non-production defaults to the reserved, undeliverable example.test domain.
    inviteAllowedDomains: domains.length > 0 ? domains : ['example.test'],
    localProductionDatabase,
  };
}

/**
 * Staff invitations are the only email this batch can trigger (sent by Supabase
 * Auth). Outside production they may only go to allow-listed test domains, so a
 * preview or staging deployment cannot email a real person by mistake.
 */
export function isInviteRecipientAllowed(config: AppConfig, email: string): boolean {
  // Exactly one '@' with a non-empty local part; the whole remainder must equal an
  // allow-listed domain (case-insensitive). Subdomains, look-alikes and suffix
  // tricks such as "user@company.example@other.example" are refused.
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length === 0) return false;
  // Non-production email is restricted to reserved test domains even when an
  // operator copies the production allowlist into a local or Preview config.
  if (config.appEnv !== 'production' && !domain.endsWith('.test')) return false;
  return config.inviteAllowedDomains.includes(domain);
}

/** Component preview gallery used for review screenshots. Local development only. */
export function isUiPreviewEnabled(env: Record<string, string | undefined>): boolean {
  return (
    env.ENABLE_UI_PREVIEW === 'true' &&
    env.LOCAL_USE_PRODUCTION_DATABASE !== 'true' &&
    env.APP_ENV === 'local' &&
    env.NODE_ENV === 'development' &&
    env.VERCEL_ENV === undefined
  );
}

/**
 * True when real-stack verification is mandatory (CI jobs set
 * REQUIRE_REAL_STACK=1). Test harnesses must then FAIL on missing
 * configuration instead of skipping (contract T16).
 */
export function isRealStackRequired(env: Record<string, string | undefined>): boolean {
  const value = env.REQUIRE_REAL_STACK?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Bitrix intake secrets on the Next app (SERVER ONLY, never NEXT_PUBLIC_). This
 * parser only trims and reports presence; the Bitrix module validates the URL
 * shape and host (src/modules/integration/bitrix/config.ts). Callers must never
 * log, return or render these values.
 *
 * Production placement (docs/implementation/phase-5/intake-plan.md):
 *   Vercel Production: BITRIX_WEBHOOK_BASE_URL, CRON_SECRET (Vercel Cron GET),
 *     INTAKE_WORKER_SECRET (manual / pg_net POST; optional), SUPABASE_SECRET_KEY.
 *   Supabase Edge Function secrets: BITRIX_EVENT_APPLICATION_TOKEN,
 *     INTAKE_RECEIVER_CREDENTIAL. The application token is NOT needed on Vercel:
 *     the Vercel events route answers 404 outside APP_ENV=local.
 *   Vercel Preview: none of these.
 */
export interface IntegrationEnv {
  /** Bitrix inbound webhook REST base URL (contains a credential). */
  bitrixWebhookBaseUrl: string | null;
  /** Outbound webhook `auth[application_token]`; on the Next app used only by the LOCAL events route. */
  bitrixEventApplicationToken: string | null;
  /** Bearer secret for POST /api/integrations/bitrix/worker (manual run or pg_net). */
  intakeWorkerSecret: string | null;
  /** Vercel Cron bearer (`Authorization: Bearer $CRON_SECRET`) for GET /api/integrations/bitrix/worker. */
  cronSecret: string | null;
}

export const INTEGRATION_ENV_NAMES = [
  'BITRIX_WEBHOOK_BASE_URL',
  'BITRIX_EVENT_APPLICATION_TOKEN',
  'INTAKE_WORKER_SECRET',
  'CRON_SECRET',
] as const;

export function parseIntegrationEnv(env: Record<string, string | undefined>): IntegrationEnv {
  const read = (name: (typeof INTEGRATION_ENV_NAMES)[number]) => {
    const value = env[name]?.trim();
    return value ? value : null;
  };
  return {
    bitrixWebhookBaseUrl: read('BITRIX_WEBHOOK_BASE_URL'),
    bitrixEventApplicationToken: read('BITRIX_EVENT_APPLICATION_TOKEN'),
    intakeWorkerSecret: read('INTAKE_WORKER_SECRET'),
    cronSecret: read('CRON_SECRET'),
  };
}

/** Minimum length for INTAKE_WORKER_SECRET and CRON_SECRET; shorter counts as not configured. */
export const MIN_INTAKE_SECRET_LENGTH = 32;

export type IntakeRuntimeRefusal =
  | 'preview_build'
  | 'wrong_environment'
  | 'shared_trigger_secret';

/**
 * Where the intake WORKER may run (fail closed; the staff app is unaffected):
 *   - APP_ENV=local (local stack, loopback mock Bitrix in tests), or
 *   - APP_ENV=production on VERCEL_ENV=production.
 * A Vercel Preview (APP_ENV=staging) never runs intake, even if secrets were
 * left in its environment. CRON_SECRET and INTAKE_WORKER_SECRET must differ so
 * each trigger can be rotated or revoked on its own. Returns a fixed code only.
 */
export function intakeRuntimeRefusal(
  appEnv: string | undefined,
  vercelEnv: string | undefined,
  env: Pick<IntegrationEnv, 'intakeWorkerSecret' | 'cronSecret'>,
): IntakeRuntimeRefusal | null {
  if (vercelEnv === 'preview') return 'preview_build';
  if (appEnv === 'local') {
    if (vercelEnv !== undefined) return 'wrong_environment';
  } else if (appEnv === 'production') {
    if (vercelEnv !== 'production') return 'wrong_environment';
  } else {
    return 'wrong_environment';
  }
  if (env.intakeWorkerSecret && env.cronSecret && env.intakeWorkerSecret === env.cronSecret) {
    return 'shared_trigger_secret';
  }
  return null;
}

let cached: AppConfig | undefined;
export function getAppConfig(): AppConfig {
  cached ??= parseAppConfig({
    APP_ENV: process.env.APP_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    PRODUCTION_SUPABASE_PROJECT_REF: process.env.PRODUCTION_SUPABASE_PROJECT_REF,
    STAFF_INVITE_ALLOWED_DOMAINS: process.env.STAFF_INVITE_ALLOWED_DOMAINS,
    LOCAL_USE_PRODUCTION_DATABASE: process.env.LOCAL_USE_PRODUCTION_DATABASE,
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  return cached;
}
