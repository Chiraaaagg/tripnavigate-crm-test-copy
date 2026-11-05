import { BOOKING_FOR, type BookingFor, CONTACT_LIMITS, type ServiceFacts, TRIP_LIMITS, TRIP_SCOPES, type TripScope } from '@/modules/fulfilment/contracts';
import { factsFromForm, fieldForFactKey, formReaders, isServiceType, type ParsedForm, readContentHash, readRowVersion, readUuid, validateServiceFacts } from '@/modules/fulfilment/forms';
import {
  CATEGORY_KEYS,
  type CategoryKey,
  CHARGE_KINDS,
  type ChargeKind,
  DECLINE_REASONS,
  type DeclineReason,
  DUE_RULES,
  type DueRule,
  LINE_LIMITS,
  OPTION_KEYS,
  type OptionKey,
  PAX_LIMITS,
  type PaiseString,
  QUOTATION_CONTACT_LIMITS,
  QUOTATION_CONTENT_LIMITS,
  QUOTATION_EVIDENCE_KINDS,
  QUOTATION_PLAN_LIMITS,
  QUOTATION_SUBJECT_KINDS,
  type QuotationContact,
  type QuotationContent,
  type QuotationEvidenceKind,
  type QuotationSubjectKind,
  SENT_CHANNELS,
  type SentChannel,
  TIER_KEYS,
  TIER_LABEL_MAX,
  type TierKey,
  UNIT_KINDS,
  type UnitKind,
} from './contracts';
import { parseRupeesWithPaise, parseWholeRupees } from './money';

/*
 * Quotation form input names (frozen with Luna's screens) and pure parsers.
 * Service items reuse the booking item input names (fulfilment FIELD:
 * hotelName, city, checkIn, …) so the same service-fields UI serves both.
 * Money inputs are rupee text: selling, totals and instalments are whole
 * rupees; cost estimates may carry paise. Actor, entity, branch and owner
 * are never read from a form. Each parser answers { ok: true, value } or
 * { ok: false, fields } naming the inputs to highlight; the database
 * validates again and decides.
 */

export const QFIELD = {
  // identity of the thing being changed
  subjectKind: 'subjectKind',
  subjectId: 'subjectId',
  quotationId: 'quotationId',
  versionId: 'versionId',
  rowVersion: 'rowVersion',
  contentHash: 'contentHash',
  requestId: 'requestId',
  // header
  title: 'title',
  // trip (always all four together)
  destination: 'destination',
  tripScope: 'tripScope',
  tripStart: 'tripStart',
  tripEnd: 'tripEnd',
  // people (counts only; DEC-33)
  adults: 'adults',
  childrenWithBed: 'childrenWithBed',
  childrenNoBed: 'childrenNoBed',
  infants: 'infants',
  paxRemarks: 'paxRemarks',
  requirementsNote: 'requirementsNote',
  validUntil: 'validUntil',
  // contact
  contactName: 'contactName',
  mobile: 'mobile',
  email: 'email',
  companyName: 'companyName',
  /** DEC-45: 'individual' | 'business'; empty or absent keeps the saved value. */
  bookingFor: 'bookingFor',
  // narrative (parallel arrays; index = order; day number = row position + 1)
  dayTitle: 'dayTitle',
  dayText: 'dayText',
  include: 'include',
  exclude: 'exclude',
  term: 'term',
  notes: 'notes',
  // tiers
  quotedTierLabel: 'quotedTierLabel',
  /** Checkbox: offer an upgrade option. */
  upgradeOffered: 'upgradeOffered',
  upgradeTierLabel: 'upgradeTierLabel',
  // items (one item per post; facts use the booking FIELD names)
  /** '' = new item (add); set = save that item. */
  itemId: 'itemId',
  serviceType: 'serviceType',
  /** '' = every tier; 'quoted' | 'upgrade'. */
  itemTierKey: 'itemTierKey',
  extraBeds: 'extraBeds',
  childrenWithoutBed: 'childrenWithoutBed',
  bedRemarks: 'bedRemarks',
  // money lines (parallel arrays; index = line order)
  lineOptionKey: 'lineOptionKey',
  /** The item id the line prices; '' = none. */
  lineItemId: 'lineItemId',
  lineChargeKind: 'lineChargeKind',
  lineCategoryKey: 'lineCategoryKey',
  lineDescription: 'lineDescription',
  lineUnitKind: 'lineUnitKind',
  lineUnits: 'lineUnits',
  linePeriods: 'linePeriods',
  lineUnitSellRupees: 'lineUnitSellRupees',
  lineUnitCostRupees: 'lineUnitCostRupees',
  lineRemark: 'lineRemark',
  // tier money (one tier per post)
  tierKey: 'tierKey',
  quotedTotalRupees: 'quotedTotalRupees',
  /** Checkbox: print the per-person price when exact. */
  showPerPerson: 'showPerPerson',
  // plan (one tier per post; parallel arrays)
  instalmentLabel: 'instalmentLabel',
  instalmentAmountRupees: 'instalmentAmountRupees',
  instalmentDueRule: 'instalmentDueRule',
  instalmentDueDays: 'instalmentDueDays',
  instalmentDueDate: 'instalmentDueDate',
  // send / accept / decline / evidence
  channel: 'channel',
  acceptedTierKey: 'acceptedTierKey',
  evidenceId: 'evidenceId',
  evidenceKind: 'evidenceKind',
  file: 'file',
  declineReason: 'declineReason',
  // link / new version
  dealId: 'dealId',
  baseVersionId: 'baseVersionId',
} as const;
export type QuotationFieldName = (typeof QFIELD)[keyof typeof QFIELD];

const { text, optionalText, optionalDate, strings, isText, isIsoDate } = formReaders;

function value(formData: FormData, name: string): string {
  return (text(formData, name) ?? '').trim();
}
function singleLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkbox(formData: FormData, name: string): boolean {
  const v = value(formData, name);
  return v === 'on' || v === 'true' || v === '1';
}
function oneOf<T extends string>(values: readonly T[], raw: string): T | null | undefined {
  if (raw === '') return null;
  return (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}
/** '' → null; an integer in range → it; else undefined. */
function intIn(raw: string, min: number, max: number): number | null | undefined {
  if (raw === '') return null;
  if (!/^-?\d{1,6}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}

/** Indian mobile: spaces and dashes removed, an optional +91 / 91 / 0 prefix dropped. '' → null; invalid → undefined. */
function mobileOf(raw: string): string | null | undefined {
  const digits = raw.replace(/[\s-]/g, '');
  if (digits === '') return null;
  const local = digits.replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  return CONTACT_LIMITS.mobilePattern.test(local) ? local : undefined;
}

function versionRow(formData: FormData, fields: string[]): { versionId: string | null; expectedRowVersion: number | null } {
  const versionId = readUuid(formData, QFIELD.versionId);
  if (!versionId) fields.push(QFIELD.versionId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(QFIELD.rowVersion);
  return { versionId, expectedRowVersion };
}

function requestIdOf(formData: FormData, fields: string[]): string | null {
  const id = readUuid(formData, QFIELD.requestId);
  if (!id) fields.push(QFIELD.requestId);
  return id;
}

function done<T>(fields: string[], build: () => T): ParsedForm<T> {
  return fields.length > 0 ? { ok: false, fields: [...new Set(fields)] } : { ok: true, value: build() };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateQuotationForm {
  subjectKind: QuotationSubjectKind;
  subjectId: string;
  title: string;
  requestId: string;
}

export function parseCreateQuotationForm(formData: FormData): ParsedForm<CreateQuotationForm> {
  const fields: string[] = [];
  const subjectKind = oneOf(QUOTATION_SUBJECT_KINDS, value(formData, QFIELD.subjectKind));
  if (!subjectKind) fields.push(QFIELD.subjectKind);
  const subjectId = readUuid(formData, QFIELD.subjectId);
  if (!subjectId) fields.push(QFIELD.subjectId);
  const title = singleLine(value(formData, QFIELD.title));
  if (!isText(title, QUOTATION_CONTENT_LIMITS.title)) fields.push(QFIELD.title);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ subjectKind: subjectKind!, subjectId: subjectId!, title, requestId: requestId! }));
}

// ---------------------------------------------------------------------------
// Details: title is header-level (not in version_save); trip, pax, requirements, validity
// ---------------------------------------------------------------------------

/** p_fields of quotation_version_save (partial: only keys present change; this form sends all of its keys). */
export interface QuotationDetailsFields {
  destination: string | null;
  scope: TripScope | null;
  start: string | null;
  end: string | null;
  adults: number;
  childrenWithBed: number;
  childrenNoBed: number;
  infants: number;
  paxRemarks: string | null;
  requirementsNote: string | null;
  validUntil: string | null;
}

export interface QuotationDetailsForm {
  versionId: string;
  expectedRowVersion: number;
  fields: QuotationDetailsFields;
}

export function parseQuotationDetailsForm(formData: FormData, today: string): ParsedForm<QuotationDetailsForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const destination = optionalText(formData, QFIELD.destination, TRIP_LIMITS.destination);
  if (destination === undefined) fields.push(QFIELD.destination);
  const scope = oneOf<TripScope>(TRIP_SCOPES, value(formData, QFIELD.tripScope));
  if (scope === undefined) fields.push(QFIELD.tripScope);
  const start = optionalDate(formData, QFIELD.tripStart);
  if (start === undefined || (start && !isIsoDate(start))) fields.push(QFIELD.tripStart);
  const end = optionalDate(formData, QFIELD.tripEnd);
  if (end === undefined || (end && !isIsoDate(end))) fields.push(QFIELD.tripEnd);
  if (start && end && end < start) fields.push(QFIELD.tripEnd);
  const count = (name: string): number => {
    const n = intIn(value(formData, name), PAX_LIMITS.count.min, PAX_LIMITS.count.max);
    if (n === undefined) fields.push(name);
    return n ?? 0;
  };
  const adults = count(QFIELD.adults);
  const childrenWithBed = count(QFIELD.childrenWithBed);
  const childrenNoBed = count(QFIELD.childrenNoBed);
  const infants = count(QFIELD.infants);
  const paxRemarks = optionalText(formData, QFIELD.paxRemarks, PAX_LIMITS.remarks);
  if (paxRemarks === undefined) fields.push(QFIELD.paxRemarks);
  const requirementsNote = optionalText(formData, QFIELD.requirementsNote, QUOTATION_CONTENT_LIMITS.requirementsNote);
  if (requirementsNote === undefined) fields.push(QFIELD.requirementsNote);
  const validUntil = optionalDate(formData, QFIELD.validUntil);
  if (validUntil === undefined || (validUntil && (!isIsoDate(validUntil) || validUntil < today))) fields.push(QFIELD.validUntil);
  return done(fields, () => ({
    versionId: versionId!,
    expectedRowVersion: expectedRowVersion!,
    fields: {
      destination: destination ?? null,
      scope: scope ?? null,
      start: start ?? null,
      end: end ?? null,
      adults,
      childrenWithBed,
      childrenNoBed,
      infants,
      paxRemarks: paxRemarks ?? null,
      requirementsNote: requirementsNote ?? null,
      validUntil: validUntil ?? null,
    },
  }));
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export interface QuotationContactForm {
  versionId: string;
  expectedRowVersion: number;
  fields: QuotationContact;
}

export function parseQuotationContactForm(formData: FormData): ParsedForm<QuotationContactForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const contactName = singleLine(value(formData, QFIELD.contactName));
  if (!isText(contactName, QUOTATION_CONTACT_LIMITS.contactName)) fields.push(QFIELD.contactName);
  const mobile = mobileOf(value(formData, QFIELD.mobile));
  if (mobile === undefined) fields.push(QFIELD.mobile);
  const emailRaw = value(formData, QFIELD.email).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= QUOTATION_CONTACT_LIMITS.email && CONTACT_LIMITS.emailPattern.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) fields.push(QFIELD.email);
  if (mobile === null && email === null) fields.push(QFIELD.mobile, QFIELD.email);
  const companyName = optionalText(formData, QFIELD.companyName, QUOTATION_CONTACT_LIMITS.companyName);
  if (companyName === undefined) fields.push(QFIELD.companyName);
  const bookingForRaw = value(formData, QFIELD.bookingFor);
  const bookingFor = bookingForRaw === '' ? undefined : (BOOKING_FOR as readonly string[]).includes(bookingForRaw) ? (bookingForRaw as BookingFor) : null;
  if (bookingFor === null) fields.push(QFIELD.bookingFor);
  return done(fields, () => ({
    versionId: versionId!,
    expectedRowVersion: expectedRowVersion!,
    fields: {
      contactName,
      mobile: mobile ?? null,
      email: email ?? null,
      companyName: companyName ? singleLine(companyName) : null,
      ...(bookingFor ? { bookingFor } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// Narrative (content)
// ---------------------------------------------------------------------------

export interface QuotationContentForm {
  versionId: string;
  expectedRowVersion: number;
  content: QuotationContent;
}

function list(formData: FormData, name: string, fields: string[]): string[] {
  const out: string[] = [];
  strings(formData, name).forEach((raw, i) => {
    const v = singleLine(raw);
    if (v === '') return;
    if (!isText(v, QUOTATION_CONTENT_LIMITS.listItem)) fields.push(`${name}[${i}]`);
    else out.push(v);
  });
  if (out.length > QUOTATION_CONTENT_LIMITS.listItems) fields.push(name);
  return out;
}

export function parseQuotationContentForm(formData: FormData): ParsedForm<QuotationContentForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const titles = strings(formData, QFIELD.dayTitle);
  const texts = strings(formData, QFIELD.dayText);
  const days: QuotationContent['days'] = [];
  for (let i = 0; i < Math.max(titles.length, texts.length); i += 1) {
    const title = singleLine(titles[i] ?? '');
    const body = (texts[i] ?? '').trim();
    if (title === '' && body === '') continue;
    if (!isText(title, QUOTATION_CONTENT_LIMITS.dayTitle)) fields.push(`${QFIELD.dayTitle}[${i}]`);
    if (body !== '' && !isText(body, QUOTATION_CONTENT_LIMITS.dayText)) fields.push(`${QFIELD.dayText}[${i}]`);
    days.push({ day: days.length + 1, title, text: body === '' ? null : body });
  }
  if (days.length > QUOTATION_CONTENT_LIMITS.days) fields.push(QFIELD.dayTitle);
  const includes = list(formData, QFIELD.include, fields);
  const excludes = list(formData, QFIELD.exclude, fields);
  const terms = list(formData, QFIELD.term, fields);
  const notes = optionalText(formData, QFIELD.notes, QUOTATION_CONTENT_LIMITS.notes);
  if (notes === undefined) fields.push(QFIELD.notes);
  return done(fields, () => ({
    versionId: versionId!,
    expectedRowVersion: expectedRowVersion!,
    content: { days, includes, excludes, terms, notes: notes ?? null },
  }));
}

// ---------------------------------------------------------------------------
// Tiers (labels; quoted always, upgrade when offered)
// ---------------------------------------------------------------------------

export interface QuotationTiersForm {
  versionId: string;
  expectedRowVersion: number;
  tiers: Array<{ tierKey: TierKey; label: string | null }>;
}

export function parseQuotationTiersForm(formData: FormData): ParsedForm<QuotationTiersForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const label = (name: string): string | null => {
    const v = singleLine(value(formData, name));
    if (v === '') return null;
    if (!isText(v, TIER_LABEL_MAX)) fields.push(name);
    return v;
  };
  const tiers: QuotationTiersForm['tiers'] = [{ tierKey: 'quoted', label: label(QFIELD.quotedTierLabel) }];
  if (checkbox(formData, QFIELD.upgradeOffered)) tiers.push({ tierKey: 'upgrade', label: label(QFIELD.upgradeTierLabel) });
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion!, tiers }));
}

// ---------------------------------------------------------------------------
// Items (one per post; booking fact inputs + hotel extras)
// ---------------------------------------------------------------------------

export interface QuotationItemForm {
  versionId: string;
  expectedRowVersion: number;
  /** null = add. */
  itemId: string | null;
  tierKey: TierKey | null;
  service: ServiceFacts;
}

export function parseQuotationItemForm(formData: FormData): ParsedForm<QuotationItemForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const itemIdRaw = value(formData, QFIELD.itemId);
  const itemId = itemIdRaw === '' ? null : readUuid(formData, QFIELD.itemId);
  if (itemIdRaw !== '' && !itemId) fields.push(QFIELD.itemId);
  const tierKey = oneOf<TierKey>(TIER_KEYS, value(formData, QFIELD.itemTierKey));
  if (tierKey === undefined) fields.push(QFIELD.itemTierKey);
  const type = value(formData, QFIELD.serviceType);
  if (!isServiceType(type)) {
    fields.push(QFIELD.serviceType);
    return { ok: false, fields: [...new Set(fields)] };
  }
  // The booking fact parser (incl. the hotel extras extraBeds, childrenWithoutBed, bedRemarks) serves both forms.
  const built = factsFromForm(type, formData);
  fields.push(...built.fields);
  const facts = built.facts;
  if (built.fields.length === 0) for (const key of validateServiceFacts(type, facts)) fields.push(fieldForFactKey(type, key));
  return done(fields, () => ({
    versionId: versionId!,
    expectedRowVersion: expectedRowVersion!,
    itemId,
    tierKey: tierKey ?? null,
    service: { type, facts } as unknown as ServiceFacts,
  }));
}

export interface QuotationItemRemoveForm {
  versionId: string;
  expectedRowVersion: number;
  itemId: string;
}

export function parseQuotationItemRemoveForm(formData: FormData): ParsedForm<QuotationItemRemoveForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const itemId = readUuid(formData, QFIELD.itemId);
  if (!itemId) fields.push(QFIELD.itemId);
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion!, itemId: itemId! }));
}

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

export interface VersionRowForm {
  versionId: string;
  expectedRowVersion: number;
}
export function parseVersionRowForm(formData: FormData): ParsedForm<VersionRowForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion! }));
}

function versionHash(formData: FormData, fields: string[]): { versionId: string | null; contentHash: string | null } {
  const versionId = readUuid(formData, QFIELD.versionId);
  if (!versionId) fields.push(QFIELD.versionId);
  const contentHash = readContentHash(formData);
  if (!contentHash) fields.push(QFIELD.contentHash);
  return { versionId, contentHash };
}

export interface MarkSentForm {
  versionId: string;
  contentHash: string;
  channel: SentChannel;
  requestId: string;
}
export function parseMarkSentForm(formData: FormData): ParsedForm<MarkSentForm> {
  const fields: string[] = [];
  const { versionId, contentHash } = versionHash(formData, fields);
  const channel = oneOf<SentChannel>(SENT_CHANNELS, value(formData, QFIELD.channel));
  if (!channel) fields.push(QFIELD.channel);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ versionId: versionId!, contentHash: contentHash!, channel: channel!, requestId: requestId! }));
}

export interface AcceptForm {
  versionId: string;
  contentHash: string;
  evidenceId: string;
  tierKey: TierKey;
  requestId: string;
}
export function parseAcceptForm(formData: FormData): ParsedForm<AcceptForm> {
  const fields: string[] = [];
  const { versionId, contentHash } = versionHash(formData, fields);
  const evidenceId = readUuid(formData, QFIELD.evidenceId);
  if (!evidenceId) fields.push(QFIELD.evidenceId);
  const tierKey = oneOf<TierKey>(TIER_KEYS, value(formData, QFIELD.acceptedTierKey));
  if (!tierKey) fields.push(QFIELD.acceptedTierKey);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ versionId: versionId!, contentHash: contentHash!, evidenceId: evidenceId!, tierKey: tierKey!, requestId: requestId! }));
}

export interface DeclineForm {
  versionId: string;
  expectedRowVersion: number;
  reason: DeclineReason;
  requestId: string;
}
export function parseDeclineForm(formData: FormData): ParsedForm<DeclineForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const reason = oneOf<DeclineReason>(DECLINE_REASONS, value(formData, QFIELD.declineReason));
  if (!reason) fields.push(QFIELD.declineReason);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion!, reason: reason!, requestId: requestId! }));
}

export interface NewVersionForm {
  quotationId: string;
  baseVersionId: string;
  requestId: string;
}
export function parseNewVersionForm(formData: FormData): ParsedForm<NewVersionForm> {
  const fields: string[] = [];
  const quotationId = readUuid(formData, QFIELD.quotationId);
  if (!quotationId) fields.push(QFIELD.quotationId);
  const baseVersionId = readUuid(formData, QFIELD.baseVersionId);
  if (!baseVersionId) fields.push(QFIELD.baseVersionId);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ quotationId: quotationId!, baseVersionId: baseVersionId!, requestId: requestId! }));
}

export interface LinkDealForm {
  quotationId: string;
  dealId: string;
  expectedRowVersion: number;
}
export function parseLinkDealForm(formData: FormData): ParsedForm<LinkDealForm> {
  const fields: string[] = [];
  const quotationId = readUuid(formData, QFIELD.quotationId);
  if (!quotationId) fields.push(QFIELD.quotationId);
  const dealId = readUuid(formData, QFIELD.dealId);
  if (!dealId) fields.push(QFIELD.dealId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(QFIELD.rowVersion);
  return done(fields, () => ({ quotationId: quotationId!, dealId: dealId!, expectedRowVersion: expectedRowVersion! }));
}

export interface ConvertForm {
  versionId: string;
  contentHash: string;
  requestId: string;
}
export function parseConvertForm(formData: FormData): ParsedForm<ConvertForm> {
  const fields: string[] = [];
  const { versionId, contentHash } = versionHash(formData, fields);
  const requestId = requestIdOf(formData, fields);
  return done(fields, () => ({ versionId: versionId!, contentHash: contentHash!, requestId: requestId! }));
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvidenceUploadForm {
  versionId: string;
  kind: QuotationEvidenceKind;
}
export function parseEvidenceUploadForm(formData: FormData): ParsedForm<EvidenceUploadForm> {
  const fields: string[] = [];
  const versionId = readUuid(formData, QFIELD.versionId);
  if (!versionId) fields.push(QFIELD.versionId);
  const kind = oneOf<QuotationEvidenceKind>(QUOTATION_EVIDENCE_KINDS, value(formData, QFIELD.evidenceKind));
  if (!kind) fields.push(QFIELD.evidenceKind);
  return done(fields, () => ({ versionId: versionId!, kind: kind! }));
}

export interface EvidenceRemoveForm {
  versionId: string;
  evidenceId: string;
}
export function parseEvidenceRemoveForm(formData: FormData): ParsedForm<EvidenceRemoveForm> {
  const fields: string[] = [];
  const versionId = readUuid(formData, QFIELD.versionId);
  if (!versionId) fields.push(QFIELD.versionId);
  const evidenceId = readUuid(formData, QFIELD.evidenceId);
  if (!evidenceId) fields.push(QFIELD.evidenceId);
  return done(fields, () => ({ versionId: versionId!, evidenceId: evidenceId! }));
}

// ---------------------------------------------------------------------------
// Money (Mercury commands)
// ---------------------------------------------------------------------------

export interface QuotationLineInput {
  lineNo: number;
  optionKey: OptionKey;
  itemId: string | null;
  chargeKind: ChargeKind;
  categoryKey: CategoryKey;
  description: string;
  unitKind: UnitKind;
  units: number;
  periods: number;
  unitSellPaise: PaiseString;
  unitCostPaise: PaiseString | null;
  remark: string | null;
}
export interface QuotationLinesForm {
  versionId: string;
  expectedRowVersion: number;
  lines: QuotationLineInput[];
}

/**
 * Lines as parallel arrays (line order = line number). Counts are taken
 * exactly as typed (DEC-33: never derived from stays): line_total forces
 * 1 × 1 and person forces one period, as the database checks.
 */
export function parseQuotationLinesForm(formData: FormData): ParsedForm<QuotationLinesForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const col = (name: string) => strings(formData, name);
  const options = col(QFIELD.lineOptionKey);
  const itemIds = col(QFIELD.lineItemId);
  const charges = col(QFIELD.lineChargeKind);
  const categories = col(QFIELD.lineCategoryKey);
  const descriptions = col(QFIELD.lineDescription);
  const units = col(QFIELD.lineUnitKind);
  const unitCounts = col(QFIELD.lineUnits);
  const periods = col(QFIELD.linePeriods);
  const sells = col(QFIELD.lineUnitSellRupees);
  const costs = col(QFIELD.lineUnitCostRupees);
  const remarks = col(QFIELD.lineRemark);
  const rows = Math.max(options.length, descriptions.length, sells.length, units.length);
  const lines: QuotationLineInput[] = [];
  for (let i = 0; i < rows; i += 1) {
    const description = singleLine(descriptions[i] ?? '');
    const sellRaw = (sells[i] ?? '').trim();
    if (description === '' && sellRaw === '' && (units[i] ?? '').trim() === '') continue;
    const bad = (name: string) => fields.push(`${name}[${i}]`);
    const optionKey = oneOf<OptionKey>(OPTION_KEYS, (options[i] ?? '').trim()) ?? null;
    if (!optionKey) bad(QFIELD.lineOptionKey);
    const itemIdRaw = (itemIds[i] ?? '').trim();
    const itemId = itemIdRaw === '' ? null : UUID.test(itemIdRaw) ? itemIdRaw.toLowerCase() : undefined;
    if (itemId === undefined) bad(QFIELD.lineItemId);
    const chargeKind = oneOf<ChargeKind>(CHARGE_KINDS, (charges[i] ?? '').trim() || 'main');
    if (!chargeKind) bad(QFIELD.lineChargeKind);
    const categoryKey = oneOf<CategoryKey>(CATEGORY_KEYS, (categories[i] ?? '').trim());
    if (!categoryKey) bad(QFIELD.lineCategoryKey);
    if (!isText(description, LINE_LIMITS.description)) bad(QFIELD.lineDescription);
    const unitKind = oneOf<UnitKind>(UNIT_KINDS, (units[i] ?? '').trim());
    if (!unitKind) bad(QFIELD.lineUnitKind);
    const fixedUnits = unitKind === 'line_total';
    const fixedPeriods = unitKind === 'line_total' || unitKind === 'person';
    const u = fixedUnits ? 1 : intIn((unitCounts[i] ?? '').trim(), LINE_LIMITS.units.min, LINE_LIMITS.units.max);
    if (u === null || u === undefined) bad(QFIELD.lineUnits);
    const p = fixedPeriods ? 1 : intIn((periods[i] ?? '').trim(), LINE_LIMITS.periods.min, LINE_LIMITS.periods.max);
    if (p === null || p === undefined) bad(QFIELD.linePeriods);
    const sell = parseWholeRupees(sellRaw);
    if (sell === null || sell === undefined) bad(QFIELD.lineUnitSellRupees);
    const cost = parseRupeesWithPaise(costs[i]);
    if (cost === undefined) bad(QFIELD.lineUnitCostRupees);
    const remarkRaw = singleLine(remarks[i] ?? '');
    if (remarkRaw !== '' && !isText(remarkRaw, LINE_LIMITS.remark)) bad(QFIELD.lineRemark);
    lines.push({
      lineNo: lines.length + 1,
      optionKey: optionKey ?? 'common',
      itemId: itemId ?? null,
      chargeKind: chargeKind ?? 'main',
      categoryKey: categoryKey ?? 'other',
      description,
      unitKind: unitKind ?? 'line_total',
      units: typeof u === 'number' ? u : 1,
      periods: typeof p === 'number' ? p : 1,
      unitSellPaise: sell ?? '0',
      unitCostPaise: cost ?? null,
      remark: remarkRaw === '' ? null : remarkRaw,
    });
  }
  if (lines.length > LINE_LIMITS.lines) fields.push(QFIELD.lineDescription);
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion!, lines }));
}

export interface QuotationTierTotalForm {
  versionId: string;
  expectedRowVersion: number;
  tierKey: TierKey;
  /** null clears the total (draft). */
  quotedTotalPaise: PaiseString | null;
  showPerPerson: boolean;
}
export function parseQuotationTierTotalForm(formData: FormData): ParsedForm<QuotationTierTotalForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const tierKey = oneOf<TierKey>(TIER_KEYS, value(formData, QFIELD.tierKey));
  if (!tierKey) fields.push(QFIELD.tierKey);
  const total = parseWholeRupees(value(formData, QFIELD.quotedTotalRupees));
  if (total === undefined || total === '0') fields.push(QFIELD.quotedTotalRupees);
  return done(fields, () => ({
    versionId: versionId!,
    expectedRowVersion: expectedRowVersion!,
    tierKey: tierKey!,
    quotedTotalPaise: total ?? null,
    showPerPerson: checkbox(formData, QFIELD.showPerPerson),
  }));
}

export interface QuotationPlanRow {
  seq: number;
  label: string;
  amountPaise: PaiseString;
  dueRule: DueRule;
  dueDays: number | null;
  dueDate: string | null;
}
export interface QuotationPlanForm {
  versionId: string;
  expectedRowVersion: number;
  tierKey: TierKey;
  instalments: QuotationPlanRow[];
}
export function parseQuotationPlanForm(formData: FormData): ParsedForm<QuotationPlanForm> {
  const fields: string[] = [];
  const { versionId, expectedRowVersion } = versionRow(formData, fields);
  const tierKey = oneOf<TierKey>(TIER_KEYS, value(formData, QFIELD.tierKey));
  if (!tierKey) fields.push(QFIELD.tierKey);
  const labels = strings(formData, QFIELD.instalmentLabel);
  const amounts = strings(formData, QFIELD.instalmentAmountRupees);
  const rules = strings(formData, QFIELD.instalmentDueRule);
  const days = strings(formData, QFIELD.instalmentDueDays);
  const dates = strings(formData, QFIELD.instalmentDueDate);
  const instalments: QuotationPlanRow[] = [];
  for (let i = 0; i < Math.max(labels.length, amounts.length); i += 1) {
    const label = singleLine(labels[i] ?? '');
    const amountRaw = (amounts[i] ?? '').trim();
    if (label === '' && amountRaw === '') continue;
    const bad = (name: string) => fields.push(`${name}[${i}]`);
    if (!isText(label, QUOTATION_PLAN_LIMITS.label)) bad(QFIELD.instalmentLabel);
    const amount = parseWholeRupees(amountRaw);
    if (!amount || amount === '0') bad(QFIELD.instalmentAmountRupees);
    const dueRule = oneOf<DueRule>(DUE_RULES, (rules[i] ?? '').trim());
    if (!dueRule) bad(QFIELD.instalmentDueRule);
    let dueDays: number | null = null;
    let dueDate: string | null = null;
    if (dueRule === 'days_before_start') {
      const n = intIn((days[i] ?? '').trim(), QUOTATION_PLAN_LIMITS.dueDays.min, QUOTATION_PLAN_LIMITS.dueDays.max);
      if (n === null || n === undefined) bad(QFIELD.instalmentDueDays);
      else dueDays = n;
    }
    if (dueRule === 'fixed_date') {
      const d = (dates[i] ?? '').trim();
      if (!isIsoDate(d)) bad(QFIELD.instalmentDueDate);
      else dueDate = d;
    }
    instalments.push({ seq: instalments.length + 1, label, amountPaise: amount ?? '0', dueRule: dueRule ?? 'on_acceptance', dueDays, dueDate });
  }
  if (instalments.length > QUOTATION_PLAN_LIMITS.instalments) fields.push(QFIELD.instalmentLabel);
  return done(fields, () => ({ versionId: versionId!, expectedRowVersion: expectedRowVersion!, tierKey: tierKey!, instalments }));
}

export interface QuotationCostEstimatesForm {
  versionId: string;
  /** One per line in line order (index + 1 = line number); null = unknown. */
  costs: Array<{ lineNo: number; unitCostPaise: PaiseString | null }>;
}
export function parseQuotationCostEstimatesForm(formData: FormData): ParsedForm<QuotationCostEstimatesForm> {
  const fields: string[] = [];
  const versionId = readUuid(formData, QFIELD.versionId);
  if (!versionId) fields.push(QFIELD.versionId);
  const costs: QuotationCostEstimatesForm['costs'] = [];
  strings(formData, QFIELD.lineUnitCostRupees).forEach((raw, i) => {
    const cost = parseRupeesWithPaise(raw);
    if (cost === undefined) fields.push(`${QFIELD.lineUnitCostRupees}[${i}]`);
    costs.push({ lineNo: i + 1, unitCostPaise: cost ?? null });
  });
  if (costs.length === 0 || costs.length > LINE_LIMITS.lines) fields.push(QFIELD.lineUnitCostRupees);
  return done(fields, () => ({ versionId: versionId!, costs }));
}
