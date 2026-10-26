'use server';

import { ERROR_TEXT, type BookingActionResult } from '@/modules/fulfilment/contracts';
import type { HotelOption, PartyOption, SearchResult } from '@/views/booking-form/vn-types';
import { PREVIEW_HOTELS as HOTELS, PREVIEW_IMPORT_SUMMARY, PREVIEW_PARTIES } from './vn-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY (voice-note batch). Stand-in server
 * actions: they read nothing, write nothing and answer from fixed synthetic
 * lists, so the gallery shows type-ahead search, "Add customer", the import
 * check and the Accounts customer check through the real screens. The
 * gallery page is a 404 outside local preview mode.
 */

type Result = BookingActionResult<unknown>;

async function settle<T>(value: T, ms = 80): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

export async function previewSearchHotelsAction(query: string, scope?: { city?: string }): Promise<SearchResult<HotelOption>> {
  const q = query.trim().toLowerCase();
  const city = scope?.city?.trim().toLowerCase() ?? '';
  const items = HOTELS.filter((h) => h.name.toLowerCase().includes(q) && (!city || h.city.toLowerCase() === city || q.length > 3));
  return settle({ ok: true, items, more: false });
}

export async function previewSearchPartiesAction(query: string): Promise<SearchResult<PartyOption>> {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const items = PREVIEW_PARTIES.filter((p) => p.name.toLowerCase().includes(q) || (digits.length >= 4 && (p.phone ?? '').includes(digits)) || (p.gstin ?? '').toLowerCase().startsWith(q));
  return settle({ ok: true, items, more: false });
}

export async function previewCreatePartyAction(_prev: never, fd: FormData): Promise<Result> {
  const type = fd.get('partyType') === 'business' ? 'business' : 'personal';
  const s = (k: string) => String(fd.get(k) ?? '').trim();
  const party: PartyOption = {
    partyId: 'p0000000-0000-4000-8000-000000000099',
    type,
    name: s('name'),
    contactPerson: s('contactPerson') || null,
    phone: s('phone') || null,
    email: s('email') || null,
    addressLine1: s('addressLine1'),
    addressLine2: s('addressLine2') || null,
    city: s('city'),
    stateCode: s('stateCode'),
    postalCode: s('postalCode'),
    gstStatus: type === 'business' ? ((s('gstStatus') || null) as PartyOption['gstStatus']) : null,
    gstin: s('gstin') || null,
    gstReason: s('gstReason') || null,
    checkStatus: 'not_checked',
    sourceLabel: 'Added on DL-1042',
  };
  return settle({ ok: true, data: { party }, message: 'Customer added.' });
}

export async function previewRefuseCreatePartyAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: ERROR_TEXT.invalid_input, fields: ['gstin'] });
}

export async function previewOkAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 5 }, message: 'Saved.' });
}

export async function previewRefuseReasonAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: ERROR_TEXT.invalid_input, fields: ['reason'] });
}

export async function previewValidateImportAction(_prev: never, fd: FormData): Promise<Result> {
  const kind = fd.get('kind') === 'customer' ? 'customer' : 'hotel';
  const file = fd.get('file');
  const fileName = file && typeof file === 'object' && 'name' in file ? String((file as File).name) : 'sample.csv';
  const branchName = kind === 'customer' ? (fd.get('branchScope') === 'company' ? null : 'Jodhpur') : undefined;
  return settle({ ok: true, data: { summary: { ...PREVIEW_IMPORT_SUMMARY, kind, fileName, branchName } }, message: 'File checked. Nothing was saved.' }, 200);
}

export async function previewApplyImportAction(): Promise<Result> {
  return settle({ ok: true, data: { applied: { creates: 98, updates: 12 } }, message: 'Import applied.' }, 200);
}

/** Bitrix trip details switch: always saved (turned on). */
export async function previewTripDetailsSavedAction(): Promise<{ ok: true; enabled: boolean; changed: boolean; message: string }> {
  return settle({ ok: true, enabled: true, changed: true, message: 'Bitrix trip details are on. Bookings take them from the Deal after the next Bitrix update. The reason is recorded in the audit log.' });
}

/** Full details of one stored customer (the search hit carries only the name and place). */
export async function previewPickPartyAction(partyId: string): Promise<{ ok: true; party: PartyOption } | { ok: false; message: string }> {
  const party = PREVIEW_PARTIES.find((p) => p.partyId === partyId);
  return settle(party ? { ok: true, party } : { ok: false, message: 'This customer could not be found.' });
}

/** Reading the customer fails (shows the refusal; the typed Bill To stays). */
export async function previewPickPartyFailAction(): Promise<{ ok: false; message: string }> {
  return settle({ ok: false, message: 'This customer is not available to you.' });
}

/** Echo-B M2: the customer search fails (network or server); the list must say so. */
export async function previewSearchPartiesThrowsAction(): Promise<SearchResult<PartyOption>> {
  await settle(null);
  throw new Error('Design preview: simulated search failure.');
}
