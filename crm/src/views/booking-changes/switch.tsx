import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';

/*
 * Super Admin switches for changes after confirmation (contract 10.2 G1) and
 * adding or removing services (11.1 H1); screen 15.10. One button per switch
 * that says what it does, a reason (10 to 500 characters) saved with the
 * change. The route passes the actions only to a Super Admin.
 */
export function BookingChangeSwitches({
  changesEnabled,
  serviceChangesEnabled,
  actions,
}: {
  changesEnabled: boolean;
  serviceChangesEnabled: boolean;
  actions: { setChanges?: DecisionAction | null; setServiceChanges?: DecisionAction | null };
}) {
  return (
    <section aria-labelledby="changes-switches-h" className="flex flex-col gap-2 rounded-control border border-line px-3 py-2">
      <h3 id="changes-switches-h" className="m-0 text-sm font-semibold text-ink">
        Switches (Super Admin)
      </h3>
      <p className="m-0 text-sm text-copy">
        Changes after confirmation: <strong>{changesEnabled ? 'on' : 'off'}</strong> · Adding or removing services: <strong>{serviceChangesEnabled ? 'on' : 'off'}</strong>. They apply to every Deal.
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <DialogAction
          buttonLabel={changesEnabled ? 'Switch changes off' : 'Switch changes on'}
          title={changesEnabled ? 'Switch changes after confirmation off?' : 'Switch changes after confirmation on?'}
          description={
            changesEnabled
              ? 'Nobody can ask for a new change. Changes already in progress can still be finished or withdrawn.'
              : 'Sales owners can ask for a change after a supplier confirmed; the branch Manager approves it. Turn it on only after the owner approved it.'
          }
          primaryLabel={changesEnabled ? 'Switch off' : 'Switch on'}
          pendingLabel="Saving…"
          action={actions.setChanges}
          fields={{ enabled: changesEnabled ? 'false' : 'true' }}
          danger={changesEnabled}
          okTitle="Saved"
        >
          <ReasonField id="cr-switch-reason" />
        </DialogAction>
        <DialogAction
          buttonLabel={serviceChangesEnabled ? 'Switch adding or removing services off' : 'Switch adding or removing services on'}
          title={serviceChangesEnabled ? 'Switch adding or removing services off?' : 'Switch adding or removing services on?'}
          description={
            serviceChangesEnabled
              ? 'Nobody can ask to add or remove a service. Requests already in progress can still be finished or withdrawn.'
              : 'Sales owners can ask to add or remove a service; the branch Manager approves each request. Turn it on only after the owner approved it.'
          }
          primaryLabel={serviceChangesEnabled ? 'Switch off' : 'Switch on'}
          pendingLabel="Saving…"
          action={actions.setServiceChanges}
          fields={{ enabled: serviceChangesEnabled ? 'false' : 'true' }}
          danger={serviceChangesEnabled}
          okTitle="Saved"
        >
          <ReasonField id="sc-switch-reason" />
        </DialogAction>
      </div>
    </section>
  );
}
