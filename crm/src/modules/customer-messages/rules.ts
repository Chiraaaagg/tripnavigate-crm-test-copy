import type { MessageType, SkipReason } from './contracts';

/**
 * Pure mirror of the database rules (contract 5.5, 5.9, LD5) for screens and
 * tests. The database (authz.cmsg_not_before, customer_message_complete,
 * authz.cmsg_skip_reason) stays the authority.
 */

/** LD5: held back 21:00-08:00 India time until 08:00. */
export const QUIET_TYPES: readonly MessageType[] = Object.freeze([
  'booking_confirmed',
  'hotel_voucher',
  'visa_status',
  'trip_reminder',
  'booking_changed',
]);

/** Three retries after a failed attempt (minutes), then failed. */
export const RETRY_MINUTES: readonly number[] = Object.freeze([5, 20, 60]);

/** At most four attempts in all. */
export const MAX_ATTEMPTS = 4;

/** 5.5: the order of the skip checks. */
export const SKIP_ORDER: readonly SkipReason[] = Object.freeze([
  'test_deal',
  'not_in_pilot',
  'trip_cancelled',
  'change_in_progress',
  'channel_off_on_deal',
  'no_contact',
  'opted_out',
  'template_not_approved',
]);

const IST_OFFSET_MS = 330 * 60_000;

/** When a message queued at `at` may leave: the next 08:00 India time for quiet types queued 21:00-08:00. */
export function notBeforeFor(type: MessageType, at: Date): Date {
  if (!QUIET_TYPES.includes(type)) return new Date(at.getTime());
  const local = new Date(at.getTime() + IST_OFFSET_MS);
  const hour = local.getUTCHours();
  if (hour >= 8 && hour < 21) return new Date(at.getTime());
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (hour >= 21 ? 1 : 0), 8, 0, 0);
  return new Date(day - IST_OFFSET_MS);
}

/**
 * The next try after a failed attempt: attempts made so far 1, 2, 3 -> +5,
 * +20, +60 minutes from the failure; 4 or more -> null (the message fails).
 */
export function nextAttemptAt(attemptsMade: number, failedAt: Date): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1 || attemptsMade >= MAX_ATTEMPTS) return null;
  return new Date(failedAt.getTime() + RETRY_MINUTES[attemptsMade - 1]! * 60_000);
}
