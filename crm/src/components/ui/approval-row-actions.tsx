import { Check, Lock, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
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
 * raised this, so a different person approves it."). Nobody approves their
 * own work; the database still refuses it whatever the screen shows.
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
    hiddenFields?: Readonly<Record<string, string>>;
  };
  disabledReason?: ReactNode;
}

export function ApprovalRowActions<R extends ConfirmResult>({ recordName, approve, returnChange, disabledReason }: ApprovalRowActionsProps<R>) {
  const approveLabel = approve.label ?? 'Approve';
  const returnLabel = returnChange?.label ?? 'Return';
  const forRecord = <span className="sr-only"> {recordName}</span>;
  if (disabledReason) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2 font-sans" data-slot="approval-actions">
        <Button size="sm" disabled>
          <Check aria-hidden="true" />
          {approveLabel}
          {forRecord}
        </Button>
        {returnChange ? (
          <Button size="sm" variant="ghost" disabled>
            <Undo2 aria-hidden="true" />
            {returnLabel}
            {forRecord}
          </Button>
        ) : null}
        <p className="m-0 flex basis-full items-start justify-end gap-1.5 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{disabledReason}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start justify-end gap-2 font-sans" data-slot="approval-actions">
      <form action={approve.formAction}>
        {approve.hiddenFields
          ? Object.entries(approve.hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
          : null}
        <Button type="submit" size="sm">
          <Check aria-hidden="true" />
          {approveLabel}
          {forRecord}
        </Button>
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
