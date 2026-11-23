import { z } from 'zod';
import {
  CHANNELS,
  LANGUAGES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  PROVIDER_KEYS,
  SEND_ERROR_CODES,
  SEND_STATES,
  SKIP_REASONS,
  TEMPLATE_STATUSES,
} from './contracts';

/**
 * DTOs of the customer message reads (contract 5.6 R-A3, 5.10 R-A1, R-A2).
 * Every key is listed; unknown keys are dropped (never passed on), so params,
 * amounts and addresses can never reach a page through these schemas.
 */

const uuid = z.string().uuid();
const at = z.string().min(1).max(40);
const masked = z.string().max(120);

export const CustomerMessageItemSchema = z.object({
  id: uuid,
  type: z.enum(MESSAGE_TYPES),
  channel: z.enum(CHANNELS),
  language: z.enum(LANGUAGES),
  status: z.enum(MESSAGE_STATUSES),
  skipReason: z.enum(SKIP_REASONS).nullable(),
  createdAt: at,
  sentAt: at.nullable(),
  deliveredAt: at.nullable(),
  readAt: at.nullable(),
  failedAt: at.nullable(),
  errorCode: z.enum(SEND_ERROR_CODES).nullable(),
  toMasked: masked.nullable(),
  attachmentKind: z.enum(['voucher', 'e_ticket', 'boarding_pass']).nullable(),
  resendOf: uuid.nullable(),
  can: z.object({ resend: z.boolean() }),
});
export type CustomerMessageItem = z.infer<typeof CustomerMessageItemSchema>;

export const DealCustomerMessagesSchema = z.object({
  dealId: uuid,
  prefs: z.object({
    language: z.enum(LANGUAGES),
    whatsappMasked: masked.nullable(),
    emailMasked: masked.nullable(),
    /** True while WhatsApp goes to the booking contact's mobile; post it only when the person changes that choice. */
    whatsappSameAsMobile: z.boolean().optional(),
    whatsappOff: z.boolean(),
    emailOff: z.boolean(),
    optedOut: z.boolean(),
    rowVersion: z.number().int().nonnegative(),
  }),
  contactConfirmed: z.boolean(),
  messages: z.array(CustomerMessageItemSchema).max(100),
  can: z.object({ editPrefs: z.boolean(), restartWhatsapp: z.boolean() }),
});
export type DealCustomerMessages = z.infer<typeof DealCustomerMessagesSchema>;

const sendState = z.object({ state: z.enum(SEND_STATES) });
export const TaskCustomerMessageStatusSchema = z.object({
  taskId: uuid,
  items: z.array(z.object({
    evidenceId: uuid,
    messageType: z.enum(['hotel_voucher', 'e_ticket', 'boarding_pass']),
    email: sendState,
    whatsapp: sendState,
  })),
});
export type TaskCustomerMessageStatus = z.infer<typeof TaskCustomerMessageStatusSchema>;

/** R-A2 as the database returns it (previews and provider flags are added by the server). */
export const AdminCustomerMessagesDbSchema = z.object({
  entityId: uuid,
  switches: z.array(z.object({
    type: z.enum(MESSAGE_TYPES),
    channel: z.enum(CHANNELS),
    enabled: z.boolean(),
    rowVersion: z.number().int().positive(),
    updatedAt: at,
  })),
  pilotOnly: z.boolean(),
  pilot: z.array(z.object({ dealId: uuid, dealReference: z.string().max(60), addedAt: at })),
  templates: z.array(z.object({
    templateCode: z.string().regex(/^tn_[a-z_]+_(en|hi)_v[0-9]+$/),
    status: z.enum(TEMPLATE_STATUSES),
    rowVersion: z.number().int().positive(),
    updatedAt: at,
  })),
  providers: z.array(z.object({ key: z.enum(PROVIDER_KEYS), configured: z.boolean().nullable() })),
  timer: z.object({
    enabled: z.boolean(),
    configured: z.boolean(),
    lastOkAt: at.nullable(),
    queueOldestMinutes: z.number().int().nullable(),
  }),
  counts: z.object({ failedLast24h: z.number().int(), enqueueFailuresLast24h: z.number().int() }),
});
export type AdminCustomerMessagesDb = z.infer<typeof AdminCustomerMessagesDbSchema>;

export const AdminCustomerMessagesSchema = AdminCustomerMessagesDbSchema.extend({
  providers: z.array(z.object({ key: z.enum(PROVIDER_KEYS), configured: z.boolean() })),
  previews: z.array(z.object({
    type: z.enum(MESSAGE_TYPES),
    language: z.enum(LANGUAGES),
    templateCode: z.string(),
    subject: z.string(),
    whatsappText: z.string(),
    header: z.enum(['none', 'document']),
  })),
});
export type AdminCustomerMessages = z.infer<typeof AdminCustomerMessagesSchema>;

export const PrefsSetResultSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  dealId: uuid,
  rowVersion: z.number().int().positive(),
});
export const OutcomeResultSchema = z.object({ outcome: z.enum(['created', 'updated', 'existing']) }).passthrough();
export const ResendResultSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  messageId: uuid,
  status: z.enum(MESSAGE_STATUSES),
  skipReason: z.enum(SKIP_REASONS).nullable(),
});
export const SettingResultSchema = z.object({ changed: z.boolean() }).passthrough();

/** deal_message_prefs_get: Book now / Deal language and WhatsApp choice (masks only). */
export const DealMessagePrefsSchema = z.object({
  dealId: uuid,
  language: z.enum(LANGUAGES),
  whatsappSameAsMobile: z.boolean(),
  whatsappMasked: masked.nullable(),
  emailOverrideMasked: masked.nullable(),
  whatsappOff: z.boolean(),
  emailOff: z.boolean(),
  rowVersion: z.number().int().nonnegative(),
});
export type DealMessagePrefs = z.infer<typeof DealMessagePrefsSchema>;

/** customer_message_deal_lookup: a Deal by its exact reference (Super Admin). */
export const PilotDealLookupSchema = z.object({
  dealId: uuid,
  dealReference: z.string().max(60),
  branchName: z.string().max(120),
  inPilot: z.boolean(),
});
export type PilotDealLookup = z.infer<typeof PilotDealLookupSchema>;

/** task_customer_files: the Purchase voucher / Flight boarding pass slot of a task. */
export const TaskCustomerFilesSchema = z.object({
  taskId: uuid,
  kind: z.enum(['customer_voucher', 'boarding_pass']),
  taskConfirmed: z.boolean(),
  can: z.object({ upload: z.boolean(), markReady: z.boolean() }),
  due: z.boolean(),
  files: z.array(z.object({
    evidenceId: uuid,
    fileName: z.string().max(120),
    status: z.enum(['pending_upload', 'stored', 'failed']),
    storedAt: at.nullable(),
    readyAt: at.nullable(),
    /** The passenger and flight a boarding pass belongs to (null = not linked; vouchers always null). */
    sectorId: uuid.nullable(),
    passengerSeq: z.number().int().min(1).max(100).nullable(),
    email: sendState,
    whatsapp: sendState,
  })),
  /** Flight: one slot per active flight and traveller of the task ([] for Purchase). */
  slots: z.array(z.object({
    sectorId: uuid,
    sectorLabel: z.string().max(80),
    passengerSeq: z.number().int().min(1).max(100),
    passengerName: z.string().max(120),
    evidenceId: uuid.nullable(),
    email: sendState,
    whatsapp: sendState,
  })),
});
export type TaskCustomerFiles = z.infer<typeof TaskCustomerFilesSchema>;

export const EvidenceBegunSchema = z.object({ evidenceId: uuid, objectPath: z.string().min(1).max(300) });
export const EvidenceFinishedSchema = z.object({ evidenceId: uuid, status: z.enum(['pending_upload', 'stored', 'failed', 'removed']) });
