import { z } from 'zod';
import {
  NOTICE_DEPARTMENTS,
  NOTICE_KINDS,
  NOTICE_LINK_KINDS,
  NOTICE_PRIORITIES,
  NOTICE_RESOLVED_REASONS,
  type NoticeCountsDTO,
  type NoticeHistoryDTO,
  type NoticeInboxDTO,
  type NoticeItemDTO,
  type NoticeMarkAllResult,
  type NoticeMarkResult,
  type NoticePreferencesDTO,
  type PushDevicesListDTO,
} from './contracts';

/**
 * zod schemas of every notice read and command result (contract 8.4, 7.5).
 * Every key is listed; unknown keys are stripped, so a key the database adds
 * later never reaches a page unreviewed. params keep only the allowlisted
 * template keys with short reference-like values.
 */

const ts = z.string().min(1);
const uuid = z.uuid();
const paramText = z.string().min(1).max(60).regex(/^[A-Za-z0-9 _./-]+$/);

export const NoticeParamsSchema = z.object({
  dealReference: paramText.optional(),
  department: z.enum(NOTICE_DEPARTMENTS).optional(),
  refNo: paramText.optional(),
  serviceType: paramText.optional(),
  versionNo: z.number().int().positive().optional(),
  status: paramText.optional(),
});

export const NoticeLinkSchema = z.object({
  kind: z.enum(NOTICE_LINK_KINDS),
  id: uuid,
});

export const NoticeItemSchema = z.object({
  noticeId: uuid,
  seq: z.number().int().positive(),
  kind: z.enum(NOTICE_KINDS),
  priority: z.enum(NOTICE_PRIORITIES),
  escalated: z.boolean(),
  createdAt: ts,
  readAt: ts.nullable(),
  doneAt: ts.nullable(),
  resolvedAt: ts.nullable(),
  resolvedReason: z.enum(NOTICE_RESOLVED_REASONS).nullable(),
  dealId: uuid.nullable(),
  dealReference: z.string().nullable(),
  taskId: uuid.nullable(),
  department: z.enum(NOTICE_DEPARTMENTS).nullable(),
  params: NoticeParamsSchema,
  link: NoticeLinkSchema.nullable(),
}) satisfies z.ZodType<NoticeItemDTO>;

export const NoticeInboxSchema = z.object({
  enabled: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  urgentCount: z.number().int().nonnegative(),
  latestSeq: z.number().int().positive().nullable(),
  soundOn: z.boolean(),
  /** Accounts phase 3 (8.5): the closed-browser alerts switch; missing (an older database) = Off via pushEnabledOf. */
  pushEnabled: z.boolean().optional(),
  /** Accounts phase 2 (8.5): missing (an older database) reads ON. */
  popupsOn: z.boolean().default(true),
  items: z.array(NoticeItemSchema),
}) satisfies z.ZodType<NoticeInboxDTO>;

export const NoticeHistorySchema = z.object({
  enabled: z.boolean(),
  items: z.array(NoticeItemSchema),
  nextBefore: z.number().int().positive().nullable(),
}) satisfies z.ZodType<NoticeHistoryDTO>;

export const NoticeCountsSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
  urgentCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<NoticeCountsDTO>;

export const NoticePreferencesSchema = z.object({
  soundOn: z.boolean(),
  popupsOn: z.boolean().default(true),
}) satisfies z.ZodType<NoticePreferencesDTO>;

export const NoticeMarkResultSchema = z.object({
  noticeId: uuid,
  readAt: ts.nullable(),
  doneAt: ts.nullable(),
}) satisfies z.ZodType<NoticeMarkResult>;

export const NoticeMarkAllResultSchema = z.object({
  count: z.number().int().nonnegative(),
}) satisfies z.ZodType<NoticeMarkAllResult>;

/** admin_set_notices_enabled result. */
export const NoticeSwitchResultSchema = z.object({
  changed: z.boolean(),
  before: z.boolean(),
  after: z.boolean(),
  updatedAt: ts,
});
export type NoticeSwitchResult = z.output<typeof NoticeSwitchResultSchema>;

// ---------------------------------------------------------------------------
// Closed-browser alerts (Accounts phase 3, 8.3). Device reads never carry an endpoint or key.
// ---------------------------------------------------------------------------

export const PushDeviceSchema = z.object({
  deviceId: uuid,
  label: z.string().min(1).max(60),
  createdAt: ts,
  lastUsedAt: ts.nullable(),
  thisDevice: z.boolean(),
});

export const PushDevicesListSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(PushDeviceSchema),
}) satisfies z.ZodType<PushDevicesListDTO>;

const outcome = z.enum(['created', 'updated', 'existing']);

/** D1 push_device_register. */
export const PushRegisterResultSchema = z.object({ outcome, deviceId: uuid });
export type PushRegisterResult = z.output<typeof PushRegisterResultSchema>;

/** D2 push_device_remove. */
export const PushRemoveResultSchema = z.object({ outcome, deviceId: uuid });
export type PushRemoveResult = z.output<typeof PushRemoveResultSchema>;

/** D2 push_device_remove_current (sign-out / "Turn off on this device"). */
export const PushRemoveCurrentResultSchema = z.object({ removed: z.number().int().min(0).max(1) });
export type PushRemoveCurrentResult = z.output<typeof PushRemoveCurrentResultSchema>;

/** push_devices_remove_all ("Sign out of all devices", Addendum O3). */
export const PushRemoveAllResultSchema = z.object({ removed: z.number().int().min(0) });

/** D4 push_test_send. */
export const PushTestResultSchema = z.object({ outcome, jobId: uuid, deviceId: uuid });
export type PushTestResult = z.output<typeof PushTestResultSchema>;

/** W-D1 push_claim rows (server worker only): the bell item is rebuilt by the notice schema. */
export const PushClaimSchema = z.array(z.object({
  jobId: uuid,
  endpoint: z.string().min(9).max(1000).regex(/^https:\/\/\S+$/),
  p256dh: z.string().min(20).max(202),
  authKey: z.string().min(16).max(66),
  test: z.boolean(),
  urgent: z.boolean(),
  notice: NoticeItemSchema.nullable(),
}));
export type PushClaimRow = z.output<typeof PushClaimSchema>[number];

export const PushCompleteResultSchema = z.object({
  outcome: z.enum(['sent', 'gone', 'failed', 'retry', 'stale']),
  status: z.string().optional(),
});

/** Alias (track T's name for the D3 read schema). */
export const PushDevicesSchema = PushDevicesListSchema;
