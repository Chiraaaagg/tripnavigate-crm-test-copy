'use client';

import { Check, Lock, Undo2 } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from './button';
import { ConfirmChange, type ConfirmAction, type ConfirmResult } from './confirm-change';

/*
 * Approve and Return on one approval row (design plan A7, Manager approvals).
 * Approve posts the page's existing approve action with its existing fields.
 * Return opens the confirm dialog (C7) with the reason REQUIRED (10 to 500
 * characters), posting the page's existing return action and field names.
 * Every button name includes the record ("Approve P-102") so a list of rows
 * reads clearly to a screen reader.
 *
 * blocked: `disabledReason` disables both and says why beside them ("You
 * raised this, so a different person approves it."). They stay focusable
 * (aria-disabled, described by the reason) and sit in no form, so they
 * cannot post. Nobody approves their own work; the database still refuses it
 * whatever the screen shows.
 *
 * Approve is disabled and shows a spinner while its post is pending (R3
 * review P2-1), so a double press cannot send a second decision.
 *
 * Contract note: the build plan named an `onReturn` callback. A server page
 * cannot pass a callback to a client part, so Return takes the dialog's
 * settings (`returnChange`) instead and opens the dialog itself.
 */

export interface ApprovalRowActionsProps<R extends ConfirmResult> {
  /** The record the row is about, added to every button name: "P-102". */
  recordName: string;
  approve: {
    formAction: (formData: FormData) => void | Promise<void>;
    label?: string;
    hiddenFields?: Readonly<Record<string, string>>;
  };
  returnChange?: {
    formAction: ConfirmAction<R>;
    label?: string;
    title: string;
    effect: ReactNode;
    affected?: ReactNode;
    confirmLabel?: string;
    reasonName?: string;
    /** Label of the reason box (default "Reason", as before). */
    reasonLabel?: string;
    hiddenFields?: Readonly<Record<string, string>>;
  };
  disabledReason?: ReactNode;
}

export function ApprovalRowActions<R extends ConfirmResult>({ recordName, approve, returnChange, disabledReason }: ApprovalRowActionsProps<R>) {
  const approveLabel = approve.label ?? 'Approve';
  const returnLabel = returnChange?.label ?? 'Return';
  const forRecord = <span className="sr-only"> {recordName}</span>;
  if (disabledReason) {
    return <BlockedActions approveLabel={approveLabel} returnLabel={returnChange ? returnLabel : null} forRecord={forRecord} reason={disabledReason} />;
  }
  return (
    <div className="flex flex-wrap items-start justify-end gap-2 font-sans" data-slot="approval-actions">
      <form action={approve.formAction}>
        {approve.hiddenFields
          ? Object.entries(approve.hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
          : null}
        <ApproveSubmit label={approveLabel} forRecord={forRecord} />
      </form>
      {returnChange ? (
        <ConfirmChange
          title={returnChange.title}
          effect={returnChange.effect}
          affected={returnChange.affected}
          confirmLabel={returnChange.confirmLabel ?? returnLabel}
          tone="danger"
          reason="required"
          reasonName={returnChange.reasonName}
          reasonLabel={returnChange.reasonLabel}
          formAction={returnChange.formAction}
          hiddenFields={returnChange.hiddenFields}
          trigger={{
            variant: 'ghost',
            size: 'sm',
            label: (
              <>
                <Undo2 aria-hidden="true" />
                {returnLabel}
                {forRecord}
              </>
            ),
          }}
        />
      ) : null}
    </div>
  );
}

/** The Approve submit: disabled with a spinner while the post is pending, so a double press posts once. */
export function ApproveSubmit({ label, forRecord }: { label: ReactNode; forRecord: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" loading={pending}>
      {pending ? null : <Check aria-hidden="true" />}
      {label}
      {forRecord}
    </Button>
  );
}

function BlockedActions({ approveLabel, returnLabel, forRecord, reason }: { approveLabel: string; returnLabel: string | null; forRecord: ReactNode; reason: ReactNode }) {
  const reasonId = useId();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 font-sans" data-slot="approval-actions">
      {/* Focusable but inert: aria-disabled, no handler and no form, so nothing can post. */}
      <Button size="sm" aria-disabled="true" aria-describedby={reasonId}>
        <Check aria-hidden="true" />
        {approveLabel}
        {forRecord}
      </Button>
      {returnLabel ? (
        <Button size="sm" variant="ghost" aria-disabled="true" aria-describedby={reasonId}>
          <Undo2 aria-hidden="true" />
          {returnLabel}
          {forRecord}
        </Button>
      ) : null}
      <p id={reasonId} className="m-0 flex basis-full items-start justify-end gap-1.5 text-sm text-quiet">
        <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{reason}</span>
      </p>
    </div>
  );
}
