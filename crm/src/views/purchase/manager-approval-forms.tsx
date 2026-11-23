'use client';

import { cn, focusRing } from '@/components/ui/cn';
import { jumpTo } from '@/components/ui/jump-links';
import { A1_TEXT } from '@/modules/procurement/contracts';
import { PFIELD } from '@/modules/procurement/forms';
import { approveBeneficiaryAction, approveOverBudgetAction, verifySupplierAction } from '@/modules/procurement/server/actions';
import type { DecisionAction } from '../accounts/supplier-forms';
import { RowDecision } from '../department/row-decision';

/*
 * Client parts of the Manager's Approvals page (redesign R3, design plan
 * DM-5 to DM-7). Every approval row uses the shared decision row
 * (RowDecision, src/views/department/row-decision.tsx since R4), which posts
 * the page's existing server action with its existing field names. The
 * database decides every row: it refuses a person's own request, routes
 * supplier money above ₹50,000 per Deal and supplier to the branch Manager,
 * and binds a cost approval to the exact version shown.
 */

/* ---------------------------------------------------------------------------
 * Decisions that also exist on the task and supplier pages (Phase 4
 * amendment A1): the same server actions, field names and words. They approve
 * only; there is no return for them.
 * ------------------------------------------------------------------------- */

const asDecision = (a: unknown) => a as DecisionAction;

/** Cost above budget: approves exactly this cost version (versionNo), nothing else. */
export function ManagerApproveCostForm({ taskId, versionNo, recordName, disabledReason }: { taskId: string; versionNo: number; recordName?: string; disabledReason?: string }) {
  return (
    <RowDecision
      recordName={recordName ?? `rate version ${versionNo}`}
      action={asDecision(approveOverBudgetAction)}
      fields={{ [PFIELD.taskId]: taskId, [PFIELD.versionNo]: versionNo }}
      decisionField={null}
      requestIdField={null}
      approveLabel={A1_TEXT.approveCostLabel}
      help={A1_TEXT.approveCostHelp}
      disabledReason={disabledReason}
    />
  );
}

/** New supplier bank details: approves exactly this revision. */
export function ManagerApproveBankForm({ supplierId, revisionNo, recordName, disabledReason }: { supplierId: string; revisionNo: number; recordName?: string; disabledReason?: string }) {
  return (
    <RowDecision
      recordName={recordName ?? `revision ${revisionNo}`}
      action={asDecision(approveBeneficiaryAction)}
      fields={{ [PFIELD.supplierId]: supplierId, [PFIELD.revisionNo]: revisionNo }}
      decisionField={null}
      requestIdField={null}
      approveLabel={A1_TEXT.approveBankLabel}
      help="Check them against the supplier’s letter or cheque. Nothing is paid from them in this CRM."
      disabledReason={disabledReason}
    />
  );
}

/** Supplier details checked by the Manager. */
export function ManagerVerifySupplierForm({ supplierId, rowVersion, recordName, disabledReason }: { supplierId: string; rowVersion: number; recordName?: string; disabledReason?: string }) {
  return (
    <RowDecision
      recordName={recordName ?? 'this supplier'}
      action={asDecision(verifySupplierAction)}
      fields={{ [PFIELD.supplierId]: supplierId, [PFIELD.rowVersion]: rowVersion }}
      decisionField={null}
      requestIdField={null}
      approveLabel={A1_TEXT.verifyLabel}
      help={A1_TEXT.verifyHelp}
      disabledReason={disabledReason}
    />
  );
}

/* ---------------------------------------------------------------------------
 * Summary chips (DM-5): one chip per section with something waiting, with
 * its count. Plain "#id" links, so without script the browser still jumps;
 * with script, focus moves to the section heading too (jumpTo).
 * ------------------------------------------------------------------------- */

export interface ApprovalsChip {
  targetId: string;
  label: string;
  /** Waiting count; 'unknown' when the list could not be read. */
  count: number | 'unknown';
}

export function ApprovalsSummaryChips({ chips }: { chips: ApprovalsChip[] }) {
  if (chips.length === 0) return null;
  return (
    <nav aria-label="Waiting for you, by kind" className="-mx-1 bg-canvas px-1 py-2 lg:sticky lg:top-0 lg:z-10" data-slot="approvals-chips">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {chips.map((c) => (
          <li key={c.targetId} className="m-0 max-w-full">
            <a
              href={`#${c.targetId}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                if (jumpTo(c.targetId)) e.preventDefault();
              }}
              className={cn(
                'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-line bg-card px-3 py-1.5 font-sans text-sm font-medium text-copy no-underline hover:border-line-strong hover:bg-wash hover:text-ink',
                focusRing,
              )}
            >
              <span className="wrap-anywhere">{c.label}</span>
              <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-wash px-2 text-xs leading-5 font-medium text-quiet tabular-nums">
                {c.count === 'unknown' ? (
                  <>
                    <span aria-hidden="true">?</span>
                    <span className="sr-only">count not known</span>
                  </>
                ) : (
                  <>
                    {c.count.toLocaleString('en-IN')}
                    <span className="sr-only"> waiting</span>
                  </>
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
