'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { QUOTATION_ERROR_TEXT, type QuotationActionResult, type QuotationErrorCode } from '../contracts';
import {
  itineraryCreateStandalone,
  quotationCreateStandalone,
  ReferralCommandError,
  referralDraftClose,
  referralDraftLink,
  referralDraftReassign,
  referralDraftReopen,
  referralDraftSave,
  referralDraftUnlink,
  type ReferralCloseResult,
  type ReferralErrorCode,
  type ReferralLinkResult,
  type ReferralReassignResult,
  type ReferralReopenResult,
  type ReferralSaveResult,
  type ReferralUnlinkResult,
} from '../referral';
import {
  parseReferralCloseForm,
  parseReferralCreateForm,
  parseReferralLinkForm,
  parseReferralReassignForm,
  parseReferralReopenForm,
  parseReferralSaveForm,
  parseReferralUnlinkForm,
} from '../referral-input';
import { referralDraftHref } from '../subject-links';
import { RFIELD, type ReferralCreatedVM } from '../work-contract';
import { workDateText, workListHref } from '../work-model';
import { UNKNOWN_QUOTATION_OUTCOME } from './results';

/*
 * Batch 3 referral draft actions (Terra, T-3; atlas-batch3-shapes v2 §3).
 * Every action: requireStaff() (aal2, active staff); parse the form (frozen
 * RFIELD names; never actor, owner or entity); run ONE database command under
 * the staff member's own session. The database authorizes first (owner with
 * Sales in the branch, branch Manager, linked Deal/Lead editors), then locks
 * the draft and refuses draft_closed before writing anything; it audits each
 * change. Linking never converts or books; "Start booking from quotation" is
 * convertQuotationAction (bind, then convert). Results have the quotation
 * action shape so the screens reuse their result boxes; refusals keep the
 * typed values on screen and name the RFIELD inputs.
 */

type Prev<T> = QuotationActionResult<T> | null;

/** Plain words for the referral screens where the quotation wording would mislead (DA-65, DA-69, DA-75, DA-78). */
const REFERRAL_TEXT: Partial<Record<ReferralErrorCode, string>> = {
  not_found: 'This referral draft is not available to you. It may not exist, or you may not have access.',
  version_changed: 'Not saved. Someone changed this draft after you opened it. Your typed values are still on screen; reload to see the latest.',
  branch_mismatch: 'That deal is in another branch. Ask that branch’s Manager.',
  deal_removed: 'That deal was removed from the CRM by the Bitrix update.',
  deal_not_active: 'That deal is lost or rejected in Bitrix.',
  deal_not_from_lead: 'That deal was not made from the linked lead in Bitrix.',
  deal_already_linked: 'That deal already has an accepted quotation.',
};

/** DA-236: not_authorized names the rule of the action that was refused (one rule per message). */
type ReferralActionKind = 'create' | 'save' | 'manage' | 'reassign' | 'link';
const NOT_AUTHORIZED: Record<ReferralActionKind, string> = {
  create: 'Only Sales and branch Managers of that branch can start a referral draft there. Nothing was made.',
  save: 'Only the people working on this draft can change it. Nothing was changed.',
  manage: 'Only the draft’s owner or the branch Manager can do this. Nothing was changed.',
  reassign: 'Only the branch Manager can change the owner. Nothing was changed.',
  link: 'You can link only leads and deals you can work on. Nothing was changed.',
};

/** Atlas hint keys → form field names (the same words in RFIELD). */
const HINT_FIELD: Record<string, string> = {
  customerName: RFIELD.customerName,
  mobile: RFIELD.mobile,
  email: RFIELD.email,
  companyName: RFIELD.companyName,
  sourceKind: RFIELD.sourceKind,
  sourceNote: RFIELD.sourceNote,
  title: RFIELD.title,
  branch: RFIELD.branchId,
  branchId: RFIELD.branchId,
  note: RFIELD.note,
  reason: RFIELD.reason,
  newOwner: RFIELD.newOwner,
  targetKind: RFIELD.targetKind,
  targetId: RFIELD.targetId,
  target: RFIELD.targetId,
};

function rfail(code: QuotationErrorCode | 'session', fields?: string[], action: ReferralActionKind = 'manage'): QuotationActionResult<never> {
  const message = code === 'not_authorized' ? NOT_AUTHORIZED[action] : (code !== 'session' && REFERRAL_TEXT[code as ReferralErrorCode]) || QUOTATION_ERROR_TEXT[code];
  return { ok: false, code, message, ...(fields && fields.length > 0 ? { fields: [...new Set(fields)] } : {}) };
}

/** A refusal the database explained; anything else may have run, so it is a retry message (never "nothing happened"). */
function rfailFrom(error: unknown, action: ReferralActionKind = 'manage'): QuotationActionResult<never> {
  if (error instanceof ReferralCommandError && error.code) {
    const fields = error.code === 'invalid_input' ? error.hintKeys.map((k) => HINT_FIELD[k.replace(/\..*$/, '')] ?? k) : undefined;
    return rfail(error.code, fields, action);
  }
  throw new Error(UNKNOWN_QUOTATION_OUTCOME);
}

function revalidateDraft(draftId: string, extra: string[] = []): void {
  revalidatePath('/app/quotations', 'layout');
  revalidatePath('/app/itineraries', 'layout');
  revalidatePath(referralDraftHref(draftId));
  revalidatePath('/app');
  for (const p of extra) revalidatePath(p);
}

function createdVM(input: { referralDraftId: string; referralReference: string; href: string; noun: 'quotation' | 'itinerary'; possibleDuplicates: Array<{ reference: string }> }): ReferralCreatedVM {
  return {
    referralDraftId: input.referralDraftId,
    referralReference: input.referralReference,
    href: input.href,
    // DA-56
    createdText: `Referral draft ${input.referralReference} created with its first ${input.noun}. Nothing is sent and nothing is in Bitrix.`,
    // DA-57: references the person can already open; each opens through the exact-reference lookup.
    possibleDuplicates: input.possibleDuplicates.map((d) => ({ reference: d.reference, href: workListHref('quotations', { reference: d.reference }) })),
  };
}

/** "Create referral quotation" (quotation_create_standalone; replay-safe by request id; refused while the switch is off). */
export async function createReferralQuotationAction(_prev: Prev<ReferralCreatedVM>, formData: FormData): Promise<QuotationActionResult<ReferralCreatedVM>> {
  const staff = await requireStaff();
  const parsed = parseReferralCreateForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const r = await quotationCreateStandalone(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(r.referralDraftId);
    const data = createdVM({ ...r, href: `/app/quotations/${r.versionId}`, noun: 'quotation' });
    return { ok: true, data, message: data.createdText };
  } catch (error) {
    return rfailFrom(error, 'create');
  }
}

/** "Create referral itinerary" (itinerary_create_standalone; no quotation is made). */
export async function createReferralItineraryAction(_prev: Prev<ReferralCreatedVM>, formData: FormData): Promise<QuotationActionResult<ReferralCreatedVM>> {
  const staff = await requireStaff();
  const parsed = parseReferralCreateForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const r = await itineraryCreateStandalone(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(r.referralDraftId);
    const data = createdVM({ ...r, href: `/app/itineraries/${r.documentId}`, noun: 'itinerary' });
    return { ok: true, data, message: data.createdText };
  } catch (error) {
    return rfailFrom(error, 'create');
  }
}

/** "Edit customer details" (referral_draft_save; the audit lists changed field names only). */
export async function saveReferralDraftAction(_prev: Prev<ReferralSaveResult>, formData: FormData): Promise<QuotationActionResult<ReferralSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralSaveForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const result = await referralDraftSave(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(parsed.value.draftId);
    return { ok: true, data: result, message: result.changedFields.length > 0 ? 'Customer details saved.' : 'Nothing changed.' };
  } catch (error) {
    return rfailFrom(error, 'save');
  }
}

/** "Close draft" (DA-72): reason required; never deletes. Due for automatic closing: that closure is kept (alreadyClosed). */
export async function closeReferralDraftAction(_prev: Prev<ReferralCloseResult>, formData: FormData): Promise<QuotationActionResult<ReferralCloseResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralCloseForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const result = await referralDraftClose(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(parsed.value.draftId);
    const message = result.alreadyClosed
      ? result.closedReason === 'no_activity'
        ? 'This draft had already closed after 90 days without activity. It stays readable and can be reopened.'
        : 'This draft was already closed. Nothing changed.'
      : 'Draft closed. Closed drafts stay readable and can be reopened.';
    return { ok: true, data: result, message };
  } catch (error) {
    return rfailFrom(error, 'manage');
  }
}

/** "Reopen draft" (DA-75): the 90 days start again. */
export async function reopenReferralDraftAction(_prev: Prev<ReferralReopenResult>, formData: FormData): Promise<QuotationActionResult<ReferralReopenResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralReopenForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const result = await referralDraftReopen(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(parsed.value.draftId);
    const due = result.autoClose.state === 'scheduled' ? workDateText(result.autoClose.dueOn) : null;
    return { ok: true, data: result, message: `Reopened. The 90 days start again.${due ? ` Closes on ${due} if nothing changes.` : ''}` };
  } catch (error) {
    return rfailFrom(error, 'manage');
  }
}

/** "Change owner" (DA-76): branch Manager only; reason 10-500; never to themselves. */
export async function reassignReferralDraftAction(_prev: Prev<ReferralReassignResult>, formData: FormData): Promise<QuotationActionResult<ReferralReassignResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralReassignForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  try {
    const result = await referralDraftReassign(asRpcClient(staff.supabase), parsed.value);
    revalidateDraft(parsed.value.draftId);
    return { ok: true, data: result, message: result.changed ? 'Owner changed. The reason is recorded with your name.' : 'That person is already the owner. Nothing changed.' };
  } catch (error) {
    return rfailFrom(error, 'reassign');
  }
}

/**
 * "Link" (DA-63/64): explicit pick + confirm; never converts or books; nothing changes in Bitrix.
 * Success returns to the Link tab with ?done=linked&link={id}; the page names the record (DA-64)
 * from the draft's own links, outside the form that the new link replaces (Echo M1).
 */
export async function linkReferralDraftAction(_prev: Prev<ReferralLinkResult>, formData: FormData): Promise<QuotationActionResult<ReferralLinkResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralLinkForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields, 'link');
  let result: ReferralLinkResult;
  try {
    result = await referralDraftLink(asRpcClient(staff.supabase), parsed.value);
  } catch (error) {
    return rfailFrom(error, 'link');
  }
  revalidateDraft(parsed.value.draftId, [parsed.value.targetKind === 'deal' ? `/app/deals/${parsed.value.targetId}` : `/app/leads/${parsed.value.targetId}`]);
  if (result.existing) return { ok: true, data: result, message: 'This draft was already linked to that record. Nothing changed.' };
  redirect(`${referralDraftHref(parsed.value.draftId)}?tab=link&done=linked&link=${encodeURIComponent(result.linkId)}`);
}

/**
 * "Remove link" (DA-67/68): owner or Manager, reason + note; refused link_locked once tied to a deal.
 * History keeps the link. With the draft id on the form, success returns to the Link tab with
 * ?done=unlinked&link={id} (DA-68 names the record there); without it, the message comes back here.
 */
export async function unlinkReferralDraftAction(_prev: Prev<ReferralUnlinkResult>, formData: FormData): Promise<QuotationActionResult<ReferralUnlinkResult>> {
  const staff = await requireStaff();
  const parsed = parseReferralUnlinkForm(formData);
  if (!parsed.ok) return rfail('invalid_input', parsed.fields);
  let result: ReferralUnlinkResult;
  try {
    result = await referralDraftUnlink(asRpcClient(staff.supabase), parsed.value);
  } catch (error) {
    return rfailFrom(error, 'manage');
  }
  revalidatePath('/app/quotations', 'layout');
  revalidatePath('/app/deals/[id]', 'page');
  revalidatePath('/app/leads/[id]', 'page');
  if (parsed.value.draftId) redirect(`${referralDraftHref(parsed.value.draftId)}?tab=link&done=unlinked&link=${encodeURIComponent(result.linkId)}`);
  return { ok: true, data: result, message: 'Link removed. You can link the right record now.' };
}
