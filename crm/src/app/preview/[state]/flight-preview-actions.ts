'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Flight
 * build screens (fl- states), so a press shows the real success or refusal
 * path without a database. They read nothing, write nothing and return fixed
 * synthetic answers; the gallery is a 404 outside the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

const ok = (message: string, data?: unknown): Promise<Result> => settle({ ok: true, message, data });

export async function flClaimAction(): Promise<Result> {
  return ok('Synthetic preview: you took both flights of this Deal.');
}
export async function flClaimConflictAction(): Promise<Result> {
  return settle({ ok: false, code: 'task_conflict', message: 'Another Flight colleague took these flights first.' });
}
export async function flReassignAction(): Promise<Result> {
  return ok('Synthetic preview: the flights moved to the chosen colleague.');
}
export async function flApplyAction(): Promise<Result> {
  return ok('Synthetic preview: the new booking is applied. Unchanged flights kept their tickets.');
}
export async function flSaveSectorsAction(): Promise<Result> {
  return ok('Synthetic preview: sectors saved.');
}
export async function flFillAction(): Promise<Result> {
  return ok('Synthetic preview: missing details saved.');
}
export async function flSubmitChangeAction(): Promise<Result> {
  return ok('Synthetic preview: change sent to Sales for approval.');
}
export async function flSubmitChangeRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'duplicate_flight', message: 'These travellers are already on this exact flight.' });
}
export async function flWithdrawAction(): Promise<Result> {
  return ok('Synthetic preview: change withdrawn. The travellers are back on their flight.');
}
export async function flAckAction(): Promise<Result> {
  return ok('Synthetic preview: noted.');
}
export async function flCorrectAction(): Promise<Result> {
  return ok('Synthetic preview: ticket corrected. The old details stay in the record.');
}
export async function flUploadAction(): Promise<Result> {
  return ok('Synthetic preview: file attached.', { evidenceId: 'e0000000-0000-4000-8000-0000000000e1' });
}
export async function flCompleteAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: 'Finish the steps listed before doing this.' });
}
export async function flCompleteOkAction(): Promise<Result> {
  return ok('Synthetic preview: flight marked done · ticket issued.');
}

const previewBase = {
  fareHash: 'a'.repeat(64),
  batchCustomerTotalPaise: null,
  costTaskId: 'f0000000-0000-4000-8000-000000000301',
};

export async function flPreviewWithinAction(): Promise<Result> {
  return ok('preview', { ...previewBase, batchSupplierCostPaise: '3360000', dealSupplierCostAfterPaise: '3360000', dealBudgetPaise: '4200000', overBudget: false, approval: null });
}
export async function flPreviewOverAction(): Promise<Result> {
  return ok('preview', { ...previewBase, batchSupplierCostPaise: '5040000', dealSupplierCostAfterPaise: '5040000', dealBudgetPaise: '4200000', overBudget: true, approval: null });
}
export async function flPreviewApprovedAction(): Promise<Result> {
  return ok('preview', {
    ...previewBase,
    batchSupplierCostPaise: '5040000',
    dealSupplierCostAfterPaise: '5040000',
    dealBudgetPaise: '4200000',
    overBudget: true,
    approval: { approvalId: 'a0000000-0000-4000-8000-0000000000a1', status: 'approved' },
  });
}
export async function flAskManagerAction(): Promise<Result> {
  return ok('Synthetic preview: the Manager is asked to approve these fares.');
}
export async function flWithdrawFaresAction(): Promise<Result> {
  return ok('Synthetic preview: request withdrawn.');
}
export async function flConfirmAction(): Promise<Result> {
  return ok('Synthetic preview: 4 tickets confirmed in batch 1.');
}
export async function flConfirmRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'ticket_number_taken', message: 'This ticket number already belongs to another traveller.' });
}
export async function flCreateSupplierAction(): Promise<Result> {
  return ok('Synthetic preview: supplier added.', { supplierId: 'c0000000-0000-4000-8000-0000000000c9' });
}
export async function flDirectPaymentAction(): Promise<Result> {
  return ok('Synthetic preview: direct payment recorded and sent to Accounts.');
}
export async function flPaymentRequestAction(): Promise<Result> {
  return ok('Synthetic preview: payment request sent to Accounts.');
}
export async function flDecideChangeAction(): Promise<Result> {
  return ok('Synthetic preview: decision saved. Flight sees it.');
}
export async function flDecideFaresAction(): Promise<Result> {
  return ok('Synthetic preview: fares approved. Flight can confirm the tickets.');
}

export async function flInvoiceUploadAction(): Promise<Result> {
  return ok('Synthetic preview: file stored.', { evidenceId: 'e0000000-0000-4000-8000-0000000000e7' });
}
export async function flInvoiceSaveAction(): Promise<Result> {
  return ok('Synthetic preview: invoice recorded. Accounts checks it.');
}
export async function flBeneficiaryAction(): Promise<Result> {
  return ok('Synthetic preview: bank details recorded. A supplier verifier approves them.');
}
export async function flBeneficiaryRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.' });
}
export async function flUpdateSupplierAction(): Promise<Result> {
  return ok('Synthetic preview: supplier saved. It is unverified again until a supplier verifier checks it.');
}
export async function flFillNameAction(): Promise<Result> {
  return ok('Name saved. The Flight team can now book this traveller.');
}
export async function flFillNameRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'name_already_set', message: 'This traveller already has a name. Reload the page to see it.' });
}
