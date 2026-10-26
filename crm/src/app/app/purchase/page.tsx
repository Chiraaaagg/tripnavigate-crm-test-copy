import type { Metadata } from 'next';
import { loadPurchaseQueue } from '@/modules/fulfilment/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { parseQueueShow } from '@/views/department/queue-show';
import { PurchaseQueuePage } from '@/views/purchase-views';

export const metadata: Metadata = { title: 'Purchase tasks' };

export default async function PurchaseQueueRoute({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const staff = await requireStaff();
  const { show } = await searchParams;
  const canTakeTasks = staff.memberships.some((m) => m.roleCode === 'purchase');
  // The database returns only tasks this person may see; errors reach the route error boundary.
  // Batch 4 (PU-01): the tabs filter the rows already returned (`?show=`, server allowlist).
  const queue = await loadPurchaseQueue(staff);
  return <PurchaseQueuePage queue={queue} canTakeTasks={canTakeTasks} show={parseQueueShow(show, canTakeTasks)} />;
}
