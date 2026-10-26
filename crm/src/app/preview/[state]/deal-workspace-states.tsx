import type { ReactNode } from 'react';
import type { DealDetail } from '@/modules/deals/dto';
import { bitrixNameKey, dealStageEntity } from '@/modules/deals/list-model';
import type { DealWorkspaceInput } from '@/modules/deals/workspace';
import type { DealTab } from '@/modules/deals/workspace-contract';
import type { BookNowView } from '@/modules/fulfilment/contracts';
import { StartBookNowForm } from '@/views/b11/book-entry-forms';
import { SubjectQuotationsCard } from '@/views/b12/quote-page';
import { DealServicesEmpty, DealServicesUnavailable } from '@/views/deal-services-view';
import { DealWorkspaceView } from '@/views/deal-workspace/workspace';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { previewServicesTabCard, previewServicesView } from './b1-states';
import { CLAIMS_EMPTY, draftView } from './b11-fixtures';
import { previewB11SavedAction } from './b11-preview-actions';
import { previewQuoteSavedAction } from './b12-preview-actions';
import { quoteList } from './b12-quote-fixtures';
import { PREVIEW_DOCUMENT_ROWS, previewBuiltDeal, previewWorkspaceFromDetail } from './batch1-fixtures';
import { PreviewLiveIndicator } from './preview-live';

/*
 * Direction A Batch 1: Deal workspace (DE-02) review states. Every state is
 * built by the route's own builder (buildDealWorkspace) from synthetic reads
 * (Echo M2): the gallery cannot show a status, Next line or primary action the
 * route would not produce. Families:
 *   ws-deal-sales[-tab]     Sales owner (price reader) with a booking draft.
 *   ws-deal-purchase[-tab]  Purchase assignee: own-task status, no Money, no
 *                           Quotations, no Lead link, honest empty History.
 *   ws-deal-noprice[-tab]   Branch Manager not on the deal: can work the
 *                           booking, no price access (Mercury MPS §7 ruling:
 *                           assisting Sales always have price access).
 *   ws-deal-manager[-tab]   Branch Manager assigned to the deal (price reader).
 *   ws-deal-state-*         One state per primary action (DA-20 to DA-31).
 *   ws-deal-error-*         One tab that could not be loaded (SH-06).
 */

const sales: ShellViewer = { displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canAdministerStaff: false, canManageGrants: false, canSeeLeads: true };
const purchase: ShellViewer = { ...sales, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', primaryBranch: 'Jodhpur', canSeeLeads: false, canSeePurchaseTasks: true };
const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', canSeePurchaseTasks: true };

const WS_DEAL_ID = 'd5102000-0000-4000-8000-000000000001';
const LEAD_LINK = { href: '/preview/p6-lead-sales', reference: 'BXL-700601' };

/** The synthetic Deal as getVisibleDeal returns it for a Sales owner (real deals carry no deal value). */
const salesDeal: DealDetail = {
  id: WS_DEAL_ID,
  reference: 'BX-905102',
  title: 'Synthetic family holiday, Goa',
  branchName: 'Delhi',
  relation: 'owner',
  createdOn: '2026-10-01',
  ownerName: null,
  assignments: [
    { kind: 'sales', isYou: true },
    { kind: 'purchase', isYou: false },
  ],
  commercial: { visible: false },
  commercialAbsence: 'not_recorded',
  source: { system: 'bitrix', sourceDealId: '905102', stageId: 'C1:UC_SYN4', lastSyncedAt: '2026-10-01T09:15:00Z', lastVerifiedAt: '2026-10-01T09:50:00Z', stale: false },
};
const withheld = (over: Partial<DealDetail>): DealDetail => ({ ...salesDeal, commercial: { visible: false }, commercialAbsence: 'withheld', ...over });

const CLAIM = { ...CLAIMS_EMPTY.claims[0], claimId: 'cl-preview-1', status: 'reported' as const, displayStatus: 'reported' as const, amountPaise: '5000000', mode: 'upi' as const, reference: null, chequeNumber: null, chequeDate: null, paidOn: '2026-10-15', payerName: 'Sample Customer A', note: null, destinationLabel: null, receiptAmountPaise: null, notReceivedReason: null, reportedByName: 'Synthetic Sales Delhi A', reportedAt: '2026-10-15T06:30:00.000Z', rowVersion: 1, canWithdraw: true };

/** A draft with one thing to finish, a payment plan, one reported payment and a returned earlier version. */
const salesDraft: BookNowView = draftView({
  dealId: WS_DEAL_ID,
  claims: { ...CLAIMS_EMPTY, dealId: WS_DEAL_ID, reportedPaise: '5000000', claims: [CLAIM] },
  history: [
    { versionId: 'v2', versionNo: 2, status: 'draft', confirmedAt: null, revisesVersionId: 'v1', changeClass: 'customer_material', changedFields: [], reviewStatus: null, reviewReason: null, reviewReasonHidden: false, supersededAt: null, sellingTotalPaise: '12000000', sellingTotalDeltaPaise: '500000' },
    { versionId: 'v1', versionNo: 1, status: 'confirmed', confirmedAt: '2026-10-08T10:00:00.000Z', revisesVersionId: null, changeClass: null, changedFields: [], reviewStatus: 'returned', reviewReason: 'Synthetic: add the second traveller’s date of birth.', reviewReasonHidden: false, supersededAt: null, sellingTotalPaise: '11500000', sellingTotalDeltaPaise: null },
  ],
});
const confirmedVersion = { ...draftView().version!, status: 'confirmed' as const };
const submitted = (over: Partial<BookNowView> = {}): BookNowView => draftView({ dealId: WS_DEAL_ID, version: confirmedVersion, canEdit: false, canSubmit: false, checklist: [], accountsReview: { status: 'pending', reviewedAt: null, reason: null, reasonHidden: false }, ...over });

/** An accepted quotation on this Deal, not yet turned into a booking. */
const acceptedQuotations = quoteList({ subjectKind: 'deal', subjectId: WS_DEAL_ID });
acceptedQuotations.quotations = acceptedQuotations.quotations.map((q) => ({ ...q, reference: 'TQ-1042', dealId: WS_DEAL_ID, acceptedVersionId: q.currentVersionId }));

const NAMED = { state: 'on' as const, names: new Map([[bitrixNameKey(dealStageEntity('C1:WON'), 'C1:WON'), { name: 'Won - Payment Received', missing: false }]]) };

const realQuotations = (deal: DealDetail) => (
  <SubjectQuotationsCard list={quoteList({ subjectKind: 'deal', subjectId: deal.id })} subjectId={deal.id} defaultTitle={deal.title} createAction={previewQuoteSavedAction} createVariant="secondary" />
);
const startForm = <StartBookNowForm dealId={WS_DEAL_ID} action={previewB11SavedAction} continueHref="/preview/b11-book-travellers" label="Start booking" />;

type Read = Omit<DealWorkspaceInput, 'tab' | 'dealId' | 'book' | 'legacyBooking' | 'services' | 'quotations' | 'itinerariesReadable' | 'leadLink'> &
  Partial<Pick<DealWorkspaceInput, 'book' | 'legacyBooking' | 'services' | 'quotations' | 'itinerariesReadable' | 'leadLink'>>;

// Built lazily: b1-states imports this module too, so its fixtures are not ready at module load.
const family = (): Record<string, { viewer: ShellViewer; read: Read; servicesFor: 'sales' | 'purchase' | 'sales-draft' }> => ({
  'ws-deal-sales': {
    viewer: sales,
    servicesFor: 'sales-draft',
    read: { deal: salesDeal, book: { state: 'ok', view: { ...salesDraft, progress: previewServicesView('sales-draft').progress } }, services: { ok: true, view: previewServicesView('sales-draft') }, quotations: quoteList({ subjectKind: 'deal', subjectId: WS_DEAL_ID }), itinerariesReadable: true, leadLink: LEAD_LINK, documents: PREVIEW_DOCUMENT_ROWS, documentsAvailable: true },
  },
  'ws-deal-purchase': {
    viewer: purchase,
    servicesFor: 'purchase',
    read: {
      deal: withheld({ relation: 'assigned', ownerName: 'Synthetic Sales Delhi A', assignments: [{ kind: 'sales', isYou: false }, { kind: 'purchase', isYou: true }] }),
      services: { ok: true, view: previewServicesView('purchase') },
      // DEC-41: a Purchase assignee may open ID proofs of its deal; never customer acceptance or payment proof.
      documents: PREVIEW_DOCUMENT_ROWS.filter((r) => r.kind === 'id_proof').map((r) => ({ ...r, href: '/preview/ws-deal-purchase-documents' })),
      documentsAvailable: true,
    },
  },
  'ws-deal-noprice': {
    viewer: manager,
    servicesFor: 'sales-draft',
    read: {
      deal: withheld({ relation: 'scope', ownerName: 'Synthetic Sales Delhi B', assignments: [{ kind: 'sales', isYou: false }] }),
      book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, commercials: undefined, plan: undefined, claims: undefined, canEditCommercials: false, progress: previewServicesView('sales-draft').progress }) },
      services: { ok: true, view: previewServicesView('sales-draft') },
      quotations: quoteList({ subjectKind: 'deal', subjectId: WS_DEAL_ID }),
      itinerariesReadable: true,
      leadLink: LEAD_LINK,
      documents: PREVIEW_DOCUMENT_ROWS,
      documentsAvailable: true,
    },
  },
  'ws-deal-manager': {
    viewer: manager,
    servicesFor: 'sales',
    read: {
      deal: { ...salesDeal, relation: 'assigned', ownerName: 'Synthetic Sales Delhi A', assignments: [{ kind: 'sales', isYou: false }, { kind: 'manager', isYou: true }], source: { ...salesDeal.source!, stageId: 'C1:WON' } },
      book: { state: 'ok', view: submitted({ accountsReview: { status: 'approved', reviewedAt: '2026-10-12T11:00:00.000Z', reason: null, reasonHidden: false }, items: salesDraft.items, progress: previewServicesView('sales').progress }) },
      services: { ok: true, view: previewServicesView('sales') },
      quotations: quoteList({ subjectKind: 'deal', subjectId: WS_DEAL_ID }),
      itinerariesReadable: true,
      leadLink: LEAD_LINK,
      names: NAMED,
      documents: PREVIEW_DOCUMENT_ROWS,
      documentsAvailable: true,
    },
  },
});

const TABS: DealTab[] = ['overview', 'services', 'quotations', 'documents', 'money', 'history'];

function familyState(state: string): ReactNode | null {
  for (const [stem, fam] of Object.entries(family())) {
    const tab: DealTab | null = state === stem ? 'overview' : TABS.find((t) => state === `${stem}-${t}`) ?? null;
    if (!tab) continue;
    // The builder parses the tab like the route: a tab this viewer may not open renders Overview.
    const ws = previewBuiltDeal({ ...fam.read, stem, tab });
    const current = ws.current;
    return (
      <StaffShell viewer={fam.viewer} currentPath="/app/deals">
        <DealWorkspaceView
          workspace={ws}
          live={<PreviewLiveIndicator />}
          servicesTab={current === 'services' ? previewServicesTabCard(fam.servicesFor) : undefined}
          quotationsTab={current === 'quotations' ? realQuotations(fam.read.deal) : undefined}
        />
      </StaffShell>
    );
  }
  return null;
}

/** One header state per primary action (copy §16.3), Overview tab, Sales owner unless noted. */
const states = (): Record<string, Read> => ({
  'ws-deal-state-not-started': {
    deal: salesDeal,
    book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [], stage: { stageId: 'C1:UC_SYN4', label: null, isTriggerStage: false } }) },
  },
  'ws-deal-state-not-started-read-only': {
    deal: { ...salesDeal, relation: 'assigned', ownerName: 'Synthetic Sales Delhi B', assignments: [{ kind: 'flight', isYou: true }] },
    book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [], canEdit: false }) },
  },
  'ws-deal-state-quotation-accepted': {
    deal: salesDeal,
    book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [] }) },
    quotations: acceptedQuotations,
  },
  'ws-deal-state-ready': { deal: salesDeal, book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, checklist: [] }) } },
  'ws-deal-state-waiting': { deal: salesDeal, book: { state: 'ok', view: submitted() } },
  'ws-deal-state-returned': {
    deal: salesDeal,
    book: { state: 'ok', view: submitted({ canOpenRevision: true, accountsReview: { status: 'returned', reviewedAt: '2026-10-12T11:00:00.000Z', reason: 'Synthetic: add the second traveller’s date of birth.', reasonHidden: false } }) },
  },
  'ws-deal-state-returned-reason-hidden': {
    deal: salesDeal,
    book: { state: 'ok', view: submitted({ canOpenRevision: true, accountsReview: { status: 'returned', reviewedAt: null, reason: null, reasonHidden: true } }) },
  },
  'ws-deal-state-arranged': {
    deal: salesDeal,
    book: { state: 'ok', view: submitted({ accountsReview: { status: 'approved', reviewedAt: '2026-10-12T11:00:00.000Z', reason: null, reasonHidden: false }, items: salesDraft.items, progress: previewServicesView('sales').progress }) },
    services: { ok: true, view: previewServicesView('sales') },
  },
  'ws-deal-state-confirmed': {
    deal: salesDeal,
    book: {
      state: 'ok',
      view: submitted({
        accountsReview: { status: 'approved', reviewedAt: '2026-10-12T11:00:00.000Z', reason: null, reasonHidden: false },
        progress: { total: 3, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 3 }, fulfilled: true, staleCount: 0, needs: [] },
      }),
    },
  },
  'ws-deal-state-lost': { deal: salesDeal, book: { state: 'ok', view: submitted({ dealNotActive: true }) } },
  'ws-deal-state-lost-no-booking': { deal: salesDeal, book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [], dealNotActive: true }) } },
  'ws-deal-state-hotel-legacy': { deal: salesDeal, book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: { ...confirmedVersion, serviceType: 'hotel' } }) }, legacyBooking: { ok: true, exists: true } },
  'ws-deal-state-could-not-load': { deal: salesDeal, book: { state: 'failed' } },
  'ws-deal-state-waiting-owner-stale': {
    deal: { ...salesDeal, relation: 'waiting', ownerName: null, assignments: [], source: { ...salesDeal.source!, lastVerifiedAt: '2026-09-28T06:00:00Z', lastSyncedAt: '2026-09-27T06:00:00Z', stale: true } },
    book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [], canEdit: false }) },
  },
  'ws-deal-state-test-record': {
    deal: { ...salesDeal, source: undefined, commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,20,000.00', estimatedMargin: '₹9,000.00' }, commercialAbsence: undefined },
    book: { state: 'ok', view: draftView({ dealId: WS_DEAL_ID, version: null, checklist: [] }) },
  },
});

/** Every state name of this file (a function: the fixtures it reads are built lazily). */
export const dealWorkspacePreviewStates = (): string[] => [
  ...['ws-deal-sales', 'ws-deal-purchase', 'ws-deal-noprice', 'ws-deal-manager'].flatMap((stem) => TABS.map((t) => (t === 'overview' ? stem : `${stem}-${t}`))),
  ...Object.keys(states()),
  'ws-deal-state-test-record-money',
  'ws-deal-error-history',
  'ws-deal-error-documents',
  'ws-deal-error-services',
];

export function renderDealWorkspaceState(state: string): ReactNode | null {
  const fam = familyState(state);
  if (fam) return fam;
  const moneyOf = /^(ws-deal-state-test-record)-money$/.exec(state);
  const key = moneyOf ? moneyOf[1]! : state;
  const read = states()[key];
  if (read) {
    const ws = previewBuiltDeal({ leadLink: LEAD_LINK, ...read, stem: key, tab: moneyOf ? 'money' : 'overview' });
    return (
      <StaffShell viewer={sales} currentPath="/app/deals">
        <DealWorkspaceView workspace={ws} live={<PreviewLiveIndicator />} startBookingForm={ws.header.primary?.kind === 'start_booking' ? startForm : undefined} />
      </StaffShell>
    );
  }
  // One tab that could not be loaded; the header and tabs stay (SH-06). Same reads as the Sales family.
  const errors: Record<string, { tab: DealTab; read: Partial<Read>; services?: ReactNode }> = {
    // A failed Book now read: History is an error (never "no history"), the header says Could not load.
    'ws-deal-error-history': { tab: 'history', read: { book: { state: 'failed' } } },
    'ws-deal-error-documents': { tab: 'documents', read: { documents: 'error' } },
    // A failed services read: the route places today's could-not-load card on the tab.
    'ws-deal-error-services': { tab: 'services', read: { services: { ok: false } }, services: <DealServicesUnavailable /> },
  };
  const e = errors[state];
  if (e) {
    const ws = previewBuiltDeal({ ...family()['ws-deal-sales']!.read, ...e.read, stem: 'ws-deal-sales', tab: e.tab });
    return (
      <StaffShell viewer={sales} currentPath="/app/deals">
        <DealWorkspaceView workspace={ws} live={<PreviewLiveIndicator />} servicesTab={e.services} />
      </StaffShell>
    );
  }
  return null;
}

/**
 * An older gallery state (DealDetail fixture) rendered as the Batch 1 Deal
 * workspace through the builder, keeping the state name so the screenshot
 * scripts still work. `services` is the Services and tasks body (hotel panel,
 * services card) and opens that tab; `read` carries the reads the route would
 * have made (legacy hotel booking, services view).
 */
export function LegacyDealPage({
  detail,
  stem,
  current,
  services,
  leadLink,
  read,
  servicesFirst,
}: {
  detail: DealDetail;
  stem: string;
  current?: DealTab;
  services?: ReactNode;
  leadLink?: { href: string; reference: string } | null;
  read?: Partial<Read>;
  /** Set on the -overview / -money variants of a state that opens on Services and tasks. */
  servicesFirst?: boolean;
}) {
  const tab = current ?? (services ? 'services' : 'overview');
  const ws = previewWorkspaceFromDetail(detail, { stem, current: tab, leadLink, servicesFirst: servicesFirst ?? Boolean(services), read });
  return <DealWorkspaceView workspace={ws} servicesTab={ws.current === 'services' ? (services ?? <DealServicesEmpty />) : undefined} live={<PreviewLiveIndicator />} />;
}
