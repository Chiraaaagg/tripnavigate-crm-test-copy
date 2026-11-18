'use client';

import { CircleCheck, CircleHelp, CircleOff, type LucideIcon, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmChange } from '@/components/ui/confirm-change';
import { Notice } from '@/components/ui/notice';
import type { NameReadStateView } from '@/modules/integration/name-map';
import { SETTINGS_TEXT } from '@/modules/settings/text';
import type { NameReadSwitchActionResult } from '@/modules/integration/server/name-map-actions';
import { formatIst } from './deal-labels';

/*
 * DEC-55 (plan.md §12c): the "Bitrix names" switch (bitrix_name_read) on the
 * Bitrix sync page. On, Off or Unknown in words with an icon (Unknown is never
 * shown as Off). Only a Super Admin gets the change control; the server
 * refuses everyone else and writes the audit row. UX redesign R1 (C7, D9):
 * "Change" opens one confirm dialog that switches to the other state; the
 * reason is optional (an empty one is saved as "No reason given"; a typed one
 * needs 10 to 500 characters). The dialog posts the same fields as before:
 * state, reason, confirm=yes. A refusal keeps the dialog open with the typed
 * reason; a save closes it and the result is announced beside the button.
 * Copy: copy-catalogue §16.10 DA-139 to DA-141.
 */

export type NameReadAction = (prev: NameReadSwitchActionResult | null, formData: FormData) => Promise<NameReadSwitchActionResult>;

export const NAMES_CARD_LINE = 'Shows Bitrix stage, status and source names. Read-only; nothing is written to Bitrix.';
/** DA-139: both directions, in the confirm dialog. */
export const NAMES_APPROVAL_LINE = 'Changing this in the live CRM needs the owner’s approval first. Write the approval in the reason.';

type Step = 'closed' | 'choose' | 'review';

/**
 * Words of one Bitrix read switch card. The Bitrix names card is the default;
 * the voice-note batch reuses the same flow for "Bitrix trip details"
 * (bitrix_trip_details_read): same state shape, same reason, review and
 * confirm, Unknown never shown as Off.
 */
export interface ReadSwitchCopy {
  title: string;
  line: string;
  /** Screen-reader prefix of the state word, e.g. "Bitrix names: ". */
  stateLabel: string;
  onNoConnection: string;
  trigger: string;
  legend: string;
  onChoice: string;
  offChoice: string;
  reviewOn: string;
  reviewOff: string;
  /** "Turn Bitrix names" (followed by on or off). */
  turn: string;
  slot: string;
}

export const NAMES_COPY: ReadSwitchCopy = {
  title: 'Bitrix names',
  line: NAMES_CARD_LINE,
  stateLabel: 'Bitrix names: ',
  onNoConnection: 'On, but the Bitrix connection is off: codes are shown.',
  trigger: 'Change Bitrix names setting',
  legend: 'Turn Bitrix names',
  onChoice: "Lists, Lead and Deal pages show Bitrix's own names after the next daily read.",
  offChoice: 'Screens show the codes again with “not recognised (code in details)”. Stored names are kept.',
  reviewOn: 'Lists, Lead and Deal pages will show Bitrix stage, status and source names after the next daily read.',
  reviewOff: 'Screens will show codes again; stored names are kept.',
  turn: 'Turn Bitrix names',
  slot: 'names',
};

/** Voice-note batch (owner answer 3): Bitrix trip details, starts Off. */
export const TRIP_DETAILS_COPY: ReadSwitchCopy = {
  title: 'Bitrix trip details',
  line: 'Read trip details from Bitrix (destination, adults, children, infants). Read-only; nothing is written to Bitrix.',
  stateLabel: 'Bitrix trip details: ',
  onNoConnection: 'On, but the Bitrix connection is off: nothing new is read.',
  trigger: 'Change Bitrix trip details setting',
  legend: 'Turn Bitrix trip details',
  onChoice: 'Bookings show the destination and the adult, child and infant counts from the Deal after the next Bitrix update. Missing values are still asked on the booking.',
  offChoice: 'Bookings ask for these values again. Values already saved on bookings are kept.',
  reviewOn: 'Bookings will take the destination and the adult, child and infant counts from the Bitrix Deal after the next Bitrix update.',
  reviewOff: 'Bookings will ask staff for these values again; saved bookings keep theirs.',
  turn: 'Turn Bitrix trip details',
  slot: 'trip-details',
};

const LOOK: Record<'on' | 'on_no_connection' | 'off' | 'unknown', { word: string; tone: StatusTone; icon: LucideIcon }> = {
  on: { word: 'On', tone: 'success', icon: CircleCheck },
  // Atlas Echo-A L1: the switch is on but the Bitrix connection is off, so screens still show codes.
  on_no_connection: { word: 'On, but the Bitrix connection is off', tone: 'warning', icon: TriangleAlert },
  off: { word: 'Off', tone: 'neutral', icon: CircleOff },
  unknown: { word: 'Unknown', tone: 'warning', icon: CircleHelp },
};

const UNKNOWN_TEXT: Record<Extract<NameReadStateView, { state: 'unknown' }>['reason'], string> = {
  not_authorized: 'This setting could not be read for your role.',
  not_configured: 'The Bitrix connection is not set up, so this setting cannot be read.',
  not_installed: 'This setting is not available on this database yet.',
  failed: 'This setting could not be read. Reload the page. Nothing was changed.',
};

function SwitchWord({ value, label }: { value: 'on' | 'on_no_connection' | 'off' | 'unknown'; label: string }) {
  const look = LOOK[value];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">{label}</span>
      {look.word}
    </StatusBadge>
  );
}

export function BitrixNamesCard({
  state,
  action,
  initialResult = null,
  initialStep = 'closed',
  initialReason = '',
  copy = NAMES_COPY,
}: {
  state: NameReadStateView;
  action: NameReadAction;
  /** Preview gallery only. */
  initialResult?: NameReadSwitchActionResult | null;
  /** Preview gallery only: 'choose' or 'review' opens the confirm dialog. */
  initialStep?: Step;
  /** Preview gallery only. */
  initialReason?: string;
  /** Words of the card (default: Bitrix names). */
  copy?: ReadSwitchCopy;
}) {
  const id = useId();
  // "On" only when names are really shown (switch on AND connection on); `enabled` is the switch itself.
  const current = state.state === 'known' ? (state.enabled ? (state.effective ? 'on' : 'on_no_connection') : 'off') : 'unknown';
  const target = state.state === 'known' && state.enabled ? 'off' : 'on';

  return (
    <Card className="mt-6">
      <section aria-labelledby={`${id}-heading`}>
        <CardHeader>
          <CardTitle id={`${id}-heading`}>{copy.title}</CardTitle>
          <SwitchWord value={current} label={copy.stateLabel} />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="m-0 text-copy">{copy.line}</p>
          {state.state === 'known' && state.enabled && !state.effective ? (
            <Notice tone="warning" icon={TriangleAlert}>
              <p>{copy.onNoConnection}</p>
            </Notice>
          ) : null}
          {state.state === 'unknown' ? (
            <Notice tone="warning" icon={CircleHelp}>
              <p>{UNKNOWN_TEXT[state.reason]} The setting is shown as Unknown, not as Off.</p>
            </Notice>
          ) : state.lastChange ? (
            <div className="text-sm text-copy" data-slot={`${copy.slot}-last-change`}>
              <p className="m-0">
                {state.lastChange.byName
                  ? `Last changed by ${state.lastChange.byName} on ${formatIst(state.lastChange.at)}`
                  : `Last changed on ${formatIst(state.lastChange.at)} by a system update (no person recorded)`}
                {state.lastChange.to === null ? '' : ` (turned ${state.lastChange.to ? 'on' : 'off'})`}.
              </p>
              {state.lastChange.reason ? <p className="m-0 mt-1.5 wrap-break-word text-quiet">Reason: {state.lastChange.reason}</p> : null}
            </div>
          ) : (
            <p className="m-0 text-sm text-quiet">Not changed since it was installed (it starts Off).</p>
          )}

          {state.state === 'known' && !state.canSwitch ? <p className="m-0 text-sm text-quiet">Only a Super Admin can change this setting.</p> : null}

          {state.state === 'known' && state.canSwitch ? (
            <div data-slot={`${copy.slot}-result`}>
              <ConfirmChange<NameReadSwitchActionResult>
                title={`${copy.turn} ${target}?`}
                effect={target === 'on' ? copy.reviewOn : copy.reviewOff}
                affected="Every branch. Nothing is written to Bitrix."
                confirmLabel={`${copy.turn} ${target}`}
                tone={target === 'off' ? 'danger' : 'primary'}
                reason="optional"
                reasonName="reason"
                reasonLabel="Why are you changing it?"
                reasonHint={SETTINGS_TEXT.reasonOptionalHint}
                formAction={action}
                hiddenFields={{ state: target, confirm: 'yes' }}
                trigger={{ label: copy.trigger }}
                initialOpen={initialStep !== 'closed'}
                initialReason={initialReason}
                initialResult={initialResult}
              >
                <p className="m-0 text-sm text-quiet">{NAMES_APPROVAL_LINE}</p>
              </ConfirmChange>
            </div>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

/** Settings · Bitrix connection: the "Bitrix trip details" switch (voice-note batch), same flow as Bitrix names. */
export function BitrixTripDetailsCard(props: Omit<Parameters<typeof BitrixNamesCard>[0], 'copy'>) {
  return <BitrixNamesCard {...props} copy={TRIP_DETAILS_COPY} />;
}
