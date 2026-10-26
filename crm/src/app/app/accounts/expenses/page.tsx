import type { Metadata } from 'next';
import { ACCOUNTS_EXPENSE_FILTERS, type AccountsExpenseFilter } from '@/modules/finance/contracts';
import { acceptExpenseRecordAction, returnExpenseRecordAction } from '@/modules/finance/server/expense-actions';
import { loadExpenseQueue } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { B11NotInstalledView } from '@/views/b11/book-views';
import { AccountsExpensesView } from '@/views/b11/department-cost';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { financeRead } from '../finance-page-support';

// A-20 / DA-276
export const metadata: Metadata = { title: 'Department costs' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** B1.1c: department expense records for Accounts review (accounts_expense_records). */
export default async function AccountsExpensesPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[]; after?: string | string[] }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const raw = first(sp.filter);
  const filter: AccountsExpenseFilter = (ACCOUNTS_EXPENSE_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as AccountsExpenseFilter) : 'submitted';
  const page = await financeRead(() => loadExpenseQueue(staff, filter, first(sp.after) ?? null));
  if (!page.ok) {
    if (page.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={page.code} title="Department costs" />;
  }
  if (!page.value) return <B11NotInstalledView title="Department costs" text="Department costs are not available on this CRM yet." />;
  const hrefs = Object.fromEntries(ACCOUNTS_EXPENSE_FILTERS.map((f) => [f, `/app/accounts/expenses?filter=${f}`])) as Record<AccountsExpenseFilter, string>;
  const moreHref = page.value.nextAfter ? `/app/accounts/expenses?filter=${filter}&after=${encodeURIComponent(page.value.nextAfter)}` : null;
  return <AccountsExpensesView page={page.value} filter={filter} hrefs={hrefs} moreHref={moreHref} acceptAction={acceptExpenseRecordAction} returnAction={returnExpenseRecordAction} />;
}
