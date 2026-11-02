// Pure validation for scripts/bootstrap-first-admin.mjs (contract section 1,
// "First administrator"). No I/O here so every rule is unit-tested
// (tests/unit/bootstrap-guards.test.ts).

export const APP_ENVS = ['local', 'staging', 'production'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
// RFC 2606 / RFC 6761 reserved names: never a real person's mailbox.
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];

const ARG_NAMES = {
  '--email': 'email',
  '--display-name': 'displayName',
  '--branch-code': 'branchCode',
  '--confirm-project-ref': 'confirmProjectRef',
};

export class BootstrapGuardError extends Error {
  constructor(errors) {
    super(`refusing to bootstrap:\n  - ${errors.join('\n  - ')}`);
    this.name = 'BootstrapGuardError';
    this.errors = errors;
  }
}

/** Accepts `--name value` and `--name=value`. Unknown arguments are errors. */
export function parseBootstrapArgs(argv) {
  const out = {};
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const key = ARG_NAMES[flag];
    if (!key) {
      errors.push(`unknown argument ${JSON.stringify(flag)}`);
      continue;
    }
    let value;
    if (eq !== -1) value = raw.slice(eq + 1);
    else {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value.startsWith('--')) errors.push(`${flag} needs a value`);
    else out[key] = value;
  }
  if (errors.length > 0) throw new BootstrapGuardError(errors);
  return out;
}

/** 'local' for a local stack, the 20-char ref for https://<ref>.supabase.co, else null. */
export function projectRefFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) return 'local';
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(parsed.hostname);
  return match && parsed.protocol === 'https:' ? match[1] : null;
}

export function isReservedEmailDomain(email) {
  const domain = String(email).trim().toLowerCase().split('@')[1] ?? '';
  const tld = domain.split('.').pop();
  return RESERVED_TLDS.includes(tld);
}

/**
 * Validates arguments and environment. Returns the normalised plan or throws
 * BootstrapGuardError listing every problem. Never includes secret values in
 * messages.
 */
export function validateBootstrap(args, env) {
  const errors = [];
  const appEnv = env.APP_ENV?.trim();
  const isCi = env.CI === 'true' || env.GITHUB_ACTIONS === 'true';

  if (!appEnv) errors.push('APP_ENV is required (local, staging or production)');
  else if (!APP_ENVS.includes(appEnv)) errors.push('APP_ENV must be local, staging or production');

  const url = env.SUPABASE_URL?.trim();
  if (!url) errors.push('SUPABASE_URL is required');
  if (!env.SUPABASE_SECRET_KEY?.trim()) errors.push('SUPABASE_SECRET_KEY is required');

  const operator = env.BOOTSTRAP_OPERATOR?.trim() ?? '';
  if (operator.length < 2 || operator.length > 200) {
    errors.push('BOOTSTRAP_OPERATOR is required (who runs this bootstrap; 2-200 characters)');
  }

  const siteUrl = (env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '');
  let siteParsed = null;
  try {
    siteParsed = siteUrl ? new URL(siteUrl) : null;
  } catch {
    siteParsed = null;
  }
  if (!siteParsed) errors.push('SITE_URL (or NEXT_PUBLIC_SITE_URL) must be a valid URL for the invitation link');

  const email = args.email?.trim().toLowerCase() ?? '';
  if (!/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) errors.push('--email must be a valid email address');
  const displayName = args.displayName?.trim() ?? '';
  if (displayName.length < 2 || displayName.length > 120) errors.push('--display-name must be 2-120 characters');
  const branchCode = args.branchCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z0-9]{2,10}$/.test(branchCode)) errors.push('--branch-code must be a branch code such as JDH');

  const actualRef = url ? projectRefFromUrl(url) : null;
  if (url && !actualRef) errors.push('SUPABASE_URL must be a local stack or https://<project-ref>.supabase.co');
  const confirmRef = args.confirmProjectRef?.trim();
  if (!confirmRef) errors.push('--confirm-project-ref is required (the target project ref, or "local")');
  else if (actualRef && confirmRef !== actualRef) {
    errors.push('--confirm-project-ref does not match the project in SUPABASE_URL');
  }

  const isLocalStack = actualRef === 'local';
  if (appEnv === 'local' && actualRef && !isLocalStack) errors.push('APP_ENV=local must target the local stack');
  if (appEnv && appEnv !== 'local' && isLocalStack) errors.push(`APP_ENV=${appEnv} cannot target a local stack`);
  if (email && isReservedEmailDomain(email) && !(isLocalStack || (isCi && appEnv !== 'production'))) {
    errors.push('reserved test email domains are allowed only on a local stack or in CI');
  }
  if (appEnv === 'production' && siteParsed && siteParsed.protocol !== 'https:') {
    errors.push('production requires an https SITE_URL');
  }
  if (env.PRODUCTION_SUPABASE_PROJECT_REF && appEnv !== 'production' && actualRef === env.PRODUCTION_SUPABASE_PROJECT_REF) {
    errors.push('non-production APP_ENV points at the production project');
  }

  if (errors.length > 0) throw new BootstrapGuardError(errors);
  return {
    appEnv,
    supabaseUrl: url,
    projectRef: actualRef,
    email,
    displayName,
    branchCode,
    operator,
    redirectTo: `${siteUrl}/auth/confirm`,
  };
}

/** Removes any occurrence of the given secret values from a message. */
export function redact(message, secrets) {
  let out = String(message ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Decides what to do given the active super administrators already present. */
export function decideBootstrap(existingAdminEmails, email) {
  const normalised = existingAdminEmails.map((e) => String(e).trim().toLowerCase());
  if (normalised.length === 0) return 'create';
  if (normalised.includes(email)) return 'already_admin';
  return 'refuse';
}
