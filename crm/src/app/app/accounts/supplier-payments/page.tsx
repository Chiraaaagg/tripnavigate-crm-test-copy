import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import {
  decidePaymentRequestAction,
  recordSupplierPaymentAction,
  uploadSupplierMoneyFileAction,
  verifySupplierPaymentAction,
} from '@/modules/supplier-money/server/actions';
import { loadAccountsSupplierPayments } from '@/modules/supplier-money/server/queries';
import { AccountsSupplierPaymentsPage, parsePaymentTab } from '@/views/accounts/supplier-payments';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Supplier payments' };

/**
 * Accounts · Supplier payments: To approve · To pay and record · To verify ·
 * All (`?tab=`, server allowlist). accounts_supplier_payments returns only the
 * viewer's Accounts entities; every decision is re-checked by its command.
 */
export default async function AccountsSupplierPaymentsRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const staff = await requireStaff();
  // Redesign R4 (D5): the Money out tab strip uses the menu's own flags (the frame's cached read, so no new
  // database read); navigation only.
  const sectionViewer = await accountsSectionViewer(staff);
  const { tab: raw } = await searchParams;
  const tab = parsePaymentTab(raw);
  const rows = await loadAccountsSupplierPayments(staff, tab);
  return (
    <AccountsSupplierPaymentsPage
      rows={rows}
      tab={tab}
      today={todayInIndia()}
      actions={{ decide: decidePaymentRequestAction, record: recordSupplierPaymentAction, upload: uploadSupplierMoneyFileAction, verify: verifySupplierPaymentAction }}
      sectionViewer={sectionViewer}
    />
  );
}
