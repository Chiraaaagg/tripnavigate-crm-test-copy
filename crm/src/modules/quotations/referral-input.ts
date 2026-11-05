import { CONTACT_LIMITS } from '@/modules/fulfilment/contracts';
import { formReaders, type ParsedForm, readUuid } from '@/modules/fulfilment/forms';
import { REFERRAL_CLOSE_REASONS, REFERRAL_SOURCE_KINDS, REFERRAL_UNLINK_REASONS, type ReferralCloseReason, type ReferralCustomerInput, type ReferralUnlinkReason } from './referral';
import { RFIELD, REFERRAL_TEXT_LIMITS } from './work-contract';

/*
 * Batch 3 referral draft form parsers (Terra, T-3). Pure; no I/O. Field names
 * are the frozen RFIELD names (work-contract.ts). Never read actor, owner,
 * entity or branch identity from the form except the branch the person picks
 * on create (the database checks they hold Sales or Manager there). Refusals
 * name RFIELD inputs so the screen marks them and keeps what was typed.
 */

const { text } = formReaders;

function value(formData: FormData, name: string): string {
  return (text(formData, name) ?? '').trim();
}
function singleLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
function done<T>(fields: string[], build: () => T): ParsedForm<T> {
  return fields.length > 0 ? { ok: false, fields: [...new Set(fields)] } : { ok: true, value: build() };
}
function rowVersionOf(formData: FormData, fields: string[]): number | null {
  const raw = value(formData, RFIELD.rowVersion);
  if (/^[1-9]\d{0,8}$/.test(raw)) return Number(raw);
  fields.push(RFIELD.rowVersion);
  return null;
}
function uuidOf(formData: FormData, name: string, fields: string[]): string | null {
  const id = readUuid(formData, name);
  if (!id) fields.push(name);
  return id;
}

/** Indian mobile: spaces and dashes removed, an optional +91 / 91 / 0 prefix dropped. '' → null; invalid → undefined. */
export function referralMobileOf(raw: string): string | null | undefined {
  const digits = raw.replace(/[\s-]/g, '');
  if (digits === '') return null;
  const local = digits.replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  return CONTACT_LIMITS.mobilePattern.test(local) ? local : undefined;
}

/** Optional single-line text up to `max`: '' → null; too long → undefined. */
function optionalLine(formData: FormData, name: string, max: number): string | null | undefined {
  const v = singleLine(value(formData, name));
  if (v === '') return null;
  return v.length <= max ? v : undefined;
}

/** The customer fields shared by create and save (atlas-batch3-shapes §2 Customer). */
function customerOf(formData: FormData, fields: string[]): ReferralCustomerInput | null {
  const customerName = singleLine(value(formData, RFIELD.customerName));
  if (customerName.length < 1 || customerName.length > REFERRAL_TEXT_LIMITS.customerName) fields.push(RFIELD.customerName);
  const mobile = referralMobileOf(value(formData, RFIELD.mobile));
  if (mobile === undefined) fields.push(RFIELD.mobile);
  const emailRaw = value(formData, RFIELD.email).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= REFERRAL_TEXT_LIMITS.email && CONTACT_LIMITS.emailPattern.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) fields.push(RFIELD.email);
  const companyName = optionalLine(formData, RFIELD.companyName, REFERRAL_TEXT_LIMITS.companyName);
  if (companyName === undefined) fields.push(RFIELD.companyName);
  const sourceRaw = value(formData, RFIELD.sourceKind);
  const sourceKind = sourceRaw === '' ? null : (REFERRAL_SOURCE_KINDS as readonly string[]).includes(sourceRaw) ? (sourceRaw as ReferralCustomerInput['sourceKind']) : undefined;
  if (sourceKind === undefined) fields.push(RFIELD.sourceKind);
  const sourceNote = optionalLine(formData, RFIELD.sourceNote, REFERRAL_TEXT_LIMITS.sourceNote);
  if (sourceNote === undefined) fields.push(RFIELD.sourceNote);
  if (fields.length > 0) return null;
  return { customerName, mobile: mobile ?? null, email: email ?? null, companyName: companyName ?? null, sourceKind: sourceKind ?? null, sourceNote: sourceNote ?? null };
}

const TITLE_MAX = 200;

export interface ReferralCreateForm {
  branchId: string;
  customer: ReferralCustomerInput;
  title: string;
  requestId: string;
}

/**
 * Create a referral quotation or itinerary. The title is optional on the form
 * (DA-54); when empty, "Trip for {customer name}" is used (shown at the top of
 * the document; it cannot be changed later; Mercury to confirm).
 */
export function parseReferralCreateForm(formData: FormData): ParsedForm<ReferralCreateForm> {
  const fields: string[] = [];
  const requestId = uuidOf(formData, RFIELD.requestId, fields);
  const branchId = uuidOf(formData, RFIELD.branchId, fields);
  const customer = customerOf(formData, fields);
  const typed = singleLine(value(formData, RFIELD.title));
  if (typed.length > TITLE_MAX) fields.push(RFIELD.title);
  return done(fields, () => ({
    branchId: branchId!,
    customer: customer!,
    title: typed !== '' ? typed : `Trip for ${customer!.customerName}`.slice(0, TITLE_MAX),
    requestId: requestId!,
  }));
}

export interface ReferralSaveForm {
  draftId: string;
  rowVersion: number;
  fields: ReferralCustomerInput;
}

/** "Edit customer details": every customer key is sent (the database records the changed field names). */
export function parseReferralSaveForm(formData: FormData): ParsedForm<ReferralSaveForm> {
  const fields: string[] = [];
  const draftId = uuidOf(formData, RFIELD.draftId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const customer = customerOf(formData, fields);
  return done(fields, () => ({ draftId: draftId!, rowVersion: rowVersion!, fields: customer! }));
}

export interface ReferralCloseForm {
  draftId: string;
  rowVersion: number;
  reason: ReferralCloseReason;
  note: string | null;
}

export function parseReferralCloseForm(formData: FormData): ParsedForm<ReferralCloseForm> {
  const fields: string[] = [];
  const draftId = uuidOf(formData, RFIELD.draftId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const reasonRaw = value(formData, RFIELD.reason);
  const reason = (REFERRAL_CLOSE_REASONS as readonly string[]).includes(reasonRaw) ? (reasonRaw as ReferralCloseReason) : null;
  if (!reason) fields.push(RFIELD.reason);
  const note = value(formData, RFIELD.note);
  if (note.length > REFERRAL_TEXT_LIMITS.closeNoteMax) fields.push(RFIELD.note);
  return done(fields, () => ({ draftId: draftId!, rowVersion: rowVersion!, reason: reason!, note: note === '' ? null : note }));
}

export interface ReferralReopenForm {
  draftId: string;
  rowVersion: number;
  note: string | null;
}

/** The note is optional here; the database requires it when the draft was closed as a duplicate (invalid_input, note). */
export function parseReferralReopenForm(formData: FormData): ParsedForm<ReferralReopenForm> {
  const fields: string[] = [];
  const draftId = uuidOf(formData, RFIELD.draftId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const note = value(formData, RFIELD.note);
  if (note.length > REFERRAL_TEXT_LIMITS.reasonMax) fields.push(RFIELD.note);
  return done(fields, () => ({ draftId: draftId!, rowVersion: rowVersion!, note: note === '' ? null : note }));
}

export interface ReferralReassignForm {
  draftId: string;
  rowVersion: number;
  newOwner: string;
  reason: string;
}

export function parseReferralReassignForm(formData: FormData): ParsedForm<ReferralReassignForm> {
  const fields: string[] = [];
  const draftId = uuidOf(formData, RFIELD.draftId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const newOwner = uuidOf(formData, RFIELD.newOwner, fields);
  const reason = value(formData, RFIELD.reason);
  if (reason.length < REFERRAL_TEXT_LIMITS.reasonMin || reason.length > REFERRAL_TEXT_LIMITS.reasonMax) fields.push(RFIELD.reason);
  return done(fields, () => ({ draftId: draftId!, rowVersion: rowVersion!, newOwner: newOwner!, reason }));
}

export interface ReferralLinkForm {
  draftId: string;
  rowVersion: number;
  targetKind: 'lead' | 'deal';
  targetId: string;
  note: string | null;
}

export function parseReferralLinkForm(formData: FormData): ParsedForm<ReferralLinkForm> {
  const fields: string[] = [];
  const draftId = uuidOf(formData, RFIELD.draftId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const kindRaw = value(formData, RFIELD.targetKind);
  const targetKind = kindRaw === 'lead' || kindRaw === 'deal' ? kindRaw : null;
  if (!targetKind) fields.push(RFIELD.targetKind);
  const targetId = uuidOf(formData, RFIELD.targetId, fields);
  const note = value(formData, RFIELD.note);
  if (note.length > REFERRAL_TEXT_LIMITS.reasonMax) fields.push(RFIELD.note);
  return done(fields, () => ({ draftId: draftId!, rowVersion: rowVersion!, targetKind: targetKind!, targetId: targetId!, note: note === '' ? null : note }));
}

export interface ReferralUnlinkForm {
  /** Optional: lets the action return to the draft's Link tab with the result (Echo M1). */
  draftId: string | null;
  linkId: string;
  rowVersion: number;
  reason: ReferralUnlinkReason;
  note: string;
}

export function parseReferralUnlinkForm(formData: FormData): ParsedForm<ReferralUnlinkForm> {
  const fields: string[] = [];
  const linkId = uuidOf(formData, RFIELD.linkId, fields);
  const rowVersion = rowVersionOf(formData, fields);
  const reasonRaw = value(formData, RFIELD.reason);
  const reason = (REFERRAL_UNLINK_REASONS as readonly string[]).includes(reasonRaw) ? (reasonRaw as ReferralUnlinkReason) : null;
  if (!reason) fields.push(RFIELD.reason);
  const note = value(formData, RFIELD.note);
  if (note.length < REFERRAL_TEXT_LIMITS.reasonMin || note.length > REFERRAL_TEXT_LIMITS.reasonMax) fields.push(RFIELD.note);
  const draftId = readUuid(formData, RFIELD.draftId);
  return done(fields, () => ({ draftId, linkId: linkId!, rowVersion: rowVersion!, reason: reason!, note }));
}
