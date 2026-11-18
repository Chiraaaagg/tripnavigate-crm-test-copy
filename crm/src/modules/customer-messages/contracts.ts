/**
 * Customer messages (Accounts phase 3, track A): frozen vocabularies,
 * refusal tokens and staff messages, form field names (Phase 2 Addendum L3
 * shape) and status words.
 *
 * Contract: implementation/accounts-phase3-2026-11-12/contract.md sections
 * 5.3-5.10, 13, 14, LD3-LD10 and Addendum O1 (frozen 12 Nov 2026). Database:
 * crm/supabase/migrations/20261205000110..0140. The nine messages only; no bill
 * is ever sent to a customer.
 */

export const MESSAGE_TYPES = [
  'booking_confirmed',
  'payment_received',
  'hotel_voucher',
  'e_ticket',
  'boarding_pass',
  'visa_status',
  'trip_reminder',
  'refund_paid',
  'booking_changed',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const CHANNELS = ['email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];

/** `unknown`: the request left and no answer came back; never retried automatically (staff check, then Send again). */
export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'stopped', 'unknown'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Skip reasons (5.4) plus `switched_off` (the type x channel switch went Off
 * after the message was queued; addition reported to the lead).
 */
export const SKIP_REASONS = [
  'test_deal',
  'not_in_pilot',
  'no_contact',
  'channel_off_on_deal',
  'opted_out',
  'trip_cancelled',
  'change_in_progress',
  'template_not_approved',
  'file_missing',
  'switched_off',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SEND_ERROR_CODES = [
  'not_configured',
  'rejected',
  'provider_error',
  'network',
  'bad_response',
  'bounced',
  'invalid_number',
  'expired',
  'unknown_outcome',
] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];

/** LD9: the only states a department sees for its own file. */
export const SEND_STATES = ['not_sent', 'waiting', 'sent', 'failed', 'off'] as const;
export type SendState = (typeof SEND_STATES)[number];

export const TEMPLATE_STATUSES = ['not_submitted', 'submitted', 'approved', 'rejected'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const MESSAGE_TYPE_LABELS: Readonly<Record<MessageType, string>> = Object.freeze({
  booking_confirmed: 'Booking confirmed',
  payment_received: 'Payment received',
  hotel_voucher: 'Hotel voucher',
  e_ticket: 'E-ticket',
  boarding_pass: 'Boarding pass',
  visa_status: 'Visa status',
  trip_reminder: 'Trip reminder',
  refund_paid: 'Refund paid',
  booking_changed: 'Booking changed',
});

/** Status words on the Deal card (never colour alone). */
export const MESSAGE_STATUS_WORDS: Readonly<Record<MessageStatus, string>> = Object.freeze({
  queued: 'Waiting',
  sending: 'Waiting',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  skipped: 'Skipped',
  stopped: 'Stopped',
  unknown: 'Not sure it was sent',
});

export const SKIP_REASON_TEXT: Readonly<Record<SkipReason, string>> = Object.freeze({
  test_deal: 'Test Deal: nothing is sent to customers.',
  not_in_pilot: 'This Deal is not on the pilot list.',
  no_contact: 'No confirmed contact for this channel.',
  channel_off_on_deal: 'This channel is switched off on the Deal.',
  opted_out: 'The customer replied STOP on WhatsApp.',
  trip_cancelled: 'The trip is cancelled.',
  change_in_progress: 'A change to the booking is in progress.',
  template_not_approved: 'WhatsApp has not approved this message text yet.',
  file_missing: 'The file is no longer available.',
  switched_off: 'This message was switched off before it was sent.',
});

export const SEND_ERROR_TEXT: Readonly<Record<SendErrorCode, string>> = Object.freeze({
  not_configured: 'Sending is not set up yet.',
  rejected: 'The provider refused the message.',
  provider_error: 'The provider had a problem.',
  network: 'The provider could not be reached.',
  bad_response: 'The provider gave an unexpected answer.',
  bounced: 'The e-mail bounced.',
  invalid_number: 'The WhatsApp number is not valid.',
  expired: 'The message could not be sent in time.',
  unknown_outcome: 'No answer from the provider: check with the customer before sending again.',
});

/** Refusal tokens of the customer message commands and their SQLSTATE (section 13). */
export const MESSAGE_ERROR_STATES = {
  not_authorized: '42501',
  invalid_input: '22023',
  version_changed: '40001',
  not_ready: '55000',
  wrong_state: '55000',
  template_not_approved: '55000',
  not_found: 'P0002',
  evidence_rejected: '22023',
  already_confirmed: '55000',
  task_closed: '55000',
  already_recorded: '55000',
} as const;
export type MessageErrorCode = keyof typeof MESSAGE_ERROR_STATES;

export const MESSAGE_ERROR_TEXT: Readonly<Record<MessageErrorCode | 'session' | 'upload_failed', string>> = Object.freeze({
  not_authorized: 'You cannot do this for this Deal.',
  invalid_input: 'Check the highlighted field.',
  version_changed: 'Someone else changed this just now. Reload and try again.',
  not_ready: 'This is not ready yet.',
  wrong_state: 'This message cannot be sent again now.',
  template_not_approved: 'WhatsApp has not approved this message text yet.',
  not_found: 'This could not be found.',
  evidence_rejected: 'Upload a PDF, JPG, PNG or WebP file up to 4 MB.',
  already_confirmed: 'This booking is already confirmed with the supplier.',
  task_closed: 'This task is closed.',
  already_recorded: 'This file already belongs to another passenger or flight.',
  upload_failed: 'The file could not be saved. Please try again.',
  session: 'Your session ended. Sign in again.',
});

export const NOT_READY_HINT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  file: 'Upload the voucher file first and wait until it is stored.',
  not_confirmed: 'The supplier has not confirmed this booking yet.',
});

export const NOT_FOUND_DEAL_TEXT = 'No Deal with this reference in this company.';

/** Boarding pass stored (and queued) but the passenger / flight link was refused: no re-upload. */
export const BOARDING_PASS_NOT_LINKED_TEXT = 'Saved and sent; not linked to this passenger.';

export const MESSAGE_UNKNOWN_OUTCOME_TEXT = 'Something went wrong. Reload the page to see what was saved.';

/** Form field names (Addendum L3). */
export const MESSAGE_FIELD = {
  dealId: 'dealId',
  entityId: 'entityId',
  messageId: 'messageId',
  evidenceId: 'evidenceId',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  language: 'language',
  whatsappMobile: 'whatsappMobile',
  whatsappSameAsMobile: 'whatsappSameAsMobile',
  emailOverride: 'emailOverride',
  whatsappOff: 'whatsappOff',
  emailOff: 'emailOff',
  offReason: 'offReason',
  reason: 'reason',
  type: 'type',
  channel: 'channel',
  enabled: 'enabled',
  pilotOnly: 'pilotOnly',
  inPilot: 'inPilot',
  templateCode: 'templateCode',
  status: 'status',
  dealReference: 'dealReference',
  taskId: 'taskId',
  file: 'file',
  sectorId: 'sectorId',
  passengerSeq: 'passengerSeq',
} as const;

/** The Super Admin page of customer messages and the timer (track U). */
export const ADMIN_MESSAGES_PATH = '/app/admin/customer-messages';

export type MessageActionResult<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; code: MessageErrorCode | 'session' | 'upload_failed'; message: string; field?: string };

/** Provider settings the owner saves in Vercel (names only; values never leave the server). */
export const PROVIDER_KEYS = ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'INTERAKT_API_KEY', 'INTERAKT_WEBHOOK_SECRET', 'TIMER_SECRET'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
