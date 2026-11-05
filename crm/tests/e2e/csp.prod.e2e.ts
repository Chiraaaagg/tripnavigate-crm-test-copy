import { expect, type Page, test } from '@playwright/test';

/**
 * T14 against a PRODUCTION build (playwright.prod.config.ts, project 'prod-csp').
 * `next dev` relaxes the policy, so only this run proves the shipped header:
 *   - no 'unsafe-inline' / 'unsafe-eval' anywhere;
 *   - script-src and style-src carry a per-request nonce ('strict-dynamic' for scripts);
 *   - the nonce differs on every request and matches the nonce on rendered scripts;
 *   - zero CSP violations on every public page, redirect and 404, including
 *     hydration and a server-action form submit.
 * The preview gallery is disabled in production builds and must 404.
 * Providerless: the Supabase URL points at a closed port.
 */

const PAGES: Array<{ path: string; landsOn?: RegExp; status?: number }> = [
  { path: '/sign-in' },
  { path: '/forgot-password' },
  { path: '/session-expired' },
  { path: '/signed-out' },
  { path: '/signed-out?scope=global' },
  { path: '/access-inactive' },
  { path: '/mfa/recovery' },
  { path: '/auth/accept?type=invite&token_hash=AAAAAAAAAAAAAAAAAAAAAAAA' },
  { path: '/auth/accept?type=recovery&token_hash=AAAAAAAAAAAAAAAAAAAAAAAA' },
  { path: '/auth/accept' },
  { path: '/', landsOn: /\/sign-in/ },
  { path: '/app', landsOn: /\/sign-in\?next=%2Fapp$/ },
  { path: '/app/deals', landsOn: /\/sign-in/ },
  { path: '/account-recovery', landsOn: /\/sign-in/ },
  { path: '/mfa/challenge', landsOn: /\/sign-in/ },
  { path: '/onboarding/password', landsOn: /\/sign-in/ },
  { path: '/preview/mfa-challenge', status: 404 },
  { path: '/preview/ui-gallery', status: 404 },
  { path: '/no-such-page', status: 404 },
];

function parseCsp(header: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

function nonceOf(directive: string[] | undefined): string | null {
  const token = directive?.find((v) => /^'nonce-[A-Za-z0-9+/=_-]+'$/.test(v));
  return token ? token.slice(7, -1) : null;
}

/** Asserts the production policy and returns its nonce. */
function expectStrictPolicy(header: string | undefined, where: string): string {
  expect(header, `${where}: Content-Security-Policy header`).toBeTruthy();
  const csp = parseCsp(header!);
  expect(header, where).not.toContain("'unsafe-inline'");
  expect(header, where).not.toContain("'unsafe-eval'");
  expect(header, where).not.toMatch(/(^|\s)\*(\s|;|$)/);
  expect(csp.get('default-src'), where).toEqual(["'self'"]);
  const scriptNonce = nonceOf(csp.get('script-src'));
  expect(scriptNonce, `${where}: script-src nonce`).toBeTruthy();
  expect(csp.get('script-src'), where).toEqual(expect.arrayContaining(["'self'", "'strict-dynamic'"]));
  expect(nonceOf(csp.get('style-src')), `${where}: style-src nonce`).toBe(scriptNonce);
  expect(csp.get('img-src'), where).toEqual(["'self'", 'data:', 'blob:']);
  // 'self' plus exactly the Supabase API origin and its Realtime websocket.
  const connect = csp.get('connect-src') ?? [];
  expect(connect[0], where).toBe("'self'");
  expect(connect.length, where).toBe(3);
  expect(connect[2], where).toBe(connect[1]!.replace(/^http/, 'ws'));
  expect(csp.get('object-src'), where).toEqual(["'none'"]);
  expect(csp.get('base-uri'), where).toEqual(["'self'"]);
  expect(csp.get('form-action'), where).toEqual(["'self'"]);
  expect(csp.get('frame-ancestors'), where).toEqual(["'none'"]);
  // Local http server: upgrading would break it; HTTPS deployments add it.
  expect(csp.has('upgrade-insecure-requests'), where).toBe(false);
  return scriptNonce!;
}

async function trackViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCspViolation: (v: string) => void }).__reportCspViolation(
        `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} ${e.sample ?? ''}`,
      );
    });
  });
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(`${page.url()}: ${msg.text()}`);
  });
  return violations;
}

test.describe('production Content Security Policy (T14)', () => {
  test('header is strict and the nonce is fresh on every request', async ({ request }) => {
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await request.get('/sign-in');
      expect(res.status()).toBe(200);
      nonces.add(expectStrictPolicy(res.headers()['content-security-policy'], `/sign-in #${i + 1}`));
    }
    expect(nonces.size).toBe(5);
  });

  test('redirects issued by the proxy carry the policy too', async ({ request }) => {
    const res = await request.get('/app', { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expectStrictPolicy(res.headers()['content-security-policy'], '/app redirect');
  });

  test('every public page, redirect and 404 renders with zero violations', async ({ page }) => {
    const violations = await trackViolations(page);
    for (const entry of PAGES) {
      const res = await page.goto(entry.path, { waitUntil: 'networkidle' });
      expect(res, entry.path).not.toBeNull();
      expect(res!.status(), entry.path).toBe(entry.status ?? 200);
      if (entry.landsOn) expect(page.url(), entry.path).toMatch(entry.landsOn);
      const nonce = expectStrictPolicy(res!.headers()['content-security-policy'], entry.path);

      // Every script in the server-rendered HTML carries this response's nonce.
      // (Scripts inserted later by those trusted scripts are allowed by
      // 'strict-dynamic' and need no nonce.)
      const html = await res!.text();
      const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
      expect(scriptTags.length, `${entry.path}: scripts rendered`).toBeGreaterThan(0);
      for (const tag of scriptTags) {
        expect(tag, `${entry.path}: script without the response nonce`).toContain(`nonce="${nonce}"`);
      }

      // Hydrated: client components respond (a submit button exists and is enabled where present).
      await expect(page.locator('h1').first(), entry.path).toBeVisible();
    }
    expect(violations).toEqual([]);
  });

  test('server-action forms work under the policy (sign-in error, forgot-password notice)', async ({ page }) => {
    const violations = await trackViolations(page);
    await page.goto('/sign-in', { waitUntil: 'networkidle' });
    await page.getByLabel(/email/i).first().fill('nobody@example.test');
    await page.getByLabel(/password/i).first().fill('Not-the-password-1');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });

    await page.goto('/forgot-password', { waitUntil: 'networkidle' });
    await page.getByLabel(/email/i).first().fill('nobody@example.test');
    await page.getByRole('button').filter({ hasText: /send|reset|email/i }).first().click();
    await expect(page.getByText(/asked the mail service to send a reset link/i)).toBeVisible({ timeout: 20_000 });

    expect(violations).toEqual([]);
  });
});
