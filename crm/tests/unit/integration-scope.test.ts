import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIntakeScope, parseIntakeScope } from '@/modules/integration/server/queries';

/* Lead-screens contract §3: intake_scope_status() via the staff session, zod-validated, fail closed. */

const manifest = {
  status: 'active',
  sourceObject: 'lead',
  sourceCode: 'WEBFORM',
  sourceCodeLabel: null,
  businessDate: '2026-10-04',
  intervalFrom: '2026-10-03T18:30:00+00:00',
  intervalTo: '2026-10-04T18:30:00+00:00',
  expectedCount: 12,
  createdByOperator: 'ops-1',
  createdAt: '2026-10-05T04:00:00+00:00',
  closedAt: null,
  counts: { imported: 5, heldForReview: 2, failed: 1, excluded: 3 },
};
const answer = { manifest, lastSuccessfulSyncAt: '2026-10-05T09:00:00+00:00' };

const rpc = vi.fn();
const from = vi.fn();
const staff = { supabase: { rpc, from } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: answer, error: null });
});

describe('loadIntakeScope', () => {
  it('calls only the RPC under the session client and returns the parsed view', async () => {
    await expect(loadIntakeScope(staff)).resolves.toEqual(answer);
    expect(rpc).toHaveBeenCalledWith('intake_scope_status');
    expect(from).not.toHaveBeenCalled();
  });

  it('accepts a null manifest and never-synced', async () => {
    rpc.mockResolvedValue({ data: { manifest: null, lastSuccessfulSyncAt: null }, error: null });
    await expect(loadIntakeScope(staff)).resolves.toEqual({ manifest: null, lastSuccessfulSyncAt: null });
  });

  it('maps 42501 to null and throws on other errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    await expect(loadIntakeScope(staff)).resolves.toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(loadIntakeScope(staff)).rejects.toThrow('Could not load the import list status');
  });

  it('throws (fails closed) on a malformed answer', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(loadIntakeScope(staff)).rejects.toThrow();
  });
});

describe('parseIntakeScope (zod rejection)', () => {
  const bad: Array<[string, unknown]> = [
    ['missing lastSuccessfulSyncAt', { manifest: null }],
    ['unknown top-level key', { ...answer, manifestId: 'x' }],
    ['manifest ids leaking', { ...answer, manifest: { ...manifest, id: 'm1' } }],
    ['unknown status', { ...answer, manifest: { ...manifest, status: 'draft' } }],
    ['unknown source object', { ...answer, manifest: { ...manifest, sourceObject: 'contact' } }],
    ['negative count', { ...answer, manifest: { ...manifest, counts: { ...manifest.counts, failed: -1 } } }],
    ['fractional count', { ...answer, manifest: { ...manifest, expectedCount: 1.5 } }],
    ['string count', { ...answer, manifest: { ...manifest, expectedCount: '12' } }],
    ['extra count key', { ...answer, manifest: { ...manifest, counts: { ...manifest.counts, names: 1 } } }],
    ['bad business date', { ...answer, manifest: { ...manifest, businessDate: '04/10/2026' } }],
    ['bad timestamp', { ...answer, manifest: { ...manifest, intervalFrom: 'yesterday' } }],
    ['bad sync time', { ...answer, lastSuccessfulSyncAt: 'never' }],
    ['array', [answer]],
  ];
  it.each(bad)('rejects %s', (_label, data) => {
    expect(parseIntakeScope(data)).toBeNull();
  });

  it('accepts a closed manifest with closedAt', () => {
    const closed = { ...answer, manifest: { ...manifest, status: 'closed', closedAt: '2026-10-05T11:00:00+00:00' } };
    expect(parseIntakeScope(closed)).toEqual(closed);
  });
});
