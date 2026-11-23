import type { ViewerRelation } from '@/modules/deals/dto';

/*
 * "Why you see it" reasons for the Leads and Deals rows (L-04, DL-03). A leaf
 * module of plain words, shared by the server lists and the client search
 * results; list-leads.tsx and deals-list-view.tsx re-export them unchanged.
 */

/** Mirrors LeadRelation (lead-views.tsx); a structural copy keeps this module a leaf. */
export type LeadSeenRelation = 'owner' | 'branch_manager' | 'integration_admin';

/** L-04 reason, moved to Details: "You see this lead because: …". */
export const LEAD_SEEN_BECAUSE: Record<LeadSeenRelation, string> = {
  owner: 'you own it',
  branch_manager: 'you manage this branch',
  integration_admin: 'you manage the Bitrix connection',
};

/** DL-03 reason, moved to Details ("Why you can see this deal"). */
export const DEAL_SEEN_BECAUSE: Record<ViewerRelation, string> = {
  owner: 'You own this deal.',
  assigned: 'You are assigned to this deal.',
  scope: 'Your role or an access grant covers this deal’s branch or company.',
  waiting: 'This deal is waiting for an owner; your role lets you see it.',
};
