/*
 * Typed adapter for the customer-messages screens (contract §5, track A).
 * These mirror the frozen read shapes R-A1, R-A2 and R-A3 key for key, so
 * the views can be built and previewed before track A's module exists. When
 * `@/modules/customer-messages/dto` lands, the route maps (or re-exports) its
 * types here; the views keep importing from this file.
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

export type Language = 'en' | 'hi';

/** `unknown` (Addendum L11): the request left and no answer came; never retried automatically. */
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'stopped' | 'unknown';

export type SkipReason =
  | 'test_deal'
  | 'not_in_pilot'
  | 'no_contact'
  | 'channel_off_on_deal'
  | 'opted_out'
  | 'trip_cancelled'
  | 'change_in_progress'
  | 'template_not_approved'
  | 'file_missing'
  /** Track A addition: the type × channel switch went Off after queueing. */
  | 'switched_off';

export type SendErrorCode = 'not_configured' | 'rejected' | 'provider_error' | 'network' | 'bad_response' | 'bounced' | 'invalid_number' | 'expired' | 'unknown_outcome';

/** Which file went with the message (track A's R-A1 `attachmentKind`). */
export type AttachmentKind = 'voucher' | 'e_ticket' | 'boarding_pass';

/** R-A1 `public.deal_customer_messages(p_deal_id)` — SO, branch M, A; null for everyone else. */
export interface DealCustomerMessages {
  dealId: string;
  prefs: {
    language: Language;
    whatsappMasked: string | null;
    emailMasked: string | null;
    whatsappOff: boolean;
    emailOff: boolean;
    optedOut: boolean;
    rowVersion: number;
    /** Addendum L11: the stored "WhatsApp is the same as mobile" choice (absent on older reads). */
    whatsappSameAsMobile?: boolean;
  };
  contactConfirmed: boolean;
  messages: CustomerMessageRow[];
  can: { editPrefs: boolean; restartWhatsapp: boolean };
}

export interface CustomerMessageRow {
  id: string;
  type: MessageType;
  channel: Channel;
  language: Language;
  status: MessageStatus;
  skipReason: SkipReason | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  errorCode: SendErrorCode | null;
  toMasked: string | null;
  attachmentKind: AttachmentKind | null;
  resendOf: string | null;
  can: { resend: boolean };
}

export type TemplateStatus = 'not_submitted' | 'submitted' | 'approved' | 'rejected';

/** R-A2 `public.admin_customer_messages(p_entity)` — Super Admin only. */
export interface AdminCustomerMessages {
  entityId: string;
  switches: { type: MessageType; channel: Channel; enabled: boolean; rowVersion: number }[];
  pilotOnly: boolean;
  pilot: { dealId: string; dealReference: string; addedByName?: string | null; addedAt: string }[];
  templates: { templateCode: string; type: MessageType; language: Language; status: TemplateStatus; updatedAt: string | null }[];
  previews: { type: MessageType; language: Language; subject: string; body: string }[];
  timer: { enabled: boolean; lastOkAt: string | null; queueOldestMinutes: number | null; /** false: the database job pieces are not set up yet. */ configured?: boolean };
  providers: { key: string; configured: boolean }[];
}

/** R-A3 `public.task_customer_message_status(p_task_id)` — the task's own department reader. */
export type ChannelSendState = 'not_sent' | 'waiting' | 'sent' | 'failed' | 'off';
export interface TaskCustomerMessageStatus {
  taskId: string;
  items: { evidenceId: string; messageType: MessageType; email: { state: ChannelSendState }; whatsapp: { state: ChannelSendState } }[];
}

/** Purchase task voucher file as the panel shows it (from the task's evidence list). */
export interface VoucherFile {
  evidenceId: string;
  fileName: string;
  storedAt: string;
  readyAt: string | null;
  readyByName: string | null;
}

/** One boarding-pass slot: a passenger on a flight sector. */
export interface BoardingPassSlot {
  key: string;
  sectorId: string;
  passengerLabel: string;
  sectorLabel: string;
  departureAt: string;
  file: { evidenceId: string; fileName: string; storedAt: string } | null;
}
