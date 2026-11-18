import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountsSupplierPaymentRow, ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { dayText } from '@/views/accounts-desk/labels';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { ChangeRequestsApprovals } from '@/views/booking-changes/approvals';
import { ChangeReviewPanel, valueText } from '@/views/booking-changes/review';
import * as CF from '@/app/preview/[state]/acc3-changes-fixtures';
import type { ChangeReviewView } from '@/views/booking-changes/types';
import { ManagerApprovalsPage, nothingWaitingText, planApprovalsSections } from '@/views/purchase/manager-approvals';

/*
 * Redesign R3, helper E (design plan DM-5 to DM-8, DM-25): Manager ·
 * Approvals shows summary chips, only sections with something waiting, the
 * empty ones in one closing line, and one decision row (Approve, then
 * "Return with reason" opening the reason box). Who may decide stays with
 * the database: the screen only follows canApprove / canDecide per row.
 * Synthetic values only.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EMPTY: ManagerApprovalsView = { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] };
const noop = (async () => ({ ok: true, message: 'ok' })) as unknown as DecisionAction;
const actions = { decidePayment: noop, decideFunding: noop, decideCancellation: noop };
const render = (view: ManagerApprovalsView, extra: Partial<Parameters<typeof ManagerApprovalsPage>[0]> = {}) =>
  renderToStaticMarkup(createElement(ManagerApprovalsPage, { view, today: '2026-11-17', actions, ...extra }));

const cost = (over: Record<string, unknown> = {}) => ({
  taskId: uuid(1),
  dealReference: 'SYN-R3-001',
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

const payment = (over: Partial<AccountsSupplierPaymentRow> = {}): AccountsSupplierPaymentRow => ({
  id: uuid(20),
  refNo: 'SP-2026-000901',
  dealId: uuid(21),
  dealReference: 'SYN-R3-002',
  branchName: 'Jodhpur',
  taskId: uuid(22),
  serviceTitle: 'Synthetic Fort Hotel, Jodhpur',
  serviceType: 'hotel',
  supplierId: uuid(23),
  supplierName: 'Synthetic Fort Partners',
  part: 'deposit',
  amountPaise: '7500000',
  customerMoneyPaise: '7500000',
  dueDate: null,
  note: null,
  route: 'manager',
  status: 'pending',
  costVersionNo: 1,
  agreedCostPaise: '15000000',
  proformaEvidenceId: null,
  returnReason: null,
  requestedAt: '2026-11-15T10:00:00+05:30',
  requestedByName: 'Synthetic Purchase',
  decidedAt: null,
  decidedByName: null,
  paidOn: null,
  paymentMode: null,
  bankReference: null,
  paymentProofEvidenceId: null,
  bankRevisionNo: null,
  recordedAt: null,
  recordedByName: null,
  verifiedAt: null,
  verifiedByName: null,
  bankDetails: null,
  funding: null,
  onHold: false,
  holdReason: null,
  rowVersion: 4,
  canDecide: true,
  canRecord: false,
  canVerify: false,
  department: 'purchase',
  flightBatchNo: null,
  ...over,
});

describe('planApprovalsSections', () => {
  it('keeps the page order, shows only sections with something waiting or an unknown count, and names the empty ones', () => {
    const plan = planApprovalsSections([
      { key: 'suppliers', count: 3, node: null },
      { key: 'payments', count: 0, node: null },
      { key: 'changes', count: 'unknown', node: null },
      { key: 'costs', count: 2, node: null },
      { key: 'bankDetails', count: 0, node: null },
    ]);
    expect(plan.waiting.map((e) => e.key)).toEqual(['costs', 'changes', 'suppliers']);
    expect(plan.empty).toEqual(['payments', 'bankDetails']);
    expect(plan.total).toBe(5);
    expect(plan.chips).toEqual([
      { targetId: 'ap-costs', label: 'Costs above budget', count: 2 },
      { targetId: 'ap-changes-h', label: 'Changes after confirmation', count: 'unknown' },
      { targetId: 'ap-suppliers', label: 'Suppliers to verify', count: 3 },
    ]);
  });

  it('says which lists hold nothing in one line, and nothing when every list has work', () => {
    expect(nothingWaitingText(['funding', 'bankDetails'])).toBe('Nothing waiting: company funding, supplier bank details.');
    expect(nothingWaitingText([])).toBeNull();
  });
});

describe('Manager · Approvals page', () => {
  it('shows chips that jump to the sections with work, hides empty sections and lists them once at the end', () => {
    const html = render({ ...EMPTY, costsAboveBudget: [cost()], payments: [payment()] });
    expect(html).toContain('aria-label="Waiting for you, by kind"');
    expect(html).toContain('href="#ap-costs"');
    expect(html).toContain('href="#ap-payments"');
    expect(html).not.toContain('href="#ap-funding"');
    expect(html).not.toContain('id="ap-funding"');
    expect(html).not.toContain('Nothing waiting.');
    expect(html).toContain('Nothing waiting: flight fares above budget, company funding, trip cancellation charges, supplier bank details, suppliers to verify.');
  });

  it('names a section the route could not read as "count not known", never 0, and shows it', () => {
    const html = render(EMPTY, { extraSections: [{ key: 'rateContracts', count: 'unknown', node: createElement('p', null, 'Rate contracts could not be loaded') }] });
    expect(html).toContain('href="#approvals-rc-heading"');
    expect(html).toContain('count not known');
    expect(html).toContain('Rate contracts could not be loaded');
    expect(html).not.toContain('Nothing waiting for you');
  });

  it('a section the viewer does not have is neither shown nor named', () => {
    const html = render({ ...EMPTY, costsAboveBudget: [cost()] });
    expect(html).not.toMatch(/refunds|write-offs|rate contracts|changes after confirmation/i);
  });

  it('shows the empty state when nothing waits anywhere', () => {
    const html = render(EMPTY, { extraSections: [{ key: 'refunds', count: 0, node: null }] });
    expect(html).toContain('Nothing waiting for you');
    expect(html).not.toContain('Waiting for you, by kind');
  });

  it('payment row: Approve and "Return with reason" with the record in their names; no reason box until Return; same fields as before', () => {
    const html = render({ ...EMPTY, payments: [payment()] });
    expect(html).toMatch(/Approve payment<span class="sr-only"> SP-2026-000901<\/span>/);
    expect(html).toMatch(/Return with reason<span class="sr-only"> SP-2026-000901<\/span>/);
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Reason for returning (optional)');
    for (const field of ['paymentId', 'expectedRowVersion', 'requestId']) expect(html).toContain(`name="${field}"`);
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('Show details');
  });

  it('own request: both buttons are shown disabled with the reason (the database refuses it anyway)', () => {
    const html = render({ ...EMPTY, costsAboveBudget: [cost({ canApprove: false })], payments: [payment({ canDecide: false })] });
    expect(html).toContain('You can’t approve your own price. Another Manager decides.');
    expect(html).toContain('Another Manager decides this one. Nobody approves their own request.');
    expect(html).not.toMatch(/<form[^>]*>[^]*?Approve this cost above budget/);
    // Review P3-6: shown disabled but still focusable (aria-disabled, in no form), so keyboard users reach the reason.
    expect(html.match(/aria-disabled="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('cost above budget approves exactly the version shown (taskId and versionNo posted)', () => {
    const html = render({ ...EMPTY, costsAboveBudget: [cost({ versionNo: 7 })] });
    expect(html).toContain(`name="taskId" value="${uuid(1)}"`);
    expect(html).toContain('name="versionNo" value="7"');
    expect(html).toContain('Approve this cost above budget');
  });
});

describe('Change review: changed first, unchanged folded, usual dates', () => {
  const side = (versionNo: number, nights: string, plan = [{ seq: 1, label: 'Deposit', amountPaise: '100000', dueDate: '2026-12-01' }]) => ({
    versionNo,
    tripStart: '2026-12-12',
    tripEnd: '2026-12-15',
    sellingTotalPaise: '500000',
    plan,
    services: [
      { itemId: 'a', itemNo: 1, serviceType: 'hotel', serviceTitle: 'Synthetic Hotel A', budgetPaise: null, facts: [{ key: 'checkIn', label: 'Check-in', value: nights }] },
      { itemId: 'b', itemNo: 2, serviceType: 'hotel', serviceTitle: 'Synthetic Hotel B', budgetPaise: null, facts: [{ key: 'rooms', label: 'Rooms', value: '1' }] },
    ],
  });
  const review: ChangeReviewView = {
    changeRequestId: 'cr',
    refNo: 'CR-2026-000901',
    kind: 'change',
    status: 'requested',
    rowVersion: 1,
    removalRoute: null,
    customerChargePaise: null,
    base: side(1, '2026-12-12'),
    proposed: side(2, '2026-12-13'),
    changedItemIds: ['a'],
    changedFields: [],
    sentVersionCurrent: true,
    canDecide: true,
  };

  it('writes plain days the usual way and leaves other text alone', () => {
    expect(valueText('2026-12-13')).toBe(dayText('2026-12-13'));
    expect(valueText('From 2026-12-13, 2 rooms')).toBe(`From ${dayText('2026-12-13')}, 2 rooms`);
    expect(valueText(null)).toBe('—');
  });

  it('shows the changed service first and folds the trip facts, plan and services that stay the same', () => {
    const html = renderToStaticMarkup(createElement(ChangeReviewPanel, { review }));
    expect(html).not.toContain('2026-12-13');
    const fold = html.indexOf('Show unchanged details');
    expect(fold).toBeGreaterThan(-1);
    expect(html.indexOf('Synthetic Hotel A')).toBeLessThan(fold);
    expect(html.indexOf('Synthetic Hotel B')).toBeGreaterThan(fold);
    expect(html.indexOf('Trip dates')).toBeGreaterThan(fold);
    expect(html).toContain('<details');
  });
});

describe('confirm steps kept from before the redesign', () => {
  it('a change request still confirms before Approve posts: no approve form outside the dialog', () => {
    const html = renderToStaticMarkup(
      createElement(ChangeRequestsApprovals, { viewer: 'manager', page: { items: [CF.ROW_CHANGE], nextAfter: null, hasMore: false }, reviews: { [CF.ROW_CHANGE.id]: CF.REVIEW_CHANGE }, actions: { decide: noop } }),
    );
    expect(html).toContain('Approve this version');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('name="decision" value="approve"');
    expect(html).toContain('data-slot="decision-footer"');
  });

  it('a supplier payment stays one press (it had no confirm before)', () => {
    const html = render({ ...EMPTY, payments: [payment()] });
    expect(html).toContain('name="decision" value="approve"');
  });
});
