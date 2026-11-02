import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expectOwnerOnlyMode } from '../helpers/file-mode';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_FILTER_KEYS,
  ACTIVITY_SELECT,
  checkWebhookShape,
  createReadOnlyCaller,
  DEAL_SELECT,
  DIAGNOSIS,
  diagnoseWebhook,
  inspectPilot,
  PILOT_READ_METHODS,
  PilotInspectError,
} from '../../scripts/bitrix-pilot-inspect.mjs';
import { startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * scripts/bitrix-pilot-inspect.mjs: read-only allow-list, minimal selects,
 * no customer or personal content kept, rate spacing, credential never printed.
 * Runs only against the in-process mock Bitrix (synthetic data).
 */

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '..', 'scripts', 'bitrix-pilot-inspect.mjs');
const NOW = Date.parse('2026-10-06T00:00:00Z');
let mock: MockBitrix;

beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.requests.length = 0;
  mock.deals.clear();
  mock.deals.set('1', syntheticDeal(1, { TITLE: 'Synthetic customer content must not appear', DATE_CREATE: '2026-10-02T10:00:00+05:30' }));
  mock.deals.set('2', syntheticDeal(2, { STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: '502', DATE_CREATE: '2026-10-03T10:00:00+05:30', COMMENTS: 'synthetic comment' }));
  mock.deals.set('3', syntheticDeal(3, { DATE_CREATE: '2026-01-01T10:00:00+05:30' })); // older than the window
});

const noSleep = async () => undefined;

describe('inspectPilot', () => {
  it('collects categories, stages, field check, recent counts and assignees without content', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    const report = await inspectPilot(caller, { portalHost: 'synthetic.bitrix24.example', sinceDays: 30, now: () => NOW });

    const c7 = report.categories.find((c) => c.id === '7')!;
    expect(c7.dealTotal).toBe(3);
    expect(c7.recent.count).toBe(2);
    expect(c7.recent.byStage).toEqual({ 'C7:WON': 1, 'C7:NEW': 1 });
    expect(c7.recent.byAssignee).toEqual({ '501': 1, '502': 1 });
    expect(c7.recent.newestDealIds).toEqual(['2', '1']);
    expect(report.assignees).toEqual([
      { id: '501', active: true, departmentIds: ['11'] },
      { id: '502', active: false, departmentIds: ['12'] },
    ]);
    expect(report.departments).toEqual([
      { id: '11', name: 'Synthetic Branch A', parent: '1' },
      { id: '12', name: 'Synthetic Branch B', parent: '1' },
    ]);
    expect(report.webhook).toEqual({ scope: ['crm', 'department', 'user_brief'], license: 'synthetic' });
    expect(report.webhookOwner).toEqual({ id: '1', admin: true });
    expect(report.memberId.obtainable).toBe(false);
    expect(report.fieldCheck.find((f) => f.code === 'TITLE')).toMatchObject({ present: true, ok: true });
    expect(report.fieldCheck.find((f) => f.code === 'STAGE_ID')).toMatchObject({ present: false, ok: false });

    const text = JSON.stringify(report);
    for (const forbidden of ['Synthetic customer content', 'synthetic comment', '99999', 'Synthetic Person', 'synthetic@example.test', '+10000000000', 'Synthetic Owner', mock.webhookCode]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('calls allow-listed read methods only, with minimal selects', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    await inspectPilot(caller, { portalHost: 'h', now: () => NOW });
    for (const r of mock.requests) {
      expect(PILOT_READ_METHODS).toContain(r.method);
      expect(r.method).not.toMatch(/\.(add|update|delete|bind|unbind)$|^event\./);
      if (r.method === 'crm.deal.list') {
        for (const f of r.body.select as string[]) expect(DEAL_SELECT).toContain(f);
      }
      if (r.method === 'user.get') expect(r.body.select).toEqual(['ID', 'ACTIVE', 'UF_DEPARTMENT']);
    }
    expect(mock.requests.some((r) => r.method === 'crm.deal.get')).toBe(false);
  });

  it('refuses write methods and wide selects before any request', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    await expect(caller.call('crm.deal.update', { id: 1 })).rejects.toBeInstanceOf(PilotInspectError);
    await expect(caller.call('event.bind', {})).rejects.toBeInstanceOf(PilotInspectError);
    await expect(caller.call('crm.deal.list', { select: ['ID', 'TITLE'] })).rejects.toThrow(/select outside/);
    await expect(caller.call('crm.deal.list', { select: ['*'] })).rejects.toThrow(/select outside/);
    await expect(caller.call('user.get', { select: ['NAME'] })).rejects.toThrow(/select outside/);
    await expect(caller.call('user.get', {})).rejects.toThrow(/select outside/);
    expect(mock.requests).toHaveLength(0);
  });

  it('allows crm.activity.list only with the provenance select and OWNER_TYPE_ID/OWNER_ID equality filter', async () => {
    expect(PILOT_READ_METHODS).toEqual(expect.arrayContaining(['crm.activity.list', 'crm.activity.fields']));
    expect([...ACTIVITY_SELECT]).toEqual(['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'CREATED']);
    expect([...ACTIVITY_FILTER_KEYS]).toEqual(['OWNER_TYPE_ID', 'OWNER_ID']);
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    const filter = { OWNER_TYPE_ID: 1, OWNER_ID: '1' };
    for (const select of [['ID', 'SUBJECT'], ['ID', 'DESCRIPTION'], ['ID', 'COMMUNICATIONS'], ['ID', 'FILES'], ['*'], [], undefined]) {
      await expect(caller.call('crm.activity.list', { filter, select })).rejects.toThrow('crm.activity.list select outside the allow-list');
    }
    for (const bad of [undefined, {}, [], { OWNER_TYPE_ID: 1, '>OWNER_ID': 1 }, { OWNER_TYPE_ID: 1, OWNER_ID: [1, 2] }, { OWNER_TYPE_ID: 1, OWNER_ID: null }, { OWNER_TYPE_ID: 1, PROVIDER_ID: 'CRM_WEBFORM' }]) {
      await expect(caller.call('crm.activity.list', { filter: bad, select: ['ID'] })).rejects.toThrow('crm.activity.list filter outside the allow-list');
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('crm.activity.list filter needs exactly OWNER_TYPE_ID = 1 and a positive integer OWNER_ID', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    const refused = [
      { OWNER_ID: '1' }, // OWNER_TYPE_ID missing
      { OWNER_TYPE_ID: 1 }, // OWNER_ID missing
      { OWNER_TYPE_ID: '1', OWNER_ID: '1' }, // type as string
      { OWNER_TYPE_ID: 2, OWNER_ID: '1' }, // not a Lead
      { OWNER_TYPE_ID: 1, OWNER_ID: '0' },
      { OWNER_TYPE_ID: 1, OWNER_ID: 0 },
      { OWNER_TYPE_ID: 1, OWNER_ID: -5 },
      { OWNER_TYPE_ID: 1, OWNER_ID: 1.5 },
      { OWNER_TYPE_ID: 1, OWNER_ID: '01' },
      { OWNER_TYPE_ID: 1, OWNER_ID: '1,2' },
      { OWNER_TYPE_ID: 1, OWNER_ID: '' },
      { OWNER_TYPE_ID: 1, OWNER_ID: '%' },
      { OWNER_TYPE_ID: 1, OWNER_ID: '99999999999999999' },
      { OWNER_TYPE_ID: 1, OWNER_ID: '1', ID: '1' },
    ];
    for (const filter of refused) {
      await expect(caller.call('crm.activity.list', { filter, select: ['ID'] })).rejects.toThrow('crm.activity.list filter outside the allow-list');
    }
    expect(mock.requests).toHaveLength(0);
    // The exact selection-script shape passes the allow-list (string or number OWNER_ID).
    for (const OWNER_ID of ['900001', 900001]) {
      await caller.call('crm.activity.list', { filter: { OWNER_TYPE_ID: 1, OWNER_ID }, select: ['ID', 'OWNER_ID'] }).catch((e: unknown) => {
        expect(String(e)).not.toMatch(/outside the allow-list|not allowed/);
      });
    }
  });

  it('refuses crm.activity write and get methods', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    await expect(caller.call('crm.activity.add', {})).rejects.toThrow(/not allowed/);
    await expect(caller.call('crm.activity.get', { id: 1 })).rejects.toThrow(/not allowed/);
    expect(mock.requests).toHaveLength(0);
  });

  it('spaces calls and retries a rate-limit answer once', async () => {
    let t = 0;
    const waits: number[] = [];
    const caller = createReadOnlyCaller(mock.baseUrl, {
      minIntervalMs: 600,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    mock.failNext('server.time', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } });
    await caller.call('profile');
    await caller.call('server.time');
    expect(waits[0]).toBe(600);
    expect(waits).toContain(2400);
    expect(mock.requests.filter((r) => r.method === 'server.time')).toHaveLength(2);
  });

  it('reports a failing optional method without aborting; credentials errors carry no URL', async () => {
    mock.failNext('user.get', { status: 401, body: { error: 'insufficient_scope', error_description: 'x' } });
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: noSleep });
    const report = await inspectPilot(caller, { portalHost: 'h', now: () => NOW });
    expect(report.assignees).toMatchObject({ error: 'user.get: HTTP 401 (insufficient_scope)' });
    expect(JSON.stringify(report)).not.toContain(mock.webhookCode);
  });
});

describe('CLI', () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ PATH: process.env.PATH, APP_ENV: 'local', BITRIX_MIN_INTERVAL_MS: '1', ...extra }) as unknown as NodeJS.ProcessEnv;

  it('refuses without BITRIX_WEBHOOK_BASE_URL', async () => {
    const err = (await run(process.execPath, [script, '--portal-domain', '127.0.0.1'], { env: env() }).catch((e: unknown) => e)) as {
      code: number;
      stderr: string;
    };
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/BITRIX_WEBHOOK_BASE_URL is not set/);
  });

  it('requires --portal-domain and refuses a URL whose host differs from it', async () => {
    const missing = (await run(process.execPath, [script], { env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }) }).catch(
      (e: unknown) => e,
    )) as { code: number; stderr: string };
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--portal-domain <portal host> is required/);
    expect(mock.requests).toHaveLength(0);

    const https = mock.baseUrl.replace('http://127.0.0.1', 'https://other.bitrix24.example');
    const mismatch = (await run(process.execPath, [script, '--portal-domain', 'synthetic.bitrix24.example'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: https, APP_ENV: 'staging' }),
    }).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toMatch(/does not match --portal-domain/);
    expect(mismatch.stderr).not.toContain(mock.webhookCode);
  });

  it('--out writes mode 0600 (also when the file existed) and keeps the report off stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilot-inspect-'));
    const file = join(dir, 'report.json');
    await writeFile(file, 'old', { mode: 0o644 });
    const { stdout } = await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--out', file], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }),
    });
    expectOwnerOnlyMode((await stat(file)).mode);
    expect(stdout).not.toContain('"categories"');
    expect(JSON.parse(await readFile(file, 'utf8')).portalHost).toBe('127.0.0.1');
    await rm(dir, { recursive: true, force: true });
  });

  it('prints a redacted JSON report and never the webhook code', async () => {
    const { stdout } = await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--since-days', '3650'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }),
    });
    expect(stdout).not.toContain(mock.webhookCode);
    const report = JSON.parse(stdout) as { portalHost: string; categories: unknown[] };
    expect(report.portalHost).toBe('127.0.0.1');
    expect(report.categories).toHaveLength(2);
  });

  it('auth failure exits 2 with a fixed message, a partial report and no URL', async () => {
    const bad = mock.baseUrl.replace(mock.webhookCode, 'wrongwebhookcode0001');
    const err = (await run(process.execPath, [script, '--portal-domain', '127.0.0.1'], { env: env({ BITRIX_WEBHOOK_BASE_URL: bad }) }).catch(
      (e: unknown) => e,
    )) as {
      code: number;
      stderr: string;
      stdout: string;
    };
    expect(err.code).toBe(2);
    expect(err.stderr).toMatch(/incomplete, stopped at crm\.category\.list: HTTP 401 \(INVALID_CREDENTIALS\)/);
    expect(err.stderr).not.toContain('wrongwebhookcode0001');
    expect(err.stdout).not.toContain('wrongwebhookcode0001');
    expect(JSON.parse(err.stdout)).toMatchObject({ aborted: 'crm.category.list: HTTP 401 (INVALID_CREDENTIALS)' });
  });

  it('a missing scope keeps app.info/profile/server.time results in the --out file', async () => {
    mock.failNext('crm.category.list', { status: 401, body: { error: 'insufficient_scope', error_description: 'x' } });
    const dir = await mkdtemp(join(tmpdir(), 'pilot-inspect-'));
    const file = join(dir, 'partial.json');
    const err = (await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--out', file], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }),
    }).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(2);
    expectOwnerOnlyMode((await stat(file)).mode);
    const report = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(report.aborted).toBe('crm.category.list: HTTP 401 (insufficient_scope)');
    expect(report.calls).toEqual(['app.info', 'profile', 'server.time', 'crm.category.list']);
    expect(report).toHaveProperty('webhook');
    expect(report).toHaveProperty('webhookOwner');
    expect(report).not.toHaveProperty('dealFields');
    expect(mock.requests).toHaveLength(4);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('dealFields metadata', () => {
  it('keeps code, type, flags and UF labels only (no enumeration items or values)', async () => {
    const caller = createReadOnlyCaller(mock.baseUrl, { minIntervalMs: 0, sleep: async () => undefined });
    const report = await inspectPilot(caller, { portalHost: 'h', now: () => NOW });
    expect(report.dealFields.length).toBe(report.dealFieldCount);
    for (const f of report.dealFields) {
      expect(Object.keys(f).sort()).toEqual(['code', 'isMultiple', 'isReadOnly', 'isRequired', 'label', 'type']);
      if (!f.code.startsWith('UF_')) expect(f.label).toBeNull();
    }
    expect(report.dealFields.find((f) => f.code === 'ID')?.type).toBe('integer');
    expect(JSON.stringify(report.dealFields)).not.toMatch(/"items"|"VALUE"|"settings"/);
  });
});

describe('--diagnose helpers (Phase 5, 401 investigation)', () => {
  const CODE = 'abcdefgh12345678';
  const good = `https://portal.bitrix24.example/rest/17/${CODE}/`;

  it('checkWebhookShape passes a well-formed URL and returns booleans only', () => {
    const r = checkWebhookShape(good, 'portal.bitrix24.example');
    expect(r.ok).toBe(true);
    expect(Object.values(r.checks).every((v) => v === true)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CODE);
    expect(JSON.stringify(r)).not.toContain('portal.bitrix24.example');
  });

  it.each([
    ['quoted', `"${good}"`, 'noQuotes'],
    ['surrounding whitespace', ` ${good}\n`, 'noSurroundingWhitespace'],
    ['http', good.replace('https:', 'http:'), 'https'],
    ['other host', good.replace('portal.', 'other.'), 'hostMatchesPortal'],
    ['method pasted after code', `${good}server.time.json`, 'pathIsRestUserCode'],
    ['query string', `${good}?x=1`, 'noUserinfoQueryHash'],
    ['non-numeric user', good.replace('/17/', '/abc/'), 'userIdNumeric'],
    ['code with symbols', good.replace(CODE, 'abcd%20fgh1234567'), 'codeAlphanumeric'],
    ['zero-width char', good.replace('rest', 'rest\u200b'), 'asciiOnly'],
  ])('checkWebhookShape fails on %s', (_name, raw, failing) => {
    const r = checkWebhookShape(raw, 'portal.bitrix24.example');
    expect(r.ok).toBe(false);
    expect(r.checks[failing as keyof typeof r.checks]).toBe(false);
  });

  it('missing trailing slash and non-16 code length are advisory only', () => {
    const r = checkWebhookShape(good.replace(CODE + '/', 'abc123'), 'portal.bitrix24.example');
    expect(r.checks.trailingSlash).toBe(false);
    expect(r.checks.codeLength16).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('loopback http is accepted only for APP_ENV=local', () => {
    expect(checkWebhookShape(mock.baseUrl, '127.0.0.1', 'local').ok).toBe(true);
    expect(checkWebhookShape(mock.baseUrl, '127.0.0.1', 'production').checks.https).toBe(false);
  });

  it.each(['post', 'get'] as const)('diagnoseWebhook (%s) makes exactly one server.time call and reports ok', async (form) => {
    const r = await diagnoseWebhook(mock.baseUrl, { form });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.method).toBe('server.time');
    expect(r).toMatchObject({ calls: 1, status: 200, verdict: 'ok', form });
  });

  it('diagnoseWebhook maps a rejected code to INVALID_CREDENTIALS without retry or URL', async () => {
    const bad = mock.baseUrl.replace(mock.webhookCode, 'wrongwebhookcode0001');
    const r = await diagnoseWebhook(bad);
    expect(mock.requests).toHaveLength(1);
    expect(r).toMatchObject({ status: 401, errorCode: 'INVALID_CREDENTIALS', verdict: 'INVALID_CREDENTIALS' });
    expect(r.explanation).toBe(DIAGNOSIS.INVALID_CREDENTIALS);
    expect(JSON.stringify(r)).not.toContain('wrongwebhookcode0001');
  });

  it('diagnoseWebhook does not follow a redirect and reports the target host only', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { location: 'https://new.example.com/rest/1/secretpath/x?y=1' } });
    }) as unknown as typeof fetch;
    const r = await diagnoseWebhook(good, { fetchImpl });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('manual');
    expect(r).toMatchObject({ verdict: 'redirect', redirectHost: 'new.example.com', status: 302 });
    expect(JSON.stringify(r)).not.toContain('secretpath');
  });

  it('diagnoseWebhook maps ACCESS_DENIED, unreachable and a malformed error code', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect((await diagnoseWebhook(good, { fetchImpl: answer(401, { error: 'ACCESS_DENIED' }) })).verdict).toBe('ACCESS_DENIED');
    const odd = await diagnoseWebhook(good, { fetchImpl: answer(500, { error: 'x <script> https://a/rest/1/abc' }) });
    expect(odd).toMatchObject({ verdict: 'other', errorCode: null });
    const down = (async () => {
      throw new Error(`connect failed ${good}`);
    }) as unknown as typeof fetch;
    const r = await diagnoseWebhook(good, { fetchImpl: down });
    expect(r).toMatchObject({ verdict: 'unreachable', status: null });
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it('diagnoseWebhook refuses an unknown form before any request', async () => {
    await expect(diagnoseWebhook(mock.baseUrl, { form: 'put' })).rejects.toBeInstanceOf(PilotInspectError);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('CLI --diagnose', () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ PATH: process.env.PATH, APP_ENV: 'local', ...extra }) as unknown as NodeJS.ProcessEnv;

  it('--offline validates the shape and makes no request', async () => {
    const { stdout } = await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--diagnose', '--offline'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }),
    });
    expect(mock.requests).toHaveLength(0);
    expect(stdout).not.toContain(mock.webhookCode);
    expect(JSON.parse(stdout)).toMatchObject({ shape: { ok: true }, call: null });
  });

  it('a failing shape exits 2 without any request', async () => {
    const err = (await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--diagnose'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: `${mock.baseUrl}server.time.json` }),
    }).catch((e: unknown) => e)) as { code: number; stdout: string };
    expect(err.code).toBe(2);
    expect(mock.requests).toHaveLength(0);
    expect(err.stdout).not.toContain(mock.webhookCode);
  });

  it('ok exits 0 after one call; a rejected code exits 2 with status and code only', async () => {
    const ok = await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--diagnose'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: mock.baseUrl }),
    });
    expect(JSON.parse(ok.stdout)).toMatchObject({ call: { status: 200, verdict: 'ok' } });
    expect(mock.requests).toHaveLength(1);

    const bad = mock.baseUrl.replace(mock.webhookCode, 'wrongwebhookcode0001');
    const err = (await run(process.execPath, [script, '--portal-domain', '127.0.0.1', '--diagnose', '--form', 'get'], {
      env: env({ BITRIX_WEBHOOK_BASE_URL: bad }),
    }).catch((e: unknown) => e)) as { code: number; stdout: string };
    expect(err.code).toBe(2);
    expect(mock.requests).toHaveLength(2);
    expect(err.stdout).not.toContain('wrongwebhookcode0001');
    expect(JSON.parse(err.stdout)).toMatchObject({ call: { status: 401, errorCode: 'INVALID_CREDENTIALS', form: 'get' } });
  });
});
