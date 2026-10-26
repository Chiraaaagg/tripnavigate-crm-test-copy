import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';

/**
 * End-to-end checks against a REAL local Supabase stack (GoTrue + PostgREST +
 * Postgres), run by the CI job "supabase-integration" after `supabase start`,
 * `supabase db reset` and `node scripts/seed-local.mjs`. Skipped locally when
 * the stack is not configured; FAILS when REQUIRE_REAL_STACK=1 (CI) and the
 * configuration is missing (T16). These complement the PGlite policy tests by
 * proving that actual Supabase Auth tokens carry what the policies expect.
 */

const env = resolveRealStackEnv();
const enabled = env !== null;
const stack = env ? createRealStack(env) : null;
const url = env?.url;
const publishable = env?.publishableKey;
const password = env?.fixturePassword;

const userClient = () => stack!.anon();

async function signIn(email: string): Promise<SupabaseClient> {
  return (await stack!.signIn(email)).client;
}

async function upgradeToAal2(client: SupabaseClient, userId: string): Promise<void> {
  await stack!.enrolTotp(client, userId);
  expect(await stack!.aal(client)).toBe('aal2');
}

async function refs(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.from('deals').select('reference').order('reference');
  if (error) throw error;
  return (data ?? []).map((d) => d.reference as string);
}

afterAll(async () => {
  await stack?.cleanup();
});

describe.skipIf(!enabled)('real Supabase stack', () => {
  it('public sign-up is disabled', async () => {
    const { error } = await userClient().auth.signUp({ email: 'self.signup@example.test', password: 'Sufficiently-Long-1' });
    expect(error).not.toBeNull();
  });

  it('anonymous Data API requests are refused', async () => {
    const { data, error } = await userClient().from('deals').select('id');
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe('42501');
  });

  it('A01 + MFA gate: password-only session sees nothing; aal2 sees only owned deals', async () => {
    const client = await signIn(FIXTURE_EMAILS.salesDelhiA);
    expect(await refs(client)).toEqual([]);
    const rpc = await client.rpc('accept_my_invitation');
    expect(rpc.error?.code).toBe('42501');
    await upgradeToAal2(client, FIXTURE_USERS.salesDelhiA);
    expect(await refs(client)).toEqual(['SYN-DEL-001']);
    const other = await client.from('deals').select('id').eq('reference', 'SYN-DEL-002');
    expect(other.data).toEqual([]);
  });

  it('A02: Purchase at aal2 sees the assigned deal but no commercial row', async () => {
    const client = await signIn(FIXTURE_EMAILS.purchaseJodhpur);
    await upgradeToAal2(client, FIXTURE_USERS.purchaseJodhpur);
    expect(await refs(client)).toEqual(['SYN-DEL-001']);
    const { data, error } = await client.from('deal_commercials').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const audit = await client.from('audit_events').select('*');
    expect(audit.data).toEqual([]);
  });

  it('a self-made token claiming aal2 is rejected by the API', async () => {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({
      sub: FIXTURE_USERS.accountsJodhpur,
      role: 'authenticated',
      aal: 'aal2',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const signature = createHmac('sha256', 'not-the-project-secret').update(`${header}.${payload}`).digest('base64url');
    const forged = createClient(url!, publishable!, {
      global: { headers: { Authorization: `Bearer ${header}.${payload}.${signature}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await forged.from('deals').select('id');
    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
  });

  it('deactivated (banned) staff cannot sign in', async () => {
    const { error } = await userClient().auth.signInWithPassword({ email: FIXTURE_EMAILS.formerStaff, password: password! });
    expect(error).not.toBeNull();
  });
});
