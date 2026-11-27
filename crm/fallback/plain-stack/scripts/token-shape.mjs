#!/usr/bin/env node
// Step 0 / P1 helper: how does this stack sign user tokens? Signs one SYNTHETIC
// fixture user in with a password (aal1) on a local stack and prints, as JSON,
// only the token's header fields, the claim NAMES and the public JWKS key types.
// The token itself is never printed or stored.
//
// Needs SUPABASE_URL (loopback), SUPABASE_PUBLISHABLE_KEY and LOCAL_FIXTURE_PASSWORD
// (the seeded fixtures of scripts/seed-local.mjs).
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
const password = process.env.LOCAL_FIXTURE_PASSWORD ?? '';
const email = process.env.TOKEN_SHAPE_EMAIL ?? 'sales.delhi.a@example.test';

const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
if (!['127.0.0.1', 'localhost'].includes(host) || !key || !password) {
  console.error('token-shape: needs a loopback SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and LOCAL_FIXTURE_PASSWORD');
  process.exit(2);
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: key, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!res.ok) {
  console.error(`token-shape: sign-in answered HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const [head, payload] = String(body.access_token ?? '').split('.');
const header = decode(head);
const claims = decode(payload);

let jwks = null;
try {
  const j = await fetch(`${url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: key } });
  const doc = j.ok ? await j.json() : null;
  jwks = { status: j.status, keys: (doc?.keys ?? []).map((k) => ({ kty: k.kty, alg: k.alg ?? null, use: k.use ?? null, crv: k.crv ?? null })) };
} catch (error) {
  jwks = { error: String(error).slice(0, 120) };
}

console.log(JSON.stringify({
  alg: header.alg,
  typ: header.typ ?? null,
  kidPresent: Boolean(header.kid),
  claimNames: Object.keys(claims).sort(),
  role: claims.role ?? null,
  aal: claims.aal ?? null,
  amrMethods: Array.isArray(claims.amr) ? claims.amr.map((a) => a.method) : null,
  sessionIdPresent: Boolean(claims.session_id),
  issuer: claims.iss ?? null,
  expiresInSeconds: typeof claims.exp === 'number' && typeof claims.iat === 'number' ? claims.exp - claims.iat : null,
  jwks,
}));
