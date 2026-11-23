import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';

/*
 * Super Admin switch for rate contracts (contract 9.1 E1, 17.2; screen 15.9).
 * One button that says what it does, a reason (10 to 500 characters) saved
 * with the change. Shown only when rate_contracts_state() says canSwitch.
 */
export function RateContractsSwitch({ enabled, action }: { enabled: boolean; action: DecisionAction | null }) {
  return (
    <DialogAction
      buttonLabel={enabled ? 'Switch rate contracts off' : 'Switch rate contracts on'}
      title={enabled ? 'Switch rate contracts off?' : 'Switch rate contracts on?'}
      description={
        enabled
          ? 'Purchase can no longer add, send or change contracts, and offers stop comparing with contract rates. Existing contracts stay as they are.'
          : 'Purchase can enter and upload contracts, Managers approve them, and hotel offers compare with the contract rate. Turn it on only after the owner approved it.'
      }
      primaryLabel={enabled ? 'Switch off' : 'Switch on'}
      pendingLabel="Saving…"
      action={action}
      fields={{ enabled: enabled ? 'false' : 'true' }}
      danger={enabled}
      okTitle="Saved"
    >
      <ReasonField id="rc-switch-reason" />
    </DialogAction>
  );
}
