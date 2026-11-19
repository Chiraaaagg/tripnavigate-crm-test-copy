import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountsGoAheadList } from '@/modules/procurement/commands';
import { toAccountsGoAheadRow } from '@/modules/procurement/dto';
import type { RpcClient } from '@/modules/fulfilment/commands';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { AccountsGoAheadPage } from '@/views/accounts/supplier-go-ahead';

/**
 * Accounts phase 3 (contract 9.3, Addendum L2): Accounts sees on the go-ahead
 * row what Purchase and the Manager see about the rate contract.
 * accounts_go_ahead_list (20261205000520) sends contractState,
 * contractTotalPaise and contractDeviationReason; the keys are optional so an
 * older database still parses.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over: Record<string, unknown> = {}) => ({
  requestId: uuid(1),
  status: 'pending',
  current: true,
  dealId: uuid(2),
  dealReference: 'SYN-ACC3-RATE1',
  branchName: 'Delhi',
  taskId: uuid(3),
  itemTitle: 'Synthetic Lake Hotel, Udaipur',
  checkIn: '2026-12-01',
  checkOut: '2026-12-04',
  supplierName: 'Synthetic Lake Partners',
  amountPaise: '3840000',
  costVersionNo: 2,
  requestedAt: '2026-11-12T10:00:00+05:30',
  requestedByName: 'Synthetic Purchase',
  decidedAt: null,
  decidedByName: null,
  returnReason: null,
  rowVersion: 1,
  bookingReviewStatus: 'approved',
  canDecide: true,
  ...over,
});
const client = (data: unknown): RpcClient => ({ rpc: async () => ({ data, error: null }) });
const list = async (over: Record<string, unknown> = {}) => (await accountsGoAheadList(client([row(over)]))).map(toAccountsGoAheadRow);
const noop = (async () => ({ ok: true, message: 'ok' })) as unknown as DecisionAction;
const render = async (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AccountsGoAheadPage, { rows: await list(over), tab: 'to_check', decideAction: noop }));

describe('Accounts go-ahead row: rate contract flags', () => {
  it('keeps the flags from the read; defaults to none when an older database sends none', async () => {
    expect((await list({ contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' }))[0]).toMatchObject({
      contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' });
    expect((await list())[0]).toMatchObject({ contractState: 'none', contractTotalPaise: null, contractDeviationReason: null });
  });

  it('refuses an unknown state or a non-paise total', async () => {
    await expect(list({ contractState: 'other' })).rejects.toThrow();
    await expect(list({ contractTotalPaise: '35200.5' })).rejects.toThrow();
  });

  it('shows "Differs from contract" with the contract total and Purchase’s reason', async () => {
    const html = await render({ contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' });
    expect(html).toContain('Differs from contract');
    expect(html).toContain('₹35,200');
    expect(html).toContain('Festival surcharge.');
  });

  it('nothing about a contract when none applied; "Matches" when it matched', async () => {
    expect(await render()).not.toMatch(/rate contract/i);
    const matches = await render({ contractState: 'matches', contractTotalPaise: '3840000' });
    expect(matches).toContain('Matches the rate contract');
    expect(matches).not.toContain('Differs from contract');
  });
});
