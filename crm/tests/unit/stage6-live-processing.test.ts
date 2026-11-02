import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationEnv } from '@/lib/config';
import { LIVE_BATCH_LIMIT, liveBatchDecision, runLiveBatch, type LiveBatchDeps } from '@/modules/integration/bitrix/live';
import { handleBitrixEvent, type ReceiverDeps } from '@/modules/integration/bitrix/receiver';
import { toDealSnapshot, toLeadIdText } from '@/modules/integration/bitrix/deal';
import { asRpcClient, type RecordedEvent } from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';

/**
 * Sync completion §1 (live processing of push events) and §3/§7 (Deal snapshot
 * leadId). Synthetic data only.
 */

const TOKEN = 'synthetic-application-token-0123456789';
const MEMBER = 'synthetic-member-0001';
const DOMAIN = 'synthetic.bitrix24.example';
const INBOX = '00000000-0000-4000-8000-0000000000a1';

const configRow = {
  portal_domain: DOMAIN,
  portal_member_id: MEMBER,
  category_id: '7',
  eligible_stage_ids: ['C7:WON'],
  cutoff_at: '2026-10-01T00:00:00+05:30',
  pilot_legal_entity_id: null,
  pilot_branch_id: null,
  enabled: true,
};

const config: IntakeConfig = {
  portalDomain: DOMAIN,
  portalMemberId: MEMBER,
  categoryId: '7',
  categoryIds: ['7'],
  eligibleStageIds: ['C7:WON'],
  cutoffAt: '2026-10-01T00:00:00+05:30',
  pilotLegalEntityId: null,
  pilotBranchId: null,
  enabled: true,
  lastReconciledAt: null,
};

const env: IntegrationEnv = {
  bitrixEventApplicationToken: TOKEN,
  bitrixWebhookBaseUrl: null,
  intakeWorkerSecret: null,
  cronSecret: null,
};

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

function eventRequest(token = TOKEN): Request {
  return new Request('https://crm.example.test/api/integrations/bitrix/events', {
    method: 'POST',
    body: new URLSearchParams({
      event: 'ONCRMDEALUPDATE',
      'data[FIELDS][ID]': '662',
      ts: '1759700000',
      'auth[domain]': DOMAIN,
      'auth[member_id]': MEMBER,
      'auth[application_token]': token,
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

function receiverDeps(answer: RpcAnswer, afterRecord?: ReceiverDeps['afterRecord']): ReceiverDeps {
  return {
    env,
    loadConfigRows: async () => [configRow],
    rpc: () => asRpcClient({ rpc: async () => answer }),
    afterRecord,
  };
}

describe('receiver: live batch hook (§1)', () => {
  it('passes the recorded row (with its status) and the active config to afterRecord, then answers 200', async () => {
    const afterRecord = vi.fn();
    const res = await handleBitrixEvent(
      eventRequest(),
      receiverDeps({ data: { inboxId: INBOX, duplicate: false, status: 'pending' }, error: null }, afterRecord),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(afterRecord).toHaveBeenCalledTimes(1);
    expect(afterRecord.mock.calls[0]![0]).toEqual({ inboxId: INBOX, duplicate: false, status: 'pending' });
    expect(afterRecord.mock.calls[0]![1]).toMatchObject({ portalMemberId: MEMBER, portalDomain: DOMAIN });
  });

  it('the response is identical when the hook throws or is absent', async () => {
    const answer = { data: { inboxId: INBOX, duplicate: false, status: 'pending' }, error: null };
    const plain = await handleBitrixEvent(eventRequest(), receiverDeps(answer));
    const throwing = await handleBitrixEvent(
      eventRequest(),
      receiverDeps(answer, () => {
        throw new Error('scheduling failed');
      }),
    );
    expect(throwing.status).toBe(plain.status);
    expect(await throwing.text()).toBe(await plain.text());
    expect([...throwing.headers.entries()]).toEqual([...plain.headers.entries()]);
  });

  it('never calls the hook when nothing was recorded (401, 503)', async () => {
    const afterRecord = vi.fn();
    expect((await handleBitrixEvent(eventRequest('wrong-token-value'), receiverDeps({ data: null, error: null }, afterRecord))).status).toBe(401);
    const refused = receiverDeps({ data: null, error: { code: '55000', message: 'not_configured' } }, afterRecord);
    expect((await handleBitrixEvent(eventRequest(), refused)).status).toBe(503);
    expect(afterRecord).not.toHaveBeenCalled();
  });

  it('an older database without status still records and answers 200', async () => {
    const afterRecord = vi.fn();
    const res = await handleBitrixEvent(eventRequest(), receiverDeps({ data: { inboxId: INBOX, duplicate: true }, error: null }, afterRecord));
    expect(res.status).toBe(200);
    expect(afterRecord.mock.calls[0]![0]).toEqual({ inboxId: INBOX, duplicate: true });
  });
});

describe('liveBatchDecision', () => {
  it('runs only for pending rows; unknown without a status', () => {
    expect(liveBatchDecision({ status: 'pending' })).toBe('run');
    for (const status of ['ignored', 'processing', 'processed', 'needs_review', 'failed', 'dead_letter'] as const) {
      expect(liveBatchDecision({ status })).toBe('skip');
    }
    expect(liveBatchDecision({})).toBe('unknown');
  });
});

describe('runLiveBatch', () => {
  let calls: Array<{ fn: string; args: Record<string, unknown> | undefined }>;
  let handlers: Record<string, (args: Record<string, unknown> | undefined) => RpcAnswer>;
  const bitrix = {
    getDeal: vi.fn(),
    getLead: vi.fn(),
    listDeals: vi.fn(),
  };

  beforeEach(() => {
    calls = [];
    handlers = {
      integration_claim_inbox: () => ({ data: [], error: null }),
      integration_record_worker_run: () => ({ data: { id: '00000000-0000-4000-8000-0000000000b1' }, error: null }),
    };
    vi.clearAllMocks();
  });

  const deps = (over: Partial<LiveBatchDeps> = {}): LiveBatchDeps => ({
    env,
    appEnv: 'local',
    vercelEnv: undefined,
    config,
    recorded: { inboxId: INBOX, duplicate: false, status: 'pending' } as RecordedEvent,
    rpc: () =>
      asRpcClient({
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          calls.push({ fn, args });
          const handler = handlers[fn];
          return handler ? handler(args) : { data: null, error: { code: 'XX000' } };
        },
      }),
    bitrix,
    now: () => Date.parse('2026-10-08T10:00:00Z'),
    ...over,
  });

  it('claims at most 5 items and records the run with trigger event', async () => {
    const result = await runLiveBatch(deps());
    expect(result.ran).toBe(true);
    expect(calls[0]).toEqual({ fn: 'integration_claim_inbox', args: { p_limit: LIVE_BATCH_LIMIT, p_lease_seconds: 120 } });
    expect(LIVE_BATCH_LIMIT).toBe(5);
    const run = calls.find((c) => c.fn === 'integration_record_worker_run')!.args!.p_run as Record<string, unknown>;
    expect(run).toMatchObject({ kind: 'worker', outcome: 'ok', trigger: 'event' });
  });

  it('a failing batch never throws and is recorded as a failed event run', async () => {
    handlers.integration_claim_inbox = () => ({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(runLiveBatch(deps())).resolves.toEqual({ ran: false, reason: 'failed' });
    const run = calls.find((c) => c.fn === 'integration_record_worker_run')!.args!.p_run as Record<string, unknown>;
    expect(run).toMatchObject({ kind: 'worker', outcome: 'internal_error', trigger: 'event' });
  });

  it('retries the heartbeat without the trigger when the database refuses the key (22023)', async () => {
    handlers.integration_record_worker_run = (args) =>
      (args!.p_run as Record<string, unknown>).trigger
        ? { data: null, error: { code: '22023', message: 'unknown run field' } }
        : { data: { id: '00000000-0000-4000-8000-0000000000b1' }, error: null };
    await runLiveBatch(deps());
    const runs = calls.filter((c) => c.fn === 'integration_record_worker_run').map((c) => c.args!.p_run as Record<string, unknown>);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.trigger).toBe('event');
    expect('trigger' in runs[1]!).toBe(false);
  });

  it('does nothing for a row that is not pending', async () => {
    const result = await runLiveBatch(deps({ recorded: { inboxId: INBOX, duplicate: true, status: 'ignored' } }));
    expect(result).toEqual({ ran: false, reason: 'not_pending' });
    expect(calls).toEqual([]);
  });

  it('without a status, looks the row up and runs only when it is pending', async () => {
    const inboxStatus = vi.fn(async () => 'processed' as const);
    const recorded = { inboxId: INBOX, duplicate: true };
    expect(await runLiveBatch(deps({ recorded, inboxStatus }))).toEqual({ ran: false, reason: 'not_pending' });
    expect(inboxStatus).toHaveBeenCalledWith(INBOX);
    expect(calls).toEqual([]);

    inboxStatus.mockResolvedValue('pending' as never);
    expect((await runLiveBatch(deps({ recorded, inboxStatus }))).ran).toBe(true);
  });

  it('never runs on a Preview or unknown runtime', async () => {
    expect(await runLiveBatch(deps({ appEnv: 'staging', vercelEnv: 'preview' }))).toEqual({ ran: false, reason: 'not_configured' });
    expect(await runLiveBatch(deps({ appEnv: undefined }))).toEqual({ ran: false, reason: 'not_configured' });
    expect(calls).toEqual([]);
  });

  it('without a Bitrix REST URL it stops before any database call', async () => {
    expect(await runLiveBatch(deps({ bitrix: undefined }))).toEqual({ ran: false, reason: 'not_configured' });
    expect(calls).toEqual([]);
  });
});

describe('events route: after() scheduling (runtime wiring)', () => {
  const afterSpy = vi.fn();
  const adminRpc = vi.fn();
  const inboxRead = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.BITRIX_EVENT_APPLICATION_TOKEN = TOKEN;
    process.env.APP_ENV = 'local';
    delete process.env.VERCEL_ENV;
    delete process.env.BITRIX_WEBHOOK_BASE_URL;
    vi.doMock('next/server', () => ({ after: (task: () => unknown) => afterSpy(task) }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createSupabaseAdminClient: () => ({
        rpc: adminRpc,
        from: (name: string) => {
          const chain: Record<string, unknown> = {};
          for (const m of ['select', 'eq']) chain[m] = () => chain;
          chain.maybeSingle = async () => inboxRead(name);
          chain.then = (resolve: (v: unknown) => void) => resolve({ data: name === 'integration_intake_config' ? [configRow] : [], error: null });
          return chain;
        },
      }),
    }));
  });
  afterEach(() => {
    vi.doUnmock('next/server');
    vi.doUnmock('@/lib/supabase/admin');
    delete process.env.BITRIX_EVENT_APPLICATION_TOKEN;
    delete process.env.APP_ENV;
  });

  async function post(): Promise<Response> {
    const { POST } = await import('@/app/api/integrations/bitrix/events/route');
    return POST(eventRequest());
  }

  it('a pending row schedules exactly one batch; the 200 does not wait for it', async () => {
    adminRpc.mockResolvedValue({ data: { inboxId: INBOX, duplicate: false, status: 'pending' }, error: null });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(afterSpy).toHaveBeenCalledTimes(1);
    // Only the record call happened before the answer; the batch is still just a scheduled callback.
    expect(adminRpc.mock.calls.map((c) => c[0])).toEqual(['integration_record_bitrix_event']);
  });

  it('an ignored or already-handled row schedules nothing', async () => {
    adminRpc.mockResolvedValue({ data: { inboxId: INBOX, duplicate: false, status: 'ignored' }, error: null });
    expect((await post()).status).toBe(200);
    adminRpc.mockResolvedValue({ data: { inboxId: INBOX, duplicate: true, status: 'processed' }, error: null });
    expect((await post()).status).toBe(200);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it('a scheduled batch whose database claim fails resolves quietly and records a failed event run', async () => {
    // Loopback REST URL (accepted with APP_ENV=local): the batch really starts and reaches the claim.
    process.env.BITRIX_WEBHOOK_BASE_URL = 'http://127.0.0.1:9/rest/1/synthetichook/';
    adminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'integration_record_bitrix_event') return { data: { inboxId: INBOX, duplicate: false, status: 'pending' }, error: null };
      if (fn === 'integration_claim_inbox') throw new Error('database down');
      return { data: { id: '00000000-0000-4000-8000-0000000000b1' }, error: null };
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const task = afterSpy.mock.calls[0]![0] as () => Promise<unknown>;
    await expect(task()).resolves.toBeUndefined();
    const fns = adminRpc.mock.calls.map((c) => c[0]);
    expect(fns).toEqual(['integration_record_bitrix_event', 'integration_claim_inbox', 'integration_record_worker_run']);
    expect(adminRpc.mock.calls[1]![1]).toEqual({ p_limit: 5, p_lease_seconds: 120 });
    expect((adminRpc.mock.calls[2]![1] as { p_run: Record<string, unknown> }).p_run).toMatchObject({
      kind: 'worker',
      outcome: 'internal_error',
      trigger: 'event',
    });
  });

  it('after() unavailable (outside a request scope) still answers 200', async () => {
    afterSpy.mockImplementation(() => {
      throw new Error('after() called outside a request scope');
    });
    adminRpc.mockResolvedValue({ data: { inboxId: INBOX, duplicate: false, status: 'pending' }, error: null });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('Deal snapshot leadId (§3, §7)', () => {
  it('reads Bitrix LEAD_ID as digits; empty, 0 and junk become empty', () => {
    expect(toLeadIdText('4521')).toBe('4521');
    expect(toLeadIdText(4521)).toBe('4521');
    expect(toLeadIdText(' 77 ')).toBe('77');
    for (const value of ['', '0', 0, null, undefined, '-3', '12a', '1.5', 1.5, '007', {}, '12345678901234567']) {
      expect(toLeadIdText(value)).toBe('');
    }
  });

  it('is part of the apply payload', () => {
    const base = {
      ID: '9411',
      TITLE: 'Synthetic trip',
      STAGE_ID: 'C7:NEW',
      CATEGORY_ID: '7',
      ASSIGNED_BY_ID: '12',
      DATE_CREATE: '2026-10-02T10:00:00+05:30',
      DATE_MODIFY: '2026-10-02T11:00:00+05:30',
    };
    expect(toDealSnapshot({ ...base, LEAD_ID: '501' }).leadId).toBe('501');
    expect(toDealSnapshot({ ...base, LEAD_ID: '0' }).leadId).toBe('');
    expect(toDealSnapshot({ ...base, LEAD_ID: null }).leadId).toBe('');
    expect(toDealSnapshot(base).leadId).toBe('');
  });
});
