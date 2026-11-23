import type { DuesStatus, InstalmentStatus } from './contracts';

/**
 * Pure mirror of the dues rules (contract 4.4) for unit tests and display.
 * The database (authz.dues_compute, 20261203000240) is the authority; this
 * never decides what a customer owes. BigInt paise only, no floats.
 *
 * - Money M = the customer_advances journal balance (verified receipts,
 *   cleared cheques, minus reversals). Allocation uses max(M, 0).
 * - Instalments are covered oldest due first (due date, then seq).
 * - Reported claims and receipts awaiting verification are never money.
 */

export interface DuesInstalmentInput {
  seq: number;
  dueDate: string;
  amountPaise: string;
}

export interface DuesInput {
  totalPaise: string;
  moneyPaise: string;
  instalments: DuesInstalmentInput[];
  /** YYYY-MM-DD in IST. */
  today: string;
}

export interface DuesInstalmentResult {
  seq: number;
  dueDate: string;
  amountPaise: string;
  coveredPaise: string;
  openPaise: string;
  status: InstalmentStatus;
  partlyPaid: boolean;
}

export interface DuesResult {
  status: DuesStatus;
  balancePaise: string;
  creditPaise: string;
  overduePaise: string;
  dueNowPaise: string;
  nextDue: { date: string; openPaise: string } | null;
  instalments: DuesInstalmentResult[];
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function computeDues(input: DuesInput): DuesResult {
  const total = BigInt(input.totalPaise);
  const m = max(BigInt(input.moneyPaise), 0n);
  const ordered = [...input.instalments].sort((a, b) => (a.dueDate === b.dueDate ? a.seq - b.seq : a.dueDate < b.dueDate ? -1 : 1));
  let before = 0n;
  let overdue = 0n;
  let dueNow = 0n;
  let nextDue: DuesResult['nextDue'] = null;
  const instalments = ordered.map((i) => {
    const amount = BigInt(i.amountPaise);
    const covered = min(amount, max(m - before, 0n));
    before += amount;
    const open = amount - covered;
    const status: InstalmentStatus =
      open === 0n ? 'paid' : i.dueDate < input.today ? 'overdue' : i.dueDate === input.today ? 'due_now' : 'upcoming';
    if (status === 'overdue') overdue += open;
    if (status === 'due_now') dueNow += open;
    if (open > 0n && !nextDue) nextDue = { date: i.dueDate, openPaise: open.toString() };
    return {
      seq: i.seq,
      dueDate: i.dueDate,
      amountPaise: amount.toString(),
      coveredPaise: covered.toString(),
      openPaise: open.toString(),
      status,
      partlyPaid: covered > 0n && open > 0n,
    };
  });
  const balance = total - min(m, total);
  const credit = max(m - total, 0n);
  const hasPlan = instalments.length > 0;
  const status: DuesStatus =
    m > total ? 'credit'
    : overdue > 0n ? 'overdue'
    : dueNow > 0n ? 'due_now'
    : !hasPlan && m > 0n && m < total ? 'unallocated'
    : !hasPlan && m === 0n && total > 0n ? 'no_plan'
    : balance > 0n ? 'upcoming'
    : 'paid';
  return {
    status,
    balancePaise: balance.toString(),
    creditPaise: credit.toString(),
    overduePaise: overdue.toString(),
    dueNowPaise: dueNow.toString(),
    nextDue,
    instalments,
  };
}

/** Sort rank of the dues list (overdue first, paid last). */
export const DUES_STATUS_RANK: Record<DuesStatus, number> = {
  overdue: 1,
  due_now: 2,
  upcoming: 3,
  unallocated: 4,
  no_plan: 5,
  credit: 6,
  paid: 7,
};
