import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { BrandedItineraryTemplate } from '@/modules/documents/render/branded-templates';
import PrintLayout from '../../print/layout';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { ItinActions } from '@/views/b12/itin-kit';
import { ItinerariesCard, ItineraryNotAvailableView, ItineraryPreviewPage, ItineraryScreen } from '@/views/b12/itin-views';
import {
  previewItinAcknowledgedAction,
  previewItinBasisUnavailableAction,
  previewItinCheckedAction,
  previewItinInternalWordingAction,
  previewItinNotReadyAction,
  previewItinRenderAction,
  previewQuoteRefuseTitleAction,
  previewQuoteSavedAction,
} from './b12-preview-actions';
import { ITIN_DOC_ID, ITIN_SCREENS, itineraryDocumentView, itineraryList } from './b12-itin-fixtures';

/*
 * B1.2 itinerary preview states (LOCAL DESIGN-REVIEW GALLERY ONLY): the real
 * itinerary page composition on synthetic views, with stand-in actions that
 * return fixed answers. Not evidence of a real journey.
 */

const sales: ShellViewer = { displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false };

export const GALLERY_ITIN_ACTIONS: ItinActions = {
  create: previewQuoteRefuseTitleAction as unknown as ItinActions['create'],
  uploadSource: previewQuoteSavedAction as unknown as ItinActions['uploadSource'],
  removeSource: previewQuoteSavedAction as unknown as ItinActions['removeSource'],
  saveFacts: previewItinInternalWordingAction as unknown as ItinActions['saveFacts'],
  checkDifferences: previewItinCheckedAction as unknown as ItinActions['checkDifferences'],
  useBasisValue: previewItinBasisUnavailableAction as unknown as ItinActions['useBasisValue'],
  acknowledge: previewItinAcknowledgedAction as unknown as ItinActions['acknowledge'],
  markReady: previewItinNotReadyAction as unknown as ItinActions['markReady'],
  requestRender: previewItinRenderAction as unknown as ItinActions['requestRender'],
};

function shell(children: ReactNode, path = '/app/deals') {
  return (
    <StaffShell viewer={sales} currentPath={path}>
      {children}
    </StaffShell>
  );
}

const back = { backHref: '/preview/b12-quote-accepted-ready', backLabel: 'Back to the quotation' };

const ITIN_STATES: Record<string, () => ReactNode> = {
  'b12-itin-card': () =>
    shell(
      <>
        <PageHeader eyebrow="Quotation TQ-7 · version 2" title="Bali for the Shah family" />
        <ItinerariesCard list={itineraryList()} defaultTitle="Bali for the Shah family" createAction={GALLERY_ITIN_ACTIONS.create} />
      </>,
    ),
  'b12-itin-not-checked': () => shell(<ItineraryScreen editor={ITIN_SCREENS.notChecked()} actions={GALLERY_ITIN_ACTIONS} {...back} />),
  'b12-itin-open': () => shell(<ItineraryScreen editor={ITIN_SCREENS.open()} actions={GALLERY_ITIN_ACTIONS} {...back} />),
  'b12-itin-ready': () => shell(<ItineraryScreen editor={ITIN_SCREENS.ready()} actions={GALLERY_ITIN_ACTIONS} {...back} />),
  'b12-itin-preview': () => shell(<ItineraryPreviewPage documentId={ITIN_DOC_ID} view={itineraryDocumentView()} />),
  'b12-itin-not-available': () => shell(<ItineraryNotAvailableView />),
  // The print page's layout (app/print/layout.tsx) around the branded template: no app chrome, banner hidden.
  'b12-itin-print': () => {
    const r = itineraryToEngine(itineraryDocumentView());
    return (
      <PrintLayout>
        <main id="main" className="tn-print">
          {r.ok ? <BrandedItineraryTemplate input={r.input} id="print-document" /> : <p>Synthetic view refused</p>}
        </main>
      </PrintLayout>
    );
  },
};


export const B12_ITIN_STATES = Object.keys(ITIN_STATES);

export function renderB12ItinState(state: string): ReactNode | null {
  return ITIN_STATES[state]?.() ?? null;
}
