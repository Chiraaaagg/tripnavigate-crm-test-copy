import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  buildCspDirectives,
  generateNonce,
  shouldUpgradeInsecureRequests,
  supabaseConnectSources,
} from '@/lib/csp';

const nonce = 'AAAAAAAAAAAAAAAAAAAAAA==';
const prod = { nonce, isDev: false, upgradeInsecureRequests: true };

describe('content security policy (T14)', () => {
  it('production policy is nonce-based and strict', () => {
    const d = buildCspDirectives(prod);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(d['style-src']).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(d['connect-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d).toHaveProperty('upgrade-insecure-requests');
  });

  it('connect-src adds only the Supabase origin and its Realtime websocket', () => {
    expect(supabaseConnectSources('https://abcdefghijklmnopqrst.supabase.co')).toEqual([
      'https://abcdefghijklmnopqrst.supabase.co',
      'wss://abcdefghijklmnopqrst.supabase.co',
    ]);
    expect(supabaseConnectSources('http://127.0.0.1:54321')).toEqual(['http://127.0.0.1:54321', 'ws://127.0.0.1:54321']);
    expect(supabaseConnectSources('not a url')).toEqual([]);
    const d = buildCspDirectives({ ...prod, connectSources: supabaseConnectSources('https://x.supabase.co') });
    expect(d['connect-src']).toEqual(["'self'", 'https://x.supabase.co', 'wss://x.supabase.co']);
  });

  it('never allows unsafe-inline scripts or unsafe-eval in production', () => {
    const header = buildContentSecurityPolicy(prod);
    expect(header).not.toContain("'unsafe-inline'");
    expect(header).not.toContain("'unsafe-eval'");
    expect(header).not.toMatch(/\*/);
  });

  it('development adds only what next dev needs', () => {
    const d = buildCspDirectives({ ...prod, isDev: true });
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    // A nonce next to 'unsafe-inline' would make browsers ignore 'unsafe-inline'.
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('serialises to one header line', () => {
    const header = buildContentSecurityPolicy(prod);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(header).toMatch(/; upgrade-insecure-requests$/);
    expect(buildContentSecurityPolicy({ ...prod, upgradeInsecureRequests: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('upgrades insecure requests only for an HTTPS site', () => {
    expect(shouldUpgradeInsecureRequests('https://crm.example.test')).toBe(true);
    expect(shouldUpgradeInsecureRequests('http://127.0.0.1:3100')).toBe(false);
    expect(shouldUpgradeInsecureRequests('not a url')).toBe(true);
  });

  it('generates a fresh unpredictable nonce per call', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(values.size).toBe(200);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('rejects a missing or malformed nonce instead of emitting a weak policy', () => {
    expect(() => buildContentSecurityPolicy({ ...prod, nonce: '' })).toThrow();
    expect(() => buildContentSecurityPolicy({ ...prod, nonce: "abc' 'unsafe-inline" })).toThrow();
  });

  it('the proxy sets the policy on the request and response and skips prefetches', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'proxy.ts'), 'utf8');
    expect(source).toContain('requestHeaders.set(CSP_HEADER, csp)');
    expect(source).toContain('res.headers.set(CSP_HEADER, csp)');
    expect(source).toContain('requestHeaders.set(NONCE_HEADER, nonce)');
    expect(source).toContain("key: 'next-router-prefetch'");
    // The proxy no longer decides session age; the database does (S5).
    expect(source).not.toMatch(/sessionAgeSeconds|sessionMaxAge/);
  });

  it('the root layout renders per request so nonces apply', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'app', 'layout.tsx'), 'utf8');
    expect(source).toMatch(/await connection\(\)/);
  });
});
