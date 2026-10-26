import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FlightTaskView, PurchaseTaskSummary, PurchaseTaskView, VisaQueueView } from '@/modules/fulfilment/contracts';
import { taskTabsFor, type DepartmentTaskHistoryRecord, type TaskTab } from '@/modules/settings/contracts';
import { VisaQueuePage } from '@/views/b11/visa-desk';
import { filterQueue, parseQueueShow, queueShowHref, queueShowsFor } from '@/views/department/queue-show';
import { budgetText, TASK_FILES_TEXT, taskNextText } from '@/views/department/task-frame';
import { TASK_HISTORY_TEXT, toTaskHistoryVM } from '@/views/department/task-history-vm';
import { FlightTaskPage } from '@/views/flight-views';
import { PurchaseQueuePage, PurchaseTaskPage } from '@/views/purchase-views';

/**
 * Batch 4 department screens (DA-16, DA-270 to DA-273; money-privacy-settings
 * §10 T-B4-01 to T-B4-08): list tabs, task tabs, History names and wording,
 * and that no tab carries money words.
 */

const render = <P extends object>(c: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(c as FunctionComponent<P>, props));

/** The href of the link marked aria-current="page" inside the named navigation. */
function currentIn(html: string, navLabel: string): string | undefined {
  const nav = html.split(`aria-label="${navLabel}"`)[1]?.split('</nav>')[0] ?? '';
  return /<a aria-current="page"[^>]*href="([^"]+)"/.exec(nav)?.[1];
}

/** The Files tab states the rule in words (DA-270); a rule is not data, so it is left out of the scan. */
const withoutRules = (html: string) => html.replace(TASK_FILES_TEXT.note, '');

/** booking-form-2026-10-22/money-privacy-copy.md §B search strings plus the Batch 4 key names. */
const NEVER = [/selling/i, /margin/i, /markup/i, /12,345\.67/, /2,345\.67/, /24,691\.34/, /payment proof/i, /acceptance/i, /paymentPlan/, /instalment/i, /claims/i, /receipts?\b/i, /finance_evidence/];

function summary(over: Partial<PurchaseTaskSummary> = {}): PurchaseTaskSummary {
  return {
    taskId: 'f0000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-DEL-001',
    serviceType: 'hotel',
    itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
    facts: { type: 'hotel', facts: { hotelName: 'Synthetic Lakeside Hotel', city: 'Udaipur', checkIn: '2026-11-14', checkOut: '2026-11-17', rooms: 1, adults: 2, children: 0 } } as PurchaseTaskSummary['facts'],
    hotelName: 'Synthetic Lakeside Hotel',
    city: 'Udaipur',
    checkIn: '2026-11-14',
    checkOut: '2026-11-17',
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

function view(over: Partial<PurchaseTaskView> = {}): PurchaseTaskView {
  return {
    ...summary(),
    roomType: 'Deluxe',
    mealPlan: 'Breakfast',
    inclusions: null,
    specialRequests: 'Late check-in (synthetic)',
    confirmedAt: '2026-10-02T07:05:00Z',
    confirmedByName: 'Synthetic Sales Delhi A',
    versionNo: 1,
    canClaim: false,
    ...over,
  };
}

const tabsOf = (current: TaskTab, has = { work: true, files: true, history: true }) => ({ tabs: taskTabsFor(has), current });

describe('department list tabs (Not taken · Mine · All)', () => {
  it('takers default to Not taken, the branch Manager to All and has no Mine', () => {
    expect(queueShowsFor(true)).toEqual(['not_taken', 'mine', 'all']);
    expect(queueShowsFor(false)).toEqual(['not_taken', 'all']);
    expect(parseQueueShow(undefined, true)).toBe('not_taken');
    expect(parseQueueShow(undefined, false)).toBe('all');
    expect(parseQueueShow('mine', false)).toBe('all');
    expect(parseQueueShow(['mine'], true)).toBe('mine');
    expect(parseQueueShow('<script>', true)).toBe('not_taken');
    expect(queueShowHref('/app/purchase', 'not_taken', true)).toBe('/app/purchase');
    expect(queueShowHref('/app/purchase', 'all', true)).toBe('/app/purchase?show=all');
    expect(queueShowHref('/app/purchase', 'all', false)).toBe('/app/purchase');
  });

  it('filters only the rows already on the page', () => {
    const rows = [summary({ taskId: 'a' }), summary({ taskId: 'b', status: 'in_progress', assigneeName: 'You', assignedToYou: true }), summary({ taskId: 'c', status: 'in_progress', assigneeName: 'Synthetic Colleague' })];
    expect(filterQueue(rows, 'not_taken').map((r) => r.taskId)).toEqual(['a']);
    expect(filterQueue(rows, 'mine').map((r) => r.taskId)).toEqual(['b']);
    expect(filterQueue(rows, 'all')).toHaveLength(3);
  });

  it('list page: tabs are links with aria-current and counts; no money words (T-B4-01)', () => {
    const html = render(PurchaseQueuePage, { queue: { tasks: [summary(), summary({ taskId: 'x', purchaseBudgetPaise: '0', status: 'in_progress', assigneeName: 'Synthetic Colleague' })] }, canTakeTasks: true });
    expect(html).toContain('aria-label="Purchase task filters"');
    expect(currentIn(html, 'Purchase task filters')).toBe('/app/purchase');
    expect(html).toContain('href="/app/purchase?show=mine"');
    expect(html).toContain('1 hotel task');
    for (const word of NEVER) expect(html).not.toMatch(word);
    const all = render(PurchaseQueuePage, { queue: { tasks: [summary({ purchaseBudgetPaise: '0' })] }, canTakeTasks: true, show: 'all' });
    expect(all).toContain('Budget not set');
    expect(all).not.toContain('₹0.00');
  });

  it('empty list and empty tab say why, honestly', () => {
    expect(render(PurchaseQueuePage, { queue: { tasks: [] }, canTakeTasks: true })).toContain('Tasks appear after Sales submits a booking with a hotel, transfer or activity.');
    expect(render(PurchaseQueuePage, { queue: { tasks: [summary()] }, canTakeTasks: true, show: 'mine' })).toContain('No tasks taken by you');
  });
});

describe('department task tabs (Details · Work · Files · History)', () => {
  it('status-only viewer (Sales, Accounts) gets no tab bar and no work (R11)', () => {
    const html = render(PurchaseTaskPage, { task: view({ status: 'supplier_confirmed', supplierConfirmedAt: '2026-10-03T06:30:00Z' }), tabs: tabsOf('details', { work: false, files: false, history: false }) });
    expect(html).not.toContain('Task sections');
    expect(html).toContain('Nothing waiting.');
    expect(html).not.toContain('Supplier offers');
  });

  it('only the open tab is rendered; tabs never carry a count; no Money tab', () => {
    const files = render(PurchaseTaskPage, {
      task: view({ assigneeName: 'Synthetic Purchase Jodhpur', assignedToYou: true, status: 'in_progress' }),
      tabs: tabsOf('files'),
      files: { purchase: [{ id: 'p1', kind: 'quote', fileName: 'synthetic-quote.pdf', mime: 'application/pdf', sizeBytes: 1000, status: 'stored', createdAt: '2026-10-03T05:11:00Z', uploadedByName: null }] },
    });
    expect(files).toContain('aria-label="Task sections"');
    expect(currentIn(files, 'Task sections')).toBe('/app/purchase/f0000000-0000-4000-8000-000000000001?tab=files');
    expect(files).toContain('href="/app/purchase/f0000000-0000-4000-8000-000000000001"');
    expect(files).not.toMatch(/>Money</);
    expect(files).not.toContain('Check-in');
    expect(files).toContain('/app/purchase/files/p1');
    expect(files).toContain('Customer payment proofs and acceptance messages are never listed here.');
    // Header primary: the assignee off the Work tab gets a link to it.
    expect(files).toContain('Record supplier confirmation');
    const work = render(PurchaseTaskPage, { task: view({ assigneeName: 'Synthetic Purchase Jodhpur', assignedToYou: true, status: 'in_progress' }), tabs: tabsOf('work'), work: 'WORK-SLOT' });
    expect(work).toContain('WORK-SLOT');
    expect(work).not.toContain('Record supplier confirmation');
  });

  it('every Purchase and Flight tab is free of money words (T-B4-02 to T-B4-08)', () => {
    const flight: FlightTaskView = {
      taskId: 't4',
      dealReference: 'BX-900420',
      itemTitle: 'DEL → IXZ → DEL',
      facts: { segments: [{ from: 'DEL', to: 'IXZ', date: '2026-11-20' }], passengers: 2 },
      purchaseBudgetPaise: '5200000',
      status: 'in_progress',
      assigneeName: 'Synthetic Flight Jodhpur',
      assignedToYou: true,
      branchName: 'Delhi',
      createdAt: '2026-10-09T07:05:00Z',
      supplierConfirmedAt: null,
      confirmedAt: '2026-10-09T07:05:00Z',
      confirmedByName: 'Synthetic Sales Delhi A',
      versionNo: 1,
      canClaim: false,
      travellerCount: 2,
    };
    const history = toTaskHistoryVM({ taskId: 't4', department: 'flight', truncated: false, events: [{ at: '2026-11-04T10:00:00Z', kind: 'sent_to_accounts', byName: null, byYou: true, toName: null, toYou: false, applicantSeq: null, state: null, note: null }] }, 'flight');
    for (const tab of ['details', 'work', 'files', 'history'] as const) {
      const p = render(PurchaseTaskPage, { task: view(), tabs: tabsOf(tab), files: { purchase: [] }, history: toTaskHistoryVM('error', 'purchase') });
      const f = render(FlightTaskPage, { task: flight, claimAction: async () => ({ ok: true as const, data: null, message: '' }) as never, tabs: tabsOf(tab), files: {}, history });
      for (const word of NEVER) {
        expect(withoutRules(p), `purchase ${tab} ${word}`).not.toMatch(word);
        expect(withoutRules(f), `flight ${tab} ${word}`).not.toMatch(word);
      }
    }
  });

  it('no tabs prop keeps the one long page (older callers)', () => {
    const html = render(PurchaseTaskPage, { task: view(), work: 'WORK-SLOT' });
    expect(html).not.toContain('Task sections');
    expect(html).toContain('Check-in');
    expect(html).toContain('WORK-SLOT');
  });

  it('branch Manager reads Purchase read-only (DA-272)', () => {
    const html = render(PurchaseTaskPage, { task: view({ status: 'in_progress', assigneeName: 'Synthetic Purchase Colleague' }), tabs: tabsOf('details'), managerReadOnly: true });
    expect(html).toContain('You can view this but not change it. Purchase in Delhi works on it.');
    expect(html).toContain('Synthetic Purchase Colleague works on this task');
  });
});

describe('DA-272 Next lines', () => {
  const base = { assignedToYou: false, assigneeName: null, canClaim: false } as const;
  it('names the next step for each state', () => {
    expect(taskNextText({ ...base, department: 'purchase', status: 'not_started', canClaim: true })).toBe('take this task');
    expect(taskNextText({ ...base, department: 'purchase', status: 'not_started' })).toBe('Purchase takes this task');
    expect(taskNextText({ ...base, department: 'visa', status: 'not_started' })).toBe('the Visa and passport desk takes this task');
    expect(taskNextText({ ...base, department: 'purchase', status: 'in_progress', assignedToYou: true })).toBe('record the supplier’s confirmation');
    expect(taskNextText({ ...base, department: 'visa', status: 'in_progress', assignedToYou: true })).toBe('finish the steps on the Work tab');
    expect(taskNextText({ ...base, department: 'flight', status: 'in_progress', assigneeName: 'Synthetic Flight Colleague' })).toBe('Synthetic Flight Colleague works on this task');
    expect(taskNextText({ ...base, department: 'flight', status: 'supplier_confirmed' })).toBe('Nothing waiting.');
    expect(taskNextText({ ...base, department: 'visa', status: 'completed' })).toBe('Nothing waiting.');
  });

  it('M14: a zero or missing budget is "Budget not set", never ₹0.00', () => {
    expect(budgetText('0')).toBe('Budget not set');
    expect(budgetText(null)).toBe('Budget not set');
    expect(budgetText('4500000')).toBe('₹45,000.00');
  });
});

describe('task History (DA-270, T-B4-05)', () => {
  const ev = (over: Partial<DepartmentTaskHistoryRecord['events'][number]>): DepartmentTaskHistoryRecord['events'][number] => ({
    at: '2026-10-03T06:00:00Z',
    kind: 'taken',
    byName: null,
    byYou: false,
    toName: null,
    toYou: false,
    applicantSeq: null,
    state: null,
    note: null,
    ...over,
  });
  const rec = (events: DepartmentTaskHistoryRecord['events']): DepartmentTaskHistoryRecord => ({ taskId: 't', department: 'purchase', truncated: false, events });

  it('names only "you" and people the database names; everyone else is "Another staff member"', () => {
    const vm = toTaskHistoryVM(rec([ev({ byYou: true }), ev({ byName: 'Synthetic Purchase Colleague' }), ev({}), ev({ kind: 'created' })]), 'purchase');
    expect(vm?.state).toBe('ok');
    const events = vm && vm.state === 'ok' ? vm.events : [];
    expect(events.map((e) => e.byText)).toEqual(['You', 'Synthetic Purchase Colleague', 'Another staff member', null]);
  });

  it('a failed read is never "no history"; a refused read has no tab', () => {
    expect(toTaskHistoryVM('error', 'purchase')).toEqual({ state: 'error' });
    expect(toTaskHistoryVM('not_installed', 'visa')).toEqual({ state: 'not_installed' });
    expect(toTaskHistoryVM(null, 'flight')).toBeNull();
    expect(TASK_HISTORY_TEXT.error).not.toMatch(/no history/i);
  });

  it('department words per kind, no amounts', () => {
    const vm = toTaskHistoryVM(rec([ev({ kind: 'supplier_confirmed' }), ev({ kind: 'cost_recorded' }), ev({ kind: 'applicant_stage', applicantSeq: 2, state: 'submitted' })]), 'flight');
    const titles = vm && vm.state === 'ok' ? vm.events.map((e) => e.title) : [];
    expect(titles).toEqual(['Confirmed by supplier', 'Cost recorded', 'Applicant 2: Submitted (reference recorded)']);
    for (const t of titles) expect(t).not.toMatch(/₹|\d{2,},\d/);
  });
});

describe('Visa desk launch is three-state (Unknown is not Off)', () => {
  const q = (launch: VisaQueueView['launch']): VisaQueueView => ({ launch, waitingCount: launch === 'off' ? 2 : null, tasks: [] });
  it('Off says the desk is not started; Unknown never does', () => {
    expect(render(VisaQueuePage, { queue: q('off') })).toContain('Not started yet');
    const unknown = render(VisaQueuePage, { queue: q('unknown') });
    expect(unknown).toContain('Desk state could not be read');
    expect(unknown).not.toContain('Not started yet');
    expect(unknown).not.toContain('Not launched yet');
    expect(render(VisaQueuePage, { queue: q('on') })).not.toMatch(/Not started yet|could not be read/);
  });
});
