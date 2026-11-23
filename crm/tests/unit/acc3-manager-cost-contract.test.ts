import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ManagerApprovalsSchema } from '@/modules/supplier-money/commands';
import type { ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { toManagerApprovalsView } from '@/modules/supplier-money/dto';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';

/**
 * Accounts phase 3 (contract 9.3, 16.4 item 6): the Manager's cost-above-budget
 * card shows "Differs from contract" with the contract total and Purchase's
 * reason before approving. manager_approvals (20261205000520) sends
 * contractState, contractTotalPaise and contractDeviationReason per cost row;
 * the keys are optional so an older database still parses.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cost = (over: Record<string, unknown> = {}) => ({
  taskId: uuid(1),
  dealReference: 'SYN-ACC3-RATE1',
  serviceTitle: 'Synthetic Lake Hotel, Udaipur',
  supplierName: 'Synthetic Lake Partners',
  versionNo: 2,
  amountPaise: '3840000',
  budgetPaise: '3600000',
  proposedAt: '2026-11-12T10:00:00+05:30',
  proposedByName: 'Synthetic Purchase',
  canApprove: true,
  ...over,
});
const record = (rows: unknown[]) => ({
  costsAboveBudget: rows,
  payments: [],
  funding: [],
  bankDetails: [],
  suppliersToVerify: [],
  cancellations: [],
  flightFares: [],
});
const noop = (async () => ({ ok: true, message: 'ok' })) as unknown as DecisionAction;
const render = (view: ManagerApprovalsView) =>
  renderToStaticMarkup(
    createElement(ManagerApprovalsPage, { view, today: '2026-11-13', actions: { decidePayment: noop, decideFunding: noop, decideCancellation: noop } }),
  );
const view = (over: Record<string, unknown> = {}) => toManagerApprovalsView(ManagerApprovalsSchema.parse(record([cost(over)])));

describe('Manager cost-above-budget row: rate contract flags', () => {
  it('keeps the contract flags from the read', () => {
    const v = view({ contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' });
    expect(v.costsAboveBudget[0]).toMatchObject({ contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' });
  });

  it('defaults to none when an older database sends no flags', () => {
    const v = view();
    expect(v.costsAboveBudget[0]).toMatchObject({ contractState: 'none', contractTotalPaise: null, contractDeviationReason: null });
  });

  it('refuses an unknown state or a non-paise total', () => {
    expect(ManagerApprovalsSchema.safeParse(record([cost({ contractState: 'other' })])).success).toBe(false);
    expect(ManagerApprovalsSchema.safeParse(record([cost({ contractTotalPaise: '35200.5' })])).success).toBe(false);
  });

  it('shows "Differs from contract" with the contract total and Purchase’s reason', () => {
    const html = render(view({ contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival surcharge.' }));
    expect(html).toContain('Differs from contract');
    expect(html).toContain('₹35,200');
    expect(html).toContain('Festival surcharge.');
  });

  it('says nothing about a contract when none applied, and "Matches" when it matched', () => {
    expect(render(view())).not.toContain('contract');
    const matches = render(view({ contractState: 'matches', contractTotalPaise: '3840000' }));
    expect(matches).toContain('Matches the rate contract');
    expect(matches).not.toContain('Differs from contract');
  });
});
