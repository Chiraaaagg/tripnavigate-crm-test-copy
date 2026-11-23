import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ManagerApprovalsSchema } from '@/modules/supplier-money/commands';
import type { ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { toManagerApprovalsView } from '@/modules/supplier-money/dto';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { ManagerApprovalsPage, ShowingLine } from '@/views/purchase/manager-approvals';

/**
 * Lead fix-forward 20261204000900: manager_approvals sends at most 50 rows
 * per list plus `<list>Total`. The DTO keeps the totals (optional keys,
 * validated); the Approvals screen says "Showing 50 of N" and links to the
 * supplier register where the rest can be worked.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const supplier = (n: number) => ({
  supplierId: uuid(n),
  name: `Synthetic Supplier ${String(n).padStart(3, '0')}`,
  city: 'Synthetic City',
  serviceTypes: ['hotel'],
  rowVersion: 1,
  updatedAt: '2026-11-10T10:00:00+05:30',
  canVerify: false,
});
const record = (over: Record<string, unknown> = {}) => ({
  costsAboveBudget: [],
  payments: [],
  funding: [],
  bankDetails: [],
  suppliersToVerify: Array.from({ length: 50 }, (_, i) => supplier(i + 1)),
  cancellations: [],
  flightFares: [],
  ...over,
});
const noop = (async () => ({ ok: true, message: 'ok' })) as unknown as DecisionAction;
const render = (view: ManagerApprovalsView) =>
  renderToStaticMarkup(
    createElement(ManagerApprovalsPage, { view, today: '2026-11-12', actions: { decidePayment: noop, decideFunding: noop, decideCancellation: noop } }),
  );

describe('manager_approvals totals (DTO)', () => {
  it('keeps the totals when sent, falls back to the rows when an older database sends none', () => {
    const withTotals = toManagerApprovalsView(ManagerApprovalsSchema.parse(record({ suppliersToVerifyTotal: 3077, costsAboveBudgetTotal: 0 })));
    expect(withTotals.totals?.suppliersToVerify).toBe(3077);
    expect(withTotals.totals?.costsAboveBudget).toBe(0);
    expect(withTotals.totals?.payments).toBe(0);
    const old = toManagerApprovalsView(ManagerApprovalsSchema.parse(record()));
    expect(old.totals?.suppliersToVerify).toBe(50);
  });

  it('refuses a total below the rows sent, a negative or a fractional total', () => {
    expect(ManagerApprovalsSchema.safeParse(record({ suppliersToVerifyTotal: 49 })).success).toBe(false);
    expect(ManagerApprovalsSchema.safeParse(record({ paymentsTotal: -1 })).success).toBe(false);
    expect(ManagerApprovalsSchema.safeParse(record({ fundingTotal: 1.5 })).success).toBe(false);
  });
});

describe('Approvals screen: "Showing 50 of N"', () => {
  it('suppliers to verify: count badge shows the full count, the line links to the register filtered to "not verified"', () => {
    const html = render(toManagerApprovalsView(ManagerApprovalsSchema.parse(record({ suppliersToVerifyTotal: 3077 }))));
    expect(html).toContain('Showing 50 of 3,077.');
    expect(html).toContain('href="/app/purchase/suppliers?verification=unverified&amp;status=active"');
    expect(html).toContain('See all suppliers to verify');
    expect(html).toContain('aria-label="3077 waiting"');
    expect(html.match(/data-testid="approvals-showing"/g)).toHaveLength(1);
  });

  it('no line when every row is shown (or the total is missing)', () => {
    expect(render(toManagerApprovalsView(ManagerApprovalsSchema.parse(record({ suppliersToVerifyTotal: 50 }))))).not.toContain('Showing');
    const fixture: ManagerApprovalsView = { ...toManagerApprovalsView(ManagerApprovalsSchema.parse(record())), totals: undefined };
    expect(render(fixture)).not.toContain('Showing');
  });

  it('a list without a page of its own says the next ones appear here', () => {
    const html = renderToStaticMarkup(createElement(ShowingLine, { shown: 50, total: 3333 }));
    expect(html).toContain('Showing 50 of 3,333. The next ones appear here as these are decided.');
    expect(html).not.toContain('href=');
  });
});
