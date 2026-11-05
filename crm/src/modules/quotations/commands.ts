import { z } from 'zod';
import { BOOKING_FOR, EVIDENCE_MIME_TYPES, type EvidenceMime, SERVICE_TYPES, TRIP_SCOPES } from '@/modules/fulfilment/contracts';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { PrefillApplySchema, PrefillSchema } from '@/modules/fulfilment/b11-commands';
import { QuotationCreateAutoFillShape } from '@/modules/fulfilment/prefill-auto';
import type { PrefillApplyResult, QUOTATION_PREFILL_FIELDS } from '@/modules/fulfilment/contracts';
import {
  CATEGORY_KEYS,
  CHARGE_KINDS,
  DECLINE_REASONS,
  DUE_RULES,
  OPTION_KEYS,
  QUOTATION_CHECKLIST_CODES,
  QUOTATION_ERROR_STATES,
  QUOTATION_EVIDENCE_KINDS,
  QUOTATION_STATUSES,
  isQuotationSubjectKind,
  QUOTATION_SUBJECT_KINDS,
  type QuotationAcceptResult,
  type QuotationChecklistCode,
  type QuotationContact,
  type QuotationContent,
  type QuotationConversionResult,
  type QuotationCreateResult,
  type QuotationErrorCode,
  type QuotationEvidenceKind,
  type QuotationItemAddResult,
  type QuotationLinkDealResult,
  type QuotationMarkReadyResult,
  type QuotationMarkSentResult,
  type QuotationNewVersionResult,
  type QuotationSaveResult,
  type QuotationSubjectKind,
  type DeclineReason,
  SENT_CHANNELS,
  type SentChannel,
  TIER_KEYS,
  type TierKey,
  UNIT_KINDS,
} from './contracts';
import type { QuotationDetailsFields, QuotationLineInput, QuotationPlanRow } from './forms';

/**
 * Typed wrappers for the quotation commands and reads (Atlas
 * 20261120000200, Mercury 20261120000300). Every call runs under the
 * CALLER's client (the staff member's own session); the privileged client
 * is used only for Storage, never here. Replies are zod-validated; anything
 * unexpected throws QuotationCommandError with code null (fail closed).
 * Refusals map by SQLSTATE + exact message token; database messages are
 * never kept. database.types.ts lists these functions only after the lead
 * regenerates it; they go through the untyped RpcClient surface (B1.1
 * pattern), so no cast is needed.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
/** A hint is kept only when it is a plain list of input keys or codes (never free text). */
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,60}(,[A-Za-z0-9_.[\]]{1,60}){0,40}$/;

/** Refusals whose hint names input keys (or, for not_ready, issue codes). */
const HINTED = new Set<string>(['invalid_input', 'not_ready', 'internal_wording', 'valid_until_past']);

export class QuotationCommandError extends Error {
  override name = 'QuotationCommandError';
  constructor(
    readonly command: string,
    /** The mapped refusal, 'session' for an ended JWT, or null for anything unexpected. */
    readonly code: QuotationErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: refused input keys; not_ready: the blocking issue codes. Never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapQuotationError(error: RpcError): QuotationErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(QUOTATION_ERROR_STATES, token) && QUOTATION_ERROR_STATES[token as QuotationErrorCode] === state) return token as QuotationErrorCode;
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  return null;
}

export function isQuotationFunctionMissing(error: unknown): boolean {
  return error instanceof QuotationCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

/** not_ready hint → the known issue codes (unknown ones dropped). */
export function issuesFromHint(keys: readonly string[]): QuotationChecklistCode[] {
  return keys.filter((k): k is QuotationChecklistCode => (QUOTATION_CHECKLIST_CODES as readonly string[]).includes(k));
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new QuotationCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapQuotationError(result.error);
    const hint = (result.error.hint ?? '').trim();
    const keys = code !== null && HINTED.has(code) && HINT_KEYS.test(hint) ? hint.split(',') : [];
    throw new QuotationCommandError(fn, code, result.error.code ?? null, keys);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new QuotationCommandError(fn, null, null);
  return parsed.data;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  return parse(fn, schema, await invoke(client, fn, args));
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const rowVersion = z.number().int().nonnegative();
const optionalNull = <T extends z.ZodType>(schema: T) => schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
const paise = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,18})$/)]).transform(String);
const signedPaise = z
  .union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/)])
  .transform(String);
const status = z.enum(QUOTATION_STATUSES);
const tierKey = z.enum(TIER_KEYS);
const count = z.number().int().min(0).max(100);
/** Object path of a quotation evidence file: <entity>/<quotation>/<version>/<evidence> (four uuids). */
const EvidencePath = z.string().regex(/^[0-9a-f-]{36}(\/[0-9a-f-]{36}){3}$/i);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ListVersionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status,
  validUntil: optionalNull(isoDate),
  sentAt: optionalNull(timestamp),
  acceptedAt: optionalNull(timestamp),
  acceptedTier: optionalNull(tierKey),
  contentHash: optionalNull(hash),
});
/**
 * Batch 3 tolerant subject kinds: a row whose subject kind is a string this
 * build does not know is dropped before the strict parse (list), and such a
 * record is answered as not visible (get). A newer database therefore never
 * fails a whole read; a malformed row (no kind, not a string) still does.
 */
function hasUnknownSubjectKind(kind: unknown): boolean {
  return typeof kind === 'string' && !isQuotationSubjectKind(kind);
}

const ListRowSchema = z.object({
  quotationId: z.uuid(),
  reference: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  subjectKind: z.enum(QUOTATION_SUBJECT_KINDS),
  leadId: optionalNull(z.uuid()),
  dealId: optionalNull(z.uuid()),
  /** Batch 3: absent on an older database. */
  referralDraftId: z.uuid().nullable().optional(),
  linkedDealId: optionalNull(z.uuid()),
  acceptedVersionId: optionalNull(z.uuid()),
  converted: z.boolean(),
  bookingVersionId: optionalNull(z.uuid()),
  createdAt: timestamp,
  rowVersion: z.number().int().positive(),
  versions: z.array(ListVersionSchema).max(200),
});
/** Rows whose subject kind this build does not know are dropped (never a failed list). */
export const QuotationListSchema = z.preprocess(
  (rows) => (Array.isArray(rows) ? rows.filter((r: unknown) => !(r && typeof r === 'object' && hasUnknownSubjectKind((r as { subjectKind?: unknown }).subjectKind))) : rows),
  z.array(ListRowSchema).max(500),
);
export type QuotationListRecord = z.output<typeof QuotationListSchema>;

/** null = the caller may not edit the subject (or it is not visible): the same answer for everyone else. */
export async function quotationList(client: RpcClient, subjectKind: QuotationSubjectKind, subjectId: string): Promise<QuotationListRecord | null> {
  const fn = 'quotation_list';
  const data = await invoke(client, fn, { p_subject_kind: subjectKind, p_subject_id: subjectId });
  return data === null ? null : parse(fn, QuotationListSchema, data);
}

const ContentSchema = z
  .object({
    days: z
      .array(z.object({ day: z.number().int().min(1).max(60), title: z.string().max(120), text: optionalNull(z.string().max(2000)) }))
      .max(60)
      .optional(),
    includes: z.array(z.string().max(300)).max(40).optional(),
    excludes: z.array(z.string().max(300)).max(40).optional(),
    terms: z.array(z.string().max(300)).max(40).optional(),
    notes: optionalNull(z.string().max(2000)),
  })
  .nullable()
  .optional()
  .transform(
    (c): QuotationContent => ({
      days: (c?.days ?? []).map((d) => ({ day: d.day, title: d.title, text: d.text })),
      includes: c?.includes ?? [],
      excludes: c?.excludes ?? [],
      terms: c?.terms ?? [],
      notes: c?.notes ?? null,
    }),
  );

const EvidenceRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(QUOTATION_EVIDENCE_KINDS),
  fileName: z.string().min(1).max(120),
  mime: z.enum(EVIDENCE_MIME_TYPES),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(['pending_upload', 'stored', 'failed']),
  createdAt: timestamp,
  storedAt: optionalNull(timestamp),
  uploadedByYou: z.boolean(),
});

const MoneyLineSchema = z.object({
  lineNo: z.number().int().min(1).max(60),
  optionKey: z.enum(OPTION_KEYS),
  itemId: optionalNull(z.uuid()),
  itemNo: optionalNull(z.number().int().min(1).max(100)),
  chargeKind: z.enum(CHARGE_KINDS),
  categoryKey: z.enum(CATEGORY_KEYS),
  description: z.string().min(1).max(200),
  unitKind: z.enum(UNIT_KINDS),
  units: z.number().int().min(1).max(999),
  periods: z.number().int().min(1).max(366),
  quantity: z.number().int().min(1),
  unitSellPaise: paise,
  lineSellPaise: paise,
  unitCostPaise: optionalNull(paise),
  lineCostPaise: optionalNull(paise),
  remark: optionalNull(z.string().max(300)),
});
const MoneyTierSchema = z.object({
  tierKey,
  label: optionalNull(z.string().max(80)),
  quotedTotalPaise: optionalNull(paise),
  showPerPerson: z.boolean(),
  lineCount: z.number().int().nonnegative(),
  componentSellPaise: paise,
  differencePaise: optionalNull(signedPaise),
  costTotalPaise: optionalNull(paise),
  costComplete: z.boolean(),
  marginPaise: optionalNull(signedPaise),
  payingTravellers: z.number().int().min(0).max(300),
  perPersonPaise: optionalNull(paise),
  planTotalPaise: optionalNull(paise),
  planCount: z.number().int().nonnegative(),
});
const MoneyInstalmentSchema = z.object({
  tierKey,
  seq: z.number().int().min(1).max(12),
  label: z.string().min(1).max(60),
  amountPaise: paise,
  dueRule: z.enum(DUE_RULES),
  dueDays: optionalNull(z.number().int().min(1).max(365)),
  dueDate: optionalNull(isoDate),
});
/** Mercury quotation_money_json (commercial readers only). Unknown codes are dropped, never shown raw. */
export const MoneySchema = z.object({
  lines: z.array(MoneyLineSchema).max(60),
  tiers: z.array(MoneyTierSchema).max(2).nullable().transform((t) => t ?? []),
  instalments: z.array(MoneyInstalmentSchema).max(24),
  codes: z.array(z.string().max(60)).max(60).nullable().transform((c) => c ?? []),
  costRefreshAllowed: z.boolean().optional().transform((v) => v ?? false),
});
export type MoneyRecord = z.output<typeof MoneySchema>;

// ---------------------------------------------------------------------------
// Batch 3 referral draft state (atlas-batch3-shapes v2 §2, §4.8)
// ---------------------------------------------------------------------------

export const REFERRAL_AUTO_CLOSE_STATES = ['paused', 'scheduled', 'closed', 'none'] as const;
export const REFERRAL_CLOSED_REASONS = ['duplicate', 'lost', 'handled_elsewhere', 'other', 'no_activity'] as const;

/** AutoClose: the browser never computes the date (contracts F.3.2); `dueOn` comes from the database. */
export const AutoCloseSchema = z.object({ state: z.enum(REFERRAL_AUTO_CLOSE_STATES), dueOn: optionalNull(isoDate) });

/** DraftState fields (status, closure, automatic close). */
export const DraftStateShape = {
  status: z.enum(['open', 'closed']),
  closedReason: optionalNull(z.enum(REFERRAL_CLOSED_REASONS)),
  closedAt: optionalNull(timestamp),
  autoClose: AutoCloseSchema,
};

/** quotation_get / itinerary_document_get `referral` key: null, or the draft behind a referral subject. */
export const ReferralBlockSchema = z.object({
  referralDraftId: z.uuid(),
  reference: z.string().min(1).max(40),
  ...DraftStateShape,
  linked: z.boolean(),
  bound: z.boolean(),
  activeDealId: optionalNull(z.uuid()),
  activeLeadId: optionalNull(z.uuid()),
  canReopen: z.boolean().optional().transform((v) => v ?? false),
  /** Atlas M5 (2e6bf31): the draft's owner, named only for the owner and the branch Manager. */
  ownerName: z.string().min(1).max(200).nullable().optional(),
  ownerIsYou: z.boolean().optional(),
});
export type ReferralBlockRecord = z.output<typeof ReferralBlockSchema>;

export const QuotationGetSchema = z.object({
  quotationId: z.uuid(),
  reference: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  /** The header's row version (quotation_link_deal). */
  rowVersion: z.number().int().positive(),
  subject: z.object({
    kind: z.enum(QUOTATION_SUBJECT_KINDS),
    leadId: optionalNull(z.uuid()),
    dealId: optionalNull(z.uuid()),
    /** Batch 3: set when kind is 'referral'; absent on an older database (left optional so older fixtures parse). */
    referralDraftId: z.uuid().nullable().optional(),
    linkedDealId: optionalNull(z.uuid()),
    reference: z.string().max(80).nullable().optional().transform((v) => v ?? ''),
    title: z.string().max(400).nullable().optional().transform((v) => v ?? ''),
    /** DEC-50 (Atlas 0800): the quotation's branch code (branches.code); null when absent. */
    branchCode: optionalNull(z.string().max(16)),
  }),
  version: z.object({
    versionId: z.uuid(),
    versionNo: z.number().int().positive(),
    status,
    rowVersion,
    contentHash: optionalNull(hash),
    validUntil: optionalNull(isoDate),
    basedOnVersionId: optionalNull(z.uuid()),
    sentAt: optionalNull(timestamp),
    sentChannel: optionalNull(z.enum(SENT_CHANNELS)),
    acceptedAt: optionalNull(timestamp),
    acceptedTier: optionalNull(tierKey),
    declinedAt: optionalNull(timestamp),
    declineReason: optionalNull(z.enum(DECLINE_REASONS)),
  }),
  trip: z
    .object({
      destination: optionalNull(z.string().max(200)),
      scope: optionalNull(z.enum(TRIP_SCOPES)),
      start: optionalNull(isoDate),
      end: optionalNull(isoDate),
    })
    .nullable()
    .optional()
    .transform((t) => ({ destination: t?.destination ?? null, scope: t?.scope ?? null, start: t?.start ?? null, end: t?.end ?? null })),
  pax: z
    .object({
      adults: count.nullable().optional(),
      childrenWithBed: count.nullable().optional(),
      childrenNoBed: count.nullable().optional(),
      infants: count.nullable().optional(),
      remarks: optionalNull(z.string().max(500)),
    })
    .nullable()
    .optional()
    .transform((p) => ({
      adults: p?.adults ?? 0,
      childrenWithBed: p?.childrenWithBed ?? 0,
      childrenNoBed: p?.childrenNoBed ?? 0,
      infants: p?.infants ?? 0,
      paxRemarks: p?.remarks ?? null,
    })),
  requirementsNote: optionalNull(z.string().max(4000)),
  content: ContentSchema,
  tiers: z.array(z.object({ tierKey, label: optionalNull(z.string().max(80)) })).max(2),
  items: z
    .array(
      z.object({
        itemId: z.uuid(),
        itemNo: z.number().int().min(1).max(100),
        serviceType: z.enum(SERVICE_TYPES),
        tierKey: optionalNull(tierKey),
        title: optionalNull(z.string().max(400)),
        /** Validated against the booking fact schema in the DTO; an invalid draft item still loads (factsValid false). */
        facts: z.record(z.string(), z.unknown()),
        factsValid: z.boolean().optional().transform((v) => v ?? true),
      }),
    )
    .max(100),
  contacts: z
    .object({
      contactName: z.string().min(1).max(120),
      mobile: optionalNull(z.string().regex(/^[6-9][0-9]{9}$/)),
      email: optionalNull(z.string().max(254)),
      companyName: optionalNull(z.string().max(200)),
      bookingFor: optionalNull(z.enum(BOOKING_FOR)),
    })
    .nullable()
    .optional()
    .transform((c): QuotationContact | null =>
      c ? { contactName: c.contactName, mobile: c.mobile, email: c.email, companyName: c.companyName, bookingFor: c.bookingFor } : null,
    ),
  evidence: z.array(EvidenceRowSchema).max(50).optional().transform((v) => v ?? []),
  issues: z.array(z.string().max(60)).max(60).nullable().optional().transform((v) => v ?? []),
  canEdit: z.boolean(),
  conversion: z
    .object({ bookingVersionId: z.uuid(), dealId: z.uuid(), createdAt: timestamp })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  /** Present only for commercial readers; absent (or null) otherwise. */
  money: MoneySchema.nullable().optional(),
  /** B1.2 (0600): Bitrix values and marks of this version, plus the fields still marked from Bitrix. Absent on an older database. */
  prefill: PrefillSchema.extend({ unchecked: z.array(z.string().min(1).max(60)).max(20).nullable().optional().transform((v) => v ?? []) })
    .nullable()
    .optional(),
  /** Batch 3 (20261123000100): the referral draft behind a referral quotation; null otherwise; absent on an older database. */
  referral: ReferralBlockSchema.nullable().optional(),
});
export type QuotationGetRecord = z.output<typeof QuotationGetSchema>;

/**
 * "Use Bitrix values" on a quotation draft (or a ready version, which goes
 * back to draft). Values come from the database snapshot of the Lead or Deal.
 */
export function quotationPrefillApply(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; fields: ReadonlyArray<(typeof QUOTATION_PREFILL_FIELDS)[number]> },
): Promise<PrefillApplyResult> {
  return call(
    client,
    'quotation_prefill_apply',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: [...input.fields] },
    PrefillApplySchema,
  );
}

/** null = not visible to the caller (the same answer for every non-reader). */
export async function quotationGet(client: RpcClient, versionId: string): Promise<QuotationGetRecord | null> {
  const fn = 'quotation_get';
  const data = await invoke(client, fn, { p_version_id: versionId });
  if (data === null) return null;
  // Batch 3: a subject kind this build does not know is answered like "not visible", never a failed page.
  if (data && typeof data === 'object' && hasUnknownSubjectKind((data as { subject?: { kind?: unknown } }).subject?.kind)) return null;
  return parse(fn, QuotationGetSchema, data);
}

export const LinkCandidatesSchema = z.array(
  z.object({
    dealId: z.uuid(),
    reference: z.string().min(1).max(80),
    title: z.string().max(400),
    branchName: optionalNull(z.string().max(200)),
    sameBranch: z.boolean(),
    active: z.boolean(),
    linkable: z.boolean(),
  }),
);
export type LinkCandidatesRecord = z.output<typeof LinkCandidatesSchema>;

export async function quotationLinkCandidates(client: RpcClient, quotationId: string): Promise<LinkCandidatesRecord | null> {
  const fn = 'quotation_link_candidates';
  const data = await invoke(client, fn, { p_quotation_id: quotationId });
  return data === null ? null : parse(fn, LinkCandidatesSchema.max(100), data);
}

// ---------------------------------------------------------------------------
// Commands (Atlas)
// ---------------------------------------------------------------------------

const RowVersionSchema = z.object({ rowVersion }).transform((r): QuotationSaveResult => ({ rowVersion: r.rowVersion }));

export function quotationCreate(
  client: RpcClient,
  input: { subjectKind: QuotationSubjectKind; subjectId: string; title: string; requestId: string },
): Promise<QuotationCreateResult> {
  return call(
    client,
    'quotation_create',
    { p_subject_kind: input.subjectKind, p_subject_id: input.subjectId, p_title: input.title, p_request_id: input.requestId },
    z.object({
      quotationId: z.uuid(),
      reference: z.string().min(1).max(40),
      versionId: z.uuid(),
      versionNo: z.number().int().positive(),
      rowVersion,
      created: z.boolean(),
      // Batch 2 (migration A): absent on an older database.
      autoFill: QuotationCreateAutoFillShape.autoFill.optional(),
      filled: QuotationCreateAutoFillShape.filled.optional(),
      skipped: QuotationCreateAutoFillShape.skipped.optional(),
    }),
  );
}

/**
 * The content allowlist as the database expects it: optional keys are left
 * out instead of null (a day without text, no notes).
 */
export function contentPayload(content: QuotationContent): Record<string, unknown> {
  return {
    days: content.days.map((d) => (d.text === null ? { day: d.day, title: d.title } : { day: d.day, title: d.title, text: d.text })),
    includes: content.includes,
    excludes: content.excludes,
    terms: content.terms,
    ...(content.notes !== null ? { notes: content.notes } : {}),
  };
}

/**
 * Partial save: only the keys present change (Atlas). The details form sends
 * every one of its keys, except an empty validity date (the database keeps
 * the current one; it refuses a null date).
 */
export function quotationVersionSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; fields: Partial<QuotationDetailsFields> & { content?: QuotationContent } },
): Promise<QuotationSaveResult> {
  const { content, validUntil, ...rest } = input.fields;
  const fields: Record<string, unknown> = {
    ...rest,
    ...(validUntil ? { validUntil } : {}),
    ...(content ? { content: contentPayload(content) } : {}),
  };
  return call(client, 'quotation_version_save', { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: fields }, RowVersionSchema);
}

export function quotationTiersSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; tiers: Array<{ tierKey: TierKey; label: string | null }> },
): Promise<QuotationSaveResult> {
  return call(client, 'quotation_tiers_save', { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_tiers: input.tiers }, RowVersionSchema);
}

export function quotationItemAdd(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; serviceType: string; tierKey: TierKey | null; facts: unknown },
): Promise<QuotationItemAddResult> {
  return call(
    client,
    'quotation_item_add',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_service_type: input.serviceType, p_tier_key: input.tierKey, p_facts: input.facts },
    z.object({ itemId: z.uuid(), itemNo: z.number().int().min(1).max(100), rowVersion }),
  );
}

export function quotationItemSave(
  client: RpcClient,
  input: { itemId: string; versionId: string; expectedRowVersion: number; tierKey: TierKey | null; facts: unknown },
): Promise<QuotationSaveResult> {
  return call(
    client,
    'quotation_item_save',
    { p_item_id: input.itemId, p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_tier_key: input.tierKey, p_facts: input.facts },
    RowVersionSchema,
  );
}

export function quotationItemRemove(client: RpcClient, input: { itemId: string; versionId: string; expectedRowVersion: number }): Promise<QuotationSaveResult> {
  return call(client, 'quotation_item_remove', { p_item_id: input.itemId, p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion }, RowVersionSchema);
}

export function quotationContactsSave(client: RpcClient, input: { versionId: string; expectedRowVersion: number; fields: QuotationContact }): Promise<QuotationSaveResult> {
  // bookingFor only when given: leaving it out keeps the saved value (DEC-45).
  const { bookingFor, ...rest } = input.fields;
  const fields = bookingFor === undefined ? rest : { ...rest, bookingFor };
  return call(client, 'quotation_contacts_save', { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: fields }, RowVersionSchema);
}

export function quotationMarkReady(client: RpcClient, input: { versionId: string; expectedRowVersion: number }): Promise<QuotationMarkReadyResult> {
  return call(
    client,
    'quotation_mark_ready',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion },
    z.object({ status: z.literal('ready'), contentHash: hash, rowVersion }).transform((r) => ({ rowVersion: r.rowVersion, contentHash: r.contentHash })),
  );
}

export function quotationMarkSent(
  client: RpcClient,
  input: { versionId: string; contentHash: string; channel: SentChannel; requestId: string },
): Promise<QuotationMarkSentResult> {
  return call(
    client,
    'quotation_mark_sent',
    { p_version_id: input.versionId, p_expected_content_hash: input.contentHash, p_channel: input.channel, p_request_id: input.requestId },
    z
      .object({ status: z.literal('sent'), validUntil: isoDate, supersededVersionId: optionalNull(z.uuid()) })
      .transform((r) => ({ validUntil: r.validUntil, supersededVersionId: r.supersededVersionId })),
  );
}

export function quotationAccept(
  client: RpcClient,
  input: { versionId: string; contentHash: string; evidenceId: string; tierKey: TierKey; requestId: string },
): Promise<QuotationAcceptResult> {
  return call(
    client,
    'quotation_accept',
    { p_version_id: input.versionId, p_expected_content_hash: input.contentHash, p_evidence_id: input.evidenceId, p_tier_key: input.tierKey, p_request_id: input.requestId },
    z
      .object({ status: z.literal('accepted'), acceptedTier: tierKey, quotationId: z.uuid(), discardedVersionId: optionalNull(z.uuid()), supersededVersionId: optionalNull(z.uuid()) })
      .transform((r) => ({ quotationId: r.quotationId, tierKey: r.acceptedTier, discardedVersionId: r.discardedVersionId, supersededVersionId: r.supersededVersionId })),
  );
}

export function quotationDecline(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; reason: DeclineReason; requestId: string },
): Promise<{ status: 'declined' }> {
  return call(
    client,
    'quotation_decline',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_reason: input.reason, p_request_id: input.requestId },
    z.object({ status: z.literal('declined') }),
  );
}

export function quotationNewVersion(client: RpcClient, input: { quotationId: string; baseVersionId: string; requestId: string }): Promise<QuotationNewVersionResult> {
  return call(
    client,
    'quotation_new_version',
    { p_quotation_id: input.quotationId, p_base_version_id: input.baseVersionId, p_request_id: input.requestId },
    z.object({ versionId: z.uuid(), versionNo: z.number().int().positive(), rowVersion, created: z.boolean() }),
  );
}

export function quotationDiscard(client: RpcClient, input: { versionId: string; expectedRowVersion: number }): Promise<{ status: 'discarded' }> {
  return call(client, 'quotation_discard', { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion }, z.object({ status: z.literal('discarded') }));
}

export function quotationLinkDeal(client: RpcClient, input: { quotationId: string; dealId: string; expectedRowVersion: number }): Promise<QuotationLinkDealResult> {
  return call(
    client,
    'quotation_link_deal',
    { p_quotation_id: input.quotationId, p_deal_id: input.dealId, p_expected_row_version: input.expectedRowVersion },
    z.object({ quotationId: z.uuid(), linkedDealId: z.uuid(), rowVersion }),
  );
}

/** One command, one transaction (Atlas): idempotent per accepted version, bound to its content hash. */
export function quotationConvertToBooking(client: RpcClient, input: { versionId: string; contentHash: string; requestId: string }): Promise<QuotationConversionResult> {
  return call(
    client,
    'quotation_convert_to_booking',
    { p_version_id: input.versionId, p_expected_content_hash: input.contentHash, p_request_id: input.requestId },
    z.object({
      outcome: z.enum(['created', 'existing']),
      bookingVersionId: z.uuid(),
      dealId: z.uuid(),
      itemsCreated: z.number().int().min(0).max(100),
    }),
  );
}

// ---------------------------------------------------------------------------
// Evidence (customer's written acceptance; sent versions only)
// ---------------------------------------------------------------------------

export function quotationEvidenceBegin(
  client: RpcClient,
  input: { versionId: string; kind: QuotationEvidenceKind; fileName: string; mime: EvidenceMime; sizeBytes: number; sha256: string },
): Promise<{ evidenceId: string; objectPath: string }> {
  return call(
    client,
    'quotation_evidence_begin',
    { p_version_id: input.versionId, p_kind: input.kind, p_file_name: input.fileName, p_mime: input.mime, p_size_bytes: input.sizeBytes, p_sha256: input.sha256 },
    z.object({ evidenceId: z.uuid(), objectPath: EvidencePath }),
  );
}

export function quotationEvidenceFinish(client: RpcClient, evidenceId: string, ok: boolean): Promise<{ evidenceId: string; status: 'stored' | 'failed' }> {
  return call(client, 'quotation_evidence_finish', { p_evidence_id: evidenceId, p_ok: ok }, z.object({ evidenceId: z.uuid(), status: z.enum(['stored', 'failed']) }));
}

export function quotationEvidenceRemove(client: RpcClient, evidenceId: string): Promise<{ evidenceId: string; status: 'removed' }> {
  return call(client, 'quotation_evidence_remove', { p_evidence_id: evidenceId }, z.object({ evidenceId: z.uuid(), status: z.literal('removed') }));
}

export function quotationEvidenceAuthorizeDownload(client: RpcClient, evidenceId: string): Promise<{ objectPath: string; fileName: string; mime: EvidenceMime }> {
  return call(
    client,
    'quotation_evidence_authorize_download',
    { p_evidence_id: evidenceId },
    z.object({ objectPath: EvidencePath, fileName: z.string().min(1).max(120).regex(/^[A-Za-z0-9._ -]+$/), mime: z.enum(EVIDENCE_MIME_TYPES) }),
  );
}

// ---------------------------------------------------------------------------
// Money commands (Mercury). Amounts travel as decimal strings (never JS numbers).
// ---------------------------------------------------------------------------

/** p_lines of quotation_lines_save (explicit keys; amounts as decimal strings). */
export function quotationLinesPayload(lines: readonly QuotationLineInput[]): Array<Record<string, unknown>> {
  return lines.map((l) => ({
    lineNo: l.lineNo,
    optionKey: l.optionKey,
    itemId: l.itemId,
    chargeKind: l.chargeKind,
    categoryKey: l.categoryKey,
    description: l.description,
    unitKind: l.unitKind,
    units: l.units,
    periods: l.periods,
    unitSellPaise: l.unitSellPaise,
    unitCostPaise: l.unitCostPaise,
    remark: l.remark,
  }));
}

export function quotationLinesSave(client: RpcClient, input: { versionId: string; expectedRowVersion: number; lines: QuotationLineInput[] }): Promise<QuotationSaveResult> {
  return call(
    client,
    'quotation_lines_save',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_lines: quotationLinesPayload(input.lines) },
    RowVersionSchema,
  );
}

export function quotationTotalSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; tierKey: TierKey; totalPaise: string | null; showPerPerson: boolean },
): Promise<QuotationSaveResult> {
  return call(
    client,
    'quotation_total_save',
    { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_tier_key: input.tierKey, p_total_paise: input.totalPaise, p_show_per_person: input.showPerPerson },
    RowVersionSchema,
  );
}

export function quotationPlanSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; tierKey: TierKey; instalments: QuotationPlanRow[] },
): Promise<QuotationSaveResult> {
  return call(
    client,
    'quotation_plan_save',
    {
      p_version_id: input.versionId,
      p_expected_row_version: input.expectedRowVersion,
      p_tier_key: input.tierKey,
      p_instalments: input.instalments.map((i) => ({ seq: i.seq, label: i.label, amountPaise: i.amountPaise, dueRule: i.dueRule, dueDays: i.dueDays, dueDate: i.dueDate })),
    },
    RowVersionSchema,
  );
}

/** Internal cost refresh after sending (not hashed; refused once converted). */
export function quotationCostEstimatesSave(
  client: RpcClient,
  input: { versionId: string; costs: Array<{ lineNo: number; unitCostPaise: string | null }> },
): Promise<{ versionId: string; updated: number }> {
  return call(
    client,
    'quotation_cost_estimates_save',
    { p_version_id: input.versionId, p_costs: input.costs },
    z.object({ versionId: z.uuid(), updated: z.number().int().min(0).max(60) }),
  );
}
