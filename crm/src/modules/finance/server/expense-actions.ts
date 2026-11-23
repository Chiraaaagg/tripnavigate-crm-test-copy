'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { expenseRecordAccept, expenseRecordReturn } from '../commands';
import { type FinanceActionState, parseExpenseReviewForm } from '../forms';
import { done, invalid, refused } from './b11-results';

/**
 * B1.1 expense records (freeze note §3.2): Accounts accepts or returns a
 * company-paid department cost. Accepting records it only: it never
 * approves, makes or schedules a payment. Reviewer ≠ submitter (database).
 */

type Prev = { status: string } | null | undefined;

const EXPENSES_PATH = '/app/accounts/expenses';

export async function acceptExpenseRecordAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseExpenseReviewForm(formData, false);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await expenseRecordAccept(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(EXPENSES_PATH);
    revalidatePath('/app');
    return done('Accepted (recorded only; not approved for payment).', result);
  } catch (error) {
    return refused(error, 'expense');
  }
}

export async function returnExpenseRecordAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseExpenseReviewForm(formData, true);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await expenseRecordReturn(asRpcClient(staff.supabase), { ...parsed.value, reason: parsed.value.reason! });
    revalidatePath(EXPENSES_PATH);
    revalidatePath('/app');
    return done('Expense record returned to the department with your reason.', result);
  } catch (error) {
    return refused(error, 'expense');
  }
}
