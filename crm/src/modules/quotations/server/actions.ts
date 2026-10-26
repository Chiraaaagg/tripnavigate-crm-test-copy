'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { istToday } from '@/modules/finance/forms';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff } from '@/modules/identity/server/session';
import {
  quotationAccept,
  quotationContactsSave,
  quotationConvertToBooking,
  quotationCreate,
  quotationDecline,
  quotationDiscard,
  quotationEvidenceBegin,
  quotationEvidenceFinish,
  quotationEvidenceRemove,
  quotationGet,
  quotationItemAdd,
  quotationItemRemove,
  quotationItemSave,
  quotationLinkDeal,
  quotationMarkReady,
  quotationMarkSent,
  quotationNewVersion,
  quotationTiersSave,
  quotationVersionSave,
} from '../commands';
import {
  QUOTATION_EVIDENCE_BUCKET,
  QUOTATION_EVIDENCE_MAX_BYTES,
  QUOTATION_TEXT,
  type QuotationAcceptResult,
  type QuotationActionResult,
  type QuotationConversionResult,
  type QuotationCreateResult,
  type QuotationItemAddResult,
  type QuotationLinkDealResult,
  type QuotationMarkReadyResult,
  type QuotationMarkSentResult,
  type QuotationNewVersionResult,
  type QuotationSaveResult,
} from '../contracts';
import {
  parseAcceptForm,
  parseConvertForm,
  parseCreateQuotationForm,
  parseDeclineForm,
  parseEvidenceRemoveForm,
  parseEvidenceUploadForm,
  parseLinkDealForm,
  parseMarkSentForm,
  parseNewVersionForm,
  parseQuotationContactForm,
  parseQuotationContentForm,
  parseQuotationDetailsForm,
  parseQuotationItemForm,
  parseQuotationItemRemoveForm,
  parseQuotationTiersForm,
  parseVersionRowForm,
  QFIELD,
} from '../forms';
import { companyWordingFields, contentWordingFields, tiersWordingFields } from '../wording';
import { qfail, qfailFrom, UNKNOWN_QUOTATION_OUTCOME } from './results';

/**
 * Quotation server actions (Phase E). Every action: requireStaff() (aal2,
 * active staff); parse the form (frozen QFIELD names; never actor, entity,
 * branch or owner); run ONE database command under the staff member's own
 * session — the database authorizes (Lead/Deal Sales owner or assignee,
 * branch Manager; nobody else), validates, audits and decides. The
 * privileged client is used only for Storage, after quotation_evidence_begin
 * authorized the actor and generated the path. No action computes money,
 * converts a Lead or writes to Bitrix. Signatures fit useActionState.
 */

type Prev<T> = QuotationActionResult<T> | null;

/** Quotation screens live on the Lead page, the Deal page and the quotation editor (routes owned by the UI agent). */
function revalidateQuotations(): void {
  revalidatePath('/app/quotations', 'layout');
  revalidatePath('/app/leads/[id]', 'page');
  revalidatePath('/app/deals/[id]', 'page');
}

const DETAILS_HINTS = {
  destination: QFIELD.destination,
  scope: QFIELD.tripScope,
  start: QFIELD.tripStart,
  end: QFIELD.tripEnd,
  adults: QFIELD.adults,
  childrenWithBed: QFIELD.childrenWithBed,
  childrenNoBed: QFIELD.childrenNoBed,
  infants: QFIELD.infants,
  paxRemarks: QFIELD.paxRemarks,
  requirementsNote: QFIELD.requirementsNote,
  validUntil: QFIELD.validUntil,
};
const CONTENT_HINTS = { content: QFIELD.dayTitle, days: QFIELD.dayTitle, includes: QFIELD.include, excludes: QFIELD.exclude, terms: QFIELD.term, notes: QFIELD.notes };
const CONTACT_HINTS = { contactName: QFIELD.contactName, mobile: QFIELD.mobile, email: QFIELD.email, companyName: QFIELD.companyName, bookingFor: QFIELD.bookingFor };
const TIER_HINTS = { tiers: QFIELD.quotedTierLabel };

/** "Create quotation" on a Lead or Deal (quotation_create; replay-safe by request id). */
export async function createQuotationAction(_prev: Prev<QuotationCreateResult>, formData: FormData): Promise<QuotationActionResult<QuotationCreateResult>> {
  const staff = await requireStaff();
  const parsed = parseCreateQuotationForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationCreate(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.created };
  } catch (error) {
    return qfailFrom(error, { subjectKind: QFIELD.subjectKind, title: QFIELD.title, requestId: QFIELD.requestId });
  }
}

/** Trip, travellers (counts only), requirements and validity (quotation_version_save; every key of this form sent). */
export async function saveQuotationDetailsAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationDetailsForm(formData, istToday());
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await quotationVersionSave(asRpcClient(staff.supabase), { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: v.fields });
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, DETAILS_HINTS);
  }
}

/** Day-by-day, includes, excludes, terms and notes (quotation_version_save with `content` only). */
export async function saveQuotationContentAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationContentForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const v = parsed.value;
  const wording = contentWordingFields(v.content);
  if (wording.length > 0) return qfail('internal_wording', wording);
  try {
    const result = await quotationVersionSave(asRpcClient(staff.supabase), { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: { content: v.content } });
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, CONTENT_HINTS);
  }
}

/** Customer contact printed on the quotation (quotation_contacts_save). */
export async function saveQuotationContactAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationContactForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const wording = companyWordingFields(parsed.value.fields.companyName);
  if (wording.length > 0) return qfail('internal_wording', wording);
  try {
    const result = await quotationContactsSave(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, CONTACT_HINTS);
  }
}

/** Option names: quoted always, upgrade when offered (quotation_tiers_save replaces the set). */
export async function saveQuotationTiersAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationTiersForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const wording = tiersWordingFields(parsed.value.tiers);
  if (wording.length > 0) return qfail('internal_wording', wording);
  try {
    const result = await quotationTiersSave(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.saved };
  } catch (error) {
    return qfailFrom(error, TIER_HINTS);
  }
}

/** Add (no itemId) or save one service with the booking fact keys (quotation_item_add / quotation_item_save). */
export async function saveQuotationItemAction(
  _prev: Prev<QuotationSaveResult | QuotationItemAddResult>,
  formData: FormData,
): Promise<QuotationActionResult<QuotationSaveResult | QuotationItemAddResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationItemForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = v.itemId
      ? await quotationItemSave(rpc, { itemId: v.itemId, versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, tierKey: v.tierKey, facts: v.service.facts })
      : await quotationItemAdd(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, serviceType: v.service.type, tierKey: v.tierKey, facts: v.service.facts });
    revalidateQuotations();
    return { ok: true, data: result, message: v.itemId ? QUOTATION_TEXT.saved : QUOTATION_TEXT.itemAdded };
  } catch (error) {
    // Fact keys in the hint are the booking input names (hotelName, checkIn, …) except the hotel extras, which match QFIELD.
    return qfailFrom(error, { tierKey: QFIELD.itemTierKey, serviceType: QFIELD.serviceType });
  }
}

export async function removeQuotationItemAction(_prev: Prev<QuotationSaveResult>, formData: FormData): Promise<QuotationActionResult<QuotationSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseQuotationItemRemoveForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationItemRemove(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.itemRemoved };
  } catch (error) {
    return qfailFrom(error);
  }
}

/** "Mark ready" (quotation_mark_ready): freezes the content hash; not_ready lists the blocking issues. */
export async function markQuotationReadyAction(_prev: Prev<QuotationMarkReadyResult>, formData: FormData): Promise<QuotationActionResult<QuotationMarkReadyResult>> {
  const staff = await requireStaff();
  const parsed = parseVersionRowForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationMarkReady(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.markedReady };
  } catch (error) {
    revalidateQuotations();
    return qfailFrom(error);
  }
}

/** "Mark as sent" after Sales sent the previewed document (quotation_mark_sent; bound to the ready hash). */
export async function markQuotationSentAction(_prev: Prev<QuotationMarkSentResult>, formData: FormData): Promise<QuotationActionResult<QuotationMarkSentResult>> {
  const staff = await requireStaff();
  const parsed = parseMarkSentForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationMarkSent(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.markedSent };
  } catch (error) {
    revalidateQuotations();
    return qfailFrom(error, { channel: QFIELD.channel });
  }
}

/** Upload the customer's written acceptance (or another file) on a sent version. */
export async function uploadQuotationEvidenceAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<QuotationActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const parsed = parseEvidenceUploadForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const file = formData.get(QFIELD.file);
  if (!(file instanceof Blob) || file.size === 0 || file.size > QUOTATION_EVIDENCE_MAX_BYTES) return qfail('evidence_rejected', [QFIELD.file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return qfail('evidence_rejected', [QFIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await quotationEvidenceBegin(rpc, { versionId: parsed.value.versionId, kind: parsed.value.kind, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 });
  } catch (error) {
    const refusal = qfailFrom(error);
    return !refusal.ok && refusal.code === 'evidence_rejected' ? { ...refusal, fields: [QFIELD.file] } : refusal;
  }

  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient().storage.from(QUOTATION_EVIDENCE_BUCKET).upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  let status: string | null;
  try {
    status = (await quotationEvidenceFinish(rpc, begun.evidenceId, stored)).status;
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    status = null;
  }
  revalidateQuotations();
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: QUOTATION_TEXT.evidenceUploaded };
  if (status === 'failed') return qfail('upload_failed');
  return qfail('upload_failed', undefined, UNKNOWN_QUOTATION_OUTCOME);
}

/** Remove a file while the version is still sent (soft; the database refuses after acceptance). */
export async function removeQuotationEvidenceAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<QuotationActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const parsed = parseEvidenceRemoveForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationEvidenceRemove(asRpcClient(staff.supabase), parsed.value.evidenceId);
    revalidateQuotations();
    return { ok: true, data: { evidenceId: result.evidenceId }, message: QUOTATION_TEXT.evidenceRemoved };
  } catch (error) {
    return qfailFrom(error);
  }
}

/** "Mark accepted" with the stored written acceptance of THIS version and the chosen option (DEC-35). */
export async function acceptQuotationAction(_prev: Prev<QuotationAcceptResult>, formData: FormData): Promise<QuotationActionResult<QuotationAcceptResult>> {
  const staff = await requireStaff();
  const parsed = parseAcceptForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationAccept(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: QUOTATION_TEXT.accepted };
  } catch (error) {
    revalidateQuotations();
    return qfailFrom(error, { tierKey: QFIELD.acceptedTierKey, evidenceId: QFIELD.evidenceId });
  }
}

export async function declineQuotationAction(_prev: Prev<Record<string, never>>, formData: FormData): Promise<QuotationActionResult<Record<string, never>>> {
  const staff = await requireStaff();
  const parsed = parseDeclineForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    await quotationDecline(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: {}, message: QUOTATION_TEXT.declined };
  } catch (error) {
    return qfailFrom(error, { reason: QFIELD.declineReason });
  }
}

/** "Make a new version" (copy, incl. money lines); an open working version is returned instead. */
export async function newQuotationVersionAction(_prev: Prev<QuotationNewVersionResult>, formData: FormData): Promise<QuotationActionResult<QuotationNewVersionResult>> {
  const staff = await requireStaff();
  const parsed = parseNewVersionForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationNewVersion(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: result, message: result.created ? QUOTATION_TEXT.newVersion : QUOTATION_TEXT.existingVersion };
  } catch (error) {
    return qfailFrom(error, { baseVersionId: QFIELD.baseVersionId });
  }
}

export async function discardQuotationVersionAction(_prev: Prev<Record<string, never>>, formData: FormData): Promise<QuotationActionResult<Record<string, never>>> {
  const staff = await requireStaff();
  const parsed = parseVersionRowForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    await quotationDiscard(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    return { ok: true, data: {}, message: QUOTATION_TEXT.discarded };
  } catch (error) {
    return qfailFrom(error);
  }
}

/** Link a Lead quotation's accepted version to the Deal Sales converted in Bitrix (stored Lead id must match). */
export async function linkQuotationDealAction(_prev: Prev<QuotationLinkDealResult>, formData: FormData): Promise<QuotationActionResult<QuotationLinkDealResult>> {
  const staff = await requireStaff();
  const parsed = parseLinkDealForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  try {
    const result = await quotationLinkDeal(asRpcClient(staff.supabase), parsed.value);
    revalidateQuotations();
    revalidatePath(`/app/deals/${result.linkedDealId}`);
    return { ok: true, data: result, message: QUOTATION_TEXT.linked };
  } catch (error) {
    return qfailFrom(error, { quotation: QFIELD.quotationId, dealId: QFIELD.dealId });
  }
}

/**
 * "Start booking from this quotation": ONE database command in one
 * transaction (quotation_convert_to_booking), idempotent per accepted
 * version and bound to its content hash. A repeat answers `existing` with
 * the same booking draft. Lead quotations wait for the linked Deal.
 *
 * Batch 3 referral quotations (lead ruling 21 Oct, atlas-batch3-shapes §3.11):
 * the booking goes only into the Deal the referral draft is linked to. The
 * action reads the quotation under the caller's own session (never the form)
 * and, when it is not bound yet, binds it to the draft's ACTIVE Deal link
 * first (quotation_link_deal, immutable; the database checks the link again,
 * deal_not_linked_to_draft), then converts. Two transactions: when the
 * conversion is refused after the bind, the answer says both honestly
 * ("Linked to the deal. Booking not started: …"). Linking a draft never
 * converts on its own.
 */
export async function convertQuotationAction(_prev: Prev<QuotationConversionResult>, formData: FormData): Promise<QuotationActionResult<QuotationConversionResult>> {
  const staff = await requireStaff();
  const parsed = parseConvertForm(formData);
  if (!parsed.ok) return qfail('invalid_input', parsed.fields);
  const client = asRpcClient(staff.supabase);
  let bound = false;
  // The read only decides whether a referral quotation needs binding; when it fails, the
  // conversion itself still runs and the database refuses an unbound quotation in words.
  const record = await quotationGet(client, parsed.value.versionId).catch(() => null);
  if (record && record.subject.kind === 'referral' && !record.subject.linkedDealId && record.conversion === null && record.referral?.activeDealId) {
    try {
      await quotationLinkDeal(client, { quotationId: record.quotationId, dealId: record.referral.activeDealId, expectedRowVersion: record.rowVersion });
      bound = true;
      revalidatePath(`/app/deals/${record.referral.activeDealId}`);
    } catch (error) {
      // Nothing was bound: the plain refusal (deal_not_linked_to_draft, draft_closed, deal_already_linked, …).
      revalidateQuotations();
      return qfailFrom(error);
    }
  }
  try {
    const result = await quotationConvertToBooking(client, parsed.value);
    revalidateQuotations();
    revalidatePath(`/app/deals/${result.dealId}`);
    revalidatePath(`/app/deals/${result.dealId}/book`);
    revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
    return { ok: true, data: result, message: result.outcome === 'existing' ? QUOTATION_TEXT.convertedExisting : QUOTATION_TEXT.converted };
  } catch (error) {
    revalidateQuotations();
    const refused = qfailFrom(error);
    // Step 1 (bind) is committed; say so instead of a bare refusal.
    if (bound && !refused.ok) return { ...refused, message: QUOTATION_TEXT.boundNotBooked.replace('{reason}', refused.message) };
    return refused;
  }
}
