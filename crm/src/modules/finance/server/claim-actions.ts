'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  paymentClaimLinkReceipt,
  paymentClaimMarkNotReceived,
  paymentClaimReport,
  paymentClaimWithdraw,
  receiptRecordFromClaim,
} from '../commands';
import {
  type FinanceActionState,
  parseClaimLinkForm,
  parseClaimNotReceivedForm,
  parseClaimReportForm,
  parseClaimWithdrawForm,
  parseReceiptFromClaimForm,
} from '../forms';
import { done, invalid, refused } from './b11-results';

/**
 * B1.1 advance claims (appendix B §2). (prevState, FormData) -> FinanceActionState.
 * Every action: requireStaff(); parse the form (never the actor, entity or
 * role); run the database command under the staff member's OWN session (no
 * privileged client). The hidden requestId makes a resubmission an exact
 * retry. A claim is never money: reporting records what the customer said.
 */

type Prev = { status: string } | null | undefined;

const CLAIMS_PATH = '/app/accounts/claims';
const accountsDealPath = (dealId: string) => `/app/accounts/deals/${dealId}`;
const bookPath = (dealId: string) => `/app/deals/${dealId}/book`;

function revalidateSales(dealId: string | null): void {
  if (!dealId) return;
  revalidatePath(`/app/deals/${dealId}`);
  revalidatePath(bookPath(dealId));
  revalidatePath(`${bookPath(dealId)}/payment`);
}

function revalidateAccounts(dealId: string | null): void {
  revalidatePath('/app/accounts');
  revalidatePath(CLAIMS_PATH);
  if (dealId) revalidatePath(accountsDealPath(dealId));
}

/** Sales: "Report this payment to Accounts". */
export async function reportPaymentClaimAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseClaimReportForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await paymentClaimReport(asRpcClient(staff.supabase), parsed.value);
    revalidateSales(parsed.value.dealId);
    revalidateAccounts(null);
    // DA-291 status word.
    return done('Payment reported to Accounts. It shows as "Reported, not checked yet" until a second Accounts person checks the receipt.', result);
  } catch (error) {
    return refused(error, 'claim');
  }
}

/** Sales: "Withdraw report" (only while the claim is reported). */
export async function withdrawPaymentClaimAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseClaimWithdrawForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await paymentClaimWithdraw(asRpcClient(staff.supabase), parsed.value);
    revalidateSales(parsed.value.dealId);
    revalidateAccounts(parsed.value.dealId);
    return done('Report withdrawn. Accounts no longer needs to check it.', result);
  } catch (error) {
    return refused(error, 'claim');
  }
}

/** Accounts: "Record receipt from this claim" (receipt_record rules apply; a different person verifies). */
export async function recordReceiptFromClaimAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseReceiptFromClaimForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await receiptRecordFromClaim(asRpcClient(staff.supabase), parsed.value);
    revalidateAccounts(parsed.value.dealId);
    revalidateSales(parsed.value.dealId);
    const no = result.receiptNo ? ` ${result.receiptNo}` : '';
    return done(`Receipt${no} recorded from the claim. Another Accounts person must verify it before it counts as money.`, result);
  } catch (error) {
    return refused(error, 'claim');
  }
}

/** Accounts: "Link this receipt" (an existing receipt on the same Deal). */
export async function linkClaimReceiptAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseClaimLinkForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await paymentClaimLinkReceipt(asRpcClient(staff.supabase), parsed.value);
    revalidateAccounts(parsed.value.dealId);
    revalidateSales(parsed.value.dealId);
    return done('Receipt linked to the claim. No new receipt was created.', result);
  } catch (error) {
    return refused(error, 'claim');
  }
}

/** Accounts: "Money not found" (reason is shown to Sales). */
export async function markClaimNotReceivedAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseClaimNotReceivedForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await paymentClaimMarkNotReceived(asRpcClient(staff.supabase), parsed.value);
    revalidateAccounts(parsed.value.dealId);
    revalidateSales(parsed.value.dealId);
    return done('Marked as money not found. Sales sees your reason and may report the payment again.', result);
  } catch (error) {
    return refused(error, 'claim');
  }
}
