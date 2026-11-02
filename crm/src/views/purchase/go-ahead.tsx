import { CircleCheck, CircleX, Hourglass, RefreshCw, Send } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { GO_AHEAD_STATE_LABEL, type GoAheadState } from '@/modules/procurement/contracts';

/*
 * Accounts go-ahead for hotel commitments (owner decision 1, 2 Nov 2026).
 * Purchase's "Send booking request" also asks Accounts; Accounts approves or
 * returns it. Validity is computed by the database (state below); this file
 * only names the state with an icon and words (never colour alone).
 */

export type { GoAheadState };

/** Frozen wording from the procurement contract. */
export const GO_AHEAD_LABEL = GO_AHEAD_STATE_LABEL;

/** One short sentence for the Work tab and the queue's screen-reader text. */
export const GO_AHEAD_HELP: Record<GoAheadState, string> = {
  not_needed: 'Transfers and activities need no Accounts go-ahead.',
  not_requested: 'Accounts is asked when you send the booking request. Rates, the final rate and files can be added before.',
  pending: 'Accounts approves every hotel commitment. You can record the supplier’s confirmation once Accounts gives the go-ahead.',
  approved: 'Accounts approved this hotel commitment for the current booking and final rate.',
  returned: 'Accounts returned the go-ahead. Read the reason, fix it, then send the booking request again.',
  stale: 'The booking or the final rate changed after the go-ahead. Send the booking request again to ask Accounts.',
};

/** Reads `goAheadState` from a list row when the database sends it; older rows have none. */
export function goAheadOf(row: object): GoAheadState | null {
  const v = (row as { goAheadState?: unknown }).goAheadState;
  return typeof v === 'string' && v in GO_AHEAD_LABEL ? (v as GoAheadState) : null;
}

export function GoAheadBadge({ state, compact = false }: { state: GoAheadState | null | undefined; compact?: boolean }) {
  // The queue shows only states that need someone's attention; the task header shows every hotel state.
  if (!state || state === 'not_needed' || (compact && state === 'not_requested')) return null;
  const look =
    state === 'approved'
      ? { tone: 'success' as const, icon: CircleCheck }
      : state === 'pending'
        ? { tone: 'warning' as const, icon: Hourglass }
        : state === 'returned'
          ? { tone: 'danger' as const, icon: CircleX }
          : state === 'stale'
            ? { tone: 'warning' as const, icon: RefreshCw }
            : { tone: 'neutral' as const, icon: Send };
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Accounts: </span>
      {GO_AHEAD_LABEL[state]}
    </StatusBadge>
  );
}
