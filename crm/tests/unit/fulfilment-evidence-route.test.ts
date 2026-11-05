import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /app/bookings/evidence/[id]: session gate → authorization under the
 * user's session → privileged signed URL (60 s, download name) → 302.
 * Every refusal is a 404; nothing is cached.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const createSignedUrl = vi.fn();
const adminFactory = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  const config = original.parseAppConfig({
    APP_ENV: 'local',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
    NEXT_PUBLIC_SITE_URL: 'https://crm.example.test',
  });
  return { ...original, getAppConfig: () => config };
});

const { GET } = await import('@/app/app/bookings/evidence/[id]/route');

const EVIDENCE = '44444444-4444-4444-8444-444444444444';
const PATH = 'e0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444';
const SIGNED = 'http://127.0.0.1:54321/storage/v1/object/sign/booking-evidence/x?token=t&download=ticket.pdf';

const call = (id: string) => GET(new Request(`https://crm.example.test/app/bookings/evidence/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: 'u', supabase: { rpc } });
  adminFactory.mockReturnValue({ storage: { from: () => ({ createSignedUrl }) } });
  rpc.mockResolvedValue({ data: { objectPath: PATH, fileName: 'ticket.pdf', mime: 'application/pdf' }, error: null });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
});

describe('GET /app/bookings/evidence/[id]', () => {
  it('authorizes first, then 302s to a 60 s download URL without caching', async () => {
    const res = await call(EVIDENCE);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SIGNED);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(rpc).toHaveBeenCalledWith('booking_authorize_evidence_download', { p_evidence_id: EVIDENCE });
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 60, { download: 'ticket.pdf' });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(adminFactory.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['not authorized (e.g. Purchase)', { code: '42501', message: 'not_authorized' }],
    ['not found / not stored', { code: 'P0002', message: 'not_found' }],
    ['unexpected', { code: 'XX000', message: 'boom' }],
  ])('404 when %s, never signing', async (_n, error) => {
    rpc.mockResolvedValue({ data: null, error });
    const res = await call(EVIDENCE);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('404 for a malformed id without a database call', async () => {
    const res = await call('../../etc');
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('404 when the authorization response is malformed (path traversal)', async () => {
    rpc.mockResolvedValue({ data: { objectPath: '../other/file', fileName: 'a.pdf', mime: 'application/pdf' }, error: null });
    expect((await call(EVIDENCE)).status).toBe(404);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('never redirects to a host other than the Supabase project', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://evil.example/steal' }, error: null });
    const res = await call(EVIDENCE);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
  });

  it('stops at the session gate', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /sign-in'));
    await expect(call(EVIDENCE)).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });
});
