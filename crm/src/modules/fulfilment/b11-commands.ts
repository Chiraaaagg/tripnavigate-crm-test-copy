import { z } from 'zod';
import {
  BookingCommandError,
  BookingPanelSchema,
  callRpc,
  flag,
  IdentitySchema,
  mapBookingError,
  parseReply,
  type RpcClient,
  type RpcError,
  ServiceFactsSchema,
  ServiceItemRecordSchema,
  TripSchema,
} from './commands';
import {
  BOOK_VERSION_STATUSES,
  type BillingProposalFields,
  type BookingContactFields,
  type BookingCustomerSaveResult,
  type BookingTripFields,
  CHANGE_CLASSES,
  type ClaimTaskResult,
  COST_KINDS,
  COST_PAID_BY,
  COST_PAYMENT_MODES,
  DEPARTMENT_EVIDENCE_KINDS,
  DEPARTMENT_TASK_STATUSES,
  type DepartmentCostFields,
  type DepartmentCostSaveResult,
  type DepartmentEvidenceKind,
  type DiscardDraftResult,
  type DraftSaveResult,
  EXPENSE_STATUSES,
  type EvidenceMime,
  ID_PROOF_MAX_BYTES,
  ID_PROOF_MAX_FILES_PER_TRAVELLER,
  ID_PROOF_STATUSES,
  type OpenRevisionResult,
  type ClassifyRevisionResult,
  type PlanInstalment,
  type SubmitBookingResult,
  TRAVELLER_TYPES,
  type TravellerDetails,
  type TravellerIdentityFields,
  type TravellerIdentitySaveResult,
  type TravellerIdProofRemoveResult,
  VISA_APPLICATION_STATES,
  VISA_DOCUMENT_STATUSES,
  type VisaApplicationFields,
  type VisaApplicationResult,
  type VisaDocumentStatus,
  type VisaStateCommand,
  type BillingProposeResult,
  type BookingPrefillField,
  type PrefillApplyResult,
  type PrefillCheckedResult,
  type PrefillFieldCode,
  type PrefillMarkState,
  type PrefillSkipReason,
  type PrefillTargetKind,
  PREFILL_CUSTOMER_TYPES,
  PREFILL_MARK_STATES,
  PREFILL_SKIP_REASONS,
  QUOTATION_PREFILL_FIELDS,
  ID_PROOF_COPY_STATUSES,
  isSpecialRequestCode,
  type SpecialRequestCode,
} from './contracts';
import { BookingStartDraftSchema, PrefillAutoKeysShape } from './prefill-auto';
import {
  CUSTOMER_MARKETS,
  CUSTOMER_TYPES,
  PAX_TOTAL_MAX,
  PRICE_CATEGORIES,
  SERVICE_ITEM_FILE_MAX_BYTES,
  type BillToKeys,
  type CustomerMarket,
  type CustomerType,
  type IdentityExtraKeys,
  type PriceLine,
  type PricesSaveResult,
  type ServiceEstimate,
  type ServiceSaveResult,
  type TripSavePartyKeys,
} from './booking-form-contract';

/**
 * B1.1 wrappers (migrations 20261119000100 / 0300 / 0500, appendix A). Same
 * rules as commands.ts: the caller's own session, zod-validated replies
 * (fail closed: anything unexpected throws BookingCommandError code null),
 * refusals mapped by SQLSTATE + exact token, database messages never kept.
 *
 * database.types.ts does not list these functions yet (only the lead
 * regenerates it); they go through the same untyped RpcClient surface B1
 * used before its types existed.
 */

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const rowVersion = z.number().int().nonnegative();
const paise = z
  .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,18})$/)])
  .transform(String);
const signedPaise = z
  .union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/)])
  .transform(String);
const optionalNull = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
const text = (max: number) => z.string().max(max);
const EVIDENCE_STATUSES = ['pending_upload', 'stored', 'failed', 'removed'] as const;
const BOOKING_EVIDENCE_KINDS = ['acceptance_message', 'ticket', 'bill', 'payment_proof', 'other'] as const;
const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const satisfies readonly EvidenceMime[];

// ---------------------------------------------------------------------------
// booking_form_get (appendix A §1.5, freeze note D7)
// ---------------------------------------------------------------------------

const FormVersionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(BOOK_VERSION_STATUSES),
  serviceType: z.enum(['hotel', 'package']).optional().transform((v) => v ?? 'package'),
  rowVersion,
  contentHash: hash,
  updatedAt: optionalNull(timestamp),
  updatedByName: optionalNull(z.string().max(200)),
  confirmedAt: optionalNull(timestamp),
  /** 0300: the base this revision draft fixes. */
  revisesVersionId: optionalNull(z.uuid()),
  /** Booking form (20261124000100): 1 = rules before the booking form, 2 = started in it or converted. Absent on an older database (undefined; read as 1). */
  formRules: z.union([z.literal(1), z.literal(2)]).nullable().optional().transform((v) => v ?? undefined),
});

const ContactsSchema = z.object({
  contactName: z.string().min(1).max(120),
  mobile: optionalNull(z.string().regex(/^[6-9][0-9]{9}$/)),
  email: optionalNull(z.string().max(254)),
  contactConfirmed: flag,
  confirmedAt: optionalNull(timestamp),
  confirmedByName: optionalNull(z.string().max(200)),
  bookingFor: z.enum(['individual', 'business']),
  payerDifferent: flag,
  payerName: optionalNull(z.string().max(200)),
  /** Booking form: plain labels (no tax, currency or price effect); absent on an older database. */
  customerType: optionalNull(z.enum(CUSTOMER_TYPES)),
  market: optionalNull(z.enum(CUSTOMER_MARKETS)),
});

const BillingSchema = z.object({
  status: z.enum(['none', 'draft', 'verified']),
  prefillSource: optionalNull(z.enum(['none', 'sales'])),
  rowVersion,
  billingName: optionalNull(text(200)),
  addressLine1: optionalNull(text(200)),
  addressLine2: optionalNull(text(200)),
  city: optionalNull(text(120)),
  stateCode: optionalNull(text(2)),
  postalCode: optionalNull(text(6)),
  gstin: optionalNull(text(15)),
  // Booking form Bill To (20261124000100; absent or null on a legacy profile).
  billToType: optionalNull(z.enum(['personal', 'business'])),
  contactPerson: optionalNull(text(120)),
  phone: optionalNull(text(20)),
  email: optionalNull(text(254)),
  gstStatus: optionalNull(z.enum(['registered', 'unregistered'])),
  gstReason: optionalNull(text(500)),
  verifiedByName: optionalNull(text(200)),
  verifiedAt: optionalNull(timestamp),
  // Voice-note batch (20261128000130): the stored customer this billing was copied from; absent on an older database.
  partyId: z.uuid().nullable().optional(),
  partyCheckStatus: z.enum(['not_checked', 'checked', 'returned']).nullable().optional().catch(undefined),
});

/** B1.2 (0100): one live identity-proof file in booking_form_get travellers[].idProofs (removed files never listed). */
export const IdProofRowSchema = z.object({
  fileId: z.uuid(),
  fileName: z.string().min(1).max(120),
  mime: z.enum(MIMES),
  sizeBytes: z.number().int().min(1).max(ID_PROOF_MAX_BYTES),
  status: z.enum(ID_PROOF_STATUSES),
  rowVersion: z.number().int().positive(),
  uploadedByName: optionalNull(z.string().max(200)),
  uploadedByYou: flag,
  /** DEC-39: who ticked "Customer agreed to share this ID for this booking", and when. */
  consentByName: optionalNull(z.string().max(200)),
  consentAt: timestamp,
  createdAt: timestamp,
  storedAt: optionalNull(timestamp),
});
export type IdProofRecord = z.output<typeof IdProofRowSchema>;

/** Identity plus the booking form passenger extras (restricted readers only; absent on an older database). */
const FormIdentitySchema = IdentitySchema.extend({
  dateOfMarriage: optionalNull(isoDate),
  phone: optionalNull(text(20)),
  email: optionalNull(text(254)),
  /** Voice-note batch (20261128000110): 0..3 extra phones (identity readers only); absent on an older database. */
  extraPhones: z.array(text(20)).max(3).nullable().optional().transform((v) => v ?? undefined),
});

// ---------------------------------------------------------------------------
// Booking form read keys (20261124000120). Every key is optional: the app
// ships before its migration and must load on a database without it.
// ---------------------------------------------------------------------------

const PartySchema = z.object({
  total: optionalNull(z.number().int().min(1).max(PAX_TOTAL_MAX)),
  /** Voice-note batch (20261128000110): adults_count; absent on an older database, null on older versions. */
  adults: z.number().int().min(0).max(PAX_TOTAL_MAX).nullable().optional(),
  children: optionalNull(z.number().int().min(0).max(PAX_TOTAL_MAX)),
  infants: optionalNull(z.number().int().min(0).max(PAX_TOTAL_MAX)),
});

const PriceLineRowSchema = z.object({
  category: z.enum(PRICE_CATEGORIES),
  quantity: z.number().int().min(0).max(PAX_TOTAL_MAX),
  purchasePaise: optionalNull(paise),
  markupPaise: optionalNull(signedPaise),
  salePaise: optionalNull(paise),
}) satisfies z.ZodType<PriceLine, unknown>;

/** Commercial readers only: absent for everyone else (never null-with-values). */
const PricesSchema = z.object({
  lines: z.array(PriceLineRowSchema).max(PRICE_CATEGORIES.length),
  source: z.enum(['per_person', 'quotation_total', 'legacy_total']).optional(),
  linesRequired: z.boolean().optional(),
  /** Every line with people has all three amounts. */
  complete: z.boolean().optional(),
  sellingTotalPaise: optionalNull(paise),
});

const EstimateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hotel'), roomRatePaise: optionalNull(paise), extraBedRatePaise: optionalNull(paise), noBedRatePaise: optionalNull(paise) }),
  z.object({ kind: z.literal('transfer'), vehicleRatePaise: optionalNull(paise) }),
  z.object({ kind: z.literal('flight'), fareTotalPaise: optionalNull(paise) }),
]) satisfies z.ZodType<ServiceEstimate, unknown>;

const ItemFileRowSchema = z.object({
  fileId: z.uuid(),
  kind: z.literal('flight_screenshot'),
  fileName: z.string().min(1).max(120),
  mime: z.enum(MIMES),
  sizeBytes: z.number().int().min(1).max(SERVICE_ITEM_FILE_MAX_BYTES),
  status: z.enum(EVIDENCE_STATUSES),
  uploadedByYou: flag,
  createdAt: timestamp,
  storedAt: optionalNull(timestamp),
  rowVersion: z.number().int().positive(),
});
export type ItemFileRecord = z.output<typeof ItemFileRowSchema>;

/** A service item of booking_form_get plus the booking form keys (estimate and files only for allowed viewers). */
const FormItemSchema = ServiceItemRecordSchema.extend({
  estimate: EstimateSchema.nullable().optional(),
  files: z.array(ItemFileRowSchema).max(20).optional(),
});
export type FormItemRecord = z.output<typeof FormItemSchema>;

const FormTravellerSchema = z.object({
  travellerId: optionalNull(z.uuid()),
  seq: z.number().int().min(1).max(100),
  fullName: z.string().min(1).max(120),
  type: z.enum(TRAVELLER_TYPES),
  ageYears: optionalNull(z.number().int().min(0).max(17)),
  specialNeeds: optionalNull(text(500)),
  /** Voice-note batch (20261128000110): standard request codes; unknown codes are dropped, absent on an older database. */
  specialRequests: z
    .array(z.string().max(40))
    .max(20)
    .nullable()
    .optional()
    .transform((v) => (v ? v.filter(isSpecialRequestCode) : undefined)),
  identity: FormIdentitySchema.nullable().optional().transform((v) => v ?? null),
  /** B1.2 (0100): ABSENT (not empty) when the caller may not read identity proofs. */
  /** Pending, stored AND failed rows are listed while the cap counts only live (pending + stored): never bound by the cap. */
  idProofs: z.array(IdProofRowSchema).max(100).optional(),
});

export const BookingEvidenceRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(BOOKING_EVIDENCE_KINDS),
  fileName: z.string().max(120),
  mime: z.enum(MIMES).optional(),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(EVIDENCE_STATUSES),
  uploadedByYou: flag,
  createdAt: timestamp,
});

const CommercialsSchema = z.object({
  listPricePaise: optionalNull(paise),
  discountPaise: optionalNull(paise),
  sellingTotalPaise: optionalNull(paise),
});

export const PlanRowSchema = z.object({
  seq: z.number().int().min(1).max(12),
  label: z.string().min(1).max(60),
  amountPaise: paise,
  dueDate: isoDate,
});

// ---------------------------------------------------------------------------
// B1.2 Bitrix prefill (0600, Atlas shapes note): the `prefill` block of
// booking_form_get and quotation_get, and the three commands. Unknown field
// codes and Customer Type options are dropped / read as null rather than
// failing the whole form read.
// ---------------------------------------------------------------------------

const PREFILL_CODES = new Set<string>(QUOTATION_PREFILL_FIELDS);
const isPrefillCode = (v: string): v is PrefillFieldCode => PREFILL_CODES.has(v);
const MARK_STATES = new Set<string>(PREFILL_MARK_STATES);
const isMarkState = (v: string): v is PrefillMarkState => MARK_STATES.has(v);
const SKIP_REASONS = new Set<string>(PREFILL_SKIP_REASONS);
const isSkipReason = (v: string): v is PrefillSkipReason => SKIP_REASONS.has(v);

/**
 * Batch 2 tolerant parse (lead Step 0): a field code, mark state or skip
 * reason this code does not know is dropped, never a reason to fail the read
 * or the command reply. A newer database (migration A applied before this
 * code, or a later state) must not turn every Book now or quotation page into
 * "could not load". The shape itself (types, limits) still fails closed.
 */
const prefillCodeList = z
  .array(z.string().min(1).max(60))
  .max(20)
  .transform((codes) => codes.filter(isPrefillCode));
const prefillSkipList = z
  .array(z.object({ field: z.string().min(1).max(60), reason: z.string().min(1).max(60) }))
  .max(20)
  .transform((rows) => rows.flatMap((r) => (isPrefillCode(r.field) && isSkipReason(r.reason) ? [{ field: r.field, reason: r.reason }] : [])));
const prefillText = (max: number) => z.string().max(max).nullable().optional().transform((v) => v ?? null);
const prefillDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null);

export const PrefillSchema = z.object({
  available: z.boolean(),
  sourceModifiedAt: timestamp.nullable().optional().transform((v) => v ?? null),
  lastVerifiedAt: timestamp.nullable().optional().transform((v) => v ?? null),
  issues: z.array(z.string().min(1).max(80)).max(50).nullable().optional().transform((v) => v ?? []),
  /** Atlas E5-3: Booking Notes withheld (no commercial scope). Absent before E5: read as false. */
  notesHidden: z.boolean().optional().transform((v) => v ?? false),
  fields: z.object({
    bookingNotes: prefillText(4000),
    travellerTotal: z.number().int().min(0).max(1000).nullable().optional().transform((v) => v ?? null),
    tourStart: prefillDate,
    tourEnd: prefillDate,
    customerType: z
      .object({ code: z.string().max(40).nullable().optional() })
      .nullable()
      .optional()
      .transform((v) => (v ? { code: (PREFILL_CUSTOMER_TYPES as readonly string[]).includes(v.code ?? '') ? (v.code as (typeof PREFILL_CUSTOMER_TYPES)[number]) : null } : null)),
    contact: z.object({ name: prefillText(400), mobile: prefillText(80), email: prefillText(400) }).nullable().optional().transform((v) => v ?? null),
    company: z.object({ name: prefillText(400), phone: prefillText(80), email: prefillText(400) }).nullable().optional().transform((v) => v ?? null),
  }),
  marks: z
    .array(z.object({ fieldCode: z.string().min(1).max(60), state: z.string().min(1).max(60), appliedAt: timestamp, checkedAt: timestamp.nullable().optional().transform((v) => v ?? null) }))
    .max(20)
    .nullable()
    .optional()
    .transform((v) => (v ?? []).flatMap((m) => (isPrefillCode(m.fieldCode) && isMarkState(m.state) ? [{ ...m, fieldCode: m.fieldCode, state: m.state }] : []))),
  /** Batch 2 (migration A, Atlas prefill-auto.ts): the switch, the creation fill run and per-field states; absent before A. */
  ...PrefillAutoKeysShape,
});
export type PrefillRecord = z.output<typeof PrefillSchema>;

export const PrefillApplySchema = z.object({
  rowVersion: z.number().int().positive(),
  contentHash: z.string().min(1).max(128).nullable().optional(),
  applied: prefillCodeList,
  skipped: prefillSkipList,
}) satisfies z.ZodType<PrefillApplyResult, unknown>;
/** Batch 2: `notChecked` lists requested fields not upgraded (state null = no mark); absent before migration A. */
export const PrefillCheckedSchema = z.object({
  checked: prefillCodeList,
  notChecked: z
    .array(z.object({ field: z.string().min(1).max(60), state: z.string().min(1).max(60).nullable().optional() }))
    .max(20)
    .optional()
    .transform((rows) =>
      rows === undefined
        ? undefined
        : rows.flatMap((r) => (isPrefillCode(r.field) && (r.state == null || isMarkState(r.state)) ? [{ field: r.field, state: r.state ?? null }] : [])),
    ),
}) satisfies z.ZodType<PrefillCheckedResult, unknown>;

/** "Use Bitrix values" on the Book now working draft (same gate as Book now saves; prefill_unavailable when nothing was read). */
export async function bookingPrefillApply(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; fields: readonly BookingPrefillField[] },
): Promise<PrefillApplyResult> {
  const fn = 'booking_prefill_apply';
  const data = await callRpc(client, fn, { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: [...input.fields] });
  return parseReply(fn, PrefillApplySchema, data);
}

/** "Mark checked": only fields still marked from Bitrix change; the row version does not move. */
export async function prefillMarkChecked(
  client: RpcClient,
  input: { targetKind: PrefillTargetKind; targetId: string; expectedRowVersion: number; fields: readonly PrefillFieldCode[] },
): Promise<PrefillCheckedResult> {
  const fn = 'prefill_mark_checked';
  const data = await callRpc(client, fn, {
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_expected_row_version: input.expectedRowVersion,
    p_fields: [...input.fields],
  });
  return parseReply(fn, PrefillCheckedSchema, data);
}

// ---------------------------------------------------------------------------
// Voice-note batch: trip facts from the Bitrix Deal (Atlas shapes v1 §b)
// ---------------------------------------------------------------------------

const factSource = z.enum(['bitrix', 'booking', 'missing']);
const factOf = <T extends z.ZodType>(value: T) =>
  z.object({ bitrix: value.nullable(), booking: value.nullable().optional().transform((v) => v ?? null), source: factSource, differs: z.boolean().optional().transform((v) => v ?? false) });
const factCount = z.number().int().min(0).max(1000);

export const TripFactsSchema = z.object({
  enabled: z.boolean(),
  readAt: optionalNull(timestamp),
  fields: z.object({
    destination: z.object({
      bitrix: z.object({ optionId: z.string().max(40), label: z.string().max(200).nullable(), listId: z.string().max(40) }).nullable(),
      booking: optionalNull(z.string().max(200)),
      source: factSource,
      differs: z.boolean().optional().transform((v) => v ?? false),
    }),
    scope: z.object({
      bitrix: z.enum(['domestic', 'international']).nullable(),
      booking: optionalNull(z.enum(['domestic', 'international'])),
      source: factSource,
      classified: z.boolean().optional().transform((v) => v ?? false),
    }),
    start: factOf(isoDate),
    end: factOf(isoDate),
    total: factOf(factCount),
    adults: factOf(factCount),
    children: factOf(factCount),
    infants: factOf(factCount),
  }),
  countsConsistent: z.boolean().nullable().optional().transform((v) => v ?? null),
  issues: z.array(z.string().max(80)).max(50).nullable().optional().transform((v) => v ?? []),
});
export type TripFactsRecord = z.output<typeof TripFactsSchema>;

export const BookingFormSchema = z.object({
  dealId: z.uuid(),
  canEdit: flag,
  /** null before any version exists (booking_form_get): nothing to confirm yet, read as false. */
  canConfirm: flag,
  /** Atlas review fix (0100): commercial editor; absent on the first 0100 text. */
  canEditCommercials: z.boolean().nullable().optional().transform((v) => (v === undefined ? undefined : (v ?? false))),
  serviceItemsEnabled: flag,
  visaPassportTasksEnabled: z.boolean().nullable().optional().transform((v) => v ?? false),
  dealNotActive: z.boolean().nullable().optional().transform((v) => v ?? false),
  version: FormVersionSchema.nullable(),
  trip: TripSchema.nullable().optional(),
  contacts: ContactsSchema.nullable().optional().transform((v) => v ?? null),
  billing: BillingSchema,
  travellers: z.array(FormTravellerSchema).max(100),
  items: z.array(FormItemSchema).max(20),
  evidence: z.array(BookingEvidenceRowSchema),
  /** Present (possibly null = no row yet) only with commercial scope; absent otherwise. */
  commercials: CommercialsSchema.nullable().optional(),
  plan: z.array(PlanRowSchema).max(12).optional(),
  /** B1.2 (0200): the accepted quotation this version was converted from; null when not from a quotation. */
  sourceQuotation: z
    .object({
      quotationId: z.uuid(),
      reference: z.string().min(1).max(40),
      versionId: z.uuid(),
      versionNo: z.number().int().positive(),
      acceptedAt: optionalNull(timestamp),
      acceptedTierKey: optionalNull(z.enum(['quoted', 'upgrade'])),
      acceptanceEvidenceId: optionalNull(z.uuid()),
    })
    .nullable()
    .optional(),
  /** B1.2 (0100, D2-3): booking editor AND switch on AND Deal active (true after submission too). Absent on an older database. */
  idProofCanEdit: z.boolean().optional(),
  /** B1.2 (0100, D3): booking editor AND Deal not removed by the sync (true with the switch off, on a lost Deal, after submission). */
  idProofCanRemove: z.boolean().optional(),
  /** B1.2 (0100): identity-proof limits (absent on an older database). */
  idProofLimits: z
    .object({ maxFilesPerTraveller: z.number().int().min(1).max(ID_PROOF_MAX_FILES_PER_TRAVELLER), maxBytes: z.number().int().min(1).max(ID_PROOF_MAX_BYTES) })
    .optional(),
  /** B1.2 (0600): Bitrix values and marks of the working version (absent on an older database; null without a Deal). */
  prefill: PrefillSchema.nullable().optional(),
  /** Booking form: party counts of the working version (absent on an older database). */
  party: PartySchema.nullable().optional(),
  /** Booking form: per-person prices, commercial readers only (absent otherwise). */
  prices: PricesSchema.nullable().optional(),
  /** Booking form: hotel night coverage worked out by the database (null without a version). */
  // Echo H1: never fails the whole read. A long list is trimmed; anything unexpected reads as absent (the view model then works coverage out itself).
  coverage: z
    .object({
      nights: z.number().int().min(0).nullable(),
      covered: z.number().int().min(0),
      missing: z.array(isoDate).transform((v) => v.slice(0, 366)),
      outside: z.array(z.uuid()).transform((v) => v.slice(0, 20)),
    })
    .nullable()
    .optional()
    .catch(undefined),
  /** Booking form: the viewer may attach and remove item files (flight screenshots). */
  itemFilesCanEdit: z.boolean().optional(),
  /** Voice-note batch (20261128000110): trip facts from the Bitrix Deal; anything unexpected reads as absent (the form then asks as before). */
  tripFacts: TripFactsSchema.nullable().optional().catch(undefined),
});
export type BookingFormRecord = z.output<typeof BookingFormSchema>;

/**
 * Echo M3 (release order): whether the database already has the booking form
 * change (20261124000100–0120). Its read always carries itemFilesCanEdit and
 * party (null without a version) and a version's formRules; an older database
 * sends none of them. Saves send the new keys only when this is true.
 */
export function bookingFormInstalled(form: Pick<BookingFormRecord, 'itemFilesCanEdit' | 'party' | 'version'>): boolean {
  return form.itemFilesCanEdit !== undefined || form.party !== undefined || form.version?.formRules !== undefined;
}

/** null = the caller may not edit or accept this Deal's booking (or the Deal is not visible). */
export async function bookingFormGet(client: RpcClient, dealId: string): Promise<BookingFormRecord | null> {
  const fn = 'booking_form_get';
  const data = await callRpc(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parseReply(fn, BookingFormSchema, data);
}

// ---------------------------------------------------------------------------
// booking_panel with the 0300 additions (accountsReview, revision, canRevise)
// ---------------------------------------------------------------------------

const AccountsReviewSchema = z.object({
  status: z.enum(['pending', 'returned', 'approved']),
  reviewedAt: optionalNull(timestamp),
  reason: optionalNull(z.string().max(500)),
  reasonHidden: z.boolean().nullable().optional().transform((v) => v ?? false),
});

const RevisionPanelSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  rowVersion,
  contentHash: hash,
  changeClass: optionalNull(z.enum(CHANGE_CLASSES)),
  changedFields: z.array(z.string().max(120)).optional().transform((v) => v ?? []),
  allowedClasses: z.array(z.enum(CHANGE_CLASSES)).nullable().optional(),
});

export const BookingPanelB11Schema = BookingPanelSchema.extend({
  accountsReview: AccountsReviewSchema.nullable().optional(),
  revision: RevisionPanelSchema.nullable().optional(),
  /** null when no revision can apply (booking_panel): read as false. */
  canRevise: z.boolean().nullable().optional().transform((v) => v ?? false),
});
export type BookingPanelB11Record = z.output<typeof BookingPanelB11Schema>;

export async function bookingPanelB11(client: RpcClient, dealId: string): Promise<BookingPanelB11Record | null> {
  const fn = 'booking_panel';
  const data = await callRpc(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parseReply(fn, BookingPanelB11Schema, data);
}

// ---------------------------------------------------------------------------
// Book now commands
// ---------------------------------------------------------------------------

const DraftSaveSchema = z.object({ rowVersion, contentHash: hash }) satisfies z.ZodType<DraftSaveResult, unknown>;
/** booking_trip_save (voice-note batch): `bitrixFields` = keys the server took from the Bitrix Deal instead of the input. */
const TripSaveSchema = z.object({ rowVersion, contentHash: hash, bitrixFields: z.array(z.string().max(40)).max(20).optional().transform((v) => v ?? []) });

const BillingResultSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  status: z.literal('draft'),
  rowVersion,
}) satisfies z.ZodType<BillingProposeResult, unknown>;

const CustomerSaveSchema = z
  .object({
    rowVersion,
    contentHash: hash,
    billing: BillingResultSchema.nullable().optional().transform((v) => v ?? null),
    /** 'existing' on an exact retry (stored result replayed). */
    outcome: z.string().max(20).optional(),
  })
  .transform(
    (r): BookingCustomerSaveResult => ({
      rowVersion: r.rowVersion,
      contentHash: r.contentHash,
      billing: r.billing,
      ...(r.outcome === 'existing' ? { replayed: true } : {}),
    }),
  );

export async function bookingCustomerSave(
  client: RpcClient,
  input: {
    versionId: string;
    expectedRowVersion: number;
    /** Booking form: customerType and market are sent only by the booking form (absent = unchanged). */
    contact: BookingContactFields & { customerType?: CustomerType | null; market?: CustomerMarket | null };
    billing: BillingProposalFields | null;
    billingExpectedRowVersion: number;
    requestId: string;
  },
): Promise<BookingCustomerSaveResult> {
  const fn = 'booking_customer_save';
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_contact: input.contact,
    p_billing: input.billing,
    p_billing_expected_row_version: input.billingExpectedRowVersion,
    p_request_id: input.requestId,
  });
  return parseReply(fn, CustomerSaveSchema, data);
}

export async function bookingContactsSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; fields: BookingContactFields },
): Promise<DraftSaveResult> {
  const fn = 'booking_contacts_save';
  const data = await callRpc(client, fn, { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: input.fields });
  return parseReply(fn, DraftSaveSchema, data);
}

export async function bookingBillingPropose(
  client: RpcClient,
  input: { dealId: string; expectedRowVersion: number; fields: BillingProposalFields & BillToKeys; requestId: string },
): Promise<BillingProposeResult> {
  const fn = 'booking_billing_propose';
  const data = await callRpc(client, fn, {
    p_deal_id: input.dealId,
    p_expected_row_version: input.expectedRowVersion,
    p_fields: input.fields,
    p_request_id: input.requestId,
  });
  return parseReply(fn, BillingResultSchema, data);
}

export async function bookingTripSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; fields: BookingTripFields & TripSavePartyKeys & { adults?: number | null } },
): Promise<DraftSaveResult & { bitrixFields: string[] }> {
  const fn = 'booking_trip_save';
  const data = await callRpc(client, fn, { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion, p_fields: input.fields });
  return parseReply(fn, TripSaveSchema, data);
}

/** deal_travellers_save with the B1.1 row keys (ageYears, specialNeeds); upsert by seq. */
export async function dealTravellersSaveDetails(
  client: RpcClient,
  input: { dealId: string; expectedRowVersion: number; travellers: Array<TravellerDetails & { specialRequests?: SpecialRequestCode[] }> },
): Promise<DraftSaveResult> {
  const fn = 'deal_travellers_save';
  const data = await callRpc(client, fn, {
    p_deal_id: input.dealId,
    p_expected_row_version: input.expectedRowVersion,
    p_travellers: input.travellers.map((t) => ({
      fullName: t.fullName,
      type: t.type,
      seq: t.seq,
      ageYears: t.ageYears,
      specialNeeds: t.specialNeeds,
      // Voice-note batch: sent only when the caller read them (absent = unchanged; an older database never sees the key).
      ...(t.specialRequests !== undefined ? { specialRequests: [...t.specialRequests] } : {}),
    })),
  });
  return parseReply(fn, DraftSaveSchema, data);
}

const IdentitySaveSchema = z.object({ seq: z.number().int().min(1).max(100), rowVersion }) satisfies z.ZodType<TravellerIdentitySaveResult, unknown>;

export async function travellerIdentitySave(
  client: RpcClient,
  input: { dealId: string; seq: number; expectedRowVersion: number; fields: TravellerIdentityFields & IdentityExtraKeys & { extraPhones?: string[] } },
): Promise<TravellerIdentitySaveResult> {
  const fn = 'traveller_identity_save';
  const data = await callRpc(client, fn, {
    p_deal_id: input.dealId,
    p_seq: input.seq,
    p_expected_row_version: input.expectedRowVersion,
    p_fields: input.fields,
  });
  return parseReply(fn, IdentitySaveSchema, data);
}

export async function serviceItemTravellersSave(
  client: RpcClient,
  input: { itemId: string; versionId: string; expectedRowVersion: number; seqs: number[] },
): Promise<DraftSaveResult> {
  const fn = 'service_item_travellers_save';
  const data = await callRpc(client, fn, {
    p_item_id: input.itemId,
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_seqs: input.seqs,
  });
  return parseReply(fn, DraftSaveSchema, data);
}

export async function bookingCommercialsSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; listPaise: string | null; discountPaise: string | null; totalPaise: string },
): Promise<DraftSaveResult> {
  const fn = 'booking_commercials_save';
  // bigint parameters: PostgREST accepts numeric strings and keeps precision.
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_list_paise: input.listPaise,
    p_discount_paise: input.discountPaise,
    p_total_paise: input.totalPaise,
  });
  return parseReply(fn, DraftSaveSchema, data);
}

export async function bookingInstalmentsSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; instalments: PlanInstalment[] },
): Promise<DraftSaveResult> {
  const fn = 'booking_instalments_save';
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_instalments: input.instalments.map((i) => ({ seq: i.seq, label: i.label, amountPaise: i.amountPaise, dueDate: i.dueDate })),
  });
  return parseReply(fn, DraftSaveSchema, data);
}

const SubmitSchema = z
  .object({
    outcome: z.enum(['created', 'existing', 'revised']),
    taskId: z.uuid().nullable().optional(),
    versionId: z.uuid(),
    taskIds: z.array(z.uuid()).optional(),
    supersededVersionId: z.uuid().nullable().optional(),
  })
  .transform(
    (r): SubmitBookingResult => ({
      outcome: r.outcome,
      versionId: r.versionId,
      taskId: r.taskId ?? r.taskIds?.[0] ?? null,
      taskIds: r.taskIds ?? (r.taskId ? [r.taskId] : []),
      supersededVersionId: r.supersededVersionId ?? null,
    }),
  );

/** booking_confirm for the Book now form: tolerates zero tasks (visa/passport waiting for the desk launch). */
export async function submitBooking(client: RpcClient, input: { versionId: string; expectedContentHash: string }): Promise<SubmitBookingResult> {
  const fn = 'booking_confirm';
  const data = await callRpc(client, fn, { p_version_id: input.versionId, p_expected_content_hash: input.expectedContentHash });
  return parseReply(fn, SubmitSchema, data);
}

// ---------------------------------------------------------------------------
// Revision (0300)
// ---------------------------------------------------------------------------

const OpenRevisionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  rowVersion,
  revisesVersionId: z.uuid(),
  created: z.boolean(),
}) satisfies z.ZodType<OpenRevisionResult, unknown>;

export async function bookingOpenRevision(client: RpcClient, baseVersionId: string): Promise<OpenRevisionResult> {
  const fn = 'booking_open_revision';
  return parseReply(fn, OpenRevisionSchema, await callRpc(client, fn, { p_base_version_id: baseVersionId }));
}

const ClassifySchema = z.object({
  rowVersion,
  contentHash: hash,
  changedFields: z.array(z.string().max(120)),
}) satisfies z.ZodType<ClassifyRevisionResult, unknown>;

export async function bookingClassifyRevision(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; changeClass: (typeof CHANGE_CLASSES)[number] },
): Promise<ClassifyRevisionResult> {
  const fn = 'booking_classify_revision';
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_change_class: input.changeClass,
  });
  return parseReply(fn, ClassifySchema, data);
}

const DiscardSchema = z.object({ outcome: z.enum(['discarded', 'existing']) }) satisfies z.ZodType<DiscardDraftResult, unknown>;

export async function bookingDiscardDraft(client: RpcClient, input: { versionId: string; expectedRowVersion: number }): Promise<DiscardDraftResult> {
  const fn = 'booking_discard_draft';
  const data = await callRpc(client, fn, { p_version_id: input.versionId, p_expected_row_version: input.expectedRowVersion });
  return parseReply(fn, DiscardSchema, data);
}

export const HistoryRowSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(BOOK_VERSION_STATUSES),
  confirmedAt: optionalNull(timestamp),
  revisesVersionId: optionalNull(z.uuid()),
  changeClass: optionalNull(z.enum(CHANGE_CLASSES)),
  changedFields: z.array(z.string().max(120)).nullable().optional().transform((v) => v ?? []),
  reviewStatus: optionalNull(z.enum(['pending', 'returned', 'approved'])),
  reviewReason: optionalNull(z.string().max(500)),
  reviewReasonHidden: z.boolean().nullable().optional().transform((v) => v ?? false),
  supersededAt: optionalNull(timestamp),
  /** Commercial readers only (absent otherwise; kept absent). */
  sellingTotalPaise: paise.nullable().optional(),
  sellingTotalDeltaPaise: signedPaise.nullable().optional(),
});
export type HistoryRowRecord = z.output<typeof HistoryRowSchema>;

/** null = not visible to the caller. */
export async function bookingVersionHistory(client: RpcClient, dealId: string): Promise<HistoryRowRecord[] | null> {
  const fn = 'booking_version_history';
  const data = await callRpc(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  // No length cap: a Deal may collect many versions over time.
  return parseReply(fn, z.array(HistoryRowSchema), data);
}

// ---------------------------------------------------------------------------
// Visa & Passport desk (0500)
// ---------------------------------------------------------------------------

/**
 * visa_task_json sends the facts object itself (like flight_task_json), not
 * the { type, facts } wrapper: it is typed here by serviceType.
 */
const VisaTaskBase = z.object({
  taskId: z.uuid(),
  dealReference: z.string().min(1),
  serviceType: z.enum(['visa', 'passport']),
  itemTitle: z.string().min(1).max(400).optional(),
  facts: z.record(z.string(), z.unknown()),
  status: z.enum(DEPARTMENT_TASK_STATUSES),
  assigneeName: optionalNull(z.string()),
  assignedToYou: flag,
  branchName: z.string(),
  createdAt: timestamp,
  completedAt: optionalNull(timestamp),
  /** Accepted but never shown to the desk (a budget is not a selling value; the DTO drops it). */
  purchaseBudgetPaise: paise.optional(),
  applicantCount: z.number().int().nonnegative().nullable().optional(),
});

/** Turns the raw facts into the typed { type, facts } union; malformed facts fail the parse (fail closed). */
function typedVisaFacts<T extends z.output<typeof VisaTaskBase>>(r: T, ctx: z.RefinementCtx) {
  const parsed = ServiceFactsSchema.safeParse({ type: r.serviceType, facts: r.facts });
  if (!parsed.success || (parsed.data.type !== 'visa' && parsed.data.type !== 'passport')) {
    ctx.addIssue({ code: 'custom', message: 'visa task facts', path: ['facts'] });
    return z.NEVER;
  }
  return { ...r, facts: parsed.data };
}

export const VisaTaskSummarySchema = VisaTaskBase.transform(typedVisaFacts);
export type VisaTaskSummaryRecord = z.output<typeof VisaTaskSummarySchema>;

const DocumentsSchema = z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.enum(VISA_DOCUMENT_STATUSES)).optional().transform((v) => v ?? {});

/**
 * One applicant. Before the task is taken there is no application yet: the
 * database lists the item's participants with applicationId, state and
 * rowVersion null.
 */
export const ApplicantSchema = z.object({
  applicationId: optionalNull(z.uuid()),
  seq: z.number().int().min(1).max(100),
  fullName: optionalNull(z.string().min(1).max(120)),
  type: optionalNull(z.enum(TRAVELLER_TYPES)),
  ageYears: optionalNull(z.number().int().min(0).max(17)),
  state: optionalNull(z.enum(VISA_APPLICATION_STATES)),
  documents: DocumentsSchema,
  reference: optionalNull(text(120)),
  appointmentAt: optionalNull(timestamp),
  appointmentPlace: optionalNull(text(200)),
  submittedAt: optionalNull(timestamp),
  outcomeAt: optionalNull(timestamp),
  customerInformedAt: optionalNull(timestamp),
  documentsReturnedAt: optionalNull(timestamp),
  documentsReturnedByName: optionalNull(z.string().max(200)),
  rowVersion: optionalNull(rowVersion),
  closed: z.boolean().nullable().optional().transform((v) => (v === undefined ? undefined : (v ?? false))),
  identity: IdentitySchema.nullable().optional(),
});
export type ApplicantRecord = z.output<typeof ApplicantSchema>;

/** department_evidence_json: the id arrives as `evidenceId`. */
export const DepartmentEvidenceRowSchema = z.object({
  evidenceId: z.uuid(),
  kind: z.enum(DEPARTMENT_EVIDENCE_KINDS),
  applicationId: optionalNull(z.uuid()),
  fileName: z.string().max(120),
  mime: z.enum(MIMES).optional(),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(EVIDENCE_STATUSES),
  uploadedByYou: flag,
  createdAt: timestamp,
});
export type DepartmentEvidenceRecord = z.output<typeof DepartmentEvidenceRowSchema>;

export const CostRowSchema = z.object({
  entryId: z.uuid(),
  costKind: z.enum(COST_KINDS),
  amountPaise: paise,
  paidBy: z.enum(COST_PAID_BY),
  paymentMode: optionalNull(z.enum(COST_PAYMENT_MODES)),
  paidOn: optionalNull(isoDate),
  reference: optionalNull(text(120)),
  expenseStatus: optionalNull(z.enum(EXPENSE_STATUSES)),
  returnReason: optionalNull(text(500)),
  receiptEvidenceId: optionalNull(z.uuid()),
  submittedAt: optionalNull(timestamp),
  reviewedAt: optionalNull(timestamp),
  rowVersion,
});
export type CostRowRecord = z.output<typeof CostRowSchema>;

export const VisaTaskDetailSchema = VisaTaskBase.extend({
  versionNo: z.number().int().positive(),
  confirmedAt: timestamp,
  canClaim: flag,
  canWork: z.boolean().nullable().optional().transform((v) => (v === undefined ? undefined : (v ?? false))),
  applicants: z.array(ApplicantSchema).max(100),
  evidence: z.array(DepartmentEvidenceRowSchema).optional().transform((v) => v ?? []),
  costs: z.array(CostRowSchema).optional().transform((v) => v ?? []),
}).transform(typedVisaFacts);
export type VisaTaskDetailRecord = z.output<typeof VisaTaskDetailSchema>;

export async function visaTaskList(client: RpcClient): Promise<VisaTaskSummaryRecord[]> {
  const fn = 'visa_task_list';
  const data = await callRpc(client, fn, {});
  if (data === null) return [];
  return parseReply(fn, z.array(VisaTaskSummarySchema), data);
}

export async function visaTaskGet(client: RpcClient, taskId: string): Promise<VisaTaskDetailRecord | null> {
  const fn = 'visa_task_get';
  const data = await callRpc(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  return parseReply(fn, VisaTaskDetailSchema, data);
}

const ClaimSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(DEPARTMENT_TASK_STATUSES),
  assignedToYou: z.literal(true),
  alreadyYours: z.boolean(),
});

export async function visaTaskClaim(client: RpcClient, taskId: string): Promise<ClaimTaskResult> {
  const fn = 'visa_task_claim';
  const r = parseReply(fn, ClaimSchema, await callRpc(client, fn, { p_task_id: taskId }));
  // A claim never completes a task; anything else is malformed.
  if (r.status === 'completed') throw new BookingCommandError(fn, null, null);
  return { taskId: r.taskId, status: r.status, assignedToYou: true, alreadyYours: r.alreadyYours };
}

const ApplicationResultSchema = z.object({
  applicationId: z.uuid(),
  rowVersion,
  state: z.enum(VISA_APPLICATION_STATES),
  taskCompleted: z.boolean().nullable().optional().transform((v) => v ?? false),
}) satisfies z.ZodType<VisaApplicationResult, unknown>;

export async function visaApplicationUpdate(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaApplicationFields },
): Promise<VisaApplicationResult> {
  const fn = 'visa_application_update';
  const data = await callRpc(client, fn, {
    p_application_id: input.applicationId,
    p_expected_row_version: input.expectedRowVersion,
    p_fields: input.fields,
  });
  return parseReply(fn, ApplicationResultSchema, data);
}

export async function visaApplicationSetState(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; state: VisaStateCommand; evidenceId: string | null },
): Promise<VisaApplicationResult> {
  const fn = 'visa_application_set_state';
  const data = await callRpc(client, fn, {
    p_application_id: input.applicationId,
    p_expected_row_version: input.expectedRowVersion,
    p_state: input.state,
    p_evidence_id: input.evidenceId,
  });
  return parseReply(fn, ApplicationResultSchema, data);
}

/** documents map update for one code (visa_application_update keeps the other codes as stored). */
export function documentsPatch(current: Record<string, VisaDocumentStatus>, code: string, status: VisaDocumentStatus): Record<string, VisaDocumentStatus> {
  return { ...current, [code]: status };
}

// ---------------------------------------------------------------------------
// Department evidence (0500, mirror of purchase_evidence_*)
// ---------------------------------------------------------------------------

const DeptBeginSchema = z.object({
  evidenceId: z.uuid(),
  // Server-generated <entity>/<task>/<evidence id>; no traversal, no leading slash.
  objectPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i),
});

export async function departmentEvidenceBegin(
  client: RpcClient,
  input: {
    taskId: string;
    applicationId: string | null;
    kind: DepartmentEvidenceKind;
    fileName: string;
    mime: EvidenceMime;
    sizeBytes: number;
    sha256: string;
  },
): Promise<{ evidenceId: string; objectPath: string }> {
  const fn = 'department_evidence_begin';
  const data = await callRpc(client, fn, {
    p_task_id: input.taskId,
    p_application_id: input.applicationId,
    p_kind: input.kind,
    p_file_name: input.fileName,
    p_mime: input.mime,
    p_size_bytes: input.sizeBytes,
    p_sha256: input.sha256,
  });
  return parseReply(fn, DeptBeginSchema, data);
}

export async function departmentEvidenceFinish(client: RpcClient, evidenceId: string, ok: boolean): Promise<{ evidenceId: string; status: string }> {
  const fn = 'department_evidence_finish';
  return parseReply(fn, z.object({ evidenceId: z.uuid(), status: z.enum(EVIDENCE_STATUSES) }), await callRpc(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

export async function departmentEvidenceRemove(client: RpcClient, evidenceId: string): Promise<{ evidenceId: string; status: 'removed' }> {
  const fn = 'department_evidence_remove';
  return parseReply(fn, z.object({ evidenceId: z.uuid(), status: z.literal('removed') }), await callRpc(client, fn, { p_evidence_id: evidenceId }));
}

export async function departmentEvidenceAuthorizeDownload(
  client: RpcClient,
  evidenceId: string,
): Promise<{ objectPath: string; fileName: string; mime: EvidenceMime }> {
  const fn = 'department_evidence_authorize_download';
  const schema = z.object({
    objectPath: DeptBeginSchema.shape.objectPath,
    fileName: z.string().min(1).max(120).regex(/^[A-Za-z0-9._ -]+$/),
    mime: z.enum(MIMES),
  });
  return parseReply(fn, schema, await callRpc(client, fn, { p_evidence_id: evidenceId }));
}

// ---------------------------------------------------------------------------
// Department work form and cost entries (0500)
// ---------------------------------------------------------------------------

const CostSaveSchema = z.object({
  entryId: z.uuid(),
  rowVersion,
  expenseStatus: optionalNull(z.enum(EXPENSE_STATUSES)),
}) satisfies z.ZodType<DepartmentCostSaveResult, unknown>;

export async function departmentCostSave(
  client: RpcClient,
  input: { taskId: string; entryId: string | null; expectedRowVersion: number; fields: DepartmentCostFields; requestId: string },
): Promise<DepartmentCostSaveResult> {
  const fn = 'department_cost_save';
  const data = await callRpc(client, fn, {
    p_task_id: input.taskId,
    p_entry_id: input.entryId,
    p_expected_row_version: input.expectedRowVersion,
    p_fields: input.fields,
    p_request_id: input.requestId,
  });
  return parseReply(fn, CostSaveSchema, data);
}

export async function departmentCostSubmit(client: RpcClient, input: { entryId: string; expectedRowVersion: number }): Promise<DepartmentCostSaveResult> {
  const fn = 'department_cost_submit';
  const data = await callRpc(client, fn, { p_entry_id: input.entryId, p_expected_row_version: input.expectedRowVersion });
  return parseReply(fn, CostSaveSchema, data);
}

export const WorkFormSchema = z.object({
  taskId: z.uuid(),
  department: z.enum(['purchase', 'flight', 'visa']),
  status: z.enum(DEPARTMENT_TASK_STATUSES).optional(),
  steps: z
    .array(
      z.object({
        code: z.string().min(1).max(60),
        at: optionalNull(timestamp),
        byName: optionalNull(z.string().max(200)),
        seq: optionalNull(z.number().int().min(1).max(100)),
      }),
    )
    .optional()
    .transform((v) => v ?? []),
  references: z
    .array(z.object({ kind: z.string().min(1).max(60), value: z.string().min(1).max(200), seq: optionalNull(z.number().int().min(1).max(100)) }))
    .optional()
    .transform((v) => v ?? []),
  documents: z.array(DepartmentEvidenceRowSchema).optional().transform((v) => v ?? []),
  costs: z.array(CostRowSchema).optional().transform((v) => v ?? []),
  /** Whether the caller works the task (assignee, in progress); absent or null = false. */
  canWork: z.boolean().nullable().optional().transform((v) => (v === undefined ? undefined : (v ?? false))),
});
export type WorkFormRecord = z.output<typeof WorkFormSchema>;

/** null = the caller cannot read the task. */
export async function departmentWorkForm(client: RpcClient, taskId: string): Promise<WorkFormRecord | null> {
  const fn = 'department_work_form';
  const data = await callRpc(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  return parseReply(fn, WorkFormSchema, data);
}

// ---------------------------------------------------------------------------
// Traveller identity proof (B1.2, migration 20261120000100; Atlas shapes
// note). Files per traveller; the database authorizes every call (booking
// editors write; restricted identity readers read) and generates the object
// path. Not hashed; never bumps the booking version's row version.
// ---------------------------------------------------------------------------

/** Server-generated <entity>/<deal>/<traveller>/<file id>; no traversal, no leading slash. */
const IdProofObjectPath = z.string().regex(/^[0-9a-f-]{36}(\/[0-9a-f-]{36}){3}$/i);

/** objectPath is present only while the file waits for its upload (status pending_upload). */
const IdProofBeginSchema = z
  .object({
    fileId: z.uuid(),
    objectPath: IdProofObjectPath.nullable(),
    outcome: z.enum(['created', 'existing']),
    status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
    rowVersion: z.number().int().positive(),
  })
  .refine((r) => (r.status === 'pending_upload') === (r.objectPath !== null));
export type IdProofBeginRecord = z.output<typeof IdProofBeginSchema>;

export async function travellerIdProofBegin(
  client: RpcClient,
  input: { dealId: string; travellerSeq: number; requestId: string; consent: true; fileName: string; mime: EvidenceMime; sizeBytes: number; sha256: string },
): Promise<IdProofBeginRecord> {
  const fn = 'traveller_id_proof_begin';
  const data = await callRpc(client, fn, {
    p_deal_id: input.dealId,
    p_seq: input.travellerSeq,
    p_request_id: input.requestId,
    // DEC-39: the customer-consent tick (the command refuses consent_required without it and records who ticked it).
    p_consent: input.consent,
    p_file_name: input.fileName,
    p_mime: input.mime,
    p_size_bytes: input.sizeBytes,
    p_sha256: input.sha256,
  });
  return parseReply(fn, IdProofBeginSchema, data);
}

export async function travellerIdProofFinish(
  client: RpcClient,
  fileId: string,
  ok: boolean,
): Promise<{ fileId: string; status: 'stored' | 'failed'; rowVersion: number }> {
  const fn = 'traveller_id_proof_finish';
  const schema = z.object({ fileId: z.uuid(), status: z.enum(['stored', 'failed']), rowVersion: z.number().int().positive() });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: fileId, p_ok: ok }));
}

export async function travellerIdProofRemove(client: RpcClient, input: { fileId: string; expectedRowVersion: number }): Promise<TravellerIdProofRemoveResult> {
  const fn = 'traveller_id_proof_remove';
  const schema = z.object({ fileId: z.uuid(), status: z.literal('removed'), rowVersion: z.number().int().positive() });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: input.fileId, p_expected_row_version: input.expectedRowVersion }));
}

export async function travellerIdProofAuthorizeDownload(
  client: RpcClient,
  fileId: string,
): Promise<{ objectPath: string; fileName: string; mime: EvidenceMime }> {
  const fn = 'traveller_id_proof_authorize_download';
  const schema = z.object({
    objectPath: IdProofObjectPath,
    fileName: z.string().min(1).max(120).regex(/^[A-Za-z0-9._ -]+$/),
    mime: z.enum(MIMES),
  });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: fileId }));
}

/** traveller_id_proofs_for_task: the task's participants and their STORED proofs (no money, no contacts). */
/** Travellers with their STORED proofs (metadata only), shared by the task and Deal reads. */
const StoredIdProofTravellersSchema = z
    .array(
      z.object({
        seq: z.number().int().min(1).max(100),
        fullName: z.string().min(1).max(120),
        type: z.enum(TRAVELLER_TYPES),
        idProofs: z
          .array(
            z.object({
              fileId: z.uuid(),
              fileName: z.string().min(1).max(120),
              mime: z.enum(MIMES),
              sizeBytes: z.number().int().min(1).max(ID_PROOF_MAX_BYTES),
              storedAt: timestamp,
            }),
          )
          .max(100),
      }),
    )
    .max(100);

const TaskIdProofsSchema = z.object({ taskId: z.uuid(), travellers: StoredIdProofTravellersSchema });
export type TaskIdProofsRecord = z.output<typeof TaskIdProofsSchema>;

/** traveller_id_proofs_for_deal: every traveller of the Deal (by seq) with STORED proofs; for the Accounts deal screen and any viewer. */
const DealIdProofsSchema = z.object({ dealId: z.uuid(), travellers: StoredIdProofTravellersSchema });
export type DealIdProofsRecord = z.output<typeof DealIdProofsSchema>;

/** null = the caller passes no viewer rule for this Deal (DEC-41), or the Deal was removed by the sync. */
export async function travellerIdProofsForDeal(client: RpcClient, dealId: string): Promise<DealIdProofsRecord | null> {
  const fn = 'traveller_id_proofs_for_deal';
  const data = await callRpc(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parseReply(fn, DealIdProofsSchema, data);
}

/** null = the caller is neither the task's assignee nor the Deal's branch Sales Manager (or the task is not visible). */
export async function travellerIdProofsForTask(client: RpcClient, taskId: string): Promise<TaskIdProofsRecord | null> {
  const fn = 'traveller_id_proofs_for_task';
  const data = await callRpc(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  return parseReply(fn, TaskIdProofsSchema, data);
}

// ---------------------------------------------------------------------------
// DEC-43 copy of ID proofs to the Bitrix Deal (migration 0700): status read,
// manual retry, Super Admin alerts. Codes and ids only.
// ---------------------------------------------------------------------------

const copyCode = z.string().regex(/^[a-z_]{1,60}$/);

export const IdProofCopyStatusSchema = z
  .array(
    z.object({
      jobId: z.uuid(),
      travellerId: z.uuid(),
      idProofId: z.uuid(),
      /** Unknown future statuses read as 'unknown' (being checked) rather than failing the page. */
      status: z.string().max(40).transform((v): (typeof ID_PROOF_COPY_STATUSES)[number] => ((ID_PROOF_COPY_STATUSES as readonly string[]).includes(v) ? (v as (typeof ID_PROOF_COPY_STATUSES)[number]) : 'unknown')),
      attempts: z.number().int().min(0).max(50),
      maxAttempts: z.number().int().min(1).max(50),
      lastErrorCode: copyCode.nullable().optional().transform((v) => v ?? null),
      updatedAt: timestamp,
      sentAt: timestamp.nullable().optional().transform((v) => v ?? null),
    }),
  )
  .max(1000);
export type IdProofCopyStatusRecord = z.output<typeof IdProofCopyStatusSchema>;

/** null = not a booking editor of the Deal (or not visible). */
export async function bitrixIdProofCopyStatus(client: RpcClient, dealId: string): Promise<IdProofCopyStatusRecord | null> {
  const fn = 'bitrix_id_proof_copy_status';
  const data = await callRpc(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parseReply(fn, IdProofCopyStatusSchema, data);
}

/**
 * Failed, unknown or needs_manual_check → queued again (unknown and
 * needs_manual_check go back to a read-back of the Deal first). A wrong_state refusal because copying is switched off
 * carries hintKeys ['switch_off'] (the only hint this command sends).
 */
export async function bitrixIdProofCopyRetry(client: RpcClient, jobId: string): Promise<{ jobId: string; status: 'pending' | 'unknown' }> {
  const fn = 'bitrix_id_proof_copy_retry';
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, { p_job_id: jobId });
  } catch {
    throw new BookingCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapBookingError(result.error);
    const switchOff = code === 'wrong_state' && (result.error.hint ?? '').trim() === 'switch_off';
    throw new BookingCommandError(fn, code, result.error.code ?? null, switchOff ? ['switch_off'] : []);
  }
  return parseReply(fn, z.object({ jobId: z.uuid(), status: z.enum(['pending', 'unknown']) }), result.data);
}

const bitrixDealNumber = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const IdProofCopyAlertsSchema = z.object({
  stops: z
    .array(
      z.object({
        stopId: z.uuid(),
        jobId: z.uuid(),
        bitrixDealId: bitrixDealNumber,
        reasonCode: copyCode,
        openedAt: timestamp,
        acknowledgedAt: timestamp.nullable().optional().transform((v) => v ?? null),
      }),
    )
    .max(1000),
  /** Review E8-2: jobs that ended needs_manual_check. */
  manualChecks: z
    .array(
      z.object({
        jobId: z.uuid(),
        bitrixDealId: bitrixDealNumber,
        lastErrorCode: copyCode.nullable().optional().transform((v) => v ?? null),
        readBackAttempts: z.number().int().min(0).max(1000),
        updatedAt: timestamp,
      }),
    )
    .max(1000)
    .optional()
    .transform((v) => v ?? []),
});
export type IdProofCopyAlertsRecord = z.output<typeof IdProofCopyAlertsSchema>;

/** Super Admin only; null for everyone else. */
export async function bitrixIdProofCopyAlerts(client: RpcClient): Promise<IdProofCopyAlertsRecord | null> {
  const fn = 'bitrix_id_proof_copy_alerts';
  const data = await callRpc(client, fn, {});
  if (data === null) return null;
  return parseReply(fn, IdProofCopyAlertsSchema, data);
}

// ---------------------------------------------------------------------------
// B1.2 switches (Super Admin, audited, reason 10-500 characters)
// ---------------------------------------------------------------------------

/** DEC-43 copy switch (integration_set_bitrix_id_proof_copy); switching on closes open automatic stops. */
export async function setBitrixIdProofCopy(client: RpcClient, input: { on: boolean; reason: string }): Promise<{ changed: boolean; on: boolean }> {
  const fn = 'integration_set_bitrix_id_proof_copy';
  return parseReply(fn, z.object({ changed: z.boolean(), on: z.boolean() }), await callRpc(client, fn, { p_on: input.on, p_reason: input.reason }));
}

const ReadSwitchesSchema = z.object({
  changed: z.boolean(),
  before: z.object({ tripFactsRead: z.boolean(), leadIntakeUnowned: z.boolean() }),
  after: z.object({ tripFactsRead: z.boolean(), leadIntakeUnowned: z.boolean() }),
  requeued: z.number().int().nonnegative(),
  notRequeued: z.number().int().nonnegative().optional().transform((v) => v ?? 0),
});
export type ReadSwitchesRecord = z.output<typeof ReadSwitchesSchema>;

/** The two Bitrix read switches (integration_set_bitrix_read_switches); null keeps a switch as it is. */
export async function setBitrixReadSwitches(
  client: RpcClient,
  input: { tripFactsRead: boolean | null; leadIntakeUnowned: boolean | null; reason: string },
): Promise<ReadSwitchesRecord> {
  const fn = 'integration_set_bitrix_read_switches';
  return parseReply(
    fn,
    ReadSwitchesSchema,
    await callRpc(client, fn, { p_trip_facts_read: input.tripFactsRead, p_lead_intake_unowned: input.leadIntakeUnowned, p_reason: input.reason }),
  );
}

// ---------------------------------------------------------------------------
// Booking form commands (20261124000110; booking-form-contract.ts)
// ---------------------------------------------------------------------------

const FormStartSchema = BookingStartDraftSchema.extend({
  formRules: z.union([z.literal(1), z.literal(2)]).optional().transform((v): 1 | 2 => v ?? 1),
});
export type BookingFormStartRecord = z.output<typeof FormStartSchema>;

/** "Start booking" in the booking form: booking_form_start (a new draft gets form_rules 2). Raw reply; the caller falls back on an older database. */
export async function bookingFormStartRaw(client: RpcClient, dealId: string): Promise<BookingFormStartRecord> {
  const fn = 'booking_form_start';
  return parseReply(fn, FormStartSchema, await callRpc(client, fn, { p_deal_id: dealId }));
}

const PricesSaveSchema = z.object({
  rowVersion,
  contentHash: hash,
  sellingTotalPaise: optionalNull(paise),
}) satisfies z.ZodType<PricesSaveResult, unknown>;

/** booking_prices_save: the four category lines (paise strings); the database recomputes markup and the selling total. */
export async function bookingPricesSave(
  client: RpcClient,
  input: { versionId: string; expectedRowVersion: number; lines: PriceLine[]; requestId: string },
): Promise<PricesSaveResult> {
  const fn = 'booking_prices_save';
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_lines: input.lines.map((l) => ({ category: l.category, quantity: l.quantity, purchasePaise: l.purchasePaise, markupPaise: l.markupPaise, salePaise: l.salePaise })),
    p_request_id: input.requestId,
  });
  return parseReply(fn, PricesSaveSchema, data);
}

const ServiceSaveSchema = z.object({
  itemId: z.uuid(),
  itemNo: z.number().int().min(1).max(20),
  rowVersion,
  contentHash: hash,
}) satisfies z.ZodType<ServiceSaveResult, unknown>;

/** booking_service_save: one item (add or save) with its estimate and participation, in one transaction. */
export async function bookingServiceSave(
  client: RpcClient,
  input: {
    versionId: string;
    expectedRowVersion: number;
    itemId: string | null;
    serviceType: string;
    facts: Record<string, unknown>;
    purchaseBudgetPaise: string | null;
    estimate: ServiceEstimate | null;
    participants: number[] | null;
    requestId: string;
  },
): Promise<ServiceSaveResult> {
  const fn = 'booking_service_save';
  const data = await callRpc(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_item_id: input.itemId,
    p_service_type: input.serviceType,
    p_facts: input.facts,
    p_purchase_budget_paise: input.purchaseBudgetPaise,
    p_estimate: input.estimate,
    p_participants: input.participants,
    p_request_id: input.requestId,
  });
  return parseReply(fn, ServiceSaveSchema, data);
}

/** Server-generated <entity>/<deal>/<item>/<file id>. */
const ItemFileObjectPath = z.string().regex(/^[0-9a-f-]{36}(\/[0-9a-f-]{36}){3}$/i);

const ItemFileBeginSchema = z
  .object({
    fileId: z.uuid(),
    objectPath: ItemFileObjectPath.nullable(),
    outcome: z.enum(['created', 'existing']),
    status: z.enum(EVIDENCE_STATUSES),
    rowVersion: z.number().int().positive(),
  })
  .refine((r) => (r.status === 'pending_upload') === (r.objectPath !== null));
export type ItemFileBeginRecord = z.output<typeof ItemFileBeginSchema>;

export async function serviceItemFileBegin(
  client: RpcClient,
  input: { itemId: string; versionId: string; kind: 'flight_screenshot'; fileName: string; mime: EvidenceMime; sizeBytes: number; sha256: string; requestId: string },
): Promise<ItemFileBeginRecord> {
  const fn = 'service_item_file_begin';
  const data = await callRpc(client, fn, {
    p_item_id: input.itemId,
    p_version_id: input.versionId,
    p_kind: input.kind,
    p_file: { fileName: input.fileName, mime: input.mime, sizeBytes: input.sizeBytes, sha256: input.sha256 },
    p_request_id: input.requestId,
  });
  return parseReply(fn, ItemFileBeginSchema, data);
}

export async function serviceItemFileFinish(client: RpcClient, fileId: string, ok: boolean): Promise<{ fileId: string; status: 'stored' | 'failed' }> {
  const fn = 'service_item_file_finish';
  const schema = z.object({ fileId: z.uuid(), status: z.enum(['stored', 'failed']) });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: fileId, p_ok: ok }));
}

export async function serviceItemFileRemove(client: RpcClient, input: { fileId: string; expectedRowVersion: number }): Promise<{ fileId: string; status: 'removed' }> {
  const fn = 'service_item_file_remove';
  const schema = z.object({ fileId: z.uuid(), status: z.literal('removed') });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: input.fileId, p_expected_row_version: input.expectedRowVersion }));
}

export async function serviceItemFileAuthorizeDownload(client: RpcClient, fileId: string): Promise<{ objectPath: string; fileName: string; mime: EvidenceMime }> {
  const fn = 'service_item_file_authorize_download';
  const schema = z.object({
    objectPath: ItemFileObjectPath,
    fileName: z.string().min(1).max(120).regex(/^[A-Za-z0-9._ -]+$/),
    mime: z.enum(MIMES),
  });
  return parseReply(fn, schema, await callRpc(client, fn, { p_file_id: fileId }));
}
