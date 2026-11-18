import { TYPE_LABEL } from '@/views/customer-messages/labels';
import { CHANNELS, MESSAGE_TYPES, type AdminCustomerMessages, type BoardingPassSlot, type CustomerMessageRow, type DealCustomerMessages, type MessageType, type TaskCustomerMessageStatus, type VoucherFile } from '@/views/customer-messages/types';

/*
 * Synthetic fixtures for the customer messages preview states
 * (acc3-messages-). Masked contacts, a SYN- Deal, invented names; nothing
 * here is real. Template bodies are the English texts of contract §5.7
 * filled with made-up values; the Hindi bodies are placeholders until
 * track A's templates.ts exists.
 */

export const DEAL_ID = 'a0003101-0000-4000-8000-000000003101';
export const ENTITY_ID = 'a0000001-0000-4000-8000-000000000001';
export const TASK_ID = 'a0003201-0000-4000-8000-000000003201';
export const FLIGHT_TASK_ID = 'a0003202-0000-4000-8000-000000003202';

let n = 0;
function msg(over: Partial<CustomerMessageRow>): CustomerMessageRow {
  n += 1;
  return {
    id: `a00033${String(n).padStart(2, '0')}-0000-4000-8000-0000000033${String(n).padStart(2, '0')}`,
    type: 'booking_confirmed',
    channel: 'email',
    language: 'en',
    status: 'delivered',
    skipReason: null,
    createdAt: '2026-11-12T04:30:00Z',
    sentAt: '2026-11-12T04:30:10Z',
    deliveredAt: '2026-11-12T04:30:40Z',
    readAt: null,
    failedAt: null,
    errorCode: null,
    toMasked: 'p***@example.test',
    attachmentKind: null,
    resendOf: null,
    can: { resend: false },
    ...over,
  };
}

const WA = '60xxxxxx21';
export const MESSAGES: CustomerMessageRow[] = [
  msg({ type: 'payment_received', channel: 'whatsapp', status: 'failed', createdAt: '2026-11-13T06:10:00Z', sentAt: null, deliveredAt: null, failedAt: '2026-11-13T07:15:00Z', errorCode: 'invalid_number', toMasked: WA, can: { resend: true } }),
  msg({ type: 'payment_received', channel: 'email', status: 'read', createdAt: '2026-11-13T06:10:00Z', sentAt: '2026-11-13T06:10:05Z', deliveredAt: '2026-11-13T06:10:30Z', readAt: '2026-11-13T08:02:00Z' }),
  msg({ type: 'hotel_voucher', channel: 'email', status: 'queued', createdAt: '2026-11-12T16:40:00Z', sentAt: null, deliveredAt: null, attachmentKind: 'voucher' }),
  msg({ type: 'hotel_voucher', channel: 'whatsapp', status: 'skipped', skipReason: 'template_not_approved', createdAt: '2026-11-12T16:40:00Z', sentAt: null, deliveredAt: null, toMasked: WA, attachmentKind: 'voucher' }),
  msg({ type: 'booking_confirmed', channel: 'whatsapp', status: 'sent', toMasked: WA, deliveredAt: null }),
  msg({ type: 'booking_confirmed', channel: 'email', status: 'delivered' }),
];

export const DEAL_MESSAGES: DealCustomerMessages = {
  dealId: DEAL_ID,
  prefs: { language: 'en', whatsappMasked: WA, emailMasked: 'p***@example.test', whatsappOff: false, emailOff: false, optedOut: false, rowVersion: 3 },
  contactConfirmed: true,
  messages: MESSAGES,
  can: { editPrefs: true, restartWhatsapp: false },
};

export const DEAL_MESSAGES_STOPPED: DealCustomerMessages = {
  ...DEAL_MESSAGES,
  prefs: { ...DEAL_MESSAGES.prefs, language: 'hi', optedOut: true },
  messages: [
    msg({ type: 'trip_reminder', channel: 'whatsapp', language: 'hi', status: 'stopped', skipReason: 'opted_out', createdAt: '2026-11-13T04:30:00Z', sentAt: null, deliveredAt: null, toMasked: WA }),
    msg({ type: 'trip_reminder', channel: 'email', language: 'hi', status: 'delivered', createdAt: '2026-11-13T04:30:00Z' }),
    ...MESSAGES.slice(4).map((m) => ({ ...m, language: 'hi' as const })),
  ],
  can: { editPrefs: true, restartWhatsapp: true },
};

export const DEAL_MESSAGES_UNCONFIRMED: DealCustomerMessages = {
  ...DEAL_MESSAGES,
  prefs: { ...DEAL_MESSAGES.prefs, emailMasked: null },
  contactConfirmed: false,
  messages: [msg({ type: 'booking_confirmed', channel: 'email', status: 'skipped', skipReason: 'no_contact', sentAt: null, deliveredAt: null, toMasked: null, can: { resend: true } })],
};

export const DEAL_MESSAGES_OFF: DealCustomerMessages = {
  ...DEAL_MESSAGES,
  prefs: { ...DEAL_MESSAGES.prefs, whatsappOff: true },
  messages: [msg({ type: 'visa_status', channel: 'whatsapp', status: 'skipped', skipReason: 'channel_off_on_deal', sentAt: null, deliveredAt: null, toMasked: WA }), msg({ type: 'visa_status', channel: 'email', status: 'sent', deliveredAt: null })],
};

export const DEAL_MESSAGES_EMPTY: DealCustomerMessages = { ...DEAL_MESSAGES, messages: [] };

export const DEAL_MESSAGES_ACCOUNTS: DealCustomerMessages = {
  ...DEAL_MESSAGES,
  messages: MESSAGES.map((m) => ({ ...m, can: { resend: false } })),
  can: { editPrefs: false, restartWhatsapp: false },
};

/* Settings */
const FILL: Record<MessageType, string> = {
  booking_confirmed: 'Hello Synthetic Guest, your booking SYN-JOD-101 with Holiday Chacha is confirmed. Trip: Udaipur, 20 Dec 2026 to 24 Dec 2026, 3 traveller(s). We will send your documents here.',
  payment_received: 'Hello Synthetic Guest, we have received your payment of Rs 25,000.00 for booking SYN-JOD-101. Balance: Rs 10,000.00. Thank you.',
  hotel_voucher: 'Hello Synthetic Guest, your hotel voucher for Synthetic Lake Hotel (20 Dec 2026 to 24 Dec 2026), booking SYN-JOD-101, is attached.',
  e_ticket: 'Hello Synthetic Guest, your e-ticket for booking SYN-JOD-101 is attached. Please check the names and dates.',
  boarding_pass: 'Hello Synthetic Guest, your boarding pass for booking SYN-JOD-101 is attached.',
  visa_status: 'Hello Synthetic Guest, visa update for Synthetic Traveller on booking SYN-JOD-101: approved. Your Holiday Chacha contact will call you with the next steps.',
  trip_reminder: 'Hello Synthetic Guest, your trip to Udaipur (booking SYN-JOD-101) starts on 20 Dec 2026 — 3 day(s) to go. Please keep your ID and tickets ready.',
  refund_paid: 'Hello Synthetic Guest, we have paid your refund of Rs 5,000.00 for booking SYN-JOD-101. It may take a few working days to show in your account.',
  booking_changed: 'Hello Synthetic Guest, your booking SYN-JOD-101 has been updated. Trip: Udaipur, 20 Dec 2026 to 25 Dec 2026. Your Holiday Chacha contact will share the details.',
};
const FOOTER_EN = '\n\nReply STOP to stop these messages';
const FOOTER_HI = '\n\nये संदेश बंद करने के लिए STOP लिखें';

const approved = new Set<string>(['booking_confirmed', 'payment_received']);
export const ADMIN: AdminCustomerMessages = {
  entityId: ENTITY_ID,
  switches: MESSAGE_TYPES.flatMap((type) =>
    CHANNELS.map((channel) => ({ type, channel, enabled: (type === 'booking_confirmed' || type === 'payment_received') && (channel === 'email' || approved.has(type)), rowVersion: 1 })),
  ),
  pilotOnly: true,
  pilot: [
    { dealId: DEAL_ID, dealReference: 'SYN-JOD-101', addedByName: 'Synthetic Owner Jodhpur', addedAt: '2026-11-12T05:00:00Z' },
    { dealId: 'a0003102-0000-4000-8000-000000003102', dealReference: 'SYN-JOD-102', addedByName: 'Synthetic Owner Jodhpur', addedAt: '2026-11-12T05:02:00Z' },
  ],
  templates: MESSAGE_TYPES.flatMap((type) =>
    (['en', 'hi'] as const).map((language) => ({
      templateCode: `tn_${type}_${language}_v1`,
      type,
      language,
      status: approved.has(type) ? ('approved' as const) : type === 'hotel_voucher' ? (language === 'en' ? ('approved' as const) : ('submitted' as const)) : type === 'refund_paid' && language === 'hi' ? ('rejected' as const) : ('not_submitted' as const),
      updatedAt: approved.has(type) ? '2026-11-12T06:00:00Z' : null,
    })),
  ),
  previews: MESSAGE_TYPES.flatMap((type) => [
    { type, language: 'en' as const, subject: `${TYPE_LABEL[type]} — SYN-JOD-101`, body: FILL[type] + FOOTER_EN },
    { type, language: 'hi' as const, subject: `${TYPE_LABEL[type]} — SYN-JOD-101`, body: `[Hindi text from track A's templates.ts — same variables, same order]${FOOTER_HI}` },
  ]),
  timer: { enabled: false, lastOkAt: null, queueOldestMinutes: null },
  providers: [
    { key: 'RESEND_API_KEY', configured: true },
    { key: 'RESEND_WEBHOOK_SECRET', configured: false },
    { key: 'INTERAKT_API_KEY', configured: false },
    { key: 'INTERAKT_WEBHOOK_SECRET', configured: false },
    { key: 'TIMER_SECRET', configured: false },
  ],
};

export const ADMIN_RUNNING: AdminCustomerMessages = {
  ...ADMIN,
  pilotOnly: false,
  timer: { enabled: true, lastOkAt: '2026-11-13T09:41:00Z', queueOldestMinutes: 22 },
  providers: ADMIN.providers.map((p) => ({ ...p, configured: true })),
};

/* Task panels */
export const VOUCHERS: VoucherFile[] = [
  { evidenceId: 'a0003401-0000-4000-8000-000000003401', fileName: 'synthetic-lake-hotel-voucher.pdf', storedAt: '2026-11-12T10:00:00Z', readyAt: '2026-11-12T10:05:00Z', readyByName: 'Synthetic Purchase Jodhpur' },
  { evidenceId: 'a0003402-0000-4000-8000-000000003402', fileName: 'synthetic-voucher-room-2.pdf', storedAt: '2026-11-13T05:00:00Z', readyAt: null, readyByName: null },
];
export const VOUCHER_STATUS: TaskCustomerMessageStatus = {
  taskId: TASK_ID,
  items: [{ evidenceId: VOUCHERS[0]!.evidenceId, messageType: 'hotel_voucher', email: { state: 'sent' }, whatsapp: { state: 'failed' } }],
};

export const NOW = '2026-11-13T10:00:00Z';
export const SLOTS: BoardingPassSlot[] = [
  { key: 's1-p1', sectorId: 'a0003501-0000-4000-8000-000000003501', passengerLabel: 'Passenger 1 (adult)', sectorLabel: 'JDH → DEL, flight SY 101', departureAt: '2026-11-14T03:30:00Z', file: { evidenceId: 'a0003601-0000-4000-8000-000000003601', fileName: 'bp-passenger-1-jdh-del.pdf', storedAt: '2026-11-13T08:00:00Z' } },
  { key: 's1-p2', sectorId: 'a0003501-0000-4000-8000-000000003501', passengerLabel: 'Passenger 2 (adult)', sectorLabel: 'JDH → DEL, flight SY 101', departureAt: '2026-11-14T03:30:00Z', file: null },
  { key: 's2-p1', sectorId: 'a0003502-0000-4000-8000-000000003502', passengerLabel: 'Passenger 1 (adult)', sectorLabel: 'DEL → JDH, flight SY 102', departureAt: '2026-11-20T12:00:00Z', file: null },
];
export const BP_STATUS: TaskCustomerMessageStatus = {
  taskId: FLIGHT_TASK_ID,
  items: [{ evidenceId: SLOTS[0]!.file!.evidenceId, messageType: 'boarding_pass', email: { state: 'sent' }, whatsapp: { state: 'waiting' } }],
};

/** Addendum L11: a WhatsApp request left and no answer came (status `unknown`); the WhatsApp number is a separate one. */
export const DEAL_MESSAGES_UNKNOWN: DealCustomerMessages = {
  ...DEAL_MESSAGES,
  prefs: { ...DEAL_MESSAGES.prefs, whatsappSameAsMobile: false },
  messages: [
    msg({ id: 'a0004899-0000-4000-8000-000000004899', type: 'hotel_voucher', channel: 'whatsapp', status: 'unknown', createdAt: '2026-11-13T05:00:00Z', sentAt: null, deliveredAt: null, failedAt: '2026-11-13T05:01:00Z', errorCode: 'unknown_outcome', toMasked: WA, attachmentKind: 'voucher', can: { resend: true } }),
    ...MESSAGES,
  ],
};
