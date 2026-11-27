import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PurchaseTaskSummary, PurchaseTaskView } from '@/modules/fulfilment/contracts';
import type { PurchaseQueueFlags } from '@/modules/procurement/contracts';
import type { PurchasePaymentRequestView } from '@/modules/supplier-money/contracts';
import { taskTabsFor, type TaskTab } from '@/modules/settings/contracts';
import { matchesSearch, parseQueueQuery, parseQueueShow, queueAddress, QUEUE_SEARCH_MAX, sortQueue } from '@/views/department/queue-show';
import { filterPayments, parsePaymentsQuery, parsePaymentsShow, paymentNext, paymentsRows, PurchasePaymentsPage } from '@/views/purchase/payments-page';
import {
  isSomeoneElseNext,
  purchaseChipMatches,
  purchaseNextStep,
  purchaseNextTargetId,
  PURCHASE_NEXT_STEPS,
  PURCHASE_QUEUE_CHIPS,
  purchaseQueueModel,
  purchaseRowNext,
  purchaseSecondFact,
  purchaseTravelDays,
  PurchaseQueuePage,
  PurchaseTaskPage,
} from '@/views/purchase-views';

/**
 * R3 helper C1 (build plan 4.6): the Purchase queue pattern (search, chips,
 * sort over the rows already returned), Payment requests as a tab, and the
 * task page's record header with the O6 "Next:" jump. Pure functions and
 * static renders only; the browser half is tests/e2e/pb-screens.e2e.ts.
 */

const render = <P extends object>(c: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(c as FunctionComponent<P>, props));

function task(over: Partial<PurchaseTaskSummary> = {}): PurchaseTaskSummary {
  return {
    taskId: 'f0000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-DEL-010',
    serviceType: 'hotel',
    itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
    facts: { type: 'hotel', facts: { hotelName: 'Synthetic Lakeside Hotel', city: 'Udaipur', checkIn: '2026-12-14', checkOut: '2026-12-17', rooms: 1, adults: 2, children: 0 } } as PurchaseTaskSummary['facts'],
    hotelName: 'Synthetic Lakeside Hotel',
    city: 'Udaipur',
    checkIn: '2026-12-14',
    checkOut: '2026-12-17',
    nights: 3,
    rooms: 1,
    travellers: { adults: 2, children: 0 },
    purchaseBudgetPaise: '4500000',
    status: 'not_started',
    assigneeName: null,
    assignedToYou: false,
    branchName: 'Delhi',
    createdAt: '2026-10-02T07:05:00Z',
    supplierConfirmedAt: null,
    ...over,
  };
}

const transfer = (over: Partial<PurchaseTaskSummary> = {}) =>
  task({
    taskId: 'f0000000-0000-4000-8000-000000000009',
    serviceType: 'transfer',
    itemTitle: 'Synthetic airport coach',
    facts: { type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-12-01', vehicleType: 'Coach', passengers: 2 } } as PurchaseTaskSummary['facts'],
    hotelName: null,
    city: null,
    checkIn: null,
    checkOut: null,
    nights: 0,
    rooms: 0,
    ...over,
  });

const flag = (over: Partial<PurchaseQueueFlags> = {}): PurchaseQueueFlags => ({ goAheadState: 'not_requested', tripCancelled: false, ...over });

describe('queue address values (server allowlist)', () => {
  it('reads q, chip and sort; unknown values fall back, never an error', () => {
    expect(parseQueueQuery({}, PURCHASE_QUEUE_CHIPS)).toEqual({ q: '', chip: null, sort: 'soonest' });
    expect(parseQueueQuery({ q: '  Udaipur   lake ', chip: 'goahead', sort: 'deal' }, PURCHASE_QUEUE_CHIPS)).toEqual({ q: 'Udaipur lake', chip: 'goahead', sort: 'deal' });
    expect(parseQueueQuery({ q: ['first', 'second'], chip: ['confirmed'], sort: ['latest'] }, PURCHASE_QUEUE_CHIPS)).toEqual({ q: 'first', chip: 'confirmed', sort: 'latest' });
    expect(parseQueueQuery({ chip: '<script>', sort: 'price' }, PURCHASE_QUEUE_CHIPS)).toEqual({ q: '', chip: null, sort: 'soonest' });
    expect(parseQueueQuery({ q: 'x'.repeat(500) }, PURCHASE_QUEUE_CHIPS).q).toHaveLength(QUEUE_SEARCH_MAX);
  });

  it('every old ?show= value keeps meaning the same tab', () => {
    expect(parseQueueShow(undefined, true)).toBe('not_taken');
    expect(parseQueueShow('mine', true)).toBe('mine');
    expect(parseQueueShow('all', true)).toBe('all');
    expect(parseQueueShow('not_taken', false)).toBe('not_taken');
    expect(parseQueueShow(undefined, false)).toBe('all');
    for (const v of ['open', 'returned', 'paid', 'all'] as const) expect(parsePaymentsShow(v)).toBe(v);
    expect(parsePaymentsShow(undefined)).toBe('open');
    expect(parsePaymentsShow('nonsense')).toBe('open');
  });

  it('builds one address: defaults left out, keys in a fixed order', () => {
    expect(queueAddress('/app/purchase', {})).toBe('/app/purchase');
    expect(queueAddress('/app/purchase', { show: 'all', q: 'Goa beach', chip: 'confirmed', sort: 'deal' })).toBe('/app/purchase?show=all&q=Goa+beach&chip=confirmed&sort=deal');
    expect(queueAddress('/app/purchase', { show: null, q: '', chip: null, sort: 'soonest' })).toBe('/app/purchase');
  });
});

describe('search and sort (pure)', () => {
  it('every word must appear; case does not matter; empty search keeps every row', () => {
    expect(matchesSearch('', ['anything'])).toBe(true);
    expect(matchesSearch('udaipur LAKE', ['Synthetic Lakeside Hotel, Udaipur'])).toBe(true);
    expect(matchesSearch('udaipur goa', ['Synthetic Lakeside Hotel, Udaipur'])).toBe(false);
    expect(matchesSearch('del-010', [null, undefined, 'SYN-DEL-010'])).toBe(true);
  });

  it('soonest and latest travel first; rows with no date always last; the same day by Deal reference; Deal reference in number order', () => {
    const rows = [
      { id: 'a', day: '2026-12-10', deal: 'SYN-10' },
      { id: 'b', day: null, deal: 'SYN-2' },
      { id: 'c', day: '2026-11-01', deal: 'SYN-9' },
      { id: 'd', day: '2026-12-10', deal: 'SYN-1' },
    ];
    const ids = (sort: 'soonest' | 'latest' | 'deal') => sortQueue(rows, sort, (r) => r.day, (r) => r.deal).map((r) => r.id);
    // a and d share a day: one rule for every desk queue (R3 integration) orders them by Deal reference, SYN-1 before SYN-10.
    expect(ids('soonest')).toEqual(['c', 'd', 'a', 'b']);
    expect(ids('latest')).toEqual(['d', 'a', 'c', 'b']);
    expect(ids('deal')).toEqual(['d', 'b', 'c', 'a']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('travel days come from the row itself: hotel stay, transfer date (and end), activity date', () => {
    expect(purchaseTravelDays(task())).toEqual({ from: '2026-12-14', to: '2026-12-17' });
    expect(purchaseTravelDays(transfer())).toEqual({ from: '2026-12-01', to: null });
  });
});

describe('Purchase chips and rows', () => {
  const mine = task({ taskId: 'm', status: 'in_progress', assignedToYou: true, assigneeName: 'Synthetic Purchase' });
  const other = task({ taskId: 'o', status: 'in_progress', assigneeName: 'Synthetic Colleague' });
  const done = task({ taskId: 'd', status: 'supplier_confirmed', assignedToYou: true, assigneeName: 'Synthetic Purchase' });
  const open = task({ taskId: 'n' });
  const flags: Record<string, PurchaseQueueFlags> = { m: flag({ goAheadState: 'pending' }), o: flag({ goAheadState: 'stale' }), d: flag({ goAheadState: 'approved', tripCancelled: true }) };

  it('chips test only the row and its go-ahead flags', () => {
    expect(purchaseChipMatches('goahead', mine, flags)).toBe(true);
    expect(purchaseChipMatches('returned', other, flags)).toBe(true);
    expect(purchaseChipMatches('open', mine, flags)).toBe(true);
    expect(purchaseChipMatches('open', open, flags)).toBe(false);
    expect(purchaseChipMatches('confirmed', done, flags)).toBe(true);
    expect(purchaseChipMatches('cancelled', done, flags)).toBe(true);
    // A confirmed task never waits for a go-ahead.
    expect(purchaseChipMatches('goahead', { ...done }, { d: flag({ goAheadState: 'pending' }) })).toBe(false);
  });

  it('the model filters the open tab, then search, then chip; chip counts follow the search', () => {
    const all = [mine, other, done, open];
    const m = purchaseQueueModel(all, 'all', { q: 'synthetic colleague', chip: null, sort: 'soonest' }, flags);
    expect(m.rows.map((r) => r.taskId)).toEqual(['o']);
    expect(m.chipCounts.returned).toBe(1);
    expect(m.chipCounts.goahead).toBe(0);
    expect(purchaseQueueModel(all, 'mine', { q: '', chip: 'confirmed', sort: 'soonest' }, flags).rows.map((r) => r.taskId)).toEqual(['d']);
    expect(purchaseQueueModel(all, 'not_taken', { q: '', chip: null, sort: 'soonest' }, flags).tabRows.map((r) => r.taskId)).toEqual(['n']);
  });

  it('one plain second fact; trip cancelled first', () => {
    expect(purchaseSecondFact(done, flags)).toBe('Trip cancelled');
    expect(purchaseSecondFact(mine, flags)).toBe('Waiting for Accounts go-ahead');
    expect(purchaseSecondFact(open, {})).toBeNull();
  });

  it('row Next step: a button only when the viewer can act', () => {
    expect(purchaseRowNext(open, flags, true)).toEqual({ text: 'Take this task', button: { label: 'Open to take', href: '/app/purchase/n' } });
    expect(purchaseRowNext(open, flags, false)).toEqual({ text: 'Purchase takes this task' });
    expect(purchaseRowNext(other, flags, true)).toEqual({ text: 'Synthetic Colleague works on it' });
    expect(purchaseRowNext(mine, flags, true).button).toBeUndefined();
    expect(purchaseRowNext(mine, {}, true).button).toEqual({ label: 'Continue', href: '/app/purchase/m?tab=work' });
    expect(purchaseRowNext(done, flags, true)).toEqual({ text: 'Nothing waiting' });
  });

  it('the list page: pill tabs with Payment requests for Purchase only, one toolbar, no money words', () => {
    const html = render(PurchaseQueuePage, { queue: { tasks: [mine, other, done, open] }, canTakeTasks: true, show: 'all', flags, query: { q: 'Udaipur', chip: null, sort: 'deal' } });
    expect(html).toContain('href="/app/purchase/payments"');
    expect(html).toContain('href="/app/purchase?show=mine&amp;q=Udaipur&amp;sort=deal"');
    expect(html).toContain('data-variant="pill"');
    expect(html).toContain('role="search"');
    for (const word of [/selling/i, /margin/i, /payment proof/i, /receipt/i]) expect(html).not.toMatch(word);
    const manager = render(PurchaseQueuePage, { queue: { tasks: [open] }, canTakeTasks: false });
    expect(manager).not.toContain('/app/purchase/payments');
    expect(manager).not.toContain('Open to take');
  });
});

describe('Payment requests tab', () => {
  const pay = (over: Partial<PurchasePaymentRequestView>): PurchasePaymentRequestView =>
    ({
      id: 'p1',
      refNo: 'SP-2026-000001',
      dealId: 'd1',
      dealReference: 'SYN-DEL-010',
      taskId: 't1',
      serviceTitle: 'Synthetic Lakeside Hotel, Udaipur',
      serviceType: 'hotel',
      supplierId: 's1',
      supplierName: 'Synthetic Stays',
      part: 'deposit',
      amountPaise: '3000000',
      dueDate: '2026-12-01',
      note: null,
      route: 'accounts',
      status: 'pending',
      costVersionNo: 1,
      proformaEvidenceId: 'e1',
      returnReason: null,
      requestedAt: '2026-11-01T05:00:00Z',
      requestedByName: null,
      decidedAt: null,
      decidedByName: null,
      paidOn: null,
      paymentMode: null,
      bankReference: null,
      verifiedAt: null,
      companyFundingAsked: false,
      onHold: false,
      holdReason: null,
      resubmittedAs: null,
      resubmitsRefNo: null,
      canCancel: true,
      canResubmit: false,
      rowVersion: 1,
      ...over,
    }) as PurchasePaymentRequestView;

  it('search and sort: due soonest (no date last) or newest request first', () => {
    const rows = [pay({ id: 'a', dueDate: null }), pay({ id: 'b', dueDate: '2026-11-20', supplierName: 'Example Desert Camp' }), pay({ id: 'c', requestedAt: '2026-11-05T05:00:00Z' })];
    expect(paymentsRows(rows, { q: '', sort: 'due' }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(paymentsRows(rows, { q: '', sort: 'newest' }).map((r) => r.id)[0]).toBe('c');
    expect(paymentsRows(rows, { q: 'desert', sort: 'due' }).map((r) => r.id)).toEqual(['b']);
    expect(parsePaymentsQuery({ q: ' x ', sort: 'bogus' })).toEqual({ q: 'x', sort: 'due' });
  });

  it('the chips keep the old ?show= groups', () => {
    const rows = [pay({ id: 'a' }), pay({ id: 'b', status: 'approved' }), pay({ id: 'c', status: 'returned' }), pay({ id: 'd', status: 'verified' }), pay({ id: 'e', status: 'cancelled' })];
    expect(filterPayments(rows, 'open').map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterPayments(rows, 'returned').map((r) => r.id)).toEqual(['c']);
    expect(filterPayments(rows, 'paid').map((r) => r.id)).toEqual(['d']);
    expect(filterPayments(rows, 'all')).toHaveLength(5);
  });

  it('next step names who acts; a returned request offers "Change and send again"', () => {
    expect(paymentNext(pay({ status: 'returned', canResubmit: true })).button.label).toBe('Change and send again');
    expect(paymentNext(pay({ route: 'manager' })).text).toBe('The branch Manager approves or returns it.');
    expect(paymentNext(pay({})).text).toBe('Accounts approves or returns it.');
  });

  it('the page: Payment requests tab current, never a funding word; a failed read is an alert', () => {
    const html = render(PurchasePaymentsPage, { rows: [pay({})], show: 'open' });
    expect(html).toMatch(/aria-current="page"[^>]*href="\/app\/purchase\/payments"|href="\/app\/purchase\/payments"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/funding/i);
    expect(render(PurchasePaymentsPage, { rows: [], show: 'open', failed: true })).toContain('role="alert"');
  });
});

describe('task record header and O6 "Next:" jump', () => {
  const view = (over: Partial<PurchaseTaskView> = {}): PurchaseTaskView => ({
    ...task({ status: 'in_progress', assignedToYou: true, assigneeName: 'Synthetic Purchase' }),
    roomType: null,
    mealPlan: null,
    inclusions: null,
    specialRequests: null,
    confirmedAt: '2026-10-02T07:05:00Z',
    confirmedByName: 'Synthetic Sales',
    versionNo: 1,
    canClaim: false,
    ...over,
  });
  const tabsOf = (current: TaskTab) => ({ tabs: taskTabsFor({ work: true, files: true, history: true }), current });

  it('ids agreed with helper F: purchase-next-<step>', () => {
    expect(PURCHASE_NEXT_STEPS.map(purchaseNextTargetId)).toEqual([
      'purchase-next-charges',
      'purchase-next-add-rate',
      'purchase-next-final-rate',
      'purchase-next-booking-request',
      'purchase-next-confirmation',
    ]);
  });

  it('every line purchaseNextText can return maps to a step, a wait, someone else, or nothing waiting', () => {
    // Read the frozen Work form's own lines so a new wording there fails here instead of losing its button silently.
    const src = readFileSync(join(process.cwd(), 'src/views/purchase/work-tab.tsx'), 'utf8');
    const body = src.slice(src.indexOf('export function purchaseNextText'), src.indexOf('\n}\n', src.indexOf('export function purchaseNextText')));
    const lines = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!).filter((t) => /^[a-zA-Z]/.test(t) && t.includes(' '));
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines) {
      const ok = purchaseNextStep(line) !== null || line.startsWith('wait for') || isSomeoneElseNext(line) || line === 'Nothing waiting.' || line === 'take this task';
      expect(ok, line).toBe(true);
    }
    expect(purchaseNextStep('record the supplier’s confirmation')).toBe('confirmation');
    expect(purchaseNextStep('wait for Accounts to give the go-ahead, then record the supplier’s confirmation')).toBeNull();
  });

  it('on Work the button jumps; elsewhere it opens Work at the control; D6 default tab keeps the bare address', () => {
    const onWork = render(PurchaseTaskPage, { task: view(), tabs: tabsOf('work'), work: 'WORK', nextText: 'choose the final rate' });
    expect(onWork).toContain('href="#purchase-next-final-rate"');
    const onDetails = render(PurchaseTaskPage, { task: view(), tabs: tabsOf('details'), defaultTab: 'work', nextText: 'choose the final rate' });
    expect(onDetails).toContain('href="/app/purchase/f0000000-0000-4000-8000-000000000001#purchase-next-final-rate"');
    expect(onDetails).toContain('href="/app/purchase/f0000000-0000-4000-8000-000000000001?tab=details"');
    const waiting = render(PurchaseTaskPage, { task: view(), tabs: tabsOf('work'), work: 'WORK', nextText: 'wait for the branch Manager to approve the final rate above budget' });
    expect(waiting).not.toContain('#purchase-next-');
  });

  it('a viewer without Work, or someone else working, gets no button; who acts is said in words', () => {
    const other = render(PurchaseTaskPage, { task: view({ assignedToYou: false, assigneeName: 'Synthetic Colleague' }), tabs: tabsOf('details'), managerReadOnly: true });
    expect(other).toContain('Synthetic Colleague works on this task.');
    expect(other).not.toContain('#purchase-next-');
    const sales = render(PurchaseTaskPage, { task: view(), tabs: { tabs: [], current: 'details' } });
    expect(sales).not.toContain('#purchase-next-');
    expect(sales).toContain('You can view this. Purchase in Delhi can change it.');
  });

  it('the header keeps Taken by, the Deal, and folds the internal line', () => {
    const html = render(PurchaseTaskPage, { task: view(), tabs: tabsOf('details') });
    expect(html).toContain('data-slot="record-header"');
    expect(html).toContain('Hotel task · SYN-DEL-010');
    expect(html).toMatch(/Taken by: <span[^>]*>You<\/span>/);
    expect(html).toContain('<details');
    expect(html).toContain('Internal task');
  });
});
