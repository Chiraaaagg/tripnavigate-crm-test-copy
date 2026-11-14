import type { DuesWriteOff, SmallBalancePage, SmallBalanceRow, WriteOffMonthly } from '@/views/write-offs/types';

/*
 * Synthetic fixtures for the write-off preview states (acc3-writeoffs-).
 * SYN- Deals, invented names and amounts; nothing here is real.
 */

const LIMIT = '500000';
const can = (over: Partial<SmallBalanceRow['can']> = {}): SmallBalanceRow['can'] => ({ propose: false, approve: false, return: false, withdraw: false, undo: false, ...over });
const id = (n: number) => `a0003${String(100 + n)}-0000-4000-8000-000000003${String(100 + n)}`;

function row(n: number, over: Partial<SmallBalanceRow>): SmallBalanceRow {
  return {
    dealId: id(n),
    dealReference: `SYN-JOD-${300 + n}`,
    branchName: 'Jodhpur',
    tripEnd: '2026-10-28',
    direction: 'due',
    balancePaise: '30000',
    limitPaise: LIMIT,
    writeOff: null,
    blockedBy: [],
    can: can(),
    ...over,
  };
}

/** Accounts view: a mix of proposable, blocked, proposed and approved rows. */
export const ACCOUNTS_ROWS: SmallBalanceRow[] = [
  row(1, { balancePaise: '300', can: can({ propose: true }) }),
  row(2, { direction: 'excess', balancePaise: '125000', tripEnd: '2026-10-21', can: can({ propose: true }) }),
  row(3, { branchName: 'Delhi', dealReference: 'SYN-DEL-303 (long family reunion trip with two extra rooms)', balancePaise: '48000', blockedBy: ['refund_open', 'receipt_unverified'], can: can({ propose: true }) }),
  row(4, {
    balancePaise: '72000',
    writeOff: { id: id(41), refNo: 'WO-2026-000014', status: 'proposed', amountPaise: '72000', reason: 'Bank charges deducted by the customer’s bank; not worth chasing.', proposedByName: 'Synthetic Accounts 1', rowVersion: 1 },
    can: can({ withdraw: true }),
  }),
  row(5, {
    direction: 'excess',
    balancePaise: '0',
    tripEnd: '2026-10-02',
    writeOff: { id: id(51), refNo: 'WO-2026-000009', status: 'approved', amountPaise: '15000', reason: 'Customer rounded the last payment up; kept as agreed.', proposedByName: 'Synthetic Accounts 2', rowVersion: 2 },
  }),
  row(6, {
    balancePaise: '20000',
    tripEnd: '2026-09-30',
    writeOff: { id: id(61), refNo: 'WO-2026-000006', status: 'approved', amountPaise: '10000', reason: 'Small difference after the final hotel bill.', proposedByName: 'Synthetic Accounts 1', rowVersion: 2 },
  }),
];

export const ACCOUNTS_PAGE: SmallBalancePage = { items: ACCOUNTS_ROWS, nextAfter: '2026-09-30|a0003106-0000-4000-8000-000000003106', hasMore: true };

/** Manager view (approve / return / undo). */
export const MANAGER_ROWS: SmallBalanceRow[] = [
  { ...ACCOUNTS_ROWS[3]!, can: can({ approve: true, return: true }) },
  { ...ACCOUNTS_ROWS[4]!, can: can({ undo: true }) },
  { ...ACCOUNTS_ROWS[5]!, can: can({ undo: true }) },
  { ...ACCOUNTS_ROWS[0]!, can: can() },
];
export const MANAGER_PAGE: SmallBalancePage = { items: MANAGER_ROWS, nextAfter: null, hasMore: false };

/** Approvals tab: proposed write-offs of the Manager's branches. */
export const TO_APPROVE_PAGE: SmallBalancePage = {
  items: [
    MANAGER_ROWS[0]!,
    {
      ...row(7, { direction: 'excess', balancePaise: '9900', branchName: 'Jodhpur' }),
      writeOff: { id: id(71), refNo: 'WO-2026-000015', status: 'proposed', amountPaise: '9900', reason: 'Overpaid ₹99 by mistake; customer said to keep it.', proposedByName: 'Synthetic Accounts 2', rowVersion: 1 },
      can: can({ approve: true, return: true }),
    },
  ],
  nextAfter: null,
  hasMore: false,
};

export const MONTHLY: WriteOffMonthly = {
  month: '2026-11-01',
  branches: [
    { branchName: 'Jodhpur', count: 4, duePaise: '182000', excessPaise: '25000' },
    { branchName: 'Delhi', count: 2, duePaise: '61000', excessPaise: '0' },
    { branchName: 'Ahmedabad', count: 1, duePaise: '0', excessPaise: '9900' },
  ],
};

export const DUES_APPROVED: DuesWriteOff = {
  refNo: 'WO-2026-000009',
  direction: 'due',
  amountPaise: '30000',
  status: 'approved',
  reason: 'Bank charges deducted by the customer’s bank; not worth chasing.',
  proposedByName: 'Synthetic Accounts 1',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-10T07:15:00Z',
};
export const DUES_PROPOSED: DuesWriteOff = { ...DUES_APPROVED, status: 'proposed', decidedByName: null, decidedAt: null };
export const DUES_EXCESS: DuesWriteOff = { ...DUES_APPROVED, direction: 'excess', amountPaise: '15000', reason: 'Customer rounded the last payment up; kept as agreed.' };
