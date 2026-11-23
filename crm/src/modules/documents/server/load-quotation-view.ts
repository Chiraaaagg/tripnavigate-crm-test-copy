import 'server-only';
import { z } from 'zod';
import { holdsPurchaseAnywhere } from '@/modules/access/policy';
import type { StaffContext } from '@/modules/identity/server/session';
import type { QuotationDocumentView } from '../contracts';
import { CustomerMoneySchema, QuotationGetSchema, toQuotationDocumentView } from '../quotation-view';

/**
 * Customer quotation view for one version, read under the staff member's own
 * session (modules README rules 2 and 4). Atlas `quotation_get` returns null
 * to anyone who is not an editor of that quotation (Sales owner/assignee or
 * branch Manager); Purchase role holders are refused before any query. The
 * customer money comes from Mercury's `quotation_customer_money` (null for
 * anyone who may not read prices); without it the view has no tiers and the
 * adapter refuses `tier_missing`.
 *
 * Never uses the privileged client. Errors carry no database text.
 */

export type QuotationViewLoad =
  | { status: 'ok'; view: QuotationDocumentView; moneyVisible: boolean }
  | { status: 'not_found' }
  | { status: 'error' };

type DocStaff = Pick<StaffContext, 'displayName' | 'access' | 'supabase'>;

/** IST calendar date (YYYY-MM-DD). */
export function istDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function loadQuotationDocumentView(staff: DocStaff, versionId: string, now: Date = new Date()): Promise<QuotationViewLoad> {
  if (!z.uuid().safeParse(versionId).success) return { status: 'not_found' };
  if (holdsPurchaseAnywhere(staff.access)) return { status: 'not_found' };
  const { data, error } = await staff.supabase.rpc('quotation_get', { p_version_id: versionId });
  if (error) return error.code === '42501' ? { status: 'not_found' } : { status: 'error' };
  if (data === null || data === undefined) return { status: 'not_found' };
  const parsed = QuotationGetSchema.safeParse(data);
  if (!parsed.success) return { status: 'error' };
  const money = await staff.supabase.rpc('quotation_customer_money', { p_version_id: versionId });
  if (money.error) return { status: 'error' };
  let customerMoney = null;
  if (money.data !== null && money.data !== undefined) {
    const m = CustomerMoneySchema.safeParse(money.data);
    if (!m.success) return { status: 'error' };
    customerMoney = m.data;
  }
  const view = toQuotationDocumentView(parsed.data, customerMoney, {
    preparedBy: { name: staff.displayName, role: 'Travel consultant', phone: null },
    today: istDate(now),
  });
  return { status: 'ok', view, moneyVisible: customerMoney !== null };
}
