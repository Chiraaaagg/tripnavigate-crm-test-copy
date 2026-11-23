import { Notice } from '@/components/ui/notice';
import { inr } from './supplier-kit';

/** How a cost's quote compares with the active rate contract (rate-contracts 9.3; additive read keys). */
export type ContractCompareState = 'none' | 'matches' | 'differs' | 'ended';

export interface ContractCompareRow {
  amountPaise: string;
  contractState?: ContractCompareState;
  contractTotalPaise?: string | null;
  contractDeviationReason?: string | null;
}

/**
 * Accounts phase 3 (contract 9.3, 16.4 item 6, Addendum L2): before approving
 * a cost above budget (Manager) or a go-ahead (Accounts), the approver sees
 * when the quote differs from the active rate contract, the contract total
 * and Purchase's reason. Nothing shows when no contract applied.
 */
export function CostContractNotice({ row }: { row: ContractCompareRow }) {
  if (row.contractState === 'differs') {
    const total = row.contractTotalPaise;
    return (
      <Notice tone="warning" title="Differs from contract">
        <p className="m-0">
          {total ? `The rate contract total for this stay is ${inr(total)}; this final rate is ${inr(row.amountPaise)}.` : 'This final rate is not the rate contract price.'}
        </p>
        <p className="m-0 mt-1.5">Purchase’s reason: {row.contractDeviationReason?.trim() ? row.contractDeviationReason : 'Not recorded'}</p>
      </Notice>
    );
  }
  if (row.contractState === 'ended') {
    return (
      <Notice tone="info" title="Rate contract ended">
        <p className="m-0">The rate contract for this stay has ended, so this price was not checked against it.</p>
      </Notice>
    );
  }
  return null;
}
