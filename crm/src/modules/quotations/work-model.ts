import type { ListFilterVM } from '@/modules/deals/workspace-contract';
import type { WorkflowSettingsView } from '@/modules/fulfilment/contracts';
import { itineraryRenderedHref } from '@/modules/itineraries/contracts';
import type { QuoteStatusWord } from './editor-contract';
import type { QuotationStatus } from './contracts';
import {
  ITINERARY_LIST_STATUSES,
  parseWorkCursor,
  QUOTATION_LIST_STATUSES_ALL,
  type ItineraryWorkPage,
  type QuotationWorkPage,
  type ReferralDraftRecord,
  type ReferralDraftStateRecord,
  type ReferralLinkCandidate,
  type ReferralOwnerCandidate,
  type ReferralSubjectDraft,
  type WorkCursor,
  type WorkItineraryRow,
  type WorkQuotationRow,
} from './referral';
import { referralDraftHref, SUBJECT_NOUN, subjectHref } from './subject-links';
import type {
  ItineraryListFilter,
  ItineraryListPageVM,
  NewWorkVM,
  QuotationListFilter,
  QuotationListPageVM,
  ReferralCandidateVM,
  ReferralDraftPrimary,
  ReferralDraftStateVM,
  ReferralDraftTab,
  ReferralDraftVM,
  ReferralLinkStepVM,
  ReferralLinkVM,
  ReferralSourceKind,
  ReferralSwitchState,
  ReferralUnlinkFormVM,
  SubjectReferralDraftsVM,
  WorkItineraryRowVM,
  WorkListKind,
  WorkListPagerVM,
  WorkListScope,
  WorkQuotationRowVM,
  WorkRowActionVM,
  WorkSubjectVM,
} from './work-contract';
import { QUOTATION_LIST_FILTERS, REFERRAL_DRAFT_TABS } from './work-contract';

/*
 * Direction A Batch 3 view-model builders (Terra, T-3). Pure: no database, no
 * React. Routes call the Atlas loaders (server/referral.ts) and turn their
 * records into the frozen view models of work-contract.ts with these helpers.
 *
 * Rules: no money in any row; every href comes from subject-links.ts or the
 * list address helpers below (never an "undefined" address); counts are exact
 * for the chosen scope and the scope is named; the automatic-close date comes
 * from the database (the browser never computes it); Unknown is never shown
 * as Off. Wording is provisional (copy-catalogue §16.5/§16.6), Mercury confirms.
 */

export const WORK_PATHS: Record<WorkListKind, string> = { quotations: '/app/quotations', itineraries: '/app/itineraries' };

// ---------------------------------------------------------------------------
// Wording (provisional; Mercury confirms; DA ids from copy-catalogue §16.5)
// ---------------------------------------------------------------------------

export const WORK_TEXT = {
  countScope: 'Counts include all pages.',
  // DA-202
  scopeLine: {
    quotations: { mine: 'Quotations you made or own', all: 'Quotations you can open' },
    itineraries: { mine: 'Itineraries you made or own', all: 'Itineraries you can open' },
  },
  /** DA-204 (amends DA-77) */
  hiddenClosed: 'Closed drafts that were never linked are not in this list. Choose “Closed drafts” or open one by its reference.',
  /** DA-205: both lists accept TQ-n and TD-n (a TD-n opens the draft itself). */
  referenceMiss: 'Nothing with that reference that you can open. Check the reference (for example TQ-12 or TD-301).',
  empty: {
    quotations: { title: 'No quotations here', text: 'Nothing matches this filter. Try another filter, or start a new quotation.' },
    itineraries: { title: 'No itineraries here', text: 'Nothing matches this filter. Try another filter, or start a new itinerary.' },
  },
  notApplicable: 'Quotations and itineraries are for Sales and branch Managers.',
  /** DA-212 (amends DA-78) */
  switchOff: 'Referral drafts are switched off, so you cannot start a new one. Existing drafts keep working.',
  switchUnknown: 'The CRM could not check whether referral drafts are switched on, so you cannot start a new one right now. Existing drafts keep working. Reload to try again.',
  /** DA-211 */
  fromBitrix: {
    quotations: 'Open the lead or deal, then press “Create quotation” on its Quotations tab.',
    itineraries: 'Open the deal or the quotation, then press “Make branded itinerary” there.',
  },
  /** DA-213 */
  titleHint: {
    quotations: 'Printed at the top of the quotation. You cannot change it later. Left empty, it reads “Trip for {customer name}”.',
    itineraries: 'Printed at the top of the itinerary. Left empty, it reads “Trip for {customer name}”.',
  },
  statusOpen: 'Open',
  statusClosed: 'Closed',
  /** DA-74 */
  statusClosedNoActivity: 'Closed after 90 days without activity',
  /** DA-218 */
  closesOn: 'Closes on {date} if nothing changes.',
  autoClosePaused: 'Automatic closing is paused while referral drafts are switched off. The 90 days start again when they are switched on.',
  closedAutomatically: 'Closed automatically on {date} after 90 days without activity. Nothing was deleted.',
  closedAutomaticallyNoDate: 'Closed automatically after 90 days without activity. Nothing was deleted.',
  /** DA-219 (amends DA-59) */
  privacyNotLinked: 'Only the owner and the branch Manager can open this draft.',
  privacyLinked: 'The owner, the branch Manager and Sales on {kind} {ref} can open this draft.',
  notGiven: 'Not given',
  /** DA-227 */
  linkHeading: { deal: 'Deals in {branch} that you can work on', lead: 'Leads in {branch} that you can work on' },
  /** DA-229 (amends DA-63): the dialog body; the title "Link this draft to {ref}?" is the view's. */
  linkConfirm: {
    deal: 'Sales on deal {ref} will be able to open and change this draft, including the customer’s mobile and email. Nothing changes in Bitrix.',
    lead: 'Sales on lead {ref} will be able to open and change this draft, including the customer’s mobile and email. Nothing changes in Bitrix.',
  },
  linkFlagFromLead: 'Made from the linked lead',
  linkFlagAccepted: 'Already has an accepted quotation',
  linkNone: 'No leads or deals in this branch match. Check the reference, or wait until Bitrix sends the record.',
  /** Echo M3 (DA-226 load-failure pattern). */
  linkLoadError: 'Leads and deals did not load. Nothing was changed. Reload the page to try again.',
  /** DA-231: the dialog body; the title "Remove the link to {ref}?" is the view's. */
  unlinkConfirm: 'Sales on {ref} lose access to this draft at once. The link stays in History.',
  /** DA-64 / DA-68 */
  linked: 'Linked to {ref}. Nothing changed in Bitrix.',
  unlinked: 'Link to {ref} removed. You can link the right record now.',
  /** Echo M4 */
  startBooking: 'Open {ref} to start booking',
  /** DA-71 */
  subjectDraftsHeading: 'Referral drafts for this deal',
  subjectDraftsNote: 'Only one quotation per deal can be accepted. Close the others as duplicates.',
} as const;

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** "12 Nov 2026" for a YYYY-MM-DD (IST calendar day) or an ISO time; null stays null. */
export function workDateText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00+05:30` : iso);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
}

export const QUOTATION_FILTER_LABEL: Record<QuotationListFilter, string> = {
  open: 'Open',
  to_finish: 'To finish',
  drafts: 'Drafts',
  ready: 'Ready to share',
  shared: 'Shared',
  accepted: 'Accepted',
  ready_to_book: 'Ready to book',
  accepted_not_linked: 'Accepted, not linked',
  declined_or_expired: 'Declined or expired',
  closed_drafts: 'Closed drafts',
  all: 'All',
};

export const ITINERARY_FILTER_LABEL: Record<ItineraryListFilter, string> = {
  open: 'Open',
  draft: 'Draft',
  ready: 'Ready for final PDF',
  final_made: 'Final PDF made',
  closed_drafts: 'Closed drafts',
  all: 'All',
};

import { REFERRAL_CLOSE_REASON_LABEL, REFERRAL_SOURCE_LABEL, REFERRAL_UNLINK_REASON_LABEL } from './work-labels';

export { REFERRAL_CLOSE_REASON_LABEL, REFERRAL_SOURCE_LABEL, REFERRAL_UNLINK_REASON_LABEL };

// ---------------------------------------------------------------------------
// List addresses and query (filter, scope, reference, keyset cursor)
// ---------------------------------------------------------------------------

export interface WorkListQuery<F extends string> {
  filter: F;
  scope: WorkListScope;
  /** Exact TQ-n / TD-n (upper case), or null. */
  reference: string | null;
  after: WorkCursor | null;
}

const one = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined) : typeof v === 'string' ? v : undefined);

/** The cursor in the address: "<since>~<id>" (opaque to staff). Malformed → first page. */
export function encodeWorkCursor(c: WorkCursor): string {
  return `${c.since}~${c.id}`;
}
export function decodeWorkCursor(raw: string | undefined): WorkCursor | null {
  if (!raw) return null;
  const i = raw.lastIndexOf('~');
  if (i <= 0) return null;
  return parseWorkCursor({ since: raw.slice(0, i), id: raw.slice(i + 1) });
}

const REFERENCE = /^(TQ|TD)-[1-9][0-9]{0,8}$/;

/** A typed reference, normalised ("td-301 " → "TD-301"); null when it is not a TQ-n / TD-n. */
export function normaliseWorkReference(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim().toUpperCase();
  return REFERENCE.test(v) ? v : null;
}

export function parseWorkListQuery(kind: 'quotations', params: Record<string, unknown>): WorkListQuery<QuotationListFilter>;
export function parseWorkListQuery(kind: 'itineraries', params: Record<string, unknown>): WorkListQuery<ItineraryListFilter>;
export function parseWorkListQuery(kind: WorkListKind, params: Record<string, unknown>): WorkListQuery<string> {
  const filters: readonly string[] = kind === 'quotations' ? QUOTATION_LIST_STATUSES_ALL : ITINERARY_LIST_STATUSES;
  const f = one(params.filter);
  const s = one(params.scope);
  return {
    filter: f && filters.includes(f) ? f : 'open',
    scope: s === 'all' ? 'all' : 'mine',
    reference: normaliseWorkReference(one(params.reference)),
    after: decodeWorkCursor(one(params.after)),
  };
}

/** List address; defaults (open, mine) are left out. A reference search ignores filter and scope. */
export function workListHref(kind: WorkListKind, q: { filter?: string; scope?: WorkListScope; reference?: string | null; after?: WorkCursor | null }): string {
  const p = new URLSearchParams();
  if (q.reference) p.set('reference', q.reference);
  else {
    if (q.filter && q.filter !== 'open') p.set('filter', q.filter);
    if (q.scope && q.scope !== 'mine') p.set('scope', q.scope);
  }
  if (q.after) p.set('after', encodeWorkCursor(q.after));
  const s = p.toString();
  return s ? `${WORK_PATHS[kind]}?${s}` : WORK_PATHS[kind];
}

// ---------------------------------------------------------------------------
// Draft state, subjects, rows
// ---------------------------------------------------------------------------

export function draftStateVM(d: Pick<ReferralDraftStateRecord, 'status' | 'closedReason' | 'autoClose'>): ReferralDraftStateVM {
  const due = workDateText(d.autoClose.dueOn);
  const closedNoActivity = d.status === 'closed' && d.closedReason === 'no_activity';
  let autoCloseLine: string | null = null;
  if (d.autoClose.state === 'scheduled' && due) autoCloseLine = fill(WORK_TEXT.closesOn, { date: due });
  else if (d.autoClose.state === 'paused' && d.status === 'open') autoCloseLine = WORK_TEXT.autoClosePaused;
  else if (d.autoClose.state === 'closed' || closedNoActivity) autoCloseLine = due ? fill(WORK_TEXT.closedAutomatically, { date: due }) : WORK_TEXT.closedAutomaticallyNoDate;
  // Effective closure on read (switch on, due): the database already reports status 'closed'.
  const status = d.status === 'closed' || d.autoClose.state === 'closed' ? 'closed' : 'open';
  return {
    status,
    closedReason: d.closedReason ?? (d.autoClose.state === 'closed' ? 'no_activity' : null),
    statusText: status === 'open' ? WORK_TEXT.statusOpen : closedNoActivity || d.autoClose.state === 'closed' ? WORK_TEXT.statusClosedNoActivity : WORK_TEXT.statusClosed,
    autoCloseLine,
    autoCloseState: d.autoClose.state,
  };
}

function subjectVM(subject: { kind: 'lead' | 'deal' | 'referral' | 'quotation'; id: string; reference: string }, extra = ''): WorkSubjectVM {
  if (subject.kind === 'quotation') return { kind: 'quotation', text: `Quotation ${subject.reference}${extra}`, href: null };
  return { kind: subject.kind, text: `${SUBJECT_NOUN[subject.kind]} ${subject.reference}${extra}`, href: subjectHref(subject.kind, subject.id) };
}

/** Status word of a list row (DA-41), from the effective status of the current version. */
export function rowStatusWord(status: QuotationStatus, converted: boolean): QuoteStatusWord {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'ready':
      return 'Ready to share';
    case 'sent':
      return 'Shared with customer';
    case 'accepted':
      return converted ? 'Booking started' : 'Accepted';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'superseded':
      return 'Replaced by a newer version';
    case 'discarded':
      return 'Discarded';
  }
}

const quotationHref = (versionId: string) => `/app/quotations/${encodeURIComponent(versionId)}`;

function quotationRowAction(r: WorkQuotationRow, closed: boolean): WorkRowActionVM | null {
  const editor = quotationHref(r.currentVersion.versionId);
  if (closed && r.referralDraftId) return { kind: 'reopen', label: 'Reopen draft', href: referralDraftHref(r.referralDraftId) };
  if (r.converted) {
    const dealId = r.subjectKind === 'deal' ? r.subject.id : r.linkedDealId;
    const href = subjectHref('deal', dealId);
    return href ? { kind: 'continue_booking', label: 'Continue booking', href: `${href}/book` } : { kind: 'open', label: 'Open', href: editor };
  }
  if (r.acceptedNotLinked) {
    // Referral: link the draft to the confirmed deal on the draft page; Lead: the quotation's own link step.
    const href = r.subjectKind === 'referral' && r.referralDraftId ? `${referralDraftHref(r.referralDraftId)}?tab=link` : editor;
    return { kind: 'link_to_deal', label: 'Link to deal', href };
  }
  // Atlas §7: readyToBook = accepted, not converted, with a deal to book into (older database: accepted).
  if (r.readyToBook ?? r.accepted) return { kind: 'start_booking', label: 'Start booking', href: editor };
  if (r.currentVersion.status === 'draft' || r.currentVersion.status === 'ready') return { kind: 'continue', label: 'Continue', href: editor };
  return { kind: 'open', label: 'Open', href: editor };
}

/** " · linked to deal D-1" / " · linked to lead L-1" / " · not linked to Bitrix yet" for referral subjects; '' when unknown. */
function draftLinkSuffix(r: { subjectKind: string; draftLink?: { kind: 'deal' | 'lead'; reference: string } | null }): string {
  if (r.subjectKind !== 'referral' || r.draftLink === undefined) return '';
  return r.draftLink ? ` · linked to ${r.draftLink.kind} ${r.draftLink.reference}` : ' · not linked to Bitrix yet';
}

export function workQuotationRowVM(r: WorkQuotationRow): WorkQuotationRowVM {
  const draft = r.draft ? draftStateVM(r.draft) : null;
  return {
    quotationId: r.quotationId,
    reference: r.reference,
    title: r.title,
    href: quotationHref(r.currentVersion.versionId),
    versionNo: r.currentVersion.versionNo,
    statusWord: rowStatusWord(r.currentVersion.status, r.converted),
    // Mercury F1 / DA-209: the draft's link state from the list read (Atlas §7); an older database says nothing.
    subject: subjectVM(r.subject, draftLinkSuffix(r)),
    draft,
    customerName: r.customerName,
    destination: r.destination,
    tripStartText: workDateText(r.tripStart),
    validUntilText: r.currentVersion.validUntil ? `Valid until ${workDateText(r.currentVersion.validUntil)}` : null,
    ownerName: r.ownerName,
    ownerIsYou: r.ownerIsYou,
    updatedText: `Updated ${workDateText(r.since) ?? ''}`.trim(),
    action: quotationRowAction(r, draft?.status === 'closed'),
  };
}

const BASIS_TEXT = { quotation_version: 'From a quotation', booking_version: 'From the booking', none: 'Not from a quotation' } as const;

export function workItineraryRowVM(r: WorkItineraryRow): WorkItineraryRowVM {
  return {
    documentId: r.documentId,
    title: r.title,
    href: `/app/itineraries/${encodeURIComponent(r.documentId)}`,
    statusText: r.latestFinal ? 'Final PDF made' : r.factsStatus === 'ready' ? 'Ready for final PDF' : 'Draft',
    basisText: BASIS_TEXT[r.basisKind],
    subject: subjectVM(r.subject, draftLinkSuffix(r)),
    draft: r.draft ? draftStateVM(r.draft) : null,
    openDifferences: r.openDifferences,
    ownerName: r.ownerIsYou ? 'You' : r.ownerName,
    updatedText: `Updated ${workDateText(r.since) ?? ''}`.trim(),
    finalDownloadHref: r.latestFinal ? itineraryRenderedHref(r.latestFinal.renderedId) : null,
  };
}

// ---------------------------------------------------------------------------
// List pages
// ---------------------------------------------------------------------------

type LoadResult<P> = P | null | 'not_installed' | 'error';

function pager(kind: WorkListKind, q: WorkListQuery<string>, shown: number, total: number | null, next: WorkCursor | null, hasMore: boolean): WorkListPagerVM {
  const noun = kind === 'quotations' ? 'quotations' : 'itineraries';
  return {
    firstHref: q.after ? workListHref(kind, { ...q, after: null }) : null,
    nextHref: hasMore && next ? workListHref(kind, { ...q, after: next }) : null,
    shown,
    total,
    rangeText: total === null ? `Showing ${shown} ${noun}` : `Showing ${shown} of ${total} ${noun}${q.after ? ' (later page)' : ''}`,
  };
}

function chips<F extends string>(kind: WorkListKind, filters: readonly F[], labels: Record<F, string>, counts: Record<string, number> | null, q: WorkListQuery<F>): ListFilterVM<F>[] {
  return filters.map((filter) => {
    const count = counts ? (counts[filter] ?? null) : null;
    return {
      filter,
      label: count === null ? labels[filter] : `${labels[filter]} (${count})`,
      count,
      href: workListHref(kind, { filter, scope: q.scope }),
      current: q.reference === null && q.filter === filter,
    };
  });
}

function basePage<F extends string>(kind: WorkListKind, q: WorkListQuery<F>, filters: readonly F[], labels: Record<F, string>) {
  return {
    kind,
    scopeLine: WORK_TEXT.scopeLine[kind][q.scope],
    scope: { current: q.scope, mineHref: workListHref(kind, { filter: q.filter, scope: 'mine' }), allHref: workListHref(kind, { filter: q.filter, scope: 'all' }) },
    filters: { chips: chips(kind, filters, labels, null, q), scopeText: WORK_TEXT.countScope },
    reference: q.reference,
    openByReference: { action: WORK_PATHS[kind], value: q.reference ?? '', missText: null as string | null },
    hiddenClosedLine: q.filter === 'closed_drafts' || q.reference ? null : WORK_TEXT.hiddenClosed,
    pageSearch: true as const,
    empty: WORK_TEXT.empty[kind],
    newHref: `${WORK_PATHS[kind]}/new`,
  };
}

export function quotationListPageVM(q: WorkListQuery<QuotationListFilter>, result: LoadResult<QuotationWorkPage>): QuotationListPageVM {
  const base = basePage('quotations', q, QUOTATION_LIST_FILTERS, QUOTATION_FILTER_LABEL);
  const off = { rows: [], pager: pager('quotations', q, 0, null, null, false) };
  if (result === 'not_installed') return { ...base, ...off, state: 'not_installed' };
  if (result === 'error') return { ...base, ...off, state: 'error' };
  if (result === null || !result.applies) return { ...base, ...off, state: 'not_applicable', empty: { title: 'Nothing here for you', text: WORK_TEXT.notApplicable } };
  const rows = result.rows.map(workQuotationRowVM);
  return {
    ...base,
    state: 'ok',
    filters: { chips: chips('quotations', QUOTATION_LIST_FILTERS, QUOTATION_FILTER_LABEL, result.counts, q), scopeText: WORK_TEXT.countScope },
    rows,
    pager: pager('quotations', q, rows.length, result.total, result.next, result.hasMore),
    openByReference: { ...base.openByReference, missText: q.reference && rows.length === 0 ? WORK_TEXT.referenceMiss : null },
  };
}

export function itineraryListPageVM(q: WorkListQuery<ItineraryListFilter>, result: LoadResult<ItineraryWorkPage>): ItineraryListPageVM {
  const base = basePage('itineraries', q, ITINERARY_LIST_STATUSES, ITINERARY_FILTER_LABEL);
  const off = { rows: [], pager: pager('itineraries', q, 0, null, null, false) };
  if (result === 'not_installed') return { ...base, ...off, state: 'not_installed' };
  if (result === 'error') return { ...base, ...off, state: 'error' };
  if (result === null || !result.applies) return { ...base, ...off, state: 'not_applicable', empty: { title: 'Nothing here for you', text: WORK_TEXT.notApplicable } };
  const rows = result.rows.map(workItineraryRowVM);
  return {
    ...base,
    state: 'ok',
    filters: { chips: chips('itineraries', ITINERARY_LIST_STATUSES, ITINERARY_FILTER_LABEL, result.counts, q), scopeText: WORK_TEXT.countScope },
    rows,
    pager: pager('itineraries', q, rows.length, result.total, result.next, result.hasMore),
    openByReference: { ...base.openByReference, missText: q.reference && rows.length === 0 ? WORK_TEXT.referenceMiss : null },
  };
}

// ---------------------------------------------------------------------------
// Switch and New pages
// ---------------------------------------------------------------------------

/** On / Off from the read; Unknown when the database did not report it or the read failed (never Off). */
export function referralSwitchState(settings: Pick<WorkflowSettingsView, 'referralDrafts'> | null | undefined): ReferralSwitchState {
  const v = settings?.referralDrafts;
  return v === true ? 'on' : v === false ? 'off' : 'unknown';
}

export function newWorkVM(input: {
  kind: WorkListKind;
  switchState: ReferralSwitchState;
  /** The person's own memberships (display only; the database decides the branch on create). */
  memberships: ReadonlyArray<{ branchId: string; branchName: string; roleCode: string; legalEntityId: string }>;
  canSeeLeads: boolean;
  /** Echo L4: the person has the Quotations menu item (canSeeQuotations). */
  allowed?: boolean;
}): NewWorkVM {
  const purchaseEntities = new Set(input.memberships.filter((m) => m.roleCode === 'purchase').map((m) => m.legalEntityId));
  const branches = new Map<string, string>();
  for (const m of input.memberships) {
    if ((m.roleCode === 'sales' || m.roleCode === 'manager') && !purchaseEntities.has(m.legalEntityId)) branches.set(m.branchId, m.branchName);
  }
  return {
    kind: input.kind,
    allowed: input.allowed ?? true,
    fromBitrix: { text: WORK_TEXT.fromBitrix[input.kind], leadsHref: input.canSeeLeads ? '/app/leads' : null, dealsHref: '/app/deals' },
    referral: {
      state: input.switchState,
      line: input.switchState === 'off' ? WORK_TEXT.switchOff : input.switchState === 'unknown' ? WORK_TEXT.switchUnknown : null,
      branches: [...branches].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      sourceKinds: (Object.keys(REFERRAL_SOURCE_LABEL) as ReferralSourceKind[]).map((value) => ({ value, label: REFERRAL_SOURCE_LABEL[value] })),
      titleHint: WORK_TEXT.titleHint[input.kind],
    },
  };
}

// ---------------------------------------------------------------------------
// Referral draft page
// ---------------------------------------------------------------------------

export const REFERRAL_TAB_LABEL: Record<ReferralDraftTab, string> = {
  overview: 'Overview',
  quotations: 'Quotations',
  itineraries: 'Itineraries',
  link: 'Link to Bitrix',
  history: 'History',
};

export function parseReferralTab(raw: unknown): ReferralDraftTab {
  const v = one(raw);
  return v && (REFERRAL_DRAFT_TABS as readonly string[]).includes(v) ? (v as ReferralDraftTab) : 'overview';
}

export function referralTabHref(draftId: string, tab: ReferralDraftTab): string {
  return tab === 'overview' ? referralDraftHref(draftId) : `${referralDraftHref(draftId)}?tab=${tab}`;
}

function linkVM(l: ReferralDraftRecord['links'][number]): ReferralLinkVM {
  const linked = workDateText(l.linkedAt) ?? '';
  return {
    linkId: l.linkId,
    targetKind: l.targetKind,
    reference: l.reference,
    title: l.title,
    href: l.title !== null ? subjectHref(l.targetKind, l.targetId) : null,
    active: l.active,
    linkedText: l.linkedByYou ? `Linked on ${linked} by you` : `Linked on ${linked}`,
    endedText: l.endedAt ? `Removed on ${workDateText(l.endedAt)}${l.endReason ? `: ${REFERRAL_UNLINK_REASON_LABEL[l.endReason]}` : ''}` : null,
    canRemove: l.active && l.canRemove,
  };
}

const DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

/** "16 Oct 2026, 11:05" in India time; unparseable input stays as given. */
export function workDateTimeText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : DATE_TIME.format(d);
}

/** Optional real list rows for the draft's tabs (work_drafts_list by the TD-n reference); fall back to the draft read. */
export interface ReferralDraftRows {
  quotations?: WorkQuotationRow[] | null;
  itineraries?: WorkItineraryRow[] | null;
}

/** The result line after a link or unlink (the action redirects with ?done=&link=); the reference comes from the draft's own links. */
export function referralResultNotice(r: Pick<ReferralDraftRecord, 'links'>, done: unknown, linkId: unknown): string | null {
  const d = one(done);
  const id = one(linkId);
  if ((d !== 'linked' && d !== 'unlinked') || !id) return null;
  const link = r.links.find((l) => l.linkId === id);
  if (!link) return null;
  if (d === 'linked' && link.active) return fill(WORK_TEXT.linked, { ref: link.reference });
  if (d === 'unlinked' && !link.active) return fill(WORK_TEXT.unlinked, { ref: link.reference });
  return null;
}

export function referralDraftVM(r: ReferralDraftRecord, tab: ReferralDraftTab, rows: ReferralDraftRows = {}, resultNotice: string | null = null): ReferralDraftVM {
  const state = draftStateVM(r);
  const closed = state.status === 'closed';
  const activeDeal = r.links.find((l) => l.active && l.targetKind === 'deal') ?? null;
  const activeLead = r.links.find((l) => l.active && l.targetKind === 'lead') ?? null;
  const active = activeDeal ?? activeLead;
  const toBook = r.quotations.find((q) => q.accepted && !q.converted) ?? null;
  // DA-216: lower case "deal" / "lead" mid-sentence.
  const refLine = `Referral draft ${r.reference} · ${activeDeal ? `linked to deal ${activeDeal.reference}` : activeLead ? `linked to lead ${activeLead.reference}` : 'not linked to Bitrix yet'}`;
  // DA-217
  const nextLine = closed
    ? 'Next: reopen the draft to make changes'
    : !active
      ? 'Next: link this draft to the Bitrix lead or deal once it exists. Booking needs the confirmed deal.'
      : toBook && activeDeal
        ? 'Next: start the booking from the accepted quotation'
        : toBook
          ? 'Next: link the deal Bitrix made from this lead, then start the booking'
          : r.quotations.length === 0 && r.itineraries.length === 0
            ? 'Next: add a quotation or itinerary'
            : 'Next: open the quotation to see its next step';
  const primary: ReferralDraftPrimary = closed ? (r.can.reopen ? 'reopen' : null) : !activeDeal && r.can.link ? 'link' : toBook && activeDeal ? 'start_booking' : null;
  const source = r.source.kind ? `${REFERRAL_SOURCE_LABEL[r.source.kind]}${r.source.note ? ` (${r.source.note})` : ''}` : null;
  const draftSubject = { kind: 'referral' as const, id: r.referralDraftId, reference: r.reference };

  // Echo M2: sort on the ISO time, then show India time (DA-222 wording, lower case kind).
  const events: Array<{ iso: string; text: string }> = [{ iso: r.createdAt, text: `Draft ${r.reference} created${r.createdByYou ? ' by you' : ''}.` }];
  for (const l of r.links) {
    events.push({ iso: l.linkedAt, text: `Linked to ${l.targetKind} ${l.reference}.` });
    if (l.endedAt) events.push({ iso: l.endedAt, text: `Link to ${l.reference} removed${l.endReason ? ` (${REFERRAL_UNLINK_REASON_LABEL[l.endReason]})` : ''}. The link stays here.` });
  }
  if (r.closedAt) {
    events.push({
      iso: r.closedAt,
      text:
        state.closedReason === 'no_activity'
          ? (state.autoCloseLine ?? WORK_TEXT.closedAutomaticallyNoDate)
          : `Closed${r.closedReason && r.closedReason !== 'no_activity' ? ` (${REFERRAL_CLOSE_REASON_LABEL[r.closedReason]})` : ''}. Closed drafts stay readable and can be reopened.`,
    });
  }
  const time = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };
  events.sort((a, b) => time(b.iso) - time(a.iso));
  const history = events.map((e) => ({ at: workDateTimeText(e.iso), text: e.text }));

  // Echo L2 / Mercury F6: real rows (with their own update time and open differences) when the list read worked.
  const quotationRows =
    rows.quotations && rows.quotations.length > 0
      ? rows.quotations.filter((q) => q.referralDraftId === r.referralDraftId).map(workQuotationRowVM)
      : r.quotations.map((q) => {
          const row = workQuotationRowVM({
            quotationId: q.quotationId,
            reference: q.reference,
            title: q.title,
            subjectKind: 'referral',
            subject: { kind: 'referral', id: r.referralDraftId, reference: r.reference, title: r.customer.customerName },
            referralDraftId: r.referralDraftId,
            draft: { status: r.status, closedReason: r.closedReason, closedAt: r.closedAt, autoClose: r.autoClose, reference: r.reference },
            linkedDealId: q.linkedDealId,
            currentVersion: q.currentVersion,
            accepted: q.accepted,
            converted: q.converted,
            acceptedNotLinked: q.accepted && !q.converted && !q.linkedDealId && !activeDeal,
            customerName: r.customer.customerName,
            destination: null,
            tripStart: null,
            ownerName: r.ownerName,
            ownerIsYou: r.ownerIsYou,
            since: r.lastActivityAt,
          });
          // No update time of its own in the draft read: say nothing rather than the draft's time.
          return { ...row, updatedText: '' };
        });
  const itineraryRows: WorkItineraryRowVM[] =
    rows.itineraries && rows.itineraries.length > 0
      ? rows.itineraries.filter((i) => i.referralDraftId === r.referralDraftId).map(workItineraryRowVM)
      : r.itineraries.map((i) => ({
          documentId: i.documentId,
          title: i.title,
          href: `/app/itineraries/${encodeURIComponent(i.documentId)}`,
          statusText: i.factsStatus === 'ready' ? 'Ready for final PDF' : 'Draft',
          basisText: i.quotationId ? 'From a quotation' : 'Not from a quotation',
          subject: subjectVM(draftSubject),
          draft: state,
          // Mercury F6: the draft read has no difference count; the view says "See the itinerary" (differencesKnown false).
          openDifferences: 0,
          differencesKnown: false,
          ownerName: r.ownerIsYou ? 'You' : r.ownerName,
          updatedText: '',
          finalDownloadHref: null,
        }));
  const accepted = toBook ? quotationRows.find((q) => q.quotationId === toBook.quotationId) : null;

  return {
    referralDraftId: r.referralDraftId,
    reference: r.reference,
    rowVersion: r.rowVersion,
    tab,
    tabs: REFERRAL_DRAFT_TABS.map((t) => ({ tab: t, label: REFERRAL_TAB_LABEL[t], href: referralTabHref(r.referralDraftId, t), current: t === tab })),
    header: {
      title: `${r.customer.customerName} · referral draft`,
      state,
      refLine,
      ownerName: r.ownerIsYou ? 'You' : r.ownerName,
      branchName: r.branchName,
      nextLine,
      // DA-219
      privacyLine: active ? fill(WORK_TEXT.privacyLinked, { kind: active.targetKind, ref: active.reference }) : WORK_TEXT.privacyNotLinked,
      primary,
      // Echo M4: say what the button does (opens the accepted quotation, where the booking starts).
      startBooking: primary === 'start_booking' && toBook ? { label: fill(WORK_TEXT.startBooking, { ref: toBook.reference }), href: accepted?.href ?? `/app/quotations/${encodeURIComponent(toBook.currentVersion.versionId)}` } : null,
    },
    resultNotice,
    defaultTitle: `Trip for ${r.customer.customerName}`.slice(0, 200),
    overview: [
      { label: 'Customer name', value: r.customer.customerName },
      { label: 'Mobile', value: r.customer.mobile ?? WORK_TEXT.notGiven },
      { label: 'Email', value: r.customer.email ?? WORK_TEXT.notGiven },
      { label: 'Company', value: r.customer.companyName ?? WORK_TEXT.notGiven },
      { label: 'How they reached us', value: source ?? WORK_TEXT.notGiven },
      { label: 'Branch', value: r.branchName },
      { label: 'Owner', value: r.ownerIsYou ? 'You' : r.ownerName },
      { label: 'Last activity', value: workDateText(r.lastActivityAt) },
    ],
    quotations: quotationRows,
    itineraries: itineraryRows,
    links: r.links.map(linkVM),
    history,
    can: { ...r.can, addQuotation: r.can.edit && !closed, addItinerary: r.can.edit && !closed },
    switchState: r.switchOn ? 'on' : 'off',
    readOnly: closed,
  };
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

export function referralLinkStepVM(input: {
  kind: 'lead' | 'deal';
  branchName: string;
  query: string;
  /** null = the candidate read failed (Echo M3): the step says so instead of showing nothing. */
  candidates: ReferralLinkCandidate[] | null;
  /** Mercury F4: the draft has an active Lead link (a deal not made from it is refused for that reason). */
  draftLeadLinked?: boolean;
}): ReferralLinkStepVM {
  const candidates: ReferralCandidateVM[] = (input.candidates ?? []).map((c) => {
    const flags: string[] = [];
    if (c.fromLinkedLead) flags.push(WORK_TEXT.linkFlagFromLead);
    if (c.alreadyHasAcceptedQuotation) flags.push(WORK_TEXT.linkFlagAccepted);
    // DA-228 words for the reason a listed record cannot be linked (every listed record is one the person can work on).
    const refusedText = c.linkable
      ? null
      : !c.active
        ? 'That deal is lost or rejected in Bitrix.'
        : c.kind === 'deal' && input.draftLeadLinked && !c.fromLinkedLead
          ? 'That deal was not made from the linked lead in Bitrix.'
          : 'That deal already has an accepted quotation.';
    return { kind: c.kind, id: c.id, reference: c.reference, title: c.title, branchName: c.branchName ?? input.branchName, flags, linkable: c.linkable, refusedText };
  });
  const failed = input.candidates === null;
  return {
    kind: input.kind,
    heading: fill(WORK_TEXT.linkHeading[input.kind], { branch: input.branchName }),
    query: input.query,
    candidates,
    emptyText: !failed && candidates.length === 0 ? WORK_TEXT.linkNone : null,
    confirmTemplate: WORK_TEXT.linkConfirm[input.kind],
    loadError: failed ? WORK_TEXT.linkLoadError : null,
  };
}

export function referralUnlinkFormVM(link: ReferralLinkVM): ReferralUnlinkFormVM {
  return {
    link,
    reasons: (Object.keys(REFERRAL_UNLINK_REASON_LABEL) as Array<keyof typeof REFERRAL_UNLINK_REASON_LABEL>).map((value) => ({ value, label: REFERRAL_UNLINK_REASON_LABEL[value] })),
    confirmText: fill(WORK_TEXT.unlinkConfirm, { ref: link.reference }),
  };
}

export function ownerChoices(candidates: ReferralOwnerCandidate[]): Array<{ userId: string; name: string; current: boolean }> {
  return candidates.map((c) => ({ userId: c.userId, name: c.displayName, current: c.isCurrentOwner }));
}

// ---------------------------------------------------------------------------
// Deal page section (DA-71). Home rows (FP-081) are built in home-view.tsx (Luna) from my_work_counts.
// ---------------------------------------------------------------------------

export function subjectReferralDraftsVM(rows: ReferralSubjectDraft[] | null | 'not_installed' | 'error'): SubjectReferralDraftsVM | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return {
    heading: WORK_TEXT.subjectDraftsHeading,
    note: rows.length > 1 ? WORK_TEXT.subjectDraftsNote : null,
    rows: rows.map((d) => ({
      referralDraftId: d.referralDraftId,
      reference: d.reference,
      customerName: d.customerName,
      href: referralDraftHref(d.referralDraftId),
      state: draftStateVM(d),
      ownerName: d.ownerIsYou ? 'You' : d.ownerName,
      quotationCount: d.quotationCount,
      hasAccepted: d.hasAccepted,
    })),
  };
}
