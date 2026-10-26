import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from './test-env.mjs';

/**
 * Shared steps for the real-stack browser journeys (tests/e2e/*.real.e2e.ts).
 * Local or CI stack only: every URL used here is checked to be loopback.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Owner connection to the local stack's Postgres (synthetic fixture steps only). */
export async function withDb<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  if (!isLoopbackDatabaseUrl(databaseUrl)) throw new Error('fixture steps run only against a loopback database');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** TOTP codes: never reuse a time step for the same secret, never use one about to expire. */
const lastStep = new Map<string, number>();
export async function totpCode(secret: string): Promise<string> {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret.replace(/\s/g, '')), digits: 6, period: 30 });
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    const remaining = 30_000 - (now % 30_000);
    const last = lastStep.get(secret);
    if ((last !== undefined && step <= last) || remaining < 4_000) {
      await sleep(remaining + 500);
      continue;
    }
    lastStep.set(secret, step);
    return totp.generate({ timestamp: now });
  }
}

/** Records every Content Security Policy violation of the contexts it tracks. */
export function cspRecorder() {
  const violations: string[] = [];
  async function track(browser: Browser, label: string): Promise<BrowserContext> {
    const context = await browser.newContext();
    await context.exposeFunction('__reportCspViolation', (v: string) => violations.push(`[${label}] ${v}`));
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __reportCspViolation: (v: string) => void }).__reportCspViolation(
          `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`,
        );
      });
    });
    context.on('console', (msg) => {
      if (msg.text().includes('Content Security Policy')) violations.push(`[${label}] console: ${msg.text()}`);
    });
    return context;
  }
  return { violations, track };
}

export async function signInViaUi(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Enrols a TOTP factor through the UI, reading the manual setup key from the page. Returns the secret. */
export async function enrolTotpViaUi(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/mfa\/enroll/);
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  await page.getByText('Cannot scan? Enter this setup key instead').click();
  const secret = ((await page.locator('p.secret').textContent()) ?? '').trim();
  expect(secret, 'setup key shown on the enrollment page').toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('6-digit code').fill(await totpCode(secret));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  return secret;
}

export async function challengeViaUi(page: Page, secret: string) {
  await expect(page).toHaveURL(/\/mfa\/challenge/);
  await page.getByLabel('6-digit code').fill(await totpCode(secret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
}

interface MailpitSummary {
  ID: string;
  To: Array<{ Address: string }>;
}

/** Path of the newest /auth/confirm link of `type` sent to `to` (local Mailpit REST API). */
export async function confirmLinkPath(mailpitUrl: string, to: string, type: 'invite' | 'recovery', notIds = new Set<string>()): Promise<{ id: string; path: string }> {
  if (!isLoopbackUrl(mailpitUrl)) throw new Error('Mailpit must be on a loopback address');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpitUrl}/api/v1/messages?limit=100`);
    expect(res.ok, 'Mailpit REST API reachable').toBe(true);
    const body = (await res.json()) as { messages?: MailpitSummary[] };
    for (const message of body.messages ?? []) {
      if (notIds.has(message.ID) || !message.To.some((t) => t.Address.toLowerCase() === to.toLowerCase())) continue;
      const full = (await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()) as { HTML?: string; Text?: string };
      const match = `${full.HTML ?? ''}\n${full.Text ?? ''}`.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/);
      if (!match) continue;
      const url = new URL(match[0].replace(/&amp;/g, '&'));
      if (url.searchParams.get('type') !== type) continue;
      return { id: message.ID, path: `${url.pathname}${url.search}` };
    }
    await sleep(1_000);
  }
  throw new Error(`No ${type} email to ${to} arrived in Mailpit within 60 s.`);
}

// ---------------------------------------------------------------------------
// Session cookie (sb-<ref>-auth-token, possibly chunked .0, .1, ...)
// ---------------------------------------------------------------------------

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [key: string]: unknown;
}

const AUTH_COOKIE = /^sb-[^.]+-auth-token(\.\d+)?$/;
const CHUNK_SIZE = 3180;

export async function authCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) => AUTH_COOKIE.test(c.name));
}

/** The session the app stored in the browser (chunks joined in order). */
export async function readSessionCookie(context: BrowserContext): Promise<StoredSession> {
  const cookies = (await authCookies(context)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  expect(cookies.length, 'auth cookie present').toBeGreaterThan(0);
  const raw = cookies.map((c) => decodeURIComponent(c.value)).join('');
  const json = raw.startsWith('base64-') ? Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8') : raw;
  return JSON.parse(json) as StoredSession;
}

/** Rewrites the stored session (same cookie names, flags and chunking rule as @supabase/ssr). */
export async function writeSessionCookie(context: BrowserContext, session: StoredSession): Promise<void> {
  const existing = await authCookies(context);
  expect(existing.length).toBeGreaterThan(0);
  const template = existing[0]!;
  const base = template.name.replace(/\.\d+$/, '');
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  await context.clearCookies({ name: AUTH_COOKIE });
  const chunks = value.length <= CHUNK_SIZE ? [value] : (value.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) ?? []);
  await context.addCookies(
    chunks.map((chunk, i) => ({
      name: chunks.length === 1 ? base : `${base}.${i}`,
      value: chunk,
      domain: template.domain,
      path: template.path,
      httpOnly: template.httpOnly,
      secure: template.secure,
      sameSite: template.sameSite,
      expires: template.expires,
    })),
  );
}

/** The aal2 access token the app holds for this browser (to call the Data API as that person). */
export async function accessTokenOf(context: BrowserContext): Promise<string> {
  return (await readSessionCookie(context)).access_token;
}

/** Every auth cookie is HttpOnly and SameSite=Lax; Secure exactly when the site is https. */
export async function expectHardenedAuthCookies(context: BrowserContext, siteIsHttps: boolean) {
  const cookies = await authCookies(context);
  expect(cookies.length, 'auth cookie present').toBeGreaterThan(0);
  for (const c of cookies) {
    expect(c.httpOnly, `${c.name} HttpOnly`).toBe(true);
    expect(c.sameSite, `${c.name} SameSite`).toBe('Lax');
    expect(c.secure, `${c.name} Secure`).toBe(siteIsHttps);
    expect(c.path, `${c.name} path`).toBe('/');
  }
}

/** Calls a database RPC through the Data API with a user's own access token. */
export async function rpcAs(supabaseUrl: string, publishableKey: string, accessToken: string, fn: string, args: Record<string, unknown>) {
  if (!isLoopbackUrl(supabaseUrl)) throw new Error('the Data API must be on a loopback address');
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  return { status: res.status, body: body as { code?: string; message?: string; details?: string } & Record<string, unknown> };
}

/** Today in India (YYYY-MM-DD), the business date the database uses. */
export function istToday(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The finance screens' calendar date format ("14 Nov 2026"). */
export function finDateText(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${iso}T00:00:00Z`));
}
