'use server';

import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { isUiPreviewEnabled } from '@/lib/config';
import { QUOTATION_ERROR_TEXT, type QuotationActionResult } from '@/modules/quotations/contracts';
import { referralDraftHref } from '@/modules/quotations/subject-links';
import type { ReferralCreatedVM } from '@/modules/quotations/work-contract';
import { PREVIEW_AFTER_COOKIE } from './batch3-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in referral actions: they write
 * nothing and answer from the posted form alone, so the preview shows the
 * real form paths (typed values kept on a refusal, fields named, the
 * never-blocking duplicate hint, link and removal answers). The gallery is a
 * 404 outside local preview mode.
 */

type Result = QuotationActionResult<unknown>;


/**
 * Revalidate-like stand-in (lead fix round): remembers, for five minutes, that the action on the
 * calling preview state succeeded, so the refresh (or redirect) that follows renders the after
 * state, as the real page does after the server revalidates. Preview only; nothing is stored.
 */
async function markDone(): Promise<string> {
  // Echo N4: preview actions ship in every build; outside local preview mode they do nothing.
  if (!isUiPreviewEnabled(process.env)) notFound();
  const referer = (await headers()).get('referer') ?? '';
  const path = new URL(referer || 'http://local.invalid/preview/', 'http://local.invalid').pathname;
  const state = path.startsWith('/preview/') ? path.slice('/preview/'.length) : '';
  (await cookies()).set(PREVIEW_AFTER_COOKIE, state, { path: '/preview', maxAge: 300, sameSite: 'lax', httpOnly: true });
  return `/preview/${state}`;
}

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

const text = (fd: FormData, name: string) => String(fd.get(name) ?? '').trim();

/** Create: refuses an empty customer name (field named); otherwise "created" with one possible duplicate (DA-56, DA-57). */
export async function previewReferralCreateAction(_prev: unknown, fd: FormData): Promise<Result> {
  // Only the customer name is required (DA-53); an empty title prints "Trip for {customer name}" (DA-213).
  const missing = ['customerName'].filter((f) => text(fd, f) === '');
  if (missing.length > 0) return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: missing });
  const data: ReferralCreatedVM = {
    referralDraftId: 'rd000000-0000-4000-8000-000000000302',
    referralReference: 'TD-302',
    href: '/preview/b3-draft-overview',
    createdText: 'Referral draft TD-302 created with its first quotation. Nothing is sent and nothing is in Bitrix.',
    possibleDuplicates: [{ reference: 'TD-301', href: referralDraftHref('rd000000-0000-4000-8000-000000000301') }],
  };
  return settle({ ok: true, data, message: data.createdText });
}

/** Create while the switch was turned off between page load and submit: the refusal keeps every typed value. */
export async function previewReferralCreateOffAction(): Promise<Result> {
  return settle({ ok: false, code: 'referral_drafts_disabled', message: QUOTATION_ERROR_TEXT.referral_drafts_disabled });
}

export async function previewReferralLinkAction(_prev: unknown, fd: FormData): Promise<Result> {
  if (text(fd, 'targetId') === '') return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['targetId'] });
  // As the real action: redirect back to the Link tab, which then shows the result notice (DA-64).
  await settle(null);
  redirect(await markDone());
}

/** Link refused (DA-65 words) so the preview shows the choice kept with the reason. */
export async function previewReferralLinkRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'deal_already_linked', message: 'That deal already has an accepted quotation.' });
}

/** Remove link: reason and a 10–500 character note, else the named fields. */
export async function previewReferralUnlinkAction(_prev: unknown, fd: FormData): Promise<Result> {
  const fields: string[] = [];
  if (text(fd, 'reason') === '') fields.push('reason');
  const note = text(fd, 'note');
  if (note.length < 10 || note.length > 500) fields.push('note');
  if (fields.length > 0) return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields });
  await settle(null);
  redirect(await markDone());
}

export async function previewReferralCloseAction(_prev: unknown, fd: FormData): Promise<Result> {
  if (text(fd, 'reason') === '') return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['reason'] });
  await markDone();
  return settle({ ok: true, data: { rowVersion: 5 }, message: 'Draft closed. Closed drafts stay readable and can be reopened.' });
}

/** Reopen: a draft closed as a duplicate needs a note. */
export async function previewReferralReopenAction(_prev: unknown, fd: FormData): Promise<Result> {
  if (text(fd, 'note') === '') return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['note'] });
  await markDone();
  return settle({ ok: true, data: { rowVersion: 5 }, message: 'Reopened. The 90 days start again. Closes on 19 Jan 2027 if nothing changes.' });
}

export async function previewReferralReopenAnyAction(): Promise<Result> {
  await markDone();
  return settle({ ok: true, data: { rowVersion: 5 }, message: 'Reopened. The 90 days start again. Closes on 19 Jan 2027 if nothing changes.' });
}

export async function previewReferralReassignAction(_prev: unknown, fd: FormData): Promise<Result> {
  const fields: string[] = [];
  if (text(fd, 'newOwner') === '') fields.push('newOwner');
  const reason = text(fd, 'reason');
  if (reason.length < 10 || reason.length > 500) fields.push('reason');
  if (fields.length > 0) return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields });
  await markDone();
  return settle({ ok: true, data: { rowVersion: 5 }, message: 'Owner changed. The reason is recorded with your name.' });
}

/** Any write on a closed draft (DA-75). */
export async function previewReferralDraftClosedAction(): Promise<Result> {
  return settle({ ok: false, code: 'draft_closed', message: QUOTATION_ERROR_TEXT.draft_closed });
}

export async function previewReferralSavedAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 5, changedFields: ['email'] }, message: 'Customer details saved.' });
}
