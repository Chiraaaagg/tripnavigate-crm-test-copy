import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import type { SupplierDetailView } from '@/modules/procurement/contracts';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { GST_STATES } from '@/views/b11/book-fields';
import type { B11Action } from '@/views/b11/shapes';
import type { ImportKind } from '@/views/booking-form/vn-types';
import { SupplierBankSection } from '@/views/procurement-views';
import { AddRateForm } from '@/views/purchase/work-forms';
import { ImportView } from '@/views/settings/import-view';
import type { SupplierFormActions } from '@/views/suppliers/forms';
import { SupplierRegisterLoading, SupplierRegisterNoAccess, SupplierRegisterView } from '@/views/suppliers/register';
import { SupplierMasterPage, SupplierPageError, SupplierPageLoading, type SupplierPagePreview, type SupplierTab } from '@/views/suppliers/supplier-page';
import type { SupplierMaster } from '@/views/suppliers/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { FLIGHT_SUP_ROWS, SUP_CATALOGUE, SUP_IMPORT_HISTORY, SUP_IMPORT_SUMMARY, SUP_MASTER, SUP_MASTER_FLIGHT, SUP_MASTER_MANAGER, SUP_QUOTE_SUPPLIERS, SUP_ROWS } from './acc2-supplier-fixtures';
import * as A from './acc2-supplier-preview-actions';
import { inSettings, settingsOwner } from './settings-preview-frame';
import { PreviewTyped } from './preview-typed';

/*
 * Accounts phase 2 preview states (acc2-supplier-*), Track E: the suppliers
 * register, the supplier page (details, contacts, hotels sold, history,
 * duplicate warnings), the quote form's catalogue hotel picker and
 * Settings › Imports › Suppliers. Synthetic props only; rendered by the
 * design-review gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const purchaseViewer: ShellViewer = {
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
  canSeePurchasePayments: true,
};
const managerViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeePurchasePayments: false, canSeeApprovals: true, canSeeLeads: true };
const flightViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', canSeePurchaseTasks: false, canSeePurchasePayments: false, canSeeFlightTasks: true };
const salesViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canSeePurchaseTasks: false, canSeePurchasePayments: false, canSeeLeads: true };
const accountsImporter: ShellViewer = { ...settingsOwner, displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', canAdministerStaff: false, canManageGrants: false, canManageIntegration: false, canOpenBitrixConnection: false, canImport: true, canUseAccounts: true };

const ENTITIES = [{ id: 'a0000001-0000-4000-8000-000000000001', name: 'Holiday Chacha Pvt LTD' }];
const ACTIONS: SupplierFormActions = {
  create: act(A.acc2SupSaveOk),
  update: act(A.acc2SupSaveOk),
  saveContact: act(A.acc2SupContactOk),
  removeContact: act(A.acc2SupRemoveOk),
  linkHotel: act(A.acc2SupLinkOk),
  unlinkHotel: act(A.acc2SupUnlinkOk),
};
const PURCHASE_SERVICES = ['hotel', 'transfer', 'activity'] as const;

const BANK_VIEW: SupplierDetailView = {
  supplierId: SUP_MASTER.supplierId,
  name: SUP_MASTER.name,
  serviceTypes: ['hotel', 'transfer', 'activity'],
  city: SUP_MASTER.city,
  verificationStatus: SUP_MASTER.verification,
  status: 'active',
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  paymentTerms: null,
  rowVersion: SUP_MASTER.rowVersion,
  updatedAt: '2026-11-10T10:30:00Z',
  verifiedAt: null,
  verifiedByName: null,
  canEdit: false,
  canVerify: false,
  beneficiaries: [
    { revisionNo: 2, accountHolder: 'Sample Desert Travel Channel', bankName: 'Sample Bank', ifsc: 'SMPL0004321', accountLast4: '4821', status: 'unverified', createdAt: '2026-11-09T08:00:00Z', createdByName: 'Synthetic Purchase Jodhpur', approvedAt: null, approvedByName: null, canApprove: false },
  ],
};

/* UX redesign R3: the Bank details tab and the header states it drives. */
const VERIFIED_ON_HOLD: SupplierMaster = { ...SUP_MASTER, verification: 'verified', verifiedAt: '2026-11-06T09:00:00Z', verifiedByName: 'Synthetic Manager Jodhpur', bankState: 'on_hold' };
const VERIFIED_NO_BANK: SupplierMaster = { ...VERIFIED_ON_HOLD, bankState: 'none', bank: null };
const BANK_VIEW_MANAGER: SupplierDetailView = { ...BANK_VIEW, canVerify: false, beneficiaries: BANK_VIEW.beneficiaries.map((b) => ({ ...b, canApprove: true })) };
const BANK_VIEW_EMPTY_EDIT: SupplierDetailView = { ...BANK_VIEW, canEdit: true, beneficiaries: [] };

function register(viewer: ShellViewer, body: ReactNode, path = '/app/purchase/suppliers') {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

function purchaseRegister(over: Partial<Parameters<typeof SupplierRegisterView>[0]> = {}) {
  return register(
    purchaseViewer,
    <SupplierRegisterView
      viewer="purchase"
      filter={{}}
      page={{ items: SUP_ROWS, nextAfter: 'syn-cursor-1', hasMore: true }}
      states={GST_STATES}
      serviceTypes={[...PURCHASE_SERVICES]}
      entities={ENTITIES}
      createAction={act(A.acc2SupSaveOk)}
      {...over}
    />,
  );
}

function page(viewer: ShellViewer, supplier: SupplierMaster, tab: SupplierTab, over: { actions?: SupplierFormActions | null; preview?: SupplierPagePreview; verify?: boolean; who?: 'purchase' | 'flight' | 'manager'; bank?: SupplierDetailView } = {}) {
  const who = over.who ?? 'purchase';
  return register(
    viewer,
    <SupplierMasterPage
      supplier={supplier}
      tab={tab}
      viewer={who}
      states={GST_STATES}
      actions={over.actions === undefined ? ACTIONS : over.actions}
      searchHotels={A.acc2SupSearchHotels}
      verifyAction={
        over.verify ? (
          <Button variant="primary" size="lg">
            Verify details
          </Button>
        ) : undefined
      }
      bank={<SupplierBankSection supplier={over.bank ?? BANK_VIEW} />}
      preview={over.preview}
    />,
  );
}

const refusal = (code: string, message: string, field?: string): DeskResult => ({ ok: false, code, message, ...(field ? { field } : {}) }) as DeskResult;

function rateCard(over: Partial<Parameters<typeof AddRateForm>[0]> = {}) {
  return register(
    purchaseViewer,
    <Card>
      <CardHeader>
        <CardTitle>Add a rate</CardTitle>
      </CardHeader>
      <CardBody>
        <AddRateForm taskId="a2000701-0000-4000-8000-000000000701" action={act(A.acc2SupRateOk)} suppliers={SUP_QUOTE_SUPPLIERS} serviceName="Sample Dune Camp Resort" rooms={2} nights={3} hotel catalogue={SUP_CATALOGUE} searchHotels={A.acc2SupSearchHotels} {...over} />
      </CardBody>
    </Card>,
    '/app/purchase',
  );
}

const KIND_LINKS = (['hotel', 'customer', 'supplier'] as ImportKind[]).map((k) => ({ kind: k, label: k === 'hotel' ? 'Hotels' : k === 'customer' ? 'Customers' : 'Suppliers', href: `/app/admin/imports?kind=${k}`, current: k === 'supplier' }));
const IMPORT_ACTIONS = { validate: A.acc2SupImportValidate as unknown as B11Action, apply: A.acc2SupImportApplyOk as unknown as B11Action };

function importView(over: Partial<Parameters<typeof ImportView>[0]> = {}) {
  return inSettings(accountsImporter, '/app/admin/imports', <ImportView kind="supplier" kindLinks={KIND_LINKS} canApply summary={SUP_IMPORT_SUMMARY} history={SUP_IMPORT_HISTORY} actions={IMPORT_ACTIONS} {...over} />);
}


/** Preview only: the refusal state shows what was typed before it (PreviewTyped fills the fields once). */
function typed(values: Record<string, string>, body: ReactNode, firstOnly = false) {
  return (
    <>
      {body}
      <PreviewTyped values={values} firstOnly={firstOnly} />
    </>
  );
}

const states: Record<string, () => ReactNode> = {
  /* Register */
  'acc2-supplier-register': () => purchaseRegister(),
  'acc2-supplier-register-filtered': () => purchaseRegister({ filter: { kind: 'channel', bankState: 'on_hold', q: 'Sample' }, page: { items: [SUP_ROWS[1]!], nextAfter: null, hasMore: false } }),
  'acc2-supplier-register-hotel': () => purchaseRegister({ filter: { hotelId: SUP_CATALOGUE.catalogueHotelId! }, hotelName: SUP_CATALOGUE.catalogueHotelName, page: { items: [SUP_ROWS[1]!], nextAfter: null, hasMore: false } }),
  'acc2-supplier-register-no-match': () => purchaseRegister({ filter: { q: '08ZZZZZ0000Z1Z0' }, page: { items: [], nextAfter: null, hasMore: false } }),
  'acc2-supplier-register-empty': () => purchaseRegister({ page: { items: [], nextAfter: null, hasMore: false } }),
  'acc2-supplier-register-error': () => purchaseRegister({ page: 'error' }),
  'acc2-supplier-register-loading': () => register(purchaseViewer, <SupplierRegisterLoading />),
  'acc2-supplier-register-manager': () =>
    register(managerViewer, <SupplierRegisterView viewer="manager" filter={{}} page={{ items: [...SUP_ROWS, ...FLIGHT_SUP_ROWS], nextAfter: null, hasMore: false }} states={GST_STATES} serviceTypes={['hotel', 'transfer', 'activity', 'flight']} />),
  'acc2-supplier-register-flight': () =>
    register(flightViewer, <SupplierRegisterView viewer="flight" filter={{}} page={{ items: FLIGHT_SUP_ROWS, nextAfter: null, hasMore: false }} states={GST_STATES} serviceTypes={['flight']} entities={ENTITIES} createAction={act(A.acc2SupSaveOk)} />, '/app/flight'),
  'acc2-supplier-register-add-warnings': () =>
    purchaseRegister({
      createAction: act(A.acc2SupSaveWarnings),
      createInitialState: { ok: true, message: 'Synthetic preview: supplier added. Its details are marked “Not verified”.', data: { warnings: [{ supplierId: SUP_ROWS[0]!.supplierId, name: SUP_ROWS[0]!.name, reasons: ['same_gstin'] }] } },
    }),
  'acc2-supplier-register-add-refused': () =>
    purchaseRegister({ createAction: act(A.acc2SupSaveExists), createInitialState: refusal('supplier_exists', 'A supplier with exactly this name already exists in this company. Open it instead, or use a different name.', 'name') }),
  'acc2-supplier-register-no-access': () => register(salesViewer, <SupplierRegisterNoAccess />),
  'acc2-supplier-register-add-open': () => purchaseRegister({ createOpen: true }),
  'acc2-supplier-register-state-chip': () => purchaseRegister({ filter: { bankState: 'on_hold' }, page: { items: [SUP_ROWS[1]!, SUP_ROWS[3]!], nextAfter: null, hasMore: false } }),
  'acc2-supplier-register-accounts': () =>
    register(accountsImporter, <SupplierRegisterView viewer="accounts" filter={{}} page={{ items: [...SUP_ROWS, ...FLIGHT_SUP_ROWS], nextAfter: null, hasMore: false }} states={GST_STATES} serviceTypes={['hotel', 'transfer', 'activity', 'flight']} />),

  /* Supplier page */
  'acc2-supplier-page': () => page(purchaseViewer, SUP_MASTER, 'details'),
  'acc2-supplier-page-edit-refused': () => page(purchaseViewer, SUP_MASTER, 'details', { actions: { ...ACTIONS, update: act(A.acc2SupSaveGstin) }, preview: { editState: refusal('invalid_input', 'Check the highlighted field.', 'gstin') } }),
  'acc2-supplier-page-manager': () => page(managerViewer, SUP_MASTER_MANAGER, 'details', { actions: null, verify: true, who: 'manager' }),
  'acc2-supplier-page-contacts': () => page(purchaseViewer, SUP_MASTER, 'contacts'),
  'acc2-supplier-page-contact-add': () => page(purchaseViewer, SUP_MASTER, 'contacts', { preview: { contactOpen: true } }),
  'acc2-supplier-page-contact-refused': () =>
    page(purchaseViewer, SUP_MASTER, 'contacts', { actions: { ...ACTIONS, saveContact: act(A.acc2SupContactRefused) }, preview: { contactOpen: true, contactState: refusal('invalid_input', 'Give a phone number or an e-mail address.', 'phone') } }),
  'acc2-supplier-page-contact-remove': () => page(purchaseViewer, SUP_MASTER, 'contacts', { preview: { removeContactOpen: true } }),
  'acc2-supplier-page-contacts-manager': () => page(managerViewer, SUP_MASTER_MANAGER, 'contacts', { actions: null, verify: true, who: 'manager' }),
  'acc2-supplier-page-contacts-empty': () => page(purchaseViewer, { ...SUP_MASTER, contacts: [], primaryContact: null }, 'contacts'),
  'acc2-supplier-page-hotels': () => page(purchaseViewer, SUP_MASTER, 'hotels'),
  'acc2-supplier-page-hotels-empty': () => page(purchaseViewer, { ...SUP_MASTER, hotels: [], hotelCount: 0 }, 'hotels'),
  'acc2-supplier-page-hotel-link': () => page(purchaseViewer, SUP_MASTER, 'hotels', { preview: { linkOpen: true } }),
  'acc2-supplier-page-hotel-link-refused': () =>
    typed({ 'input[id$="-hotel"]': 'Sample Lake' }, page(purchaseViewer, SUP_MASTER, 'hotels', { actions: { ...ACTIONS, linkHotel: act(A.acc2SupLinkRefused) }, preview: { linkOpen: true, linkState: refusal('invalid_input', 'Choose the hotel from the list.', 'hotelId') } })),
  'acc2-supplier-page-hotels-manager': () => page(managerViewer, SUP_MASTER_MANAGER, 'hotels', { actions: null, verify: true, who: 'manager' }),
  'acc2-supplier-page-history': () => page(purchaseViewer, SUP_MASTER, 'history'),
  'acc2-supplier-page-history-empty': () => page(purchaseViewer, { ...SUP_MASTER, history: [] }, 'history'),
  'acc2-supplier-page-flight': () => page(flightViewer, SUP_MASTER_FLIGHT, 'details', { who: 'flight' }),
  'acc2-supplier-page-bank': () => page(purchaseViewer, SUP_MASTER, 'bank'),
  'acc2-supplier-page-on-hold': () => page(purchaseViewer, VERIFIED_ON_HOLD, 'details'),
  'acc2-supplier-page-bank-manager': () => page(managerViewer, { ...VERIFIED_ON_HOLD, pan: 'ABCDE9876F', can: SUP_MASTER_MANAGER.can }, 'details', { actions: null, who: 'manager', bank: BANK_VIEW_MANAGER }),
  'acc2-supplier-page-bank-manager-tab': () => page(managerViewer, { ...VERIFIED_ON_HOLD, pan: 'ABCDE9876F', can: SUP_MASTER_MANAGER.can }, 'bank', { actions: null, who: 'manager', bank: BANK_VIEW_MANAGER }),
  'acc2-supplier-page-no-bank': () => page(purchaseViewer, VERIFIED_NO_BANK, 'details', { bank: BANK_VIEW_EMPTY_EDIT }),
  'acc2-supplier-page-no-bank-tab': () => page(purchaseViewer, VERIFIED_NO_BANK, 'bank', { bank: BANK_VIEW_EMPTY_EDIT }),
  'acc2-supplier-page-loading': () => register(purchaseViewer, <SupplierPageLoading />),
  'acc2-supplier-page-error': () => register(purchaseViewer, <SupplierPageError />),

  /* Quote form hotel picker (contract 13.4) */
  'acc2-supplier-rate-picker': () => rateCard(),
  'acc2-supplier-rate-picker-no-catalogue': () => rateCard({ catalogue: { catalogueHotelId: null, catalogueHotelName: null, hotelSuppliers: [] }, serviceName: 'Sample hotel typed by Sales' }),

  /* Settings › Imports › Suppliers */
  'acc2-supplier-import': () => importView(),
  'acc2-supplier-import-start': () => importView({ summary: null }),
  'acc2-supplier-import-check-only': () => importView({ canApply: false }),
  'acc2-supplier-import-applied': () => importView({ summary: { ...SUP_IMPORT_SUMMARY, status: 'applied' } }),
  'acc2-supplier-import-apply-file': () => importView({ previewApply: {} }),
  'acc2-supplier-import-apply-other-file': () =>
    importView({
      actions: { ...IMPORT_ACTIONS, apply: A.acc2SupImportApplyOtherFile as unknown as B11Action },
      previewApply: {
        state: {
          ok: false,
          code: 'invalid_input',
          message: 'Choose the same file you checked (with the same column choices) and press Import again: bank account numbers are not kept between the check and the import. Nothing was imported.',
          fields: ['file'],
        } as never,
      },
    }),
  'acc2-supplier-import-changed': () => importView({ actions: { ...IMPORT_ACTIONS, apply: A.acc2SupImportApplyChanged as unknown as B11Action } }),
  'acc2-supplier-import-clean': () =>
    importView({ summary: { ...SUP_IMPORT_SUMMARY, supplier: { warnings: { similarNameCity: 0, sameGstin: 0, samePan: 0, sameBank: 0, hotelNotFound: 0 }, withBankDetails: 0, rows: SUP_IMPORT_SUMMARY.supplier!.rows.slice(4) } } }),
};

export const ACC2_SUPPLIER_STATES = Object.keys(states);

export function renderAcc2SupplierState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
