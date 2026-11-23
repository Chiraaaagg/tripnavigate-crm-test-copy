import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Accounts phase 3, track A: uploadBoardingPassAction never asks for a second
 * upload once the file is stored (its message is already queued): a refused
 * passenger / flight link returns ok with a warning (independent UI review,
 * 13 Nov 2026). Database, storage and Next are stubs.
 */

const calls: string[] = [];
let linkFails = false;

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/modules/customer-messages/server/dispatch', () => ({ scheduleCustomerMessageDispatch: () => { calls.push('dispatch'); } }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ storage: { from: () => ({ upload: async () => { calls.push('upload'); return { error: null }; } }) } }),
}));
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: async () => ({
    supabase: {
      rpc: async (fn: string) => {
        calls.push(fn);
        if (fn === 'department_evidence_begin') return { data: { evidenceId: EV, objectPath: 'e/t/x' }, error: null };
        if (fn === 'department_evidence_finish') return { data: { evidenceId: EV, status: 'stored' }, error: null };
        if (fn === 'boarding_pass_slot_link') {
          return linkFails ? { data: null, error: { code: '22023', message: 'invalid_input', hint: 'passengerSeq' } }
            : { data: { outcome: 'created', evidenceId: EV }, error: null };
        }
        return { data: null, error: { code: 'XX000', message: 'unexpected' } };
      },
    },
  }),
}));

const EV = '00000000-0000-4000-8000-0000000000e1';
const TASK = '00000000-0000-4000-8000-0000000000a1';
const SECTOR = '00000000-0000-4000-8000-0000000000b1';

function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('taskId', TASK);
  fd.set('file', new File([new TextEncoder().encode('%PDF-1.4 synthetic boarding pass')], 'bp.pdf', { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  calls.length = 0;
  linkFails = false;
});

describe('uploadBoardingPassAction', () => {
  it('stores, queues and links to the passenger and flight', async () => {
    const { uploadBoardingPassAction } = await import('@/modules/customer-messages/server/actions');
    const r = await uploadBoardingPassAction(null, form({ sectorId: SECTOR, passengerSeq: '1' }));
    expect(r).toMatchObject({ ok: true, message: 'File saved.', data: { evidenceId: EV } });
    expect(calls).toEqual(['department_evidence_begin', 'upload', 'department_evidence_finish', 'dispatch', 'boarding_pass_slot_link']);
  });

  it('a refused link after a stored file: ok with the warning, no failure, so nobody uploads it again', async () => {
    linkFails = true;
    const { uploadBoardingPassAction } = await import('@/modules/customer-messages/server/actions');
    const r = await uploadBoardingPassAction(null, form({ sectorId: SECTOR, passengerSeq: '9' }));
    expect(r).toEqual({ ok: true, message: 'Saved and sent; not linked to this passenger.', data: { evidenceId: EV } });
  });

  it('half a slot is refused before anything is stored', async () => {
    const { uploadBoardingPassAction } = await import('@/modules/customer-messages/server/actions');
    const r = await uploadBoardingPassAction(null, form({ sectorId: SECTOR }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input', field: 'passengerSeq' });
    expect(calls).toEqual([]);
  });
});
