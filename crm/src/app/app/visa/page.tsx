import type { Metadata } from 'next';
import { loadVisaQueue } from '@/modules/fulfilment/server/visa';
import { requireStaff } from '@/modules/identity/server/session';
import { VisaQueuePage } from '@/views/b11/visa-desk';
import { parseQueueShow } from '@/views/department/queue-show';

export const metadata: Metadata = { title: 'Visa and passport tasks' };

/** Visa and passport desk queue (the database returns rows to the visa role only; the desk always takes tasks). */
export default async function VisaQueueRoute({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const staff = await requireStaff();
  const { show } = await searchParams;
  const queue = await loadVisaQueue(staff);
  return <VisaQueuePage queue={queue} show={parseQueueShow(show, true)} />;
}
