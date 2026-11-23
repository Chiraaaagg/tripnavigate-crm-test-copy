import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { reviewSupplierDocumentAction } from '@/modules/supplier-money/server/actions';
import { setCreditNoteLinkAction } from '@/modules/accounts-desk/server/actions';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { loadAccountsSupplierDocuments } from '@/modules/supplier-money/server/queries';
import { AccountsSupplierInvoicesPage, parseDocumentTab } from '@/views/accounts/supplier-invoices';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Supplier invoices' };

/** Accounts · Supplier invoices and credit notes: To check · Missing invoices · All (`?tab=`). */
export default async function AccountsSupplierInvoicesRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const staff = await requireStaff();
  // Redesign R4 (D5): the Money out tab strip uses the menu's own flags (the frame's cached read, so no new
  // database read); navigation only.
  const sectionViewer = await accountsSectionViewer(staff);
  const { tab: raw } = await searchParams;
  const tab = parseDocumentTab(raw);
  const view = await loadAccountsSupplierDocuments(staff, tab);
  return <AccountsSupplierInvoicesPage view={view} tab={tab} reviewAction={reviewSupplierDocumentAction} creditLinkAction={setCreditNoteLinkAction as unknown as DecisionAction} sectionViewer={sectionViewer} />;
}
