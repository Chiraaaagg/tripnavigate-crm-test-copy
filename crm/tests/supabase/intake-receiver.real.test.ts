import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { createPostgrestDeps, handleBitrixEventEdge } from '../../supabase/functions/bitrix-events/index';
import { syntheticEventRequest } from '../helpers/mock-bitrix';
import { assertDatabaseUrlNotOperational, closeRunManifests, openRunManifest } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';

/**
 * Phase 5 least-privilege receiver (security review M3) against the REAL local
 * Supabase stack: the Edge Function's own handler and PostgREST adapter, with
 * the PUBLISHABLE key only, calling public.integration_receive_bitrix_event
 * through real PostgREST (role anon). Proves the anon key can record one event
 * and nothing else.
 *
 * Uses the synthetic intake fixture (SYNTHETIC_MEMBER_0001 at
 * synthetic-portal.example.test). The receiver credential is generated per run;
 * only its SHA-256 digest is written, through a direct LOCAL database
 * connection, and removed in afterAll together with this run's inbox rows.
 * Runs only in CI; fails (never skips) when REQUIRE_REAL_STACK=1 and the stack
 * or TEST_DATABASE_URL is missing.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const TOKEN = 'synthetic-real-stack-application-token-0001';
const NOTE = 'ci real-stack receiver test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('receiver real-stack test runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const credential = randomBytes(32).toString('base64url');
const base = 7_000_000 + Math.floor(Math.random() * 900_000) * 10;
const usedIds = new Set<number>();
const dealId = (offset: number) => {
  usedIds.add(base + offset);
  return String(base + offset);
};
// Phase 6: this run's Deal manifest holds offsets 1..3 only; offset 4 is outside.
let manifestId = '';
const FN_URL = 'https://receiver.real-stack.example.test/functions/v1/bitrix-events';

async function owner<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

function deps(receiverCredential = credential) {
  return {
    applicationToken: TOKEN,
    ...createPostgrestDeps({ supabaseUrl: env!.url, publishableKey: env!.publishableKey, receiverCredential }),
  };
}
const nowTs = () => String(Math.floor(Date.now() / 1000));
const send = (opts: Parameters<typeof syntheticEventRequest>[1], receiverCredential?: string) =>
  handleBitrixEventEdge(
    syntheticEventRequest(FN_URL, { applicationToken: TOKEN, memberId: MEMBER, domain: DOMAIN, ts: nowTs(), ...opts }),
    deps(receiverCredential),
  );

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  manifestId = await openRunManifest(dbUrl!, {
    object: 'deal', ids: [base + 1, base + 2, base + 3], sourceCode: 'SYNTHETIC_SRC', businessDate: '2026-09-15',
  });
  await owner(`delete from public.integration_receiver_credentials where note = $1`, [NOTE]);
  await owner(
    `insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (2, decode($1, 'hex'), $2)`,
    [createHash('sha256').update(credential, 'utf8').digest('hex'), NOTE],
  );
});

afterAll(async () => {
  if (!enabled) return;
  await closeRunManifests(dbUrl!, manifestId ? [manifestId] : []);
  if (usedIds.size > 0) {
    await owner(`delete from public.integration_inbox where portal_member_id = $1 and source_deal_id = any($2::bigint[])`, [
      MEMBER,
      [...usedIds],
    ]);
  }
  await owner(`delete from public.integration_receiver_credentials where note = $1`, [NOTE]);
});

describe.skipIf(!enabled)('Edge receiver with the publishable key only (real PostgREST)', () => {
  it('records an event (200) and a redelivery stays one inbox row', async () => {
    const id = dealId(1);
    const ts = nowTs();
    expect((await send({ dealId: id, ts })).status).toBe(200);
    expect((await send({ dealId: id, ts })).status).toBe(200);
    const rows = await owner<{ n: string }>(
      `select count(*)::text as n from public.integration_inbox where portal_member_id = $1 and source_deal_id = $2`,
      [MEMBER, Number(id)],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('wrong receiver credential -> 503; wrong domain or member -> 401; nothing stored', async () => {
    const id = dealId(2);
    expect((await send({ dealId: id }, randomBytes(32).toString('base64url'))).status).toBe(503);
    expect((await send({ dealId: id, domain: 'other-portal.example.test' })).status).toBe(401);
    expect((await send({ dealId: id, memberId: 'OTHER_MEMBER_0001' })).status).toBe(401);
    const rows = await owner<{ n: string }>(
      `select count(*)::text as n from public.integration_inbox where source_deal_id = $1`,
      [Number(id)],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('the publishable key cannot read intake tables or call the service-role commands', async () => {
    const anon = stack!.anon();
    for (const table of ['integration_receiver_credentials', 'integration_intake_config', 'integration_inbox', 'deals']) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      expect(error, table).not.toBeNull();
      expect(data).toBeNull();
    }
    const record = await anon.rpc('integration_record_bitrix_event', {
      p_member_id: MEMBER,
      p_event_type: 'ONCRMDEALADD',
      p_deal_id: Number(dealId(3)),
      p_source_ts: Number(nowTs()),
    });
    expect(record.error).not.toBeNull();
    const claim = await anon.rpc('integration_claim_inbox', { p_limit: 1, p_lease_seconds: 60 });
    expect(claim.error).not.toBeNull();
  });

  it('Phase 6: an event outside the active manifest is still 200 and stored ignored/not_in_manifest', async () => {
    const id = dealId(4);
    expect((await send({ dealId: id })).status).toBe(200);
    const rows = await owner<{ status: string; reason_code: string; attempts: number; source_object: string }>(
      `select status, reason_code, attempts, source_object from public.integration_inbox where portal_member_id = $1 and source_deal_id = $2`,
      [MEMBER, Number(id)],
    );
    expect(rows).toEqual([{ status: 'ignored', reason_code: 'not_in_manifest', attempts: 0, source_object: 'deal' }]);
  });

  it('Phase 6 L1: environment unset answers 503 and writes no inbox row', async () => {
    const id = dealId(5);
    const [before] = await owner<{ environment: string }>('select environment from public.deployment_settings where id');
    await owner(`update public.deployment_settings set environment = 'unset'`);
    try {
      expect((await send({ dealId: id })).status).toBe(503);
    } finally {
      await owner(`update public.deployment_settings set environment = $1`, [before!.environment]);
    }
    const rows = await owner<{ n: string }>(`select count(*)::text as n from public.integration_inbox where source_deal_id = $1`, [Number(id)]);
    expect(rows[0]!.n).toBe('0');
  });
});
