'use server';

import { requireStaff } from '@/modules/identity/server/session';
import type { DealSearchResult, LeadSearchResult } from '../contracts';
import { searchDeals, searchLeads } from './search';

/*
 * Batch 5 search actions (contracts.md §E; view shape luna-batch5-props.md:
 * plain (formData) => result, the view keeps its own state and appends
 * "Show more" pages). Every call runs requireStaff() first (active staff at
 * aal2), then the search under the person's own session; the database list
 * policies decide every row. Fields: q (words), kind (ignored: each action
 * has one kind), after (cursor from the previous result, "Show more" only).
 * The words travel only in this POST body: never in an address, a log line,
 * an audit row or an error message.
 */

export async function searchLeadsAction(formData: FormData): Promise<LeadSearchResult> {
  const staff = await requireStaff();
  return searchLeads(staff, formData);
}

export async function searchDealsAction(formData: FormData): Promise<DealSearchResult> {
  const staff = await requireStaff();
  return searchDeals(staff, formData);
}
