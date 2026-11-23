import type { ListFilterVM } from '@/modules/deals/workspace-contract';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { referralDraftHref } from '@/modules/quotations/subject-links';
import {
  QUOTATION_LIST_FILTERS,
  ITINERARY_LIST_FILTERS,
  REFERRAL_DRAFT_TABS,
  type ItineraryListFilter,
  type ItineraryListPageVM,
  type NewWorkVM,
  type QuotationListFilter,
  type QuotationListPageVM,
  type ReferralDraftStateVM,
  type ReferralDraftTab,
  type ReferralDraftVM,
  type ReferralLinkStepVM,
  type SubjectReferralDraftsVM,
  type WorkItineraryRowVM,
  type WorkListScope,
  type WorkQuotationRowVM,
} from '@/modules/quotations/work-contract';
import type { ReferralCustomerFormVM } from '@/views/b12/referral-forms';
import { REFERRAL_SOURCE_LABEL, WORK_TEXT } from '@/modules/quotations/work-model';

/*
 * Batch 3 preview fixtures (LOCAL DESIGN-REVIEW GALLERY ONLY): synthetic view
 * models in the frozen work-contract.ts shapes, standing in for Terra's
 * builders. Every name, number and reference is made up. No money anywhere.
 */

/** Cookie naming the preview state whose stand-in action "succeeded" (batch3-preview-actions markDone). */
export const PREVIEW_AFTER_COOKIE = 'tn-b3-preview-after';

export const DRAFT_ID = 'rd000000-0000-4000-8000-000000000301';
export const CLOSED_DRAFT_ID = 'rd000000-0000-4000-8000-000000000298';
const DEAL_ID = 'd0000000-0000-4000-8000-000000005109';

const QUOTE_LABEL: Record<QuotationListFilter, string> = {
  open: 'Open',
  to_finish: 'To finish',
  drafts: 'Drafts',
  ready: 'Ready to share',
  shared: 'Shared',
  accepted: 'Accepted',
  accepted_not_linked: 'Accepted, not linked',
  ready_to_book: 'Ready to book',
  declined_or_expired: 'Declined or expired',
  closed_drafts: 'Closed drafts',
  all: 'All',
};
const ITIN_LABEL: Record<ItineraryListFilter, string> = {
  open: 'Open',
  draft: 'Draft',
  ready: 'Ready for final PDF',
  final_made: 'Final PDF made',
  closed_drafts: 'Closed drafts',
  all: 'All',
};

function listHref(kind: 'quotations' | 'itineraries', filter: string, scope: WorkListScope): string {
  const q = new URLSearchParams();
  if (filter !== 'open') q.set('filter', filter);
  if (scope !== 'mine') q.set('scope', scope);
  const qs = q.toString();
  return qs ? `/app/${kind}?${qs}` : `/app/${kind}`;
}

/** Fixture-only options are not view-model keys. */
function strip<T extends { filter?: unknown; scopeKey?: unknown; showClosedChip?: unknown }>(over: T): Omit<T, 'filter' | 'scopeKey' | 'showClosedChip'> {
  const { filter: _f, scopeKey: _s, showClosedChip: _c, ...rest } = over;
  void _f;
  void _s;
  void _c;
  return rest;
}

const STATE_OPEN_SCHEDULED: ReferralDraftStateVM = {
  status: 'open',
  closedReason: null,
  statusText: 'Open',
  autoCloseLine: WORK_TEXT.closesOn.replace('{date}', '13 Jan 2027'),
  autoCloseState: 'scheduled',
};
const STATE_OPEN_PAUSED: ReferralDraftStateVM = {
  status: 'open',
  closedReason: null,
  statusText: 'Open',
  autoCloseLine: WORK_TEXT.autoClosePaused,
  autoCloseState: 'paused',
};
const STATE_CLOSED_AUTO: ReferralDraftStateVM = {
  status: 'closed',
  closedReason: 'no_activity',
  statusText: 'Closed after 90 days without activity',
  autoCloseLine: WORK_TEXT.closedAutomatically.replace('{date}', '2 Oct 2026'),
  autoCloseState: 'closed',
};
const STATE_CLOSED_DUPLICATE: ReferralDraftStateVM = { status: 'closed', closedReason: 'duplicate', statusText: 'Closed', autoCloseLine: null, autoCloseState: 'none' };
// DA-216: the link state is in the reference line, not in the status word.
const STATE_LINKED: ReferralDraftStateVM = { status: 'open', closedReason: null, statusText: 'Open', autoCloseLine: WORK_TEXT.closesOn.replace('{date}', '13 Jan 2027'), autoCloseState: 'scheduled' };

export const QUOTE_ROWS: WorkQuotationRowVM[] = [
  {
    quotationId: 'q1',
    reference: 'TQ-7001',
    title: 'Ranthambore safari, Patel family',
    href: '/app/quotations/qv000000-0000-4000-8000-000000007001',
    versionNo: 2,
    statusWord: 'Accepted',
    subject: { kind: 'deal', text: 'Deal D-5103', href: '/app/deals/d0000000-0000-4000-8000-000000005103' },
    draft: null,
    customerName: 'Sample Customer Patel',
    destination: 'Ranthambore',
    tripStartText: 'from 12 Nov 2026',
    validUntilText: '28 Oct 2026',
    ownerName: 'Synthetic Sales Jodhpur',
    ownerIsYou: true,
    updatedText: 'Today, 10:20',
    action: { kind: 'start_booking', label: 'Start booking', href: '/app/quotations/qv000000-0000-4000-8000-000000007001' },
  },
  {
    quotationId: 'q2',
    reference: 'TQ-7002',
    title: 'Dubai shopping trip, Qureshi',
    href: '/app/quotations/qv000000-0000-4000-8000-000000007002',
    versionNo: 1,
    statusWord: 'Not started',
    subject: { kind: 'lead', text: 'Lead L-3104', href: '/app/leads/l0000000-0000-4000-8000-000000003104' },
    draft: null,
    customerName: 'Sample Customer Qureshi',
    destination: 'Dubai',
    tripStartText: null,
    validUntilText: null,
    ownerName: 'Synthetic Sales Jodhpur',
    ownerIsYou: true,
    updatedText: 'Yesterday',
    action: { kind: 'continue', label: 'Continue', href: '/app/quotations/qv000000-0000-4000-8000-000000007002' },
  },
  {
    quotationId: 'q3',
    reference: 'TQ-7003',
    title: 'Kerala backwaters, Mehra couple',
    href: '/app/quotations/qv000000-0000-4000-8000-000000007003',
    versionNo: 1,
    statusWord: 'Draft',
    subject: { kind: 'referral', text: 'Referral draft TD-301 · not linked to Bitrix yet', href: referralDraftHref(DRAFT_ID) },
    draft: STATE_OPEN_SCHEDULED,
    customerName: 'Sample Customer Mehra',
    destination: 'Kerala',
    tripStartText: 'from 3 Dec 2026',
    validUntilText: null,
    ownerName: 'Synthetic Sales Jodhpur',
    ownerIsYou: true,
    updatedText: '16 Oct 2026',
    action: { kind: 'continue', label: 'Continue', href: '/app/quotations/qv000000-0000-4000-8000-000000007003' },
  },
  {
    quotationId: 'q4',
    reference: 'TQ-7004',
    title: 'Goa long weekend, Verma',
    href: '/app/quotations/qv000000-0000-4000-8000-000000007004',
    versionNo: 3,
    statusWord: 'Accepted',
    subject: { kind: 'referral', text: 'Referral draft TD-305 · not linked to Bitrix yet', href: referralDraftHref('rd000000-0000-4000-8000-000000000305') },
    draft: STATE_OPEN_SCHEDULED,
    customerName: 'Sample Customer Verma',
    destination: 'Goa',
    tripStartText: 'from 20 Nov 2026',
    validUntilText: '25 Oct 2026',
    ownerName: 'Synthetic Sales Jodhpur',
    ownerIsYou: true,
    updatedText: '18 Oct 2026',
    action: { kind: 'link_to_deal', label: 'Link to deal', href: `${referralDraftHref('rd000000-0000-4000-8000-000000000305')}?tab=link` },
  },
  {
    quotationId: 'q5',
    reference: 'TQ-6990',
    title: 'Shimla family holiday, Iyer',
    href: '/app/quotations/qv000000-0000-4000-8000-000000006990',
    versionNo: 2,
    statusWord: 'Shared with customer',
    subject: { kind: 'deal', text: 'Deal D-5098', href: '/app/deals/d0000000-0000-4000-8000-000000005098' },
    draft: null,
    customerName: 'Sample Customer Iyer',
    destination: 'Shimla',
    tripStartText: 'from 1 Dec 2026',
    validUntilText: '24 Oct 2026',
    ownerName: 'Synthetic Sales Jodhpur B',
    ownerIsYou: false,
    updatedText: '14 Oct 2026',
    action: { kind: 'open', label: 'Open', href: '/app/quotations/qv000000-0000-4000-8000-000000006990' },
  },
];

/** Accepted referral quotation whose draft is linked to the confirmed deal: ready to book (Terra filter ready_to_book). */
export const READY_TO_BOOK_REFERRAL_ROW: WorkQuotationRowVM = {
  quotationId: 'q6',
  reference: 'TQ-7010',
  title: 'Coorg coffee trail, Nair',
  href: '/app/quotations/qv000000-0000-4000-8000-000000007010',
  versionNo: 1,
  statusWord: 'Accepted',
  subject: { kind: 'referral', text: 'Referral draft TD-306 · linked to deal D-5120', href: referralDraftHref('rd000000-0000-4000-8000-000000000306') },
  draft: STATE_LINKED,
  customerName: 'Sample Customer Nair',
  destination: 'Coorg',
  tripStartText: 'from 8 Dec 2026',
  validUntilText: '27 Oct 2026',
  ownerName: 'Synthetic Sales Jodhpur',
  ownerIsYou: true,
  updatedText: '20 Oct 2026',
  action: { kind: 'start_booking', label: 'Start booking', href: '/app/quotations/qv000000-0000-4000-8000-000000007010' },
};

export const CLOSED_QUOTE_ROW: WorkQuotationRowVM = {
  quotationId: 'q9',
  reference: 'TQ-6950',
  title: 'Ladakh bike trip, Sandhu',
  href: '/app/quotations/qv000000-0000-4000-8000-000000006950',
  versionNo: 1,
  statusWord: 'Draft',
  subject: { kind: 'referral', text: 'Referral draft TD-298 · not linked to Bitrix yet', href: referralDraftHref(CLOSED_DRAFT_ID) },
  draft: STATE_CLOSED_AUTO,
  customerName: 'Sample Customer Sandhu',
  destination: 'Ladakh',
  tripStartText: null,
  validUntilText: null,
  ownerName: 'Synthetic Sales Jodhpur',
  ownerIsYou: true,
  updatedText: '4 Jul 2026',
  action: { kind: 'reopen', label: 'Reopen draft', href: referralDraftHref(CLOSED_DRAFT_ID) },
};

const QUOTE_COUNTS: Record<QuotationListFilter, number> = { open: 5, to_finish: 2, drafts: 2, ready: 0, shared: 1, accepted: 3, accepted_not_linked: 1, ready_to_book: 2, declined_or_expired: 1, closed_drafts: 1, all: 7 };
const SHOWN_QUOTE_CHIPS: QuotationListFilter[] = ['open', 'drafts', 'ready', 'shared', 'accepted', 'ready_to_book', 'accepted_not_linked', 'declined_or_expired', 'closed_drafts'];

export function quotationListPage(over: Omit<Partial<QuotationListPageVM>, 'scope'> & { filter?: QuotationListFilter; scopeKey?: WorkListScope; showClosedChip?: boolean } = {}): QuotationListPageVM {
  const filter = over.filter ?? 'open';
  const scope = over.scopeKey ?? 'mine';
  const chips: ListFilterVM<QuotationListFilter>[] = SHOWN_QUOTE_CHIPS.filter((f) => f !== 'closed_drafts' || over.showClosedChip !== false).map((f) => ({
    filter: f,
    label: QUOTE_LABEL[f],
    count: QUOTE_COUNTS[f],
    href: listHref('quotations', f, scope),
    current: f === filter,
  }));
  void QUOTATION_LIST_FILTERS;
  const rows = over.rows ?? QUOTE_ROWS;
  return {
    kind: 'quotations',
    state: 'ok',
    scopeLine: WORK_TEXT.scopeLine.quotations[scope],
    scope: { current: scope, mineHref: listHref('quotations', filter, 'mine'), allHref: listHref('quotations', filter, 'all') },
    filters: { chips, scopeText: WORK_TEXT.countScope },
    rows,
    pager: { firstHref: null, nextHref: null, shown: rows.length, total: rows.length, rangeText: `Showing ${rows.length} of ${rows.length} quotations` },
    reference: null,
    openByReference: { action: '/app/quotations', value: '', missText: null },
    hiddenClosedLine: WORK_TEXT.hiddenClosed,
    pageSearch: true,
    empty: WORK_TEXT.empty.quotations,
    newHref: '/app/quotations/new',
    ...strip(over),
  };
}

export const ITIN_ROWS: WorkItineraryRowVM[] = [
  {
    documentId: 'i1',
    title: 'Ranthambore safari, day by day',
    href: '/app/itineraries/id000000-0000-4000-8000-000000000001',
    statusText: 'Ready for final PDF',
    basisText: 'From TQ-7001 v2',
    subject: { kind: 'deal', text: 'Deal D-5103', href: '/app/deals/d0000000-0000-4000-8000-000000005103' },
    draft: null,
    openDifferences: 0,
    // Echo L9: own rows say "Owner: you" (work-model maps ownerIsYou to 'You').
    ownerName: 'You',
    updatedText: 'Today, 09:40',
    finalDownloadHref: null,
  },
  {
    documentId: 'i2',
    title: 'Kerala backwaters plan',
    href: '/app/itineraries/id000000-0000-4000-8000-000000000002',
    statusText: 'Draft',
    basisText: 'Not from a quotation',
    subject: { kind: 'referral', text: 'Referral draft TD-301 · not linked to Bitrix yet', href: referralDraftHref(DRAFT_ID) },
    draft: STATE_OPEN_SCHEDULED,
    openDifferences: 0,
    ownerName: 'Synthetic Sales Jodhpur',
    updatedText: '16 Oct 2026',
    finalDownloadHref: null,
  },
  {
    documentId: 'i3',
    title: 'Shimla family holiday',
    href: '/app/itineraries/id000000-0000-4000-8000-000000000003',
    statusText: 'Draft',
    basisText: 'From the booking',
    subject: { kind: 'deal', text: 'Deal D-5098', href: '/app/deals/d0000000-0000-4000-8000-000000005098' },
    draft: null,
    openDifferences: 2,
    ownerName: 'Synthetic Sales Jodhpur B',
    updatedText: '14 Oct 2026',
    finalDownloadHref: null,
  },
  {
    documentId: 'i4',
    title: 'Udaipur weekend',
    href: '/app/itineraries/id000000-0000-4000-8000-000000000004',
    statusText: 'Final PDF made',
    basisText: 'From TQ-6970 v1',
    subject: { kind: 'deal', text: 'Deal D-5080', href: '/app/deals/d0000000-0000-4000-8000-000000005080' },
    draft: null,
    openDifferences: 0,
    ownerName: 'Synthetic Sales Jodhpur',
    updatedText: '2 Oct 2026',
    finalDownloadHref: '/preview/b3-itineraries-list',
  },
];

const ITIN_COUNTS: Record<ItineraryListFilter, number> = { open: 3, draft: 2, ready: 1, final_made: 1, closed_drafts: 0, all: 4 };

export function itineraryListPage(over: Omit<Partial<ItineraryListPageVM>, 'scope'> & { filter?: ItineraryListFilter; scopeKey?: WorkListScope } = {}): ItineraryListPageVM {
  const filter = over.filter ?? 'open';
  const scope = over.scopeKey ?? 'mine';
  const chips = ITINERARY_LIST_FILTERS.filter((f) => f !== 'all').map((f) => ({ filter: f, label: ITIN_LABEL[f], count: ITIN_COUNTS[f], href: listHref('itineraries', f, scope), current: f === filter }));
  const rows = over.rows ?? ITIN_ROWS;
  return {
    kind: 'itineraries',
    state: 'ok',
    scopeLine: WORK_TEXT.scopeLine.itineraries[scope],
    scope: { current: scope, mineHref: listHref('itineraries', filter, 'mine'), allHref: listHref('itineraries', filter, 'all') },
    filters: { chips, scopeText: WORK_TEXT.countScope },
    rows,
    pager: { firstHref: null, nextHref: null, shown: rows.length, total: 4, rangeText: `Showing ${rows.length} of 4 itineraries` },
    reference: null,
    openByReference: { action: '/app/itineraries', value: '', missText: null },
    hiddenClosedLine: WORK_TEXT.hiddenClosed,
    pageSearch: true,
    empty: WORK_TEXT.empty.itineraries,
    newHref: '/app/itineraries/new',
    ...strip(over),
  };
}

export function newWork(kind: 'quotations' | 'itineraries', state: NewWorkVM['referral']['state'], branches = [{ id: 'b-jdh', name: 'Jodhpur' }]): NewWorkVM {
  return {
    kind,
    fromBitrix: {
      text: WORK_TEXT.fromBitrix[kind],
      leadsHref: kind === 'quotations' ? '/app/leads' : null,
      dealsHref: '/app/deals',
    },
    referral: {
      state,
      line: state === 'off' ? WORK_TEXT.switchOff : state === 'unknown' ? WORK_TEXT.switchUnknown : null,
      titleHint: WORK_TEXT.titleHint[kind],
      branches,
      sourceKinds: (Object.keys(REFERRAL_SOURCE_LABEL) as Array<keyof typeof REFERRAL_SOURCE_LABEL>).map((value) => ({ value, label: REFERRAL_SOURCE_LABEL[value] })),
    },
  };
}

const TAB_LABEL: Record<ReferralDraftTab, string> = { overview: 'Overview', quotations: 'Quotations', itineraries: 'Itineraries', link: 'Link to Bitrix', history: 'History' };

export function draftVM(over: Partial<ReferralDraftVM> & { tab?: ReferralDraftTab; draftId?: string } = {}): ReferralDraftVM {
  const draftId = over.draftId ?? DRAFT_ID;
  const tab = over.tab ?? 'overview';
  const base = referralDraftHref(draftId);
  return {
    referralDraftId: draftId,
    reference: 'TD-301',
    rowVersion: 4,
    tab,
    tabs: REFERRAL_DRAFT_TABS.map((t) => ({ tab: t, label: TAB_LABEL[t], href: t === 'overview' ? base : `${base}?tab=${t}`, current: t === tab })),
    header: {
      title: 'Sample Customer Mehra · referral draft',
      state: STATE_OPEN_SCHEDULED,
      refLine: 'Referral draft TD-301 · not linked to Bitrix yet',
      ownerName: 'You',
      branchName: 'Jodhpur',
      nextLine: 'Next: link this draft to the Bitrix lead or deal once it exists. Booking needs the confirmed deal.',
      privacyLine: WORK_TEXT.privacyNotLinked,
      primary: 'link',
    },
    overview: [
      { label: 'Customer name', value: 'Sample Customer Mehra' },
      { label: 'Mobile', value: '+91 55555 00301' },
      { label: 'Email', value: null },
      { label: 'Company', value: null },
      { label: 'How they reached us', value: 'Referral' },
      { label: 'Who referred them', value: 'Sample past customer' },
      { label: 'Branch', value: 'Jodhpur' },
      { label: 'Last activity', value: '16 Oct 2026' },
    ],
    quotations: [QUOTE_ROWS[2]!],
    // Mercury F6: the draft read has no difference count.
    itineraries: [{ ...ITIN_ROWS[1]!, differencesKnown: false }],
    links: [],
    history: [
      { at: '16 Oct 2026, 11:05 · You', text: 'Quotation TQ-7003 added.' },
      { at: '15 Oct 2026, 16:40 · You', text: 'Referral draft TD-301 created. Nothing was sent and nothing is in Bitrix.' },
    ],
    can: { edit: true, close: true, reopen: false, reassign: false, link: true, unlink: true, addQuotation: true, addItinerary: true },
    switchState: 'on',
    readOnly: false,
    defaultTitle: 'Trip for Sample Customer Mehra',
    ...over,
  };
}

export const DRAFT_CUSTOMER: ReferralCustomerFormVM = {
  customerName: 'Sample Customer Mehra',
  mobile: '5555500301',
  email: null,
  companyName: null,
  sourceKind: 'referral',
  sourceNote: 'Sample past customer',
};

export function linkStep(kind: 'deal' | 'lead' = 'deal', empty = false): ReferralLinkStepVM {
  return {
    kind,
    heading: WORK_TEXT.linkHeading[kind].replace('{branch}', 'Jodhpur'),
    query: '',
    candidates: empty
      ? []
      : kind === 'deal'
        ? [
            { kind: 'deal', id: DEAL_ID, reference: 'D-5109', title: 'Sample Customer Mehra, Kerala', branchName: 'Jodhpur', flags: ['Made from the linked lead'], linkable: true, refusedText: null },
            { kind: 'deal', id: 'd0000000-0000-4000-8000-000000005110', reference: 'D-5110', title: 'Sample Customer Mehta, Munnar', branchName: 'Jodhpur', flags: [], linkable: true, refusedText: null },
            { kind: 'deal', id: 'd0000000-0000-4000-8000-000000005090', reference: 'D-5090', title: 'Sample Customer Mehra, Goa', branchName: 'Jodhpur', flags: ['Already has an accepted quotation'], linkable: false, refusedText: 'That deal already has an accepted quotation.' },
          ]
        : [{ kind: 'lead', id: 'l0000000-0000-4000-8000-000000003120', reference: 'L-3120', title: 'Sample Customer Mehra', branchName: 'Jodhpur', flags: [], linkable: true, refusedText: null }],
    emptyText: empty ? WORK_TEXT.linkNone : null,
    confirmTemplate: WORK_TEXT.linkConfirm[kind],
  };
}

export function linkedDraftVM(): ReferralDraftVM {
  return draftVM({
    tab: 'link',
    header: {
      ...draftVM().header,
      state: STATE_LINKED,
      refLine: 'Referral draft TD-301 · linked to deal D-5109',
      nextLine: 'Next: open the quotation to see its next step',
      privacyLine: WORK_TEXT.privacyLinked.replace('{kind}', 'deal').replace('{ref}', 'D-5109'),
      primary: null,
    },
    links: [
      { linkId: 'lk1', targetKind: 'deal', reference: 'D-5109', title: 'Sample Customer Mehra, Kerala', href: `/app/deals/${DEAL_ID}`, active: true, linkedText: 'Linked on 18 Oct 2026 by you', endedText: null, canRemove: true },
      { linkId: 'lk0', targetKind: 'deal', reference: 'D-5110', title: null, href: null, active: false, linkedText: 'Linked on 17 Oct 2026 by you', endedText: 'Removed on 18 Oct 2026: Wrong customer', canRemove: false },
    ],
  });
}

export function closedDraftVM(kind: 'auto' | 'duplicate' = 'auto'): ReferralDraftVM {
  const state = kind === 'auto' ? STATE_CLOSED_AUTO : STATE_CLOSED_DUPLICATE;
  return draftVM({
    draftId: CLOSED_DRAFT_ID,
    reference: 'TD-298',
    header: {
      ...draftVM().header,
      title: 'Sample Customer Sandhu · referral draft',
      state,
      refLine: 'Referral draft TD-298 · not linked to Bitrix yet',
      nextLine: 'Next: reopen the draft to make changes',
      primary: 'reopen',
    },
    quotations: [CLOSED_QUOTE_ROW],
    itineraries: [],
    history: [
      kind === 'auto'
        ? { at: '2 Oct 2026, 00:20', text: 'Closed automatically after 90 days without activity. Nothing was deleted.' }
        : { at: '2 Oct 2026, 12:10 · Synthetic Manager Jodhpur', text: 'Closed: Duplicate. Same customer as TD-290.' },
      { at: '4 Jul 2026, 10:00 · You', text: 'Referral draft TD-298 created.' },
    ],
    can: { edit: false, close: false, reopen: true, reassign: false, link: false, unlink: false, addQuotation: false, addItinerary: false },
    readOnly: true,
  });
}

export function managerDraftVM(): ReferralDraftVM {
  return draftVM({
    header: { ...draftVM().header, ownerName: 'Synthetic Sales Jodhpur', state: STATE_OPEN_PAUSED },
    can: { edit: true, close: true, reopen: false, reassign: true, link: true, unlink: true, addQuotation: true, addItinerary: true },
    switchState: 'off',
  });
}

export const OWNER_CANDIDATES = [
  { userId: 'u1', displayName: 'Synthetic Sales Jodhpur B' },
  { userId: 'u2', displayName: 'Synthetic Sales Jodhpur C' },
];

export const DEAL_DRAFTS: SubjectReferralDraftsVM = {
  heading: 'Referral drafts for this deal',
  note: 'Only one quotation per deal can be accepted. Close the others as duplicates.',
  rows: [
    { referralDraftId: DRAFT_ID, reference: 'TD-301', customerName: 'Sample Customer Mehra', href: referralDraftHref(DRAFT_ID), state: STATE_LINKED, ownerName: 'Synthetic Sales Jodhpur', quotationCount: 1, hasAccepted: true },
    { referralDraftId: 'rd2', reference: 'TD-303', customerName: 'Sample Customer Mehra (wife)', href: referralDraftHref('rd2'), state: STATE_LINKED, ownerName: null, quotationCount: 2, hasAccepted: false },
  ],
};

export const SALES_WORK_B3: MyWorkCounts = {
  waitingForMe: 3,
  returnedToMe: 1,
  missingDetails: 2,
  intakeNeeded: 0,
  receiptsToVerify: null,
  requestsToApprove: null,
  claimsToProcess: null,
  expensesToReview: null,
  visaTasksWaiting: null,
  draftsToContinue: 3,
  quotationDraftsToFinish: 2,
  acceptedQuotesToLink: 1,
};
