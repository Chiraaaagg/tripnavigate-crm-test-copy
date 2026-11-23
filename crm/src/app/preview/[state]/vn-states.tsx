import type { ReactNode } from 'react';
import { StaffShell } from '@/views/StaffShell';
import { CustomerCheckView, CustomersToCheckView } from '@/views/accounts/customer-check';
import type { DestinationClassRow, ImportBatchRow, PartyCheckDetail, PartyCheckFilter, PartyCheckRow } from '@/views/booking-form/vn-types';
import { BitrixTripDetailsCard } from '@/views/bitrix-names-card';
import { DestinationClassesCard } from '@/views/settings/destination-classes';
import { ImportView } from '@/views/settings/import-view';
import { accounts } from './b11-states';
import { inSettings, settingsOwner } from './settings-preview-frame';
import { PREVIEW_IMPORT_SUMMARY, PREVIEW_PARTIES } from './vn-fixtures';
import { previewNamesRefuseAction } from './names-preview-actions';
import { previewTripDetailsSavedAction, previewApplyImportAction, previewOkAction, previewRefuseReasonAction, previewValidateImportAction } from './vn-preview-actions';

/*
 * LOCAL DESIGN-REVIEW GALLERY: voice-note batch screens outside the booking
 * form (Accounts customer check, hotel and customer import, Bitrix
 * destination classes). Synthetic props only; addresses /preview/vn-*.
 */

const ROWS: PartyCheckRow[] = PREVIEW_PARTIES.map((p, i) => ({
  partyId: p.partyId,
  href: `/preview/vn-customer-check${i === 2 ? '-returned' : ''}`,
  type: p.type,
  name: p.name,
  contactLine: [p.phone, p.email].filter(Boolean).join(' · ') || null,
  place: p.city,
  gstLine: p.gstStatus === 'registered' ? p.gstin : p.gstStatus === 'unregistered' ? 'Not GST registered' : null,
  status: 'not_checked',
  sourceLabel: p.sourceLabel,
  addedAt: '2026-10-24T06:00:00.000Z',
  addedByName: 'Synthetic Sales Delhi A',
}));

const filters = (current: PartyCheckFilter, counts: [number, number, number]) =>
  (['not_checked', 'returned', 'checked'] as const).map((key, i) => ({ key, label: key === 'not_checked' ? 'Not checked' : key === 'returned' ? 'Returned' : 'Checked', href: `/preview/vn-customers${key === 'not_checked' ? '' : `-${key}`}`, count: counts[i]!, current: key === current }));

const DETAIL: PartyCheckDetail = {
  ...PREVIEW_PARTIES[1]!,
  rowVersion: 3,
  returnedReason: null,
  checkedByName: null,
  checkedAt: null,
  files: [{ fileId: 'f1', kind: 'gst_certificate', fileName: 'gst-certificate.pdf', sizeLabel: '310 KB', downloadHref: '#' }],
  history: [
    { at: '2026-10-24T06:00:00.000Z', byName: 'Synthetic Sales Delhi A', text: 'Added on DL-1042.' },
    { at: '2026-10-24T06:05:00.000Z', byName: 'Synthetic Sales Delhi A', text: 'Used for Bill To on DL-1042.' },
  ],
  usedOn: [{ reference: 'DL-1042', href: '/preview/bookform-vn-billto-picked--finish' }],
};

const ACTIONS = { save: previewOkAction, check: previewOkAction, returnParty: previewOkAction };

const HISTORY: ImportBatchRow[] = [
  { batchId: 'b1', kind: 'hotel', fileName: 'sample-hotels-sept.csv', status: 'applied', rows: 80, creates: 74, updates: 0, invalid: 6, byName: 'Synthetic Owner Jodhpur', at: '2026-10-20T08:00:00.000Z' },
  { batchId: 'b2', kind: 'hotel', fileName: 'sample-hotels-old.csv', status: 'expired', rows: 20, creates: 20, updates: 0, invalid: 0, byName: 'Synthetic Owner Jodhpur', at: '2026-10-18T08:00:00.000Z' },
];

const kindLinks = (kind: 'hotel' | 'customer') => [
  { kind: 'hotel' as const, label: 'Hotels', href: '/preview/vn-import-hotel', current: kind === 'hotel' },
  { kind: 'customer' as const, label: 'Customers', href: '/preview/vn-import-customer', current: kind === 'customer' },
];

const BRANCHES = { options: [{ branchId: 'b-jdh', name: 'Jodhpur' }, { branchId: 'b-del', name: 'Delhi' }, { branchId: 'b-amd', name: 'Ahmedabad' }], defaultBranchId: 'b-jdh' };

const DESTINATIONS: DestinationClassRow[] = [
  { optionId: '101', label: 'Himachal', source: 'single', scope: 'domestic', reason: 'Indian state; owner approved list 24 Oct.', byName: 'Synthetic Owner Jodhpur', at: '2026-10-24T07:00:00.000Z', rowVersion: 1 },
  { optionId: '102', label: 'Kerala', source: 'single', scope: null, reason: null, byName: null, at: null, rowVersion: 0 },
  { optionId: '103', label: 'Dubai', source: 'single', scope: 'international', reason: 'UAE; owner approved list 24 Oct.', byName: 'Synthetic Owner Jodhpur', at: '2026-10-24T07:00:00.000Z', rowVersion: 1 },
  { optionId: '201', label: 'Bali', source: 'multi', scope: null, reason: null, byName: null, at: null, rowVersion: 0 },
];

const accountsPage = (children: ReactNode) => (
  <StaffShell viewer={accounts} currentPath="/app/accounts">
    {children}
  </StaffShell>
);

export const VN_STATES = [
  'vn-customers',
  'vn-customers-returned',
  'vn-customers-checked',
  'vn-customers-error',
  'vn-customer-check',
  'vn-customer-check-returned',
  'vn-customer-check-blocked',
  'vn-customer-check-refused',
  'vn-import-hotel',
  'vn-import-hotel-summary',
  'vn-import-customer',
  'vn-import-customer-choose',
  'vn-destinations',
  'vn-destinations-view',
  'vn-destinations-error',
  'vn-trip-details-off',
  'vn-trip-details-on',
  'vn-trip-details-unknown',
  'vn-trip-details-review',
  'vn-trip-details-viewer',
] as const;

export function renderVnState(state: string): ReactNode | null {
  switch (state) {
    case 'vn-customers':
      return accountsPage(<CustomersToCheckView items={ROWS.slice(0, 2)} filters={filters('not_checked', [2, 1, 1])} nextHref={null} />);
    case 'vn-customers-returned':
      return accountsPage(<CustomersToCheckView items={[{ ...ROWS[2]!, status: 'returned' }]} filters={filters('returned', [2, 1, 1])} nextHref={null} />);
    case 'vn-customers-checked':
      return accountsPage(<CustomersToCheckView items={[]} filters={filters('checked', [2, 1, 0])} nextHref={null} />);
    case 'vn-customers-error':
      return accountsPage(<CustomersToCheckView items={null} filters={filters('not_checked', [0, 0, 0]).map((f) => ({ ...f, count: null }))} nextHref={null} />);
    case 'vn-customer-check':
      return accountsPage(<CustomerCheckView party={DETAIL} backHref="/preview/vn-customers" canEdit canCheck checkBlockedReason={null} actions={ACTIONS} />);
    case 'vn-customer-check-returned':
      return accountsPage(
        <CustomerCheckView party={{ ...DETAIL, ...PREVIEW_PARTIES[2]!, checkStatus: 'returned', returnedReason: 'Address is missing the PIN code. Ask the customer for it.' }} backHref="/preview/vn-customers-returned" canEdit canCheck checkBlockedReason={null} actions={ACTIONS} />,
      );
    case 'vn-customer-check-blocked':
      return accountsPage(<CustomerCheckView party={DETAIL} backHref="/preview/vn-customers" canEdit={false} canCheck={false} checkBlockedReason="Only Accounts staff of this company can check customers." actions={ACTIONS} />);
    case 'vn-customer-check-refused':
      return accountsPage(<CustomerCheckView party={DETAIL} backHref="/preview/vn-customers" canEdit canCheck checkBlockedReason={null} actions={{ ...ACTIONS, returnParty: previewRefuseReasonAction }} />);
    case 'vn-import-hotel':
      return inSettings(settingsOwner, '/app/admin/imports', <ImportView kind="hotel" kindLinks={kindLinks('hotel')} canApply summary={null} history={HISTORY} actions={{ validate: previewValidateImportAction, apply: previewApplyImportAction }} />);
    case 'vn-import-hotel-summary':
      return inSettings(settingsOwner, '/app/admin/imports', <ImportView kind="hotel" kindLinks={kindLinks('hotel')} canApply summary={PREVIEW_IMPORT_SUMMARY} history={HISTORY} actions={{ validate: previewValidateImportAction, apply: previewApplyImportAction }} />);
    case 'vn-import-customer':
      return inSettings(
        settingsOwner,
        '/app/admin/imports',
        <ImportView kind="customer" kindLinks={kindLinks('customer')} canApply={false} summary={{ ...PREVIEW_IMPORT_SUMMARY, kind: 'customer', fileName: 'sample-customers.csv', branchName: 'Jodhpur' }} history={[]} actions={{ validate: previewValidateImportAction, apply: previewApplyImportAction }} branchChoice={BRANCHES} />,
      );
    case 'vn-import-customer-choose':
      return inSettings(settingsOwner, '/app/admin/imports', <ImportView kind="customer" kindLinks={kindLinks('customer')} canApply summary={null} history={[]} actions={{ validate: previewValidateImportAction, apply: previewApplyImportAction }} branchChoice={{ ...BRANCHES, defaultBranchId: null }} />);
    case 'vn-destinations':
      return inSettings(settingsOwner, '/app/admin/integration', <DestinationClassesCard rows={DESTINATIONS} canEdit action={previewOkAction} />);
    case 'vn-destinations-view':
      return inSettings(settingsOwner, '/app/admin/integration', <DestinationClassesCard rows={DESTINATIONS} canEdit={false} action={previewOkAction} />);
    case 'vn-destinations-error':
      return inSettings(settingsOwner, '/app/admin/integration', <DestinationClassesCard rows={null} canEdit action={previewOkAction} />);
    case 'vn-trip-details-off':
      return inSettings(settingsOwner, '/app/admin/integration', <BitrixTripDetailsCard state={{ state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }} action={previewTripDetailsSavedAction} />);
    case 'vn-trip-details-on':
      return inSettings(
        settingsOwner,
        '/app/admin/integration',
        <BitrixTripDetailsCard
          state={{ state: 'known', enabled: true, connectionEnabled: true, effective: true, canSwitch: true, lastChange: { at: '2026-10-24T07:00:00.000Z', byName: 'Synthetic Owner Jodhpur', via: 'command', to: true, reason: 'Owner approved trip details on 24 Oct (synthetic).' } }}
          action={previewTripDetailsSavedAction}
        />,
      );
    case 'vn-trip-details-unknown':
      return inSettings(settingsOwner, '/app/admin/integration', <BitrixTripDetailsCard state={{ state: 'unknown', reason: 'not_installed' }} action={previewTripDetailsSavedAction} />);
    case 'vn-trip-details-review':
      return inSettings(
        settingsOwner,
        '/app/admin/integration',
        <BitrixTripDetailsCard state={{ state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }} action={previewNamesRefuseAction} initialStep="review" initialReason="Owner approved trip details on 24 Oct (synthetic)." />,
      );
    case 'vn-trip-details-viewer':
      return inSettings(settingsOwner, '/app/admin/integration', <BitrixTripDetailsCard state={{ state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: false, lastChange: null }} action={previewTripDetailsSavedAction} />);
    default:
      return null;
  }
}
