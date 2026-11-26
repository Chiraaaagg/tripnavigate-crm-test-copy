import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest, type WorkerEndpointDeps } from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient } from '@/modules/integration/commands';
import {
  alertEmailConfig,
  buildAlertEmail,
  isAlertEmailConfigured,
  RESEND_ENDPOINT,
  runSyncAlerts,
} from '@/modules/integration/sync-alerts';

/**
 * Sync completion §4 / §7: sync-stopped alert emails and the worker's
 * `?task=health` flow, with the database commands mocked. Synthetic values only.
 */

const API_KEY = 're_synthetic_key_0123456789abcdef';
const FROM = 'CRM Alerts <alerts@crm.example.test>';
const RECIPIENTS = ['admin.one@crm.example.test', 'admin.two@crm.example.test'];
const INCIDENT = '00000000-0000-4000-8000-0000000000c1';
const SECRET = 'synthetic-worker-secret-0123456789abcdef';
const ENV = { RESEND_API_KEY: API_KEY, SYNC_ALERT_FROM: FROM, NEXT_PUBLIC_SITE_URL: 'https://crm.example.test/' };

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

let calls: Array<{ fn: string; args: Record<string, unknown> | undefined }>;
let handlers: Record<string, (args: Record<string, unknown> | undefined) => RpcAnswer>;
const rpc = () =>
  asRpcClient({
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      return handler ? handler(args) : { data: null, error: { code: 'XX000' } };
    },
  });

const stopped = {
  incidentId: INCIDENT,
  kind: 'stopped',
  openedAt: '2026-10-08T08:00:00Z',
  recoveredAt: null,
  reasonCode: 'no_successful_run',
  recipients: RECIPIENTS,
};

let fetchSpy: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn<(line: string) => void>>;

beforeEach(() => {
  calls = [];
  handlers = {
    integration_sync_alert_check: () => ({ data: { send: [stopped], emailRecipientsCount: 2 }, error: null }),
    integration_sync_alert_mark_sent: () => ({ data: null, error: null }),
  };
  fetchSpy = vi.fn(async () => new Response('{"id":"synthetic"}', { status: 200 }));
  log = vi.fn();
});

const marks = () => calls.filter((c) => c.fn === 'integration_sync_alert_mark_sent').map((c) => c.args);

describe('email sender settings', () => {
  it('is not set up unless both RESEND_API_KEY and SYNC_ALERT_FROM are present', () => {
    expect(alertEmailConfig({})).toBeNull();
    expect(alertEmailConfig({ RESEND_API_KEY: API_KEY })).toBeNull();
    expect(alertEmailConfig({ SYNC_ALERT_FROM: FROM })).toBeNull();
    expect(alertEmailConfig({ RESEND_API_KEY: '  ', SYNC_ALERT_FROM: FROM })).toBeNull();
    expect(isAlertEmailConfigured({})).toBe(false);
    expect(isAlertEmailConfigured(ENV)).toBe(true);
    expect(alertEmailConfig(ENV)?.adminUrl).toBe('https://crm.example.test/app/admin/integration');
    expect(alertEmailConfig({ ...ENV, NEXT_PUBLIC_SITE_URL: 'not a url' })?.adminUrl).toBeNull();
  });

  it('builds the plain subjects and text from the contract, with the admin link and no secrets', () => {
    const down = buildAlertEmail(stopped as never, 'https://crm.example.test/app/admin/integration');
    expect(down.subject).toBe('TripNavigate CRM: Bitrix sync stopped');
    expect(down.text).toContain('https://crm.example.test/app/admin/integration');
    expect(down.text).toContain('IST');
    const up = buildAlertEmail(
      { ...stopped, kind: 'recovered', recoveredAt: '2026-10-08T09:30:00Z' } as never,
      null,
    );
    expect(up.subject).toBe('TripNavigate CRM: Bitrix sync working again');
    expect(up.text).toContain('Bitrix sync page');
    for (const text of [down.text, up.text, down.subject, up.subject]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toMatch(/npm run|local:up/);
    }
  });
});

describe('runSyncAlerts', () => {
  it('without the variables sends nothing, marks nothing and logs nothing', async () => {
    const summary = await runSyncAlerts({ rpc: rpc(), env: {}, fetchImpl: fetchSpy as never, log });
    expect(summary).toMatchObject({ pending: 1, sent: 0, skipped: 1, emailConfigured: false, checkFailed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(marks()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('sends through the Resend HTTP API, then marks the incident once', async () => {
    const summary = await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log });
    expect(summary).toMatchObject({ pending: 1, sent: 1, failed: 0, emailConfigured: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ from: FROM, to: RECIPIENTS, subject: 'TripNavigate CRM: Bitrix sync stopped' });
    expect(typeof body.text).toBe('string');
    expect(marks()).toEqual([{ p_incident: INCIDENT, p_kind: 'stopped' }]);
  });

  it('a refused send is not marked (retried next run) and its log line has no key or recipients', async () => {
    fetchSpy.mockResolvedValue(new Response(`{"message":"bad key ${API_KEY}"}`, { status: 401 }));
    const summary = await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log });
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(marks()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ fn: 'sync-alert', code: 'send_failed', kind: 'stopped', reason: 'http_error', status: 401 });
    expect(line).not.toContain(API_KEY);
    for (const r of RECIPIENTS) expect(line).not.toContain(r);
  });

  it('a network error whose message carries the key is reduced to a fixed code', async () => {
    fetchSpy.mockRejectedValue(new Error(`connect failed for Bearer ${API_KEY} to ${RECIPIENTS[0]}`));
    const summary = await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log });
    expect(summary.failed).toBe(1);
    const everything = JSON.stringify([summary, log.mock.calls]);
    expect(everything).not.toContain(API_KEY);
    for (const r of RECIPIENTS) expect(everything).not.toContain(r);
    expect(marks()).toEqual([]);
  });

  it('an incident with no recipients is left unmarked and nothing is sent', async () => {
    handlers.integration_sync_alert_check = () => ({ data: { send: [{ ...stopped, recipients: [] }], emailRecipientsCount: 0 }, error: null });
    const summary = await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log });
    expect(summary).toMatchObject({ skipped: 1, sent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(marks()).toEqual([]);
  });

  it('a failed or malformed check never throws', async () => {
    handlers.integration_sync_alert_check = () => ({ data: null, error: { code: '42501' } });
    expect((await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log })).checkFailed).toBe(true);
    handlers.integration_sync_alert_check = () => ({ data: { send: 'nope' }, error: null });
    expect((await runSyncAlerts({ rpc: rpc(), env: ENV, fetchImpl: fetchSpy as never, log })).checkFailed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('worker endpoint: ?task=health and the post-run check', () => {
  const loadConfigRows = vi.fn(async () => [] as unknown[]);
  const deps = (over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps => ({
    env: { bitrixWebhookBaseUrl: null, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    vercelEnv: undefined,
    trigger: 'manual',
    loadConfigRows,
    rpc,
    alerts: { env: ENV, fetchImpl: fetchSpy as never, log },
    ...over,
  });
  const request = (query: string, auth = `Bearer ${SECRET}`) =>
    new Request(`https://crm.example.test/api/integrations/bitrix/worker${query}`, {
      method: 'POST',
      headers: { authorization: auth },
    });

  beforeEach(() => loadConfigRows.mockClear());

  it('check -> send -> mark, counts only, without reading the Bitrix configuration', async () => {
    const res = await handleWorkerRequest(request('?task=health'), deps());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ pending: 1, sent: 1, failed: 0, skipped: 0, emailConfigured: true, checkFailed: false });
    expect(calls.map((c) => c.fn)).toEqual(['integration_sync_alert_check', 'integration_sync_alert_mark_sent']);
    expect(loadConfigRows).not.toHaveBeenCalled();
    expect(body).not.toContain(API_KEY);
    for (const r of RECIPIENTS) expect(body).not.toContain(r);
  });

  it('answers 503 when the check fails, and still needs the bearer', async () => {
    handlers.integration_sync_alert_check = () => ({ data: null, error: { code: 'XX000' } });
    expect((await handleWorkerRequest(request('?task=health'), deps())).status).toBe(503);
    expect((await handleWorkerRequest(request('?task=health', 'Bearer wrong'), deps())).status).toBe(401);
    expect(calls.filter((c) => c.fn === 'integration_sync_alert_check')).toHaveLength(1);
  });

  it('after a run, the alert check is scheduled (not awaited) and runs when the task fires', async () => {
    loadConfigRows.mockResolvedValue([
      {
        portal_domain: 'synthetic.bitrix24.example',
        portal_member_id: 'synthetic-member-0001',
        category_id: '7',
        eligible_stage_ids: ['C7:WON'],
        cutoff_at: '2026-10-01T00:00:00+05:30',
        pilot_legal_entity_id: null,
        pilot_branch_id: null,
        enabled: true,
      },
    ]);
    handlers.integration_claim_inbox = () => ({ data: [], error: null });
    handlers.integration_record_worker_run = () => ({ data: null, error: null });
    const scheduled: Array<() => Promise<void>> = [];
    const env = {
      bitrixWebhookBaseUrl: 'http://127.0.0.1:9/rest/1/synthetichook/',
      bitrixEventApplicationToken: null,
      intakeWorkerSecret: SECRET,
      cronSecret: null,
    };
    const res = await handleWorkerRequest(request('?limit=1'), deps({ env, schedule: (t) => scheduled.push(t) }));
    expect(res.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    expect(calls.some((c) => c.fn === 'integration_sync_alert_check')).toBe(false);
    await scheduled[0]!();
    expect(calls.filter((c) => c.fn === 'integration_sync_alert_check')).toHaveLength(1);
    expect(marks()).toEqual([{ p_incident: INCIDENT, p_kind: 'stopped' }]);
  });

  it('a failing run still runs the check, and the check cannot change the run answer', async () => {
    loadConfigRows.mockResolvedValue([
      {
        portal_domain: 'synthetic.bitrix24.example',
        portal_member_id: 'synthetic-member-0001',
        category_id: '7',
        eligible_stage_ids: ['C7:WON'],
        cutoff_at: '2026-10-01T00:00:00+05:30',
        pilot_legal_entity_id: null,
        pilot_branch_id: null,
        enabled: true,
      },
    ]);
    handlers.integration_claim_inbox = () => ({ data: null, error: { code: 'XX000' } });
    handlers.integration_sync_alert_check = () => {
      throw new Error('alert check exploded');
    };
    const env = {
      bitrixWebhookBaseUrl: 'http://127.0.0.1:9/rest/1/synthetichook/',
      bitrixEventApplicationToken: null,
      intakeWorkerSecret: SECRET,
      cronSecret: null,
    };
    // No schedule: the check runs inline after the run and its failure is swallowed.
    const res = await handleWorkerRequest(request('?limit=1'), deps({ env }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(calls.some((c) => c.fn === 'integration_sync_alert_check')).toBe(true);
  });
});
