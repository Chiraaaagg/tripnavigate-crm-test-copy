import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import type { PurchasePaymentRequestView } from '@/modules/supplier-money/contracts';
import { loadPurchasePaymentRequests } from '@/modules/supplier-money/server/queries';
import { parsePaymentsQuery, parsePaymentsShow, PurchasePaymentsPage } from '@/views/purchase/payments-page';

export const metadata: Metadata = { title: 'Payment requests' };

type Param = string | string[] | undefined;

/** Purchase: the viewer's own supplier payment requests (the database scopes every row). */
export default async function PurchasePaymentsRoute({ searchParams }: { searchParams: Promise<{ show?: Param; q?: Param; sort?: Param }> }) {
  const staff = await requireStaff();
  const { show, q, sort } = await searchParams;
  let rows: PurchasePaymentRequestView[] = [];
  let failed = false;
  try {
    rows = await loadPurchasePaymentRequests(staff, 'mine');
  } catch {
    failed = true;
  }
  // R3 (C1): search and sort work only on the rows already returned (`?q=&sort=`, server allowlist).
  return <PurchasePaymentsPage rows={rows} show={parsePaymentsShow(show)} failed={failed} query={parsePaymentsQuery({ q, sort })} />;
}
