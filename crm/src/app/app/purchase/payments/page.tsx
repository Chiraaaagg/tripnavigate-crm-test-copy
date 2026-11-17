import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import type { PurchasePaymentRequestView } from '@/modules/supplier-money/contracts';
import { loadPurchasePaymentRequests } from '@/modules/supplier-money/server/queries';
import { parsePaymentsShow, PurchasePaymentsPage } from '@/views/purchase/payments-page';

export const metadata: Metadata = { title: 'Payment requests' };

/** Purchase: the viewer's own supplier payment requests (the database scopes every row). */
export default async function PurchasePaymentsRoute({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const staff = await requireStaff();
  const { show } = await searchParams;
  let rows: PurchasePaymentRequestView[] = [];
  let failed = false;
  try {
    rows = await loadPurchasePaymentRequests(staff, 'mine');
  } catch {
    failed = true;
  }
  return <PurchasePaymentsPage rows={rows} show={parsePaymentsShow(show)} failed={failed} />;
}
