import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { QUOTATION_STATUSES } from './contracts';

/**
 * Direction A Batch 3: typed wrappers for the referral-draft commands and
 * the scoped Quotations / Itineraries list reads (Atlas migration
 * 20261123000100; shapes in the Atlas notes atlas-batch3-shapes.md v2).
 *
 * Every call runs under the CALLER's client (the staff member's own
 * session). Replies are zod-validated and copied key by key (DTO allowlist);
 * anything unexpected throws ReferralCommandError with code null (fail
 * closed). Refusals map by SQLSTATE + exact message token; database message
 * text is never kept. Enum values the database may add later are tolerated
 * only where a safe reading exists (autoClose state 'none', closed reason
 * 'other'); everything else fails closed.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const REFERRAL_ERROR_STATES = {
  not_authorized: '42501',
  not_found: 'P0002',
  invalid_input: '22023',
  version_changed: '40001',
  request_conflict: '40001',
  referral_drafts_disabled: '55000',
  draft_closed: '55000',
  draft_not_closed: '55000',
  draft_already_linked: '55000',
  link_locked: '55000',
  deal_not_linked_to_draft: '55000',
  branch_mismatch: '22023',
  deal_not_from_lead: '22023',
  deal_already_linked: '55000',
  deal_removed: '55000',
  deal_not_active: '55000',
  settings_busy: '55P03',
} as const;
export type ReferralErrorCode = keyof typeof REFERRAL_ERROR_STATES;

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,60}(,[A-Za-z0-9_.[\]]{1,60}){0,40}$/;

export class ReferralCommandError extends Error {
  override name = 'ReferralCommandError';
  constructor(
    readonly command: string,
    /** The mapped refusal, 'session' for an ended JWT, or null for anything unexpected. */
    readonly code: ReferralErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: the refused input keys (never shown as text). */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapReferralError(error: RpcError): ReferralErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(REFERRAL_ERROR_STATES, token) && REFERRAL_ERROR_STATES[token as ReferralErrorCode] === state) {
    return token as ReferralErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  return null;
}

/** The database has no Batch 3 functions yet (PGRST202 / 42883): screens keep today's behaviour. */
export function isReferralFunctionMissing(error: unknown): boolean {
  return error instanceof ReferralCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new ReferralCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapReferralError(result.error);
    const hint = (result.error.hint ?? '').trim();
    const keys = code === 'invalid_input' && HINT_KEYS.test(hint) ? hint.split(',') : [];
    throw new ReferralCommandError(fn, code, result.error.code ?? null, keys);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ReferralCommandError(fn, null, null);
  return parsed.data;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  return parse(fn, schema, await invoke(client, fn, args));
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const rowVersion = z.number().int().positive();
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
const text = (max: number) => z.string().min(1).max(max);
const draftRef = z.string().regex(/^TD-[1-9][0-9]{0,8}$/);
const quoteRef = z.string().min(1).max(40);

export const REFERRAL_SOURCE_KINDS = ['walk_in', 'phone', 'whatsapp', 'email', 'referral', 'repeat_customer', 'social', 'other'] as const;
export type ReferralSourceKind = (typeof REFERRAL_SOURCE_KINDS)[number];
export const REFERRAL_CLOSE_REASONS = ['duplicate', 'lost', 'handled_elsewhere', 'other'] as const;
export type ReferralCloseReason = (typeof REFERRAL_CLOSE_REASONS)[number];
export const REFERRAL_CLOSED_REASONS = [...REFERRAL_CLOSE_REASONS, 'no_activity'] as const;
export type ReferralClosedReason = (typeof REFERRAL_CLOSED_REASONS)[number];
export const REFERRAL_UNLINK_REASONS = ['wrong_link', 'duplicate', 'other'] as const;
export type ReferralUnlinkReason = (typeof REFERRAL_UNLINK_REASONS)[number];
export const AUTO_CLOSE_STATES = ['paused', 'scheduled', 'closed', 'none'] as const;
export type AutoCloseState = (typeof AUTO_CLOSE_STATES)[number];

/** The server computes the date; the browser never does (F.3.2). */
export const AutoCloseSchema = z.object({
  state: z.enum(AUTO_CLOSE_STATES).catch('none'),
  dueOn: nullable(isoDate),
});
export type ReferralAutoCloseRecord = z.output<typeof AutoCloseSchema>;

const closedReason = nullable(z.enum(REFERRAL_CLOSED_REASONS).catch('other'));
export const DraftStateSchema = z.object({
  status: z.enum(['open', 'closed']),
  closedReason,
  closedAt: nullable(timestamp),
  autoClose: AutoCloseSchema,
});
export type ReferralDraftStateRecord = z.output<typeof DraftStateSchema>;

const CurrentVersionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(QUOTATION_STATUSES),
  validUntil: nullable(isoDate),
});

const SubjectRefSchema = z.object({
  kind: z.enum(['lead', 'deal', 'referral', 'quotation']),
  id: z.uuid(),
  reference: text(60),
  title: text(200),
});

const DuplicateSchema = z.array(z.object({ reference: draftRef })).max(5);

// ---------------------------------------------------------------------------
// Lists (work_drafts_list)
// ---------------------------------------------------------------------------

export const WORK_LIST_KINDS = ['quotations', 'itineraries'] as const;
export type WorkListKind = (typeof WORK_LIST_KINDS)[number];
export const QUOTATION_LIST_STATUSES = [
  'open', 'to_finish', 'drafts', 'ready', 'shared', 'accepted', 'accepted_not_linked', 'declined_or_expired', 'closed_drafts', 'all',
] as const;
/** Mercury F1: accepted with a Deal to book into (a separate filter; the chips above stay as built). */
export const QUOTATION_READY_TO_BOOK = 'ready_to_book' as const;
export const QUOTATION_LIST_STATUSES_ALL = [...QUOTATION_LIST_STATUSES, QUOTATION_READY_TO_BOOK] as const;
export type QuotationListStatus = (typeof QUOTATION_LIST_STATUSES_ALL)[number];
export const ITINERARY_LIST_STATUSES = ['open', 'draft', 'ready', 'final_made', 'closed_drafts', 'all'] as const;
export type ItineraryListStatus = (typeof ITINERARY_LIST_STATUSES)[number];
export const WORK_SCOPES = ['mine', 'all'] as const;
export type WorkScope = (typeof WORK_SCOPES)[number];
export const WORK_LIST_MAX_LIMIT = 50;
export const WORK_LIST_DEFAULT_LIMIT = 25;

export interface WorkListFilter {
  status?: QuotationListStatus | ItineraryListStatus;
  scope?: WorkScope;
  /** Exact TQ-n or TD-n; ignores status and scope; finds closed drafts too. */
  reference?: string | null;
}

export const WorkCursorSchema = z.object({ since: z.string().min(1), id: z.uuid() });
export type WorkCursor = z.output<typeof WorkCursorSchema>;

/** The draft's active link for list rows (reference only; Mercury F1). */
const DraftLinkSchema = z.object({ kind: z.enum(['deal', 'lead']), reference: text(60) });

const counts = (keys: readonly string[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.number().int().nonnegative()])) as Record<string, z.ZodNumber>);

const QuotationRowSchema = z.object({
  quotationId: z.uuid(),
  reference: quoteRef,
  title: text(200),
  subjectKind: z.enum(['lead', 'deal', 'referral']),
  subject: SubjectRefSchema,
  referralDraftId: nullable(z.uuid()),
  draft: nullable(DraftStateSchema.extend({ reference: draftRef })),
  /** Optional in the type so older fixtures still build; the database always sends it (null when none). */
  draftLink: DraftLinkSchema.nullable().optional(),
  linkedDealId: nullable(z.uuid()),
  currentVersion: CurrentVersionSchema,
  accepted: z.boolean(),
  converted: z.boolean(),
  acceptedNotLinked: z.boolean(),
  /** Accepted, not converted, with a Deal to book into (own, bound or the draft's active Deal link); never "accepted, not linked". */
  readyToBook: z.boolean().optional(),
  customerName: nullable(text(200)),
  destination: nullable(text(200)),
  tripStart: nullable(isoDate),
  ownerName: nullable(text(200)),
  ownerIsYou: z.boolean(),
  since: timestamp,
});
export type WorkQuotationRow = z.output<typeof QuotationRowSchema>;

const ItineraryRowSchema = z.object({
  documentId: z.uuid(),
  title: text(200),
  subjectKind: z.enum(['quotation', 'deal', 'referral']),
  subject: SubjectRefSchema,
  quotationId: nullable(z.uuid()),
  referralDraftId: nullable(z.uuid()),
  draft: nullable(DraftStateSchema.extend({ reference: draftRef })),
  /** Optional in the type so older fixtures still build; the database always sends it (null when none). */
  draftLink: DraftLinkSchema.nullable().optional(),
  basisKind: z.enum(['quotation_version', 'booking_version', 'none']),
  factsStatus: z.enum(['draft', 'ready']),
  latestFinal: nullable(z.object({ renderedId: z.uuid(), createdAt: timestamp })),
  openDifferences: z.number().int().nonnegative(),
  ownerName: nullable(text(200)),
  /** Echo L9: the owner whose name is shown is the viewer (optional in the type for older fixtures). */
  ownerIsYou: z.boolean().optional(),
  createdByYou: z.boolean(),
  since: timestamp,
});
export type WorkItineraryRow = z.output<typeof ItineraryRowSchema>;

const pageSchema = <R extends z.ZodType>(row: R, statuses: readonly string[], countKeys: readonly string[] = statuses) =>
  z.union([
    z.object({ applies: z.literal(false) }).transform(() => ({ applies: false as const })),
    z
      .object({
        applies: z.literal(true),
        scope: z.enum(WORK_SCOPES),
        filter: z.object({ status: z.enum(statuses as [string, ...string[]]), scope: z.enum(WORK_SCOPES), reference: nullable(z.string()) }),
        counts: counts(countKeys).catchall(z.number().int().nonnegative()),
        total: z.number().int().nonnegative(),
        rows: z.array(row).max(WORK_LIST_MAX_LIMIT),
        hasMore: z.boolean(),
        next: nullable(WorkCursorSchema),
      })
      .transform((p) => ({
        applies: true as const,
        scope: p.scope,
        filter: { status: p.filter.status, scope: p.filter.scope, reference: p.filter.reference },
        counts: p.counts,
        total: p.total,
        rows: p.rows as z.output<R>[],
        hasMore: p.hasMore,
        next: p.next ? { since: p.next.since, id: p.next.id } : null,
      })),
  ]);

export const QuotationWorkPageSchema = pageSchema(QuotationRowSchema, QUOTATION_LIST_STATUSES_ALL, QUOTATION_LIST_STATUSES);
export const ItineraryWorkPageSchema = pageSchema(ItineraryRowSchema, ITINERARY_LIST_STATUSES);
export type QuotationWorkPage = z.output<typeof QuotationWorkPageSchema>;
export type ItineraryWorkPage = z.output<typeof ItineraryWorkPageSchema>;

/** One page of the Quotations or Itineraries list. applies:false = the person has no list (hide the menu item). */
export async function workDraftsList(
  client: RpcClient,
  kind: 'quotations',
  filter?: WorkListFilter,
  after?: WorkCursor | null,
  limit?: number,
): Promise<QuotationWorkPage>;
export async function workDraftsList(
  client: RpcClient,
  kind: 'itineraries',
  filter?: WorkListFilter,
  after?: WorkCursor | null,
  limit?: number,
): Promise<ItineraryWorkPage>;
export async function workDraftsList(
  client: RpcClient,
  kind: WorkListKind,
  filter: WorkListFilter = {},
  after: WorkCursor | null = null,
  limit: number = WORK_LIST_DEFAULT_LIMIT,
): Promise<QuotationWorkPage | ItineraryWorkPage> {
  const fn = 'work_drafts_list';
  const args = {
    p_kind: kind,
    p_filter: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
      ...(filter.reference ? { reference: filter.reference } : {}),
    },
    p_after: after ? { since: after.since, id: after.id } : null,
    p_limit: Math.min(WORK_LIST_MAX_LIMIT, Math.max(1, Math.trunc(limit))),
  };
  return kind === 'quotations'
    ? call(client, fn, args, QuotationWorkPageSchema)
    : call(client, fn, args, ItineraryWorkPageSchema);
}

/** A cursor taken from a URL (opaque to staff); anything malformed is ignored (first page). */
export function parseWorkCursor(raw: unknown): WorkCursor | null {
  const parsed = WorkCursorSchema.safeParse(raw);
  return parsed.success ? { since: parsed.data.since, id: parsed.data.id } : null;
}

// ---------------------------------------------------------------------------
// Draft reads
// ---------------------------------------------------------------------------

const LinkSchema = z.object({
  linkId: z.uuid(),
  targetKind: z.enum(['lead', 'deal']),
  targetId: z.uuid(),
  reference: text(60),
  title: nullable(text(200)),
  active: z.boolean(),
  linkedAt: timestamp,
  linkedByYou: z.boolean(),
  endedAt: nullable(timestamp),
  endReason: nullable(z.enum(REFERRAL_UNLINK_REASONS).catch('other')),
  canRemove: z.boolean(),
});

export const ReferralDraftSchema = DraftStateSchema.extend({
  referralDraftId: z.uuid(),
  reference: draftRef,
  branchId: z.uuid(),
  branchName: text(200),
  ownerUserId: z.uuid(),
  ownerName: nullable(text(200)),
  ownerIsYou: z.boolean(),
  createdByYou: z.boolean(),
  customer: z.object({
    customerName: text(120),
    mobile: nullable(z.string().regex(/^[6-9][0-9]{9}$/)),
    email: nullable(z.string().min(3).max(254)),
    companyName: nullable(text(200)),
  }),
  source: z.object({ kind: nullable(z.enum(REFERRAL_SOURCE_KINDS).catch('other')), note: nullable(text(200)) }),
  closeNote: nullable(text(500)),
  linked: z.boolean(),
  bound: z.boolean(),
  lastActivityAt: timestamp,
  rowVersion,
  createdAt: timestamp,
  switchOn: z.boolean(),
  can: z.object({ edit: z.boolean(), close: z.boolean(), reopen: z.boolean(), reassign: z.boolean(), link: z.boolean(), unlink: z.boolean() }),
  links: z.array(LinkSchema).max(200),
  quotations: z
    .array(
      z.object({
        quotationId: z.uuid(),
        reference: quoteRef,
        title: text(200),
        currentVersion: CurrentVersionSchema,
        accepted: z.boolean(),
        converted: z.boolean(),
        linkedDealId: nullable(z.uuid()),
      }),
    )
    .max(200),
  itineraries: z
    .array(z.object({ documentId: z.uuid(), title: text(200), quotationId: nullable(z.uuid()), factsStatus: z.enum(['draft', 'ready']) }))
    .max(200),
});
export type ReferralDraftRecord = z.output<typeof ReferralDraftSchema>;

/** null = not an editor of this draft, or no such draft: the same answer for everyone else. */
export async function referralDraftGet(client: RpcClient, draftId: string): Promise<ReferralDraftRecord | null> {
  const fn = 'referral_draft_get';
  const data = await invoke(client, fn, { p_draft_id: draftId });
  return data === null ? null : parse(fn, ReferralDraftSchema, data);
}

/** Open by reference (exact TD-n, closed drafts included); owner or branch Manager only; else null. */
export async function referralDraftFind(client: RpcClient, reference: string): Promise<{ referralDraftId: string } | null> {
  const fn = 'referral_draft_find';
  const data = await invoke(client, fn, { p_reference: reference });
  return data === null ? null : parse(fn, z.object({ referralDraftId: z.uuid() }).transform((r) => ({ referralDraftId: r.referralDraftId })), data);
}

export const LinkCandidateSchema = z.object({
  kind: z.enum(['lead', 'deal']),
  id: z.uuid(),
  reference: text(60),
  title: text(200),
  branchName: nullable(text(200)),
  active: z.boolean(),
  fromLinkedLead: z.boolean(),
  alreadyHasAcceptedQuotation: z.boolean(),
  linkable: z.boolean(),
});
export type ReferralLinkCandidate = z.output<typeof LinkCandidateSchema>;

/** null = not an editor of the draft. Never preselected; nothing is linked by this read. */
export async function referralLinkCandidates(
  client: RpcClient,
  draftId: string,
  kind: 'lead' | 'deal',
  query: string | null = null,
): Promise<ReferralLinkCandidate[] | null> {
  const fn = 'referral_link_candidates';
  const data = await invoke(client, fn, { p_draft_id: draftId, p_kind: kind, p_query: query });
  return data === null ? null : parse(fn, z.array(LinkCandidateSchema).max(25), data);
}

export const OwnerCandidateSchema = z.object({ userId: z.uuid(), displayName: text(200), isCurrentOwner: z.boolean() });
export type ReferralOwnerCandidate = z.output<typeof OwnerCandidateSchema>;

/** null = the caller is not the draft's branch Manager. */
export async function referralOwnerCandidates(client: RpcClient, draftId: string): Promise<ReferralOwnerCandidate[] | null> {
  const fn = 'referral_owner_candidates';
  const data = await invoke(client, fn, { p_draft_id: draftId });
  return data === null ? null : parse(fn, z.array(OwnerCandidateSchema).max(500), data);
}

export const SubjectDraftSchema = DraftStateSchema.extend({
  referralDraftId: z.uuid(),
  reference: draftRef,
  customerName: text(120),
  ownerName: nullable(text(200)),
  ownerIsYou: z.boolean(),
  quotationCount: z.number().int().nonnegative(),
  hasAccepted: z.boolean(),
});
export type ReferralSubjectDraft = z.output<typeof SubjectDraftSchema>;

/** Drafts actively linked to a Lead or Deal (DA-71). null = the caller cannot edit that record. */
export async function referralDraftsForSubject(
  client: RpcClient,
  subjectKind: 'lead' | 'deal',
  subjectId: string,
): Promise<ReferralSubjectDraft[] | null> {
  const fn = 'referral_drafts_for_subject';
  const data = await invoke(client, fn, { p_subject_kind: subjectKind, p_subject_id: subjectId });
  return data === null ? null : parse(fn, z.array(SubjectDraftSchema).max(200), data);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface ReferralCustomerInput {
  customerName: string;
  mobile?: string | null;
  email?: string | null;
  companyName?: string | null;
  sourceKind?: ReferralSourceKind | null;
  sourceNote?: string | null;
}

const CUSTOMER_KEYS = ['customerName', 'mobile', 'email', 'companyName', 'sourceKind', 'sourceNote'] as const;
function customerPayload(c: Partial<ReferralCustomerInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CUSTOMER_KEYS) if (Object.hasOwn(c, k) && c[k] !== undefined) out[k] = c[k];
  return out;
}

export const QuotationStandaloneSchema = z
  .object({
    referralDraftId: z.uuid(),
    referralReference: draftRef,
    quotationId: z.uuid(),
    reference: quoteRef,
    versionId: z.uuid(),
    versionNo: z.literal(1),
    rowVersion,
    created: z.boolean(),
    possibleDuplicates: DuplicateSchema,
  })
  .transform((r) => ({ ...r, possibleDuplicates: r.possibleDuplicates.map((d) => ({ reference: d.reference })) }));
export type QuotationStandaloneResult = z.output<typeof QuotationStandaloneSchema>;

export function quotationCreateStandalone(
  client: RpcClient,
  input: { branchId: string; customer: ReferralCustomerInput; title: string; requestId: string },
): Promise<QuotationStandaloneResult> {
  return call(client, 'quotation_create_standalone', {
    p_branch_id: input.branchId, p_customer: customerPayload(input.customer), p_title: input.title, p_request_id: input.requestId,
  }, QuotationStandaloneSchema);
}

export const ItineraryStandaloneSchema = z
  .object({
    referralDraftId: z.uuid(),
    referralReference: draftRef,
    documentId: z.uuid(),
    draftId: z.uuid(),
    rowVersion,
    created: z.boolean(),
    possibleDuplicates: DuplicateSchema,
  })
  .transform((r) => ({ ...r, possibleDuplicates: r.possibleDuplicates.map((d) => ({ reference: d.reference })) }));
export type ItineraryStandaloneResult = z.output<typeof ItineraryStandaloneSchema>;

export function itineraryCreateStandalone(
  client: RpcClient,
  input: { branchId: string; customer: ReferralCustomerInput; title: string; requestId: string },
): Promise<ItineraryStandaloneResult> {
  return call(client, 'itinerary_create_standalone', {
    p_branch_id: input.branchId, p_customer: customerPayload(input.customer), p_title: input.title, p_request_id: input.requestId,
  }, ItineraryStandaloneSchema);
}

const SaveSchema = z.object({ rowVersion, changedFields: z.array(z.enum(CUSTOMER_KEYS)).max(6) });
export type ReferralSaveResult = z.output<typeof SaveSchema>;

export function referralDraftSave(
  client: RpcClient,
  input: { draftId: string; rowVersion: number; fields: Partial<ReferralCustomerInput> },
): Promise<ReferralSaveResult> {
  return call(client, 'referral_draft_save', {
    p_draft_id: input.draftId, p_expected_row_version: input.rowVersion, p_fields: customerPayload(input.fields),
  }, SaveSchema);
}

const CloseSchema = z.object({ status: z.literal('closed'), closedReason: z.enum(REFERRAL_CLOSED_REASONS).catch('other'), alreadyClosed: z.boolean(), rowVersion });
export type ReferralCloseResult = z.output<typeof CloseSchema>;

/** alreadyClosed true = it was closed already (or closed automatically just now); the reason is never overwritten. */
export function referralDraftClose(
  client: RpcClient,
  input: { draftId: string; rowVersion: number; reason: ReferralCloseReason; note?: string | null },
): Promise<ReferralCloseResult> {
  return call(client, 'referral_draft_close', {
    p_draft_id: input.draftId, p_expected_row_version: input.rowVersion, p_reason: input.reason, p_note: input.note ?? null,
  }, CloseSchema);
}

const ReopenSchema = z.object({
  status: z.literal('open'),
  closedAutomatically: z.boolean(),
  dueOn: nullable(isoDate),
  autoClose: AutoCloseSchema,
  rowVersion,
});
export type ReferralReopenResult = z.output<typeof ReopenSchema>;

/** Note required when the draft was closed as a duplicate (invalid_input hint 'note'). */
export function referralDraftReopen(
  client: RpcClient,
  input: { draftId: string; rowVersion: number; note?: string | null },
): Promise<ReferralReopenResult> {
  return call(client, 'referral_draft_reopen', {
    p_draft_id: input.draftId, p_expected_row_version: input.rowVersion, p_note: input.note ?? null,
  }, ReopenSchema);
}

const ReassignSchema = z.object({ ownerIsYou: z.boolean(), changed: z.boolean(), rowVersion });
export type ReferralReassignResult = z.output<typeof ReassignSchema>;

export function referralDraftReassign(
  client: RpcClient,
  input: { draftId: string; rowVersion: number; newOwner: string; reason: string },
): Promise<ReferralReassignResult> {
  return call(client, 'referral_draft_reassign', {
    p_draft_id: input.draftId, p_expected_row_version: input.rowVersion, p_new_owner: input.newOwner, p_reason: input.reason,
  }, ReassignSchema);
}

const LinkResultSchema = z.object({ linkId: z.uuid(), targetKind: z.enum(['lead', 'deal']), targetId: z.uuid(), rowVersion, existing: z.boolean() });
export type ReferralLinkResult = z.output<typeof LinkResultSchema>;

/** Explicit link only; never converts or books (binding is quotation_link_deal, conversion quotation_convert_to_booking). */
export function referralDraftLink(
  client: RpcClient,
  input: { draftId: string; rowVersion: number; targetKind: 'lead' | 'deal'; targetId: string; note?: string | null },
): Promise<ReferralLinkResult> {
  return call(client, 'referral_draft_link', {
    p_draft_id: input.draftId, p_expected_row_version: input.rowVersion, p_target_kind: input.targetKind,
    p_target_id: input.targetId, p_note: input.note ?? null,
  }, LinkResultSchema);
}

const UnlinkSchema = z.object({ linkId: z.uuid(), ended: z.literal(true), rowVersion });
export type ReferralUnlinkResult = z.output<typeof UnlinkSchema>;

/** rowVersion is the DRAFT's; note 10-500 characters (invalid_input hint 'note'). */
export function referralDraftUnlink(
  client: RpcClient,
  input: { linkId: string; rowVersion: number; reason: ReferralUnlinkReason; note: string },
): Promise<ReferralUnlinkResult> {
  return call(client, 'referral_draft_unlink', {
    p_link_id: input.linkId, p_expected_row_version: input.rowVersion, p_reason: input.reason, p_note: input.note,
  }, UnlinkSchema);
}
