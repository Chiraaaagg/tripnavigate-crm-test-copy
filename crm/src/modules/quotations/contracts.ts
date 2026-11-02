import type { BookingTrip, EvidenceMime, ServiceFacts, ServiceType, TripScope } from '@/modules/fulfilment/contracts';

/*
 * B1.2 quotations (Phase E): TypeScript contracts for the quotation module
 * (B1.2 freeze note part 2; Atlas 20261120000200 quotations, versions,
 * states, conversion — shapes note atlas-b12-0200-shapes.md; Mercury
 * 20261120000300 lines, tier totals, plan).
 *
 * Rules carried here (frozen):
 * - Subjects: an imported Lead or an eligible Deal. Readers = editors: the
 *   Lead/Deal Sales owner or assignee and the branch Manager. Nobody else
 *   reads a quotation in B1.2 (Accounts, Purchase, Flight, the desk and
 *   Super Admin get the same "not available" answer as a missing quotation).
 * - States draft → ready → sent → accepted | declined | expired | superseded;
 *   draft/ready → discarded. A sent version never changes.
 * - Money: whole paise as decimal digit strings on the wire and in views
 *   (bigint in arithmetic, quotations/money.ts). Customer-visible amounts are
 *   whole rupees. Nothing is ever rounded. No GST amount anywhere (DEC-34).
 * - Units (DEC-33): hotel room_night, cab trip, flight/visa/passport
 *   line_total, activities line_total or person; night/person only on
 *   extra-bed, child-without-bed and other charge lines, chosen by staff and
 *   never multiplied automatically. No age bands.
 */

/** Whole paise as a decimal digit string ("1250000" = ₹12,500.00). */
export type PaiseString = string;

// ---------------------------------------------------------------------------
// Subjects, states, tiers
// ---------------------------------------------------------------------------

/**
 * Batch 3 (migration 20261123000100, atlas-batch3-shapes §4.5): a quotation's
 * subject is a Bitrix Lead, a Bitrix Deal or a referral draft (TD-n, a customer
 * not in Bitrix yet). Reads drop a subject kind they do not know instead of
 * failing (commands.ts), so a newer database never hides a whole list.
 */
export type QuotationSubjectKind = 'lead' | 'deal' | 'referral';
export const QUOTATION_SUBJECT_KINDS = ['lead', 'deal', 'referral'] as const satisfies readonly QuotationSubjectKind[];

export function isQuotationSubjectKind(value: unknown): value is QuotationSubjectKind {
  return typeof value === 'string' && (QUOTATION_SUBJECT_KINDS as readonly string[]).includes(value);
}

export type QuotationStatus = 'draft' | 'ready' | 'sent' | 'accepted' | 'declined' | 'expired' | 'superseded' | 'discarded';
export const QUOTATION_STATUSES = ['draft', 'ready', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'discarded'] as const satisfies readonly QuotationStatus[];
export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: 'Draft',
  ready: 'Ready to send',
  sent: 'Sent to the customer',
  accepted: 'Accepted by the customer',
  declined: 'Declined by the customer',
  expired: 'Expired',
  superseded: 'Replaced by a newer version',
  discarded: 'Discarded',
};
/** Editable in place (any edit moves ready back to draft). */
export const QUOTATION_EDITABLE_STATUSES = ['draft', 'ready'] as const satisfies readonly QuotationStatus[];

/** Exactly the engine's two tiers: `quoted` is required, `upgrade` optional. A third tier is not built. */
export type TierKey = 'quoted' | 'upgrade';
export const TIER_KEYS = ['quoted', 'upgrade'] as const satisfies readonly TierKey[];
export const TIER_KEY_LABEL: Record<TierKey, string> = { quoted: 'Quoted option', upgrade: 'Upgrade option' };
/** A money line counts in both tiers (`common`) or in one tier. */
export type OptionKey = 'common' | TierKey;
export const OPTION_KEYS = ['common', 'quoted', 'upgrade'] as const satisfies readonly OptionKey[];
export const OPTION_KEY_LABEL: Record<OptionKey, string> = { common: 'Both options', quoted: 'Quoted option only', upgrade: 'Upgrade option only' };

export type SentChannel = 'whatsapp' | 'email' | 'in_person' | 'phone' | 'other';
export const SENT_CHANNELS = ['whatsapp', 'email', 'in_person', 'phone', 'other'] as const satisfies readonly SentChannel[];
export const SENT_CHANNEL_LABEL: Record<SentChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  in_person: 'In person',
  phone: 'Phone',
  other: 'Other',
};

export type DeclineReason = 'price' | 'dates' | 'changed_plans' | 'chose_other' | 'no_response' | 'other';
export const DECLINE_REASONS = ['price', 'dates', 'changed_plans', 'chose_other', 'no_response', 'other'] as const satisfies readonly DeclineReason[];
export const DECLINE_REASON_LABEL: Record<DeclineReason, string> = {
  price: 'Price',
  dates: 'Dates did not suit',
  changed_plans: 'Customer changed plans',
  chose_other: 'Chose another company',
  no_response: 'No response',
  other: 'Other reason',
};

/** Default validity (DEC-35): IST today + 7 days, editable until sent. */
export const QUOTATION_DEFAULT_VALID_DAYS = 7;

// ---------------------------------------------------------------------------
// Version facts (Atlas): trip, people, requirements, contacts, narrative, items
// ---------------------------------------------------------------------------

/** Same shape as the booking trip block, so conversion copies it unchanged. */
export type QuotationTrip = BookingTrip;
export type { TripScope };

/** Counts only (DEC-33: no age bands). `travellerCount` in views = the sum. */
export interface QuotationPax {
  adults: number;
  childrenWithBed: number;
  childrenNoBed: number;
  infants: number;
  paxRemarks: string | null;
}
export const PAX_LIMITS = { count: { min: 0, max: 100 }, remarks: 500 } as const;

/** What the quotation prints for the customer (B1.1 contact rules: a mobile or an e-mail). */
export interface QuotationContact {
  contactName: string;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
  /**
   * DEC-45: who the booking is for, carried into the booking on conversion.
   * Absent on a save = keep the saved value; null = not set.
   */
  bookingFor?: import('@/modules/fulfilment/contracts').BookingFor | null;
}
export const QUOTATION_CONTACT_LIMITS = { contactName: 120, email: 254, companyName: 200 } as const;

/** Narrative only (no money keys; Atlas allowlist, quotation_version_save `content`). */
export interface QuotationDay {
  /** 1..60, the day number printed. */
  day: number;
  title: string;
  text: string | null;
}
export interface QuotationContent {
  days: QuotationDay[];
  includes: string[];
  excludes: string[];
  terms: string[];
  notes: string | null;
}
export const QUOTATION_CONTENT_LIMITS = {
  days: 60,
  dayTitle: 120,
  dayText: 2000,
  listItems: 40,
  listItem: 300,
  notes: 2000,
  title: 200,
  destination: 200,
  requirementsNote: 4000,
} as const;
export const EMPTY_QUOTATION_CONTENT: QuotationContent = { days: [], includes: [], excludes: [], terms: [], notes: null };

/** Tier labels (Atlas); money per tier is Mercury's (QuotationTierMoneyView). `quoted` is required to be ready. */
export interface QuotationTierView {
  tierKey: TierKey;
  label: string | null;
}
export const TIER_LABEL_MAX = 80;

/**
 * One service on the quotation: the SAME fact keys and validation as booking
 * items, so conversion copies them. Hotel facts may carry the DEC-33 extras
 * (`extraBeds`, `childrenWithoutBed`, `bedRemarks`): counts and remarks only;
 * any charge for them is a staff-chosen money line, never multiplied.
 */
export interface QuotationItemView {
  itemId: string;
  itemNo: number;
  serviceType: ServiceType;
  /** null = offered in every tier. */
  tierKey: TierKey | null;
  service: ServiceFacts;
  /** false when the facts no longer pass validation (issue item_facts_invalid). */
  factsValid: boolean;
  /** Short line for lists ("Hotel · Goa · 10–13 Dec"). */
  title: string;
}
export const MAX_QUOTATION_ITEMS = 30;
/** Same limits and labels as the booking hotel form (fulfilment HOTEL_EXTRA_LIMITS / HOTEL_EXTRA_LABEL). */
export { HOTEL_EXTRA_LIMITS as HOTEL_EXTRAS_LIMITS, HOTEL_EXTRA_LABEL } from '@/modules/fulfilment/contracts';

// ---------------------------------------------------------------------------
// Money (Mercury): lines, tier totals, plan
// ---------------------------------------------------------------------------

export type ChargeKind = 'main' | 'extra_bed' | 'child_no_bed' | 'other';
export const CHARGE_KINDS = ['main', 'extra_bed', 'child_no_bed', 'other'] as const satisfies readonly ChargeKind[];
export const CHARGE_KIND_LABEL: Record<ChargeKind, string> = {
  main: 'Main charge',
  extra_bed: 'Extra bed',
  child_no_bed: 'Child without bed',
  other: 'Other charge',
};

export type CategoryKey = 'flights' | 'hotels' | 'transfers' | 'tours' | 'visas' | 'insurance' | 'other';
export const CATEGORY_KEYS = ['flights', 'hotels', 'transfers', 'tours', 'visas', 'insurance', 'other'] as const satisfies readonly CategoryKey[];
export const CATEGORY_LABEL: Record<CategoryKey, string> = {
  flights: 'Flights',
  hotels: 'Hotels',
  transfers: 'Transfers',
  tours: 'Tours and activities',
  visas: 'Visas',
  insurance: 'Insurance',
  other: 'Other',
};

/** DEC-33 units. */
export type UnitKind = 'room_night' | 'trip' | 'line_total' | 'night' | 'person';
export const UNIT_KINDS = ['room_night', 'trip', 'line_total', 'night', 'person'] as const satisfies readonly UnitKind[];
export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  room_night: 'Per room per night',
  trip: 'Per trip',
  line_total: 'Total for the line',
  night: 'Per night',
  person: 'Per person',
};
/** What `units` and `periods` mean for each unit (form labels). */
export const UNIT_KIND_FIELDS: Record<UnitKind, { units: string; periods: string | null }> = {
  room_night: { units: 'Rooms', periods: 'Nights' },
  trip: { units: 'Vehicles', periods: 'Trips' },
  line_total: { units: 'Quantity', periods: null },
  night: { units: 'Beds or persons', periods: 'Nights' },
  person: { units: 'Persons', periods: null },
};
export const LINE_LIMITS = { lines: 60, units: { min: 1, max: 999 }, periods: { min: 1, max: 366 }, description: 200, remark: 300 } as const;

export interface QuotationLineView {
  lineNo: number;
  optionKey: OptionKey;
  /** The quotation item this line prices; null for a charge with no fulfilment item. */
  itemId: string | null;
  /** That item's number, for display. */
  itemNo: number | null;
  chargeKind: ChargeKind;
  categoryKey: CategoryKey;
  /** Customer-facing, single line. */
  description: string;
  unitKind: UnitKind;
  units: number;
  periods: number;
  /** units × periods */
  quantity: number;
  /** Per unit, whole rupees in paise (for line_total: the line's amount). */
  unitSellPaise: PaiseString;
  /** Internal estimate per unit; null = not known yet. Never printed. */
  unitCostPaise: PaiseString | null;
  lineSellPaise: PaiseString;
  lineCostPaise: PaiseString | null;
  /** Internal note for staff; never printed. */
  remark: string | null;
}

/** Typed per tier by Sales (DEC-34). Comparison values are derived, never applied. */
export interface QuotationTierMoneyView {
  tierKey: TierKey;
  label: string | null;
  /** The customer price of the tier; null while drafting. */
  quotedTotalPaise: PaiseString | null;
  /** Adults + children with and without a bed (infants are not counted; no age bands). */
  payingTravellers: number;
  showPerPerson: boolean;
  lineCount: number;
  /** Σ selling of common + this tier's lines. */
  componentSellPaise: PaiseString;
  /** quoted − component; null without a quoted total. A non-zero value is the `component_mismatch` warning. */
  componentDifferencePaise: string | null;
  /** Σ cost of the same lines; null when any is unknown. Internal. */
  costTotalPaise: PaiseString | null;
  costComplete: boolean;
  /** quoted − cost; null when unknown. Internal; may be negative. */
  marginPaise: string | null;
  /** Printed only when exact (quoted divides by paying travellers in whole rupees); null otherwise. */
  perPersonPaise: PaiseString | null;
  /** Σ of this tier's plan; null without a plan. */
  planTotalPaise: PaiseString | null;
  planCount: number;
}

export type DueRule = 'on_acceptance' | 'days_before_start' | 'fixed_date';
export const DUE_RULES = ['on_acceptance', 'days_before_start', 'fixed_date'] as const satisfies readonly DueRule[];
export const DUE_RULE_LABEL: Record<DueRule, string> = {
  on_acceptance: 'On confirmation',
  days_before_start: 'Days before departure',
  fixed_date: 'By a fixed date',
};
export const QUOTATION_PLAN_LIMITS = { instalments: 12, label: 60, dueDays: { min: 1, max: 365 } } as const;

export interface QuotationInstalmentView {
  tierKey: TierKey;
  seq: number;
  label: string;
  amountPaise: PaiseString;
  dueRule: DueRule;
  dueDays: number | null;
  dueDate: string | null;
}

/** Commercial readers only (absent otherwise). */
export interface QuotationMoneyView {
  lines: QuotationLineView[];
  tiers: QuotationTierMoneyView[];
  plan: QuotationInstalmentView[];
  /** Money issue codes (blocking and warnings). */
  issues: QuotationMoneyIssue[];
  /** Internal cost estimates may still be refreshed (not converted yet; not hashed). */
  costRefreshAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Readiness and money issues
// ---------------------------------------------------------------------------

/** Atlas quotation issues (block mark-ready). */
export type QuotationIssueCode =
  | 'trip_missing'
  | 'pax_missing'
  | 'no_items'
  | 'item_facts_invalid'
  | 'contact_missing'
  | 'tier_missing'
  | 'valid_until_past';
export const QUOTATION_ISSUE_CODES = [
  'trip_missing',
  'pax_missing',
  'no_items',
  'item_facts_invalid',
  'contact_missing',
  'tier_missing',
  'valid_until_past',
] as const satisfies readonly QuotationIssueCode[];

/** Mercury money check: blocking codes. */
export type QuotationMoneyBlocker =
  | 'lines_missing'
  | 'quoted_total_missing'
  | 'upgrade_total_missing'
  | 'upgrade_tier_missing'
  | 'plan_total_mismatch'
  | 'plan_due_invalid'
  | 'traveller_count_missing'
  | 'unit_not_allowed'
  | 'line_tier_mismatch';
/** Mercury money check: warnings (never blocking; Atlas treats exactly these as warnings). */
export type QuotationMoneyWarning =
  | 'component_mismatch'
  | 'cost_incomplete'
  | 'margin_negative'
  | 'extra_bed_not_priced'
  | 'child_no_bed_not_priced'
  | 'per_person_not_exact';
export type QuotationMoneyIssue = QuotationMoneyBlocker | QuotationMoneyWarning;
export const QUOTATION_MONEY_BLOCKERS = [
  'lines_missing',
  'quoted_total_missing',
  'upgrade_total_missing',
  'upgrade_tier_missing',
  'plan_total_mismatch',
  'plan_due_invalid',
  'traveller_count_missing',
  'unit_not_allowed',
  'line_tier_mismatch',
] as const satisfies readonly QuotationMoneyBlocker[];
export const QUOTATION_MONEY_WARNINGS = [
  'component_mismatch',
  'cost_incomplete',
  'margin_negative',
  'extra_bed_not_priced',
  'child_no_bed_not_priced',
  'per_person_not_exact',
] as const satisfies readonly QuotationMoneyWarning[];

export type QuotationChecklistCode = QuotationIssueCode | QuotationMoneyIssue;
export const QUOTATION_CHECKLIST_CODES = [...QUOTATION_ISSUE_CODES, ...QUOTATION_MONEY_BLOCKERS, ...QUOTATION_MONEY_WARNINGS] as const;

/** Where each issue is fixed in the editor (section anchors; Luna owns the screen). */
export type QuotationSection = 'details' | 'contact' | 'services' | 'narrative' | 'money' | 'plan';
export const QUOTATION_SECTIONS = ['details', 'contact', 'services', 'narrative', 'money', 'plan'] as const satisfies readonly QuotationSection[];
export const QUOTATION_SECTION_LABEL: Record<QuotationSection, string> = {
  details: 'Trip, travellers and validity',
  contact: 'Customer contact',
  services: 'Services',
  narrative: 'Day-by-day and terms',
  money: 'Prices and totals',
  plan: 'Payment schedule',
};

export const QUOTATION_ISSUE_TEXT: Record<QuotationChecklistCode, { text: string; blocking: boolean; section: QuotationSection }> = {
  trip_missing: { text: 'Add the destination, trip type and dates.', blocking: true, section: 'details' },
  pax_missing: { text: 'Add how many travellers (at least one adult).', blocking: true, section: 'details' },
  no_items: { text: 'Add at least one service.', blocking: true, section: 'services' },
  item_facts_invalid: { text: 'A service is missing details. Open it and fill the highlighted fields.', blocking: true, section: 'services' },
  contact_missing: { text: 'Add the customer’s name and a mobile number or e-mail.', blocking: true, section: 'contact' },
  tier_missing: { text: 'Name the quoted option.', blocking: true, section: 'money' },
  valid_until_past: { text: 'The validity date has passed. Choose a new date.', blocking: true, section: 'details' },
  quoted_total_missing: { text: 'Type the final quoted total.', blocking: true, section: 'money' },
  upgrade_total_missing: { text: 'Type the upgrade option’s total, or remove the upgrade option.', blocking: true, section: 'money' },
  plan_total_mismatch: { text: 'The payment schedule must add up exactly to the quoted total.', blocking: true, section: 'plan' },
  plan_due_invalid: { text: 'A payment date is before today, or counts days before a trip start that is not set. Change it.', blocking: true, section: 'plan' },
  traveller_count_missing: { text: 'Add the number of travellers.', blocking: true, section: 'details' },
  unit_not_allowed: { text: 'A price line uses a unit that does not fit its service. Hotels are per room per night, cabs per trip, flights and visas a total for the line.', blocking: true, section: 'money' },
  lines_missing: { text: 'Add at least one price line for the quoted option.', blocking: true, section: 'money' },
  upgrade_tier_missing: { text: 'The upgrade option has prices but no name. Name it, or remove its prices.', blocking: true, section: 'money' },
  line_tier_mismatch: { text: 'A price line is in a different option than its service. Move the line or the service.', blocking: true, section: 'money' },
  // QE-08 (the item carries no amounts, so the sums are not repeated here)
  component_mismatch: { text: 'The line prices do not add up to the quoted total. Allowed: the customer sees categories without amounts.', blocking: false, section: 'money' },
  // DA-182: internal warnings (price readers only, shown with the Internal tag).
  cost_incomplete: { text: 'Some of our costs are empty.', blocking: false, section: 'money' },
  margin_negative: { text: 'Total is below our cost.', blocking: false, section: 'money' },
  extra_bed_not_priced: { text: 'A hotel has extra beds but no extra-bed charge line. Fine if the hotel includes them.', blocking: false, section: 'money' },
  child_no_bed_not_priced: { text: 'A hotel has children without a bed but no charge line for them. Fine if the hotel includes them.', blocking: false, section: 'money' },
  per_person_not_exact: { text: 'The total does not divide evenly by the travellers, so no per-person price is printed.', blocking: false, section: 'money' },
};

// ---------------------------------------------------------------------------
// Evidence (customer's written acceptance)
// ---------------------------------------------------------------------------

export type QuotationEvidenceKind = 'acceptance_message' | 'other';
export const QUOTATION_EVIDENCE_KINDS = ['acceptance_message', 'other'] as const satisfies readonly QuotationEvidenceKind[];
export const QUOTATION_EVIDENCE_KIND_LABEL: Record<QuotationEvidenceKind, string> = {
  acceptance_message: 'Customer’s written acceptance',
  other: 'Other file',
};
export type QuotationEvidenceStatus = 'pending_upload' | 'stored' | 'failed';
export const QUOTATION_EVIDENCE_STATUSES = ['pending_upload', 'stored', 'failed'] as const satisfies readonly QuotationEvidenceStatus[];
export const QUOTATION_EVIDENCE_BUCKET = 'quotation-evidence';
export const QUOTATION_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const QUOTATION_EVIDENCE_MAX_FILES = 10;

export interface QuotationEvidenceView {
  evidenceId: string;
  kind: QuotationEvidenceKind;
  fileName: string;
  mime: EvidenceMime;
  sizeLabel: string;
  status: QuotationEvidenceStatus;
  uploadedByYou: boolean;
  uploadedAt: string;
  storedAt: string | null;
  /** Audited download route; null until stored. */
  downloadHref: string | null;
}

/** /app/quotations/evidence/{evidenceId} (route file owned by the UI agent; handler quotationEvidenceDownloadResponse). */
export function quotationEvidenceHref(evidenceId: string): string {
  return `/app/quotations/evidence/${evidenceId}`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface QuotationSubjectView {
  kind: QuotationSubjectKind;
  leadId: string | null;
  dealId: string | null;
  /** Batch 3: the referral draft (TD-n) when kind is 'referral'; null otherwise. Optional for older callers. */
  referralDraftId?: string | null;
  reference: string;
  title: string;
  /** DEC-50: the quotation's branch code (e.g. JDH), for the missing-company-GSTIN warning; null when unknown. */
  branchCode: string | null;
}

/** Where a Lead quotation's accepted version can go (Deals whose stored Bitrix Lead id matches). */
export interface QuotationLinkCandidate {
  dealId: string;
  reference: string;
  title: string;
  branchName: string | null;
  sameBranch: boolean;
  /** false: lost or rejected in Bitrix. */
  active: boolean;
  /** The database's verdict: same branch, active, not linked or accepted elsewhere. */
  linkable: boolean;
}

export interface QuotationConversionView {
  dealId: string;
  bookingVersionId: string;
  convertedAt: string;
}

/** One version as the editor, preview and acceptance screens see it (quotation_get). */
export interface QuotationVersionView {
  quotationId: string;
  reference: string;
  title: string;
  subject: QuotationSubjectView;
  /** Lead quotations: the Deal Sales linked after converting in Bitrix. */
  linkedDealId: string | null;
  /** The quotation header's row version (link form). */
  quotationRowVersion: number;
  versionId: string;
  versionNo: number;
  /** Effective state: a sent version past its validity date reads `expired` before a command persists it. */
  status: QuotationStatus;
  rowVersion: number;
  /** null while draft (set when marked ready). */
  contentHash: string | null;
  basedOnVersionId: string | null;
  trip: QuotationTrip;
  pax: QuotationPax;
  /** Σ of the four counts; null when none entered. */
  travellerCount: number | null;
  requirementsNote: string | null;
  contact: QuotationContact | null;
  content: QuotationContent;
  tiers: QuotationTierView[];
  items: QuotationItemView[];
  validUntil: string | null;
  sent: { at: string; channel: SentChannel | null } | null;
  accepted: { at: string; tierKey: TierKey } | null;
  declined: { at: string; reason: DeclineReason | null } | null;
  /** Readiness (drafts): Atlas issues plus money issues; empty when ready. */
  issues: QuotationChecklistCode[];
  evidence: QuotationEvidenceView[];
  /** Commercial readers only (absent otherwise). */
  money?: QuotationMoneyView;
  conversion: QuotationConversionView | null;
  /**
   * B1.2 (0600): Bitrix values of the quotation's Lead or Deal for "Use
   * Bitrix values" (absent on a database without 0600). `unchecked` lists
   * the fields still marked from Bitrix (a warning only; never blocks mark
   * ready or send).
   */
  prefill?: import('@/modules/fulfilment/contracts').PrefillView;
  /** Derived from the database's canEdit and the state (the database decides again on every command). */
  canEdit: boolean;
  canEditMoney: boolean;
  canMarkReady: boolean;
  canSend: boolean;
  canUploadEvidence: boolean;
  canAccept: boolean;
  canDecline: boolean;
  canNewVersion: boolean;
  canDiscard: boolean;
  canLinkDeal: boolean;
  canConvert: boolean;
  /** Plain words when the next action is waiting (for example the verified Bitrix Deal). */
  nextStepText: string | null;
  /**
   * Batch 3: the referral draft behind a referral quotation (null for Lead and
   * Deal quotations; absent from older callers). While the draft is closed every
   * write is off (the database refuses draft_closed) and the page offers Reopen.
   */
  referral?: QuotationReferralView | null;
}

/** Batch 3 (atlas-batch3-shapes v2 §4.8 `referral`): the draft state a referral quotation shows. */
export interface QuotationReferralView {
  referralDraftId: string;
  /** TD-n */
  reference: string;
  status: 'open' | 'closed';
  closedReason: 'duplicate' | 'lost' | 'handled_elsewhere' | 'other' | 'no_activity' | null;
  closedAt: string | null;
  autoClose: { state: 'paused' | 'scheduled' | 'closed' | 'none'; dueOn: string | null };
  /** Any active link to a Lead or Deal. */
  linked: boolean;
  /** A quotation of the draft is bound to a Deal (or converted): links can no longer be removed. */
  bound: boolean;
  /** The draft's active Deal link: the only Deal "Start booking from this quotation" may bind to. */
  activeDealId: string | null;
  activeLeadId: string | null;
  canReopen: boolean;
  /** Fix round (Echo L5): the draft is open and nothing of it is tied to a deal yet, so its editors may link it. */
  canLink?: boolean;
  /** Fix round (Echo L7): reference of the draft's linked deal when the viewer can read it (load-screen fills it). */
  activeDealReference?: string | null;
  /** Atlas M5: owner of the draft ("You" for yourself); null when not shown to this viewer. */
  ownerName?: string | null;
  ownerIsYou?: boolean;
}

/** One row of a quotation's version list (status is effective). */
export interface QuotationVersionSummary {
  versionId: string;
  versionNo: number;
  status: QuotationStatus;
  validUntil: string | null;
  sentAt: string | null;
  acceptedTierKey: TierKey | null;
}

/** quotation_list(subject): every quotation of a Lead or Deal (a Deal also lists linked Lead quotations), newest first. */
export interface QuotationSummary {
  quotationId: string;
  reference: string;
  title: string;
  subjectKind: QuotationSubjectKind;
  leadId: string | null;
  dealId: string | null;
  /** Batch 3: the referral draft when subjectKind is 'referral'. Optional for older callers. */
  referralDraftId?: string | null;
  linkedDealId: string | null;
  acceptedVersionId: string | null;
  converted: boolean;
  bookingVersionId: string | null;
  createdAt: string;
  /** The quotation header's row version (link form). */
  rowVersion: number;
  /** Newest first. */
  versions: QuotationVersionSummary[];
  /** The version the editor opens: the working draft/ready version, else the newest. */
  currentVersionId: string;
}

export interface QuotationListView {
  subjectKind: QuotationSubjectKind;
  subjectId: string;
  quotations: QuotationSummary[];
  /** Readers are editors (freeze §2.1): a visible list means "Create quotation" is offered; the database decides. */
  canCreate: boolean;
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export interface QuotationCreateResult {
  quotationId: string;
  versionId: string;
  versionNo: number;
  reference: string;
  rowVersion: number;
  created: boolean;
  /** Batch 2 (migration A): what the creation fill did; absent on an older database. */
  autoFill?: import('@/modules/fulfilment/prefill-contract').PrefillAutoFillOutcome | undefined;
  filled?: import('@/modules/fulfilment/contracts').PrefillFieldCode[] | undefined;
  skipped?: import('@/modules/fulfilment/prefill-contract').PrefillSkip[] | undefined;
}
export interface QuotationSaveResult {
  rowVersion: number;
}
export interface QuotationItemAddResult {
  itemId: string;
  itemNo: number;
  rowVersion: number;
}
export interface QuotationMarkReadyResult {
  rowVersion: number;
  contentHash: string;
}
export interface QuotationMarkSentResult {
  validUntil: string;
  supersededVersionId: string | null;
}
export interface QuotationAcceptResult {
  quotationId: string;
  tierKey: TierKey;
  discardedVersionId: string | null;
  supersededVersionId: string | null;
}
export interface QuotationNewVersionResult {
  versionId: string;
  versionNo: number;
  rowVersion: number;
  created: boolean;
}
export interface QuotationLinkDealResult {
  quotationId: string;
  linkedDealId: string;
  rowVersion: number;
}
/** quotation_convert_to_booking: idempotent per accepted version. */
export interface QuotationConversionResult {
  dealId: string;
  bookingVersionId: string;
  outcome: 'created' | 'existing';
  itemsCreated: number;
}

export type QuotationActionResult<T = undefined> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: QuotationErrorCode | 'session' | 'upload_failed';
      message: string;
      /** Form field names to highlight (typed values are kept). */
      fields?: string[];
      /** not_ready: what still blocks. */
      issues?: QuotationChecklistCode[];
    };

// ---------------------------------------------------------------------------
// Refusal tokens and plain wording
// ---------------------------------------------------------------------------

export type QuotationErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'invalid_input'
  | 'version_changed'
  | 'request_conflict'
  | 'wrong_state'
  | 'not_ready'
  | 'valid_until_past'
  | 'service_on_hold'
  | 'quotation_already_accepted'
  | 'version_superseded'
  | 'quotation_expired'
  | 'acceptance_proof_required'
  | 'quotation_converted'
  | 'deal_not_from_lead'
  | 'deal_already_linked'
  | 'quotation_already_linked'
  | 'branch_mismatch'
  | 'deal_link_required'
  | 'draft_not_empty'
  | 'already_confirmed'
  | 'service_items_disabled'
  | 'deal_not_active'
  | 'deal_removed'
  | 'evidence_rejected'
  | 'internal_wording'
  // B1.2 Bitrix prefill (0600)
  | 'prefill_unavailable'
  // Batch 3 referral drafts (20261123000100, atlas-batch3-shapes §1)
  | 'referral_drafts_disabled'
  | 'draft_closed'
  | 'draft_not_closed'
  | 'draft_already_linked'
  | 'link_locked'
  | 'deal_not_linked_to_draft'
  | 'settings_busy';

export const QUOTATION_ERROR_TEXT: Record<QuotationErrorCode | 'session' | 'upload_failed', string> = {
  not_authorized: 'Only the Lead or Deal owner, an assigned salesperson or the branch Manager can do this.',
  not_found: 'This quotation is not available to you. It may not exist, or you may not have access.',
  invalid_input: 'Some details are missing or not valid. Check the highlighted fields.',
  version_changed: 'Not saved. Someone changed this quotation after you opened it. Your typed values are still on screen; reload to see the latest version.',
  request_conflict: 'This form was already submitted with different details. Reload the page and try again.',
  wrong_state: 'This is no longer possible for this version (it may have been sent already: make a new version for any change). Reload the page.',
  not_ready: 'Not ready to send yet. Fix the items listed.',
  valid_until_past: 'The validity date has passed. Choose a date from today on.',
  service_on_hold: 'Train bookings are deferred and can’t be added. Nothing was added.',
  quotation_already_accepted: 'A quotation for this Deal is already accepted. Only one can be accepted.',
  // QS-17
  version_superseded: 'A newer version was shared, so this one can’t be accepted. Open the newer version.',
  quotation_expired: 'This version’s validity date has passed. Make a new version with a new date.',
  acceptance_proof_required: 'Upload the customer’s written acceptance of this exact version first.',
  quotation_converted: 'This quotation was already turned into a booking. Change the booking instead (a revision).',
  deal_not_from_lead: 'That Deal did not come from this Lead in Bitrix. Pick the Deal Sales converted from this Lead.',
  deal_already_linked: 'This Deal already has an accepted quotation. Nothing was changed.',
  quotation_already_linked: 'This quotation is already linked to a different Deal; links never change. Nothing was changed.',
  branch_mismatch: 'That Deal belongs to another branch. Ask the branch Manager.',
  deal_link_required: 'Waiting for the Deal: convert the Lead into a Deal in Bitrix, then link it here.',
  draft_not_empty: 'This Deal already has a booking draft with details. Finish or discard that draft first; nothing was copied.',
  already_confirmed: 'This Deal’s booking is already submitted. Nothing was copied.',
  service_items_disabled: 'Booking is switched off for this CRM. An admin can switch it on. Nothing was changed.',
  deal_not_active: 'This Deal is marked lost or rejected in Bitrix. Nothing was changed.',
  deal_removed: 'This Deal was removed from the CRM by the Bitrix sync. Nothing was changed.',
  evidence_rejected: 'File not accepted: PDF, JPG, PNG or WebP up to 4 MB, at most 10 files per version.',
  internal_wording: 'Customer text contains internal words (for example net rate or margin). Reword it; nothing was saved.',
  prefill_unavailable: 'Bitrix values are not available for this Lead or Deal right now. Type the details instead. Nothing was changed.',
  // Batch 3: provisional plain words (copy DA-65, DA-69, DA-70, DA-75, DA-78); Mercury confirms.
  referral_drafts_disabled: 'Referral drafts are switched off, so no new draft was made. Existing drafts keep working.',
  draft_closed: 'This draft is closed. Reopen it to make changes. Nothing was saved.',
  draft_not_closed: 'This draft is already open. Nothing was changed.',
  draft_already_linked: 'This draft is already linked. Remove the wrong link first.',
  link_locked: 'This link cannot be removed: a quotation from this draft is already tied to that deal for booking. Nothing was changed.',
  deal_not_linked_to_draft: 'Link this draft to the confirmed deal first.',
  settings_busy: 'The workflow switches are busy right now. Nothing was changed. Try again in a minute.',
  session: 'Your session has ended. Sign in again; your typed values are still on screen.',
  upload_failed: 'The file was not stored and does not count. Remove it if it is listed, then upload it again.',
};

/** SQLSTATE per token (Atlas shapes note). A token maps only when message AND state match (fail closed). */
export const QUOTATION_ERROR_STATES: Record<QuotationErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  invalid_input: '22023',
  version_changed: '40001',
  request_conflict: '40001',
  wrong_state: '55000',
  not_ready: '55000',
  valid_until_past: '22023',
  service_on_hold: '55000',
  quotation_already_accepted: '55000',
  version_superseded: '55000',
  quotation_expired: '55000',
  acceptance_proof_required: '55000',
  quotation_converted: '55000',
  deal_not_from_lead: '22023',
  deal_already_linked: '55000',
  quotation_already_linked: '55000',
  branch_mismatch: '22023',
  deal_link_required: '55000',
  draft_not_empty: '55000',
  already_confirmed: '55000',
  service_items_disabled: '55000',
  deal_not_active: '55000',
  deal_removed: '55000',
  evidence_rejected: '22023',
  internal_wording: '22023',
  prefill_unavailable: '55000',
  referral_drafts_disabled: '55000',
  draft_closed: '55000',
  draft_not_closed: '55000',
  draft_already_linked: '55000',
  link_locked: '55000',
  deal_not_linked_to_draft: '55000',
  settings_busy: '55P03',
};

export const QUOTATION_TEXT = {
  notAvailable: 'Quotations are not available to you here. They may not exist, or you may not have access.',
  notInstalled: 'Quotations are not available on this CRM yet.',
  gstLine: 'GST as applicable',
  notTaxInvoice: 'Quotation — not a tax invoice',
  created: 'Quotation started. Nothing has been sent or booked.',
  saved: 'Saved. Nothing has been sent or booked.',
  itemAdded: 'Service added. Nothing has been booked.',
  itemRemoved: 'Service removed.',
  // DA-183 / DA-188
  markedReady: 'Marked ready to share.',
  markedSent: 'Marked as shared. To change anything, make a new version.',
  // QS-07
  accepted: 'Marked accepted. Nothing is booked yet.',
  declined: 'Marked declined.',
  newVersion: 'New version opened as a draft. The earlier versions stay in history.',
  existingVersion: 'This quotation already has a working version; opening it.',
  discarded: 'Draft discarded. Earlier versions stay in history.',
  linked: 'Linked to the Deal. You can now start the booking from this quotation.',
  converted: 'Booking draft started from this quotation. Check every step, add the travellers’ names, and submit when ready.',
  convertedExisting: 'This quotation was already turned into a booking draft; opening it.',
  evidenceUploaded: 'File uploaded.',
  evidenceRemoved: 'File removed.',
  // Q-09
  waitingForDeal: 'Waiting for the deal. Convert the lead to a deal in Bitrix; it will appear here to link.',
  // Batch 3 referral quotations (DA-70; provisional words, Mercury confirms).
  waitingForDraftLink: 'Booking waits for the confirmed Bitrix deal: link this referral draft to the deal first.',
  referralDraftClosed: 'This referral draft is closed. Reopen it to make changes.',
  /** Step 1 (bind) worked, step 2 (start booking) was refused: honest partial report; {reason} is the refusal text. */
  boundNotBooked: 'This quotation is now tied to the linked deal. The booking was not started. {reason}',
  mismatchWarning: 'Your components add up to {components}; the quoted total is {total} ({difference} {direction}).',
  perPersonNotExact: 'No per-person price is printed: {total} does not divide evenly by {count} travellers. Nearest exact totals: {below} or {above}.',
  totalForTravellers: '{total} for {count} travellers',
} as const;
