import { DealPageLoading } from '@/views/deal-page-view';

/**
 * Loading state of the deal page only (/app/deals/[id]). The Deals list has
 * its own in the "(list)" route group; neither wraps the other.
 */
export default function Loading() {
  return <DealPageLoading />;
}
