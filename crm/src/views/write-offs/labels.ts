import type { StatusTone } from '@/components/ui/badge';
import { dayText, inr } from '@/views/accounts-desk/labels';
import type { DuesWriteOff, SmallBalanceFilter, SmallBalancePreset, SmallBalanceRow, WriteOffBlockCode, WriteOffDirection, WriteOffStatus } from './types';

/*
 * Words for the write-off screens (Accounts phase 3, contract 6.6, 13, 15
 * screen 6). Pure, unit-tested (tests/unit/acc3u-writeoffs-labels.test.ts).
 * Status always shows an icon plus these words, never colour alone. Refusal
 * messages are track B's frozen texts (contract 13); the server actions
 * return them and the screens show them as given (copies here are for the
 * preview gallery only).
 */

export const SMALL_BALANCES_PATH = '/app/accounts/small-balances';
export const WRITE_OFF_MONTHLY_PATH = '/app/accounts/small-balances/monthly';

export const DIRECTION_WORDS: Record<WriteOffDirection, { title: string; balance: string; effect: string }> = {
  due: { title: 'Customer still owes', balance: 'Balance due', effect: 'The customer no longer owes it. Dues become zero.' },
  excess: { title: 'Customer overpaid', balance: 'Credit (overpaid)', effect: 'The company keeps it. The credit becomes zero and it can never be refunded.' },
};

export const STATUS_WORDS: Record<WriteOffStatus, { word: string; tone: StatusTone }> = {
  proposed: { word: 'Waiting for Manager approval', tone: 'info' },
  approved: { word: 'Written off', tone: 'success' },
  returned: { word: 'Returned by the Manager', tone: 'warning' },
  withdrawn: { word: 'Withdrawn', tone: 'neutral' },
  undone: { word: 'Undone', tone: 'neutral' },
};

export const BLOCK_WORDS: Record<WriteOffBlockCode, string> = {
  write_off_off: 'Write-offs are not switched on yet.',
  trip_not_ended: 'The trip has not ended yet.',
  refund_open: 'A refund request is still open on this Deal.',
  cancellation_open: 'A trip cancellation is not approved yet.',
  change_open: 'A booking change is still in progress.',
  receipt_unverified: 'A payment is reported or not yet verified.',
  shortfall: 'Money held is below zero. Fix the money first.',
  over_limit: 'More than the write-off limit for one Deal.',
};

export const PRESET_WORDS: Record<SmallBalancePreset, { label: string; empty: string }> = {
  to_propose: { label: 'To propose', empty: 'No small balances are waiting for a write-off.' },
  to_approve: { label: 'To approve', empty: 'No write-offs are waiting for approval.' },
  needs_review: { label: 'Needs review', empty: 'No written-off Deal has a balance again.' },
};

/** Frozen refusal texts (contract 13) for the preview gallery. */
export const WRITE_OFF_REFUSAL = {
  write_off_off: 'Write-offs are not switched on yet.',
  write_off_over_limit: 'This is more than the write-off limit for one Deal.',
  write_off_not_balance: 'A write-off must be the whole remaining balance.',
  write_off_open_exists: 'This Deal already has a write-off.',
  not_self_approval: 'You cannot approve your own request.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
} as const;

/** One plain line for a block code (unknown codes from a newer server get a generic line). */
export function blockText(code: string): string {
  return (BLOCK_WORDS as Record<string, string>)[code] ?? 'Something on this Deal stops a write-off now.';
}

/** Short reason the propose button is not usable (first block wins), or null when it can be pressed. */
export function proposeBlockedReason(row: SmallBalanceRow): string | null {
  if (row.writeOff && (row.writeOff.status === 'proposed' || row.writeOff.status === 'approved')) return 'This Deal already has a write-off.';
  if (row.blockedBy.length > 0) return blockText(row.blockedBy[0]!);
  if (BigInt(row.balancePaise) <= 0n) return 'Nothing is left to write off.';
  if (BigInt(row.balancePaise) > BigInt(row.limitPaise)) return blockText('over_limit');
  if (!row.can.propose) return 'Only Accounts propose write-offs.';
  return null;
}

/** "Written off ₹30.00 by Synthetic Manager on 12 Nov 2026 — reason" (the dues line, contract 15 screen 6). */
export function duesWriteOffLine(w: DuesWriteOff): string {
  const amount = inr(w.amountPaise);
  if (w.status === 'proposed') return `Write-off of ${amount} proposed${w.proposedByName ? ` by ${w.proposedByName}` : ''} — waiting for the Manager — ${w.reason}`;
  const verb = w.status === 'approved' ? (w.direction === 'due' ? 'Written off' : 'Overpayment kept') : STATUS_WORDS[w.status].word;
  const by = w.decidedByName ? ` by ${w.decidedByName}` : '';
  const on = w.decidedAt ? ` on ${dayText(w.decidedAt)}` : '';
  return `${verb} ${amount}${by}${on} — ${w.reason}`;
}

/** Address of the small balances list with a preset, branch and keyset cursor. */
export function smallBalancesHref(filter: SmallBalanceFilter, after?: string | null): string {
  const q = new URLSearchParams();
  if (filter.preset) q.set('preset', filter.preset);
  if (filter.branchId) q.set('branch', filter.branchId);
  if (after) q.set('after', after);
  const s = q.toString();
  return s ? `${SMALL_BALANCES_PATH}?${s}` : SMALL_BALANCES_PATH;
}

/** Parses the list address back (unknown values dropped). */
export function parseSmallBalancesQuery(params: Record<string, string | string[] | undefined>): { filter: SmallBalanceFilter; after: string | null } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const preset = one(params.preset);
  const branch = one(params.branch);
  const after = one(params.after);
  return {
    filter: {
      preset: (['to_propose', 'to_approve', 'needs_review'] as string[]).includes(preset) ? (preset as SmallBalancePreset) : undefined,
      branchId: /^[0-9a-f-]{36}$/i.test(branch) ? branch : undefined,
    },
    after: after && after.length <= 200 ? after : null,
  };
}

/** Month totals for the footer row (paise strings, BigInt sums). */
export function monthlyTotal(branches: Array<{ count: number; duePaise: string; excessPaise: string }>): { count: number; duePaise: string; excessPaise: string } {
  let count = 0;
  let due = 0n;
  let excess = 0n;
  for (const b of branches) {
    count += b.count;
    due += BigInt(b.duePaise);
    excess += BigInt(b.excessPaise);
  }
  return { count, duePaise: due.toString(), excessPaise: excess.toString() };
}

/** "November 2026" from YYYY-MM-01. */
export function monthText(month: string): string {
  const t = Date.parse(`${month.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(t) ? month : new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(t);
}

/** The month before / after YYYY-MM-01 (for the monthly totals pager). */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
