import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Echo-A L12: the Accounts customer check page and its document route are
 * for Accounts only. Sales and Managers (who may read the customer through
 * Bill To) get the same not-found answer as a missing customer, before any
 * database read. Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321' }) }));

const { partyFileDownloadResponse } = await import('@/modules/parties/server/party-file-download');
const page = (await import('@/app/app/accounts/customers/[id]/page')).default;
const listPage = (await import('@/app/app/accounts/customers/page')).default;

const USER = 'a0000000-0000-4000-8000-000000000001';
const E1 = 'e0000000-0000-4000-8000-000000000001';
const PARTY = '22222222-2222-4222-8222-222222222222';
const FILE = '44444444-4444-4444-8444-444444444444';
const as = (roles: string[]) =>
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: roles.map((roleCode) => ({ legalEntityId: E1, branchId: 'b', roleCode })), rolePermissions: [], grants: [] } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Accounts-only customer check', () => {
  it('Sales and Managers get not found on the page and 404 on a document, with no database read', async () => {
    for (const role of ['sales', 'manager', 'purchase']) {
      as([role]);
      await expect(page({ params: Promise.resolve({ id: PARTY }) })).rejects.toThrow('NEXT_NOT_FOUND');
      const res = await partyFileDownloadResponse(PARTY, FILE);
      expect(res.status).toBe(404);
    }
    as(['accounts', 'purchase']);
    expect((await partyFileDownloadResponse(PARTY, FILE)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('Accounts reaches the database (which still decides): a refused file is 404 too', async () => {
    as(['accounts']);
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect((await partyFileDownloadResponse(PARTY, FILE)).status).toBe(404);
    expect(rpc).toHaveBeenCalledWith('customer_party_document_authorize_download', { p_file_id: FILE });
  });
  it('the list: Accounts reads it (not tied to the finance switch); Sales gets no access and no read', async () => {
    as(['sales']);
    await listPage({ searchParams: Promise.resolve({}) });
    expect(rpc).not.toHaveBeenCalled();
    as(['accounts']);
    rpc.mockResolvedValue({ data: { items: [], hasMore: false }, error: null });
    await listPage({ searchParams: Promise.resolve({ status: 'returned' }) });
    expect(rpc).toHaveBeenCalledWith('customer_party_accounts_list', { p_status: 'returned', p_limit: 50, p_offset: 0 });
  });
});
