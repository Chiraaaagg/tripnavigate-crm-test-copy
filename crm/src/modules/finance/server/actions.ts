'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  billingSave,
  billingVerify,
  chequeClear,
  chequeMark,
  chequeRepresent,
  depositRecord,
  depositReject,
  depositVerify,
  companyDestinationVersionDetail,
  destinationApprove,
  destinationRetire,
  destinationReturn,
  destinationSubmit,
  FinanceCommandError,
  policyUpdate,
  receiptRecord,
  receiptReject,
  receiptReverse,
  receiptVerify,
  reconciliationRecord,
  reconciliationVerify,
  reviewApprove,
  reviewReturn,
} from '../commands';
import {
  type DestinationVersionDetail,
  FINANCE_ERROR_TEXT,
  RECEIPT_STATUS_LABEL,
  type FinanceCommandResult,
  type ReceiptStatus,
} from '../contracts';
import {
  FINANCE_FIELD as F,
  type FieldErrors,
  type FinanceActionState,
  parseBillingForm,
  parseChequeMarkKind,
  parseChequeNote,
  parseDepositForm,
  parseDestinationForm,
  parseEvidenceKind,
  parseOutcomeDate,
  parsePolicyForm,
  parseReason,
  parseReceiptForm,
  parseReconciliationForm,
  parseRejectionKind,
  parseReversalKind,
  readExpectedRowVersion,
  readRequestId,
  readUuidField,
} from '../forms';
import { discardFinanceEvidence, storeFinanceEvidence, type StoreEvidenceResult } from './evidence';
import { depositSlipRequestId } from './slip-id';

/**
 * Phase 5A server actions: (prevState, FormData) -> FinanceActionState.
 * Every action: requireStaff(); parse the form (never the actor, entity
 * membership or role); run the database command under the staff member's OWN
 * session. The hidden requestId makes a resubmission an exact retry. Database
 * messages never reach the browser; refusals map to FINANCE_ERROR_TEXT. An
 * unexplained failure is rethrown without detail (the command may have
 * committed), and the form shows its "reload to check" text.
 */

/** Previous state is never read; any shape the views keep is accepted. */
type Prev = { status: string } | null | undefined;

const ACCOUNTS_PATH = '/app/accounts';
const CASH_PATH = '/app/accounts/cash';
const POLICY_PATH = '/app/admin/finance-policy';
const dealPath = (dealId: string) => `/app/accounts/deals/${dealId}`;

// G-05
const UNKNOWN_OUTCOME = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';
const SESSION_TEXT = 'Your session has ended. Sign in again, then retry.';
const FORM_OUT_OF_DATE = 'This form is out of date. Reload the page and try again.';
const CAP_TEXT = {
  payer_day: 'This cash amount is over the company cash limit for this payer today (all branches). Ask for a bank transfer, UPI or cheque instead.',
  trip: 'This cash amount is over the company cash limit for this trip. Ask for a bank transfer, UPI or cheque instead.',
} as const;
const FILE_TEXT = {
  file_rejected: 'Choose a PDF, JPEG, PNG or WebP file of at most 4 MB whose content matches its type.',
  upload_failed: 'The file could not be uploaded. Nothing was recorded. Please retry.',
} as const;

function invalid(fieldErrors: FieldErrors): FinanceActionState {
  const { _form, ...rest } = fieldErrors;
  return {
    status: 'error',
    code: 'invalid_input',
    message: _form ?? FINANCE_ERROR_TEXT.invalid_input,
    fieldErrors: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function refused(error: unknown): FinanceActionState {
  if (error instanceof FinanceCommandError) {
    if (error.code === 'session') return { status: 'error', code: 'session', message: SESSION_TEXT };
    if (error.code === 'cash_cap_exceeded') {
      return { status: 'error', code: error.code, message: error.capKind ? CAP_TEXT[error.capKind] : FINANCE_ERROR_TEXT.cash_cap_exceeded };
    }
    if (error.code) return { status: 'error', code: error.code, message: FINANCE_ERROR_TEXT[error.code] };
  }
  throw new Error(UNKNOWN_OUTCOME);
}

function fromEvidence(result: Exclude<StoreEvidenceResult, { ok: true }>): FinanceActionState {
  if (result.code === 'file_rejected') return { status: 'error', code: 'invalid_input', message: FILE_TEXT.file_rejected, fieldErrors: { [F.file]: FILE_TEXT.file_rejected } };
  if (result.code === 'upload_failed') return { status: 'error', code: 'upload_failed', message: FILE_TEXT.upload_failed };
  if (result.code === 'duplicate_reference') {
    const text = 'This exact file is already attached to another record. The same proof cannot back two receipts or deposits.';
    return { status: 'error', code: result.code, message: text, fieldErrors: { [F.file]: text } };
  }
  if (result.code === 'unknown') throw new Error(UNKNOWN_OUTCOME);
  return { status: 'error', code: result.code, message: FINANCE_ERROR_TEXT[result.code] };
}

function ok(message: string, result?: FinanceCommandResult): FinanceActionState {
  const replay = result?.outcome === 'existing' ? ' (already recorded; nothing changed)' : '';
  return { status: 'ok', message: `${message}${replay}` };
}

function revalidateDeal(dealId: string | null): void {
  revalidatePath(ACCOUNTS_PATH);
  if (dealId) revalidatePath(dealPath(dealId));
}

function statusText(status: string | undefined): string {
  return status && status in RECEIPT_STATUS_LABEL ? RECEIPT_STATUS_LABEL[status as ReceiptStatus] : 'Saved';
}

// ---------------------------------------------------------------------------
// Billing and review
// ---------------------------------------------------------------------------

export async function saveBillingAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, F.dealId);
  const requestId = readRequestId(formData);
  const expectedRowVersion = readExpectedRowVersion(formData);
  const parsed = parseBillingForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  if (!dealId || !requestId || expectedRowVersion === null) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await billingSave(asRpcClient(staff.supabase), { dealId, expectedRowVersion, fields: parsed.value, requestId });
    revalidateDeal(dealId);
    // DA-296: another Accounts person checks them.
    return ok('Billing details saved, not checked yet. Another Accounts check is needed.', result);
  } catch (error) {
    if (error instanceof FinanceCommandError && error.code === 'version_changed') revalidateDeal(dealId);
    return refused(error);
  }
}

export async function verifyBillingAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, F.dealId);
  const requestId = readRequestId(formData);
  const expectedRowVersion = readExpectedRowVersion(formData);
  if (!dealId || !requestId || expectedRowVersion === null) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await billingVerify(asRpcClient(staff.supabase), { dealId, expectedRowVersion, requestId });
    revalidateDeal(dealId);
    // DA-296
    return ok('Billing details checked.', result);
  } catch (error) {
    if (error instanceof FinanceCommandError && error.code === 'version_changed') revalidateDeal(dealId);
    return refused(error);
  }
}

export async function returnReviewAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, F.dealId);
  const bookingVersionId = readUuidField(formData, F.bookingVersionId);
  const requestId = readRequestId(formData);
  const reason = parseReason(formData);
  if (!reason.ok) return invalid(reason.fieldErrors);
  if (!bookingVersionId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await reviewReturn(asRpcClient(staff.supabase), { bookingVersionId, reason: reason.value, requestId });
    revalidateDeal(dealId);
    return ok('Review returned. Sales sees the reason in Book now.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function approveReviewAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, F.dealId);
  const bookingVersionId = readUuidField(formData, F.bookingVersionId);
  const requestId = readRequestId(formData);
  const expectedRowVersion = readExpectedRowVersion(formData);
  if (!bookingVersionId || !requestId || expectedRowVersion === null) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await reviewApprove(asRpcClient(staff.supabase), { bookingVersionId, expectedRowVersion, requestId });
    revalidateDeal(dealId);
    return ok('Booking review approved. No money was posted and no document was issued.', result);
  } catch (error) {
    if (error instanceof FinanceCommandError && error.code === 'version_changed') revalidateDeal(dealId);
    return refused(error);
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export async function recordReceiptAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseReceiptForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await receiptRecord(asRpcClient(staff.supabase), parsed.value);
    revalidateDeal(parsed.value.dealId);
    revalidatePath(CASH_PATH);
    return ok(`Receipt ${result.receiptNo ?? ''} recorded (internal number). Another Accounts person must verify it.`.replace('Receipt  ', 'Receipt '), result);
  } catch (error) {
    // The chosen company account was replaced or retired: refresh the page's
    // options so the person can choose again instead of resubmitting a stale one.
    if (error instanceof FinanceCommandError && error.code === 'destination_changed') revalidateDeal(parsed.value.dealId);
    return refused(error);
  }
}

function receiptIds(formData: FormData): { dealId: string | null; receiptId: string | null; requestId: string | null } {
  return { dealId: readUuidField(formData, F.dealId), receiptId: readUuidField(formData, F.receiptId), requestId: readRequestId(formData) };
}

export async function verifyReceiptAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  if (!receiptId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await receiptVerify(asRpcClient(staff.supabase), { receiptId, requestId });
    revalidateDeal(dealId);
    revalidatePath(CASH_PATH);
    return ok(result.status === 'pending_clearance' ? 'Cheque verified. It now waits for bank clearance; nothing counts as received yet.' : 'Receipt verified.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function rejectReceiptAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  const kind = parseRejectionKind(formData);
  const reason = parseReason(formData);
  const errors: FieldErrors = reason.ok ? {} : { ...reason.fieldErrors };
  if (!kind) errors[F.kind] = 'Choose why the receipt is rejected.';
  if (Object.keys(errors).length > 0) return invalid(errors);
  if (!receiptId || !requestId || !kind || !reason.ok) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await receiptReject(asRpcClient(staff.supabase), { receiptId, kind, reason: reason.value, requestId });
    revalidateDeal(dealId);
    revalidatePath(CASH_PATH);
    return ok('Receipt rejected. It stays in the history.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function clearChequeAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  const date = parseOutcomeDate(formData);
  if (!date.ok) return invalid(date.fieldErrors);
  if (!receiptId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await chequeClear(asRpcClient(staff.supabase), { receiptId, outcomeDate: date.value, requestId });
    revalidateDeal(dealId);
    return ok('Cheque cleared. The money now counts as available customer funds.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function markChequeAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  const kind = parseChequeMarkKind(formData);
  if (!kind) return invalid({ [F.kind]: 'Choose what happened to the cheque.' });
  const date = parseOutcomeDate(formData);
  const note = parseChequeNote(formData, kind);
  const errors: FieldErrors = { ...(date.ok ? {} : date.fieldErrors), ...(note.ok ? {} : note.fieldErrors) };
  if (!date.ok || !note.ok) return invalid(errors);
  if (!receiptId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await chequeMark(asRpcClient(staff.supabase), { receiptId, kind, outcomeDate: date.value, note: note.value, requestId });
    revalidateDeal(dealId);
    return ok(`${statusText(result.status)}. It never counts as received money.`, result);
  } catch (error) {
    return refused(error);
  }
}

export async function representChequeAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  if (!receiptId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await chequeRepresent(asRpcClient(staff.supabase), { receiptId, requestId });
    revalidateDeal(dealId);
    return ok('Cheque presented again. It waits for bank clearance; the amount is not counted twice.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function reverseReceiptAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { dealId, receiptId, requestId } = receiptIds(formData);
  const kind = parseReversalKind(formData);
  const reason = parseReason(formData);
  const errors: FieldErrors = reason.ok ? {} : { ...reason.fieldErrors };
  if (!kind) errors[F.kind] = 'Choose why the receipt is reversed.';
  if (Object.keys(errors).length > 0) return invalid(errors);
  if (!receiptId || !requestId || !kind || !reason.ok) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await receiptReverse(asRpcClient(staff.supabase), { receiptId, kind, reason: reason.value, requestId });
    revalidateDeal(dealId);
    revalidatePath(CASH_PATH);
    return ok('Receipt reversed. The original and its reversal both stay in the history. No refund is made here.', result);
  } catch (error) {
    return refused(error);
  }
}

/**
 * Proof for a receipt (bank proof or cheque image). Deposit slips are uploaded
 * with the deposit itself (recordDepositAction): a slip is linked when the
 * deposit is recorded and never added afterwards.
 */
export async function uploadEvidenceAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, F.dealId);
  const receiptId = readUuidField(formData, F.receiptId);
  const requestId = readRequestId(formData);
  const kind = parseEvidenceKind(formData);
  if (!kind || kind === 'deposit_slip') return invalid({ [F.kind]: 'Choose what the file shows.' });
  if (!receiptId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  const stored = await storeFinanceEvidence(staff, { targetType: 'receipt', targetId: receiptId, kind, file: formData.get(F.file), requestId });
  revalidateDeal(dealId);
  if (!stored.ok) return fromEvidence(stored);
  return { status: 'ok', message: 'File uploaded.' };
}

// ---------------------------------------------------------------------------
// Cash custody and reconciliation
// ---------------------------------------------------------------------------

export async function recordDepositAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseDepositForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  const rpc = asRpcClient(staff.supabase);
  // The slip's request id derives from the deposit's: an exact retry replays
  // the same slip (begin and finish are idempotent) and then the stored deposit.
  const stored = await storeFinanceEvidence(staff, {
    targetType: 'branch',
    targetId: parsed.value.branchId,
    kind: 'deposit_slip',
    file: formData.get(F.file),
    requestId: depositSlipRequestId(parsed.value.requestId),
  });
  if (!stored.ok) return fromEvidence(stored);
  try {
    const result = await depositRecord(rpc, { ...parsed.value, evidenceId: stored.evidenceId });
    revalidatePath(CASH_PATH);
    return ok('Deposit recorded. Another Accounts person verifies it against the slip.', result);
  } catch (error) {
    // Free the unused slip. If the deposit did commit, the slip is linked and
    // the database refuses the removal, so this is always safe.
    await discardFinanceEvidence(rpc, stored.evidenceId);
    return refused(error);
  }
}

function depositIds(formData: FormData) {
  return { depositId: readUuidField(formData, F.depositId), requestId: readRequestId(formData) };
}

export async function verifyDepositAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { depositId, requestId } = depositIds(formData);
  if (!depositId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await depositVerify(asRpcClient(staff.supabase), { depositId, requestId });
    revalidatePath(CASH_PATH);
    return ok('Deposit verified. The cash moved from the branch to the bank; customer funds did not change.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function rejectDepositAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { depositId, requestId } = depositIds(formData);
  const reason = parseReason(formData);
  if (!reason.ok) return invalid(reason.fieldErrors);
  if (!depositId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await depositReject(asRpcClient(staff.supabase), { depositId, reason: reason.value, requestId });
    revalidatePath(CASH_PATH);
    return ok('Deposit rejected. Its receipts can go into a new deposit.', result);
  } catch (error) {
    return refused(error);
  }
}

export async function recordReconciliationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseReconciliationForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await reconciliationRecord(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(CASH_PATH);
    return ok('Cash count recorded. Another Accounts person verifies it.', result);
  } catch (error) {
    if (error instanceof FinanceCommandError && error.code === 'invalid_input' && !parsed.value.note) {
      const text = 'The count differs from the expected cash. Explain the difference in a note of 10 to 500 characters.';
      return { status: 'error', code: 'invalid_input', message: text, fieldErrors: { [F.note]: text } };
    }
    return refused(error);
  }
}

export async function verifyReconciliationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const reconciliationId = readUuidField(formData, F.reconciliationId);
  const requestId = readRequestId(formData);
  if (!reconciliationId || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await reconciliationVerify(asRpcClient(staff.supabase), { reconciliationId, requestId });
    revalidatePath(CASH_PATH);
    return ok('Cash count verified.', result);
  } catch (error) {
    return refused(error);
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function updatePolicyAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parsePolicyForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await policyUpdate(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(POLICY_PATH);
    revalidatePath(ACCOUNTS_PATH);
    return ok(
      result.status === 'scheduled'
        ? `Policy version ${result.rowVersion ?? ''} scheduled. Existing receipts keep the version they were recorded under.`
        : `Policy version ${result.rowVersion ?? ''} is now in effect. Existing receipts keep the version they were recorded under.`,
      result,
    );
  } catch (error) {
    return refused(error);
  }
}

// ---------------------------------------------------------------------------
// Stage 2: company destinations
// ---------------------------------------------------------------------------

const DESTINATIONS_PATH = '/app/accounts/destinations';

const DESTINATION_WRONG_STATE =
  'This company account changed meanwhile (a version is already waiting, it was decided, or it was retired). Nothing was saved. Reload the page.';

/** Same mapping as receipts, with destination wording for a state refusal. */
function refusedDestination(error: unknown): FinanceActionState {
  const state = refused(error);
  return state.code === 'wrong_state' ? { ...state, message: DESTINATION_WRONG_STATE } : state;
}

function revalidateDestinations(): void {
  revalidatePath(DESTINATIONS_PATH);
  revalidatePath(ACCOUNTS_PATH, 'layout');
}

/** Add a destination (version 1) or submit a replacement/correction version. Values never appear in messages. */
export async function submitDestinationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const parsed = parseDestinationForm(formData);
  if (!parsed.ok) return invalid(parsed.fieldErrors);
  try {
    const result = await destinationSubmit(asRpcClient(staff.supabase), parsed.value);
    revalidateDestinations();
    return ok('Details submitted. Another Accounts person must approve this exact version before it can be used.', result);
  } catch (error) {
    return refusedDestination(error);
  }
}

function decisionIds(formData: FormData) {
  return {
    versionId: readUuidField(formData, F.versionId),
    expectedRowVersion: readExpectedRowVersion(formData),
    requestId: readRequestId(formData),
  };
}

export async function approveDestinationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { versionId, expectedRowVersion, requestId } = decisionIds(formData);
  if (!versionId || expectedRowVersion === null || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  try {
    const result = await destinationApprove(asRpcClient(staff.supabase), { versionId, expectedRowVersion, requestId });
    revalidateDestinations();
    return ok('Version approved. It is now the account new receipts can select; the previous version stays in history.', result);
  } catch (error) {
    return refusedDestination(error);
  }
}

export async function returnDestinationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const { versionId, expectedRowVersion, requestId } = decisionIds(formData);
  const reason = parseReason(formData);
  if (!versionId || expectedRowVersion === null || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  if (!reason.ok) return invalid(reason.fieldErrors);
  try {
    const result = await destinationReturn(asRpcClient(staff.supabase), { versionId, expectedRowVersion, reason: reason.value, requestId });
    revalidateDestinations();
    return ok('Version returned with your reason. The maker submits a corrected version.', result);
  } catch (error) {
    return refusedDestination(error);
  }
}

export async function retireDestinationAction(_prev: Prev, formData: FormData): Promise<FinanceActionState> {
  const staff = await requireStaff();
  const destinationId = readUuidField(formData, F.destinationId);
  const expectedRowVersion = readExpectedRowVersion(formData);
  const requestId = readRequestId(formData);
  const reason = parseReason(formData);
  if (!destinationId || expectedRowVersion === null || !requestId) return invalid({ _form: FORM_OUT_OF_DATE });
  if (!reason.ok) return invalid(reason.fieldErrors);
  try {
    const result = await destinationRetire(asRpcClient(staff.supabase), { destinationId, expectedRowVersion, reason: reason.value, requestId });
    revalidateDestinations();
    return ok('Account retired. New receipts can no longer select it; earlier receipts keep their record.', result);
  } catch (error) {
    return refusedDestination(error);
  }
}

/** Result of an audited full-details read. The values live only in this response, never in a URL or message. */
export type DestinationDetailState =
  | { status: 'idle' }
  | { status: 'ok'; detail: DestinationVersionDetail }
  | { status: 'error'; message: string };

/** "Show full details": one audited read of one version (POST, so nothing is prefetched or cached). */
export async function showDestinationDetailAction(_prev: Prev, formData: FormData): Promise<DestinationDetailState> {
  const staff = await requireStaff();
  const versionId = readUuidField(formData, F.versionId);
  if (!versionId) return { status: 'error', message: FORM_OUT_OF_DATE };
  try {
    return { status: 'ok', detail: await companyDestinationVersionDetail(asRpcClient(staff.supabase), versionId) };
  } catch (error) {
    if (error instanceof FinanceCommandError) {
      if (error.code === 'session') return { status: 'error', message: SESSION_TEXT };
      if (error.code) return { status: 'error', message: FINANCE_ERROR_TEXT[error.code] };
    }
    return { status: 'error', message: 'The details could not be shown right now. Please retry.' };
  }
}
