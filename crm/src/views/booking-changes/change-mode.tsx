import { PencilLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { cn } from '@/components/ui/cn';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedButton, DialogAction } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { KIND_WORD, REFUSAL_TEXT } from './labels';
import { changeModeItemState, itemNosText, outsideRequestItemNos, type ChangeModeItemState } from './rules';
import type { ChangeModeView } from './types';

/*
 * Booking form in change mode (contract 10.3 G5–G6, 11.2, 11.3, screen
 * 15.10). Standalone parts the booking form places: the banner at the top
 * (which request, what is in it, "Send change"), a mark beside each changed
 * field, and a read-only note on services outside the request. "Send change"
 * binds the content hash and the changed services the screen showed; a
 * service changed outside the request is refused `change_outside_request`
 * and named here before the press.
 */

export function ChangeModeBanner({ view, submit, preview }: { view: ChangeModeView; submit: DecisionAction | null; preview?: { open?: boolean; state?: DeskResult | null } }) {
  const outside = outsideRequestItemNos(view.requestItemIds, view.changedItemIds, view.itemNos);
  const inRequestChanged = view.changedItemIds.filter((id) => view.requestItemIds.includes(id));
  const nothingChanged = view.kind === 'change' && inRequestChanged.length === 0;
  const blocked = !view.canSubmit
    ? 'Only the requester or the Sales owner sends the change.'
    : outside.length > 0
      ? `${REFUSAL_TEXT.change_outside_request} Undo the edits to ${itemNosText(outside).toLowerCase()}.`
      : nothingChanged
        ? 'Nothing has changed yet. Edit the services in the request first.'
        : null;
  const requestNos = view.requestItemIds.map((id) => view.itemNos[id]).filter((n): n is number => typeof n === 'number');
  return (
    <section id="change-mode" aria-labelledby="change-mode-heading" className="mb-5 scroll-mt-20 rounded-card border-2 border-brand-line bg-brand-tint px-4.5 py-4 font-sans text-base text-copy">
      <div className="flex items-start gap-2.5">
        <PencilLine aria-hidden="true" className="mt-1.5 size-4.5 shrink-0 text-brand-strong" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p id="change-mode-heading" className="m-0 text-lg font-semibold text-ink">
            Change mode · {KIND_WORD[view.kind]} {view.refNo}
          </p>
          <p className="m-0 wrap-anywhere">{view.changeSummary}</p>
          <p className="m-0 text-sm">
            {view.kind === 'add_service'
              ? 'Add the new service, then set the new total and payment plan. Services already in the booking stay as they are.'
              : view.kind === 'remove_service'
                ? 'The service is removed in this version. Set the new total (it includes the customer charge in the request) and the payment plan.'
                : `You can edit ${itemNosText(requestNos).toLowerCase()} only. Other services are read-only.`}{' '}
            The confirmed booking stays valid until the change is applied. When it is ready, press &quot;Send change&quot;: the branch Manager approves exactly what you send.
          </p>
          {outside.length > 0 ? (
            <p role="alert" className="m-0 rounded-control border border-status-danger-line bg-status-danger-tint px-3 py-2 text-sm text-ink">
              <strong>Not part of the request: </strong>
              {itemNosText(outside)} changed. Undo those edits, or withdraw this request and ask for a new one.
            </p>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            {blocked || !submit ? (
              <BlockedButton label="Send change" reason={blocked ?? 'Not available here.'} variant="primary" />
            ) : (
              <DialogAction
                buttonLabel="Send change"
                buttonVariant="primary"
                title={`Send change ${view.refNo}`}
                description={
                  view.kind === 'change'
                    ? `${itemNosText(inRequestChanged.map((id) => view.itemNos[id]!).filter(Boolean))} changed. The branch Manager now checks the old and new booking side by side and approves exactly this version. Then Purchase asks each supplier to reconfirm; the change is applied when every supplier agreed. Do not edit the booking after sending: the Manager would have to see it again.`
                    : 'The branch Manager now checks the old and new booking side by side and approves exactly this version. Then new services get their task; a removed service closes its task. Do not edit the booking after sending.'
                }
                primaryLabel="Send the change"
                pendingLabel="Sending…"
                action={submit}
                fields={{ changeRequestId: view.changeRequestId, expectedContentHash: view.contentHash }}
                okTitle="Sent"
                initialOpen={preview?.open}
                initialState={preview?.state}
              >
                {/* G6: one hidden field per changed service the screen showed (module CHANGE_FIELD.changedItemIds, repeated). */}
                {view.changedItemIds.map((id) => (
                  <input key={id} type="hidden" name="changedItemIds" value={id} />
                ))}
              </DialogAction>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

const MARK: Record<ChangeModeItemState, { word: string; tone: 'warning' | 'info' | 'neutral' }> = {
  changed: { word: 'Changed', tone: 'warning' },
  in_request: { word: 'In the request', tone: 'info' },
  outside_request: { word: 'Read-only: not in the request', tone: 'neutral' },
};

/** The word mark for one service card in change mode. */
export function ChangeModeServiceMark({ itemId, view }: { itemId: string; view: Pick<ChangeModeView, 'requestItemIds' | 'changedItemIds'> }) {
  const state = changeModeItemState(itemId, view.requestItemIds, view.changedItemIds);
  const m = MARK[state];
  return <StatusBadge tone={m.tone}>{m.word}</StatusBadge>;
}

/** Wraps one field: a tint and a "Changed" word when its value differs from the confirmed version. */
export function ChangedField({ changed, before, children, className }: { changed: boolean; before?: string | null; children: ReactNode; className?: string }) {
  if (!changed) return <>{children}</>;
  return (
    <div className={cn('flex flex-col gap-1 rounded-control border-l-4 border-status-warning-line bg-status-warning-tint py-1.5 pr-2 pl-3', className)} data-changed="true">
      {children}
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-copy">
        <StatusBadge tone="warning">Changed</StatusBadge>
        {before !== undefined ? <span className="wrap-anywhere">Confirmed: {before === null || before === '' ? 'empty' : before}</span> : null}
      </p>
    </div>
  );
}
