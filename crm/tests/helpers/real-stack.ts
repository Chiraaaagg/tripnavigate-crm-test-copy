import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import { isRealStackRequired } from '@/lib/config';

/**
 * Harness for tests against a REAL local Supabase stack (GoTrue + PostgREST +
 * Postgres + Mailpit), started in CI by `supabase start`, reset and seeded with
 * scripts/seed-local.mjs.
 *
 * T16: when REQUIRE_REAL_STACK=1 (set by every real-stack CI job) missing
 * configuration THROWS, so the suite fails instead of silently skipping.
 */

export interface RealStackEnv {
  url: string;
  publishableKey: string;
  secretKey: string;
  fixturePassword: string;
  mailpitUrl: string;
  /** The CRM app served against this stack (`next start`), e.g. http://127.0.0.1:3000. */
  appBaseUrl: string;
}

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'LOCAL_FIXTURE_PASSWORD',
  'APP_BASE_URL',
] as const;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class RealStackConfigError extends Error {
  override name = 'RealStackConfigError';
}

/**
 * Returns the real-stack configuration, or null when it is absent and not
 * required. Throws when REQUIRE_REAL_STACK=1 and anything is missing, and
 * always refuses non-local targets (these tests create, ban and deactivate users).
 */
export function resolveRealStackEnv(env: Record<string, string | undefined> = process.env): RealStackEnv | null {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    if (isRealStackRequired(env)) {
      throw new RealStackConfigError(
        `REQUIRE_REAL_STACK=1 but real-stack configuration is missing: ${missing.join(', ')}`,
      );
    }
    return null;
  }
  const url = env.SUPABASE_URL!.trim();
  const mailpitUrl = (env.MAILPIT_URL?.trim() || 'http://127.0.0.1:54324').replace(/\/$/, '');
  const appBaseUrl = env.APP_BASE_URL!.trim().replace(/\/$/, '');
  for (const target of [url, mailpitUrl, appBaseUrl]) {
    if (!LOCAL_HOSTS.has(new URL(target).hostname)) {
      throw new RealStackConfigError('Real-stack tests run only against a local stack (localhost/127.0.0.1).');
    }
  }
  return {
    url,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY!.trim(),
    secretKey: env.SUPABASE_SECRET_KEY!.trim(),
    fixturePassword: env.LOCAL_FIXTURE_PASSWORD!,
    mailpitUrl,
    appBaseUrl,
  };
}

const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The barrier has second precision and a sign-in in the same second as the
 * barrier move is denied (fail closed). Wait past the next second boundary.
 */
export const waitPastBarrierSecond = () => sleep(1_500);

export interface Totp {
  factorId: string;
  secret: string;
}

export interface SignedIn {
  client: SupabaseClient;
  session: Session;
}

export function createRealStack(env: RealStackEnv) {
  /** Service-role client (bypasses RLS). Used only for setup and provider-side steps. */
  const admin = () => createClient(env.url, env.secretKey, { auth: noPersist });
  /** Publishable-key client without a session (anon). */
  const anon = () => createClient(env.url, env.publishableKey, { auth: noPersist });
  /**
   * Raw Data API client that always sends the given access token, exactly as
   * an attacker holding a copied token would. It never refreshes.
   */
  const withToken = (accessToken: string) =>
    createClient(env.url, env.publishableKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: noPersist,
    });

  const factorsByUser = new Map<string, Totp[]>();
  const touchedUsers = new Set<string>();

  async function signIn(email: string, password = env.fixturePassword): Promise<SignedIn> {
    const client = anon();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { client, session: data.session };
  }

  async function currentSession(client: SupabaseClient): Promise<Session> {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw error ?? new Error('no session');
    return data.session;
  }

  function code(secret: string, offsetPeriods = 0): string {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
    return totp.generate({ timestamp: Date.now() + offsetPeriods * 30_000 });
  }

  /**
   * Challenge + verify an existing TOTP factor. If the provider refuses a code
   * (for example a code already used in this 30 s window) it waits for the
   * next window and retries once.
   */
  async function verifyTotp(client: SupabaseClient, factor: Totp): Promise<Session> {
    let result = await client.auth.mfa.challengeAndVerify({ factorId: factor.factorId, code: code(factor.secret) });
    if (result.error) {
      await sleep(30_000 - (Date.now() % 30_000) + 1_000);
      result = await client.auth.mfa.challengeAndVerify({ factorId: factor.factorId, code: code(factor.secret) });
    }
    if (result.error) throw result.error;
    return currentSession(client);
  }

  /** Enrols a NEW TOTP factor for the signed-in user and verifies it (session becomes aal2). */
  async function enrolTotp(client: SupabaseClient, userId: string): Promise<Totp> {
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `ci-${userId.slice(-4)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (error) throw error;
    touchedUsers.add(userId);
    const factor = { factorId: data.id, secret: data.totp.secret };
    factorsByUser.set(userId, [...(factorsByUser.get(userId) ?? []), factor]);
    await verifyTotp(client, factor);
    return factor;
  }

  async function aal(client: SupabaseClient): Promise<string | null> {
    const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel ?? null;
  }

  /**
   * Password sign-in, then aal2: reuses the last known factor of this user if
   * it still exists, otherwise enrols a new one.
   */
  async function signInAal2(email: string, userId: string): Promise<SignedIn & { factor: Totp }> {
    const { client } = await signIn(email);
    const { data } = await client.auth.mfa.listFactors();
    const verified = new Set((data?.totp ?? []).filter((f) => f.status === 'verified').map((f) => f.id));
    const known = [...(factorsByUser.get(userId) ?? [])].reverse().find((f) => verified.has(f.factorId));
    let factor: Totp;
    if (known) {
      await verifyTotp(client, known);
      factor = known;
    } else if (verified.size > 0) {
      throw new Error('user has a verified factor this run does not know; cannot reach aal2');
    } else {
      factor = await enrolTotp(client, userId);
    }
    if ((await aal(client)) !== 'aal2') throw new Error('expected an aal2 session');
    return { client, session: await currentSession(client), factor };
  }

  /** Exchanges a refresh token directly with the provider (no stored session). */
  async function refresh(refreshToken: string) {
    return anon().auth.refreshSession({ refresh_token: refreshToken });
  }

  /** Provider-side factor removal, as the server does after begin_mfa_recovery. */
  async function deleteAllFactors(userId: string): Promise<number> {
    const client = admin();
    const { data, error } = await client.auth.admin.mfa.listFactors({ userId });
    if (error) throw error;
    for (const factor of data.factors) {
      const del = await client.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
      if (del.error) throw del.error;
    }
    factorsByUser.delete(userId);
    return data.factors.length;
  }

  /** Provider-side removal of ONE factor (e.g. an extra factor planted by an attacker). */
  async function deleteFactor(userId: string, factorId: string): Promise<void> {
    const del = await admin().auth.admin.mfa.deleteFactor({ id: factorId, userId });
    if (del.error) throw del.error;
    factorsByUser.set(
      userId,
      (factorsByUser.get(userId) ?? []).filter((f) => f.factorId !== factorId),
    );
  }

  /** afterAll: remove every factor this run created so suites stay re-runnable. */
  async function cleanup(): Promise<void> {
    for (const userId of touchedUsers) {
      await deleteAllFactors(userId).catch(() => undefined);
    }
  }

  return {
    env,
    admin,
    anon,
    withToken,
    signIn,
    signInAal2,
    enrolTotp,
    verifyTotp,
    aal,
    refresh,
    deleteAllFactors,
    deleteFactor,
    cleanup,
    currentSession,
  };
}

export type RealStack = ReturnType<typeof createRealStack>;

// ---------------------------------------------------------------------------
// Mailpit (local email capture). REST API: GET /api/v1/messages,
// GET /api/v1/message/{ID}.
// ---------------------------------------------------------------------------

export interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
  To: Array<{ Address: string; Name?: string }>;
}

export interface MailpitMessage extends MailpitSummary {
  HTML: string;
  Text: string;
}

export async function listMailpitMessages(mailpitUrl: string, limit = 200): Promise<MailpitSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages?limit=${limit}`);
  if (!res.ok) throw new Error(`Mailpit list failed: HTTP ${res.status}`);
  const body = (await res.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

export async function getMailpitMessage(mailpitUrl: string, id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Mailpit message failed: HTTP ${res.status}`);
  return (await res.json()) as MailpitMessage;
}

/** Waits for the newest message to `to` created after `since` (ms epoch). */
export async function waitForEmail(
  mailpitUrl: string,
  to: string,
  options: { since?: number; timeoutMs?: number; subject?: RegExp } = {},
): Promise<MailpitMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const target = to.toLowerCase();
  while (Date.now() < deadline) {
    const hit = (await listMailpitMessages(mailpitUrl)).find(
      (m) =>
        m.To.some((r) => r.Address.toLowerCase() === target) &&
        (!options.since || Date.parse(m.Created) >= options.since - 2_000) &&
        (!options.subject || options.subject.test(m.Subject)),
    );
    if (hit) return getMailpitMessage(mailpitUrl, hit.ID);
    await sleep(500);
  }
  throw new Error(`no email to ${to} arrived in Mailpit in time`);
}

/** Extracts the /auth/confirm link of the given type from an email body. */
export function extractConfirmLink(message: Pick<MailpitMessage, 'HTML' | 'Text'>, type: 'invite' | 'recovery'): URL {
  const body = `${message.HTML ?? ''}\n${message.Text ?? ''}`.replace(/&amp;/g, '&');
  const match = /https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/.exec(body);
  if (!match) throw new Error('no /auth/confirm link in the email');
  const url = new URL(match[0]);
  if (url.searchParams.get('type') !== type) throw new Error(`link type is not ${type}`);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(url.searchParams.get('token_hash') ?? '')) throw new Error('bad token_hash');
  return url;
}

// ---------------------------------------------------------------------------
// Email link flow through the app: GET /auth/confirm (never spends the token)
// -> /auth/accept interstitial -> same-origin POST that verifies the token.
// ---------------------------------------------------------------------------

export interface FetchStep {
  status: number;
  location: string | null;
  setCookies: string[];
  body: string;
}

async function step(url: string, init: RequestInit = {}): Promise<FetchStep> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookies: res.headers.getSetCookie(),
    body: res.status >= 300 && res.status < 400 ? '' : await res.text(),
  };
}

export interface AcceptForm {
  action: string;
  method: string;
  enctype: string;
  fields: Record<string, string>;
}

const decodeHtml = (v: string) =>
  v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return m ? decodeHtml(m[1]!) : null;
}

/** Parses the first POST form of an HTML page (action, enctype and named inputs). */
export function parsePostForm(html: string): AcceptForm | null {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = `<form ${match[1]}>`;
    if ((attr(open, 'method') ?? 'get').toLowerCase() !== 'post') continue;
    const fields: Record<string, string> = {};
    for (const input of match[2]!.matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(input[0], 'name');
      if (name) fields[name] = attr(input[0], 'value') ?? '';
    }
    return {
      action: attr(open, 'action') ?? '',
      method: 'post',
      enctype: (attr(open, 'enctype') ?? 'application/x-www-form-urlencoded').toLowerCase(),
      fields,
    };
  }
  return null;
}

export function submitForm(pageUrl: string, form: AcceptForm, origin: string): Promise<FetchStep> {
  const target = new URL(form.action || pageUrl, pageUrl).toString();
  let body: BodyInit;
  if (form.enctype.startsWith('multipart/')) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form.fields)) fd.append(k, v);
    body = fd;
  } else {
    body = new URLSearchParams(form.fields);
  }
  return step(target, { method: 'POST', body, headers: { Origin: origin, Referer: pageUrl } });
}

/**
 * Opens an emailed /auth/confirm link like a browser (GET, redirect to the
 * /auth/accept interstitial) and returns the interstitial's form. Nothing here
 * spends the token.
 */
export async function openEmailLink(appBaseUrl: string, link: URL): Promise<{ acceptUrl: string; form: AcceptForm }> {
  const first = await step(new URL(link.pathname + link.search, appBaseUrl).toString());
  if (first.status < 300 || first.status >= 400 || !first.location) {
    throw new Error(`GET /auth/confirm should redirect to /auth/accept (HTTP ${first.status})`);
  }
  const acceptUrl = new URL(first.location, appBaseUrl).toString();
  if (new URL(acceptUrl).pathname !== '/auth/accept') throw new Error(`unexpected redirect to ${new URL(acceptUrl).pathname}`);
  const page = await step(acceptUrl);
  if (page.status !== 200) throw new Error(`/auth/accept returned HTTP ${page.status}`);
  const form = parsePostForm(page.body);
  if (!form) throw new Error('/auth/accept has no POST form');
  return { acceptUrl, form };
}

export const hasAuthCookie = (setCookies: string[]) =>
  setCookies.some((c) => /^sb-[^=]+-auth-token(\.\d+)?=[^;]+/.test(c) && !/^sb-[^=]+-auth-token(\.\d+)?=;/.test(c));

/** Cookie header from Set-Cookie lines (name=value only). */
export const cookieHeader = (setCookies: string[]) =>
  setCookies.map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c!)).join('; ');
