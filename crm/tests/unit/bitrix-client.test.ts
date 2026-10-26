import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIntegrationEnv } from '@/lib/config';
import { BitrixClientError, createBitrixClient, redact, type AllowedReadMethod } from '@/modules/integration/bitrix/client';
import { BitrixConfigError, resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/** Bitrix REST client and base-URL rules (contract §1; P2-07, P2-12, P2-13) against the in-process mock. */

let mock: MockBitrix;
const sleep = vi.fn(async () => undefined);

beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.deals.clear();
  mock.requests.length = 0;
  sleep.mockClear();
});

const client = (opts: { timeoutMs?: number } = {}) =>
  createBitrixClient({ target: resolveBitrixRestTarget(mock.baseUrl, 'synthetic.bitrix24.example', 'local'), sleep, ...opts });

function expectNoSecret(text: string) {
  expect(text).not.toContain(mock.webhookCode);
  expect(text).not.toContain(mock.baseUrl);
}

describe('resolveBitrixRestTarget (P2-12)', () => {
  const portal = 'tripnav.bitrix24.example';
  it('accepts https with the portal host and normalises the trailing slash', () => {
    expect(resolveBitrixRestTarget(`https://${portal}/rest/1/abcd1234`, portal, 'staging').baseUrl).toBe(
      `https://${portal}/rest/1/abcd1234/`,
    );
  });
  it.each([
    ['http (not https)', `http://${portal}/rest/1/abcd1234/`, 'insecure_url'],
    ['another host', 'https://evil.example/rest/1/abcd1234/', 'host_mismatch'],
    ['suffix trick', `https://${portal}.evil.example/rest/1/abcd1234/`, 'host_mismatch'],
    ['userinfo', `https://user:pw@${portal}/rest/1/abcd1234/`, 'invalid_url'],
    ['query string', `https://${portal}/rest/1/abcd1234/?x=1`, 'invalid_url'],
    ['not a webhook path', `https://${portal}/oauth/token/`, 'invalid_url'],
    ['odd port', `https://${portal}:8443/rest/1/abcd1234/`, 'host_mismatch'],
    ['garbage', 'not a url', 'invalid_url'],
  ])('rejects %s', (_label, url, code) => {
    try {
      resolveBitrixRestTarget(url, portal, 'staging');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BitrixConfigError);
      expect((error as BitrixConfigError).code).toBe(code);
      expect((error as Error).message).not.toContain('abcd1234');
    }
  });
  it('allows a loopback mock only for APP_ENV=local', () => {
    expect(() => resolveBitrixRestTarget(mock.baseUrl, portal, 'local')).not.toThrow();
    expect(() => resolveBitrixRestTarget(mock.baseUrl, portal, 'staging')).toThrow(BitrixConfigError);
    expect(() => resolveBitrixRestTarget(mock.baseUrl, portal, 'production')).toThrow(BitrixConfigError);
    expect(() => resolveBitrixRestTarget(mock.baseUrl, portal, undefined)).toThrow(BitrixConfigError);
  });
  it('missing credential is a distinct, value-free error', () => {
    expect(() => resolveBitrixRestTarget(null, portal, 'local')).toThrow(/missing/);
  });
  it('parseIntegrationEnv only trims and reports presence', () => {
    expect(parseIntegrationEnv({ BITRIX_WEBHOOK_BASE_URL: '  ', INTAKE_WORKER_SECRET: ' s ' })).toEqual({
      bitrixWebhookBaseUrl: null,
      bitrixEventApplicationToken: null,
      intakeWorkerSecret: 's',
      cronSecret: null,
    });
  });
});

describe('Bitrix REST client', () => {
  it('reads a deal through crm.deal.get', async () => {
    mock.deals.set('42', syntheticDeal(42));
    const res = await client().getDeal('42');
    expect(res).toMatchObject({ kind: 'ok', deal: { ID: '42', STAGE_ID: 'C7:WON' } });
    expect(mock.requests).toEqual([expect.objectContaining({ method: 'crm.deal.get', authorized: true, body: { id: '42' } })]);
  });

  it('maps the documented "Not found" answer to not_found', async () => {
    expect(await client().getDeal('404')).toEqual({ kind: 'not_found' });
  });

  it('only allow-listed read methods can be called; no write method exists', async () => {
    await expect(client().call('crm.deal.update' as AllowedReadMethod, { id: 1 })).rejects.toMatchObject({ code: 'internal_error' });
    await expect(client().call('crm.deal.add' as AllowedReadMethod)).rejects.toBeInstanceOf(BitrixClientError);
    expect(mock.requests).toHaveLength(0);
    expect(Object.keys(client())).not.toEqual(expect.arrayContaining(['updateDeal', 'addDeal']));
  });

  it('backs off and retries on 503 QUERY_LIMIT_EXCEEDED, then succeeds', async () => {
    mock.deals.set('7', syntheticDeal(7));
    mock.failNext('crm.deal.get', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } });
    mock.failNext('crm.deal.get', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } });
    expect((await client().getDeal('7')).kind).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(2);
    const [first, second] = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(second!).toBeGreaterThan(first! - 1_000); // exponential with jitter
  });

  it('gives up after bounded retries on 429 OPERATION_TIME_LIMIT -> provider_rate_limited', async () => {
    for (let i = 0; i < 4; i += 1) {
      mock.failNext('crm.deal.get', { status: 429, body: { error: 'OPERATION_TIME_LIMIT', error_description: 'blocked' } });
    }
    await expect(client().getDeal('7')).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ status: 500, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'x' } }, 'provider_unavailable'],
    [{ status: 502, raw: '<html>bad gateway</html>' }, 'provider_unavailable'],
    [{ status: 401, body: { error: 'INVALID_CREDENTIALS', error_description: 'x' } }, 'provider_auth_failed'],
    [{ status: 401, body: { error: 'insufficient_scope', error_description: 'x' } }, 'provider_auth_failed'],
    [{ status: 401, body: { error: 'OVERLOAD_LIMIT', error_description: 'x' } }, 'provider_unavailable'],
    [{ status: 200, raw: 'not json' }, 'provider_bad_response'],
    [{ status: 200, body: { result: 'string-not-object' } }, 'provider_bad_response'],
    [{ status: 302, raw: '', headers: { location: 'https://evil.example/steal' } }, 'provider_unavailable'],
  ])('maps %j to %s and never leaks the base URL', async (failure, code) => {
    mock.failNext('crm.deal.get', failure);
    const error = await client().getDeal('9').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BitrixClientError);
    expect((error as BitrixClientError).code).toBe(code);
    expectNoSecret(String((error as Error).message));
    expectNoSecret(JSON.stringify(error));
    expectNoSecret(String((error as Error).stack));
  });

  it('times out (provider_timeout) instead of hanging', async () => {
    mock.failNext('crm.deal.get', 'hang');
    await expect(client({ timeoutMs: 150 }).getDeal('9')).rejects.toMatchObject({ code: 'provider_timeout' });
  });

  it('unreachable provider -> provider_unavailable without the URL in the error', async () => {
    const c = createBitrixClient({
      target: { baseUrl: 'http://127.0.0.1:1/rest/1/secretcode999/', host: '127.0.0.1' },
      sleep,
    });
    const error = (await c.getDeal('1').catch((e: unknown) => e)) as BitrixClientError;
    expect(error.code).toBe('provider_unavailable');
    expect(`${error.message}${error.stack}`).not.toContain('secretcode999');
  });

  it('paginates crm.deal.list with start/next (page size 50)', async () => {
    for (let i = 1; i <= 120; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    const c = client();
    const p1 = await c.listDeals({ filter: {}, select: ['ID'], start: 0 });
    const p3 = await c.listDeals({ filter: {}, select: ['ID'], start: 100 });
    expect(p1.items).toHaveLength(50);
    expect(p1.next).toBe(50);
    expect(p3.items).toHaveLength(20);
    expect(p3.next).toBeNull();
    expect(p1.total).toBe(120);
  });

  it('redact() removes secrets and webhook-shaped paths', () => {
    expect(redact(`GET ${mock.baseUrl}crm.deal.get.json`, [mock.webhookCode])).not.toContain(mock.webhookCode);
    expect(redact('https://x.example/rest/12/abcDEF123/crm.deal.get', [])).toBe('https://x.example/rest/[redacted]/crm.deal.get');
  });
});
