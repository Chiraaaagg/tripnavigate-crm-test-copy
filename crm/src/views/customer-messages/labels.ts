import type { StatusTone } from '@/components/ui/badge';
import type {
  AdminCustomerMessages,
  Channel,
  ChannelSendState,
  CustomerMessageRow,
  Language,
  MessageType,
  SendErrorCode,
  SkipReason,
  TemplateStatus,
} from './types';

/*
 * Words for the customer-messages screens (contract §5, §15 screens 1–4).
 * Every status is an icon plus these words, never colour alone. Pure and
 * unit-tested (tests/unit/acc3u-messages-labels.test.ts).
 */

export const TYPE_LABEL: Record<MessageType, string> = {
  booking_confirmed: 'Booking confirmed',
  payment_received: 'Payment received',
  hotel_voucher: 'Hotel voucher',
  e_ticket: 'E-ticket',
  boarding_pass: 'Boarding pass',
  visa_status: 'Visa status',
  trip_reminder: 'Trip reminder',
  refund_paid: 'Refund paid',
  booking_changed: 'Booking updated',
};

/** When each message goes (Settings; owner-approved list of 12 November 2026). */
export const TYPE_WHEN: Record<MessageType, string> = {
  booking_confirmed: 'Once, when Accounts first approve the booking.',
  payment_received: 'When a payment is verified (a cheque: when it clears).',
  hotel_voucher: 'When Purchase marks a hotel voucher ready for the customer.',
  e_ticket: 'When the e-ticket is stored and the tickets are confirmed.',
  boarding_pass: 'When Flight uploads a boarding pass.',
  visa_status: 'When the visa result is recorded.',
  trip_reminder: '3 days and 1 day before the trip starts.',
  refund_paid: 'When a refund payout is recorded.',
  booking_changed: 'When an approved change is applied to the booking.',
};

/** Held back between 21:00 and 08:00 India time (LD5). */
export const QUIET_HOURS_TYPES: readonly MessageType[] = ['booking_confirmed', 'hotel_voucher', 'visa_status', 'trip_reminder', 'booking_changed'];

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'E-mail', whatsapp: 'WhatsApp' };
export const LANGUAGE_LABEL: Record<Language, string> = { en: 'English', hi: 'Hindi' };

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  test_deal: 'test Deal, nothing is sent',
  not_in_pilot: 'this Deal is not on the pilot list',
  no_contact: 'no confirmed contact for this channel',
  channel_off_on_deal: 'this channel is switched off on the Deal',
  opted_out: 'the customer replied STOP',
  trip_cancelled: 'the trip is cancelled',
  change_in_progress: 'a booking change is in progress',
  template_not_approved: 'WhatsApp has not approved this message text yet',
  file_missing: 'the file is missing',
  switched_off: 'this message was switched off before it was sent',
};

export const ERROR_TEXT: Record<SendErrorCode, string> = {
  not_configured: 'sending is not set up yet',
  rejected: 'the provider refused it',
  provider_error: 'the provider had a problem',
  network: 'the connection failed',
  bad_response: 'the provider gave an unclear answer',
  bounced: 'the e-mail address bounced',
  invalid_number: 'the number is not on WhatsApp',
  expired: 'the message expired before delivery',
  unknown_outcome: 'no answer came from the provider',
};

export interface StatusWord {
  label: string;
  tone: StatusTone;
}

/** The status word of one message row (contract §15 screen 2). */
export function messageStatusWord(row: Pick<CustomerMessageRow, 'status' | 'skipReason' | 'errorCode'>): StatusWord {
  switch (row.status) {
    case 'queued':
    case 'sending':
      return { label: 'Waiting', tone: 'info' };
    case 'sent':
      return { label: 'Sent', tone: 'brand' };
    case 'delivered':
      return { label: 'Delivered', tone: 'success' };
    case 'read':
      return { label: 'Read', tone: 'success' };
    case 'failed':
      return { label: `Failed — ${row.errorCode ? ERROR_TEXT[row.errorCode] : 'reason not given'}`, tone: 'danger' };
    case 'unknown':
      // Addendum L11: it may have reached the customer; never retried by itself.
      return { label: 'Failed — check before sending again', tone: 'danger' };
    case 'stopped':
      return { label: `Stopped — ${row.skipReason ? SKIP_REASON_TEXT[row.skipReason] : 'the customer replied STOP'}`, tone: 'warning' };
    case 'skipped':
      return { label: `Skipped — ${row.skipReason ? SKIP_REASON_TEXT[row.skipReason] : 'reason not given'}`, tone: 'neutral' };
  }
}

/** The time that goes with the status (latest step reached). */
export function messageStatusAt(row: Pick<CustomerMessageRow, 'status' | 'createdAt' | 'sentAt' | 'deliveredAt' | 'readAt' | 'failedAt'>): string {
  if (row.status === 'read' && row.readAt) return row.readAt;
  if (row.status === 'delivered' && row.deliveredAt) return row.deliveredAt;
  if (row.status === 'sent' && row.sentAt) return row.sentAt;
  if ((row.status === 'failed' || row.status === 'unknown') && row.failedAt) return row.failedAt;
  return row.createdAt;
}

export const SEND_STATE_WORD: Record<ChannelSendState, StatusWord> = {
  not_sent: { label: 'Not sent yet', tone: 'neutral' },
  waiting: { label: 'Waiting to send', tone: 'info' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Could not be sent', tone: 'danger' },
  off: { label: 'Off', tone: 'neutral' },
};

export const TEMPLATE_STATUS_WORD: Record<TemplateStatus, StatusWord> = {
  not_submitted: { label: 'Not sent to WhatsApp yet', tone: 'neutral' },
  submitted: { label: 'Waiting for WhatsApp', tone: 'info' },
  approved: { label: 'Approved by WhatsApp', tone: 'success' },
  rejected: { label: 'Rejected by WhatsApp', tone: 'danger' },
};

/** Provider key names shown on Settings (names only; values never leave the server). */
export const PROVIDER_KEY_LABEL: Record<string, string> = {
  RESEND_API_KEY: 'E-mail sending key',
  RESEND_WEBHOOK_SECRET: 'E-mail delivery-report secret',
  INTERAKT_API_KEY: 'WhatsApp sending key',
  INTERAKT_WEBHOOK_SECRET: 'WhatsApp delivery-report secret',
  TIMER_SECRET: 'Timer secret',
};

/**
 * Why the WhatsApp switch of a type cannot be turned on now, or null. Both
 * language templates must be approved (contract 5.9 A7, refusal
 * `template_not_approved`). Turning a switch off is never blocked.
 */
export function whatsappSwitchBlock(type: MessageType, templates: AdminCustomerMessages['templates'], enabled: boolean): string | null {
  if (enabled) return null;
  const mine = templates.filter((t) => t.type === type);
  const waiting = (['en', 'hi'] as const).filter((lang) => !mine.some((t) => t.language === lang && t.status === 'approved'));
  if (waiting.length === 0) return null;
  return `WhatsApp has not approved the ${waiting.map((l) => LANGUAGE_LABEL[l]).join(' and ')} text yet.`;
}

/** A boarding pass is due: the flight leaves within 24 hours and no file is stored. */
export function boardingPassDue(departureAt: string, hasFile: boolean, now: Date): boolean {
  if (hasFile) return false;
  const t = Date.parse(departureAt);
  if (Number.isNaN(t)) return false;
  const ms = t - now.getTime();
  return ms > 0 && ms <= 24 * 60 * 60 * 1000;
}

/** Queue age in plain words (Settings timer line). */
export function queueAgeText(minutes: number | null): string {
  if (minutes === null) return 'No messages waiting';
  if (minutes < 1) return 'Oldest waiting message: under a minute';
  if (minutes < 60) return `Oldest waiting message: ${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `Oldest waiting message: ${h} h ${minutes % 60} min`;
}

/** Field names of the A1 preferences form (Addendum L3 shape). */
export const PREFS_FIELD = {
  dealId: 'dealId',
  expectedRowVersion: 'expectedRowVersion',
  language: 'language',
  whatsappMobile: 'whatsappMobile',
  whatsappSameAsMobile: 'whatsappSameAsMobile',
  emailOverride: 'emailOverride',
  whatsappOff: 'whatsappOff',
  emailOff: 'emailOff',
  offReason: 'offReason',
} as const;

/** Frozen refusal texts (contract §13) the preview gallery shows; the server actions return the same. */
export const MESSAGES_REFUSAL = {
  template_not_approved: 'WhatsApp has not approved this message text yet.',
  version_changed: 'Someone changed this just now. Reload the page and try again.',
  wrong_state: 'This message cannot be sent again in its current state.',
  not_authorized: 'You cannot do this.',
  invalid_input: 'Check the highlighted field.',
} as const;
