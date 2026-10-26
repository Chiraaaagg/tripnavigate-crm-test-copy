import { type DealDetail, formatPaise } from '@/modules/deals/dto';
import { BITRIX_NAMES_OFF, type BitrixNameLookup, bitrixName, dealRowOwner, dealStageEntity } from '@/modules/deals/list-model';
import type { BookNowView, DealServicesView, ServiceDepartment } from '@/modules/fulfilment/contracts';
import type { QuotationListView, QuotationStatus, QuotationSummary } from '@/modules/quotations/contracts';
import type {
  DealBookingState,
  DealDocumentRow,
  DealDocumentsVM,
  DealHeaderVM,
  DealHistoryEventVM,
  DealHistoryVM,
  DealMoneyVM,
  DealNextVM,
  DealOverviewVM,
  DealPrimaryAction,
  DealStatusVM,
  DealStatusWord,
  DealTab,
  DealWorkspaceVM,
  LeadLinkVM,
  TabItemVM,
} from '@/modules/deals/workspace-contract';

/*
 * Batch 1 Deal workspace (DE-02): pure view-model builders for the route
 * `src/app/app/deals/[id]/page.tsx`. Every input is a read the route already
 * made under the viewer's own session (the database filtered it); these
 * functions only choose and copy fields. No I/O, no React.
 *
 * Privacy rules enforced here (money-privacy-settings.md §2 P5, P6, P12;
 * workspace-contract.ts):
 *   - Money appears only in DealMoneyVM, which is built only for viewers whose
 *     deal DTO does not say commercialAbsence 'withheld'. Header, Overview and
 *     History never carry an amount.
 *   - The Money tab is not listed for a withheld viewer, and `?tab=money` from
 *     that viewer parses to Overview.
 *   - 'payment_reported' History events are built only when the viewer also
 *     reads claims (and then without amounts).
 *   - The Lead link is passed through from loadDealLeadLink, which refuses
 *     Purchase before any query; it is never derived here.
 */

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Display order and labels (DA-10). */
export const DEAL_TABS = ['overview', 'services', 'quotations', 'documents', 'money', 'history'] as const satisfies readonly DealTab[];

export const DEAL_TAB_LABEL: Record<DealTab, string> = {
  overview: 'Overview',
  services: 'Services and tasks',
  quotations: 'Quotations',
  documents: 'Documents',
  money: 'Money',
  history: 'History',
};

/** True when the viewer may read this Deal's prices (the DTO already applied the commercial policy). */
export function canSeeDealMoney(deal: Pick<DealDetail, 'commercialAbsence'>): boolean {
  return deal.commercialAbsence !== 'withheld';
}

export interface DealTabAccess {
  /** canSeeDealMoney(deal). */
  money: boolean;
  /** The quotation list or the itinerary list was readable (non-null) for this viewer. */
  quotations: boolean;
  /** The combined documents read (B1-2) is installed for this page (lead decision 3: hidden until then). */
  documents: boolean;
}

/** Tabs this viewer may open, in DA-10 order. Overview, Services and tasks and History are always listed. */
export function visibleDealTabs(access: DealTabAccess): DealTab[] {
  return DEAL_TABS.filter((tab) => {
    if (tab === 'money') return access.money;
    if (tab === 'quotations') return access.quotations;
    if (tab === 'documents') return access.documents;
    return true;
  });
}

/**
 * `?tab=` parsed against the server allowlist. Unknown values, repeated
 * parameters and tabs the viewer may not open all render Overview (the tab
 * never decides authorization and never reveals that a hidden tab exists).
 */
export function parseDealTab(raw: unknown, visible: readonly DealTab[] = DEAL_TABS): DealTab {
  if (typeof raw !== 'string') return 'overview';
  const tab = (DEAL_TABS as readonly string[]).includes(raw) ? (raw as DealTab) : null;
  return tab && visible.includes(tab) ? tab : 'overview';
}

export function dealHref(dealId: string, tab: DealTab = 'overview'): string {
  return tab === 'overview' ? `/app/deals/${dealId}` : `/app/deals/${dealId}?tab=${tab}`;
}

export function dealTabItems(dealId: string, visible: readonly DealTab[], current: DealTab): TabItemVM<DealTab>[] {
  return visible.map((tab) => ({ tab, label: DEAL_TAB_LABEL[tab], href: dealHref(dealId, tab), current: tab === current }));
}

// ---------------------------------------------------------------------------
// Booking state, status word, primary action (copy §16.3, DA-20 to DA-31)
// ---------------------------------------------------------------------------

/**
 * The booking reads of the page, as the route received them:
 *   - book: loadBookNow. 'failed' = the read threw; 'none' = null (not an
 *     editor or acceptor) or not installed; 'ok' = the view.
 *   - legacyBooking: loadBookingForDeal (B1 hotel panel). `exists` = a panel view came back.
 *   - services: loadDealServices.
 *   - quotations: loadQuotationsForDeal (null when not readable or failed).
 */
export interface DealBookingInput {
  dealId: string;
  book: { state: 'failed' } | { state: 'none' } | { state: 'ok'; view: BookNowView };
  legacyBooking: { ok: false } | { ok: true; exists: boolean };
  services: { ok: false } | { ok: true; view: DealServicesView | null };
  quotations: QuotationListView | null;
}

/** Status word per state; 'own_task' takes its word from the viewer's task (DA-44, ownTaskWord). */
export const DEAL_STATUS_WORD: Record<Exclude<DealBookingState, 'own_task'>, DealStatusWord> = {
  not_started: 'Not started',
  quotation_accepted: 'Quotation accepted',
  in_progress: 'Booking in progress',
  ready_to_submit: 'Ready to submit',
  waiting_for_accounts: 'Waiting for Accounts',
  returned: 'Returned by Accounts',
  being_arranged: 'Being arranged',
  all_confirmed: 'All services confirmed',
  lost: 'Lost in Bitrix',
  hotel_legacy: 'Hotel booking',
  could_not_load: 'Could not load',
  submitted: 'Booking submitted',
};

export function dealStatusWord(state: Exclude<DealBookingState, 'own_task'>): DealStatusWord {
  return DEAL_STATUS_WORD[state];
}

type ReadableItem = DealServicesView['items'][number];

/** The viewer's own assigned, not-cancelled tasks among the rows the services read returned. */
function ownTaskItems(services: DealServicesView | null): ReadableItem[] {
  return (services?.items ?? []).filter((i) => i.state !== 'cancelled' && i.task?.assignedToYou === true);
}

const TASK_RANK = { not_started: 0, in_progress: 1, supplier_confirmed: 2, completed: 2 } as const;

/** DA-44 word of one task. */
function taskWord(item: ReadableItem): DealStatusWord {
  const status = item.task!.status;
  if (status === 'not_started') return 'Waiting to be taken';
  if (status === 'in_progress') return 'In progress';
  if (status === 'completed') return 'Completed';
  // DA-318: Flight too (the CRM records a supplier confirmation, never an issued ticket).
  return 'Confirmed by supplier';
}

/** DA-44 word of the viewer's least advanced own task (what still needs them); null when they have none. */
export function ownTaskWord(services: DealServicesView | null): DealStatusWord | null {
  const own = ownTaskItems(services);
  if (own.length === 0) return null;
  const first = [...own].sort((a, b) => TASK_RANK[a.task!.status] - TASK_RANK[b.task!.status] || a.itemNo - b.itemNo)[0]!;
  return taskWord(first);
}

function hasReadableTask(services: DealServicesView | null): boolean {
  return (services?.items ?? []).some((i) => i.task !== null);
}

/** An accepted quotation on this Deal that has not started a booking yet (DA-22), newest first. */
export function acceptedQuotationToBook(list: QuotationListView | null): QuotationSummary | null {
  if (!list) return null;
  return list.quotations.find((q) => q.acceptedVersionId !== null && !q.converted && q.bookingVersionId === null) ?? null;
}

function blockingCount(view: BookNowView): number {
  return view.checklist.filter((c) => c.blocking).length;
}

/**
 * One derivation over today's reads. A failed booking read is 'could_not_load',
 * never 'not_started'. null = no status word is provable for this viewer.
 */
export function dealBookingState(input: DealBookingInput): DealBookingState | null {
  const { book } = input;
  if (book.state === 'failed') return 'could_not_load';
  if (book.state === 'ok') {
    const view = book.view;
    const v = view.version;
    if (v?.serviceType === 'hotel') return 'hotel_legacy';
    // Book now switched off with nothing started: the B1 hotel panel rules apply (as today).
    if (!v && !view.serviceItemsEnabled) return limitedState(input);
    if (view.dealNotActive) return 'lost';
    if (!v) return acceptedQuotationToBook(input.quotations) ? 'quotation_accepted' : 'not_started';
    if (v.status === 'draft') return blockingCount(view) > 0 ? 'in_progress' : 'ready_to_submit';
    const review = view.accountsReview?.status ?? null;
    if (review === 'returned') return 'returned';
    if (review === 'approved') return view.progress.fulfilled ? 'all_confirmed' : 'being_arranged';
    return 'waiting_for_accounts';
  }
  return limitedState(input);
}

/**
 * Viewers without a Book now view (Purchase, Flight, the Visa & Passport desk,
 * Accounts, or a database without Book now). Honest-status rule (lead ruling,
 * 19 October): only what their own reads prove.
 *   - No Accounts-review signal: never 'waiting_for_accounts', 'returned',
 *     'being_arranged' or 'all_confirmed'. Tasks are created when the booking
 *     is submitted, before Accounts decides (booking_confirm,
 *     20261119000300_b11_revision.sql:1230, task insert :1388 and :1430), so a
 *     readable task does not prove approval.
 *   - No lost signal: the lost-stage list is only in authz.lost_deal_stages
 *     (20261115000100_lost_deal_booking_block.sql:56), which the application
 *     cannot read, so the stage code alone proves nothing.
 * Order: the viewer's own task (DA-44 word); a submitted version ("Booking
 * submitted"); a readable draft; otherwise no status word.
 */
function limitedState(input: DealBookingInput): DealBookingState | null {
  if (!input.services.ok || !input.legacyBooking.ok) return 'could_not_load';
  const services = input.services.view;
  const version = services?.version ?? null;
  if (version?.serviceType === 'hotel' || (!version && input.legacyBooking.exists)) return 'hotel_legacy';
  if (ownTaskWord(services)) return 'own_task';
  if (version?.status === 'confirmed') return 'submitted';
  if (version?.status === 'draft') return 'in_progress';
  return null;
}

/** The header status, or undefined when no status word is provable (amended contract). */
export function dealStatus(input: DealBookingInput, state: DealBookingState | null = dealBookingState(input)): DealStatusVM | undefined {
  if (state === null) return undefined;
  if (state === 'own_task') {
    const word = ownTaskWord(input.services.ok ? input.services.view : null);
    return word ? { state, word } : undefined;
  }
  return { state, word: dealStatusWord(state) };
}

const DEPARTMENT_WORD: Record<ServiceDepartment, string> = {
  purchase: 'Purchase',
  flight: 'Flight',
  visa: 'the Visa and passport desk',
};

/** "Purchase and Flight" etc. from the services still open (DA-27). */
function arrangingDepartments(view: BookNowView | null, services: DealServicesView | null): string {
  const items = view?.items ?? services?.items ?? [];
  const open = new Set<ServiceDepartment>();
  for (const item of items) {
    if (item.state === 'cancelled') continue;
    const done = item.task?.status === 'supplier_confirmed' || item.task?.status === 'completed';
    if (!done) open.add(item.department);
  }
  const words = (['purchase', 'flight', 'visa'] as const).filter((d) => open.has(d)).map((d) => DEPARTMENT_WORD[d]);
  if (words.length === 0) return 'The teams';
  const text = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Next line for viewers whose reads prove no booking step (lead ruling, 19 October; DA-112 lower case). */
export const SEE_SERVICES = 'see Services and tasks';

export interface DealActionResult {
  primary: DealPrimaryAction | null;
  next: DealNextVM;
}

/**
 * The one header primary and the "Next:" line for a state (copy §16.3). A
 * viewer who may not do the next step gets no primary; the Next line then
 * names who acts. Booking links go to existing pages only.
 */
export function dealPrimaryAction(state: DealBookingInput & { bookingState?: DealBookingState | null }): DealActionResult {
  const bookingState = state.bookingState === undefined ? dealBookingState(state) : state.bookingState;
  const view = state.book.state === 'ok' ? state.book.view : null;
  const services = state.services.ok ? state.services.view : null;
  const bookHref = `/app/deals/${state.dealId}/book`;
  const canEdit = view?.canEdit ?? false;
  const teamTasks: DealPrimaryAction | null = hasReadableTask(services)
    ? { kind: 'see_team_tasks', label: 'See team tasks', href: dealHref(state.dealId, 'services') }
    : null;
  if (bookingState === null) return { primary: teamTasks, next: { text: SEE_SERVICES } };
  switch (bookingState) {
    case 'own_task':
    case 'submitted':
      return { primary: teamTasks, next: { text: SEE_SERVICES } };
    case 'could_not_load':
      return { primary: null, next: { text: 'Booking did not load. Nothing was changed. Reload the page.' } };
    case 'not_started':
      return canEdit
        ? { primary: { kind: 'start_booking', label: 'Start booking' }, next: { text: 'start the booking', actor: 'You' } }
        : { primary: null, next: { text: 'Sales on this deal or the branch Manager starts the booking' } };
    case 'quotation_accepted': {
      const q = acceptedQuotationToBook(state.quotations);
      const reference = q?.reference ?? '';
      if (canEdit && q?.acceptedVersionId) {
        return {
          primary: {
            kind: 'start_from_quotation',
            label: 'Start booking from quotation',
            href: `/app/quotations/${q.acceptedVersionId}`,
            quotationReference: reference,
          },
          next: { text: `start the booking from quotation ${reference}`, actor: 'You' },
        };
      }
      return { primary: null, next: { text: `Sales on this deal or the branch Manager starts the booking from quotation ${reference}` } };
    }
    case 'in_progress': {
      const n = view ? blockingCount(view) : 0;
      const things = n === 1 ? '1 thing' : `${n} things`;
      if (canEdit) return { primary: { kind: 'continue_booking', label: 'Continue booking', href: bookHref }, next: { text: `finish ${things}`, actor: 'You' } };
      return { primary: null, next: { text: 'Sales on this deal or the branch Manager finishes the booking' } };
    }
    case 'ready_to_submit':
      if (canEdit) {
        return {
          // Batch 2 (lead ruling): step 3 opened at the review section.
          primary: { kind: 'review_and_submit', label: 'Review and submit', href: `${bookHref}/finish#review` },
          next: { text: 'review and submit (step 3)', actor: 'You' },
        };
      }
      return { primary: null, next: { text: 'the deal owner or branch Manager reviews and submits the booking' } };
    case 'waiting_for_accounts':
      return { primary: view ? { kind: 'view_booking', label: 'View booking', href: bookHref } : null, next: { text: 'Accounts checks the booking' } };
    case 'returned':
      if (view?.canOpenRevision) {
        return {
          primary: { kind: 'fix_and_send_again', label: 'Fix and send again', href: bookHref },
          next: { text: 'fix what Accounts asked for', actor: 'You' },
        };
      }
      return {
        primary: view ? { kind: 'view_booking', label: 'View booking', href: bookHref } : null,
        // Opening a fix uses can_edit_booking_draft (assigned Sales too); lead ruling 19 October.
        next: { text: 'Sales on this deal or the branch Manager fixes what Accounts asked for' },
      };
    case 'being_arranged':
      return {
        primary: { kind: 'see_team_tasks', label: 'See team tasks', href: dealHref(state.dealId, 'services') },
        next: { text: `${arrangingDepartments(view, services)} arrange the services. Nothing is booked until the supplier confirms.` },
      };
    case 'all_confirmed':
      return { primary: view ? { kind: 'view_booking', label: 'View booking', href: bookHref } : null, next: { text: 'Nothing waiting.' } };
    case 'lost':
      return view?.version
        ? { primary: { kind: 'view_booking', label: 'View booking', href: bookHref }, next: { text: 'nothing while the deal is lost or rejected in Bitrix' } }
        : { primary: null, next: { text: 'nothing while the deal is lost or rejected in Bitrix' } };
    case 'hotel_legacy':
      return {
        primary: state.legacyBooking.ok && state.legacyBooking.exists
          ? { kind: 'open_hotel_booking', label: 'Open hotel booking', href: `${dealHref(state.dealId, 'services')}#hotel-booking` }
          : null,
        next: { text: 'see the hotel booking under Services and tasks' },
      };
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** Bitrix stage by name (B1-1); the switch ships Off, so Batch 1 shows the DA-93 fallback. */
export function dealStageName(stageId: string, names: BitrixNameLookup = BITRIX_NAMES_OFF) {
  return bitrixName(names, dealStageEntity(stageId), stageId);
}

/** Same owner rule as the Deals list (DEC-52: the owner's name only when the read returned it). */
export const dealOwnerVM = dealRowOwner;

function servicesProgressText(view: BookNowView | null, services: DealServicesView | null): string | undefined {
  const progress = view?.progress ?? services?.progress;
  if (!progress || progress.total === 0) return undefined;
  const done = progress.byState.supplierConfirmed + (progress.byState.completed ?? 0);
  return `Services: ${done} of ${progress.total} confirmed`;
}

export interface DealHeaderInput extends DealBookingInput {
  deal: DealDetail;
  leadLink: LeadLinkVM | null;
  /** Bitrix name map for this render (loadBitrixNameLookup); default switched off (DA-93). */
  names?: BitrixNameLookup;
}

export function buildDealHeader(input: DealHeaderInput): DealHeaderVM {
  const { deal } = input;
  const state = dealBookingState(input);
  const { primary, next } = dealPrimaryAction({ ...input, bookingState: state });
  const view = input.book.state === 'ok' ? input.book.view : null;
  const services = input.services.ok ? input.services.view : null;
  const review = view?.accountsReview;
  const progressText = servicesProgressText(view, services);
  const status = dealStatus(input, state);
  return {
    dealId: deal.id,
    reference: deal.reference,
    title: deal.title,
    ...(status ? { status } : {}),
    ...(deal.source ? { stage: dealStageName(deal.source.stageId, input.names) } : {}),
    owner: dealOwnerVM(deal),
    ...(input.leadLink ? { leadLink: { href: input.leadLink.href, reference: input.leadLink.reference } } : {}),
    next,
    primary,
    // DA-20 chip: only with the start action, while the Bitrix stage is not the Won stage.
    waitsForWon: primary?.kind === 'start_booking' && Boolean(view?.stage && !view.stage.isTriggerStage),
    bitrixLate: Boolean(deal.source?.stale),
    testRecord: !deal.source,
    lostInBitrix: Boolean(view?.dealNotActive),
    ...(review && review.status === 'returned'
      ? { returnNotice: { reviewedAt: review.reviewedAt, reason: review.reasonHidden ? null : review.reason, reasonHidden: review.reasonHidden } }
      : {}),
    ...(progressText ? { servicesProgressText: progressText } : {}),
  };
}

// ---------------------------------------------------------------------------
// Overview (no money)
// ---------------------------------------------------------------------------

const ASSIGNMENT_KIND_LABEL: Record<string, string> = {
  sales: 'Sales',
  purchase: 'Purchase',
  flight: 'Flight',
  visa: 'Visa and passport desk',
};

const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function dayText(ymd: string): string {
  const time = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(time) ? ymd : DAY.format(time);
}

/** "Goa · 12 Nov 2026 to 15 Nov 2026"; null when nothing is known. */
export function tripText(trip: { destination: string | null; start: string | null; end: string | null } | null | undefined): string | null {
  if (!trip) return null;
  const parts: string[] = [];
  const destination = trip.destination?.trim();
  if (destination) parts.push(destination);
  if (trip.start && trip.end) parts.push(`${dayText(trip.start)} to ${dayText(trip.end)}`);
  else if (trip.start) parts.push(`from ${dayText(trip.start)}`);
  return parts.length ? parts.join(' · ') : null;
}

export function buildDealOverview(deal: DealDetail, services: DealServicesView | null, names: BitrixNameLookup = BITRIX_NAMES_OFF): DealOverviewVM {
  const travellers = services?.travellers;
  const source = deal.source;
  return {
    branchName: deal.branchName,
    createdOn: deal.createdOn,
    relation: deal.relation,
    team: deal.assignments.map((a) => ({
      kindLabel: ASSIGNMENT_KIND_LABEL[a.kind] ?? a.kind.charAt(0).toUpperCase() + a.kind.slice(1),
      isYou: a.isYou,
    })),
    tripText: tripText(services?.trip),
    // Absent for Purchase and Flight (the services DTO omits travellers for them).
    travellersText: travellers && travellers.length > 0 ? (travellers.length === 1 ? '1 traveller' : `${travellers.length} travellers`) : null,
    ...(source
      ? {
          bitrix: {
            sourceDealId: source.sourceDealId,
            stage: dealStageName(source.stageId, names),
            lastCheckedAt: source.lastVerifiedAt,
            lastChangeAt: source.lastSyncedAt,
            late: source.stale,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Money (the only VM with amounts)
// ---------------------------------------------------------------------------

function paise(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return formatPaise(value);
}

function signedPaise(value: string | number | null | undefined): string | null {
  const text = paise(value);
  if (text === null) return null;
  return BigInt(value as string | number) > 0n ? `+${text}` : text;
}

/**
 * Money tab model, or undefined for every viewer whose deal DTO says
 * 'withheld' (Purchase, Flight, Visa, Sales without price access). Copies
 * exactly today's Sales figures: never destinations, receipt amounts, cheque
 * numbers, payer names, references or Accounts names.
 */
export function buildDealMoney(deal: DealDetail, view: BookNowView | null): DealMoneyVM | undefined {
  if (!canSeeDealMoney(deal)) return undefined;
  const money: DealMoneyVM = {
    dealValue: deal.commercial.visible
      ? { state: 'shown', sellingTotal: deal.commercial.sellingTotal, estimatedMargin: deal.commercial.estimatedMargin }
      : { state: 'not_recorded' },
  };
  if (view && (view.commercials !== undefined || view.plan !== undefined)) {
    money.booking = {
      finalSellingTotal: paise(view.commercials?.sellingTotalPaise),
      plan: view.plan && view.plan.length > 0 ? view.plan.map((p) => ({ label: p.label, amount: formatPaise(p.amountPaise), dueDate: p.dueDate || null })) : null,
    };
  }
  if (view?.claims) {
    const c = view.claims;
    money.claims = {
      reported: formatPaise(c.reportedPaise),
      confirmed: formatPaise(c.confirmedPaise),
      balance: paise(c.balancePaise),
      own: c.claims.map((x) => ({ claimId: x.claimId, amount: formatPaise(x.amountPaise), paidOn: x.paidOn, mode: x.mode, status: x.displayStatus })),
    };
  }
  const totals = (view?.history ?? []).filter((h) => h.sellingTotalPaise !== undefined);
  if (totals.length > 0) {
    money.versionTotals = totals.map((h) => ({
      versionNo: h.versionNo,
      sellingTotal: paise(h.sellingTotalPaise),
      sellingTotalDelta: signedPaise(h.sellingTotalDeltaPaise),
    }));
  }
  return money;
}

// ---------------------------------------------------------------------------
// History (money-free)
// ---------------------------------------------------------------------------

const BOOKING_VERSION_WORD = { draft: 'Draft', confirmed: 'Submitted', superseded: 'Replaced', discarded: 'Discarded' } as const;

/** DA-41 word for one quotation version. */
export function quotationVersionWord(q: QuotationSummary, versionNo: number, status: QuotationStatus, versionId: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'ready':
      return 'Ready to share';
    case 'sent':
      return 'Shared with customer';
    case 'accepted':
      return q.converted && q.acceptedVersionId === versionId ? 'Booking started' : 'Accepted';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'discarded':
      return 'Discarded';
    case 'superseded': {
      const newer = q.versions.map((v) => v.versionNo).filter((n) => n > versionNo);
      return newer.length ? `Replaced by v${Math.min(...newer)}` : 'Replaced';
    }
  }
}

export interface DealHistoryInput {
  book: DealBookingInput['book'];
  quotations: QuotationListView | null;
  /** The viewer's Money model; payment events only when it carries claims. */
  money: DealMoneyVM | undefined;
}

/**
 * History events, every one from a read the database already filters by role.
 * Order: booking versions newest first (each followed by its Accounts review),
 * then quotation versions newest first, then reported payments newest first.
 * A failed booking read is 'error' (never an empty history).
 */
export function buildDealHistory(input: DealHistoryInput): DealHistoryVM {
  if (input.book.state === 'failed') return { state: 'error' };
  const events: DealHistoryEventVM[] = [];
  const view = input.book.state === 'ok' ? input.book.view : null;
  const versions = [...(view?.history ?? [])].sort((a, b) => b.versionNo - a.versionNo);
  for (const h of versions) {
    events.push({ kind: 'booking_version', id: h.versionId, at: h.confirmedAt, versionNo: h.versionNo, statusText: BOOKING_VERSION_WORD[h.status], changeClass: h.changeClass });
    if (h.reviewStatus) {
      events.push({
        kind: 'accounts_review',
        id: `${h.versionId}:review`,
        at: null,
        versionNo: h.versionNo,
        reviewStatus: h.reviewStatus,
        reason: h.reviewReasonHidden ? null : h.reviewReason,
        reasonHidden: h.reviewReasonHidden,
      });
    }
  }
  for (const q of input.quotations?.quotations ?? []) {
    for (const v of q.versions) {
      events.push({
        kind: 'quotation_version',
        id: v.versionId,
        at: v.sentAt,
        quotationReference: q.reference,
        versionNo: v.versionNo,
        statusText: quotationVersionWord(q, v.versionNo, v.status, v.versionId),
        href: `/app/quotations/${v.versionId}`,
      });
    }
  }
  if (input.money?.claims && view?.claims) {
    const claims = [...view.claims.claims].sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : a.reportedAt > b.reportedAt ? -1 : 0));
    for (const c of claims) events.push({ kind: 'payment_reported', id: c.claimId, at: c.reportedAt, status: c.displayStatus });
  }
  return { state: 'ok', events };
}

export type DealHistoryGroupKey = 'booking' | 'quotations' | 'payments';

/** One heading per History group (lead ruling 5: grouped History, each group headed). */
export const DEAL_HISTORY_GROUP_HEADING: Record<DealHistoryGroupKey, string> = {
  booking: 'Booking versions and Accounts reviews',
  quotations: 'Quotations',
  payments: 'Reported payments',
};

export interface DealHistoryGroup {
  key: DealHistoryGroupKey;
  heading: string;
  events: DealHistoryEventVM[];
}

/**
 * The History events split into their groups, in buildDealHistory's order
 * (each group newest first). Empty groups are left out, so every group shown
 * has a heading and at least one event.
 */
export function dealHistoryGroups(events: DealHistoryEventVM[]): DealHistoryGroup[] {
  const groupOf = (e: DealHistoryEventVM): DealHistoryGroupKey =>
    e.kind === 'quotation_version' ? 'quotations' : e.kind === 'payment_reported' ? 'payments' : 'booking';
  return (['booking', 'quotations', 'payments'] as const)
    .map((key) => ({ key, heading: DEAL_HISTORY_GROUP_HEADING[key], events: events.filter((e) => groupOf(e) === key) }))
    .filter((g) => g.events.length > 0);
}

// ---------------------------------------------------------------------------
// Documents (B1-2: Atlas's loadDealDocuments rows, links already built to the
// existing download routes by src/modules/deals/documents.ts)
// ---------------------------------------------------------------------------

/** Explicit key copy of the read's rows (DTO allowlist); 'error' stays an error, never "No documents". */
export function toDealDocumentsVM(rows: DealDocumentRow[] | 'error'): DealDocumentsVM {
  if (rows === 'error') return { state: 'error' };
  return {
    state: 'ok',
    rows: rows.map((r) => ({ kind: r.kind, id: r.id, fileName: r.fileName, mime: r.mime, uploadedAt: r.uploadedAt, context: { ...r.context }, href: r.href }) as DealDocumentRow),
  };
}

// ---------------------------------------------------------------------------
// Whole workspace
// ---------------------------------------------------------------------------

export interface DealWorkspaceInput extends DealHeaderInput {
  /** Raw `?tab=` value. */
  tab: unknown;
  /** The itinerary list was readable (non-null). */
  itinerariesReadable: boolean;
  /** Documents rows (loadDealDocuments) when the Documents tab is open; undefined = not read. */
  documents?: DealDocumentRow[] | 'error';
  /** True when the B1-2 read exists on this database (decides tab visibility before the rows are read). */
  documentsAvailable?: boolean;
}

/** Only the current tab's model is built; the other tab models are left out (no hidden payload). */
export function buildDealWorkspace(input: DealWorkspaceInput): DealWorkspaceVM {
  const visible = visibleDealTabs({
    money: canSeeDealMoney(input.deal),
    quotations: input.quotations !== null || input.itinerariesReadable,
    documents: Boolean(input.documentsAvailable),
  });
  const current = parseDealTab(input.tab, visible);
  const view = input.book.state === 'ok' ? input.book.view : null;
  const services = input.services.ok ? input.services.view : null;
  const workspace: DealWorkspaceVM = {
    header: buildDealHeader(input),
    tabs: dealTabItems(input.deal.id, visible, current),
    current,
  };
  if (current === 'overview') workspace.overview = buildDealOverview(input.deal, services, input.names);
  if (current === 'money') {
    const money = buildDealMoney(input.deal, view);
    if (money) workspace.money = money;
  }
  if (current === 'history') {
    // The money model is consulted only to decide payment events; it is not attached to History.
    workspace.history = buildDealHistory({ book: input.book, quotations: input.quotations, money: buildDealMoney(input.deal, view) });
  }
  if (current === 'documents' && input.documents !== undefined) workspace.documents = toDealDocumentsVM(input.documents);
  return workspace;
}
