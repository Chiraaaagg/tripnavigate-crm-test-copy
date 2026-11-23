/*
 * Types of the write-off screens (Accounts phase 3, contract 6.6, reads R-B1
 * small_balances_list, R-B2 write_off_monthly and the `writeOff` block of
 * deal_dues). The rows come from track B's DTOs in
 * `@/modules/write-offs/{contracts,dto}`; the page and filter shapes below are
 * the screen's own. Money is paise as decimal strings (never floats).
 */

import type { SmallBalancePreset } from '@/modules/write-offs/contracts';
import type { SmallBalanceRow } from '@/modules/write-offs/dto';

export {
  SMALL_BALANCE_PRESETS,
  WRITE_OFF_BLOCK_CODES,
  WRITE_OFF_DIRECTIONS,
  WRITE_OFF_STATUSES,
  type SmallBalancePreset,
  type WriteOffBlockCode,
  type WriteOffDirection,
  type WriteOffStatus,
} from '@/modules/write-offs/contracts';
export type { DuesWriteOff, SmallBalanceRow, SmallBalanceWriteOff, WriteOffMonthly } from '@/modules/write-offs/dto';

export interface SmallBalanceFilter {
  preset?: SmallBalancePreset;
  branchId?: string;
}

export interface SmallBalancePage {
  items: SmallBalanceRow[];
  /** Keyset cursor `(trip_end, deal_id)` as the server encodes it; null = that is all. */
  nextAfter: string | null;
  hasMore: boolean;
}

/** Who reads the small balances screen (contract 14: Accounts and the branch Manager only). */
export type SmallBalancesViewer = { kind: 'accounts'; entityName: string } | { kind: 'manager'; branchNames: string[] };

/** Form field names the server actions read (Addendum L3 shape; hidden binding values in paise). */
export const WO_FIELD = {
  dealId: 'dealId',
  writeOffId: 'writeOffId',
  direction: 'direction',
  amountPaise: 'amountPaise',
  expectedAmountPaise: 'expectedAmountPaise',
  expectedRowVersion: 'expectedRowVersion',
  decision: 'decision',
  reason: 'reason',
} as const;
