import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { SupplierRefundFields } from './fields';
import { SOURCE_WORD, SUPPLIER_REFUND_MODE_WORD } from './labels';
import type { SupplierRefundSource } from './types';

/*
 * Supplier, airline and visa-fee refunds expected on an approved trip
 * cancellation (contract 7.1, 7.3 C7/C8 with Addendum L1, R-C1
 * supplierRefunds, R-C3): expected and received (verified) side by side, the
 * receipts, and for Accounts "Record refund received" (recorded and verified
 * in one step by one person) and "Cancel" with a reason. Never customer
 * money: it never changes dues. Read only for the branch Manager.
 */

export interface SupplierRefundLine {
  key: string;
  /** Null for a reconfirmation source (Accounts phase 3): the change request names it instead. */
  cancellationId: string | null;
  changeRequestId?: string | null;
  changeRefNo?: string | null;
  dealId: string;
  dealReference?: string;
  branchName?: string;
  sourceKind: SupplierRefundSource;
  sourceId: string;
  supplierName: string | null;
  expectedPaise: string;
  receivedPaise: string;
  canRecord: boolean;
  receipts: Array<{ id: string; amountPaise: string; receivedOn: string; mode: keyof typeof SUPPLIER_REFUND_MODE_WORD; reference: string; status: 'verified' | 'rejected'; rowVersion: number; recordedByName: string | null; rejectReason?: string | null; canCancel?: boolean }>;
}

export function SupplierRefundsList({
  lines,
  actions,
  today,
  showDeal,
  enabled = true,
  open,
}: {
  lines: SupplierRefundLine[];
  /** Accounts only. */
  actions: { record: DecisionAction; cancel: DecisionAction } | null;
  today: string;
  showDeal?: boolean;
  enabled?: boolean;
  open?: { key: string; dialog: 'record' | 'cancel'; state?: DeskResult | null };
}) {
  const off = enabled ? null : 'Refunds are not switched on yet.';
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {lines.map((l) => {
        const outstanding = BigInt(l.expectedPaise) - BigInt(l.receivedPaise);
        const done = outstanding <= 0n;
        const title = `${SOURCE_WORD[l.sourceKind]}${l.changeRefNo ? ` (${l.changeRefNo})` : ''}${l.supplierName ? ` · ${l.supplierName}` : ''}`;
        return (
          <li key={l.key} className="m-0 flex flex-col gap-2 rounded-control border border-line bg-canvas px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold wrap-anywhere text-ink">{title}</span>
              {showDeal && l.dealReference ? (
                <Link href={`/app/accounts/deals/${l.dealId}?tab=money`} className="text-sm font-semibold text-brand-strong underline-offset-4 hover:underline">
                  {l.dealReference}
                  {l.branchName ? ` · ${l.branchName}` : ''}
                </Link>
              ) : null}
              <StatusBadge tone={done ? 'success' : BigInt(l.receivedPaise) > 0n ? 'info' : 'warning'} wrap>
                {done ? 'All received' : BigInt(l.receivedPaise) > 0n ? 'Partly received' : 'Waiting for the refund'}
              </StatusBadge>
            </div>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-quiet">Expected</dt>
                <dd className="m-0 tabular-nums text-ink">{inr(l.expectedPaise)}</dd>
              </div>
              <div>
                <dt className="text-sm text-quiet">Received (verified)</dt>
                <dd className="m-0 tabular-nums text-ink">{inr(l.receivedPaise)}</dd>
              </div>
              {!done ? (
                <div>
                  <dt className="text-sm text-quiet">Still expected</dt>
                  <dd className="m-0 font-semibold tabular-nums text-ink">{inr(outstanding.toString())}</dd>
                </div>
              ) : null}
            </dl>
            {l.receipts.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" aria-label={`Refunds received for ${title}`}>
                {l.receipts.map((rc) => (
                  <li key={rc.id} className="flex flex-wrap items-center gap-2">
                    <span className={rc.status === 'rejected' ? 'text-quiet line-through' : 'text-copy'}>
                      {inr(rc.amountPaise)} on {dayText(rc.receivedOn)} · {SUPPLIER_REFUND_MODE_WORD[rc.mode]} · ref {rc.reference}
                      {rc.recordedByName ? ` · ${rc.recordedByName}` : ''}
                    </span>
                    <StatusBadge tone={rc.status === 'verified' ? 'success' : 'neutral'} wrap>
                      {rc.status === 'verified' ? 'Verified' : `Cancelled${rc.rejectReason ? ` — ${rc.rejectReason}` : ''}`}
                    </StatusBadge>
                    {actions && rc.status === 'verified' && rc.canCancel !== false ? (
                      <DialogAction
                        buttonLabel="Cancel this record"
                        ariaLabel={`Cancel this record: ${inr(rc.amountPaise)} received ${dayText(rc.receivedOn)}`}
                        buttonVariant="ghost"
                        blockedReason={off}
                        title="Cancel this supplier refund?"
                        description="Use this when it was recorded by mistake. It stays in the history as cancelled; if it was exported to Tally it shows as changed since export."
                        primaryLabel="Cancel the refund record"
                        pendingLabel="Cancelling…"
                        danger
                        cancelLabel="Keep it"
                        action={actions.cancel}
                        fields={{ supplierRefundId: rc.id, expectedRowVersion: rc.rowVersion, dealId: l.dealId }}
                        okTitle="Cancelled"
                        initialOpen={open?.key === rc.id && open.dialog === 'cancel'}
                        initialState={open?.key === rc.id && open.dialog === 'cancel' ? open.state : undefined}
                      >
                        <ReasonField id={`srcancel-${rc.id}`} label="Why it is cancelled" />
                      </DialogAction>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-quiet">Nothing received yet.</p>
            )}
            {actions ? (
              <DialogAction
                buttonLabel="Record refund received"
                ariaLabel={`Record refund received from ${title}`}
                blockedReason={off ?? (l.canRecord ? null : done ? 'All received.' : 'Not available for this line.')}
                title={`Record a refund from ${title}`}
                description="Enter what reached our account. You record and verify it in one step."
                primaryLabel="Record and verify"
                pendingLabel="Recording…"
                action={actions.record}
                fields={{ cancellationId: l.cancellationId, changeRequestId: l.changeRequestId, sourceKind: l.sourceKind, sourceId: l.sourceId, dealId: l.dealId }}
                okTitle="Recorded"
                initialOpen={open?.key === l.key && open.dialog === 'record'}
                initialState={open?.key === l.key && open.dialog === 'record' ? open.state : undefined}
              >
                <SupplierRefundFields today={today} outstandingPaise={(outstanding > 0n ? outstanding : 0n).toString()} />
              </DialogAction>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
