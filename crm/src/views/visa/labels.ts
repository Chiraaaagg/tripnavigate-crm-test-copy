import {
  VISA_COST_KIND_LABEL,
  VISA_ERROR_TEXT as B_ERROR_TEXT,
  VISA_HANDOVER_LABEL,
  VISA_KIND_LABEL,
  VISA_NOT_READY_REASON,
  VISA_UNKNOWN_OUTCOME_TEXT,
} from '@/modules/visa/contracts';
import type {
  HandoverMethod,
  VisaApplicant,
  VisaCostKind,
  VisaExpenseStatus,
  VisaNotReadyToken,
  VisaOpenStep,
  VisaPaidBy,
  VisaPaxType,
  VisaPaymentMode,
  VisaWorkspace,
} from './types';

/*
 * Words the Visa and passport screens show (Visa build contract sections
 * 6.1, 8 and 11). Status words and refusal messages are frozen by the
 * contract; the server module repeats them in its contracts.ts and the
 * database stays the authority for every state. Nothing here says the CRM
 * sends anything: the desk records what it did.
 */

/** Contract 6.1 frozen messages and not-ready reasons come from the server module (one source). */
export const VISA_ERROR_TEXT: Record<string, string> = { ...B_ERROR_TEXT, unexpected: VISA_UNKNOWN_OUTCOME_TEXT };
export const NOT_READY_TEXT: Record<VisaNotReadyToken, string> = VISA_NOT_READY_REASON;

/** Contract 8: task status words by first unfinished step. */
export const STEP_STATUS_TEXT: Record<VisaOpenStep, string> = {
  ready: 'Documents and date pending',
  applied: 'Not applied yet',
  decision: 'Waiting for decision',
  handover: 'Handover pending',
};

/** HTML visaNext (H:15055): the "Next:" line for the assignee by current step. */
export const STEP_NEXT_TEXT: Record<VisaOpenStep, string> = {
  ready: 'receive each passenger’s documents and set the appointment date',
  applied: 'record each passenger’s application',
  decision: 'record the decision from the visa department',
  handover: 'finish the handover',
};

export const STEP_LABEL: Record<string, string> = {
  take: 'Task taken',
  ready: 'Documents and date',
  applied: 'Applied',
  decision: 'Decision',
  handover: 'Handover',
};

export const PAX_LABEL: Record<VisaPaxType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };

export const KIND_LABEL: Record<'e_visa' | 'sticker', string> = VISA_KIND_LABEL;

/** Contract 10: handover words (frozen). */
export const HANDOVER_LABEL: Record<HandoverMethod, string> = VISA_HANDOVER_LABEL;
export const HANDOVER_METHODS: HandoverMethod[] = ['office', 'executive', 'courier', 'not_with_us'];

export const COST_KIND_LABEL: Record<VisaCostKind, string> = VISA_COST_KIND_LABEL;

export const PAID_BY_LABEL: Record<VisaPaidBy, string> = { company: 'Company', customer_direct: 'Customer directly', not_yet: 'Not paid yet' };

export const PAYMENT_MODE_LABEL: Record<VisaPaymentMode, string> = { bank_transfer: 'Bank transfer', upi: 'UPI', card: 'Card', cash: 'Cash', other: 'Other' };
export const PAYMENT_MODES: VisaPaymentMode[] = ['bank_transfer', 'upi', 'card', 'cash', 'other'];

export const EXPENSE_STATUS_LABEL: Record<VisaExpenseStatus, string> = {
  draft: 'Waiting for a receipt',
  submitted: 'With Accounts',
  accepted: 'Accepted by Accounts',
  returned: 'Returned by Accounts',
};


export const PASSPORT_APPLICATION_LABEL: Record<string, string> = { fresh: 'Fresh passport', renewal: 'Renewal', tatkaal: 'Tatkaal', minor: 'Minor' };

/** Government fee paid by (Sales' booking value) in desk words (HTML H:15293). */
export function feePaidByText(v: string | null | undefined): string {
  if (v === 'company') return 'Company pays (recorded for Accounts review)';
  if (v === 'customer') return 'Customer pays the government fee directly';
  return 'Not decided yet';
}

/** Default "Paid by" of the Applied popup: Sales' customer → Customer directly, else Company. */
export function defaultPaidBy(ws: VisaWorkspace): VisaPaidBy {
  return 'visa' in ws.facts && ws.facts.visa.feePaidBy === 'customer' ? 'customer_direct' : 'company';
}

export function nameOf(a: Pick<VisaApplicant, 'fullName' | 'seq'>): string {
  return a.fullName?.trim() || `Traveller ${a.seq}`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Message for a refusal: the server message wins, then the frozen token text. */
export function refusalText(code: string | undefined, message: string | undefined): string {
  if (message) return message;
  return (code && VISA_ERROR_TEXT[code]) || VISA_ERROR_TEXT.invalid_input!;
}

/** The not_ready refusal with its reason ("Not ready to apply yet: documents not received."). */
export function notReadyLine(tokens: VisaNotReadyToken[]): string | null {
  const first = tokens.find((t) => t !== 'wrong_state' && t !== 'superseded');
  return first ? `Not ready to apply yet: ${NOT_READY_TEXT[first]}.` : null;
}
