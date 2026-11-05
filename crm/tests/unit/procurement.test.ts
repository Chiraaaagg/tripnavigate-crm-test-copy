import { describe, expect, it } from 'vitest';
import type { RpcClient } from '@/modules/fulfilment/commands';
import {
  costPropose,
  mapProcurementError,
  PROCUREMENT_ERROR_STATES,
  ProcurementCommandError,
  purchaseWorkspace,
  supplierGet,
} from '@/modules/procurement/commands';
import { PROCUREMENT_ERROR_TEXT, PROCUREMENT_ISSUE_TEXT } from '@/modules/procurement/contracts';
import { latestCostVersionNo, toWorkspaceView } from '@/modules/procurement/dto';
import { parseBeneficiaryForm, parseCostForm, parseQuoteForm, parseSupplierConfirmForm, parseSupplierForm } from '@/modules/procurement/forms';

const T = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const R = '44444444-4444-4444-8444-444444444444';

function form(entries: Array<[string, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

function rpc(data: unknown, error: { code?: string; message?: string } | null = null): RpcClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push([fn, args]);
      return Promise.resolve({ data, error });
    },
  };
}

const TASK = {
  taskId: T,
  dealReference: 'SYN-DEL-001',
  hotelName: 'Synthetic Hotel',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 2,
  adults: 3,
  children: 1,
  purchaseBudgetPaise: '4500000',
  status: 'in_progress',
  assigneeName: 'Synthetic Purchase',
  assignedToYou: true,
  branchName: 'Delhi',
  createdAt: '2026-10-03T05:00:00Z',
  supplierConfirmedAt: null,
  roomType: null,
  mealPlan: null,
  inclusions: null,
  specialRequests: null,
  confirmedAt: '2026-10-03T04:00:00Z',
  confirmedByName: 'Synthetic Sales',
  versionNo: 1,
  canClaim: false,
};
const WORKSPACE = {
  task: TASK,
  canWork: true,
  canRelease: true,
  canReassign: false,
  canApproveOverBudget: false,
  assigneeUserId: R,
  reassignCandidates: [],
  gateIssue: null,
  issues: ['missing_supplier_confirmation_proof'],
  supplierReference: null,
  selectedQuoteId: null,
  supplierConfirmedByName: null,
  quotes: [
    {
      quoteId: Q,
      supplierId: S,
      supplierName: 'Synthetic Stays',
      supplierVerification: 'unverified',
      hotelName: 'Synthetic Hotel',
      roomType: null,
      mealPlan: null,
      quotedCostPaise: '4000000',
      holdUntil: null,
      cancellationTerms: null,
      status: 'open',
      createdAt: '2026-10-03T05:10:00Z',
      createdByName: null,
    },
  ],
  costVersions: [
    { versionNo: 2, quoteId: Q, stage: 'proposed', amountPaise: '3900000', dueDate: null, note: null, payableStatus: 'not_requested', createdAt: '2026-10-03T05:20:00Z', createdByName: null, overBudgetApprovedAt: null, overBudgetApprovedByName: null },
    { versionNo: 1, quoteId: Q, stage: 'proposed', amountPaise: '4000000', dueDate: null, note: null, payableStatus: 'not_requested', createdAt: '2026-10-03T05:15:00Z', createdByName: null, overBudgetApprovedAt: null, overBudgetApprovedByName: null },
  ],
  evidence: [],
};

describe('error mapping (contract §7)', () => {
  it('maps every token only with its own SQLSTATE and fails closed otherwise', () => {
    for (const [token, state] of Object.entries(PROCUREMENT_ERROR_STATES)) {
      expect(mapProcurementError({ code: state, message: token })).toBe(token);
      expect(PROCUREMENT_ERROR_TEXT[token as keyof typeof PROCUREMENT_ERROR_TEXT]).toBeTruthy();
    }
    expect(mapProcurementError({ code: '55000', message: 'over_budget' })).toBe('over_budget');
    expect(mapProcurementError({ code: '40001', message: 'over_budget' })).toBeNull();
    expect(mapProcurementError({ code: '55000', message: 'something else' })).toBeNull();
    expect(mapProcurementError({ code: '42501', message: 'permission denied for table x' })).toBe('not_authorized');
    expect(mapProcurementError({ code: 'PGRST301' })).toBe('session');
    expect(mapProcurementError({ code: 'XX000', message: 'boom' })).toBeNull();
  });

  it('never surfaces the database message', async () => {
    const client = rpc(null, { code: '55000', message: 'over_budget' });
    const err = await costPropose(client, { taskId: T, quoteId: Q, expectedVersionNo: 1, amountPaise: '1', dueDate: null, note: null, requestId: R }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcurementCommandError);
    expect((err as ProcurementCommandError).code).toBe('over_budget');
    expect(client.calls[0]).toEqual([
      'purchase_cost_propose',
      { p_task_id: T, p_quote_id: Q, p_expected_version_no: 1, p_amount_paise: '1', p_due_date: null, p_note: null, p_request_id: R },
    ]);
  });

  it('every issue code has staff wording', () => {
    for (const text of Object.values(PROCUREMENT_ISSUE_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe('response validation', () => {
  it('rejects a workspace that carries an unexpected shape', async () => {
    await expect(purchaseWorkspace(rpc({ ...WORKSPACE, canWork: 'yes' }), T)).rejects.toMatchObject({ code: null });
  });

  it('rejects a full account number in place of the last 4 digits', async () => {
    const supplier = {
      supplierId: S,
      legalEntityId: R,
      name: 'Synthetic Stays',
      serviceTypes: ['hotel'],
      city: null,
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      paymentTerms: null,
      verificationStatus: 'unverified',
      verifiedAt: null,
      verifiedByName: null,
      status: 'active',
      rowVersion: 1,
      updatedAt: '2026-10-03T05:00:00Z',
      canEdit: true,
      canVerify: false,
    };
    const ben = {
      revisionNo: 1,
      accountHolder: 'X',
      bankName: 'Y',
      ifsc: 'SYNB0000001',
      status: 'unverified',
      createdAt: '2026-10-03T05:00:00Z',
      createdByName: null,
      approvedAt: null,
      approvedByName: null,
      canApprove: false,
    };
    await expect(supplierGet(rpc({ ...supplier, beneficiaries: [{ ...ben, accountLast4: '000011112222' }] }), S)).rejects.toMatchObject({ code: null });
    expect((await supplierGet(rpc({ ...supplier, beneficiaries: [{ ...ben, accountLast4: '2222' }] }), S))!.beneficiaries[0]!.accountLast4).toBe('2222');
  });

  it('the workspace view copies named fields only and finds the latest cost version', async () => {
    const record = await purchaseWorkspace(rpc({ ...WORKSPACE, sellingTotalPaise: '9876543', task: { ...TASK, marginPaise: '1' } }), T);
    const view = toWorkspaceView(record!, []);
    expect(JSON.stringify(view)).not.toMatch(/selling|margin|9876543/i);
    expect(latestCostVersionNo(view)).toBe(2);
    expect(view.supplierChoices).toEqual([]);
  });
});

describe('form parsing', () => {
  it('supplier: needs a name and a known service type; status only on edit', () => {
    expect(parseSupplierForm(form([['name', 'Synthetic Stays'], ['serviceTypes', 'hotel']]), { allowStatus: false })).toMatchObject({
      ok: true,
      value: { name: 'Synthetic Stays', serviceTypes: ['hotel'], city: null },
    });
    expect(parseSupplierForm(form([['name', 'X'], ['serviceTypes', 'flight']]), { allowStatus: false }).ok).toBe(false);
    expect(parseSupplierForm(form([['name', ''], ['serviceTypes', 'hotel']]), { allowStatus: false }).ok).toBe(false);
    expect(parseSupplierForm(form([['name', 'X'], ['serviceTypes', 'hotel'], ['contactEmail', 'not-an-email']]), { allowStatus: false }).ok).toBe(false);
    expect(parseSupplierForm(form([['name', 'X'], ['serviceTypes', 'hotel']]), { allowStatus: true }).ok).toBe(false);
    expect(parseSupplierForm(form([['name', 'X'], ['serviceTypes', 'hotel'], ['status', 'archived']]), { allowStatus: true })).toMatchObject({ ok: true, value: { status: 'archived' } });
  });

  it('bank details: IFSC and digits only; IFSC upper-cased; spaces removed', () => {
    expect(parseBeneficiaryForm(form([['accountHolder', 'A'], ['bankName', 'B'], ['ifsc', 'synb0000001'], ['accountNumber', '0000 1111 2222']]))).toEqual({
      ok: true,
      value: { accountHolder: 'A', bankName: 'B', ifsc: 'SYNB0000001', accountNumber: '000011112222' },
    });
    expect(parseBeneficiaryForm(form([['accountHolder', 'A'], ['bankName', 'B'], ['ifsc', 'BAD'], ['accountNumber', '123456']])).ok).toBe(false);
    expect(parseBeneficiaryForm(form([['accountHolder', 'A'], ['bankName', 'B'], ['ifsc', 'SYNB0000001'], ['accountNumber', '12AB56']])).ok).toBe(false);
  });

  it('quote and cost: rupees become paise; zero and bad dates refused', () => {
    expect(parseQuoteForm(form([['supplierId', S], ['hotelName', 'H'], ['quotedCostRupees', '40,000.50'], ['holdUntil', '2026-11-30']]))).toMatchObject({
      ok: true,
      value: { quotedCostPaise: '4000050', holdUntil: '2026-11-30' },
    });
    expect(parseQuoteForm(form([['supplierId', S], ['hotelName', 'H'], ['quotedCostRupees', '0']])).ok).toBe(false);
    expect(parseQuoteForm(form([['supplierId', S], ['hotelName', 'H'], ['quotedCostRupees', '10'], ['holdUntil', '2026-02-30']])).ok).toBe(false);
    expect(
      parseCostForm(form([['taskId', T], ['quoteId', Q], ['requestId', R], ['expectedVersionNo', '0'], ['amountRupees', '39000']])),
    ).toMatchObject({ ok: true, value: { expectedVersionNo: 0, amountPaise: '3900000' } });
    expect(parseCostForm(form([['taskId', T], ['quoteId', Q], ['expectedVersionNo', '0'], ['amountRupees', '1']])).ok).toBe(false);
  });

  it('supplier confirmation: needs a reference and a cost version of at least 1', () => {
    expect(parseSupplierConfirmForm(form([['taskId', T], ['expectedVersionNo', '2'], ['reference', ' SYN-1 ']]))).toEqual({
      ok: true,
      value: { taskId: T, expectedVersionNo: 2, reference: 'SYN-1' },
    });
    expect(parseSupplierConfirmForm(form([['taskId', T], ['expectedVersionNo', '0'], ['reference', 'X']])).ok).toBe(false);
    expect(parseSupplierConfirmForm(form([['taskId', T], ['expectedVersionNo', '1'], ['reference', '']])).ok).toBe(false);
  });
});
