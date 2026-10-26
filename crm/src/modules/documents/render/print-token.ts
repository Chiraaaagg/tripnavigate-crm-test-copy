import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * DEC-49: the short-lived signed link the online PDF maker gives headless
 * Chromium to open the in-app print page of ONE render job.
 *
 * Token = base64url(JSON payload) "." base64url(HMAC-SHA256(payload)), keyed
 * with RENDER_PRINT_TOKEN_SECRET (server env only, at least 32 characters,
 * never logged). The payload names the job, the worker that holds its lease
 * and the IST day the document is dated (so the page prints exactly the input
 * the worker checks), and expires after at most two minutes. The page still
 * reads the job through the worker's lease, so a token alone opens nothing
 * once the job is finished.
 */

/** The online PDF maker's switch (server env; "on" = on; anything else = off). */
export const PDF_RENDER_ONLINE_ENV = 'PDF_RENDER_ONLINE';
/** The id of the template element on the print page (checked and printed). */
export const PRINT_DOCUMENT_ELEMENT_ID = 'itinerary-document';

/** Review E10-6: the request header carrying the print token (never the URL). */
export const PRINT_TOKEN_HEADER = 'x-tn-print-token';

export const PRINT_TOKEN_TTL_SECONDS = 120;
export const MIN_PRINT_TOKEN_SECRET_LENGTH = 32;

export interface PrintTokenPayload {
  /** Render job id. */
  j: string;
  /** Worker name holding the lease. */
  w: string;
  /** IST day (YYYY-MM-DD) the document is dated. */
  d: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function usableSecret(secret: string | undefined | null): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_PRINT_TOKEN_SECRET_LENGTH;
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signPrintToken(input: { jobId: string; worker: string; day: string }, secret: string, nowMs: number, ttlSeconds = PRINT_TOKEN_TTL_SECONDS): string {
  if (!usableSecret(secret)) throw new Error('print token secret missing or too short');
  if (!UUID.test(input.jobId) || !WORKER.test(input.worker) || !DAY.test(input.day)) throw new Error('print token input invalid');
  const ttl = Math.min(Math.max(Math.trunc(ttlSeconds), 1), PRINT_TOKEN_TTL_SECONDS);
  const payload: PrintTokenPayload = { j: input.jobId, w: input.worker, d: input.day, e: Math.floor(nowMs / 1000) + ttl };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

/**
 * The payload when the token is genuine, unexpired, for this job and not
 * valid for longer than the maximum lifetime; null otherwise (never a reason,
 * so the page answers every refusal the same way).
 */
export function verifyPrintToken(token: string | null | undefined, jobId: string, secret: string | undefined | null, nowMs: number): PrintTokenPayload | null {
  if (!usableSecret(secret) || typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: PrintTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PrintTokenPayload;
  } catch {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.j !== jobId ||
    typeof payload.w !== 'string' ||
    !WORKER.test(payload.w) ||
    typeof payload.d !== 'string' ||
    !DAY.test(payload.d) ||
    !Number.isSafeInteger(payload.e) ||
    payload.e < now ||
    payload.e > now + PRINT_TOKEN_TTL_SECONDS
  ) {
    return null;
  }
  return payload;
}
