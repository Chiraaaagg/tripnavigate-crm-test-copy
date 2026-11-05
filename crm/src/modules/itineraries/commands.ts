import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { ReferralBlockSchema } from '@/modules/quotations/commands';
import {
  FACT_PROVENANCES,
  ITINERARY_DRAFT_STATUSES,
  ITINERARY_FACT_LIMITS,
  ITINERARY_ERROR_STATES,
  ITINERARY_READINESS_CODES,
  isItinerarySubjectKind,
  ITINERARY_SUBJECT_KINDS,
  type ItineraryMoney,
  RENDER_JOB_STATUSES,
  RENDER_KINDS,
  SOURCE_MIMES,
  SOURCE_STATUSES,
  type ItineraryCreateResult,
  type ItineraryDifferencesResult,
  type ItineraryErrorCode,
  type ItineraryFacts,
  type ItineraryFactsSaveResult,
  type ItineraryReadinessCode,
  type ItineraryRenderResult,
  type ItinerarySubjectKind,
  type RenderKind,
  type SourceMime,
} from './contracts';

/**
 * Typed wrappers for Atlas's itinerary commands and reads (migration
 * 20261120000500), under the CALLER's client (the staff member's own
 * session). The render worker commands (claim/complete) are service-role
 * only and are not wrapped here. Replies are zod-validated (fail closed);
 * refusals map by SQLSTATE + exact message token; database messages are
 * never kept.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,120}(,[A-Za-z0-9_.[\]]{1,120}){0,60}$/;

type MappedCode = Exclude<ItineraryErrorCode, 'internal_wording' | 'basis_value_unavailable' | 'document_blocked'>;

export class ItineraryCommandError extends Error {
  override name = 'ItineraryCommandError';
  constructor(
    readonly command: string,
    readonly code: MappedCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: refused fact paths / input keys; not_ready: readiness codes. Never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapItineraryError(error: RpcError): MappedCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(ITINERARY_ERROR_STATES, token) && ITINERARY_ERROR_STATES[token as MappedCode] === state) return token as MappedCode;
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  return null;
}

export function isItineraryFunctionMissing(error: unknown): boolean {
  return error instanceof ItineraryCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

export function readinessFromHint(keys: readonly string[]): ItineraryReadinessCode[] {
  return keys.filter((k): k is ItineraryReadinessCode => (ITINERARY_READINESS_CODES as readonly string[]).includes(k));
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new ItineraryCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapItineraryError(result.error);
    const hint = (result.error.hint ?? '').trim();
    const keys = (code === 'invalid_input' || code === 'not_ready') && HINT_KEYS.test(hint) ? hint.split(',') : [];
    throw new ItineraryCommandError(fn, code, result.error.code ?? null, keys);
  }
  return result.data;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await invoke(client, fn, args));
  if (!parsed.success) throw new ItineraryCommandError(fn, null, null);
  return parsed.data;
}

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const rowVersion = z.number().int().nonnegative();
const optionalNull = <T extends z.ZodType>(schema: T) => schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
const text = (max: number) => optionalNull(z.string().max(max));
const int = (min: number, max: number) => optionalNull(z.number().int().min(min).max(max));
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max).nullable().optional().transform((v) => (v ?? []) as z.output<T>[]);
/** Path of a source / rendered object: uuid segments, the last one the file or job id (".pdf" for rendered files). */
const objectPath = z.string().regex(/^[0-9a-f-]{36}(\/[0-9a-f-]{36}){1,3}(\.pdf)?$/i);

/** Atlas itinerary_fact_drafts.facts as stored; missing keys read as null / []. */
export const ItineraryFactsSchema = z
  .object({
    destination: text(200),
    startDate: optionalNull(isoDate),
    endDate: optionalNull(isoDate),
    party: z
      .object({ adults: int(0, 100), children: int(0, 100), childAges: list(z.number().int().min(0).max(17), 20), infants: int(0, 100) })
      .nullable()
      .optional()
      .transform((p) => ({ adults: p?.adults ?? null, children: p?.children ?? null, childAges: p?.childAges ?? [], infants: p?.infants ?? null })),
    stays: list(
      z.object({
        city: text(120),
        nights: int(1, 60),
        checkIn: optionalNull(isoDate),
        checkOut: optionalNull(isoDate),
        hotelName: text(200),
        roomType: text(120),
        mealPlan: text(60),
        rooms: int(1, 50),
      }),
      30,
    ),
    days: list(
      z.object({
        n: z.number().int().min(1).max(60),
        date: optionalNull(isoDate),
        base: text(120),
        title: text(120),
        story: text(2000),
        highlights: list(z.string().max(200), 10),
        meals: text(60),
      }),
      60,
    ),
    transfers: list(z.object({ date: optionalNull(isoDate), from: text(200), to: text(200), mode: text(60) }), 40),
    activities: list(z.object({ date: optionalNull(isoDate), city: text(120), name: text(200), included: optionalNull(z.boolean()) }), 60),
    flights: list(z.object({ date: optionalNull(isoDate), from: text(60), to: text(60), carrier: text(60), number: text(20) }), 20),
    inclusions: list(z.string().max(300), 60),
    exclusions: list(z.string().max(300), 60),
    coverWord: text(ITINERARY_FACT_LIMITS.coverWord),
    country: text(ITINERARY_FACT_LIMITS.country),
    category: text(ITINERARY_FACT_LIMITS.category),
    roomBasis: text(ITINERARY_FACT_LIMITS.roomBasis),
    introduction: text(ITINERARY_FACT_LIMITS.introduction),
    reasons: list(z.string().max(ITINERARY_FACT_LIMITS.point), ITINERARY_FACT_LIMITS.reasons),
    handledByUs: list(z.string().max(ITINERARY_FACT_LIMITS.point), ITINERARY_FACT_LIMITS.handledByUs),
    youBring: list(z.string().max(ITINERARY_FACT_LIMITS.point), ITINERARY_FACT_LIMITS.youBring),
    provenance: z.record(z.string().max(120), z.enum(FACT_PROVENANCES)).nullable().optional().transform((v) => v ?? {}),
  })
  .nullable()
  .optional()
  .transform((f): ItineraryFacts => ({
    destination: f?.destination ?? null,
    startDate: f?.startDate ?? null,
    endDate: f?.endDate ?? null,
    party: f?.party ?? { adults: null, children: null, childAges: [], infants: null },
    stays: f?.stays ?? [],
    days: f?.days ?? [],
    transfers: f?.transfers ?? [],
    activities: f?.activities ?? [],
    flights: f?.flights ?? [],
    inclusions: f?.inclusions ?? [],
    exclusions: f?.exclusions ?? [],
    coverWord: f?.coverWord ?? null,
    country: f?.country ?? null,
    category: f?.category ?? null,
    roomBasis: f?.roomBasis ?? null,
    introduction: f?.introduction ?? null,
    reasons: f?.reasons ?? [],
    handledByUs: f?.handledByUs ?? [],
    youBring: f?.youBring ?? [],
    provenance: f?.provenance ?? {},
  }));

/**
 * The facts as the database expects them: empty values and empty lists left
 * out (all keys optional), no unknown keys.
 */
export function factsPayload(facts: ItineraryFacts): Record<string, unknown> {
  const clean = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
  const party = clean({ ...facts.party });
  return clean({
    destination: facts.destination,
    startDate: facts.startDate,
    endDate: facts.endDate,
    ...(Object.keys(party).length > 0 ? { party } : {}),
    stays: facts.stays.map((s) => clean({ ...s })),
    days: facts.days.map((d) => clean({ ...d })),
    transfers: facts.transfers.map((t) => clean({ ...t })),
    activities: facts.activities.map((a) => clean({ ...a })),
    flights: facts.flights.map((f) => clean({ ...f })),
    inclusions: facts.inclusions,
    exclusions: facts.exclusions,
    coverWord: facts.coverWord,
    country: facts.country,
    category: facts.category,
    roomBasis: facts.roomBasis,
    introduction: facts.introduction,
    reasons: facts.reasons,
    handledByUs: facts.handledByUs,
    youBring: facts.youBring,
    ...(Object.keys(facts.provenance).length > 0 ? { provenance: facts.provenance } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Batch 3 tolerant subject kinds: a row whose subject kind is a string this
 * build does not know is dropped before the strict parse (list), and such a
 * record is answered as not visible (get). A malformed row still fails.
 */
function hasUnknownSubjectKind(kind: unknown): boolean {
  return typeof kind === 'string' && !isItinerarySubjectKind(kind);
}

const ItineraryListRowsSchema = z
  .array(
    z.object({
      documentId: z.uuid(),
      title: z.string().min(1).max(200),
      subjectKind: z.enum(ITINERARY_SUBJECT_KINDS),
      draftStatus: z.enum(ITINERARY_DRAFT_STATUSES),
      factsHash: hash,
      createdAt: timestamp,
      latestFinal: z.object({ renderedId: z.uuid(), createdAt: timestamp }).nullable().optional().transform((v) => v ?? null),
    }),
  )
  .max(200);
/** Rows whose subject kind this build does not know are dropped (never a failed list). */
export const ItineraryListSchema = z.preprocess(
  (rows) => (Array.isArray(rows) ? rows.filter((r: unknown) => !(r && typeof r === 'object' && hasUnknownSubjectKind((r as { subjectKind?: unknown }).subjectKind))) : rows),
  ItineraryListRowsSchema,
);
export type ItineraryListRecord = z.output<typeof ItineraryListSchema>;

export async function itineraryDocumentList(client: RpcClient, kind: ItinerarySubjectKind, subjectId: string): Promise<ItineraryListRecord | null> {
  const fn = 'itinerary_document_list';
  const data = await invoke(client, fn, { p_subject_kind: kind, p_subject_id: subjectId });
  if (data === null) return null;
  const parsed = ItineraryListSchema.safeParse(data);
  if (!parsed.success) throw new ItineraryCommandError(fn, null, null);
  return parsed.data;
}

const paiseText = z.union([z.string().regex(/^-?\d{1,18}$/), z.number().int()]).transform(String);
/**
 * One tier of Mercury's customer money. Lenient on not-yet-priced tiers
 * (breakdownHasAmounts null while there is no total): read as false.
 */
const MoneyTierSchema = z.object({
  tierKey: z.enum(['quoted', 'upgrade']),
  label: text(120),
  quotedTotalPaise: optionalNull(paiseText),
  payingTravellers: int(0, 1000),
  perPersonPaise: optionalNull(paiseText),
  breakdownHasAmounts: z.boolean().nullable().optional().transform((v) => v ?? false),
  breakdown: list(z.object({ categoryKey: z.string().min(1).max(40), descriptions: list(z.string().max(300), 100), amountPaise: optionalNull(paiseText) }), 20),
  plan: list(
    z.object({ seq: z.number().int().min(1).max(12), label: z.string().min(1).max(60), amountPaise: paiseText, dueRule: text(40), dueDays: int(0, 3650), dueDate: optionalNull(isoDate) }),
    12,
  ),
});

/** DEC-48 `money` of itinerary_document_get / itinerary_render_input (selling side only). */
export const ItineraryMoneySchema = z.union([
  z
    .object({ source: z.literal('quotation_version'), versionId: z.uuid(), acceptedTier: optionalNull(z.enum(['quoted', 'upgrade'])), tiers: list(MoneyTierSchema, 2) })
    .transform((m): ItineraryMoney => ({ source: 'quotation_version', versionId: m.versionId, acceptedTier: m.acceptedTier, tiers: m.tiers })),
  z
    .object({
      source: z.literal('booking_version'),
      versionId: z.uuid(),
      sellingTotalPaise: optionalNull(z.string().regex(/^\d{1,18}$/)),
      plan: list(z.object({ seq: z.number().int().min(1).max(12), label: z.string().min(1).max(60), amountPaise: z.string().regex(/^\d{1,18}$/), dueDate: optionalNull(isoDate) }), 12),
    })
    .transform((m): ItineraryMoney => ({ source: 'booking_version', versionId: m.versionId, sellingTotalPaise: m.sellingTotalPaise, plan: m.plan })),
]);

export const ItineraryGetSchema = z.object({
  documentId: z.uuid(),
  title: z.string().min(1).max(200),
  subject: z.object({
    kind: z.enum(ITINERARY_SUBJECT_KINDS),
    quotationId: optionalNull(z.uuid()),
    dealId: optionalNull(z.uuid()),
    /** Batch 3: set when kind is 'referral'; absent on an older database (left optional so older fixtures parse). */
    referralDraftId: z.uuid().nullable().optional(),
    /** DEC-50 (Atlas 0800): the document's branch code; null when absent. */
    branchCode: optionalNull(z.string().max(16)),
  }),
  draft: z.object({
    draftId: z.uuid(),
    status: z.enum(ITINERARY_DRAFT_STATUSES),
    rowVersion,
    facts: ItineraryFactsSchema,
    factsHash: hash,
    sourceFileId: optionalNull(z.uuid()),
    updatedAt: optionalNull(timestamp),
  }),
  basis: z.object({ kind: z.enum(['quotation_version', 'booking_version', 'none']), id: optionalNull(z.uuid()), hash }),
  differences: z.object({
    runId: optionalNull(z.uuid()),
    current: z.boolean(),
    items: list(
      z.object({
        differenceId: z.uuid(),
        path: z.string().min(1).max(120),
        kind: z.enum(['missing', 'different', 'extra']),
        acknowledged: z.boolean(),
        acknowledgedByName: optionalNull(z.string().max(200)),
        acknowledgedAt: optionalNull(timestamp),
        note: optionalNull(z.string().max(500)),
      }),
      2000,
    ),
  }),
  sources: list(
    z.object({ fileId: z.uuid(), fileName: z.string().min(1).max(120), mime: z.enum(SOURCE_MIMES), sizeBytes: z.number().int().nonnegative(), status: z.enum(SOURCE_STATUSES), createdAt: timestamp }),
    50,
  ),
  jobs: list(
    z.object({
      jobId: z.uuid(),
      kind: z.enum(RENDER_KINDS),
      status: z.enum(RENDER_JOB_STATUSES),
      attempts: z.number().int().min(0).max(100),
      lastErrorCode: optionalNull(z.string().max(60)),
      createdAt: timestamp,
      finishedAt: optionalNull(timestamp),
    }),
    20,
  ),
  rendered: list(
    z.object({
      renderedId: z.uuid(),
      kind: z.enum(RENDER_KINDS),
      pageCount: optionalNull(z.number().int().min(0).max(500)),
      sizeBytes: z.number().int().nonnegative(),
      createdAt: timestamp,
      qa: z
        .object({
          placeholders: z.number().int().nonnegative().optional().transform((v) => v ?? 0),
          layoutIssues: z.array(z.string().max(60)).max(100).optional().transform((v) => v ?? []),
          safetyHits: z.array(z.string().max(60)).max(100).optional().transform((v) => v ?? []),
        })
        .nullable()
        .optional()
        .transform((v) => v ?? null),
    }),
    200,
  ),
  /** DEC-48: present (non-null) only for staff who may read the customer prices and a priced basis. */
  money: ItineraryMoneySchema.nullable().optional().transform((v) => v ?? null),
  /** Batch 3 (20261123000100): the referral draft behind the document; null otherwise; absent on an older database. */
  referral: ReferralBlockSchema.nullable().optional(),
});
export type ItineraryGetRecord = z.output<typeof ItineraryGetSchema>;

export async function itineraryDocumentGet(client: RpcClient, documentId: string): Promise<ItineraryGetRecord | null> {
  const fn = 'itinerary_document_get';
  const data = await invoke(client, fn, { p_document_id: documentId });
  if (data === null) return null;
  // Batch 3: a subject kind this build does not know is answered like "not visible", never a failed page.
  if (data && typeof data === 'object' && hasUnknownSubjectKind((data as { subject?: { kind?: unknown } }).subject?.kind)) return null;
  const parsed = ItineraryGetSchema.safeParse(data);
  if (!parsed.success) throw new ItineraryCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function itineraryDocumentCreate(
  client: RpcClient,
  input: { subjectKind: ItinerarySubjectKind; subjectId: string; title: string; requestId: string },
): Promise<ItineraryCreateResult> {
  return call(
    client,
    'itinerary_document_create',
    { p_subject_kind: input.subjectKind, p_subject_id: input.subjectId, p_title: input.title, p_request_id: input.requestId },
    z.object({ documentId: z.uuid(), draftId: z.uuid(), rowVersion, created: z.boolean() }),
  );
}

export function itinerarySourceBegin(
  client: RpcClient,
  input: { documentId: string; fileName: string; mime: SourceMime; sizeBytes: number; sha256: string },
): Promise<{ fileId: string; objectPath: string }> {
  return call(
    client,
    'itinerary_source_begin',
    { p_document_id: input.documentId, p_file_name: input.fileName, p_mime: input.mime, p_size_bytes: input.sizeBytes, p_sha256: input.sha256 },
    z.object({ fileId: z.uuid(), objectPath }),
  );
}

export function itinerarySourceFinish(client: RpcClient, fileId: string, ok: boolean): Promise<{ fileId: string; status: 'stored' | 'failed' }> {
  return call(client, 'itinerary_source_finish', { p_file_id: fileId, p_ok: ok }, z.object({ fileId: z.uuid(), status: z.enum(['stored', 'failed']) }));
}

export function itinerarySourceRemove(client: RpcClient, fileId: string): Promise<{ fileId: string; status: 'removed' }> {
  return call(client, 'itinerary_source_remove', { p_file_id: fileId }, z.object({ fileId: z.uuid(), status: z.literal('removed') }));
}

export function itinerarySourceAuthorizeDownload(client: RpcClient, fileId: string): Promise<{ objectPath: string; fileName: string; mime: SourceMime }> {
  return call(
    client,
    'itinerary_source_authorize_download',
    { p_file_id: fileId },
    z.object({ objectPath, fileName: z.string().min(1).max(120), mime: z.enum(SOURCE_MIMES) }),
  );
}

export function itineraryFactsSave(
  client: RpcClient,
  input: { draftId: string; expectedRowVersion: number; facts: ItineraryFacts; sourceFileId: string | null },
): Promise<ItineraryFactsSaveResult> {
  return call(
    client,
    'itinerary_facts_save',
    { p_draft_id: input.draftId, p_expected_row_version: input.expectedRowVersion, p_facts: factsPayload(input.facts), p_source_file_id: input.sourceFileId },
    z.object({ rowVersion, factsHash: hash, status: z.literal('draft') }).transform((r) => ({ rowVersion: r.rowVersion, factsHash: r.factsHash })),
  );
}

export function itineraryDifferencesSave(
  client: RpcClient,
  input: {
    draftId: string;
    expectedRowVersion: number;
    basisKind: 'quotation_version' | 'booking_version' | 'none';
    basisId: string | null;
    basisHash: string;
    /** Exactly as Nova computed them; the value hashes (E3-9) let an acknowledgement carry over while both values stay the same. */
    differences: ReadonlyArray<{ path: string; kind: 'missing' | 'different' | 'extra'; factsValueHash?: string | null; basisValueHash?: string | null }>;
  },
): Promise<ItineraryDifferencesResult> {
  return call(
    client,
    'itinerary_differences_save',
    {
      p_draft_id: input.draftId,
      p_expected_row_version: input.expectedRowVersion,
      p_basis_kind: input.basisKind,
      p_basis_id: input.basisId,
      p_basis_hash: input.basisHash,
      // Paths, kinds and value hashes only: never a value.
      p_differences: input.differences.map((d) => ({
        path: d.path,
        kind: d.kind,
        ...(d.factsValueHash ? { factsValueHash: d.factsValueHash } : {}),
        ...(d.basisValueHash ? { basisValueHash: d.basisValueHash } : {}),
      })),
    },
    z.object({ runId: z.uuid(), differenceCount: z.number().int().nonnegative(), openCount: z.number().int().nonnegative(), outcome: z.enum(['created', 'existing']) }),
  );
}

export function itineraryDifferenceAcknowledge(client: RpcClient, input: { differenceId: string; note: string | null }): Promise<{ differenceId: string; acknowledged: true }> {
  return call(
    client,
    'itinerary_difference_acknowledge',
    { p_difference_id: input.differenceId, p_note: input.note },
    z.object({ differenceId: z.uuid(), acknowledged: z.literal(true) }),
  );
}

export function itineraryFactsMarkReady(client: RpcClient, input: { draftId: string; expectedRowVersion: number }): Promise<{ rowVersion: number }> {
  return call(
    client,
    'itinerary_facts_mark_ready',
    { p_draft_id: input.draftId, p_expected_row_version: input.expectedRowVersion },
    z.object({ status: z.literal('ready'), rowVersion }).transform((r) => ({ rowVersion: r.rowVersion })),
  );
}

export function itineraryRenderRequest(
  client: RpcClient,
  input: { documentId: string; kind: RenderKind; inputHash: string; templateVersion: string },
): Promise<ItineraryRenderResult> {
  return call(
    client,
    'itinerary_render_request',
    { p_document_id: input.documentId, p_kind: input.kind, p_input_hash: input.inputHash, p_template_version: input.templateVersion },
    z.object({ jobId: z.uuid(), status: z.enum(RENDER_JOB_STATUSES), outcome: z.enum(['created', 'existing']) }),
  );
}

export function itineraryRenderedAuthorizeDownload(client: RpcClient, renderedId: string): Promise<{ objectPath: string; fileName: string }> {
  return call(
    client,
    'itinerary_rendered_authorize_download',
    { p_rendered_id: renderedId },
    z.object({ objectPath, mime: z.literal('application/pdf'), fileName: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).transform((r) => ({ objectPath: r.objectPath, fileName: r.fileName })),
  );
}
