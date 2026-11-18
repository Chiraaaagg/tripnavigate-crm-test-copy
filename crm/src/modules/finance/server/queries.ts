import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  accountsCashOverview,
  accountsDealDetail,
  accountsDealLookup,
  accountsQueue,
  companyDestinationOptions,
  companyDestinationsList,
  FinanceCommandError,
  financeEnabledEntities,
  financePolicyGet,
  accountsExpenseRecords,
  accountsPaymentClaims,
  isFinanceFunctionMissing,
} from '../commands';
import type {
  AccountsDealDetail,
  AccountsDealLookup,
  AccountsQueueFilter,
  AccountsQueuePage,
  CashOverview,
  CompanyDestinationsPage,
  DestinationOption,
  FinanceErrorCode,
  FinancePolicyPage,
  AccountsClaimsFilter,
  AccountsClaimsPage,
  AccountsExpenseFilter,
  AccountsExpenseRecordsPage,
} from '../contracts';
import { ACCOUNTS_CLAIMS_FILTERS, ACCOUNTS_EXPENSE_FILTERS } from '../contracts';
import { isAccountsQueueCursor, isB11ListCursor, isClaimsCursor } from '../dto';

/**
 * Phase 5A reads under the staff member's OWN session client (never the
 * privileged client). Database refusals are thrown as FinanceReadError whose
 * `.code` is the FinanceErrorCode token (pages turn it into an honest screen).
 * lookupAccountsDeal and loadAccountsDealDetail return null for "not found or
 * not visible". Anything unexpected throws a plain Error (route error
 * boundary); nothing is ever guessed or rendered empty by mistake.
 */

type Staff = Pick<StaffContext, 'supabase'>;

const QUEUE_FILTERS = ['all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending'] as const;

export class FinanceReadError extends Error {
  override name = 'FinanceReadError';
  constructor(readonly code: FinanceErrorCode) {
    super(code);
  }
}

function rethrow(error: unknown, what: string): never {
  if (error instanceof FinanceCommandError && error.code && error.code !== 'session') {
    throw new FinanceReadError(error.code);
  }
  throw new Error(`Could not load ${what}. Please retry.`);
}

export function isAccountsQueueFilter(value: unknown): value is AccountsQueueFilter {
  return typeof value === 'string' && (QUEUE_FILTERS as readonly string[]).includes(value);
}

/**
 * One page (50 items) of the Accounts queue, ordered by deal reference.
 * `after` is the previous page's nextAfter; a malformed cursor (for example a
 * hand-edited URL) loads the first page instead. The result carries
 * totalCount and hasMore, so a page is never presented as the whole queue.
 */
export async function loadAccountsQueue(
  staff: Staff,
  filter: AccountsQueueFilter = 'all',
  after?: string | null,
): Promise<AccountsQueuePage> {
  const safe: AccountsQueueFilter = isAccountsQueueFilter(filter) ? filter : 'all';
  const cursor = isAccountsQueueCursor(after) ? after : null;
  try {
    return await accountsQueue(asRpcClient(staff.supabase), safe, cursor);
  } catch (error) {
    rethrow(error, 'the Accounts queue');
  }
}

/** Exact reference within the viewer's finance-enabled entities (audited by the database). */
export async function lookupAccountsDeal(staff: Staff, reference: string): Promise<AccountsDealLookup | null> {
  const ref = (reference ?? '').trim();
  if (ref === '' || ref.length > 120 || /[\u0000-\u001f\u007f]/.test(ref)) return null;
  try {
    return await accountsDealLookup(asRpcClient(staff.supabase), ref);
  } catch (error) {
    if (error instanceof FinanceCommandError && (error.code === 'not_found' || error.code === 'invalid_input')) return null;
    rethrow(error, 'the deal lookup');
  }
}

export async function loadAccountsDealDetail(staff: Staff, dealId: string): Promise<AccountsDealDetail | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await accountsDealDetail(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (error instanceof FinanceCommandError && error.code === 'not_found') return null;
    rethrow(error, 'this Accounts deal');
  }
}

export async function loadCashOverview(staff: Staff, entityId: string): Promise<CashOverview> {
  const id = z.uuid().safeParse(entityId);
  if (!id.success) throw new FinanceReadError('not_authorized');
  try {
    return await accountsCashOverview(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    rethrow(error, 'branch cash');
  }
}

export async function loadFinancePolicy(staff: Staff, entityId: string): Promise<FinancePolicyPage> {
  const id = z.uuid().safeParse(entityId);
  if (!id.success) throw new FinanceReadError('not_authorized');
  try {
    return await financePolicyGet(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    rethrow(error, 'the finance policy');
  }
}

/**
 * Finance-enabled entities among the viewer's active memberships, for
 * navigation only (pair with accountsEntityIds / financePolicyEntityIds in
 * access/policy.ts). Any failure returns [] (navigation hides, fail closed).
 * Cached per request, so the navigation and the page read the same answer.
 */
export const financeEnabledEntityIds = cache(async (staff: Staff): Promise<string[]> => {
  try {
    return await financeEnabledEntities(asRpcClient(staff.supabase));
  } catch {
    return [];
  }
});

/** Stage 2: masked company destinations of one entity (Accounts only). */
export async function loadCompanyDestinations(staff: Staff, entityId: string): Promise<CompanyDestinationsPage> {
  const id = z.uuid().safeParse(entityId);
  if (!id.success) throw new FinanceReadError('not_authorized');
  try {
    return await companyDestinationsList(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    rethrow(error, 'company accounts');
  }
}

/** Stage 2: approved current destinations a new receipt on this deal may select (masked). */
export async function loadDestinationOptions(staff: Staff, dealId: string): Promise<DestinationOption[]> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return [];
  try {
    return await companyDestinationOptions(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    rethrow(error, 'company accounts for this deal');
  }
}

// ---------------------------------------------------------------------------
// B1.1: advance claims and expense record lists (Accounts)
// ---------------------------------------------------------------------------

export function isAccountsClaimsFilter(value: unknown): value is AccountsClaimsFilter {
  return typeof value === 'string' && (ACCOUNTS_CLAIMS_FILTERS as readonly string[]).includes(value);
}

export function isAccountsExpenseFilter(value: unknown): value is AccountsExpenseFilter {
  return typeof value === 'string' && (ACCOUNTS_EXPENSE_FILTERS as readonly string[]).includes(value);
}

/**
 * /app/accounts/claims: one page of advance claims, oldest first. null = the
 * database has no B1.1 claims yet (the page says so). A malformed cursor
 * loads the first page. Refusals throw FinanceReadError like the queue.
 */
export async function loadClaimsQueue(staff: Staff, filter: AccountsClaimsFilter = 'reported', after?: string | null): Promise<AccountsClaimsPage | null> {
  const safe: AccountsClaimsFilter = isAccountsClaimsFilter(filter) ? filter : 'reported';
  const cursor = isClaimsCursor(after) ? after : null;
  try {
    return await accountsPaymentClaims(asRpcClient(staff.supabase), safe, cursor);
  } catch (error) {
    if (isFinanceFunctionMissing(error)) return null;
    rethrow(error, 'the advance claims');
  }
}

/** /app/accounts/expenses: one page of department expense records. null = not installed yet. */
export async function loadExpenseQueue(
  staff: Staff,
  filter: AccountsExpenseFilter = 'submitted',
  after?: string | null,
): Promise<AccountsExpenseRecordsPage | null> {
  const safe: AccountsExpenseFilter = isAccountsExpenseFilter(filter) ? filter : 'submitted';
  const cursor = isB11ListCursor(after) ? after : null;
  try {
    return await accountsExpenseRecords(asRpcClient(staff.supabase), safe, cursor);
  } catch (error) {
    if (isFinanceFunctionMissing(error)) return null;
    rethrow(error, 'the expense records');
  }
}
