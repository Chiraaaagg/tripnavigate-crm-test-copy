import { describe, expect, it, vi } from 'vitest';
import { runBitrixNameRefresh } from '@/modules/integration/bitrix/name-refresh';
import {
  DEAL_TRIP_DETAIL_CODES as C,
  DEAL_TRIP_DETAIL_FIELDS,
  parseDestinationOptions,
  toCount,
  toDealTripDetails,
  toDestination,
} from '@/modules/integration/bitrix/trip-details';
import { toDealFactsPayload } from '@/modules/integration/bitrix/worker';
import type { RpcClient } from '@/modules/integration/commands';
import { parseIntakeConfigRow } from '@/modules/integration/intake-config';

vi.mock('server-only', () => ({}));

/**
 * Voice-note batch (migration 20261128000100), application side: the Bitrix
 * Deal destination and counts are normalised into codes the database
 * re-checks, the worker sends each group only while its own switch is on, and
 * the daily name refresh reads the destination option names with one
 * crm.deal.fields call while the trip details switch is on. Synthetic values
 * only; no network.
 */

describe('Bitrix Deal trip details', () => {
  it('reads whole counts 0-100 only; anything else is unreadable (code, never the value)', () => {
    expect(toCount('2.00')).toEqual({ count: 2, unreadable: false });
    expect(toCount(3)).toEqual({ count: 3, unreadable: false });
    expect(toCount('')).toEqual({ count: null, unreadable: false });
    expect(toCount(null)).toEqual({ count: null, unreadable: false });
    for (const bad of ['2.5', '101', '-1', 'two', '1e3']) expect(toCount(bad)).toEqual({ count: null, unreadable: true });
  });

  it('takes the single-choice destination first, else the first value of the multiple choice', () => {
    expect(toDestination({ [C.destinationSingle]: '45', [C.destinationMulti]: ['77'] })).toEqual({ field: 'single', optionId: '45', unreadable: false });
    expect(toDestination({ [C.destinationSingle]: '', [C.destinationMulti]: ['77', '78'] })).toEqual({ field: 'multi', optionId: '77', unreadable: false });
    expect(toDestination({ [C.destinationSingle]: false, [C.destinationMulti]: false })).toEqual({ field: null, optionId: null, unreadable: false });
    expect(toDestination({ [C.destinationSingle]: 'Dubai' })).toEqual({ field: null, optionId: null, unreadable: true });
    expect(toDestination({ [C.destinationMulti]: ['x', '79'] })).toEqual({ field: 'multi', optionId: '79', unreadable: false });
  });

  it('builds the database keys with sorted issue codes', () => {
    expect(toDealTripDetails({ [C.destinationSingle]: '45', [C.adults]: '2.00', [C.children]: '1', [C.infants]: '0', EXTRA: 'dropped' }))
      .toEqual({ destinationField: 'single', destinationOptionId: '45', adults: 2, children: 1, infants: 0, detailsIssues: [] });
    expect(toDealTripDetails({ [C.adults]: '2.5', [C.infants]: 'x', [C.destinationSingle]: 'bad' })).toEqual({
      destinationField: null, destinationOptionId: null, adults: null, children: null, infants: null,
      detailsIssues: ['adults_unreadable', 'destination_unreadable', 'infants_unreadable'],
    });
    expect(DEAL_TRIP_DETAIL_FIELDS).toEqual(['UF_CRM_6876462911034', 'UF_CRM_6A9BD81EA7CCF', 'UF_CRM_68A83F913F4EF',
      'UF_CRM_68A83F91465CD', 'UF_CRM_68A83F914D169']);
  });

  it('the worker sends each group only while its own switch is on', () => {
    const raw = {
      ID: '5', DATE_MODIFY: '2026-10-03T10:00:00+05:30', UF_CRM_1784359625: 'Synthetic notes', UF_CRM_68A83F91534CA: '4',
      [C.destinationSingle]: '45', [C.adults]: '3', [C.children]: '1', [C.infants]: '0',
    };
    const factsOnly = toDealFactsPayload(raw, true, false);
    expect(factsOnly).toMatchObject({ bookingNotes: 'Synthetic notes', travellerTotal: 4 });
    expect(factsOnly).not.toHaveProperty('adults');
    const detailsOnly = toDealFactsPayload(raw, false, true);
    expect(detailsOnly).toEqual({ dateModify: '2026-10-03T10:00:00+05:30', destinationField: 'single', destinationOptionId: '45',
      adults: 3, children: 1, infants: 0, detailsIssues: [] });
    expect(toDealFactsPayload(raw, true, true)).toMatchObject({ bookingNotes: 'Synthetic notes', adults: 3 });
  });

  it('reads the switch with the intake config (absent column = off)', () => {
    const row = {
      portal_domain: 'synthetic.example.test', portal_member_id: 'M1', category_id: 7, eligible_category_ids: null,
      eligible_stage_ids: ['C7:NEW'], cutoff_at: '2026-09-01T00:00:00Z', pilot_legal_entity_id: '00000000-0000-4000-8000-000000000001',
      pilot_branch_id: '00000000-0000-4000-8000-000000000002', enabled: true, last_reconciled_at: null, lead_intake_mode: 'manifest',
      deal_intake_mode: 'manifest',
    };
    expect(parseIntakeConfigRow(row)?.tripDetailsRead).toBe(false);
    expect(parseIntakeConfigRow({ ...row, bitrix_trip_details_read: true })?.tripDetailsRead).toBe(true);
  });
});

describe('destination option names', () => {
  const FIELDS = {
    [C.destinationSingle]: { type: 'enumeration', items: [{ ID: '45', VALUE: ' Synthetic Dubai\u0007', SORT: '10' }, { ID: '46', VALUE: 'Synthetic Goa' },
      { ID: '45', VALUE: 'Duplicate' }, { ID: 'x', VALUE: 'Bad id' }, { ID: '47', VALUE: '' }] },
    [C.destinationMulti]: { type: 'enumeration', items: [{ ID: '77', VALUE: 'Synthetic Bali', SORT: 5 }] },
    TITLE: { type: 'string' },
  };

  it('keeps option id, label and sort only; a missing field gives no list', () => {
    expect(parseDestinationOptions(FIELDS)).toEqual([
      { entityId: 'DEAL_DESTINATION', items: [{ code: '45', name: 'Synthetic Dubai', sort: 10 }, { code: '46', name: 'Synthetic Goa', sort: 0 }] },
      { entityId: 'DEAL_DESTINATION_MULTI', items: [{ code: '77', name: 'Synthetic Bali', sort: 5 }] },
    ]);
    expect(parseDestinationOptions({ [C.destinationSingle]: FIELDS[C.destinationSingle] })).toHaveLength(1);
    expect(parseDestinationOptions(null)).toEqual([]);
    expect(parseDestinationOptions([])).toEqual([]);
  });

  function namesDb(due: unknown) {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const rpc: RpcClient = {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        if (fn === 'integration_bitrix_names_due') return { data: due, error: null };
        return { data: { applied: true, lists: 2, added: 3, renamed: 0, missing: 0, restored: 0, dropped: 0 }, error: null };
      },
    };
    return { rpc, calls };
  }

  it('details switch only: one crm.deal.fields call, no status lists; the day completes', async () => {
    const db = namesDb({ due: true, pipelineIds: [], statusLists: false, destinations: true });
    const call = vi.fn(async () => ({ result: FIELDS, next: null, total: null }));
    const r = await runBitrixNameRefresh({ rpc: db.rpc, bitrix: { call: call as never }, config: { portalMemberId: 'M1' } });
    expect(r).toMatchObject({ status: 'ran', listsRead: 2, listsFailed: 0 });
    expect(call.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['crm.deal.fields']);
    const apply = db.calls.find((c) => c.fn === 'integration_apply_bitrix_names')!;
    expect(apply.args).toMatchObject({ p_complete: true });
    expect((apply.args!.p_lists as Array<{ entityId: string }>).map((l) => l.entityId)).toEqual(['DEAL_DESTINATION', 'DEAL_DESTINATION_MULTI']);
    expect(JSON.stringify(apply.args)).not.toContain('enumeration');
  });

  it('a failed or partial fields answer keeps the stored names and leaves the day incomplete', async () => {
    const db = namesDb({ due: true, pipelineIds: [], statusLists: false, destinations: true });
    const partial = vi.fn(async () => ({ result: { [C.destinationSingle]: FIELDS[C.destinationSingle] }, next: null, total: null }));
    expect(await runBitrixNameRefresh({ rpc: db.rpc, bitrix: { call: partial as never }, config: { portalMemberId: 'M1' } }))
      .toMatchObject({ status: 'ran', listsRead: 1, listsFailed: 1 });
    expect(db.calls.find((c) => c.fn === 'integration_apply_bitrix_names')!.args).toMatchObject({ p_complete: false });
    const failing = vi.fn(async () => { throw new Error('provider down'); });
    const db2 = namesDb({ due: true, pipelineIds: [], statusLists: false, destinations: true });
    expect(await runBitrixNameRefresh({ rpc: db2.rpc, bitrix: { call: failing as never }, config: { portalMemberId: 'M1' } }))
      .toEqual({ status: 'error', code: 'nothing_read' });
  });

  it('an older due answer (no list kinds) reads the status lists only, as before', async () => {
    const db = namesDb({ due: true, pipelineIds: [] });
    const call = vi.fn(async (method: string) => ({ result: method === 'crm.status.list' ? [{ STATUS_ID: 'NEW', NAME: 'New' }] : {}, next: null, total: null }));
    await runBitrixNameRefresh({ rpc: db.rpc, bitrix: { call: call as never }, config: { portalMemberId: 'M1' } });
    expect(new Set(call.mock.calls.map((c) => (c as unknown[])[0]))).toEqual(new Set(['crm.status.list']));
  });
});
