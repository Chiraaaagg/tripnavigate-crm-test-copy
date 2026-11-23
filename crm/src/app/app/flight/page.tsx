import type { Metadata } from 'next';
import { loadFlightQueue } from '@/modules/flight/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { parseQueueSearch, parseQueueShow, parseQueueSort } from '@/views/department/queue-show';
import { FlightQueuePage, parseQueueOnly } from '@/views/flight/queue';

export const metadata: Metadata = { title: 'Flight tasks' };

/**
 * Flight queue (Flight build, contract 9.1 / 11.1): one row per Deal. The
 * database returns only groups this person may see (Flight role, or the
 * branch Manager read-only); errors reach the route error boundary. The tabs
 * filter the rows already returned (`?show=`, server allowlist); the search
 * (`?q=`), filter chips (`?only=`) and sort (`?sort=`) only narrow and order
 * those rows (UX redesign R3).
 */
export default async function FlightQueueRoute({
  searchParams,
}: {
  searchParams: Promise<{ show?: string | string[]; only?: string | string[]; q?: string | string[]; sort?: string | string[] }>;
}) {
  const staff = await requireStaff();
  const { show, only, q, sort } = await searchParams;
  const canTakeTasks = staff.memberships.some((m) => m.roleCode === 'flight');
  const queue = await loadFlightQueue(staff);
  return (
    <FlightQueuePage
      queue={queue}
      canTakeTasks={canTakeTasks}
      show={parseQueueShow(show, canTakeTasks)}
      only={parseQueueOnly(only)}
      q={parseQueueSearch(q)}
      sort={parseQueueSort(sort)}
    />
  );
}
