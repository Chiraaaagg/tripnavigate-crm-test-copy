import type { ViewerRelation } from '@/modules/deals/dto';
import type { PaymentClaimDisplayStatus, ReceiptMode } from '@/modules/finance/contracts';
import type { AccountsReviewStatus, ChangeClass, EvidenceKind } from '@/modules/fulfilment/contracts';

/*
 * Batch 1 frozen contract (Direction A, R1 lists + R2 Deal workspace): the view
 * models that the routes (Terra, application integration) hand to the screens
 * (Luna, UI). Types only: no values, no functions, no React nodes.
 *
 * Rules for every type in this file:
 *   - Plain serializable data (strings, numbers, booleans, arrays, plain
 *     objects). No Date, Map, function or ReactNode, so a view model may be
 *     passed to a client component without carrying anything hidden.
 *   - Built on the server from reads that the database already filters
 *     (docs/implementation/frontend-redesign-2026-10-15/batch-1-backend-contract.md §2, §3).
 *     A view model never carries a field the screen does not display.
 *   - Money appears ONLY in DealMoneyVM. DealMoneyVM is absent (the key is left
 *     out, never null) for every viewer whose deal DTO says commercialAbsence
 *     'withheld' (Purchase, Flight, Visa, Sales without price access):
 *     money-privacy-settings.md P5, P6, P12; feature-parity FP-020, FP-026.
 *   - Amounts are display strings already formatted on the server from whole
 *     paise (formatPaise); the browser never does money arithmetic.
 *   - Wording comes from copy-catalogue.md §16 (DA-xx ids cited per type).
 *     Unknown is never shown as zero, empty or Off.
 *
 * Code map and parity cases: Terra's Batch 1 notes. Decisions: plan.md §12a,
 * §12b (DEC-52 owner names), lead decisions of 19 October 2026.
 */

// ---------------------------------------------------------------------------
// Tabs (server-rendered link tabs; Echo E23)
// ---------------------------------------------------------------------------

/**
 * Deal record tabs, in display order (DA-10): Overview · Services and tasks ·
 * Quotations · Documents · Money · History, as `?tab=overview|services|
 * quotations|documents|money|history`. Parsed on the server against this list;
 * an unknown value or a tab the viewer may not open renders Overview. The tab
 * never decides authorization.
 */
export type DealTab = 'overview' | 'services' | 'quotations' | 'documents' | 'money' | 'history';

/** Lead record tabs (DA-11): Overview · Quotations · Bitrix details, as `?tab=overview|quotations|bitrix`. */
export type LeadTab = 'overview' | 'quotations' | 'bitrix';

/**
 * One link tab. Only tabs the viewer may open are listed: Money only with a
 * DealMoneyVM, Quotations only when the quotation or itinerary list is
 * readable, Documents only when the combined read (B1-2) is installed.
 * Deliberately no count field: tabs never show counts (money-privacy P6).
 */
export interface TabItemVM<T extends string> {
  tab: T;
  /** Label exactly as DA-10 / DA-11. */
  label: string;
  /** Same page with `?tab=`; Overview links without the parameter. */
  href: string;
  /** Sets aria-current="page". */
  current: boolean;
}

// ---------------------------------------------------------------------------
// Shared small view models
// ---------------------------------------------------------------------------

/**
 * A Bitrix stage, status or source shown by name (B1-1 name map, switch
 * `bitrix_name_read`, Off by default). DA-90 to DA-93: `name` only when
 * `labelState` is 'named'; otherwise the screen says "Stage / Status / Source
 * not recognised (code in details)" and the reason goes to Details.
 */
export interface BitrixNameVM {
  /** Raw Bitrix code; shown in Details only ("Bitrix code: {code}"). */
  code: string;
  /** Bitrix's own name, never renamed by the CRM; null unless labelState is 'named'. */
  name: string | null;
  /** DA-90 named · DA-91 not_in_list · DA-92 list_unreadable · DA-93 switched_off. */
  labelState: 'named' | 'not_in_list' | 'list_unreadable' | 'switched_off';
  /** B1-1: code marked missing_since; shows the last known name plus "No longer in the Bitrix list". */
  noLongerInList?: boolean;
}

/**
 * Owner of a Lead or Deal, for lists and record headers (copy L-04, DL-03, D-15).
 * - 'you': "You".
 * - 'colleague': `displayName` when record_staff_names (B1-4, DEC-52) returns
 *   it, else "Another staff member". Only the record OWNER's name is approved
 *   (DEC-52); other assigned colleagues keep today's wording.
 * - 'waiting': status "Waiting for owner" (word with icon, never a name).
 */
export interface RecordOwnerVM {
  kind: 'you' | 'colleague' | 'waiting';
  /** Owner display name only (never contact details); present only for 'colleague' when B1-4 returned it. */
  displayName?: string;
}

/** "Came from Lead {ref}" / "From lead {ref}" (D-05). Present only when the viewer may read the Lead (never Purchase). */
export interface LeadLinkVM {
  href: string;
  reference: string;
}

// ---------------------------------------------------------------------------
// Lists (LE-01, DE-01)
// ---------------------------------------------------------------------------

/** Leads list filter chips in Batch 1 (lead decision 5): server filters with exact counts. */
export type LeadListFilter = 'all' | 'mine';

/** Deals list filter chips in Batch 1 (batch-1-backend-contract §3): All = countVisibleDeals; owned and assigned are disjoint. */
export type DealListFilter = 'all' | 'owned' | 'assigned';

/**
 * One filter chip. The count is exact over every record the viewer can see
 * (not this page); null when the count could not be read (never shown as 0).
 * Labels and scope wording per batch-1-backend-contract §3, e.g. "All deals
 * you can see ({n})", "Owned by you ({n})", "Assigned to you, owned by someone
 * else ({n})", "Yours: {n} of the {N} leads you can see".
 */
export interface ListFilterVM<F extends string = string> {
  filter: F;
  label: string;
  count: number | null;
  /** List address with this filter (page reset to 1; `?sort` kept on Deals). */
  href: string;
  current: boolean;
}

/** The chip row plus one line naming what the counts cover (handoff §2: counts name their scope). */
export interface ListFiltersVM<F extends string = string> {
  chips: ListFilterVM<F>[];
  /** e.g. "Counts cover all deals you can see, not just this page." */
  scopeText: string;
}

/**
 * List-level Bitrix freshness line (DA-45), derived from the rows shown
 * (lead decision 2): the oldest last-verified time on the page.
 * 'unknown' = "Bitrix update time not known" (no Bitrix rows, or a missing
 * value). Row badges ("Not updated from Bitrix for over a day") stay per row.
 * Separate from the live-update indicator (DA-46), which never claims freshness.
 */
export type ListFreshnessVM =
  | { state: 'known'; /** ISO time; the screen shows "Bitrix data updated {time} ago". */ oldestCheckedAt: string; /** At least one row on the page is late. */ anyLate: boolean }
  | { state: 'unknown' };

/** "1–25 of N" pager (P-LIST, DL-07, DL-08). Hrefs keep the filter and order. */
export interface ListPagerVM {
  /** 1-based index of the first row shown; 0 when the page is empty. */
  from: number;
  to: number;
  /** Exact total for the current filter; null when it could not be counted. */
  total: number | null;
  previousHref: string | null;
  nextHref: string | null;
}

// ---------------------------------------------------------------------------
// Deal record (DE-02)
// ---------------------------------------------------------------------------

/**
 * Booking state of the Deal, one per row of DA-20 to DA-31. Derived on the
 * server from today's reads (getVisibleDeal, loadBookNow, loadBookingForDeal,
 * loadDealServices, loadQuotationsForDeal); never a new read.
 */
export type DealBookingState =
  | 'not_started' // DA-20, DA-21
  | 'quotation_accepted' // DA-22
  | 'in_progress' // DA-23
  | 'ready_to_submit' // DA-24
  | 'waiting_for_accounts' // DA-25
  | 'returned' // DA-26
  | 'being_arranged' // DA-27
  | 'all_confirmed' // DA-28
  | 'lost' // DA-29
  | 'hotel_legacy' // DA-30 (older B1 hotel version; the legacy panel keeps its own status)
  | 'could_not_load' // DA-31 (never shown as "Not started")
  // Amended 19 Oct (lead): viewers without the Book now view (Purchase, Flight, Visa desk, Accounts)
  // get only a status their own reads prove.
  | 'own_task' // DA-44 word of the viewer's own assigned task
  | 'submitted'; // a confirmed version is readable, nothing more provable ("Booking submitted")

/**
 * Status word shown with an icon, never by colour alone (DA-40, G-15).
 * 'Hotel booking' for DA-30 is the one word not in DA-40 ("as today").
 */
export type DealStatusWord =
  | 'Not started'
  | 'Quotation accepted'
  | 'Booking in progress'
  | 'Ready to submit'
  | 'Waiting for Accounts'
  | 'Returned by Accounts'
  | 'Being arranged'
  | 'All services confirmed'
  | 'Lost in Bitrix'
  | 'Hotel booking'
  | 'Could not load'
  // Amended 19 Oct (lead): DA-44 department task words, and "Booking submitted" (Mercury to confirm).
  | 'Waiting to be taken'
  | 'In progress'
  | 'Confirmed by supplier'
  | 'Completed'
  | 'Waiting for the Visa desk to start'
  | 'Booking submitted';

export interface DealStatusVM {
  state: DealBookingState;
  word: DealStatusWord;
}

/**
 * The one primary action in the Deal header (copy §16.3, FP-022). null in the
 * header VM = no primary button; the Next line then names who acts (DA-21,
 * DA-31, DA-29 without a booking).
 * - 'start_booking' has no href: the route renders the existing Start booking
 *   server-action form (StartBookNowForm) as the primary button.
 * - 'start_from_quotation' links to the quotation page, where the existing
 *   conversion lives (lead decision 4); no new action on the Deal page.
 * - 'see_team_tasks' links to `?tab=services`.
 */
export type DealPrimaryAction =
  | { kind: 'start_booking'; label: 'Start booking' } // DA-20
  | { kind: 'start_from_quotation'; label: 'Start booking from quotation'; href: string; quotationReference: string } // DA-22
  | { kind: 'continue_booking'; label: 'Continue booking'; href: string } // DA-23
  | { kind: 'review_and_submit'; label: 'Review and submit'; href: string } // DA-24
  | { kind: 'view_booking'; label: 'View booking'; href: string } // DA-25, DA-28, DA-29
  | { kind: 'fix_and_send_again'; label: 'Fix and send again'; href: string } // DA-26
  | { kind: 'see_team_tasks'; label: 'See team tasks'; href: string } // DA-27
  | { kind: 'open_hotel_booking'; label: 'Open hotel booking'; href: string }; // DA-30

/** "Next: …" line under the title (copy §16.3 "Next:" column). Plain text; `actor` "You" when the viewer acts. */
export interface DealNextVM {
  text: string;
  actor?: string;
}

/**
 * Accounts return notice under the title (DA-26). `reason` only when Sales may
 * read it (returns recorded since the B1.1 revision release; reasonHidden
 * otherwise). Money-free.
 */
export interface DealReturnNoticeVM {
  reviewedAt: string | null;
  reason: string | null;
  reasonHidden: boolean;
}

/** Record header (P-HEADER, G9; FP-019). No money. */
export interface DealHeaderVM {
  dealId: string;
  reference: string;
  /** Customer and trip (the Bitrix title). */
  title: string;
  /** Amended 19 Oct: absent = no status word is provable for this viewer; the Next line then says "See Services and tasks". */
  status?: DealStatusVM;
  /** Bitrix stage (D-01); undefined for a CRM-native or synthetic record. */
  stage?: BitrixNameVM;
  owner: RecordOwnerVM;
  leadLink?: LeadLinkVM;
  next: DealNextVM;
  primary: DealPrimaryAction | null;
  /** DA-20 chip "Waiting for Won - Payment Received" when the Bitrix stage is not the Won stage. */
  waitsForWon: boolean;
  /** D-02 / D-20 "Not updated from Bitrix for over a day" (only when late). */
  bitrixLate: boolean;
  /** D-03 "Test record" (no Bitrix source). */
  testRecord: boolean;
  /** D-10 / DA-29: lost or rejected in Bitrix; work is read-only. */
  lostInBitrix: boolean;
  returnNotice?: DealReturnNoticeVM;
  /** D-04 "Services: {done} of {total} confirmed"; undefined when services did not load or none exist. */
  servicesProgressText?: string;
}

/** Bitrix details disclosure inside Overview (FP-021, D-19). */
export interface DealBitrixDetailsVM {
  sourceDealId: string;
  stage: BitrixNameVM;
  /** "Last checked with Bitrix" (ISO). */
  lastCheckedAt: string;
  /** "Last change received" (ISO). */
  lastChangeAt: string;
  late: boolean;
}

/** One active assignment (D-15). Kind words only; colleagues' names are not approved (DEC-52 covers the owner only). */
export interface DealTeamMemberVM {
  /** Assignment kind as a word, e.g. "Sales", "Purchase". */
  kindLabel: string;
  isYou: boolean;
}

/**
 * Overview tab (FP-020 without money, D-14, D-15). Never carries money:
 * the prototype's "Selling price" row in Overview is not adopted.
 */
export interface DealOverviewVM {
  branchName: string;
  createdOn: string;
  /** "Why you can see this deal" in Details (D-14, DL-03). */
  relation: ViewerRelation;
  team: DealTeamMemberVM[];
  /** Destination and dates from deal_services.trip, as one line; null when not known. */
  tripText: string | null;
  /** Traveller count line; null when not known or not shown to this role. */
  travellersText: string | null;
  /** Undefined for a CRM-native or synthetic record. */
  bitrix?: DealBitrixDetailsVM;
}

/** Deal value from the deal record (D-16): "Deal value (from the deal record)" with "Not the booking total." */
export type DealValueVM =
  | { state: 'shown'; sellingTotal: string; estimatedMargin: string }
  | { state: 'not_recorded' };

export interface DealPlanInstalmentVM {
  label: string;
  amount: string;
  /** ISO date or null when not entered. */
  dueDate: string | null;
}

/** One of the viewer's own reported payments (DA-48). Never receipt numbers, cheque numbers, Accounts names or company accounts. */
export interface DealOwnClaimVM {
  claimId: string;
  amount: string;
  paidOn: string;
  mode: ReceiptMode;
  status: PaymentClaimDisplayStatus;
}

/**
 * Sales claims summary (book-claims.tsx today; DA-48): "Reported, not checked
 * (not money)", "Checked by Accounts", "Still to pay (based on checked money)".
 * Copied from copySalesClaims without `destinations`, `canReport` or `reportBlock`.
 */
export interface DealClaimsSummaryVM {
  reported: string;
  confirmed: string;
  /** null when no final selling total exists yet. */
  balance: string | null;
  own: DealOwnClaimVM[];
}

/** Selling total of one booking version, for price readers only (from booking_version_history). */
export interface DealVersionTotalVM {
  versionNo: number;
  sellingTotal: string | null;
  sellingTotalDelta: string | null;
}

/**
 * Money tab (FP-020, FP-026; money-privacy P6). The ONLY view model with money.
 * Present only when the viewer may read this Deal's prices
 * (commercialAbsence !== 'withheld'); otherwise the key is left out and the
 * tab is not listed. Exactly today's Sales figures: no receipt list, cheque
 * amounts or states, company accounts or other Accounts-page figures; Accounts
 * work stays on the Accounts deal page (T1).
 */
export interface DealMoneyVM {
  dealValue: DealValueVM;
  /** From the booking (BookNowView.commercials / plan); undefined when the viewer has no booking view. */
  booking?: {
    /** "Final selling total"; null = not entered. */
    finalSellingTotal: string | null;
    /** "Payment plan"; null = not entered. */
    plan: DealPlanInstalmentVM[] | null;
  };
  /** Only when deal_payment_claims returned the viewer's claims (owner and Sales assignees with price access). */
  claims?: DealClaimsSummaryVM;
  /** Per-version selling totals (the money part of History, kept here so History stays money-free). */
  versionTotals?: DealVersionTotalVM[];
}

/**
 * One History event (FP-027; screen plan §3 "History rule"). Every event comes
 * from a read the database already filters by role. No amounts in any event.
 * 'payment_reported' events are built only when the viewer also has a
 * DealMoneyVM with claims.
 */
export type DealHistoryEventVM =
  | {
      kind: 'booking_version';
      id: string;
      /** ISO; null when the version has no confirmed time. */
      at: string | null;
      versionNo: number;
      /** e.g. "Submitted", "Draft", "Replaced", "Discarded". */
      statusText: string;
      changeClass: ChangeClass | null;
    }
  | {
      kind: 'accounts_review';
      id: string;
      /** Not in booking_version_history today: shown against its version without a time. */
      at: null;
      versionNo: number;
      reviewStatus: AccountsReviewStatus;
      /** Only when shared with Sales (reasonHidden false). */
      reason: string | null;
      reasonHidden: boolean;
    }
  | {
      kind: 'quotation_version';
      id: string;
      at: string | null;
      quotationReference: string;
      versionNo: number;
      /** DA-41 word, e.g. "Shared with customer", "Accepted". */
      statusText: string;
      href: string;
    }
  | {
      kind: 'payment_reported';
      id: string;
      at: string;
      /** DA-48 status word only; no amount. */
      status: PaymentClaimDisplayStatus;
    };

/**
 * History tab. 'ok' with no events shows one honest empty line ("No history
 * you can see yet. Money and acceptance events are shown only to roles with
 * price access."); 'error' shows the shared could-not-load line, never empty.
 */
export type DealHistoryVM = { state: 'ok'; events: DealHistoryEventVM[] } | { state: 'error' };

/**
 * Documents tab rows: the deal_documents_list (B1-2) row shape, one variant
 * per kind with exactly its context keys. Only files the viewer may open; the
 * application adds `href` built from kind and id to the existing download
 * route (no storage URL). Never object paths, uploader identities, hashes or
 * amounts. Customer payment proof (finance_evidence) is never listed here.
 */
interface DealDocumentRowBase {
  id: string;
  fileName: string;
  mime: string;
  uploadedAt: string;
  /** Existing route: /app/id-proofs, /app/bookings/evidence, /app/quotations/evidence, /app/itineraries/sources|rendered, /app/purchase/files, /app/department/evidence. */
  href: string;
}

export type DealDocumentRow =
  | (DealDocumentRowBase & { kind: 'id_proof'; context: { travellerSeq: number } })
  | (DealDocumentRowBase & { kind: 'booking_file'; context: { versionNo: number | null; evidenceKind: EvidenceKind } }) // amended 19 Oct: versionNo may be null (B1-2 read)
  | (DealDocumentRowBase & { kind: 'quotation_acceptance'; context: { quotationReference: string; versionNo: number | null; evidenceKind: 'acceptance_message' | 'other' } }) // amended 19 Oct (Echo M3: truthful label)
  | (DealDocumentRowBase & { kind: 'itinerary_source'; context: { documentId: string } })
  | (DealDocumentRowBase & { kind: 'itinerary_pdf'; context: { pdfKind: string; documentId: string } })
  | (DealDocumentRowBase & { kind: 'purchase_file'; context: { department: 'purchase'; fileKind: string } })
  | (DealDocumentRowBase & { kind: 'department_file'; context: { department: string; fileKind: string } });

export type DealDocumentKind = DealDocumentRow['kind'];

/**
 * Documents tab (FP-025). The tab is not listed at all when the read is not
 * installed (lead decision 3: hidden until B1-2 lands; never partial).
 * 'error' = "Documents could not be loaded. Nothing was changed." (never "No documents").
 */
export type DealDocumentsVM = { state: 'ok'; rows: DealDocumentRow[] } | { state: 'error' };

/**
 * Whole Deal workspace. Services and tasks and Quotations tab bodies are the
 * existing server-rendered cards placed by the route (not view models here).
 * Only the current tab's body is rendered; other tab models are left out.
 */
export interface DealWorkspaceVM {
  header: DealHeaderVM;
  tabs: TabItemVM<DealTab>[];
  current: DealTab;
  overview?: DealOverviewVM;
  /** Present only for price readers AND only when current is 'money'. */
  money?: DealMoneyVM;
  history?: DealHistoryVM;
  documents?: DealDocumentsVM;
}

// ---------------------------------------------------------------------------
// Lead record (LE-02)
// ---------------------------------------------------------------------------

/** Lead header (P-HEADER; FP-014, FP-015; copy L-11, L-13). No money, no contact fields. */
export interface LeadHeaderVM {
  leadId: string;
  reference: string;
  /** Customer and trip (the Bitrix title). */
  title: string;
  status: BitrixNameVM;
  owner: RecordOwnerVM;
  branchName: string;
  /** L-13 warning near the title, only when late. */
  bitrixLate: boolean;
  /** L-11 "Next: follow up in Bitrix · {owner}". */
  next: DealNextVM;
  /** Primary "New quotation": only when the quotation list is readable and creation is allowed (Sales owner, branch Manager; never Super Admin). */
  canCreateQuotation: boolean;
}

/** Bitrix details tab (L-12, L-15 to L-17). */
export interface LeadBitrixDetailsVM {
  sourceLeadId: string;
  status: BitrixNameVM;
  source: BitrixNameVM;
  /** ISO "Created in Bitrix". */
  createdInBitrixAt: string;
  /** "Last checked with Bitrix" (ISO). */
  lastCheckedAt: string;
  /** "Last change received from Bitrix" (ISO). */
  lastChangeAt: string;
  /** "You see this lead because: …" (L-04). */
  relation: 'owner' | 'branch_manager' | 'integration_admin';
}

export interface LeadWorkspaceVM {
  header: LeadHeaderVM;
  tabs: TabItemVM<LeadTab>[];
  current: LeadTab;
  /** Overview key facts: source, created, branch, owner (same data as the header and details). */
  overview?: { source: BitrixNameVM; createdInBitrixAt: string; branchName: string; owner: RecordOwnerVM };
  bitrix?: LeadBitrixDetailsVM;
}
