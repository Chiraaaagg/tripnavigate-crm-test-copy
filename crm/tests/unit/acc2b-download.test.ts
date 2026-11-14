import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Accounts phase 2, Track B: the customer document PDF route body (contract
 * 6.8, B10; L7 review 10): authorised under the staff session, Deal of the
 * link checked, streamed as an attachment only when the bytes match the
 * stored sha256. Fakes for the session, the commands and Storage.
 */

const DEAL = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const PATH = `${ENTITY}/customer-documents/${DOC}/${JOB}.pdf`;
const BYTES = new Uint8Array([37, 80, 68, 70, 45, 49]);

const state = { bytes: BYTES, sha: createHash('sha256').update(BYTES).digest('hex'), dealId: DEAL, refuse: false };

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: vi.fn(async () => ({ supabase: { rpc: vi.fn() } })) }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    storage: { from: () => ({ download: async () => ({ data: new Blob([state.bytes]), error: null }) }) },
  }),
}));
vi.mock('@/modules/customer-documents/commands', () => ({
  readDocument: vi.fn(async () => ({ dealId: state.dealId })),
  authorizeDownload: vi.fn(async () => {
    if (state.refuse) throw new Error('not_authorized');
    return { documentId: DOC, objectPath: PATH, fileName: 'SYN-DEL-001-INV-1.pdf', sizeBytes: state.bytes.byteLength, sha256: state.sha };
  }),
}));

const { customerDocumentPdfResponse } = await import('@/modules/customer-documents/server/download');

beforeEach(() => {
  state.bytes = BYTES;
  state.sha = createHash('sha256').update(BYTES).digest('hex');
  state.dealId = DEAL;
  state.refuse = false;
});

describe('customerDocumentPdfResponse', () => {
  it('streams the PDF as an attachment, never cached', async () => {
    const r = await customerDocumentPdfResponse(DEAL, DOC);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="SYN-DEL-001-INV-1.pdf"');
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES);
  });

  it('refuses on a sha256 mismatch (409), another Deal or a refusal (404), a malformed id (404)', async () => {
    state.sha = 'f'.repeat(64);
    expect((await customerDocumentPdfResponse(DEAL, DOC)).status).toBe(409);
    state.sha = createHash('sha256').update(BYTES).digest('hex');
    state.dealId = '99999999-9999-4999-8999-999999999999';
    expect((await customerDocumentPdfResponse(DEAL, DOC)).status).toBe(404);
    state.dealId = DEAL;
    state.refuse = true;
    expect((await customerDocumentPdfResponse(DEAL, DOC)).status).toBe(404);
    expect((await customerDocumentPdfResponse('nope', DOC)).status).toBe(404);
  });
});
