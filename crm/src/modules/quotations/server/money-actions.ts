'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { quotationCostEstimatesSave, quotationLinesSave, quotationPlanSave, quotationTotalSave } from '../commands';
import { QUOTATION_TEXT, type QuotationActionResult, type QuotationSaveResult } from '../contracts';
import { parseQuotationCostEstimatesForm, parseQuotationLinesForm, parseQuotationPlanForm, parseQuotationTierTotalForm, QFIELD } from '../forms';
import { linesWordingFields, planWordingFields } from '../wording';
import { qfail, qfailFrom } from './results';

/**
 * Quotation money actions (Mercury 20261120000300 commands). Commercial
 * editors only (the database refuses everyone else: Purchase, Flight, the
 * desk, Accounts and Super Admin never reach quotation money). Amounts are
 * whole paise as decimal strings from rupee text: customer amounts whole
 * rupees, cost estimates may carry paise. Quantities are sent exactly as
 * typed (DEC-33: never derived from stays). The typed total is never
 * adjusted to the components (DEC-34). No tax is computed. Drafts only,
 * except the internal cost refresh.
 */

type Prev<T> = QuotationActionResult<T> | null;

function revalidateQuotations(): void {
  revalidatePath('/app/quotations', 'layout');
  revalidatePath('/app/leads/[id]', 'page');
  revalidatePath('/app/deals/[id]', 'page');
}

/** Database hint "lines[n].key" → the form's parallel input name (1-based → 0-based in hintFields). */
const LINE_HINTS = {
  lines: QFIELD.lineDescription,
  'lines.lineNo': QFIELD.lineDescription,
  'lines.optionKey': QFIELD.lineOptionKey,
  'lines.itemId': QFIELD.lineItemId,
  'lines.chargeKind': QFIELD.lineChargeKind,
  'lines.categoryKey': QFIELD.lineCategoryKey,
  'lines.description': QFIELD.lineDescription,
  'lines.unitKind': QFIELD.lineUnitKind,
  'lines.units': QFIELD.lineUnits,
  'lines.periods': QFIELD.linePeriods,
  'lines.unitSellPaise': QFIELD.lineUnitSellRupees,
  'lines.unitCostPaise': QFIELD.lineUnitCostRupees,
  'lines.remark': QFIELD.lineRemark,
};
const PLAN_HINTS = {
  instalments: QFIELD.instalmentLabel,
  'instalments.label': QFIELD.instalmentLabel,
  'instalments.amountPaise': QFIELD.instalmentAmountRupees,
  'instalments.dueRule': QFIELD.instalmentDueRule,
  'instalments.dueDays': QFIELD.instalmentDueDays,
  'instalments.dueDate': QFIELD.instalmentDueDate,
  tierKey: QFIELD.tierKey,
};

/** All price lines of a draft version (quotation_lines_save replaces the set). */
export async function saveQuotationLinesAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationLinesForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const wording = linesWordingFields(parsed.value.lines);
  if (wording.length > 0) return qfail('internal_wording', wording);
  try {
    const result = await quotationLinesSave(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, LINE_HINTS);
  }
}

/** The typed quoted total of one option (DEC-34); empty clears it while drafting. */
export async function saveQuotationTierTotalAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationTierTotalForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await quotationTotalSave(asRpcClient(staff.supabase), {
      versionId: v.versionId,
      expectedRowVersion: v.expectedRowVersion,
      tierKey: v.tierKey,
      totalPaise: v.quotedTotalPaise,
      showPerPerson: v.showPerPerson,
    });
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, { tierKey: QFIELD.tierKey, totalPaise: QFIELD.quotedTotalRupees });
  }
}

/** The payment schedule of one option (optional; must equal the typed total before sending). */
export async function saveQuotationPlanAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationPlanForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const wording = planWordingFields(parsed.value.instalments);
  if (wording.length > 0) return qfail('internal_wording', wording);
  try {
    const result = await quotationPlanSave(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, PLAN_HINTS);
  }
}

/** Internal cost refresh after sending (not hashed; no new version; refused once converted). */
export async function saveQuotationCostEstimatesAction(
  _prev: Prev<{ updated: number }>,
  formData: FormData,
): Promise<QuotationActionResult<{ updated: number }>> {
  const staff = await requireStaff();
  const parsed = parseQuotationCostEstimatesForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationCostEstimatesSave(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: { updated: result.updated }, message: 'Cost estimates saved. They are internal and do not change the quotation.' };
  } catch (error) {
    return qfailFrom(error, { costs: QFIELD.lineUnitCostRupees });
  }
}
