import { DealsListLoading } from '@/views/deals-list-view';

/**
 * Loading state of the Deals list only. The "(list)" route group keeps this
 * file away from the deal page (/app/deals/[id]), which keeps the staff
 * frame's general loading state (src/app/app/loading.tsx).
 */
export default function Loading() {
  return <DealsListLoading />;
}
