import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * S11 "files to Bitrix", slice 3: deliverFile and the nine download handlers
 * (file 14 section 2.4 and 2.5; file 11 section 2.5 item 5 and 4.2
 * `s11-file-delivery`).
 *
 * - A file in the CRM: the same signed URL and 302 as before, byte for byte
 *   (status, Location, headers), for every handler, and the same 503 text
 *   when signing fails.
 * - A refusal from file_view_begin is answered exactly as before; nothing is
 *   resolved, read or signed.
 * - An older database without file_view_begin falls back to the handler's
 *   own authorize command.
 * - A file kept in Bitrix: the outcome is written before the body, and a
 *   failed write serves nothing; mismatch, size mismatch, missing id, deal
 *   not found, no reader and a Bitrix timeout are never served.
 * - No Bitrix deal id, file id, box key, link or host in any answer; no-store
 *   on every answer; nothing logged.
 *
 * Bitrix, Storage and the database are fakes. Synthetic ids and bytes only.
 */

const rpc = vi.fn();
const adminRpc = vi.fn();
const createSignedUrl = vi.fn();
const storageFrom = vi.fn();
const requireStaff = vi.fn();
const openBitrixFileReader = vi.fn();
const readBox = vi.fn();
const downloadEntry = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => requireStaff(),
  staffForAction: () => requireStaff(),
  SESSION_ENDED: Symbol('session_ended'),
}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ storage: { from: storageFrom }, rpc: adminRpc }) }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, refresh: () => undefined }));
vi.mock('@/modules/integration/server/file-store-access', () => ({ openBitrixFileReader: (options?: unknown) => openBitrixFileReader(options) }));
vi.mock('@/views/files/file-unavailable-page', () => ({
  fileUnavailableHtml: (kind: string) => `<!doctype html><html><head><title>File</title></head><body><p>PAGE:${kind}</p></body></html>`,
}));

const { attachmentDisposition, BITRIX_VIEW_TIMEOUT_MS } = await import('@/modules/documents/server/file-delivery');
const { idProofDownloadResponse } = await import('@/modules/fulfilment/server/id-proof-download');
const { evidenceDownloadResponse } = await import('@/modules/fulfilment/server/evidence-download');
const { departmentEvidenceDownloadResponse } = await import('@/modules/fulfilment/server/department-evidence');
const { eTicketDownloadResponse } = await import('@/modules/flight/server/evidence');
const { financeEvidenceDownloadResponse } = await import('@/modules/finance/server/evidence');
const { refundEvidenceDownloadResponse } = await import('@/modules/refunds/server/evidence');
const { supplierMoneyEvidenceDownloadResponse } = await import('@/modules/supplier-money/server/evidence');
const { partyFileDownloadResponse } = await import('@/modules/parties/server/party-file-download');

// Synthetic ids. The Bitrix values below never appear in any of them.
const USER = 'a0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = 'c0000000-0000-4000-8000-000000000001';
const PARTY = 'b0000000-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const OTHER_FILE = 'f0000000-0000-4000-8000-000000000002';
const VIEW = '0b000000-0000-4000-8000-0000000000ab';

const BITRIX_DEAL_ID = '7300555';
const BITRIX_FILE_ID = '8800333';
const BITRIX_BOX = 'ufCrm_1784359513';
const BITRIX_LINK = 'https://portal-synthetic.bitrix24.test/disk/downloadFile/8800333/?auth=synthetictoken';
const LEAK_MARKERS = [BITRIX_DEAL_ID, BITRIX_FILE_ID, BITRIX_BOX, 'ufCrm', 'bitrix24', 'portal-synthetic', 'urlMachine', 'synthetictoken', VIEW];

const SIGNED = 'http://127.0.0.1:54321/storage/v1/object/sign/bucket/x?token=synthetic';
const CRM_HEADERS = { 'cache-control': 'private, no-store, max-age=0', 'referrer-policy': 'no-referrer', location: SIGNED };

const PDF = (() => {
  const b = new Uint8Array(512);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
  for (let i = 8; i < b.length; i += 1) b[i] = 0x41 + (i % 26);
  return b;
})();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PDF_SHA = sha(PDF);

type Handler = {
  name: string;
  call: () => Promise<Response>;
  table: string;
  bucket: string;
  legacyFn: string;
  legacyArgs: Record<string, string>;
  objectPath: string;
  fileName: string;
  downloadName: string;
  /** Today's 503 when signing fails: plain text, or the Accounts html page. */
  unavailableText: string;
  notFoundText: string;
};

const PATH4 = `${ENTITY}/${DEAL}/${VERSION}/${FILE}`;
const PATH3 = `${ENTITY}/${VERSION}/${FILE}`;
const PLAIN_503 = 'This file is not available right now. Please retry.';
const PAGE_503 = 'The file could not be opened right now. Go back and open it again.';
const PAGE_404 = 'This file does not exist or you cannot open it.';

const HANDLERS: Handler[] = [
  { name: 'traveller ID proof', call: () => idProofDownloadResponse(FILE), table: 'traveller_id_proofs', bucket: 'traveller-id-proofs', legacyFn: 'traveller_id_proof_authorize_download', legacyArgs: { p_file_id: FILE }, objectPath: PATH4, fileName: 'aadhaar front.pdf', downloadName: 'id-proof.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
  { name: 'booking proof', call: () => evidenceDownloadResponse(FILE), table: 'booking_evidence', bucket: 'booking-evidence', legacyFn: 'booking_authorize_evidence_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH4, fileName: 'hotel bill.pdf', downloadName: 'hotel bill.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
  { name: 'department file', call: () => departmentEvidenceDownloadResponse(FILE), table: 'department_evidence', bucket: 'department-evidence', legacyFn: 'department_evidence_authorize_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH3, fileName: 'fee receipt.pdf', downloadName: 'fee receipt.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
  { name: 'flight e-ticket', call: () => eTicketDownloadResponse(FILE), table: 'department_evidence', bucket: 'department-evidence', legacyFn: 'department_evidence_authorize_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH3, fileName: 'e-ticket.pdf', downloadName: 'e-ticket.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
  { name: 'finance file', call: () => financeEvidenceDownloadResponse(FILE), table: 'finance_evidence', bucket: 'finance-evidence', legacyFn: 'finance_evidence_authorize_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH4, fileName: 'bank proof.pdf', downloadName: 'bank proof.pdf', unavailableText: PAGE_503, notFoundText: PAGE_404 },
  { name: 'refund proof', call: () => refundEvidenceDownloadResponse(FILE), table: 'refund_evidence', bucket: 'finance-evidence', legacyFn: 'refund_evidence_authorize_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH4, fileName: 'refund proof.pdf', downloadName: 'refund proof.pdf', unavailableText: PAGE_503, notFoundText: PAGE_404 },
  { name: 'supplier money file', call: () => supplierMoneyEvidenceDownloadResponse(FILE), table: 'supplier_money_evidence', bucket: 'supplier-money', legacyFn: 'supplier_money_evidence_authorize_download', legacyArgs: { p_evidence_id: FILE }, objectPath: PATH4, fileName: 'proforma.pdf', downloadName: 'proforma.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
  { name: 'customer document', call: () => partyFileDownloadResponse(PARTY, FILE), table: 'customer_party_documents', bucket: 'customer-party-documents', legacyFn: 'customer_party_document_authorize_download', legacyArgs: { p_file_id: FILE }, objectPath: `${ENTITY}/${PARTY}/${FILE}`, fileName: 'gst certificate.pdf', downloadName: 'customer-document.pdf', unavailableText: PLAIN_503, notFoundText: 'Not found' },
];
const ID_PROOF = HANDLERS[0]!;
const FINANCE = HANDLERS[4]!;

type Reply = { data?: unknown; error?: { code: string; message: string } | null; throws?: boolean };
/** The user's own session client: one reply (or a queue) per function name; anything else is a test failure. */
function userReplies(map: Record<string, Reply | Reply[] | ((args: Record<string, unknown>) => Reply)>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'function' ? v : Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    const entry = queues[fn];
    if (!entry) throw new Error(`unexpected rpc ${fn}`);
    const reply = typeof entry === 'function' ? entry(args) : entry.length > 1 ? entry.shift()! : entry[0]!;
    if (reply.throws) throw new TypeError('fetch failed');
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

const crmBegin = (h: Handler, over: Record<string, unknown> = {}): Reply => ({ data: { location: 'crm', objectPath: h.objectPath, fileName: h.fileName, mime: 'application/pdf', ...over } });
const bitrixBegin = (h: Handler, over: Record<string, unknown> = {}): Reply => ({ data: { location: 'bitrix', viewId: VIEW, objectPath: h.objectPath, fileName: h.fileName, mime: 'application/pdf', ...over } });
const finishEcho = (args: Record<string, unknown>): Reply => ({ data: { outcome: args.p_outcome } });
const resolved = (over: Record<string, unknown> = {}) => ({ bitrixDealId: BITRIX_DEAL_ID, bitrixField: BITRIX_BOX, bitrixFileId: BITRIX_FILE_ID, sha256: PDF_SHA, sizeBytes: PDF.byteLength, mime: 'application/pdf', ...over });
const ENTRY = { id: Number(BITRIX_FILE_ID), raw: { urlMachine: BITRIX_LINK } };

function bitrixHolds(bytes: Uint8Array = PDF, report: { sha256?: string; sizeBytes?: number } = {}) {
  readBox.mockResolvedValue({ kind: 'ok', entries: [{ id: 1234500, raw: null }, ENTRY] });
  downloadEntry.mockResolvedValue({ kind: 'ok', bytes, sha256: report.sha256 ?? sha(bytes), sizeBytes: report.sizeBytes ?? bytes.byteLength });
}

/** Every Bitrix-path answer: no-store, no-referrer, nosniff; no Bitrix id, box, link or host anywhere. */
async function expectSafe(res: Response): Promise<string> {
  expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(res.headers.get('pragma')).toBe('no-cache');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('location')).toBeNull();
  const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const headerText = JSON.stringify([...res.headers.entries()]);
  for (const marker of LEAK_MARKERS) {
    expect(body).not.toContain(marker);
    expect(headerText).not.toContain(marker);
  }
  return body;
}

function finishCalls(): string[] {
  return rpc.mock.calls.filter((c) => c[0] === 'file_view_finish').map((c) => (c[1] as { p_outcome: string }).p_outcome);
}

const consoleSpies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({
    userId: USER,
    supabase: { rpc },
    access: { userId: USER, memberships: [{ legalEntityId: ENTITY, branchId: 'b', roleCode: 'accounts' }], rolePermissions: [], grants: [] },
  });
  storageFrom.mockReturnValue({ createSignedUrl });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
  adminRpc.mockImplementation(async (fn: string) => {
    if (fn !== 'file_view_resolve') throw new Error(`unexpected admin rpc ${fn}`);
    return { data: resolved(), error: null };
  });
  openBitrixFileReader.mockResolvedValue({ readBox, downloadEntry });
  bitrixHolds();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, level));
});

afterEach(() => {
  // Nothing on the view path logs (no id, link or host can leak through a log line).
  for (const spy of consoleSpies.splice(0)) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.useRealTimers();
});

describe('file in the CRM: unchanged, byte for byte', () => {
  it.each(HANDLERS)('$name: file_view_begin under the session, then the same signed URL and 302', async (h) => {
    userReplies({ file_view_begin: crmBegin(h) });
    const res = await h.call();
    expect(res.status).toBe(302);
    expect(Object.fromEntries(res.headers.entries())).toEqual(CRM_HEADERS);
    expect(await res.text()).toBe('');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('file_view_begin', { p_source_table: h.table, p_source_id: FILE });
    expect(storageFrom).toHaveBeenCalledWith(h.bucket);
    expect(createSignedUrl).toHaveBeenCalledWith(h.objectPath, 60, { download: h.downloadName });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(createSignedUrl.mock.invocationCallOrder[0]!);
    // Nothing of the Bitrix path runs for a CRM file.
    expect(adminRpc).not.toHaveBeenCalled();
    expect(openBitrixFileReader).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)('$name: a failed signing or a foreign origin is the same 503 as before', async (h) => {
    userReplies({ file_view_begin: crmBegin(h) });
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    let res = await h.call();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain(h.unavailableText);

    createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://evil.example/x' }, error: null });
    res = await h.call();
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('refusals: answered exactly as before, nothing resolved, read or signed', () => {
  it.each(HANDLERS)('$name: 42501, P0002 and 55000 are the same 404', async (h) => {
    for (const error of [
      { code: '42501', message: 'not_authorized' },
      { code: 'P0002', message: 'not_found' },
      { code: '55000', message: 'wrong_state' },
    ]) {
      userReplies({ file_view_begin: { error } });
      const res = await h.call();
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain(h.notFoundText);
    }
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(openBitrixFileReader).not.toHaveBeenCalled();
    // Never a second authorize call after a refusal.
    expect(rpc.mock.calls.every((c) => c[0] === 'file_view_begin')).toBe(true);
  });

  it('finance and refunds keep telling a refusal (404) from a temporary failure (503)', async () => {
    for (const h of [FINANCE, HANDLERS[5]!]) {
      userReplies({ file_view_begin: { error: { code: 'PGRST301', message: 'JWT expired' } } });
      expect((await h.call()).status).toBe(404);
      userReplies({ file_view_begin: { error: { code: 'XX000', message: 'boom' } } });
      let res = await h.call();
      expect(res.status).toBe(503);
      expect(await res.text()).toContain(PAGE_503);
      userReplies({ file_view_begin: { throws: true } });
      expect((await h.call()).status).toBe(503);
      userReplies({ file_view_begin: { data: { location: 'somewhere' } } });
      res = await h.call();
      expect(res.status).toBe(503);
    }
  });

  it('the other handlers answer 404 for any failure, as before (network error, unexpected answer)', async () => {
    for (const h of HANDLERS.filter((x) => x !== FINANCE && x !== HANDLERS[5])) {
      userReplies({ file_view_begin: { throws: true } });
      expect((await h.call()).status).toBe(404);
      userReplies({ file_view_begin: { data: { location: 'crm' } } });
      expect((await h.call()).status).toBe(404);
    }
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([ID_PROOF, HANDLERS[7]!])('$name: a path for another file is a 404 in either location (before any Bitrix step)', async (h) => {
    const otherPath = h.objectPath.replace(FILE, OTHER_FILE);
    userReplies({ file_view_begin: crmBegin(h, { objectPath: otherPath }) });
    expect((await h.call()).status).toBe(404);
    userReplies({ file_view_begin: bitrixBegin(h, { objectPath: otherPath }) });
    expect((await h.call()).status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(openBitrixFileReader).not.toHaveBeenCalled();
  });

  it('a malformed id never reaches the database', async () => {
    expect((await idProofDownloadResponse('not-a-uuid')).status).toBe(404);
    expect((await financeEvidenceDownloadResponse('x')).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('older database without file_view_begin: today\'s authorize command decides', () => {
  it.each(HANDLERS)('$name: PGRST202 falls back to the table\'s own command, then the same 302', async (h) => {
    userReplies({
      file_view_begin: { error: { code: 'PGRST202', message: 'Could not find the function' } },
      [h.legacyFn]: { data: { objectPath: h.objectPath, fileName: h.fileName, mime: 'application/pdf' } },
    });
    const res = await h.call();
    expect(res.status).toBe(302);
    expect(Object.fromEntries(res.headers.entries())).toEqual(CRM_HEADERS);
    expect(rpc).toHaveBeenNthCalledWith(1, 'file_view_begin', { p_source_table: h.table, p_source_id: FILE });
    expect(rpc).toHaveBeenNthCalledWith(2, h.legacyFn, h.legacyArgs);
    expect(createSignedUrl).toHaveBeenCalledWith(h.objectPath, 60, { download: h.downloadName });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it('42883 falls back too; a refusal from the old command is still the same 404', async () => {
    userReplies({
      file_view_begin: { error: { code: '42883', message: 'function does not exist' } },
      traveller_id_proof_authorize_download: { error: { code: '42501', message: 'not_authorized' } },
    });
    expect((await idProofDownloadResponse(FILE)).status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();

    userReplies({
      file_view_begin: { error: { code: 'PGRST202', message: 'Could not find the function' } },
      finance_evidence_authorize_download: { error: { code: 'P0002', message: 'not_found' } },
    });
    expect((await financeEvidenceDownloadResponse(FILE)).status).toBe(404);
    userReplies({
      file_view_begin: { error: { code: 'PGRST202', message: 'Could not find the function' } },
      finance_evidence_authorize_download: { throws: true },
    });
    expect((await financeEvidenceDownloadResponse(FILE)).status).toBe(503);
  });
});

describe('file kept in Bitrix', () => {
  it.each(HANDLERS)('$name: checked bytes, outcome written first, then the whole file with safe headers and today\'s name', async (h) => {
    userReplies({ file_view_begin: bitrixBegin(h), file_view_finish: finishEcho });
    const res = await h.call();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe(String(PDF.byteLength));
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${h.downloadName}"`);
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('accept-ranges')).toBeNull();
    expect(res.headers.get('content-range')).toBeNull();
    const body = await expectSafe(res.clone());
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(body.length).toBe(PDF.byteLength);

    // Begin and finish under the user's session; resolve with the privileged client, after begin.
    expect(rpc).toHaveBeenCalledWith('file_view_begin', { p_source_table: h.table, p_source_id: FILE });
    expect(adminRpc).toHaveBeenCalledTimes(1);
    expect(adminRpc).toHaveBeenCalledWith('file_view_resolve', { p_view_id: VIEW });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(adminRpc.mock.invocationCallOrder[0]!);
    expect(readBox).toHaveBeenCalledWith(BITRIX_DEAL_ID, BITRIX_BOX);
    expect(downloadEntry).toHaveBeenCalledWith(ENTRY, PDF.byteLength);
    expect(openBitrixFileReader).toHaveBeenCalledWith({ timeoutMs: BITRIX_VIEW_TIMEOUT_MS });
    expect(finishCalls()).toEqual(['served']);
    const finishOrder = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex((c) => c[0] === 'file_view_finish')]!;
    expect(downloadEntry.mock.invocationCallOrder[0]!).toBeLessThan(finishOrder);
    // Never signed: the CRM copy is not used.
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['an error', { error: { code: '42501', message: 'not_authorized' } }],
    ['a network failure', { throws: true }],
    ['a different outcome', { data: { outcome: 'mismatch' } }],
    ['no answer', { data: null }],
  ] as const)('the outcome cannot be written (%s): 503, nothing served', async (_label, reply) => {
    userReplies({ file_view_begin: bitrixBegin(ID_PROOF), file_view_finish: reply as Reply });
    const res = await idProofDownloadResponse(FILE);
    expect(res.status).toBe(503);
    const body = await expectSafe(res);
    expect(body).toContain('PAGE:bitrix_unavailable');
    expect(body).not.toContain('%PDF');
    expect(finishCalls()).toEqual(['served']);
  });

  const NEVER_SERVED: Array<[string, () => void, string, 'bitrix_unavailable' | 'needs_attention']> = [
    ['hash differs', () => bitrixHolds(PDF, { sha256: 'f'.repeat(64) }), 'mismatch', 'needs_attention'],
    ['bytes differ although the reader reports the right hash', () => {
      const other = PDF.slice();
      other[100] = 0x21;
      bitrixHolds(other, { sha256: PDF_SHA, sizeBytes: PDF.byteLength });
    }, 'mismatch', 'needs_attention'],
    ['size differs', () => bitrixHolds(PDF.slice(0, 400)), 'mismatch', 'needs_attention'],
    ['type bytes do not match the recorded type', () => {
      const png = new Uint8Array(PDF.byteLength);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      bitrixHolds(png);
      adminRpc.mockResolvedValue({ data: resolved({ sha256: sha(png) }), error: null });
    }, 'mismatch', 'needs_attention'],
    ['file too large for the record', () => downloadEntry.mockResolvedValue({ kind: 'unreadable', code: 'too_large' }), 'mismatch', 'needs_attention'],
    ['link to another host', () => downloadEntry.mockResolvedValue({ kind: 'unreadable', code: 'other_host' }), 'mismatch', 'needs_attention'],
    ['not a file', () => downloadEntry.mockResolvedValue({ kind: 'unreadable', code: 'not_a_file' }), 'mismatch', 'needs_attention'],
    ['file id not in the box', () => readBox.mockResolvedValue({ kind: 'ok', entries: [{ id: 1234500, raw: null }] }), 'not_found_in_bitrix', 'needs_attention'],
    ['deal not found', () => readBox.mockResolvedValue({ kind: 'deal_not_found' }), 'deal_not_found', 'needs_attention'],
    ['reader not configured', () => openBitrixFileReader.mockResolvedValue(null), 'bitrix_unavailable', 'bitrix_unavailable'],
    ['Bitrix down', () => readBox.mockRejectedValue(Object.assign(new Error('unavailable'), { kind: 'unavailable', code: 'http_503' })), 'bitrix_unavailable', 'bitrix_unavailable'],
    ['download timed out', () => downloadEntry.mockResolvedValue({ kind: 'unreadable', code: 'timeout' }), 'bitrix_unavailable', 'bitrix_unavailable'],
    ['download HTTP error', () => downloadEntry.mockResolvedValue({ kind: 'unreadable', code: 'http_error' }), 'bitrix_unavailable', 'bitrix_unavailable'],
    ['view no longer resolvable', () => adminRpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'not_found' } }), 'bitrix_unavailable', 'bitrix_unavailable'],
  ];

  it.each(NEVER_SERVED)('%s: never served; outcome %s; the %s page', async (_label, arrange, outcome, page) => {
    arrange();
    userReplies({ file_view_begin: bitrixBegin(ID_PROOF), file_view_finish: finishEcho });
    const res = await idProofDownloadResponse(FILE);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = await expectSafe(res);
    expect(body).toContain(`PAGE:${page}`);
    expect(body).not.toContain('%PDF');
    expect(finishCalls()).toEqual([outcome]);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('the same failures on an Accounts handler use the same pages (not the Accounts 404/503)', async () => {
    readBox.mockResolvedValue({ kind: 'deal_not_found' });
    userReplies({ file_view_begin: bitrixBegin(FINANCE), file_view_finish: finishEcho });
    const res = await financeEvidenceDownloadResponse(FILE);
    expect(res.status).toBe(503);
    expect(await expectSafe(res)).toContain('PAGE:needs_attention');
  });

  it('Bitrix not answering: one attempt, given up after 15 seconds, never served', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    readBox.mockImplementation(() => {
      readStarted();
      return new Promise(() => undefined);
    });
    userReplies({ file_view_begin: bitrixBegin(ID_PROOF), file_view_finish: finishEcho });
    const pending = idProofDownloadResponse(FILE);
    await started;
    await vi.advanceTimersByTimeAsync(BITRIX_VIEW_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await expectSafe(res)).toContain('PAGE:bitrix_unavailable');
    expect(readBox).toHaveBeenCalledTimes(1);
    expect(downloadEntry).not.toHaveBeenCalled();
    expect(finishCalls()).toEqual(['bitrix_unavailable']);
  });

  it('the view limit (PT429) answers the "try again" page, with nothing resolved or read', async () => {
    userReplies({ file_view_begin: { error: { code: 'PT429', message: 'view_limit' } } });
    for (const h of [ID_PROOF, FINANCE]) {
      const res = await h.call();
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await expectSafe(res)).toContain('PAGE:bitrix_unavailable');
    }
    expect(adminRpc).not.toHaveBeenCalled();
    expect(openBitrixFileReader).not.toHaveBeenCalled();
    expect(finishCalls()).toEqual([]);
  });

  it('a Bitrix answer in begin that carries Bitrix details is never passed on', async () => {
    userReplies({
      file_view_begin: bitrixBegin(ID_PROOF, { bitrixDealId: BITRIX_DEAL_ID, bitrixFileId: BITRIX_FILE_ID, link: BITRIX_LINK }),
      file_view_finish: finishEcho,
    });
    const res = await idProofDownloadResponse(FILE);
    expect(res.status).toBe(200);
    await expectSafe(res);
  });
});

describe('attachmentDisposition', () => {
  it('keeps a recorded name as is and never lets a quote or a line break into the header', () => {
    expect(attachmentDisposition('bank proof.pdf')).toBe('attachment; filename="bank proof.pdf"');
    const header = attachmentDisposition('a"b\r\nc.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="a_b__c.pdf"');
    expect(header).toContain("filename*=UTF-8''a%22b%0D%0Ac.pdf");
  });
});
