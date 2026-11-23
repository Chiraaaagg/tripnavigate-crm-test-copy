'use client';

import { useId, type ReactNode } from 'react';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { DialogAction, ReasonField, BlockedButton } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { inr } from '@/views/accounts-desk/labels';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DIRECTION_WORDS, proposeBlockedReason } from './labels';
import { WO_FIELD, type SmallBalanceRow } from './types';

/*
 * The write-off actions of one small-balance row (contract 6.6 B3–B6).
 * Each opens one dialog with one primary button; refusals keep the dialog
 * open with what was typed. The amount is never typed: a write-off is always
 * the whole balance, so it travels as a hidden paise value and the approval
 * binds the amount the Manager saw (expectedAmountPaise).
 */

export interface WriteOffActions {
  propose?: DecisionAction | null;
  decide?: DecisionAction | null;
  withdraw?: DecisionAction | null;
  undo?: DecisionAction | null;
}

export type WriteOffDialog = 'propose' | 'approve' | 'return' | 'withdraw' | 'undo';

/** Preview gallery only: open one dialog on one row, optionally with a refusal on screen. */
export interface WriteOffPreviewOpen {
  dealId: string;
  dialog: WriteOffDialog;
  state?: DeskResult | null;
}

function AmountFacts({ row }: { row: SmallBalanceRow }) {
  const amount = row.writeOff?.amountPaise ?? row.balancePaise;
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-control border border-line bg-wash px-3.5 py-3 text-sm">
      <dt className="text-quiet">Deal</dt>
      <dd className="m-0 font-semibold wrap-anywhere text-ink">{row.dealReference}</dd>
      <dt className="text-quiet">{DIRECTION_WORDS[row.direction].title}</dt>
      <dd className="m-0 font-semibold text-ink tabular-nums">{inr(amount)}</dd>
      <dt className="text-quiet">Limit per Deal</dt>
      <dd className="m-0 tabular-nums">{inr(row.limitPaise)}</dd>
    </dl>
  );
}

export function WriteOffRowActions({ row, actions, preview }: { row: SmallBalanceRow; actions: WriteOffActions; preview?: WriteOffPreviewOpen | null }) {
  const noteId = useId();
  const wo = row.writeOff;
  const open = (d: WriteOffDialog) => (preview && preview.dealId === row.dealId && preview.dialog === d ? { initialOpen: true, initialState: preview.state ?? null } : {});
  const ctx = ` for ${row.dealReference}`;
  const buttons: ReactNode[] = [];

  if (wo?.status === 'proposed') {
    if (row.can.approve) {
      buttons.push(
        <DialogAction
          key="approve"
          {...open('approve')}
          buttonLabel="Approve write-off"
          buttonVariant="primary"
          ariaLabel={`Approve write-off ${wo.refNo}${ctx}`}
          title={`Approve write-off ${wo.refNo}`}
          description={<>{DIRECTION_WORDS[row.direction].effect} Nothing moves in the bank or cash.</>}
          primaryLabel="Approve write-off"
          pendingLabel="Approving…"
          action={actions.decide}
          fields={{ [WO_FIELD.writeOffId]: wo.id, [WO_FIELD.decision]: 'approve', [WO_FIELD.expectedAmountPaise]: wo.amountPaise, [WO_FIELD.expectedRowVersion]: wo.rowVersion }}
        >
          <AmountFacts row={row} />
          <p className="m-0 text-sm">
            <span className="font-semibold text-ink">Accounts&apos; reason: </span>
            {wo.reason}
          </p>
          <Field htmlFor={noteId} label="Note" optional hint="Shown in the history.">
            <Textarea id={noteId} name={WO_FIELD.reason} maxLength={500} rows={2} aria-describedby={`${noteId}-hint`} />
          </Field>
        </DialogAction>,
      );
    }
    if (row.can.return) {
      buttons.push(
        <DialogAction
          key="return"
          {...open('return')}
          buttonLabel="Return"
          ariaLabel={`Return write-off ${wo.refNo}${ctx}`}
          title={`Return write-off ${wo.refNo}`}
          description="Accounts see your reason and can propose again or leave the balance open."
          primaryLabel="Return to Accounts"
          pendingLabel="Returning…"
          action={actions.decide}
          fields={{ [WO_FIELD.writeOffId]: wo.id, [WO_FIELD.decision]: 'return', [WO_FIELD.expectedAmountPaise]: wo.amountPaise, [WO_FIELD.expectedRowVersion]: wo.rowVersion }}
        >
          <AmountFacts row={row} />
          <ReasonField id={`${noteId}-ret`} label="Why it is returned" />
        </DialogAction>,
      );
    }
    if (row.can.withdraw) {
      buttons.push(
        <DialogAction
          key="withdraw"
          {...open('withdraw')}
          buttonLabel="Withdraw"
          ariaLabel={`Withdraw write-off ${wo.refNo}${ctx}`}
          title={`Withdraw write-off ${wo.refNo}`}
          description="The balance stays open on the Deal. You can propose again later."
          primaryLabel="Withdraw write-off"
          pendingLabel="Withdrawing…"
          cancelLabel="Keep it"
          action={actions.withdraw}
          fields={{ [WO_FIELD.writeOffId]: wo.id, [WO_FIELD.expectedRowVersion]: wo.rowVersion }}
        >
          <ReasonField id={`${noteId}-wd`} />
        </DialogAction>,
      );
    }
    if (!row.can.approve && !row.can.return && !row.can.withdraw) {
      buttons.push(<BlockedButton key="wait" label="Approve write-off" reason="Waiting for a branch Manager to approve it." />);
    }
  } else if (wo?.status === 'approved') {
    if (row.can.undo) {
      buttons.push(
        <DialogAction
          key="undo"
          {...open('undo')}
          buttonLabel="Undo write-off"
          ariaLabel={`Undo write-off ${wo.refNo}${ctx}`}
          title={`Undo write-off ${wo.refNo}`}
          description="The balance comes back on the Deal exactly as it was. The write-off stays in the history."
          primaryLabel="Undo write-off"
          pendingLabel="Undoing…"
          danger
          cancelLabel="Keep it"
          action={actions.undo}
          fields={{ [WO_FIELD.writeOffId]: wo.id, [WO_FIELD.expectedRowVersion]: wo.rowVersion }}
        >
          <AmountFacts row={row} />
          <ReasonField id={`${noteId}-undo`} />
        </DialogAction>,
      );
    }
  } else {
    const blocked = proposeBlockedReason(row);
    buttons.push(
      <DialogAction
        key="propose"
        {...open('propose')}
        buttonLabel="Propose write-off"
        buttonVariant="primary"
        blockedReason={blocked}
        ariaLabel={`Propose write-off${ctx}`}
        title={`Propose a write-off for ${row.dealReference}`}
        description={<>A write-off is always the whole balance. A branch Manager approves it. {DIRECTION_WORDS[row.direction].effect}</>}
        primaryLabel="Send for approval"
        pendingLabel="Sending…"
        action={actions.propose}
        fields={{ [WO_FIELD.dealId]: row.dealId, [WO_FIELD.direction]: row.direction, [WO_FIELD.amountPaise]: row.balancePaise }}
      >
        <AmountFacts row={row} />
        <ReasonField id={`${noteId}-prop`} hint="10 to 500 characters, for example why the small amount is not worth collecting. The Manager sees it." />
      </DialogAction>,
    );
  }

  return <div className="flex flex-wrap items-start gap-2">{buttons}</div>;
}
