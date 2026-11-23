import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalisePortalDomain } from './config';
import type { BitrixEventAuth } from './events';

/**
 * Event authentication (contract §1). Bitrix outbound webhooks carry no HMAC and
 * no stable event ID; the documented check is equality of
 * `auth[application_token]` with the token shown in the outbound webhook
 * settings. We compare in constant time (over SHA-256 digests, so differing
 * lengths do not short-circuit) and additionally require `auth[member_id]` and
 * `auth[domain]` to equal the configured portal.
 */

export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  // Evaluate both checks; never return early on the first.
  const same = timingSafeEqual(da, db);
  return same && a.length === b.length;
}

export interface PortalIdentity {
  portalMemberId: string;
  portalDomain: string;
}

export type EventAuthDecision = 'ok' | 'missing' | 'bad_token' | 'wrong_portal';

/** Token check only (runs before any database read). */
export function checkApplicationToken(auth: BitrixEventAuth, expectedToken: string): EventAuthDecision {
  if (!auth.applicationToken || !auth.memberId || !auth.domain) return 'missing';
  return constantTimeEqual(auth.applicationToken, expectedToken) ? 'ok' : 'bad_token';
}

/** Portal check against the configured intake portal (never against caller input). */
export function checkPortal(auth: BitrixEventAuth, portal: PortalIdentity): EventAuthDecision {
  if (!auth.memberId || !auth.domain) return 'missing';
  const memberOk = constantTimeEqual(auth.memberId, portal.portalMemberId);
  const domainOk = normalisePortalDomain(auth.domain) === normalisePortalDomain(portal.portalDomain);
  return memberOk && domainOk ? 'ok' : 'wrong_portal';
}

/** Bearer check for the worker route. */
export function checkBearer(header: string | null, secret: string): boolean {
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header ?? '');
  // Always run a comparison so missing/malformed headers take similar time.
  return constantTimeEqual(match?.[1] ?? '', secret) && match !== null;
}
