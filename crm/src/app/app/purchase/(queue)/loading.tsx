import { ListLoading } from '@/views/list-parts';

/**
 * Loading state of the Purchase task lists (Purchase tasks and Payment
 * requests). The "(queue)" route group keeps it away from the task page
 * (/app/purchase/[taskId]), Suppliers and Rate contracts, which keep the staff
 * frame's general loading state (src/app/app/loading.tsx).
 */
export default function Loading() {
  return <ListLoading title="Purchase tasks" noun="Purchase tasks" withOrder />;
}
