import { describe, expect, it } from 'vitest';
import { DIRECTORY_CONCURRENCY, DirectoryStoppedError, listBitrixUsers, listPipelines, mapLimit } from '@/modules/integration/bitrix/directory';

/**
 * Speed plan F1: the Bitrix directory reads pipelines' stages and the two user
 * states at the same time, with a bounded number of requests in flight. The
 * answer must be the same as reading one after the other.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBitrix(delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const log: string[] = [];
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push(method);
    await sleep(delayMs);
    inFlight -= 1;
    const start = Number(params.start ?? 0);
    if (method === 'crm.category.list') return { result: { categories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `P${id}` })) }, next: null, total: null };
    if (method === 'crm.status.list') {
      const entity = (params.filter as { ENTITY_ID: string }).ENTITY_ID;
      // Two pages per pipeline, so paging inside one pipeline stays sequential.
      const page = [0, 1].map((i) => ({ STATUS_ID: `${entity}:${start + i}`, NAME: `S${start + i}`, SEMANTICS: start + i === 3 ? 'S' : null }));
      return { result: page, next: start === 0 ? 2 : null, total: 4 };
    }
    if (method === 'user.get') {
      const active = (params.FILTER as { ACTIVE: boolean }).ACTIVE;
      const all = Array.from({ length: active ? 75 : 10 }, (_, i) => ({
        ID: String((active ? 100 : 900) + i),
        NAME: `${active ? 'Active' : 'Former'} ${String(i).padStart(2, '0')}`,
        EMAIL: `u${i}@example.test`,
        ACTIVE: active,
      }));
      return { result: all.slice(start, start + 50), next: start + 50 < all.length ? start + 50 : null, total: all.length };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { client: { call } as never, log, maxInFlight: () => maxInFlight };
}

describe('Bitrix directory reads (speed plan F1)', () => {
  it('keeps pipeline order and every stage page, with at most DIRECTORY_CONCURRENCY requests in flight', async () => {
    const bitrix = fakeBitrix();
    const pipelines = await listPipelines(bitrix.client);
    expect(pipelines.map((p) => p.id)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    for (const p of pipelines) {
      const entity = p.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${p.id}`;
      expect(p.stages.map((s) => s.id)).toEqual([0, 1, 2, 3].map((n) => `${entity}:${n}`));
      expect(p.stages[3]!.kind).toBe('won');
    }
    expect(bitrix.maxInFlight()).toBeGreaterThan(1);
    expect(bitrix.maxInFlight()).toBeLessThanOrEqual(DIRECTORY_CONCURRENCY);
  });

  it('reads active and former users together and returns the same sorted list', async () => {
    const bitrix = fakeBitrix();
    const users = await listBitrixUsers(bitrix.client);
    expect(users).toHaveLength(85);
    expect(users.map((u) => u.name)).toEqual([...users.map((u) => u.name)].sort((a, b) => a.localeCompare(b)));
    expect(users.filter((u) => !u.active)).toHaveLength(10);
    expect(bitrix.log.filter((m) => m === 'user.get')).toHaveLength(3);
  });

  it('a failure still rejects the whole listing', async () => {
    const failing = { call: async (method: string) => {
      if (method === 'crm.status.list') throw new Error('provider_unavailable');
      return { result: { categories: [{ id: 1, name: 'P1' }] }, next: null, total: null };
    } } as never;
    await expect(listPipelines(failing)).rejects.toThrow('provider_unavailable');
  });

  it('mapLimit starts no new item after a rejection', async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
        started.push(n);
        await sleep(2);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    await sleep(20);
    // 1 and 2 start together; 2 fails; 3 may already have started from worker 1, nothing after.
    expect(started.length).toBeLessThanOrEqual(3);
  });

  it('a pipeline failure stops new stage reads; a users stop signal stops new user pages', async () => {
    const bitrix = fakeBitrix();
    let statusCalls = 0;
    const failing = {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'crm.status.list') {
          statusCalls += 1;
          await sleep(2);
          throw new Error('provider_unavailable');
        }
        return (bitrix.client as unknown as { call: (m: string, p: Record<string, unknown>) => Promise<unknown> }).call(method, params);
      },
    } as never;
    await expect(listPipelines(failing)).rejects.toThrow('provider_unavailable');
    await sleep(20);
    expect(statusCalls).toBeLessThanOrEqual(DIRECTORY_CONCURRENCY);

    const users = fakeBitrix();
    await expect(listBitrixUsers(users.client, { stopped: () => true })).rejects.toBeInstanceOf(DirectoryStoppedError);
    expect(users.log).toEqual([]);
  });

  it('mapLimit keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await sleep(n);
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(max).toBe(2);
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe('loadBitrixDirectory outcome (speed plan F1)', () => {
  it('a users failure keeps the pipelines; a pipelines failure shows neither', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const listPipelinesMock = vi.fn();
    const listUsersMock = vi.fn();
    vi.doMock('@/modules/integration/bitrix/directory', () => ({ listPipelines: listPipelinesMock, listBitrixUsers: listUsersMock }));
    vi.doMock('@/modules/integration/intake-config', () => ({
      INTAKE_CONFIG_COLUMNS: 'portal_domain',
      // B1.1d: the config read goes through selectIntakeConfig (legacy-column fallback).
      selectIntakeConfig: (select: (columns: string) => unknown) => select('portal_domain'),
      dealListingStageIds: () => [],
      parseIntakeConfigRow: () => ({ portalDomain: 'synthetic.example.test' }),
    }));
    vi.doMock('@/modules/integration/bitrix/config', async (orig) => ({
      ...(await orig<typeof import('@/modules/integration/bitrix/config')>()),
      getIntegrationEnv: () => ({ bitrixWebhookBaseUrl: 'http://127.0.0.1:1/rest/1/syntheticCode0001/' }),
      resolveBitrixRestTarget: () => ({ baseUrl: 'http://127.0.0.1:1/rest/1/syntheticCode0001/', host: '127.0.0.1' }),
    }));
    const { loadBitrixDirectory } = await import('@/modules/integration/server/bitrix-admin');
    const { BitrixClientError } = await import('@/modules/integration/bitrix/client');
    let configReads = 0;
    const staff = () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: async () => {
              configReads += 1;
              return { data: [{}], error: null };
            },
          }),
        }),
      },
    }) as never;

    listPipelinesMock.mockResolvedValue([{ id: '0', name: 'General', stages: [] }]);
    listUsersMock.mockRejectedValue(new BitrixClientError('provider_auth_failed', 401));
    const partial = await loadBitrixDirectory(staff(), { pipelines: true, users: true });
    expect(partial.pipelines).toEqual([{ id: '0', name: 'General', stages: [] }]);
    expect(partial.users).toBeNull();
    expect(partial.error).toMatch(/Users \(user\)/);

    listPipelinesMock.mockRejectedValue(new BitrixClientError('provider_timeout'));
    let stopSeen: boolean | null = null;
    listUsersMock.mockImplementation(async (_client: unknown, options: { stopped: () => boolean }) => {
      await new Promise((r) => setTimeout(r, 5));
      stopSeen = options.stopped();
      return [{ id: '1', name: 'Synthetic', email: null, active: true }];
    });
    const failed = await loadBitrixDirectory(staff(), { pipelines: true, users: true });
    expect(failed).toEqual({ pipelines: null, users: null, error: 'Bitrix could not be reached. Try again in a minute.' });
    // Once the pipelines failed, the users listing is told to start no new page.
    expect(stopSeen).toBe(true);
    listUsersMock.mockReset();
    listUsersMock.mockResolvedValue([{ id: '1', name: 'Synthetic', email: null, active: true }]);

    listPipelinesMock.mockResolvedValue([]);
    const usersOnly = await loadBitrixDirectory(staff(), { users: true });
    expect(usersOnly).toEqual({ pipelines: null, users: [{ id: '1', name: 'Synthetic', email: null, active: true }], error: null });
    expect(configReads).toBe(3);
    vi.doUnmock('@/modules/integration/bitrix/directory');
    vi.doUnmock('@/modules/integration/intake-config');
    vi.doUnmock('@/modules/integration/bitrix/config');
  });
});
