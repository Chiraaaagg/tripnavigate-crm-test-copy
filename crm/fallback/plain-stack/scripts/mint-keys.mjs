#!/usr/bin/env node
// Generates every secret of one plain-stack CI run and mints the two API keys
// (contract file 12, section 3.2). Run once per job, before scripts/up.sh:
//
//   node fallback/plain-stack/scripts/mint-keys.mjs
//
// Writes NAME=value lines to the file named by $GITHUB_ENV (so later steps of
// the same job see them) and prints only "::add-mask::" commands, so GitHub
// hides every value in the logs. Refuses to run outside GitHub Actions unless
// PLAIN_ENV_FILE names a file to write instead. Never prints a value itself.
//
// The JWT secret, the database passwords and the S3 keys are random per run;
// the API keys are HS256 tokens for the roles anon and service_role signed
// with that secret, as Supabase's legacy API keys are. User sessions are signed
// by GoTrue with a per-run ES256 key pair, as the Supabase CLI stack does (step
// 0 capture, run 45983995949). Round 1 signed them with the shared secret
// (HS256): two tokens for the same session in the same second were then
// byte-identical and journey.real.e2e.ts "new access token" failed (gap G16).
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const target = process.env.GITHUB_ENV || process.env.PLAIN_ENV_FILE;
if (!target) {
  console.error('mint-keys: set GITHUB_ENV (GitHub Actions) or PLAIN_ENV_FILE');
  process.exit(2);
}

const hex = (bytes) => randomBytes(bytes).toString('hex');
const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function mintJwt(secret, role, now) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ iss: 'plain-stack-ci', role, iat: now, exp: now + 12 * 3600 });
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

const jwtSecret = hex(32);
const dbPassword = hex(24);
const serviceDbPassword = hex(24);
const probePassword = hex(24);
const s3AccessKey = `plain${hex(8)}`;
const s3SecretKey = hex(24);
const now = Math.floor(Date.now() / 1000);
const anonKey = mintJwt(jwtSecret, 'anon', now);
const serviceKey = mintJwt(jwtSecret, 'service_role', now);

// Session signing key (private JWK for GoTrue) and the JWKS that PostgREST and
// storage-api verify with: the shared secret (for the two API keys) plus the
// public half of the key pair.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPrivate = privateKey.export({ format: 'jwk' });
const kid = hex(8);
const signingKeys = [{ kty: 'EC', kid, use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256', ext: true, crv: ecPrivate.crv, x: ecPrivate.x, y: ecPrivate.y, d: ecPrivate.d }];
const jwks = {
  keys: [
    { kty: 'oct', k: Buffer.from(jwtSecret, 'utf8').toString('base64url'), alg: 'HS256' },
    { kty: 'EC', kid, use: 'sig', key_ops: ['verify'], alg: 'ES256', ext: true, crv: ecPrivate.crv, x: ecPrivate.x, y: ecPrivate.y },
  ],
};

// Database URLs: the services reach Postgres on the compose network ("db"),
// the runner reaches it on loopback only.
const dbUrl = (user, password, host, port) => `postgres://${user}:${password}@${host}:${port}/postgres`;
const runnerDbUrl = dbUrl('postgres', dbPassword, '127.0.0.1', 55432);

const values = {
  PLAIN_JWT_SECRET: jwtSecret,
  PLAIN_DB_PASSWORD: dbPassword,
  PLAIN_SVC_DB_PASSWORD: serviceDbPassword,
  PLAIN_PROBE_PASSWORD: probePassword,
  PLAIN_S3_ACCESS_KEY: s3AccessKey,
  PLAIN_S3_SECRET_KEY: s3SecretKey,
  PLAIN_ANON_KEY: anonKey,
  PLAIN_SERVICE_KEY: serviceKey,
  PLAIN_JWT_KEYS: JSON.stringify(signingKeys),
  PLAIN_JWKS: JSON.stringify(jwks),
  // Only for masking and the artifact scrub: the private part of the key pair.
  PLAIN_EC_PRIVATE_D: ecPrivate.d,
  PLAIN_AUTH_DB_URL: dbUrl('supabase_auth_admin', serviceDbPassword, 'db', 5432),
  PLAIN_STORAGE_DB_URL: dbUrl('supabase_storage_admin', serviceDbPassword, 'db', 5432),
  PLAIN_REST_DB_URL: dbUrl('authenticator', serviceDbPassword, 'db', 5432),
  PLAIN_ADMIN_DB_URL: runnerDbUrl,
  // The names the existing test suites, seed script and app read.
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: anonKey,
  SUPABASE_SECRET_KEY: serviceKey,
  TEST_DATABASE_URL: runnerDbUrl,
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
};

const secrets = [jwtSecret, dbPassword, serviceDbPassword, probePassword, s3AccessKey, s3SecretKey, anonKey, serviceKey, ecPrivate.d, jwks.keys[0].k];
if (process.env.GITHUB_ACTIONS === 'true') {
  for (const secret of secrets) console.log(`::add-mask::${secret}`);
}
appendFileSync(target, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
console.log(`mint-keys: ${Object.keys(values).length} values written (${secrets.length} masked); API keys HS256 (12 h), sessions ES256`);
