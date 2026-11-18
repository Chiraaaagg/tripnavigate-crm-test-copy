'use client';

import { Check, Lock, Undo2 } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApprovalRowActions, ApproveSubmit } from '@/components/ui/approval-row-actions';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { ConfirmChange } from '@/components/ui/confirm-change';
import { jumpTo } from '@/components/ui/jump-links';
import { Notice } from '@/components/ui/notice';
import { A1_TEXT } from '@/modules/procurement/contracts';
import { PFIELD } from '@/modules/procurement/forms';
import { approveBeneficiaryAction, approveOverBudgetAction, verifySupplierAction } from '@/modules/procurement/server/actions';
import { guard, type DecisionAction, type UiResult } from '../accounts/supplier-forms';

/*
 * Client parts of the Manager's Approvals page (redesign R3, design plan
 * DM-5 to DM-7). One decision template for every approval row: "Approve …"
 * and "Return with reason" side by side (the shared ApprovalRowActions);
 * the reason box opens only after "Return with reason" (the shared confirm
 * dialog, 10 to 500 characters, required). Every row posts the page's
 * existing server action with its existing field names and one request id
 * per row. The database decides every row: it refuses a person's own
 * request, routes supplier money above ₹50,000 per Deal and supplier to the
 * branch Manager, and binds a cost approval to the exact version shown.
 */

/** Return settings of one row (absent: the row can only be approved). */
export interface RowReturn {
  /** The confirm button in the dialog, named for where it goes: "Return to Purchase". */
  confirmLabel: string;
  /** Dialog title, a question: "Return SP-2026-000049 to Purchase?" */
  title: string;
  /** One sentence: what happens on return. */
  effect: ReactNode;
  /** Value posted in the decision field (default "return"). */
  value?: string;
  /** Return is not possible now (approve may still be): the reason in one line. */
  blockedReason?: string | null;
}

export interface RowDecisionProps {
  /** The record the buttons are about ("SP-2026-000049"), added to every button name. */
  recordName: string;
  /** The page's existing server action (prev, formData) => result. */
  action: DecisionAction;
  /** Hidden fields the action reads today (ids and row versions). */
  fields: Readonly<Record<string, string | number>>;
  approveLabel: string;
  /** Field the pressed decision posts under (null: the action takes no decision field). */
  decisionField?: string | null;
  approveValue?: string;
  /** Field of the request id (null: the action takes none). */
  requestIdField?: string | null;
  reasonField?: string;
  /** What approving does, one short line above the buttons. */
  help?: ReactNode;
  ret?: RowReturn;
  /** Neither decision is possible for this person (own request, another Manager decides). */
  disabledReason?: ReactNode;
  /** Approve alone is not possible now (return still is): the reason in one line. */
  approveBlockedReason?: string | null;
  /**
   * Approve asks to confirm first (shared confirm dialog, no reason box), for
   * approvals that had a confirm step before the redesign. Same fields.
   */
  approveConfirm?: { title: string; effect: ReactNode; confirmLabel: string };
  /** Preview gallery only: a reply already received for Approve. */
  initialApproveResult?: UiResult | null;
  /** Preview gallery only: the approve confirm dialog open on first load. */
  initialApproveOpen?: boolean;
  /** Preview gallery only: the return dialog open on first load. */
  initialReturnOpen?: boolean;
}

/**
 * R3 review P2-1: once Approve has succeeded, a queued second press keeps that
 * first "Done" and posts nothing (its reply would be a refusal, "already
 * decided", and would replace "Done" with a false "Not saved").
 */
export function keepFirstOk<T extends { ok: boolean }>(run: (prev: T | null, formData: FormData) => Promise<T>) {
  return async (prev: T | null, formData: FormData): Promise<T> => (prev?.ok ? prev : run(prev, formData));
}

const stringFields = (fields: Readonly<Record<string, string | number>>): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));

/** Approve and Return with reason on one approval row, with the outcome in words. */
export function RowDecision({
  recordName,
  action,
  fields,
  approveLabel,
  decisionField = 'decision',
  approveValue = 'approve',
  requestIdField = 'requestId',
  reasonField = 'reason',
  help,
  ret,
  disabledReason,
  approveBlockedReason,
  approveConfirm,
  initialApproveResult = null,
  initialApproveOpen = false,
  initialReturnOpen = false,
}: RowDecisionProps) {
  const [approveResult, approve] = useActionState(keepFirstOk(guard(action)), approveConfirm ? null : initialApproveResult);
  // One request id per row: a double press or a retry after a lost reply is the same request.
  const [requestId] = useState(() => crypto.randomUUID());
  const [returned, setReturned] = useState<UiResult | null>(null);
  const [confirmed, setConfirmed] = useState<UiResult | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const done = approveResult?.ok ? approveResult : confirmed?.ok ? confirmed : returned?.ok ? returned : null;

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} className="outline-none">
        <Notice tone="success" role="status">
          <p>
            <strong>Done: </strong>
            {done.message}
          </p>
        </Notice>
      </div>
    );
  }

  const base = stringFields(fields);
  const withRequest = requestIdField ? { ...base, [requestIdField]: requestId } : base;
  const approveFields = decisionField ? { ...withRequest, [decisionField]: approveValue } : withRequest;
  const returnFields = decisionField ? { ...withRequest, [decisionField]: ret?.value ?? 'return' } : withRequest;
  const runReturn = async (prev: UiResult | null, formData: FormData): Promise<UiResult> => {
    const result = await guard(action)(prev, formData);
    if (result.ok) setReturned(result);
    return result;
  };
  const runApproveConfirmed = async (prev: UiResult | null, formData: FormData): Promise<UiResult> => {
    const result = await guard(action)(prev, formData);
    if (result.ok) setConfirmed(result);
    return result;
  };
  const returnDialog: ReturnDialog | undefined = ret
    ? { formAction: runReturn, label: 'Return with reason', title: ret.title, effect: ret.effect, confirmLabel: ret.confirmLabel, reasonName: reasonField, hiddenFields: returnFields }
    : undefined;
  const approveDialog: ApproveDialog | undefined = approveConfirm
    ? { ...approveConfirm, formAction: runApproveConfirmed, initialOpen: initialApproveOpen || !!initialApproveResult, initialResult: initialApproveResult }
    : undefined;
  const refused = approveResult && !approveResult.ok ? approveResult : null;
  // Which decisions are open to this person now.
  const returnOpen = !!returnDialog && !ret?.blockedReason;
  const bothBlocked = disabledReason ?? (approveBlockedReason && !returnOpen ? approveBlockedReason : null);
  const partial = !bothBlocked && (!!approveDialog || (!!approveBlockedReason && returnOpen) || (initialReturnOpen && returnOpen));

  return (
    <div className="flex flex-col gap-2" data-slot="row-decision">
      {help && !bothBlocked ? (
        <p className="m-0 text-sm text-quiet">
          {help}
        </p>
      ) : null}
      {refused ? (
        <Notice tone="danger" role="alert">
          <p>
            <strong>Not saved: </strong>
            {refused.message}
          </p>
        </Notice>
      ) : null}
      {/* A flex row, so the shared actions sit at the start of the card under the facts. */}
      <div className="flex">
        {partial ? (
          <PartialActions
            recordName={recordName}
            approveLabel={approveLabel}
            approveBlockedReason={approveBlockedReason ?? null}
            approveFormAction={approve}
            approveFields={approveFields}
            approveDialog={approveDialog}
            ret={returnOpen ? returnDialog : undefined}
            initialReturnOpen={initialReturnOpen}
          />
        ) : (
          <ApprovalRowActions
            recordName={recordName}
            approve={{ formAction: approve, label: approveLabel, hiddenFields: approveFields }}
            returnChange={returnOpen && returnDialog ? { ...returnDialog, reasonLabel: RETURN_REASON_LABEL } : undefined}
            disabledReason={bothBlocked ?? undefined}
          />
        )}
      </div>
      {!bothBlocked && ret?.blockedReason ? <p className="m-0 text-sm text-quiet">{ret.blockedReason}</p> : null}
    </div>
  );
}

/** Label of the reason box in every return dialog on the Approvals page (DM-6). */
const RETURN_REASON_LABEL = 'Reason for returning';

interface ApproveDialog {
  title: string;
  effect: ReactNode;
  confirmLabel: string;
  formAction: (prev: UiResult | null, formData: FormData) => Promise<UiResult>;
  initialOpen: boolean;
  initialResult: UiResult | null;
}

interface ReturnDialog {
  formAction: (prev: UiResult | null, formData: FormData) => Promise<UiResult>;
  label: string;
  title: string;
  effect: ReactNode;
  confirmLabel: string;
  reasonName: string;
  hiddenFields: Readonly<Record<string, string>>;
}

/**
 * The cases the shared part does not cover: Approve that confirms first (an
 * approval that had a confirm step before), Approve blocked while Return is
 * still possible (a booked removal waiting for supplier charges), and the
 * preview gallery's open dialogs. Same buttons, words and fields; every
 * dialog is the shared ConfirmChange.
 */
function PartialActions({
  recordName,
  approveLabel,
  approveBlockedReason,
  approveFormAction,
  approveFields,
  approveDialog,
  ret,
  initialReturnOpen,
}: {
  recordName: string;
  approveLabel: string;
  approveBlockedReason: string | null;
  approveFormAction: (formData: FormData) => void;
  approveFields: Readonly<Record<string, string>>;
  approveDialog?: ApproveDialog;
  ret?: ReturnDialog;
  initialReturnOpen: boolean;
}) {
  const blockedId = useId();
  const forRecord = <span className="sr-only"> {recordName}</span>;
  return (
    <div className="flex flex-wrap items-start gap-2 font-sans" data-slot="approval-actions">
      {approveBlockedReason ? (
        // Focusable but inert (R3 review P3-6): aria-disabled, no handler and no form, so it cannot post.
        <Button size="sm" aria-disabled="true" aria-describedby={blockedId}>
          <Check aria-hidden="true" />
          {approveLabel}
          {forRecord}
        </Button>
      ) : approveDialog ? (
        <ConfirmChange
          title={approveDialog.title}
          effect={approveDialog.effect}
          confirmLabel={approveDialog.confirmLabel}
          reason="none"
          formAction={approveDialog.formAction}
          hiddenFields={approveFields}
          initialOpen={approveDialog.initialOpen}
          initialResult={approveDialog.initialResult}
          trigger={{
            variant: 'primary',
            size: 'sm',
            label: (
              <>
                <Check aria-hidden="true" />
                {approveLabel}
                {forRecord}
              </>
            ),
          }}
        />
      ) : (
        <form action={approveFormAction}>
          {Object.entries(approveFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <ApproveSubmit label={approveLabel} forRecord={forRecord} />
        </form>
      )}
      {ret ? (
        <ConfirmChange
          title={ret.title}
          effect={ret.effect}
          confirmLabel={ret.confirmLabel}
          tone="danger"
          reason="required"
          reasonName={ret.reasonName}
          reasonLabel={RETURN_REASON_LABEL}
          formAction={ret.formAction}
          hiddenFields={ret.hiddenFields}
          initialOpen={initialReturnOpen}
          trigger={{
            variant: 'ghost',
            size: 'sm',
            label: (
              <>
                <Undo2 aria-hidden="true" />
                {ret.label}
                {forRecord}
              </>
            ),
          }}
        />
      ) : null}
      {approveBlockedReason ? (
        <p id={blockedId} className="m-0 flex basis-full items-start gap-1.5 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{approveBlockedReason}</span>
        </p>
      ) : null}
    </div>
  );
}

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
