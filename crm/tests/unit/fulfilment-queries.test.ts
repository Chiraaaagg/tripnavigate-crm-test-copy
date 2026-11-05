import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import {
  loadBookingForDeal,
  loadBookingHealth,
  loadPurchaseQueue,
  loadPurchaseTask,
} from '@/modules/fulfilment/server/queries';

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const TASK = '22222222-2222-4222-8222-222222222222';
const access: ViewerAccess = { userId: 'u', memberships: [], rolePermissions: [], grants: [] };

const rpc = vi.fn();
const dealRow = vi.fn();
const assignments = vi.fn();
const from = vi.fn((table: string) => {
  if (table === 'deals') return { select: () => ({ eq: () => ({ maybeSingle: () => dealRow() }) }) };
  return { select: () => ({ eq: () => ({ is: () => assignments() }) }) };
});
const staff = { access, supabase: { rpc, from } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  dealRow.mockResolvedValue({
    data: { id: DEAL, legal_entity_id: 'e', branch_id: 'b', owner_user_id: 'u' },
    error: null,
  });
  assignments.mockResolvedValue({ data: [], error: null });
});

describe('fulfilment queries', () => {
  it('returns null for malformed ids and invisible deals without calling the panel', async () => {
    await expect(loadBookingForDeal(staff, 'nope')).resolves.toBeNull();
    dealRow.mockResolvedValue({ data: null, error: null });
    await expect(loadBookingForDeal(staff, DEAL)).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refusals are honest null/empty; unexplained failures throw', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    await expect(loadBookingForDeal(staff, DEAL)).resolves.toBeNull();
    await expect(loadPurchaseQueue(staff)).resolves.toEqual({ tasks: [] });
    await expect(loadPurchaseTask(staff, TASK)).resolves.toBeNull();
    await expect(loadBookingHealth(staff)).resolves.toBeNull();

    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(loadBookingForDeal(staff, DEAL)).rejects.toThrow('Could not load the booking');
    await expect(loadPurchaseQueue(staff)).rejects.toThrow();
    await expect(loadBookingHealth(staff)).rejects.toThrow();

    rpc.mockResolvedValue({ data: { unexpected: true }, error: null });
    await expect(loadBookingHealth(staff)).rejects.toThrow();
  });
});
