import { describe, expect, it } from 'vitest';
import { computeDues } from '@/modules/accounts-desk/dues';
import { detectReferenceType, recordsFilterFromParams, recordsFilterToParams } from '@/modules/accounts-desk/filters';
import { PROVISIONAL_TEXT, basisLine } from '@/modules/accounts-desk/status';

/** Accounts phase contract 4.4 (dues mirror), 8.1 (filters, exact search), Lead decision AL3; test plan 12.5, Track E. */

const TODAY = '2026-11-10';
const plan = [
  { seq: 1, dueDate: '2026-11-07', amountPaise: '3000000' },
  { seq: 2, dueDate: TODAY, amountPaise: '3000000' },
  { seq: 3, dueDate: '2026-11-20', amountPaise: '3123457' },
];

describe('4.4 dues mirror', () => {
  it('no money: overdue first; open sums', () => {
    const d = computeDues({ totalPaise: '9123457', moneyPaise: '0', instalments: plan, today: TODAY });
    expect(d).toMatchObject({ status: 'overdue', balancePaise: '9123457', overduePaise: '3000000', dueNowPaise: '3000000', creditPaise: '0',
      nextDue: { date: '2026-11-07', openPaise: '3000000' } });
    expect(d.instalments.map((i) => i.status)).toEqual(['overdue', 'due_now', 'upcoming']);
  });
  it('oldest due first; partly paid; due_now', () => {
    const d = computeDues({ totalPaise: '9123457', moneyPaise: '4000000', instalments: plan, today: TODAY });
    expect(d.instalments.map((i) => [i.coveredPaise, i.openPaise, i.partlyPaid])).toEqual([['3000000', '0', false], ['1000000', '2000000', true],
      ['0', '3123457', false]]);
    expect(d.status).toBe('due_now');
  });
  it('the day after the due date is overdue (H5); due date today is due_now; order by due date then seq', () => {
    const d = computeDues({ totalPaise: '200', moneyPaise: '0', today: TODAY, instalments: [
      { seq: 2, dueDate: TODAY, amountPaise: '100' }, { seq: 1, dueDate: '2026-11-09', amountPaise: '100' }] });
    expect(d.instalments.map((i) => [i.seq, i.status])).toEqual([[1, 'overdue'], [2, 'due_now']]);
  });
  it('paid, credit, upcoming, no_plan, unallocated; negative money allocates nothing', () => {
    expect(computeDues({ totalPaise: '9123457', moneyPaise: '9123457', instalments: plan, today: TODAY })).toMatchObject({ status: 'paid', balancePaise: '0', nextDue: null });
    expect(computeDues({ totalPaise: '9123457', moneyPaise: '9223457', instalments: plan, today: TODAY })).toMatchObject({ status: 'credit', creditPaise: '100000' });
    expect(computeDues({ totalPaise: '100', moneyPaise: '0', today: TODAY, instalments: [{ seq: 1, dueDate: '2026-12-01', amountPaise: '100' }] }).status).toBe('upcoming');
    expect(computeDues({ totalPaise: '100', moneyPaise: '0', instalments: [], today: TODAY }).status).toBe('no_plan');
    expect(computeDues({ totalPaise: '100', moneyPaise: '40', instalments: [], today: TODAY })).toMatchObject({ status: 'unallocated', balancePaise: '60' });
    expect(computeDues({ totalPaise: '9123457', moneyPaise: '-500', instalments: plan, today: TODAY }).instalments[0]!.coveredPaise).toBe('0');
  });
  it('whole paise with bigint: no float drift on large values', () => {
    const d = computeDues({ totalPaise: '123456789012345', moneyPaise: '123456789012344', instalments: [], today: TODAY });
    expect(d.balancePaise).toBe('1');
  });
});

describe('AL3 provisional label', () => {
  it('awaiting_review says "Provisional — booking not yet approved by Accounts"', () => {
    expect(PROVISIONAL_TEXT).toBe('Provisional — booking not yet approved by Accounts');
    expect(basisLine({ versionNo: 1, kind: 'awaiting_review', newerVersionPending: false } as never)).toContain(PROVISIONAL_TEXT);
    expect(basisLine({ versionNo: 2, kind: 'approved', newerVersionPending: true } as never)).toMatch(/version 2/i);
  });
});

describe('8.1 filters and reference detection', () => {
  it('URL params round trip keeps only allowlisted keys', () => {
    const params = new URLSearchParams('kinds=receipt&kinds=supplier_invoice&tallyStatus=ready&q=R-2026-27-000001&colour=red&branchId=x');
    const f = recordsFilterFromParams(params as never);
    expect(Object.keys(f)).not.toContain('colour');
    const back = recordsFilterToParams(f);
    expect(back.get('colour')).toBeNull();
    expect(recordsFilterFromParams(back as never)).toEqual(f);
  });
  it.each([
    ['R-2026-27-000001', 'receipt'], ['sp-2026-000123', 'supplier_payment'], ['BX-123456', 'deal'], ['176-2410394501', 'ticket_number'],
    ['Q001XA', 'pnr'], ['SYN/INV-001', 'document_or_reference'], ['  ', 'empty'],
  ])('%s -> %s', (q, type) => {
    expect(detectReferenceType(q)).toBe(type);
  });
});
