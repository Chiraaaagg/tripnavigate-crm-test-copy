import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/check-local-dev.mjs');

function check(settings: string, developmentSettings?: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'tripnavigate-dev-check-'));
  try {
    writeFileSync(resolve(directory, '.env.local'), settings);
    if (developmentSettings) writeFileSync(resolve(directory, '.env.development.local'), developmentSettings);
    return spawnSync(process.execPath, [script], {
      cwd: directory,
      env: { PATH: process.env.PATH, NODE_ENV: 'development' },
      encoding: 'utf8',
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('local development launcher', () => {
  it('stops before server startup when business-database opt-in is present', () => {
    const result = check('LOCAL_USE_PRODUCTION_DATABASE=true\nNEXT_PUBLIC_SUPABASE_URL=https://syntheticproject.supabase.co\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run start');
    expect(result.stderr).not.toContain('syntheticproject');
  });

  it('refuses a hosted database even when the opt-in is missing', () => {
    expect(check('NEXT_PUBLIC_SUPABASE_URL=https://syntheticproject.supabase.co\n').status).toBe(1);
  });

  it('accepts an isolated loopback database', () => {
    expect(check('LOCAL_USE_PRODUCTION_DATABASE=false\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n').status).toBe(0);
  });

  it('uses Next.js development-file precedence', () => {
    const result = check(
      'LOCAL_USE_PRODUCTION_DATABASE=true\nNEXT_PUBLIC_SUPABASE_URL=https://syntheticproject.supabase.co\n',
      'LOCAL_USE_PRODUCTION_DATABASE=false\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n',
    );
    expect(result.status).toBe(0);
  });
});
