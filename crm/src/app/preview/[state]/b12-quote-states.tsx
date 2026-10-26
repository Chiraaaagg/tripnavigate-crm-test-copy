import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { QuoteActions } from '@/views/b12/quote-kit';
import { QuotationPage, QuotationPreviewPage, SubjectQuotationsCard } from '@/views/b12/quote-page';
import { QuoteNotAvailableView } from '@/views/b12/quote-views';
import {
  previewQuoteConflictAction,
  previewQuoteDraftNotEmptyAction,
  previewQuoteInternalWordingAction,
  previewQuoteNotReadyAction,
  previewQuoteProofRequiredAction,
  previewQuoteRefuseDetailsAction,
  previewQuoteRefuseTitleAction,
  previewQuoteSavedAction,
  previewPrefillCheckedAction,
  previewPrefillUsedAction,
} from './b12-preview-actions';
import type { B11Action } from '@/views/b11/shapes';
import type { PrefillFieldCode } from '@/modules/fulfilment/contracts';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { toPrefillUi } from '@/modules/fulfilment/prefill-ui';
import { prefillView } from './b12-itin-fixtures';
import type { QuoteScreenData } from '@/views/b12/quote-shapes';
import { QUOTE_SCREENS, quoteDocumentView, quoteList, V2_ID } from './b12-quote-fixtures';

/*
 * B1.2 quotation preview states (LOCAL DESIGN-REVIEW GALLERY ONLY): synthetic
 * views on the real page composition, with stand-in actions that return
 * fixed answers. Not evidence of a real journey.
 */

const sales: ShellViewer = { displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false };

function shell(children: ReactNode, path = '/app/leads') {
  return (
    <StaffShell viewer={sales} currentPath={path}>
      {children}
    </StaffShell>
  );
}

export const GALLERY_ACTIONS: QuoteActions = {
  create: previewQuoteRefuseTitleAction,
  saveDetails: previewQuoteRefuseDetailsAction,
  saveContact: previewQuoteSavedAction,
  saveContent: previewQuoteInternalWordingAction,
  saveTiers: previewQuoteSavedAction,
  saveItem: previewQuoteSavedAction,
  removeItem: previewQuoteSavedAction,
  markReady: previewQuoteNotReadyAction,
  markSent: previewQuoteConflictAction,
  uploadEvidence: previewQuoteSavedAction,
  removeEvidence: previewQuoteSavedAction,
  accept: previewQuoteProofRequiredAction,
  decline: previewQuoteSavedAction,
  newVersion: previewQuoteConflictAction,
  discard: previewQuoteConflictAction,
  linkDeal: previewQuoteSavedAction,
  convert: previewQuoteDraftNotEmptyAction,
  saveLines: previewQuoteSavedAction,
  saveTierTotal: previewQuoteSavedAction,
  savePlan: previewQuoteSavedAction,
  saveCostEstimates: previewQuoteSavedAction,
  usePrefill: previewPrefillUsedAction as unknown as B11Action,
  markPrefillChecked: previewPrefillCheckedAction as unknown as B11Action,
};

function screen(data: QuoteScreenData, prefillUi: PrefillUiVM | null = null, actions: QuoteActions = GALLERY_ACTIONS) {
  return shell(<QuotationPage data={data} actions={actions} today="2026-10-12" prefillUi={prefillUi} />);
}

/** Batch 2: Check and mark ready succeeds; prices save; Fill empty / Keep mine stand-ins. */
const SAVING_QUOTE_ACTIONS: QuoteActions = { ...GALLERY_ACTIONS, saveDetails: previewQuoteSavedAction, markReady: previewQuoteSavedAction, fillEmptyPrefill: previewQuoteSavedAction as unknown as B11Action, dismissPrefillNotice: previewQuoteSavedAction as unknown as B11Action };
/** Batch 2: the second price form is refused (honest partial "Save prices" report). */
const PRICES_REFUSED_ACTIONS: QuoteActions = { ...SAVING_QUOTE_ACTIONS, saveLines: previewQuoteRefuseDetailsAction };

/** Inline mode (switch on) for a quotation: Terra's builder over a synthetic read. */
function quoteInline(states: Parameters<typeof prefillView>[1] = {}) {
  const pv = prefillView({}, states);
  return { pv: { ...pv, autoFill: { enabled: true, run: { mode: 'create' as const, ranAt: '2026-10-12T06:00:00.000Z', filled: ['trip.start', 'contacts.contactName'] as PrefillFieldCode[], skipped: [] }, canFillEmpty: false }, fieldStates: [] }, ui: (editable: boolean) => toPrefillUi({ ...pv, autoFill: { enabled: true, run: null, canFillEmpty: false } }, { target: 'quotation', editable }) };
}

function card(title: string, body: ReactNode, path = '/app/leads') {
  return shell(
    <>
      <PageHeader eyebrow={path === '/app/leads' ? 'Lead 4041' : 'Deal SYN-JOD-052'} title={title} />
      {body}
    </>,
    path,
  );
}

const QUOTE_STATES: Record<string, () => ReactNode> = {
  'b12-quote-lead-card': () => card('Shah · Bali family trip', <SubjectQuotationsCard list={quoteList()} subjectId="l1" defaultTitle="Shah · Bali family trip" createAction={GALLERY_ACTIONS.create} />),
  'b12-quote-lead-card-empty': () => card('Shah · Bali family trip', <SubjectQuotationsCard list={quoteList({ quotations: [] })} subjectId="l1" defaultTitle="Shah · Bali family trip" createAction={GALLERY_ACTIONS.create} />),
  'b12-quote-deal-card-lost': () =>
    card('Sen · Goa', <SubjectQuotationsCard list={quoteList({ subjectKind: 'deal', subjectId: 'd1', canCreate: false, quotations: [] })} subjectId="d1" defaultTitle="Sen · Goa" createAction={GALLERY_ACTIONS.create} blockedReason="This Deal is lost or rejected in Bitrix: no new quotation. Existing quotations stay readable." />, '/app/deals'),
  'b12-quote-draft': () => screen(QUOTE_SCREENS.draft()),
  // Batch 2 (QU-02): untouched draft says "Not started"; nothing red until "Check and mark ready".
  'b2-quote-untouched': () => screen(QUOTE_SCREENS.untouched()),
  'b2-quote-draft-saving': () => screen(QUOTE_SCREENS.draft(), null, SAVING_QUOTE_ACTIONS),
  'b2-quote-prices-refused': () => screen(QUOTE_SCREENS.draft(), null, PRICES_REFUSED_ACTIONS),
  'b2-quote-inline': () => {
    const d = QUOTE_SCREENS.untouched({ trip: { destination: null, scope: null, start: '2026-11-14', end: null }, contact: { contactName: 'Sample Customer Shah', mobile: null, email: null, companyName: null } });
    const q = quoteInline({ 'trip.start': 'from_bitrix', 'contacts.contactName': 'from_bitrix' });
    d.version.prefill = { ...q.pv, unchecked: ['trip.start', 'contacts.contactName'] };
    return screen(d, q.ui(true), SAVING_QUOTE_ACTIONS);
  },
  'b12-quote-ready': () => screen(QUOTE_SCREENS.ready()),
  // DEC-50 review: a Delhi quotation (company GSTIN not approved yet) warns before sending; it never blocks.
  'b12-quote-ready-gstin-pending': () => {
    const d = QUOTE_SCREENS.ready();
    d.version.subject = { ...d.version.subject, branchCode: 'DEL' };
    return screen(d);
  },
  'b12-quote-draft-prefill': () => {
    const d = QUOTE_SCREENS.draft();
    d.version.prefill = prefillView({ notesHidden: true, bookingNotes: null }, { 'contacts.contactName': 'from_bitrix', 'trip.start': 'from_bitrix' });
    return screen(d);
  },
  'b12-quote-sent': () => screen(QUOTE_SCREENS.sent()),
  'b12-quote-expired': () => screen(QUOTE_SCREENS.expired()),
  'b12-quote-declined': () => screen(QUOTE_SCREENS.declined()),
  'b12-quote-mismatch': () => screen(QUOTE_SCREENS.mismatch()),
  'b12-quote-no-money': () => screen(QUOTE_SCREENS.noMoney()),
  'b12-quote-accepted-waiting': () => screen(QUOTE_SCREENS.acceptedWaiting()),
  'b12-quote-accepted-candidate': () => screen(QUOTE_SCREENS.acceptedCandidate()),
  'b12-quote-accepted-ready': () => screen(QUOTE_SCREENS.acceptedReady()),
  'b12-quote-converted': () => screen(QUOTE_SCREENS.converted()),
  'b12-quote-preview': () => shell(<QuotationPreviewPage versionId={V2_ID} view={quoteDocumentView()} moneyVisible />),
  'b12-quote-preview-partial': () => shell(<QuotationPreviewPage versionId={V2_ID} view={quoteDocumentView({ days: [{ day: 1, city: null, title: 'Arrive in Bali', text: '' }] })} moneyVisible />),
  'b12-quote-preview-gstin-pending': () => shell(<QuotationPreviewPage versionId={V2_ID} view={quoteDocumentView({ branchCode: 'DEL' })} moneyVisible />),
  'b12-quote-preview-no-money': () => shell(<QuotationPreviewPage versionId={V2_ID} view={quoteDocumentView({ tiers: [] })} moneyVisible={false} />),
  'b12-quote-preview-blocked': () => shell(<QuotationPreviewPage versionId={V2_ID} view={quoteDocumentView({ includes: ['Daily breakfast', 'Best price in Bali'] })} moneyVisible />),
  'b12-quote-not-available': () => shell(<QuoteNotAvailableView />),
};

export const B12_QUOTE_STATES = Object.keys(QUOTE_STATES);

export function renderB12QuoteState(state: string): ReactNode | null {
  return QUOTE_STATES[state]?.() ?? null;
}
