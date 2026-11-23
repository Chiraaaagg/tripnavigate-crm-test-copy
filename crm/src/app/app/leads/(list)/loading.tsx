import { LeadsListLoading } from '@/views/list-leads';

/**
 * Loading state of the Leads list only (UX redesign R2). The "(list)" route
 * group keeps this file away from the Lead page (/app/leads/[id]), which keeps
 * the staff frame's general loading state (src/app/app/loading.tsx), the same
 * way as the Deals list.
 */
export default function Loading() {
  return <LeadsListLoading />;
}
