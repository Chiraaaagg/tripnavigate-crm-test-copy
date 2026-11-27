import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { createPostgrestDeps, handleBitrixEventEdge } from '../../../supabase/functions/bitrix-events/index';
import {
  assertDatabaseUrlNotOperational,
  closeRunManifests,
  FIXTURE_EMAILS,
  FIXTURE_USERS,
  istBusinessDate,
  openRunManifest,
} from '../../../tests/helpers/db';
import { startMockBitrix, syntheticDeal, syntheticEventRequest, type MockBitrix } from '../../../tests/helpers/mock-bitrix';
import { createRealStack, resolveRealStackEnv, sleep } from '../../../tests/helpers/real-stack';

/**
 * Architecture-C proofs that the existing suites do not state explicitly
 * (hosting-migration contract file 12, section 4.2), on the PLAIN stack of
 * crm/fallback/plain-stack (official Postgres 17, self-run GoTrue, PostgREST,
 * storage-api in front of an S3 stand-in, nginx front door). Synthetic data only.
 *
 *   P1  password + TOTP sign-in on plain GoTrue; the access token carries the
 *       claims the database reads (sub, role, aal = aal2, amr[] with
 *       timestamps, session_id) and auth.sessions holds the verified factor.
 *   P4  files through storage-api into the S3 stand-in: 200 kB and 3.5 MB
 *       objects land in the stand-in's bucket, the database sees them, a signed
 *       link works with the forced file name and is refused after 60 s, an
 *       upload over the 4 MiB bucket limit is refused.
 *   P5  scheduler without pg_cron / pg_net: an outside loop (scripts/
 *       scheduler-loop.sh) posts to the worker route every 30 s for 3 minutes
 *       against a MOCK Bitrix; worker-run rows per call, no overlap, a seeded
 *       inbox event processed one tick later (no kick); the timer route once;
 *       the SQL-only clean-ups once. Also measures G13 (sync health without
 *       pg_cron).
 *
 * Runs only through fallback/plain-stack/vitest.plain.config.ts in the
 * workflow fallback-plain-stack.yml, after the existing suites (it leaves
 * synthetic machine-log rows). Writes PLAIN_PROOFS_OUT (proofs.json). FAILS,
 * never skips, when REQUIRE_REAL_STACK=1 and configuration is missing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = new Set(['127.0.0.1', 'localhost']);
const env = resolveRealStackEnv();
const REQUIRED = ['TEST_DATABASE_URL', 'PLAIN_S3_ACCESS_KEY', 'PLAIN_S3_SECRET_KEY', 'INTAKE_WORKER_SECRET', 'BITRIX_WEBHOOK_BASE_URL'] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (env && missing.length > 0 && isRealStackRequired(process.env)) {
  throw new Error(`REQUIRE_REAL_STACK=1 but plain-stack proof configuration is missing: ${missing.join(', ')}`);
}
const enabled = env !== null && missing.length === 0;
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
if (enabled && !LOCAL.has(new URL(dbUrl).hostname)) throw new Error('plain-stack proofs run only against a local database');
const stack = enabled ? createRealStack(env!) : null;

const OUT = process.env.PLAIN_PROOFS_OUT?.trim() || 'test-results/plain/proofs.json';
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
function save() {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
}
function record(key: string, value: Record<string, unknown>) {
  results[key] = { ...(results[key] as Record<string, unknown> | undefined), ...value };
  save();
}

async function dbQuery<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const decodePart = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl);
});

afterAll(async () => {
  if (!enabled) return;
  results.endedAt = new Date().toISOString();
  save();
  await stack!.cleanup();
});

// ---------------------------------------------------------------------------
// P1: sign-in and the authenticator level inside the token
// ---------------------------------------------------------------------------
describe.skipIf(!enabled)('P1: password + TOTP sign-in on plain GoTrue, claims the database reads', () => {
  it('aal2 token: sub, role, aal, amr[] with timestamps, session_id; auth.sessions holds the factor; refresh keeps aal2', async () => {
    const userId = FIXTURE_USERS.salesDelhiB;
    // Start from no factor (an earlier suite may have left one this run does not know).
    await stack!.deleteAllFactors(userId);
    const signed = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiB, userId);
    const [head, payload] = signed.session.access_token.split('.');
    const header = decodePart(head);
    const claims = decodePart(payload);
    const amr = Array.isArray(claims.amr) ? (claims.amr as Array<Record<string, unknown>>) : [];
    const sessionId = typeof claims.session_id === 'string' ? claims.session_id : '';
    const [session] = sessionId
      ? await dbQuery<{ user_id: string; factor_id: string | null; aal: string | null }>(
          'select user_id::text, factor_id::text, aal::text from auth.sessions where id = $1',
          [sessionId],
        )
      : [];
    const refreshed = await stack!.refresh(signed.session.refresh_token);
    const refreshedClaims = refreshed.data.session ? decodePart(refreshed.data.session.access_token.split('.')[1]) : {};
    const dataApi = await stack!.withToken(signed.session.access_token).from('staff_profiles').select('user_id').eq('user_id', userId);
    record('P1', {
      tokenHeader: { alg: header.alg, typ: header.typ ?? null, kidPresent: Boolean(header.kid) },
      claimNames: Object.keys(claims).sort(),
      role: claims.role,
      aal: claims.aal,
      amr: amr.map((a) => ({ method: a.method, timestampIsNumber: typeof a.timestamp === 'number' })),
      sessionIdPresent: Boolean(sessionId),
      authSessionsRow: session ? { factorIdPresent: Boolean(session.factor_id), aal: session.aal, sameUser: session.user_id === userId } : null,
      refresh: { ok: !refreshed.error, aal: refreshedClaims.aal ?? null, sameSession: refreshedClaims.session_id === sessionId },
      dataApiWithToken: { error: dataApi.error?.code ?? null, rows: dataApi.data?.length ?? 0 },
    });
    expect(['HS256', 'ES256', 'RS256']).toContain(header.alg);
    expect(claims.sub).toBe(userId);
    expect(claims.role).toBe('authenticated');
    expect(claims.aal).toBe('aal2');
    expect(amr.map((a) => a.method)).toEqual(expect.arrayContaining(['password', 'totp']));
    expect(amr.every((a) => typeof a.timestamp === 'number')).toBe(true);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session?.user_id).toBe(userId);
    expect(session?.factor_id).toBeTruthy();
    expect(session?.aal).toBe('aal2');
    expect(refreshed.error).toBeNull();
    expect(refreshedClaims.aal).toBe('aal2');
    expect(dataApi.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P4: files through storage-api into the S3 stand-in
// ---------------------------------------------------------------------------
const S3 = { host: '127.0.0.1:59000', bucket: 'crm-plain-files', region: 'us-east-1', tenant: 'stub' };
const sha256hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();
const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** ListObjectsV2 on the S3 stand-in, signed with AWS Signature V4 (keys from the run's environment). */
async function s3List(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const access = process.env.PLAIN_S3_ACCESS_KEY!.trim();
  const secret = process.env.PLAIN_S3_SECRET_KEY!.trim();
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const query = `list-type=2&prefix=${awsEncode(prefix)}`;
  const empty = sha256hex('');
  const canonical = ['GET', `/${S3.bucket}`, query, `host:${S3.host}`, `x-amz-content-sha256:${empty}`, `x-amz-date:${amzDate}`, '',
    'host;x-amz-content-sha256;x-amz-date', empty].join('\n');
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), S3.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');
  const res = await fetch(`http://${S3.host}/${S3.bucket}?${query}`, {
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': empty,
      authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`S3 stand-in list answered HTTP ${res.status}`);
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1] ?? '',
    size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? '-1'),
  }));
}

/** Synthetic bytes that start like a PDF (the bucket allows application/pdf). */
const syntheticPdf = (size: number) => {
  const bytes = randomBytes(size);
  Buffer.from('%PDF-1.4\n% synthetic plain-stack proof\n').copy(bytes, 0);
  return bytes;
};

describe.skipIf(!enabled)('P4: files through storage-api into the S3 stand-in', () => {
  const BUCKET = 'booking-evidence';
  const run = randomBytes(4).toString('hex');
  const small = { path: `plain-proof/${run}/small.pdf`, size: 200_000 };
  const large = { path: `plain-proof/${run}/large.pdf`, size: 3_500_000 };
  const tooLarge = { path: `plain-proof/${run}/too-large.pdf`, size: 4_500_000 };

  afterAll(async () => {
    if (!enabled) return;
    await stack!.admin().storage.from(BUCKET).remove([small.path, large.path, tooLarge.path]).catch(() => undefined);
  });

  it('200 kB and 3.5 MB objects are stored in the stand-in and visible to the database; over 4 MiB is refused', async () => {
    const storage = stack!.admin().storage.from(BUCKET);
    const uploads: Record<string, unknown> = {};
    for (const file of [small, large]) {
      const started = Date.now();
      const { error } = await storage.upload(file.path, syntheticPdf(file.size), { contentType: 'application/pdf', upsert: false });
      uploads[file.path.split('/').pop()!] = { ok: !error, error: error?.message ?? null, ms: Date.now() - started };
      expect(error, `upload ${file.path}`).toBeNull();
    }
    const tooLargeUpload = await storage.upload(tooLarge.path, syntheticPdf(tooLarge.size), { contentType: 'application/pdf' });
    const inStandIn: Record<string, unknown> = {};
    const inDatabase: Record<string, unknown> = {};
    for (const file of [small, large]) {
      const objects = await s3List(`${S3.tenant}/${BUCKET}/${file.path}`);
      inStandIn[file.path.split('/').pop()!] = objects.map((o) => ({ size: o.size, keyDepth: o.key.split('/').length }));
      expect(objects.some((o) => o.size === file.size), `${file.path} in the S3 stand-in with its size`).toBe(true);
      const [row] = await dbQuery<{ size: string | null }>(
        `select metadata ->> 'size' as size from storage.objects where bucket_id = $1 and name = $2`,
        [BUCKET, file.path],
      );
      inDatabase[file.path.split('/').pop()!] = row ? { size: Number(row.size) } : null;
      expect(Number(row?.size), `${file.path} in storage.objects with its size`).toBe(file.size);
    }
    const tooLargeInStandIn = await s3List(`${S3.tenant}/${BUCKET}/${tooLarge.path}`);
    record('P4', {
      bucket: BUCKET,
      uploads,
      inStandIn,
      inDatabase,
      overLimit: {
        refused: Boolean(tooLargeUpload.error),
        message: tooLargeUpload.error?.message ?? null,
        status: (tooLargeUpload.error as { status?: number; statusCode?: string } | null)?.statusCode ?? null,
        objectsInStandIn: tooLargeInStandIn.length,
      },
    });
    expect(tooLargeUpload.error, 'an upload over the 4 MiB bucket limit is refused').not.toBeNull();
    expect(tooLargeInStandIn).toHaveLength(0);
  }, 120_000);

  it('a signed link works with the forced file name and is refused after 60 s', async () => {
    const storage = stack!.admin().storage.from(BUCKET);
    const forced = `plain-proof-${run}.pdf`;
    const created = Date.now();
    const { data, error } = await storage.createSignedUrl(small.path, 60, { download: forced });
    expect(error).toBeNull();
    const link = new URL(data!.signedUrl);
    expect(LOCAL.has(link.hostname)).toBe(true);
    const first = await fetch(link);
    const firstBody = Buffer.from(await first.arrayBuffer());
    const disposition = first.headers.get('content-disposition') ?? '';
    const waitMs = 60_000 + 3_000 - (Date.now() - created);
    if (waitMs > 0) await sleep(waitMs);
    const late = await fetch(link);
    record('P4', {
      signedLink: {
        firstStatus: first.status,
        firstBytes: firstBody.length,
        forcedNameInDisposition: disposition.includes(forced),
        attachment: /attachment/i.test(disposition),
        afterSeconds: Math.round((Date.now() - created) / 1000),
        lateStatus: late.status,
      },
    });
    expect(first.status).toBe(200);
    expect(firstBody.length).toBe(small.size);
    expect(disposition).toContain(forced);
    expect(late.status).toBeGreaterThanOrEqual(400);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// P5: scheduler without pg_cron / pg_net (+ G13 measurement)
// ---------------------------------------------------------------------------
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const SOURCE = 'SYNTHETIC_SRC';
const NOTE = 'plain-stack P5 proof';
const FN_URL = 'https://receiver.plain-stack.example.test/functions/v1/bitrix-events';
const INTERVAL_S = 30;
const CALLS = 7; // t = 0, 30, ..., 180 s: three minutes of ticks

interface LoopCall {
  call: number;
  startedAt: string;
  status: number;
  seconds: number;
}

function runSchedulerLoop(baseUrl: string): Promise<LoopCall[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(here, '..', 'scripts', 'scheduler-loop.sh'), baseUrl, String(INTERVAL_S), String(CALLS)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`scheduler-loop.sh exited ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LoopCall));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe.skipIf(!enabled)('P5: outside scheduler instead of pg_cron + pg_net (mock Bitrix, running app)', () => {
  const TOKEN = randomBytes(16).toString('hex');
  const credential = randomBytes(32).toString('base64url');
  const dealId = 47_000_000 + Math.floor(Math.random() * 900_000) * 10;
  const baseUrl = enabled ? new URL(process.env.BITRIX_WEBHOOK_BASE_URL!.trim()) : null;
  const webhook = baseUrl ? /^\/rest\/(\d+)\/([^/]+)\/?$/.exec(baseUrl.pathname) : null;
  let mock: MockBitrix | null = null;
  let manifestId = '';
  let startedAt = new Date(0);

  beforeAll(async () => {
    if (!enabled) return;
    if (!baseUrl || !LOCAL.has(baseUrl.hostname) || !webhook) throw new Error('BITRIX_WEBHOOK_BASE_URL must be a loopback mock address');
    startedAt = (await dbQuery<{ now: Date }>('select now() as now'))[0]!.now;
    // No daily full resync during the run (as tests/supabase/s4-no-missed-event.real.test.ts).
    const open = await dbQuery<{ n: number }>(
      `select count(*)::int as n from public.integration_resync_jobs where portal_member_id = $1 and status in ('queued', 'running')`,
      [MEMBER],
    );
    if (open[0]!.n > 0) throw new Error('refusing to run: a full resync is open on this stack');
    await dbQuery(
      `insert into public.integration_resync_jobs (portal_member_id, reason, status, cutoff_at, category_ids, stage_ids)
       select c.portal_member_id, 'manual', 'superseded', c.cutoff_at, array[c.category_id]::bigint[], c.eligible_stage_ids
       from public.integration_intake_config c where c.portal_member_id = $1`,
      [MEMBER],
    );
    await dbQuery('delete from public.integration_receiver_credentials where note = $1', [NOTE]);
    await dbQuery(`insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (2, decode($1, 'hex'), $2)`, [
      createHash('sha256').update(credential, 'utf8').digest('hex'),
      NOTE,
    ]);
    manifestId = await openRunManifest(dbUrl, { object: 'deal', ids: [dealId], sourceCode: SOURCE, businessDate: istBusinessDate() });
    mock = await startMockBitrix({ port: Number(baseUrl.port), userId: Number(webhook[1]), webhookCode: webhook[2] });
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    try {
      await dbQuery('delete from public.integration_receiver_credentials where note = $1', [NOTE]);
      await closeRunManifests(dbUrl, manifestId ? [manifestId] : []);
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`update public.integration_inbox set processed_deal_id = null where portal_member_id = $1 and source_deal_id = $2`, [MEMBER, dealId]);
        await client.query(
          `delete from public.deal_assignments where deal_id in (
             select id from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = $2)`,
          [MEMBER, dealId],
        );
        await client.query(`delete from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = $2`, [MEMBER, dealId]);
        await client.query(`delete from public.integration_inbox where portal_member_id = $1 and source_deal_id = $2`, [MEMBER, dealId]);
        await client.query(
          `delete from public.integration_resync_seen where job_id in (
             select id from public.integration_resync_jobs where portal_member_id = $1 and created_at >= $2)`,
          [MEMBER, startedAt.toISOString()],
        );
        await client.query(`delete from public.integration_resync_jobs where portal_member_id = $1 and created_at >= $2`, [MEMBER, startedAt.toISOString()]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    } finally {
      await mock?.close();
    }
  }, 120_000);

  it('every 30 s for 3 minutes: one run per call, no overlap, the event is processed one tick later without a kick', async () => {
    const loopStarted = Date.now();
    const loop = runSchedulerLoop(env!.appBaseUrl);
    // The record appears in the mock Bitrix and its event is sent a few seconds
    // AFTER the first tick, so neither that tick's pull nor its inbox drain sees
    // it: the event waits for the next tick (round 1 added the record before the
    // loop, and the first pull imported it before the event arrived).
    await sleep(8_000);
    const now = new Date().toISOString();
    mock!.deals.set(String(dealId), syntheticDeal(dealId, {
      STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: '101', DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE,
    }));
    const sent = await handleBitrixEventEdge(
      syntheticEventRequest(FN_URL, { applicationToken: TOKEN, memberId: MEMBER, domain: DOMAIN, ts: String(Math.floor(Date.now() / 1000)), dealId: String(dealId), event: 'ONCRMDEALADD' }),
      { applicationToken: TOKEN, ...createPostgrestDeps({ supabaseUrl: env!.url, publishableKey: env!.publishableKey, receiverCredential: credential }) },
    );
    const calls = await loop;
    const loopEnded = Date.now();

    const [row] = await dbQuery<{ status: string; reason_code: string | null; attempts: number; received_at: Date; processed_at: Date | null; updated_at: Date }>(
      `select status, reason_code, attempts, received_at, processed_at, updated_at from public.integration_inbox
       where portal_member_id = $1 and source_deal_id = $2 order by received_at limit 1`,
      [MEMBER, dealId],
    );
    const runs = await dbQuery<{ kind: string; started_at: Date; finished_at: Date; outcome: string }>(
      `select kind, started_at, finished_at, outcome from public.integration_worker_runs
       where started_at >= $1 and started_at <= $2 order by started_at`,
      [new Date(loopStarted - 2_000).toISOString(), new Date(loopEnded + 5_000).toISOString()],
    );
    const kicks = await dbQuery<{ kind: string; n: number }>(
      `select kind, count(*)::int as n from public.integration_sync_dispatches where dispatched_at >= $1 group by kind`,
      [startedAt.toISOString()],
    );
    const finishedAt = row?.processed_at ?? (row && row.status !== 'pending' ? row.updated_at : null);
    const nextCall = calls.find((c) => row && Date.parse(c.startedAt) >= row.received_at.getTime());
    const perCall = calls.map((c) => {
      const from = Date.parse(c.startedAt) - 1_000;
      const to = Date.parse(c.startedAt) + c.seconds * 1_000 + 2_000;
      return runs.filter((r) => r.started_at.getTime() >= from && r.started_at.getTime() <= to).map((r) => `${r.kind}:${r.outcome}`);
    });
    const overlaps: string[] = [];
    for (const kind of new Set(runs.map((r) => r.kind))) {
      const mine = runs.filter((r) => r.kind === kind);
      for (let i = 1; i < mine.length; i += 1) {
        if (mine[i]!.started_at < mine[i - 1]!.finished_at) overlaps.push(`${kind} #${i}`);
      }
    }
    const waitSeconds = row && finishedAt ? (finishedAt.getTime() - row.received_at.getTime()) / 1000 : null;
    record('P5', {
      intervalSeconds: INTERVAL_S,
      calls,
      receiverStatus: sent.status,
      inboxRow: row ? { status: row.status, reasonCode: row.reason_code, attempts: row.attempts } : null,
      eventWaitSeconds: waitSeconds,
      processedAfterNextTickStarted: Boolean(nextCall && finishedAt && finishedAt.getTime() >= Date.parse(nextCall.startedAt) - 500),
      workerRunsPerCall: perCall,
      workerRunsTotal: runs.length,
      overlaps,
      dispatchesSinceStart: Object.fromEntries(kicks.map((k) => [k.kind, k.n])),
    });
    expect(calls).toHaveLength(CALLS);
    expect(calls.every((c) => c.status === 200)).toBe(true);
    expect(sent.status).toBe(200);
    expect(perCall.every((rows) => rows.length >= 1), 'at least one worker-run row per call').toBe(true);
    expect(overlaps).toEqual([]);
    expect(row, 'the seeded event reached the inbox').toBeTruthy();
    expect(['processed', 'ignored']).toContain(row!.status);
    expect(row!.attempts).toBe(1);
    // No kick: the event waited for the next tick, which came within one interval.
    expect(waitSeconds).not.toBeNull();
    expect(waitSeconds!).toBeLessThanOrEqual(INTERVAL_S + 15);
    expect(nextCall, 'a tick started after the event arrived').toBeTruthy();
    expect(finishedAt!.getTime(), 'processed by that tick, not before it').toBeGreaterThanOrEqual(Date.parse(nextCall!.startedAt) - 500);
    expect(kicks.find((k) => k.kind === 'event')?.n ?? 0).toBe(0);
  }, 300_000);

  it('the timer route answers once with the timer bearer', async () => {
    const secret = process.env.TIMER_SECRET?.trim() ?? '';
    const res = await fetch(`${env!.appBaseUrl}/api/integrations/timer`, {
      method: 'POST',
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      redirect: 'manual',
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    record('P5', { timer: { configured: Boolean(secret), status: res.status, body } });
    expect(res.status).toBe(secret ? 200 : 503);
  }, 120_000);

  it('the SQL-only clean-ups of the pg_cron jobs run once when called directly', async () => {
    // The commands of the jobs provisioned by authz.provision_bitrix_sync_jobs(),
    // authz.provision_referral_close_job() and the S4 machine-log prune.
    const jobs: Array<[string, string]> = [
      ['bitrix-sync-heartbeat-cleanup', `delete from public.integration_worker_runs where finished_at < now() - interval '14 days'`],
      ['bitrix-sync-dispatch-cleanup', `delete from public.integration_sync_dispatches where dispatched_at < now() - interval '14 days'`],
      ['referral-drafts-close-inactive', 'select public.referral_drafts_close_inactive(200)'],
      ['machine-log-prune', 'select authz.prune_machine_logs()'],
    ];
    const outcome: Record<string, unknown> = {};
    for (const [name, sql] of jobs) {
      try {
        const rows = await dbQuery(sql);
        outcome[name] = { ok: true, result: rows[0] ?? null };
      } catch (error) {
        outcome[name] = { ok: false, code: (error as { code?: string }).code ?? null, message: String((error as Error).message).slice(0, 200) };
      }
    }
    record('P5', { sqlCleanups: outcome });
    expect(Object.values(outcome).every((o) => (o as { ok: boolean }).ok)).toBe(true);
  }, 120_000);

  it('G13 (measurement): what sync health and the stopped-sync alert say without pg_cron', async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    const measured: Record<string, unknown> = {};
    try {
      await client.query('begin');
      // Disposable stack, rolled back: the sync switch as an operator would set it.
      await client.query('update public.integration_sync_schedule set enabled = true, updated_at = now() where id');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      await client.query('savepoint alert');
      await client.query('set local role service_role');
      try {
        const alert = await client.query<{ r: unknown }>('select public.integration_sync_alert_check() as r');
        measured.alertCheck = alert.rows[0]?.r ?? null;
        await client.query('release savepoint alert');
      } catch (error) {
        measured.alertCheckError = String((error as Error).message).slice(0, 200);
        await client.query('rollback to savepoint alert');
      }
      await client.query('reset role');
      const incidents = await client.query<{ reason_code: string }>(
        `select reason_code from public.integration_sync_incidents where recovered_at is null and opened_at >= now() - interval '1 minute'`,
      );
      measured.incidentOpenedWithSyncOn = incidents.rows.map((r) => r.reason_code);
      const nowS = Math.floor(Date.now() / 1000);
      const claims = {
        sub: FIXTURE_USERS.adminJodhpur, role: 'authenticated', aal: 'aal2', aud: 'authenticated', iat: nowS, exp: nowS + 900,
        amr: [{ method: 'password', timestamp: nowS - 60 }, { method: 'totp', timestamp: nowS - 60 }],
      };
      await client.query('savepoint status');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query('set local role authenticated');
      try {
        const status = await client.query<{ r: Record<string, unknown> }>('select public.integration_auto_sync_status() as r');
        const st = status.rows[0]?.r ?? {};
        measured.autoSyncStatus = { cronInstalled: st.cronInstalled ?? null, job: st.job ?? null, enabled: st.enabled ?? null, keys: Object.keys(st).sort() };
        await client.query('release savepoint status');
      } catch (error) {
        measured.autoSyncStatusError = String((error as Error).message).slice(0, 200);
        await client.query('rollback to savepoint status');
      }
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
    record('G13', measured);
    expect(measured).toBeTruthy();
  }, 120_000);
});
