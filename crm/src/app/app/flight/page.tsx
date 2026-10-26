import type { Metadata } from 'next';
import { loadFlightQueue } from '@/modules/fulfilment/server/flight';
import { requireStaff } from '@/modules/identity/server/session';
import { parseQueueShow } from '@/views/department/queue-show';
import { FlightQueuePage } from '@/views/flight-views';

export const metadata: Metadata = { title: 'Flight tasks' };

export default async function FlightQueueRoute({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const staff = await requireStaff();
  const { show } = await searchParams;
  const canTakeTasks = staff.memberships.some((m) => m.roleCode === 'flight');
  // The database returns only tasks this person may see; errors reach the route error boundary.
  // Batch 4 (FL-01): the tabs filter the rows already returned (`?show=`, server allowlist).
  const queue = await loadFlightQueue(staff);
  return <FlightQueuePage queue={queue} canTakeTasks={canTakeTasks} show={parseQueueShow(show, canTakeTasks)} />;
}
