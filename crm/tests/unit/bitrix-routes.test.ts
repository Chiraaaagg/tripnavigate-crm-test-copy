import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route wiring (app/api/integrations/bitrix/*), proxy exemption, and the admin
 * server actions / status loader for /app/admin/integration.
 */

const TOKEN = 'synthetic-application-token-0123456789';
const SECRET = 'synthetic-worker-secret-0123456789abcdef';
const MEMBER = 'synthetic-member-0001';
const DOMAIN = 'synthetic.bitrix24.example';

const adminRpc = vi.fn();
const adminFactory = vi.fn();
const requireStaff = vi.fn();
const revalidatePath = vi.fn();
const configRow = {
  portal_domain: DOMAIN,
  portal_member_id: MEMBER,
  category_id: '7',
  eligible_stage_ids: ['C7:WON'],
  cutoff_at: '2026-10-01T00:00:00+05:30',
  pilot_legal_entity_id: null,
  pilot_branch_id: 'b0000000-0000-4000-8000-000000000001',
  enabled: true,
};

vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

/** Minimal chainable PostgREST stand-in: every filter returns itself; awaiting yields `result`. */
/** integration_auto_sync_status (admin RPC) as the fake client answers it. */
const autoSyncRpc = vi.fn(async (name?: string) =>
  name === 'integration_waiting_for_owner'
    // Stage 0: Deals waiting for an owner come from the admin-only database count.
    ? { data: { total: 3, byBitrixUser: [{ bitrixUserId: 7, deals: 2 }, { bitrixUserId: 9, deals: 1 }] }, error: null }
    : {
        data: { cronInstalled: true, job: { schedule: '30 seconds', active: true }, enabled: true, lastCalls: [], failingSince: null },
        error: null,
      });

function table(result: { data?: unknown; single?: unknown; error?: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'gte', 'is', 'range']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: result.single ?? result.data ?? null, error: result.error ?? null });
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
  return chain;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.BITRIX_EVENT_APPLICATION_TOKEN = TOKEN;
  process.env.INTAKE_WORKER_SECRET = SECRET;
  process.env.APP_ENV = 'local';
  delete process.env.VERCEL_ENV;
  delete process.env.CRON_SECRET;
  delete process.env.BITRIX_WEBHOOK_BASE_URL;
  adminFactory.mockReturnValue({
    rpc: adminRpc,
    from: (name: string) => table(name === 'integration_intake_config' ? { data: [configRow] } : {}),
  });
  adminRpc.mockResolvedValue({ data: { inboxId: '00000000-0000-4000-8000-000000000001', duplicate: false }, error: null });
});
const savedAppEnv = process.env.APP_ENV;
afterEach(() => {
  delete process.env.BITRIX_EVENT_APPLICATION_TOKEN;
  delete process.env.INTAKE_WORKER_SECRET;
  delete process.env.BITRIX_WEBHOOK_BASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_ENV;
  if (savedAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = savedAppEnv;
});

const eventBody = (token = TOKEN) =>
  new URLSearchParams({
    event: 'ONCRMDEALADD',
    'data[FIELDS][ID]': '15',
    ts: '1759700000',
    'auth[domain]': DOMAIN,
    'auth[member_id]': MEMBER,
    'auth[application_token]': token,
  }).toString();

describe('POST /api/integrations/bitrix/events', () => {
  it('records through the service-role command and answers 200', async () => {
    const { POST } = await import('@/app/api/integrations/bitrix/events/route');
    const res = await POST(
      new Request('https://crm.example.test/api/integrations/bitrix/events', {
        method: 'POST',
        body: eventBody(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(res.status).toBe(200);
    expect(adminRpc).toHaveBeenCalledWith('integration_record_bitrix_event', {
      p_member_id: MEMBER,
      p_event_type: 'ONCRMDEALADD',
      p_deal_id: 15,
      p_source_ts: 1759700000,
    });
  });

  it('wrong token -> 401 and the privileged client is never created', async () => {
    const { POST } = await import('@/app/api/integrations/bitrix/events/route');
    const res = await POST(
      new Request('https://crm.example.test/api/integrations/bitrix/events', {
        method: 'POST',
        body: eventBody('wrong-token-value'),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(res.status).toBe(401);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('exports POST only (other methods get 405 from Next.js)', async () => {
    const mod = await import('@/app/api/integrations/bitrix/events/route');
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['POST']);
  });

  it.each([
    ['production', 'production'],
    ['staging', 'preview'],
    ['local', 'development'],
  ])('APP_ENV=%s VERCEL_ENV=%s: 404 (the Edge Function is the only production ingress)', async (appEnv, vercelEnv) => {
    process.env.APP_ENV = appEnv;
    process.env.VERCEL_ENV = vercelEnv;
    const { POST } = await import('@/app/api/integrations/bitrix/events/route');
    const res = await POST(
      new Request('https://crm.example.test/api/integrations/bitrix/events', {
        method: 'POST',
        body: eventBody(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(res.status).toBe(404);
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations/bitrix/worker (Vercel Cron)', () => {
  const CRON = 'synthetic-cron-secret-0123456789abcdef0';
  const get = (auth?: string) =>
    new Request('https://crm.example.test/api/integrations/bitrix/worker', {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
    });

  it('exports GET (cron) and POST (manual)', async () => {
    const mod = await import('@/app/api/integrations/bitrix/worker/route');
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(['GET', 'POST']);
  });

  it('503 when CRON_SECRET is not set, even with the worker secret as bearer', async () => {
    const { GET } = await import('@/app/api/integrations/bitrix/worker/route');
    expect((await GET(get(`Bearer ${SECRET}`))).status).toBe(503);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('the two triggers do not accept each other\'s secret', async () => {
    process.env.CRON_SECRET = CRON;
    const { GET, POST } = await import('@/app/api/integrations/bitrix/worker/route');
    expect((await GET(get(`Bearer ${SECRET}`))).status).toBe(401);
    const post = new Request('https://crm.example.test/api/integrations/bitrix/worker', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON}` },
    });
    expect((await POST(post)).status).toBe(401);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('a valid cron bearer on production reaches configuration (503 here: no REST URL), never on a Preview', async () => {
    process.env.CRON_SECRET = CRON;
    process.env.APP_ENV = 'production';
    process.env.VERCEL_ENV = 'production';
    const { GET } = await import('@/app/api/integrations/bitrix/worker/route');
    expect((await GET(get(`Bearer ${CRON}`))).status).toBe(503);
    expect(adminFactory).toHaveBeenCalled();
    // Sync completion §4: only the sync-stopped alert check runs; no intake command.
    expect(adminRpc.mock.calls.map((c) => c[0])).toEqual(['integration_sync_alert_check']);

    adminFactory.mockClear();
    process.env.APP_ENV = 'staging';
    process.env.VERCEL_ENV = 'preview';
    vi.resetModules();
    const preview = await import('@/app/api/integrations/bitrix/worker/route');
    expect((await preview.GET(get(`Bearer ${CRON}`))).status).toBe(503);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('identical CRON_SECRET and INTAKE_WORKER_SECRET are refused (503, no database access)', async () => {
    process.env.CRON_SECRET = SECRET;
    const { GET } = await import('@/app/api/integrations/bitrix/worker/route');
    expect((await GET(get(`Bearer ${SECRET}`))).status).toBe(503);
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/bitrix/worker', () => {
  it('401 without the bearer secret; privileged client not created', async () => {
    const { POST } = await import('@/app/api/integrations/bitrix/worker/route');
    const res = await POST(new Request('https://crm.example.test/api/integrations/bitrix/worker', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('503 when BITRIX_WEBHOOK_BASE_URL is missing (no claim made)', async () => {
    const { POST } = await import('@/app/api/integrations/bitrix/worker/route');
    const res = await POST(
      new Request('https://crm.example.test/api/integrations/bitrix/worker', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(503);
    // No claim; the sync-stopped alert check still runs after the answer (§4).
    expect(adminRpc.mock.calls.map((c) => c[0])).toEqual(['integration_sync_alert_check']);
  });
});

describe('proxy exemption for /api/integrations/*', () => {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'proxy.ts'), 'utf8');
  it('matcher excludes the integration API and the function guard returns early', () => {
    expect(source).toContain("robots.txt|api/integrations/).*)'");
    expect(source).toMatch(/if \(isIntegrationApiPath\(request\.nextUrl\.pathname\)\) return NextResponse\.next\(\);/);
    // Staff UI handling remains.
    expect(source).toContain("request.nextUrl.pathname.startsWith('/app')");
    expect(source).toContain('res.headers.set(CSP_HEADER, csp)');
  });
  it('the matcher regex excludes only /api/integrations/*', () => {
    const m = /source: '(.+)'/.exec(source)![1]!;
    const re = new RegExp(`^${m.replace('/((?!', '/(?!').replace(').*)', ').*')}$`);
    expect(re.test('/api/integrations/bitrix/events')).toBe(false);
    expect(re.test('/api/integrations/bitrix/worker')).toBe(false);
    expect(re.test('/app/deals')).toBe(true);
    expect(re.test('/app/admin/integration')).toBe(true);
    expect(re.test('/api/other')).toBe(true);
  });
});

describe('startOfTodayIst', () => {
  it('is midnight IST (18:30 UTC the previous day)', async () => {
    const { startOfTodayIst } = await import('@/modules/integration/server/queries');
    expect(startOfTodayIst(Date.parse('2026-10-06T10:00:00Z'))).toBe('2026-10-05T18:30:00.000Z');
    expect(startOfTodayIst(Date.parse('2026-10-05T18:29:59Z'))).toBe('2026-10-04T18:30:00.000Z');
    expect(startOfTodayIst(Date.parse('2026-10-05T18:30:00Z'))).toBe('2026-10-05T18:30:00.000Z');
  });
});

describe('admin actions and status loader', () => {
  const idle = { status: 'idle' as const };
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it('retryInboxItemAction: session gate, then integration_retry_inbox under the actor session', async () => {
    const userRpc = vi.fn().mockResolvedValue({ data: { status: 'pending' }, error: null });
    requireStaff.mockResolvedValue({ supabase: { rpc: userRpc } });
    const { retryInboxItemAction } = await import('@/modules/integration/server/actions');
    const id = '00000000-0000-4000-8000-0000000000aa';
    const ok = await retryInboxItemAction(idle, form({ inboxId: id }));
    expect(ok.status).toBe('success');
    expect(userRpc).toHaveBeenCalledWith('integration_retry_inbox', { p_inbox_id: id });
    expect(adminFactory).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith('/app/admin/integration');

    userRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    expect((await retryInboxItemAction(idle, form({ inboxId: id }))).message).toMatch(/permission/);
    expect((await retryInboxItemAction(idle, form({ inboxId: 'not-a-uuid' }))).status).toBe('error');
  });

  it('runReconcileNowAction: integration_request_reconcile first (denied / cooldown / not configured / no credential)', async () => {
    const userRpc = vi.fn();
    const userFrom = vi.fn(() => table({ data: [configRow] }));
    requireStaff.mockResolvedValue({ supabase: { rpc: userRpc, from: userFrom } });
    const { runReconcileNowAction } = await import('@/modules/integration/server/actions');

    userRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    expect((await runReconcileNowAction(idle, new FormData())).message).toMatch(/permission/);
    expect(userRpc).toHaveBeenCalledWith('integration_request_reconcile', {});
    expect(userFrom).not.toHaveBeenCalled();

    userRpc.mockResolvedValue({ data: { portalMemberId: MEMBER, allowed: false, retryAfterSeconds: 200 }, error: null });
    const cooldown = await runReconcileNowAction(idle, new FormData());
    expect(cooldown).toMatchObject({ status: 'error' });
    expect(cooldown.message).toMatch(/ran recently.*about 4 minutes/);
    expect(userFrom).not.toHaveBeenCalled();

    userRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'intake is not configured' } });
    expect((await runReconcileNowAction(idle, new FormData())).message).toMatch(/not configured/);

    userRpc.mockResolvedValue({ data: { portalMemberId: MEMBER, allowed: true, retryAfterSeconds: 0 }, error: null });
    userFrom.mockImplementation(() => table({ data: [] }));
    expect((await runReconcileNowAction(idle, new FormData())).message).toMatch(/not configured/);

    userFrom.mockImplementation(() => table({ data: [configRow] }));
    const noCred = await runReconcileNowAction(idle, new FormData());
    expect(noCred.message).toMatch(/credential is not configured/);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('loadIntegrationStatus reports presence of credentials, never values', async () => {
    const statusPortal = 'synthetic.bitrix24.test';
    process.env.BITRIX_WEBHOOK_BASE_URL = 'https://synthetic.bitrix24.example/rest/1/secretcode123/';
    const from = vi.fn((name: string) => {
      switch (name) {
        case 'integration_intake_config':
          return table({ data: [{ ...configRow, portal_domain: statusPortal }] });
        case 'deployment_settings':
          return table({ data: { environment: 'test' } });
        case 'branches':
          return table({ data: { name: 'Synthetic Delhi' } });
        case 'integration_inbox':
          return table({
            data: [],
            single: { processed_at: '2026-10-06T00:00:00Z', received_at: '2026-10-05T23:00:00Z' },
            count: 2,
          });
        case 'integration_worker_runs':
          return table({ single: { finished_at: '2026-10-06T00:01:00Z', outcome: 'partial' } });
        case 'integration_sync_schedule':
          return table({ single: { enabled: true } });
        case 'deals':
          // Ownerless imported deals (admin view): two for Bitrix user 7, one for 9.
          // count: the shared deal count (same query as the Deals page).
          return table({ data: [{ source_assigned_by_id: 7 }, { source_assigned_by_id: 9 }, { source_assigned_by_id: 7 }], count: 41 });
        case 'integration_resync_jobs':
          return table({
            data: [
              { reason: 'settings_changed', status: 'running', scanned: 150, bitrix_total: 400, listing_done: false, created_at: '2026-10-06T00:02:00Z', finished_at: null, result: null },
              { reason: 'daily', status: 'done', scanned: 41, bitrix_total: 41, listing_done: true, created_at: '2026-10-05T00:00:00Z', finished_at: '2026-10-05T00:03:00Z', result: { bitrix: 41, crm: 41, missing: 0, extra: 0, keptAfterStageMove: 0, inSync: true } },
            ],
          });
        default:
          throw new Error(`unexpected table ${name}`);
      }
    });
    const { loadIntegrationStatus } = await import('@/modules/integration/server/queries');
    const view = await loadIntegrationStatus({ supabase: { from, rpc: autoSyncRpc } as never });
    expect(view.crmDeals).toBe(41);
    // Scheduler health from integration_auto_sync_status + the last successful heartbeat.
    expect(view.autoSync).toMatchObject({ cronInstalled: true, jobActive: true, enabled: true, lastSuccessAt: '2026-10-06T00:01:00Z' });
    expect(view.lastRun).toEqual({ at: '2026-10-06T00:01:00Z', fetched: 0, created: 0, updated: 0 });
    expect(view.fullCheck).toEqual({
      running: { reason: 'settings_changed', scanned: 150, bitrixTotal: 400, listingDone: false, queuedAt: '2026-10-06T00:02:00Z' },
      last: { finishedAt: '2026-10-05T00:03:00Z', bitrix: 41, crm: 41, missing: 0, extra: 0, keptAfterStageMove: 0, inSync: true, matchesSettings: false },
    });
    expect(view).toMatchObject({
      configured: true,
      environment: 'test',
      portalDomain: statusPortal,
      pilotBranchName: 'Synthetic Delhi',
      credentialPresent: true,
      workerSecretPresent: true,
      enabledConfigCount: 1,
      lastProcessedAt: '2026-10-06T00:00:00Z',
      lastWorkerRunAt: '2026-10-06T00:01:00Z',
      lastWorkerOutcome: 'partial',
      oldestPendingAt: '2026-10-05T23:00:00Z',
      lastSyncAt: '2026-10-06T00:01:00Z',
      lastSyncOutcome: 'partial',
      dealsSyncedToday: 2,
      syncEnabled: true,
      waitingForOwner: 3,
      waitingByBitrixUser: [
        { bitrixUserId: '7', deals: 2 },
        { bitrixUserId: '9', deals: 1 },
      ],
    });
    expect(view.counts.dead_letter).toBe(2);
    expect(JSON.stringify(view)).not.toContain('secretcode123');
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('loadIntegrationStatus reports staging as disabled even with enabled configuration', async () => {
    const from = vi.fn((name: string) => {
      if (name === 'integration_intake_config') return table({ data: [configRow] });
      if (name === 'deployment_settings') return table({ data: { environment: 'staging' } });
      return table({ data: [], count: 0 });
    });
    const { loadIntegrationStatus } = await import('@/modules/integration/server/queries');
    const view = await loadIntegrationStatus({ supabase: { from, rpc: autoSyncRpc } as never });
    expect(view).toMatchObject({ configured: false, environment: 'staging', enabledConfigCount: 1 });
  });

  it('loadIntegrationStatus: two enabled portals are not "configured"; short worker secret is not present', async () => {
    process.env.INTAKE_WORKER_SECRET = 'short';
    const from = vi.fn((name: string) =>
      name === 'integration_intake_config'
        ? table({ data: [configRow, { ...configRow, portal_member_id: 'OTHER', portal_domain: 'other.example.test' }] })
        : name === 'deployment_settings'
          ? table({ data: { environment: 'test' } })
          : table({ data: [], count: 0 }),
    );
    const { loadIntegrationStatus } = await import('@/modules/integration/server/queries');
    const view = await loadIntegrationStatus({ supabase: { from, rpc: autoSyncRpc } as never });
    expect(view).toMatchObject({ configured: false, enabledConfigCount: 2, workerSecretPresent: false, lastWorkerRunAt: null });
  });
});
