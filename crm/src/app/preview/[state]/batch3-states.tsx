import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { WORK_TEXT } from '@/modules/quotations/work-model';
import { itineraryBackLink } from '@/modules/quotations/subject-links';
import type { QuotationReferralView } from '@/modules/quotations/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { ItineraryScreen } from '@/views/b12/itin-views';
import { QuotationPage } from '@/views/b12/quote-page';
import { NewWorkScreen, ReferralDraftLoadErrorView, ReferralDraftNotAvailableView, ReferralDraftScreen, SubjectReferralDraftsSection } from '@/views/b12/referral-views';
import type { ReferralActions } from '@/views/b12/referral-forms';
import { ItinerariesListScreen, QuotationsListScreen, WorkListLoading } from '@/views/b12/work-lists';
import { HomeView } from '@/views/staff-views';
import { GALLERY_ITIN_ACTIONS } from './b12-itin-states';
import { itineraryEditor } from './b12-itin-fixtures';
import { QUOTE_SCREENS } from './b12-quote-fixtures';
import { GALLERY_ACTIONS } from './b12-quote-states';
import {
  closedDraftVM,
  CLOSED_QUOTE_ROW,
  DEAL_DRAFTS,
  DRAFT_CUSTOMER,
  draftVM,
  itineraryListPage,
  linkedDraftVM,
  linkStep,
  managerDraftVM,
  newWork,
  OWNER_CANDIDATES,
  PREVIEW_AFTER_COOKIE,
  quotationListPage,
  QUOTE_ROWS,
  READY_TO_BOOK_REFERRAL_ROW,
  SALES_WORK_B3,
} from './batch3-fixtures';
import {
  previewReferralCloseAction,
  previewReferralCreateAction,
  previewReferralCreateOffAction,
  previewReferralDraftClosedAction,
  previewReferralLinkAction,
  previewReferralLinkRefusedAction,
  previewReferralReassignAction,
  previewReferralReopenAction,
  previewReferralReopenAnyAction,
  previewReferralSavedAction,
  previewReferralUnlinkAction,
} from './batch3-preview-actions';

/*
 * Batch 3 preview states (LOCAL DESIGN-REVIEW GALLERY ONLY): Quotations and
 * Itineraries lists, the New quotation / New itinerary choice, the referral
 * draft page and its tabs, linking, closed drafts, the Deal section and the
 * Home rows, on the real views with synthetic view models and stand-in
 * actions. Not evidence of a real journey.
 */

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Jodhpur',
  primaryRole: 'Sales',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeeLeads: true,
  canSeeQuotations: true,
};
const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeePurchaseTasks: true };
const purchase: ShellViewer = { displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeePurchaseTasks: true };

function shell(children: ReactNode, path = '/app/quotations', viewer: ShellViewer = sales) {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {children}
    </StaffShell>
  );
}

const ACTIONS: ReferralActions = {
  save: previewReferralSavedAction,
  close: previewReferralCloseAction,
  reopen: previewReferralReopenAnyAction,
  reassign: previewReferralReassignAction,
  link: previewReferralLinkAction,
  unlink: previewReferralUnlinkAction,
};

function routeLinkStep(vm: ReturnType<typeof draftVM>) {
  const canLink = !vm.links.some((l) => l.active && l.targetKind === 'deal') && vm.can.link && vm.header.state.status === 'open';
  return vm.tab === 'link' && canLink ? linkStep() : null;
}

function draft(vm: ReturnType<typeof draftVM>, extra: Partial<Parameters<typeof ReferralDraftScreen>[0]> = {}, viewer: ShellViewer = sales) {
  return shell(
    <ReferralDraftScreen
      vm={vm}
      actions={extra.actions ?? ACTIONS}
      // Exactly the props the route passes (Echo N2): customer only to editors; a link step only on the Link
      // tab of an open draft that may be linked and has no active deal link.
      customer={vm.can.edit ? DRAFT_CUSTOMER : null}
      quoteCreate={GALLERY_ACTIONS.create}
      itinCreate={GALLERY_ITIN_ACTIONS.create}
      linkStep={routeLinkStep(vm)}
      {...extra}
    />,
    '/app/quotations',
    viewer,
  );
}

/** The closed draft after Reopen: open again, the 90 days restarted. */
function reopenedVM() {
  const base = closedDraftVM('auto');
  const open = draftVM();
  return { ...base, header: { ...open.header, title: base.header.title, refLine: base.header.refLine, state: { ...open.header.state, autoCloseLine: WORK_TEXT.closesOn.replace('{date}', '19 Jan 2027') } }, can: open.can, readOnly: false };
}

function referralQuote(referral: Partial<QuotationReferralView>, base = QUOTE_SCREENS.acceptedWaiting()) {
  const d = base;
  d.version.subject = { kind: 'referral', leadId: null, dealId: null, referralDraftId: 'rd000000-0000-4000-8000-000000000301', reference: 'TD-301', title: 'Sample Customer Mehra', branchCode: 'JDH' };
  d.version.referral = {
    referralDraftId: 'rd000000-0000-4000-8000-000000000301',
    reference: 'TD-301',
    status: 'open',
    closedReason: null,
    closedAt: null,
    autoClose: { state: 'scheduled', dueOn: '2027-01-13' },
    linked: false,
    bound: false,
    activeDealId: null,
    activeLeadId: null,
    canReopen: false,
    canLink: true,
    activeDealReference: null,
    ...referral,
  };
  d.candidates = null;
  return shell(<QuotationPage data={d} actions={GALLERY_ACTIONS} today="2026-10-21" />);
}

/**
 * Revalidate-like preview (lead fix round): after a stand-in action succeeds on `state`, the
 * refresh or redirect that follows renders `after` — what the real page shows once the server
 * has revalidated (forms swapped or gone, the result in a page-level line). Before that, `before`.
 */
async function AfterAction({ state, before, after }: { state: string; before: ReactNode; after: ReactNode }) {
  const done = (await cookies()).get(PREVIEW_AFTER_COOKIE)?.value === state;
  return <>{done ? after : before}</>;
}

function withAfter(state: string, before: () => ReactNode, after: () => ReactNode) {
  return function PreviewWithAfter() {
    return <AfterAction state={state} before={before()} after={after()} />;
  };
}

const LINKED_NOTICE = WORK_TEXT.linked.replace('{ref}', 'D-5109');
const UNLINKED_NOTICE = WORK_TEXT.unlinked.replace('{ref}', 'D-5109');

/** The draft after its active link to D-5109 was removed (the link stays under Earlier links). */
function afterUnlink(base: ReturnType<typeof draftVM>) {
  const linked = linkedDraftVM();
  return {
    ...base,
    tab: 'link' as const,
    tabs: base.tabs.map((t) => ({ ...t, current: t.tab === 'link' })),
    links: linked.links.map((l) => (l.active ? { ...l, active: false, canRemove: false, endedText: 'Removed on 21 Oct 2026: Wrong customer' } : l)),
    resultNotice: UNLINKED_NOTICE,
  };
}

const STATES: Record<string, () => ReactNode> = {
  // Lists (QL, IL)
  'b3-quotations-list': () => shell(<QuotationsListScreen page={quotationListPage()} />),
  'b3-quotations-manager-all': () =>
    shell(<QuotationsListScreen page={quotationListPage({ scopeKey: 'all' })} />, '/app/quotations', manager),
  'b3-quotations-ready-to-book': () => shell(<QuotationsListScreen page={quotationListPage({ filter: 'ready_to_book', rows: [QUOTE_ROWS[0]!, READY_TO_BOOK_REFERRAL_ROW] })} />),
  'b3-quotations-closed-drafts': () =>
    shell(<QuotationsListScreen page={quotationListPage({ filter: 'closed_drafts', rows: [CLOSED_QUOTE_ROW], hiddenClosedLine: null })} />),
  'b3-quotations-reference-hit': () =>
    shell(
      <QuotationsListScreen
        page={quotationListPage({ rows: [CLOSED_QUOTE_ROW], reference: 'TD-298', openByReference: { action: '/app/quotations', value: 'TD-298', missText: null }, hiddenClosedLine: null })}
      />,
    ),
  'b3-quotations-reference-miss': () =>
    shell(
      <QuotationsListScreen
        page={quotationListPage({
          openByReference: { action: '/app/quotations', value: 'TD-999', missText: WORK_TEXT.referenceMiss },
        })}
      />,
    ),
  'b3-quotations-page-2': () =>
    shell(
      <QuotationsListScreen
        page={quotationListPage({
          rows: QUOTE_ROWS.slice(3),
          pager: { firstHref: '/app/quotations', nextHref: null, shown: 2, total: 27, rangeText: 'Showing 2 of 27 quotations (later page)' },
        })}
      />,
    ),
  'b3-quotations-more': () =>
    shell(
      <QuotationsListScreen
        page={quotationListPage({ pager: { firstHref: null, nextHref: '/app/quotations?after=synthetic', shown: 5, total: 27, rangeText: 'Showing 5 of 27 quotations' } })}
      />,
    ),
  'b3-quotations-empty': () => shell(<QuotationsListScreen page={quotationListPage({ rows: [], pager: { firstHref: null, nextHref: null, shown: 0, total: 0, rangeText: 'Showing 0 of 0 quotations' } })} />),
  'b3-quotations-error': () => shell(<QuotationsListScreen page={quotationListPage({ state: 'error', rows: [] })} />),
  'b3-quotations-not-installed': () => shell(<QuotationsListScreen page={quotationListPage({ state: 'not_installed', rows: [] })} />),
  'b3-quotations-not-applicable': () => shell(<QuotationsListScreen page={quotationListPage({ state: 'not_applicable', rows: [], scopeLine: WORK_TEXT.notApplicable })} />, '/app/quotations', purchase),
  'b3-quotations-loading': () => shell(<WorkListLoading kind="quotations" />),
  'b3-itineraries-list': () => shell(<ItinerariesListScreen page={itineraryListPage()} />, '/app/itineraries'),
  'b3-itineraries-empty': () =>
    shell(<ItinerariesListScreen page={itineraryListPage({ rows: [], pager: { firstHref: null, nextHref: null, shown: 0, total: 0, rangeText: 'Showing 0 of 0 itineraries' } })} />, '/app/itineraries'),
  // New quotation / New itinerary (QN, IN)
  'b3-new-quotation-on': () => shell(<NewWorkScreen vm={newWork('quotations', 'on')} createAction={previewReferralCreateAction} />),
  'b3-new-quotation-branches': () =>
    shell(<NewWorkScreen vm={newWork('quotations', 'on', [{ id: 'b-jdh', name: 'Jodhpur' }, { id: 'b-del', name: 'Delhi' }])} createAction={previewReferralCreateAction} />),
  'b3-new-quotation-switched-off-after-load': () => shell(<NewWorkScreen vm={newWork('quotations', 'on')} createAction={previewReferralCreateOffAction} />),
  'b3-new-quotation-off': () => shell(<NewWorkScreen vm={newWork('quotations', 'off')} createAction={previewReferralCreateAction} />),
  'b3-new-quotation-unknown': () => shell(<NewWorkScreen vm={newWork('quotations', 'unknown')} createAction={previewReferralCreateAction} />),
  // Echo-B L4: someone without the Quotations menu item types the address.
  'b3-new-quotation-not-allowed': () => shell(<NewWorkScreen vm={{ ...newWork('quotations', 'on'), allowed: false }} createAction={previewReferralCreateAction} />, '/app/quotations', purchase),
  'b3-new-itinerary-on': () => shell(<NewWorkScreen vm={newWork('itineraries', 'on')} createAction={previewReferralCreateAction} />, '/app/itineraries'),
  // Referral draft page
  'b3-draft-overview': withAfter(
    'b3-draft-overview',
    () => draft(draftVM()),
    () =>
      draft(
        draftVM({
          header: { ...draftVM().header, state: { status: 'closed', closedReason: 'lost', statusText: 'Closed', autoCloseLine: null, autoCloseState: 'none' }, nextLine: 'Next: reopen the draft to make changes', primary: 'reopen' },
          can: { edit: false, close: false, reopen: true, reassign: false, link: false, unlink: true, addQuotation: false, addItinerary: false },
          readOnly: true,
        }),
      ),
  ),
  'b3-draft-quotations': () => draft(draftVM({ tab: 'quotations' })),
  'b3-draft-itineraries': () => draft(draftVM({ tab: 'itineraries' })),
  'b3-draft-link': withAfter('b3-draft-link', () => draft(draftVM({ tab: 'link' })), () => draft({ ...linkedDraftVM(), links: linkedDraftVM().links.slice(0, 1), resultNotice: LINKED_NOTICE })),
  'b3-draft-link-refused': () => draft(draftVM({ tab: 'link' }), { actions: { ...ACTIONS, link: previewReferralLinkRefusedAction } }),
  'b3-draft-link-empty': () => draft(draftVM({ tab: 'link' }), { linkStep: linkStep('deal', true) }),
  'b3-draft-link-lead': () => draft(draftVM({ tab: 'link' }), { linkStep: linkStep('lead') }),
  'b3-draft-linked': withAfter('b3-draft-linked', () => draft(linkedDraftVM()), () => draft(afterUnlink(draftVM()))),
  'b3-draft-history': () => draft(draftVM({ tab: 'history' })),
  // Echo-B M3: the candidate read failed; the tab says so (kind switch and search stay).
  'b3-draft-link-load-error': () => draft(draftVM({ tab: 'link' }), { linkStep: { ...linkStep('deal', true), emptyText: null, loadError: WORK_TEXT.linkLoadError } }),
  // Echo-B L1: the deal link can no longer be removed (a quotation is tied to the deal); the lead step says why.
  'b3-draft-link-locked': () => {
    const linked = linkedDraftVM();
    return draft({ ...linked, links: linked.links.map((l) => ({ ...l, canRemove: false })) });
  },
  // Echo-B M4: accepted quotation and a linked deal: the primary opens that quotation.
  'b3-draft-ready-to-book': () => {
    const linked = linkedDraftVM();
    const accepted = { ...QUOTE_ROWS[2]!, statusWord: 'Accepted' as const };
    return draft({
      ...linked,
      tab: 'overview',
      tabs: linked.tabs.map((t) => ({ ...t, current: t.tab === 'overview' })),
      quotations: [accepted],
      header: { ...linked.header, nextLine: 'Next: start the booking from the accepted quotation', primary: 'start_booking', startBooking: { label: 'Open TQ-7003 to start booking', href: accepted.href } },
    });
  },
  'b3-draft-manager': withAfter(
    'b3-draft-manager',
    () => draft(managerDraftVM(), { ownerCandidates: OWNER_CANDIDATES }, manager),
    () => draft({ ...managerDraftVM(), header: { ...managerDraftVM().header, ownerName: 'Synthetic Sales Jodhpur B' } }, { ownerCandidates: OWNER_CANDIDATES }, manager),
  ),
  'b3-draft-closed': withAfter('b3-draft-closed', () => draft(closedDraftVM('auto')), () => draft(reopenedVM())),
  'b3-draft-closed-duplicate': withAfter(
    'b3-draft-closed-duplicate',
    () => draft(closedDraftVM('duplicate'), { actions: { ...ACTIONS, reopen: previewReferralReopenAction } }),
    () => draft(reopenedVM()),
  ),
  'b3-draft-closed-quotations': () => draft({ ...closedDraftVM('auto'), tab: 'quotations', tabs: closedDraftVM('auto').tabs.map((t) => ({ ...t, current: t.tab === 'quotations' })) }, { actions: { ...ACTIONS, save: previewReferralDraftClosedAction } }),
  // Atlas 21 Oct: a closed draft's wrong link can be removed without reopening (canRemove decides).
  'b3-draft-closed-linked': withAfter(
    'b3-draft-closed-linked',
    () => {
      const closed = closedDraftVM('auto');
      const linked = linkedDraftVM();
      return draft({ ...closed, tab: 'link', tabs: closed.tabs.map((t) => ({ ...t, current: t.tab === 'link' })), links: linked.links, can: { ...closed.can, unlink: true } });
    },
    () => draft(afterUnlink(closedDraftVM('auto'))),
  ),
  'b3-draft-not-available': () => shell(<ReferralDraftNotAvailableView />),
  'b3-draft-load-error': () => shell(<ReferralDraftLoadErrorView />),
  // Deal Quotations tab section (DA-71)
  'b3-deal-referral-drafts': () =>
    shell(
      <>
        <PageHeader eyebrow="D-5109" title="Sample Customer Mehra, Kerala" />
        <SubjectReferralDraftsSection vm={DEAL_DRAFTS} />
      </>,
      '/app/deals',
    ),
  // Quotation editor for referral quotations
  'b3-quote-referral-accepted-unlinked': () => referralQuote({}),
  'b3-quote-referral-accepted-linked': () =>
    referralQuote({ linked: true, activeDealId: 'd0000000-0000-4000-8000-000000005109', activeDealReference: 'D-5109' }, (() => {
      const d = QUOTE_SCREENS.acceptedWaiting();
      d.version.canConvert = true;
      return d;
    })()),
  'b3-quote-referral-closed': () => referralQuote({ status: 'closed', closedReason: 'no_activity', closedAt: '2026-10-02T18:50:00.000Z', autoClose: { state: 'closed', dueOn: '2026-10-02' }, canReopen: true }, QUOTE_SCREENS.draft()),
  // Referral itinerary: nothing to compare with yet (DA-80, DA-81)
  'b3-itin-referral': () => {
    const e = itineraryEditor({
      subject: { kind: 'referral', quotationId: null, dealId: null, referralDraftId: 'rd000000-0000-4000-8000-000000000301' },
      basis: { kind: 'none', id: null, hash: '', label: 'Not from a quotation' },
      pricesIncluded: false,
    });
    return shell(<ItineraryScreen editor={e} actions={GALLERY_ITIN_ACTIONS} {...(() => { const b = itineraryBackLink(e); return { backHref: b.href, backLabel: b.label }; })()} />, '/app/itineraries');
  },
  // Home rows (FP-081)
  'b3-home-sales': () =>
    shell(
      <HomeView
        displayName="Synthetic Sales Jodhpur"
        counts={{ visible: 12, owned: 8, assigned: 2 }}
        roles={{ bookings: true, branchManager: false, purchase: false, flight: false, visa: false, accounts: false, quotations: true }}
        myWork={SALES_WORK_B3}
      />,
      '/app',
    ),
  'b3-home-manager': () =>
    shell(
      <HomeView
        displayName="Synthetic Manager Jodhpur"
        counts={{ visible: 40, owned: 2, assigned: 0 }}
        roles={{ bookings: true, branchManager: true, purchase: true, flight: false, visa: false, accounts: false, quotations: true }}
        myWork={{ ...SALES_WORK_B3, quotationDraftsToFinish: 6, acceptedQuotesToLink: 0 }}
      />,
      '/app',
      manager,
    ),
};

export const BATCH3_STATES = Object.keys(STATES);

export function renderBatch3State(state: string): ReactNode | null {
  return STATES[state]?.() ?? null;
}
