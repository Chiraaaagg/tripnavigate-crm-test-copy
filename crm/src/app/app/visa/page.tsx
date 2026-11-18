import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadVisaQueue } from '@/modules/visa/server/queries';
import { parseQueueShow } from '@/views/department/queue-show';
import { isDeskViewer, VisaQueuePage } from '@/views/visa/queue';
import { VisaTaskNotAvailable } from '@/views/visa/workspace';

export const metadata: Metadata = { title: 'Visa and passport tasks' };

/**
 * Visa and passport queue (Visa build, contract 9.1 / 11.1). visa_queue
 * returns the entity's tasks to the Visa desk and the branch's tasks to the
 * branch Manager (read-only: Not taken · All, no Take); anyone else gets
 * null and the not-available answer.
 */
export default async function VisaQueueRoute({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const staff = await requireStaff();
  const { show } = await searchParams;
  const queue = await loadVisaQueue(staff);
  if (!queue) return <VisaTaskNotAvailable />;
  return <VisaQueuePage queue={queue} show={parseQueueShow(show, isDeskViewer(queue))} />;
}
