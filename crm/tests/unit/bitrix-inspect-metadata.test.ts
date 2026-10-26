import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMetadata, inspectMetadata, METADATA_METHODS, resolveBaseUrl } from '../../scripts/lib/bitrix-metadata.mjs';
import { startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/** scripts/bitrix-inspect-metadata.mjs: read-only, metadata only, refuses without credential, never prints it. */

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '..', 'scripts', 'bitrix-inspect-metadata.mjs');
let mock: MockBitrix;

beforeAll(async () => {
  mock = await startMockBitrix();
  mock.deals.set('1', syntheticDeal(1, { TITLE: 'Synthetic customer content must not print' }));
});
afterAll(async () => {
  await mock.close();
});

const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, APP_ENV: 'local' }) as unknown as NodeJS.ProcessEnv;

describe('bitrix-inspect-metadata', () => {
  it('calls metadata methods only and prints categories, stages and field codes', async () => {
    const meta = await inspectMetadata(resolveBaseUrl(mock.baseUrl, 'synthetic.bitrix24.example', 'local'));
    expect(meta.categories.map((c) => c.id)).toEqual(['0', '7']);
    expect(meta.stagesByCategory['7']!.map((s) => s.statusId)).toContain('C7:WON');
    expect(meta.dealFields.map((f) => f.code)).toContain('UF_CRM_SYNTHETIC');
    expect(new Set(mock.requests.map((r) => r.method))).toEqual(new Set(METADATA_METHODS));
    expect(formatMetadata(meta)).toContain('STAGE_ID=C7:WON');
  });

  it('refuses without BITRIX_WEBHOOK_BASE_URL in the process env', async () => {
    const err = (await run(process.execPath, [script, '--portal-domain', 'synthetic.bitrix24.example'], { env: baseEnv() }).catch(
      (e: unknown) => e,
    )) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/BITRIX_WEBHOOK_BASE_URL is not set/);
  });

  it('refuses a host that does not match the portal (non-local)', async () => {
    const env = { ...baseEnv(), APP_ENV: 'staging', BITRIX_WEBHOOK_BASE_URL: 'https://evil.example/rest/1/abcd9876/' };
    const err = (await run(process.execPath, [script, '--portal-domain', 'synthetic.bitrix24.example'], { env }).catch(
      (e: unknown) => e,
    )) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).not.toContain('abcd9876');
  });

  it('runs against the mock and never prints the credential or deal content', async () => {
    mock.requests.length = 0;
    const env = { ...baseEnv(), BITRIX_WEBHOOK_BASE_URL: mock.baseUrl };
    const { stdout, stderr } = await run(process.execPath, [script, '--portal-domain', 'synthetic.bitrix24.example'], { env });
    expect(stdout).toContain('CATEGORY_ID=7');
    expect(`${stdout}${stderr}`).not.toContain(mock.webhookCode);
    expect(stdout).not.toContain('Synthetic customer content');
    expect(mock.requests.every((r) => METADATA_METHODS.includes(r.method))).toBe(true);
  });

  it('provider errors are reported without the URL', async () => {
    mock.failNext('crm.category.list', { status: 401, body: { error: 'INVALID_CREDENTIALS', error_description: 'x' } });
    const env = { ...baseEnv(), BITRIX_WEBHOOK_BASE_URL: mock.baseUrl };
    const err = (await run(process.execPath, [script, '--portal-domain', 'synthetic.bitrix24.example'], { env }).catch(
      (e: unknown) => e,
    )) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('INVALID_CREDENTIALS');
    expect(err.stderr).not.toContain(mock.webhookCode);
  });
});
