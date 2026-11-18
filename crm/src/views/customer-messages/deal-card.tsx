import { MessageSquareText, Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { CommandButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { whenText } from '@/views/accounts-desk/labels';
import { CustomerLanguageFields } from './language-fields';
import { ChannelOffBox, EmailOverrideField, OffReasonField } from './prefs-fields';
import { CHANNEL_LABEL, LANGUAGE_LABEL, PREFS_FIELD, TYPE_LABEL, messageStatusAt, messageStatusWord } from './labels';
import type { CustomerMessageRow, DealCustomerMessages } from './types';

/*
 * Deal page "Messages to customer" card (contract §5.10 R-A1, §15 screen 2,
 * LD9). Sales owner and branch Manager read and act; Accounts read only;
 * Purchase, Flight and Visa get null from the database and the card renders
 * nothing. No amounts anywhere: the amount of a payment or refund message
 * lives only in the queued row's params, which no read returns.
 */

export interface MessageActions {
  /** A1 deal_message_prefs_set. */
  setPrefs: DecisionAction;
  /** A6 customer_message_resend. */
  resend: DecisionAction;
  /** A2 customer_whatsapp_restart. */
  restartWhatsapp: DecisionAction;
}

export interface MessagesCardPreview {
  prefsOpen?: boolean;
  prefsState?: DeskResult | null;
  restartOpen?: boolean;
  restartState?: DeskResult | null;
  /** Preview gallery: the reason as typed before the refusal (the dialog keeps it). */
  restartReason?: string;
  resend?: { messageId: string; state: DeskResult };
}

export function DealCustomerMessagesCard({
  data,
  actions,
  preview,
}: {
  /** null: this person may not see the card (Purchase, Flight, Visa) — nothing renders. */
  data: DealCustomerMessages | 'error' | null;
  actions: Partial<MessageActions> | null;
  preview?: MessagesCardPreview;
}) {
  if (data === null) return null;
  if (data === 'error') {
    return (
      <Frame description="Could not load">
        <Notice tone="warning" role="status">
          <p>The customer messages could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      </Frame>
    );
  }
  const d = data;
  const p = d.prefs;
  const last = d.messages[0];
  const summary = `${LANGUAGE_LABEL[p.language]} · ${d.messages.length === 0 ? 'no messages yet' : `${d.messages.length} ${d.messages.length === 1 ? 'message' : 'messages'}, latest ${messageStatusWord(last!).label.split(' — ')[0]!.toLowerCase()}`}`;
  return (
    <Frame description={summary}>
      {!d.contactConfirmed ? (
        <Notice tone="warning" title="Booking contact not confirmed">
          <p>No message goes to the customer until the contact on the confirmed booking is marked as checked with the customer. Messages that were due show as skipped below.</p>
        </Notice>
      ) : null}

      {p.optedOut ? (
        <Notice tone="warning" title="Customer stopped WhatsApp">
          <p>The customer replied STOP. No WhatsApp message goes to this number. E-mails still go.</p>
          {d.can.restartWhatsapp ? (
            <div className="pt-1">
              <DialogAction
                buttonLabel="Restart WhatsApp"
                title="Restart WhatsApp messages"
                description="Only when the customer asked you to start WhatsApp messages again. Your reason is saved in the history."
                primaryLabel="Restart WhatsApp"
                pendingLabel="Restarting…"
                action={actions?.restartWhatsapp}
                fields={{ dealId: d.dealId }}
                okTitle="Restarted"
                initialOpen={preview?.restartOpen}
                initialState={preview?.restartState}
              >
                <ReasonField id="cmsg-restart-reason" max={300} hint="10 to 300 characters, e.g. who asked and when." defaultValue={preview?.restartReason} />
              </DialogAction>
            </div>
          ) : null}
        </Notice>
      ) : null}

      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Language" value={LANGUAGE_LABEL[p.language]} />
        <Fact label="WhatsApp" value={p.whatsappMasked ?? 'No number'} state={p.whatsappOff ? 'Off on this Deal' : p.optedOut ? 'Stopped by the customer' : 'On'} on={!p.whatsappOff && !p.optedOut} />
        <Fact label="E-mail" value={p.emailMasked ?? 'No e-mail address'} state={p.emailOff ? 'Off on this Deal' : 'On'} on={!p.emailOff} />
      </dl>

      {d.can.editPrefs ? (
        <DialogAction
          buttonLabel="Change language or channels"
          title="Language and channels for this Deal"
          description="Applies to messages queued from now on. Switching a channel off needs a reason; it is saved in the history."
          primaryLabel="Save"
          pendingLabel="Saving…"
          action={actions?.setPrefs}
          fields={{ [PREFS_FIELD.dealId]: d.dealId, [PREFS_FIELD.expectedRowVersion]: p.rowVersion }}
          okTitle="Saved"
          initialOpen={preview?.prefsOpen}
          initialState={preview?.prefsState}
        >
          <div className="flex flex-col gap-4">
            <CustomerLanguageFields idPrefix="cmsg-prefs" defaultLanguage={p.language} defaultSameAsMobile={p.whatsappSameAsMobile ?? true} mobileHint={p.whatsappMasked ? `Number now: ${p.whatsappMasked}` : undefined} />
            <EmailOverrideField id="cmsg-prefs-email" />
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1 p-0 text-base font-semibold text-ink">Channels on this Deal</legend>
              <ChannelOffBox id="cmsg-prefs-wa-off" name={PREFS_FIELD.whatsappOff} defaultChecked={p.whatsappOff} label="Switch WhatsApp off" />
              <ChannelOffBox id="cmsg-prefs-email-off" name={PREFS_FIELD.emailOff} defaultChecked={p.emailOff} label="Switch e-mail off" />
            </fieldset>
            <OffReasonField id="cmsg-prefs-reason" />
          </div>
        </DialogAction>
      ) : (
        <p className="m-0 text-sm text-quiet">Only the Sales owner or the branch Manager can change the language or channels.</p>
      )}

      <section aria-labelledby="cmsg-list-heading" className="flex flex-col gap-3">
        <h3 id="cmsg-list-heading" className="m-0 text-base font-semibold text-ink">
          Messages
        </h3>
        {d.messages.length === 0 ? (
          <p className="m-0 text-copy">No message for this Deal yet. Messages appear here when the booking is confirmed, a payment is verified, a file is ready and so on — only for the types a Super Admin has switched on.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {d.messages.map((m) => (
              <MessageLine key={m.id} m={m} dealId={d.dealId} action={actions?.resend} state={preview?.resend?.messageId === m.id ? preview.resend.state : null} />
            ))}
          </ul>
        )}
      </section>
    </Frame>
  );
}

function MessageLine({ m, dealId, action, state }: { m: CustomerMessageRow; dealId: string; action: DecisionAction | undefined; state: DeskResult | null }) {
  const word = messageStatusWord(m);
  return (
    <li className="m-0 flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 font-semibold text-ink">
          {TYPE_LABEL[m.type]} <span className="font-normal text-quiet">· {CHANNEL_LABEL[m.channel]} · {LANGUAGE_LABEL[m.language]}</span>
        </p>
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm text-quiet">
          {m.toMasked ? <span>To {m.toMasked}</span> : null}
          <span>{whenText(messageStatusAt(m))}</span>
          {m.attachmentKind ? (
            <span className="inline-flex items-center gap-1">
              <Paperclip aria-hidden="true" className="size-3.5" />
              With file
            </span>
          ) : null}
          {m.resendOf ? <span>Sent again</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
        <StatusBadge tone={word.tone} wrap>
          {word.label}
        </StatusBadge>
        {m.can.resend ? (
          <CommandButton action={action} fields={{ messageId: m.id, dealId }} label="Send again" pendingLabel="Queuing…" okTitle="Queued" initialState={state} ariaLabel={`Send again: ${TYPE_LABEL[m.type]} by ${CHANNEL_LABEL[m.channel]}`} />
        ) : null}
      </div>
    </li>
  );
}

function Fact({ label, value, state, on }: { label: string; value: string; state?: string; on?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className="m-0 flex flex-col items-start gap-1 text-ink">
        <span className="wrap-anywhere tabular-nums">{value}</span>
        {state ? (
          <StatusBadge tone={on ? 'success' : 'neutral'} wrap>
            {state}
          </StatusBadge>
        ) : null}
      </dd>
    </div>
  );
}

function Frame({ description, children }: { description: string; children: ReactNode }) {
  return (
    <Card id="customer-messages">
      <section aria-labelledby="customer-messages-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="customer-messages-heading">Messages to customer</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <MessageSquareText aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">{children}</CardBody>
      </section>
    </Card>
  );
}

/** Loading state while R-A1 is read (Deal page streams it). */
export function DealCustomerMessagesLoading() {
  return (
    <Frame description="Loading…">
      <LoadingRegion label="Loading customer messages…">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </LoadingRegion>
    </Frame>
  );
}
