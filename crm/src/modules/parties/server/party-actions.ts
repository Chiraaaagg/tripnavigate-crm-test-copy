'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import type { PartyOption, SearchResult } from '@/views/booking-form/vn-types';
import { PARTY_FIELD, parsePartyFields, readUuidField, searchQuery, toPartyOption } from '../party-forms';
import { createParty, getParty, partyDocumentBegin, partyDocumentFinish, searchParties } from './parties-db';
import { derivedRequestId, vnFail, vnFailFrom, type VnResult } from './party-results';

/**
 * Stored customers in Bill To (voice-note batch, owner item 9). Every action:
 * requireStaff() first; the database command runs under the staff member's
 * own session and decides access (booking editor of the Deal; never
 * Purchase). The privileged client only stores a document after the
 * database authorized it and chose the object path. Search words travel in
 * the action body only (never a URL, never logged); at most 20 results.
 * Search hits are summaries; the customer staff pick is read in full once.
 * A new customer is always "Not checked" (Accounts checks it in the CRM).
 */

const SEARCH_LIMIT = 20;
const DOC_BUCKET = 'customer-party-documents';
const DOC_MAX_BYTES = 4 * 1024 * 1024;
const BUSINESS_DOCS_MAX = 3;

const TEXT = {
  searchUnavailable: 'Customers cannot be searched right now. Enter the Bill To details by hand.',
  pickUnavailable: 'This customer cannot be opened right now. Search again or enter the Bill To details by hand.',
  added: 'Customer added. Accounts checks new customers before use.',
  docTooBig: 'is over 4 MB',
  docBadType: 'is not a PDF, JPG, PNG or WebP file',
  docFailed: 'could not be uploaded',
} as const;

const HINTS: Record<string, string> = {
  partyType: PARTY_FIELD.partyType,
  name: PARTY_FIELD.name,
  contactPerson: PARTY_FIELD.contactPerson,
  phone: PARTY_FIELD.phone,
  email: PARTY_FIELD.email,
  addressLine1: PARTY_FIELD.addressLine1,
  addressLine2: PARTY_FIELD.addressLine2,
  city: PARTY_FIELD.city,
  stateCode: PARTY_FIELD.stateCode,
  postalCode: PARTY_FIELD.postalCode,
  gstStatus: PARTY_FIELD.gstStatus,
  gstin: PARTY_FIELD.gstin,
  gstReason: PARTY_FIELD.gstReason,
  requestId: PARTY_FIELD.requestId,
};

/**
 * Bill To search. Bound to the Deal on the server (`searchPartiesAction.bind(null, dealId)`):
 * the database limits results to that Deal's entity and branch (or entity-wide customers)
 * and requires the caller to edit that Deal's booking.
 */
export async function searchPartiesAction(dealId: string, query: string): Promise<SearchResult<PartyOption>> {
  const staff = await requireStaff();
  const q = searchQuery(query);
  if (!q) return { ok: true, items: [], more: false };
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return { ok: false, message: TEXT.searchUnavailable };
  try {
    // Summary hits only (name, place, GSTIN, check state): the one picked is read in full by pickPartyAction.
    const result = await searchParties(asRpcClient(staff.supabase), { query: q, dealId, limit: SEARCH_LIMIT, offset: 0 });
    return { ok: true, items: result.items.map(toPartyOption), more: result.hasMore };
  } catch {
    return { ok: false, message: TEXT.searchUnavailable };
  }
}

/**
 * The customer staff picked in Bill To, read in full (customer_party_get under the caller's
 * own session; a customer the caller may not read is "not available"). Fills the Bill To form;
 * saving Bill To then copies the customer into the Deal's billing on the server.
 */
export async function pickPartyAction(partyId: string): Promise<{ ok: true; party: PartyOption } | { ok: false; message: string }> {
  const staff = await requireStaff();
  if (typeof partyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partyId)) return { ok: false, message: TEXT.pickUnavailable };
  try {
    const record = await getParty(asRpcClient(staff.supabase), partyId);
    return record ? { ok: true, party: toPartyOption(record) } : { ok: false, message: TEXT.pickUnavailable };
  } catch {
    return { ok: false, message: TEXT.pickUnavailable };
  }
}

interface ChosenFile {
  file: File;
  kind: 'id_proof' | 'gst_certificate' | 'other';
  consent: boolean;
  label: string;
}

function chosenFiles(formData: FormData, type: 'personal' | 'business'): ChosenFile[] | { field: string } {
  const out: ChosenFile[] = [];
  if (type === 'personal') {
    const f = formData.get(PARTY_FIELD.idFile);
    if (f instanceof File && f.size > 0) out.push({ file: f, kind: 'id_proof', consent: formData.get(PARTY_FIELD.idConsent) === 'on', label: 'The ID file' });
  } else {
    const docs = formData.getAll(PARTY_FIELD.documents).filter((f): f is File => f instanceof File && f.size > 0);
    if (docs.length > BUSINESS_DOCS_MAX) return { field: PARTY_FIELD.documents };
    docs.forEach((file, i) => out.push({ file, kind: 'other', consent: false, label: docs.length === 1 ? 'The document' : `Document ${i + 1}` }));
  }
  return out;
}

/**
 * "Add customer" (Personal or Business) from Bill To: customer_party_create
 * under the caller's session (entity and branch come from the Deal), then
 * each optional document: checked first (size, type, content), begun under
 * the caller's session (consent for an ID), stored by the privileged client
 * at the path the database chose, finished. The customer is kept when a
 * document fails; the answer says which one.
 */
export async function createPartyAction(_prev: VnResult<{ party: PartyOption }> | null, formData: FormData): Promise<VnResult<{ party: PartyOption }>> {
  const staff = await requireStaff();
  const dealId = readUuidField(formData, PARTY_FIELD.dealId);
  const requestId = readUuidField(formData, PARTY_FIELD.requestId);
  const parsed = parsePartyFields(formData);
  const bad = [...(dealId ? [] : [PARTY_FIELD.dealId]), ...(requestId ? [] : [PARTY_FIELD.requestId]), ...(parsed.ok ? [] : parsed.fields)];
  if (!parsed.ok || bad.length > 0) return vnFail('invalid_input', bad);
  const files = chosenFiles(formData, parsed.fields.partyType);
  if (!Array.isArray(files)) return vnFail('invalid_input', [files.field], 'Attach at most 3 documents. Nothing was saved.');
  // Check every file before anything is written (a refused file leaves the typed details on screen).
  const checked = [];
  for (const f of files) {
    if (f.kind === 'id_proof' && !f.consent) return vnFail('consent_required', [PARTY_FIELD.idConsent], 'Tick that the customer agreed to share this ID, or remove the file. Nothing was saved.');
    if (f.file.size > DOC_MAX_BYTES) return vnFail('invalid_input', [f.kind === 'id_proof' ? PARTY_FIELD.idFile : PARTY_FIELD.documents], `${f.label} ${TEXT.docTooBig}. Nothing was saved.`);
    const bytes = new Uint8Array(await f.file.arrayBuffer());
    const check = checkEvidenceFile({ bytes, declaredMime: f.file.type, fileName: f.file.name });
    if (!check.ok || check.sizeBytes > DOC_MAX_BYTES) return vnFail('invalid_input', [f.kind === 'id_proof' ? PARTY_FIELD.idFile : PARTY_FIELD.documents], `${f.label} ${TEXT.docBadType}. Nothing was saved.`);
    checked.push({ ...f, bytes, check });
  }

  const rpc = asRpcClient(staff.supabase);
  let partyId: string;
  try {
    partyId = (await createParty(rpc, { dealId: dealId!, fields: parsed.fields, requestId: requestId! })).partyId;
  } catch (error) {
    return vnFailFrom(error, HINTS);
  }

  const failed: string[] = [];
  for (const [i, f] of checked.entries()) {
    try {
      const begun = await partyDocumentBegin(rpc, {
        partyId,
        kind: f.kind,
        requestId: derivedRequestId(requestId!, `doc-${i}`),
        consent: f.consent,
        fileName: f.check.fileName,
        mime: f.check.mime,
        sizeBytes: f.check.sizeBytes,
        sha256: f.check.sha256,
      });
      if (begun.status === 'stored') continue;
      if (begun.objectPath === null) {
        failed.push(f.label);
        continue;
      }
      // The database authorized the actor and chose the path: only now the privileged client.
      let stored = false;
      try {
        const up = await createSupabaseAdminClient().storage.from(DOC_BUCKET).upload(begun.objectPath, f.bytes, { contentType: f.check.mime, upsert: false });
        stored = !up.error;
      } catch {
        stored = false;
      }
      const finished = await partyDocumentFinish(rpc, begun.fileId, stored).catch(() => null);
      if (finished?.status !== 'stored') failed.push(f.label);
    } catch {
      failed.push(f.label);
    }
  }

  let party: PartyOption | null = null;
  try {
    const record = await getParty(rpc, partyId);
    party = record ? toPartyOption(record) : null;
  } catch {
    party = null;
  }
  revalidatePath('/app/accounts/customers');
  if (!party) return vnFail('not_found', undefined, 'Customer added, but it could not be shown here. Search for it by name.');
  const docWords = failed.length > 0 ? ` ${failed.join(' and ')} ${TEXT.docFailed}; the customer was added without ${failed.length === 1 ? 'it' : 'them'}.` : '';
  return { ok: true, data: { party }, message: `${TEXT.added}${docWords}` };
}
