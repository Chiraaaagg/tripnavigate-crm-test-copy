import { canReadDealCommercial, type ViewerAccess } from '@/modules/access/policy';
import type { SalesPaymentClaims } from '@/modules/finance/contracts';
import type { SwitchState } from '@/modules/settings/contracts';
import type { IntakeChecklist } from './contracts';
import type {
  ApplicantRecord,
  BookingFormRecord,
  BookingPanelB11Record,
  CostRowRecord,
  DepartmentEvidenceRecord,
  HistoryRowRecord,
  IdProofRecord,
  TaskIdProofsRecord,
  DealIdProofsRecord,
  IdProofCopyAlertsRecord,
  IdProofCopyStatusRecord,
  PrefillRecord,
  VisaTaskDetailRecord,
  VisaTaskSummaryRecord,
  WorkFormRecord,
} from './b11-commands';
import {
  BOOK_NOW_TEXT,
  BOOK_SECTIONS,
  BOOK_STEPS,
  type BookChecklistCode,
  type BookChecklistItem,
  type BookingAccountsReview,
  type BookingBillingView,
  type BookingCommercials,
  type BookingIssueCode,
  type BookingTrip,
  type BookingVersionHistoryEntry,
  type BookNowVersion,
  type BookNowView,
  type BookSection,
  type BookServiceItemView,
  type BookStep,
  type BookStepStatus,
  type BookTravellerView,
  CHECKLIST_STEP,
  ID_PROOF_COPY_STATUS_TEXT,
  ID_PROOF_COPY_RETRYABLE,
  ID_PROOF_COPY_SUPER_ADMIN_CODES,
  type IdProofCopyAlertsView,
  idProofCopyReasonText,
  type IdProofCopyAlertView,
  type IdProofCopyView,
  BOOKING_PREFILL_FIELDS,
  PREFILL_CUSTOMER_TYPE_LABEL,
  PREFILL_FIELD_LABEL,
  PREFILL_MARK_STATE_TEXT,
  QUOTATION_PREFILL_FIELDS,
  type PrefillFieldCode,
  type PrefillView,
  idProofDownloadHref,
  type TaskIdProofsView,
  type DealIdProofsView,
  type TravellerIdProofView,
  type ChecklistTarget,
  ITEM_SCOPED_CHECKLIST_CODES,
  CHECKLIST_TEXT,
  type DepartmentCostView,
  type DepartmentEvidenceView,
  type DepartmentWorkFormView,
  ERROR_TEXT,
  FLIGHT_DIRECT_PAYMENT_LIMIT_PAISE,
  type IntakeChecklistCode,
  type IntakeChecklistOwner,
  ISSUE_TEXT,
  type PlanInstalment,
  type ServiceItemView,
  type VisaApplicantView,
  type VisaDocumentView,
  type VisaQueueView,
  type VisaTaskSummary,
  type VisaTaskView,
  DEPARTMENT_COST_TEXT,
} from './contracts';
import { BookingShapeError, copyFacts, copyIdentity, copyTrip, computeProgress, formatEvidenceSize, itemTitle, type IntakeDealFacts, toServiceItemView } from './dto';

/**
 * B1.1 DTO shaping (explicit copies, never spreads of records). The Book now
 * view carries commercial members (selling total, list, discount, plan,
 * claims) only when the database sent them AND the application mirror of the
 * policy allows it. Desk and department DTOs carry no selling price, list
 * price, discount, plan, claims, receipts, contacts or billing at all.
 */

const EMPTY_TRIP: BookingTrip = { destination: null, scope: null, start: null, end: null };

const GATE_ISSUES: BookingIssueCode[] = ['environment_unset', 'booking_disabled'];

/** Readiness issue codes that duplicate a checklist code (the checklist entry wins). */
const SAME_AS: Partial<Record<BookingIssueCode, IntakeChecklistCode>> = {
  missing_acceptance_proof: 'acceptance_missing',
  missing_selling_total: 'selling_total_missing',
  traveller_count_mismatch: 'traveller_missing',
};

function issueOwner(code: BookingIssueCode): IntakeChecklistOwner {
  if (code === 'stage_not_confirmed') return 'bitrix';
  if (code === 'environment_unset' || code === 'booking_disabled' || code === 'source_not_recently_verified') return 'admin';
  if (code === 'base_no_longer_returned') return 'accounts';
  return 'sales';
}

function withNumbers(base: string, itemNos: number[], travellerSeqs: number[]): string {
  const parts: string[] = [];
  if (itemNos.length > 0) parts.push(`service ${itemNos.join(', ')}`);
  if (travellerSeqs.length > 0) parts.push(`traveller ${travellerSeqs.join(', ')}`);
  return parts.length === 0 ? base : `${base} (${parts.join('; ')})`;
}

/** Item fields the checklist router needs (BookServiceItemView satisfies it). */
export type ChecklistRouteItem = Pick<BookServiceItemView, 'itemNo' | 'serviceType' | 'state'>;

const ITEM_SCOPED = new Set<BookChecklistCode>(ITEM_SCOPED_CHECKLIST_CODES);
const HOTEL_TARGET: Pick<ChecklistTarget, 'step' | 'section'> = { step: 'stay', section: 'hotels' };
const SERVICES_TARGET: Pick<ChecklistTarget, 'step' | 'section'> = { step: 'finish', section: 'services' };

function itemTarget(item: ChecklistRouteItem): Pick<ChecklistTarget, 'step' | 'section'> {
  return item.serviceType === 'hotel' ? HOTEL_TARGET : SERVICES_TARGET;
}

/**
 * Where an item-scoped code is fixed: one group per section, each with the
 * item numbers in that section (hotel → stay/hotels, every other type →
 * finish/services; B1.2 freeze note §2.1). Without item numbers: hotels only
 * when every active item is a hotel, else the map's default (finish/services).
 * An item number the form does not know keeps the map's default.
 */
export function routeChecklistItems(
  code: BookChecklistCode,
  itemNos: readonly number[],
  items: readonly ChecklistRouteItem[],
): Array<{ target: ChecklistTarget; itemNos: number[] }> {
  const base = CHECKLIST_STEP[code];
  if (!ITEM_SCOPED.has(code)) return [{ target: base, itemNos: [...itemNos] }];
  if (itemNos.length === 0) {
    // Without item numbers the item cannot be known: hotels only when every active item is a hotel, else the default.
    const active = items.filter((i) => i.state !== 'cancelled');
    const allHotels = active.length > 0 && active.every((i) => i.serviceType === 'hotel');
    return [{ target: allHotels ? { ...base, ...HOTEL_TARGET } : base, itemNos: [] }];
  }
  const groups = new Map<BookSection, { target: ChecklistTarget; itemNos: number[] }>();
  for (const no of itemNos) {
    const item = items.find((i) => i.itemNo === no);
    const target: ChecklistTarget = item ? { ...base, ...itemTarget(item) } : base;
    const group = groups.get(target.section) ?? { target, itemNos: [] };
    group.itemNos.push(no);
    groups.set(target.section, group);
  }
  return BOOK_SECTIONS.filter((s) => groups.has(s)).map((s) => groups.get(s)!);
}

/**
 * The form's checklist: every intake_checklist item, plus readiness issues
 * that the checklist did not already list. Each item names its step, section
 * and field through the frozen CHECKLIST_STEP map; item-scoped codes are
 * listed once per section that holds one of their items.
 */
export function mergeBookChecklist(
  checklist: IntakeChecklist | null,
  issues: readonly BookingIssueCode[],
  items: readonly ChecklistRouteItem[] = [],
): BookChecklistItem[] {
  const out: BookChecklistItem[] = [];
  const seen = new Set<BookChecklistCode>();
  for (const item of checklist?.items ?? []) {
    if (item.code === 'prefill_unchecked') {
      out.push(...prefillChecklistItems(item));
      seen.add(item.code);
      continue;
    }
    const travellerSeqs = [...(item.travellerSeqs ?? [])];
    for (const group of routeChecklistItems(item.code, item.itemNos, items)) {
      out.push({
        code: item.code,
        step: group.target.step,
        section: group.target.section,
        field: group.target.field,
        blocking: item.blocking,
        owner: item.owner,
        itemNos: group.itemNos,
        travellerSeqs: [...travellerSeqs],
        text: withNumbers(CHECKLIST_TEXT[item.code], group.itemNos, travellerSeqs),
      });
    }
    seen.add(item.code);
  }
  for (const code of issues) {
    const same = SAME_AS[code];
    if (seen.has(code) || (same && seen.has(same))) continue;
    const [group] = routeChecklistItems(code, [], items);
    const target = group!.target;
    out.push({ code, step: target.step, section: target.section, field: target.field, blocking: true, owner: issueOwner(code), itemNos: [], travellerSeqs: [], text: ISSUE_TEXT[code] });
    seen.add(code);
  }
  return out;
}

const PREFILL_TRIP_TARGET: ChecklistTarget = { step: 'stay', section: 'trip', field: 'tripStart' };

/**
 * prefill_unchecked (0600, warning): trip-date fields are fixed on step 2
 * (destinations and dates), contact fields on step 1 (customer). One row per
 * section, naming the fields still marked from Bitrix.
 */
function prefillChecklistItems(item: IntakeChecklist['items'][number]): BookChecklistItem[] {
  const codes = (item.fields ?? []).filter((f): f is PrefillFieldCode => (QUOTATION_PREFILL_FIELDS as readonly string[]).includes(f));
  const trip = codes.filter((f) => f.startsWith('trip.'));
  const other = codes.filter((f) => !f.startsWith('trip.'));
  const groups: Array<{ target: ChecklistTarget; fields: PrefillFieldCode[] }> = [];
  if (other.length > 0 || codes.length === 0) groups.push({ target: CHECKLIST_STEP.prefill_unchecked, fields: other });
  if (trip.length > 0) groups.push({ target: { ...PREFILL_TRIP_TARGET, field: trip.includes('trip.start') ? 'tripStart' : 'tripEnd' }, fields: trip });
  return groups.map(({ target, fields }) => ({
    code: 'prefill_unchecked',
    step: target.step,
    section: target.section,
    field: target.field,
    blocking: false,
    owner: item.owner,
    itemNos: [],
    travellerSeqs: [],
    text: fields.length > 0 ? `${CHECKLIST_TEXT.prefill_unchecked} (${fields.map((f) => PREFILL_FIELD_LABEL[f]).join(', ')})` : CHECKLIST_TEXT.prefill_unchecked,
    prefillFields: fields,
  }));
}

/** Indian mobile as the database normalises it (digits; leading 91 / 0 dropped); null when it would not be applied. */
function prefillMobile(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function prefillValue(record: PrefillRecord, field: PrefillFieldCode): string | null {
  const f = record.fields;
  switch (field) {
    case 'trip.start':
      return f.tourStart;
    case 'trip.end':
      return f.tourEnd;
    case 'requirementsNote':
      return f.bookingNotes;
    case 'contacts.contactName':
      return f.contact?.name?.trim() || null;
    case 'contacts.mobile':
      return f.contact?.mobile ?? null;
    case 'contacts.email':
      return f.contact?.email ?? null;
    case 'contacts.companyName':
      return f.company?.name?.trim() || null;
    case 'contacts.bookingFor':
      // DEC-45: every known Bitrix Customer Type is a business booking; unknown or absent fills nothing.
      return f.customerType?.code ? 'business' : null;
  }
}

/**
 * The "From Bitrix" panel for Book now (booking fields) or a quotation
 * (quotation fields). `canEdit`: the working version is editable by the
 * viewer. A mobile Bitrix has in a form the database would skip is shown but
 * not offered. Unknown codes never reach the view.
 */
export function toPrefillView(record: PrefillRecord, opts: { target: 'booking' | 'quotation'; canEdit: boolean; unchecked?: readonly string[] }): PrefillView {
  const codes: readonly PrefillFieldCode[] = opts.target === 'booking' ? BOOKING_PREFILL_FIELDS : QUOTATION_PREFILL_FIELDS;
  const marks = new Map(record.marks.map((m) => [m.fieldCode, m]));
  const fields = codes.map((field) => {
    const hidden = field === 'requirementsNote' && record.notesHidden;
    const bitrixValue = record.available && !hidden ? prefillValue(record, field) : null;
    const state = marks.get(field)?.state ?? null;
    const usable = field === 'contacts.mobile' ? prefillMobile(bitrixValue) !== null : bitrixValue !== null;
    return {
      field,
      label: PREFILL_FIELD_LABEL[field],
      bitrixValue,
      state,
      stateText: state ? PREFILL_MARK_STATE_TEXT[state] : null,
      canUse: record.available && opts.canEdit && usable,
      // Batch 2 (F.2): kept (saved by staff, not checked) can be checked too; changed and replaced cannot.
      canMarkChecked: opts.canEdit && (state === 'from_bitrix' || state === 'kept'),
    };
  });
  const unchecked = opts.unchecked
    ? opts.unchecked.filter((f): f is PrefillFieldCode => (codes as readonly string[]).includes(f))
    : fields.filter((f) => f.state === 'from_bitrix' || f.state === 'kept').map((f) => f.field);
  const customerType = record.available ? (record.fields.customerType?.code ?? null) : null;
  return {
    available: record.available,
    sourceModifiedAt: record.sourceModifiedAt,
    lastVerifiedAt: record.lastVerifiedAt,
    issues: [...record.issues],
    bookingNotes: record.available && !record.notesHidden ? record.fields.bookingNotes : null,
    notesHidden: record.notesHidden,
    travellerTotal: record.available ? record.fields.travellerTotal : null,
    customerType,
    customerTypeLabel: customerType ? PREFILL_CUSTOMER_TYPE_LABEL[customerType] : null,
    fields,
    unchecked,
    ...(record.autoFill ? { autoFill: record.autoFill } : {}),
    ...(record.fieldStates ? { fieldStates: record.fieldStates.filter((f) => (codes as readonly string[]).includes(f.field)) } : {}),
  };
}

function markerOf(items: readonly BookChecklistItem[]): BookStepStatus {
  return items.some((i) => i.blocking) ? 'needs_input' : items.length > 0 ? 'warnings_only' : 'complete';
}

/** Section markers: blocking item → needs input; only warnings → warnings only; nothing → complete. Not started → every section needs input. */
export function bookSectionStatus(items: readonly BookChecklistItem[], started: boolean): Record<BookSection, BookStepStatus> {
  const status = {} as Record<BookSection, BookStepStatus>;
  for (const section of BOOK_SECTIONS) status[section] = started ? markerOf(items.filter((i) => i.section === section)) : 'needs_input';
  return status;
}

/** Step markers: the worst of the step's sections (same rule). Not started → every step needs input. */
export function bookStepStatus(items: readonly BookChecklistItem[], started: boolean): Record<BookStep, BookStepStatus> {
  const status = {} as Record<BookStep, BookStepStatus>;
  for (const step of BOOK_STEPS) status[step] = started ? markerOf(items.filter((i) => i.step === step)) : 'needs_input';
  return status;
}

/** Seqs whose identity is needed: participants of visa/passport items, and of flight items on an international trip. */
export function identityRequiredSeqs(items: ReadonlyArray<Pick<BookServiceItemView, 'serviceType' | 'participants' | 'state'>>, trip: BookingTrip): Set<number> {
  const seqs = new Set<number>();
  for (const item of items) {
    if (item.state === 'cancelled') continue;
    const needs = item.serviceType === 'visa' || item.serviceType === 'passport' || (item.serviceType === 'flight' && trip.scope === 'international');
    if (needs) for (const s of item.participants) seqs.add(s);
  }
  return seqs;
}

function copyBilling(record: BookingFormRecord['billing'], canEdit: boolean): BookingBillingView {
  return {
    status: record.status,
    prefillSource: record.prefillSource,
    rowVersion: record.rowVersion,
    billingName: record.billingName,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    stateCode: record.stateCode,
    postalCode: record.postalCode,
    gstin: record.gstin,
    editableBySales: canEdit && record.status !== 'verified',
  };
}

function copyHistory(rows: HistoryRowRecord[], commercial: boolean): BookingVersionHistoryEntry[] {
  return rows.map((r) => ({
    versionId: r.versionId,
    versionNo: r.versionNo,
    status: r.status,
    confirmedAt: r.confirmedAt,
    revisesVersionId: r.revisesVersionId,
    changeClass: r.changeClass,
    changedFields: [...r.changedFields],
    reviewStatus: r.reviewStatus,
    reviewReason: r.reviewReasonHidden ? null : r.reviewReason,
    reviewReasonHidden: r.reviewReasonHidden,
    supersededAt: r.supersededAt,
    ...(commercial && r.sellingTotalPaise !== undefined ? { sellingTotalPaise: r.sellingTotalPaise } : {}),
    ...(commercial && r.sellingTotalDeltaPaise !== undefined ? { sellingTotalDeltaPaise: r.sellingTotalDeltaPaise } : {}),
  }));
}

/** Explicit copy of the Sales claims projection (finance shape; never receipt numbers or Accounts names). */
export function copySalesClaims(c: SalesPaymentClaims): SalesPaymentClaims {
  return {
    dealId: c.dealId,
    sellingTotalPaise: c.sellingTotalPaise,
    reportedPaise: c.reportedPaise,
    confirmedPaise: c.confirmedPaise,
    balancePaise: c.balancePaise,
    canReport: c.canReport,
    reportBlock: c.reportBlock,
    destinations: c.destinations.map((d) => ({
      versionId: d.versionId,
      kind: d.kind,
      label: d.label,
      bankName: d.bankName,
      accountMasked: d.accountMasked,
      upiMasked: d.upiMasked,
    })),
    claims: c.claims.map((x) => ({
      claimId: x.claimId,
      status: x.status,
      displayStatus: x.displayStatus,
      amountPaise: x.amountPaise,
      mode: x.mode,
      reference: x.reference,
      chequeNumber: x.chequeNumber,
      chequeDate: x.chequeDate,
      paidOn: x.paidOn,
      payerName: x.payerName,
      note: x.note,
      destinationLabel: x.destinationLabel,
      receiptAmountPaise: x.receiptAmountPaise,
      notReceivedReason: x.notReceivedReason,
      reportedByName: x.reportedByName,
      reportedAt: x.reportedAt,
      rowVersion: x.rowVersion,
      canWithdraw: x.canWithdraw,
    })),
  };
}

/**
 * booking_form_get travellers[].idProofs → views (explicit copies). The
 * download link is offered only for stored files; the route authorizes again
 * on every call.
 */
export function toIdProofViews(rows: readonly IdProofRecord[]): TravellerIdProofView[] {
  return rows.map((f) => ({
    fileId: f.fileId,
    fileName: f.fileName,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    sizeLabel: formatEvidenceSize(f.sizeBytes),
    status: f.status,
    rowVersion: f.rowVersion,
    uploadedByName: f.uploadedByName,
    uploadedByYou: f.uploadedByYou,
    uploadedAt: f.createdAt,
    storedAt: f.storedAt,
    consentByName: f.consentByName,
    consentAt: f.consentAt,
    downloadHref: f.status === 'stored' ? idProofDownloadHref(f.fileId) : null,
  }));
}

function toStoredIdProofTravellers(travellers: TaskIdProofsRecord['travellers']): TaskIdProofsView['travellers'] {
  return travellers.map((t) => ({
      seq: t.seq,
      fullName: t.fullName,
      type: t.type,
      idProofs: t.idProofs.map((f) => ({
        fileId: f.fileId,
        fileName: f.fileName,
        mime: f.mime,
        sizeLabel: formatEvidenceSize(f.sizeBytes),
        storedAt: f.storedAt,
        downloadHref: idProofDownloadHref(f.fileId),
      })),
    }));
}

/** traveller_id_proofs_for_task → the "Traveller ID proofs" list on a department task (explicit copies; stored files only). */
export function toTaskIdProofsView(record: TaskIdProofsRecord): TaskIdProofsView {
  return { taskId: record.taskId, travellers: toStoredIdProofTravellers(record.travellers) };
}

/** traveller_id_proofs_for_deal → the Deal's "Traveller ID proofs" list (explicit copies; stored files only). */
export function toDealIdProofsView(record: DealIdProofsRecord): DealIdProofsView {
  return { dealId: record.dealId, travellers: toStoredIdProofTravellers(record.travellers) };
}

export interface BookNowInputs {
  viewer: ViewerAccess;
  deal: IntakeDealFacts;
  form: BookingFormRecord;
  panel: BookingPanelB11Record | null;
  checklist: IntakeChecklist | null;
  /** undefined = not available (not installed, not allowed); never fabricated. */
  claims?: SalesPaymentClaims | null;
  history?: HistoryRowRecord[] | null;
}

export function toBookNowView(input: BookNowInputs): BookNowView {
  const { viewer, deal, form, panel, checklist } = input;
  if (form.dealId !== deal.id || (panel && panel.dealId !== deal.id)) throw new BookingShapeError('book now reads do not belong to this deal');
  const commercialAllowed = canReadDealCommercial(viewer, deal);
  const v = form.version;
  const isDraft = v?.status === 'draft';
  const history = input.history ?? null;
  const historyFor = (id: string | null) => (id ? history?.find((h) => h.versionId === id) : undefined);
  const revision = panel?.revision && v && panel.revision.versionId === v.versionId ? panel.revision : null;
  const ownHistory = historyFor(v?.versionId ?? null);
  const revisesVersionId = v?.revisesVersionId ?? ownHistory?.revisesVersionId ?? null;

  const version: BookNowVersion | null = v
    ? {
        versionId: v.versionId,
        versionNo: v.versionNo,
        status: v.status,
        serviceType: v.serviceType,
        confirmedAt: v.confirmedAt,
        rowVersion: v.rowVersion,
        // The hash the submit form posts back: readiness' hash for a draft when present.
        contentHash: isDraft ? (panel?.readiness?.contentHash ?? v.contentHash) : v.contentHash,
        savedAt: v.updatedAt,
        savedByName: v.updatedByName,
        revisesVersionId,
        revisesVersionNo: historyFor(revisesVersionId)?.versionNo ?? null,
        changeClass: revision?.changeClass ?? ownHistory?.changeClass ?? null,
        changedFields: [...(revision?.changedFields ?? ownHistory?.changedFields ?? [])],
        allowedClasses: revision?.allowedClasses ? [...revision.allowedClasses] : null,
      }
    : null;

  const items: BookServiceItemView[] = form.items.map((record) => {
    const view: ServiceItemView = toServiceItemView(record);
    return { ...view, participants: [...(record.participants ?? [])], waitingForLaunch: view.waitingForLaunch === true };
  });
  const trip = form.trip ? copyTrip(form.trip) : { ...EMPTY_TRIP };
  const needIdentity = identityRequiredSeqs(items, trip);
  const travellers: BookTravellerView[] = form.travellers.map((t) => ({
    travellerId: t.travellerId,
    seq: t.seq,
    fullName: t.fullName,
    type: t.type,
    ageYears: t.ageYears,
    specialNeeds: t.specialNeeds,
    // Voice-note batch: standard request codes (absent on an older database = none sent).
    ...(t.specialRequests !== undefined ? { specialRequests: [...t.specialRequests] } : {}),
    identityRequired: needIdentity.has(t.seq),
    identity: t.identity
      ? {
          ...copyIdentity(t.identity),
          // Booking form passenger extras (only when set; absent on an older database).
          ...(t.identity.dateOfMarriage ? { dateOfMarriage: t.identity.dateOfMarriage } : {}),
          ...(t.identity.phone ? { phone: t.identity.phone } : {}),
          ...(t.identity.email ? { email: t.identity.email } : {}),
          ...(t.identity.extraPhones !== undefined ? { extraPhones: [...t.identity.extraPhones] } : {}),
        }
      : null,
    ...(t.idProofs ? { idProofs: toIdProofViews(t.idProofs) } : {}),
  }));

  const issues = isDraft ? (panel?.readiness?.issues ?? []) : [];
  const merged = isDraft ? mergeBookChecklist(checklist, issues, items) : [];
  const blocking = merged.some((i) => i.blocking);
  const notActive = form.dealNotActive || panel?.dealNotActive === true;
  const canEdit = form.canEdit && !notActive && form.serviceItemsEnabled && (v === null || isDraft);
  const canSubmit = form.canConfirm && isDraft && !blocking && !notActive && form.serviceItemsEnabled;

  let submitBlockedReason: string | null = null;
  if (isDraft && !canSubmit) {
    if (notActive) submitBlockedReason = ERROR_TEXT.deal_not_active;
    else if (!form.serviceItemsEnabled) submitBlockedReason = ERROR_TEXT.service_items_disabled;
    else if (!form.canConfirm) submitBlockedReason = ERROR_TEXT.not_authorized;
    else if (merged.some((i) => i.code === 'stage_not_confirmed')) submitBlockedReason = BOOK_NOW_TEXT.submitWaitsForWon;
    else {
      const gate = GATE_ISSUES.find((code) => issues.includes(code));
      if (gate) submitBlockedReason = ISSUE_TEXT[gate];
    }
  }
  let openBlockedReason: string | null = null;
  if (v === null) {
    if (notActive) openBlockedReason = ERROR_TEXT.deal_not_active;
    else if (!form.serviceItemsEnabled) openBlockedReason = ERROR_TEXT.service_items_disabled;
    else if (!form.canEdit) openBlockedReason = ERROR_TEXT.not_authorized;
  }

  const review = panel?.accountsReview;
  const accountsReview: BookingAccountsReview | null = review
    ? { status: review.status, reviewedAt: review.reviewedAt, reason: review.reasonHidden ? null : review.reason, reasonHidden: review.reasonHidden }
    : null;

  const commercials: BookingCommercials | undefined =
    commercialAllowed && form.commercials !== undefined
      ? {
          listPricePaise: form.commercials?.listPricePaise ?? null,
          discountPaise: form.commercials?.discountPaise ?? null,
          sellingTotalPaise: form.commercials?.sellingTotalPaise ?? null,
        }
      : undefined;
  const plan: PlanInstalment[] | undefined =
    commercialAllowed && form.plan !== undefined
      ? form.plan.map((p) => ({ seq: p.seq, label: p.label, amountPaise: p.amountPaise, dueDate: p.dueDate })).sort((a, b) => a.seq - b.seq)
      : undefined;

  const synced = deal.sourceSystem === 'bitrix' && !!deal.sourceStageId;
  const stageNotConfirmed = (checklist?.items ?? []).some((i) => i.code === 'stage_not_confirmed') || issues.includes('stage_not_confirmed');

  return {
    dealId: deal.id,
    dealReference: deal.reference,
    dealTitle: deal.title,
    stage: synced ? { stageId: deal.sourceStageId!, label: null, isTriggerStage: !stageNotConfirmed } : null,
    dealNotActive: notActive,
    serviceItemsEnabled: form.serviceItemsEnabled,
    visaPassportTasksEnabled: form.visaPassportTasksEnabled,
    gate: panel ? { realBookingEnabled: panel.gate.realBookingEnabled, environment: panel.gate.environment } : { realBookingEnabled: false, environment: 'unset' },
    version,
    canEdit,
    // Older 0100 text had no flag: commercial editors are editors who received the commercial members.
    canEditCommercials: canEdit && commercialAllowed && (form.canEditCommercials ?? form.commercials !== undefined),
    canSubmit,
    submitBlockedReason,
    openBlockedReason,
    canOpenRevision: panel?.canRevise === true && !notActive,
    accountsReview,
    trip,
    contacts: form.contacts
      ? {
          contactName: form.contacts.contactName,
          mobile: form.contacts.mobile,
          email: form.contacts.email,
          contactConfirmed: form.contacts.contactConfirmed,
          confirmedAt: form.contacts.confirmedAt,
          confirmedByName: form.contacts.confirmedByName,
          bookingFor: form.contacts.bookingFor,
          payerDifferent: form.contacts.payerDifferent,
          payerName: form.contacts.payerName,
        }
      : null,
    billing: copyBilling(form.billing, canEdit),
    idProofCanEdit: form.idProofCanEdit === true,
    idProofCanRemove: form.idProofCanRemove === true,
    idProofLimits: form.idProofLimits ? { maxFilesPerTraveller: form.idProofLimits.maxFilesPerTraveller, maxBytes: form.idProofLimits.maxBytes } : null,
    travellers,
    items,
    ...(commercials ? { commercials } : {}),
    ...(plan ? { plan } : {}),
    ...(commercialAllowed && input.claims ? { claims: copySalesClaims(input.claims) } : {}),
    evidence: form.evidence
      .filter((e) => e.status !== 'removed')
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        fileName: e.fileName,
        sizeLabel: formatEvidenceSize(e.sizeBytes),
        status: e.status,
        uploadedByYou: e.uploadedByYou,
        uploadedAt: e.createdAt,
      })),
    evidenceVisible: panel ? panel.evidenceVisible : true,
    checklist: merged,
    stepStatus: bookStepStatus(merged, v !== null),
    sectionStatus: bookSectionStatus(merged, v !== null),
    progress: computeProgress(items),
    ...(history ? { history: copyHistory(history, commercialAllowed) } : {}),
    ...(form.sourceQuotation
      ? {
          quotationSource: {
            quotationId: form.sourceQuotation.quotationId,
            reference: form.sourceQuotation.reference,
            versionId: form.sourceQuotation.versionId,
            versionNo: form.sourceQuotation.versionNo,
            acceptedAt: form.sourceQuotation.acceptedAt,
            acceptedTierKey: form.sourceQuotation.acceptedTierKey,
            // Same audited route as the quotation screens (quotations quotationEvidenceHref).
            acceptanceHref: form.sourceQuotation.acceptanceEvidenceId ? `/app/quotations/evidence/${form.sourceQuotation.acceptanceEvidenceId}` : null,
          },
        }
      : {}),
    ...(form.prefill ? { prefill: toPrefillView(form.prefill, { target: 'booking', canEdit: canEdit && v !== null }) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Visa & Passport desk and department work forms (no commercial keys at all)
// ---------------------------------------------------------------------------

/** "birth_certificate" → "Birth certificate". */
export function documentLabel(code: string): string {
  const words = code.replace(/_/g, ' ').trim();
  return words === '' ? code : words.charAt(0).toUpperCase() + words.slice(1);
}

export function toDepartmentEvidence(e: DepartmentEvidenceRecord): DepartmentEvidenceView {
  return {
    id: e.evidenceId,
    kind: e.kind,
    applicationId: e.applicationId,
    fileName: e.fileName,
    sizeLabel: formatEvidenceSize(e.sizeBytes),
    status: e.status,
    uploadedByYou: e.uploadedByYou,
    uploadedAt: e.createdAt,
  };
}

export function toDepartmentCost(row: CostRowRecord, ctx: { taskId: string; department: DepartmentCostView['department']; canWork: boolean }): DepartmentCostView {
  const editableStatus = row.expenseStatus === null || row.expenseStatus === 'draft' || row.expenseStatus === 'returned';
  return {
    entryId: row.entryId,
    taskId: ctx.taskId,
    department: ctx.department,
    costKind: row.costKind,
    amountPaise: row.amountPaise,
    paidBy: row.paidBy,
    paymentMode: row.paymentMode,
    paidOn: row.paidOn,
    reference: row.reference,
    expenseStatus: row.expenseStatus,
    returnReason: row.returnReason,
    receiptEvidenceId: row.receiptEvidenceId,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    rowVersion: row.rowVersion,
    canEdit: ctx.canWork && editableStatus && ctx.department !== 'purchase',
    canSubmit: ctx.canWork && row.paidBy === 'company' && (row.expenseStatus === 'draft' || row.expenseStatus === 'returned') && ctx.department !== 'purchase',
  };
}

function applicantClosed(a: ApplicantRecord): boolean {
  if (a.closed !== undefined) return a.closed;
  if (a.state === 'issued') return a.documentsReturnedAt !== null;
  if (a.state === 'refused' || a.state === 'withdrawn') return a.customerInformedAt !== null;
  return false;
}

function toApplicant(a: ApplicantRecord): VisaApplicantView {
  const documents: VisaDocumentView[] = Object.entries(a.documents)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([code, status]) => ({ code, label: documentLabel(code), status }));
  return {
    applicationId: a.applicationId,
    travellerSeq: a.seq,
    fullName: a.fullName ?? `Traveller ${a.seq}`,
    type: a.type,
    ageYears: a.ageYears,
    ...(a.identity !== undefined ? { identity: a.identity ? copyIdentity(a.identity) : null } : {}),
    documents,
    state: a.state,
    reference: a.reference,
    appointmentAt: a.appointmentAt,
    appointmentPlace: a.appointmentPlace,
    submittedAt: a.submittedAt,
    outcomeAt: a.outcomeAt,
    customerInformedAt: a.customerInformedAt,
    documentsReturnedAt: a.documentsReturnedAt,
    documentsReturnedByName: a.documentsReturnedByName,
    closed: applicantClosed(a),
    rowVersion: a.rowVersion,
  };
}

/** Explicit whitelist: no budget, price, plan, claims, contacts or billing. */
export function toVisaTaskSummary(record: VisaTaskSummaryRecord): VisaTaskSummary {
  const facts = copyFacts(record.facts);
  if (facts.type !== record.serviceType || (facts.type !== 'visa' && facts.type !== 'passport')) {
    throw new BookingShapeError('visa task facts do not match its service type');
  }
  return {
    taskId: record.taskId,
    dealReference: record.dealReference,
    serviceType: facts.type,
    itemTitle: itemTitle(facts),
    facts: facts.facts,
    status: record.status,
    assigneeName: record.assigneeName,
    assignedToYou: record.assignedToYou,
    branchName: record.branchName,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    applicantCount: record.applicantCount ?? null,
  };
}

export function toVisaTaskView(record: VisaTaskDetailRecord): VisaTaskView {
  const summary = toVisaTaskSummary(record);
  const canWork = record.canWork ?? (record.assignedToYou && record.status === 'in_progress');
  return {
    ...summary,
    versionNo: record.versionNo,
    confirmedAt: record.confirmedAt,
    canClaim: record.canClaim,
    canWork,
    applicants: record.applicants.map(toApplicant).sort((a, b) => a.travellerSeq - b.travellerSeq),
    evidence: record.evidence.filter((e) => e.status !== 'removed').map(toDepartmentEvidence),
    costs: record.costs.map((c) => toDepartmentCost(c, { taskId: record.taskId, department: 'visa', canWork })),
  };
}

export function toVisaQueueView(records: VisaTaskSummaryRecord[], launch: SwitchState, waitingCount: number | null): VisaQueueView {
  return { launch, waitingCount, tasks: records.map(toVisaTaskSummary) };
}

export function toDepartmentWorkFormView(record: WorkFormRecord): DepartmentWorkFormView {
  const canWork = record.canWork === true;
  const isPurchase = record.department === 'purchase';
  return {
    taskId: record.taskId,
    department: record.department,
    steps: record.steps.map((s) => ({ code: s.code, at: s.at, byName: s.byName, seq: s.seq })),
    references: record.references.map((r) => ({ kind: r.kind, value: r.value, seq: r.seq })),
    documents: record.documents.filter((d) => d.status !== 'removed').map(toDepartmentEvidence),
    costs: isPurchase ? [] : record.costs.map((c) => toDepartmentCost(c, { taskId: record.taskId, department: record.department, canWork })),
    readOnlyReason: isPurchase ? DEPARTMENT_COST_TEXT.purchasePlaceholder : null,
    canRecordCost: canWork && !isPurchase,
    directLimitPaise: record.department === 'flight' ? FLIGHT_DIRECT_PAYMENT_LIMIT_PAISE : null,
  };
}

// ---------------------------------------------------------------------------
// DEC-43 Bitrix copy status (migration 0700)
// ---------------------------------------------------------------------------

const SUPER_ADMIN_ONLY = new Set<string>(ID_PROOF_COPY_SUPER_ADMIN_CODES);

export function toIdProofCopyView(row: IdProofCopyStatusRecord[number]): IdProofCopyView {
  const retryable = ID_PROOF_COPY_RETRYABLE.includes(row.status);
  const superAdminOnly = retryable && (row.status === 'needs_manual_check' || (row.lastErrorCode !== null && SUPER_ADMIN_ONLY.has(row.lastErrorCode)));
  return {
    jobId: row.jobId,
    status: row.status,
    statusText: ID_PROOF_COPY_STATUS_TEXT[row.status],
    reasonText: row.status === 'sent' || row.status === 'cancelled' ? null : idProofCopyReasonText(row.lastErrorCode),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt,
    canRetry: retryable && !superAdminOnly,
    retryNeedsSuperAdmin: superAdminOnly,
  };
}

/**
 * Attaches each proof's copy status (by proof id; the newest job wins) to the
 * Book now travellers. Proofs without a job keep no `bitrixCopy`.
 */
export function withIdProofCopies(view: BookNowView, rows: IdProofCopyStatusRecord | null): BookNowView {
  if (!rows || rows.length === 0) return view;
  const byProof = new Map<string, IdProofCopyStatusRecord[number]>();
  for (const row of rows) {
    const seen = byProof.get(row.idProofId);
    if (!seen || seen.updatedAt <= row.updatedAt) byProof.set(row.idProofId, row);
  }
  return {
    ...view,
    travellers: view.travellers.map((t) =>
      t.idProofs
        ? { ...t, idProofs: t.idProofs.map((p) => (byProof.has(p.fileId) ? { ...p, bitrixCopy: toIdProofCopyView(byProof.get(p.fileId)!) } : p)) }
        : t,
    ),
  };
}

export function toIdProofCopyAlertViews(record: IdProofCopyAlertsRecord): IdProofCopyAlertsView {
  const stops: IdProofCopyAlertView[] = record.stops.map((r) => ({
    stopId: r.stopId,
    jobId: r.jobId,
    bitrixDealId: r.bitrixDealId,
    reasonText: idProofCopyReasonText(r.reasonCode)!,
    openedAt: r.openedAt,
    acknowledgedAt: r.acknowledgedAt,
    open: r.acknowledgedAt === null,
  }));
  const manualChecks = record.manualChecks.map((r) => ({
    jobId: r.jobId,
    bitrixDealId: r.bitrixDealId,
    reasonText: idProofCopyReasonText(r.lastErrorCode),
    readBackAttempts: r.readBackAttempts,
    updatedAt: r.updatedAt,
    statusText: ID_PROOF_COPY_STATUS_TEXT.needs_manual_check,
  }));
  return { stops, manualChecks };
}
