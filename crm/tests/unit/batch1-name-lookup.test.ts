import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { bitrixName, bitrixNameKey } from '@/modules/deals/list-model';
import { loadBitrixNameLookup, loadRecordOwnerNames } from '@/modules/deals/server/queries';

const staffAnswering = (answer: { data: unknown; error: { code?: string } | null } | Error) => ({
  supabase: {
    rpc: vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))),
  },
}) as never;

describe('Batch 1 list hooks', () => {
  it('maps the name map: off and not installed show the code fallback, failures are unreadable, names are keyed', async () => {
    await expect(loadBitrixNameLookup(staffAnswering({ data: { enabled: false, readAt: null, names: [] }, error: null }))).resolves.toEqual({ state: 'switched_off' });
    await expect(loadBitrixNameLookup(staffAnswering({ data: null, error: { code: 'PGRST202' } }))).resolves.toEqual({ state: 'switched_off' });
    await expect(loadBitrixNameLookup(staffAnswering({ data: null, error: { code: '42501' } }))).resolves.toEqual({ state: 'list_unreadable' });
    await expect(loadBitrixNameLookup(staffAnswering(new Error('network')))).resolves.toEqual({ state: 'list_unreadable' });
    await expect(loadBitrixNameLookup(staffAnswering({ data: { enabled: true, names: 'bad' }, error: null }))).resolves.toEqual({ state: 'list_unreadable' });

    const on = await loadBitrixNameLookup(
      staffAnswering({
        data: {
          enabled: true,
          readAt: '2026-10-19T10:00:00Z',
          names: [
            { entityId: 'DEAL_STAGE', code: 'WON', name: 'Won - Payment Received', kind: 'won', missing: false },
            { entityId: 'STATUS', code: 'OLD', name: 'Old status', kind: null, missing: true },
          ],
        },
        error: null,
      }),
    );
    expect(on.state).toBe('on');
    expect(bitrixName(on, 'DEAL_STAGE', 'WON')).toEqual({ code: 'WON', name: 'Won - Payment Received', labelState: 'named' });
    expect(bitrixName(on, 'STATUS', 'OLD')).toEqual({ code: 'OLD', name: 'Old status', labelState: 'named', noLongerInList: true });
    expect(bitrixName(on, 'STATUS', 'NEW')).toEqual({ code: 'NEW', name: null, labelState: 'not_in_list' });
    expect(on.state === 'on' && on.names.has(bitrixNameKey('DEAL_STAGE', 'WON'))).toBe(true);
  });

  it('owner names: a failure gives no names, never an error', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await expect(loadRecordOwnerNames(staffAnswering({ data: null, error: { code: '42501' } }), [id])).resolves.toEqual(new Map());
    await expect(loadRecordOwnerNames(staffAnswering(new Error('network')), [id])).resolves.toEqual(new Map());
    await expect(
      loadRecordOwnerNames(staffAnswering({ data: [{ userId: id, displayName: 'Asha Rao' }], error: null }), [id]),
    ).resolves.toEqual(new Map([[id, 'Asha Rao']]));
  });
});
