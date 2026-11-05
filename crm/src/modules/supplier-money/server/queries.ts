import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  accountsCompanyFunding,
  accountsSupplierDocuments,
  accountsSupplierPayments,
  managerApprovals,
  paymentContext,
  purchasePaymentRequests,
  SupplierMoneyCommandError,
  supplierMoneyHomeCounts,
} from '../commands';
import type {
  AccountsDocumentTab,
  AccountsFundingTab,
  AccountsPaymentTab,
  AccountsSupplierDocumentsView,
  AccountsSupplierPaymentRow,
  CompanyFundingRow,
  ManagerApprovalsView,
  PaymentContextView,
  PurchasePaymentRequestView,
  PurchasePaymentScope,
  SupplierMoneyHomeCounts,
} from '../contracts';
import {
  toAccountsDocumentsView,
  toAccountsPaymentRow,
  toFundingRow,
  toHomeCounts,
  toManagerApprovalsView,
  toPaymentContextView,
  toPurchasePaymentView,
} from '../dto';

/**
 * Supplier money reads, under the staff member's own session. A refusal
 * (not this person's role, scope or environment) returns an empty list (as
 * procurement's loadSuppliers) or null for one task; an unexplained failure
 * throws (never a fabricated empty state). Pages gate on the role first.
 */

type Staff = Pick<StaffContext, 'supabase'>;

/** Refused for this viewer (role, scope or environment): the page shows "not available". */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof SupplierMoneyCommandError &&
    (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'not_configured' || error.code === 'environment_unset')
  );
}

export async function loadPurchasePaymentRequests(staff: Staff, scope: PurchasePaymentScope): Promise<PurchasePaymentRequestView[]> {
  try {
    return (await purchasePaymentRequests(asRpcClient(staff.supabase), scope)).map(toPurchasePaymentView);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load payment requests. Please retry.');
  }
}

export async function loadPaymentContext(staff: Staff, taskId: string): Promise<PaymentContextView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await paymentContext(asRpcClient(staff.supabase), id.data);
    return record ? toPaymentContextView(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load supplier payments for this task. Please retry.');
  }
}

export async function loadAccountsSupplierPayments(staff: Staff, tab: AccountsPaymentTab): Promise<AccountsSupplierPaymentRow[]> {
  try {
    return (await accountsSupplierPayments(asRpcClient(staff.supabase), tab)).map(toAccountsPaymentRow);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load supplier payments. Please retry.');
  }
}

export async function loadAccountsSupplierDocuments(staff: Staff, tab: AccountsDocumentTab): Promise<AccountsSupplierDocumentsView> {
  try {
    return toAccountsDocumentsView(await accountsSupplierDocuments(asRpcClient(staff.supabase), tab));
  } catch (error) {
    if (isRefusal(error)) return { documents: [], missingInvoices: [] };
    throw new Error('Could not load supplier invoices. Please retry.');
  }
}

export async function loadAccountsCompanyFunding(staff: Staff, tab: AccountsFundingTab): Promise<CompanyFundingRow[]> {
  try {
    return (await accountsCompanyFunding(asRpcClient(staff.supabase), tab)).map(toFundingRow);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load company funding. Please retry.');
  }
}

export async function loadManagerApprovals(staff: Staff): Promise<ManagerApprovalsView> {
  try {
    return toManagerApprovalsView(await managerApprovals(asRpcClient(staff.supabase)));
  } catch (error) {
    if (isRefusal(error)) {
      return { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] };
    }
    throw new Error('Could not load approvals. Please retry.');
  }
}

/** Supplier money Home rows (null keys = not applicable to this viewer). */
export async function loadSupplierMoneyHomeCounts(staff: Staff): Promise<SupplierMoneyHomeCounts | null> {
  try {
    return toHomeCounts(await supplierMoneyHomeCounts(asRpcClient(staff.supabase)));
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load your work. Please retry.');
  }
}
