'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Accounts
 * phase 2 supplier states (acc2-supplier-*), so a press shows the real
 * success or refusal path without a database. They read nothing, write
 * nothing and return fixed synthetic answers; the gallery is a 404 outside
 * the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };
type Hotels = { ok: true; items: Array<{ hotelId: string; name: string; city: string; area: string | null; category: string | null }>; more: boolean };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function acc2SupSaveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved. The details are marked “Not verified”.', data: { supplierId: 'a2000102-0000-4000-8000-000000000102', rowVersion: 3, warnings: [] } });
}
export async function acc2SupSaveWarnings(): Promise<Result> {
  return settle({
    ok: true,
    message: 'Synthetic preview: supplier added. Its details are marked “Not verified”.',
    data: { supplierId: 'a2000107-0000-4000-8000-000000000107', rowVersion: 1, warnings: [{ supplierId: 'a2000101-0000-4000-8000-000000000101', name: 'Sample Lake Hotels Pvt Ltd', reasons: ['same_gstin'] }] },
  });
}
export async function acc2SupSaveExists(): Promise<Result> {
  return settle({ ok: false, code: 'supplier_exists', message: 'A supplier with exactly this name already exists in this company. Open it instead, or use a different name.', field: 'name' });
}
export async function acc2SupSaveGstin(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'gstin' });
}
export async function acc2SupContactOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: contact saved.' });
}
export async function acc2SupContactRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Give a phone number or an e-mail address.', field: 'phone' });
}
export async function acc2SupRemoveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: contact removed.' });
}
export async function acc2SupLinkOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: hotel linked.' });
}
export async function acc2SupLinkRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Choose the hotel from the list.', field: 'hotelId' });
}
export async function acc2SupUnlinkOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: link removed.' });
}
export async function acc2SupRateOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: rate added.' });
}
export async function acc2SupSearchHotels(query: string): Promise<Hotels> {
  const all = [
    { hotelId: 'a2000501-0000-4000-8000-000000000501', name: 'Sample Dune Camp Resort', city: 'Jaisalmer', area: 'Sam', category: '4 star' },
    { hotelId: 'a2000502-0000-4000-8000-000000000502', name: 'Sample Golden Fort Haveli', city: 'Jaisalmer', area: 'Fort', category: '3 star' },
    { hotelId: 'a2000503-0000-4000-8000-000000000503', name: 'Sample Lakeside Palace', city: 'Udaipur', area: null, category: '5 star' },
  ];
  const q = query.trim().toLowerCase();
  return settle({ ok: true, items: all.filter((h) => h.name.toLowerCase().includes(q)), more: false });
}
export async function acc2SupImportValidate(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Synthetic preview: the gallery does not read files.', field: 'file' });
}
export async function acc2SupImportApplyOk(): Promise<Result> {
  return settle({ ok: true, message: 'Applied.', data: { applied: { creates: 2, updates: 1 } } });
}
export async function acc2SupImportApplyChanged(): Promise<Result> {
  return settle({ ok: false, code: 'import_not_validated', message: 'Something changed since this check. Check the file again, then apply.' });
}
export async function acc2SupImportApplyOtherFile(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Choose the same file you checked (with the same column choices) and press Import again: bank account numbers are not kept between the check and the import. Nothing was imported.', fields: ['file'] } as Result);
}
