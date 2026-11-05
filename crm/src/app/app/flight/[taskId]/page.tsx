import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loadFlightQueue } from '@/modules/flight/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { FlightWorkspaceNotFound } from '@/views/flight/workspace';

export const metadata: Metadata = { title: 'Flight task' };

/**
 * Old per-task address (FL-02). The Flight build has one workspace per Deal
 * (decision 1): find the task's Deal among the groups this person may see and
 * go there, keeping the tab and focusing that flight. Anyone else gets the
 * same "not available" page as before (ids cannot be probed).
 */
export default async function FlightTaskRedirect({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ taskId }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const queue = await loadFlightQueue(staff);
  const group = queue.groups.find((g) => g.flights.some((f) => f.taskId === taskId));
  if (!group) return <FlightWorkspaceNotFound />;
  const t = typeof tab === 'string' && ['details', 'work', 'files', 'history'].includes(tab) ? tab : null;
  redirect(`/app/flight/deals/${group.dealId}?${t ? `tab=${t}&` : ''}flight=${taskId}`);
}
