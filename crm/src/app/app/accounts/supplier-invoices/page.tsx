import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { reviewSupplierDocumentAction } from '@/modules/supplier-money/server/actions';
import { loadAccountsSupplierDocuments } from '@/modules/supplier-money/server/queries';
import { AccountsSupplierInvoicesPage, parseDocumentTab } from '@/views/accounts/supplier-invoices';

export const metadata: Metadata = { title: 'Supplier invoices' };

/** Accounts · Supplier invoices and credit notes: To check · Missing invoices · All (`?tab=`). */
export default async function AccountsSupplierInvoicesRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const staff = await requireStaff();
  const { tab: raw } = await searchParams;
  const tab = parseDocumentTab(raw);
  const view = await loadAccountsSupplierDocuments(staff, tab);
  return <AccountsSupplierInvoicesPage view={view} tab={tab} reviewAction={reviewSupplierDocumentAction} />;
}
