import type { Metadata } from 'next';
import { loadPurchaseQueue } from '@/modules/fulfilment/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { loadPurchaseQueueFlags } from '@/modules/procurement/server/queries';
import { parseQueueQuery, parseQueueShow } from '@/views/department/queue-show';
import { PURCHASE_QUEUE_CHIPS, PurchaseQueuePage } from '@/views/purchase-views';

export const metadata: Metadata = { title: 'Purchase tasks' };

type Param = string | string[] | undefined;

export default async function PurchaseQueueRoute({ searchParams }: { searchParams: Promise<{ show?: Param; q?: Param; chip?: Param; sort?: Param }> }) {
  const staff = await requireStaff();
  const { show, q, chip, sort } = await searchParams;
  const canTakeTasks = staff.memberships.some((m) => m.roleCode === 'purchase');
  // The database returns only tasks this person may see; errors reach the route error boundary.
  // Batch 4 (PU-01): the tabs filter the rows already returned (`?show=`, server allowlist).
  // R3 (C1): search, status chip and sort also work only on those rows (`?q=&chip=&sort=`, server allowlist).
  // Purchase build: the go-ahead and trip-cancelled flags per task; a failed flag read only hides the badges.
  const [queue, flags] = await Promise.all([loadPurchaseQueue(staff), loadPurchaseQueueFlags(staff).catch(() => ({}))]);
  return (
    <PurchaseQueuePage
      queue={queue}
      canTakeTasks={canTakeTasks}
      show={parseQueueShow(show, canTakeTasks)}
      flags={flags}
      query={parseQueueQuery({ q, chip, sort }, PURCHASE_QUEUE_CHIPS)}
    />
  );
}
