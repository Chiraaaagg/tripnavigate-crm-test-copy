import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorize = vi.fn();
const createSignedUrl = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: vi.fn(async () => ({ supabase: { rpc: vi.fn() } })) }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321' }) }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ storage: { from: () => ({ createSignedUrl }) } }),
}));
vi.mock('@/modules/finance/commands', async (original) => ({
  ...(await original<typeof import('@/modules/finance/commands')>()),
  evidenceAuthorizeDownload: authorize,
}));

const { FinanceCommandError } = await import('@/modules/finance/commands');
const { financeEvidenceDownloadResponse } = await import('@/modules/finance/server/evidence');
const ID = '0e000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockResolvedValue({ objectPath: 'entity/slip.pdf', fileName: 'slip.pdf', mime: 'application/pdf' });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/x?token=t' }, error: null });
});

describe('finance file route responses', () => {
  it('redirects an authorized viewer to the short-lived signed URL, never caching it', async () => {
    const res = await financeEvidenceDownloadResponse(ID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1:54321\/storage\//);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it.each(['42501', 'P0002', '55000'])('a refusal (%s) is the same readable 404 with a way back', async (sqlState) => {
    authorize.mockRejectedValueOnce(new FinanceCommandError('finance_evidence_authorize_download', null, sqlState));
    const res = await financeEvidenceDownloadResponse(ID);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('This file does not exist or you cannot open it.');
    expect(html).toContain('href="/app/accounts"');
  });

  it('an ended session is a refusal; an outage or unexpected error is a temporary 503, not "gone"', async () => {
    authorize.mockRejectedValueOnce(new FinanceCommandError('finance_evidence_authorize_download', 'session', 'PGRST301'));
    expect((await financeEvidenceDownloadResponse(ID)).status).toBe(404);
    authorize.mockRejectedValueOnce(new FinanceCommandError('finance_evidence_authorize_download', null, null));
    expect((await financeEvidenceDownloadResponse(ID)).status).toBe(503);
    authorize.mockRejectedValueOnce(new FinanceCommandError('finance_evidence_authorize_download', null, '40001'));
    const res = await financeEvidenceDownloadResponse(ID);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('open it again');
  });

  it('a malformed id is a 404 without asking the database', async () => {
    expect((await financeEvidenceDownloadResponse('not-a-uuid')).status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('a Storage failure or a foreign-origin URL is a 503', async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect((await financeEvidenceDownloadResponse(ID)).status).toBe(503);
    createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://evil.example/x' }, error: null });
    expect((await financeEvidenceDownloadResponse(ID)).status).toBe(503);
  });
});
