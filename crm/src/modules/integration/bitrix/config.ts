import 'server-only';
import { MIN_INTAKE_SECRET_LENGTH, parseIntegrationEnv, type IntegrationEnv } from '@/lib/config';

/**
 * Bitrix REST base URL validation (contract §1, P2-12).
 *
 * The base URL comes ONLY from the server environment (BITRIX_WEBHOOK_BASE_URL),
 * never from request input; `auth[client_endpoint]` / `server_endpoint` in event
 * bodies are ignored. It must be https and its host must equal the portal domain
 * stored in public.integration_intake_config.
 *
 * Test exception: with APP_ENV=local (which config.ts already pins to a local
 * Supabase stack) a loopback base URL (127.0.0.1 / localhost, http or https) is
 * accepted so the in-process mock Bitrix server can be used. No other host is
 * ever accepted without an exact portal-domain match.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Inbound webhook format: https://{portal}/rest/{user_id}/{webhook_code}/
const REST_PATH = /^\/rest\/\d{1,10}\/[A-Za-z0-9_-]{4,128}\/?$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export class BitrixConfigError extends Error {
  override name = 'BitrixConfigError';
  constructor(readonly code: 'missing' | 'invalid_url' | 'insecure_url' | 'host_mismatch' | 'invalid_portal_domain') {
    // Message is a fixed code: never include the URL (it carries the credential).
    super(`Bitrix configuration rejected: ${code}`);
  }
}

export interface BitrixRestTarget {
  /** Normalised base URL ending in "/". Secret: never log or return. */
  baseUrl: string;
  host: string;
}

export function normalisePortalDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Validates the REST base URL against the configured portal domain.
 * Throws BitrixConfigError (without the URL in the message) when invalid.
 */
export function resolveBitrixRestTarget(
  rawBaseUrl: string | null,
  portalDomain: string,
  appEnv: string | undefined,
): BitrixRestTarget {
  if (!rawBaseUrl) throw new BitrixConfigError('missing');
  const portal = normalisePortalDomain(portalDomain);
  if (!DOMAIN.test(portal)) throw new BitrixConfigError('invalid_portal_domain');
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new BitrixConfigError('invalid_url');
  }
  if (url.username || url.password || url.search || url.hash) throw new BitrixConfigError('invalid_url');
  if (!REST_PATH.test(url.pathname)) throw new BitrixConfigError('invalid_url');
  const host = url.hostname.toLowerCase();
  const loopbackTest = appEnv === 'local' && LOOPBACK.has(host);
  if (!loopbackTest) {
    if (url.protocol !== 'https:') throw new BitrixConfigError('insecure_url');
    if (url.port && url.port !== '443') throw new BitrixConfigError('host_mismatch');
    if (host !== portal) throw new BitrixConfigError('host_mismatch');
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BitrixConfigError('insecure_url');
  }
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return { baseUrl: `${url.protocol}//${url.host}${path}`, host };
}

/** Reads the integration secrets from process.env (server only). */
export function getIntegrationEnv(): IntegrationEnv {
  return parseIntegrationEnv({
    BITRIX_WEBHOOK_BASE_URL: process.env.BITRIX_WEBHOOK_BASE_URL,
    BITRIX_EVENT_APPLICATION_TOKEN: process.env.BITRIX_EVENT_APPLICATION_TOKEN,
    INTAKE_WORKER_SECRET: process.env.INTAKE_WORKER_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
  });
}

/** Minimum length for INTAKE_WORKER_SECRET / CRON_SECRET; shorter values count as not configured. */
export const MIN_WORKER_SECRET_LENGTH = MIN_INTAKE_SECRET_LENGTH;
