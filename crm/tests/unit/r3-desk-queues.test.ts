import { describe, expect, it } from 'vitest';
import { deskQueueHref, deskToolbarKeep, matchesSearch, parseQueueSearch, parseQueueShow, parseQueueSort, sortQueue } from '@/views/department/queue-show';
import { filterGroups, flightQueueModel, flightRowNext, parseQueueOnly } from '@/views/flight/queue';
import type { FlightQueueGroup, FlightStatus } from '@/views/flight/types';
import { parseVisaQueueOnly, visaQueueModel, visaRowNext } from '@/views/visa/queue';
import type { VisaQueueTask, VisaQueueView } from '@/views/visa/types';

/**
 * UX redesign R3 (C2): the Flight and Visa queues' search, filter chips and
 * sort are pure functions over the rows the database already returned. Old
 * addresses (`?show=`, Home's `?show=mine&only=…`) keep giving the same rows,
 * and the row button only appears for the person who can act.
 */

const st = (code: FlightStatus['code'], confirmed = 0, required = 0): FlightStatus => ({ code, text: code, confirmed, required });
const noChips = { bookingChanged: false, unnamed: 0, changesWaiting: 0, faresWaiting: false, paymentNeeded: false };

function group(ref: string, over: Partial<FlightQueueGroup> = {}): FlightQueueGroup {
  return {
    dealId: `deal-${ref}`,
    dealReference: ref,
    branchName: 'Jodhpur',
    status: st('waiting'),
    assigneeName: null,
    assignedToYou: false,
    canTake: true,
    firstDate: null,
    chips: noChips,
    budgetPaise: null,
    flights: [{ taskId: `t-${ref}`, itemNo: 1, title: 'JDH → DEL', route: 'JDH → DEL', firstDate: null, status: st('waiting'), entryMode: 'typed' }],
    ...over,
  };
}

const dated = (ref: string, date: string | null, over: Partial<FlightQueueGroup> = {}) =>
  group(ref, { firstDate: date, flights: [{ taskId: `t-${ref}`, itemNo: 1, title: 'JDH → GOI', route: 'JDH → GOI', firstDate: date, status: st('waiting'), entryMode: 'typed' }], ...over });

const GROUPS: FlightQueueGroup[] = [
  dated('SYN-3', '2026-12-01'),
  dated('SYN-1', '2026-11-20', { assigneeName: 'Me', assignedToYou: true, canTake: false, status: st('in_progress', 1, 3), readyToFinish: true }),
  dated('SYN-2', null, { assigneeName: 'Colleague', canTake: false, status: st('in_progress'), chips: { ...noChips, paymentNeeded: true } }),
  dated('SYN-4', '2026-11-10', { assigneeName: 'Me', assignedToYou: true, canTake: false, status: st('done') }),
  dated('SYN-5', '2026-11-15', { assigneeName: 'Me', assignedToYou: true, canTake: false, status: st('in_progress'), chips: { ...noChips, bookingChanged: true } }),
];

const refs = (rows: Array<{ dealReference: string }>) => rows.map((r) => r.dealReference);

describe('address parsing', () => {
  it('sort: allowlist, first value, default soonest', () => {
    expect(parseQueueSort(undefined)).toBe('soonest');
    expect(parseQueueSort('latest')).toBe('latest');
    expect(parseQueueSort(['deal', 'latest'])).toBe('deal');
    expect(parseQueueSort('LATEST')).toBe('soonest');
    expect(parseQueueSort('price')).toBe('soonest');
  });

  it('search: first value, trimmed, at most 100 characters', () => {
    expect(parseQueueSearch(undefined)).toBe('');
    expect(parseQueueSearch('  goa  ')).toBe('goa');
    expect(parseQueueSearch(['a', 'b'])).toBe('a');
    expect(parseQueueSearch('x'.repeat(150))).toHaveLength(100);
  });

  it('chips: flight and visa allowlists, unknown is none', () => {
    expect(parseQueueOnly('ready')).toBe('ready');
    expect(parseQueueOnly('booking_changed')).toBe('booking_changed');
    expect(parseQueueOnly('nope')).toBeNull();
    expect(parseQueueOnly(undefined)).toBeNull();
    expect(parseVisaQueueOnly('decision')).toBe('decision');
    expect(parseVisaQueueOnly('completed')).toBe('completed');
    expect(parseVisaQueueOnly('ready ')).toBeNull();
  });
});

describe('search and sort helpers', () => {
  it('every word must appear, case-insensitive; empty search matches all', () => {
    expect(matchesSearch('goi jod', ['SYN-JOD-901', 'JDH → GOI'])).toBe(true);
    expect(matchesSearch('goi delhi', ['SYN-JOD-901', 'JDH → GOI'])).toBe(false);
    expect(matchesSearch('', [null, undefined])).toBe(true);
  });

  it('travel sort puts dateless rows last both ways and breaks ties by Deal reference', () => {
    const rows = [
      { ref: 'B', d: '2026-11-02' },
      { ref: 'A', d: null },
      { ref: 'C', d: '2026-11-01' },
      { ref: 'A2', d: '2026-11-02' },
    ];
    const by = (s: 'soonest' | 'latest' | 'deal') => sortQueue(rows, s, (r) => r.d, (r) => r.ref).map((r) => r.ref);
    expect(by('soonest')).toEqual(['C', 'A2', 'B', 'A']);
    expect(by('latest')).toEqual(['A2', 'B', 'C', 'A']);
    expect(by('deal')).toEqual(['A', 'A2', 'B', 'C']);
    expect(rows[0]!.ref).toBe('B');
  });

  it('hrefs leave defaults out and keep Home links exactly as before', () => {
    expect(deskQueueHref('/app/flight', true, { show: 'not_taken' })).toBe('/app/flight');
    expect(deskQueueHref('/app/flight', true, { show: 'mine', only: 'ready' })).toBe('/app/flight?show=mine&only=ready');
    expect(deskQueueHref('/app/flight', true, { show: 'mine', only: 'booking_changed' })).toBe('/app/flight?show=mine&only=booking_changed');
    expect(deskQueueHref('/app/flight', true, { show: 'all', q: 'goa trip', sort: 'latest' })).toBe('/app/flight?show=all&q=goa+trip&sort=latest');
    expect(deskQueueHref('/app/visa', false, { show: 'all', sort: 'soonest' })).toBe('/app/visa');
    expect(deskToolbarKeep(true, { show: 'mine', only: 'ready', q: 'x' })).toEqual({ show: 'mine', only: 'ready' });
    expect(deskToolbarKeep(true, { show: 'not_taken' })).toBeUndefined();
  });
});

describe('Flight queue model', () => {
  it('old ?show= addresses give the same rows as before (tab filter unchanged)', () => {
    for (const show of ['not_taken', 'mine', 'all'] as const) {
      const m = flightQueueModel(GROUPS, { canTakeTasks: true, show });
      expect(new Set(refs(m.rows))).toEqual(new Set(refs(filterGroups(GROUPS, show))));
    }
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: parseQueueShow(undefined, true) }).rows)).toEqual(refs(filterGroups(GROUPS, parseQueueShow(undefined, true))));
  });

  it("Home's ?show=mine&only=… rows are the same as before", () => {
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'mine', only: 'ready' }).rows)).toEqual(['SYN-1']);
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'mine', only: 'booking_changed' }).rows)).toEqual(['SYN-5']);
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'mine', only: 'payment' }).rows)).toEqual([]);
  });

  it('a branch Manager has no tabs: every row, any ?show=', () => {
    const m = flightQueueModel(GROUPS, { canTakeTasks: false, show: 'mine' });
    expect(m.current).toBe('all');
    expect(m.rows).toHaveLength(GROUPS.length);
  });

  it('tab, then search, then chip, then sort; counts per tab and per chip', () => {
    const m = flightQueueModel(GROUPS, { canTakeTasks: true, show: 'all', q: 'syn', only: 'payment', sort: 'latest' });
    // `?only=` narrows Mine only, as before R3 (review P3-5): on All it is ignored.
    expect(m.only).toBeNull();
    expect(refs(m.rows)).toEqual(['SYN-3', 'SYN-1', 'SYN-5', 'SYN-4', 'SYN-2']);
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'not_taken', only: 'ready' }).rows)).toEqual(['SYN-3']);
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'mine', q: 'syn', only: 'booking_changed', sort: 'latest' }).rows)).toEqual(['SYN-5']);
    expect(m.tabRows).toHaveLength(5);
    expect(m.counts).toEqual({ not_taken: 1, mine: 2, all: 5 });
    expect(m.chipCounts).toEqual({ booking_changed: 1, payment: 1, change_decision: 0, ready: 1 });
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'all' }).rows)).toEqual(['SYN-4', 'SYN-5', 'SYN-1', 'SYN-3', 'SYN-2']);
    expect(refs(flightQueueModel(GROUPS, { canTakeTasks: true, show: 'all', q: 'colleague' }).rows)).toEqual(['SYN-2']);
  });

  it('row button only for the person who can act', () => {
    const [notTaken, mine, colleague, done, changed] = GROUPS;
    expect(flightRowNext(notTaken!).button?.label).toBe('Review and take');
    expect(flightRowNext({ ...notTaken!, canTake: false }).button).toBeUndefined();
    expect(flightRowNext(mine!)).toEqual({ text: 'Mark the flights done', button: { label: 'Continue', href: '/app/flight/deals/deal-SYN-1?tab=work' } });
    expect(flightRowNext(colleague!)).toEqual({ text: 'Colleague works on these flights' });
    expect(flightRowNext(done!)).toEqual({ text: 'Nothing waiting' });
    expect(flightRowNext(changed!).text).toBe('Review the booking change Sales sent');
  });
});

function visaTask(ref: string, over: Partial<VisaQueueTask> = {}): VisaQueueTask {
  return {
    taskId: `v-${ref}`,
    serviceType: 'visa',
    dealReference: ref,
    branchName: 'Jodhpur',
    title: 'France · Tourism',
    factsLine: 'France · Tourism',
    travelDate: null,
    status: { code: 'not_taken', step: null, text: 'Not taken' },
    applicantCount: 2,
    readyCount: 0,
    appliedCount: 0,
    decidedCount: 0,
    closedCount: 0,
    assigneeName: null,
    assignedToYou: false,
    createdAt: '2026-11-01T09:00:00Z',
    canTake: true,
    isManagerView: false,
    ...over,
  } as VisaQueueTask;
}

const VQ: VisaQueueView = {
  isManagerView: false,
  canTake: true,
  launch: 'on',
  waitingCount: null,
  tasks: [
    visaTask('V-1', { travelDate: '2027-02-06', assigneeName: 'Me', assignedToYou: true, canTake: false, status: { code: 'in_progress', step: 'ready', text: 'Documents and date pending' } }),
    visaTask('V-2', { travelDate: '2026-11-20', title: 'United Arab Emirates · Tourism' }),
    visaTask('V-3', { serviceType: 'passport', title: 'Fresh passport', assigneeName: 'Colleague', canTake: false, status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' } }),
    visaTask('V-4', { travelDate: '2026-11-01', assigneeName: 'Me', assignedToYou: true, canTake: false, status: { code: 'completed', step: null, text: 'Completed' } }),
  ],
} as VisaQueueView;

describe('Visa queue model', () => {
  it('old ?show= addresses give the same rows; default sort is soonest travel', () => {
    expect(refs(visaQueueModel(VQ, { show: 'not_taken' }).rows)).toEqual(['V-2']);
    expect(refs(visaQueueModel(VQ, { show: 'mine' }).rows)).toEqual(['V-4', 'V-1']);
    expect(refs(visaQueueModel(VQ, { show: 'all' }).rows)).toEqual(['V-4', 'V-2', 'V-1', 'V-3']);
  });

  it('chips by open step or completed; search over kind, title, Deal and colleague', () => {
    expect(refs(visaQueueModel(VQ, { show: 'all', only: 'decision' }).rows)).toEqual(['V-3']);
    expect(refs(visaQueueModel(VQ, { show: 'all', only: 'completed' }).rows)).toEqual(['V-4']);
    expect(refs(visaQueueModel(VQ, { show: 'all', q: 'passport' }).rows)).toEqual(['V-3']);
    expect(refs(visaQueueModel(VQ, { show: 'all', q: 'emirates' }).rows)).toEqual(['V-2']);
    expect(visaQueueModel(VQ, { show: 'all' }).chipCounts).toEqual({ ready: 1, applied: 0, decision: 1, handover: 0, completed: 1 });
  });

  it('a Manager-only viewer never lands on Mine and never gets a row button', () => {
    const manager = { ...VQ, isManagerView: true, canTake: false, tasks: VQ.tasks.map((t) => ({ ...t, assignedToYou: false, canTake: false, isManagerView: true })) } as VisaQueueView;
    const m = visaQueueModel(manager, { show: 'mine' });
    expect(m.canTake).toBe(false);
    expect(m.current).toBe('all');
    for (const t of manager.tasks) expect(visaRowNext(t).button).toBeUndefined();
  });

  it('row next step and button', () => {
    const [mine, open, colleague, done] = VQ.tasks;
    expect(visaRowNext(mine!)).toEqual({ text: 'Receive each passenger’s documents and set the appointment date', button: { label: 'Continue', href: '/app/visa/v-V-1?tab=work' } });
    expect(visaRowNext(open!).button).toEqual({ label: 'Review and take', href: '/app/visa/v-V-2', primary: true });
    expect(visaRowNext(colleague!)).toEqual({ text: 'Colleague works on this task' });
    expect(visaRowNext(done!)).toEqual({ text: 'Nothing waiting' });
  });
});
