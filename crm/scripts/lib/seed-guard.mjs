import { parse as parseConnectionString } from 'pg-connection-string';

// Environment guard for scripts/seed-local.mjs.
//
// Synthetic fixtures create fixture Auth users (including a Super Admin with
// the shared LOCAL_FIXTURE_PASSWORD) and relabel the database 'test'. Only a
// fresh database ('unset', or no deployment setting yet) or an already
// synthetic one ('test') may be seeded. 'operational' and 'staging' (the
// label scripts/local-bitrix-setup.mjs gives a local database holding real
// Bitrix data) are refused, as is any label this guard does not know.
const SEEDABLE = new Set(['unset', 'test']);

/** @param {string[]} environments deployment_settings.environment values (0 or 1 row). */
export function seedEnvironmentRefusal(environments) {
  const refused = environments.find((env) => !SEEDABLE.has(env));
  return refused === undefined
    ? null
    : `refusing to seed: the database deployment environment is ${refused}. Only a fresh ('unset') or synthetic ('test') database may be seeded.`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Refuse unsafe targets before constructing either the database or Auth client. */
export function seedTargetRefusal(supabaseUrl, databaseUrl) {
  const refusal = 'refusing to seed: use plain loopback HTTP(S) and PostgreSQL URLs without connection overrides.';
  try {
    const api = new URL(supabaseUrl);
    if (!['http:', 'https:'].includes(api.protocol) || !LOOPBACK.has(api.hostname)
        || api.username || api.password || api.search || api.hash || !['', '/'].includes(api.pathname)) return refusal;

    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !LOOPBACK.has(database.hostname)
        || database.hash) return refusal;
    // A strict allowlist also rejects encoded/duplicate host, hostaddr, port,
    // service, socket and SSL-file overrides before the driver can read files.
    // sslmode=disable is emitted by some local tooling; no other query is needed.
    for (const [key, value] of database.searchParams) {
      if (key !== 'sslmode' || value !== 'disable' || database.searchParams.getAll(key).length !== 1) return refusal;
    }
    const effective = parseConnectionString(databaseUrl);
    if (!LOOPBACK.has(effective.host) || effective.host.includes(',') || effective.host.startsWith('/')
        || effective.hostaddr != null) return refusal;
    return null;
  } catch {
    // Do not echo a connection string or parser error that might contain credentials.
    return refusal;
  }
}
